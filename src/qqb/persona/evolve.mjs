// R1b 人设演变（R5 人工干预也走这条落地路径）。
//
// 目的：人格卡不再是写死的模板。她在长期对话里长出来的「近况 / 习惯 / 承诺 / 在意的」，
// 会以**受管区块**的形式，慢慢写回 roles/小鲸鱼.md；人工干预（actor='owner'）走同一条路。
//
// 三条硬规矩：
//   1) 只动标记之间的内容。人格卡其余部分是主人的创作，一个字都不许碰；
//   2) 每次落盘都留审计（before/after + 原因 + 证据），并把写盘前的卡片存进
//      state/persona-card-history/，以便随时回滚；
//   3) 演化是**规则式**的（免费、不调 LLM）：候选来自记忆库里「关于她自己的」事实，
//      以及历史消息的时间分布（比如最近总在深夜说话 → 习惯：最近常熬夜）。
//
// 设计取舍：结构化特征存 state/persona-traits.json（可机器读写、可 diff），
// 人格卡里只放渲染好的短区块（给模型看）。两者不同步也没关系——卡片丢了能重渲染。
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.4';

/** 受管区块的标记。渲染/替换只在这两行之间发生。 */
export const CARD_BEGIN = '<!-- qqb-persona:begin（自动维护，可回滚；请勿手工编辑这一块） -->';
export const CARD_END = '<!-- qqb-persona:end -->';

export const TRAIT_KINDS = ['promise', 'habit', 'like', 'dislike', 'self', 'rule'];
export const KIND_LABEL = { promise: '承诺', habit: '习惯', like: '喜欢', dislike: '不太喜欢', self: '近况', rule: '底线' };

/**
 * 「规矩」类事实：是约束不是偏好，渲染成「底线」而不是「喜欢」。
 * 例：小鲸鱼拒绝登录或使用他人的抖音账号，只看公开页面。
 */
export const RULE_RE = /拒绝|禁止|不许|不可以|不能|不允许|只看|不登|别登|别人的账号|他人账号|隐私|别外传|不要外传|底线|违规|危险/;
/** 纯聊天碎片（顶嘴、反问、口头语开头）不该被当成她的长期人设。 */
const CHATTER_RE = /^(那|这|好|行|嗯|哦|诶|哎|哈|喂|对了|然后|所以|但是|不过)/;
/**
 * 承诺/打算里真正要紧的标记：口头语开头的句子只要带着这些，就还是长期特征，
 * 别把「那英语明天补上」这种真承诺跟「那我也没办法」这种顶嘴一起丢掉。
 */
const COMMIT_RE = /答应|说好|约定|明天|后天|以后|下次|这周|下周|每天|每晚|一定|记得|补上|写完|复习|早起|早睡/;
/**
 * 第三人称（记忆库里的书面语）转成人设块里的第一人称。
 * 只换「小鲸鱼」这个自称，别的词一个字不动。
 */
export function toFirstPerson(text) {
  return String(text ?? '').replace(/小鲸鱼/g, '我');
}
/** 这条候选值不值得写进她的人设块（挡掉聊天碎片与模板残渣）。 */
export function worthKeeping(text, kind) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (t.includes('{{') || t.includes('}}')) return false;
  if (/[？?]$/.test(t)) return false;
  // 承诺/偏好桶里，口头语开头、很短、又没有任何承诺标记的顶嘴句子不算长期特征
  if ((kind === 'promise' || kind === 'like') && t.length <= 16 && CHATTER_RE.test(t) && !COMMIT_RE.test(t)) return false;
  return true;
}
/**
 * 记忆/候选的 kind → 人设特征 kind。
 * **底线优先**：看起来像规矩的一律归「底线」，不能被塞进「近况」里当成随口一提
 * （主人 2026-10-21 指出人格卡区块把规矩标成了近况）。
 */
export function traitKindOf(kind, text) {
  if (RULE_RE.test(String(text ?? ''))) return 'rule';
  const k = String(kind ?? '');
  if (k === 'promise') return 'promise';
  if (k === 'preference' || k === 'like') return 'like';
  if (k === 'dislike') return 'dislike';
  if (k === 'habit') return 'habit';
  if (TRAIT_KINDS.includes(k)) return k;
  return 'self';
}

const clampText = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const normKey = (s) => String(s ?? '').toLowerCase().replace(/[\s，。！？、,.!?；;：:（）()「」“”"'’‘~～-]/g, '');

/**
 * 近重复阈值：同一件事被巩固两次时，措辞通常只差几个字
 * （「我这边开了权限马上补」vs「我这边权限的事刚有个头绪，等弄好了马上补上，说好的」）。
 * 归一化只能抓住一模一样的，同义改写要靠二字组 Jaccard —— 0.6 左右是实测的甜点：
 * 再低会把「明天抽查」和「今晚抽查」并成一条，再高又抓不住改写。
 */
export const TRAIT_SIMILAR = 0.6;

export function bagOf(text) {
  const s = String(text ?? '').normalize('NFKC').toLowerCase();
  const bag = new Set();
  for (const w of s.match(/[a-z0-9]{2,}/g) ?? []) bag.add(w);
  for (const run of s.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) bag.add(run.slice(i, i + 2));
  }
  return bag;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * 各类特征能活多久（天）：0/缺省 = 不过期。
 * 承诺最该短命 —— 它是「当时答应过的一件事」，不像喜好、底线能长期成立。
 */
export const KIND_MAX_AGE_DAYS = { promise: 10 };

export function staleByKind(kind, at, nowTs = Date.now()) {
  const maxDays = KIND_MAX_AGE_DAYS[kind];
  if (!maxDays) return false;
  const ts = Number(at);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return nowTs - ts > maxDays * 24 * 60 * 60 * 1000;
}

export function createEvolve({
  root = null,
  cardFile = null,
  traitsFile = null,
  cardHistoryDir = null,
  historyDir = null,
  store = null,
  logger = null,
  now = Date.now,
  maxTraits = 24,
  maxLines = 5,
  maxChars = 420,
  dryRun = false
} = {}) {
  const cardPath = cardFile ?? (root ? path.join(root, 'roles', '小鲸鱼.md') : null);
  const traitsPath = traitsFile ?? (root ? path.join(root, 'state', 'persona-traits.json') : null);
  const historyPath = cardHistoryDir ?? (root ? path.join(root, 'state', 'persona-card-history') : null);
  const histDir = historyDir ?? (root ? path.join(root, 'state', 'history') : null);

  const state = { version: VERSION, updatedAt: 0, traits: {} };

  function warn(message, detail) {
    try { logger?.warn?.(message, detail); } catch { /* 日志失败不影响演化 */ }
  }

  function load() {
    if (!traitsPath) return;
    try {
      if (!fs.existsSync(traitsPath)) return;
      const raw = JSON.parse(fs.readFileSync(traitsPath, 'utf8'));
      if (raw && typeof raw === 'object') {
        state.updatedAt = Number(raw.updatedAt) || 0;
        for (const kind of TRAIT_KINDS) {
          const list = Array.isArray(raw.traits?.[kind]) ? raw.traits[kind] : [];
          state.traits[kind] = list
            .map((t) => {
              const source = clampText(t?.source ?? '', 40);
              return {
                // 老表里存的是书面第三人称（「小鲸鱼…」），读出来统一成第一人称。
                text: toFirstPerson(clampText(t?.text, 80)),
                weight: Number.isFinite(Number(t?.weight)) ? Number(t.weight) : 0.5,
                source,
                evidence: clampText(t?.evidence ?? '', 160),
                at: Number(t?.at) || 0
              };
            })
            // 老表里混进来的聊天碎片（顶嘴、反问、口头语）：只清「记忆推出来」的那些，
            // 主人/她自己明确采纳的建议一律保留（那是有人拍过板的）。
            .filter((t) => t.text && !(t.source === 'memory' && !worthKeeping(t.text, traitKindOf(kind, t.text))));
          // 同一个桶里同一条（第三人称/第一人称各存了一份）只留权重最高的那条，
          // 否则渲染出来会是两行一模一样的话。
          const seen = new Map();
          for (const trait of state.traits[kind]) {
            const key = normKey(trait.text);
            const prev = seen.get(key);
            if (!prev || trait.weight > prev.weight) seen.set(key, trait);
          }
          state.traits[kind] = [...seen.values()];
        }
        // 就地纠错：0.1.2 之前规矩/约束被当成「近况」存进表里了，读的时候顺手挪到「底线」，
        // 免得旧条目一直错位，还和新条目在卡片里重复出现。
        for (const kind of TRAIT_KINDS) {
          if (kind === 'rule') continue;
          const bucket = state.traits[kind] ?? [];
          if (!bucket.length) continue;
          const keep = [];
          for (const trait of bucket) {
            if (trait.text && RULE_RE.test(trait.text)) {
              const ruleBucket = state.traits.rule ?? (state.traits.rule = []);
              if (!ruleBucket.some((r) => normKey(r.text) === normKey(trait.text))) ruleBucket.push(trait);
              continue;
            }
            keep.push(trait);
          }
          state.traits[kind] = keep;
        }
      }
    } catch (error) {
      warn(`人设特征读取失败（按空开始）：${error?.message ?? error}`);
    }
  }

  function save() {
    if (!traitsPath || dryRun) return false;
    try {
      state.updatedAt = now();
      fs.mkdirSync(path.dirname(traitsPath), { recursive: true });
      const tmp = `${traitsPath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: VERSION, updatedAt: state.updatedAt, traits: state.traits }, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, traitsPath);
      return true;
    } catch (error) {
      warn(`人设特征写入失败：${error?.message ?? error}`);
      return false;
    }
  }

  /** 全部特征（按 kind 分组，平铺成数组方便上层处理）。 */
  function all() {
    const out = [];
    for (const kind of TRAIT_KINDS) for (const t of state.traits[kind] ?? []) out.push({ kind, ...t });
    return out;
  }

  /**
   * 从长期记忆与历史时间分布里推出候选特征（规则式，免费）。
   * 只认「主语是她自己」的记忆——别人的事属于记忆，不属于人设。
   */
  function derive({ memoryLimit = 200, historySample = 300 } = {}) {
    const out = [];
    // 1) 记忆库里关于她自己的承诺 / 偏好 / 事实
    try {
      const rows = store?.exportAll ? store.exportAll({}) : [];
      // 退役（过期）的记忆不再拿来塑造人设：2026-10-27 主人说「别总揪着妈妈背单词」，
      // 根子就是那批「七点五十四抽查单词」的约定被记忆注入、又被这里写成一直生效的
      // promise trait。过期只是让它不再自动冒头，行还在库里可以查。
      const nowTs = Number(now?.()) || Date.now();
      const alive = (row) => !row?.deleted_at && !row?.archived_at
        && !(row?.expires_at && Number(row.expires_at) <= nowTs);
      const mine = rows
        .filter(alive)
        .filter((row) => String(row?.subject ?? '') === '小鲸鱼' || /^我$/.test(String(row?.subject ?? '')))
        .sort((a, b) => Number(b?.importance ?? 0) - Number(a?.importance ?? 0))
        .slice(0, memoryLimit);
      for (const row of mine) {
        const text = toFirstPerson(clampText(row?.text, 80));
        if (!text) continue;
        const mapped = traitKindOf(row?.kind, text);
        if (!worthKeeping(text, mapped)) continue;
        // 承诺会过期：「明天给你发图」这种话说出口那天有效，十来天后还当特征注入，
        // 她就一直照着一句旧承诺往下演（2026-11-03 主人报「机制太僵硬」的同源问题）。
        if (staleByKind(mapped, row?.created_at, nowTs)) continue;
        out.push({
          kind: mapped,
          text,
          weight: Math.min(1, Math.max(0.3, Number(row?.importance ?? 0.5))),
          source: 'memory',
          // at 用记忆自己的发生时间：特征里那条「（承诺·10-27）」才是真的 10-27，
          // 而不是被演化当场刷成今天（2026-11-03 主人报「总把前几天的事记成今天」）。
          at: Number(row?.created_at ?? row?.updated_at ?? 0) || undefined,
          evidence: `记忆 #${row?.id ?? '?'}（${row?.layer ?? '?'}）`
        });
      }
    } catch (error) {
      warn(`从记忆推人设失败：${error?.message ?? error}`);
    }

    // 2) 历史消息的时间分布 → 作息类习惯（只在她最近真的常在深夜说话时才写）
    try {
      if (histDir && fs.existsSync(histDir)) {
        const files = fs.readdirSync(histDir).filter((f) => f.endsWith('.jsonl'));
        const hours = new Array(24).fill(0);
        let total = 0;
        for (const file of files) {
          const lines = fs.readFileSync(path.join(histDir, file), 'utf8').split('\n').filter(Boolean).slice(-historySample);
          for (const line of lines) {
            try {
              const rec = JSON.parse(line);
              if (rec?.self !== true) continue; // 只看她自己发言的时间
              const h = new Date(Number(rec.t)).getHours();
              if (Number.isFinite(h)) { hours[h] += 1; total += 1; }
            } catch { /* 单行坏了跳过 */ }
          }
        }
        if (total >= 40) {
          const late = hours.slice(23).concat(hours.slice(0, 2)).reduce((a, b) => a + b, 0);
          const early = hours.slice(6, 9).reduce((a, b) => a + b, 0);
          if (late / total >= 0.2) {
            out.push({ kind: 'habit', text: '最近常熬夜，深夜也在说话', weight: 0.6, source: 'history', evidence: `深夜发言占比 ${Math.round((late / total) * 100)}%` });
          } else if (early / total >= 0.25) {
            out.push({ kind: 'habit', text: '起得挺早，早上就在线', weight: 0.5, source: 'history', evidence: `早间发言占比 ${Math.round((early / total) * 100)}%` });
          }
        }
      }
    } catch (error) {
      warn(`从历史推作息失败：${error?.message ?? error}`);
    }

    // 同批去重（同 kind 同文本只留权重最高的那条）
    const seen = new Map();
    for (const item of out) {
      const key = `${item.kind}:${normKey(item.text)}`;
      const prev = seen.get(key);
      if (!prev || item.weight > prev.weight) seen.set(key, item);
    }
    return [...seen.values()];
  }

  /** 把候选并进特征表：同文本只累加权重与证据，不重复堆条目。 */
  function merge(candidates, { actor = 'self', source = null } = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const cand of list) {
      const text = toFirstPerson(clampText(cand?.text, 80));
      if (!text) { skipped += 1; continue; }
      // 归桶也要过一遍底线判断：外部候选（记忆/主人指令）说成「近况」也不许错位。
      const kind = traitKindOf(cand?.kind, text);
      const bucket = state.traits[kind] ?? (state.traits[kind] = []);
      const key = normKey(text);
      const bag = bagOf(text);
      // 先找一模一样的；再找「说的是同一件事、只是换了说法」的（TRAIT_SIMILAR）。
      const hit = bucket.find((t) => normKey(t.text) === key)
        ?? bucket.find((t) => jaccard(bagOf(t.text), bag) >= TRAIT_SIMILAR);
      if (hit) {
        hit.weight = Math.min(1, Number(hit.weight) + 0.05);
        // at 留着不动 = 「这条最早是什么时候出现的」。以前每次重新演化都把它刷成现在，
        // 于是十天前的旧承诺在提示词里永远显示「今天」—— 2026-11-03 主人报的
        // 「她总把前几天的事记成今天」有一半来自这里。最近一次被印证的时间单独记 lastAt。
        hit.lastAt = now();
        if (cand.evidence) hit.evidence = clampText(cand.evidence, 160);
        updated += 1;
      } else {
        // 候选若带着「这件事原始发生时间」（derive 从记忆推来的会带 created_at），
        // 就用它当 at —— 否则新长出来的特征全显示成「今天」。
        const born = Number(cand?.at ?? cand?.created_at ?? 0);
        bucket.push({
          text,
          weight: Math.min(1, Math.max(0.2, Number(cand.weight) || 0.5)),
          source: clampText(source ?? cand.source ?? actor, 40),
          evidence: clampText(cand.evidence ?? '', 160),
          at: Number.isFinite(born) && born > 0 ? born : now()
        });
        added += 1;
      }
    }
    // 上限：按权重留最好的，旧的低权重条目自然被挤掉；顺带让过期的承诺退场
    // （主人拍过板的建议不动 —— 那类条目 source 是 owner-advice）。
    for (const kind of TRAIT_KINDS) {
      let bucket = (state.traits[kind] ?? [])
        .filter((t) => t?.source === 'owner-advice' || !staleByKind(kind, t?.at, Number(now?.()) || Date.now()));
      if (bucket.length > maxTraits) {
        bucket = bucket.sort((a, b) => Number(b.weight) - Number(a.weight)).slice(0, maxTraits);
      }
      // 无论超没超上限都要写回：以前只有超过 maxTraits 才赋值，
      // 于是「过期的承诺被过滤掉」这件事在条数不多时根本没生效（2026-11-03 实测踩到）。
      state.traits[kind] = bucket;
    }
    return { added, updated, skipped, total: all().length };
  }

  /** 渲染给模型看的短区块（没人设特征时给空串，不占 token）。 */
  function render({ lines = maxLines, chars = maxChars } = {}) {
    // 先按权重排，再「各类轮流取」：以前直接取前 5 条，权重最高的往往是一串
    // 「（承诺·10-25）…」旧承诺，把喜好/习惯全挤掉了，看着像复读机（2026-11-03 主人报的去重）。
    const sorted = all().sort((a, b) => Number(b.weight) - Number(a.weight));
    const pools = new Map();
    for (const t of sorted) {
      if (!pools.has(t.kind)) pools.set(t.kind, []);
      pools.get(t.kind).push(t);
    }
    const items = [];
    const limit = Math.max(1, lines);
    // 同一件事换个说法就会长成两条（「我下午刷了下抖音…九寨沟水獭」与「跟你说个事…九寨沟水獭」）。
    // 渲染时只留最先出来的那条，免得五行里两行在讲同一件事（2026-11-03 主人报的「记忆混乱」）。
    const RENDER_SIMILAR = 0.35;
    const bags = [];
    const tooClose = (text) => {
      const bag = bagOf(text);
      return bags.some((b) => jaccard(b, bag) >= RENDER_SIMILAR);
    };
    let round = 0;
    while (items.length < limit && round < 40) {
      let pickedAny = false;
      for (const pool of pools.values()) {
        if (items.length >= limit) break;
        let next = pool.shift();
        while (next && tooClose(next.text)) next = pool.shift();
        if (next) {
          items.push(next);
          bags.push(bagOf(next.text));
          pickedAny = true;
        }
      }
      if (!pickedAny) break;
      round += 1;
    }
    items.sort((a, b) => Number(b.weight) - Number(a.weight));
    if (!items.length) return '';
    // 带上「这条是什么时候长出来的」：没有日期时，三天前答应的「明天给你发图」和今天答应的
    // 长得一模一样，她会照着旧条一直往下拖（2026-11-03 主人：「她总把前几天的事记成今天」）。
    const dayOf = (ts) => {
      const n = Number(ts);
      if (!Number.isFinite(n) || n <= 0) return '';
      const d = new Date(n);
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const body = items.map((t) => {
      const when = dayOf(t.at);
      return `- （${KIND_LABEL[t.kind] ?? t.kind}${when ? `·${when}` : ''}）${t.text}`;
    }).join('\n');
    const block = `【她自己的长期特征（演化出来的，不是刚听说的）】\n${body}`;
    return block.length > chars ? `${block.slice(0, chars - 1)}…` : block;
  }

  /** 读人格卡里现有的受管区块（没有就给空串）。 */
  function cardBlock() {
    if (!cardPath) return '';
    try {
      if (!fs.existsSync(cardPath)) return '';
      const raw = fs.readFileSync(cardPath, 'utf8');
      const begin = raw.indexOf(CARD_BEGIN);
      const end = raw.indexOf(CARD_END);
      if (begin < 0 || end < 0 || end < begin) return '';
      return raw.slice(begin + CARD_BEGIN.length, end).trim();
    } catch (error) {
      warn(`人格卡读取失败：${error?.message ?? error}`);
      return '';
    }
  }

  function backupCard(reason) {
    if (!historyPath || !cardPath) return null;
    try {
      fs.mkdirSync(historyPath, { recursive: true });
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const name = `${stamp}.md`;
      fs.copyFileSync(cardPath, path.join(historyPath, name));
      fs.writeFileSync(path.join(historyPath, `${stamp}.json`), `${JSON.stringify({ at: now(), reason: clampText(reason, 200) }, null, 2)}\n`, 'utf8');
      return name;
    } catch (error) {
      warn(`人格卡备份失败：${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * 把渲染好的区块写进人格卡（只动标记之间；没有标记就追加）。
   * @returns {{ok: boolean, wrote: boolean, backup: string|null, reason?: string}}
   */
  function writeCard(block, { reason = '', actor = 'self' } = {}) {
    if (!cardPath) return { ok: false, wrote: false, backup: null, reason: '未配置人格卡路径' };
    if (dryRun) return { ok: true, wrote: false, backup: null, reason: 'dry-run' };
    try {
      const exists = fs.existsSync(cardPath);
      const raw = exists ? fs.readFileSync(cardPath, 'utf8') : '';
      const begin = raw.indexOf(CARD_BEGIN);
      const end = raw.indexOf(CARD_END);
      const managed = `${CARD_BEGIN}\n${block}\n${CARD_END}`;
      let next;
      if (begin >= 0 && end > begin) next = `${raw.slice(0, begin)}${managed}${raw.slice(end + CARD_END.length)}`;
      else next = `${raw.replace(/\s*$/, '')}\n\n${managed}\n`;
      const backup = exists ? backupCard(reason) : null;
      const tmp = `${cardPath}.tmp`;
      fs.mkdirSync(path.dirname(cardPath), { recursive: true });
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, cardPath);
      return { ok: true, wrote: true, backup };
    } catch (error) {
      warn(`人格卡写入失败：${error?.message ?? error}`);
      return { ok: false, wrote: false, backup: null, reason: String(error?.message ?? error) };
    }
  }

  /**
   * 演化一轮：推导候选 → 并表 → 落盘（特征表 + 人格卡受管区块）→ 写审计。
   * 区块没变化时不重复写卡片（也就不会堆一堆一模一样的备份）。
   */
  function apply({ actor = 'self', reason = '长期对话自动演化', evidence = null, candidates = null } = {}) {
    const list = candidates ?? derive();
    const merged = merge(list, { actor });
    const block = render();
    const before = cardBlock();
    let wrote = false;
    let backup = null;
    let auditId = null;
    let cardNote = '区块无变化，未改人格卡';
    if (block && block !== before) {
      const res = writeCard(block, { reason, actor });
      wrote = res.wrote;
      backup = res.backup;
      cardNote = wrote ? '已更新人格卡受管区块' : `未写入：${res.reason ?? '未知'}`;
    } else if (!block) {
      cardNote = '暂无特征可写';
    }
    save();
    try {
      auditId = store?.persona?.record?.({
        kind: 'evolve',
        field: 'managed-block',
        before: before || '（空）',
        after: block || '（空）',
        reason: `${reason}｜新增 ${merged.added} 条、更新 ${merged.updated} 条`,
        evidence: evidence ?? (backup ? `backup:${backup}` : `来源：${list.map((c) => c.source).filter(Boolean).slice(0, 4).join('/') || '无'}`),
        actor,
        applied: wrote
      }) ?? null;
    } catch (error) {
      warn(`人设审计写入失败：${error?.message ?? error}`);
    }
    return { ...merged, block, wroteCard: wrote, backup, auditId, cardNote };
  }

  /** 人格卡历史（可用于回滚）。 */
  function history() {
    if (!historyPath) return [];
    try {
      if (!fs.existsSync(historyPath)) return [];
      return fs.readdirSync(historyPath)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse()
        .map((name) => {
          const full = path.join(historyPath, name);
          return { name, bytes: fs.statSync(full).size, at: fs.statSync(full).mtimeMs };
        });
    } catch (error) {
      warn(`人格卡历史读取失败：${error?.message ?? error}`);
      return [];
    }
  }

  /** 回滚人格卡到某个备份（不传就用最近一个）。回滚本身也写审计。 */
  function rollback({ name = null, reason = '人工回滚' } = {}) {
    if (!cardPath || !historyPath) return { ok: false, reason: '未配置人格卡路径' };
    const list = history();
    const pick = name ? list.find((h) => h.name === name) : list[0];
    if (!pick) return { ok: false, reason: '没有可用的备份' };
    try {
      const before = cardBlock();
      if (!dryRun) fs.copyFileSync(path.join(historyPath, pick.name), cardPath);
      const after = cardBlock();
      const auditId = store?.persona?.record?.({
        kind: 'rollback',
        field: 'managed-block',
        before: before || '（空）',
        after: after || '（空）',
        reason: `${reason}（恢复到 ${pick.name}）`,
        evidence: `backup:${pick.name}`,
        actor: 'owner',
        applied: !dryRun,
        rollbackOf: null
      }) ?? null;
      return { ok: true, restored: pick.name, auditId, before, after };
    } catch (error) {
      warn(`人格卡回滚失败：${error?.message ?? error}`);
      return { ok: false, reason: String(error?.message ?? error) };
    }
  }

  load();
  return {
    version: VERSION,
    paths: { card: cardPath, traits: traitsPath, cardHistory: historyPath },
    state: () => ({ version: VERSION, updatedAt: state.updatedAt, traits: state.traits }),
    traits: all,
    derive,
    merge,
    render,
    apply,
    cardBlock,
    writeCard,
    history,
    rollback,
    save,
    dryRun,
  };
}