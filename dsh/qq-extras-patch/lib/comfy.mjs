// dsh-qq-extras 0.1.0 漏发的模块：ComfyUI 文生图客户端。
//
// 背景（上游缺陷）：dsh-qq-extras@0.1.0 的 mcp.mjs 第 11 行是
//     import { generate, listModels, serverUp } from './lib/comfy.mjs';
// 但 npm 包里根本没有 `lib/comfy.mjs`（`files` 字段只带上了 lib/ 下已存在的几个），
// 于是整个 MCP server 在 import 阶段就 `ERR_MODULE_NOT_FOUND` 退出：
// `image_generate` / `image_models` 用不了，**连带 memory_* / voice_* / web_sticker_send
// 也一起不可用**（stdio MCP 起不来 = 一个工具都没有）。npm 上只有 0.0.0-stage 与 0.1.0，
// 没有修好的版本，所以这份文件由 qq-bridge 仓库提供，用
//     npm run extras:patch
// 把它补进已安装的插件目录（见 scripts/patch-qq-extras.mjs）。
//
// 契约（照 mcp.mjs 的实际调用写，不要改这三个导出名）：
//   serverUp(): Promise<boolean>   探活
//   listModels(): Array            同步返回四个绘图风格的模型表
//   generate(args): Promise<{file}> 画一张图并落盘，mcp.mjs 会读 r.file 再发出去
//
// 设计取舍：
// - **不假装在线**：ComfyUI 没装/没起来时 serverUp() 返回 false，generate() 抛中文错误说明
//   该怎么办；绝不在缺模型时退回"随便找一张图"。
// - **模型名不写死**：ComfyUI 里 checkpoint 的落盘名五花八门（大小写、下划线、带版本后缀），
//   所以按"优先名 → 大小写不敏感 → 关键词包含 → COMFYUI_CHECKPOINT_<STYLE> 环境变量"依次解析，
//   真正可用清单以服务端 /object_info 为准。
// - **自包含**：不 import './common.mjs'（本文件在仓库里是一份模板、被拷进插件 lib/ 后才是模块），
//   需要的 DATA_DIR 就地按同一口径算（`QQ_EXTRAS_DATA` 或 `~/.dsh/qq-memory`）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** ComfyUI 默认地址；`COMFYUI_URL` 可覆盖（注意别把结尾斜杠带上，内部会自己剥）。 */
export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188';
/** 单张图的默认总预算：SDXL 在 4060 上大约 20~40 秒，留足首图加载模型的时间。 */
export const DEFAULT_GENERATE_TIMEOUT_MS = 300_000;
/** 探活/查询的超时：ComfyUI 忙时 /object_info 可能要几秒，别设得太紧。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/** checkpoint 清单的缓存时长：避免每一张图都重新拉一遍 /object_info。 */
const CHECKPOINT_TTL_MS = 60_000;

/** 归档/产物目录：与插件 lib/common.mjs 的 DATA_DIR 同口径。 */
export function dataDir() {
  return process.env.QQ_EXTRAS_DATA || path.join(os.homedir(), '.dsh', 'qq-memory');
}

/** 画出来的图落在 <DATA_DIR>/images/（voice 产物在 audio/，两个别混）。 */
export function imagesDir() {
  return path.join(dataDir(), 'images');
}

/** 当前 ComfyUI 地址（env 优先，其次默认）。 */
export function comfyUrl() {
  return String(process.env.COMFYUI_URL || DEFAULT_COMFY_URL).replace(/\/+$/, '');
}

/**
 * 四个模型。`preferred` 是期望的落盘名，`patterns` 是用来在服务端清单里认脸的宽松匹配，
 * 尺寸按底模给（SD1.5 用 1024 会糊成一团，所以 sd15 风格单独给 512 系尺寸）。
 */
export const STYLE_TABLE = {
  anime: {
    label: 'Animagine XL 4.0（二次元 / 动漫，SDXL）',
    note: '动漫插画最稳的一张，1024 起步；prompt 用英文 Danbooru 标签效果最好。',
    preferred: 'animagine-xl-4.0.safetensors',
    patterns: ['animagine', 'animagine-xl-4'],
    base: 'sdxl',
    sizes: { portrait: [832, 1216], landscape: [1216, 832], square: [1024, 1024] },
    steps: 28,
    cfg: 6.5,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
    negative: 'lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, low score, bad score, average score, signature, watermark, username, blurry',
  },
  'anime-sd15': {
    label: 'Counterfeit V2.5（老派二次元，SD1.5）',
    note: '2023 年前后的画风，速度最快、显存最省；尺寸要留在 512 系。',
    preferred: 'counterfeit-v2.5.safetensors',
    patterns: ['counterfeit-v2.5', 'counterfeit'],
    base: 'sd15',
    sizes: { portrait: [512, 768], landscape: [768, 512], square: [512, 512] },
    steps: 30,
    cfg: 7,
    sampler: 'dpmpp_2m',
    scheduler: 'karras',
    negative: 'lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry',
  },
  realistic: {
    label: 'Realistic Vision V5.1（写实真人，SD1.5）',
    note: '真人质感，适合生活照风格；写人像时尺寸用竖构图。',
    preferred: 'realisticVisionV51_v51VAE.safetensors',
    patterns: ['realisticvision', 'realistic-vision'],
    base: 'sd15',
    sizes: { portrait: [512, 768], landscape: [768, 512], square: [512, 512] },
    steps: 32,
    cfg: 5.5,
    sampler: 'dpmpp_2m',
    scheduler: 'karras',
    negative: 'cartoon, anime, painting, illustration, lowres, bad anatomy, bad hands, text, error, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry, deformed',
  },
  general: {
    label: 'SDXL Base 1.0（通用插画 / 风景）',
    note: '不偏科的一张，风景、静物、概念图都能用；质量不如专门微调的模型。',
    preferred: 'sd_xl_base_1.0.safetensors',
    patterns: ['sd_xl_base_1.0', 'sd_xl_base', 'sdxl_base'],
    base: 'sdxl',
    sizes: { portrait: [832, 1216], landscape: [1216, 832], square: [1024, 1024] },
    steps: 30,
    cfg: 7,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
    negative: 'lowres, bad anatomy, bad hands, text, error, cropped, worst quality, low quality, low score, signature, watermark, username, blurry',
  },
};

/** 显式传入的风格名做一次归一（容忍 anime_sd15 / animeSD15 / 大写）。 */
export function styleKey(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return 'anime';
  const norm = raw.toLowerCase().replace(/[\s_]+/g, '-');
  if (STYLE_TABLE[norm]) return norm;
  const compact = norm.replace(/-/g, '');
  for (const key of Object.keys(STYLE_TABLE)) {
    if (key.replace(/-/g, '') === compact) return key;
  }
  return norm;
}

let lastCheckpoints = { at: 0, list: [], url: '' };
let lastStats = { at: 0, data: null, url: '' };

/** 服务端已知的 checkpoint 清单（没查过就是空数组，调用方要把它当"未知"而不是"没有"）。 */
export function knownCheckpoints() {
  return Array.isArray(lastCheckpoints.list) ? [...lastCheckpoints.list] : [];
}

async function fetchJson(url, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(500, Number(timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS)) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data, text };
}

/** 从 /object_info 里把可用的 checkpoint 名捞出来（ComfyUI 的权威清单）。 */
async function refreshCheckpoints(baseUrl = comfyUrl(), timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  try {
    const r = await fetchJson(`${baseUrl}/object_info/CheckpointLoaderSimple`, { timeoutMs });
    const list = r.data?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    if (Array.isArray(list)) {
      lastCheckpoints = { at: Date.now(), list: list.map(String), url: baseUrl };
      return lastCheckpoints.list;
    }
  } catch {
    /* ComfyUI 没起来或这个节点不存在：保留旧缓存，交给调用方判"未知" */
  }
  return knownCheckpoints();
}

/** 探活。`refresh` 打开时顺带刷新 checkpoint 清单（best-effort，失败不影响返回值）。 */
export async function serverUp(baseUrl = comfyUrl(), { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, refresh = true } = {}) {
  try {
    const r = await fetchJson(`${baseUrl}/system_stats`, { timeoutMs });
    if (!r.ok) return false;
    lastStats = { at: Date.now(), data: r.data, url: baseUrl };
    if (refresh) await refreshCheckpoints(baseUrl, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/** 最近一次探活看到的硬件信息（显存等），没探过就是 null。 */
export function lastSystemStats() {
  return lastStats.data ? { url: lastStats.url, at: lastStats.at, ...lastStats.data } : null;
}

function envOverride(style) {
  const key = `COMFYUI_CHECKPOINT_${style.toUpperCase().replace(/-/g, '_')}`;
  const value = process.env[key];
  return value ? String(value).trim() : '';
}

/**
 * 解析某个风格实际要用的 checkpoint 名：
 * 环境变量覆盖 → 服务端清单精确匹配 → 服务端清单大小写不敏感 → 服务端清单关键词包含 →
 * 本地模型目录里找 → 都没有就用 preferred（并标记 unknown）。
 */
export function resolveCheckpoint(style, { checkpoints = knownCheckpoints(), modelsDir = process.env.COMFYUI_MODELS_DIR || '' } = {}) {
  const key = styleKey(style);
  const spec = STYLE_TABLE[key];
  if (!spec) return null;
  const forced = envOverride(key);
  if (forced) return { name: forced, installed: true, source: 'env' };
  const names = (checkpoints || []).map(String);
  if (names.length) {
    const base = path.basename(spec.preferred).toLowerCase();
    const stem = base.replace(/\.[a-z0-9]+$/, '');
    const exact = names.find((n) => path.basename(n).toLowerCase() === base);
    if (exact) return { name: exact, installed: true, source: 'server' };
    const ci = names.find((n) => path.basename(n).toLowerCase() === base);
    if (ci) return { name: ci, installed: true, source: 'server' };
    const stemHit = names.find((n) => path.basename(n).toLowerCase().startsWith(stem));
    if (stemHit) return { name: stemHit, installed: true, source: 'server' };
    const patternHit = names.find((n) => {
      const low = path.basename(n).toLowerCase();
      return (spec.patterns || []).some((p) => low.includes(p));
    });
    if (patternHit) return { name: patternHit, installed: true, source: 'server' };
    return { name: spec.preferred, installed: false, source: 'server', available: names };
  }
  if (modelsDir) {
    const hit = findCheckpointInDir(modelsDir, spec);
    if (hit) return { name: hit, installed: true, source: 'dir' };
  }
  return { name: spec.preferred, installed: null, source: 'unknown' };
}

function findCheckpointInDir(dir, spec) {
  try {
    const wanted = path.basename(spec.preferred).toLowerCase();
    const stem = wanted.replace(/\.[a-z0-9]+$/, '');
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of files) {
      if (entry.isDirectory()) {
        const nested = findCheckpointInDir(path.join(dir, entry.name), spec);
        if (nested) return nested;
        continue;
      }
      const low = entry.name.toLowerCase();
      if (low === wanted || low.startsWith(stem) || (spec.patterns || []).some((p) => low.includes(p))) return entry.name;
    }
  } catch {
    /* 目录不存在/没权限：当作没找到 */
  }
  return '';
}

/** 同步的模型表（给 mcp.mjs 的 image_models 用）。`installed: null` = 还没探到服务端清单，不知道。 */
export function listModels() {
  const checkpoints = knownCheckpoints();
  const modelsDir = process.env.COMFYUI_MODELS_DIR || '';
  return Object.entries(STYLE_TABLE).map(([style, spec]) => {
    const resolved = resolveCheckpoint(style, { checkpoints, modelsDir }) || { name: spec.preferred, installed: null, source: 'unknown' };
    return {
      style,
      label: spec.label,
      note: spec.note,
      base: spec.base,
      checkpoint: resolved.name,
      installed: resolved.installed,
      source: resolved.source,
      sizes: spec.sizes,
      steps: spec.steps,
      cfg: spec.cfg,
    };
  });
}

function randSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

function pickSize(spec, aspect, width, height) {
  const kind = String(aspect || 'portrait').toLowerCase();
  const fallback = spec.sizes[kind] || spec.sizes.portrait || spec.sizes.square;
  const w = Number.isFinite(Number(width)) && Number(width) > 0 ? Math.round(Number(width)) : fallback[0];
  const h = Number.isFinite(Number(height)) && Number(height) > 0 ? Math.round(Number(height)) : fallback[1];
  return { width: Math.min(1536, Math.max(256, w)), height: Math.min(1536, Math.max(256, h)) };
}

function clipTo(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 图片魔数校验：ComfyUI 出错时可能回一段 JSON/HTML，别把那种东西当图存下来。 */
function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  const magic = buf.subarray(0, 4).toString('hex');
  if (magic === '89504e47') return 'image/png';
  if (magic.startsWith('ffd8ff')) return 'image/jpeg';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return false;
}

function summarizeNodeErrors(nodeErrors) {
  if (!nodeErrors || typeof nodeErrors !== 'object') return '';
  const parts = [];
  for (const [id, info] of Object.entries(nodeErrors)) {
    const errors = info?.errors || info?.error || [];
    const texts = (Array.isArray(errors) ? errors : [errors])
      .map((e) => e?.message || e?.details || (typeof e === 'string' ? e : '')).filter(Boolean);
    parts.push(`节点 ${id}: ${texts.join('; ') || JSON.stringify(info).slice(0, 200)}`);
  }
  return parts.join(' | ').slice(0, 600);
}

/**
 * 画一张图。
 * @returns {Promise<{ok:boolean,file:string,bytes:number,style:string,label:string,checkpoint:string,seed:number,width:number,height:number,steps:number,cfg:number,promptId:string,elapsedMs:number}>}
 */
export async function generate({
  prompt,
  style = 'anime',
  aspect = 'portrait',
  negative,
  width,
  height,
  steps,
  cfg,
  seed,
  outDir,
  baseUrl,
  timeoutMs = DEFAULT_GENERATE_TIMEOUT_MS,
  prefix = 'qq-extras',
  filenamePrefix = 'qq-extras',
} = {}) {
  const text = String(prompt ?? '').trim();
  if (!text) throw new Error('prompt 不能为空（要用英文 Danbooru 标签或英文描述）');
  const key = styleKey(style);
  const spec = STYLE_TABLE[key];
  if (!spec) throw new Error(`不认识的风格：${style}（可用 ${Object.keys(STYLE_TABLE).join(' / ')}）`);

  const url = String(baseUrl || comfyUrl()).replace(/\/+$/, '');
  if (!(await serverUp(url))) {
    throw new Error(`连不上 ComfyUI（${url}）：没在运行或地址不对。启动 ComfyUI 后再试，或用 COMFYUI_URL 指定地址。`);
  }
  await refreshCheckpoints(url);

  const resolved = resolveCheckpoint(key) || { name: spec.preferred, installed: null, source: 'unknown' };
  if (resolved.installed === false) {
    const have = (resolved.available || []).slice(0, 8).join(', ');
    throw new Error(`ComfyUI 里没有「${spec.label}」的模型（期望 ${spec.preferred}${have ? `；现有：${have}` : ''}）。把模型放进 ComfyUI/models/checkpoints，或用 COMFYUI_CHECKPOINT_${key.toUpperCase().replace(/-/g, '_')} 指定文件名。`);
  }

  const size = pickSize(spec, aspect, width, height);
  const realSeed = Number.isFinite(Number(seed)) ? Math.round(Number(seed)) : randSeed();
  const realSteps = clipTo(steps, 1, 60, spec.steps);
  const realCfg = clipTo(cfg, 1, 20, spec.cfg);
  const negativeText = String(negative ?? spec.negative ?? '');

  const graph = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: resolved.name } },
    2: { class_type: 'CLIPTextEncode', inputs: { text, clip: ['1', 1] } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: negativeText, clip: ['1', 1] } },
    4: { class_type: 'EmptyLatentImage', inputs: { width: size.width, height: size.height, batch_size: 1 } },
    5: {
      class_type: 'KSampler',
      inputs: {
        seed: realSeed,
        steps: realSteps,
        cfg: realCfg,
        sampler_name: spec.sampler,
        scheduler: spec.scheduler,
        denoise: 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    6: { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    7: { class_type: 'SaveImage', inputs: { filename_prefix: String(filenamePrefix || prefix), images: ['6', 0] } },
  };

  const started = Date.now();
  const clientId = `qq-extras-${process.pid}-${Date.now().toString(36)}`;
  let queued;
  try {
    const res = await fetch(`${url}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
      signal: AbortSignal.timeout(Math.max(2000, Number(timeoutMs) || DEFAULT_GENERATE_TIMEOUT_MS)),
    });
    const bodyText = await res.text();
    try { queued = bodyText ? JSON.parse(bodyText) : null; } catch { queued = null; }
    if (!res.ok) {
      const detail = summarizeNodeErrors(queued?.node_errors) || queued?.error?.message || queued?.error || bodyText.slice(0, 300);
      throw new Error(`ComfyUI 拒绝了画图请求（HTTP ${res.status}）：${detail}`);
    }
  } catch (error) {
    if (String(error?.message || '').startsWith('ComfyUI 拒绝了')) throw error;
    throw new Error(`把画图请求发给 ComfyUI 失败（${url}）：${error?.message || error}`);
  }

  const promptId = queued?.prompt_id;
  if (!promptId) {
    throw new Error(`ComfyUI 没有返回 prompt_id：${summarizeNodeErrors(queued?.node_errors) || JSON.stringify(queued).slice(0, 300)}`);
  }

  const budget = Math.max(5000, Number(timeoutMs) || DEFAULT_GENERATE_TIMEOUT_MS);
  let image = null;
  let lastStatus = '';
  while (Date.now() - started < budget) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let history;
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetchJson(`${url}/history/${promptId}`, { timeoutMs: 10_000 });
      history = r.data;
    } catch {
      continue; // 单次查询失败不算失败，继续轮询到总超时
    }
    const item = history?.[promptId];
    if (!item) continue;
    lastStatus = item?.status?.status_str || lastStatus;
    const outputs = item.outputs || {};
    for (const node of Object.values(outputs)) {
      const first = (node?.images || [])[0];
      if (first?.filename) { image = first; break; }
    }
    if (image) break;
    if (lastStatus === 'error') {
      const messages = (item?.status?.messages || [])
        .map((m) => (Array.isArray(m) ? `${m[0]}: ${typeof m[1] === 'string' ? m[1] : JSON.stringify(m[1]).slice(0, 200)}` : String(m)))
        .join(' | ');
      throw new Error(`ComfyUI 画图失败：${messages.slice(0, 600) || '节点执行出错（看 ComfyUI 控制台）'}`);
    }
  }
  if (!image) {
    throw new Error(`画图超时（${budget}ms${lastStatus ? `，状态 ${lastStatus}` : ''}）：模型太大或显存不够时会发生，试试 steps 小一点、尺寸小一点。`);
  }

  const view = `${url}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || '')}&type=${encodeURIComponent(image.type || 'output')}`;
  let buffer;
  try {
    const res = await fetch(view, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    throw new Error(`取回画好的图失败：${error?.message || error}`);
  }
  const mime = looksLikeImage(buffer);
  if (!mime) throw new Error('ComfyUI 返回的不是图片（可能是错误信息）');

  const dir = outDir ? path.resolve(outDir) : imagesDir();
  fs.mkdirSync(dir, { recursive: true });
  const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/gif' ? '.gif' : mime === 'image/webp' ? '.webp' : '.png';
  const file = path.join(dir, `${prefix}-${stamp()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
  fs.writeFileSync(file, buffer);

  return {
    ok: true,
    file,
    bytes: buffer.length,
    mime,
    style: key,
    label: spec.label,
    checkpoint: resolved.name,
    seed: realSeed,
    width: size.width,
    height: size.height,
    steps: realSteps,
    cfg: realCfg,
    promptId,
    elapsedMs: Date.now() - started,
    view,
  };
}