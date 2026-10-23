/**
 * qqb · 模型客户端（R6/F：引擎直连模型 API）
 *
 * 为什么要有它：现在小鲸鱼「说话」这一步是绕道 DSH 的 —— 桥接把唤醒提示交给 DSH 的
 * `qq-chat-v2` preset，由 DSH 去调模型。这条链路一旦 DSH 崩/重启，她就哑了，
 * 而我们前面已经把工具面、记忆、队列都搬出了 DSH，模型是最后一条依赖。
 * 这里把「调模型」抽成 provider 无关的 OpenAI 兼容客户端（百炼 / DeepSeek / 任何兼容端点），
 * 先用 enabled=false 挂着，等桥接切过来时只需要把调用点从 preset 换成这个客户端。
 *
 * 设计取舍：
 * - 只实现 OpenAI 兼容的 /chat/completions（百炼 compatible-mode、DeepSeek 官方都是这个形状），
 *   换端点只改 baseUrl/model，不动代码；
 * - 重试复用 net/backoff（429 / 5xx / 网络错才重试；400/401/403 这类是请求本身的问题，重试没意义）；
 * - 密钥只从「显式 config.model.apiKey → 环境变量 → DSH 凭据文件」取，不猜、不写日志（日志里一律脱敏）。
 *   为什么要有第三条：计划任务里的桥接/看门狗进程环境**没有** BAILIAN_API_KEY/DEEPSEEK_API_KEY
 *   （体检里 keyConfigured=false 就是这么来的），而 `~/.dsh/.credentials.yaml` 的 `refs:` 段里本来就有，
 *   直接复用那一份，省得把密钥再抄一遍到 config.json。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBackoff } from '../net/backoff.mjs';

export const VERSION = '0.1.1';

/** 默认端点：百炼（阿里云）的 OpenAI 兼容入口，本机 .credentials.yaml 里已有 BAILIAN_API_KEY。 */
export const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const DEFAULT_MODEL = 'deepseek-v4.1-flash';
export const DEFAULT_API_KEY_ENVS = ['BAILIAN_API_KEY', 'DEEPSEEK_API_KEY'];
/** DSH 的凭据库：`refs:` 段就是「名字 → 值」的扁平表，这里只认这一段。 */
export const DEFAULT_API_KEY_FILE = path.join(os.homedir(), '.dsh', '.credentials.yaml');

const REDACT = /(sk-[A-Za-z0-9._-]{6})[A-Za-z0-9._-]{2,}/g;

/** 日志/错误里出现密钥时一律打码（百炼的 key 是 `sk-ws-开头的带点串`，不只有 `sk-`）。 */
export function redact(text) {
  return String(text ?? '').replace(REDACT, '$1…');
}

/**
 * 读 DSH 凭据文件 `refs:` 段的键值。**不做通用 YAML 解析**：只扫这一段，
 * 遇到回到行首的顶层键（顶层非空白开头）就停。读不到/格式不对都返回 {}（密钥问题不该让进程起不来）。
 * @param {string} file
 * @param {Function} [readFileSync]
 */
export function readCredentialsRefs(file, readFileSync = fs.readFileSync) {
  const out = {};
  try {
    const text = String(readFileSync(file, 'utf8'));
    let inRefs = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) {
        inRefs = true;
        continue;
      }
      if (!inRefs) continue;
      if (line.trim() && !/^\s/.test(line)) break; // 回到顶层 → refs 段结束
      const matched = /^\s+([A-Za-z0-9_]+):\s*(\S+)\s*$/.exec(line);
      if (matched) out[matched[1]] = matched[2];
    }
  } catch {
    /* 没有这个文件很正常（比如换台机器） */
  }
  return out;
}

/**
 * 凭据文件读取器：按 mtime 缓存，文件没变就不重复读（模型调用很频繁，别每次 IO）。
 * @param {{file?: string, readFileSync?: Function, statSync?: Function}} [options]
 */
export function createKeyResolver(options = {}) {
  const file = options.file || DEFAULT_API_KEY_FILE;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const statSync = options.statSync ?? fs.statSync;
  let cache = null;
  function refs(filePath) {
    try {
      const stat = statSync(filePath);
      if (cache && cache.file === filePath && cache.mtimeMs === stat.mtimeMs) return cache.refs;
      const loaded = readCredentialsRefs(filePath, readFileSync);
      cache = { file: filePath, mtimeMs: stat.mtimeMs, refs: loaded };
      return loaded;
    } catch {
      return {};
    }
  }
  return {
    file,
    /** 按顺序找第一个存在的名字 → {apiKey, keyFrom}。 */
    resolve(names, filePath) {
      const table = refs(filePath || file);
      for (const name of names) {
        const value = table?.[name];
        if (typeof value === 'string' && value.trim()) {
          return { apiKey: value.trim(), keyFrom: `credentials.${name}` };
        }
      }
      return { apiKey: '', keyFrom: '' };
    },
  };
}

/** 模块级共享（凭据文件不常改；常驻进程与体检探针复用同一份 mtime 缓存）。 */
export const sharedKeyResolver = createKeyResolver();

/**
 * 密钥解析：config.model.apiKey → 环境变量（apiKeyEnv）→ 凭据文件 refs（同名键）。
 * **有没有第三步由调用方决定**：传了 `options.resolver` 才读凭据文件，
 * 不传就是纯函数（测试与纯计算场景不该被本机凭据影响）。
 * @returns {{apiKey: string, keyFrom: string}}
 */
export function resolveModelKey(config, env = process.env, options = {}) {
  const m = config && typeof config.model === 'object' && config.model !== null ? config.model : {};
  if (typeof m.apiKey === 'string' && m.apiKey.trim()) {
    return { apiKey: m.apiKey.trim(), keyFrom: 'config.model.apiKey' };
  }
  const names = Array.isArray(m.apiKeyEnv) && m.apiKeyEnv.length ? m.apiKeyEnv.map(String) : DEFAULT_API_KEY_ENVS;
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) return { apiKey: value.trim(), keyFrom: `env.${name}` };
  }
  const resolver = options.resolver || null;
  if (!resolver) return { apiKey: '', keyFrom: '' };
  const file = typeof m.apiKeyFile === 'string' && m.apiKeyFile.trim() ? m.apiKeyFile.trim() : resolver.file;
  return resolver.resolve(names, file);
}

/**
 * 从 config.json 的 model 段 + 环境变量 + 凭据文件解析出客户端配置。
 * @param {any} config
 * @param {Record<string, string|undefined>} [env]
 * @param {{resolver?: any}} [options]
 */
export function modelConfigOf(config, env = process.env, options = {}) {
  const m = config && typeof config.model === 'object' && config.model !== null ? config.model : {};
  const resolved = resolveModelKey(config, env, options);
  const apiKey = resolved.apiKey;
  const keyFrom = resolved.keyFrom;
  return {
    // 默认关闭：装上模块不等于切主链路，切不切由 config.model.enabled 决定（可随时回退）。
    enabled: m.enabled === true,
    provider: String(m.provider || 'bailian'),
    baseUrl: String(m.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: String(m.model || DEFAULT_MODEL),
    apiKey,
    keyFrom,
    keyConfigured: Boolean(apiKey),
    timeoutMs: Math.max(3000, Number(m.timeoutMs) || 60000),
    maxRetries: Math.max(0, Math.min(5, Number.isFinite(Number(m.maxRetries)) ? Number(m.maxRetries) : 2)),
    temperature: Number.isFinite(Number(m.temperature)) ? Number(m.temperature) : 0.8,
    maxTokens: Math.max(0, Number(m.maxTokens) || 0),
    // 端点上有些「兼容参数」得原样带上去（比如百炼的 enable_thinking），
    // 放进配置而不是写死代码里，换模型时不用改客户端。
    extraBody: m.extraBody && typeof m.extraBody === 'object' && !Array.isArray(m.extraBody) ? { ...m.extraBody } : null,
  };
}

/** 把上游错误翻成人话（只保留状态码与一句话，不把整段 HTML 塞进日志）。 */
function describeHttpError(status, body) {
  const detail = body && typeof body === 'object'
    ? body.error?.message || body.message || body.error || ''
    : String(body || '').slice(0, 200);
  return `模型接口返回 ${status}${detail ? `：${redact(detail)}` : ''}`;
}

/**
 * @param {{config?: any, env?: Record<string, string|undefined>, logger?: any, now?: () => number,
 *   fetchImpl?: Function, resolver?: any}} [options]
 */
export function createModelClient(options = {}) {
  const { logger = null, now = () => Date.now(), fetchImpl = globalThis.fetch } = options;
  const env = options.env ?? process.env;
  const resolver = options.resolver || createKeyResolver();
  let cfg = modelConfigOf(options.config, env, { resolver });
  const stats = { calls: 0, ok: 0, failures: 0, retries: 0, toolCalls: 0, lastError: null, lastLatencyMs: null, byPurpose: {} };
  const backoff = createBackoff({ baseMs: 1500, maxMs: 15000, factor: 2, jitter: 0.25 });

  /** 常驻进程里改 config.json 不用重启：重新读一遍配置即可。 */
  function configure(config) {
    cfg = modelConfigOf(config ?? options.config, env, { resolver });
    return cfg;
  }

  function deployReady() {
    return Boolean(cfg.apiKey && cfg.baseUrl && cfg.model);
  }

  /**
   * 调一次对话补全。永不抛：失败也返回结构化结果（调用方自己决定是回退、排队还是报错）。
   * @param {{messages: any[], tools?: any[], toolChoice?: any, temperature?: number, maxTokens?: number,
   *   timeoutMs?: number, signal?: AbortSignal, purpose?: string}} request
   */
  async function complete(request = {}) {
    const purpose = String(request.purpose || 'chat');
    const current = configure();
    stats.calls += 1;
    stats.byPurpose[purpose] = (stats.byPurpose[purpose] || 0) + 1;
    if (!current.enabled) {
      return fail('模型客户端未启用（config.json 里 model.enabled=false）', purpose);
    }
    if (!current.apiKey) {
      return fail(`没有可用的模型 API key（找过 ${current.keyFrom || DEFAULT_API_KEY_ENVS.join(' / ')}）`, purpose);
    }
    if (typeof fetchImpl !== 'function') {
      return fail('当前 Node 没有可用的 fetch', purpose);
    }

    const messages = Array.isArray(request.messages) ? request.messages : [];
    if (!messages.length) return fail('messages 为空', purpose);

    const extra = { ...(current.extraBody || {}), ...(request.extra && typeof request.extra === 'object' ? request.extra : {}) };
    const body = {
      ...extra,
      // 下面这些是我们说了算的，不让 extra 里的同名键把它们顶掉
      model: current.model,
      messages,
      temperature: Number.isFinite(Number(request.temperature)) ? Number(request.temperature) : current.temperature,
    };
    if (Array.isArray(request.tools) && request.tools.length) {
      body.tools = request.tools;
      if (request.toolChoice) body.tool_choice = request.toolChoice;
    }
    const maxTokens = Number(request.maxTokens) || current.maxTokens;
    if (maxTokens > 0) body.max_tokens = maxTokens;

    const timeoutMs = Math.max(3000, Number(request.timeoutMs) || current.timeoutMs);
    const startedAt = now();
    let lastError = '';
    for (let attempt = 0; attempt <= current.maxRetries; attempt += 1) {
      if (attempt > 0) {
        const delay = backoff.next();
        stats.retries += 1;
        logger?.warn?.(`模型调用重试第 ${attempt} 次（${delay}ms 后）`, redact(lastError));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      let response;
      try {
        response = await fetchImpl(`${current.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${current.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: request.signal ?? AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        lastError = `连接模型接口失败：${redact(error?.message ?? error)}`;
        if (request.signal?.aborted) return fail(lastError, purpose); // 主动取消就别重试了
        continue; // 网络问题 → 交给下一轮
      }

      const text = await response.text().catch(() => '');
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        lastError = describeHttpError(response.status, parsed ?? text);
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) return fail(lastError, purpose);
        continue;
      }
      if (!parsed) return fail('模型接口返回的不是合法 JSON', purpose);

      const choice = parsed.choices?.[0] ?? {};
      const message = choice.message ?? {};
      const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call) => ({
        id: String(call.id ?? ''),
        name: String(call.function?.name ?? ''),
        arguments: String(call.function?.arguments ?? ''),
      }));
      if (toolCalls.length) stats.toolCalls += toolCalls.length;
      stats.ok += 1;
      stats.lastError = null;
      stats.lastLatencyMs = Math.max(0, now() - startedAt);
      backoff.reset();
      return {
        ok: true,
        text: String(message.content ?? ''),
        toolCalls,
        usage: parsed.usage ?? null,
        finishReason: String(choice.finish_reason ?? ''),
        model: String(parsed.model || current.model),
        provider: current.provider,
        latencyMs: stats.lastLatencyMs,
        attempts: attempt + 1,
        purpose,
      };
    }
    return fail(lastError || '模型调用失败', purpose, current.maxRetries + 1);
  }

  function fail(error, purpose, attempts = 0) {
    stats.failures += 1;
    stats.lastError = error;
    logger?.warn?.(redact(error), purpose);
    return { ok: false, error, text: '', toolCalls: [], usage: null, finishReason: '', model: cfg.model, provider: cfg.provider, latencyMs: null, attempts, purpose };
  }

  return {
    version: VERSION,
    configure,
    config: () => ({ ...cfg, apiKey: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…` : '' }),
    ready: deployReady,
    complete,
    stats: () => ({ ...stats, byPurpose: { ...stats.byPurpose } }),
    reset: () => {
      stats.calls = 0; stats.ok = 0; stats.failures = 0; stats.retries = 0; stats.toolCalls = 0;
      stats.lastError = null; stats.lastLatencyMs = null; stats.byPurpose = {};
      backoff.reset();
    },
  };
}