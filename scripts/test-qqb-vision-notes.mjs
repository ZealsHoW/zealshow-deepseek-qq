#!/usr/bin/env node
/**
 * 「别人发来的图，她得真的看见」——2026-11-01 的坑。
 *
 * 现象：主人早上连发两张火锅照片，她先回「我看看你发的啥」，半小时后回
 * 「图没刷出来，你发的啥啊」；妈妈发的早安图她只能说「这图我看不太清」。
 * 根因不是视觉模型坏了（`qq_describe_image` 调得通，连菜单上的「盛香亭」都读得出来），
 * 是**她的 prompt 里只有「[图片]」三个字**：没有 messageId，也没有内容，
 * 她手上一个抓手都没有 —— 想调用工具都不知道传什么。
 *
 * 所以断言两件事：
 *   1. 收图后在后台真的去看了（appendSocialV2Message → describeInboundImage → toolbox.call）；
 *   2. 拼 prompt 时把结果贴进去；还没看完就把 messageId 交给她，并允许她说「看不清」。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'bridge.js');
const src = fs.readFileSync(srcPath, 'utf8');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${error?.message ?? error}`);
  }
}

check('收图后在后台调视觉（不阻塞收消息）', () => {
  assert.match(src, /if \(msg\.messageId && \(msg\.media \|\| \[\]\)\.some\(\(m\) => m && m\.kind === 'image'\)\) void describeInboundImage\(key, msg\.messageId\);/);
});

check('只有真图才看图（表情/市场表情不花这次调用）', () => {
  assert.doesNotMatch(src, /if \(msg\.hasMedia && msg\.messageId\) void describeInboundImage/);
  assert.match(src, /m\.kind === 'image'/);
});

check('后台看图走的是 qq_describe_image，并带上会话与 messageId', () => {
  assert.match(src, /rt\.toolbox\.call\('qq_describe_image', \{ messageId, key \}\)/);
});

check('看完的结果按 key|messageId 缓存，重复收图不重复看', () => {
  assert.match(src, /const inboundImageNotes = new Map\(\);/);
  assert.match(src, /const known = inboundImageNotes\.get\(id\);\s*\n\s*if \(known\) return;/);
});

check('看完才贴进 prompt（pending 的不算）', () => {
  assert.match(src, /function inboundImageNote\(key, messageId\) \{[\s\S]{0,240}if \(!hit \|\| hit\.pending \|\| !hit\.text\) return '';/);
});

check('prompt 里：看完的贴内容，没看完的给她 messageId 与「看不清就说看不清」', () => {
  assert.match(src, /【\$\{String\(lastMsg\.sender \|\| '他'\)\}发来的图，你已经看过图了】/);
  assert.match(src, /【\$\{String\(lastMsg\.sender \|\| '他'\)\}发来一张图，你还没看清】/);
  assert.match(src, /真看不清就直说看不清，别猜图里是什么/);
  assert.match(src, /qq_describe_image\(\$\{\[mid, `key="\$\{key\}"`\]/);
});

check('缓存有上界（不会无限堆）', () => {
  assert.match(src, /if \(inboundImageNotes\.size > 80\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);