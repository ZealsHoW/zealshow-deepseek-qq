// qqb/memory/live.mjs —— 长期记忆库与桥接进程之间的那一层（R1 下半段的接线）
//
// 三条铁律：
//  1) 所有对外方法都不抛错。记忆库坏了只降级成「没有长期记忆」，绝不能拖垮桥接主循环。
//  2) 默认分层隔离：会话 key 决定分层（private / normal / group），注入提示词的 block()只取本层，
//     群聊提示词里不会平白冒出私聊内容。**但她主动检索时可以跨会话**（recallAcrossScopes）：
//     别人那边发生过的事她都能想起来，只是要不要说出来由她自己拿分寸（主人 2026-10-25 的要求）。
//  3) 写入走 store.remember()（自带去重合并 + 提炼配额），删除走 store.forget()（软删除，可追溯）。
import path from 'node:path';
import { KINDS, openStore } from './store.mjs';
import { HASH_MODEL, createEmbedder, hashVector } from './embed.mjs';
import { PROMPT_WEIGHT_FLOOR, emotionFromText } from './ebbinghaus.mjs';

export const VERSION = '0.4.1';

/** social-v2 的类别 → 记忆库类型。 */
const CATEGORY_TO_KIND = Object.freeze({
  activeTopic: 'topic',
  pendingThought: 'event',
  memberImpression: 'impression',
});

/** 各类型的默认重要度（0~1），影响召回排序。 */
const KIND_IMPORTANCE = Object.freeze({
  promise: 0.85,
  fact: 0.7,
  impression: 0.7,
  preference: 0.65,
  topic: 0.6,
  diary: 0.5,
  event: 0.4,
});

const KIND_LABEL = Object.freeze({
  fact: '事实',
  topic: '话题',
  impression: '印象',
  diary: '日记',
  preference: '偏好',
  event: '动态',
  promise: '约定',
});

const DEFAULT_MAX_CHARS = 600;
const DEFAULT_LINE_CHARS = 90;

/** 会话 key 规范化：与桥接内部的 canonicalV2Key 保持一致（去前导零）。 */
export function canonicalScope(key) {
  const raw = String(key ?? '').trim();
  const m = /^(group|private):0*(\d+)$/.exec(raw);
  return m ? `${m[1]}:${m[2]}` : raw;
}

/** 会话 key → 记忆分层。主人的私聊是 private，其它私聊是 normal，群聊是 group。 */
export function layerForKey(key, ownerQQ) {
  const scope = canonicalScope(key);
  if (scope.startsWith('group:')) return 'group';
  if (!scope.startsWith('private:')) return 'normal';
  const qq = scope.slice('private:'.length);
  return String(ownerQQ ?? '').replace(/^0+(?=\d)/, '') === qq ? 'private' : 'normal';
}

/**
 * 一次召回允许看到的分层。
 * 主人私聊可以同时看到 private 与 normal；其它私聊只看 normal；群聊只看 group。
 */
export function layersForSession(key, ownerQQ) {
  const layer = layerForKey(key, ownerQQ);
  return layer === 'private' ? ['private', 'normal'] : [layer];
}

/**
 * 会话 key → 关系语境（PANDORA_SPEC §2 的硬过滤入口）。
 * owner = 主人私聊；friend = 其它私聊；group = 群聊；self = 她主动跨会话检索（不设限）。
 *
 * 为什么必须有：只靠 `layers` 过滤挡不住「另一份 private」——群聊分层是 group，
 * 但主人私聊那条通道里 A 的私聊在数据库里也是 private。真正说得清「这一刻对面是谁」
 * 的只有 scope 本身，所以把 key 一起带上，让 store 在拼 SQL 前算白名单。
 */
export function audienceOf(key, ownerQQ, { rel = null } = {}) {
  const scope = canonicalScope(key);
  if (rel) return { rel, key: scope, ownerQQ: ownerQQ == null ? null : String(ownerQQ) };
  if (scope.startsWith('group:')) return { rel: 'group', key: scope, ownerQQ: ownerQQ == null ? null : String(ownerQQ) };
  if (scope.startsWith('private:')) {
    const qq = scope.slice('private:'.length);
    const owner = String(ownerQQ ?? '').replace(/^0+(?=\d)/, '');
    return { rel: owner && qq === owner ? 'owner' : 'friend', key: scope, ownerQQ: ownerQQ == null ? null : String(ownerQQ) };
  }
  return { rel: 'self', key: scope, ownerQQ: ownerQQ == null ? null : String(ownerQQ) };
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * 建一个挂在桥接进程里的记忆门面。root 是 qq-bridge 根目录（库默认在 <root>/state/memory.db）。
 * 参数 ownerQQOf 传函数而不是值：配置是异步加载完的，取主人在调用时才发生。
 */
export function createLiveMemory({
  root,
  file,
  ownerQQOf,
  logger,
  now = () => Date.now(),
  extractLimit = 30,
  extractWindowMs = 3600000,
  minScore = 0.35,
  warnIntervalMs = 60000,
  ollamaUrl,
  ollamaModel,
  embedTimeoutMs = 4000,
  // 把 scope 翻成人能看懂的名字（桥接传 people.label）。没传就退化成「私聊 3482501440」。
  describeScope = null,
} = {}) {
  if (!root) throw new Error('createLiveMemory 需要 root');
  const rootDir = path.resolve(String(root));
  const dbFile = file ? path.resolve(String(file)) : path.join(rootDir, 'state', 'memory.db');
  let store = null;
  let failure = null;
  let lastWarnAt = 0;
  // 向量通道：hash-v1 永远在（同步）；ollama 的语义向量有就更好、没有也不挡路。
  const embedder = createEmbedder({
    ollamaUrl: ollamaUrl ?? process.env.QQB_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    ollamaModel: ollamaModel === undefined ? (process.env.QQB_EMBED_MODEL ?? 'bge-m3') : ollamaModel,
    timeoutMs: embedTimeoutMs,
    logger,
  });
  let semanticFailedAt = 0;

  function scopeLabel(scope) {
    const raw = String(scope ?? '');
    if (!raw) return '记忆库';
    if (typeof describeScope === 'function') {
      try {
        const text = String(describeScope(raw) ?? '').trim();
        if (text) return text.replace(/（[^）]*）s*$/, '');
      } catch { /* 标签翻不出来不挡检索 */ }
    }
    const [kind, id] = raw.split(':');
    return kind === 'group' ? `群聊 ${id}` : kind === 'private' ? `私聊 ${id}` : kind === 'global' ? '全局' : raw;
  }

  function warn(message, detail) {
    const ts = now();
    if (ts - lastWarnAt < warnIntervalMs) return;
    lastWarnAt = ts;
    try {
      logger?.warn?.(message, detail);
    } catch {
      /* 日志本身出错就算了：这里绝不能再抛 */
    }
  }

  function open() {
    if (store) return store;
    if (failure) return null;
    try {
      store = openStore({ root: rootDir, file: dbFile, logger, now, extractLimit, extractWindowMs });
      return store;
    } catch (err) {
      failure = err;
      warn('长期记忆库打不开，本次降级为无长期记忆', { error: String(err?.message ?? err), file: dbFile });
      return null;
    }
  }

  function guard(name, fn, fallback) {
    try {
      return fn();
    } catch (err) {
      warn(`长期记忆操作失败：${name}`, { error: String(err?.message ?? err) });
      return fallback;
    }
  }

  function ownerQQ() {
    try {
      return canonicalScope(`private:${ownerQQOf?.() ?? ''}`).slice('private:'.length);
    } catch {
      return '';
    }
  }

  function resolveKind(category) {
    const cat = String(category ?? '').trim();
    if (CATEGORY_TO_KIND[cat]) return CATEGORY_TO_KIND[cat];
    return KINDS.includes(cat) ? cat : 'fact';
  }

  /**
   * 把某个库还缺的语义向量补上（多批、有限批）。Ollama 缺席时是空转，绝不抛。
   * 补完才查，否则「刚写进去的记忆搜不到」会让人以为向量没生效。
   */
  async function ensureSemanticVectors(kind, st, { batches = 2, batchSize = 24 } = {}) {
    if (!embedder.semantic) return { embedded: 0 };
    let embedded = 0;
    try {
      for (let round = 0; round < batches; round += 1) {
        const pending = st.vectors.pending({ kind, model: embedder.semantic.id, limit: batchSize });
        if (!pending.length) break;
        const vectors = await embedder.semantic.embed(pending.map((row) => String(row.text ?? '')));
        for (let i = 0; i < pending.length; i += 1) {
          if (vectors[i]?.length) {
            st.vectors.set(kind, pending[i].id, embedder.semantic.id, vectors[i]);
            embedded += 1;
          }
        }
        if (pending.length < batchSize) break;
      }
    } catch (err) {
      warn('语义向量补建失败（这批先走 hash-v1）', { kind, error: String(err?.message ?? err) });
    }
    return { embedded };
  }

  return {
    version: VERSION,
    path: dbFile,

    /** 记忆库是否可用（首次调用才会真正打开文件）。 */
    available() {
      return Boolean(open());
    },
    /** 打不开时的错误信息，便于健康检查展示。 */
    error() {
      open();
      return failure ? String(failure?.message ?? failure) : null;
    },

    /**
     * 把一条 social-v2 记忆镜像进长期库。
     * 返回 { action: inserted|merged|revived|rejected, ... }；库不可用时返回 null。
     */
    /**
     * §1 原文底账（L2）：每句原始消息都留一份，**只给巩固/做梦当素材，不参与召回**。
     * 召回那边默认把 L2 排除掉了（`includeOriginals` 才看得见），所以不怕多。
     * 同一句重复发按 hash 合并，桥接重放同一段时间不会把库撑爆。
     */
    recordOriginal({ key, role = 'user', text, at = null, subject = null } = {}) {
      return guard('recordOriginal', () => {
        const st = open();
        if (!st) return null;
        const body = String(text ?? '').trim();
        // 太短的（「嗯」「哈」）单独存一条没有信息量，还会把 L2 撑成噪声。
        if (body.length < 4) return null;
        const owner = ownerQQ();
        const who = role === 'assistant' || role === 'self' ? '小鲸鱼' : String(role || '对方');
        return st.remember({
          layer: layerForKey(key, owner),
          scope: canonicalScope(key),
          kind: 'message',
          memLevel: 'L2',
          // 回填历史时能把「谁说的」带上（群里的 🍇、私聊里的爸爸），面板才看得懂。
          subject: String(subject ?? '').trim() || who,
          text: body.slice(0, 500),
          emotion: emotionFromText(body),
          // 原文的重要度压到最低：它只在巩固时被读，永远不该靠权重挤进提示词。
          importance: 0.2,
          confidence: 0.9,
          source: 'origin-log',
          // 回填历史时把原始时间带进库里，时间轴才不是「全都发生在此刻」。
          at: Number(at) || null,
          meta: { role: String(role ?? ''), at: Number(at) || null },
        });
      }, null);
    },

    rememberSocialEvent({ key, category, content, extra, source = 'bridge-social', importance, emotion } = {}) {
      return guard('rememberSocialEvent', () => {
        const st = open();
        if (!st) return null;
        const text = String(content ?? '').trim();
        if (!text) return { action: 'rejected', reason: '内容为空' };
        const kind = resolveKind(category);
        const owner = ownerQQ();
        const layer = layerForKey(key, owner);
        const subject = String(extra?.target ?? '').trim() || null;
        // 情绪：调用方给（当前心情 + 文本信号）优先，没给就按文本里的情绪字眼估一个。
        const moodWeight = Number.isFinite(emotion) ? Math.min(1, Math.max(0, emotion)) : emotionFromText(text);
        return st.remember({
          layer,
          scope: canonicalScope(key),
          kind,
          subject,
          text,
          emotion: moodWeight,
          importance: Number.isFinite(importance) ? importance : (KIND_IMPORTANCE[kind] ?? 0.5),
          confidence: 0.7,
          source,
          evidence: extra?.evidence ? String(extra.evidence) : null,
          meta: { category: String(category ?? ''), extra: extra && typeof extra === 'object' ? extra : null },
        });
      }, null);
    },

    /**
     * 删掉跟 (key, category, content/target) 对得上的长期记忆（软删除）。
     * content 为空时按 target 找（群友印象的删除路径就是这种）。
     */
    forgetSocialEvent({ key, category, content, extra } = {}) {
      return guard('forgetSocialEvent', () => {
        const st = open();
        if (!st) return 0;
        const owner = ownerQQ();
        const scope = canonicalScope(key);
        const layers = layersForSession(key, owner);
        const kind = category ? resolveKind(category) : null;
        const needle = String(content ?? '').trim() || String(extra?.target ?? '').trim();
        const rows = st.recall({ scope, layers, kinds: kind ? [kind] : null, query: needle, limit: 50, markUsed: false });
        const target = needle ? needle.replace(/\s+/g, ' ').trim() : '';
        let removed = 0;
        for (const row of rows) {
          if (target) {
            const sameText = String(row.text ?? '').replace(/\s+/g, ' ').trim() === target;
            const sameSubject = row.subject && String(row.subject).trim() === target;
            if (!sameText && !sameSubject) continue;
          }
          if (st.forget(row.id, { reason: 'social-v2 记忆被删除' })) removed += 1;
        }
        return removed;
      }, 0);
    },

    /** 清空某个会话（可限定类别）的长期记忆，对应 qq_memory_clear。 */
    clearScope(key, { category } = {}) {
      return guard('clearScope', () => {
        const st = open();
        if (!st) return 0;
        const scope = canonicalScope(key);
        const kind = category && category !== 'all' ? resolveKind(category) : null;
        const rows = st.exportAll({ scope });
        let removed = 0;
        for (const row of rows) {
          if (kind && row.kind !== kind) continue;
          if (st.forget(row.id, { reason: '会话长期记忆被清空' })) removed += 1;
        }
        return removed;
      }, 0);
    },

    /**
     * 组装要注入提示词的长期记忆块。没有记忆时返回空串（调用方直接当空行处理）。
     * query 传最近消息片段时按相关性召回，不传则按重要度+新鲜度召回。
     */
    block({ key, query, limit = 6, maxChars = DEFAULT_MAX_CHARS, lineChars = DEFAULT_LINE_CHARS } = {}) {
      return guard('block', () => {
        const st = open();
        if (!st) return '';
        const owner = ownerQQ();
        const queryText = String(query ?? '').trim();
        const rows = st.recall({
          scope: canonicalScope(key),
          layers: layersForSession(key, owner),
          // P1 硬过滤：这一刻对面是谁，只看得见「他和她的」+ global（外加主动分享出去的 scope）。
          audience: audienceOf(key, owner),
          query: queryText,
          limit: Math.max(limit * 4, 24),
          minScore: 0,
          // 同步路径只有 hash-v1（提示词组装是同步的，不能等 Ollama）。
          vector: queryText ? hashVector(queryText) : null,
          vectorModel: HASH_MODEL,
        });
        if (!rows.length) return '';
        // 重量级的分往前站（主人 2026-10-25：「权重高的放越醒目的位置」）：
        // weight 是「重要度 × 遗忘曲线保留率」，vivid 的先说、faint 的垫后；
        // deep（快忘了）平时不自己冒进提示词，除非这次的话正好沾边——
        // 字面命中或余弦够近，那说明「她这会儿真想起来了」。
        const relevant = (row) => (row.match ?? 0) >= 0.6 || (row.vector ?? 0) >= 0.35;
        const strong = rows.filter((row) => row.weight >= PROMPT_WEIGHT_FLOOR || relevant(row));
        const picked = (strong.length ? strong : rows)
          .sort((a, b) => b.weight - a.weight || b.score - a.score)
          .slice(0, limit);
        const head = '【记得的事】以下是你跨会话记住的（越靠前记得越清楚，越靠后越模糊；不是刚发生的新消息，别当成对方刚说的）。'
          + '带「索引」的是很久以前、只记得个大概的事——需要细节就调 qq_memory_detail 去翻原文；'
          + '带「来源」的来自别的会话，别把别人的话当成眼前这个人的：';
        const here = canonicalScope(key);
        const lines = picked.map((row) => {
          const label = KIND_LABEL[row.kind] ?? row.kind;
          const subject = row.subject ? `${clip(row.subject, 16)}：` : '';
          // 冷数据只给一句话索引（时间+人物+核心事件+当时情绪），原文留在库里按需拉取。
          const cold = row.tier === 'cold';
          const body = cold ? (row.card || clip(row.text, 60)) : clip(row.text, lineChars);
          const from = row.scope && row.scope !== here && row.scope !== 'global' ? `（来源：${scopeLabel(row.scope)}）` : '';
          return `- （${label}${cold ? '·索引' : ''}）${subject}${body}${from}`;
        });
        return clip([head, ...lines].join('\n'), maxChars);
      }, '');
    },

    /**
     * 索引卡（L5，PANDORA_SPEC §8）：每条长记忆一张 ≤50 字的卡（时间/人物/起因/结果/情绪）。
     * 提示词里只放最近的几张，给模型一个「她脑子里挂着的事」的索引，正文仍靠 block()。
     */
    cards({ limit = 5 } = {}) {
      return guard('cards', () => {
        const st = open();
        if (!st || typeof st.listMemoriesForPanel !== 'function') return [];
        const r = st.listMemoriesForPanel({ levels: ['L5'], limit: Math.max(1, Math.min(20, Number(limit) || 5)) });
        return (r?.items ?? []).filter((it) => String(it.text ?? '').trim());
      }, []);
    },

    /**
     * 触景生情（§6）：这句话里提到的具体东西（草莓、下雨天、某个地名）如果记忆里出现过，
     * 直接把 L3/L4 拉出来——不走向量相似度，走实体倒排。命中的是「真提过」，不是「看起来像」。
     */
    flash({ key, text, limit = 3 } = {}) {
      return guard('flash', () => {
        const st = open();
        if (!st || typeof st.searchByEntities !== 'function') return [];
        const owner = ownerQQ();
        const entities = typeof entitiesOf === 'function' ? entitiesOf(String(text ?? '')) : [];
        if (!Array.isArray(entities) || !entities.length) return [];
        const rows = st.searchByEntities({ entities, audience: audienceOf(key, owner), limit: Math.max(1, Math.min(10, Number(limit) || 3)) });
        return (rows ?? []).map((row) => ({
          id: row.id,
          kind: row.kind,
          subject: row.subject ?? null,
          text: row.text,
          scope: row.scope,
          matched: row.matched ?? null,
        }));
      }, []);
    },

    /**
     * 结构化召回，给 `qq_memory_query` 这类「要能看出记了什么」的场景用
     * （`block()` 是给人看的提示词片段，这里是给模型/控制台看的数据）。
     */
    recall({ key, query, limit = 12, kinds, includeOriginals = false } = {}) {
      return guard('recall', () => {
        const st = open();
        if (!st) return [];
        const owner = ownerQQ();
        const queryText = String(query ?? '').trim();
        const rows = st.recall({
          scope: canonicalScope(key),
          layers: layersForSession(key, owner),
          audience: audienceOf(key, owner),
          kinds: Array.isArray(kinds) && kinds.length ? kinds : null,
          // 默认不吐 L2 原文（每句话都算记忆会把真正的事实挤掉）；排障/面板要看原文才置 true。
          includeOriginals: includeOriginals === true,
          query: queryText,
          limit,
          minScore: 0,
          markUsed: false,
          vector: queryText ? hashVector(queryText) : null,
          vectorModel: HASH_MODEL,
        });
        return rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          layer: row.layer,
          subject: row.subject ?? null,
          text: row.text,
          score: row.score,
          importance: row.importance,
          source: row.source,
          updatedAt: row.updatedAt ?? row.updated_at ?? null,
          useCount: row.useCount ?? row.use_count ?? 0,
          // 遗忘曲线把「此刻还记得多清楚」摊开给调用方（控制台/排障看得到深浅）。
          weight: row.weight,
          retention: row.retention,
          depth: row.depth,
          emotion: row.emotion,
          vector: row.vector ?? null,
          tier: row.tier ?? 'hot',
          card: row.card ?? null,
          sourceLabel: scopeLabel(row.scope),
        }));
      }, []);
    },

    /** 按 id 拉全文（含 L2 原文）——「索引不够、想回忆细节」时她主动调的那一下。 */
    detail({ id } = {}) {
      return guard('detail', () => {
        const st = open();
        const num = Number(id);
        if (!st || !Number.isFinite(num)) return null;
        const row = st.get(num);
        if (!row) return null;
        return {
          id: row.id,
          scope: row.scope,
          sourceLabel: scopeLabel(row.scope),
          kind: row.kind,
          layer: row.layer,
          memLevel: row.memLevel ?? null,
          subject: row.subject ?? null,
          text: row.text,
          sensory: row.sensory ?? null,
          subtext: row.subtext ?? null,
          createdAt: row.createdAt ?? row.created_at ?? null,
          emotion: row.emotion,
          importance: row.importance,
          weight: row.weight,
          card: row.card ?? null,
          tier: row.tier ?? 'hot',
        };
      }, null);
    },

    /** 冷热迁移（桥接每 6 小时跑一次；面板也能手动触发）。 */
    retier(options = {}) {
      return guard('retier', () => {
        const st = open();
        return st && typeof st.retier === 'function' ? st.retier(options) : { hot: 0, cold: 0 };
      }, { hot: 0, cold: 0 });
    },

    tierStats() {
      return guard('tierStats', () => {
        const st = open();
        return st && typeof st.tierStats === 'function' ? st.tierStats() : { hot: 0, cold: 0 };
      }, { hot: 0, cold: 0 });
    },

    /**
     * 跨会话召回：不限定 scope，整个库都查（结果带 scope，调用方再翻成人名）。
     *
     * 用途只有一个 —— 她自己主动检索（`qq_memory_search`）。提示词注入仍然走 `block()`
     * 的分层视角，所以「她脑子里时刻装着全库」不会发生：想知道谁那边的事，就去查一次。
     */
    recallAcrossScopes({ query, limit = 12, kinds } = {}) {
      return guard('recallAcrossScopes', () => {
        const st = open();
        if (!st) return [];
        const queryText = String(query ?? '').trim();
        const rows = st.recall({
          allScopes: true,
          kinds: Array.isArray(kinds) && kinds.length ? kinds : null,
          query: queryText,
          limit,
          minScore: 0,
          markUsed: false,
          vector: queryText ? hashVector(queryText) : null,
          vectorModel: HASH_MODEL,
        });
        return rows.map((row) => ({
          id: row.id,
          scope: row.scope,
          kind: row.kind,
          layer: row.layer,
          subject: row.subject ?? null,
          text: row.text,
          score: row.score,
          importance: row.importance,
          source: row.source,
          updatedAt: row.updated_at ?? null,
          weight: row.weight,
          retention: row.retention,
          depth: row.depth,
          emotion: row.emotion,
          vector: row.vector ?? null,
          tier: row.tier ?? 'hot',
          card: row.card ?? null,
          sourceLabel: scopeLabel(row.scope),
        }));
      }, []);
    },

    /**
     * 统一的检索入口（异步，RAG）：记忆与知识都走这里。
     * 优先用本机 Ollama 的语义向量；模型没装/服务没起/超时 → 退回 hash-v1，结果照样给。
     * 它不参与提示词拼装（那条路是同步的），只给「她自己主动查」和控制台排障用。
     */
    async search({ kind = 'memory', query, limit = 12, kinds, scope = null, markUsed = true, includeOriginals = true } = {}) {
      const st = open();
      if (!st) return { results: [], model: HASH_MODEL, semantic: false, embedded: 0 };
      const text = String(query ?? '').trim();
      let model = HASH_MODEL;
      let vector = text ? hashVector(text) : null;
      let semantic = false;
      let embedded = 0;
      if (embedder.semantic && text) {
        try {
          if (await embedder.semanticReady()) {
            embedded = (await ensureSemanticVectors(kind, st, { batches: 2 })).embedded;
            const [vec] = await embedder.semantic.embed([text]);
            if (vec?.length) {
              vector = vec;
              model = embedder.semantic.id;
              semantic = true;
            }
          }
        } catch (err) {
          const ts = now();
          if (ts - semanticFailedAt > warnIntervalMs) {
            semanticFailedAt = ts;
            warn('语义向量不可用，本次退回 hash-v1', { error: String(err?.message ?? err) });
          }
        }
      }
      if (kind === 'knowledge') {
        const rows = st.knowledge.search({ query: text, limit, scope, markUsed, vector, vectorModel: model });
        return { results: rows, model, semantic, embedded };
      }
      const rows = st.recall({
        ...(scope ? { scope } : { allScopes: true }),
        // 2026-10-30：她主动查的时候要把 L2 原话算进来。不然「北边玩」这种只进过原文、还没被巩固成情节的事，
        // 在群里问就查不到（主人复现的就是这一条）。提示词注入那条路（block()）仍然排除 L2。
        includeOriginals: includeOriginals === true,
        kinds: Array.isArray(kinds) && kinds.length ? kinds : null,
        query: text,
        limit,
        minScore: 0,
        markUsed,
        vector,
        vectorModel: model,
      });
      return { results: rows, model, semantic, embedded };
    },

    /** 写一条知识。走同一份 store，哈希向量与内存缓存立刻一致（另开连接的写会让 cache 变旧）。 */
    knowledgeAdd(entry = {}) {
      return guard('knowledgeAdd', () => {
        const st = open();
        if (!st) return { action: 'rejected', reason: '知识库不可用' };
        return st.knowledge.add(entry);
      }, { action: 'rejected', reason: '知识库不可用' });
    },

    /** 知识库概况（条数/最老/最新），给健康检查用。 */
    knowledgeStats() {
      return guard('knowledgeStats', () => {
        const st = open();
        return st ? st.knowledge.stats() : null;
      }, null);
    },

    /** 向量索引状态：覆盖了多少、有哪些模型、语义通道通不通。 */
    vectors() {
      return guard('vectors', () => {
        const st = open();
        const base = st ? st.vectors.stats() : { models: [], coverage: { memory: 0, knowledge: 0 } };
        return { ...base, hash: HASH_MODEL, semantic: embedder.semantic?.id ?? null };
      }, { models: [], coverage: { memory: 0, knowledge: 0 }, hash: HASH_MODEL, semantic: null });
    },

    /** 启动/定时预热：本机 Ollama 有嵌入模型时，把缺的语义向量多补几批（不阻塞任何事）。 */
    async warmVectors({ batches = 10, batchSize = 32 } = {}) {
      const out = { ready: false, model: embedder.semantic?.id ?? null, memory: 0, knowledge: 0 };
      const st = open();
      if (!st) return out;
      try {
        out.ready = await embedder.semanticReady();
        if (!out.ready) return out;
        out.memory = (await ensureSemanticVectors('memory', st, { batches, batchSize })).embedded;
        out.knowledge = (await ensureSemanticVectors('knowledge', st, { batches, batchSize })).embedded;
      } catch (err) {
        warn('语义向量预热失败（不影响检索）', { error: String(err?.message ?? err) });
      }
      return out;
    },

    /** 语义通道探一下（控制台健康检查/排障用）。 */
    async embedderReady() {
      try {
        return { semantic: Boolean(embedder.semantic), ready: await embedder.semanticReady(), model: embedder.semantic?.id ?? null };
      } catch {
        return { semantic: Boolean(embedder.semantic), ready: false, model: embedder.semantic?.id ?? null };
      }
    },

    /** 库的统计信息，给健康检查与 /api/status 用。 */
    stats() {
      return guard('stats', () => {
        const st = open();
        return st ? st.stats() : null;
      }, null);
    },

    /**
     * 给 R1b 人设演化用的接口：读记忆原文（只读）+ 写人设审计。
     * 单独开一个口子，是因为 evolve.mjs 不该知道 SQLite 的存在，也不该拿到整个 store。
     */
    evolveStore() {
      return {
        exportAll: (opts = {}) => guard('evolveExport', () => {
          const st = open();
          return st ? st.exportAll(opts) : [];
        }, []),
        persona: {
          record: (row) => guard('evolveAudit', () => {
            const st = open();
            return st ? st.persona.record(row) : null;
          }, null),
          list: ({ limit = 20 } = {}) => guard('evolveAuditList', () => {
            const st = open();
            return st ? st.persona.list({ limit }) : [];
          }, []),
          lastApplied: () => guard('evolveAuditLast', () => {
            const st = open();
            return st ? st.persona.lastApplied() : null;
          }, null),
        },
      };
    },

    close() {
      return guard('close', () => {
        store?.close?.();
        store = null;
        return true;
      }, false);
    },
  };
}