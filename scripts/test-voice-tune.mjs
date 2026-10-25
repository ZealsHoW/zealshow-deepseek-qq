#!/usr/bin/env node
// voice-tune.mjs 的回归：变调数学 + 变体命名 + 接线（README / package.json）。
// 不跑 ffmpeg、不连 TTS —— 那些要真机才验，`node scripts/voice-tune.mjs ...` 就是那条路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePitchList, pitchFilter, warmFilter, variantName, tuneFilter,
} from './voice-tune.mjs';
import { parseArgs as parseProbeArgs, probeOutPath, DEFAULT_TEXT as DEFAULT_PROBE_TEXT } from './voice-probe.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('变调滤镜：0 半音是恒等变换', () => {
  const f = pitchFilter(0);
  assert.match(f, /asetrate=32000\*1\.0000/);
  assert.match(f, /aresample=32000/);
  assert.match(f, /atempo=1\.0000/);
});

test('变调滤镜：降 2 个半音 = 比率 0.8909、atempo 1.1225', () => {
  const f = pitchFilter(-2);
  assert.match(f, /asetrate=32000\*0\.8909/);
  assert.match(f, /atempo=1\.1225/);
});

test('变调滤镜：整个八度就是减半/翻倍，时长还补得回来', () => {
  const down = pitchFilter(-12);
  assert.match(down, /asetrate=32000\*0\.5000/);
  assert.match(down, /atempo=2\.0000/);
  const up = pitchFilter(12);
  assert.match(up, /asetrate=32000\*2\.0000/);
  assert.match(up, /atempo=0\.5000/);
  // 比率 × atempo 必须恒为 1，否则出来的音频会变长/变短（跑调又变时长的经典事故）
  for (const n of [-11, -5, -2, 0, 3, 7, 11]) {
    const m = pitchFilter(n).match(/asetrate=32000\*([\d.]+),aresample=32000,atempo=([\d.]+)/);
    assert.ok(m, `滤镜格式不对：${pitchFilter(n)}`);
    assert.ok(Math.abs(Number(m[1]) * Number(m[2]) - 1) < 0.002, `比率×atempo 应约等于 1（${n} 半音）`);
  }
});

test('暖化滤镜：两个 equalizer（200Hz 抬、4kHz 压）', () => {
  const f = warmFilter();
  assert.match(f, /equalizer=f=200:t=q:w=1:g=2/);
  assert.match(f, /equalizer=f=4000:t=q:w=1:g=-2/);
});

test('变体命名：p0 / m2 / p2 / m2-warm', () => {
  assert.equal(variantName(0), 'p0');
  assert.equal(variantName(-2), 'm2');
  assert.equal(variantName(2), 'p2');
  assert.equal(variantName(-2, true), 'm2-warm');
  assert.equal(variantName(0, true), 'p0-warm');
});

test('滤镜链顺序：变调在前、暖化在后', () => {
  assert.equal(tuneFilter(-2, true), `${pitchFilter(-2)},${warmFilter()}`);
  assert.equal(tuneFilter(-2, false), pitchFilter(-2));
});

test('--pitch 解析：逗号/中文逗号/空格/正号都认，越界夹到 ±11', () => {
  assert.deepEqual(parsePitchList('0,-1,-2'), [0, -1, -2]);
  assert.deepEqual(parsePitchList('0，-2'), [0, -2]);
  assert.deepEqual(parsePitchList(' +2  -3 '), [2, -3]);
  assert.deepEqual(parsePitchList('-2,-2'), [-2], '重复值去重');
  assert.deepEqual(parsePitchList('99'), [11]);
  assert.deepEqual(parsePitchList('-99'), [-11]);
  assert.deepEqual(parsePitchList(''), [0]);
  assert.throws(() => parsePitchList('abc'), /不是数字/);
});

test('接线：README 与 package.json 都提到了这条命令', () => {
  assert.ok(README.includes('scripts/voice-tune.mjs'), 'README 没写 voice-tune 用法');
  assert.ok(README.includes('asetrate'), 'README 没解释变调数学');
  assert.ok(README.includes('ref-m2'), 'README 没给出一版实测例子');
  assert.equal(PKG.scripts['test:voice-tune'], 'node scripts/test-voice-tune.mjs');
  assert.equal(PKG.scripts['voice:tune'], 'node scripts/voice-tune.mjs');
});

// ── 挑参考片段那条路（2026-10-25 主人丢来 113 秒录音说「就用这个当音色」时补的） ──
test('voice-probe：--ref-text 必填（GPT-SoVITS 靠它对齐音素，猜错比不给更糟）', () => {
  assert.throws(() => parseProbeArgs(['--ref', 'a.wav']), /--ref-text/);
  assert.throws(() => parseProbeArgs(['--ref', 'a.wav', '--ref-text', '   ']), /不能是空白/);
  assert.throws(() => parseProbeArgs(['--ref-text', 'x']), /缺少 --ref/);
  assert.throws(() => parseProbeArgs(['--ref', 'a.wav', '--ref-text', 'x', '--wat']), /不认识的参数/);
  assert.throws(() => parseProbeArgs(['--ref', 'a.wav', '--ref-text']), /要跟一个值/);
});

test('voice-probe：默认探针台词固定、产物落在 audio/cand/ 且按参考名命名', () => {
  const o = parseProbeArgs(['--ref', 'audio/ref/xiaojing-6s.wav', '--ref-text', '逐字文本']);
  assert.equal(o.text, DEFAULT_PROBE_TEXT, '探针台词要默认固定，横向比才可比');
  assert.equal(probeOutPath('audio/ref/xiaojing-6s.wav'), path.join('audio', 'cand', 'probe-xiaojing-6s.wav'));
  assert.equal(probeOutPath('x.wav', 'tmp/a.wav'), 'tmp/a.wav', '显式 --out 优先');
});

test('接线：挑参考片段的两步（切候选 / 合成探针）都写进了 README 与 package.json', () => {
  assert.ok(README.includes('pick-ref-segment.py'), 'README 没写怎么从长录音里切候选');
  assert.ok(README.includes('sentence_timestamp'), 'README 没解释句子级时间戳从哪来');
  assert.ok(README.includes('voice:probe'), 'README 没写怎么合成探针');
  assert.equal(PKG.scripts['voice:probe'], 'node scripts/voice-probe.mjs');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'pick-ref-segment.py')), '缺 scripts/pick-ref-segment.py');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'voice-probe.mjs')), '缺 scripts/voice-probe.mjs');
});

test('朴素：切参考片段的默认清洗链不许再带压缩/限幅/loudnorm（2026-10-25「回声」教训）', () => {
  const py = fs.readFileSync(path.join(ROOT, 'scripts', 'pick-ref-segment.py'), 'utf8');
  const gentleAt = py.indexOf("'gentle':");
  const offAt = py.indexOf("'off':");
  assert.ok(gentleAt > 0 && offAt > gentleAt, 'pick-ref-segment.py 里应该有 gentle / off 两档清洗链');
  const gentle = py.slice(gentleAt, offAt);
  for (const bad of ['acompressor', 'alimiter', 'loudnorm']) {
    assert.ok(!gentle.includes(bad), `默认清洗链里不该有 ${bad}：它抬底噪和混响尾巴，克隆会学成回声`);
  }
  assert.ok(py.includes('--clean') || py.includes("add_argument('--clean'"), '缺 --clean 开关');
  assert.ok(README.includes('--clean'), 'README 没写清洗链怎么选');
});

test('朴素：--pitch 变调必须先对齐采样率（44.1k 素材直接 asetrate 会变慢+反掉）', () => {
  const py = fs.readFileSync(path.join(ROOT, 'scripts', 'pick-ref-segment.py'), 'utf8');
  assert.ok(py.includes('def pitch_filter('), '缺 pitch_filter()');
  const m = py.match(/return \('(aresample=[^']+)'/);
  assert.ok(m, 'pitch_filter 的返回值应当是「先 aresample 对齐采样率再 asetrate」的滤镜串');
  assert.ok(m[1].indexOf('aresample=') === 0, 'pitch_filter 必须先 aresample 对齐输入采样率');
  assert.ok(m[1].indexOf('asetrate=') > 0, 'asetrate 要排在 aresample 之后');
  assert.ok(py.includes('asetrate=%d*%.6f'), 'asetrate 要用传入的采样率而不是写死 32000*R');
  assert.ok(py.includes("'--pitch'"), '缺 --pitch 开关');
  assert.ok(README.includes('--pitch'), 'README 没写 --pitch');
});