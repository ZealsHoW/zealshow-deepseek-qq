#!/usr/bin/env node
// dsh-qq-extras 归档器（桥接版）。
//
// 背景：dsh-qq-extras 自带的 collector.mjs 读的是 `<BRIDGE_DIR>/state/qq-activity.log`，
// 只认 `管理员 <名>：` / `agent 回复：` 两种说话人，而桥接的活动日志是
// `[HH:MM:SS] <key> [tag] 消息已入未读：<text>`（不带说话人身份）——一条都匹配不上。
// 我们没有改活动日志的格式（它被控制台 UI 与既有测试消费），而是让桥接多写一份
// `state/qq-memory.log`（见 src/qqb/memory-log.mjs），由这个脚本喂给插件的归档库。
//
// 用法：
//   node scripts/qq-extras-collector.mjs                # 采一轮就退出（适合计划任务）
//   node scripts/qq-extras-collector.mjs --watch        # 常驻轮询
//   node scripts/qq-extras-collector.mjs --dry-run      # 只统计不落盘
//   node scripts/qq-extras-collector.mjs --status       # 只看归档现状
//   node scripts/qq-extras-collector.mjs --no-summary   # 不触发摘要（省 token）
// 选项：--log <file> --data-dir <dir> --plugin-dir <dir> --summary-every <n> --interval <sec> --dsh-url <url>
//
// 归档到达到阈值时会调用插件的 summarizeOnce()：它会在 DSH 里开一个临时会话让模型
// 压缩对话（因此会消耗 token），所以默认 10 分钟内最多触发一次。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { memoryLogTimestamp, parseMemoryLog } from '../src/qqb/memory-log.mjs';
import { discoverDshWebUrls, resolveDshBaseUrl } from '../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 摘要最小间隔：summarizeOnce 会真的让模型跑一轮，别被每 5 分钟的任务反复触发。 */
const SUMMARY_MIN_GAP_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const args = { _: [] };
  const flags = new Set(['watch', 'dry-run', 'status', 'no-summary', 'quiet', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const name = token.slice(2);
    if (flags.has(name)) { args[name] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) { args[name] = true; continue; }
    args[name] = value;
    i += 1;
  }
  return args;
}

const USAGE = `用法：node scripts/qq-extras-collector.mjs [选项]
  --watch              常驻轮询（默认采一轮就退出）
  --interval <秒>      轮询间隔（默认 30）
  --dry-run            只统计，不写归档也不改状态
  --status             打印归档现状后退出
  --no-summary         不触发插件摘要
  --quiet              只打一行结果（计划任务写日志用）
  --task-log <file>    配合 --quiet：把那一行也追加到这个文件（保留最后 5000 行）
  --summary-every <n>  攒够 n 条触发一次摘要（默认取插件配置，30）
  --log <file>         归档流水日志（默认 state/qq-memory.log）
  --data-dir <dir>     归档数据目录（默认插件自带 ~/.dsh/qq-memory）
  --plugin-dir <dir>   dsh-qq-extras 安装目录（默认自动找 profile 里的）
  --dsh-url <url>      DSH Web 地址（默认按 DSH_BASE_URL/DSH_WEB_URL/config.json/活端口发现）`;

function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex');
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 给计划任务用的自带上限日志：追加一行，超过 maxLines 只留最后 maxLines 行。
 * 刻意放在 node 里做（而不是在 .bat 里再拉一个 pwsh）：少一个外部依赖，也不会因为
 * 引号/换行把整条任务弄成静默失败。写日志失败绝不能影响归档，所以异常全吞。
 */
export function appendCappedLine(file, line, maxLines = 5000) {
  try {
    if (!file) return null;
    fs.appendFileSync(file, `${line}\n`, 'utf8');
    const cap = Number(maxLines);
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    if (Number.isFinite(cap) && cap > 0 && rows.length > cap) {
      fs.writeFileSync(file, rows.slice(-cap).join('\n') + '\n', 'utf8');
    }
    return line;
  } catch {
    return null;
  }
}

/** 找已安装的 dsh-qq-extras：--plugin-dir → QQ_EXTRAS_PLUGIN_DIR → 各 profile 的 node_modules。 */
export function resolvePluginDir(args = {}, home = os.homedir(), env = process.env) {
  const candidates = [];
  if (typeof args['plugin-dir'] === 'string') candidates.push(path.resolve(args['plugin-dir']));
  if (env.QQ_EXTRAS_PLUGIN_DIR) candidates.push(path.resolve(env.QQ_EXTRAS_PLUGIN_DIR));
  for (const profile of ['web', 'desktop', 'cli']) {
    candidates.push(path.join(home, '.dsh', 'profiles', profile, 'node_modules', 'dsh-qq-extras'));
  }
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'lib', 'archive.mjs'))) return dir;
  }
  return null;
}

/**
 * 选出真的能应答的 DSH Web 地址：
 * 显式/环境变量/config.json 优先，其次用 netstat 发现的 DSH 宿主监听端口逐个探活。
 */
export async function resolveDshUrl({ explicit, probe, env = process.env } = {}) {
  const fromConfig = resolveDshBaseUrl(explicit, { root: ROOT, env });
  const candidates = [];
  try {
    candidates.push(...discoverDshWebUrls({ env }));
  } catch {
    /* 发现失败就当没有候选 */
  }
  const check = probe ?? (async (url) => {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2500) });
    return res.status < 500;
  });
  for (const url of [fromConfig, ...candidates]) {
    if (!url) continue;
    try {
      if (await check(url)) return { url, source: url === fromConfig ? 'config' : 'discovered', candidates };
    } catch {
      /* 这个候选不通，看下一个 */
    }
  }
  return { url: fromConfig, source: 'unverified', candidates };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const pluginDir = resolvePluginDir(args);
  if (!pluginDir) {
    console.log(JSON.stringify({ ok: true, skipped: 'plugin-not-installed', hint: '先跑 dsh plugin --profile web add dsh-qq-extras' }));
    return 0;
  }

  const logFile = path.resolve(typeof args.log === 'string' ? args.log : path.join(ROOT, 'state', 'qq-memory.log'));
  const dataDir = typeof args['data-dir'] === 'string' ? path.resolve(args['data-dir']) : '';
  const intervalMs = Math.max(5, Number(args.interval) || 30) * 1000;
  const now = new Date();

  // 环境变量必须在 import 插件模块之前设好：插件的 DATA_DIR/BRIDGE_DIR 是模块加载时取的。
  if (!process.env.QQ_BRIDGE_DIR) process.env.QQ_BRIDGE_DIR = ROOT;
  if (dataDir) process.env.QQ_EXTRAS_DATA = dataDir;
  const dsh = await resolveDshUrl({ explicit: typeof args['dsh-url'] === 'string' ? args['dsh-url'] : undefined });
  // 同理：插件 summarize.mjs 的 BASE 也是模块加载时取的，所以提前注入。
  process.env.DSH_WEB_URL = dsh.url;

  const { loadConfig } = await import(pathToFileURL(path.join(pluginDir, 'lib', 'common.mjs')).href);
  const archive = await import(pathToFileURL(path.join(pluginDir, 'lib', 'archive.mjs')).href);

  const cfg = loadConfig();
  const stateFile = path.join(path.dirname(cfg.archiveDir), 'collector-bridge.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const summaryEvery = Math.max(1, Number(args['summary-every']) || Number(cfg.summaryEvery) || 30);
  const base = {
    logFile,
    archiveDir: cfg.archiveDir,
    dataDir: process.env.QQ_EXTRAS_DATA || '~/.dsh/qq-memory',
    pluginDir,
    dshUrl: dsh.url,
    dshSource: dsh.source,
    summaryEvery
  };

  if (args.status) {
    console.log(JSON.stringify({ ok: true, ...base, stats: archive.stats() }, null, 2));
    return 0;
  }

  const runPass = async () => {
    const state = readJsonSafe(stateFile, { seen: {}, lastSummaryAt: 0 });
    const seen = state.seen && typeof state.seen === 'object' ? state.seen : {};
    let text = '';
    try {
      text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    } catch (error) {
      return { ok: false, ...base, error: `读日志失败：${error.message}` };
    }
    const records = parseMemoryLog(text);
    const counts = new Map();
    let appended = 0;
    let skipped = 0;
    for (const rec of records) {
      const hash = sha1(rec.raw);
      const nth = (counts.get(hash) || 0) + 1;
      counts.set(hash, nth);
      if (nth <= (Number(seen[hash]) || 0)) { skipped += 1; continue; }
      if (args['dry-run']) { appended += 1; continue; }
      const line = archive.appendMessage({
        ts: memoryLogTimestamp(rec.clock, now),
        key: rec.key,
        role: rec.role,
        name: rec.name,
        text: rec.text
      });
      if (line) appended += 1; else skipped += 1;
    }

    let summary = null;
    if (!args['dry-run']) {
      state.seen = Object.fromEntries(counts);
      state.lastRunAt = new Date().toISOString();
      const enough = appended >= summaryEvery;
      const cooled = Date.now() - (Number(state.lastSummaryAt) || 0) > SUMMARY_MIN_GAP_MS;
      if (enough && cooled && !args['no-summary']) {
        try {
          const { summarizeOnce } = await import(pathToFileURL(path.join(pluginDir, 'summarize.mjs')).href);
          summary = await summarizeOnce();
          if (summary?.ok) state.lastSummaryAt = Date.now();
        } catch (error) {
          summary = { ok: false, reason: `summarize-error: ${error.message}` };
        }
      } else if (enough && !args['no-summary'] && !cooled) {
        summary = { ok: false, reason: 'cooldown', nextAllowedInMs: SUMMARY_MIN_GAP_MS - (Date.now() - (Number(state.lastSummaryAt) || 0)) };
      }
      writeJsonSafe(stateFile, state);
    }

    return {
      ok: true,
      ...base,
      parsed: records.length,
      appended,
      skipped,
      pending: appended,
      dryRun: !!args['dry-run'],
      summary
    };
  };

  if (!args.watch) {
    const result = await runPass();
    if (args.quiet) {
      // 计划任务每 5 分钟跑一次：只留一行，日志才不至于失控。
      const summaryNote = result.summary ? ` summary=${result.summary.ok ? 'ok' : (result.summary.reason ?? 'no')}` : '';
      const line = `[${new Date().toISOString()}] parsed=${result.parsed} appended=${result.appended} skipped=${result.skipped} pending=${result.pending}${summaryNote}`;
      console.log(line);
      // 计划任务没有 stdout，可以自己留一份（保留最后 5000 行）。
      if (typeof args['task-log'] === 'string') appendCappedLine(path.resolve(args['task-log']), line);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return result.ok ? 0 : 1;
  }

  console.log(JSON.stringify({ ok: true, ...base, watch: true, intervalMs }));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    // eslint-disable-next-line no-await-in-loop
    const result = await runPass();
    console.log(JSON.stringify(result));
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error('collector failed:', error?.stack || error?.message || String(error));
      process.exit(1);
    });
}

export { main, parseArgs, SUMMARY_MIN_GAP_MS };