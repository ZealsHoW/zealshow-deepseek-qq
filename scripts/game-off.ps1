# 打游戏前：把 QQ 机器人整套后台关掉，并停用会自动拉起的计划任务。
# 用法：双击 game-off.cmd（或 pwsh -File scripts\game-off.ps1）
$ErrorActionPreference = 'SilentlyContinue'
$tasks = @('\qq-bridge-watchdog', '\qq-bridge-memory-collector', '\qq-bridge-daily-backup')
foreach ($t in $tasks) { schtasks /change /tn $t /disable | Out-Null; Write-Host "已停用 $t" }

$ports = 3100, 3210, 3000, 3001, 9880, 11434, 9077
$pids = netstat -ano | Select-String 'LISTENING' | ForEach-Object {
  $f = $_.Line -split '\s+'
  $port = [int](($f[1] -split ':')[-1])
  if ($ports -contains $port) { [int]$f[-1] }
} | Sort-Object -Unique
foreach ($p in $pids) { Stop-Process -Id $p -Force; Write-Host "已关掉 PID $p" }

Get-Process -Name 'ollama app', 'ollama' | Stop-Process -Force
Get-Process python | Where-Object { $_.Path -like '*\uv\*' } | Stop-Process -Force
Get-Process -Name 'DeepSeek Harness' | Stop-Process -Force
Write-Host '全部关掉了，可以打游戏。恢复请双击 game-on.cmd。'