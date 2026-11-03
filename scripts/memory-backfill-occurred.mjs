#!/usr/bin/env node
/**
 * 给老记忆补「发生时间」：把 evidence 开头那个 `[YYYY-MM-DD]`（巩固时写进去的）
 * 提升成 `meta.occurredAt`。
 *
 * 为什么要这一步：巩固是**事后批量**跑的，`created_at` 只是入库时间。11-02 白天的事
 * 可能是 11-03 凌晨才巩固进库，于是提示词里就显示成「今天」。证据里本来就带着那天的
 * 日期，只是从来没被当成时间用（2026-11-03 主人：「之前的在记忆库也没有时间维度吗」）。
 *
 * 用法：
 *   node scripts/memory-backfill-occurred.mjs            # 预演
 *   node scripts/memory-backfill-occurred.mjs --apply    # 真写
 */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const APPLY = process.argv.includes('--apply');
const db = new DatabaseSync(path.join(ROOT, 'state', 'memory.db'));

/** `[2026-11-02] …` → 本地中午 12:00 的时间戳（中午不会跨时区跑到前一天）。 */
export function occurredFromEvidence(evidence) {
  const m = /^\[(\d{4})-(\d{2})-(\d{2})\]/.exec(String(evidence ?? '').trim());
  if (!m) return 0;
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

const rows = db.prepare(
  "SELECT id, mem_level, evidence, meta, created_at FROM memories WHERE deleted_at IS NULL AND evidence LIKE '[%'"
).all();

let todo = 0;
let already = 0;
const samples = [];
for (const row of rows) {
  const want = occurredFromEvidence(row.evidence);
  if (!want) continue;
  let meta = {};
  if (row.meta) {
    try { meta = JSON.parse(row.meta) ?? {}; } catch { meta = {}; }
  }
  if (Number(meta.occurredAt) === want) { already += 1; continue; }
  todo += 1;
  if (samples.length < 6) {
    samples.push(`#${row.id} ${row.mem_level ?? '-'} 入库 ${new Date(Number(row.created_at)).toISOString().slice(0, 10)} → 发生 ${String(row.evidence).slice(1, 11)}`);
  }
  if (APPLY) {
    const next = JSON.stringify({ ...meta, occurredAt: want });
    db.prepare('UPDATE memories SET meta = ? WHERE id = ?').run(next, row.id);
  }
}

db.close();
console.log(samples.join('\n'));
console.log(`\n扫到 ${rows.length} 条带 [日期] 证据的记忆：要补 ${todo} 条，已有 ${already} 条。`);
console.log(APPLY ? '已写入 meta.occurredAt。' : '（预演，没写库；加 --apply 才真写）');