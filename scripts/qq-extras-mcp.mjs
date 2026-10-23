#!/usr/bin/env node
// dsh-qq-extras 的 MCP 启动壳（由 qq-bridge 仓库提供，见 scripts/patch-qq-extras.mjs）。
//
// 为什么不直接让 DSH 跑插件的 mcp.mjs：
//   1) dsh-qq-extras@0.1.0 的 npm 包漏发了 `lib/comfy.mjs`，而 mcp.mjs 第 11 行无条件 import 它
//      ⇒ 整个 stdio MCP server 在 import 阶段就 `ERR_MODULE_NOT_FOUND` 退出。stdio 起不来 =
//      一个工具都没有，memory_*（上下文增强）也一起不可用。本壳在 import 之前把缺失的模块补齐
//      （源文件在 <repo>/dsh/qq-extras-patch/lib/comfy.mjs），所以插件被重装/覆盖后还能自愈。
//   2) 插件的 ownerQQ() 读 `<QQ_BRIDGE_DIR>/config.json`，而 DSH 的 MCP 配置里没地方写 env。
//      本壳把 QQ_BRIDGE_DIR 默认指到本仓库根目录（已设过就不动）。
//   3) 起不来时要在 stderr 留下一行能定位问题的话（哪个副本、comfy.mjs 补没补上）。
//
// 用法：
//   node scripts/qq-extras-mcp.mjs            # 作为 stdio MCP server 运行（DSH 用这条）
//   node scripts/qq-extras-mcp.mjs --check    # 只自检：插件目录在哪、comfy.mjs 是否就绪、桥接目录
//
// 刻意**不** import ./qq-extras-collector.mjs（那里会连带加载 src/ 下的桥接模块）：MCP server
// 的启动路径要保持精简，仓库里任何一个模块的语法错误都不该让她的工具全掉线。所以这里自带一份
// 十几行的插件目录解析（与采集器同一套候选顺序）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
/** 缺失模块的规范副本：补进插件目录的内容一字不改地来自这里。 */
const CANONICAL_COMFY = path.join(ROOT, 'dsh', 'qq-extras-patch', 'lib', 'comfy.mjs');

/** 找已安装的 dsh-qq-extras：--plugin-dir → QQ_EXTRAS_PLUGIN_DIR → 各 profile 的 node_modules。 */
export function findPluginDir({ explicit = '', env = process.env, home = os.homedir(), root = ROOT } = {}) {
  const candidates = [];
  const flag = process.argv.find((a) => a.startsWith('--plugin-dir='));
  if (flag) candidates.push(flag.slice('--plugin-dir='.length));
  const next = process.argv[process.argv.indexOf('--plugin-dir') + 1];
  if (process.argv.includes('--plugin-dir') && next && !next.startsWith('--')) candidates.push(next);
  if (explicit) candidates.push(explicit);
  if (env.QQ_EXTRAS_PLUGIN_DIR) candidates.push(env.QQ_EXTRAS_PLUGIN_DIR);
  if (env.QQ_EXTRAS_PLUGIN) candidates.push(env.QQ_EXTRAS_PLUGIN);
  for (const profile of ['web', 'desktop', 'cli']) {
    candidates.push(path.join(home, '.dsh', 'profiles', profile, 'node_modules', 'dsh-qq-extras'));
  }
  candidates.push(path.join(root, 'node_modules', 'dsh-qq-extras'));
  for (const dir of candidates) {
    if (!dir) continue;
    const abs = path.resolve(dir.replace(/^~/, home));
    if (fs.existsSync(path.join(abs, 'mcp.mjs')) && fs.existsSync(path.join(abs, 'lib', 'archive.mjs'))) return abs;
  }
  return null;
}

/** comfy.mjs 的当前状态：ok（一字不差）/ stale（有文件但内容不同）/ missing。 */
export function comfyStatus(pluginDir) {
  if (!pluginDir) return { status: 'no-plugin', target: '' };
  const target = path.join(pluginDir, 'lib', 'comfy.mjs');
  try {
    if (!fs.existsSync(target)) return { status: 'missing', target };
    const want = fs.readFileSync(CANONICAL_COMFY, 'utf8');
    const have = fs.readFileSync(target, 'utf8');
    return { status: have === want ? 'ok' : 'stale', target };
  } catch (error) {
    return { status: 'missing', target, error: error.message };
  }
}

/** 把规范副本写到插件目录；返回做了什么（identical / restored）。 */
export function installComfy(pluginDir, { dryRun = false } = {}) {
  const { status, target } = comfyStatus(pluginDir);
  if (status === 'ok') return { status: 'identical', target };
  if (!target) throw new Error('没找到 dsh-qq-extras 安装目录：先跑 dsh plugin --profile web add dsh-qq-extras');
  const body = fs.readFileSync(CANONICAL_COMFY, 'utf8');
  if (!dryRun) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, 'utf8');
  }
  return { status: 'restored', target, bytes: Buffer.byteLength(body) };
}

async function main() {
  if (process.argv.includes('--check')) {
    const pluginDir = findPluginDir();
    const comfy = comfyStatus(pluginDir);
    const report = {
      ok: !!pluginDir,
      pluginDir,
      comfy: comfy.status,
      comfyPath: comfy.target,
      canonical: CANONICAL_COMFY,
      bridgeDir: process.env.QQ_BRIDGE_DIR || ROOT,
      hasBridgeConfig: fs.existsSync(path.join(process.env.QQ_BRIDGE_DIR || ROOT, 'config.json')),
    };
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  const pluginDir = findPluginDir();
  if (!pluginDir) {
    console.error('[qq-extras] 找不到 dsh-qq-extras 安装目录：先跑 dsh plugin --profile web add dsh-qq-extras');
    return 1;
  }
  const fixed = installComfy(pluginDir);
  if (!process.env.QQ_BRIDGE_DIR) process.env.QQ_BRIDGE_DIR = ROOT;
  console.error(`[qq-extras] 启动壳：插件 ${pluginDir}；comfy.mjs ${fixed.status}；QQ_BRIDGE_DIR=${process.env.QQ_BRIDGE_DIR}`);
  // 真正的 server 在这个 import 里：它有顶层 await（server.connect），会一直挂在 stdio 上。
  await import(pathToFileURL(path.join(pluginDir, 'mcp.mjs')).href);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main()
    .then((code) => { if (code) process.exit(code); })
    .catch((error) => {
      console.error('[qq-extras] 启动失败：', error?.stack || error?.message || String(error));
      process.exit(1);
    });
}

export { ROOT, CANONICAL_COMFY, main };