// 定位「DSH 运行时安装目录下的 node_modules」—— 供仓库脚本加载 DSH 自身的模块做校验。
//
// 为什么这件事需要一整个文件（而不是一行 join）
// --------------------------------------------
// DSH 桌面版把运行时 JS 打在 `resources/app.asar` 里，profile 下的
// `~/.dsh/profiles/*/node_modules` 只是安装器/包管理器铺出来的解析层。
// 一旦 DSH 换安装位置（本机真实发生过：从旧的 `…\DSH Desktop` 搬到短路径），
// 这层里会留下一批**指向已删除路径的 junction**。旧实现只探测 `dsh-persona` /
// `js-yaml` 能否 require 成功，于是：
//   · `dsh-persona` 解析失败后，`js-yaml` 在 desktop profile 里解析成功；
//   · 返回 `profiles/desktop/node_modules` —— 它里面一个 DSH 工具包都没有；
//   · `scan-dsh-tool-names.mjs` 安静地扫到 0 个包，把所有守卫名单报成"假名"；
//   · `test-preset-local-tools.mjs` 安静地打一行"跳过"，套件仍然全绿。
// 这类失败比报错危险得多：它让人以为已经对过账。
//
// 解析顺序（每一步都**验证**目录里确实有 `@deepseek-ai/dsh-*`）：
//   1. 环境变量 DSH_INSTALL_MODULES / DSH_MODULES（显式指定；无效时直接报错，不静默回退）
//   2. 环境变量 DSH_RUNTIME_DIR（DSH 运行时解包根目录；接受根目录或 node_modules）
//   3. 从各 profile 的 package.json 用 Node 模块解析反查（profile 依次尝试
//      DSH_PROFILE、web、default、desktop，再兜底扫 profiles 下的其它目录）
//   4. 当前 DSH 安装的 **app.asar 解包副本**（`_dsh_asar/dsh/node_modules` 等；
//      这是本机用于对账的可读副本。若副本过期，doctor 会单独告警）
// 全部失败时抛出**带候选清单和修复命令**的错误，不做任何写死路径的回退 ——
// 宁可显式报错，也不要静默用错版本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 用来判断「这个 node_modules 是不是 DSH 运行时」的锚点包。
 *
 * 任意一个存在即可：不同版本裁剪的包不同，但只要有一个 `@deepseek-ai/dsh-*`
 * 落在目录里，就说明它至少包含 DSH 运行时，而不是普通依赖目录。
 * 刻意**不**用 `js-yaml` / `@deepseek-ai/schemastery` 这类通用包做锚点 ——
 * 它们在任何 profile 里都可能存在，这正是旧实现认错目录的根因。
 */
export const DSH_ANCHOR_PACKAGES = Object.freeze([
  'dsh-app-boot',
  'dsh-agent-loop',
  'dsh-tools',
  'dsh-tool-pwsh',
  'dsh-persona',
]);

const DSH_PACKAGES_SCOPE = '@deepseek-ai';

/**
 * 检查一个目录是否是「DSH 运行时 node_modules」。
 *
 * @param {string} dir 候选目录
 * @returns {{dir: string, exists: boolean, anchors: string[], ok: boolean, reason: string}}
 */
export function inspectDshModulesDir(dir) {
  const result = { dir: dir ? path.resolve(dir) : '', exists: false, anchors: [], ok: false, reason: '' };
  if (!result.dir) {
    result.reason = '未提供目录';
    return result;
  }
  try {
    if (!fs.statSync(result.dir).isDirectory()) {
      result.reason = '不是目录';
      return result;
    }
  } catch {
    result.reason = '目录不存在';
    return result;
  }
  result.exists = true;
  for (const name of DSH_ANCHOR_PACKAGES) {
    try {
      const pkg = path.join(result.dir, DSH_PACKAGES_SCOPE, name, 'package.json');
      if (fs.statSync(pkg).isFile()) result.anchors.push(name);
    } catch { /* junction 断了 / 包不存在都算没有 */ }
  }
  result.ok = result.anchors.length > 0;
  if (!result.ok) {
    result.reason = `目录里没有 ${DSH_PACKAGES_SCOPE}/dsh-*（通常是被删掉的旧安装留下的 profile 链接，或 app.asar 的解包不完整）`;
  }
  return result;
}

function findNodeModules(resolvedFile) {
  let dir = path.dirname(resolvedFile);
  for (;;) {
    if (path.basename(dir) === 'node_modules') return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** profile 名的候选顺序：环境变量优先，其余保持确定性。 */
export function candidateProfiles(home = dshHome()) {
  const names = [];
  const add = (n) => { if (n && !names.includes(n)) names.push(n); };
  add(process.env.DSH_PROFILE);
  add('web');
  add('default');
  add('desktop');
  try {
    for (const e of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (e.isDirectory()) add(e.name);
    }
  } catch { /* profiles 目录不存在时忽略 */ }
  return names;
}

/** 从某个 profile 的 package.json 解析一个包，返回它的 node_modules 目录。 */
function nodeModulesFromProfile(profileDir, specifier) {
  const anchor = path.join(profileDir, 'package.json');
  if (!fs.existsSync(anchor)) return null;
  try {
    const req = createRequire(anchor);
    const resolved = req.resolve(specifier);
    return findNodeModules(resolved);
  } catch {
    return null;
  }
}

/** 从脚本所在位置向上找「app.asar 解包副本」的常见目录。 */
function extractedRuntimeCandidates() {
  const out = [];
  const push = (source, dir) => {
    if (!dir) return;
    const norm = path.resolve(dir);
    if (!out.some((c) => c.dir.toLowerCase() === norm.toLowerCase())) out.push({ source, dir: norm });
  };

  // 环境变量显式指定：既接受 <根>/dsh/node_modules，也接受 <根>/node_modules 或直接 node_modules。
  const runtimeDir = process.env.DSH_RUNTIME_DIR;
  if (runtimeDir) {
    push('环境变量 DSH_RUNTIME_DIR', path.join(runtimeDir, 'dsh', 'node_modules'));
    push('环境变量 DSH_RUNTIME_DIR', path.join(runtimeDir, 'node_modules'));
    push('环境变量 DSH_RUNTIME_DIR', runtimeDir);
  }

  // 稳定运行时副本（scripts/sync-dsh-runtime.mjs 生成）：优先于工作区里的解包副本。
  const stableRoot = path.join(dshHome(), 'runtime');
  try {
    const versions = fs.readdirSync(stableRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const version of versions) {
      push(`~/.dsh/runtime/${version}/node_modules`, path.join(stableRoot, version, 'node_modules'));
    }
  } catch { /* 还没有稳定副本 */ }

  const starts = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()];
  const roots = new Set();
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let i = 0; i < 5; i += 1) {
      roots.add(dir);
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }

  const knownNames = ['_dsh_asar', 'dsh_asar', 'dsh-asar', 'asar-extract', 'dsh-runtime-extract'];
  for (const root of roots) {
    for (const name of knownNames) {
      push(`${name}/dsh/node_modules`, path.join(root, name, 'dsh', 'node_modules'));
      push(`${name}/node_modules`, path.join(root, name, 'node_modules'));
    }
    // 兜底：工作区里任何名字带 asar / runtime 的目录（只扫一层，避免遍历大目录）。
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory() || !/asar|runtime/i.test(e.name)) continue;
        push(`${e.name}/dsh/node_modules`, path.join(root, e.name, 'dsh', 'node_modules'));
        push(`${e.name}/node_modules`, path.join(root, e.name, 'node_modules'));
      }
    } catch { /* 无权限/不存在都忽略 */ }
  }
  return out;
}

/**
 * 列出所有候选目录及验证结果。doctor 用它解释「为什么定位失败」。
 *
 * @returns {{source: string, dir: string, exists: boolean, anchors: string[], ok: boolean, reason: string}[]}
 */
export function dshModulesCandidates() {
  const home = dshHome();
  const out = [];
  const add = (source, dir) => {
    if (!dir) return;
    const norm = path.resolve(dir);
    if (out.some((c) => c.dir.toLowerCase() === norm.toLowerCase())) return;
    out.push({ source, ...inspectDshModulesDir(norm) });
  };

  const envDir = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (envDir) add('环境变量 DSH_INSTALL_MODULES / DSH_MODULES', envDir);

  for (const profile of candidateProfiles(home)) {
    const profileDir = path.join(home, 'profiles', profile);
    if (!fs.existsSync(path.join(profileDir, 'package.json'))) continue;
    for (const name of DSH_ANCHOR_PACKAGES) {
      const spec = `${DSH_PACKAGES_SCOPE}/${name}`;
      const dir = nodeModulesFromProfile(profileDir, spec);
      if (dir) {
        add(`profile ${profile} → ${spec}`, dir);
        break;
      }
    }
  }
  // 即使解析不到锚点，也把 profile 的 node_modules 列出来，doctor 才能显示“断链”证据。
  for (const profile of candidateProfiles(home)) {
    add(`profile ${profile}/node_modules`, path.join(home, 'profiles', profile, 'node_modules'));
  }
  add('profiles/node_modules（共享解析层）', path.join(home, 'profiles', 'node_modules'));

  for (const c of extractedRuntimeCandidates()) add(c.source, c.dir);
  return out;
}

/**
 * 定位 DSH 运行时的 node_modules。
 *
 * @returns {string} 已验证包含 `@deepseek-ai/dsh-*` 的目录
 * @throws {Error} 所有候选都无效时，错误里带候选清单与下一步命令
 */
export function dshModulesDir() {
  // 显式指定的目录必须被尊重：如果它无效，宁可报错，也不要静默回退到
  // “另一个看起来可用”的目录 —— 那正是“用错版本”的经典来源。
  const explicit = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (explicit) {
    const info = inspectDshModulesDir(explicit);
    if (!info.ok) {
      throw new Error(
        `DSH_INSTALL_MODULES / DSH_MODULES 指向的目录无效：${info.dir}\n`
        + `  原因：${info.reason}\n`
        + '  → 改指向 <DSH 运行时解包目录>/node_modules，或删除该环境变量后重试。'
      );
    }
    return info.dir;
  }

  const candidates = dshModulesCandidates();
  const good = candidates.find((c) => c.ok);
  if (good) return good.dir;

  const considered = candidates.filter((c) => c.exists);
  const lines = considered.length
    ? considered.map((c) => `  · ${c.dir}\n    （来源：${c.source}）${c.reason}`).join('\n')
    : '  （没有任何候选目录存在）';
  throw new Error(
    '无法定位 DSH 运行时的 node_modules（候选目录里都没有 @deepseek-ai/dsh-*）。\n'
    + `${lines}\n\n`
    + '  → 修复（任选其一）：\n'
    + '    1) 指向一个可读的 DSH 运行时解包副本：\n'
    + '       set DSH_INSTALL_MODULES=<解包目录>/node_modules\n'
    + '    2) 从安装包重新解包（需要 @electron/asar）：\n'
    + '       npx @electron/asar extract "<DSH 安装目录>/resources/app.asar" <解包目录>\n'
    + '    3) 若只是 DSH 换了安装位置，先按 docs/guides/PLUGIN_ENV_PLAYBOOK.md §3.2\n'
    + '       重建 profile 的解析层，再重跑本脚本。\n'
    + '  本次检查不会写任何文件，也不会猜一个“看起来像”的目录继续跑。'
  );
}
