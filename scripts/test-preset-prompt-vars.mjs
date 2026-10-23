// 提示词变量 `cwd` 的回归测试（纯离线，不连 DSH、不连 QQ）。
//
// 背景：2026-10-20 线上报错
//   unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
//   registered variables: provider, model, vision_router_mode_sync
// 当前安装的 DSH（dsh-agent-loop）只注册 provider / model，没有 cwd，而两个 preset 的
// persona 模板都写了 {{cwd}} —— 整个会话装配失败。修法是 preset 里加一条
// prompt-vars 行（plugins/qq-agent-presets/qq-prompt-vars.mjs），在 agent 作用域补注册 cwd。
//
// 这里钉住三件事：
//   1. 插件真的注册了 cwd，且取值顺序正确（header.cwd → session.cwd → options.cwd → ''）；
//   2. 两个 preset 的产物 patch 里都有 prompt-vars 行，且引用方式从 profile 目录可解析；
//   3. 模板里出现的每个 {{变量}} 都有来源（harness 自带的 provider/model，或 preset 自己
//      注册的变量）——这条才是能提前抓住原报错的断言。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

// 离线测试不要写生产诊断日志（doctor 会按 pid 判断“最近 apply 是否来自活进程”）。
// 必须在动态 import 插件之前设置。
process.env.QQ_PLUGIN_DIAG = '';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS = ['qq-chat', 'qq-chat-v2'];
/** harness（dsh-agent-loop）自己注册的变量；少一个都会让装配失败。 */
const HARNESS_VARIABLES = ['provider', 'model'];

const readText = (p) => fs.readFileSync(p, 'utf8');

/** 用假 ctx 跑一遍插件的 apply，收集注册到的变量名 → provider。 */
function loadRegisteredVariables(modulePath) {
  const registered = new Map();
  const ctx = {
    systemPrompt: {
      variable(name, provider) {
        assert.equal(registered.has(name), false, `重复注册变量 ${name}（同一个作用域会抛错）`);
        registered.set(name, provider);
      },
    },
  };
  return import(pathToFileURL(modulePath).href).then((mod) => {
    assert.equal(typeof mod.apply, 'function', `${path.basename(modulePath)} 应导出 apply`);
    mod.apply(ctx);
    return { mod, registered };
  });
}

test('插件把自己声明成 cordis 插件（name + inject systemPrompt）', async () => {
  const canonical = path.join(REPO_ROOT, 'plugins', 'qq-agent-presets', 'qq-prompt-vars.mjs');
  const { mod } = await loadRegisteredVariables(canonical);
  assert.equal(mod.name, 'qq-prompt-vars');
  assert.deepEqual(mod.inject, ['systemPrompt']);
});

test('注册的是 cwd，取值顺序 header.cwd → session.cwd → options.cwd → 空串', async () => {
  const canonical = path.join(REPO_ROOT, 'plugins', 'qq-agent-presets', 'qq-prompt-vars.mjs');
  const { mod, registered } = await loadRegisteredVariables(canonical);
  assert.ok(registered.has('cwd'), '应注册 cwd');
  const provider = registered.get('cwd');
  assert.equal(provider({ agent: { session: { header: { cwd: 'D:\\work' } } } }), 'D:\\work');
  assert.equal(provider({ agent: { session: { cwd: 'D:\\session' } } }), 'D:\\session');
  assert.equal(provider({ agent: { options: { cwd: 'D:\\options' } } }), 'D:\\options');
  assert.equal(provider({}), '', '完全拿不到时退回空串，而不是 undefined（undefined 也会让装配抛错）');
  assert.equal(provider(undefined), '');
  assert.equal(provider({ agent: { session: { header: { cwd: 42 } } } }), '', '非字符串一律退回空串');
  // 同源函数也导出了，方便别处复用
  assert.equal(mod.resolveCwd({ agent: { session: { header: { cwd: 'D:\\x' } } } }), 'D:\\x');
});

test('没有 systemPrompt.variable() 的老运行时：插件安静跳过而不是炸掉 preset', async () => {
  const canonical = path.join(REPO_ROOT, 'plugins', 'qq-agent-presets', 'qq-prompt-vars.mjs');
  const mod = await import(pathToFileURL(canonical).href);
  assert.doesNotThrow(() => mod.apply({ systemPrompt: {} }));
  assert.doesNotThrow(() => mod.apply({}));
  assert.doesNotThrow(() => mod.apply(undefined));
});

test('两个 preset 的产物 patch 都插入了 prompt-vars 行，引用方式可从 profile 解析', () => {
  for (const name of PRESETS) {
    const patch = yaml.load(readText(path.join(REPO_ROOT, 'plugins', 'qq-agent-presets', 'presets', `${name}.patch.yml`)));
    const rows = patch[0].insert[0].config.plugins;
    const row = rows.find((r) => r.id === 'prompt-vars');
    assert.ok(row, `${name}: 产物里应有 prompt-vars 行`);
    assert.equal(row.name, 'qq-agent-presets/qq-prompt-vars.mjs', `${name}: 必须用可从 profile 目录解析的裸说明符`);
    // 相对/绝对路径在 DSH 0.1.7 的 preset 机制下会按 profile 目录解析，装不上
    for (const r of rows) {
      assert.ok(!(typeof r.name === 'string' && (r.name.startsWith('.') || path.isAbsolute(r.name))), `${name}: 行 ${r.id} 的 name 不能是相对/绝对路径`);
    }
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'plugins', 'qq-agent-presets', 'qq-prompt-vars.mjs')), '实现文件应存在');
  }
});

test('两个 preset 目录下的 qq-prompt-vars.mjs 都是指向唯一实现的 re-export 壳', async () => {
  const canonical = path.join(REPO_ROOT, 'plugins', 'qq-agent-presets', 'qq-prompt-vars.mjs');
  for (const name of PRESETS) {
    const shim = path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'qq-prompt-vars.mjs');
    assert.match(readText(shim).trim(), /^export \* from '\.\.\/\.\.\/\.\.\/plugins\/qq-agent-presets\/qq-prompt-vars\.mjs'$/m);
  }
  // 壳与实现在同一模块实例上（导出同一份 apply）
  const canonicalMod = await import(pathToFileURL(canonical).href);
  for (const name of PRESETS) {
    const shim = path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'qq-prompt-vars.mjs');
    const shimMod = await import(pathToFileURL(shim).href);
    assert.equal(shimMod.apply, canonicalMod.apply);
  }
});

test('回归：模板里的每个 {{变量}} 都有来源（能提前抓住 unknown prompt variable）', async () => {
  const canonical = path.join(REPO_ROOT, 'plugins', 'qq-agent-presets', 'qq-prompt-vars.mjs');
  const { registered } = await loadRegisteredVariables(canonical);
  const presetVariables = new Set([...HARNESS_VARIABLES, ...registered.keys()]);

  for (const name of PRESETS) {
    const source = yaml.load(readText(path.join(REPO_ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml')));
    const persona = source.find((r) => r.id === 'persona');
    const templates = [persona?.config?.prefix ?? '', persona?.config?.suffix ?? ''];
    const used = new Set();
    for (const text of templates) {
      for (const match of String(text).matchAll(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi)) used.add(match[1]);
    }
    assert.ok(used.has('cwd'), `${name}: 模板应仍在使用 {{cwd}}（本测试的前提）`);
    for (const variable of used) {
      assert.ok(
        presetVariables.has(variable),
        `${name}: 模板变量 {{${variable}}} 没有任何来源（harness 自带：${HARNESS_VARIABLES.join(', ')}；preset 注册：${[...registered.keys()].join(', ')}）`
          + ' —— 这会在提示词装配期抛 unknown prompt variable，整个会话不可用',
      );
    }
  }
});
