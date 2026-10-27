#!/usr/bin/env node
/**
 * 让某类记忆「退场」：把命中的行设成已过期（expires_at = now），不删、不丢历史。
 *
 * 为什么需要这个：有些约定是「当时答应过」的一次性事件（比如每天早上七点五十四叫妈妈
 * 抽查单词）。条目留在库里、又永远不过期，就会一轮一轮被注入提示词，她就一直往那件事上
 * 拐 —— 2026-10-27 主人反馈「不要总是揪着妈妈背单词，可以多几种」，根子就在这里。
 *
 * 过期 = recall 不再返回（store.recall 的 where 里有 expires_at 过滤），但行还在、
 * 想翻历史随时能查到，比直接删干净得多。
 *
 * 用法：
 *   node scripts/memory-retire.mjs --match 单词 --kinds promise,topic,event          # 预演
 *   node scripts/memory-retire.mjs --match 单词 --kinds promise,topic,event --apply   # 真写
 *   node scripts/memory-retire.mjs --list --match 单词                                 # 只看命中哪些
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const DB = path.join(ROOT, 'state', 'memory.db');

function parseArgs(argv) {
  const out = { match: '', kinds: [], list: false, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--list') out.list = true;
    else if (a === '--match') out.match = String(argv[++i] ?? '').trim();
    else if (a === '--kinds') out.kinds = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.match) {
  console.error('用法：node scripts/memory-retire.mjs --match <关键词> [--kinds promise,topic] [--list] [--apply]');
  process.exit(2);
}
if (!fs.existsSync(DB)) {
  console.error(`找不到记忆库：${DB}`);
  process.exit(2);
}

const db = new DatabaseSync(DB);
const like = `%${args.match}%`;
const params = [like, like];
let sql = `SELECT id, kind, scope, subject, text, importance, use_count, expires_at, created_at
             FROM memories
            WHERE deleted_at IS NULL AND archived_at IS NULL
              AND (text LIKE ? OR subject LIKE ?)`;
if (args.kinds.length) {
  sql += ` AND kind IN (${args.kinds.map(() => '?').join(',')})`;
  params.push(...args.kinds);
}
sql += ' ORDER BY created_at ASC';
const rows = db.prepare(sql).all(...params);

if (!rows.length) {
  console.log(`没有命中「${args.match}」${args.kinds.length ? `（kind: ${args.kinds.join('/')}）` : ''}的记忆。`);
  process.exit(0);
}

const fmt = (r) => `#${r.id} [${r.kind}] ${r.scope} imp=${r.importance} use=${r.use_count} exp=${r.expires_at ?? 'null'} :: ${String(r.text).slice(0, 80)}`;
for (const r of rows) console.log(fmt(r));
console.log(`\n命中 ${rows.length} 条${args.kinds.length ? `（kind: ${args.kinds.join('/')}）` : ''}。`);

if (args.list || !args.apply) {
  console.log(args.list ? '' : '（预演，没写库；加 --apply 才真过期）');
  process.exit(0);
}

const now = Date.now();
const stmt = db.prepare('UPDATE memories SET expires_at = ?, updated_at = ? WHERE id = ? AND (expires_at IS NULL OR expires_at > ?)');
let changed = 0;
for (const r of rows) {
  const info = stmt.run(now, now, r.id, now);
  if (info.changes) changed += 1;
}
db.close();
console.log(`已把 ${changed} 条设为过期（expires_at=${now}）；剩下的本来就已经过期了。`);