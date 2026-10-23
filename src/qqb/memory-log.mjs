// 给 dsh-qq-extras 归档器读的「对话流水」日志（state/qq-memory.log）。
//
// 为什么不直接改 state/qq-activity.log：
//   1) 活动日志被控制台 UI 与既有测试消费，且 createCappedLogger(..., 500) 只留 500 行；
//   2) 入站行是 `[HH:MM:SS] <key> [reserved2] 消息已入未读：<text>`，**不带发送者身份**，
//      而 dsh-qq-extras 的 collector 只认 `管理员 <昵称>：` 与 `agent 回复：` 两种说话人
//      （其它行一律 return null，等于一条都归档不进去）；
//   3) 归档要的是「主人 ↔ 小鲸鱼」的对话，带上真实昵称才值得存。
// 所以另写一份，格式刻意做成插件现成正则就能认的样子：
//
//   [HH:MM:SS] <key> 管理员 <昵称>：<text>
//   [HH:MM:SS] <key> agent 回复：<text>
//   [HH:MM:SS] <key> 成员 <昵称>：<text>      ← 群里其他人（插件原生不认，我们自己的归档器认）
//
// 这份日志只被 scripts/qq-extras-collector.mjs 读，写失败绝不能拖垮收发，
// 所以 createMemoryLogWriter().append() 内部把异常全部吞掉并返回 null。
import fs from 'node:fs';
import path from 'node:path';

/** 归档流水文件名（放在 state/ 下，与 qq-activity.log 同级）。 */
export const MEMORY_LOG_FILE = 'qq-memory.log';
/** 默认保留行数：归档器是增量的，留得比活动日志多得多。 */
export const DEFAULT_MAX_LINES = 5000;
/** 单条文字上限，避免一条超长消息把日志撑爆。 */
export const MAX_TEXT_CHARS = 800;
/** 行内时刻比当前时间晚超过这个毫秒数，就判断为「昨天的这一秒」（跨零点补归档）。 */
const FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

export function memoryLogPath(stateDir) {
  return path.join(String(stateDir), MEMORY_LOG_FILE);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function oneLine(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 本地时间 HH:MM:SS（与活动日志同一口径，方便对照）。 */
export function localClockText(atMs = Date.now()) {
  const d = new Date(atMs);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 把一条消息渲染成归档流水行；role 取 'owner' | 'agent' | 'member'。
 * 返回空串表示这条不值得写（没有正文）。
 */
export function formatMemoryLine({ clock, key, role, name, text }) {
  const body = oneLine(text).slice(0, MAX_TEXT_CHARS);
  if (!body) return '';
  const at = oneLine(clock) || localClockText();
  const where = oneLine(key) || 'unknown';
  if (role === 'agent') return `[${at}] ${where} agent 回复：${body}`;
  const who = oneLine(name) || (role === 'owner' ? '主人' : '成员');
  return `[${at}] ${where} ${role === 'owner' ? '管理员' : '成员'} ${who}：${body}`;
}

/**
 * 解析归档流水行 → { clock, key, role, name, text }；认不出来返回 null。
 * 与 dsh-qq-extras/collector.mjs 的 `^\[(\d{2}:\d{2}:\d{2})\] (\S+) (.*?)：(.*)$` 口径一致
 * （说话人必须是 `管理员 <名>` / `agent 回复`），另外多认我们自己的 `成员 <名>`。
 */
export function parseMemoryLine(raw) {
  const line = String(raw ?? '').trim();
  const head = /^\[(\d{2}:\d{2}:\d{2})\]\s+(\S+)\s+(.+)$/.exec(line);
  if (!head) return null;
  const [, clock, key, rest] = head;
  const sep = rest.indexOf('：');
  if (sep <= 0) return null;
  const speaker = rest.slice(0, sep).trim();
  const text = rest.slice(sep + 1).trim();
  if (!text || !speaker) return null;
  if (speaker === 'agent 回复' || speaker === 'agent') return { clock, key, role: 'agent', name: 'agent', text, raw: line };
  if (speaker.startsWith('管理员')) {
    return { clock, key, role: 'owner', name: speaker.replace(/^管理员\s*/, '') || '管理员', text, raw: line };
  }
  if (speaker.startsWith('成员')) {
    return { clock, key, role: 'member', name: speaker.replace(/^成员\s*/, '') || '成员', text, raw: line };
  }
  return null;
}

export function parseMemoryLog(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const rec = parseMemoryLine(line);
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * 行内时刻 → 归档用的时间戳 `YYYY-MM-DD HH:MM:SS`。
 * 日志行只有时刻没有日期，所以按「当天」补；若该时刻比现在还晚 10 分钟以上，
 * 则判为昨天（跨零点时归档器补跑上一分钟的日志就落在这条分支上）。
 */
export function memoryLogTimestamp(clock, now = new Date()) {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(clock ?? ''));
  const d = new Date(now.getTime());
  if (!m) return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${localClockText(d.getTime())}`;
  d.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
  if (d.getTime() - now.getTime() > FUTURE_TOLERANCE_MS) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 归档流水写入器。append({ key, role, name, text }) → 写入的行（没写返回 null）。
 * 超过 maxLines 时只保留最后 maxLines 行（与 createCappedLogger 同一思路，只是留得多）。
 */
export function createMemoryLogWriter({ file, maxLines = DEFAULT_MAX_LINES, enabled = true, clock = localClockText } = {}) {
  let lineCount = null;
  const countLines = () => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  };
  const append = (rec) => {
    if (!enabled || !file) return null;
    let line = '';
    try {
      line = formatMemoryLine({ clock: typeof clock === 'function' ? clock() : clock, key: rec?.key, role: rec?.role, name: rec?.name, text: rec?.text });
      if (!line) return null;
      if (lineCount === null) lineCount = countLines();
      fs.appendFileSync(file, line + '\n');
      lineCount += 1;
      const cap = Number(maxLines);
      if (Number.isFinite(cap) && cap > 0 && lineCount > cap) {
        const kept = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).slice(-cap);
        fs.writeFileSync(file, kept.length ? kept.join('\n') + '\n' : '');
        lineCount = kept.length;
      }
      return line;
    } catch {
      return null;
    }
  };
  return {
    append,
    file,
    maxLines,
    enabled,
    /** 仅供测试：重置内存里的行数缓存。 */
    _resetCount() { lineCount = null; }
  };
}