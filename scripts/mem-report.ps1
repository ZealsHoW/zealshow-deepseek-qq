# 看看谁在吃内存（2026-10-26）
#
# 这台机 16 GB，跑着 SnowLuma + 桥接 + MCP + Hindsight daemon + QQ + 联想那套 Tobii RGB 服务，
# 基线常常 10 GB 朝上，于是「声音模块」（GPT-SoVITS 要 8 GB 提交内存、ACE-Step 要 7~10 GB）根本起不来。
# 这里只读，不改任何东西：按「提交内存（Private）」排序列出前 N 个进程名，外加可用物理内存。
#
# 用法：powershell -NoProfile -File scripts\mem-report.ps1 [-Top 15]
param([int]$Top = 15)

$available = (Get-Counter '\Memory\Available MBytes' -ErrorAction SilentlyContinue).CounterSamples.CookedValue
$procs = Get-Process -ErrorAction SilentlyContinue
$totalPriv = [math]::Round((($procs | Measure-Object PrivateMemorySize64 -Sum).Sum) / 1MB)
$totalWs = [math]::Round((($procs | Measure-Object WorkingSet64 -Sum).Sum) / 1MB)

"可用物理内存：{0:N0} MB    提交合计（Private）：{1:N0} MB    工作集合计：{2:N0} MB    进程数：{3}" -f $available, $totalPriv, $totalWs, $procs.Count
""
"按进程名汇总（Private 降序）："
$procs | Group-Object ProcessName | ForEach-Object {
  [pscustomobject]@{
    名称 = $_.Name
    个数 = $_.Count
    '提交MB' = [math]::Round((($_.Group | Measure-Object PrivateMemorySize64 -Sum).Sum) / 1MB)
    '工作集MB' = [math]::Round((($_.Group | Measure-Object WorkingSet64 -Sum).Sum) / 1MB)
  }
} | Sort-Object '提交MB' -Descending | Select-Object -First $Top | Format-Table -AutoSize