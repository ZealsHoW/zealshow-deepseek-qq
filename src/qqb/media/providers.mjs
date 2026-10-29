// R6 媒体能力层：把「看图」抽象成可替换的 provider，并给图生图 / 视频帧解析**预留契约**。
//
// 为什么这么拆：
// - 现在只有一个能力真正可用：`describe`（图片 → 文字，走本机 Ollama 上的轻量视觉模型）。
//   但需求里要求「后续支持图生图、视频帧解析，当前先保证原有识图、发图稳定」——
//   所以先把**接口**定死：谁能做什么由 capabilities 声明，没实现的不是悄悄不做，
//   而是抛一个明确的「暂未接入」错误，调用方（MCP 工具 / 桥接）不用提前写 if。
// - 换模型只换 provider：把云端视觉接进来时，注册一个新 provider 当默认即可，
//   调用点（qq_describe_image / qq_web_screenshot）一行都不用改。
//
// 约定：所有 provider 方法都返回 `{ ... }` 纯数据，不写盘、不发 QQ；失败一律抛 Error
//       （预留能力的错误带 `code = 'MEDIA_NOT_SUPPORTED'` 与 `capability`）。

import { normalizeImageForVision, DEFAULT_MAX_SIDE } from './resize.mjs';
import { sharedKeyResolver } from '../model/client.mjs';

export const VERSION = '0.1.0';

/** 媒体能力清单。前三个是当前语义，后面两个是**预留**（有契约、暂无实现）。 */
export const CAPABILITIES = ['describe', 'image2image', 'videoFrames'];
/** 预留能力：注册时会自动补一个「暂未接入」的抛错实现，保证调用方现在就能按契约写代码。 */
export const RESERVED = ['image2image', 'videoFrames'];

export const PROMPTS = {
  describe:
    '仔细看这张图片，用简体中文回答：\n1) 一句话概括这张图是什么；\n2) 画面内容：有哪些人物/动物/物体、场景、颜色、数量、相对位置；如果是聊天/界面截图，说明是谁在说什么、界面上有哪些按钮和状态；\n3) 图片里的所有文字：逐字转录（含标题、招牌、聊天文字、代码、数字），看不清的标“（不清晰）”；\n4) 如果是表情包/梗图，说明它表达的情绪或梗。\n只描述确实能看到的内容，不要编造；不确定的地方明确说“看不清”。',
  ocr: '只做一件事：逐字转录这张图片里的所有可见文字，保持原有的分行与顺序，不要翻译、不要解释、不要漏掉小字。若图片里没有文字，回答“（没有文字）”。',
  both: '用简体中文完成两件事：\nA) 先逐字转录图片里的所有文字（保持分行，看不清标“（不清晰）”，没有文字就写“（没有文字）”）；\nB) 再用 3-6 句话描述画面内容：人物/物体/场景/颜色/数量/界面状态；若为表情包，说明其情绪或梗。\n只写能看到的内容，不要编造。'
};

/** 「这个能力还没接入」——显式错误，别让调用方以为成功了。 */
export function notSupportedError(capability, providerName = '') {
  const suffix = providerName ? `（provider ${providerName}）` : '';
  const error = new Error(`媒体能力 ${capability} 暂未接入${suffix}：接口已预留，接上实现后可直接调用`);
  error.code = 'MEDIA_NOT_SUPPORTED';
  error.capability = capability;
  return error;
}

/** 视觉配置（与既有 config.json 的 vision 段兼容，默认值不变）。 */
export function visionConfigOf(cfg) {
  const v = cfg && typeof cfg.vision === 'object' && cfg.vision ? cfg.vision : {};
  return {
    enabled: v.enabled !== false,
    baseUrl: String(v.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    model: String(v.model || 'qwen2.5vl:3b'),
    timeoutMs: Math.max(5000, Number(v.timeoutMs) || 120000),
    maxImages: Math.max(1, Number(v.maxImages) || 3),
    maxUrlBytes: Math.max(1024 * 1024, Number(v.maxUrlBytes) || 16 * 1024 * 1024),
    // 生成参数（可在 config.json 的 vision 段覆盖，不用改代码）
    numPredict: Math.max(128, Number(v.numPredict) || 2048),
    repeatPenalty: Math.max(0.8, Number(v.repeatPenalty) || 1.15),
    // Ollama + qwen2.5vl 对长边 >1280 的图会直接 `token repeat limit reached` 中断，
    // 所以送到模型前先缩到长边 ≤ 这个值（config.json 的 vision.maxSide 可覆盖）。
    maxSide: Math.max(256, Number(v.maxSide) || DEFAULT_MAX_SIDE),
    // 小视觉模型偶发复读时，最多重试几次（总共 1 + retries 次请求）
    retries: (() => {
      const n = Number(v.retries);
      return Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : 1;
    })()
  };
}

/**
 * Ollama 生成参数。
 *
 * 为什么必须显式给：qwen2.5vl:3b 在长文字截图（聊天/网页 OCR）上会偶发复读，
 * 命中 Ollama 自己的重复检测后被中断，整次识图直接作废（历史日志里的
 * `prediction aborted, token repeat limit reached`）。原来只传了 temperature，
 * 既没有输出长度上限也没有重复惩罚，等于把稳定性交给模型心情。
 */
export function generateOptionsOf(v = {}, { retry = false } = {}) {
  const base = {
    temperature: 0.1,
    repeat_penalty: Math.max(0.8, Number(v.repeatPenalty) || 1.15),
    repeat_last_n: 512,
    num_predict: Math.max(128, Number(v.numPredict) || 2048)
  };
  if (!retry) return base;
  // 重试时加重惩罚并缩短输出：先让它把话说完/把字抄完，而不是再复读一遍。
  // 换一个随机 seed 也很关键——同一个 seed 下小模型很容易原封不动再复读一次。
  return {
    ...base,
    temperature: 0.05,
    seed: Math.floor(Math.random() * 1e9),
    repeat_penalty: Math.round((base.repeat_penalty + 0.2) * 100) / 100,
    repeat_last_n: 256,
    num_predict: Math.min(base.num_predict, 1200)
  };
}

/** 媒体层配置：目前只有一个「默认 provider 是谁」。 */
export function mediaConfigOf(cfg) {
  const m = cfg && typeof cfg.media === 'object' && cfg.media ? cfg.media : {};
  const v = cfg && typeof cfg.vision === 'object' && cfg.vision ? cfg.vision : {};
  // 2026-10-29：加了云端视觉之后，默认 provider 也可以写在 vision.provider 上
  // （原来只能写 media.defaultProvider —— 而那份配置根本不存在，于是永远是 ollama）。
  return {
    defaultProvider: String(m.defaultProvider || v.provider || 'ollama')
  };
}

/**
 * 云端视觉（OpenAI 兼容的 chat/completions + image_url）。
 *
 * 为什么要有它：本机 Ollama 的模型文件坏了/重下不动（2026-10-29：qwen2.5vl:3b
 * 对纯文本都只吐 `88888888…`，重下时 R2 的 blob 域名整段连不通），而她「看图」
 * 是每天都用的能力。云端这条路只需要一个 key —— 主链路的百炼 key 本来就在。
 *
 * 配置（config.json 的 vision 段）：
 *   provider: 'openai'
 *   chat: { baseUrl, model, apiKey, apiKeyEnv: [...] }
 * key 的解析顺序与主模型一致：vision.chat.apiKey → 环境变量 → 凭据文件同名键。
 */
export function createOpenAIProvider({ config, fetchImpl = fetch, logger = null, resolver = sharedKeyResolver, env = process.env } = {}) {
  const vision = () => visionConfigOf(config);
  const API_KEY_ENVS = ['BAILIAN_API_KEY', 'DEEPSEEK_API_KEY'];

  function chatConfig() {
    const v = config && typeof config.vision === 'object' && config.vision ? config.vision : {};
    const c = v.chat && typeof v.chat === 'object' ? v.chat : {};
    const m = config && typeof config.model === 'object' && config.model ? config.model : {};
    const names = Array.isArray(c.apiKeyEnv) && c.apiKeyEnv.length
      ? c.apiKeyEnv.map(String)
      : (Array.isArray(m.apiKeyEnv) && m.apiKeyEnv.length ? m.apiKeyEnv.map(String) : API_KEY_ENVS);
    let apiKey = typeof c.apiKey === 'string' ? c.apiKey.trim() : '';
    let keyFrom = apiKey ? 'vision.chat.apiKey' : '';
    if (!apiKey) {
      for (const name of names) {
        const value = env?.[name];
        if (typeof value === 'string' && value.trim()) { apiKey = value.trim(); keyFrom = `env.${name}`; break; }
      }
    }
    if (!apiKey && resolver) {
      const got = resolver.resolve(names, typeof c.apiKeyFile === 'string' && c.apiKeyFile.trim() ? c.apiKeyFile.trim() : resolver.file);
      apiKey = got?.apiKey || '';
      keyFrom = apiKey ? got.keyFrom : '';
    }
    return {
      baseUrl: String(c.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
      model: String(c.model || v.model || 'qwen3-vl-plus'),
      apiKey,
      keyFrom
    };
  }

  function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      // 百炼有时把答案拆成多段（text / output_text），拼起来。
      return content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('').trim();
    }
    return '';
  }

  return defineProvider({
    name: 'openai',
    version: VERSION,
    note: '云端 OpenAI 兼容视觉（默认百炼 qwen3-vl-plus），图片会发到云端',
    capabilities: { describe: true },
    async describe({ image, mode = 'describe', focus = '', timeoutMs }) {
      const v = vision();
      if (!v.enabled) throw new Error('视觉未启用（config.json 里 vision.enabled=false）');
      if (!image) throw new Error('没有拿到图片数据');
      const c = chatConfig();
      if (!c.apiKey) throw new Error(`没有可用的视觉 API key（找过 ${c.keyFrom || API_KEY_ENVS.join(' / ')}）`);
      const prompt = `${PROMPTS[mode] || PROMPTS.describe}${focus ? `\n补充关注点：${focus}` : ''}`;
      const budget = Math.max(3000, Number(timeoutMs) || v.timeoutMs);
      // 云端模型对尺寸不敏感，但仍然缩一下：省 token、也避开超大图被拒。
      const prepared = normalizeImageForVision(image, { maxSide: Math.max(v.maxSide, 1280) });
      if (prepared.note) logger?.info?.('视觉输入预处理', prepared.note);
      const MIME = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
      const mime = MIME[String(prepared.format || '').toLowerCase()] || 'image/jpeg';
      const body = {
        model: c.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${prepared.base64}` } }
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: Math.max(256, Number(v.numPredict) || 2048)
      };
      let res;
      try {
        res = await fetchImpl(`${c.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(budget)
        });
      } catch (error) {
        logger?.warn?.('云端视觉请求失败', `${c.baseUrl} ${error?.message ?? error}`);
        throw new Error(`连接云端视觉失败（${c.baseUrl}）：${error?.message ?? error}`);
      }
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = payload?.error?.message || payload?.message || res.status;
        throw new Error(`云端视觉调用失败：${detail}（模型 ${c.model}）`);
      }
      const text = contentText(payload?.choices?.[0]?.message?.content).trim();
      if (!text) throw new Error('云端视觉返回了空结果');
      return {
        text,
        model: c.model,
        raw: payload,
        options: { temperature: 0.1, max_tokens: body.max_tokens },
        image: {
          width: prepared.width,
          height: prepared.height,
          resized: prepared.resized,
          note: prepared.note,
          format: prepared.format
        }
      };
    }
  });
}

/**
 * 规范化一个 provider：
 * - 声明了 capabilities 但没实现对应方法 → 自动补「暂未接入」的抛错实现；
 * - 实现了方法但没声明 → 以实现为准（capabilities 里补上）。
 * 这样「预留能力」在任何 provider 上都是可调用的、明确的错误，而不是 undefined。
 */
export function defineProvider({ name, version = '0.1.0', capabilities = {}, note = '', describe, image2image, videoFrames }) {
  if (!name) throw new Error('provider 必须有名字');
  const implements_ = { describe, image2image, videoFrames };
  const caps = {};
  for (const cap of CAPABILITIES) {
    const declared = capabilities[cap] === true;
    const implemented = typeof implements_[cap] === 'function';
    caps[cap] = declared || implemented;
    if (!implemented) implements_[cap] = async () => { throw notSupportedError(cap, name); };
  }
  return { name, version, note, capabilities: caps, ...implements_ };
}

/** 本机 Ollama 视觉（qwen2.5vl 等）：当前唯一的真实 provider。 */
export function createOllamaProvider({ config, fetchImpl = fetch, logger = null } = {}) {
  const vision = () => visionConfigOf(config);
  return defineProvider({
    name: 'ollama',
    version: VERSION,
    note: '本机 Ollama 多模态模型（默认 qwen2.5vl:3b），不把图片发到云端',
    capabilities: { describe: true },
    async describe({ image, mode = 'describe', focus = '', timeoutMs }) {
      const v = vision();
      if (!v.enabled) throw new Error('本地视觉未启用（config.json 里 vision.enabled=false）');
      if (!image) throw new Error('没有拿到图片数据');
      const prompt = `${PROMPTS[mode] || PROMPTS.describe}${focus ? `\n补充关注点：${focus}` : ''}`;
      const budget = Math.max(1000, Number(timeoutMs) || v.timeoutMs);
      // 大图先缩小：Ollama 对长边 >1280 的图会复读中断（见 resize.mjs 的说明）。
      const prepared = normalizeImageForVision(image, { maxSide: v.maxSide });
      if (prepared.note) logger?.info?.('视觉输入预处理', prepared.note);
      const payloadImage = prepared.base64;
      const attempts = Math.max(0, Math.min(3, Number(v.retries) || 0)) + 1;
      let lastError = null;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const retry = attempt > 0;
        const options = generateOptionsOf(v, { retry });
        let res;
        try {
          res = await fetchImpl(`${v.baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: v.model, prompt, images: [payloadImage], stream: false, options }),
            signal: AbortSignal.timeout(budget)
          });
        } catch (error) {
          logger?.warn?.('本地视觉请求失败', `${v.baseUrl} ${error?.message ?? error}`);
          throw new Error(`连接本地视觉服务失败（${v.baseUrl}）：${error?.message ?? error}。请确认 Ollama 已启动，并已下载模型（ollama pull ${v.model}）`);
        }
        const body = await res.json().catch(() => ({}));
        const rawError = body?.error || (res.ok ? '' : res.status);
        if (!res.ok || rawError) {
          lastError = new Error(`本地视觉模型调用失败：${rawError}（模型 ${v.model}）`);
          // 只有「复读被中断」这类可自愈的失败才重试；模型不存在/HTTP 5xx 重试也没用。
          if (!/repeat/i.test(String(rawError)) || attempt + 1 >= attempts) throw lastError;
          logger?.warn?.('本地视觉复读被中断，正在重试', `${v.model} 第 ${attempt + 1} 次：${rawError}`);
          continue;
        }
        const text = String(body.response || '').trim();
        if (!text) {
          lastError = new Error('本地视觉模型返回了空结果');
          // 空结果多是复读中断后的副作用，同样给它一次重试机会。
          if (attempt + 1 >= attempts) throw lastError;
          logger?.warn?.('本地视觉返回空结果，正在重试', `${v.model} 第 ${attempt + 1} 次`);
          continue;
        }
        return {
          text,
          model: v.model,
          raw: body,
          options,
          image: {
            width: prepared.width,
            height: prepared.height,
            resized: prepared.resized,
            note: prepared.note,
            format: prepared.format
          }
        };
      }
      throw lastError ?? new Error('本地视觉模型调用失败（未说明原因）');
    }
  });
}

/**
 * 媒体注册表：选择 provider、调用能力、统计调用情况。
 * provider 未实现的能力会抛出 `MEDIA_NOT_SUPPORTED`，而不是静默返回空。
 */
export function createMediaRegistry({ config, logger = null, fetchImpl = fetch, providers = null } = {}) {
  let cfg = config ?? {};
  let list = new Map();
  let defaultName = mediaConfigOf(cfg).defaultProvider;
  const stats = { calls: 0, failures: 0, byProvider: {}, reservedCalls: 0 };

  function bump(provider, ok) {
    stats.calls += 1;
    if (!ok) stats.failures += 1;
    const key = String(provider || 'unknown');
    const row = stats.byProvider[key] || (stats.byProvider[key] = { calls: 0, failures: 0 });
    row.calls += 1;
    if (!ok) row.failures += 1;
  }

  function load(nextCfg) {
    cfg = nextCfg ?? cfg;
    list = new Map();
    defaultName = mediaConfigOf(cfg).defaultProvider;
    const seeded = providers ?? [
      createOpenAIProvider({ config: cfg, fetchImpl, logger }),
      createOllamaProvider({ config: cfg, fetchImpl, logger })
    ];
    for (const p of seeded) register(p);
    if (!list.has(defaultName)) defaultName = [...list.keys()][0] ?? '';
  }

  function register(provider) {
    if (!provider?.name) throw new Error('provider 必须有名字');
    list.set(provider.name, provider);
    return provider;
  }

  load(cfg);

  return {
    version: VERSION,
    /** 重新读配置（换模型 / 换默认 provider 不用重启进程）。 */
    configure(nextCfg) { load(nextCfg); return this.capabilities(); },
    register,
    unregister(name) { list.delete(name); },
    names() { return [...list.keys()]; },
    get(name) { return list.get(String(name || '')) || null; },
    defaultName() { return defaultName; },
    setDefault(name) {
      if (!list.has(name)) throw new Error(`没有这个 provider：${name}`);
      defaultName = name;
      return defaultName;
    },
    /** 能力 → 谁提供；预留能力此刻是空数组（接口在，实现没接）。 */
    capabilities() {
      const table = {};
      for (const cap of CAPABILITIES) {
        table[cap] = [...list.values()].filter((p) => p.capabilities?.[cap] === true).map((p) => p.name);
      }
      return { version: VERSION, default: defaultName, reserved: [...RESERVED], providers: this.names(), capabilities: table };
    },
    stats() { return JSON.parse(JSON.stringify(stats)); },
    async describeImage({ image, mode = 'describe', focus = '', provider = null, timeoutMs } = {}) {
      const target = list.get(String(provider || defaultName));
      if (!target) throw new Error(`没有可用的视觉 provider（配置 media.defaultProvider=${defaultName}）`);
      try {
        const out = await target.describe({ image, mode, focus, timeoutMs });
        bump(target.name, true);
        return { ok: true, provider: target.name, model: out?.model ?? null, text: String(out?.text ?? ''), raw: out?.raw ?? null };
      } catch (error) {
        bump(target.name, false);
        logger?.warn?.('媒体能力调用失败', `${target.name} ${error?.message ?? error}`);
        throw error;
      }
    },
    /** 预留：图生图。接上实现前，调用会得到明确的「暂未接入」。 */
    async image2image(args = {}) {
      const target = list.get(String(args.provider || defaultName));
      if (!target) throw new Error(`没有可用的媒体 provider（配置 media.defaultProvider=${defaultName}）`);
      if (target.capabilities?.image2image !== true) stats.reservedCalls += 1;
      try {
        const out = await target.image2image(args);
        bump(target.name, true);
        return { ok: true, provider: target.name, ...out };
      } catch (error) {
        if (error?.code !== 'MEDIA_NOT_SUPPORTED') bump(target.name, false);
        throw error;
      }
    },
    /** 预留：视频帧解析。同样先给明确错误，接口已定。 */
    async videoFrames(args = {}) {
      const target = list.get(String(args.provider || defaultName));
      if (!target) throw new Error(`没有可用的媒体 provider（配置 media.defaultProvider=${defaultName}）`);
      if (target.capabilities?.videoFrames !== true) stats.reservedCalls += 1;
      try {
        const out = await target.videoFrames(args);
        bump(target.name, true);
        return { ok: true, provider: target.name, ...out };
      } catch (error) {
        if (error?.code !== 'MEDIA_NOT_SUPPORTED') bump(target.name, false);
        throw error;
      }
    }
  };
}