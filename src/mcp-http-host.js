// 哨兵必须在三个 server 模块之前 import（见 mcp-http-mode.js 的说明），所以它必须排在第一行。
import './mcp-http-mode.js';
// QQ 能力工具面：**常驻** MCP over Streamable HTTP（TCP），不再由 DSH 以 stdio 方式 spawn。
//
// 为什么改（2026-10-21，用户指令：QQ 相关能力脱离 DSH 进程组独立常驻）：
//   DSH 用 stdio 启动 MCP 时，那个子进程属于 DSH 的 Windows 作业对象 —— DSH 重启/崩溃会把
//   它一起杀掉（历史上 01:02 / 01:21 两次都这样，工具面整体消失）。改成独立常驻进程 +
//   TCP（Streamable HTTP）后：进程由看门狗（计划任务，svchost 之下）保活，不在 DSH 作业对象里；
//   DSH 只是它的一个 HTTP 客户端，自己重启不再连坐，断了由 MCP SDK 的重连策略接管。
//
// 端点（只绑 127.0.0.1，绝不对外监听）：
//   POST /snowluma/mcp    —— QQ 会话工具（mcp-snowluma-safe.js，注册期按 config 过滤开关）
//   POST /host/mcp        —— SnowLuma 网关只读探活（mcp-host-server.js）
//   POST /websearch/mcp   —— 只读联网搜索 / 网页抓取（mcp-web-search-safe.js）
//   GET  /health          —— 探活（看门狗用）
//
// 鉴权：请求头 `x-mcp-token` 必须等于 config.json → mcp.httpToken。
//   这些工具能让模型真的以机器人身份往外发消息，所以除了绑环回再加一道共享密钥。
//   DSH 侧在 profile 的 cordis.patch.yml 里带上同一个值（由 scripts/setup-dsh.mjs 写入）。
//
// 传输约定（无状态，刻意如此）：
//   sessionIdGenerator: undefined + enableJsonResponse: true —— 每个请求新建 McpServer +
//   StreamableHTTPServerTransport，响应结束即关闭；不需要会话表，DSH 重启/重连也没有残留
//   会话要清理。服务器工厂本身无状态（工具实现不使用进程级会话环境，agent 令牌由每次调用
//   显式传入，配置与 console-token 每次请求现读），所以一个进程可以安全服务任意多请求。
//   非 POST 一律 405：无状态模式既没有 SSE 长连接，也没有显式 DELETE 会话。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer as buildSnowlumaServer } from './mcp-snowluma-safe.js';
import { buildServer as buildHostServer } from './mcp-host-server.js';
import { buildServer as buildWebSearchServer } from './mcp-web-search-safe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const VERSION = '0.1.0';

// 请求体上限：工具调用本身很小，但 qq_send_image / qq_collect_sticker 之类可以带 base64。
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const ENDPOINTS = new Map([
  ['/snowluma/mcp', { name: 'snowluma', build: buildSnowlumaServer }],
  ['/host/mcp', { name: 'snowluma-host', build: buildHostServer }],
  ['/websearch/mcp', { name: 'web-search-safe', build: buildWebSearchServer }],
]);

function readConfig() {
  try {
    let text = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function tokenMatches(expected, received) {
  if (!expected) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(received ?? ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    sendJson(res, 400, { error: 'bad url' });
    return;
  }

  if (url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'qq-mcp-http',
      version: VERSION,
      pid: process.pid,
      endpoints: [...ENDPOINTS.keys()],
      ts: Date.now()
    });
    return;
  }

  const endpoint = ENDPOINTS.get(url.pathname);
  if (!endpoint) {
    sendJson(res, 404, { error: 'not found', endpoints: [...ENDPOINTS.keys()] });
    return;
  }

  const cfg = readConfig();
  const expected = cfg.mcp?.httpToken;
  if (!expected) {
    sendJson(res, 503, {
      error: 'config.json 缺少 mcp.httpToken，拒绝服务（运行 node scripts/setup-dsh.mjs 生成）'
    });
    return;
  }
  if (!tokenMatches(expected, req.headers['x-mcp-token'])) {
    sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'x-mcp-token 无效' }, id: null });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed：无状态模式只接受 POST' },
      id: null
    });
    return;
  }

  let body;
  try {
    const raw = await readBody(req);
    body = raw.length ? JSON.parse(raw.toString('utf8')) : undefined;
  } catch (error) {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: `Parse error: ${error?.message ?? error}` },
      id: null
    });
    return;
  }

  let mcp;
  let transport;
  try {
    mcp = endpoint.build();
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      try { transport?.close(); } catch {}
      try { mcp?.close(); } catch {}
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal error: ${error?.message ?? error}` },
        id: null
      });
    } else {
      try { res.end(); } catch {}
    }
    try { transport?.close(); } catch {}
    try { mcp?.close(); } catch {}
  }
});

// qq_wait_for_messages 最长要挂 725s（DSH 侧 toolCallTimeoutMs=725000），
// 而 node:http 的 requestTimeout 默认 300s —— 不改就会在第 5 分钟被 408 掐断。
server.requestTimeout = 0;
server.headersTimeout = 0;
server.on('clientError', (_error, socket) => {
  try { socket.destroy(); } catch {}
});

const port = Number(process.env.QQ_MCP_PORT || readConfig().mcp?.httpPort || 3210);

server.on('error', (error) => {
  process.stderr.write(`[qq-mcp-http] 监听失败：${error?.message ?? error}\n`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(
    `[qq-mcp-http] listening http://127.0.0.1:${port}`
    + ` endpoints=${[...ENDPOINTS.keys()].join(',')} pid=${process.pid}\n`
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdout.write(`[qq-mcp-http] 收到 ${signal}，退出\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}