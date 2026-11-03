#!/usr/bin/env node
/**
 * 记忆去重：同一条事被巩固过好几次时，只留「最值得留」的那一条，其余置过期（不删）。
 *
 * 为什么需要：2026-11-03 主人发现提示词里「我这边开了权限马上补」「（承诺）」反复出现十次。
 * L3/L4 巩固是按天跑的，同一件事在不同的天里被重新总结一遍，措辞略有差别、行却是新的：
 * 库里 87 条 promise 里有一大批是「七点五十四抽查单词」的同义反复，靠 weight 霸榜
 * 每轮注入（此前用 memory-retire.mjs 按关键词退役过 41 条，这里改成按「重复」自动判）。
 *
 * 两层判重：
 *   1) 归一化后完全一样（去空白/标点/emoji、全角半角、大小写）—— 默认开。
 *   2) 词袋 Jaccard ≥ 阈值（默认关，`--similar 0.86` 才开）—— 用来抓「同义改写」，
 *      但它会误伤「约定明天抽查」和「约定今晚抽查」这种日期不同的事，所以必须人工看预演。
 *
 * 保留谁：use_count 高的优先（被反复验证过的更可信）→ importance 高的 → created_at 新的。
 * 置过期而不是删除：`expires_at = now` 之后 recall 不再返回，但行还在，翻历史随时可查。
 *
 * 用法：
 *   node scripts/memory-dedupe.mjs                        # 预演（默认只比完全相同）
 *   node scripts/memory-dedupe.mjs --similar 0.86         # 预演：连「同义改写」一起看
 *   node scripts/memory-dedupe.mjs --apply                # 真写（完全相同的）
 *   node scripts/memory-dedupe.mjs --similar 0.86 --apply # 真写（含同义）
 *   node scripts/memory-dedupe.mjs --kinds promise,fact   # 只处理这几类（默认排除 message）
 *   node scripts/memory-dedupe.mjs --scope private:3250968635
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const DB = path.join(ROOT, 'state', 'memory.db');

/** 默认不碰 message（L2 原话底账）：同一句话对方真说过两次，是历史，不是重复。 */
export const DEFAULT_SKIP_KINDS = ['message'];

/** 归一化：去空白、标点、符号（含 emoji）、大小写，全角转半角。 */
export function normalizeMemoryText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .trim();
}

/** 中文没有空格，词袋用「二字组」代替切词；顺带保留英文/数字整词。 */
export function bagOf(text) {
  const s = String(text ?? '').normalize('NFKC').toLowerCase();
  const bag = new Set();
  for (const w of s.match(/[a-z0-9]{2,}/g) ?? []) bag.add(w);
  for (const run of s.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) bag.add(run.slice(i, i + 2));
  }
  return bag;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 把候选行分成「重复组」：返回 [{ keep, drop: [...] }]，组内至少 2 条。
 * rows 每项需要 { id, kind, scope, text, use_count, importance, created_at }。
 */
export function findDuplicateGroups(rows, { similar = 0, skipKinds = DEFAULT_SKIP_KINDS } = {}) {
  const skip = new Set(skipKinds);
  const usable = rows.filter((r) => r && !skip.has(r.kind) && String(r.text ?? '').trim());
  const rank = (r) =>
    [Number(r.use_count) || 0, Number(r.importance) || 0, Number(r.created_at) || 0];

  // 第一层：归一化后完全相同（同 kind + 同 scope 才算，跨会话各留一份是设计）。
  const exact = new Map();
  for (const r of usable) {
    const key = `${r.kind}|${r.scope}|${normalizeMemoryText(r.text)}`;
    if (!exact.has(key)) exact.set(key, []);
    exact.get(key).push(r);
  }

  const used = new Set();
  const groups = [];
  for (const list of exact.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => {
      const [ua, ia, ca] = rank(a);
      const [ub, ib, cb] = rank(b);
      return ub - ua || ib - ia || cb - ca;
    });
    groups.push({ keep: sorted[0], drop: sorted.slice(1), why: 'exact' });
    for (const r of list) used.add(r.id);
  }

  // 第二层（可选）：同 kind + 同 scope 里词袋相似度够高的，归到「保留者」名下。
  if (similar > 0) {
    const byBucket = new Map();
    for (const r of usable) {
      if (used.has(r.id)) continue;
      const key = `${r.kind}|${r.scope}`;
      if (!byBucket.has(key)) byBucket.set(key, []);
      byBucket.get(key).push({ r, bag: bagOf(r.text) });
    }
    for (const list of byBucket.values()) {
      const kept = [];
      for (const item of list.sort((a, b) => {
        const [ua, ia, ca] = rank(a.r);
        const [ub, ib, cb] = rank(b.r);
        return ub - ua || ib - ia || cb - ca;
      })) {
        const hit = kept.find((k) => jaccard(k.bag, item.bag) >= similar);
        if (hit) groups.push({ keep: hit.r, drop: [item.r], why: `similar≥${similar}` });
        else kept.push(item);
      }
    }
  }

  return groups;
}

export function parseArgs(argv) {
  const out = { apply: false, similar: 0, kinds: [], scope: '', list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--list') out.list = true;
    else if (a === '--similar') out.similar = Number(argv[++i]) || 0;
    else if (a === '--kinds') out.kinds = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--scope') out.scope = String(argv[++i] ?? '').trim();
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(DB)) {
    console.error(`找不到记忆库：${DB}`);
    process.exit(2);
  }
  const db = new DatabaseSync(DB);
  const now = Date.now();
  const where = ['deleted_at IS NULL', 'archived_at IS NULL', "(expires_at IS NULL OR expires_at > ?)"];
  const params = [now];
  if (args.kinds.length) {
    where.push(`kind IN (${args.kinds.map(() => '?').join(',')})`);
    params.push(...args.kinds);
  }
  if (args.scope) {
    where.push('scope = ?');
    params.push(args.scope);
  }
  const rows = db
    .prepare(`SELECT id, kind, scope, text, use_count, importance, created_at, expires_at FROM memories WHERE ${where.join(' AND ')}`)
    .all(...params);

  const groups = findDuplicateGroups(rows, { similar: args.similar });
  if (!groups.length) {
    console.log(`没有发现重复（候选 ${rows.length} 条${args.kinds.length ? `，kind: ${args.kinds.join('/')}` : ''}）。`);
    db.close();
    return;
  }

  const fmt = (r) => `#${r.id} [${r.kind}] ${r.scope} use=${r.use_count} imp=${r.importance} :: ${String(r.text).slice(0, 70)}`;
  const dropSet = new Set();
  for (const g of groups) {
    console.log(`— ${g.why}：留 ${fmt(g.keep)}`);
    for (const d of g.drop) {
      console.log(`   过期 ${fmt(d)}`);
      dropSet.add(d.id);
    }
  }
  console.log(`\n发现 ${groups.length} 组重复，要过期 ${dropSet.size} 条（保留 ${groups.length} 条）。`);

  if (!args.apply) {
    console.log('（预演，没写库；加 --apply 才真过期）');
    db.close();
    return;
  }

  const stmt = db.prepare('UPDATE memories SET expires_at = ?, updated_at = ? WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)');
  let changed = 0;
  for (const id of dropSet) {
    const info = stmt.run(now, now, id, now);
    if (info.changes) changed += 1;
  }
  db.close();
  console.log(`已把 ${changed} 条设为过期（expires_at=${now}）。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();