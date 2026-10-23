// 桥接启动预检（src/plugin-contract.js 的 runPluginPreflight）的离线回归。
//
// 预检的职责是“在 QQ 消息失败之前，用一行日志指出环境已经变了”：
//   · 模板变量没有来源 → 提示词装配会整体失败；
//   · patch 比源旧       → DSH 还在跑旧 preset；
//   · profile 没装/断链   → 插件根本没进 DSH。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runPluginPreflight } from '../src/plugin-contract.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function makeRepo(root, suffix) {
  write(path.join(root, 'dsh/agent-presets/qq-chat/preset.yml'), 'name: x\ndescription: y\norder: 1\n');
  write(path.join(root, 'dsh/agent-presets/qq-chat/agent.cordis.yml'), [
    '- id: persona',
    '  name: "@deepseek-ai/dsh-persona"',
    '  config:',
    `    suffix: ${suffix}`,
    '',
  ].join('\n'));
}

test('模板里有未知变量时，预检报 PROMPT_VARIABLE_UNKNOWN（而不是等会话炸）', () => {
  const root = tempDir('preflight-var-');
  makeRepo(root, 'cwd={{cwd}} unknown={{not_real}}');
  const dshHome = tempDir('preflight-home-');
  const issues = runPluginPreflight({ repoRoot: root, dshHome });
  const issue = issues.find((item) => item.code === 'PROMPT_VARIABLE_UNKNOWN');
  assert.ok(issue, JSON.stringify(issues));
  assert.equal(issue.variable, 'not_real');
  assert.match(issue.message, /not_real/);
  assert.ok(issue.action.includes('PLUGIN_ENV_PLAYBOOK.md#prompt-variable'));
});

test('模板只有已知变量时，不产生变量告警', () => {
  const root = tempDir('preflight-var-ok-');
  makeRepo(root, 'cwd={{cwd}} model={{model}}');
  const dshHome = tempDir('preflight-home-');
  const issues = runPluginPreflight({ repoRoot: root, dshHome });
  assert.equal(issues.some((item) => item.code === 'PROMPT_VARIABLE_UNKNOWN'), false);
});

test('源文件比 patch 新时，预检报 PATCH_STALE', () => {
  const root = tempDir('preflight-patch-');
  makeRepo(root, 'cwd={{cwd}}');
  const patch = path.join(root, 'plugins/qq-agent-presets/presets/qq-chat.patch.yml');
  write(patch, '# generated\n');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(patch, past, past);
  const dshHome = tempDir('preflight-home-');
  const issues = runPluginPreflight({ repoRoot: root, dshHome });
  assert.ok(issues.some((item) => item.code === 'PATCH_STALE' && item.preset === 'qq-chat'));
});

test('没有任何 profile 装插件时，预检报 PROFILE_WIRING_MISSING', () => {
  const root = tempDir('preflight-wiring-');
  makeRepo(root, 'cwd={{cwd}}');
  const dshHome = tempDir('preflight-home-');
  fs.mkdirSync(path.join(dshHome, 'profiles'), { recursive: true });
  const issues = runPluginPreflight({ repoRoot: root, dshHome, profile: 'web' });
  assert.ok(issues.some((item) => item.code === 'PROFILE_WIRING_MISSING'));
});

test('预检是只读的：临时目录里不应多出文件', () => {
  const root = tempDir('preflight-readonly-');
  makeRepo(root, 'cwd={{cwd}}');
  const dshHome = tempDir('preflight-home-');
  const before = fs.readdirSync(root).sort();
  runPluginPreflight({ repoRoot: root, dshHome });
  assert.deepEqual(fs.readdirSync(root).sort(), before);
});
