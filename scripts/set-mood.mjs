#!/usr/bin/env node
// 手动校准她的状态维度：心情(mood) / 精力(energy) / 委屈(irritation) / 社交意愿(social)。
//
// 为什么必须走桥接而不是改文件：
//   状态活在**运行中的桥接进程内存里**，state/persona-state.json 只是它的影子。拿编辑器
//   直接改那个文件，会在下一次事件（decay + save）时被内存里的旧值原样盖回去 ——
//   看起来就像「改了没用」。所以这里走 POST /api/socialV2/mood，由持有状态的进程改，
//   改完立刻落盘。
//
// 用法（在 qq-bridge 目录下执行）：
//   node scripts/set-mood.mjs                       # 只看现在什么状态（不改）
//   node scripts/set-mood.mjs energy=0.7            # 把精力调到 0.7
//   node scripts/set-mood.mjs mood=0.8 energy=0.9 --reason 手动补
//   node scripts/set-mood.mjs --json                # 只吐 JSON（给脚本用）
//
// 维度是**绝对值**（不是增量），会 clamp 到 0~1。精力门槛：主动开口要 energy ≥ 0.25。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// ── 参数解析 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags.set(k, v);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { flags.set(k, argv[++i]); }
    else flags.set(k, true);
  } else positional.push(a);
}
const has = (k) => flags.has(k);
const val = (k, d = undefined) => (flags.has(k) ? (flags.get(k) === true ? '' : String(flags.get(k))) : d);

function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}
function readConsoleTokenFile() {
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const cfg = loadConfig();
const consolePort = Number(val('port', cfg.consolePort)) || 3100;
const consoleToken = String(
  val('console-token', cfg.consoleToken || process.env.QQ_CONSOLE_TOKEN || readConsoleTokenFile() || '')
).trim();
const reason = String(val('reason', ''));
const asJson = has('json');
const quiet = has('q') || has('quiet');

const fail = (msg, code = 1) => { console.error(`❌ ${msg}`); process.exit(code); };

// 位置参数里 dim=value 形式就是要改的维度（数值非法留给桥接去报错，这里只挑形状）。
const wanted = {};
for (const item of positional) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(item);
  if (!m) fail(`看不懂这个参数：${item}（要写成 energy=0.7 这样）`);
  wanted[m[1]] = m[2];
}

async function bridgeApi(pathname, init = {}) {
  const res = await fetch(`http://127.0.0.1:${consolePort}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
      ...(init.headers ?? {})
    },
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const pct = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n ?? '?'));
const DIM_LABEL = { mood: '心情', energy: '精力', irritation: '委屈', social: '社交意愿' };

function printState(snapshot, { title = '她此刻的状态' } = {}) {
  const dims = snapshot?.dims ?? {};
  console.log(`\n${title}`);
  for (const [dim, value] of Object.entries(dims)) {
    console.log(`  ${String(DIM_LABEL[dim] ?? dim).padEnd(6)} ${pct(value)}`);
  }
  const pro = snapshot?.proactive;
  if (pro) console.log(`  主动开口  ${pro.allow ? '✅ 允许' : '⛔ 拦下'}：${pro.reason}`);
  if (snapshot?.summary) console.log(`  提示词里的一句话：${snapshot.summary.replace(/^【此刻的心情】/, '')}`);
  console.log('');
}

try {
  if (!Object.keys(wanted).length) {
    const body = await bridgeApi('/api/socialV2/mood');
    if (asJson) { console.log(JSON.stringify(body, null, 2)); process.exit(0); }
    if (!quiet) printState(body);
    else console.log(`${Object.entries(body.dims ?? {}).map(([k, v]) => `${k}=${pct(v)}`).join(' ')}`);
    process.exit(0);
  }

  const body = await bridgeApi('/api/socialV2/mood', {
    method: 'POST',
    body: JSON.stringify({ dims: wanted, reason })
  });
  if (asJson) { console.log(JSON.stringify(body, null, 2)); process.exit(0); }
  if (!quiet) {
    console.log(`✅ 已改：${(body.applied ?? []).map((a) => `${DIM_LABEL[a.dim] ?? a.dim}=${pct(a.value)}`).join('、')}`);
    if (body.failed?.length) console.log(`⚠️ 没改成功：${body.failed.map((f) => `${f.dim}（${f.error}）`).join('、')}`);
    printState(body, { title: '改完之后' });
  } else {
    console.log(JSON.stringify(body));
  }
} catch (error) {
  const hint = error?.status === 401
    ? '（控制台令牌不对：config.consoleToken 或 state/console-token）'
    : (error?.cause?.code === 'ECONNREFUSED' ? `（桥接没在 ${consolePort} 上跑？）` : '');
  fail(`改状态失败：${error?.message ?? error}${hint}`);
}