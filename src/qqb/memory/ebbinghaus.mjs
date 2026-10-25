// qqb/memory/ebbinghaus.mjs —— 艾宾浩斯遗忘曲线 + 情绪加权（主人 2026-10-25 的要求）
//
// 记忆不是「存进去就一样清楚」：放得越久越淡，被反复想起就越牢，当时情绪越猛留得越久。
// 这里全是纯函数（不碰库、不碰时间），方便单测；store.mjs 只在召回时调它们算权重。
//
// 模型（简化版艾宾浩斯）：
//   R(t) = exp(-t / S)        t = 距上次「写过/想过」多久（天），S = 当前记忆强度（天）
//   S    = base(kind) × (1 + 3·importance) × (1 + 4·emotion) × (1 + 0.6·ln(1+useCount))
//   weight = effectiveImportance × R(t)
//   effectiveImportance = importance + (1 - importance) × 0.35 × emotion
//
// 语义：encoding 时情绪高 → importance 抬一截、S 也翻几倍（闪光灯记忆）；
// 之后每被想起一次（use_count+1，且 updated_at/last_used_at 被刷新=复习）曲线从头再来，
// 且 S 随练习次数增长（间隔效应）。appraisal 上「越重要的事淡得越慢」。

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 一次都没复习过、importance=0.5、emotion=0 的中性记忆，差不多几天就淡成背景。 */
export const BASE_STABILITY_DAYS = 1.5;

/** 上限：再重要的事也不该「永远不忘」，否则库里全是僵尸常青树。 */
export const MAX_STABILITY_DAYS = 240;

/** 不同类别的基础强度（天）：约定/事实比一时动态耐放。 */
export const KIND_STABILITY_DAYS = Object.freeze({
  promise: 4,
  fact: 2.2,
  impression: 2,
  preference: 1.8,
  diary: 1.4,
  topic: 1.5,
  event: 1.2,
});

/** 权重分档：越靠前越「醒目」，提示词里排得越前；deep 的不再自动进提示词。 */
export const DEPTH_LABELS = Object.freeze({
  vivid: '记得很清楚',
  clear: '记得',
  faint: '有点模糊',
  deep: '快忘了',
});

/** 低于这个权重就沉到库底：还可以搜到，但不会自己冒进提示词。 */
export const PROMPT_WEIGHT_FLOOR = 0.15;

function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 情绪强度：0 = 平静，1 = 心里翻江倒海。 */
export function clampEmotion(value, fallback = 0) {
  return clamp01(value, fallback);
}

/**
 * 从一句话里估情绪强度（给没有情绪信号可用的写入路径兜底）。
 * 只认「有情绪的词 + 感叹/重复」这类廉价信号，不追求准，只要别把中性句当大事。
 */
const STRONG_WORDS = [
  '哭', '疼', '怕', '崩溃', '委屈', '难过', '伤心', '生气', '愤怒', '后悔', '孤独',
  '想你', '舍不得', '分手', '对不起', '救命', '焦虑', '害怕', '紧张', '激动', '惊讶',
  '感动', '开心', '高兴', '快乐', '幸福', '喜欢', '爱你', '谢谢', '再见', '答应', '发誓',
  '约定', '保证', '永远', '第一次',
];
const MILD_WORDS = ['累', '困', '饿', '烦', '讨厌', '哈哈', '笑', '呜', '唉', '哎'];

const STRONG_RE = new RegExp(STRONG_WORDS.join('|'), 'g');
const MILD_RE = new RegExp(MILD_WORDS.join('|'), 'g');

export function emotionFromText(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  const strong = (s.match(STRONG_RE) ?? []).length;
  const mild = (s.match(MILD_RE) ?? []).length;
  const exclaim = (s.match(/[!！]/g) ?? []).length;
  const repeat = /(.)\1{2,}/.test(s) ? 1 : 0; // 「啊啊啊」「呜呜」
  const score = 0.25 * strong + 0.12 * mild + 0.08 * Math.min(3, exclaim) + 0.1 * repeat;
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

/** 编码时的有效重要度：情绪高会把它抬起来（但不会把 1.0 抬过 1.0）。 */
export function effectiveImportance({ importance = 0.5, emotion = 0 } = {}) {
  const imp = clamp01(importance, 0.5);
  const emo = clamp01(emotion, 0);
  return Math.round((imp + (1 - imp) * 0.35 * emo) * 10000) / 10000;
}

/** 记忆强度 S（天）：类别 × 重要度 × 情绪 × 复习次数。 */
export function stabilityDays({ importance = 0.5, emotion = 0, useCount = 0, kind = null } = {}) {
  const base = (kind && KIND_STABILITY_DAYS[kind]) || BASE_STABILITY_DAYS;
  const imp = clamp01(importance, 0.5);
  const emo = clamp01(emotion, 0);
  const uses = Math.max(0, Number(useCount) || 0);
  const s = base * (1 + 3 * imp) * (1 + 4 * emo) * (1 + 0.6 * Math.log1p(uses));
  return Math.min(MAX_STABILITY_DAYS, Math.round(s * 100) / 100);
}

/** 保留率 R(t)：0~1，1 = 刚想起来的程度。 */
export function retentionFor({ elapsedMs = 0, stability = BASE_STABILITY_DAYS } = {}) {
  const days = Math.max(0, Number(elapsedMs) || 0) / DAY_MS;
  const s = Math.max(0.01, Number(stability) || BASE_STABILITY_DAYS);
  const r = Math.exp(-days / s);
  return Math.round(Math.min(1, Math.max(0, r)) * 10000) / 10000;
}

/** 权重落在哪一档（决定提示词里的位置：vivid 最醒目 → deep 沉底）。 */
export function depthOf(weight) {
  const w = clamp01(weight, 0);
  if (w >= 0.55) return 'vivid';
  if (w >= 0.32) return 'clear';
  if (w >= PROMPT_WEIGHT_FLOOR) return 'faint';
  return 'deep';
}

/**
 * 一条记忆此刻的「分量」。
 * @param {{importance?: number, emotion?: number, useCount?: number, kind?: string,
 *   ageMs?: number}} [input] ageMs = 距上次复习（updated_at / last_used_at）多久
 * @returns {{weight: number, retention: number, stability: number, effectiveImportance: number, depth: string}}
 */
export function memoryWeight({ importance = 0.5, emotion = 0, useCount = 0, kind = null, ageMs = 0 } = {}) {
  const eff = effectiveImportance({ importance, emotion });
  const stability = stabilityDays({ importance, emotion, useCount, kind });
  const retention = retentionFor({ elapsedMs: ageMs, stability });
  const weight = Math.round(eff * retention * 10000) / 10000;
  return { weight, retention, stability, effectiveImportance: eff, depth: depthOf(weight) };
}

/** 权重够不够「自己冒出来」：够才进提示词，不够就只在主动检索里找得到。 */
export function promptWorthy(weight) {
  return Number(weight) >= PROMPT_WEIGHT_FLOOR;
}