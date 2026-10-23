// qq_send_image 出站链路回归：MCP 工具 → POST /api/socialV2/send-image → sendImageV2 → OneBot。
//
// 钉住的边界（每条都对应一个真实失败形态）：
//   1. 正常链路：段顺序（image → text caption）、group_id/user_id、base64 载荷逐字节一致；
//   2. 记账：recentMessages 落 `[图片] caption`、lastAiReplyAt 更新、sendTimes 记这次发送；
//   3. 鉴权：reserved2 必须带 agent token，且只能是本会话的（别家会话的令牌一律 403）；
//   4. 白名单/模式：模式不是 reserved2、目标不在 allow 里都要 403；
//   5. 图片来源沙箱：非图片文件、目录逃逸（../config.json）都要失败且不发出任何东西；
//   6. 引用/艾特：私聊带 atUserId 必须 400；不存在的 replyToMessageId 必须 400。
//
// 断言走 harness 注入的 fakeFetch（calls.http），既不连真网关，也不发真消息。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

// 1x1 PNG：sniffImageExt 只看 magic，够用且能真正被 QQ 解析。
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');

// 与真实 MCP 客户端同口径：控制台令牌 + x-agent-call，避免把「漏声明智能体调用」当成测试通过。
const CONSOLE = { 'x-console-token': 'fixture-console-token', 'x-agent-call': '1' };

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...CONSOLE, ...headers } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: response.statusCode, body: data, json });
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

async function fixture() {
  const h = await bridgeHarness();
  h.setMode('reserved2');
  fs.mkdirSync(path.join(h.temp, 'state', 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(h.temp, 'state', 'outbox', 'tiny.png'), PNG);
  fs.writeFileSync(path.join(h.temp, 'state', 'outbox', 'not-image.txt'), 'not an image, just text');
  const st = h.getSocialV2State('group:456');
  const ownerToken = h.getSocialV2State('private:123').agentToken;
  const strayToken = h.getSocialV2State('private:999').agentToken;
  return { h, st, token: st.agentToken, ownerToken, strayToken };
}

await test('群聊：发图 + 说明文字 → 段顺序、目标、载荷、记账全对', async () => {
  const { h, st, token } = await fixture();
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-image', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: { key: 'group:456', image: 'tiny.png', caption: '  给你看这个  ' }
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.ok, true, res.body);
      assert.equal(res.json.messageId, 9001);
      assert.equal(res.json.source, 'file');
      assert.ok(res.json.bytes > 0);
      assert.equal(res.json.caption, '给你看这个', 'caption 必须去掉首尾空白');

      const sends = h.calls.http.filter((c) => c.url.endsWith('/send_group_msg'));
      assert.equal(sends.length, 1, '只应发出一次');
      const msg = sends[0].body.message;
      assert.deepEqual(msg.map((s) => s.type), ['image', 'text'], '图片在前，说明文字后跟');
      assert.equal(msg[0].data.file, 'base64://' + PNG.toString('base64'), '载荷必须逐字节一致');
      assert.equal(msg[1].data.text, '给你看这个');
      assert.equal(sends[0].body.group_id, 456);

      const last = st.recentMessages.at(-1);
      assert.equal(last.text, '[图片] 给你看这个');
      assert.equal(last.sender, '我');
      assert.equal(last.messageId, '9001');
      assert.ok(st.lastAiReplyAt > 0, '发图要记成一次 AI 行为（否则会自以为没回过而重复发）');
      assert.equal(st.sendTimes.length, 1, '发送要计入频率限制');
    });
  } finally { await h.close(); }
});

await test('私聊：base64:// 直接发，不带 caption 时只有 image 段', async () => {
  const { h, ownerToken } = await fixture();
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-image', {
        method: 'POST',
        headers: { 'x-agent-token': ownerToken },
        body: { key: 'private:123', image: 'base64://' + PNG.toString('base64') }
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.source, 'base64');
      const sends = h.calls.http.filter((c) => c.url.endsWith('/send_private_msg'));
      assert.equal(sends.length, 1);
      assert.equal(sends[0].body.user_id, 123);
      assert.deepEqual(sends[0].body.message.map((s) => s.type), ['image']);
    });
  } finally { await h.close(); }
});

await test('引用：replyToMessageId 命中会话内消息 → 段顺序 reply → image', async () => {
  const { h, st, token } = await fixture();
  try {
    st.recentMessages.push({
      seq: 7001, messageId: '9001', sender: '朋友', text: '看这个',
      plain: '看这个', time: Date.now(), media: [], hasMedia: false,
      forwardIds: [], hasForward: false, isSelf: false, isOwner: false
    });
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-image', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: { key: 'group:456', image: 'tiny.png', replyToMessageId: '7001' }
      });
      assert.equal(res.status, 200, res.body);
      const send = h.calls.http.find((c) => c.url.endsWith('/send_group_msg'));
      assert.deepEqual(send.body.message.map((s) => s.type), ['reply', 'image']);
      assert.equal(send.body.message[0].data.id, '9001');
    });
  } finally { await h.close(); }
});

await test('引用：不存在的 message id → 400，且一条都不发', async () => {
  const { h, token } = await fixture();
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-image', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: { key: 'group:456', image: 'tiny.png', replyToMessageId: '123456789' }
      });
      assert.equal(res.status, 400, res.body);
      assert.match(res.json.error, /无法解析被引用消息/);
      assert.equal(h.calls.http.filter((c) => /send_(group|private)_msg/.test(c.url)).length, 0);
    });
  } finally { await h.close(); }
});

await test('鉴权：缺令牌 / 去别的会话偷令牌 一律 403 且不发', async () => {
  const { h, token, ownerToken } = await fixture();
  try {
    await withServer(h, async (port) => {
      const missing = await call(port, '/api/socialV2/send-image', {
        method: 'POST', body: { key: 'group:456', image: 'tiny.png' }
      });
      assert.equal(missing.status, 403);
      assert.match(missing.json.error, /必须携带有效的会话令牌/);

      const stolen = await call(port, '/api/socialV2/send-image', {
        method: 'POST', headers: { 'x-agent-token': ownerToken },
        body: { key: 'group:456', image: 'tiny.png' }
      });
      assert.equal(stolen.status, 403, '会话令牌不能跨会话使用');
      assert.match(stolen.json.error, /agent token 无效/);

      const wrong = await call(port, '/api/socialV2/send-image', {
        method: 'POST', headers: { 'x-agent-token': 'f'.repeat(32) },
        body: { key: 'group:456', image: 'tiny.png' }
      });
      assert.equal(wrong.status, 403);

      assert.equal(h.calls.http.filter((c) => /send_(group|private)_msg/.test(c.url)).length, 0);
      assert.ok(token && token.length === 32);
    });
  } finally { await h.close(); }
});

await test('白名单/模式：目标不在 allow、key 格式错、非 reserved2 全部拒绝', async () => {
  const { h, token, strayToken } = await fixture();
  try {
    await withServer(h, async (port) => {
      const notAllowed = await call(port, '/api/socialV2/send-image', {
        method: 'POST', headers: { 'x-agent-token': strayToken },
        body: { key: 'private:999', image: 'tiny.png' }
      });
      assert.equal(notAllowed.status, 403);
      assert.match(notAllowed.json.error, /不在当前模式允许范围内/);

      const badKey = await call(port, '/api/socialV2/send-image', {
        method: 'POST', headers: { 'x-agent-token': token },
        body: { key: 'group:abc', image: 'tiny.png' }
      });
      // 非法 key 在令牌校验阶段就失败（agentTokenOk 只认规范 key），挡在格式检查之前。
      assert.equal(badKey.status, 403);
      assert.match(badKey.json.error, /agent token 无效/);

      const noPrompt = await call(port, '/api/socialV2/send-image', {
        method: 'POST', headers: { 'x-agent-token': token },
        body: { key: 'group:456' }
      });
      assert.equal(noPrompt.status, 400);

      h.setMode('chat');
      const wrongMode = await call(port, '/api/socialV2/send-image', {
        method: 'POST', headers: { 'x-agent-token': token },
        body: { key: 'group:456', image: 'tiny.png' }
      });
      assert.equal(wrongMode.status, 403);
      assert.match(wrongMode.json.error, /仅 reserved2 模式可用/);
      assert.equal(h.calls.http.filter((c) => /send_(group|private)_msg/.test(c.url)).length, 0);
    });
  } finally { await h.close(); }
});

await test('图片来源沙箱：非图片文件、目录逃逸、file:// 一律失败且不发', async () => {
  const { h, token } = await fixture();
  try {
    await withServer(h, async (port) => {
      const notImage = await call(port, '/api/socialV2/send-image', {
        method: 'POST', headers: { 'x-agent-token': token },
        body: { key: 'group:456', image: 'not-image.txt' }
      });
      assert.equal(notImage.status, 500);
      assert.match(notImage.json.error, /不是可识别的图片/);

      const escape = await call(port, '/api/socialV2/send-image', {
        method: 'POST', headers: { 'x-agent-token': token },
        body: { key: 'group:456', image: '../config.json' }
      });
      assert.equal(escape.status, 500);
      assert.match(escape.json.error, /state\/outbox/);

      const fileUri = await call(port, '/api/socialV2/send-image', {
        method: 'POST', headers: { 'x-agent-token': token },
        body: { key: 'group:456', image: 'file:///C:/Windows/win.ini' }
      });
      assert.equal(fileUri.status, 500);

      // 失败的那一次不应留下 sendTimes 记账（否则会把额度白白吃掉）
      const st = h.getSocialV2State('group:456');
      assert.equal(st.sendTimes.length, 0);
      assert.equal(h.calls.http.filter((c) => /send_(group|private)_msg/.test(c.url)).length, 0);
    });
  } finally { await h.close(); }
});

await test('私聊带 atUserId → 400（私聊没有可 @ 的人）', async () => {
  const { h, ownerToken } = await fixture();
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-image', {
        method: 'POST', headers: { 'x-agent-token': ownerToken },
        body: { key: 'private:123', image: 'tiny.png', atUserId: '456' }
      });
      assert.equal(res.status, 400);
      assert.match(res.json.error, /私聊不需要 @/);
    });
  } finally { await h.close(); }
});

if (failures) {
  console.error(`\n结果：${failures} 条失败`);
  process.exit(1);
}
console.log('\n结果：全部通过');




