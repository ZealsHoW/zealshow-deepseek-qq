// 记忆核心（P1 / PANDORA_SPEC §1 §2 §3 §6 §7）回归：
//   六层与迁移回填、厚度字段、关系硬过滤（owner/friend/group/self）、归档与复职、
//   实体联想（entitiesOf / searchByEntities）、分享、面板数据函数。
//
// 全部走 os.tmpdir() 下的临时库（真 SQLite，node:sqlite），不碰 state/memory.db。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MEM_LEVELS,
  cleanSnippet,
  entitiesOf,
  entitiesOfMemory,
  levelOfKind,
  normalizeMemLevel,
  openStore,
} from '../src/qqb/memory/store.mjs';

const DAY = 24 * 60 * 60 * 1000;

function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `qqb-levels-${label}-`));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return root;
}

/** 可控时钟：权重衰减、归档清扫、分享过期都要能确定性地推进。 */
function clockAt(iso) {
  let ms = Date.parse(iso);
  return {
    now: () => ms,
    advance(deltaMs) { ms += deltaMs; return ms; },
    set(iso2) { ms = Date.parse(iso2); },
  };
}

/** 老库（schema v4，没有 mem_level/sensory/subtext/archive_reason）直接手搓。 */
function makeLegacyStore(root) {
  const sqlite = process.getBuiltinModule('node:sqlite');
  if (!sqlite?.DatabaseSync) throw new Error('需要 Node >= 23.4（node:sqlite 内置）');
  const file = path.join(root, 'state', 'memory.db');
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layer TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT,
      text TEXT NOT NULL,
      norm TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      importance REAL NOT NULL DEFAULT 0.5,
      emotion REAL NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.6,
      source TEXT,
      evidence TEXT,
      meta TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      deleted_at INTEGER,
      archived_at INTEGER
    );
  `);
  const ts = Date.parse('2026-10-01T12:00:00+08:00');
  const insert = db.prepare(`INSERT INTO memories
    (layer, scope, kind, subject, text, norm, hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('private', 'private:1000000001', 'fact', '主人', '主人喜欢喝无糖可乐', '主人喜欢喝无糖可乐', 'h1', ts, ts);
  insert.run('group', 'group:900000001', 'topic', null, '大家在聊装修', '大家在聊装修', 'h2', ts, ts);
  insert.run('normal', 'global', 'wish', null, '想去海边看一次日出', '想去海边看一次日出', 'h3', ts, ts);
  db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('schema_version', '4');
  db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('created_at', String(ts));
  db.close();
  return file;
}

// ─────────────────────────── 1. 六层映射 ───────────────────────────

test('六层：levelOfKind 映射、MEM_LEVELS 顺序、normalizeMemLevel 归一', () => {
  assert.deepEqual([...MEM_LEVELS], ['L2', 'L3', 'L4', 'L5', 'L6']);
  // 事实类 → L4
  for (const kind of ['fact', 'preference', 'impression', 'promise']) {
    assert.equal(levelOfKind(kind), 'L4', `${kind} 应该是 L4`);
  }
  // 片段类 → L3
  assert.equal(levelOfKind('event'), 'L3');
  assert.equal(levelOfKind('topic'), 'L3');
  // 巩固层 / 日记 / 原话
  assert.equal(levelOfKind('card'), 'L5');
  assert.equal(levelOfKind('diary'), 'L6');
  assert.equal(levelOfKind('message'), 'L2');
  // 其它（含空值）默认 L4 —— 老 kind 不会因为映射表升级而丢掉层级
  assert.equal(levelOfKind('wish'), 'L4');
  assert.equal(levelOfKind(undefined), 'L4');
  assert.equal(levelOfKind(''), 'L4');
  // 大小写与空白容错
  assert.equal(levelOfKind('  EVENT '), 'L3');
  // 归一：'l3' / '3' / 非法值
  assert.equal(normalizeMemLevel('l3'), 'L3');
  assert.equal(normalizeMemLevel('5'), 'L5');
  assert.equal(normalizeMemLevel('L9'), null);
  assert.equal(normalizeMemLevel(null, 'L4'), 'L4');
});

// ─────────────────────────── 2. 迁移回填 ───────────────────────────

test('迁移：老库（v4）补列并按 kind 回填层级，schema_version 升到 5', () => {
  const root = tempRoot('migrate');
  const file = makeLegacyStore(root);
  const store = openStore({ root });
  try {
    const rows = store.exportAll();
    assert.equal(rows.length, 3);
    const byText = new Map(rows.map((row) => [row.text, row]));
    // fact → L4；topic → L3；未知 kind（wish）→ L4
    assert.equal(byText.get('主人喜欢喝无糖可乐').memLevel, 'L4');
    assert.equal(byText.get('大家在聊装修').memLevel, 'L3');
    assert.equal(byText.get('想去海边看一次日出').memLevel, 'L4');
    // 厚度列补上来了，默认是 null（不是 ''、不是 undefined）
    for (const row of rows) {
      assert.equal(row.sensory, null);
      assert.equal(row.subtext, null);
      assert.equal(row.archived, false);
      assert.equal(row.archiveReason, null);
    }
    // 迁移不能丢数据，也不能把 FTS 索引搞空（改列后重建一次）
    assert.deepEqual(store.recall({ scope: 'private:1000000001', query: '可乐', markUsed: false }).map((r) => r.text), ['主人喜欢喝无糖可乐']);
  } finally {
    store.close();
  }
  // schema_version 必须已经写成 5（直接读库确认，不靠 store 自报）
  const sqlite = process.getBuiltinModule('node:sqlite');
  const db = new sqlite.DatabaseSync(file);
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get();
    assert.equal(String(row.value), '5');
  } finally {
    db.close();
  }
});

// ─────────────────────────── 3. 厚度落库 ───────────────────────────

test('厚度：sensory/subtext 落库、清洗到 200 字内、空串存 null', () => {
  const root = tempRoot('thickness');
  const clock = clockAt('2026-10-29T10:00:00+08:00');
  const store = openStore({ root, now: clock.now });
  try {
    const long = 'x'.repeat(260);
    const inserted = store.remember({
      layer: 'private',
      scope: 'private:1000000001',
      kind: 'event',
      text: '那天在火锅店她笑得很开心',
      sensory: '  红油翻滚的味道，玻璃上全是雾  ',
      subtext: long,
    });
    assert.equal(inserted.action, 'inserted');
    assert.equal(inserted.memLevel, 'L3');
    const got = store.get(inserted.id);
    assert.equal(got.sensory, '红油翻滚的味道，玻璃上全是雾');
    assert.equal(got.subtext.length, 200);
    assert.equal(got.memLevel, 'L3');

    // 空串 / 纯空白 → null（防「有感官戳」和「空字符串」两种假值混用）
    const blank = store.remember({
      layer: 'private', scope: 'private:1000000001', kind: 'event',
      text: '一条没有感官细节的事', sensory: '   ', subtext: '',
    });
    assert.equal(store.get(blank.id).sensory, null);
    assert.equal(store.get(blank.id).subtext, null);

    // 合并同一件事时只补空、不覆盖第一次记下的细节
    store.remember({
      layer: 'private', scope: 'private:1000000001', kind: 'event',
      text: '那天在火锅店她笑得很开心', sensory: '后来补的细节',
    });
    assert.equal(store.get(inserted.id).sensory, '红油翻滚的味道，玻璃上全是雾');

    // 显式层级优先于 kind 映射
    const diary = store.remember({
      layer: 'private', scope: 'private:1000000001', kind: 'fact',
      text: '今天想他想到睡不着', memLevel: 'L6',
    });
    assert.equal(store.get(diary.id).memLevel, 'L6');

    // cleanSnippet 单测（纯函数）
    assert.equal(cleanSnippet('  a   b  '), 'a b');
    assert.equal(cleanSnippet(''), null);
    assert.equal(cleanSnippet('y'.repeat(500)).length, 200);
  } finally {
    store.close();
  }
});

// ─────────────────────── 4. 归档与复职（§3）───────────────────────

test('归档：默认不召回；includeArchived+exact 精确命中后复职；archiveSweep 只扫又旧又淡的', () => {
  const root = tempRoot('archive');
  const clock = clockAt('2026-01-01T00:00:00+08:00');
  const store = openStore({ root, now: clock.now });
  try {
    const heavy = store.remember({
      layer: 'private', scope: 'private:1000000001', kind: 'promise',
      text: '答应过她每年生日都一起去看海', importance: 0.95, emotion: 0.9,
    });
    const light = store.remember({
      layer: 'private', scope: 'private:1000000001', kind: 'fact',
      text: '路过便利店看到新出的汽水口味', importance: 0.05,
    });
    clock.advance(60 * DAY);

    const sweep = store.archiveSweep({ now: clock.now(), minWeight: 0.12, idleDays: 30 });
    assert.equal(sweep.archived, 1, '只该归档那条又淡又旧的事实');
    assert.deepEqual(sweep.ids, [light.id]);
    assert.equal(store.get(light.id).archived, true);
    assert.equal(store.get(light.id).archiveReason, 'stale');
    assert.equal(store.get(heavy.id).archived, false, '重要的承诺不该被扫走');

    // 默认召回：归档条目一条都不出现
    assert.deepEqual(store.recall({ scope: 'private:1000000001', query: '汽水', markUsed: false }), []);
    // 只给 includeArchived 但没 exact：仍然不唤起（防「随手一搜翻出沉底旧事」）
    assert.deepEqual(store.recall({ scope: 'private:1000000001', query: '汽水', includeArchived: true, markUsed: false }), []);

    // includeArchived + exact + 原文命中 → 捞回来、复职、use_count+1
    const revived = store.recall({
      scope: 'private:1000000001', query: '新出的汽水口味', includeArchived: true, exact: true,
    });
    assert.equal(revived.length, 1);
    assert.equal(revived[0].id, light.id);
    assert.equal(revived[0].revived, true);
    assert.equal(revived[0].archived, false);
    assert.equal(revived[0].useCount, 1);
    const after = store.get(light.id);
    assert.equal(after.archived, false);
    assert.equal(after.archiveReason, null);
    // 复职后回到默认召回里
    assert.equal(store.recall({ scope: 'private:1000000001', query: '汽水', markUsed: false }).length, 1);
  } finally {
    store.close();
  }
});

// ─────────────────────── 5. 实体抽取（§6）───────────────────────

test('实体：entitiesOf 抽 2–4 字片段、去停用词/人称/标点、去重、最多 8 个', () => {
  // ① 空输入
  assert.deepEqual(entitiesOf(''), []);
  assert.deepEqual(entitiesOf(null), []);
  assert.deepEqual(entitiesOf('   '), []);

  // ② 名词片段留下来了，人称/时间词/虚词没留下来
  const a = entitiesOf('我们明天一起去吃火锅吧，我请客');
  assert.ok(a.includes('火锅'), `应抽出「火锅」：${a.join('/')}`);
  assert.ok(!a.includes('我们') && !a.some((item) => item.includes('明天')), '人称与时间词不该成为实体');

  // ③ 每个片段都是 2–4 字（中文），且不重复
  const b = entitiesOf('小鲸鱼喜欢被人这么叫，觉得特别亲切；小鲸鱼还会学鲸鱼叫');
  assert.ok(b.length > 0);
  for (const item of b) assert.ok(item.length >= 2 && item.length <= 4, `片段长度不对：${item}`);
  assert.equal(new Set(b).size, b.length, '实体不能重复');
  assert.ok(b.includes('小鲸鱼'), `人名要留下：${b.join('/')}`);

  // ④ 长专名切成 ≤4 字片段，仍然能对上关键词
  const c = entitiesOf('冰美式加燕麦奶，配一块可可味的小蛋糕');
  assert.ok(c.some((item) => item.includes('燕麦奶') || item.includes('冰美式')), `长名要切出片段：${c.join('/')}`);

  // ⑤ 最多 8 个
  const d = entitiesOf('杭州 西湖 龙井 东坡 苏堤 灵隐 九溪 烟霞 黄龙 玉泉 虎跑 六和塔 雷峰塔');
  assert.ok(d.length <= 8, `最多 8 个，实际 ${d.length}`);
  assert.ok(d.length >= 4);

  // ⑥ 纯数字/标点没有实体价值；英文按小写保留
  assert.deepEqual(entitiesOf('123456 987654321'), []);
  assert.deepEqual(entitiesOf('...，。！！'), []);
  assert.ok(entitiesOf('用 Obsidian 记笔记').includes('obsidian'));

  // ⑦ subject 也参与抽取（人名是最重要的联想线索）
  const fromMemory = entitiesOfMemory({ subject: '阿澈', text: '阿澈最近在赶游戏原画的项目' });
  assert.ok(fromMemory.includes('阿澈'), `subject 要进实体：${fromMemory.join('/')}`);
});

test('实体：searchByEntities 按命中实体数排序，并遵守关系硬过滤', () => {
  const root = tempRoot('entities');
  const clock = clockAt('2026-10-29T10:00:00+08:00');
  const store = openStore({ root, now: clock.now });
  try {
    const both = store.remember({
      layer: 'private', scope: 'private:1000000001', kind: 'event',
      text: '那天在火锅店，小鲸鱼笑得像只仓鼠', importance: 0.6,
    });
    const onlyHotpot = store.remember({
      layer: 'private', scope: 'private:1000000001', kind: 'event',
      text: '火锅店的蘸料里放了很多蒜', importance: 0.6,
    });
    const otherFriend = store.remember({
      layer: 'private', scope: 'private:1000000003', kind: 'event',
      text: '朋友家的火锅很难吃',
    });
    // fact（L4）也能被实体联想命中；topic 是 L3
    const fact = store.remember({
      layer: 'private', scope: 'private:1000000001', kind: 'fact',
      text: '她最喜欢的那家火锅店叫海底捞',
    });

    const hits = store.searchByEntities({ entities: ['火锅', '小鲸鱼'] });
    assert.equal(hits[0].id, both.id, '命中两个实体的排最前');
    assert.equal(hits[0].matched, 2);
    const ids = hits.map((item) => item.id);
    assert.ok(ids.includes(onlyHotpot.id));
    assert.ok(ids.includes(fact.id), 'L4 的事实同样参与联想');
    assert.ok(ids.includes(otherFriend.id), '没有 audience 时不做 scope 限制');
    // 只命中「火锅」的 matched 必须是 1
    assert.equal(hits.find((item) => item.id === onlyHotpot.id).matched, 1);

    // 关系硬过滤：朋友看不到别人的 private 里的火锅
    const friendHits = store.searchByEntities({
      entities: ['火锅'],
      audience: { rel: 'friend', key: 'private:1000000003', ownerQQ: '1000000001' },
    });
    assert.deepEqual(friendHits.map((item) => item.id), [otherFriend.id]);
    assert.equal(friendHits[0].audienceRel, 'friend');

    // 空实体不查库
    assert.deepEqual(store.searchByEntities({ entities: [] }), []);
    assert.deepEqual(store.searchByEntities({ entities: [' '] }), []);
  } finally {
    store.close();
  }
});

// ─────────────────── 6. 关系硬过滤（§2）───────────────────

test('关系硬过滤：owner/friend/group/self 四组白名单，allScopes 对非 self 一律作废', () => {
  const root = tempRoot('audience');
  const clock = clockAt('2026-10-29T10:00:00+08:00');
  const store = openStore({ root, now: clock.now });
  const OWNER = '1000000001';
  const FRIEND = '1000000003';
  try {
    store.remember({ layer: 'private', scope: `private:${OWNER}`, kind: 'fact', text: '爸爸喜欢喝无糖可乐' });
    store.remember({ layer: 'normal', scope: `private:${FRIEND}`, kind: 'fact', text: '朋友在准备考试' });
    store.remember({ layer: 'group', scope: 'group:900000001', kind: 'topic', text: '大家在聊装修' });
    store.remember({ layer: 'normal', scope: 'global', kind: 'preference', text: '她喜欢被人叫小鲸鱼' });

    const texts = (list) => list.map((item) => item.text).sort();

    // owner 在私聊：自己的 private + global
    const ownerPrivate = store.recall({
      scope: `private:${OWNER}`, query: '', markUsed: false,
      audience: { rel: 'owner', key: `private:${OWNER}`, ownerQQ: OWNER },
    });
    assert.deepEqual(texts(ownerPrivate), ['她喜欢被人叫小鲸鱼', '爸爸喜欢喝无糖可乐']);

    // owner 在群里：当前群 + 自己的 private + global（私房话不该因为换窗口消失）
    const ownerGroup = store.recall({
      scope: 'group:900000001', query: '', markUsed: false,
      audience: { rel: 'owner', key: 'group:900000001', ownerQQ: OWNER },
    });
    assert.deepEqual(texts(ownerGroup), ['大家在聊装修', '她喜欢被人叫小鲸鱼', '爸爸喜欢喝无糖可乐']);

    // friend：当前会话 + global；别人的 private（owner 的）一条都不能有
    const friend = store.recall({
      scope: `private:${FRIEND}`, query: '', markUsed: false,
      audience: { rel: 'friend', key: `private:${FRIEND}`, ownerQQ: OWNER },
    });
    assert.deepEqual(texts(friend), ['她喜欢被人叫小鲸鱼', '朋友在准备考试']);

    // group：当前群 + global
    const group = store.recall({
      scope: 'group:900000001', query: '', markUsed: false,
      audience: { rel: 'group', key: 'group:900000001' },
    });
    assert.deepEqual(texts(group), ['大家在聊装修', '她喜欢被人叫小鲸鱼']);

    // self（她主动检索）：全库 —— 连别人的 private 都能看
    const self = store.recall({ query: '', markUsed: false, audience: { rel: 'self' } });
    assert.deepEqual(texts(self), ['大家在聊装修', '她喜欢被人叫小鲸鱼', '朋友在准备考试', '爸爸喜欢喝无糖可乐']);

    // 硬约束①：friend 传 allScopes:true 也必须被忽略（不看全库）
    const friendAll = store.recall({
      scope: `private:${FRIEND}`, query: '', markUsed: false, allScopes: true,
      audience: { rel: 'friend', key: `private:${FRIEND}` },
    });
    assert.deepEqual(texts(friendAll), ['她喜欢被人叫小鲸鱼', '朋友在准备考试']);

    // 硬约束②：group 传了 scope 也是当前会话，不会顺带漏出别的群/私聊
    const groupAll = store.recall({
      scope: 'group:900000001', query: '', markUsed: false, allScopes: true,
      audience: { rel: 'group', key: 'group:900000001' },
    });
    assert.deepEqual(texts(groupAll), ['大家在聊装修', '她喜欢被人叫小鲸鱼']);

    // 老路径不受影响：没有 audience 时 allScopes 照旧 = 全库
    const legacyAll = store.recall({ query: '', allScopes: true, markUsed: false });
    assert.equal(legacyAll.length, 4);
    // 老路径默认按 scope + global 收敛
    assert.deepEqual(
      texts(store.recall({ scope: `private:${OWNER}`, query: '', markUsed: false })),
      ['她喜欢被人叫小鲸鱼', '爸爸喜欢喝无糖可乐'],
    );

    // 每条结果都带 audienceRel（无 audience 时是 null），老字段一个不少
    assert.equal(legacyAll[0].audienceRel, null);
    assert.equal(ownerPrivate[0].audienceRel, 'owner');
    assert.ok('text' in ownerPrivate[0] && 'score' in ownerPrivate[0] && 'weight' in ownerPrivate[0]);
  } finally {
    store.close();
  }
});

// ─────────────────────── 7. 分享（§7）───────────────────────

test('分享：shareMemory 把 scope 借给 target，recall 只在有 audience 时并入白名单，到期失效', () => {
  const root = tempRoot('shares');
  const clock = clockAt('2026-10-29T10:00:00+08:00');
  const store = openStore({ root, now: clock.now });
  try {
    const secret = store.remember({
      layer: 'private', scope: 'private:1000000011', kind: 'fact',
      text: '另一个朋友悄悄说他要辞职去旅行',
    });
    store.remember({ layer: 'normal', scope: 'private:1000000003', kind: 'fact', text: '朋友在准备考试' });

    // 借出去之前：朋友看不到另一个朋友的 private
    const before = store.recall({
      scope: 'private:1000000003', query: '', markUsed: false,
      audience: { rel: 'friend', key: 'private:1000000003' },
    });
    assert.ok(!before.some((item) => item.id === secret.id));

    const shared = store.shareMemory({ id: secret.id, target: 'private:1000000003', ttlMs: DAY });
    assert.equal(shared.ok, true);
    assert.equal(shared.scope, 'private:1000000011');
    assert.equal(shared.expiresAt, clock.now() + DAY);

    // sharedScopesFor 能查到
    assert.deepEqual(
      store.sharedScopesFor({ audience: { rel: 'friend', key: 'private:1000000003' } }),
      ['private:1000000011'],
    );

    // 有了分享：朋友现在看得见这条，并被标成 shared
    const after = store.recall({
      scope: 'private:1000000003', query: '', markUsed: false,
      audience: { rel: 'friend', key: 'private:1000000003' },
    });
    const hit = after.find((item) => item.id === secret.id);
    assert.ok(hit, '分享进来的 scope 应该进白名单');
    assert.equal(hit.shared, true);

    // 没有 audience 时分享不生效（没有「借给谁」可言）
    const noAudience = store.recall({ scope: 'private:1000000003', query: '', markUsed: false });
    assert.ok(!noAudience.some((item) => item.id === secret.id));

    // 到期后失效
    clock.advance(DAY + 1000);
    assert.deepEqual(store.sharedScopesFor({ audience: { rel: 'friend', key: 'private:1000000003' } }), []);
    const expired = store.recall({
      scope: 'private:1000000003', query: '', markUsed: false,
      audience: { rel: 'friend', key: 'private:1000000003' },
    });
    assert.ok(!expired.some((item) => item.id === secret.id));

    // 分享不存在的记忆要老实失败
    assert.equal(store.shareMemory({ id: 99999, target: 'friend' }).ok, false);
  } finally {
    store.close();
  }
});

// ─────────────────── 8. 面板数据函数（§7）───────────────────

test('面板：listMemoriesForPanel 过滤/统计，setMemoryWeight 改权重，setMemoryArchived 归档与反归档', () => {
  const root = tempRoot('panel');
  const clock = clockAt('2026-10-29T10:00:00+08:00');
  const store = openStore({ root, now: clock.now });
  try {
    const event = store.remember({
      layer: 'private', scope: 'private:1000000001', kind: 'event',
      text: '在火锅店笑了一晚上', sensory: '红油味', importance: 0.4,
    });
    const fact = store.remember({
      layer: 'private', scope: 'private:1000000001', kind: 'fact',
      text: '主人喜欢无糖可乐', importance: 0.6,
    });
    const topic = store.remember({ layer: 'group', scope: 'group:900000001', kind: 'topic', text: '群里在聊装修' });

    // 全量
    const all = store.listMemoriesForPanel();
    assert.equal(all.items.length, 3);
    assert.deepEqual(all.stats, { total: 3, archived: 0 });
    // 字段形状（路由层直接吃）
    const item = all.items.find((row) => row.id === fact.id);
    for (const key of ['id', 'memLevel', 'layer', 'scope', 'kind', 'subject', 'text', 'sensory', 'subtext',
      'importance', 'emotion', 'weight', 'retention', 'depth', 'archived', 'createdAt', 'updatedAt', 'useCount', 'evidence']) {
      assert.ok(key in item, `面板条目缺字段：${key}`);
    }
    assert.equal(item.memLevel, 'L4');
    assert.equal(item.archived, false);

    // 按层级过滤：L3 = 事件 + 话题（都按 kind 映射成 L3）
    const l3 = store.listMemoriesForPanel({ levels: ['L3'] });
    assert.deepEqual(l3.items.map((row) => row.id).sort(), [event.id, topic.id].sort());
    // levels 归一（小写也认）
    assert.deepEqual(store.listMemoriesForPanel({ levels: ['l4'] }).items.map((row) => row.id), [fact.id]);
    // 关键词过滤（走 norm）
    assert.deepEqual(store.listMemoriesForPanel({ q: '可乐' }).items.map((row) => row.id), [fact.id]);
    // scope 过滤
    assert.deepEqual(store.listMemoriesForPanel({ scope: 'group:900000001' }).items.map((row) => row.text), ['群里在聊装修']);
    // limit 生效
    assert.equal(store.listMemoriesForPanel({ limit: 1 }).items.length, 1);

    // 改权重：importance 更新、updated_at 跟着抬
    const before = store.get(fact.id);
    clock.advance(1000);
    const weighted = store.setMemoryWeight({ id: fact.id, importance: 0.93 });
    assert.equal(weighted.ok, true);
    assert.equal(weighted.item.importance, 0.93);
    assert.ok(weighted.item.updatedAt > before.updated_at, 'setMemoryWeight 要更新 updated_at');
    assert.equal(store.get(fact.id).importance, 0.93);
    // 越界值夹到 0..1
    assert.equal(store.setMemoryWeight({ id: fact.id, importance: 5 }).item.importance, 1);
    // 非法 id / 非法 importance
    assert.equal(store.setMemoryWeight({ id: 99999, importance: 0.5 }).ok, false);
    assert.equal(store.setMemoryWeight({ id: fact.id, importance: 'x' }).ok, false);

    // 归档：面板默认不显示，includeArchived 才显示。
    // 统计口径跟着过滤条件走 —— 面板底部写「共 N 条」不能把归档的也算进去，
    // 否则人物档案里每个人的记忆条数都会变成全库总数（真机上踩过一次）。
    const archived = store.setMemoryArchived({ id: event.id, archived: true, reason: 'manual' });
    assert.equal(archived.ok, true);
    assert.equal(archived.item.archived, true);
    assert.deepEqual(store.listMemoriesForPanel().stats, { total: 2, archived: 1 });
    assert.deepEqual(store.listMemoriesForPanel({ includeArchived: true }).stats, { total: 3, archived: 1 });
    // scope 过滤后统计也要跟着收窄（人物档案靠这个）
    assert.deepEqual(store.listMemoriesForPanel({ scope: 'group:900000001' }).stats, { total: 1, archived: 0 });
    assert.ok(!store.listMemoriesForPanel().items.some((row) => row.id === event.id));
    assert.ok(store.listMemoriesForPanel({ includeArchived: true }).items.some((row) => row.id === event.id));
    // 归档后默认召回也看不到
    assert.deepEqual(store.recall({ scope: 'private:1000000001', query: '火锅', markUsed: false }), []);

    // 反归档：回来，updated_at 刷新
    const back = store.setMemoryArchived({ id: event.id, archived: false });
    assert.equal(back.ok, true);
    assert.equal(back.item.archived, false);
    assert.deepEqual(store.listMemoriesForPanel().stats, { total: 3, archived: 0 });
    assert.equal(store.listMemoriesForPanel().items.length, 3);
    assert.equal(store.setMemoryArchived({ id: 99999, archived: true }).ok, false);
  } finally {
    store.close();
  }
});

console.log('✅ qqb 记忆核心（P1：六层/厚度/关系硬过滤/归档/实体/分享/面板）测试通过');