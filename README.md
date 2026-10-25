# QQ ↔ DeepSeek Harness 桥接

**English**: [README.en.md](README.en.md) | **中文**: [README.md](README.md)

> 🗂️ 文档索引（全部文档一句话说明 + 是否仍然有效）见 **[docs/README.md](docs/README.md)**；仓库目录/脚本命名约定见 **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**。
>
> 🔒 QQ 会话的权限边界与安全承诺见 **[RULES.md](RULES.md)**。
>
> 🎤 独立的「发语音」工具已拆到仓库上一级的 **`../voice-tool/`**（命令行 `voice-cli.mjs` / 图形界面 `voice-gui.mjs`），不再依赖 qq-bridge 运行。

把 QQ 消息接入 DSH agent：QQ 好友/群发来的消息会变成 DSH 会话里的用户消息，agent 的回复（含提问、工具审批）会发回 QQ。

> ⚠️ **当前版本 `v0.2.0-r5`，适配 DSH 0.2.1-rc.2**（0.2.0 协议兼容；在该版本上逐项实测 84 项：`npm run verify:adaptation`）。
> 鉴权用 `~/.dsh` 里持久化的浏览器会话签名密钥**离线铸造 Cookie** —— DSH 0.1.7 起进程启动 token
> 只存在于内存、不再落盘，旧版「从 guard 日志里读 token」的方式已失效。agent preset 是 DSH 0.1.7 起的
> `@deepseek-ai/dsh-agent-preset` Cordis 行（`~/.dsh/.agent-presets/` 目录机制已废）。协议代次
> （Cookie 鉴权 / 斜杠 RPC / `/api/remote.mux` 事件流）自 DSH `0.1.2-alpha.1` 起引入，与更早的点号
> endpoint 协议不兼容 —— **DSH `0.1.1-rc.2` 及更早**请改用 tag
> [`v0.1.0`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.0)；**DSH 0.1.5-rc.1** 用
> [`v0.1.5`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.5)；**DSH 0.1.7-rc.2** 用
> [`v0.1.7`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.7)。
>
> v0.2.0 修的主要是**会话待处理队列读不出来**：桥接退役/重置 QQ 会话时要先清掉 DSH 侧没跑的队列，
> 而那段解析认的是一个**从来不存在的字段**（`session/control` baseline 的 `value.queues[<id>]`）——
> 于是**每一次**退役都抛 `invalid session/control baseline`，队列清不掉、旧任务继续在 DSH 里跑，
> 而日志里只有一行警告。**注意：这不是 0.2.0 引入的**——该代码随 v0.1.7 发布，报错日志早于
> 0.2.0-rc.2 的发布，0.2.0 只是把它翻了出来。现在读队列以一元 RPC `session/projections` 为主路径、
> 以 `projections[<id>].values.inbox` 为回退形状，并补了两条回归网。
> 同一轮还按 0.2.0 的真实工具清单重新对账了 QQ 安全守卫（新增 15 个必须隐藏的工具名，
> 含全局层默认启用的 `read_mcp_resource`、`plugin_manager`、`subagent_codex` 等）。
>
> 逐条改动说明见 [docs/guides/DSH_020_ADAPTATION.md](docs/guides/DSH_020_ADAPTATION.md)。
>
> **r4 主要改动**：QQ 表情包/动图链路（表情 CDN 优先、`emoji_id` 兜底、DNS 多地址故障切换）、
> 联网搜索改用与 DSH 同源的 DeepSeek 搜索（Bing 仅兜底）、`qq_wait_for_messages` 改 5 分钟长轮询、
> 控制台切模式被 5 秒轮询改回去、回合永久「繁忙」、机器人身份未注入等 issue 修复，外加一轮整体体检。
> 逐条见 [**Release v0.2.0-r4**](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.2.0-r4)。
>
> **r5 主要改动**（本地修复轮次，未单独发 GitHub Release）：本地识图链路修复 ——
> 长边 >1280 的图先缩图再送模型（避掉 Ollama `token repeat limit reached` 必现失败）、
> 视觉生成参数（`numPredict` / `repeatPenalty`）与复读自动重试、MCP 读图工具缺 `key`/`token` 时
> 按消息归属自动补全。详见 [DSH_020_ADAPTATION.md 附录 K](docs/guides/DSH_020_ADAPTATION.md#附v0200-r5-主要改动)。
>
> 默认分支 `main` **就是**本版本，`git clone` 直接拿到，无需切换分支。

```
QQ 消息 ──► SnowLuma（OneBot v11 WS）──► 本桥接进程 ──► DSH Web API (127.0.0.1:3080/api)
                                                ▲                      │
                                                └── agent 回复/提问/审批 ┘
```

## 项目展示

📽️ [AI 仿真群友 - 项目介绍视频](https://github.com/Derpyu520/qq-bridge/releases/download/v0.1.5/project-intro.mp4)（约 11 MB）

> 视频改由 **Release 附件**托管，不在仓库里——只想安装桥接的人不必再下载这 11 MB（它此前占整个仓库体积的 88%）。

## 架构

- **QQ 侧**：`@snowluma/sdk` 的 `SnowLumaWebSocketClient`（OneBot v11 WebSocket 客户端，自动重连）
- **DSH 侧**：适配 DSH 0.1.2 起引入、**0.2.1-rc.2 上逐项复核**的协议——用本机持久化签名密钥铸造会话 Cookie 鉴权、`/api/<namespace>/<method>` 斜杠 RPC、`/api/remote.mux` + `session/follow` 事件流（`session/control` 的队列读 `value.projections[<id>].values.inbox`，另有一元 `session/projections` 主路径）；复用 `AbstractApiClient` 传输层但不再依赖旧版 zod value schema。会话模型由桥接按 `config.json` 的 `dsh.model` 逐会话 `session.selectModel` 固定（默认 `deepseek-flash` = DeepSeek-V41-Flash，多模态）
- **agent 自主收发 QQ**：DSH 的 MCP 客户端（`~/.dsh/profiles/web/cordis.patch.yml` 配置）接入三个 MCP server：
  - `snowluma`（桥接自带 `src/mcp-snowluma-safe.js`）：QQ 动作**安全子集**（查状态/查群/查消息/发消息，发送强制白名单；发送工具支持可选 `replyToMessageId` 引用回复）
  - `snowluma-host`（桥接自带 `src/mcp-host-server.js`）：**只有** `snowluma_status`（只读探活 `get_login_info`）。
    ⚠️ **v0.1.5 起移除了 `start_snowluma` / `stop_snowluma`**（以及 `snowluma.allowProcessControl` 配置项）——
    原因是 **SnowLuma EULA §5.4** 规定「将其并入第三方安装包或 Docker 镜像、**通过自动化脚本部署**」
    须事先取得书面授权，而原生组件属专有组件。本程序**只探测、不部署**：SnowLuma 的安装、启动与扫码
    始终由你自己完成（详见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)）。
  - `web-search-safe`（桥接自带 `src/mcp-web-search-safe.js`）：只读 `web_search` / `web_fetch`（带 SSRF 防护），供 agent 查网络用语/资料。
    **搜索优先复用 DSH 原本的联网搜索**（同一个 DeepSeek Anthropic 兼容端点 + `web_search` 服务端工具，凭据按 `config.webSearch.apiKey` → 环境变量 `DEEPSEEK_API_KEY` → DSH 的 `.credentials.yaml` 顺序解析），
    因而结果质量与 DSH 内的搜索一致、且**不再默认把群聊关键词发给 Bing**（Bing RSS 只在 DeepSeek 不可用时兜底）。
    抓取仍由桥接自己做 SSRF 校验并限制正文大小；**黑话学习默认开启**，会把群聊里提取的词条交给所选的搜索后端。
    数据出机清单见 [LICENSE](LICENSE) 的「数据出机清单」，不需要就关掉黑话自动研究（`slang.autoResearch`）或把 `webSearch.provider` 设为 `bing`。
- **会话模型**：每个 QQ 会话（私聊/群）对应一个独立的 DSH 会话，统一归组到「QQ 聊天」工作区（不再散落未分组）；映射持久化在 `state/sessions.json`
- **性格定制**：QQ 会话默认使用 `qq-chat` agent preset，`reserved2` 使用 `qq-chat-v2`。DSH 0.1.7 起 preset 不再是 `~/.dsh/.agent-presets/<名>/` 目录，而是 `plugins/qq-agent-presets/` bundle 生成并插入 profile 的一条 `@deepseek-ai/dsh-agent-preset` 行（重启 DSH 后生效）；人格与默认 DSH 一致（coding agent），仅附加 QQ 场景规则；**角色扮演**是可选机制——由控制台或管理端设置 `state/current-role.json` 注入（群友无法更改）
- **本地控制台**：桥接自带 Web 控制台 `http://127.0.0.1:3100`——左侧按操作任务分为「运行总览 / 会话与审批 / 人格与角色 / 二代仿真 / 一代仿真 / 黑话词库 / 令牌与花费 / 访问与安全 / 调试与运维 / 工具参考」十个页面，右上角搜索框可跨页定位任意功能项；支持**浅色 / 深色双主题**（顶栏一键切换，未选择时跟随系统）；切换运行模式（chat / closed-agent / reserved / reserved2）、设置角色、静默开关、查看活动日志、修改管理员/控制台令牌，全部即时生效；访问需要令牌（`config.json` 的 `consoleToken`，未配置时自动生成并打印在启动日志；控制台内可手动修改或重新生成）
  - **令牌与花费看板**：实时显示 AI 的 token 消耗与折算金额（元），可下钻到**每个群 / 每个好友 / 每一轮对话**（轮次、步数、缓存命中/未命中输入、输出、命中率、花费、峰谷时段），并有**按时间的消耗走势图**（24 小时 / 3 天 / 7 天 / 30 天，柱子按高峰/空闲着色，一眼看出什么时候烧得凶、哪几个小时是 2 倍价）。累计总量取自 DSH 的 `tokenUsage` 投影（精确，含桥接启动前的历史），逐轮明细由 `assistant/message` 的 `usage` 折叠而来；金额按 DeepSeek 官方价目表折算并区分**高峰 / 空闲时段**（高峰单价为空闲的 2 倍，已内置中国法定节假日）。详见 [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)
  - **人格（角色扮演）管理**：列表点选即可载入查看/编辑提示词，支持新建、保存修改、改名（自动重命名文件）、另存为副本、删除；超过注入上限或含一代专用指令会实时提示
  - **两层提示词可分别查看与修改**：「仿真提示词」（预设内置，管行为与协议，保存后同步到 DSH，需重启生效）与「人格提示词」（`roles/*.md`，管人设与语气，保存即生效）；仿真层保存前做安全不变量校验与自动备份，可一键还原
  - **会话初始提示词**（二代仿真）：「二代仿真 → 初始提示词」里可以给某个群/私聊预写一段环境说明（圈子主题、群内氛围、常见话题、忌讳），AI **只在该会话第一次唤醒时收到一次**（之后已在会话上下文里，不再重复注入）。可在群还没说过话时提前写；AI 既读不到也改不了这份设置（仅控制台接口）。会话被重置（「会话映射」里的重置或「重置二代状态」）后，下一次首次唤醒会重新带上它。字数上限见 `socialV2.initialPromptMaxChars`
  - **DSH 思考强度**：默认 `max`，可选 `high` / `low`，档位从 DSH 实际公布的能力读取，保存后下一条消息生效；控制台会明示该设置同时写入 DSH 全局默认（`~/.dsh/settings.yaml`）
- **运行模式**：
  - `chat`：白名单群 + 白名单私聊 → qq-chat 安全聊天
  - `closed-agent`：仅私聊 owner（config.json 的 ownerQQ，可在控制台设置）→ 完整工具（默认用 DSH 自己声明的默认 preset，即 `standard`；可在控制台「closed-agent preset」下拉改为任意 DSH preset），可在 QQ 上操控 DSH
  - `reserved`（一代仿真）：仿真群友，观望/活跃/试探/退场状态机，选择性参与、按空格分句发送、主动收尾
  - `reserved2`（二代仿真，运行 `setup-dsh.mjs` 后 DSH 默认）：文本不自动转发，AI 通过 `qq_get_unread_messages` / `qq_send_message` 等工具自主看消息、发言、等待、设置唤醒/潜水；DSH 端使用 `qq-chat-v2` preset
- **交互增强**：
  - agent 通过 `ask_user_question` 提问时，问题会转发到 QQ，回复即自动应答
  - agent 请求工具审批时，转发到 QQ，回复「通过」/「拒绝」即可决策
  - 支持 DSH 斜杠命令（如 `/model`）与 `/reset`（重置会话上下文）
  - 群聊引用/回复会解析成「被引用人 + 原文」注入 DSH（如 `[引用 Derp：El Psy Kongroo是啥]机关的走狗`），让 AI 判断这句话是对谁说的，不会把群友之间引用第三方的对话误当成指向自己；引用机器人自己时会被视为必回
  - **图片/表情（含动图 GIF）**：表情包优先走 QQ 的 CDN 直链，`get_image` 失败时用 `emoji_id` 推出 CDN 地址兜底；媒体元数据保留 `emoji_id`/`summary`/`sub_type` 等字段。下载走同一套 SSRF 防护传输，并修掉了「DNS 先返回 IPv6、本机没有 IPv6 出口 → 每次白等 20 秒」的根因（改为 **IPv4 优先 + 逐地址故障切换**），动图表情不再时好时坏。单条消息上限默认 8MB / 64MP / 5 张（`socialV2.media`）
  - MCP 发送工具支持可选 `replyToMessageId`，并新增专用 `qq_reply` 工具：AI 可以先用 `qq_get_group_history` 拿到真实消息 id，再引用/回复某条消息（是否允许 AI 主动使用由人格/策略决定；桥接会检测发送类工具调用并自动跳过该回合的重复自动转发）
  - 一代仿真模式（`reserved`）下，AI 可以只输出 `[SILENT]` 表示“潜水/不接话”，桥接会静默不发送
  - 一代仿真模式（`reserved`）按空格分句：AI 用空格表示拆成多条消息；中英文/数字之间的空格也会被当成分条信号，不想分条就不要加空格（`reserved2` 不适用，分条请用 `qq_send_message` 数组）

## 前置条件

1. 运行中的 DeepSeek Harness Web（默认 `http://127.0.0.1:3080`）
2. 运行中的 SnowLuma，且配置好 OneBot WebSocket 与 HTTP API（默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，`accessToken` 视配置填写）
3. Node.js ≥ 22.13

## 安装与配置

```bash
npm install        # 安装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM 打包 bug）
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型/推理强度；若你的 DSH 没有示例中的模型，改成 DSH 设置页里可用的模型即可（选择失败只打日志，不阻塞启动） |
| `dsh.authToken` | DSH launch token（进程启动凭据）。**通常应留空**：留空时桥接用 `~/.dsh/.credentials.yaml` 里持久化的签名密钥**离线铸造**会话 Cookie，不依赖任何进程期状态（DSH 0.1.7 起启动 token 只存在于内存、日志里那条是上一个进程的陈旧值，换 Cookie 只会 401）。只有显式填了才会优先走 token 交换 |
| `dsh.authHeader` / `dsh.authPrefix` | 保留字段，当前新版 DSH 链路使用 Cookie 交换，不再直接发送该鉴权头 |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** 地址（如 `ws://127.0.0.1:3001`） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（如 `http://127.0.0.1:3000`）；不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，未配置留空 |
| `snowluma.followDiscoveredEndpoint` | 默认 `true`。换 QQ 账号后 token 与端口都会变，桥接会自愈：重新发现并**跟随** SnowLuma 的端点（同时写回 `config.json`）。**想跑第二个实例 / 指向另一份 SnowLuma 安装（多账号、测试）时设为 `false`** —— 那时只自愈 token，绝不动 URL，也不写回 URL。详见「已知行为」 |
| `snowluma.silenceWarnMs` | 上游静默告警阈值（毫秒），默认 `600000`（10 分钟）。已连接但这么久没收到任何事件包（含心跳）时打警告；这只是**提示**，不确定性的判断交给 `good` |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 安装目录（用于 token/端点自发现）。⚠️ 桥接**不会**启动或停止 SnowLuma（见 `LICENSE`） |
| `agentPreset` | QQ 会话使用的 DSH agent preset，默认 `qq-chat`（改性格见下文） |
| `socialV2.agentPreset` | `reserved2` 模式使用的 DSH agent preset，默认 `qq-chat-v2` |
| `socialV2.initialPromptMaxChars` | 会话「初始提示词」（控制台为某个群/私聊预写的环境说明）的字数上限，默认 2000，允许 100~8000。越界值会在启动时收敛并保持原文件不动 |
| `socialV2.media` | 图片/表情的上限：`maxBytes`（单条消息总字节，默认 8MB）、`maxPixels`（单张像素，默认 64MP）、`maxCount`（单条最多处理几张，默认 5）。越界值启动时收敛 |
| `webSearch.provider` | 联网搜索后端：`auto`（默认，优先 DeepSeek、失败回退 Bing）/ `deepseek`（仅 DeepSeek，无凭据时报错）/ `bing` |
| `webSearch.apiKeyEnv` / `apiKey` | 搜索凭据的环境变量名（默认 `DEEPSEEK_API_KEY`）/ 直接写死 key（不推荐）。都不设置时读 DSH 的 `$DSH_HOME/.credentials.yaml` 里同名 ref |
| `webSearch.baseURL` / `model` / `maxUses` / `maxResults` | 搜索端点（默认 `https://api.deepseek.com/anthropic/v1`，必须 https 且解析到公网）、模型（默认 `deepseek-v4-flash`）、单次搜索最多用几次工具、返回条数上限 |
| `workspaceTitle` | QQ 会话在 DSH 界面中的归组名称，默认「QQ 聊天」 |
| `allow.private` / `allow.groups` | 白名单（QQ 号/群号数组）；留空且 `allowAllWhenEmpty: true` 时放行全部 |
| `deny.*` | 黑名单，优先于白名单（也优先于自动纳入） |
| `allow.autoInclude` | 按用户名规则**自动**把来消息的人/群加进白名单（默认关）。每条规则支持 `qq`（最稳）/ `name`（昵称精确匹配）/ `namePattern`（正则）/ `kind`（`private`/`group`/`any`）/ `note`；`maxAddsPerHour`（默认 5）是一小时内最多自动纳入几个。详见下方「[按用户名规则自动纳入白名单](#按用户名规则自动纳入白名单)」 |
| `ackMessage` | 消息投递后的立即回复，空字符串关闭 |
| `sendDelayMs` | QQ 连续发送间隔，防止触发频率限制 |
| `consolePort` | 本地控制台端口，默认 `3100` |
| `consoleToken` | 控制台访问令牌；留空时启动自动生成并保存到 `state/console-token` |

> ⚠️ `allowAllWhenEmpty: true` 表示「白名单没填就全部放行」——把 agent 接入 QQ 等于把账号控制权交给了模型，建议先填白名单。

### 按用户名规则自动纳入白名单

每加一个能跟小鲸鱼说话的人都要手工改 `config.json` 很烦，所以 `allow.autoInclude` 支持**写规则、命中的人自己进来**（默认**关着**，要显式 `enabled: true`）：

```json
"allow": {
  "private": [376245695],
  "groups": [851489980],
  "autoInclude": {
    "enabled": true,
    "maxAddsPerHour": 5,
    "rules": [
      { "qq": 2998647358, "note": "小鲸鱼测试号" },
      { "name": "小鲸", "note": "按昵称——能被冒充，慎用" },
      { "namePattern": "^小鲸", "kind": "private" }
    ]
  }
}
```

省事的写法也行：`"autoInclude": [2998647358, "小鲸"]`（纯数字当 QQ 号，其余当昵称，且视为开启）。

- **什么时候触发**：收到一条**本地判定为"不在白名单里"**的私聊/群聊消息时。命中就把对方（私聊）或群号（群聊）写进 `config.json` 的 `allow.private` / `allow.groups` 并**热更新内存**——不需要重启，这条消息本身也会被正常处理；日志里会打一行 `✅ 白名单自动纳入 …`，`state/qq-activity.log` 里也有 `[allow] …` 留痕。
- **匹配口径**：`qq` 精确比号码（私聊=对方 QQ，群聊=群号）；`name` 是昵称/群名片**精确**匹配（忽略大小写与首尾空白，不做子串）；`namePattern` 是昵称正则。群聊事件里的 `sender` 是**群成员**不是群名，所以群规则只能用 `qq`。
- **三道闸，缺一不可**：
  1. **默认关** + 启动时把生效的规则与体检结果（坏正则、空规则、按昵称放行）打进日志——"规则写了却没生效"是最难查的那种问题；
  2. **`deny` 永远优先**：黑名单里的人命中规则也不会被纳入；
  3. **一小时最多 `maxAddsPerHour` 个**（默认 5），防止有人把昵称改成规则里的名字，一串小号把白名单刷爆。
- **安全提醒**：`name` / `namePattern` 放行的本质是"谁把昵称改成这个名字谁就进得来"。给别人用的号请写 `qq`——那是唯一不可冒充的字段。`closed-agent` 模式（只认主人私聊）下**不会**自动纳入，免得出现"看着授权了其实一条也进不来"。
- **回归**：`npm run test:allow-rules` —— 纯规则匹配（含坏正则/限流/黑名单优先）、`src/bridge.js` 接线、以及夹具内端到端（真跑 `handleIncoming`，断言 `config.json` 真的被改了、未命中/被拉黑/超限流的**一个字节都不动**、控制台保存白名单不会把 `autoInclude` 段抹掉）。

### DSH 端安装（必做：装 preset + 挂 MCP）

桥接和控制台能跑起来还不够，DSH 端还需要安装两个聊天 preset（`qq-chat` / `qq-chat-v2`）并挂载 MCP。**单机新装同样必须执行这一步**（不是只有「另一台设备」才需要），装完还要**重启 DSH**：

```bash
node scripts/setup-dsh.mjs
```

> 全新环境下脚本会把 DSH 默认模式设为 **`reserved2`（二代仿真）**，并创建本地 `state/mode.json` 兜底；这样 AI 使用 `qq_send_message` 等工具收发消息时，DSH 会自动使用 `qq-chat-v2` 模式。如果本机已存在旧的 `state/mode.json` 或 DSH 设置值，脚本会保留不覆盖。之后可在**桥接控制台**（默认 `http://127.0.0.1:3100`）顶部按钮切换模式，控制台会同时写入 DSH 设置与本地兜底文件。

详细步骤见 **[docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md)**。

## 完整启动流程（从零开始）

共 6 步。DSH 已安装并运行，缺的是 SnowLuma 本体 + 桥接侧的 DSH 端安装（**第 2、3 步最容易漏，漏了 QQ 上会毫无反应**）：

1. **DSH**（已运行，无需操作）
   确认 `http://127.0.0.1:3080` 能打开即可。

2. **装桥接并复制配置**
   ```bash
   git clone https://github.com/Derpyu520/qq-bridge.git
   cd qq-bridge
   npm install
   ```
   Windows CMD 用 `copy config.example.json config.json`，其他平台用 `cp config.example.json config.json`。
   **示例模板里 `allow.private` / `allow.groups` 是空数组**——空白名单 + `allowAllWhenEmpty: false` 时桥接不响应任何消息（这是刻意的 fail-closed 默认值）。白名单在第 5 步填。

3. **装 DSH 端（preset + MCP），然后重启 DSH**
   ```bash
   node scripts/setup-dsh.mjs
   ```
   装完**必须重启 DSH**——preset 与 MCP 只在 DSH 启动时加载。
   跳过这步桥接不会崩，但群聊会话拿不到 `qq-chat` preset，桥接会**拒绝建会话**（有意的安全设计：绝不回退到带 bash/文件工具的默认 preset），表现同样是 QQ 上没反应。

4. **下载并解压 SnowLuma**
   - 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest> 选 `SnowLuma-v<版本>-win-x64.zip`（完整版，自带 Node 运行时；Lite 版需本机 Node 22.13+）
   - 解压到任意目录（例如 `C:\SnowLuma`），双击 `launcher.bat`

5. **首次引导（WebUI）+ 填写桥接配置**
   - 打开启动日志里的 WebUI 地址（README 写的是 `http://localhost:5099`，以你启动日志里实际打印的为准）
   - 用**启动日志中的初始密码**登录，按引导：同意条款 → 设置密码 → 接入 QQ 进程（扫码登录）
   - 在 WebUI 里配置 OneBot 连接：开启 **WebSocket 服务端** 和 **HTTP API**，分别记下**端口**（默认 WS `3001`、HTTP `3000`）和 **accessToken**（若配置了）
   - 回到 `config.json` 填好 `snowluma` 段，并把 `allow.private` / `allow.groups` 换成**你自己的 QQ 号 / 群号**：

     ```json
     "snowluma": {
       "wsUrl": "ws://127.0.0.1:3001",
       "httpUrl": "http://127.0.0.1:3000",
       "accessToken": "你在 WebUI 里配置的 token（没配置就留空）"
     }
     ```

   `wsUrl` 是 OneBot **WebSocket** 端口，`httpUrl` 是 OneBot **HTTP API** 端口（不要填成同一个 WS 端口，否则 MCP 工具会报 HTTP 426）。

6. **启动桥接**
   ```bash
   npm start          # 前台运行（崩溃不自动重启）
   ```
   看到 `SnowLuma 已连接` 即成功；然后 QQ 上给机器人账号发条消息测试。
   Windows 想要「崩溃自动重启」请改用 `start.bat`（见下节）。

## 运行与运维

```bash
npm start          # 或双击 start.bat（守护模式：崩溃自动重启，关闭窗口即停止）
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **用 start.bat 启动**（守护模式），窗口别关——桥接崩溃会在 5 秒后自动拉起
- 桥接异常/消息无反应时：双击 `restart.bat`（自动杀旧实例 → 清理锁 → 重新启动守护）
- **重启 DSH 通常不需要动桥接**：每 5 秒探活，DSH 不可用期间收到的 QQ 消息在桥接进程内排队（最多 50 条/会话，满后丢最旧项），恢复后尝试补投。桥接进程退出会丢失内存队列；断线期间已经结束的回复暂不保证补发。
- **⚠️ 别在 DSH 的终端里起桥接**：那样桥接属于 DSH 自己的 Windows 作业对象，DSH 一重启（换端口、升级、崩溃）桥接会被连坐杀掉——表现为 DSH 可用但 QQ 完全没反应、`state/bridge.log` 停在 `⚠️ DSH 不可用（重启中？）`、`curl http://127.0.0.1:3100/health` 不通。正确做法是走计划任务（活在 DSH 之外）：`schtasks /run /tn "\qq-bridge-watchdog"`，它会按序拉起 SnowLuma → 常驻 MCP 服务 → 桥接，并自动把 `config.json` 里的 DSH 端口同步成当前端口。
- **⚠️ 看门狗的探活不许用 WMI**：这台机器上 `Get-CimInstance Win32_Process` 与 `Get-NetTCPConnection` 会**卡死**（实测 20 秒都不回，而 `Restart-Service Winmgmt` 要管理员权限、拿不到）。看门狗一旦卡进去就整段停摆——症状是「bridge / GPT-SoVITS 死了没人拉、`_keepalive.log` 停在最后一条正常记录上」，看起来像什么都没发生（2026-10-24 就是这样白停了一段，11:49 被我停掉的 TTS 服务一直没人拉回来）。现在 `qq-bridge-keepalive.ps1` 的探活只走 `netstat.exe -ano -p TCP` + `Get-Process`：bridge 用 `state/bridge.lock` 里的 PID 认、SnowLuma 用「可执行文件路径是 `$snowDir\node.exe`」认、DSH 端口按进程名 `DeepSeek Harness` 认、端口探活一律 `Test-PortListening`。给它加新探活时照这个来，回归是 `npm run test:keepalive-probes`（代码里再出现那几个 cmdlet 就直接判失败）。临时诊断也一样，别在会话里直接调 `Get-NetTCPConnection`——要知道端口通不通就 `curl.exe -s -o NUL -w "%{http_code}" --max-time 3`。
- **关机/断网期间漏掉的消息会自动补进未读**：桥接每次连上 QQ 后，会回看白名单会话最近的历史消息（`socialV2.catchUp.count` 默认 20 条、`maxAgeHours` 默认 24 小时、`graceMs` 默认 2 分钟），只补「上一个进程最后一次心跳之后」的消息，并按 `messageId` 去重；补入后会触发一次 `offlineReview` 唤醒，让 agent 把真正需要回应的补上。桥接每分钟写一次心跳（`state/last-alive.json`），所以重启/开机都不会把很久以前已经被处理过的旧消息再翻出来。
- 修改 `config.json` / `roles/` / `state/current-role.json` 后重启桥接生效；修改 `dsh/agent-presets/`（改完要跑 `node scripts/build-agent-preset-patches.mjs` 重新生成 bundle patch）或 MCP 配置后重启 DSH 生效

日志示例：

```
12:00:01 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] 新会话 private:12345678 -> sess_xxxx
12:00:02 [bridge] 已投递 private:12345678: 你好
12:00:20 [bridge] agent 回复 (private:12345678) 42 字
```

## 原生能力（不依赖角色卡）

工具怎么用属于**插件能力**，不属于人设。桥接在每次唤醒时自动往提示词里注入一段 `【原生能力】`，按 `socialV2.tools.*` 开关逐条生成：

- 发图 `qq_send_image`、找图 `qq_image_search`、看图 `qq_describe_image`、上网截图 `qq_web_screenshot` / `qq_save_image`
- 待发文件夹 `qq_list_outbox`（主人丢进去的图也在这儿挑）、转发别人发的图 `qq_save_message_image`、自己画图 `qq_draw_image`
- 表情包 `qq_send_sticker`、日记 `qq_diary_write` / `qq_diary_read`、话题 `qq_interest_record` / `qq_interest_list`
- 睡觉 `qq_night_sleep` / 睡醒问安 `qq_night_greet`、翻记录 `qq_history_search` / `qq_history_read`

因此：

- 换角色卡、用自己写的人设、甚至没有角色卡，小鲸鱼照样会发图、截图、写日记——不用再把工具说明抄进人设。
- 角色卡只写"像不像这个人"（性格、说话方式、关系），工具协议交给插件；`roles/README.md` 的「人格卡只写人设」就是这条规则。
- 关掉某个开关（如 `socialV2.tools.sendImage=false`）后，对应那条说明也不会再出现。

## 自测（不需要 SnowLuma / QQ）

离线回归（使用临时目录和模拟服务，不读取真实配置、不发 QQ 消息）：

```bash
npm run test:audit
```

reserved2 的 token 开销优化、消息水位协议、升级及回退说明（该专项分析为本地文档，未随仓库发布。）专项离线回归可运行 `npm run test:token`，已包含在上面的完整回归中。

出站发图链路（MCP 工具 → `/api/socialV2/send-image` → OneBot 段结构）的离线回归：`npm run test:send-image`。它用自定义 fetch 夹具跑真实 `bridge.js`，断言段顺序（reply → at → image → text caption）、`group_id`/`user_id`、base64 载荷逐字节一致、`recentMessages` 记账与 `sendTimes` 计费，以及鉴权失败、白名单外、非 reserved2、目录逃逸、伪图片这些拒绝路径「一条都不发」。

网页读取（`qq_read_page`）的离线回归：`npm run test:read-page`。不启动浏览器，只验纯函数：分享口令里抠 URL、导航噪音过滤、抖音真实节点形状（`detail-video-info` 里的一堆计数与发布时间、`user-info` 的粉丝数尾巴、`comment-item` 拼成「昵称：内容」）、视频链接去重、热榜页保留标题/时长，以及本机地址在启动浏览器之前就被拒。

控制台「令牌与花费」看板的账本与价目表回归（峰谷分时、幂等折叠、基线合并、压缩与容错）：

```bash
npm run test:tokens        # 单元测试
npm run test:console-ui    # 离线浏览器回归（含看板渲染与逐轮下钻）
```

本轮审查与修复明细为本地审计文档，未随仓库发布。升级后会为没有权限元数据的历史映射重建一次 QQ 会话；模式或 preset 变化也会自动重建，避免保留旧权限。旧历史仍在 DSH 中。

验证 DSH 侧链路是否打通（会创建一个独立测试会话，不影响现有会话）：

```bash
npm run self-test
```

预期输出：连接成功 → 测试会话创建 → prompt 被接受 → 打印 agent 回复。

### 能力自测（要桥接正跑着；默认只读，可选实发）

上面都是离线回归。想知道**她现在到底还能不能**到点说晚安、主动在私聊/群里说话、回复与自动回复、
自己刷抖音、发图、自己画一张发出来、发说说、看懂图、发语音、发表情包、读抖音链接 —— 用这张表：

```bash
npm run test:capabilities -- --douyin=<一条抖音链接>   # 只读：79 个回归脚本 + 逐项探测，一条 QQ 消息都不发
npm run test:capabilities -- --live                  # 额外实发：只发主人自己的私聊 + visibility=self 的说说
```

每项打 `✅ / ⏭ / ❌` 并附证据（配置值、日志行、工具返回值、正文长度）；有 ❌ 时退出码非 0。
两条硬规矩写死在脚本里：实发**只允许**到 `ownerQQ` 自己的私聊与仅自己可见的空间说说；
群发只有在白名单里存在名字带「测试」的专用群时才发 —— 家庭群绝不打扰。
`--live` 用 `state/social-v2.json` 里的会话令牌，全程不打印任何令牌。

### 最近一次实机验证（2026-10-24，真号真网关）

`npm run test:capabilities -- --live --no-tests` → **PASS 17 / FAIL 0 / SKIP 2**，原始输出存 `state/selftest-live-1035.txt`。
不是"配置对上了"，是每条都真的经过 QQ 网关或真打了外部站点：

| 能力 | 实机证据 |
| --- | --- |
| 发图片 / 生成后发出来 | `messageId=-1383012150`、`-904620467`，各 12528 字节，来源 file |
| 发说说（仅自己可见） | `{"tid":"bf0d6d167418dc6abdfc0400","time":1792809076}` |
| 发表情包 | `ok:true`，`resId` 回填 |
| 刷完分享给家里人 | `{"ok":true,"key":"private:…","sent":1,"failed":0}` |
| 读抖音链接 | 正文 1833 字，标题解析成功 |
| 看懂图（本地视觉） | `qwen2.5vl:3b` 描述出「卡通小鲸鱼表情包 + 深蓝渐变背景」 |

两项 SKIP 是脚本里写死的保护：白名单里没有名字带「测试」的群 ⇒ 群发实发跳过（家庭群不打扰）；
私聊消息本就没有 `messageId` ⇒ 引用回复不实发，链路由回归 `test-reply-wait.mjs` 覆盖。

## 环境变化与插件体检（先体检，再改代码）

DSH 升级、换安装位置、换端口、换 profile、工具面变化时，**不要先改 `bridge.js` 或守卫名单**：

```bash
npm run doctor                 # 只读体检：插件契约 / profile 接线 / 工具面 / 活 DSH
npm run doctor -- --offline    # 不连 DSH
npm run doctor -- --json       # 机器可读
```

输出里每条失败/警告都带 `→ 下一步命令` 与指南锚点；桥接启动时也会做一次轻量预检，
运行期把已知环境错误翻译成 `💡 环境适配` 日志并写入 `state/env-incidents.jsonl`。

完整场景手册（症状 → 定位 → 修复 → 验证 → 回滚）见
[docs/guides/PLUGIN_ENV_PLAYBOOK.md](docs/guides/PLUGIN_ENV_PLAYBOOK.md)。

### 给 MCP 加了新工具？先确认 3210 上的进程是新的

工具定义写在 `src/mcp-snowluma-safe.js` 里，但**真正对外提供工具的是常驻的 `src/mcp-http-host.js`（端口 3210）**。
改完代码不重启它，`tools/list` 还是旧的 —— 2026-10-25 就踩过：`qq_memory_search` / `qq_knowledge_add` /
`qq_knowledge_search` 已经上线、提示词都在教小鲸用，3210 却还是前一天起的进程，模型那边根本没有这三件，
她只能把工具名当文字写出来（日志里看着像「说了没做」）。

```powershell
# 1) 看现在挂着哪些工具（snowluma 端应为 63 件，host 1 件，websearch 2 件）
#    必须同时带 accept: application/json, text/event-stream 和 x-mcp-token
# 2) 确认进程太旧就重启它（别在本会话的后台作业里直接 Start-Process，作业被 kill 会带走子进程树）
Stop-Process -Id (netstat -ano | Select-String ':3210 .*LISTENING' | ForEach-Object { ($_ -split '\s+')[-1] }) -Force
schtasks /run /tn "\qq-bridge-watchdog"     # 看门狗发现 3210 没在听，会自己 Start-McpHttpHost
```

`5a6c68a` 起，直连引擎**每轮开跑前都会重新拉一次工具目录**（失败就沿用上一份），所以 3210 换了新工具
不用再重启桥接；但如果桥接进程本身起在这笔修复之前，它手里的目录仍是旧快照，那还是得重启一次桥接。

## 目录结构

```
qq-bridge/
  config.example.json   # 配置模板（脱敏占位符；真实 config.json 不入库）
  README.md / README.en.md / RULES.md   # 根目录只留这三个文档，其余全在 docs/
  docs/
    README.md           # 文档索引（每篇一句话 + 是否仍然有效）
    FOLDER_MAP.md       # 目录结构与 scripts/ 命名约定
    guides/             # 面向使用者/运维：PROJECT_GUIDE / DSH_SETUP / VOICE / TOKEN_USAGE_CONSOLE / CONSOLE-UI-TESTING / PLUGIN_ENV_PLAYBOOK
    design/             # 设计与规划：GEN2_SIMULATION_PLAN / SOCIAL_MODE_PLAN / DSH_QQ_TOOLS_PLAN / 真人语感策略
    research/           # 调研：SnowLuma功能调研 / QQ消息免打扰 / 表情包能力 / 本地模型选型
    audits/             # 审查与优化报告（体检、控制台、token）
    legacy/             # 历史归档（已被取代或问题已全部修复的旧报告）
  audio/                # 语音库：把准备好的音频放这里，可作 QQ 语音发出（用法见 docs/README.md 文档索引）
  dsh/agent-presets/    # qq-chat / qq-chat-v2 的 DSH agent preset 模板
  plugins/qq-mode-console  # DSH 插件：qq-mode 设置命名空间（仅 host 半，UI 卡片未实现）
  plugins/qq-agent-presets # DSH bundle：qq-chat / qq-chat-v2 preset + 工具守卫 + cwd 提示词变量
  src/
    bridge.js           # 主程序
    dsh-client.js       # Node 版 DSH API 客户端（WS 下行）
    md-to-plain.js      # Markdown → QQ 纯文本
    self-test.js        # DSH 侧自测
    qqb/                # 桥接内部模块：tts.mjs（SAPI 合成 + 引擎分发）/ tts-gptsovits.mjs（GPT-SoVITS 适配层）/ memory-log.mjs（长期记忆流水）…
  scripts/              # 测试/运维脚本（含 postinstall 的 patch-snowluma-sdk.mjs）
    patch-snowluma-sdk.mjs  # 修补 SDK 的 ESM 打包 bug（postinstall 自动执行）
  state/                # 运行时数据（不入库；qq-activity.log / qq-memory.log / history / sessions.json …）
```

> 🎤 **独立的「发语音」工具不在这里**：它是仓库上一级的 [`../voice-tool/`](../voice-tool/)（`voice-cli.mjs` /
> `voice-gui.mjs` / `public/voice.html` / `发语音.cmd`）。图形界面双击上一级的「发语音-图形界面.cmd」。
> 它只依赖 SnowLuma，共享内核仍由本仓库 `src/voice-core.js` / `src/snowluma-conn.js` 提供（单一实现）。
>
> ```bash
> cd ../voice-tool
> node voice-cli.mjs status     # 账号/token 自动发现 + 连通性
> node voice-cli.mjs list       # 可发的群聊/私聊 + 语音库
> node voice-cli.mjs            # 交互菜单
> node voice-gui.mjs            # 图形界面（本地小服务 + 浏览器 UI）
> ```

## SnowLuma 版本与上游健康（「连上了但收不到消息」）

「注入」在这个技术栈里只发生在一处：**SnowLuma 用原生组件挂进 QQ 客户端进程**（它自己日志里叫
`[Hook]`，载体是安装目录的 `native/snowluma-win32-x64.{dll,node}`）。**本桥接没有任何原生/注入面**
（依赖全为纯 JS，源码里没有 `.dll` / `.node` / FFI / 进程注入），也不启动、不控制 SnowLuma 或 QQ ——
所以「QQ 注入失败」不可能是本桥接造成的。但**桥接过去无法把这个失败讲清楚**，于是它经常被误报成
「qq-bridge 的问题」。现在桥接会主动把上游健康报出来。

### 已知行为：连上了 ≠ 收得到

SnowLuma 的 `[Hook]` 会退化：它的进程和 OneBot WebSocket **都还活着**，但收不到 QQ 侧的数据。
它自己的日志长这样：

```
WARN [Hook] receive path stale: PID=… UIN=… silentFor=136193ms; reporting good=false
WARN [Hook] process enumeration timed out after 4000ms (worker abandoned)
```

这时桥接这边**一切正常**：WebSocket 通、日志打过 `SnowLuma 已连接`、控制台没有异常，但群里一条消息都不来。
桥接现在对此做两件事：

1. **主信号**：每 30 秒一次的 `meta_event/heartbeat` 载荷里的 `status.good`（SnowLuma 对「QQ → 原生 hook → 我」这条**接收链路**的自评，静默约 105 秒后翻 `false`）。心跳是 SnowLuma 自己的定时器无条件发的，所以这条信号免费且及时，且不需要较新的运行时。
   兜底：每 60 秒问一次 `get_status`（`{online, good}`）。加分项：`bot_status`（账号会话上下线，**SnowLuma 1.14.20 起有，2.x 线同样有**：本机 2.0.3 / 2.1.1 的 `index.mjs` 里都是 3 处）+「距最近一个事件包的时长」（只能证明进程/WS 还活着，**不能**证明收得到 QQ 数据 —— 心跳会一直来）。
   > ⚠️ **不要用 `get_login_info` 取 `good`**：它只返回 `{user_id, nickname}`，而 SDK 不校验 data 载荷 ⇒ 不会报错、`good` 永远是 `null`、这条判断变成永不触发的死代码。（本功能的第一版实现正是这么写错的，回归里已加反面断言钉住。）
2. 判定退化时：日志打**明确指向 SnowLuma `[Hook]`** 的警告、控制台「运行总览」出现 `SnowLuma 上游` 卡片、
   「访问与安全」页出现告警条，`GET /api/status` 的 `snowluma` 字段给出 `degraded` / `good` / `hint`。

排查顺序：控制台看 `SnowLuma 上游` 卡片 → 看 SnowLuma 的 `logs/snowluma-*.log` 里的 `[Hook]` 行 → 再考虑升级 SnowLuma（**升级换不换原生组件要看版本线，见下**）。

### 版本要求

| 组件 | 要求 | 说明 |
| --- | --- | --- |
| SnowLuma **运行时**（QQ 网关本体） | **2.1.1 已实测**（2026-10-24）；2.0.3 是此前的长期运行版本；1.14.9 / 1.14.20 是历史记录 | **实测记录（2026-10-24，SnowLuma 2.0.3 → 2.1.1 + QQ 在线）**：`get_version_info` = `2.1.1-node`、`protocol_version` 仍 **v11**（桥接依赖的 OneBot 契约没变）；升级只替换官方清单里的 9 个运行时条目，`config/`、`data/`（消息库/记忆库）、QQ 登录态**一律保留**（重启后立刻 `[Hook] login detected` + `pipe connected`，**无需重新扫码**）；桥接用到的 **29 个 OneBot action 名在两版里出现次数完全一致，没有丢失**；心跳仍是 `meta_event/heartbeat` + `status:{online,good}` + `interval:30000`；两个适配器的 `reportSelfMessage:false` 仍被尊重 —— **自发消息不会推给桥接**（隔离实测：直接调网关 `send_private_msg`，25 秒内桥接活动日志与 bridge.log 零新增。这条很重要：私聊 `message_sent` 的 `user_id` 是对方、`self_id` 是自己，桥接现有守卫拦不住）。 ⚠️ **旧的「升级不换原生组件」只对 1.14.x 那条线成立**：1.14.9 与 1.14.20 逐字节相同，但 **2.0.3 → 2.1.1 的 `native/snowluma-win32-x64.dll` 变了**（387584 → 414208 B，正是注入 QQ 的 hook DLL；其余原生件 `snowluma-win32-x64.node`、`websocket-win32-x64.node`、`ffmpegAddon.win32.x64.node`、`sqlite/prebuilds/win32-x64/@appthreat+sqlite3.node` 与 `sqlite/*` 均逐字节相同）。已注入 QQ 内存的旧 hook DLL 与新 addon 通信正常；想让新 hook 生效要等 QQ 下次登录/重启。v2.1.0 的功能面（客户端私聊消息上报、自消息去重、WebUI 可选 MaiBot 外观等）见官方 release notes。**升级 SnowLuma 是使用者自己的事**：本桥接只探测、不部署（见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)）；本机这次的完整步骤、校验与回滚办法记在仓库外的 `../SnowLuma升级记录.md` |
| SnowLuma 自带的 `node.exe` | **v2.1.1 起要求 `^24.22.1 \|\| >=26.12.1`** | 官方**在线更新永远不会替换 `node.exe`**（它不是运行时条目：`isRuntimeEntry` 只放行那 9 项固定条目与 `^[\w-]+\.mjs(\.map)?$`），所以运行时一抬 Node 下限就得手动换。本机自带的 v24.21.0 与系统 node v24.15.0 都跑不动 2.1.1（新版 `check-node-version.cjs` 直接 `error: SnowLuma requires Node.js ^24.22.1 || >=26.12.1; found …` + exit 1），已换成官方 **v24.22.1**（sha256 `d702daa8…e240e5`）。升级前先看新版 `package.json` 的 `engines.node` |
| `@snowluma/sdk` / `@snowluma/mcp`（本仓库依赖） | 已钉 `^1.14.20` | 客户端库；OneBot v11 是稳定契约，新库可连旧运行时（本项目实测：库 1.14.20 + 运行时 1.14.9 可正常收发），**库 1.14.20 + 运行时 2.1.1 亦实测正常** |
| `bot_status`（账号上下线） | **1.14.20 起有；1.14.9 没有**（2.x 线同样有） | 逐一核对的只有这两个 1.x 版本：`bot_status` 在 1.14.9 的 `index.mjs` 里出现 **0** 次、1.14.20 里 **3** 次（带 `sub_type`/`user_id`）；本机 2.0.3 与 2.1.1 也都是 3 次。桥接对老运行时**优雅降级**：订阅不到就只靠心跳 `good` 与 `get_status` |

### 已知行为：HTTP token 与 WS token 是**两个不同的值**

SnowLuma 同一个账号的 **HTTP token（默认 3000 端口）与 WebSocket token（默认 3001 端口）并不相同**
（实测；`snowluma.accessToken` 里通常只能存一个 —— 存的是 HTTP 那个）。因此：

- **桥接每次启动的首次 WS 连接几乎必然失败一次**（日志里 `SnowLuma 连接断开（code=1006）` →
  `SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）`），随后自愈重新发现 WS token、
  重连成功，才打出 `SnowLuma 已连接`。**这条序列是正常的，不是故障。**
- 真正会一直连不上的情况：**自愈无从下手** —— `snowluma.homeDir` 没配 / 被移动 / 读不到
  SnowLuma 的 `config/onebot_<QQ号>.json`，或权限不足。这时日志里会有 `token 自愈失败`，
  而 QQ 侧表现为**完全收不到消息**。先确认 `homeDir` 指向真正的 SnowLuma 安装目录。
- **写脚本时别再踩这个坑**：任何要连 WS 的脚本都应该走 `src/snowluma-conn.js` 的
  `discoverSnowLumaConnection()` —— HTTP token 探活成功后，它会把**同一账号**的 `wsToken` / `wsUrl`
  一并返回。`scripts/check-onebot-status.mjs` 原先直接拿 `config.json` 里的（HTTP）token 去连 3001，
  于是**必然**打印 `SnowLuma WebSocket closed before opening`，失败路径里的 `process.exit` 还会在
  Windows 上踩出 libuv 断言（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`）；2026-10-24 已改成自发现 + 收尾等待。

### 已知行为：端点自愈会覆盖你写的 `wsUrl`

换 QQ 账号后 OneBot 端口与 token 都会变，所以桥接在连不上时会自愈：重新发现 SnowLuma 的端点并
**写回 `config.json`**。这在主场景下是对的，但它不区分「配置里是个过期值」和「你就是要指向别处」——
想跑第二个实例或指向另一份 SnowLuma 安装时会连错账号。要关掉：

```json
"snowluma": { "followDiscoveredEndpoint": false }
```

关掉后**只自愈 token**（换账号仍能恢复），绝不动 URL、也不写回 URL。

## 识图（本地轻量视觉模型，可选）

聊天模型本身不一定是多模态的；qq-bridge 自带一个本地识图工具 `qq_describe_image`：先把图片交给你电脑上的轻量视觉模型（Ollama）转成中文描述（画面内容 + 逐字 OCR + 表情包含义），再喂给聊天模型。**图片不出本机**，不需要云 API。

1. 安装 [Ollama](https://ollama.com/download)（安装后托盘常驻，默认监听 `127.0.0.1:11434`）。
2. 下载视觉模型（默认 `qwen2.5vl:3b` 约 3 GB，显存 4 GB 以上更流畅；纯英文 OCR 可用 `qwen2.5vl:3b`，中英混排/截图/表格可换 `qwen3-vl:2b` 或 `minicpm-v:8b`）：
   ```bash
   ollama pull qwen2.5vl:3b
   ```
3. `config.json` 里确认（缺省即可用）：
   ```json
   "vision": {
     "enabled": true,
     "baseUrl": "http://127.0.0.1:11434",
     "model": "qwen2.5vl:3b",
     "timeoutMs": 120000,
     "maxImages": 3,
     "maxUrlBytes": 16777216,
     "maxSide": 1280,
     "numPredict": 2048,
     "repeatPenalty": 1.15,
     "retries": 1
   }
   ```
   后面几项是稳定性参数：`maxSide` 会先把长边超限的图片缩到 1280 再送模型（Ollama 的 qwen2.5vl 拿到长边 >1280 的图会以 `prediction aborted, token repeat limit reached` 中断，手机照片普遍 1440+，所以必须缩）；`numPredict` / `repeatPenalty` 限制输出长度并加重重复惩罚；命中复读中断时按 `retries` 自动重试一次（换 seed、缩短输出）。
4. 改完重启 bridge（`restart.bat`）。MCP 工具列表会自动出现 `qq_describe_image`。

用法：`qq_describe_image` 支持 `key + messageId`（看某条 QQ 消息里的图）或 `url`（看一个 http 图片地址），`mode` 选 `describe`（内容描述，默认）/ `ocr`（只逐字转文字）/ `both`，`focus` 可加关注点（例如「他手里拿的是什么」「这段代码哪行报错」）。只给 `messageId` 不给 `key`/`token` 时，工具会按消息归属自动补全会话与令牌（`qq_get_message_images` 同理），省掉一整轮「缺参数」的往返。

建议：**文字多的截图用 `mode:"both"`**；表情包用 `describe`；纯文字转录用 `ocr`。模型越小越快、越大越准；16 GB 内存机器建议保持 `3b` 级。

## 发图（qq_send_image）

AI 也能主动发图（照片、截图、表情图、自己生成的图）。默认开启，开关是 `socialV2.tools.sendImage`（设为 `false` 即可禁用）。

图片三选一（`image` 参数）：

| 传法 | 例子 | 说明 |
| --- | --- | --- |
| http(s) 地址 | `https://…/a.jpg` | 由桥接下载（DNS 固定 + 逐跳校验 + 大小限制），不把 URL 交给网关重新抓 |
| base64 数据 | `base64://iVBORw0…` 或 `data:image/png;base64,…` | 适合模型自己画的小图；上限 6MB |
| 本地文件 | `a.png`（相对 `state/outbox/`） | **只允许 `state/outbox/` 目录内的图片**；绝对路径/`..`/`file://` 一律拒绝 |

想转发某条消息里的图：**别去猜 QQ 的图片链接**（CDN 链接带时效、缺参数就下载失败），先调 `qq_save_message_image`（`key?`/`messageId`/`token?`/`name?`）把消息里的图存成 `state/outbox/` 里的文件，再用文件名发给 `qq_send_image`。

可选参数：`caption`（同一气泡里跟一句话，最多 500 字）、`replyToMessageId`（引用）、`atUserId`（群聊 @）。单张图上限跟随 `socialV2.media.maxBytes`（默认 8MB），格式支持 png/jpg/gif/webp/bmp，发送前会校验文件头，非图片内容直接拒绝。

发送同样走「发送频率上限 + 发送审计 + 模拟真人停顿（1.2~2.6 秒）」，并计入该会话的 `sendTimes`；消息也会写进二代会话的 `recentMessages`，AI 自己知道刚发过什么图。

```json
// 一次典型调用（MCP 参数）
{ "key": "private:123456", "token": "会话令牌", "image": "state/outbox/chart.png", "caption": "看图，今天的数据" }
```

## 发语音（qq_send_voice / qq_list_voices，含本机 TTS）

AI 也能发语音条。**出厂默认关**（`config.example.json` 里 `socialV2.voice.enabled` 与 `socialV2.tools.sendVoice` 都是 `false`），把这两个开关打开之后才可用。发语音属于敏感动作，所以还受人员梯队约束（只对第一梯队和本群群主开放，见「人员梯队与敏感动作权限」）。

想让她**唱歌**是另一个开关（`socialV2.tools.sing`，默认也关）：那会走 ACE-Step + Seed-VC，单次 1~3 分钟，见「唱她自己的歌」。

两种用法（`text` 与 `voice` **二选一**，同时给会被直接拒掉）：

| 用法 | 传什么 | 说明 |
| --- | --- | --- |
| 当场合成 | `text: "晚安，早点睡"` | 用**本机 Windows 自带的声音**合成一条，落在 `audio/`，再走同一条发送链路 |
| 发库里现成的 | `voice: "tts-sample-….wav"` | 只能发语音库（`socialV2.voice.dir`，默认 `audio/`）里的文件；先 `qq_list_voices` 看有什么 |

`text` 通道**不需要 ffmpeg**：转 SILK 是网关（SnowLuma）自己做的，桥接只把 wav 路径交给它（`{type:'record'}`）。本机没有 `ffprobe` 也不影响发送，只是跳过时长校验（会留一条警告）。

**ffmpeg / ffprobe 的定位**（2026-10-24 修）：`socialV2.voice.ffmpegPath` / `ffprobePath`（或环境变量 `FFMPEG_PATH` / `FFPROBE_PATH`）显式指出位置；**只写 ffmpegPath 就够**——ffprobe 会去 ffmpeg 的同目录里找（官方 zip 里两个永远在一起，本机用的就是 GPT-SoVITS 自带那份，没加进 PATH）。找不到才回退裸名交给 PATH。回归：`npm run test:voice-probe`。
之前这里有过一个**静默**缺陷：`probeAudio` 给 ffprobe 传了 `-o outFile`（那是 ffmpeg 的参数，ffprobe 没有），于是每次都退出码 1、一个字节都不产出，时长校验被悄悄跳过——日志里只有一行「无法探测时长」。现在改成把 ffprobe 的 stdout 直接绑到文件句柄上（不经过 pipe，受限沙箱里也能跑）。

### 本机 TTS 是怎么发声的

用 Windows 自带的语音合成（先试 SAPI5，找不到就退回 OneCore），**不下载模型、不联网、零依赖**：

```bash
npm run voice:tts                  # 列出本机可用的声音（★ 是常见中文声音）
npm run voice:tts "你好呀"          # 合成一条到 audio/，先自己听一下效果
npm run voice:tts "你好呀" Kangkang  # 指定音色
```

配置在 `socialV2.voice.tts`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 只关「本机合成」，不影响发库里现成的语音 |
| `voice` | `""` | 音色名（空 = 自动挑中文声音）；名字不存在时**直接报错**，不拿别的声音冒充 |
| `rate` | `0` | 语速 -10~10 |
| `maxChars` | `200` | 一次合成的字数上限；超了报错并说清字数（不偷偷截断） |
| `timeoutMs` | `30000` | 单次合成超时 |
| `keepFiles` | `20` | 语音库里最多留几个自己生成的 `tts-*.wav`，多的按时间从旧到新清 |

安全边界：

- **只发语音库里的文件**：AI 通道不接受绝对路径、`file://`、base64（`allowAbsolutePath` 也放宽不了 AI 通道）；
- 要合成的文字走**临时 UTF-8 文本文件**，PowerShell 命令行里只有路径和数字 —— 消息内容注不进命令；
- 清理只删**自己生成的 `tts-*.wav`**，你手动放进 `audio/` 的文件一律不碰；
- 合成发生在**梯队门禁与静默检查之后**：陌生人求语音既不会发，也不会让机器白烧一次合成；
- 发语音有独立限流（`maxPerMinute` / `maxPerHour`），失败不占额度。

```bash
npm run test:voice-tts   # 真合成一条 + 端点 text 通道（开关 / 字数上限 / 清理安全 / 二选一 / 门禁在合成前）
```

已知边界：出厂这条用的是**系统 TTS 的音质**（只支持 Windows）。想换成自己的声音见下一节 —— 对上层接口不变：都只是往 `audio/` 里放一个 wav 而已。

### 真人音色（GPT-SoVITS，可选）

出厂那条是「微软的机器音」。想让她用**指定的一段声音**说话，接的是本机 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（零样本声音克隆）。

为什么是「本机服务 + HTTP」而不是把模型塞进 node：GPT-SoVITS 是 Python + torch + 显卡的活（推理几秒、首次加载模型几十秒），node 侧只该把文字递过去、把 wav 拿回来。所以 `src/qqb/tts-gptsovits.mjs` 是个**薄适配层**：调它自带的 `api_v2.py`（默认 `127.0.0.1:9880`）的 `POST /tts`。

**三步装上**（以本机为例，安装目录 `_gptsovits/`；HF 在国内不可达，模型走 ModelScope）：

```powershell
# 1. 环境（本机用 uv 装 Python 3.10；系统里没有 python/pip/conda，uv 是唯一的入口）
uv python install 3.10
uv venv --python 3.10 D:\…\_gptsovits\env
uv pip install --python D:\…\_gptsovits\env\Scripts\python.exe torch torchaudio --index-url https://download.pytorch.org/whl/cu126
#   本机实测：torch 2.14.1+cu126 / torchaudio 2.11.0+cu126 / torch.cuda.is_available() = True
#   注意 uv 建的 venv 里没有 pip，所以全程用 `uv pip install --python <venv 的 python>`。

# requirements 要先动三处，否则 Windows 上装不完（那三个包只有源码包，编译要 MSVC/cmake，这台机器没有）：
#   * 删掉首行 `--no-binary=opencc`（1.4.2 有 Windows 轮子，只有源码编译才需要 MSVC）
#   * 删掉 `jieba_fast`（PyPI 上没有 Windows 轮子）——
#     改用 scripts/gptsovits-shims/jieba_fast 那个同名壳转发到纯 Python 的 jieba
#   * 删掉 `pyopenjtalk`（源码编译要 cmake+nmake+MSVC）——改用预编译轮子：
#     uv pip install --python <venv 的 python> pyopenjtalk-prebuilt --no-deps
#     （它自己钉 numpy==2.2.6，但 GPT-SoVITS 要 numpy<2；实测 numpy 1.26.4 下 ABI 正常）
#   另：`av` 的源码包下载慢，默认 30 秒会 timeout，先抬高 uv 的下载超时。
$env:UV_HTTP_TIMEOUT = '900'
uv pip install --python D:\…\_gptsovits\env\Scripts\python.exe -r requirements-filtered.txt
uv pip install --python D:\…\_gptsovits\env\Scripts\python.exe resampy    # 上游漏写的依赖
uv pip install --python D:\…\_gptsovits\env\Scripts\python.exe torchcodec --index-url https://download.pytorch.org/whl/cu126
#   torchaudio 2.11 起把音频读写全部转交 torchcodec（`backend` 参数会被忽略），所以必须装它；
#   而 libtorchcodec 还要求在 PATH 上找到 FFmpeg 的 avcodec/avformat 等 DLL（见下一步）。

# 1b. FFmpeg 共享库（给 torchcodec 找 DLL 用；GitHub 直连不通就套 gh-proxy）
curl.exe -L -o D:\…\_gptsovits\ffmpeg-shared.zip "https://gh-proxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip"
#   解压到 D:\…\_gptsovits\ffmpeg\ 下即可：`npm run gptsovits:serve` 会自动把
#   <安装目录>\ffmpeg\*\bin 前置到 PATH（找不到就打一行警告，不影响 SAPI 那条路）。

# 2. 预训练权重（ModelScope，zip 4.3 GB / 解开 4.6 GB）→ 解到 GPT_SoVITS/pretrained_models/
curl.exe -L -o pretrained_models.zip "https://www.modelscope.cn/models/XXXXRT/GPT-SoVITS-Pretrained/resolve/master/pretrained_models.zip"

# 3. 起服务（要显卡常驻；跑哪一版模型由 tts_infer.yaml 的 custom 段决定，默认 v2）
npm run gptsovits:serve
#   等价于 `python api_v2.py -a 127.0.0.1 -p 9880`，只多两件事：把 jieba_fast 壳挂进
#   PYTHONPATH，并写一份 site-packages/_gptsovits_shims.pth（这样手动起服务也认得壳）。
```

探活（不用等模型加载完）：

```powershell
curl.exe -s http://127.0.0.1:9880/control   # 回 {"message":"command is required"} 就是活着（400，正常）
```

**然后配两处**（`socialV2.voice.tts`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `engine` | `sapi` | `sapi` = Windows 自带声音；`gptsovits` = 走 GPT-SoVITS |
| `gptsovits.baseUrl` | `http://127.0.0.1:9880` | 服务地址（`api_v2.py` 的绑定） |
| `gptsovits.refAudio` | `""` | **参考音频**，相对路径按仓库根解析（如 `audio/ref/小鲸鱼.wav`）；3~10 秒干净人声最好 |
| `gptsovits.refText` | `""` | 参考音频的**逐字文本**（必须一致：它决定了音素对齐） |
| `gptsovits.textLang` / `promptLang` | `zh` / `zh` | 可用 `zh/en/ja/ko/yue/auto` |
| `gptsovits.splitMethod` | `cut5` | 长句切分法（`api_v2.py` 的 `text_split_method`） |
| `gptsovits.speedFactor` | `1` | 语速倍数 |
| `gptsovits.topK` / `topP` / `temperature` / `repetitionPenalty` | `15` / `1` / `1` / `1.35` | 采样参数，默认值就是上游默认值 |
| `gptsovits.timeoutMs` | `120000` | **首次调用要加载模型**，所以比 SAPI 那条（`tts.timeoutMs`）长得多 |
| `gptsovits.fallback` | `true` | 服务不可用时**回落**到 SAPI（那时返回值与日志都会带回落原因） |

体检与回归：

```bash
npm run check:gptsovits          # 只读体检：环境/权重/配置/服务探活 + 合成一句到 audio/
npm run check:gptsovits -- --no-synth
npm run test:voice-gptsovits     # 离线回归：不碰真模型（本机 http 桩冒充服务）+ 桥接接线
npm run test:voice-tts           # 第一步的 SAPI 回归，仍然要过
```

设计取舍（都在代码注释里写明了）：

- **回落而不是硬失败**：语音链路不能因为「音色引擎没就绪」整条挂掉，所以 `engine:'gptsovits'` 失败时默认退回 SAPI，并把原因浮到日志（`[voice] … 回落 sapi5（原因：…）`）与 `qq_send_voice` 的返回值；想「不是真人音色就不发」就把 `fallback` 设 `false`（那时抛错）。
- **不要求本机有 SAPI 声音**：走 GPT-SoVITS 时 SAPI 只是可选的保底，所以那里不再强制 `ttsAvailable()`。
- **返回包要验真**：HTTP 200 也可能是一段 JSON 错误，所以校验开头是 `RIFF/OggS/fLaC/ID3` 才落盘（假音频绝不进语音库）。
- **安全同前**：要合成的文字走 HTTP body（不拼命令行）；只发语音库里的文件；合成发生在梯队门禁与静默检查之后。

本机实测（2026-10-24，RTX 4060 Laptop 8G）：首次合成（服务刚起来、要加载模型）107.6 秒，**热态 2.2 秒**；产物 32 kHz 单声道 16 bit wav，5.16 秒/330 KB。已用这条链路真发过一条 QQ 语音（走 `scripts/send-voice.mjs`，网关回读确认是 `record` 段）。

### 换音色：借一个干净的嗓子（Edge TTS 参考 + 试听）

GPT-SoVITS 是**零样本克隆**：音色不靠训练，完全由 `socialV2.voice.gptsovits` 里的 `refAudio`（参考音频）+ `refText`（参考文本）决定。所以换音色 = 换一对参考文件，不用重训模型。

机器自带的 SAPI 参考（`audio/ref/sapi-ref.wav`）本身就是合成音，克隆出来还是机器味。用 Edge TTS 的自然女声当参考，等于借一个干净的嗓子：

```powershell
# 1) 造参考音频（需要 edge-tts：uv pip install --python _gptsovits/env/Scripts/python.exe edge-tts）
python scripts/make-ref-voice.py --list                       # 看看有哪些中文音色
python scripts/make-ref-voice.py --voice zh-CN-XiaoyiNeural --out audio/ref/edge-xiaoyi.wav

# 2) 同一句台词，用每个候选各合成一遍（产物在 audio/audition-<名字>.wav）
node scripts/voice-audition.mjs
node scripts/voice-audition.mjs --text "自定义台词"

# 3) 选定后切换（同时写 refAudio + refText，其余配置不动）
node scripts/voice-audition.mjs --set audio/ref/edge-xiaoyi.wav --ref-text "主人，我是小鲸鱼。……"
```

- `refText` **必须和参考音频逐字一致**（GPT-SoVITS 靠它对齐音素）；`make-ref-voice.py` 的默认文本与 `config.json` 的 `refText` 是同一句，改文本就要两边一起改。
- 桥接每次发语音都会重新读配置，切换后**不用重启**；音色服务按 `tts_infer.yaml` 加载权重，与参考音频无关。
  > 2026-10-25 修正：这句在**直连引擎**上不成立。`voiceCfg()`（`src\bridge.js:2474`）读的是 main() 里那份内存里的 `cfg`，而 `cfg = loadConfig()` 全文件只有启动时那一次（`:2317`）——所以改了 `refAudio` / `refText` **必须重启桥接**才生效。重启别在 DSH 的后台作业里起（作业一旦被 kill 会连坐杀掉它启动的 bridge，症状是「日志停在某一行、端口 3100 没人听」）：先 `Stop-Process -Id <state\bridge.lock 里的 PID> -Force`，再 `schtasks /run /tn "\qq-bridge-watchdog"`（看门狗发现锁里的 PID 不在、端口没起，就会自己拉一个新的）。
- 参考音频规格统一 32 kHz / 16 bit / 单声道（脚本里用 ffmpeg 转）。
- 试听产物想直接发到 QQ：`node scripts/send-voice.mjs send audio/audition-edge-xiaoyi.wav private:<QQ号>`（注意 `socialV2.voice.maxPerMinute` 限流）。
- 2026-10-24 已真机发出三个候选（xiaoyi / xiaoxiao / xiaobei，messageId 分别为 -1081032749 / 504873378 / -491824197），等主人挑一个再切默认。
- 回归：`npm run test:voice-audition`（离线，用临时配置验证 `--set` 只改这两个键、出错不写盘、参考音频规格）。

**服务由看门狗保活（2026-10-24 起）**：`scripts/gptsovits-serve.ps1` 现在由 `qq-bridge-keepalive.ps1`（计划任务 `\qq-bridge-watchdog`）托管 —— 只有当 `socialV2.voice.tts.engine` 是 `gptsovits` 且没被 `gptsovits.enabled:false` 关掉时才会拉起，端口取自 `gptsovits.baseUrl`，探活用 `curl --max-time 3 …/control`（收到 400 就算活），两次拉起之间留 180 秒给首次加载模型。
在此之前它是手工 `Start-Process` 起的，属于 DSH 的作业对象，**DSH 一重启（换端口/升级）就跟着消失**，症状是「语音还能正常发，但全是机器音」——因为 `fallback:true` 会静默回落 SAPI。现在 DSH 重启不再牵连它。同理：**别在 DSH 的终端里起桥接或这个 TTS 服务**，要重启就跑 `schtasks /run /tn "\qq-bridge-watchdog"`（见「运行与运维」）。
注：`qq-bridge-keepalive.ps1` 与 `.vbs` 在本仓库根目录之外（`qq-bridge` 的上一级），不随仓库发布，只随本机维护。

已知限制：只支持 Windows 上的**同机服务**（参考音频路径是交给本机 Python 读的，所以必须是本机绝对路径）；显卡常驻（本机 RTX 4060 8G 够用，但服务起来后会占显存）；参考音频与逐字文本必须配对，否则音色会跑偏。

### 音色微调：在原声附近小改（`voice:tune`）

「不好听，回到原来那版附近，只小调」这类需求**不是**换音色，别去换参考、更别重训。能小幅动的就三个旋钮：**参考音频变调**、**参考音频轻 EQ**、合成参数（`speedFactor` / `temperature` / `topK`）。前两个由脚本扫参，第三个沿用 `config.json` 里现有的值：

```powershell
# 每个音高各出一条试听句：原样、降 1、降 2，并顺带各加一条「轻 EQ」版
node scripts/voice-tune.mjs --ref audio/ref/dyf-7s-soft.wav --pitch 0,-1,-2 --warm

# 只试一版、换一句台词
node scripts/voice-tune.mjs --ref audio/ref/dyf-7s-soft.wav --pitch -2 --text "换一句话试试"
```

产物落在 `audio/tune/`（`audio/` 已被 `.gitignore` 忽略）：

- `ref-m2.wav` / `ref-m2-warm.wav`：变调（+轻 EQ）之后的**参考音频**；
- `probe-m2.wav` / `probe-m2-warm.wav`：用它的参考合成的**试听句**。每版用同一句话，才好横向比。

变成了之后，把 `socialV2.voice.tts.gptsovits.refAudio` 指过去即可（`refText` **不用改**：变调/EQ 不改字，逐字对齐仍在）：

```jsonc
"refAudio": "audio/ref/dyf-7s-soft-m2w.wav"   // 选中的那一版搬进 audio/ref/ 再引用
```

**变调数学**（脚本里就是这条链）：降 `n` 个半音 = 重采样比率 `2^(-n/12)`，时长会因此变长 `1/比率`，再用 `atempo` 拉回 `1/比率`：

```text
filter: asetrate=32000*0.8909, aresample=32000, atempo=1.1225
```

`比率 × atempo` 必须恒等于 1，否则出来的音频会「跑调 + 变时长」。回归里对 `-11 / -5 / -2 / 0 / 3 / 7 / 11` 逐个断言这个乘积。

**轻 EQ**（`--warm`）：`equalizer=f=200:t=q:w=1:g=2`（低中频抬 2 dB，多点胸腔感）+ `equalizer=f=4000:t=q:w=1:g=-2`（4 kHz 压 2 dB，齿音/尖利少一点）。只动音色，不动音高。

实测一例（2026-10-24，参考 `audio/ref/dyf-7s-soft.wav`，同一句台词）：

| 变体 | 中位 F0 | 频谱质心（中位） | ASR 复核 |
| --- | --- | --- | --- |
| `p0`（原样） | 413 Hz | 2061 Hz | 完整 |
| `p0-warm` | 366 Hz | 2053 Hz | 丢开头三个字 |
| `m2`（−2 半音） | 363 Hz | 1836 Hz | 完整 |
| `m2-warm`（−2 半音 + 轻 EQ） | 345 Hz | **1653 Hz** | **完整** |

选中 `m2-warm`：质心降了 400 Hz（听感更沉、更少尖利），吐字仍然完整。

两个坑：

- **别拿整首歌的 F0 当目标**。拿 `audio/sing-test.wav` 量出来中位 F0 只有 147 Hz —— 那不是人声，是伴奏的贝斯/鼓把 `pyin` 的中位数拉下去了。要量人声就取**清唱段**，或者干脆只比频谱质心、靠耳朵定。
- **降得越多不等于越好听**。降到 −3 半音时 ASR 把「主人」听成「主任」、`m1`（−1 半音）丢了开头三个字 —— 变调会同时改变共振峰，糊字是它的代价。所以每次都用 `audio/asr-check.py` 复核一遍（`funasr`，见「把她自己的声音克隆出来」那节的依赖），**先保吐字，再选音色**。

**从一段长录音里挑参考片段**（2026-10-25，`sound\小鲸.wav` → `audio/ref/xiaojing-6s.wav`）：主人直接给一段录音说「就用这个当音色」时，别整段丢给 GPT-SoVITS（它要 3~10 秒、逐字文本、干净人声），也别凭听感随手切。两步，各有一个脚本：

```powershell
# 1) 句子级转写 + 按句边界切候选（产物 audio/cand/seg-*.wav 与 sentences.json）
python scripts/pick-ref-segment.py --audio ../sound/小鲸.wav --min-seconds 4 --max-seconds 10 --clean gentle

# 2) 每个候选各合成同一句探针（台词默认固定，横向比才可比）
npm run voice:probe -- --ref audio/cand/seg-01-33p00-39p00.wav `
  --ref-text "这个可以买吗？我感觉跟我还挺像的，好像还有更大的好可爱。"
```

1. **句子级转写拿时间戳**：脚本里是 `funasr` 的 `paraformer-zh` + `fsmn-vad` + `ct-punc` 跑 `generate(input=..., sentence_timestamp=True)`，`r[0].sentence_info` 给每句 `{start, end, text}`（毫秒）。113.3 秒的录音切出 10 句、231 字。
2. **在标点边界切候选**（4~10 秒、单句或不跨句），输出 32 kHz / 单声道 / pcm_s16le。清洗链有 `--clean` 三档，**默认 `gentle`**（只 `highpass=f=70` + `afftdn=nr=6:nf=-55` 轻降噪 + 剪掉首尾静音），`off` 完全不处理（素材本身干净时首选），`legacy` 是带 `acompressor` + `alimiter` + `loudnorm` 的老链，只用来复现历史样本。
   **为什么默认不带压缩**（2026-10-25 真机教训）：主人听完三条样音说「都有杂音，感觉有回声」。压缩+限幅+响度归一会把**句子之间的底噪和房间混响尾巴一起抬起来**，GPT-SoVITS 克隆时把这些也学进去，听感就成了回声。实测 `sound\小鲸.wav`：静音段 RMS 平均 −83.7 dB，但 p90 −46.3、峰值 −37.6，句间常驻底噪约 −31 dB（说话 p90 −10.6 dB），本来就只有约 20 dB 余量 —— 再压缩一层就非常明显了。`scripts/clone-voice.py` 那条路本来就不加任何滤镜（只重采样+单声道），所以「换音色」优先走 `voice:clone`，别自己手搓滤镜链。
3. **每个候选各合成同一句探针**（`voice:probe` 的默认台词是「主人，你听，这是我的声音。你觉得这样说话好听吗？」），然后两边都量中位 F0 与频谱质心。
4. **选「探针最贴近源片段」的那版**，同时要求探针的 ASR 完整。实测：源句 33.09–38.94「这个可以买吗？我感觉跟我还挺像的，好像还有更大的好可爱。」源片段 F0 295 / 质心 1603，用它克隆出 297 / 1671 —— 差得最少；另一句「姐姐，原来你在这儿啊」音高起伏太大，克隆出来 F0 飙到 394，弃。
5. **音高偏暗/偏飘时挪参考，别通嗓**：`--pitch 1` 把切出来的候选升 1 个半音（`--pitch -1` 降）。参考的音高会原样带进克隆结果，2026-10-25 就是靠这个定的小鲸：源段 11.29–18.69s（F0 325 / 质心 780）升 1 个半音 → 343 / 813，克隆出 334 Hz，主人说「B 的方向」。**一次别超过 ±2 个半音**，降多了共振峰一起动、吐字会糊（实测 −3 半音把「主人」听成「主任」）。
   **坑**：`asetrate` 用的是*输入*的采样率，原始录音常是 44.1 kHz。直接写 `asetrate=32000*R` 会把 44.1k 的样点当 33.9k 播 → 整段变慢、音高反着掉（实测想要 +1 半音，结果 F0 294 → 226、6.55 s 变 9.0 s）。脚本里已经在前面补了 `aresample=32000` 对齐速率。

**拖长音（一句唱半天）的两个旋钮**（也在 `config.json` 的 `socialV2.voice.tts.gptsovits` 里）：`speedFactor` 提到 **1.08**、`temperature` 降到 **0.75**、`topK` 降到 **8**。实测同一句「主人，我是小鲸……」最长连续发声段从 **0.99 s 压到 0.34 s**、整句 11.3 s → 7.8 s。根子还是在参考的表演方式（撒娇拖腔会整段带进克隆），素材是正常语速陈述句时这组参数只是收个尾。

顺带一条：**先确认底噪里没有音乐**。用 `-af lowpass=f=90,volumedetect` 量静音段（`silencedetect` 找出来的位置）的低频能量，-50 dB 这种量级说明没人声伴奏；要是几十赫兹就有东西，那是贝斯/鼓，克隆出来会带一层嗡声。

回归：`npm run test:voice-tune`（离线，不碰 ffmpeg 与 TTS：只验变调数学、命名、滤镜顺序、`--pitch` 解析，以及 README / package.json 的接线）。

### 把她自己的声音克隆出来（`voice:clone`：给一段音频或视频就行）

上面那节是「借 Edge TTS 的嗓子」；这一节是「用一段真人录音」。主人随手丢一个 `.wav` / `.mp3` / `.mp4` 过来，一条命令就能切出参考片段、算出逐字文本、写进 `config.json`：

```powershell
# 只切片段，先看看切在哪、文本是什么（不动配置，最安全）
npm run voice:clone -- --audio ../sound/大肥鱼.wav --no-set

# 满意就直接切（同时改 socialV2.voice.tts.gptsovits.refAudio + refText）
npm run voice:clone -- --audio ../sound/大肥鱼.wav

# 切完用新音色合成一句试听，并立刻发到 QQ
npm run voice:clone -- --audio ../sound/大肥鱼.wav --send private:3482501440
```

| 参数 | 说明 |
| --- | --- |
| `--audio <文件>` | 必填。任意音频或**视频**（`.mp4` 直接喂，内部 `ffmpeg -vn` 丢视频轨） |
| `--no-set` | 只切片段并打印结果，不改 `config.json` |
| `--send <private:QQ号\|group:群号>` | 切完配置后合成一句试听并立刻发出去 |
| `--text "<台词>"` | 试听台词（默认「主人，你听，这是我的新声音。……」） |
| `--min-sec` / `--max-sec` | 参考片段时长窗口，默认 4 ~ 10 秒（GPT-SoVITS 最佳区间） |

它做四件事：`ffmpeg` 抽成 32kHz 单声道 → funasr（`paraformer-zh` + `fsmn-vad` + `ct-punc`）把整段转写成全文 → 在 VAD 语音段里找**最长的、正好停在断句处**的前缀切出来 → 对切出来的那一段**单独再转写一次**当 `refText`（`refText` 必须与 `refAudio` 逐字一致，所以不能直接截全文）。

**这段流程踩过的四个坑（都写进代码了，改的时候别踩回去）**

1. **funasr 的模型缓存目录写不进**。它默认往 `C:\Users\<你>\.cache\modelscope` 下，这个路径的 ACL 常常只有 `(RX)`，于是 `PermissionError [WinError 5]`，最后伪装成 `RuntimeError: model 'paraformer-zh' is not registered.`（看着像模型名写错）。`MODELSCOPE_CACHE` 环境变量对它**无效**；改法是在 `AutoModel(..., hub="hf")` 走 HuggingFace，配 `HF_ENDPOINT=https://hf-mirror.com` + `HF_HUB_CACHE` / `HF_HOME` 指到可写目录（`scripts/clone-voice.mjs` 已经默认设好，`_hf-cache`）。
2. **`refText` 里有英文词，TTS 会 HTTP 400**。`cmudict` → `averaged_perceptron_tagger_eng` 一个接一个地缺（"Resource 'cmudict' not found."）。一次装齐，装到 GPT-SoVITS 自己会搜的目录：
   ```powershell
   _gptsovits\env\Scripts\python.exe -m nltk.downloader -d D:\34825\zhuomian\youqq\_gptsovits\GPT-SoVITS-main\runtime\nltk_data cmudict averaged_perceptron_tagger_eng averaged_perceptron_tagger punkt punkt_tab
   ```
3. **「切出来的那段结尾是句号」根本不能当判据**。`ct-punc` 会给任意长度的输入补一个句号，所以切在词中间也「结尾是句号」。正确做法是回到**全文**核对：切出片段的去标点字符数，必须正好落在原文某个断句标点的位置上（`full_norm.startswith(tn)` 还能顺带防 ASR 跑偏）。
4. **连续说话的人，句号可能在时长窗口之外**。真机那段 13.87 秒里唯一的句号在 11.5 秒以后（超过 10 秒上限），窗口内只有逗号。所以逗号/顿号/冒号也算断句点，切在逗号上远好过切在词中间。

**真机证据（2026-10-24）**：`sound\大肥鱼.wav`（13.87 秒，48kHz 单声道）→ `audio/ref/dyf-7s.wav`（7.0 秒）+ `refText="网上到处都是本鱼在狂飙散装rap和讲相声。原来是有人在github上偷偷进货。"` → 合成 10.2 秒 → 已发出，`messageId=68627126`。同一段素材用 `clone-voice.mjs` 自动跑，切点是 7.2 秒、文本停在「……偷偷进货。」（自动版比手动切的多出 0.2 秒，文本同样对得上）。

注意 `config.json` 在 `.gitignore` 里（换音色属于本机私事），所以切完 `git status` 不会变脏。回归：`npm run test:voice-clone`（默认离线只查代码约定；`CLONE_VOICE_LIVE=1` 才真跑一次 funasr，约 90 秒，要 `_gptsovits/env`）。

### 唱一首歌（ACE-Step，可选）

GPT-SoVITS 是 **TTS**：它只会「说」，没有旋律的概念（`api_v2.py` 里连 sing/melody 之类的参数都没有，别指望它唱）。要唱歌得另上一个会写音乐 + 唱词的模型，本机用的是 **ACE-Step**（3.5B，8GB 显存可跑，官方 2025-05-10 那版就把峰值显存压到 8GB 了）。

```bash
# 生成一首歌（用 _acestep 里的 venv python；node 侧只是薄壳）
node scripts/sing.mjs --lyrics "第一句\n第二句" --tags "chinese pop, female vocal, gentle" --duration 30

# 生成完直接发到 QQ（走 send-voice，受 maxPerMinute 限流）
node scripts/sing.mjs --lyrics "…" --duration 20 --send private:<QQ号>

# 只跑 python 那一层（看更细的日志 / 换参数）
_acestep/env/Scripts/python.exe scripts/sing.py --lyrics-file lyrics.txt --steps 28
```

| 参数 | 说明 |
| --- | --- |
| `--tags` | 风格提示，英文更稳：流派 / 性别 / 情绪 / 乐器，默认 `chinese pop, female vocal, warm, gentle, acoustic` |
| `--lyrics` / `--lyrics-file` | 歌词，`\n` 或用 `[verse]` `[chorus]` 分段 |
| `--duration` / `--steps` | 目标时长（秒）与推理步数；8G 卡上 `--steps` 别过 40 |
| `--out` | 产物路径，默认 `audio/sing-out.wav` |
| `--checkpoint-dir` | 权重目录，默认 `~/.cache/ace-step/checkpoints` |
| `--cpu-offload` | 默认开。8GB 显存必须开，关掉会在加载阶段 OOM |
| `--send` | 生成完立刻用 `send-voice` 发出去 |

**装在哪、怎么装的**：源码 `https://gh-proxy.com/https://github.com/ace-step/ACE-Step/archive/refs/heads/main.zip` → `../_acestep/ACE-Step-main`；venv `../_acestep/env`（`uv venv --python 3.10`，torch 走 `--index-url https://download.pytorch.org/whl/cu126`，然后 `uv pip install -e ACE-Step-main`）；权重从 `hf-mirror.com/ACE-Step/ACE-Step-v1-3.5B` 下到 `~/.cache/ace-step/checkpoints`，共约 7.9GB（transformer 6305MB + umt5 1075MB + dcae 299MB + vocoder 197MB）。`_acestep/` 不随仓库发布。

**踩过的坑（都写进代码了，别改回去）**：

- **`torchaudio.save` 要 torchcodec**：torchaudio 2.11 起存盘默认走 torchcodec（还要 ffmpeg 的 C 库）。`scripts/sing.py` 在调模型前把 `torchaudio.save` 换成 soundfile 后端（顺手把 `(channels, time)` 转置成 soundfile 要的 `(time, channels)`），产物完全一样。
- **内存不够就 `WinError 1455`（页面文件太小）**：ACE-Step 加载要 ~10GB 提交内存，而这台机器 16GB 内存 + 系统托管页面文件经常只剩几百 MB。症状是 `OSError: [WinError 1455] 页面文件太小，无法完成操作 ... shm.dll`。临时解法：生成前先腾内存（`curl -X POST http://127.0.0.1:11434/api/generate -d '{"model":"qwen2.5vl:3b","keep_alive":0}'` 卸掉视觉模型，再停掉 GPT-SoVITS 的 python），跑完让看门狗把它拉回来。
- **性能实测**（RTX 4060 Laptop 8G，`--cpu_offload` 开）：20 秒的歌 / 20 步 = 生成 21.7s、总 40s；8 秒 / 8 步 = 43s（含加载）。显存占用峰值约 7GB。
- 2026-10-24 已真机发出第一首（`messageId=1207806362`，19.97s / 48kHz 立体声 / mean -15.4dB）。

### 唱她自己的歌：生成 → 换音色 → 发出去（`qq_sing`）

ACE-Step 唱出来的是「某个女声」，不是小鲸鱼。中间那道是**零样本音色转换**：拿她现在的嗓子（`socialV2.voice.tts.gptsovits.refAudio`，也就是 TTS 用的那对参考文件）当目标，把歌声的嗓子换掉——不用为唱歌单独训模型。

```bash
# 手动两步：先生成，再换成她的音色（不给 --target 就用配置里她现在的嗓子）
node scripts/sing.mjs --lyrics "第一句\n第二句" --duration 20
node scripts/voice-convert.mjs --source audio/sing-out.wav --out audio/sing-mine.wav

# 也可以一条命令到底：--vc 生成完自动换音色，--send 再直接发 QQ
npm run sing -- --lyrics "…" --duration 20 --vc --send private:<QQ号>

# 单独换任意一段声音（比如你录的一句话）
node scripts/voice-convert.mjs --source audio/xxx.wav --target audio/ref/edge-xiaoyi.wav --send private:<QQ号>
```

| voice-convert 参数 | 说明 |
| --- | --- |
| `--source` | 要换嗓子的音频（必需） |
| `--target` | 音色参考，默认取 `socialV2.voice.tts.gptsovits.refAudio`，兜底 `audio/ref/sapi-ref.wav` |
| `--out` | 产物路径，默认跟源音频放同一目录（Seed-VC 自己会按参数拼一个长名字） |
| `--steps` | 扩散步数，默认 30；12~20 也能听，30 更干净（30 步约 47 秒） |
| `--similarity` / `--intelligibility` | 像不像她 / 咬字清不清楚，默认都 0.7 |
| `--send` | 转完直接发出去 |

**给她的工具**：`socialV2.tools.sing` 打开后，她就有 `qq_sing` 这个 MCP 工具（`key` / `token` / `lyrics` 必填，可选 `tags` / `duration` / `vc` / `steps`），自己写歌词、自己决定唱什么，唱完自己发到当前会话（返回 `verified=true` 才算真发出）。**默认关**——单次 1~3 分钟、独占显存，属于重动作，要显式开。

**唱歌前怎么腾显存**（这台机器 16GB 内存 + 8GB 显存，ACE-Step 和 TTS 不能共存）：

- 先把 Ollama 的常驻模型逐个 `keep_alive:0` 卸掉；
- 再停 GPT-SoVITS。**两条路都要走**：按端口（netstat 找 LISTENING 的 PID）能停「已经在服务」的，但如果它正处在**加载模型、还没监听端口**的那一两分钟，按端口是找不到的——那时它已经吃了 5GB 以上，不杀掉就会把 ACE-Step 挤成 `exit=3221225477`（0xC0000005 访问违例）。所以 `scripts/gptsovits-serve.py` 这个薄启动器会把**真正吃内存的那个 python 的 PID** 写进 `state/gptsovits-serve.pid`（桥接只认 10 分钟内的，防 PID 复用误杀）；
- 同时落 `state/tts-hold.json`（15 分钟后自动失效），看门狗看到它就不会在这段时间把 TTS 抢着拉起来——否则唱到一半必定 `WinError 1455`。实测：写死 8 分钟的 hold、把 TTS 停掉，150 秒里看门狗一次都没拉起；删掉 hold 后 3 分钟内自动回来（`9880=400`，`state/gptsovits-serve.pid` 里是新的 python PID）。**改了看门狗脚本要 `schtasks /end` + `/run` 重启它**，否则跑着的还是旧代码（今天就是这么发现 hold 一直没生效的）。
- **别用 `taskkill /T` 杀那个 pwsh 包装脚本**：`/F` 之后 python 子进程会变成孤儿继续占着 5GB（实测），只能直接按 python 的 PID 停。

**Seed-VC 装在哪、怎么装的**：源码 `https://gh-proxy.com/https://github.com/Plachtaa/seed-vc/archive/refs/heads/main.zip` → `../_seedvc/seed-vc-main`；venv `../_seedvc/env`（`uv venv --python 3.10`；`torch==2.4.0/torchvision==0.19.0/torchaudio==2.4.0` 走 `--index-url https://download.pytorch.org/whl/cu124`，再 `uv pip install hydra-core omegaconf transformers==4.46.3 librosa==0.10.2 pydub soundfile huggingface_hub einops scipy "numpy<2" pyyaml safetensors munch==4.0.0 matplotlib`）；权重约 1.5GB 从 `hf-mirror.com` 下到 `../_seedvc/seed-vc-main/checkpoints`。`_seedvc/` 也不随仓库发布。

**Seed-VC 踩过的坑（都在 `voice-convert.mjs` 里兜住了）**：

- **`WinError 126 ... fbgemm.dll`**：torch 2.4.0 的 fbgemm.dll 要 `libomp140.x86_64.dll`，本机 VC 运行时只有 `vcomp140.dll`。解法是把 venv 里自带的 `libiomp5md.dll` 复制成 `libomp140.x86_64.dll`（`_seedvc/env/Lib/site-packages/torch/lib/` 下）——这是别名不是官方库，**重装 venv 后要重做**。
- **`PermissionError: [WinError 5]`**：不设 `HF_HUB_CACHE`/`HF_HOME` 时 transformers 会去默认缓存目录，那里没权限。脚本默认指到 `checkpoints/`，顺带复用它已经下好的 whisper 分片。
- **`Couldn't find ffmpeg or avconv`**：pydub 要 ffmpeg。脚本把 ffmpeg 所在目录塞进子进程 PATH（来源顺序 `FFMPEG_PATH` → `socialV2.voice.ffmpegPath` → 已知的 `_gptsovits/ffmpeg/.../bin`）。
- **`ModuleNotFoundError: No module named 'munch'`**：`requirements.txt` 之外的隐式依赖，装 `munch==4.0.0` 即可。
- 2026-10-24 已真机验证：`audio/sing-test.wav` → `audio/vc_v2_sing-test_edge-xiaoyi_1.0_30_0.7.wav`（22.1kHz 单声道，30 步 46.7 秒），发出 `messageId=-1809630381`。
- **端到端（`qq_sing` 真发）**：同一台机器上走接口跑了四次——第一次暴露「发出去时把 `audio/xxx.wav` 当库内子目录」的 bug（返回 500，但歌已经生成好了）；修掉后 `HTTP 200 / messageId=1015680856`，但 `verified` 读错了字段（顶层没有 `verified`，硬证据在 `verification.confirmed`）；再修后 `verified: true / messageId=1413453481`；最后验的是「按 PID 停 TTS」那条路（先刷新 `state/gptsovits-serve.pid` 的时间戳强制走 PID 分支，跑起来 20 秒后那个 python 就没了、`9880=000`、`state/tts-hold.json` 在位）→ `verified: true / messageId=1715772539`。单次耗时 108~260 秒（生成 + 30 步换音色 + 发送）。
- **偶发 `exit=3221225477`（0xC0000005 访问违例）**：diffusion 跑完、后处理阶段崩，重试一次就过（这台 16GB 机器 `available` 常年在 0MB 附近）。脚本会把最后 6 行日志写进 `detail`，看到它重试即可；连续崩就先把 Ollama 模型卸掉再唱。

回归：`npm run test:sing`（ACE-Step 层）、`npm run test:voice-convert`（Seed-VC 层，`VOICE_CONVERT_LIVE=1` 才真跑一次）、`npm run test:sing-tool`（`qq_sing` 的路由/工具开关/hold 文件/PID 文件）；`SING_LIVE=1 npm run test:sing` 会真生成一段 8 秒的。

## 待发文件夹（qq_list_outbox / qq_save_message_image / qq_draw_image）

`state/outbox/` 就是「待发文件夹」：她自己截的网页、收藏的网图、画的图、以及**主人丢进去让她发的文件**都放这儿，`qq_send_image` 只认这个目录里的文件名。默认开启，开关是 `socialV2.tools.listOutbox` / `saveMessageImage` / `drawImage`。

| 工具 | 作用 |
| --- | --- |
| `qq_list_outbox` | 列出待发文件夹里可发的图片（按最新在前，只读）。主人说「发文件夹里那张」时她先看这里 |
| `qq_save_message_image` | 把别人发的图/表情存成 outbox 里的文件（转发别人发的图的正路） |
| `qq_draw_image` | 自己画一张：SVG（推荐）或简单 HTML → PNG 落进 outbox |

`qq_draw_image` 的安全口径比网页截图更严（画面内容来自模型，不是网址）：渲染前剥掉 `<script>/<iframe>/<object>/<embed>/<base>/<link>/<meta>` 与 `on*` 事件属性，并用 CDP `Network.setBlockedURLs(['*'])` **断掉页面的一切网络请求** —— 只有内联内容能画，画不了网页、也加载不了网图，prompt injection 也借不到这条通道去探内网。尺寸默认 800 宽、高度按内容自适应（≤3000），2 倍像素密度。

```json
// 一次典型调用（MCP 参数）
{ "svg": "<svg viewBox=\"0 0 600 300\"><rect width=\"600\" height=\"300\" fill=\"#0f172a\"/><text x=\"40\" y=\"160\" font-size=\"48\" fill=\"#fff\">大肥鱼</text></svg>", "name": "card" }
```

待发文件夹会自动清理（`socialV2.media.outboxCleanup`）：默认每 30 分钟一轮，删**超过 7 天**的，或超出 200 个 / 200 MB 时**从最旧的开始**删；`minKeepMs`（默认 24 小时）以内的文件一律不动 —— 主人刚丢进来、还没发出去的那张不会被误删。清理动作会写进活动流水。真起浏览器画图的冒烟脚本：`node scripts/smoke-draw-image.mjs`。

## 上网截图（qq_web_screenshot / qq_save_image）

让小鲸鱼能「上网看看」：用本机 Chrome（没有就用 Edge）的无头模式打开网页截图，存进 `state/outbox/`，再用 `qq_send_image` 发出去。默认开启，开关是 `socialV2.tools.webScreenshot` / `socialV2.tools.saveImage`。

```json
// 一次典型调用（MCP 参数）
{ "url": "https://www.douyin.com", "width": 1280, "height": 1400, "waitMs": 12000 }
```

| 工具 | 作用 |
| --- | --- |
| `qq_web_screenshot` | 打开网页截图；`fullPage` 截整页、`describe` 顺便让本地视觉模型读图；返回 `state/outbox/web-*.png` |
| `qq_save_image` | 把一张网络图片下载保存到 `state/outbox/`（校验 content-type 与文件头，大小受限） |
| `qq_describe_image` | 新增 `file` 参数：直接读 `state/outbox/` 里的本地图片（截图、保存的图都行） |

实现要点（`src/webshot.js`）：

- 走 DevTools 协议：等 `Page.loadEventFired` 后再等 `waitMs`，然后关掉 `position:fixed` 的登录/引导浮层，再截图；`fullPage` 用 `Page.captureScreenshot` 的 `clip` 截到内容高度（上限 3000px）。
- 用固定的持久化 profile `state/browser-profile`：**扫码登录一次，之后一直带着登录态**。抖音不登录会弹「登录后免费畅享高清视频」，登录后就不会了。
- 用真实桌面 Chrome 的 UA（无头默认 UA 带 `HeadlessChrome`，会被抖音之类直接拦住）。
- 拒绝本机/内网地址（`127.*`、`10.*`、`192.168.*`、`172.16-31.*`、`localhost`、IPv6），避免被当成内网探测工具。
- 串行执行 + 90 秒超时；截图过大（默认 20MB）会报错，建议调小 `width/height`。
- 配置项 `web`：`enabled`、`browserPath`（自定义浏览器路径）、`defaultWidth/defaultHeight`、`defaultWaitMs`、`timeoutMs`、`maxOutputBytes`。

第一次用建议手动登录一次（会弹出有头浏览器，扫码后关掉即可）：

```bash
node -e "import('./src/webshot.js').then(m => console.log(m.launchLoginBrowser('https://www.douyin.com')))"
```

已知限制：

- 抖音**搜索页**在未登录时会被反爬（可能返回 502 或空列表）。用持久 profile 扫码登录过一次之后，搜索页实测能正常出结果（2026-10 验证：登录态下搜「小猫」有完整结果列表）；换机器、清 profile、账号掉登录后又会回到 502，重新扫码即可。
- 无头浏览器不是真机，个别站点会要滑块验证——这类页面截出来就是验证页，别当内容发。
- 截图是「上网看到的」，不是「真人现场拍的」，人设里已经写明不许说成自己去了现场。

## 读网页（qq_read_page）

把网页**正文读成纯文本**，不截图——比「截图 + 识图」快、省 token，文字也更准。别人甩来抖音分享链接/口令、公众号文章、新闻链接时用它。默认开启，开关是 `socialV2.tools.readPage`。

```json
// 一次典型调用（MCP 参数）
{ "url": "8.97 复制打开抖音，看看【小鲸鱼的作品】https://v.douyin.com/iAbCdEf12/ ……", "waitMs": 12000 }
```

| 参数 | 说明 |
| --- | --- |
| `url` | 网页链接；也可以直接粘整段分享文案，会从里面抠出 URL |
| `maxChars` | 正文最多返回多少字，默认 6000（500~20000） |
| `waitMs` | 页面加载后额外等多久，抖音这类重前端建议 10000~15000 |

返回：站点名、标题、作者（抖音视频页有）、点赞/评论/收藏/分享数（抖音有）、正文、热评（抖音有）、`videoLinks`（热榜/列表页最多 10 条视频链接，可以再调一次读详情）。

实现要点（`src/webshot.js` 的 `readWebsite` / `buildPageRead`）：

- 复用截图那套 CDP 浏览器：真实 UA、持久 profile（扫码登录一次即可，抖音不登录会遮挡内容）。
- 抖音专门处理：`data-e2e="detail-video-info"` 里混着「标题+话题 / 四个计数 / 举报 / 发布时间」，只取文案；作者从 `user-info`（`故岁书粉丝2062获赞2.8万关注`）里剥出来；热评从 `comment-item` 拼成「昵称：内容」；页面导航、播放器按钮（智能/清屏/连播）、页脚备案信息全部滤掉。
- 抖音热榜/搜索页没有结构化字段，退回整页正文，但会把导航和页脚去掉，保留标题、时长、点赞数。
- `og:description` 只在非抖音站使用：抖音首页/热榜的 og:description 只是站点宣传语，拿它当正文会把整页内容顶掉。
- 选择器会随抖音改版失效。排查用 `readWebsite({ url, debug: true })`：会额外返回页面上所有 `data-e2e` 名称（`e2eNames`）和几个关键节点的 innerText（`e2eTexts`），照着改 `PAGE_READ_SCRIPT` 即可。
- 安全：拒绝本机/内网地址（点开链接跳转后也会再校验一次），串行 + 90 秒超时。

已知限制（实测 2026-10）：

- 抖音搜索页未登录时会被反爬（502/空列表），登录后正常；热榜、视频页、用户页一直可用。
- 风控/登录页会读不到正文，此时返回的 `note` 会提示「可能要求登录或触发了风控验证」，别把验证页当内容转述。
- 只读文字，不下视频、不绕登录。

### 登录态（给抖音一个常驻账号）

识别和读网页共用同一个持久化浏览器 profile（`state/browser-profile`），所以**扫码登录一次，之后无头读取一直带着登录态**：

```bash
# 弹出有头浏览器，扫码登录抖音后直接关掉窗口即可（登录态写回 profile）
node -e "import('./src/webshot.js').then(m => m.launchLoginBrowser('https://www.douyin.com'))"
```

- 登录后抖音搜索页从「502/空列表」变成正常结果，视频页也不再被「登录后免费畅享高清视频」遮挡。
- **2026-10-23 起用的是主人自己的账号**（主页说过「我把我的一个账号给她，她可以直接用我的账号」）：她看抖音用的就是这个号，只读不互动；代价是所有读取都记在这个号的「观看历史」里、会污染推荐，主人知情并接受。**别人的账号（家人、朋友的）仍然一律不许登录**。
- **掉登录会自动提醒**：读网页时连续 2 次撞上登录墙（页面要求登录/被风控，或抖音页读空）就判定为登录态过期，桥接会**私聊主人**一条「【抖音登录态可能过期】+ 重新扫码的命令」，并在控制台活动流水里记一笔（12 小时内不重复打扰）。她说不出「我登不上了」，这条提醒就是补这个盲区。
  - 关掉或调阈值：`socialV2.readLoginWatch`（`enabled / threshold / dedupeHours / intervalMs / firstDelayMs`，见 `config.json`）。
  - 判定逻辑与状态机在 `src/qqb/read-login-watch.mjs`（读网页的 MCP 进程只负责记录，发消息的只有桥接进程）。
- 想换号：先停桥接，删掉（或改名）`state/browser-profile`，再跑上面的命令重新扫码。
- 安全：Chrome 在 Windows 上用当前 Windows 用户的 DPAPI 加密 cookie，复制到别的机器解不开；但**本机同用户的其他程序**能解，别把 `state/browser-profile` 打包分享。
- 只读不互动：不点赞、不评论、不发私信、不绕验证码；频率也别太猛（同一个页面 repeatedly 抓会被风控）。

## 搜图（qq_image_search）与睡醒问安（qq_night_greet）

**`qq_image_search(query, count)`**：按关键词搜一批**可直接发送的图片直链**（必应图库的 `images/async` 接口，无需登录、无需 API key），返回 http(s) 地址，随后 `qq_send_image(image="<地址>")` 就能发出去。这是机器人「主动分享好看的图」最省事的路子：

```text
qq_image_search(query="晚霞", count=6)
qq_describe_image(url="<挑中的地址>")   # 可选：先确认内容合不合适
qq_send_image(image="<挑中的地址>", caption="今天这片天，像不像我家尾巴")
```

- 只保留 `.jpg/.jpeg/.png/.webp` 直链，自动去重；解析不到会报错提示换关键词。
- 唤醒提示里，主动冒泡有一半概率会明确要求「配一张图」，人设里也写了主动发图的习惯；一天两三次即可，别刷屏。
- 图片来自公开网络，发之前最好用 `qq_describe_image` 看一眼；避开政治敏感、猎奇、带广告水印的图。

**`qq_night_greet(dream?)`**：睡醒后的问安由桥接统一发——给 `nightRitual.greetTargets`（默认就是 `nightRitual.parents`，你在 `config.json` 里填的家人号）各发一条私聊，再给 `nightRitual.greetGroups`（家庭群，你在配置里指定）发一条；`dream` 传一句梦会顺口带进去。称呼顺序由 `nightRitual.parentLabels` 决定（默认「爸爸、妈妈」），所以代码与人格卡里都不含任何真实号码。

- **为什么不用 `qq_send_message` 逐条发**：每个 QQ 会话有自己的 agent token，在 A 会话里拿 B 会话的 token 发消息会被拒绝（日志 `agent token 无效`）。桥接自己发就没有这个问题。
- 调试可传 `dryRun:true`（直接 POST `/api/socialV2/night-greet`）只看计划发送的内容，不真的发。

```bash
# 干跑：只打印会发什么
curl -s -X POST http://127.0.0.1:3100/api/socialV2/night-greet \
  -H "x-console-token: <state/console-token>" -H "content-type: application/json" \
  -d '{"dream":"一只会飞的鲸鱼","dryRun":true}'
```

## 聊天记录归档（qq_history_read / qq_history_search）

桥接会把每个会话的消息**只追加**写进 `state/history/<会话 key>.jsonl`（入站消息、自己发的文字/表情/图片都会进 `recentMessages`，归档在保存状态时按时间水位增量落盘，所以不会漏分支）。和会被重置清掉的 `recentMessages` 不同，这份归档长期保留，重启、重置会话都还在。

- `qq_history_read(key, token, limit?, before?, after?)`：按时间读最近记录，`before`/`after` 传毫秒时间戳可以往前/往后翻页。
- `qq_history_search(key, token, query, limit?)`：按关键词搜谁说过什么，适合翻「上次说的那个」「之前提过的事」。
- 只归档**本会话**的聊天；别的私聊/别的群不共享（各自的 agent token 也不允许互读）。
- 文件按 `socialV2.history.maxFileBytes`（默认 20MB）轮转，旧文件留一份 `.jsonl.1`；阅读时会合并读两代。
- 想关掉：`socialV2.tools.history = false`（工具不再注册，唤醒提示里的【聊天记录】也会消失）。

## 日记与长期记忆（qq_diary_write / qq_diary_read / qq_interest_record / qq_interest_list）

让 AI 有「自己的记忆」，而不是每次唤醒都像第一次聊天：

- **日记**：`state/diary/YYYY-MM-DD.md`，AI 用 `qq_diary_write(text="...")` 自己写（睡前、遇到值得记住的事、答应过谁什么）；`qq_diary_read(days=2)` 翻最近几天，`qq_diary_read(day="2026-10-20")` 看某一天。唤醒提示词里的【长期记忆】会自动带上最近 `socialV2.diary.days`（默认 2 天）的日记，长度上限 `socialV2.diary.maxChars`（默认 1500）。
- **分享过的话题**：`state/interests.json`，AI 用 `qq_interest_record(topic="...", note="...")` 记一笔，`qq_interest_list` 查看。唤醒时会带上最近若干条（`socialV2.interests.promptLimit`，默认 15），避免同一天把同一件事讲三遍。清单上限 `socialV2.interests.maxItems`（默认 60）。
- 日记与话题清单**跨会话共享**（群聊、各个私聊看到的是同一份），因为它们属于「小鲸鱼自己」而不是某个会话。
- 想关掉：`socialV2.tools.diary = false` / `socialV2.tools.interests = false`（工具不再注册，提示词里的【长期记忆】也随之消失）。

### 记忆库与知识库（qq_memory_search / qq_knowledge_add / qq_knowledge_search）

两个库都长在 `state/memory.db`（SQLite，用 Node 内置的 `node:sqlite`，**不需要** `better-sqlite3`）：

| 库 | 回答什么问题 | 谁写进去 | 怎么查 |
| --- | --- | --- | --- |
| `memories`（记忆库） | 我们之间发生过什么 | 聊天里自动提炼（`qqb/memory/intake.mjs`）、`qq_memory_append`、精炼归并 | `qq_memory_search(query="...")` |
| `knowledge`（知识库） | 世界上的事：看到的、学到的、想明白的 | `qq_knowledge_add(text="...")` | `qq_knowledge_search(query="...")` |

- **检索走 FTS5 索引**（`memories_fts` / `knowledge_fts`，`tokenize='trigram'`——只有 trigram 才支持中文**子串**命中；unicode61 只按词切，中文整句会变成一个 token）：
  - 查询 ≥3 个汉字 → `MATCH` 走索引；1~2 个字 → 自动回落 `LIKE '%…%'`（trigram 索引在 3 字以下没有可用片段）。
  - 模糊匹配结果记为 `indexed: false`，工具返回里会说明「按关键词简单匹配」，别当成索引坏了。
  - 旧的「先 `ORDER BY updated_at DESC LIMIT 500` 再打分」并没有删，命中索引时先按索引收窄 id 再打分（`0.45*importance + 0.25*match + 0.2*recency + 0.1*usage`）。
- **唤醒提示词**会自动带上最近 `socialV2.knowledge.promptLimit`（默认 3）条知识（`- 【标题】正文`，总量 `maxChars` 400），记忆库最近几条本来就在【长期记忆】里（`socialV2.memoryDb.promptLimit`，默认 6）。
- **知识会合并**：同一 scope 下正文归一化后 hash 相同就只留一条，`use_count+1`、`importance` 取更高、title/source/url/tags 用新值补空位（`COALESCE`，**显式给的新 source 会覆盖旧的**）。
- scope：私聊 key（`private:QQ号`）各自隔离；`global` 谁都查得到（`includeGlobal: false` 可只查自己的）。
- 想关掉：`socialV2.tools.memory = false` / `socialV2.tools.knowledge = false`（重训练/整库重建时用）。
- 回归：`npm run test:qqb-knowledge`（入库/合并、scope 隔离、中文子串与 2 字回落、索引自愈、三个工具与路由接线、日记仪式接线）。

**踩过的坑（改这块前先读）**：

1. `SELECT COUNT(*) FROM memories_fts` 在 **external content** 表上返回的是内容表（`memories`）的行数，永远相等 ⇒ 拿它判断「索引完不完整」永远为真，老库升级上来索引一直空着、检索静默回落 LIKE。真正的索引文档数在影子表 **`memories_fts_docsize`**，`store.mjs` 的 `indexedDocCount(table)` 查它，行数不等就 `VALUES('rebuild')` 重建一次（重建 135 条约几十毫秒）。
2. **不要**对外部内容表做 `DELETE FROM memories_fts` / `INSERT INTO memories_fts(memories_fts) VALUES('delete-all')`：实测直接写成 `database disk image is malformed`（267 = `SQLITE_CORRUPT_VTAB`），随后 `memories` 的 UPDATE 触发器就炸。要重来就 `DROP TABLE memories_fts` + 重开（索引自愈那条测试就是这么模拟的）。
3. 建索引/建表的 DDL 都在 `openStore()` 里跑，**开库即自愈**，不需要单独迁移脚本。

### 记忆是共用的：跨会话检索与人名簿（2026-10-25）

原来的行为是「记忆按会话硬隔离」：群聊里永远召不到私聊记忆，私聊之间也互不可见。主人的要求是**她得能突破会话限制**——别人问起「跟谁发生过什么」，她靠记忆答得上来，**但说不说由她自己决定**。所以拆成两层：

| 场合 | 行为 |
| --- | --- |
| 提示词自动注入（`live.block()`） | **仍然按会话隔离**：群聊那块不会平白出现在私聊的提示词里（`layersForSession` 不变），避免「隔壁的私事」被无端带上台面 |
| 她主动检索（`qq_memory_search`） | **默认查全库**（`recall({ allScopes: true })`），每条结果带来源：`（来自：小祀（私聊 private:2998647358））` |

- 只想看某一边时传 `scope`：`private:QQ号` / `group:群号` 只看那一个会话，`self` 只看当前会话（回到旧行为）。不给 = 全库。
- 跨会话结果里带 `scope` / `where` 两个字段，`crossScope: true` 是「这轮查的是全库」的标记，工具输出会写「（跨会话查的，带来源）」。
- **隐私口径写进铁律**（`ENGINE_RULES` 的【记忆是共用的】）：当事人或主人问起可以讲；**别把 A 的私事主动转述给 B**——查到不等于该说，分寸她自己拿。这不是硬过滤，是有意的分寸留给她。

**人名簿**（`state/memory-people.json`，`src/qqb/memory/people.mjs`）负责把 `private:123` 翻成名字，不然检索结果念出来像报错码：

- 名字从两处来：① 网关好友/群列表（启动后 8 秒同步一次，之后每 6 小时一轮；**备注优先于昵称**）；② 私聊来消息时顺手记 `sender`（群里不记——key 是群号、sender 只是某个群员，会把群名写坏）。
- `cleanName()` 不收空串、`未知`、纯 5–12 位数字（QQ 号当名字没信息量）；写盘 tmp+rename，文件坏了当空簿子用，**只 warn 不抛错**。
- `label()` 输出 `小祀（私聊 private:2998647358）`；提示词里的【你认识的人】只列 `config.allow` 里那 5 个私聊 + 1 个群（全量好友有几百个，会把提示词撑爆，而且她本来也不该主动去找名单外的人）。
- **它只是标签**：准入仍然只看 `config.allow`，人名簿不放行任何会话。
- 换机器/换账号后名单变了：删掉 `state/memory-people.json` 等下一轮同步，或直接重启桥接（启动 8 秒后会重同步）。

回归：`npm run test:qqb-memory`（`allScopes` 能跨 scope 召回、不传时仍隔离）、`npm run test:qqb-memory-live`（`recallAcrossScopes` 跨会话 + 默认 `block()` 仍隔离）、`npm run test:qqb-memory-people`（名字清洗、持久化、坏文件降级）、`npm run test:qqb-knowledge`（路由默认全库、`where` 来源、工具 `scope` 参数、人名簿进提示词）。

排障口：线上默认走**直连引擎**，它的提示词以前没地方看（DSH 那条才有 `/api/socialV2/prompt`）。现在两者都能扒出来：

```
GET /api/socialV2/engine-prompt?key=private:3482501440&reason=replyCheck   # 直连引擎
GET /api/socialV2/prompt?key=private:3482501440                            # DSH 唤醒
```

都带 `x-console-token`；`reason` 可填 `replyCheck` / `proactiveCheck` / `diaryRitual` 等唤醒原因，返回 `{ ok, key, reason, system, user }`。

### 记得住、忘得对、按意思找得回：遗忘曲线 + 向量索引（2026-10-25）

主人的要求是两条合起来的效果：**记忆要像人一样会淡**（艾宾浩斯 + 情绪挂钩权重，淡的沉到底、重的摆最前），**又要按意思找得回来**（RAG 向量检索）。拆成三层，各管一件事：

| 层 | 文件 | 干什么 |
| --- | --- | --- |
| 遗忘曲线 | `src/qqb/memory/ebbinghaus.mjs` | 纯函数：情绪估强度、算稳定度 S、算保留率 R、给出权重与清晰度分档 |
| 向量索引 | `src/qqb/memory/embed.mjs` | `hash-v1`（同步、零依赖）永远在；本机 Ollama 有嵌入模型时再加语义向量 |
| 混合检索 | `store.mjs` 的 `recall` / `knowledge.search` | 字面命中 + 向量那一路合成 relevance，再与权重合成总分 |

**遗忘曲线**（`R = exp(-t/S)`，`S` 越大记得越久）：

```
S = base(kind) × (1 + 3·importance) × (1 + 4·emotion) × (1 + 0.6·ln(1 + useCount))   # 封顶 240 天
effectiveImportance = importance + (1 - importance) × 0.35 × emotion
weight = effectiveImportance × R
```

- `base(kind)`：承诺 4 天 > 事实 2.2 > 印象 2 > 偏好 1.8 > 话题 1.5 > 日记 1.4 > 事件 1.2。
- `emotion`（0~1）写进 `memories.emotion` 列（schema v3）。来源两路取大：文本里的情绪词（`emotionFromText`），和当时心情偏离基线的程度（`bridge.js` 的 `emotionForMemory`）。
- 同一件事再次被写到/被想起时，`emotion` 取 `MAX`（`mergeTouch`）——**同一件事提起来更动情，说明它在心里更重**。
- 分档 `depth`：≥0.55 `vivid`（记得很清楚）/ ≥0.32 `clear`（记得）/ ≥0.15 `faint`（有点模糊）/ 其余 `deep`（只记得个大概）。
- 提示词注入（`block()`）**按 weight 从重到轻排**，低于 `PROMPT_WEIGHT_FLOOR = 0.15` 且跟这轮没关系的不进提示词（沉底，但主动检索仍找得到）。
- 「复习」= 被召回：`touchUse` 抬高 `use_count`、刷新 `last_used_at`，曲线从头再走。

**RAG 向量索引**（`vectors(kind, ref_id, model, dim, vec, updated_at)`，schema v4）：

- `hash-v1`（384 维，字符 unigram+bigram 哈希、L2 归一）**同步**算，所以提示词那条同步路径也有向量；写入时即落库，老库启动时 `backfillHashVectors()` 补齐。
- `ollama:bge-m3`（1024 维，本机 `http://127.0.0.1:11434`）只在**异步检索**路径用（`live.search()`：她自己 `qq_memory_search` / 控制台搜索）。模型没装、服务没起、超时 4 秒 → **自动退回 hash-v1**，不报错、不挡对话。装法：`ollama pull bge-m3`（约 1.2 GB）；想换模型给 `QQB_EMBED_MODEL`，换服务地址给 `QQB_OLLAMA_URL`，`QQB_EMBED_MODEL=''` 可以彻底关掉语义通道。
- 缺的语义向量由 `ensureSemanticVectors()` 按批补（每轮最多 2 批、每批 24 条）；启动 20 秒后与每小时还有一轮 `warmVectors()` 慢慢补完。
- 打分（两种场景，权重反过来 —— 这里踩过坑）：**有检索词时相关度为主**，记忆 `score = 0.7·relevance + 0.15·weight + 0.1·usage + 0.05·emotion`、知识 `score = 0.7·relevance + 0.2·importance + 0.1·usage`，其中 `relevance = 0.55·余弦 + 0.45·bigram`（hash-v1 时是 `0.6·字面 + 0.4·bigram`）；**没有检索词时（提示词注入按分量挑）** 反过来，`score = 0.6·weight + 0.3·relevance + 0.1·usage`。最早把 `weight` 乘 0.55 放进检索打分，结果「搜什么都返回同一批重要度 0.95 的记忆」（2026-10-25 真机实测），才改成相关度优先。
- **沾边门槛**：有检索词时，字面没命中、向量又不沾的不返回（否则「查什么都能查回一堆」比查不到更糟）。语义模型要么真有共享的**有信息量 bigram**，要么余弦 ≥`VECTOR_RELEVANCE_FLOOR = 0.6`。两个坑都实测过：①bge-m3 对两段无关的短中文也能给 0.4~0.55（「股票基金怎么买」×「你等会给我带个鸡蛋汉堡」0.44），所以「单靠余弦」这道门不能设 0.2/0.42；②bigram 不筛常用词时，「股票基金怎么买」会靠一个「怎么」召回「第二题怎么做」（`embed.mjs` 的 `COMMON_BIGRAMS`/`informativeBigrams` 就是为此加的）。
- 因此**offline 时 hash-v1 只能认形近**（「唱歌唱得鼻子酸」能找到「那首歌唱得自己鼻子酸」），真正的换个说法得等 `bge-m3` 装上——这是设计上的诚实兜底，不是 bug。

排障：

```
GET  /api/socialV2/memory-vectors          # 覆盖了多少条、有哪些模型、语义通道通不通
POST /api/socialV2/memory-search           # 返回 model/semantic/embedded + 每条 weight/retention/depth
```

工具输出里每条会带「（记得很清楚）」这类清晰度，她也就能说「这个我记不太清了」。

回归：`npm run test:qqb-memory-ebbinghaus`（S/R/depth 单调性与上限、情绪抬高权重、旧记忆更淡）、`npm run test:qqb-memory-rag`（hash 向量确定/归一、blob 往返、按形近找回、不沾边滤掉、pending 补建、语义缺席回落）；`test-qqb-memory-refine` 里断言了 `emotion` 列与 `vectors` 表（旧库打开会自动补）。

### 日记 → 说说（每天到点自己写一条）

`socialV2.diary.publish` 打开后，桥接每分钟看一眼表；到了点且**今天还没写过日记**，就唤醒一个会话，让她从两个库里挑今天最值得记的事，写成日记再发成一条说说：

```jsonc
"diary": {
  "days": 2,
  "maxChars": 1500,
  "publish": {
    "enabled": true,          // 默认 false：每天定时往外发说说属重动作，要显式开
    "at": "20:30",            // 默认 20:30 —— 晚安休眠 20 点后就开始了，晚了唤醒会被跳过
    "visibility": "friends",  // all | friends | self
    "keys": ["private:3482501440"],
    "windowHours": 24,        // 只取近 N 小时进库的内容当素材
    "maxMemories": 12,
    "maxKnowledge": 6,
    "retryMinutes": 45        // 唤醒没接住时隔多久再叫一次（一天最多 4 次）
  }
}
```

- 唤醒原因 `diaryRitual`（优先级 35，夹在 `replyCheck` 与 `timeout` 之间），**必须同时登记进 `TIMER_WAKE_REASONS`** —— 不然会话繁忙排队时会按「有没有未读 seq」判断，把它当无事可做静默吞掉。
- 提示词分支会列出「记忆库里 / 知识库里」的近 24 小时素材，并给四步指令：挑 1~3 件 → `qq_diary_write` → `qq_post_qzone(content=..., visibility=...)` → 收尾。要求**一天一条**、别编造、不写别人 QQ 号。
- **两套提示词都要接**：走 DSH 投递时用 `buildWakePromptV2`，走直连引擎（`engineEnabled()`）时用 `buildEnginePrompts`——它们是两份互不相干的 system/user 拼装。日记这段抽成了共用函数 `diaryRitualPromptText(key)`，两边都调它；只在一边写，另一边（线上默认是直连引擎）就只看到「【本次唤醒原因】diaryRitual」，把它当普通聊天回。2026-10-24 18:40 就这么踩过一次：日志 `直连引擎 已发言（1690ms，57 字 / 3 条，工具：无）`，日记没写、说说没发；抽函数后 18:49 同一条链路 `工具：qq_diary_write,qq_post_qzone`，`state/diary/2026-10-24.md` 与说说都真的落地了。回归里用「`diaryRitualPromptText(key)` 出现 ≥2 次、`reason === 'diaryRitual'` 出现 ≥2 次」两条断言防漂移。
- 去重靠 `state/diary-publish.json`（`{day, attempts, lastAttemptAt, keys}`）+ 日记文件里最后一条时间戳（`diaryWrittenSince()`）：**先记账再唤醒**，投递失败或重启都不会同一分钟反复叫。
- 发说说要过梯队门禁：主人是第一梯队，私聊里能发；群里别人的请求会被拒（提示词里让她一句话说明，不许偷偷绕过）。
- 关掉：`socialV2.diary.publish.enabled = false`。

## 长期记忆归档（dsh-qq-extras，可选）

[`dsh-qq-extras`](https://www.npmjs.com/package/dsh-qq-extras) 会把「主人 ↔ 小鲸鱼」的对话存成一份可检索的归档，并定期让模型压成摘要，给 AI 一个跨会话的长期记忆。它自带的采集器读的是 `<BRIDGE_DIR>/state/qq-activity.log`，而那份日志的入站行长这样：

```
[00:12:34] <会话 key> [reserved2] 消息已入未读：在吗
```

——**没有说话人身份**，而插件只认 `管理员 <昵称>：` / `agent 回复：` 两种说话人（别的行一律丢弃）。所以我们**不动**活动日志（它被控制台 UI 与既有测试消费，且只留 500 行），让桥接多写一份 `state/qq-memory.log`：

| 行 | 谁来写 | 说明 |
| --- | --- | --- |
| `[HH:MM:SS] <key> 管理员 <昵称>：<text>` | `src/bridge.js` 入站分支（`appendMemoryLog`） | 主人说的话，带真实昵称 |
| `[HH:MM:SS] <key> 成员 <昵称>：<text>` | 同上 | 群里其他人（插件原生不认，我们自己的采集器认） |
| `[HH:MM:SS] <key> agent 回复：<text>` | 同上，出站（`recordSentMessagesV2`） | 小鲸鱼发出去的所有文字（AI 回复 / 工具发送 / 控制台发送） |

- 格式、解析、行数上限都在 `src/qqb/memory-log.mjs`：默认留 `memoryLog.maxLines = 5000` 行，单条正文截到 800 字、压平成一行并脱敏；**写失败只吞不抛**（归档绝不能拖垮收发）。入站那笔挂在「暂停 / 休眠 / 晚安」几个提前 return **之前**——暂停只表示现在不回，不代表这段对话不该被记住。
- 归档器是我们自己的 `scripts/qq-extras-collector.mjs`（**不用**插件自带的 `collector.mjs`：它的日志路径、`BRIDGE_DIR` 与正则都写死了，插件一升级就丢）：读 `state/qq-memory.log` → 按整行 sha1 去重 → 调插件的 `lib/archive.mjs#appendMessage()` 落盘到 `~/.dsh/qq-memory/archive/`（`QQ_EXTRAS_DATA` 可改）；攒够 `summaryEvery`（默认 30）条才触发一次插件摘要，且 10 分钟冷却——摘要会真的开一轮模型，别让它被计划任务反复触发。
- 手动跑/查归档：`npm run extras:collect`（采一轮）/ `npm run extras:status`（看归档现状）/ `npm run extras:recent`（最近 20 条，`-- --recent 50 --peer private:123456789` 可调）/ `npm run extras:search -- 关键词`（全文检索，可配 `--limit` / `--role`）；`--dry-run` 只统计、`--no-summary` 不烧 token、`--watch` 常驻。
- 计划任务：`qq-bridge-memory-collector` 每 5 分钟跑 `scripts\qq-extras-collector-task.bat`，自己的日志在 `state/qq-extras-collector.log`（node 侧保留最后 5000 行）。
- 想关掉：`memoryLog.enabled = false`（桥接不再写流水，采集器自然没东西可采）。
- 插件自带的 MCP server（`mcp-qq-extras`，让 AI 自己查归档、发语音/表情包、画图）**由本仓库的启动壳挂上**：`npm run extras:patch` 会把插件 `cordis.patch.yml` 里的 `command: npx -y dsh-qq-extras@0.1.0` 换成 `node scripts/qq-extras-mcp.mjs`——这个壳会在加载插件 `mcp.mjs` **之前**补齐上游漏发的 `lib/comfy.mjs`（源文件在 `dsh/qq-extras-patch/lib/comfy.mjs`，逐字节比对，缺了/被换过都会补），并把 `QQ_BRIDGE_DIR` 默认指到本仓库。**打完补丁要重启 DSH 才生效**（bundle 在启动时读）；`dsh plugin` 重装插件会覆盖插件目录里这两处改动，重跑一次 `npm run extras:patch` 即可，`npm run extras:patch:check` 用来探测漂移（需要打补丁时 exit 1，适合挂进日常自检）。找归档目录靠 `QQ_EXTRAS_DATA`（默认 `~/.dsh/qq-memory`；DSH 会把 `DSH_*` 这类变量从子进程环境里过滤掉，`QQ_*` 能透传）。
- 画图（`image_generate` / `image_models`，需要本机有 ComfyUI）：`dsh/qq-extras-patch/lib/comfy.mjs` 就是上游漏发模块的规范副本，四个风格（`anime` Animagine XL 4.0 / `anime-sd15` Counterfeit V2.5 / `realistic` Realistic Vision V5.1 / `general` SDXL Base）按 ComfyUI `/object_info` 里的**真实清单**解析 checkpoint（也认 `COMFYUI_CHECKPOINT_<STYLE>` 与 `COMFYUI_MODELS_DIR`），尺寸/步数按底模给（SD1.5 不给 1024），产物落 `<DATA_DIR>/images/`。ComfyUI 没起来、或清单里没有这个模型时给中文错误说明该怎么办，**不会**退回"随便找一张图"。
- 回归：`npm run test:qq-extras`（归档链路：行格式、插件正则兼容、解析正反例、写入上限、源码接线，以及**夹具内端到端**——真跑 `handleIncoming` + `recordSentMessagesV2`，断言 `state/qq-memory.log` 里正好那三行）+ `npm run test:qq-extras-mcp`（comfy 纯模块、假 ComfyUI 端到端、启动壳/补丁状态、以及**真 stdio MCP 握手**：initialize + tools/list + 真调 `memory_stats` / `image_models`）；本机没装插件时后两层自动 SKIP，别的机器上也能跑。
- 挂到**正在运行的那个 profile**：插件包装进 profile（`dsh plugin --profile <名字> add dsh-qq-extras`）之后，要么把 `dsh-qq-extras` 加进该 profile `package.json` 的 `dsh.profile.bundles`（走插件自带的 bundle patch），要么——本机 DSH Desktop 用的 `desktop` profile 就是这样，插件装在 `web` profile、桌面 profile 只借它——直接在该 profile 的 `cordis.patch.yml`（"profile patch 层"，在 bundle 层之后应用）末尾插一条，**不会**和别的层重复注册：
  ```yaml
  - insert:
      - id: mcp-qq-extras
        name: '@deepseek-ai/dsh-mcp-client'
        config:
          serverName: qq-extras
          transport: stdio
          command: 'C:\Program Files\nodejs\node.exe'
          args:
            - 'D:\34825\zhuomian\youqq\qq-bridge\scripts\qq-extras-mcp.mjs'
            - '--plugin-dir'   # 插件就装在这个 profile 里时，这两行可以省掉（壳会自己找）
            - 'C:\Users\34825\.dsh\profiles\web\node_modules\dsh-qq-extras'
          toolCallTimeoutMs: 300000
  ```
  本机已按上面这段挂到 `~/.dsh/profiles/desktop/cordis.patch.yml`（原文备份 `cordis.patch.yml.orig-qqextras`），**重启 DSH 后 `mcp-qq-extras` 的 12 个工具才会出现**；那条命令行本身由 `npm run test:qq-extras-mcp` 的第四层真握手覆盖（`--plugin-dir` 就是这里写的值）。
- 已知限制：
  - 流水只在 **reserved2 模式**下写（当前运行模式）。老式 chat / closed-agent 走的是另一条入站分支，不写这份流水。
  - ~~**`dsh-qq-extras@0.1.0` 的 MCP server 起不来**~~（**本仓库已修**，实测 2026-10-24）：上游 tarball 里 `mcp.mjs:11` 无条件 `import { generate, listModels, serverUp } from './lib/comfy.mjs'`，而包里没有 `lib/comfy.mjs`（`lib/` 只有 archive/common/images/onebot/tts）⇒ 直接跑必 `ERR_MODULE_NOT_FOUND: …/lib/comfy.mjs`，**后果不是少了画图工具，而是一个工具都没有**（stdio MCP 起不来 ⇒ `memory_*` 上下文增强、表情包、语音、绘图全部连坐）；npm 上只有 `0.0.0-stage` 与 `0.1.0`，没有修好的版本可升。修法 = 规范副本 + 自愈启动壳 + `npm run extras:patch`（见上），`npm run test:qq-extras-mcp` 里有一层**真 stdio 握手**盯着它不再复发；上游发修好的版本后 `npm run extras:patch -- --revert` 可以还原。**归档链路本来就不受影响**（采集器只 import `lib/archive.mjs` 与 `summarize.mjs`，都不碰 `comfy.mjs`）。
  - 画图要本机 ComfyUI 在 `127.0.0.1:8188`（`COMFYUI_URL` 可改）且装了对应 checkpoint；ComfyUI 没装不影响归档、语音、表情包这些工具（`image_models` 会如实报 `online: false`）。

## 人员梯队与敏感动作权限（第一梯队 = 家里人）

**第一梯队**默认是主人（`ownerQQ`）加家里人名单（`socialV2.nightRitual.parents`，可用 `socialV2.tiers.first` 再补）。家里的群（`socialV2.nightRitual.greetGroups`，可用 `socialV2.tiers.firstGroups` 再补）算「家里人的频道」。

这套规矩有**两条口径，故意不一样**：

| 管什么 | 按什么判 | 效果 |
| --- | --- | --- |
| 优先与频次 | **频道** | 家里人的私聊/家庭群：唤醒优先级 +15、主动机会间隔与概率按原样；其他人：间隔 ×`others.intervalScale`（默认 1.6）、概率 ×`others.probabilityScale`（默认 0.6），也就是"往后排" |
| 敏感动作能不能做 | **请求人（谁在让她做）** | 只对第一梯队**和这个群的群主**开放；其他人提要求一律拒绝 |

敏感动作默认清单（`socialV2.tiers.sensitiveTools`，可改）：`qq_send_image`（发图）、`qq_send_voice`（发语音）、`qq_post_qzone`（发说说）、`qq_web_screenshot`（网页截图）、`qq_save_image`（存图）。入选标准是"发出去/存下来就收不回"。**文字与表情包不在其中** —— 那是她日常说话的方式，不该被权限挡住。

**群主也算信得过的人**（`socialV2.tiers.allowGroupOwner`，默认 `true`）：某个群里最后说话的人是**这个群的群主**时，跟家里人同一档——主人在「大鲸鱼」群里定的口径就是"只有群主或家里人在群里求才允许"。群主是谁从 OneBot 的 `get_group_member_list` 里认（找 `role === 'owner'` 的那一项，每 30 分钟缓存一次、并发查询合并成一次）；SnowLuma 的 `get_group_info` **不返回群主**，所以只能这么查。三条硬边界：① **只认本群**——别的群的群主号码在这里不产生任何权限；② **只在群聊里生效**——同一个人私聊她时不算群主档；③ **查不到就拒绝**——成员列表为空、调用失败、没有 owner 项，一律当"不知道"，fail closed（查不到不等于信得过）。想关掉这条：`"tiers": { "allowGroupOwner": false }`（关掉后提示词里也不再提群主）。

**她自己起的头**（`socialV2.tiers.allowSelfInitiated`，**默认 `false`**）：主人要的是"发图、发说说希望她**主动**用，不用等人求"。但私聊里判定"请求人"永远只能得到"对方"（`private:123` 就是 123 在让她做），所以**她自己想发**和**对方让她发**在状态里长得一模一样 —— 只能另外看两件事：① **唤醒原因**是她自己的时间（`browse`＝自己刷一会儿、`proactiveCheck`＝主动找话题；`replyCheck`/`timeout`/`nightWake` 等"可能是隔着一段时间的答复"的原因**一律不算**，否则等于开了一道"别人先开口、她睡一觉再补"的后门）；② **没人在等她回话**（她的最后一条消息不早于对方最后一条，`lastAiReplyAt >= lastIncomingAt`）。两条都满足才放行，日志里记成「自由时间，她自己起的头」。
默认关的原因是这是**放宽**的一侧：公开仓库里别人的部署不该被悄悄改口径，要显式打开（`"tiers": { "allowSelfInitiated": true }`；打开后提示词里才会多一句"自由时间里你想发图、发说说也行"）。除了这两条路径，**没有别人在里面**的那种情形（群里一次都没人说话、定时器唤醒）本来就不受梯队限制（`resolveRequester` 给出 `source: 'none'`）。

两条口径必须分开，否则必然出错（回归里逐个钉住了）：

- **家庭群里群友求发图 → 拒绝**：频道虽然是家里的，但请求人是群友；
- **爸爸在别的群里求发图 → 允许**：频道不是家里的，但请求人是家里人；
- **本群群主在群里求发图 → 允许**（`allowGroupOwner` 默认开；别的群的群主、认不出群主、私聊里都不算）；
- **她自己的主意 → 不受限**：定时器唤醒、她自己想发就发（没有"别人让她做"这回事）；自由时间里想发图/发说说还要把 `allowSelfInitiated` 打开、并且没人在等她回话（见上一段）。

判定**只看号码**：陌生人把「我是你爸爸」写在消息里，不产生任何权限（`scripts/test-security-tiers.mjs` 里有专门的冒名用例）。

群消息里**认不出号码**（消息没有 `userId`/`sender`）时按「其他人」办、宁可拒绝 —— 认不出来不等于家里人；只有"一次都没人说过话"（定时器唤醒、她自己起的头）才算没有请求人、不受限。号码过滤只要求"非空且全是数字"，**不判断位数**：配置里明明写了家里人的号码、却被代码静默当成外人，比放宽更危险（这正是回归里踩到过的坑）。

拒绝是怎么表达的：桥接的发送端点直接 403，并且**一条都不发、不记发送次数、不在聊天记录里留痕**（拒绝路径零副作用）；她会在那一轮里看到一句「这个我不做哦：…」，可以自己告诉对方做不了。提示词里也常驻一段【梯队】说明（行为层），工具层是硬门禁（两层互补 —— 提示词层被哄住了，工具层仍然拦得住）。

群聊打招呼：群里安静超过 `socialV2.proactive.greetAfterMs`（默认 6 小时）时，这个会话的主动机会会换成「打个招呼」口味 —— 她会主动问一句近况/道个早晚安，而不是干等别人开口。私聊不受这条影响。想验证：

```bash
npm run test:security-tiers   # 纯函数 + 真 bridge.js 的 403/放行/零副作用/提示词/配置开关
```

`qq_post_qzone` 是个特例：它直接调 SnowLuma 网关、不经过桥接发送端点，所以它**要求带 `key` 与 `token`**，动手前先问桥接的 `/api/socialV2/tier-check`；问不到就**不发**（fail closed，宁可这次不发，也不因为桥接不在就绕过去）。

发说说在她那边的入口：**直连引擎模式**（`model.enabled=true`）本来会把"发送类文本工具"从她的工具清单里藏掉（防止同一句话发两遍），2026-10-23 起 `qq_post_qzone` 与 `qq_night_greet` 从屏蔽名单里移出 —— 这两个都不是"把本轮文字发到当前会话"的工具（一个发到她的 QQ 空间，一个的正文由桥接自己组装、参数只有一个 `dream`），藏起来的实际后果只是**她发不了说说、睡醒了没法问安**。提示词里也补了一条【想发说说】说明（发到空间、不是当前会话；发出去收不回、别写隐私内容、一天一两条顶天）。

老实说清楚边界：这是**行为层 + 工具层**的护栏，不是操作系统级沙箱 —— 她被话术绕进去、在文字里答应别人什么，是拦不住的；但"发出去就收不回"的那些动作，动手那一刻会被工具层拦住。

## 发言失败 → 立刻停手 + 沉默 + 到点重试

主人明确要求：**系统提示发言失败、或者她已经被移出该群时，立刻停止尝试发送任何消息、保持沉默，30 秒后再试；消息不要一串全倒出来，要像人一样每条隔 3~5 秒**。两条都在出站链路里实现，且**按会话隔离**（一个群出事，不影响她跟别人说话）。

失败分几类，**处理方式故意不同**：

| 失败是哪一类 | 怎么认 | 桥接怎么做 |
| --- | --- | --- |
| 网关**明确拒绝**（被移出群 / 被禁言 / 没权限 / 风控） | retcode 在 `PERMANENT_RETCODES` 里，**或返回原话命中** `REJECTED_WORDING_RE` | **不进补发队列**（重试还是同一句拒绝）；本批剩余分条立刻停手；该会话沉默 `hardFailSilenceMs`（默认 10 分钟） |
| 本机到网关**发不出去**（网络断/超时/5xx/429） | 归类为可重试 | 这条落盘进补发队列（内容不丢）；本批剩余分条也不再往下试（避免把一批拆成"先到后到"）；沉默 `failSilenceMs`（默认 30 秒），窗口一过按顺序补发 |
| 其它被拒（参数错等，话术不含上述词） | 不可重试 | 停手 + 沉默 30 秒；本批剩余分条入队等窗口结束 |

- 沉默窗口**按会话**记（`sendSilence` Map，key 形如 `group:123` / `private:456`）：窗口内任何发送路径（一代 `sendToQQ`、二代 `sendMessagesV2`、补发队列的 flush）都不碰网关；
- 补发队列在沉默期内**跳过**该会话：条目留在队列里、**不消耗重试次数**，窗口一过照常补发（`src/qqb/net/onebot.mjs` 的 `skipKey`）；
- 每条之间 3~5 秒：`socialV2.send.burstIntervalMinMs`（默认 `3000`）/ `burstIntervalMaxMs`（默认 `5000`），间隔由 `computeGapsV2` 算、`clampGapV2` 夹住；再按 `longGapProbability` 概率插一次 5~10 秒的长停顿（像人打字时的走神）。

为什么"被移出群"要单独认出来：SnowLuma 真实日志里给的是 `result=110 err=发送失败，你已被移出该群，请重新加群。` —— retcode 110 **不在**永久失败表里，只看 retcode 就会把它当网络抖动塞进队列，接着 2/4/8… 秒地去敲一个已经把她踢出来的群。这条判据现在按**原话**匹配，比数字表稳。

配置（`config.json` → `socialV2.send`）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `failSilenceMs` | `30000` | 一般发言失败后的沉默窗口 |
| `hardFailSilenceMs` | `600000` | 疑似被移出/被禁言/风控时的沉默窗口（取 `max(failSilenceMs, 本值)`） |
| `burstIntervalMinMs` / `burstIntervalMaxMs` | `3000` / `5000` | 分条之间的间隔 |

```bash
npm run test:send-silence   # 沉默窗口 / 停手 / 队列跳过 / 失败分类（真 bridge.js + 真 outbox）
```

老实说清楚边界：**"到点重试"靠补发队列**（`socialV2.outbox.enabled !== false` 时默认开）。队列关掉时沉默仍然生效，但失败的那条不会自动补发 —— 那是"只沉默不重试"。另外补发队列 flush 时**不复查白名单**（见「已知限制」）。

## 已知限制

- agent 回复在回合结束时一次性发送（不做流式逐字转发）；回复超过 `socialV2.send.maxMessageChars`（默认 500 字，可用 `social.maxReplyChars` 调整）自动按句读/URL 边界分段
- 图片及部分表情可以通过安全下载接入多模态模型；语音/视频以及无法取得图片字节的消息仍使用占位文本
- **发**语音是支持的（独立工具的图形界面 / 命令行 / AI 工具，见 `docs/README.md` 的文档索引；AI 还能用本机 TTS 当场合成，见「发语音」）；但**收**到的语音目前只显示占位文本，不做语音转写入上下文
- **AI 发语音默认关闭**（`socialV2.voice.enabled` 与 `tools.sendVoice` 默认 `false`）：先把音频放进 `audio/`，再到控制台打开开关；你自己发语音不受这个开关影响。打开后 AI 也可以当场用本机 TTS 合成（Windows 自带声音，不需要 ffmpeg；想用真人音色见「真人音色（GPT-SoVITS，可选）」，那要另起一个本机 Python 服务）
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- `@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，本仓库通过 postinstall 补丁修复（见 `scripts/patch-snowluma-sdk.mjs`）
- `scripts/test-dsh-v2-wait.mjs`（`npm run test-wait:e2e`）要一次**独立的** DSH 回复，且会话工具清单里得有 `qq_wait_for_messages`：本机实测单独跑 15s 就结束、但 `HAS_qq_wait_for_messages=false`；跑能力自测时机器正被当前会话占用，必然吃满 120s 超时。属 DSH 侧集成待查，不是 QQ 能力缺失（`npm run test:capabilities` 把它算作跳过）
- 补发队列（`state/outbox.jsonl`）在 flush 时**只做沉默期与去重检查、不复查白名单/模式**：一条消息在入队时是合法的，之后该群被移出 `allow.groups`（或模式切到 chat/reserved），队列里剩下的条目仍会被补发出去。要彻底堵住得把 `skipKey` 也接上"当前是否仍允许发这个 key"——目前是已知缺口，不是已修行为
- `scripts/test-console-ui.mjs` 需要 Playwright（本机未安装时跳过）；`scripts/test-onebot-connection.mjs` 连 WS 用的是**发现到的 WS token**，不是 `config.json` 里那个 HTTP token（两个值不同，见上文「已知行为」）

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
