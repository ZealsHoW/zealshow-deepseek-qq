/**
 * qqb / engine 的离线测试
 *
 * 两个假服务都在本地起：一个假的常驻 MCP 宿主（tools/list + tools/call），
 * 一个假的模型端点（/chat/completions，按脚本回话）。不碰真 Ollama、真百炼、真 QQ。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createToolbox, toOpenAiTool, SESSION_ARGS, sessionArgsOf } from '../src/qqb/engine/toolbox.mjs';
import { createAgentLoop, composeMessages, injectArgs, summarizeFailures, parseTextToolCalls, stripTextToolCalls } from '../src/qqb/engine/loop.mjs';
import { createModelClient } from '../src/qqb/model/client.mjs';
import { createCallLog, redactEntry, MAX_FIELD_CHARS } from '../src/qqb/core/call-log.mjs';

const TOKEN = 'test-mcp-token';

/** 1×1 的 PNG，够当「图片内容」使了。 */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/* ------------------------------- 假 MCP 宿主 ------------------------------- */

async function fakeMcp({ toolsA, toolsB, token = TOKEN }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify(obj));
      };
      if (req.headers['x-mcp-token'] !== token) {
        send(401, { jsonrpc: '2.0', error: { code: -32001, message: 'x-mcp-token 无效' }, id: null });
        return;
      }
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      if (!body) { send(400, { error: 'bad json' }); return; }
      calls.push({ path: req.url, method: body.method, params: body.params ?? null });
      const tools = req.url.includes('/a/') ? toolsA : toolsB;
      if (body.method === 'tools/list') {
        send(200, { jsonrpc: '2.0', id: body.id, result: { tools } });
        return;
      }
      if (body.method === 'tools/call') {
        const name = body.params?.name;
        const args = body.params?.arguments ?? {};
        if (name === 'boom') {
          send(200, { jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: '炸了：权限不足' }] } });
          return;
        }
        if (name === 'long') {
          send(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'x'.repeat(9000) }] } });
          return;
        }
        if (name === 'picture') {
          send(200, { jsonrpc: '2.0', id: body.id, result: { content: [
            { type: 'text', text: '取回 1 张图片' },
            { type: 'image', mimeType: 'image/png', data: PIXEL },
          ] } });
          return;
        }
        send(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ echo: name, args }) }] } });
        return;
      }
      send(200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `没有这个方法：${body.method}` } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    calls,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

const TOOL_STATUS = {
  name: 'qq_status',
  description: '查询登录状态',
  inputSchema: { type: 'object', properties: { key: { type: 'string' }, token: { type: 'string' } }, required: ['key', 'token'] },
};
const TOOL_SEND = {
  name: 'qq_send_message',
  description: '发消息',
  inputSchema: { type: 'object', properties: { key: { type: 'string' }, token: { type: 'string' }, messages: { type: 'string' } }, required: ['key', 'token', 'messages'] },
};
const TOOL_HOST = { name: 'snowluma_status', description: '网关状态', inputSchema: { type: 'object', properties: {} } };
const TOOL_BOOM = { name: 'boom', description: '会报错的工具', inputSchema: { type: 'object', properties: {} } };
const TOOL_LONG = { name: 'long', description: '返回超长文本的工具', inputSchema: { type: 'object', properties: {} } };
// 像 qq_get_message_images 那样：结果里带真的图片内容（base64）。
const TOOL_PICTURE = { name: 'picture', description: '返回一张图片的工具', inputSchema: { type: 'object', properties: {} } };
// 像 qq_describe_image 那样：key/token 是**可选属性**，required 里没有它们。
// 旧代码按 required 判「要不要补会话参数」，于是这两个永远补不进 → 调用必失败。
const TOOL_OPTIONAL = {
  name: 'qq_describe_image',
  description: '看图',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' }, key: { type: 'string' }, token: { type: 'string' } },
    required: ['url'],
  },
};

/* -------------------------------- 假模型端点 -------------------------------- */

async function fakeModel(script) {
  const calls = [];
  let index = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      calls.push({ url: req.url, body });
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (step?.status && step.status !== 200) {
        res.writeHead(step.status, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: { message: step.message ?? 'boom' } }));
        return;
      }
      const message = { role: 'assistant', content: step?.content ?? '' };
      if (step?.tool_calls) message.tool_calls = step.tool_calls;
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({
        model: 'fake-model',
        choices: [{ finish_reason: step?.tool_calls ? 'tool_calls' : 'stop', message }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    calls,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

function modelOf(fake, extra = {}) {
  return createModelClient({
    config: { model: { enabled: true, baseUrl: fake.baseUrl, model: 'fake-model', apiKey: 'sk-test-123456', maxRetries: 0, ...extra } },
    env: {},
    fetchImpl: fetch,
  });
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args ?? {}) } };
}

/* ---------------------------------- 用例 ---------------------------------- */

test('toOpenAiTool：会话参数 key/token 从 schema 里摘掉，别的保留', () => {
  const tool = toOpenAiTool(TOOL_SEND);
  assert.equal(tool.type, 'function');
  assert.equal(tool.function.name, 'qq_send_message');
  assert.deepEqual(Object.keys(tool.function.parameters.properties), ['messages']);
  assert.deepEqual(tool.function.parameters.required, ['messages'], '被摘掉的参数不能留在 required 里');
  assert.ok(SESSION_ARGS.includes('key') && SESSION_ARGS.includes('token'));
  // 原本没有 required 的工具不该凭空长出 required
  assert.equal(toOpenAiTool(TOOL_HOST).function.parameters.required, undefined);
  // key/token 只是可选属性时也要摘干净（qq_describe_image 那种）
  const optional = toOpenAiTool(TOOL_OPTIONAL);
  assert.deepEqual(Object.keys(optional.function.parameters.properties), ['url']);
  assert.deepEqual(optional.function.parameters.required, ['url']);
});

test('sessionArgsOf：按 schema 声明过的属性判，不按 required 判', () => {
  assert.deepEqual(sessionArgsOf(TOOL_STATUS), ['key', 'token']);
  assert.deepEqual(sessionArgsOf(TOOL_OPTIONAL), ['key', 'token'], '可选属性也算「声明过」');
  assert.deepEqual(sessionArgsOf(TOOL_HOST), []);
  assert.deepEqual(sessionArgsOf({ inputSchema: { type: 'object' } }), []);
});

test('toolbox：合并两个端点的工具，重名保留先到的并记进 collisions', async () => {
  const fake = await fakeMcp({ toolsA: [TOOL_STATUS, TOOL_SEND], toolsB: [TOOL_STATUS, TOOL_HOST] });
  try {
    const box = createToolbox({ baseUrl: fake.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }, { server: 'b', path: '/b/mcp' }] });
    const info = await box.refresh();
    assert.equal(info.tools, 3, '重名的 qq_status 只留一个');
    assert.equal(info.collisions.length, 1);
    assert.deepEqual(info.collisions[0], { name: 'qq_status', kept: 'a', skipped: 'b' });
    assert.deepEqual(box.names().sort(), ['qq_send_message', 'qq_status', 'snowluma_status']);
    assert.equal(box.find('snowluma_status').server, 'b');
  } finally {
    await fake.close();
  }
});

test('toolbox：tools/call 正常返回文本，记到对应端点上', async () => {
  const fake = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [TOOL_HOST] });
  try {
    const box = createToolbox({ baseUrl: fake.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }, { server: 'b', path: '/b/mcp' }] });
    await box.refresh();
    const res = await box.call('snowluma_status', {});
    assert.equal(res.ok, true);
    assert.equal(res.server, 'b');
    assert.match(res.text, /snowluma_status/);
    assert.equal(box.stats().byServer.b, 1);
    assert.equal(box.stats().calls, 1);
  } finally {
    await fake.close();
  }
});

test('toolbox：工具自己报错（isError）→ ok:false，错误文本照样带回来', async () => {
  const fake = await fakeMcp({ toolsA: [TOOL_STATUS, TOOL_BOOM], toolsB: [TOOL_HOST] });
  try {
    const box = createToolbox({ baseUrl: fake.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const res = await box.call('boom', {});
    assert.equal(res.ok, false);
    assert.equal(res.isError, true);
    assert.match(res.text, /权限不足/);
    assert.equal(box.stats().failures, 1);
  } finally {
    await fake.close();
  }
});

test('toolbox：没这个工具、token 不对都给出人话错误', async () => {
  const fake = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  try {
    const box = createToolbox({ baseUrl: fake.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const none = await box.call('qq_nothing', {});
    assert.equal(none.ok, false);
    assert.match(none.error, /没有这个工具/);

    const bad = createToolbox({ baseUrl: fake.baseUrl, token: 'wrong', endpoints: [{ server: 'a', path: '/a/mcp' }] });
    const info = await bad.refresh();
    assert.equal(info.tools, 0);
    assert.match(bad.stats().lastError, /HTTP 401/, 'token 不对要报 401 而不是静默');
    const res = await bad.call('qq_status', {});
    assert.equal(res.ok, false);
    assert.match(res.error, /没有这个工具/, '清单没拉到时也说清楚');
  } finally {
    await fake.close();
  }
});

test('toolbox：超长结果被截断，并说明原长', async () => {
  const fake = await fakeMcp({ toolsA: [TOOL_STATUS, TOOL_LONG], toolsB: [] });
  try {
    const box = createToolbox({ baseUrl: fake.baseUrl, token: TOKEN, maxResultChars: 100, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const res = await box.call('long', {});
    assert.equal(res.ok, true);
    assert.ok(res.text.length < 200, '不能把 9000 字原样塞回上下文');
    assert.match(res.text, /已截断，原长 9000 字/);
  } finally {
    await fake.close();
  }
});

test('composeMessages：system 可为空，历史在 user 之前', () => {
  const plain = composeMessages({ user: '在吗' });
  assert.deepEqual(plain, [{ role: 'user', content: '在吗' }]);
  const full = composeMessages({ system: ' 你是小鲸鱼 ', user: '在吗', history: [{ role: 'assistant', content: '嗯' }, { role: 'user', content: '刚干嘛去了' }] });
  assert.equal(full[0].role, 'system');
  assert.equal(full[0].content, '你是小鲸鱼', 'system 两端空白要去掉');
  assert.deepEqual(full.slice(1).map((m) => m.role), ['assistant', 'user', 'user']);
  assert.equal(composeMessages({ history: [{ role: 'user', content: '' }], user: '' }).length, 0);
});

test('injectArgs：补 schema 声明过的、模型没给的会话参数', () => {
  const entry = { required: ['key', 'token', 'messages'], session: ['key', 'token'] };
  const merged = injectArgs(entry, { messages: 'hi' }, { key: 'group:1', token: 'abc', messages: '不许覆盖我' });
  assert.deepEqual(merged, { messages: 'hi', key: 'group:1', token: 'abc' });
  const kept = injectArgs(entry, { key: '模型自己给的', messages: 'hi' }, { key: '不该用它' });
  assert.equal(kept.key, '模型自己给的');
  // 可选会话参数（required 里没有它们）照样要补——这正是 0.1.3 修的 bug
  const optional = injectArgs({ required: ['url'], session: ['key', 'token'] }, { url: 'u' }, { key: 'group:1', token: 'abc' });
  assert.deepEqual(optional, { url: 'u', key: 'group:1', token: 'abc' });
  // 旧形状（只有 required）仍然兜底
  assert.deepEqual(injectArgs({ required: ['key'] }, {}, { key: 'k', token: '不该补' }), { key: 'k' });
});

test('回路：模型直接说话 → ok、一步结束、不需要工具', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const fakeModelSrv = await fakeModel([{ content: '我刚在发呆呢，怎么啦？' }]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({ system: '你是小鲸鱼', user: '在吗' });
    assert.equal(out.ok, true);
    assert.equal(out.text, '我刚在发呆呢，怎么啦？');
    assert.equal(out.steps, 1);
    assert.equal(out.toolCalls.length, 0);
    assert.equal(out.fallbackSafe, false);
    const body = fakeModelSrv.calls[0].body;
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.tools.length, 1, '工具清单要带给模型');
    assert.equal(loop.stats().ok, 1);
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：每轮开跑前重新拉一次工具目录（3210 新加的工具不用重启桥接）', async () => {
  // 2026-10-25 的坑：qq_memory_search / knowledge_* 已经上线、提示词都在教她用，
  // 但引擎目录是桥接启动时缓存的旧快照，模型压根看不到这三件。
  const toolsA = [TOOL_STATUS];
  const mcp = await fakeMcp({ toolsA, toolsB: [] });
  const fakeModelSrv = await fakeModel([{ content: '嗯' }, { content: '嗯嗯' }]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    await loop.run({ system: 's', user: '第一轮' });
    assert.equal(fakeModelSrv.calls[0].body.tools.length, 1, '第一轮只有 1 个工具');
    toolsA.push(TOOL_SEND); // 常驻服务上新加一件，桥接没重启
    await loop.run({ system: 's', user: '第二轮' });
    assert.equal(fakeModelSrv.calls[1].body.tools.length, 2, '第二轮就该看到新工具');
    assert.ok(fakeModelSrv.calls[1].body.tools.some((t) => t.function.name === 'qq_send_message'));
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：工具目录刷新失败也不挡这一轮（沿用上一份目录）', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const fakeModelSrv = await fakeModel([{ content: '照常说话' }]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    box.refresh = async () => { throw new Error('3210 正在重启'); };
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({ system: 's', user: 'u' });
    assert.equal(out.ok, true);
    assert.equal(out.text, '照常说话');
    assert.equal(fakeModelSrv.calls[0].body.tools.length, 1, '刷新失败要用缓冲里那份');
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：模型要工具 → 引擎执行 → 把结果塞回去 → 模型再说话', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS, TOOL_SEND], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('call_1', 'qq_status', {})] },
    { content: '在线呢，找我有事？' },
  ]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({ system: 's', user: 'u', extraArgs: { key: 'private:1', token: 'tok' } });
    assert.equal(out.ok, true);
    assert.equal(out.text, '在线呢，找我有事？');
    assert.equal(out.steps, 2);
    assert.deepEqual(out.toolCalls.map((c) => c.name), ['qq_status']);
    assert.equal(out.toolCalls[0].ok, true);
    // 第二轮请求里应该有 assistant(tool_calls) + tool 结果，并且会话参数被引擎补上了
    const second = fakeModelSrv.calls[1].body.messages;
    assert.equal(second.at(-2).role, 'assistant');
    assert.equal(second.at(-2).tool_calls[0].function.name, 'qq_status');
    assert.equal(second.at(-1).role, 'tool');
    assert.equal(second.at(-1).tool_call_id, 'call_1');
    assert.match(second.at(-1).content, /private:1/, 'key 要由引擎注入，模型不用知道');
    assert.match(second.at(-1).content, /tok/);
    assert.equal(mcp.calls.filter((c) => c.method === 'tools/call').length, 1);
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：key/token 只是可选属性时也要注入（她 10 次看图 10 次失败的那个 bug）', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_OPTIONAL], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('call_1', 'qq_describe_image', { url: 'https://x/1.jpg' })] },
    { content: '看到了，是一只鲸鱼' },
  ]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    assert.deepEqual(box.find('qq_describe_image').session, ['key', 'token'], 'entry 要带上声明过的会话参数');
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({ system: 's', user: 'u', extraArgs: { key: 'group:900000001', token: 'agent-token-1' } });
    assert.equal(out.ok, true);
    const call = mcp.calls.find((c) => c.method === 'tools/call');
    assert.equal(call.params.arguments.key, 'group:900000001', '可选声明也要补 key');
    assert.equal(call.params.arguments.token, 'agent-token-1', '可选声明也要补 token');
    assert.equal(call.params.arguments.url, 'https://x/1.jpg');
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：第一次模型调用就失败 → 可以安全回退（一个工具都没跑）', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const fakeModelSrv = await fakeModel([{ status: 400, message: '模型参数不对' }]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({ system: 's', user: 'u' });
    assert.equal(out.ok, false);
    assert.equal(out.fallbackSafe, true, '没执行过工具，回退是安全的');
    assert.match(out.error, /模型/);
    assert.equal(mcp.calls.filter((c) => c.method === 'tools/call').length, 0);
    assert.equal(loop.stats().fallbacks, 1);
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：已经跑过工具后再失败 → 绝不能回退（否则消息发两遍）', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_SEND], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('call_1', 'qq_send_message', { messages: '晚安' })] },
    { status: 500, message: '网关炸了' },
  ]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({ system: 's', user: 'u', extraArgs: { key: 'group:1', token: 'tok' } });
    assert.equal(out.ok, false);
    assert.equal(out.fallbackSafe, false, '执行过工具就回退不安全');
    assert.equal(out.toolCalls.length, 1);
    assert.equal(mcp.calls.filter((c) => c.method === 'tools/call').length, 1);
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：撞上最大步数、救援也救不回来 → exhausted，且同样不允许回退', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('c1', 'qq_status', {})] },
    { tool_calls: [toolCall('c2', 'qq_status', {})] },
    // 最后一步永远是要工具（fakeModel 会无限重复最后一步），所以救援那次也拿不到话。
    { tool_calls: [toolCall('c3', 'qq_status', {})] },
  ]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({ system: 's', user: 'u', maxSteps: 2, extraArgs: { key: 'k', token: 't' } });
    assert.equal(out.ok, false);
    assert.equal(out.exhausted, true);
    assert.equal(out.steps, 2);
    assert.equal(out.fallbackSafe, false);
    assert.equal(fakeModelSrv.calls.length, 3, '2 步 + 1 次不带工具的救援');
    assert.equal(fakeModelSrv.calls[2].body.tools, undefined, '救援那次不能带工具');
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：步数用尽但工具是好的 → 至少要出一句话，不许一声不吭', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('c1', 'qq_status', {})] },
    { tool_calls: [toolCall('c2', 'qq_status', {})] },
    { content: '查到了，我说一句' },
  ]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({ system: 's', user: 'u', maxSteps: 2 });
    assert.equal(out.ok, true, '救援救回来就该照常发言');
    assert.equal(out.rescued, true);
    assert.equal(out.text, '查到了，我说一句');
    assert.equal(out.steps, 2);
    assert.equal(out.toolCalls.length, 2);
    assert.equal(out.fallbackSafe, false, '跑过工具就绝不回退');
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：模型写出半截 JSON 也要活下来（当失败结果塞回去，继续走）', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'qq_status', arguments: '{"key": ' } }] },
    { content: '参数写坏了，我直接说' },
  ]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({ system: 's', user: 'u' });
    assert.equal(out.ok, true);
    assert.equal(out.toolCalls[0].ok, false);
    assert.equal(mcp.calls.filter((c) => c.method === 'tools/call').length, 0, '参数坏掉就不该真去调工具');
    assert.match(fakeModelSrv.calls[1].body.messages.at(-1).content, /不是合法 JSON/);
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：一轮要太多工具时按上限砍掉，并留日志', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => toolCall(`c${i}`, 'qq_status', {}));
  const fakeModelSrv = await fakeModel([{ tool_calls: many }, { content: '够了' }]);
  const warns = [];
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box, maxToolCalls: 2, logger: { warn: (m) => warns.push(String(m)) } });
    const out = await loop.run({ system: 's', user: 'u', extraArgs: { key: 'k', token: 't' } });
    assert.equal(out.ok, true);
    assert.equal(out.toolCalls.length, 2);
    assert.equal(mcp.calls.filter((c) => c.method === 'tools/call').length, 2);
    assert.ok(warns.some((line) => /只执行前 2 个/.test(line)), '砍工具要留日志');
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：intercept 拦下的调用不发给 MCP，但仍算「跑过工具」（不许回退）', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('c1', 'qq_status', {})] },
    { content: '我发完了' },
  ]);
  const seen = [];
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({
      system: 's',
      user: 'u',
      extraArgs: { key: 'k', token: 't' },
      intercept: (name, args, entry) => {
        seen.push({ name, args, entry });
        return { ok: true, text: '意向已记下' };
      },
    });
    assert.equal(out.ok, true);
    assert.equal(out.fallbackSafe, false, '被拦下的调用也是跑过工具，不能回退 DSH');
    assert.deepEqual(out.toolCalls, [{ name: 'qq_status', ok: true, ms: 0, error: null }]);
    assert.equal(mcp.calls.filter((c) => c.method === 'tools/call').length, 0, '拦下了就不该真的去打 MCP');
    assert.equal(fakeModelSrv.calls[1].body.messages.at(-1).content, '意向已记下');
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].args, { key: 'k', token: 't' }, 'intercept 拿到的是注入过会话参数的实参');
    assert.equal(seen[0].entry?.server, 'a');
    assert.equal(seen[0].entry?.tool?.name, 'qq_status');
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：intercept 抛错不炸整轮，转成失败结果继续走', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('c1', 'qq_status', {})] },
    { content: '算了，直接说' },
  ]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({
      system: 's',
      user: 'u',
      extraArgs: { key: 'k', token: 't' },
      intercept: () => { throw new Error('队列炸了'); },
    });
    assert.equal(out.ok, true);
    assert.equal(out.toolCalls[0].ok, false);
    assert.match(out.toolCalls[0].error, /队列炸了/);
    assert.match(fakeModelSrv.calls[1].body.messages.at(-1).content, /工具执行失败：拦截处理失败：队列炸了/);
    assert.equal(mcp.calls.filter((c) => c.method === 'tools/call').length, 0);
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：intercept 返回 null 的工具照常走 MCP', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('c1', 'qq_status', {})] },
    { content: '查完了' },
  ]);
  let intercepts = 0;
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({
      system: 's',
      user: 'u',
      extraArgs: { key: 'k', token: 't' },
      intercept: () => { intercepts += 1; return null; },
    });
    assert.equal(out.ok, true);
    assert.equal(intercepts, 1);
    assert.equal(mcp.calls.filter((c) => c.method === 'tools/call').length, 1, '没认领就照常执行');
    assert.equal(out.toolCalls[0].ok, true);
    assert.match(fakeModelSrv.calls[1].body.messages.at(-1).content, /"echo":"qq_status"/);
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

/* ------------------------- 工具调用落盘（core/call-log） ------------------------- */
// 背景：引擎的工具统计原来只在内存里，落盘的 tool-calls.jsonl 只有 DSH 那条链路在写，
// 引擎一接管主链路日志就整段变黑。下面这组用例锁住「引擎也写、格式一致、且必须脱敏」。

function tmpLogFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-call-log-'));
  return { dir, file: path.join(dir, 'tool-calls.jsonl') };
}

test('call-log：redactEntry 按敏感键打码、超长截断、危险键不落盘', () => {
  const out = redactEntry({
    tool: 'qq_send_message',
    args: { key: 'group:1', token: 'real-agent-token', messages: 'x'.repeat(MAX_FIELD_CHARS + 50) },
    error: 'sk-abcdefghijklmnop 不能出现',
  });
  assert.equal(out.args.token, '***', 'token 必须打码');
  assert.equal(out.args.key, 'group:1', 'key 不是凭据，保留（和 DSH 链路一致）');
  assert.ok(out.args.messages.length < MAX_FIELD_CHARS + 60, '超长字段要截断');
  assert.match(out.args.messages, /已截断/, '截断要说清楚原长');
  assert.ok(!String(out.error).includes('sk-abcdefghijklmnop'), '凭据正则要生效');
  // 原型链护栏：模型/工具参数里来的键不能写进日志对象
  assert.equal(Object.prototype.hasOwnProperty.call(redactEntry(JSON.parse('{"__proto__":{"polluted":true}}')), '__proto__'), false);
  assert.equal({}.polluted, undefined);
});

test('call-log：超过行数上限轮转到 .1，新文件从零开始', () => {
  const { file } = tmpLogFile();
  const log = createCallLog({ file, maxLines: 3 });
  for (let i = 0; i < 4; i += 1) log.appendLine(`{"n":${i}}\n`);
  // 第 4 行让计数超过上限 → 当前文件整体改名成 .1
  assert.equal(fs.existsSync(file), false, '轮转后当前文件应被移走');
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8').split('\n').filter(Boolean).length, 4);
  log.appendLine('{"n":4}\n');
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1, '轮转后重新计数');
  assert.equal(log.stats().rotations, 1);
});

test('call-log：append 与 appendLine 共用同一个计数器（两条链路不能各数各的）', () => {
  const { file } = tmpLogFile();
  const log = createCallLog({ file, maxLines: 3 });
  log.appendLine('{"src":"dsh"}\n');
  log.append({ src: 'engine', n: 2 });
  log.appendLine('{"src":"dsh"}\n');
  log.append({ src: 'engine', n: 4 });
  // 混写 4 条也只轮转一次：上限是「这个文件」的，不是某个调用方的
  assert.equal(log.stats().appended, 4);
  assert.equal(log.stats().rotations, 1);
});

test('call-log：clear() 连计数器一起归零，清完不会立刻误轮转', () => {
  const { file } = tmpLogFile();
  const log = createCallLog({ file, maxLines: 3 });
  for (let i = 0; i < 3; i += 1) log.appendLine(`{"n":${i}}\n`);
  assert.equal(log.stats().lines, 3);
  log.clear();
  assert.equal(fs.readFileSync(file, 'utf8'), '');
  assert.equal(log.stats().lines, 0, '计数器必须跟着归零');
  log.appendLine('{"n":"after"}\n');
  assert.equal(log.stats().rotations, 0, '清空后的第一次追加不该触发轮转');
  assert.equal(fs.existsSync(`${file}.1`), false);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), '{"n":"after"}');
});

test('toolLog：每执行一个工具写 call + result 两条，字段与 DSH 链路对齐', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS, TOOL_SEND], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('call_1', 'qq_status', {})] },
    { content: '在线呢' },
  ]);
  const logs = [];
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box, toolLog: (entry) => logs.push(entry) });
    const out = await loop.run({ system: 's', user: 'u', extraArgs: { key: 'private:1', token: 'tok' } });
    assert.equal(out.ok, true);
    assert.equal(logs.length, 2, '一个工具 = call + result 两条');
    const [call, result] = logs;
    assert.equal(call.type, 'call');
    assert.equal(call.source, 'engine', '必须能分辨是引擎还是 DSH 链路写的');
    assert.equal(call.tool, 'qq_status');
    assert.equal(call.key, 'private:1');
    assert.equal(call.purpose, 'qq-direct');
    assert.deepEqual(call.args, { key: 'private:1', token: 'tok' }, '记的是注入过会话参数的实参');
    assert.equal(result.type, 'result');
    assert.equal(result.tool, 'qq_status');
    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.equal(typeof result.ms, 'number');
    assert.equal(result.source, 'engine');
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('toolLog：落进文件的条目已脱敏——agent token 绝不出现明文', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_SEND], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('call_1', 'qq_send_message', { messages: '晚安' })] },
    { content: '发完了' },
  ]);
  const { file } = tmpLogFile();
  const callLog = createCallLog({ file, maxLines: 2000 });
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box, toolLog: (entry) => callLog.append(entry) });
    await loop.run({ system: 's', user: 'u', extraArgs: { key: 'group:1', token: 'secret-agent-token' } });

    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.ok(!raw.includes('secret-agent-token'), 'agent token 绝不能明文落盘');
    const call = JSON.parse(lines[0]);
    assert.equal(call.args.token, '***');
    assert.equal(call.args.key, 'group:1');
    assert.equal(call.args.messages, '晚安');
    assert.equal(call.source, 'engine');
    // 读回来的能力也要在（控制台的「工具调用」页走这条路）
    assert.equal(callLog.read(10).length, 2);
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('toolLog：参数是半截 JSON 时也留痕（ok:false），且不真去调 MCP', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'qq_status', arguments: '{"key": ' } }] },
    { content: '参数写坏了' },
  ]);
  const logs = [];
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box, toolLog: (entry) => logs.push(entry) });
    await loop.run({ system: 's', user: 'u', extraArgs: { key: 'k', token: 't' } });
    assert.equal(mcp.calls.filter((c) => c.method === 'tools/call').length, 0);
    assert.equal(logs.length, 2, '没真跑也要留痕，否则事后看不出模型把参数写坏了');
    assert.equal(logs[0].type, 'call');
    assert.equal(logs[0].args, '{"key": ', '解析不了就记原文');
    assert.equal(logs[1].ok, false);
    assert.match(logs[1].error, /不是合法 JSON/);
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('toolLog：钩子抛错只警告，绝不拖垮这一轮', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('c1', 'qq_status', {})] },
    { content: '查完了' },
  ]);
  const warns = [];
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({
      model: modelOf(fakeModelSrv),
      toolbox: box,
      logger: { warn: (m) => warns.push(String(m)) },
      toolLog: () => { throw new Error('磁盘满了'); },
    });
    const out = await loop.run({ system: 's', user: 'u', extraArgs: { key: 'k', token: 't' } });
    assert.equal(out.ok, true, '日志写不进去不能把对话拖垮');
    assert.equal(out.text, '查完了');
    assert.ok(warns.some((line) => /写工具调用日志失败/.test(line)), '但必须留下警告');
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

// ─────────────────── 0.1.4：工具连着坏时「别哑掉」的两条护栏 ───────────────────

test('summarizeFailures：只数失败的，按工具聚合', () => {
  assert.equal(summarizeFailures([]), '');
  assert.equal(summarizeFailures([{ name: 'a', ok: true }]), '');
  assert.equal(
    summarizeFailures([
      { name: 'qq_describe_image', ok: false },
      { name: 'qq_get_message_images', ok: false },
      { name: 'qq_describe_image', ok: false },
      { name: 'qq_get_recent_messages', ok: true },
    ]),
    'qq_describe_image×2、qq_get_message_images×1',
  );
});

test('回路：工具连续失败 3 次就停手，改为要一句话（不再空烧到最大步数）', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_BOOM], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('c1', 'boom', {})] },
    { tool_calls: [toolCall('c2', 'boom', {})] },
    { tool_calls: [toolCall('c3', 'boom', {})] },
    // 第 4 次模型调用就是救援那一次（前 3 次各失败一个工具后就停手了）。
    { content: '工具坏了，那我直接说' },
  ]);
  const warns = [];
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box, logger: { warn: (m) => warns.push(String(m)) } });
    const out = await loop.run({ system: 's', user: 'u', maxSteps: 4 });
    assert.equal(out.ok, true, '救援成功就该照常说话');
    assert.equal(out.rescued, true);
    assert.equal(out.text, '工具坏了，那我直接说');
    assert.equal(out.steps, 3, '第三次失败后就该停手，不该烧到第 4 步');
    assert.equal(out.toolCalls.length, 3);
    assert.ok(out.toolCalls.every((item) => item.ok === false));
    assert.ok(warns.some((line) => /工具连续失败 3 次/.test(line)), '停手要留日志');
    // 救援请求必须是「不带工具」的那一次 —— 这正是她不会一声不吭的原因。
    const rescue = fakeModelSrv.calls.at(-1).body;
    assert.equal(rescue.tools, undefined, '救援请求不能带工具');
    assert.match(rescue.messages.at(-1).content, /不要再调用任何工具/);
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：救不回来时，error 要指名道姓说是哪个工具在坏', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_BOOM], toolsB: [] });
  // fakeModel 会把最后一个 step 无限重复，所以连救援那一次也只会要工具、拿不到话。
  const fakeModelSrv = await fakeModel([{ tool_calls: [toolCall('c1', 'boom', {})] }]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({ system: 's', user: 'u', maxSteps: 4 });
    assert.equal(out.ok, false);
    assert.equal(out.exhausted, true);
    assert.equal(out.steps, 3, '连续失败 3 次就停手');
    assert.match(out.error, /达到最大步数（4 步）还没说话/);
    assert.match(out.error, /失败的工具：boom×3/, 'error 里要写明工具与次数，下次不必再翻日志');
    assert.equal(out.fallbackSafe, false, '跑过工具就绝不回退');
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('回路：中间有一次成功就不算「连续失败」，照常走完步数', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_BOOM, TOOL_STATUS], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('c1', 'boom', {})] },
    { tool_calls: [toolCall('c2', 'qq_status', {})] },
    { tool_calls: [toolCall('c3', 'boom', {})] },
    { tool_calls: [toolCall('c4', 'boom', {})] },
  ]);
  const warns = [];
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box, logger: { warn: (m) => warns.push(String(m)) } });
    const out = await loop.run({ system: 's', user: 'u', maxSteps: 4 });
    assert.equal(out.steps, 4, '成功一次就把连败清零，不该提前停手');
    assert.equal(out.toolCalls[1].ok, true);
    assert.ok(!warns.some((line) => /工具连续失败/.test(line)), '没到连续失败上限就不该喊停手');
    assert.match(out.error, /失败的工具：boom×3/);
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('toolbox：图片结果要带出来，不能只剩一个「[图片]」', async () => {
  const fake = await fakeMcp({ toolsA: [TOOL_PICTURE], toolsB: [] });
  try {
    const box = createToolbox({ baseUrl: fake.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const res = await box.call('picture', {});
    assert.equal(res.ok, true);
    assert.match(res.text, /取回 1 张图片/);
    assert.match(res.text, /\[图片\]/, '文字里仍然留个占位，模型才知道结果里有图');
    assert.equal(res.images.length, 1, '像素必须原样带出来');
    assert.equal(res.images[0].mimeType, 'image/png');
    assert.equal(res.images[0].data, PIXEL);
  } finally {
    await fake.close();
  }
});

test('回路：工具取回的图片要作为多模态 user 消息交给模型（否则她「看不见图」）', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_PICTURE], toolsB: [] });
  const fakeModelSrv = await fakeModel([
    { tool_calls: [toolCall('c1', 'picture', {})] },
    { content: '看到了，是一张 1×1 的图。' },
  ]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({ system: 's', user: 'u', maxSteps: 4 });

    assert.equal(out.ok, true);
    assert.equal(out.text, '看到了，是一张 1×1 的图。');

    // 第二次模型请求里必须真的带着图片：tool 消息只能放文本，所以另起一条 user 多模态消息。
    const second = fakeModelSrv.calls[1].body.messages;
    const toolMsg = second.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '工具结果本身照旧用 role:tool 回');
    assert.equal(toolMsg.content, '取回 1 张图片\n[图片]', 'tool 消息里只能放文字');

    const picMsg = second.find((m) => m.role === 'user' && Array.isArray(m.content));
    assert.ok(picMsg, '图片要另起一条 user 多模态消息，模型才看得见');
    const imagePart = picMsg.content.find((p) => p.type === 'image_url');
    assert.ok(imagePart, '图片内容必须是 image_url part');
    assert.equal(imagePart.image_url.url, `data:image/png;base64,${PIXEL}`);

    // transcript 里不要抄 base64（几百 KB 的日志没人看得下去）
    const transcriptPic = out.transcript.find((m) => m.role === 'user' && String(m.content).includes('[图片 ×'));
    assert.ok(transcriptPic, 'transcript 里只留记号');
    assert.ok(!JSON.stringify(out.transcript).includes(PIXEL.slice(0, 40)), 'base64 不该进 transcript');
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

test('parseTextToolCalls：把模型写进正文的 XML 方言翻成真正的调用', () => {
  // 2026-10-22 00:25 真发生过的事：她把下面这一段原文当消息发进了 QQ。
  const raw = [
    '<tool calls>',
    '<tool invoke name="qq_describe_image">',
    '<parameter name="messageId">最近一条</parameter>',
    '</tool invoke>',
    '<tool invoke name="qq_get_recent_messages">',
    '<parameter name="limit">15</parameter>',
    '</tool invoke>',
    '</tool calls>',
  ].join('\n');
  const calls = parseTextToolCalls(raw);
  assert.deepEqual(calls.map((c) => c.name), ['qq_describe_image', 'qq_get_recent_messages']);
  assert.deepEqual(JSON.parse(calls[0].arguments), { messageId: '最近一条' });
  assert.deepEqual(JSON.parse(calls[1].arguments), { limit: 15 }, '数字要还原成数字，不是字符串');
  assert.equal(stripTextToolCalls(raw), '', '整段就是调用，抹完什么都不剩');

  // 前面有人话时只抹标签，人话留着；不是调用就一个字都别动
  assert.equal(stripTextToolCalls(`我去瞅一眼。\n${raw}`), '我去瞅一眼。');
  const plain = '他发了个 <3 给我，真可爱';
  assert.equal(parseTextToolCalls(plain).length, 0);
  assert.equal(stripTextToolCalls(plain), plain);
  assert.equal(stripTextToolCalls(''), '');
});

test('parseTextToolCalls：认 antml: 前缀、string="true" 与实体转义', () => {
  const raw = '<antml:invoke name="qq_status">'
    + '<antml:parameter name="note" string="true">7 &lt; 9 &amp; 3</antml:parameter>'
    + '<antml:parameter name="n">2</antml:parameter>'
    + '</antml:invoke>';
  const calls = parseTextToolCalls(raw);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'qq_status');
  assert.deepEqual(JSON.parse(calls[0].arguments), { note: '7 < 9 & 3', n: 2 });
  assert.equal(stripTextToolCalls(`前缀 ${raw} 后缀`), '前缀  后缀');
});

test('回路：模型把工具调用写成正文时，照样执行、且标签不会发出去', async () => {
  const mcp = await fakeMcp({ toolsA: [TOOL_STATUS], toolsB: [] });
  const xml = [
    '<tool calls>',
    '<tool invoke name="qq_status">',
    '<parameter name="key">private:1</parameter>',
    '</tool invoke>',
    '</tool calls>',
  ].join('\n');
  const fakeModelSrv = await fakeModel([{ content: xml }, { content: '我在呢。' }]);
  try {
    const box = createToolbox({ baseUrl: mcp.baseUrl, token: TOKEN, endpoints: [{ server: 'a', path: '/a/mcp' }] });
    await box.refresh();
    const loop = createAgentLoop({ model: modelOf(fakeModelSrv), toolbox: box });
    const out = await loop.run({ system: 's', user: 'u', extraArgs: { key: 'private:1', token: 'tok' } });
    assert.equal(out.ok, true);
    assert.equal(out.text, '我在呢。');
    assert.equal(out.steps, 2);
    assert.deepEqual(out.toolCalls.map((c) => c.name), ['qq_status'], '写成正文的调用也要真的跑');
    const toolCalls = mcp.calls.filter((c) => c.method === 'tools/call');
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].params.name, 'qq_status');
    assert.equal(toolCalls[0].params.arguments.key, 'private:1');
    assert.equal(toolCalls[0].params.arguments.token, 'tok', '会话参数照旧由引擎注入');
    // 回给模型的 assistant 消息里不该再留着那段 XML
    const assistant = fakeModelSrv.calls[1].body.messages.find((m) => m.role === 'assistant');
    assert.ok(assistant && Array.isArray(assistant.tool_calls) && assistant.tool_calls.length === 1, '要按真调用记进对话');
    assert.ok(!String(assistant.content).includes('tool invoke'), '正文里的标签要抹掉');
    assert.ok(!JSON.stringify(out.transcript).includes('<tool invoke'), 'transcript 里也不留标签');
  } finally {
    await fakeModelSrv.close();
    await mcp.close();
  }
});

// —— 以下是 2026-10-22 那次真实事故的形态：DeepSeek 原生 DSML，竖线是 U+FF5C ——
const DSML_BAR = '\uff5c';
const dsmlOpen = (tag) => `<${DSML_BAR}DSML${DSML_BAR} ${tag}>`;
const dsmlClose = (tag) => `</${DSML_BAR}DSML${DSML_BAR} ${tag}>`;

test('parseTextToolCalls：认 DeepSeek 原生 DSML 标记（她 00:25 发进 QQ 的就是这个）', () => {
  const xml = [
    dsmlOpen('calls'),
    dsmlOpen('invoke name="qq_describe_image"'),
    dsmlOpen('parameter name="messageId"') + '最近一条' + dsmlClose('parameter'),
    dsmlClose('invoke'),
    dsmlOpen('invoke name="qq_get_recent_messages"'),
    dsmlOpen('parameter name="limit"') + '15' + dsmlClose('parameter'),
    dsmlClose('invoke'),
    dsmlClose('calls'),
  ].join('\n');
  const calls = parseTextToolCalls(xml);
  assert.equal(calls.length, 2, '两个 invoke 都要认出来');
  assert.equal(calls[0].name, 'qq_describe_image');
  assert.deepEqual(JSON.parse(calls[0].arguments), { messageId: '最近一条' });
  assert.equal(calls[1].name, 'qq_get_recent_messages');
  assert.deepEqual(JSON.parse(calls[1].arguments), { limit: 15 }, '参数该转成数字就转');
  assert.equal(stripTextToolCalls(xml), '', '整段标记要抹得一个字符不剩');
});

test('stripTextToolCalls：正文被截断、闭合标签缺了也不能把标记漏出去', () => {
  const xml = [
    dsmlOpen('calls'),
    dsmlOpen('invoke name="qq_get_recent_messages"'),
    dsmlOpen('parameter name="limit"') + '15',
  ].join('\n');
  const out = stripTextToolCalls(xml);
  assert.equal(out, '', '残留要从第一个标记起整段丢掉（宁可少说半句）');
  assert.ok(!out.includes(DSML_BAR));
});

test('stripTextToolCalls：普通句子一个字都不动（含 <3 这种）', () => {
  const normal = '今天群里挺热闹的，你们吃饭了吗？<3 这个不是标签';
  assert.equal(stripTextToolCalls(normal), normal);
  assert.deepEqual(parseTextToolCalls(normal), []);
});