// 环境类 agent 错误的「翻译层」回归（纯函数，不连 DSH/QQ）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { appendEnvIncident, explainAgentError } from '../src/plugin-env-guide.js';

test('unknown prompt variable 被翻译成可行动的指南，并带出变量名', () => {
  const guide = explainAgentError(
    'unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; '
    + 'registered variables: provider, model, vision_router_mode_sync',
  );
  assert.ok(guide);
  assert.equal(guide.code, 'PROMPT_VARIABLE_MISSING');
  assert.match(guide.title, /cwd/);
  assert.ok(guide.actions.some((action) => /qq-prompt-vars/.test(action)));
  assert.ok(guide.doc.includes('PLUGIN_ENV_PLAYBOOK.md#prompt-variable'));
});

test('端口/鉴权/preset/工具面/ACL 都有对应分类', () => {
  const samples = [
    ['connect ECONNREFUSED 127.0.0.1:3080', 'DSH_UNREACHABLE'],
    ['request failed: 401 Unauthorized', 'DSH_AUTH'],
    ['No configurable plugin entry "qq-mode"', 'SETTINGS_NAMESPACE'],
    ['Cannot find package \'qq-agent-presets\'', 'PLUGIN_LINK_BROKEN'],
    ['unknown agent preset qq-chat-v2', 'PRESET_NOT_INSTALLED'],
    ['tools.restrict: tool "dsh_snapshot" is not registered', 'TOOL_DRIFT'],
    ['EPERM: operation not permitted, open state\\bridge.lock', 'STATE_ACL'],
  ];
  for (const [message, code] of samples) {
    const guide = explainAgentError(message);
    assert.ok(guide, `未命中：${message}`);
    assert.equal(guide.code, code, `${message} → ${guide.code}`);
    assert.ok(guide.actions.length > 0);
    assert.ok(guide.doc.startsWith('docs/guides/PLUGIN_ENV_PLAYBOOK.md#'));
  }
});

test('未知错误不硬套指南（避免误导排查方向）', () => {
  assert.equal(explainAgentError('model returned an empty response'), null);
  assert.equal(explainAgentError(''), null);
  assert.equal(explainAgentError(undefined), null);
});

test('环境事故记录是可追加的 JSONL，且写盘失败不抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-incidents-'));
  const file = path.join(dir, 'env-incidents.jsonl');
  appendEnvIncident(file, { key: 'group:1', code: 'PROMPT_VARIABLE_MISSING', title: 'x', message: 'm' });
  appendEnvIncident(file, { key: 'group:2', code: 'DSH_UNREACHABLE', title: 'y', message: 'n' });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].code, 'PROMPT_VARIABLE_MISSING');
  assert.ok(lines[0].t);
  assert.ok(lines[0].pid);
  // 目录不可写 / 路径非法：只读诊断不能把桥接带崩。
  assert.doesNotThrow(() => appendEnvIncident(path.join(dir, 'x\0y', 'z.jsonl'), { code: 'x' }));
  assert.doesNotThrow(() => appendEnvIncident('', { code: 'x' }));
});

test('事故日志超过 512KB 会轮转（Windows 上 rename 不能覆盖已有 .1）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-incidents-rotate-'));
  const file = path.join(dir, 'env-incidents.jsonl');
  fs.writeFileSync(file, `${'x'.repeat(512 * 1024 + 1)}\n`, 'utf8');
  // 第二次写入前看到超限 → 先轮转再追加。
  appendEnvIncident(file, { code: 'ROTATED' });
  assert.equal(fs.existsSync(`${file}.1`), true);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).code, 'ROTATED');
});
