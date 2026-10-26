// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'test-audit-bridge.mjs', 'test-audit-protocol.mjs', 'test-audit-protocol-helpers.mjs',
  'test-audit-security.mjs', 'test-audit-security-mcp.mjs',
  'test-audit-setup.mjs', 'test-audit-setup-guards.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // scripts/test-dsh-session-retire.mjs）。
  'test-dsh-inbox-projection.mjs',
  'test-md-to-plain.mjs', 'test-slang-learn.mjs', 'test-mux-reconnect.mjs',
  'test-token-economy.mjs', 'test-qq-model-view.mjs', 'test-qq-preset-contract.mjs',
  'test-reply-wait.mjs', 'test-preset-prompt.mjs', 'test-role-card.mjs',
  // preset 的「源 → 生成 patch」契约与 {{cwd}} 兜底：2026-10-20 线上
  // `unknown prompt variable "{{cwd}}"` 事故的登记期回归（此前没进 audit 清单）。
  'test-agent-preset-patches.mjs', 'test-preset-prompt-vars.mjs',
  // 2026-10-21：qq-plugin-runtime 的 capabilities() 读了未 inject 的服务而抛错，
  // 导致 preset 变 agent-preset/invalid、QQ 会话建不起来（插件诊断里连 apply 都没有）。
  'test-qq-plugin-runtime.mjs',
  // 环境变化应对层：DSH 端口解析、错误→指南翻译、启动预检、一键体检。
  // 这些测试都离线、只读；doctor 的活 DSH 段不在 audit 里（见 npm run doctor）。
  'test-dsh-base-url.mjs', 'test-plugin-env-guide.mjs',
  'test-plugin-preflight.mjs', 'test-doctor-plugins.mjs',
  // 环境修复动作本身：稳定运行时副本 + profile 断链重指向/清理（都只读预演，
  // apply 走显式参数；测试用临时目录，不碰真实 ~/.dsh）。
  'test-sync-dsh-runtime.mjs', 'test-profile-link-repair.mjs',
  // 体检修复回归：无令牌智能体调用面、send-burst 失败回滚、唤醒限频重试、
  // 定时器类暂存唤醒补发、collector 生命周期、ownerQQ 覆盖语义、预设名校验、
  // wake triggers 白名单、memory-update 边界、wait 租约归一化、md/黑话/表情/账本；
  // 本轮新增：/api/send/* 失败路径的作用域错误（R15）、reserved2 落库丢表情识别字段（R16）。
  'test-audit-regressions.mjs',
  // 图片/表情链路（动图/表情包字段、CDN 优先与 emoji_id 兜底）+ 联网搜索
  // （DSH 同一路 DeepSeek 搜索、Bing RSS 兜底、凭据优先级与端点安全；
  //  本轮新增：空结果 note 必须在写缓存之前生成，否则缓存命中丢掉提示）。
  'test-media-search.mjs',
  // GitHub issue 回归：#22 模式 user 层优先 / #11/#19 回合判忙租约 / #29 机器人身份注入。
  'test-issue-regressions.mjs',
  // 二代「会话初始提示词」：只在首次唤醒注入、管理面隔离、损坏文件只读降级、
  // 以及控制台「立即唤醒」不得顶掉首次 bootstrap（否则初始提示词永远发不出去）。
  'test-v2-initial-prompt.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'test-token-usage.mjs', 'test-hardening.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'test-voice.mjs',
  // 音色微调（参考音频变调 + 轻 EQ）：只验变调数学/命名/滤镜顺序/--pitch 解析与文档接线
  'test-voice-tune.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'test-voice-volume.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'test-voice-edge.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'test-voice-gui.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'test-console-static.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'test-voice-system.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'test-snowluma-conn.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'test-encoding.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'test-console-encoding.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 QSH_PLAN.md §0.1/§5.2），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'test-preset-local-tools.mjs',
  // qq-mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'test-qq-mode-plugin.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'test-snowluma-upstream-health.mjs',
  // qqb 基础设施（阶段 A：core 骨架 + 健康上报 + 版本回滚）：
  //   版本登记表与模块导出的 VERSION 必须一致（登记了却对不上，回滚会装回错版本）；
  //   健康表里 critical 模块 down 必须把整体判成 down（这是看门狗唯一的判据）；
  //   生命周期单模块起不来只降级、不得连坐；探针连不上/超时一律转成状态而不是抛错。
  'test-qqb-core.mjs',
  // 记忆库（R1）：分层隔离是硬边界（群聊里召不到私聊记忆）、重复事实必须合并而不是堆积、
  // 提炼配额必须真的挡住超额写入（省 token 的开关在这里）、软删除要能复活、审计要能回滚。
  'test-qqb-memory.mjs',
  // 记忆接线层（R1 下半段）：会话 key → 分层（主人私聊 private / 其它 private normal / 群聊 group）；
  //   群聊提示词里绝不能出现私聊记忆；库打不开时整条链路静默降级而不是把桥接带崩；
  //   但「她主动检索」可以跨会话（2026-10-25 主人要的），默认注入仍然隔离。
  'test-qqb-memory-live.mjs',
  // 人名簿：把 private:123 / group:456 翻成「小祀」「大肥鱼之家」，跨会话检索才能说清「这是谁那边的事」；
  //   它只是标签、不参与准入；空/纯数字/「未知」不收；文件坏了当空簿子用，不抛错。
  'test-qqb-memory-people.mjs',
  // 记忆摄入层（R1 尾巴）：历史 JSONL 抽事实必须待水位（不重复入库）、分页不得跳过超出一页的旧消息、
  //   库打不开时只记日志不推进水位；提炼配额必须真挡住超额入库（省 token 的开关在这里）。
  'test-qqb-memory-intake.mjs',
  // 记忆精炼/归档层（R1 的「LLM 提炼 + 旧记忆归档」）：水位推早了静默丢记忆、
  // 推晚了每轮重烧 token、每日轮数与提炼配额是省钱的闸门、归档导出失败必须一条都不标记。
  'test-qqb-memory-refine.mjs',
  // 艾宾浩斯遗忘曲线 + 情绪加权（2026-10-25）：S 随重要度/情绪/复习次数变长且有上限、
  //   R 随时间单调下降、depth 分档决定提示词里的位置；store 写入带情绪后权重更高、忘得更慢。
  'test-qqb-memory-ebbinghaus.mjs',
  // RAG 向量索引（2026-10-25）：hash-v1 确定/归一、blob 往返、混合检索按意思找得回、
  //   不沾边的不混进来、向量覆盖统计与 pending 补建、语义通道缺席时回落 hash-v1 不报错。
  'test-qqb-memory-rag.mjs',
  // 音色服务生命周期（2026-10-26）：不用就关掉那 8.3 GB —— 已就绪不重复拉起、没起就现拉并撤 hold、
  //   拉不起来回落到机器音不拖死调用方、闲够才停且唱歌时不停、idleStopMinutes=0 表示别自动关。
  'test-tts-lifecycle.mjs',
  // 预生成曲库：按情景挑歌 + 秒发 + 清单坏了不炸。
  'test-song-library.mjs',
  // 她睡着时看门狗歇着（2026-10-26 主人要求）：进晚安休眠停用三个计划任务并建一次性醒来兜底任务、
  //   醒来/取消时重新启用并删兜底、桥接重启还在睡时重新落实；看门狗自己每轮先看 night-sleep.json。
  'test-night-quiet.mjs',
  // 容错层（R4 上半段）：SnowLuma 重启那 20 秒里发失败的消息必须落盘并能补发、不得静默丢；
  //   同一 dedupKey 不得真的发两遍（去重要在 POST 之前判）；参数错（retcode 1400）不重试；
  //   重试次数用尽才放弃；进程在 POST 中途被杀不得让同一条无限重试。
  'test-qqb-net.mjs',
  // 情绪/状态机（R2）：被凶要真的委屈（且只记当事人）、道歉要能安抚、心情会随时间自己回稳、
  //   深夜睡觉恢复更快、状态跨重启不丢；门控只给建议（回复永不拒绝），坏文件/写失败绝不能抛。
  'test-qqb-mood.mjs',
        // R1b/R5：人设慢演化（只改人格卡受管区块 + 审计 + 回滚）与干预提案队列。
        'test-qqb-persona-evolve.mjs',
        // R8 定向投递：自然语言要能解析出对象与嘱托、必须从队列里认辞（撤回/拒绝/过期都要有交代）；
        //   最终发出去的是她自己重写的话、只有主人能下达、全流程留档（下达人/对象/产出/理由）。
        'test-qqb-directed.mjs',
        // R6 媒体能力：识图走 provider（默认本机 Ollama），换 provider 不改调用点；
        //   图生图/视频帧解析这类预留能力要给出可识别的「暂未接入」而不是含糊报错。
        'test-qqb-media.mjs',
    'test-qqb-engine.mjs', // F：直连引擎（工具箱 key/token 隐藏、回路 fallbackSafe 语义）
        // F 引擎直连模型 API：配置与密钥来源、未启用/无 key 时绝不发请求、工具调用解析、
        //   5xx 才重试而 4xx 不重试、主动取消立刻返回、密钥在日志里必须脱敏。
        'test-qqb-model.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
