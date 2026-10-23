// R4 通信容错（1/3）：退避器 —— 断线重连与发送重试共用一套节奏。
//
// 为什么单独成模块：
//   以前重连逻辑散在 bridge.js 里（事件流一处、发送一处、队列补投一处），
//   三处的等待时间各写各的，出问题时看不出「现在到底在哪个退避阶段」。
//   这里把它收成一个可注入时钟/随机源的纯对象，便于单测断言（R4 要求可观测可回滚）。
//
// 语义：
//   next() 返回「下一次重试前该等多少毫秒」，并把尝试次数 +1；
//   等待时间 = min(maxMs, baseMs * factor^(attempts-1))，再叠加 ±jitter 比例的抖动
//   （抖动是为了避免多个模块在同一毫秒一起重连，把对端打出一波尖峰）。

export const VERSION = '0.1.0';

/** 默认参数：1s 起、2 倍增长、最多 60s、±20% 抖动。 */
export const DEFAULTS = Object.freeze({
  baseMs: 1000,
  maxMs: 60000,
  factor: 2,
  jitter: 0.2,
});

/**
 * @param {object} [options]
 * @param {number} [options.baseMs] 首次重试等待
 * @param {number} [options.maxMs] 等待上限
 * @param {number} [options.factor] 增长倍数
 * @param {number} [options.jitter] 抖动比例（0~1）
 * @param {() => number} [options.random] 随机源（单测注入固定值）
 * @param {() => number} [options.now] 时钟（单测注入）
 */
export function createBackoff(options = {}) {
  const baseMs = Math.max(1, Number(options.baseMs) || DEFAULTS.baseMs);
  const maxMs = Math.max(baseMs, Number(options.maxMs) || DEFAULTS.maxMs);
  const factor = Math.max(1, Number(options.factor) || DEFAULTS.factor);
  const jitter = Math.max(0, Math.min(1, Number(options.jitter ?? DEFAULTS.jitter)));
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const now = typeof options.now === 'function' ? options.now : Date.now;

  let attempts = 0;
  let lastDelayMs = 0;
  let resetAt = null;

  /** 不减抖动的基础等待（attempts 为「这是第几次重试」，从 1 开始）。 */
  function rawDelayFor(n) {
    const exp = Math.max(0, n - 1);
    // factor 很大时 Math.pow 会溢出成 Infinity，先与 maxMs 比一下再算。
    const scaled = factor === 1 ? baseMs : baseMs * Math.pow(factor, exp);
    return Math.min(maxMs, Number.isFinite(scaled) ? scaled : maxMs);
  }

  return {
    version: VERSION,

    /** 当前已重试次数（成功一次即 reset）。 */
    get attempts() {
      return attempts;
    },

    /** 上一次给出的等待时间（毫秒）。 */
    get lastDelayMs() {
      return lastDelayMs;
    },

    /** 不推进状态地看一眼「下一次会等多久」（用于日志/健康上报）。 */
    peek() {
      return this.delayFor(attempts + 1);
    },

    /** 指定第 n 次重试的等待时间（含抖动）。 */
    delayFor(n) {
      const raw = rawDelayFor(Math.max(1, Number(n) || 1));
      if (jitter <= 0) return raw;
      // random 可能被注入成返回 1 的假实现，这里夹到 [0,1) 保证抖动不越界。
      const r = Math.max(0, Math.min(0.999999, Number(random()) || 0));
      const offset = raw * jitter * (r * 2 - 1);
      return Math.max(1, Math.round(raw + offset));
    },

    /** 取下一次等待时间并推进尝试计数。 */
    next() {
      attempts += 1;
      lastDelayMs = this.delayFor(attempts);
      return lastDelayMs;
    },

    /** 重连成功：回到起点。 */
    reset() {
      attempts = 0;
      lastDelayMs = 0;
      resetAt = now();
      return this;
    },

    /** 可观测状态（写日志/健康上报用）。 */
    state() {
      return {
        attempts,
        lastDelayMs,
        nextDelayMs: this.peek(),
        baseMs,
        maxMs,
        factor,
        jitter,
        resetAt,
      };
    },
  };
}