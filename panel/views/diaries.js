// 日记本：分级筛选（含做梦）、时间倒序、长文折叠。
const GRADES = [
  ['', '全部'],
  ['daily', '日常'],
  ['important', '重要'],
  ['unforgettable', '刻骨铭心'],
  ['dream', '做梦'],
];
const GRADE_NAME = { daily: '日常', important: '重要', unforgettable: '刻骨铭心', dream: '做梦' };
const FOLD_AT = 300;
let state = null;

function fresh() {
  return { grade: '', items: [], loaded: false, loading: false, error: '', expanded: new Set(), seq: 0, handlers: null };
}

export function mount(root, ctx) {
  if (!state) state = fresh();
  root.innerHTML = shell();
  bind(root, ctx);
  if (!state.loaded && !state.loading) load(ctx, root);
  paint(root, ctx);
}

function shell() {
  const chips = GRADES.map(([value, label]) => {
    const on = state.grade === value;
    return `<button type="button" class="chip${on ? ' on' : ''}" data-grade="${value}" aria-pressed="${on}">${label}</button>`;
  }).join('');
  return `<section class="pane">
    <div class="filters"><div class="chips" role="group" aria-label="日记分级">${chips}</div></div>
    <div class="list-meta" id="diary-meta"></div>
    <div id="diary-list"></div>
  </section>`;
}

function bind(root, ctx) {
  ctx.listen(root, state, {
    click(ev) {
      const chip = ev.target.closest('[data-grade]');
      if (chip) {
        const next = chip.dataset.grade || '';
        if (state.grade === next) return;
        state.grade = next;
        root.querySelectorAll('[data-grade]').forEach((btn) => {
          const on = (btn.dataset.grade || '') === next;
          btn.classList.toggle('on', on);
          btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        load(ctx, root);
        return;
      }
      const fold = ev.target.closest('[data-fold]');
      if (fold) {
        const key = fold.dataset.fold;
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        paint(root, ctx);
        return;
      }
      if (ev.target.closest('[data-retry]')) load(ctx, root);
    },
  });
}

async function load(ctx, root) {
  const seq = ++state.seq;
  state.loading = true;
  state.error = '';
  paint(root, ctx);
  const qs = new URLSearchParams({ limit: '50' });
  if (state.grade) qs.set('grade', state.grade);
  try {
    const data = await ctx.api(`/api/pandora/diaries?${qs.toString()}`);
    if (seq !== state.seq) return;
    state.items = Array.isArray(data.items) ? data.items : [];
    state.loaded = true;
  } catch (err) {
    if (seq !== state.seq) return;
    state.error = err.message || String(err);
  } finally {
    if (seq !== state.seq) return;
    state.loading = false;
    paint(root, ctx);
  }
}

function dayLabel(value, ctx) {
  const t = ctx.toTime(value);
  if (t === null) return String(value || '日期未知');
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function gradeOf(it) {
  if (it.kind === 'dream') return 'dream';
  return Object.prototype.hasOwnProperty.call(GRADE_NAME, it.grade) ? it.grade : 'daily';
}

function paint(root, ctx) {
  if (root.dataset.tab !== 'diaries') return;
  const meta = root.querySelector('#diary-meta');
  const list = root.querySelector('#diary-list');
  if (!meta || !list) return;
  meta.innerHTML = `<span>共 ${state.items.length} 篇</span>${state.loading ? '<span class="dot">·</span><span>读取中…</span>' : ''}`;
  if (state.error) {
    list.innerHTML = `<div class="card pad"><p class="warn">${ctx.esc(state.error)}</p><button type="button" class="btn" data-retry>重试</button></div>`;
    return;
  }
  if (state.loading && !state.items.length) {
    list.innerHTML = Array.from({ length: 3 }, () => '<div class="card sk-card"><div class="sk-line w40"></div><div class="sk-line"></div><div class="sk-line w90"></div></div>').join('');
    return;
  }
  if (!state.items.length) {
    list.innerHTML = ctx.empty(state.grade === 'dream' ? '她还没做过能记住的梦' : '她还没有写过日记');
    return;
  }
  const sorted = state.items.slice().sort((a, b) => (ctx.toTime(b.date) ?? 0) - (ctx.toTime(a.date) ?? 0));
  list.innerHTML = sorted.map((it, i) => card(it, i, ctx)).join('');
}

/** 服务端的 title 就是正文第一行，展示时去掉重复的那一行。 */
function bodyOf(it) {
  const title = String(it.title || '');
  const text = String(it.text || '');
  if (!title) return text;
  const lines = text.split('\n');
  const head = lines[0].replace(/^\[\d{1,2}:\d{2}\]\s*/, '');
  return head.startsWith(title) ? lines.slice(1).join('\n').trim() : text;
}

function card(it, i, ctx) {
  const grade = gradeOf(it);
  const text = bodyOf(it);
  const long = text.length > FOLD_AT;
  const key = `${dayLabel(it.date, ctx)}#${i}`;
  const open = state.expanded.has(key);
  const shown = long && !open ? `${text.slice(0, FOLD_AT)}…` : text;
  const date = dayLabel(it.date, ctx);
  return `<article class="card diary">
    <header class="diary-head">
      <h2 class="diary-title">${ctx.esc(it.title || '无题')}</h2>
      <span class="tag grade g-${grade}">${GRADE_NAME[grade]}${it.kind === 'dream' ? ' · 梦' : ''}</span>
    </header>
    <div class="diary-date">
      <time datetime="${ctx.esc(it.date || '')}" title="${ctx.esc(ctx.fullTime(it.date))}">${ctx.esc(date)}</time>
      <span class="muted">${ctx.esc(ctx.timeAgo(it.date))}</span>
      ${it.mood ? `<span class="emo">心情 ${ctx.esc(it.mood)}</span>` : ''}
    </div>
    <p class="${text ? 'diary-text' : 'muted'}">${text ? ctx.esc(shown) : '（这篇日记只有标题）'}</p>
    ${long ? `<button type="button" class="btn link" data-fold="${ctx.esc(key)}">${open ? '收起' : '展开全文'}</button>` : ''}
  </article>`;
}