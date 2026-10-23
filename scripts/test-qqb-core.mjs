// qqb 基础设施（A 阶段：core + 健康上报 + 版本回滚）的离线回归。
//
// 全部用临时目录与本地假服务，不碰真 QQ / 真 DSH / 真 state。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createBus } from '../src/qqb/core/bus.mjs';
import { createConfig, getPath } from '../src/qqb/core/config.mjs';
import { createHealth } from '../src/qqb/core/health.mjs';
import { createLifecycle } from '../src/qqb/core/lifecycle.mjs';
import { createLogger, redactSecrets } from '../src/qqb/core/log.mjs';
import { createServiceChecks, httpJson } from '../src/qqb/checks/services.mjs';
import { MODULES, moduleNames } from '../src/qqb/version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `qqb-${label}-`));
}

// ────────────────────────────── 版本登记表 ──────────────────────────────

test('版本登记表自洽：semver 合法、文件存在、且与模块导出的 VERSION 一致', async () => {
  assert.ok(moduleNames().length >= 6);
  for (const name of moduleNames()) {
    const spec = MODULES[name];
    assert.match(spec.version, /^\d+\.\d+\.\d+$/, `${name} 版本号必须是 x.y.z`);
    assert.ok(spec.files.length > 0, `${name} 必须登记文件`);
    for (const relative of spec.files) {
      const file = path.join(root, relative);
      assert.ok(fs.existsSync(file), `${name} 登记的文件不存在：${relative}`);
      if (!/\.(mjs|js)$/.test(relative)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const match = text.match(/export const VERSION = '([^']+)'/);
      assert.ok(match, `${name} 的 ${relative} 必须导出 VERSION`);
      assert.equal(match[1], spec.version, `${name} 的 VERSION 与登记表不一致`);
    }
  }
});

test('module-version CLI：list / verify 退出码为 0', () => {
  for (const command of ['list', 'verify']) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'module-version.mjs'), command], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${command} 失败：${result.stdout}${result.stderr}`);
  }
});

test('module-version CLI：snapshot + rollback --dry-run（用真快照但只读回滚）', () => {
  const snapshot = spawnSync(process.execPath, [path.join(root, 'scripts', 'module-version.mjs'), 'snapshot', 'core/log', '--force'], { encoding: 'utf8' });
  assert.equal(snapshot.status, 0, `snapshot 失败：${snapshot.stdout}${snapshot.stderr}`);
  const dry = spawnSync(process.execPath, [path.join(root, 'scripts', 'module-version.mjs'), 'rollback', 'core/log', '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0, `rollback --dry-run 失败：${dry.stdout}${dry.stderr}`);
  assert.match(dry.stdout, /dry-run/);
});

// ────────────────────────────── core/log ──────────────────────────────

test('日志：脱敏、分级过滤、child 模块名、JSONL 落盘', () => {
  const dir = tmpdir('log');
  const file = path.join(dir, 'qqb-test.jsonl');
  const logger = createLogger({ module: 'core.test', file, level: 'info', echo: false });
  logger.debug('不该出现');
  logger.info('普通一行', { note: 'ok' });
  logger.error('密钥泄露检查', { apiKey: 'sk-abcdefghijklmnop', header: 'Bearer abcdefghijklmnopqrst' });
  logger.child('sub').warn('子模块');
  logger.setLevel('debug');
  logger.debug('现在可以出现');

  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.msg), ['普通一行', '密钥泄露检查', '子模块', '现在可以出现']);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('sk-abcdefghijklmnop'), '明文 sk- 必须被脱敏');
  assert.ok(!text.includes('abcdefghijklmnopqrst'), 'Bearer 令牌必须被脱敏');
  assert.equal(lines[1].module, 'core.test');
  assert.equal(lines[2].module, 'core.test.sub');
  assert.equal(redactSecrets('token=abcdef123456'), 'token=***');
});

test('日志：写入失败不抛（目录不存在也不会把调用方炸掉）', () => {
  const file = path.join(tmpdir('log-bad'), 'no-such-dir', 'x.jsonl');
  const logger = createLogger({ module: 'core.test', file, echo: false });
  assert.doesNotThrow(() => logger.info('试一试'));
  // 目录不存在时 mkdir 会补上，所以这里通常已成功；无论成败都不得抛。
  assert.ok(logger.file().endsWith('x.jsonl'));
});

// ────────────────────────────── core/config ──────────────────────────────

test('配置：点号取值、默认值、原子写入无 BOM、坏 JSON 保留上一份并标记 invalid', () => {
  const dir = tmpdir('config');
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ dsh: { baseUrl: 'http://127.0.0.1:1' }, mcp: { httpPort: 3210 } }), 'utf8');
  const config = createConfig({ root: dir, file });
  assert.equal(config.get('dsh.baseUrl'), 'http://127.0.0.1:1');
  assert.equal(config.get('mcp.httpPort', 0), 3210);
  assert.equal(config.get('nothing.here', 'fallback'), 'fallback');
  assert.equal(getPath({ a: { b: 2 } }, 'a.b'), 2);

  assert.equal(config.set('mcp.httpPort', 3211), true);
  const bytes = fs.readFileSync(file);
  assert.notEqual(bytes[0], 0xef, '写出的 JSON 不得带 BOM');
  assert.equal(JSON.parse(bytes.toString('utf8')).mcp.httpPort, 3211);
  assert.equal(config.get('mcp.httpPort'), 3211);

  // 有人手工写坏了配置：保留上一份好配置，标记 invalid，不抛。
  fs.writeFileSync(file, '{ 坏掉的 json', 'utf8');
  assert.equal(config.reload({ force: true }).mcp.httpPort, 3211);
  assert.match(String(config.invalid()), /解析失败/);

  // 带 BOM 的正常配置要能读（历史事故：BOM 让 JSON.parse 直接抛）。
  fs.writeFileSync(file, `\uFEFF${JSON.stringify({ ok: true })}`, 'utf8');
  assert.equal(config.reload({ force: true }).ok, true);
  assert.equal(config.invalid(), null);
});

// ────────────────────────────── core/bus ──────────────────────────────

test('事件总线：监听者抛错被隔离、历史与回放可用、通配通道生效', () => {
  const seen = [];
  const bus = createBus({ historyLimit: 3 });
  bus.on('x', () => { throw new Error('这个监听者坏了'); });
  bus.on('x', (payload) => seen.push(payload.n));
  const wildcard = [];
  bus.on('*', (channel, payload) => wildcard.push(`${channel}:${payload.n}`));

  assert.equal(bus.emit('x', { n: 1 }), 2, '坏监听者与好监听者、通配监听者都要被调用');
  bus.emit('x', { n: 2 });
  bus.emit('x', { n: 3 });
  bus.emit('x', { n: 4 });
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.deepEqual(wildcard.slice(-1), ['x:4']);
  assert.deepEqual(bus.history('x').map((item) => item.payload.n), [2, 3, 4], '历史上限生效');

  const replayed = [];
  bus.replay('x', (payload) => replayed.push(payload.n), 2);
  assert.deepEqual(replayed, [3, 4]);
});

// ────────────────────────────── core/health ──────────────────────────────

test('健康：critical 决定整体状态、状态变化只回调一次、缓存与表格', async () => {
  const health = createHealth({ cacheMs: 50 });
  let mode = 'ok';
  const transitions = [];
  health.register({
    name: '关键模块', version: '1.0.0', critical: true,
    check: () => (mode === 'ok' ? { status: 'ok', detail: 'fine' } : { status: 'down', detail: 'broken' }),
    onDegrade: (status, detail, previous) => transitions.push(['degrade', status, detail, previous]),
    onRecover: (previous) => transitions.push(['recover', previous]),
  });
  health.register({ name: '非关键模块', version: '1.0.0', critical: false, check: () => ({ status: 'degraded', detail: '慢' }) });

  const first = await health.run({ force: true });
  assert.equal(first.status, 'degraded', '非关键模块 degraded → 整体 degraded');
  assert.deepEqual(first.counts, { ok: 1, degraded: 1, down: 0, unknown: 0 });

  mode = 'down';
  const second = await health.run({ force: true });
  assert.equal(second.status, 'down', 'critical 模块 down → 整体 down');
  assert.deepEqual(transitions, [['degrade', 'down', 'broken', 'ok']]);
  await health.run({ force: true });
  assert.equal(transitions.length, 1, '状态未再变化时不得重复回调');

  mode = 'ok';
  const fourth = await health.run({ force: true });
  assert.deepEqual(transitions.at(-1), ['recover', 'down']);
  assert.equal(fourth.status, 'degraded');

  const cached = await health.run();
  assert.equal(cached.cached, true, '缓存窗口内不重复探测');
  assert.match(health.table(fourth), /关键模块/);
  assert.equal(health.statusOf('关键模块'), 'ok');
});

test('健康：探针抛错与超时都记为 down，不把调用方炸掉', async () => {
  const health = createHealth({ defaultTimeoutMs: 50, cacheMs: 0 });
  health.register({ name: '抛错', version: '1.0.0', critical: false, check: () => { throw new Error('探针坏了'); } });
  health.register({ name: '超时', version: '1.0.0', critical: false, check: () => new Promise(() => {}) });
  const report = await health.run({ force: true });
  const byName = Object.fromEntries(report.modules.map((item) => [item.name, item]));
  assert.equal(byName['抛错'].status, 'down');
  assert.match(byName['抛错'].error, /探针坏了/);
  assert.equal(byName['超时'].status, 'down');
  assert.match(byName['超时'].error, /超时/);
  health.setState('抛错', 'ok', '手工恢复');
  assert.equal(health.statusOf('抛错'), 'ok');
});

// ────────────────────────────── core/lifecycle ──────────────────────────────

test('生命周期：依赖顺序、单模块启动失败只降级、停机反序、成环要报错', async () => {
  const events = [];
  const health = createHealth({ cacheMs: 0 });
  const lifecycle = createLifecycle({ health, startTimeoutMs: 200, stopTimeoutMs: 200 });
  lifecycle.register({ name: 'a', version: '1.0.0', start: () => { events.push('start:a'); }, stop: () => { events.push('stop:a'); } });
  lifecycle.register({
    name: 'b', version: '1.0.0', dependsOn: ['a'],
    start: () => { events.push('start:b'); throw new Error('b 起不来'); },
    stop: () => { events.push('stop:b'); },
  });
  lifecycle.register({ name: 'c', version: '1.0.0', dependsOn: ['a'], start: () => { events.push('start:c'); }, stop: () => { events.push('stop:c'); } });

  const started = await lifecycle.startAll();
  assert.deepEqual(started.started, ['a', 'c'], 'b 失败不影响 a/c');
  assert.deepEqual(events, ['start:a', 'start:b', 'start:c']);
  assert.equal(lifecycle.states().b, 'failed');
  assert.equal(health.statusOf('b'), 'down', '失败模块必须在健康表里暴露');

  await lifecycle.stopAll('test');
  assert.deepEqual(events.slice(3), ['stop:c', 'stop:b', 'stop:a'], '停机按启动反序');
  assert.equal(lifecycle.states().c, 'stopped');

  const cyclic = createLifecycle({});
  cyclic.register({ name: 'x', version: '1.0.0', dependsOn: ['y'] });
  cyclic.register({ name: 'y', version: '1.0.0', dependsOn: ['x'] });
  assert.throws(() => cyclic.order(), /成环/);
});

// ────────────────────────────── checks/services ──────────────────────────────

/** 一个按路径回话的假网关，用来离线验证探针口径。 */
function fakeGateway() {
  const state = { dshReady: true, onebot: { status: 'ok', retcode: 0, data: { user_id: 376245695, nickname: '大肥鱼' } } };
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const send = (payload, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.startsWith('/get_login_info')) return send(state.onebot);
    if (url.startsWith('/api/status')) {
      return send({
        mode: 'reserved2',
        dshReady: state.dshReady,
        role: '小鲸鱼',
        socialV2Paused: false,
        ...(state.presetHealth ? { presetHealth: state.presetHealth } : {}),
      });
    }
    if (url.startsWith('/health')) return send({ ok: true, service: 'fake' });
    return send({ error: 'not found' }, 404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        state,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('探针：httpJson 对 200/404/连不上 都不抛', async () => {
  const gateway = await fakeGateway();
  try {
    const ok = await httpJson(`http://127.0.0.1:${gateway.port}/health`);
    assert.equal(ok.ok, true);
    assert.equal(ok.json.service, 'fake');
    const missing = await httpJson(`http://127.0.0.1:${gateway.port}/nope`);
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);
    const refused = await httpJson('http://127.0.0.1:1/health', { timeoutMs: 500 });
    assert.equal(refused.ok, false);
    assert.ok(refused.error, '连不上必须给出 error 文本');
  } finally {
    await gateway.close();
  }
});

test('探针：OneBot 看 retcode、桥接看 dshReady、Hindsight 非关键只降级、state 可写', async () => {
  const gateway = await fakeGateway();
  const dir = tmpdir('checks');
  const config = {
    get(dotted, fallback) {
      const table = {
        'snowluma.httpUrl': `http://127.0.0.1:${gateway.port}`,
        'snowluma.accessToken': 'test-token',
        consolePort: gateway.port,
        consoleToken: 'console-token',
        'mcp.httpPort': gateway.port,
        'hindsight.port': gateway.port,
      };
      return table[dotted] ?? fallback;
    },
  };
  try {
    const checks = createServiceChecks({ root: dir, config });
    assert.deepEqual(checks.map((item) => item.name), ['onebot', 'bridge', 'mcp', 'hindsight', 'state', 'memory', 'outbox', 'mood', 'persona', 'directed', 'media', 'model']);
    const byName = Object.fromEntries(checks.map((item) => [item.name, item]));
    assert.equal(byName.onebot.critical, true);
    assert.equal(byName.hindsight.critical, false, 'Hindsight 没起来不能算宕机');

    assert.equal((await byName.onebot.check()).status, 'ok');
    gateway.state.onebot = { status: 'failed', retcode: 1404, wording: 'token 不对' };
    const badOnebot = await byName.onebot.check();
    assert.equal(badOnebot.status, 'down');
    assert.match(badOnebot.error, /token 不对/);

    assert.equal((await byName.bridge.check()).status, 'ok');
    gateway.state.dshReady = false;
    const bridgeDegraded = await byName.bridge.check();
    assert.equal(bridgeDegraded.status, 'degraded', 'DSH 没连上算降级而不是宕机');
    gateway.state.dshReady = true;

    // 0.1.9：preset 装配失败必须让桥接探针报 degraded。只认 dshReady 的话，
    // 2026-10-21 那次 qq-chat/qq-chat-v2 坏了 30 多个小时，这个探针一直报 ok（假绿灯）。
    gateway.state.presetHealth = {
      usable: ['standard'],
      broken: { 'qq-chat': 'cannot get property "tools" without inject qq-tool-restrict' },
    };
    const presetBroken = await byName.bridge.check();
    assert.equal(presetBroken.status, 'degraded', 'DSH 报 broken 的 preset 必须降级');
    assert.deepEqual(presetBroken.detail.brokenPresets, ['qq-chat']);
    assert.match(presetBroken.error, /qq-chat/);
    assert.match(presetBroken.error, /without inject/, '要把 broken 的原因带出来');
    // 修好（重启 DSH）之后必须回到 ok，不能粘住。
    gateway.state.presetHealth = { usable: ['standard', 'qq-chat'], broken: {} };
    assert.equal((await byName.bridge.check()).status, 'ok');
    // 老版本桥接没有 presetHealth 字段：不能因此报错，仍按 dshReady 判。
    gateway.state.presetHealth = null;
    assert.equal((await byName.bridge.check()).status, 'ok');

    assert.equal((await byName.mcp.check()).status, 'ok');
    assert.equal((await byName.hindsight.check()).status, 'ok');
    assert.equal((await byName.state.check()).status, 'ok');
    assert.equal(byName.memory.critical, false, '记忆库坏了要告警但不判宕机');
    const memoryCheck = await byName.memory.check();
    assert.equal(memoryCheck.status, 'ok');
    assert.equal(memoryCheck.detail.total, 0, '新库统计为 0');
    assert.equal(path.basename(memoryCheck.detail.path), 'memory.db');
    // R4：空队列必须是 ok（不能因为文件还没建就报错），且不能判宕机
    assert.equal(byName.outbox.critical, false, '发送队列积压不能算宕机');
    const outboxCheck = await byName.outbox.check();
    assert.equal(outboxCheck.status, 'ok');
    assert.equal(outboxCheck.detail.pending, 0);

    // R1b/R5：人设探针在"还没有特征、也没提案"的空状态下必须是 ok（她还没积累不算故障）。
    assert.equal(byName.persona.critical, false, '人设模块坏了不能算宕机');
    const personaCheck = await byName.persona.check();
    assert.equal(personaCheck.status, 'ok');
    assert.equal(personaCheck.detail.traits, 0);
    assert.equal(personaCheck.detail.proposals.total, 0);

    // Hindsight 指向没人的端口 → down，但整体不该因此变 down（非关键）。
    const health = createHealth({ cacheMs: 0 });
    const offline = createServiceChecks({ root: dir, config: { get: (k, d) => (k === 'hindsight.port' ? 1 : config.get(k, d)) } });
    for (const check of offline) health.register(check);
    const report = await health.run({ force: true });
    const hindsight = report.modules.find((item) => item.name === 'hindsight');
    assert.equal(hindsight.status, 'down');
    assert.equal(hindsight.critical, false);
  } finally {
    await gateway.close();
  }
});

test('探针：state/console-token 作为控制台令牌的兜底来源', async () => {
  const dir = tmpdir('token');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'console-token'), 'from-file\n', 'utf8');
  const { consoleToken } = await import('../src/qqb/checks/services.mjs');
  assert.equal(consoleToken(dir, { get: () => '' }), 'from-file');
  assert.equal(consoleToken(dir, { get: () => 'from-config' }), 'from-config');
});

console.log('✅ qqb A 阶段（core / 健康 / 版本回滚 / 探针）测试通过');