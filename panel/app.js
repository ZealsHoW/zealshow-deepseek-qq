// 潘多拉魔盒 · 面板核心：工具函数、REST、路由、抽屉、启动。
// 只调用同源 REST；所有插值都走 esc()。无构建工具、无第三方依赖。
import { mount as mountMemories } from './views/memories.js';
import { mount as mountDiaries } from './views/diaries.js';
import { mount as mountPersona } from './views/persona.js';
import { mount as mountGallery } from './views/gallery.js';
import { mount as mountPeople } from './views/people.js';

export const TAB_IDS = ['memories', 'diaries', 'persona', 'gallery', 'people'];
const TAB_TITLES = { memories: '记忆库', diaries: '日记本', persona: '人格状态', gallery: '收藏夹', people: '人物档案' };
const MOUNTS = { memories: mountMemories, diaries: mountDiaries, persona: mountPersona, gallery: mountGallery, people: mountPeople };
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** 唯一入口：所有来自服务端/用户输入的文本都要先过这里。 */
export function esc(value) {
  return value === null || value === undefined ? '' : String(value).replace(/[&<>"'`]/g, (ch) => ESCAPES[ch]);
}

/** ISO 字符串、epoch 毫秒/秒、Date → 毫秒；认不出返回 null。 */
export function toTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (/^\d{10}$/.test(text)) return Number(text) * 1000;
  if (/^\d{13}$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 自然日差：0=同一天，1=昨天，7=一周前。 */
export function dayGap(from, to) {
  return Math.round((startOfDay(from) - startOfDay(to)) / 86400000);
}

export function timeAgo(value, now = Date.now()) {
  const t = toTime(value);
  if (t === null) return '—';
  const diff = now - t;
  if (!Number.isFinite(diff)) return '—';
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  const gap = dayGap(now, t);
  if (gap === 1) return '昨天';
  if (gap > 1) return `${gap} 天前`;
  return `${Math.floor(diff / 3600000)} 小时前`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function fullTime(value) {
  const t = toTime(value);
  if (t === null) return '时间未知';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 0–1；兼容后端偶尔给的 0–100。 */
export function norm01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const v = n > 1 && n <= 100 ? n / 100 : n;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function fmt(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

/** 归档标记可能是布尔、0/1、时间戳或 ISO 字符串。 */
export function isArchived(item) {
  if (!item || typeof item !== 'object') return false;
  const v = item.archived ?? item.archivedAt ?? item.archived_at;
  if (v === true) return true;
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string') return v !== '' && v !== '0' && v !== 'false';
  return false;
}

/** '#Diaries?x' / 'persona' / '' → 合法 Tab id（默认记忆库）。 */
export function parseHash(hash) {
  const raw = String(hash === null || hash === undefined ? '' : hash)
    .replace(/^#/, '')
    .split(/[?/]/)[0]
    .trim()
    .toLowerCase();
  return TAB_IDS.includes(raw) ? raw : 'memories';
}

export function empty(text) {
  return `<p class="empty">${esc(text)}</p>`;
}

/** CSP 友好：用原生 progress 画条，不写内联 style。 */
export function bar(value, label = '', tone = '') {
  const v = norm01(value);
  const aria = label ? ` aria-label="${esc(label)}"` : '';
  return `<progress class="bar${tone ? ` ${tone}` : ''}" max="1" value="${v.toFixed(3)}"${aria}></progress>`;
}

/** 同一个容器反复 mount 时先摘掉旧监听，避免重复绑定。 */
export function listen(root, owner, handlers) {
  if (owner.handlers) {
    for (const [type, fn] of owner.handlers) root.removeEventListener(type, fn);
  }
  owner.handlers = Object.entries(handlers).filter(([, fn]) => typeof fn === 'function');
  for (const [type, fn] of owner.handlers) root.addEventListener(type, fn);
}

let authShown = false;

export function showAuth() {
  if (authShown) return;
  authShown = true;
  const el = document.getElementById('auth-banner');
  if (el) el.hidden = false;
}

/** 同源 REST 包装：401 顶部提示；网络/HTTP 错误统一成中文 Error。 */
export async function api(path, options = {}) {
  const init = { credentials: 'same-origin', cache: 'no-store', ...options };
  if (init.body !== null && init.body !== undefined && typeof init.body !== 'string') {
    init.headers = { 'content-type': 'application/json', ...(init.headers || {}) };
    init.body = JSON.stringify(init.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('连不上桥接进程');
  }
  if (res.status === 401) {
    showAuth();
    throw new Error('未授权（令牌无效）');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`);
  if (data && data.ok === false) throw new Error(data.error || '请求失败');
  return data || {};
}

let toastTimer = null;

export function toast(message, kind = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = String(message);
  el.className = `toast${kind ? ` ${kind}` : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

const raf = typeof globalThis.requestAnimationFrame === 'function'
  ? globalThis.requestAnimationFrame.bind(globalThis)
  : (fn) => setTimeout(fn, 0);

let drawerOpen = false;
let drawerTimer = null;
let lastFocus = null;

export function openDrawer(title, html) {
  const drawer = document.getElementById('drawer');
  const scrim = document.getElementById('scrim');
  const body = document.getElementById('drawer-body');
  const heading = document.getElementById('drawer-title');
  if (!drawer || !scrim || !body || !heading) return;
  lastFocus = document.activeElement;
  heading.textContent = String(title || '');
  body.innerHTML = String(html || '');
  body.scrollTop = 0;
  clearTimeout(drawerTimer);
  drawer.hidden = false;
  scrim.hidden = false;
  document.body.classList.add('no-scroll');
  drawerOpen = true;
  raf(() => {
    drawer.classList.add('open');
    scrim.classList.add('open');
  });
  const btn = document.getElementById('drawer-close');
  if (btn && typeof btn.focus === 'function') btn.focus({ preventScroll: true });
}

export function drawerBody() {
  return document.getElementById('drawer-body');
}

export function closeDrawer() {
  const drawer = document.getElementById('drawer');
  const scrim = document.getElementById('scrim');
  if (!drawer || drawer.hidden) return;
  drawer.classList.remove('open');
  if (scrim) scrim.classList.remove('open');
  document.body.classList.remove('no-scroll');
  drawerOpen = false;
  clearTimeout(drawerTimer);
  drawerTimer = setTimeout(() => {
    if (drawerOpen) return;
    drawer.hidden = true;
    if (scrim) scrim.hidden = true;
    const body = document.getElementById('drawer-body');
    if (body) body.innerHTML = '';
  }, 200);
  if (lastFocus && typeof lastFocus.focus === 'function') {
    try {
      lastFocus.focus({ preventScroll: true });
    } catch {
      /* 元素已卸载 */
    }
  }
  lastFocus = null;
}

/** 给各视图的运行时上下文；视图不反向 import app.js，避免循环依赖。 */
export const ctx = {
  esc, toTime, dayGap, timeAgo, fullTime, norm01, num, fmt, isArchived, parseHash,
  bar, empty, listen, api, toast, openDrawer, drawerBody, closeDrawer,
};

let currentTab = null;

function markTabs(id) {
  document.querySelectorAll('.tab[data-tab]').forEach((btn) => {
    const on = btn.dataset.tab === id;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function errorView(err) {
  return `<div class="card pad"><h2>加载失败</h2><p class="warn">${esc(err && err.message ? err.message : err)}</p><p class="muted">检查桥接是否在运行，然后刷新重试。</p></div>`;
}

function renderTab() {
  const id = parseHash(window.location.hash);
  document.title = `${TAB_TITLES[id]} · 潘多拉魔盒`;
  markTabs(id);
  if (id === currentTab) return;
  currentTab = id;
  closeDrawer();
  const root = document.getElementById('view');
  if (!root) return;
  root.dataset.tab = id;
  root.innerHTML = '';
  window.scrollTo(0, 0);
  try {
    MOUNTS[id](root, ctx);
  } catch (err) {
    root.innerHTML = errorView(err);
  }
}

function boot() {
  const tabs = document.getElementById('tabs');
  if (tabs) {
    tabs.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-tab]');
      if (!btn) return;
      const id = parseHash(btn.dataset.tab);
      if (window.location.hash === `#${id}`) renderTab();
      else window.location.hash = id;
    });
  }
  const close = document.getElementById('drawer-close');
  if (close) close.addEventListener('click', closeDrawer);
  const scrim = document.getElementById('scrim');
  if (scrim) scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeDrawer();
  });
  window.addEventListener('hashchange', renderTab);
  renderTab();
}

if (typeof document !== 'undefined' && document.getElementById('view')) boot();