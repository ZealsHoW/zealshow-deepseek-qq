// config.json 的统一读写入口。
//
// 三条硬约束（都踩过坑）：
//   · 写盘必须**无 BOM**：node 的 JSON.parse 遇到 BOM 会直接抛（历史上就是这么坏的）。
//   · 写入必须原子：临时文件 + rename，避免半截 JSON 被 DSH 全局搜索或下一次启动读到。
//   · 解析失败**不能把配置清空**：保留上一份好配置，标记 invalid，让调用方降级而不是崩。
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.0';

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 点号路径取值，如 `dsh.baseUrl`。 */
export function getPath(object, dotted, fallback) {
  let cursor = object;
  for (const key of String(dotted).split('.')) {
    if (cursor == null || typeof cursor !== 'object' || !(key in cursor)) return fallback;
    cursor = cursor[key];
  }
  return cursor === undefined ? fallback : cursor;
}

function setPath(object, dotted, value) {
  const keys = String(dotted).split('.');
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    if (cursor[key] == null || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
  return object;
}

/**
 * @param {{root: string, file?: string, logger?: any}} options
 */
export function createConfig(options = {}) {
  const root = options.root ?? process.cwd();
  const file = options.file ?? path.join(root, 'config.json');
  const logger = options.logger ?? null;
  /** @type {any} */
  let data = {};
  let mtimeMs = -1;
  let loaded = false;
  /** @type {string|null} */
  let invalid = null;
  let invalidReported = null;

  function readFromDisk() {
    let text;
    try {
      text = stripBom(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      invalid = `读取失败：${error?.message ?? error}`;
      reportInvalid();
      return false;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        invalid = '顶层不是对象';
        reportInvalid();
        return false;
      }
      data = parsed;
      invalid = null;
      loaded = true;
      return true;
    } catch (error) {
      invalid = `JSON 解析失败：${error?.message ?? error}`;
      reportInvalid();
      return false;
    }
  }

  function reportInvalid() {
    if (invalid && invalid !== invalidReported) {
      invalidReported = invalid;
      logger?.error?.('config.json 不可用，保留上一份好配置', { file, reason: invalid });
    }
  }

  function reload({ force = false } = {}) {
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    const currentMtime = stat?.mtimeMs ?? -1;
    if (!force && loaded && currentMtime === mtimeMs) return data;
    mtimeMs = currentMtime;
    readFromDisk();
    return data;
  }

  const api = {
    file,
    reload,
    all() { return reload(); },
    get(dotted, fallback) { return getPath(reload(), dotted, fallback); },
    invalid: () => invalid,
    stats: () => ({ file, mtimeMs, loaded, invalid, keys: Object.keys(reload()).length }),
    /** 单键写入（原子、无 BOM），返回是否写成功。 */
    set(dotted, value) {
      const next = JSON.parse(JSON.stringify(reload() ?? {}));
      setPath(next, dotted, value);
      return write(next);
    },
    /** 用回调整体改写，回调返回新对象（或原地改后返回 undefined）。 */
    update(mutator) {
      const current = JSON.parse(JSON.stringify(reload() ?? {}));
      const produced = mutator(current);
      return write(produced && typeof produced === 'object' ? produced : current);
    },
    path: getPath,
  };

  function write(next) {
    const tmp = `${file}.tmp-qqb-${process.pid}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8' });
      fs.renameSync(tmp, file);
      data = next;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { mtimeMs = -1; }
      invalid = null;
      logger?.info?.('config.json 已更新', { file });
      return true;
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉就算了 */ }
      logger?.error?.('config.json 写入失败', { file, error });
      return false;
    }
  }

  reload({ force: true });
  return api;
}