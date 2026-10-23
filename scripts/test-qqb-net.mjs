// R4 验收：退避器 / 持久化发送队列 / OneBot 客户端。
//
// 这几条断言对应的是线上真出现过的故障：
//   · SnowLuma 重启那 20 秒里发出的回复以前是**直接丢**（fetch 抛错就完了）→ 现在必须落盘并补发；
//   · 同一条回复被两条路径触发时不得发两遍（dedupKey 窗口）；
//   · 参数错（retcode 1400）不该无限重试，也不该把队列塞满；
//   · 进程在「POST 已发出、还没等到结果」时被强杀，重启后不能无限重试同一条。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createBackoff } from '../src/qqb/net/backoff.mjs';
import { createOutbox } from '../src/qqb/net/outbox.mjs';
import { createOneBotClient, classifyFailure, PERMANENT_RETCODES } from '../src/qqb/net/onebot.mjs';
import { createInboundDedup } from '../src/qqb/net/inbound.mjs';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-net-'));

// ── 退避器 ─────────────────────────────────────────────────────────────────

test('退避器：指数增长、封顶、reset 回起点', () => {
  const b = createBackoff({ baseMs: 1000, maxMs: 10000, factor: 2, jitter: 0 });
  assert.equal(b.next(), 1000);
  assert.equal(b.next(), 2000);
  assert.equal(b.next(), 4000);
  assert.equal(b.next(), 8000);
  assert.equal(b.next(), 10000); // 封顶
  assert.equal(b.next(), 10000);
  assert.equal(b.attempts, 6);
  b.reset();
  assert.equal(b.attempts, 0);
  assert.equal(b.next(), 1000);
});

test('退避器：抖动在 ±jitter 内，且 random 越界也不越界', () => {
  const low = createBackoff({ baseMs: 1000, maxMs: 60000, jitter: 0.2, random: () => 0 });
  const high = createBackoff({ baseMs: 1000, maxMs: 60000, jitter: 0.2, random: () => 1 });
  assert.equal(low.next(), 800);   // 1000 * (1 - 0.2)
  assert.equal(high.next(), 1200); // 1000 * (1 + 0.2)，random()=1 被夹到 0.999999
  const state = low.state();
  assert.equal(state.baseMs, 1000);
  assert.equal(state.maxMs, 60000);
  assert.equal(state.attempts, 1);
});

// ── 持久化发送队列 ─────────────────────────────────────────────────────────

test('发送队列：入队落盘、重启后按序恢复', () => {
  const root = tmpRoot();
  const o1 = createOutbox({ root });
  const a = o1.enqueue({ key: 'private:1', action: 'send_private_msg', params: { user_id: 1 }, dedupKey: 'k1' });
  const b = o1.enqueue({ key: 'group:2', action: 'send_group_msg', params: { group_id: 2 }, dedupKey: 'k2' });
  assert.equal(o1.size(), 2);
  assert.ok(fs.existsSync(o1.file));

  const o2 = createOutbox({ root });
  const pending = o2.pending();
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map((i) => i.id), [a.id, b.id]); // 顺序必须保持
  assert.equal(pending[0].action, 'send_private_msg');
  assert.equal(pending[1].params.group_id, 2);
});

test('发送队列：dedupKey 窗口内不重复入队，不同 key 正常入队', () => {
  const o = createOutbox({ root: tmpRoot() });
  assert.equal(o.enqueue({ action: 'send_private_msg', params: {}, dedupKey: 'same' }).duplicate, false);
  assert.equal(o.enqueue({ action: 'send_private_msg', params: {}, dedupKey: 'same' }).duplicate, true);
  assert.equal(o.size(), 1);
  assert.equal(o.enqueue({ action: 'send_private_msg', params: {}, dedupKey: 'other' }).duplicate, false);
  assert.equal(o.size(), 2);

  // 发成功之后仍在去重窗口里：防止「重试竞态」把同一条又发一遍。
  const id = o.pending()[0].id;
  o.markSent(id, { messageId: 42 });
  assert.equal(o.size(), 1);
  assert.equal(o.isDuplicate('same'), true);
  assert.equal(o.enqueue({ action: 'send_private_msg', params: {}, dedupKey: 'same' }).duplicate, true);
});

test('发送队列：可重试失败要等退避到点，永久失败立即丢弃', () => {
  const root = tmpRoot();
  let t = 100000;
  const now = () => t;
  const backoff = createBackoff({ baseMs: 1000, maxMs: 60000, jitter: 0 });
  const o = createOutbox({ root, now, backoff });
  const { id } = o.enqueue({ action: 'send_private_msg', params: {}, dedupKey: 'r1' });

  const r = o.markFailed(id, { error: 'boom' });
  assert.equal(r.retry, true);
  assert.equal(r.attempts, 1);
  assert.equal(o.pending().length, 0);      // 还没到点
  assert.equal(o.waitingCount(), 1);
  t += 1001;
  assert.equal(o.pending().length, 1);      // 到点可重试
  const r2 = o.markFailed(id, { error: 'boom again' });
  assert.equal(r2.attempts, 2);

  // 重启后 attempts 仍要记得（否则每次重启都从 1s 重来，退避形同虚设）
  const o2 = createOutbox({ root, now, backoff });
  const item = o2.all()[0];
  assert.equal(item.attempts, 2);
  assert.equal(item.lastError, 'boom again');

  o2.markFailed(item.id, { error: 'params wrong', permanent: true });
  assert.equal(o2.size(), 0);
  assert.equal(o2.stats().dropped, 1);
});

test('发送队列：上限丢最旧、超期不再补发、compact 后状态不变', () => {
  let t = 500000;
  const now = () => t;
  const root = tmpRoot();
  const o = createOutbox({ root, now, maxItems: 3, maxAgeMs: 60000 });
  for (let i = 0; i < 5; i += 1) o.enqueue({ action: 'send_private_msg', params: { i } });
  assert.equal(o.size(), 3);
  assert.deepEqual(o.all().map((i) => i.params.i), [2, 3, 4]); // 最旧的 0、1 被丢
  assert.equal(o.stats().dropped, 2);

  t += 61000; // 全部超期
  o.prune();
  assert.equal(o.size(), 0);

  // compact：先塞几条再压，压缩后重启仍能全部恢复
  const o2 = createOutbox({ root, now, maxItems: 10, maxAgeMs: 3600000 });
  o2.enqueue({ action: 'send_group_msg', params: { g: 1 }, dedupKey: 'c1' });
  o2.enqueue({ action: 'send_group_msg', params: { g: 2 }, dedupKey: 'c2' });
  o2.markSent(o2.all()[0].id);
  const before = o2.all().map((i) => i.dedupKey);
  const res = o2.compact();
  assert.equal(res.items, 1);
  const o3 = createOutbox({ root, now, maxItems: 10, maxAgeMs: 3600000 });
  assert.deepEqual(o3.all().map((i) => i.dedupKey), before);
});

test('发送队列：写完 attempt 就被强杀，重启后算一次尝试（不会无限重试）', () => {
  const root = tmpRoot();
  const o1 = createOutbox({ root });
  const { id } = o1.enqueue({ action: 'send_private_msg', params: { user_id: 9 }, dedupKey: 'crash' });
  o1.markAttempt(id);

  const o2 = createOutbox({ root });
  const item = o2.all()[0];
  assert.equal(item.attempts, 1);
  assert.match(String(item.lastError), /中途/);
  assert.equal(item.nextAttemptAt, 0); // 允许立刻再试一次
});

// ── OneBot 客户端（真起一个本地 HTTP 服务） ────────────────────────────────

/** 假 OneBot：mode 可切换，记录收到的请求。 */
async function fakeOneBot() {
  const requests = [];
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* 忽略 */ }
      requests.push({ url: req.url, auth: req.headers.authorization ?? null, body });
      // 不让连接的 keep-alive 把测试挂住：undici 会复用连接，server.close() 会一直等它。
      res.setHeader('connection', 'close');
      if (mode === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: requests.length } }));
      } else if (mode === '500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'failed', retcode: 1200, wording: 'internal' }));
      } else {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'failed', retcode: 1400, wording: 'user_id: must be >= 1' }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setMode(next) { mode = next; },
    close: async () => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('OneBot 客户端：成功一次就发出去，带鉴权头与正确的 body', async (t) => {
  const fake = await fakeOneBot();
  t.after(() => fake.close()); // 断言失败也要关掉服务，否则句柄吊住进程
  const client = createOneBotClient({ httpUrl: fake.url, accessToken: 'tok-123' });
  const res = await client.call('send_private_msg', { user_id: 1, message: [{ type: 'text', data: { text: 'hi' } }] });
  assert.equal(res.ok, true);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].url, '/send_private_msg');
  assert.equal(fake.requests[0].auth, 'Bearer tok-123');
  assert.equal(fake.requests[0].body.user_id, 1);
});

test('OneBot 客户端：5xx 失败落盘，服务恢复后 flush 补发成功', async (t) => {
  const fake = await fakeOneBot();
  t.after(() => fake.close());
  const outbox = createOutbox({ root: tmpRoot() });
  const client = createOneBotClient({ httpUrl: () => fake.url, outbox });

  fake.setMode('500');
  const res = await client.call('send_private_msg', { user_id: 7, message: [] }, { dedupKey: 'turn-1', key: 'private:7' });
  assert.equal(res.ok, false);
  assert.equal(res.queued, true);
  assert.equal(outbox.size(), 1);

  fake.setMode('ok');
  const flush = await client.flush();
  assert.equal(flush.sent, 1);
  assert.equal(flush.failed, 0);
  assert.equal(outbox.size(), 0);
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[1].body.user_id, 7);
});

test('OneBot 客户端：retcode 1400 是永久失败（不入队、不重试）', async (t) => {
  const fake = await fakeOneBot();
  t.after(() => fake.close());
  fake.setMode('400');
  const outbox = createOutbox({ root: tmpRoot() });
  const client = createOneBotClient({ httpUrl: fake.url, outbox });
  const res = await client.call('send_private_msg', { user_id: 0, message: [] }, { dedupKey: 'bad' });
  assert.equal(res.ok, false);
  assert.equal(res.queued, false);
  assert.equal(res.permanent, true);
  assert.equal(outbox.size(), 0);
  assert.ok(PERMANENT_RETCODES.has(1400));
  assert.deepEqual(classifyFailure({ status: 400, retcode: 1400 }), { retryable: false, reason: 'OneBot retcode 1400（参数或权限问题，重试无意义）' });
});

test('OneBot 客户端：重试次数用尽才算放弃，且同一 dedupKey 只真发一次', async (t) => {
  const fake = await fakeOneBot();
  t.after(() => fake.close());
  fake.setMode('500');
  let clock = 1000000;
  const now = () => clock;
  const outbox = createOutbox({ root: tmpRoot(), now, backoff: createBackoff({ baseMs: 1, maxMs: 1, jitter: 0 }) });
  const client = createOneBotClient({ httpUrl: fake.url, outbox, now, maxAttempts: 2 });

  const first = await client.call('send_group_msg', { group_id: 5, message: [] }, { dedupKey: 'g-1' });
  assert.equal(first.queued, true);
  const dup = await client.call('send_group_msg', { group_id: 5, message: [] }, { dedupKey: 'g-1' });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.skipped, true);
  assert.equal(outbox.size(), 1, '同一 dedupKey 只应入队一次');
  assert.equal(fake.requests.length, 1, '同一 dedupKey 第二次调用不应真的再发一遍');

  const a = await client.flush();
  assert.equal(a.failed, 1);   // 第 1 次重试失败
  clock += 10;
  const b = await client.flush();
  assert.equal(b.failed, 1);   // 第 2 次重试失败（已达 maxAttempts）
  clock += 10;
  const c = await client.flush();
  assert.equal(c.dropped, 1);  // 下一轮才发现次数用尽 → 丢弃
  assert.equal(c.failed, 0);
  assert.equal(outbox.size(), 0);

  // 丢弃之后就算服务恢复，也不该再冒出那条过时消息
  fake.setMode('ok');
  const after = await client.flush();
  assert.equal(after.sent + after.failed + after.dropped, 0);
});

test('OneBot 客户端：probe 不排队，stats 能看出链路状态', async (t) => {
  const fake = await fakeOneBot();
  t.after(() => fake.close());
  fake.setMode('500');
  const outbox = createOutbox({ root: tmpRoot() });
  const client = createOneBotClient({ httpUrl: fake.url, outbox });
  const res = await client.probe('get_login_info');
  assert.equal(res.ok, false);
  assert.equal(outbox.size(), 0);
  const stats = client.stats();
  assert.equal(stats.lastError.includes('get_login_info'), true);
  assert.equal(stats.outbox.pending, 0);
});

// ── 入站去重 ───────────────────────────────────────────────────────────────

test('入站去重：同一条消息只放行一次，且引用跨重启记得住', () => {
  const root = tmpRoot();
  const first = createInboundDedup({ root });
  assert.equal(first.admit(['id:7001', 'seq:88']).ok, true, '第一次必须放行');
  assert.equal(first.admit(['id:7001', 'seq:88']).ok, false, '同一引用必须拦下');
  assert.equal(first.admit(['id:7001']).ok, false, '只带其中一个引用也算重复');
  assert.equal(first.admit(['id:7002', 'seq:89']).ok, true, '换一条必须放行');
  // 编号空间不同：A 的 id=88 不能被 B 的 seq=88 当成重复（调用方加前缀的意义）
  assert.equal(first.admit(['id:88']).ok, true);

  // 重启（新实例读同一个文件）后仍然记得
  const second = createInboundDedup({ root });
  assert.equal(second.admit(['id:7002']).ok, false, '重启后不得把已处理的消息再喂一遍');
  assert.equal(second.stats().loaded >= 4, true, `应回放历史记录，实际 ${second.stats().loaded}`);
});

test('入站去重：TTL 过期后放行，超上限丢最旧', () => {
  const root = tmpRoot();
  let clock = Date.parse('2026-10-21T00:00:00Z');
  const dedup = createInboundDedup({ root, now: () => clock, ttlMs: 60000, maxEntries: 3 });
  assert.equal(dedup.admit(['id:1']).ok, true);
  clock += 30000;
  assert.equal(dedup.admit(['id:1']).ok, false, 'TTL 内仍算重复');
  clock += 60000;
  assert.equal(dedup.admit(['id:1']).ok, true, 'TTL 过期后放行（不永久占位）');

  clock += 1000;
  dedup.admit(['id:2']);
  dedup.admit(['id:3']);
  dedup.admit(['id:4']);
  const stats = dedup.stats();
  assert.equal(stats.size <= 3, true, `上限必须生效，实际 ${stats.size}`);
  assert.equal(stats.evicted > 0, true, '超上限必须淘汰最旧的');
});