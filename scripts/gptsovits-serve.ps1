# 小鲸鱼的真人音色服务启动器（GPT-SoVITS api_v2.py）
#
# 用法：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/gptsovits-serve.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/gptsovits-serve.ps1 -Port 9880 -Wait
#
# 只做三件事：找到 venv 里的 python、进到 GPT-SoVITS 源码目录、前台起 api_v2.py。
# 服务是桥接的外挂件：它挂了桥接会回落到 SAPI（socialV2.voice.gptsovits.fallback），
# 不会让发语音整条失败。关联设计见 README「真人音色（GPT-SoVITS，可选）」。

[CmdletBinding()]
param(
  [string]$InstallDir = $(if ($env:GPTSOVITS_DIR) { $env:GPTSOVITS_DIR } else { 'D:\34825\zhuomian\youqq\_gptsovits' }),
  [string]$Bind = '127.0.0.1',
  [int]$Port = 9880,
  [string]$TtsConfig = 'GPT_SoVITS/configs/tts_infer.yaml',
  [string]$Log = '',
  [switch]$Wait,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$python = Join-Path $InstallDir 'env\Scripts\python.exe'
$src = Join-Path $InstallDir 'GPT-SoVITS-main'
$api = Join-Path $src 'api_v2.py'

if (-not (Test-Path $python)) { throw "找不到 venv 里的 python：$python" }
if (-not (Test-Path $api)) { throw "找不到 api_v2.py：$api" }
if (-not (Test-Path (Join-Path $src $TtsConfig))) { throw "找不到模型配置：$(Join-Path $src $TtsConfig)" }

if (-not $Log) { $Log = Join-Path $src '..\serve.log' }
$Log = [System.IO.Path]::GetFullPath($Log)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) | Out-Null

# 中文与 emoji 走 UTF-8，避免 Windows 控制台代码页把日志搅成乱码
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'

# FFmpeg 的共享 DLL：torchaudio 2.11 的 load() 全部转交 torchcodec，而 libtorchcodec_*.dll
# 要在 PATH 上找得到 avcodec/avformat 这些 DLL 才能加载。没有它，读参考音频就会报
# 「Could not load libtorchcodec_core4.dll」。安装目录下的 ffmpeg\ 由 README 里的步骤下载。
$ffBin = Get-ChildItem -Path (Join-Path $InstallDir 'ffmpeg') -Filter 'bin' -Directory -Recurse -ErrorAction SilentlyContinue |
  Where-Object { Test-Path (Join-Path $_.FullName 'avcodec*.dll') } |
  Select-Object -First 1 -ExpandProperty FullName
if ($ffBin) {
  $env:PATH = "$ffBin;$env:PATH"
  if (-not $Quiet) { Write-Host "  FFmpeg：   $ffBin" }
} elseif (-not $Quiet) {
  Write-Host "  ⚠ 没找到 $InstallDir\ffmpeg\*\bin（torchaudio 读音频会失败，见 README）"
}

# jieba_fast 在这台机器上装不了（PyPI 只有源码包，需要 MSVC），用 scripts/gptsovits-shims
# 里的同名壳转发到纯 Python 的 jieba。顺手把壳目录固化进 site-packages 的 .pth，
# 这样不走本脚本、手动 `python api_v2.py` 也认得 jieba_fast。
$shimDir = Join-Path $PSScriptRoot 'gptsovits-shims'
if (Test-Path (Join-Path $shimDir 'jieba_fast\__init__.py')) {
  $env:PYTHONPATH = if ($env:PYTHONPATH) { "$shimDir;$env:PYTHONPATH" } else { $shimDir }
  $pth = Join-Path $InstallDir 'env\Lib\site-packages\_gptsovits_shims.pth'
  $old = if (Test-Path $pth) { (Get-Content -LiteralPath $pth -Raw).Trim() } else { '' }
  if ($old -ne $shimDir) {
    Set-Content -LiteralPath $pth -Value $shimDir -Encoding ascii
    if (-not $Quiet) { Write-Host "  已登记 jieba_fast 替代壳：$pth" }
  }
}

if (-not $Quiet) {
  Write-Host "小鲸鱼真人音色服务"
  Write-Host "  安装目录：$InstallDir"
  Write-Host "  监听：    http://${Bind}:${Port}"
  Write-Host "  日志：    $Log"
  Write-Host "  探活：    curl http://${Bind}:${Port}/control   （回 400 command is required 就是活着）"
  Write-Host "  首次启动要加载模型，可能要一两分钟。Ctrl+C 结束。"
}

# api_v2.py 里大量相对路径（GPT_SoVITS/…），必须在源码目录下跑
# 走 gptsovits-serve.py 这一层而不是直接起 api_v2.py：它会把真正的 PID 写进
# state/gptsovits-serve.pid，桥接唱歌前就能停掉「正在加载、还没监听端口」的这个进程。
$launcher = Join-Path $PSScriptRoot 'gptsovits-serve.py'
if (-not (Test-Path $launcher)) { throw "找不到启动器：$launcher" }
Push-Location $src
try {
  $line = "[{0}] 启动 api_v2.py -a {1} -p {2} -c {3}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Bind, $Port, $TtsConfig
  Add-Content -LiteralPath $Log -Value $line -Encoding utf8
  if ($Wait) {
    & $python $launcher $api -a $Bind -p $Port -c $TtsConfig *>&1 | Tee-Object -FilePath $Log -Append
    exit $LASTEXITCODE
  } else {
    # 后台跑（看门狗就是这么起的）时也把输出写进日志：隐藏窗口里崩掉，不落盘就完全查不到原因
    # （2026-10-24 就踩过：服务起不来、日志里只有一行「启动 api_v2.py」，python 的报错全丢了）。
    & $python $launcher $api -a $Bind -p $Port -c $TtsConfig *>&1 | Tee-Object -FilePath $Log -Append
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}