// qq_draw_image / webshot.renderHtmlToImage 的真浏览器冒烟（手动跑，不进回归套件）：
// 回归测试只测纯函数与参数校验（见 test-outbox-tools.mjs），真起 Chrome 这一段放这里，
// 与 qq_web_screenshot 的 smoke-read-page.mjs 同一口径。
// 用法：node scripts/smoke-draw-image.mjs
import fs from 'node:fs';
import { renderHtmlToImage, stripDrawActiveContent } from '../src/webshot.js';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 320">
  <rect width="600" height="320" fill="#0f172a"/>
  <circle cx="120" cy="160" r="70" fill="#38bdf8"/>
  <text x="230" y="150" font-family="sans-serif" font-size="40" fill="#f8fafc">大肥鱼</text>
  <text x="230" y="200" font-family="sans-serif" font-size="24" fill="#94a3b8">qq_draw_image 冒烟 ✅</text>
</svg>`;

const html = `<div style="font:700 44px/1.5 'Microsoft YaHei',sans-serif;padding:44px;color:#111">
  你好，我是大肥鱼
  <div style="font-size:22px;color:#666;margin-top:10px">HTML 片段也可以画：自动按内容高度裁切</div>
</div>`;

const hostile = `<div>外链与脚本应被剥掉</div>
  <script>document.title='pwned'</script>
  <img src="http://127.0.0.1:3100/api/socialV2/config">
  <div onclick="alert(1)">click</div>`;

const strokes = [];
try {
  const a = await renderHtmlToImage({ svg, name: 'smoke-draw-svg' });
  console.log(`✅ SVG  → ${a.file}  ${a.width}×${a.height}  ${Math.round(a.bytes / 1024)} KB  ${a.ms}ms  剥掉 ${a.stripped} 处`);
  strokes.push(a.path);

  const b = await renderHtmlToImage({ html, width: 640 });
  console.log(`✅ HTML → ${b.file}  ${b.width}×${b.height}  ${Math.round(b.bytes / 1024)} KB  ${b.ms}ms（高度自适应）`);
  strokes.push(b.path);

  const stripped = stripDrawActiveContent(hostile);
  const c = await renderHtmlToImage({ html: hostile, width: 420, name: 'smoke-draw-hostile' });
  console.log(`✅ 恶意内容 → ${c.file}  ${Math.round(c.bytes / 1024)} KB  剥掉 ${c.stripped} 处（纯函数口径 ${stripped.stripped} 处）`);
  strokes.push(c.path);

  for (const file of strokes) {
    const size = fs.statSync(file).size;
    if (size < 1000) throw new Error(`渲染结果太小，可能是白图：${file}（${size} 字节）`);
  }
  console.log('\n结果：三张图都渲染成功，PNG 落在 state/outbox/，可直接 qq_send_image(image="<文件名>")');
} catch (error) {
  console.error('❌ 冒烟失败：', error?.message ?? error);
  process.exit(1);
}