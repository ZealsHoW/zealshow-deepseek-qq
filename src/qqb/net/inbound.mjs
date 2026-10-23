// 入站消息去重（R4）。
//
// 为什么需要它：SnowLuma 的 WS 断线重连、`catchUp` 上线补漏、以及「历史上同一个
// message_id 被两条路径都捞到」这几种情况会给出同一条消息；桥接的 handleIncoming
// 一旦重复执行，模型会看到同一句话两遍（甚至回答两遍）。
//
// 语义取舍：
//   - 记的是**引用集合**（message_id + message_seq），任何一个命中即视为重复；
//   - 只保留 TTL 内的记录（默认 24h），上限 maxEntries，避免无限增长；
//   - **fail-open**：落盘/读取失败时一律放行（宁可偶尔重复处理，也不能吞掉真消息）。
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.0';
export const DEFAULTS = { ttlMs: 86400000, maxEntries: 5000, compactAfter: 2000 };

export function createInboundDedup({
  root = null,
  file = null,
  logger = null,
  now = Date.now,
  ttlMs = DEFAULTS.ttlMs,
  maxEntries = DEFAULTS.maxEntries,
  compactAfter = DEFAULTS.compactAfter
} = {}) {
  const target = file ?? (root ? path.join(root, 'state', 'inbound-seen.jsonl') : null);
  const seen = new Map(); // ref -> 首次见到的时间
  const counters = { loaded: 0, accepted: 0, duplicated: 0, evicted: 0, compactions: 0, writeFailures: 0 };
  let lines = 0;

  function warn(message, detail) {
    try { logger?.warn?.(message, detail); } catch { /* 日志失败不影响去重 */ }
  }

  function load() {
    if (!target) return;
    try {
      if (!fs.existsSync(target)) return;
      const raw = fs.readFileSync(target, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        lines += 1;
        let rec = null;
        try { rec = JSON.parse(line); } catch { continue; }
        const ref = rec?.ref != null ? String(rec.ref) : '';
        const t = Number(rec?.t);
        if (!ref || !Number.isFinite(t)) continue;
        const prev = seen.get(ref);
        if (prev == null || t > prev) seen.set(ref, t);
        counters.loaded += 1;
      }
      prune();
    } catch (error) {
      warn(`入站去重记录读取失败（放行所有消息）：${error?.message ?? error}`);
    }
  }

  function prune() {
    const cutoff = now() - Math.max(0, Number(ttlMs) || DEFAULTS.ttlMs);
    for (const [ref, t] of seen) {
      if (t < cutoff) { seen.delete(ref); counters.evicted += 1; }
    }
    const cap = Math.max(1, Number(maxEntries) || DEFAULTS.maxEntries);
    while (seen.size > cap) {
      const oldest = seen.keys().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
      counters.evicted += 1;
    }
  }

  function append(entries) {
    if (!target || !entries.length) return;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const body = entries.map(({ ref, t }) => JSON.stringify({ ref, t })).join('\n');
      fs.appendFileSync(target, `${body}\n`, 'utf8');
      lines += entries.length;
    } catch (error) {
      counters.writeFailures += 1;
      warn(`入站去重记录写入失败（下次仍会去重，但重启后可能重复）：${error?.message ?? error}`);
    }
  }

  function compact() {
    if (!target || lines <= compactAfter) return false;
    try {
      prune();
      const body = [...seen.entries()].map(([ref, t]) => JSON.stringify({ ref, t })).join('\n');
      const tmp = `${target}.tmp`;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, body ? `${body}\n` : '', 'utf8');
      fs.renameSync(tmp, target);
      lines = seen.size;
      counters.compactions += 1;
      return true;
    } catch (error) {
      warn(`入站去重记录压缩失败：${error?.message ?? error}`);
      return false;
    }
  }

  // 真：这条消息没处理过（并把它的引用登记下来）。假：TTL 内见过。
  function admit(refs) {
    const list = [];
    for (const ref of Array.isArray(refs) ? refs : [refs]) {
      const s = ref == null ? '' : String(ref).trim();
      if (s && !list.includes(s)) list.push(s);
    }
    if (!list.length) return { ok: true, refs: [] };
    try {
      const t = now();
      prune();
      const cutoff = t - Math.max(0, Number(ttlMs) || DEFAULTS.ttlMs);
      for (const ref of list) {
        const prev = seen.get(ref);
        if (prev != null && prev >= cutoff) {
          counters.duplicated += 1;
          return { ok: false, duplicate: ref, refs: list };
        }
      }
      const fresh = [];
      for (const ref of list) {
        if (!seen.has(ref)) fresh.push({ ref, t });
        seen.set(ref, t);
      }
      counters.accepted += 1;
      append(fresh);
      if (seen.size > Math.max(1, Number(maxEntries) || DEFAULTS.maxEntries)) prune();
      compact();
      return { ok: true, refs: list };
    } catch (error) {
      counters.writeFailures += 1;
      warn(`入站去重判断失败（放行）：${error?.message ?? error}`);
      return { ok: true, refs: list, degraded: true };
    }
  }

  function stats() {
    return {
      file: target, size: seen.size, lines, ttlMs, maxEntries,
      oldestAt: seen.size ? Math.min(...seen.values()) : null,
      ...counters
    };
  }

  load();
  return { version: VERSION, admit, has: (ref) => seen.has(String(ref)), stats, prune, compact };
}