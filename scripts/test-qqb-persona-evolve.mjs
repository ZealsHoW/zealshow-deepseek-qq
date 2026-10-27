// R1b（人设演变）+ R5（干预通道）的回归测试。
//
// 重点测「不可逆的部分」：人格卡只被改受管区块、备份与审计一定留下、回滚能恢复原样、
// 非主人提不了干预。用真临时目录 + 可控时钟。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createEvolve, CARD_BEGIN, CARD_END, VERSION as EVOLVE_VERSION, traitKindOf } from '../src/qqb/persona/evolve.mjs';
import { createIntervene, VERSION as INTERVENE_VERSION } from '../src/qqb/persona/intervene.mjs';

const CARD_HEAD = [
  '# 小鲸鱼（人格卡）',
  '',
  '## 性格',
  '- 有点傲娇，嘴硬心软。',
  '',
  '## 说话方式',
  '- 短句，口语，偶尔撒娇。'
].join('\n');

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-persona-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  return dir;
}

function writeCard(root, body) {
  const dir = path.join(root, 'roles');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '小鲸鱼.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function fakeStore() {
  const audits = [];
  return {
    audits,
    rows: [
      { id: 1, subject: '小鲸鱼', text: '那英语明天补上，今晚别熬太晚', kind: 'promise', importance: 0.9, layer: 'private' },
      { id: 2, subject: '小鲸鱼', text: '我最近喜欢听周杰伦', kind: 'preference', importance: 0.7, layer: 'private' },
      { id: 3, subject: '爸爸', text: '我要准备四级考试', kind: 'fact', importance: 0.8, layer: 'private' },
      { id: 4, subject: '小鲸鱼', text: '小鲸鱼拒绝登录别人的抖音账号，只看公开页面', kind: 'fact', importance: 0.95, layer: 'private' },
      { id: 5, subject: '小鲸鱼', text: '那我也没办法？', kind: 'preference', importance: 0.9, layer: 'private' }
    ],
    exportAll() { return this.rows.slice(); },
    persona: {
      record(row) { audits.push(row); return audits.length; }
    }
  };
}

test('evolve: 只写受管区块，人格卡其余部分一字不动', (t) => {
  const root = tmpRoot(t);
  const card = writeCard(root, `${CARD_HEAD}\n`);
  const store = fakeStore();
  const evo = createEvolve({ root, store, now: () => Date.parse('2026-10-21T04:30:00+08:00') });

  const out = evo.apply({ reason: '测试演化' });
  assert.ok(out.added >= 2, `至少应新增 2 条特征，实际 ${out.added}`);
  assert.equal(out.wroteCard, true);

  const raw = fs.readFileSync(card, 'utf8');
  assert.ok(raw.startsWith(CARD_HEAD.slice(0, 12)), '人格卡原有内容必须仍在开头');
  assert.ok(raw.includes('- 有点傲娇，嘴硬心软。'), '原有性格行必须保留');
  assert.ok(raw.includes(CARD_BEGIN) && raw.includes(CARD_END), '受管区块标记必须写入');
  assert.ok(raw.includes('承诺') && raw.includes('那英语明天补上'));
  assert.ok(!raw.includes('爸爸') && !raw.includes('四级'), '别人的事不能进她的人设');
});

test('evolve: 规矩归「底线」不归「近况」，聊天碎片不进人设', (t) => {
  assert.equal(traitKindOf('fact', '不许登别人的账号'), 'rule');
  assert.equal(traitKindOf('preference', '我最近喜欢听周杰伦'), 'like');
  assert.equal(traitKindOf('fact', '今天下午三点去拿快递'), 'self');

  const root = tmpRoot(t);
  const card = writeCard(root, `${CARD_HEAD}\n`);
  const evo = createEvolve({ root, store: fakeStore() });
  evo.apply({ reason: '规矩归位' });

  const raw = fs.readFileSync(card, 'utf8');
  assert.ok(raw.includes('（底线）我拒绝登录别人的抖音账号'), '规矩要标成底线，并转成第一人称');
  assert.ok(!/（近况）[^\n]*拒绝登录/.test(raw), '规矩不许被塞进近况');
  assert.ok(!raw.includes('那我也没办法'), '反问式的聊天碎片不进人设');
  assert.ok(raw.includes('【她自己的长期特征'), '区块标题说的是长期特征，不是近况');
});

test('evolve: 过期（退役）的记忆不再塑造人设', (t) => {
  // 2026-10-27：主人说「别总揪着妈妈背单词」，根子是那批「七点五十四抽查单词」的约定
  // 被写成一直生效的 promise trait。记忆设成过期后，演化不该再从它推出特征。
  const root = tmpRoot(t);
  const card = writeCard(root, `${CARD_HEAD}\n`);
  const store = fakeStore();
  store.rows = [
    { id: 11, subject: '小鲸鱼', text: '我约定每天七点五十四叫妈妈背单词', kind: 'promise', importance: 0.95, layer: 'private', expires_at: Date.now() - 1000 },
    { id: 12, subject: '小鲸鱼', text: '小鲸鱼喜欢听雨声', kind: 'preference', importance: 0.6, layer: 'private', expires_at: null }
  ];
  const evo = createEvolve({ root, store });
  evo.apply({ reason: '退役的不进人设' });

  const raw = fs.readFileSync(card, 'utf8');
  assert.ok(!raw.includes('背单词'), '过期记忆不许再变成特征');
  assert.ok(raw.includes('喜欢听雨声'), '没过期的照旧进人设');
});

test('evolve: 老表里错标成「喜欢/近况」的规矩，读回来时自动挪到「底线」', (t) => {
  const root = tmpRoot(t);
  writeCard(root, `${CARD_HEAD}\n`);
  const store = fakeStore();
  const a = createEvolve({ root, store });
  a.apply({ reason: '先写一版' });

  // 造一份 0.1.2 之前的老表：规矩被塞在 like / self 桶里（真机上就是这样）
  const traitsFile = path.join(root, 'state', 'persona-traits.json');
  const raw = JSON.parse(fs.readFileSync(traitsFile, 'utf8'));
  raw.traits.like = [{ text: '小鲸鱼拒绝登录或使用他人的抖音账号，只看公开页面。', weight: 0.95, source: 'memory', evidence: '记忆 #11（group）', at: 1 }];
  raw.traits.self = [
    { text: '不许半夜给别人打电话', weight: 0.8, source: 'memory', evidence: '', at: 1 },
    // 同一条内容存了第三人称与第一人称两份：读出来要合成一行，不能渲染两遍。
    { text: '群聊「大肥鱼之家」的名字取自小鲸鱼，ZealsHoW和🍇把小鲸鱼当女儿看待。', weight: 0.9, source: 'memory', evidence: '', at: 1 },
    { text: '群聊「大肥鱼之家」的名字取自我，ZealsHoW和🍇把我当女儿看待。', weight: 0.5, source: 'self', evidence: '', at: 1 },
  ];
  raw.traits.rule = [];
  // 老表里混着的聊天碎片（记忆推出来的）该被清掉；主人拍过板的建议一律保留。
  raw.traits.promise = [
    { text: '那我一会儿再来查你', weight: 1, source: 'memory', evidence: '记忆 #5（normal）', at: 1 },
    { text: '那好吧', weight: 0.7, source: 'owner-advice', evidence: '建议 #3', at: 1 },
  ];
  fs.writeFileSync(traitsFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

  const b = createEvolve({ root, store });
  const all = b.traits();
  const rules = all.filter((x) => x.kind === 'rule').map((x) => x.text);
  assert.equal(rules.length, 2, `两条规矩都该在「底线」里，实际：${JSON.stringify(rules)}`);
  assert.ok(!all.some((x) => x.kind === 'like' && /拒绝登录/.test(x.text)), '老错标要从「喜欢」里挪走');
  assert.ok(!all.some((x) => x.kind === 'self' && /不许半夜/.test(x.text)), '老错标要从「近况」里挪走');
  assert.ok(rules.some((t) => t.startsWith('我拒绝登录')), '老表里的第三人称要转成第一人称');
  assert.ok(!all.some((x) => /一会儿再来查你/.test(x.text)), '记忆推出来的聊天碎片要清掉');
  assert.ok(all.some((x) => x.source === 'owner-advice' && x.text === '那好吧'), '有人拍过板的建议不许清');
  const dupes = all.filter((x) => /大肥鱼之家/.test(x.text));
  assert.equal(dupes.length, 1, `同一条内容只能留一份，实际 ${dupes.length} 份`);
  assert.ok(dupes[0].text.includes('取自我'), '留下的应是第一人称那份');
  assert.equal(b.render().split('\n').filter((l) => /大肥鱼之家/.test(l)).length, 1, '渲染不能出现两行一样的话');
  assert.ok(b.render().includes('（底线）'), '渲染出来应标成底线');
});

test('evolve: 同一批候选重复演化不堆条目，也不重复写卡片备份', (t) => {
  const root = tmpRoot(t);
  const card = writeCard(root, `${CARD_HEAD}\n`);
  const store = fakeStore();
  const evo = createEvolve({ root, store, now: () => Date.parse('2026-10-21T04:30:00+08:00') });

  const first = evo.apply({ reason: '第一次' });
  const afterFirst = fs.readFileSync(card, 'utf8');
  const backups1 = evo.history().length;

  const second = evo.apply({ reason: '第二次' });
  const afterSecond = fs.readFileSync(card, 'utf8');

  assert.equal(second.added, 0, '第二次不应新增条目');
  assert.ok(second.updated >= 1, '第二次应只更新权重');
  assert.equal(afterFirst, afterSecond, '特征没变化时不应改动卡片');
  assert.equal(evo.history().length, backups1, '没写卡片就不该新增备份');
  assert.ok(first.auditId > 0 && second.auditId > 0, '每轮演化都要留审计');
});

test('evolve: 回滚能恢复到写卡片之前，且回滚本身也留审计', (t) => {
  const root = tmpRoot(t);
  const card = writeCard(root, `${CARD_HEAD}\n`);
  const store = fakeStore();
  const evo = createEvolve({ root, store, now: () => Date.parse('2026-10-21T04:30:00+08:00') });

  evo.apply({ reason: '第一版' });
  const withBlock = fs.readFileSync(card, 'utf8');
  assert.ok(withBlock.includes(CARD_BEGIN));

  // 再演化一次（新增一条候选），卡片会再次变化并留下备份
  const before2 = evo.cardBlock();
  evo.merge([{ kind: 'habit', text: '最近常熬夜', weight: 0.6, source: 'history' }], { actor: 'self' });
  const r = evo.apply({ reason: '第二版', candidates: [] });
  assert.equal(r.wroteCard, true, '区块变了就该写卡片');

  const rollback = evo.rollback({ reason: '测试回滚' });
  assert.equal(rollback.ok, true);
  const restored = fs.readFileSync(card, 'utf8');
  assert.ok(restored.includes(before2.slice(0, 12)) || restored.includes(CARD_BEGIN), '回滚后应恢复旧区块');
  assert.ok(!restored.includes('最近常熬夜'), '回滚应去掉新增特征');
  const audits = store.audits;
  assert.equal(audits[audits.length - 1].kind, 'rollback');
  assert.equal(audits[audits.length - 1].actor, 'owner');
});

test('evolve: 人格卡没有标记时追加区块，dry-run 不落盘', (t) => {
  const root = tmpRoot(t);
  const card = writeCard(root, `${CARD_HEAD}\n`);
  const store = fakeStore();
  const evo = createEvolve({ root, store, dryRun: true });
  const out = evo.apply({ reason: 'dry-run' });
  assert.equal(out.wroteCard, false);
  assert.equal(fs.readFileSync(card, 'utf8'), `${CARD_HEAD}\n`, 'dry-run 不许改卡片');
  assert.equal(fs.existsSync(path.join(root, 'state', 'persona-traits.json')), false, 'dry-run 不写特征表');

  const live = createEvolve({ root, store });
  const real = live.apply({ reason: '正式' });
  assert.equal(real.wroteCard, true);
  const raw = fs.readFileSync(card, 'utf8');
  assert.ok(raw.startsWith(CARD_HEAD.slice(0, 12)) && raw.includes(CARD_END));
});

test('evolve: 特征表跨实例持久化，区块能重新渲染出来', (t) => {
  const root = tmpRoot(t);
  writeCard(root, `${CARD_HEAD}\n`);
  const store = fakeStore();
  const a = createEvolve({ root, store });
  a.apply({ reason: '落盘' });
  const traitsFile = path.join(root, 'state', 'persona-traits.json');
  assert.equal(fs.existsSync(traitsFile), true);

  const b = createEvolve({ root, store });
  const block = b.render();
  assert.ok(block.includes('【她自己的长期特征'), '重渲染应给出注入块');
  assert.ok(b.traits().length >= 2, '重载后特征数量应保留');
});

test('intervene: 只有主人能提案，非主人被拒', (t) => {
  const root = tmpRoot(t);
  const iv = createIntervene({ root, now: () => Date.parse('2026-10-21T04:30:00+08:00') });

  const denied = iv.propose({ text: '以后别熬夜了', isOwner: false, from: '朋友' });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /只有主人/);
  assert.equal(iv.stats().total, 0, '被拒的提案不应入库');

  const ok = iv.propose({ text: '以后别熬夜了', isOwner: true, from: '爸爸', kind: 'habit' });
  assert.equal(ok.ok, true);
  assert.equal(iv.pendingCount(), 1);
  assert.equal(iv.get(ok.id).status, 'pending');
});

test('intervene: 采纳/拒绝/撤回都留理由，状态与持久化正确', async (t) => {
  const root = tmpRoot(t);
  const now = () => Date.parse('2026-10-21T04:30:00+08:00');
  const iv = createIntervene({ root, now });

  const a = iv.propose({ text: '说话可以更黏人一点', isOwner: true, from: '爸爸' });
  const b = iv.propose({ text: '少用颜文字', isOwner: true, from: '爸爸' });
  const c = iv.propose({ text: '少熬夜', isOwner: true, from: '爸爸' });

  const applied = await iv.apply(a.id, { actor: 'self', reason: '她愿意试', applyFn: (item) => `已并入：${item.text}` });
  assert.equal(applied.ok, true);
  assert.equal(iv.get(a.id).status, 'applied');
  assert.match(iv.get(a.id).result, /已并入/);

  const rejected = iv.reject(b.id, { actor: 'self', reason: '她自己喜欢用' });
  assert.equal(rejected.ok, true);
  assert.equal(iv.get(b.id).status, 'rejected');

  const withdrawn = iv.withdraw(c.id, { actor: 'owner' });
  assert.equal(withdrawn.ok, true);
  assert.equal(iv.get(c.id).status, 'withdrawn');
  assert.equal(iv.pendingCount(), 0);

  const again = iv.withdraw(c.id);
  assert.equal(again.ok, false, '已决的提案不能再撤回');

  const reopened = createIntervene({ root, now });
  assert.equal(reopened.stats().total, 3);
  assert.equal(reopened.get(a.id).status, 'applied');
  assert.equal(reopened.list({ status: 'applied' }).length, 1);
});

test('intervene: applyFn 抛错时保持待决，不误记成已采纳', async (t) => {
  const root = tmpRoot(t);
  const iv = createIntervene({ root });
  const p = iv.propose({ text: '试试看', isOwner: true, from: '爸爸' });
  const out = await iv.apply(p.id, { applyFn: () => { throw new Error('卡片写入失败'); } });
  assert.equal(out.ok, false);
  assert.equal(iv.get(p.id).status, 'pending', '失败必须留在待决，等重试');
  assert.match(iv.get(p.id).reason, /采纳失败/);
});

test('版本号登记一致', () => {
  assert.match(EVOLVE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(INTERVENE_VERSION, /^\d+\.\d+\.\d+$/);
});