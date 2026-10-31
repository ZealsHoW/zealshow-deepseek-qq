/**
 * 她睡着时看门狗歇着（2026-10-26 主人要求：「在小鲸休息的时候，看门狗等可以不用开启，保持关闭即可」）。
 *
 * 背景：看门狗每 60 秒查一遍服务、每天 5 分钟弹一个采集窗口，睡着时纯属空转；更早还有
 * `Start-Dsh` 不带 `-WindowStyle Hidden` 导致 30~60 秒弹一个运行框。
 *
 * 现在的行为：
 *   1) 进入晚安休眠 → 停用三个计划任务（看门狗 / 记忆采集 / 每日备份），并建一个**一次性**任务
 *      `\qq-bridge-night-wake` 兜底（`/z` 跑完自删）；
 *   2) 醒来 / 取消休眠 → 重新启用任务、删掉兜底任务；
 *   3) 桥接中途重启但还在睡 → `loadNightSleepState()` 把「停用」重新落实；
 *   4) 看门狗自己每轮先看 `state/night-sleep.json`，睡着就 5 分钟一轮空转，不查服务也不拉 DSH。
 *
 * 这里只做源码/文件断言（真的去改计划任务要管理员权限，也会碰到主人的机器状态）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.dirname(here);
const bridgeSrc = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
const keepaliveSrc = fs.readFileSync(path.join(root, '..', 'qq-bridge-keepalive.ps1'), 'utf8');
const wakeScriptPath = path.join(root, 'scripts', 'night-wake.ps1');

const results = [];
function ok(cond, name) {
  results.push({ cond: Boolean(cond), name });
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}`);
}

/** 从 `startNightSleep` 之类函数名开始，切到下一个同缩进的 `function`/注释块，拿到函数体。 */
function bodyOf(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const rest = src.slice(at);
  const end = rest.search(/\n {2}\}\n/);
  return end < 0 ? rest : rest.slice(0, end);
}

// ── bridge.js ────────────────────────────────────────────────────────────────
ok(bridgeSrc.includes("const SLEEP_QUIET_TASKS = ['\\\\qq-bridge-watchdog', '\\\\qq-bridge-memory-collector', '\\\\qq-bridge-daily-backup'];"),
  '休眠期间要停用的三个计划任务都列全了');
ok(bridgeSrc.includes("const NIGHT_WAKE_TASK = '\\\\qq-bridge-night-wake';"), '醒来兜底任务名是 \\qq-bridge-night-wake');
ok(/function setSleepQuietTasks\(disabled, why\)/.test(bridgeSrc), '有 setSleepQuietTasks(disabled, why)');
ok(bridgeSrc.includes("'/change', '/tn', name, disabled ? '/disable' : '/enable'"), '停用/启用走 schtasks /change');
ok(/execFileSync\(file, args,/.test(bridgeSrc) && bridgeSrc.includes("runCmd('schtasks'"), 'schtasks 用 execFileSync 走 runCmd（vm 夹具里只有这个桩，没有 spawn）');

const start = bodyOf(bridgeSrc, 'function startNightSleep(');
ok(start.includes("setSleepQuietTasks(true, '进入晚安休眠')"), '进入休眠时停用看门狗等任务');
ok(start.includes('scheduleNightWakeTask(nightSleep.wakeAt)'), '进入休眠时建醒来兜底任务');

const finish = bodyOf(bridgeSrc, 'function finishNightSleep(');
ok(finish.includes("setSleepQuietTasks(false, '睡醒了')"), '醒来时重新启用任务');
ok(finish.includes('clearNightWakeTask()'), '醒来时删掉兜底任务');

const cancel = bodyOf(bridgeSrc, 'function cancelNightSleep(');
ok(cancel.includes("setSleepQuietTasks(false, '取消晚安休眠')"), '取消休眠也把任务放回来');
ok(cancel.includes('clearNightWakeTask()'), '取消休眠也删掉兜底任务');

const load = bodyOf(bridgeSrc, 'function loadNightSleepState(');
ok(load.includes("setSleepQuietTasks(true, '恢复晚安休眠')"), '桥接重启时若还在睡，重新停用任务');
ok(load.includes('scheduleNightWakeTask(wakeAt)'), '桥接重启时若还在睡，兜底任务也补上');

ok(/Register-ScheduledTask -TaskName/.test(bridgeSrc), '兜底任务用 Register-ScheduledTask 建（schtasks /sc once + /sd 会吐坏 XML）');
ok(bridgeSrc.includes('New-ScheduledTaskTrigger -Once'), '兜底任务是一次性触发');
ok(bridgeSrc.includes('New-ScheduledTaskAction'), '兜底任务的动作是 powershell 跑 night-wake.ps1');
ok(/runSchtasks\(\[[^\]]*'\/delete', '\/tn', NIGHT_WAKE_TASK/.test(bridgeSrc), '有删除兜底任务（/delete）');

// ── 睡着期间不许被叫起来说话（2026-10-31 的事故）─────────────────────────────
// 事故：23:00 入睡到 06:00，她却 02:06/02:36/03:06 被「自己刷一会儿」唤醒、03:15 起被主动机会
// 唤醒，在 2~5 点给爸爸、妈妈、哥哥都发了消息。两条定时器只查情绪门控，而门控的「困」依赖精力值 ——
// 睡到一半精力回上来就放行了。修法：模块级 nightFlag + 唤醒/发送两处硬开关。
ok(bridgeSrc.includes('const nightFlag = { sleeping: false };'), '有模块级 nightFlag（早于发送链路就位，避开 TDZ）');
ok(bodyOf(bridgeSrc, 'function persistNightSleep(').includes('nightFlag.sleeping = Boolean(nightSleep.active)'),
  'persistNightSleep 同步 nightFlag（start/cancel/finish 都走它）');
ok(bodyOf(bridgeSrc, 'function loadNightSleepState(').includes('nightFlag.sleeping = true'),
  '桥接重启后接着睡时 nightFlag 也得亮起来');
const wakePrompt = bodyOf(bridgeSrc, 'async function sendWakePromptV2(');
ok(wakePrompt.includes("nightFlag.sleeping && reason !== 'nightWake'"), '唤醒统一入口：睡着就不投递（醒来那一刻除外）');
ok(wakePrompt.includes('休眠中不唤醒'), '被拦下时留一条日志，好复盘');
ok(bodyOf(bridgeSrc, 'function sendMessagesV2(').includes('if (nightFlag.sleeping)'), '发送链路：睡着一条都不出门');
ok(bodyOf(bridgeSrc, 'function startBrowseBehavior(').includes('if (nightFlag.sleeping || nightSleep.active) return;'),
  '「自己刷一会儿」睡着时不挑人');

// ── scripts/night-wake.ps1 ──────────────────────────────────────────────────
const wakeBytes = fs.existsSync(wakeScriptPath) ? fs.readFileSync(wakeScriptPath) : Buffer.alloc(0);
ok(wakeBytes.length > 0, 'scripts/night-wake.ps1 存在');
ok(wakeBytes[0] === 0xef && wakeBytes[1] === 0xbb && wakeBytes[2] === 0xbf,
  'night-wake.ps1 带 UTF-8 BOM（不带的话 PowerShell 5.1 按 GBK 读中文会 ParseError）');
const wakeSrc = wakeBytes.toString('utf8');
ok(wakeSrc.includes('schtasks /change /tn $name /enable'), '兜底脚本会重新启用任务');
ok(wakeSrc.includes(':3100'), '兜底脚本会看桥接（3100）在不在');
ok(wakeSrc.includes("schtasks /run /tn '\\qq-bridge-watchdog'"), '醒来无条件让看门狗回来值班（脚本自带互斥锁，不会并存）');
ok(wakeSrc.includes("schtasks /delete /tn '\\qq-bridge-night-wake' /f"), '兜底脚本跑完自己删掉任务（等价 /z）');

// ── 看门狗自己也要认「她在睡觉」─────────────────────────────────────────────
ok(keepaliveSrc.includes("'state\\night-sleep.json'"), '看门狗读得到睡眠状态文件（state\\night-sleep.json）');
ok(/\$nowMs = \[DateTimeOffset\]::UtcNow\.ToUnixTimeMilliseconds\(\)/.test(keepaliveSrc), '用 Unix 时间戳比较（别拿 DateTime 相减）');
ok(keepaliveSrc.includes('$night.active -and $wakeAt -gt $nowMs'), '只在 wakeAt 之前才歇着');
ok(keepaliveSrc.includes('Start-Sleep -Seconds 300') && keepaliveSrc.includes('continue'), '睡着时 5 分钟一轮空转，不往下查服务');

const bad = results.filter((r) => !r.cond);
console.log(`\n${results.length - bad.length}/${results.length} 通过${bad.length ? `，失败 ${bad.length}` : ''}`);
process.exit(bad.length ? 1 : 0);