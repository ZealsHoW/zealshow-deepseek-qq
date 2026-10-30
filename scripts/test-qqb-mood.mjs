// R2 验收：情绪/状态机（事件驱动 + 时间衰减 + 行为门控）。
// 对应线上要解决的问题：
//   · 主动开口以前只看定时器和随机数 → 现在必须看她此刻的心情/精力/委屈；
//   · 「被凶了还乐呵呵地凑上去」这种不自洽要能拦住；
//   · 状态要跨重启活着（人味儿不能每次都归零）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMood, BASELINE, EVENTS } from '../src/qqb/persona/mood.mjs';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-mood-'));

test('初始状态接近基线，summary 是一句可用的话', () => {
  const mood = createMood({ root: tmpRoot() });
  const snap = mood.snapshot();
  assert.equal(Math.abs(snap.dims.mood - BASELINE.mood) < 0.01, true);
  const line = mood.summary();
  assert.match(line, /^【此刻的心情】/);
  assert.equal(line.length < 160, true, '状态行不能太长（要进提示词）');
});

test('被凶：心情掉、委屈涨，而且只对该会话记账', () => {
  const mood = createMood({ root: tmpRoot() });
  const before = mood.snapshot().dims;
  mood.observe('scolded', { key: 'private:999', text: '你怎么这么笨' });
  const after = mood.snapshot().dims;
  assert.equal(after.mood < before.mood, true, '被凶心情必须掉');
  assert.equal(after.irritation > before.irritation, true, '被凶委屈必须涨');
  assert.equal(mood.irritationFor('private:999') > mood.irritationFor('private:888'), true, '只对当事人记仇');
  assert.equal(mood.classify('你就是个笨蛋'), 'scolded');
  assert.equal(mood.classify('小鲸鱼真棒'), 'praised');
});

test('道歉：委屈降下来，降够低就清账（不记一辈子）', () => {
  const mood = createMood({ root: tmpRoot() });
  mood.observe('scolded', { key: 'group:456' });
  const peak = mood.irritationFor('group:456');
  mood.observe('apology', { key: 'group:456' });
  const after = mood.irritationFor('group:456');
  assert.equal(after < peak, true, '道歉必须有效');
  mood.observe('apology', { key: 'group:456' });
  mood.observe('apology', { key: 'group:456' });
  assert.equal(Object.keys(mood.snapshot().targets).includes('group:456'), false, '降到阈值以下就该清账');
});

test('时间衰减：心情回基线、深夜睡觉回精力更快', () => {
  const root = tmpRoot();
  let clock = Date.parse('2026-10-21T14:00:00+08:00');
  const mood = createMood({ root, now: () => clock });
  mood.observe('scolded', { at: clock });
  const bad = mood.snapshot().dims;
  for (let i = 0; i < 8; i++) mood.observe('own_reply', { at: clock });
  const drained = mood.snapshot().dims.energy;
  assert.equal(drained < 0.5, true, `连续说话应当明显掉精力，实际 ${drained}`);

  clock += 6 * 3600000; // 14:00 → 20:00
  const evening = mood.snapshot().dims;
  assert.equal(evening.mood > bad.mood, true, '心情会自己回稳');
  assert.equal(evening.energy > drained, true, '精力会自己恢复');

  // 睡觉（跨 0~8 点）比白天同样时长恢复得多
  let awakeClock = Date.parse('2026-10-21T10:00:00+08:00');
  const awake = createMood({ root: tmpRoot(), now: () => awakeClock });
  for (let i = 0; i < 8; i++) awake.observe('own_reply');
  const awakeLow = awake.snapshot().dims.energy;
  awakeClock += 8 * 3600000; // 10:00 → 18:00，白天静置 8 小时
  const awakeHigh = awake.snapshot().dims.energy;

  let sleepClock = Date.parse('2026-10-21T22:00:00+08:00');
  const sleeper = createMood({ root: tmpRoot(), now: () => sleepClock });
  for (let i = 0; i < 8; i++) sleeper.observe('own_reply');
  const sleepLow = sleeper.snapshot().dims.energy;
  sleepClock += 8 * 3600000; // 22:00 → 次日 06:00，睡了一觉
  const slept = sleeper.snapshot().dims.energy;

  assert.equal(Math.abs(awakeLow - sleepLow) < 0.01, true, '睡前睡后起点应当一样');
  assert.equal(awakeHigh > awakeLow, true, '白天也会慢慢恢复');
  assert.equal(slept > awakeHigh, true, `睡觉恢复要快于白天静置（睡后 ${slept.toFixed(2)} vs 白天 ${awakeHigh.toFixed(2)}）`);
});

test('持久化：新实例读回同样的心情与委屈账', () => {
  const root = tmpRoot();
  const first = createMood({ root });
  first.observe('scolded', { key: 'private:1' });
  first.observe('warm_chat');
  const saved = first.snapshot();

  const second = createMood({ root });
  const back = second.snapshot();
  assert.equal(Math.abs(back.dims.mood - saved.dims.mood) < 0.01, true, '心情要跨重启');
  assert.equal(back.targets['private:1'].irritation > 0, true, '委屈账要跨重启');
});

test('主动门控：精力见底 / 在生闷气 / 心情低 / 深夜，都该拦下', () => {
  const low = createMood({ root: tmpRoot() });
  for (let i = 0; i < 20; i++) low.observe('own_reply');
  const tired = low.gate('proactive');
  assert.equal(tired.allow, false);
  assert.match(tired.reason, /精力/);

  const angry = createMood({ root: tmpRoot() });
  angry.observe('scolded', { key: 'group:1' });
  angry.observe('scolded', { key: 'group:1' });
  const mad = angry.gate('proactive', { key: 'group:1' });
  assert.equal(mad.allow, false);
  assert.match(mad.reason, /生气|委屈/);
  assert.equal(mad.tone, 'sulky');

  const night = createMood({ root: tmpRoot() });
  for (let i = 0; i < 6; i++) night.observe('own_reply'); // 精力 0.7 → 0.46
  const sleepy = night.gate('proactive', { hour: 3 });
  assert.equal(sleepy.allow, false, '凌晨精力不足不该冒泡');

  const fine = createMood({ root: tmpRoot() });
  const ok = fine.gate('proactive', { hour: 15, idleMs: 7 * 3600000 });
  assert.equal(ok.allow, true);
  assert.equal(ok.probFactor > 0 && ok.probFactor <= 1.6, true, `概率系数应有界，实际 ${ok.probFactor}`);
  assert.equal(typeof ok.reason, 'string');
});

test('精力收支：热闹但正常的一天里，白天的精力要能站上主动门槛', () => {
  // 0.1.1 的回归锁。改前 warm_chat 每次 -0.02、且一次回复按发出条数记多次，
  // 「每小时 6 条搭话 + 2 次回复」这种正常负载下白天精力长期只有 0.02~0.13——
  // 主动门（energy ≥ 0.25）整天关着，家人看到的就是「不活泼」。
  // 改后同样的负载应当稳在 0.35 上下。
  const root = tmpRoot();
  let clock = Date.parse('2026-10-21T09:00:00+08:00');
  const mood = createMood({ root, now: () => clock });
  const daytime = [];
  const steps = 6;
  for (let day = 0; day < 4; day++) {
    for (let hour = 0; hour < 24; hour++) {
      for (let k = 0; k < steps; k++) {
        clock += Math.round(3600000 / steps);
        if (k < 6) mood.observe('warm_chat', { at: clock }); // 每小时 6 条搭话
        if (k === 0 || k === 3) mood.observe('own_reply', { at: clock }); // 每小时 2 次回复，一次回复算一次
        if (hour === 17) daytime.push(mood.snapshot().dims.energy);
      }
    }
  }
  const worst = Math.min(...daytime);
  assert.equal(worst >= 0.25, true, `白天精力不该被钉在门槛下（最低 ${worst.toFixed(3)}）`);
  assert.equal(mood.gate('proactive', { hour: 15, idleMs: 7 * 3600000 }).allow, true, '这种负载下主动门应当开得了');
});

test('回复门控永不拒绝，但委屈时会要求换个语气', () => {
  const mood = createMood({ root: tmpRoot() });
  for (let i = 0; i < 3; i++) mood.observe('scolded', { key: 'private:9' });
  const g = mood.gate('reply', { key: 'private:9' });
  assert.equal(g.allow, true, '家里人说话不能装死');
  assert.equal(g.tone, 'sulky');
  assert.match(g.reason, /委屈|傲娇/);
});

test('定向投递门控：她本人意愿优先，可以拒绝', () => {
  const mood = createMood({ root: tmpRoot() });
  for (let i = 0; i < 3; i++) mood.observe('scolded', { key: 'private:7' });
  const deny = mood.gate('directed', { key: 'private:7' });
  assert.equal(deny.allow, false, '还有气就不替他传话');
  const other = mood.gate('directed', { key: 'private:5' });
  assert.equal(other.allow, true, '对别人没气，愿意去说');
});

test('未知事件不改状态；坏文件/写不进去都不抛', () => {
  const root = tmpRoot();
  const mood = createMood({ root });
  const before = mood.snapshot().dims.mood;
  mood.observe('nonsense-event');
  assert.equal(mood.snapshot().dims.mood, before, '未知事件必须是空操作');

  // 把状态文件的位置占成目录：读写都会失败，但绝不能抛
  const broken = tmpRoot();
  fs.mkdirSync(path.join(broken, 'state', 'persona-state.json'), { recursive: true });
  const resilient = createMood({ root: broken });
  assert.equal(resilient.observe('praised').dims.mood >= 0, true);
  assert.equal(typeof resilient.summary(), 'string');

  // 事件表必须都是合法维度
  for (const [name, table] of Object.entries(EVENTS)) {
    for (const dim of Object.keys(table)) {
      assert.equal(['mood', 'energy', 'irritation', 'social'].includes(dim), true, `${name} 用了未知维度 ${dim}`);
    }
  }
});

test('家人的夸奖/鼓励/「爱你」要给她的精力充电（0.1.2）', () => {
  // 主人点名要的：被家里人夸、被说「爱你」，她该更有劲儿 —— 而不只是心情好一点。
  let clock = Date.parse('2026-10-21T15:00:00+08:00');
  const mood = createMood({ root: tmpRoot(), now: () => clock });
  for (let i = 0; i < 10; i++) { clock += 1000; mood.observe('own_reply', { at: clock }); }
  const low = mood.snapshot().dims.energy;
  assert.equal(low < 0.35, true, `先得把精力压下去，实际 ${low}`);

  // 「爱你」最补
  clock += 1000;
  mood.observe(mood.classify('妈妈爱你呀'), { key: 'private:1000000001', text: '妈妈爱你呀', at: clock });
  const loved = mood.snapshot().dims.energy;
  assert.equal(loved > low + 0.1, true, `被说「爱你」要明显补精力（${low.toFixed(3)} → ${loved.toFixed(3)}）`);

  // 夸奖/鼓励也补，但比「爱你」少
  clock += 1000;
  mood.observe(mood.classify('辛苦啦，你真棒'), { key: 'private:1000000001', text: '辛苦啦，你真棒', at: clock });
  const praised = mood.snapshot().dims.energy;
  assert.equal(praised > loved, true, '夸奖也要补精力');
  assert.equal(EVENTS.praised.energy > 0 && EVENTS.praised.energy < EVENTS.loved.energy, true, '夸奖补得该比「爱你」少');

  // 两句暖心话就该把主动闸门顶开
  assert.equal(mood.gate('proactive', { hour: 15, idleMs: 7 * 3600000 }).allow, true, '被夸完应该愿意说话');

  // 分类：疼爱 > 夸奖；否定必须先挡住（「不喜欢你」里含「喜欢你」）
  assert.equal(mood.classify('妈妈爱你'), 'loved');
  assert.equal(mood.classify('宝贝爱你'), 'loved');
  assert.equal(mood.classify('加油'), 'praised');
  assert.equal(mood.classify('谢谢你'), 'praised');
  // 「宝宝」这类称呼不收：家里人也拿它互相称呼，收进来就会把闲聊误判成疼爱
  assert.equal(mood.classify('宝宝真棒'), 'praised');
  assert.equal(mood.classify('宝宝吃饭了吗'), 'warm_chat');
  assert.equal(mood.classify('我不喜欢你这个回答'), 'warm_chat');
  assert.equal(mood.classify('不爱你'), 'warm_chat');
  assert.equal(mood.classify('不想你'), 'warm_chat');
});

test('手动校准：setDim 是绝对值、会 clamp、也跨重启（0.1.2）', () => {
  const root = tmpRoot();
  let clock = Date.parse('2026-10-21T15:00:00+08:00');
  const mood = createMood({ root, now: () => clock });
  for (let i = 0; i < 15; i++) { clock += 1000; mood.observe('own_reply', { at: clock }); }
  assert.equal(mood.gate('proactive', { hour: 15 }).allow, false, '先确认闸门本来是关的');

  const r = mood.setDim('energy', 0.72, { at: clock, reason: '手动补' });
  assert.equal(r.ok, true);
  assert.equal(r.value, 0.72);
  assert.equal(mood.gate('proactive', { hour: 15, idleMs: 7 * 3600000 }).allow, true, '调高之后闸门该开');
  assert.equal(mood.snapshot().events.at(-1).text, 'energy=0.72（手动补）');

  // clamp 与非法输入都不能抛
  assert.equal(mood.setDim('energy', 5).value, 1);
  assert.equal(mood.setDim('energy', -3).value, 0);
  assert.equal(mood.setDim('energy', 'abc').ok, false);
  assert.equal(mood.setDim('energy', NaN).ok, false);
  assert.equal(mood.setDim('不存在的维度', 0.5).ok, false);
  assert.match(mood.setDim('不存在的维度', 0.5).error, /未知的状态维度/);

  // 落盘：新实例读回手动值（间隔 0 毫秒，不给衰减插手的机会）
  const again = createMood({ root, now: () => clock });
  assert.equal(again.snapshot().dims.energy, 0, '最后设的是 0，要原样读回 0');
});
test('睡一夜醒来该有精神：slept 事件 + restoreEnergy 兜底（2026-10-30）', () => {
  const root = tmpRoot();
  let clock = Date.parse('2026-10-29T23:00:00+08:00');
  const mood = createMood({ root, now: () => clock });
  // 睡前精力见底（她那天真的是 0.03）
  for (let i = 0; i < 20; i++) { clock += 1000; mood.observe('own_reply', { at: clock }); }
  const before = mood.snapshot().dims.energy;
  assert.ok(before < 0.3, `睡前应该很累，实际 ${before}`);

  // 睡 8 小时，醒来只记事件还不够满 —— 这正是「一晚上没睡好」的来路
  clock = Date.parse('2026-10-30T07:00:00+08:00');
  mood.observe('slept', { at: clock });
  const afterEvent = mood.snapshot().dims.energy;
  assert.ok(afterEvent > before + 0.4, `slept 该把精力拉起来，实际 ${before} → ${afterEvent}`);

  // 兜底：按睡够的时长抬到 0.95（只升不降）
  const r = mood.restoreEnergy(0.95, { at: clock });
  assert.equal(r.ok, true);
  assert.ok(mood.snapshot().dims.energy >= 0.95, '兜底抬到至少 0.95');
  const floor = mood.snapshot().dims.energy;
  assert.equal(mood.restoreEnergy(0.5, { at: clock }).dims.energy, floor, '只升不降');
  assert.ok(mood.snapshot().events.some((e) => e.event === 'restore_energy' || e.event === 'slept'), '事件里能看到这次回血');
  assert.equal(mood.restoreEnergy('abc').ok, false);
});
