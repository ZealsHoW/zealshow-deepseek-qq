// 模块启停编排（R3：单模块坏了只降级，不整体退出；R4 的优雅停机也走这里）。
//
// 设计取舍：
//   · 一个模块 start() 抛错，**不**中断其它模块的启动 —— 这正是「降级而非宕机」；
//     失败模块在健康表里记为 down，控制台/看门狗据此告警，其余能力照常服务。
//   · 依赖用 dependsOn 声明，启动按拓扑序、停机按反序（先起的最晚停）。
//   · 停机有总预算与单模块超时：卡住的模块会被放弃并记录，不会让进程永远退不掉。
export const VERSION = '0.1.0';

function withTimeout(promise, timeoutMs, label, action) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} ${action}超时（${timeoutMs}ms）`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * @param {{
 *   logger?: any, health?: any, bus?: any, now?: () => Date,
 *   startTimeoutMs?: number, stopTimeoutMs?: number, shutdownTimeoutMs?: number,
 * }} [options]
 */
export function createLifecycle(options = {}) {
  const logger = options.logger ?? null;
  const health = options.health ?? null;
  const bus = options.bus ?? null;
  const now = options.now ?? (() => new Date());
  const startTimeoutMs = Number.isFinite(options.startTimeoutMs) ? options.startTimeoutMs : 15000;
  const stopTimeoutMs = Number.isFinite(options.stopTimeoutMs) ? options.stopTimeoutMs : 5000;
  const shutdownTimeoutMs = Number.isFinite(options.shutdownTimeoutMs) ? options.shutdownTimeoutMs : 20000;
  /** @type {Map<string, any>} */
  const modules = new Map();
  let signalsInstalled = false;
  let stopping = false;

  const api = {
    register(spec) {
      const name = String(spec?.name ?? '');
      if (!name) throw new Error('模块必须提供 name');
      if (modules.has(name)) throw new Error(`模块重复注册：${name}`);
      const module = {
        name,
        version: String(spec.version ?? '0.0.0'),
        description: spec.description ?? '',
        dependsOn: [...(spec.dependsOn ?? [])],
        critical: Boolean(spec.critical),
        start: typeof spec.start === 'function' ? spec.start : null,
        stop: typeof spec.stop === 'function' ? spec.stop : null,
        status: 'registered',
        startedAt: null,
        stoppedAt: null,
        error: null,
        unregisterHealth: null,
      };
      modules.set(name, module);
      if (health && spec.health !== false) {
        module.unregisterHealth = health.register({
          name,
          version: module.version,
          critical: module.critical,
          description: module.description,
          status: 'unknown',
        });
      }
      return module;
    },
    get: (name) => modules.get(name) ?? null,
    names: () => [...modules.keys()],
    states: () => Object.fromEntries([...modules.values()].map((m) => [m.name, m.status])),
    /** 启动顺序：依赖在前。缺依赖或成环直接抛错（这是配置错误，不该静默）。 */
    order() {
      const done = new Set();
      const visiting = new Set();
      /** @type {any[]} */
      const out = [];
      const visit = (module) => {
        if (done.has(module.name)) return;
        if (visiting.has(module.name)) throw new Error(`模块依赖成环：${[...visiting, module.name].join(' -> ')}`);
        visiting.add(module.name);
        for (const dep of module.dependsOn) {
          const target = modules.get(dep);
          if (!target) throw new Error(`模块 ${module.name} 依赖未注册的 ${dep}`);
          visit(target);
        }
        visiting.delete(module.name);
        done.add(module.name);
        out.push(module);
      };
      for (const module of modules.values()) visit(module);
      return out;
    },
    async startAll(context = {}) {
      const started = [];
      for (const module of api.order()) {
        module.status = 'starting';
        const began = Date.now();
        try {
          if (module.start) {
            await withTimeout(
              Promise.resolve(module.start({
                ...context, module: module.name,
                logger: logger?.child?.(module.name) ?? logger,
                bus, health, lifecycle: api,
              })),
              startTimeoutMs, module.name, '启动',
            );
          }
          module.status = 'running';
          module.startedAt = now().toISOString();
          started.push(module.name);
          health?.setState?.(module.name, 'ok', `已启动（${Date.now() - began}ms）`);
          logger?.info?.('模块已启动', { module: module.name, version: module.version, ms: Date.now() - began });
          bus?.emit?.('lifecycle.started', { name: module.name });
        } catch (error) {
          module.status = 'failed';
          module.error = String(error?.message ?? error);
          health?.setState?.(module.name, 'down', module.error);
          logger?.error?.('模块启动失败，其它模块继续启动（降级）', { module: module.name, error });
          bus?.emit?.('lifecycle.failed', { name: module.name, error: module.error });
        }
      }
      return { started, states: api.states() };
    },
    async stopAll(reason = 'shutdown') {
      if (stopping) return { skipped: true };
      stopping = true;
      const order = api.order().reverse();
      const deadlineAt = Date.now() + shutdownTimeoutMs;
      const stopped = [];
      for (const module of order) {
        if (!['running', 'failed', 'starting'].includes(module.status)) continue;
        if (Date.now() > deadlineAt) {
          logger?.warn?.('停机总预算已用尽，放弃剩余模块', { module: module.name, reason });
          break;
        }
        try {
          if (module.stop) await withTimeout(Promise.resolve(module.stop({ reason, logger })), stopTimeoutMs, module.name, '停机');
          module.status = 'stopped';
          module.stoppedAt = now().toISOString();
          stopped.push(module.name);
          health?.setState?.(module.name, 'unknown', '已停止');
          logger?.info?.('模块已停止', { module: module.name, reason });
          bus?.emit?.('lifecycle.stopped', { name: module.name, reason });
        } catch (error) {
          module.status = 'stop-failed';
          module.error = String(error?.message ?? error);
          logger?.error?.('模块停机失败（已跳过）', { module: module.name, error });
        }
      }
      return { stopped, reason };
    },
    /** SIGINT/SIGTERM → 优雅停机后退出；返回卸载函数（测试里用）。 */
    installSignals() {
      if (signalsInstalled) return () => {};
      signalsInstalled = true;
      const handle = async (signal) => {
        logger?.warn?.(`收到 ${signal}，开始优雅停机`);
        try {
          await api.stopAll(signal);
        } catch (error) {
          logger?.error?.('优雅停机出错', { error });
        }
        process.exit(0);
      };
      const onInt = () => { handle('SIGINT'); };
      const onTerm = () => { handle('SIGTERM'); };
      process.on('SIGINT', onInt);
      process.on('SIGTERM', onTerm);
      return () => {
        signalsInstalled = false;
        process.off('SIGINT', onInt);
        process.off('SIGTERM', onTerm);
      };
    },
  };
  return api;
}