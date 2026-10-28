# 小鲸「潘多拉魔盒」：活人化记忆与状态系统（实现规格）

> 依据：2026-10-29 主人给的任务书（六层记忆 / 状态机 / 提示词约束 / 抗遗忘四件 / 记忆厚度四件 / 五 Tab 面板）。
> 原则：**物理一套 SQLite，逻辑分层；所有过滤在 SQL 之前就硬拦，不靠提示词自觉**。

## 0. 现状盘点（改之前就有的）

| 任务书要求 | 现状 | 差距 |
| --- | --- | --- |
| 精神值 / 饥饿 | `src/qqb/persona/spirit.mjs`（0.1.0，已接线） | 缺心跳 cron 的自然流失与随机念头联动 |
| 单句 / 1 秒停顿 | `planSocialTimeline` + `sendPauseMs`（已接线） | 输出解析层没做「句号截断」硬兜底 |
| 遗忘曲线 | `ebbinghaus.mjs` 权重/retention/depth | 没有 `archived` 状态，只有 `expires_at` |
| 作用域隔离 | `recall({scope})` + `allScopes` | 没有 Owner/Friend/Group/Self 的关系层 |
| 原文底账 | `state/history/*.jsonl` + `intake.mjs` 候选 | 没进库、不参与召回（正好符合 L2 定位） |
| 事实提炼 | `refine.mjs`（PROMPT_VERSION 1） | 提炼 prompt 要加「感官细节/潜台词/情绪戳」 |
| 向量 + 关键词 | `embed.mjs` + bigram | 缺「实体 → 记忆」的联想索引 |
| 日记 | `state/diary/*.md` + `qq_diary_write` | 没有分级（日常/重要/刻骨铭心）与做梦条目 |

## 1. 六层记忆（逻辑分层，一张表）

`memories` 表新增 **`mem_level`** 字段（L1–L6），与现有 `layer`（private/normal/group，历史字段）并存：

| 级别 | 含义 | 写入者 | 是否参与召回 | 检索方式 |
| --- | --- | --- | --- | --- |
| L1 | 固化人设 / 铁律 / 身份 | 人（`persona.md`、`ENGINE_RULES`） | 固定注入，不检索 | 全文注入 |
| L2 | 原话底账（Messages） | `bridge.js` 落 `history/*.jsonl`，同步 `messages` 视图 | 否 | 只在「她要查原文」时按 id/时间取 |
| L3 | 片段（Episodes，一场对话的起因-经过-结果） | 巩固 cron 从 L2 切 | 是（低优先） | 向量 + 关键词 |
| L4 | 事实（Facts，提炼主力） | `refine.mjs` | **是（主力）** | 向量 + bigram + 实体 |
| L5 | 索引卡（Index Cards，≤50 字概览） | 巩固 cron 生成 | 是（每次注入 5 张） | 按相关度 |
| L6 | 日记（Diaries，长文/做梦） | `qq_diary_write` + dream cron | 是（情绪锚点优先） | 关键词 + 情绪戳 |

映射约定：现有 `kind`（fact/preference/event/promise/topic/impression）保留不动，`mem_level` 由 kind + 来源推导：
`fact|preference|impression → L4`、`event|topic → L3`、`promise → L4`、`diary → L6`、`card → L5`、`message → L2`。人设不进表（`persona.md` 即 L1）。

## 2. 硬过滤（Owner / Friend / Group / Self）

`scope` 已有 `private:<qq>` / `group:<gid>` / `global`。新增 **关系层** `rel`：

- `owner`（`cfg.allow.ownerQQ`）→ 可见 owner + 自己的 private + 当前群 + global
- `friend`（白名单其他人）→ 自己的 private + 当前群 + global，**永不跨 private**
- `group`（群会话）→ 当前群 + 该群成员的「群内可见」记忆 + global
- `self`（她主动检索）→ 全库，但结果必须带来源标签

实现：`recall()` 增加 `audience: { rel, key, ownerQQ }`，在拼 SQL 前算 `scopeWhitelist`，`where scope IN (...)`；`allScopes` 仅当 `rel === 'self'` 才允许。**分享**：新增 `shares` 表（`kind, scope, target, created_at, expires_at`），小鲸用 `qq_memory_share` 主动把某条 share 给某个 target，recall 时把 share 进来的 scope 加进白名单。

## 3. 归档（不是删除）

- `memories` 加 `archived_at INTEGER`、`archive_reason TEXT`。权重 `weight < 0.12` 且 30 天未被 `use_count` 增加 → 归档（`archived_at` 置位，不删）。
- 归档条目不进向量召回、不进索引卡；**只有显式关键词精确检索**（`recall({ query, includeArchived: true, exact: true })`，走 FTS）才唤起，命中后 `use_count++` 并「复职」（清 `archived_at`）。
- 面板「记忆库」Tab 可手动改权重 → `PATCH /api/pandora/memories/:id`。

## 4. 巩固 / 做梦（离线压缩）

新增 `src/qqb/memory/consolidate.mjs`：

1. 输入：某个 scope 当天 `history/*.jsonl`（L2）。
2. `buildConsolidateMessages()`：三步 prompt —— ①切 L3 片段（一场对话一条：时间/人物/起因/经过/结果）；②抽 L4 事实（复用 `refine.mjs` 的 kinds）；③每条 L4 写一张 L5 索引卡（时间/人物/起因/结果/当时情绪，≤50 字）。
3. 写库：L3/L4/L5 各带 `evidence`（原文行号）与 `emotion`/`sensory` 戳。
4. `dream({ scope })`：随机抽 2–3 条近期 L3/L4 → 生成一段荒诞/隐喻独白 → 存 L6（`kind='diary'`, `meta.kind='dream'`），并在次日提示词里带一条「我昨天梦到……」。
5. 触发：夜间睡眠开始后 10 分钟跑一次（`nightSleep` 钩子），外加 `scripts/consolidate-now.mjs` 手动跑。

## 5. 上下文折叠 + 情绪锚点

- `loop.mjs` 维护 `ctxTokens` 估算（`chars/1.6` 中文近似）；≥70% 窗口时：把最老 N 条消息用 `summarizeWindow()` 压成一句「核心事件 + 情绪基调」，插到 system 顶部 `[窗口摘要]`，再从 history 里裁掉。
- 锚点：`recall` 结果里 `emotion >= 0.7` 或 `meta.anchor` 的条目打 `[L2_Anchor]`，写入 `state/anchors.json`，之后 100 轮内每轮 **强制注入**（不受窗口裁剪影响）。
- 注入形态：`【你心里一直过不去的事】…`，最多 3 条。

## 6. 关键词触景生情（实体联想）

- `entities(text)`：抽 2–4 字名词/专名（去停用词、去人称），写 `memory_entities(entity, memory_id, weight)`。
- 输入命中实体 → 直接 `SELECT` 该实体下 L3/L4 各 ≤3 条，注入 `【突然想起来的】` 段，标记 `flashback=true`。
- 与向量检索并列，不互相替代（任务书原话：不要只依赖向量）。

## 7. 记忆厚度

- **情感切片**：`memories` 加 `sensory TEXT`（感官戳）、`subtext TEXT`（内心潜台词）。提炼 prompt 强制要求「用当时的心跳/温度/声音写，不写摘要」。
- **闪回**：注入时若 `emotion >= 0.8`，附 `flashbackHint`（先写情绪停顿，再带画面）。提示词规则 `【闪回】`。
- **记忆偏差**：`recall` 对 `age > 90 天` 的条目，text 随机截断 0–15%，并在 meta 标 `fuzzy:true`；提示词 `【记忆是主观的】`（日期可以记错，情绪必须对）。
- **残缺之美**：`emotion >= 0.85` 的条目只给「半句话 + 标点」（取最后一句话的前 60%），提示词要求她用自己的话补完。
- **执念**：`thoughts.mjs` 里对 `emotion >= 0.85` 的记忆给额外 `urge` 与冷却，允许无关话题里突然提起。

## 8. 状态机（补完）

- `spirit.mjs` 已是 0.1.0：8 小时睡满回满、12 小时后消耗翻倍、甜食 +0.22 / 饥饿 +0.3。
- 新增 `heartbeat()`（每 30 分钟）：自然流失 `drainPerHour × 0.5 × fatigueFactor`；饥饿 +0.025；`spirit < 0.25` 时 30% 概率产生「困/饿」念头；写 `state/spirit.json`。
- 打盹：`napMinutes` 上限 30 分钟/次、每天 2 次，恢复 `0.12 × 分钟/60`。

## 9. 五 Tab 面板（`/pandora`）

**决策**：DSH 本体是打包后的 Electron（`app.asar`），客户端插件要打进 DSH 自己的构建产物；因此面板做成**桥接自带的独立 Web 应用**（`http://127.0.0.1:3100/pandora`），纯静态 + 桥接 REST，不依赖 DSH 内部 UI API。好处：随时可用、手机同网可看、日后要包成 DSH 插件也只是套一层壳。

| Tab | 数据源 | 操作 |
| --- | --- | --- |
| 记忆库 | `GET /api/pandora/memories?level=L3,L4&q=` | 改权重 `PATCH`、归档/复职、看原文底账 |
| 日记本 | `GET /api/pandora/diaries?grade=` | 分页读全文、按等级筛选 |
| 人格状态 | `GET /api/pandora/persona`（人设 + spirit + mood + thoughts） | 打盹/吃甜/设定精神（复用 `/api/socialV2/spirit`） |
| 收藏夹 | `GET /api/pandora/gallery`（`state/stickers` + `audio/songs` + 表情包目录） | 预览、下载 |
| 人物档案 | `GET /api/pandora/people`（人名簿 + 每人记忆条数 + 最近互动） | 展开看某个人的记忆时间轴 |

鉴权：与现有控制台一致，`x-console-token`；浏览器首次访问用 `?token=<console-token>` 换 cookie（`pandora=<token>`，HttpOnly、SameSite=Lax）。

## 10. 交付顺序

1. **P1 记忆核心**：`mem_level` / `archived_at` / `sensory` / `subtext` / 关系硬过滤 / 归档与复职 / `PATCH` 权重。
2. **P2 面板**：五 Tab + 鉴权 + 只读优先（写操作只做权重/归档）。
3. **P3 巩固与做梦**：consolidate + dream + 夜间钩子。
4. **P4 上下文层**：折叠 + 锚点 + 索引卡 + 实体联想 + 闪回/偏差/残缺 prompt。
5. **P5 状态机心跳** + 文档 + 全量 audit。

每步都要：`node scripts/test-audit.mjs` 全绿、README 记一节、`git commit`（推送受网络限制时先本地）。

## 11. 实现进度（2026-10-29）

| 子项 | 状态 | 位置 |
|---|---|---|
| P1 记忆核心（`mem_level`/`archived_at`/`sensory`/`subtext`/`memory_entities`/`shares`/关系硬过滤/归档复职） | 已合入 | `src/qqb/memory/store.mjs`（schema v5）、`scripts/test-qqb-memory-levels.mjs` |
| P2 面板五 Tab | 已合入 | `qq-bridge/panel/{index.html,app.js,style.css,views/*}`、`src/qqb/pandora-api.mjs`（`/pandora`、`/api/pandora/*`） |
| P3 巩固 + 做梦 | 已合入 | `src/qqb/memory/consolidate.mjs`、`bridge.js` 的 `consolidateNow()` + 睡前 10 分钟钩子 + `POST /api/socialV2/consolidate` |
| P4 上下文层 | 部分 | 记忆厚度四条规则已进 `ENGINE_RULES`；折叠/锚点/索引卡/实体联想待接 |
| P5 心跳 + 文档 | 部分 | 精神心跳（30 分钟）已接；README 与全量 audit 待收尾 |

判定口径：面板只做「看 + 调权重 + 归档/复职」，不做删除（任务书要求“归档不删除”）；`/api/pandora/*` 全部要求控制台令牌。