// QQ 桥接安全硬边界：只允许 QQ MCP 工具与少量无害模型侧工具。
//
// 本文件是 qq-agent-presets bundle 里的**唯一权威实现**，由 qq-chat / qq-chat-v2 两个
// agent preset 的 qq-tool-restrict 行共同引用（dsh/agent-presets/<preset>/qq-tool-restrict.mjs
// 只是个 re-export 壳，避免出现两份会漂移的实现）。
//
// 为什么引用方式是「包名/子路径」而不是 `./qq-tool-restrict.mjs`（DSH 0.1.7 的机制变化）：
//   0.1.5 的 preset 是 ~/.dsh/.agent-presets/<preset>/ 目录，相对名按 preset 目录解析；
//   0.1.7 的 preset 变成一条 loader 行，子行 name 按**声明它的 loader 上下文**
//   （= profile 目录 file:///…/.dsh/profiles/<profile>/）解析，因此 `./x.mjs` 会去找
//   profile 根目录下的文件（不存在）。bundle patch 文件只对 insert 行自己的 name 做
//   「相对 patch 文件锚定」（dsh-app-boot 的 anchorInsertedPluginNames），不会走进
//   preset 行的 config.plugins —— 所以守卫只能用**从 profile 目录可解析的裸说明符**。
//   该包以 link: 依赖注册在 profile package.json，node_modules junction 由
//   scripts/setup-dsh.mjs（或 dsh-super-injector 的 dev_heal_links）维护：
//   不写死任何绝对路径，仓库搬家后重建链接即可。
// 作用：
//  1) 用 tools.restrict 把本地执行/文件类工具与开发工具从**工具清单**里隐藏（注册期）；
//  2) 用 tools.guard 白名单兜底：任何不在允许范围内的工具，执行时一律拒绝。
//
// ⚠️ 第 1 条是铁律 L7 的落点，不是"附注"：仿真会话的 preset 永不包含本地工具。
//    `tools.guard` 只能拒绝**执行**，工具名仍会出现在模型的 schema 里——
//    那既不满足"仿真会话不得拥有本地执行能力"的注册期要求，也会诱导模型去调它。
//    所以本地工具必须同时出现在下面的 restrict 名单里。
import { capabilities, diag, guideHint, pluginVersion, warn } from './qq-plugin-runtime.mjs'

export const name = 'qq-tool-restrict'

export const inject = ['tools']

/** 供 doctor / 测试读取的静态契约（不参与 DSH 装配）。 */
export const PLUGIN_CONTRACT = Object.freeze({
  id: 'qq-tool-restrict',
  version: pluginVersion(),
  requires: { tools: true, toolsGuard: true },
  failClosed: true,
  doc: 'docs/guides/PLUGIN_ENV_PLAYBOOK.md#tool-drift',
})

/**
 * 本地执行 / 文件访问 / 进程控制类工具：仿真会话**不得**拥有。
 *
 * 名字**逐个核对过** DSH 0.1.7-rc.2 实际注册的工具名（来源包见每条注释），
 * 不是凭印象列举。教训：本名单初版把 `pwsh_persistent`/`bash_persistent`/
 * `cordis`/`goal_write`/`goal_read` 当成工具名，这五个**根本不存在**——
 * 而 `tools.restrict()` 对未知名字会抛错、被下面的 try/catch 逐个吞掉，
 * 于是坏名字**静默失效**。`test-preset-local-tools.mjs` 现在会把本数组与
 * DSH 真实工具名集合求差，专门防这类拼写假名。
 *
 * 2026-09-27 针对 0.1.7-rc.2 重新对账（不是逐个打补丁）：`dsh-tool-cordis` 仍在，
 * 但 `cordis_define`/`cordis_undefine`/`cordis_run`/`cordis_stop` 四个名字**已被删除**，
 * 现在只注册 `cordis_inspect_list`/`cordis_inspect_query`——旧名字留在名单里
 * 只会换来四条静默失效的 restrict（正是本名单最怕的失败模式），
 * 而新名字能读宿主运行期状态，属于必须隐藏的那一类，所以是**替换**不是删除。
 * 同一轮对账还补上了 0.1.7 新增的两个能力：
 *   - `load_workspace_dependencies`（自带 Python/Node/pnpm 的绝对路径 ⇒ 等于递上执行能力）
 *   - `list_subagent_models`（派生 agent 家族，暴露宿主模型路由配置）
 *
 * 来源包（0.1.7-rc.2）：
 *   dsh-tool-pwsh / -pwsh-persistent   → pwsh（persistent 变体注册的就是 "pwsh"）
 *   dsh-tool-bash / -bash-persistent   → bash（同上）
 *   dsh-tool-fs                        → read / read_image / write / edit
 *   dsh-tool-fs-search                 → glob / grep
 *   dsh-tool-str-replace-editor        → str_replace_editor
 *   dsh-tool-workspace-dependencies    → load_workspace_dependencies
 *                                        （返回内置 Python/Node/pnpm 的绝对路径）
 *   dsh-tool-subagent                  → subagent / subagent_fork / list_subagent_models
 *   dsh-tool-subagent-control          → send_message / interrupt_agent / list_agents
 *   dsh-tool-workflow / -ralph         → workflow / ralph
 *   dsh-tool-jobs                      → job_list / job_output / job_kill
 *   dsh-tool-todo / -skill / -present  → todo_write / skill / present
 *   dsh-tool-goal                      → get_goal / create_goal / update_goal
 *   dsh-tool-cordis                    → cordis_inspect_list / cordis_inspect_query
 *                                        （读宿主运行期状态；0.1.7 已无装载类工具名）
 *   dsh-plugin-guard（web profile bundle）→ dsh_snapshot / dsh_rollback / incident_resolved
 *                                        （读写 package.json/lockfile/patch 并 **spawn pnpm**）
 *   dsh-mode-boost（已装插件，当前未进 bundles）→ dev_mode_set / _status / _subagent
 *                                        （dev_mode_subagent 会派生 agent）
 *
 * ⚠️ 硬证据：2026-08-29 的一次 **qq-chat-v2 仿真会话**记录下来的工具清单里，
 * 除了 MCP 工具就只有 `ask_user_question`、`todo_write`、`dev_mode_*`、
 * `dsh_rollback`、`dsh_snapshot`、`incident_resolved`。也就是说
 * **`dsh_snapshot`/`dsh_rollback` 真的进过仿真会话的 schema**——本名单初版漏了它们。
 *
 * 2026-09-29 针对 DSH 0.2.0-rc.2 重新对账（同样不是逐个打补丁，而是拿安装包重扫）。
 * 对账工具：`node scripts/scan-dsh-tool-names.mjs`（可重复运行；它从已安装的
 * `@deepseek-ai/dsh-*` 里抽真实工具名，与本名单求双向差）。
 * 该轮结论：**旧名字全部还在**（0 个假名，0.1.7 那次替换后没有再次改名），
 * 但 0.2.0 的包里多出 13 个「危险语义」名字是名单没覆盖的，逐条判定如下：
 *
 *   ① 真的会进仿真会话、必须隐藏的（它们在**全局层**，所有 preset 都继承）：
 *      · `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource`
 *        —— `dsh-base` 的 `mcp-resources` 行**默认启用**（cordis.patch.yml 里没有
 *        disabled），所以每个 QQ 会话都会继承这三个工具。`read_mcp_resource` 的
 *        `server` 参数可以指向**任意已配置的 MCP server**：用户一旦挂了
 *        filesystem 之类的能力型 MCP，QQ 群就通过它拿到了文件读取权。
 *        这正是 L7 要挡的那类越权路径，因此必须从 schema 里隐藏。
 *   ② 会派生 agent / 执行外部代码（当前只在 DSH 自带 preset 里挂载，QQ preset 不挂；
 *      列进来是**回归网**：别的 composition 一旦把它们推进全局层就被挡住）：
 *      · `spawn_teammate` / `team_task_create|get|list|update`（实验性 Team 模式）
 *      · `subagent_codex` / `subagent_claude_code` 在 0.2.1 实测中已不存在，
 *        已移入 `TRACKED_ABSENT_TOOL_NAMES`（回归网保留，不参与 restrict）。
 *   ③ 等于把插件装载权交出去 ⇒ 任意代码执行：
 *      · `plugin_manager`（安装/卸载/启停插件，内部会 spawn pnpm）
 *   ④ 无人值守的自我调度（`dsh-schedule`，0.2.0 起是可选 bundle）：
 *      · `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete`
 */
const LOCAL_EXECUTION_TOOLS = [
  // shell / 进程
  'pwsh', 'bash',
  // 文件读写
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  // 文件检索
  'glob', 'grep',
  // 自带运行时（Python/Node/pnpm 的绝对路径）⇒ 等于把"跑代码"递给模型
  'load_workspace_dependencies',
  // 派生 agent 与编排（都能间接拿到 shell）
  'subagent', 'subagent_fork', 'list_subagent_models',
  'send_message', 'interrupt_agent', 'list_agents',
  'workflow', 'ralph',
  // 插件/cordis 运行期检查：能读宿主状态（0.1.7 起只有这两个名字）
  'cordis_inspect_list', 'cordis_inspect_query',
  // 本机文件 + 进程：plugin-guard 会改写配置并 spawn pnpm
  'dsh_snapshot', 'dsh_rollback', 'incident_resolved',
  // 会话/交付/任务面
  // 注意：`todo_write` 与 `ask_user_question` **故意不在**此名单——它们是下面
  // SAFE_EXACT 允许的无害模型侧工具，两边不能自相矛盾。
  'job_list', 'job_output', 'job_kill', 'skill', 'present',
  'get_goal', 'create_goal', 'update_goal',
  // 0.2.0 新增对账（见上方长注释的 4 类判定）：
  //   ① 全局层默认启用 ⇒ 真的会进仿真会话
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  //   ② 派生 agent / 执行外部代码
  // 0.2.1 已移除，但仍保留在 restrict 名单里当回归网（失败按 TRACKED_ABSENT 归为预期）。
  'subagent_codex', 'subagent_claude_code',
  'spawn_teammate', 'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  //   ③ 插件装载权（= 任意代码执行）
  'plugin_manager',
  //   ④ 无人值守的自我调度
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  // 0.2.1 重新对账（2026-10-20；扫描 295 个包 / 60 个候选）：
  //   · terminal_*：本机终端会话（读/写/信号），L7 必须隐藏；
  //   · session_*：读宿主会话/事件归档，属于跨会话数据面，不应暴露给 QQ；
  //   · plugin_market：插件市场能力，等价于装载权。
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'session_search', 'session_event_search', 'session_event_read', 'session_event_trace', 'session_trace',
  'plugin_market',
  // 已装但当前未进 bundles 的插件（一旦加回就是新口子）
  'dev_mode_set', 'dev_mode_status', 'dev_mode_subagent',
]

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  // 本地执行面（见上）
  ...LOCAL_EXECUTION_TOOLS,
  // dsh-super-injector / 开发注入器（0.1.7-rc.2 实测注册的全局工具）
  // 说明：这些名字是**运行时**才出现的（注入即注册、卸载即消失），所以只能尽力 restrict；
  // 真正的边界是下面的执行期白名单。
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_plugin_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
]

// 供 test-preset-local-tools.mjs 导入并与 DSH 真实工具名对账，避免两份名单漂移。
export const RESTRICTED_TOOL_NAMES = Object.freeze([...KNOWN_DANGEROUS_GLOBAL_TOOLS])

/**
 * 当前安装里**不存在、但历史上真实注册过**的工具名（回归网，不是拼写错误）。
 *
 * 2026-10-20 用修好的 `scan-dsh-tool-names.mjs` 实测：当前 DSH 0.2.0-rc.2 的
 * 278 个 `@deepseek-ai/dsh-*` 包里**没有** `dsh-plugin-guard`（那是 web profile
 * bundle，曾装过、现在不在），因此下面三个名字调用 `tools.restrict()` 会抛
 * “工具不存在”。它们仍保留在 restrict 名单里，因为：
 *   · 一旦插件被重新装回，仿真会话不该把 snapshot/rollback 能力暴露出去；
 *   · 执行期白名单本来也会拒绝这三个名字（不在 SAFE_EXACT/前缀内）——
 *     即使 restrict 没生效，执行仍然被挡。
 *
 * 对账规则（`test-preset-local-tools.mjs` 钉住）：
 *   · 名单里的名字在当前 DSH 找不到时，**只有**在下面这个清单里才允许；
 *   · 一旦某个名字重新出现在 DSH 里，测试会失败，要求把它从本清单移出
 *     （说明能力回来了，必须确认 restrict 真的生效）。
 *
 * 不要把这里当成“允许拼错”的后门：新增条目必须同时在测试注释里给出
 * 来源包与实测日期。
 */
export const TRACKED_ABSENT_TOOL_NAMES = Object.freeze([
  'dsh_snapshot',
  'dsh_rollback',
  'incident_resolved',
  // 0.2.1 实测：当前安装不再提供 Codex / Claude Code 子智能体工具；
  // 保留在回归网里，重新出现时测试会要求复核 restrict。
  'subagent_codex',
  'subagent_claude_code',
])

// 执行期白名单：不在这些范围内的工具一律拒绝。
// 前缀覆盖 DSH MCP client 暴露的命名空间工具。
const SAFE_PREFIXES = [
  'mcp__snowluma__',
  'mcp__snowluma-host__',
  'mcp__web-search-safe__',
]

// 无害模型侧工具：ask_user_question 用于把问题转给管理员/用户，
// todo_write 仅维护任务列表。若后续 preset 不再挂载这些工具，保留无害。
const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
])

export function apply(ctx) {
  const caps = capabilities(ctx)
  diag('apply', {
    plugin: 'qq-tool-restrict',
    caps,
    restrictedNames: KNOWN_DANGEROUS_GLOBAL_TOOLS.length,
    trackedAbsent: TRACKED_ABSENT_TOOL_NAMES.length,
  })

  // 0) 执行期白名单是**最后一道**边界。DSH 没有 tools.guard 时继续运行 =
  //    仿真会话可能执行任何继承来的工具，这是安全回归，因此 fail-closed：
  //    宁可让 preset 装配失败并留下明确诊断，也不静默放行。
  if (!ctx?.tools || typeof ctx.tools.guard !== 'function') {
    const reason = !ctx?.tools
      ? 'DSH 没有注入 tools 服务'
      : 'tools.guard() 不可用（DSH 插件 seam 变化）'
    warn(
      `安全边界无法建立：${reason}；按 fail-closed 拒绝启用 QQ 仿真 preset。`
      + ` ${guideHint('tool-drift')}`
    )
    throw new Error(
      `[qq-tool-restrict] ${reason}。QQ 仿真会话的执行期白名单是安全边界，`
      + '缺少它时不允许降级运行。请运行 `npm run doctor` 并查看 '
      + 'docs/guides/PLUGIN_ENV_PLAYBOOK.md#tool-drift。'
    )
  }

  // 1) 把已知危险全局工具从 schema 隐藏（restrict 只影响继承的全局层，
  //    不会误删 preset 自己注册的 scoped 工具）。
  // 逐个 restrict：当前 DSH 版本不存在的工具名会单独抛错并跳过，
  // 不会导致整批限制失败（restrict 的 unknown 校验是整批原子性的）。
  //
  // 口径（2026-09-27 实测 web profile 的全局层）：实际存在的全局工具只有
  // `dev_*`（注入器）与三个 MCP 命名空间的工具；`read`/`pwsh`/`subagent` 这类
  // 是**各 preset 行自己注册的 scoped 工具**，在 QQ preset 里根本没挂载，
  // 因此本名单主要防的是"别的 composition 把它们注册进全局层"这种回归，
  // 以及 MCP 之外的宿主工具（plugin-guard / cordis 检查工具等）。
  //
  // 失败聚合：过去每个名字打一行 console.error，每次新会话几十行噪音。
  //
  // 关键区分（2026-10-20 按 DSH 0.2.0-rc.2 的 restrict() 实现核对）：
  //   DSH 对不在**全局层**的名字抛 `tools.restrict() names unknown global tool …`。
  //   本名单里 `pwsh`/`read`/`subagent` 这类是 preset 自己注册的 scoped 工具，
  //   在 QQ preset 里本来就不在全局层 —— 这条失败是**预期**的，不能每次新会话
  //   都告警（那会把真正的 seam 变化淹掉）。只有“预期之外”的错误才 warn：
  //     · restrict 要求 scoped context（说明调用点/作用域机制变了）；
  //     · reserved 名称 / 参数形状变化；
  //     · TRACKED_ABSENT 之外的其它未知错误。
  if (typeof ctx.tools.restrict === 'function') {
    const failures = []
    for (const name of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
      try {
        ctx.tools.restrict({ deny: [name] })
      } catch (error) {
        failures.push({ name, message: error?.message ?? String(error) })
      }
    }
    if (failures.length > 0) {
      const expected = failures.filter((f) => /names unknown global tool/i.test(f.message)
        || TRACKED_ABSENT_TOOL_NAMES.includes(f.name))
      const unexpected = failures.filter((f) => !expected.includes(f))
      diag('restrict-failures', {
        total: failures.length,
        expectedCount: expected.length,
        expectedSample: expected.slice(0, 8).map((f) => f.name),
        unexpected,
      })
      if (unexpected.length > 0) {
        // 预期之外的失败不能当成“名字不存在”吞掉：可能是 restrict seam 本身变了。
        warn(
          `${unexpected.length} 个 restrict 失败且不属于“工具不在全局层”的预期情况：`
          + `${unexpected.map((f) => `${f.name}（${f.message}）`).join('; ')}。`
          + ` ${guideHint('tool-drift')}`
        )
      }
    }
  } else {
    // restrict 缺失只影响“注册期隐藏”，执行期仍由下面的 guard 兜底。
    // 这是**可接受降级**，但必须留下告警，避免“以为隐藏了、其实没有”。
    warn(
      'tools.restrict() 不可用：本地/危险工具会留在模型的 schema 里，'
      + '但执行期白名单仍会拒绝执行。'
      + ` ${guideHint('tool-drift')}`
    )
  }

  // 2) 执行期白名单：任何不在允许范围内的工具调用都会被拒绝。
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    if (SAFE_EXACT.has(name)) return
    if (SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) return
    return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`
  })
  diag('guard-registered', { safePrefixes: SAFE_PREFIXES.length, safeExact: [...SAFE_EXACT] })
}
