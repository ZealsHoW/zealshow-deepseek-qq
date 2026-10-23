// R4 通信容错（3/3）：OneBot 客户端 —— 统一出口 + 失败落盘 + 自动补发。
//
// 背景：桥接里原来散着 5 处各写一遍的 `fetch(${httpUrl}/${action})`（图片、语音、文本、
// get_msg、fetch_ptt_text），每处各自判断 status/retcode、各自超时。任何一处失败都只是
// 抛给调用方，于是「对方等服务重启那 20 秒里发的消息」就永久丢了。
//
// 这个客户端做三件事：
//   1. 一处统一出口（鉴权头、超时、retcode 判定、错误文案规范化）；
//   2. 失败分类：网络/超时/429/5xx = 可重试 → 落盘进 outbox；参数错/无权限 = 永久失败 → 不排队；
//   3. flush()：把 outbox 里到点的条目按序补发，成功出队、失败按退避排下一次（次数用尽才丢）。
//
// 注意「至少一次」语义：极端情况下（POST 已成功、进程在 markSent 之前被强杀）同一条可能重发一次。
// 这是有意的取舍 —— 对 QQ 对话来说，宁可极少数情况重复一句，也不要安静地丢一句。
// 平时由 outbox 的 dedupKey 窗口 + 每次尝试前先写 attempt 记录来把窗口压到最小。

export const VERSION = '0.1.0';

/** 这些 retcode 重试多少次都不会变好（参数错/无权限/未登录），不要进队列。 */
export const PERMANENT_RETCODES = new Set([1400, 1401, 1403, 1404, 1405]);

/**
 * 网关明确拒绝过的话术：重试还是同一句拒绝，不该进队列反复敲门。
 *
 * 真实样本（SnowLuma 2026-10-23 日志）：`result=110 err=发送失败，你已被移出该群，请重新加群。`
 * retcode 110 不在 PERMANENT_RETCODES 里 —— 只看 retcode 会把它当网络抖动塞进补发队列，
 * 于是「刚被踢出群的那批分条」会被 2/4/8… 秒地反复补发，正是最容易把号玩坏的动作。
 * 网络类失败的 error.message（fetch failed / timeout）不含这些词，所以仍按可重试处理。
 */
export const REJECTED_WORDING_RE = /移出|重新加群|禁言|踢出|不在该群|无权限|权限不足|风控|冻结|拉黑|not\s*in\s*group|kicked|muted|forbidden|no\s*permission/i;

export const DEFAULTS = Object.freeze({
  timeoutMs: 15000,
  maxAttempts: 6,
  flushBatch: 20,
  flushIntervalMs: 15000,
});

function valueOf(source, fallback = '') {
  if (typeof source === 'function') {
    try {
      const v = source();
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }
  return source === undefined || source === null ? fallback : source;
}

/** 一次失败到底该不该重试。 */
export function classifyFailure({ status = 0, retcode = null, error = null, wording = null } = {}) {
  // 先看网关拒绝的原话：这是「对端明确说不行」，优先级高于 retcode 表和网络类推断。
  const rejected = String(wording ?? '');
  if (rejected && REJECTED_WORDING_RE.test(rejected)) {
    return { retryable: false, reason: `网关拒绝发送：${rejected.slice(0, 120)}` };
  }
  if (error && !status) return { retryable: true, reason: `网络/超时：${String(error?.message ?? error).slice(0, 120)}` };
  const code = Number(retcode);
  if (Number.isFinite(code) && PERMANENT_RETCODES.has(code)) {
    return { retryable: false, reason: `OneBot retcode ${code}（参数或权限问题，重试无意义）` };
  }
  if (status === 429) return { retryable: true, reason: 'OneBot 限流 429' };
  if (status >= 500) return { retryable: true, reason: `OneBot 服务端 ${status}` };
  if (status >= 400) return { retryable: false, reason: `OneBot 请求被拒 ${status}` };
  return { retryable: true, reason: '未知失败' };
}

/**
 * @param {object} options
 * @param {string|Function} options.httpUrl 形如 http://127.0.0.1:3000（可传函数，桥接里 cfg 会变）
 * @param {string|Function} [options.accessToken]
 * @param {object} [options.outbox] createOutbox() 的实例；不传则失败即抛（不排队）
 * @param {(key: string) => boolean} [options.skipKey] 返回 true 表示这个会话此刻不该发
 *   （桥接用它实现「发言失败后沉默 30 秒」：条目留在队列里，窗口过了再补发）
 * @param {{warn?: Function, info?: Function}} [options.logger]
 * @param {() => number} [options.now]
 * @param {Function} [options.fetchImpl] 单测注入
 */
export function createOneBotClient(options = {}) {
  const logger = options.logger ?? {};
  const outbox = options.outbox ?? null;
  const skipKey = typeof options.skipKey === 'function' ? options.skipKey : null;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const defaultTimeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULTS.timeoutMs);
  const maxAttempts = Math.max(1, Number(options.maxAttempts) || DEFAULTS.maxAttempts);
  const flushBatch = Math.max(1, Number(options.flushBatch) || DEFAULTS.flushBatch);
  let lastError = null;
  let lastOkAt = null;
  let autoTimer = null;

  function log(level, message, detail) {
    try {
      const fn = logger[level];
      if (typeof fn === 'function') fn(message, detail);
    } catch { /* 日志失败不影响发送 */ }
  }

  function baseUrl() {
    return String(valueOf(options.httpUrl, 'http://127.0.0.1:3000')).replace(/\/+$/, '');
  }

  function authHeaders() {
    const token = valueOf(options.accessToken, '');
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  /** 真正发一次（不排队）。永远不抛，返回结果对象。 */
  async function post(action, params, { timeoutMs = defaultTimeoutMs } = {}) {
    const url = `${baseUrl()}/${action}`;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(params ?? {}),
        signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || defaultTimeoutMs)),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.status !== 'ok' || body?.retcode !== 0) {
        const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
        const failure = classifyFailure({ status: res.status, retcode: body?.retcode, wording: body?.wording });
        const error = `OneBot ${action} 失败: ${body?.wording || body?.retcode || res.status}${hint}`;
        lastError = error;
        return { ok: false, action, status: res.status, retcode: body?.retcode ?? null, error, ...failure };
      }
      lastOkAt = Number(now());
      return { ok: true, action, status: res.status, data: body.data ?? null };
    } catch (error) {
      const failure = classifyFailure({ error });
      const message = `OneBot ${action} 失败: ${error?.message ?? error}`;
      lastError = message;
      return { ok: false, action, status: 0, retcode: null, error: message, ...failure };
    }
  }

  return {
    version: VERSION,

    /** 只发一次，不排队（给「重试没意义」的只读接口用，如 get_login_info）。 */
    async probe(action, params, opts) {
      return post(action, params, opts);
    },

    /**
     * 发送类调用：失败且可重试时落盘进 outbox，等 flush 补发。
     * @returns {{ok: boolean, queued?: boolean, id?: string|null, duplicate?: boolean, data?: any, error?: string, permanent?: boolean}}
     */
    async call(action, params, { dedupKey = null, tag = null, queueOnFailure = true, key = null, timeoutMs } = {}) {
      // 去重要在发之前判：同一个 dedupKey 被两条路径同时触发时，先判后发才挡得住「发两遍」。
      if (dedupKey && outbox && typeof outbox.isDuplicate === 'function' && outbox.isDuplicate(dedupKey)) {
        log('info', `重复发送已跳过（dedupKey 命中）：${action}`, dedupKey);
        return { ok: true, queued: true, duplicate: true, skipped: true, data: null };
      }
      const result = await post(action, params, { timeoutMs });
      if (result.ok) return { ok: true, queued: false, data: result.data };
      if (result.retryable && queueOnFailure && outbox) {
        const { id, duplicate } = outbox.enqueue({ key, action, params, dedupKey, tag });
        if (duplicate) {
          log('info', `发送失败且已在队列中（跳过重复入队）：${action}`, result.error);
          return { ok: false, queued: true, duplicate: true, id: null, error: result.error };
        }
        log('warn', `发送失败已入队待补发：${action}`, `${result.error}｜队列 ${outbox.size()} 条`);
        return { ok: false, queued: true, duplicate: false, id, error: result.error };
      }
      if (result.retryable && !outbox) {
        // 没接队列时保持旧行为：抛出去让调用方看见（避免「以为发了其实没发」）。
        throw new Error(result.error);
      }
      return { ok: false, queued: false, permanent: true, error: result.error };
    },

    /** 补发一批到点的条目。 */
    async flush({ limit = flushBatch } = {}) {
      const summary = { sent: 0, failed: 0, dropped: 0, skipped: 0, remaining: 0, errors: [] };
      if (!outbox) return summary;
      outbox.prune();
      const due = outbox.pending().slice(0, Math.max(1, Number(limit) || flushBatch));
      for (const item of due) {
        // 沉默期内的会话一律不补发：条目原样留在队列里（不含进重试次数），
        // 窗口一过它还是「到点」的，下一轮自然补发。
        if (skipKey && item.key && skipKey(item.key)) {
          summary.skipped += 1;
          continue;
        }
        if ((Number(item.attempts) || 0) >= maxAttempts) {
          outbox.markFailed(item.id, { error: `重试 ${item.attempts} 次仍未成功`, permanent: true });
          summary.dropped += 1;
          log('warn', '补发放弃（次数用尽）', `${item.id} ${item.key ?? ''}`.trim());
          continue;
        }
        // 先记一笔「正在尝试」：若进程在 POST 中途被杀，重启后这次尝试也计入次数，不会无限重试。
        if (typeof outbox.markAttempt === 'function') outbox.markAttempt(item.id);
        const result = await post(item.action, item.params);
        if (result.ok) {
          outbox.markSent(item.id, { messageId: result.data?.message_id ?? null });
          summary.sent += 1;
          log('info', `补发成功（第 ${Number(item.attempts) || 0} 次重试后）：${item.action}`, `队列剩 ${outbox.size()} 条`);
        } else if (result.retryable) {
          const r = outbox.markFailed(item.id, { error: result.error });
          summary.failed += 1;
          summary.errors.push(result.error);
          log('warn', `补发失败，将再试：${item.action}`, `${result.error}｜第 ${r.attempts} 次`);
        } else {
          outbox.markFailed(item.id, { error: result.error, permanent: true });
          summary.dropped += 1;
          log('warn', `补发放弃（永久失败）：${item.action}`, result.error);
        }
      }
      summary.remaining = outbox.size();
      return summary;
    },

    /** 起一个自动补发定时器（返回 stop()）。 */
    startAutoFlush({ intervalMs = DEFAULTS.flushIntervalMs, onResult } = {}) {
      if (autoTimer || !outbox) return () => {};
      const tick = async () => {
        try {
          if (outbox.size() === 0) return;
          const res = await this.flush();
          if (typeof onResult === 'function') onResult(res);
        } catch (error) {
          log('warn', '自动补发异常', error?.message ?? error);
        }
      };
      autoTimer = setInterval(tick, Math.max(5000, Number(intervalMs) || DEFAULTS.flushIntervalMs));
      if (typeof autoTimer?.unref === 'function') autoTimer.unref();
      return () => {
        if (autoTimer) clearInterval(autoTimer);
        autoTimer = null;
      };
    },

    stats() {
      const t = Number(now());
      return {
        httpUrl: baseUrl(),
        lastOkAt,
        lastError,
        sinceLastOkMs: lastOkAt ? t - lastOkAt : null,
        outbox: outbox ? outbox.stats() : null,
      };
    },
  };
}