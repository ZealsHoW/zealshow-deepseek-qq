#!/usr/bin/env node
/**
 * 图片 / 语音 / 自带表情的「出场率」——2026-11-01 主人两条要求：
 *   ①「她现在也不会自己主动发图片」→「提高发送图片、语音的概率」
 *   ②「有的表情包也可以重复发，比如感觉要睡觉时就发一张 assets/goodnight-whale.png」
 *
 * 事实：`state/tool-calls.jsonl` 里 `qq_send_image` 从 10-26 起每天 0~2 次，10-31 之后是 0；
 * `qq_send_voice` 一次都没自己调过。工具都在 prompt 里写着，她只是一轮轮专心打字。
 * 所以既有「节奏纸条」（概率 + 冷却），也要让自带表情真的能发（收藏表情库只有 url，本地文件发不出去）。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const src = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (error) { fail += 1; console.log(`FAIL ${name}`); console.log(`     ${error?.message ?? error}`); }
};

check('节奏配置有默认值，且能被 config.json 的 socialV2.media.nudge 关掉', () => {
  assert.match(src, /function mediaNudgeConfig\(\)/);
  assert.match(src, /const raw = cfg\?\.socialV2\?\.media\?\.nudge;/);
  assert.match(src, /imageChance: Math\.min\(1, Math\.max\(0, num\(n\.imageChance, 0\.22\)\)\)/);
  assert.match(src, /voiceChance: Math\.min\(1, Math\.max\(0, num\(n\.voiceChance, 0\.14\)\)\)/);
  assert.match(src, /if \(!n\.enabled\) return '';/);
});

check('冷却：刚发过就不递纸条；太久没发会抬概率', () => {
  assert.match(src, /const imageFresh = now - rh\.lastImageAt < n\.imageCooldownMin \* 60000;/);
  assert.match(src, /const voiceFresh = now - rh\.lastVoiceAt < n\.voiceCooldownMin \* 60000;/);
  assert.match(src, /n\.imageChance \+ n\.staleBoost/);
  assert.match(src, /n\.voiceChance \+ n\.staleBoost/);
});

check('仪式类唤醒不递纸条（日记/问安/追办）', () => {
  assert.match(src, /if \(reason === 'diaryRitual' \|\| reason === 'nightGreet' \|\| reason\.startsWith\('directiveFollowUp'\)\) return '';/);
});

check('纸条内容：图给 qq_generate_image / qq_image_search，语音给 qq_send_voice', () => {
  assert.match(src, /const MEDIA_NUDGE_IMAGE = \[/);
  assert.match(src, /`qq_generate_image` 画一张/);
  assert.match(src, /`qq_image_search` 找一张现成的/);
  assert.match(src, /const MEDIA_NUDGE_VOICE = \[/);
  assert.match(src, /`qq_send_voice\(text="…"\)` 真发一条语音/);
});

check('这一轮真发了图/语音，节奏表会记住（用于冷却）', () => {
  assert.match(src, /const IMAGE_TURN_TOOLS = new Set\(\['qq_send_image', 'qq_send_sticker', 'qq_generate_image'\]\);/);
  assert.match(src, /const VOICE_TURN_TOOLS = new Set\(\['qq_send_voice', 'qq_sing', 'qq_sing_send'\]\);/);
  assert.match(src, /if \(tools\.some\(\(t\) => IMAGE_TURN_TOOLS\.has\(t\)\)\) rh\.lastImageAt = now;/);
  assert.match(src, /if \(tools\.some\(\(t\) => VOICE_TURN_TOOLS\.has\(t\)\)\) rh\.lastVoiceAt = now;/);
});

check('直连引擎的提示词里真的会带这张纸条', () => {
  assert.match(src, /const mediaHint = mediaNudgeLine\(key, reason\);\s*\n\s*if \(mediaHint\) bits\.push\(mediaHint\);/);
});

check('自带表情：晚安鲸鱼指向 assets/goodnight-whale.png，且文件真的在', () => {
  assert.match(src, /id: 'local-goodnight-whale'/);
  assert.match(src, /alias: 'goodnight-whale'/);
  assert.match(src, /path\.join\(ROOT, 'assets', 'goodnight-whale\.png'\)/);
  assert.ok(fs.statSync(path.join(root, 'assets', 'goodnight-whale.png')).isFile(), 'assets/goodnight-whale.png 不存在');
});

check('自带表情能发出去：收藏库找不到时回落本地文件（不是只认 url）', () => {
  assert.match(src, /\|\| findLocalSticker\(stickerRef\);/);
  assert.match(src, /if \(!url && entry\.source !== 'local'\) throw new Error/);
  assert.match(src, /if \(entry\.source === 'local'\) \{\s*\n\s*const buf = fs\.readFileSync\(entry\.filePath\);/);
});

check('内置表情也出现在 qq_list_stickers 的返回里', () => {
  assert.match(src, /const entries = \[\.\.\.localStickerEntries\(\), \.\.\.\(synced\?\.entries \?\? stickerEntries\)\];/);
  // 路由里那三处 list 也要合并，否则她 qq_list_stickers 拿到的是空列表（2026-11-01 实测 items=0）
  const routeLists = src.split('\n').filter((line) => line.includes('formatStickerList(') && line.includes('localStickerEntries()'));
  assert.ok(routeLists.length >= 3, `合并本地表情的调用点只有 ${routeLists.length} 处`);
});

check('source 放行 local（否则列表里显示成 QQ 收藏表情）', () => {
  const lib = fs.readFileSync(path.join(root, 'src', 'sticker-lib.js'), 'utf8');
  assert.ok(lib.includes("['manual', 'ai', 'local'].includes(entry.source)"), 'sticker-lib 没有放行 local');
});

check('自带表情发完，消息记录里带名字而不是「表情包」', () => {
  assert.match(src, /if \(entry\.source === 'local'\) \{\s*\n\s*return \{ entry, messageId: data\?\.message_id \?\? null \};/);
});

check('规则里教了她：自带表情可以天天发，尤其晚安鲸鱼', () => {
  assert.match(src, /【自带表情可以天天发】/);
  assert.match(src, /`local-goodnight-whale`（晚安鲸鱼，困了\/要睡\/道晚安时发，天天重复也不奇怪）/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);