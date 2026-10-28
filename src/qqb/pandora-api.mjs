// 潘多拉魔盒（/pandora）—— 小鲸的内心面板：静态页 + 只读为主的 REST。
//
// 设计决策见 docs/PANDORA_SPEC.md §9：DSH 本体是打包后的 Electron，客户端插件要打进它自己的
// 构建产物；所以面板做成**桥接自带的独立 Web 应用**（同源、同一张库），不依赖 DSH 内部 UI API。
//
// 鉴权与其它控制台端点一致：`x-console-token`。浏览器不方便带头，所以额外支持
// `GET /pandora?token=<console-token>` 换一枚 HttpOnly cookie（30 天）。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const VERSION = '0.1.0';

const COOKIE = 'pandora_token';
const COOKIE_MAX_AGE = 30 * 24 * 3600;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k) out[k] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** `# 2026-10-26 | 重要 | - 20:31 …` 这种头解析。第二段历史上是空的，留给分级。 */
function parseDiary(raw, file) {
  const lines = String(raw).split(/\r?\n/);
  const head = lines[0] ?? '';
  // 两种头都见过：`# 2026-10-28 | 日常 |`（新格式）与 `# 2026-10-28`（旧格式，没分级没心情）。
  const dateMatch = head.match(/^#\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  const gradeMatch = head.match(/\|\s*([^|]*)\s*\|/);
  const date = dateMatch?.[1] ?? file.replace(/\.md$/, '');
  const gradeRaw = String(gradeMatch?.[1] ?? '').trim();
  const grade = /刻骨|难忘|unforgettable/i.test(gradeRaw)
    ? 'unforgettable'
    : /重要|important/i.test(gradeRaw)
      ? 'important'
      : 'daily';
  const body = lines
    .slice(dateMatch ? 1 : 0)
    .map((l) => l.replace(/^-\s+(\d{1,2}:\d{2})\s*/, '[$1] '))
    .join('\n')
    .trim();
  // 标题取第一条真正的正文（跳过空行、`#` 小标题与 `> ` 引用），没有就用日期兜底。
  const titleLine = body
    .split(/\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('>'));
  return {
    date,
    title: String(titleLine ?? date).replace(/^\[\d{1,2}:\d{2}\]\s*/, '').slice(0, 40),
    grade,
    kind: /梦|dream/i.test(gradeRaw) || /^梦/m.test(body) ? 'dream' : 'diary',
    mood: gradeRaw && !/刻骨|难忘|重要|unforgettable|important/i.test(gradeRaw) ? gradeRaw : '',
    text: body,
  };
}

export function createPandora({ root, store, spirit, thoughts, people, consoleToken, logger = console }) {
  const panelDir = path.join(root, 'panel');
  const stateDir = path.join(root, 'state');
  const audioDir = path.join(root, 'audio');

  /** 静态文件：只允许 panel/ 里的相对路径，任何越界都按 404 处理。 */
  async function serveStatic(res, rel) {
    const clean = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(panelDir, clean);
    if (!file.startsWith(panelDir)) return sendJson(res, 404, { ok: false, error: 'not found' });
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    } catch {
      // SPA 兜底：没扩展名的路径一律回 index.html
      if (!path.extname(clean)) {
        try {
          const html = await fsp.readFile(path.join(panelDir, 'index.html'));
          res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
          return res.end(html);
        } catch {
          /* fallthrough */
        }
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
    }
  }

  function listFiles(dir, exts, { limit = 200 } = {}) {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && exts.includes(path.extname(d.name).toLowerCase()))
        .map((d) => {
          const abs = path.join(dir, d.name);
          const st = fs.statSync(abs);
          return { name: d.name, path: abs, size: st.size, createdAt: st.birthtimeMs || st.mtimeMs };
        })
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  function diaries({ grade = '', limit = 50 } = {}) {
    const dir = path.join(stateDir, 'diary');
    let items = [];
    try {
      items = fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.md'))
        .map((n) => parseDiary(fs.readFileSync(path.join(dir, n), 'utf8'), n));
    } catch {
      return [];
    }
    items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const filtered = grade ? items.filter((it) => it.grade === grade || it.kind === grade) : items;
    return filtered.slice(0, Math.min(Number(limit) || 50, 200));
  }

  function personaPayload() {
    const cardFile = path.join(root, 'roles', '小鲸鱼.md');
    let card = '';
    try {
      card = fs.readFileSync(cardFile, 'utf8');
    } catch {
      card = '（人设卡没找到：roles/小鲸鱼.md）';
    }
    const snap = spirit?.snapshot?.() ?? {};
    const th = thoughts?.snapshot?.() ?? { items: [], lastAt: null };
    let due = null;
    try {
      due = thoughts?.due?.() ?? null;
    } catch { /* 没有念头时 due 可能抛，忽略 */ }
    return {
      ok: true,
      persona: {
        name: '小鲸',
        card: card.slice(0, 8000),
        tags: ['CETACEA_LOLI', '蓝白发', '鲸鱼尾', '傲娇但甜', '五音不全'],
        voiceLine: '亮薄、气声重、f0 中位 248 Hz（声音是 e400 RVC 换的）',
      },
      state: {
        spirit: snap.spirit ?? null,
        hunger: snap.hunger ?? null,
        mood: snap.status ?? '',
        awakeHours: snap.awakeHours ?? null,
        status: snap.asleep ? '睡着了' : snap.status ?? '',
        budget: snap.budget ?? null,
      },
      thoughts: {
        items: (th.items ?? []).map((it) => ({
          id: it.id,
          text: it.text,
          urge: it.urge,
          kind: it.source,
          createdAt: it.at,
          acted: Boolean(it.acted),
        })),
        due,
      },
    };
  }

  async function peoplePayload() {
    const entries = people?.entries?.() ?? [];
    const out = [];
    // entries() 返回的是对象数组 [{ scope, name, kind, note, updatedAt }]，
    // 早期按 [scope, info] 解构过一次，结果是 people 接口整个 500（v0.1.0 的坑）。
    for (const info of entries) {
      const scope = info?.scope;
      if (!scope) continue;
      let memories = 0;
      let lastText = '';
      let lastAt = null;
      try {
        const r = store.listMemoriesForPanel({ scope, limit: 1 });
        const items = r?.items ?? [];
        memories = r?.stats?.total ?? items.length;
        lastText = items[0]?.text ?? '';
        lastAt = items[0]?.updatedAt ?? null;
      } catch (err) {
        logger?.warn?.('pandora: 读记忆失败', scope, err?.message ?? err);
      }
      out.push({
        scope,
        name: info?.name ?? '',
        // 群/私聊分别由 people.label() 统一口径（「小鲸（私聊 private:376245695）」）
        label: people?.label?.(scope) ?? scope,
        kind: info?.kind ?? (String(scope).startsWith('group:') ? 'group' : 'private'),
        note: info?.note ?? '',
        memories,
        lastAt,
        lastText,
      });
    }
    out.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
    return { ok: true, people: out };
  }

  function galleryPayload() {
    const groups = [
      { name: '表情与形象', items: listFiles(path.join(root, 'assets'), ['.png', '.jpg', '.jpeg', '.gif', '.webp']) },
      { name: '我收到的照片', items: listFiles(path.join(stateDir, 'outbox'), ['.png', '.jpg', '.jpeg', '.gif', '.webp']) },
      { name: '我唱过的歌', items: listFiles(path.join(audioDir, 'songs'), ['.wav', '.mp3', '.ogg', '.flac']) },
    ];
    return {
      ok: true,
      groups: groups.map((g) => ({
        name: g.name,
        items: g.items.map((it) => ({
          kind: path.extname(it.name).slice(1).toLowerCase(),
          name: it.name,
          path: it.path,
          // 静态资源也走 /pandora 前缀，但只放行 data/ 子树，避免把整个仓库暴露出去
          url: it.path.startsWith(stateDir) || it.path.startsWith(audioDir) || it.path.startsWith(path.join(root, 'assets'))
            ? `/pandora-data/${encodeURIComponent(path.relative(root, it.path).split(path.sep).join('/'))}`
            : '',
          size: it.size,
          createdAt: it.createdAt,
        })),
      })),
    };
  }

  /** 面板自己的媒体：只允许 root 下 assets/、state/outbox/、audio/songs/ 三处。 */
  async function serveMedia(res, rel) {
    const abs = path.join(root, decodeURIComponent(rel));
    const okPrefixes = [path.join(root, 'assets'), path.join(stateDir, 'outbox'), path.join(audioDir, 'songs')];
    if (!okPrefixes.some((p) => abs.startsWith(p))) return sendJson(res, 403, { ok: false, error: 'forbidden' });
    try {
      const st = await fsp.stat(abs);
      res.writeHead(200, {
        'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'private, max-age=3600',
      });
      fs.createReadStream(abs).pipe(res);
    } catch {
      sendJson(res, 404, { ok: false, error: 'not found' });
    }
  }

  function authorized(req, url) {
    const token = String(req.headers['x-console-token'] ?? '');
    if (token && token === consoleToken) return true;
    const cookies = parseCookies(req.headers.cookie);
    return Boolean(consoleToken) && cookies[COOKIE] === consoleToken;
  }

  /**
   * 返回 true 表示这条请求归面板处理（已写响应）。
   * 调用方（bridge.js）在鉴权之前调用，因为面板自己管 cookie。
   */
  async function handle(req, res, url) {
    const pathname = url.pathname;

    // 换 cookie：/pandora?token=xxx → 302 到 /pandora
    if (pathname === '/pandora' || pathname === '/pandora/') {
      const qsToken = url.searchParams.get('token');
      if (qsToken && qsToken === consoleToken) {
        res.writeHead(302, {
          location: '/pandora',
          'set-cookie': `${COOKIE}=${encodeURIComponent(consoleToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
        });
        return res.end(), true;
      }
      await serveStatic(res, 'index.html');
      return true;
    }

    if (pathname.startsWith('/pandora/')) {
      const rel = pathname.slice('/pandora/'.length) || 'index.html';
      await serveStatic(res, rel);
      return true;
    }

    if (pathname.startsWith('/pandora-data/')) {
      if (!authorized(req, url)) return sendJson(res, 401, { ok: false, error: '未授权' }), true;
      await serveMedia(res, pathname.slice('/pandora-data/'.length));
      return true;
    }

    if (!pathname.startsWith('/api/pandora/')) return false;
    if (!authorized(req, url)) return sendJson(res, 401, { ok: false, error: '未授权：请用 /pandora?token=… 打开' }), true;

    const api = pathname.slice('/api/pandora/'.length);
    try {
      if (api === 'memories' && req.method === 'GET') {
        const levels = String(url.searchParams.get('level') ?? '')
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter((s) => /^L[2-6]$/.test(s));
        const r = store.listMemoriesForPanel({
          levels,
          q: url.searchParams.get('q') ?? '',
          scope: url.searchParams.get('scope') ?? '',
          limit: Number(url.searchParams.get('limit')) || 100,
          includeArchived: url.searchParams.get('archived') === '1',
        });
        return sendJson(res, 200, { ok: true, items: r?.items ?? [], stats: r?.stats ?? {} }), true;
      }

      const memMatch = api.match(/^memories\/(\d+)(\/archive)?$/);
      if (memMatch) {
        const id = Number(memMatch[1]);
        if (req.method === 'PATCH' && !memMatch[2]) {
          const body = await readBody(req);
          const r = store.setMemoryWeight({ id, importance: Number(body.importance) });
          return sendJson(res, r?.ok === false ? 400 : 200, { ok: r?.ok !== false, item: r?.item ?? null }), true;
        }
        if (req.method === 'POST' && memMatch[2]) {
          const body = await readBody(req);
          const r = store.setMemoryArchived({ id, archived: body.archived !== false, reason: body.reason ?? 'manual' });
          return sendJson(res, r?.ok === false ? 400 : 200, { ok: r?.ok !== false, item: r?.item ?? null }), true;
        }
      }

      if (api === 'diaries' && req.method === 'GET') {
        const items = diaries({
          grade: url.searchParams.get('grade') ?? '',
          limit: url.searchParams.get('limit') ?? 50,
        });
        return sendJson(res, 200, { ok: true, items }), true;
      }

      if (api === 'persona' && req.method === 'GET') return sendJson(res, 200, personaPayload()), true;

      // 面板上的两个小动作：打盹 / 吃点甜的。浏览器只有 pandora_token，走不通控制台鉴权的
      // /api/socialV2/spirit，所以在这里代理一次（同一个 spirit 实例、同一套规则）。
      if (api === 'spirit' && req.method === 'POST') {
        const body = await readBody(req);
        const action = String(body?.action ?? '').trim();
        if (action === 'nap') {
          const r = spirit?.nap?.({ minutes: Number(body?.minutes) || 20 }) ?? null;
          return sendJson(res, 200, { ok: r?.ok !== false, action, result: r, snapshot: spirit?.snapshot?.() ?? null }), true;
        }
        if (action === 'sweet') {
          const r = spirit?.sweet?.({ what: String(body?.what || '甜的') }) ?? null;
          return sendJson(res, 200, { ok: r?.ok !== false, action, result: r, snapshot: spirit?.snapshot?.() ?? null }), true;
        }
        return sendJson(res, 400, { ok: false, error: `不认识的动作：${action}` }), true;
      }
      if (api === 'gallery' && req.method === 'GET') return sendJson(res, 200, galleryPayload()), true;
      if (api === 'people' && req.method === 'GET') return sendJson(res, 200, await peoplePayload()), true;

      if (api === 'health') return sendJson(res, 200, { ok: true, ts: Date.now() }), true;

      return sendJson(res, 404, { ok: false, error: `未知接口：${api}` }), true;
    } catch (err) {
      logger?.warn?.('pandora: 接口失败', api, err?.message ?? err);
      return sendJson(res, 500, { ok: false, error: String(err?.message ?? err) }), true;
    }
  }

  return { handle, diaries, personaPayload, peoplePayload, galleryPayload };
}