// GPT-SoVITS 本机语音合成适配层（第二步：真人音色 / 声音克隆）。
//
// 为什么是「本机服务 + HTTP」而不是把模型塞进 node：
//   GPT-SoVITS 是 Python + torch + 显卡的活（推理要几秒、首次加载模型要几十秒），
//   node 侧只该做一件事 —— 把文字交给它、把 wav 拿回来。所以这里是**薄适配层**：
//   调它自带的 `api_v2.py`（FastAPI，默认 127.0.0.1:9880）的 `POST /tts`，返回 wav 字节落盘。
//
// 与 SAPI 的关系（见 tts.mjs 的 synthesizeVoice）：
//   SAPI/OneCore 是零依赖的**保底**，GPT-SoVITS 是**更好听**的那一档；
//   服务没起来 / 模型没下好 / 参考音频缺失时，一律回落到 SAPI —— 语音这条链路
//   绝不能因为「音色引擎没就绪」而整条失败。
//
// 安全：文字走 HTTP body（JSON），**不拼命令行**（与 SAPI 路径同一条规矩）。
import fs from 'node:fs';
import path from 'node:path';

/** 本机 GPT-SoVITS 服务的默认地址（api_v2.py 的默认绑定与端口）。 */
export const DEFAULT_GPTSOVITS_BASE_URL = 'http://127.0.0.1:9880';

/** 默认超时：首次请求要加载模型（实测几十秒），给足；后续一句通常 2-10 秒。 */
export const DEFAULT_GPTSOVITS_TIMEOUT_MS = 120000;

/** 探活超时：这是「端口开没开」级别的问题，必须快，不能拖住发送。 */
export const DEFAULT_HEALTH_TIMEOUT_MS = 3000;

/** 支持的文本语言（api_v2.py 的 text_lang / prompt_lang 取值）。 */
export const LANGS = ['zh', 'en', 'ja', 'ko', 'yue', 'auto'];

const str = (v, d = '') => (v === undefined || v === null ? d : String(v));
// 注意：null/空串要当作「没给」，不能走 Number() —— Number(null) 是 0（有限数），
// 会把「没传超时」误判成「超时 0ms」。这个坑真的踩过：分发器不传 timeoutMs 时
// 预算被压成 1000ms，真人音色每次都超时回落 SAPI。
const num = (v, d) => (v === null || v === undefined || v === '' ? d : (Number.isFinite(Number(v)) ? Number(v) : d));

/**
 * 把配置里的 `socialV2.voice.gptsovits` 段规整成内部设置。
 *
 * `root` 用来把相对路径（如 `audio/ref/小鲸鱼.wav`）解析成绝对路径 ——
 * 服务端与我们同机，传绝对路径最稳（它的工作目录不一定是仓库目录）。
 */
export function gptsovitsSettings(raw = {}, { root = process.cwd() } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const refAudioRaw = str(r.refAudio ?? r.ref_audio ?? r.refAudioPath);
  return {
    enabled: r.enabled !== false,
    baseUrl: str(r.baseUrl ?? r.url, DEFAULT_GPTSOVITS_BASE_URL).replace(/\/+$/, ''),
    refAudio: refAudioRaw ? path.resolve(root, refAudioRaw) : null,
    refText: str(r.refText ?? r.ref_text),
    textLang: str(r.textLang, 'zh').toLowerCase(),
    promptLang: str(r.promptLang, 'zh').toLowerCase(),
    mediaType: str(r.mediaType, 'wav').toLowerCase(),
    textSplitMethod: str(r.splitMethod ?? r.text_split_method, 'cut5'),
    speedFactor: num(r.speedFactor, 1),
    topK: num(r.topK, 15),
    topP: num(r.topP, 1),
    temperature: num(r.temperature, 1),
    repetitionPenalty: num(r.repetitionPenalty, 1.35),
    timeoutMs: num(r.timeoutMs, DEFAULT_GPTSOVITS_TIMEOUT_MS),
    healthTimeoutMs: num(r.healthTimeoutMs, DEFAULT_HEALTH_TIMEOUT_MS),
    /**
     * 没在用就关掉服务（分钟）。服务常驻要 **提交 8.3 GB** 内存（实测 2026-10-26：PID 13556，
     * WorkingSet 531 MB / Private 8283 MB），这台机一共 16 GB，闲着也占着就没人敢开游戏了。
     * 0 / 负数 = 不自动关（一直保活，第一次发语音最快）。
     */
    idleStopMinutes: num(r.idleStopMinutes, 10),
    /** 服务不可用时是否回落到 SAPI（默认回落；关掉就「要么 GPT-SoVITS，要么这条语音不发」）。 */
    fallback: r.fallback !== false
  };
}

/**
 * 检查设置是否「够用」，返回人话问题清单（空数组 = 可以合成）。
 *
 * 特意把「参考音频不存在」「参考文本为空」单独挑出来：GPT-SoVITS 的零样本克隆
 * 必须同时给参考音频**和它的逐字文本**，缺一个它就会拿错音素、听起来像另一个人。
 */
export function gptsovitsProblems(settings = {}, { checkFiles = true } = {}) {
  const problems = [];
  if (!settings.refAudio) problems.push('没有配参考音频：socialV2.voice.gptsovits.refAudio');
  else if (checkFiles) {
    try {
      if (!fs.existsSync(settings.refAudio)) problems.push(`参考音频不存在：${settings.refAudio}`);
    } catch {
      problems.push(`参考音频路径读不了：${settings.refAudio}`);
    }
  }
  if (!String(settings.refText ?? '').trim()) problems.push('没有配参考文本：socialV2.voice.gptsovits.refText（要和参考音频逐字一致）');
  if (!settings.baseUrl) problems.push('没有配服务地址：socialV2.voice.gptsovits.baseUrl');
  if (settings.textLang && !LANGS.includes(settings.textLang)) problems.push(`textLang 不认识：${settings.textLang}（可用 ${LANGS.join('/')}）`);
  if (settings.promptLang && !LANGS.includes(settings.promptLang)) problems.push(`promptLang 不认识：${settings.promptLang}（可用 ${LANGS.join('/')}）`);
  return problems;
}

/** 参考音频的展示名（日志/返回值里用，例如 `小鲸鱼`）。 */
export function referenceName(settings = {}) {
  if (!settings.refAudio) return '';
  try {
    return path.basename(settings.refAudio).replace(/\.[^.]+$/, '');
  } catch {
    return '';
  }
}

/**
 * 探活：服务在不在。
 *
 * 用 `GET /control`（不带 command）：它**不碰模型**、立刻回 400 `command is required`，
 * 所以「拿到任何 HTTP 响应」就说明 FastAPI 在监听；连接被拒/超时才是没起来。
 */
export async function gptsovitsHealth({ baseUrl = DEFAULT_GPTSOVITS_BASE_URL, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS } = {}) {
  const url = `${str(baseUrl, DEFAULT_GPTSOVITS_BASE_URL).replace(/\/+$/, '')}/control`;
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(Math.max(500, Number(timeoutMs) || DEFAULT_HEALTH_TIMEOUT_MS)) });
    // 400（缺参数）/ 200 / 405 都算「HTTP 活着」；只有 5xx 才当异常。
    if (res.status >= 500) return { ok: false, status: res.status, baseUrl, error: `服务返回 ${res.status}` };
    return { ok: true, status: res.status, baseUrl };
  } catch (error) {
    const msg = error?.name === 'TimeoutError' ? `探活超时（${timeoutMs}ms）` : error?.message ?? String(error);
    return { ok: false, baseUrl, error: msg };
  }
}

/** 上手前先自检：设置够不够 + 服务在不在。给 doctor 脚本与桥接的错误提示共用。 */
export async function inspectGptsovits({ raw = {}, root = process.cwd(), checkService = true } = {}) {
  const settings = gptsovitsSettings(raw, { root });
  const problems = gptsovitsProblems(settings);
  const health = checkService ? await gptsovitsHealth({ baseUrl: settings.baseUrl, timeoutMs: settings.healthTimeoutMs }) : null;
  return { settings, problems, health, ready: problems.length === 0 && (!health || health.ok) };
}

/**
 * 真正合成一句话：`POST /tts` → wav 字节 → 落盘。
 *
 * 失败一律抛中文错误（与 synthesizeToFile 一致），由上层决定是否回落 SAPI。
 */
export async function synthesizeWithGptSoVits({
  text,
  outPath,
  settings = {},
  root = process.cwd(),
  timeoutMs = null
} = {}) {
  const s = gptsovitsSettings(settings, { root });
  const content = String(text ?? '');
  if (!content.trim()) throw new Error('要合成的文字是空的');
  if (!outPath) throw new Error('缺少输出路径 outPath');

  const problems = gptsovitsProblems(s);
  if (problems.length) throw new Error(`GPT-SoVITS 配置不完整：${problems.join('；')}`);

  const out = path.resolve(String(outPath));
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const body = {
    text: content,
    text_lang: s.textLang,
    ref_audio_path: s.refAudio,
    aux_ref_audio_paths: [],
    prompt_text: s.refText,
    prompt_lang: s.promptLang,
    top_k: s.topK,
    top_p: s.topP,
    temperature: s.temperature,
    text_split_method: s.textSplitMethod,
    batch_size: 1,
    media_type: s.mediaType,
    streaming_mode: false,
    speed_factor: s.speedFactor,
    repetition_penalty: s.repetitionPenalty,
    parallel_infer: true
  };

  const budget = Math.max(1000, num(timeoutMs ?? s.timeoutMs, DEFAULT_GPTSOVITS_TIMEOUT_MS));
  let res;
  try {
    res = await fetch(`${s.baseUrl}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(budget)
    });
  } catch (error) {
    const msg = error?.name === 'TimeoutError'
      ? `GPT-SoVITS 合成超时（${budget}ms）——首次调用要加载模型，可以把 socialV2.voice.gptsovits.timeoutMs 调大`
      : `连不上 GPT-SoVITS 服务（${s.baseUrl}）：${error?.message ?? error}`;
    throw new Error(msg);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = str(j?.Exception ?? j?.message ?? j);
    } catch {
      try { detail = (await res.text()).slice(0, 300); } catch {}
    }
    throw new Error(`GPT-SoVITS 合成失败（HTTP ${res.status}）：${detail || '服务没有给出原因'}`);
  }

  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    throw new Error(`GPT-SoVITS 返回的音频读不出来：${error?.message ?? error}`);
  }
  if (!buf.length) throw new Error('GPT-SoVITS 返回了空音频');

  // 校验确实是音频：服务出错时偶尔会回一段 JSON（HTTP 200 但内容是错误）。
  const head = buf.subarray(0, 4).toString('latin1');
  const looksAudio = head === 'RIFF' || head.startsWith('OggS') || head.startsWith('fLaC') || head.startsWith('ID3');
  if (!looksAudio) {
    throw new Error(`GPT-SoVITS 返回的不是音频（开头 ${JSON.stringify(buf.subarray(0, 40).toString('utf8'))}）`);
  }

  fs.writeFileSync(out, buf);
  return {
    path: out,
    bytes: buf.length,
    engine: 'gptsovits',
    voice: referenceName(s) || 'gptsovits',
    mediaType: s.mediaType,
    baseUrl: s.baseUrl
  };
}

/**
 * 运行时切权重（可选）：`GET /set_gpt_weights` + `GET /set_sovits_weights`。
 * 只在 doctor/手工切版本时用；日常合成由服务自己的 tts_infer.yaml 决定。
 */
export async function selectWeights({ baseUrl = DEFAULT_GPTSOVITS_BASE_URL, gptWeights = '', sovitsWeights = '', timeoutMs = 120000 } = {}) {
  const base = str(baseUrl, DEFAULT_GPTSOVITS_BASE_URL).replace(/\/+$/, '');
  const out = { ok: true, steps: [] };
  for (const [route, p, label] of [
    ['/set_gpt_weights', gptWeights, 'gpt'],
    ['/set_sovits_weights', sovitsWeights, 'sovits']
  ]) {
    if (!p) continue;
    try {
      const res = await fetch(`${base}${route}?weights_path=${encodeURIComponent(p)}`, { signal: AbortSignal.timeout(Math.max(1000, timeoutMs)) });
      const txt = (await res.text()).slice(0, 200);
      out.steps.push({ weights: label, status: res.status, body: txt });
      if (!res.ok) out.ok = false;
    } catch (error) {
      out.ok = false;
      out.steps.push({ weights: label, status: 0, body: String(error?.message ?? error) });
    }
  }
  return out;
}