# 打完游戏：重新启用计划任务并启动小鲸鱼整套后台（含 DSH）。
$ErrorActionPreference = 'SilentlyContinue'
$tasks = @('\qq-bridge-watchdog', '\qq-bridge-memory-collector', '\qq-bridge-daily-backup')
foreach ($t in $tasks) { schtasks /change /tn $t /enable | Out-Null; Write-Host "已启用 $t" }
Start-Process -FilePath 'D:\dsh\DeepSeek Harness.exe' -WorkingDirectory 'D:\dsh'
schtasks /run /tn '\qq-bridge-watchdog' | Out-Null
Write-Host '看门狗已拉起：bridge / MCP / 音色 / SnowLuma / Ollama 会在 1~2 分钟内陆续就绪。'