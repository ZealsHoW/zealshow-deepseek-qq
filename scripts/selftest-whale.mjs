#!/usr/bin/env node
// 小鲸鱼能力自测：把主人点名要测的每项能力跑一遍，逐项给出 PASS / FAIL / SKIP 和证据。
//
// 用法（在 qq-bridge 目录下执行）：
//   node scripts/selftest-whale.mjs                  # 离线回归 + 只读探测（不往 QQ 发任何东西）
//   node scripts/selftest-whale.mjs --live           # 额外实发：只发给**主人自己的私聊** + 仅自己可见的说说
//   node scripts/selftest-whale.mjs --no-tests       # 跳过回归脚本，只跑探测/实发
//   node scripts/selftest-whale.mjs --douyin=<url>   # 指定用来测「读取抖音链接」的真实链接
//
// 两条硬规矩（别改）：
//   1) 实发**只允许**发到 config.json 里的 ownerQQ（主人自己），以及 visibility=self 的空间说说；
//      群聊默认不发 —— 除非存在一个名字带「测试」的专用群，那才往里发（家庭群绝不打扰）。
//   2) 这里不写死任何真实号码/链接：全部从 config.json / state 读，或由命令行传入。
//
// 为什么要有它：能力是「散在工具面 + 配置开关 + 发送链路」三处的，单看任一处都判断不了
// 「她现在到底还能不能发图/发语音/刷抖音」。这份自测把三者串起来，输出一张能复跑的体检表。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const RUN_TESTS = !args.includes('--no-tests');
const DOUYIN = (args.find((a) => a.startsWith('--douyin=')) ?? '').slice('--douyin='.length);

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const OWNER = String(cfg.ownerQQ ?? '').trim();
const OKEY = `private:${OWNER}`;
const socialV2 = cfg.socialV2 ?? {};

// ── 她的会话令牌：模型侧工具要它，才认得出「这次唤醒是哪个会话」 ───────────────
function agentTokenOf(key) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
    return String(st.conversations?.[key]?.agentToken ?? '').trim();
  } catch { return ''; }
}
const OTOK = agentTokenOf(OKEY);

// ── MCP 调用：宿主固定监听 127.0.0.1:3210，路径 /snowluma/mcp ────────────────
const MCP_HOST = process.env.QQ_MCP_URL ?? 'http://127.0.0.1:3210/snowluma/mcp';
const MCP_TOKEN = String(cfg.mcp?.httpToken ?? '');

async function call(name, params = {}, timeoutMs = 90_000) {
  const r = await fetch(MCP_HOST, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-mcp-token': MCP_TOKEN
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: params } }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await r.text();
  const clean = raw.replace(/^data:\s*/gm, '').trim();
  let j;
  try { j = JSON.parse(clean); } catch { throw new Error(`响应不是 JSON：${raw.slice(0, 200)}`); }
  if (j.error) throw new Error(`MCP 错误：${JSON.stringify(j.error).slice(0, 200)}`);
  const text = j.result?.content?.[0]?.text ?? '';
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  return { value, isError: Boolean(j.result?.isError), text };
}

const short = (s, n = 150) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  return (t ?? '').replace(/\s+/g, ' ').slice(0, n);
};

// 发送类工具的成功判定：必须显式 ok===true。
// （踩过一次：工具返回的是错误字符串时 `r.value?.ok !== false` 恒真，把“发送失败：必须携带 agent token”判成了 PASS。）
const sentOk = (value) => Boolean(value && typeof value === 'object' && value.ok === true);

const results = [];
function record(item, status, evidence) { results.push({ item, status, evidence }); }

// ══ Part A：离线回归（每个能力都有对应的回归脚本） ══════════════════════════
function runRegressionSuites() {
  if (!RUN_TESTS) return;
  // 这些脚本要跑起来才认；环境缺依赖（浏览器的 Playwright）不算能力坏了。
  const ENV_SKIP = new Map([
    ['test-console-ui.mjs', '需要 Playwright（本机未安装）'],
    ['test-dsh-v2-wait.mjs',
      'DSH 侧集成用例：要一次**独立的** DSH 回复，且会话工具清单里要有 qq_wait_for_messages。' +
      '本机实测单独跑 15s 结束但 HAS_qq_wait_for_messages=false；跑自测时机器正被当前会话占用，' +
      '必然吃满 120s 超时。属 DSH 侧待查，不是 QQ 能力缺失（见 README 的「已知限制」）。']
  ]);
  // 时序/会话敏感的一次性用例：失败**重试一次**，两次都失败才算真失败。
  const RETRY_ONCE = new Set(['test-reply-wait.mjs']);
  const all = fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((f) => /^test-.*\.mjs$/.test(f)).sort();
  for (const f of all) {
    if (ENV_SKIP.has(f)) { record(`回归：${f}`, 'SKIP', ENV_SKIP.get(f)); continue; }
    const once = () => {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [path.join('scripts', f)], {
        cwd: ROOT, encoding: 'utf8', timeout: 300_000, windowsHide: true
      });
      const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n').filter((l) => /FAIL|Error|✗/.test(l)).slice(0, 2).join(' | ');
      return { ok: r.status === 0, ms: Date.now() - t0, tail };
    };
    let run = once();
    let retried = false;
    if (!run.ok && RETRY_ONCE.has(f)) { retried = true; run = once(); }
    if (run.ok) { record(`回归：${f}`, 'PASS', `${run.ms}ms${retried ? '（重试后通过）' : ''}`); continue; }
    record(`回归：${f}`, 'FAIL', `${run.ms}ms${retried ? '（重试后仍失败）' : ''} ${short(run.tail, 150)}`);
  }
}

// ══ Part B：逐项探测 / 实发 ═════════════════════════════════════════════════
async function checkNightSleep() {
  const nr = socialV2.nightRitual ?? {};
  const r = await call('qq_night_sleep', { action: 'status', token: OTOK });
  const v = r.value ?? {};
  const ok = v.ok === true && typeof v.zzzText === 'string';
  record('① 到点说晚安休息', ok ? 'PASS' : 'FAIL',
    `休眠态 active=${v.active} remaining=${v.remainingMinutes}min zzz="${v.zzzText}"；晚安词 ${(nr.keywords ?? []).length} 个、家人 ${(nr.parents ?? []).length} 位、窗口 ${Math.round((nr.windowMs ?? 0) / 60000)}min`);
}

async function checkProactive() {
  const p = socialV2.proactive ?? {};
  // 桥接日志里能看到「已安排主动机会检查 <会话>」，这是主动机制真的在排队的直接证据
  let queuedPrivate = false;
  let queuedGroup = false;
  let sample = '';
  try {
    const log = fs.readFileSync(path.join(ROOT, 'state', 'bridge.log'), 'utf8');
    const lines = log.split('\n').filter((l) => l.includes('已安排主动机会检查')).slice(-40);
    queuedPrivate = lines.some((l) => /private:\d+/.test(l));
    queuedGroup = lines.some((l) => /group:\d+/.test(l));
    sample = (lines.slice(-1)[0] ?? '').trim();
  } catch { /* 日志不存在就算了 */ }
  record('② 自动在私信发消息（排队）', p.enabled && queuedPrivate ? 'PASS' : 'FAIL',
    `proactive.enabled=${p.enabled} 间隔 ${Math.round((p.checkIntervalMinMs ?? 0) / 60000)}~${Math.round((p.checkIntervalMaxMs ?? 0) / 60000)}min；日志：${short(sample, 100)}`);
  record('② 自动在群里发消息（排队）', p.enabled && queuedGroup ? 'PASS' : 'SKIP',
    queuedGroup ? '日志里排到过群会话' : '最近 40 条排队记录里没有群会话（群里发不发还看白名单与主动门）');

  // 群发实发：白名单里**只有专用测试群**才发。家庭群绝不打扰（这是硬规矩）。
  const allowedGroups = Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [];
  const groupNames = allowedGroups.map((g) => String((g && typeof g === 'object' ? g.name : '') ?? ''));
  const testGroup = allowedGroups.find((g, i) => /测试/.test(groupNames[i]));
  if (!LIVE) { record('② 群发实发', 'SKIP', '没加 --live'); return; }
  if (!testGroup) {
    record('② 群发实发', 'SKIP',
      `白名单里 ${allowedGroups.length} 个群、没有名字带「测试」的专用群 —— 家庭群不打扰，故不实发`);
    return;
  }
  const gid = String(testGroup && typeof testGroup === 'object' ? (testGroup.id ?? testGroup.groupId) : testGroup);
  const gtok = agentTokenOf(`group:${gid}`);
  const r = await call('qq_send_group_message', { groupId: gid, message: '【自测】群聊发送链路检查（自动生成，可忽略）', token: gtok });
  record('② 群发实发', sentOk(r.value) ? 'PASS' : 'FAIL', `群 ${short(groupNames[allowedGroups.indexOf(testGroup)], 20)}(${gid}) → ${short(r.value, 120)}`);
}

async function checkReply() {
  // 引用回复：私聊消息在会话状态里**没有 messageId**（只有群消息有），而唯一的白名单群是家庭群 ——
  // 所以引用回复不实发（往家里发一条测试回复才是真的打扰）。回复链路由回归脚本 test-reply-wait.mjs 覆盖。
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
  const conv = st.conversations?.[OKEY] ?? {};
  const recent = Array.isArray(conv.recentMessages) ? conv.recentMessages : [];
  const withId = recent.filter((m) => m.messageId).length;
  record('③ 回复（引用回复）', 'SKIP',
    `私聊最近 ${recent.length} 条里带 messageId 的 ${withId} 条（私聊本就没有）⇒ 不实发；链路见回归 test-reply-wait.mjs`);
  const ar = Number(socialV2.autoReplyCheckMs ?? 0);
  record('③ 自动回复（休眠中 zzz / 自动回）', ar > 0 && (socialV2.nightRitual?.zzzText ? true : false) ? 'PASS' : 'FAIL',
    `autoReplyCheckMs=${ar}ms；休眠自动回文案="${socialV2.nightRitual?.zzzText ?? '(未配)'}"`);
}

async function checkBrowse() {
  const b = socialV2.browse ?? {};
  let hit = '';
  try {
    const log = fs.readFileSync(path.join(ROOT, 'state', 'bridge.log'), 'utf8');
    hit = (log.split('\n').filter((l) => /刷|browse/i.test(l)).slice(-1)[0] ?? '').trim();
  } catch { /* ignore */ }
  record('④ 自动刷抖音（调度）', b.enabled ? 'PASS' : 'FAIL',
    `browse.enabled=${b.enabled} 每 ${Math.round((b.tickMs ?? 0) / 60000)}min 一拍、上限 ${b.maxPerDay}/天、最小间隔 ${Math.round((b.minGapMs ?? 0) / 3600000)}h；最近日志：${short(hit, 100) || '(本轮还没刷)'}`);
  if (!DOUYIN) { record('④ 刷完分享给爸妈（实发）', 'SKIP', '没给 --douyin=<链接>；分享就发到主人私聊（爸爸本人）'); return; }
  if (!LIVE) { record('④ 刷完分享给爸妈（实发）', 'SKIP', '没加 --live'); return; }
  const r = await call('qq_send_private_message', { userId: OWNER, message: `【自测】刷到一条抖音，分享给爸爸：${DOUYIN}`, token: OTOK });
  record('④ 刷完分享给爸妈（实发）', sentOk(r.value) ? 'PASS' : 'FAIL', `→ ${short(r.value, 120)}`);
}

async function checkSendImage() {
  const box = await call('qq_list_outbox', { limit: 3 });
  const name = /-\s(\S+?)（/.exec(String(box.value))?.[1] ?? (fs.readdirSync(path.join(ROOT, 'state', 'outbox'))[0] ?? '');
  if (!name) { record('⑤ 发图片', 'FAIL', '待发文件夹里没有图片'); return; }
  if (!LIVE) { record('⑤ 发图片', 'SKIP', `可发素材 ${name}，没加 --live`); return; }
  const r = await call('qq_send_image', { key: OKEY, token: OTOK, image: name, caption: '【自测】发图链路检查 ✅' });
  record('⑤ 发图片', sentOk(r.value) ? 'PASS' : 'FAIL', `${name} → ${short(r.value, 130)}`);
}

async function checkDrawImage() {
  const svg = `<svg viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="200" fill="#0b1730"/><ellipse cx="160" cy="118" rx="78" ry="44" fill="#7fc7ff"/><path d="M232 118c18-16 34-20 46-18-8 14-8 22 0 36-14 2-30-2-46-18z" fill="#7fc7ff"/><circle cx="132" cy="104" r="6" fill="#0b1730"/><path d="M160 74c6-16 20-22 30-20-2 14-8 22-14 28z" fill="#a8dcff"/><text x="160" y="182" fill="#cfe8ff" font-size="15" text-anchor="middle" font-family="sans-serif">自测 · 小鲸鱼</text></svg>`;
  const r = await call('qq_draw_image', { svg, width: 320, height: 200, name: 'selftest-whale.svg' });
  const text = String(r.value?.file ?? r.value?.name ?? r.text ?? '');
  const name = /([\w.-]+\.png)/.exec(text)?.[1] ?? '';
  const ok = Boolean(name);
  record('⑥ 自己生成照片', ok ? 'PASS' : 'FAIL', `${short(text, 130)}`);
  if (!ok || !LIVE) { if (ok) record('⑥ 生成后发出来（实发）', 'SKIP', '没加 --live'); return; }
  const s = await call('qq_send_image', { key: OKEY, token: OTOK, image: name, caption: '【自测】这是我刚画的 ✅' });
  record('⑥ 生成后发出来（实发）', sentOk(s.value) ? 'PASS' : 'FAIL', `${name} → ${short(s.value, 130)}`);
}

async function checkQzone() {
  if (!LIVE) { record('⑦ 发说说', 'SKIP', '没加 --live（实发会写进空间，只敢用 visibility=self）'); return; }
  const r = await call('qq_post_qzone', { content: '【自测】小鲸鱼能力体检 · 仅自己可见', visibility: 'self' });
  record('⑦ 发说说', r.value?.tid ? 'PASS' : 'FAIL', `visibility=self → ${short(r.value, 130)}`);
}

async function checkReadImage() {
  const box = await call('qq_list_outbox', { limit: 1 });
  const name = /-\s(\S+?)（/.exec(String(box.value))?.[1] ?? '';
  if (!name) { record('⑧ 读取图（视觉）', 'SKIP', '没有可用图片'); return; }
  const r = await call('qq_describe_image', { key: OKEY, token: OTOK, file: name, focus: '一句话说清画面里有什么' }, 180_000);
  const desc = String(r.value?.description ?? r.value?.text ?? r.value ?? '');
  const ok = desc.trim().length > 8 && !/失败|error|无法/i.test(desc.slice(0, 40));
  record('⑧ 读取图（视觉）', ok ? 'PASS' : 'FAIL', `${name} → ${short(desc, 150)}`);
}

function checkVoice() {
  const v = socialV2.voice ?? {};
  const dir = path.resolve(ROOT, v.dir ?? 'audio');
  const exists = fs.existsSync(dir);
  if (!v.enabled || !exists) {
    record('⑨ 发语音', 'SKIP',
      `语音功能未启用：socialV2.voice.enabled=${v.enabled}、语音库目录 ${exists ? '存在' : '不存在'}（${v.dir}）；工具面里也没有语音工具，只有 CLI scripts/send-voice.mjs。要开就得配 enabled=true + 放音频进目录（可能还需要 ffmpeg 转码）`);
  } else {
    record('⑨ 发语音', 'PASS', `voice.enabled=true，语音库 ${dir} 有 ${fs.readdirSync(dir).length} 个文件（实发请用 scripts/send-voice.mjs）`);
  }
}

async function checkSticker() {
  const list = await call('qq_list_stickers', { key: OKEY, token: OTOK, count: 3 });
  const text = String(list.value?.text ?? list.text ?? list.value ?? '');
  const id = /"?(?:id|stickerId|sticker_id)"?\s*[:=]\s*"?([\w-]{4,})/.exec(JSON.stringify(list.value))?.[1] ?? '';
  const okList = /表情|sticker|\d+\s*条/i.test(text) || id;
  record('⑩ 发表情包（库存）', okList ? 'PASS' : 'FAIL', short(text, 140));
  if (!id || !LIVE) { record('⑩ 发表情包（实发）', 'SKIP', id ? '没加 --live' : '没解析到表情 id'); return; }
  const r = await call('qq_send_sticker', { key: OKEY, token: OTOK, stickerId: id });
  record('⑩ 发表情包（实发）', sentOk(r.value) ? 'PASS' : 'FAIL', `${id} → ${short(r.value, 120)}`);
}

async function checkReadDouyin() {
  if (!DOUYIN) { record('⑪ 读取抖音链接', 'SKIP', '没给 --douyin=<链接>'); return; }
  const r = await call('qq_read_page', { url: DOUYIN, maxChars: 1500 }, 120_000);
  // 工具返回的是「标题/链接/正文」这种给人看的文本（不是 JSON），所以按文本解析。
  const text = String(r.text ?? '');
  const title = /标题：(.+)/.exec(text)?.[1]?.trim() ?? '';
  const resolved = /链接：(\S+)/.exec(text)?.[1]?.trim() ?? '';
  const body = (text.split('正文：')[1] ?? '').trim();
  const ok = body.length > 60;
  const jump = resolved && resolved !== DOUYIN ? `，跳转到 ${resolved}` : '';
  record('⑪ 读取抖音链接', ok ? 'PASS' : 'FAIL',
    `${DOUYIN} → 正文 ${body.length} 字，标题="${short(title, 36)}"${jump}`);
}

async function checkBasics() {
  const s = await call('qq_status', {});
  record('基础：网关在线', s.value?.online ? 'PASS' : 'FAIL', short(s.value, 130));
  try {
    const r = await call('qq_image_search', { query: '鲸鱼', count: 2 }, 90_000);
    const t = String(r.text ?? '');
    record('基础：网上找图', /http|张|results/i.test(t) ? 'PASS' : 'FAIL', short(t, 130));
  } catch (e) { record('基础：网上找图', 'FAIL', short(String(e.message ?? e), 130)); }
}

// ══ 跑起来 ══════════════════════════════════════════════════════════════════
console.log(`小鲸鱼能力自测 · ${LIVE ? '含实发（只发主人私聊 / 仅自己可见说说）' : '只读模式'} · owner=${OWNER ? OWNER.slice(0, 3) + '****' : '(未配)'}`);
console.log(`MCP=${MCP_HOST} 会话令牌=${OTOK ? '已取到' : '缺失'} 回归=${RUN_TESTS ? '开' : '关'}\n`);

runRegressionSuites();

const liveness = [
  ['①', checkNightSleep], ['②', checkProactive], ['③', checkReply], ['④', checkBrowse],
  ['⑤', checkSendImage], ['⑥', checkDrawImage], ['⑦', checkQzone], ['⑧', checkReadImage],
  ['⑨', checkVoice], ['⑩', checkSticker], ['⑪', checkReadDouyin], ['⑫', checkBasics]
];
for (const [, fn] of liveness) {
  try { await fn(); } catch (e) {
    record(`探测失败（${fn.name}）`, 'FAIL', short(String(e?.message ?? e), 160));
  }
}

const pad = (s, n) => String(s).padEnd(n, ' ');
const icon = { PASS: '✅', FAIL: '❌', SKIP: '⏭' };
console.log('能力'.padEnd(30) + '结果  证据');
console.log('─'.repeat(110));
for (const r of results.filter((x) => !x.item.startsWith('回归：'))) {
  console.log(`${icon[r.status]} ${pad(r.item, 26)} ${r.evidence}`);
}
const suites = results.filter((x) => x.item.startsWith('回归：'));
if (suites.length) {
  console.log('\n回归脚本：' + suites.filter((s) => s.status === 'PASS').length + '/' + suites.length + ' 通过');
  for (const s of suites.filter((x) => x.status !== 'PASS')) console.log(`  ${icon[s.status]} ${s.item.replace('回归：', '')} — ${s.evidence}`);
}
const count = (st, rows = results) => rows.filter((r) => r.status === st).length;
console.log(`\n汇总：PASS ${count('PASS')} / FAIL ${count('FAIL')} / SKIP ${count('SKIP')}`);
if (count('FAIL')) {
  console.log('失败项：');
  for (const f of results.filter((r) => r.status === 'FAIL')) console.log(`  ❌ ${f.item} — ${f.evidence}`);
  process.exitCode = 1;
}