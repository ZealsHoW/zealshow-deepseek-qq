// 本机语音合成（TTS）—— 让「她当场说一句话」成为可能，而不是只能发语音库里现成的音频文件。
//
// 为什么用 Windows 自带的 SAPI / OneCore，而不是装 Python+edge-tts、ComfyUI、RVC、GPT-SoVITS：
//   1. 零下载、零依赖：这台机器上没有 Python（只有应用商店占位符）、没有 ffmpeg、没有 torch，
//      但 Windows 11 中文版自带中文声音（SAPI5 的 "Microsoft Huihui Desktop"；OneCore 还多
//      Kangkang / Yaoyao）—— 一次 fork 就能出声。主线是「先把文字→语音条整条链路打通」，
//      真人音色（GPT-SoVITS）是第二步：那要下模型、要显卡常驻，不该挡住第一步。
//   2. 失败了也只是「这条语音没发出去」，不影响文字聊天。
//
// 安全（这条最关键）：**文字只通过临时文件传递，绝不拼进命令行。**
//   Windows 上把聊天内容拼进 powershell 的参数字符串时，一句带引号/反引号/分号的文字就能
//   变成一段 PowerShell 代码（prompt injection → 本机命令执行）。所以这里的链路是：
//     文字 → UTF-8 临时 .txt → 脚本内部 ReadAllText 读取；命令行参数里只有路径和数字。
//   PS 脚本本身也落成临时 .ps1 再 -File 执行，同样是为了不给命令行留任何拼接余地。
//
// 产物：44 字节 RIFF 头的 wav（SAPI 的 SAFT22kHz16BitMono）。QQ 那条链路由 SnowLuma 自己
// 转 SILK，本机不需要 ffmpeg；ffprobe 缺失也只让「时长校验」退化成警告（见 voice-core.js）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Windows PowerShell 5.1 的绝对路径。
 * 为什么不用 pwsh：SAPI 的 COM 与 OneCore 的 WinRT 投影在 Windows PowerShell 5.1 上最稳，
 * 且它随系统自带（pwsh 是可选安装的）。
 */
export function powershellPath() {
  const win = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const full = path.join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    if (fs.existsSync(full)) return full;
  } catch {}
  return 'powershell.exe';
}

/** 本机能不能合成语音（非 Windows 或没有 PowerShell 就是不能 —— 上层据此给可读的错误）。 */
export function ttsAvailable() {
  if (process.platform !== 'win32') return false;
  const p = powershellPath();
  if (p === 'powershell.exe') return true; // 交给 PATH 决定
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * 内嵌的 PowerShell 脚本（真正干活的地方）。
 *
 * 参数里**只有文件路径与数字**，没有用户文字：
 *   -TextFile 要合成的文字（UTF-8 纯文本文件）
 *   -Out      输出 wav 路径
 *   -Voice    声音名（空 = 自动挑中文声音；匹配不到就走 OneCore 兜底）
 *   -Rate     SAPI 语速（-10..10）
 *
 * 注意：模板字符串里刻意**不出现反引号与 ${**（PowerShell 的转义符与变量展开写法都绕开了），
 * 否则 JS 侧会把它当模板语法吃掉。
 */
export const TTS_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Voice = '',
  [int]$Rate = 0
)
$ErrorActionPreference = 'Stop'
$engine = ''
$used = ''
try {
  if (-not (Test-Path -LiteralPath $TextFile)) { throw "找不到文本文件：$TextFile" }
  $text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
  if ([string]::IsNullOrWhiteSpace($text)) { throw '要合成的文字是空的' }
  try { if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force } } catch {}
  # ---- 1) SAPI5（系统自带；中文一般是 Microsoft Huihui Desktop）----
  try {
    $sapi = New-Object -ComObject SAPI.SpVoice
    $voices = $sapi.GetVoices()
    $pick = $null
    for ($i = 0; $i -lt $voices.Count; $i++) {
      $desc = [string]$voices.Item($i).GetDescription()
      if ($Voice -eq '') {
        if ($desc -match 'Chinese|Huihui|zh-CN') { $pick = $voices.Item($i); break }
      } elseif ($desc -like "*$Voice*") {
        $pick = $voices.Item($i); break
      }
    }
    if ($pick -eq $null -and $Voice -eq '' -and $voices.Count -gt 0) { $pick = $voices.Item(0) }
    if ($pick -ne $null) {
      $sapi.Voice = $pick
      $sapi.Rate = $Rate
      $stream = New-Object -ComObject SAPI.SpFileStream
      $stream.Format.Type = 22
      $stream.Open($Out, 3, $false)
      $sapi.AudioOutputStream = $stream
      $sapi.Speak($text) | Out-Null
      $stream.Close()
      $used = [string]$pick.GetDescription()
      $engine = 'sapi5'
    }
  } catch { $engine = ''; $used = '' }
  # ---- 2) OneCore（兜底：SAPI5 里没有能用的声音时，用 WinRT 合成器）----
  if ($engine -eq '') {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
    })[0]
    # WinRT 类型在 Windows PowerShell 5.1 里必须用「程序集限定名 + ContentType=WindowsRuntime」才认得出，
    # 光写类型短名会报 TypeNotFound（实测）。
    $synth = [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]::new()
    $all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]::AllVoices
    $chosen = $null
    foreach ($v in $all) {
      if ($Voice -eq '') {
        if ([string]$v.Language -like 'zh*') { $chosen = $v; break }
      } elseif ([string]$v.DisplayName -like "*$Voice*" -or [string]$v.Id -like "*$Voice*") {
        $chosen = $v; break
      }
    }
    if ($chosen -eq $null -and $Voice -ne '') {
      $names = @()
      foreach ($v in $all) { $names += [string]$v.DisplayName }
      throw "本机没有叫「$Voice」的语音合成声音；可用：" + ($names -join '、')
    }
    if ($chosen -ne $null) {
      $synth.Voice = $chosen
    } else {
      # 取第一个声音（不能用 $all[0] 直接赋值：IVectorView 下标拿到的 COM 包装对象
      # 会在赋值时报「无法转换为 VoiceInformation」，foreach 出来的对象没这个问题）
      foreach ($v in $all) { $synth.Voice = $v; break }
    }
    $op = $synth.SynthesizeTextToStreamAsync($text)
    $task = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]).Invoke($null, @($op))
    $null = $task.Wait(60000)
    $speech = $task.Result
    $inStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($speech)
    $outStream = [System.IO.File]::Create($Out)
    $inStream.CopyTo($outStream)
    $outStream.Close()
    $inStream.Close()
    $used = [string]$synth.Voice.DisplayName
    $engine = 'onecore'
  }
  if ($engine -eq '' -or -not (Test-Path -LiteralPath $Out)) {
    throw '本机没有可用的语音合成声音（SAPI5 与 OneCore 都没出声）'
  }
  if ((Get-Item -LiteralPath $Out).Length -le 0) { throw '语音合成产物为空' }
} catch {
  # 错误信息写成 UTF-8 文件交给 node 读：PowerShell 的 stderr 在中文系统上是 GBK，
  # 直接由 node 解码会是乱码（实测「语音合成失败：m.__ComObject…」那种）。
  $msg = [string]$_.Exception.Message
  if ([string]::IsNullOrWhiteSpace($msg)) { $msg = ($_ | Out-String) }
  try { [System.IO.File]::WriteAllText("$Out.err.txt", $msg, (New-Object System.Text.UTF8Encoding($false))) } catch {}
  exit 3
}
# 实际用到的引擎/声音写进 <Out>.voice.txt，node 侧读一次就删（回执给上层做日志与断言）
[System.IO.File]::WriteAllText("$Out.voice.txt", "$engine|$used", (New-Object System.Text.UTF8Encoding($false)))
Write-Output $Out
`;

/** 列声音用的小脚本：SAPI5 与 OneCore 各一份，输出 JSON。 */
const LIST_SCRIPT = String.raw`
$sapi = @()
try {
  $v = New-Object -ComObject SAPI.SpVoice
  $voices = $v.GetVoices()
  for ($i = 0; $i -lt $voices.Count; $i++) { $sapi += [string]$voices.Item($i).GetDescription() }
} catch {}
$one = @()
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $allVoices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]::AllVoices
  foreach ($x in $allVoices) { $one += [string]$x.DisplayName }
} catch {}
@{ sapi = $sapi; onecore = $one } | ConvertTo-Json -Compress
`;

/** 跑一段 PowerShell 脚本文件，收集 stdout/stderr（超时杀进程，不抛异常）。 */
function runPowershell(scriptPath, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
        windowsHide: true
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: `PowerShell 启动失败：${error?.message ?? error}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, Math.max(1000, Number(timeoutMs) || 30000));
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}${e?.message ?? e}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** 把一段文字合成为 wav 文件。成功返回 { path, bytes, engine, voice }，失败抛出可读的中文错误。 */
export async function synthesizeToFile({ text, outPath, voice = '', rate = 0, timeoutMs = 30000 } = {}) {
  const content = String(text ?? '');
  if (!content.trim()) throw new Error('要合成的文字是空的');
  if (!outPath) throw new Error('缺少输出路径 outPath');
  if (!ttsAvailable()) throw new Error('本机没有可用的语音合成（仅支持 Windows 自带的 SAPI/OneCore 声音）');
  const out = path.resolve(String(outPath));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-'));
  const scriptFile = path.join(tmp, 'tts.ps1');
  const textFile = path.join(tmp, 'text.txt');
  try {
    // BOM 不是可选项：Windows PowerShell 5.1 读**没有 BOM** 的 .ps1 时会按系统 ANSI
    // （中文 Windows 是 GBK）解码，脚本里的中文字符串会被解坏 —— 实测报
    // "表达式或语句中包含意外的标记"（ParserError）。加 BOM 后它才按 UTF-8 读。
    fs.writeFileSync(scriptFile, `\uFEFF${TTS_SCRIPT}`, 'utf8');
    // 文本文件不用 BOM：脚本里是 ReadAllText(..., Encoding::UTF8) 显式读的。
    fs.writeFileSync(textFile, content, 'utf8');
    const rateNum = Number.isFinite(Number(rate)) ? Math.trunc(Math.max(-10, Math.min(10, Number(rate)))) : 0;
    const res = await runPowershell(
      scriptFile,
      ['-TextFile', textFile, '-Out', out, '-Voice', String(voice ?? ''), '-Rate', String(rateNum)],
      { timeoutMs }
    );
    if (res.code !== 0 || !fs.existsSync(out)) {
      // 优先读脚本写下的 UTF-8 错误文件（PS 的 stderr 在中文系统上是 GBK，node 直接解码会乱码）
      let why = '';
      try { why = String(fs.readFileSync(`${out}.err.txt`, 'utf8')).trim(); } catch {}
      if (!why) {
        why = String(res.stderr || res.stdout || '')
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-3)
          .join(' / ');
      }
      try { fs.rmSync(`${out}.err.txt`, { force: true }); } catch {}
      throw new Error(`语音合成失败${why ? `：${why}` : ''}`);
    }
    const st = fs.statSync(out);
    if (!st.size) throw new Error('语音合成产物为空');
    let engine = 'sapi5';
    let usedVoice = '';
    try {
      const meta = fs.readFileSync(`${out}.voice.txt`, 'utf8');
      const [e, v] = String(meta).split('|');
      if (e) engine = e;
      if (v) usedVoice = v;
    } catch {}
    try { fs.rmSync(`${out}.voice.txt`, { force: true }); } catch {}
    return { path: out, bytes: st.size, engine, voice: usedVoice };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/** 列出本机可用的合成声音（SAPI5 / OneCore）。诊断与测试用，read-only。 */
export async function listTtsVoices({ timeoutMs = 20000 } = {}) {
  if (!ttsAvailable()) return { ok: false, error: '本机不支持（仅 Windows 自带声音）', sapi: [], onecore: [] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tts-list-'));
  const scriptFile = path.join(tmp, 'list.ps1');
  try {
    fs.writeFileSync(scriptFile, `\uFEFF${LIST_SCRIPT}`, 'utf8');
    const res = await runPowershell(scriptFile, [], { timeoutMs });
    const line = String(res.stdout || '')
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x.startsWith('{'))
      .pop();
    if (!line) return { ok: false, error: String(res.stderr || '没拿到声音列表').trim().slice(0, 300), sapi: [], onecore: [] };
    const parsed = JSON.parse(line);
    const arr = (x) => (Array.isArray(x) ? x.filter(Boolean) : x ? [String(x)] : []);
    return { ok: true, sapi: arr(parsed.sapi), onecore: arr(parsed.onecore) };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error), sapi: [], onecore: [] };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}