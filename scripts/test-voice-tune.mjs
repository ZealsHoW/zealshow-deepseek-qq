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