// R8 跨会话定向投递：主人在任意窗口用自然语言托付「去给某人/某群说句话」。
//
// 设计边界（来自需求 R8）：
// - 主人的外部指令只是**提议**，优先级低于她本人的意愿；她可以拒绝、改口、委婉推辞。
// - 最终内容由她按人设与心境生成，**不是复述原话**（所以 accept 时带的是她自己写的 text）。
// - 只有主人能创建（from 必须是 owner）；任务进独立队列，可撤回未执行的。
// - 全程留日志：下达人、指令原文、发送对象、最终产出、执行/拒绝理由。
//
// 本模块只做「解析 + 队列 + 状态机 + 落盘」，发送与回执由 bridge.js 负责（它才有发送/权限链路）。
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.0';

/** 任务状态。pending=待她定夺；accepted=她答应了（内容已生成，等发送）；sent/declined/withdrawn/failed/expired=终态。 */
export const STATUSES = ['pending', 'accepted', 'sent', 'declined', 'withdrawn', 'failed', 'expired'];

/** 默认别名表（可用 config.socialV2.directed.aliases 覆盖/追加）。词表按「长的优先」匹配。
 *
 * ⚠ 这里的 id 是**示例号**，不是真人：2026-10-23 发布前扫描发现这张表曾经写死作者家
 * 爸爸/妈妈/朋友/家庭群的真实 QQ 号 —— 公开仓库会把它永久记进 git 历史。
 * 真实号码只放在 config.json 的 socialV2.directed.aliases（不入库），配置非空时与这张表合并。 */
export const DEFAULT_ALIASES = [
  { name: '爸爸', kind: 'private', id: '1000000001', words: ['爸爸', '老爸', '爸', '老爹', '爹'] },
  { name: '妈妈', kind: 'private', id: '1000000002', words: ['妈妈', '老妈', '妈', '娘'] },
  { name: '朋友', kind: 'private', id: '1000000003', words: ['朋友', '室友', '同学'] },
  { name: '家庭群', kind: 'group', id: '900000001', words: ['家庭群', '家里群', '家群', '家族群', '家人群'] }
];

const SEND_VERB = /(发|说|讲|问|聊|转告|带话|告诉|知会|道个|打个招呼|问候)/;
const TRIGGER = /(你去|帮我|替我|代我|给我去|去给|去跟|去和|去问|去说)/;
const URGENT = /(马上|立刻|赶紧|现在就|快点|尽快)/;
const LATER = /(一会儿|待会|等会|晚点|不急|有空)/;
const NOISE = /^(你|你去|帮我|替我|代我|给我|给我去|去|去给|去跟|去和|去问|去说|给|跟|和|向|对|请)+/;

function clampText(value, max = 500) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 把一条自然语言解析成定向任务（匹配不上返回 { matched:false, reason }）。 */
export function parseDirective(text, options = {}) {
  const aliases = Array.isArray(options.aliases) && options.aliases.length ? options.aliases : DEFAULT_ALIASES;
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (raw.length < 4) return { matched: false, reason: '太短' };

  let target = null;
  const digits = raw.match(/(?:^|\D)(\d{5,12})(?:\D|$)/);
  if (digits) {
    const id = digits[1];
    const inGroups = Array.isArray(options.allowGroups) && options.allowGroups.includes(Number(id));
    target = { name: id, id, kind: inGroups ? 'group' : 'private' };
  } else {
    const hits = [];
    for (const alias of aliases) {
      for (const word of alias.words ?? []) {
        if (!word) continue;
        const lower = word.toLowerCase();
        const at = raw.toLowerCase().indexOf(lower);
        if (at >= 0) hits.push({ alias, word, at, len: word.length });
      }
    }
    if (hits.length) {
      hits.sort((a, b) => b.len - a.len);
      const hit = hits[0];
      target = { name: hit.alias.name, id: String(hit.alias.id), kind: hit.alias.kind ?? 'private', alias: hit.word };
    }
  }
  if (!target) return { matched: false, reason: '没认出对象' };

  const hasVerb = SEND_VERB.test(raw);
  const hasTrigger = TRIGGER.test(raw);
  if (!hasVerb && !hasTrigger) return { matched: false, reason: '不像托付' };
  // 光有对象 + 动词还不够：日常聊天里「妈妈说…」也会命中「说」。要求明显的托付语气。
  if (!hasTrigger && !/(给|跟|和|向|对)\s*\S{0,6}(发|说|讲|问|聊|转告|带话|告诉|知会|道个|打个招呼)/.test(raw)) {
    return { matched: false, reason: '没有「托付给谁」的语气' };
  }

  let rest = raw;
  if (target.alias) rest = rest.replace(target.alias, ' ');
  for (const alias of aliases) {
    if (alias.name === target.name) continue;
  }
  rest = rest.replace(/\d{5,12}/g, ' ').replace(NOISE, ' ').replace(/^(给|跟|和|向|对)/, ' ')
    .replace(/(发个?消息|发条?消息|发一句|说一句|说一声|说句话|说一下|讲一声|讲一下|问一下|问一问|问一句|聊两句|聊一下|聊一句|转告|带个话|带话|告诉|知会|道个|道声|道一句|打个招呼)/g, ' ')
    .replace(/[，,。.!！?？；;、~～]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  rest = rest
    .replace(/^(在|去|到|从|里|中|的|了|吧|啊|呀|哦|嘛|那|就|一下|一声|一句|\s)+/g, '')
    .replace(/(在|里|中|的|了|吧|啊|呀|哦|嘛|一下|一声|一句|\s)+$/g, '')
    .trim();
  const intent = rest ? clampText(rest, 200) : '（主人没说要说什么，你自己看着说）';
  const urgency = URGENT.test(raw) ? 'high' : (LATER.test(raw) ? 'low' : 'normal');
  const confidence = digits || hasTrigger ? 0.9 : 0.7;
  return { matched: true, target, intent, raw: clampText(raw, 300), urgency, confidence };
}

/**
 * 定向任务队列：JSONL 追加日志 + 启动回放（和发送队列 outbox 同一套思路，但没有退避重试）。
 * 所有方法都不抛：写盘失败只记日志、返回安全值（她的事业不能被一个坏文件搞停）。
 */
export function createDirected(options = {}) {
  const root = options.root ?? process.cwd();
  const file = options.file ?? path.join(root, 'state', 'directives.jsonl');
  const logger = options.logger ?? {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxPending = Number.isFinite(options.maxPending) && options.maxPending > 0 ? options.maxPending : 20;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 30 * 60 * 1000;
  const aliases = Array.isArray(options.aliases) && options.aliases.length ? options.aliases : DEFAULT_ALIASES;

  const items = new Map();
  let seq = 0;
  let updatedAt = 0;

  function warn(message, detail) {
    try {
      logger.warn?.(message, detail);
    } catch {
      /* 日志失败不能影响主流程 */
    }
  }

  function append(row) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
      updatedAt = now();
      return true;
    } catch (error) {
      warn(`定向任务落盘失败：${error?.message ?? error}`, file);
      return false;
    }
  }

  function apply(row) {
    if (!row || typeof row !== 'object') return;
    if (row.op === 'add') {
      items.set(String(row.id), {
        id: String(row.id),
        ts: Number(row.ts ?? 0),
        from: row.from ?? 'owner',
        originKey: row.originKey ?? '',
        target: row.target ?? { kind: 'private', id: '', name: '' },
        intent: row.intent ?? '',
        raw: row.raw ?? '',
        urgency: row.urgency ?? 'normal',
        status: 'pending',
        finalText: '',
        reason: '',
        actor: row.from ?? 'owner',
        decidedAt: 0,
        sentAt: 0,
        result: null
      });
      seq = Math.max(seq, Number(row.id) || 0);
      return;
    }
    const item = items.get(String(row.id));
    if (!item) return;
    if (row.op === 'decision') {
      item.status = row.status ?? item.status;
      item.finalText = row.finalText ?? item.finalText;
      item.reason = row.reason ?? item.reason;
      item.actor = row.actor ?? item.actor;
      item.decidedAt = Number(row.ts ?? 0);
    } else if (row.op === 'sent') {
      item.status = 'sent';
      item.finalText = row.finalText ?? item.finalText;
      item.sentAt = Number(row.ts ?? 0);
      item.result = row.result ?? null;
    } else if (row.op === 'failed') {
      item.status = 'failed';
      item.reason = row.reason ?? item.reason;
      item.result = row.result ?? null;
    } else if (row.op === 'withdraw') {
      item.status = 'withdrawn';
      item.actor = row.actor ?? 'owner';
      item.reason = row.reason ?? item.reason;
      item.decidedAt = Number(row.ts ?? 0);
    } else if (row.op === 'expire') {
      item.status = 'expired';
      item.reason = row.reason ?? '太久没顾上';
      item.decidedAt = Number(row.ts ?? 0);
    }
    updatedAt = Math.max(updatedAt, Number(row.ts ?? 0));
  }

  function load() {
    items.clear();
    seq = 0;
    updatedAt = 0;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return { loaded: 0 };
    }
    let loaded = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        apply(JSON.parse(line));
        loaded += 1;
      } catch {
        /* 坏行跳过 */
      }
    }
    return { loaded };
  }

  const loadResult = load();

  function list(opts = {}) {
    const status = opts.status ?? null;
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 50;
    let rows = [...items.values()];
    if (status) rows = rows.filter((row) => row.status === status);
    rows.sort((a, b) => b.ts - a.ts || (Number(b.id) || 0) - (Number(a.id) || 0));
    return rows.slice(0, limit);
  }

  function pending() {
    return list({ status: 'pending', limit: 100 });
  }

  function get(id) {
    return items.get(String(id)) ?? null;
  }

  function create(entry = {}) {
    const from = entry.from ?? 'owner';
    if (from !== 'owner') return { ok: false, error: '定向投递只能由主人下达' };
    const target = entry.target ?? null;
    if (!target?.id) return { ok: false, error: '缺少发送对象' };
    const current = pending();
    if (current.length >= maxPending) {
      return { ok: false, error: `待办太多（${current.length}/${maxPending}），先让她把这批处理完` };
    }
    const id = String(++seq);
    const ts = now();
    const row = {
      op: 'add',
      id,
      ts,
      from,
      originKey: entry.originKey ?? '',
      target: { kind: target.kind === 'group' ? 'group' : 'private', id: String(target.id), name: clampText(target.name ?? target.id, 40) },
      intent: clampText(entry.intent ?? '', 200),
      raw: clampText(entry.raw ?? '', 300),
      urgency: ['high', 'low', 'normal'].includes(entry.urgency) ? entry.urgency : 'normal'
    };
    apply(row);
    append(row);
    return { ok: true, directive: get(id) };
  }

  function decide(entry = {}) {
    const item = get(entry.id);
    if (!item) return { ok: false, error: '任务不存在' };
    if (item.status !== 'pending') return { ok: false, error: `任务已是 ${item.status}，不能再定夺` };
    const action = entry.action;
    if (action !== 'accept' && action !== 'decline') return { ok: false, error: 'action 只能是 accept / decline' };
    const ts = now();
    const row = action === 'accept'
      ? { op: 'decision', id: item.id, ts, status: 'accepted', finalText: clampText(entry.text ?? item.intent, 300), reason: clampText(entry.reason ?? '', 120), actor: entry.actor ?? 'self' }
      : { op: 'decision', id: item.id, ts, status: 'declined', reason: clampText(entry.reason ?? '她这次不想说', 120), actor: entry.actor ?? 'self' };
    apply(row);
    append(row);
    return { ok: true, directive: get(item.id) };
  }

  function withdraw(entry = {}) {
    const item = get(entry.id);
    if (!item) return { ok: false, error: '任务不存在' };
    if (item.status !== 'pending') return { ok: false, error: `任务已是 ${item.status}，撤不回来了` };
    const row = { op: 'withdraw', id: item.id, ts: now(), actor: entry.actor ?? 'owner', reason: clampText(entry.reason ?? '主人撤回', 120) };
    apply(row);
    append(row);
    return { ok: true, directive: get(item.id) };
  }

  function markSent(entry = {}) {
    const item = get(entry.id);
    if (!item) return { ok: false, error: '任务不存在' };
    const row = {
      op: 'sent',
      id: item.id,
      ts: now(),
      finalText: clampText(entry.text ?? item.finalText ?? item.intent, 300),
      result: entry.result ?? null
    };
    apply(row);
    append(row);
    return { ok: true, directive: get(item.id) };
  }

  function markFailed(entry = {}) {
    const item = get(entry.id);
    if (!item) return { ok: false, error: '任务不存在' };
    const row = { op: 'failed', id: item.id, ts: now(), reason: clampText(entry.error ?? '发送失败', 160), result: entry.result ?? null };
    apply(row);
    append(row);
    return { ok: true, directive: get(item.id) };
  }

  /** 过期未定夺的任务（默认 30 分钟）——不能永远挂在那儿，回执要说清是「没顾上」。 */
  function expire(opts = {}) {
    const ttl = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : ttlMs;
    const at = now();
    const expired = [];
    for (const item of items.values()) {
      if (item.status !== 'pending') continue;
      if (at - item.ts < ttl) continue;
      const row = { op: 'expire', id: item.id, ts: at, reason: opts.reason ?? '太久没顾上' };
      apply(row);
      append(row);
      expired.push(get(item.id));
    }
    return expired;
  }

  function stats() {
    const byStatus = {};
    for (const status of STATUSES) byStatus[status] = 0;
    for (const item of items.values()) byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    return { total: items.size, pending: byStatus.pending ?? 0, byStatus, updatedAt, file, maxPending, ttlMs };
  }

  function aliasTable() {
    return aliases.map((alias) => ({ name: alias.name, id: String(alias.id), kind: alias.kind ?? 'private', words: [...(alias.words ?? [])] }));
  }

  return {
    version: VERSION,
    path: file,
    loaded: loadResult.loaded,
    aliases,
    aliasTable,
    parse: (text, extra = {}) => parseDirective(text, { aliases, ...extra }),
    create,
    list,
    pending,
    get,
    decide,
    withdraw,
    markSent,
    markFailed,
    expire,
    stats,
    reload: load
  };
}