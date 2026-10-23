import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import http from 'node:http';

let failures = 0;
async function test(name, run) {
  const h = await bridgeHarness();
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}
await test('closed-agent session is not reused after switching to chat', async (h) => {
  h.setMode('closed-agent');
  const privileged = await h.ensureSession('private:123');
  h.setMode('chat');
  const restricted = await h.ensureSession('private:123');
  assert.notEqual(restricted, privileged);
  assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat');
  assert.ok(h.calls.cancelled.includes(privileged));
});
await test('unavailable preset catalogue fails closed for QQ and learner sessions', async (h) => {
  h.setPresets([]);
  assert.equal(h.resolvePresetName('missing', { strict: true }), '');
  await assert.rejects(h.ensureSession('group:456'));
  await assert.rejects(h.ensureSlangLearnerSession());
  assert.equal(h.calls.created.length, 0);
});
await test('session creation crossing a mode change never accepts stale permissions', async (h) => {
  h.setMode('closed-agent');
  let release;
  const original = h.api.sessions.create;
  h.api.sessions.create = async (params) => {
    const result = await original(params);
    await new Promise((resolve) => { release = resolve; });
    return result;
  };
  const pending = h.ensureSession('private:123');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  h.setMode('chat');
  release();
  await assert.rejects(pending);
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('queued send rechecks allowlist at actual transport time', async (h) => {
  const sending = h.sendToQQ('group:456', 'fixture');
  h.cfg.allow.groups = [];
  await sending;
  assert.equal(h.calls.sent.length, 0);
});
await test('old prompt completion cannot delete replacement queue after reset', async (h) => {
  const release = [];
  h.api.sessions.prompt = async () => {
    await new Promise((resolve) => release.push(resolve));
    return { result: { ok: true, value: {} } };
  };
  const first = h.deliverPrompt('group:456', 'first');
  while (release.length < 1) await new Promise((resolve) => setImmediate(resolve));
  h.drainPromptQueue('group:456', 'reset');
  const second = h.deliverPrompt('group:456', 'second');
  while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const replacement = h.promptQueues.get('group:456');
  release[0](); await first;
  assert.equal(h.promptQueues.get('group:456'), replacement);
  release[1](); await second;
});
await test('same-policy sessions are reused but legacy unlabelled sessions are replaced', async (h) => {
  const first = await h.ensureSession('private:123');
  assert.equal(await h.ensureSession('private:123'), first);
  delete h.state.sessionPolicies['private:123'];
  assert.notEqual(await h.ensureSession('private:123'), first);
});
await test('reset during model selection cannot return a detached session', async (h) => {
  h.api.sessions.selectModel = async () => {
    h.resetEpoch();
    return { result: { ok: true, value: { selected: {} } } };
  };
  await assert.rejects(h.ensureSession('private:123'));
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('malformed HTTP request targets return 400 without hanging', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: 'http://[', method: 'GET' }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(1500, () => request.destroy(new Error('request hung')));
      request.end();
    });
    assert.equal(status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
{ // 控制台重置路径必须与 retireSession 一样：清掉权限元数据并终止 DSH 侧排队的工作。
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const sessionId = await h.ensureSession('private:123');
    assert.ok(h.state.sessionPolicies['private:123'], 'policy should exist before reset');
    h.calls.cancelled.length = 0;
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/session/reset?token=fixture-console-token', method: 'POST',
        headers: { 'content-type': 'application/json' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('reset request hung')));
      request.end(JSON.stringify({ key: 'private:123' }));
    });
    assert.equal(status, 200);
    assert.equal(h.state.sessions['private:123'], undefined);
    assert.equal(h.state.sessionPolicies['private:123'], undefined, 'policy must not be orphaned by reset');
    assert.ok(h.calls.cancelled.includes(sessionId), 'reset must stop the retired DSH session');
    console.log('PASS console reset drops the session policy and stops the retired DSH session');
  } catch (error) { failures++; console.error('FAIL console reset cleanup:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
{
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  let body;
  const h = await bridgeHarness({ globals: {
    safeFetchBuffer: async () => ({ buffer: image }),
    validateFetchUrl: async () => { throw new Error('must fetch validated bytes instead of passing a URL'); },
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    },
  } });
  try {
    await h.sendStickerV2('group:456', 'fixture-sticker');
    assert.equal(body.message.find((part) => part.type === 'image').data.file, 'base64://' + image.toString('base64'));
    console.log('PASS sticker sending gives OneBot validated bytes, never a URL to refetch');
  } catch (error) { failures++; console.error('FAIL safe sticker sending:', error.message); }
  finally { await h.close(); }
}
// ── 语音发送（AI 通道）的安全边界 ────────────────────────────────────────────
// 语音比文本更"重"（真的会说话、不可撤回），所以这里逐条钉住它的闸门：
// 来源只能是语音库、白名单必须命中、限流要生效、文件名审计要拦住本机路径。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  // 默认出厂配置是 voice.enabled=false（AI 不能发语音）；这里显式打开，
  // 才能测"打开之后"的各项闸门。关闭时的行为单独在下面钉一条。
  const voiceOn = { socialV2: { voice: { enabled: true } } };
  const h = await bridgeHarness({ config: voiceOn });
  try {
    // 语音库 fixture：临时 config 的 ROOT 之下，voice.dir 默认 'audio'
    const audioDir = path.join(h.temp, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, 'hello.mp3'), Buffer.alloc(1024, 1));
    // 库外的文件（模拟"随便一个本地文件"）
    const outside = path.join(h.temp, 'outside-secret.mp3');
    fs.writeFileSync(outside, Buffer.alloc(1024, 1));

    const names = h.voiceLibrary().map((v) => v.name);
    assert.ok(names.includes('hello.mp3'), '语音库列出库内音频');
    assert.ok(!names.some((n) => n.includes(h.temp)), '语音库不返回绝对路径');

    // 1) AI 只能按语音库名字取文件
    const okPath = h.resolveVoicePathForV2('hello');
    assert.equal(okPath.path, path.join(audioDir, 'hello.mp3'), 'AI 省略扩展名也能命中语音库文件');

    // 2) 绝对路径默认被拒（防 prompt injection 拿任意本地文件外发）
    assert.throws(() => h.resolveVoicePathForV2(outside), /语音库|绝对路径/, 'AI 传库外绝对路径被拒');
    assert.throws(() => h.resolveVoicePathForV2('C:\\Windows\\Media\\Alarm01.wav'), /语音库|绝对路径/, 'AI 传系统绝对路径被拒');

    // 3) 远程/内联来源被拒（体积与来源都不可控）
    for (const bad of ['https://example.com/a.mp3', 'base64://AAAA', 'data:audio/mp3;base64,AAAA']) {
      assert.throws(() => h.resolveVoicePathForV2(bad), /不接受|只能/, `AI 传 ${bad.split(':')[0]} 来源被拒`);
    }

    // 4) 真发一条（虚拟网关）：必须是 record 段、且 file 指向库内文件
    const sent = await h.sendVoiceForV2('group:456', 'hello.mp3', { readback: false });
    const call = h.calls.http.find((c) => c.url.endsWith('/send_group_msg'));
    assert.ok(call, '语音走 send_group_msg');
    assert.equal(call.body.group_id, 456, '语音发给正确群');
    assert.equal(call.body.message.length, 1, '语音只发一个段');
    assert.equal(call.body.message[0].type, 'record', '段类型是 record');
    assert.equal(call.body.message[0].data.file, path.join(audioDir, 'hello.mp3'), 'record 段指向库内绝对路径');
    assert.equal(sent.messageId, 9001, '返回网关 message_id');
    assert.equal(sent.readback, null, '显式关掉回读时不调 fetch_ptt_text');

    // 5) 落地校验：默认用 get_msg 回读确认这条消息真的带 record 段
    const h2 = await bridgeHarness({ config: voiceOn });
    try {
      const dir2 = path.join(h2.temp, 'audio');
      fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(path.join(dir2, 'hi.mp3'), Buffer.alloc(512, 1));
      const sent2 = await h2.sendVoiceForV2('group:456', 'hi.mp3');
      // 注意：这些对象来自 vm realm，deepEqual 会因原型不同而失败 → 逐字段断言
      assert.equal(sent2.verification?.confirmed, true, '默认回读 get_msg 确认 record 段');
      assert.equal(sent2.verification?.duration, 3, '回读到语音时长');
      // 校验结果**不能**把源文件路径回传给 AI（私聊 get_msg 会把本机路径塞进 record.url）
      assert.equal(sent2.verification?.file, undefined, '校验结果不回传文件路径（防路径泄露进模型上下文）');
      assert.ok(h2.calls.http.some((c) => c.url.endsWith('/get_msg')), '校验走 get_msg');
      assert.equal(sent2.readback, null, '默认不索取转写（自己发的语音没有转写）');
      // 关掉校验时不发 get_msg
      const h2b = await bridgeHarness({ config: voiceOn });
      try {
        const dir2b = path.join(h2b.temp, 'audio');
        fs.mkdirSync(dir2b, { recursive: true });
        fs.writeFileSync(path.join(dir2b, 'hi.mp3'), Buffer.alloc(512, 1));
        const sent2b = await h2b.sendVoiceForV2('group:456', 'hi.mp3', { verify: false });
        assert.equal(sent2b.verification, null, 'verify=false 时不做回读校验');
        assert.ok(!h2b.calls.http.some((c) => c.url.endsWith('/get_msg')), 'verify=false 时不发 get_msg');
      } finally { await h2b.close(); }
    } finally { await h2.close(); }

    // 6) 文件名审计：含本机路径特征的名字不许外发。
    //    resolveVoicePathForV2 允许绝对路径的"文件名形态"由 allowAbsolutePath 管；
    //    这里直接喂一个**看起来就像本机路径**的名字，验证审计层会拦下来。
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', 'C:\\Users\\somebody\\secret-voice.mp3', { readback: false }),
      /敏感信息|语音库|绝对路径/,
      '文件名含本机路径特征被审计/来源校验拦截'
    );

    // 7) 限流：语音额度独立计数，超限拒绝
    const h3 = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 2 } } } });
    try {
      const dir3 = path.join(h3.temp, 'audio');
      fs.mkdirSync(dir3, { recursive: true });
      fs.writeFileSync(path.join(dir3, 'a.mp3'), Buffer.alloc(512, 1));
      await h3.sendVoiceForV2('group:456', 'a.mp3', { readback: false });
      await assert.rejects(
        () => h3.sendVoiceForV2('group:456', 'a.mp3', { readback: false }),
        /频率超限|每分钟/,
        '同一分钟内第二条语音被限流（每分钟 1 条）'
      );
      // 额度只在发出后才记账：参数错误不应吃掉配额
      const h4 = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 2 } } } });
      try {
        const dir4 = path.join(h4.temp, 'audio');
        fs.mkdirSync(dir4, { recursive: true });
        fs.writeFileSync(path.join(dir4, 'a.mp3'), Buffer.alloc(512, 1));
        await assert.rejects(() => h4.sendVoiceForV2('group:456', 'nope.mp3'), /找不到/, '不存在的音频被拒');
        // 失败没有消耗额度 → 紧接着真发一条应当成功
        const ok2 = await h4.sendVoiceForV2('group:456', 'a.mp3', { readback: false });
        assert.equal(ok2.messageId, 9001, '失败不吃额度：随后发送成功');
      } finally { await h4.close(); }
    } finally { await h3.close(); }

    // 8) 语音功能总开关关闭时，**AI 通道**彻底拒绝
    const h5 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      await assert.rejects(() => h5.sendVoiceForV2('group:456', 'a.mp3'), /已关闭/, 'voice.enabled=false 时 AI 通道拒绝发送');
    } finally { await h5.close(); }

    // 9) 但**操作者通道**不受这个开关影响：否则"默认不启用"会变成"连手动试发都做不了"
    const h6 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      const dir6 = path.join(h6.temp, 'audio');
      fs.mkdirSync(dir6, { recursive: true });
      fs.writeFileSync(path.join(dir6, 'a.mp3'), Buffer.alloc(512, 1));
      const sent6 = await h6.sendVoiceV2('group:456', path.join(dir6, 'a.mp3'), { guard: false, audit: true });
      assert.equal(sent6.messageId, 9001, 'voice.enabled=false 时操作者仍能发（AI 开关不该封死手动路径）');
    } finally { await h6.close(); }

    // 10) 音量：倍数会传给音频处理，并原样回报给调用方
    const h7 = await bridgeHarness({ config: voiceOn });
    try {
      const dir7 = path.join(h7.temp, 'audio');
      fs.mkdirSync(dir7, { recursive: true });
      fs.writeFileSync(path.join(dir7, 'a.mp3'), Buffer.alloc(512, 1));
      const loud = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { volume: 2.5 } });
      assert.equal(loud.volume, 2.5, '音量倍数透传到音频处理');
      assert.equal(loud.audioMode, 'volume', 'mode 标为 volume');
      assert.match(loud.audioProcessing, /250%/, '处理说明含百分比');
      const normal = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true });
      assert.equal(normal.audioMode, 'original', '不传音量时保持原样（不转码）');
      assert.equal(normal.audioProcessing, '原始音量', '原样时说明为"原始音量"');
      const smart = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { normalize: true, loudness: 'loud' } });
      assert.equal(smart.audioMode, 'loudnorm', '智能音量 mode=loudnorm');
      assert.match(smart.audioProcessing, /-13/, '智能音量按档位给出目标 LUFS');
      // 非法音量必须被拦下（而不是把奇怪的值丢给 ffmpeg）
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { volume: 99 } }),
        /0\.1~4/,
        '越界音量被拒'
      );
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { normalize: true, loudness: 'nope' } }),
        /未知的响度档位/,
        '未知响度档位被拒'
      );
    } finally { await h7.close(); }

    console.log('PASS voice sending enforces library-only source, whitelist, budget, name audit and volume');
  } catch (error) { failures++; console.error('FAIL voice sending guards:', error.message); }
  finally { await h.close(); }
}

// ── 语音路径：allowAbsolutePath 不再放宽 AI 通道（任意本机音频外发）────────────
// 审计发现：开关打开时 resolveVoicePathForV2 会把 AI 给的绝对路径直接交给
// resolveAudioSource 解析，于是群友用提示注入就能让 AI 把本机任意音频（< 20MB）
// 发到群里；而 inspectAudio 在 ffprobe 不可用时对任何文件都放行。
// 现在即使开了开关，绝对路径也必须落在语音库目录之内。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, allowAbsolutePath: true, maxPerMinute: 50, maxPerHour: 50 } } } });
  try {
    const libraryDir = path.join(h.temp, 'audio');
    const outsideDir = path.join(h.temp, 'outside');
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(libraryDir, 'inside.mp3'), Buffer.alloc(512, 1));
    const outsideFile = path.join(outsideDir, 'secret.mp3');
    fs.writeFileSync(outsideFile, Buffer.alloc(512, 2));

    // 库外的绝对路径必须被拒绝（即使 allowAbsolutePath=true）
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', outsideFile, { readback: false }),
      /语音库/,
      'allowAbsolutePath=true 时库外绝对路径仍必须被拒绝'
    );
    // 相对穿越同样必须被拒绝
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', path.join('..', 'outside', 'secret.mp3'), { readback: false }),
      /语音库|\.\./,
      '相对路径穿越必须被拒绝'
    );
    // 库内的绝对路径应当仍然可用（开关的合理用途）
    const inside = await h.sendVoiceForV2('group:456', path.join(libraryDir, 'inside.mp3'), { readback: false });
    assert.equal(inside.messageId, 9001, '库内绝对路径仍可发送');
    console.log('PASS voice absolute paths stay confined to the library even when allowAbsolutePath is on');
  } catch (error) { failures++; console.error('FAIL voice library confinement:', error.message); }
  finally { await h.close(); }
}

// agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
// 因此仅靠控制台令牌挡不住 QQ 群里的 AI。人格/提示词/思考强度/白名单/重启等管理端点
// 必须对 agent token 一律 403，否则 AI 能改写自己的系统提示词或给自己提权。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const adminOnly = { 'x-console-token': 'fixture-console-token' };
    const asAgent = { ...adminOnly, 'x-agent-token': 'fixture-agent-token' };
    const mustDeny = [
      ['GET', '/api/roles'], ['GET', '/api/roles/content?name=x'], ['GET', '/api/roles?x=1'],
      ['POST', '/api/roles/create'], ['POST', '/api/roles/update'],
      ['POST', '/api/roles/rename'], ['POST', '/api/roles/delete'],
      ['GET', '/api/preset/sim-prompt'], ['POST', '/api/preset/sim-prompt'],
      ['GET', '/api/preset/sim-prompt/backups'], ['POST', '/api/preset/sim-prompt/restore'],
      ['GET', '/api/dsh/model'], ['POST', '/api/dsh/effort'],
      ['GET', '/api/whitelist'], ['POST', '/api/whitelist'], ['POST', '/api/restart'],
      ['POST', '/api/console/token'], ['GET', '/api/role'], ['POST', '/api/role'],
    ];
    for (const [method, path] of mustDeny) {
      const res = await call(path, method, asAgent, method === 'POST' ? {} : undefined);
      assert.equal(res.status, 403, `${method} ${path} 必须对 agent token 拒绝，实际 HTTP ${res.status}`);
    }
    // 绕过尝试：路径穿越与重复斜杠在 URL 解析后仍需被拒
    for (const path of ['/api/roles/../roles', '/api//roles', '/api/./roles', '/api/roles/']) {
      const res = await call(path, 'GET', asAgent);
      assert.notEqual(res.status, 200, `${path} 不得绕过 agent token 限制（实际 HTTP ${res.status}）`);
    }
    // 允许面：AI 真正需要的只读接口不应被误伤
    const allowed = await call('/api/status', 'GET', asAgent);
    assert.equal(allowed.status, 200, '/api/status 应对 agent token 放行');
    // 同一批管理端点，管理员（仅控制台令牌）应可正常访问
    const adminOk = await call('/api/dsh/model', 'GET', adminOnly);
    assert.equal(adminOk.status, 200, '管理员应能访问 /api/dsh/model');
    console.log('PASS agent token cannot reach persona/prompt/effort/whitelist admin endpoints');
  } catch (error) { failures++; console.error('FAIL agent token admin isolation:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
// ── 控制台入口的传输层防护：Host 头 + 令牌定长比较 + /api/authorize/read 鉴权 ──
// 这三条都是「审计发现 → 加固」的结果，钉住它们以防以后被无意改回去。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const admin = { 'x-console-token': 'fixture-console-token' };

    // ① DNS rebinding 硬化：非本机 Host 一律拒绝（即使带着正确的控制台令牌）。
    // 注意 Host 必须走 headers（Node 会用 options.host 覆盖它，那样测不到伪造 Host）。
    for (const host of ['evil.example.com:' + port, '127.0.0.1:1', 'localhost']) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 403, `Host=${host} 必须被拒绝，实际 HTTP ${res.status}`);
    }
    // 合法的三个 Host 都要放行（127.0.0.1 / localhost / [::1] 加实际端口）
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 200, `Host=${host} 应被接受，实际 HTTP ${res.status}`);
    }

    // ② 令牌比较必须是定长：错长度/错内容的令牌都不得通过（不能因为"前缀对"就放行）。
    // 注意 Node 的 HTTP 客户端会自动裁掉自定义头的首尾空白，所以"带尾空格"这一类
    // 必须用 ?token= 传（控制台本来就接受这种入口，它才是真实的攻击面）。
    for (const token of ['fixture-console-token-x', 'fixture-console-toke', 'FIXTURE-CONSOLE-TOKEN', 'fixture-console-token ']) {
      const res = await call(`/api/status?token=${encodeURIComponent(token)}`, 'GET');
      assert.equal(res.status, 401, `令牌「${token}」不得通过鉴权，实际 HTTP ${res.status}`);
    }
    const noHeader = await call('/api/status', 'GET');
    assert.equal(noHeader.status, 401, '不带令牌必须被拒绝');

    // ③ /api/authorize/read 不再接受空令牌（它曾对 agent 流量开放 ⇒ 成为免鉴权入口）。
    const noToken = await call('/api/authorize/read', 'POST', { ...admin, 'x-agent-token': 'x' }, { key: 'group:456' });
    assert.equal(noToken.status, 403, '空会话令牌必须被拒绝');
    console.log('PASS console rejects foreign Host headers, non-exact tokens and token-less authorize/read');
  } catch (error) { failures++; console.error('FAIL console transport guards:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// ===== A：直连引擎的「媒体意向」通道 =====
// 背景：直连模式曾把 10 个发送类工具全屏蔽，代价是她从 2026-10-21 07:35 起再没发过表情/图片。
// 现在表情/图片两种工具回到清单里，但调用被主机侧拦下、只记意向，等本轮文字发完再单独补发。

await test('直连引擎工具面：发送类文本工具隐藏，表情/图片留下当「意向」', async (h) => {
  for (const name of ['qq_send_message', 'qq_send_burst', 'qq_reply', 'qq_send_group_message',
    'qq_send_private_message', 'qq_send_poke', 'qq_post_qzone', 'qq_night_greet']) {
    assert.equal(h.engineHiddenSendTool(name), true, `${name} 必须对模型隐藏（否则同一句话发两遍）`);
  }
  assert.equal(h.engineHiddenSendTool('qq_send_sticker'), false);
  assert.equal(h.engineHiddenSendTool('qq_send_image'), false);
  assert.equal(h.engineHiddenSendTool('qq_get_unread_messages'), false);
  assert.equal(h.ENGINE_MEDIA_MAX_PER_TURN, 2);
});

await test('媒体意向队列：空引用、本机路径、超上限、重复调用都被挡住', async (h) => {
  const q = h.createEngineMediaIntentQueue();
  assert.equal(q.intercept('qq_send_message', {}), null, '不认领的工具要返回 null，让回路照常执行');
  assert.equal(q.intercept('qq_send_sticker', {}).ok, false);
  assert.equal(q.intercept('qq_send_image', { image: 'D:\\pics\\a.png' }).ok, false);
  assert.equal(q.intercept('qq_send_image', { image: 'file:///D:/pics/a.png' }).ok, false);
  assert.equal(q.intercept('qq_send_image', { image: '\\\\nas\\share\\a.png' }).ok, false);
  const first = q.intercept('qq_send_sticker', { stickerId: 'md5-abc' });
  assert.equal(first.ok, true);
  assert.match(first.text, /第 1\/2 个/);
  assert.equal(q.intercept('qq_send_sticker', { stickerId: 'md5-abc' }).ok, false, '同一个表情不重复排队');
  assert.equal(q.intercept('qq_send_image', { image: 'https://example.com/a.png', caption: '看这个' }).ok, true);
  assert.equal(q.intercept('qq_send_sticker', { stickerId: 'md5-def' }).ok, false, '一轮最多 2 个');
  // 跨 realm：VM 里造出来的对象原型与本测试的 Object 不同，deepEqual 会判不等，转成普通对象再比。
  assert.equal(
    JSON.stringify(Array.from(q.items, (i) => ({ kind: String(i.kind), ref: String(i.ref), caption: String(i.caption) }))),
    JSON.stringify([
      { kind: 'sticker', ref: 'md5-abc', caption: '' },
      { kind: 'image', ref: 'https://example.com/a.png', caption: '看这个' },
    ]),
  );
});

/** 起一个「假回路 + 可控 self-HTTP」的桥接夹具，专门验媒体意向的接线。 */
async function engineIntentFixture({ plan, text = '好呀，我发你' } = {}) {
  const mediaCalls = [];
  const loopSeen = [];
  let harness = null;
  const h = await bridgeHarness({
    config: {
      consolePort: 3199,
      mcp: { httpToken: 'fixture-mcp-token' },
      model: { enabled: true, maxSteps: 4 },
    },
    globals: {
      createAgentLoop: ({ catalogFilter }) => {
        assert.equal(typeof catalogFilter, 'function', '工具面过滤必须交给回路');
        assert.equal(catalogFilter({ function: { name: 'qq_send_message' } }), false, '注册时就该把文本发送工具滤掉');
        assert.equal(catalogFilter({ function: { name: 'qq_send_sticker' } }), true, '表情工具要留在清单里');
        return {
          version: '0.1.0',
          run: async (request) => {
            for (const step of plan) {
              const entry = { server: 'snowluma', path: '/snowluma/mcp', tool: { name: step.name }, required: [] };
              const result = await request.intercept(step.name, { key: request.extraArgs.key, token: request.extraArgs.token, ...step.args }, entry);
              loopSeen.push({ name: step.name, ok: result?.ok === true, text: result?.text ?? '', error: result?.error ?? null });
            }
            return { ok: true, text, steps: 1, toolCalls: plan.map((s) => ({ name: s.name, ok: true })), fallbackSafe: false };
          },
          stats: () => ({ runs: 1, ok: 1, failed: 0, fallbacks: 0, steps: 1, toolCalls: plan.length, executions: plan.length, byTool: {} }),
        };
      },
      // 桥接自己的 HTTP 端点在夹具里被这个 fetch 代替：断言请求体 + 记录「调用时文字是否已经发出去」。
      fetch: async (url, init = {}) => {
        let body = init.body;
        try { body = JSON.parse(init.body ?? '{}'); } catch {}
        mediaCalls.push({
          url: String(url),
          body,
          token: init.headers?.['x-agent-token'] ?? null,
          consoleToken: init.headers?.['x-console-token'] ?? null,
          agentCall: init.headers?.['x-agent-call'] ?? null,
          httpLenAtCall: harness ? harness.calls.http.length : -1,
        });
        return { ok: true, status: 200, json: async () => ({ ok: true, messageId: 9002 }) };
      },
    },
  });
  harness = h;
  h.setMode('reserved2');
  return { h, mediaCalls, loopSeen };
}

await test('直连引擎：文字先落地，媒体意向随后单独补发（顺序与请求体都要对）', async () => {
  const { h, mediaCalls, loopSeen } = await engineIntentFixture({ plan: [{ name: 'qq_send_sticker', args: { stickerId: 'md5-abc' } }] });
  try {
    const out = await h.runDirectAgentTurn('private:123', 'audit');
    assert.equal(out.ok, true, out.error);
    assert.equal(out.handled, true);
    assert.equal(out.text, '好呀，我发你');
    assert.equal(out.fallbackSafe, false);
    assert.equal(loopSeen.length, 1);
    assert.equal(loopSeen[0].ok, true, loopSeen[0].error ?? '');
    // 文字真的发出去了
    const sends = h.calls.http.filter((c) => c.url.endsWith('/send_private_msg'));
    assert.equal(sends.length, 1, '文字应当只发一次');
    assert.match(JSON.stringify(sends[0]), /好呀，我发你/);
    // 表情意向走自己的端点，且在文字之后
    assert.equal(mediaCalls.length, 1);
    assert.match(mediaCalls[0].url, /\/api\/socialV2\/send-sticker$/);
    assert.deepEqual(mediaCalls[0].body, { key: 'private:123', stickerId: 'md5-abc' });
    assert.ok(mediaCalls[0].token, '必须带上这一轮的 agent token（端点会校验）');
    // 补发走的是自己的控制台 HTTP 端点，而那个端点的**第一道关是控制台令牌**：
    // 只带 agent token 的请求在业务校验之前就 401「未授权：请提供控制台访问令牌」。
    // 2026-10-22 03:57 / 10-23 07:03 两次真实图片意向就是这么丢的（日志里只有一句
    // 「媒体意向补发失败（图片）」）。这一条就是那次回归的网。
    assert.equal(mediaCalls[0].consoleToken, 'fixture-console-token', '必须带控制台令牌，否则端点先 401、根本走不到会话校验');
    assert.equal(mediaCalls[0].agentCall, '1', '必须声明 x-agent-call，避免漏带会话令牌时被当成管理端全权');
    assert.ok(mediaCalls[0].httpLenAtCall >= 1, '表情必须在文字发出去之后才补发');
  } finally { await h.close(); }
});

await test('直连引擎：图片意向带 caption，只发媒体不说话时也照样补发', async () => {
  const { h, mediaCalls } = await engineIntentFixture({
    plan: [{ name: 'qq_send_image', args: { image: 'https://example.com/a.png', caption: '给你看这个' } }],
    text: '',
  });
  try {
    const out = await h.runDirectAgentTurn('private:123', 'audit');
    assert.equal(out.ok, true, out.error);
    assert.equal(out.text, '');
    assert.equal(h.calls.http.filter((c) => c.url.endsWith('/send_private_msg')).length, 0, '她没说话就不该发文字');
    assert.equal(mediaCalls.length, 1);
    assert.match(mediaCalls[0].url, /\/api\/socialV2\/send-image$/);
    assert.deepEqual(mediaCalls[0].body, { key: 'private:123', image: 'https://example.com/a.png', caption: '给你看这个' });
    assert.equal(mediaCalls[0].consoleToken, 'fixture-console-token', '图片意向和表情同一套鉴权，控制台令牌不能漏');
  } finally { await h.close(); }
});

// 上面两条用**桩 fetch** 断言请求头（快、确定），这一条则真起控制台服务器、
// 把发往控制台端口的请求透传给真 HTTP —— 端到端复现「她发图」这条链：
// 媒体意向 → 控制台鉴权 → 会话令牌 → 图片来源沙箱（state/outbox）→ sendImageV2 → 网关。
// 这条链在 2026-10-22 03:57 / 10-23 07:03 两次断在第一步（缺控制台令牌 ⇒ 401），
// 单看请求头容易漏掉「端点是否真的会收发」，所以两条都留。
await test('直连引擎：图片意向真打自己的 HTTP 端点，state/outbox 里的文件真的发得出去', async () => {
  const consolePort = 3199;
  const onebot = [];
  // 1×1 PNG：与 test-send-image.mjs 同一个载荷，够被 sniffImageExt 认出来。
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');
  const h = await bridgeHarness({
    config: { consolePort, mcp: { httpToken: 'fixture-mcp-token' }, model: { enabled: true, maxSteps: 4 } },
    globals: {
      createAgentLoop: () => ({
        version: '0.1.0',
        run: async (request) => {
          // 她这一轮「想发一张图」：只给 state/outbox 里的文件名（桥接只认这一种本地图片）。
          const seen = await request.intercept('qq_send_image', { ...request.extraArgs, image: 'tiny.png', caption: '看这个' }, {
            server: 'snowluma', path: '/snowluma/mcp', tool: { name: 'qq_send_image' }, required: []
          });
          assert.equal(seen?.ok, true, seen?.error ?? '意向应被收下');
          return { ok: true, text: '给你看个东西', steps: 1, toolCalls: [{ name: 'qq_send_image', ok: true }], fallbackSafe: false };
        },
        stats: () => ({ runs: 1, ok: 1, failed: 0, fallbacks: 0, steps: 1, toolCalls: 1, executions: 1, byTool: {} })
      }),
      fetch: async (url, init = {}) => {
        const u = String(url);
        // 发给控制台的请求走真 HTTP：鉴权/配额/取字节/记账全都是真代码。
        if (u.startsWith(`http://127.0.0.1:${consolePort}/`)) return globalThis.fetch(u, init);
        // 其余（OneBot 网关）照旧桩掉，绝不真发 QQ 消息。
        let body = init.body;
        try { body = JSON.parse(init.body ?? '{}'); } catch {}
        onebot.push({ url: u, body });
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
      }
    }
  });
  try {
    h.setMode('reserved2');
    fs.mkdirSync(path.join(h.temp, 'state', 'outbox'), { recursive: true });
    fs.writeFileSync(path.join(h.temp, 'state', 'outbox', 'tiny.png'), PNG);
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    try {
      const out = await h.runDirectAgentTurn('private:123', 'audit');
      assert.equal(out.ok, true, out.error);
      assert.equal(out.text, '给你看个东西', '话要照常发出去');
      // 文字一条（走 OneBot 客户端桩），图片一条（sendImageV2 直接 fetch 网关）。
      assert.equal(h.calls.http.filter((c) => c.url.endsWith('/send_private_msg')).length, 1, '文字应当只发一次');
      const imageSends = onebot.filter((c) => c.url.endsWith('/send_private_msg') && JSON.stringify(c.body).includes('"type":"image"'));
      assert.equal(imageSends.length, 1, `图片必须真的发到网关（实际 ${onebot.length} 次网关调用：${onebot.map((c) => c.url).join(', ')}）`);
      const segments = imageSends[0].body.message;
      assert.deepEqual(segments.map((s) => s.type), ['image', 'text'], '图片在前、caption 在后');
      assert.equal(segments[0].data.file, 'base64://' + PNG.toString('base64'), '取的是 state/outbox 里那张图的字节');
      assert.equal(segments[1].data.text, '看这个');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  } finally { await h.close(); }
});

// 反向用例：补发失败必须**留痕**。
//
// 这条通道失败时的处境很特殊：她的文字已经照常发出去了，图却没发出去，而她自己以为发了
// （工具调用返回的是 ok:true）。所以失败至少要写进活动流水，让控制台看得见 ——
// 2026-10 的「她发不了图片」之所以坏了几个小时没人发现，就是因为只有一行 log。
await test('直连引擎：媒体意向补发失败要写进活动流水（控制台可见，不再静默）', async () => {
  const consolePort = 3198;
  const h = await bridgeHarness({
    config: { consolePort, mcp: { httpToken: 'fixture-mcp-token' }, model: { enabled: true, maxSteps: 4 } },
    globals: {
      createAgentLoop: () => ({
        version: '0.1.0',
        run: async (request) => {
          // 存心给一个 outbox 里不存在的文件名：端点会回「读取本地图片失败」，补发必然失败。
          const seen = await request.intercept('qq_send_image', { ...request.extraArgs, image: 'not-here.png', caption: '看这个' }, {
            server: 'snowluma', path: '/snowluma/mcp', tool: { name: 'qq_send_image' }, required: []
          });
          assert.equal(seen?.ok, true, seen?.error ?? '意向应被收下');
          return { ok: true, text: '给你看个东西', steps: 1, toolCalls: [{ name: 'qq_send_image', ok: true }], fallbackSafe: false };
        },
        stats: () => ({ runs: 1, ok: 1, failed: 0, fallbacks: 0, steps: 1, toolCalls: 1, executions: 1, byTool: {} })
      }),
      fetch: async (url, init = {}) => {
        const u = String(url);
        // 控制台端点走真 HTTP（鉴权/取字节/错误文案都是真代码），网关仍然桩掉、绝不真发 QQ。
        if (u.startsWith(`http://127.0.0.1:${consolePort}/`)) return globalThis.fetch(u, init);
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
      }
    }
  });
  try {
    h.setMode('reserved2');
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    try {
      const out = await h.runDirectAgentTurn('private:123', 'audit');
      assert.equal(out.ok, true, '图失败不该让这一轮文字也失败');
      assert.equal(out.text, '给你看个东西');
      const activityPath = path.join(h.temp, 'state', 'qq-activity.log');
      const activity = fs.existsSync(activityPath) ? fs.readFileSync(activityPath, 'utf8') : '';
      const lines = activity.split(/\r?\n/).filter(Boolean);
      const hit = lines.find((line) => line.includes('没发出去'));
      assert.ok(hit, `活动流水里应有补发失败的记录，实际最后几行：${lines.slice(-3).join(' | ') || '（文件为空或不存在）'}`);
      assert.match(hit, /private:123/, '要写明是哪个会话');
      assert.match(hit, /not-here\.png/, '要写明是哪张图');
    } finally { await new Promise((resolve) => server.close(resolve)); }
  } finally { await h.close(); }
});

await test('说话方式：空行是分条而不是排版（QQ 里不再打出一个空行）', async () => {
  const text = '在啊在啊\n\n爸你一下拍我三次干嘛\n\n我哪有运行代码';
  const { h } = await engineIntentFixture({ plan: [], text });
  try {
    const out = await h.runDirectAgentTurn('private:123', 'audit');
    assert.equal(out.ok, true, out.error);
    assert.equal(out.text, text, '清洗后的正文本身保持不变');
    const sends = h.calls.http.filter((c) => c.url.endsWith('/send_private_msg'));
    assert.equal(sends.length, 3, '空行应当拆成 3 条独立的 QQ 消息');
    for (const s of sends) {
      assert.ok(!JSON.stringify(s).includes('\\n\\n'), '每条消息里都不该再夹着空行');
    }
    assert.match(JSON.stringify(sends[0]), /在啊在啊/);
    assert.match(JSON.stringify(sends[2]), /我哪有运行代码/);
  } finally { await h.close(); }
});

await test('说话方式：空行分条有上限，超出部分并回最后一条，不丢话', async () => {
  const h = await bridgeHarness();
  try {
    assert.equal(h.ENGINE_MAX_BUBBLES, 6);
    assert.equal(JSON.stringify(h.splitBubblesV2('  ')), '[]', '只有空白就不发');
    assert.equal(JSON.stringify(h.splitBubblesV2('一句话')), '["一句话"]');
    assert.equal(JSON.stringify(h.splitBubblesV2('甲\n\n乙')), '["甲","乙"]');
    assert.equal(JSON.stringify(h.splitBubblesV2('甲\n \n乙')), '["甲","乙"]', '空行里夹空格也算分条');
    const nine = Array.from({ length: 9 }, (_, i) => `第${i + 1}条`).join('\n\n');
    const parts = Array.from(h.splitBubblesV2(nine), String);
    assert.equal(parts.length, 6, '一轮最多 6 条，不刷屏');
    assert.equal(parts[5], '第6条 第7条 第8条 第9条', '超出的并回最后一条（宁可长，也别丢话）');
  } finally { await h.close(); }
});

await test('定向投递别名表：配置项与内置表合并，不整体覆盖', async () => {
  const h = await bridgeHarness();
  try {
    h.cfg.socialV2 = h.cfg.socialV2 ?? {};
    h.cfg.socialV2.directed = {
      ...(h.cfg.socialV2.directed ?? {}),
      aliases: [
        { name: '爸爸', id: '999', words: ['老父亲'] },
        { name: '奶奶', kind: 'private', id: '888', words: ['奶奶', '阿奶'] },
      ],
    };
    const table = h.directedAliases();
    const dad = table.find((a) => a.name === '爸爸');
    assert.equal(dad.id, '999', '配置能改内置条目的 id');
    assert.ok(dad.words.includes('爸爸'), '内置词还在（合并而非覆盖）');
    assert.ok(dad.words.includes('老父亲'), '配置新增的词并进同一个条目');
    assert.equal(table.find((a) => a.name === '奶奶')?.kind, 'private', '配置新增的条目被采纳');
    assert.ok(table.some((a) => a.name === '家庭群'), '新增条目不会顶掉内置的家庭群');
    const parsed = h.directed.parse('帮我去跟阿奶说一声晚安', { aliases: table, allowGroups: [] });
    assert.equal(parsed.matched, true, '配置里的新词真的能被解析出来');
    assert.equal(parsed.target.name, '奶奶');
  } finally { await h.close(); }
});

await test('直连引擎提示词：反AI味/积极性回了，最近聊天记录直接写进 user', async () => {
  const h = await bridgeHarness({ config: { model: { enabled: true, maxSteps: 4 } } });
  try {
    const key = 'private:123';
    const st = h.getSocialV2State(key);
    st.recentMessages = [
      { sender: '私聊', isSelf: false, text: '在干嘛？', plain: '在干嘛？', time: Date.now() - 60000 },
      { sender: '我', isSelf: true, text: '写代码呢', plain: '写代码呢', time: Date.now() - 30000 },
      { sender: '私聊', isSelf: false, text: '。！', plain: '。！', time: Date.now() - 1000 },
    ];
    st.unread = [{ seq: 1, text: '。！' }];
    st.lastAiReplyAt = Date.now() - 120000;
    const p = h.buildEnginePrompts(key, 'audit');
    // DSH 路径有的行为口径，直连引擎也必须有 —— 否则「讲起话来怪怪的」（2026-10-21 用户报告）。
    assert.match(p.system, /【反AI味】/, '反AI味那行不能丢');
    assert.match(p.system, /【积极性】/, '积极性那行不能丢');
    assert.match(p.system, /不要写“思考过程/, '必须明确禁止把思维链当正文写出来');
    assert.match(p.system, /qq_send_sticker/, '表情意向通道要在提示词里说明');
    // 聊天记录进 user（以前只有元信息，她每轮都得先花步数把消息捞回来）。
    assert.match(p.user, /最近的聊天记录/);
    assert.match(p.user, /在干嘛？/);
    assert.match(p.user, /。！/);
    assert.match(p.user, /此刻状态/);
    assert.match(p.user, /最近一条来自/);
    assert.ok(!/\n\n\n/.test(p.user), 'user 不该出现多余空行');
  } finally { await h.close(); }
});

await test('正文清洗：思维链与旁白不发到 QQ，正常聊天原样保留', async () => {
  const h = await bridgeHarness();
  try {
    // 2026-10-21 09:59 真实泄漏过的那条（无开标签、有闭标签）。
    // 闭标签在这里拆开拼，避免编辑/工具链把它当成真标签处理。
    const CLOSE = '<' + '/thi' + 'nking>';
    const leak = [
      '## 思考过程', '', '爸爸发消息了，我看看。', '先看未读。', CLOSE, '',
      '_(等一下，我先看看未读)_', '---', '**[查看未读消息]**', '---',
      '爸爸私聊我，9条未读。先看看他说了啥。',
    ].join('\n');
    const cleaned = h.sanitizeEngineReplyV2(leak);
    assert.ok(!cleaned.includes('思考过程'), '思考过程不能发出去');
    assert.ok(!cleaned.includes(CLOSE), '闭标签不能发出去');
    assert.ok(!cleaned.includes('**[查看未读消息]**'), '工具旁白不能发出去');
    assert.ok(!cleaned.includes('---'), '分隔线不能发出去');
    assert.equal(cleaned, '爸爸私聊我，9条未读。先看看他说了啥。');
    // 正常的多气泡聊天原样保留（空行仍用来分条）。
    const normal = '早\n\n11点多睡也算早？你昨天还说让我别熬太晚\n\n那 cd 是干嘛的';
    assert.equal(h.sanitizeEngineReplyV2(normal), normal);
    assert.equal(h.sanitizeEngineReplyV2('   '), '');
  } finally { await h.close(); }
});

await test('R2 行为模块「自己刷一会儿」：挑会话的规矩（安静、每天上限、间隔、开关）', async () => {
  const h = await bridgeHarness();
  try {
    const now = Date.now();
    h.setMode('reserved2');
    h.cfg.allow = { private: ['123'], groups: [] };
    h.cfg.socialV2 = h.cfg.socialV2 ?? {};
    h.cfg.socialV2.mood = { enabled: false }; // 门控在测试里保持确定（真实运行由情绪决定）
    h.cfg.socialV2.browse = { enabled: true, maxPerDay: 5, minGapMs: 2 * 60 * 60 * 1000, idleThresholdMs: 20 * 60 * 1000 };
    const st = h.getSocialV2State('private:123');
    st.lastIncomingAt = now - 30 * 60 * 1000;
    assert.equal(h.pickBrowseTargetV2(now)?.key, 'private:123', '安静 30min 的会话会被挑中');
    assert.equal(h.browseCountToday({ browseTimes: [now] }, now), 1, '当天次数按本地零点起算');
    // 刚刷过：间隔不够，不重复叫同一个会话去刷。
    st.browseTimes = [now - 30 * 60 * 1000];
    assert.equal(h.pickBrowseTargetV2(now), null, '两次之间至少隔 2h');
    // 一天最多 5 次（人格卡写的一天三五次）。
    st.browseTimes = Array.from({ length: 5 }, (_, i) => now - i * 1000);
    assert.equal(h.pickBrowseTargetV2(now), null, '一天 5 次就够，不再刷');
    // 会话刚热过：别挑，免得像插话。
    st.browseTimes = [];
    st.lastIncomingAt = now - 60 * 1000;
    assert.equal(h.pickBrowseTargetV2(now), null, '刚说过话（<20min）不去刷');
    // 开关。
    st.lastIncomingAt = now - 30 * 60 * 1000;
    h.cfg.socialV2.browse.enabled = false;
    assert.equal(h.pickBrowseTargetV2(now), null, '模块关掉就不挑');
    assert.equal(h.startBrowseBehavior(), null, '关掉时不装定时器');
    h.cfg.socialV2.browse.enabled = true;
    const started = h.startBrowseBehavior();
    assert.ok(started && started.tickMs >= 5 * 60 * 1000, '开着时装上定时器');
  } finally { await h.close(); }
});

await test('R2 行为模块：定时唤醒的提示词要告诉她「这一轮可以自己去刷」', async () => {
  const h = await bridgeHarness({ config: { model: { enabled: true } } });
  try {
    const key = 'private:123';
    h.getSocialV2State(key).lastIncomingAt = Date.now() - 30 * 60 * 1000;
    const browse = h.buildEnginePrompts(key, 'browse');
    assert.match(browse.user, /【自己刷一会儿】/, '直连提示词要说明这是一次自由时间');
    assert.match(browse.user, /主人自己的账号|主人替你登录好/, '要说清浏览器里用的是主人的账号（2026-10-23 主人把账号给了她）');
    assert.match(browse.user, /别去登录别人的账号|别登录别人的号/, '别人的账号仍然不许登录');
    assert.match(browse.user, /只读不互动/, '只读不互动（不点赞/评论/私信/关注）');
    assert.match(browse.user, /登录态可能过期/, '要告诉她登录过期是什么样、别硬刷');
    assert.ok(!/绝不登录/.test(browse.user), '不再是一刀切「绝不登录」——主人已授权用自己的账号');
    assert.ok(!/【主动机会】/.test(browse.user), '刷一会儿和主动机会不是同一件事');
    const proactive = h.buildEnginePrompts(key, 'proactiveCheck');
    assert.match(proactive.user, /【主动机会】/, '主动机会也要有自己的口径');
    assert.ok(!/【自己刷一会儿】/.test(proactive.user), '两种原因不能混用');
    const plain = h.buildEnginePrompts(key, 'audit');
    assert.ok(!/【自己刷一会儿】/.test(plain.user) && !/【主动机会】/.test(plain.user), '普通回合不带这两行');
    assert.match(plain.system, /自己刷一会儿/, '行为规则常驻在 system 里（工具与边界）');
    // DSH 路径同样要有这一轮的口径（引擎关掉时走的那条路）。
    const dsh = h.buildWakePromptV2(key, 'browse');
    assert.match(dsh, /【自己刷一会儿】/, 'DSH 路径也要有');
    assert.match(dsh, /别刷太久/, '顺带提醒别刷太久');
    assert.match(dsh, /别去登录别人的账号|别登录别人的号/, 'DSH 路径的登录口径也要跟着改');
  } finally { await h.close(); }
});

// 掉登录必须有人管：读网页那一侧只会「读不到内容」，她看不出是登录失效，
// 主人也不知道 —— 2026-10 那批「她发不了图」就是同款静默失效。所以这里盯三件事：
// 连续撞墙才提醒、提醒发得出去、发过之后去重不刷屏。
await test('抖音登录态监视：连续撞墙 → 私聊主人 + 活动流水；发过之后去重', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: 1000000001, snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'fixture-gateway-token' } } });
  try {
    const statePath = path.join(h.temp, 'state', 'read-login-watch.json');
    const now = Date.now();
    const writeWatch = (patch) => {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({
        consecutive: 2, lastWallAt: now, lastWallUrl: 'https://www.douyin.com/hot',
        lastOkAt: 0, notifiedAt: 0, notifiedCount: 0, updatedAt: now, ...patch
      }));
    };

    // ① 只撞了 1 次：不够，不打扰主人
    writeWatch({ consecutive: 1 });
    let out = await h.checkReadLoginWatch(now);
    assert.equal(out.notified, false, `只 1 次不该提醒（${out.reason}）`);
    assert.equal(h.calls.http.filter((c) => String(c.url).endsWith('/send_private_msg')).length, 0, '一次网关调用都不该有');

    // ② 连续 2 次：私聊主人，正文要能照着做（命令 + 网址 + 时间）
    writeWatch({});
    out = await h.checkReadLoginWatch(now);
    assert.equal(out.notified, true, out.reason);
    const sends = h.calls.http.filter((c) => String(c.url).endsWith('/send_private_msg'));
    assert.equal(sends.length, 1, `应当只发一条（实际 ${sends.length}）`);
    const body = sends[0].body;
    assert.equal(String(body.user_id), '1000000001', '发给 ownerQQ');
    const text = body.message.map((seg) => seg.data.text).join('');
    assert.match(text, /抖音登录态可能过期/, '要说清是什么事');
    assert.match(text, /douyin\.com\/hot/, '要带上最近一次读不到的页面');
    assert.match(text, /launchLoginBrowser/, '要给出重新扫码的命令，否则主人不知道怎么修');
    assert.match(text, /12 小时/, '要说明多久内不会再提醒');
    assert.match(String(sends[0].headers?.authorization ?? ''), /Bearer fixture-gateway-token/, '要带上网关令牌');

    // ③ 已提醒过：同一批撞墙不再重复（主人刚收到过）
    out = await h.checkReadLoginWatch(now + 60_000);
    assert.equal(out.notified, false, `重复提醒被去重（${out.reason}）`);
    assert.match(out.reason, /上次提醒/, '理由要说明是去重');
    assert.equal(h.calls.http.filter((c) => String(c.url).endsWith('/send_private_msg')).length, 1, '仍然只有一条');

    // ④ 超过去重窗口 + 还在撞墙：再提醒一次
    out = await h.checkReadLoginWatch(now + 13 * 3600 * 1000);
    assert.equal(out.notified, true, `过了 12 小时该再提醒（${out.reason}）`);
    assert.equal(h.calls.http.filter((c) => String(c.url).endsWith('/send_private_msg')).length, 2);

    // ⑤ 读到正常内容后计数清零：不再提醒
    writeWatch({ consecutive: 0, notifiedAt: now + 13 * 3600 * 1000 });
    out = await h.checkReadLoginWatch(now + 14 * 3600 * 1000);
    assert.equal(out.notified, false, '读到正常内容就不再提醒');

    // ⑥ 活动流水要留痕（控制台看得见），否则又回到「只有日志」的老毛病
    const activityPath = path.join(h.temp, 'state', 'qq-activity.log');
    const activity = fs.existsSync(activityPath) ? fs.readFileSync(activityPath, 'utf8') : '';
    assert.match(activity, /抖音登录态可能过期/, '活动流水里要记一笔（没写就什么都不剩，和控制台看不见是一回事）');
  } finally { await h.close(); }
});

await test('抖音登录态监视：私聊发不出去时不标记已通知（下一轮还要再试）', async () => {
  // 只让网关那一跳失败，其余请求照常（桥接启动自己也会发请求）。
  const attempted = [];
  const h = await bridgeHarness({
    config: { ownerQQ: 1000000001, snowluma: { httpUrl: 'http://127.0.0.1:3000' } },
    globals: {
      fetch: async (url, init = {}) => {
        const u = String(url);
        attempted.push(u);
        if (u.endsWith('/send_private_msg')) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
      }
    }
  });
  try {
    const statePath = path.join(h.temp, 'state', 'read-login-watch.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ consecutive: 3, lastWallAt: Date.now(), lastWallUrl: '', lastOkAt: 0, notifiedAt: 0 }));
    const out = await h.checkReadLoginWatch(Date.now());
    assert.equal(out.notified, false, '失败不能算通知成功');
    assert.match(out.reason, /发送失败/, out.reason);
    assert.ok(attempted.some((u) => u.endsWith('/send_private_msg')), '确实尝试发了');
    const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(after.notifiedAt, 0, '失败就不该写 notifiedAt，否则这条提醒会被去重吃掉');
  } finally { await h.close(); }
});

await test('家里人身份：号码从 config 注入提示词（代码与人格卡里不留真实号码）', async () => {
  // 2026-10-23 发布前扫描发现：人格卡、bridge.js 默认值、directed 内置别名表里都写死过家人的真实 QQ 号。
  // 公开仓库不能带这些（git 历史删不掉），所以号码改由 config 注入，这里钉住"注入生效 + 跟着配置走"。
  const h = await bridgeHarness({
    config: {
      ownerQQ: 1000000001,
      socialV2: { nightRitual: { parents: ['1000000001', '1000000002'], parentLabels: ['爸爸', '妈妈'] } }
    }
  });
  try {
    const p = h.buildEnginePrompts('private:1000000002', 'audit');
    const text = `${p.system}\n${p.user}`;
    assert.match(text, /【家里人】/, '要把家里人告进提示词');
    assert.match(text, /爸爸的 QQ 是 1000000001/, '爸爸的号码来自 config');
    assert.match(text, /妈妈的 QQ 是 1000000002/, '妈妈的号码来自 config');
    assert.match(text, /不会见谁都叫爸妈/, '保留原来的判断口径');
  } finally { await h.close(); }

  const h2 = await bridgeHarness({
    config: {
      ownerQQ: 1234567899,
      socialV2: { nightRitual: { parents: ['1234567899', '1234567898'], parentLabels: ['老爸', '老妈'] } }
    }
  });
  try {
    const q = h2.buildEnginePrompts('private:1234567898', 'audit');
    const text = `${q.system}\n${q.user}`;
    assert.match(text, /老爸的 QQ 是 1234567899/, '称呼与号码都跟着配置走');
    assert.ok(!/1000000001/.test(text), '不会串到上一套配置');
  } finally { await h2.close(); }
});

if (failures) process.exitCode = 1;
