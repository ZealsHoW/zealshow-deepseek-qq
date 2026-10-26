/**
 * GPT-SoVITS 生命周期回归：要用才拉起、闲够久就关掉。
 *
 * 背景（2026-10-26）：那个服务一加载模型就提交 8.3 GB 内存（PID 13556：WorkingSet 531 MB /
 * Private 8283 MB），这台机一共 16 GB。它以前常驻，于是闲着也用掉一半内存 —— 游戏开不了，
 * ACE-Step 也永远够不到它要的 7~10 GB。现在：发语音前 `ensureRunning()`，用完 `noteUsage()`，
 * 每分钟 `maybeStopIfIdle()` 把闲置的服务停掉（靠 `state/tts-hold.json` 让看门狗别抢着拉起）。
 *
 * 这里全部用注入的时钟/探活/spawn/kill，不碰真服务。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTtsLifecycle, DEFAULT_IDLE_STOP_MINUTES } from '../src/qqb/tts-lifecycle.mjs';
import { gptsovitsSettings } from '../src/qqb/tts-gptsovits.mjs';

const results = [];
function ok(cond, name) {
  results.push({ cond: Boolean(cond), name });
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}`);
}

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-life-'));
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'gptsovits-serve.ps1'), '# stub');
  return root;
}

function makeLife(overrides = {}) {
  const root = overrides.root ?? tmpRoot();
  // 时钟要**真的会走**：ensureRunning 用 `now() < deadline` 等探活，时钟冻住就死循环。
  // 于是 = 起点 + 真实流逝 + 测试手动加的偏移（tick 只加偏移，保证 idleFor 依旧可控）。
  const startedAt = overrides.startAt ?? 1_700_000_000_000;
  const realStart = Date.now();
  let offset = 0;
  const clock = () => startedAt + (Date.now() - realStart) + offset;
  const calls = { spawned: 0, killed: [] };
  const life = createTtsLifecycle({
    root,
    stateDir: path.join(root, 'state'),
    bridgeDir: root,
    baseUrl: 'http://127.0.0.1:9880',
    port: 9880,
    idleMinutes: 10,
    startWaitMs: 200,
    pollMs: 5,
    now: clock,
    logger: { info() {}, warn() {} },
    health: overrides.health ?? (async () => false),
    spawnService: () => { calls.spawned += 1; },
    killPid: (pid) => { calls.killed.push(pid); },
    listPids: overrides.listPids ?? (() => [4242]),
    ...overrides.life
  });
  return { root, life, calls, tick: (ms) => { offset += ms; }, now: clock };
}

console.log('## 配置：闲时关服务有默认值，也能关掉');
{
  const s = gptsovitsSettings({});
  ok(s.idleStopMinutes === DEFAULT_IDLE_STOP_MINUTES, `默认 ${DEFAULT_IDLE_STOP_MINUTES} 分钟`);
  ok(gptsovitsSettings({ idleStopMinutes: 0 }).idleStopMinutes === 0, '显式 0 = 不自动关');
  ok(gptsovitsSettings({ idleStopMinutes: 30 }).idleStopMinutes === 30, '自定义分钟数读得进来');
}

console.log('## 记「用过」：闲多久是算出来的，不是猜的');
{
  const { life, root, tick } = makeLife();
  ok(life.lastUsedAt() === 0, '从没记过 → 0');
  ok(life.idleFor() === Number.POSITIVE_INFINITY, '从没记过当作很久没用（可以关）');
  life.noteUsage();
  ok(life.lastUsedAt() > 0, 'noteUsage 落了时间戳');
  ok(fs.existsSync(path.join(root, 'state', 'tts-last-used.json')), '落盘在 state/tts-last-used.json');
  tick(90 * 1000);
  ok(life.idleFor() >= 90 * 1000 && life.idleFor() < 95 * 1000, 'idleFor = now - lastUsedAt（含真实流逝的几毫秒）');
}

console.log('## hold 文件：关掉服务期间别让看门狗拉回来');
{
  const { life, root, tick, now } = makeLife();
  ok(!life.holding(), '没有 hold 时 holding() 为假');
  life.writeHold(60_000, 'test');
  ok(life.holding(), '写完 hold 就生效');
  const file = path.join(root, 'state', 'tts-hold.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(data.by === 'test' && data.until > now(), 'hold 里记了 until 和 by');
  tick(61_000);
  ok(!life.holding(), '过期后自动失效（不靠谁去删）');
  life.writeHold(60_000, 'test');
  life.clearHold();
  ok(!fs.existsSync(file) && !life.holding(), 'clearHold 直接删文件');
}

console.log('## ensureRunning：在跑就直接用，不起新进程');
{
  const { life, calls } = makeLife({ health: async () => true });
  const r = await life.ensureRunning();
  ok(r.ok === true && r.started === false, '已就绪 → {ok:true, started:false}');
  ok(calls.spawned === 0, '没有重复拉起');
  ok(life.lastUsedAt() > 0, '用上了也要记一笔（这次就是「用过」）');
}

console.log('## ensureRunning：没在跑就拉，拉起来就撤 hold');
{
  let healthy = false;
  let polls = 0;
  const { life, root, calls } = makeLife({
    health: async () => { polls += 1; if (polls > 2) healthy = true; return healthy; }
  });
  const r = await life.ensureRunning();
  ok(r.ok === true && r.started === true, '拉起成功');
  ok(calls.spawned === 1, '只 spawn 一次（不是轮询里反复拉）');
  const holdFile = path.join(root, 'state', 'tts-hold.json');
  ok(!fs.existsSync(holdFile), '起来之后 hold 已撤（看门狗恢复正常）');
  ok(life.lastUsedAt() > 0, '拉起成功也算用过');
}

console.log('## ensureRunning：拉不起来也不拖死调用方');
{
  const { life, calls, root } = makeLife({ health: async () => false });
  const t0 = Date.now();
  const r = await life.ensureRunning({ waitMs: 60 });
  ok(r.ok === false && Boolean(r.error), '超时返回 {ok:false, error}');
  ok(calls.spawned === 1, '只试了一次');
  ok(Date.now() - t0 < 9000, '等的是 waitMs（有 5 秒下限兜底），不会真的等两分钟');
  ok(!fs.existsSync(path.join(root, 'state', 'tts-hold.json')), '失败也要撤 hold，别把看门狗永久挡住');
}

console.log('## ensureRunning：找不到启动脚本就直说');
{
  const root = tmpRoot();
  fs.rmSync(path.join(root, 'scripts', 'gptsovits-serve.ps1'));
  const { life } = makeLife({ root, health: async () => false });
  const r = await life.ensureRunning({ waitMs: 30 });
  ok(r.ok === false && /找不到启动脚本/.test(r.error), '报「找不到启动脚本」而不是干等');
}

console.log('## stop：占住 hold、按 pid 停、清 pid 文件');
{
  const { life, root, calls } = makeLife({ health: async () => true, listPids: () => [4242, 5353] });
  fs.writeFileSync(path.join(root, 'state', 'gptsovits-serve.pid'), '4242');
  const r = await life.stop({ reason: 'idle' });
  ok(r.stopped === true, '停了');
  ok(calls.killed.length === 2 && calls.killed.includes(4242), '两个 pid 都停（端口 + pid 文件）');
  ok(life.holding(), 'stop 之后 hold 生效（看门狗不会 60 秒后又拉起来）');
  const hold = JSON.parse(fs.readFileSync(path.join(root, 'state', 'tts-hold.json'), 'utf8'));
  ok(hold.by === 'idle', 'hold 里写明是谁关的');
  ok(!fs.existsSync(path.join(root, 'state', 'gptsovits-serve.pid')), 'pid 文件顺手清掉（防 PID 复用误杀）');
}

console.log('## stop：本来就没在跑 → 什么都不做');
{
  const { life, calls } = makeLife({ health: async () => false });
  const r = await life.stop();
  ok(r.stopped === false && r.skipped === 'already-stopped', '返回 already-stopped');
  ok(calls.killed.length === 0, '没有乱杀进程');
  ok(!life.holding(), '也不写 hold（没必要）');
}

console.log('## maybeStopIfIdle：闲够才关，忙着不关');
{
  const { life, tick, calls } = makeLife({ health: async () => true });
  life.noteUsage();
  tick(9 * 60 * 1000);
  let r = await life.maybeStopIfIdle();
  ok(r.stopped === false && r.skipped === 'recent', '9 分钟 → 还不到，不关');
  tick(2 * 60 * 1000);
  r = await life.maybeStopIfIdle({ blocked: () => true });
  ok(r.stopped === false && r.skipped === 'busy', '闲够但正在唱歌/发语音 → 不关');
  r = await life.maybeStopIfIdle();
  ok(r.stopped === true, '11 分钟且没人用 → 关掉');
  ok(calls.killed.length > 0, '真去停了进程');
}

console.log('## maybeStopIfIdle：idleStopMinutes=0 就是「别自动关」');
{
  const { life, tick } = makeLife({ health: async () => true, life: { idleMinutes: 0 } });
  life.noteUsage();
  tick(24 * 60 * 60 * 1000);
  const r = await life.maybeStopIfIdle();
  ok(r.stopped === false && r.skipped === 'disabled', '配置 0 → 永远不自动关');
}

console.log('## stats：排障要看得见「为什么没关」');
{
  const { life, tick } = makeLife({ health: async () => true });
  ok(life.stats().idleStopMinutes === 10, 'stats 带阈值');
  ok(life.stats().lastUsedAt === null, '没记过就 null');
  life.noteUsage();
  tick(120_000);
  const s = life.stats();
  ok(s.lastUsedAt > 0 && s.idleMs >= 120_000, 'stats 带最近一次使用与闲置时长');
  ok(s.holding === false && s.holdUntil === null, 'stats 带 hold 状态');
  ok(s.script === true, 'stats 说明启动脚本在不在');
}

console.log('## 默认拉起：不能用 detached（Windows 上 pwsh 会立刻退出，脚本一行都不跑）');
{
  const src = fs.readFileSync(new URL('../src/qqb/tts-lifecycle.mjs', import.meta.url), 'utf8');
  ok(/detached:\s*false/.test(src), 'detached 必须是 false（2026-10-26 实测：true 时 pwsh exit 0、日志都没写）');
  ok(/child\.on\('error'/.test(src), "拉起失败要监听 'error'，否则未捕获事件会把桥接带崩");
}

const failed = results.filter((r) => !r.cond).length;
console.log(`\n结果：${results.length - failed} 通过 ${failed} 失败`);
if (failed > 0) process.exitCode = 1;