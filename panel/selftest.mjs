// 最小自测：用假 document 只验证 esc()、时间格式化、hash 解析。
// 运行：node panel/selftest.mjs（不联网、不读数据库、不需要 jsdom）
const fake = {
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }),
  body: { classList: { add() {}, remove() {} } },
};
globalThis.document = fake;
globalThis.window = { location: { hash: '', origin: 'http://127.0.0.1:3100' }, addEventListener() {}, scrollTo() {} };

const { esc, timeAgo, fullTime, parseHash } = await import('./app.js');

let passed = 0;
const failures = [];

function eq(actual, expected, label) {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failures.push(`${label}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`);
}

// ---- 1. esc() ----
eq(esc('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;', 'esc 转义 HTML 特殊字符');
eq(esc('`'), '&#96;', 'esc 转义反引号');
eq(esc('小鲸 <鲸鱼>'), '小鲸 &lt;鲸鱼&gt;', 'esc 保留中文、转义尖括号');
eq(esc(null), '', 'esc(null) 为空串');
eq(esc(undefined), '', 'esc(undefined) 为空串');
eq(esc(0), '0', 'esc(0) 保留零');
eq(esc(false), 'false', 'esc(false) 保留布尔');

// ---- 2. 时间格式化 ----
const now = new Date(2026, 9, 29, 12, 0, 0).getTime();
eq(timeAgo(now - 30 * 1000, now), '刚刚', 'timeAgo 30 秒内 → 刚刚');
eq(timeAgo(now - 5 * 60 * 1000, now), '5 分钟前', 'timeAgo 5 分钟前');
eq(timeAgo(now - 3 * 60 * 60 * 1000, now), '3 小时前', 'timeAgo 3 小时前');
eq(timeAgo(now - 25 * 60 * 60 * 1000, now), '昨天', 'timeAgo 跨自然日 → 昨天');
eq(timeAgo(now - 3 * 24 * 60 * 60 * 1000, now), '3 天前', 'timeAgo 3 天前');
eq(timeAgo('不是时间', now), '—', 'timeAgo 非法输入 → 破折号');
eq(fullTime(new Date(2026, 0, 2, 3, 4, 5).getTime()), '2026-01-02 03:04', 'fullTime 补零格式');
eq(fullTime('2026-10-29T08:09:10+08:00'), '2026-10-29 08:09', 'fullTime 解析 ISO 字符串');
eq(timeAgo('2026-10-29T11:00:00+08:00', now), '1 小时前', 'timeAgo 解析 ISO 字符串');

// ---- 3. hash 路由解析 ----
eq(parseHash('#memories'), 'memories', 'parseHash #memories');
eq(parseHash('diaries'), 'diaries', 'parseHash 无井号');
eq(parseHash('#persona?x=1'), 'persona', 'parseHash 带查询串');
eq(parseHash('#GALLERY'), 'gallery', 'parseHash 大小写归一');
eq(parseHash(''), 'memories', 'parseHash 空 → 默认记忆库');
eq(parseHash('#nope'), 'memories', 'parseHash 未知 Tab → 默认记忆库');
eq(parseHash(null), 'memories', 'parseHash null → 默认记忆库');
eq(parseHash('#people/'), 'people', 'parseHash 尾斜杠');

// ---- 输出 ----
for (const f of failures) console.error(`not ok - ${f}`);
console.log(`# selftest: ${passed} 项断言通过，${failures.length} 项失败`);
if (failures.length) process.exit(1);
console.log('# 三组纯函数（esc / 时间格式化 / hash 路由）全部通过');