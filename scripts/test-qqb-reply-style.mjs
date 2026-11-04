// 说话节奏（2026-11-04 主人要求）：一次只说一句 / 说完停一秒 / 精神值联动说得更短。
//   - 分句：句末标点断句，连着标点不拆（「真的吗？！」是一句），省略号不算句末
//   - 截句：多条气泡 → 只留第一句，多出来的计数
//   - 预算：精神值 → maxTokens / thinkMs（困了停更久）
//   - 接线：直连引擎这一轮真拿到 maxTokens、发之前截句、发完停一下
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { firstSentence, enforceSingleSentence, replyLimits, splitSentences } from '../src/qqb/persona/reply-style.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const bridge = read('src/bridge.js');
const version = read('src/qqb/version.mjs');

test('分句：句末标点断句，连着标点不拆，省略号不断句', () => {
  assert.deepEqual(splitSentences('好呀！我知道啦。那你去吧'), ['好呀！', '我知道啦。', '那你去吧']);
  assert.deepEqual(splitSentences('真的吗？！我不信……'), ['真的吗？！', '我不信……']);
  assert.deepEqual(splitSentences('嗯嗯\n好吧'), ['嗯嗯', '好吧']);
  assert.deepEqual(splitSentences('   '), []);
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('没有标点的一句话'), ['没有标点的一句话']);
});

test('截句：只留第一句，多出来的算砍掉', () => {
  assert.deepEqual(enforceSingleSentence(['好呀！我知道啦。', '那你去吧']), { texts: ['好呀！'], dropped: 2 });
  assert.deepEqual(enforceSingleSentence('嗯…好吧。那我去了'), { texts: ['嗯…好吧。'], dropped: 1 });
  assert.deepEqual(enforceSingleSentence([]), { texts: [], dropped: 0 });
  assert.deepEqual(enforceSingleSentence(['', '  ']), { texts: [], dropped: 0 });
  assert.equal(firstSentence('一二三四五六七八九十。后面还有'), '一二三四五六七八九十。');
  assert.equal(firstSentence('一二三四五六七八九十。后面还有', { maxChars: 4 }), '一二三四…');
});

test('预算：精神值越低，maxTokens 越少、停得越久', () => {
  const at = (s, extra = {}) => replyLimits(s, { rand: () => 0, ...extra });
  assert.equal(at(0.1).maxTokens, 128);
  assert.equal(at(0.3).maxTokens, 192);
  assert.equal(at(0.5).maxTokens, 320);
  assert.equal(at(0.7).maxTokens, 448);
  assert.equal(at(0.95).maxTokens, 512);
  // 字数上限复用 spirit.replyBudget 的口径，两处不会打架
  assert.equal(at(0.1).maxChars, 24);
  assert.equal(at(0.95).maxChars, 120);
  // 精神好 = 只有基础停顿；困 = 基础 + 随机一段（rand=1 取满）
  assert.equal(at(0.9, { rand: () => 1 }).thinkMs, 1000);
  assert.equal(at(0.9).tired, false);
  assert.equal(at(0.1, { rand: () => 1 }).tired, true);
  assert.equal(at(0.1, { rand: () => 1 }).thinkMs, 2500);
  assert.equal(at(0.29, { rand: () => 1 }).tired, true);
  assert.equal(at(0.29, { rand: () => 1 }).thinkMs, 1900);
  // 0.3 正好是边界（「低于 30%」才算累），不该被算进去
  assert.equal(at(0.3, { rand: () => 1 }).tired, false);
  assert.equal(at(0.3, { rand: () => 1 }).thinkMs, 1000);
  // 关掉停顿（thinkMs:0）也要能关干净
  assert.equal(at(0.1, { thinkMs: 0, rand: () => 1 }).thinkMs, 0);
  // 0/负数/字符串都要能收拾
  assert.equal(replyLimits(0, { rand: () => 0 }).maxTokens, 128);
  assert.equal(replyLimits('0.95', { rand: () => 0 }).maxTokens, 512);
});

test('接线：直连引擎带 maxTokens、发之前截句、发完停一下', () => {
  assert.match(bridge, /maxTokens: turnLimits\(\)\.maxTokens/, '这一轮把精神力度的 maxTokens 交给引擎');
  assert.match(bridge, /const text = oneLineReply\(sanitizeEngineReplyV2\(rawText\)/, '直连引擎发之前截成一句');
  assert.match(bridge, /await thinkPause\('直连引擎'\)/, '发完停一秒');
  assert.match(bridge, /planSocialTimeline\(oneLineReply\(plain, \{ where: 'agent 回复' \}\)/, '旧 agent 回复路径同样截句');
  assert.match(bridge, /【一次只说一句】/, '提示词里也讲清规则');
  assert.match(bridge, /【说完停一下】/, '提示词里交代停顿');
  assert.match(version, /'persona\/reply-style'/, '模块登记进版本表');
  // 2026-11-04：旧的【只说一句】/「在心里停一秒」和新的【一次只说一句】是同一件事的两种说法，
  // 两份一起注入会互相打架（一份让她自己想象停顿，一份说停顿由桥接做）⇒ 只留一份。
  assert.ok(!bridge.includes('【只说一句】'), '旧的【只说一句】应该删掉，只留【一次只说一句】');
  assert.ok(!bridge.includes('先在心里停大约一秒'), '旧的「在心里停一秒」应该删掉（真停顿在代码里）');
});