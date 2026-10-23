// DSH base URL 解析的离线回归（纯函数，不连 DSH）。
//
// 背景：DSH 桌面版端口是动态的（本机实测 61388），而一批探针/验证脚本历史写死
// `http://127.0.0.1:3080`。DSH 一换端口，这些脚本会连到空气并报 ECONNREFUSED，
// 看起来像“DSH 挂了”。统一解析入口后，这里钉住优先级，防止再次各自为政。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  resolveDshBaseUrl,
  parseNetstatListeners,
  parseTasklistPids,
  discoverDshWebUrls,
  findLiveDshBaseUrl,
  persistDshBaseUrl,
} from '../src/dsh-client.js';

function fixtureWithConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-base-url-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config), 'utf8');
  return dir;
}

test('显式参数优先，并去掉尾部斜杠', () => {
  const root = fixtureWithConfig({ dsh: { baseUrl: 'http://127.0.0.1:1111' } });
  assert.equal(resolveDshBaseUrl('http://127.0.0.1:2222/', { root, env: {} }), 'http://127.0.0.1:2222');
});

test('环境变量优先级：DSH_BASE_URL > DSH_WEB_URL > config.json', () => {
  const root = fixtureWithConfig({ dsh: { baseUrl: 'http://127.0.0.1:3333' } });
  assert.equal(
    resolveDshBaseUrl(undefined, { root, env: { DSH_BASE_URL: 'http://127.0.0.1:4444', DSH_WEB_URL: 'http://127.0.0.1:5555' } }),
    'http://127.0.0.1:4444',
  );
  assert.equal(
    resolveDshBaseUrl(undefined, { root, env: { DSH_WEB_URL: 'http://127.0.0.1:5555' } }),
    'http://127.0.0.1:5555',
  );
  assert.equal(
    resolveDshBaseUrl(undefined, { root, env: { DSH_WEB_URL: 'not-a-url' } }),
    'http://127.0.0.1:3333',
  );
});

test('没有环境变量时读仓库 config.json 的 dsh.baseUrl', () => {
  const root = fixtureWithConfig({ dsh: { baseUrl: 'http://127.0.0.1:61388' } });
  assert.equal(resolveDshBaseUrl(undefined, { root, env: {} }), 'http://127.0.0.1:61388');
});

test('什么都没配置时回退历史默认值，不抛错', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-base-url-empty-'));
  assert.equal(resolveDshBaseUrl(undefined, { root, env: {} }), 'http://127.0.0.1:3080');
  // config.json 损坏同样回退，而不是把 JSON 错误抛给启动流程。
  fs.writeFileSync(path.join(root, 'config.json'), '{ broken', 'utf8');
  assert.equal(resolveDshBaseUrl(undefined, { root, env: {} }), 'http://127.0.0.1:3080');
});

test('非法显式参数被忽略，不会覆盖环境变量/config', () => {
  const root = fixtureWithConfig({ dsh: { baseUrl: 'http://127.0.0.1:3333' } });
  assert.equal(resolveDshBaseUrl('file:///etc/passwd', { root, env: {} }), 'http://127.0.0.1:3333');
});

// ── 端点自愈：发现当前活着的那个 DSH 端口 ──────────────────────────────────────
// 桌面版 DSH 每次重启都换端口（实测 61388 → 51673 → 63342），而 config.json 是静态值。
// 下面钉住的是“从系统里把端口找出来”的纯解析部分，全程离线（子进程用注入的 run 替掉）。

const NETSTAT_SAMPLE = [
  '',
  '活动连接',
  '',
  '  协议  本地地址          外部地址        状态           PID',
  '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1184',
  '  TCP    127.0.0.1:3100         0.0.0.0:0              LISTENING       999',
  '  TCP    127.0.0.1:63342        0.0.0.0:0              LISTENING       324732',
  '  TCP    127.0.0.1:51673        0.0.0.0:0              TIME_WAIT       0',
  '  TCP    [::]:445               [::]:0                 LISTENING       4',
  '',
].join('\r\n');

test('parseNetstatListeners：只取 LISTENING，认得 IPv6 与本地端口', () => {
  const listeners = parseNetstatListeners(NETSTAT_SAMPLE);
  assert.deepEqual(listeners, [
    { port: 135, pid: 1184 },
    { port: 3100, pid: 999 },
    { port: 63342, pid: 324732 },
    { port: 445, pid: 4 },
  ]);
  // TIME_WAIT 那条（PID 0）不能被当成活着的监听。
  assert.ok(!listeners.some((x) => x.port === 51673));
  assert.deepEqual(parseNetstatListeners(''), []);
  assert.deepEqual(parseNetstatListeners(undefined), []);
});

test('parseTasklistPids：取 CSV 第 2 列，坏行跳过', () => {
  const out = [
    '信息: 没有运行的任务匹配指定标准。',
    '"DeepSeek Harness.exe","324732","Console","1","345,678 K"',
    '"DeepSeek Harness.exe","314056","Console","1","120,000 K"',
    'not-csv-line',
  ].join('\r\n');
  assert.deepEqual(parseTasklistPids(out), [324732, 314056]);
  assert.deepEqual(parseTasklistPids(''), []);
});

test('discoverDshWebUrls：挑出宿主进程监听的端口，并排除桥接自己的端口', () => {
  const run = (cmd) => {
    if (cmd === 'tasklist') return '"DeepSeek Harness.exe","324732","Console","1","345,678 K"\r\n';
    if (cmd === 'netstat') return NETSTAT_SAMPLE;
    return '';
  };
  assert.deepEqual(discoverDshWebUrls({ platform: 'win32', env: {}, run }), ['http://127.0.0.1:63342']);
  // 135/445 是别人（PID 1184/4）的端口，3100 是桥接自己的控制台端口。
  assert.deepEqual(
    discoverDshWebUrls({ platform: 'win32', env: {}, run, exclude: [63342] }),
    [],
  );
  // tasklist 报错（进程名没有匹配）时不能抛，只能返回空。
  assert.deepEqual(
    discoverDshWebUrls({ platform: 'win32', env: {}, run: (cmd) => { if (cmd === 'tasklist') throw new Error('boom'); return NETSTAT_SAMPLE; } }),
    [],
  );
});

test('discoverDshWebUrls：环境变量优先，重复端口去重', () => {
  const run = (cmd) => (cmd === 'tasklist'
    ? '"DeepSeek Harness.exe","324732","Console","1","1 K"\r\n'
    : NETSTAT_SAMPLE);
  assert.deepEqual(
    discoverDshWebUrls({
      platform: 'win32',
      run,
      env: { DSH_WEB_URL: 'http://127.0.0.1:7001/', DSH_BASE_URL: 'http://127.0.0.1:63342' },
    }),
    ['http://127.0.0.1:7001', 'http://127.0.0.1:63342'],
  );
});

test('findLiveDshBaseUrl：跳过当前地址，挑第一个真的能应答的候选', async () => {
  const candidates = ['http://127.0.0.1:63342', 'http://127.0.0.1:51673'];
  const probed = [];
  const probe = async (url) => { probed.push(url); return url.endsWith(':51673'); };
  assert.equal(
    await findLiveDshBaseUrl({ candidates, current: 'http://127.0.0.1:63342', probe }),
    'http://127.0.0.1:51673',
  );
  // current 不重复探；探针抛错只当这个候选不行，不中断发现。
  assert.deepEqual(probed, ['http://127.0.0.1:51673']);
  assert.equal(await findLiveDshBaseUrl({ candidates, current: '', probe: () => { throw new Error('boom'); } }), null);
  assert.equal(await findLiveDshBaseUrl({ candidates, current: '', probe: undefined }), null);
});

test('persistDshBaseUrl：只改 dsh.baseUrl，幂等，且保留 BOM', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-persist-'));
  const cfgPath = path.join(dir, 'config.json');
  const original = { dsh: { baseUrl: 'http://127.0.0.1:51673', provider: 'deepseek-official' }, consolePort: 3100 };
  fs.writeFileSync(cfgPath, `\uFEFF${JSON.stringify(original, null, 2)}\n`, 'utf8');

  const first = persistDshBaseUrl(cfgPath, 'http://127.0.0.1:63342');
  assert.equal(first.updated, true);
  assert.deepEqual(first.changed, { baseUrl: { from: 'http://127.0.0.1:51673', to: 'http://127.0.0.1:63342' } });

  const raw = fs.readFileSync(cfgPath, 'utf8');
  assert.equal(raw.charCodeAt(0), 0xFEFF, 'BOM 必须原样保留');
  const written = JSON.parse(raw.slice(1));
  assert.equal(written.dsh.baseUrl, 'http://127.0.0.1:63342');
  assert.equal(written.dsh.provider, 'deepseek-official', '其它配置一个都不能动');
  assert.equal(written.consolePort, 3100);

  // 已经是指定值：不写文件、报告未变更。
  const before = fs.readFileSync(cfgPath, 'utf8');
  const second = persistDshBaseUrl(cfgPath, 'http://127.0.0.1:63342');
  assert.equal(second.updated, false);
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), before);

  // 非法地址直接忽略，绝不清空用户的配置。
  assert.equal(persistDshBaseUrl(cfgPath, 'file:///etc/passwd').updated, false);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8').slice(1)).dsh.baseUrl, 'http://127.0.0.1:63342');
});
