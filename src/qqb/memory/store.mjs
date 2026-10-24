// 记忆库（R1）：小鲸鱼自己的长期记忆，落在 `state/memory.db`（SQLite）。
//
// 为什么是 SQLite：Node 内置 `node:sqlite`（本机 v24，无需三方依赖），单文件可拷可查可导出，
// 备份/回滚跟着 state 一起走。设计取舍：
//   · **分层**：private（只属于某个私聊对象）/ normal（一般对话）/ group（群聊公开）。
//     召回时按 scope 过滤，群聊里永远召不到 private 记忆 —— 这是硬边界，不是提示词约束。
//   · **重复事实合并**（不再长成一堆近义条目）：按 (layer|scope|kind|归一化文本) 的哈希去重，
//     命中就把 use_count/importance/updated_at 合并，并在 merges 表留痕。
//   · **节流**：`source='llm-extract'` 的写入要先过 budgets 配额（默认 30 条/小时/scope），
//     超额直接 rejected —— 省 token 的开关在这里，而不是在提示词里求模型少写。
//   · **人设演变审计**（R1b）：persona_audit 表记录「改了什么、为什么、依据哪句话、是否已应用」，
//     回滚只需要按 rollback_of 指回去。
//   · 删除是软删除（deleted_at），召回默认不返回；真删要走 export + vacuum。
//   · **归档**（0.1.1，R1「旧记忆定期归档」）：长期没人用、重要性又低的老条目打上
//     `archived_at` 就不再进召回（避免唤醒提示被陈年废话占满），但数据还在库里、
//     可以 exportAll/backupTo 捞出；同一条事实日后又被提起时会被合并并自动「复活」。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.1';

/** 记忆分层。private 只在对应会话内可见，group 可在群内共享，normal 为一般对话。 */
export const LAYERS = Object.freeze(['private', 'normal', 'group']);
export const KINDS = Object.freeze(['fact', 'topic', 'impression', 'diary', 'preference', 'event', 'promise']);
export const MAX_TEXT = 2000;

const DEFAULT_EXTRACT_LIMIT = 30;
const DEFAULT_EXTRACT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function nowMs(now) {
  const value = now();
  return value instanceof Date ? value.getTime() : Number(value);
}

function normalizeText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hashOf(layer, scope, kind, norm) {
  return crypto.createHash('sha1').update(`${layer}|${scope}|${kind}|${norm}`).digest('hex');
}

function clamp01(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

/**
 * @param {{root: string, file?: string, logger?: any, now?: () => number|Date,
 *          extractLimit?: number, extractWindowMs?: number}} options
 */
export function openStore(options = {}) {
  const root = options.root;
  if (!root) throw new Error('openStore 需要 root');
  const logger = options.logger ?? null;
  const now = options.now ?? (() => Date.now());
  const file = options.file ?? path.join(root, 'state', 'memory.db');
  const extractLimit = Number.isFinite(options.extractLimit) ? options.extractLimit : DEFAULT_EXTRACT_LIMIT;
  const extractWindowMs = Number.isFinite(options.extractWindowMs) ? options.extractWindowMs : DEFAULT_EXTRACT_WINDOW_MS;

  fs.mkdirSync(path.dirname(file), { recursive: true });

  // 用 process.getBuiltinModule 而不是静态 import：node:sqlite 在 Node 22.5~23.3
  // 需要 --experimental-sqlite，静态 import 会让整个模块在旧 Node 上连加载都失败。
  // 这样写可以在旧 Node 上给出一句能照做的提示，而不是 ERR_UNKNOWN_BUILTIN_MODULE。
  let sqlite = null;
  try {
    sqlite = globalThis.process?.getBuiltinModule?.('node:sqlite') ?? null;
  } catch {
    sqlite = null;
  }
  if (!sqlite?.DatabaseSync) {
    throw new Error('node:sqlite 不可用：请用 Node >= 23.4 启动（本机 v24 已内置；22.x 需 --experimental-sqlite）');
  }

  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layer TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT,
      text TEXT NOT NULL,
      norm TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      importance REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 0.6,
      source TEXT,
      evidence TEXT,
      meta TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      deleted_at INTEGER,
      archived_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, layer, kind);
    CREATE INDEX IF NOT EXISTS idx_memories_recent ON memories(updated_at DESC);
    CREATE TABLE IF NOT EXISTS merges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kept_id INTEGER NOT NULL,
      incoming_text TEXT NOT NULL,
      reason TEXT,
      evidence TEXT
    );
    CREATE TABLE IF NOT EXISTS persona_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      field TEXT,
      before TEXT,
      after TEXT,
      reason TEXT,
      evidence TEXT,
      actor TEXT,
      applied INTEGER NOT NULL DEFAULT 0,
      rollback_of INTEGER
    );
    CREATE TABLE IF NOT EXISTS budgets (
      key TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
  `);
  // 检索索引（R1「具体提到某件事就去库里查」）：FTS5 + **trigram** 分词器。
  // 必须用 trigram —— 默认的 unicode61 按词切分，中文整句会被当成一个长词，
  // 「她说过什么关于演唱会的事」这种子串检索等于没有索引，只能全表 LIKE 扫。
  // external content 表：索引只存倒排表，正文仍在 memories 里，不复制一份数据。
  // 老库（已有 158 条）上触发器是新建的，索引是空的 —— 下面按行数差做一次 rebuild。
  //
  // 坑（2026-10-24 实测）：`SELECT COUNT(*) FROM memories_fts` 在 **external content** 表上
  // 查的是内容表（memories），永远等于 memories 的行数 —— 拿它当「索引完不完整」的判据永远为真，
  // 老库升级上来时索引其实是空的，检索会静默回落 LIKE（还以为是索引在跑）。真正建了索引的
  // 文档数在 FTS5 的影子表 `memories_fts_docsize` 里（一篇一行），重建后用 MATCH 也才查得到。
  function indexedDocCount(table) {
    try {
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}_docsize`).get().n);
    } catch {
      return null; // 影子表不在（运行时禁了 columnsize）：交给调用方决定
    }
  }
  let ftsReady = false;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text, norm, subject, content='memories', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, text, norm, subject) VALUES (new.id, new.text, new.norm, COALESCE(new.subject, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, norm, subject) VALUES ('delete', old.id, old.text, old.norm, COALESCE(old.subject, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, norm, subject) VALUES ('delete', old.id, old.text, old.norm, COALESCE(old.subject, ''));
        INSERT INTO memories_fts(rowid, text, norm, subject) VALUES (new.id, new.text, new.norm, COALESCE(new.subject, ''));
      END;
    `);
    ftsReady = true;
  } catch (error) {
    // 老 SQLite / 未编 FTS5 的运行时：不装索引也能跑，检索回落 LIKE。
    logger?.warn?.('记忆全文索引不可用（回落 LIKE 检索）', { error: String(error?.message ?? error) });
  }
  if (ftsReady) {
    try {
      const contentRows = Number(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n);
      const indexRows = indexedDocCount('memories_fts');
      if (indexRows === null || contentRows !== indexRows) {
        db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
        logger?.info?.('记忆全文索引已重建', { rows: contentRows });
      }
    } catch (error) {
      logger?.warn?.('记忆全文索引重建失败（回落 LIKE 检索）', { error: String(error?.message ?? error) });
      ftsReady = false;
    }
  }

  // 知识库（R6）：她「在外面看到的、学到的、总结出来的」都落这张表。
  // 与 memories 分开的理由不是技术上的，是语义上的：记忆是「关于我们的事」，知识是「关于世界的事」，
  // 混在一张表里迟早会被同一套召回打分搅在一起（知识不该按「谁说的」分层，记忆必须分层）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'global',
      title TEXT,
      text TEXT NOT NULL,
      norm TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE,
      source TEXT,
      url TEXT,
      tags TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      use_count INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_recent ON knowledge(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_scope ON knowledge(scope, updated_at DESC);
  `);
  let knowledgeFtsReady = false;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        title, text, tags, content='knowledge', content_rowid='id', tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS knowledge_fts_ai AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts(rowid, title, text, tags) VALUES (new.id, COALESCE(new.title, ''), new.text, COALESCE(new.tags, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_fts_ad AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, text, tags) VALUES ('delete', old.id, COALESCE(old.title, ''), old.text, COALESCE(old.tags, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_fts_au AFTER UPDATE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, text, tags) VALUES ('delete', old.id, COALESCE(old.title, ''), old.text, COALESCE(old.tags, ''));
        INSERT INTO knowledge_fts(rowid, title, text, tags) VALUES (new.id, COALESCE(new.title, ''), new.text, COALESCE(new.tags, ''));
      END;
    `);
    knowledgeFtsReady = true;
    const contentRows = Number(db.prepare('SELECT COUNT(*) AS n FROM knowledge').get().n);
    const indexRows = indexedDocCount('knowledge_fts');
    if (indexRows === null || contentRows !== indexRows) db.exec("INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')");
  } catch (error) {
    logger?.warn?.('知识库全文索引不可用（回落 LIKE 检索）', { error: String(error?.message ?? error) });
    knowledgeFtsReady = false;
  }

  // schema v2：memories 增加 archived_at（R1 旧记忆归档）。旧库就地补列：ADD COLUMN
  // 只改表头、不重写已有数据，7 条真实记忆的库上是毫秒级的操作。
  const columns = db.prepare('PRAGMA table_info(memories)').all().map((row) => String(row.name));
  if (!columns.includes('archived_at')) db.exec('ALTER TABLE memories ADD COLUMN archived_at INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_archive ON memories(archived_at, updated_at)');
  db.prepare('INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)').run('schema_version', '2');
  db.prepare('UPDATE schema_meta SET value = ? WHERE key = ? AND CAST(value AS INTEGER) < ?').run('2', 'schema_version', 2);
  db.prepare('INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)').run('created_at', String(nowMs(now)));

  const statements = {
    byHash: db.prepare('SELECT * FROM memories WHERE hash = ?'),
    insert: db.prepare(`INSERT INTO memories
      (layer, scope, kind, subject, text, norm, hash, importance, confidence, source, evidence, meta, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    // 又被提起就说明这条事实还活着：顺手清掉 archived_at（复活）。归档不是单向门。
    mergeTouch: db.prepare('UPDATE memories SET use_count = use_count + 1, updated_at = ?, importance = MAX(importance, ?), evidence = COALESCE(?, evidence), archived_at = NULL WHERE id = ?'),
    logMerge: db.prepare('INSERT INTO merges (ts, kept_id, incoming_text, reason, evidence) VALUES (?, ?, ?, ?, ?)'),
    byId: db.prepare('SELECT * FROM memories WHERE id = ?'),
    forget: db.prepare('UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
    touchUse: db.prepare('UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?'),
    countAll: db.prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL'),
    countArchived: db.prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND archived_at IS NOT NULL'),
    archiveMark: db.prepare('UPDATE memories SET archived_at = ? WHERE id = ? AND archived_at IS NULL'),
    budget: db.prepare('SELECT * FROM budgets WHERE key = ?'),
    budgetSet: db.prepare('INSERT INTO budgets (key, window_start, used) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, used = excluded.used'),
  };

  function rowToMemory(row) {
    if (!row) return null;
    let meta = null;
    if (row.meta) {
      try { meta = JSON.parse(row.meta); } catch { meta = { raw: row.meta }; }
    }
    return { ...row, meta };
  }

  function budgetConsume(key, limit, windowMs) {
    const ts = nowMs(now);
    const row = statements.budget.get(key);
    if (!row || ts - row.window_start >= windowMs) {
      statements.budgetSet.run(key, ts, 1);
      return { allowed: true, used: 1, limit, resetAt: ts + windowMs };
    }
    if (row.used >= limit) return { allowed: false, used: row.used, limit, resetAt: row.window_start + windowMs };
    statements.budgetSet.run(key, row.window_start, row.used + 1);
    return { allowed: true, used: row.used + 1, limit, resetAt: row.window_start + windowMs };
  }

  function remember(entry = {}) {
    const layer = String(entry.layer ?? 'normal');
    if (!LAYERS.includes(layer)) return { action: 'rejected', reason: `未知分层：${layer}` };
    const scope = String(entry.scope ?? 'global');
    const kind = String(entry.kind ?? 'fact');
    if (!KINDS.includes(kind)) return { action: 'rejected', reason: `未知类型：${kind}` };
    const raw = String(entry.text ?? '').trim();
    if (raw.length < 2) return { action: 'rejected', reason: '内容太短' };
    const text = raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) : raw;
    const norm = normalizeText(text);
    const hash = hashOf(layer, scope, kind, norm);
    const ts = nowMs(now);

    if (entry.source === 'llm-extract') {
      const budget = budgetConsume(`extract:${scope}`, extractLimit, extractWindowMs);
      if (!budget.allowed) {
        logger?.warn?.('记忆提炼配额用尽，本条丢弃', { scope, used: budget.used, limit: budget.limit });
        return { action: 'rejected', reason: `提炼配额用尽（${budget.limit}/窗口）`, resetAt: budget.resetAt };
      }
    }

    const existing = statements.byHash.get(hash);
    if (existing && !existing.deleted_at) {
      const importance = Math.max(existing.importance, clamp01(entry.importance, existing.importance));
      const evidence = entry.evidence && entry.evidence !== existing.evidence ? String(entry.evidence).slice(0, 2000) : null;
      statements.mergeTouch.run(ts, importance, evidence, existing.id);
      statements.logMerge.run(ts, existing.id, text, entry.mergeReason ?? '同一条事实重复写入', entry.evidence ?? null);
      return { action: 'merged', id: existing.id, useCount: existing.use_count + 1, importance };
    }
    if (existing?.deleted_at) {
      // 同一条事实被删过又想加回来：复活它，避免 id 无限膨胀。
      db.prepare('UPDATE memories SET deleted_at = NULL, archived_at = NULL, updated_at = ?, text = ?, evidence = COALESCE(?, evidence) WHERE id = ?')
        .run(ts, text, entry.evidence ?? null, existing.id);
      return { action: 'revived', id: existing.id };
    }

    const info = statements.insert.run(
      layer, scope, kind, entry.subject ? String(entry.subject) : null, text, norm, hash,
      clamp01(entry.importance, 0.5), clamp01(entry.confidence, 0.6),
      entry.source ? String(entry.source) : 'manual',
      entry.evidence ? String(entry.evidence).slice(0, 2000) : null,
      entry.meta ? JSON.stringify(entry.meta) : null,
      ts, ts,
      Number.isFinite(entry.expiresAt) ? entry.expiresAt : null,
    );
    return { action: 'inserted', id: Number(info.lastInsertRowid) };
  }

  // FTS5 的 MATCH 表达式：双引号包成短语（trigram 下等于「包含这段子串」），内部引号按
  // FTS5 规矩用两个双引号转义。少于 3 个字符时 trigram 一个词都切不出来，直接回落 LIKE。
  function ftsMatchExpr(needle) {
    return `"${String(needle).replace(/"/g, '""')}"`;
  }

  /**
   * 用全文索引拿一批候选 id。返回 null 表示「索引不可用/太短，调用方回落 LIKE」；
   * 返回空数组表示「索引确实查了，但没有一条命中」——两者对调用方含义不同。
   */
  function ftsIds(table, needle, limit = 400) {
    const ready = table === 'knowledge_fts' ? knowledgeFtsReady : ftsReady;
    if (!ready || !needle || needle.length < 3) return null;
    try {
      return db.prepare(`SELECT rowid AS id FROM ${table} WHERE ${table} MATCH ? ORDER BY rank LIMIT ?`)
        .all(ftsMatchExpr(needle), Math.max(1, Number(limit) || 400))
        .map((row) => Number(row.id));
    } catch (error) {
      logger?.warn?.('全文检索失败（本次回落 LIKE）', { table, error: String(error?.message ?? error) });
      return null;
    }
  }

  function recall(query = {}) {
    const ts = nowMs(now);
    const scope = query.scope ? String(query.scope) : null;
    const layers = query.layers ? query.layers.map(String) : null;
    const kinds = query.kinds ? query.kinds.map(String) : null;
    const limit = Number.isFinite(query.limit) ? Math.max(1, query.limit) : 10;
    const minScore = Number.isFinite(query.minScore) ? query.minScore : 0;
    const needle = normalizeText(query.query);

    const where = ['deleted_at IS NULL', 'archived_at IS NULL', '(expires_at IS NULL OR expires_at > ?)'];
    const params = [ts];
    if (scope) { where.push('(scope = ? OR scope = ?)'); params.push(scope, 'global'); }
    if (layers?.length) { where.push(`layer IN (${layers.map(() => '?').join(',')})`); params.push(...layers); }
    if (kinds?.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
    // 有关键词走全文索引（走索引才叫「检索」，老实现是全表 LIKE 扫 500 行再打分）；
    // 只有索引不可用或关键词太短（trigram 切不出词）时才回落 LIKE。
    if (needle) {
      const indexed = ftsIds('memories_fts', needle);
      if (indexed?.length) {
        where.push(`id IN (${indexed.map(() => '?').join(',')})`);
        params.push(...indexed);
      } else {
        where.push('(norm LIKE ? OR LOWER(COALESCE(subject, \'\')) LIKE ?)');
        params.push(`%${needle}%`, `%${needle}%`);
      }
    }

    const rows = db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 500`).all(...params);
    const tokens = needle ? needle.split(' ').filter((item) => item.length > 1) : [];
    const scored = rows.map((row) => {
      const age = Math.max(0, ts - row.updated_at);
      const recency = Math.exp(-age / DEFAULT_RECENT_WINDOW_MS);
      const usage = Math.min(1, row.use_count / 5);
      let match = needle ? 0.3 : 0.5;
      if (needle && row.norm.includes(needle)) match = 1;
      else if (tokens.length && tokens.some((token) => row.norm.includes(token))) match = 0.6;
      const score = 0.45 * row.importance + 0.25 * match + 0.2 * recency + 0.1 * usage;
      return { ...rowToMemory(row), score: Math.round(score * 10000) / 10000 };
    })
      .filter((item) => item.score >= minScore)
      .sort((a, b) => b.score - a.score || b.updated_at - a.updated_at)
      .slice(0, limit);

    if (query.markUsed !== false && scored.length) {
      for (const item of scored) statements.touchUse.run(ts, item.id);
    }
    return scored;
  }

  /** 最近的记忆（不分层过滤时按 scope 收敛：「我们最近在聊什么」比检索更常用）。 */
  function recentMemories(query = {}) {
    const scope = query.scope ? String(query.scope) : null;
    const layers = Array.isArray(query.layers) && query.layers.length ? query.layers.map(String) : null;
    const kinds = Array.isArray(query.kinds) && query.kinds.length ? query.kinds.map(String) : null;
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 8));
    const ts = nowMs(now);
    const where = ['deleted_at IS NULL', 'archived_at IS NULL', '(expires_at IS NULL OR expires_at > ?)'];
    const params = [ts];
    if (scope) { where.push('(scope = ? OR scope = ?)'); params.push(scope, 'global'); }
    if (layers) { where.push(`layer IN (${layers.map(() => '?').join(',')})`); params.push(...layers); }
    if (kinds) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
    return db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit)
      .map((row) => rowToMemory(row));
  }

  const KNOWLEDGE_TEXT_MAX = 4000;

  /** 把 tags（数组或字符串）归一成 JSON 数组字符串，方便 FTS 和展示两用。 */
  function tagsJsonOf(tags) {
    if (tags == null) return null;
    const list = (Array.isArray(tags) ? tags : String(tags).split(/[,，;；\s]+/))
      .map((item) => String(item ?? '').trim())
      .filter(Boolean)
      .slice(0, 20);
    return list.length ? JSON.stringify(list) : null;
  }

  function rowToKnowledge(row) {
    if (!row) return null;
    let tags = [];
    try { tags = row.tags ? JSON.parse(row.tags) : []; } catch { tags = []; }
    return {
      id: Number(row.id),
      scope: row.scope,
      title: row.title ?? null,
      text: row.text,
      source: row.source ?? null,
      url: row.url ?? null,
      tags,
      importance: row.importance,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      useCount: row.use_count,
    };
  }

  /**
   * 记一条知识。同 scope 下正文归一化后重复的，不新增行，只把 use_count/importance
   * 和来源合并上去（同一件事看到三遍说明它重要，而不是要存三份）。
   */
  function knowledgeAdd(entry = {}) {
    const ts = nowMs(now);
    const scope = String(entry.scope ?? 'global') || 'global';
    const text = String(entry.text ?? '').trim().slice(0, KNOWLEDGE_TEXT_MAX);
    if (!text) throw new Error('knowledgeAdd 需要 text');
    const title = entry.title ? String(entry.title).trim().slice(0, 200) : null;
    const norm = normalizeText(text);
    const hash = crypto.createHash('sha1').update(`${scope}|${norm}`).digest('hex');
    const importance = clamp01(entry.importance, 0.5);
    const source = entry.source ? String(entry.source).slice(0, 100) : null;
    const url = entry.url ? String(entry.url).slice(0, 2000) : null;
    const tags = tagsJsonOf(entry.tags);
    const existing = db.prepare('SELECT * FROM knowledge WHERE hash = ?').get(hash);
    if (existing) {
      db.prepare(`UPDATE knowledge SET use_count = use_count + 1, updated_at = ?,
        importance = MAX(importance, ?), source = COALESCE(?, source), url = COALESCE(?, url),
        tags = COALESCE(?, tags), title = COALESCE(?, title), deleted_at = NULL WHERE id = ?`)
        .run(ts, importance, source, url, tags, title, Number(existing.id));
      return { action: 'merged', id: Number(existing.id) };
    }
    const info = db.prepare(`INSERT INTO knowledge
      (scope, title, text, norm, hash, source, url, tags, importance, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(scope, title, text, norm, hash, source, url, tags, importance, ts, ts);
    return { action: 'inserted', id: Number(info.lastInsertRowid) };
  }

  /** 知识检索：有关键词走 FTS，没有就按重要性/新鲜度列最近的。 */
  function knowledgeSearch(query = {}) {
    const ts = nowMs(now);
    const scope = query.scope ? String(query.scope) : null;
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 10));
    const needle = normalizeText(query.query);
    const where = ['deleted_at IS NULL'];
    const params = [];
    if (scope && query.includeGlobal !== false) { where.push('(scope = ? OR scope = ?)'); params.push(scope, 'global'); }
    else if (scope) { where.push('scope = ?'); params.push(scope); }
    if (needle) {
      const indexed = ftsIds('knowledge_fts', needle);
      if (indexed?.length) {
        where.push(`id IN (${indexed.map(() => '?').join(',')})`);
        params.push(...indexed);
      } else {
        where.push('(norm LIKE ? OR LOWER(COALESCE(title, \'\')) LIKE ? OR LOWER(COALESCE(tags, \'\')) LIKE ?)');
        params.push(`%${needle}%`, `%${needle}%`, `%${needle}%`);
      }
    }
    const rows = db.prepare(`SELECT * FROM knowledge WHERE ${where.join(' AND ')} ORDER BY importance DESC, updated_at DESC LIMIT ?`)
      .all(...params, limit);
    if (query.markUsed !== false && rows.length) {
      const touch = db.prepare('UPDATE knowledge SET use_count = use_count + 1, updated_at = MAX(updated_at, ?) WHERE id = ?');
      for (const row of rows) touch.run(ts, Number(row.id));
    }
    return rows.map((row) => rowToKnowledge(row));
  }

  return {
    version: VERSION,
    path: file,
    remember,
    recall,
    recentMemories,
    knowledge: {
      add: knowledgeAdd,
      search: knowledgeSearch,
      recent({ scope = null, limit = 10 } = {}) { return knowledgeSearch({ scope, limit, markUsed: false }); },
      stats() {
        const total = Number(db.prepare('SELECT COUNT(*) AS n FROM knowledge WHERE deleted_at IS NULL').get().n);
        const row = db.prepare('SELECT MIN(created_at) AS oldest, MAX(updated_at) AS newest FROM knowledge WHERE deleted_at IS NULL').get();
        return { total, oldestAt: row?.oldest ?? null, newestAt: row?.newest ?? null };
      },
    },
    get(id) { return rowToMemory(statements.byId.get(Number(id))); },
    forget(id, { reason } = {}) {
      const ts = nowMs(now);
      const info = statements.forget.run(ts, Number(id));
      if (Number(info.changes) > 0) logger?.info?.('记忆已软删除', { id: Number(id), reason: reason ?? null });
      return Number(info.changes) > 0;
    },
    merges({ limit = 20 } = {}) {
      return db.prepare('SELECT * FROM merges ORDER BY id DESC LIMIT ?').all(limit);
    },
    /**
     * R1「旧记忆定期归档」：把长期没人用、重要性又低的老条目打上 archived_at，不再进召回。
     * 只打标记、不删数据（exportAll/backupTo 仍捞得出来），同一条事实日后又被提起会自动复活。
     * @param {{olderThanMs?: number, maxImportance?: number, maxUseCount?: number, limit?: number,
     *   dryRun?: boolean, exportTo?: string|null}} [options]
     */
    archiveOld({ olderThanMs = 30 * 24 * 60 * 60 * 1000, maxImportance = 0.45, maxUseCount = 0, limit = 200, dryRun = false, exportTo = null } = {}) {
      const ts = nowMs(now);
      const cut = ts - Math.max(0, Number(olderThanMs) || 0);
      const rows = db.prepare(`SELECT * FROM memories
        WHERE deleted_at IS NULL AND archived_at IS NULL AND updated_at < ? AND importance <= ? AND use_count <= ?
        ORDER BY updated_at ASC LIMIT ?`)
        .all(cut, clamp01(maxImportance, 0.45), Math.max(0, Number(maxUseCount) || 0), Math.max(1, Number(limit) || 200));
      const out = { dryRun: Boolean(dryRun), cutAt: cut, candidates: rows.length, archived: 0, file: null, ids: [] };
      if (!rows.length || dryRun) return out;
      if (exportTo) {
        // 先落盘再打标记：万一导出失败，宁可这一轮不归档，也不要「标记打了、原件却捞不回来」。
        const dest = path.resolve(String(exportTo));
        try {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const lines = rows.map((row) => JSON.stringify({ archivedAt: ts, ...rowToMemory(row) })).join('\n');
          fs.appendFileSync(dest, `${lines}\n`);
          out.file = dest;
        } catch (error) {
          logger?.warn?.('归档导出失败，本轮不改动记忆', { error: String(error?.message ?? error) });
          return { ...out, error: String(error?.message ?? error) };
        }
      }
      for (const row of rows) {
        const info = statements.archiveMark.run(ts, Number(row.id));
        if (Number(info.changes) > 0) { out.archived += 1; out.ids.push(Number(row.id)); }
      }
      if (out.archived) logger?.info?.('旧记忆已归档', { count: out.archived, cutAt: cut, file: out.file });
      return out;
    },
    stats() {
      const byLayer = db.prepare('SELECT layer, COUNT(*) AS n FROM memories WHERE deleted_at IS NULL GROUP BY layer').all();
      const byScope = db.prepare('SELECT scope, COUNT(*) AS n FROM memories WHERE deleted_at IS NULL GROUP BY scope ORDER BY n DESC LIMIT 20').all();
      const row = db.prepare('SELECT MIN(created_at) AS oldest, MAX(updated_at) AS newest FROM memories WHERE deleted_at IS NULL').get();
      return {
        path: file,
        total: statements.countAll.get().n,
        archived: statements.countArchived.get().n,
        active: statements.countAll.get().n - statements.countArchived.get().n,
        deleted: db.prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NOT NULL').get().n,
        merges: db.prepare('SELECT COUNT(*) AS n FROM merges').get().n,
        personaAudits: db.prepare('SELECT COUNT(*) AS n FROM persona_audit').get().n,
        byLayer, byScope,
        oldestAt: row?.oldest ?? null,
        newestAt: row?.newest ?? null,
        bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
      };
    },
    exportAll({ scope } = {}) {
      const rows = scope
        ? db.prepare('SELECT * FROM memories WHERE scope = ? ORDER BY id').all(String(scope))
        : db.prepare('SELECT * FROM memories ORDER BY id').all();
      return rows.map(rowToMemory);
    },
    /** 一致性快照：WAL 模式下直接拷贝 .db 可能丢掉未合并的 WAL，备份要走 VACUUM INTO。 */
    backupTo(target) {
      const dest = path.resolve(String(target));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.rmSync(dest, { force: true });
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      return dest;
    },
    /** R1b：人设演变审计。applied=1 表示这条已落进人格卡。 */
    persona: {
      record(entry = {}) {
        const ts = nowMs(now);
        const info = db.prepare(`INSERT INTO persona_audit
          (ts, kind, field, before, after, reason, evidence, actor, applied, rollback_of)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          ts,
          String(entry.kind ?? 'adjust'),
          entry.field ? String(entry.field) : null,
          entry.before == null ? null : String(entry.before).slice(0, 4000),
          entry.after == null ? null : String(entry.after).slice(0, 4000),
          entry.reason ? String(entry.reason).slice(0, 1000) : null,
          entry.evidence ? String(entry.evidence).slice(0, 2000) : null,
          entry.actor ? String(entry.actor) : 'self',
          entry.applied ? 1 : 0,
          Number.isFinite(entry.rollbackOf) ? entry.rollbackOf : null,
        );
        return Number(info.lastInsertRowid);
      },
      list({ limit = 20, kind } = {}) {
        return kind
          ? db.prepare('SELECT * FROM persona_audit WHERE kind = ? ORDER BY id DESC LIMIT ?').all(String(kind), limit)
          : db.prepare('SELECT * FROM persona_audit ORDER BY id DESC LIMIT ?').all(limit);
      },
      get(id) { return db.prepare('SELECT * FROM persona_audit WHERE id = ?').get(Number(id)) ?? null; },
      lastApplied() { return db.prepare('SELECT * FROM persona_audit WHERE applied = 1 ORDER BY id DESC LIMIT 1').get() ?? null; },
    },
    budget: {
      consume: budgetConsume,
      peek(key) { return statements.budget.get(String(key)) ?? null; },
    },
    close() { try { db.close(); } catch { /* 已关就算了 */ } },
  };
}