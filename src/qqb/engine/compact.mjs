// 上下文折叠（PANDORA_SPEC §7）：上下文用到 70% 时，把最老的一段压成「核心事件 + 情绪基调」
// 一句话插在上下文顶端，腾地方给新消息，但不让「更早发生了什么」凭空消失。
//
// 为什么不用模型来压：折叠必须是同步、便宜、可测的（一轮对话里要做决定，不能等一次额外调用），
// 而且这里要的是「她还记得那个感觉」，不是精确复述。规则式摘出来的东西更不容易编。
//
// 三条边界：
//  1) 永不折叠最近 keepRecent 条（今天的对话必须原样在）。
//  2) 折叠只减少条目、不删原文：L2 原文底账在记忆库里（live.recordOriginal），
//     想翻原话去库里面翻，提示词里只留一句索引。
//  3) 任何异常都返回原样，绝不因为折叠把这一轮搞挂。

/** 中文字大约 1 字 1 token，英文/数字约 4 字符 1 token —— 粗估够用，宁多勿少。 */
export const VERSION = '0.1.0';

export function estimateTokens(text = '') {
  const str = String(text ?? '');
  let cjk = 0;
  let other = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80 && code <= 0x9fff) cjk += 1;
    else if (code >= 0xf900 && code <= 0xfaff) cjk += 1;
    else if (code >= 0xff00 && code <= 0xff60) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

const EMOTION_WORDS = [
  [/开心|高兴|笑|好玩|喜欢|喜欢上|甜|可爱|舒服|踏实|放松|得意/, '开心'],
  [/难受|委屈|想哭|哭|伤心|失落|低落|孤独|闷|心疼|舍不得/, '难受'],
  [/生气|烦|讨厌|气死|火大|不高兴|炸毛|凶|吼|哼/, '有点生气'],
  [/紧张|怕|担心|慌|不安|焦虑|害怕/, '紧张'],
  [/累|困|疲惫|没力气|睡|躺|懒/, '累了'],
  [/饿|想吃|好吃|馋|甜食|奶茶|蛋糕/, '想吃东西'],
];

/** 给一段文字估个情绪基调（只用于摘要那一句，不参与打分）。 */
export function emotionTone(text = '') {
  const str = String(text ?? '');
  let best = '';
  let bestHits = 0;
  for (const [re, label] of EMOTION_WORDS) {
    const hits = (str.match(new RegExp(re.source, 'g')) ?? []).length;
    if (hits > bestHits) { bestHits = hits; best = label; }
  }
  return best || '平常';
}

function cleanLine(text, max = 48) {
  const one = String(text ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max)}…`;
}

/**
 * 把被丢掉的那一段压成一句话：挑最后一条有实际内容的话当「核心事件」，情绪取整段的基调。
 * 「最后一条」而不是「第一条」：折叠的窗口是「最近之前那一段」，越靠后越接近现在的语境。
 */
export function summarizeDropped(items = []) {
  const lines = items
    .map((item) => ({ role: String(item?.role ?? 'user'), content: String(item?.content ?? '').trim() }))
    .filter((item) => item.content);
  if (!lines.length) return '';
  const spoken = lines.filter((item) => item.role !== 'system');
  const pool = spoken.length ? spoken : lines;
  const core = pool[pool.length - 1];
  const tone = emotionTone(pool.map((item) => item.content).join(' '));
  const who = core.role === 'assistant' ? '她' : '对方';
  return `【更早的事】${who}说到「${cleanLine(core.content, 40)}」（当时的情绪：${tone}；另有 ${Math.max(0, pool.length - 1)} 条更早的对话已折叠）`;
}

/**
 * 折叠历史。返回的 `messages` 已经可以直接塞给 composeMessages。
 *
 * @param {object[]} history  [{ role, content }]
 * @param {{budgetTokens?: number, triggerRatio?: number, keepRecent?: number, maxSummaryChars?: number}} [options]
 * @returns {{messages: object[], folded: boolean, summary: string, dropped: number, tokensBefore: number, tokensAfter: number}}
 */
export function foldHistory(history = [], options = {}) {
  const items = (Array.isArray(history) ? history : [])
    .filter((item) => item && typeof item === 'object' && String(item.content ?? '').trim())
    .map((item) => ({
      role: item.role === 'assistant' || item.role === 'system' ? item.role : 'user',
      content: String(item.content),
    }));
  const budgetTokens = Math.max(400, Number(options.budgetTokens) || 6000);
  const triggerRatio = Math.min(0.95, Math.max(0.3, Number(options.triggerRatio) || 0.7));
  const keepRecent = Math.max(2, Math.min(items.length, Number(options.keepRecent) || 12));
  const maxSummaryChars = Math.max(60, Number(options.maxSummaryChars) || 160);

  const tokensBefore = items.reduce((sum, item) => sum + estimateTokens(item.content), 0);
  const unchanged = { messages: items, folded: false, summary: '', dropped: 0, tokensBefore, tokensAfter: tokensBefore };
  if (tokensBefore < budgetTokens * triggerRatio) return unchanged;

  // 往回收：每次多折一条，直到降到预算的 55% 以下（留出这一轮工具结果/回复的空间）。
  let cut = 0;
  let tokens = tokensBefore;
  const target = budgetTokens * 0.55;
  while (cut < items.length - keepRecent && tokens > target) {
    tokens -= estimateTokens(items[cut].content);
    cut += 1;
  }
  if (cut <= 0) return unchanged;

  const droppedItems = items.slice(0, cut);
  const summary = summarizeDropped(droppedItems).slice(0, maxSummaryChars);
  const kept = items.slice(cut);
  const messages = summary
    ? [{ role: 'system', content: `${summary}（只是背景，不要当成对方刚说的话）` }, ...kept]
    : kept;
  const tokensAfter = messages.reduce((sum, item) => sum + estimateTokens(item.content), 0);
  return { messages, folded: true, summary, dropped: cut, tokensBefore, tokensAfter };
}