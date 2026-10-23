#!/usr/bin/env node
/**
 * GPT-SoVITS（真人音色）链路体检 —— 「现在到底能不能用真人音色说话」。
 *
 * 用法：
 *   node scripts/check-gptsovits.mjs                     # 用 config.json 里的 socialV2.voice.tts.gptsovits 体检
 *   node scripts/check-gptsovits.mjs --no-synth          # 只探活，不合成
 *   node scripts/check-gptsovits.mjs --ref audio/x.wav --ref-text "那句话的逐字文本" --text "试一句"
 *   node scripts/check-gptsovits.mjs --json              # 机器可读（给上层脚本用）
 *
 * 它做的事：
 *   1. 环境：venv 在不在、GPT-SoVITS 源码在不在、预训练权重下没下（只读检查，不动任何东西）
 *   2. 配置：参考音频/参考文本/地址是否齐全（缺什么就直说怎么补）
 *   3. 服务：GET /control 探活
 *   4. 合成（可跳过）：把一句话合成为 wav 落盘，报耗时与字节数
 *
 * **不发送**任何消息：要真发到 QQ 走 send-voice.mjs（操作者通道）或让 AI 调 qq_send_voice。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_GPTSOVITS_BASE_URL,
  gptsovitsHealth,
  gptsovitsProblems,
  gptsovitsSettings,
  referenceName,
  synthesizeWithGptSoVits
} from '../src/qqb/tts-gptsovits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { flags: new Set(), values: {} };
  const takes = new Set(['--base-url', '--ref', '--ref-text', '--text', '--out', '--timeout', '--lang', '--install-dir']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (takes.has(a)) {
      out.values[a] = argv[i + 1] ?? '';
      i += 1;
    } else if (a.startsWith('--')) {
      out.flags.add(a);
    }
  }
  return out;
}

function loadVoiceConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return { voice: raw?.socialV2?.voice ?? {}, found: true };
  } catch (error) {
    return { voice: {}, found: false, error: error?.message ?? String(error) };
  }
}

/** 只读地看一眼「Python 环境 + 源码 + 权重」到不到位。 */
function checkInstall(installDir) {
  const dir = installDir || process.env.GPTSOVITS_DIR || 'D:\\34825\\zhuomian\\youqq\\_gptsovits';
  const report = { dir, python: null, source: null, models: null, notes: [] };
  const venvPython = path.join(dir, 'env', 'Scripts', 'python.exe');
  report.python = fs.existsSync(venvPython) ? venvPython : null;
  const srcDir = path.join(dir, 'GPT-SoVITS-main');
  report.source = fs.existsSync(path.join(srcDir, 'api_v2.py')) ? srcDir : null;
  const models = path.join(srcDir, 'GPT_SoVITS', 'pretrained_models');
  if (fs.existsSync(models)) {
    const wanted = [
      ['chinese-roberta-wwm-ext-large', 'BERT（中文）'],
      ['chinese-hubert-base', 'HuBERT（音色）'],
      ['gsv-v2final-pretrained', 'v2 底模'],
      ['s1v3.ckpt', 's1v3（v3/v4 用）'],
      ['gsv-v4-pretrained', 'v4 底模']
    ];
    report.models = wanted.map(([name, label]) => ({ name, label, ok: fs.existsSync(path.join(models, name)) }));
  } else {
    report.models = [];
    report.notes.push(`预训练权重目录还不存在：${models}（用 install.ps1 -Source ModelScope 下 pretrained_models.zip 解开）`);
  }
  if (!report.python) report.notes.push(`没有找到 Python 环境：${venvPython}（uv venv --python 3.10 建一个，再装 torch/torchaudio/requirements）`);
  return report;
}

const args = parseArgs(process.argv.slice(2));
const asJson = args.flags.has('--json');
const cfg = loadVoiceConfig();
// gptsovits 段住在 socialV2.voice.tts.gptsovits（与 bridge.js 的 voiceCfg() 同口径），
// 不是 socialV2.voice.gptsovits —— 别读错一层，否则会报「没配参考音频」。
const cfgGsv = cfg.voice?.tts?.gptsovits ?? {};
const cfgEngine = String(cfg.voice?.tts?.engine ?? 'sapi');

const rawSettings = {
  ...cfgGsv,
  ...(args.values['--base-url'] ? { baseUrl: args.values['--base-url'] } : {}),
  ...(args.values['--ref'] ? { refAudio: args.values['--ref'] } : {}),
  ...(args.values['--ref-text'] ? { refText: args.values['--ref-text'] } : {}),
  ...(args.values['--timeout'] ? { timeoutMs: Number(args.values['--timeout']) } : {}),
  ...(args.values['--lang'] ? { textLang: args.values['--lang'] } : {})
};
const settings = gptsovitsSettings(rawSettings, { root: ROOT });
const problems = gptsovitsProblems(settings);
const install = checkInstall(args.values['--install-dir']);
const health = await gptsovitsHealth({ baseUrl: settings.baseUrl, timeoutMs: settings.healthTimeoutMs });

let synth = null;
const wantSynth = !args.flags.has('--no-synth');
if (wantSynth && !problems.length && health.ok) {
  const text = args.values['--text'] || '主人，我在的，这是真人音色链路的一次试音。';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const out = path.resolve(ROOT, args.values['--out'] || path.join('audio', `gptsovits-check-${stamp}.wav`));
  const started = Date.now();
  try {
    const made = await synthesizeWithGptSoVits({ text, outPath: out, settings, root: ROOT });
    synth = { ok: true, ...made, elapsedMs: Date.now() - started, text };
  } catch (error) {
    synth = { ok: false, error: error?.message ?? String(error), elapsedMs: Date.now() - started, text, outPath: out };
  }
}

const ready = problems.length === 0 && health.ok && (!wantSynth || synth?.ok !== false);

if (asJson) {
  console.log(JSON.stringify({
    ok: ready,
    configFound: cfg.found,
    engine: cfgEngine,
    settings: { ...settings, refText: settings.refText ? `${settings.refText.slice(0, 20)}…` : '' },
    problems,
    health,
    install,
    synth
  }, null, 2));
  process.exit(ready ? 0 : 1);
}

console.log('GPT-SoVITS 链路体检\n');
console.log(`配置来源：   ${cfg.found ? path.join(ROOT, 'config.json') : `config.json 读不了（${cfg.error}）`}`);
console.log(`当前引擎：   socialV2.voice.tts.engine = ${cfgEngine}${cfgEngine === 'gptsovits' ? '' : '（不是 gptsovits，桥接仍用 Windows 自带声音）'}`);
console.log(`服务地址：   ${settings.baseUrl}（默认 ${DEFAULT_GPTSOVITS_BASE_URL}）`);
console.log(`参考音频：   ${settings.refAudio || '(没配)'}${settings.refAudio ? `（名字 ${referenceName(settings) || '?'}）` : ''}`);
console.log(`参考文本：   ${settings.refText ? `已配 ${settings.refText.length} 字` : '(没配)'}`);
console.log(`语言/切分：  text_lang=${settings.textLang} prompt_lang=${settings.promptLang} ${settings.textSplitMethod}`);
console.log(`超时/回落：  ${settings.timeoutMs}ms / fallback=${settings.fallback}`);

console.log('\n环境（只读检查）:');
console.log(`  安装目录：  ${install.dir}`);
console.log(`  Python：    ${install.python || '（没找到）'}`);
console.log(`  源码：      ${install.source || '（没找到 api_v2.py）'}`);
if (install.models?.length) {
  for (const m of install.models) console.log(`  权重 ${m.ok ? '✓' : '✗'}  ${m.label}（${m.name}）`);
}
for (const n of install.notes) console.log(`  ⚠️  ${n}`);

console.log('\n体检结果:');
if (problems.length) {
  for (const p of problems) console.log(`  ❌ 配置：${p}`);
} else {
  console.log('  ✅ 配置齐全');
}
if (health.ok) console.log(`  ✅ 服务活着（GET /control → HTTP ${health.status}）`);
else console.log(`  ❌ 服务连不上：${health.error}\n     起服务：<install>\\env\\Scripts\\python.exe api_v2.py -a 127.0.0.1 -p 9880`);
if (synth) {
  if (synth.ok) console.log(`  ✅ 合成成功：${synth.path}（${synth.bytes} 字节，${(synth.elapsedMs / 1000).toFixed(1)}s，音色 ${synth.voice}）`);
  else console.log(`  ❌ 合成失败：${synth.error}`);
}
if (!wantSynth) console.log('  ⏭️  按 --no-synth 跳过了合成');

console.log(ready ? '\n✅ 链路可用' : '\n❌ 链路还没就绪（上面标出的就是缺的那一环）');
process.exit(ready ? 0 : 1);