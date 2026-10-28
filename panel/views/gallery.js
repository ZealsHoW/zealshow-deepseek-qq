// 收藏夹：按分组铺图/音频，点开看原图与真实路径。
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus', 'weba']);
let state = null;

function fresh() {
  return { groups: [], loaded: false, loading: false, error: '', seq: 0, handlers: null };
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
    <div class="list-meta" id="gallery-meta"></div>
    <div id="gallery-body"></div>
  </section>`;
}

function bind(root, ctx) {
  ctx.listen(root, state, {
    click(ev) {
      if (ev.target.closest('audio')) return;
      const tile = ev.target.closest('[data-open]');
      if (tile) {
        show(Number(tile.dataset.g), Number(tile.dataset.i), ctx);
        return;
      }
      if (ev.target.closest('[data-retry]')) load(ctx, root);
    },
    keydown(ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const tile = ev.target.closest('[data-open]');
      if (!tile) return;
      ev.preventDefault();
      show(Number(tile.dataset.g), Number(tile.dataset.i), ctx);
    },
  });
}

async function load(ctx, root) {
  const seq = ++state.seq;
  state.loading = true;
  state.error = '';
  paint(root, ctx);
  try {
    const data = await ctx.api('/api/pandora/gallery');
    if (seq !== state.seq) return;
    state.groups = Array.isArray(data.groups) ? data.groups : [];
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

function extOf(it) {
  const raw = String(it.kind || '').replace(/^\./, '').toLowerCase();
  if (raw) return raw;
  const name = String(it.name || it.path || '');
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function paint(root, ctx) {
  if (root.dataset.tab !== 'gallery') return;
  const meta = root.querySelector('#gallery-meta');
  const box = root.querySelector('#gallery-body');
  if (!meta || !box) return;
  const count = state.groups.reduce((n, g) => n + (Array.isArray(g.items) ? g.items.length : 0), 0);
  meta.innerHTML = `<span>${state.groups.length} 个分组</span><span class="dot">·</span><span>${count} 件</span>${state.loading ? '<span class="dot">·</span><span>读取中…</span>' : ''}`;
  if (state.error) {
    box.innerHTML = `<div class="card pad"><p class="warn">${ctx.esc(state.error)}</p><button type="button" class="btn" data-retry>重试</button></div>`;
    return;
  }
  if (state.loading && !state.groups.length) {
    box.innerHTML = '<div class="tiles">' + Array.from({ length: 6 }, () => '<div class="tile sk-tile"></div>').join('') + '</div>';
    return;
  }
  if (!state.groups.length) {
    box.innerHTML = ctx.empty('收藏夹还是空的');
    return;
  }
  box.innerHTML = state.groups.map((group, g) => {
    const items = Array.isArray(group.items) ? group.items : [];
    return `<section class="gallery-group">
      <h2 class="group-title">${ctx.esc(group.name || '未分组')}<span>${items.length}</span></h2>
      ${items.length ? `<div class="tiles">${items.map((it, i) => tile(it, g, i, ctx)).join('')}</div>` : ctx.empty('这一组还是空的')}
    </section>`;
  }).join('');
}

function tile(it, g, i, ctx) {
  const ext = extOf(it);
  const url = it.url ? String(it.url) : '';
  const name = it.name || it.path || '未命名';
  const media = IMAGE_EXT.has(ext)
    ? `<img class="thumb" src="${ctx.esc(url)}" alt="${ctx.esc(name)}" loading="lazy" decoding="async">`
    : AUDIO_EXT.has(ext)
      ? `<span class="audio-wrap"><audio controls preload="none" src="${ctx.esc(url)}" aria-label="${ctx.esc(name)}"></audio></span>`
      : '<span class="file-ico">文件</span>';
  return `<article class="tile" data-open data-g="${g}" data-i="${i}" tabindex="0" role="button" aria-label="查看 ${ctx.esc(name)}">
    ${media}
    <span class="tile-name" title="${ctx.esc(it.path || name)}">${ctx.esc(name)}</span>
  </article>`;
}

function show(g, i, ctx) {
  const group = state.groups[g];
  const it = group && Array.isArray(group.items) ? group.items[i] : null;
  if (!it) return;
  const ext = extOf(it);
  const url = it.url ? String(it.url) : '';
  const name = it.name || it.path || '未命名';
  const media = IMAGE_EXT.has(ext)
    ? `<img class="zoom-img" src="${ctx.esc(url)}" alt="${ctx.esc(name)}">`
    : AUDIO_EXT.has(ext)
      ? `<audio class="zoom-audio" controls preload="none" src="${ctx.esc(url)}"></audio>`
      : '';
  const size = humanSize(it.size);
  ctx.openDrawer(name, `<div class="zoom">${media}
    <p class="path"><code>${ctx.esc(it.path || '（没有路径）')}</code></p>
    <dl class="facts">
      <div><dt>分组</dt><dd>${ctx.esc(group.name || '未分组')}</dd></div>
      <div><dt>类型</dt><dd>${ctx.esc(ext || '未知')}</dd></div>
      ${size ? `<div><dt>大小</dt><dd>${ctx.esc(size)}</dd></div>` : ''}
      <div><dt>收藏时间</dt><dd>${ctx.esc(ctx.fullTime(it.createdAt))}</dd></div>
    </dl>
    ${url ? `<p class="muted">直接打开：<a href="${ctx.esc(url)}" target="_blank" rel="noopener">${ctx.esc(url)}</a></p>` : ''}
  </div>`);
}