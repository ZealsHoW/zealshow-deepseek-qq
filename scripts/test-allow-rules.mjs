#!/usr/bin/env node
/**
 * 白名单「按用户名规则自动纳入」（主人 2026-10-23 第①条）的回归。
 *
 * 三层：
 *   一、src/qqb/allow-rules.mjs —— 纯模块：配置归一化（对象/裸数组两种写法）、规则匹配、
 *      黑名单优先、一小时限流、体检文案。
 *   二、src/bridge.js 源码接线 —— loadConfig 里真的挂了；handleIncoming 未授权分支真的调了；
 *      closed-agent 模式不许偷偷改配置；控制台保存白名单不许把 autoInclude 抹掉。
 *   三、夹具端到端 —— 真跑 handleIncoming：命中规则 → config.json 真被改 + 消息真被处理；
 *      不命中 / 被拉黑 / 超限流 / 没开开关 → 配置一动不动。
 *
 * 用法：node scripts/test-allow-rules.mjs（npm run test:allow-rules）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTO_INCLUDE_WINDOW_MS,
  DEFAULT_AUTO_INCLUDE_MAX_ADDS_PER_HOUR,
  autoIncludeBudget,
  autoIncludeProblems,
  autoIncludeSettings,
  describeAutoIncludeRule,
  matchAutoInclude
} from '../src/qqb/allow-rules.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const readConfig = (h) => JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
const ids = (list) => (list ?? []).map(String);
/**
 * 「这条消息到底有没有被处理」的判据：state/qq-memory.log。
 * 那笔归档写在 handleIncoming 的白名单闸门**之后**，所以未授权的人不会留下任何痕迹；
 * 而 calls.created 不能当判据——唤醒是攒批的，建会话发生在批窗口之后（1000ms），
 * 断言它会变成"跟批处理时机赛跑"。
 */
const memoryLog = (h) => {
  const file = path.join(h.temp, 'state', 'qq-memory.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};

/** 造一条私聊入站事件 */
const privateEvent = (userId, nickname, messageId) => ({
  self_id: 999,
  user_id: userId,
  message_id: messageId,
  message: [{ type: 'text', data: { text: '你好呀' } }],
  raw_message: '你好呀',
  sender: { nickname }
});

// ══ 一、纯模块 ═══════════════════════════════════════════════════════════════

await test('默认关：没配 autoInclude 时 disabled、零规则、上限是默认值', () => {
  const s = autoIncludeSettings(undefined);
  assert.equal(s.enabled, false);
  assert.deepEqual(s.rules, []);
  assert.equal(s.maxAddsPerHour, DEFAULT_AUTO_INCLUDE_MAX_ADDS_PER_HOUR);
  assert.equal(matchAutoInclude({ kind: 'private', id: '1', name: '小鲸' }, s), null);
});

await test('裸数组写法：数字当 QQ 号、其余当昵称，且自动开启', () => {
  const s = autoIncludeSettings([2998647358, '小鲸', '  ']);
  assert.equal(s.enabled, true, '写成数组本身就是"要开"的意思');
  assert.equal(s.rules.length, 2, '空白项被丢掉');
  assert.equal(s.rules[0].qq, '2998647358');
  assert.equal(s.rules[1].name, '小鲸');
  assert.equal(s.rules[0].kind, 'any');
});

await test('对象写法：qq / name / namePattern / kind / note 都归一化', () => {
  const s = autoIncludeSettings({
    enabled: true,
    maxAddsPerHour: 2,
    rules: [
      { qq: '02998647358', note: '前导零也要归一化' },
      { name: ' 小鲸 ' },
      { namePattern: '^小鲸', kind: 'private' },
      { namePattern: '[' },
      { kind: 'private' },
      { qq: 5, kind: 'group', note: '群规则' }
    ]
  });
  assert.equal(s.enabled, true);
  assert.equal(s.maxAddsPerHour, 2);
  assert.equal(s.rules[0].qq, '2998647358');
  assert.equal(s.rules[1].name, '小鲸');
  assert.equal(s.rules[2].regex instanceof RegExp, true);
  assert.equal(s.rules[2].kind, 'private');
  assert.equal(s.rules[3].regex, null, '坏正则只剔掉那一条规则，不抛异常');
  assert.equal(s.rules[4].qq, ''); assert.equal(s.rules[4].name, '');
  assert.equal(s.rules[5].kind, 'group');
});

await test('体检：坏正则 / 空规则 / 按昵称放行 / 上限 0 都要说出来', () => {
  const problems = autoIncludeProblems(autoIncludeSettings({
    enabled: true,
    maxAddsPerHour: 0,
    rules: [{}, { namePattern: '[' }, { name: '小鲸' }]
  }));
  const text = problems.join('\n');
  assert.match(text, /第 1 条规则什么都没写/);
  assert.match(text, /第 2 条规则的 namePattern 不是合法正则/);
  assert.match(text, /第 3 条规则按昵称放行/);
  assert.match(text, /maxAddsPerHour=0/);
  assert.deepEqual(autoIncludeProblems(autoIncludeSettings({ enabled: true, rules: [{ qq: 1 }] })), []);
  assert.deepEqual(autoIncludeProblems(autoIncludeSettings({ enabled: false, rules: [{}] })), [], '没开就不体检');
});

await test('匹配：QQ 号精确命中（私聊与群聊都按 id 比）', () => {
  const s = autoIncludeSettings({ enabled: true, rules: [{ qq: 2998647358, note: '测试号' }] });
  const hit = matchAutoInclude({ kind: 'private', id: 2998647358, name: '随便改的名字' }, s);
  assert.equal(hit?.index, 0);
  assert.match(hit.why, /QQ 号 2998647358/);
  assert.equal(matchAutoInclude({ kind: 'private', id: '2998647359' }, s), null);
  assert.ok(matchAutoInclude({ kind: 'group', id: '2998647358' }, s), '群规则按群号比');
});

await test('匹配：昵称/群名片精确匹配（忽略大小写与首尾空白），不用正则兜底', () => {
  const s = autoIncludeSettings({ enabled: true, rules: [{ name: '小鲸' }] });
  assert.ok(matchAutoInclude({ kind: 'private', id: '1', name: ' 小鲸 ' }, s));
  assert.ok(matchAutoInclude({ kind: 'private', id: '1', card: '小鲸' }, s), '群名片也叫这个名');
  assert.equal(matchAutoInclude({ kind: 'private', id: '1', name: '小鲸鱼' }, s), null, '精确匹配，不做子串');
  const s2 = autoIncludeSettings({ enabled: true, rules: [{ namePattern: '^小鲸' }] });
  assert.ok(matchAutoInclude({ kind: 'private', id: '1', name: '小鲸鱼2号' }, s2));
  assert.equal(matchAutoInclude({ kind: 'group', id: '1', name: '小鲸鱼2号' }, s2), null,
    '群聊事件里的 sender 是群成员、不是群名，昵称规则不参与群聊');
});

await test('匹配：kind 过滤（群规则不认私聊，私聊规则不认群）', () => {
  const s = autoIncludeSettings({ enabled: true, rules: [{ qq: 777, kind: 'group' }] });
  assert.ok(matchAutoInclude({ kind: 'group', id: '777' }, s));
  assert.equal(matchAutoInclude({ kind: 'private', id: '777' }, s), null);
  const s2 = autoIncludeSettings({ enabled: true, rules: [{ qq: 777, kind: 'private' }] });
  assert.ok(matchAutoInclude({ kind: 'private', id: '777' }, s2));
  assert.equal(matchAutoInclude({ kind: 'group', id: '777' }, s2), null);
});

await test('限流：窗口内计数、超限不许再加、老时间戳被裁掉', () => {
  const now = 1_000_000_000_000;
  const adds = [now - 10, now - AUTO_INCLUDE_WINDOW_MS - 1, now - 20];
  const budget = autoIncludeBudget(adds, { now, maxPerHour: 3 });
  assert.equal(budget.count, 2, '一小时前的那个被裁掉');
  assert.equal(budget.ok, true);
  assert.equal(adds.length, 2, '裁剪是就地的，内存里的数组不会无限长');
  assert.equal(autoIncludeBudget([now, now, now], { now, maxPerHour: 3 }).ok, false);
  assert.equal(autoIncludeBudget([], { now, maxPerHour: 0 }).ok, false, '上限 0 = 永不自动纳入');
});

await test('规则描述能一眼看出是哪条', () => {
  const s = autoIncludeSettings({ enabled: true, rules: [{ qq: 2998647358, name: '小鲸', kind: 'private', note: '测试号' }] });
  const text = describeAutoIncludeRule(s.rules[0], 0);
  assert.match(text, /^#1 /);
  assert.match(text, /qq=2998647358/);
  assert.match(text, /name=小鲸/);
  assert.match(text, /kind=private/);
  assert.match(text, /note=测试号/);
});

// ══ 二、源码接线 ═════════════════════════════════════════════════════════════

const bridgeSource = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

await test('源码接线：loadConfig 归一化 allow.autoInclude', () => {
  assert.match(bridgeSource, /import \{[^}]*autoIncludeSettings[^}]*\} from '\.\/qqb\/allow-rules\.mjs';/);
  assert.match(bridgeSource, /autoInclude: autoIncludeSettings\(file\.allow\?\.autoInclude\)/);
});

await test('源码接线：未授权分支真的试自动纳入，且 closed-agent 不许改配置', () => {
  assert.match(bridgeSource, /currentMode !== 'closed-agent' && tryAutoInclude\(kind, id, event, cfg\)/);
  assert.match(bridgeSource, /function tryAutoInclude\(kind, id, event, cfg\)/);
  assert.match(bridgeSource, /if \(autoIncludeDenied\(kind, id, cfg\)\) return false;/, 'deny 优先');
});

await test('源码接线：控制台保存白名单不许抹掉 autoInclude', () => {
  assert.match(bridgeSource, /file\.allow = \{ \.\.\.\(file\.allow \?\? \{\}\), private: allow\.private, groups: allow\.groups \};/);
  assert.match(bridgeSource, /cfg\.allow = \{ \.\.\.cfg\.allow, private: allow\.private, groups: allow\.groups \};/);
});

await test('源码接线：开了就在启动日志里列规则与体检结果', () => {
  assert.match(bridgeSource, /白名单自动纳入：已开启/);
  assert.match(bridgeSource, /autoIncludeProblems\(cfg\.allow\.autoInclude\)/);
});

// ══ 三、夹具端到端 ═══════════════════════════════════════════════════════════

const baseAllow = { private: ['123'], groups: ['456'] };
const baseConfig = (autoInclude, extra = {}) => ({
  allow: { ...baseAllow, ...(autoInclude === undefined ? {} : { autoInclude }) },
  socialV2: { wake: { batchWindowMs: 1000 } },
  ...extra
});

await test('端到端：QQ 号规则命中 → 写进 config.json、消息真被处理、活动流水留痕', async () => {
  const h = await bridgeHarness({
    config: baseConfig({ enabled: true, rules: [{ qq: 2998647358, note: '测试号' }] })
  });
  try {
    h.setMode('reserved2');
    assert.equal(readConfig(h).allow.private.map(String).includes('2998647358'), false, '前置：不在白名单里');
    await h.handleIncoming('private', '2998647358', privateEvent(2998647358, '路人甲', 7001), h.cfg);

    assert.ok(ids(h.cfg.allow.private).includes('2998647358'), '内存白名单要立刻生效');
    assert.ok(ids(readConfig(h).allow.private).includes('2998647358'), 'config.json 要落盘（重启后还在）');
    assert.match(memoryLog(h), /private:2998647358/, '这条消息必须真的被处理（不是"忽略了事"）');
    const activity = fs.readFileSync(path.join(h.temp, 'state', 'qq-activity.log'), 'utf8');
    assert.match(activity, /\[allow\] 白名单自动纳入 private:2998647358/);
    // 幂等：同一个人再来一条，不该重复写入
    await h.handleIncoming('private', '2998647358', privateEvent(2998647358, '路人甲', 7002), h.cfg);
    assert.equal(ids(readConfig(h).allow.private).filter((x) => x === '2998647358').length, 1, '不能重复塞进白名单');
  } finally { await h.close(); }
});

await test('端到端：昵称规则命中（可被冒充，但行为要正确）', async () => {
  const h = await bridgeHarness({ config: baseConfig({ enabled: true, rules: [{ name: '小鲸' }] }) });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('private', '555', privateEvent(555, ' 小鲸 ', 7003), h.cfg);
    assert.ok(ids(readConfig(h).allow.private).includes('555'));
    assert.match(memoryLog(h), /private:555/);
  } finally { await h.close(); }
});

await test('端到端：不命中规则的人还是被忽略，配置一动不动', async () => {
  const h = await bridgeHarness({ config: baseConfig({ enabled: true, rules: [{ qq: 2998647358 }] }) });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('private', '999', privateEvent(999, '陌生人', 7004), h.cfg);
    assert.equal(memoryLog(h), '', '未授权的人不该在归档流水里留下任何东西');
    assert.deepEqual(readConfig(h).allow.private, ['123'], 'config.json 不该被动过');
  } finally { await h.close(); }
});

await test('端到端：deny 优先——黑名单里的人命中昵称规则也进不来', async () => {
  const h = await bridgeHarness({
    config: baseConfig({ enabled: true, rules: [{ name: '被拉黑的人' }] }, { deny: { private: ['666'], groups: [] } })
  });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('private', '666', privateEvent(666, '被拉黑的人', 7005), h.cfg);
    assert.equal(memoryLog(h), '');
    assert.equal(ids(readConfig(h).allow.private).includes('666'), false, 'deny 的人绝不能被自动纳入');
  } finally { await h.close(); }
});

await test('端到端：一小时限流——只放进第一个，第二个被挡下且不落盘', async () => {
  const h = await bridgeHarness({
    config: baseConfig({ enabled: true, maxAddsPerHour: 1, rules: [{ namePattern: '^新朋友' }] })
  });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('private', '801', privateEvent(801, '新朋友A', 7006), h.cfg);
    await h.handleIncoming('private', '802', privateEvent(802, '新朋友B', 7007), h.cfg);
    assert.ok(ids(readConfig(h).allow.private).includes('801'));
    assert.equal(ids(readConfig(h).allow.private).includes('802'), false, '超限流的那个不许进白名单');
    assert.match(memoryLog(h), /private:801/);
    assert.doesNotMatch(memoryLog(h), /private:802/, '被限流的消息仍按未授权处理');
    assert.match(fs.readFileSync(path.join(h.temp, 'state', 'qq-activity.log'), 'utf8'), /命中自动纳入规则但被限流/);
  } finally { await h.close(); }
});

await test('端到端：开关没开时行为跟以前一模一样（回归底线）', async () => {
  const h = await bridgeHarness({ config: baseConfig({ enabled: false, rules: [{ qq: 2998647358 }] }) });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('private', '2998647358', privateEvent(2998647358, '路人甲', 7008), h.cfg);
    assert.equal(memoryLog(h), '');
    assert.deepEqual(readConfig(h).allow.private, ['123']);
  } finally { await h.close(); }
});

await test('端到端：closed-agent 模式不自动纳入（避免"看着授权了其实没有"）', async () => {
  const h = await bridgeHarness({ config: baseConfig({ enabled: true, rules: [{ qq: 2998647358 }] }) });
  try {
    h.setMode('closed-agent');
    await h.handleIncoming('private', '2998647358', privateEvent(2998647358, '路人甲', 7009), h.cfg);
    assert.equal(memoryLog(h), '');
    assert.deepEqual(readConfig(h).allow.private, ['123'], '封闭 agent 模式下配置必须原封不动');
  } finally { await h.close(); }
});

await test('端到端：群规则按群号自动纳入群白名单', async () => {
  const h = await bridgeHarness({ config: baseConfig({ enabled: true, rules: [{ qq: 888777, kind: 'group' }] }) });
  try {
    h.setMode('reserved2');
    await h.handleIncoming('group', '888777', {
      self_id: 999, user_id: 321, group_id: 888777, message_id: 7010,
      message: [{ type: 'text', data: { text: '小鲸鱼在吗' } }], raw_message: '小鲸鱼在吗',
      sender: { nickname: '群友', card: '群友' }
    }, h.cfg);
    assert.ok(ids(readConfig(h).allow.groups).includes('888777'), '群号要落进 allow.groups');
    assert.deepEqual(readConfig(h).allow.private, ['123'], '别串到私聊白名单里');
    assert.match(memoryLog(h), /group:888777/);
  } finally { await h.close(); }
});

await test('端到端：控制台 POST /api/whitelist 不会抹掉 autoInclude', async () => {
  const h = await bridgeHarness({
    config: baseConfig({ enabled: true, rules: [{ qq: 2998647358, note: '测试号' }] })
  });
  let server = null;
  try {
    h.setMode('reserved2');
    server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const status = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ allow: { private: ['123', '654321'], groups: ['456'] }, deny: { private: [], groups: [] } });
      const request = http.request({
        host: '127.0.0.1', port: server.address().port, path: '/api/whitelist?token=fixture-console-token', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body);
    });
    assert.equal(status, 200);
    const saved = readConfig(h);
    assert.deepEqual(saved.allow.private.map(Number).sort((a, b) => a - b), [123, 654321]);
    assert.equal(saved.allow.autoInclude.enabled, true, 'autoInclude 必须原样留在 config.json 里');
    assert.equal(saved.allow.autoInclude.rules.length, 1);
    assert.equal(h.cfg.allow.autoInclude.enabled, true, '内存里也不能丢（否则热更新后规则静默失效）');
  } finally {
    // 控制台服务器必须显式关：留着它会让整个回归脚本跑完不退出（"全部通过"之后再挂住）。
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

console.log('');
if (failures) {
  console.error(`❌ 白名单自动纳入回归有 ${failures} 项失败`);
  process.exit(1);
}
console.log('✅ 白名单自动纳入回归全部通过');