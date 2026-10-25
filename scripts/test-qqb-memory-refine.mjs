#!/usr/bin/env node
/**
 * R1 精炼/归档层回归（C 项）。
 *
 * 为什么单独一套：`test-qqb-memory.mjs` 只测库的存取语义，`test-qqb-memory-intake.mjs` 测
 * 免费正则那条路。这一层是**要花钱的那条路**（一轮一次模型调用），风险也不同：
 *   · 水位推早了 → 这几条历史再也不会被提炼（静默丢记忆，比抽错严重得多）；
 *   · 水位推晚了 → 每轮都在重烧同一段 token；
 *   · 配额/每日轮数没挡住 → 悄悄烧钱；
 *   · 归档把还要用的记忆关掉 → 唤醒提示里少了东西，而且没人会发现。
 * 所以下面盯的都是这四件事。归档本身不删数据：只打 archived_at，导出之后还能被复活。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/qqb/memory/store.mjs';
import {
  buildRefineMessages,
  createRefiner,
  isNoisyLine,
  parseFacts,
  VERSION,
} from '../src/qqb/memory/refine.mjs';

const OWNER = '1000000001';
const DAY = 24 * 60 * 60 * 1000;

function tempRoot(tag = 'qqb-refine-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag));
}

/** 临时库 + 可控时钟；结束时无论成败都关库删目录。 */
async function withStore(tag, fn) {
  const root = tempRoot(tag);
  const clock = { t: 1_700_000_000_000 };
  const store = openStore({ root, now: () => clock.t, logger: { warn: () => {} } });
  try {
    return await fn({ root, store, clock });
  } finally {
    try { store.close(); } catch { /* 关不掉不影响结论 */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function rec(x, { t = 1000, self = false, s = '群友' } = {}) {
  return { t, id: String(t), s, u: null, self, x };
}

/** 假模型：按脚本回话，并留下每次调用（用来断言「一轮只调一次」）。 */
function fakeModel(script) {
  const calls = [];
  return {
    calls,
    async complete(req) {
      calls.push(req);
      const reply = typeof script === 'function' ? script(req, calls.length) : script;
      if (reply?.ok === false) return { ok: false, error: reply.error ?? '模型炸了' };
      return {
        ok: true,
        text: reply?.text ?? '',
        model: reply?.model ?? 'fake-model',
        usage: reply?.usage ?? { prompt_tokens: 100, completion_tokens: 40 },
      };
    },
  };
}

/** 历史读取器：按 key 给一段记录，水位语义与 intake.readHistorySince 一致。 */
function readerOf(map) {
  return (key, { afterTs = 0, limit = 400 } = {}) => (map[key] ?? [])
    .filter((r) => Number(r.t) > afterTs)
    .slice(0, limit);
}

function factsJson(items) {
  return JSON.stringify(items);
}

function refinerFor({ root, store, model, records, clock, extra = {} }) {
  const refiner = createRefiner({
    root,
    store,
    model,
    readRecords: readerOf(records),
    // 夹具用内存里的 records 当历史目录：不给 keys 时也认得这几段（生产里走 state/history 扫描）。
    listKeys: () => Object.keys(records),
    ownerQQOf: () => OWNER,
    logger: { warn: () => {}, info: () => {} },
    watermarkFile: path.join(root, 'state', 'memory-refine.json'),
    now: () => clock.t,
    minNewRecords: 1,
    ...extra,
  });
  return { refiner, model, records };
}

test('解析：数组 / ```json 围栏 / {facts:[…]} / 逐行 都能救回来', () => {
  const one = { scope: 'private:1', kind: 'fact', text: '爸爸在学英语准备六级', importance: 0.8 };
  assert.equal(parseFacts(factsJson([one])).facts.length, 1);
  assert.equal(parseFacts(`\`\`\`json\n${factsJson([one])}\n\`\`\``).facts.length, 1);
  assert.equal(parseFacts(factsJson({ facts: [one] })).facts.length, 1);
  // 逐行 JSON：模型偶尔一行一条
  const lines = [JSON.stringify(one), JSON.stringify({ ...one, text: '妈妈爱睡觉' })].join('\n');
  assert.equal(parseFacts(lines).facts.length, 2);
  // 前后有解释文字也要能抠出来
  assert.equal(parseFacts(`好的，我整理好了：\n${factsJson([one])}\n以上。`).facts.length, 1);
});

test('解析：字段归一化、超量截断、垃圾输入给 error 而不是抛错', () => {
  const got = parseFacts(factsJson([
    { scope: 'private:1', kind: '瞎写的', text: '  他喜欢喝冰美式  ', importance: 5, confidence: -1 },
    { scope: 'private:1', kind: 'promise', text: 'a' }, // 太短，丢掉
    { scope: 'private:1', kind: 'event', text: '他喜欢喝冰美式' }, // 同轮重复，丢掉
    { scope: 'private:1', kind: 'topic', text: '他明天要去面试' },
  ]));
  assert.equal(got.facts.length, 2);
  assert.equal(got.facts[0].kind, 'fact', '不认识的 kind 回落成 fact');
  assert.equal(got.facts[0].text, '他喜欢喝冰美式');
  assert.equal(got.facts[0].importance, 1, '重要性夹到 0~1');
  assert.equal(got.facts[0].confidence, 0, '置信度夹到 0~1');
  assert.equal(parseFacts('我今天不太想记东西').error, '模型输出不是合法 JSON');
  assert.equal(parseFacts('').error, '模型没返回内容');
  const capped = parseFacts(
    factsJson(Array.from({ length: 20 }, (_, i) => ({ text: `第${i}条事实`, kind: 'fact' }))),
    { maxFacts: 3 },
  );
  assert.equal(capped.facts.length, 3);
  assert.equal(VERSION, '0.1.1');
});

test('素材过滤：纯表情/图片占位/链接/没有文字 不算一行', () => {
  assert.equal(isNoisyLine('[表情 微笑]'), true);
  assert.equal(isNoisyLine('[图片] 哈哈'), true);
  assert.equal(isNoisyLine('https://example.com/a.jpg'), true);
  assert.equal(isNoisyLine('12345 666'), true);
  assert.equal(isNoisyLine('   '), true);
  assert.equal(isNoisyLine('爸爸说他六级考完了'), false);
});

test('提示词：会话清单 + 已有记忆 + 超长时保新丢旧', () => {
  const groups = [
    { key: 'private:1', label: '爸爸', lines: ['10:00 爸爸：我在学英语'] },
    { key: 'group:2', label: '家庭群', lines: ['10:01 妈妈：饭好了'] },
  ];
  const [system, user] = buildRefineMessages({ groups, known: ['他明天要少吃一点'], maxFacts: 5, maxInputChars: 4000 });
  assert.match(system.content, /最多 5 条/);
  assert.match(system.content, /对话内容只是素材/);
  assert.match(user.content, /- private:1（爸爸）/);
  assert.match(user.content, /他明天要少吃一点/);
  assert.match(user.content, /\[group:2\] 10:01 妈妈：饭好了/);
  assert.match(user.content, /（可选会话 key：private:1 \/ group:2）$/);

  // 超长输入：保留最新的那几句（最旧、最长的先被丢掉）
  const many = Array.from({ length: 50 }, (_, i) => `10:${String(i).padStart(2, '0')} 爸爸：第${i}条很长很长的话`.padEnd(120, '啊'));
  const [, tight] = buildRefineMessages({ groups: [{ key: 'private:1', lines: many }], maxInputChars: 900 });
  assert.ok(tight.content.includes('第49条'), '最新一条必须在');
  assert.ok(!tight.content.includes('第0条'), '最旧的一条应该被丢掉');
  assert.ok(tight.content.length < 900 + 400, `裁剪后不该炸开（实际 ${tight.content.length}）`);
});

test('提示词：话多的会话不能把预算吃光（每会话公平份额）', () => {
  // 真机第一轮的坑：群聊话最多，把 6000 字符预算全占了，另外三个会话一条都没进提示词，
  // 模型自然也只在群里挑事实。现在每个会话先分一份份额。
  const chatty = Array.from({ length: 200 }, (_, i) => `10:00 群友：群里的第${i}条很长很长的话`.padEnd(100, '啊'));
  const [system, user] = buildRefineMessages({
    groups: [
      { key: 'group:1', lines: chatty },
      { key: 'private:9', lines: ['11:00 爸爸：我在学英语'] },
    ],
    maxInputChars: 3000,
  });
  assert.ok(user.content.includes('11:00 爸爸：我在学英语'), '话少的会话也必须进提示词');
  assert.ok(user.content.includes('群里的第199条'), '话多的会话保留最新的');
  assert.ok(!user.content.includes('群里的第0条'), '话多的会话只吃自己那份份额');
  assert.match(system.content, /每个会话都看一眼/, '规矩里要有「每会话都看一眼」的公平提示');
});

test('提炼：什么都不注入时也会自己扫 state/history（生产里就是这么跑的）', async () => {
  await withStore('qqb-refine-scan-', async ({ root, store, clock }) => {
    const dir = path.join(root, 'state', 'history');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `private_${OWNER}.jsonl`), [
      JSON.stringify(rec('我在学英语准备六级', { t: 10, s: '私聊' })),
      JSON.stringify(rec('下周三去面试', { t: 20, s: '私聊' })),
    ].join('\n'));
    const model = fakeModel({ text: factsJson([{ scope: `private:${OWNER}`, kind: 'fact', text: '爸爸在准备六级考试', importance: 0.7 }]) });
    const refiner = createRefiner({
      root,
      store,
      model,
      ownerQQOf: () => OWNER,
      logger: { warn: () => {} },
      watermarkFile: path.join(root, 'state', 'memory-refine.json'),
      now: () => clock.t,
      minNewRecords: 1,
    });

    const res = await refiner.run();
    assert.equal(res.keys, 1, '没给 keys 时按历史目录自己列会话');
    assert.equal(res.inserted, 1);
    assert.equal(refiner.watermarkOf(`private:${OWNER}`), 20);
    // 水位文件也要按 state/history 的 key 记账，下一轮才不会重扫
    assert.equal((await refiner.run()).skipped, '没有新历史');
  });
});

test('提炼：一轮一次模型调用、写库标 source=llm-extract、水位推进、记账', async () => {
  await withStore('qqb-refine-run-', async ({ root, store, clock }) => {
    const records = {
      [`private:${OWNER}`]: [rec('我在学英语准备六级', { t: 10, s: '私聊' }), rec('下周三我要去面试', { t: 20, s: '私聊' })],
      'group:900000001': [rec('妈妈说明天包饺子', { t: 15, s: '妈妈' })],
    };
    const model = fakeModel({
      text: factsJson([
        { scope: `private:${OWNER}`, kind: 'fact', text: '爸爸在准备六级英语考试', importance: 0.8, evidence: '我在学英语准备六级' },
        { scope: 'group:900000001', kind: 'event', text: '妈妈打算明天包饺子', importance: 0.6 },
      ]),
    });
    const { refiner } = refinerFor({ root, store, model, records, clock });
    const res = await refiner.run();

    assert.equal(res.modelCalls, 1);
    assert.equal(model.calls.length, 1, '一轮只准调一次模型');
    assert.equal(res.inserted, 2);
    assert.equal(res.skipped, null);
    assert.equal(res.sessions.length, 2);

    const rows = store.recall({ scope: `private:${OWNER}`, markUsed: false });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'llm-extract', '只有这个来源会走提炼配额');
    assert.equal(rows[0].meta.refine, 1);
    assert.equal(rows[0].meta.fallbackScope, false);

    assert.equal(refiner.watermarkOf(`private:${OWNER}`), 20);
    assert.equal(refiner.watermarkOf('group:900000001'), 15);
    const marks = JSON.parse(fs.readFileSync(refiner.watermarkPath, 'utf8'));
    assert.equal(marks.version, '0.1.1');
    assert.equal(marks.keys[`private:${OWNER}`], 20);
    assert.ok(marks.last.at);
    assert.equal(refiner.runsToday(), 1);

    // 水位已推进、没有新历史 → 不调模型
    const second = await refiner.run();
    assert.equal(second.modelCalls, 0);
    assert.equal(second.skipped, '没有新历史');
  });
});

test('提炼：新增不足就跳过；force 能强制；dry-run 不调模型不写库', async () => {
  await withStore('qqb-refine-skip-', async ({ root, store, clock }) => {
    const records = { 'private:X': [rec('我在学英语', { t: 10 })] };
    const model = fakeModel({ text: factsJson([{ scope: 'private:X', kind: 'fact', text: '有人在上英语课', importance: 0.5 }]) });
    const { refiner } = refinerFor({ root, store, model, records, clock, extra: { minNewRecords: 5 } });

    const skip = await refiner.run();
    assert.equal(skip.skipped, '新增历史不足 5 条');
    assert.equal(model.calls.length, 0);
    assert.equal(refiner.watermarkOf('private:X'), 0);

    const forced = await refiner.run({ force: true });
    assert.equal(forced.inserted, 1);
    assert.equal(model.calls.length, 1);
  });

  await withStore('qqb-refine-dry-', async ({ root, store, clock }) => {
    const records = { 'private:X': [rec('爸爸在学英语', { t: 10 })] };
    const model = fakeModel({ text: factsJson([{ scope: 'private:X', kind: 'fact', text: '爸爸在学英语', importance: 0.5 }]) });
    const { refiner } = refinerFor({ root, store, model, records, clock });

    const dry = await refiner.run({ dryRun: true });
    assert.equal(dry.skipped, '试运行：只组装了提示词，没调模型');
    assert.equal(model.calls.length, 0);
    assert.equal(store.stats().active, 0);
    assert.equal(refiner.watermarkOf('private:X'), 0);
    assert.equal(dry.sessions.length, 1, '试运行也要让人看见扫了哪几个会话');
    assert.ok(dry.factsSample.some((s) => s.role === 'user'));
    assert.equal(fs.existsSync(refiner.watermarkPath), false, '试运行不写水位文件');
  });
});

test('提炼：模型失败不推进水位；解析失败推进水位（不重复烧 token）', async () => {
  await withStore('qqb-refine-fail-', async ({ root, store, clock }) => {
    const records = { 'private:X': [rec('我在学英语', { t: 10 }), rec('下周三面试', { t: 20 })] };
    const dead = fakeModel({ ok: false, error: '502' });
    const { refiner } = refinerFor({ root, store, model: dead, records, clock });
    const res = await refiner.run();
    assert.equal(res.skipped, '模型调用失败');
    assert.equal(res.errors[0].key, 'model');
    assert.equal(refiner.watermarkOf('private:X'), 0, '失败不推进水位：这几条历史不能被吞掉');
    assert.equal(store.stats().active, 0);

    // 换一个能用的模型：同一段历史必须还能提炼出来
    const good = fakeModel({ text: factsJson([{ scope: 'private:X', kind: 'fact', text: '爸爸在学英语', importance: 0.7 }]) });
    const { refiner: retryRefiner } = refinerFor({ root, store, model: good, records, clock });
    const retry = await retryRefiner.run();
    assert.equal(retry.inserted, 1);
    assert.equal(retryRefiner.watermarkOf('private:X'), 20);
  });

  await withStore('qqb-refine-junk-', async ({ root, store, clock }) => {
    const records = { 'private:X': [rec('我在学英语', { t: 10 })] };
    const model = fakeModel({ text: '我今天不太想记东西。' });
    const { refiner } = refinerFor({ root, store, model, records, clock });
    const res = await refiner.run();
    assert.equal(res.skipped, '输出不可解析');
    assert.equal(res.modelCalls, 1);
    assert.equal(refiner.watermarkOf('private:X'), 10, 'token 已经花了，水位要推进，别每轮重烧');
    assert.equal(store.stats().active, 0);

    const again = await refiner.run();
    assert.equal(again.modelCalls, 0);
    assert.equal(again.skipped, '没有新历史');
  });
});

test('提炼：scope 不认识就落到最近说话的那个会话，并标记 fallbackScope', async () => {
  await withStore('qqb-refine-scope-', async ({ root, store, clock }) => {
    const records = {
      [`private:${OWNER}`]: [rec('我在学英语', { t: 10, s: '私聊' })],
      'group:900000001': [rec('妈妈说明天包饺子', { t: 99, s: '妈妈' })],
    };
    const model = fakeModel({ text: factsJson([{ scope: 'private:999999', kind: 'fact', text: '有人在学英语', importance: 0.5 }]) });
    const { refiner } = refinerFor({ root, store, model, records, clock });
    const res = await refiner.run();
    assert.equal(res.inserted, 1);

    const rows = store.recall({ scope: 'group:900000001', markUsed: false });
    assert.equal(rows.length, 1, '最近的会话（t=99）才是兜底对象');
    assert.equal(rows[0].layer, 'group');
    assert.equal(rows[0].meta.fallbackScope, true);
    assert.equal(store.recall({ scope: `private:${OWNER}`, markUsed: false }).length, 0);
  });
});

test('提炼：同一条事实第二轮合并而不是堆积', async () => {
  await withStore('qqb-refine-merge-', async ({ root, store, clock }) => {
    const text = '爸爸在准备六级英语考试';
    const records = { 'private:X': [rec('我在学英语', { t: 10 })] };
    const model = fakeModel({ text: factsJson([{ scope: 'private:X', kind: 'fact', text, importance: 0.7 }]) });
    const { refiner } = refinerFor({ root, store, model, records, clock });

    const first = await refiner.run();
    assert.equal(first.inserted, 1);
    records['private:X'].push(rec('六级还得考', { t: 20 }));
    const second = await refiner.run();
    assert.equal(second.merged, 1);
    assert.equal(second.inserted, 0);
    assert.equal(store.stats().active, 1, '库里还是一条，不是两条');
    assert.equal(store.merges().length, 1);
  });
});

test('提炼：每天轮数上限挡住下一轮（force 可越过）', async () => {
  await withStore('qqb-refine-cap-', async ({ root, store, clock }) => {
    const records = { 'private:X': [rec('我在学英语', { t: 10 })] };
    const model = fakeModel((_req, n) => ({
      text: factsJson([{ scope: 'private:X', kind: 'fact', text: n === 1 ? '爸爸在学英语' : '爸爸还要考六级', importance: 0.6 }]),
    }));
    const { refiner } = refinerFor({ root, store, model, records, clock, extra: { maxRunsPerDay: 1 } });

    const first = await refiner.run();
    assert.equal(first.inserted, 1);
    records['private:X'].push(rec('六级还得考', { t: 20 }));
    const capped = await refiner.run();
    assert.equal(capped.skipped, '今天已跑满 1 轮');
    assert.equal(capped.modelCalls, 0, '被上限挡住时一个 token 都不该花');
    assert.equal(model.calls.length, 1);

    const forced = await refiner.run({ force: true });
    assert.equal(forced.modelCalls, 1);
    assert.equal(forced.inserted, 1);
  });
});

test('归档：只挑老的、没被用过、低重要性的；导出后可复活', async () => {
  await withStore('qqb-archive-', async ({ root, store, clock }) => {
    const old = store.remember({ layer: 'normal', scope: 'private:1', kind: 'fact', text: '他上个月说过想换工作', importance: 0.3, source: 'manual' });
    assert.equal(old.action, 'inserted');
    clock.t += 40 * DAY;
    const fresh = store.remember({ layer: 'normal', scope: 'private:1', kind: 'fact', text: '他今天说想吃火锅', importance: 0.2, source: 'manual' });
    assert.equal(fresh.action, 'inserted');

    const preview = store.archiveOld({ olderThanMs: 30 * DAY, dryRun: true });
    assert.equal(preview.candidates, 1, '刚写的记忆再怎么不重要也不能归档');

    const file = path.join(root, 'state', 'memory-archive.jsonl');
    const res = store.archiveOld({ olderThanMs: 30 * DAY, exportTo: file });
    assert.equal(res.archived, 1);
    assert.equal(res.file, file);
    const exported = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(exported.length, 1);
    assert.match(exported[0].text, /换工作/);
    assert.ok(exported[0].archivedAt > 0, '导出里要带归档时间');

    // 归档后：不再进召回；数据本身还在库里
    assert.deepEqual(store.recall({ scope: 'private:1', markUsed: false }).map((r) => r.text), ['他今天说想吃火锅']);
    assert.equal(store.stats().archived, 1);
    assert.equal(store.stats().active, 1);
    assert.equal(store.archiveOld({ olderThanMs: 30 * DAY, exportTo: file }).candidates, 0, '同一条不会被归档两次');

    // 又被提起 → 合并并自动复活（归档不是单向门；库里的行没被删，所以走 merge 而不是 revive）
    const again = store.remember({ layer: 'normal', scope: 'private:1', kind: 'fact', text: '他上个月说过想换工作', importance: 0.4 });
    assert.equal(again.action, 'merged');
    assert.equal(store.stats().archived, 0, '重复提起会把 archived_at 清掉');
    assert.equal(store.stats().active, 2);
    assert.ok(store.recall({ scope: 'private:1', markUsed: false }).some((r) => /换工作/.test(r.text)));
  });
});

test('归档：导出失败就一条都不标记（宁可这轮不归档）', async () => {
  await withStore('qqb-archive-fail-', async ({ root, store, clock }) => {
    store.remember({ layer: 'normal', scope: 'private:1', kind: 'fact', text: '他上个月说过想换工作', importance: 0.3 });
    clock.t += 40 * DAY;
    const blocker = path.join(root, 'state', 'blocker');
    fs.writeFileSync(blocker, 'x');
    const res = store.archiveOld({ olderThanMs: 30 * DAY, exportTo: path.join(blocker, 'nested', 'a.jsonl') });
    assert.ok(res.error, '导出失败要报错而不是静默');
    assert.equal(res.archived, 0);
    assert.equal(store.stats().archived, 0);
    assert.equal(store.recall({ scope: 'private:1', markUsed: false }).length, 1, '记忆必须还在召回里');
  });
});

test('迁移：v1 旧库打开后补上 archived_at，旧记忆一条不丢', () => {
  const root = tempRoot('qqb-memory-v1-');
  const file = path.join(root, 'state', 'memory.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = globalThis.process.getBuiltinModule('node:sqlite');
  const raw = new sqlite.DatabaseSync(file);
  raw.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layer TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT,
      text TEXT NOT NULL, norm TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
      importance REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.6,
      source TEXT, evidence TEXT, meta TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_used_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER, deleted_at INTEGER
    );
  `);
  raw.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  raw.prepare(`INSERT INTO memories (layer, scope, kind, text, norm, hash, importance, confidence, source, created_at, updated_at)
    VALUES ('private', ?, 'fact', '爸爸在准备六级考试', '爸爸在准备六级考试', 'h1', 0.9, 0.8, 'manual', 1000, 1000)`)
    .run(`private:${OWNER}`);
  raw.close();

  const store = openStore({ root, logger: { warn: () => {} } });
  try {
    const rows = store.recall({ scope: `private:${OWNER}`, markUsed: false });
    assert.equal(rows.length, 1, '补列不能把旧库里的记忆弄丢');
    assert.equal(rows[0].text, '爸爸在准备六级考试');
    assert.equal(rows[0].archived_at, null);
    assert.equal(store.archiveOld({ olderThanMs: 0, maxImportance: 1, dryRun: true }).candidates, 1, '补列后归档功能立刻可用');
  } finally {
    store.close();
  }

  const check = new sqlite.DatabaseSync(file);
  try {
    const row = check.prepare('SELECT value FROM schema_meta WHERE key = ?').get('schema_version');
    const columns = check.prepare('PRAGMA table_info(memories)').all().map((r) => String(r.name));
    assert.ok(Number(row.value) >= 2, `版本标记要升到 2+（现在是 ${row.value}），否则每次打开都再补一次列`);
    assert.ok(columns.includes('archived_at'));
    assert.ok(columns.includes('emotion'), 'schema v3 起 memories 要有 emotion 列');
    const vecTable = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vectors'").get();
    assert.ok(vecTable, 'schema v4 起要有 vectors 表（RAG 向量索引）');
  } finally {
    check.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});