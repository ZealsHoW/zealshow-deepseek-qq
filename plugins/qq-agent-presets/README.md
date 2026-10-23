# qq-agent-presets

qq-bridge 的 DSH **bundle 插件**：把 `qq-chat` / `qq-chat-v2` 两个 agent preset 装进 DSH，
并携带两代 preset 共用的安全守卫与提示词变量兜底。

## 文件

| 文件 | 作用 | 权威源 / 注意 |
| --- | --- | --- |
| `presets/qq-chat.patch.yml`、`presets/qq-chat-v2.patch.yml` | DSH 0.1.7+ 的 bundle patch：插入 `@deepseek-ai/dsh-agent-preset` 行 | **生成物**，由 `scripts/build-agent-preset-patches.mjs` 从 `dsh/agent-presets/<preset>/` 生成；不要手改 |
| `qq-tool-restrict.mjs` | 唯一权威的安全守卫：注册期 `tools.restrict` 隐藏危险工具 + 执行期 `tools.guard` 白名单 | 两个 preset 的子行都引用 `qq-agent-presets/qq-tool-restrict.mjs`（从 profile 目录可解析） |
| `qq-prompt-vars.mjs` | 在 agent 作用域补注册 `cwd`，避免 `unknown prompt variable "{{cwd}}"` | 只兜底 `cwd`；新变量必须先确认宿主注册并登记到 `src/plugin-contract.js` |
| `qq-plugin-runtime.mjs` | 能力探测 + JSONL 诊断（默认 `%TEMP%\qq-agent-presets.log`，`QQ_PLUGIN_DIAG` 可覆盖/置空关闭） | 诊断失败绝不影响插件 |

## 安装方式

不会单独安装本目录：`scripts/setup-dsh.mjs` 把它作为 `link:` 依赖注册到 profile，
并把本包加入 `dsh.profile.bundles`。pack 里的两个 patch 文件由 DSH 的 bundle 机制加载。

```text
node scripts/build-agent-preset-patches.mjs   # 源 → patch
node scripts/setup-dsh.mjs <profile>          # link + bundles
# 重启 DSH
npm run doctor                                # 验证契约/安装
```

## 失败时的行为（刻意设计）

| 情况 | 行为 | 原因 |
| --- | --- | --- |
| `tools.guard` 不可用 / `tools` 缺失 | **抛错，拒绝启用 preset** | 执行期白名单是安全边界，不能静默降级 |
| `tools.restrict` 不可用 | 告警，继续注册 guard | 只影响 schema 隐藏；执行期仍拒绝 |
| `systemPrompt.variable` 不可用 | 告警，不抛，跳过 `cwd` 注册 | 让 DSH 报原始错误，比插件先炸更可诊断 |
| 名单里的名字在当前 DSH 不存在 | 记为**预期**（scoped 工具本来就不在全局层；历史工具记录在 `TRACKED_ABSENT_TOOL_NAMES`），只在诊断里留计数/样本 | 每个新会话都告警会把真正的 seam 变化淹掉 |
| `TRACKED_ABSENT_TOOL_NAMES` 里的工具重新出现 | `npm run test:preset-local-tools` 变红 | 能力回来了，必须复核 restrict 是否真的生效 |

## 验证

```text
npm run test:presets                          # patch 防漂移 + cwd 兜底 + 模板变量来源
npm run test:preset-local-tools               # L7：仿真会话不得有本地工具
npm run test:plugin                           # 守卫/契约
npm run doctor                                # 环境体检（含工具面扫描、profile、活 DSH）
```

环境变化（DSH 升级、工具面变化、提示词变量缺失、profile 换位置）的处置见
[`docs/guides/PLUGIN_ENV_PLAYBOOK.md`](../../docs/guides/PLUGIN_ENV_PLAYBOOK.md)。
