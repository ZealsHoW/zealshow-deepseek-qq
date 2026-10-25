// scripts/test-qqb-memory-rag.mjs —— RAG 向量索引（qqb/memory/embed.mjs + store 的 vectors 表 + live 接线）回归。
// 覆盖：hash 向量确定性/归一化/余弦、blob 往返、混合检索能按意思找回（字面不沾边也可）、
// 不相干的问题被相关度地板滤掉、知识库同样走混合、向量覆盖统计与 pending 补建、live.search 的语义通道回落。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HASH_DIM, HASH_MODEL, blobToVec, cosine, hashVector, vecToBlob, vectorFingerprint } from '../src/qqb/memory/embed.mjs';
import { createLiveMemory } from '../src/qqb/memory/live.mjs';
import { VECTOR_RELEVANCE_FLOOR, openStore } from '../src/qqb/memory/store.mjs';

const DAY = 24 * 60 * 60 * 1000;
const OWNER = '1000000001';

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-rag-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return root;
}

function norm(vec) {
  return Math.sqrt(Array.from(vec).reduce((acc, v) => acc + v * v, 0));
}

test('hash 向量：稳定、单位长度、自己跟自己是 1、不同文本不会撞成一模一样', () => {
  const a = hashVector('她说那首歌唱得我鼻子酸');
  const b = hashVector('她说那首歌唱得我鼻子酸');
  assert.equal(a.length, HASH_DIM);
  assert.equal(vectorFingerprint(a), vectorFingerprint(b), '同一个文本必须得到同一个向量');
  assert.ok(Math.abs(norm(a) - 1) < 1e-4, 'L2 归一');
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
  const c = hashVector('今天下午去开会了');
  assert.ok(cosine(a, c) < 0.9, '不同文本的相似度要明显低于 1');
  const empty = hashVector('');
  assert.ok(norm(empty) < 1e-6, '空文本是零向量，不要归一化炸出 NaN');
});

test('向量落库往返：Float32 → BLOB → Float32 不失真', () => {
  const vec = hashVector('爸爸答应给我买内存条');
  const back = blobToVec(vecToBlob(vec));
  assert.equal(back.length, vec.length);
  assert.ok(Math.abs(cosine(vec, back) - 1) < 1e-6);
});

test('混合召回：字面一个词都不沾，也能按意思找回来', () => {
  const root = tempRoot();
  const st = openStore({ root });
  try {
    st.remember({ layer: 'normal', scope: 'private:1000000001', kind: 'event', text: '她说那首歌唱得自己鼻子酸' });
    st.remember({ layer: 'normal', scope: 'private:1000000001', kind: 'event', text: '今天下午去开会了' });
    // 「让我心里一动的歌」里没有「唱」「鼻子酸」，纯字面是召不回的。
    const rows = st.recall({
      scope: 'private:1000000001',
      query: '唱歌唱得鼻子发酸',
      vector: hashVector('唱歌唱得鼻子发酸'),
      vectorModel: HASH_MODEL,
    });
    assert.ok(rows.length >= 1, '按意思要能把那条找回来');
    const hit = rows.find((row) => row.text.includes('鼻子酸'));
    assert.ok(hit, `第一条相关记忆要在结果里（实际：${rows.map((r) => r.text).join(' / ')}）`);
    assert.ok(hit.match < 0.6, '字面命中率应当很低，靠的是形近/向量那一路');
    assert.ok(hit.lexical > 0, 'hash-v1 拿 bigram 重叠判沾边，要真的共享了词');
    const unrelated = st.recall({
      scope: 'private:1000000001',
      query: '股票基金怎么买',
      vector: hashVector('股票基金怎么买'),
      vectorModel: HASH_MODEL,
    });
    assert.equal(unrelated.length, 0, '完全不相干的问题不该硬凑结果出来');
  } finally {
    st.close();
  }
});

test('知识库同样混合检索：换个说法也查得到', () => {
  const root = tempRoot();
  const st = openStore({ root });
  try {
    st.knowledge.add({ scope: 'private:1000000001', title: 'SQLite FTS5 索引行数怎么看', text: '真实行数在 memories_fts_docsize 里，memories_fts 只是逻辑表' });
    st.knowledge.add({ scope: 'private:1000000001', title: '音频采样率', text: 'GPT-SoVITS 参考音频要 32k' });
    const rows = st.knowledge.search({
      scope: 'private:1000000001',
      query: '索引的真实行数在哪里看',
      vector: hashVector('索引的真实行数在哪里看'),
      vectorModel: HASH_MODEL,
    });
    assert.ok(rows.length >= 1);
    assert.ok(rows[0].title.includes('FTS5'), `FTS5 那条要排第一（实际：${rows.map((r) => r.title).join(' / ')}）`);
  } finally {
    st.close();
  }
});

test('向量覆盖统计 + pending：hash 向量写完就有，别的模型靠 pending 找出来补', () => {
  const root = tempRoot();
  const st = openStore({ root });
  try {
    st.remember({ layer: 'normal', scope: 'private:1000000001', kind: 'fact', text: '主人不喜欢吃香菜' });
    const stats = st.vectors.stats();
    assert.ok(stats.models.some((m) => m.model === HASH_MODEL), 'hash-v1 要出现在模型清单里');
    assert.equal(stats.coverage.memory, 1, '记忆写一条，hash 向量就有一条');
    const pending = st.vectors.pending({ kind: 'memory', model: 'ollama:test' });
    assert.equal(pending.length, 1, '没算过语义向量的行应当被 pending 找出来');
    assert.equal(pending[0].id > 0, true);
    assert.ok(typeof pending[0].text === 'string' && pending[0].text.length > 0);
    // 手动写入一个语义向量后，就不再 pending 了
    st.vectors.set('memory', pending[0].id, 'ollama:test', hashVector('换个模型的向量'));
    assert.equal(st.vectors.pending({ kind: 'memory', model: 'ollama:test' }).length, 0);
  } finally {
    st.close();
  }
});

test('沾边只认有信息量的 bigram：靠一个「怎么」不算沾边（2026-10-25 真机踩过）', () => {
  const root = tempRoot();
  const st = openStore({ root });
  try {
    st.remember({ layer: 'normal', scope: 'private:1000000001', kind: 'event', text: '对方在备考 UML，曾问第二题怎么做并要求详细讲解' });
    const rows = st.recall({
      scope: 'private:1000000001',
      query: '股票基金怎么买',
      vector: hashVector('股票基金怎么买'),
      vectorModel: HASH_MODEL,
      markUsed: false,
    });
    assert.deepEqual(rows, [], '只共享「怎么」这种常用词不能算沾边');
    // 真有实词重叠时仍要能召回，别矫枉过正。
    const hit = st.recall({
      scope: 'private:1000000001',
      query: 'UML 第二题',
      vector: hashVector('UML 第二题'),
      vectorModel: HASH_MODEL,
      markUsed: false,
    });
    assert.ok(hit.length >= 1, '实词重叠要能召回');
  } finally {
    st.close();
  }
});

test('检索时相关度为主：权重高但不沾边的那条不许霸榜（2026-10-25 真机踩过）', () => {
  const root = tempRoot();
  const st = openStore({ root });
  const model = 'ollama:test';
  try {
    // 两条都在同一个 scope：一条重要度 0.95 但跟问题无关，一条重要度 0.5 正是要找的。
    const heavy = st.remember({
      layer: 'normal', scope: 'private:1000000001', kind: 'event',
      text: '今天给自己起了个新名字叫小鲸', importance: 0.95,
    });
    const target = st.remember({
      layer: 'normal', scope: 'private:1000000001', kind: 'event',
      text: '她说那首歌唱得自己鼻子酸', importance: 0.5,
    });
    const query = hashVector('让我心里一动的歌');
    // 假语义模型：无关那条余弦 0.45（刚够过门槛），要找的那条 0.9。
    st.vectors.set('memory', heavy.id, model, hashVector('完全不相干的一段话'));
    st.vectors.set('memory', target.id, model, query);
    const rows = st.recall({
      scope: 'private:1000000001',
      query: '让我心里一动的歌',
      vector: query,
      vectorModel: model,
      markUsed: false,
    });
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].text, '她说那首歌唱得自己鼻子酸', '按意思最近的要排第一');
    assert.ok(rows[0].score > (rows.find((r) => r.text.includes('新名字'))?.score ?? 0));
  } finally {
    st.close();
  }
});

test('live.search 语义通道缺席时回落 hash-v1，结果照样带权重/清晰度；block 按权重排且滤掉快忘光的', async () => {
  const root = tempRoot();
  let clock = Date.UTC(2026, 0, 1);
  const mem = createLiveMemory({ root, ownerQQOf: () => OWNER, now: () => clock, ollamaModel: null });
  try {
    mem.rememberSocialEvent({ key: 'private:1000000001', category: 'event', content: '爸爸答应星期五带我去吃火锅，我特别开心！', importance: 0.9 });
    mem.rememberSocialEvent({ key: 'private:1000000001', category: 'event', content: '今天下午去开会了', importance: 0.3 });
    const found = await mem.search({ kind: 'memory', query: '说好的火锅还算数吗', limit: 5 });
    assert.equal(found.semantic, false, '没配嵌入模型时 semantic 要是 false');
    assert.equal(found.model, HASH_MODEL, '回落 hash-v1');
    assert.ok(found.results.length >= 1, '回落之后结果不能是空的');
    const hit = found.results.find((row) => row.text.includes('火锅'));
    assert.ok(hit, '按意思要能找回火锅那条');
    assert.ok(hit.weight > 0 && typeof hit.depth === 'string', '结果要带遗忘曲线权重与清晰度');
    assert.ok(hit.retention <= 1 && hit.retention > 0);

    // 30 天后：火锅那条还记得，开会那条已经淡到不该自己冒出来。
    clock += 7 * DAY;
    const block = mem.block({ key: 'private:1000000001' });
    assert.ok(block.includes('火锅'), `重要的事要留在提示词里（实际：${block}）`);
    assert.ok(!block.includes('开会'), '快忘光的琐事沉底，不该占提示词');
    const rows = mem.recall({ key: 'private:1000000001', markUsed: false });
    assert.ok(rows[0].weight >= rows[rows.length - 1].weight, '召回结果按权重从重到轻');
  } finally {
    mem.close();
  }
});