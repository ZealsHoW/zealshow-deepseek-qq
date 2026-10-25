#!/usr/bin/env node
// 克隆音色：给一段任意音频/视频，切出 GPT-SoVITS 的参考片段 + 逐字文本，并（默认）直接切到 config.json。
//
// 为什么要有它：换音色 = 换一对「refAudio + refText」，可这对东西必须彼此逐字对得上、
// 而且要恰好停在句号上。手工做一次要抽音频、转写、切片段、再转写核对，容易漏。
// 真正干活的是 scripts/clone-voice.py（funasr 在 _gptsovits 那个 venv 里），
// 这一层负责找 python、传环境变量、把 JSON 结果接到 voice-audition --set 上。
//
// 用法：
//   npm run voice:clone -- --audio sound/大肥鱼.wav
//   node scripts/clone-voice.mjs --audio 视频.mp4 --no-set         只切片段，不改配置
//   node scripts/clone-voice.mjs --audio a.wav --send private:3482501440   切完改配置 + 合成一句发出去
//   node scripts/clone-voice.mjs --audio a.wav --text "试听台词"
//
// 环境变量：
//   GPT_SOVITS_HOME  GPT-SoVITS 安装目录（默认 <仓库>/../_gptsovits）
//   GPT_SOVITS_PYTHON python 解释器（默认 <GPT_SOVITS_HOME>/env/Scripts/python.exe）
//   HF_ENDPOINT      模型源（默认 https://hf-mirror.com）
//   HF_HUB_CACHE     funasr 模型缓存（默认 <仓库>/../_hf-cache）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const gptsovitsHome = process.env.GPT_SOVITS_HOME || path.resolve(repoRoot, '..', '_gptsovits');
const python = process.env.GPT_SOVITS_PYTHON || path.join(gptsovitsHome, 'env', 'Scripts', 'python.exe');
const pythonScript = path.join(repoRoot, 'scripts', 'clone-voice.py');
const hfCache = process.env.HF_HUB_CACHE || process.env.HF_HOME || path.resolve(repoRoot, '..', '_hf-cache');

const SAMPLE_TEXT = '主人，你听，这是我的新声音。以后我就用这个声音跟你说话啦。';

function usage(msg) {
  if (msg) console.error(`✗ ${msg}`);
  console.error(`用法：
  node scripts/clone-voice.mjs --audio <音频或视频> [--no-set] [--text "试听台词"]
                                [--send <private:QQ号|group:群号>] [--min-sec 4] [--max-sec 10]

  默认会把 config.json 的 refAudio + refText 一起切到新片段（改完**要重启桥接**：voiceCfg() 读的是内存里的配置）。
  --no-set   只切片段并打印结果，不动配置
  --send     切完配置后用新音色合成一句试听，并立刻发出去`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (error) => resolve({ code: -1, out: out + String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage();
const audio = args.audio && args.audio !== true ? String(args.audio) : null;
if (!audio) usage('缺少 --audio（要克隆的音频或视频）');
if (!fs.existsSync(path.resolve(repoRoot, audio)) && !fs.existsSync(audio)) usage(`找不到音频：${audio}`);
if (!fs.existsSync(pythonScript)) usage(`缺少 ${path.relative(repoRoot, pythonScript)}`);
if (!fs.existsSync(python)) {
  console.error(`✗ 找不到 python：${python}`);
  console.error('   设 GPT_SOVITS_PYTHON 指到解释器，或先按 README 把 _gptsovits/env 建好。');
  process.exit(1);
}

const extra = [];
for (const [flag, key] of [['--min-sec', 'min-sec'], ['--max-sec', 'max-sec']]) {
  if (args[key] !== undefined && args[key] !== true) extra.push(flag, String(args[key]));
}

function runPython() {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
      HF_HUB_CACHE: hfCache,
      HF_HOME: hfCache
    };
    const child = spawn(python, [pythonScript, '--audio', path.resolve(repoRoot, audio), '--out-dir', path.join(repoRoot, 'audio', 'ref'), ...extra], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      const text = String(d);
      out += text;
      for (const line of text.split(/\r?\n/)) if (line.trim().startsWith('{')) console.log(`  ${line.trim()}`);
    });
    child.stderr.on('data', (d) => {
      const text = String(d);
      err += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) console.log(`  ${line.trim()}`);
    });
    child.on('error', (error) => resolve({ code: -1, out, err: err + String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
  });
}

function lastJson(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{') && l.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* 继续往前找 */ }
  }
  return null;
}

const started = Date.now();
console.log(`克隆音色：${audio}`);
console.log(`python  ：${python}`);

const res = await runPython();
if (res.code !== 0) {
  console.error(`\n✗ 切片段失败（exit=${res.code}）`);
  const tail = (res.err || res.out || '').split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
  if (tail) console.error(tail);
  process.exit(1);
}

const info = lastJson(res.out);
if (!info?.refAudio || !info?.refText) {
  console.error('✗ 没拿到参考音频/文本（clone-voice.py 的输出里没有 JSON）');
  process.exit(1);
}

const refRel = path.relative(repoRoot, info.refAudio).split(path.sep).join('/');
console.log(`\n✓ 参考片段：${refRel}（${info.secs} 秒，源 ${info.duration} 秒）`);
console.log(`  参考文本："${info.refText}"`);
if (info.warn) console.log(`  ⚠️ ${info.warn}`);
console.log(`  用时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`);

if (args['no-set']) {
  console.log('\n（--no-set：没有改 config.json）');
  console.log(`   想切就用：node scripts/voice-audition.mjs --set ${refRel} --ref-text "${info.refText}"`);
  process.exit(0);
}

const set = await runNode(['scripts/voice-audition.mjs', '--set', refRel, '--ref-text', info.refText]);
console.log(set.out.trim());
if (set.code !== 0) {
  console.error('✗ 切换配置失败');
  process.exit(1);
}

if (args.send && args.send !== true) {
  const text = String(args.text && args.text !== true ? args.text : SAMPLE_TEXT);
  console.log(`\n合成试听："${text}"`);
  const synth = await runNode(['scripts/voice-audition.mjs', '--candidates', refRel, '--text', text]);
  console.log(synth.out.trim());
  if (synth.code !== 0) {
    console.error('✗ 合成失败：音色服务起了吗（scripts/gptsovits-serve.ps1）');
    process.exit(1);
  }
  const name = path.basename(refRel, path.extname(refRel));
  const audition = path.join('audio', `audition-${name}.wav`);
  const send = await runNode(['scripts/send-voice.mjs', 'send', audition, String(args.send)]);
  console.log(send.out.trim());
  if (send.code !== 0) {
    console.error('✗ 发送失败');
    process.exit(1);
  }
}

console.log('\n✓ 完成：她的声音已经换成这一份参考。');