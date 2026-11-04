// 说话节奏的三道闸（2026-11-04）：一次只说一句、说完停一秒、累了说得更短。
//
// 为什么放在代码层而不是只写进提示词：主人这些要求都是「不能被模型商量掉」的硬约束。
// 提示词只能影响它的倾向，真正兜底的是这里 —— 生成之后先截成一句，再按精神值卡字数/停顿时长。
//
//   enforceSingleSentence(texts)  一段话 → 只留第一句（多出来的丢掉并计数，调用方负责记日志）
//   replyLimits(spirit, style)    精神值 → 这一轮的 maxTokens 与说完之后要停多久
import { replyBudget } from './spirit.mjs';

export const VERSION = '0.1.0';

export const DEFAULT_STYLE = {
  singleSentence: true,
  // 说完一句之后停多久再听下一句（毫秒）：0 关掉。这是「强制思考一秒」的底座。
  thinkMs: 1000,
  // 精神值低于这个数时，除了基础停顿再随机多停一会儿（人困了就反应慢）。
  tiredBelow: 0.3,
  tiredExtraMsMax: 1500,
};

/** 断句点：句末标点 + 换行（省略号/波浪号不算断句，她常拿它们拖长音）。 */
const SENTENCE_END = /[。！？!?]/;

const clamp01 = (n) => {
  const v = Number(n);
  return Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));
};

/**
 * 把一段话切成句子。保留句末标点，换行也算断句。
 * @returns {string[]} 至少 0 条；空段被丢掉
 */
export function splitSentences(text) {
  const src = String(text ?? '');
  if (!src.trim()) return [];
  const out = [];
  let buf = '';
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '\n' || ch === '\r') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
    if (!SENTENCE_END.test(ch)) continue;
    // 连着的句末标点（「真的吗？！」「嗯……」）算同一句的结尾，一起收进来
    while (i + 1 < src.length && SENTENCE_END.test(src[i + 1])) {
      i += 1;
      buf += src[i];
    }
    if (buf.trim()) out.push(buf.trim());
    buf = '';
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/** 只留第一句（可选再按字数截断），用作「一次只说一句」的落点。 */
export function firstSentence(text, { maxChars = 0 } = {}) {
  const one = splitSentences(text)[0] ?? '';
  const tidy = one.replace(/([。！？!?])\1+$/g, '$1');
  if (maxChars > 0 && tidy.length > maxChars) {
    return `${tidy.slice(0, maxChars).replace(/[，、,；;：:\s]+$/, '')}…`;
  }
  return tidy;
}

/**
 * 一段（可能被拆成多条气泡的）回复 → 只留第一句。
 * 返回丢掉了几句，方便调用方记日志（「一次只说一句：砍掉 3 句」）。
 */
export function enforceSingleSentence(texts) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '').trim()).filter(Boolean);
  const sentences = list.flatMap((t) => splitSentences(t));
  if (!sentences.length) return { texts: [], dropped: 0 };
  return { texts: [sentences[0]], dropped: Math.max(0, sentences.length - 1) };
}

/**
 * 精神值 → 这一轮的两把尺子。
 *
 * - `maxTokens`：模型这一轮最多能写多少（累了就别让它酝酿小作文）
 * - `thinkMs`：这一句说完到能听下一句之间要停多久（基础停顿 + 困的时候随机多停）
 * - `maxChars`：直接借用 spirit 模块的口径，两处不会打架
 *
 * @param {number} spirit 0~1
 * @param {object} style 覆盖 DEFAULT_STYLE 的部分字段；测试里传 rand: () => 0 可固定随机
 */
export function replyLimits(spirit, style = {}) {
  const c = { ...DEFAULT_STYLE, ...(style || {}) };
  const s = clamp01(spirit);
  const rand = typeof c.rand === 'function' ? c.rand : Math.random;
  const base = Math.max(0, Number(c.thinkMs) || 0);
  const extraMax = Math.max(0, Number(c.tiredExtraMsMax) || 0);
  const tiredBelow = Number.isFinite(Number(c.tiredBelow)) ? Number(c.tiredBelow) : DEFAULT_STYLE.tiredBelow;

  let maxTokens = 512;
  let extra = 0;
  if (s < 0.2) { maxTokens = 128; extra = extraMax * 1.0; }
  else if (s < 0.35) { maxTokens = 192; extra = extraMax * 0.6; }
  else if (s < 0.55) { maxTokens = 320; }
  else if (s < 0.75) { maxTokens = 448; }
  else { maxTokens = 512; }
  if (s >= tiredBelow) extra = Math.min(extra, 0);

  const thinkMs = base === 0 && Number(c.thinkMs) === 0
    ? 0 // thinkMs: 0 = 整条停顿关掉（连累了要多停的那段也不加）
    : Math.round(base + extra * clamp01(rand()));
  const budget = replyBudget(s);
  return {
    spirit: s,
    maxTokens,
    maxChars: budget.maxChars,
    thinkMs,
    tired: s < tiredBelow,
  };
}