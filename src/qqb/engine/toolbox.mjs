/**
 * qqb / engine / toolbox —— 直连引擎的工具箱（R-F）
 *
 * 引擎自己说话时，工具从常驻 MCP 服务（127.0.0.1:3210，Streamable HTTP）现拿现用：
 *   - `tools/list` 把三个端点的工具合并成一份 OpenAI function 清单；
 *   - `tools/call` 按名字找到归属端点去执行。
 *
 * 三个实测结论写在这里，省得以后再踩：
 *   1. 无状态模式下**不需要 initialize 握手**：直接 POST `tools/list` / `tools/call` 就行
 *      （早先手工探测拿到 406，是因为漏了 `accept: application/json, text/event-stream`）。
 *   2. 响应是普通 JSON（宿主开了 enableJsonResponse），不是 SSE 流。
 *   3. 工具的 `inputSchema` 里常含 `key`/`token` 这类会话参数——**不给模型看**：
 *      `expose` 会把它们从 schema 的 required/properties 里摘掉，调用时再由引擎自己填。
 *   4. 「要补哪些会话参数」按 **schema 里声明过的属性** 判，**不能按 `required` 判**：
 *      `key`/`token` 在很多工具里是可选属性（`qq_describe_image` 一个 required 都没有），
 *      按 required 判就永远补不进去，模型又看不到它们 ⇒ 调用必然失败。
 *   5. 工具返回的**图片不能压成 `[图片]` 三个字**：那样她等于对着一张写着「[图片]」的
 *      纸条说话，会说「我看不到图」并开始回避图片问题。像素要原样带出去（`images`），
 *      由 loop 贴进一条 user 消息里给模型真看（见 loop.mjs）。
 */

export const VERSION = '0.1.2';

/** 常驻 MCP 服务的三个端点（与 src/mcp-http-host.js 的 ENDPOINTS 一致）。 */
export const DEFAULT_ENDPOINTS = [
  { server: 'snowluma', path: '/snowluma/mcp' },
  { server: 'snowluma-host', path: '/host/mcp' },
  { server: 'web-search-safe', path: '/websearch/mcp' },
];

/** 会话参数：模型不需要知道，调用前由引擎注入。 */
export const SESSION_ARGS = ['key', 'token'];

/** 单个工具结果的截断长度（工具返回的 JSON 往往很长，别把上下文撑爆）。 */
export const MAX_RESULT_CHARS = 4000;

/**
 * 把 MCP 工具定义转成 OpenAI function 工具，并摘掉会话参数。
 * @param {object} tool MCP 工具（name/description/inputSchema）
 * @param {string[]} sessionArgs 要摘掉的参数名
 */
export function toOpenAiTool(tool, sessionArgs = SESSION_ARGS) {
  const schema = tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
  const properties = { ...(schema.properties ?? {}) };
  const required = Array.isArray(schema.required) ? schema.required.filter((name) => !sessionArgs.includes(name)) : [];
  for (const name of sessionArgs) delete properties[name];
  return {
    type: 'function',
    function: {
      name: String(tool?.name ?? ''),
      description: String(tool?.description ?? ''),
      parameters: { ...schema, type: 'object', properties, ...(required.length ? { required } : { required: undefined }) },
    },
  };
}

/** 从工具 schema 里读必填参数（只做诊断/展示用，别拿它判「要不要补会话参数」）。 */
export function requiredArgsOf(tool) {
  const required = tool?.inputSchema?.required;
  return Array.isArray(required) ? required.map(String) : [];
}

/**
 * 从工具 schema 里读「声明过」的会话参数——**这才是判断要不要补 `key`/`token` 的依据**。
 * 和 requiredArgsOf 的区别：required 只说「必填」，而 key/token 常常是可选属性
 * （`qq_describe_image` 连一个 required 都没有），按 required 判会整整漏补一批工具。
 * @param {object} tool MCP 工具（name/description/inputSchema）
 * @param {string[]} sessionArgs 会话参数名
 */
export function sessionArgsOf(tool, sessionArgs = SESSION_ARGS) {
  const properties = tool?.inputSchema?.properties;
  if (!properties || typeof properties !== 'object') return [];
  return sessionArgs.filter((name) => Object.prototype.hasOwnProperty.call(properties, name));
}

/**
 * 一轮里最多把几张工具取回来的图片交给模型看。
 * 图片是按像素算钱的，而且 base64 很占体积；2 张够用了（和 config.vision.maxImages 同量级）。
 */
export const MAX_RESULT_IMAGES = 2;

/** 单张图的 base64 上限（约 6MB 原始图）——再大就别塞进模型请求了，宁可只留文字。 */
export const MAX_RESULT_IMAGE_CHARS = 8 * 1024 * 1024;

/**
 * @param {object} options
 * @param {string} [options.baseUrl] 常驻 MCP 服务地址，默认 127.0.0.1:3210
 * @param {string} options.token config.json → mcp.httpToken
 * @param {object[]} [options.endpoints] 覆盖默认端点表
 * @param {Function} [options.fetchImpl]
 * @param {object} [options.logger] { warn }
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxResultChars]
 */
export function createToolbox(options = {}) {
  const {
    baseUrl = 'http://127.0.0.1:3210',
    token,
    endpoints = DEFAULT_ENDPOINTS,
    fetchImpl = fetch,
    logger = null,
    timeoutMs = 30000,
    maxResultChars = MAX_RESULT_CHARS,
  } = options;

  const stats = { refreshes: 0, calls: 0, failures: 0, byServer: {}, lastError: null };
  /** @type {Map<string, {server: string, path: string, tool: object}>} */
  const byName = new Map();
  let catalog = [];
  const collisions = [];
  let seq = 0;

  function warn(message, detail) {
    logger?.warn?.(message, detail ?? '');
  }

  async function rpc(endpoint, method, params) {
    seq += 1;
    const body = { jsonrpc: '2.0', id: seq, method, ...(params === undefined ? {} : { params }) };
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${endpoint.path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token ? { 'x-mcp-token': token } : {}),
        },
        body: JSON.stringify(body),
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (error) {
      return { ok: false, error: `连不上常驻 MCP 服务（${baseUrl}${endpoint.path}）：${error?.message ?? error}` };
    }
    const text = await response.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const detail = json?.error?.message ?? text.slice(0, 200);
      return { ok: false, status: response.status, error: `${endpoint.server} HTTP ${response.status}：${detail || '没有响应体'}` };
    }
    if (!json) return { ok: false, error: `${endpoint.server} 返回的不是合法 JSON` };
    if (json.error) return { ok: false, error: `${endpoint.server}：${json.error.message ?? JSON.stringify(json.error)}` };
    return { ok: true, result: json.result ?? null };
  }

  /** 从三个端点拉一遍工具清单（可重复调用刷新）。 */
  async function refresh() {
    const next = new Map();
    const list = [];
    collisions.length = 0;
    for (const endpoint of endpoints) {
      const res = await rpc(endpoint, 'tools/list', {});
      if (!res.ok) {
        warn(`工具箱：${endpoint.server} 的工具清单拉取失败`, res.error);
        stats.lastError = res.error;
        continue;
      }
      const tools = Array.isArray(res.result?.tools) ? res.result.tools : [];
      for (const tool of tools) {
        const name = String(tool?.name ?? '');
        if (!name) continue;
        if (next.has(name)) {
          collisions.push({ name, kept: next.get(name).server, skipped: endpoint.server });
          continue;
        }
        next.set(name, { server: endpoint.server, path: endpoint.path, tool, required: requiredArgsOf(tool), session: sessionArgsOf(tool) });
        list.push(toOpenAiTool(tool));
      }
    }
    byName.clear();
    for (const [name, entry] of next) byName.set(name, entry);
    catalog = list;
    stats.refreshes += 1;
    return { tools: catalog.length, servers: endpoints.length, collisions: collisions.slice() };
  }

  /** OpenAI function 清单（调用方负责先 refresh；没拉过就是空数组而不是隐式异步）。 */
  function catalogOf() {
    return catalog.slice();
  }

  function names() {
    return [...byName.keys()];
  }

  function find(name) {
    return byName.get(String(name ?? '')) ?? null;
  }

  /**
   * 执行一个工具。
   *
   * 图片结果会被**原样带出来**（`images`），不能只留一个 `[图片]` 占位——那等于让模型
   * 对着一张写着「[图片]」的纸条发呆，她会说「我看不到图」并开始回避图片问题。
   * `key`/`token` 那种会话参数已经在 injectArgs 里补好，这里只负责别把像素弄丢。
   *
   * @returns {Promise<{ok: boolean, text: string, images?: {mimeType: string, data: string}[], isError?: boolean, ms: number, server?: string, error?: string}>}
   */
  async function call(name, args = {}) {
    const entry = find(name);
    const startedAt = Date.now();
    stats.calls += 1;
    if (!entry) {
      stats.failures += 1;
      const error = `没有这个工具：${name}`;
      stats.lastError = error;
      return { ok: false, text: '', ms: Date.now() - startedAt, error };
    }
    stats.byServer[entry.server] = (stats.byServer[entry.server] || 0) + 1;
    const res = await rpc(entry, 'tools/call', { name: entry.tool.name, arguments: args });
    const ms = Date.now() - startedAt;
    if (!res.ok) {
      stats.failures += 1;
      stats.lastError = res.error;
      return { ok: false, text: '', ms, server: entry.server, error: res.error };
    }
    const content = Array.isArray(res.result?.content) ? res.result.content : [];
    const images = [];
    const raw = content
      .map((part) => {
        if (part?.type === 'text') return String(part.text ?? '');
        if (part?.type === 'image') {
          const data = typeof part.data === 'string' ? part.data : '';
          const mimeType = String(part.mimeType || 'image/png');
          if (data && data.length <= MAX_RESULT_IMAGE_CHARS && images.length < MAX_RESULT_IMAGES) {
            images.push({ mimeType, data });
          }
          return '[图片]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
    let text = raw;
    if (maxResultChars > 0 && text.length > maxResultChars) {
      text = `${text.slice(0, maxResultChars)}…（结果过长，已截断，原长 ${raw.length} 字）`;
    }
    if (res.result?.isError) {
      stats.failures += 1;
      stats.lastError = text.slice(0, 200);
      return { ok: false, text, isError: true, ms, server: entry.server, error: text.slice(0, 200) || '工具报错' };
    }
    return { ok: true, text, images, isError: false, ms, server: entry.server };
  }

  return {
    version: VERSION,
    refresh,
    catalog: catalogOf,
    schemas: catalogOf,
    names,
    find,
    call,
    endpoints: () => endpoints.map((item) => ({ ...item })),
    stats: () => ({ ...stats, tools: byName.size, collisions: collisions.slice() }),
  };
}