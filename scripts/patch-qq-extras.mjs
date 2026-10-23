#!/usr/bin/env node
// dsh-qq-extras@0.1.0 补丁器：修掉「MCP server 起不来」的上游缺陷。
//
// 缺陷（上游，npm 上 0.0.0-stage / 0.1.0 都有）：
//   mcp.mjs 第 11 行 `import { generate, listModels, serverUp } from './lib/comfy.mjs';`
//   而包里没有 `lib/comfy.mjs` ⇒ ERR_MODULE_NOT_FOUND ⇒ stdio MCP server 一秒退出。
//   后果不是"少了画图工具"，而是**一个工具都没有**：memory_search / memory_context（上下文增强）、
//   web_sticker_send、voice_send_text、qq_self_check 全部不可用。
//
// 本脚本做两件事（都可重复执行）：
//   1) 把 `dsh/qq-extras-patch/lib/comfy.mjs` 补进已安装插件的 `lib/`（内容一字不改，缺/被换过都会补）；
//   2) 把插件自己的 `cordis.patch.yml` 从 `npx -y dsh-qq-extras@0.1.0`（每次现拉那个坏包、还依赖网络）
//      改成跑仓库里的启动壳 `node scripts/qq-extras-mcp.mjs`（壳会在 import 前自动补齐 comfy.mjs）。
//
// 为什么改插件目录里的文件而不是 profile 的 cordis.patch.yml：插件是 `dsh plugin add` 装进
// `~/.dsh/profiles/<p>/node_modules` 的，DSH 读的 bundle patch 就在那个包里；profile 级的
// cordis.patch.yml 由 scripts/setup-dsh.mjs 维护（重复插入同一个 id `mcp-qq-extras` 的行为未定义，
// 不去赌）。代价是 `dsh plugin` 重装插件会把这些改动覆盖掉 —— 所以本脚本可反复跑，且 `--check`
// 会明确报告"需要重新打补丁"（npm 上出现修好的 0.2.x 之后，这个脚本就可以退休了）。
//
// 用法：
//   node scripts/patch-qq-extras.mjs             # 打补丁（幂等）
//   node scripts/patch-qq-extras.mjs --check     # 只检查：需要打补丁就 exit 1
//   node scripts/patch-qq-extras.mjs --dry-run   # 看要改什么，不落盘
//   node scripts/patch-qq-extras.mjs --json      # 机器可读输出
//   node scripts/patch-qq-extras.mjs --revert    # 还原 cordis.patch.yml（用首次打补丁时留的 .orig）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CANONICAL_COMFY, ROOT, comfyStatus, findPluginDir, installComfy } from './qq-extras-mcp.mjs';

const WRAPPER = path.join(ROOT, 'scripts', 'qq-extras-mcp.mjs');
/** 画图很慢（SDXL 在 4060 上首图含加载模型可能一两分钟），给足调用预算。 */
const TOOL_CALL_TIMEOUT_MS = 300_000;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const name = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) { args[name] = true; continue; }
    args[name] = value;
    i += 1;
  }
  return args;
}

/** 生成目标 cordis.patch.yml：单引号 YAML 里的反斜杠是字面量，Windows 路径不用转义。 */
export function patchedCordis(options = {}) {
  const nodePath = options.nodePath || process.execPath;
  const wrapper = options.wrapper || WRAPPER;
  const timeout = Number(options.toolCallTimeoutMs) || TOOL_CALL_TIMEOUT_MS;
  return `# === qq-bridge patch BEGIN ===
# 由 scripts/patch-qq-extras.mjs 重新生成，请勿手工编辑内部条目（重复执行是安全的）。
# 原内容是 npx -y dsh-qq-extras@0.1.0：那个包漏发 lib/comfy.mjs，mcp.mjs 在 import 阶段就退出。
# 现在改为跑仓库里的启动壳，它会在加载 mcp.mjs 之前把缺失模块补齐（自愈）。
- insert:
    - id: mcp-qq-extras
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qq-extras
        transport: stdio
        command: '${nodePath}'
        args:
          - '${wrapper}'
        toolCallTimeoutMs: ${timeout}
# === qq-bridge patch END ===
`;
}

/** 这个 cordis.patch.yml 是不是已经指向我们的启动壳了。 */
export function isPatched(text) {
  return /qq-extras-mcp\.mjs/.test(String(text || ''));
}

function readMaybe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const json = !!args.json;
  const dryRun = !!args['dry-run'];
  const explicit = typeof args['plugin-dir'] === 'string' ? args['plugin-dir'] : '';
  const pluginDir = findPluginDir({ explicit });

  if (!pluginDir) {
    const out = { ok: false, reason: 'plugin-not-installed', hint: '先跑 dsh plugin --profile web add dsh-qq-extras' };
    console.log(json ? JSON.stringify(out, null, 2) : `❌ 没找到 dsh-qq-extras 安装目录：${out.hint}`);
    return 1;
  }

  const cordisFile = path.join(pluginDir, 'cordis.patch.yml');
  const current = readMaybe(cordisFile);
  const patched = isPatched(current);
  const comfy = comfyStatus(pluginDir);

  if (args.revert) {
    const orig = `${cordisFile}.orig`;
    if (!fs.existsSync(orig)) {
      console.log(json ? JSON.stringify({ ok: false, reason: 'no-orig', file: orig }, null, 2) : `❌ 没有 ${orig}，无法还原`);
      return 1;
    }
    if (!dryRun) fs.copyFileSync(orig, cordisFile);
    console.log(json ? JSON.stringify({ ok: true, reverted: cordisFile }, null, 2) : `${dryRun ? '（dry-run）' : ''}↩️  已还原 ${cordisFile}`);
    return 0;
  }

  const needComfy = comfy.status !== 'ok';
  const needCordis = !patched;
  const report = {
    ok: true,
    pluginDir,
    canonical: CANONICAL_COMFY,
    comfyFile: comfy.target,
    comfy: comfy.status,
    cordisFile,
    cordis: patched ? 'patched' : 'original',
    wrapper: WRAPPER,
    needsPatch: needComfy || needCordis,
  };

  if (args.check) {
    console.log(json ? JSON.stringify(report, null, 2) : (report.needsPatch
      ? `⚠️  需要打补丁：comfy.mjs=${report.comfy}，cordis=${report.cordis}\n   → npm run extras:patch`
      : `✅ 补丁已就位：comfy.mjs=${report.comfy}，cordis=${report.cordis}（插件 ${pluginDir}）`));
    return report.needsPatch ? 1 : 0;
  }

  if (needComfy) installComfy(pluginDir, { dryRun });
  if (needCordis) {
    if (!dryRun) {
      if (current && !fs.existsSync(`${cordisFile}.orig`)) fs.copyFileSync(cordisFile, `${cordisFile}.orig`);
      fs.writeFileSync(cordisFile, patchedCordis(), 'utf8');
    }
  }

  const done = { ...report, applied: { comfy: needComfy ? (dryRun ? 'would-restore' : 'restored') : 'unchanged', cordis: needCordis ? (dryRun ? 'would-rewrite' : 'rewritten') : 'unchanged' } };
  if (json) {
    console.log(JSON.stringify(done, null, 2));
  } else {
    console.log(`${dryRun ? '（dry-run）' : '✅'} 插件 ${pluginDir}`);
    console.log(`   comfy.mjs：${done.applied.comfy}（原状态 ${report.comfy}）`);
    console.log(`   cordis.patch.yml：${done.applied.cordis}（原状态 ${report.cordis}）`);
    if (done.applied.cordis !== 'unchanged' || done.applied.comfy !== 'unchanged') {
      console.log('   重启 DSH 后生效（bundle 在启动时读取）。');
    }
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) process.exit(main());

export { WRAPPER };