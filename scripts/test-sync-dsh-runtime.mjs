// 稳定运行时副本同步（scripts/sync-dsh-runtime.mjs）的离线回归。
//
// 目的：profile 链接不能长期指向工作区里的解包副本（仓库一搬就断）。同步脚本
// 必须能做到：预演不写盘、apply 后复制完整、写 manifest、重复运行幂等。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { syncRuntime } from './sync-dsh-runtime.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

test('预演不复制；apply 复制 node_modules 并写 manifest；重复运行幂等', () => {
  const root = tempDir('sync-runtime-');
  const source = path.join(root, 'source', 'node_modules');
  write(path.join(source, '@deepseek-ai', 'dsh-app-boot', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-app-boot', version: '9.9.9-test',
  }));
  write(path.join(source, '@deepseek-ai', 'dsh-tool-pwsh', 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-tool-pwsh', version: '9.9.9-test',
  }));
  write(path.join(source, 'zod', 'package.json'), JSON.stringify({ name: 'zod', version: '0.0.0' }));

  const home = tempDir('sync-home-');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const dry = syncRuntime({ source, apply: false });
    assert.equal(dry.dryRun, true);
    assert.equal(fs.existsSync(dry.target), false);

    const first = syncRuntime({ source, apply: true });
    assert.equal(first.changed, true);
    assert.equal(first.version, '9.9.9-test');
    assert.equal(fs.existsSync(path.join(first.target, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json')), true);
    // 运行时的普通依赖也要在，否则 @deepseek-ai 包自身的 import 解析不到。
    assert.equal(fs.existsSync(path.join(first.target, 'node_modules', 'zod', 'package.json')), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(first.target, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, '9.9.9-test');
    assert.equal(manifest.source, path.resolve(source));
    assert.equal(manifest.packages, 2);

    const second = syncRuntime({ source, apply: true });
    assert.equal(second.changed, false);
    assert.match(second.reason, /已是最新/);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('拒绝把稳定副本写到 ~/.dsh/runtime 之外', () => {
  const root = tempDir('sync-unsafe-');
  const source = path.join(root, 'source');
  write(path.join(source, '@deepseek-ai', 'dsh-app-boot', 'package.json'), JSON.stringify({ version: '1.0.0' }));
  assert.throws(
    () => syncRuntime({ source, target: root, apply: true }),
    /拒绝写入/,
  );
});

test('拒绝把稳定副本自己当源（防先删后复制）', () => {
  const home = tempDir('sync-self-');
  const target = path.join(home, 'runtime', '9.9.9-test');
  const source = path.join(target, 'node_modules');
  write(path.join(source, '@deepseek-ai', 'dsh-app-boot', 'package.json'), JSON.stringify({ version: '9.9.9-test' }));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    assert.throws(
      () => syncRuntime({ source, target, apply: true, force: true }),
      /源\/目标重叠/,
    );
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});
