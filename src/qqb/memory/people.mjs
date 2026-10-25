// 「人名簿」：把会话 scope（private:123 / group:456）翻成看得见的名字。
//
// 为什么要有它：记忆库里的 scope 是 `private:2998647358` 这种机器标识，跨会话检索时
// 结果只会说「发生在 private:2998647358」，模型念出来像报错码。有了这层，检索结果能
// 写成「小祀那边的事」，她才说得出「这是小祀跟我讲的」。
//
// 边界：
//   · 它**只是标签**，不参与任何准入判断 —— 谁能跟她说话仍然只由 config.allow 决定；
//   · 文件坏了/读不到就当空簿子，绝不抛错（记忆库整个坏了都不该拖垮对话，何况名字）；
//   · 群里同一个 key 会不断换发言人，所以群名只从网关的群列表来，不用消息里的 sender 覆盖。
import fs from 'node:fs';
import path from 'node:path';

const UNKNOWN_LABEL = '不认识的人';

function cleanName(name) {
  const text = String(name ?? '').trim();
  // 空、纯数字（QQ 号当名字没有信息量）、以及调用方兜底的「未知」都不收。
  if (!text) return '';
  if (text === '未知' || text === UNKNOWN_LABEL) return '';
  if (/^[0-9]{5,12}$/.test(text)) return '';
  return text.slice(0, 40);
}

/**
 * @param {object} options
 * @param {string|null} options.filePath  落盘路径（默认不落盘，纯内存）
 * @param {{warn?:Function}|null} options.logger
 * @param {() => number} [options.now]
 */
export function createPeopleDirectory({ filePath = null, logger = null, now = () => Date.now() } = {}) {
  /** @type {Record<string, {name:string, kind:string, note:string, updatedAt:number}>} */
  let map = {};
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    if (!filePath) return;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [scope, value] of Object.entries(parsed)) {
          const name = cleanName(value?.name);
          if (!name) continue;
          map[scope] = {
            name,
            kind: value?.kind === 'group' ? 'group' : 'private',
            note: String(value?.note ?? '').slice(0, 80),
            updatedAt: Number(value?.updatedAt) || 0
          };
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') logger?.warn?.('人名簿读取失败，先当空簿子用', error?.message ?? error);
      map = {};
    }
  }

  function save() {
    if (!filePath) return false;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, filePath);
      return true;
    } catch (error) {
      logger?.warn?.('人名簿写入失败（不影响对话）', error?.message ?? error);
      return false;
    }
  }

  /** 记一个名字。名字没变就不写盘；返回 true 表示这次真的更新了。 */
  function remember(scope, name, extra = {}) {
    const key = String(scope ?? '').trim();
    const clean = cleanName(name);
    if (!key || !clean) return false;
    load();
    const previous = map[key];
    if (previous && previous.name === clean) return false;
    map[key] = {
      name: clean,
      kind: extra?.kind === 'group' || key.startsWith('group:') ? 'group' : 'private',
      note: String(extra?.note ?? previous?.note ?? '').slice(0, 80),
      updatedAt: now()
    };
    save();
    return true;
  }

  function get(scope) {
    load();
    const key = String(scope ?? '').trim();
    return map[key] ? { ...map[key] } : null;
  }

  /**
   * 展示用的标签：`小祀（私聊 private:2998647358）`。
   * 带上 scope 是有意的 —— 她知道这是「谁的私聊」才敢决定要不要往下说，
   * 也才写得出 `qq_send_message` 需要的 key。
   */
  function label(scope) {
    const key = String(scope ?? '').trim();
    if (!key) return UNKNOWN_LABEL;
    const entry = get(key);
    const kindText = key.startsWith('group:') ? '群聊' : '私聊';
    if (!entry) return `${kindText} ${key}`;
    return `${entry.name}（${kindText} ${key}）`;
  }

  /** 只给名字，不带 scope（提示词里列「我认识谁」时用）。 */
  function nameOf(scope) {
    const entry = get(scope);
    return entry ? entry.name : '';
  }

  function entries() {
    load();
    return Object.entries(map)
      .map(([scope, value]) => ({ scope, ...value }))
      .sort((a, b) => a.scope.localeCompare(b.scope));
  }

  function size() {
    load();
    return Object.keys(map).length;
  }

  return { load, save, remember, get, label, nameOf, entries, size, filePath };
}