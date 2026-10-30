// scripts/test-qqb-liveness.mjs —— 「活人化」改造的接线回归（bridge.js 侧）。
//
// 主人 2026-10-28 的要求：一次只发一句、说完停一秒、不用问「可不可以」、
// 想法自己冒（念头）、精神值决定回多少字。行为细节在 spirit/thoughts 的单独测试里，
// 这里只钉「桥接有没有真的接上」——这类改造最容易写完模块忘了插线，
// 表现就是「模块测试全绿、线上她还是在连发三条」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = fs.readFileSync(path.join(here, '..', 'src', 'bridge.js'), 'utf8');

test('接线：引擎行为规则里有「只说一句 / 说完停一下 / 不用问可不可以 / 念头 / 记忆留感受」', () => {
  for (const rule of ['【只说一句】', '【说完停一下】', '【不用问可不可以】', '【念头是你自己的】', '【记忆要留感受】']) {
    assert.ok(bridge.includes(rule), `ENGINE_RULES 里缺少 ${rule}`);
  }
});

test('接线：单句模式真的把整段压成第一句（不是只写在提示词里）', () => {
  assert.ok(bridge.includes('function firstSentenceOf('), '缺少 firstSentenceOf');
  assert.ok(bridge.includes("socialCfg?.singleSentence !== false"), '单句开关没接');
  assert.ok(/firstSentenceOf\(src, cap\)/.test(bridge), 'planSocialTimeline 没调用 firstSentenceOf');
  // 单句模式必须提前返回，否则后面还会按空格拆成多条
  const block = bridge.slice(bridge.indexOf('socialCfg?.singleSentence !== false'));
  const head = block.slice(0, 400);
  assert.match(head, /return \{ main: one \? \[singleLineForQQ\(one\)\] : \[\], followUp: null \};/);
});

test('接线：发完一条到下一句之间有一秒停顿（单条发送与多段发送都要有）', () => {
  assert.ok(bridge.includes('function sendPauseMs('), '缺少 sendPauseMs');
  assert.ok(bridge.includes("cfg?.social?.singleSentencePauseMs"), '停顿时长没从配置读');
  assert.ok(bridge.includes('i === parts.length - 1 ? sendPauseMs() : 0'), '单条发送没有在最后一条后停顿');
  // 多段发送（sendBurstToQQ）整串说完也要停
  const burst = bridge.slice(bridge.indexOf('function sendBurstToQQ'), bridge.indexOf('function sendBurstToQQ') + 4000);
  assert.ok(burst.includes('const pause = sendPauseMs();'), '多段发送结束后没有停顿');
});

test('接线：精神值进了提示词，并且会硬锁回复字数', () => {
  assert.ok(bridge.includes('function spiritSummary('), '缺少 spiritSummary');
  assert.ok(bridge.includes('spiritSummary(),'), '提示词里没有精神值那一段');
  assert.ok(bridge.includes('thoughtsText(),'), '提示词里没有念头那一段');
  assert.ok(bridge.includes('limitReplyBySpirit(plain)'), '回复没有按精神值截断');
  assert.ok(bridge.includes('function limitReplyBySpirit('), '缺少 limitReplyBySpirit');
  // 正常/DSH 两条提示词路线都要有（以前踩过「只改一边」）
  const spiritUses = bridge.match(/spiritSummary\(\),/g) || [];
  assert.ok(spiritUses.length >= 2, `两条提示词路线都该插入精神值，实际 ${spiritUses.length} 处`);
});

test('接线：睡觉/醒来会结算精神（进入晚安休眠 → 醒来按睡了几小时回填）', () => {
  const sleepAt = bridge.indexOf('function startNightSleep(');
  const startBlock = bridge.slice(sleepAt, sleepAt + 1200);
  assert.ok(startBlock.includes('spirit.sleep({ reason: source })'), 'startNightSleep 没有记入睡');

  const wakeAt = bridge.indexOf('function finishNightSleep(');
  const finishBlock = bridge.slice(wakeAt, wakeAt + 2600);
  assert.ok(finishBlock.includes('spirit.wake({ hours: sleptMs / 3600000 })'), 'finishNightSleep 没有按睡了多久结算');

  const cancelAt = bridge.indexOf('function cancelNightSleep(');
  const cancelBlock = bridge.slice(cancelAt, cancelAt + 900);
  assert.ok(cancelBlock.includes('spirit.wake({})'), '提前取消睡眠没有结算');

  // 进程重启时若还在睡眠窗口内，精神系统要跟着回到睡着
  assert.ok(bridge.includes('if (!snap.asleep) spirit.sleep({ reason: \'恢复晚安休眠\' });'), 'loadNightSleepState 没有恢复睡眠态');
});

test('接线：念头循环起来了，且聊天会花精神', () => {
  assert.ok(bridge.includes('startThoughtLoop();'), 'main 里没有启动念头循环');
  assert.ok(bridge.includes('function thoughtTick('), '缺少 thoughtTick');
  assert.ok(bridge.includes("scheduleWakeV2(key, 'proactiveCheck')"), '念头按捺不住时没有唤醒会话');
  assert.ok(bridge.includes("spendSpirit('chat', { key });"), '回一句话没有消耗精神');
});

test('接线：/api/socialV2/spirit 与 /api/socialV2/thoughts 可查可调', () => {
  assert.ok(bridge.includes("'/api/socialV2/spirit'"), '缺少精神值端点');
  assert.ok(bridge.includes("'/api/socialV2/thoughts'"), '缺少念头端点');
  assert.ok(bridge.includes("action === 'nap'"), '精神值端点不支持打盹');
  assert.ok(bridge.includes("action === 'sweet'"), '精神值端点不支持吃甜的');
});