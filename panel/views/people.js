// 人物档案：每人一行，点开抽屉拉该 scope 的记忆。
let state = null;

function fresh() {
  return { people: [], loaded: false, loading: false, error: '', seq: 0, drawerSeq: 0, handlers: null };
}

export function mount(root, ctx) {
  if (!state) state = fresh();
  root.innerHTML = shell();
  bind(root, ctx);
  if (!state.loaded && !state.loading) load(ctx, root);
  paint(root, ctx);
}

function shell() {
  return `<section class="pane">
    <div class="list-meta" id="people-meta"></div>
    <div id="people-list"></div>
  </section>`;
}

function bind(root, ctx) {
  ctx.listen(root, state, {
    click(ev) {
      const row = ev.target.closest('[data-scope]');
      if (row) {
        open(row.dataset.scope, row.dataset.pname || row.dataset.scope, ctx);
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
  try {
    const data = await ctx.api('/api/pandora/people');
    if (seq !== state.seq) return;
    state.people = Array.isArray(data.people) ? data.people : [];
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

function chatKind(scope, label) {
  const s = String(scope || '').toLowerCase();
  const l = String(label || '');
  if (/group|群/.test(s) || l.includes('群')) return '群聊';
  if (/private|friend|私/.test(s) || l.includes('私')) return '私聊';
  return '私聊';
}

function paint(root, ctx) {
  if (root.dataset.tab !== 'people') return;
  const meta = root.querySelector('#people-meta');
  const list = root.querySelector('#people-list');
  if (!meta || !list) return;
  meta.innerHTML = `<span>共 ${state.people.length} 个人</span>${state.loading ? '<span class="dot">·</span><span>读取中…</span>' : ''}`;
  if (state.error) {
    list.innerHTML = `<div class="card pad"><p class="warn">${ctx.esc(state.error)}</p><button type="button" class="btn" data-retry>重试</button></div>`;
    return;
  }
  if (state.loading && !state.people.length) {
    list.innerHTML = Array.from({ length: 4 }, () => '<div class="card sk-card"><div class="sk-line w30"></div><div class="sk-line w70"></div></div>').join('');
    return;
  }
  if (!state.people.length) {
    list.innerHTML = ctx.empty('还没有人来找过她');
    return;
  }
  list.innerHTML = state.people.map((p) => {
    const kind = chatKind(p.scope, p.label);
    const count = Number(p.memories ?? p.count ?? 0);
    return `<button type="button" class="card person-row" data-scope="${ctx.esc(p.scope || '')}" data-pname="${ctx.esc(p.name || p.scope || '')}">
      <span class="person-main">
        <span class="person-name">${ctx.esc(p.name || p.scope || '未知')}</span>
        <span class="tag soft kind-${kind === '群聊' ? 'group' : 'private'}">${kind}</span>
        <span class="muted scope-text" title="${ctx.esc(p.scope || '')}">${ctx.esc(p.scope || '')}</span>
      </span>
      <span class="person-side">
        <span class="count">${Number.isFinite(count) ? count : 0} 条记忆</span>
        <time title="${ctx.esc(ctx.fullTime(p.lastAt))}">${ctx.esc(ctx.timeAgo(p.lastAt))}</time>
      </span>
      <span class="person-excerpt">${ctx.esc(p.lastText || '还没有留下记忆')}</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>`;
  }).join('');
}

async function open(scope, name, ctx) {
  if (!scope) {
    ctx.toast('这条记录没有 scope');
    return;
  }
  const seq = ++state.drawerSeq;
  ctx.openDrawer(name, '<p class="muted">读取中…</p>');
  try {
    const data = await ctx.api(`/api/pandora/memories?scope=${encodeURIComponent(scope)}&limit=50`);
    if (seq !== state.drawerSeq) return;
    const body = ctx.drawerBody();
    const drawer = document.getElementById('drawer');
    if (!body || !drawer || drawer.hidden) return;
    const items = Array.isArray(data.items) ? data.items : [];
    body.innerHTML = `<p class="muted drawer-scope">scope：<code>${ctx.esc(scope)}</code></p>
      ${items.length ? `<ul class="drawer-mems">${items.map((it) => memRow(it, ctx)).join('')}</ul>` : ctx.empty('这个 scope 下还没有记忆')}`;
  } catch (err) {
    if (seq !== state.drawerSeq) return;
    const body = ctx.drawerBody();
    if (!body) return;
    body.innerHTML = `<p class="warn">${ctx.esc(err.message || String(err))}</p>`;
  }
}

function memRow(it, ctx) {
  const raw = String(it.memLevel ?? '').toUpperCase();
  const level = /^L[1-6]$/.test(raw) ? raw : 'L?';
  return `<li class="drawer-mem">
    <div class="dm-head">
      <span class="lv lv-${level}">${level}</span>
      <time title="${ctx.esc(ctx.fullTime(it.createdAt))}">${ctx.esc(ctx.timeAgo(it.createdAt))}</time>
      ${ctx.isArchived(it) ? '<span class="flag">已归档</span>' : ''}
    </div>
    <p class="dm-text">${ctx.esc(it.text || '（没有正文）')}</p>
    ${it.subtext ? `<p class="mem-subtext">「${ctx.esc(it.subtext)}」</p>` : ''}
  </li>`;
}