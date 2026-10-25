// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as loginWatch from '../src/qqb/read-login-watch.mjs';
import * as tiers from '../src/qqb/tiers.mjs';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as memoryLog from '../src/qqb/memory-log.mjs';
import { autoIncludeBudget, autoIncludeProblems, autoIncludeSettings, describeAutoIncludeRule, matchAutoInclude } from '../src/qqb/allow-rules.mjs';
// 本机 TTS 模块：夹具里**注入真实现**（它只读写显式传入的路径），需要替身的用例用 globals 覆盖。
import * as ttsLib from '../src/qqb/tts.mjs';
import * as presetPrompt from '../src/preset-prompt.js';
import * as roleCard from '../src/role-card.js';
import { DEFAULT_ALIASES as DIRECTED_ALIASES, parseDirective } from '../src/qqb/directed/direct.mjs';
import { createCallLog } from '../src/qqb/core/call-log.mjs';
import { stripTextToolCalls } from '../src/qqb/engine/loop.mjs';
import * as stateAcl from '../src/state-acl.mjs';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';
// R1 长期记忆库的接线层。这里**故意换成惰性桩**而不是真实现：
// 真实现的 SQLite 句柄会一直开着，Windows 上夹具目录就删不掉（EPERM）。
// 真行为由 scripts/test-qqb-memory-live.mjs 单独回归。
function createLiveMemory() {
  return {
    version: '0.1.0',
    path: '',
    available: () => false,
    error: () => 'audit-stub',
    rememberSocialEvent: () => null,
    forgetSocialEvent: () => 0,
    clearScope: () => 0,
    block: () => '',
    recall: () => [],
    stats: () => null,
    // R1b 人设演化要的口子（夹具里既不读库也不写审计）。
    evolveStore: () => ({
      exportAll: () => [],
      persona: { record: () => null, list: () => [], lastApplied: () => null },
    }),
    close: () => true,
  };
}

/**
 * 人名簿（scope → 名字）同样是桩：夹具里不落盘，也测不到真实网关同步。
 * 真行为由 scripts/test-qqb-memory-people.mjs 回归；这里只要「别让桥接 ReferenceError」。
 */
function createPeopleDirectory() {
  return {
    filePath: null,
    load: () => {},
    save: () => false,
    remember: () => false,
    get: () => null,
    label: (scope) => {
      const key = String(scope ?? '').trim();
      if (!key) return '不认识的人';
      return `${key.startsWith('group:') ? '群聊' : '私聊'} ${key}`;
    },
    nameOf: () => '',
    entries: () => [],
    size: () => 0,
  };
}

/**
 * 遗忘曲线取情绪：桩成 0（不参与权重），真行为由 test-qqb-memory-ebbinghaus.mjs 回归。
 * bridge.js 在 memory-update 里会用它算 emotion，缺了就是整片 R 系列报
 * 「emotionFromText is not defined」。
 */
function emotionFromText() {
  return 0;
}

// 摄入层同样是惰性桩：夹具里不能真去开库（同上，EPERM）。
function openStore() {
  return null;
}
function createIntake() {
  return {
    version: '0.1.0',
    watermarkPath: '',
    watermarkOf: () => 0,
    run: () => ({ dryRun: false, keys: 0, scanned: 0, inserted: 0, merged: 0, rejected: 0, sessions: [], errors: [] }),
    runSession: () => ({ key: '', scanned: 0, inserted: 0, merged: 0, rejected: 0, candidates: [] }),
    save: () => false,
  };
}

// R4 容错层也是惰性桩：夹具里不写真队列文件、不真发 HTTP。
// 真行为由 scripts/test-qqb-net.mjs 回归（那边起真的本地 HTTP 假网关）。
function createBackoff() {
  return {
    version: '0.1.0',
    attempts: 0,
    lastDelayMs: 0,
    peek: () => 1000,
    delayFor: () => 1000,
    next: () => 1000,
    reset: () => {},
    state: () => ({ baseMs: 1000, maxMs: 60000, factor: 2, jitter: 0, attempts: 0, lastDelayMs: 0 }),
  };
}
function createOutbox() {
  return {
    version: '0.1.0',
    file: '',
    size: () => 0,
    all: () => [],
    pending: () => [],
    waitingCount: () => 0,
    enqueue: () => ({ id: null, duplicate: false }),
    markAttempt: () => false,
    markSent: () => false,
    markFailed: () => ({ retry: false, attempts: 0, nextAttemptAt: 0 }),
    remove: () => false,
    clear: () => 0,
    isDuplicate: () => false,
    prune: () => 0,
    compact: () => ({ file: '', items: 0, lines: 0, at: 0 }),
    stats: () => ({ pending: 0, due: 0, waiting: 0, oldestAt: null, lastError: null, file: '', logLines: 0, sent: 0, failed: 0, dropped: 0, duplicated: 0, loaded: 0 }),
    reload: () => 0,
  };
}
function createInboundDedup() {
  return {
    version: '0.1.0',
    admit: () => ({ ok: true, refs: [] }),
    has: () => false,
    stats: () => ({ file: '', size: 0, lines: 0, ttlMs: 86400000, maxEntries: 5000, oldestAt: null, loaded: 0, accepted: 0, duplicated: 0, evicted: 0, compactions: 0, writeFailures: 0 }),
    prune: () => 0,
    compact: () => false,
  };
}
function createOneBotClient() {
  return {
    version: '0.1.0',
    probe: async () => ({ ok: true, action: 'stub', status: 200, data: null }),
    call: async () => ({ ok: true, queued: false, data: null }),
    flush: async () => ({ sent: 0, failed: 0, dropped: 0, remaining: 0, errors: [] }),
    startAutoFlush: () => () => {},
    stats: () => ({ httpUrl: '', lastOkAt: null, lastError: null, sinceLastOkMs: null, outbox: null }),
  };
}
// R2 情绪/状态机：夹具里不做真读写（状态文件在临时目录、真实现会去碰磁盘），
// 用惰性桩保证 bridge 的调用点可跑；状态机本身由 scripts/test-qqb-mood.mjs 用真实现覆盖。
function createMood() {
  return {
    version: '0.1.0',
    path: '',
    observe: () => ({ event: 'stub', dims: { mood: 0.62, energy: 0.7, irritation: 0.05, social: 0.55 }, target: null }),
    classify: () => 'warm_chat',
    gate: () => ({ allow: true, probFactor: 1, tone: 'soft', reason: 'audit-stub', dims: { mood: 0.62, energy: 0.7, irritation: 0.05, social: 0.55 } }),
    summary: () => '',
    snapshot: () => ({ dims: { mood: 0.62, energy: 0.7, irritation: 0.05, social: 0.55 }, targets: {}, updatedAt: 0, events: [] }),
    irritationFor: () => 0,
    decay: () => 0,
    save: () => false,
    events: () => [],
  };
}

// R1b/R5 人设演化与干预：夹具里绝不能真写人格卡与审计库（临时目录里没有真卡片，
// 真实现还会去碰 SQLite），用惰性桩保证 bridge 的调用点可跑；
// 真行为由 scripts/test-qqb-persona-evolve.mjs 用真实现 + 临时目录覆盖。
function createEvolve() {
  return {
    version: '0.1.0',
    paths: { card: '', traits: '', cardHistory: '' },
    state: () => ({ version: '0.1.0', updatedAt: 0, traits: {} }),
    traits: () => [],
    derive: () => [],
    merge: () => ({ added: 0, updated: 0, skipped: 0, total: 0 }),
    render: () => '',
    apply: () => ({ added: 0, updated: 0, skipped: 0, total: 0, block: '', wroteCard: false, backup: null, auditId: null, cardNote: 'audit-stub' }),
    cardBlock: () => '',
    writeCard: () => ({ ok: false, wrote: false, backup: null, reason: 'audit-stub' }),
    history: () => [],
    rollback: () => ({ ok: false, reason: 'audit-stub' }),
    save: () => false,
    dryRun: true,
  };
}
function createIntervene() {
  return {
    version: '0.1.0',
    path: '',
    list: () => [],
    get: () => null,
    propose: () => ({ ok: false, reason: 'audit-stub' }),
    apply: async () => ({ ok: false, reason: 'audit-stub' }),
    reject: () => ({ ok: false, reason: 'audit-stub' }),
    withdraw: () => ({ ok: false, reason: 'audit-stub' }),
    stats: () => ({ total: 0, pending: 0, byStatus: {}, updatedAt: 0 }),
    pendingCount: () => 0,
    clear: () => ({ ok: true }),
  };
}

/**
 * R8 定向投递的惰性桩：夹具里既不读真队列文件、也不发任何消息。
 * 真行为（队列/定夺/回执）由 scripts/test-qqb-directed.mjs 覆盖。
 * 但**别名表与自然语言解析是纯函数**，这里接的是真实现——否则桥接里的
 * 「配置别名表与内置表合并」这条路径在夹具里根本测不到。
 */
function createDirected() {
  const empty = () => [];
  return {
    version: '0.1.0',
    path: '',
    loaded: 0,
    aliases: DIRECTED_ALIASES,
    aliasTable: () => DIRECTED_ALIASES.map((a) => ({ name: a.name, id: String(a.id), kind: a.kind ?? 'private', words: [...(a.words ?? [])] })),
    parse: (text, extra = {}) => parseDirective(text, { aliases: DIRECTED_ALIASES, ...extra }),
    create: () => ({ ok: false, error: 'audit-stub' }),
    list: empty,
    pending: empty,
    get: () => null,
    decide: () => ({ ok: false, error: 'audit-stub' }),
    withdraw: () => ({ ok: false, error: 'audit-stub' }),
    markSent: () => ({ ok: false, error: 'audit-stub' }),
    markFailed: () => ({ ok: false, error: 'audit-stub' }),
    expire: empty,
    stats: () => ({ total: 0, pending: 0, byStatus: {}, updatedAt: 0, file: '', maxPending: 20, ttlMs: 1800000 }),
    audit: empty,
  };
}

/**
 * F 直连引擎的惰性桩：夹具里不打真模型、不连常驻 MCP 服务。
 * 真行为（工具箱、回路、fallbackSafe）由 scripts/test-qqb-engine.mjs 覆盖。
 */
function createModelClient() {
  return {
    version: '0.1.0',
    configure: () => {},
    config: () => ({ enabled: false }),
    ready: () => false,
    complete: async () => ({ ok: false, error: 'audit-stub：直连未启用' }),
    stats: () => ({ calls: 0, failures: 0 }),
    reset: () => {},
  };
}
function createToolbox() {
  return {
    version: '0.1.0',
    refresh: async () => ({ tools: 0, servers: 0, collisions: [] }),
    catalog: () => [],
    schemas: () => [],
    names: () => [],
    find: () => null,
    call: async () => ({ ok: false, error: 'audit-stub' }),
    endpoints: () => [],
    stats: () => ({ refreshes: 0, calls: 0, failures: 0, byServer: {}, tools: 0, collisions: [], lastError: null }),
  };
}
function createAgentLoop() {
  return {
    version: '0.1.0',
    run: async () => ({ ok: false, error: 'audit-stub：直连未启用', text: '', steps: 0, toolCalls: [], fallbackSafe: true }),
    stats: () => ({ runs: 0, ok: 0, failed: 0, fallbacks: 0, steps: 0, toolCalls: 0, executions: 0, byTool: {} }),
  };
}

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], http: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body, headers: (init && init.headers) ? { ...init.headers } : {} });
    const action = String(url).split('/').pop();
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 qq-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerQQ 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request() { return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] }; }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    wakePriorityV2, tierGuardV2, scheduleProactiveCheckV2,
    // 发言失败后的沉默窗口：停手 / 静默时长 / 整批暂存 / 补发队列跳过（对应主人 m00363 的要求）。
    sendMessagesV2, deferTextSend, sendSilenceState, noteSendSilence, sendSilenceCfg, sendSilenceSkip, sendSilence,
    refreshMode, modeAllowed, trackTurnEvent, replayPendingWakeReasonsV2,
    collectors, setupSleepTimerV2,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2,
    initialPrompts, initialPromptMaxChars,
    extractMediaFromSegments, segmentsToText, fetchOneBotImage, fetchMediaData, resolveMediaList,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES, bot,
    isConversationBusyV2, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS,
    settingFromDshNamespace, selfIdentityTextV2, buildWakeReminderPromptV2,
    getMode() { return currentMode; },
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    flushQueue, retireSession,
    // R8 定向投递：别名表合并规则（配置非空时与内置表合并，而非整体覆盖）。
    directed, directedAliases, directedBlock,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    // 本机 TTS：文字→wav 的合成入口与语音库清理（对应「发语音开启」那条要求）。
    synthesizeVoiceForV2, pruneTtsLibrary,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
    // F/A：直连引擎的「媒体意向」通道（都在模块作用域，测试可绕开真模型/真 MCP 直接驱动）。
    runDirectAgentTurn, ensureEngine, engineEnabled, engineHiddenSendTool,
    createEngineMediaIntentQueue, flushEngineMediaIntents,
    ENGINE_MEDIA_MAX_PER_TURN, ENGINE_SEND_TOOLS, ENGINE_MEDIA_INTENT_TOOLS,
    // 说话口径：提示词装配（反AI味/积极性/最近聊天记录）与正文清洗、空行分条。
    buildEnginePrompts, sanitizeEngineReplyV2, splitBubblesV2, ENGINE_MAX_BUBBLES,
    // R2 行为模块：自己刷一会儿（挑会话的规则、每天次数、启停）。
    pickBrowseTargetV2, startBrowseBehavior, browseCountToday,
    // 待发文件夹（state/outbox）自动清理：只删够老的，保护刚放进去还没发的。
    cleanupOutboxMedia, startOutboxCleanup,
    // 抖音登录态监视：MCP 进程记录、桥接进程通知主人（状态文件名由 bridge.js 按 STATE_DIR 传进来，
    // 所以夹具只用得到临时目录里的那一份）。
    checkReadLoginWatch, startReadLoginWatch, sendOwnerNotice,
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    createLiveMemory,
    createPeopleDirectory,
    emotionFromText,
    openStore,
    createIntake,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    // bridge.js 顶层的环境适配 import 会被本 harness 剥掉（VM 里靠 context 注入）；
    // 新增这些绑定是为了让错误分支在虚拟环境里也不会 ReferenceError。
    // 测试关心的是桥接的队列/发送行为，不需要真实跑插件预检或写事故文件。
    runPluginPreflight: () => [],
    appendEnvIncident: () => {},
    explainAgentError: () => null,
    // F：直连引擎的三个模块（真实现会打真模型、连常驻 MCP）。默认是「未启用」的惰性桩；
    // 测试可以用 globals 覆盖 createAgentLoop，驱动「媒体意向」这类只发生在桥接侧的接线。
    createModelClient, createToolbox, createAgentLoop,
    // 正文清洗里「别把工具调用当消息发出去」那一道闸。纯函数，注入真实现最省事
    // （写桩就得把 XML 方言的解析规则抄第二份，两边必然漂移）。
    stripTextToolCalls,
    // F 补：工具调用落盘。这里注入**真实现**——它只写文件，而 bridge.js 的 ROOT 已被换成
    // 夹具临时目录，不会碰到真 state/tool-calls.jsonl；再手写一套桩反而会掩盖真实的
    // 脱敏与上限轮转行为。
    createCallLog,
    // 归档流水（state/qq-memory.log）：注入**真实现**——它只按显式路径 append，
    // 而那个路径由 bridge.js 按被替换过的 STATE_DIR 算出来 = 夹具临时目录。
    // 这里若漏注入，appendMemoryLog 会把 ReferenceError 吞掉，归档链路在夹具里静默失效。
    createMemoryLogWriter: memoryLog.createMemoryLogWriter,
    memoryLogPath: memoryLog.memoryLogPath,
    // 白名单「按用户名规则自动纳入」（第①条）：注入**真实现**——这一层不碰文件/网络，
    // 写盘与热更新在 bridge.js 的 tryAutoInclude() 里（夹具里 config.json 指临时目录）。
    autoIncludeSettings, autoIncludeProblems, matchAutoInclude, autoIncludeBudget, describeAutoIncludeRule,
    // R4：容错层的注入点。backoff/outbox/inbound 用桩（真实现会碰文件与定时器）。
    createBackoff, createOutbox, createInboundDedup,
    // R2：情绪状态机也用桩（夹具不做真磁盘读写）。
    createMood,
    // 抖音登录态监视：注入**真实现**（它只读写一个显式传入的文件路径，而那个路径由 bridge.js
    // 按被替换过的 ROOT 算出来 = 夹具临时目录；写桩反而会把「连续几次才算掉登录」的规则抄两份）。
    readWatch: loginWatch.readWatch,
    shouldNotifyWatch: loginWatch.shouldNotifyWatch,
    markWatchNotified: loginWatch.markWatchNotified,
    buildWatchNotice: loginWatch.buildWatchNotice,
    // R1b/R5：人设演化与干预通道也用桩（夹具绝不真写人格卡/审计库）。
    createEvolve, createIntervene,
    // R8：定向投递队列用桩（夹具不读真队列、不发任何消息）。
    createDirected,
    // OneBot 客户端桩：形状按 R4 之后的新契约（queued 显式标记），但**仍然经过 fakeFetch**，
    // 这样「到底发出去没有、发了哪些段」还能被 calls.http 断言（R1/R15 依赖这条）。
    // 需要模拟网关永久失败时，用 globals 覆盖这个工厂即可。
    createOneBotClient: (options = {}) => {
      const base = () => String(typeof options.httpUrl === 'function' ? options.httpUrl() : options.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const post = async (action, params, timeoutMs) => {
        const res = await fakeFetch(`${base()}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params ?? {}),
          timeoutMs
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body?.status !== 'ok' || body?.retcode !== 0) {
          const detail = body?.wording ?? body?.retcode ?? res.status;
          return { ok: false, status: res.status, error: `OneBot ${action} 失败: ${detail}`, retryable: Number(res.status) >= 500 };
        }
        return { ok: true, status: res.status, data: body.data ?? null };
      };
      return {
        version: '0.1.0',
        probe: (action, params) => post(action, params),
        async call(action, params) {
          const r = await post(action, params);
          if (r.ok) return { ok: true, queued: false, data: r.data };
          // 夹具里的 outbox 是桩（enqueue 返回 id:null）⇒ 视为没入队，按永久失败走原来的抛错/回滚路径。
          return { ok: false, queued: false, permanent: true, error: r.error };
        },
        flush: async () => ({ sent: 0, failed: 0, dropped: 0, remaining: 0, errors: [] }),
        startAutoFlush: () => () => {},
        stats: () => ({ httpUrl: base(), lastOkAt: null, lastError: null, sinceLastOkMs: null, outbox: null })
      };
    },
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...ttsLib, ...stateAcl, ...presetPrompt, ...roleCard, ...tiers,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
