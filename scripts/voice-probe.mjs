// 用指定参考音频合成一句「探针」，用来横向比音色 —— 挑选参考片段（scripts/pick-ref-segment.py）
// 之后，每个候选都合成同一句话，量出来才可比。
//
// 用法：
//   node scripts/voice-probe.mjs --ref audio/cand/seg-01-33p00-39p00.wav \
//        --ref-text "这个可以买吗？我感觉跟我还挺像的，好像还有更大的好可爱。"
//   node scripts/voice-probe.mjs --ref audio/ref/xiaojing-6s.wav --ref-text "<同一段逐字文本>" \
//        --text "自定义探针台词" --out audio/cand/probe.wav
//
// 说明：
//  - refText 必填：GPT-SoVITS 靠它对齐音素，给错字会吞字、改调，比不给还糟（所以不做「自动转写」兜底）。
//  - 音频服务与合成参数（baseUrl / speedFactor / temperature / topK / topP / Lang）全部沿用
//    config.json 里的 socialV2.voice.tts.gptsovits，只覆盖 refAudio / refText 两项 ——
//    这样探针和线上是同一套参数。
//  - 产物默认落在 audio/cand/probe-<参考名>.wav；audio/ 已被 .gitignore 忽略。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gptsovitsSettings, synthesizeWithGptSoVits, gptsovitsProblems } from '../src/qqb/tts-gptsovits.mjs';

export const DEFAULT_TEXT = '主人，你听，这是我的声音。你觉得这样说话好听吗？';

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { ref: '', refText: '', text: DEFAULT_TEXT, out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const take = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 后面要跟一个值`);
      i += 1;
      return v;
    };
    if (a === '--ref') out.ref = take();
    else if (a === '--ref-text' || a === '--refText') out.refText = take();
    else if (a === '--text') out.text = take();
    else if (a === '--out') out.out = take();
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  if (out.help) return out;
  if (!out.ref) throw new Error('缺少 --ref（参考音频路径）');
  if (!out.refText) throw new Error('缺少 --ref-text（参考音频的逐字文本，GPT-SoVITS 靠它对齐音素）');
  if (!String(out.refText).trim()) throw new Error('--ref-text 不能是空白');
  return out;
}

export function probeOutPath(refPath, explicit) {
  if (explicit) return explicit;
  const base = path.basename(refPath).replace(/\.(wav|mp3|flac|m4a)$/i, '');
  return path.join('audio', 'cand', `probe-${base}.wav`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log('用法：node scripts/voice-probe.mjs --ref <参考音频> --ref-text "<逐字文本>" [--text "..."] [--out <wav>]');
    return;
  }

  const root = process.cwd();
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const base = gptsovitsSettings(cfg.socialV2?.voice?.tts?.gptsovits ?? {}, { root });
  const settings = { ...base, refAudio: opts.ref, refText: opts.refText };
  const problems = gptsovitsProblems(settings);
  if (problems.length) {
    console.error(`✗ 参考音频不可用：${problems.join('；')}`);
    process.exitCode = 1;
    return;
  }

  const outPath = probeOutPath(opts.ref, opts.out);
  fs.mkdirSync(path.dirname(path.resolve(root, outPath)), { recursive: true });
  const t0 = Date.now();
  try {
    const made = await synthesizeWithGptSoVits({ text: opts.text, outPath, root, timeoutMs: 180000, settings });
    console.log(`✓ ${outPath}（${made.bytes} 字节，${Date.now() - t0}ms）`);
    console.log(`  参考：${opts.ref}`);
    console.log(`  台词：${opts.text}`);
  } catch (error) {
    console.error(`✗ 合成失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) await main();