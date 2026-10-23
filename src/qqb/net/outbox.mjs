// R4 通信容错（2/3）：持久化发送队列（outbox）。
//
// 要解决的问题（线上真出现过）：
//   SnowLuma / OneBot 短暂不可用（重启、端口没起来、网络抖动）时，桥接的 fetch 直接抛错，
//   那一条回复就**永久丢了** —— 对方等不到任何回应，日志里只有一行「QQ 发送失败」。
//
// 这里给的保证：
//   · 至少一次：发送失败（可重试类）先落盘，随后由 flush 反复重试，直到成功或被判定为永久失败；
//   · 不重复：同一个 dedupKey 在「待发队列 + 刚发成功不久」这两个窗口内不会入队两次
//     （重试竞态、同一个回复被两条路径触发的场景都靠它挡住）；
//   · 有序：pending() 严格按入队顺序返回，恢复后按序补发；
//   · 可回滚：只是多了一份 JSONL，删掉文件即回到旧行为；桥接侧接线也只是一处分支。
//
// 存储格式：追加写的 JSONL（每次变更一行），启动时回放成内存状态。
//   追加而不是整份重写，是为了「进程被强杀时最多丢最后一行」，而不是整份队列被写坏。
//   行数超过 compactAfter 时自动 compact() 压回一份最小日志。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const VERSION = '0.1.0';

export const DEFAULTS = Object.freeze({
  maxItems: 500,              // 队列上限，超了丢最旧的（丢的时候一定写日志）
  maxAgeMs: 24 * 3600 * 1000, // 超过一天还没发出去就不再补发（再说那句话也过时了）
  compactAfter: 200,          // 日志行数超过它就跑一次 compact
  dedupTtlMs: 5 * 60 * 1000,  // 「刚发成功」的去重窗口
});

function nowOf(now) {
  const t = Number(typeof now === 'function' ? now() : Date.now());
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * @param {object} options
 * @param {string} options.root 桥接根目录（默认把队列放在 state/outbox.jsonl）
 * @param {string} [options.file] 覆盖队列文件路径
 * @param {{warn?: Function, info?: Function}} [options.logger]
 * @param {() => number} [options.now]
 * @param {object} [options.backoff] createBackoff() 的实例（重试节奏由它决定）
 */
export function createOutbox(options = {}) {
  const root = options.root ?? process.cwd();
  const file = options.file ?? path.join(root, 'state', 'outbox.jsonl');
  const logger = options.logger ?? {};
  const now = options.now ?? Date.now;
  const backoff = options.backoff ?? null;
  const maxItems = Math.max(1, Number(options.maxItems) || DEFAULTS.maxItems);
  const maxAgeMs = Math.max(1000, Number(options.maxAgeMs) || DEFAULTS.maxAgeMs);
  const compactAfter = Math.max(10, Number(options.compactAfter) || DEFAULTS.compactAfter);
  const dedupTtlMs = Math.max(0, Number(options.dedupTtlMs ?? DEFAULTS.dedupTtlMs));

  /** @type {Map<string, object>} 待发/重试中的条目，key = id */
  const items = new Map();
  /** @type {Map<string, number>} dedupKey → 最近一次入队或发成功的时间 */
  const dedupSeen = new Map();
  const counters = { sent: 0, failed: 0, dropped: 0, duplicated: 0, loaded: 0 };
  let seq = 0;
  let logLines = 0;
  let lastError = null;

  function warn(message, detail) {
    try {
      if (typeof logger.warn === 'function') logger.warn(message, detail);
    } catch { /* 日志失败不影响队列 */ }
  }

  function ensureDir() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      return true;
    } catch (error) {
      lastError = error;
      warn('发送队列目录不可写', error?.message ?? error);
      return false;
    }
  }

  function append(record) {
    logLines += 1;
    try {
      fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      lastError = error;
      warn('发送队列写入失败（本次仅留在内存）', error?.message ?? error);
    }
  }

  /** 回放日志 → 内存状态。坏行跳过（宁可丢一行，也不要整份队列起不来）。 */
  function load() {
    items.clear();
    counters.loaded = 0;
    logLines = 0;
    // 每个条目最后一条记录是什么操作：用来识别「写完 attempt 就被强杀」的中间态。
    const lastOp = new Map();
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return; // 文件不存在 = 空队列
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      logLines += 1;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec || typeof rec !== 'object') continue;
      if (rec.op === 'add' && rec.item?.id) {
        const item = rec.item;
        items.set(item.id, {
          ...item,
          attempts: Number(item.attempts) || 0,
          nextAttemptAt: Number(item.nextAttemptAt) || 0,
        });
        if (item.dedupKey) {
          dedupSeen.set(String(item.dedupKey), Number(item.enqueuedAt) || nowOf(now));
        }
        lastOp.set(item.id, 'add');
      } else if (rec.op === 'attempt' && rec.id) {
        lastOp.set(rec.id, 'attempt');
      } else if (rec.op === 'sent' || rec.op === 'drop') {
        if (rec.id) items.delete(rec.id);
        if (rec.dedupKey) dedupSeen.set(String(rec.dedupKey), nowOf(now));
        if (rec.id) lastOp.set(rec.id, rec.op);
      } else if (rec.op === 'fail' && rec.id) {
        const item = items.get(rec.id);
        if (item) {
          item.attempts = Number(rec.attempts) || item.attempts + 1;
          item.nextAttemptAt = Number(rec.nextAttemptAt) || 0;
          item.lastError = rec.error ?? null;
        }
        lastOp.set(rec.id, 'fail');
      }
      seq += 1;
    }
    // 上次在「已发出 POST、还没等到结果」的中间态被强杀：这一趟算一次尝试，
    // 否则同一台机器反复崩在这个窗口里会让它无限重试。
    for (const [id, op] of lastOp) {
      if (op !== 'attempt') continue;
      const item = items.get(id);
      if (!item) continue;
      item.attempts += 1;
      item.nextAttemptAt = 0;
      item.lastError = '上次发送中途进程退出，结果未知（按一次尝试计）';
    }
    counters.loaded = items.size;
  }

  function liveItems() {
    return [...items.values()].sort((a, b) => (a.seq - b.seq) || String(a.id).localeCompare(String(b.id)));
  }

  /** 超期条目不再补发（防止第二天突然把昨天的碎碎念发出去）。 */
  function pruneExpired() {
    const t = nowOf(now);
    for (const item of liveItems()) {
      if (t - (Number(item.enqueuedAt) || t) > maxAgeMs) {
        counters.dropped += 1;
        items.delete(item.id);
        append({ op: 'drop', id: item.id, dedupKey: item.dedupKey ?? null, reason: 'expired', ts: t });
        warn('发送队列：条目过期已丢弃', `${item.id} ${item.key ?? ''}`.trim());
      }
    }
  }

  /** 队列超上限：丢最旧的（新的还在排队，说明它们更接近「当下要说的话」）。 */
  function enforceLimit() {
    const list = liveItems();
    if (list.length <= maxItems) return;
    for (const item of list.slice(0, list.length - maxItems)) {
      counters.dropped += 1;
      items.delete(item.id);
      append({ op: 'drop', id: item.id, dedupKey: item.dedupKey ?? null, reason: 'queue-full', ts: nowOf(now) });
      warn('发送队列：超上限丢弃最旧条目', `${item.id} ${item.key ?? ''}`.trim());
    }
  }

  function maybeCompact() {
    if (logLines <= compactAfter) return false;
    compact();
    return true;
  }

  ensureDir();
  load();

  return {
    version: VERSION,
    file,

    /** 待发条目数（含还没到重试时间的）。 */
    size() {
      return items.size;
    },

    /** 只读快照：按入队顺序。 */
    all() {
      return liveItems().map((item) => ({ ...item }));
    },

    /** 到点可重试的条目（按入队顺序），flush 用。 */
    pending() {
      const t = nowOf(now);
      return liveItems().filter((item) => (Number(item.nextAttemptAt) || 0) <= t).map((item) => ({ ...item }));
    },

    /** 还没到重试时间、但确实还排着的条目数（健康上报用）。 */
    waitingCount() {
      const t = nowOf(now);
      return liveItems().filter((item) => (Number(item.nextAttemptAt) || 0) > t).length;
    },

    /**
     * 入队一条待发消息。
     * @param {{key?: string, action: string, params: object, dedupKey?: string, tag?: string}} entry
     * @returns {{id: string|null, duplicate: boolean}}
     */
    enqueue(entry) {
      const t = nowOf(now);
      const dedupKey = entry?.dedupKey ? String(entry.dedupKey) : null;
      if (dedupKey) {
        const seenAt = dedupSeen.get(dedupKey);
        if (seenAt !== undefined && (t - seenAt) <= dedupTtlMs) {
          counters.duplicated += 1;
          return { id: null, duplicate: true };
        }
        const inQueue = liveItems().find((item) => item.dedupKey === dedupKey);
        if (inQueue) {
          counters.duplicated += 1;
          return { id: null, duplicate: true };
        }
      }
      if (!entry?.action || typeof entry.action !== 'string') {
        warn('发送队列：拒绝入队（缺 action）');
        return { id: null, duplicate: false };
      }
      seq += 1;
      const item = {
        id: `${t.toString(36)}-${seq.toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
        seq,
        key: entry.key ?? null,
        action: entry.action,
        params: entry.params ?? {},
        dedupKey,
        tag: entry.tag ?? null,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        enqueuedAt: t,
      };
      items.set(item.id, item);
      if (dedupKey) dedupSeen.set(dedupKey, t);
      append({ op: 'add', item });
      enforceLimit();
      maybeCompact();
      return { id: item.id, duplicate: false };
    },

    /**
     * 记一笔「正在尝试发送」。写在 POST **之前**：进程若在这次尝试中途被杀，
     * 重启后 load() 会把它算作一次尝试（见上面的 lastOp 处理），避免无限重试。
     */
    markAttempt(id) {
      const item = items.get(id);
      if (!item) return false;
      append({ op: 'attempt', id, ts: nowOf(now) });
      return true;
    },

    /** 发送成功：出队并记入去重窗口。 */
    markSent(id, { messageId = null } = {}) {
      const item = items.get(id);
      if (!item) return false;
      items.delete(id);
      counters.sent += 1;
      append({ op: 'sent', id, dedupKey: item.dedupKey ?? null, messageId, ts: nowOf(now) });
      maybeCompact();
      return true;
    },

    /**
     * 发送失败：可重试的排下一次重试；永久失败的直接丢（并写日志，避免无限重试垃圾）。
     * @returns {{retry: boolean, attempts: number, nextAttemptAt: number}}
     */
    markFailed(id, { error = null, permanent = false } = {}) {
      const item = items.get(id);
      if (!item) return { retry: false, attempts: 0, nextAttemptAt: 0 };
      if (permanent) {
        items.delete(id);
        counters.dropped += 1;
        append({ op: 'drop', id, dedupKey: item.dedupKey ?? null, reason: 'permanent-failure', error, ts: nowOf(now) });
        warn('发送队列：永久失败已丢弃', `${item.key ?? ''} ${error ?? ''}`.trim());
        return { retry: false, attempts: item.attempts, nextAttemptAt: 0 };
      }
      item.attempts += 1;
      const delay = backoff && typeof backoff.next === 'function'
        ? backoff.next()
        : Math.min(60000, 1000 * Math.pow(2, item.attempts - 1));
      item.nextAttemptAt = nowOf(now) + Math.max(0, Number(delay) || 0);
      item.lastError = error == null ? null : String(error).slice(0, 300);
      counters.failed += 1;
      append({ op: 'fail', id, attempts: item.attempts, nextAttemptAt: item.nextAttemptAt, error: item.lastError, ts: nowOf(now) });
      maybeCompact();
      return { retry: true, attempts: item.attempts, nextAttemptAt: item.nextAttemptAt };
    },

    /** 主动撤销（R8 的「撤回未执行的待发送任务」也走它）。 */
    remove(id, { reason = 'cancelled' } = {}) {
      const item = items.get(id);
      if (!item) return false;
      items.delete(id);
      counters.dropped += 1;
      append({ op: 'drop', id, dedupKey: item.dedupKey ?? null, reason, ts: nowOf(now) });
      return true;
    },

    /** 丢掉全部待发（重启前的极端手段，调用方要自己决定要不要）。 */
    clear({ reason = 'cleared' } = {}) {
      const removed = [];
      for (const item of liveItems()) {
        items.delete(item.id);
        counters.dropped += 1;
        append({ op: 'drop', id: item.id, dedupKey: item.dedupKey ?? null, reason, ts: nowOf(now) });
        removed.push(item.id);
      }
      return removed.length;
    },

    /** 该 dedupKey 是否在去重窗口内（待发或刚发成功）。 */
    isDuplicate(dedupKey) {
      if (!dedupKey) return false;
      const seenAt = dedupSeen.get(String(dedupKey));
      if (seenAt !== undefined && (nowOf(now) - seenAt) <= dedupTtlMs) return true;
      return liveItems().some((item) => item.dedupKey === String(dedupKey));
    },

    /** 过期清理（桥接定时器会带着调，也可以在 flush 前调一次）。 */
    prune() {
      pruneExpired();
      return items.size;
    },

    /** 把追加日志压成一份最小日志（只保留当前仍在队列里的条目）。 */
    compact() {
      const t = nowOf(now);
      const lines = liveItems().map((item) => JSON.stringify({ op: 'add', item }));
      try {
        if (lines.length === 0) {
          fs.writeFileSync(file, '', 'utf8');
        } else {
          const tmp = `${file}.tmp`;
          fs.writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8');
          fs.renameSync(tmp, file);
        }
        logLines = lines.length;
      } catch (error) {
        lastError = error;
        warn('发送队列压缩失败（继续用追加日志）', error?.message ?? error);
      }
      return { file, items: items.size, lines: logLines, at: t };
    },

    stats() {
      const list = liveItems();
      const t = nowOf(now);
      return {
        pending: list.length,
        due: list.filter((item) => (Number(item.nextAttemptAt) || 0) <= t).length,
        waiting: list.filter((item) => (Number(item.nextAttemptAt) || 0) > t).length,
        oldestAt: list.length ? Number(list[0].enqueuedAt) || null : null,
        lastError: lastError ? String(lastError?.message ?? lastError).slice(0, 200) : null,
        file,
        logLines,
        maxItems,
        maxAgeMs,
        ...counters,
      };
    },

    /** 重新从磁盘读（单测/人工修复后用）。 */
    reload() {
      load();
      return items.size;
    },
  };
}