#!/usr/bin/env node
/**
 * 手动跑一轮「历史对话 → 长期记忆」的摄入（R1）。
 *
 * 用法：
 *   node scripts/qqb-memory-intake.mjs --dry-run            # 只看会抽出什么，一个字都不写
 *   node scripts/qqb-memory-intake.mjs                      # 真的写进 state/memory.db
 *   node scripts/qqb-memory-intake.mjs --key=private:1000000001
 *   node scripts/qqb-memory-intake.mjs --json               # 机器可读
 *   node scripts/qqb-memory-intake.mjs --reset              # 清掉水位（下次从头扫，靠 hash 去重）
 *
 * 注意：桥接进程自己在跑定时摄入（默认 10 分钟一轮）。这个脚本是「立刻跑一轮 + 看结果」的
 * 调试入口；两边共用同一个水位文件，谁先跑谁推进水位，不会重复写库。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/qqb/memory/store.mjs';
import { createIntake, readHistorySince, listHistoryKeys, VERSION as INTAKE_VERSION } from '../src/qqb/memory/intake.mjs';
import { createConfig } from '../src/qqb/core/config.mjs';
import { createLogger } from '../src/qqb/core/log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function argOf(name, fallback = null) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
}

const dryRun = Boolean(argOf('dry-run', false));
const asJson = Boolean(argOf('json', false));
const reset = Boolean(argOf('reset', false));
const limit = Number(argOf('limit', 12)) || 12;
const keyArg = argOf('key', null);
const keys = typeof keyArg === 'string' && keyArg ? [keyArg] : undefined;

const logger = createLogger({ module: 'memory-intake', root: REPO_ROOT, level: 'info', echo: false });
const config = createConfig({ root: REPO_ROOT, logger });

if (reset) {
  const file = path.join(REPO_ROOT, 'state', 'memory-intake.json');
  try { fs.rmSync(file, { force: true }); console.log(`已清掉水位：${file}`); } catch (err) { console.error(`清水位失败：${err?.message ?? err}`); }
}

const store = openStore({ root: REPO_ROOT, logger });
const intake = createIntake({
  root: REPO_ROOT,
  store,
  ownerQQOf: () => config.get('ownerQQ'),
  logger,
  readRecords: (key, opts) => readHistorySince({ root: REPO_ROOT, key, ...opts }),
  maxPerRun: limit,
});

const result = intake.run({ keys, dryRun });

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const mode = dryRun ? '试运行（不写库）' : '正式写入';
  console.log(`qqb 历史摄入 v${INTAKE_VERSION} · ${mode}`);
  console.log(`水位文件：${intake.watermarkPath}`);
  const allKeys = keys ?? listHistoryKeys({ root: REPO_ROOT });
  console.log(`会话数：${allKeys.length}，本轮有新增内容的：${result.keys}，扫描记录：${result.scanned}`);
  if (!dryRun) console.log(`写入：新增 ${result.inserted}，合并 ${result.merged}，丢弃 ${result.rejected}`);
  for (const s of result.sessions) {
    const items = s.candidates ?? [];
    if (!items.length) continue;
    console.log(`\n[${s.key}]（层：${s.layer ?? '?'}）${items.length} 条`);
    for (const c of items) {
      const kind = c.kind ?? '?';
      const action = c.action ? ` → ${c.action}` : '';
      console.log(`  - （${kind}）${c.subject ? `${c.subject}：` : ''}${c.text}${action}`);
    }
  }
  if (result.errors?.length) {
    console.log('\n错误：');
    for (const e of result.errors) console.log(`  - ${e.key}: ${e.error}`);
  }
}

try { store.close?.(); } catch { /* 关不掉也不影响结果 */ }