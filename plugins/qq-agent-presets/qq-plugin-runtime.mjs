// QQ preset 插件的运行期诊断与能力探测。
//
// 为什么插件需要自己「留证」
// --------------------------
// 插件是装进 DSH 进程里的，出错时用户能看到的往往只有桥接转发的一句
// 「agent 处理出错」。过去排查 `{{cwd}}` 一类问题只能靠猜：DSH 日志里既没有
// 「插件有没有被装配」，也没有「当前 DSH 提供了哪些 seam」。
//
// 这里做三件事（都是只追加、失败不影响插件）：
//   1. capability 探测：systemPrompt.variable / tools.restrict / tools.guard /
//      settings.register 等当前运行时到底有没有；
//   2. 结构化 JSONL 诊断：写到系统临时目录（可用 QQ_PLUGIN_DIAG 覆盖，
//      设为空串关闭），doctor 直接读它判断「插件是否被装配 + 上次能力矩阵」；
//   3. 统一告警前缀：所有环境不适配信息都以 `[qq-agent-presets]` 开头，
//      在 DSH 日志里能一眼 grep 到，并附带指南入口。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 诊断文件路径：默认系统临时目录，绝不按相对层级往仓库里写。 */
export const DIAG_FILE = process.env.QQ_PLUGIN_DIAG === ''
  ? ''
  : (process.env.QQ_PLUGIN_DIAG || path.join(os.tmpdir(), 'qq-agent-presets.log'));

/** 日志超过这个大小就轮转到 `.1`（只保留一份，避免临时目录无限增长）。 */
const MAX_DIAG_BYTES = 1024 * 1024;

const GUIDE = 'docs/guides/PLUGIN_ENV_PLAYBOOK.md';

/** 读取本包版本（失败时返回 unknown，诊断本身不能成为新的故障源）。 */
export function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 追加一条诊断。任何写盘失败都被吞掉：诊断是辅助信息，不能让插件装配失败。
 *
 * @param {string} event 事件名（apply / registered / warning / error）
 * @param {Record<string, unknown>} [data]
 */
export function diag(event, data = {}) {
  if (!DIAG_FILE) return;
  try {
    fs.mkdirSync(path.dirname(DIAG_FILE), { recursive: true });
    try {
      if (fs.statSync(DIAG_FILE).size > MAX_DIAG_BYTES) {
        // Windows 的 rename 不会覆盖已存在的 `.1`，先删再轮转。
        try { fs.rmSync(`${DIAG_FILE}.1`, { force: true }); } catch { /* 忽略 */ }
        fs.renameSync(DIAG_FILE, `${DIAG_FILE}.1`);
      }
    } catch { /* 首次写入 / 轮转失败都继续追加 */ }
    const line = JSON.stringify({
      t: new Date().toISOString(),
      pid: process.pid,
      plugin: 'qq-agent-presets',
      version: pluginVersion(),
      event,
      ...data,
    });
    fs.appendFileSync(DIAG_FILE, `${line}\n`, 'utf8');
  } catch { /* 只读临时目录 / 权限不足：忽略 */ }
}

/** 统一前缀的告警（同时落诊断文件，便于 doctor 复盘）。 */
export function warn(message) {
  console.warn(`[qq-agent-presets] ${message}`);
  diag('warning', { message });
}

/** 拼一条带指南入口的告警文案，避免每个调用点各写一份措辞。 */
export function guideHint(anchor) {
  return `运行 \`npm run doctor\` 查看环境体检；指南见 ${GUIDE}${anchor ? `#${anchor}` : ''}`;
}

/**
 * 读一个可能「不可访问」的属性。
 *
 * cordis 的 ctx 是代理对象：读取**没有写进 inject** 的服务会直接抛
 * `cannot get property "x" without inject`，而不是返回 undefined。
 * 它是抛错而不是 undefined —— 所以这里必须 try，不能用 `?.` 兜。
 *
 * @template T
 * @param {() => T} get
 * @returns {T | undefined}
 */
function probe(get) {
  try { return get(); } catch { return undefined; }
}

/**
 * 探测当前 DSH 暴露给插件的 seam。
 *
 * 只报告「有没有」，不判断「新版应该怎样」——契约变化由 doctor 与
 * PLUGIN_ENV_PLAYBOOK 负责解释，插件自身只做安全降级。
 *
 * 每个服务**分别兜底**：调用方的 inject 集合各不相同（qq-prompt-vars 只注入
 * systemPrompt、qq-tool-restrict 只注入 tools），而本函数是共用入口。
 * 2026-10-21 实测事故：这里没兜住，qq-prompt-vars 读 tools、qq-tool-restrict
 * 读 systemPrompt 时在 apply() 抛错 → preset 变成 `agent-preset/invalid` →
 * QQ 会话一轮都建不起来（桥接侧只看到「agent 处理出错」）。
 *
 * @param {Record<string, any>} ctx cordis 插件上下文
 */
export function capabilities(ctx) {
  const systemPrompt = probe(() => ctx?.systemPrompt);
  const tools = probe(() => ctx?.tools);
  const settings = probe(() => ctx?.settings);
  return {
    systemPrompt: Boolean(systemPrompt),
    systemPromptVariable: typeof systemPrompt?.variable === 'function',
    tools: Boolean(tools),
    toolsRestrict: typeof tools?.restrict === 'function',
    toolsGuard: typeof tools?.guard === 'function',
    settings: Boolean(settings),
    // 0.1.x 才有；0.2.0 已删除。出现它说明运行时比插件预期老。
    settingsRegister: typeof settings?.register === 'function',
  };
}
