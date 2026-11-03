// 日期标签 + 称呼改投（2026-11-03 主人两件报障）
//
// ① 「她会记不清日期，总是将前几天的事记成今天」——提示词里的旧内容没有时间戳。
// ② 「给妈妈发『爸，妈说她想你了，你回她一句呗』」——发送只认当前会话，不看开头叫的是谁。
import fs from 'node:fs';
import { leadingAddressee, normQQ, routeByAddressee } from '../src/qqb/directed/addressee.mjs';
import { memoryWhenLabel } from '../src/qqb/memory/live.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); } else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}`);
}

const bridge = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const live = fs.readFileSync(new URL('../src/qqb/memory/live.mjs', import.meta.url), 'utf8');
const mcp = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');

const DAD = '3482501440';
const MOM = '3250968635';
const TABLE = [
  { qq: DAD, name: '爸爸' },
  { qq: DAD, name: '爸' },
  { qq: MOM, name: '妈妈' },
  { qq: MOM, name: '妈' },
];

console.log('称呼 → 收件人：');
{
  eq('「爸，…」认成爸爸', leadingAddressee('爸，妈说她想你了，你回她一句呗', TABLE), { qq: DAD, name: '爸' });
  eq('「爸爸: 」也认', leadingAddressee('爸爸: 我到啦', TABLE), { qq: DAD, name: '爸爸' });
  eq('「主人 在吗」认', leadingAddressee('主人 在吗', [{ qq: DAD, name: '主人' }]), { qq: DAD, name: '主人' });
  eq('叙述里的「我爸昨天…」不算叫', leadingAddressee('我爸昨天说要早点睡', TABLE), null);
  eq('「妈妈说今天很冷」不算叫（没标点紧跟）', leadingAddressee('妈妈说今天很冷', TABLE), null);
  eq('句中的「爸，」不算（必须在开头）', leadingAddressee('我觉得爸，他说得对', TABLE), null);
  eq('空串安全', leadingAddressee('', TABLE), null);
  eq('号码去前导零', normQQ('03482501440'), DAD);
}

console.log('\n拆批：');
{
  // 主人报的那句：在当前会话是妈妈时，这句话必须改投给爸爸。
  const r1 = routeByAddressee({ key: `private:${MOM}`, texts: ['爸，妈说她想你了，你回她一句呗'], table: TABLE });
  eq('妈妈窗口里写给爸爸的话改投', r1.moves, [{ qq: DAD, name: '爸', text: '爸，妈说她想你了，你回她一句呗' }]);
  eq('本会话什么都不剩', r1.keep, []);

  const r2 = routeByAddressee({ key: `private:${MOM}`, texts: ['妈，我今晚想吃火锅', '爸，你也来呗', '我先去洗澡啦'], table: TABLE });
  eq('同一批里各归各的（妈妈 2 条）', r2.keep, ['妈，我今晚想吃火锅', '我先去洗澡啦']);
  eq('同批里给爸爸的那条改投', r2.moves.map((m) => m.qq), [DAD]);

  const r3 = routeByAddressee({ key: `private:${MOM}`, texts: ['爸，晚安'], table: TABLE });
  eq('本来就是发给爸爸的窗口不必改投（peer 排除）', routeByAddressee({ key: `private:${DAD}`, texts: ['爸，晚安'], table: TABLE }).moves, []);
  ok('妈妈窗口里叫妈妈本来就是本会话', r3.moves.length === 1);

  const r4 = routeByAddressee({ key: 'group:851489980', texts: ['爸，你看这个', '妈，你也看'], table: TABLE });
  eq('群聊一律不改投（群里叫妈是家常便饭）', r4.moves, []);
  eq('群聊原文不动', r4.keep, ['爸，你看这个', '妈，你也看']);

  const r5 = routeByAddressee({ key: `private:${MOM}`, texts: ['今天好冷'], table: TABLE });
  eq('没称呼就不动', r5.moves, []);

  eq('单条字符串也能吃', routeByAddressee({ key: `private:${MOM}`, texts: '爸，早', table: TABLE }).moves.length, 1);
  eq('空表不炸', routeByAddressee({ key: `private:${MOM}`, texts: ['爸，早'], table: [] }), { keep: ['爸，早'], moves: [] });
}

console.log('\n日期标签：');
{
  const now = new Date(2026, 10, 3, 20, 0, 0).getTime(); // 2026-11-03 20:00 本地
  const at = (m, d, h, min) => new Date(2026, m - 1, d, h, min, 0).getTime();
  eq('今天', memoryWhenLabel(at(11, 3, 9, 12), now), '今天');
  eq('昨天', memoryWhenLabel(at(11, 2, 23, 30), now), '昨天');
  eq('前天', memoryWhenLabel(at(11, 1, 19, 34), now), '前天');
  eq('更早给月-日', memoryWhenLabel(at(10, 20, 8, 0), now), '10-20');
  eq('跨年给完整日期', memoryWhenLabel(new Date(2025, 11, 31, 8, 0).getTime(), now), '2025-12-31');
  eq('没有时间戳就留空', memoryWhenLabel(null, now), '');
  // 主人报的那句：11-01 19:34 的话，到 11-03 必须写成「前天」，不能当今天。
  eq('妈妈 11-01 那句在今天看来是「前天」', memoryWhenLabel(at(11, 1, 19, 34), now), '前天');
}

console.log('\n接线：');
{
  ok('bridge 有 whenLabel', /function whenLabel\(ts, \{ withTime = true, now = Date\.now\(\) \} = \{\}\)/.test(bridge));
  ok('聊天记录每行带〔时间〕', /〔\$\{when\}〕\$\{who\}：/.test(bridge));
  ok('记忆块每行带日期（live.mjs）', /memoryWhenLabel\(memoryOccurredAt\(row\)\)/.test(live));
  ok('检索结果带 when', /when: whenLabel\(memoryOccurredAt\(item\)/.test(bridge));
  ok('MCP 渲染带〔日期〕', /const when = it\.when \? `〔\$\{it\.when\}〕`/.test(mcp));
  ok('bridge 引入称呼拆批器', /import \{ routeByAddressee as routeAddressee \} from '\.\/qqb\/directed\/addressee\.mjs'/.test(bridge));
  ok('回复走 sendReplyV2（两处入口）', (bridge.match(/sendReplyV2\(/g) ?? []).length >= 3, String((bridge.match(/sendReplyV2\(/g) ?? []).length));
  ok('改投有日志', /log\('发言改投'/.test(bridge));
  ok('铁律：先看日期再开口', /【先看日期再开口】/.test(bridge));
  ok('铁律：开口叫谁就发到谁那儿', /【开口叫谁就发到谁那儿】/.test(bridge));
  ok('人名簿与白名单过滤（只改投白名单内的人）', /allowed\.has\(e\.qq\)/.test(bridge));
}

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);