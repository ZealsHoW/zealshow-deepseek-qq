#!/usr/bin/env node
// 语音「探测时长」这条链路的回归。
//
// 背景（2026-10-24）：发完第一首 ACE-Step 生成的歌时，send-voice 打了一行
//   ⚠️ 无法探测时长（ffprobe 不可用：spawn ffprobe ENOENT）
// 一查发现是**三重**问题叠在一起，而且全都不报错、只是「悄悄少一道闸」：
//   1. ffprobe 在 PATH 里没有（本机只有 GPT-SoVITS 自带的那份 zip，ffmpeg/ffprobe 同目录）；
//   2. 配置里只写了 ffmpegPath，代码却只按裸名找 ffprobe，从没想到「问一下 ffmpeg 在哪」；
//   3. 就算找到了 ffprobe，旧实现传的是 `-o outFile`——ffprobe 根本没有这个参数
//      （`-o` 是 ffmpeg 的），于是每次退出码 1、临时文件一个字节都不产，时长校验被静默跳过。
//
// 所以这里断言：ffprobe 会顺着 ffmpeg 找、stdout 直接写句柄（不经过 pipe，受限沙箱也活）、
// 参数里没有 `-o`，且探测真能跑出时长。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectAudio,
  resolveFfprobe,
  resolveFfmpeg
} from '../src/voice-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? `（${extra}）` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? `（${extra}）` : ''}`); }
}

const coreSrc = fs.readFileSync(path.join(ROOT, 'src', 'voice-core.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const sendSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'send-voice.mjs'), 'utf8');

console.log('## ffprobe 的定位（顺着 ffmpeg 找）');
ok(/export function resolveFfprobe/.test(coreSrc), '导出了 resolveFfprobe');
ok(/resolveFfprobe[\s\S]{0,900}?path\.dirname\(ffmpeg\)/.test(coreSrc), '会问「ffmpeg 在哪」，取它的目录');
ok(/resolveFfprobe[\s\S]{0,900}?'ffprobe\.exe'/.test(coreSrc), '同目录里找 ffprobe.exe（Windows 官方 zip 就是这样）');
ok(/resolveFfprobe[\s\S]{0,900}?return 'ffprobe'/.test(coreSrc), '实在找不到才回退裸名（交给 PATH）');
ok(/export async function inspectAudio[\s\S]{0,400}?ffmpegPath = null/.test(coreSrc), 'inspectAudio 接受 ffmpegPath');
ok(/probeAudio\(file, \{ ffprobePath: resolveFfprobe\(\{ ffprobePath, ffmpegPath \}\) \}\)/.test(coreSrc),
  'inspectAudio 探测前会解析一次（调用方只给 ffmpegPath 也够）');

console.log('## ffprobe 的调用（不用 pipe、也不许有 -o）');
ok(!/'-o', outFile/.test(coreSrc), '参数里没有 `-o outFile`（ffprobe 没这个参数）');
ok(/stdio: \['ignore', fd, 'ignore'\]/.test(coreSrc), 'stdout 直接写文件句柄（绕过 pipe，受限沙箱可用）');
ok(/fs\.openSync\(outFile, 'w'\)/.test(coreSrc), '自己 open 目标文件拿 fd');
ok(/'-show_entries', 'format=duration,format_name:stream=codec_name,codec_type,sample_rate,channels'/.test(coreSrc),
  '只传一次 -show_entries（两次会互相覆盖）');
ok(/child\.on\('close'/.test(coreSrc), '结果在 close 之后读（进程真的退出了）');
ok(/finish\b/.test(coreSrc) && /settled/.test(coreSrc), '超时/错误/关闭只结算一次（不重复 resolve）');

console.log('## 调用点把 ffmpegPath 带下去');
{
  const bridgeCalls = [...bridgeSrc.matchAll(/inspectAudio\([^)]*\)/g)].map((m) => m[0]);
  ok(bridgeCalls.length >= 4, `bridge.js 里 inspectAudio 调用点 ${bridgeCalls.length} 处`);
  const missing = bridgeCalls.filter((c) => !/ffmpegPath:/.test(c));
  ok(missing.length === 0, '每处都带 ffmpegPath', missing.length ? `${missing.length} 处遗漏` : '');
  ok(/ffmpegPath: vc\.ffmpegPath/.test(bridgeSrc) || /ffmpegPath: voice\.ffmpegPath/.test(bridgeSrc),
    '发送路径上用 voiceCfg.ffmpegPath');
  ok(/const voiceCfg = cfg\.socialV2\?\.voice \|\| cfg\.voice \|\| \{\}/.test(sendSrc),
    'send-voice 认 socialV2.voice（旧版才在顶层 voice）');
  ok(/ffmpegPath: val\('ffmpeg', process\.env\.FFMPEG_PATH \|\| voiceCfg\.ffmpegPath/.test(sendSrc),
    'send-voice 的 ffmpegPath 来自配置/环境变量');
}

console.log('## 真实探测（本机装了 ffmpeg 才算）');
{
  const cfgPath = path.join(ROOT, 'config.json');
  let configuredFfmpeg = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    configuredFfmpeg = cfg.socialV2?.voice?.ffmpegPath || cfg.voice?.ffmpegPath || null;
  } catch {}
  const ffmpeg = resolveFfmpeg({ ffmpegPath: configuredFfmpeg });
  if (ffmpeg === 'ffmpeg') {
    console.log('  ⏭ 没有配置 ffmpegPath、PATH 里也没有 ffmpeg，跳过实际探测');
  } else {
    const probe = resolveFfprobe({ ffmpegPath: configuredFfmpeg });
    ok(probe !== 'ffprobe' && fs.existsSync(probe), '解析出了真实存在的 ffprobe', probe);
    ok(probe === path.join(path.dirname(ffmpeg), path.basename(probe)), 'ffprobe 与 ffmpeg 同目录');

    const sample = path.join(ROOT, 'audio', 'sing-test.wav');
    if (!fs.existsSync(sample)) {
      console.log(`  ⏭ 没有样本音频 ${path.relative(ROOT, sample)}，跳过时长探测`);
    } else {
      const info = await inspectAudio(sample, { ffmpegPath: configuredFfmpeg });
      ok(info.ok, '样本音频可检（ok）', info.error ?? '');
      ok(Number(info.duration) > 0, '探测出了时长（不再静默跳过）', `${Number(info.duration).toFixed(2)}s`);
      ok(!(info.warnings ?? []).some((w) => /无法探测时长/.test(w)), '没有「无法探测时长」警告');
      ok(/pcm|mp3|aac|flac/.test(info.codec || ''), '识别出了编码', info.codec || '(空)');
    }
  }
}

console.log(`\n结果：${pass} 通过 ${fail} 失败`);
process.exit(fail ? 1 : 0);