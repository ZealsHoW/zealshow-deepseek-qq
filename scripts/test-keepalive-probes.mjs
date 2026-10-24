#!/usr/bin/env node
// 看门狗探活的回归：它**绝不能**再碰 WMI。
//
// 背景（2026-10-24）：这台机器上 `Get-CimInstance Win32_Process` 与 `Get-NetTCPConnection`
// 会卡死（20 秒都不回，`Restart-Service Winmgmt` 要管理员权限、拿不到）。看门狗一旦卡进去
// 就整段停摆——症状是「bridge 死了没人拉、GPT-SoVITS 死了没人管」，而日志停在最后一条正常
// 记录上，看起来像"没事发生"。所以这几条断言守的就是：探活只走 netstat + Get-Process。
//
// 脚本在仓库根之外（D:\34825\zhuomian\youqq\qq-bridge-keepalive.ps1），别的机器上不存在就 SKIP。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const ps1 = path.resolve(repoRoot, '..', 'qq-bridge-keepalive.ps1');

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? `（${extra}）` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? `（${extra}）` : ''}`); }
}

if (!fs.existsSync(ps1)) {
  console.log(`⏭ 本机没有 ${ps1}，跳过（这份脚本不随仓库发布）`);
  process.exit(0);
}

const raw = fs.readFileSync(ps1, 'utf8');
const lines = raw.split(/\r?\n/);
// 注释行允许提到这些 cmdlet（用于解释"为什么不能用"），只检查真正的代码行。
const codeLines = lines.filter((l) => !/^\s*#/.test(l));
const code = codeLines.join('\n');

console.log(`## ${path.basename(ps1)}（${lines.length} 行）`);

console.log('## 不许碰 WMI');
for (const bad of ['Get-CimInstance', 'Get-NetTCPConnection', 'Test-NetConnection']) {
  const hits = codeLines.map((l, i) => [i + 1, l]).filter(([, l]) => l.includes(bad));
  ok(hits.length === 0, `代码里没有 ${bad}`, hits.length ? `L${hits.map(([n]) => n).join(',')}` : '');
}

console.log('## 探活只靠 netstat + Get-Process');
ok(/function\s+Get-ListenerInfo/.test(code), '有 Get-ListenerInfo');
ok(/netstat(\.exe)?"?\s+-ano\s+-p\s+TCP/i.test(code), '用 netstat -ano -p TCP 取监听表');
ok(/LISTENING\\s\+\(\\d\+\)/.test(code) || /LISTENING\\s\+/.test(code), '正则里认 LISTENING 与 PID');
ok(/function\s+Test-PortListening/.test(code), '有 Test-PortListening');
for (const fn of ['Test-OllamaPort', 'Test-HindsightPort', 'Test-Port3100', 'Test-SnowLumaPort']) {
  const m = new RegExp(`function\\s+${fn}[\\s\\S]{0,200}?Test-PortListening`).test(code);
  ok(m, `${fn} 走 Test-PortListening`);
}

console.log('## bridge 用 lock 文件认，不再靠命令行');
ok(/function\s+Get-BridgePid/.test(code), '有 Get-BridgePid');
ok(/state\\bridge\.lock/.test(code), '读的是 state\\bridge.lock');
ok(/\^\(\\d\+\)\$/.test(code), '对 lock 内容做了纯数字校验');
ok(!/\*src[\\/]bridge\.js\*/.test(code), '不再用 "*src/bridge.js*" 匹配命令行');

console.log('## SnowLuma / WS 连接');
ok(/function\s+Test-BridgeWs[\s\S]{0,600}?ESTABLISHED/.test(code), 'Test-BridgeWs 用 netstat 的 ESTABLISHED 行');
ok(/function\s+Test-BridgeWs[\s\S]{0,600}?:3001\$/.test(code), 'Test-BridgeWs 认 :3001');
ok(/\$_\.Path -like "\$snowDir\*"/.test(code), 'SnowLuma 用可执行文件路径认（$snowDir\\node.exe）');
ok(/function\s+Get-DshListenPorts[\s\S]{0,400}?DeepSeek Harness/.test(code), 'DSH 端口按进程名 "DeepSeek Harness" 认');

console.log('## 注释里写清了这个坑（免得以后有人"顺手优化"回去）');
ok(/卡死/.test(raw) && /netstat/i.test(raw), '脚本里解释了"WMI 会卡死 + 改用 netstat"');

console.log(`\n结果：${pass} 通过 ${fail} 失败`);
process.exit(fail ? 1 : 0);