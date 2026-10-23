// qq-agent-presets 的几个插件共用 qq-plugin-runtime.mjs 的 capabilities() 做能力探测。
// 它必须对「没 inject 的服务」安全：cordis 的 ctx 是代理对象，读未声明的服务会**抛错**
// 而不是返回 undefined。
//
// 2026-10-21 线上事故（就是本测试要钉住的）：capabilities() 里直接写
// `const systemPrompt = ctx?.systemPrompt`，于是
//   - qq-prompt-vars（只 inject systemPrompt）读 ctx.tools 时抛
//     `cannot get property "tools" without inject`；
//   - qq-tool-restrict（只 inject tools）读 ctx.systemPrompt 时抛对称的错误。
// apply() 抛错 → 整个 preset 变成 `agent-preset/invalid` → QQ 会话一轮都建不起来
// （桥接侧只看到「agent 处理出错」，插件诊断文件里连 apply 事件都不会有）。
//
// 这里用一个「照抄 cordis 行为」的代理来复现：未注入 = 抛错，而不是 undefined。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capabilities } from '../plugins/qq-agent-presets/qq-plugin-runtime.mjs';

/** 与 cordis 一致的错误文案（DSH 侧看到的就是这句）。 */
const withoutInject = (name) => new Error(`cannot get property "${name}" without inject`);

/**
 * 造一个 cordis 风格的 ctx：只有写进 inject 的服务可读，其余一律抛错。
 * @param {string[]} injected
 */
function ctxWith(injected) {
  const services = {
    systemPrompt: { variable: () => {} },
    tools: { restrict: () => {}, guard: () => {} },
    settings: { register: () => {} },
  };
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== 'string' || !(property in services)) return undefined;
      if (!injected.includes(property)) throw withoutInject(property);
      return services[property];
    },
  });
}

test('只注入 systemPrompt 时，探测 tools 不会抛（qq-prompt-vars 的 inject 集合）', () => {
  const caps = capabilities(ctxWith(['systemPrompt']));
  assert.equal(caps.systemPrompt, true);
  assert.equal(caps.systemPromptVariable, true);
  assert.equal(caps.tools, false, '未注入的服务应报告为 false，而不是抛错');
  assert.equal(caps.toolsRestrict, false);
  assert.equal(caps.toolsGuard, false);
});

test('只注入 tools 时，探测 systemPrompt 不会抛（qq-tool-restrict 的 inject 集合）', () => {
  const caps = capabilities(ctxWith(['tools']));
  assert.equal(caps.tools, true);
  assert.equal(caps.toolsRestrict, true);
  assert.equal(caps.toolsGuard, true);
  assert.equal(caps.systemPrompt, false);
  assert.equal(caps.systemPromptVariable, false);
});

test('什么都不注入时全部报告 false，且不抛', () => {
  const caps = capabilities(ctxWith([]));
  assert.deepEqual(caps, {
    systemPrompt: false,
    systemPromptVariable: false,
    tools: false,
    toolsRestrict: false,
    toolsGuard: false,
    settings: false,
    settingsRegister: false,
  });
});

test('三个服务都注入时全部为 true', () => {
  const caps = capabilities(ctxWith(['systemPrompt', 'tools', 'settings']));
  assert.equal(caps.systemPrompt, true);
  assert.equal(caps.tools, true);
  assert.equal(caps.settings, true);
  assert.equal(caps.settingsRegister, true);
});

test('服务存在但缺少子方法时报告 false（老/裁剪过的 DSH）', () => {
  const ctx = { systemPrompt: {}, tools: {}, settings: {} };
  const caps = capabilities(ctx);
  assert.equal(caps.systemPrompt, true);
  assert.equal(caps.systemPromptVariable, false);
  assert.equal(caps.toolsRestrict, false);
  assert.equal(caps.toolsGuard, false);
  assert.equal(caps.settingsRegister, false);
});

test('ctx 为 undefined / null 时不抛', () => {
  for (const value of [undefined, null]) {
    assert.doesNotThrow(() => capabilities(value));
    assert.equal(capabilities(value).tools, false);
  }
});

console.log('✅ qq-plugin-runtime capabilities() 的未注入服务兜底测试通过');