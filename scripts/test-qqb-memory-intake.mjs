#!/usr/bin/env node
/**
 * R1 摄入层回归：规则抽取 + 水位分页 + 幂等。
 *
 * 为什么单独一套：`test-qqb-memory.mjs` 只测库的存取语义，`test-qqb-memory-live.mjs` 测
 * 「桥接写一次、这里镜像一次」。摄入层是第三条路（历史归档 → 记忆库，自动跑），
 * 它的风险不一样：抽错了会污染记忆，水位推错了会**静默丢记忆**（比抽错严重得多），
 * 所以分页那条用例专门盯着水位推进。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/qqb/memory/store.mjs';
import {
  createIntake,
  extractCandidates,
  keyFromHistoryFile,
  listHistoryKeys,
  readHistorySince,
  sentenceAround,
  stripQuote,
  VERSION,
} from '../src/qqb/memory/intake.mjs';

const OWNER = '1000000001';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-intake-'));
}

function rec(x, { t = 1000, self = false, s = '群友' } = {}) {
  return { t, id: String(t), s, u: null, self, x };
}

test('规则族：承诺/喜好/身份/安排各命中一次', () => {
  const records = [
    rec('那英语明天补上，今晚别熬太晚', { t: 1, self: true }),
    rec('我特别喜欢玩手机，求你了', { t: 2 }),
    rec('我在和我女朋友吃饭', { t: 3 }),
    rec('下周三我要去面试，紧张', { t: 4 }),
  ];
  const got = extractCandidates(records);
  assert.deepEqual(got.map((c) => c.kind), ['promise', 'preference', 'fact', 'event']);
  assert.equal(got[0].subject, '小鲸鱼'); // 她自己的台词：主体写成小鲸鱼，注入提示词时才不会被误读成对方说的
  assert.equal(got[2].text, '我在和我女朋友吃饭');
  assert.ok(got[0].importance > got[3].importance, '承诺比安排更重要');
});

test('规则族：她的台词、反问、引用前缀都不该被记成长期事实', () => {
  const records = [
    rec('我哪是小宝宝，我是鲸鱼', { t: 1, self: true }), // 她自己的身份台词
    rec('明天的事明天再少吃', { t: 2, self: true }), // 她自己的「安排」
    rec('哦，合着你昨天问我是不是你', { t: 3 }), // 「是不是」里的「我是」不能命中
    rec('那我学会了什么', { t: 4 }), // 疑问句
    rec('[引用 🍇：我明天去上班]@🍇 早', { t: 5 }), // 引用里别人的话
    rec('我明天要少吃一点', { t: 6 }), // 真正的安排，要留下
  ];
  const got = extractCandidates(records);
  assert.deepEqual(got.map((c) => c.text), ['我明天要少吃一点']);
});

test('句子截取与引用剥离', () => {
  assert.equal(sentenceAround('早啊。我在做饭，等会儿聊！', 3), '我在做饭，等会儿聊！');
  assert.equal(stripQuote('[引用 爸爸：明天见]@爸爸 好'), '@爸爸 好');
  assert.equal(stripQuote('没有引用'), '没有引用');
});

test('同批去重与条数上限', () => {
  const dup = [rec('我喜欢吃火锅', { t: 1 }), rec('我喜欢吃火锅', { t: 2 })];
  assert.equal(extractCandidates(dup).length, 1);
  const many = Array.from({ length: 20 }, (_, i) => rec(`我喜欢打第${i}种游戏`, { t: 100 + i }));
  assert.equal(extractCandidates(many, { max: 5 }).length, 5);
});

test('历史文件名与目录扫描', () => {
  assert.equal(keyFromHistoryFile('private_1000000001.jsonl'), 'private:1000000001');
  assert.equal(keyFromHistoryFile('group_900000001.jsonl'), 'group:900000001');
  assert.equal(keyFromHistoryFile('group_0900000001.jsonl.1'), 'group:0900000001');
  assert.equal(keyFromHistoryFile('random.jsonl'), '');
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'state', 'history'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'history', 'group_1.jsonl'), '{}\n');
  fs.writeFileSync(path.join(root, 'state', 'history', 'private_2.jsonl'), '{}\n');
  fs.writeFileSync(path.join(root, 'state', 'history', 'notes.txt'), 'x\n');
  assert.deepEqual(listHistoryKeys({ root }), ['group:1', 'private:2']);
  // 默认读取器按时间升序、只取水位之后
  fs.writeFileSync(path.join(root, 'state', 'history', 'group_1.jsonl'), [
    JSON.stringify({ t: 10, x: 'a' }), JSON.stringify({ t: 20, x: 'b' }), JSON.stringify({ t: 30, x: 'c' }),
  ].join('\n'));
  assert.deepEqual(readHistorySince({ root, key: 'group:1', afterTs: 15 }).map((r) => r.x), ['b', 'c']);
  assert.deepEqual(readHistorySince({ root, key: 'group:1', limit: 1 }).map((r) => r.x), ['c']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('摄入：写入分层正确、第二轮幂等、重复内容合并', () => {
  const root = tempRoot();
  const store = openStore({ root, logger: { warn: () => {} } });
  try {
    const records = [
      rec('我特别喜欢玩手机', { t: 10, s: '私聊' }),
      rec('下周三我要去面试', { t: 20, s: '私聊' }),
    ];
    let cursor = 0;
    const reader = (_key, { afterTs = 0, limit = 400 } = {}) => records.filter((r) => r.t > afterTs).slice(0, limit);
    const intake = createIntake({ root, store, ownerQQOf: () => OWNER, readRecords: reader, watermarkFile: path.join(root, 'state', 'intake.json') });

    const first = intake.run({ keys: [`private:${OWNER}`] });
    assert.equal(first.inserted, 2);
    assert.equal(first.keys, 1);
    assert.equal(intake.watermarkOf(`private:${OWNER}`), 20);

    const second = intake.run({ keys: [`private:${OWNER}`] });
    assert.equal(second.inserted, 0, '水位已推进，第二轮不该重复写');
    assert.equal(second.scanned, 0);

    // 新内容里有一句和第一轮相同 → 合并而不是新增
    records.push(rec('我特别喜欢玩手机', { t: 30, s: '私聊' }));
    const third = intake.run({ keys: [`private:${OWNER}`] });
    assert.equal(third.inserted, 0);
    assert.equal(third.merged, 1);

    const rows = store.recall({ scope: `private:${OWNER}`, layers: ['private'], limit: 20 });
    assert.equal(rows.length, 2, '同一条事实只该有一行');
    assert.ok(rows.every((r) => r.layer === 'private'), '主人的私聊应落在 private 层');
    assert.ok(rows.every((r) => r.source === 'history-rule'));

    // 水位文件是原子写出来的，且能被重新读回
    const marks = JSON.parse(fs.readFileSync(path.join(root, 'state', 'intake.json'), 'utf8'));
    assert.equal(marks.keys[`private:${OWNER}`], 30);
    assert.equal(marks.version, VERSION);
  } finally {
    store.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('摄入：分页读取不会跳过超出单页的历史（水位只推到已处理处）', () => {
  const root = tempRoot();
  const store = openStore({ root, logger: { warn: () => {} } });
  try {
    // 5 条都含「我喜欢」，单页只给 2 条 → 必须翻 3 页才读完
    const records = Array.from({ length: 5 }, (_, i) => rec(`我喜欢第${i}种零食`, { t: 100 + i * 10, s: '私聊' }));
    const reader = (_key, { afterTs = 0, limit = 400 } = {}) => records.filter((r) => r.t > afterTs).slice(0, limit);
    const intake = createIntake({
      root, store, ownerQQOf: () => OWNER, readRecords: reader,
      scanLimit: 2,
      watermarkFile: path.join(root, 'state', 'intake.json'),
    });
    const res = intake.run({ keys: [`private:${OWNER}`] });
    assert.equal(res.scanned, 5, '五条历史必须都被扫描到');
    assert.equal(res.inserted, 5);
    assert.equal(intake.watermarkOf(`private:${OWNER}`), 140);

    const rows = store.recall({ scope: `private:${OWNER}`, layers: ['private'], limit: 20 });
    assert.equal(rows.length, 5);
  } finally {
    store.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('摄入：库不可用时只记日志，不抛错也不推进水位', () => {
  const root = tempRoot();
  const warnings = [];
  const intake = createIntake({
    root,
    store: null,
    ownerQQOf: () => OWNER,
    readRecords: () => [rec('我喜欢吃鱼', { t: 5 })],
    logger: { warn: (m) => warnings.push(m) },
    watermarkFile: path.join(root, 'state', 'intake.json'),
  });
  const res = intake.run({ keys: [`private:${OWNER}`] });
  assert.equal(res.inserted, 0);
  assert.equal(res.rejected, 1);
  assert.equal(res.scanned, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('试运行：只报告候选，一个字都不写库', () => {
  const root = tempRoot();
  const store = openStore({ root, logger: { warn: () => {} } });
  try {
    const intake = createIntake({
      root, store, ownerQQOf: () => OWNER,
      readRecords: () => [rec('我喜欢吃鱼', { t: 7 })],
      watermarkFile: path.join(root, 'state', 'intake.json'),
    });
    const res = intake.run({ keys: [`private:${OWNER}`], dryRun: true });
    assert.equal(res.dryRun, true);
    assert.equal(res.inserted, 0);
    assert.equal(res.sessions[0].candidates.length, 1);
    assert.equal(store.stats().total, 0, '试运行不能写库');
    assert.equal(fs.existsSync(path.join(root, 'state', 'intake.json')), false, '试运行不该推水位');
  } finally {
    store.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});