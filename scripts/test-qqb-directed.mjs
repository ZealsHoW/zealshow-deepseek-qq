// R8 定向投递：解析 + 队列 + 状态机 + 落盘（node:test，真文件、可控时钟）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDirected, parseDirective, DEFAULT_ALIASES, STATUSES, VERSION } from '../src/qqb/directed/direct.mjs';

function tmpRoot(tag = 'directed') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qq-directed-${tag}-`));
}

test('版本与别名表自洽', () => {
  assert.equal(VERSION, '0.1.0');
  assert.ok(STATUSES.includes('pending') && STATUSES.includes('expired'));
  for (const alias of DEFAULT_ALIASES) {
    assert.ok(alias.name && alias.id && alias.kind);
    assert.ok(Array.isArray(alias.words) && alias.words.length > 0);
  }
});

test('解析：给谁 + 托付语气 + 意图与紧急度', () => {
  const a = parseDirective('你去给妈妈发个消息，问问她晚上回不回来吃饭');
  assert.equal(a.matched, true);
  assert.equal(a.target.name, '妈妈');
  assert.equal(a.target.id, '1000000002');
  assert.equal(a.target.kind, 'private');
  assert.match(a.intent, /晚上回不回来吃饭/);
  assert.equal(a.urgency, 'normal');

  const b = parseDirective('帮我跟爸爸说一声我今晚不回去吃饭了，赶紧的');
  assert.equal(b.matched, true);
  assert.equal(b.target.id, '1000000001');
  assert.match(b.intent, /今晚不回去吃饭/);
  assert.equal(b.urgency, 'high');

  const c = parseDirective('帮我在家庭群里说一下晚安');
  assert.equal(c.matched, true);
  assert.equal(c.target.kind, 'group');
  assert.equal(c.target.id, '900000001');
  assert.equal(c.intent, '晚安');

  const d = parseDirective('去给 1000000003 发个消息，问他在忙啥');
  assert.equal(d.matched, true);
  assert.equal(d.target.id, '1000000003');
  assert.equal(d.target.kind, 'private');
});

test('解析：日常闲聊不误判', () => {
  assert.equal(parseDirective('妈妈说一会儿回来').matched, false);
  assert.equal(parseDirective('今天天气不错').matched, false);
  assert.equal(parseDirective('晚安').matched, false);
  assert.equal(parseDirective('我去给花浇点水').matched, false);
});

test('只有主人能创建；任务落盘并能读回', () => {
  const root = tmpRoot('create');
  const q = createDirected({ root, logger: { warn() {} } });
  const denied = q.create({ from: 'group', originKey: 'group:1', target: { kind: 'private', id: '1', name: 'x' }, intent: 'hi' });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /只能由主人/);

  const made = q.create({ originKey: 'private:1000000001', target: { kind: 'private', id: '1000000002', name: '妈妈' }, intent: '问她晚上回不回来吃饭', raw: '你去给妈妈发个消息', urgency: 'normal' });
  assert.equal(made.ok, true);
  assert.equal(made.directive.status, 'pending');
  assert.equal(q.pending().length, 1);

  const again = createDirected({ root, logger: { warn() {} } });
  assert.equal(again.loaded, 1);
  const back = again.get(made.directive.id);
  assert.equal(back.target.name, '妈妈');
  assert.equal(back.intent, '问她晚上回不回来吃饭');
  assert.equal(back.status, 'pending');
  fs.rmSync(root, { recursive: true, force: true });
});

test('待办上限：满了就不再收', () => {
  const root = tmpRoot('limit');
  const q = createDirected({ root, maxPending: 1, logger: { warn() {} } });
  assert.equal(q.create({ target: { kind: 'private', id: '1', name: 'a' }, intent: 'x' }).ok, true);
  const second = q.create({ target: { kind: 'private', id: '2', name: 'b' }, intent: 'y' });
  assert.equal(second.ok, false);
  assert.match(second.error, /待办太多/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('她可以答应（用自己的话）或拒绝，决定后不能再改', () => {
  const root = tmpRoot('decide');
  let clock = Date.parse('2026-10-21T04:00:00+08:00');
  const q = createDirected({ root, now: () => clock, logger: { warn() {} } });
  const made = q.create({ originKey: 'private:1000000001', target: { kind: 'private', id: '1000000002', name: '妈妈' }, intent: '问她晚上回不回来吃饭', raw: '你去给妈妈发个消息' });
  const id = made.directive.id;

  clock += 60_000;
  const own = '妈，晚上回来吃饭不？我这边给你留了菜～'; // 她按自己的语气重写，不是复述原话
  const accepted = q.decide({ id, action: 'accept', text: own });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.directive.status, 'accepted');
  assert.equal(accepted.directive.finalText, own);
  assert.notEqual(accepted.directive.finalText, accepted.directive.intent);

  const twice = q.decide({ id, action: 'decline', reason: '反悔了' });
  assert.equal(twice.ok, false);
  assert.match(twice.error, /accepted/);

  const sent = q.markSent({ id, text: own, result: { ok: true } });
  assert.equal(sent.ok, true);
  assert.equal(sent.directive.status, 'sent');
  assert.ok(sent.directive.sentAt >= clock);

  const second = q.create({ target: { kind: 'private', id: '1000000001', name: '爸爸' }, intent: '说晚安' });
  const declined = q.decide({ id: second.directive.id, action: 'decline', reason: '今天不太想说话' });
  assert.equal(declined.directive.status, 'declined');
  assert.equal(declined.directive.reason, '今天不太想说话');
  fs.rmSync(root, { recursive: true, force: true });
});

test('撤回：只有待决的能撤；发送失败进 failed', () => {
  const root = tmpRoot('withdraw');
  const q = createDirected({ root, logger: { warn() {} } });
  const a = q.create({ target: { kind: 'private', id: '1', name: 'a' }, intent: 'x' });
  assert.equal(q.withdraw({ id: a.directive.id, reason: '主人撤回' }).directive.status, 'withdrawn');
  assert.equal(q.withdraw({ id: a.directive.id }).ok, false);

  const b = q.create({ target: { kind: 'group', id: '2', name: '群' }, intent: 'y' });
  assert.equal(q.decide({ id: b.directive.id, action: 'accept', text: '大家好' }).directive.status, 'accepted');
  assert.match(q.withdraw({ id: b.directive.id }).error, /撤不回来/);

  const failed = q.markFailed({ id: b.directive.id, error: 'SnowLuma 未连接' });
  assert.equal(failed.directive.status, 'failed');
  assert.equal(failed.directive.reason, 'SnowLuma 未连接');
  fs.rmSync(root, { recursive: true, force: true });
});

test('过期：挂太久自动收尾，新的不动', () => {
  const root = tmpRoot('expire');
  let clock = Date.parse('2026-10-21T04:00:00+08:00');
  const q = createDirected({ root, now: () => clock, ttlMs: 30 * 60 * 1000, logger: { warn() {} } });
  const old = q.create({ target: { kind: 'private', id: '1', name: 'a' }, intent: 'x' });
  clock += 31 * 60 * 1000;
  const fresh = q.create({ target: { kind: 'private', id: '2', name: 'b' }, intent: 'y' });
  const expired = q.expire();
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, old.directive.id);
  assert.equal(expired[0].status, 'expired');
  assert.equal(q.get(fresh.directive.id).status, 'pending');
  fs.rmSync(root, { recursive: true, force: true });
});

test('统计与别名表；坏文件不影响使用', () => {
  const root = tmpRoot('stats');
  const q = createDirected({ root, logger: { warn() {} } });
  const a = q.create({ target: { kind: 'private', id: '1', name: 'a' }, intent: 'x' });
  q.decide({ id: a.directive.id, action: 'decline', reason: '不' });
  q.create({ target: { kind: 'private', id: '2', name: 'b' }, intent: 'y' });
  const stats = q.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.pending, 1);
  assert.equal(stats.byStatus.declined, 1);
  assert.ok(q.aliasTable().some((x) => x.name === '妈妈'));

  const bad = tmpRoot('bad');
  fs.mkdirSync(path.join(bad, 'state', 'directives.jsonl'), { recursive: true }); // 路径被占成目录
  const q2 = createDirected({ root: bad, logger: { warn() {} } });
  const made = q2.create({ target: { kind: 'private', id: '1', name: 'a' }, intent: 'x' });
  assert.equal(made.ok, true); // 内存里仍然能建
  assert.equal(q2.pending().length, 1);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(bad, { recursive: true, force: true });
});
test('追办：答应了不动手会被叫醒，且不许编「已经发了」', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'bridge.js'), 'utf8');
  // 托付注入块把口径写死：这一轮就调工具、没工具返回不许说做了
  assert.ok(src.includes('要办就**这一轮直接调工具**办掉'));
  assert.ok(src.includes('只在文字里说「我去发」不算做过'));
  // 入队后挂追办计时器，到点还没定夺就叫醒
  assert.ok(src.includes('runtimeHooks.directiveNudge = (key, id) =>'));
  assert.ok(src.includes("scheduleWakeV2(key, `directiveFollowUp:${id}`)"));
  assert.ok(src.includes("'directiveFollowUp']"));
  // 追办那一轮的提示词明说「还没动手」，并禁止编造结果
  assert.ok(src.includes("reason.startsWith('directiveFollowUp')"));
  assert.ok(src.includes('不许编「已经发了」'));
  // 全局铁律：做过才许说做过
  assert.ok(src.includes('【做过才许说做过】'));
});
