#!/usr/bin/env node
// 把任意一段声音换成"她自己的音色"：Seed-VC v2 零样本音色转换（源 = 唱/念的音频，目标 = 音色参考）。
//
// 为什么单独一层：ACE-Step 会先把歌词"唱"成任意女声，再用 Seed-VC 把那个嗓子换成小鲸鱼的嗓子，
// 这样不用为唱歌单独训一个模型。两件事都很吃显存，必须分开跑。
//
// 用法：
//   node scripts/voice-convert.mjs --source audio/sing-x.wav                      用配置里的音色参考
//   node scripts/voice-convert.mjs --source a.wav --target audio/ref/edge-xiaoyi.wav
//   node scripts/voice-convert.mjs --source a.wav --out audio/vc-x.wav --steps 30
//   node scripts/voice-convert.mjs --source a.wav --send private:3482501440      转完直接发 QQ
//
// 环境变量：
//   SEEDVC_HOME     Seed-VC 安装目录（默认 <仓库>/../_seedvc）
//   SEEDVC_PYTHON   python 解释器（默认 <SEEDVC_HOME>/env/Scripts/python.exe）
//   HF_ENDPOINT     权重源（默认 https://hf-mirror.com）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const seedvcHome = process.env.SEEDVC_HOME || path.resolve(repoRoot, '..', '_seedvc');
const seedvcDir = path.join(seedvcHome, 'seed-vc-main');
const python = process.env.SEEDVC_PYTHON || path.join(seedvcHome, 'env', 'Scripts', 'python.exe');
const inferencePy = path.join(seedvcDir, 'inference_v2.py');

function usage(msg) {
  if (msg) console.error(`✗ ${msg}`);
  console.error(`用法：
  node scripts/voice-convert.mjs --source <音频> [--target <音色参考>] [--out <输出>]
  可选：--steps 30  --length-adjust 1.0  --similarity 0.7  --intelligibility 0.7
        --send <private:QQ号|group:群号>   转完立刻用 send-voice 发出去
  没给 --target 时用 config.json 里 socialV2.voice.tts.gptsovits.refAudio（她现在的嗓子）`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out.rest.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function readConfig() {
  const file = process.env.QQ_BRIDGE_CONFIG || path.join(repoRoot, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage();
const source = args.source || args.rest[0];
if (!source) usage('缺少 --source（要转换的音频）');

const cfg = readConfig();
const tts = cfg?.socialV2?.voice?.tts?.gptsovits || {};
const target = args.target && args.target !== true
  ? args.target
  : (tts.refAudio || path.join('audio', 'ref', 'sapi-ref.wav'));

if (!fs.existsSync(python)) {
  usage(`找不到 python：${python}
  Seed-VC 需要先装一份环境：
    uv venv --python 3.10 ${path.join(seedvcHome, 'env')}
    uv pip install --python ${python} torch==2.4.0 torchvision==0.19.0 torchaudio==2.4.0 --index-url https://download.pytorch.org/whl/cu124
    uv pip install --python ${python} hydra-core omegaconf transformers==4.46.3 librosa==0.10.2 pydub soundfile huggingface_hub einops scipy "numpy<2" pyyaml safetensors munch==4.0.0 matplotlib
  源码：https://gh-proxy.com/https://github.com/Plachtaa/seed-vc/archive/refs/heads/main.zip → ${seedvcDir}`);
}
if (!fs.existsSync(inferencePy)) usage(`找不到 ${inferencePy}`);

const srcAbs = path.resolve(repoRoot, String(source));
if (!fs.existsSync(srcAbs)) usage(`源音频不存在：${srcAbs}`);
const tgtAbs = path.resolve(repoRoot, String(target));
if (!fs.existsSync(tgtAbs)) usage(`音色参考不存在：${tgtAbs}`);

// --foo 不带值时 parseArgs 给的是 true，这里统一兜底成默认值
const val = (v, dflt) => (v === undefined || v === true ? dflt : v);

// 输出目录：默认跟源音频放一起（send-voice 只认仓库内的相对路径最省事）
const outDir = path.dirname(srcAbs);
const steps = String(val(args.steps, 30));
const pyArgs = [
  inferencePy,
  '--source', srcAbs,
  '--target', tgtAbs,
  '--output', outDir,
  '--diffusion-steps', steps,
];
if (args['length-adjust'] !== undefined && args['length-adjust'] !== true) pyArgs.push('--length-adjust', String(args['length-adjust']));
if (args.similarity !== undefined && args.similarity !== true) pyArgs.push('--similarity-cfg-rate', String(args.similarity));
if (args.intelligibility !== undefined && args.intelligibility !== true) pyArgs.push('--intelligibility-cfg-rate', String(args.intelligibility));

// ffmpeg：pydub 读 mp3 时要用；把已知的 bin 目录塞进 PATH（与 send-voice 用同一个来源）
const ffmpegDir = (() => {
  if (process.env.FFMPEG_PATH) return path.dirname(process.env.FFMPEG_PATH);
  const fromCfg = cfg?.socialV2?.voice?.ffmpegPath;
  if (fromCfg) return path.dirname(fromCfg);
  const known = path.resolve(repoRoot, '..', '_gptsovits', 'ffmpeg', 'ffmpeg-master-latest-win64-gpl-shared', 'bin');
  return fs.existsSync(known) ? known : null;
})();
const env = {
  ...process.env,
  PYTHONIOENCODING: 'utf-8',
  HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
  HF_HUB_CACHE: process.env.HF_HUB_CACHE || path.join(seedvcDir, 'checkpoints'),
  HF_HOME: process.env.HF_HOME || process.env.HF_HUB_CACHE || path.join(seedvcDir, 'checkpoints'),
  HF_HUB_DISABLE_SYMLINKS_WARNING: '1',
};
if (ffmpegDir) env.PATH = `${ffmpegDir}${path.delimiter}${env.PATH || ''}`;

console.log(`→ 换音色：${path.relative(repoRoot, srcAbs)} → ${path.relative(repoRoot, tgtAbs)}`);
console.log(`  ${path.basename(python)} inference_v2.py --diffusion-steps ${steps}（${seedvcDir}）`);
const started = Date.now();
const child = spawn(python, pyArgs, { cwd: seedvcDir, stdio: ['ignore', 'pipe', 'pipe'], env });

let tail = '';
let savedPath = null;
const takeLine = (text) => {
  const m = /Output saved to:\s*(.+)\s*$/m.exec(text);
  if (m) savedPath = m[1].trim();
};
const relay = (buf, isErr) => {
  const text = buf.toString('utf8');
  tail = (tail + text).slice(-8000);
  takeLine(text);
  process[isErr ? 'stderr' : 'stdout'].write(text);
};
child.stdout.on('data', (b) => relay(b, false));
child.stderr.on('data', (b) => relay(b, true));

child.on('error', (err) => { console.error(`✗ 起不来：${err.message}`); process.exit(1); });
child.on('close', (code) => {
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (code !== 0) {
    console.error(`✗ 转换失败（exit=${code}，${secs}s）`);
    if (!savedPath) takeLine(tail);
    if (/WinError 1455|paging file/i.test(tail)) {
      console.error('  内存/页面文件不够：Seed-VC 要 4~6GB 显存 + 几 GB 内存。先把 GPT-SoVITS 服务和 Ollama 模型停掉再试。');
    }
    if (/No module named|ModuleNotFoundError/i.test(tail)) {
      console.error('  缺 python 依赖：按上面 usage 里那两行 uv pip install 补齐。');
    }
    process.exit(code || 1);
  }
  if (!savedPath) { console.error('✗ 脚本说成功但没打印输出路径'); process.exit(1); }
  let finalPath = savedPath;
  if (args.out && args.out !== true) {
    const wanted = path.resolve(repoRoot, String(args.out));
    fs.mkdirSync(path.dirname(wanted), { recursive: true });
    fs.renameSync(savedPath, wanted);
    finalPath = wanted;
  }
  const stat = fs.statSync(finalPath);
  console.log(`✓ ${path.relative(repoRoot, finalPath)}（${(stat.size / 1024).toFixed(0)}KB，总耗时 ${secs}s）`);
  if (args.send && args.send !== true) {
    console.log(`→ 发到 ${args.send} …`);
    const sender = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'send-voice.mjs'), 'send', path.relative(repoRoot, finalPath), String(args.send)], { cwd: repoRoot, stdio: 'inherit' });
    sender.on('close', (c) => process.exit(c === 0 ? 0 : 1));
  }
});