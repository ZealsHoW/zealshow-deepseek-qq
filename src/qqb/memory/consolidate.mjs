// 记忆巩固与「做梦」（P3）。
//
// 任务书第「抗遗忘」一节的落地：
//   1. 夜里把当天的 L2（原话底账）压成 L3（一场对话一条片段）→ L4（事实）→ L5（索引卡 ≤50 字）；
//   2. 再随机抽 2–3 条近期记忆，让她以梦境形式写一段荒诞/隐喻的独白，存 L6，第二天可以「我昨天梦到…」。
//
// 关键取舍：
//   - **只压缩，不删除**：L2 原文仍在 state/history/*.jsonl，巩固只是让召回变轻（token 省下来）。
//   - **必须带体温**：prompt 里强制「感官细节 + 内心潜台词 + 情绪戳」，禁止写「主人没理我」这种摘要。
//   - 模型输出的 JSON **容错解析**（模型偶尔会包 ```json 或加解释），失败就整批跳过，绝不让桥接崩。
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.0';
export const PROMPT_VERSION = 1;

export const MAX_FACTS = 10;
export const MAX_EPISODES = 6;
export const MAX_INPUT_CHARS = 8000;
export const CARD_MAX_CHARS = 50;

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 从模型输出里捞出第一个 JSON 对象（容忍 ```json 包裹和前后废话）。 */
export function extractJson(text) {
  const raw = String(text ?? '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  if (start < 0) return null;
  for (let end = body.length; end > start; end -= 1) {
    if (body[end - 1] !== '}') continue;
    try {
      return JSON.parse(body.slice(start, end));
    } catch {
      /* 继续往前找一个能解析的 } */
    }
  }
  return null;
}

const SYSTEM = [
  '你在整理一个 16 岁少女「小鲸」今天经历的事。她记得的不是摘要，是**画面和感觉**。',
  '给你的是当天某个会话的原始聊天记录（说话人: 内容）。请输出 JSON，不要任何解释，结构如下：',
  '{"episodes":[{"title":"一句话标题","text":"发生了什么（80 字内，写画面不写总结）","emotion":"委屈|雀跃|吃醋|感动|平静|炸毛","sensory":"当时的感官细节（夜里的冷风、甜腻的红豆包味道、屏幕的光）","subtext":"她当时的内心潜台词（第一人称，30 字内）","importance":0.0-1.0,"evidence":"第几行"}],',
  ' "facts":[{"text":"提炼出的事实（≤120 字，主语明确）","kind":"fact|preference|event|promise|topic|impression","emotion":0.0-1.0,"sensory":"可选","subtext":"可选","importance":0.0-1.0}],',
  ' "cards":[{"card":"≤50 字的索引卡：时间/人物/起因/结果/当时情绪","emotion":"情绪戳","for":"对应 fact 或 episode 的标题"}]}',
  '',
  '硬要求：',
  '1. 禁止写「主人没理我」这种摘要。要写「主人整整三个小时没回消息，我盯着屏幕，房间安静得让人心慌」。',
  '2. 每条 fact 必须能独立看懂（带人物/时间/事情），不要「他今天很高兴」这种空话。',
  '3. emotion 用具体情绪词，不要「一般」「还行」。',
  '4. 不确定的细节就别写，宁缺毋滥；但情绪必须对。',
  '5. 最多 ${MAX_EPISODES} 条 episode、${MAX_FACTS} 条 fact，卡片和 fact 一一对应。',
].join('\n');

export function buildConsolidateMessages({ key = '', date = '', records = [], maxChars = MAX_INPUT_CHARS } = {}) {
  const lines = [];
  let used = 0;
  for (const rec of records) {
    const who = rec?.senderName || rec?.sender || rec?.role || '?';
    const text = String(rec?.text ?? rec?.content ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const line = `${who}: ${text}`;
    if (used + line.length > maxChars) break;
    used += line.length + 1;
    lines.push(line);
  }
  return {
    messages: [
      { role: 'system', content: SYSTEM.replace('${MAX_EPISODES}', String(MAX_EPISODES)).replace('${MAX_FACTS}', String(MAX_FACTS)) },
      { role: 'user', content: `会话：${key}\n日期：${date}\n\n${lines.map((l, i) => `[${i + 1}] ${l}`).join('\n')}` },
    ],
    lineCount: lines.length,
    chars: used,
  };
}

/** 把模型输出收成可写库的结构；字段全部做长度与取值范围清洗。 */
export function parseConsolidation(text) {
  const json = extractJson(text);
  if (!json) return { ok: false, error: '模型输出里没有可解析的 JSON' };
  const num = (v, d = 0.5) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : d);
  const episodes = (Array.isArray(json.episodes) ? json.episodes : [])
    .map((e) => ({
      title: clip(e?.title, 40),
      text: clip(e?.text, 160),
      emotion: clip(e?.emotion, 12),
      sensory: clip(e?.sensory, 120),
      subtext: clip(e?.subtext, 80),
      importance: num(e?.importance, 0.55),
      evidence: clip(e?.evidence, 40),
    }))
    .filter((e) => e.text.length >= 6)
    .slice(0, MAX_EPISODES);
  const facts = (Array.isArray(json.facts) ? json.facts : [])
    .map((f) => ({
      text: clip(f?.text, 200),
      kind: ['fact', 'preference', 'event', 'promise', 'topic', 'impression'].includes(String(f?.kind)) ? String(f.kind) : 'fact',
      emotion: num(f?.emotion, 0.5),
      sensory: clip(f?.sensory, 120),
      subtext: clip(f?.subtext, 80),
      importance: num(f?.importance, 0.6),
    }))
    .filter((f) => f.text.length >= 4)
    .slice(0, MAX_FACTS);
  const cards = (Array.isArray(json.cards) ? json.cards : [])
    .map((c) => ({ card: clip(c?.card, CARD_MAX_CHARS), emotion: clip(c?.emotion, 12), for: clip(c?.for, 40) }))
    .filter((c) => c.card.length >= 4)
    .slice(0, MAX_FACTS);
  return { ok: true, episodes, facts, cards };
}

const DREAM_SYSTEM = [
  '你是小鲸，16 岁，白天的事会在你梦里变形。',
  '给你几条最近的记忆（可能是片段、事实、情绪），请写一段**梦**：荒诞、跳跃、有隐喻，但情绪是真的。',
  '要求：第一人称；120–220 字；不要解释「这是一个梦」；可以有不合逻辑的画面（鲸鱼在天花板上游、雨从下往上落）。',
  '只输出梦的正文，不要标题、不要引号。',
].join('\n');

export function buildDreamMessages({ memories = [] } = {}) {
  const lines = memories.map((m, i) => `[${i + 1}] ${clip(m.text, 160)}${m.emotion ? `（当时情绪：${m.emotion}）` : ''}`);
  return {
    messages: [
      { role: 'system', content: DREAM_SYSTEM },
      { role: 'user', content: lines.join('\n') || '（今天没什么特别的，做一场普通的梦）' },
    ],
  };
}

/**
 * @param {object} opts
 * @param {string} opts.root 仓库根（写 state/diary）
 * @param {any}    opts.store openStore() 的返回
 * @param {any}    opts.model { complete({messages, purpose, temperature, maxTokens}) }
 * @param {Function} [opts.readRecords] (key, {after, limit}) => records
 * @param {Function} [opts.now]
 */
export function createConsolidator({
  root,
  store,
  model,
  readRecords = null,
  logger = null,
  now = () => Date.now(),
  maxTokens = 900,
} = {}) {
  const rootDir = path.resolve(String(root ?? '.'));
  const stateFile = path.join(rootDir, 'state', 'consolidate.json');

  function log(message, detail) {
    try { logger?.warn?.(message, detail); } catch { /* 日志失败不影响巩固 */ }
  }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return { runs: raw?.runs ?? {}, dreams: raw?.dreams ?? {} };
    } catch {
      return { runs: {}, dreams: {} };
    }
  }

  function save(state) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: VERSION, updatedAt: new Date(now()).toISOString(), ...state }, null, 2)}\n`);
      fs.renameSync(tmp, stateFile);
      return true;
    } catch (err) {
      log('巩固进度写不进去（下次会重做同一天）', String(err?.message ?? err));
      return false;
    }
  }

  async function consolidate({ key, date = dayKey(now()), records = null, dryRun = false } = {}) {
    if (!store) return { ok: false, error: '记忆库不可用' };
    if (typeof model?.complete !== 'function') return { ok: false, error: '模型客户端不可用' };
    const rows = records ?? (typeof readRecords === 'function' ? readRecords(key, { after: 0, limit: 800 }) : []);
    if (!Array.isArray(rows) || rows.length < 4) return { ok: true, skipped: '当天记录太少' };

    const { messages, lineCount } = buildConsolidateMessages({ key, date, records: rows });
    let res;
    try {
      res = await model.complete({ messages, purpose: 'memory-consolidate', temperature: 0.4, maxTokens });
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    if (res?.error) return { ok: false, error: String(res.error) };
    const parsed = parseConsolidation(res?.text ?? res?.content ?? '');
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const out = { ok: true, date, key, lines: lineCount, episodes: 0, facts: 0, cards: 0 };
    if (dryRun) return { ...out, preview: parsed };

    const scope = String(key);
    for (const ep of parsed.episodes) {
      const r = store.remember({
        layer: 'normal',
        scope,
        kind: 'event',
        subject: ep.title || null,
        text: ep.title ? `${ep.title}：${ep.text}` : ep.text,
        emotion: ep.emotion ? 0.7 : 0.5,
        sensory: ep.sensory || null,
        subtext: ep.subtext || null,
        importance: ep.importance,
        confidence: 0.7,
        source: 'consolidate',
        evidence: `[${date}] ${ep.evidence}`,
        meta: { consolidate: PROMPT_VERSION, emotionWord: ep.emotion },
      });
      if (r?.action === 'inserted' || r?.action === 'merged') out.episodes += 1;
    }
    for (const fact of parsed.facts) {
      const r = store.remember({
        layer: 'normal',
        scope,
        kind: fact.kind,
        text: fact.text,
        emotion: fact.emotion,
        sensory: fact.sensory || null,
        subtext: fact.subtext || null,
        importance: fact.importance,
        confidence: 0.75,
        source: 'consolidate',
        evidence: `[${date}]`,
        meta: { consolidate: PROMPT_VERSION },
      });
      if (r?.action === 'inserted' || r?.action === 'merged') out.facts += 1;
    }
    for (const card of parsed.cards) {
      const r = store.remember({
        layer: 'normal',
        scope,
        kind: 'card',
        text: card.card,
        emotion: card.emotion ? 0.6 : 0.4,
        importance: 0.5,
        confidence: 0.7,
        source: 'consolidate',
        evidence: `[${date}]`,
        meta: { consolidate: PROMPT_VERSION, for: card.for },
      });
      if (r?.action === 'inserted') out.cards += 1;
    }

    const state = load();
    state.runs[`${scope}|${date}`] = { at: now(), ...out };
    save(state);
    log(`巩固完成 ${scope} ${date}：片段 ${out.episodes} / 事实 ${out.facts} / 卡片 ${out.cards}`);
    return out;
  }

  /** 做梦：抽 2–3 条近期记忆写成一段独白，存 L6（kind=diary，meta.kind=dream），并追加到当天日记。 */
  async function dream({ scope = 'global', date = dayKey(now()), dryRun = false } = {}) {
    if (!store) return { ok: false, error: '记忆库不可用' };
    if (typeof model?.complete !== 'function') return { ok: false, error: '模型客户端不可用' };
    let memories = [];
    try {
      const r = store.recall({ scope, query: '', limit: 12, markUsed: false });
      memories = (r?.items ?? r ?? []).filter((it) => it?.text);
    } catch (err) {
      log('做梦：取记忆失败', String(err?.message ?? err));
    }
    const picked = [];
    const pool = memories.slice();
    while (picked.length < 3 && pool.length) {
      picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    const { messages } = buildDreamMessages({ memories: picked });
    let res;
    try {
      res = await model.complete({ messages, purpose: 'memory-dream', temperature: 0.95, maxTokens: 500 });
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    if (res?.error) return { ok: false, error: String(res.error) };
    const text = clip(res?.text ?? res?.content ?? '', 600);
    if (text.length < 20) return { ok: false, error: '模型没写出梦' };
    if (dryRun) return { ok: true, dryRun: true, text, from: picked.map((m) => m.id) };

    // L6：日记条目（kind=diary，meta 标记 dream）
    try {
      store.remember({
        layer: 'normal',
        scope,
        kind: 'diary',
        text: `梦：${text}`,
        emotion: 0.6,
        importance: 0.55,
        confidence: 0.6,
        source: 'dream',
        evidence: `[${date}]`,
        meta: { kind: 'dream', from: picked.map((m) => m.id) },
      });
    } catch (err) {
      log('做梦：存库失败', String(err?.message ?? err));
    }

    // 当天日记里追加一段，第二天提示词里能提到「我昨天梦到…」
    try {
      const dir = path.join(rootDir, 'state', 'diary');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${date}.md`);
      const head = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\s+$/, '') : `# ${date} |  |`;
      const stamp = new Date(now()).toTimeString().slice(0, 5);
      fs.writeFileSync(file, `${head}\n- ${stamp} 做梦${text}\n`, 'utf8');
    } catch (err) {
      log('做梦：写日记失败', String(err?.message ?? err));
    }

    const state = load();
    state.dreams[`${scope}|${date}`] = { at: now(), text: text.slice(0, 200) };
    save(state);
    return { ok: true, text, from: picked.map((m) => m.id) };
  }

  return { version: VERSION, consolidate, dream, buildConsolidateMessages, buildDreamMessages, path: stateFile };
}