/**
 * GPT-SoVITS 服务的「用时拉起、闲时关掉」调度（2026-10-26）。
 *
 * 为什么要有这一层：
 *   那个服务一旦加载模型就**提交 8.3 GB** 内存（实测 PID 13556：WorkingSet 531 MB，
 *   Private/提交 8283 MB），而这台机一共 16 GB。以前它是常驻的，于是「不唱歌、不发语音」
 *   的时候那 8.3 GB 也一直压在头上：空闲内存只剩 1~2 GB，游戏开不了，ACE-Step 也永远
 *   够不到它要的 7~10 GB。
 *
 * 于是：
 *   - 合成一条语音之前调 `ensureRunning()`：已就绪就直接用，没起就现拉（冷启动一次约 26 秒，
 *     由 `state/tts-last-used.json` 之外的调用方等）；
 *   - 每次真用完之后 `noteUsage()` 记一笔时间；
 *   - 每分钟 `maybeStopIfIdle()`：超过 `idleStopMinutes` 没被用过就把服务停掉，把那 8.3 GB 还回去。
 *
 * 「关掉以后别让看门狗又拉起来」用的是现成机制：`state/tts-hold.json`（`until` 是毫秒时间戳）。
 * `qq-bridge-keepalive.ps1` 看到未过期的 hold 就不会抢着启动 TTS —— 唱歌期间腾内存用的也是它。
 * 反过来，`ensureRunning()` 自己要拉服务时先写一段短 hold（防止看门狗和我们同时拉），
 * 起来之后再清掉。
 *
 * 依赖全部可注入（spawn / kill / 探活 / 时钟），所以能脱离真服务做回归。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

export const DEFAULT_IDLE_STOP_MINUTES = 10;
export const DEFAULT_BASE_URL = 'http://127.0.0.1:9880';
/** 拉起服务时最多等多久：冷启动实测 26 秒，但这台机在内存吃紧时会拉到 105 秒（2026-10-26 实测），
 *  所以留到 3 分钟 —— 等不到就回落 SAPI，不会拖死说话。 */
export const DEFAULT_START_WAIT_MS = 180000;
const PID_FILE_MAX_AGE_MS = 10 * 60 * 1000;

const num = (v, d) => (v === null || v === undefined || v === '' ? d : (Number.isFinite(Number(v)) ? Number(v) : d));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

function rmQuiet(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* 删不掉就等它过期 */ }
}

/** 探活：`/control` 不带 command 会回 400 —— 有回包（<500）就说明服务活着。 */
export async function ttsHealth({ baseUrl = DEFAULT_BASE_URL, timeoutMs = 3000 } = {}) {
  try {
    const res = await fetch(`${String(baseUrl).replace(/\/+$/, '')}/control`, {
      method: 'GET',
      signal: AbortSignal.timeout(Math.max(500, Number(timeoutMs) || 3000))
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** 谁在监听这个端口（Windows：解析 netstat）。查不到就空数组。 */
export function listenerPids(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const pids = new Set();
    for (const line of String(out).split(/\r?\n/)) {
      if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const pid = Number(cols[cols.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

export function createTtsLifecycle({
  root = process.cwd(),
  stateDir = path.join(root, 'state'),
  bridgeDir = root,
  baseUrl = DEFAULT_BASE_URL,
  port = 9880,
  idleMinutes = DEFAULT_IDLE_STOP_MINUTES,
  startWaitMs = DEFAULT_START_WAIT_MS,
  pollMs = 2000,
  now = () => Date.now(),
  logger = { info() {}, warn() {} },
  health = ttsHealth,
  spawnService = null,
  killPid = null,
  listPids = null
} = {}) {
  const usedFile = path.join(stateDir, 'tts-last-used.json');
  const holdFile = path.join(stateDir, 'tts-hold.json');
  const pidFile = path.join(stateDir, 'gptsovits-serve.pid');
  const serveScript = path.join(bridgeDir, 'scripts', 'gptsovits-serve.ps1');
  const serveLog = path.join(root, '_gptsovits', 'serve.log');

  const stopMinutes = Math.max(0, num(idleMinutes, DEFAULT_IDLE_STOP_MINUTES));

  function holdEndsAt() {
    const data = readJson(holdFile);
    const until = Number(data?.until);
    return Number.isFinite(until) ? until : 0;
  }

  function holding() {
    return holdEndsAt() > now();
  }

  function writeHold(ms, by) {
    writeJson(holdFile, { until: now() + Math.max(0, ms), by: String(by ?? 'tts') });
    return holdEndsAt();
  }

  function clearHold() {
    rmQuiet(holdFile);
  }

  function lastUsedAt() {
    const data = readJson(usedFile);
    const at = Number(data?.at);
    return Number.isFinite(at) && at > 0 ? at : 0;
  }

  function noteUsage(at = now()) {
    writeJson(usedFile, { at });
    return at;
  }

  const defaultSpawnService = () => {
    const pwsh = process.env.ComSpec ? 'pwsh.exe' : 'pwsh';
    const child = spawn(pwsh, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', serveScript,
      '-Port', String(port),
      '-Log', serveLog
    ], {
      // 2026-10-26 实测：Windows 上 `detached: true` 的 pwsh 会**立刻退出（exit 0）**，脚本一行都没跑，
      // 于是这边干等 120 秒还以为服务在加载。换成 detached:false + stdio:'ignore' + unref()：
      // Windows 不会因为父进程退出而杀掉子进程，服务照样活得下来，而且真的会起来。
      detached: false,
      stdio: 'ignore',
      windowsHide: true
    });
    // 没有 'error' 监听时，spawn 失败会以未捕获事件的形式把桥接整个带崩 —— 这里只记一条警告。
    child.on('error', (error) => logger.warn(`拉起音色服务失败：${error?.message ?? error}`));
    child.unref();
  };

  const defaultKill = (pid) => process.kill(pid);
  const defaultListPids = () => {
    const pids = new Set(listenerPids(port));
    // 服务还在「加载模型、没监听端口」的阶段时按端口找不到它 —— 启动器会把真正吃内存的
    // PID 写进 state/gptsovits-serve.pid，这里补上（只认 10 分钟内的，PID 会被复用）。
    try {
      const ageMs = now() - fs.statSync(pidFile).mtimeMs;
      const pid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0 && ageMs < PID_FILE_MAX_AGE_MS) pids.add(pid);
    } catch { /* 没有 pid 文件就算了 */ }
    return [...pids];
  };

  const spawnIt = spawnService ?? defaultSpawnService;
  const killIt = killPid ?? defaultKill;
  const listIt = listPids ?? defaultListPids;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function alive() {
    return Boolean(await health({ baseUrl, timeoutMs: 3000 }));
  }

  /** 要用服务了：在跑就直接用；没在跑就现拉（最多等 startWaitMs）。 */
  async function ensureRunning({ waitMs = startWaitMs } = {}) {
    if (await alive()) {
      noteUsage();
      return { ok: true, started: false };
    }
    if (!fs.existsSync(serveScript)) {
      return { ok: false, started: false, error: `找不到启动脚本：${serveScript}` };
    }
    // 先占住 hold：看门狗一轮 60 秒，别在我们拉的时候它也拉一个，两个模型一起抢内存。
    writeHold(waitMs + 60000, 'tts-wake');
    try {
      spawnIt();
      logger.info('音色服务没在跑，正在拉起（冷启动约 26 秒）');
    } catch (error) {
      clearHold();
      return { ok: false, started: false, error: `拉起失败：${error?.message ?? error}` };
    }
    const deadline = now() + Math.max(5000, waitMs);
    while (now() < deadline) {
      await sleep(pollMs);
      if (await alive()) {
        clearHold();
        noteUsage();
        logger.info(`音色服务已就绪（等了约 ${Math.round((now() - (deadline - waitMs)) / 1000)} 秒）`);
        return { ok: true, started: true };
      }
    }
    clearHold();
    logger.warn(`音色服务拉起超时（等了 ${Math.round(waitMs / 1000)} 秒），先回落机器音`);
    return { ok: false, started: false, error: `拉起超时（${Math.round(waitMs / 1000)} 秒）` };
  }

  /** 停服务：先占 hold（别让看门狗拉回来），再按端口/pid 文件逐个停。 */
  async function stop({ reason = 'idle', holdMs = 12 * 60 * 60 * 1000, onlyIfIdle = false } = {}) {
    if (onlyIfIdle && idleFor() < stopMinutes * 60000) {
      return { stopped: false, skipped: 'recent', idleMs: idleFor() };
    }
    if (!(await alive())) {
      return { stopped: false, skipped: 'already-stopped', idleMs: idleFor() };
    }
    writeHold(holdMs, reason);
    const pids = listIt().filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    let killed = 0;
    for (const pid of pids) {
      try {
        killIt(pid);
        killed += 1;
      } catch { /* 已经退了 */ }
    }
    if (killed > 0) {
      await sleep(1500);
      logger.info(`音色服务已停（${pids.join(',')}，${reason}），内存还回去`);
    }
    rmQuiet(pidFile);
    return { stopped: killed > 0, pids, reason };
  }

  function idleFor() {
    const at = lastUsedAt();
    if (!at) return Number.POSITIVE_INFINITY; // 从来没记过 = 当作很久没用，可以关
    return Math.max(0, now() - at);
  }

  /**
   * 每分钟问一次：闲够久了吗？
   * `blocked()` 由调用方给（她在唱歌、正在发语音时就别停）。
   */
  async function maybeStopIfIdle({ blocked = () => false } = {}) {
    if (stopMinutes <= 0) return { stopped: false, skipped: 'disabled' };
    const idleMs = idleFor();
    if (idleMs < stopMinutes * 60000) return { stopped: false, skipped: 'recent', idleMs };
    if (blocked()) return { stopped: false, skipped: 'busy', idleMs };
    if (!(await alive())) return { stopped: false, skipped: 'already-stopped', idleMs };
    return { ...(await stop({ reason: 'idle' })), idleMs };
  }

  function stats() {
    const until = holdEndsAt();
    return {
      baseUrl,
      port,
      idleStopMinutes: stopMinutes,
      lastUsedAt: lastUsedAt() || null,
      idleMs: Number.isFinite(idleFor()) ? idleFor() : null,
      holding: until > now(),
      holdUntil: until || null,
      pidFile: fs.existsSync(pidFile),
      script: fs.existsSync(serveScript)
    };
  }

  return { ensureRunning, stop, maybeStopIfIdle, noteUsage, lastUsedAt, idleFor, holding, writeHold, clearHold, stats };
}