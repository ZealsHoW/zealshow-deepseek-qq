// 发言失败 → 立即停手 + 保持沉默 + 到点再试（对应主人的要求：失败或被移出群后 30 秒再重试）。
//
// 钉住的边界（每条都对应一个真实失败形态）：
//   1. 软失败（网络/超时）→ 该会话沉默 30 秒：不是 0 秒（等于没改），也不是永久拉黑（再也说不了话）；
//   2. 硬失败（被禁言 / 已被移出群）→ 沉默 10 分钟：被踢之后每隔几秒去敲门是最容易把号玩坏的动作；
//   3. 本批剩余分条立即停手：一代（sendToQQ）只尝试第一条，后面的不再往同一个会话里灌；
//   4. 沉默期内任何发送都不碰网关：二代整批**暂存待补发**（既不硬发，也不凭空丢掉内容）；
//   5. 窗口过后自动恢复发送；
//   6. 补发队列在沉默期内跳过该会话：条目留在队列里、不算一次重试，窗口一过照常补发。
//   7. 「网关拒绝」与「网络抖动」必须分开：被移出群（retcode 110 + 原话）算拒绝、不进队列，
//      本机到网关的 fetch failed 照旧入队补发；
//   8. 二代里首条被暂存（网关抖动）时，本批剩余分条也不再试探 —— 但**不**惩罚这个会话（不压沉默窗口）。
//
// 断言全部走真实现：一代/二代用 audit-bridge-harness 里的真 bridge.js（FakeBot / fakeFetch 记账），
// 队列跳过用 src/qqb/net 的真 outbox + 真 OneBot 客户端（只把 fetch 换成记录器）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { createBackoff } from '../src/qqb/net/backoff.mjs';
import { createOutbox } from '../src/qqb/net/outbox.mjs';
import { classifyFailure, createOneBotClient } from '../src/qqb/net/onebot.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const KEY = 'group:456';
// splitForQQ 默认 4000 字一截 ⇒ 这条会被拆成 3 段，用来验证「第一条失败后立即停手」。
const LONG = '甲'.repeat(9000);

async function fixture(globals = {}, { mode = null } = {}) {
  const h = await bridgeHarness({ globals });
  if (mode) h.setMode(mode);
  h.sendSilence.clear();
  return h;
}

// ---- 沉默窗口本身 ----------------------------------------------------------------

await test('软失败：该会话沉默 30 秒（不是 0 秒，也不是永久）', async () => {
  const h = await fixture();
  try {
    h.noteSendSilence(KEY, new Error('OneBot send_group_msg 失败: 连接超时'));
    const st = h.sendSilenceState(KEY);
    assert.equal(st.silenced, true);
    assert.equal(st.hard, false, '网络抖动不该按硬失败处理');
    assert.ok(st.remainMs > 25_000 && st.remainMs <= 30_000, `remainMs=${st.remainMs}`);
    assert.equal(h.sendSilenceSkip(KEY), true);
  } finally { await h.close(); }
});

await test('硬失败：被禁言 / 已被移出群 → 沉默 10 分钟', async () => {
  const h = await fixture();
  try {
    h.noteSendSilence(KEY, new Error('OneBot send_group_msg 失败: 你已被禁言'));
    const st = h.sendSilenceState(KEY);
    assert.equal(st.hard, true, '「禁言」必须按硬失败处理');
    assert.ok(st.remainMs > 590_000 && st.remainMs <= 600_000, `remainMs=${st.remainMs}`);
    // 别人说话不受影响：沉默是按会话隔离的
    assert.equal(h.sendSilenceState('private:123').silenced, false);
  } finally { await h.close(); }
});

await test('沉默时长可配置，且窗口到期自动解除', async () => {
  const h = await fixture();
  try {
    h.cfg.socialV2.send.failSilenceMs = 40;
    h.noteSendSilence(KEY, new Error('OneBot send_group_msg 失败: 连接超时'));
    assert.equal(h.sendSilenceState(KEY).silenced, true);
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(h.sendSilenceState(KEY).silenced, false, '窗口过后必须自动解除（不是永久拉黑）');
    assert.equal(h.sendSilenceSkip(KEY), false);
  } finally { await h.close(); }
});

// ---- 一代链路（sendToQQ）---------------------------------------------------------

await test('一代：本批第一条失败后，剩余分条不再往同一个会话里灌', async () => {
  const h = await fixture();
  try {
    const attempts = [];
    h.bot.sendGroupMessage = async (id, text) => {
      attempts.push(String(text));
      throw new Error('OneBot send_group_msg 失败: 群不存在');
    };
    await h.sendToQQ(KEY, LONG);
    assert.equal(attempts.length, 1, `只应尝试第一条，实际尝试了 ${attempts.length} 条`);
    assert.equal(h.calls.sent.length, 0, '一条都不该真的发出去');
    assert.equal(h.sendSilenceState(KEY).silenced, true);
  } finally { await h.close(); }
});

await test('一代：沉默期内后续发送一条都不发（零网关尝试）', async () => {
  const h = await fixture();
  try {
    const attempts = [];
    h.bot.sendGroupMessage = async (id, text) => {
      attempts.push(String(text));
      throw new Error('OneBot send_group_msg 失败: 连接超时');
    };
    await h.sendToQQ(KEY, LONG);
    const before = attempts.length;
    assert.ok(before >= 1, '第一次失败本身要有尝试记录');
    await h.sendToQQ(KEY, '再来一条');
    await h.sendToQQ(KEY, '还有一条');
    assert.equal(attempts.length, before, '沉默期内不该有任何网关尝试');
  } finally { await h.close(); }
});

await test('一代：沉默窗口过后恢复发送（真的发出去）', async () => {
  const h = await fixture();
  try {
    const attempts = [];
    let failing = true;
    const original = h.bot.sendGroupMessage.bind(h.bot);
    h.bot.sendGroupMessage = async (id, text) => {
      attempts.push(String(text));
      if (failing) throw new Error('OneBot send_group_msg 失败: 连接超时');
      return original(id, text);
    };
    h.cfg.socialV2.send.failSilenceMs = 40;
    await h.sendToQQ(KEY, LONG);
    const afterFail = attempts.length;
    assert.equal(afterFail, 1);
    failing = false;
    await new Promise((resolve) => setTimeout(resolve, 90));
    await h.sendToQQ(KEY, '恢复发言');
    assert.ok(attempts.length > afterFail, '窗口过后应该继续尝试');
    assert.ok(h.calls.sent.length > 0, '恢复后要真的发到网关');
  } finally { await h.close(); }
});

// ---- 二代链路（sendMessagesV2 / 直连引擎用的那条）----------------------------------

function failingGateway(error) {
  const attempts = [];
  return {
    attempts,
    globals: {
      createOneBotClient: () => ({
        version: '0.1.0',
        probe: async () => ({ ok: false, error }),
        async call() { attempts.push(1); return { ok: false, queued: false, permanent: true, error }; },
        flush: async () => ({ sent: 0, failed: 0, dropped: 0, skipped: 0, remaining: 0, errors: [] }),
        startAutoFlush: () => () => {},
        stats: () => ({ httpUrl: 'fixture', lastOkAt: null, lastError: null, sinceLastOkMs: null, outbox: null })
      })
    }
  };
}

await test('二代：沉默期内的整批暂存待补发（零网关尝试，内容不丢）', async () => {
  const h = await fixture({}, { mode: 'reserved2' });
  try {
    h.noteSendSilence(KEY, new Error('OneBot send_group_msg 失败: 连接超时'));
    const httpBefore = h.calls.http.length;
    await assert.rejects(
      h.sendMessagesV2(KEY, ['甲', '乙'], [0], null),
      (error) => {
        assert.equal(error.silenced, true, '要能被识别成「沉默期未发送」');
        assert.equal(error.softFail, true, '暂存待补发按软失败上报，别当成内容没了');
        assert.equal(error.sent.length, 0);
        assert.equal(error.queued.length + error.skipped.length, 2, '两条都要有归属：暂存或登记丢弃');
        return true;
      }
    );
    assert.equal(h.calls.http.length, httpBefore, '沉默期内不该碰网关');
  } finally { await h.close(); }
});

await test('二代：首条被网关拒绝后停手，剩余分条不再试探，并按硬失败沉默 10 分钟', async () => {
  const { attempts, globals } = failingGateway('OneBot send_group_msg 失败: 你已被禁言');
  const h = await fixture(globals, { mode: 'reserved2' });
  try {
    await assert.rejects(
      h.sendMessagesV2(KEY, ['甲', '乙', '丙'], [0, 0], null),
      (error) => {
        assert.equal(error.sent.length, 0);
        assert.equal(error.queued.length + error.skipped.length, 2, '剩余分条要有归属（暂存或登记丢弃）');
        assert.ok(String(error.message).includes('失败'), `错误要说清是发送失败：${error.message}`);
        return true;
      }
    );
    assert.equal(attempts.length, 1, `只应尝试第一条，实际尝试了 ${attempts.length} 条`);
    const st = h.sendSilenceState(KEY);
    assert.equal(st.silenced, true);
    assert.equal(st.hard, true, '「你已被禁言」要按硬失败处理');
    assert.ok(st.remainMs > 590_000, `remainMs=${st.remainMs}`);
  } finally { await h.close(); }
});

// ---- 补发队列（真 outbox + 真 OneBot 客户端）---------------------------------------

await test('补发队列：沉默期内的会话被跳过，条目留在队列里且不算一次重试', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-silence-'));
  try {
    const outbox = createOutbox({ root, backoff: createBackoff({ baseMs: 2000, maxMs: 60000, factor: 2, jitter: 0 }) });
    const queued = outbox.enqueue({
      key: KEY,
      action: 'send_group_msg',
      params: { group_id: 456, message: [{ type: 'text', data: { text: '甲' } }] },
      dedupKey: 'silence-fixture-1'
    });
    assert.ok(queued?.id, '夹具条目要真的入队');

    let fetched = 0;
    const fetchOk = async () => {
      fetched += 1;
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    };
    const client = createOneBotClient({
      httpUrl: 'http://127.0.0.1:3000',
      outbox,
      skipKey: (key) => key === KEY,
      fetchImpl: fetchOk,
      logger: { warn() {}, info() {} }
    });

    const skipped = await client.flush({ limit: 5 });
    assert.equal(skipped.skipped, 1, '要被记成「沉默期跳过」');
    assert.equal(skipped.sent, 0);
    assert.equal(fetched, 0, '沉默期内一次网关都不该碰');
    assert.equal(outbox.size(), 1, '条目要留在队列里等窗口结束');
    assert.equal(outbox.all()[0].attempts, 0, '跳过不该消耗重试次数');

    // 窗口结束：同一条条目照常补发
    const client2 = createOneBotClient({
      httpUrl: 'http://127.0.0.1:3000',
      outbox,
      skipKey: () => false,
      fetchImpl: fetchOk,
      logger: { warn() {}, info() {} }
    });
    const done = await client2.flush({ limit: 5 });
    assert.equal(done.sent, 1, '窗口结束后要真的补发出去');
    assert.equal(fetched, 1);
    assert.equal(outbox.size(), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 失败分类：网关「拒绝」≠ 本机「网络抖动」---------------------------------------

const KICKED_WORDING = '发送失败，你已被移出该群，请重新加群。';

await test('分类：网关拒绝的原话算永久失败，网络/超时仍算可重试', async () => {
  // 真实样本来自 SnowLuma 日志：result=110 err=发送失败，你已被移出该群，请重新加群。
  const kicked = classifyFailure({ status: 200, retcode: 110, wording: KICKED_WORDING });
  assert.equal(kicked.retryable, false, '被移出群不该进补发队列反复敲门');
  const muted = classifyFailure({ status: 200, retcode: 110, wording: '你已被禁言，无法发言' });
  assert.equal(muted.retryable, false, '禁言同样属于「对端明确说不」');
  const netFail = classifyFailure({ error: new Error('fetch failed') });
  assert.equal(netFail.retryable, true, '本机到网关不通仍要补发，不能丢内容');
  const timeout = classifyFailure({ error: new Error('The operation was aborted due to timeout') });
  assert.equal(timeout.retryable, true);
  const rateLimit = classifyFailure({ status: 429, retcode: 1 });
  assert.equal(rateLimit.retryable, true, '限流要排队等恢复');
});

await test('真网关客户端：被移出群的那条不进补发队列；fetch failed 照旧入队', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-silence-class-'));
  try {
    const outbox = createOutbox({ root, backoff: createBackoff({ baseMs: 2000, maxMs: 60000, factor: 2, jitter: 0 }) });
    const params = { group_id: 456, message: [{ type: 'text', data: { text: '甲' } }] };

    const fetchRejected = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'failed', retcode: 110, wording: KICKED_WORDING })
    });
    const rejected = createOneBotClient({
      httpUrl: 'http://127.0.0.1:3000',
      outbox,
      fetchImpl: fetchRejected,
      logger: { warn() {}, info() {} }
    });
    const r1 = await rejected.call('send_group_msg', params, { key: KEY, dedupKey: 'silence-fixture-kicked' });
    assert.equal(r1.ok, false);
    assert.equal(r1.queued, false, '网关拒绝不该入队');
    assert.equal(r1.permanent, true, '要标成永久失败，好让桥接压硬沉默窗口');
    assert.equal(outbox.size(), 0, '队列里不该有被拒绝的那条');

    // 对照组：本机网络不通 → 入队等补发（内容不丢，这是原有能力，不能被上面的改动带走）
    const fetchDown = async () => { throw new Error('fetch failed'); };
    const down = createOneBotClient({
      httpUrl: 'http://127.0.0.1:3000',
      outbox,
      fetchImpl: fetchDown,
      logger: { warn() {}, info() {} }
    });
    const r2 = await down.call('send_group_msg', params, { key: KEY, dedupKey: 'silence-fixture-net' });
    assert.equal(r2.queued, true, '网络类失败照旧入队');
    assert.equal(outbox.size(), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 二代：可重试失败（已暂存）也要停手，但不惩罚会话 ------------------------------

/** 网关抖动：第一次调用返回「已入队待补发」，之后不该再被调用。 */
function queuedGateway(error) {
  const attempts = [];
  return {
    attempts,
    globals: {
      createOneBotClient: () => ({
        version: '0.1.0',
        probe: async () => ({ ok: false, error }),
        async call() { attempts.push(1); return { ok: false, queued: true, error }; },
        flush: async () => ({ sent: 0, failed: 0, dropped: 0, skipped: 0, remaining: 0, errors: [] }),
        startAutoFlush: () => () => {},
        stats: () => ({ httpUrl: 'fixture', lastOkAt: null, lastError: null, sinceLastOkMs: null, outbox: null })
      })
    }
  };
}

await test('二代：首条被暂存待补发 → 剩余分条不再试探，且不压沉默窗口', async () => {
  const { attempts, globals } = queuedGateway('OneBot send_group_msg 失败: fetch failed');
  const h = await fixture(globals, { mode: 'reserved2' });
  try {
    await assert.rejects(
      h.sendMessagesV2(KEY, ['甲', '乙', '丙'], [0, 0], null),
      (error) => {
        assert.equal(error.sent.length, 0);
        assert.equal(error.softFail, true, '暂存待补发按软失败上报，别当成内容没了');
        assert.equal(error.queued.length + error.skipped.length, 3, '三条都要有归属（暂存或登记丢弃）');
        return true;
      }
    );
    assert.equal(attempts.length, 1, `只应尝试第一条，实际尝试了 ${attempts.length} 条`);
    assert.equal(h.sendSilenceState(KEY).silenced, false, '本机到网关的抖动不该惩罚这个会话');
  } finally { await h.close(); }
});

await test('二代：暂存回来的若是「你已被移出该群」→ 仍按硬失败沉默 10 分钟', async () => {
  const { attempts, globals } = queuedGateway(`OneBot send_group_msg 失败: ${KICKED_WORDING}`);
  const h = await fixture(globals, { mode: 'reserved2' });
  try {
    await assert.rejects(h.sendMessagesV2(KEY, ['甲', '乙'], [0], null), () => true);
    assert.equal(attempts.length, 1, '被移出群之后不该再试第二条');
    const st = h.sendSilenceState(KEY);
    assert.equal(st.silenced, true);
    assert.equal(st.hard, true, '原话里带「移出」就要按硬失败算，哪怕它是从「已入队」那条路回来的');
    assert.ok(st.remainMs > 590_000, `remainMs=${st.remainMs}`);
  } finally { await h.close(); }
});

if (failures > 0) {
  console.error(`\n结果：${failures} 条失败`);
  process.exit(1);
}
console.log('\n结果：全部通过');