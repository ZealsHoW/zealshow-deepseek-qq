# 醒来兜底（2026-10-26）：她进入晚安休眠时看门狗等计划任务会被停用、正在跑的那一轮也会被 end 掉，
# 这个脚本由**一次性**任务 \qq-bridge-night-wake 在醒来时间调用 —— 把三个任务重新启用，
# 再把看门狗拉回来值班（脚本自己有 Local\qq-bridge-keepalive 互斥锁，多拉一次不会并存）。
$ErrorActionPreference = 'Stop'
$root = 'D:\34825\zhuomian\youqq\qq-bridge'
$logFile = Join-Path $root 'state\night-sleep-schedule.log'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$tasks = @('\qq-bridge-watchdog', '\qq-bridge-memory-collector', '\qq-bridge-daily-backup')
try {
  $enabled = 0
  foreach ($name in $tasks) {
    & schtasks /change /tn $name /enable 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $enabled += 1 }
  }
  $listening = @(netstat -ano | Select-String ':3100\s+.*LISTENING').Count -gt 0
  & schtasks /run /tn '\qq-bridge-watchdog' 2>&1 | Out-Null
  $state = if ($listening) { '桥接在跑' } else { '桥接没在跑，看门狗会补' }
  Add-Content -Path $logFile -Value "$stamp 醒来兜底：启用任务 $enabled/$($tasks.Count)，已让看门狗继续值班（$state）" -Encoding utf8
} catch {
  Add-Content -Path $logFile -Value "$stamp 醒来兜底失败：$($_.Exception.Message)" -Encoding utf8
} finally {
  # 跑一次就够了：把自己从计划任务里撤掉（正常醒来时桥接那边的 clearNightWakeTask 也会删）
  & schtasks /delete /tn '\qq-bridge-night-wake' /f 2>&1 | Out-Null
}