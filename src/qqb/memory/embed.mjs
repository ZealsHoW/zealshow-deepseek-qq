// qqb/memory/embed.mjs —— 记忆库/知识库的向量化（RAG 检索的那一半）
//
// 为什么需要它：FTS5 trigram 只能命中「字面上有的子串」。她问「上次那个让我心里
// 一动的歌」，库里存的是「她说那首歌唱得她鼻子酸」—— 一个字都对不上，索引就哑了。
// 向量检索补的正是这一块：把「意思」折成向量，按余弦相似度找回语义相近的条目。
//
// 两条通道，一条都不能少：
//  1) `hash-v1`（纯 JS，同步，零依赖）：字符 unigram + bigram 哈希到 384 维再 L2 归一。
//     它不是「深度学习语义向量」，但对中文短句效果出奇地稳（形近、字序、共现都算分），
//     而且**同步**——提示词注入 `block()` 是同步函数，只有它能在那里跑。
//  2) `ollama:<model>`（异步，本机 Ollama）：真正的语义向量（bge-m3 等）。
//     用在「她自己主动检索」这条异步路径上（qq_memory_search / 控制台搜索）。
//     模型没装 / 服务没起 / 超时 → 自动退回 hash-v1，检索不会因为模型缺席而瘫掉。
//
// 融合方式（store.mjs 里做）：relevance = 0.6 * 字面命中 + 0.4 * 余弦，
// 再和遗忘曲线的 weight 合成总分 —— 即「记得清 + 沾边」双高才排最前。
import crypto from 'node:crypto';

/** 同步的字符 n-gram 哈希向量；同一段文本永远得到同一个向量。 */
export const HASH_MODEL = 'hash-v1';
export const HASH_DIM = 384;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

function normalizeText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 同步算一条文本的哈希向量。返回 Float32Array（已 L2 归一，可直接点积当余弦）。
 * 权重：unigram 1.0、bigram 1.6（词序信息更新，权重给高些）、子线性 TF 抑制长文本。
 */
export function hashVector(text, dim = HASH_DIM) {
  const vec = new Float32Array(dim);
  const norm = normalizeText(text);
  if (!norm) return vec;
  const counts = new Map();
  const bump = (gram, weight) => {
    const key = `${weight}|${gram}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let i = 0; i < norm.length; i += 1) {
    bump(norm[i], 1);
    if (i + 1 < norm.length) bump(norm.slice(i, i + 2), 1.6);
  }
  for (const [key, count] of counts) {
    const sep = key.indexOf('|');
    const weight = Number(key.slice(0, sep));
    const gram = key.slice(sep + 1);
    const h = fnv1a(gram);
    const idx = h % dim;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    vec[idx] += sign * weight * (1 + Math.log(count));
  }
  let sum = 0;
  for (let i = 0; i < dim; i += 1) sum += vec[i] * vec[i];
  const len = Math.sqrt(sum);
  if (len > 0) for (let i = 0; i < dim; i += 1) vec[i] /= len;
  return vec;
}

/** 字符 bigram 集合（只留汉字/字母/数字，空白和标点不参与）。 */
export function bigramSet(text) {
  const clean = normalizeText(text).replace(/[^\p{L}\p{N}]+/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < clean.length; i += 1) out.add(clean.slice(i, i + 2));
  return out;
}

// 这些 bigram 几乎出现在任何一句中文里，算不上「沾边」。
// 2026-10-25 真机：「股票基金怎么买」靠一个「怎么」召回了「第二题怎么做」，
// 所以「沾边」必须只认有信息量的字组合。
const COMMON_BIGRAMS = new Set([
  '怎么', '什么', '一个', '一下', '我们', '你们', '他们', '她们', '自己', '这个', '那个', '这些', '那些',
  '现在', '今天', '明天', '昨天', '时候', '可以', '可能', '没有', '就是', '还是', '因为', '所以', '但是',
  '如果', '不会', '不是', '这样', '那样', '真的', '也是', '都是', '有点', '一点', '已经', '觉得', '知道',
  '然后', '而且', '或者', '不过', '还有', '一下', '怎么', '怎样', '为什么', '东西', '事情', '问题',
]);

/** 只保留有信息量的 bigram（去掉「怎么/什么/一个」这种到哪儿都有的）。 */
export function informativeBigrams(text) {
  const out = new Set();
  for (const gram of bigramSet(text)) if (!COMMON_BIGRAMS.has(gram)) out.add(gram);
  return out;
}

/**
 * 「沾边」程度（0~1）：两段文本共享多少个**有信息量**的字符 bigram，按短的那边归一。
 * hash-v1 只是形近向量，余弦分不出「沾边」和「碰巧撞了几个字」；
 * 用它当门槛、余弦当排序，才不会「查什么都查回一堆」。
 */
export function bigramOverlap(a, b) {
  const left = informativeBigrams(a);
  if (!left.size) return 0;
  const right = bigramSet(b);
  if (!right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return shared / left.size;
}

/** 余弦相似度（两边都已归一时就是点积；这里仍然兜底算长度，方便接外部模型）。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Float32Array → SQLite BLOB；反过来也一样。 */
export function vecToBlob(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function blobToVec(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length % 4 !== 0) return null;
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Float32Array(copy.buffer, 0, buf.length / 4);
}

function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 本机 Ollama 的嵌入通道。构造是同步的，真正的可用性探测延迟到第一次 embed()。
 * `id` 形如 `ollama:bge-m3`，作为 vectors 表里的 model 键 —— 换模型就是换一列，
 * 旧向量不删也不串味（查询只取同名模型那一批）。
 */
export function createOllamaEmbedder({
  url = 'http://127.0.0.1:11434',
  model = 'bge-m3',
  timeoutMs = 4000,
  logger = null,
} = {}) {
  const base = String(url ?? '').replace(/\/+$/, '');
  let probe = null; // null=未探过 / true / false
  let probedAt = 0;
  const PROBE_TTL_MS = 10 * 60 * 1000;

  return {
    kind: 'ollama',
    id: `ollama:${model}`,
    model,
    async available({ force = false } = {}) {
      const ts = Date.now();
      if (!force && probe !== null && ts - probedAt < PROBE_TTL_MS) return probe;
      try {
        const res = await withTimeout(fetch(`${base}/api/tags`), timeoutMs, 'ollama /api/tags');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const names = (data?.models ?? []).map((item) => String(item?.name ?? ''));
        probe = names.some((name) => name === model || name.startsWith(`${model}:`));
        if (!probe) logger?.warn?.('本机 Ollama 没有这个嵌入模型，向量检索退回 hash-v1', { model, have: names.slice(0, 10) });
      } catch (error) {
        probe = false;
        logger?.warn?.('本机 Ollama 不可用，向量检索退回 hash-v1', { url: base, error: String(error?.message ?? error) });
      }
      probedAt = ts;
      return probe;
    },
    async embed(texts) {
      const list = (Array.isArray(texts) ? texts : [texts]).map((item) => String(item ?? ''));
      if (!list.length) return [];
      if (!(await this.available())) throw new Error('ollama 嵌入模型不可用');
      const res = await withTimeout(fetch(`${base}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: list }),
      }), timeoutMs * 4, 'ollama /api/embed');
      if (!res.ok) throw new Error(`ollama /api/embed HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const rows = data?.embeddings ?? [];
      if (!Array.isArray(rows) || rows.length !== list.length) throw new Error('ollama 返回的向量条数不对');
      return rows.map((row) => Float32Array.from(row));
    },
  };
}

/**
 * 统一的向量入口：`sync` 部分永远可用（hash），`semantic` 部分可能缺席。
 * 调用方：同步路径用 `sync.vector(text)`；异步路径先 `await semanticReady()` 再 `await semantic.embed()`。
 */
export function createEmbedder({ ollamaUrl, ollamaModel, timeoutMs, logger } = {}) {
  const ollama = ollamaModel === null
    ? null
    : createOllamaEmbedder({ url: ollamaUrl, model: ollamaModel ?? 'bge-m3', timeoutMs, logger });
  return {
    hash: { id: HASH_MODEL, dim: HASH_DIM, vector: (text) => hashVector(text) },
    semantic: ollama,
    async semanticReady() {
      if (!ollama) return false;
      try {
        return await ollama.available();
      } catch {
        return false;
      }
    },
  };
}

/** 给测试/排障用的稳定指纹：同一文本 → 同一 hex。 */
export function vectorFingerprint(vec) {
  return crypto.createHash('sha1').update(Buffer.from(new Float32Array(vec).buffer)).digest('hex').slice(0, 12);
}