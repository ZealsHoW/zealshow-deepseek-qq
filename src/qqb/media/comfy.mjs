// 桥接侧的 ComfyUI 客户端。
//
// 为什么在这里再包一层：真正干活的那套（探活、checkpoint 认脸、workflow 组装、
// /prompt + /history 轮询、取图校验）已经在 `dsh/qq-extras-patch/lib/comfy.mjs` 里了
// ——那是上游 dsh-qq-extras@0.1.0 漏发 `lib/comfy.mjs`、由本仓库补上的实现，
// 跑通过真图。再抄一份只会漂移，所以这里只做「桥接口径」的包装：
//   - 产物直接落 `state/outbox`（那样 qq_send_image 的解析逻辑原样可用）；
//   - 暴露 status()：桥接要靠它判断「没装 / 没起 / 没模型」三种情况，并给中文原因；
//   - 风格白名单收窄成她用得上的三种，别让模型瞎猜 style 名。
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

export const VERSION = '0.1.0';

/** 默认画风：二次元（她的人设就是蓝白鲸鱼娘，动漫风最贴）。 */
export const DEFAULT_STYLE = 'anime';
/** 默认构图：方形，聊天窗里不裁。 */
export const DEFAULT_ASPECT = 'square';
/** 她只能点名这三种，其余（写实 SD1.5 之类）留给我们自己调。 */
export const ALLOWED_STYLES = Object.freeze(['anime', 'anime-sd15', 'realistic']);
/** 单张图的时长预算：4060 8 GB 上 SDXL 1024 约 25~45 秒，首图还要加加载模型的时间。 */
export const DEFAULT_TIMEOUT_MS = DEFAULT_GENERATE_TIMEOUT_MS;

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

/**
 * 建一个桥接用的画图客户端。
 * @param {{outDir?: string, baseUrl?: string, timeoutMs?: number, logger?: {warn?: Function}}} options
 */
export function createComfyClient({ outDir = null, baseUrl = comfyUrl(), timeoutMs = DEFAULT_TIMEOUT_MS, logger = null } = {}) {
  const url = String(baseUrl || DEFAULT_COMFY_URL).replace(/\/+$/, '');
  const budget = Math.max(10_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);

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

  /**
   * 画一张。产物落 outDir（默认由调用方给 state/outbox），返回 generate() 的结果
   * 加上 `rel`（相对 outDir 的文件名，方便发图时当 ref 用）。
   */
  async function draw({ prompt, style = DEFAULT_STYLE, aspect = DEFAULT_ASPECT, seed, steps, width, height, negative, prefix = 'qq-draw' } = {}) {
    const text = String(prompt ?? '').trim();
    if (!text) throw new Error('prompt 不能为空（英文 Danbooru 标签或英文描述效果最好）');
    const result = await generate({
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
    logger?.warn?.(`[comfy] 画好了 ${result.file}（${result.width}×${result.height}，${result.elapsedMs}ms，seed=${result.seed}）`);
    return { ...result, rel, url };
  }

  return { VERSION, url, budget, status, draw };
}