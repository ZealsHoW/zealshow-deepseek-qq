// 记忆库（R1）回归：分层隔离、重复合并、配额节流、软删除/复活、过期、人设审计、持久化。
//
// 全部走临时目录里的真 SQLite（node:sqlite），不碰 state/memory.db。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { LAYERS, openStore } from '../src/qqb/memory/store.mjs';

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqb-mem-${label}-`));
}

/** 可控时钟：配额窗口与时间衰减都要能确定性地推进。 */
function clockAt(iso) {
  let ms = Date.parse(iso);
  return { now: () => ms, advance(deltaMs) { ms += deltaMs; return ms; }, set(iso2) { ms = Date.parse(iso2); } };
}

test('记忆库：分层与 scope 隔离（群聊里召不到私聊记忆）', () => {
  const clock = clockAt('2026-10-21T03:00:00+08:00');
  const store = openStore({ root: tmpdir('layers'), now: clock.now });
  try {
    assert.deepEqual([...LAYERS], ['private', 'normal', 'group']);
    assert.equal(store.remember({ layer: 'private', scope: 'private:1000000001', kind: 'fact', text: '爸爸喜欢喝无糖可乐' }).action, 'inserted');
    store.remember({ layer: 'group', scope: 'group:900000001', kind: 'topic', text: '大家在聊装修' });
    store.remember({ layer: 'normal', scope: 'private:1000000003', kind: 'fact', text: '朋友在准备考试' });
    store.remember({ layer: 'normal', scope: 'global', kind: 'preference', text: '她喜欢被人叫小鲸鱼' });

    const privateHit = store.recall({ scope: 'private:1000000001', query: '可乐' });
    assert.equal(privateHit.length, 1);
    assert.equal(privateHit[0].layer, 'private');

    // 群聊窗口：只能看到群里的 + global，看不到别人的私聊。
    const groupHit = store.recall({ scope: 'group:900000001', query: '' });
    assert.deepEqual(groupHit.map((item) => item.text).sort(), ['大家在聊装修', '她喜欢被人叫小鲸鱼']);

    // 别人的私聊窗口：看不到爸爸那条。
    const friendHit = store.recall({ scope: 'private:1000000003', query: '' });
    assert.ok(friendHit.every((item) => !item.text.includes('可乐')));

    // 分层过滤
    const onlyGroup = store.recall({ scope: 'group:900000001', layers: ['group'], query: '' });
    assert.deepEqual(onlyGroup.map((item) => item.text), ['大家在聊装修']);
  } finally {
    store.close();
  }
});

test('记忆库：allScopes 跨会话召回（她主动检索用），默认仍按 scope 隔离', () => {
  const clock = clockAt('2026-10-21T03:00:00+08:00');
  const store = openStore({ root: tmpdir('cross'), now: clock.now });
  try {
    store.remember({ layer: 'private', scope: 'private:1000000001', kind: 'fact', text: '爸爸喜欢喝无糖可乐' });
    store.remember({ layer: 'group', scope: 'group:900000001', kind: 'topic', text: '大家在聊装修' });
    store.remember({ layer: 'normal', scope: 'private:1000000003', kind: 'fact', text: '朋友在准备考试' });
    store.remember({ layer: 'normal', scope: 'global', kind: 'preference', text: '她喜欢被人叫小鲸鱼' });

    // 群里问起「可乐」：默认窗口里那条私聊记忆仍然不可见（提示词注入不跨会话）。
    assert.deepEqual(store.recall({ scope: 'group:900000001', query: '可乐' }), []);

    // 她主动跨会话检索：能查到爸爸私聊里的那条，并且带 scope/where 来源。
    const across = store.recall({ scope: 'group:900000001', allScopes: true, query: '可乐' });
    assert.equal(across.length, 1);
    assert.equal(across[0].scope, 'private:1000000001');

    const all = store.recall({ scope: 'group:900000001', allScopes: true, query: '' });
    assert.equal(all.length, 4, 'allScopes 不受 scope 限制');
    assert.deepEqual(all.map((item) => item.scope).sort(), ['global', 'group:900000001', 'private:1000000001', 'private:1000000003']);

    // 只给 allScopes、不给 scope 也一样（= 全库）。
    assert.equal(store.recall({ allScopes: true, query: '' }).length, 4);

    // 最近记忆也支持跨会话（人名簿靠它列「我认识谁」时不会串门）。
    assert.equal(store.recentMemories({ scope: 'group:900000001', allScopes: true }).length, 4);
    assert.equal(store.recentMemories({ scope: 'group:900000001' }).length, 2, '不传 allScopes 仍是群 + global');
  } finally {
    store.close();
  }
});

test('记忆库：重复事实合并（含空格/大小写归一），不同 scope/kind 不合并', () => {
  const clock = clockAt('2026-10-21T03:00:00+08:00');
  const store = openStore({ root: tmpdir('dedup'), now: clock.now });
  try {
    const first = store.remember({ layer: 'normal', scope: 'group:1', kind: 'fact', text: '爸爸  喜欢 无糖可乐', importance: 0.4 });
    assert.equal(first.action, 'inserted');
    clock.advance(60_000);
    const second = store.remember({ layer: 'normal', scope: 'group:1', kind: 'fact', text: '爸爸 喜欢 无糖可乐', importance: 0.8, evidence: '10-21 中午说的' });
    assert.equal(second.action, 'merged');
    assert.equal(second.id, first.id);
    assert.equal(second.importance, 0.8, '合并时取更高的 importance');

    const row = store.get(first.id);
    assert.equal(row.use_count, 1, '合并会累加使用次数');
    assert.equal(row.evidence, '10-21 中午说的');
    assert.equal(store.stats().total, 1, '合并后仍然只有一行');
    assert.equal(store.merges().length, 1, '合并要留痕');
    assert.match(store.merges()[0].incoming_text, /无糖可乐/);

    // 大小写（英文事实）也归一
    store.remember({ layer: 'normal', scope: 'group:1', kind: 'fact', text: 'KEEP CALM' });
    assert.equal(store.remember({ layer: 'normal', scope: 'group:1', kind: 'fact', text: 'keep calm' }).action, 'merged');

    // 同文本但 scope / kind 不同 → 各自独立
    assert.equal(store.remember({ layer: 'normal', scope: 'group:2', kind: 'fact', text: '爸爸 喜欢 无糖可乐' }).action, 'inserted');
    assert.equal(store.remember({ layer: 'normal', scope: 'group:1', kind: 'diary', text: '爸爸 喜欢 无糖可乐' }).action, 'inserted');
    assert.equal(store.stats().total, 4, '同一句话在 4 个 (layer|scope|kind) 桶里各占一行');
  } finally {
    store.close();
  }
});

test('记忆库：软删除、复活、过期与非法输入', () => {
  const clock = clockAt('2026-10-21T03:00:00+08:00');
  const store = openStore({ root: tmpdir('forget'), now: clock.now });
  try {
    const kept = store.remember({ layer: 'normal', scope: 'global', kind: 'fact', text: '她怕黑' });
    assert.equal(store.forget(kept.id, { reason: '说错了' }), true);
    assert.equal(store.forget(kept.id), false, '重复删除返回 false');
    assert.equal(store.recall({ scope: 'global', query: '怕黑' }).length, 0);
    assert.equal(store.stats().total, 0);
    assert.equal(store.stats().deleted, 1);

    const revived = store.remember({ layer: 'normal', scope: 'global', kind: 'fact', text: '她怕黑' });
    assert.equal(revived.action, 'revived');
    assert.equal(revived.id, kept.id, '复活复用同一个 id，避免 id 膨胀');
    assert.equal(store.recall({ scope: 'global', query: '怕黑' }).length, 1);

    // 过期记忆不再召回
    store.remember({ layer: 'normal', scope: 'global', kind: 'event', text: '明天要去医院', expiresAt: clock.now() - 1 });
    assert.equal(store.recall({ scope: 'global', query: '医院' }).length, 0);

    assert.equal(store.remember({ layer: 'secret', scope: 'global', kind: 'fact', text: '分层不存在' }).reason, '未知分层：secret');
    assert.equal(store.remember({ layer: 'normal', scope: 'global', kind: 'nope', text: '类型不存在' }).reason, '未知类型：nope');
    assert.equal(store.remember({ layer: 'normal', scope: 'global', kind: 'fact', text: 'x' }).reason, '内容太短');
  } finally {
    store.close();
  }
});

test('记忆库：LLM 提炼配额节流，窗口滚动后恢复；手工写入不受限', () => {
  const clock = clockAt('2026-10-21T03:00:00+08:00');
  const store = openStore({ root: tmpdir('budget'), now: clock.now, extractLimit: 2, extractWindowMs: 60 * 60 * 1000 });
  try {
    assert.equal(store.remember({ layer: 'normal', scope: 'group:9', kind: 'fact', text: '第一条提炼', source: 'llm-extract' }).action, 'inserted');
    assert.equal(store.remember({ layer: 'normal', scope: 'group:9', kind: 'fact', text: '第二条提炼', source: 'llm-extract' }).action, 'inserted');
    const third = store.remember({ layer: 'normal', scope: 'group:9', kind: 'fact', text: '第三条提炼', source: 'llm-extract' });
    assert.equal(third.action, 'rejected');
    assert.match(third.reason, /配额/);
    assert.ok(third.resetAt > clock.now());

    // 配额按 scope 记账：别的会话不受影响
    assert.equal(store.remember({ layer: 'normal', scope: 'group:10', kind: 'fact', text: '另一个群', source: 'llm-extract' }).action, 'inserted');
    // 手工/日记写入不吃提炼配额
    assert.equal(store.remember({ layer: 'normal', scope: 'group:9', kind: 'diary', text: '手工补一条', source: 'manual' }).action, 'inserted');

    clock.advance(60 * 60 * 1000 + 1);
    assert.equal(store.remember({ layer: 'normal', scope: 'group:9', kind: 'fact', text: '窗口滚动后又能提炼', source: 'llm-extract' }).action, 'inserted');
    assert.equal(store.budget.peek('extract:group:9').used, 1, '新窗口从 1 开始计');
  } finally {
    store.close();
  }
});

test('记忆库：召回打分（重要性/匹配度）与 minScore 过滤', () => {
  const clock = clockAt('2026-10-21T03:00:00+08:00');
  const store = openStore({ root: tmpdir('score'), now: clock.now });
  try {
    store.remember({ layer: 'normal', scope: 'global', kind: 'fact', text: '喜欢喝冰美式', importance: 0.9 });
    store.remember({ layer: 'normal', scope: 'global', kind: 'fact', text: '喜欢喝冰美式加燕麦奶', importance: 0.2 });
    const hits = store.recall({ scope: 'global', query: '冰美式', markUsed: false });
    assert.equal(hits.length, 2);
    assert.ok(hits[0].score >= hits[1].score);
    assert.equal(hits[0].text, '喜欢喝冰美式', '完全匹配 + 高重要性应排前面');
    const strict = store.recall({ scope: 'global', query: '冰美式', minScore: 0.9, markUsed: false });
    assert.ok(strict.length <= 1);
    // 默认 markUsed=true 会累加使用次数
    const first = store.recall({ scope: 'global', query: '冰美式', limit: 1 })[0];
    const before = store.get(first.id).use_count;
    store.recall({ scope: 'global', query: '冰美式', limit: 1 });
    assert.equal(store.get(first.id).use_count, before + 1);
  } finally {
    store.close();
  }
});

test('记忆库：人设演变审计（R1b）与人设回滚指针', () => {
  const clock = clockAt('2026-10-21T03:00:00+08:00');
  const store = openStore({ root: tmpdir('persona'), now: clock.now });
  try {
    const id = store.persona.record({
      kind: 'adjust', field: '口癖', before: '爱说「好的」', after: '爱说「嗯嗯」',
      reason: '最近老被说太客气', evidence: '10-21 群聊 17:20', applied: true, actor: 'self',
    });
    assert.ok(id > 0);
    store.persona.record({ kind: 'owner-request', field: '称呼', before: '小鲸鱼', after: '小鱼干', reason: '爸爸想换个叫法', applied: false, actor: 'owner:1000000001' });
    const list = store.persona.list({ limit: 5 });
    assert.equal(list.length, 2);
    assert.equal(list[0].actor, 'owner:1000000001', '按时间倒序');
    assert.equal(store.persona.lastApplied().field, '口癖');
    assert.equal(store.persona.get(id).after, '爱说「嗯嗯」');
    assert.equal(store.stats().personaAudits, 2);

    const rollbackId = store.persona.record({ kind: 'rollback', field: '口癖', before: '爱说「嗯嗯」', after: '爱说「好的」', reason: '爸爸说还是原来好', applied: true, rollbackOf: id });
    assert.equal(store.persona.get(rollbackId).rollback_of, id);
  } finally {
    store.close();
  }
});

test('记忆库：持久化（重开同一个文件数据还在）与导出/统计', () => {
  const clock = clockAt('2026-10-21T03:00:00+08:00');
  const root = tmpdir('persist');
  const file = path.join(root, 'state', 'memory.db');
  const first = openStore({ root, now: clock.now });
  first.remember({ layer: 'private', scope: 'private:1000000001', kind: 'promise', text: '周末陪爸爸去看球' });
  first.remember({ layer: 'group', scope: 'group:900000001', kind: 'topic', text: '群里在张罗生日' });
  const stats = first.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.path, file);
  assert.ok(stats.bytes > 0);
  assert.deepEqual(stats.byLayer.map((row) => row.layer).sort(), ['group', 'private']);
  assert.ok(fs.existsSync(file));
  first.close();

  const second = openStore({ root, now: clock.now });
  try {
    assert.equal(second.stats().total, 2, '关掉再打开数据仍在');
    const exported = second.exportAll({ scope: 'group:900000001' });
    assert.equal(exported.length, 1);
    assert.equal(exported[0].kind, 'topic');
    assert.equal(second.exportAll().length, 2);
    assert.equal(second.recall({ scope: 'private:1000000001', query: '看球' }).length, 1);

    // 一致性备份：WAL 模式下直接拷 .db 会丢数据，必须走 VACUUM INTO。
    const backup = second.backupTo(path.join(root, '_backups', 'memory-copy.db'));
    assert.ok(fs.existsSync(backup));
    const third = openStore({ root: tmpdir('persist-copy'), file: backup, now: clock.now });
    try {
      assert.equal(third.stats().total, 2, '备份文件应当能被直接打开且内容一致');
    } finally {
      third.close();
    }
  } finally {
    second.close();
  }
});

console.log('✅ qqb 记忆库（R1）测试通过');