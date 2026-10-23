// 结构化日志（R3「输出清晰日志」的地基）。
//
// 为什么不用 console 拼字符串：小鲸鱼的服务群是常驻多模块进程，
// 出问题时要能按模块、按级别、按时间翻查，还要**永不把密钥写进日志**。
// 所以统一走这里：每行一条 JSON（JSONL，按天分文件），字段固定 ts/level/module/msg，
// 其余字段由调用方给；字符串一律过脱敏，超长字段截断，写失败也绝不抛（否则日志会拖垮服务）。
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.0';

/** @type {readonly string[]} 由低到高 */
export const LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

const MAX_FIELD_CHARS = 2000;
const MAX_STACK_LINES = 6;

/**
 * 抹掉日志里不该出现的凭据。
 * 覆盖本仓库实际用到的形态：OpenAI/DeepSeek 的 `sk-...`、HTTP 头里的 `Bearer ...`、
 * 以及 `"apiKey": "..."` / `accessToken=...` 这类键值对。
 * @param {unknown} input
 * @returns {string}
 */
export function redactSecrets(input) {
  let out = String(input ?? '');
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
  out = out.replace(
    /((?:api[_-]?key|access[_-]?token|http[_-]?token|console[_-]?token|agent[_-]?token|token|secret|password)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{6,})/gi,
    '$1***',
  );
  return out;
}

function ymd(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** 默认日志目录：<root>/state/logs（与桥接现有 state/ 同级，备份脚本已覆盖 state）。 */
export function defaultLogDir(root) {
  return path.join(root, 'state', 'logs');
}

function normalizeField(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') {
    const text = redactSecrets(value);
    return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…（已截断 ${text.length} 字符）` : text;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecrets(value.message),
      stack: redactSecrets(String(value.stack ?? ''))
        .split('\n').slice(0, MAX_STACK_LINES).join('\n'),
    };
  }
  if (typeof value === 'function') return '[function]';
  if (depth >= 4) return '[deep]';
  if (Array.isArray(value)) {
    const head = value.slice(0, 50).map((item) => normalizeField(item, depth + 1));
    return value.length > 50 ? [...head, `…共 ${value.length} 项`] : head;
  }
  const out = {};
  let n = 0;
  for (const [key, item] of Object.entries(value)) {
    out[key] = normalizeField(item, depth + 1);
    if (++n >= 50) { out['…'] = '字段过多已截断'; break; }
  }
  return out;
}

/**
 * @param {{
 *   module: string,
 *   root?: string,
 *   dir?: string,
 *   file?: string,
 *   level?: string,
 *   echo?: boolean,
 *   memoryLimit?: number,
 *   now?: () => Date,
 * }} options
 */
export function createLogger(options = {}) {
  const module = String(options.module ?? 'qqb');
  const root = options.root ?? process.cwd();
  const dir = options.dir ?? defaultLogDir(root);
  const fixedFile = options.file ?? null;
  const echo = options.echo ?? process.env.QQB_LOG_CONSOLE === '1';
  const memoryLimit = Number.isFinite(options.memoryLimit) ? Number(options.memoryLimit) : 500;
  const now = options.now ?? (() => new Date());
  /** @type {{ts: string, level: string, module: string, msg: string, [k: string]: unknown}[]} */
  const memory = [];
  let level = String(options.level ?? process.env.QQB_LOG_LEVEL ?? 'info').toLowerCase();
  if (!LEVELS.includes(level)) level = 'info';
  let writeError = null;
  let warnedWriteError = false;

  const targetFile = () => fixedFile ?? path.join(dir, `qqb-${ymd(now())}.jsonl`);

  function persist(entry) {
    const file = targetFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
      writeError = null;
    } catch (error) {
      writeError = redactSecrets(error?.message ?? error);
      if (!warnedWriteError) {
        warnedWriteError = true;
        process.stderr.write(`[qqb/log] 日志写入失败（后续不再重复提示）：${writeError}\n`);
      }
    }
  }

  function log(atLevel, msg, fields) {
    if (LEVELS.indexOf(atLevel) < LEVELS.indexOf(level)) return null;
    const entry = {
      ts: now().toISOString(),
      level: atLevel,
      module,
      msg: redactSecrets(msg),
    };
    if (fields && typeof fields === 'object') {
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'ts' || key === 'level' || key === 'module' || key === 'msg') continue;
        entry[key] = normalizeField(value);
      }
    }
    memory.push(entry);
    if (memory.length > memoryLimit) memory.splice(0, memory.length - memoryLimit);
    if (echo) process.stdout.write(`[${entry.ts}] ${atLevel.toUpperCase()} ${module} ${entry.msg}\n`);
    persist(entry);
    return entry;
  }

  const logger = {
    module,
    get level() { return level; },
    setLevel(next) {
      const wanted = String(next ?? '').toLowerCase();
      if (LEVELS.includes(wanted)) level = wanted;
      return level;
    },
    isEnabled(atLevel) { return LEVELS.indexOf(atLevel) >= LEVELS.indexOf(level); },
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    /** 同一下沉，换个模块名（如 `core.health` → `core.health.onebot`）。 */
    child(sub) {
      return createLogger({
        module: `${module}.${sub}`,
        root, dir, file: fixedFile ?? undefined, level, echo, memoryLimit, now,
      });
    },
    file: () => targetFile(),
    writeError: () => writeError,
    entries: () => memory.slice(),
    tail: (n = 20) => memory.slice(-n),
    clear: () => { memory.length = 0; },
  };
  return logger;
}