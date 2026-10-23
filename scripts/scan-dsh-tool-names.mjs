// DSH 工具名清单扫描器：从**已安装的 DSH 包/插件**里抽取真实注册的工具名，
// 与 QQ 守卫的 restrict 名单对账。
//
// 为什么要有这个脚本（而不是把清单抄死在注释里）
// ----------------------------------------------
// `tools.restrict({ deny: [name] })` 对**不存在的工具名会抛错**，而守卫是逐个
// try/catch 的 ⇒ 拼错/过期的名字 = 静默 no-op，安全边界无声地少一层。
// 反过来，DSH 每个版本都会新增工具，守卫漏掉新名字 = 该隐藏的能力留在
// 仿真会话的 schema 里。两类漂移都只能靠「拿安装包重新对账」发现。
//
// 抽取逻辑在 scripts/dsh-tool-names.mjs（唯一实现，测试与扫描器共用）；
// 本文件只是 CLI：打印、分类、给退出码。
//
// 本脚本是**只读**的：不改任何文件。
//
// 用法：
//   node scripts/scan-dsh-tool-names.mjs            # 对账并打印全部候选
//   node scripts/scan-dsh-tool-names.mjs --missing  # 只打印值得补进守卫的名字
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  collectDshToolNames, dshPackagesDir, DANGER_TOOL_RE, SAFE_MODEL_TOOLS, TOOL_NAME_RE,
} from './dsh-tool-names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { names, packages } = collectDshToolNames();
const guardPath = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
const guard = await import(pathToFileURL(guardPath).href);
const guarded = new Set(guard.RESTRICTED_TOOL_NAMES);
const trackedAbsent = new Set(guard.TRACKED_ABSENT_TOOL_NAMES ?? []);

const sorted = [...names.keys()].sort();
const onlyFlag = process.argv.includes('--missing');

console.log(`DSH 包目录：${dshPackagesDir()}`);
console.log(`扫描包数：${packages.length}；抽到工具名候选：${sorted.length}\n`);

/** ① 守卫名单里的名字必须真实存在，否则 restrict 抛错被吞、限制静默失效。 */
const fabricated = [...guarded]
  .filter((n) => TOOL_NAME_RE.test(n) && !n.startsWith('dev_') && !names.has(n) && !trackedAbsent.has(n));
console.log('=== ① 守卫名单里、但安装包中找不到的名字（restrict 会抛错并静默失效） ===');
console.log(fabricated.length ? fabricated.map((n) => `  ${n}`).join('\n') : '  (无)');

/**
 * ①b 已知缺失清单的双向校验：
 *   · 清单里的名字**必须仍然缺失**；如果重新出现，说明能力回来了，应该从
 *     TRACKED_ABSENT_TOOL_NAMES 移入正常名单并确认 restrict 生效。
 *   · 清单必须真的是 RESTRICTED_TOOL_NAMES 的子集（否则“缺失”没有任何意义）。
 */
const trackedPresent = [...trackedAbsent].filter((n) => names.has(n));
const trackedNotGuarded = [...trackedAbsent].filter((n) => !guarded.has(n));
console.log('\n=== ①b 已知缺失清单（TRACKED_ABSENT_TOOL_NAMES）===');
console.log(trackedAbsent.size === 0
  ? '  (空)'
  : [...trackedAbsent].map((n) => `  ${n}  ${names.has(n) ? '⚠️ 已重新出现，需移出清单' : '· 仍缺失（预期）'}`).join('\n'));
if (trackedNotGuarded.length > 0) {
  console.log(`  ✖ 不在 RESTRICTED_TOOL_NAMES 里的条目：${trackedNotGuarded.join(', ')}`);
}

/** ② 安装包里有、守卫没覆盖的危险语义名字（可能是新版本新增的能力）。 */
const missing = sorted.filter((n) => DANGER_TOOL_RE.test(n) && !guarded.has(n) && !SAFE_MODEL_TOOLS.has(n));
console.log('\n=== ② 安装包里有、守卫名单里没有的「危险语义」名字（可能漏隐藏） ===');
console.log(missing.length ? missing.map((n) => `  ${n}  ← ${[...names.get(n)].join(', ')}`).join('\n') : '  (无)');

if (!onlyFlag) {
  console.log('\n=== ③ 全部候选名字（含来源包） ===');
  for (const n of sorted) {
    console.log(`  ${guarded.has(n) ? '[在名单]' : '[      ]'} ${n}  ← ${[...names.get(n)].join(', ')}`);
  }
}

console.log(
  `\n守卫名单 ${guarded.size} 个名字；其中悬空（假名）${fabricated.length} 个；`
  + `已知缺失 ${trackedAbsent.size} 个（仍缺失 ${trackedAbsent.size - trackedPresent.length}）；`
  + `候选里未覆盖的危险名 ${missing.length} 个。`
);
if (trackedPresent.length > 0) {
  console.log(`⚠️ 以下已知缺失工具已重新出现，请移出 TRACKED_ABSENT_TOOL_NAMES：${trackedPresent.join(', ')}`);
}
if (trackedNotGuarded.length > 0) {
  console.log(`⚠️ TRACKED_ABSENT_TOOL_NAMES 含不在守卫名单里的名字：${trackedNotGuarded.join(', ')}`);
}
process.exitCode = (fabricated.length === 0
  && missing.length === 0
  && trackedPresent.length === 0
  && trackedNotGuarded.length === 0) ? 0 : 1;
