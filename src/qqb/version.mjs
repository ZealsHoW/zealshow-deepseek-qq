// qqb（小鲸鱼主体）模块版本登记表 —— R7「每次改动打版本标记」的唯一权威来源。
//
// 规矩（改代码的人/代理都要守）：
//   1. 改动某个模块的文件后，把 MODULES 里对应条目的 version 递增（semver），
//      并同步顶部 QQB_VERSION（取所有模块里的最大值语义，仅作总览）。
//   2. 发布前跑一次 `node scripts/module-version.mjs snapshot <module>`：
//      它把该版本的文件整份复制到 `_backups/versions/<module>/<version>/`。
//   3. 线上出问题时 `node scripts/module-version.mjs rollback <module> [version]`
//      可一键退回上一稳定版（回滚前会 `node --check` 每个 .js/.mjs）。
//
// 这个表也是 `scripts/qqb-health.mjs` 与健康上报里 version 字段的来源：
// 模块自己导出的 VERSION 必须与本表一致（test-qqb-core.mjs 会核对，防止漏改）。

// 注册表里 `qqb/version` 这一条自己的版本。两个名字并存：这个文件既被当作
// 「模块」（导出 VERSION，供 module-version verify / 健康上报核对），又是整包总览
// （导出 QQB_VERSION）。它们必须相等，否则 verify 会当场报错。
export const VERSION = '0.1.7';
export const QQB_VERSION = VERSION;

/** @type {Record<string, {version: string, files: string[], note: string}>} */
export const MODULES = {
  'qqb/version': {
    version: '0.1.7',
    files: ['src/qqb/version.mjs'],
    note: '模块版本登记表与回滚入口',
  },
  'core/log': {
    version: '0.1.0',
    files: ['src/qqb/core/log.mjs'],
    note: '结构化 JSONL 日志：分级、按天分文件、密钥脱敏、内存环形缓冲',
  },
  'core/config': {
    version: '0.1.0',
    files: ['src/qqb/core/config.mjs'],
    note: 'config.json 读写：mtime 缓存、点号取值、原子写入（无 BOM）',
  },
  'core/bus': {
    version: '0.1.0',
    files: ['src/qqb/core/bus.mjs'],
    note: '进程内事件总线：监听者异常隔离、通道历史可回放',
  },
  'core/health': {
    version: '0.1.0',
    files: ['src/qqb/core/health.mjs'],
    note: '模块健康登记与汇总：ok/degraded/down、降级回调、结果缓存',
  },
  'core/lifecycle': {
    version: '0.1.0',
    files: ['src/qqb/core/lifecycle.mjs'],
    note: '模块启停编排：依赖顺序、单模块失败只降级不整体退出、优雅停机',
  },
  'core/call-log': {
    version: '0.1.0',
    files: ['src/qqb/core/call-log.mjs'],
    note: '工具调用落盘（F 补）：引擎与 DSH 两条链路写同一个 state/tool-calls.jsonl，共用行数上限与轮转；按键名脱敏凭据、超长截断、危险键不落盘',
  },
  'checks/services': {
    version: '0.1.9',
    files: ['src/qqb/checks/services.mjs'],
    note: 'R3 实测探针：OneBot 网关 / 桥接控制台 / 常驻 MCP / Hindsight / state 可写 / 记忆库可打开 / 发送队列积压 / 情绪状态（R2）/ 人设演化与干预（R1b+R5）/ 定向投递待办（R8）/ 媒体能力与失败率（R6）/ 模型直连配置（F）；0.1.9 起 checkBridge 读管理端 presetHealth.broken：DSH 报「装配失败」的 preset 让这个探针报 degraded（此前只认 dshReady，preset 坏了 30 多个小时它一直报 ok——就是那个假绿灯）',
  },
  'memory/store': {
    version: '0.4.1',
    files: ['src/qqb/memory/store.mjs'],
    note: 'R1 记忆库：SQLite 分层记忆（private/normal/group）、重复事实合并、提炼配额、人设演变审计（R1b）。0.1.1 起 schema v2：archived_at；0.2.0 起 schema v3：emotion + 艾宾浩斯（weight/retention/depth）；0.3.0 起 schema v4：vectors 表 + 字面/向量混合检索；0.4.0 起 schema v5（潘多拉）：mem_level L2–L6、sensory/subtext 厚度、memory_entities 实体倒排、shares 分享、audience 关系硬过滤（owner/friend/group/self）、archiveSweep 归档清扫 + exact 复职、面板 listMemoriesForPanel/setMemoryWeight/setMemoryArchived',
  },
  'memory/live': {
    version: '0.4.1',
    files: ['src/qqb/memory/live.mjs'],
    note: 'R1 接线层：会话 key→分层、桥接写入镜像、唤醒提示注入块（跨会话召回）。0.3.0 起按遗忘权重从重到轻排（重的在前、淡的沉底），search()/warmVectors() 走语义向量；0.4.0 起 block()/recall() 带 audience 硬过滤（这一刻对面是谁），新增 audienceOf()、cards()（L5 索引卡）、flash()（实体触景生情）',
  },
  'memory/consolidate': {
    version: '0.1.0',
    files: ['src/qqb/memory/consolidate.mjs'],
    note: 'P3 巩固与做梦：把当天 L2 原话复盘成 L4 事实 + L3 情节 + L5 索引卡（禁止写「主人没理我」式摘要，要感官细节与潜台词）；做梦把近期记忆熬成 120–220 字荒诞隐喻存进日记（meta.kind=dream）；进度落 state/consolidate.json，记录太少就跳过',
  },
  'pandora/api': {
    version: '0.1.0',
    files: ['src/qqb/pandora-api.mjs'],
    note: '潘多拉魔盒后端：/pandora（console-token 换 HttpOnly cookie）、/pandora/<静态页>、/pandora-data/<白名单目录>、/api/pandora/{memories,memories/:id,memories/:id/archive,diaries,persona,gallery,people,health,spirit}；只作面板用，不改她的行为',
  },
  'memory/intake': {
    version: '0.1.0',
    files: ['src/qqb/memory/intake.mjs'],
    note: 'R1 摄入层：历史 JSONL 定时抽事实入库（规则式、免费、断点水位、提炼配额），不烧 token',
  },
  'memory/refine': {
    version: '0.1.1',
    files: ['src/qqb/memory/refine.mjs'],
    note: 'R1 精炼层：跨会话说一次小模型调用，把最近历史蒸馏成长期记忆（写库走 source=llm-extract，吃 store 的提炼配额）；省 token 的硬边界：一轮最多一次调用、输入裁剪、新增不足 minNewRecords 不调、每天最多 maxRunsPerDay 轮、失败不推进水位。0.1.1 起提示词按**公平份额**分配字符预算（每会话最多 maxLinesPerGroup=80 行、先各分一份预算），并在规矩里要求「多个会话时每会话先挑 1 条」——第一轮真机上 8 条事实全来自群聊就是这个坑',
  },
  'net/backoff': {
    version: '0.1.0',
    files: ['src/qqb/net/backoff.mjs'],
    note: 'R4 退避器：指数增长 + 上限 + 抖动，重连/补发共用',
  },
  'net/outbox': {
    version: '0.1.0',
    files: ['src/qqb/net/outbox.mjs'],
    note: 'R4 持久化发送队列：JSONL 追加日志、有序补发、dedupKey 去重窗口、上限与超期丢弃',
  },
  'net/onebot': {
    version: '0.1.0',
    files: ['src/qqb/net/onebot.mjs'],
    note: 'R4 OneBot 统一出口：鉴权/超时/retcode 判定、失败分类、失败落盘与 flush 补发',
  },
  'net/inbound': {
    version: '0.1.0',
    files: ['src/qqb/net/inbound.mjs'],
    note: 'R4 入站去重：message_id/seq 引用记忆 + TTL + 上限，防止重连重放被处理两遍',
  },
  'persona/mood': {
    version: '0.1.2',
    files: ['src/qqb/persona/mood.mjs'],
    note: 'R2 情绪/状态机：mood/energy/irritation/social 四维、事件驱动 + 时间衰减、行为门控建议、跨重启持久化。0.1.1 修精力收支：warm_chat 的 energy 由 -0.02 降到 -0.005——原值下光是「被搭话」每小时 6 条就把恢复额（约 +0.12/h）吃光，精力被钉死在 0，「主动开口」的闸门（energy ≥ 0.25）永远够不着（配套改动在桥接侧：一次回复只记一次 own_reply）。0.1.2：家人的夸奖/鼓励/「爱你」开始真的补精力（praised +0.06、新增 loved +0.12），loveWords/negations 两个词表把「疼爱」和「嫌弃」分开；新增 setDim(name,value) 走实例做手动校准（直接改 state/persona-state.json 会被内存旧值盖掉），配套 POST /api/socialV2/mood 与 scripts/set-mood.mjs',
  },
  'persona/spirit': {
    version: '0.1.0',
    files: ['src/qqb/persona/spirit.mjs'],
    note: 'R9 精神系统（活人化）：精神/饥饿/清醒时长三件事，行为花精神、睡觉按指数曲线回满（睡满 sleepHoursToFull 才满）、清醒超 fullRestHours 消耗翻倍、甜食立刻补但更饿、打盹有日上限；只给建议（gate/replyBudget），精神低就把回复锁短，绝不拦死回复；状态落 state/spirit.json，时间推进用 lazy tick',
  },
  'persona/thoughts': {
    version: '0.1.0',
    files: ['src/qqb/persona/thoughts.mjs'],
    note: 'R9 念头系统（活人化）：她自己的小想法（没回的话/兴趣/记忆/身体感觉/随机），每条带 urge；攒够 due() 才主动开口，有冷却、超 6 小时作废，做过就标记不再重复；状态落 state/thoughts.json',
  },
  'persona/evolve': {
    version: '0.1.3',
    files: ['src/qqb/persona/evolve.mjs'],
    note: 'R1b 人设演变：规则式推导特征（记忆里关于她自己的事实 + 历史时间分布）、只改人格卡受管区块、写前备份 + 审计 + 可回滚；0.1.1 加「底线」类特征与聊天碎片过滤；0.1.2 修错位（规矩/约束一律归底线，不再标成近况）+ 区块标题改成「她自己的长期特征」；0.1.3 读取时归一化老表（第三人称转第一人称、清掉记忆推来的聊天碎片、老错标挪到「底线」，主人拍过板的建议不动）',
  },
  'persona/intervene': {
    version: '0.1.0',
    files: ['src/qqb/persona/intervene.mjs'],
    note: 'R5 人设干预：提案队列（仅主人可提）、她自己可采纳/拒绝、主人可撤回、全流程留档',
  },
  'directed/direct': {
    version: '0.1.0',
    files: ['src/qqb/directed/direct.mjs'],
    note: 'R8 定向投递：主人托付进独立队列、她定夺（可拒绝/改口）、发送后回执原窗口、主人可撤回、全程留档',
  },
  'media/providers': {
    version: '0.1.0',
    files: ['src/qqb/media/providers.mjs'],
    note: 'R6 媒体能力：识图走 provider（默认本机 Ollama qwen2.5vl）；图生图 / 视频帧解析接口已预留（未接入时给可识别错误 MEDIA_NOT_SUPPORTED），换模型或接云端不用改调用点',
  },
  'model/client': {
    version: '0.1.1',
    files: ['src/qqb/model/client.mjs'],
    note: 'F：引擎直连模型 API（OpenAI 兼容 /chat/completions，百炼或 DeepSeek 均可）；密钥按 config.apiKey → 环境变量 → DSH 凭据文件 refs 三级解析且日志脱敏（sk-ws- 形式也打码），429/5xx/网络错按退避重试，支持 extraBody/extra 透传兼容参数（enable_thinking=false 实测省 6 倍 completion token），默认 enabled=false 不切主链路',
  },
  'engine/toolbox': {
    version: '0.1.2',
    files: ['src/qqb/engine/toolbox.mjs'],
    note: 'F：直连引擎的工具箱——从常驻 MCP 服务(3210)现拉 tools/list 合并成 OpenAI function 清单，tools/call 按名字找归属端点；会话参数 key/token 对模型隐藏、调用时由引擎注入；结果超 4000 字截断。0.1.1 修会话参数注入：要补哪些 key/token 改按 **schema 声明过的属性** 判（新增 sessionArgsOf 并写进 entry.session），不再按 required——key/token 在很多工具里是可选属性（qq_describe_image 一个 required 都没有），旧判据让它们永远补不进、模型又看不到 ⇒ 调用必然失败。0.1.2 修「图片被压成三个字」：tools/call 的结果里图片 part 原本被 map 成字符串「[图片]」、base64 直接丢掉，模型只收到那三个字 ⇒ 她会说「我看不到图」并开始回避图片话题；现在像素原样带出（images:[{mimeType,data}]，最多 MAX_RESULT_IMAGES=2 张、单张 base64 上限 8MB），由 loop.mjs 贴进多模态 user 消息',
  },
  'engine/loop': {
    version: '0.1.7',
    files: ['src/qqb/engine/loop.mjs'],
    note: 'F：直连引擎的对话回路——模型要工具就自己执行再塞回结果，最多 4 步；关键是 fallbackSafe：一个工具都没跑过才允许回退 DSH，跑过就绝不回退（否则消息发两遍）。0.1.1 起支持 request.intercept(name,args,entry)：宿主可拦下某个工具调用自己处理（返回 {ok,text,error} 当结果），拦下的调用同样计入「跑过工具」，拦截函数抛错会转成工具错误结果而不是炸掉整轮。0.1.2 起支持 toolLog(entry)：每执行一个工具（含被拦截、参数写坏、执行失败）回调 call/result 两条，供宿主落盘——此前引擎的工具统计只在内存里，引擎接管后 tool-calls.jsonl 整段变黑；钩子抛错只警告，绝不影响这一轮。0.1.3 修 injectArgs 的名单来源：改取 entry.session（toolbox 按 schema 声明算出来的），entry.required 只作旧形状兜底——旧判据让 key/token 这类可选会话参数补不进去。0.1.4 加两条「别哑掉」的护栏：工具**连续**失败 maxFailedToolCalls（默认 3）次就停手，不等步数烧光；步数用尽还没说话时再要一次不带工具的回复（rescued:true 就照常说话），并把失败的工具与次数写进 error 文本——此前工具一坏就是空烧 20～40 秒后一声不吭，日志里只有一句「达到最大步数还没说话」，查不出是哪个工具在坏。0.1.5 把工具取回来的图片真的送到模型眼前：OpenAI 兼容协议里 tool 消息只能放文本，所以照惯例紧跟一条 role:user 的多模态消息（text + image_url data URL）——此前工具箱把图片压成「[图片]」三个字，她等于对着一张写着「[图片]」的纸条说话。0.1.6 兜住「模型把工具调用写成了正文」：2026-10-22 00:25 她（browse 唤醒）把 `<tool calls>` + `<tool invoke name="qq_describe_image">` 这一段**原文当消息发进了 QQ**（主人收到的就是一堆标签）——XML 是模型的原生写法，而这条链路讲的是 OpenAI 的 tools/tool_calls，格式走岔时那段文本就没人接手；现在 parseTextToolCalls 把它翻回真正的调用照样执行、stripTextToolCalls 把标签从正文抹掉，桥接的 sanitizeEngineReplyV2 再兜一道',
  },
  'engine/compact': {
    version: '0.1.0',
    files: ['src/qqb/engine/compact.mjs'],
    note: 'P4 上下文折叠（PANDORA_SPEC §7）：上下文用到预算 70% 时，把最老那一段压成「核心事件 + 情绪基调」一句话插在历史最前面，腾地方给新消息；最近 keepRecent 条（默认 12）永远原样保留；折叠只减条目、不删原文（L2 底账在记忆库里）；estimateTokens 粗估中文字数、summarizeDropped 取窗口最后一句 + emotionTone 情绪词表；任何异常都返回原样，绝不因为折叠把一轮对话搞挂',
  },
};

/** @returns {string[]} 全部模块名 */
export function moduleNames() {
  return Object.keys(MODULES);
}

/**
 * @param {string} name
 * @returns {{version: string, files: string[], note: string}|null}
 */
export function getModule(name) {
  return MODULES[name] ?? null;
}

/** @param {unknown} value */
export function semverOk(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

/** 一行概览，给日志/控制台用。 */
export function describe() {
  const parts = moduleNames().map((name) => `${name}@${MODULES[name].version}`);
  return `qqb ${QQB_VERSION}（${parts.length} 个模块）\n${parts.join('\n')}`;
}