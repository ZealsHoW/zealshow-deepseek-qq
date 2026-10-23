// 把「agent 报错」翻译成「环境变化应对指南」。
//
// 背景：插件/DSH 适配失败的原始错误通常只有一行，例如
//   unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
//   registered variables: provider, model, vision_router_mode_sync
// 它出现在 QQ 里像天书，出现在 bridge.log 里也只是一行 —— 而真正该做的是
// "改哪个文件 / 跑哪条命令 / 看哪节文档"。
//
// 本模块只做**纯文本分类**：不连 DSH、不读文件、不写文件。桥接在收到
// `ended.reason.kind === 'error'` 时调用它，把命中的指南写进 bridge.log 与
// state/env-incidents.jsonl；doctor 再把这些事故汇总出来。
//
// 规则要保守：只匹配**已知且可行动**的形态；未知错误保持原样，不硬套指南。
import fs from 'node:fs';
import path from 'node:path';

/** 指南文档（相对仓库根）。 */
export const GUIDE_DOC = 'docs/guides/PLUGIN_ENV_PLAYBOOK.md';

/**
 * @typedef {{
 *   code: string, title: string, detail: string,
 *   actions: string[], doc: string, matched: Record<string, string>,
 * }} EnvGuide
 */

const RULES = [
  {
    code: 'PROMPT_VARIABLE_MISSING',
    test: /unknown prompt variable\s+"?\{\{\s*([\w.-]+)\s*\}\}"?/i,
    title: (match) => `提示词变量 {{${match[1]}}} 没有注册`,
    detail: () => 'preset 的 persona 模板引用了当前 DSH 没有注册的变量，提示词装配会整体失败。',
    actions: (match) => [
      `在 dsh/agent-presets/*/agent.cordis.yml 里搜索 {{${match[1]}}}，确认是模板需要它`,
      `确认当前 DSH 真的注册了 ${match[1]}；本仓库只兜底 cwd（plugins/qq-agent-presets/qq-prompt-vars.mjs）`,
      '若变量应由本仓库补充：在 qq-prompt-vars.mjs 注册，并同步 src/plugin-contract.js 的来源表',
      'npm run doctor',
    ],
    doc: `${GUIDE_DOC}#prompt-variable`,
  },
  {
    code: 'SETTINGS_NAMESPACE',
    test: /No configurable plugin entry|has no volatile fields/i,
    title: () => 'qq-mode 设置命名空间不可写',
    detail: () => 'DSH 按 loader entry id + 导出的 Config 推导命名空间；id 不同名或 Config 缺 volatile 字段都会失败。',
    actions: () => [
      '检查 plugins/qq-mode-console/cordis.patch.yml：entry id 必须是 qq-mode（不是包名）',
      '检查 plugins/qq-mode-console/lib/index.js 的 Config 字段带 .extra(\'volatile\', true)',
      'node scripts/setup-dsh.mjs <profile> 后重启 DSH',
      'npm run doctor',
    ],
    doc: `${GUIDE_DOC}#settings-namespace`,
  },
  {
    code: 'PLUGIN_LINK_BROKEN',
    test: /Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND/i,
    title: () => '插件/依赖无法解析（profile 链接可能断了）',
    detail: () => '插件以 link: 依赖装进 profile；仓库搬家、插件目录被删或旧安装残留都会让解析失败。',
    actions: () => [
      '确认 DSH_PROFILE 指向正在运行的 profile',
      'node scripts/setup-dsh.mjs <profile> 重建 link: 依赖',
      'npm run doctor（会列出断链数量与示例）',
    ],
    doc: `${GUIDE_DOC}#profile-wiring`,
  },
  {
    code: 'DSH_UNREACHABLE',
    test: /ECONNREFUSED|fetch failed|socket hang up|connect ETIMEDOUT/i,
    title: () => 'DSH Web API 连不上',
    detail: () => '端口变化（桌面版是动态端口）、DSH 未启动或 baseUrl 仍指向旧地址都会表现为连接拒绝。',
    actions: () => [
      '对照当前 GUI 地址检查 config.json 的 dsh.baseUrl（不要改脚本里的默认端口）',
      '确认 DSH 正在运行；npm run test:dsh-auth',
      'npm run doctor -- --offline 先排除本地配置问题',
    ],
    doc: `${GUIDE_DOC}#dsh-port`,
  },
  {
    code: 'DSH_AUTH',
    test: /\b401\b|Unauthorized|invalid cookie|forbidden/i,
    title: () => 'DSH 鉴权失败',
    detail: () => '会话 Cookie 铸造依赖 ~/.dsh 里的持久化签名密钥；DSH_HOME 指错或密钥变化都会 401。',
    actions: () => [
      '确认 DSH_HOME 指向正在运行的 DSH（默认 ~/.dsh）',
      'npm run test:dsh-auth 查看鉴权链路',
      '不要手工把 token 写进代码或配置；用 Cookie 铸造路径',
    ],
    doc: `${GUIDE_DOC}#dsh-auth`,
  },
  {
    code: 'PRESET_NOT_INSTALLED',
    test: /unknown (?:agent )?preset|preset[^\n]*(?:not found|不存在)|agentPresets?\/list/i,
    title: () => 'agent preset 没有装进当前 profile',
    detail: () => 'preset 以 bundle patch 形式安装；只改仓库源文件、不重新生成/安装，DSH 看不到变化。',
    actions: () => [
      'node scripts/build-agent-preset-patches.mjs',
      'node scripts/setup-dsh.mjs <profile>',
      '重启 DSH 后 npm run doctor（检查 live-presets）',
    ],
    doc: `${GUIDE_DOC}#preset-bundle`,
  },
  {
    code: 'TOOL_DRIFT',
    test: /tools?\.restrict|tool[^\n]*(?:not registered|unknown tool)|not a registered tool/i,
    title: () => '工具面与守卫名单不一致',
    detail: () => 'DSH 升级后工具名可能新增/改名/删除；restrict 对未知名字会抛错（被逐个 catch），静默失效。',
    actions: () => [
      'node scripts/scan-dsh-tool-names.mjs --missing',
      '按输出更新 qq-tool-restrict.mjs 的名单与 TRACKED_ABSENT_TOOL_NAMES',
      'npm run test:preset-local-tools / npm run doctor',
    ],
    doc: `${GUIDE_DOC}#tool-drift`,
  },
  {
    code: 'STATE_ACL',
    test: /EACCES|EPERM[^\n]*(?:state|write|access)|access is denied/i,
    title: () => '文件/目录权限拒绝（常见于 state/ ACL）',
    detail: () => 'state/ 被收紧了 ACL；沙箱子进程或换用户运行时会写不进去。',
    actions: () => [
      'npm run diagnose:acl（需在普通终端跑，不要在沙箱里）',
      '必要时 sudo/管理员执行它给出的 icacls 命令',
      '与插件无关时忽略本提示',
    ],
    doc: `${GUIDE_DOC}#acl`,
  },
];

/**
 * 把一条 agent 错误翻译成指南。未命中返回 null（不要为未知错误编造建议）。
 *
 * @param {unknown} rawMessage
 * @returns {EnvGuide|null}
 */
export function explainAgentError(rawMessage) {
  const message = typeof rawMessage === 'string' ? rawMessage : String(rawMessage ?? '');
  if (!message.trim()) return null;
  for (const rule of RULES) {
    const match = rule.test.exec(message);
    if (!match) continue;
    const matched = {};
    match.slice(1).forEach((value, index) => { if (value) matched[`$${index + 1}`] = value; });
    return {
      code: rule.code,
      title: rule.title(match),
      detail: rule.detail(match),
      actions: rule.actions(match),
      doc: rule.doc,
      matched,
    };
  }
  return null;
}

/**
 * 追加一条环境事故（JSONL），供 doctor 的「最近环境事故」汇总。
 * 任何写盘失败都吞掉：诊断不能反过来影响桥接。
 *
 * @param {string} file
 * @param {Record<string, unknown>} incident
 */
export function appendEnvIncident(file, incident) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > 512 * 1024) {
        // Windows 的 rename 不会覆盖已存在的 `.1`，先删再轮转。
        try { fs.rmSync(`${file}.1`, { force: true }); } catch { /* 忽略 */ }
        fs.renameSync(file, `${file}.1`);
      }
    } catch { /* 首次写入 */ }
    fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...incident })}\n`, 'utf8');
  } catch { /* 只读目录/权限不足：忽略 */ }
}
