#!/usr/bin/env node
/**
 * dsh-qq-extras 归档链路的回归：桥接写 state/qq-memory.log → 我们自己的采集器喂给插件归档库。
 *
 * 三层：
 *   一、src/qqb/memory-log.mjs —— 纯模块：行格式、脱敏、解析、跨零点时间戳、行数上限。
 *   二、格式兼容 —— 用插件 collector.mjs 里那条**原样正则**（见下方 PLUGIN_LINE_RE）
 *      断言我们写出去的 `管理员 <名>：` / `agent 回复：` 行它一定认（这是整件事的地基）。
 *   三、采集器 —— scripts/qq-extras-collector.mjs：参数解析、插件目录解析、端到端落库 + 幂等。
 *      插件没装时第三层的端到端部分装 SKIP（别的机器上也能跑）。
 *
 * 用法：node scripts/test-qq-extras-memory-log.mjs（npm run test:qq-extras）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MAX_TEXT_CHARS,
  createMemoryLogWriter,
  formatMemoryLine,
  memoryLogTimestamp,
  parseMemoryLine,
  parseMemoryLog
} from '../src/qqb/memory-log.mjs';
import { parseArgs, resolvePluginDir } from './qq-extras-collector.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COLLECTOR = path.join(__dirname, 'qq-extras-collector.mjs');

/** dsh-qq-extras/collector.mjs 里 parseLine 用的正则，原样抄来当兼容性断言。 */
const PLUGIN_LINE_RE = /^\[(\d{2}:\d{2}:\d{2})\] (\S+) (.*?)：(.*)$/s;

let failures = 0;
const skipped = [];
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
function skip(name, why) { skipped.push(name); console.log('SKIP', name, '—', why); }

function tempDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `qqextras-${tag}-`));
  return dir;
}

// ══ 一、纯模块 ═══════════════════════════════════════════════════════════════

await test('memory-log：三种角色的行格式与空正文', () => {
  assert.equal(
    formatMemoryLine({ clock: '01:02:03', key: 'private:1000000001', role: 'owner', name: '大肥鱼', text: '在吗' }),
    '[01:02:03] private:1000000001 管理员 大肥鱼：在吗'
  );
  assert.equal(
    formatMemoryLine({ clock: '01:02:03', key: 'private:1000000001', role: 'agent', name: null, text: '在的' }),
    '[01:02:03] private:1000000001 agent 回复：在的'
  );
  assert.equal(
    formatMemoryLine({ clock: '01:02:03', key: 'group:900000001', role: 'member', name: '路人', text: '哈喽' }),
    '[01:02:03] group:900000001 成员 路人：哈喽'
  );
  // 没有正文、没有 key/name 的兜底
  assert.equal(formatMemoryLine({ clock: '01:02:03', key: 'k', role: 'owner', name: 'x', text: '   ' }), '');
  assert.equal(
    formatMemoryLine({ clock: '01:02:03', key: '', role: 'owner', name: '', text: '喂' }),
    '[01:02:03] unknown 管理员 主人：喂'
  );
});

await test('memory-log：正文压平成一行并截断到上限', () => {
  const long = '啊'.repeat(MAX_TEXT_CHARS + 50);
  const line = formatMemoryLine({ clock: '01:02:03', key: 'k', role: 'agent', name: null, text: `第一行\r\n第二行\n\n第三行  ${long}` });
  assert.ok(!line.includes('\n') && !line.includes('\r'), '不能写出换行，否则一行变多行');
  assert.match(line, /第一行 第二行 第三行 啊/);
  const body = line.slice(line.indexOf('：') + 1);
  assert.equal(body.length, MAX_TEXT_CHARS, `正文要截断到 ${MAX_TEXT_CHARS} 字`);
});

await test('格式兼容：插件 collector 的正则必须认得出我们写的行', () => {
  const owner = formatMemoryLine({ clock: '09:08:07', key: 'private:1000000001', role: 'owner', name: '大肥鱼', text: '小鲸鱼' });
  const agent = formatMemoryLine({ clock: '09:08:08', key: 'private:1000000001', role: 'agent', name: null, text: '欸' });
  const mOwner = PLUGIN_LINE_RE.exec(owner);
  const mAgent = PLUGIN_LINE_RE.exec(agent);
  assert.ok(mOwner, `插件正则认不出管理员行：${owner}`);
  assert.equal(mOwner[2], 'private:1000000001');
  assert.ok(mOwner[3].startsWith('管理员'), '插件靠「管理员」前缀判 owner');
  assert.equal(mOwner[4], '小鲸鱼');
  assert.ok(mAgent, `插件正则认不出 agent 行：${agent}`);
  assert.equal(mAgent[3], 'agent 回复', '插件靠「agent 回复」精确匹配判 agent');
});

await test('memory-log：解析器正反例（含活动日志老格式必须不认）', () => {
  assert.deepEqual(
    (({ clock, key, role, name, text }) => ({ clock, key, role, name, text }))(parseMemoryLine('[09:08:07] private:1 管理员 大肥鱼：在吗')),
    { clock: '09:08:07', key: 'private:1', role: 'owner', name: '大肥鱼', text: '在吗' }
  );
  assert.equal(parseMemoryLine('[09:08:08] private:1 agent 回复：在的')?.role, 'agent');
  assert.equal(parseMemoryLine('[09:08:09] group:2 成员 路人：哈喽')?.name, '路人');
  assert.equal(parseMemoryLine(''), null);
  assert.equal(parseMemoryLine('[09:08:07] private:1 管理员 大肥鱼：'), null, '没有正文不算一条');
  assert.equal(parseMemoryLine('[09:08:07] private:1 消息已入未读：x'), null, '不是三方说话人不认');
  assert.equal(
    parseMemoryLine('[09:08:07] private:1 [reserved2] 消息已入未读：x'),
    null,
    '桥接活动日志的老格式必须被拒（否则会把同一句话重复归档）'
  );
  const many = parseMemoryLog(['[09:08:07] private:1 管理员 A：一', '垃圾行', '[09:08:08] private:1 agent 回复：二'].join('\n'));
  assert.equal(many.length, 2);
});

await test('memory-log：跨零点的时间戳回退到昨天', () => {
  const now = new Date(2026, 9, 24, 0, 5, 0); // 2026-10-24 00:05
  assert.equal(memoryLogTimestamp('00:04:30', now), '2026-10-24 00:04:30');
  assert.equal(memoryLogTimestamp('23:59:30', now), '2026-10-23 23:59:30', '行内时刻在未来 >10 分钟 ⇒ 判为昨天');
  assert.equal(memoryLogTimestamp('', now), '2026-10-24 00:05:00', '没有时刻就退回当前时间');
});

await test('memory-log：写入器按 maxLines 截断，关掉就不写，写不进去也不抛', () => {
  const dir = tempDir('writer');
  const file = path.join(dir, 'qq-memory.log');
  const writer = createMemoryLogWriter({ file, maxLines: 3 });
  const clock = () => '10:00:00';
  for (let i = 1; i <= 6; i += 1) writer.append({ key: 'k', role: 'owner', name: 'A', text: `第 ${i} 条` });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3, '超过上限只留最后 3 行');
  assert.match(lines.at(-1), /第 6 条/);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('第 3 条'), '太老的行要滚掉');

  const offFile = path.join(dir, 'off.log');
  const off = createMemoryLogWriter({ file: offFile, enabled: false });
  assert.equal(off.append({ key: 'k', role: 'owner', name: 'A', text: '不该写' }), null);
  assert.ok(!fs.existsSync(offFile), '关掉时连文件都不该建');

  const broken = createMemoryLogWriter({ file: path.join(dir, 'no-such-dir', 'x.log') });
  assert.equal(broken.append({ key: 'k', role: 'owner', name: 'A', text: '写不进去' }), null, '写失败返回 null 而不是抛');
});

// ══ 二、桥接侧接线（源码级断言，防重构时被悄悄删掉） ═══════════════════════════

await test('桥接接线：入站与出站各有一处 appendMemoryLog，且默认开启', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  assert.match(src, /import \{[^}]*createMemoryLogWriter[^}]*\} from '\.\/qqb\/memory-log\.mjs'/, '要 import 模块');
  assert.match(src, /memoryLog: \{ enabled: true, maxLines: 5000/, '配置默认开启');
  assert.match(src, /appendMemoryLog\(key, 'agent', null, text\)/, '出站（recordSentMessagesV2）要写 agent 行');
  assert.match(src, /isOwner \? 'owner' : 'member'/, '入站要按是不是主人分角色');
  const writer = createMemoryLogWriter;
  assert.equal(typeof writer, 'function');
});

// ── 端到端（夹具内）：真跑桥接代码，看它到底往 state/qq-memory.log 写了什么 ──────
// 源码级断言只能防「行被删」，证明不了它真的会被调用；这里用审计夹具（临时 state、
// 假网关、假 DSH）驱动真实的 handleIncoming / recordSentMessagesV2 走一遍。
await test('端到端（夹具内）：主人入站、群友入站、出站回复都落进 state/qq-memory.log', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { batchWindowMs: 1000 } } } });
  try {
    h.setMode('reserved2');
    const file = path.join(h.temp, 'state', 'qq-memory.log');
    assert.equal(fs.existsSync(file), false, '没人说话时不该先建文件');

    // 主人私聊（夹具 config 的 ownerQQ = 123）
    await h.handleIncoming('private', '123', {
      self_id: 999, user_id: 123, message_id: 5001,
      message: [{ type: 'text', data: { text: '在吗' } }], raw_message: '在吗',
      sender: { nickname: '大肥鱼' }
    }, h.cfg);
    // 群里其他人
    await h.handleIncoming('group', '456', {
      self_id: 999, user_id: 888, message_id: 5002,
      message: [{ type: 'text', data: { text: '小鲸鱼早' } }], raw_message: '小鲸鱼早',
      sender: { nickname: '群友甲', card: '群友甲' }
    }, h.cfg);
    // 小鲸鱼的出站文字（AI 回复 / 工具发送 / 控制台发送都走这里）
    h.recordSentMessagesV2('private:123', ['在的，我在。']);

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, `应有 3 行归档流水，实际：${JSON.stringify(lines)}`);
    for (const line of lines) assert.match(line, PLUGIN_LINE_RE, '每一行插件 collector 都要认得出');

    const recs = parseMemoryLog(lines.join('\n'));
    assert.deepEqual(
      recs.map((r) => [r.key, r.role, r.name, r.text]),
      [
        ['private:123', 'owner', '大肥鱼', '在吗'],
        ['group:456', 'member', '群友甲', '小鲸鱼早'],
        ['private:123', 'agent', 'agent', '在的，我在。']
      ]
    );
    // 时间戳能补出归档要的 YYYY-MM-DD HH:MM:SS
    assert.match(memoryLogTimestamp(recs[0].clock), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  } finally { await h.close(); }
});

// ══ 三、采集器 ═══════════════════════════════════════════════════════════════

await test('采集器：参数解析与插件目录解析', () => {
  const args = parseArgs(['--log', 'x.log', '--dry-run', '--summary-every', '5', '--no-summary', '--interval', '60']);
  assert.equal(args.log, 'x.log');
  assert.equal(args['dry-run'], true);
  assert.equal(args['summary-every'], '5');
  assert.equal(args['no-summary'], true);
  assert.equal(parseArgs(['--status'])['status'], true, '无值开关不能把下一个 flag 吃掉');
  // 查询类开关：--recent 既可裸用也可带条数；--search 必须带关键词。
  assert.equal(parseArgs(['--recent']).recent, true);
  assert.equal(parseArgs(['--recent', '10']).recent, '10');
  assert.equal(parseArgs(['--search', '鲸鱼']).search, '鲸鱼');
  assert.equal(parseArgs(['--search', '鲸鱼', '--limit', '3', '--role', 'agent']).limit, '3');
  assert.equal(parseArgs(['--search', '鲸鱼', '--limit', '3', '--role', 'agent']).role, 'agent');

  const home = tempDir('home');
  const fake = path.join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-qq-extras');
  fs.mkdirSync(path.join(fake, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'lib', 'archive.mjs'), 'export const x = 1;\n');
  assert.equal(resolvePluginDir({}, home, {}), fake, '要能在 profile 的 node_modules 里找到插件');
  assert.equal(resolvePluginDir({}, path.join(home, 'nope'), {}), null);
  assert.equal(resolvePluginDir({ 'plugin-dir': fake }, home, {}), fake);
});

const pluginDir = resolvePluginDir({});

// fixture 的时刻必须落在「刚刚过去」，不能写死：写死 10:00 在上午 9 点跑测试时会被
// memoryLogTimestamp 判成「昨天」（它就是这么设计的），断言就会假失败。
const pad2 = (n) => String(n).padStart(2, '0');
const fixtureBase = (() => {
  const realNow = new Date();
  const past = new Date(Date.now() - 60_000);
  return past.getDate() === realNow.getDate() ? past : realNow;
})();
const fixtureDay = `${fixtureBase.getFullYear()}-${pad2(fixtureBase.getMonth() + 1)}-${pad2(fixtureBase.getDate())}`;
const clockAt = (offsetSec) => {
  const d = new Date(fixtureBase.getTime() + offsetSec * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const fixtureLog = [
  `[${clockAt(1)}] private:1000000001 管理员 大肥鱼：小鲸鱼，归档这条链路通了吗`,
  `[${clockAt(2)}] private:1000000001 管理员 大肥鱼：小鲸鱼，归档这条链路通了吗`,
  `[${clockAt(3)}] private:1000000001 agent 回复：通了主人，我连着跑了两遍，第二遍一条都没重复`,
  `[${clockAt(4)}] group:900000001 成员 路人：凑个热闹`,
  `[${clockAt(5)}] private:1000000001 [reserved2] 消息已入未读：老格式不该进归档`
].join('\n');

if (!pluginDir) {
  skip('采集器端到端（落库 + 幂等 + --status）', '没找到 dsh-qq-extras（先跑 dsh plugin --profile web add dsh-qq-extras）');
} else {
  const runCollector = (extra) => JSON.parse(execFileSync(process.execPath, [COLLECTOR, '--no-summary', ...extra], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000
  }));

  await test('采集器端到端：4 条入库、老格式被丢、重跑不重复', () => {
    const dir = tempDir('collector');
    const log = path.join(dir, 'qq-memory.log');
    fs.writeFileSync(log, fixtureLog, 'utf8');
    const data = path.join(dir, 'data');
    const first = runCollector(['--log', log, '--data-dir', data]);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.parsed, 4, '老格式那行不该被解析');
    assert.equal(first.appended, 4);
    const rows = fs.readFileSync(path.join(data, 'archive', 'messages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 4);
    assert.equal(rows[0].role, 'owner');
    assert.equal(rows[0].name, '大肥鱼');
    assert.equal(rows[0].ts, `${fixtureDay} ${clockAt(1)}`);
    assert.equal(rows[2].role, 'agent');
    assert.equal(rows[3].name, '路人');

    const second = runCollector(['--log', log, '--data-dir', data]);
    assert.equal(second.appended, 0, '重跑必须一条都不重复');
    assert.equal(second.skipped, 4);
    assert.equal(fs.readFileSync(path.join(data, 'archive', 'messages.jsonl'), 'utf8').trim().split('\n').length, 4);

    const status = JSON.parse(execFileSync(process.execPath, [COLLECTOR, '--status', '--data-dir', data], { cwd: ROOT, encoding: 'utf8', timeout: 60000 }));
    assert.equal(status.stats.total, 4);
    assert.equal(status.stats.byRole.owner, 2, '两条管理员行时间戳不同，各自算一条');
    assert.equal(status.stats.byRole.agent, 1);
  });

  await test('采集器：--dry-run 不落盘、不改状态', () => {
    const dir = tempDir('dry');
    const log = path.join(dir, 'qq-memory.log');
    fs.writeFileSync(log, fixtureLog, 'utf8');
    const data = path.join(dir, 'data');
    const dry = runCollector(['--log', log, '--data-dir', data, '--dry-run']);
    assert.equal(dry.appended, 4, 'dry-run 也要报出「本来会写几条」');
    assert.ok(!fs.existsSync(path.join(data, 'archive', 'messages.jsonl')), 'dry-run 不能落库');
    assert.ok(!fs.existsSync(path.join(data, 'collector-bridge.json')), 'dry-run 不能改状态');
    const real = runCollector(['--log', log, '--data-dir', data]);
    assert.equal(real.appended, 4, 'dry-run 之后真跑还是要写 4 条');
  });
}

// ══ 收尾 ════════════════════════════════════════════════════════════════════
if (skipped.length) console.log(`\n（跳过 ${skipped.length} 项：本机/环境所限）`);
if (failures) {
  console.error(`\n❌ dsh-qq-extras 归档链路回归失败 ${failures} 项`);
  process.exit(1);
}
console.log('\n✅ dsh-qq-extras 归档链路回归全部通过');