#!/usr/bin/env node
/**
 * 手动跑一轮 R1 的「LLM 精炼」或「旧记忆归档」。
 *
 * 用法：
 *   node scripts/qqb-memory-refine.mjs --dry-run        # 只组装提示词，不调模型、不写库
 *   node scripts/qqb-memory-refine.mjs                  # 真调一次模型并写进 state/memory.db
 *   node scripts/qqb-memory-refine.mjs --force          # 无视「新增不足 N 条」与每日轮数上限
 *   node scripts/qqb-memory-refine.mjs --key=private:1000000001
 *   node scripts/qqb-memory-refine.mjs --json           # 机器可读
 *   node scripts/qqb-memory-refine.mjs --reset          # 清掉提炼水位（下次从头扫，靠 hash 去重）
 *   node scripts/qqb-memory-refine.mjs --archive --dry-run   # 看旧记忆归档会挑中谁
 *   node scripts/qqb-memory-refine.mjs --archive            # 真归档（先导出 state/memory-archive.jsonl）
 *
 * 注意：桥接进程自己在跑定时精炼（默认 6 小时一轮）与归档（默认 24 小时一轮）。
 * 这个脚本是「立刻跑一轮 + 看结果」的调试入口，两边共用同一份水位文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/qqb/memory/store.mjs';
import { createRefiner, VERSION as REFINE_VERSION } from '../src/qqb/memory/refine.mjs';
import { readHistorySince } from '../src/qqb/memory/intake.mjs';
import { createModelClient } from '../src/qqb/model/client.mjs';
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
const force = Boolean(argOf('force', false));
const archiveMode = Boolean(argOf('archive', false));
const showPrompt = Boolean(argOf('show-prompt', false));
const keyArg = argOf('key', null);
const keys = typeof keyArg === 'string' && keyArg ? [keyArg] : undefined;

const logger = createLogger({ module: 'memory-refine', root: REPO_ROOT, level: 'info', echo: false });
const config = createConfig({ root: REPO_ROOT, logger });
const memoryCfg = config.get('socialV2.memoryDb') ?? {};

const store = openStore({ root: REPO_ROOT, logger });

if (archiveMode) {
  const archiveCfg = memoryCfg.archive || {};
  const olderThanDays = Math.max(1, Number(archiveCfg.olderThanDays) || 30);
  const result = store.archiveOld({
    olderThanMs: olderThanDays * 24 * 60 * 60 * 1000,
    maxImportance: Number.isFinite(Number(archiveCfg.maxImportance)) ? Number(archiveCfg.maxImportance) : 0.45,
    maxUseCount: Math.max(0, Number(archiveCfg.maxUseCount) || 0),
    limit: Math.max(1, Number(archiveCfg.maxPerRun) || 200),
    dryRun,
    exportTo: path.join(REPO_ROOT, 'state', 'memory-archive.jsonl'),
  });
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`qqb 旧记忆归档 · ${dryRun ? '试运行（不改库）' : '正式归档'}`);
    console.log(`条件：${olderThanDays} 天没被用过、重要性 ≤ ${archiveCfg.maxImportance ?? 0.45}`);
    console.log(`候选 ${result.candidates} 条，${dryRun ? '（试运行未改库）' : `实际归档 ${result.archived} 条`}${result.file ? `\n导出：${result.file}` : ''}`);
    const stats = store.stats();
    console.log(`库里现状：在用 ${stats.active ?? stats.total} 条 / 已归档 ${stats.archived ?? 0} 条 / 已删 ${stats.deleted} 条`);
  }
} else {
  if (reset) {
    const file = path.join(REPO_ROOT, 'state', 'memory-refine.json');
    try { fs.rmSync(file, { force: true }); console.log(`已清掉提炼水位：${file}`); } catch (err) { console.error(`清水位失败：${err?.message ?? err}`); }
  }
  // 注意：`createModelClient` 认的是**普通对象**（`config.model…`），不是 `createConfig()` 那层带 `get()` 的壳。
  // 传壳进去会被当成「model.enabled=false」直接拒掉（真机上踩过一次）。
  const model = createModelClient({ config: config.all(), env: process.env, logger });
  const refineCfg = memoryCfg.refine || {};
  const refiner = createRefiner({
    root: REPO_ROOT,
    store,
    model,
    ownerQQOf: () => config.get('ownerQQ'),
    logger,
    readRecords: (key, opts) => readHistorySince({ root: REPO_ROOT, key, ...opts }),
    maxFacts: Math.max(1, Math.min(20, Number(refineCfg.maxFacts) || 8)),
    minNewRecords: Math.max(1, Number(refineCfg.minNewRecords) || 16),
    maxInputChars: Math.max(1000, Number(refineCfg.maxInputChars) || 6000),
    maxRunsPerDay: Math.max(1, Number(refineCfg.maxRunsPerDay) || 8),
    maxTokens: Math.max(200, Number(refineCfg.maxTokens) || 700),
  });

  const result = await refiner.run({ keys, dryRun, force, onMessages: showPrompt ? (messages) => {
    for (const m of messages) {
      console.log(`\n===== ${m.role}（${m.content.length} 字）=====`);
      console.log(m.content);
    }
  } : undefined });

  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`qqb 记忆精炼 v${REFINE_VERSION} · ${dryRun ? '试运行（不调模型、不写库）' : '正式提炼'}`);
    console.log(`水位文件：${refiner.watermarkPath}（今天已跑 ${refiner.runsToday()} 轮）`);
    console.log(`扫描 ${result.scanned} 条历史（${result.keys} 个会话有新增），结果：新增 ${result.inserted}，合并 ${result.merged}，丢弃 ${result.rejected}，模型调用 ${result.modelCalls} 次，耗时 ${result.ms}ms`);
    if (result.skipped) console.log(`跳过原因：${result.skipped}`);
    if (result.usage) console.log(`token：输入 ${result.usage.prompt_tokens ?? '?'}，输出 ${result.usage.completion_tokens ?? '?'}`);
    for (const item of result.factsSample ?? []) {
      if (item.action) console.log(`  - （${item.kind}）${item.text} → ${item.action}`);
      else console.log(`  - 提示词 ${item.role}：${item.chars} 字`);
    }
    if (result.errors?.length) {
      console.log('\n错误：');
      for (const e of result.errors) console.log(`  - ${e.key}: ${e.error}`);
    }
  }
}

try { store.close?.(); } catch { /* 关不掉也不影响结果 */ }