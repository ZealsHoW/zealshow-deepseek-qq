// 给画好的图配文：把底图内联进 HTML，叠一个气泡/字幕条/贴纸，再用同一套无头 Chrome 渲染出来。
// 都是本地字节，不碰网络（data: URI 在 webshot 的断网口径里是放行的）。
//
// 为什么要它：她自己画出来的图经常是「空镜」——表情对了但没话说。加一句话，图就有梗了。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderHtmlToImage } from '../../webshot.js';

// src/qqb/media/annotate.mjs → 仓库根（qq-bridge 的上一级，那里放着 _gptsovits/ffmpeg）
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const VERSION = '0.1.0';
export const CAPTION_STYLES = ['bubble', 'band', 'sticker'];
export const DEFAULT_CAPTION_STYLE = 'bubble';
// 一张 832×1216 的 PNG base64 约 1.6 MB → 2.2 M 字符，而 webshot 的上限是 200000 字符。
// 所以底图先压到 832 宽、质量够用就行的 jpg；压完通常 60–120 KB，文字照样盖得住。
const MAX_EMBED_CHARS = 150_000;

export function normalizeCaptionStyle(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return CAPTION_STYLES.includes(s) ? s : DEFAULT_CAPTION_STYLE;
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fontPx(text) {
  const n = String(text ?? '').length;
  if (n <= 6) return 60;
  if (n <= 12) return 50;
  if (n <= 20) return 40;
  if (n <= 34) return 32;
  return 26;
}

/**
 * 底图不能直接塞：压到塞得下。返回 { base64, mime }。
 * 用 Chrome 之外的路径压缩（ffmpeg 不保证在），所以这里退一步——先看体积，
 * 太大就交给调用方先缩图（comfy 出来的图本来就在 1–2 MB，压一次就够）。
 */
function embedImage(imagePath) {
  const buf = fs.readFileSync(imagePath);
  const b64 = buf.toString('base64');
  const mime = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg';
  if (b64.length <= MAX_EMBED_CHARS) return { base64: b64, mime };

  // 太大了：压成 832 宽的 jpg 再用。ffmpeg 在 _gptsovits 里随包带着，PATH 里没有，所以走绝对路径。
  // 这个文件在 qq-bridge/src/qqb/media/，往上四层才是 youqq（_gptsovits 在那儿），
  // 但仓库也可能被整个搬到别的地方，所以两个候选都试。
  const base = path.dirname(fileURLToPath(import.meta.url));
  const ffmpeg = [
    path.resolve(base, '..', '..', '..', '..', '_gptsovits', 'ffmpeg', 'ffmpeg-master-latest-win64-gpl-shared', 'bin', 'ffmpeg.exe'),
    path.resolve(base, '..', '..', '..', '_gptsovits', 'ffmpeg', 'ffmpeg-master-latest-win64-gpl-shared', 'bin', 'ffmpeg.exe'),
    'ffmpeg'
  ].find((p) => p === 'ffmpeg' || fs.existsSync(p));
  if (!ffmpeg) throw new Error('底图太大，又找不到 ffmpeg 来压（把 _gptsovits/ffmpeg 放回来）');
  // 临时文件写到 state/outbox（桥接本来就往里写画图产物），别用系统临时目录——
  // 这台机器上沙箱会把 %TEMP% 里的写入挡掉（ffmpeg 报 Permission denied）。
  const outbox = path.resolve(base, '..', '..', '..', 'state', 'outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const tmp = path.join(outbox, `.cap-src-${process.pid}.jpg`);
  // 逐档往下压：先掉画质，再掉分辨率。833 宽的 q4 有 175 KB（base64 已 233k），所以这里目标更狠。
  for (const [w, q] of [[832, 6], [832, 10], [720, 6], [720, 10], [640, 8]]) {
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', imagePath, '-vf', `scale=${w}:-2`, '-q:v', String(q), tmp]);
    const small = fs.readFileSync(tmp);
    if (small.toString('base64').length <= MAX_EMBED_CHARS) {
      try { fs.unlinkSync(tmp); } catch {}
      return { base64: small.toString('base64'), mime: 'image/jpeg' };
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  throw new Error('底图压不下来（换张小一点的图）');
}

function buildHtml({ base64, mime, texts, style, pos }) {
  const items = texts.map((t) => `<div class="cap" style="font-size:${fontPx(t)}px">${escapeHtml(t)}</div>`).join('');
  const core = style === 'bubble'
    ? `<div class="wrap ${pos === 'bottom' ? 'at-bottom' : 'at-top'}">${items}</div>`
    : style === 'band'
      ? `<div class="band">${items.replace(/class="cap"/g, 'class="cap band-cap"')}</div>`
      : `<div class="sticker">${items.replace(/class="cap"/g, 'class="cap sticker-cap"')}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#0d1117}
    .stage{position:relative;width:100vw;height:100vh;overflow:hidden}
    .stage>img{width:100%;height:100%;object-fit:cover;display:block}
    .wrap{position:absolute;left:0;right:0;display:flex;flex-direction:column;align-items:center;gap:14px}
    .wrap.at-top{top:34px;padding:0 22px}
    .wrap.at-bottom{bottom:46px;padding:0 22px}
    .cap{position:relative;background:#fff;color:#16244f;border:5px solid #16244f;border-radius:34px;
      font-family:"Microsoft YaHei","PingFang SC",sans-serif;font-weight:800;line-height:1.32;
      padding:16px 26px;max-width:88%;text-align:center;transform:rotate(-1.2deg);
      box-shadow:0 8px 0 rgba(22,36,79,.18)}
    .wrap.at-top .cap::after{content:'';position:absolute;bottom:-20px;left:46px;width:0;height:0;
      border:16px solid transparent;border-top-color:#16244f;border-bottom:0;transform:rotate(9deg)}
    .band{position:absolute;left:0;right:0;bottom:0;padding:70px 30px 54px;display:flex;flex-direction:column;align-items:center;gap:8px;
      background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.78) 55%)}
    .band-cap{background:none;border:0;box-shadow:none;transform:none;color:#fff;
      font-family:"Microsoft YaHei",sans-serif;font-weight:800;letter-spacing:1px;
      text-shadow:0 3px 8px rgba(0,0,0,.85)}
    .sticker{position:absolute;left:50%;bottom:60px;transform:translateX(-50%) rotate(-2deg);display:flex;flex-direction:column;gap:6px;
      background:#ffe066;border:5px solid #16244f;border-radius:18px;padding:12px 24px;box-shadow:0 8px 0 rgba(22,36,79,.2)}
    .sticker-cap{background:none;border:0;box-shadow:none;transform:none;color:#16244f;padding:0;
      font-family:"Microsoft YaHei",sans-serif;font-weight:900;letter-spacing:1px}
  </style></head><body>
    <div class="stage"><img src="data:${mime};base64,${base64}">${core}</div>
  </body></html>`;
}

/**
 * 给一张图配上文字，返回 { file, path, bytes, width, height }。
 * texts 为空就直接返回原图，不生成副本。
 */
export async function annotateImage({ imagePath, texts = [], style = DEFAULT_CAPTION_STYLE, pos = 'top', width = 832, height = 1216, name } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (!imagePath || !fs.existsSync(imagePath)) throw new Error(`图不存在：${imagePath}`);
  if (!list.length) return { file: path.basename(imagePath), path: imagePath, bytes: fs.statSync(imagePath).size, annotated: false };

  const { base64, mime } = embedImage(imagePath);
  const html = buildHtml({ base64, mime, texts: list, style: normalizeCaptionStyle(style), pos });
  const out = await renderHtmlToImage({
    html,
    width,
    height,
    name: name || `cap-${Date.now().toString(36)}`
  });
  return { ...out, annotated: true };
}