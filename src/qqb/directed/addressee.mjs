// 称呼 → 会话：她开口叫的是谁，这句话就发给谁。
//
// 2026-11-03 主人报：「给妈妈发『爸，妈说她想你了，你回她一句呗』」。
// 查 `state/history/private_3250968635.jsonl`：这句 09:00:30 和 11:00:31 两次都落在**妈妈**
// 的窗口里，而 `state/tool-calls.jsonl` 那两小时没有任何发送工具记录 —— 不是工具发错，
// 是引擎把这段文本当成「这一轮要说的话」直接发给了当前会话：发送路径只认 key，
// 从不看她开头写的是谁。她在妈妈窗口里惦记爸爸的事，写给爸爸的话就塞进了妈妈的眼睛里。
//
// 这里的职责很窄、纯函数：拿一张「称呼 → QQ」的表，把一句话拆成「留在本会话」和「改投」。
// 表怎么来（config 的爸妈、人名簿）由桥接那边组装，方便单测。
export const VERSION = '0.1.0';

/** 正则里的特殊字符转义。 */
export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 号码规范化：去掉前导零（OneBot 两种写法都见过）。 */
export function normQQ(qq) {
  return String(qq ?? '').trim().replace(/^0+(?=\d)/, '');
}

/**
 * 这一行开头叫的是谁？命中就返回 { qq, name }，否则 null。
 *
 * 「叫」的判定很窄：称呼必须在**最前面**，后面紧跟标点或空白（「爸，…」「妈妈: …」「主人 在吗」）。
 * 这样「我爸昨天…」「妈妈说今天…」这种叙述不会误判 —— 只有真的在对谁说话才算。
 */
export function leadingAddressee(text, table = []) {
  const body = String(text ?? '');
  if (!body.trim()) return null;
  for (const entry of table) {
    const name = String(entry?.name ?? '').trim();
    const qq = normQQ(entry?.qq);
    if (!name || !qq) continue;
    if (new RegExp(`^\\s*${escapeRe(name)}\\s*[，,、：:！!~～\\s]`).test(body)) return { qq, name };
  }
  return null;
}

/**
 * 把一批要说的话拆成两堆。
 *
 * - 只处理私聊：群聊里叫「妈」是家常便饭，不该改投。
 * - 表里同一个人（就是当前会话这位）不算改投，那是正常称呼。
 * - 一行一个判定，不动顺序，`keep` 里的内容原样保留（调用方还要按原来的节奏发）。
 *
 * @param {{ key: string, texts: string[]|string, table: Array<{qq:string,name:string}> }} args
 * @returns {{ keep: any[], moves: Array<{qq:string,name:string,text:string}> }}
 */
export function routeByAddressee({ key, texts, table = [] } = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  const scope = String(key ?? '');
  if (!scope.startsWith('private:')) return { keep: list, moves: [] };
  const peer = normQQ(scope.slice('private:'.length));
  const others = (Array.isArray(table) ? table : [])
    .map((e) => ({ qq: normQQ(e?.qq), name: String(e?.name ?? '').trim() }))
    .filter((e) => e.qq && e.name && e.qq !== peer);
  if (!others.length) return { keep: list, moves: [] };
  const keep = [];
  const moves = [];
  for (const raw of list) {
    const hit = leadingAddressee(raw, others);
    if (hit) moves.push({ ...hit, text: String(raw ?? '') });
    else keep.push(raw);
  }
  return { keep, moves };
}