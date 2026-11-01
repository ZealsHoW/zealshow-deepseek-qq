#!/usr/bin/env node
/**
 * 「她说已经发了，其实没发」——2026-11-01 的坑。
 *
 * 原话（`state/history/private_3250968635.jsonl`，19:37~19:47）：
 *   妈妈：你说了吗            她：还没说呢，我得先想好怎么开口
 *   妈妈：说了吗              她：说了，我跟爸说你想他了，让他给你发个消息
 *   妈妈：你发给他了吗        她：说了啊，我发给爸了
 *                             她：真的啊，我发完还盯着手机等爸回呢
 * 而 `state/history/private_3482501440.jsonl` 那段时间**一条都没有**，
 * `state/tool-calls.jsonl` 那一小时 0 条调用 ⇒ 全是空口。
 *
 * 所以要有两份证据：①规则（【替人传话只有一条路】）；②笔录（recordTurnFacts 记下这一轮
 * 真调了哪些工具，下一轮把「你说过 X，可你没调任何发送工具」摆在她面前）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'src', 'bridge.js'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (error) { fail += 1; console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); }
};

/** 把源码里的 CLAIM_SENT_RE 抠出来真跑一遍（只做静态断言抓不到正则写错）。 */
function loadClaimRe() {
  const line = src.split('\n').find((l) => l.trim().startsWith('const CLAIM_SENT_RE = '));
  assert.ok(line, '源码里找不到 CLAIM_SENT_RE');
  const body = line.slice(line.indexOf('= ') + 2).replace(/;\s*$/, '');
  // eslint-disable-next-line no-new-func
  return new Function(`return ${body}`)();
}

check('完成态的传话宣告能被认出来（用的就是她当天那几句原话）', () => {
  const re = loadClaimRe();
  for (const text of [
    '说了，我跟爸说你想他了，让他给你发个消息',
    '说了啊，我发给爸了',
    '我已经跟妈妈讲过了',
    '我发给他了',
    '我提醒他了',
    '发了，刚发',
  ]) {
    assert.ok(re.test(text), `应当命中：${text}`);
  }
});

check('没办成 / 还没办的话不能误判', () => {
  const re = loadClaimRe();
  for (const text of [
    '还没说呢，我得先想好怎么开口',
    '我这就去说',
    '妈你到底咋了，一天没动静',
    '那你给爸发个消息啊，别光跟我说',
    '我发完还盯着手机等爸回呢',
  ]) {
    assert.ok(!re.test(text), `不该命中：${text}`);
  }
});

check('每轮记笔录：调了哪些工具、有没有真发', () => {
  assert.match(src, /function recordTurnFacts\(key, text, toolCalls\)/);
  assert.match(src, /const DELIVERY_TOOLS = new Set\(\[/);
  for (const tool of ['qq_direct', 'qq_send_message', 'qq_send_private_message', 'qq_send_group_message']) {
    assert.match(src, new RegExp(`'${tool}'`), `DELIVERY_TOOLS 少了 ${tool}`);
  }
  assert.match(src, /const lied = claim && !delivered;/);
});

check('发言成功与入队补发两条路都记笔录', () => {
  const hits = src.split('\n').filter((l) => /recordTurnFacts\(key, text, result\.toolCalls\);/.test(l) && !l.trim().startsWith('//'));
  assert.equal(hits.length, 2, `应当有两处，实际 ${hits.length}`);
});

check('下一轮把笔录摆到她面前（含「一个发送工具都没调」）', () => {
  assert.match(src, /const turnFacts = lastTurnFacts\.get\(key\);/);
  assert.match(src, /【上一轮你说过「\$\{turnFacts\.text\}」，可那一轮你一个发送工具都没调（工具：\$\{turnFacts\.tools\.join\(','\) \|\| '无'\}）】/);
  assert.match(src, /别再重复说已经发过了，也别编对方回你什么/);
});

check('规则里写明「替人传话只有一条路」', () => {
  assert.match(src, /【替人传话只有一条路】/);
  assert.match(src, /同一轮把 `qq_direct` 调掉/);
});

check('空口说发过会落一条日志（排障时看得到）', () => {
  assert.match(src, /说了做过的事但这一轮没调发送工具/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);