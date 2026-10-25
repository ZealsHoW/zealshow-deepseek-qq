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

export const VERSION = '0.1.0';

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
} = {}) {
  if (!root) throw new Error('createLiveMemory 需要 root');
  const rootDir = path.resolve(String(root));
  const dbFile = file ? path.resolve(String(file)) : path.join(rootDir, 'state', 'memory.db');
  let store = null;
  let failure = null;
  let lastWarnAt = 0;

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
    rememberSocialEvent({ key, category, content, extra, source = 'bridge-social', importance } = {}) {
      return guard('rememberSocialEvent', () => {
        const st = open();
        if (!st) return null;
        const text = String(content ?? '').trim();
        if (!text) return { action: 'rejected', reason: '内容为空' };
        const kind = resolveKind(category);
        const owner = ownerQQ();
        const layer = layerForKey(key, owner);
        const subject = String(extra?.target ?? '').trim() || null;
        return st.remember({
          layer,
          scope: canonicalScope(key),
          kind,
          subject,
          text,
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
        const rows = st.recall({
          scope: canonicalScope(key),
          layers: layersForSession(key, owner),
          query,
          limit,
          minScore,
        });
        if (!rows.length) return '';
        const head = '【记得的事】以下是你跨会话记住的（不是刚发生的新消息，别当成对方刚说的）：';
        const lines = rows.map((row) => {
          const label = KIND_LABEL[row.kind] ?? row.kind;
          const subject = row.subject ? `${clip(row.subject, 16)}：` : '';
          return `- （${label}）${subject}${clip(row.text, lineChars)}`;
        });
        return clip([head, ...lines].join('\n'), maxChars);
      }, '');
    },

    /**
     * 结构化召回，给 `qq_memory_query` 这类「要能看出记了什么」的场景用
     * （`block()` 是给人看的提示词片段，这里是给模型/控制台看的数据）。
     */
    recall({ key, query, limit = 12, kinds } = {}) {
      return guard('recall', () => {
        const st = open();
        if (!st) return [];
        const owner = ownerQQ();
        const rows = st.recall({
          scope: canonicalScope(key),
          layers: layersForSession(key, owner),
          kinds: Array.isArray(kinds) && kinds.length ? kinds : null,
          query,
          limit,
          markUsed: false,
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
        }));
      }, []);
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
        const rows = st.recall({
          allScopes: true,
          kinds: Array.isArray(kinds) && kinds.length ? kinds : null,
          query,
          limit,
          markUsed: false,
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
        }));
      }, []);
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