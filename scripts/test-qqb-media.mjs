// R6 媒体能力层的单测：provider 契约、能力声明、预留能力抛错、注册表选择与统计。
// 全部走注入的假 fetch，不碰真 Ollama、不发网络请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VERSION,
  CAPABILITIES,
  RESERVED,
  PROMPTS,
  notSupportedError,
  visionConfigOf,
  mediaConfigOf,
  generateOptionsOf,
  defineProvider,
  createOllamaProvider,
  createMediaRegistry
} from '../src/qqb/media/providers.mjs';
import {
  normalizeImageForVision,
  imageSize,
  sniffImageFormat,
  DEFAULT_MAX_SIDE
} from '../src/qqb/media/resize.mjs';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

const CFG = {
  vision: { enabled: true, baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5vl:3b', timeoutMs: 60000, maxImages: 2 },
  media: { defaultProvider: 'ollama' }
};

function fakeFetch(response) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts, body: opts.body ? JSON.parse(opts.body) : null });
    if (typeof response === 'function') return response(url, opts, calls.length);
    return response;
  };
  impl.calls = calls;
  return impl;
}

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body
});

test('常量与配置默认值自洽', () => {
  assert.equal(VERSION, '0.1.0');
  assert.deepEqual(CAPABILITIES, ['describe', 'image2image', 'videoFrames']);
  assert.deepEqual(RESERVED, ['image2image', 'videoFrames']);
  assert.ok(PROMPTS.describe.includes('逐字转录'));
  assert.ok(PROMPTS.ocr.startsWith('只做一件事'));
  const v = visionConfigOf({});
  assert.equal(v.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(v.model, 'qwen2.5vl:3b');
  assert.equal(v.timeoutMs, 120000);
  assert.equal(v.maxImages, 3);
  assert.equal(visionConfigOf({ vision: { baseUrl: 'http://x:1/', enabled: false, timeoutMs: 100 } }).timeoutMs, 5000, '超时要夹到下限');
  assert.equal(mediaConfigOf({}).defaultProvider, 'ollama');
  assert.equal(mediaConfigOf({ media: { defaultProvider: 'cloud' } }).defaultProvider, 'cloud');
});

test('defineProvider 补齐预留能力：没实现的能力抛出可识别的「暂未接入」', async () => {
  const p = defineProvider({ name: 'fake', capabilities: { describe: true, image2image: true } });
  assert.equal(p.capabilities.describe, true);
  assert.equal(p.capabilities.image2image, true);
  assert.equal(p.capabilities.videoFrames, false, '没声明也没实现的算不支持');
  await assert.rejects(() => p.videoFrames({ video: 'x' }), (error) => {
    assert.equal(error.code, 'MEDIA_NOT_SUPPORTED');
    assert.equal(error.capability, 'videoFrames');
    assert.match(error.message, /暂未接入/);
    return true;
  });
  const e = notSupportedError('image2image', 'cloud');
  assert.equal(e.code, 'MEDIA_NOT_SUPPORTED');
  assert.match(e.message, /cloud/);
});

test('Ollama provider：正常描述，请求体带上模型 / 提示词 / 关注点', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ response: '  一只橘猫趴在键盘上  ' }));
  const provider = createOllamaProvider({ config: CFG, fetchImpl });
  const out = await provider.describe({ image: 'BASE64', mode: 'describe', focus: '它手里拿的是什么' });
  assert.equal(out.text, '一只橘猫趴在键盘上');
  assert.equal(out.model, 'qwen2.5vl:3b');
  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:11434/api/generate');
  assert.equal(call.body.model, 'qwen2.5vl:3b');
  assert.deepEqual(call.body.images, ['BASE64']);
  assert.equal(call.body.stream, false);
  assert.ok(call.body.prompt.includes('补充关注点：它手里拿的是什么'));
  assert.ok(call.body.prompt.includes(PROMPTS.describe));
});

test('Ollama provider：ocr 模式用 ocr 提示词', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ response: 'hello' }));
  const provider = createOllamaProvider({ config: CFG, fetchImpl });
  await provider.describe({ image: 'B', mode: 'ocr' });
  assert.ok(fetchImpl.calls[0].body.prompt.startsWith(PROMPTS.ocr));
});

test('Ollama provider：四类失败都给得出人话（未启用 / 连不上 / 报错 / 空结果）', async () => {
  const disabled = createOllamaProvider({ config: { vision: { enabled: false } }, fetchImpl: fakeFetch(jsonResponse({})) });
  await assert.rejects(() => disabled.describe({ image: 'B' }), /本地视觉未启用/);

  const down = createOllamaProvider({
    config: CFG,
    fetchImpl: async () => { throw new Error('fetch failed'); }
  });
  await assert.rejects(() => down.describe({ image: 'B' }), (error) => {
    assert.match(error.message, /连接本地视觉服务失败/);
    assert.match(error.message, /ollama pull qwen2\.5vl:3b/);
    return true;
  });

  const bad = createOllamaProvider({ config: CFG, fetchImpl: fakeFetch(jsonResponse({ error: 'model not found' }, { ok: false, status: 404 })) });
  await assert.rejects(() => bad.describe({ image: 'B' }), /本地视觉模型调用失败：model not found/);

  const empty = createOllamaProvider({ config: CFG, fetchImpl: fakeFetch(jsonResponse({ response: '   ' })) });
  await assert.rejects(() => empty.describe({ image: 'B' }), /返回了空结果/);

  const noImage = createOllamaProvider({ config: CFG, fetchImpl: fakeFetch(jsonResponse({ response: 'x' })) });
  await assert.rejects(() => noImage.describe({}), /没有拿到图片数据/);
});

test('注册表：默认 provider、未知 provider、能力表与统计', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ response: '看图结果' }));
  const registry = createMediaRegistry({ config: CFG, fetchImpl });
  assert.deepEqual(registry.names(), ['ollama']);
  assert.equal(registry.defaultName(), 'ollama');
  const caps = registry.capabilities();
  assert.deepEqual(caps.capabilities.describe, ['ollama']);
  assert.deepEqual(caps.capabilities.image2image, [], '预留能力此刻没有实现者');
  assert.deepEqual(caps.reserved, RESERVED);

  const out = await registry.describeImage({ image: 'B' });
  assert.equal(out.ok, true);
  assert.equal(out.text, '看图结果');
  assert.equal(out.provider, 'ollama');
  assert.deepEqual(registry.stats().byProvider.ollama, { calls: 1, failures: 0 });

  await assert.rejects(() => registry.describeImage({ image: 'B', provider: 'nope' }), /没有可用的视觉 provider/);
  assert.throws(() => registry.setDefault('nope'), /没有这个 provider/);
});

test('注册表：换配置（模型 / 默认 provider）不用重启，reconfigure 后立即生效', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ response: 'ok' }));
  const registry = createMediaRegistry({ config: CFG, fetchImpl });
  registry.configure({ vision: { ...CFG.vision, model: 'qwen2.5vl:7b' }, media: { defaultProvider: 'ollama' } });
  await registry.describeImage({ image: 'B' });
  assert.equal(fetchImpl.calls.at(-1).body.model, 'qwen2.5vl:7b');
});

test('注册表：可注册新 provider 并设为默认（换云端视觉不用改调用点）', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ response: 'local' }));
  const registry = createMediaRegistry({ config: CFG, fetchImpl });
  const cloud = defineProvider({
    name: 'cloud',
    capabilities: { describe: true },
    async describe({ image }) { return { text: `cloud:${image}`, model: 'cloud-vl' }; }
  });
  registry.register(cloud);
  registry.setDefault('cloud');
  const out = await registry.describeImage({ image: 'B' });
  assert.equal(out.text, 'cloud:B');
  assert.equal(out.provider, 'cloud');
  assert.equal(fetchImpl.calls.length, 0, '走云端 provider 时不该再打本机 Ollama');
});

test('预留能力：默认 provider 上调用得到 MEDIA_NOT_SUPPORTED，且计入 reservedCalls', async () => {
  const registry = createMediaRegistry({ config: CFG, fetchImpl: fakeFetch(jsonResponse({ response: 'x' })) });
  await assert.rejects(() => registry.image2image({ source: 'B', prompt: '画成猫' }), (error) => {
    assert.equal(error.code, 'MEDIA_NOT_SUPPORTED');
    return true;
  });
  await assert.rejects(() => registry.videoFrames({ video: '/tmp/a.mp4', count: 3 }), /暂未接入/);
  assert.equal(registry.stats().reservedCalls, 2);
});

test('预留能力：一旦有 provider 实现了，注册表就直接转调，调用点无需改动', async () => {
  const registry = createMediaRegistry({ config: CFG, fetchImpl: fakeFetch(jsonResponse({ response: 'x' })) });
  const painter = defineProvider({
    name: 'painter',
    capabilities: { image2image: true, videoFrames: true },
    async image2image({ prompt }) { return { images: [`data:image/png;base64,${prompt}`] }; },
    async videoFrames({ count }) { return { frames: Array.from({ length: count }, (_, i) => `frame-${i}`) }; }
  });
  registry.register(painter);
  registry.setDefault('painter');
  const img = await registry.image2image({ prompt: 'cat' });
  assert.deepEqual(img.images, ['data:image/png;base64,cat']);
  const vid = await registry.videoFrames({ count: 2 });
  assert.deepEqual(vid.frames, ['frame-0', 'frame-1']);
  assert.equal(registry.stats().reservedCalls, 0, '有实现时不算「预留空调用」');
});

test('provider 抛错时注册表计入 failures 并把错误原样抛出', async () => {
  const registry = createMediaRegistry({ config: CFG, fetchImpl: async () => { throw new Error('boom'); } });
  await assert.rejects(() => registry.describeImage({ image: 'B' }), /连接本地视觉服务失败/);
  assert.equal(registry.stats().failures, 1);
  assert.equal(registry.stats().byProvider.ollama.failures, 1);
});

// ── 复读中断的自愈：生成参数有上限 + 命中 repeat 时重试一次 ──────────────────
// 历史问题：qwen2.5vl:3b 在长文字截图上复读，Ollama 中断后整次识图作废
// （日志里的 `prediction aborted, token repeat limit reached`）。原来只传 temperature，
// 既没输出上限也没重复惩罚，也不重试。

test('生成参数：默认带上输出上限与重复惩罚，重试时加重惩罚并缩短输出', () => {
  const base = generateOptionsOf({});
  assert.equal(base.temperature, 0.1);
  assert.equal(base.num_predict, 2048);
  assert.equal(base.repeat_penalty, 1.15);
  assert.equal(base.repeat_last_n, 512);

  const retry = generateOptionsOf({}, { retry: true });
  assert.ok(retry.repeat_penalty > base.repeat_penalty, '重试要更狠地罚重复');
  assert.ok(retry.num_predict < base.num_predict, '重试要给更短的输出预算');

  const tuned = generateOptionsOf({ numPredict: 512, repeatPenalty: 1.3 });
  assert.equal(tuned.num_predict, 512);
  assert.equal(tuned.repeat_penalty, 1.3);

  const v = visionConfigOf({ vision: { numPredict: 4096, repeatPenalty: 1.25, retries: 2 } });
  assert.equal(v.numPredict, 4096);
  assert.equal(v.repeatPenalty, 1.25);
  assert.equal(v.retries, 2);
  assert.equal(visionConfigOf({}).retries, 1, '默认重试一次');
});

test('Ollama provider：请求体带 options（上限 + 重复惩罚），不再只有 temperature', async () => {
  const fetchImpl = fakeFetch(jsonResponse({ response: 'ok' }));
  const provider = createOllamaProvider({ config: CFG, fetchImpl });
  await provider.describe({ image: 'B' });
  const { options } = fetchImpl.calls[0].body;
  assert.equal(options.num_predict, 2048);
  assert.equal(options.repeat_penalty, 1.15);
  assert.equal(options.temperature, 0.1);
});

test('Ollama provider：复读中断自动重试一次，第二次成功就正常返回', async () => {
  const fetchImpl = fakeFetch((_url, _opts, n) => (n === 1
    ? jsonResponse({ error: 'prediction aborted, token repeat limit reached' }, { ok: false, status: 500 })
    : jsonResponse({ response: '  重试后抄完了  ' })));
  const warns = [];
  const provider = createOllamaProvider({ config: CFG, fetchImpl, logger: { warn: (m, d) => warns.push(`${m} ${d}`) } });
  const out = await provider.describe({ image: 'B', mode: 'ocr' });
  assert.equal(out.text, '重试后抄完了');
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls[1].body.options.repeat_penalty > fetchImpl.calls[0].body.options.repeat_penalty);
  assert.ok(warns.some((w) => w.includes('复读')));
});

test('Ollama provider：重试也失败时报原来的错误；不可自愈的错误不重试', async () => {
  const always = fakeFetch(jsonResponse({ error: 'token repeat limit reached' }, { ok: false, status: 500 }));
  const provider = createOllamaProvider({ config: CFG, fetchImpl: always });
  await assert.rejects(() => provider.describe({ image: 'B' }), /token repeat limit reached/);
  assert.equal(always.calls.length, 2, '默认 1 次重试');

  const notFound = fakeFetch(jsonResponse({ error: 'model not found' }, { ok: false, status: 404 }));
  const p2 = createOllamaProvider({ config: CFG, fetchImpl: notFound });
  await assert.rejects(() => p2.describe({ image: 'B' }), /model not found/);
  assert.equal(notFound.calls.length, 1, '模型不存在重试也没用，不该白等');

  const disabledRetry = createOllamaProvider({
    config: { ...CFG, vision: { ...CFG.vision, retries: 0 } },
    fetchImpl: fakeFetch(jsonResponse({ error: 'token repeat limit reached' }, { ok: false, status: 500 }))
  });
  await assert.rejects(() => disabledRetry.describe({ image: 'B' }), /repeat limit/);
});
// ── 送模型前的缩图（resize.mjs）：大图必缩、小图不动、坏数据不抛错 ─────────────
function makePng(w, h, color = [180, 40, 40, 255]) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) data.set(color, i * 4);
  return PNG.sync.write({ width: w, height: h, data });
}

function makeJpeg(w, h) {
  const data = Buffer.alloc(w * h * 4, 128);
  return Buffer.from(jpeg.encode({ width: w, height: h, data }, 80).data);
}

test('缩图：小图原样返回，不解码也不改字节', () => {
  const big = makePng(320, 200).toString('base64');
  const out = normalizeImageForVision(big);
  assert.equal(out.resized, false);
  assert.equal(out.base64, big);
  assert.equal(out.width, 320);
  assert.equal(out.height, 200);
  assert.equal(DEFAULT_MAX_SIDE, 1280);
});

test('缩图：长边超限的 PNG 缩到 1280 且保持比例，仍可解码', () => {
  const out = normalizeImageForVision(makePng(1600, 1200).toString('base64'));
  assert.equal(out.resized, true);
  assert.equal(out.format, 'png');
  assert.equal(out.originalWidth, 1600);
  assert.equal(out.width, 1280);
  assert.equal(out.height, 960);
  const decoded = PNG.sync.read(Buffer.from(out.base64, 'base64'));
  assert.equal(decoded.width, 1280);
  assert.equal(decoded.height, 960);
});

test('缩图：JPEG 同样按长边缩（横图/竖图都试）', () => {
  const wide = normalizeImageForVision(makeJpeg(2000, 1000).toString('base64'));
  assert.equal(wide.resized, true);
  assert.equal(wide.width, 1280);
  assert.equal(wide.height, 640);
  assert.equal(sniffImageFormat(Buffer.from(wide.base64, 'base64')), 'jpeg');

  const tall = normalizeImageForVision(makeJpeg(900, 1600).toString('base64'));
  assert.equal(tall.width, 720);
  assert.equal(tall.height, 1280);
});

const GIF_HEADER = Buffer.concat([
  Buffer.from('GIF89a', 'latin1'),
  // 1600x1200（小端）：故意超过 1280，走「格式不支持、原样返回」这条分支
  Buffer.from([0x40, 0x06, 0xb0, 0x04, 0x00, 0x00, 0x00, 0x00, 0x3b])
]);

test('缩图：不支持的格式（gif/webp）原样返回并说明原因', () => {
  const out = normalizeImageForVision(GIF_HEADER.toString('base64'));
  assert.equal(out.resized, false);
  assert.equal(out.format, 'gif');
  assert.match(out.note, /暂不缩放 gif/);
});

test('缩图：坏数据不抛错，只是原样返回', () => {
  const out = normalizeImageForVision('B');
  assert.equal(out.resized, false);
  assert.ok(out.note);
});

test('imageSize / sniffImageFormat：按文件头识别宽高', () => {
  assert.deepEqual(imageSize(makePng(64, 32)), { format: 'png', width: 64, height: 32 });
  assert.deepEqual(imageSize(makeJpeg(48, 30)), { format: 'jpeg', width: 48, height: 30 });
  assert.equal(sniffImageFormat(GIF_HEADER), 'gif');
  assert.equal(sniffImageFormat(Buffer.from('nope', 'latin1')), null);
});

test('Ollama provider：大图在发送前自动缩小（避免 token repeat limit）', async () => {
  const ff = fakeFetch(jsonResponse({ response: 'ok' }));
  const provider = createOllamaProvider({ config: CFG, fetchImpl: ff });
  const r = await provider.describe({ image: makePng(1600, 1200).toString('base64') });
  assert.equal(r.image.resized, true);
  assert.equal(r.image.note, '1600x1200 → 1280x960');
  const sent = imageSize(Buffer.from(ff.calls[0].body.images[0], 'base64'));
  assert.equal(sent.width, 1280);
  assert.equal(sent.height, 960);
});
