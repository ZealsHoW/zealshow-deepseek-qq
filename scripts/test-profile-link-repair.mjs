// profile 解析层断链修复（scripts/repair-profile-links.mjs）的离线回归。
//
// 环境变化里最隐蔽的一类：链接还在、目标没了。它不会立刻让 DSH 报错，
// 但会让“从 profile 解析 DSH 包”的脚本静默失败。这里钉住：
//   1. 只规划**断链**，健康链接/真实目录不碰；
//   2. 源里有对应包 → 重指向；源里没有（旧版本删掉的包名）→ 只有 --prune 才删；
//   3. 动手前写备份；apply 后新链接真的能解析。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyLinkRepairs, planLinkRepairs } from './repair-profile-links.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePackage(root, name, version = '1.0.0') {
  const dir = path.join(root, '@deepseek-ai', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version }), 'utf8');
  return dir;
}

function makeJunction(target, link) {
  fs.symlinkSync(target, link, 'junction');
}

test('断链修复：只动断链，能重指向的重指向，旧包名按 --prune 清理，并写备份', () => {
  const root = tempDir('link-repair-');
  const source = path.join(root, 'runtime', 'node_modules');
  writePackage(source, 'dsh-app-boot');
  writePackage(source, 'dsh-tool-pwsh');
  const scope = path.join(root, 'profiles', 'node_modules', '@deepseek-ai');
  fs.mkdirSync(scope, { recursive: true });

  const missing = path.join(root, 'deleted-install', 'node_modules', '@deepseek-ai');
  try {
    makeJunction(path.join(missing, 'dsh-tool-pwsh'), path.join(scope, 'dsh-tool-pwsh'));
    makeJunction(path.join(missing, 'gone-package'), path.join(scope, 'gone-package'));
    makeJunction(path.join(source, '@deepseek-ai', 'dsh-app-boot'), path.join(scope, 'dsh-app-boot'));
  } catch (error) {
    console.log(`  ⏭  跳过：本环境无法创建 junction（${error.code ?? error.message}）`);
    return;
  }

  const plan = planLinkRepairs({ scopeDir: scope, source });
  assert.equal(plan.repairable.length, 1);
  assert.equal(plan.repairable[0].name, 'dsh-tool-pwsh');
  assert.equal(plan.obsolete.length, 1);
  assert.equal(plan.obsolete[0].name, 'gone-package');
  assert.equal(plan.healthy, 1);

  // 断链的 existsSync 为 false（它跟随目标）；判断“链接本身在不在”要用 lstat。
  const linkExists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

  // 预演不写盘。
  const dry = applyLinkRepairs(plan, { prune: true, apply: false });
  assert.equal(dry.repaired.length, 0);
  assert.equal(linkExists(path.join(scope, 'gone-package')), true);

  const backupFile = path.join(root, 'backup.json');
  const result = applyLinkRepairs(plan, { prune: true, backupFile, apply: true });
  assert.equal(result.failed.length, 0);
  assert.equal(result.repaired.length, 1);
  assert.equal(result.pruned.length, 1);
  assert.equal(linkExists(path.join(scope, 'gone-package')), false);
  assert.equal(linkExists(path.join(scope, 'dsh-tool-pwsh')), true);
  assert.equal(fs.existsSync(path.join(scope, 'dsh-tool-pwsh', 'package.json')), true);
  assert.equal(fs.existsSync(path.join(scope, 'dsh-app-boot', 'package.json')), true);

  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  assert.equal(backup.repairable[0].name, 'dsh-tool-pwsh');
  assert.match(backup.repairable[0].from, /deleted-install/);
  assert.equal(backup.obsolete[0].name, 'gone-package');
});

test('可把“指向旧运行时副本”的健康链接重指向当前稳定副本（--repoint-outdated）', () => {
  const root = tempDir('link-repoint-');
  const oldSource = path.join(root, 'runtime', '0.2.0-rc.2', 'node_modules');
  const newSource = path.join(root, 'runtime', '0.2.1-rc.2', 'node_modules');
  writePackage(oldSource, 'dsh-app-boot');
  writePackage(oldSource, 'dsh-tool-pwsh');
  writePackage(newSource, 'dsh-app-boot');
  writePackage(newSource, 'dsh-tool-pwsh');
  const scope = path.join(root, 'profiles', 'node_modules', '@deepseek-ai');
  fs.mkdirSync(scope, { recursive: true });
  const link = path.join(scope, 'dsh-tool-pwsh');
  try {
    makeJunction(path.join(oldSource, '@deepseek-ai', 'dsh-tool-pwsh'), link);
  } catch (error) {
    console.log(`  ⏭  跳过：本环境无法创建 junction（${error.code ?? error.message}）`);
    return;
  }

  const healthy = planLinkRepairs({ scopeDir: scope, source: newSource });
  assert.equal(healthy.healthy, 1);
  assert.equal(healthy.outdated.length, 0);

  const plan = planLinkRepairs({ scopeDir: scope, source: newSource, repointOutdated: true });
  assert.equal(plan.outdated.length, 1);
  assert.match(plan.outdated[0].from, /0\.2\.0-rc\.2/);
  const backupFile = path.join(root, 'backup-outdated.json');
  const result = applyLinkRepairs(plan, { backupFile, apply: true });
  assert.equal(result.failed.length, 0);
  assert.equal(result.repointed.length, 1);
  assert.equal(fs.existsSync(path.join(link, 'package.json')), true);
  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
  assert.equal(backup.outdated[0].name, 'dsh-tool-pwsh');
});
