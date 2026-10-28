// 记忆库（R1）：小鲸鱼自己的长期记忆，落在 `state/memory.db`（SQLite）。
//
// 为什么是 SQLite：Node 内置 `node:sqlite`（本机 v24，无需三方依赖），单文件可拷可查可导出，
// 备份/回滚跟着 state 一起走。设计取舍：
//   · **分层**：private（只属于某个私聊对象）/ normal（一般对话）/ group（群聊公开）。
//     默认召回按 scope 过滤（提示词注入永远是本会话视角，group 里不会平白出现 private 记忆）；
//     但**她主动检索时**（`qq_memory_search` → `recall({ allScopes: true })`）可以查全库，
//     结果带 scope 来源 —— 2026-10-25 主人的要求：跨会话的事她都得能想起来，
//     「说给谁听 / 说不说」由她自己拿分寸，而不是被库直接挡住。
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
//   · **遗忘曲线 + 情绪加权**（0.2.0，主人 2026-10-25 的要求）：每条记忆按艾宾浩斯
//     `R = exp(-t/S)` 算「保留率」，S 随 importance / 情绪强度 / 被想起的次数变长；
//     weight = 有效重要度 × R，越大的在提示词里排得越前（vivid），小的沉到库底（deep，
//     不再自己冒进提示词，但主动检索仍找得到）。情绪在写入那一刻决定：当时越动情，
//     同一条事记得越久 —— 详见 qqb/memory/ebbinghaus.mjs。
//   · **六层 + 厚度 + 关系硬过滤 + 归档复活 + 实体联想 + 分享**（P1 记忆核心，
//     2026-10-29 主人任务书，见 docs/PANDORA_SPEC.md §1/§2/§3/§6/§7）：
//       - `mem_level`（L2–L6）与历史 `layer` 并存，由 kind 推导（`levelOfKind()`）；
//       - `sensory`（感官戳）/ `subtext`（潜台词）让事实带着「当时的温度」；
//       - `audience: {rel, key, ownerQQ}` 在拼 SQL 之前算 `scopeWhitelist`，
//         `rel !== 'self'` 时 `allScopes` 被硬拦（不靠提示词自觉）；
//       - `archived_at` 是「归档不是删除」：默认不召回，只有
//         `includeArchived + exact` 的 FTS 精确检索才唤起并复职；
//       - `memory_entities` 实体 → 记忆的联想索引（`entitiesOf()` 是纯函数，可单测）；
//       - `shares` 让小鲸主动把某条记忆分享给某个 target（recall 时并进白名单）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { memoryWeight } from './ebbinghaus.mjs';
import { HASH_MODEL, bigramOverlap, blobToVec, cosine, hashVector, vecToBlob } from './embed.mjs';

export const VERSION = '0.4.1';

/** 向量检索的两个库：memory（memories 表）和 knowledge（knowledge 表）。 */
export const VECTOR_KINDS = Object.freeze(['memory', 'knowledge']);

/** 记忆分层。private 只在对应会话内可见，group 可在群内共享，normal 为一般对话。 */
export const LAYERS = Object.freeze(['private', 'normal', 'group']);
export const KINDS = Object.freeze(['fact', 'topic', 'impression', 'diary', 'preference', 'event', 'promise', 'message']);
export const MAX_TEXT = 2000;

/** 记忆厚度字段（sensory 感官戳 / subtext 潜台词）的清洗上限：够一段感官描写，又不至于把注入撑爆。 */
export const MAX_SNIPPET = 200;

/** 分享默认有效期：一天。借出去的东西自己会回来，不用人记着收回。 */
export const DEFAULT_SHARE_TTL_MS = 24 * 60 * 60 * 1000;

/** 六层记忆（PANDORA_SPEC §1）。L1 是 persona.md / ENGINE_RULES，不进表。 */
export const MEM_LEVELS = Object.freeze(['L2', 'L3', 'L4', 'L5', 'L6']);

/**
 * kind → 记忆层级（PANDORA_SPEC §1 的映射约定）。
 *
 * 这是唯一真源：`remember()` 新写入、老库回填、面板展示都问它，避免三处各写一套 CASE。
 * L1（人设）不进表；`card`/`message` 是为巩固层（L5 索引卡）与原话底账（L2）保留的 kind。
 * @param {string} kind
 * @returns {'L2'|'L3'|'L4'|'L5'|'L6'}
 */
export function levelOfKind(kind) {
  const k = String(kind ?? '').trim().toLowerCase();
  if (k === 'event' || k === 'topic') return 'L3';
  if (k === 'fact' || k === 'preference' || k === 'impression' || k === 'promise') return 'L4';
  if (k === 'card') return 'L5';
  if (k === 'diary') return 'L6';
  if (k === 'message') return 'L2';
  return 'L4';
}

/** 把外部传进来的层级（'L4' / 'l4' / ' 4 '）归一；认不出返回 fallback。 */
export function normalizeMemLevel(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const raw = String(value).trim().toUpperCase();
  const candidate = /^\d+$/.test(raw) ? `L${raw}` : raw;
  return MEM_LEVELS.includes(candidate) ? candidate : fallback;
}

/**
 * 清洗记忆厚度字段：压平空白、截到 200 字，空串/非字符串落成 null（库里别存空串，
 * 「有没有感官戳」这种判断才不用同时判 null 和 ''）。
 */
export function cleanSnippet(value, max = MAX_SNIPPET) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

// ────────────────────────── 实体联想（PANDORA_SPEC §6）──────────────────────────
//
// 她「触景生情」靠的不是向量：一段话里蹦出「火锅」两个字，就该想起那天在火锅店的事。
// 这里不追求真分词（没有词典也能跑），而是「停用词/人称/虚词切掉 → 留 2–4 字片段」：
//   · 多字停用词（喜欢/觉得/我们/明天…）先替换成分隔符，长词里的名词才露出来；
//   · 单字虚词/动词（的/了/我/吃/去…）当分隔符切；
//   · 剩下的片段 2–4 字直接收（`无糖可乐` 这种 4 字专名整条保留）；
//   · 超过 4 字的片段取「尾部 4 字」——中文名词的中心语在最后（「冰美式加燕麦奶」→「加燕麦奶」），
//     再补一个开头 2–4 字的片段，兼顾「冰美式」这种前置专名。
const ENTITY_STOP_PHRASES = [
  // 人称 / 指代
  '我们', '你们', '他们', '她们', '它们', '咱们', '自己', '别人', '大家', '这个', '那个', '这些', '那些',
  '这里', '那里', '哪里', '什么', '怎么', '为什么', '怎么样', '这样', '那样',
  // 虚词 / 连接
  '因为', '所以', '但是', '不过', '然后', '而且', '如果', '虽然', '还是', '就是', '不是', '没有', '已经',
  '可以', '应该', '可能', '其实', '真的', '好像', '有点', '一直', '一起', '现在', '时候', '东西', '事情',
  '地方', '样子', '感觉', '非常', '特别', '总是', '总是', '一点', '一些', '这种', '那种', '的话',
  '这么', '那么', '被人', '偷偷', '悄悄', '好吃', '好喝', '下次', '刚才', '真的', '很想',
  // 时间词（日期不是实体，实体是人和物）
  '今天', '昨天', '明天', '后天', '前天', '昨晚', '今晚', '今早', '早上', '晚上', '中午', '下午', '上午', '刚才', '后来', '之前', '之后',
  // 高频动词 / 客套
  '喜欢', '觉得', '知道', '认为', '希望', '想要', '告诉', '记得', '看到', '听到', '发现', '开始', '结束',
  '谢谢', '对不起', '没关系', '再见', '你好', '爱你', '加油', '一起', '帮忙', '准备', '已经',
];
const ENTITY_STOP_CHARS = new Set(Array.from(
  '的了着过是在和与及或把被给让对就都也又还很太更最不没要有会能说想去来吃喝玩睡买做走跑送问答我你他她它们这那哪个一上下里外后前时地得之其啊吧呢吗呀嘛哦嗯哈啦呗嘛咯噢唉哎喂诶欸借还',
));
const ENTITY_TRIM_CHARS = new Set(Array.from('的了着过是在和与及或把被给让对就都也又还很太更最不没要有会能说想去来我你他她它们这那哪个一上下里外后前时地得之其啊吧呢吗呀嘛哦嗯哈啦呗'));

/** 切出来的片段还太长时的兜底：尾部 4 字（中心语）+ 开头 4 字。 */
function entityPiecesOf(segment, out, seen, max) {
  const push = (piece) => {
    if (out.length >= max) return;
    if (piece.length < 2 || piece.length > 4) return;
    if (seen.has(piece)) return;
    seen.add(piece);
    out.push(piece);
  };
  if (segment.length <= 4) { push(segment); return; }
  push(segment.slice(-4));
  push(segment.slice(0, 4));
}

/**
 * 从一段话里抽实体（纯函数，不碰库、不碰时间，便于单测）。
 *
 * 返回 2–4 字的中文名词片段（英文/数字词按原样小写收），按首次出现顺序、最多 8 个。
 * 不追求语言学正确 —— 只要求：同一段记忆和「她此刻听到的话」用同一套规则，
 * 两边切出来的片段对得上，才谈得上联想。
 * @param {string} text
 * @param {{max?: number}} [options]
 * @returns {string[]}
 */
export function entitiesOf(text, { max = 8 } = {}) {
  const cap = Math.max(1, Number(max) || 8);
  const raw = String(text ?? '').toLowerCase();
  if (!raw.trim()) return [];
  let work = raw;
  for (const phrase of ENTITY_STOP_PHRASES) {
    if (work.includes(phrase)) work = work.split(phrase).join('|');
  }
  const out = [];
  const seen = new Set();
  // 按「非中文/非字母数字」切段：停用词替换出来的 | 也在这里断开。
  for (const chunk of work.split(/[^\u3400-\u9fffa-z0-9]+/)) {
    if (out.length >= cap) break;
    // 停用词替换出来的一串 `|` 会切出空段：跳过，不能 break（一 break 就把整句丢了）。
    if (!chunk) continue;
    if (/^[a-z0-9]/.test(chunk)) {
      // 英文/数字：纯数字没有实体价值（QQ 号、时间戳），英文词保留小写原形。
      if (!/[a-z]/.test(chunk) || chunk.length < 2 || chunk.length > 24) continue;
      if (!seen.has(chunk)) { seen.add(chunk); out.push(chunk); }
      continue;
    }
    // 单字虚词当分隔符切，再把片段两端的虚词/人称削掉。
    for (let piece of chunk.split(new RegExp(`[${[...ENTITY_STOP_CHARS].join('')}]+`))) {
      while (piece && ENTITY_TRIM_CHARS.has(piece[0])) piece = piece.slice(1);
      while (piece && ENTITY_TRIM_CHARS.has(piece[piece.length - 1])) piece = piece.slice(0, -1);
      if (!piece) continue;
      entityPiecesOf(piece, out, seen, cap);
      if (out.length >= cap) break;
    }
  }
  return out.slice(0, cap);
}

/** 记忆主体（subject）也算实体来源：人名是联想里最重要的一类。 */
export function entitiesOfMemory({ subject, text, sensory } = {}) {
  return entitiesOf([subject, text, sensory].filter(Boolean).join(' '));
}

const DEFAULT_EXTRACT_LIMIT = 30;
const DEFAULT_EXTRACT_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** 向量通道的「沾边」下限：余弦低于它、字面又没命中的，算不相关（否则查什么都能查回一堆）。
 *  hash-v1 不算余弦（它只是形近），改用 bigram 是否有共享来判沾边，见 recall/knowledgeSearch。 */
// 守着「语义模型光靠余弦要多近才算数」的门槛：bge-m3 对两段无关的中文短句
// 也能给到 0.4~0.55（2026-10-25 实测），太低就是「搜什么都搜得到」。
export const VECTOR_RELEVANCE_FLOOR = 0.6;

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
      emotion REAL NOT NULL DEFAULT 0,
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
      archived_at INTEGER,
      archive_reason TEXT,
      mem_level TEXT CHECK (mem_level IS NULL OR mem_level IN ('L2', 'L3', 'L4', 'L5', 'L6')),
      sensory TEXT,
      subtext TEXT
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

  // 向量索引（0.3.0，RAG）：一条记忆/一条知识一行向量，按 (kind, ref_id, model) 唯一。
  // 为什么要落库而不是每次现算：写一次、查千次；而且 hash-v1 与 ollama:bge-m3 是两列，
  // 换模型只多一批行，旧向量原样留着（查询只取同名模型，不会串味）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS vectors (
      kind TEXT NOT NULL,
      ref_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (kind, ref_id, model)
    );
    CREATE INDEX IF NOT EXISTS idx_vectors_model ON vectors(model, kind);
  `);

  // schema v2：memories 增加 archived_at（R1 旧记忆归档）。旧库就地补列：ADD COLUMN
  // 只改表头、不重写已有数据，7 条真实记忆的库上是毫秒级的操作。
  const columns = db.prepare('PRAGMA table_info(memories)').all().map((row) => String(row.name));
  if (!columns.includes('archived_at')) db.exec('ALTER TABLE memories ADD COLUMN archived_at INTEGER');
  // schema v3：emotion（写入那一刻的情绪强度 0~1），遗忘曲线的 S 由它和 importance 一起算。
  // 老库补列默认 0 —— 旧记忆当时没记情绪，按「平静」处理，曲线从它们当前的 updated_at 起算。
  if (!columns.includes('emotion')) db.exec('ALTER TABLE memories ADD COLUMN emotion REAL NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_archive ON memories(archived_at, updated_at)');

  // schema v5（P1 记忆核心）：六层 mem_level + 厚度 sensory/subtext + 归档原因 archive_reason。
  //
  // 坑①：ADD COLUMN 不能带 UNIQUE / PRIMARY KEY，也不能带「非常量」默认值 —— 所以
  //   `mem_level TEXT CHECK (mem_level IN (...) )` 这类约束只有新库的 CREATE TABLE 有，
  //   老库补上来的列是裸 TEXT，合法性靠 levelOfKind() 在写入侧兜住（读侧另外做一次归一）。
  // 坑②：**绝不 DROP/重建 memories**。FTS5 是 external content 表（content='memories'），
  //   影子表 memories_fts_* 跟着父表 rowid 走；重建父表后影子表里的旧 rowid 与正文错位，
  //   MATCH 查得到、点名却取不到正文（静默丢条目）。要引索引用 ADD COLUMN + CREATE INDEX。
  // 坑③：回填 UPDATE 会触发 memories_fts_au（FTS 删一次再插一次）。条目量级在几百条时
  //   无所谓；但别在回填里写 UPDATE ... WHERE 1，只补 mem_level IS NULL 的行。
  if (!columns.includes('mem_level')) db.exec('ALTER TABLE memories ADD COLUMN mem_level TEXT');
  if (!columns.includes('sensory')) db.exec('ALTER TABLE memories ADD COLUMN sensory TEXT');
  if (!columns.includes('subtext')) db.exec('ALTER TABLE memories ADD COLUMN subtext TEXT');
  if (!columns.includes('archive_reason')) db.exec('ALTER TABLE memories ADD COLUMN archive_reason TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_level ON memories(mem_level)');
  {
    // 回填：老条目按 kind 映射层级（走 levelOfKind，和 remember() 用同一套规则）。
    const stale = db.prepare('SELECT DISTINCT kind FROM memories WHERE mem_level IS NULL').all();
    if (stale.length) {
      const update = db.prepare('UPDATE memories SET mem_level = ? WHERE mem_level IS NULL AND kind = ?');
      let filled = 0;
      for (const row of stale) {
        const kind = String(row.kind ?? '');
        filled += Number(update.run(levelOfKind(kind), kind).changes) || 0;
      }
      if (filled) logger?.info?.('记忆层级回填完成', { rows: filled });
    }
  }

  // 实体联想（§6）：entity → memory 的倒排。weight 预留给「同一条记忆里重复出现/距离主体近」的加权，
  // 现在是常量 1，但表结构与查询已按权重排好序，以后调整不用迁移。
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entities (
      entity TEXT NOT NULL,
      memory_id INTEGER NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (entity, memory_id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entities_memory ON memory_entities(memory_id);
    CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity, weight DESC);
  `);

  // 分享（§7）：把某条记忆（或某个 scope 的可见权）临时借给另一个关系对象。
  // kind='memory' 精确到条；kind='scope' 精确到 scope（memory_id 为空）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      kind TEXT NOT NULL,
      scope TEXT NOT NULL,
      target TEXT NOT NULL,
      memory_id INTEGER,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_shares_target ON shares(target, kind);
    CREATE INDEX IF NOT EXISTS idx_shares_memory ON shares(memory_id);
  `);

  db.prepare('INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)').run('schema_version', '5');
  db.prepare('UPDATE schema_meta SET value = ? WHERE key = ? AND CAST(value AS INTEGER) < ?').run('5', 'schema_version', 5);
  db.prepare('INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)').run('created_at', String(nowMs(now)));

  const statements = {
    byHash: db.prepare('SELECT * FROM memories WHERE hash = ?'),
    // 六层 + 厚度：mem_level 没给就按 kind 映射；sensory/subtext 已清洗（空串 → null）。
    insert: db.prepare(`INSERT INTO memories
      (layer, scope, kind, subject, text, norm, hash, importance, emotion, confidence, source, evidence, meta, created_at, updated_at, expires_at, mem_level, sensory, subtext)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    // 合并时只补厚度、不覆盖：第一次记下的感官细节最真（后来复述的都被时间磨平了）。
    fillThickness: db.prepare('UPDATE memories SET sensory = COALESCE(sensory, ?), subtext = COALESCE(subtext, ?), mem_level = COALESCE(mem_level, ?) WHERE id = ?'),
    entityUpsert: db.prepare('INSERT INTO memory_entities (entity, memory_id, weight, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(entity, memory_id) DO UPDATE SET weight = MAX(memory_entities.weight, excluded.weight)'),
    // 归档与复职（§3）：archive_reason 只在归档时有意义，复职一并清掉。
    archiveStale: db.prepare("UPDATE memories SET archived_at = ?, archive_reason = ? WHERE id = ? AND archived_at IS NULL"),
    revive: db.prepare('UPDATE memories SET archived_at = NULL, archive_reason = NULL, use_count = use_count + 1, last_used_at = ? WHERE id = ?'),
    // 又被提起就说明这条事实还活着：顺手清掉 archived_at（复活）。归档不是单向门。
    // 情绪取「历史最高」：同一件事这次提起时更动情，说明它在心里更重。
    mergeTouch: db.prepare('UPDATE memories SET use_count = use_count + 1, updated_at = ?, importance = MAX(importance, ?), emotion = MAX(emotion, ?), evidence = COALESCE(?, evidence), archived_at = NULL WHERE id = ?'),
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

  // ---- 向量索引（RAG 那一半）----
  const vectorCache = new Map(); // `${kind}|${model}` → Map(ref_id → Float32Array)

  function vectorMapFor(kind, model) {
    const key = `${kind}|${model}`;
    const hit = vectorCache.get(key);
    if (hit) return hit;
    const map = new Map();
    try {
      for (const row of db.prepare('SELECT ref_id, vec FROM vectors WHERE kind = ? AND model = ?').all(kind, model)) {
        const vec = blobToVec(row.vec);
        if (vec) map.set(Number(row.ref_id), vec);
      }
    } catch (error) {
      logger?.warn?.('向量索引读不出来（本次按纯字面检索）', { kind, model, error: String(error?.message ?? error) });
    }
    vectorCache.set(key, map);
    return map;
  }

  function setVector(kind, refId, model, vec) {
    if (!VECTOR_KINDS.includes(kind) || !vec || !vec.length) return false;
    const ts = nowMs(now);
    try {
      db.prepare(`INSERT INTO vectors (kind, ref_id, model, dim, vec, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(kind, ref_id, model) DO UPDATE SET dim = excluded.dim, vec = excluded.vec, updated_at = excluded.updated_at`)
        .run(kind, Number(refId), String(model), vec.length, vecToBlob(vec), ts);
    } catch (error) {
      logger?.warn?.('向量写入失败（这条只走字面检索）', { kind, id: Number(refId), error: String(error?.message ?? error) });
      return false;
    }
    const map = vectorCache.get(`${kind}|${model}`);
    if (map) map.set(Number(refId), Float32Array.from(vec));
    return true;
  }

  /**
   * 补建 hash-v1 向量。老库升级上来时一次性补齐；之后每条新写入都在 remember/knowledgeAdd
   * 里同步落向量，所以这里平时是空转。
   */
  function backfillHashVectors({ limit = 5000 } = {}) {
    const out = { memory: 0, knowledge: 0 };
    try {
      const missing = db.prepare(`SELECT m.id, m.text, m.subject FROM memories m
        WHERE m.deleted_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM vectors v WHERE v.kind = 'memory' AND v.ref_id = m.id AND v.model = ?
        ) LIMIT ?`).all(HASH_MODEL, Math.max(1, limit));
      for (const row of missing) {
        setVector('memory', row.id, HASH_MODEL, hashVector(`${row.subject ?? ''} ${row.text}`));
        out.memory += 1;
      }
      const kmiss = db.prepare(`SELECT k.id, k.title, k.text, k.tags FROM knowledge k
        WHERE k.deleted_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM vectors v WHERE v.kind = 'knowledge' AND v.ref_id = k.id AND v.model = ?
        ) LIMIT ?`).all(HASH_MODEL, Math.max(1, limit));
      for (const row of kmiss) {
        setVector('knowledge', row.id, HASH_MODEL, hashVector(`${row.title ?? ''} ${row.text} ${row.tags ?? ''}`));
        out.knowledge += 1;
      }
    } catch (error) {
      logger?.warn?.('向量补建失败（本次按纯字面检索）', { error: String(error?.message ?? error) });
    }
    return out;
  }

  function vectorStats() {
    try {
      const rows = db.prepare('SELECT kind, model, COUNT(*) AS n, MAX(dim) AS dim FROM vectors GROUP BY kind, model').all();
      const memTotal = Number(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL AND archived_at IS NULL').get().n);
      const knowTotal = Number(db.prepare('SELECT COUNT(*) AS n FROM knowledge WHERE deleted_at IS NULL').get().n);
      return {
        models: rows.map((row) => ({ kind: row.kind, model: row.model, count: Number(row.n), dim: Number(row.dim) })),
        coverage: {
          memory: memTotal ? Math.round((vectorMapFor('memory', HASH_MODEL).size / memTotal) * 1000) / 1000 : 1,
          knowledge: knowTotal ? Math.round((vectorMapFor('knowledge', HASH_MODEL).size / knowTotal) * 1000) / 1000 : 1,
        },
      };
    } catch (error) {
      return { models: [], coverage: { memory: 0, knowledge: 0 }, error: String(error?.message ?? error) };
    }
  }

  function rowToMemory(row) {
    if (!row) return null;
    let meta = null;
    if (row.meta) {
      try { meta = JSON.parse(row.meta); } catch { meta = { raw: row.meta }; }
    }
    const emotion = Number(row.emotion) || 0;
    // 遗忘曲线：clock 取「上次写过/上次被想起」的较晚者（复习一次曲线从头再来）。
    const clock = Math.max(Number(row.updated_at) || 0, Number(row.last_used_at) || 0);
    const decay = memoryWeight({
      importance: row.importance,
      emotion,
      useCount: row.use_count,
      kind: row.kind,
      ageMs: Math.max(0, nowMs(now) - clock),
    });
    return {
      ...row,
      emotion,
      meta,
      // 六层与厚度（P1）：老库回填过 mem_level，但读侧再兜一次底 —— 宁可归一，
      // 也不要让上层拿到 undefined 之后各写一套默认值。
      memLevel: row.mem_level ?? levelOfKind(row.kind),
      sensory: row.sensory ?? null,
      subtext: row.subtext ?? null,
      archived: Boolean(row.archived_at),
      archiveReason: row.archive_reason ?? null,
      ...decay,
    };
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
    // 情绪强度决定「这条事在心里有多重」：写入时由调用方给（桥接拿当前心情 + 文本信号估），
    // 没给就是平静。它只影响遗忘曲线的 S 和有效重要度，不影响准入。
    const emotion = clamp01(entry.emotion, 0);
    // 厚度（§1）：感官戳是「当时看到/闻到/触到的」，潜台词是「嘴上没说、心里那句」。
    // 都清洗成 ≤200 字，空串存 null —— 「有没有」不该同时判 null 和 ''。
    const sensory = cleanSnippet(entry.sensory);
    const subtext = cleanSnippet(entry.subtext);
    // 层级：调用方可以显式指定（日记写 L6、索引卡 L5），没给就按 kind 映射。
    const memLevel = normalizeMemLevel(entry.memLevel, levelOfKind(kind));

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
      statements.mergeTouch.run(ts, importance, emotion, evidence, existing.id);
      statements.fillThickness.run(sensory, subtext, memLevel, existing.id);
      // 重复提到同一件事时，可能带出新的实体（「火锅」那次提到「小鲸鱼」），也一并记上。
      saveEntities(existing.id, { subject: entry.subject, text, sensory }, ts);
      statements.logMerge.run(ts, existing.id, text, entry.mergeReason ?? '同一条事实重复写入', entry.evidence ?? null);
      return { action: 'merged', id: existing.id, useCount: existing.use_count + 1, importance };
    }
    if (existing?.deleted_at) {
      // 同一条事实被删过又想加回来：复活它，避免 id 无限膨胀。
      db.prepare('UPDATE memories SET deleted_at = NULL, archived_at = NULL, archive_reason = NULL, updated_at = ?, text = ?, evidence = COALESCE(?, evidence), mem_level = COALESCE(mem_level, ?) WHERE id = ?')
        .run(ts, text, entry.evidence ?? null, memLevel, existing.id);
      saveEntities(existing.id, { subject: entry.subject, text, sensory }, ts);
      return { action: 'revived', id: existing.id };
    }

    const info = statements.insert.run(
      layer, scope, kind, entry.subject ? String(entry.subject) : null, text, norm, hash,
      clamp01(entry.importance, 0.5), emotion, clamp01(entry.confidence, 0.6),
      entry.source ? String(entry.source) : 'manual',
      entry.evidence ? String(entry.evidence).slice(0, 2000) : null,
      entry.meta ? JSON.stringify(entry.meta) : null,
      ts, ts,
      Number.isFinite(entry.expiresAt) ? entry.expiresAt : null,
      memLevel, sensory, subtext,
    );
    const id = Number(info.lastInsertRowid);
    // 向量与正文同时落地（hash-v1 是同步的，代价是几微秒），这样「刚记住就能被语义/形近检索到」。
    setVector('memory', id, HASH_MODEL, hashVector(`${entry.subject ? String(entry.subject) : ''} ${text}`));
    // 实体倒排（§6）：写入时就建好，检索时才不用现切全库正文。
    saveEntities(id, { subject: entry.subject, text, sensory }, ts);
    return { action: 'inserted', id, memLevel };
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

  // ─────────────────────── 关系可见性（PANDORA_SPEC §2）───────────────────────
  //
  // 这一层是**硬**的：不靠提示词叮嘱「别提别人私事」，而是在拼 SQL 前就把不该看的 scope
  // 从白名单里剔掉。理由很实在 —— 提示词会被越狱、会被模型自己找理由绕过，`scope IN (...)`
  // 不会。三条铁律：
  //   1. rel !== 'self' 时 allScopes 一律作废（调用方给不给都不看，防止上游忘了关）；
  //   2. friend 永不跨 private —— 只有「当前这个会话自己的 private」能进，别人的一个都不给；
  //   3. 没有 audience 时行为与本版之前**逐字节一致**（老调用路径与回归测试靠它活着）。
  const AUDIENCE_RELS = Object.freeze(['owner', 'friend', 'group', 'self']);

  /** 归一 audience；认不出 rel 就返回 null（= 没有关系语境，走老路径）。 */
  function normalizeAudience(value) {
    if (!value || typeof value !== 'object') return null;
    const rel = String(value.rel ?? '').trim().toLowerCase();
    if (!AUDIENCE_RELS.includes(rel)) return null;
    return {
      rel,
      key: value.key == null ? null : String(value.key),
      ownerQQ: value.ownerQQ == null || value.ownerQQ === '' ? null : String(value.ownerQQ).trim(),
    };
  }

  /**
   * 可见 scope 白名单。rel === 'self' 返回 null（她主动检索 = 不设限，由 allScopes 表达）；
   * 其余关系返回「一定含 global」的数组，调用方直接 `scope IN (...)`。
   *
   * @param {{rel: string, key?: string, ownerQQ?: string}} audience 已归一
   * @param {{scope?: string|null, shareScopes?: string[]}} [context]
   * @returns {string[]|null}
   */
  function scopeWhitelistFor(audience, { scope = null, shareScopes = [] } = {}) {
    if (!audience || audience.rel === 'self') return null;
    const key = audience.key ?? scope ?? null;
    const out = new Set(['global']);
    if (key) out.add(key);
    // owner：私聊里看到的就是「我们俩的 private」；在群里也保留这份 ——
    // 他跟她说的话不该因为换了个窗口就消失（这是规格书 §2 owner 那条的用意）。
    if (audience.rel === 'owner' && audience.ownerQQ) out.add(`private:${audience.ownerQQ}`);
    // friend / group：当前会话 + global，仅此而已。别人的 private 一条都不进白名单。
    for (const extra of shareScopes ?? []) if (extra) out.add(String(extra));
    return [...out];
  }

  /**
   * 分享（§7）：把某条记忆所在的 scope 临时借给一个 target。
   * target 写法与会话 key / 关系名一致：`private:123`、`group:456`、`owner`、`friend`、`group`。
   *
   * @param {{id: number, target: string, ttlMs?: number, kind?: string, scope?: string}} entry
   * @returns {{ok: boolean, reason?: string, id?: number, scope?: string, target?: string, expiresAt?: number}}
   */
  function shareMemory({ id, target, ttlMs = DEFAULT_SHARE_TTL_MS, kind = 'memory', scope = null } = {}) {
    const memoryId = Number(id);
    if (!Number.isFinite(memoryId) || memoryId <= 0) return { ok: false, reason: '缺少 id' };
    const row = statements.byId.get(memoryId);
    if (!row || row.deleted_at) return { ok: false, reason: '没有这条记忆' };
    const to = String(target ?? '').trim();
    if (!to) return { ok: false, reason: '缺少 target' };
    const ts = nowMs(now);
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Number(ttlMs) : DEFAULT_SHARE_TTL_MS;
    const sharedScope = String(scope ?? row.scope);
    db.prepare('INSERT INTO shares (kind, scope, target, memory_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(String(kind ?? 'memory'), sharedScope, to, memoryId, ts, ts + ttl);
    logger?.info?.('记忆已分享', { id: memoryId, scope: sharedScope, target: to, expiresAt: ts + ttl });
    return { ok: true, id: memoryId, scope: sharedScope, target: to, expiresAt: ts + ttl };
  }

  /**
   * 某个 audience 此刻被分享到的 scope 列表（target 匹配 key 或 rel）。
   * 到期即失效；同 scope 多条只回一个。
   *
   * @param {{audience?: object|null, key?: string|null, ts?: number}} [query]
   * @returns {string[]}
   */
  function sharedScopesFor({ audience = null, key = null, ts = nowMs(now) } = {}) {
    const norm = normalizeAudience(audience) ?? (audience && typeof audience === 'object' ? audience : null);
    const targets = new Set();
    if (norm?.key) targets.add(String(norm.key));
    if (key) targets.add(String(key));
    if (norm?.rel) targets.add(String(norm.rel));
    if (!targets.size) return [];
    const list = [...targets];
    try {
      return db.prepare(`SELECT DISTINCT scope FROM shares
        WHERE target IN (${list.map(() => '?').join(',')}) AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY scope`).all(...list, ts).map((row) => String(row.scope));
    } catch (error) {
      logger?.warn?.('分享读不出来（本次忽略分享）', { error: String(error?.message ?? error) });
      return [];
    }
  }

  // ───────────────────────── 归档清扫（PANDORA_SPEC §3）─────────────────────────

  /**
   * 把「已经很淡、而且很久没被提起」的记忆沉进归档区（不删数据）。
   * 归档是单向门吗？不是 —— `recall({ includeArchived: true, exact: true, query })`
   * 直接用原文命中时会复职（见 recall 的 revived 分支）。
   *
   * @param {{now?: number|null, minWeight?: number, idleDays?: number, limit?: number}} [options]
   * @returns {{archived: number, ids: number[], scanned: number, at: number}}
   */
  function archiveSweep({ now: sweepNow = null, minWeight = 0.12, idleDays = 30, limit = 5000 } = {}) {
    const ts = Number.isFinite(sweepNow) ? Number(sweepNow) : nowMs(now);
    const idleMs = Math.max(0, Number(idleDays) || 30) * 86400000;
    const floor = Number.isFinite(minWeight) ? Number(minWeight) : 0.12;
    const cap = Math.max(1, Number(limit) || 5000);
    const rows = db.prepare(`SELECT * FROM memories
      WHERE deleted_at IS NULL AND archived_at IS NULL
        AND MAX(updated_at, COALESCE(last_used_at, 0)) < ?
      ORDER BY MAX(updated_at, COALESCE(last_used_at, 0)) ASC LIMIT ?`).all(ts - idleMs, cap);
    const ids = [];
    for (const row of rows) {
      // 权重按 sweepNow 那一刻的年龄算（而不是 store 的时钟），这样测试可以给定一个「后来」的时间点。
      const decay = memoryWeight({
        importance: row.importance,
        emotion: row.emotion,
        useCount: row.use_count,
        kind: row.kind,
        ageMs: Math.max(0, ts - Math.max(Number(row.updated_at) || 0, Number(row.last_used_at) || 0)),
      });
      if (decay.weight < floor) ids.push(Number(row.id));
    }
    for (const id of ids) statements.archiveStale.run(ts, 'stale', id);
    if (ids.length) logger?.info?.('记忆归档清扫', { count: ids.length, floor, idleDays });
    return { archived: ids.length, ids, scanned: rows.length, at: ts };
  }

  // ───────────────────── 实体联想（PANDORA_SPEC §6）─────────────────────

  /**
   * 写实体倒排。同一 (entity, memory_id) 只一行，重复写入只把 weight 抬到最大，不会撑表。
   * @returns {string[]} 写入的实体
   */
  function saveEntities(memoryId, fields, ts = nowMs(now)) {
    if (!memoryId) return [];
    const entities = entitiesOfMemory(fields);
    for (const entity of entities) statements.entityUpsert.run(entity, memoryId, 1, ts);
    return entities;
  }

  /**
   * 实体联想：给一串实体（或一段话），找提到过它们的 L3/L4 记忆，按**命中实体数**排序。
   * 用了 audience 就同样走硬过滤（和 recall 共享白名单规则），没给我就不设 scope 限制。
   *
   * @param {{entities?: string[]|string, audience?: object|null, limit?: number}} [query]
   * @returns {Array<object>} 记忆行（rowToMemory + matched/entities/audienceRel）
   */
  function searchByEntities(query = {}) {
    const ts = nowMs(now);
    const source = Array.isArray(query.entities) ? query.entities : query.entities ? [query.entities] : [];
    const entities = [...new Set(source
      .flatMap((item) => (Array.isArray(item) ? item : [item]))
      .map((item) => String(item ?? '').trim().toLowerCase())
      .filter((item) => item.length >= 2))].slice(0, 32);
    if (!entities.length) return [];
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 10));
    const audience = normalizeAudience(query.audience);
    const shareScopes = audience ? sharedScopesFor({ audience, ts }) : [];
    const whitelist = audience && audience.rel !== 'self'
      ? scopeWhitelistFor(audience, { shareScopes })
      : null;

    const where = [
      'm.deleted_at IS NULL',
      'm.archived_at IS NULL',
      '(m.expires_at IS NULL OR m.expires_at > ?)',
      "m.mem_level IN ('L3', 'L4')",
    ];
    const params = [ts];
    if (whitelist) {
      where.push(whitelist.length ? `m.scope IN (${whitelist.map(() => '?').join(',')})` : '0 = 1');
      params.push(...whitelist);
    }
    // 匹配实体数用 COUNT(DISTINCT entity) 而不是 COUNT(*)：同一条记忆里同一实体只有一行，
    // 但防御性地按 DISTINCT 计数，免得以后加「权重行」时排序悄悄变了。
    //
    // 匹配不能只做 `e.entity = ?`：抽取是片段式的（「火锅店」「火锅」，「小鲸鱼笑」「小鲸鱼」），
    // 精确等值会让「火锅」召不到「火锅店」这条。改为「相等 / 存储串含查询串 / 查询串含存储串」三选一。
    const entityConds = entities.map(() => "(e.entity = ? OR e.entity LIKE ? ESCAPE '\\' OR ? LIKE '%' || e.entity || '%')").join(' OR ');
    const entityParams = [];
    for (const needle of entities) {
      const escaped = needle.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      entityParams.push(needle, `%${escaped}%`, needle);
    }
    const rows = db.prepare(`SELECT m.*, COUNT(DISTINCT e.entity) AS matched,
        GROUP_CONCAT(DISTINCT e.entity) AS matched_entities
      FROM memories m JOIN memory_entities e ON e.memory_id = m.id
      WHERE ${where.join(' AND ')} AND (${entityConds})
      GROUP BY m.id
      ORDER BY matched DESC, MAX(e.weight) DESC, m.importance DESC, m.updated_at DESC
      LIMIT ?`).all(...params, ...entityParams, limit);
    return rows.map((row) => ({
      ...rowToMemory(row),
      matched: Number(row.matched) || 0,
      entities: String(row.matched_entities ?? '').split(',').filter(Boolean),
      audienceRel: audience?.rel ?? null,
    }));
  }

  function recall(query = {}) {
    const ts = nowMs(now);
    const scope = query.scope ? String(query.scope) : null;
    // 关系语境（§2）。没有 audience = 老路径，行为与之前完全一致。
    const audience = normalizeAudience(query.audience);
    const rel = audience?.rel ?? null;
    // 跨会话召回：**只有 rel === 'self'（她自己主动检索）才允许**。其余关系下 allScopes
    // 直接作废 —— 不给上游、更不给提示词任何「这次特批全库」的机会。
    const allScopes = rel === 'self' ? true : (rel ? false : query.allScopes === true);
    const layers = query.layers ? query.layers.map(String) : null;
    const kinds = query.kinds ? query.kinds.map(String) : null;
    const limit = Number.isFinite(query.limit) ? Math.max(1, query.limit) : 10;
    const minScore = Number.isFinite(query.minScore) ? query.minScore : 0;
    const needle = normalizeText(query.query);
    // 可选的查询向量（RAG）：给了就做「字面 + 余弦」混合排序，没给就纯字面。
    const queryVector = query.vector ? Float32Array.from(query.vector) : null;
    const vectorModel = query.vectorModel ? String(query.vectorModel) : HASH_MODEL;
    const vectorMap = queryVector ? vectorMapFor('memory', vectorModel) : null;

    // 分享进来的 scope 并进白名单（只在给了 audience 时生效；没有 audience 就没有「借给谁」可言）。
    const shareScopes = audience ? sharedScopesFor({ audience, key: scope, ts }) : [];
    const whitelist = rel && rel !== 'self' ? scopeWhitelistFor(audience, { scope, shareScopes }) : null;
    // 不带分享的白名单：只用来给结果打 `shared` 标记（「这条是别人借给我看的」）。
    const baseWhitelist = rel && rel !== 'self' ? scopeWhitelistFor(audience, { scope }) : null;
    const shareOnly = new Set(shareScopes.filter((item) => !baseWhitelist?.includes(String(item))));

    const where = ['deleted_at IS NULL', '(expires_at IS NULL OR expires_at > ?)'];
    const params = [ts];
    // 归档（§3）：默认只看活条目；只有「显式 includeArchived + exact + 有关键词」才允许
    // 用原文精确命中把归档条目捞回来（捞到就复职）。宁可唤起得笨一点，也不许模糊命中把
    // 一堆早就沉底的旧事翻出来 —— 那等于归档没做。
    const wantsRevive = query.includeArchived === true && query.exact === true && Boolean(needle);
    const archivedIds = wantsRevive ? ftsIds('memories_fts', needle) : null;
    if (!wantsRevive) {
      where.push('archived_at IS NULL');
    } else if (archivedIds === null) {
      // 索引不可用（没编 FTS5 / 关键词太短）：回落原文 LIKE，仍然只认「原文包含」。
      where.push('(archived_at IS NULL OR norm LIKE ?)');
      params.push(`%${needle}%`);
    } else if (archivedIds.length) {
      where.push(`(archived_at IS NULL OR id IN (${archivedIds.map(() => '?').join(',')}))`);
      params.push(...archivedIds);
    } else {
      // 索引查了、一条都没沾上：归档区一条都不唤起。
      where.push('archived_at IS NULL');
    }
    if (whitelist) {
      // 硬过滤：白名单为空就 fail-closed（`0 = 1`），绝不退化成「不加条件 = 全库」。
      where.push(whitelist.length ? `scope IN (${whitelist.map(() => '?').join(',')})` : '0 = 1');
      params.push(...whitelist);
    } else if (scope && !allScopes) {
      where.push('(scope = ? OR scope = ?)');
      params.push(scope, 'global');
    }
    if (layers?.length) { where.push(`layer IN (${layers.map(() => '?').join(',')})`); params.push(...layers); }
    if (kinds?.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
    // §1 原文底账：L2 是原始消息，只给巩固/做梦当素材，**默认不参与召回**。
    // 想翻原文得显式 `includeOriginals: true`（面板/排障用），否则每句话都会成为「记忆」，
    // 几下就把真正的事实挤出提示词（这是 L1–L6 里最容易做错的一层）。
    if (query.includeOriginals !== true && !kinds?.includes('message')) {
      where.push("(mem_level IS NULL OR mem_level <> 'L2')");
    }
    // 有关键词走全文索引（走索引才叫「检索」，老实现是全表 LIKE 扫 500 行再打分）；
    // 只有索引不可用或关键词太短（trigram 切不出词）时才回落 LIKE。
    // 例外：带了查询向量（RAG）时**不**用字面结果筛候选 —— 语义相近的条目本来就可能一个词都不沾，
    // 那种被字面筛掉正是老实现最大的漏召。索引命中的那几条另外并回候选集。
    let extraIds = null;
    if (needle) {
      const indexed = ftsIds('memories_fts', needle);
      if (vectorMap) {
        extraIds = indexed ?? [];
      } else if (indexed?.length) {
        where.push(`id IN (${indexed.map(() => '?').join(',')})`);
        params.push(...indexed);
      } else {
        where.push('(norm LIKE ? OR LOWER(COALESCE(subject, \'\')) LIKE ?)');
        params.push(`%${needle}%`, `%${needle}%`);
      }
    }

    const rows = db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, vectorMap ? 1000 : 500);
    if (extraIds?.length) {
      const have = new Set(rows.map((row) => Number(row.id)));
      const missing = extraIds.filter((id) => !have.has(Number(id)));
      if (missing.length) {
        const scopeOk = (row) => (whitelist
          ? whitelist.includes(String(row.scope))
          : (!scope || allScopes || row.scope === scope || row.scope === 'global'));
        const layerOk = (row) => !layers?.length || layers.includes(row.layer);
        const kindOk = (row) => !kinds?.length || kinds.includes(row.kind);
        const liveOk = (row) => !row.deleted_at && (!row.archived_at || wantsRevive) && (!row.expires_at || row.expires_at > ts);
        for (const row of db.prepare(`SELECT * FROM memories WHERE id IN (${missing.map(() => '?').join(',')})`).all(...missing)) {
          if (scopeOk(row) && layerOk(row) && kindOk(row) && liveOk(row)) rows.push(row);
        }
      }
    }
    const tokens = needle ? needle.split(' ').filter((item) => item.length > 1) : [];
    const scored = rows.map((row) => {
      // 一条记忆此刻的「分量」：weight = 有效重要度 × 保留率（艾宾浩斯），
      // 情绪强度在编码时已经把重要度抬过一截（rowToMemory 里算好）。
      const memory = rowToMemory(row);
      const usage = Math.min(1, row.use_count / 5);
      let match = needle ? 0.3 : 0.5;
      if (needle && row.norm.includes(needle)) match = 1;
      else if (tokens.length && tokens.some((token) => row.norm.includes(token))) match = 0.6;
      const stored = vectorMap?.get(Number(row.id)) ?? null;
      const cos = vectorMap ? (stored ? cosine(queryVector, stored) : 0) : null;
      // hash-v1 认形不认意思：用 bigram 重叠判断是否沾边，余弦只参与排序；
      // 语义模型（bge-m3）才真是按意思算，但短句余弦噪声大，bigram 仍留一份话语权。
      const lexical = vectorMap
        ? bigramOverlap(String(query.query ?? ''), `${row.subject ?? ''} ${row.text ?? ''}`)
        : null;
      // 相关性 = 字面命中 + 向量那一路（两路互相补短：一个认字，一个认意思）。
      // 语义模型（bge-m3）余弦的绝对值比字面命中更可信，占比更大。
      const relevance = vectorMap
        ? (vectorModel === HASH_MODEL
          ? clamp01(0.6 * match + 0.4 * lexical)
          : clamp01(0.55 * cos + 0.45 * lexical))
        : match;
      // 有两种场景，权重要反过来：
      //   · 有检索词（她自己搜/控制台搜）—— 相关度为主，weight 只是轻微先验，
      //     否则「重要度 0.95 的那几条」会永远霸榜，搜什么都返回同一批（2026-10-25 实测）。
      //   · 没有检索词（提示词注入按分量挑）—— weight 为主，就是艾宾浩斯那套。
      const score = needle
        ? 0.7 * relevance + 0.15 * memory.weight + 0.1 * usage + 0.05 * memory.emotion
        : 0.6 * memory.weight + 0.3 * relevance + 0.1 * usage;
      return {
        ...memory,
        match,
        ...(vectorMap ? { vector: Math.round(cos * 10000) / 10000 } : {}),
        ...(lexical != null ? { lexical: Math.round(lexical * 10000) / 10000 } : {}),
        score: Math.round(score * 10000) / 10000,
        // §2 的可见性结论：rel 原样回传（没有 audience 时是 null），方便上层审计「这条为什么给她看」。
        // 老字段一个不少，纯增量，向后兼容。
        audienceRel: rel,
      };
    })
      .filter((item) => item.score >= minScore)
      // 有关键词时，向量通道也要有个「沾边」门槛：字面没命中、又一点都不沾的，
      // 不该混进结果（否则「查什么都能查回一堆」—— 那比查不到更糟）。
      // hash-v1 看 bigram 是否真有共享；语义模型要么余弦很近（≥ VECTOR_RELEVANCE_FLOOR），
      // 要么至少沾一点字面 —— 光靠 0.4~0.5 的「泛泛相似」会混进一堆不相干的闲聊。
      .filter((item) => (
        !needle || !vectorMap || item.match >= 0.6
        || (vectorModel === HASH_MODEL
          ? (item.lexical ?? 0) > 0
          : (item.lexical ?? 0) > 0 || (item.vector ?? 0) >= VECTOR_RELEVANCE_FLOOR)
      ))
      .sort((a, b) => b.score - a.score || b.weight - a.weight || b.updated_at - a.updated_at)
      .slice(0, limit);

    // 复职（§3）：归档条目被原文精确命中 = 这次真的「想起来了」，从归档区拿回活区。
    // 复职本身记一次使用（use_count+1、last_used_at=ts），所以这些条目不再走 touchUse，
    // 否则同一次召回会被记两次。
    const revived = new Set();
    if (query.markUsed !== false) {
      for (const item of scored) {
        if (!item.archived) continue;
        statements.revive.run(ts, Number(item.id));
        item.archived = false;
        item.archiveReason = null;
        item.revived = true;
        item.useCount = Number(item.useCount ?? 0) + 1;
        revived.add(Number(item.id));
      }
      for (const item of scored) if (!revived.has(Number(item.id))) statements.touchUse.run(ts, item.id);
    }
    if (shareOnly.size) {
      for (const item of scored) if (shareOnly.has(String(item.scope))) item.shared = true;
    }
    return scored;
  }

  /** 最近的记忆（不分层过滤时按 scope 收敛：「我们最近在聊什么」比检索更常用）。 */
  function recentMemories(query = {}) {
    const scope = query.scope ? String(query.scope) : null;
    const allScopes = query.allScopes === true;
    const layers = Array.isArray(query.layers) && query.layers.length ? query.layers.map(String) : null;
    const kinds = Array.isArray(query.kinds) && query.kinds.length ? query.kinds.map(String) : null;
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 8));
    const ts = nowMs(now);
    const where = ['deleted_at IS NULL', 'archived_at IS NULL', '(expires_at IS NULL OR expires_at > ?)'];
    const params = [ts];
    if (scope && !allScopes) { where.push('(scope = ? OR scope = ?)'); params.push(scope, 'global'); }
    if (layers) { where.push(`layer IN (${layers.map(() => '?').join(',')})`); params.push(...layers); }
    if (kinds) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
    // 和 recall 同一条规矩：L2 原文默认不参与「最近记忆」，否则每句闲聊都把事实挤到后面。
    if (query.includeOriginals !== true && !kinds?.includes('message')) {
      where.push("(mem_level IS NULL OR mem_level <> 'L2')");
    }
    return db.prepare(`SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit)
      .map((row) => rowToMemory(row));
  }

  // ───────────────────── 控制台（面板）数据函数（§7，签名固定）─────────────────────
  //
  // 面板走的是「只读视图 + 两个写操作」，不复用 recall：recall 会打 use_count、
  // 会按分数排序，列表页要的是「按时间排好的全量」和「稳定的字段形状」。

  /** 一条记忆的面板形状（字段名 camelCase，跟路由层直接拼 JSON 用）。 */
  function panelItem(row) {
    const memory = rowToMemory(row);
    if (!memory) return null;
    return {
      id: Number(memory.id),
      memLevel: memory.memLevel,
      layer: memory.layer,
      scope: memory.scope,
      kind: memory.kind,
      subject: memory.subject ?? null,
      text: memory.text,
      sensory: memory.sensory,
      subtext: memory.subtext,
      importance: memory.importance,
      emotion: memory.emotion,
      weight: memory.weight,
      retention: memory.retention,
      depth: memory.depth,
      archived: memory.archived,
      createdAt: memory.created_at,
      updatedAt: memory.updated_at,
      useCount: memory.use_count,
      evidence: memory.evidence ?? null,
    };
  }

  /**
   * 面板列表：按更新时间倒序、可按层级/关键词/scope 过滤。
   * stats 是**全库**口径（不受过滤条件影响），页头要的是「总共有多少、归档了多少」，
   * 不是「当前这页筛出多少」。
   */
  function listMemoriesForPanel({ levels = [], q = '', scope = '', limit = 100, includeArchived = false } = {}) {
    const cap = Math.max(1, Math.min(500, Number(limit) || 100));
    const levelList = [...new Set((Array.isArray(levels) ? levels : [levels])
      .map((item) => normalizeMemLevel(item)).filter(Boolean))];
    const where = ['deleted_at IS NULL'];
    const params = [];
    // 「归档」这个条件单独拼，不塞进 where —— 统计要分别数「可见的」与「归档的」，
    // 而且两者都得沿用同一套 levels/scope/关键词过滤（否则面板每个人的记忆数都是全库总数）。
    const archivedCond = includeArchived ? '1 = 1' : 'archived_at IS NULL';
    if (levelList.length) {
      where.push(`mem_level IN (${levelList.map(() => '?').join(',')})`);
      params.push(...levelList);
    }
    const scopeFilter = String(scope ?? '').trim();
    if (scopeFilter) { where.push('scope = ?'); params.push(scopeFilter); }
    const needle = String(q ?? '').trim().toLowerCase();
    if (needle) {
      where.push("(norm LIKE ? OR LOWER(COALESCE(subject, '')) LIKE ?)");
      params.push(`%${needle}%`, `%${needle}%`);
    }
    const filterSql = where.join(' AND ');
    const rows = db.prepare(`SELECT * FROM memories WHERE ${filterSql} AND ${archivedCond} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params, cap);
    const stats = {
      total: Number(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${filterSql} AND ${archivedCond}`).get(...params).n),
      archived: Number(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${filterSql} AND archived_at IS NOT NULL`).get(...params).n),
    };
    return { items: rows.map(panelItem), stats };
  }

  /**
   * 面板改重要度：同时抬 updated_at —— 用户手动「加重」就是一次复习，遗忘曲线该从头走。
   * 向量不用重算（内容没变），哈希向量的输入也不含 importance。
   */
  function setMemoryWeight({ id, importance } = {}) {
    const memoryId = Number(id);
    const row = statements.byId.get(memoryId);
    if (!row || row.deleted_at) return { ok: false, item: null, reason: '没有这条记忆' };
    const value = Number(importance);
    if (!Number.isFinite(value)) return { ok: false, item: panelItem(row), reason: 'importance 必须是数字' };
    db.prepare('UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?')
      .run(clamp01(value, row.importance), nowMs(now), memoryId);
    return { ok: true, item: panelItem(statements.byId.get(memoryId)) };
  }

  /**
   * 面板归档/取消归档：取消归档同时刷新 updated_at（手动捞回来的东西，值得重新计时）。
   * 归档保留 updated_at —— 归档清扫与「沉了多久」都以它为准。
   */
  function setMemoryArchived({ id, archived, reason } = {}) {
    const memoryId = Number(id);
    const row = statements.byId.get(memoryId);
    if (!row || row.deleted_at) return { ok: false, item: null, reason: '没有这条记忆' };
    const ts = nowMs(now);
    const wantArchived = archived === true || archived === 1 || archived === 'true';
    if (wantArchived) {
      db.prepare('UPDATE memories SET archived_at = ?, archive_reason = ? WHERE id = ?')
        .run(ts, String(reason ?? 'manual').slice(0, 40), memoryId);
    } else {
      db.prepare('UPDATE memories SET archived_at = NULL, archive_reason = NULL, updated_at = ? WHERE id = ?')
        .run(ts, memoryId);
    }
    return { ok: true, item: panelItem(statements.byId.get(memoryId)) };
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
    const id = Number(info.lastInsertRowid);
    setVector('knowledge', id, HASH_MODEL, hashVector(`${title ?? ''} ${text} ${tags ?? ''}`));
    return { action: 'inserted', id };
  }

  /** 知识检索：关键词走 FTS + 向量余弦混合排序，没有关键词就按重要性/新鲜度列最近的。 */
  function knowledgeSearch(query = {}) {
    const ts = nowMs(now);
    const scope = query.scope ? String(query.scope) : null;
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 10));
    const needle = normalizeText(query.query);
    const queryVector = query.vector ? Float32Array.from(query.vector) : null;
    const vectorModel = query.vectorModel ? String(query.vectorModel) : HASH_MODEL;
    const vectorMap = queryVector ? vectorMapFor('knowledge', vectorModel) : null;
    const where = ['deleted_at IS NULL'];
    const params = [];
    if (scope && query.includeGlobal !== false) { where.push('(scope = ? OR scope = ?)'); params.push(scope, 'global'); }
    else if (scope) { where.push('scope = ?'); params.push(scope); }
    if (needle && !vectorMap) {
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
      .all(...params, Math.max(limit, 200));
    const tokens = needle ? needle.split(' ').filter((item) => item.length > 1) : [];
    const scored = rows.map((row) => {
      const item = rowToKnowledge(row);
      const hay = `${item.title ? String(item.title).toLowerCase() : ''} ${row.norm}`;
      let match = needle ? 0.3 : 0.5;
      if (needle && hay.includes(needle)) match = 1;
      else if (tokens.length && tokens.some((token) => hay.includes(token))) match = 0.6;
      const stored = vectorMap?.get(item.id) ?? null;
      const cos = vectorMap ? (stored ? cosine(queryVector, stored) : 0) : null;
      const lexical = vectorMap
        ? bigramOverlap(String(query.query ?? ''), `${item.title ?? ''} ${row.text ?? ''} ${row.tags ?? ''}`)
        : null;
      const relevance = vectorMap
        ? (vectorModel === HASH_MODEL
          ? clamp01(0.6 * match + 0.4 * lexical)
          : clamp01(0.55 * cos + 0.45 * lexical))
        : match;
      // 知识库没有遗忘曲线，但同样的道理：检索时相关度为主，重要度只当先验。
      const score = 0.7 * relevance + 0.2 * item.importance + 0.1 * Math.min(1, Number(item.useCount) / 5);
      return {
        ...item,
        match,
        ...(vectorMap ? { vector: Math.round(cos * 10000) / 10000 } : {}),
        ...(lexical != null ? { lexical: Math.round(lexical * 10000) / 10000 } : {}),
        score: Math.round(score * 10000) / 10000,
      };
    })
      .filter((item) => (
        !needle || !vectorMap || item.match >= 0.6
        || (vectorModel === HASH_MODEL
          ? (item.lexical ?? 0) > 0
          : (item.lexical ?? 0) > 0 || (item.vector ?? 0) >= VECTOR_RELEVANCE_FLOOR)
      ))
      .sort((a, b) => b.score - a.score || b.importance - a.importance || b.updatedAt - a.updatedAt)
      .slice(0, limit);
    if (query.markUsed !== false && scored.length) {
      const touch = db.prepare('UPDATE knowledge SET use_count = use_count + 1, updated_at = MAX(updated_at, ?) WHERE id = ?');
      for (const row of scored) touch.run(ts, Number(row.id));
    }
    return scored;
  }

  // 老库升级上来时把缺的 hash-v1 向量补一遍（同步、毫秒级；新库此时是空转）。
  const backfilled = backfillHashVectors();
  if (backfilled.memory || backfilled.knowledge) logger?.info?.('记忆/知识向量已补建', backfilled);

  return {
    version: VERSION,
    path: file,
    remember,
    recall,
    recentMemories,
    // P1 记忆核心（§2/§3/§6/§7）：关系硬过滤之外的对外口子。
    searchByEntities,
    shareMemory,
    sharedScopesFor,
    archiveSweep,
    listMemoriesForPanel,
    setMemoryWeight,
    setMemoryArchived,
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
    /** 向量索引的对外口子（RAG）：查模型覆盖、手动重算、写外部模型的向量。 */
    vectors: {
      model: HASH_MODEL,
      set: setVector,
      of: vectorMapFor,
      backfill: backfillHashVectors,
      stats: vectorStats,
      /** 还没算过某个模型向量的条目（给异步语义向量补建用）。 */
      pending({ kind = 'memory', model = HASH_MODEL, limit = 50 } = {}) {
        const sql = kind === 'knowledge'
          ? `SELECT k.id, COALESCE(k.title, '') || ' ' || k.text AS text FROM knowledge k
             WHERE k.deleted_at IS NULL AND NOT EXISTS (
               SELECT 1 FROM vectors v WHERE v.kind = 'knowledge' AND v.ref_id = k.id AND v.model = ?
             ) ORDER BY k.id LIMIT ?`
          : `SELECT m.id, COALESCE(m.subject, '') || ' ' || m.text AS text FROM memories m
             WHERE m.deleted_at IS NULL AND m.archived_at IS NULL AND NOT EXISTS (
               SELECT 1 FROM vectors v WHERE v.kind = 'memory' AND v.ref_id = m.id AND v.model = ?
             ) ORDER BY m.id LIMIT ?`;
        try {
          return db.prepare(sql).all(String(model), Math.max(1, Number(limit) || 50));
        } catch {
          return [];
        }
      },
    },
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