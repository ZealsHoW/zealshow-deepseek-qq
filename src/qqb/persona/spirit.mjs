// R9 精神系统（Spirit）。
//
// 主人 2026-10-28 的「活人化」重构：她的行为不再由固定任务栏驱动，而是由
// **精神值**决定——看视频、刷抖音、听歌、聊天都要花精神；精神低了她会真的累、
// 回得短、犯困；睡觉才能回满，而且回满的曲线是指数式的（睡不够就回不满）。
//
// 与 mood.mjs 的分工：
//   - mood.mjs 管**情绪**（心情/委屈/社交意愿），是「想不想说」；
//   - 这里管**体力**（精神/饥饿/清醒时长），是「说得出多少、能撑多久」。
// 两者都不直接命令调用方，只给建议（gate / replyBudget），由桥接决定。
//
// 几个关键取舍：
//   1. **指数恢复**：`spirit = s0 + (1-s0) * (1 - e^(-k·h)) / (1 - e^(-k·H))`，
//      归一化到 H 小时精确回满——「睡满 X 小时才彻底回满」就是这条式子，不是拍脑袋加法。
//   2. **疲劳曲线**：醒来后 `fullRestHours`（默认 12）小时内消耗正常，超过则 ×2，
//      这样白天有行动力，又不会无限透支。
//   3. **甜食**：立刻补精神，但把「饥饿」顶上去；饿到顶会反过来扣精神（真实代价）。
//   4. 所有数值落在 `state/spirit.json`，重启不丢；时间推进用 lazy tick（读的时候补算）。
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.2';

export const DEFAULTS = {
  /** 睡满多少小时精神才彻底回满。 */
  sleepHoursToFull: 8,
  /** 醒来后多少小时内消耗正常，之后翻倍。 */
  fullRestHours: 16,
  /** 清醒时每小时自然流失。 */
  drainPerHour: 0.028,
  /** 打盹每小时恢复（很慢，且一天有上限）。 */
  napPerHour: 0.12,
  /** 打盹一天最多补多少。 */
  napDayCap: 0.35,
  /** 一口甜食立刻补多少精神。 */
  sweetRestore: 0.22,
  /** 一口甜食增加多少饥饿。 */
  sweetHunger: 0.3,
  /** 饥饿每小时自然增长。 */
  hungerPerHour: 0.03,
  /** 饿到 1 时额外每小时多掉多少精神。 */
  hungerPenalty: 0.02,
  /**
   * 吃一顿：降饥饿、补一点点精神。
   * 2026-10-29 之前只有 sweet()（越吃越饿），所以饥饿值一路顶到 1 再也下不来，
   * 反噬的「饿」让精神全天在 0.2 以下 —— 这是「精力一直很低」的主因。
   */
  eatHungerDrop: 0.35,
  eatRestore: 0.04,
  /** 各种行为的精神代价（一次）。 */
  costs: {
    chat: 0.012,      // 回一句
    voice: 0.03,      // 发一条语音
    browse: 0.05,     // 刷一会儿（看网页/热榜）
    video: 0.05,      // 看视频
    tiktok: 0.04,     // 刷抖音
    book: 0.05,       // 看书
    music: 0.02,      // 听歌
    app: 0.02,        // 打开手机软件
    sing: 0.12,       // 唱歌
    diary: 0.05,      // 写日记
    draw: 0.06,       // 画画
  },
};

const clamp01 = (n) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
const HOUR = 3600000;

/** 归一化指数恢复：h=0 不动，h≥H 精确回到 1。 */
export function sleepRecovery(s0, hours, fullHours) {
  const start = clamp01(s0);
  const h = Math.max(0, Number(hours) || 0);
  const H = Math.max(0.5, Number(fullHours) || 8);
  if (h >= H) return 1;
  const k = 3 * (h / H); // 曲线陡度：前段回得快，后段趋缓
  const c = 1 / (1 - Math.exp(-3));
  return clamp01(start + (1 - start) * ((1 - Math.exp(-k)) * c));
}

/** 精神值 → 这一轮的说话预算（字数上限）与疲惫口吻。 */
export function replyBudget(spirit) {
  const s = clamp01(spirit);
  if (s < 0.2) return { maxChars: 24, tone: '困到不行：一句话，短，可能打错字' };
  if (s < 0.35) return { maxChars: 36, tone: '很累：短句，别展开' };
  if (s < 0.55) return { maxChars: 60, tone: '有点累：还是一句话，但别硬撑' };
  if (s < 0.75) return { maxChars: 90, tone: '还行：正常一句话' };
  return { maxChars: 120, tone: '精神不错：可以带点小情绪' };
}

export function createSpirit({
  root = null,
  file = null,
  logger = null,
  now = Date.now,
  options = {},
} = {}) {
  const opts = { ...DEFAULTS, ...(options || {}), costs: { ...DEFAULTS.costs, ...(options?.costs || {}) } };
  const target = file ?? (root ? path.join(root, 'state', 'spirit.json') : null);
  const state = {
    spirit: 0.9,
    hunger: 0.2,
    asleep: false,
    awakeAt: now(),
    sleptHours: 0,
    napToday: 0,
    napDay: new Date(now()).toDateString(),
    updatedAt: now(),
    log: [],
  };
  let dirty = false;

  function warn(message, detail) {
    try { logger?.warn?.(message, detail); } catch { /* 日志失败不影响状态 */ }
  }

  function load() {
    if (!target) return;
    try {
      if (!fs.existsSync(target)) return;
      const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      if (Number.isFinite(Number(raw.spirit))) state.spirit = clamp01(raw.spirit);
      if (Number.isFinite(Number(raw.hunger))) state.hunger = clamp01(raw.hunger);
      if (typeof raw.asleep === 'boolean') state.asleep = raw.asleep;
      if (Number.isFinite(Number(raw.awakeAt))) state.awakeAt = Number(raw.awakeAt);
      if (Number.isFinite(Number(raw.sleptHours))) state.sleptHours = Number(raw.sleptHours);
      if (Number.isFinite(Number(raw.napToday))) state.napToday = Number(raw.napToday);
      if (typeof raw.napDay === 'string') state.napDay = raw.napDay;
      if (Number.isFinite(Number(raw.updatedAt))) state.updatedAt = Number(raw.updatedAt);
      if (Array.isArray(raw.log)) state.log = raw.log.slice(-30);
    } catch (error) {
      warn(`精神状态读取失败（按初始值继续）：${error?.message ?? error}`);
    }
  }

  function save() {
    if (!target || !dirty) return false;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({
        version: VERSION,
        spirit: state.spirit,
        hunger: state.hunger,
        asleep: state.asleep,
        awakeAt: state.awakeAt,
        sleptHours: state.sleptHours,
        napToday: state.napToday,
        napDay: state.napDay,
        updatedAt: state.updatedAt,
        log: state.log.slice(-30),
      }, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, target);
      dirty = false;
      return true;
    } catch (error) {
      warn(`精神状态写入失败：${error?.message ?? error}`);
      return false;
    }
  }

  function note(text, at) {
    state.log.push({ t: at, text: String(text).slice(0, 80) });
    if (state.log.length > 30) state.log = state.log.slice(-30);
  }

  /** 醒来多久了（小时）。睡着时按睡前的清醒时长算。 */
  function awakeHours(at = now()) {
    return Math.max(0, (at - state.awakeAt) / HOUR);
  }

  /** 疲劳系数：清醒超过 fullRestHours 之后消耗翻倍。 */
  function fatigueFactor(at = now()) {
    if (state.asleep) return 0;
    return awakeHours(at) > opts.fullRestHours ? 2 : 1;
  }

  function rollNapDay(at = now()) {
    const today = new Date(at).toDateString();
    if (state.napDay !== today) {
      state.napDay = today;
      state.napToday = 0;
    }
  }

  /** 时间推进：自然流失 + 饥饿增长 + 饿过头的反噬。 */
  function tick(at = now()) {
    const elapsed = Math.max(0, at - state.updatedAt);
    if (elapsed < 60000) return 0;
    const hours = elapsed / HOUR;
    if (!state.asleep) {
      rollNapDay(at);
      const drain = opts.drainPerHour * fatigueFactor(at) + (state.spirit > 0 ? opts.hungerPenalty * state.hunger : 0);
      state.spirit = clamp01(state.spirit - drain * hours);
      state.hunger = clamp01(state.hunger + opts.hungerPerHour * hours);
    }
    state.updatedAt = at;
    dirty = true;
    return elapsed;
  }

  /**
   * 花精神做一件事。疲惫期（清醒超 fullRestHours）代价 ×2。
   * @returns {{ok: boolean, cost: number, spirit: number, reason?: string}}
   */
  function cost(action, { amount = null, at = now(), key = null } = {}) {
    tick(at);
    const base = amount != null ? Number(amount) : Number(opts.costs[String(action)] ?? 0.02);
    const paid = Math.max(0, base) * fatigueFactor(at);
    if (state.spirit <= 0) {
      return { ok: false, cost: 0, spirit: state.spirit, reason: '精神见底，什么都做不动' };
    }
    state.spirit = clamp01(state.spirit - paid);
    note(`${action} -${paid.toFixed(3)}${key ? `（${key}）` : ''}`, at);
    dirty = true;
    save();
    return { ok: true, cost: paid, spirit: state.spirit };
  }

  /** 睡觉：记下睡前精神与入睡时间；`hours` 由醒来时结算。 */
  function sleep({ at = now(), reason = '' } = {}) {
    tick(at);
    state.asleep = true;
    state.sleepStartedAt = at;
    note(`睡了${reason ? `（${reason}）` : ''}，睡前精神 ${state.spirit.toFixed(2)}`, at);
    dirty = true;
    save();
    return snapshot(at);
  }

  /**
   * 醒来：按睡了多久结算。睡满 sleepHoursToFull 才回满；没睡够按指数曲线补一部分。
   */
  function wake({ hours = null, at = now() } = {}) {
    const slept = hours != null && Number.isFinite(Number(hours))
      ? Math.max(0, Number(hours))
      : (state.sleepStartedAt ? (at - state.sleepStartedAt) / HOUR : 0);
    const before = state.spirit;
    state.spirit = sleepRecovery(before, slept, opts.sleepHoursToFull);
    state.hunger = clamp01(state.hunger + 0.25 * Math.min(1, slept / 8)); // 睡醒会饿
    state.asleep = false;
    state.awakeAt = at;
    state.sleptHours = slept;
    state.updatedAt = at;
    rollNapDay(at);
    note(`醒了：睡 ${slept.toFixed(1)}h，精神 ${before.toFixed(2)}→${state.spirit.toFixed(2)}`, at);
    dirty = true;
    save();
    return snapshot(at);
  }

  /** 手动改饥饿（调试/面板用）。0 = 刚吃饱，1 = 饿到顶。 */
  function setHunger(value, { at = now(), reason = '' } = {}) {
    const num = Number(value);
    if (!Number.isFinite(num)) return { ok: false, error: `不是数字：${value}` };
    tick(at);
    state.hunger = clamp01(num);
    note(`手动设定饥饿 ${state.hunger.toFixed(2)}${reason ? `（${reason}）` : ''}`, at);
    dirty = true;
    save();
    return { ok: true, hunger: state.hunger };
  }

  /** 打盹：白天小睡，恢复很慢且有日上限。 */
  function nap({ minutes = 20, at = now() } = {}) {
    tick(at);
    rollNapDay(at);
    const room = Math.max(0, opts.napDayCap - state.napToday);
    const gain = Math.min(room, (opts.napPerHour * Math.max(0, Number(minutes) || 0)) / 60);
    state.napToday = clamp01(state.napToday + gain);
    state.spirit = clamp01(state.spirit + gain);
    note(`打盹 ${minutes} 分钟 +${gain.toFixed(3)}`, at);
    dirty = true;
    save();
    return snapshot(at);
  }

  /** 好好吃一顿：饥饿降下来，精神也回来一点（吃甜的只会更饿，见 sweet）。 */
  function eat({ at = now(), what = '一顿饭' } = {}) {
    tick(at);
    state.hunger = clamp01(state.hunger - opts.eatHungerDrop);
    state.spirit = clamp01(state.spirit + opts.eatRestore);
    note(`吃了${what}：饿 ${state.hunger.toFixed(2)}，精神 +${opts.eatRestore}`, at);
    dirty = true;
    save();
    return snapshot(at);
  }

  /** 吃甜食：立刻补精神，代价是更饿。 */
  function sweet({ at = now(), what = '甜的' } = {}) {
    tick(at);
    state.spirit = clamp01(state.spirit + opts.sweetRestore);
    state.hunger = clamp01(state.hunger + opts.sweetHunger);
    note(`吃了${what} +${opts.sweetRestore}，饿 ${state.hunger.toFixed(2)}`, at);
    dirty = true;
    save();
    return snapshot(at);
  }

  /** 行为门控：能不能做这件事。 */
  function gate(action, { at = now() } = {}) {
    tick(at);
    const s = state.spirit;
    if (state.asleep) return { allow: false, reason: '睡着了', spirit: s };
    if (action === 'proactive' && s < 0.25) return { allow: false, reason: `精神见底（${s.toFixed(2)}），先歇着`, spirit: s };
    if (action === 'media' && s < 0.2) return { allow: false, reason: `太累了（${s.toFixed(2)}），不想刷了`, spirit: s };
    if (action === 'reply' && s <= 0.02) return { allow: true, reason: '困到只能回几个字', spirit: s };
    return { allow: true, reason: `精神 ${s.toFixed(2)}${fatigueFactor(at) > 1 ? '（疲劳期，消耗翻倍）' : ''}`, spirit: s };
  }

  function statusWord(at = now()) {
    tick(at);
    const s = state.spirit;
    if (state.asleep) return '睡着了';
    if (s > 0.75) return '精神很好';
    if (s > 0.55) return '精神还行';
    if (s > 0.35) return '有点累';
    if (s > 0.18) return '很困';
    return '困到睁不开眼';
  }

  function snapshot(at = now()) {
    tick(at);
    return {
      spirit: state.spirit,
      hunger: state.hunger,
      asleep: state.asleep,
      awakeHours: Number(awakeHours(at).toFixed(2)),
      fatigueFactor: fatigueFactor(at),
      sleptHours: state.sleptHours,
      napToday: Number(state.napToday.toFixed(3)),
      status: statusWord(at),
      budget: replyBudget(state.spirit),
      updatedAt: state.updatedAt,
      log: state.log.slice(-8),
    };
  }

  /** 给提示词的一段（短，别占 token）。 */
  function summary(at = now()) {
    tick(at);
    const s = state.spirit;
    const awake = awakeHours(at);
    const fatigue = fatigueFactor(at) > 1 ? '，已经过了这个点，做什么都比平时更费精神' : '';
    const hunger = state.hunger > 0.75 ? '，肚子很饿，注意力有点散' : state.hunger > 0.5 ? '，有点饿了' : '';
    const napHint = s < 0.35 && awake > 6 ? '（太累就趴一会儿，或者吃点甜的顶一下）' : '';
    const budget = replyBudget(s);
    return `【你的精神】${statusWord(at)}（精神值 ${s.toFixed(2)}／清醒 ${awake.toFixed(1)} 小时${fatigue}）${hunger}。这一轮最多说 ${budget.maxChars} 字，${budget.tone}。${napHint}`;
  }

  /** 手动设定（调试/主人想让她清醒一点）。 */
  function setSpirit(value, { at = now(), reason = '' } = {}) {
    const num = Number(value);
    if (!Number.isFinite(num)) return { ok: false, error: `不是数字：${value}` };
    tick(at);
    state.spirit = clamp01(num);
    note(`手动设定 ${state.spirit.toFixed(2)}${reason ? `（${reason}）` : ''}`, at);
    dirty = true;
    save();
    return { ok: true, spirit: state.spirit };
  }

  load();
  tick();
  return {
    version: VERSION,
    snapshot,
    summary,
    gate,
    cost,
    sleep,
    wake,
    nap,
    eat,
    sweet,
    tick,
    setSpirit,
    setHunger,
    statusWord,
    replyBudget: () => replyBudget(state.spirit),
    fatigueFactor,
    awakeHours,
    save,
    path: target,
    options: opts,
  };
}