// R5 人设干预通道（人工温和引导，不强制覆盖她的人格）。
//
// 定位：主人可以用自然语言提一个「倾向/建议」（比如「以后别老熬夜」「说话可以更黏人一点」），
// 它进**提案队列**，等她自己在合适的时机接纳、或她自己决定不接纳。
// 她始终保留主线自主演变权：干预只是提议，不是命令；被拒绝也要留档与理由。
//
// 与 R1b 的分工：本模块只管「提案的生命周期」（提出→待决→采纳/拒绝/撤回 + 留档），
// 真正把人设改到卡片上是 evolve.mjs 的事（apply 时由上层传 applyFn）。
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.0';
export const STATUSES = ['pending', 'applied', 'rejected', 'withdrawn'];
const MAX_TEXT = 300;

const clampText = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function createIntervene({
  root = null,
  file = null,
  logger = null,
  now = Date.now,
  maxItems = 100
} = {}) {
  const filePath = file ?? (root ? path.join(root, 'state', 'persona-proposals.json') : null);
  const state = { version: VERSION, nextId: 1, items: [] };

  function warn(message, detail) {
    try { logger?.warn?.(message, detail); } catch { /* 日志失败不影响提案 */ }
  }

  function load() {
    if (!filePath) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      state.nextId = Math.max(1, Number(raw.nextId) || 1);
      state.items = (Array.isArray(raw.items) ? raw.items : [])
        .map((it) => ({
          id: Number(it?.id) || 0,
          ts: Number(it?.ts) || 0,
          text: clampText(it?.text, MAX_TEXT),
          kind: clampText(it?.kind ?? 'tone', 20),
          from: clampText(it?.from ?? '', 40),
          scope: clampText(it?.scope ?? '', 60),
          evidence: clampText(it?.evidence ?? '', 160),
          status: STATUSES.includes(String(it?.status)) ? String(it.status) : 'pending',
          actor: clampText(it?.actor ?? '', 40),
          decidedAt: Number(it?.decidedAt) || 0,
          reason: clampText(it?.reason ?? '', 200),
          result: clampText(it?.result ?? '', 200)
        }))
        .filter((it) => it.id && it.text);
    } catch (error) {
      warn(`人设提案读取失败（按空开始）：${error?.message ?? error}`);
    }
  }

  function save() {
    if (!filePath) return false;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, filePath);
      return true;
    } catch (error) {
      warn(`人设提案写入失败：${error?.message ?? error}`);
      return false;
    }
  }

  function list({ status = null, limit = 50 } = {}) {
    const items = state.items.filter((it) => (status ? it.status === status : true));
    return items.slice(-Math.max(1, limit)).reverse();
  }

  const get = (id) => state.items.find((it) => it.id === Number(id)) ?? null;
  const pendingCount = () => state.items.filter((it) => it.status === 'pending').length;

  /**
   * 提出一条干预提案。**只有主人能提**（isOwner !== true 直接拒绝）。
   * @returns {{ok: boolean, id?: number, proposal?: object, reason?: string}}
   */
  function propose({ text, from = '', isOwner = false, scope = '', evidence = '', kind = 'tone' } = {}) {
    if (!isOwner) return { ok: false, reason: '只有主人可以提出人设干预' };
    const clean = clampText(text, MAX_TEXT);
    if (clean.length < 2) return { ok: false, reason: '提案内容太短' };
    const proposal = {
      id: state.nextId++,
      ts: now(),
      text: clean,
      kind: clampText(kind, 20) || 'tone',
      from: clampText(from, 40),
      scope: clampText(scope, 60),
      evidence: clampText(evidence, 160),
      status: 'pending',
      actor: '',
      decidedAt: 0,
      reason: '',
      result: ''
    };
    state.items.push(proposal);
    if (state.items.length > maxItems) state.items = state.items.slice(-maxItems);
    save();
    return { ok: true, id: proposal.id, proposal };
  }

  /**
   * 采纳一条提案：调用上层给的 applyFn（通常是 evolve 的并表/落盘）。
   * applyFn 抛错时不改状态，只把错误留在 reason 里，等下次重试。
   */
  async function apply(id, { actor = 'self', reason = '', applyFn = null } = {}) {
    const item = get(id);
    if (!item) return { ok: false, reason: '提案不存在' };
    if (item.status === 'applied') return { ok: false, reason: '提案已采纳过' };
    let result = '';
    if (typeof applyFn === 'function') {
      try {
        const out = await applyFn(item);
        result = clampText(typeof out === 'string' ? out : JSON.stringify(out ?? ''), 200);
      } catch (error) {
        item.reason = `采纳失败：${clampText(error?.message ?? error, 180)}`;
        save();
        return { ok: false, reason: item.reason };
      }
    }
    item.status = 'applied';
    item.actor = clampText(actor, 40);
    item.decidedAt = now();
    item.reason = clampText(reason || '已采纳', 200);
    item.result = result;
    save();
    return { ok: true, proposal: item };
  }

  /** 拒绝/暂不采纳——她自己的判断，也要留理由。 */
  function reject(id, { actor = 'self', reason = '' } = {}) {
    const item = get(id);
    if (!item) return { ok: false, reason: '提案不存在' };
    if (item.status !== 'pending') return { ok: false, reason: `提案已是 ${item.status}` };
    item.status = 'rejected';
    item.actor = clampText(actor, 40);
    item.decidedAt = now();
    item.reason = clampText(reason || '暂不采纳', 200);
    save();
    return { ok: true, proposal: item };
  }

  /** 主人撤回自己提的（还没执行的）提案。 */
  function withdraw(id, { actor = 'owner', reason = '主人撤回' } = {}) {
    const item = get(id);
    if (!item) return { ok: false, reason: '提案不存在' };
    if (item.status !== 'pending') return { ok: false, reason: `提案已是 ${item.status}，不能撤回` };
    item.status = 'withdrawn';
    item.actor = clampText(actor, 40);
    item.decidedAt = now();
    item.reason = clampText(reason, 200);
    save();
    return { ok: true, proposal: item };
  }

  function stats() {
    const byStatus = {};
    for (const s of STATUSES) byStatus[s] = 0;
    for (const it of state.items) byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
    return { total: state.items.length, pending: pendingCount(), byStatus, updatedAt: state.items.length ? state.items[state.items.length - 1].ts : 0 };
  }

  function clear() {
    state.items = [];
    state.nextId = 1;
    save();
    return { ok: true };
  }

  load();
  return {
    version: VERSION,
    path: filePath,
    list,
    get,
    propose,
    apply,
    reject,
    withdraw,
    stats,
    pendingCount,
    clear
  };
}