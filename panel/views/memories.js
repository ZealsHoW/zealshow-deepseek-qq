// 记忆库：等级 / 关键词 / scope / 归档筛选；权重拖动 → PATCH importance；归档与复职。
const LEVELS = ['L3', 'L4', 'L5', 'L6'];
const GROUPS = ['今天', '昨天', '本周', '更早'];
let state = null;
let searchTimer = null;

function fresh() {
  return {
    levels: new Set(['L3', 'L4']), q: '', scope: '', archived: false,
    items: [], stats: null, scopes: [], loaded: false, loading: false, error: '', seq: 0, handlers: null,
  };
}

export function mount(root, ctx) {
  if (!state) state = fresh();
  root.innerHTML = shell(ctx);
  bind(root, ctx);
  if (!state.loaded && !state.loading) {
    load(ctx, root);
    loadScopes(ctx, root);
  }
  paint(root, ctx);
}

function shell(ctx) {
  const chips = LEVELS.map((lv) => {
    const on = state.levels.has(lv);
    return `<button type="button" class="chip${on ? ' on' : ''}" data-level="${lv}" aria-pressed="${on}">${lv}</button>`;
  }).join('');
  return `<section class="pane">
    <div class="filters">
      <div class="chips" role="group" aria-label="记忆等级">${chips}</div>
      <input id="mem-q" class="input" type="search" placeholder="搜记忆正文…" value="${ctx.esc(state.q)}" autocomplete="off" aria-label="关键词">
      <select id="mem-scope" class="input select" aria-label="作用域">${scopeOptions(ctx)}</select>
      <label class="switch"><input id="mem-archived" type="checkbox"${state.archived ? ' checked' : ''}><span>显示归档</span></label>
    </div>
    <div class="list-meta" id="mem-meta"></div>
    <div id="mem-list" class="mem-list"></div>
  </section>`;
}

function scopeOptions(ctx) {
  const seen = new Set();
  const rows = [];
  const push = (scope, label) => {
    if (!scope || seen.has(scope)) return;
    seen.add(scope);
    rows.push([scope, label || scope]);
  };
  for (const p of state.scopes) push(p.scope, p.name ? `${p.name}（${p.scope}）` : p.scope);
  for (const it of state.items) push(it.scope, it.scope);
  return ['<option value="">全部 scope</option>']
    .concat(rows.map(([v, label]) => `<option value="${ctx.esc(v)}"${state.scope === v ? ' selected' : ''}>${ctx.esc(label)}</option>`))
    .join('');
}

function bind(root, ctx) {
  ctx.listen(root, state, {
    click(ev) {
      const chip = ev.target.closest('[data-level]');
      if (chip) { toggleLevel(chip.dataset.level, ctx, root); return; }
      const arch = ev.target.closest('[data-archive]');
      if (arch) { setArchived(Number(arch.dataset.archive), arch.dataset.next === '1', ctx, root); return; }
      if (ev.target.closest('[data-retry]')) { load(ctx, root); }
    },
    change(ev) {
      if (ev.target.id === 'mem-archived') { state.archived = ev.target.checked; load(ctx, root); return; }
      if (ev.target.id === 'mem-scope') { state.scope = ev.target.value; load(ctx, root); return; }
      const range = ev.target.closest('[data-weight]');
      if (range) commitWeight(Number(range.dataset.weight), Number(range.value) / 100, range, ctx, root);
    },
    input(ev) {
      if (ev.target.id === 'mem-q') {
        state.q = ev.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => load(ctx, root), 300);
        return;
      }
      const range = ev.target.closest('[data-weight]');
      if (range) {
        const out = range.closest('.weight');
        const numEl = out ? out.querySelector('.weight-num') : null;
        if (numEl) numEl.textContent = ctx.fmt(Number(range.value) / 100);
      }
    },
  });
}

async function load(ctx, root) {
  const seq = ++state.seq;
  state.loading = true;
  state.error = '';
  paint(root, ctx);
  const qs = new URLSearchParams();
  if (state.levels.size) qs.set('level', [...state.levels].join(','));
  if (state.q.trim()) qs.set('q', state.q.trim());
  if (state.scope) qs.set('scope', state.scope);
  if (state.archived) qs.set('archived', '1');
  qs.set('limit', '100');
  try {
    const data = await ctx.api(`/api/pandora/memories?${qs.toString()}`);
    if (seq !== state.seq) return;
    state.items = Array.isArray(data.items) ? data.items : [];
    state.stats = data.stats || null;
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

async function loadScopes(ctx, root) {
  if (state.scopes.length) return;
  try {
    const data = await ctx.api('/api/pandora/people');
    state.scopes = (Array.isArray(data.people) ? data.people : []).map((p) => ({ scope: p.scope, name: p.name || '' }));
    if (root.dataset.tab !== 'memories') return;
    const sel = root.querySelector('#mem-scope');
    if (sel) {
      sel.innerHTML = scopeOptions(ctx);
      if (state.scope) sel.value = state.scope;
    }
  } catch {
    /* scope 下拉只是锦上添花，失败不影响主列表 */
  }
}

function bucketOf(item, ctx) {
  const t = ctx.toTime(item.createdAt ?? item.updatedAt);
  if (t === null) return '更早';
  const gap = ctx.dayGap(Date.now(), t);
  if (gap <= 0) return '今天';
  if (gap === 1) return '昨天';
  if (gap < 7) return '本周';
  return '更早';
}

function paint(root, ctx) {
  if (root.dataset.tab !== 'memories') return;
  const meta = root.querySelector('#mem-meta');
  const list = root.querySelector('#mem-list');
  if (!meta || !list) return;
  const stats = state.stats || {};
  const total = Number.isFinite(Number(stats.total)) ? Number(stats.total) : state.items.length;
  const archivedCount = Number.isFinite(Number(stats.archived)) ? Number(stats.archived) : state.items.filter(ctx.isArchived).length;
  meta.innerHTML = `<span>共 ${total} 条</span><span class="dot">·</span><span>归档 ${archivedCount}</span>${state.loading ? '<span class="dot">·</span><span>读取中…</span>' : ''}`;
  if (state.error) {
    list.innerHTML = `<div class="card pad"><p class="warn">${ctx.esc(state.error)}</p><button type="button" class="btn" data-retry>重试</button></div>`;
    return;
  }
  if (state.loading && !state.items.length) {
    list.innerHTML = skeleton();
    return;
  }
  if (!state.items.length) {
    list.innerHTML = ctx.empty('她还没记住什么');
    return;
  }
  const sorted = state.items.slice().sort((a, b) => {
    const ta = ctx.toTime(a.createdAt ?? a.updatedAt) ?? 0;
    const tb = ctx.toTime(b.createdAt ?? b.updatedAt) ?? 0;
    return tb - ta;
  });
  const grouped = new Map(GROUPS.map((name) => [name, []]));
  for (const item of sorted) grouped.get(bucketOf(item, ctx)).push(item);
  let html = '';
  for (const name of GROUPS) {
    const items = grouped.get(name);
    if (!items.length) continue;
    html += `<section class="tgroup"><h2 class="tgroup-title">${name}<span>${items.length}</span></h2>${items.map((it) => card(it, ctx)).join('')}</section>`;
  }
  list.innerHTML = html;
}

function card(it, ctx) {
  const id = Number(it.id);
  const rawLevel = String(it.memLevel ?? it.mem_level ?? '').toUpperCase();
  const level = /^L[1-6]$/.test(rawLevel) ? rawLevel : 'L?';
  const importance = ctx.norm01(it.importance ?? it.weight ?? 0);
  const weightKnown = it.weight !== null && it.weight !== undefined;
  const weight = weightKnown ? ctx.norm01(it.weight) : null;
  const emotion = ctx.norm01(it.emotion ?? 0);
  const hot = emotion >= 0.7;
  const archived = ctx.isArchived(it);
  const at = it.createdAt ?? it.updatedAt;
  const uses = Number(it.useCount ?? it.use_count ?? 0);
  return `<article class="card mem-card${archived ? ' is-archived' : ''}" data-id="${id}">
    <div class="mem-head">
      <span class="lv lv-${level}">${level}</span>
      ${it.kind ? `<span class="tag">${ctx.esc(it.kind)}</span>` : ''}
      ${it.scope ? `<span class="tag scope" title="${ctx.esc(it.scope)}">${ctx.esc(it.scope)}</span>` : ''}
      ${emotion > 0 ? `<span class="emo${hot ? ' hot' : ''}" title="情绪戳">情绪 ${ctx.fmt(emotion)}</span>` : ''}
      <time title="${ctx.esc(ctx.fullTime(at))}">${ctx.esc(ctx.timeAgo(at))}</time>
      ${archived ? '<span class="flag">已归档</span>' : ''}
    </div>
    <p class="mem-text">${ctx.esc(it.text || '（没有正文）')}</p>
    ${it.sensory ? `<p class="mem-sensory">${ctx.esc(it.sensory)}</p>` : ''}
    ${it.subtext ? `<p class="mem-subtext">「${ctx.esc(it.subtext)}」</p>` : ''}
    <div class="mem-foot">
      <label class="weight" title="拖动写入 importance（0–1），松手保存">
        <span class="weight-cap">权重</span>
        <input type="range" min="0" max="100" step="1" value="${Math.round(importance * 100)}" data-weight="${id}" aria-label="权重">
        <span class="weight-num">${ctx.fmt(importance)}</span>
      </label>
      <span class="uses">调用 ${Number.isFinite(uses) ? uses : 0} 次</span>
      <span class="uses" title="分量 = 重要度 × 保留率（只读）">分量 ${weight === null ? '—' : ctx.fmt(weight)}</span>
      <button type="button" class="btn tiny" data-archive="${id}" data-next="${archived ? '0' : '1'}">${archived ? '复职' : '归档'}</button>
    </div>
  </article>`;
}

function skeleton() {
  return Array.from({ length: 3 }, () => '<div class="card sk-card"><div class="sk-line w30"></div><div class="sk-line"></div><div class="sk-line w80"></div><div class="sk-line w50"></div></div>').join('');
}

function toggleLevel(level, ctx, root) {
  if (state.levels.has(level)) {
    if (state.levels.size === 1) {
      ctx.toast('至少留一个等级');
      return;
    }
    state.levels.delete(level);
  } else {
    state.levels.add(level);
  }
  const btn = root.querySelector(`[data-level="${level}"]`);
  if (btn) {
    const on = state.levels.has(level);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  load(ctx, root);
}

async function commitWeight(id, value, input, ctx, root) {
  const item = state.items.find((it) => Number(it.id) === id);
  if (!item) return;
  const before = { importance: item.importance, weight: item.weight };
  item.importance = value;
  input.disabled = true;
  const cardEl = input.closest('.mem-card');
  try {
    const data = await ctx.api(`/api/pandora/memories/${id}`, { method: 'PATCH', body: { importance: Number(value.toFixed(3)) } });
    if (data.item && typeof data.item === 'object') Object.assign(item, data.item);
    if (cardEl) cardEl.classList.add('saved');
    ctx.toast(`权重已改为 ${ctx.fmt(ctx.norm01(item.importance ?? value))}`);
  } catch (err) {
    item.importance = before.importance;
    item.weight = before.weight;
    const back = ctx.norm01(before.importance ?? before.weight ?? value);
    input.value = String(Math.round(back * 100));
    const numEl = cardEl ? cardEl.querySelector('.weight-num') : null;
    if (numEl) numEl.textContent = ctx.fmt(back);
    if (cardEl) cardEl.classList.add('failed');
    ctx.toast(`权重没改成：${err.message}`, 'err');
  } finally {
    input.disabled = false;
    if (cardEl) setTimeout(() => cardEl.classList.remove('saved', 'failed'), 900);
    if (root.dataset.tab !== 'memories') return;
  }
}

async function setArchived(id, next, ctx, root) {
  const item = state.items.find((it) => Number(it.id) === id);
  if (!item) return;
  const before = ctx.isArchived(item);
  item.archived = next;
  paint(root, ctx);
  try {
    const data = await ctx.api(`/api/pandora/memories/${id}/archive`, { method: 'POST', body: { archived: next } });
    if (data.item && typeof data.item === 'object') Object.assign(item, data.item);
    if (next && !state.archived) state.items = state.items.filter((it) => Number(it.id) !== id);
    ctx.toast(next ? '已归档，她不会再主动想起' : '已复职');
  } catch (err) {
    item.archived = before;
    ctx.toast(`没成功：${err.message}`, 'err');
  }
  paint(root, ctx);
}