/**
 * 白名单「按用户名规则自动纳入」的纯逻辑层（配置解析 / 规则匹配 / 限流预算）。
 *
 * 背景（主人 2026-10-23 提的第①条）：每加一个能跟小鲸鱼说话的人，都要手工把 QQ 号
 * 填进 config.json 的 allow.private。想要的是「写一条规则，命中的人自己进来」——
 * 例如「QQ 号 2998647358」或「昵称叫小鲸的」。
 *
 * ⚠️ **昵称是可以随便改的**，按昵称放行 = 任何人都能把自己的昵称改成规则里的名字混进来。
 * 所以这里做三件事兜底，缺一不可：
 *   1. 默认**关着**：必须显式 `enabled: true`（或直接把规则写成数组，见下）才会生效；
 *   2. `deny` 永远优先：黑名单里的人绝不会被自动纳入；
 *   3. 限流：一小时最多自动纳入 `maxAddsPerHour`（默认 5）个，防止一串伪造昵称把白名单刷爆。
 * 真正安全的做法仍然是写 QQ 号（`{"qq": 2998647358}`），昵称规则只当"顺手"用。
 *
 * 配置写法（config.json 的 allow 段里）：
 *   "allow": {
 *     "private": [376245695],
 *     "groups": [851489980],
 *     "autoInclude": {
 *       "enabled": true,
 *       "maxAddsPerHour": 5,
 *       "rules": [
 *         { "qq": 2998647358, "note": "小鲸鱼测试号" },
 *         { "name": "小鲸", "note": "按昵称——可被冒充，慎用" },
 *         { "namePattern": "^小鲸", "kind": "private" }
 *       ]
 *     }
 *   }
 * 也可以偷懒直接写数组（等价于 `{enabled: true, rules: [...]}`）：
 *   "autoInclude": [2998647358, "小鲸"]
 * 数组里的纯数字 → 按 QQ 号；其余字符串 → 按昵称精确匹配。
 *
 * 规则字段：
 *   qq          QQ 号（私聊=对方号，群聊=群号）
 *   name        昵称/群名片**精确**匹配（忽略大小写与首尾空白）
 *   namePattern 昵称正则（只对私聊有意义：群聊事件里的 sender 是群成员，不是群名）
 *   kind        private / group / any（默认 any）
 *   note        备注，只出现在日志里
 *
 * 这一层不碰文件、不碰网络：写盘与热更新在 src/bridge.js 的 tryAutoInclude() 里，
 * 这样规则匹配可以被 scripts/test-allow-rules.mjs 直接单测。
 */

/** 一小时最多自动纳入几个（默认值，可被配置覆盖） */
export const DEFAULT_AUTO_INCLUDE_MAX_ADDS_PER_HOUR = 5;

/** 限流窗口 */
export const AUTO_INCLUDE_WINDOW_MS = 60 * 60 * 1000;

const KINDS = new Set(['private', 'group', 'any']);

function str(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** 纯数字串 → 归一化后的 QQ 号字符串；不是纯数字返回 null */
function digits(value) {
  const s = str(value);
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : null;
}

/**
 * 把配置里的 autoInclude 段归一化成 `{ enabled, rules, maxAddsPerHour }`。
 *
 * 容错口径（跟插件配置一个路子）：写错的地方不抛异常，而是留下痕迹——
 * 坏正则的规则会被剔掉（`autoIncludeProblems()` 能列出原因），
 * 因为「一条正则写错」绝不该让整份配置加载失败、桥接起不来。
 */
export function autoIncludeSettings(raw) {
  const bare = Array.isArray(raw);
  const src = bare ? { enabled: true, rules: raw } : (raw && typeof raw === 'object' ? raw : {});
  const list = bare
    ? raw
    : (Array.isArray(src.rules) ? src.rules
      : Array.isArray(src.private) ? src.private
        : Array.isArray(src.qq) ? src.qq
          : []);
  const rules = [];
  for (const entry of list) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === 'string' || typeof entry === 'number') {
      const qq = digits(entry);
      const raw = str(entry);
      // 空白项直接丢：它既不是 QQ 号也不是昵称，留着只会让"第 N 条规则"的编号对不上。
      if (!qq && !raw) continue;
      // 数字 / 纯数字串按 QQ 号，其余按昵称——省得写对象，"小鲸" 也能直接用。
      rules.push(qq
        ? { qq, name: '', namePattern: '', regex: null, regexError: '', kind: 'any', note: '' }
        : { qq: '', name: raw, namePattern: '', regex: null, regexError: '', kind: 'any', note: '' });
      continue;
    }
    if (typeof entry !== 'object') continue;
    const qq = digits(entry.qq);
    const name = str(entry.name);
    const namePattern = str(entry.namePattern ?? entry.nameRegex ?? entry.pattern);
    let regex = null;
    let regexError = '';
    if (namePattern) {
      try { regex = new RegExp(namePattern); } catch (error) { regexError = String(error?.message ?? error); }
    }
    const kind = KINDS.has(str(entry.kind)) ? str(entry.kind) : 'any';
    // 写坏的正则保留原文（regexError 记原因）：体检要能指着它说"第 N 条写错了"，
    // 而不是把规则悄悄丢掉、让人对着配置发愣。
    rules.push({ qq: qq ?? '', name, namePattern, regex, regexError, kind, note: str(entry.note) });
  }
  const max = Number(src.maxAddsPerHour ?? src.maxAdds ?? DEFAULT_AUTO_INCLUDE_MAX_ADDS_PER_HOUR);
  return {
    enabled: src.enabled === true,
    rules,
    maxAddsPerHour: Number.isFinite(max) && max >= 0 ? Math.floor(max) : DEFAULT_AUTO_INCLUDE_MAX_ADDS_PER_HOUR
  };
}

/**
 * 配置体检：返回人类可读的问题清单（空数组 = 没毛病）。
 * 启动时会打出来——规则写得不对却静默不生效，是最难查的那种问题。
 */
export function autoIncludeProblems(settings) {
  const problems = [];
  if (!settings?.enabled) return problems;
  if (settings.rules.length === 0) problems.push('autoInclude.enabled=true 但一条规则都没有（qq / name / namePattern 至少要有一个）');
  settings.rules.forEach((rule, i) => {
    const hasQq = !!rule.qq;
    const hasName = !!rule.name;
    // 写了 namePattern 但正则编不出来，也算"写了东西"——否则会被错报成「什么都没写」。
    const hasPattern = !!rule.namePattern;
    if (!hasQq && !hasName && !hasPattern) {
      problems.push(`第 ${i + 1} 条规则什么都没写（需要 qq / name / namePattern 之一）`);
      return;
    }
    if (rule.namePattern && !rule.regex) problems.push(`第 ${i + 1} 条规则的 namePattern 不是合法正则：${rule.namePattern}（${rule.regexError || '编译失败'}）`);
    if (hasName || hasPattern) {
      problems.push(`第 ${i + 1} 条规则按昵称放行${hasQq ? '（同时也写了 qq，那条不受影响）' : ''}：昵称可以随便改，任何人都能冒充这个名字进来，建议改成 qq${hasPattern ? '；正则尤其危险' : ''}`);
    }
  });
  if (settings.maxAddsPerHour === 0) problems.push('autoInclude.maxAddsPerHour=0：规则永远不会生效');
  return problems;
}

/**
 * 规则匹配。
 *
 * @param {{ kind?: 'private'|'group', id?: string|number, name?: string, card?: string }} peer
 * @param {ReturnType<typeof autoIncludeSettings>} settings
 * @returns {{ index: number, rule: object, why: string } | null}
 */
export function matchAutoInclude(peer, settings) {
  if (!settings?.enabled || settings.rules.length === 0) return null;
  const kind = peer?.kind === 'group' ? 'group' : 'private';
  const id = str(peer?.id);
  // 私聊看昵称；群聊的 sender 是群成员、不是群名，所以群聊只有 qq（群号）这一条路。
  const names = kind === 'group'
    ? []
    : [str(peer?.name), str(peer?.card)].filter(Boolean);
  for (let index = 0; index < settings.rules.length; index += 1) {
    const rule = settings.rules[index];
    if (rule.kind !== 'any' && rule.kind !== kind) continue;
    if (rule.qq && rule.qq === id) return { index, rule, why: `${kind === 'group' ? '群号' : 'QQ 号'} ${id}` };
    if (kind === 'group') continue;
    if (rule.name) {
      const hit = names.find((n) => n.toLowerCase() === rule.name.toLowerCase());
      if (hit) return { index, rule, why: `昵称「${hit}」` };
    }
    if (rule.regex) {
      const hit = names.find((n) => rule.regex.test(n));
      if (hit) return { index, rule, why: `昵称「${hit}」命中正则 /${rule.namePattern}/` };
    }
  }
  return null;
}

/**
 * 限流预算：把时间戳列表裁到窗口内，并判断现在还能不能再纳入一个。
 *
 * @param {number[]} adds 已自动纳入的时间戳（会被就地裁剪，只保留窗口内的）
 * @param {{ now?: number, maxPerHour?: number }} options
 * @returns {{ ok: boolean, count: number, max: number }}
 */
export function autoIncludeBudget(adds, { now = Date.now(), maxPerHour = DEFAULT_AUTO_INCLUDE_MAX_ADDS_PER_HOUR } = {}) {
  const list = Array.isArray(adds) ? adds : [];
  const cutoff = now - AUTO_INCLUDE_WINDOW_MS;
  let write = 0;
  for (let read = 0; read < list.length; read += 1) {
    const ts = Number(list[read]);
    if (Number.isFinite(ts) && ts > cutoff) {
      list[write] = ts;
      write += 1;
    }
  }
  list.length = write;
  return { ok: write < maxPerHour, count: write, max: maxPerHour };
}

/** 一句话描述规则（日志与体检都用它） */
export function describeAutoIncludeRule(rule, index = 0) {
  if (!rule) return '（空规则）';
  const bits = [];
  if (rule.qq) bits.push(`qq=${rule.qq}`);
  if (rule.name) bits.push(`name=${rule.name}`);
  if (rule.namePattern) bits.push(`namePattern=/${rule.namePattern}/`);
  if (rule.kind && rule.kind !== 'any') bits.push(`kind=${rule.kind}`);
  if (rule.note) bits.push(`note=${rule.note}`);
  return `#${index + 1} ${bits.join(' ') || '（空规则）'}`;
}