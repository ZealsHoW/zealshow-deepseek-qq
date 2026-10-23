// 模块健康登记与汇总（R3）。
//
// 目标形态：每个模块自己说「我还行不行」，控制台/看门狗只读一份汇总。
// 关键语义：
//   · 单模块 down 不等于整体 down —— 只有 critical 模块 down 才是整体 down；
//   · 状态**变化**时回调 onDegrade/onRecover（用于降级动作与告警），不是每次轮询都回调；
//   · 检查有超时、有缓存：探测挂了不会把调用方一起挂住（探针异常一律记为 down + error 文本）。
export const VERSION = '0.1.0';

/** @type {readonly string[]} */
export const STATUSES = Object.freeze(['ok', 'degraded', 'down', 'unknown']);

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_MS = 5000;

function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 健康检查超时（${timeoutMs}ms）`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function normalizeResult(result) {
  if (result == null) return { status: 'ok', detail: undefined, error: null };
  if (typeof result === 'string') return { status: 'ok', detail: result, error: null };
  if (typeof result === 'boolean') return { status: result ? 'ok' : 'down', detail: undefined, error: null };
  if (typeof result !== 'object') return { status: 'ok', detail: String(result), error: null };
  const status = STATUSES.includes(result.status)
    ? result.status
    : (typeof result.ok === 'boolean' ? (result.ok ? 'ok' : 'down') : 'ok');
  return { status, detail: result.detail, error: result.error ? String(result.error) : null };
}

/**
 * @param {{logger?: any, cacheMs?: number, defaultTimeoutMs?: number, now?: () => Date}} [options]
 */
export function createHealth(options = {}) {
  const logger = options.logger ?? null;
  const cacheMs = Number.isFinite(options.cacheMs) ? Number(options.cacheMs) : DEFAULT_CACHE_MS;
  const defaultTimeoutMs = Number.isFinite(options.defaultTimeoutMs) ? Number(options.defaultTimeoutMs) : DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  /** @type {Map<string, any>} */
  const registry = new Map();
  /** @type {any} */
  let last = null;
  let lastRunAt = 0;

  function entryOf(name) {
    const item = registry.get(name);
    if (!item) throw new Error(`健康检查未注册的模块：${name}`);
    return item;
  }

  function applyTransition(item, status, detail, error) {
    const previous = item.status;
    if (previous === status) return;
    item.lastChangeAt = now().toISOString();
    if (status === 'down' || status === 'degraded') {
      item.consecutiveFailures = (item.consecutiveFailures ?? 0) + 1;
      logger?.warn?.('模块健康状态变化', { module: item.name, from: previous, to: status, detail, error });
      try {
        item.onDegrade?.(status, detail, previous);
      } catch (err) {
        logger?.error?.('onDegrade 回调抛错（已隔离）', { module: item.name, error: err });
      }
    } else if (status === 'ok' && (previous === 'down' || previous === 'degraded')) {
      item.consecutiveFailures = 0;
      logger?.info?.('模块健康已恢复', { module: item.name, from: previous, to: status });
      try {
        item.onRecover?.(previous);
      } catch (err) {
        logger?.error?.('onRecover 回调抛错（已隔离）', { module: item.name, error: err });
      }
    }
  }

  async function runOne(item) {
    const startedAt = Date.now();
    let status = item.status === 'unknown' && !item.check ? 'unknown' : 'ok';
    let detail = item.detail;
    let error = null;
    if (typeof item.check === 'function') {
      try {
        const result = await withTimeout(Promise.resolve().then(() => item.check()), item.timeoutMs, item.name);
        const normalized = normalizeResult(result);
        status = normalized.status;
        detail = normalized.detail;
        error = normalized.error;
      } catch (err) {
        status = 'down';
        error = String(err?.message ?? err);
        detail = undefined;
      }
    } else if (item.status) {
      status = item.status;
    }
    item.detail = detail;
    item.error = error;
    item.checkedAt = now().toISOString();
    item.latencyMs = Date.now() - startedAt;
    // 顺序要紧：applyTransition 读的是 item.status，必须在改写它**之前**调用，
    // 否则 previous === status 恒成立，onDegrade/onRecover 永远不会触发
    // （这正是 2026-10-21 test-qqb-core 抓到的那条：状态确实变了，回调却是空的）。
    applyTransition(item, status, detail, error);
    item.status = status;
    return {
      name: item.name,
      version: item.version,
      critical: item.critical,
      description: item.description,
      status: item.status,
      detail: item.detail ?? undefined,
      error: item.error ?? undefined,
      latencyMs: item.latencyMs,
      checkedAt: item.checkedAt,
      changedAt: item.lastChangeAt,
      consecutiveFailures: item.consecutiveFailures ?? 0,
    };
  }

  function summarize(modules) {
    const counts = { ok: 0, degraded: 0, down: 0, unknown: 0 };
    for (const item of modules) counts[item.status] = (counts[item.status] ?? 0) + 1;
    const criticalDown = modules.some((item) => item.critical && item.status === 'down');
    const anyProblem = modules.some((item) => item.status === 'down' || item.status === 'degraded');
    const status = criticalDown ? 'down' : (anyProblem ? 'degraded' : 'ok');
    return { status, counts };
  }

  return {
    register(spec) {
      const name = String(spec?.name ?? '');
      if (!name) throw new Error('健康检查必须提供 name');
      if (registry.has(name)) throw new Error(`健康检查重复注册：${name}`);
      const item = {
        name,
        version: String(spec.version ?? '0.0.0'),
        description: spec.description ?? '',
        critical: Boolean(spec.critical),
        timeoutMs: Number.isFinite(spec.timeoutMs) ? spec.timeoutMs : defaultTimeoutMs,
        check: typeof spec.check === 'function' ? spec.check : null,
        onDegrade: spec.onDegrade,
        onRecover: spec.onRecover,
        status: spec.status ?? 'unknown',
        detail: undefined,
        error: null,
        checkedAt: null,
        changedAt: now().toISOString(),
        consecutiveFailures: 0,
      };
      registry.set(name, item);
      return () => registry.delete(name);
    },
    unregister(name) { return registry.delete(name); },
    /** 主动上报（没有 check 函数的模块用这个）。 */
    setState(name, status, detail) {
      const item = entryOf(name);
      if (!STATUSES.includes(status)) throw new Error(`未知健康状态：${status}`);
      item.manual = true;
      applyTransition(item, status, detail, null);
      item.status = status;
      item.detail = detail;
      item.checkedAt = now().toISOString();
      return item;
    },
    statusOf(name) { return registry.get(name)?.status ?? 'unknown'; },
    names: () => [...registry.keys()],
    cacheMs,
    lastReport: () => last,
    async run({ force = false } = {}) {
      const ts = Date.now();
      if (!force && last && ts - lastRunAt < cacheMs) return { ...last, cached: true };
      const modules = [];
      for (const item of registry.values()) modules.push(await runOne(item));
      const { status, counts } = summarize(modules);
      last = {
        ts: now().toISOString(),
        status,
        counts,
        modules,
        cached: false,
      };
      lastRunAt = ts;
      return last;
    },
    /** 人类可读的表格，给 CLI/控制台用。 */
    table(report) {
      const rows = [['模块', '版本', '状态', '关键', '耗时ms', '说明/详情']];
      for (const item of report.modules) {
        const detail = item.error
          ? `错误：${item.error}`
          : (item.detail === undefined ? '' : (typeof item.detail === 'string' ? item.detail : JSON.stringify(item.detail)));
        rows.push([item.name, item.version, item.status, item.critical ? '是' : '否', String(item.latencyMs ?? ''), detail]);
      }
      const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column] ?? '').length)));
      return rows
        .map((row) => row.map((cell, column) => String(cell ?? '').padEnd(widths[column])).join('  '))
        .join('\n');
    },
  };
}