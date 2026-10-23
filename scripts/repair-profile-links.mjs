#!/usr/bin/env node
// repair-profile-links.mjs — 修复 `~/.dsh/profiles/node_modules/@deepseek-ai` 里
// 指向已删除目标的 junction。
//
// 典型来源：DSH 换安装位置后，profile 解析层仍指向旧安装目录（本机真实案例：
// 243 个链接全部指向已被搬走的旧安装目录，那个目录已经空了）。
//
// 原则：
//   · 默认只预演，不写盘；`--apply` 才动；
//   · 只处理**断链**，健康链接/真实目录一律不碰；
//   · 目标包在稳定运行时副本里存在 → 重指向；不存在（旧版本已删除的包名）→
//     只有显式 `--prune` 才删除，否则只报告；
//   · 动手前把旧目标写进 `state/profile-link-backup-<时间戳>.json`，可人工回滚。
//
// 用法：
//   node scripts/repair-profile-links.mjs                  # 预演
//   node scripts/repair-profile-links.mjs --apply --prune  # 修复 + 清理已删除包名的断链
//   node scripts/repair-profile-links.mjs --source=<node_modules> --apply
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHome, dshModulesDir, inspectDshModulesDir } from './dsh-modules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = '@deepseek-ai';

/** 读一个链接的目标；不是链接则返回 null。 */
function linkTarget(link) {
  try {
    return fs.readlinkSync(link);
  } catch {
    return null;
  }
}

function isHealthyTarget(target) {
  if (!target) return false;
  // Windows junction 有时带 \\?\ 前缀；existsSync 能处理两种写法。
  return fs.existsSync(target);
}

function removeLink(link) {
  // Windows junction：unlink 可能 EPERM，rmdir 只删链接不删目标。
  try {
    fs.unlinkSync(link);
    return;
  } catch { /* 继续尝试 rmdir */ }
  fs.rmdirSync(link);
}

/** 选择默认运行时源：优先 ~/.dsh/runtime/<version>/node_modules，其次可读解包副本。 */
export function defaultRuntimeSource() {
  const runtimeRoot = path.join(dshHome(), 'runtime');
  try {
    const versions = fs.readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const version of versions) {
      const candidate = path.join(runtimeRoot, version, 'node_modules');
      if (inspectDshModulesDir(candidate).ok) return candidate;
    }
  } catch { /* 没有稳定副本 */ }
  return dshModulesDir();
}

/**
 * 生成修复计划（只读）。
 *
 * @param {{scopeDir?: string, source?: string}} [options]
 */
export function planLinkRepairs({ scopeDir, source, repointOutdated = false } = {}) {
  const scope = scopeDir ?? path.join(dshHome(), 'profiles', 'node_modules', SCOPE);
  const src = path.resolve(source ?? defaultRuntimeSource());
  const inspection = inspectDshModulesDir(src);
  if (!inspection.ok) throw new Error(`运行时源无效：${src}（${inspection.reason}）`);
  const sourceScope = path.join(src, SCOPE);
  const normalizedSourceScope = `${path.resolve(sourceScope).toLowerCase()}${path.sep}`;
  const plan = {
    scopeDir: scope,
    source: src,
    exists: fs.existsSync(scope),
    healthy: 0,
    repairable: [],
    outdated: [],
    obsolete: [],
    invalid: [],
  };
  if (!plan.exists) return plan;

  /** 这个健康链接是否指向“旧运行时副本/工作区解包副本”，而不是当前稳定副本。 */
  const isOutdatedRuntimeTarget = (target) => {
    const normalized = path.resolve(target).toLowerCase();
    if (normalized.startsWith(normalizedSourceScope)) return false;
    // 只重指向明确的运行时副本，不对用户自定义目录做“猜测式”修改。
    return /[\\/]runtime[\\/][^\\/]+[\\/]node_modules[\\/]@deepseek-ai[\\/]/i.test(normalized)
      || /_dsh_asar/i.test(normalized);
  };

  let entries = [];
  try {
    entries = fs.readdirSync(scope, { withFileTypes: true });
  } catch {
    return plan;
  }
  for (const entry of entries) {
    const link = path.join(scope, entry.name);
    const target = linkTarget(link);
    if (!target) { plan.healthy += 1; continue; } // 真实目录
    const replacement = path.join(sourceScope, entry.name);
    const canRepoint = fs.existsSync(path.join(replacement, 'package.json'));
    if (isHealthyTarget(target)) {
      if (repointOutdated && isOutdatedRuntimeTarget(target)) {
        if (canRepoint) plan.outdated.push({ name: entry.name, from: target, to: replacement });
        else plan.obsolete.push({ name: entry.name, from: target, reason: '当前运行时不再包含该包' });
      } else {
        plan.healthy += 1;
      }
      continue;
    }
    if (canRepoint) {
      plan.repairable.push({ name: entry.name, from: target, to: replacement });
    } else {
      plan.obsolete.push({ name: entry.name, from: target, reason: '目标不存在且当前运行时也没有该包' });
    }
    if (!path.isAbsolute(target) && !path.isAbsolute(link)) plan.invalid.push({ name: entry.name, target });
  }
  return plan;
}

/**
 * 执行修复计划。会先写备份；单个链接失败不阻断其它链接，失败项在返回里列出。
 *
 * @param {{scopeDir: string, repairable: {name: string, from: string, to: string}[], obsolete: {name: string, from: string}[], healthy: number}} plan
 * @param {{prune?: boolean, backupFile?: string, apply?: boolean}} [options]
 */
export function applyLinkRepairs(plan, { prune = false, backupFile, apply = true } = {}) {
  const result = { repaired: [], repointed: [], pruned: [], failed: [], backupFile: null, dryRun: !apply };
  const scope = plan.scopeDir;
  if (!scope || !fs.existsSync(scope)) return result;
  if (!apply) return result;

  const backup = {
    generatedAt: new Date().toISOString(),
    scopeDir: scope,
    source: plan.source,
    repairable: plan.repairable,
    outdated: plan.outdated ?? [],
    obsolete: prune ? plan.obsolete : [],
    healthy: plan.healthy,
  };
  const file = backupFile ?? path.join(ROOT, 'state', `profile-link-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(backup, null, 2)}\n`, 'utf8');
  result.backupFile = file;

  const repairOne = (item, bucket) => {
    const link = path.join(scope, item.name);
    try {
      removeLink(link);
      fs.symlinkSync(item.to, link, 'junction');
      if (!fs.existsSync(path.join(item.to, 'package.json'))) throw new Error('目标 package.json 不存在');
      if (!fs.existsSync(link)) throw new Error('新链接不可解析');
      bucket.push(item);
    } catch (error) {
      result.failed.push({ ...item, error: error?.message ?? String(error) });
    }
  };
  for (const item of plan.outdated ?? []) repairOne(item, result.repointed);
  for (const item of plan.repairable) repairOne(item, result.repaired);
  if (prune) {
    for (const item of plan.obsolete) {
      const link = path.join(scope, item.name);
      try {
        removeLink(link);
        result.pruned.push(item);
      } catch (error) {
        result.failed.push({ ...item, error: error?.message ?? String(error) });
      }
    }
  }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const value = (prefix) => args.find((arg) => arg.startsWith(`${prefix}=`))?.slice(prefix.length + 1);
  const apply = args.includes('--apply');
  const prune = args.includes('--prune');
  const repointOutdated = args.includes('--repoint-outdated');
  try {
    const plan = planLinkRepairs({ source: value('--source'), repointOutdated });
    console.log(`[links] 解析层 ${plan.scopeDir}`);
    console.log(`[links] 运行时源 ${plan.source}`);
    if (!plan.exists) {
      console.log('[links] 解析层不存在，无需修复');
      return;
    }
    console.log(`[links] 健康 ${plan.healthy}；可重指向（断链）${plan.repairable.length}；旧运行时 ${plan.outdated.length}；已删除包名 ${plan.obsolete.length}`);
    for (const item of plan.repairable.slice(0, 8)) console.log(`  可修复 ${item.name} → ${item.to}`);
    if (plan.repairable.length > 8) console.log(`  …还有 ${plan.repairable.length - 8} 个可修复`);
    for (const item of plan.outdated.slice(0, 8)) console.log(`  旧运行时 ${item.name} → ${item.to}`);
    if (plan.outdated.length > 8) console.log(`  …还有 ${plan.outdated.length - 8} 个旧运行时链接`);
    for (const item of plan.obsolete.slice(0, 8)) console.log(`  旧包名 ${item.name}（当前运行时不存在${prune && apply ? '，将删除断链' : '；加 --prune 才删除'}）`);
    if (plan.obsolete.length > 8) console.log(`  …还有 ${plan.obsolete.length - 8} 个旧包名`);

    if (!apply) {
      console.log(`[links] 预演结束。确认后运行：node scripts/repair-profile-links.mjs --apply --prune${plan.outdated.length ? ' --repoint-outdated' : ''}`);
      return;
    }
    const result = applyLinkRepairs(plan, { prune });
    console.log(`[links] 已修复断链 ${result.repaired.length}；重指向旧运行时 ${result.repointed.length}；已清理 ${result.pruned.length}；失败 ${result.failed.length}`);
    if (result.backupFile) console.log(`[links] 旧目标备份：${result.backupFile}`);
    for (const failure of result.failed) console.error(`  ✖ ${failure.name}: ${failure.error}`);
    if (result.failed.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`[links] 失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
