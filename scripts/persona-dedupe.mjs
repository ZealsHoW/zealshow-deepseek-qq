#!/usr/bin/env node
/**
 * 人设特征去重：`state/persona-traits.json` 里同一件事被演化过好几次时，只留权重最高的那条。
 *
 * 为什么需要：这些特征每轮都会以「（承诺）…（近况）…」注入提示词。一件事被记成两条时
 * 它等于被强调了两遍 —— 2026-11-03 主人说「她总把前几天的事记成今天、机制太僵硬」，
 * 翻出来一堆同义条目（九寨沟水獭两条、云朵照片两条、截图两条、淘宝摇一摇两条）。
 * 归一化只能抓一模一样的，所以这里用二字组 Jaccard（默认 0.6）抓「换了说法」的同一条。
 *
 * 用法：
 *   node scripts/persona-dedupe.mjs                # 预演
 *   node scripts/persona-dedupe.mjs --apply        # 真写（先备份 .bak-<时间>）
 *   node scripts/persona-dedupe.mjs --similar 0.7  # 换阈值
 */
import fs from 'node:fs';
import path from 'node:path';
import { bagOf, jaccard } from '../src/qqb/persona/evolve.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'state', 'persona-traits.json');

function parseArgs(argv) {
  const out = { apply: false, similar: 0.6 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') out.apply = true;
    else if (argv[i] === '--similar') out.similar = Number(argv[++i]) || 0.6;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!fs.existsSync(FILE)) {
  console.error(`找不到人设特征文件：${FILE}`);
  process.exit(2);
}
const state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const traits = state.traits && typeof state.traits === 'object' ? state.traits : {};

let dropped = 0;
for (const [kind, list] of Object.entries(traits)) {
  if (!Array.isArray(list) || list.length < 2) continue;
  const kept = [];
  const sorted = [...list].sort((a, b) => (Number(b.weight) - Number(a.weight)) || (Number(b.at) - Number(a.at)));
  for (const t of sorted) {
    const bag = bagOf(t.text);
    const hit = kept.find((k) => jaccard(bagOf(k.text), bag) >= args.similar);
    if (hit) {
      console.log(`[${kind}] 留「${hit.text}」（w=${hit.weight}）`);
      console.log(`      并掉「${t.text}」`);
      // 并掉的条目把权重叠一点上去，别让「被说过两次」反而变轻。
      hit.weight = Math.min(1, Math.max(Number(hit.weight) || 0.5, Number(t.weight) || 0.5) + 0.02);
      dropped += 1;
    } else {
      kept.push({ ...t });
    }
  }
  traits[kind] = kept;
}

if (!dropped) {
  console.log(`没有发现近重复（阈值 ${args.similar}）。`);
  process.exit(0);
}
console.log(`\n共 ${dropped} 条会被并掉。`);
if (!args.apply) {
  console.log('（预演，没写文件；加 --apply 才真写）');
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.copyFileSync(FILE, `${FILE}.bak-${stamp}`);
state.updatedAt = Date.now();
fs.writeFileSync(FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
console.log(`已写回（备份 ${path.basename(FILE)}.bak-${stamp}）。`);