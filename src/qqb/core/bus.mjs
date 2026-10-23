// 进程内事件总线。
//
// 存在的理由（R3「单模块异常降级而非整体宕机」）：模块之间不该直接互调，
// 否则任何一个模块抛错都会顺着调用栈炸掉上游（历史事故里就是一处 apply() 抛错
// 把整个 preset 变 invalid，QQ 会话全建不起来）。这里把投递和监听者隔离：
// 监听者抛错只记日志、不影响其它监听者，也不回抛给 emit 的调用方。
import { EventEmitter } from 'node:events';

export const VERSION = '0.1.0';

/**
 * @param {{logger?: any, historyLimit?: number}} [options]
 */
export function createBus(options = {}) {
  const logger = options.logger ?? null;
  const historyLimit = Number.isFinite(options.historyLimit) ? Number(options.historyLimit) : 50;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);
  /** @type {Map<string, {ts: string, payload: unknown}[]>} */
  const history = new Map();

  function record(channel, payload) {
    const list = history.get(channel) ?? [];
    list.push({ ts: new Date().toISOString(), payload });
    if (list.length > historyLimit) list.splice(0, list.length - historyLimit);
    history.set(channel, list);
  }

  return {
    on(channel, listener) {
      emitter.on(channel, listener);
      return () => emitter.off(channel, listener);
    },
    once(channel, listener) {
      emitter.once(channel, listener);
      return () => emitter.off(channel, listener);
    },
    off(channel, listener) {
      emitter.off(channel, listener);
    },
    /** 投递：先记历史，再逐个调用（异常隔离），最后给 '*' 通配监听者。 */
    emit(channel, payload) {
      record(channel, payload);
      let delivered = 0;
      for (const listener of emitter.listeners(channel)) {
        try {
          listener(payload);
          delivered += 1;
        } catch (error) {
          logger?.error?.('事件监听者抛错（已隔离）', { channel, error });
        }
      }
      for (const listener of emitter.listeners('*')) {
        try {
          listener(channel, payload);
          delivered += 1;
        } catch (error) {
          logger?.error?.('通配监听者抛错（已隔离）', { channel, error });
        }
      }
      return delivered;
    },
    /** 回放某通道最近 n 条历史（给晚到的订阅者）。 */
    replay(channel, listener, n = historyLimit) {
      const list = (history.get(channel) ?? []).slice(-n);
      for (const item of list) {
        try {
          listener(item.payload, item.ts);
        } catch (error) {
          logger?.error?.('回放监听者抛错（已隔离）', { channel, error });
        }
      }
      return list.length;
    },
    history: (channel, n = historyLimit) => (history.get(channel) ?? []).slice(-n),
    channels: () => [...history.keys()],
    listenerCount: (channel) => emitter.listenerCount(channel),
    clear: () => { history.clear(); emitter.removeAllListeners(); },
  };
}