// scripts/test-qqb-spirit.mjs —— 精神系统（qqb/persona/spirit.mjs）的回归测试。
//
// 这套东西是「活人化」重构的底座：聊天/看视频/唱歌都花精神，精神低了她会真的累、回得短，
// 只有睡够才能回满（指数曲线）。这里锁住几件事，防止以后被人「顺手改成加法」：
//   1. 睡觉回满是指数曲线 —— 睡一半最多回一大半，不能一觉就满；
//   2. 疲劳期（清醒超过 fullRestHours）消耗翻倍；
//   3. 甜食补精神但会饿，饿了反过来扣精神；
//   4. 睡着了不能主动做事（gate）；
//   5. 状态落盘，重启不丢。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSpirit, replyBudget, sleepRecovery } from '../src/qqb/persona/spirit.mjs';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-spirit-'));
  return path.join(dir, 'state', 'spirit.json');
}

/** 可控时钟：手动推进时间，避免测试等真时间。 */
function clock(start = 1790000000000) {
  let t = start;
  return {
    now: () => t,
    advance(hours) { t += Math.round(hours * 3600000); return t; },
  };
}

test('精神：回复预算按精神值分档（越累越短）', () => {
  assert.equal(replyBudget(0.1).maxChars, 24);
  assert.equal(replyBudget(0.3).maxChars, 36);
  assert.equal(replyBudget(0.5).maxChars, 60);
  assert.equal(replyBudget(0.7).maxChars, 90);
  assert.equal(replyBudget(0.9).maxChars, 120);
  // 单调：精神越高，能说的字越多
  const ladder = [0, 0.25, 0.4, 0.6, 0.8].map((s) => replyBudget(s).maxChars);
  assert.deepEqual(ladder, [...ladder].sort((a, b) => a - b));
});

test('精神：睡觉回满是指数曲线，睡一半回不满', () => {
  assert.equal(sleepRecovery(0.1, 8, 8), 1, '睡满 8 小时必须精确回到 1');
  const half = sleepRecovery(0.1, 4, 8);
  assert.ok(half > 0.7 && half < 1, `睡 4 小时应回到 0.7~1 之间，实际 ${half}`);
  const quarter = sleepRecovery(0.1, 2, 8);
  assert.ok(quarter < half, '睡得越少回得越少');
  assert.ok(sleepRecovery(0.1, 100, 8) === 1, '睡超过也算满');
});

test('精神：清醒时自然流失，睡着时不流失', () => {
  const c = clock();
  const spirit = createSpirit({ now: c.now, options: { drainPerHour: 0.1, hungerPerHour: 0, hungerPenalty: 0 } });
  const before = spirit.snapshot().spirit;
  c.advance(3);
  const after = spirit.snapshot();
  assert.ok(Math.abs((before - after.spirit) - 0.3) < 0.02, `3 小时应掉 0.3，实际掉 ${(before - after.spirit).toFixed(3)}`);

  spirit.sleep({});
  const sleptBefore = spirit.snapshot().spirit;
  c.advance(5);
  assert.equal(spirit.snapshot().spirit, sleptBefore, '睡着期间不该继续掉精神');
});

test('精神：睡了多久决定回多少（wake 按入睡到醒来的时长结算）', () => {
  const c = clock();
  const spirit = createSpirit({ now: c.now, options: { sleepHoursToFull: 8 } });
  spirit.setSpirit(0.2, { reason: '测试' });
  spirit.sleep({});
  c.advance(8);
  const full = spirit.wake({});
  assert.equal(full.spirit, 1);

  spirit.setSpirit(0.2, { reason: '测试' });
  spirit.sleep({});
  c.advance(3);
  const short = spirit.wake({});
  assert.ok(short.spirit < 1 && short.spirit > 0.6, `睡 3 小时应该回一部分（0.6~1），实际 ${short.spirit}`);
});

test('精神：疲劳期（清醒过久）消耗翻倍', () => {
  const c = clock();
  const spirit = createSpirit({ now: c.now, options: { fullRestHours: 12, drainPerHour: 0, hungerPerHour: 0 } });
  const fresh = spirit.cost('chat', { at: c.now() });
  c.advance(13); // 过了 fullRestHours
  const tired = spirit.cost('chat', { at: c.now() });
  assert.ok(tired.cost > fresh.cost * 1.5, `疲劳期代价应约翻倍：${fresh.cost} → ${tired.cost}`);
});

test('精神：甜食补精神但更饿，饿了反过来扣精神', () => {
  const c = clock();
  const spirit = createSpirit({ now: c.now, options: { hungerPerHour: 0, hungerPenalty: 0.2, drainPerHour: 0 } });
  spirit.setSpirit(0.4, { reason: '测试' });
  const afterSweet = spirit.sweet({ what: '糖' });
  assert.ok(Math.abs(afterSweet.spirit - 0.62) < 0.01);
  assert.ok(afterSweet.hunger > 0.4, '吃甜的会更饿');

  // 饿到 1 时，每小时的额外扣精神应当大于 0
  const greedy = createSpirit({
    now: c.now,
    options: { hungerPerHour: 0, hungerPenalty: 1, drainPerHour: 0, sweetRestore: 0, sweetHunger: 1 },
  });
  greedy.setSpirit(0.5, { reason: '测试' });
  greedy.sweet({}); // 饥饿拉满
  const before = greedy.snapshot().spirit;
  c.advance(1);
  assert.ok(greedy.snapshot().spirit < before, '饿到头会额外掉精神');
});

test('精神：睡着时不能主动做事（gate 拦住 proactive）', () => {
  const c = clock();
  const spirit = createSpirit({ now: c.now });
  spirit.sleep({ reason: '晚安' });
  const g = spirit.gate('proactive', { at: c.now() });
  assert.equal(g.allow, false);
  assert.match(g.reason, /睡着/);
  spirit.wake({ hours: 8 });
  assert.equal(spirit.gate('proactive', { at: c.now() }).allow, true);
});

test('精神：打盹有每日上限，状态落盘重启不丢', () => {
  const c = clock();
  const file = tempFile();
  const spirit = createSpirit({ file, now: c.now, options: { napDayCap: 0.05, napPerHour: 0.6 } });
  spirit.setSpirit(0.4, { reason: '测试' });
  const first = spirit.nap({ minutes: 30 });
  assert.ok(Math.abs(first.spirit - 0.45) < 0.01, `30 分钟应回 0.05，实际 ${(first.spirit - 0.4).toFixed(3)}`);
  const second = spirit.nap({ minutes: 30 });
  assert.ok(Math.abs(second.spirit - 0.45) < 0.01, '当日额度用完后再打盹不该再补');

  assert.ok(fs.existsSync(file), '应落盘到 state/spirit.json');
  const revived = createSpirit({ file, now: c.now });
  assert.ok(Math.abs(revived.snapshot().spirit - second.spirit) < 0.01, '重开应读回同一份精神值');
});

test('精神：状态文件坏了也不抛（按初始值继续）', () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  const spirit = createSpirit({ file });
  assert.ok(spirit.snapshot().spirit > 0);
});
test('精神：吃一顿能降饥饿（2026-10-29 之前只有 sweet，越吃越饿）', () => {
  const c = clock();
  const spirit = createSpirit({ now: c.now, options: { hungerPerHour: 0.2, hungerPenalty: 0, drainPerHour: 0 } });
  spirit.setSpirit(0.2, { reason: '测试' });
  c.advance(4); // 饥饿涨到 0.8
  const before = spirit.snapshot();
  assert.ok(before.hunger > 0.7, `先攒到 ${before.hunger} 再吃`);
  const fed = spirit.eat({ what: '午饭' });
  assert.ok(Math.abs(fed.hunger - (before.hunger - 0.35)) < 0.001, '吃一顿要降 0.35 饥饿');
  assert.ok(Math.abs(fed.spirit - (before.spirit + 0.04)) < 0.001, '吃一顿要补一点点精神');
  // 一路吃到空腹就停在 0，不会变负
  for (let i = 0; i < 6; i += 1) spirit.eat();
  assert.equal(spirit.snapshot().hunger, 0);
});

test('精神：一天不该全天见底（默认参数下的曲线）', () => {
  const c = clock();
  const spirit = createSpirit({ now: c.now });
  spirit.setSpirit(1, { reason: '醒来' });
  spirit.wake({ hours: 8 });
  // 每 5 小时吃一顿，模拟她白天会吃饭
  for (let h = 5; h <= 15; h += 5) {
    c.advance(5);
    spirit.eat();
  }
  c.advance(1);
  const s = spirit.snapshot();
  assert.ok(s.spirit > 0.35, `清醒 16 小时、中间吃三顿，精神应还在 0.35 以上，实际 ${s.spirit.toFixed(2)}`);
  assert.ok(s.hunger < 0.9, `吃过饭饥饿不该顶在 1，实际 ${s.hunger.toFixed(2)}`);
});

test('精神：桥接自己会吃饭、白天会打盹（不再只靠面板手动点）', () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.ok(src.includes('spirit.eat({ what: meal })'), '心跳里应自己吃饭');
  assert.ok(src.includes("before.hunger > 0.7"), '饿了才吃');
  assert.ok(src.includes('spirit.nap({ minutes: 40 })'), '白天累了应打个盹');
  assert.ok(src.includes('idleMs > 45 * 60000'), '打盹前要确认没人找她（别聊到一半睡着）');
  assert.ok(src.includes('napToday ?? 0) < 0.2'), '当日额度快用完就别再打盹（补 0 也要记一条日志很蠢）');
  assert.ok(src.includes("action === 'eat'"), 'POST /api/socialV2/spirit 支持 eat');
  assert.ok(src.includes('let lastInboundAt = 0;') && src.includes('lastInboundAt = Date.now();'), '要记最后一次有人说话的时间');
});

test('饥饿：能手动设（面板/调试），set 只传 hunger 不会把精神改掉', () => {
  const c = clock();
  const sp = createSpirit({ now: c.now, options: { drainPerHour: 0, hungerPerHour: 0, hungerPenalty: 0 } });
  sp.setSpirit(0.66, { reason: '测试' });
  const before = sp.snapshot();
  const r = sp.setHunger(0.35, { reason: '测试' });
  const after = sp.snapshot();
  assert.equal(r.ok, true);
  assert.ok(Math.abs(after.hunger - 0.35) < 0.01, `饥饿应设为 0.35，实际 ${after.hunger}`);
  assert.ok(Math.abs(after.spirit - before.spirit) < 0.02, `精神不该被 hunger 带跑：${before.spirit} → ${after.spirit}`);
  assert.equal(sp.setHunger('abc').ok, false);
  assert.ok(Math.abs(sp.setHunger(5).hunger - 1) < 1e-6, '超界夹到 1');

  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.ok(src.includes('spirit.setHunger(body.hunger'), 'set 动作要支持 hunger');
  assert.ok(src.includes("if (body.spirit != null) result.spirit = spirit.setSpirit"), 'spirit 与 hunger 分开设');
});
