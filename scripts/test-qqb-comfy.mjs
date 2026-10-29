// 自绘（src/qqb/media/comfy.mjs）的回归：风格归一、状态探活、坏输入、接线。
// 不联网、不连真 ComfyUI、不出图——真出图由 `node scripts/comfy-selftest.mjs` 手工跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOWED_STYLES,
  DEFAULT_ASPECT,
  DEFAULT_LORA,
  DEFAULT_LORA_WEIGHT,
  DEFAULT_STYLE,
  DEFAULT_TRIGGER,
  VERSION,
  createComfyClient,
  normalizeStyle,
  styleLines,
} from '../src/qqb/media/comfy.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

console.log('自绘模块：');
{
  ok('有 VERSION（版本登记表要读）', /^\d+\.\d+\.\d+$/.test(VERSION));
  eq('只放三种风格', [...ALLOWED_STYLES], ['anime', 'anime-sd15', 'realistic']);
  eq('默认风格与构图', [DEFAULT_STYLE, DEFAULT_ASPECT], ['anime', 'square']);
  eq('风格名归一：不认识 → 默认', normalizeStyle('nope'), 'anime');
  eq('风格名归一：大小写', normalizeStyle('REALISTIC'), 'realistic');
  eq('风格名归一：空值 → 默认', normalizeStyle(''), 'anime');
  eq('风格名归一：认识的原样', normalizeStyle('anime-sd15'), 'anime-sd15');
  const lines = styleLines();
  eq('风格说明三行', lines.length, 3);
  ok('风格说明带中文标签', lines[0].includes('Animagine') && lines[0].startsWith('anime：'));
}

console.log('LoRA：');
{
  ok('默认 LoRA 是她的那支', DEFAULT_LORA === 'xiaojing_sdxl_lora.safetensors');
  eq('默认触发词与权重', [DEFAULT_TRIGGER, DEFAULT_LORA_WEIGHT], ['xiaojing', 0.8]);
  const probe = createComfyClient({ outDir: os.tmpdir() });
  ok('客户端带 knownLoras 方法（查服务器上挂了哪些 LoRA）', typeof probe.knownLoras === 'function');
  const src = fs.readFileSync(new URL('../src/qqb/media/comfy.mjs', import.meta.url), 'utf8');
  ok('出图时挂 LoraLoader', src.includes("class_type: 'LoraLoader'"));
  ok('两个 CLIPTextEncode 都从 LoraLoader 的 clip 出', src.includes("clip: ['2', 1]") && src.includes("class_type: 'LoraLoader'"));
  ok('画图尺寸按 (style, aspect) 查表', src.includes('function pickSizeFor') && src.includes('realistic'));
}

console.log('探活与坏输入（不连真服务）：');
{
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-comfy-'));
  // 挑一个几乎肯定没人监听的端口，status() 应该「up=false + 说清原因」，而不是抛。
  const client = createComfyClient({ outDir, baseUrl: 'http://127.0.0.1:6553', timeoutMs: 20_000 });
  eq('url 去掉了结尾斜杠', client.url, 'http://127.0.0.1:6553');
  const status = await client.status();
  eq('连不上时 up=false', status.up, false);
  ok('连不上时给中文原因', String(status.reason || '').includes('ComfyUI 没在跑'));
  eq('连不上时不谎报有模型', status.checkpoints, []);

  let threw = '';
  try {
    await client.draw({ prompt: '   ' });
  } catch (error) {
    threw = String(error?.message || error);
  }
  ok('prompt 空就直接拒（不往服务端发）', threw.includes('prompt 不能为空'));

  // 服务没起时 draw 也要报清楚「连不上」，不能是 fetch 的英文栈。
  let threw2 = '';
  try {
    await client.draw({ prompt: '1girl, blue hair', style: 'nope' });
  } catch (error) {
    threw2 = String(error?.message || error);
  }
  ok('服务没起时 draw 说人话', threw2.includes('连不上 ComfyUI') || threw2.includes('ComfyUI'), threw2.slice(0, 120));
}

console.log('接线：');
{
  const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  ok('bridge.js 导入了 comfy 客户端', bridge.includes("from './qqb/media/comfy.mjs'"));
  ok('有 POST 路由 /api/socialV2/generate-image', bridge.includes("'/api/socialV2/generate-image'"));
  ok('有后台任务 runDrawJobInBackground', /async function runDrawJobInBackground\(/.test(bridge));
  ok('画完走 sendImageV2 发出去', bridge.includes('sendImageV2(job.key, job.file'));
  ok('默认开关 generateImage: true', /generateImage: true,/.test(bridge));
  ok('有显存守卫（nvidia-smi）', bridge.includes("'--query-gpu=memory.free'"));
  ok('正在唱歌就不画（409 busyWith）', bridge.includes("busyWith: 'sing'"));

  const mcp = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
  ok('MCP 注册了 qq_generate_image', mcp.includes("'qq_generate_image'"));
  ok('MCP 开关映射到 generateImage', mcp.includes("qq_generate_image: 'generateImage'"));
  ok('MCP 调用前后台口径写清楚（queued）', mcp.includes('已排上（jobId='));

  ok('路由解析 lora / loraWeight / trigger', bridge.includes('const loraName = loraOff ?') && bridge.includes('const loraWeight = loraOff ? 0'));
  ok('默认挂她自己的 LoRA（config 没配时用 DEFAULT_LORA）', bridge.includes('imageCfg.lora || DEFAULT_LORA'));
  ok('job 里记着 lora 与权重', bridge.includes('lora: loraName,') && bridge.includes('loraWeight,'));
  ok('后台画图时把 LoRA 传给客户端', bridge.includes('lora: job.lora ??') && bridge.includes('loraWeight: job.loraWeight ??'));
  ok('202 回执带 lora 字段', bridge.includes('lora: loraName || null,'));

  ok('MCP 工具带 lora 参数', mcp.includes("lora: z.union([z.boolean(), z.string()]).optional()"));
  ok('MCP 工具带 loraWeight 参数', mcp.includes('loraWeight: z.number().optional()'));
  ok('MCP 描述写清默认挂她自己的 LoRA', mcp.includes('默认挂着她自己的 LoRA'));

  const harness = fs.readFileSync(new URL('../scripts/audit-bridge-harness.mjs', import.meta.url), 'utf8');
  ok('audit 夹具补了 createComfyClient 桩', harness.includes('function createComfyClient()') && harness.includes('createComfyClient, ALLOWED_STYLES'));
  const audit = fs.readFileSync(new URL('../scripts/test-audit.mjs', import.meta.url), 'utf8');
  ok('audit 清单收了本测试', audit.includes("'test-qqb-comfy.mjs'"));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  ok('package.json 有 test:qqb-comfy', typeof pkg.scripts['test:qqb-comfy'] === 'string');
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);