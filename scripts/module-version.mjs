// 模块版本快照与回滚（R7）。
//
//   node scripts/module-version.mjs list                    # 列出各模块版本与已有快照
//   node scripts/module-version.mjs verify                  # 核对 registry ↔ 文件里的 VERSION
//   node scripts/module-version.mjs snapshot core/log       # 存一份 _backups/versions/core__log/<版本>/
//   node scripts/module-version.mjs snapshot all
//   node scripts/module-version.mjs rollback core/log 0.1.0 # 先 node --check 再覆盖，覆盖前另存当前版本
//
// 快照落在工作区 `_backups/versions/<模块转义名>/<版本>/`（`/` 转成 `__`），
// 每个快照带 SNAPSHOT.json（文件清单 + sha256），回滚前会校验哈希并在抄回去之前把当前文件另存。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { MODULES, QQB_VERSION, getModule, moduleNames, semverOk } from '../src/qqb/version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const workspace = path.resolve(root, '..');
const versionsRoot = path.join(workspace, '_backups', 'versions');

const checkedExtensions = new Set(['.js', '.mjs', '.cjs']);

function dirNameOf(module) {
  return String(module).replace(/[\\/]/g, '__');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0);
  }
  return 0;
}

function availableVersions(module) {
  const base = path.join(versionsRoot, dirNameOf(module));
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && semverOk(entry.name))
    .map((entry) => entry.name)
    .sort(compareVersions);
}

function syntaxCheck(file) {
  if (!checkedExtensions.has(path.extname(file))) return { ok: true };
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

function copyFiles(module, version, { fromDir, toRoot, label }) {
  const spec = getModule(module);
  if (!spec) throw new Error(`未登记的模块：${module}`);
  const written = [];
  for (const relative of spec.files) {
    const source = path.join(fromDir, relative);
    if (!fs.existsSync(source)) throw new Error(`${label} 缺文件：${source}`);
    const check = syntaxCheck(source);
    if (!check.ok) throw new Error(`${label} 语法检查失败：${source}\n${check.output}`);
    const target = path.join(toRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    written.push(relative);
  }
  return { version, written };
}

function snapshotOne(module, version, { force = false } = {}) {
  const spec = getModule(module);
  if (!spec) throw new Error(`未登记的模块：${module}`);
  const wanted = version ?? spec.version;
  if (!semverOk(wanted)) throw new Error(`版本号必须是 x.y.z：${wanted}`);
  const dest = path.join(versionsRoot, dirNameOf(module), wanted);
  if (fs.existsSync(dest) && !force) {
    return { module, version: wanted, dest, skipped: '已存在（--force 可覆盖）' };
  }
  const manifest = { module, version: wanted, qqbVersion: QQB_VERSION, ts: new Date().toISOString(), files: [] };
  for (const relative of spec.files) {
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) throw new Error(`缺文件，无法快照：${source}`);
    const buffer = fs.readFileSync(source);
    const target = path.join(dest, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    manifest.files.push({ path: relative, sha256: sha256(buffer), bytes: buffer.length });
  }
  fs.writeFileSync(path.join(dest, 'SNAPSHOT.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { module, version: wanted, dest, files: manifest.files.length };
}

function rollbackOne(module, version, { dryRun = false } = {}) {
  const spec = getModule(module);
  if (!spec) throw new Error(`未登记的模块：${module}`);
  const available = availableVersions(module);
  if (!available.length) throw new Error(`模块 ${module} 没有任何快照（先 snapshot）`);
  const wanted = version ?? available[available.length - 1];
  if (!available.includes(wanted)) {
    throw new Error(`模块 ${module} 没有版本 ${wanted} 的快照；已有：${available.join(', ')}`);
  }
  const fromDir = path.join(versionsRoot, dirNameOf(module), wanted);
  const manifestFile = path.join(fromDir, 'SNAPSHOT.json');
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    for (const item of manifest.files ?? []) {
      const file = path.join(fromDir, item.path);
      const actual = sha256(fs.readFileSync(file));
      if (actual !== item.sha256) throw new Error(`快照文件哈希不符（已损坏）：${file}`);
    }
  }
  if (dryRun) return { module, version: wanted, dryRun: true, files: spec.files };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(versionsRoot, dirNameOf(module), `${spec.version}-pre-rollback-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const relative of spec.files) {
    const current = path.join(root, relative);
    if (fs.existsSync(current)) {
      const target = path.join(backupDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(current, target);
    }
  }
  const result = copyFiles(module, wanted, { fromDir, toRoot: root, label: `回滚 ${module}@${wanted}` });
  return { module, version: wanted, files: result.written, preRollbackBackup: backupDir };
}

function verifyRegistry() {
  const problems = [];
  for (const name of moduleNames()) {
    const spec = MODULES[name];
    if (!semverOk(spec.version)) problems.push(`${name}: registry 版本号非法（${spec.version}）`);
    for (const relative of spec.files) {
      const file = path.join(root, relative);
      if (!fs.existsSync(file)) { problems.push(`${name}: 缺文件 ${relative}`); continue; }
      if (!checkedExtensions.has(path.extname(file))) continue;
      const text = fs.readFileSync(file, 'utf8');
      const match = text.match(/export const VERSION = '([^']+)'/);
      if (!match) { problems.push(`${name}: ${relative} 没有导出 VERSION`); continue; }
      if (match[1] !== spec.version) {
        problems.push(`${name}: 文件里的 VERSION=${match[1]} 与 registry=${spec.version} 不一致`);
      }
    }
  }
  return problems;
}

// 参数解析：`snapshot core/log --force` 里的 --force 不能被当成版本号。
const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((item) => item.startsWith('--')));
const positionals = rawArgs.filter((item) => !item.startsWith('--'));
const [command = 'list', moduleArg, versionArg] = positionals;
const force = flags.has('--force');
const dryRun = flags.has('--dry-run');

try {
  if (command === 'list') {
    process.stdout.write(`qqb ${QQB_VERSION}\n`);
    for (const name of moduleNames()) {
      const snapshots = availableVersions(name);
      process.stdout.write(`  ${name.padEnd(18)} ${MODULES[name].version}  ${snapshots.length ? `快照：${snapshots.join(', ')}` : '（无快照）'}\n`);
    }
    process.stdout.write(`快照根目录：${versionsRoot}\n`);
  } else if (command === 'verify') {
    const problems = verifyRegistry();
    if (problems.length) {
      process.stdout.write(`⛔ 版本登记表与代码不一致：\n${problems.map((line) => `  - ${line}`).join('\n')}\n`);
      process.exit(1);
    }
    process.stdout.write(`✅ 版本登记表与代码一致（${moduleNames().length} 个模块，qqb ${QQB_VERSION}）\n`);
  } else if (command === 'snapshot') {
    const targets = !moduleArg || moduleArg === 'all' ? moduleNames() : [moduleArg];
    for (const name of targets) {
      const result = snapshotOne(name, versionArg, { force });
      process.stdout.write(result.skipped
        ? `↷ ${result.module}@${result.version} 跳过：${result.skipped}\n`
        : `📦 ${result.module}@${result.version} → ${result.dest}（${result.files} 个文件）\n`);
    }
  } else if (command === 'rollback') {
    if (!moduleArg) throw new Error('用法：rollback <module> [version] [--dry-run]');
    const result = rollbackOne(moduleArg, versionArg, { dryRun });
    process.stdout.write(dryRun
      ? `（dry-run）将把 ${result.module} 回滚到 ${result.version}，涉及：${result.files.join(', ')}\n`
      : `↩️ ${result.module} 已回滚到 ${result.version}（${result.files.join(', ')}）\n   当前版本另存于：${result.preRollbackBackup}\n`);
  } else {
    throw new Error(`未知命令：${command}（可用：list / verify / snapshot / rollback）`);
  }
} catch (error) {
  process.stderr.write(`⛔ ${error?.message ?? error}\n`);
  process.exit(1);
}