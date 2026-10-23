/**
 * qqb · 模型客户端测试（R6/F）
 *
 * 不碰真模型、不花 token：所有用例打在一个本地假 /chat/completions 上。
 * 覆盖：配置解析与密钥来源、未启用/无密钥时**不发请求**、正常返回、工具调用解析、
 * 5xx 重试、4xx 不重试、重试次数用尽、主动取消、密钥脱敏、统计与重置。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createModelClient, modelConfigOf, resolveModelKey, createKeyResolver, readCredentialsRefs, redact, DEFAULT_BASE_URL, DEFAULT_MODEL, VERSION } from '../src/qqb/model/client.mjs';

/**
 * 假模型服务：按脚本回放响应；记录每次请求的方法/路径/头/体。
 * 注意 close() 要先 closeAllConnections —— 否则 keep-alive 连接会把事件循环吊住（R4 时踩过）。
 */
async function fakeModel(script = []) {
  const calls = [];
  const queue = [...script];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const next = queue.length ? queue.shift() : { status: 200, json: { choices: [{ message: { content: '默认回答' } }] } };
      if (next.delayMs) {
        setTimeout(() => respond(next), next.delayMs);
        return;
      }
      respond(next);
      function respond(item) {
        res.setHeader('connection', 'close');
        if (item.status >= 400) {
          res.writeHead(item.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(item.json ?? { error: { message: 'boom' } }));
          return;
        }
        res.writeHead(item.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(item.json ?? {}));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    calls,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const OK_JSON = {
  model: 'deepseek-v4.1-flash',
  choices: [{ message: { content: '在的，我在。' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
};

function cfg(overrides = {}) {
  return { model: { enabled: true, baseUrl: '', model: 'test-model', apiKey: 'sk-test-1234567890', ...overrides } };
}

test('版本与默认值自洽', () => {
  assert.equal(VERSION, '0.1.1');
  assert.match(DEFAULT_BASE_URL, /^https:\/\//);
  assert.ok(DEFAULT_MODEL.length > 3);
  const parsed = modelConfigOf({}, {});
  assert.equal(parsed.enabled, false, '默认必须是关闭的，装了模块不等于切主链路');
  assert.equal(parsed.apiKey, '', '不传 resolver 时不读本机凭据文件（纯函数）');
  assert.equal(parsed.maxRetries, 2);
});

test('密钥来源：config 优先，其次环境变量（并记录来源）', () => {
  const fromConfig = modelConfigOf({ model: { apiKey: 'sk-config' } }, { BAILIAN_API_KEY: 'sk-env' });
  assert.equal(fromConfig.apiKey, 'sk-config');
  assert.equal(fromConfig.keyFrom, 'config.model.apiKey');

  const fromEnv = modelConfigOf({ model: { apiKeyEnv: ['BAILIAN_API_KEY', 'DEEPSEEK_API_KEY'] } }, { DEEPSEEK_API_KEY: 'sk-deep' });
  assert.equal(fromEnv.apiKey, 'sk-deep');
  assert.equal(fromEnv.keyFrom, 'env.DEEPSEEK_API_KEY');

  const none = modelConfigOf({}, {});
  assert.equal(none.keyConfigured, false);
});

test('未启用 / 没有密钥时：直接返回失败，且一个请求都不发', async () => {
  const fake = await fakeModel();
  try {
    const disabled = createModelClient({ config: { model: { enabled: false, baseUrl: fake.base, apiKey: 'sk-x' } }, env: {}, fetchImpl: fetch });
    const a = await disabled.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(a.ok, false);
    assert.match(a.error, /未启用/);

    const noKey = createModelClient({
      config: { model: { enabled: true, baseUrl: fake.base, apiKey: '' } },
      env: {},
      fetchImpl: fetch,
      resolver: { file: '(不给)', resolve: () => ({ apiKey: '', keyFrom: '' }) }, // 别让本机凭据文件影响这条
    });
    const b = await noKey.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(b.ok, false);
    assert.match(b.error, /key/);

    assert.equal(fake.calls.length, 0, '这两种情况都不该真的打接口');
  } finally {
    await fake.close();
  }
});

test('正常返回：请求体与鉴权头正确，文本/用量/耗时回填', async () => {
  const fake = await fakeModel([{ status: 200, json: OK_JSON }]);
  try {
    const client = createModelClient({ config: cfg({ baseUrl: fake.base, temperature: 0.3 }), env: {}, fetchImpl: fetch });
    const out = await client.complete({ messages: [{ role: 'user', content: '你在吗' }], purpose: 'wake' });
    assert.equal(out.ok, true);
    assert.equal(out.text, '在的，我在。');
    assert.equal(out.usage.total_tokens, 17);
    assert.equal(out.attempts, 1);
    assert.equal(out.purpose, 'wake');
    assert.ok(out.latencyMs >= 0);

    const call = fake.calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, '/chat/completions');
    assert.equal(call.headers.authorization, 'Bearer sk-test-1234567890');
    assert.equal(call.body.model, 'test-model');
    assert.equal(call.body.temperature, 0.3);
    assert.deepEqual(call.body.messages, [{ role: 'user', content: '你在吗' }]);
    assert.equal(client.stats().ok, 1);
  } finally {
    await fake.close();
  }
});

test('工具调用：解析成 {id,name,arguments} 并计入统计', async () => {
  const fake = await fakeModel([{
    status: 200,
    json: {
      choices: [{
        message: {
          content: '',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'qq_send_message', arguments: '{"key":"group:1","messages":"在"}' } }],
        },
        finish_reason: 'tool_calls',
      }],
    },
  }]);
  try {
    const client = createModelClient({ config: cfg({ baseUrl: fake.base }), env: {}, fetchImpl: fetch });
    const out = await client.complete({ messages: [{ role: 'user', content: '发个消息' }], tools: [{ type: 'function', function: { name: 'qq_send_message' } }] });
    assert.equal(out.ok, true);
    assert.equal(out.finishReason, 'tool_calls');
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0].name, 'qq_send_message');
    assert.equal(JSON.parse(out.toolCalls[0].arguments).key, 'group:1');
    assert.deepEqual(fake.calls[0].body.tools[0].function.name, 'qq_send_message');
    assert.equal(client.stats().toolCalls, 1);
  } finally {
    await fake.close();
  }
});

test('5xx 会重试到成功；4xx 不重试', async () => {
  const fake = await fakeModel([
    { status: 500, json: { error: { message: 'upstream down' } } },
    { status: 503, json: { error: { message: 'busy' } } },
    { status: 200, json: OK_JSON },
    { status: 400, json: { error: { message: 'bad request' } } },
  ]);
  try {
    const client = createModelClient({ config: cfg({ baseUrl: fake.base, maxRetries: 2, timeoutMs: 3000 }), env: {}, fetchImpl: fetch, logger: { warn: () => {} } });
    const ok = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(ok.ok, true);
    assert.equal(ok.attempts, 3, '两次失败后第三次成功');
    assert.equal(client.stats().retries, 2);

    const bad = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /400/);
    assert.equal(fake.calls.length, 4, '400 不该再重试');
  } finally {
    await fake.close();
  }
});

test('一直失败：重试次数用尽后给出最后一条错误', async () => {
  const fake = await fakeModel([
    { status: 500, json: { error: { message: 'down-1' } } },
    { status: 500, json: { error: { message: 'down-2' } } },
  ]);
  try {
    const client = createModelClient({ config: cfg({ baseUrl: fake.base, maxRetries: 1, timeoutMs: 3000 }), env: {}, fetchImpl: fetch, logger: { warn: () => {} } });
    const out = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.ok, false);
    assert.match(out.error, /down-2/);
    assert.equal(out.attempts, 2);
    assert.equal(client.stats().failures, 1);
    assert.match(client.stats().lastError, /500/);
  } finally {
    await fake.close();
  }
});

test('主动取消：不重试，立刻返回失败', async () => {
  const fake = await fakeModel([{ status: 200, json: OK_JSON, delayMs: 2000 }]);
  try {
    const client = createModelClient({ config: cfg({ baseUrl: fake.base, maxRetries: 3, timeoutMs: 3000 }), env: {}, fetchImpl: fetch, logger: { warn: () => {} } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const out = await client.complete({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal });
    assert.equal(out.ok, false);
    assert.match(out.error, /连接模型接口失败/);
    assert.equal(fake.calls.length, 1, '取消后不该重试');
  } finally {
    await fake.close();
  }
});

test('密钥脱敏与统计重置', () => {
  const masked = redact('调用失败 sk-abcdef1234567890 —— 请检查');
  assert.ok(!masked.includes('sk-abcdef1234567890'));
  assert.match(masked, /sk-abcdef…/);

  // 百炼的 key 是 sk-ws- 开头的带点串，老正则（只认 [A-Za-z0-9_-]）漏了它。
  const maskedWs = redact('Authorization: Bearer sk-ws-H.PXIXXXY.9JRw.MEYCIQCMOsQQgb9IY');
  assert.ok(!maskedWs.includes('MEYCIQCMOsQQgb9IY'), 'sk-ws- 形式的 key 也必须打码');

  const client = createModelClient({ config: cfg({ apiKey: 'sk-abcdef1234567890' }), env: {} });
  assert.match(client.config().apiKey, /^sk-abc…$/);
  assert.ok(!JSON.stringify(client.config()).includes('1234567890'));
  client.reset();
  assert.equal(client.stats().calls, 0);
});

test('凭据文件：只认 refs 段，名字→值', () => {
  const text = [
    'version: 1',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-deep-aaaaaaaa',
    '  BAILIAN_API_KEY: sk-ws-bbbbbbbb',
    'records:',
    '  deepseek-account-platform/default:',
    '    kind: grant',
    '    payload:',
    '      token: should-not-be-read',
    '',
  ].join('\n');
  const read = () => text;
  const refs = readCredentialsRefs('/nowhere/.credentials.yaml', read);
  assert.deepEqual(Object.keys(refs).sort(), ['BAILIAN_API_KEY', 'DEEPSEEK_API_KEY']);
  assert.equal(refs.DEEPSEEK_API_KEY, 'sk-deep-aaaaaaaa');
  assert.equal('token' in refs, false, 'records 段里的东西不该被当成 refs 读出来');

  assert.deepEqual(readCredentialsRefs('/nowhere/.credentials.yaml', () => { throw new Error('ENOENT'); }), {}, '读不到就是空表，不抛');
  assert.deepEqual(readCredentialsRefs('/nowhere/.credentials.yaml', () => 'nothing here'), {});
});

test('密钥顺序：config → env → 凭据文件；来源可查', () => {
  const text = ['refs:', '  BAILIAN_API_KEY: sk-from-file', ''].join('\n');
  const resolver = createKeyResolver({ file: '/cred/.yaml', readFileSync: () => text, statSync: () => ({ mtimeMs: 1 }) });

  const fromFile = modelConfigOf({ model: {} }, {}, { resolver });
  assert.equal(fromFile.apiKey, 'sk-from-file');
  assert.equal(fromFile.keyFrom, 'credentials.BAILIAN_API_KEY');
  assert.equal(fromFile.keyConfigured, true);

  const fromEnv = modelConfigOf({ model: {} }, { BAILIAN_API_KEY: 'sk-from-env' }, { resolver });
  assert.equal(fromEnv.keyFrom, 'env.BAILIAN_API_KEY', '环境变量优先于凭据文件');

  const fromConfig = modelConfigOf({ model: { apiKey: 'sk-from-config' } }, { BAILIAN_API_KEY: 'sk-from-env' }, { resolver });
  assert.equal(fromConfig.keyFrom, 'config.model.apiKey', '显式配置优先于一切');

  const custom = modelConfigOf({ model: { apiKeyEnv: ['MY_KEY'] } }, {}, { resolver: { file: '/x', resolve: () => ({ apiKey: 'sk-x', keyFrom: 'credentials.MY_KEY' }) } });
  assert.equal(custom.keyFrom, 'credentials.MY_KEY');

  // 自定义文件路径（config.model.apiKeyFile）要传给 resolver
  let askedFor = '';
  const spy = { file: '/default', resolve: (names, file) => { askedFor = file; return { apiKey: '', keyFrom: '' }; } };
  resolveModelKey({ model: { apiKeyFile: '/custom/creds.yaml' } }, {}, { resolver: spy });
  assert.equal(askedFor, '/custom/creds.yaml');
});

test('凭据文件按 mtime 缓存：文件没变不重读，变了才重读', () => {
  let reads = 0;
  let mtime = 100;
  const text = () => `refs:\n  BAILIAN_API_KEY: sk-v${reads}\n`;
  const resolver = createKeyResolver({
    file: '/cred/.yaml',
    readFileSync: () => { reads += 1; return text(); },
    statSync: () => ({ mtimeMs: mtime }),
  });
  assert.equal(resolver.resolve(['BAILIAN_API_KEY']).apiKey, 'sk-v1');
  assert.equal(resolver.resolve(['BAILIAN_API_KEY']).apiKey, 'sk-v1');
  assert.equal(reads, 1, 'mtime 没变就不该重复读文件');
  mtime = 200;
  assert.equal(resolver.resolve(['BAILIAN_API_KEY']).apiKey, 'sk-v2');
  assert.equal(reads, 2);
  assert.equal(resolver.resolve(['NOT_THERE']).apiKey, '');
});

test('客户端默认会去读凭据文件（主链路要能自己拿到 key）', () => {
  const text = 'refs:\n  BAILIAN_API_KEY: sk-from-creds\n';
  const client = createModelClient({
    config: { model: { enabled: true, baseUrl: 'http://127.0.0.1:1/v1' } },
    env: {},
    resolver: createKeyResolver({ file: '/cred/.yaml', readFileSync: () => text, statSync: () => ({ mtimeMs: 1 }) }),
  });
  assert.equal(client.ready(), true);
  assert.equal(client.config().keyFrom, 'credentials.BAILIAN_API_KEY');
  assert.match(client.config().apiKey, /^sk-fro…$/, 'config() 也不回显完整 key');
});

test('兼容参数：config.model.extraBody 与单次 extra 都会带上去，但顶不掉 model/messages', async () => {
  const fake = await fakeModel([{ status: 200, json: OK_JSON }]);
  try {
    const client = createModelClient({
      config: cfg({ baseUrl: fake.base, extraBody: { enable_thinking: false, model: '被顶掉的模型' } }),
      env: {},
      fetchImpl: fetch,
    });
    const out = await client.complete({ messages: [{ role: 'user', content: 'hi' }], purpose: 'extra' });
    assert.equal(out.ok, true);
    const body = fake.calls[0].body;
    assert.equal(body.enable_thinking, false, '配置里的兼容参数要原样带上');
    assert.equal(body.model, 'test-model', 'extraBody 不能顶掉 model');
    assert.equal(body.messages.length, 1, 'extraBody 不能顶掉 messages');

    const out2 = await client.complete({ messages: [{ role: 'user', content: 'hi' }], extra: { enable_thinking: true } });
    assert.equal(out2.ok, true);
    assert.equal(fake.calls[1].body.enable_thinking, true, '单次 extra 覆盖配置默认值');
  } finally {
    await fake.close();
  }
});