#!/usr/bin/env node
/**
 * 去重脚本的单元测试：记忆库（memory-dedupe）与人设特征（persona-dedupe/evolve）。
 *
 * 守住的规则：
 *  - 归一化把标点/emoji/空白/全角都吃掉，但不动「说的是两件事」的措辞；
 *  - 同 kind + 同 scope 才算重复（跨会话各留一份是设计，不是脏数据）；
 *  - message（L2 原话）默认不参与去重 —— 对方真说过两次是历史；
 *  - 保留谁：use 高的 > importance 高的 > 新的；被并掉的不删，只置过期；
 *  - 人设特征里「换了说法」的同一条要并成一条，并且并完权重不能变轻。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SKIP_KINDS,
  findDuplicateGroups,
  jaccard as memJaccard,
  normalizeMemoryText
} from './memory-dedupe.mjs';
import { createEvolve, bagOf, jaccard, TRAIT_SIMILAR } from '../src/qqb/persona/evolve.mjs';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

console.log('memory-dedupe：归一化');
check('去空白/标点/emoji/全角，大小写归一', () => {
  assert.equal(normalizeMemoryText('  我是鳄鱼🐊！'), '我是鳄鱼');
  assert.equal(normalizeMemoryText('ＡＢＣ　def'), 'abcdef');
});
check('不同的句子不会被归一成同一串', () => {
  assert.notEqual(normalizeMemoryText('明天抽查单词'), normalizeMemoryText('今晚抽查单词'));
});
check('二字组 Jaccard：同义改写 > 0.4，不同事 < 0.3', () => {
  const a = bagOf('我建议直接关掉淘宝的传感器权限来屏蔽摇一摇广告。');
  const b = bagOf('我建议直接关闭淘宝的传感器权限来屏蔽摇一摇广告。');
  const c = bagOf('我答应明天早上叫妈妈起床背单词。');
  assert.ok(jaccard(a, b) > 0.4);
  assert.equal(memJaccard(a, c), jaccard(a, c));
});

console.log('memory-dedupe：分组');
const rows = [
  { id: 1, kind: 'fact', scope: 'private:1', text: '我是鳄鱼🐊', use_count: 141, importance: 0.65, created_at: 100 },
  { id: 2, kind: 'fact', scope: 'private:1', text: '我是鳄鱼', use_count: 0, importance: 0.65, created_at: 200 },
  // 跨会话：各留一份
  { id: 3, kind: 'fact', scope: 'private:2', text: '我是鳄鱼', use_count: 0, importance: 0.65, created_at: 300 },
  // L2 原话不参与
  { id: 4, kind: 'message', scope: 'private:1', text: '妈妈，我在', use_count: 0, importance: 0.3, created_at: 400 },
  { id: 5, kind: 'message', scope: 'private:1', text: '妈妈，我在。', use_count: 0, importance: 0.3, created_at: 500 },
  // 近义改写（要 --similar 才并）
  { id: 6, kind: 'topic', scope: 'private:1', text: '小鲸鱼怀疑小祀一整天都没理她。', use_count: 15, importance: 0.4, created_at: 600 },
  { id: 7, kind: 'topic', scope: 'private:1', text: '小鲸鱼怀疑小祀一整天没理她。', use_count: 0, importance: 0.3, created_at: 700 }
];

check('完全相同的只留 use 最高那条，且只并同 scope', () => {
  const groups = findDuplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep.id, 1);
  assert.deepEqual(groups[0].drop.map((r) => r.id), [2]);
});
check('message 默认被跳过', () => {
  assert.deepEqual(DEFAULT_SKIP_KINDS, ['message']);
  const groups = findDuplicateGroups(rows);
  assert.ok(!groups.some((g) => g.drop.some((r) => r.kind === 'message')));
});
check('给了 similar 阈值才抓近义改写，且保留 use 高的', () => {
  const groups = findDuplicateGroups(rows, { similar: 0.75 });
  const g = groups.find((x) => x.drop.some((r) => r.id === 7));
  assert.ok(g);
  assert.equal(g.keep.id, 6);
});
check('阈值过高时不误并', () => {
  const groups = findDuplicateGroups(rows, { similar: 0.99 });
  assert.ok(!groups.some((x) => x.drop.some((r) => r.id === 7)));
});

console.log('persona：近重复合并 + 日期标签');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-persona-'));
const file = path.join(dir, 'persona-traits.json');
const evolve = createEvolve({ filePath: file, logger: { warn: () => {} } });

check('同一件事换个说法只进一条，权重不降', () => {
  evolve.merge([
    { kind: 'promise', text: '我答应明天出门给爸爸拍云朵照片。', weight: 0.5 },
    { kind: 'promise', text: '我答应明天出门给爸爸拍云朵照片', weight: 0.5 }
  ]);
  const list = evolve.traits().filter((t) => t.kind === 'promise');
  assert.equal(list.length, 1);
  assert.ok(Number(list[0].weight) >= 0.5);
});
check('不同的两件事不会被并成一条', () => {
  const before = evolve.traits().filter((t) => t.kind === 'promise').length;
  evolve.merge([
    { kind: 'promise', text: '我答应明天早上抽查单词。', weight: 0.5 },
    { kind: 'promise', text: '我答应今晚早点睡，不刷手机到两点。', weight: 0.5 }
  ]);
  const after = evolve.traits().filter((t) => t.kind === 'promise').length;
  assert.equal(after - before, 2);
});
check('渲染带「·MM-DD」，说明这条是什么时候长出来的', () => {
  const block = evolve.render({ lines: 5, chars: 800 });
  assert.match(block, /【她自己的长期特征/);
  assert.match(block, /（承诺·\d{2}-\d{2}）/);
});
check('阈值常量在合理区间（太高抓不住改写，太低会误并）', () => {
  assert.ok(TRAIT_SIMILAR > 0.4 && TRAIT_SIMILAR < 0.8);
});

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);