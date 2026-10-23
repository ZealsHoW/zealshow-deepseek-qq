// 工具调用日志（JSONL）的唯一写入口。
//
// 为什么需要它：桥接原来只有 DSH 那条链路会写 `state/tool-calls.jsonl`——
// 工具调用是 DSH 侧的工具事件推给桥接、桥接再落盘的。直连引擎（`engine/loop`）
// 自己执行工具、统计只放在内存里，所以引擎一接管主链路，这份日志就整段变黑：
// 事后没人答得出「她今天调了哪些工具、失败了几次」。这个模块把落盘能力抽出来，
// 让两条链路写同一份文件、同一套格式。
//
// **一个文件只能有一个计数器。** 上限轮转靠的是「启动时数一次行数，之后 O(1) 追加，
// 到上限 rename 成 .1」——两条链路各建一个计数器的话，两边各数各的，实际上限会变成
// 两倍，而且一边 rename 之后另一边的计数还停在旧值，轮转时机变得不可预测。
// 所以 `createCallLog()` 在一个进程里**只应该建一次**，两条链路共用同一个实例：
// 引擎走 `append(entry)`（带脱敏），桥接侧已自带脱敏、走 `appendLine(text)`。
import fs from 'node:fs';
import path from 'node:path';

import { redactSecrets } from './log.mjs';

export const VERSION = '0.1.0';

/** 默认保留多少行，超出即轮转到 `<file>.1`（与桥接既有工具日志一致）。 */
export const DEFAULT_MAX_LINES = 2000;

/** 单个字段（字符串）最长留多少字符，超出截断——防止模型把整段群聊塞进 args。 */
export const MAX_FIELD_CHARS = 2000;

/**
 * 参数里这些键一律打码。
 * 与 `bridge.js` 的 `SENSITIVE_ARG_KEYS` 保持同一份名单：引擎调用时会注入会话 `token`，
 * 那是真正的 agent token，**绝不能明文落盘**。
 */
export const SENSITIVE_ARG_KEYS = Object.freeze(new Set([
  'token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key',
  'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session',
  'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken',
  'refresh_token', 'x-agent-token', 'x_agent_token',
]));

/** 这些键不能出现在日志对象里（原型链污染护栏）。 */
const UNSAFE_KEYS = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

/**
 * 抹掉文本里的凭据特征（`sk-...`、`Bearer ...`、`apiKey: ...` 等）。
 * 复用 `core/log` 的那份正则，避免两处脱敏规则各自漂移。
 * @param {unknown} input
 * @returns {string}
 */
export function redactText(input) {
  return redactSecrets(input);
}

function normalizeField(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') {
    const text = redactText(value);
    return text.length > MAX_FIELD_CHARS
      ? `${text.slice(0, MAX_FIELD_CHARS)}…（已截断 ${text.length} 字符）`
      : text;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (typeof value === 'function') return '[function]';
  if (depth >= 4) return '[deep]';
  if (Array.isArray(value)) {
    const head = value.slice(0, 50).map((item) => normalizeField(item, depth + 1));
    return value.length > 50 ? [...head, `…共 ${value.length} 项`] : head;
  }
  // 用无原型对象承接：日志对象的键来自模型/工具参数，不能让它碰到原型链。
  const out = Object.create(null);
  let n = 0;
  for (const [key, item] of Object.entries(value)) {
    const name = String(key).toLowerCase();
    if (UNSAFE_KEYS.has(name)) continue;
    // 敏感键**每一层**都要打码：会话 token 就藏在 args 里面，
    // 只在顶层检查等于没检查（这里踩过一次，测试锁住了）。
    if (SENSITIVE_ARG_KEYS.has(name)) {
      out[key] = item == null || item === '' ? item : '***';
      continue;
    }
    out[key] = normalizeField(item, depth + 1);
    if (++n >= 50) { out['…'] = '字段过多已截断'; break; }
  }
  return out;
}

/**
 * 脱敏一条日志条目：按**键名**打码敏感字段，其余字符串过凭据正则，超长截断。
 * 纯函数，便于单测。
 * @param {object} entry
 * @returns {object}
 */
export function redactEntry(entry) {
  if (!entry || typeof entry !== 'object') return Object.create(null);
  const out = Object.create(null);
  for (const [key, value] of Object.entries(entry)) {
    if (UNSAFE_KEYS.has(String(key).toLowerCase())) continue;
    if (SENSITIVE_ARG_KEYS.has(String(key).toLowerCase())) {
      out[key] = value == null || value === '' ? value : '***';
      continue;
    }
    out[key] = normalizeField(value);
  }
  return out;
}

/**
 * 建一个工具调用日志写入器。**一个文件、一个进程只建一次**（见文件头注释）。
 *
 * @param {{file: string, maxLines?: number, now?: () => Date}} options
 */
export function createCallLog(options = {}) {
  const file = String(options.file ?? '');
  if (!file) throw new Error('createCallLog 需要一个 file 路径');
  const maxLines = Math.max(1, Number(options.maxLines) || DEFAULT_MAX_LINES);
  const now = options.now ?? (() => new Date());

  let lines = -1; // -1 = 还没数过（第一次追加时数一次）
  let rotations = 0;
  let appended = 0;
  let writeError = null;

  function countLines() {
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    } catch {
      lines = 0;
    }
  }

  /**
   * 追加**一行**（调用方自己保证单行且已脱敏）。永不抛：
   * 日志写不进去是麻烦，但绝不能让日志把服务或这一轮对话拖垮。
   * @param {string} text
   * @returns {boolean} 是否写成功
   */
  function appendLine(text) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (lines < 0) countLines();
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      appended += 1;
      if (lines > maxLines) {
        // 轮转：改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        rotations += 1;
        lines = 0;
      }
      writeError = null;
      return true;
    } catch (error) {
      writeError = redactText(error?.message ?? error);
      return false;
    }
  }

  /**
   * 写一条结构化条目（自动脱敏 + 序列化 + 追加一行）。
   * @param {object} entry
   * @returns {boolean}
   */
  function append(entry) {
    let line;
    try {
      line = `${JSON.stringify(redactEntry(entry))}\n`;
    } catch (error) {
      writeError = redactText(error?.message ?? error);
      return false;
    }
    return appendLine(line);
  }

  /**
   * 清空日志。**必须走这里，不要自己 `fs.writeFileSync(file, '')`**：
   * 内存计数器还记着旧行数的话，下一次追加会立刻触发轮转，
   * 把刚清空的空文件改名成 `.1`，看起来像「清空没生效」。
   * @returns {boolean}
   */
  function clear() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '', 'utf8');
      lines = 0;
      appended = 0;
      writeError = null;
      return true;
    } catch (error) {
      writeError = redactText(error?.message ?? error);
      return false;
    }
  }

  /** 读回最近的若干条（解析不了的行走跳过，不抛）。 */
  function read(limit = 200) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const all = raw.split('\n').filter(Boolean);
      const want = Math.max(1, Math.min(1000, Number(limit) || 200));
      const out = [];
      for (const line of all.slice(-want)) {
        try { out.push(JSON.parse(line)); } catch {}
      }
      return out;
    } catch {
      return [];
    }
  }

  return {
    version: VERSION,
    file,
    maxLines,
    today: () => now(),
    append,
    appendLine,
    clear,
    read,
    stats: () => ({ lines, appended, rotations, writeError }),
    /** 仅供测试：忘掉已数过的行数，下次追加重新数。 */
    _recount: () => { lines = -1; },
  };
}