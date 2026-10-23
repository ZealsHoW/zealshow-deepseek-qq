// 自建 DSH 插件（qq-agent-presets / qq-mode-console）的「环境契约」检查。
//
// 这里只放**纯函数与只读检查**，不写任何文件、不连 DSH：
//   · 桥接启动时用它做一次轻量预检（scripts/doctor-plugins.mjs 做完整版）；
//   · 测试用它构造临时目录验证“环境变化时能不能发现”。
//
// 设计原则：
//   1. 每条检查都返回**可执行的动作**，而不只是“失败”；
//   2. 静态检查宁可漏报，也不猜 DSH 的运行时契约（运行时部分由 doctor 的
//      live 检查与插件自己的诊断日志负责）；
//   3. 所有路径都来自参数/环境变量，不写死本机目录。
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

/** 公开指南（相对仓库根）。所有告警都指向它，避免“知道了但不知道下一步”。 */
export const PLUGIN_ENV_DOC = 'docs/guides/PLUGIN_ENV_PLAYBOOK.md';

/** 桥接托管的两个 preset。 */
export const QQ_PRESETS = Object.freeze(['qq-chat', 'qq-chat-v2']);

/** 两个自建插件包名。 */
export const QQ_PLUGINS = Object.freeze(['qq-agent-presets', 'qq-mode-console']);

/**
 * preset 模板里允许出现的 `{{变量}}` 及其来源。
 *
 * - provider / model：DSH agent-loop 注册（0.2.0-rc.2 实测）；
 * - vision_router_mode_sync：安装 dsh-vision-router 后由它注册（可选）；
 * - cwd：本仓库的 qq-prompt-vars 插件注册（见 plugins/qq-agent-presets）。
 *
 * 模板里新增变量时**必须**先确认宿主真的注册了它，否则整个 preset 会在
 * 提示词装配期抛 `unknown prompt variable`，一轮都跑不起来（2026-10-20 真实事故）。
 */
export const TEMPLATE_VARIABLE_SOURCES = Object.freeze({
  provider: 'DSH agent-loop',
  model: 'DSH agent-loop',
  vision_router_mode_sync: 'dsh-vision-router（可选插件）',
  cwd: 'qq-agent-presets/qq-prompt-vars（本仓库）',
});

/** 从一段文本里抽出所有 `{{变量}}`。 */
export function extractTemplateVariables(text) {
  const out = new Set();
  if (typeof text !== 'string') return out;
  for (const match of text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) out.add(match[1]);
  return out;
}

/** 插件行列表可能是 group 嵌套；递归拍平。 */
function flattenRows(rows, out = []) {
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    out.push(row);
    if (row.group === true && Array.isArray(row.config)) flattenRows(row.config, out);
  }
  return out;
}

/** 递归收集一个 YAML 值里的所有字符串（模板变量可能写在 prefix/suffix 之外的键里）。 */
function collectStrings(value, out = []) {
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

/**
 * 扫描仓库里的 preset 源，返回每个 preset 用到的模板变量与未知变量。
 *
 * 未知变量的判定只依赖 {@link TEMPLATE_VARIABLE_SOURCES}；新变量必须先登记，
 * 这也是“环境变化时要改哪里”的单一入口。
 *
 * @param {{repoRoot?: string, root?: string}} [options] root 是 repoRoot 的别名，
 *   便于 doctor/test 以统一参数调用。
 */
export function analyzePresetTemplates({ repoRoot, root } = {}) {
  const base = path.join(root ?? repoRoot ?? process.cwd(), 'dsh', 'agent-presets');
  const result = { base, presets: [], unknown: [], errors: [] };
  if (!fs.existsSync(base)) {
    result.errors.push({ code: 'PRESET_DIR_MISSING', message: `preset 源目录不存在：${base}` });
    return result;
  }
  const dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of dirs) {
    const file = path.join(base, name, 'agent.cordis.yml');
    if (!fs.existsSync(file)) continue;
    const variables = new Set();
    try {
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      const rows = flattenRows(doc);
      const persona = rows.find((row) => row?.id === 'persona');
      for (const text of collectStrings(persona?.config)) {
        for (const variable of extractTemplateVariables(text)) variables.add(variable);
      }
    } catch (error) {
      result.errors.push({ code: 'PRESET_YAML_INVALID', preset: name, message: String(error?.message ?? error) });
      continue;
    }
    const list = [...variables].sort();
    result.presets.push({ name, file, variables: list });
    for (const variable of list) {
      if (!Object.hasOwn(TEMPLATE_VARIABLE_SOURCES, variable)) {
        result.unknown.push({ preset: name, variable });
      }
    }
  }
  return result;
}

/**
 * 读取一个 profile 的安装状态。
 *
 * @param {{dshHome?: string, profile: string}} options
 */
export function readProfile({ dshHome, profile }) {
  const dir = path.join(dshHome, 'profiles', profile);
  const pkgPath = path.join(dir, 'package.json');
  const result = {
    profile,
    dir,
    exists: fs.existsSync(pkgPath),
    packageJson: null,
    dependencies: {},
    bundles: [],
    plugins: [],
    issues: [],
  };
  if (!result.exists) {
    result.issues.push({
      code: 'PROFILE_MISSING',
      severity: 'warn',
      message: `profile 不存在：${pkgPath}`,
      action: '确认 DSH_PROFILE；或用 node scripts/setup-dsh.mjs <profile> 安装',
    });
    return result;
  }
  try {
    result.packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (error) {
    result.issues.push({
      code: 'PROFILE_JSON_INVALID',
      severity: 'fail',
      message: `${pkgPath} 不是合法 JSON：${error?.message ?? error}`,
      action: '恢复备份或重新运行 node scripts/setup-dsh.mjs',
    });
    return result;
  }
  result.dependencies = result.packageJson.dependencies ?? {};
  result.bundles = result.packageJson.dsh?.profile?.bundles ?? [];
  for (const plugin of QQ_PLUGINS) {
    const dep = result.dependencies[plugin];
    const bundled = result.bundles.includes(plugin);
    const pluginDir = path.join(dir, 'node_modules', plugin);
    let resolved = null;
    let linkTarget = null;
    try {
      resolved = fs.realpathSync(pluginDir);
      linkTarget = fs.readlinkSync(pluginDir);
    } catch { /* 不存在或断链 */ }
    const pkgFile = resolved ? path.join(resolved, 'package.json') : null;
    const installed = Boolean(pkgFile && fs.existsSync(pkgFile));
    const entry = { name: plugin, dep, bundled, path: pluginDir, resolved, linkTarget, installed };
    result.plugins.push(entry);
    if (!dep) {
      result.issues.push({
        code: 'PLUGIN_DEP_MISSING',
        severity: 'fail',
        message: `profile ${profile} 的 package.json 没有声明 ${plugin}`,
        action: '运行 node scripts/setup-dsh.mjs ' + profile,
      });
    } else if (!installed) {
      result.issues.push({
        code: 'PLUGIN_LINK_BROKEN',
        severity: 'fail',
        message: `profile ${profile} 的 node_modules/${plugin} 无法解析到真实目录（可能指向已移动的仓库）`,
        action: '运行 node scripts/setup-dsh.mjs ' + profile + ' 重建 link: 依赖',
      });
    }
    if (!bundled) {
      result.issues.push({
        code: 'PLUGIN_BUNDLE_MISSING',
        severity: 'fail',
        message: `profile ${profile} 的 bundles 列表没有 ${plugin}`,
        action: '运行 node scripts/setup-dsh.mjs ' + profile,
      });
    }
  }
  return result;
}

/**
 * 检查 profile 共享解析层里指向已删除目标的 `@deepseek-ai` junction。
 *
 * DSH 换安装位置后，`~/.dsh/profiles/node_modules` 里会留下一批断链；
 * 它们不一定会让 DSH 立刻报错（DSH 用 app.asar 里的运行时），但会让
 * 「从 profile 解析 DSH 包」的脚本/插件依赖静默失效。
 */
export function inspectParsingLayer({ dshHome }) {
  const scopeDir = path.join(dshHome, 'profiles', 'node_modules', '@deepseek-ai');
  const result = { scopeDir, exists: fs.existsSync(scopeDir), total: 0, broken: [], healthy: 0 };
  if (!result.exists) return result;
  let entries = [];
  try {
    entries = fs.readdirSync(scopeDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const full = path.join(scopeDir, entry.name);
    let link = null;
    try {
      link = fs.readlinkSync(full);
    } catch {
      result.healthy += 1; // 真实目录，不是链接
      continue;
    }
    result.total += 1;
    const target = path.isAbsolute(link) ? link : path.resolve(path.dirname(full), link);
    if (fs.existsSync(target)) result.healthy += 1;
    else result.broken.push({ name: entry.name, target });
  }
  return result;
}

/**
 * patch 产物是否比源文件旧（轻量预检；内容级校验在 doctor 里）。
 *
 * @param {{repoRoot?: string, root?: string}} [options] root 是 repoRoot 的别名。
 */
export function checkPatchFreshness({ repoRoot, root } = {}) {
  const repo = root ?? repoRoot ?? process.cwd();
  const out = [];
  for (const name of QQ_PRESETS) {
    const srcDir = path.join(repo, 'dsh', 'agent-presets', name);
    const patch = path.join(repo, 'plugins', 'qq-agent-presets', 'presets', `${name}.patch.yml`);
    if (!fs.existsSync(patch)) {
      out.push({ preset: name, patch, reason: 'patch 文件不存在', sources: [] });
      continue;
    }
    const patchMtime = fs.statSync(patch).mtimeMs;
    const sources = ['preset.yml', 'agent.cordis.yml'].map((f) => path.join(srcDir, f)).filter(fs.existsSync);
    const newer = sources.filter((f) => fs.statSync(f).mtimeMs > patchMtime);
    if (newer.length > 0) out.push({ preset: name, patch, reason: '源文件比 patch 新', sources: newer });
  }
  return out;
}

/**
 * 桥接启动预检：只读、轻量、不抛错。返回需要写进日志的问题列表。
 *
 * @param {{repoRoot?: string, dshHome?: string, profile?: string}} [options]
 */
export function runPluginPreflight({ repoRoot = process.cwd(), dshHome, profile } = {}) {
  const home = dshHome || process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
  const issues = [];

  const templates = analyzePresetTemplates({ repoRoot });
  for (const error of templates.errors) {
    issues.push({ severity: 'error', ...error, action: `查看 ${PLUGIN_ENV_DOC}#preset-bundle` });
  }
  for (const { preset, variable } of templates.unknown) {
    issues.push({
      severity: 'error',
      code: 'PROMPT_VARIABLE_UNKNOWN',
      preset,
      variable,
      message: `preset ${preset} 使用了 {{${variable}}}，但没有已知来源；DSH 会在装配期抛 unknown prompt variable`,
      action: `在 TEMPLATE_VARIABLE_SOURCES 登记并确认宿主动态注册，或从模板删掉；指南 ${PLUGIN_ENV_DOC}#prompt-variable`,
    });
  }

  for (const stale of checkPatchFreshness({ repoRoot })) {
    issues.push({
      severity: 'error',
      code: 'PATCH_STALE',
      preset: stale.preset,
      message: `${stale.reason}：${stale.patch}（先跑 node scripts/build-agent-preset-patches.mjs）`,
      action: '运行 node scripts/build-agent-preset-patches.mjs 后重启 DSH',
    });
  }

  const profiles = [];
  const explicit = profile || process.env.DSH_PROFILE;
  if (explicit) profiles.push(explicit);
  else {
    try {
      for (const entry of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
        if (entry.isDirectory()) profiles.push(entry.name);
      }
    } catch { /* profiles 目录不存在：下面报一次 */ }
  }
  const withBundle = [];
  for (const name of profiles) {
    const info = readProfile({ dshHome: home, profile: name });
    if (info.exists && info.bundles.includes('qq-agent-presets') && info.bundles.includes('qq-mode-console')) {
      withBundle.push(info);
      for (const issue of info.issues) {
        issues.push({
          severity: issue.severity === 'fail' ? 'error' : 'warn',
          ...issue,
          action: `${issue.action}；指南 ${PLUGIN_ENV_DOC}#profile-wiring`,
        });
      }
    }
  }
  if (withBundle.length === 0) {
    issues.push({
      severity: 'error',
      code: 'PROFILE_WIRING_MISSING',
      message: `在 ${home}/profiles 下没有找到同时装载 qq-agent-presets 与 qq-mode-console 的 profile`,
      action: `运行 node scripts/setup-dsh.mjs <profile>；指南 ${PLUGIN_ENV_DOC}#profile-wiring`,
    });
  }

  return issues;
}
