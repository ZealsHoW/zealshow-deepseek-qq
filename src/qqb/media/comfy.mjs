// 桥接侧的 ComfyUI 客户端。
//
// 为什么在这里再包一层：真正干活的那套（探活、checkpoint 认脸、workflow 组装、
// /prompt + /history 轮询、取图校验）已经在 `dsh/qq-extras-patch/lib/comfy.mjs` 里了
// ——那是上游 dsh-qq-extras@0.1.0 漏发 `lib/comfy.mjs`、由本仓库补上的实现，
// 跑通过真图。再抄一份只会漂移，所以这里只做「桥接口径」的包装：
//   - 产物直接落 `state/outbox`（那样 qq_send_image 的解析逻辑原样可用）；
//   - 暴露 status()：桥接要靠它判断「没装 / 没起 / 没模型」三种情况，并给中文原因；
//   - 风格白名单收窄成她用得上的三种，别让模型瞎猜 style 名；
//   - 2026-10-29 起支持挂 LoRA（她自己的 SDXL LoRA：`xiaojing_sdxl_lora.safetensors`）。
//     上游 generate() 的图里没有 LoraLoader，所以挂 LoRA 的那条路在这里自己组装图，
//     但「提交 / 轮询 / 取图 / 落盘」仍用同一套口径，避免两套行为。
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_COMFY_URL,
  DEFAULT_GENERATE_TIMEOUT_MS,
  STYLE_TABLE,
  comfyUrl,
  generate,
  knownCheckpoints,
  serverUp,
  styleKey,
} from '../../../dsh/qq-extras-patch/lib/comfy.mjs';

export const VERSION = '0.2.0';

/** 默认画风：二次元（她的人设就是蓝白鲸鱼娘，动漫风最贴）。 */
export const DEFAULT_STYLE = 'anime';
/** 默认构图：方形，聊天窗里不裁。 */
export const DEFAULT_ASPECT = 'square';
/** 她只能点名这三种，其余（写实 SD1.5 之类）留给我们自己调。 */
export const ALLOWED_STYLES = Object.freeze(['anime', 'anime-sd15', 'realistic']);
/** 单张图的时长预算：4060 8 GB 上 SDXL 1024 约 25~45 秒，首图还要加加载模型的时间。 */
export const DEFAULT_TIMEOUT_MS = DEFAULT_GENERATE_TIMEOUT_MS;
/** 她自己的 LoRA（17 张定稿图、dim 16、800 步、2026-10-29 训）。挂上它才「像她」。 */
export const DEFAULT_LORA = 'xiaojing_sdxl_lora.safetensors';
/** LoRA 的触发词：训练集每张 caption 的第一个 tag。 */
export const DEFAULT_TRIGGER = 'xiaojing';
/** LoRA 权重：0.8 是有她没有训糊的平衡点（1.0 会生硬地往训练图的构图靠）。 */
export const DEFAULT_LORA_WEIGHT = 0.8;

/** 给提示词/工具描述用：一行一个风格的说明。 */
export function styleLines() {
  return ALLOWED_STYLES.filter((key) => STYLE_TABLE[key]).map((key) => {
    const spec = STYLE_TABLE[key];
    return `${key}：${spec.label}（${spec.note}）`;
  });
}

/** 归一化风格名，不认识的回落到默认（不抛，画图不该因为风格名拼错就整轮失败）。 */
export function normalizeStyle(input) {
  const key = styleKey(String(input ?? '').trim() || DEFAULT_STYLE);
  return ALLOWED_STYLES.includes(key) ? key : DEFAULT_STYLE;
}

/** 触发词去重：她已经写了 `xiaojing` 就不要重复加。 */
export function withTrigger(prompt, trigger = DEFAULT_TRIGGER) {
  const text = String(prompt ?? '').trim();
  if (!text) return text;
  const tag = String(trigger ?? '').trim();
  if (!tag) return text;
  return new RegExp(`(^|[,\\s])${tag}([,\\s]|$)`, 'i').test(text) ? text : `${tag}, ${text}`;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function looksLikeImage(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return null;
}

/**
 * 建一个桥接用的画图客户端。
 * @param {{outDir?: string, baseUrl?: string, timeoutMs?: number, logger?: {warn?: Function}}} options
 */
export function createComfyClient({ outDir = null, baseUrl = comfyUrl(), timeoutMs = DEFAULT_TIMEOUT_MS, logger = null } = {}) {
  const url = String(baseUrl || DEFAULT_COMFY_URL).replace(/\/+$/, '');
  const budget = Math.max(10_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);

  /** ComfyUI 里现有哪些 LoRA（读 LoraLoader 的枚举；服务没起就返回空）。 */
  async function knownLoras({ timeoutMs: probeMs = 5000 } = {}) {
    try {
      const res = await fetch(`${url}/object_info/LoraLoader`, { signal: AbortSignal.timeout(probeMs) });
      if (!res.ok) return [];
      const body = await res.json();
      const list = body?.LoraLoader?.input?.required?.lora_name?.[0];
      return Array.isArray(list) ? list.filter((n) => n && n !== 'None') : [];
    } catch {
      return [];
    }
  }

  /**
   * 能不能画：把「服务没起」和「起了没模型」分开说，免得她对着主人说「我不会画画」。
   * @returns {Promise<{up: boolean, url: string, checkpoints: string[], style: string, reason?: string}>}
   */
  async function status() {
    let up = false;
    try {
      up = await serverUp(url, { timeoutMs: 4000 });
    } catch {
      up = false;
    }
    const checkpoints = up ? knownCheckpoints() : [];
    if (!up) {
      return { up: false, url, checkpoints, style: DEFAULT_STYLE, reason: `ComfyUI 没在跑（${url}）` };
    }
    const wanted = STYLE_TABLE[DEFAULT_STYLE]?.preferred || 'animagine-xl-4.0.safetensors';
    const hasModel = !checkpoints.length || checkpoints.some((name) => /animagine/i.test(name));
    return {
      up: true,
      url,
      checkpoints,
      style: DEFAULT_STYLE,
      ...(hasModel ? {} : { reason: `ComfyUI 里没有 ${wanted}（现有：${checkpoints.slice(0, 6).join(', ')}）` }),
    };
  }

  /** 挂 LoRA 的那条路：自己组图（CheckpointLoader → LoraLoader → 两个 CLIPTextEncode → KSampler → VAE）。 */
  async function drawWithLora({ prompt, style, aspect, seed, steps, width, height, negative, prefix, lora, loraWeight, trigger }) {
    const key = normalizeStyle(style);
    const spec = STYLE_TABLE[key];
    const name = String(lora).trim();
    // 和只走 generate() 的那条路同一句人话：服务没起时不要抛 fetch failed。
    const probe = await status();
    if (!probe.up) {
      throw new Error(`连不上 ComfyUI（${url}）：没在运行或地址不对。启动 ComfyUI 后再试，或用 COMFYUI_URL 指定地址。`);
    }
    // 探 LoRA 列表只是「名字写错时给个好人话」的加分项：探不到/探失败都不能把这张图搞没，
    // 真挂不上时 /prompt 会返回 node_errors 里带 lora_name 的错误，那才是要报的错。
    let loras = [];
    try {
      loras = await knownLoras({ timeoutMs: 5000 });
    } catch (error) {
      logger?.warn?.('画图：探不到 LoRA 列表，照常往下画', error?.message ?? String(error));
    }
    if (loras.length && !loras.includes(name)) {
      throw new Error(`ComfyUI 里没有 LoRA ${name}（现有：${loras.slice(0, 6).join(', ')}）`);
    }
    const size = pickSizeFor(spec, aspect, width, height);
    const realSeed = Number.isFinite(Number(seed)) ? Math.round(Number(seed)) : Math.floor(Math.random() * 2 ** 31);
    const realSteps = clamp(steps, 1, 60, spec.steps);
    const realCfg = clamp(spec.cfg, 1, 20, spec.cfg);
    const text = withTrigger(prompt, trigger);
    const graph = {
      1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: spec.preferred } },
      2: {
        class_type: 'LoraLoader',
        inputs: { model: ['1', 0], clip: ['1', 1], lora_name: name, strength_model: Math.max(0, Math.min(1.5, Number(loraWeight) || DEFAULT_LORA_WEIGHT)), strength_clip: 1 },
      },
      3: { class_type: 'CLIPTextEncode', inputs: { text, clip: ['2', 1] } },
      4: { class_type: 'CLIPTextEncode', inputs: { text: String(negative ?? spec.negative ?? ''), clip: ['2', 1] } },
      5: { class_type: 'EmptyLatentImage', inputs: { width: size.width, height: size.height, batch_size: 1 } },
      6: {
        class_type: 'KSampler',
        inputs: {
          seed: realSeed, steps: realSteps, cfg: realCfg, sampler_name: spec.sampler, scheduler: spec.scheduler, denoise: 1,
          model: ['2', 0], positive: ['3', 0], negative: ['4', 0], latent_image: ['5', 0],
        },
      },
      7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
      8: { class_type: 'SaveImage', inputs: { filename_prefix: String(prefix || 'qq-draw'), images: ['7', 0] } },
    };

    const started = Date.now();
    const res = await fetch(`${url}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: `qq-bridge-${process.pid}-${Date.now().toString(36)}` }),
      signal: AbortSignal.timeout(Math.min(budget, 60_000)),
    });
    const raw = await res.text();
    let queued = null;
    try { queued = raw ? JSON.parse(raw) : null; } catch { queued = null; }
    if (!res.ok) throw new Error(`ComfyUI 拒绝了画图请求（HTTP ${res.status}）：${String(queued?.error?.message || raw).slice(0, 200)}`);
    const promptId = queued?.prompt_id;
    if (!promptId) throw new Error(`ComfyUI 没有返回 prompt_id：${raw.slice(0, 200)}`);

    let image = null;
    let lastStatus = '';
    while (Date.now() - started < budget) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1000));
      let history = null;
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await fetch(`${url}/history/${promptId}`, { signal: AbortSignal.timeout(10_000) });
        if (r.ok) history = await r.json();
      } catch { continue; }
      const item = history?.[promptId];
      if (!item) continue;
      lastStatus = item?.status?.status_str || lastStatus;
      for (const node of Object.values(item.outputs || {})) {
        const first = (node?.images || [])[0];
        if (first?.filename) { image = first; break; }
      }
      if (image) break;
      if (lastStatus === 'error') {
        const messages = (item?.status?.messages || []).map((m) => (Array.isArray(m) ? `${m[0]}: ${typeof m[1] === 'string' ? m[1] : JSON.stringify(m[1]).slice(0, 160)}` : String(m))).join(' | ');
        throw new Error(`ComfyUI 画图失败：${messages.slice(0, 400) || '节点执行出错'}`);
      }
    }
    if (!image) throw new Error(`画图超时（${budget}ms${lastStatus ? `，状态 ${lastStatus}` : ''}）`);

    const view = `${url}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || '')}&type=${encodeURIComponent(image.type || 'output')}`;
    const imgRes = await fetch(view, { signal: AbortSignal.timeout(30_000) });
    if (!imgRes.ok) throw new Error(`取回画好的图失败：HTTP ${imgRes.status}`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const mime = looksLikeImage(buffer);
    if (!mime) throw new Error('ComfyUI 返回的不是图片（可能是错误信息）');

    const dir = outDir ? path.resolve(outDir) : undefined;
    if (!dir) throw new Error('没有给输出目录（outDir）');
    fs.mkdirSync(dir, { recursive: true });
    const ext = mime === 'image/jpeg' ? '.jpg' : '.png';
    const file = path.join(dir, `${prefix || 'qq-draw'}-${stamp()}-${Math.random().toString(36).slice(2, 6)}${ext}`);
    fs.writeFileSync(file, buffer);

    return {
      ok: true, file, bytes: buffer.length, mime, style: key, label: spec.label,
      checkpoint: spec.preferred, lora: name, loraWeight, trigger: withTrigger('', trigger) ? String(trigger ?? DEFAULT_TRIGGER) : '',
      seed: realSeed, width: size.width, height: size.height, steps: realSteps, cfg: realCfg,
      promptId, elapsedMs: Date.now() - started, view, prompt: text,
    };
  }

  /**
   * 画一张。产物落 outDir（默认由调用方给 state/outbox），返回 generate() 的结果
   * 加上 `rel`（相对 outDir 的文件名，方便发图时当 ref 用）。
   * 传 `lora`（默认 DEFAULT_LORA，传空串就画原模型）会走挂 LoRA 的那条路。
   */
  async function draw({
    prompt, style = DEFAULT_STYLE, aspect = DEFAULT_ASPECT, seed, steps, width, height, negative,
    prefix = 'qq-draw', lora = DEFAULT_LORA, loraWeight = DEFAULT_LORA_WEIGHT, trigger = DEFAULT_TRIGGER,
  } = {}) {
    const text = String(prompt ?? '').trim();
    if (!text) throw new Error('prompt 不能为空（英文 Danbooru 标签或英文描述效果最好）');
    const result = lora
      ? await drawWithLora({ prompt: text, style, aspect, seed, steps, width, height, negative, prefix, lora, loraWeight, trigger })
      : await generate({
        prompt: text,
        style: normalizeStyle(style),
        aspect: String(aspect || DEFAULT_ASPECT),
        negative,
        width,
        height,
        steps,
        seed,
        outDir: outDir ? path.resolve(outDir) : undefined,
        baseUrl: url,
        timeoutMs: budget,
        prefix,
        filenamePrefix: prefix,
      });
    const rel = outDir && result.file ? path.basename(result.file) : null;
    logger?.warn?.(`[comfy] 画好了 ${result.file}（${result.width}×${result.height}，${result.elapsedMs}ms，seed=${result.seed}${result.lora ? `，LoRA ${result.lora}@${result.loraWeight}` : ''}）`);
    return { ...result, rel, url };
  }

  return { VERSION, url, budget, status, draw, knownLoras };
}

/** 按风格表挑尺寸（和上游 pickSize 同一口径，只是不导出那个函数，这里补一份）。 */
function pickSizeFor(spec, aspect, width, height) {
  const a = String(aspect || DEFAULT_ASPECT).toLowerCase();
  // STYLE_TABLE 里 sizes 是 [w, h] 数组（portrait/landscape/square），不是对象。
  const pair = spec.sizes?.[a] || spec.sizes?.square || [1024, 1024];
  const w = Number(width) > 0 ? Math.round(Number(width)) : pair[0];
  const h = Number(height) > 0 ? Math.round(Number(height)) : pair[1];
  return { width: w - (w % 16), height: h - (h % 16) };
}