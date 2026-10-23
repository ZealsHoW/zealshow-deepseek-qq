#!/usr/bin/env node
// doctor-plugins.mjs — 自建 DSH 插件的「环境体检」。
//
// 为什么需要它
// ------------
// qq-agent-presets / qq-mode-console 是装进 DSH 进程里的插件，它们的契约分散在
// 四个地方：仓库源文件、生成的 bundle patch、DSH profile 的解析层、以及 DSH 运行时
// 的插件 seam（systemPrompt / tools / settings）。任何一处随版本变化，症状都可能只是
// 一条「agent 处理出错」，过去只能靠人翻 70 万字节的 bridge.js 猜。
//
// 本脚本把这些契约变成**一条命令 + 可执行动作**：
//   · 只读：不写文件、不改配置、不建会话；
//   · 离线检查永远执行；--offline 跳过活 DSH/SnowLuma；
//   · 每条失败/警告都带「下一步命令」和指南章节；
//   · --json 给机器读，退出码给脚本用。
//
// 用法：
//   npm run doctor                 # 完整（离线 + 活 DSH + 工具面扫描）
//   npm run doctor -- --offline    # 不连 DSH
//   npm run doctor -- --json       # 机器可读
//   npm run doctor -- --no-tools   # 跳过工具名扫描（更快）
//   npm run doctor -- --strict     # 警告也返回非 0
//
// 退出码：0 = 无失败；1 = 有失败（--strict 时有警告也算失败）。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  PLUGIN_ENV_DOC, QQ_PLUGINS, TEMPLATE_VARIABLE_SOURCES,
  analyzePresetTemplates, checkPatchFreshness, inspectParsingLayer, readProfile,
} from '../src/plugin-contract.js';
import { discoverDshSessionCookie, resolveDshBaseUrl } from '../src/dsh-client.js';
import { buildPatches } from './build-agent-preset-patches.mjs';
import { dshModulesCandidates, inspectDshModulesDir } from './dsh-modules.mjs';
import { collectDshToolNames } from './dsh-tool-names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIAG_FILES = {
  'qq-agent-presets': process.env.QQ_PLUGIN_DIAG === ''
    ? ''
    : (process.env.QQ_PLUGIN_DIAG || path.join(os.tmpdir(), 'qq-agent-presets.log')),
  'qq-mode-console': process.env.QQ_MODE_DIAG ?? path.join(os.tmpdir(), 'qq-mode-plugin.log'),
};

const STATUS_ORDER = { fail: 0, warn: 1, ok: 2, skip: 3 };
const STATUS_LABEL = { fail: '✖ 失败', warn: '⚠ 警告', ok: '✔ 通过', skip: '⏭ 跳过' };

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readPkg(dir) {
  return readJson(path.join(dir, 'package.json'));
}

function versionOfModule(modulesDir, name) {
  const pkg = readJson(path.join(modulesDir, '@deepseek-ai', name, 'package.json'));
  return pkg?.version ?? null;
}

function satisfiesNode(version, range) {
  const match = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(String(range ?? '').trim());
  if (!match) return { ok: true, required: range ?? '(未声明)' };
  const need = match.slice(1).map(Number);
  const got = String(version).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if (got[i] > need[i]) return { ok: true, required: range };
    if (got[i] < need[i]) return { ok: false, required: range };
  }
  return { ok: true, required: range };
}

function tcpProbe(rawUrl, timeoutMs = 900) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      resolve({ ok: false, error: 'URL 无法解析' });
      return;
    }
    const port = Number(url.port || (url.protocol === 'wss:' || url.protocol === 'https:' ? 443 : 80));
    const host = url.hostname;
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done({ ok: false, error: `${timeoutMs}ms 超时` }));
    socket.once('connect', () => done({ ok: true, host, port }));
    socket.once('error', (error) => done({ ok: false, error: error?.code ?? String(error) }));
  });
}

async function rpc(baseUrl, cookie, method, args = {}, timeoutMs = 4000) {
  const rpcId = `doctor-${randomUUID().slice(0, 8)}`;
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = await response.json();
  if (body?.result?.error) throw new Error(`${method}: ${body.result.error.message ?? JSON.stringify(body.result.error)}`);
  return body?.result?.value ?? body?.result;
}

function parseDiagLog(plugin) {
  const file = DIAG_FILES[plugin];
  if (!file || !fs.existsSync(file)) return { file, exists: false, entries: [], lastApply: null };
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-80);
  } catch (error) {
    return { file, exists: true, error: String(error?.message ?? error), entries: [], lastApply: null };
  }
  const entries = [];
  for (const line of lines) {
    const jsonStart = line.indexOf('{');
    if (jsonStart < 0) continue;
    try {
      entries.push(JSON.parse(line.slice(jsonStart)));
    } catch { /* 旧文本格式在下面兜底 */ }
  }
  let lastApply = [...entries].reverse().find((entry) => entry?.event === 'apply') ?? null;
  if (!lastApply) {
    // 0.1.x 时代 qq-mode-console 的纯文本日志。
    const text = lines.filter((line) => /apply called/.test(line)).at(-1);
    if (text) lastApply = { raw: text };
  }
  return { file, exists: true, entries, lastApply };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function bridgeStatus({ root }) {
  const stateDir = path.join(root, 'state');
  const lockFile = path.join(stateDir, 'bridge.lock');
  const aliveFile = path.join(stateDir, 'last-alive.json');
  const lock = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8').trim() : '';
  const pid = /^\d+$/.test(lock) ? Number(lock) : null;
  let alive = false;
  if (pid) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch { /* ESRCH：进程不在 / 权限不足 */ }
  }
  let lastAliveAt = null;
  const aliveDoc = readJson(aliveFile);
  if (Number.isFinite(aliveDoc?.at)) lastAliveAt = aliveDoc.at;
  return { lockFile, pid, alive, lastAliveAt, ageMs: lastAliveAt ? Date.now() - lastAliveAt : null };
}

/**
 * 执行一次体检。纯只读；返回可直接 JSON 化的报告。
 *
 * @param {{
 *   root?: string, dshHome?: string, profile?: string, baseUrl?: string,
 *   offline?: boolean, tools?: boolean, snowluma?: boolean, timeoutMs?: number,
 * }} [options]
 */
export async function runDoctor(options = {}) {
  const root = options.root ?? ROOT;
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const offline = options.offline === true;
  const tools = options.tools !== false;
  const snowluma = options.snowluma !== false;
  const timeoutMs = options.timeoutMs ?? 4000;
  const checks = [];
  const add = (id, title, status, detail = '', extra = {}) => {
    checks.push({ id, title, status, detail, actions: extra.actions ?? [], doc: extra.doc ?? null, data: extra.data });
  };

  const pkg = readJson(path.join(root, 'package.json'), {});
  const config = readJson(path.join(root, 'config.json'), {});
  const baseUrl = resolveDshBaseUrl(options.baseUrl, { root });

  // ── 1. 基础环境 ────────────────────────────────────────────────────────────
  {
    const nodeOk = satisfiesNode(process.versions.node, pkg?.engines?.node);
    add(
      'node',
      'Node.js 版本',
      nodeOk.ok ? 'ok' : 'fail',
      `当前 ${process.versions.node}；要求 ${nodeOk.required}`,
      nodeOk.ok ? {} : { actions: ['升级 Node.js 后重跑 npm run doctor'] },
    );
  }

  {
    const required = [
      'plugins/qq-agent-presets/package.json',
      'plugins/qq-agent-presets/qq-prompt-vars.mjs',
      'plugins/qq-agent-presets/qq-tool-restrict.mjs',
      'plugins/qq-mode-console/package.json',
      'dsh/agent-presets/qq-chat/agent.cordis.yml',
      'dsh/agent-presets/qq-chat-v2/agent.cordis.yml',
      'src/plugin-contract.js',
    ];
    const missing = required.filter((rel) => !fs.existsSync(path.join(root, rel)));
    add(
      'repo',
      '仓库与插件文件',
      missing.length === 0 ? 'ok' : 'fail',
      missing.length === 0 ? `${pkg.name ?? '?'}@${pkg.version ?? '?'}` : `缺少：${missing.join(', ')}`,
      missing.length === 0 ? {} : { actions: [`确认当前目录是 qq-bridge 仓库根：${root}`] },
    );
  }

  {
    if (!config || typeof config !== 'object' || Object.keys(config).length === 0) {
      add('config', '运行配置', 'fail', 'config.json 不存在或不是合法 JSON', {
        actions: ['复制 config.example.json 为 config.json 后再启动桥接'],
      });
    } else {
      const groups = config.allow?.groups?.length ?? 0;
      const privateChats = config.allow?.private?.length ?? 0;
      const detail = `dsh.baseUrl=${config.dsh?.baseUrl ?? '(默认)'}；consolePort=${config.consolePort ?? 3100}；`
        + `白名单 group=${groups} private=${privateChats}；SnowLuma=${config.snowluma?.wsUrl ?? '(默认)'}`;
      const problems = [];
      if (!config.dsh?.baseUrl) problems.push('dsh.baseUrl 未配置');
      if (groups === 0 && privateChats === 0) problems.push('allow 白名单为空（allowAllWhenEmpty 会放开所有目标）');
      add(
        'config',
        '运行配置',
        problems.length === 0 ? 'ok' : 'warn',
        problems.length === 0 ? detail : `${detail}；${problems.join('；')}`,
        problems.length === 0 ? {} : { actions: ['在控制台或 config.json 补全配置；指南 §3.9'] },
      );
    }
  }

  {
    const overrides = ['DSH_HOME', 'DSH_PROFILE', 'DSH_INSTALL_MODULES', 'DSH_MODULES', 'DSH_RUNTIME_DIR', 'DSH_TOOL_PACKAGES', 'QQ_PLUGIN_DIAG']
      .filter((key) => process.env[key])
      .map((key) => `${key}=${process.env[key]}`);
    add('env', '环境变量', 'ok', overrides.length ? overrides.join('；') : '（无覆盖，全部走默认/配置文件）');
  }

  // ── 2. 仓库侧契约 ──────────────────────────────────────────────────────────
  {
    let stale = [];
    let error = null;
    try {
      stale = buildPatches({ check: true }).filter((result) => result.changed);
    } catch (failure) {
      error = failure;
    }
    if (error) {
      add('preset-patches', 'preset patch 与源一致', 'fail', `生成器报错：${error.message}`, {
        actions: ['node scripts/build-agent-preset-patches.mjs'],
        doc: `${PLUGIN_ENV_DOC}#preset-bundle`,
      });
    } else {
      add(
        'preset-patches',
        'preset patch 与源一致',
        stale.length === 0 ? 'ok' : 'fail',
        stale.length === 0 ? '2 个 patch 与 dsh/agent-presets 源逐字一致' : `${stale.length} 个 patch 过期`,
        stale.length === 0 ? {} : {
          actions: ['node scripts/build-agent-preset-patches.mjs', '重启 DSH 使新 preset 生效'],
          doc: `${PLUGIN_ENV_DOC}#preset-bundle`,
        },
      );
    }
  }

  {
    const analysis = analyzePresetTemplates({ root });
    const unknown = analysis.unknown.map((u) => `${u.preset}:{{${u.variable}}}`);
    const vars = new Map();
    for (const preset of analysis.presets) for (const name of preset.variables) vars.set(name, (vars.get(name) ?? 0) + 1);
    if (analysis.errors.length > 0) {
      add('preset-variables', 'preset 模板变量', 'fail', analysis.errors.map((e) => e.message).join('；'), {
        actions: [`检查 dsh/agent-presets 下的 YAML 是否合法`], doc: `${PLUGIN_ENV_DOC}#prompt-variable`,
      });
    } else {
      add(
        'preset-variables',
        'preset 模板变量',
        unknown.length === 0 ? 'ok' : 'fail',
        unknown.length === 0
          ? `全部有来源：${[...vars.keys()].join(', ')}`
          : `没有已知来源：${unknown.join(', ')}（来源表：${Object.keys(TEMPLATE_VARIABLE_SOURCES).join(', ')}）`,
        unknown.length === 0 ? {} : {
          actions: [
            '若模板确实需要该变量：确认 DSH 运行时真的注册了它，并在 src/plugin-contract.js 的 TEMPLATE_VARIABLE_SOURCES 登记',
            '否则从 persona 模板删掉该 {{变量}}',
          ],
          doc: `${PLUGIN_ENV_DOC}#prompt-variable`,
        },
      );
    }
  }

  {
    const problems = [];
    // doctor 是只读的：这里会真的执行插件的 apply（检查契约），但**不能**把诊断
    // 写进生产日志 —— 否则下次体检会把“doctor 自己”误认成 DSH 装配。
    const previousDiag = process.env.QQ_PLUGIN_DIAG;
    const previousModeDiag = process.env.QQ_MODE_DIAG;
    process.env.QQ_PLUGIN_DIAG = '';
    process.env.QQ_MODE_DIAG = '';
    try {
      const promptVars = await import(pathToFileURL(path.join(root, 'plugins/qq-agent-presets/qq-prompt-vars.mjs')).href);
      const registered = new Set();
      promptVars.apply({
        systemPrompt: { variable: (name) => registered.add(name) },
      });
      if (!registered.has('cwd')) problems.push('qq-prompt-vars 没有注册 cwd');
      const guard = await import(pathToFileURL(path.join(root, 'plugins/qq-agent-presets/qq-tool-restrict.mjs')).href);
      let guardFn = null;
      const restricted = [];
      guard.apply({
        tools: {
          restrict: ({ deny }) => restricted.push(...deny),
          guard: (fn) => { guardFn = fn; },
        },
      });
      if (!restricted.includes('pwsh')) problems.push('守卫 restrict 名单缺少 pwsh');
      if (typeof guardFn !== 'function') problems.push('守卫没有注册执行期白名单');
      else {
        if (typeof guardFn({ name: 'bash' }) !== 'string') problems.push('守卫没有拒绝本地工具 bash');
        if (guardFn({ name: 'mcp__snowluma__qq_send_message' }) !== undefined) problems.push('守卫误拒了 QQ MCP 工具');
      }
      const mode = await import(pathToFileURL(path.join(root, 'plugins/qq-mode-console/lib/index.js')).href);
      if (!mode.Config) problems.push('qq-mode-console 没有导出 Config');
      const modePatch = yaml.load(fs.readFileSync(path.join(root, 'plugins/qq-mode-console/cordis.patch.yml'), 'utf8'));
      const entry = modePatch?.[0]?.insert?.[0];
      if (entry?.id !== 'qq-mode') problems.push(`cordis.patch.yml 的 entry id 必须是 qq-mode（实际 ${entry?.id}）`);
    } catch (error) {
      problems.push(error?.message ?? String(error));
    } finally {
      if (previousDiag === undefined) delete process.env.QQ_PLUGIN_DIAG;
      else process.env.QQ_PLUGIN_DIAG = previousDiag;
      if (previousModeDiag === undefined) delete process.env.QQ_MODE_DIAG;
      else process.env.QQ_MODE_DIAG = previousModeDiag;
    }
    add(
      'plugin-contract',
      '插件静态契约（离线执行 apply）',
      problems.length === 0 ? 'ok' : 'fail',
      problems.length === 0 ? 'prompt-vars / guard / mode 三份契约均可执行' : problems.join('；'),
      problems.length === 0 ? {} : { actions: ['npm run test:audit；指南 §4'], doc: `${PLUGIN_ENV_DOC}#plugin-degradation` },
    );
  }

  // ── 3. profile 与解析层 ────────────────────────────────────────────────────
  const profileNames = (() => {
    try {
      return fs.readdirSync(path.join(dshHome, 'profiles'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  })();
  const explicitProfile = options.profile || process.env.DSH_PROFILE;
  const profiles = [];
  for (const name of profileNames) {
    const info = readProfile({ dshHome, profile: name });
    const relevant = info.bundles.includes('qq-agent-presets') || info.bundles.includes('qq-mode-console');
    if (relevant || name === explicitProfile) profiles.push(info);
  }
  const active = explicitProfile && profiles.find((p) => p.profile === explicitProfile)
    ? profiles.find((p) => p.profile === explicitProfile)
    : (profiles.find((p) => p.profile === 'desktop') ?? profiles[0] ?? null);

  {
    const details = [];
    const actions = [];
    let status = 'ok';
    for (const info of profiles) {
      const relevant = info.bundles.includes('qq-agent-presets') || info.bundles.includes('qq-mode-console');
      const fails = info.issues.filter((issue) => issue.severity === 'fail');
      const warns = info.issues.filter((issue) => issue.severity !== 'fail');
      if (fails.length > 0 || warns.length > 0) {
        details.push(`${info.profile}: ${[...fails, ...warns].map((issue) => issue.code).join(', ')}`);
        for (const issue of [...fails, ...warns]) actions.push(`${info.profile}: ${issue.action}`);
        if (fails.length > 0 && (info === active || !explicitProfile)) status = 'fail';
        else if (fails.length > 0 || warns.length > 0) status = status === 'fail' ? 'fail' : 'warn';
      } else if (relevant) {
        details.push(`${info.profile}: link/bundles 正常`);
      }
    }
    if (profiles.length === 0) {
      status = 'fail';
      details.push(`没有找到安装 qq-* 插件的 profile（${path.join(dshHome, 'profiles')}）`);
      actions.push('node scripts/setup-dsh.mjs <profile>');
    }
    add('profile-wiring', 'profile 安装与解析', status, details.join('；'), {
      actions: [...new Set(actions)].slice(0, 6),
      doc: `${PLUGIN_ENV_DOC}#profile-wiring`,
      data: { active: active?.profile ?? null, profiles: profiles.map((p) => p.profile) },
    });
  }

  {
    const layer = inspectParsingLayer({ dshHome });
    if (!layer.exists) {
      add('parsing-layer', 'profile 共享解析层', 'skip', `${path.join(dshHome, 'profiles', 'node_modules')} 不存在`);
    } else if (layer.broken.length === 0) {
      add('parsing-layer', 'profile 共享解析层', 'ok', `${layer.healthy} 个有效链接/目录，0 个断链`);
    } else {
      const samples = layer.broken.slice(0, 3).map((item) => `${item.name} → ${item.target}`).join('；');
      add(
        'parsing-layer',
        'profile 共享解析层',
        'warn',
        `${layer.broken.length}/${layer.total} 个 @deepseek-ai 链接指向已删除的位置（示例：${samples}）`,
        {
          actions: [
            '这通常是 DSH 换安装位置后留下的旧链接；DSH 本身用 app.asar 里的运行时，可能仍正常',
            '$env:ELECTRON_RUN_AS_NODE=1; & "<DSH>\\DeepSeek Harness.exe" scripts\\extract-asar-runtime.mjs --asar="<DSH>\\resources\\app.asar"',
            'node scripts/repair-profile-links.mjs --apply --prune --repoint-outdated（重指向/清理断链，自动备份旧目标）',
            'npm run doctor',
          ],
          doc: `${PLUGIN_ENV_DOC}#old-install-links`,
        },
      );
    }
  }

  if (profiles.length > 1) {
    const fingerprint = (info) => JSON.stringify({
      deps: QQ_PLUGINS.map((name) => [name, info.dependencies[name] ?? null]),
      bundles: [...info.bundles].filter((name) => QQ_PLUGINS.includes(name)).sort(),
      links: info.plugins.map((plugin) => ({ name: plugin.name, resolved: plugin.resolved, installed: plugin.installed })),
    });
    const reference = active ?? profiles[0];
    const drift = profiles.filter((info) => fingerprint(info) !== fingerprint(reference));
    add(
      'profile-duplication',
      '多个 profile 都装了 qq-* 插件',
      drift.length === 0 ? 'ok' : 'warn',
      drift.length === 0
        ? `${profiles.map((p) => p.profile).join(', ')} 的 link:/bundles/插件目录完全一致（${reference.profile} 活跃，其余可作备份/CLI）`
        : `与 ${reference.profile} 不一致：${drift.map((p) => p.profile).join(', ')}（link:/bundles/插件目录有漂移）`,
      drift.length === 0 ? {} : {
        actions: ['用 DSH_PROFILE 明确当前在跑的 profile；对漂移的那个重跑 node scripts/setup-dsh.mjs <profile>'],
        doc: `${PLUGIN_ENV_DOC}#profile-wiring`,
      },
    );
  }

  // ── 4. DSH 运行时与工具面 ──────────────────────────────────────────────────
  const candidates = dshModulesCandidates();
  const goodModules = candidates.find((candidate) => candidate.ok) ?? null;
  let dshVersion = null;

  const explicitModules = process.env.DSH_INSTALL_MODULES || process.env.DSH_MODULES;
  if (explicitModules) {
    const info = inspectDshModulesDir(explicitModules);
    add(
      'dsh-modules-env',
      'DSH_INSTALL_MODULES 显式覆盖',
      info.ok ? 'ok' : 'fail',
      info.ok
        ? `${info.dir}（有效；已优先于自动探测）`
        : `${info.dir} 无效：${info.reason}。脚本会拒绝静默回退到其它目录。`,
      info.ok ? {} : {
        actions: [
          '改指向 <DSH 运行时解包目录>/node_modules',
          '或删除 DSH_INSTALL_MODULES / DSH_MODULES 后重试',
        ],
        doc: `${PLUGIN_ENV_DOC}#dsh-runtime`,
      },
    );
  }
  if (!goodModules) {
    add(
      'dsh-modules',
      'DSH 运行时定位',
      'fail',
      candidates.filter((c) => c.exists).map((c) => `${c.dir}（${c.reason}）`).join('；') || '没有任何候选目录',
      {
        actions: [
          '设置 DSH_INSTALL_MODULES=<DSH 运行时解包目录>/node_modules',
          '$env:ELECTRON_RUN_AS_NODE=1; & "<DSH>\\DeepSeek Harness.exe" scripts\\extract-asar-runtime.mjs --asar="<DSH>\\resources\\app.asar"',
        ],
        doc: `${PLUGIN_ENV_DOC}#dsh-runtime`,
      },
    );
  } else {
    dshVersion = versionOfModule(goodModules.dir, 'dsh-app-boot')
      ?? versionOfModule(goodModules.dir, 'dsh')
      ?? versionOfModule(goodModules.dir, 'dsh-tools');
    const source = goodModules.source;
    const stableRoot = path.join(dshHome, 'runtime');
    const fromStable = goodModules.dir.startsWith(`${path.resolve(stableRoot)}${path.sep}`);
    // 注意：稳定副本路径里也含 "runtime"，不能用 /runtime/ 粗判解包副本。
    const fromExtract = !fromStable && /asar|runtime-extract/i.test(source);
    add(
      'dsh-modules',
      'DSH 运行时定位',
      'ok',
      `${goodModules.dir}（来源：${source}；${dshVersion ?? '版本未知'}）`,
      {},
    );
    if (fromStable) {
      const versionDir = path.dirname(goodModules.dir);
      const manifest = readJson(path.join(versionDir, 'manifest.json'));
      if (!manifest) {
        add(
          'dsh-modules-freshness',
          'DSH 运行时副本新鲜度',
          'warn',
          `稳定副本缺少 manifest：${versionDir}`,
          {
            actions: ['删除该副本后用 scripts/extract-asar-runtime.mjs（Electron）重新解包，或用 sync-dsh-runtime 指定真实解包目录'],
            doc: `${PLUGIN_ENV_DOC}#dsh-runtime`,
          },
        );
      } else {
        const asarPath = manifest.sourceAsar;
        let stale = false;
        if (asarPath && Number.isFinite(manifest.sourceAsarMtimeMs) && fs.existsSync(asarPath)) {
          try { stale = fs.statSync(asarPath).mtimeMs > manifest.sourceAsarMtimeMs + 1000; } catch { /* 忽略 */ }
        }
        add(
          'dsh-modules-freshness',
          'DSH 运行时副本新鲜度',
          stale ? 'warn' : 'ok',
          stale
            ? `安装包比稳定副本新：${asarPath}（副本 ${manifest.version}，${manifest.copiedAt}）`
            : `稳定副本 ${manifest.version}（复制于 ${manifest.copiedAt}${asarPath ? `；源 ${asarPath}` : ''}）`,
          stale ? {
            actions: [
              '$env:ELECTRON_RUN_AS_NODE=1; & "<DSH>\\DeepSeek Harness.exe" scripts\\extract-asar-runtime.mjs --asar="<DSH>\\resources\\app.asar" --force',
              'node scripts/repair-profile-links.mjs --apply --prune --repoint-outdated',
              'npm run doctor',
            ],
            doc: `${PLUGIN_ENV_DOC}#dsh-runtime`,
          } : {},
        );
      }
    } else if (fromExtract) {
      add(
        'dsh-modules-freshness',
        'DSH 运行时副本新鲜度',
        'warn',
        `工具面扫描用的是工作区里的 app.asar 解包副本（${goodModules.dir}）；DSH 升级或仓库搬动后它可能过期/失效`,
        {
          actions: [
            '$env:ELECTRON_RUN_AS_NODE=1; & "<DSH>\\DeepSeek Harness.exe" scripts\\extract-asar-runtime.mjs --asar="<DSH>\\resources\\app.asar"',
            'node scripts/repair-profile-links.mjs --apply --prune --repoint-outdated（把 profile 链接指向新副本）',
            'npm run doctor',
          ],
          doc: `${PLUGIN_ENV_DOC}#dsh-runtime`,
        },
      );
    }
  }

  if (!tools) {
    add('tool-scan', '工具面与守卫对账', 'skip', '--no-tools');
  } else if (!goodModules) {
    add('tool-scan', '工具面与守卫对账', 'skip', '运行时未定位，无法扫描');
  } else {
    const started = Date.now();
    try {
      const guardPath = path.join(root, 'plugins/qq-agent-presets/qq-tool-restrict.mjs');
      const guard = await import(pathToFileURL(guardPath).href);
      const guarded = new Set(guard.RESTRICTED_TOOL_NAMES ?? []);
      const trackedAbsent = new Set(guard.TRACKED_ABSENT_TOOL_NAMES ?? []);
      const { names, packages } = collectDshToolNames({
        packagesDir: path.join(goodModules.dir, '@deepseek-ai'),
        pluginDirs: [path.join(dshHome, 'plugins')],
      });
      const fabricated = [...guarded].filter((name) => !name.startsWith('dev_') && !names.has(name) && !trackedAbsent.has(name));
      const returned = [...trackedAbsent].filter((name) => names.has(name));
      const dangerousUncovered = [...names.keys()].filter((name) => /(pwsh|bash|exec|spawn|terminal|subagent|workflow|ralph|plugin_manager|schedule_|dev_)/.test(name)
        && !guarded.has(name) && !['ask_user_question', 'todo_write'].includes(name));
      const elapsed = Date.now() - started;
      const problems = [];
      if (fabricated.length > 0) problems.push(`守卫名单里有当前安装不存在的名字：${fabricated.join(', ')}`);
      if (returned.length > 0) problems.push(`已知缺失清单里的工具重新出现：${returned.join(', ')}（需移出清单并复核）`);
      if (dangerousUncovered.length > 0) problems.push(`候选里存在未覆盖的危险语义工具：${dangerousUncovered.join(', ')}`);
      add(
        'tool-scan',
        '工具面与守卫对账',
        problems.length === 0 ? 'ok' : 'fail',
        problems.length === 0
          ? `扫描 ${packages.length} 个包、${names.size} 个工具名；守卫 ${guarded.size} 个（已知缺失 ${trackedAbsent.size} 个仍缺失）；${elapsed}ms`
          : problems.join('；'),
        problems.length === 0 ? {} : {
          actions: ['node scripts/scan-dsh-tool-names.mjs --missing', '按输出更新 qq-tool-restrict.mjs 的名单/已知缺失清单'],
          doc: `${PLUGIN_ENV_DOC}#tool-drift`,
        },
      );
    } catch (error) {
      add('tool-scan', '工具面与守卫对账', 'fail', `扫描失败：${error?.message ?? error}`, {
        actions: ['设置 DSH_INSTALL_MODULES 后重试；指南 §3.5'],
        doc: `${PLUGIN_ENV_DOC}#tool-drift`,
      });
    }
  }

  // ── 5. 插件装配诊断 ────────────────────────────────────────────────────────
  {
    const details = [];
    let status = 'ok';
    for (const plugin of ['qq-agent-presets', 'qq-mode-console']) {
      const log = parseDiagLog(plugin);
      if (!log.exists) {
        details.push(`${plugin}: 无诊断文件（${log.file || '未配置'}）`);
        status = status === 'fail' ? 'fail' : 'warn';
        continue;
      }
      if (log.error) {
        details.push(`${plugin}: 读取失败 ${log.error}`);
        status = 'warn';
        continue;
      }
      if (!log.lastApply) {
        details.push(`${plugin}: 有诊断文件但没有 apply 记录`);
        status = 'warn';
        continue;
      }
      const when = log.lastApply.t ?? (log.lastApply.raw?.match(/^\[([^\]]+)\]/)?.[1]) ?? '?';
      const pid = Number(log.lastApply.pid);
      const pidAlive = Number.isInteger(pid) && pid > 0 ? isPidAlive(pid) : null;
      if (pidAlive === false) {
        // 测试/上一次进程也会写同一个临时文件；只认“写日志的进程还活着”的证据。
        details.push(`${plugin}: 最近 apply ${when} 来自已退出进程 pid=${pid}（可能是测试或上次运行）`);
        status = 'warn';
      } else if (pidAlive === true) {
        details.push(`${plugin}: 上次 apply ${when}（pid ${pid} 仍在运行）`);
      } else {
        details.push(`${plugin}: 上次 apply ${when}（旧日志无 pid，无法确认进程）`);
      }
      // 即使 pid 的判断不充分，也能比较“插件文件 mtime vs 最后装配时间”：
      // 文件更新说明当前 DSH 仍在跑旧代码，必须重启才能生效。
      const sourceFiles = plugin === 'qq-agent-presets'
        ? ['qq-plugin-runtime.mjs', 'qq-prompt-vars.mjs', 'qq-tool-restrict.mjs'].map((name) => path.join(root, 'plugins/qq-agent-presets', name))
        : [path.join(root, 'plugins/qq-mode-console/lib/index.js')];
      const applyTime = Date.parse(when);
      if (Number.isFinite(applyTime)) {
        const newest = sourceFiles.reduce((max, file) => {
          try { return Math.max(max, fs.statSync(file).mtimeMs); } catch { return max; }
        }, 0);
        if (newest > applyTime) {
          details.push(`${plugin}: 插件文件比最后一次装配新，当前 DSH 仍在跑旧代码`);
          status = 'warn';
        }
      }
    }
    if (status !== 'ok') {
      add('plugin-load', '插件装配诊断', status, details.join('；'), {
        actions: [
          '重启 DSH 让新插件代码生效；确认 QQ_PLUGIN_DIAG 指向可写目录',
          '若重启后仍无记录：检查 profile bundles 与 node_modules 链接（见上一条）',
        ],
        doc: `${PLUGIN_ENV_DOC}#plugin-load`,
      });
    } else {
      add('plugin-load', '插件装配诊断', 'ok', details.join('；'));
    }
  }

  // ── 6. 桥接与外部服务 ──────────────────────────────────────────────────────
  {
    const bridge = bridgeStatus({ root });
    if (!bridge.pid) {
      add('bridge', '桥接进程', 'warn', 'state/bridge.lock 不存在或没有 PID', {
        actions: ['启动 start.bat；若桥接本不该运行可忽略'],
      });
    } else if (!bridge.alive) {
      add('bridge', '桥接进程', 'warn', `锁文件 PID ${bridge.pid} 已不在运行（过期锁）`, {
        actions: ['启动 start.bat；若确认没有实例，可删除 state/bridge.lock'],
      });
    } else if (bridge.ageMs !== null && bridge.ageMs > 120_000) {
      add('bridge', '桥接进程', 'warn', `PID ${bridge.pid} 在运行，但心跳已 ${(bridge.ageMs / 1000).toFixed(0)}s 未更新`, {
        actions: ['查看 state/bridge.log 末尾；必要时重启 start.bat'],
      });
    } else {
      add('bridge', '桥接进程', 'ok', `PID ${bridge.pid} 运行中；最近心跳 ${bridge.ageMs === null ? '未知' : `${(bridge.ageMs / 1000).toFixed(0)}s 前`}`);
    }
  }

  if (snowluma) {
    const wsUrl = config.snowluma?.wsUrl ?? 'ws://127.0.0.1:3001';
    const probe = await tcpProbe(wsUrl);
    add(
      'snowluma',
      'SnowLuma 网关',
      probe.ok ? 'ok' : 'warn',
      probe.ok ? `${wsUrl} 可连接` : `${wsUrl} 连接失败（${probe.error}）；SnowLuma 没启动时可忽略`,
      probe.ok ? {} : { actions: ['启动 SnowLuma；或在 config.json 更新 snowluma.wsUrl；指南 §3.6'] },
    );
  }

  // ── 7. 活 DSH ──────────────────────────────────────────────────────────────
  if (offline) {
    add('live-dsh', '活 DSH 接口', 'skip', '--offline');
  } else {
    const cookie = discoverDshSessionCookie(baseUrl);
    if (!cookie) {
      add('live-dsh', '活 DSH 接口', 'fail', `读不到 ${baseUrl} 的会话密钥，无法铸造 Cookie`, {
        actions: ['确认 DSH 正在运行且 DSH_HOME 指向正确；npm run test:dsh-auth'],
        doc: `${PLUGIN_ENV_DOC}#dsh-auth`,
      });
    } else {
      try {
        const describe = await rpc(baseUrl, cookie, 'settings/describe', {}, timeoutMs);
        const namespaces = describe?.namespaces ?? [];
        const qqMode = namespaces.find((entry) => entry.ns === 'qq-mode');
        add('live-dsh', '活 DSH 接口', 'ok', `${baseUrl} 可达；${namespaces.length} 个 settings 命名空间`);
        if (!qqMode) {
          add('live-qq-mode', 'qq-mode 设置命名空间', 'fail', 'settings/describe 里没有 qq-mode', {
            actions: ['确认 profile 的 cordis.patch.yml entry id 是 qq-mode；node scripts/setup-dsh.mjs <profile>'],
            doc: `${PLUGIN_ENV_DOC}#settings-namespace`,
          });
        } else {
          const schemaText = JSON.stringify(qqMode);
          const fields = ['mode', 'ownerQQ'].filter((field) => new RegExp(`"${field}"`).test(schemaText));
          const missingFields = ['mode', 'ownerQQ'].filter((field) => !fields.includes(field));
          add(
            'live-qq-mode',
            'qq-mode 设置命名空间',
            missingFields.length === 0 ? 'ok' : 'fail',
            missingFields.length === 0
              ? `存在（autoGenerate=${qqMode.autoGenerate}；字段 ${fields.join('/')} 可写）`
              : `存在，但 schema 缺少字段：${missingFields.join(', ')}（可能是 Config 导出被改/DSH 设置推导变化）`,
            missingFields.length === 0 ? {} : {
              actions: ['检查 plugins/qq-mode-console/lib/index.js 的 Config；node scripts/test-qq-mode-plugin.mjs'],
              doc: `${PLUGIN_ENV_DOC}#settings-namespace`,
            },
          );
        }
        const presets = await rpc(baseUrl, cookie, 'agentPresets/list', {}, timeoutMs);
        const ids = (presets?.presets ?? []).map((preset) => preset.id);
        const missingPresets = ['qq-chat', 'qq-chat-v2'].filter((id) => !ids.includes(id));
        add(
          'live-presets',
          'agent preset 注册表',
          missingPresets.length === 0 ? 'ok' : 'fail',
          missingPresets.length === 0 ? `qq-chat / qq-chat-v2 在列（共 ${ids.length} 个）` : `缺少：${missingPresets.join(', ')}`,
          missingPresets.length === 0 ? {} : {
            actions: ['node scripts/build-agent-preset-patches.mjs && node scripts/setup-dsh.mjs <profile>，然后重启 DSH'],
            doc: `${PLUGIN_ENV_DOC}#preset-bundle`,
          },
        );
      } catch (error) {
        add('live-dsh', '活 DSH 接口', 'fail', `${baseUrl} 请求失败：${error?.message ?? error}`, {
          actions: [
            '确认 config.json 的 dsh.baseUrl 与当前 GUI 地址一致（看窗口标题/DSH_WEB_URL）',
            '端口变化时优先改 config.json，而不是改脚本',
            'npm run test:dsh-auth',
          ],
          doc: `${PLUGIN_ENV_DOC}#dsh-port`,
        });
      }
    }
  }

  // ── 8. 最近的环境事故 ──────────────────────────────────────────────────────
  {
    const incidents = path.join(root, 'state', 'env-incidents.jsonl');
    if (!fs.existsSync(incidents)) {
      add('incidents', '最近环境事故', 'skip', '还没有环境类事故记录（这是好事）');
    } else {
      const lines = fs.readFileSync(incidents, 'utf8').split(/\r?\n/).filter(Boolean).slice(-5);
      const parsed = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const detail = parsed.map((item) => `${item.t ?? '?'} ${item.code ?? '?'} (${item.key ?? '?'})`).join('；');
      add('incidents', '最近环境事故', parsed.length ? 'warn' : 'skip', detail || '记录无法解析', {
        actions: ['对照上面的失败项修复；指南 §3'],
        doc: `${PLUGIN_ENV_DOC}#incidents`,
      });
    }
  }

  const summary = {
    ok: checks.filter((check) => check.status === 'ok').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    skip: checks.filter((check) => check.status === 'skip').length,
  };

  return {
    generatedAt: new Date().toISOString(),
    env: {
      root,
      dshHome,
      profile: active?.profile ?? explicitProfile ?? null,
      profiles: profiles.map((info) => info.profile),
      baseUrl,
      node: process.versions.node,
      dshVersion,
      modulesDir: goodModules?.dir ?? null,
      pluginVersions: {
        'qq-agent-presets': readPkg(path.join(root, 'plugins/qq-agent-presets'))?.version ?? null,
        'qq-mode-console': readPkg(path.join(root, 'plugins/qq-mode-console'))?.version ?? null,
      },
    },
    checks,
    summary,
  };
}

function printReport(report, { verbose = false } = {}) {
  console.log(`\nQQ 桥接插件环境体检  ${report.env.pluginVersions['qq-agent-presets'] ?? ''}  [只读]`);
  console.log(`时间 ${report.generatedAt}   Node ${report.env.node}   DSH ${report.env.dshVersion ?? '未知'}`);
  console.log(`仓库 ${report.env.root}`);
  console.log(`profile ${report.env.profile ?? '(未找到)'}   baseUrl ${report.env.baseUrl}`);
  console.log(`DSH modules ${report.env.modulesDir ?? '(未定位)'}\n`);

  const sorted = [...report.checks].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  for (const check of sorted) {
    if (!verbose && check.status === 'ok' && !check.detail) continue;
    console.log(`${STATUS_LABEL[check.status]}  ${check.title}`);
    if (check.detail && (verbose || check.status !== 'ok')) console.log(`      ${check.detail}`);
    for (const action of check.actions ?? []) console.log(`      → ${action}`);
    if (check.doc) console.log(`      → 指南 ${check.doc}`);
  }

  const { ok, warn, fail, skip } = report.summary;
  console.log(`\n结果：${ok} 通过，${warn} 警告，${fail} 失败，${skip} 跳过`);
  if (fail > 0) {
    console.log('下一步：先处理「失败」项（按每项下面的 → 命令），再重跑 npm run doctor。');
    console.log(`完整手册：${PLUGIN_ENV_DOC}`);
  } else if (warn > 0) {
    console.log('没有失败项；警告项建议在下次重启 DSH/桥接前处理。');
  } else {
    console.log('全部通过。');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const report = await runDoctor({
    offline: args.includes('--offline'),
    tools: !args.includes('--no-tools'),
    snowluma: !args.includes('--no-snowluma'),
    profile: args.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length),
    baseUrl: args.find((arg) => arg.startsWith('--base-url='))?.slice('--base-url='.length),
  });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, { verbose: args.includes('--verbose') });
  }
  const strict = args.includes('--strict');
  process.exitCode = report.summary.fail > 0 || (strict && report.summary.warn > 0) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('doctor 崩溃：', error);
    process.exitCode = 2;
  });
}
