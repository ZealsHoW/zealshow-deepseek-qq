#!/usr/bin/env node
// `qq_sing`（让她用自己的音色唱一首歌）这条链路的回归。
//
// 背景（2026-10-24）：ACE-Step 能把曲子生成出来、Seed-VC 能把歌声换成她的音色，
// 但那是两个脚本、要人肉敲命令。让她自己能唱，得再补四段胶水，而每一段都可能
// 「静默失效」——接口在、工具不在；工具在、开关默认关；开关开了、显存又被
// 真人音色服务占着，生成到一半 WinError 1455。
//
// 所以这里断言这四段都在，且默认值是「重动作默认关、要人显式打开」：
//   1. bridge 的 POST /api/socialV2/sing（门禁照抄 send-voice，唱歌期间落 hold 文件腾显存）；
//   2. MCP 工具 qq_sing + TOOL_CONFIG_FLAGS 登记（漏登记 = 模型看得到工具却永远 403）；
//   3. 看门狗认 hold 文件（否则它每轮都抢着把 TTS 拉起来，歌就 OOM）；
//   4. 脚本层的 --vc（生成完自动换音色）与 voice-convert.mjs（Seed-VC 的包装）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

let pass = 0;
let fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? `（${extra}）` : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? `（${extra}）` : ''}`); }
}

const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const singSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'sing.mjs'), 'utf8');
const convertPath = path.join(ROOT, 'scripts', 'voice-convert.mjs');
const convertSrc = fs.existsSync(convertPath) ? fs.readFileSync(convertPath, 'utf8') : '';

console.log('## 桥接接口 POST /api/socialV2/sing');
ok(/url\.pathname === '\/api\/socialV2\/sing'/.test(bridgeSrc), '路由挂上了');
ok(/v2ToolEnabled\('sing'\)/.test(bridgeSrc), '门禁里有工具开关（sing）');
ok(/tierGuardV2\(key, 'qq_sing'\)/.test(bridgeSrc), '梯队在 qq_sing 这把钥匙上算');
ok(/agentTokenOk\(key, token\)/.test(bridgeSrc), '沿用 agent token 校验');
ok(/shouldBlockSilentReply\(key\)/.test(bridgeSrc), '静默模式一样挡');
ok(/state\/tts-hold|'tts-hold\.json'/.test(bridgeSrc), '唱歌期间落 hold 文件（让看门狗别抢内存）');
ok(/releaseResourcesForSinging\(voiceCfg\(\)\)/.test(bridgeSrc), '后台任务开始前先腾资源（卸 Ollama + 停 TTS）');
ok(/sendVoiceForV2\(job\.key, voiceName/.test(bridgeSrc), '后台生成完走语音发送（不是直接甩文件）');
ok(/path\.basename\(String\(result\.file\)\)/.test(bridgeSrc), '发送前把路径收成文件名（否则会被拼成 audio/audio/…）');
ok(/job\.verified = sent\?\.verification\?\.confirmed === true/.test(bridgeSrc), '状态里记 verified（取 verification.confirmed，只有真发成功才算数）');
ok(/'--json'/.test(bridgeSrc), '调脚本时带 --json（解析最后一行拿产物路径）');

console.log('## 后台任务：路由立刻回、生成在后台跑（2026-10-26）');
// 背景：13:44 那次同步等生成，把整机压到假死 16 分钟，回复一起超时报废。
// 现在必须：① 立刻 202 + queued；② 生成放在 runSingJobInBackground 里、响应之后跑；
// ③ 后台函数绝不能再写响应（写了也白发）；④ 同一时刻只允许一首；⑤ 有状态查询。
ok(/async function runSingJobInBackground\(job\)/.test(bridgeSrc), '后台 runner 在');
ok(/void runSingJobInBackground\(job\);/.test(bridgeSrc), '响应之后启动 runner（不 await）');
{
  // 把 runner 函数体切出来，确认里面没有 sendJson —— 响应早发了，再写只会在已结束的 res 上抛错。
  const start = bridgeSrc.indexOf('async function runSingJobInBackground(job) {');
  const end = bridgeSrc.indexOf('if (req.method === \'POST\' && url.pathname === \'/api/socialV2/sing\')', start);
  const body = start >= 0 && end > start ? bridgeSrc.slice(start, end) : '';
  ok(body.length > 0 && !/sendJson\(/.test(body), 'runner 里不碰 sendJson（响应早已发出）');
  ok(/sendVoiceForV2\(job\.key/.test(body), 'runner 用 job.key 发回原会话（不依赖已结束的请求变量）');
}
ok(/queued: true/.test(bridgeSrc) && /202\)/.test(bridgeSrc), '接口回 202 + queued:true');
ok(/jobId: `sing-\$\{Date\.now\(\)\}`/.test(bridgeSrc), '每次生成有 jobId');
ok(/busy: true/.test(bridgeSrc) && /409\)/.test(bridgeSrc), '同一时刻只允许一首（第二首回 409 busy）');
ok(/req\.method === 'GET' && url\.pathname === '\/api\/socialV2\/sing'/.test(bridgeSrc), 'GET 同一路径查进度/上一首结果');
ok(/freeMb < 4500/.test(bridgeSrc), '内存护栏：不够就不排（13:44 的教训）');
ok(/singJobStatus\(\)/.test(bridgeSrc), '状态由 singJobStatus 统一出');

console.log('## MCP 工具 qq_sing');
ok(/qq_sing: 'sing'/.test(mcpSrc), 'TOOL_CONFIG_FLAGS 登记了 qq_sing → sing');
ok(/server\.tool\(\s*'qq_sing'/.test(mcpSrc), '工具注册了');
ok(/tools\?\.sing !== false/.test(mcpSrc), '注册期开关读 socialV2.tools.sing');
ok(/agentApi\('\/api\/socialV2\/sing'/.test(mcpSrc), '打到桥接的 sing 接口');
ok(/timeoutMs: 30000/.test(mcpSrc), '超时降到 30 秒（路由立刻回，不再等生成）');
ok(/后台任务/.test(mcpSrc) && /不要原地等、也不要再调一次/.test(mcpSrc), '描述里写明是后台任务、别原地等也别重复调');
ok(/data\?\.queued/.test(mcpSrc), '工具把 queued 翻译成「等我几分钟」的指引');

console.log('## 默认值：重动作默认关');
ok(/sendVoice: false,[\s\S]{0,400}?sing: false,/.test(bridgeSrc), 'bridge 默认表 sing: false');
const examplePath = path.join(ROOT, 'config.example.json');
if (fs.existsSync(examplePath)) {
  const example = JSON.parse(fs.readFileSync(examplePath, 'utf8').replace(/^\uFEFF/, ''));
  ok(example.socialV2?.tools?.sing === false, 'config.example.json 里是 false');
} else {
  console.log('  ⏭ 没有 config.example.json');
}
const cfgPath = path.join(ROOT, 'config.json');
if (fs.existsSync(cfgPath)) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
  ok(cfg.socialV2?.tools?.sing === true, '本机 config.json 已显式打开（她要能唱）');
} else {
  console.log('  ⏭ 没有 config.json');
}

console.log('## 看门狗认 hold 文件');
const keepalivePath = path.resolve(ROOT, '..', 'qq-bridge-keepalive.ps1');
if (fs.existsSync(keepalivePath)) {
  const ps = fs.readFileSync(keepalivePath, 'utf8');
  ok(/tts-hold\.json/.test(ps), '读 state\\tts-hold.json');
  ok(/\$ttsHeld/.test(ps), '算出「此刻被 hold」');
  ok(/-not \$ttsHeld -and -not \(Test-TtsHttp/.test(ps), 'hold 期间不抢着拉起 TTS');
  ok(/ToUnixTimeMilliseconds/.test(ps), '按毫秒时间戳判断过期（坏文件也不会永久挡住）');
} else {
  console.log('  ⏭ 没有 ../qq-bridge-keepalive.ps1（仓库外脚本），跳过');
}

console.log('## 腾显存：连「正在加载、还没监听端口」的 TTS 也要停掉');
const servePath = path.join(ROOT, 'scripts', 'gptsovits-serve.ps1');
const pyLauncher = path.join(ROOT, 'scripts', 'gptsovits-serve.py');
if (fs.existsSync(servePath) && fs.existsSync(pyLauncher)) {
  const serveSrc = fs.readFileSync(servePath, 'utf8');
  const pySrc = fs.readFileSync(pyLauncher, 'utf8');
  ok(/gptsovits-serve\.py/.test(serveSrc), 'ps1 通过 gptsovits-serve.py 启动 api_v2.py');
  ok(/gptsovits-serve\.pid/.test(pySrc) && /os\.getpid\(\)/.test(pySrc), 'py 启动器把真正吃内存的 PID 写进 state\\gptsovits-serve.pid');
  ok(/runpy\.run_path/.test(pySrc), '用 run_path 让 api_v2.py 以为自己就是主程序（跑在同一进程里）');
  ok(/PID_FILE\.unlink\(\)/.test(pySrc) && /== str\(os\.getpid\(\)\)/.test(pySrc), '退出时只清自己那份（别误删后来者的）');
} else {
  console.log('  ⏭ 没有 scripts/gptsovits-serve.ps1 / .py');
}
ok(/gptsovits-serve\.pid/.test(bridgeSrc), 'bridge 读同一个 PID 文件');
ok(/process\.kill\(servePid\)/.test(bridgeSrc), '按 PID 直接停（杀 wrapper 会留孤儿 python，实测）');
ok(/ageSec < 600/.test(bridgeSrc), '只认 10 分钟内的 PID（防 PID 复用误杀别人）');

console.log('## 脚本层：生成完换音色');
ok(fs.existsSync(convertPath), 'scripts/voice-convert.mjs 在');
ok(/SEEDVC_HOME/.test(convertSrc), 'voice-convert 认 SEEDVC_HOME');
ok(/inference_v2\.py/.test(convertSrc), '调 Seed-VC 的 inference_v2.py');
ok(/HF_HUB_CACHE/.test(convertSrc), '设了 HF_HUB_CACHE（否则默认缓存目录 WinError 5）');
ok(/--target/.test(convertSrc) && /socialV2\?\.voice\?\.tts\?\.gptsovits/.test(convertSrc) && /tts\.refAudio/.test(convertSrc),
  '不给 --target 就用她现在的嗓子（tts.gptsovits.refAudio）');
ok(/'--vc'|--vc/.test(singSrc), 'sing.mjs 支持 --vc');
ok(/voice-convert\.mjs/.test(singSrc), 'sing.mjs 会调 voice-convert');
ok(/'--json'|--json/.test(singSrc), 'sing.mjs 支持 --json（给桥接解析）');

console.log(`\n结果：${pass} 通过 ${fail} 失败`);
process.exit(fail ? 1 : 0);

