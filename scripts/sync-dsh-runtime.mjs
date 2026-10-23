#!/usr/bin/env node
// sync-dsh-runtime.mjs — 把一个**可读的 DSH 运行时 node_modules**同步成
// `~/.dsh/runtime/<version>/node_modules`，作为 profile 链接的稳定目标。
//
// 背景（本机真实环境）：
//   DSH 桌面版把运行时打在 `resources/app.asar` 里，Node 脚本读不了 asar。
//   仓库里通常有一份可读的解包副本（本机是 `_dsh_asar/dsh/node_modules`），
//   但它属于工作区：仓库一移动/清理，`~/.dsh/profiles/node_modules` 里指向它的
//   junction 又会断。而旧安装留下的 243 个 junction 正是指向已删除的旧安装目录。
//
// 做法：复制一次到用户目录，并写 manifest（版本、来源、时间）。profile 链接
// 指向这份稳定副本；DSH 升级后重跑本脚本即可（doctor 会提示副本过期）。
//
// 用法：
//   node scripts/sync-dsh-runtime.mjs                 # 预演（只打印）
//   node scripts/sync-dsh-runtime.mjs --apply         # 真正复制
//   node scripts/sync-dsh-runtime.mjs --apply --force # 覆盖已有副本
//   node scripts/sync-dsh-runtime.mjs --source=<node_modules> --apply
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshModulesCandidates, inspectDshModulesDir } from './dsh-modules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readVersion(source) {
  for (const name of ['dsh-app-boot', 'dsh', 'dsh-tools']) {
    const pkg = readJson(path.join(source, '@deepseek-ai', name, 'package.json'));
    if (typeof pkg?.version === 'string') return pkg.version;
  }
  return null;
}

function countPackages(source) {
  try {
    return fs.readdirSync(path.join(source, '@deepseek-ai'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

function runtimeRoot() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'runtime');
}

/** child 是否等于 parent 或位于其下（用于阻止源/目标重叠）。 */
function isWithin(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

/**
 * 默认源：必须是**不是稳定副本**的可读运行时。
 *
 * 注意：`dshModulesDir()` 会优先返回 `~/.dsh/runtime/<version>/node_modules`；
 * 如果拿它当源，就会把稳定副本复制到它自己身上（甚至先删掉自己）。这里
 * 明确排除稳定目录，没有可读解包副本时让调用方用 `--source` 指定。
 */
function defaultSource() {
  // 排除整个 ~/.dsh：修好断链后，profiles/node_modules 也能“解析出” DSH 包，
  // 但它只是链接农场，不是可复制的真实运行时。默认源必须是工作区里的解包副本。
  const home = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const candidates = dshModulesCandidates()
    .filter((candidate) => candidate.ok && !isWithin(home, candidate.dir));
  return candidates[0]?.dir ?? '';
}

function safeTarget(target) {
  const resolved = path.resolve(target);
  const base = path.resolve(runtimeRoot());
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`拒绝写入 ${resolved}：稳定运行时副本只能放在 ${base} 下（避免误删用户目录）`);
  }
  return resolved;
}

/**
 * 同步运行时副本。纯函数式参数，便于测试。
 *
 * @param {{source?: string, target?: string, asar?: string, apply?: boolean, force?: boolean}} options
 */
export function syncRuntime({ source, target, asar, apply = false, force = false } = {}) {
  const usedDefault = source === undefined;
  const chosen = source ?? defaultSource();
  if (!chosen) {
    throw new Error(
      '找不到“非稳定副本”的可读 DSH 运行时；请用 --source=<解包目录>/node_modules 指定，'
      + '不要直接从 ~/.dsh/runtime 再同步一次。'
    );
  }
  const src = path.resolve(chosen);
  const inspection = inspectDshModulesDir(src);
  if (!inspection.ok) throw new Error(`源目录不是 DSH 运行时：${src}（${inspection.reason}）`);
  const version = readVersion(src);
  if (!version) throw new Error(`读不到 DSH 版本：${src}`);
  if (usedDefault) {
    // 默认源必须与当前最高稳定副本同版本，否则说明工作区解包副本已经落后于 DSH：
    // 这时应该用 extract-asar-runtime.mjs 从**当前 app.asar** 重新解包，而不是复制旧副本。
    const versions = (() => {
      try {
        return fs.readdirSync(runtimeRoot(), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort()
          .reverse();
      } catch { return []; }
    })();
    if (versions.length > 0 && version !== versions[0]) {
      throw new Error(
        `默认解包副本是 ${version}，但稳定运行时最高版本是 ${versions[0]}。\n`
        + '  → 不要复制旧副本；用当前安装包重新解包：\n'
        + '     $env:ELECTRON_RUN_AS_NODE=1\n'
        + '     & "<DSH>\\DeepSeek Harness.exe" scripts\\extract-asar-runtime.mjs --asar="<DSH>\\resources\\app.asar"\n'
        + '  或用 --source 显式指定要同步的解包目录。'
      );
    }
  }
  const destRoot = safeTarget(target ?? path.join(runtimeRoot(), version));
  const destModules = path.join(destRoot, 'node_modules');
  if (isWithin(src, destModules) || isWithin(destModules, src)) {
    throw new Error(`源/目标重叠：${src} ↔ ${destModules}。稳定副本不能同步到它自己。`);
  }
  const manifestFile = path.join(destRoot, 'manifest.json');
  const existing = readJson(manifestFile);
  const same = existing?.version === version
    && path.resolve(existing?.source ?? '') === src
    && fs.existsSync(destModules)
    && !force;
  if (same) {
    return { changed: false, version, source: src, target: destRoot, reason: '已是最新（版本/来源一致）' };
  }
  const packages = countPackages(src);
  const asarPath = asar || process.env.DSH_INSTALL_ASAR || '';
  let asarMtimeMs = null;
  if (asarPath) {
    try { asarMtimeMs = fs.statSync(asarPath).mtimeMs; } catch { /* 允许只记录路径 */ }
  }
  if (!apply) {
    return {
      changed: false,
      dryRun: true,
      version,
      source: src,
      target: destRoot,
      packages,
      reason: '预演：加 --apply 才会复制',
    };
  }
  if (fs.existsSync(destRoot)) {
    if (!force) throw new Error(`目标已存在且不匹配：${destRoot}（确认后加 --force）`);
    fs.rmSync(destRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(destRoot), { recursive: true });
  const staging = `${destRoot}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  try {
    fs.cpSync(src, path.join(staging, 'node_modules'), {
      recursive: true,
      force: true,
      dereference: false,
      errorOnExist: false,
    });
    const copied = countPackages(path.join(staging, 'node_modules'));
    if (copied < packages) throw new Error(`复制不完整：${copied}/${packages} 个包`);
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify({
      version,
      source: src,
      sourceAsar: asarPath || null,
      sourceAsarMtimeMs: asarMtimeMs,
      copiedAt: new Date().toISOString(),
      packages: copied,
    }, null, 2)}\n`, 'utf8');
    fs.renameSync(staging, destRoot);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    changed: true,
    version,
    source: src,
    target: destRoot,
    packages,
    manifest: manifestFile,
    reason: `已复制并写入 manifest（${packages} 个包）`,
  };
}

function main() {
  const args = process.argv.slice(2);
  const value = (prefix) => args.find((arg) => arg.startsWith(`${prefix}=`))?.slice(prefix.length + 1);
  try {
    const result = syncRuntime({
      source: value('--source'),
      target: value('--target'),
      asar: value('--asar'),
      apply: args.includes('--apply'),
      force: args.includes('--force'),
    });
    console.log(`[runtime] ${result.dryRun ? '预演' : result.changed ? '已同步' : '跳过'}`);
    console.log(`  版本 ${result.version}`);
    console.log(`  源   ${result.source}`);
    console.log(`  目标 ${result.target}`);
    if (result.packages) console.log(`  包数 ${result.packages}`);
    console.log(`  ${result.reason}`);
    if (result.dryRun) {
      console.log('  → 确认后加 --apply；之后运行 node scripts/repair-profile-links.mjs --apply --prune');
    }
  } catch (error) {
    console.error(`[runtime] 失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { ROOT };
