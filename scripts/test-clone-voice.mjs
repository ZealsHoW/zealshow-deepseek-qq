#!/usr/bin/env node
// clone-voice（从任意音频/视频里切 GPT-SoVITS 参考片段）的回归。
//
// 这条链路的坑几乎全在「别人不该知道」的地方：
//   - funasr 默认把模型写到 C:\Users\<你>\.cache\modelscope，沙箱里只读 → 必须 hub="hf" + HF_HUB_CACHE；
//   - 参考文本的英文词要 nltk 的 cmudict / averaged_perceptron_tagger_eng，缺了 TTS 直接 HTTP 400；
//   - 说话人没有静音缝时，切点必须回到全文核对（ct-punc 会给任何输入补句号，光看结尾永远是句号）；
//   - 视频容器要 -vn 丢视频轨。
// 想真跑一次（约 90 秒，要 _gptsovits/env）：CLONE_VOICE_LIVE=1 node scripts/test-clone-voice.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const mjs = path.join(ROOT, 'scripts', 'clone-voice.mjs');
const py = path.join(ROOT, 'scripts', 'clone-voice.py');

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? `（${extra}）` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? `（${extra}）` : ''}`); }
}

console.log('## 文件与用法');
ok(fs.existsSync(mjs), 'scripts/clone-voice.mjs 在');
ok(fs.existsSync(py), 'scripts/clone-voice.py 在');
const src = fs.readFileSync(mjs, 'utf8');
const pysrc = fs.readFileSync(py, 'utf8');
const help = spawnSync(process.execPath, [mjs, '--help'], { encoding: 'utf8' });
ok(help.status === 2, '--help 走 usage、退出码 2');
ok(/--audio/.test(src) && /--no-set/.test(src) && /--send/.test(src) && /--text/.test(src), '四个核心参数都在');
ok(/不确定|不用重启/.test(src) || /重读配置|重新读配置/.test(src), '说清「改完不用重启桥接」');
ok(/npm run voice:clone/.test(src), '用法里给了 npm 入口');

console.log('## 环境默认值（别人不用记这些）');
ok(/GPT_SOVITS_HOME/.test(src) && /_gptsovits/.test(src), 'GPT_SOVITS_HOME 默认 ../_gptsovits');
ok(/GPT_SOVITS_PYTHON/.test(src) && /Scripts', 'python\.exe'/.test(src), 'GPT_SOVITS_PYTHON 默认 env/Scripts/python.exe');
ok(/HF_HUB_CACHE/.test(src) && /HF_HOME/.test(src), 'HF_HUB_CACHE / HF_HOME 都设（否则 WinError 5）');
ok(/HF_ENDPOINT/.test(src) && /hf-mirror/.test(src), 'HF_ENDPOINT 默认走镜像');
ok(/PYTHONUTF8/.test(src) && /PYTHONIOENCODING/.test(src) && /PYTHONUNBUFFERED/.test(src), '三个 python 环境变量都设');
ok(/PYTHONIOENCODING: 'utf-8'/.test(src), 'PYTHONIOENCODING=utf-8（否则中文全乱）');

console.log('## 接线：切完直接换配置');
ok(/voice-audition\.mjs', '--set'/.test(src), '调 voice-audition --set 切换');
ok(/--ref-text/.test(src), '同时把 refText 一起换（两条必须成对）');
ok(/startsWith\('\{'\)/.test(src), '从输出里挑 JSON 行解析');
ok(/send-voice\.mjs', 'send'/.test(src), '--send 时用 send-voice 发出去');
ok(/audition-\$\{name\}\.wav/.test(src), '试听产物名与 voice-audition 的约定一致');

console.log('## python 侧：切片段');
ok(/-vn/.test(pysrc), 'ffmpeg 带 -vn（视频容器也能直接喂）');
ok(/"-ac",\s*"1"/.test(pysrc) && /"-ar",\s*"32000"/.test(pysrc), '统一成 32kHz 单声道');
ok(/ffprobe/.test(pysrc) && /format=duration/.test(pysrc), '先用 ffprobe 读时长');
ok(/_gptsovits\/ffmpeg/.test(pysrc), 'ffmpeg 找不到时去 _gptsovits 下找');
ok(/hub="hf"/.test(pysrc), 'funasr 走 HuggingFace（modelscope 缓存目录写不进）');
ok(/paraformer-zh/.test(pysrc) && /fsmn-vad/.test(pysrc) && /ct-punc/.test(pysrc), '三个模型都点名');
ok(/BREAK_CHARS/.test(pysrc) && /break_cut_lengths/.test(pysrc), '切点按全文的断句位置核对');
ok(/SENTENCE_END\s*\+\s*"，、；：/.test(pysrc), '逗号也算断句（连续说话时句号可能在窗口外）');
ok(/full_norm\.startswith\(tn\)/.test(pysrc), '切出来的转写必须是全文开头（防 ASR 跑偏）');
ok(/t\s*=\s*round\(t - 0\.2, 3\)/.test(pysrc), '从上限往下 0.2 秒一档扫');
ok(/scans < 40/.test(pysrc), '扫描次数有上限（不会无限跑）');
ok(/default=4\.0/.test(pysrc) && /default=10\.0/.test(pysrc), '时长窗口默认 4~10 秒');
ok(/"refAudio"/.test(pysrc) && /"refText"/.test(pysrc) && /"secs"/.test(pysrc) && /"warn"/.test(pysrc), 'JSON 契约字段齐');

console.log('## 入口与文档');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok(pkg.scripts?.['voice:clone'] === 'node scripts/clone-voice.mjs', 'package.json 有 voice:clone');
ok(pkg.scripts?.['test:voice-clone'] === 'node scripts/test-clone-voice.mjs', 'package.json 有 test:voice-clone');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
ok(/voice:clone/.test(readme), 'README 写了 voice:clone 用法');
ok(/cmudict/.test(readme) && /averaged_perceptron_tagger_eng/.test(readme), 'README 写了 nltk 那三个资源');
ok(/runtime\\?nltk_data/i.test(readme), 'README 写了 nltk_data 放哪（GPT-SoVITS 会自己搜）');
ok(/hub="hf"|hub=hf/.test(readme), 'README 写了 funasr 走 hf hub');
ok(/messageId=68627126/.test(readme), 'README 记了真机证据');

if (process.env.CLONE_VOICE_LIVE === '1') {
  console.log('## 真跑一次（CLONE_VOICE_LIVE=1）');
  const ref = path.join(ROOT, 'audio', 'ref', 'edge-xiaoyi.wav');
  if (!fs.existsSync(ref)) {
    ok(false, `缺少测试音频 ${path.relative(ROOT, ref)}`);
  } else {
    const cfgPath = path.join(ROOT, 'config.json');
    const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const before = fs.existsSync(cfgPath) ? hash(cfgPath) : null;
    const r = spawnSync(process.execPath, [mjs, '--audio', path.relative(ROOT, ref), '--no-set'], {
      cwd: ROOT, encoding: 'utf8', timeout: 300000
    });
    ok(r.status === 0, `--no-set 真跑成功（exit ${r.status}）`, r.status === 0 ? '' : (r.stderr || '').split('\n').slice(-3).join(' | '));
    ok(/参考片段：audio\/ref\//.test(r.stdout || ''), '输出了参考片段路径');
    ok(/参考文本：".+"/.test(r.stdout || ''), '输出了参考文本');
    ok(/没有改 config\.json|--no-set/.test(r.stdout || ''), '确认没有动配置');
    const after = fs.existsSync(cfgPath) ? hash(cfgPath) : null;
    ok(before === after, '--no-set 确实没写 config.json');
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
if (fail > 0) process.exitCode = 1;