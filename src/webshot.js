// 网页通道：用本机 Chrome/Edge 的无头模式打开网页，截图（captureWebsite）或把正文
// 读成纯文本（readWebsite，类似「浏览器网页抓取」）。
//
// 用途：让小鲸鱼能「上网看看」——打开抖音、B 站、新闻、搜索结果页，截一张图存进
// state/outbox/，再配合 qq_send_image 把图发出去；也可以先 qq_describe_image 看懂。
// 遇到抖音分享口令/链接这类「文字才对」的场合，用 readWebsite / qq_read_page 直接读正文，
// 比截图再让视觉模型去认准确得多，也省一次模型调用。
//
// 设计要点：
// - 不引入任何新依赖：直接 spawn 本机已安装的 Chrome（没有就用 Edge），
//   用 DevTools 协议（CDP）控制：等待页面加载、关掉登录弹层、按需截整页。
// - 固定一个持久化 profile（state/browser-profile）：用户手动扫码登录一次后，
//   之后的截图都带着登录态（抖音那种一打开就弹登录框的站点需要这个）。
// - 真实桌面 Chrome 的 User-Agent：无头模式默认 UA 带 HeadlessChrome，会被不少
//   站点直接拦住（抖音会卡在加载动画/验证页）。
// - 串行执行：同一个 profile 不能被两个 Chrome 同时占用，并发请求排队。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const OUTBOX_DIR = path.join(STATE_DIR, 'outbox');
const PROFILE_DIR = path.join(STATE_DIR, 'browser-profile');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

const BROWSER_CANDIDATES = [
  process.env.QQBOT_CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

// 关掉固定的登录/引导浮层（只动 position:fixed 且文案像登录框的容器，别把正常内容删了）
const DISMISS_SCRIPT = `(() => {
  let removed = 0;
  const looksLogin = (t) => /登录后|扫码登录|请先登录|登录查看更多|打开.{0,6}APP|下载.{0,6}客户端/.test(t);
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    let cs;
    try { cs = getComputedStyle(el); } catch { continue; }
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 120) continue;
    const t = (el.innerText || '').slice(0, 300);
    if (looksLogin(t)) {
      try { el.remove(); removed++; } catch {}
    }
  }
  return removed;
})()`;

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  throw new Error('没有找到可用的 Chrome/Edge，可在 config.json 的 web.browserPath 指定浏览器路径');
}

function loadWebConfig() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {}
  const w = c.web && typeof c.web === 'object' ? c.web : {};
  return {
    enabled: w.enabled !== false,
    browserPath: String(w.browserPath || '').trim(),
    defaultWidth: clampInt(w.defaultWidth, 320, 2560, 1280),
    defaultHeight: clampInt(w.defaultHeight, 320, 4000, 900),
    defaultWaitMs: clampInt(w.defaultWaitMs, 1000, 30000, 9000),
    timeoutMs: clampInt(w.timeoutMs, 10000, 180000, 90000),
    maxOutputBytes: clampInt(w.maxOutputBytes, 1024 * 1024, 40 * 1024 * 1024, 20 * 1024 * 1024)
  };
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function ensureDirs() {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

let queueTail = Promise.resolve();

function enqueue(task) {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => {});
  return run;
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true; // IPv6 一律不放行
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new Error('网址不合法，需要完整的 http(s):// 地址');
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('只支持 http(s) 网页地址');
  if (isPrivateHost(url.hostname)) throw new Error('出于安全考虑，不允许访问本机/内网地址');
  return url.toString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ───────────────────────── 读取网页正文 ─────────────────────────

// 抖音分享文案长这样：「8.97 复制打开抖音，看看【某某的作品】… https://v.douyin.com/xxxx/ 复制此链接…」
// 所以入口既要吃纯 URL，也要能从整段口令里把 URL 抠出来。
const SHARE_URL_RE = /https?:\/\/[^\s<>"'，。；、！？）】」》]+/i;
const BARE_DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+(?:com|cn|net|org|tv|cc|io|me|co|top|xyz|im|app)(?:\/[^\s]*)?)/i;

export function extractUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('请提供网页链接或抖音分享文案');
  const m = raw.match(SHARE_URL_RE);
  if (m) return m[0].replace(/[.。,，;；:：!！?？)）\]】}」》'"]+$/, '');
  const d = raw.match(BARE_DOMAIN_RE);
  if (d) return `https://${d[1].replace(/[.。,，;；:：!！?？)）\]】}」》'"]+$/, '')}`;
  throw new Error('没在提供的文本里找到网址（需要 http(s):// 链接，或 v.douyin.com 这样的短链）');
}

// 页面正文里反复出现的导航/按钮文案，读正文时是纯噪音。
const NOISE_LINES = new Set([
  '首页', '推荐', '搜索', '关注', '朋友', '消息', '我', '登录', '下载抖音', '下载客户端',
  '打开APP', '打开app', '分享', '收藏', '评论', '更多', '收起', '展开', '发布', '发送',
  '举报', '复制链接', '不感兴趣', '反馈', '返回顶部', '加载中', '全部评论', '导航', '网站导航', '登录/注册',
  '客户端', '壁纸', '通知', '投稿', '充钻石', '广告投放', '用户服务协议', '账号找回', '加入我们',
  '友情链接', '站点地图', '抖音电商', '网上有害信息举报', '互联网违法和不良信息举报', '播放',
  '收藏夹', '稍后再看', '弹幕设置', '倍速', '全屏', '网页全屏', '画中画'
]);

// 页脚/备案/客户端引导这些整行噪音，用正则清掉（按行匹配，不误伤正文里的短句）。
const NOISE_PATTERNS = [
  /^(开启读屏标签|读屏标签已关闭|手机随时看更方便|下载 ?APP|下载抖音精选|下载客户端)$/i,
  /^(京ICP|京公网安备|沪ICP|粤ICP|浙ICP|苏ICP|川ICP|鄂ICP|湘ICP|闽ICP|鲁ICP|豫ICP|冀ICP|皖ICP|赣ICP|晋ICP|陕ICP|渝ICP|津ICP|（京）|（沪）|（粤）|（浙）)/,
  /ICP备|公网安备|电子营业执照|许可证|证字〔|网络文化经营|增值电信|广播电视节目制作|互联网宗教|药品医疗器械|互联网新闻信息服务|网络谣言曝光台|有害信息举报|专项举报|Copyright|©/i,
  /^(举报|反馈|联系我们|关于我们|用户协议|隐私政策)(电话|邮箱)?[:：]?$/
];

function isNoiseLine(line) {
  if (NOISE_LINES.has(line)) return true;
  return NOISE_PATTERNS.some((re) => re.test(line));
}

export function cleanPageText(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  const out = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/[\t ]+/g, ' ').trim();
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (isNoiseLine(line)) continue;
    if (out.length && out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const SITE_LABELS = {
  'douyin.com': '抖音', 'iesdouyin.com': '抖音',
  'bilibili.com': '哔哩哔哩', 'b23.tv': '哔哩哔哩',
  'weibo.com': '微博', 'zhihu.com': '知乎',
  'xiaohongshu.com': '小红书', 'github.com': 'GitHub',
  'mp.weixin.qq.com': '微信公众号'
};

function siteLabelOf(host) {
  const h = String(host || '').toLowerCase();
  const hit = Object.keys(SITE_LABELS).find((suffix) => h === suffix || h.endsWith(`.${suffix}`));
  return hit ? SITE_LABELS[hit] : h || '网页';
}

// 在页面里跑：把标题、正文、抖音专有字段和热评一次性带回来。
// 抖音的 data-e2e 选择器是它前端自用的稳定钩子，比 class 名可靠；失效时回落 innerText。
const PAGE_READ_SCRIPT = `(() => {
  const pick = (sel) => {
    try {
      const el = document.querySelector(sel);
      return el ? String(el.innerText || el.textContent || '').trim() : '';
    } catch { return ''; }
  };
  const meta = (name) => {
    try {
      const el = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
      return el ? String(el.content || '').trim() : '';
    } catch { return ''; }
  };
  const collect = (sel, limit) => {
    try {
      return Array.from(document.querySelectorAll(sel)).slice(0, limit)
        .map((el) => String(el.innerText || '').trim()).filter(Boolean);
    } catch { return []; }
  };
  const links = (() => {
    try {
      const seen = new Set();
      const out = [];
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const href = String(a.href || '');
        if (!/^https?:/i.test(href)) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        out.push(href);
        if (out.length >= 200) break;
      }
      return out;
    } catch { return []; }
  })();
  return {
    title: document.title || '',
    url: location.href,
    desc: meta('og:description') || meta('description'),
    ogTitle: meta('og:title'),
    text: document.body ? String(document.body.innerText || '') : '',
    links,
    douyin: {
      // 现版抖音：detail-video-info 里依次是「标题+话题、点赞、评论、收藏、分享、举报、发布时间」。
      desc: pick('[data-e2e="detail-video-info"]'),
      author: pick('[data-e2e="user-info"]'),
      stats: {
        like: pick('[data-e2e="video-player-digg"]'),
        comment: pick('[data-e2e="feed-comment-icon"]'),
        collect: pick('[data-e2e="video-player-collect"]'),
        share: pick('[data-e2e="video-player-share"]')
      },
      comments: collect('[data-e2e="comment-item"]', 8)
    }
  };
})()`;

// 排查用：把页面上所有 data-e2e 属性列出来（抖音改版时用来修选择器）。
const E2E_PROBE_SCRIPT = `(() => {
  const KNOWN = ['detail-video-info', 'user-info', 'detail-video-publish-time', 'video-player-digg',
    'feed-comment-icon', 'video-player-collect', 'video-player-share', 'comment-list'];
  const texts = {};
  for (const name of KNOWN) {
    try {
      const el = document.querySelector('[data-e2e="' + name + '"]');
      texts[name] = el ? String(el.innerText || '').trim().slice(0, 300) : null;
    } catch { texts[name] = null; }
  }
  try {
    const names = new Set();
    for (const el of Array.from(document.querySelectorAll('[data-e2e]'))) {
      const v = String(el.getAttribute('data-e2e') || '').trim();
      if (v) names.add(v);
      if (names.size > 80) break;
    }
    return { names: Array.from(names), texts };
  } catch { return { names: [], texts }; }
})()`;

// 现版抖音把文案、几个计数、举报和发布时间塞进同一个节点（detail-video-info），这里只挑文案。
function douyinDescOf(raw) {
  const lines = String(raw || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = [];
  for (const line of lines) {
    if (/^\d+(\.\d+)?(万|w|W)?$/.test(line)) continue; // 点赞/评论/收藏/分享数
    if (/^(举报|分享|回复|收藏)$/.test(line)) continue;
    if (/^发布时间/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').trim().slice(0, 2000);
}

// 「故岁书粉丝2062获赞2.8万关注」→「故岁书」
function douyinAuthorOf(raw) {
  return String(raw || '')
    .split('\n')[0]
    .replace(/粉丝.*$/, '')
    .replace(/获赞.*$/, '')
    .trim()
    .slice(0, 40);
}

// 一条 comment-item 的 innerText：昵称、…、评论正文、时间·地区、点赞数、分享、回复。
function douyinCommentOf(raw) {
  const lines = String(raw || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== '...' && !/^\d+$/.test(l) && !/^(分享|回复|作者)$/.test(l) && !/^展开\d*条?回复/.test(l));
  const name = lines.shift() || '';
  if (!name) return '';
  const body = lines.find((l) => !/^\d+(秒|分钟|小时|天|周|月|年)前/.test(l) && !/^IP属地/.test(l));
  return `${name}${body ? `：${body}` : ''}`;
}

// 抖音页面的导航/播放器/推荐位噪音，正文里没必要留。
const DOUYIN_BODY_NOISE = [
  '精选', '推荐', '关注', '朋友', '我的', '直播', '放映厅', '短剧', '小游戏', 'AI抖音',
  '智能', '清屏', '连播', '举报', '分享', '回复', '收藏', '推荐视频', '大家都在搜：',
  '留下你的精彩评论吧', '暂时没有更多评论', '打开抖音', '下载抖音', '...'
];

// 热榜/列表页：只去掉导航和页脚，时长、点赞数、标题都留着。
function douyinNavStrip(bodyClean) {
  const drop = new Set(DOUYIN_BODY_NOISE);
  return String(bodyClean || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !drop.has(l) && !/^违法和不良信息举报/.test(l) && !/^(Copyright|©)/i.test(l))
    .join('\n');
}

function douyinBodyOf(bodyClean, { desc = '', author = '', comments = [] } = {}) {
  const drop = new Set([...DOUYIN_BODY_NOISE, desc, author].filter(Boolean));
  for (const c of comments) {
    for (const part of String(c).split('：')) {
      const v = part.trim();
      if (v) drop.add(v);
    }
  }
  const kept = [];
  for (const line of String(bodyClean || '').split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (drop.has(l)) continue;
    if (/^\d{1,2}:\d{2}\s*\/\s*\d{1,2}:\d{2}$/.test(l)) continue;
    if (/^\d+$/.test(l)) continue;
    if (/^\d+(秒|分钟|小时|天|周|月|年)前/.test(l)) continue;
    if (/^粉丝.*获赞/.test(l)) continue;
    if (/^((首页|推荐|搜索|更多视频|更多)[ 　]*)+$/.test(l)) continue;
    if (/^(展开\d*条?回复|举报|分享|回复)$/.test(l)) continue;
    if (/^作者声明[:：]/.test(l)) continue;
    if (/^发布时间[:：]?/.test(l)) continue;
    if (/^违法和不良信息举报/.test(l)) continue;
    if (/^Copyright|^©/i.test(l)) continue;
    kept.push(l);
  }
  return kept.join('\n');
}

/**
 * 把 CDP 拿回来的原始 payload 整成「模型能直接读」的正文。
 * 导出是为了离线单测：不需要真浏览器也能验格式化/截断逻辑。
 */
export function buildPageRead(payload = {}, { maxChars = 6000, fallbackUrl = '' } = {}) {
  const rawUrl = String(payload.url || fallbackUrl || '');
  let host = '';
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {}
  const isDouyin = /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/.test(host);
  const dy = payload.douyin && typeof payload.douyin === 'object' ? payload.douyin : {};
  const title = String(payload.title || payload.ogTitle || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  const bodyClean = cleanPageText(payload.text);
  // 只认视频页 data-e2e 里的结构化文案；og:description 在抖音热榜/首页上只是站点宣传语，
  // 拿它当正文会把整页内容顶掉（实测 chars=43）。
  const desc = isDouyin ? douyinDescOf(dy.desc) : '';
  const author = isDouyin ? douyinAuthorOf(dy.author) : '';
  const stats = isDouyin && dy.stats && typeof dy.stats === 'object' ? dy.stats : {};
  const statLine = isDouyin
    ? ['点赞', '评论', '收藏', '分享']
        .map((label, i) => {
          const v = String([stats.like, stats.comment, stats.collect, stats.share][i] || '').trim();
          return v ? `${label} ${v}` : '';
        })
        .filter(Boolean)
        .join(' · ')
    : '';
  const comments = isDouyin
    ? (Array.isArray(dy.comments) ? dy.comments : [])
        .map((c) => douyinCommentOf(c))
        .filter(Boolean)
        .slice(0, 8)
    : [];

  let core;
  if (isDouyin) {
    const chunks = [];
    if (desc) chunks.push(desc);
    const meta = [author ? `作者：${author}` : '', statLine].filter(Boolean).join(' · ');
    if (meta) chunks.push(meta);
    if (comments.length) chunks.push(`热评：\n${comments.map((c, i) => `${i + 1}. ${c}`).join('\n')}`);
    // 没有结构化的视频文案时（比如热榜/搜索页），退回整页正文
    if (!desc) {
      const body = douyinNavStrip(bodyClean);
      if (body) chunks.push(body);
      else if (payload.desc) chunks.push(String(payload.desc).trim());
    } else {
      const rest = douyinBodyOf(bodyClean, { desc, author, comments });
      if (rest && rest.length >= 20) chunks.push(`页面其余内容：\n${rest}`);
    }
    core = chunks.filter(Boolean).join('\n\n');
  } else {
    core = bodyClean;
  }
  core = core.trim();

  const rawChars = core.length;
  const truncated = rawChars > maxChars;
  const text = truncated ? `${core.slice(0, maxChars).trimEnd()}…` : core;

  let note = '';
  // 登录墙/风控的识别：**必须先「没读到东西」**再看正文里有没有登录字样。
  // 只按字样判断会误报——抖音/微博的页面骨架里本来就常年有「登录」两个字的按钮；
  // 反过来只按「读到的东西少」判断也不行，纯视频页本来就没什么正文。
  // 两个条件同时成立才算撞墙，交给 read-login-watch 去数「连续几次」。
  const thin = !core || core.length < 80;
  const loginSmell = /登录|验证|安全检查|访问过于频繁|环境异常/.test(bodyClean);
  // 抖音热榜/搜索页读空 = 反爬或掉登录（登录态正常时这两个页面一定有内容）。
  // 但「读到的东西少」本身不够：纯视频页、正文极少的页面也可能很短，所以再加一道
  // 「什么结构化字段都没拿到」（作者/文案/点赞数/评论全空）—— 正常的视频页至少会有作者或点赞数。
  const structured = Boolean(author || desc || statLine || (Array.isArray(comments) && comments.length));
  const douyinBarren = thin && /(^|\.)douyin\.com$/i.test(host) && !structured;
  const loginWall = thin && (loginSmell || douyinBarren);
  if (!core) {
    note = loginSmell
      ? '页面可能要求登录或触发了风控验证，没读到正文'
      : '页面没有可读正文（可能是纯视频/图片页，或内容还没渲染出来）';
  } else if (core.length < 80 && loginSmell) {
    note = '读到的内容很少，页面可能要求登录或触发了风控验证';
  }

  // 页面上的视频/文章链接（去重、限 10 条）：读热榜/搜索页时能顺手挑一条继续读。
  const links = Array.isArray(payload.links) ? payload.links.map(String) : [];
  const videoLinks = [...new Set(links.filter((href) => /\/video\/\d+/.test(href)))].slice(0, 10);

  return {
    url: rawUrl,
    site: siteLabelOf(host),
    title,
    author,
    statLine,
    desc,
    comments,
    videoLinks,
    text,
    chars: rawChars,
    truncated,
    note,
    loginWall
  };
}

export async function readWebsite(input = {}) {
  const w = loadWebConfig();
  if (!w.enabled) throw new Error('网页读取未启用（config.json 里 web.enabled=false）');
  const url = normalizeUrl(extractUrl(input.url ?? input.link ?? input.text));
  const waitMs = clampInt(input.waitMs, 1000, 30000, w.defaultWaitMs);
  const maxChars = clampInt(input.maxChars, 500, 20000, 6000);
  const width = clampInt(input.width, 320, 2560, w.defaultWidth);
  const height = clampInt(input.height, 320, 4000, w.defaultHeight);
  const exe = w.browserPath || findBrowser();
  ensureDirs();

  return enqueue(async () => {
    const started = Date.now();
    let browser;
    let cdp;
    try {
      browser = await openBrowser(exe, width, height);
      const target = await newTarget(browser.port, 'about:blank');
      cdp = new CDP(pageWsUrl(target));
      await cdp.connect();
      await cdp.send('Page.enable');
      const loadPromise = cdp.once('Page.loadEventFired', 30000);
      await cdp.send('Page.navigate', { url });
      await loadPromise;
      await sleep(waitMs);
      // 关登录浮层，再轻滚一下触发评论/推荐的懒加载，然后回到顶部读全文
      await cdp
        .send('Runtime.evaluate', { expression: DISMISS_SCRIPT, returnByValue: true })
        .catch(() => {});
      await sleep(600);
      await cdp
        .send('Runtime.evaluate', {
          expression: 'window.scrollTo(0, Math.min(1200, Math.max(0, document.body.scrollHeight * 0.5)))',
          returnByValue: true
        })
        .catch(() => {});
      await sleep(900);
      await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0, 0)', returnByValue: true }).catch(() => {});
      await sleep(250);
      const res = await cdp.send('Runtime.evaluate', { expression: PAGE_READ_SCRIPT, returnByValue: true });
      const payload = res?.result?.value ?? {};
      const read = buildPageRead(payload, { maxChars, fallbackUrl: url });
      let debugInfo;
      if (input.debug === true) {
        const probe = await cdp
          .send('Runtime.evaluate', { expression: E2E_PROBE_SCRIPT, returnByValue: true })
          .catch(() => null);
        const value = probe?.result?.value;
        if (value && typeof value === 'object') {
          debugInfo = { e2eNames: value.names ?? [], e2eTexts: value.texts ?? {} };
        }
      }
      let finalHost = '';
      try {
        finalHost = new URL(read.url).hostname;
      } catch {}
      if (finalHost && isPrivateHost(finalHost)) throw new Error('页面跳转到了本机/内网地址，已拒绝');
      return { ...read, ms: Date.now() - started, browser: exe, ...(debugInfo ?? {}) };
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      try {
        cdp?.close();
      } catch {}
      try {
        browser?.child?.kill('SIGKILL');
      } catch {}
    }
  });
}


function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// 极简 CDP 客户端：连接页面的 webSocketDebuggerUrl，按 id 收发消息。
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = null;
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连接浏览器调试端口超时')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(t);
        reject(new Error('连接浏览器调试端口失败'));
      });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message || 'CDP 错误'}（${msg.method || ''}）`));
        else resolve(msg.result);
        return;
      }
      const ls = this.listeners.get(msg.method);
      if (ls) ls.forEach((fn) => fn(msg.params));
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 30000);
    });
  }
  once(method, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const fn = (params) => {
        const arr = this.listeners.get(method) || [];
        this.listeners.set(
          method,
          arr.filter((x) => x !== fn)
        );
        resolve(params);
      };
      const arr = this.listeners.get(method) || [];
      arr.push(fn);
      this.listeners.set(method, arr);
      setTimeout(() => {
        const cur = this.listeners.get(method) || [];
        this.listeners.set(
          method,
          cur.filter((x) => x !== fn)
        );
        resolve(null);
      }, timeoutMs);
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function openBrowser(exe, width, height) {
  const port = await freePort();
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    `--window-size=${width},${height}`,
    `--user-agent=${USER_AGENT}`,
    'about:blank'
  ];
  const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('浏览器启动超时（没有等到调试端口）')), 20000);
    const onData = (buf) => {
      stderr += buf.toString();
      const m = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    };
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`启动浏览器失败：${err.message}`));
    });
    child.on('exit', (code) => {
      if (code != null) {
        clearTimeout(timer);
        reject(new Error(`浏览器提前退出（exit=${code}）`));
      }
    });
  });
  return { child, port, wsUrl };
}

async function newTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`创建标签页失败：HTTP ${res.status}`);
  return res.json();
}

function pageWsUrl(target) {
  return target.webSocketDebuggerUrl;
}

export async function captureWebsite(input = {}) {
  const w = loadWebConfig();
  if (!w.enabled) throw new Error('网页截图未启用（config.json 里 web.enabled=false）');
  const url = normalizeUrl(input.url);
  const width = clampInt(input.width, 320, 2560, w.defaultWidth);
  const height = clampInt(input.height, 320, 4000, w.defaultHeight);
  const waitMs = clampInt(input.waitMs, 500, 30000, w.defaultWaitMs);
  const fullPage = input.fullPage === true;
  const exe = w.browserPath || findBrowser();
  ensureDirs();

  return enqueue(async () => {
    const file = `web-${stamp()}-${Math.random().toString(36).slice(2, 6)}.png`;
    const outPath = path.join(OUTBOX_DIR, file);
    const started = Date.now();
    let browser;
    let cdp;
    try {
      browser = await openBrowser(exe, width, height);
      const target = await newTarget(browser.port, 'about:blank');
      cdp = new CDP(pageWsUrl(target));
      await cdp.connect();
      await cdp.send('Page.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: width,
        screenHeight: height
      });
      const loadPromise = cdp.once('Page.loadEventFired', 30000);
      await cdp.send('Page.navigate', { url });
      await loadPromise;
      await sleep(waitMs);
      // 关掉登录/引导浮层，再等一下让它淡出
      try {
        await cdp.send('Runtime.evaluate', { expression: DISMISS_SCRIPT, returnByValue: true });
      } catch {}
      await sleep(700);
      // 滚到顶部，确保截的是首屏内容
      try {
        await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)', returnByValue: true });
      } catch {}
      let shotParams = { format: 'png', captureBeyondViewport: false };
      if (fullPage) {
        const metrics = await cdp.send('Page.getLayoutMetrics').catch(() => null);
        const contentH = Math.min(3000, Math.ceil(metrics?.cssContentSize?.height || metrics?.contentSize?.height || height));
        shotParams = { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: contentH, scale: 1 } };
      }
      const shot = await cdp.send('Page.captureScreenshot', shotParams);
      const buf = Buffer.from(shot.data, 'base64');
      if (buf.length > w.maxOutputBytes) throw new Error(`截图太大（${Math.round(buf.length / 1024)} KB），请减小 width/height 或关闭 fullPage`);
      fs.writeFileSync(outPath, buf);
      const title = await cdp
        .send('Runtime.evaluate', { expression: 'document.title || ""', returnByValue: true })
        .then((r) => String(r?.result?.value || '').slice(0, 200))
        .catch(() => '');
      return { file, path: outPath, bytes: buf.length, url, width, height, fullPage, title, ms: Date.now() - started, browser: exe };
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      try {
        cdp?.close();
      } catch {}
      try {
        browser?.child?.kill('SIGKILL');
      } catch {}
    }
  });
}

// ── 画画（renderHtmlToImage / qq_draw_image）───────────────────────────────
// 小鲸鱼自己「画」一张图：给她一段 SVG（或简单 HTML），用同一套无头 Chrome 渲染成 PNG
// 落进 state/outbox/，之后 qq_send_image 就能发出去。
//
// 与 captureWebsite 的关键差别：**画面内容来自模型，不是某个网址**，所以安全口径更严：
// - 断网：导航前 Network.setBlockedURLs([...])，只按「协议」拦（http/https/ws/wss/ftp/file），
//   而不是写字面 '*'。差别在于 data: URI 也会被 '*' 命中：内联图片（`<img src="data:image/png;base64,…">`）
//   作为请求一样会被挡掉，于是「在图上叠文字」这类合成图只能画出一个破图图标。
//   data: 是本进程自己塞进去的字节，不是网络出口，所以放行它不破坏上面那条口径。导航本身也是 data: URL。
// - 去活内容：<script>/<iframe>/<object>/<embed>/<base>/<link>/<meta> 与 on* 事件属性在渲染前
//   剥掉，画出来的是静态图。
// 这样即使 prompt injection 让她画「某个内部地址的内容」，也没有出口。
const DRAW_MAX_CHARS = 200_000;
const DRAW_STRIP_TAGS = ['script', 'iframe', 'object', 'embed', 'base', 'link', 'meta'];

/**
 * 剥掉页面里的活内容（脚本、外部资源标签、内联事件处理器）。
 * 返回值里的 stripped 是"剥了几处"，用于在工具返回里如实说明（而不是假装没动过）。
 */
export function stripDrawActiveContent(raw) {
  let text = String(raw ?? '');
  let stripped = 0;
  for (const tag of DRAW_STRIP_TAGS) {
    // 成对标签（含内容）与自闭合标签两种写法都要吃到，否则 `<script src=…/>` 会漏。
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>|<${tag}\\b[^>]*\\/?>`, 'gi');
    text = text.replace(re, () => {
      stripped += 1;
      return '';
    });
  }
  text = text.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, () => {
    stripped += 1;
    return '';
  });
  return { text: text.trim(), stripped };
}

/**
 * 把 svg / html 组装成一份完整文档（纯函数，便于离线回归）。
 * config.json 的 web.enabled=false 时由调用方拒绝，这里只负责组装与长度校验。
 */
export function buildDrawDocument(input = {}) {
  const svg = typeof input.svg === 'string' ? input.svg.trim() : '';
  const html = typeof input.html === 'string' ? input.html.trim() : '';
  if (svg && html) throw new Error('svg 和 html 只能给一个');
  if (!svg && !html) throw new Error('要画什么？请给 svg（推荐，矢量、缩放不糊）或 html');
  const body = stripDrawActiveContent(svg || html);
  if (!body.text) throw new Error('内容剥掉脚本/外链后是空的，画不出东西');
  if (body.text.length > DRAW_MAX_CHARS) throw new Error(`画的内容太长了（${body.text.length} 字符，上限 ${DRAW_MAX_CHARS}）`);
  const isFullDoc = /^(<!doctype\s+html|<html[\s>])/i.test(body.text);
  // 两种壳子，差别只在"要不要铺满视口"：
  // - SVG：height:100% 让矢量铺满画布（preserveAspectRatio 默认等比，不拉变形）；
  // - HTML 片段：**不能**给 html/body 定高，否则 cssContentSize 永远等于视口高度，
  //   "高度自适应"就变成永远 800 —— 内容多高就该多高。
  const shell = svg
    ? '<style>html,body{margin:0;padding:0;height:100%;background:#fff}svg{display:block;width:100%;height:100%}body{overflow:hidden}</style>'
    : '<style>html,body{margin:0;padding:0;background:#fff}img,video,table{max-width:100%}</style>';
  const head = `<!doctype html><html><head><meta charset="utf-8">${shell}</head><body>`;
  const document = isFullDoc ? body.text : `${head}${body.text}</body></html>`;
  // SVG 能从 viewBox 推出宽高比：不给 height 时按它算，画布正好贴住图形（而不是方形画布里上下留白）。
  let aspect = null;
  if (svg) {
    const box = /viewBox\s*=\s*["']\s*([-\d.eE\s,]+)["']/i.exec(svg);
    if (box) {
      const nums = box[1].trim().split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
      if (nums.length === 4 && nums[2] > 0 && nums[3] > 0) aspect = nums[3] / nums[2];
    }
  }
  return { html: document, chars: body.text.length, stripped: body.stripped, kind: svg ? 'svg' : 'html', stretch: Boolean(svg), aspect };
}

/** 画出来的文件名：只允许一个扁平的文件名，去掉路径分隔符与前导点，补 .png。 */
export function drawFileName(name) {
  const raw = String(name ?? '').trim();
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.{2,}/g, '_')
    .trim()
    .slice(0, 60);
  if (!cleaned) return `draw-${stamp()}-${Math.random().toString(36).slice(2, 6)}.png`;
  if (/\.png$/i.test(cleaned)) return cleaned;
  return `${cleaned.replace(/\.[a-z0-9]{1,6}$/i, '')}.png`;
}

/**
 * 渲染 svg/html 成 PNG 存进 state/outbox/，返回 { file, path, bytes, width, height, ... }。
 * height 不给时按内容高度自适应（最多 3000px）；2 倍像素密度，文字边缘不糊。
 */
export async function renderHtmlToImage(input = {}) {
  const w = loadWebConfig();
  if (!w.enabled) throw new Error('画画未启用（config.json 里 web.enabled=false）');
  const document = buildDrawDocument(input);
  const width = clampInt(input.width, 64, 2560, 800);
  const rawHeight = Number(input.height);
  const autoHeight = !Number.isFinite(rawHeight) || rawHeight <= 0;
  // 不给高度时：SVG 按 viewBox 的宽高比算（画布贴住图形），HTML 用视口高度起底、之后再按内容裁。
  const aspectHeight = autoHeight && document.aspect ? clampInt(Math.round(width * document.aspect), 64, 4000, 800) : null;
  const viewHeight = aspectHeight ?? clampInt(rawHeight, 64, 4000, 800);
  const waitMs = clampInt(input.waitMs, 0, 30000, 400);
  const exe = w.browserPath || findBrowser();
  ensureDirs();
  const file = drawFileName(input.name);
  const outPath = path.join(OUTBOX_DIR, file);

  return enqueue(async () => {
    const started = Date.now();
    let browser;
    let cdp;
    try {
      browser = await openBrowser(exe, width, viewHeight);
      const target = await newTarget(browser.port, 'about:blank');
      cdp = new CDP(pageWsUrl(target));
      await cdp.connect();
      await cdp.send('Page.enable');
      // 2 倍像素密度：图更清晰，尺寸上限仍由 width/height/maxOutputBytes 兜住。
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: viewHeight,
        deviceScaleFactor: 2,
        mobile: false,
        screenWidth: width,
        screenHeight: viewHeight
      });
      // 断网必须在导航之前设好，否则页面里第一个外链请求可能已经发出去。
      // 按协议拦（不是 '*'），给 data: 留一条口子——内联图片要能显示，见文件头注释。
      try {
        await cdp.send('Network.enable');
        await cdp.send('Network.setBlockedURLs', {
          urls: ['http://*', 'https://*', 'ws://*', 'wss://*', 'ftp://*', 'file://*']
        });
      } catch {}
      const loadPromise = cdp.once('Page.loadEventFired', 20000);
      const url = `data:text/html;charset=utf-8;base64,${Buffer.from(document.html, 'utf8').toString('base64')}`;
      await cdp.send('Page.navigate', { url });
      await loadPromise;
      await sleep(waitMs);
      let shotHeight = viewHeight;
      if (autoHeight && !aspectHeight) {
        // 不能只看 Page.getLayoutMetrics 的 cssContentSize：无头 Chrome 把它报到**至少等于视口**，
        // 于是"高度自适应"会永远得到 800。
        // 量 body 的盒子才是内容真实高度（body 高度是 auto）。
        // 注意别把 documentElement.scrollHeight 算进来：它天然 ≥ 视口高度，一算就又变回 800。
        const measured = await cdp
          .send('Runtime.evaluate', {
            expression:
              '(() => { const b = document.body;' +
              ' if (!b) return document.documentElement ? document.documentElement.scrollHeight : 0;' +
              ' return Math.ceil(Math.max(b.getBoundingClientRect().height, b.scrollHeight)); })()',
            returnByValue: true
          })
          .then((r) => Number(r?.result?.value))
          .catch(() => NaN);
        const fallback = await cdp
          .send('Page.getLayoutMetrics')
          .then((m) => Math.ceil(m?.cssContentSize?.height || m?.contentSize?.height || viewHeight))
          .catch(() => viewHeight);
        shotHeight = Math.min(3000, Math.max(64, Number.isFinite(measured) && measured > 0 ? measured : fallback));
      }
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: shotHeight, scale: 1 }
      });
      const buf = Buffer.from(shot.data, 'base64');
      if (buf.length > w.maxOutputBytes) {
        throw new Error(`画出来的图太大（${Math.round(buf.length / 1024)} KB），把 width/height 调小一点，或简化内容`);
      }
      fs.writeFileSync(outPath, buf);
      return {
        file,
        path: outPath,
        bytes: buf.length,
        width: width * 2,
        height: shotHeight * 2,
        kind: document.kind,
        chars: document.chars,
        stripped: document.stripped,
        aspect: document.aspect,
        ms: Date.now() - started,
        browser: exe
      };
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      try {
        cdp?.close();
      } catch {}
      try {
        browser?.child?.kill('SIGKILL');
      } catch {}
    }
  });
}

// 一次性扫码登录用的有头浏览器（不参与截图队列）：用同一个 profile 打开，登录后关掉即可。
export function launchLoginBrowser(rawUrl = 'https://www.douyin.com') {
  const url = normalizeUrl(rawUrl);
  const w = loadWebConfig();
  const exe = w.browserPath || findBrowser();
  ensureDirs();
  const child = spawn(
    exe,
    ['--no-first-run', '--no-default-browser-check', `--user-data-dir=${PROFILE_DIR}`, '--window-size=1280,900', url],
    { windowsHide: false, detached: true, stdio: 'ignore' }
  );
  child.unref();
  return { pid: child.pid, profile: PROFILE_DIR, url };
}

export { OUTBOX_DIR, PROFILE_DIR };
