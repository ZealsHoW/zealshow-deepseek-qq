// 知识库 + 记忆库全文索引 + 日记→说说 的回归。
//
// 分两层：
//   ① 真 SQLite（临时目录，不碰 state/memory.db）：知识的增/查/合并、中文子串能否走 FTS、
//      索引丢了能不能自愈重建；
//   ② 源码接线：路由 / MCP 工具 / 工具开关 / 唤醒提示词 / `diaryRitual` 定时器是否都接上了。
//      这些在桥接单进程里跑，没法单独 import 一个函数出来测，只能钉住「这几处必须同时出现」——
//      少一处就会静默失效（比如漏了 TIMER_WAKE_REASONS，日记唤醒会被繁忙判定吞掉）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '../src/qqb/memory/store.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const MCP_SRC = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqb-know-${label}-`));
}

function clockAt(iso) {
  let ms = Date.parse(iso);
  return { now: () => ms, advance(deltaMs) { ms += deltaMs; return ms; } };
}

test('知识库：存进去能查出来，重复的合并而不是存两份', () => {
  const clock = clockAt('2026-10-24T10:00:00+08:00');
  const store = openStore({ root: tmpdir('add'), now: clock.now });
  try {
    const first = store.knowledge.add({
      scope: 'private:1000000001',
      title: '开源配音',
      text: 'github 上有个开源配音项目，能把文字转成很像人的声音',
      source: 'web',
      url: 'https://example.com/tts',
      tags: ['配音', '开源'],
      importance: 0.6,
    });
    assert.equal(first.action, 'inserted');
    clock.advance(60_000);
    const again = store.knowledge.add({
      scope: 'private:1000000001',
      text: 'github 上有个开源配音项目，能把文字转成很像人的声音',
      importance: 0.8,
    });
    assert.equal(again.action, 'merged');
    assert.equal(again.id, first.id);
    assert.equal(store.knowledge.stats().total, 1, '同一件事看到两遍只占一行');

    const hit = store.knowledge.search({ scope: 'private:1000000001', query: '配音' });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].title, '开源配音', '合并时保留原来的标题');
    assert.equal(hit[0].importance, 0.8, '合并取更高的 importance');
    assert.equal(hit[0].source, 'web', '已有来源不被空值覆盖');
    assert.deepEqual(hit[0].tags, ['配音', '开源']);
    assert.deepEqual(hit[0].url ? [hit[0].url] : [], ['https://example.com/tts']);
  } finally {
    store.close();
  }
});

test('知识库：别的 scope 查不到（私聊知识不外泄），global 谁都能查', () => {
  const clock = clockAt('2026-10-24T10:00:00+08:00');
  const store = openStore({ root: tmpdir('scope'), now: clock.now });
  try {
    store.knowledge.add({ scope: 'private:1000000001', text: '爸爸的电脑是 Windows 11' });
    store.knowledge.add({ scope: 'private:1000000002', text: '朋友在学吉他' });
    store.knowledge.add({ scope: 'global', text: 'Vite 的热更新默认监听 5173 端口' });

    assert.deepEqual(
      store.knowledge.search({ scope: 'private:1000000001', query: '' }).map((k) => k.text).sort(),
      ['Vite 的热更新默认监听 5173 端口', '爸爸的电脑是 Windows 11'],
    );
    assert.ok(store.knowledge.search({ scope: 'private:1000000002', query: 'Windows' }).length === 0,
      '另一个私聊里查不到别人那条');
    assert.equal(store.knowledge.search({ scope: 'group:900000001', query: 'Vite' }).length, 1,
      'global 知识在任何会话都能查到');
    assert.equal(store.knowledge.search({ scope: 'private:1000000001', query: 'Vite', includeGlobal: false }).length, 0,
      'includeGlobal:false 时只查自己 scope');
  } finally {
    store.close();
  }
});

test('知识库：中文子串（≥3 字）走 FTS，2 字自动回落模糊匹配', () => {
  const clock = clockAt('2026-10-24T10:00:00+08:00');
  const store = openStore({ root: tmpdir('fts'), now: clock.now });
  try {
    store.knowledge.add({ scope: 'private:1', text: '大肥鱼这个博主在讲开源 TTS 工具，语速特别快' });
    store.knowledge.add({ scope: 'private:1', text: '晚上下雨了，窗外的路灯把雨照成一条一条的' });

    // 4 字 → trigram FTS 能命中文中任意子串（不是从头匹配）
    assert.equal(store.knowledge.search({ scope: 'private:1', query: '开源 TTS' }).length >= 1, true);
    assert.equal(store.knowledge.search({ scope: 'private:1', query: '肥鱼这个' }).length, 1, '子串在词中间也要命中');
    // 2 字 → 索引不支持，回落 LIKE，同样要能查到
    assert.equal(store.knowledge.search({ scope: 'private:1', query: '语速' }).length, 1);
    assert.equal(store.knowledge.search({ scope: 'private:1', query: '路灯' }).length, 1);
    // 查不到的别乱给
    assert.equal(store.knowledge.search({ scope: 'private:1', query: '量子计算机' }).length, 0);
    // 标点/英文大小写混着输也不该把 FTS 语法搞崩（" OR " 这种会被引号包住）
    assert.doesNotThrow(() => store.knowledge.search({ scope: 'private:1', query: 'TTS OR 下雨' }));
  } finally {
    store.close();
  }
});

test('记忆库：索引行被删掉后重开能自愈重建（不会从此查不到）', () => {
  const dir = tmpdir('rebuild');
  const clock = clockAt('2026-10-24T10:00:00+08:00');
  const first = openStore({ root: dir, now: clock.now });
  try {
    first.remember({ layer: 'private', scope: 'private:1', kind: 'fact', text: '爸爸喜欢喝无糖可乐' });
    first.remember({ layer: 'private', scope: 'private:1', kind: 'event', text: '昨天一起去看了海' });
    assert.equal(first.recall({ scope: 'private:1', query: '无糖可乐' }).length, 1);
  } finally {
    first.close();
  }

  // 模拟「老库升级上来时还没有 FTS」：把索引表连触发器一起删掉，memories 内容表不动。
  // （不能对外部内容表直接 DELETE / delete-all，那会把索引写成坏图——这也是真机上
  //  修索引只能靠 'rebuild' 的原因。）
  const raw = new DatabaseSync(path.join(dir, 'state', 'memory.db'));
  try {
    raw.exec(`
      DROP TRIGGER IF EXISTS memories_fts_ai;
      DROP TRIGGER IF EXISTS memories_fts_ad;
      DROP TRIGGER IF EXISTS memories_fts_au;
      DROP TABLE IF EXISTS memories_fts;
    `);
  } finally {
    raw.close();
  }

  const again = openStore({ root: dir, now: clock.now });
  try {
    assert.equal(again.recall({ scope: 'private:1', query: '无糖可乐' }).length, 1, '重开时按行数差 rebuild，索引自己回来');
    assert.equal(again.recall({ scope: 'private:1', query: '看了海' }).length, 1);
  } finally {
    again.close();
  }
});

test('接线：知识/记忆检索的路由、MCP 工具、工具开关都在', () => {
  for (const route of ['/api/socialV2/memory-search', '/api/socialV2/knowledge-add', '/api/socialV2/knowledge-search']) {
    assert.ok(BRIDGE_SRC.includes(`url.pathname === '${route}'`), `${route} 路由缺失`);
  }
  assert.ok(BRIDGE_SRC.includes("v2ToolEnabled('knowledge')"), '知识库路由要过 knowledge 开关');
  assert.ok(BRIDGE_SRC.includes("v2ToolEnabled('memory')"), '记忆检索要过 memory 开关');
  assert.ok(BRIDGE_SRC.includes('store.knowledge.add('), '知识入库要落库');
  assert.ok(BRIDGE_SRC.includes('store.knowledge.search('), '知识检索要落库');

  for (const tool of ['qq_memory_search', 'qq_knowledge_add', 'qq_knowledge_search']) {
    assert.ok(MCP_SRC.includes(`'${tool}'`), `${tool} 没注册`);
    assert.ok(MCP_SRC.includes(`${tool}:`), `${tool} 没在 TOOL_CONFIG_FLAGS 里`);
  }
  assert.ok(/qq_memory_search:\s*'memory'/.test(MCP_SRC));
  assert.ok(/qq_knowledge_add:\s*'knowledge'/.test(MCP_SRC));
  assert.ok(/qq_knowledge_search:\s*'knowledge'/.test(MCP_SRC));

  // 默认开关 + 能力表（qq_get_prompt 里要列出来，她才知道有这两个工具）
  assert.ok(/knowledge:\s*true/.test(BRIDGE_SRC), 'knowledge 工具默认开关缺失');
  assert.ok(BRIDGE_SRC.includes("knowledge: 'qq_knowledge_add / qq_knowledge_search'"));
  assert.ok(BRIDGE_SRC.includes('qq_memory_search / qq_memory_remove'), 'memory 能力表没补 qq_memory_search');
});

test('接线：记忆是共用的（跨会话检索 + 人名簿标注来源）', () => {
  // 路由：默认查全库，显式传 scope 才收窄；每条带 people.label() 出来的来源。
  assert.ok(BRIDGE_SRC.includes("const crossScope = !scopeParam || scopeParam === 'all' || scopeParam === '*'"));
  assert.ok(BRIDGE_SRC.includes('allScopes: crossScope'), 'memory-search 要把 crossScope 传给 recall');
  assert.ok(BRIDGE_SRC.includes('where: people.label(item.scope)'), '检索结果要标来源');
  assert.ok(BRIDGE_SRC.includes("scopeParam === 'self' ? key : scopeParam"), "scope=self 要落回当前会话");
  // 人名簿：提示词里列「我认识谁」、私聊来消息时顺手记名字。
  assert.ok(BRIDGE_SRC.includes('function peoplePromptText('));
  assert.ok(BRIDGE_SRC.includes('peoplePromptText(),'), '人名簿没进 buildEnginePrompts');
  assert.ok(BRIDGE_SRC.includes("if (String(key).startsWith('private:')) people.remember(key, sender);"));
  assert.ok(BRIDGE_SRC.includes('async function seedPeopleFromGateway('), '人名簿要从网关同步名字');
  // MCP 工具：能指定 scope，并把来源念出来。
  assert.ok(/scope: z\.string\(\)\.optional\(\)\.describe\(/.test(MCP_SRC), 'qq_memory_search 缺 scope 参数');
  assert.ok(MCP_SRC.includes('（来自：${it.where}）'), '工具输出要带来源');
  assert.ok(MCP_SRC.includes('data?.crossScope'), '跨会话查的结果要标一下');
  // 铁律里要教她「记忆是共用的、说不说由自己定」。
  assert.ok(BRIDGE_SRC.includes('【记忆是共用的】'));
  // 排障口：DSH 那条有 /prompt，直连引擎那条也要能看到提示词（否则只能真机跑一轮反推）。
  assert.ok(/url\.pathname === '\/api\/socialV2\/engine-prompt'/.test(BRIDGE_SRC), '缺 engine-prompt 调试路由');
  assert.ok(BRIDGE_SRC.includes('enginePromptsOf(epKey, epReason)'), 'engine-prompt 要按 key/reason 取提示词');
});

test('接线：唤醒提示词里有知识库最近几条 + 检索指引', () => {
  assert.ok(BRIDGE_SRC.includes('function knowledgeRecentText('), 'knowledgeRecentText 缺失');
  assert.ok(BRIDGE_SRC.includes('store.knowledge.recent({ scope: key, limit })'));
  assert.ok(BRIDGE_SRC.includes('const knowledgeText = knowledgeRecentText(key'));
  assert.ok(BRIDGE_SRC.includes('你最近记进知识库的东西'));
  assert.ok(BRIDGE_SRC.includes('qq_memory_search(query="...")'));
  assert.ok(BRIDGE_SRC.includes('qq_knowledge_add(text="...")'));
  // 读库失败不能把整次唤醒带挂：函数体里必须有兜底 return ''
  const fn = BRIDGE_SRC.slice(BRIDGE_SRC.indexOf('function knowledgeRecentText('));
  assert.ok(fn.slice(0, 1200).includes("return ''"));
});

test('接线：日记 → 说说 的定时唤醒与提示词', () => {
  // 唤醒原因要同时进优先级表和「定时唤醒」集合，否则繁忙时会被静默吞掉。
  assert.ok(/diaryRitual:\s*\d+/.test(BRIDGE_SRC), 'WAKE_PRIORITY 里没有 diaryRitual');
  const timerSet = BRIDGE_SRC.slice(BRIDGE_SRC.indexOf('const TIMER_WAKE_REASONS'), BRIDGE_SRC.indexOf('const TIMER_WAKE_REASONS') + 300);
  assert.ok(timerSet.includes("'diaryRitual'"), 'TIMER_WAKE_REASONS 里没有 diaryRitual');

  assert.ok(BRIDGE_SRC.includes('function startDiaryPublish('));
  assert.ok(BRIDGE_SRC.includes('startDiaryPublish();'), '启动时没调用 startDiaryPublish');
  assert.ok(BRIDGE_SRC.includes('function diaryPublishCfg('));
  assert.ok(BRIDGE_SRC.includes('function diaryPublishKeys('));
  assert.ok(BRIDGE_SRC.includes('function diaryWrittenSince('));
  assert.ok(BRIDGE_SRC.includes('function diaryDigestText('));
  assert.ok(BRIDGE_SRC.includes("scheduleWakeV2(key, 'diaryRitual')"));

  // 默认关（外发动作要主人显式打开）、默认时间要早于「晚安休眠」
  assert.ok(BRIDGE_SRC.includes('enabled: p.enabled === true'));
  assert.ok(BRIDGE_SRC.includes("'20:30'"));

  // 提示词分支：给她素材 + 让她自己写日记、自己发说说。
  //
  // 2026-10-24 真机踩到过：这段只写在 buildWakePromptV2（DSH 那条路）里，而线上跑的是直连引擎
  // （buildEnginePrompts）—— 它的定时唤醒当时只认 browse / proactiveCheck，diaryRitual 落到空分支，
  // 她只看到「唤醒原因：diaryRitual」，当成普通聊天回了三句话、一个工具没调（日志 `工具：无`）。
  // 所以现在抽成 diaryRitualPromptText()，并断言**两条路都真的用了它**。
  const ritual = BRIDGE_SRC.slice(BRIDGE_SRC.indexOf('function diaryRitualPromptText('));
  const body = ritual.slice(0, 1800);
  assert.ok(ritual && ritual.length > 100, '没有 diaryRitualPromptText()');
  assert.ok(body.includes('qq_diary_write(text="...")'));
  assert.ok(body.includes('qq_post_qzone(content="...", visibility='));
  assert.ok(body.includes('记忆库里'));
  assert.ok(body.includes('知识库里'));
  assert.ok((BRIDGE_SRC.match(/diaryRitualPromptText\(key\)/g) || []).length >= 2,
    'diaryRitualPromptText 没有同时被 DSH 与直连引擎两条提示词路径用上');
  assert.ok((BRIDGE_SRC.match(/reason === 'diaryRitual'/g) || []).length >= 2,
    '只有一条提示词路径认识 diaryRitual');
});

test('接线：日记只叫一个会话（日记文件是全局每天一份）', () => {
  // 多叫就会同一件事写三遍、说说也发三条 —— 这条写死，改的时候必须显式改测试。
  assert.ok(BRIDGE_SRC.includes('nightRitual?.parents'));
  assert.ok(BRIDGE_SRC.includes('private:${Number(s)}'));
  assert.ok(BRIDGE_SRC.includes('attempts >= 4'), '同一天的重试上限');
});