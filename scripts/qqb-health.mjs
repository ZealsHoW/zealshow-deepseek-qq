// qqb 体检 CLI（R3）：把在线服务按模块打一张健康表。
//
//   node scripts/qqb-health.mjs            # 人读表格；有 critical 模块 down 时退出码 1
//   node scripts/qqb-health.mjs --json     # 给看门狗/控制台解析
//   node scripts/qqb-health.mjs --timeout=2000
//
// 只读探测：不发送任何 QQ 消息、不写业务数据。日志落 state/logs/qqb-YYYYMMDD.jsonl。
import { fileURLToPath } from 'node:url';

import { createConfig } from '../src/qqb/core/config.mjs';
import { createHealth } from '../src/qqb/core/health.mjs';
import { createLogger } from '../src/qqb/core/log.mjs';
import { createServiceChecks } from '../src/qqb/checks/services.mjs';
import { QQB_VERSION } from '../src/qqb/version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const quiet = args.includes('--quiet');
const timeoutArg = args.find((item) => item.startsWith('--timeout='));
const timeoutMs = timeoutArg ? Number(timeoutArg.split('=')[1]) : 4000;

const logger = createLogger({
  module: 'qqb.health',
  root,
  echo: false,
  level: process.env.QQB_LOG_LEVEL ?? 'info',
});
const config = createConfig({ root, logger });
const health = createHealth({ logger });
// 传**门面**：检查项用 `config.get('snowluma.httpUrl')` 这种点号读取；
// 需要原始对象的那几个（`checkModel`/`checkMedia` 要把 config 交给模块）自己在内部调 `config.all()`。
for (const check of createServiceChecks({ root, config, logger, timeoutMs })) health.register(check);

const report = await health.run({ force: true });

if (asJson) {
  process.stdout.write(`${JSON.stringify({ qqb: QQB_VERSION, ...report }, null, 2)}\n`);
} else if (!quiet) {
  const mark = { ok: '✅', degraded: '⚠️ ', down: '⛔', unknown: '❔' };
  process.stdout.write(`qqb ${QQB_VERSION} 体检 @ ${report.ts} → ${mark[report.status] ?? ''} ${report.status}\n`);
  process.stdout.write(`${health.table(report)}\n`);
  process.stdout.write(`日志：${logger.file()}\n`);
  if (config.invalid()) process.stdout.write(`⚠️  config.json 当前不可用：${config.invalid()}\n`);
  const down = report.modules.filter((item) => item.status === 'down');
  const criticalDown = down.filter((item) => item.critical);
  const softDown = down.filter((item) => !item.critical);
  if (criticalDown.length) {
    process.stdout.write(`⛔ 关键模块不可用：${criticalDown.map((item) => `${item.name}（${item.error ?? '未知原因'}）`).join('；')}\n`);
  }
  if (softDown.length) {
    // 非关键模块（例如 Hindsight 记忆 daemon）没起来只是降级，不该报成宕机、也不该改退出码。
    process.stdout.write(`⚠️  非关键模块未就绪：${softDown.map((item) => `${item.name}（${item.error ?? '未知原因'}）`).join('；')}\n`);
  }
}

// 用 exitCode 而不是 process.exit()：硬退出会在 Windows 上留下
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 的 libuv 噪声，
// 看门狗与控制台都会被这行 stderr 干扰。
process.exitCode = report.status === 'down' ? 1 : 0;