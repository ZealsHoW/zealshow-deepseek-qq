// 自检：常驻 MCP over Streamable HTTP（src/mcp-http-host.js）端到端验证。
//
// 用法：node scripts/test-mcp-http-host.mjs
//
// 起一个隔离端口（默认 3219，不碰生产端口 3210），依次验证：
//   /health、无效 token → 401、未知路径 → 404、GET → 405，
//   三个端点的 initialize + tools/list（工具数量下限），
//   以及两个只读 tools/call（snowluma_status 走 OneBot 探活、qq_status 走 bridge agentApi）。
// 跑完杀掉子进程。要求 bridge 与 SnowLuma 正在运行（qq_status 会去问 bridge）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_MCP_PORT || 3219);
const BASE = `http://127.0.0.1:${PORT}`;

function readConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = readConfig();
const TOKEN = cfg.mcp?.httpToken;
if (!TOKEN) {
  console.error('FAIL: config.json 缺 mcp.httpToken（先跑 node scripts/setup-dsh.mjs）');
  process.exit(1);
}

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

async function rpc(endpoint, method, params, { id = 1, token = TOKEN } = {}) {
  const res = await fetch(`${BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-mcp-token': token
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, text };
}

const child = spawn(process.execPath, [path.join(ROOT, 'src', 'mcp-http-host.js')], {
  cwd: ROOT,
  env: { ...process.env, QQ_MCP_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (d) => process.stdout.write(`  [host] ${d}`));
child.stderr.on('data', (d) => process.stdout.write(`  [host!] ${d}`));

async function waitHealthy(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

try {
  console.log('== 常驻 MCP over Streamable HTTP 自检 ==');
  const health = await waitHealthy();
  check('GET /health', !!health?.ok, health ? `service=${health.service} pid=${health.pid}` : '超时');
  if (!health) throw new Error('host 未就绪');

  check('无效 token → 401', (await rpc('/snowluma/mcp', 'tools/list', {}, { token: 'wrong-token' })).status === 401);
  check('未知路径 → 404', (await fetch(`${BASE}/nope`)).status === 404);
  check('GET 端点 → 405', (await fetch(`${BASE}/snowluma/mcp`, { headers: { 'x-mcp-token': TOKEN } })).status === 405);

  const endpoints = [['/snowluma/mcp', 40], ['/host/mcp', 1], ['/websearch/mcp', 2]];
  for (const [endpoint, minTools] of endpoints) {
    const init = await rpc(endpoint, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'qq-bridge-selftest', version: '1.0.0' }
    });
    const serverName = init.json?.result?.serverInfo?.name ?? '?';
    check(`${endpoint} initialize`, init.status === 200 && !!init.json?.result?.serverInfo, `server=${serverName} status=${init.status}`);

    const list = await rpc(endpoint, 'tools/list', {}, { id: 2 });
    const names = list.json?.result?.tools?.map((t) => t.name) ?? [];
    check(`${endpoint} tools/list ≥ ${minTools}`, names.length >= minTools, `${names.length} 个工具`);

    if (endpoint === '/host/mcp') {
      const call = await rpc(endpoint, 'tools/call', { name: 'snowluma_status', arguments: {} }, { id: 3 });
      const text = call.json?.result?.content?.[0]?.text ?? '';
      check('只读调用 snowluma_status', call.status === 200 && text.includes('reachable'), text.slice(0, 120).replace(/\s+/g, ' '));
    }
    if (endpoint === '/snowluma/mcp') {
      const call = await rpc(endpoint, 'tools/call', { name: 'qq_status', arguments: {} }, { id: 4 });
      const text = call.json?.result?.content?.[0]?.text ?? '';
      check('只读调用 qq_status（经 bridge agentApi）', call.status === 200, text.slice(0, 140).replace(/\s+/g, ' '));
    }
  }
} catch (error) {
  fail += 1;
  console.log(`  FAIL 异常：${error?.message ?? error}`);
} finally {
  try { child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  try { child.kill('SIGKILL'); } catch {}
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}