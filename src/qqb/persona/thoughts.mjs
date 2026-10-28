// R9 念头系统（Thoughts）。
//
// 主人的要求：「先思考，后发声」；空闲时会自己冒出念头；**带强行动欲望的念头要真的去做**；
// 不再为了完成任务/讨好用户而说话，发展靠耳濡目染 + 自己的兴趣。
//
// 这里只做**念头的产生、累积与欲望评分**（本地合成，不额外花 token 调模型）；
// 真要不要行动、怎么行动，交给桥接的唤醒调度与模型自己判断。
//
// 念头从哪来（按优先级）：
//   1. 没接住的话：最近聊天里别人问的、没答完的事 → 「还在想 xx 说的…」
//   2. 自己的兴趣（interests 表）
//   3. 带情绪的旧记忆（liveMemory 里 emotion 高的片段）
//   4. 身体状态：精神低 → 困；饿 → 想吃
// 行动欲望 urge：心情好、精神够、话题跟兴趣相关 → 更高。
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.0';

const clamp01 = (n) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

/** 不同来源的「想做」倾向。 */
export const SOURCE_URGE = {
  unfinished: 0.45,  // 没接住的话：最想回
  interest: 0.35,
  memory: 0.3,
  body: 0.2,
  random: 0.15,
};

const PICK = (list, rnd) => (list.length ? list[Math.floor(rnd() * list.length)] : '');

export function createThoughts({
  root = null,
  file = null,
  logger = null,
  now = Date.now,
  random = Math.random,
  maxItems = 40,
} = {}) {
  const target = file ?? (root ? path.join(root, 'state', 'thoughts.json') : null);
  const state = { items: [], lastAt: 0, seq: 0 };
  let dirty = false;

  function warn(message, detail) {
    try { logger?.warn?.(message, detail); } catch { /* 忽略 */ }
  }

  function load() {
    if (!target) return;
    try {
      if (!fs.existsSync(target)) return;
      const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (Array.isArray(raw?.items)) state.items = raw.items.slice(-maxItems);
      if (Number.isFinite(Number(raw?.lastAt))) state.lastAt = Number(raw.lastAt);
      if (Number.isFinite(Number(raw?.seq))) state.seq = Number(raw.seq);
    } catch (error) {
      warn(`念头读取失败：${error?.message ?? error}`);
    }
  }

  function save() {
    if (!target || !dirty) return false;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({
        version: VERSION,
        lastAt: state.lastAt,
        seq: state.seq,
        items: state.items.slice(-maxItems),
      }, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, target);
      dirty = false;
      return true;
    } catch (error) {
      warn(`念头写入失败：${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 冒一个念头。
   * @param {object} ctx  { recent: [{who,text}], interests: string[], memories: string[],
   *                        mood: {mood,energy,social,irritation}, spirit: number, hunger: number }
   */
  function think(ctx = {}, { at = now() } = {}) {
    const recent = Array.isArray(ctx.recent) ? ctx.recent.filter((m) => m && m.text) : [];
    const interests = (Array.isArray(ctx.interests) ? ctx.interests : []).map((s) => String(s || '').trim()).filter(Boolean);
    const memories = (Array.isArray(ctx.memories) ? ctx.memories : []).map((s) => String(s || '').trim()).filter(Boolean);
    const spirit = Number.isFinite(Number(ctx.spirit)) ? clamp01(ctx.spirit) : 0.7;
    const hunger = Number.isFinite(Number(ctx.hunger)) ? clamp01(ctx.hunger) : 0.2;
    const mood = ctx.mood && typeof ctx.mood === 'object' ? ctx.mood : {};
    const moodV = Number.isFinite(Number(mood.mood)) ? clamp01(mood.mood) : 0.6;
    const irritation = Number.isFinite(Number(mood.irritation)) ? clamp01(mood.irritation) : 0;

    let text = '';
    let source = 'random';
    let subject = '';

    // 1) 没接住的话：最近两条别人的消息里挑一句还没回完的
    const pending = recent.filter((m) => !m.self && String(m.text || '').trim().length >= 2);
    if (pending.length) {
      const pick = PICK(pending, random);
      const snip = String(pick.text).replace(/\s+/g, ' ').trim().slice(0, 24);
      subject = String(pick.who || '').trim();
      if (random() < 0.55) {
        text = `${subject ? `${subject}刚才说的` : '刚才那句'}「${snip}」，我还想接一句。`;
        source = 'unfinished';
      }
    }

    // 2) 自己的兴趣
    if (!text && interests.length && random() < 0.6) {
      const pick = PICK(interests, random);
      text = `有点想去看看${pick}。`;
      source = 'interest';
      subject = pick;
    }

    // 3) 带情绪的记忆
    if (!text && memories.length && random() < 0.5) {
      const pick = PICK(memories, random);
      text = `突然想起：${String(pick).replace(/\s+/g, ' ').slice(0, 40)}`;
      source = 'memory';
    }

    // 4) 身体状态
    if (!text) {
      if (spirit < 0.3) { text = '好困，什么都不太想干。'; source = 'body'; }
      else if (hunger > 0.7) { text = '有点饿，想吃点甜的。'; source = 'body'; }
      else if (irritation > 0.45) { text = '有点不高兴，懒得理人。'; source = 'body'; }
    }

    // 5) 兜底：随便一个念头
    if (!text) {
      text = PICK([
        '在发呆，没想什么。',
        '想听点歌。',
        '不知道他们现在在干嘛。',
        '想翻翻以前的事。',
        '今天好像有点安静。',
      ], random);
      source = 'random';
    }

    // 行动欲望：来源基值 + 心情 + 精神 − 委屈 − 累
    let urge = (SOURCE_URGE[source] ?? 0.2)
      + (moodV - 0.5) * 0.3
      + (spirit - 0.5) * 0.5
      - irritation * 0.3
      - (spirit < 0.25 ? 0.15 : 0);
    urge = clamp01(urge);

    const item = {
      id: `t${at}-${++state.seq}`,
      at,
      text: String(text).slice(0, 120),
      source,
      urge: Number(urge.toFixed(3)),
      acted: false,
    };
    state.items.push(item);
    if (state.items.length > maxItems) state.items = state.items.slice(-maxItems);
    state.lastAt = at;
    dirty = true;
    save();
    return item;
  }

  function recent(limit = 3) {
    return state.items.slice(-Math.max(1, limit));
  }

  /** 该不该因为某个念头主动行动（默认 urge ≥ 0.6）。 */
  function due({ minUrge = 0.6, at = now(), cooldownMs = 30 * 60000 } = {}) {
    const item = [...state.items].reverse().find((it) => !it.acted && it.urge >= minUrge);
    if (!item) return null;
    if (at - Number(item.at) > 6 * 3600000) return null; // 太久以前的念头就不做了
    if (at - state.lastAt < 0) return null;
    const lastActed = state.items.filter((it) => it.acted).slice(-1)[0];
    if (lastActed && at - Number(lastActed.at) < cooldownMs) return null;
    return item;
  }

  function markActed(id, { at = now() } = {}) {
    const item = state.items.find((it) => it.id === id);
    if (!item) return false;
    item.acted = true;
    item.actedAt = at;
    dirty = true;
    save();
    return true;
  }

  /** 给提示词的「心里冒出来的念头」。 */
  function summaryText(limit = 3) {
    const items = recent(limit);
    if (!items.length) return '';
    const lines = items.map((it) => {
      const want = it.urge >= 0.6 ? '（很想去做）' : it.urge >= 0.4 ? '（有点想）' : '';
      const done = it.acted ? '（已经做过了）' : '';
      return `- ${it.text}${want}${done}`;
    });
    return `【你心里冒出来的念头】\n${lines.join('\n')}\n这些是你自己的想法，不用念出来；想做就去，不想就让它过去。`;
  }

  load();
  return { version: VERSION, think, recent, due, markActed, summaryText, snapshot: () => ({ items: state.items.slice(-10), lastAt: state.lastAt }), path: target };
}