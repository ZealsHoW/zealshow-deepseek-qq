// scripts/test-qqb-memory-ebbinghaus.mjs —— 艾宾浩斯遗忘曲线 + 情绪加权（qqb/memory/ebbinghaus.mjs）的回归。
// 覆盖：情绪从文本估、S 随重要度/情绪/复习次数变长、保留率随时间衰减、depth 分档、
// 以及 store 层「写入带情绪 → 后面同样时间点权重更高 / 老记忆更淡」这条接线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_STABILITY_DAYS,
  PROMPT_WEIGHT_FLOOR,
  depthOf,
  effectiveImportance,
  emotionFromText,
  memoryWeight,
  promptWorthy,
  retentionFor,
  stabilityDays,
} from '../src/qqb/memory/ebbinghaus.mjs';
import { openStore } from '../src/qqb/memory/store.mjs';

const DAY = 24 * 60 * 60 * 1000;

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-ebbing-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return root;
}

test('情绪从文本估：平静的话接近 0，动情的话明显更高', () => {
  assert.equal(emotionFromText(''), 0);
  assert.equal(emotionFromText('今天下午三点开会'), 0);
  const warm = emotionFromText('我好开心呀，最喜欢你了');
  const strong = emotionFromText('我真的好难过好想哭，超级委屈！！！');
  assert.ok(warm > 0.1, `带情绪词要起来（实际 ${warm}）`);
  assert.ok(strong > warm, '情绪词更重、感叹号更多的那句要更高');
  assert.ok(strong <= 1, '封顶 1');
});

test('稳定度 S：重要度 / 情绪 / 复习次数都让它更长，且有上限', () => {
  const low = stabilityDays({ importance: 0.3, emotion: 0, useCount: 0 });
  const highImp = stabilityDays({ importance: 0.9, emotion: 0, useCount: 0 });
  const emotional = stabilityDays({ importance: 0.3, emotion: 1, useCount: 0 });
  const reviewed = stabilityDays({ importance: 0.3, emotion: 0, useCount: 10 });
  assert.ok(highImp > low, '重要的事记更久');
  assert.ok(emotional > low, '动情的事记更久');
  assert.ok(reviewed > low, '复习过的记更久');
  assert.ok(stabilityDays({ importance: 1, emotion: 1, useCount: 999 }) <= MAX_STABILITY_DAYS, 'S 有上限，不会永生');
  // 情绪也抬有效重要度（编码时就抬高，不是只在算 R 时用）
  assert.ok(effectiveImportance({ importance: 0.4, emotion: 0.8 }) > 0.4);
  assert.ok(effectiveImportance({ importance: 0.4, emotion: 0 }) === 0.4);
});

test('保留率 R=exp(-t/S)：刚写完是 1，越久越低，且单调不增', () => {
  const S = 5;
  assert.ok(Math.abs(retentionFor({ elapsedMs: 0, stability: S }) - 1) < 1e-9);
  const r1 = retentionFor({ elapsedMs: 5 * DAY, stability: S });
  const r2 = retentionFor({ elapsedMs: 20 * DAY, stability: S });
  assert.ok(r1 < 1 && r2 < r1, `R 要单调下降（5 天 ${r1.toFixed(3)} / 20 天 ${r2.toFixed(3)}）`);
  assert.ok(Math.abs(r1 - Math.exp(-1)) < 1e-3, '一个 S 周期后正好是 1/e');
});

test('depth 分档与 promptWorthy：重的在前（vivid），淡的沉底（deep）不进提示词', () => {
  assert.equal(depthOf(0.8), 'vivid');
  assert.equal(depthOf(0.4), 'clear');
  assert.equal(depthOf(0.2), 'faint');
  assert.equal(depthOf(0.05), 'deep');
  assert.equal(promptWorthy(PROMPT_WEIGHT_FLOOR - 0.01), false);
  assert.equal(promptWorthy(PROMPT_WEIGHT_FLOOR + 0.01), true);
});

test('接线：写入带情绪的记忆，过一段时间后权重更高、还能压过刚写的平凡记忆', () => {
  const root = tempRoot();
  let clock = Date.UTC(2026, 0, 1);
  const st = openStore({ root, now: () => clock });
  try {
    // 同一天写下两条：一条动情、一条平淡。
    st.remember({ layer: 'normal', scope: 'private:1000000001', kind: 'event', text: '她哭着说最喜欢我了', emotion: 1, importance: 0.4 });
    st.remember({ layer: 'normal', scope: 'private:1000000001', kind: 'event', text: '今天下午三点去开会了', emotion: 0, importance: 0.4 });
    const fresh = st.recall({ scope: 'private:1000000001' });
    assert.equal(fresh.length, 2);
    const emotional = fresh.find((row) => row.text.includes('哭着'));
    const plain = fresh.find((row) => row.text.includes('开会'));
    assert.ok(emotional.weight > plain.weight, '编码情绪高的那条权重更高');

    // 过 30 天：两条都淡了，但动情的那条还剩更多。
    clock += 30 * DAY;
    const later = st.recall({ scope: 'private:1000000001' });
    const lateEmo = later.find((row) => row.text.includes('哭着'));
    const latePlain = later.find((row) => row.text.includes('开会'));
    assert.ok(lateEmo.retention < 1, '30 天后保留率必须小于 1（真的在忘）');
    assert.ok(lateEmo.retention > latePlain.retention, '动情的事忘得更慢');
    assert.ok(later[0].text.includes('哭着'), '召回排序把还记得更牢的排前面');
    assert.ok(latePlain.retention < lateEmo.retention);
    assert.ok(memoryWeight({ importance: 0.4, emotion: 1, useCount: 0, ageMs: 30 * DAY }).weight > 0);
  } finally {
    st.close();
  }
});

test('接线：复习（use_count）会把曲线拉回来 —— 被想起的事重新变清晰', () => {
  const root = tempRoot();
  let clock = Date.UTC(2026, 0, 1);
  const st = openStore({ root, now: () => clock });
  try {
    st.remember({ layer: 'normal', scope: 'private:1000000001', kind: 'fact', text: '主人不喜欢吃香菜', importance: 0.5 });
    clock += 40 * DAY;
    const before = st.recall({ scope: 'private:1000000001', markUsed: false })[0];
    // 两次「被想起」
    st.recall({ scope: 'private:1000000001', query: '香菜' });
    st.recall({ scope: 'private:1000000001', query: '香菜' });
    const after = st.recall({ scope: 'private:1000000001', markUsed: false })[0];
    assert.ok(after.use_count > before.use_count, '召回会累计使用次数');
    assert.ok(after.weight >= before.weight, '复习后权重不低于复习前');
  } finally {
    st.close();
  }
});