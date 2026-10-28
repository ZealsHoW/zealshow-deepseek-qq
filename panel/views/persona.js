// 人格状态：左边人设卡，右边实时状态 + 念头；底部动作走 /api/socialV2/spirit。
let state = null;

function fresh() {
  return { data: null, loaded: false, loading: false, busy: '', error: '', seq: 0, handlers: null };
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
    <div class="persona-grid">
      <div class="card pad" id="persona-card">${'<div class="sk-line w40"></div><div class="sk-line"></div><div class="sk-line w80"></div><div class="sk-line"></div>'}</div>
      <div class="card pad" id="state-card">${'<div class="sk-line w40"></div><div class="sk-line"></div><div class="sk-line w60"></div>'}</div>
    </div>
    <div class="actions">
      <button type="button" class="btn" data-action="nap">打盹 20 分钟</button>
      <button type="button" class="btn" data-action="sweet">吃点甜的</button>
      <button type="button" class="btn" data-action="refresh">刷新</button>
      <button type="button" class="btn ghost" data-action="debug">打开调试</button>
    </div>
  </section>`;
}

function bind(root, ctx) {
  ctx.listen(root, state, {
    click(ev) {
      const btn = ev.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'refresh') { load(ctx, root); return; }
      if (action === 'debug') {
        window.open(`${window.location.origin}/`, '_blank', 'noopener');
        return;
      }
      act(action, ctx, root);
    },
  });
}

async function load(ctx, root) {
  const seq = ++state.seq;
  state.loading = true;
  state.error = '';
  paint(root, ctx);
  try {
    const data = await ctx.api('/api/pandora/persona');
    if (seq !== state.seq) return;
    state.data = data;
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

async function act(action, ctx, root) {
  if (state.busy) return;
  state.busy = action;
  setButtons(root, true);
  try {
    // 走面板自己的代理端点：浏览器只有 pandora_token，控制台鉴权的 /api/socialV2/spirit 会 401。
    const body = action === 'nap' ? { action: 'nap', minutes: 20 } : { action: 'sweet', what: '甜的' };
    const data = await ctx.api('/api/pandora/spirit', { method: 'POST', body });
    if (state.data && data.snapshot) {
      state.data.state = { ...(state.data.state || {}), ...data.snapshot };
      if (data.snapshot.budget) state.data.state.budget = data.snapshot.budget;
    }
    ctx.toast(data.summary || (action === 'nap' ? '她打了个盹' : '她吃了点甜的'));
    await load(ctx, root);
  } catch (err) {
    ctx.toast(`没成功：${err.message}`, 'err');
  } finally {
    state.busy = '';
    setButtons(root, false);
  }
}

function setButtons(root, disabled) {
  root.querySelectorAll('[data-action]').forEach((btn) => {
    if (btn.dataset.action === 'refresh' || btn.dataset.action === 'debug') return;
    btn.disabled = disabled;
  });
}

function money(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : null;
}

function ring(value, label) {
  const known = money(value);
  const v = known === null ? 0 : (Number(known) > 1 && Number(known) <= 100 ? Number(known) / 100 : Math.min(1, Math.max(0, Number(known))));
  const pct = Math.round(v * 100);
  return `<div class="stat">
    <div class="ring" role="img" aria-label="${label} ${known === null ? '未知' : `${pct}%`}">
      <svg viewBox="0 0 42 42" aria-hidden="true">
        <circle class="ring-bg" cx="21" cy="21" r="15.9155"></circle>
        <circle class="ring-fg" cx="21" cy="21" r="15.9155" pathLength="100" stroke-dasharray="${(v * 100).toFixed(1)} 100"></circle>
      </svg>
      <span class="ring-num">${known === null ? '—' : `${pct}%`}</span>
    </div>
    <div class="stat-body"><span class="stat-name">${label}</span><span class="stat-val">${known === null ? '暂时读不到' : `${pct} / 100`}</span></div>
  </div>`;
}

function paint(root, ctx) {
  if (root.dataset.tab !== 'persona') return;
  const left = root.querySelector('#persona-card');
  const right = root.querySelector('#state-card');
  if (!left || !right) return;
  if (state.error) {
    left.innerHTML = `<h2>加载失败</h2><p class="warn">${ctx.esc(state.error)}</p><button type="button" class="btn" data-action="refresh">重试</button>`;
    right.innerHTML = '';
    return;
  }
  const data = state.data;
  if (!data) {
    if (!state.loading) {
      left.innerHTML = '<h2>人格状态</h2><p class="muted">还没有数据。</p>';
      right.innerHTML = '';
    }
    return;
  }
  const persona = data.persona || {};
  const st = data.state || {};
  const thoughts = data.thoughts || {};
  const tags = Array.isArray(persona.tags) ? persona.tags : [];
  const budget = st.budget && typeof st.budget === 'object' ? st.budget : { maxChars: st.budget };
  const budgetChars = money(budget.maxChars, 0);

  left.innerHTML = `<header class="persona-head">
      <h2>${ctx.esc(persona.name || '小鲸')}</h2>
      ${st.mood ? `<span class="tag">${ctx.esc(st.mood)}</span>` : ''}
    </header>
    <div class="tags">${tags.length ? tags.map((t) => `<span class="tag soft">${ctx.esc(t)}</span>`).join('') : '<span class="muted">没有标签</span>'}</div>
    ${persona.voiceLine ? `<p class="voice">“${ctx.esc(persona.voiceLine)}”</p>` : ''}
    <div class="persona-body">${ctx.esc(persona.card || '她还没有写下人设卡。')}</div>`;

  const due = thoughts.due;
  const dueText = due === null || due === undefined || due === '' ? '' : String(typeof due === 'object' ? JSON.stringify(due) : due);
  const rows = (Array.isArray(thoughts.items) ? thoughts.items : []).map((t) => `<li class="thought">
      <div class="thought-head"><span class="tag soft">${ctx.esc(t.kind || '念头')}</span><time title="${ctx.esc(ctx.fullTime(t.createdAt))}">${ctx.esc(ctx.timeAgo(t.createdAt))}</time></div>
      <p class="thought-text">${ctx.esc(t.text || '')}</p>
      <div class="thought-urge">${ctx.bar(t.urge, '冲动', 'warm')}<span class="muted">${ctx.fmt(ctx.norm01(t.urge), 2)}</span></div>
    </li>`).join('');

  right.innerHTML = `<h2>此刻的状态</h2>
    <div class="stats">
      ${ring(st.spirit, '精神值')}
      <div class="stat"><div class="stat-body wide"><span class="stat-name">饥饿值</span>${ctx.bar(st.hunger, '饥饿值', 'warm')}<span class="stat-val">${money(st.hunger) === null ? '暂时读不到' : `${Math.round(ctx.norm01(st.hunger) * 100)} / 100`}</span></div></div>
    </div>
    <dl class="facts">
      <div><dt>状态</dt><dd>${ctx.esc(st.status || '—')}</dd></div>
      <div><dt>清醒</dt><dd>${money(st.awakeHours, 2) === null ? '—' : `${ctx.fmt(st.awakeHours, 2)} 小时`}</dd></div>
      <div><dt>字数预算</dt><dd>${budgetChars === null ? '—' : `${budgetChars} 字`}${budget.tone ? `<span class="muted"> · ${ctx.esc(budget.tone)}</span>` : ''}</dd></div>
    </dl>
    <h3 class="sub">脑子里的念头${dueText ? `<span class="muted due">下一条：${ctx.esc(dueText)}</span>` : ''}</h3>
    ${rows ? `<ul class="thoughts">${rows}</ul>` : ctx.empty('她脑子里空空的')}`;
}