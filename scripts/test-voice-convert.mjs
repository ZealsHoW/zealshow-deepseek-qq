#!/usr/bin/env node
// voice-convert.mjs（Seed-VC 零样本音色转换）的回归。
//
// 这个脚本的价值全在「别人不该知道 Seed-VC 那些环境变量」：
//   - HF_HUB_CACHE / HF_HOME 不指到 checkpoints 就会去默认缓存目录，报 WinError 5 拒绝访问；
//   - PATH 里没有 ffmpeg，pydub 直接 "Couldn't find ffmpeg or avconv"；
//   - 不指定 --target 时要自动用她现在的嗓子（config 的 tts.gptsovits.refAudio）。
// 所以这里主要断言这些默认值都还在，而不是去跑一次 40 秒的转换。
// 想真跑：VOICE_CONVERT_LIVE=1 node scripts/test-voice-convert.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const script = path.join(ROOT, 'scripts', 'voice-convert.mjs');

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? `（${extra}）` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? `（${extra}）` : ''}`); }
}

console.log('## 文件与用法');
ok(fs.existsSync(script), 'scripts/voice-convert.mjs 在');
const src = fs.readFileSync(script, 'utf8');
ok(/--source/.test(src) && /--target/.test(src) && /--out/.test(src), '三个核心参数都在');
ok(/--steps/.test(src) && /--length-adjust/.test(src) && /--similarity/.test(src) && /--intelligibility/.test(src),
  'Seed-VC 的调参口子都透出来了');
ok(/--send/.test(src), '可以直接 --send 发出去');
const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
ok(help.status === 2, '--help 走 usage、退出码 2');

console.log('## 环境默认值（别人不用记这些）');
ok(/SEEDVC_HOME/.test(src) && /_seedvc/.test(src), 'SEEDVC_HOME 默认 ../_seedvc');
ok(/SEEDVC_PYTHON/.test(src) && /Scripts'?,?\s*'python\.exe|Scripts', 'python\.exe'/.test(src), 'SEEDVC_PYTHON 默认 env/Scripts/python.exe');
ok(/HF_HUB_CACHE/.test(src) && /HF_HOME/.test(src), 'HF_HUB_CACHE / HF_HOME 都设（否则 WinError 5）');
ok(/HF_ENDPOINT/.test(src) && /hf-mirror/.test(src), 'HF_ENDPOINT 默认走镜像');
ok(/PYTHONIOENCODING/.test(src), 'PYTHONIOENCODING=utf-8（不然生成日志里的中文全乱）');
ok(/env\.PATH = /.test(src) && /ffmpegPath/.test(src), '把 ffmpeg 目录塞进 PATH（pydub 要用）');
ok(/HF_HUB_DISABLE_SYMLINKS_WARNING/.test(src), '关掉 symlink 警告噪音');

console.log('## 音色参考与产物');
ok(/tts\?\.gptsovits/.test(src) && /tts\.refAudio/.test(src), '默认音色参考取 tts.gptsovits.refAudio');
ok(/sapi-ref\.wav/.test(src), '配置里没有时兜底 sapi-ref.wav');
ok(/path\.dirname\(srcAbs\)/.test(src), '输出目录跟源音频放一起');
ok(/fs\.renameSync\(savedPath, wanted\)/.test(src), '给了 --out 就重命名成指定名字');
ok(/Output saved to:/.test(src), '从 stdout 抓 "Output saved to:"');

console.log('## 出错时说人话');
ok(/WinError 1455\|paging file/i.test(src), '认 WinError 1455（显存/内存不够）');
ok(/把 GPT-SoVITS 服务和 Ollama 模型停掉/.test(src), '1455 时告诉人先停谁');
ok(/No module named\|ModuleNotFoundError/i.test(src), '认缺依赖');
ok(/uv venv --python 3\.10/.test(src) && /uv pip install --python/.test(src), '找不到 python 时给出完整安装命令（不用去翻 README）');
ok(/const val = \(v, dflt\) =>/.test(src), '--foo 不带值时兜底成默认值（踩过 String(true) 的坑）');

console.log('## 与 sing.mjs 的约定');
const singSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'sing.mjs'), 'utf8');
ok(/voice-convert\.mjs/.test(singSrc), 'sing.mjs 会调它');
ok(/--vc/.test(singSrc), 'sing.mjs 的 --vc 就是这一步');

if (process.env.VOICE_CONVERT_LIVE === '1') {
  console.log('## 实跑一次（VOICE_CONVERT_LIVE=1）');
  const sample = path.join(ROOT, 'audio', 'sing-test.wav');
  const ref = path.join(ROOT, 'audio', 'ref', 'edge-xiaoyi.wav');
  if (!fs.existsSync(sample) || !fs.existsSync(ref)) {
    console.log('  ⏭ 缺样本音频（audio/sing-test.wav 或音色参考），跳过');
  } else {
    const started = Date.now();
    const run = spawnSync(process.execPath, [
      script,
      '--source', sample,
      '--target', ref,
      '--out', 'audio/vc-selftest.wav',
      '--steps', '12'
    ], { encoding: 'utf8', cwd: ROOT, timeout: 900000 });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    ok(run.status === 0, '转换退出码 0', `${secs}s`);
    const outFile = path.join(ROOT, 'audio', 'vc-selftest.wav');
    ok(fs.existsSync(outFile) && fs.statSync(outFile).size > 10000, '产物真有内容', fs.existsSync(outFile) ? `${fs.statSync(outFile).size} 字节` : '缺文件');
  }
} else {
  console.log('\n（想真跑一次：VOICE_CONVERT_LIVE=1 node scripts/test-voice-convert.mjs）');
}

console.log(`\n结果：${pass} 通过 ${fail} 失败`);
process.exit(fail ? 1 : 0);