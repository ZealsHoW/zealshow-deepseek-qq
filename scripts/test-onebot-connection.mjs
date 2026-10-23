// 一次性连接测试：用 @snowluma/sdk 连接 SnowLuma 的 OneBot WebSocket 网关，
// 验证地址、端口、WS 令牌是否正确。成功即打印 ✅ 并退出。
//
// ⚠ 2026-10-23 修正：原来这里直接拿 config.json 的 `snowluma.accessToken` 去连 WS —— 那是
// **HTTP 令牌**，跟 WS 令牌不是同一个（桥接自己也要运行时才发现：`bot.accessToken = wsToken`，
// 见 src/bridge.js 的自愈段；per-account 文件里 http / ws 各记一份，端口也可能不同）。
// 用 HTTP 令牌连 WS 会被网关以 `1006 closed before opening` 拒掉 —— 症状是「这个脚本一直连不上，
// 但桥接一切正常」。现在改成和桥接同一条路：`discoverSnowLumaConnection()` 取 wsUrl + wsToken。
//
// 注意：网关是 per-account 的（HTTP/WS 两份令牌、端口也可能不同）。用发现到的 WS 令牌连，
// 桥接同时在跑也能连上（2026-10-23 实测）；连不上时先看 discoverSnowLumaConnection 的 tried 列表。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import { discoverSnowLumaConnection } from '../src/snowluma-conn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));

const found = await discoverSnowLumaConnection({ cfg, timeoutMs: 6000 });
const wsUrl = found.wsUrl || cfg.snowluma.wsUrl;
const wsToken = found.wsToken || cfg.snowluma.accessToken;
console.log(`测试连接 ${wsUrl}（WS 令牌 ${wsToken ? `${String(wsToken).slice(0, 4)}…` : '未发现'}；HTTP 令牌来源 ${found.source ?? '-'}）…`);

const bot = new SnowLumaWebSocketClient({
  url: wsUrl,
  accessToken: wsToken || undefined,
  reconnect: false
});

const result = await Promise.race([
  new Promise((resolve) => {
    bot.on('open', () => {
      console.log('✅ WebSocket 已连接（网关接受连接，token 正确）');
      resolve(true);
    });
    bot.on('event', (event) => {
      if (event.post_type === 'meta_event') {
        console.log('✅ 收到 meta 事件:', event.meta_event_type, JSON.stringify(event).slice(0, 160));
      } else {
        console.log('📨 收到事件:', event.post_type, event.message_type ?? '', JSON.stringify(event).slice(0, 160));
      }
    });
    bot.on('close', (info) => {
      if (info?.code === 4001 || info?.code === 401) {
        console.error('❌ 网关拒绝连接：鉴权失败（token 不对或未填）', info);
      } else {
        console.error('❌ 连接被关闭:', info);
      }
      resolve(false);
    });
  }),
  bot.connect().catch((error) => {
    console.error('❌ 连接异常:', error?.message ?? error);
    return false;
  }),
  new Promise((resolve) => setTimeout(() => {
    console.error('❌ 超时（10s）：地址/端口不对或网关未启动？');
    resolve(false);
  }, 10_000))
]);

try { bot.close(); } catch {}
process.exit(result ? 0 : 1);
