// 环境体检（scripts/doctor-plugins.mjs）与契约检查的离线回归。
//
// 目的不是“把 doctor 的输出逐字固定”，而是钉住三件事：
//   1. doctor 能跑完、结构稳定、只读（不往 state/ 写东西）；
//   2. 环境变化的关键形态（断链、未知模板变量、stale patch）能被识别；
//   3. 失败/警告项都带可执行动作与指南锚点，而不是只有一句“失败”。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  analyzePresetTemplates, checkPatchFreshness, inspectParsingLayer, readProfile,
} from '../src/plugin-contract.js';
import { runDoctor } from './doctor-plugins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

test('doctor 离线模式能跑完，且不往 state/ 写任何东西', async () => {
  const stateDir = path.join(ROOT, 'state');
  const before = fs.existsSync(stateDir)
    ? new Set(fs.readdirSync(stateDir).sort())
    : null;
  const report = await runDoctor({ root: ROOT, offline: true, tools: false, snowluma: false });
  const after = fs.existsSync(stateDir)
    ? new Set(fs.readdirSync(stateDir).sort())
    : null;
  assert.deepEqual(after, before, 'doctor 必须只读：不得在 state/ 创建文件');

  assert.ok(report.env.root);
  assert.match(report.env.baseUrl, /^https?:\/\//);
  assert.equal(typeof report.summary.ok, 'number');
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 8);
  // 关键检查项必须存在（名字改了要同步测试与文档）。
  for (const id of ['node', 'repo', 'preset-patches', 'preset-variables', 'plugin-contract', 'profile-wiring', 'dsh-modules', 'bridge']) {
    assert.ok(report.checks.some((check) => check.id === id), `缺少检查项 ${id}`);
  }
  // 失败/警告项必须给动作或指南之一，不能只说“坏了”。
  for (const check of report.checks.filter((item) => item.status === 'fail' || item.status === 'warn')) {
    assert.ok(
      (check.actions?.length ?? 0) > 0 || check.doc,
      `${check.id} 失败/警告但没有 actions/doc`,
    );
  }
  // 必须可 JSON 化（--json 用）。
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});

test('未知模板变量会被识别，并指向变量来源表', () => {
  const root = tempDir('doctor-preset-');
  writeFile(path.join(root, 'dsh/agent-presets/qq-chat/agent.cordis.yml'), yaml.dump([{
    id: 'persona', name: '@deepseek-ai/dsh-persona',
    config: { prefix: 'hello {{model}}', suffix: 'cwd={{cwd}} unknown={{not_real}}' },
  }]));
  const analysis = analyzePresetTemplates({ root });
  assert.deepEqual(
    analysis.unknown.map((item) => `${item.preset}:${item.variable}`).sort(),
    ['qq-chat:not_real'],
  );
});

test('profile 的 link: 依赖断掉会被识别为 PLUGIN_LINK_BROKEN', () => {
  const dshHome = tempDir('doctor-profile-');
  const profileDir = path.join(dshHome, 'profiles', 'web');
  writeFile(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: { 'qq-agent-presets': 'link:C:/nope/qq-agent-presets' },
    dsh: { profile: { bundles: [] } },
  }, null, 2));
  const info = readProfile({ dshHome, profile: 'web' });
  assert.equal(info.exists, true);
  assert.ok(info.issues.some((issue) => issue.code === 'PLUGIN_LINK_BROKEN'));
  assert.ok(info.issues.some((issue) => issue.code === 'PLUGIN_BUNDLE_MISSING'));
});

test('共享解析层的断链会被计数（Windows 用 junction，不需要管理员）', () => {
  const dshHome = tempDir('doctor-layer-');
  const scope = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai');
  fs.mkdirSync(scope, { recursive: true });
  const missingTarget = path.join(dshHome, 'definitely-missing-target');
  const link = path.join(scope, 'cordis');
  try {
    fs.symlinkSync(missingTarget, link, 'junction');
  } catch (error) {
    // 极少数环境禁止创建 junction：显式跳过，而不是假装通过。
    console.log(`  ⏭  跳过：本环境无法创建 junction（${error.code ?? error.message}）`);
    return;
  }
  const layer = inspectParsingLayer({ dshHome });
  assert.equal(layer.exists, true);
  assert.equal(layer.broken.length, 1);
  assert.equal(layer.broken[0].name, 'cordis');
  assert.equal(layer.broken[0].target, missingTarget);
});

test('patch 比源文件旧会被识别（预检口径）', () => {
  const root = tempDir('doctor-patch-');
  const src = path.join(root, 'dsh/agent-presets/qq-chat');
  writeFile(path.join(src, 'preset.yml'), 'name: x\ndescription: y\norder: 1\n');
  writeFile(path.join(src, 'agent.cordis.yml'), '- id: persona\n  name: p\n');
  const patch = path.join(root, 'plugins/qq-agent-presets/presets/qq-chat.patch.yml');
  writeFile(patch, '# generated\n');
  // 把 patch 的 mtime 调早，模拟“改了 preset 但忘了重新生成”。
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(patch, past, past);
  // qq-chat-v2 没有源也没有 patch，会以“patch 不存在”出现在结果里；这里只钉 qq-chat。
  const stale = checkPatchFreshness({ root });
  const chat = stale.find((item) => item.preset === 'qq-chat');
  assert.ok(chat, '应报告 qq-chat patch 过期');
  assert.match(chat.reason, /源文件比 patch 新/);
});
