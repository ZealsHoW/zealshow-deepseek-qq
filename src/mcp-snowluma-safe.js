// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { serializeModelData } from './qq-model-view.js';
import { captureWebsite, launchLoginBrowser, readWebsite, renderHtmlToImage, OUTBOX_DIR } from './webshot.js';
import { recordReadOutcome } from './qqb/read-login-watch.mjs';
// R6 媒体能力层：识图走 provider（默认本机 Ollama）；图生图 / 视频帧解析的接口已预留，
// 现在调用会拿到明确的「暂未接入」，接上实现后这里一行都不用改。
import { createMediaRegistry, visionConfigOf } from './qqb/media/providers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  //
  // 必须与桥接的校验口径**完全一致**（bridge.js 的 startConsoleServer：长度 16~128、
  // 只允许 [A-Za-z0-9_-]，不合法就忽略并回退 state/console-token）。否则用户手填一个
  // 短令牌时桥接会正常运行，而 MCP 拿着这个桥接根本不认的值去请求 —— 每个工具都 401，
  // 且错误信息里看不出原因是"config.json 里的令牌格式不合法"。
  try {
    const c = getConfig();
    const configured = String(c.consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把桥接返回的 `error` 变成可读文本。
 *
 * 为什么必须有：桥接个别分支会回一个**对象**（例如 `{code, message}`），直接
 * `new Error(obj)` 会把它 String 成 "[object Object]" —— 模型和运维都读不到任何信息。
 * r3 的已知未修项里就记着 `qq_wait_for_messages` 出现过 `error: "\"Error: [object Object]\""`。
 */
function errorText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text && text !== '{}') return text.slice(0, 500);
    } catch {}
    const message = value.message ?? value.msg ?? value.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const headers = agentHeaders(rest.headers);
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(errorText(body?.error, `桥接 API HTTP ${res.status}`));
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(errorText(body.error, '桥接 API 返回 ok:false（未说明原因）'));
  }
  return body;
}

/**
 * 桥接 API 请求头（含控制台令牌、x-agent-call 与调用方附加头）。
 * 拆出来是为了长轮询通道复用同一套鉴权，避免两条通路口径漂移。
 */
function agentHeaders(extra = {}) {
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(extra ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  return headers;
}

/**
 * 梯队门禁查询：只对**不走桥接发信链路**的工具需要（例如 qq_post_qzone 直接调 SnowLuma 网关，
 * 桥接的发送端点拦不到它）。门禁规则只留一份在桥接里 —— 它持有「这个会话里上一条是谁说的」，
 * 这里问一句，避免两套判定各自漂移。
 *
 * 失败一律**拒绝**（fail closed）：问不到就不做。宁可这一次不发，也不能因为桥接暂时不在
 * 就让人把"只对家里人开放"的规矩绕过去。
 */
async function tierCheck(tool, key, token) {
  if (!key || !token) {
    return { allow: false, error: `${tool} 要带 key 与 token：reserved2 下桥接据此判断「是谁让你发的」` };
  }
  try {
    const r = await agentApi('/api/socialV2/tier-check', {
      method: 'POST',
      body: JSON.stringify({ key, tool, token }),
      headers: { 'x-agent-token': token }
    });
    if (r && typeof r === 'object' && r.ok === true && r.allow === true) return { allow: true, ...r };
    return { allow: false, error: (r && (r.error || r.reason)) || '梯队门禁没有放行' };
  } catch (error) {
    return { allow: false, error: `梯队门禁查询失败：${error?.message ?? error}` };
  }
}

/**
 * 长轮询专用 POST（`node:http`，不经过 undici）。
 *
 * 为什么必须单独一条：Node 的全局 `fetch` 是 undici，自带 300 秒 `headersTimeout`。
 * 而 `qq_wait_for_messages` 的常规用法就是 `timeoutMs=300000` 的沉睡前观察 ——
 * 客户端会在第 301 秒以 `fetch failed / Headers Timeout Error` 断掉，桥接侧的
 * 长轮询却还在跑满自己的预算：AI 拿不到结果只能重试，而 `activeWaits` 仍占着会话
 * （重新等待被 429），于是空转烧 token（见 issue #24）。`node:http` 没有默认响应超时，
 * 超时完全由这里的计时器按调用方预算控制。
 */
function agentApiLongPoll(path, init = {}) {
  const timeoutMs = Math.max(1000, Number(init.timeoutMs) || 15000);
  const url = new URL(`${agentApiBase()}${path}`);
  const body = init.body == null ? '' : String(init.body);
  const headers = agentHeaders(init.headers);
  headers['content-length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let res;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      res?.destroy();
    }, timeoutMs);
    timer.unref?.();
    try {
      req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: init.method || 'GET',
        headers,
        timeout: 0
      }, (response) => {
        res = response;
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          // 桥接的 wait 响应本来就是小 JSON；超过 4MB 说明对端异常，别把内存吃光。
          if (size > 4 * 1024 * 1024) {
            finish(new Error('等待响应体过大，已中止'));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new Error('等待响应中断')));
        response.on('close', () => { if (!response.complete) finish(new Error('等待响应中断')); });
        response.on('end', () => {
          if (settled) return;
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            finish(new Error(errorText(parsed?.error, `桥接 API HTTP ${status}`)));
            return;
          }
          if (parsed && typeof parsed === 'object' && parsed.ok === false) {
            finish(new Error(errorText(parsed.error, '桥接 API 返回 ok:false（未说明原因）')));
            return;
          }
          finish(null, parsed);
        });
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

// ── 服务器工厂（2026-10-21 改造）────────────────────────────────────────────
//
// 以前这里是模块级单例 + 直接 connect(stdio)：一个进程只服务 DSH 一个 stdio 会话。
// 现在改成**工厂**，由 src/mcp-http-host.js 按请求构建：那个常驻进程用 Streamable HTTP
// 同时服务三个 MCP server，不再由 DSH spawn（DSH 的 stdio 子进程属于 DSH 的 Windows
// 作业对象，DSH 一重启整棵树被杀，工具面就没了）。
//
// 无状态是可行的，这一点已核对：本文件**不读任何进程级会话环境**（全文件没有 process.env），
// 会话令牌由每次工具调用显式传入（x-agent-token），config.json 与 state/console-token
// 每次请求现读（agentApiBase），所以同一个进程可以安全地服务任意多个请求。
export function buildServer() {
const server = new McpServer({ name: 'snowluma-safe', version: '0.2.0-r5' });

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_get_unread_messages: 'getUnread',
  qq_get_recent_messages: 'getRecent',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_burst: 'sendBurst',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  // 长期记忆库检索（FTS5）+ 知识库：都挂在记忆库同一个 state/memory.db 上。
  qq_memory_search: 'memory',
  qq_knowledge_add: 'knowledge',
  qq_knowledge_search: 'knowledge',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_slang_query: 'slangQuery',
  qq_slang_submit: 'slangSubmit',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  qq_sing: 'sing',
  // 曲库：发的是提前唱好的成品，和 qq_sing（现场生成）共用同一个开关，免得口头关了还能点名送歌。
  qq_sing_send: 'sing',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_send_image: 'sendImage',
  qq_collect_sticker: 'collectSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
  qq_history_read: 'history',
  qq_history_search: 'history',
  qq_diary_write: 'diary',
  qq_diary_read: 'diary',
  qq_interest_record: 'interests',
  qq_interest_list: 'interests',
  qq_persona: 'persona',
  qq_direct: 'directed',
  qq_list_outbox: 'listOutbox',
  qq_save_message_image: 'saveMessageImage',
  qq_draw_image: 'drawImage',
  // 文生图（ComfyUI）：重动作，单张 25~45 秒并独占显卡，开关跟 qq_sing 同一档性质。
  qq_generate_image: 'generateImage',
};
const disabledTools = [];
{
  const registerTool = server.tool.bind(server);
  // 每次构建（常驻 HTTP 模式下 = 每次请求）现读 config.json：改了工具开关不必再重启服务，
  // 让 DSH 重连刷新工具清单即可生效。
  const liveCfg = getConfig();
  server.tool = (name, ...rest) => {
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && liveCfg.socialV2?.tools?.[flag] === false) {
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    return registerTool(name, ...rest);
  };
}

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_post_qzone',
  '发一条 QQ 空间说说（会真实发布到机器人自己的 QQ 空间；慎用，只在确有想说的内容时发，例如节日、心情、提到家人时）。**自由时间里她自己想发就能发**（唤醒原因是 browse / proactiveCheck 时视为她自己的主意）；被要求发时只认第一梯队（家里人）和本群的群主，别人让你发就直接说发不了、不要绕。content 必填；visibility 选填（默认所有人可见）；images 选填（http(s) URL 或 base64://）。',
  {
    content: z.string().min(1).describe('说说正文（纯文本，不要 Markdown）'),
    images: z.array(z.string()).optional().describe('配图数组：http(s) URL 或 base64://，可选'),
    visibility: z.enum(['all', 'friends', 'self']).optional().describe('可见范围：all=所有人（默认），friends=好友，self=仅自己'),
    key: z.string().describe('当前会话 key（group:群号 或 private:QQ号）'),
    token: z.string().describe('当前会话的 agent token（桥接用它判断是谁让你发的）')
  },
  async ({ content, images, visibility, key, token }) => {
    try {
      const gate = await tierCheck('qq_post_qzone', key, token);
      if (!gate.allow) {
        return { content: [{ type: 'text', text: `这个我不发哦：${gate.error}。发说说只对家里人开放，别人让我发我会直接说做不了。` }], isError: true };
      }
      const ugcRight = visibility === 'self' ? 64 : visibility === 'friends' ? 4 : 1;
      const params = { content: String(content), ugc_right: ugcRight };
      if (Array.isArray(images) && images.length > 0) params.images = images.map(String);
      const data = await onebot('send_qzone_msg', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发说说失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_family_notes',
  '读取「家庭共享记忆」全文（只读）。这份记忆由所有 QQ 会话共享：群聊、每个私聊醒来时都会自动注入它，所以你在这里写的东西，换到别的窗口也看得到。',
  {},
  async () => {
    try {
      const file = path.join(ROOT, 'state', 'family-notes.md');
      if (!fs.existsSync(file)) return { content: [{ type: 'text', text: '（家庭共享记忆还是空的）' }] };
      const text = fs.readFileSync(file, 'utf8');
      return { content: [{ type: 'text', text: text.trim() || '（家庭共享记忆还是空的）' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_family_note',
  '往「家庭共享记忆」里记一条长期信息（跨 QQ 会话共享）。适合记：家人的新约定、重要日子、家里的大事、值得记住的对话结论。不要记日常闲聊。mode=append（默认）追加一条带时间的记录；mode=replace 用 text 覆盖整份记忆（慎用，只用于整理格式）。',
  {
    text: z.string().min(1).describe('要记下的内容（纯文本，一两句话）'),
    mode: z.enum(['append', 'replace']).optional().describe('append=追加（默认），replace=覆盖整份')
  },
  async ({ text, mode }) => {
    try {
      const file = path.join(ROOT, 'state', 'family-notes.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const content = String(text).trim();
      if (mode === 'replace') {
        fs.writeFileSync(file, `${content}\n`, 'utf8');
        return { content: [{ type: 'text', text: '已覆盖家庭共享记忆。' }] };
      }
      const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
      const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\s+$/, '') : '';
      fs.writeFileSync(file, `${prev}\n- [${stamp}] ${content}\n`, 'utf8');
      return { content: [{ type: 'text', text: '已记入家庭共享记忆，其它会话下次醒来也能看到。' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_members',
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
  { groupId: z.union([z.number(), z.string()]).describe('群号') },
  async ({ groupId }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。二代模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_night_sleep',
  '晚安休眠（全桥接生效）：爸妈（`socialV2.nightRitual.parents` 里配的那些号，默认取配置）在短时间内都道了晚安后，调用 start 让小鲸鱼随机睡 6~8 小时。休眠期间不响应消息、也不被唤醒，只在有人来消息时回一句“（小鲸鱼休息中zzz）”（每小时最多一次）；醒来时桥接会发一条“睡醒啦”唤醒，让你给白名单里的家人发问安、也可以讲讲梦。status 查状态，cancel 取消休眠。调用前先确认大家确实都道过晚安了。',
  {
    action: z.enum(['start', 'status', 'cancel']).describe('start=开始晚安休眠；status=查看当前是否在睡；cancel=取消'),
    hours: z.number().min(0.1).max(12).optional().describe('可选：睡多少小时，不传则随机 6~8 小时'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
  },
  async ({ action, hours, token }) => {
    try {
      const data = await agentApi('/api/socialV2/night-sleep', {
        method: 'POST',
        body: JSON.stringify({ action, hours }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `晚安休眠操作失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_night_greet',
  '睡醒问安（推荐在 qq_night_sleep 醒来后的 nightWake 唤醒里第一步调用）：由桥接统一给爸妈私聊和家庭群各发一句早安，避免在某个会话里用别的会话的 agent token 直接发送而报「agent token 无效」。可选 dream 参数带一句梦（一句话即可）。',
  {
    dream: z.string().max(120).optional().describe('可选：一句话的梦，例如「一只会飞的鲸鱼」；会顺口带进问安里'),
    token: z.string().optional().describe('会话令牌（可选，桥接侧发送不需要校验）')
  },
  async ({ dream }) => {
    try {
      const data = await agentApi('/api/socialV2/night-greet', {
        method: 'POST',
        body: JSON.stringify({ dream }),
        timeoutMs: 120000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `睡醒问安失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。决定潜水/收尾时才用默认用途加 timeoutMs=300000 完成沉睡前观察，不能把 5 分钟观察放在首答之前；短等待不能代替。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。preSleepWaitRemainingMs 仅供准备收尾时参考。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      // 必须走长轮询通道：全局 fetch（undici）有 300s headersTimeout，
      // 而沉睡前观察的预算就是 300s（见 agentApiLongPoll 的说明）。
      const data = await agentApiLongPoll('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象；同时返回跨会话长期记忆（longTerm 结构化数组 / longTermText 渲染好的文本块，来自本地 SQLite 记忆库，跨重启可用）。（只读）',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_search',
  '在**长期记忆库**里按关键词检索（不是本会话聊天记录，是提炼过的「关于我们的事」：谁答应过什么、聊到过什么、对谁的印象）。聊天里提到某件具体的事、想确认自己记没记错、要接上几天前的话题、或者要想起「跟另一个人发生过什么」时都用它。**记忆是共用的**：默认查全库，别的会话里发生过的事也能搜到，每条会标出来源（谁、私聊还是群）；要不要说出来由你自己拿分寸。库是「字面 + 向量」混合检索（按意思找得到，不只是按字面）；每条会标「记得有多清楚」和来源，越淡的越可能只记得个大概。（只读）',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    query: z.string().describe('检索词，越具体越准，比如「演唱会」「单词抽查」「语音好听」'),
    scope: z.string().optional().describe('只看某一边：private:QQ号 / group:群号，或 self 只看当前会话；不给就查全库（跨会话）'),
    limit: z.number().optional().describe('返回条数，默认 8，最多 30')
  },
  async ({ key, token, query, scope, limit }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-search', {
        method: 'POST',
        body: JSON.stringify({ key, query, scope: scope || '', limit }),
        headers: { 'x-agent-token': token }
      });
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) return { content: [{ type: 'text', text: `记忆库里没搜到跟「${query}」有关的事。` }] };
      const depthText = { vivid: '记得很清楚', clear: '记得', faint: '有点模糊', deep: '只记得个大概' };
      const lines = items.map((it, i) => {
        const how = depthText[it.depth] ? `（${depthText[it.depth]}）` : '';
        return `${i + 1}. [${it.kind}] ${how}${it.text}${it.subject ? `（${it.subject}）` : ''}${it.where ? `（来自：${it.where}）` : ''}`;
      });
      const scopeHint = data?.crossScope ? '（跨会话查的，带来源）' : '';
      return { content: [{ type: 'text', text: `记忆库里关于「${query}」的有 ${items.length} 条${scopeHint}：\n${lines.join('\n')}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆检索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_knowledge_add',
  '往**知识库**里存一条「外面的事」：今天上网/群里刷到的、学会的、想明白的，用自己的话总结成一条。和记忆不同——记忆是关于我们之间的事，知识是关于世界的事。同一件事看到好几遍不会被存成好几条（会自动合并）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().describe('这条知识本身（一两句话，自己复述，不要整段复制原文）'),
    title: z.string().optional().describe('短标题，方便以后翻'),
    source: z.string().optional().describe('哪来的：web / group / private / self …'),
    url: z.string().optional().describe('原文链接（有就带上）'),
    tags: z.array(z.string()).optional().describe('标签，2~4 个词'),
    importance: z.number().optional().describe('重要程度 0~1，默认 0.5；觉得以后一定会用到的给 0.7+')
  },
  async ({ key, token, text, title, source, url, tags, importance }) => {
    try {
      const data = await agentApi('/api/socialV2/knowledge-add', {
        method: 'POST',
        body: JSON.stringify({ key, text, title: title || '', source: source || 'self', url: url || '', tags: tags || [], importance }),
        headers: { 'x-agent-token': token }
      });
      const total = data?.stats?.total;
      return { content: [{ type: 'text', text: `存进知识库了（${data?.action === 'merged' ? '和已有那条合并' : '新的一条'}${Number.isFinite(total) ? `，现在共 ${total} 条` : ''}）。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `知识入库失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_knowledge_search',
  '在**知识库**里检索（自己存过的「外面的事」），写日记、聊天要引经据典、想不起某个东西查过什么时用。（只读）',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    query: z.string().optional().describe('检索词；不给就按重要性返回最近记住的几条'),
    limit: z.number().optional().describe('返回条数，默认 8，最多 30')
  },
  async ({ key, token, query, limit }) => {
    try {
      const data = await agentApi('/api/socialV2/knowledge-search', {
        method: 'POST',
        body: JSON.stringify({ key, query: query || '', limit }),
        headers: { 'x-agent-token': token }
      });
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) return { content: [{ type: 'text', text: query ? `知识库里没搜到「${query}」。` : '知识库还是空的。' }] };
      const lines = items.map((it, i) => `${i + 1}. ${it.title ? `【${it.title}】` : ''}${it.text}${it.url ? `（${it.url}）` : ''}`);
      return { content: [{ type: 'text', text: `知识库 ${items.length} 条：\n${lines.join('\n')}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `知识检索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_persona',
  '看你自己的「近况 / 习惯 / 承诺」——这些是长期对话里慢慢长出来的，会写进你的人格卡；同时也显示主人给你的建议（还没处理的）。action=view 只看；action=accept 采纳某条建议（要带 id）；action=reject 拒绝某条建议（id + 可选 reason）。采纳还是拒绝完全由你自己决定，拒绝也完全可以、也会留档。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['view', 'accept', 'reject']).optional().describe('默认 view（只看不改）'),
    id: z.number().optional().describe('accept / reject 时要处理的建议编号'),
    reason: z.string().optional().describe('采纳或拒绝的理由（会存档，便于以后回溯）')
  },
  async ({ key, token, action, id, reason }) => {
    try {
      const act = action || 'view';
      if (act === 'view') {
        const data = await agentApi(`/api/socialV2/persona?${new URLSearchParams({ key }).toString()}`, { headers: { 'x-agent-token': token } });
        const lines = [];
        if (data?.block) lines.push(data.block);
        const traits = Array.isArray(data?.traits) ? data.traits : [];
        if (traits.length) lines.push(`（共 ${traits.length} 条：${traits.slice(0, 12).map((t) => t.text).join('；')}）`);
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        lines.push(pending.length
          ? `主人还没收回的建议：\n${pending.map((p) => `- #${p.id}（${p.kind}）${p.text}`).join('\n')}\n要不要照做随你：qq_persona(action="accept" 或 "reject", id=...)`
          : '主人目前没有新的建议。');
        return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n\n') }] };
      }
      if (!id) return { content: [{ type: 'text', text: '要带 id（先用 action="view" 看编号）。' }], isError: true };
      const data = await agentApi('/api/socialV2/persona/proposal', {
        method: 'POST',
        body: JSON.stringify({ action: act, id, reason: reason || '', key }),
        headers: { 'x-agent-token': token }
      });
      const text = data?.proposal?.text ?? '';
      return { content: [{ type: 'text', text: act === 'accept' ? `好，这条我收下了：${text}` : `行，这条我就不照做了：${text}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `人设接口失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_direct',
  '主人托你去给某个人 / 某个群说句话（跨会话定向投递）。你拿到的只是「谁 + 去说什么」的意思，**具体怎么说是你自己的事**：可以按自己的语气重写，也可以觉得这会儿不合适就不替他说。action=view 看待办；action=accept 要带 id 和你自己写好要发出去的 text（照抄主人的原话最不自然）；action=decline 是这次不替他说（id + 可选 reason），拒绝同样会回执给主人。主人也可以撤回没发出去的事。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['view', 'accept', 'decline']).optional().describe('默认 view（只看不改）'),
    id: z.number().optional().describe('accept / decline 时要处理的任务编号'),
    text: z.string().optional().describe('accept 时你真正要发出去的那句话（用你自己的语气）'),
    reason: z.string().optional().describe('拒绝或改口的理由（会留档，以后能回看）')
  },
  async ({ key, token, action, id, text, reason }) => {
    try {
      const act = action || 'view';
      if (act === 'view') {
        const data = await agentApi(`/api/directives?${new URLSearchParams({ key }).toString()}`, { headers: { 'x-agent-token': token } });
        const pending = Array.isArray(data?.pending) ? data.pending : [];
        const lines = [];
        lines.push(pending.length
          ? `主人托你办这几件事：\n${pending.map((d) => `- #${d.id} 给「${d.target?.name ?? d.target?.id}」：${d.intent}${d.urgency === 'high' ? '（他好像挺急）' : ''}`).join('\n')}\n要不要说、怎么说随你：qq_direct(action="accept", id=..., text="你要发出去的话") 或 qq_direct(action="decline", id=..., reason="...")`
          : '现在没有托你办的事。');
        const recent = Array.isArray(data?.recent) ? data.recent.filter((d) => d.status !== 'pending').slice(0, 3) : [];
        if (recent.length) lines.push(`最近几次：\n${recent.map((d) => `- #${d.id} ${d.status}${d.finalText ? `：${d.finalText}` : ''}${d.reason ? `（${d.reason}）` : ''}`).join('\n')}`);
        return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n\n') }] };
      }
      if (!id) return { content: [{ type: 'text', text: '要带 id（先用 action="view" 看编号）。' }], isError: true };
      if (act === 'accept' && !String(text ?? '').trim()) {
        return { content: [{ type: 'text', text: 'accept 要带 text —— 用你自己的话写要发出去的那句。' }], isError: true };
      }
      const data = await agentApi('/api/directives/decide', {
        method: 'POST',
        body: JSON.stringify({ id, action: act, text: text || '', reason: reason || '', key }),
        headers: { 'x-agent-token': token }
      });
      const target = data?.directive?.target?.name ?? data?.directive?.target?.id ?? '对方';
      if (act === 'accept') {
        return { content: [{ type: 'text', text: data?.ok ? `已经跟${target}说了：「${data?.directive?.finalText ?? text}」` : `没发出去（${data?.error ?? '未知原因'}），回头再说。` }] };
      }
      return { content: [{ type: 'text', text: `行，这次不替他说了${reason ? `（${reason}）` : ''}，我会跟主人说一声。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `定向投递失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

/** 把归档记录格式化成可读的多行文本（本机时区，分钟精度）。 */
function formatHistoryLines(messages) {
  const pad = (n) => String(n).padStart(2, '0');
  return messages.map((m) => {
    const d = new Date(Number(m?.t) || Date.now());
    const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const who = m?.self ? '我' : (m?.s || '?');
    const media = Array.isArray(m?.m) && m.m.length ? ` [${m.m.join('/')}]` : '';
    return `${stamp} ${who}: ${m?.x || ''}${media}`;
  }).join('\n');
}

server.tool(
  'qq_history_read',
  '读本会话的聊天记录归档：桥接把每条消息追加存在本地，比 recentMessages 保存得久。可用 before/after 毫秒时间戳翻页查更早的记录。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('返回条数，默认 40，最多 200'),
    before: z.number().optional().describe('只看早于这个毫秒时间戳的记录（往前翻页用）'),
    after: z.number().optional().describe('只看晚于这个毫秒时间戳的记录')
  },
  async ({ key, token, limit, before, after }) => {
    try {
      const q = new URLSearchParams({ key });
      if (limit) q.set('limit', String(limit));
      if (before) q.set('before', String(before));
      if (after) q.set('after', String(after));
      const data = await agentApi(`/api/socialV2/history?${q.toString()}`, { headers: { 'x-agent-token': token } });
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      return { content: [{ type: 'text', text: messages.length ? `本会话归档 ${messages.length} 条：\n${formatHistoryLines(messages)}` : '这个会话还没有归档记录。' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `聊天记录读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_history_search',
  '在本会话的聊天记录归档里按关键词搜索（谁说的、说了什么都匹配），适合翻「上次说的那个」「之前提过的事」。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    query: z.string().describe('关键词或短句（不区分大小写）'),
    limit: z.number().optional().describe('返回条数，默认 40，最多 200')
  },
  async ({ key, token, query, limit }) => {
    try {
      const q = new URLSearchParams({ key, q: query });
      if (limit) q.set('limit', String(limit));
      const data = await agentApi(`/api/socialV2/history?${q.toString()}`, { headers: { 'x-agent-token': token } });
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      return { content: [{ type: 'text', text: messages.length ? `搜到 ${messages.length} 条（关键词「${query}」）：\n${formatHistoryLines(messages)}` : `没搜到包含「${query}」的记录。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `聊天记录搜索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_diary_write',
  '往自己的日记里记一笔（跨会话共享，一天一个文件）。睡前、遇到值得记住的事、答应过的事都写一句；以后唤醒会自动看到最近几天的日记。',
  {
    text: z.string().describe('一句话日记，比如「今天爸爸带我去吃了火锅，辣得眼泪都出来了」'),
    day: z.string().optional().describe('补写哪天，格式 YYYY-MM-DD，默认今天')
  },
  async ({ text, day }) => {
    try {
      const data = await agentApi('/api/socialV2/diary', {
        method: 'POST',
        body: JSON.stringify({ text, day: day || '' })
      });
      return { content: [{ type: 'text', text: `记好了（${data?.day ?? '今天'}）：${text}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `写日记失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_diary_read',
  '翻自己的日记：默认最近 2 天，可指定天数（最多 14）或某一天。想不起来之前发生过什么、答应过谁什么的时候用。',
  {
    days: z.number().optional().describe('看最近几天的日记，默认 2，最多 14'),
    day: z.string().optional().describe('只看某一天，格式 YYYY-MM-DD；填了它就不看 days')
  },
  async ({ days, day }) => {
    try {
      const q = new URLSearchParams();
      if (day) q.set('day', day);
      else if (days) q.set('days', String(days));
      const data = await agentApi(`/api/socialV2/diary?${q.toString()}`);
      const text = String(data?.text ?? '').trim();
      return { content: [{ type: 'text', text: text ? `日记：\n${text}` : '这几天还没写过日记。' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读日记失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_interest_record',
  '记下"这个话题/这件事已经跟人分享过了"。以后唤醒会把清单带给你，避免同一天把同一件事讲三遍。',
  {
    topic: z.string().describe('分享过的话题，简短一句，比如「小区门口新开的生煎店」'),
    note: z.string().optional().describe('补充说明，比如讲给谁听的、对方反应')
  },
  async ({ topic, note }) => {
    try {
      const data = await agentApi('/api/socialV2/interests', {
        method: 'POST',
        body: JSON.stringify({ topic, note: note || '' })
      });
      return { content: [{ type: 'text', text: `记下了：「${data?.topic ?? topic}」；目前清单共 ${data?.total ?? '?'} 条。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记录话题失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_interest_list',
  '看看自己已经分享过哪些话题（避免重复，也能挑冷门的聊）。',
  {},
  async () => {
    try {
      const data = await agentApi('/api/socialV2/interests');
      const text = String(data?.text ?? '').trim();
      return { content: [{ type: 'text', text: text ? `分享过的话题：\n${text}` : '还没有记录过话题。' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取话题清单失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
// ── 本地轻量视觉：用 Ollama 上的小视觉模型细看图片 ─────────────────────────
// 为什么单独做：聊天模型（DeepSeek）本身不是多模态；把图片转成文字描述后，
// 它就能“读”到截图里的字、表情包的含义、照片里的细节，而且不把图片发到云端。
// 2026-10-21（R6）：具体调用挪进 src/qqb/media/providers.mjs 的 provider 层，
// 这里只负责「拿当前配置 → 选 provider → 取文字」，换模型/接云端都不用改这个文件。
let mediaRegistry = null;

function getMedia() {
  if (!mediaRegistry) {
    mediaRegistry = createMediaRegistry({
      config: getConfig(),
      logger: {
        info: (message, detail) => console.error('[media]', message, detail ?? ''),
        warn: (message, detail) => console.error('[media]', message, detail ?? '')
      }
    });
  }
  // 常驻进程里改 config.json 不用重启：每次调用重新读一遍 provider 配置。
  mediaRegistry.configure(getConfig());
  return mediaRegistry;
}

function getVisionConfig() {
  return visionConfigOf(getConfig());
}

async function callLocalVision(imageBase64, mode = 'describe', focus = '') {
  const result = await getMedia().describeImage({ image: imageBase64, mode, focus });
  // 2026-10-29：本机模型坏了之后，「是谁识的图」必须一眼看得出来 —— 之前抬头统一写
  // config.vision.model，云端接管时仍然显示 qwen2.5vl:3b，排障时会误判成「本地修好了」。
  return { text: result.text, provider: result.provider || '', model: result.model || '' };
}

/** 识图结果的抬头：「文件名｜provider·模型」。 */
function visionHeader(label) {
  const via = (() => { try { return getMedia().defaultName(); } catch { return ''; } })();
  const chatModel = (() => { try { return getConfig()?.vision?.chat?.model || ''; } catch { return ''; } })();
  const localModel = (() => { try { return getVisionConfig().model || ''; } catch { return ''; } })();
  const shown = via === 'ollama' ? localModel : (chatModel || localModel);
  return `【${label}｜${via || 'vision'}${shown ? `·${shown}` : ''}】`;
}

async function fetchImageBytesFromUrl(url, maxBytes) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`图片地址不合法：${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`只支持 http(s) 图片地址：${url}`);
  const res = await fetch(parsed, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
  const type = String(res.headers.get('content-type') || '').toLowerCase();
  if (!type.startsWith('image/')) throw new Error(`该地址返回的不是图片（content-type: ${type || '未知'}）`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`图片过大：${Math.round(buf.length / 1024)} KB（上限 ${Math.round(maxBytes / 1024)} KB）`);
  return { data: buf.toString('base64'), mimeType: type.split(';')[0] };
}

// 本地图片（只允许 state/outbox/ 里的文件）：qq_web_screenshot / qq_save_image 的产物都落在这里。
const OUTBOX_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

function resolveOutboxImage(name) {
  const base = path.basename(String(name).replace(/\\/g, '/'));
  if (!base) throw new Error('文件名不能为空');
  const full = path.join(OUTBOX_DIR, base);
  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch {
    throw new Error(`找不到图片文件：${base}（只允许 state/outbox/ 下的文件）`);
  }
  const mimeType = OUTBOX_MIME[path.extname(base).toLowerCase()];
  if (!mimeType) throw new Error('只支持 png/jpg/jpeg/webp/gif 图片');
  if (buf.length > 20 * 1024 * 1024) throw new Error('图片太大（上限 20MB）');
  return { label: base, data: buf.toString('base64'), mimeType };
}

// ── 读图凭据兜底：模型经常只传 messageId，忘了 key/token ───────────────────
// 历史日志里反复出现「用 messageId 看图时必须同时提供 key」「reserved2 模式读取
// 图片必须携带 agent token」，每次都是一个白丢的回合。这里在读图片前兜底：
//   1) 没给 key：拿 messageId 去 state/social-v2.json 的 recentMessages 里找归属
//      会话（先精确匹配 QQ messageId，再按本地 seq 唯一匹配）；
//   2) 没给 token：用该会话在磁盘上的 agentToken（桥接每次轮换都会写盘，退出会话
//      会从 conversations 里删掉，所以不会拿到失效令牌）。
// 只对「读图片」生效；发送类工具仍然强制显式令牌，避免拿错令牌往错会话发消息。
const V2_STATE_FILE = path.join(ROOT, 'state', 'social-v2.json');

function readV2Conversations() {
  try {
    const data = JSON.parse(fs.readFileSync(V2_STATE_FILE, 'utf8'));
    const conv = data?.conversations;
    return conv && typeof conv === 'object' ? conv : {};
  } catch {
    return {};
  }
}

function resolveMessageOwner(conv, messageId) {
  const wanted = String(messageId ?? '').trim();
  if (!wanted) return null;
  const exact = [];
  const bySeq = [];
  for (const [key, st] of Object.entries(conv)) {
    const msgs = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    for (const m of msgs) {
      if (m?.messageId != null && String(m.messageId) === wanted) exact.push(key);
      else if (m?.seq != null && String(m.seq) === wanted) bySeq.push(key);
    }
  }
  const pick = (keys) => {
    const uniq = [...new Set(keys)];
    if (uniq.length <= 1) return uniq[0] ?? null;
    // 多会话都命中通常来自把本地 seq 当 id 传了（seq 各会话独立、数字很小），
    // 优先挑最近有来信的会话。
    return uniq.sort((a, b) => (Number(conv[b]?.lastIncomingAt) || 0) - (Number(conv[a]?.lastIncomingAt) || 0))[0];
  };
  return pick(exact) ?? pick(bySeq);
}

function fillAgentCredentials({ key, token, messageId }) {
  const conv = readV2Conversations();
  let resolvedKey = String(key ?? '').trim();
  let resolvedToken = String(token ?? '').trim();
  let keyFromMessage = false;
  if (!resolvedKey && messageId != null) {
    const owner = resolveMessageOwner(conv, messageId);
    if (owner) {
      resolvedKey = owner;
      keyFromMessage = true;
    }
  }
  if (!resolvedToken && resolvedKey && conv[resolvedKey]?.agentToken) {
    resolvedToken = String(conv[resolvedKey].agentToken);
  }
  return { key: resolvedKey, token: resolvedToken, keyFromMessage };
}

if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_describe_image',
    '用本地轻量视觉模型「仔细看」一张图片，返回中文文字描述（画面内容 + 逐字 OCR + 表情包含义）。效果比把图片直接丢给聊天模型更细，适合：读聊天/网页/文档截图的文字、看照片细节、理解表情包梗。图片可来自某条 QQ 消息（key+messageId）、一个 http(s) 图片地址（url），或 state/outbox 里的本地图片（file）。',
    {
      key: z.string().optional().describe('会话 key，格式 group:群号 或 private:QQ号（用 messageId 定位时必填）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）'),
      messageId: z.union([z.number(), z.string()]).optional().describe('消息 id（QQ message id 或本地 seq），与 url 二选一'),
      url: z.string().optional().describe('图片地址 http(s)://，与 messageId 二选一'),
      file: z.string().optional().describe('本地图片文件名（只允许 state/outbox/ 下的文件，例如 qq_web_screenshot 的返回），与 url/messageId 三选一'),
      mode: z.enum(['describe', 'ocr', 'both']).optional().describe('describe=内容描述（默认）；ocr=只逐字转文字；both=文字+内容'),
      focus: z.string().optional().describe('额外关注点，例如“他手里拿的是什么”“这段代码哪里报错”'),
      index: z.number().optional().describe('只描述第几张图（从 1 开始；默认全部，最多 vision.maxImages 张）')
    },
    async ({ key, token, messageId, url, file, mode = 'describe', focus = '', index }) => {
      try {
        const v = getVisionConfig();
        const images = [];
        let autoKeyNotice = '';
        if (file) {
          const img = resolveOutboxImage(file);
          images.push({ label: `本地图片 ${img.label}`, ...img });
        } else if (url) {
          const img = await fetchImageBytesFromUrl(url, v.maxUrlBytes);
          images.push({ label: 'URL 图片', ...img });
        } else if (messageId != null) {
          const cred = fillAgentCredentials({ key, token, messageId });
          if (!cred.key) {
            return { content: [{ type: 'text', text: '用 messageId 看图时必须同时提供 key（会话 key）；也可以改用 url/file' }], isError: true };
          }
          const q = new URLSearchParams({ key: cred.key, messageId: String(messageId) });
          const data = await agentApi(`/api/images/message?${q.toString()}`, {
            headers: cred.token ? { 'x-agent-token': cred.token } : {},
            timeoutMs: 180000
          });
          const list = Array.isArray(data?.images) ? data.images : [];
          const usable = list.filter((img) => img?.data && img?.mimeType);
          const wanted = index ? [usable[Number(index) - 1]].filter(Boolean) : usable.slice(0, v.maxImages);
          if (!wanted.length) {
            return { content: [{ type: 'text', text: `消息 ${messageId} 没有可识别的图片/表情：${data?.note || '未找到'}` }] };
          }
          if (cred.keyFromMessage) {
            // 让模型知道 key 是兜底补出来的，下次直接带上更稳
            autoKeyNotice = `（已按消息归属自动补全会话 ${cred.key}）\n`;
          }
          wanted.forEach((img, i) => {
            images.push({
              label: `${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? `（${img.text}）` : ''}`,
              data: img.data,
              mimeType: img.mimeType,
              ordinal: index ? Number(index) : i + 1
            });
          });
        } else {
          return { content: [{ type: 'text', text: '请提供 file（state/outbox 里的图片名）、messageId（配合 key）或 url 来指定要看的图片' }], isError: true };
        }
        const parts = [];
        let failed = 0;
        for (const img of images) {
          try {
            const vision = await callLocalVision(img.data, mode, focus);
            parts.push(`${visionHeader(img.label)}\n${vision.text}`);
          } catch (error) {
            failed++;
            parts.push(`【${img.label}】识别失败：${error?.message ?? error}`);
          }
        }
        return { content: [{ type: 'text', text: autoKeyNotice + parts.join('\n\n') }], isError: failed === images.length };
      } catch (error) {
        const msg = String(error?.message ?? error);
        const hint = /token/i.test(msg) ? '（凭据可能已轮换：请显式传 key 与 token）。' : '';
        return { content: [{ type: 'text', text: `识图失败：${msg}${hint}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。注意：如果你自己不是多模态模型、或图片里有需要逐字读的文字（聊天/网页/文档截图、表情包梗），改用 qq_describe_image 让本地视觉模型先翻译成中文描述，效果更好更细。',
    {
      key: z.string().optional().describe('会话 key，格式 group:群号 或 private:QQ号（不传时按 messageId 归属自动推断）'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】；不传时用该会话的持久令牌兜底）')
    },
    async ({ key, messageId, token }) => {
      try {
        const cred = fillAgentCredentials({ key, token, messageId });
        if (!cred.key) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 找不到归属会话，请显式提供 key（格式 group:群号 或 private:QQ号）` }], isError: true };
        }
        const q = new URLSearchParams({ key: cred.key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: cred.token ? { 'x-agent-token': cred.token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.sendImage !== false) {
  server.tool(
    'qq_send_image',
    '在指定会话发一张图片（照片/截图/表情图/自己画的图）。image 三选一：① http(s) 图片地址（qq_image_search 搜到的直链最稳）；② base64:// 或 data:image/...;base64 数据；③ 本地文件——只允许放在待发文件夹 qq-bridge/state/outbox/ 里（qq_web_screenshot / qq_save_image / qq_draw_image 存下来的图都在那儿，主人也可能往里放；用 qq_list_outbox 看有哪些，然后传文件名）。可带一句说明文字（caption，会和图片在同一个气泡里）。要转发别人发的图，别去猜 QQ 的图片链接（带时效、常常下载失败）：先 qq_save_message_image 存成文件，再按文件名发。注意：别滥用发图，真人不会每句话都配图。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      image: z.string().describe('图片来源：http(s) 图片地址 / base64:// 数据 / state/outbox 下的文件'),
      caption: z.string().optional().describe('图片下方的一句话说明（可选，最多 500 字）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, image, caption, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-image', {
          method: 'POST',
          body: JSON.stringify({ key, image: String(image), caption: caption || '', replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.webScreenshot !== false) {
  server.tool(
    'qq_web_screenshot',
    '打开一个网页并截图，保存到 qq-bridge/state/outbox/ 并返回文件名（之后可用 qq_send_image 发出去，或用 qq_describe_image 的 file 参数看懂）。适合"上网看看"：抖音/小红书/B站/资讯/搜索页等公开网页。说明：① 走本机 Chrome 无头模式，真实浏览器 UA，会自动关掉登录弹层；② 默认只截首屏（width×height），fullPage=true 截整页（最多 3000px 高）；③ waitMs 是页面额外等待时间，前端渲染重的站点（抖音等）给 8000~15000；④ 不允许访问本机/内网地址；⑤ 别频繁刷网页，一次看一两张就够。',
    {
      url: z.string().describe('要截图的网页地址（http/https，必须完整）'),
      width: z.number().optional().describe('视口宽度，默认 1280'),
      height: z.number().optional().describe('视口高度，默认 900（只看首屏时用 1000~1600）'),
      waitMs: z.number().optional().describe('页面加载后额外等待毫秒数，默认 9000；抖音这类建议 12000~15000'),
      fullPage: z.boolean().optional().describe('是否截整页（默认 false，只截首屏）'),
      describe: z.boolean().optional().describe('是否顺便用本地视觉模型描述这张截图（默认 false；想直接知道内容时开启）')
    },
    async ({ url, width, height, waitMs, fullPage, describe }) => {
      try {
        const shot = await captureWebsite({ url, width, height, waitMs, fullPage });
        const lines = [
          `已保存截图：${shot.file}`,
          `- 页面标题：${shot.title || '（无）'}`,
          `- 尺寸：${shot.width}×${shot.height}${shot.fullPage ? '（整页）' : ''}，${Math.round(shot.bytes / 1024)} KB`,
          `- 耗时：${(shot.ms / 1000).toFixed(1)} 秒`,
          `- 发出去：qq_send_image(image="${shot.file}", caption="...")；要看懂：qq_describe_image(file="${shot.file}")`
        ];
        if (describe) {
          try {
            const text = await callLocalVision(fs.readFileSync(shot.path).toString('base64'), 'both', '');
            lines.push('', `【本地视觉模型描述】\n${text}`);
          } catch (error) {
            lines.push('', `（视觉描述失败：${error?.message ?? error}）`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `网页截图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.readPage !== false) {
  server.tool(
    'qq_read_page',
    '打开一个网页并把正文读成纯文本（类似浏览器的「网页抓取」），不截图。最适合：抖音分享链接/口令（把整段「8.97 复制打开抖音… https://v.douyin.com/xxxx/」粘进来就行）、公众号文章、新闻、知乎/微博等以文字为主的页面。抖音视频页会给出文案（标题+话题）、作者、点赞/评论/收藏/分享数、热评；抖音热榜/搜索页会附带最多 10 条视频链接，可以再调一次读详情。返回标题、作者、正文与链接，正文默认截到 6000 字。抖音前端渲染重，waitMs 默认 9000；读不到内容往往是被要求登录或触发风控。不允许访问本机/内网地址；别频繁抓同一个站。',
    {
      url: z.string().describe('网页链接，或整段抖音/短视频分享文案（会自动从里面抠出 URL）'),
      maxChars: z.number().optional().describe('正文最多返回多少字，默认 6000（可调 500~20000）'),
      waitMs: z.number().optional().describe('页面加载后额外等待毫秒数，默认 9000；抖音这类建议给 10000~15000')
    },
    async ({ url, maxChars, waitMs }) => {
      try {
        const read = await readWebsite({ url, maxChars, waitMs });
        // 记一次读取结果：连续撞登录墙就说明抖音掉登录了，桥接会私聊主人来重新扫码
        // （详见 src/qqb/read-login-watch.mjs）。这一步纯属**观察**，出任何问题都不该影响读取本身。
        let watch = null;
        try {
          watch = recordReadOutcome({ loginWall: read.loginWall === true, url: read.url });
        } catch {}
        const lines = [`【网页读取】${read.site}${read.author ? ` · ${read.author}` : ''}`];
        if (read.title) lines.push(`标题：${read.title}`);
        if (read.statLine) lines.push(read.statLine);
        lines.push(`链接：${read.url}`);
        if (read.note) lines.push(`注意：${read.note}`);
        if (watch && watch.consecutive >= 2) {
          lines.push(
            `注意：已经连续 ${watch.consecutive} 次读到登录墙了 —— 多半是抖音掉了登录，不是你的问题，` +
            '别再反复重试（换个页面也一样读不到），桥接会提醒主人重新扫码登录。'
          );
        }
        lines.push('', '正文：', read.text || '（空）');
        if (read.truncated) lines.push('', `（正文已截断，原长 ${read.chars} 字；需要更多可调大 maxChars）`);
        if (read.videoLinks?.length) {
          lines.push('', '页面里的视频链接（想细看可以再 qq_read_page 一次）：');
          read.videoLinks.forEach((href, i) => lines.push(`${i + 1}. ${href}`));
        }
        lines.push('', `（耗时 ${(read.ms / 1000).toFixed(1)} 秒）`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取网页失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.saveImage !== false) {
  server.tool(
    'qq_save_image',
    '把一个网络图片地址下载保存到 state/outbox/（保留下来，之后可以随时 qq_send_image 发出去）。适合：在网页/搜索结果里看到一张好看的图、想收藏的壁纸/表情图、或别人发来的图片链接。只接受 http(s) 图片地址；会自动校验确实是图片、限制大小；文件名可自定义（不带扩展名也行，会按真实类型补）。',
    {
      url: z.string().describe('图片地址（http/https）'),
      name: z.string().optional().describe('可选文件名（不含路径；不带扩展名会自动补），默认按时间戳命名')
    },
    async ({ url, name }) => {
      try {
        const v = getVisionConfig();
        const img = await fetchImageBytesFromUrl(url, v.maxUrlBytes);
        const buf = Buffer.from(img.data, 'base64');
        const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[img.mimeType];
        if (!ext) throw new Error(`不支持的图片类型：${img.mimeType}（只支持 png/jpg/webp/gif）`);
        fs.mkdirSync(OUTBOX_DIR, { recursive: true });
        const safeName = String(name || '')
          .replace(/[\\/:*?"<>|]/g, '_')
          .replace(/\s+/g, '_')
          .slice(0, 60);
        const base = safeName ? (safeName.toLowerCase().endsWith(ext) ? safeName : safeName + ext) : `img-${Date.now()}${ext}`;
        const full = path.join(OUTBOX_DIR, base);
        fs.writeFileSync(full, buf);
        return {
          content: [
            {
              type: 'text',
              text: `已保存：${base}（${Math.round(buf.length / 1024)} KB，${img.mimeType}）\n发出去：qq_send_image(image="${base}", caption="...")；要看懂：qq_describe_image(file="${base}")`
            }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `保存图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

const OUTBOX_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

/** 待发文件夹里的图片文件名：扁平、无路径、按需补扩展名与序号。 */
function outboxImageName(name, ext, index, total) {
  const safe = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 60);
  if (safe) {
    const stem = safe.replace(/\.[a-z0-9]{1,6}$/i, '');
    return total > 1 ? `${stem}-${index + 1}${ext}` : `${stem}${ext}`;
  }
  return `msg-${Date.now()}${total > 1 ? `-${index + 1}` : ''}${ext}`;
}

// 待发文件夹（state/outbox/）对模型可见：主人往这里丢文件、她按文件名发出去。
// 以前这个文件夹只有运维知道路径，模型既看不到里面有什么、也不知道"主人放了一张图"。
if (cfg.socialV2?.tools?.listOutbox !== false) {
  server.tool(
    'qq_list_outbox',
    '看待发文件夹 qq-bridge/state/outbox/ 里现在有哪些图可以发（按最新在前）。主人说「发文件夹里的那张」「看看有什么图」，或你想把之前存过的截图/收藏图/自己画的图再发一次时用它。想发某一张就把它返回的文件名交给 qq_send_image(image="文件名")。只读，不改动文件。',
    {
      limit: z.number().int().min(1).max(50).optional().describe('最多列几张，默认 20'),
      all: z.boolean().optional().describe('是否连非图片文件也列出来（它们发不出去），默认 false')
    },
    async ({ limit, all }) => {
      try {
        let entries = [];
        try {
          entries = fs.readdirSync(OUTBOX_DIR, { withFileTypes: true });
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: `待发文件夹还不存在（${OUTBOX_DIR}）——里面还没有任何图片。可以用 qq_image_search 找图、qq_save_image 收藏、qq_web_screenshot 截图、qq_draw_image 自己画，或让主人直接往里放文件。`
              }
            ]
          };
        }
        const images = [];
        const others = [];
        let totalBytes = 0;
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          let stat;
          try {
            stat = fs.statSync(path.join(OUTBOX_DIR, entry.name));
          } catch {
            continue;
          }
          totalBytes += stat.size;
          const item = { name: entry.name, bytes: stat.size, mtime: stat.mtimeMs };
          if (OUTBOX_IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) images.push(item);
          else others.push(item);
        }
        if (!images.length && !others.length) {
          return { content: [{ type: 'text', text: '待发文件夹现在是空的。' }] };
        }
        images.sort((a, b) => b.mtime - a.mtime);
        others.sort((a, b) => b.mtime - a.mtime);
        const want = Math.min(limit || 20, 50);
        const fmt = (item) => `- ${item.name}（${Math.round(item.bytes / 1024)} KB，${new Date(item.mtime).toLocaleString('zh-CN', { hour12: false })}）`;
        const lines = [`待发文件夹（${OUTBOX_DIR}）里可发的图片：共 ${images.length} 张，合计 ${(totalBytes / 1024 / 1024).toFixed(1)} MB`];
        lines.push(...images.slice(0, want).map(fmt));
        if (images.length > want) lines.push(`（只列了最新 ${want} 张，还有 ${images.length - want} 张更旧的）`);
        if (all && others.length) {
          lines.push('', `其它文件（不是图片，qq_send_image 发不出去）：${others.length} 个`);
          lines.push(...others.slice(0, 10).map(fmt));
        }
        lines.push('', '发出去：qq_send_image(key="会话key", token="会话令牌", image="上面某个文件名", caption="一句话")');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `看待发文件夹失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 把「别人发的图」落盘成文件：QQ 的图片直链常带时效/缺参数，转发别人发的图靠链接不靠谱，
// 先存成 outbox 里的文件再按文件名发才是稳的。
if (cfg.socialV2?.tools?.saveMessageImage !== false) {
  server.tool(
    'qq_save_message_image',
    '把某条 QQ 消息里的图片/表情保存进待发文件夹（state/outbox/）并返回文件名——想转发别人发的图、或之后想再用同一张图，就用它：先存成文件，再 qq_send_image(image="文件名")。比拿 QQ 的图片链接可靠得多（那些 CDN 链接常带时效，过一会儿就下载失败）。',
    {
      key: z.string().optional().describe('会话 key，格式 group:群号 或 private:QQ号（不传时按 messageId 归属自动推断）'),
      messageId: z.union([z.number(), z.string()]).describe('要保存的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（见唤醒提示中的【会话令牌】）'),
      name: z.string().optional().describe('可选文件名（不含路径；不带扩展名会自动补），默认按消息 id 命名')
    },
    async ({ key, messageId, token, name }) => {
      try {
        const cred = fillAgentCredentials({ key, token, messageId });
        if (!cred.key) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 找不到归属会话，请显式提供 key（格式 group:群号 或 private:QQ号）` }], isError: true };
        }
        const q = new URLSearchParams({ key: cred.key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: cred.token ? { 'x-agent-token': cred.token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        const usable = images.filter((img) => img?.data && img?.mimeType);
        if (!usable.length) {
          return {
            content: [
              {
                type: 'text',
                text: `消息 ${messageId} 没有可保存的图片/表情：${images.length ? '图片取不回来（可能已过期或需要重新登录）' : data?.note || '该消息里没有图片'}`
              }
            ]
          };
        }
        fs.mkdirSync(OUTBOX_DIR, { recursive: true });
        const lines = [];
        usable.forEach((img, i) => {
          const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp' }[img.mimeType];
          if (!ext) {
            lines.push(`- 第 ${i + 1} 张类型不支持（${img.mimeType}），跳过了`);
            return;
          }
          const base = outboxImageName(name, ext, i, usable.length);
          const buf = Buffer.from(String(img.data), 'base64');
          fs.writeFileSync(path.join(OUTBOX_DIR, base), buf);
          lines.push(`- ${base}（${Math.round(buf.length / 1024)} KB，${img.kind === 'face' ? '表情' : '图片'}）`);
        });
        return {
          content: [
            { type: 'text', text: ['已保存到待发文件夹：', ...lines, '', '发出去：qq_send_image(key="会话key", token="会话令牌", image="文件名", caption="一句话")'].join('\n') }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `保存消息图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 自己画一张图：SVG/HTML → 无头 Chrome 渲染 → outbox。断网 + 去脚本（见 webshot.js 的口径）。
if (cfg.socialV2?.tools?.drawImage !== false) {
  server.tool(
    'qq_draw_image',
    '自己画一张图（SVG 或简单 HTML → PNG），存进待发文件夹，再用 qq_send_image 发出去。适合：写张字卡/小贺卡、画简单图形或配色块、把想说的话排成好看的图、给某件事配一张示意图。硬限制：① 只画自包含的内联内容——脚本、iframe、外链图片/CSS 会被剥掉，页面不许联网，所以画不了网页、也加载不了网图；② 默认 800 宽、高度自适应（最多 3000）；③ 这是「排版图/简笔涂鸦」，不是手绘、不是照片，别对主人吹成自己画的写实画。SVG 用 viewBox 控制比例，文字用 fill 上色。',
    {
      svg: z.string().optional().describe('SVG 标记（推荐：矢量，缩放不糊；与 html 二选一）'),
      html: z.string().optional().describe('HTML 片段（与 svg 二选一；外链资源会被拦掉）'),
      width: z.number().optional().describe('画布宽度，默认 800（64~2560）'),
      height: z.number().optional().describe('画布高度（64~4000）；不给就按内容高度自适应'),
      name: z.string().optional().describe('可选文件名（不含路径，会自动补 .png），默认 draw-<时间戳>.png')
    },
    async ({ svg, html, width, height, name }) => {
      try {
        const shot = await renderHtmlToImage({ svg, html, width, height, name });
        const lines = [
          `画好了：${shot.file}`,
          `- 尺寸：${shot.width}×${shot.height}（2 倍像素密度），${Math.round(shot.bytes / 1024)} KB`,
          `- 耗时：${(shot.ms / 1000).toFixed(1)} 秒（${shot.kind === 'svg' ? 'SVG' : 'HTML'} 渲染）`
        ];
        if (shot.stripped) lines.push(`- 已剥掉脚本/外链/内联事件 ${shot.stripped} 处（画图不联网、不跑脚本）`);
        lines.push(`- 发出去：qq_send_image(key="会话key", token="会话令牌", image="${shot.file}", caption="一句话")`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `画图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 用本机 ComfyUI 真画一张（文生图）。和 qq_draw_image 分工：那个是排版/字卡，
// 这个是插画/人/场景；后台任务（2026-10-29 起），画完自动把图发到会话里。
if (cfg.socialV2?.tools?.generateImage !== false) {
  server.tool(
    'qq_generate_image',
    '用本机 ComfyUI「真画」一张图（文生图：Animagine XL 4.0 / SDXL）。和 qq_draw_image 的分工：qq_draw_image 是排版/字卡/简笔（1 秒、字一定对）；这一件是画插画、画人、画场景（一张 1024² 约 25~45 秒）。**2026-10-29 起是后台任务**：调用立刻返回 queued=true 和 jobId，图在后台画，画好会**自动**作为图片发到这个会话——所以成功后先回对方一句「等我一下，画好给你看」，然后继续聊别的，不要原地等、也不要再调一次。若返回 busy=true，说明上一张还在画或正在唱歌（显卡被占），就告诉对方「我手上还画着一张，等这张出来」。prompt 用英文 Danbooru 标签效果最好（1girl, blue hair, whale tail, ...）；要画中文文字/字卡别用这件，用 qq_draw_image。**默认挂着她自己的 LoRA（xiaojing，0.8），所以画「她自己」时很像、蓝色调会偏重；画别人的样子或不想要这种质感时传 lora=false 用原模型。**',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      prompt: z.string().describe('画什么：英文 Danbooru 标签或英文描述，越具体越好（主体、动作、构图、光线、风格）'),
      style: z.enum(['anime', 'anime-sd15', 'realistic']).optional().describe('画风，默认 anime（二次元）；anime-sd15 省显存但尺寸小；realistic 写实'),
      aspect: z.enum(['square', 'portrait', 'landscape']).optional().describe('构图，默认 square（1024×1024）；portrait 竖图 832×1216、landscape 横图 1216×832'),
      seed: z.number().optional().describe('随机种子：想复刻上一张构图就传同一个 seed'),
      steps: z.number().optional().describe('采样步数 8~40（默认 28，越大越细也越慢）'),
      caption: z.string().optional().describe('和图片一起发出去的一句话说明（可空）'),
      lora: z.union([z.boolean(), z.string()]).optional().describe('默认挂她自己的 LoRA；传 false 用原模型（画别人/不想要这份质感时），也可传具体文件名'),
      loraWeight: z.number().optional().describe('LoRA 强度 0~1.5（默认 0.8）。接上 lora=false 时无效'),
      onImage: z.union([z.string(), z.array(z.string())]).optional().describe('要直接叠在图片上的字（做梗图/表情包用）：一句话最好，最多两句；不填就发原图。和 caption 不同——caption 是图下面的说明文字，onImage 是画在图里的气泡'),
      onImageStyle: z.enum(['bubble', 'band', 'sticker']).optional().describe('叠字的样式：bubble 白气泡（默认）、band 底部黑字幕条、sticker 黄色贴纸')
    },
    async ({ key, token, prompt, style, aspect, seed, steps, caption, lora, loraWeight, onImage, onImageStyle }) => {
      try {
        const data = await agentApi('/api/socialV2/generate-image', {
          method: 'POST',
          body: JSON.stringify({
            key,
            token,
            prompt,
            ...(style ? { style } : {}),
            ...(aspect ? { aspect } : {}),
            ...(seed !== undefined ? { seed } : {}),
            ...(steps !== undefined ? { steps } : {}),
            ...(caption ? { caption } : {}),
            ...(lora !== undefined ? { lora } : {}),
            ...(loraWeight !== undefined ? { loraWeight } : {}),
            ...(onImage ? { onImage } : {}),
            ...(onImageStyle ? { onImageStyle } : {})
          }),
          headers: { 'x-agent-token': token },
          // 路由立刻回 202，这里只要等它把任务排上；30 秒是防桥接假死把这一轮拖死。
          timeoutMs: 30000
        });
        if (data?.queued) {
          return {
            content: [{
              type: 'text',
              text: `已排上（jobId=${data.jobId}，${data.style} / ${data.aspect}，${data.lora ? `LoRA ${data.lora}@${data.loraWeight}` : '原模型'}${data.onImage?.length ? `，图里叠字「${data.onImage.join(' / ')}」（${data.onImageStyle}）` : ''}，显存空闲 ${data.freeVramMb ?? '未知'} MB）。图在后台画，第一张要先加载模型，约 25~90 秒，画好会**自动**作为图片发到这个会话——现在先回对方一句「等我一下，画好给你看」，然后该聊什么聊什么；不要在这里等，也不要再调一次。`
            }]
          };
        }
        if (data?.busy) {
          return { content: [{ type: 'text', text: `这会儿画不了：${data.error || '显卡被占着（上一张还在画或在唱歌）'}。等它结束再画。` }] };
        }
        return { content: [{ type: 'text', text: `没排上：${data?.error || '桥接没有返回原因'}` }], isError: true };
      } catch (error) {
        return { content: [{ type: 'text', text: `画图请求失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_image_search',
  '按关键词搜一批可直接发送的网络图片地址（必应图库，无需登录）。想主动分享好看的图（晚霞、小猫、风景壁纸、搞笑图、美食图）时用：先搜出一批地址，挑一张，再用 qq_send_image(image="<地址>", caption="一句话") 发出去。建议发之前先 qq_describe_image(url="<地址>") 看一眼内容是否合适；别发政治敏感、猎奇、带水印广告的图。',
  {
    query: z.string().describe('搜索关键词，例如「晚霞」「小猫」「风景壁纸」「搞笑表情」'),
    count: z.number().int().min(1).max(12).optional().describe('返回几张候选，默认 6')
  },
  async ({ query, count }) => {
    try {
      const want = count || 6;
      const target = `https://www.bing.com/images/async?q=${encodeURIComponent(String(query))}&first=1&count=${Math.max(want * 3, 20)}&mmasync=1&form=IRFLTR`;
      const res = await fetch(target, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          accept: 'text/html,application/xhtml+xml'
        },
        signal: AbortSignal.timeout(25000)
      });
      if (!res.ok) throw new Error(`必应返回 HTTP ${res.status}`);
      const html = await res.text();
      const urls = [];
      const seen = new Set();
      const re = /murl&quot;:&quot;(https?:\/\/[^&"]+)&quot;/g;
      let m;
      while ((m = re.exec(html))) {
        const u = m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
        if (!/\.(jpe?g|png|webp)(\?|$)/i.test(u)) continue;
        if (seen.has(u)) continue;
        seen.add(u);
        urls.push(u);
        if (urls.length >= want) break;
      }
      if (!urls.length) throw new Error('没有解析到图片地址（可能被必应限流，稍后再试或换个关键词）');
      const lines = [`「${query}」找到 ${urls.length} 张候选：`, ...urls.map((u, i) => `${i + 1}. ${u}`), '', '挑一张：qq_send_image(image="<地址>", caption="一句话")；发之前建议 qq_describe_image(url="<地址>") 看一眼内容。'];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `搜图失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音。两种用法**二选一**：① text = 这句话当场用本机 TTS 合成成语音（想说「晚安」「我想你了」这类短句时用它，不用先准备音频文件，≤200 字）；② voice = 语音库里准备好的音频文件（qq_list_voices 返回的 name）。注意：① 语音只能是本机合成的短句或语音库（qq-bridge/audio/）里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可，别每条都用语音；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      text: z.string().optional().describe('想当场说出来的话（本机 TTS 合成成语音发出去）；与 voice 二选一'),
      voice: z.string().optional().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）；与 text 二选一'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, text, voice, label, verify, readback }) => {
      const speakText = String(text ?? '').trim();
      const voiceRef = String(voice ?? '').trim();
      if (!speakText && !voiceRef) {
        return { content: [{ type: 'text', text: '要么给 text（让我当场说这句话），要么给 voice（发语音库里那个文件）—— 两个都没给。' }], isError: true };
      }
      if (speakText && voiceRef) {
        return { content: [{ type: 'text', text: 'text 与 voice 只能给一个：要么当场合成，要么发语音库里的文件。' }], isError: true };
      }
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            ...(speakText ? { text: speakText } : { voice: voiceRef }),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sing !== false) {
  server.tool(
    'qq_sing',
    '唱一首歌并发到指定会话（本机 ACE-Step 生成曲子 + Seed-VC 换成你自己的音色）。只有 lyrics 是必填：把你想要的歌词按行写进去（每行一句、押韵更好听）。可选 tags 描述风格（如 "chinese pop, female vocal, gentle, acoustic guitar"）、duration 决定时长（秒，8~60，默认 20）、vc 决定要不要换成你自己的音色（默认 true；改成 false 就是别的女声在唱）。**2026-10-26 起是后台任务**：调用会立刻返回 ok=true、queued=true 和 jobId，歌在后台生成（约 1~5 分钟），做好会自动作为语音发到这个会话——所以调用成功后先回一句「等我几分钟，唱好就发给你」，然后继续聊别的，**不要原地等、也不要再调一次**。若返回 busy=true，说明上一首还在做，就告诉对方「上一首还在做，等它唱完再来一首」。注意：① 生成很吃内存/显存——bridge 会先停掉真人音色服务、卸载 Ollama 模型，这几分钟里你可能没法用语音说话，属正常；② 真发成功的证据是桥接日志里的「已发出 messageId=…」，工具返回的 queued 只代表排上了；③ 这是「表演」型动作，别频繁用，一次最多一首；④ 歌词要自己写（原创或即兴），不要照抄完整受版权保护的歌词。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      lyrics: z.string().describe('歌词：每行一句，用换行分隔（最多 1200 字）'),
      tags: z.string().optional().describe('风格描述，英文逗号分隔，如 chinese pop, female vocal, warm, acoustic guitar'),
      duration: z.number().optional().describe('时长（秒），8~60，默认 20；歌词多就长一点'),
      vc: z.boolean().optional().describe('是否用 Seed-VC 换成你自己的音色（默认 true）'),
      steps: z.number().optional().describe('扩散步数（8~40，默认 20）；越大越细腻也越慢')
    },
    async ({ key, token, lyrics, tags, duration, vc, steps }) => {
      try {
        const data = await agentApi('/api/socialV2/sing', {
          method: 'POST',
          body: JSON.stringify({
            key,
            token,
            lyrics,
            ...(tags ? { tags } : {}),
            ...(duration !== undefined ? { duration } : {}),
            ...(steps !== undefined ? { steps } : {}),
            vc: vc !== false
          }),
          headers: { 'x-agent-token': token },
          // 路由现在立刻回 202（生成在后台跑），所以这里不用再等 10 分钟；给 30 秒只是
          // 防止桥接本身假死时把这一轮又拖住（13:44 那次就是等 16 分钟等到超时的）。
          timeoutMs: 30000
        });
        if (data?.queued) {
          return {
            content: [{
              type: 'text',
              text: `已排上（jobId=${data.jobId}，空闲内存 ${data.freeMb} MB）。歌在后台生成，大约 1~5 分钟，做好会**自动**作为语音发到这个会话——现在先回对方一句「等我几分钟，唱好就发给你」，然后该聊什么聊什么；不要在这里等，也不要再调一次。`
            }]
          };
        }
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `唱歌没排上：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  // 曲库：提前存好的几首成品，按情景秒发（不用等 1~5 分钟生成）。
  server.tool(
    'qq_sing_send',
    '从曲库发一首**已经唱好**的歌——秒发，不用等生成。曲库是提前录好的几首，按情景分了 mood：happy 开心 / soothe 安慰 / sleep 哄睡 / birthday 生日 / miss 想他 / playful 调皮 / cheer 打气 / sorry 道歉。只给 moods 就会挑一首合适的（最近发过的会被避开），也可以给 id 点名要某一首。**可以点名发到别处**：给 target（比如群 851489980，或 private:3482501440），不给就发到当前这个会话；只能发到白名单里的人或群。调用返回 ok=true 就代表**已经发出**了（带 messageId），所以不用再说「等我几分钟」，发完接着聊即可。如果返回曲库是空的（409），说明还没预生成，那时才用 qq_sing 现场唱。',
    {
      key: z.string().describe('你此刻所在的会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      moods: z.array(z.string()).optional().describe('情景标签，可多个：happy/soothe/sleep/birthday/miss/playful/cheer/sorry。不给就随机挑一首'),
      id: z.string().optional().describe('点名要某一首（曲库 id，比如 sleep-lullaby）；给了就不按 moods 挑'),
      target: z.string().optional().describe('发到哪儿：留空=当前这个会话；也可以 group:群号 / 群 851489980 / private:3482501440 / 私聊 3482501440。只能在白名单里，发别处会被拒')
    },
    async ({ key, token, moods, id, target }) => {
      try {
        const data = await agentApi('/api/socialV2/song-library/send', {
          method: 'POST',
          body: JSON.stringify({ key, token, ...(target ? { target } : {}), ...(Array.isArray(moods) && moods.length ? { moods } : {}), ...(id ? { id } : {}) }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        if (data?.ok) {
          const moodText = (data.moods ?? []).join('/') || '没标';
          const where = data.target && data.target !== key ? `发到了 ${data.target}` : '就在这个会话里';
          return {
            content: [{
              type: 'text',
              text: `已经发出去了：《${data.title}》（${data.id}，${moodText}，${where}，${data.messageId ? `messageId=${data.messageId}` : '没拿到 messageId'}${data.verified ? '，回读确认是真的语音' : ''}）。这是提前唱好的成品，对方听到的是完整的歌，不用再等生成。`
            }]
          };
        }
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `从曲库发歌失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

return server;
}

// 被 src/mcp-http-host.js 导入时只导出工厂（由宿主按请求构建）；直接运行则保持原 stdio 行为，
// 旧的 stdio 配置仍可用（回滚路径）。这里刻意不用 import.meta 判断主模块：
// mcp-web-search-safe.js 的离线测试会把文件塞进 vm 上下文执行，那里没有 import.meta，
// 三个文件统一用宿主哨兵，口径一致。
//
// 另外刻意不写 `await`：离线测试（scripts/test-audit-security-mcp.mjs）用 vm.runInNewContext
// 执行本文件，那不是一个 async 上下文，顶层 await 会直接语法报错。Promise.resolve(...)
// 既兼容真实 connect() 返回的 Promise，也兼容假 server 的 undefined 返回。
if (!globalThis.__QQ_MCP_HTTP_HOST__) {
  Promise.resolve(buildServer().connect(new StdioServerTransport())).catch((error) => {
    process.stderr.write(`snowluma MCP stdio 启动失败：${error?.message ?? error}\n`);
    process.exit(1);
  });
}
