/**
 * 「抖音登录态可能过期」的监视器。
 *
 * 背景：桥接是用主人自己的账号登录抖音的（持久化 profile `state/browser-profile`），
 * 登录态会因为异地登录、改密码、长期不用而失效。失效的表现很小声——`qq_read_page`
 * 只是「读到的内容很少」「没读到正文」，她看不出这是掉登录，主人也不知道，
 * 于是这条能力就静默失效了（和 2026-10 那批「她发不了图」是同一类盲区）。
 *
 * 分工：
 * - MCP 进程（真正去读网页的那一侧）：每次读完调 `recordReadOutcome()`，把「这次是不是撞到
 *   登录墙」记进 `state/read-login-watch.json`；
 * - 桥接进程（唯一会对外发消息的那一侧）：定时 `checkReadLoginWatch()`——连续 N 次撞墙、
 *   且距上次提醒超过去重时长 → 私聊主人，并写一条活动流水（控制台可见）。
 *
 * 这个文件只放纯函数 + 一个 best-effort 的文件读写；发消息留在 bridge.js，
 * 这样状态机可以完全离线测试（不需要 Chrome、不需要网关）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

export const LOGIN_WATCH_FILE = path.join(ROOT, 'state', 'read-login-watch.json');
export const DEFAULT_THRESHOLD = 2;
export const DEFAULT_DEDUPE_MS = 12 * 3600 * 1000;

export function emptyWatchState() {
  return {
    consecutive: 0,     // 连续撞到登录墙的次数（读到正常内容就清零）
    lastWallAt: 0,
    lastWallUrl: '',
    lastOkAt: 0,
    notifiedAt: 0,      // 上次提醒主人的时间（去重用）
    notifiedCount: 0,
    updatedAt: 0
  };
}

/**
 * 一次读取结果 → 新状态（纯函数）。
 * @param {object} prev 旧状态（可为 null）
 * @param {{loginWall?: boolean, url?: string, now?: number}} outcome
 */
export function nextWatchState(prev, outcome = {}) {
  const now = Number(outcome.now) || Date.now();
  const base = { ...emptyWatchState(), ...(prev && typeof prev === 'object' ? prev : {}) };
  const next = { ...base, updatedAt: now };
  if (outcome.loginWall) {
    next.consecutive = (Number(base.consecutive) || 0) + 1;
    next.lastWallAt = now;
    const url = String(outcome.url ?? '').trim();
    if (url) next.lastWallUrl = url;
  } else if (outcome.ok !== false) {
    // 读到正常内容：连着撞墙的计数清零。没读到内容（超时/报错）不算「好」也不算「墙」，保持不变。
    next.consecutive = 0;
    next.lastOkAt = now;
  }
  return next;
}

/**
 * 该不该提醒主人（纯函数）。
 * @returns {{notify: boolean, reason: string}}
 */
export function shouldNotifyWatch(state, now = Date.now(), options = {}) {
  const threshold = Math.max(1, Number(options.threshold) || DEFAULT_THRESHOLD);
  const dedupeMs = Math.max(60_000, Number(options.dedupeMs) || DEFAULT_DEDUPE_MS);
  const consecutive = Number(state?.consecutive) || 0;
  if (consecutive < threshold) {
    return { notify: false, reason: `只连续撞墙 ${consecutive} 次（阈值 ${threshold}）` };
  }
  const notifiedAt = Number(state?.notifiedAt) || 0;
  if (notifiedAt && now - notifiedAt < dedupeMs) {
    const mins = Math.round((now - notifiedAt) / 60000);
    return { notify: false, reason: `上次提醒才过 ${mins} 分钟（去重 ${Math.round(dedupeMs / 3600000)} 小时）` };
  }
  return { notify: true, reason: `连续 ${consecutive} 次撞到登录墙` };
}

/** 给主人的提醒正文（纯函数，测试直接断言）。 */
export function buildWatchNotice(state, now = Date.now(), options = {}) {
  const dedupeHours = Math.round(Math.max(60_000, Number(options.dedupeMs) || DEFAULT_DEDUPE_MS) / 3600000);
  const consecutive = Number(state?.consecutive) || 0;
  const when = Number(state?.lastWallAt) ? new Date(Number(state.lastWallAt)) : new Date(now);
  const stamp = `${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ` +
    `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  const lines = [
    '【抖音登录态可能过期】',
    `我连着 ${consecutive} 次都没读到页面内容了（最近一次 ${stamp}${state?.lastWallUrl ? `：${state.lastWallUrl}` : ''}），`,
    '抖音那边大概是掉了登录，我自己登不回去。',
    '',
    '有空的时候帮我重新扫码登一下就好：',
    '1) 先把桥接停掉（看门狗会自己把它拉起来；想彻底停就关掉 keepalive 那个窗口）',
    '2) 在 qq-bridge 目录里跑：node -e "import(\'./src/webshot.js\').then(m => m.launchLoginBrowser(\'https://www.douyin.com\'))"',
    '3) 在弹出的窗口里扫码，登好之后把窗口关掉就成',
    '',
    `登录好了我就能接着看抖音了。（这条提醒 ${dedupeHours} 小时内不会再重复）`
  ];
  return lines.join('\n');
}

/** 读状态（best-effort：读不到就当没有，绝不抛）。 */
export function readWatch(file = LOGIN_WATCH_FILE) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { ...emptyWatchState(), ...parsed };
  } catch {
    return null;
  }
}

function writeWatch(state, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 记一次读取结果，返回新状态（写盘失败也不影响读取流程）。 */
export function recordReadOutcome(outcome = {}, file = LOGIN_WATCH_FILE) {
  const next = nextWatchState(readWatch(file), outcome);
  writeWatch(next, file);
  return next;
}

/** 标记「已经提醒过主人了」，用于去重。 */
export function markWatchNotified(now = Date.now(), file = LOGIN_WATCH_FILE) {
  const prev = readWatch(file) ?? emptyWatchState();
  const next = {
    ...prev,
    notifiedAt: now,
    notifiedCount: (Number(prev.notifiedCount) || 0) + 1,
    updatedAt: now
  };
  writeWatch(next, file);
  return next;
}