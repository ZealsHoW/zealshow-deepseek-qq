// 潘多拉魔盒（P1–P4）接线回归：只查「写好了有没有接上」，不重跑各模块自己的用例。
//   - panel/ 静态页与绝对路径引用
//   - pandora-api 的静态分支、spirit 代理
//   - 记忆核心新 API 与 live 门面的 audience 硬过滤
//   - 索引卡 / 触景生情 / 高情绪锚点接进两条提示词路线
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('面板静态页：');
{
  const files = ['panel/index.html', 'panel/app.js', 'panel/style.css', 'panel/selftest.mjs',
    'panel/views/memories.js', 'panel/views/diaries.js', 'panel/views/persona.js',
    'panel/views/gallery.js', 'panel/views/people.js'];
  for (const f of files) ok(`${f} 存在`, fs.existsSync(path.join(root, f)));
  const html = read('panel/index.html');
  ok('资源用绝对路径（302 后相对路径会断）', html.includes('/pandora/style.css') && html.includes('/pandora/app.js'));
  ok('没有内联脚本', !/<script(?![^>]*src=)/i.test(html));
  const api = read('src/qqb/pandora-api.mjs');
  ok('pandora-api 有 /pandora/<file> 静态分支', api.includes("pathname.startsWith('/pandora/')"));
  ok('静态分支在 /pandora-data/ 之前', api.indexOf("pathname.startsWith('/pandora/')") < api.indexOf("pathname.startsWith('/pandora-data/')"));
  ok('有 /api/pandora/spirit 代理（浏览器只有 cookie）', api.includes("api === 'spirit'"));
  ok('代理只放行 nap/sweet', api.includes("action === 'nap'") && api.includes("action === 'sweet'"));
  const persona = read('panel/views/persona.js');
  ok('面板改走 /api/pandora/spirit', persona.includes("ctx.api('/api/pandora/spirit'") && !persona.includes("ctx.api('/api/socialV2/spirit'"));
}

console.log('记忆核心接线：');
{
  const store = read('src/qqb/memory/store.mjs');
  for (const name of ['listMemoriesForPanel', 'setMemoryWeight', 'setMemoryArchived', 'archiveSweep', 'searchByEntities', 'shareMemory', 'sharedScopesFor']) {
    ok(`store 导出 ${name}`, new RegExp(`\\b${name}\\b`).test(store));
  }
  ok('六层常量 MEM_LEVELS', store.includes("['L2', 'L3', 'L4', 'L5', 'L6']"));
  const live = read('src/qqb/memory/live.mjs');
  ok('live 导出 audienceOf', /export function audienceOf\(/.test(live));
  ok('block() 走 audience 硬过滤', live.includes('audience: audienceOf(key, owner)'));
  ok('live 有 cards()/flash()', /cards\(\{ limit = 5 \}/.test(live) && /flash\(\{ key, text, limit = 3 \}/.test(live));
  const bridge = read('src/bridge.js');
  ok('bridge 注入索引卡与触景生情', /function innerIndexPromptText\(/.test(bridge) && bridge.includes('liveMemory.cards({ limit: 5 })') && bridge.includes('liveMemory.flash({ key, text, limit: 3 })'));
  ok('两条提示词路线都接了', (bridge.match(/innerIndexPromptText\(\{ key, text:/g) ?? []).length >= 2);
  ok('锚点：记录 + 注入 + 100 轮', /function noteAnchor\(/.test(bridge) && /function anchorsTextFor\(/.test(bridge) && bridge.includes('ANCHOR_TURNS = 100'));
  ok('锚点接到收消息路径', bridge.includes('noteAnchor(key, plainContent ?? textContent, emotion)'));
  ok('两条路线都注入锚点', (bridge.match(/anchorsTextFor\(key\)/g) ?? []).length >= 2);
}

console.log('L2 原文底账与上下文折叠：');
{
  const store = read('src/qqb/memory/store.mjs');
  ok('召回默认排除 L2 原文', store.includes("(mem_level IS NULL OR mem_level <> 'L2')") && store.includes('includeOriginals'));
  const live = read('src/qqb/memory/live.mjs');
  ok('live 有 recordOriginal（L2 写入）', /recordOriginal\(\{ key, role = 'user', text, at = null/.test(live) && live.includes("memLevel: 'L2'"));
  ok('太短的原文不记', live.includes('if (body.length < 4) return null;'));
  const bridge = read('src/bridge.js');
  ok('收消息时记原文', bridge.includes('liveMemory.recordOriginal?.({ key, role: \'user\''));
  ok('自己说的话也记原文', bridge.includes('liveMemory.recordOriginal?.({ key, role: \'assistant\''));
  ok('引擎带历史进 loop', bridge.includes('history: engineHistoryV2(key)') && /function engineHistoryV2\(/.test(bridge));
  ok('历史截到本轮触发消息之前', bridge.includes('lastUser'));
  ok('折叠生效时写日志', bridge.includes('上下文折叠：${result.compact.dropped}'));
  const loop = read('src/qqb/engine/loop.mjs');
  ok('loop 引 foldHistory', loop.includes("import { foldHistory } from './compact.mjs'"));
  ok('loop 按预算折叠', loop.includes('historyBudgetTokens') && loop.includes('historyKeepRecent'));
  ok('run() 返回 compact 信息', (loop.match(/compact: compactInfo/g) ?? []).length >= 4);
}

console.log('审计清单：');
{
  const audit = read('scripts/test-audit.mjs');
  ok('清单收了 levels', audit.includes("'test-qqb-memory-levels.mjs'"));
  ok('清单收了 consolidate', audit.includes("'test-qqb-consolidate.mjs'"));
  const pkg = JSON.parse(read('package.json'));
  ok('package.json 有 levels 脚本', typeof pkg.scripts['test:qqb-memory-levels'] === 'string');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);