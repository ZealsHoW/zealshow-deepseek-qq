#!/usr/bin/env node
// extract-asar-runtime.mjs — 把当前 DSH 安装包里的 `dsh/node_modules` 解包成
// `~/.dsh/runtime/<version>/node_modules` 稳定副本。
//
// 为什么必须用 Electron 跑：
//   `resources/app.asar` 是 Electron 的归档格式，普通 Node 的 fs 读不了目录；
//   只有 Electron-as-node（ELECTRON_RUN_AS_NODE=1）的 fs 才带 asar 支持。
//
// 用法（PowerShell）：
//   $env:ELECTRON_RUN_AS_NODE='1'
//   & '<DSH 安装目录>\DeepSeek Harness.exe' scripts\extract-asar-runtime.mjs `
//       --asar='<DSH 安装目录>\resources\app.asar'
//
//   # 可选：--target=<目录>  --force
//
// 退出码：0 成功/已是最新；1 失败；2 用法错误。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDshModulesDir } from './dsh-modules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function argValue(args, prefix) {
  return args.find((arg) => arg.startsWith(`${prefix}=`))?.slice(prefix.length + 1);
}

function copyTree(src, dst, stats) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, stats);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      stats.files += 1;
      stats.bytes += fs.statSync(to).size;
      if (stats.files % 10000 === 0) console.log(`[extract] ${stats.files} files…`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const asar = argValue(args, '--asar') || process.env.DSH_INSTALL_ASAR;
  if (!asar) {
    console.error('[extract] 缺少 --asar=<DSH 安装目录>/resources/app.asar');
    process.exitCode = 2;
    return;
  }
  const asarPath = path.resolve(asar);
  const runtimePkg = readJson(path.join(asarPath, 'dsh', 'package.json'));
  if (!runtimePkg?.version) {
    console.error(`[extract] 读不到 ${asarPath}/dsh/package.json（普通 Node 读不了 asar？必须用 Electron 运行本脚本）`);
    process.exitCode = 1;
    return;
  }
  const version = runtimePkg.version;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const runtimeRoot = path.join(home, 'runtime');
  const target = path.resolve(argValue(args, '--target') || path.join(runtimeRoot, version));
  if (target !== path.resolve(runtimeRoot) && !target.startsWith(`${path.resolve(runtimeRoot)}${path.sep}`)) {
    console.error(`[extract] 拒绝写入 ${target}：目标必须在 ${runtimeRoot} 下（或用 --target 显式指定到安全位置）`);
    process.exitCode = 2;
    return;
  }
  const force = args.includes('--force');
  const sourceModules = path.join(asarPath, 'dsh', 'node_modules');
  try {
    if (!inspectDshModulesDir(sourceModules).ok) throw new Error('asar 里没有 @deepseek-ai/dsh-*');
  } catch (error) {
    console.error(`[extract] 源不可读：${error?.message ?? error}`);
    console.error('  → 确认用 Electron 运行：$env:ELECTRON_RUN_AS_NODE=1; & "<DSH>\\DeepSeek Harness.exe" scripts\\extract-asar-runtime.mjs ...');
    process.exitCode = 1;
    return;
  }
  if (fs.existsSync(target) && !force) {
    const manifest = readJson(path.join(target, 'manifest.json'));
    console.log(`[extract] 已存在：${target}（${manifest?.version ?? '无 manifest'}）；加 --force 才覆盖`);
    return;
  }
  const staging = `${target}.tmp-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const stats = { files: 0, bytes: 0 };
  const started = Date.now();
  try {
    copyTree(sourceModules, path.join(staging, 'node_modules'), stats);
    const packages = fs.readdirSync(path.join(staging, 'node_modules', '@deepseek-ai'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length;
    const asarStat = fs.statSync(asarPath);
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify({
      version,
      sourceAsar: asarPath,
      sourceAsarMtimeMs: asarStat.mtimeMs,
      copiedAt: new Date().toISOString(),
      packages,
      files: stats.files,
    }, null, 2)}\n`, 'utf8');
    if (fs.existsSync(target)) {
      const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(target, backup);
      console.log(`[extract] 旧副本已改名：${backup}`);
    }
    fs.renameSync(staging, target);
    console.log(`[extract] 完成：${target}`);
    console.log(`  版本 ${version}；包 ${packages}；文件 ${stats.files}；${(stats.bytes / 1024 / 1024).toFixed(1)} MB；${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log('  → 接着运行：node scripts/repair-profile-links.mjs --apply --prune');
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    console.error(`[extract] 失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { copyTree, ROOT };
