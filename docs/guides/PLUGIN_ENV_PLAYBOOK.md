# 插件环境变化应对手册（PLUGIN_ENV_PLAYBOOK）

> 适用对象：`plugins/qq-agent-presets`、`plugins/qq-mode-console` 两个**自建 DSH 插件**，
> 以及它们依赖的 preset bundle、profile 解析层、DSH 运行时 seam。
> 目标：环境变了（DSH 升级、安装位置变化、端口变化、工具面变化、profile 变化）时，
> **先体检、再定位、后改动**；每条改动都有验证与回滚，而不是直接改代码赌一把。
>
> 最后核对：2026-10-20（DSH **0.2.1-rc.2** / cordis 4.0.5 / Node 24.15）。
> ⚠️ 工作区里的 `_dsh_asar` 是 **0.2.0-rc.2** 的旧解包副本，不能当当前运行时用；
> 当前运行时以 `~/.dsh/runtime/0.2.1-rc.2` 为准（由 `extract-asar-runtime.mjs` 从当前 app.asar 解包）。
> 所有命令都在仓库根（`qq-bridge/`）执行。

---

## 0. 先做这三件事（30 秒）

1. 跑体检：`npm run doctor`
   - 看最后的「✖ 失败 / ⚠ 警告」；每项下面都有 `→` 命令和指南锚点。
   - 不能连活 DSH 时：`npm run doctor -- --offline`。
2. 看日志：`state/bridge.log` 里搜 `💡 环境适配` / `🩺 插件环境预检`。
   - 桥接现在会把已知环境错误翻译成「下一步做什么」，并写入 `state/env-incidents.jsonl`。
3. 按症状打开本手册 §3 对应小节；**不要**先改 `bridge.js` 或 `qq-tool-restrict.mjs` 的名单。

> 体检是**只读**的：它不写配置、不建会话、不改 profile。修复动作永远由你显式执行。

---

## 1. 三层契约：环境一变，断在哪一层

| 层 | 位置 | 谁维护 | 变化时的典型症状 |
| --- | --- | --- | --- |
| **DSH 运行时 seam** | `systemPrompt` / `tools.restrict` / `tools.guard` / `settings` / 提示词变量 | DSH 版本 | `unknown prompt variable`、`No configurable plugin entry`、工具面少隐藏/多隐藏 |
| **preset bundle** | 源 `dsh/agent-presets/<preset>/` → 生成 `plugins/qq-agent-presets/presets/*.patch.yml` → 装进 DSH | 本仓库脚本 | DSH 里看不到 `qq-chat` / 还是旧人设 / 守卫行没生效 |
| **profile 解析层** | `~/.dsh/profiles/<profile>/package.json`（`link:` 依赖 + bundles）、`node_modules/` junction | `setup-dsh.mjs` + DSH 安装器 | 插件根本没加载、`Cannot find package`、脚本扫不到 DSH 工具包 |
| **外部服务** | DSH Web API（端口动态）、SnowLuma（WS 3001 / HTTP 3000） | 各自进程 | `ECONNREFUSED`、上游健康告警、QQ 没反应 |

**判断原则**：先确定断在哪一层，再动那一层的文件。跨层盲改（比如 DSH 端口变了却去改守卫名单）
是过去反复出问题的根因。

---

## 2. 一键体检（`npm run doctor`）

```text
npm run doctor                 # 离线检查 + 活 DSH + 工具面扫描 + SnowLuma TCP
npm run doctor -- --offline    # 不连 DSH（换机器/DSH 没启动时）
npm run doctor -- --no-tools   # 跳过工具名扫描（更快）
npm run doctor -- --json       # 机器可读（CI/工单）
npm run doctor -- --strict     # 警告也返回非 0
npm run doctor -- --verbose    # 连通过项也打印细节
```

退出码：`0` 无失败；`1` 有失败（`--strict` 时警告也算）；`2` 体检脚本自身崩溃。

> Windows PowerShell 若禁止运行 `npm.ps1`（ExecutionPolicy），改用
> `cmd /c "npm run doctor"`，或直接 `node scripts/doctor-plugins.mjs`。

它检查（按输出顺序不一定相同）：

| 检查项 | 说明 |
| --- | --- |
| `node` / `repo` / `config` / `env` | 版本、必要文件、配置白名单、环境变量覆盖 |
| `preset-patches` | 生成的 patch 与 `dsh/agent-presets` 源是否**逐字一致** |
| `preset-variables` | 模板里的每个 `{{变量}}` 是否有已知来源（`src/plugin-contract.js` 的来源表） |
| `plugin-contract` | 用假 ctx 真正执行两个插件的 `apply`，验证注册 cwd / 守卫 / Config |
| `profile-wiring` | 每个装了插件的 profile：`link:`、bundles、真实目录 |
| `parsing-layer` | `~/.dsh/profiles/node_modules` 里指向已删除目标的 `@deepseek-ai` 链接 |
| `dsh-modules` | 能否定位**真正的** DSH 运行时（不是任意 node_modules） |
| `tool-scan` | 守卫名单 vs 当前安装工具名（含「已知缺失」双向校验） |
| `plugin-load` | 插件诊断日志里最近一次 `apply` 是否来自**仍存活**的进程 |
| `bridge` | `state/bridge.lock` PID、心跳新鲜度 |
| `snowluma` | `snowluma.wsUrl` 的 TCP 可达性（不做鉴权、不发消息） |
| `live-dsh` / `live-qq-mode` / `live-presets` | 活 DSH 的 `settings/describe`、`qq-mode` 字段、`agentPresets/list` |
| `incidents` | `state/env-incidents.jsonl` 最近 5 条环境事故 |

**它不能替代什么**：不创建会话、不验证模型真实回复、不检查 QQ 发送白名单。这些仍由
`npm run test:audit`、`npm run verify:adaptation`、真实 QQ 链路负责。

---

## 3. 场景手册

> 每一节格式：**症状 → 30 秒定位 → 根因 → 修复 → 验证 → 回滚 / 不要做**。
> 命令都在仓库根执行；`<profile>` 用实际在跑的 profile（本机是 `desktop`）。

### <a id="dsh-runtime"></a>3.1 DSH 升级 / 重装 / 安装位置变化

**症状**
- 升级后突然 `unknown prompt variable`、`No configurable plugin entry`、工具面行为变化。
- `npm run scan:tool-names` 输出「扫描包数：0」，然后把整个守卫名单报成假名。
- 脚本报 `ECONNREFUSED 127.0.0.1:3080`，但 GUI 明明开着（端口变成动态端口）。

**30 秒定位**
```text
npm run doctor
node scripts/scan-dsh-tool-names.mjs --missing
```
- 看 `dsh-modules`：是否定位到**含 `@deepseek-ai/dsh-*`** 的目录；
- 看 `dsh-modules-freshness`：是否在用 app.asar 的**解包副本**（升级后可能过期）；
- 看 `tool-scan`：`扫描 N 个包` 是否为 0。
- 看 `live-dsh` 的 `baseUrl` 是否就是当前 GUI 地址。

**根因**
DSH 桌面版把运行时打在 `resources/app.asar` 里。脚本要读包内容，只能读**解包副本**
（本机是 `_dsh_asar/dsh/node_modules`）。一旦 DSH 升级/换安装位置：
1. 解包副本过期 → 工具名对账基于旧版本，结论不可信；
2. `~/.dsh/profiles/node_modules` 里的链接可能仍指向旧安装（见 §3.2）；
3. 端口从固定 3080 变成动态端口（本机 61388）。

**修复**
```text
# 1) 重新解包当前 app.asar（需要 @electron/asar）
npx @electron/asar extract "<DSH 安装目录>/resources/app.asar" <解包目录>
# 2) 让脚本用新副本（也可以写进环境变量，别改脚本常量）
set DSH_INSTALL_MODULES=<解包目录>/dsh/node_modules
# 3) 重新对账
node scripts/scan-dsh-tool-names.mjs --missing
npm run doctor
# 4) 基础回归 + 活 DSH 适配验证
npm run test:audit
npm run verify:adaptation
```
如果只是端口变了：只改 `config.json` 的 `dsh.baseUrl`，**不要改脚本里的默认值**；
`src/dsh-client.js` 的 `resolveDshBaseUrl()` 已统一解析（显式参数 → `DSH_BASE_URL` →
`DSH_WEB_URL` → `config.json` → 3080）。

**验证**
- `npm run doctor`：`dsh-modules` 版本 = 当前 DSH；`tool-scan` 扫描包数 > 0。
- `npm run verify:adaptation`：75 项全过（会建一个探测会话并归档，属正常）。

**回滚 / 不要做**
- 不要把 `_dsh_asar` 的版本号当成「当前安装」写进代码；它只是可读副本，立即可替换。
- 不要为了让测试变绿去删守卫名单里的名字——先确认是「工具不存在」还是「扫描器没找到包」。
- 保留旧的解包目录直到新版本验证通过；回滚 = 设回 `DSH_INSTALL_MODULES` 旧路径。

---

### <a id="old-install-links"></a>3.2 profile 解析层有大量断链（换安装位置的残留）

**症状**
- `npm run doctor` 的 `parsing-layer`：`N/N 个 @deepseek-ai 链接指向已删除的位置`。
- 某些脚本/插件从 profile 解析 `@deepseek-ai/*` 失败，但 DSH 本身运行正常。
- 本机真实值：2026-10-20 曾出现 243 个链接全部指向已删除的旧安装目录
  （作者本机是从一个带空格的旧路径搬到短路径的）。修复分两轮：
  237 个重指向 0.2.0 稳定副本 + 6 个旧包名清理；随后确认当前 DSH 是 **0.2.1-rc.2**，
  又把 237 个里 227 个重指向 0.2.1、10 个 0.2.1 已不包含的包清理。
  现在 **227 个链接、0 断链**，doctor 的 `parsing-layer` 为通过。

**30 秒定位**
```text
npm run doctor   # parsing-layer 会打印数量 + 3 个示例目标
```
看目标路径是否属于**上一个**安装目录；再确认当前 DSH 是否正常（通常正常，因为
DSH 用自己的 asar 运行时，不依赖 profile 里这层链接）。

**根因**
DSH 安装器会把运行时包铺到 `~/.dsh/profiles/node_modules` 供插件解析。换安装位置/升级后，
旧 junction 没有被清理，形成「断链」。它不一定立刻报错，但会让**从 profile 解析**的
工具静默失效——这是最危险的失败形态。

**修复（推荐，已在本机验证）**
1. 先确认**当前 DSH 真实版本**（不要用工作区 `_dsh_asar` 的版本），并跑一次只读体检：
   ```text
   npm run doctor
   $env:ELECTRON_RUN_AS_NODE='1'
   & '<DSH>\DeepSeek Harness.exe' -e "const fs=require('fs');console.log(JSON.parse(fs.readFileSync('<DSH>/resources/app.asar/package.json','utf8')).version)"
   ```
2. 从**当前 app.asar** 解包出稳定运行时副本（普通 Node 读不了 asar，必须用 Electron）：
   ```text
   $env:ELECTRON_RUN_AS_NODE='1'
   & '<DSH>\DeepSeek Harness.exe' scripts\extract-asar-runtime.mjs --asar='<DSH>\resources\app.asar'
   ```
   - 已有真实解包目录时，也可以 `node scripts/sync-dsh-runtime.mjs --apply --source=<目录>/node_modules`；
   - `sync` 默认源如果是旧版本会**直接报错**，避免把旧副本复制成“当前”。
3. 先预演链接修复，再执行：
   ```text
   node scripts/repair-profile-links.mjs --repoint-outdated
   node scripts/repair-profile-links.mjs --apply --prune --repoint-outdated
   ```
   - 只处理**断链**，以及指向旧 `runtime/<version>`/`_dsh_asar` 的健康链接；
     用户自定义目录一律不碰；
   - 动手前把旧目标写到 `state/profile-link-backup-<时间戳>.json`；
   - 失败项逐条列出，不会阻断其它链接。
4. 验证：
   ```text
   npm run doctor
   npm run verify:adaptation
   ```

> `doctor` 本身仍然**只读**：它只给出上面这些命令，不会自动改 profile。
> 回滚：按备份 JSON 把旧 target 还原为 junction，或从 `~/.dsh/runtime` 删除稳定副本。

**不要做**
- 不要 `rm -rf ~/.dsh/profiles/node_modules` 后不重装——那会让插件的依赖解析更糟。
- 不要把「DSH 能跑」当成「断链无害」：它只说明当前没走到那条解析路径。
- 不要手工把链接指向仓库里的 `_dsh_asar`：仓库一搬就再次断链；用稳定副本。

---

### <a id="profile-wiring"></a>3.3 插件装错 profile（desktop vs web）

**症状**
- 改了插件/跑了 `setup-dsh`，但 GUI 行为没变。
- `npm run doctor` 的 `profile-duplication`：`desktop, web` 两个 profile 都装了 qq-*。
- `live-qq-mode` 正常，但某个脚本检查的是另一个 profile 的文件。

**30 秒定位**
```text
echo %DSH_PROFILE%
type %USERPROFILE%\.dsh\profiles\desktop\package.json
type %USERPROFILE%\.dsh\profiles\web\package.json
npm run doctor
```
- 桌面版 GUI 用 `desktop`；`dsh web` CLI 通常用 `web`。
- 本仓库的 `setup-dsh.mjs` 现在按「命令行参数 → `DSH_PROFILE` → `web`」选 profile，
  不再无条件写 `web`。
- 验证脚本也改为优先 `DSH_PROFILE`，否则 `desktop` 存在就用 `desktop`。

**根因**：历史上脚本把 profile 写死成 `web`，而实际在跑的是 `desktop`；安装/验证都
查了另一份副本，于是「装好了但没生效」。

**修复**
```text
# 明确指定，避免歧义
node scripts/setup-dsh.mjs desktop
npm run verify:adaptation
npm run doctor
# 然后重启 DSH（GUI 菜单或 restart.bat）
```
只维护正在跑的那个 profile；另一个留作备份，不要两边同时手改。

**验证**：`doctor` 的 `profile` 行 = 实际 GUI profile；`live-presets` 含 qq-chat/qq-chat-v2。

**回滚**：`setup-dsh` 覆盖前会写 `package.json.bak-<时间戳>`；恢复备份并重跑 setup。

---

### <a id="prompt-variable"></a>3.4 提示词变量缺失（`unknown prompt variable`）

**症状**
- `bridge.log` / QQ 侧：`unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model, ...`
- 该会话一轮都跑不起来；DSH 里新建同 preset 会话也一样。

**30 秒定位**
```text
npm run doctor   # preset-variables 会列出模板变量与来源
```
- 若 doctor 报「没有已知来源」：模板用了宿主没注册的变量。
- 若 doctor 通过但线上仍报错：DSH 里跑的 preset 是**旧的 patch**（见 §3.6），或插件没有装配（§3.12）。

**根因**：persona 模板里的 `{{变量}}` 必须在提示词装配前由某个插件注册；本仓库的
`qq-prompt-vars` 只兜底 `cwd`。当前 DSH 0.2.1-rc.2 的 agent-loop 只注册 `provider`/`model`，
`cwd` 是我们补的。

**修复（二选一）**
1. 变量确实需要，且宿主应该注册：在 `plugins/qq-agent-presets/qq-prompt-vars.mjs` 增加注册，
   同步 `src/plugin-contract.js` 的 `TEMPLATE_VARIABLE_SOURCES`，补测试。
2. 变量是误写：从 `dsh/agent-presets/<preset>/agent.cordis.yml` 删掉，然后：
```text
node scripts/build-agent-preset-patches.mjs
node scripts/setup-dsh.mjs <profile>
# 重启 DSH
npm run doctor
npm run test:presets
```

**验证**：`npm run test:presets`、`npm run doctor` 的 `preset-variables` 通过；
新建 QQ 会话能正常回复（旧会话需 `/reset` 或重启 DSH 才会重建）。

**不要做**
- 不要用「把 `{{cwd}}` 改成固定字符串」来绕过——人格模板会失去真实工作目录。
- 不要在 `bridge.js` 里做字符串替换：提示词装配在 DSH 进程内，桥接看不到模板。

---

### <a id="tool-drift"></a>3.5 工具面变化（新增/删除/改名）

**症状**
- DSH 升级后，仿真会话里出现本不该有的工具，或守卫日志刷 `restrict` 失败。
- `npm run scan:tool-names` 报「悬空（假名）」；或 `test-preset-local-tools` 红。
- 本机真实值：`dsh_snapshot` / `dsh_rollback` / `incident_resolved` 来自曾装过的
  `dsh-plugin-guard`，当前 0.2.1-rc.2 没有它。

**30 秒定位**
```text
node scripts/scan-dsh-tool-names.mjs --missing
npm run test:preset-local-tools
npm run doctor
```
- 「① 悬空」= 守卫名单里有、安装包找不到 → 要么删，要么放进 `TRACKED_ABSENT_TOOL_NAMES`；
- 「①b 已知缺失」= 预期不存在的回归网；**重新出现**时必须移出清单并复核；
- 「② 未覆盖的危险名」= 新版本新增能力，必须判定是否隐藏。

**根因**：`tools.restrict()` 对未知工具名会抛错；守卫逐个 `try/catch`，于是过期名字
**静默失效**。反过来，新工具漏进 schema 等于给仿真会话开了新口子。

**修复**
1. 先修扫描器定位（§3.1）：扫描包数为 0 时，结论全部不可信。
2. 按扫描输出改 `plugins/qq-agent-presets/qq-tool-restrict.mjs`：
   - 真实存在的危险名 → 加入 `LOCAL_EXECUTION_TOOLS` / `KNOWN_DANGEROUS_GLOBAL_TOOLS`；
   - 当前确实不存在、但历史上真实注册过的 → 加入 `TRACKED_ABSENT_TOOL_NAMES`（写明来源与日期）。
3. 补/改测试，跑：
```text
npm run test:preset-local-tools
npm run test:presets
npm run doctor
```

**验证**：`scan` 退出码 0；`tool-scan` 通过；仿真会话 schema 里没有本地执行类工具。

**不要做**：不要为了消掉一条报错直接把名字删掉——先判断它属于「拼错」「已删除」「当前
可选插件才注册」中的哪一种。

---

### <a id="preset-bundle"></a>3.6 preset 改了但 DSH 没变化（patch 过期 / 没重装）

**症状**
- 控制台/源文件里改了人格或工具面，新会话还是旧行为。
- `npm run doctor` 的 `preset-patches` 报「N 个 patch 过期」。

**30 秒定位**
```text
npm run test:presets          # --check：产物与源是否逐字一致
npm run doctor
```
注意 `dsh/agent-presets/` 是**权威源**；`plugins/qq-agent-presets/presets/*.patch.yml`
是生成物（文件头写着「请勿手工编辑」）。

**修复**
```text
node scripts/build-agent-preset-patches.mjs
node scripts/setup-dsh.mjs <profile>
# 重启 DSH（profile 的 patchReload 可能不是 live）
npm run doctor
npm run verify:adaptation
```
控制台保存人格时会自动备份到 `state/preset-backups/`，可一键还原；还原后同样要重新生成。

**验证**：`live-presets` 含两个 preset；新建会话的 persona 是新版；`preset-patches` 通过。

**回滚**：从 `state/preset-backups/` 恢复源文件 → 重新生成 → 重启 DSH。

---

### <a id="settings-namespace"></a>3.7 `qq-mode` 设置命名空间不可写

**症状**
- 桥接写 DSH 设置失败：`No configurable plugin entry "qq-mode"` 或 `has no volatile fields`。
- 控制台切模式只在本地生效，下一次 DSH 轮询被回滚。

**30 秒定位**
```text
npm run doctor        # live-qq-mode：是否存在、schema 是否有 mode/ownerQQ
npm run probe:settings
npm run test:plugin
```

**根因**：DSH 0.2.0 删除了 `ctx.settings.register()`；命名空间改为：
1. profile patch 里存在 **id 恰好等于 `qq-mode`** 的 loader entry；
2. 该 entry 的模块导出 `Config`；
3. `Config` 至少一个字段带 `.extra('volatile', true)`。

**修复**：逐条核对 `plugins/qq-mode-console/cordis.patch.yml`、`lib/index.js` 的 `Config`；
`node scripts/setup-dsh.mjs <profile>` 后重启 DSH。

**不要做**：不要按旧注释把 `settings.register()` 加回来（0.2.0 会 TypeError）。

---

### <a id="dsh-port"></a>3.8 DSH 端口变化 / 连不上

**症状**：`ECONNREFUSED 127.0.0.1:3080`、`fetch failed`、桥接启动后没有会话。
**定位**：`npm run doctor` 的 `live-dsh`；对照 GUI 地址（或 `DSH_WEB_URL`）与
`config.json` 的 `dsh.baseUrl`。
**修复**：只改 `config.json`；重启桥接。脚本统一走 `resolveDshBaseUrl()`，不要再写死端口。
**验证**：`npm run test:dsh-auth`、`npm run doctor`。

---

### <a id="dsh-auth"></a>3.9 DSH 鉴权失败（401 / Cookie 铸造失败）

**症状**：401、`读不到会话密钥`、`settings/describe` 401。
**定位**
```text
npm run doctor
npm run test:dsh-auth
echo %DSH_HOME%
```
**根因**：Cookie 铸造依赖 `~/.dsh` 里的持久化签名密钥；`DSH_HOME` 指错、DSH 换用户、
密钥变化都会失败。启动 token 只在内存里，重启即失效——不要依赖它。
**修复**：确认 `DSH_HOME`；重启 DSH 后重跑测试；不要把 token 写进代码/配置。
**验证**：`test:dsh-auth` 16 项通过。

---

### 3.10 SnowLuma 升级 / 换端口 / 换账号

**症状**：QQ 没反应/发不出；日志有上游健康告警；401。
**定位**：`npm run probe:heartbeat`（只读）；`npm run doctor` 的 `snowluma`；
看 `config.json` 的 `snowluma.wsUrl`/`httpUrl`/`accessToken`。
**说明**：桥接有端点自愈（`followDiscoveredEndpoint`），但会覆盖手写 `wsUrl`——如果
你刻意固定端点，把它关掉（见 DSH_020_ADAPTATION 附 D）。
**修复**：换账号后 token 会变，用桥接的自发现/控制台重新写入；必要时重启 SnowLuma。
**不要做**：不要在代码里写死 QQ 号/token；不要把 SnowLuma 的注入问题（`[Hook]`）当成桥接 bug。

---

### <a id="acl"></a>3.11 `state/` 权限 / 沙箱写入失败

**症状**：`EPERM/EACCES`，尤其在 DSH 沙箱里跑脚本时；日志/状态写不进去。
**定位**：`npm run diagnose:acl`（**必须在无沙箱终端跑**）。
**根因**：`state/` 被收紧 ACL（去掉继承），沙箱进程的能力 SID 不在 ACL 里。
**修复**：按 `diagnose-acl` 打印的 `icacls` 命令恢复继承；不要关闭 ACL 收紧。
**验证**：普通终端能写；沙箱内脚本按设计显式跳过（不是假通过）。

---

### <a id="plugin-load"></a>3.12 插件有没有真的被装配？

**症状**：改了插件代码但行为没变；`doctor` 的 `plugin-load` 警告。
**定位**
- 诊断文件（临时目录，可用环境变量覆盖）：
  - `%TEMP%\qq-agent-presets.log`（JSONL：apply / registered / warning）
  - `%TEMP%\qq-mode-plugin.log`
  - 关闭：`set QQ_PLUGIN_DIAG=`（空串）；`QQ_MODE_DIAG` 同理。
- `doctor` 只认「写日志的进程仍然存活」的记录；测试/上次运行的残留会被标成警告。
**修复**：重启 DSH；确认 profile bundles 与 `node_modules` 链接（§3.3）；再跑 doctor。
**不要做**：不要以「诊断文件里有 apply」就断定当前 DSH 已加载——先看 pid。

---

### <a id="incidents"></a>3.13 最近环境事故（`state/env-incidents.jsonl`）

桥接收到已知环境错误时会追加一条 JSONL（时间、会话 key、分类、原始消息）。
`doctor` 的 `incidents` 会显示最近 5 条。它的用途是：
- 判断「是不是同一个环境问题反复发生」；
- 把 QQ 里看到的一句天书和具体修复章节对上。
修复后可以保留历史；该文件超过 512KB 会轮转到 `.1`。

---

### <a id="third-party-update"></a>3.14 第三方插件更新失败（`already-installed`）

**症状**
- DSH 插件管理器的「更新」失败：`{"code":"already-installed"}`，并提示
  “更新前的构建未能验证恢复，请先检查该 profile，再重新启动”。

**根因**
- 管理器在 HMR 开启时**拒绝原地替换**已安装包（`installBundle` 里的
  `if (hmr && Object.hasOwn(dependencies, name)) throw already-installed`）。
  它的设计路径是“先卸载，再安装”，而不是原地升级。
- 另一个常见原因是目标版本要求更新的 DSH：例如 `dsh-better-sidebar@0.28.0`
  要求 `@deepseek-ai/dsh-agent ^0.2.1-rc.1` + `cordis ^4.0.5`；
  当前若是 0.2.0-rc.2 就不能装最新版。

**30 秒定位**
```text
# 当前 DSH 真实版本（不要只看工作区解包副本）
$env:ELECTRON_RUN_AS_NODE='1'
& '<DSH>\DeepSeek Harness.exe' -e "const fs=require('fs');console.log(JSON.parse(fs.readFileSync('<DSH>/resources/app.asar/package.json','utf8')).version)"

# 目标版本要求
cmd /c "npm view <包名>@<版本> peerDependencies --json"
```

**修复（本机已用）**
1. 备份 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`。
2. 用 profile 自带的 pnpm 原地升级（选择与当前 DSH 的 peer 范围匹配的版本）：
   ```text
   $d='<DSH>\resources\runtime\primary-runtime\dependencies'
   cd $env:USERPROFILE\.dsh\profiles\<profile>
   & "$d\node\bin\node.exe" "$d\pnpm\bin\pnpm.mjs" add <包名>@<版本> --reporter=append-only
   ```
3. 重启 DSH 后验证（见下）。
4. 若不兼容/启动失败：按备份恢复 `package.json/lock`，再 `pnpm install --frozen-lockfile`
   或装回旧版本。

**验证**
```text
npm run doctor                         # profile/依赖仍完整
# 重启后：listBundles 版本 = 目标版本；listPlugins 该 entry fiberPhase = active
```

**不要做**
- 不要为了“更新按钮能用”把最新版硬装到旧 DSH 上——peer 不匹配会在启动时炸。
- 不要把 `pnpm peers check` 里“missing peer @deepseek-ai/dsh-*”当成错误：这些 peer
  由 DSH 运行时提供，本来就不在 profile 的 `node_modules` 里；看版本是否匹配即可。
- 不要在 `cordis.patch.yml` 里手动再挂一遍同名插件（bundle 已挂载，会双挂）。

---

## <a id="plugin-degradation"></a>4. 插件代码的降级策略（fail-open vs fail-closed）

| 能力缺失 | 行为 | 为什么 |
| --- | --- | --- |
| `systemPrompt.variable()` | 告警，**不抛**，跳过 cwd 注册 | 让 DSH 自己报原始错误，比插件先炸更可诊断；模板不用 cwd 时还能正常跑 |
| `ctx.tools.guard()` | **抛错，拒绝启用 preset**（fail-closed） | 执行期白名单是安全边界；没有它就不能让仿真会话跑起来 |
| `ctx.tools.restrict()` | 告警，继续注册 guard | 只影响「schema 隐藏」，执行期仍会拒绝 |
| `tools` 服务整体缺失 | **抛错**（fail-closed） | 同上，安全边界无法建立 |
| `settings` 缺失（qq-mode-console） | 静默降级，只记诊断 | 聊天链路不依赖设置页；不应因设置不可用而中断 |
| 检测到 0.1.x 的 `settings.register` | 告警，不抛 | 保持聊天可用，把判断留给 doctor |
| 取不到 cwd | 返回空串 | 宁可渲染空目录，也不要让整份提示词装配失败 |

新增一个能力/变量时：
1. 在 `plugins/qq-agent-presets/qq-plugin-runtime.mjs` 的 `capabilities()` 里加探测；
2. 在插件 `apply` 里决定 fail-open / fail-closed，并写清理由；
3. 在 `doctor` 的 `plugin-contract` 检查与测试里覆盖。

---

## 5. 新增一条「环境检查」的标准步骤

不要直接改 `bridge.js`。按这个顺序加：

1. **定义可观测症状**：日志里会出现什么错误/什么状态？写进 §3 的一个新小节（用显式
   HTML 锚点，例如 `<a id="new-check"></a>`）。
2. **静态可判的放 `src/plugin-contract.js`**；需要活 DSH 的放 `scripts/doctor-plugins.mjs`。
   每条检查必须返回 `actions` 或 `doc`。
3. **写失败夹具测试**：在临时目录里构造「环境变了」的形态（断链、未知变量、过期 patch），
   断言能识别；再写一条「正常形态不误报」。
4. **注册进 `scripts/test-audit.mjs`**（离线测试）或 `npm run doctor`（活检查）。
5. 更新本手册、`docs/README.md`、`docs/FOLDER_MAP.md` 的索引。

---

## 6. 回滚与恢复

| 场景 | 回滚动作 |
| --- | --- |
| 改了 preset 源 | 从 `state/preset-backups/` 恢复 → `node scripts/build-agent-preset-patches.mjs` → 重启 DSH |
| 改了 `config.json` | 用 `config.json.bak-<时间戳>` 覆盖；重启桥接 |
| 插件 link 坏了 | `node scripts/setup-dsh.mjs <profile>` 重建；必要时手工恢复 `package.json.bak-*` |
| 插件代码改坏 | 用备份/版本控制恢复；`node scripts/test:doctor` + `npm run test:audit` 先验证 |
| DSH 升级出问题 | 装回旧版 DSH → 重新解包/设 `DSH_INSTALL_MODULES` → `npm run doctor` |
| 桥接卡死 | 停 `start.bat` 窗口；确认只有一个 `node src/bridge.js`；重启 |

**绝不删除**：`state/`、`roles/`、`audio/`、`config.json`（用户数据/凭据）。
备份里可能含 token：不要提交、不要贴到公开 issue。

---

## 7. 命令速查

| 我想…… | 命令 |
| --- | --- |
| 一眼看环境是否适配 | `npm run doctor` |
| 不连 DSH 体检 | `npm run doctor -- --offline` |
| 机器可读报告 | `npm run doctor -- --json` |
| 从当前 app.asar 解包运行时（Electron） | `$env:ELECTRON_RUN_AS_NODE=1; & "<DSH>\DeepSeek Harness.exe" scripts\extract-asar-runtime.mjs --asar="<DSH>\resources\app.asar"` |
| 复制/刷新稳定 DSH 运行时（已是真实目录） | `node scripts/sync-dsh-runtime.mjs --apply --source=<解包目录>/node_modules` |
| 更新第三方插件（管理器报 already-installed） | 备份 profile → `pnpm add <包>@<版本>` → 重启 DSH（§3.14） |
| 修复 profile 断链（先预演） | `node scripts/repair-profile-links.mjs` → `--apply --prune` |
| 工具名对账 | `node scripts/scan-dsh-tool-names.mjs --missing` |
| 重新生成 preset patch | `node scripts/build-agent-preset-patches.mjs` |
| 安装/修复 profile 接线 | `node scripts/setup-dsh.mjs <profile>` |
| 活 DSH 适配验证 | `npm run verify:adaptation` |
| 鉴权链路 | `npm run test:dsh-auth` |
| 插件静态契约 | `npm run test:presets && npm run test:plugin` |
| 全量离线回归 | `npm run test:audit` |
| ACL 诊断（无沙箱终端） | `npm run diagnose:acl` |
| 看插件装配记录 | `type %TEMP%\qq-agent-presets.log` |

---

## 附：本机真实事故记录（为什么会有这本手册）

| 日期 | 现象 | 根因 | 现在的防线 |
| --- | --- | --- | --- |
| 2026-10-20 | `unknown prompt variable "{{cwd}}"`，QQ 会话全挂 | DSH agent-loop 只注册 provider/model；模板用了 cwd | `qq-prompt-vars` 兜底 + `test-preset-prompt-vars` 进 audit + 预检 |
| 2026-10-20 | `scan:tool-names` 扫描 0 个包，守卫名单全报假名 | `dshModulesDir()` 认错 node_modules（旧实现只看 js-yaml） | 新定位器只认 `@deepseek-ai/dsh-*` 锚点 + doctor `dsh-modules` |
| 2026-10-20 | `dsh_snapshot` 等 3 个名字「悬空」 | `dsh-plugin-guard` 已不在当前安装，但测试因 0 包而跳过 | `TRACKED_ABSENT_TOOL_NAMES` 双向校验 + 重扫 |
| 2026-10-20 | `verify:adaptation` 连 3080 失败 | 桌面版端口是 61388，脚本写死 3080 | `resolveDshBaseUrl()` + `test-dsh-base-url` |
| 2026-10-20 | `test-audit` 33/35 | MCP 测试漏拷 `webshot.js`；VOICE.md 被 gitignore 后测试仍硬读 | 补依赖 + 缺文档时显式跳过 |
| 2026-10-20 | profile 里 243 个链接全断 | DSH 从旧的带空格安装路径搬到短路径 | 分两轮修复：243→237 重指向 + 6 清理；确认实际 0.2.1 后 227 重指向 0.2.1 + 10 清理（现 227 链接、0 断链） |
| 2026-10-20 | `dsh-better-sidebar` 更新报 `already-installed` | 管理器在 HMR 下拒绝原地替换已安装包；且最新版要求 DSH 0.2.1-rc.1+ | 确认版本后 `pnpm add dsh-better-sidebar@0.28.0` + 重启 DSH；见 §3.14 |
| 2026-10-20 | 工具面扫描/守卫对账基于 0.2.0 旧副本 | `_dsh_asar` 是旧解包副本，当前安装已是 0.2.1-rc.2 | `extract-asar-runtime.mjs` 从当前 app.asar 解包 + 重新对账（terminal/session/plugin_market 已补进守卫） |
