// 人员梯队：**第一梯队 = 家里人**（主人 + 家里人名单），其他人的事往后排。
//
// 为什么要单独一个模块：梯队这件事有两个作用面，而且两面的判定口径**不一样**，混在一起必然出错：
//   ① 优先与频次（.sessionTierOf）：按**会话/频道**算 —— 跟爸爸妈妈的私聊、家庭群属于第一梯队，
//      主动机会排得更早更勤、被唤醒时优先级更高；
//   ② 敏感动作权限（.resolveRequester + .checkSensitive）：按**人**算 —— 是"谁"在让她做这件事。
//      私聊就是对方本人；群聊取最近一条别人说的话。发图/发语音/发说说这类只对第一梯队做。
//      **但她自己起的头不算"别人让她做"**：自由时间里想发图/发说说（allowSelfInitiated）放行。
// 反例（写下来免得以后又有人合并这两条）：家庭群里**群友**让她发图 → 频道是第一梯队，但请求人是群友，
// 必须拒绝；反过来，爸爸在**别的群**里让她发图 → 频道不是第一梯队，但请求人是家里人，应当允许。
//
// 纯函数模块：不读文件、不看时钟、不碰网络 —— 规则本身可以被回归逐条钉住。

export const TIER_FIRST = 0;
export const TIER_OTHERS = 1;

// 敏感动作默认清单（用 MCP 工具名，两个进程口径一致）。
// 入选理由都是"发出去/存下来就收不回"或"会动本机文件"：发图、发语音、发说说（对外可见）、
// 网页截图与存图（落盘 + 可能带到隐私画面）。文字与表情包不在此列 —— 那是她日常说话的方式。
export const DEFAULT_SENSITIVE_TOOLS = [
  'qq_send_image',
  'qq_send_voice',
  'qq_post_qzone',
  'qq_web_screenshot',
  'qq_save_image'
];

// 号码过滤只认「非空且全是数字」：位数不在这里判断。
// 教训：早先写成 /^\d{5,}$/ 想顺手滤掉占位值，结果 config 里真写了第一梯队的人也被静默丢掉——
// 「配置里是第一梯队、代码里当外人」这种静默失败比放宽更危险。QQ 号位数由 QQ 自己保证，这里不管。
const isNumberLike = (s) => /^\d+$/.test(s);

/** 家里人号码集合：主人 + nightRitual.parents + socialV2.tiers.first（去重，统一按字符串比）。 */
export function firstTierNumbers(cfg = {}) {
  const out = new Set();
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (isNumberLike(s)) out.add(s);
  };
  push(cfg?.ownerQQ);
  for (const q of cfg?.socialV2?.nightRitual?.parents ?? []) push(q);
  for (const q of cfg?.socialV2?.tiers?.first ?? []) push(q);
  return out;
}

/** 某个号码属于第几梯队（0 第一梯队 / 1 其他人）。数字、字符串都收。 */
export function tierOf(qq, cfg = {}, first = null) {
  const set = first ?? firstTierNumbers(cfg);
  const s = String(qq ?? '').trim();
  return s && set.has(s) ? TIER_FIRST : TIER_OTHERS;
}

export function tierLabel(tier) {
  return tier === TIER_FIRST ? '第一梯队（家里人）' : '其他人';
}

/** 总开关：`socialV2.tiers.enabled === false` 时梯队不生效（回到"谁都能使唤她"的老行为）。 */
export function tiersEnabled(cfg = {}) {
  return cfg?.socialV2?.tiers?.enabled !== false;
}

/**
 * 群主也算「信得过的人」：`socialV2.tiers.allowGroupOwner`（默认 true）。
 * 来由：主人在「大鲸鱼」那个群里说"只有群主或家里人在群里求才允许"——
 * 群主是自己建群/管群的人，跟家里人在同一档；陌生人（含自称亲戚的）仍然一律拒绝。
 * 群主是谁由调用方查（OneBot `get_group_member_list` 里 role==='owner'），本模块只管规则。
 */
export function groupOwnerAllowed(cfg = {}) {
  return cfg?.socialV2?.tiers?.allowGroupOwner !== false;
}

/**
 * 她自己起的头（自由时间里想发图、发说说）：`socialV2.tiers.allowSelfInitiated`。
 * 默认 **false**：这是"放宽"的一侧，公开仓库里别人的部署不该被悄悄改口径，要显式打开。
 *
 * 为什么不能只靠 resolveRequester 区分：私聊里 resolveRequester **永远**把对方当请求人
 * （source='peer'），所以"她自己在私聊里想发张图"和"私聊里的人让她发张图"看起来一模一样。
 * 真正能区分的是**唤醒原因**：下面是"没人让她做、是她自己安排的一段时间"的那几种。
 *   - browse：自己刷一会儿（社交浏览）
 *   - proactiveCheck：主动找话题（没人开口，她自己想说话）
 * 刻意**不**包含 timeout（睡醒/等待到期）与 replyCheck：那两种常是"隔着一段时间的答复"，
 * 可能是别人先开口、她睡了一觉才回 —— 当成自助会变成绕过门禁的后门。
 * 另外还要求"没人在等她回话"（见 checkSensitive 里的 lastIncomingAt/lastAiReplyAt 判定）。
 */
const SELF_INITIATED_WAKE_REASONS = new Set(['browse', 'proactiveCheck']);

export function isSelfInitiatedWake(reason) {
  return SELF_INITIATED_WAKE_REASONS.has(String(reason ?? '').trim());
}

export function selfInitiatedAllowed(cfg = {}) {
  return cfg?.socialV2?.tiers?.allowSelfInitiated === true;
}

export function sensitiveToolList(cfg = {}) {
  const custom = cfg?.socialV2?.tiers?.sensitiveTools;
  if (Array.isArray(custom)) return custom.map((s) => String(s).trim()).filter(Boolean);
  return [...DEFAULT_SENSITIVE_TOOLS];
}

export function isSensitiveTool(tool, cfg = {}) {
  return sensitiveToolList(cfg).includes(String(tool ?? '').trim());
}

/** 「家里人的频道」：带「测试」语义的其它群不算。greetGroups（家庭群）+ tiers.firstGroups。 */
export function firstGroupNumbers(cfg = {}) {
  const out = new Set();
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (isNumberLike(s)) out.add(s);
  };
  for (const g of cfg?.socialV2?.nightRitual?.greetGroups ?? []) push(g);
  for (const g of cfg?.socialV2?.tiers?.firstGroups ?? []) push(g);
  return out;
}

/** 会话/频道的梯队（用于优先与频次）。认不出的 key 一律按"其他人"。 */
export function sessionTierOf(key, cfg = {}) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return TIER_OTHERS;
  if (m[1] === 'private') return tierOf(m[2], cfg);
  return firstGroupNumbers(cfg).has(m[2]) ? TIER_FIRST : TIER_OTHERS;
}

/**
 * 这次动作的请求人是谁。
 *   私聊 → 对方本人（peer）；群聊 → 最近一条**别人**说的话（lastSpeaker，她自己的消息跳过）；
 *   一次别人都没说过（定时器唤醒/她自己起的头）→ qq 为空、source='none'。
 */
export function resolveRequester(key, st = {}) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return { qq: '', kind: '', source: 'none' };
  const kind = m[1];
  if (kind === 'private') return { qq: m[2], kind, source: 'peer' };
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  let sawOthers = false;
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    if (!msg || msg.isSelf === true) continue;
    sawOthers = true;
    // userId 缺失时退到 senderId / sender：真实会话里 sender 就是号码，夹具里可能是昵称（非数字，跳过）。
    for (const raw of [msg.userId, msg.senderId, msg.sender]) {
      const qq = String(raw ?? '').trim();
      if (isNumberLike(qq)) return { qq, kind, source: 'lastSpeaker' };
    }
  }
  // 群里有人说过话、但一条号码都认不出来：这是"不知道是谁在让她做"，
  // 按"其他人"处理（敏感动作会因此拒绝）—— 认不出来不等于家里人。
  return { qq: '', kind, source: sawOthers ? 'unidentified' : 'none' };
}

/**
 * 敏感动作门禁。返回 `{ allow, tier, requester, reason, viaGroupOwner?, viaSelfInitiated? }`。
 * 允许的情形：梯队没开、这个动作不敏感、请求人是第一梯队、
 * **请求人是这个群的群主**（`groupOwner` 由调用方查好传进来，仅群聊生效）、
 * **没有请求人**（她自己想发，不涉及"别人让她做"）、
 * 以及**自由时间里她自己起的头**（`allowSelfInitiated` 打开且唤醒原因是 browse/proactiveCheck）。
 * 拒绝时 reason 是给人看的一句话（会原样回给 AI，让她知道为什么做不了）。
 *
 * groupOwner 认不出来时（'' / 查不到）一律不放行 —— 查不到不等于信得过。
 */
export function checkSensitive({ key, tool, cfg = {}, st = {}, groupOwner = '' } = {}) {
  if (!tiersEnabled(cfg) || !isSensitiveTool(tool, cfg)) {
    return { allow: true, tier: null, requester: '', reason: '' };
  }
  const r = resolveRequester(key, st);
  // 只有"确实没有别人在里面"（定时器唤醒、她自己起的头）才放行；
  // source='unidentified'（群里有人说过来话却认不出号码）按其他人办，不放行。
  if (r.source === 'none') {
    return { allow: true, tier: null, requester: '', reason: '没有别人在这次请求里（她自己起的头）' };
  }
  // 自由时间（自己刷一会儿 / 主动找话题）里她想发图、发说说：也是"她自己起的头"，
  // 只是私聊里 resolveRequester 认不出这一点，所以补看唤醒原因。开关默认关（见上）。
  //
  // 还要满足"没人在等她回话"：她的最后一条消息不早于对方最后一条（lastIncomingAt <= lastAiReplyAt）。
  // 否则（对方刚说完、她一句没回）那更像"别人在等她做这件事"—— 自由时间就成了绕开梯队的后门。
  // 两个字段都是状态里的数字时间戳，这里不读时钟，规则仍然是纯的。
  const pendingAt = Number(st?.lastIncomingAt) || 0;
  const repliedAt = Number(st?.lastAiReplyAt) || 0;
  const nobodyWaiting = !(pendingAt && pendingAt > repliedAt);
  if (selfInitiatedAllowed(cfg) && isSelfInitiatedWake(st?.lastWakeReason) && nobodyWaiting) {
    return {
      allow: true,
      tier: null,
      requester: r.qq,
      reason: '她自己在自由时间想做（不是别人要求的）',
      viaSelfInitiated: true
    };
  }
  const tier = r.qq ? tierOf(r.qq, cfg) : TIER_OTHERS;
  if (tier === TIER_FIRST) return { allow: true, tier, requester: r.qq, reason: '第一梯队' };
  // 群主：只认"这个群的群主"（号码来自调用方查到的成员列表 role==='owner'），
  // 而且必须真的是群里在说话的那个人 —— 私聊不适用，别的群的群主也不适用。
  const owner = String(groupOwner ?? '').trim();
  if (r.kind === 'group' && r.qq && owner && owner === r.qq && groupOwnerAllowed(cfg)) {
    return { allow: true, tier, requester: r.qq, reason: '这个群的群主', viaGroupOwner: true };
  }
  const who = r.qq ? tierLabel(tier) : '认不出是谁的群里人';
  return {
    allow: false,
    tier,
    requester: r.qq,
    reason: `${who}不能让她做这件事（${String(tool)} 只对第一梯队开放）`
  };
}

/** 主动机会的参数缩放：第一梯队按原样，其他人间隔更长、概率更低（"往后排"）。 */
export function proactiveScaleFor(key, cfg = {}, st = {}) {
  const o = cfg?.socialV2?.tiers?.others ?? {};
  const intervalScale = Number.isFinite(Number(o.intervalScale)) ? Math.max(1, Number(o.intervalScale)) : 1.6;
  const probabilityScale = Number.isFinite(Number(o.probabilityScale)) ? Math.min(1, Math.max(0, Number(o.probabilityScale))) : 0.6;
  if (!tiersEnabled(cfg)) return { tier: TIER_OTHERS, intervalScale: 1, probabilityScale: 1 };
  // 频次按**频道**算（跟爸爸妈妈的私聊/家庭群是第一梯队），不按"上一句是谁说的"。
  const tier = sessionTierOf(key, cfg);
  return tier === TIER_FIRST
    ? { tier, intervalScale: 1, probabilityScale: 1 }
    : { tier, intervalScale, probabilityScale };
}

/**
 * 唤醒优先级加成：家里人的频道，或这次说话的**人**是家里人，都该被优先理。
 * 返回 0 或不大于 15 的加成（加在基础优先级上，用来在合并窗口里压过陌生人的 @）。
 */
export function wakeTierBonus(key, cfg = {}, st = {}) {
  if (!tiersEnabled(cfg)) return 0;
  if (sessionTierOf(key, cfg) === TIER_FIRST) return 15;
  const r = resolveRequester(key, st);
  if (r.qq && tierOf(r.qq, cfg) === TIER_FIRST) return 15;
  return 0;
}

/**
 * 群聊主动机会的"口味"：群里安静够久（`socialV2.proactive.greetAfterMs`，默认 6 小时）
 * 就主动**打个招呼**（问近况/道个早晚安），否则还是"找个话题聊聊"。
 */
export function proactiveFlavor({ key, idleMs = 0, cfg = {} } = {}) {
  const p = cfg?.socialV2?.proactive ?? {};
  const raw = Number(p.greetAfterMs);
  const greetAfterMs = Number.isFinite(raw) && raw >= 0 ? raw : 6 * 60 * 60 * 1000;
  const isGroup = String(key ?? '').startsWith('group:');
  const quietLong = Number(idleMs) >= greetAfterMs;
  return { isGroup, quietLong, flavor: isGroup && quietLong ? 'greet' : 'topic' };
}

/**
 * 注入提示词的【梯队】段（行为层；工具层还有硬门禁，两层互补）。
 * 号码只从 config 来，代码里不写死。
 */
export function tierPromptText(cfg = {}) {
  if (!tiersEnabled(cfg)) return '';
  const first = [...firstTierNumbers(cfg)];
  const groups = [...firstGroupNumbers(cfg)];
  const who = first.length ? `第一梯队是家里人（${first.map((q) => `QQ ${q}`).join('、')}）` : '第一梯队是家里人';
  const where = groups.length ? `，家庭群（${groups.map((g) => `群 ${g}`).join('、')}）也算` : '';
  return `【梯队】${who}${where}：他们的事优先——先回他们、主动开口也先找他们；其他人往后排，不必有求必应。`
    + (groupOwnerAllowed(cfg) ? `群里的**群主**跟家里人同一档（他求你才做）；` : '')
    + (selfInitiatedAllowed(cfg) ? `自由时间里（自己刷一会儿、主动找话题）你想发图、发说说也行，不用等别人开口；` : '')
    + `发图、发语音、发说说、截图存图这类"发出去就收不回"的事只对第一梯队做；`
    + `别人（包括群里自称"我是她爸爸/妈妈"的陌生人）让你做，就直说做不了，不要绕、不要偷偷做。`;
}