// GPT-SoVITS 语音引擎（第二步：真人音色）的离线回归。
//
// 覆盖三件事，全部**不碰真模型**：
//   一、src/qqb/tts-gptsovits.mjs 纯模块：配置规整、问题清单、探活、合成请求形状与响应校验。
//       服务用一个本机 node:http 桩（127.0.0.1:0 随机端口）冒充，记录收到的请求体。
//   二、src/qqb/tts.mjs 的 synthesizeVoice 分发器：engine 选择、回落语义、未知引擎报错。
//   三、桥接接线（源码级 + 夹具内）：voiceCfg 是否把 engine/gptsovits 带下去、
//       synthesizeVoiceForV2 是否调分发器、回落原因是否浮到日志/返回值。
//
// 为什么这么测：真机验证要下 ~2 GB 模型、要显卡常驻；回归必须能在任何时候几秒内跑完。
// 真机链路另用 `node scripts/check-gptsovits.mjs`（doctor）验，不进回归。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_GPTSOVITS_BASE_URL,
  DEFAULT_GPTSOVITS_TIMEOUT_MS,
  gptsovitsHealth,
  gptsovitsProblems,
  gptsovitsSettings,
  inspectGptsovits,
  referenceName,
  selectWeights,
  synthesizeWithGptSoVits
} from '../src/qqb/tts-gptsovits.mjs';
import { synthesizeVoice, synthesizeToFile, ttsAvailable } from '../src/qqb/tts.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gptsovits-test-'));

let pass = 0;
let fail = 0;
let skipCount = 0;
function ok(name, detail = '') {
  pass += 1;
  console.log(`  ✅ ${name}${detail ? `（${detail}）` : ''}`);
}
function bad(name, error) {
  fail += 1;
  console.log(`  ❌ ${name}：${error?.message ?? error}`);
}
function skip(name, why) {
  skipCount += 1;
  console.log(`  ⏭️  ${name}：${why}`);
}
async function t(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (error) {
    bad(name, error);
  }
}

/** 一段最小的「真 wav」：44 字节 RIFF 头 + 一点静音数据。 */
function makeWav(samples = 64) {
  const data = Buffer.alloc(samples * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(32000, 24);
  head.writeUInt32LE(64000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/**
 * 起一个假 GPT-SoVITS 服务。
 * `handler(req, body)` 返回 { status, json } 或 { status, body: Buffer, type }；默认回一段 wav。
 */
async function fakeServer(handler = null) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, body: raw.length ? JSON.parse(raw.toString('utf8')) : null });
      const out = handler
        ? await handler(req, raw.length ? JSON.parse(raw.toString('utf8')) : null, seen.length)
        : null;
      if (!out) {
        const wav = makeWav();
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(wav);
        return;
      }
      if (out.json) {
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.json));
        return;
      }
      res.writeHead(out.status ?? 200, { 'content-type': out.type ?? 'application/octet-stream' });
      res.end(out.body ?? Buffer.alloc(0));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** 造一份可用的参考音频 + 参考文本。 */
function makeReference(name = 'ref.wav') {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, makeWav(320));
  return p;
}

console.log('GPT-SoVITS 语音引擎回归\n');

// ══ 一、纯模块 ════════════════════════════════════════════════════════════════
console.log('一、src/qqb/tts-gptsovits.mjs（纯模块）');

await t('配置规整：默认值与相对路径解析', () => {
  const s = gptsovitsSettings({ refAudio: 'audio/ref/小鲸鱼.wav' }, { root: ROOT });
  assert.equal(s.enabled, true);
  assert.equal(s.baseUrl, DEFAULT_GPTSOVITS_BASE_URL);
  assert.equal(s.timeoutMs, DEFAULT_GPTSOVITS_TIMEOUT_MS);
  assert.equal(s.fallback, true);
  assert.equal(s.textLang, 'zh');
  assert.equal(s.promptLang, 'zh');
  assert.equal(s.mediaType, 'wav');
  assert.equal(s.textSplitMethod, 'cut5');
  assert.equal(s.refAudio, path.join(ROOT, 'audio', 'ref', '小鲸鱼.wav'));
  // 地址末尾斜杠要吃掉，否则拼出 //tts
  assert.equal(gptsovitsSettings({ baseUrl: 'http://127.0.0.1:9880/' }).baseUrl, 'http://127.0.0.1:9880');
  // 显式关掉回落 / 关掉引擎
  assert.equal(gptsovitsSettings({ fallback: false }).fallback, false);
  assert.equal(gptsovitsSettings({ enabled: false }).enabled, false);
  // 空/垃圾入参不能炸
  assert.equal(gptsovitsSettings(null).baseUrl, DEFAULT_GPTSOVITS_BASE_URL);
  assert.equal(gptsovitsSettings('nonsense').refAudio, null);
});

await t('问题清单：缺音频、缺文本、语言不认、文件不在', () => {
  const empty = gptsovitsSettings({}, { root: tmpRoot });
  const p1 = gptsovitsProblems(empty);
  assert.equal(p1.length, 2, `空配置应报 2 条（缺音频+缺文本），实得 ${JSON.stringify(p1)}`);

  const missing = gptsovitsSettings({ refAudio: 'nope.wav', refText: '你好' }, { root: tmpRoot });
  assert.match(gptsovitsProblems(missing).join('；'), /参考音频不存在/);

  const badLang = gptsovitsSettings({ refAudio: 'nope.wav', refText: '你好', textLang: 'klingon' }, { root: tmpRoot });
  assert.match(gptsovitsProblems(badLang).join('；'), /textLang 不认识/);

  // checkFiles:false 时只在「没配」时报警，不看盘
  assert.equal(gptsovitsProblems(gptsovitsSettings({ refAudio: 'nope.wav', refText: 'x' }, { root: tmpRoot }), { checkFiles: false }).length, 0);

  const ref = makeReference('good-ref.wav');
  const good = gptsovitsSettings({ refAudio: ref, refText: '你好，我是小鲸鱼。' }, { root: tmpRoot });
  assert.deepEqual(gptsovitsProblems(good), []);
  assert.equal(referenceName(good), 'good-ref');
});

await t('探活：桩服务回 400 也算活；端口没人听算死', async () => {
  const s = await fakeServer(() => ({ status: 400, json: { message: 'command is required' } }));
  const up = await gptsovitsHealth({ baseUrl: s.baseUrl, timeoutMs: 2000 });
  assert.equal(up.ok, true, JSON.stringify(up));
  assert.equal(up.status, 400);
  assert.equal(s.seen[0].url, '/control');
  await s.close();

  // 关掉之后的端口：拿一个几乎不可能有人听的端口（先建再关，确保端口曾属于我们）
  const dead = await fakeServer();
  const deadUrl = dead.baseUrl;
  await dead.close();
  const down = await gptsovitsHealth({ baseUrl: deadUrl, timeoutMs: 1500 });
  assert.equal(down.ok, false, JSON.stringify(down));
  assert.match(String(down.error), /ECONNREFUSED|fetch failed|探活超时|socket/i);

  const boom = await fakeServer(() => ({ status: 502, json: { message: 'bad gateway' } }));
  const five = await gptsovitsHealth({ baseUrl: boom.baseUrl, timeoutMs: 1500 });
  assert.equal(five.ok, false);
  assert.equal(five.status, 502);
  await boom.close();
});

await t('合成：请求形状正确、wav 落盘、返回契约完整', async () => {
  const ref = makeReference('req-ref.wav');
  const s = await fakeServer();
  const out = path.join(tmpRoot, 'out', 'req.wav');
  const made = await synthesizeWithGptSoVits({
    text: '主人，我在的。',
    outPath: out,
    settings: {
      baseUrl: s.baseUrl,
      refAudio: ref,
      refText: '这是一段参考音频的逐字文本。',
      textLang: 'zh',
      promptLang: 'zh'
    },
    root: tmpRoot
  });
  const body = s.seen[0].body;
  assert.equal(s.seen[0].method, 'POST');
  assert.equal(s.seen[0].url, '/tts');
  assert.equal(body.text, '主人，我在的。');
  assert.equal(body.text_lang, 'zh');
  assert.equal(body.prompt_text, '这是一段参考音频的逐字文本。');
  assert.equal(body.prompt_lang, 'zh');
  assert.equal(body.ref_audio_path, ref);
  assert.deepEqual(body.aux_ref_audio_paths, []);
  assert.equal(body.media_type, 'wav');
  assert.equal(body.streaming_mode, false);
  assert.equal(body.text_split_method, 'cut5');
  assert.equal(body.top_k, 15);
  assert.equal(body.repetition_penalty, 1.35);
  assert.equal(body.speed_factor, 1);
  await s.close();

  assert.equal(made.path, out);
  assert.equal(made.engine, 'gptsovits');
  assert.equal(made.voice, 'req-ref');
  assert.equal(made.bytes, makeWav().length);
  assert.equal(fs.readFileSync(out).subarray(0, 4).toString('latin1'), 'RIFF');
});

await t('超时预算：不传 timeoutMs 时用配置里的，绝不吃 null（回归：曾被压成 1000ms）', async () => {
  const ref = makeReference('slow-ref.wav');
  const base = { refAudio: ref, refText: '参考文本' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 桩慢 1.5 秒；配置里 timeoutMs = 3000（调用时不传 timeoutMs）。
  // 老代码 num(null, s.timeoutMs) → Number(null)=0 → 预算被 Math.max 压成 1000ms ⇒ 这里会超时。
  const slow = await fakeServer(async () => { await sleep(1500); return null; });
  const made = await synthesizeWithGptSoVits({
    text: '慢一点也要等我。',
    outPath: path.join(tmpRoot, 'slow-ok.wav'),
    settings: { ...base, baseUrl: slow.baseUrl, timeoutMs: 3000 },
    root: tmpRoot
  });
  assert.ok(made.bytes > 0, 'should have synthesized');
  await slow.close();

  // 预算明确给 1200ms、桩慢 2 秒 → 错误文案必须带上真实预算，方便排查。
  const slower = await fakeServer(async () => { await sleep(2000); return null; });
  await assert.rejects(
    () => synthesizeWithGptSoVits({
      text: '这次一定会超时。',
      outPath: path.join(tmpRoot, 'slow-bad.wav'),
      settings: { ...base, baseUrl: slower.baseUrl },
      root: tmpRoot,
      timeoutMs: 1200
    }),
    /合成超时（1200ms）/
  );
  await slower.close();

  // 显式传 timeoutMs 要盖过配置。
  const faster = await fakeServer(async () => { await sleep(1500); return null; });
  await assert.rejects(
    () => synthesizeWithGptSoVits({
      text: '显式预算更短。',
      outPath: path.join(tmpRoot, 'slow-bad2.wav'),
      settings: { ...base, baseUrl: faster.baseUrl, timeoutMs: 60000 },
      root: tmpRoot,
      timeoutMs: 1200
    }),
    /合成超时（1200ms）/
  );
  await faster.close();
});

await t('合成：服务报错 / 非音频 / 空音频 / 缺参数 都要抛得明白', async () => {
  const ref = makeReference('err-ref.wav');
  const base = { baseUrl: '', refAudio: ref, refText: '参考文本' };

  const refused = await fakeServer(() => ({ status: 400, json: { message: 'tts failed', Exception: 'reference audio not found' } }));
  await assert.rejects(
    () => synthesizeWithGptSoVits({ text: '你好', outPath: path.join(tmpRoot, 'x1.wav'), settings: { ...base, baseUrl: refused.baseUrl }, root: tmpRoot }),
    /HTTP 400.*reference audio not found/s
  );
  await refused.close();

  const notAudio = await fakeServer(() => ({ status: 200, json: { ok: true, note: '这不是音频' } }));
  await assert.rejects(
    () => synthesizeWithGptSoVits({ text: '你好', outPath: path.join(tmpRoot, 'x2.wav'), settings: { ...base, baseUrl: notAudio.baseUrl }, root: tmpRoot }),
    /返回的不是音频/
  );
  await notAudio.close();

  const empty = await fakeServer(() => ({ status: 200, body: Buffer.alloc(0) }));
  await assert.rejects(
    () => synthesizeWithGptSoVits({ text: '你好', outPath: path.join(tmpRoot, 'x3.wav'), settings: { ...base, baseUrl: empty.baseUrl }, root: tmpRoot }),
    /空音频/
  );
  await empty.close();

  // 连不上
  const gone = await fakeServer();
  const goneUrl = gone.baseUrl;
  await gone.close();
  await assert.rejects(
    () => synthesizeWithGptSoVits({ text: '你好', outPath: path.join(tmpRoot, 'x4.wav'), settings: { ...base, baseUrl: goneUrl }, root: tmpRoot }),
    /连不上 GPT-SoVITS 服务/
  );

  // 配置不齐 / 空文字 / 缺路径
  await assert.rejects(
    () => synthesizeWithGptSoVits({ text: '你好', outPath: path.join(tmpRoot, 'x5.wav'), settings: { baseUrl: 'http://127.0.0.1:1' }, root: tmpRoot }),
    /配置不完整/
  );
  await assert.rejects(
    () => synthesizeWithGptSoVits({ text: '   ', outPath: path.join(tmpRoot, 'x6.wav'), settings: { ...base, baseUrl: 'http://127.0.0.1:1' }, root: tmpRoot }),
    /要合成的文字是空的/
  );
  await assert.rejects(
    () => synthesizeWithGptSoVits({ text: '你好', settings: { ...base, baseUrl: 'http://127.0.0.1:1' }, root: tmpRoot }),
    /缺少输出路径/
  );
});

await t('inspectGptsovits：问题清单 + 探活合成结论', async () => {
  const s = await fakeServer(() => ({ status: 400, json: { message: 'command is required' } }));
  const ref = makeReference('insp-ref.wav');
  const ready = await inspectGptsovits({ raw: { baseUrl: s.baseUrl, refAudio: ref, refText: '文本' }, root: tmpRoot });
  assert.equal(ready.ready, true, JSON.stringify(ready.problems));
  assert.equal(ready.health.ok, true);

  const notReady = await inspectGptsovits({ raw: { baseUrl: s.baseUrl }, root: tmpRoot });
  assert.equal(notReady.ready, false);
  assert.equal(notReady.problems.length, 2, JSON.stringify(notReady.problems));
  await s.close();
});

await t('selectWeights：两个端点都打到、失败会如实标出来', async () => {
  const s = await fakeServer((req) => ({ status: req.url.startsWith('/set_gpt_weights') ? 200 : 500, body: Buffer.from('ok') }));
  const good = await selectWeights({ baseUrl: s.baseUrl, gptWeights: 'A.ckpt', sovitsWeights: 'B.pth' });
  assert.equal(good.steps.length, 2);
  assert.equal(good.ok, false, '第二个端点 500 时 ok 必须是 false');
  assert.match(s.seen[0].url, /^\/set_gpt_weights\?weights_path=A\.ckpt$/);
  assert.match(s.seen[1].url, /^\/set_sovits_weights\?weights_path=B\.pth$/);
  const none = await selectWeights({ baseUrl: s.baseUrl });
  assert.deepEqual(none, { ok: true, steps: [] });
  await s.close();
});

// ══ 二、synthesizeVoice 分发器 ════════════════════════════════════════════════
console.log('\n二、src/qqb/tts.mjs 的 synthesizeVoice 分发器');

await t('engine=gptsovits + 服务可用 → 走 GPT-SoVITS', async () => {
  const s = await fakeServer();
  const ref = makeReference('disp-ref.wav');
  const out = path.join(tmpRoot, 'disp', 'a.wav');
  const made = await synthesizeVoice({
    text: '你好呀',
    outPath: out,
    engine: 'gptsovits',
    gptsovits: { baseUrl: s.baseUrl, refAudio: ref, refText: '参考文本' },
    root: tmpRoot
  });
  await s.close();
  assert.equal(made.engine, 'gptsovits');
  assert.equal(made.engineWanted, 'gptsovits');
  assert.equal(made.fallbackReason, undefined);
  assert.equal(fs.existsSync(out), true);
});

await t('engine=gptsovits + fallback:false + 服务不可用 → 抛错，不偷偷回落', async () => {
  const gone = await fakeServer();
  const url = gone.baseUrl;
  await gone.close();
  const ref = makeReference('disp-ref2.wav');
  await assert.rejects(
    () => synthesizeVoice({
      text: '你好呀',
      outPath: path.join(tmpRoot, 'disp', 'b.wav'),
      engine: 'gptsovits',
      gptsovits: { baseUrl: url, refAudio: ref, refText: '参考文本', fallback: false },
      root: tmpRoot
    }),
    /连不上 GPT-SoVITS 服务/
  );
});

await t('engine=gptsovits + enabled:false → 直接 SAPI（不算故障）', async () => {
  if (!ttsAvailable()) return skip('（返回值断言）', '本机没有 SAPI 声音');
  const out = path.join(tmpRoot, 'disp', 'c.wav');
  const made = await synthesizeVoice({
    text: '走保底引擎',
    outPath: out,
    engine: 'gptsovits',
    gptsovits: { enabled: false }
  });
  assert.equal(made.path, out);
  assert.match(String(made.engine), /sapi|onecore/i);
  assert.match(String(made.fallbackReason), /enabled=false/);
});

await t('engine=gptsovits + 服务不可用 + 允许回落 → 回落 SAPI 并带回原因', async () => {
  if (!ttsAvailable()) return skip('（回落断言）', '本机没有 SAPI 声音');
  const gone = await fakeServer();
  const url = gone.baseUrl;
  await gone.close();
  const ref = makeReference('disp-ref3.wav');
  const out = path.join(tmpRoot, 'disp', 'd.wav');
  const made = await synthesizeVoice({
    text: '回落测试',
    outPath: out,
    engine: 'gptsovits',
    gptsovits: { baseUrl: url, refAudio: ref, refText: '参考文本' },
    root: tmpRoot
  });
  assert.equal(fs.existsSync(out), true);
  assert.match(String(made.engine), /sapi|onecore/i);
  assert.match(String(made.fallbackReason), /连不上 GPT-SoVITS 服务/);
});

await t('engine 默认/未知：默认 sapi，未知要报错', async () => {
  if (ttsAvailable()) {
    const out = path.join(tmpRoot, 'disp', 'e.wav');
    const made = await synthesizeVoice({ text: '默认引擎', outPath: out });
    assert.match(String(made.engine), /sapi|onecore/i);
    assert.equal(made.engineWanted, 'sapi');
  } else {
    skip('（默认引擎）', '本机没有 SAPI 声音');
  }
  await assert.rejects(
    () => synthesizeVoice({ text: '你好', outPath: path.join(tmpRoot, 'disp', 'f.wav'), engine: 'elevenlabs' }),
    /不认识的语音引擎/
  );
  // SAPI 那条路本身没被改动（第一步的契约不能破）
  await assert.rejects(() => synthesizeToFile({ text: '  ', outPath: path.join(tmpRoot, 'nope.wav') }), /要合成的文字是空的/);
});

// ══ 三、桥接接线 ══════════════════════════════════════════════════════════════
console.log('\n三、桥接接线');

await t('源码级：bridge.js 把 engine/gptsovits 带下去、夹具注入没漏', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(bridge, /import \{ synthesizeVoice, ttsAvailable \} from '\.\/qqb\/tts\.mjs';/);
  assert.match(bridge, /engine: String\(t\.engine \?\? 'sapi'\)/);
  assert.match(bridge, /gptsovits: \{ \.\.\.\(t\.gptsovits \?\? \{\}\) \}/);
  assert.match(bridge, /await synthesizeVoice\(\{/);
  assert.match(bridge, /const gsvPrimary = /);
  assert.match(bridge, /fallbackReason: made\.fallbackReason \?\? null/);
  const tts = fs.readFileSync(path.join(ROOT, 'src', 'qqb', 'tts.mjs'), 'utf8');
  assert.match(tts, /import \{ gptsovitsSettings, synthesizeWithGptSoVits \} from '\.\/tts-gptsovits\.mjs';/);
  // 夹具剥掉 bridge.js 的顶层 import，靠 ...ttsLib 注入 —— 少一个导出就静默失效（⑤ 踩过）
  const harness = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-bridge-harness.mjs'), 'utf8');
  assert.match(harness, /\.\.\.ttsLib/);
});

await t('夹具内：synthesizeVoiceForV2 会把 engine 与回落原因带出来', async () => {
  const calls = [];
  const h = await bridgeHarness({
    config: { socialV2: { voice: { enabled: true, tts: { enabled: true, engine: 'gptsovits', gptsovits: { refAudio: 'audio/x.wav', refText: '文本' } } } } },
    globals: {
      synthesizeVoice: async (opts) => {
        calls.push(opts);
        fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
        fs.writeFileSync(opts.outPath, makeWav(8));
        return {
          path: opts.outPath,
          bytes: fs.statSync(opts.outPath).size,
          engine: 'sapi5',
          voice: 'Microsoft Huihui Desktop',
          engineWanted: opts.engine,
          fallbackReason: '连不上 GPT-SoVITS 服务（http://127.0.0.1:9880）：fetch failed'
        };
      }
    }
  });
  try {
    const made = await h.synthesizeVoiceForV2('试试真人音色');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].engine, 'gptsovits');
    assert.equal(calls[0].voice, '');
    // 注意：这两个对象来自 VM 里的另一个 realm（bridgeHarness 用 vm.createContext），
// deepStrictEqual 会因为**原型不同**报 "same structure but are not reference-equal"，
// 所以按字段比（JSON 化再比）—— 比的是语义，不是对象身份。
    assert.equal(JSON.stringify(calls[0].gptsovits), JSON.stringify({ refAudio: 'audio/x.wav', refText: '文本' }));
    // 夹具把 bridge.js 的 import.meta.url 改写到临时目录，所以 VM 里的 ROOT 就是 h.temp
    // —— 这也正是「root 必须一路传下去」的证明：路径解析基准跟着桥接自己的根走。
    assert.equal(path.resolve(calls[0].root), h.temp);
    assert.equal(made.engine, 'sapi5');
    assert.match(String(made.fallbackReason), /连不上 GPT-SoVITS 服务/);
    assert.equal(calls[0].text, '试试真人音色');
    assert.match(path.basename(made.path), /^tts-\d{8}-\d{6}-[a-z0-9]{4}\.wav$/);
  } finally {
    await h.close?.();
  }
});

await t('夹具内：默认仍是 sapi（第一步的行为不被悄悄改掉）', async () => {
  const calls = [];
  const h = await bridgeHarness({
    config: { socialV2: { voice: { enabled: true, tts: { enabled: true } } } },
    globals: {
      synthesizeVoice: async (opts) => {
        calls.push(opts);
        fs.writeFileSync(opts.outPath, makeWav(8));
        return { path: opts.outPath, bytes: 8, engine: 'sapi5', voice: 'x', engineWanted: opts.engine };
      }
    }
  });
  try {
    await h.synthesizeVoiceForV2('默认走保底');
    assert.equal(calls[0].engine, 'sapi');
    assert.equal(JSON.stringify(calls[0].gptsovits), '{}');
  } finally {
    await h.close?.();
  }
});

// ══ 收尾 ══════════════════════════════════════════════════════════════════════
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

console.log(`\n汇总：PASS ${pass} / FAIL ${fail} / SKIP ${skipCount}`);
if (fail) {
  console.log('❌ GPT-SoVITS 语音引擎回归存在失败项');
  process.exit(1);
}
console.log('✅ GPT-SoVITS 语音引擎回归全部通过');