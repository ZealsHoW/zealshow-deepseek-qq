#!/usr/bin/env node
/**
 * dsh-qq-extras 的 MCP 链路回归。
 *
 * 背景（上游缺陷，npm 上 0.0.0-stage / 0.1.0 都有）：插件的 mcp.mjs 无条件 import `./lib/comfy.mjs`，
 * 而包里没有这个文件 ⇒ stdio MCP server 在 import 阶段就 `ERR_MODULE_NOT_FOUND` 退出，**一个工具都
 * 起不来**（memory_search / memory_context / web_sticker_send / voice_send_text 全部连坐）。
 *
 * 这份回归盯的就是"我们自己的修法"，四层：
 *   一、`dsh/qq-extras-patch/lib/comfy.mjs` 纯模块：风格归一、模型解析、尺寸与参数默认、四类错误文案。
 *   二、假 ComfyUI 端到端：工作流图 → POST /prompt → 轮询 /history → /view 取图落盘（含 400 与缺模型）。
 *   三、启动壳 `scripts/qq-extras-mcp.mjs`：找插件目录、comfy.mjs 自愈、`--check` 自检。
 *   四、真握手：把壳当 stdio MCP server 拉起来，走 initialize / tools/list / tools/call 真调一次
 *       memory_stats 与 image_models（这两个不需要 ComfyUI 在线，正好覆盖"上下文增强"这条主线）。
 *       插件没装时三、四层装 SKIP（别的机器上也能跑）。
 *
 * 用法：node scripts/test-qq-extras-mcp.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_COMFY_URL,
  STYLE_TABLE,
  STYLE_TABLE as STYLES,
  comfyUrl,
  generate,
  imagesDir,
  listModels,
  resolveCheckpoint,
  serverUp,
  styleKey,
} from '../dsh/qq-extras-patch/lib/comfy.mjs';
import { comfyStatus, findPluginDir, installComfy } from './qq-extras-mcp.mjs';
import { isPatched, patchedCordis } from './patch-qq-extras.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(__dirname, 'qq-extras-mcp.mjs');

let failures = 0;
const skipped = [];
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
function skip(name, why) { skipped.push(name); console.log('SKIP', name, '—', why); }

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqextras-mcp-${tag}-`));
}

/** 最小合法 PNG 头（comfy.mjs 只校验魔数，够用）。 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);

/**
 * 假 ComfyUI：只实现 comfy.mjs 真正会碰的四个端点。
 * historyDelay 用来逼出"轮询"这条路径（前 N 次 /history 返空）。
 */
async function fakeComfy({
  checkpoints = ['animagine-xl-4.0.safetensors', 'counterfeit-v2.5.safetensors'],
  promptStatus = 200,
  nodeErrors = null,
  historyDelay = 0,
} = {}) {
  const state = { requests: [], promptBody: null, promptId: 'test-prompt-1', historyCalls: 0, viewUrl: '' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push(`${req.method} ${url.pathname}`);
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/system_stats') return json(200, { system: { os: 'nt', comfyui_version: 'test' } });
    if (url.pathname === '/object_info/CheckpointLoaderSimple') {
      return json(200, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints, { tooltip: 'x' }] } } } });
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        state.promptBody = JSON.parse(body);
        if (promptStatus !== 200) return json(promptStatus, { error: { message: 'bad request' }, node_errors: nodeErrors });
        json(200, { prompt_id: state.promptId, number: 1, node_errors: {} });
      });
      return undefined;
    }
    if (url.pathname.startsWith('/history/')) {
      state.historyCalls += 1;
      if (state.historyCalls <= historyDelay) return json(200, {});
      return json(200, {
        [state.promptId]: {
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { 7: { images: [{ filename: 'qq-extras_00001_.png', subfolder: '', type: 'output' }] } },
        },
      });
    }
    if (url.pathname === '/view') {
      state.viewUrl = req.url;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
      return undefined;
    }
    return json(404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, state, url, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withEnv(pairs, run) {
  const saved = new Map();
  for (const [k, v] of Object.entries(pairs)) { saved.set(k, process.env[k]); if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await run(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ══ 一、comfy.mjs 纯模块 ═════════════════════════════════════════════════════
console.log('\n—— 一、comfy.mjs 纯模块 ——');

await test('comfy：风格名归一（大小写/下划线/未知原样）', () => {
  assert.equal(styleKey(''), 'anime');
  assert.equal(styleKey('ANIME'), 'anime');
  assert.equal(styleKey('anime_sd15'), 'anime-sd15');
  assert.equal(styleKey('AnimeSD15'), 'anime-sd15');
  assert.equal(styleKey('realistic'), 'realistic');
  assert.equal(styleKey('随便'), '随便');
});

await test('comfy：四个风格的尺寸档位（SD1.5 不许给 1024）', () => {
  const keys = Object.keys(STYLE_TABLE);
  assert.deepEqual(keys, ['anime', 'anime-sd15', 'realistic', 'general']);
  for (const [key, spec] of Object.entries(STYLES)) {
    assert.ok(spec.preferred.endsWith('.safetensors'), `${key} 要有期望文件名`);
    assert.ok(spec.negative.length > 20, `${key} 要有负面提示词`);
    for (const [aspect, [w, h]] of Object.entries(spec.sizes)) {
      const long = Math.max(w, h);
      if (spec.base === 'sd15') assert.ok(long <= 768, `${key}/${aspect} 是 SD1.5，尺寸不能超过 768`);
      else assert.ok(long >= 1024, `${key}/${aspect} 是 SDXL，长边至少 1024`);
    }
  }
});

await test('comfy：checkpoint 解析（精确 → 大小写 → 关键词 → 缺模型 → env 覆盖）', async () => {
  const exact = resolveCheckpoint('anime', { checkpoints: ['animagine-xl-4.0.safetensors'] });
  assert.equal(exact.name, 'animagine-xl-4.0.safetensors');
  assert.equal(exact.installed, true);
  assert.equal(exact.source, 'server');

  const ci = resolveCheckpoint('anime', { checkpoints: ['Animagine-XL-4.0.safetensors'] });
  assert.equal(ci.installed, true, '大小写/连字符不同也要认出来');

  const fuzzy = resolveCheckpoint('realistic', { checkpoints: ['sub/dir/realisticVisionV51_v51VAE-fp16.safetensors'] });
  assert.equal(fuzzy.installed, true, '关键词包含也要认出来');

  const missing = resolveCheckpoint('anime', { checkpoints: ['counterfeit-v2.5.safetensors'] });
  assert.equal(missing.installed, false, '服务端清单里没有就要如实说"没装"');
  assert.deepEqual(missing.available, ['counterfeit-v2.5.safetensors']);

  const unknown = await withEnv({ COMFYUI_MODELS_DIR: undefined }, () => resolveCheckpoint('anime', { checkpoints: [] }));
  assert.equal(unknown.installed, null, '还没探到清单 = 未知，不是"没有"');

  process.env.COMFYUI_CHECKPOINT_ANIME = 'my-anime.safetensors';
  try {
    const forced = resolveCheckpoint('anime');
    assert.equal(forced.name, 'my-anime.safetensors');
    assert.equal(forced.source, 'env');
  } finally {
    delete process.env.COMFYUI_CHECKPOINT_ANIME;
  }
});

await test('comfy：listModels 给四个风格与安装状态', () => {
  const models = listModels();
  assert.equal(models.length, 4);
  for (const m of models) {
    assert.ok(m.label && m.note, `${m.style} 要有中文说明`);
    assert.ok(['server', 'dir', 'env', 'unknown'].includes(m.source));
    assert.ok(m.sizes.portrait && m.sizes.landscape && m.sizes.square);
  }
});

await test('comfy：dataDir / imagesDir 跟随 QQ_EXTRAS_DATA', async () => {
  const dir = tempDir('data');
  await withEnv({ QQ_EXTRAS_DATA: dir }, () => {
    assert.equal(imagesDir(), path.join(dir, 'images'));
  });
});

await test('comfy：serverUp 对没人监听的端口返回 false（不抛）', async () => {
  assert.equal(await serverUp('http://127.0.0.1:9', { timeoutMs: 1500 }), false);
});

await test('comfy：comfyUrl 认 COMFYUI_URL 并剥掉结尾斜杠', async () => {
  await withEnv({ COMFYUI_URL: 'http://127.0.0.1:1234///' }, () => assert.equal(comfyUrl(), 'http://127.0.0.1:1234'));
  await withEnv({ COMFYUI_URL: undefined }, () => assert.equal(comfyUrl(), DEFAULT_COMFY_URL));
});

await test('comfy：空 prompt / 未知风格 / 服务不在线 的中文错误', async () => {
  await assert.rejects(() => generate({ prompt: '   ' }), /prompt 不能为空/);
  await assert.rejects(() => generate({ prompt: 'x', style: '不存在' }), /不认识的风格/);
  await withEnv({ COMFYUI_URL: 'http://127.0.0.1:9' }, async () => {
    await assert.rejects(() => generate({ prompt: 'x', timeoutMs: 5000 }), /连不上 ComfyUI/);
  });
});

// ══ 二、假 ComfyUI 端到端 ════════════════════════════════════════════════════
console.log('\n—— 二、假 ComfyUI 端到端 ——');

await test('comfy：generate 走完 探活→查清单→排队→轮询→取图 并落盘', async () => {
  const comfy = await fakeComfy({ historyDelay: 1 });
  const out = tempDir('img');
  try {
    await withEnv({ COMFYUI_URL: comfy.url, QQ_EXTRAS_DATA: out }, async () => {
      const r = await generate({ prompt: '1girl, solo, cherry blossoms', style: 'anime', aspect: 'portrait' });
      assert.equal(r.ok, true);
      assert.equal(r.mime, 'image/png');
      assert.equal(r.bytes, PNG.length);
      assert.ok(fs.existsSync(r.file), '图要真的落盘');
      assert.ok(r.file.startsWith(path.join(out, 'images')), '落在 <DATA_DIR>/images');
      assert.equal(r.checkpoint, 'animagine-xl-4.0.safetensors');
      assert.deepEqual([r.width, r.height], [832, 1216], 'SDXL 竖构图');
      assert.equal(r.steps, 28);
      assert.ok(Number.isInteger(r.seed));
      assert.ok(comfy.state.historyCalls >= 2, '第一次 /history 返空时要继续轮询');
      assert.match(comfy.state.viewUrl, /filename=qq-extras_00001_\.png/);
    });
    const body = comfy.state.promptBody;
    assert.ok(body?.client_id, 'POST /prompt 要带 client_id');
    const graph = body.prompt;
    assert.deepEqual(Object.keys(graph).sort(), ['1', '2', '3', '4', '5', '6', '7']);
    assert.equal(graph['1'].class_type, 'CheckpointLoaderSimple');
    assert.equal(graph['1'].inputs.ckpt_name, 'animagine-xl-4.0.safetensors');
    assert.equal(graph['2'].class_type, 'CLIPTextEncode');
    assert.equal(graph['2'].inputs.text, '1girl, solo, cherry blossoms');
    assert.ok(graph['3'].inputs.text.length > 10, '负面提示词要带上');
    assert.deepEqual(graph['4'].inputs, { width: 832, height: 1216, batch_size: 1 });
    assert.equal(graph['5'].class_type, 'KSampler');
    assert.ok(Number.isInteger(graph['5'].inputs.seed), 'seed 是整数');
    assert.ok(graph['5'].inputs.seed >= 0 && graph['5'].inputs.seed < 2 ** 31, 'seed 在合法范围');
    assert.equal(graph['5'].inputs.sampler_name, 'euler_ancestral');
    assert.equal(graph['5'].inputs.scheduler, 'normal');
    assert.equal(graph['5'].inputs.denoise, 1);
    assert.equal(graph['6'].class_type, 'VAEDecode');
    assert.equal(graph['7'].class_type, 'SaveImage');
  } finally {
    await comfy.close();
  }
});

await test('comfy：显式 width/height/steps/cfg/negative 覆盖默认值', async () => {
  const comfy = await fakeComfy();
  const out = tempDir('img2');
  try {
    await withEnv({ COMFYUI_URL: comfy.url, QQ_EXTRAS_DATA: out }, async () => {
      const r = await generate({ prompt: 'mountain lake', style: 'anime', width: 1024, height: 640, steps: 99, cfg: 99, negative: '自定义负面', seed: 42 });
      assert.deepEqual([r.width, r.height], [1024, 640]);
      assert.equal(r.steps, 60, 'steps 夹到上限 60');
      assert.equal(r.cfg, 20, 'cfg 夹到上限 20');
      assert.equal(r.seed, 42);
    });
    assert.equal(comfy.state.promptBody.prompt['3'].inputs.text, '自定义负面');
  } finally {
    await comfy.close();
  }
});

await test('comfy：服务端清单里没有这个模型时给出人话（不硬着头皮画）', async () => {
  const comfy = await fakeComfy({ checkpoints: ['totally-other.safetensors'] });
  const out = tempDir('img3');
  try {
    await withEnv({ COMFYUI_URL: comfy.url, QQ_EXTRAS_DATA: out }, async () => {
      await assert.rejects(() => generate({ prompt: 'x', style: 'anime' }), /ComfyUI 里没有「.*」的模型/);
    });
  } finally {
    await comfy.close();
  }
});

await test('comfy：ComfyUI 返回 400 时把 node_errors 摘要带进错误里', async () => {
  const comfy = await fakeComfy({ promptStatus: 400, nodeErrors: { 5: { errors: [{ message: 'KSampler: 显存不足' }] } } });
  const out = tempDir('img4');
  try {
    await withEnv({ COMFYUI_URL: comfy.url, QQ_EXTRAS_DATA: out }, async () => {
      await assert.rejects(() => generate({ prompt: 'x', style: 'anime' }), (error) => {
        assert.match(error.message, /拒绝了画图请求/);
        assert.match(error.message, /显存不足/);
        return true;
      });
    });
  } finally {
    await comfy.close();
  }
});

// ══ 三、启动壳与补丁状态 ═════════════════════════════════════════════════════
console.log('\n—— 三、启动壳与补丁状态 ——');

const pluginDir = findPluginDir();
if (!pluginDir) {
  for (const name of ['壳：找得到插件目录', '壳：comfy.mjs 已补齐', '补丁：cordis.patch.yml 指向启动壳', '壳：--check 自检通过']) {
    skip(name, '本机没装 dsh-qq-extras');
  }
} else {
  await test('壳：findPluginDir 找得到插件目录', () => {
    assert.ok(fs.existsSync(path.join(pluginDir, 'mcp.mjs')), '插件目录里要有 mcp.mjs');
    assert.ok(fs.existsSync(path.join(pluginDir, 'lib', 'archive.mjs')), '插件目录里要有 lib/archive.mjs');
  });

  await test('壳：comfy.mjs 已补齐且与仓库副本一字不差', () => {
    assert.equal(comfyStatus(pluginDir).status, 'ok', '缺失就 npm run extras:patch');
  });

  await test('壳：installComfy 幂等（已就位时不重写）', () => {
    assert.equal(installComfy(pluginDir).status, 'identical');
  });

  await test('补丁：cordis.patch.yml 指向启动壳（不再是 npx 现拉坏包）', () => {
    const cordis = fs.readFileSync(path.join(pluginDir, 'cordis.patch.yml'), 'utf8');
    assert.ok(isPatched(cordis), '需要 npm run extras:patch');
    assert.match(cordis, /qq-extras-mcp\.mjs/);
    // 注释里会提到"原来是 npx"，所以只看生效行（非 # 开头）里还有没有 npx / 那个坏包。
    const active = cordis.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
    assert.ok(!/\bnpx\b/.test(active), '生效行里不该再走 npx（那个包永远是坏的，还要联网）');
    assert.ok(!/dsh-qq-extras@0\.1\.0/.test(active), '生效行里不该再指 npm 包本身');
    assert.match(active, /command: '.+'/);
    assert.match(active, /toolCallTimeoutMs: 300000/);
    assert.match(patchedCordis(), /id: mcp-qq-extras/);
    assert.match(patchedCordis(), /serverName: qq-extras/);
  });

  await test('壳：--check 自检 exit 0 且报 comfy ok', () => {
    const stdout = execFileSync(process.execPath, [WRAPPER, '--check'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, QQ_BRIDGE_DIR: ROOT },
    });
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.comfy, 'ok');
    assert.ok(report.hasBridgeConfig, 'QQ_BRIDGE_DIR 下要有 config.json（ownerQQ 从这里读）');
  });
}

// ══ 四、真握手（stdio MCP） ══════════════════════════════════════════════════
console.log('\n—— 四、真握手（stdio MCP） ——');

/**
 * 把启动壳当 stdio MCP server 拉起来，按 JSON-RPC 送五条消息并收齐四个响应。
 * 超时 30 秒：起 MCP + 探 ComfyUI 通常 1~3 秒，慢机器留足余量。
 */
function mcpHandshake({ timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRAPPER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, QQ_BRIDGE_DIR: ROOT },
    });
    let stdout = '';
    let stderr = '';
    const responses = new Map();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP 握手超时（${timeoutMs}ms）；stderr:\n${stderr.slice(-800)}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg = null;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined) responses.set(msg.id, msg);
      }
      if ([1, 2, 3, 4].every((id) => responses.has(id))) {
        clearTimeout(timer);
        child.kill();
        resolve({ responses, stderr, child });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      if ([1, 2, 3, 4].every((id) => responses.has(id))) return;
      clearTimeout(timer);
      reject(new Error(`MCP server 提前退出（code=${code}）；stderr:\n${stderr.slice(-800)}`));
    });
    const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qq-extras-test', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_stats', arguments: {} } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'image_models', arguments: {} } });
  });
}

if (!pluginDir) {
  for (const name of ['握手：initialize / tools/list', '握手：memory_stats 真调一次', '握手：image_models 四个风格']) {
    skip(name, '本机没装 dsh-qq-extras');
  }
} else {
  let handshake = null;
  try {
    handshake = await mcpHandshake();
  } catch (error) {
    failures++;
    console.error('FAIL 握手：MCP server 起不来 —', error?.message ?? error);
  }

  if (handshake) {
    const { responses, stderr } = handshake;
    await test('握手：initialize 认得 qq-extras，12 个工具都在', () => {
      const init = responses.get(1);
      assert.equal(init.result.serverInfo.name, 'qq-extras');
      const tools = responses.get(2).result.tools.map((t) => t.name);
      for (const name of [
        'memory_recent', 'memory_search', 'memory_stats', 'memory_summary_get', 'memory_summary_save', 'memory_context',
        'web_sticker_send', 'voice_send_text', 'voice_send_file', 'qq_self_check', 'image_models', 'image_generate',
      ]) {
        assert.ok(tools.includes(name), `少了工具 ${name}`);
      }
    });

    await test('握手：memory_stats 返回归档统计（上下文增强的主线工具）', () => {
      const res = responses.get(3);
      assert.ok(!res.error, `memory_stats 报错：${JSON.stringify(res.error)}`);
      const text = res.result.content[0].text;
      const stats = JSON.parse(text);
      assert.equal(typeof stats.total, 'number');
      assert.ok(stats.archiveDir, '要报出归档目录');
      assert.equal(typeof stats.byRole.owner, 'number');
      assert.equal(typeof stats.byRole.agent, 'number');
    });

    await test('握手：image_models 报四个风格（ComfyUI 不在线也不许崩）', () => {
      const res = responses.get(4);
      assert.ok(!res.error, `image_models 报错：${JSON.stringify(res.error)}`);
      const out = JSON.parse(res.result.content[0].text);
      assert.equal(typeof out.online, 'boolean');
      assert.equal(out.models.length, 4);
      assert.deepEqual(out.models.map((m) => m.style), ['anime', 'anime-sd15', 'realistic', 'general']);
    });

    await test('壳：stderr 留下可定位的启动行', () => {
      assert.match(stderr, /\[qq-extras\] 启动壳：插件 /);
      assert.match(stderr, /comfy\.mjs (ok|identical|restored)/);
      assert.match(stderr, /QQ_BRIDGE_DIR=/);
    });
  }
}

// ══ 收尾 ════════════════════════════════════════════════════════════════════
console.log(`\nROOT=${ROOT}`);
if (skipped.length) console.log(`（跳过 ${skipped.length} 项：本机/环境所限）`);
if (failures) {
  console.error(`\n❌ dsh-qq-extras MCP 回归失败 ${failures} 项`);
  process.exit(1);
}
console.log('\n✅ dsh-qq-extras MCP 回归全部通过');