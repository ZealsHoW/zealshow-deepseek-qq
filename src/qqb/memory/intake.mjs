/**
 * R1 记忆库：历史对话 → 长期记忆的「摄入层」（intake）。
 *
 * 为什么需要它：`store.mjs` 只提供存取，`live.mjs` 只做「桥接写一次、这里镜像一次」。
 * 那两条路都依赖模型主动调用 `qq_memory_*` 工具 —— 而四个真实会话的轻量记忆长期是空的
 * （见 CHANGE §十三 的盘点），也就是说：**没人调用，记忆库就永远是空的**。
 * 所以长期记忆必须有一条自己会跑的路：定期把 `state/history/*.jsonl` 里值得记的话，
 * 按规则沉淀进 memory.db。
 *
 * 为什么不直接上 LLM 提炼：token。用户 R1 明确要求「减少冗余 LLM 提炼以控制 token」。
 * 这里的规则抽取完全免费（只是正则 + 写库），命中率低、但不会误伤钱包；
 * 以后要加 LLM 精炼时，它必须走 `source='llm-extract'`（`store.remember` 只对这一个
 * source 扣 `extract:<scope>` 配额），跟这条免费通道分开计费、分开开关。
 *
 * 只做「抽取 + 归档水位」两件事，不负责读文件：读历史由调用方注入
 * （桥接传自己的 `readHistoryRecords`，它认 `.1` 轮转；测试传自己的假 reader）。
 * 好处是模块不需要知道桥接的目录结构，也不会跟桥接的实现漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalScope, layerForKey } from './live.mjs';

export const VERSION = '0.1.0';

/** 规则集版本：改了规则就 +1，会写进每条记忆的 meta，便于回溯「这条是怎么来的」。
 *  v2：身份/安排类只记别人说的（她自己的台词和「明天少吃点」不是长期记忆）、
 *      去掉反问与引用前缀（「是不是你」曾把「我是」误命中）。 */
export const RULE_VERSION = 2;

/**
 * 规则表。每条规则都要求「未来/身份标记 + 谓语」两个成分同时出现，
 * 宁可漏记也不要把「哈哈哈」「在吗」这种灌进长期库 —— 记忆库一旦变垃圾场，
 * 每次召回都会污染唤醒提示，比没有记忆更糟。
 */
export const RULES = [
  {
    kind: 'promise',
    importance: 0.85,
    // 承诺：时间标记（明天/回头/等会…）或「我会/答应」+ 一个交付类动词。
    // 她自己的承诺最值得记（对方会等着），所以这条不排除 self。
    re: /(?:我(?:会|一定|保证|答应|尽量|争取)|明天|后天|大后天|下次|回头|等会|一会儿|晚点|马上|周末|月底)[^。！？!?；;\n]{0,14}(?:给你|帮你|陪你|带你|补(?:上)?|做|发|带|讲|说|找|查|试|安排|联系|过来|过去|回来)/,
  },
  {
    kind: 'event',
    importance: 0.6,
    selfOk: false, // 她自己的「明天少吃点」这类不是安排，记下来只会污染召回
    // 安排：时间/日期 + 事件动词。
    re: /(?:\d{1,2}月\d{1,2}[日号]|\d{1,2}[点:：]\d{0,2}|今天|明天|后天|大后天|下?周[一二三四五六日天]|周末|月底|月初)[^。！？!?；;\n]{0,18}(?:考|试|上班|上学|加班|回家|出门|去|来|吃|过生日|生日|约|见|面试|体检|出差|旅游|搬家|放假|上课)/,
  },
  {
    kind: 'event',
    importance: 0.7,
    selfOk: false,
    // 生日/纪念日这类就算没有时间词也值得记（一年才一次，漏了最亏）。
    re: /(?:生日|纪念日|结婚纪念|满月|周年)/,
  },
  {
    kind: 'preference',
    importance: 0.7,
    // 喜好：她自己的也算（「我最爱吃鱼」是人格的一部分）。
    re: /我(?:最|很|超|挺|好|特别)?(?:喜欢|爱|爱吃|讨厌|害怕|怕|受不了|习惯)/,
  },
  {
    kind: 'fact',
    importance: 0.65,
    selfOk: false, // 身份类事实只记别人说的 —— 她自己的台词（「我是鲸鱼」）不是长期记忆
    // 身份：必须不是「是不是/我在你眼里」这类反问或修辞。
    // `(?![不你我他])` 里那个「不」就是为「问我**是不是**你」加的：光靠前面的负向后顾挡不住。
    re: /(?<![不没就那这他你我])(?:我是(?![不你我他])|我在(?![你我他])|我住|我在学|我学的是|我做|我搞|我上班|我们家|我的(?:名字|生日|老家|工作|专业))/,
  },
];

/** 句子边界（用于只截取命中所在的那一句，别把整段话塞进记忆）。 */
const DELIM = '。！？!?；;\n';

const DEFAULT_MIN_CHARS = 4;
const DEFAULT_MAX_CHARS = 200;

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 取命中位置所在的那一句。 */
export function sentenceAround(text, index) {
  const raw = String(text ?? '');
  let start = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (DELIM.includes(raw[i])) { start = i + 1; break; }
  }
  let end = raw.length;
  for (let i = index; i < raw.length; i += 1) {
    if (DELIM.includes(raw[i])) { end = i + 1; break; }
  }
  return raw.slice(start, end).replace(/^[\s,，、]+/, '').trim();
}

/** 明显不值得记的内容（指令、链接、纯表情/数字）。 */
function isNoise(text) {
  const s = String(text ?? '').trim();
  if (!s) return true;
  if (s.length > 400) return true;
  if (/^[/!！.。]/.test(s)) return true;
  if (/https?:\/\//i.test(s)) return true;
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(s)) return true;
  return false;
}

/** 去掉引用前缀：`[引用 🍇：那我学会了什么]@🍇 爱我` → `@🍇 爱我`（引用里的话是别人说的，别记成当前说话人的）。 */
export function stripQuote(text) {
  return String(text ?? '').replace(/^\s*\[(?:引用|回复)[^\]]{0,200}\]\s*/, '');
}

/** 疑问句不是长期事实：「那我学会了什么」「你在吗」。 */
function isQuestionish(sentence) {
  const s = String(sentence ?? '').trim();
  if (!s) return true;
  if (/[?？]$/.test(s)) return true;
  return /(?:什么|吗|呢|咋|怎么|多少|哪个|几点)[。！!]?$/.test(s);
}

/** 说话人：私聊的历史里 `s` 是「私聊」两个字，没有名字，主体交给 scope 表达。 */
function speakerOf(rec) {
  // 她自己说过的话也算记忆（她答应过的事必须记得），但主体写成「小鲸鱼」而不是「我」：
  // 这条记忆日后被注入她的提示词里，写「我」会让她误以为那是对方说的。
  if (rec?.self) return '小鲸鱼';
  const s = String(rec?.s ?? '').trim();
  if (!s || s === '私聊' || s === '群聊') return null;
  return s.slice(0, 32);
}

/**
 * 从一批历史记录里抽候选记忆。
 * @param {Array<object>} records 形如 { t, id, s, u, self, x }（见 bridge.js 的 historyRecordOf）
 */
export function extractCandidates(records, { max = 12, minChars = DEFAULT_MIN_CHARS, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const out = [];
  const seen = new Set();
  for (const rec of Array.isArray(records) ? records : []) {
    const text = stripQuote(rec?.x);
    if (typeof text !== 'string' || isNoise(text)) continue;
    for (const rule of RULES) {
      if (rule.selfOk === false && rec?.self) continue;
      const m = rule.re.exec(text);
      if (!m) continue;
      const sentence = sentenceAround(text, m.index);
      if (sentence.length < minChars) continue;
      if (isQuestionish(sentence)) continue;
      const clipped = clip(sentence, maxChars);
      const key = `${rule.kind}|${normalize(clipped)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: rule.kind,
        rule: rule.kind,
        text: clipped,
        subject: speakerOf(rec),
        importance: rule.importance,
        t: Number(rec?.t) || 0,
        id: rec?.id ?? null,
        evidence: `history:${rec?.t ?? ''}${rec?.id ? `#${rec.id}` : ''}`,
      });
      break; // 一条消息只归一类，避免同一句话在多个类型里各存一份
    }
    if (out.length >= max) break;
  }
  return out;
}

/** `<root>/state/history` 下的文件名 → 会话 key。 */
export function keyFromHistoryFile(name) {
  const base = String(name ?? '').replace(/\.jsonl(?:\.\d+)?$/, '');
  const idx = base.indexOf('_');
  if (idx < 0) return '';
  const kind = base.slice(0, idx);
  const id = base.slice(idx + 1).replace(/_+$/, '');
  if (kind !== 'group' && kind !== 'private') return '';
  if (!/^\d+$/.test(id)) return '';
  return `${kind}:${id}`;
}

/** 列出有历史归档的会话 key（桥接没传 keys 时用）。 */
export function listHistoryKeys({ root } = {}) {
  const dir = path.join(path.resolve(String(root ?? '.')), 'state', 'history');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const keys = new Set();
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const key = keyFromHistoryFile(name);
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * 默认的历史读取器（给 CLI 与测试用）：认 `.1` 轮转，按时间升序返回，取最后 limit 条。
 * 桥接自己有 `readHistoryRecords`（支持关键词/前后时间），生产路径注入那个，不走这里。
 */
export function readHistorySince({ root, key, afterTs = 0, limit = 400 } = {}) {
  const safe = String(canonicalScope(key)).replace(':', '_');
  const file = path.join(path.resolve(String(root ?? '.')), 'state', 'history', `${safe}.jsonl`);
  const out = [];
  for (const f of [`${file}.1`, file]) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      if (Number(rec.t) <= afterTs) continue;
      out.push(rec);
    }
  }
  out.sort((a, b) => Number(a.t) - Number(b.t));
  return out.slice(-limit);
}

/**
 * 摄入器。水位存在一个独立的小 JSON 里（不是记在 memory.db）：
 * 记忆库是可以整个丢掉的派生物，水位丢了最多重扫一遍历史（写库靠 hash 去重，重复也是合并），
 * 反过来则不行 —— 水位写进库、库一坏就连「读到哪里」都不知道。
 */
export function createIntake({
  root,
  store,
  ownerQQOf,
  logger,
  readRecords,
  watermarkFile,
  maxPerRun = 12,
  scanLimit = 400,
} = {}) {
  const rootDir = path.resolve(String(root ?? '.'));
  const stateFile = path.resolve(String(watermarkFile ?? path.join(rootDir, 'state', 'memory-intake.json')));
  const reader = typeof readRecords === 'function' ? readRecords : (key, opts) => readHistorySince({ root: rootDir, key, ...opts });
  let marks = null;
  let dirty = false;

  function log(level, message, detail) {
    try { logger?.[level]?.(message, detail); } catch { /* 日志失败不影响摄入 */ }
  }

  function load() {
    if (marks) return marks;
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      marks = parsed && typeof parsed === 'object' && parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {};
    } catch {
      marks = {};
    }
    return marks;
  }

  function save() {
    if (!dirty) return false;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const payload = JSON.stringify({ version: VERSION, updatedAt: new Date().toISOString(), keys: load() }, null, 2);
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, `${payload}\n`);
      fs.renameSync(tmp, stateFile);
      dirty = false;
      return true;
    } catch (err) {
      log('warn', '摄入水位写不进去，下次会重扫同一段历史（不会丢记忆）', { error: String(err?.message ?? err) });
      return false;
    }
  }

  function watermarkOf(key) {
    const v = Number(load()[canonicalScope(key)]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  function advance(key, ts) {
    if (!Number.isFinite(ts) || ts <= 0) return;
    const scope = canonicalScope(key);
    if (ts <= watermarkOf(scope)) return;
    load()[scope] = ts;
    dirty = true;
  }

  function runSession({ key, records, layer } = {}) {
    const result = { key: canonicalScope(key), scanned: 0, inserted: 0, merged: 0, rejected: 0, candidates: [] };
    const list = Array.isArray(records) ? records : [];
    result.scanned = list.length;
    if (!list.length) return result;
    const owner = (() => { try { return ownerQQOf?.() ?? ''; } catch { return ''; } })();
    const effectiveLayer = layer || layerForKey(key, owner);
    const scope = canonicalScope(key);
    const candidates = extractCandidates(list, { max: maxPerRun });
    for (const c of candidates) {
      let res = null;
      try {
        res = store?.remember?.({
          layer: effectiveLayer,
          scope,
          kind: c.kind,
          subject: c.subject,
          text: c.text,
          importance: c.importance,
          confidence: 0.6,
          source: 'history-rule',
          evidence: c.evidence,
          meta: { rule: c.rule, ruleVersion: RULE_VERSION },
        }) ?? null;
      } catch (err) {
        log('warn', '历史记忆写入失败', { key: scope, error: String(err?.message ?? err) });
        res = null;
      }
      if (!res) { result.rejected += 1; continue; }
      if (res.action === 'merged') result.merged += 1;
      else if (res.action === 'rejected') result.rejected += 1;
      else result.inserted += 1;
      result.candidates.push({ key: scope, layer: effectiveLayer, kind: c.kind, text: c.text, action: res.action });
    }
    const lastTs = list.reduce((acc, rec) => Math.max(acc, Number(rec?.t) || 0), 0);
    advance(scope, lastTs);
    return result;
  }

  return {
    version: VERSION,
    watermarkPath: stateFile,

    watermarkOf(key) {
      return watermarkOf(key);
    },

    /** 跑一轮：没给 keys 就自己看 state/history 下有哪些会话。 */
    run({ keys, dryRun = false } = {}) {
      const list = (Array.isArray(keys) && keys.length ? keys : listHistoryKeys({ root: rootDir })).map((k) => canonicalScope(k));
      const out = { dryRun: Boolean(dryRun), keys: 0, scanned: 0, inserted: 0, merged: 0, rejected: 0, sessions: [], errors: [] };
      for (const key of list) {
        let after = watermarkOf(key);
        let first = true;
        // 分页读取：桥接的历史读取器是「按时间升序取最后 limit 条」，
        // 一次性读完 400 条、又把水位推到末尾的话，超出 400 条的历史会被水位直接跳过（静默丢记忆）。
        // 所以一页一页读，每页用上一页的末尾时间当下界，直到读不满一页为止。
        for (let page = 0; page < 5; page += 1) {
          let records = [];
          try {
            records = reader(key, { afterTs: after, limit: scanLimit }) || [];
          } catch (err) {
            out.errors.push({ key, error: String(err?.message ?? err) });
            break;
          }
          if (!records.length) break;
          if (dryRun) {
            const owner = (() => { try { return ownerQQOf?.() ?? ''; } catch { return ''; } })();
            const candidates = extractCandidates(records, { max: maxPerRun });
            out.keys += 1;
            out.scanned += records.length;
            out.sessions.push({
              key,
              layer: layerForKey(key, owner),
              scanned: records.length,
              watermark: after,
              candidates: candidates.map((c) => ({ kind: c.kind, text: c.text, subject: c.subject })),
            });
            break;
          }
          const res = runSession({ key, records });
          if (first) out.keys += 1;
          first = false;
          out.scanned += res.scanned;
          out.inserted += res.inserted;
          out.merged += res.merged;
          out.rejected += res.rejected;
          out.sessions.push(res);
          const next = watermarkOf(key);
          if (next <= after) break; // 水位没推进（同一毫秒的一批）：停手，靠 hash 去重兜底
          after = next;
          if (records.length < scanLimit) break;
        }
      }
      if (!dryRun) save();
      return out;
    },

    /** 测试与调试用：直接喂一个会话的记录。 */
    runSession,
    save,
  };
}