// 面板接口烟测：用真库只读跑一遍 store.listMemoriesForPanel / setMemoryWeight 等，
// 不联网、不改数据（权重只读回原值）。跑法：node scripts/pandora-smoke.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../src/qqb/memory/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = openStore({ root, logger: { warn: (...a) => console.warn('warn', ...a) } });
if (!store) {
  console.log('没有库（先跑桥接让它建库）');
  process.exit(0);
}
const r = store.listMemoriesForPanel({ limit: 5 });
console.log('listMemoriesForPanel:', Array.isArray(r?.items) ? `${r.items.length} 条` : r, '| stats:', JSON.stringify(r?.stats ?? null));
const first = r?.items?.[0];
if (first) {
  console.log('首条:', JSON.stringify({ id: first.id, level: first.level, kind: first.kind, scope: first.scope, archived: first.archived, text: String(first.text ?? '').slice(0, 30) }));
  const before = first.importance;
  const wr = store.setMemoryWeight({ id: first.id, importance: before });
  console.log('setMemoryWeight（写回原值）:', JSON.stringify(wr?.ok));
}
const arc = store.setMemoryArchived({ id: 99999999, archived: true });
console.log('setMemoryArchived（不存在的 id 要安全失败）:', JSON.stringify(arc));
console.log('archiveSweep（只扫不改？看返回字段）:', JSON.stringify(store.archiveSweep?.({ limit: 1 }) ?? null).slice(0, 200));