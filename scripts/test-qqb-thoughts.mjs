// scripts/test-qqb-thoughts.mjs —— 念头系统（qqb/persona/thoughts.mjs）的回归测试。
//
// 念头要解决的是「她像个任务机器」：以前的主动行为全是定时任务，现在让她自己冒出想法、
// 攒到一定欲望才真的去做。这里锁住：
//   1. 念头从哪来（没回的话/兴趣/记忆/身体感觉/随机）与欲望怎么算；
//   2. urge 高了才 due，且有冷却，别一天主动十次；
//   3. 做过就标记，不再重复；
//   4. 落盘 + 重启不丢，空上下文也不报错。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createThoughts } from '../src/qqb/persona/thoughts.mjs';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-thoughts-'));
  return path.join(dir, 'state', 'thoughts.json');
}

test('念头：从「还没回的话」里冒出来，并记下来源', () => {
  const thoughts = createThoughts({ now: () => 1790000000000, random: () => 0 });
  const item = thoughts.think({
    recent: [
      { text: '妈妈：今天好累啊', self: false },
      { text: '我：早点睡', self: true },
    ],
    spirit: 0.9,
    hunger: 0.1,
  });
  assert.ok(item.text.includes('今天好累'), `念头应来自对方没说尽的话：${item.text}`);
  assert.equal(item.source, 'unfinished');
  assert.ok(item.urge > 0.4, `想关心对方的欲望应该偏高，实际 ${item.urge}`);
  assert.equal(thoughts.recent(1)[0].id, item.id);
});

test('念头：兴趣与身体感觉都能独立成为来源', () => {
  const a = createThoughts({ now: () => 1790000000000, random: () => 0 });
  const hobby = a.think({ interests: ['唱歌'], spirit: 0.9, hunger: 0.1 });
  assert.equal(hobby.source, 'interest');
  assert.ok(hobby.text.includes('唱歌'));

  const b = createThoughts({ now: () => 1790000000000, random: () => 0 });
  const body = b.think({ recent: [], interests: [], memories: [], spirit: 0.9, hunger: 0.95 });
  assert.equal(body.source, 'body', '饿的时候应该先想到吃的');
});

test('念头：欲望低的不会触发主动行动，高的才会 due', () => {
  const t = 1790000000000;
  const thoughts = createThoughts({ now: () => t, random: () => 0.5 });
  const low = thoughts.think({ interests: ['编程'], spirit: 0.3, hunger: 0.9 });
  assert.ok(low.urge < 0.6, `又累又饿时不该很想去折腾，实际 ${low.urge}`);
  assert.equal(thoughts.due({ minUrge: 0.6 }), null);

  const high = thoughts.think({ recent: [{ text: '妈妈：你最近怎么不理我', self: false }], spirit: 1, hunger: 0 });
  assert.ok(high.urge >= 0.6, `精神好又有没回的话，欲望应该高，实际 ${high.urge}`);
  assert.equal(thoughts.due({ minUrge: 0.6 })?.id, high.id);
});

test('念头：做过就标记，冷却期内不会再来一次', () => {
  let t = 1790000000000;
  const thoughts = createThoughts({ now: () => t, random: () => 0 });
  const item = thoughts.think({ recent: [{ text: '妈妈：今天好累啊', self: false }], spirit: 1, hunger: 0 });
  assert.ok(thoughts.due({ minUrge: 0.5, cooldownMs: 30 * 60000 }));

  thoughts.markActed(item.id);
  assert.equal(thoughts.due({ minUrge: 0.5, cooldownMs: 30 * 60000 }), null, '刚做过就冷却');

  // 再过一小时、又冒出一个强念头，冷却结束后应当允许
  t += 3600000;
  const next = thoughts.think({ recent: [{ text: '妈妈：在吗', self: false }], spirit: 1, hunger: 0 });
  assert.ok(next.urge > 0.5);
  assert.equal(thoughts.due({ minUrge: 0.5, cooldownMs: 30 * 60000 })?.id, next.id);
});

test('念头：太久以前的强念头不再追（超过 6 小时作废）', () => {
  let t = 1790000000000;
  const thoughts = createThoughts({ now: () => t, random: () => 0 });
  const item = thoughts.think({ recent: [{ text: '妈妈：晚安', self: false }], spirit: 1, hunger: 0 });
  assert.ok(item.urge >= 0.6);
  t += 7 * 3600000;
  assert.equal(thoughts.due({ minUrge: 0.6 }), null);
});

test('念头：落盘重开还在，摘要给提示词用', () => {
  const file = tempFile();
  const t = 1790000000000;
  const a = createThoughts({ file, now: () => t, random: () => 0 });
  a.think({ recent: [{ text: '爸爸：周末去看电影吧', self: false }], spirit: 1, hunger: 0 });
  assert.ok(fs.existsSync(file));

  const b = createThoughts({ file, now: () => t });
  const items = b.snapshot().items;
  assert.equal(items.length, 1);
  assert.match(b.summaryText(3), /周末去看电影|惦记|想/);
});

test('念头：空上下文也能生成，坏文件不抛', () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'not json at all', 'utf8');
  const thoughts = createThoughts({ file });
  assert.ok(thoughts.snapshot().items.length === 0);
  const item = thoughts.think({});
  assert.ok(item && item.text, '什么都不给也该冒出一个泛泛的念头');
});
