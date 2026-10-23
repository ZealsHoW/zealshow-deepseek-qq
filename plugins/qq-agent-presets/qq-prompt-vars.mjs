// 提示词变量兜底：`cwd`。
//
// 为什么需要这个插件（2026-10-20 实测）
//   qq-chat / qq-chat-v2 的 persona 模板里写着
//     suffix: Your working directory is {{cwd}}.
//   依赖 agent loop 在每次装配提示词时注册 `cwd` 变量。但当前安装的 DSH
//   （D:\dsh，app.asar 里 dsh-agent-loop 只注册了 provider / model）并没有这个变量，
//   于是整个提示词装配直接失败：
//     unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
//     registered variables: provider, model, vision_router_mode_sync
//   —— 会话一轮都跑不起来，QQ 侧只看到「agent 处理出错」。
//
// 做法：在 preset 的 agent 作用域里补注册 `cwd`，取值来源与上游 agent loop 一致
// （session.header.cwd）。作用域变量按 DSH 的规则**遮蔽**同名的全局变量，所以：
//   - 老/当前版本（agent loop 没注册 cwd）：补上缺口，模板正常渲染；
//   - 新版本（agent loop 已注册 cwd）：scoped 值覆盖全局值，不会重复注册报错。
//
// 降级策略（刻意区分「能降级」与「不能降级」）：
//   - 没有 `systemPrompt.variable()`：**不炸** preset，只告警。模板若仍用 {{cwd}}，
//     DSH 会在装配期抛出原始错误；那至少是 DSG 自己的错误，比这里先抛更可诊断。
//   - 注册本身抛错（例如同名变量已在同一作用域注册）：告警后**原样抛出** —
//     此时继续装配必然得到 unknown prompt variable，早抛能带上更准确的上下文。
//   - 取不到 cwd：返回空串。宁可渲染一句空目录，也不要让整份系统提示词装配抛错。
//     取值失败（getter 抛错）同样吞掉并返回空串。
//
// 诊断：apply 的能力矩阵与注册结果写入 QQ_PLUGIN_DIAG（默认系统临时目录），
// 供 `npm run doctor` 判断「插件是否真的被装配」。
import { capabilities, diag, guideHint, pluginVersion, warn } from './qq-plugin-runtime.mjs';

export const name = 'qq-prompt-vars'

export const inject = ['systemPrompt']

/** 供 doctor / 测试读取的静态契约（不参与 DSH 装配）。 */
export const PLUGIN_CONTRACT = Object.freeze({
  id: 'qq-prompt-vars',
  version: pluginVersion(),
  registers: ['cwd'],
  requires: { systemPromptVariable: true },
  doc: 'docs/guides/PLUGIN_ENV_PLAYBOOK.md#prompt-variable',
});

/**
 * 从装配上下文里取当前会话的工作目录。
 *
 * 任何一层抛错（getter 异常、代理对象）都退化为空串：这个函数在提示词装配的
 * 热路径上，不能成为新的故障点。
 *
 * @param {{ agent?: { session?: { header?: { cwd?: unknown }, cwd?: unknown }, options?: { cwd?: unknown } } }} context
 * @returns {string}
 */
export function resolveCwd(context) {
  try {
    const agent = context?.agent
    const session = agent?.session
    const value = session?.header?.cwd ?? session?.cwd ?? agent?.options?.cwd
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

export function apply(ctx) {
  const caps = capabilities(ctx);
  diag('apply', { plugin: 'qq-prompt-vars', caps });

  const systemPrompt = ctx?.systemPrompt
  // 极老/裁剪过的 DSH 可能没有 variable()（只有 section/context）：那就什么都别做，
  // 让模板里的 {{cwd}} 按原样失败，而不是在这里先炸掉一整个 preset。
  if (!systemPrompt || !caps.systemPromptVariable) {
    warn(
      'systemPrompt.variable() 不可用，跳过 cwd 注册。'
      + ' 若 preset 的 persona 仍使用 {{cwd}}，DSH 会在提示词装配期抛 '
      + 'unknown prompt variable。'
      + ` ${guideHint('prompt-variable')}`
    )
    return
  }

  try {
    systemPrompt.variable('cwd', resolveCwd)
    diag('registered', { variable: 'cwd' })
  } catch (error) {
    const message = error?.message ?? String(error)
    warn(
      `注册 cwd 失败：${message}。`
      + ' preset 使用了 {{cwd}} 时整个会话将无法装配。'
      + ` ${guideHint('prompt-variable')}`
    )
    throw error
  }
}
