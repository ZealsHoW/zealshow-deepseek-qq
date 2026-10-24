#!/usr/bin/env node
// 音色试听/切换（scripts/voice-audition.mjs）与参考音色生成（scripts/make-ref-voice.py）的回归。
//
// 为什么要有这条：换音色 = 换 config.json 里的 refAudio + refText。这两件事必须**同时**改
// （GPT-SoVITS 靠 refText 对齐音素，只改音频不改文本会合成出糊掉的音），而且 refText 一旦
// 和音频逐字不一致就是静默质量问题 —— 只有听才听得出来。所以这条回归盯三件事：
//   1) --set 同时写这两个键，别的键一个都不许动（round-trip 校验）；
//   2) 出错时（文件不存在 / refText 为空）必须失败且**不写盘**；
//   3) 生成参考音频的脚本确实按 GPT-SoVITS 要的规格（32kHz/16bit/单声道）出 wav。
//
// 全程离线：用 QQ_BRIDGE_CONFIG 指一份临时配置，不碰真实 config.json，也不连 GPT-SoVITS。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDITION = path.join(ROOT, 'scripts', 'voice-audition.mjs');
const MAKE_REF = path.join(ROOT, 'scripts', 'make-ref-voice.py');
const REAL_CONFIG = path.join(ROOT, 'config.json');

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

// config.json 与 audio/ 都不进 git（部署态才有），没有它就跳过 —— 换台机器跑自测不该因此变红
if (!fs.existsSync(REAL_CONFIG)) {
  console.log(`⏭ 跳过：没有 config.json（${REAL_CONFIG}）；这条回归只在部署态跑。`);
  process.exit(0);
}
const realCfg = JSON.parse(fs.readFileSync(REAL_CONFIG, 'utf8'));
const realG = realCfg?.socialV2?.voice?.tts?.gptsovits ?? {};

// 只保留两个键不动、其余全保留：--set 之后 deepEqual（去掉这两个键）应当和原来一致
function withoutRef(cfg) {
  const copy = JSON.parse(JSON.stringify(cfg));
  if (copy?.socialV2?.voice?.tts?.gptsovits) {
    delete copy.socialV2.voice.tts.gptsovits.refAudio;
    delete copy.socialV2.voice.tts.gptsovits.refText;
  }
  return copy;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-voice-audition-'));
const tmpCfgPath = path.join(tmpDir, 'config.json');

function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [AUDITION, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, QQ_BRIDGE_CONFIG: tmpCfgPath, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

console.log('## 脚本存在与基本形态');
{
  ok(fs.existsSync(AUDITION), '有 scripts/voice-audition.mjs');
  ok(fs.existsSync(MAKE_REF), '有 scripts/make-ref-voice.py');
  const py = fs.readFileSync(MAKE_REF, 'utf8');
  ok(/--voice/.test(py) && /--text/.test(py) && /--out/.test(py) && /--list/.test(py), '生成脚本带 --voice/--text/--out/--list');
  // 32kHz / 16bit / 单声道：GPT-SoVITS 的参考音频按这个规格最稳
  ok(/'32000'/.test(py) || /32000/.test(py), '输出 32kHz');
  ok(/-sample_fmt', 's16'/.test(py), '输出 16bit（s16）');
  ok(/-ac', '1'/.test(py), '输出单声道');
  // GBK 控制台里 print('✓') 会直接 ValueError 崩掉，必须先把 stdout 切 UTF-8
  ok(/stdout\.reconfigure\(encoding='utf-8'/.test(py), 'stdout 切 UTF-8（GBK 控制台不崩）');
}

console.log('## --set：两个键一起改，别的键不动');
{
  fs.writeFileSync(tmpCfgPath, `${JSON.stringify(realCfg, null, 2)}\n`);
  const before = JSON.parse(fs.readFileSync(tmpCfgPath, 'utf8'));
  const res = run(['--set', 'audio/ref/edge-xiaoyi.wav', '--ref-text', '回归用的参考文本']);
  ok(res.code === 0, '切换退出码 0', res.code === 0 ? '' : res.stdout.slice(0, 200));
  const after = JSON.parse(fs.readFileSync(tmpCfgPath, 'utf8'));
  const g = after?.socialV2?.voice?.tts?.gptsovits ?? {};
  ok(g.refAudio === 'audio/ref/edge-xiaoyi.wav', 'refAudio 切成仓库相对路径', String(g.refAudio));
  ok(g.refText === '回归用的参考文本', 'refText 同时改掉', String(g.refText));
  ok(JSON.stringify(withoutRef(after)) === JSON.stringify(withoutRef(before)), '其余配置一个字节都没动（除这两键）');
}

console.log('## 出错时不能写盘');
{
  fs.writeFileSync(tmpCfgPath, `${JSON.stringify(realCfg, null, 2)}\n`);
  const snapshot = fs.readFileSync(tmpCfgPath, 'utf8');
  const missing = run(['--set', 'audio/ref/no-such-file-xyz.wav', '--ref-text', 'x']);
  ok(missing.code !== 0, '参考音频不存在 → 非 0 退出');
  ok(fs.readFileSync(tmpCfgPath, 'utf8') === snapshot, '而且配置没被写坏');

  const empty = run(['--set', 'audio/ref/edge-xiaoyi.wav', '--ref-text', '   ']);
  ok(empty.code !== 0, 'refText 为空 → 非 0 退出（不会写出「没有参考文本」的半残配置）');
  ok(fs.readFileSync(tmpCfgPath, 'utf8') === snapshot, '配置仍然没动');

  const noConfig = (() => {
    try {
      execFileSync(process.execPath, [AUDITION, '--set', 'audio/ref/edge-xiaoyi.wav'], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, QQ_BRIDGE_CONFIG: path.join(tmpDir, 'nope.json') }, stdio: ['ignore', 'pipe', 'pipe']
      });
      return 0;
    } catch (error) { return error.status ?? 1; }
  })();
  ok(noConfig !== 0, '配置文件不存在 → 非 0 退出（不是静默造一份空配置）');
}

console.log('## 真实配置的一致性');
{
  ok(typeof realG.refAudio === 'string' && realG.refAudio.trim().length > 0, 'config.json 里 refAudio 非空');
  ok(typeof realG.refText === 'string' && realG.refText.trim().length > 0, 'config.json 里 refText 非空');
  const refPath = path.resolve(ROOT, realG.refAudio ?? '');
  // audio/ 在 .gitignore 里（参考音频是本机素材），所以这里只报事实、不判红
  console.log(`  ℹ refAudio → ${path.relative(ROOT, refPath)}${fs.existsSync(refPath) ? '（存在）' : '（本机没有这个文件，属正常：audio/ 不进 git）'}`);
  const edge = fs.existsSync(path.join(ROOT, 'audio', 'ref'))
    ? fs.readdirSync(path.join(ROOT, 'audio', 'ref')).filter((f) => /^edge-.*\.wav$/i.test(f))
    : [];
  console.log(`  ℹ audio/ref 下的 Edge 参考音色：${edge.length ? edge.join(', ') : '（还没有，用 make-ref-voice.py 生成）'}`);
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);