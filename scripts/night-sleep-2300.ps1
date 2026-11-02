# 每晚 23:00 自动让小鲸鱼进入晚安休眠（主人 2026-10-26 要求）。
# 由计划任务 \qq-bridge-night-sleep 调用，失败只记日志、不弹窗。
# 2026-11-02 主人：「可以让她睡到 8、9 点才醒」——不传 hours，由 config 的
# socialV2.nightRitual.wakeAtHour（8.5 = 08:30）算到那个钟点，早睡晚睡都落在同一个早上。
$ErrorActionPreference = 'Stop'
$root = 'D:\34825\zhuomian\youqq\qq-bridge'
$logFile = Join-Path $root 'state\night-sleep-schedule.log'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
try {
  $tok = (Get-Content (Join-Path $root 'state\console-token') -Raw).Trim()
  $body = '{"action":"start"}'
  $resp = Invoke-WebRequest -Method Post `
    -Uri 'http://127.0.0.1:3100/api/socialV2/night-sleep' `
    -Headers @{ 'x-console-token' = $tok } `
    -ContentType 'application/json' -Body $body -TimeoutSec 25 -UseBasicParsing
  $payload = $resp.Content | ConvertFrom-Json
  $wake = if ($payload.wakeAt) { ([DateTimeOffset]::Parse($payload.wakeAt)).ToLocalTime().ToString('yyyy-MM-dd HH:mm') } else { '?' }
  $line = "$stamp ok：已进入休眠，预计 $wake 醒（alreadyActive=$($payload.alreadyActive)）"
} catch {
  $line = "$stamp 失败：$($_.Exception.Message)"
}
Add-Content -Path $logFile -Value $line -Encoding utf8