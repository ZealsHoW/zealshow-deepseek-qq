#!/usr/bin/env node
// 把 state/history/*.jsonl 里的历史消息回填进 L2 原文底账（kind='message'）。
//
// 为什么需要它：L2 是 2026-10-29 才上线的，之前所有对话只在 history 里，
// 夜间巩固/做梦读不到，面板的时间轴也是空的。这脚本把历史补进去。
//
// 安全性：
//   · 默认是 dry-run，只统计不写；加 --apply 才真的写。
//   · 写入走 store 的 hash 去重：同一会话里一模一样的句子会合并（use_count+1），
//     所以重复跑不会把库撑爆，也不会产生重复行。
//   · 原文按 live.recordOriginal 的老规矩办：少于 4 个字的短语不记（「嗯」「哈」）。
//   · 时间用消息原本的时间戳（store.remember 支持 at），时间轴才不会全挤在今天。
//
// 用法：
//   node scripts/backfill-originals.mjs                      # 预演，只统计
//   node scripts/backfill-originals.mjs --apply              # 真写
//   node scripts/backfill-originals.mjs --apply --since 2026-10-01
//   node scripts/backfill-originals.mjs --apply --scope private:3482501440
//   node scripts/backfill-originals.mjs --apply --min-chars 2  # 连「嗯」也记

import fs from 'node:fs';
import path from 'node:path';
import { createLiveMemory } from '../src/qqb/memory/live.mjs';

const ROOT = process.cwd();
const HISTORY_DIR = path.join(ROOT, 'state', 'history');

function parseArgs(argv) {
  const opts = { apply: false, minChars: 4, since: 0, scope: '', until: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--min-chars') opts.minChars = Math.max(1, Number(argv[++i]) || 4);
    else if (a === '--scope') opts.scope = String(argv[++i] ?? '').trim();
    else if (a === '--since') {
      const raw = String(argv[++i] ?? '');
      const ts = Date.parse(raw);
      if (Number.isFinite(ts)) opts.since = ts;
    } else if (a === '--until') {
      const raw = String(argv[++i] ?? '');
      const ts = Date.parse(raw);
      if (Number.isFinite(ts)) opts.until = ts;
    }
  }
  return opts;
}

function scopeOfFile(file) {
  const name = path.basename(file, '.jsonl');
  const m = /^(private|group)_(\d+)$/.exec(name);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const opts = parseArgs(process.argv.slice(2));
const cfg = readConfig();
const ownerQQ = String(cfg?.socialV2?.ownerQQ ?? cfg?.ownerQQ ?? '').trim();

if (!fs.existsSync(HISTORY_DIR)) {
  console.error(`找不到历史目录：${HISTORY_DIR}`);
  process.exit(1);
}

const files = fs.readdirSync(HISTORY_DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => path.join(HISTORY_DIR, f))
  .filter((f) => scopeOfFile(f))
  .filter((f) => !opts.scope || scopeOfFile(f) === opts.scope);

if (!files.length) {
  console.error('没有可回填的历史文件（检查 --scope）');
  process.exit(1);
}

const mem = createLiveMemory({
  root: ROOT,
  ownerQQOf: () => ownerQQ,
  logger: { warn: (a, b) => console.warn('[记忆]', a, b ?? '') },
});

const startedAt = Date.now();
const stats = { files: 0, lines: 0, skippedShort: 0, skippedTime: 0, skippedBad: 0, inserted: 0, merged: 0, revived: 0, rejected: 0 };
const rejectReasons = new Map();
const perScope = new Map();

for (const file of files) {
  const scope = scopeOfFile(file);
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/);
  const scopeStat = { lines: 0, inserted: 0, merged: 0, skipped: 0 };
  stats.files += 1;

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      stats.skippedBad += 1;
      continue;
    }
    stats.lines += 1;
    scopeStat.lines += 1;
    const text = String(rec?.x ?? '').trim();
    if (!text) { stats.skippedBad += 1; continue; }
    if (text.length < opts.minChars) { stats.skippedShort += 1; scopeStat.skipped += 1; continue; }
    const at = Number(rec?.t) || 0;
    if (opts.since && at && at < opts.since) { stats.skippedTime += 1; continue; }
    if (opts.until && at && at > opts.until) { stats.skippedTime += 1; continue; }

    if (!opts.apply) {
      scopeStat.inserted += 1;
      continue;
    }
    const role = rec?.self === true ? 'assistant' : 'user';
    const subject = role === 'assistant' ? 'assistant' : (String(rec?.s ?? '').trim() || 'user');
    const result = mem.recordOriginal({ key: scope, role, text, at, subject });
    const action = String(result?.action ?? 'rejected');
    if (action === 'inserted') { stats.inserted += 1; scopeStat.inserted += 1; }
    else if (action === 'merged') { stats.merged += 1; scopeStat.merged += 1; }
    else if (action === 'revived') { stats.revived += 1; }
    else {
      stats.rejected += 1;
      const reason = String(result?.reason ?? 'unknown');
      rejectReasons.set(reason, (rejectReasons.get(reason) ?? 0) + 1);
    }
  }
  perScope.set(scope, scopeStat);
}

const ms = Date.now() - startedAt;
console.log(opts.apply ? '=== 已写入 ===' : '=== 预演（没有写库，加 --apply 才真写）===');
for (const [scope, s] of perScope) {
  console.log(`${scope.padEnd(22)} 读 ${String(s.lines).padStart(5)} 行 · 新记 ${s.inserted} · 合并 ${s.merged} · 跳过(太短) ${s.skipped}`);
}
console.log('—'.repeat(60));
console.log(`文件 ${stats.files} · 读 ${stats.lines} 行 · 新记 ${stats.inserted} · 合并 ${stats.merged} · 复活 ${stats.revived} · 拒收 ${stats.rejected} · 太短 ${stats.skippedShort} · 坏行 ${stats.skippedBad} · 用时 ${(ms / 1000).toFixed(1)}s`);
for (const [reason, n] of rejectReasons) console.log(`  拒收原因：${reason} × ${n}`);
if (!opts.apply) console.log('（预演完成：上面「新记」是上限，真写时一部分会因为同句重复变成合并）');