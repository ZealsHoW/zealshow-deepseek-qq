// R3 的实际探针：把已经在线的东西按模块登记成健康项。
//
// 这一版只探测**已经存在**的服务（OneBot 网关 / 桥接控制台 / 常驻 MCP / Hindsight / state 可写），
// 不引入任何新依赖、不碰 QQ、不写任何业务数据；后续模块（记忆库、收发、媒体）复用同一张表登记。
//
// 判定口径都按历史事故校准过：
//   · OneBot 用 `get_login_info` 的 retcode（SDK 不校验载荷，只看 HTTP 200 会静默失效）；
//   · 桥接的「能收能发」看 `/api/status` 的 `dshReady` —— 它才是桥接与 DSH 的真实连接态；
//   · Hindsight 是**非关键**模块：本地 daemon 首次要下几百 MB，没起来只算降级、不算宕机。
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.9';

/**
 * 极简 HTTP JSON 探测：永不抛，失败也返回结构化结果（健康检查不该把调用方炸掉）。
 * @param {string} url
 * @param {{method?: string, headers?: Record<string,string>, body?: string|null, timeoutMs?: number}} [options]
 */
export async function httpJson(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 4000;
  const began = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      body: options.body ?? undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return {
      ok: response.ok,
      status: response.status,
      json,
      text: text.slice(0, 400),
      error: null,
      latencyMs: Date.now() - began,
    };
  } catch (error) {
    const cause = error?.cause?.message ?? error?.message ?? error;
    return { ok: false, status: 0, json: null, text: '', error: String(cause), latencyMs: Date.now() - began };
  } finally {
    clearTimeout(timer);
  }
}

/** 控制台令牌：优先 config，其次 state/console-token（桥接两种都认）。 */
export function consoleToken(root, config) {
  const fromConfig = config?.get?.('consoleToken');
  if (fromConfig) return String(fromConfig);
  try {
    return fs.readFileSync(path.join(root, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 建一组可直接喂给 `health.register()` 的检查项。
 * @param {{root: string, config?: any, logger?: any, timeoutMs?: number}} options
 */
export function createServiceChecks(options = {}) {
  const root = options.root ?? process.cwd();
  const config = options.config ?? null;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 4000;
  const get = (dotted, fallback) => config?.get?.(dotted, fallback) ?? fallback;
  // 有些检查项要把整份配置交给模块（`modelConfigOf` / `createMediaRegistry`），它们直读 `config.model`、
  // `config.vision`；而这里拿到的往往是 createConfig 的**门面**（只有 get/all/… 方法）→ 直读全是 undefined，
  // 探针便会退回默认值说好话（2026-10-21 修：`model` 探针把已开启的直连报成 enabled=false）。
  const rawConfig = () => (typeof config?.all === 'function' ? config.all() ?? {} : config ?? {});

  const checkOnebot = async () => {
    const base = String(get('snowluma.httpUrl', 'http://127.0.0.1:3000')).replace(/\/+$/, '');
    const token = get('snowluma.accessToken', '');
    const result = await httpJson(`${base}/get_login_info`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      timeoutMs,
    });
    if (result.error) {
      return { status: 'down', detail: { url: base, latencyMs: result.latencyMs }, error: result.error };
    }
    const payload = result.json ?? {};
    const healthy = payload.status === 'ok' && payload.retcode === 0;
    return healthy
      ? { status: 'ok', detail: { url: base, user_id: payload.data?.user_id, nickname: payload.data?.nickname, latencyMs: result.latencyMs } }
      : {
        status: 'down',
        detail: { url: base, httpStatus: result.status, retcode: payload.retcode, wording: payload.wording },
        error: payload.wording ?? `HTTP ${result.status}`,
      };
  };

  const checkBridge = async () => {
    const port = Number(get('consolePort', 3100));
    const token = consoleToken(root, config);
    const url = `http://127.0.0.1:${port}/api/status`;
    const result = await httpJson(url, { headers: token ? { 'x-console-token': token } : {}, timeoutMs });
    if (result.error) return { status: 'down', detail: { url, latencyMs: result.latencyMs }, error: result.error };
    if (!result.ok) return { status: 'down', detail: { url, httpStatus: result.status }, error: `HTTP ${result.status}` };
    const payload = result.json ?? {};
    const dshReady = payload.dshReady === true;
    // 活 DSH 的 preset 体检。`dshReady` 只说明 DSH **连得上**，不代表 preset **能用**：
    // 2026-10-21 qq-chat / qq-chat-v2 装配失败了 30 多个小时，dshReady 一直是 true、
    // 这个探针一直报 ok —— 这就是那个「假绿灯」。broken 的 preset 只影响依赖 DSH 会话的
    // 那一半功能（新建会话 / resume / 黑话提取 / 无会话时的唤醒投递），所以判 degraded 不判 down。
    const broken = payload.presetHealth?.broken ?? {};
    const brokenIds = Object.keys(broken);
    if (dshReady && brokenIds.length) {
      return {
        status: 'degraded',
        detail: {
          url,
          mode: payload.mode,
          dshReady,
          brokenPresets: brokenIds,
          latencyMs: result.latencyMs,
        },
        error: `DSH preset 装配失败：${brokenIds.join('、')}（${String(broken[brokenIds[0]] ?? '').slice(0, 160)}）；新建会话/resume/黑话提取会失败，重启 DSH 才会重新加载`,
      };
    }
    return {
      status: dshReady ? 'ok' : 'degraded',
      detail: {
        url,
        mode: payload.mode,
        dshReady,
        role: payload.role,
        paused: payload.socialV2Paused,
        latencyMs: result.latencyMs,
      },
      error: dshReady ? null : 'DSH 未就绪（桥接正在重连，属降级）',
    };
  };

  const checkMcp = async () => {
    const port = Number(get('mcp.httpPort', 3210));
    const url = `http://127.0.0.1:${port}/health`;
    const result = await httpJson(url, { timeoutMs });
    if (result.error) return { status: 'down', detail: { url, latencyMs: result.latencyMs }, error: result.error };
    if (!result.ok) return { status: 'down', detail: { url, httpStatus: result.status }, error: `HTTP ${result.status}` };
    return { status: 'ok', detail: { url, body: result.json, latencyMs: result.latencyMs } };
  };

  const checkHindsight = async () => {
    const port = Number(get('hindsight.port', 9077));
    const url = `http://127.0.0.1:${port}/health`;
    const result = await httpJson(url, { timeoutMs: Math.min(timeoutMs, 3000) });
    if (result.error) {
      return {
        status: 'down',
        detail: { url, hint: '本地记忆 daemon 未监听：首次启动要下载依赖，看门狗每 10 分钟重试一次' },
        error: result.error,
      };
    }
    return result.ok
      ? { status: 'ok', detail: { url, body: result.json, latencyMs: result.latencyMs } }
      : { status: 'degraded', detail: { url, httpStatus: result.status }, error: `HTTP ${result.status}` };
  };

  const checkState = async () => {
    const stateDir = path.join(root, 'state');
    const probeFile = path.join(stateDir, `.qqb-write-probe-${process.pid}`);
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(probeFile, 'ok', 'utf8');
      fs.rmSync(probeFile, { force: true });
    } catch (error) {
      return { status: 'down', detail: { stateDir }, error: `state/ 不可写：${error?.message ?? error}` };
    }
    const memoryDb = fs.existsSync(path.join(stateDir, 'memory.db'));
    return {
      status: 'ok',
      detail: { stateDir, memoryDb, note: memoryDb ? '记忆库已存在' : '记忆库未建（B 阶段 R1 待做）' },
    };
  };

  /** R1 记忆库：真的打开一次、读统计、再关掉（打不开就是记忆功能不可用）。 */
  const checkMemory = async () => {
    let store = null;
    try {
      const { openStore } = await import('../memory/store.mjs');
      store = openStore({ root, file: options.memoryFile, logger: null });
      const stats = store.stats();
      return {
        status: 'ok',
        detail: {
          path: stats.path,
          total: stats.total,
          merges: stats.merges,
          personaAudits: stats.personaAudits,
          bytes: stats.bytes,
          byLayer: stats.byLayer,
          note: stats.total === 0 ? '记忆库为空（还没写过）' : undefined,
        },
      };
    } catch (error) {
      return { status: 'down', error: `记忆库不可用：${error?.message ?? error}` };
    } finally {
      try { store?.close(); } catch { /* 关不掉就算了 */ }
    }
  };

  /**
   * R2 情绪/状态机：读一次状态文件、报四个维度和「此刻适不适合主动开口」。
   * 状态文件不存在不算故障（她刚上线就是基线心情）；读不出来才是 down。
   */
  const checkMood = async () => {
    try {
      const { createMood } = await import('../persona/mood.mjs');
      const mood = createMood({ root, logger: null });
      const snap = mood.snapshot();
      const gate = mood.gate('proactive');
      return {
        status: 'ok',
        detail: {
          path: mood.path,
          dims: snap.dims,
          irritationTargets: Object.keys(snap.targets || {}).length,
          proactiveAllow: gate.allow,
          proactiveReason: gate.reason,
          summary: mood.summary(),
        },
      };
    } catch (error) {
      return { status: 'down', error: `情绪状态不可用：${error?.message ?? error}` };
    }
  };

  /**
   * R1b/R5 人设：读特征表、提案队列与人格卡的受管区块。
   * 没有特征/没有提案都是正常状态（她还没积累、主人也还没提建议），不算故障。
   */
  const checkPersona = async () => {
    try {
      const { createEvolve } = await import('../persona/evolve.mjs');
      const { createIntervene } = await import('../persona/intervene.mjs');
      const evolve = createEvolve({ root, logger: null, dryRun: true });
      const proposals = createIntervene({ root, logger: null });
      const cardPath = evolve.paths?.card ?? null;
      return {
        status: 'ok',
        detail: {
          traits: evolve.traits().length,
          block: evolve.render() ? 'ready' : 'empty',
          card: cardPath && fs.existsSync(cardPath) ? 'present' : 'missing',
          managedBlock: evolve.cardBlock() ? 'present' : 'none',
          proposals: proposals.stats(),
        },
      };
    } catch (error) {
      return { status: 'down', error: `人设模块不可用：${error?.message ?? error}` };
    }
  };

  /**
   * R8 定向投递：只读队列文件，看待办条数、最早的托付等了多久。
   * 有任务已经过了期限还没收尾（说明过期定时器没在跑）判 degraded，不判 down。
   */
  const checkDirected = async () => {
    try {
      const { createDirected } = await import('../directed/direct.mjs');
      const directed = createDirected({ root, logger: null });
      const stats = directed.stats();
      const pending = directed.pending();
      const ttlMs = Number(stats.ttlMs) || 0;
      const oldest = pending.reduce((min, d) => (min === null || d.ts < min ? d.ts : min), null);
      const overdue = ttlMs > 0 ? pending.filter((d) => Date.now() - d.ts > ttlMs).length : 0;
      return {
        status: overdue > 0 ? 'degraded' : 'ok',
        detail: {
          file: directed.path ?? null,
          pending: pending.length,
          overdue,
          oldestWaitMs: oldest ? Math.max(0, Date.now() - oldest) : 0,
          stats,
        },
      };
    } catch (error) {
      return { status: 'down', error: `定向投递模块不可用：${error?.message ?? error}` };
    }
  };

  /**
   * R6 媒体能力：只读 provider 注册表——默认 provider 是谁、预留能力有没有实现。
   * 判 degraded 只有一种情况：没有可用 provider（识图全废，但聊天不受影响）。
   * 注：注册表的 calls/failures 是**进程内计数**，体检另起进程看不到常驻 MCP 服务里的真实调用量，
   * 所以不用它判失败率（要看得去 MCP 服务自己的日志）。
   */
  const checkMedia = async () => {
    try {
      const { createMediaRegistry } = await import('../media/providers.mjs');
      const registry = createMediaRegistry({ config: rawConfig(), logger: null });
      const caps = registry.capabilities();
      const stats = registry.stats();
      const noProvider = !caps.default;
      return {
        status: noProvider ? 'degraded' : 'ok',
        detail: {
          default: caps.default ?? null,
          providers: caps.providers ?? [],
          reserved: caps.reserved ?? [],
          calls: Number(stats.calls) || 0,
          failures: Number(stats.failures) || 0,
          reservedCalls: Number(stats.reservedCalls) || 0,
          counters: 'process-local',
        },
      };
    } catch (error) {
      return { status: 'down', error: `媒体能力模块不可用：${error?.message ?? error}` };
    }
  };

  /**
   * F 模型客户端：**只看配置，不发请求**（体检不该花 token）。
   * 没有 key 或没启用只是「还没切过来」，不是故障 → 只要配置自洽就 ok，
   * 缺 key 且 enabled=true 才 degraded（那样直连链路必然失败）。
   */
  const checkModel = async () => {
    try {
      const { modelConfigOf, sharedKeyResolver } = await import('../model/client.mjs');
      // 体检要看真话：密钥可能来自本机 DSH 凭据文件（计划任务进程环境里没有那两个 env）。
      const info = modelConfigOf(rawConfig(), process.env, { resolver: sharedKeyResolver });
      const bad = info.enabled && !info.keyConfigured;
      return {
        status: bad ? 'degraded' : 'ok',
        detail: {
          enabled: info.enabled,
          provider: info.provider,
          model: info.model,
          baseUrl: info.baseUrl,
          keyConfigured: info.keyConfigured,
          keyFrom: info.keyFrom || null,
          note: info.enabled ? '引擎直连已启用' : '待切（当前仍走 DSH preset）',
        },
      };
    } catch (error) {
      return { status: 'down', error: `模型客户端模块不可用：${error?.message ?? error}` };
    }
  };

  /**
   * R4 发送队列：**只读**队列文件读统计（不启动客户端、不发任何请求）。
   * 阈值取舍：积压 >50 或最旧一条等超过 1 小时才算 degraded —— 那说明网关已经不顺很久了，
   * 但 QQ 本身还能收，所以不判 down。
   */
  const checkOutbox = async () => {
    try {
      const { createOutbox } = await import('../net/outbox.mjs');
      const outbox = createOutbox({ root, logger: null });
      const stats = outbox.stats();
      const waiting = Number(stats.waiting) || 0;
      const oldestAt = stats.oldestAt ?? null;
      const oldestAgeMs = oldestAt ? Math.max(0, Date.now() - oldestAt) : 0;
      const backlogged = waiting > 50 || oldestAgeMs > 3600000;
      return {
        status: backlogged ? 'degraded' : 'ok',
        detail: {
          file: stats.file,
          pending: stats.pending,
          due: stats.due,
          waiting,
          sent: stats.sent,
          failed: stats.failed,
          dropped: stats.dropped,
          duplicated: stats.duplicated,
          oldestAt,
          oldestAgeMs,
          lastError: stats.lastError,
        },
        error: backlogged ? `发送队列积压（待补发 ${waiting} 条，最旧 ${Math.round(oldestAgeMs / 60000)} 分钟）` : undefined,
      };
    } catch (error) {
      return { status: 'down', error: `发送队列不可用：${error?.message ?? error}` };
    }
  };

  return [
    {
      name: 'onebot',
      version: VERSION,
      critical: true,
      description: 'SnowLuma OneBot 网关（QQ 收发的前提）',
      timeoutMs,
      check: checkOnebot,
    },
    {
      name: 'bridge',
      version: VERSION,
      critical: true,
      description: 'qq-bridge 主程序与控制台（dshReady 表示与 DSH 的真实连接态）',
      timeoutMs,
      check: checkBridge,
    },
    {
      name: 'mcp',
      version: VERSION,
      critical: true,
      description: '常驻 QQ 工具面（Streamable HTTP，DSH 的 MCP 客户端连它）',
      timeoutMs,
      check: checkMcp,
    },
    {
      name: 'hindsight',
      version: VERSION,
      critical: false,
      description: '本地 Hindsight 记忆 daemon（非关键：未起来只降级）',
      timeoutMs,
      check: checkHindsight,
    },
    {
      name: 'state',
      version: VERSION,
      critical: true,
      description: 'state/ 目录可写（记忆、会话、日志都落在这里）',
      timeoutMs,
      check: checkState,
    },
    {
      name: 'memory',
      version: VERSION,
      // 记忆坏了要立刻告警，但不该把「QQ 还能正常收发」判成宕机。
      critical: false,
      description: 'R1 记忆库（state/memory.db，SQLite）：能打开、能读统计',
      timeoutMs,
      check: checkMemory,
    },
    {
      name: 'outbox',
      version: VERSION,
      // R4 发送队列：积压只说明网关不太顺，不该把整体判成宕机；积压过多/太旧才 degraded。
      critical: false,
      description: 'R4 发送队列（state/outbox.jsonl）：能读出待补发条数与最旧时间',
      timeoutMs,
      check: checkOutbox,
    },
    {
      name: 'mood',
      version: VERSION,
      // R2 情绪/状态机：状态坏了只影响「她像不像活人」，不该影响收发。
      critical: false,
      description: 'R2 情绪状态（state/persona-state.json）：四个维度可读、门控可算',
      timeoutMs,
      check: checkMood,
    },
    {
      name: 'persona',
      version: VERSION,
      // R1b/R5 人设演化与干预：坏了只是人设不长了，收发与记忆都不受影响。
      critical: false,
      description: 'R1b/R5 人设（state/persona-traits.json + persona-proposals.json + 人格卡受管区块）',
      timeoutMs,
      check: checkPersona,
    },
    {
      name: 'directed',
      version: VERSION,
      // R8 定向投递：坏了只是「帮她传话」不能用，收发与记忆不受影响。
      critical: false,
      description: 'R8 定向投递（state/directives.json）：待办条数、有没有过了期限还没回执的',
      timeoutMs,
      check: checkDirected,
    },
    {
      name: 'media',
      version: VERSION,
      // R6 媒体能力：识图/发图坏了只是「看不了图」，聊天、记忆、收发都不受影响。
      critical: false,
      description: 'R6 媒体能力（src/qqb/media/providers.mjs）：默认 provider 是谁、调用失败率、预留能力有没有接上',
      timeoutMs,
      check: checkMedia,
    },
    {
      name: 'model',
      version: VERSION,
      // F 直连模型：还没切过来是正常的（enabled=false），不能因为「没启用」就报故障。
      critical: false,
      description: 'F 模型客户端（src/qqb/model/client.mjs）：配置是否自洽、key 有没有着落（不花 token，不发请求）',
      timeoutMs,
      check: checkModel,
    },
  ];
}

/**
 * 一次性体检：建表 → 注册全部检查 → 跑一轮。
 * @param {{root?: string, config?: any, logger?: any, timeoutMs?: number, health?: any}} [options]
 */
export async function probe(options = {}) {
  const { createHealth } = await import('../core/health.mjs');
  const health = options.health ?? createHealth({ logger: options.logger });
  for (const check of createServiceChecks(options)) health.register(check);
  return health.run({ force: true });
}