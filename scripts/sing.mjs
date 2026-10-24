#!/usr/bin/env node
// 让小鲸鱼唱一首歌：node 侧薄壳，转手给 _acestep 里的 python（sing.py 解释细节）。
//
// 为什么不直接在她说话的链路上跑：ACE-Step 生成一首歌要几十秒到几分钟、吃 7~10GB 内存/显存，
// 和"聊天"抢资源；所以唱歌是独立动作——生成好文件，再由 send-voice.mjs / qq_send_voice 发出去。
//
// 用法：
//   node scripts/sing.mjs --lyrics "第一句\n第二句" --tags "chinese pop, female vocal" --duration 30
//   node scripts/sing.mjs --lyrics-file lyrics.txt --out audio/sing-xxx.wav --steps 28
//   node scripts/sing.mjs --send private:3482501440 --lyrics "……"    生成完直接发 QQ
//
// 环境变量：
//   ACESTEP_HOME        ACE-Step 安装目录（默认 <仓库>/../_acestep）
//   ACESTEP_PYTHON      python 解释器（默认 <ACESTEP_HOME>/env/Scripts/python.exe）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const acestepHome = process.env.ACESTEP_HOME || path.resolve(repoRoot, '..', '_acestep');
const python = process.env.ACESTEP_PYTHON || path.join(acestepHome, 'env', 'Scripts', 'python.exe');
const singPy = path.join(repoRoot, 'scripts', 'sing.py');

function usage(msg) {
  if (msg) console.error(`✗ ${msg}`);
  console.error(`用法：
  node scripts/sing.mjs --lyrics "第一句\\n第二句" [--tags "风格"] [--duration 30] [--out audio/sing-x.wav]
  可选：--lyrics-file <文件> --steps <n> --seed <n> --cpu-offload 0|1 --checkpoint-dir <目录>
        --send <private:QQ号|group:群号>   生成完立刻用 send-voice 发出去`);
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

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage();
if (!args.lyrics && !args['lyrics-file'] && !args.rest.length) usage('要么给 --lyrics，要么给 --lyrics-file');

if (!fs.existsSync(python)) usage(`找不到 python：${python}（设 ACESTEP_PYTHON 或装好 _acestep/env）`);
if (!fs.existsSync(singPy)) usage(`找不到 ${singPy}`);

const pyArgs = [singPy];
const lyricsText = args.lyrics || args.rest.join(' ');
if (lyricsText) pyArgs.push('--lyrics', lyricsText.replace(/\\n/g, '\n'));
if (args['lyrics-file']) pyArgs.push('--lyrics-file', args['lyrics-file']);
if (args.tags) pyArgs.push('--tags', args.tags);
if (args.duration) pyArgs.push('--duration', String(args.duration));
if (args.steps) pyArgs.push('--steps', String(args.steps));
if (args.seed !== undefined) pyArgs.push('--seed', String(args.seed));
if (args['checkpoint-dir']) pyArgs.push('--checkpoint-dir', args['checkpoint-dir']);
if (args['cpu-offload'] !== undefined) pyArgs.push('--cpu-offload', String(args['cpu-offload']));
const outPath = args.out || path.join('audio', 'sing-out.wav');
pyArgs.push('--out', outPath);

console.log(`→ ${path.basename(python)} scripts/sing.py（${acestepHome}）`);
const started = Date.now();
const child = spawn(python, pyArgs, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
let tail = '';
const relay = (buf, isErr) => {
  const text = buf.toString('utf8');
  tail = (tail + text).slice(-4000);
  process[isErr ? 'stderr' : 'stdout'].write(text);
};
child.stdout.on('data', (b) => relay(b, false));
child.stderr.on('data', (b) => relay(b, true));

child.on('error', (err) => { console.error(`✗ 起不来：${err.message}`); process.exit(1); });
child.on('close', async (code) => {
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (code !== 0) {
    console.error(`✗ 生成失败（exit=${code}，${secs}s）`);
    if (/WinError 1455|paging file/i.test(tail)) {
      console.error('  内存/页面文件不够：8GB 显存的 ACE-Step 要 ~10GB 内存。先关掉吃内存的东西（GPT-SoVITS 服务、Ollama 模型）再试。');
    }
    process.exit(code || 1);
  }
  const abs = path.resolve(repoRoot, outPath);
  if (!fs.existsSync(abs)) { console.error(`✗ 脚本说成功但没有产物：${abs}`); process.exit(1); }
  const stat = fs.statSync(abs);
  console.log(`✓ ${path.relative(repoRoot, abs)}（${(stat.size / 1024).toFixed(0)}KB，总耗时 ${secs}s）`);
  if (args.send) {
    console.log(`→ 发到 ${args.send} …`);
    const sender = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'send-voice.mjs'), 'send', path.relative(repoRoot, abs), String(args.send)], { cwd: repoRoot, stdio: 'inherit' });
    sender.on('close', (c) => process.exit(c === 0 ? 0 : 1));
  }
});