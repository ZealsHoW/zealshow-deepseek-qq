// 记忆巩固 / 做梦（src/qqb/memory/consolidate.mjs）的纯逻辑回归：
//   prompt 组装、JSON 容错解析、写库字段清洗、做梦落盘。模型用假的，不联网。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildConsolidateMessages,
  buildDreamMessages,
  parseConsolidation,
  extractJson,
  createConsolidator,
} from '../src/qqb/memory/consolidate.mjs';

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
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-consolidate-'));

console.log('记忆巩固：');
{
  const records = [
    { senderName: '爸爸', text: '今天带你去吃火锅' },
    { senderName: '小鲸', text: '真的吗！不过你上次也这么说然后去加班了' },
    { senderName: '爸爸', text: '这次真的，七点' },
  ];
  const { messages, lineCount } = buildConsolidateMessages({ key: 'private:10001', date: '2026-10-29', records });
  eq('消息两条：system + user', messages.length, 2);
  ok('system 里要求写画面不写总结', messages[0].content.includes('禁止写「主人没理我」这种摘要'));
  ok('user 带会话与日期', messages[1].content.includes('private:10001') && messages[1].content.includes('2026-10-29'));
  ok('记录带行号', messages[1].content.includes('[1] 爸爸: 今天带你去吃火锅'));
  eq('行数统计', lineCount, 3);
}
{
  const { messages } = buildConsolidateMessages({
    key: 'k',
    date: 'd',
    records: [{ senderName: 'a', text: 'x'.repeat(500) }],
    maxChars: 100,
  });
  ok('超长输入被截断在 maxChars 内', messages[1].content.length < 300);
}
{
  // 2026-10-29：真实历史记录的正文键是 `x`，且夜间只该复盘当天的话。
  const records = [
    { senderName: '爸爸', x: '昨天的旧事', t: new Date('2026-10-27T21:00:00+08:00').getTime() },
    { senderName: '爸爸', x: '今天吃火锅', t: new Date('2026-10-29T12:00:00+08:00').getTime() },
    { senderName: '小鲸', x: '好耶', t: new Date('2026-10-29T12:01:00+08:00').getTime() },
  ];
  const { messages, lineCount } = buildConsolidateMessages({ key: 'k', date: '2026-10-29', records });
  eq('x 键的正文能进提示词', lineCount, 2);
  ok('只取当天的记录', !messages[1].content.includes('昨天的旧事') && messages[1].content.includes('今天吃火锅'));
}
{
  eq('extractJson 直接对象', extractJson('{"a":1}'), { a: 1 });
  eq('extractJson 带 ```json 包裹', extractJson('前言\n```json\n{"a":2}\n```\n后记'), { a: 2 });
  eq('extractJson 前后有废话', extractJson('好的，结果如下 {"a":3} 完毕'), { a: 3 });
  eq('extractJson 没有 JSON', extractJson('没有'), null);
  // 2026-10-29：真实翻车现场——模型写了两段半 episode 就撞 maxTokens，整份 JSON 不合语法。
  const cut = extractJson('{"episodes":[{"title":"a","text":"b"},{"title":"c","text":"d');
  ok('extractJson 能救回被截断的 JSON', Array.isArray(cut?.episodes) && cut.episodes.length === 2);
  const cut2 = extractJson('{"episodes":[{"title":"a","sensory":"夜里很冷');
  ok('截断在字符串中间也能救', cut2?.episodes?.[0]?.sensory === '夜里很冷');
}
{
  const parsed = parseConsolidation(`\`\`\`json
  {
    "episodes": [
      {"title":"火锅约","text":"他说七点去吃火锅，我记着上次也这么说","emotion":"雀跃","sensory":"屏幕的光","subtext":"别再放我鸽子","importance":0.8,"evidence":"[3]"},
      {"title":"","text":"太短","emotion":"","sensory":"","subtext":"","importance":9}
    ],
    "facts": [
      {"text":"爸爸答应周三晚上七点带小鲸去吃火锅","kind":"promise","emotion":0.7,"importance":0.85},
      {"text":"","kind":"fact"}
    ],
    "cards": [
      {"card":"周三 爸爸约七点吃火锅 之前放过一次鸽子 当时雀跃又怕","emotion":"雀跃","for":"火锅约"}
    ]
  }
  \`\`\``);
  ok('解析成功', parsed.ok);
  eq('episode 数量', parsed.episodes.length, 1);
  ok('emotion 保留', parsed.episodes[0].emotion === '雀跃');
  ok('sensory/subtext 落位', parsed.episodes[0].sensory === '屏幕的光' && parsed.episodes[0].subtext === '别再放我鸽子');
  eq('importance 被夹到 1 以内', parsed.episodes[0].importance, 0.8);
  eq('空 fact 被丢掉', parsed.facts.length, 1);
  eq('非法 kind 回落 fact', parsed.facts[0].kind, 'promise');
  ok('卡片 ≤50 字', parsed.cards[0].card.length <= 50);
}
{
  const parsed = parseConsolidation('对不起我写不出来');
  ok('没有 JSON 时报错不抛', parsed.ok === false && typeof parsed.error === 'string');
}

console.log('做梦：');
{
  const { messages } = buildDreamMessages({ memories: [{ text: '雨夜他三个小时没回', emotion: '委屈' }] });
  ok('dream system 要荒诞隐喻', messages[0].content.includes('荒诞'));
  ok('记忆带情绪戳', messages[1].content.includes('委屈'));
}
{
  const root = tmp();
  const written = [];
  const store = {
    remember(entry) {
      written.push(entry);
      return { action: 'inserted', id: written.length };
    },
    recall() {
      return { items: [{ id: 1, text: '雨夜他没回消息' }, { id: 2, text: '一起吃火锅' }, { id: 3, text: '背单词' }, { id: 4, text: '唱歌' }] };
    },
  };
  const model = {
    async complete({ purpose }) {
      if (purpose === 'memory-dream') return { text: '我梦见天花板上有鲸鱼在游，雨从下往上落，我一直在等一条消息。' };
      return {
        text: JSON.stringify({
          episodes: [{ title: '等待', text: '他三个小时没回，我盯着屏幕', emotion: '委屈', sensory: '夜里的冷风', subtext: '是不是不想理我', importance: 0.7 }],
          facts: [{ text: '他雨夜三个小时没回小鲸消息', kind: 'event', emotion: 0.6, importance: 0.6 }],
          cards: [{ card: '雨夜 他三小时没回 我等到心慌 委屈', emotion: '委屈', for: '等待' }],
        }),
      };
    },
  };
  const c = createConsolidator({ root, store, model, now: () => Date.parse('2026-10-29T13:05:00+08:00') });
  const r = await c.consolidate({ key: 'private:1', date: '2026-10-29', records: [{ senderName: 'a', text: '1' }, { senderName: 'b', text: '2' }, { senderName: 'a', text: '3' }, { senderName: 'b', text: '4' }] });
  ok('巩固成功', r.ok && r.episodes === 1 && r.facts === 1 && r.cards === 1, JSON.stringify(r));
  eq('写库三条', written.length, 3);
  ok('片段带 sensory', written[0].sensory === '夜里的冷风');
  ok('片段 source=consolidate', written[0].source === 'consolidate');
  eq('卡片 kind=card', written[2].kind, 'card');

  const d = await c.dream({ scope: 'private:1', date: '2026-10-29' });
  ok('做梦成功', d.ok && d.text.includes('鲸鱼'), JSON.stringify(d));
  const diary = fs.readFileSync(path.join(root, 'state', 'diary', '2026-10-29.md'), 'utf8');
  ok('梦境写进当天日记', diary.includes('做梦'));
  ok('日记带头行', diary.startsWith('# 2026-10-29'));
  const dreamEntry = written.find((w) => w.kind === 'diary');
  ok('梦中条目 kind=diary 且 meta.kind=dream', dreamEntry && dreamEntry.meta.kind === 'dream');
  const second = await c.dream({ scope: 'private:1', date: '2026-10-29' });
  ok('同一天再做梦不报错', second.ok === true);
}
{
  const root = tmp();
  const c = createConsolidator({ root, store: null, model: null });
  const r = await c.consolidate({ key: 'k' });
  ok('没有库时返回错误不抛', r.ok === false && Boolean(r.error));
  const d = await c.dream({});
  ok('没有库时做梦也返回错误', d.ok === false);
}
{
  const root = tmp();
  const store = { remember: () => ({ action: 'inserted' }), recall: () => ({ items: [] }) };
  let calls = 0;
  const model = { async complete() { calls += 1; return { text: '{"episodes":[],"facts":[],"cards":[]}' }; } };
  const c = createConsolidator({ root, store, model });
  const r = await c.consolidate({ key: 'k', records: [{ text: 'a' }, { text: 'b' }] });
  ok('记录太少时跳过且不调模型', r.ok === true && r.skipped && calls === 0);
}

console.log('接线：');
{
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  ok('bridge.js 导入了 createConsolidator', bridge.includes("from './qqb/memory/consolidate.mjs'"));
  ok('有 consolidateNow 封装', /async function consolidateNow\(/.test(bridge));
  ok('有 POST /api/socialV2/consolidate 路由', bridge.includes("'/api/socialV2/consolidate'"));
  ok('睡前 10 分钟起巩固定时器', bridge.includes('10 * 60_000') && bridge.includes('consolidateNow({ key: k, dream: true })'));
  ok('巩固失败只 log 不抛', bridge.includes('巩固失败（不影响其它功能）'));
  ok('成了会写一行日志（片段/事实/卡片）', bridge.includes('片段 ${c?.episodes ?? 0}'));
  const harness = fs.readFileSync(new URL('../scripts/audit-bridge-harness.mjs', import.meta.url), 'utf8');
  ok('audit 夹具补了 createConsolidator 桩', harness.includes('function createConsolidator()') && harness.includes('createConsolidator,'));
  const audit = fs.readFileSync(new URL('../scripts/test-audit.mjs', import.meta.url), 'utf8');
  ok('audit 清单收了本测试', audit.includes("'test-qqb-consolidate.mjs'"));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  ok('package.json 有 test:qqb-consolidate', typeof pkg.scripts['test:qqb-consolidate'] === 'string');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);