#!/usr/bin/env node
/**
 * 本机 TTS（Windows 自带 SAPI / OneCore）的回归。
 *
 * 分两层：
 *   一、src/qqb/tts.mjs —— 纯模块。真跑一次合成（本机约 1 秒），断言产物是**真 wav**
 *      （RIFF/WAVE 头、有 fmt 段、体积合理），并断言它把临时元数据（.voice.txt/.err.txt）收干净。
 *      Linux/macOS 上这层整体跳过（没有 SAPI）。
 *   二、桥接集成 —— 用 audit-bridge-harness 的假网关：voice.tts 开关、字数上限、语音库清理
 *      （只删自己生成的 tts-*.wav，绝不碰主人放进去的音频）、以及 /api/socialV2/send-voice
 *      的 text 通道（dry-run、真发、text/voice 二选一、工具开关、梯队门禁在合成之前）。
 *
 * 用法：node scripts/test-voice-tts.mjs（npm run test:voice-tts）
 *
 * 注意：桥接集成那层用 `globals.synthesizeToFile` 把合成换成桩（写一个手搓的真 wav），
 * 这样断言的是"桥接怎么用合成结果"，不依赖本机装了什么声音；真合成由第一层负责。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { synthesizeToFile, ttsAvailable, listTtsVoices, powershellPath } from '../src/qqb/tts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
const skipped = [];
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
function skip(name, why) { skipped.push(name); console.log('SKIP', name, '—', why); }

// fixture 号码刻意用合成号（不在任何真实账号里出现）。
const OWNER = '1000000001';
const STRANGER = '1000000009';
const CONSOLE = { 'x-console-token': 'fixture-console-token', 'x-agent-call': '1' };
const sendCalls = (h) => h.calls.http.filter((c) => /send_(group|private)_msg/.test(String(c.url)));
const ttsFilesIn = (dir) => {
  try { return fs.readdirSync(dir).filter((f) => /^tts-.*\.wav$/i.test(f)); } catch { return []; }
};

/** 手搓一个合法 PCM wav（不依赖 TTS），用来验证"没有 ffmpeg 也能探出时长"。 */
function makeWav(seconds = 1, rate = 8000) {
  const samples = Math.max(1, Math.round(seconds * rate));
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
const WAV = makeWav(1);

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
    request.setTimeout(15000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

/** 桥接夹具：真 bridge.js + 假网关；合成换成写手搓 wav 的桩。 */
async function fixture(socialV2 = {}) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: OWNER,
      allow: { private: [OWNER, STRANGER], groups: [] },
      socialV2: {
        ...socialV2,
        // 夹具的默认配置沿用「语音默认关、sendVoice 默认关」的历史默认值（与线上旧配置一致），
        // 所以正向用例必须显式打开 —— 这也正好让「开关关掉」的反向用例有意义。
        voice: { enabled: true, ...(socialV2.voice ?? {}) },
        tools: { sendVoice: true, ...(socialV2.tools ?? {}) }
      }
    },
    globals: {
      // 桩的返回值形状必须与 src/qqb/tts.mjs 的 synthesizeToFile 一致
      synthesizeToFile: async ({ outPath }) => {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, WAV);
        return { path: outPath, bytes: WAV.length, engine: 'stub-tts', voice: 'stub-voice' };
      }
    }
  });
  h.setMode('reserved2');
  return h;
}

const KEY = `private:${OWNER}`;
const tokenOf = (h, key = KEY) => h.getSocialV2State(key).agentToken;
const sendBody = (over = {}) => ({ key: KEY, text: '你好呀', ...over });
const voiceDirOf = (h) => path.join(h.temp, 'audio');

// ══ 一、src/qqb/tts.mjs（纯模块，Windows 真合成） ═════════════════════════════
if (!ttsAvailable()) {
  skip('TTS 模块：真合成一条 wav', `本机不可用（platform=${process.platform}）`);
  skip('TTS 模块：声音列表', '本机不可用');
  skip('TTS 模块：空文字/缺路径被拒', '本机不可用');
  skip('TTS 模块：点名的声音不存在时不冒充', '本机不可用');
} else {
  await test('TTS 模块：能找到 Windows 自带的合成声音（至少一个常见中文声音）', async () => {
    assert.match(powershellPath(), /powershell/i);
    const info = await listTtsVoices();
    assert.equal(info.ok, true, info.error);
    const all = [...info.sapi, ...info.onecore];
    assert.ok(all.length > 0, `一个声音都没有：${JSON.stringify(info)}`);
    assert.ok(all.some((v) => /Huihui|Kangkang|Yaoyao|Xiaoxiao|Zira|Hanhan/i.test(v)),
      `没找到常见中文声音：${JSON.stringify(info)}`);
  });

  await test('TTS 模块：真合成 → 产物是真 wav，且临时元数据被收干净', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-test-'));
    const out = path.join(dir, 'say.wav');
    try {
      const made = await synthesizeToFile({ text: '你好，我是小鲸鱼。', outPath: out });
      assert.equal(made.path, path.resolve(out));
      assert.ok(made.bytes > 4000, `产物太小：${made.bytes} 字节`);
      const buf = fs.readFileSync(out);
      assert.equal(buf.subarray(0, 4).toString('latin1'), 'RIFF', 'RIFF 头');
      assert.equal(buf.subarray(8, 12).toString('latin1'), 'WAVE', 'WAVE 标记');
      assert.ok(buf.includes(Buffer.from('fmt ')), '有 fmt 段（真音频，不是空壳文件）');
      assert.match(String(made.engine), /^(sapi5|onecore)$/);
      assert.ok(String(made.voice).length > 0, '要报告实际用的声音名（方便主人分辨是不是她的声音）');
      assert.equal(fs.existsSync(`${out}.voice.txt`), false, '元数据文件不该留在语音库里');
      assert.equal(fs.existsSync(`${out}.err.txt`), false, '错误文件不该留在语音库里');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('TTS 模块：空文字/缺输出路径被拒（不启动 PowerShell）', async () => {
    await assert.rejects(() => synthesizeToFile({ text: '   \n ', outPath: path.join(os.tmpdir(), 'nope.wav') }), /要合成的文字是空的/);
    await assert.rejects(() => synthesizeToFile({ text: '你好' }), /缺少输出路径/);
  });

  await test('TTS 模块：点名的声音不存在时，绝不拿别的声音冒充', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-test-'));
    const out = path.join(dir, 'bogus.wav');
    try {
      let made = null;
      try {
        made = await synthesizeToFile({ text: '试音', outPath: out, voice: 'Definitely-Not-A-Voice' });
      } catch (error) {
        assert.ok(String(error?.message ?? '').length > 0, '失败也要有可读原因');
        return;
      }
      assert.notEqual(String(made.voice), 'Definitely-Not-A-Voice', '不能声称用了不存在的声音');
      assert.ok(fs.existsSync(out), '兜底成功时产物要真的在');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ══ 二、桥接：synthesizeVoiceForV2 的开关与上限 ═══════════════════════════════
await test('桥接：voice.tts.enabled=false → 拒绝合成', async () => {
  const h = await fixture({ voice: { tts: { enabled: false } } });
  try {
    await assert.rejects(() => h.synthesizeVoiceForV2('你好'), /本机语音合成已关闭/);
    assert.equal(fs.existsSync(voiceDirOf(h)), false, '被拒时连语音库目录都不该建');
  } finally { await h.close(); }
});

await test('桥接：语音功能整体关掉（voice.enabled=false）→ 合成函数自己也要拒绝', async () => {
  // 端点在外层就挡住了（另有专门用例），这里钉的是 synthesizeVoiceForV2 自身的防线：
  // 将来若有别的调用方（CLI、主动发言）直接用它，也不会绕过总开关。
  const h = await fixture({ voice: { enabled: false } });
  try {
    await assert.rejects(() => h.synthesizeVoiceForV2('你好'), /语音功能已关闭/);
    assert.equal(fs.existsSync(voiceDirOf(h)), false, '被拒时连语音库目录都不该建');
  } finally { await h.close(); }
});

await test('桥接：超过 tts.maxChars → 拒绝并说清字数（不硬截断、不建目录）', async () => {
  const h = await fixture({ voice: { tts: { maxChars: 5 } } });
  try {
    await assert.rejects(
      () => h.synthesizeVoiceForV2('一二三四五六七八九十'),
      /太长（10 字，上限 5 字）/
    );
    assert.equal(fs.existsSync(voiceDirOf(h)), false, '被拒时连语音库目录都不该建');
  } finally { await h.close(); }
});

await test('桥接：产物落在语音库目录，且清理只删自己生成的 tts-*.wav', async () => {
  const h = await fixture({ voice: { tts: { keepFiles: 2 } } });
  try {
    const dir = voiceDirOf(h);
    fs.mkdirSync(dir, { recursive: true });
    // 主人自己放进去的音频：任何情况下都不许被清理
    const keepMe = path.join(dir, '主人的音频.wav');
    fs.writeFileSync(keepMe, WAV);
    // 历史产物：3 个（mtime 不同，最旧的应该先被清）
    for (const [i, name] of ['tts-20200101-000000-aaaa.wav', 'tts-20200102-000000-bbbb.wav', 'tts-20200103-000000-cccc.wav'].entries()) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, WAV);
      const t = new Date(Date.now() - (10 - i) * 86400000);
      fs.utimesSync(p, t, t);
    }
    const made = await h.synthesizeVoiceForV2('第一句');
    assert.ok(made.path.startsWith(dir), `产物必须在语音库内：${made.path}`);
    assert.equal(made.engine, 'stub-tts');
    assert.equal(ttsFilesIn(dir).length, 2, `keepFiles=2 但库里剩 ${ttsFilesIn(dir).join(', ')}`);
    assert.equal(fs.existsSync(keepMe), true, '主人放进来的音频绝不能被清理');
    assert.equal(ttsFilesIn(dir).includes('tts-20200101-000000-aaaa.wav'), false, '最旧的产物应该先被清掉');
    assert.ok(made.pruned >= 1, `要报告清理数量：${made.pruned}`);
  } finally { await h.close(); }
});

// ══ 三、桥接：/api/socialV2/send-voice 的 text 通道 ══════════════════════════
await test('端点：text 与 voice 同时给 → 400（不替人猜要哪个），且零合成零发送', async () => {
  const h = await fixture();
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-voice', {
        method: 'POST', headers: { 'x-agent-token': tokenOf(h) },
        body: sendBody({ voice: 'a.wav' })
      });
      assert.equal(res.status, 400, res.body);
      assert.match(String(res.json?.error), /只能给一个/);
    });
    assert.equal(sendCalls(h).length, 0, '参数冲突时一条都不能发');
    assert.equal(ttsFilesIn(voiceDirOf(h)).length, 0, '参数冲突时不该合成');
  } finally { await h.close(); }
});

await test('端点：工具开关 sendVoice=false → 403，且零发送', async () => {
  const h = await fixture({ tools: { sendVoice: false } });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-voice', {
        method: 'POST', headers: { 'x-agent-token': tokenOf(h) }, body: sendBody()
      });
      assert.equal(res.status, 403, res.body);
      assert.match(String(res.json?.error), /工具未启用/);
    });
    assert.equal(sendCalls(h).length, 0);
  } finally { await h.close(); }
});

await test('端点：语音功能整体关掉（voice.enabled=false）→ 403，且零合成', async () => {
  const h = await fixture({ voice: { enabled: false } });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-voice', {
        method: 'POST', headers: { 'x-agent-token': tokenOf(h) }, body: sendBody()
      });
      assert.equal(res.status, 403, res.body);
      assert.match(String(res.json?.error), /语音功能已关闭/);
    });
    assert.equal(sendCalls(h).length, 0);
    assert.equal(ttsFilesIn(voiceDirOf(h)).length, 0, '整体关掉时连合成都不该做');
  } finally { await h.close(); }
});

await test('端点：第二梯队求发语音 → 403（梯队门禁在合成之前）', async () => {
  const h = await fixture();
  try {
    // 私聊里"请求人"就是对方本人（不是最近说话的人），所以换成一个第二梯队的号私聊她。
    const strangerKey = `private:${STRANGER}`;
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-voice', {
        method: 'POST', headers: { 'x-agent-token': tokenOf(h, strangerKey) },
        body: { key: strangerKey, text: '说句话给我听听' }
      });
      assert.equal(res.status, 403, res.body);
      assert.match(String(res.json?.error), /只对第一梯队/);
      assert.equal(res.json?.requester, STRANGER);
    });
    assert.equal(sendCalls(h).length, 0, '被门禁拒了就不该发');
    assert.equal(ttsFilesIn(voiceDirOf(h)).length, 0, '被门禁拒了就不该合成（不许替陌生人烧算力）');
  } finally { await h.close(); }
});

await test('端点：文字超长 → 400，错误里带字数', async () => {
  const h = await fixture({ voice: { tts: { maxChars: 3 } } });
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-voice', {
        method: 'POST', headers: { 'x-agent-token': tokenOf(h) }, body: sendBody({ text: '一二三四五六' })
      });
      assert.equal(res.status, 400, res.body);
      assert.match(String(res.json?.error), /太长（6 字，上限 3 字）/);
    });
    assert.equal(sendCalls(h).length, 0);
  } finally { await h.close(); }
});

await test('端点：dryRun 只预演（合成 + 探测，不发），响应里有音频详情', async () => {
  const h = await fixture();
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-voice', {
        method: 'POST', headers: { 'x-agent-token': tokenOf(h) }, body: sendBody({ dryRun: true })
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json?.dryRun, true);
      assert.ok(String(res.json?.detail ?? '').length > 0, '要给出音频探测结果');
    });
    assert.equal(sendCalls(h).length, 0, 'dry-run 不能真发');
    assert.equal(ttsFilesIn(voiceDirOf(h)).length, 1, 'dry-run 仍要真合成出文件（只是不发）');
  } finally { await h.close(); }
});

await test('端点：真发一条 → 200、回读确认、回执带合成引擎、网关收到 record 段', async () => {
  const h = await fixture();
  try {
    await withServer(h, async (port) => {
      const res = await call(port, '/api/socialV2/send-voice', {
        method: 'POST', headers: { 'x-agent-token': tokenOf(h) },
        body: sendBody({ text: '今天早点睡，好不好？' })
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json?.ok, true);
      assert.equal(res.json?.verified, true, '要能回读到 record 段才算真发出去');
      assert.equal(res.json?.synthesized?.engine, 'stub-tts', '要带上本机合成的回执');
      assert.match(String(res.json?.file ?? ''), /^tts-.*\.wav$/);
    });
    const sends = sendCalls(h);
    assert.equal(sends.length, 1, `应该正好发一条，实际 ${sends.length}`);
    assert.match(JSON.stringify(sends[0].body ?? ''), /"type":"record"/);
    assert.equal(ttsFilesIn(voiceDirOf(h)).length, 1, '发完产物留在语音库（默认 keepFiles=20）');
  } finally { await h.close(); }
});

// ══ 收尾 ════════════════════════════════════════════════════════════════════
if (skipped.length) console.log(`\n（跳过 ${skipped.length} 项：本机/环境所限）`);
if (failures) {
  console.error(`\n❌ 语音 TTS 回归失败 ${failures} 项`);
  process.exit(1);
}
console.log('\n✅ 语音 TTS 回归全部通过');