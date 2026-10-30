// R2 情绪/状态机。
//
// 目的：让「主动开口」这类行为由**她此刻的状态**决定，而不是纯定时器 + 随机数。
// 四个维度（都归一化到 0~1，越大约强烈）：
//   mood       心情好坏（基线偏高兴）
//   energy     精力（深夜与连发会掉，睡一觉回满）
//   irritation 委屈/生气（被凶会涨，被道歉会掉；可以只针对某个人）
//   social     社交意愿（想不想说话）
//
// 语义取舍：
//   - 事件驱动 + 时间衰减，衰减是**连续**的（不是每事件一次），所以长时间没人理她心情会自己回稳；
//   - 状态落 `state/persona-state.json`，重启不丢（跨会话的人味儿靠它）；
//   - `gate(action)` 给的是**建议**（allow / soften / deny + 概率系数 + 语气），
//     调用方（主动检查、发送、R8 定向投递）据此决定，而不是被这里硬控制。
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.3';

export const BASELINE = { mood: 0.62, energy: 0.7, irritation: 0.05, social: 0.55 };
export const DIMS = Object.keys(BASELINE);

/** 事件表。数值是「一次事件带来的偏移」，不乘时间。 */
export const EVENTS = {
  // 0.1.2：家人的夸奖/鼓励/「爱你」开始真的**补能量**——主人点名要的：被家里人夸、被说爱你，
  // 她该更有劲儿。数值按「两三句暖心话就能把主动闸门（energy ≥ 0.25）顶开」标定，
  // 单句不至于一下灌满（1.0）。
  praised: { mood: 0.1, irritation: -0.06, social: 0.05, energy: 0.06 },
  loved: { mood: 0.15, irritation: -0.1, social: 0.08, energy: 0.12 },
  // energy 原是 -0.02：光「被家里人搭话」这一项，每小时 6 条就把恢复额（约 +0.12/h）吃光，
  // 她再回一句就倒欠——精力因此长期停在 0，主动开口的闸门（energy ≥ 0.25）形同关闭。
  warm_chat: { mood: 0.05, social: 0.06, energy: -0.005 },
  family_greeting: { mood: 0.08, social: 0.04 },
  apology: { irritation: -0.15, mood: 0.05 },
  scolded: { mood: -0.18, irritation: 0.25, social: -0.1 },
  ignored: { mood: -0.06, irritation: 0.1, social: -0.08 },
  long_silence: { mood: -0.02, social: -0.05 },
  late_night: { energy: -0.05, mood: -0.01 },
  own_reply: { energy: -0.04, social: -0.02 },
  rest: { energy: 0.25, irritation: -0.08, mood: 0.03, social: 0.05 },
  // 2026-10-30：睡一整夜原来只走 rest（+0.25），她睡前 0.03，醒来 0.28 ⇒ 一早说「我一晚上没睡好」。
  // 睡够一晚必须真的回血，这条按「从见底拉起、醒来接近满格」标定（再配合 restoreEnergy 兜底）。
  slept: { energy: 0.68, irritation: -0.15, mood: 0.08, social: 0.05 },
};

/** 衰减速度（毫秒）。数值越大衰减越慢。 */
const DECAY = {
  mood: 12 * 3600000,
  energy: 6 * 3600000,
  irritation: 6 * 3600000,
  social: 3 * 3600000,
};

const clamp01 = (n) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

function mix(current, target, tauMs, elapsedMs) {
  if (!(elapsedMs > 0) || !(tauMs > 0)) return current;
  const k = 1 - Math.exp(-elapsedMs / tauMs);
  return clamp01(current + (target - current) * k);
}

export function createMood({
  root = null,
  file = null,
  logger = null,
  now = Date.now,
  maxEvents = 50,
  scoldWords = ['笨蛋', '真笨', '废物', '没用', '滚', '闭嘴', '烦人', '讨厌你', '不如', '别说了', '垃圾'],
  // 夸奖 / 鼓励 / 道谢：给心情与社交，也补一点能量。
  praiseWords = ['厉害', '真好', '谢谢你', '辛苦', '加油', '你可以的', '相信你', '聪明', '棒', '乖', '可爱', '贴心', '懂事', '最棒'],
  // 直白的疼爱：比夸奖更补能量。
  // 只收「朝她说」的说法（爱你/想你/抱抱…），**不收**「宝宝」「宝贝」「好孩子」这类称呼——
  // 家里人也拿它们互相称呼（群里就有「@… 宝宝」这种），会把闲聊误判成疼爱。
  loveWords = ['爱你', '喜欢你', '想你', '抱抱', '亲亲', '最爱的'],
  // 否定闸：这些词里含「爱你」「喜欢你」「棒」，漏了它就会把嫌弃记成疼爱。
  negations = ['不爱你', '不爱我', '不喜欢你', '不想你', '不棒', '不厉害', '别爱我']
} = {}) {
  const target = file ?? (root ? path.join(root, 'state', 'persona-state.json') : null);
  const state = {
    dims: { ...BASELINE },
    targets: {}, // key -> { irritation, at }
    events: [],
    updatedAt: now(),
  };
  let dirty = false;

  function warn(message, detail) {
    try { logger?.warn?.(message, detail); } catch { /* 日志失败不影响状态机 */ }
  }

  function load() {
    if (!target) return;
    try {
      if (!fs.existsSync(target)) return;
      const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (raw && typeof raw === 'object') {
        for (const dim of DIMS) {
          if (Number.isFinite(raw.dims?.[dim])) state.dims[dim] = clamp01(raw.dims[dim]);
        }
        if (raw.targets && typeof raw.targets === 'object') {
          for (const [key, value] of Object.entries(raw.targets)) {
            const ir = Number(value?.irritation);
            if (Number.isFinite(ir) && ir > 0) state.targets[key] = { irritation: clamp01(ir), at: Number(value?.at) || 0 };
          }
        }
        if (Array.isArray(raw.events)) state.events = raw.events.slice(-maxEvents);
        if (Number.isFinite(Number(raw.updatedAt))) state.updatedAt = Number(raw.updatedAt);
      }
    } catch (error) {
      warn(`情绪状态读取失败（按初始状态继续）：${error?.message ?? error}`);
    }
  }

  function save() {
    if (!target || !dirty) return false;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({
        version: VERSION,
        dims: state.dims,
        targets: state.targets,
        events: state.events.slice(-maxEvents),
        updatedAt: state.updatedAt,
      }, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, target);
      dirty = false;
      return true;
    } catch (error) {
      warn(`情绪状态写入失败：${error?.message ?? error}`);
      return false;
    }
  }

  /** 时间衰减：把四个维度朝基线拉，深夜恢复得更快（睡觉回血）。 */
  function decay(at = now()) {
    const elapsed = Math.max(0, at - state.updatedAt);
    if (elapsed < 60000) return 0;
    const hour = new Date(at).getHours();
    const resting = hour >= 0 && hour < 8;
    for (const dim of DIMS) {
      let tau = DECAY[dim];
      let base = BASELINE[dim];
      if (dim === 'energy' && resting) { tau = 3 * 3600000; base = 0.95; }
      state.dims[dim] = mix(state.dims[dim], base, tau, elapsed);
    }
    for (const [key, value] of Object.entries(state.targets)) {
      const left = value.irritation * Math.exp(-elapsed / DECAY.irritation);
      if (left < 0.02) delete state.targets[key];
      else state.targets[key] = { ...value, irritation: clamp01(left) };
    }
    state.updatedAt = at;
    dirty = true;
    return elapsed;
  }

  /**
   * 观测一次事件。text 给了就按关键词做一次轻量情感判定（不调模型，免费）。
   * @returns {{event: string, dims: object, target: string|null}}
   */
  function observe(event, { text = '', key = null, at = now() } = {}) {
    decay(at);
    let name = String(event || '');
    if (!name && text) name = classify(text);
    const table = EVENTS[name];
    if (!table) return { event: name, dims: { ...state.dims }, target: null };
    for (const [dim, delta] of Object.entries(table)) state.dims[dim] = clamp01(state.dims[dim] + delta);
    let targetKey = null;
    if (key && (name === 'scolded' || name === 'ignored')) {
      targetKey = String(key);
      const prev = state.targets[targetKey]?.irritation ?? 0;
      state.targets[targetKey] = { irritation: clamp01(prev + table.irritation * 0.8), at };
    }
    if (key && (name === 'praised' || name === 'apology') && state.targets[String(key)]) {
      const prev = state.targets[String(key)].irritation;
      const next = clamp01(prev + (table.irritation ?? 0) * 0.8);
      if (next < 0.02) delete state.targets[String(key)];
      else state.targets[String(key)] = { irritation: next, at };
    }
    state.events.push({ t: at, event: name, key: key ?? null, text: text ? String(text).slice(0, 60) : '' });
    if (state.events.length > maxEvents) state.events = state.events.slice(-maxEvents);
    dirty = true;
    save();
    return { event: name, dims: { ...state.dims }, target: targetKey };
  }

  /** 关键词情感判定：只认最明显的那几个，认不出就算普通聊天。 */
  function classify(text) {
    const s = String(text || '');
    if (!s) return 'warm_chat';
    if (scoldWords.some((w) => s.includes(w))) return 'scolded';
    // 否定先挡：`不喜欢你` / `不爱你` 里含 `喜欢你` / `爱你`，漏了这道闸就会把嫌弃夸成疼爱。
    if (negations.some((w) => s.includes(w))) return 'warm_chat';
    if (loveWords.some((w) => s.includes(w))) return 'loved';
    if (praiseWords.some((w) => s.includes(w))) return 'praised';
    return 'warm_chat';
  }

  /** 针对某个会话的委屈值（人级），没有就是全局 irritation 的一部分。 */
  function irritationFor(key) {
    decay();
    const own = Number(state.targets[String(key)]?.irritation) || 0;
    return clamp01(Math.max(own, own * 0.6 + state.dims.irritation * 0.4));
  }

  /**
   * 行为门控：给调用方的建议，不是命令。
   * @param {'proactive'|'reply'|'directed'|'media'} action
   * @returns {{allow: boolean, probFactor: number, tone: string, reason: string, dims: object}}
   */
  function gate(action, { key = null, hour = null, idleMs = null, at = now() } = {}) {
    decay(at);
    const h = hour == null ? new Date(at).getHours() : Number(hour);
    const d = state.dims;
    const ir = key ? irritationFor(key) : d.irritation;
    const dims = { ...d, irritationTo: ir };
    const night = h >= 23 || h < 8;
    const tone = ir > 0.55 ? 'sulky' : d.mood > 0.7 && d.energy > 0.5 ? 'bright' : d.energy < 0.3 ? 'tired' : 'soft';

    if (action === 'proactive') {
      let factor = 1;
      // 频率预算：刚说过话、最近说太多、白天深夜，都按系数压
      if (d.energy < 0.25) return { allow: false, probFactor: 0, tone, reason: `精力见底（${d.energy.toFixed(2)}），先潜水歇会儿`, dims };
      if (ir > 0.45) return { allow: false, probFactor: 0, tone: 'sulky', reason: `在生闷气（委屈 ${ir.toFixed(2)}），不想主动开口`, dims };
      if (d.mood < 0.3) return { allow: false, probFactor: 0, tone, reason: `心情低（${d.mood.toFixed(2)}），这次不冒泡`, dims };
      if (night && d.energy < 0.55) return { allow: false, probFactor: 0, tone: 'tired', reason: '这个点了，困', dims };
      factor *= 0.6 + d.social * 0.8;          // 社交意愿
      factor *= 0.7 + d.mood * 0.6;            // 心情
      if (night) factor *= 0.4;
      if (idleMs != null && idleMs > 6 * 3600000) factor *= 1.25; // 很久没说话了，想冒个泡
      return {
        allow: true,
        probFactor: Math.min(1.6, Math.max(0.05, factor)),
        tone,
        reason: `心情 ${d.mood.toFixed(2)} / 精力 ${d.energy.toFixed(2)} / 社交 ${d.social.toFixed(2)}${night ? ' / 深夜' : ''}`,
        dims,
      };
    }

    if (action === 'reply') {
      // 回复永远不拒绝（家里人说话不能装死），但可以「短一点、傲娇一点」
      if (ir > 0.5) return { allow: true, probFactor: 1, tone: 'sulky', reason: `还在委屈（${ir.toFixed(2)}）：回短一点、带点傲娇`, dims };
      if (d.energy < 0.2) return { allow: true, probFactor: 1, tone: 'tired', reason: '很累：可以简短、别硬撑长篇', dims };
      return { allow: true, probFactor: 1, tone, reason: `心情 ${d.mood.toFixed(2)} / 精力 ${d.energy.toFixed(2)}`, dims };
    }

    if (action === 'directed') {
      // R8 定向投递：她的主观意愿优先——委屈大就直接拒（由上层生成委婉话术）
      if (ir > 0.55) return { allow: false, probFactor: 0, tone: 'sulky', reason: `对这个人还有气（${ir.toFixed(2)}），这次不替他传话`, dims };
      if (d.energy < 0.2) return { allow: false, probFactor: 0, tone: 'tired', reason: '太累了，不想动', dims };
      return { allow: true, probFactor: 0.5 + d.social * 0.5, tone, reason: `愿意去说，但按自己的语气（心情 ${d.mood.toFixed(2)}）`, dims };
    }

    return { allow: true, probFactor: 1, tone, reason: `心情 ${d.mood.toFixed(2)} / 精力 ${d.energy.toFixed(2)}`, dims };
  }

  /** 给提示词用的一句话状态（短，别占 token）。 */
  function summary() {
    decay();
    const d = state.dims;
    const moodWord = d.mood > 0.75 ? '心情很好' : d.mood > 0.5 ? '心情还行' : d.mood > 0.32 ? '有点闷' : '心情不太好';
    const energyWord = d.energy > 0.7 ? '精神不错' : d.energy > 0.45 ? '还行' : d.energy > 0.25 ? '有点累' : '很困';
    const irWord = d.irritation > 0.55 ? '还在委屈' : d.irritation > 0.25 ? '有点小别扭' : '';
    const tail = irWord ? `，${irWord}` : '';
    return `【此刻的心情】${moodWord}、${energyWord}${tail}；想说话的意愿 ${d.social.toFixed(2)}。（这是你自己的状态，语气自然跟着走，别念出来。）`;
  }

  /**
   * 手动改一个维度（绝对值，clamp 到 0~1）。给「家人/主人手动把她精力调高」和应急调试用。
   *
   * 必须走这个实例：state/persona-state.json 只是它的内存快照，直接改文件会在下一次事件
   * （decay + save）时被内存里的旧值原样盖回去。
   * @returns {{ok: boolean, name?: string, value?: number, dims?: object, error?: string}}
   */
  function setDim(name, value, { at = now(), reason = '' } = {}) {
    const dim = String(name ?? '');
    if (!DIMS.includes(dim)) return { ok: false, error: `未知的状态维度：${name}（可用：${DIMS.join('、')}）` };
    const num = Number(value);
    if (!Number.isFinite(num)) return { ok: false, error: `不是数字：${value}` };
    decay(at);
    state.dims[dim] = clamp01(num);
    const note = `${dim}=${state.dims[dim].toFixed(2)}${reason ? `（${String(reason).slice(0, 40)}）` : ''}`;
    state.events.push({ t: at, event: 'manual', key: null, text: note });
    if (state.events.length > maxEvents) state.events = state.events.slice(-maxEvents);
    dirty = true;
    save();
    return { ok: true, name: dim, value: state.dims[dim], dims: { ...state.dims } };
  }

  function snapshot() {
    decay();
    return { dims: { ...state.dims }, targets: { ...state.targets }, updatedAt: state.updatedAt, events: state.events.slice(-10) };
  }

  load();
  decay();
  /**
   * 把某个维度抬到至少 floor（只升不降）。睡觉醒来用它兜底：
   * 就算睡前是 0.03、事件表加起来也不够，醒来也该是「睡饱了」的样子。
   * @returns {{ok:boolean, dims:object}|{ok:false, error:string}}
   */
  function restoreEnergy(floor = 0.9, { at = now() } = {}) {
    const num = Number(floor);
    if (!Number.isFinite(num)) return { ok: false, error: `不是数字：${floor}` };
    const want = Math.max(0, Math.min(1, num));
    if (state.dims.energy >= want) return { ok: true, dims: { ...state.dims } };
    decay(at);
    state.dims.energy = want;
    state.events.push({ t: at, event: restore_energy, delta: { energy: want } });
    if (state.events.length > maxEvents) state.events.splice(0, state.events.length - maxEvents);
    state.updatedAt = at;
    dirty = true;
    save();
    return { ok: true, dims: { ...state.dims } };
  }

  return { version: VERSION, observe, classify, gate, summary, snapshot, setDim, restoreEnergy, irritationFor, decay, save, events: () => state.events.slice(), path: target };
}