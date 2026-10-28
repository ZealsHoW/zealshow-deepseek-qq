// 上下文折叠（PANDORA_SPEC §7）回归：70% 触发、保留最近、摘要带情绪、坏输入不抛、接进 loop.run。
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldHistory, estimateTokens, summarizeDropped, emotionTone } from '../src/qqb/engine/compact.mjs';
import { createAgentLoop } from '../src/qqb/engine/loop.mjs';

function longHistory(count, each = '这是一句很长的对话内容，用来把上下文顶到上限，反复出现也没关系。') {
  return Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}: ${each}` }));
}

test('estimateTokens：中文按字、英文按四字符，粗估不小气', () => {
  assert.equal(estimateTokens('你好'), 2);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('他三个小时没回消息，我盯着屏幕') >= 15);
});

test('没到 70% 就一个字都不动', () => {
  const history = longHistory(3, '短句');
  const r = foldHistory(history, { budgetTokens: 4000 });
  assert.equal(r.folded, false);
  assert.equal(r.messages.length, history.length);
  assert.equal(r.summary, '');
});

test('超过 70% 折叠最老那一段，最近 keepRecent 条原样保留', () => {
  const history = longHistory(120);
  const r = foldHistory(history, { budgetTokens: 2000, keepRecent: 10 });
  assert.equal(r.folded, true);
  assert.ok(r.dropped > 0);
  assert.equal(r.messages.length, 1 + (history.length - r.dropped));
  // 最近 10 条连内容一起在
  const tail = history.slice(-10);
  assert.deepEqual(r.messages.slice(-10), tail);
  // 折叠后确实小了
  assert.ok(r.tokensAfter < r.tokensBefore);
  // 摘要排在最前面，并明确标注「只是背景」
  assert.equal(r.messages[0].role, 'system');
  assert.match(r.messages[0].content, /^【更早的事】/);
  assert.match(r.messages[0].content, /只是背景，不要当成对方刚说的话/);
});

test('摘要取窗口里最后一条有内容的话 + 整段情绪基调', () => {
  const summary = summarizeDropped([
    { role: 'user', content: '今天下雨了' },
    { role: 'assistant', content: '我有点想哭，可是又觉得没什么' },
    { role: 'user', content: '别难受了' },
  ]);
  // 窗口越靠后越接近现在的语境，所以核心事件取最后一条；情绪取整段基调。
  assert.match(summary, /^【更早的事】对方说到「别难受了」/);
  assert.match(summary, /当时的情绪：难受/);
  assert.match(summary, /另有 2 条更早的对话已折叠/);
  const onlyHer = summarizeDropped([{ role: 'assistant', content: '我好想你' }]);
  assert.match(onlyHer, /^【更早的事】她说到/);
  assert.equal(emotionTone('太开心了，笑死'), '开心');
  assert.equal(emotionTone('平平无奇'), '平常');
});

test('坏输入不抛：空数组、null、缺 content、非数组', () => {
  for (const input of [[], null, undefined, 'x', [null, {}, { content: '' }]]) {
    const r = foldHistory(input, { budgetTokens: 500 });
    assert.equal(r.folded, false);
    assert.ok(Array.isArray(r.messages));
    assert.equal(r.dropped, 0);
  }
});

test('历史比 keepRecent 还短时绝不折叠（否则会把整段历史折没）', () => {
  const history = longHistory(6);
  const r = foldHistory(history, { budgetTokens: 200, keepRecent: 12 });
  assert.equal(r.folded, false);
  assert.equal(r.messages.length, 6);
});

test('接进 loop.run：超预算的 history 被折叠，模型收到的是摘要 + 最近几条', async () => {
  const seen = [];
  const model = {
    async complete({ messages }) {
      seen.push(messages);
      return { ok: true, text: '嗯', toolCalls: [], usage: null, finishReason: 'stop' };
    },
  };
  const toolbox = {
    async refresh() {},
    catalog: () => [],
    find: () => undefined,
    call: async () => ({ ok: true }),
  };
  const loop = createAgentLoop({ model, toolbox });
  const history = longHistory(90);
  const result = await loop.run({
    system: '你是小鲸鱼',
    user: '在吗',
    history,
    historyBudgetTokens: 1500,
    historyKeepRecent: 8,
  });
  assert.equal(result.ok, true);
  assert.equal(result.compact.folded, true);
  const sent = seen[0];
  const historyPart = sent.slice(1, sent.length - 1); // 去掉 system 与最后的 user
  assert.match(historyPart[0].content, /【更早的事】/);
  // 折叠到预算的 55% 左右为止：保留条数 = 原条数 − 被折掉的条数，且至少保住最近 8 条。
  assert.equal(historyPart.length - 1, 90 - result.compact.dropped);
  assert.ok(historyPart.length - 1 >= 8);
  assert.ok(result.compact.tokensAfter < result.compact.tokensBefore);
  assert.equal(sent[sent.length - 1].content, '在吗');
});

console.log('✅ qqb 上下文折叠（P4）测试通过');