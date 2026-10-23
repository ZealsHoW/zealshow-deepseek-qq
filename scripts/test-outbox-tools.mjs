// 待发文件夹（state/outbox）与「自己画图」的回归。
//
// 三段，都不该碰真 QQ、也不该碰真桥接进程：
//   ① webshot 的纯函数（组装文档 / 剥活内容 / 文件名）—— 不启浏览器；
//   ② 桥接的 outbox 清理 —— 走 audit harness（真跑 bridge.js，在临时目录里造文件）；
//   ③ 三个新 MCP 工具 —— 真起 stdio server，断言清单与参数校验（真 Chrome 渲染留给
//      smoke-draw-image.mjs，理由同 test-read-page.mjs：回归测试不启浏览器）。
// 用法：node scripts/test-outbox-tools.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { buildDrawDocument, drawFileName, stripDrawActiveContent } from '../src/webshot.js';

let failed = 0;
const pass = (name) => console.log(`✅ ${name}`);
const fail = (name, detail) => {
  failed += 1;
  console.error(`❌ ${name} — ${detail}`);
};
function check(name, run) {
  try {
    run();
    pass(name);
  } catch (error) {
    fail(name, error?.message ?? error);
  }
}
async function checkAsync(name, run) {
  try {
    await run();
    pass(name);
  } catch (error) {
    fail(name, error?.message ?? error);
  }
}

// ── ① 纯函数：组装文档 ────────────────────────────────────────────────────
check('SVG 被包进完整文档，并强制铺满视口（等比不拉变形）', () => {
  const doc = buildDrawDocument({ svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#f00"/></svg>' });
  assert.equal(doc.kind, 'svg');
  assert.equal(doc.stretch, true);
  assert.equal(doc.aspect, 1);
  assert.match(doc.html, /^<!doctype html>/i);
  assert.match(doc.html, /<svg viewBox="0 0 10 10">/);
  assert.match(doc.html, /svg\{display:block;width:100%;height:100%\}/);
});

check('SVG 的宽高比从 viewBox 读出来（不给 height 时画布贴住图形）', () => {
  assert.equal(buildDrawDocument({ svg: '<svg viewBox="0 0 600 320"></svg>' }).aspect, 320 / 600);
  assert.equal(buildDrawDocument({ svg: '<svg viewBox="0,0,100,50"></svg>' }).aspect, 0.5);
  assert.equal(buildDrawDocument({ svg: '<svg width="10" height="10"></svg>' }).aspect, null, '没有 viewBox 就不能瞎猜');
});

check('已是完整 HTML 文档时不再二次包裹（否则嵌套 html 标签会被浏览器乱修）', () => {
  const raw = '<!doctype html><html><body><h1>hi</h1></body></html>';
  assert.equal(buildDrawDocument({ html: raw }).html, raw);
});

check('HTML 片段被包进壳子，且壳子不给 html/body 定高（否则高度自适应永远等于视口）', () => {
  const doc = buildDrawDocument({ html: '<h1>hi</h1>' });
  assert.equal(doc.kind, 'html');
  assert.equal(doc.stretch, false);
  assert.match(doc.html, /html,body\{margin:0;padding:0;background:#fff\}/);
  assert.ok(!/height:100%/.test(doc.html), 'HTML 壳子不能有 height:100%');
  assert.match(doc.html, /<h1>hi<\/h1><\/body><\/html>$/);
});

check('脚本 / iframe / 外链 / 内联事件都被剥掉，并如实计数', () => {
  const input =
    '<div onclick="alert(1)" onmouseover=\'x()\'>x</div>' +
    '<script>fetch("http://127.0.0.1:3100/api/socialV2/config")</script>' +
    '<SCRIPT SRC="http://evil.invalid/x.js"></SCRIPT>' +
    '<iframe src="http://127.0.0.1:3100"></iframe>' +
    '<object data="x"></object><embed src="x">' +
    '<link rel="stylesheet" href="http://evil.invalid/x.css">';
  const result = stripDrawActiveContent(input);
  assert.ok(!/script|iframe|object|embed|onclick|onmouseover|link/i.test(result.text), result.text);
  assert.ok(result.stripped >= 8, `剥掉处数偏少：${result.stripped}`);
});

check('svg 与 html 同时给会明确报错', () => {
  assert.throws(() => buildDrawDocument({ svg: '<svg/>', html: '<b>x</b>' }), /只能给一个/);
});

check('什么都不给会明确报错', () => {
  assert.throws(() => buildDrawDocument({}), /要画什么/);
});

check('剥完什么都不剩也会报错（而不是渲染出一张白图）', () => {
  assert.throws(() => buildDrawDocument({ html: '<script>a()</script>' }), /空的/);
});

check('超长内容被拒（防止把 data: URL 撑爆）', () => {
  assert.throws(() => buildDrawDocument({ html: `<p>${'x'.repeat(200_001)}</p>` }), /太长/);
});

// ── ① 纯函数：文件名 ─────────────────────────────────────────────────────
check('文件名：路径分隔符被压平、不会带 .. 或 /（不能越出 outbox）', () => {
  for (const raw of ['../../etc/passwd', 'a/b\\c.png', 'C:\\Windows\\win.ini', '..\\..\\x']) {
    const name = drawFileName(raw);
    assert.ok(!name.includes('/') && !name.includes('\\'), `${raw} → ${name}`);
    assert.ok(!name.includes('..'), `${raw} → ${name}`);
    assert.match(name, /\.png$/);
  }
});

check('文件名：给了名字就用它，扩展名统一成 .png；不给就 draw-<时间戳>', () => {
  assert.equal(drawFileName('小猫'), '小猫.png');
  assert.equal(drawFileName('cat.jpg'), 'cat.png');
  assert.equal(drawFileName('  spaced name  '), 'spaced name.png');
  assert.match(drawFileName(''), /^draw-[\d-]+-[a-z0-9]{4}\.png$/);
  assert.match(drawFileName(undefined), /^draw-/);
});

// ── ② 桥接：待发文件夹清理 ───────────────────────────────────────────────
const outboxOf = (h) => path.join(h.temp, 'state', 'outbox');
function seed(dir, name, { ageMs = 0, bytes = 16 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  fs.writeFileSync(full, Buffer.alloc(bytes, 7));
  const seconds = (Date.now() - ageMs) / 1000;
  fs.utimesSync(full, seconds, seconds);
  return full;
}
const KEEP = { enabled: true, maxFiles: 200, maxTotalBytes: 200 * 1024 * 1024, maxAgeDays: 7, minKeepMs: 3_600_000, intervalMs: 60_000, firstDelayMs: 5_000 };

await checkAsync('清理：超过 maxFiles 时从最旧的删，且绝不碰保护期内的新图', async () => {
  const h = await bridgeHarness();
  try {
    h.cfg.socialV2.media.outboxCleanup = { ...KEEP, maxFiles: 2 };
    const dir = outboxOf(h);
    seed(dir, 'old-1.png', { ageMs: 3 * 3_600_000 });
    seed(dir, 'old-2.png', { ageMs: 2 * 3_600_000 });
    seed(dir, 'old-3.png', { ageMs: 1_800_000 });
    seed(dir, 'fresh.png', { ageMs: 0 });
    const result = h.cleanupOutboxMedia();
    assert.equal(result.removed, 2, `应该删 2 个（4 个里留 2 个，fresh 不许删），实际 ${result.removed}`);
    assert.ok(!fs.existsSync(path.join(dir, 'old-1.png')), '最旧的应先被删');
    assert.ok(!fs.existsSync(path.join(dir, 'old-2.png')));
    assert.ok(fs.existsSync(path.join(dir, 'old-3.png')));
    assert.ok(fs.existsSync(path.join(dir, 'fresh.png')), '刚放进去、还没发的图不能被删');
    assert.equal(result.kept, 2);
    assert.equal(result.failed, 0);
  } finally {
    await h.close();
  }
});

await checkAsync('清理：超过 maxAgeDays 的删掉，保护期内的不动', async () => {
  const h = await bridgeHarness();
  try {
    h.cfg.socialV2.media.outboxCleanup = { ...KEEP, maxAgeDays: 1, minKeepMs: 3_600_000 };
    const dir = outboxOf(h);
    seed(dir, 'ancient.png', { ageMs: 3 * 24 * 3_600_000 });
    seed(dir, 'aged-but-protected.png', { ageMs: 1_800_000 });
    seed(dir, 'recent.png', { ageMs: 2 * 3_600_000 });
    const result = h.cleanupOutboxMedia();
    assert.equal(result.removed, 1);
    assert.ok(!fs.existsSync(path.join(dir, 'ancient.png')));
    assert.ok(fs.existsSync(path.join(dir, 'aged-but-protected.png')), '保护期内（minKeepMs）不能被删，哪怕它比 maxAgeDays 老');
    assert.ok(fs.existsSync(path.join(dir, 'recent.png')));
  } finally {
    await h.close();
  }
});

await checkAsync('清理：总体积超限时仍然从最旧的开始删', async () => {
  const h = await bridgeHarness();
  try {
    h.cfg.socialV2.media.outboxCleanup = { ...KEEP, maxFiles: 1000, maxTotalBytes: 1024 * 1024 };
    const dir = outboxOf(h);
    seed(dir, 'big-1.png', { ageMs: 3 * 3_600_000, bytes: 800 * 1024 });
    seed(dir, 'big-2.png', { ageMs: 2 * 3_600_000, bytes: 800 * 1024 });
    const result = h.cleanupOutboxMedia();
    assert.equal(result.removed, 1, `1.6MB 超 1MB，应只删最旧的 800KB，实际删 ${result.removed}`);
    assert.ok(!fs.existsSync(path.join(dir, 'big-1.png')));
    assert.ok(fs.existsSync(path.join(dir, 'big-2.png')));
  } finally {
    await h.close();
  }
});

await checkAsync('清理：目录不存在不报错，子目录与名字怪的文件不被牵连', async () => {
  const h = await bridgeHarness();
  try {
    h.cfg.socialV2.media.outboxCleanup = { ...KEEP, maxAgeDays: 1 };
    // 目录还不存在：应安静返回 0，而不是抛 ENOENT。
    const empty = h.cleanupOutboxMedia();
    assert.equal(empty.removed, 0);
    assert.equal(empty.scanned, 0);
    const dir = outboxOf(h);
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
    seed(dir, 'ancient.png', { ageMs: 30 * 24 * 3_600_000 });
    seed(dir, 'ancient-2.png', { ageMs: 20 * 24 * 3_600_000 });
    const result = h.cleanupOutboxMedia();
    assert.equal(result.removed, 2);
    assert.ok(fs.existsSync(path.join(dir, 'sub')), '子目录不能被删');
    assert.deepEqual(fs.readdirSync(dir), ['sub']);
  } finally {
    await h.close();
  }
});

// ── ③ MCP 工具：清单与参数校验 ───────────────────────────────────────────
const entry = fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'outbox-tools-test', version: '0.1.0' });

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const names = tools.map((t) => t.name);
  for (const name of ['qq_list_outbox', 'qq_save_message_image', 'qq_draw_image']) {
    check(`MCP 工具注册：${name}`, () => assert.ok(names.includes(name), `工具清单里没有 ${name}`));
  }
  check('qq_save_message_image 必填 messageId（key/token 可自动补）', () => {
    const required = tools.find((t) => t.name === 'qq_save_message_image')?.inputSchema?.required ?? [];
    assert.ok(required.includes('messageId'), JSON.stringify(required));
    assert.ok(!required.includes('key') && !required.includes('token'), JSON.stringify(required));
  });
  check('qq_draw_image 的 svg/html/尺寸都不是必填（画布有默认值）', () => {
    const required = tools.find((t) => t.name === 'qq_draw_image')?.inputSchema?.required ?? [];
    assert.deepEqual(required, []);
  });
  await checkAsync('qq_list_outbox 能真的列出待发文件夹（只读）', async () => {
    const listed = await client.callTool({ name: 'qq_list_outbox', arguments: { limit: 3 } });
    assert.ok(!listed.isError, listed.content?.[0]?.text);
    const text = listed.content?.[0]?.text ?? '';
    assert.match(text, /待发文件夹/, text.slice(0, 200));
  });
  await checkAsync('qq_draw_image 什么都不给时在校验层就被拦下（不启动浏览器）', async () => {
    const bad = await client.callTool({ name: 'qq_draw_image', arguments: {} });
    assert.ok(bad.isError, '应该报错');
    assert.match(bad.content?.[0]?.text ?? '', /要画什么/);
  });
  await checkAsync('qq_save_message_image 用假令牌时错误原样透回（不吞成崩溃）', async () => {
    const saved = await client.callTool({
      name: 'qq_save_message_image',
      arguments: { key: 'group:456', messageId: 1, token: 'f'.repeat(32) }
    });
    assert.ok(saved.isError, '假令牌必须失败');
    const text = saved.content?.[0]?.text ?? '';
    assert.ok(text.trim().length > 0, '错误信息不能是空的');
    assert.ok(/失败|无效|未授权|token|令牌|HTTP|fetch/i.test(text), text.slice(0, 200));
  });
} catch (error) {
  fail('MCP stdio 会话', error?.message ?? error);
} finally {
  try {
    await client.close();
  } catch {}
}

console.log(failed ? `\n结果：${failed} 项失败` : '\n结果：全部通过');
process.exit(failed ? 1 : 0);