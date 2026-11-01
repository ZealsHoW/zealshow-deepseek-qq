// 真机验证自带表情：以她的身份（agent token）发一张 goodnight-whale。
// 用法：node _live-sticker.mjs <stickerRef> [key]
import fs from 'node:fs';

const stickerId = process.argv[2] ?? 'goodnight-whale';
const key = process.argv[3] ?? 'private:3482501440';
const consoleToken = fs.readFileSync('state/console-token', 'utf8').trim();
const conv = JSON.parse(fs.readFileSync('state/social-v2.json', 'utf8')).conversations[key];
const agentToken = conv?.agentToken;
if (!agentToken) throw new Error(`${key} 没有 agentToken`);

// 先看她的表情清单里有没有这张（qq_list_stickers 的返回）
const listRes = await fetch(`http://127.0.0.1:3100/api/socialV2/sticker-list?key=${encodeURIComponent(key)}&count=5`, {
  headers: { 'x-console-token': consoleToken, 'x-agent-token': agentToken, 'x-agent-call': '1' }
});
const list = await listRes.json();
const items = list?.stickers?.items ?? list?.items ?? [];
console.log('list ok=', list?.ok, 'items=', items.length);
for (const it of items.slice(0, 3)) console.log('  ', it.id, '|', it.desc || it.localNote || '', '|', it.source);

const res = await fetch('http://127.0.0.1:3100/api/socialV2/send-sticker', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-console-token': consoleToken,
    'x-agent-token': agentToken,
    'x-agent-call': '1'
  },
  body: JSON.stringify({ key, stickerId })
});
const body = await res.json();
console.log('send', res.status, JSON.stringify(body).slice(0, 400));