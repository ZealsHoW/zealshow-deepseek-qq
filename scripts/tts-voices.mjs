#!/usr/bin/env node
/**
 * 本机语音合成（Windows 自带 SAPI5 / OneCore）的小工具。
 *
 * 用法：
 *   node scripts/tts-voices.mjs                 # 列出本机可用的合成声音
 *   node scripts/tts-voices.mjs "你好呀"         # 用默认（中文）声音合成一条，落在 audio/
 *   node scripts/tts-voices.mjs "你好呀" Kangkang # 指定音色
 *
 * 它只做两件事：看有哪些声音、把一句话合成为 wav。**不发送**任何消息 ——
 * 要真发到 QQ 上，走 `send-voice.mjs`（操作者通道）或让 AI 调 `qq_send_voice`（text 通道）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeToFile, listTtsVoices, ttsAvailable, powershellPath } from '../src/qqb/tts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [text = '', voice = ''] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

console.log(`PowerShell: ${powershellPath()}`);
console.log(`本机可用:   ${ttsAvailable() ? '是' : '否（只有 Windows 自带声音可用）'}`);

const info = await listTtsVoices();
if (!info.ok) {
  console.error(`拿不到声音列表：${info.error}`);
  process.exit(1);
}
const zh = (v) => /Huihui|Kangkang|Yaoyao|Xiaoxiao|Hanhan/i.test(v);
console.log('\nSAPI5（经典，兼容性最好）:');
for (const v of info.sapi) console.log(`  ${zh(v) ? '★' : ' '} ${v}`);
console.log('OneCore（新引擎，声音通常更多）:');
for (const v of info.onecore) console.log(`  ${zh(v) ? '★' : ' '} ${v}`);
console.log('\n★ = 常见中文声音；不指定音色时优先挑中文。');

if (!text.trim()) {
  console.log('\n想听一句：node scripts/tts-voices.mjs "你好呀，我是小鲸鱼" [音色名]');
  process.exit(0);
}

const dir = path.join(ROOT, 'audio');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const out = path.join(dir, `tts-sample-${stamp}.wav`);
try {
  const made = await synthesizeToFile({ text, outPath: out, voice });
  console.log(`\n✅ 合成好了：${made.path}`);
  console.log(`   引擎 ${made.engine} / 声音 ${made.voice || '(默认)'} / ${made.bytes} 字节`);
  console.log('   想发到 QQ：把文件名（不含 audio/ 前缀）交给操作者通道 send-voice.mjs，或让 AI 用 qq_send_voice 的 text 通道重说一遍。');
} catch (error) {
  console.error(`\n❌ 合成失败：${error?.message ?? error}`);
  process.exit(1);
}