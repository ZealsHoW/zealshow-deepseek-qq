#!/usr/bin/env node
// 音色微调：把参考音频做**小幅**变调 / 轻 EQ，再各合成一条试听句，听完挑一版。
//
// 为什么要这个脚本
// ────────────────
// GPT-SoVITS 的「音色」八成来自参考音频（refAudio）：参考里嗓子多高多亮，出来的就是那样。
// 换参考、重克隆是大改；主人说「在原来那版附近小调一下」时，能动的其实是三个旋钮：
//   ① 参考音频变调（asetrate + atempo，只动音高不动时长）
//   ② 参考音频的轻 EQ（低中频抬一点、4kHz 压一点 = 少些齿音/尖利）
//   ③ 合成参数（speedFactor / temperature / topK）
// 这个脚本把 ①② 做成扫参、每版合成一句同样的话；③ 沿用 config.json 里现有的值，保证只改一处。
//
// 用法（在 qq-bridge 目录下）：
//   node scripts/voice-tune.mjs --ref audio/ref/dyf-7s-soft.wav --pitch 0,-1,-2 --warm
//   node scripts/voice-tune.mjs --ref audio/ref/dyf-7s-soft.wav --pitch -2 --text "换一句话试试"
// 产物都在 audio/tune/ 下（audio/ 已在 .gitignore 里）：
//   ref-m2.wav       变调后的参考音频
//   probe-m2.wav     用它合成的试听句（每版用同一句话，才好横向比）
//
// 变调数学：降 n 个半音 = 重采样比率 2^(-n/12)，时长会变长 1/比率倍，再用 atempo 拉回去。
// 降 2 个半音 ≈ 比率 0.8909、atempo 1.1225；降 12 个半音正好是比率 0.5、atempo 2。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { synthesizeWithGptSoVits } from '../src/qqb/tts-gptsovits.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** "0,-1,-2" → [0, -1, -2]；容忍中文逗号、空格、+2 这种写法。 */
export function parsePitchList(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [0];
  const list = raw
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
  if (list.some((n) => !Number.isFinite(n))) throw new Error(`--pitch 里有不是数字的项：${raw}`);
  // 一次调超过一个八度就不是「小幅调整」了，clamp 掉免得把参考音频弄坏。
  return [...new Set(list.map((n) => Math.max(-11, Math.min(11, Math.round(n)))))];
}

/** 变调滤镜：降 semitones 个半音，再把时长补回去。 */
export function pitchFilter(semitones, sampleRate = 32000) {
  const n = Number(semitones) || 0;
  const ratio = Math.pow(2, n / 12);
  const atempo = 1 / ratio;
  return `asetrate=${sampleRate}*${ratio.toFixed(4)},aresample=${sampleRate},atempo=${atempo.toFixed(4)}`;
}

/** 轻 EQ：200Hz 抬 2dB（多点胸腔感）、4kHz 压 2dB（齿音/尖利少一点）。 */
export function warmFilter() {
  return 'equalizer=f=200:t=q:w=1:g=2,equalizer=f=4000:t=q:w=1:g=-2';
}

/** 变体名：p2 = 升 2 个半音，m2 = 降 2 个半音，后缀 -warm = 加了 EQ。 */
export function variantName(semitones, warm = false) {
  const n = Math.round(Number(semitones) || 0);
  const base = n === 0 ? 'p0' : n > 0 ? `p${n}` : `m${-n}`;
  return warm ? `${base}-warm` : base;
}

/** 一版要跑的完整滤镜链（变调 → 暖化）。 */
export function tuneFilter(semitones, warm = false, sampleRate = 32000) {
  return [pitchFilter(semitones, sampleRate), warm ? warmFilter() : ''].filter(Boolean).join(',');
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function resolveFfmpeg(cfg, override) {
  const fromArg = String(override ?? '').trim();
  if (fromArg) return fromArg;
  const fromCfg = String(cfg?.socialV2?.voice?.ffmpegPath ?? '').trim();
  return fromCfg || 'ffmpeg';
}

function runFfmpeg(ffmpeg, args) {
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`调用 ffmpeg 失败（${ffmpeg}）：${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg 退出码 ${r.status}：${String(r.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
}

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags.set(k, v);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags.set(k, argv[++i]);
    else flags.set(k, true);
  }
  return flags;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const cfg = readConfig();
  const gpts = cfg?.socialV2?.voice?.tts?.gptsovits ?? {};
  const ref = path.resolve(ROOT, String(flags.get('ref') || gpts.refAudio || '').trim());
  if (!ref || !fs.existsSync(ref)) throw new Error(`参考音频不存在：${ref}（用 --ref 指定，或先在 config.json 里配好）`);
  const refText = String(flags.get('ref-text') || gpts.refText || '').trim();
  if (!refText) throw new Error('缺少参考音频对应的文字（--ref-text 或 config.json 的 refText）');
  const text = String(flags.get('text') || '主人，你听，这是我的声音。你觉得这样说话好听吗？');
  const pitches = parsePitchList(flags.get('pitch') ?? '0,-2');
  // 带 --warm 就每个音高各跑「原样」和「加了轻 EQ」两版，方便直接 A/B。
  const warms = flags.has('warm') ? [false, true] : [false];
  const outDir = path.resolve(ROOT, String(flags.get('out-dir') || 'audio/tune'));
  const ffmpeg = resolveFfmpeg(cfg, flags.get('ffmpeg'));
  const sampleRate = Math.max(8000, Number(gpts.sampleRate) || 32000);
  fs.mkdirSync(outDir, { recursive: true });

  const rows = [];
  for (const pitch of pitches) {
    for (const warm of warms) {
      const name = variantName(pitch, warm);
      const refOut = path.join(outDir, `ref-${name}.wav`);
      const probeOut = path.join(outDir, `probe-${name}.wav`);
      const t0 = Date.now();
      runFfmpeg(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', ref,
        '-filter:a', tuneFilter(pitch, warm, sampleRate), '-ac', '1', '-ar', String(sampleRate), refOut]);
      rows.push({
        name, pitch, warm, refOut, probeOut,
        refBytes: fs.statSync(refOut).size,
        settings: {
          baseUrl: String(gpts.baseUrl || 'http://127.0.0.1:9880'),
          textLang: String(gpts.textLang || 'zh'),
          promptLang: String(gpts.promptLang || 'zh'),
          refAudio: refOut,
          refText,
          speedFactor: Number(gpts.speedFactor) || 1,
          temperature: Number(gpts.temperature) || 1,
          topK: Number(gpts.topK) || 15,
          topP: Number(gpts.topP) || 1,
          mediaType: String(gpts.mediaType || 'wav'),
        },
        ffmpegMs: Date.now() - t0,
      });
    }
  }
  console.log(`参考：${ref}\n文字：${text}\n输出：${outDir}`);

  (async () => {
    for (const row of rows) {
      try {
        const r = await synthesizeWithGptSoVits({ text, outPath: row.probeOut, root: ROOT, timeoutMs: Number(gpts.timeoutMs) || 120000, settings: row.settings });
        console.log(`  ${row.name.padEnd(9)} 参考 ${(row.refBytes / 1024).toFixed(0)}KB → ${path.basename(row.probeOut)} ${(r.bytes / 1024).toFixed(0)}KB`);
      } catch (error) {
        console.log(`  ${row.name.padEnd(9)} 合成失败：${error?.message ?? error}`);
      }
    }
    console.log(`\n听完挑一版，把 config.json 的 socialV2.voice.tts.gptsovits.refAudio 指到对应 ref-*.wav（相对路径用 audio/tune/ref-xxx.wav）。`);
  })();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`voice-tune: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}