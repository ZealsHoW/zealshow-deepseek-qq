#!/usr/bin/env node
// 看门狗（qq-bridge-keepalive.ps1）里的「真人音色服务保活」接线回归。
//
// 为什么要有这条：2026-10-24 的故障是「GPT-SoVITS 被 DSH 重启带走」——那个服务原来
// 是手工从 DSH 终端 Start-Process 起的，属于 DSH 的作业对象，DSH 一换端口就被连坐杀掉，
// 症状是「语音还能发，但全是机器音」（tts.fallback 默认 true 会静默回落 SAPI）。
// 现在改由看门狗在 DSH 之外托管；这个脚本盯着那几处接线别再被改回去。
//
// 看门狗脚本在仓库根目录之外（`qq-bridge` 的上一级），所以：
//   - 找不到就 SKIP（换台机器跑自测不该因为少一个本地运维脚本而红）；
//   - 找到就断言关键结构（门禁 / 探活方式 / 退避 / 步骤位置）。
//
// 用法：node scripts/test-keepalive-tts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KEEPALIVE = path.resolve(ROOT, '..', 'qq-bridge-keepalive.ps1');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); } else { fail += 1; console.error(`  ❌ ${name}`); }
}

if (!fs.existsSync(KEEPALIVE)) {
  console.log(`⏭ 跳过：看门狗脚本不在本机（${KEEPALIVE}）`);
  console.log('   它属于本机运维脚本，不在仓库里；没有它就没什么可断言的。');
  process.exit(0);
}

const src = fs.readFileSync(KEEPALIVE, 'utf8');
console.log('## 单实例保护（VBS 与计划任务双入口不能打出两个看门狗）');
{
  ok(/New-Object System\.Threading\.Mutex\(\$false, 'Local\\qq-bridge-keepalive'\)/.test(src),
    '有 Local\\qq-bridge-keepalive 互斥量');
  ok(/WaitOne\(0\)/.test(src), '拿不到互斥量就退出（非阻塞）');
}

console.log('## 真人音色服务（GPT-SoVITS）保活');
{
  ok(/function Get-TtsSettings/.test(src), '有 Get-TtsSettings（判断该不该管）');
  ok(/function Test-TtsHttp/.test(src), '有 Test-TtsHttp（探活）');
  ok(/function Start-TtsService/.test(src), '有 Start-TtsService（拉起）');
  ok(/gptsovits-serve\.ps1/.test(src), '拉起的是 scripts/gptsovits-serve.ps1');
  // 门禁：只有引擎真的配成 gptsovits 才管，否则配了 SAPI 的机器也会白跑一个服务
  ok(/-ne 'gptsovits'/.test(src), '按 socialV2.voice.tts.engine 门禁（-ne \'gptsovits\' 就跳过）');
  ok(/enabled -eq \$false/.test(src), '尊重 gptsovits.enabled:false');
  ok(/\$g\.baseUrl/.test(src) && /\[regex\]::Match\(/.test(src), '端口从 gptsovits.baseUrl 里解析（不是写死 9880）');
  // 探活方式：这台机器上 Get-NetTCPConnection 偶尔卡几分钟，TTS 段必须走 curl
  const ttsStart = src.indexOf('# ── 真人音色服务 GPT-SoVITS');
  const ttsEnd = src.indexOf('# ── 余额告警', ttsStart);
  const ttsBlock = ttsStart >= 0 && ttsEnd > ttsStart ? src.slice(ttsStart, ttsEnd) : '';
  // 注释里**允许**提到 Get-NetTCPConnection（说明为什么不用它），所以只查真正的代码行
  const ttsCode = ttsBlock
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  ok(ttsBlock.length > 0, '能定位到真人音色服务那一段');
  ok(/curl\.exe/.test(ttsCode) && /\/control/.test(ttsCode), '探活走 curl.exe …/control（收到 400 就算活）');
  ok(!/Get-NetTCPConnection/.test(ttsCode), '探活的代码不用 Get-NetTCPConnection（会卡几分钟）');
  ok(/--max-time/.test(ttsCode), '探活带 --max-time（不会把看门狗拖住）');
}

console.log('## 主循环里的接线');
{
  ok(/# 3\.7\) 真人音色服务/.test(src), '主循环有 3.7) 步骤');
  const stepStart = src.indexOf('# 3.7) 真人音色服务');
  const stepEnd = src.indexOf('# 4) bridge', stepStart);
  const step = stepStart >= 0 && stepEnd > stepStart ? src.slice(stepStart, stepEnd) : '';
  ok(step.length > 0, '能定位到 3.7) 步骤');
  ok(/\$tts = Get-TtsSettings/.test(step), '步骤里先取 Get-TtsSettings');
  ok(/Test-TtsHttp \$tts\.port/.test(step), '服务不活才处理（Test-TtsHttp）');
  ok(/Start-TtsService \$tts\.port/.test(step), '真的会调 Start-TtsService');
  // 首次加载模型要一两分钟，退避窗口必须比它长，否则加载窗口里会重复拉起
  const m = /TotalSeconds -gt (\d+)/.exec(step);
  ok(Boolean(m) && Number(m[1]) >= 120, `两次拉起之间留足退避（${m ? m[1] : '?'} 秒 ≥ 120）`);
  ok(/\$lastTtsAttempt = \(Get-Date\)\.AddDays\(-1\)/.test(src), '$lastTtsAttempt 初值在启动时给（首轮就会检查）');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);