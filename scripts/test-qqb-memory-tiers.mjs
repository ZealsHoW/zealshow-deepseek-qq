// 跨会话记忆的「冷热分层 + RRF + 索引/原文」回归（R11，2026-10-30）：
//   - 新记忆默认热；很久没动过的会被 retier 转冷
//   - 冷记忆被频繁检索会自己回热（动态迁移，不是一次性的）
//   - 深情绪 / 高重要度的记忆不吃时间衰减（immune）
//   - card 是「一句话索引」：有日期、有当事人、有当时的情绪
// 走 os.tmpdir() 下的临时库，不碰 state/memory.db。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openStore } from '../src/qqb/memory/store.mjs';

const DAY = 24 * 60 * 60 * 1000;

function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `qqb-tiers-${label}-`));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return root;
}

function clock(start) {
  let ts = start;
  return { now: () => ts, advance: (ms) => { ts += ms; return ts; } };
}

test('新记忆默认是热的，retier 会把久不动的转冷', () => {
  const c = clock(Date.UTC(2026, 9, 30, 12));
  const store = openStore({ root: tempRoot('demote'), now: c.now });
  const old = store.remember({ scope: 'private:3482501440', kind: 'event', text: '很久以前一起去看了海', importance: 0.4, at: c.now() });
  const fresh = store.remember({ scope: 'private:3482501440', kind: 'event', text: '昨天在群里抢到了红包', importance: 0.4, at: c.now() });
  assert.equal(old.tier ?? store.get(old.id).tier, 'hot');

  c.advance(10 * DAY);
  store.remember({ scope: 'private:3482501440', kind: 'event', text: '今天刚说的一句话', importance: 0.4, at: c.now() });
  const moved = store.retier();
  assert.ok(moved.demoted >= 1, '应该有记忆被转冷');
  assert.equal(store.get(old.id).tier, 'cold');
  assert.equal(store.get(fresh.id).tier, 'cold');
  assert.equal(store.tierStats().cold >= 2, true);
});

test('冷记忆被反复检索会自己回热（动态迁移）', () => {
  const c = clock(Date.UTC(2026, 9, 30, 12));
  const store = openStore({ root: tempRoot('promote'), now: c.now });
  const item = store.remember({ scope: 'private:3482501440', kind: 'event', text: '小时候在奶奶家后院抓到一只萤火虫', importance: 0.4, at: c.now() - 9 * DAY });
  c.advance(11 * DAY);
  store.retier();
  assert.equal(store.get(item.id).tier, 'cold');

  // 她主动提了两次这件事 → 热回来。
  store.recall({ scope: 'private:3482501440', query: '萤火虫', limit: 3, markUsed: true });
  store.recall({ scope: 'private:3482501440', query: '萤火虫', limit: 3, markUsed: true });
  const after = store.get(item.id);
  assert.equal(after.tier, 'hot', '命中两次应该升热');
  assert.ok(Number(after.hits) >= 2, 'hits 要记账');
  assert.equal(store.tierStats().hot >= 1, true);
});

test('深情绪/高重要度不吃时间衰减（immune）', () => {
  const c = clock(Date.UTC(2026, 9, 30, 12));
  const store = openStore({ root: tempRoot('immune'), now: c.now });
  const strong = store.remember({ scope: 'group:851489980', kind: 'event', text: '那天她在群里被骂了，一个人躲到阳台上', importance: 0.9, emotion: 0.9, at: c.now() - 90 * DAY });
  const light = store.remember({ scope: 'group:851489980', kind: 'event', text: '有人提了一句明天会下雨', importance: 0.3, at: c.now() - 90 * DAY });
  const rows = store.recall({ scope: 'group:851489980', query: '阳台 下雨', limit: 5, markUsed: false });
  const a = rows.find((r) => r.id === strong.id);
  const b = rows.find((r) => r.id === light.id);
  assert.equal(a.immune, true);
  assert.equal(b.immune, false);
  assert.ok(a.recency > b.recency, '同样的 90 天，深情绪的「新鲜度」要更高');
});

test('card 是一句话索引：有日期、当事人和当时的情绪', () => {
  const c = clock(Date.UTC(2026, 9, 30, 12));
  const store = openStore({ root: tempRoot('card'), now: c.now });
  const item = store.remember({
    scope: 'private:3482501440',
    kind: 'event',
    text: '他三个小时都没有回消息，我盯着屏幕看，房间安静得心慌',
    importance: 0.7,
    emotion: 0.8,
    at: Date.UTC(2026, 9, 20, 22)
  });
  const row = store.recall({ scope: 'private:3482501440', query: '心慌', limit: 1, markUsed: false })[0];
  assert.equal(row.id, item.id);
  assert.ok(typeof row.card === 'string' && row.card.length > 0 && row.card.length <= 80, 'card 长度要克制');
  assert.match(row.card, /^\[\d{2}-\d{2}\]/, '开头是日期（按本地时区格式化）');
  assert.ok(/ZealsHoW|3482501440|与他|^\[\d{2}-\d{2}\]他/.test(row.card), '带当事人（没记 subject 时用「他」）');
});

test('retier 不动已归档、也不动深情绪的老记忆', () => {
  const c = clock(Date.UTC(2026, 9, 30, 12));
  const store = openStore({ root: tempRoot('guard'), now: c.now });
  const warm = store.remember({ scope: 'private:3482501440', kind: 'event', text: '抱了他一下，他愣了一下', importance: 0.6, emotion: 0.7, at: c.now() - 20 * DAY });
  const archived = store.remember({ scope: 'private:3482501440', kind: 'event', text: '某天随手记的一句话', importance: 0.2, at: c.now() - 20 * DAY });
  const plain = store.remember({ scope: 'private:3482501440', kind: 'topic', text: '那天随口聊到的天气', importance: 0.3, at: c.now() - 20 * DAY });
  store.setMemoryArchived({ id: archived.id, archived: true, reason: '测试' });
  store.retier();
  assert.equal(store.get(warm.id).tier, 'hot', '深情绪不吃「3 天没提就转冷」');
  assert.equal(store.get(plain.id).tier, 'cold', '普通老记忆会被推到冷区');
  assert.equal(store.get(archived.id).archived, true, '归档标记在');
});