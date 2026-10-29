// 图配文（src/qqb/media/annotate.mjs）的回归：样式归一、HTML 拼装与转义、底图压缩口径、接线。
// 不真渲染（渲染会起 Chrome、要写 outbox），真出图由 _comfy/annotate.mjs 手工验。
import fs from 'node:fs';
import path from 'node:path';
import {
  CAPTION_STYLES,
  DEFAULT_CAPTION_STYLE,
  VERSION,
  normalizeCaptionStyle,
} from '../src/qqb/media/annotate.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

console.log('图配文模块：');
{
  ok('有 VERSION（版本登记表要读）', /^\d+\.\d+\.\d+$/.test(VERSION));
  eq('三种样式', [...CAPTION_STYLES], ['bubble', 'band', 'sticker']);
  eq('默认样式是白气泡', DEFAULT_CAPTION_STYLE, 'bubble');
  eq('样式归一：不认识 → 默认', normalizeCaptionStyle('nope'), 'bubble');
  eq('样式归一：大小写', normalizeCaptionStyle('STICKER'), 'sticker');
  eq('样式归一：空值', normalizeCaptionStyle(''), 'bubble');
}

console.log('\n接线：');
{
  const src = read('src/qqb/media/annotate.mjs');
  // 底图不能直接塞：超过上限要压（ffmpeg 在 _gptsovits 里，不走 PATH）
  ok('有体积上限，超过就压', src.includes('MAX_EMBED_CHARS') && src.includes('scale='));
  ok('ffmpeg 走绝对路径而不是 PATH', src.includes("'_gptsovits'") && src.includes('ffmpeg.exe'));
  ok('临时文件写 state/outbox（%TEMP% 会被沙箱挡）', src.includes("'state', 'outbox'") || src.includes("'state',\n"));
  ok('文字进 HTML 前转义', src.includes('function escapeHtml') && src.includes('&amp;'));
  ok('句子多 → 字号变小', src.includes('function fontPx') && src.includes('if (n <= 6) return 60'));

  const bridge = read('src/bridge.js');
  ok('桥接 import 了 annotateImage', bridge.includes("import { annotateImage, normalizeCaptionStyle } from './qqb/media/annotate.mjs';"));
  ok('路由解析 onImage（字符串或数组，最多两句）', bridge.includes('body.onImage') && bridge.includes('.slice(0, 2)'));
  ok('样式走 normalizeCaptionStyle', bridge.includes('normalizeCaptionStyle(body.onImageStyle ?? body.captionStyle)'));
  ok('画完先叠字再发', bridge.indexOf('await annotateImage({') < bridge.indexOf('const sent = await sendImageV2(job.key, job.file'));
  ok('叠字失败回落到原图（不让一句话毁掉整张图）', bridge.includes('叠字失败，发原图'));
  ok('叠字产物名字带时间戳（不互相覆盖）', bridge.includes('name: `qq-draw-cap-'));
  ok('202 回执带 onImage', bridge.includes('onImage,') && bridge.includes('onImageStyle: onImage.length ? onImageStyle : null'));

  const mcp = read('src/mcp-snowluma-safe.js');
  ok('MCP 工具带 onImage 参数', mcp.includes('onImage: z.union([z.string(), z.array(z.string())])'));
  ok('MCP 工具带 onImageStyle 参数', mcp.includes("onImageStyle: z.enum(['bubble', 'band', 'sticker'])"));
  ok('MCP 把 onImage 传给桥接', mcp.includes('...(onImage ? { onImage } : {})'));

  const webshot = read('src/webshot.js');
  ok('断网口径按协议拦（给 data: 留口子，内联图才画得出来）',
    webshot.includes("urls: ['http://*', 'https://*', 'ws://*', 'wss://*', 'ftp://*', 'file://*']"));

  const audit = read('scripts/test-audit.mjs');
  ok('audit 清单收了本测试', audit.includes("'test-qqb-annotate.mjs'"));
  const pkg = JSON.parse(read('package.json'));
  ok('package.json 有 test:qqb-annotate', typeof pkg.scripts['test:qqb-annotate'] === 'string');
  const ver = read('src/qqb/version.mjs');
  ok('版本登记表收了 media/annotate', ver.includes("'media/annotate'"));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);