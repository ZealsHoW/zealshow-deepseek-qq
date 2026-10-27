#!/usr/bin/env node
// 唱歌链路的回归：只查"接线对不对"，不真跑模型（真跑一次要 40s+ 且吃满 8GB 显存）。
// 想连模型一起验：SING_LIVE=1 node scripts/test-sing.mjs（会真生成一段 8 秒的，慢）
//
// 为什么值得有这条：唱歌是"模型在仓库外面、参数在仓库里面"的典型结构，
// 一旦路径/参数/后端起不来，症状是"她明明调了工具但QQ那边没动静"，很难从日志看出问题。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const singPy = path.join(repoRoot, 'scripts', 'sing.py');
const singMjs = path.join(repoRoot, 'scripts', 'sing.mjs');

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? `（${extra}）` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? `（${extra}）` : ''}`); }
}
function read(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }

console.log('## 文件与形态');
const py = read(singPy);
const mjs = read(singMjs);
ok(fs.existsSync(singPy), 'scripts/sing.py 存在');
ok(fs.existsSync(singMjs), 'scripts/sing.mjs 存在');
ok(/ACEStepPipeline/.test(py), 'sing.py 用的是 ACEStepPipeline（库 API，不是 gradio）');
ok(/cpu_offload/.test(py) && /default=1/.test(py), 'sing.py 默认开 cpu_offload（8GB 显卡的前提）');
ok(/torchcodec|soundfile/i.test(py) && /_ta\.save\s*=/.test(py), 'sing.py 把 torchaudio.save 换成 soundfile 后端（绕开 torchcodec）');
ok(/save_path\s*=/.test(py) && /format\s*=\s*'wav'/.test(py), 'sing.py 明确指定 save_path 与 wav 格式');
ok(/reconfigure\(encoding='utf-8'/.test(py), 'sing.py 把 stdout 切成 utf-8（否则 GBK 控制台直接崩）');
ok(/WinError 1455|paging file/i.test(mjs), 'sing.mjs 对"内存/页面文件不够"给了人话提示');
ok(/ACESTEP_HOME|ACESTEP_PYTHON/.test(mjs), 'sing.mjs 支持 ACESTEP_HOME / ACESTEP_PYTHON 覆盖路径');
ok(/send-voice\.mjs/.test(mjs), 'sing.mjs 能 --send 直接发出去');
ok(/scripts', 'sing\.py'/.test(mjs), 'sing.mjs 调的是仓库里的 sing.py');

console.log('## 参数接线（mjs → py）');
for (const flag of ['--lyrics', '--tags', '--duration', '--steps', '--out', '--checkpoint-dir']) {
  ok(mjs.includes(`'${flag}'`) && py.includes(`'${flag}'`), `${flag} 两端都对得上`);
}
ok(/lyrics-file/.test(mjs) && /lyrics-file/.test(py), '--lyrics-file 两端都对得上');
// 2026-10-27：主人嫌跑调/音色不真实，加 audio2audio 参考通道（照参考音频的曲风唱）。
ok(/--ref-strength/.test(mjs) && /--ref-strength/.test(py), '--ref / --ref-strength 两端都对得上');
ok(/audio2audio_enable/.test(py) && /ref_audio_input/.test(py), 'sing.py 真的把参考音频传进 ACE-Step 的 audio2audio');
ok(/args\.ref\) pyArgs\.push\('--ref'/.test(mjs), 'sing.mjs 会把 --ref 透传给 python');
ok(/参考音频不存在/.test(py), '参考音频不存在时明确报错，不去猜');
// 2026-10-27 实测：torchaudio 2.9+ 的 load() 改走 torchcodec，venv 里没装 ⇒ --ref 直接 ImportError。
// sing.py 必须像 save 一样用 soundfile 顶掉它，否则参考通道在真机上根本跑不起来。
ok(/_load_via_soundfile/.test(py) && /_ta2\.load = _load_via_soundfile/.test(py), 'sing.py 用 soundfile 顶掉 torchaudio.load（否则 --ref 缺 torchcodec 直接崩）');

console.log('## 依赖现状');
const acestepHome = process.env.ACESTEP_HOME || path.resolve(repoRoot, '..', '_acestep');
const pyExe = process.env.ACESTEP_PYTHON || path.join(acestepHome, 'env', 'Scripts', 'python.exe');
const ckpt = process.env.ACESTEP_CHECKPOINT_DIR || path.join(process.env.USERPROFILE || '', '.cache', 'ace-step', 'checkpoints');
const havePy = fs.existsSync(pyExe);
const transformer = path.join(ckpt, 'ace_step_transformer', 'diffusion_pytorch_model.safetensors');
const haveModel = fs.existsSync(transformer) && fs.statSync(transformer).size > 6e9;
console.log(`  ℹ python: ${havePy ? '有' : '没有'}  ${pyExe}`);
console.log(`  ℹ 权重:   ${haveModel ? '有' : '没有'}  ${transformer}`);
if (!havePy || !haveModel) {
  console.log('  ⏭ 本机没装 ACE-Step（或权重没下完），跳过实跑');
}

if (process.env.SING_LIVE === '1') {
  console.log('## 实跑（SING_LIVE=1）');
  if (!havePy) { fail++; console.log('  ❌ 没有 python，无法实跑'); }
  else {
    const out = path.join('audio', 'sing-selftest.wav');
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [singMjs, '--lyrics', '啦 啦 啦', '--duration', '8', '--steps', '8', '--out', out], {
      cwd: repoRoot, encoding: 'utf8', timeout: 600000,
    });
    const abs = path.join(repoRoot, out);
    const size = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
    ok(r.status === 0, 'sing.mjs 退出码 0', `${Math.round((Date.now() - t0) / 1000)}s`);
    ok(size > 100000, '产物是像样的 wav', `${size} 字节`);
    if (r.status !== 0) console.log((r.stdout || '').slice(-800), (r.stderr || '').slice(-800));
  }
}

console.log(`\n结果：${pass} 通过 ${fail} 失败`);
process.exit(fail ? 1 : 0);