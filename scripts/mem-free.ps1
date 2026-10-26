# 给「声音模块」腾内存（2026-10-26）
#
# 背景：这台机 16 GB。GPT-SoVITS 一加载模型就要 8 GB 提交内存，ACE-Step（唱歌）要 7~10 GB。
# 基线被这些常驻吃满时，声音模块起来就 OOM 或干脆卡 16 分钟（2026-10-26 13:44 那次实测）。
#
# 本脚本做两件**可逆**的事：
#   1) 停掉 Hindsight 本地记忆 daemon（127.0.0.1:9077，约 1.9~2.7 GB）—— 它只是我这个编码助手的记忆后端，
#      停了以后 🧠 记忆工具会暂不可用，`-Restore` 一条命令就回来。
#   2) 加 -Tobii 时停掉联想预装的 Tobii RGB/眼动服务（platform_runtime_RGB_service，两个进程约 1.7 GB）。
#      这两个是系统服务，**需要管理员**；不影响键盘灯（灯光是 LenovoLightingService 管的）。
#
# 用法：
#   powershell -NoProfile -File scripts\mem-free.ps1              # 只停 Hindsight，然后报可用内存
#   powershell -NoProfile -File scripts\mem-free.ps1 -Tobii       # 连 Tobii 一起停（管理员）
#   powershell -NoProfile -File scripts\mem-free.ps1 -Restore     # 把停掉的都开回来
#   powershell -NoProfile -File scripts\mem-free.ps1 -Report      # 只看不杀（等于 mem-report.ps1）
param(
  [switch]$Tobii,
  [switch]$Restore,
  [switch]$Report
)

$uvxExe = Join-Path $env:USERPROFILE '.local\bin\uvx.exe'
$env:UV_PYTHON = '3.13'
$env:HINDSIGHT_EMBED_DAEMON_STARTUP_TIMEOUT = '1800'

function AvailableMB {
  return [math]::Round((Get-Counter '\Memory\Available MBytes' -ErrorAction SilentlyContinue).CounterSamples.CookedValue)
}
function HindsightUp {
  return @(netstat -ano -p TCP | Select-String ':9077\s+.*LISTENING').Count -gt 0
}
function HindsightMemoryMB {
  $pid9077 = $null
  $line = (netstat -ano -p TCP | Select-String ':9077\s+.*LISTENING' | Select-Object -First 1).Line
  if ($line) { $pid9077 = [int]($line -split '\s+')[-1] }
  if (-not $pid9077) { return 0 }
  $p = Get-Process -Id $pid9077 -ErrorAction SilentlyContinue
  if (-not $p) { return 0 }
  return [math]::Round($p.PrivateMemorySize64 / 1MB)
}

if ($Report) { & (Join-Path $PSScriptRoot 'mem-report.ps1'); return }

if ($Restore) {
  if (-not (HindsightUp)) {
    "启动 Hindsight daemon…"
    & $uvxExe hindsight-embed@latest -p coding-agent daemon start 2>&1 | Select-Object -Last 2
    Start-Sleep -Seconds 5
  }
  "Hindsight: $(if (HindsightUp) { '已回来（9077 在听）' } else { '还没起来，30 秒后再看一次' })"
  if ($Tobii) {
    # 不需要管理员就能把服务改回自动（sc config 要管理员；这里只提醒）
    "Tobii 服务若要恢复：管理员执行  sc start TobiiRGB & sc start TobiiALENOVOYXX0"
  }
  "可用物理内存：$(AvailableMB) MB"
  return
}

$before = AvailableMB
"开始腾内存（可用 $before MB）"

if (HindsightUp) {
  $mb = HindsightMemoryMB
  "1) 停 Hindsight daemon（占 $mb MB）…"
  & $uvxExe hindsight-embed@latest -p coding-agent daemon stop 2>&1 | Select-Object -Last 1
  Start-Sleep -Seconds 3
} else {
  "1) Hindsight daemon 本来就没跑"
}

if ($Tobii) {
  "2) 停 Tobii RGB 服务（需要管理员）…"
  foreach ($svc in @('TobiiRGB', 'TobiiALENOVOYXX0')) {
    & sc.exe stop $svc 2>&1 | Select-String -Pattern 'SUCCESS|FAILED|失败|拒绝' | ForEach-Object { "   ${svc}: $($_.Line.Trim())" }
  }
  Start-Sleep -Seconds 3
} else {
  "2) Tobii RGB 没动（要停加 -Tobii，并用管理员运行；两个进程约 1.7 GB）"
}

Start-Sleep -Seconds 2
$after = AvailableMB
""
"腾完了：可用 $before MB → $after MB（多了 $(($after - $before)) MB）"
"要恢复：powershell -NoProfile -File scripts\mem-free.ps1 -Restore"