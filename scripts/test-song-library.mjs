#!/usr/bin/env node
// 曲库回归：预生成的歌能按情景挑出来、秒发路由接线正确、清单坏了不炸。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSongLibrary, MOOD_LABELS } from '../src/qqb/song-library.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const bridgeSrc = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(root, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const premakeSrc = fs.readFileSync(path.join(root, 'scripts', 'premake-songs.mjs'), 'utf8');

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  ✅ ${label}`);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'songlib-'));
}

console.log('曲库：清单读写与挑歌');

// 1) 空库
{
  const dir = tmpDir();
  const lib = createSongLibrary({ filePath: path.join(dir, 'song-library.json'), audioDir: path.join(dir, 'audio') });
  ok(lib.count() === 0, '新库是空的');
  ok(lib.pick({ moods: ['happy'] }) === null, '空库挑不出歌（返回 null，不抛）');
  ok(lib.stats().count === 0 && lib.stats().filePath.endsWith('song-library.json'), 'stats 带文件路径');

  lib.add({ id: 'happy-day', title: '今天风很轻', file: 'audio/songs/happy-day.wav', moods: ['happy', 'cheer'], durationSec: 22, bytes: 1000 });
  lib.add({ id: 'sleep-lullaby', title: '月亮挂在窗边', file: 'audio/songs/sleep-lullaby.wav', moods: ['sleep'], durationSec: 26 });
  ok(lib.count() === 2, '加两条之后 count=2');

  const reopened = createSongLibrary({ filePath: path.join(dir, 'song-library.json') });
  ok(reopened.count() === 2, '落盘后重开还在（tmp+rename 生效）');
  ok(reopened.get('happy-day').moods.join(',') === 'happy,cheer', 'mood 标签存下来了');
}

// 2) 按情景挑
{
  const dir = tmpDir();
  const lib = createSongLibrary({ filePath: path.join(dir, 'song-library.json') });
  lib.add({ id: 'sleep-lullaby', title: '哄睡', file: 'audio/songs/a.wav', moods: ['sleep'] });
  lib.add({ id: 'happy-day', title: '开心', file: 'audio/songs/b.wav', moods: ['happy'] });
  lib.add({ id: 'soothe-night', title: '安慰', file: 'audio/songs/c.wav', moods: ['soothe'] });

  ok(lib.pick({ moods: ['sleep'] }).id === 'sleep-lullaby', '按 mood=sleep 挑到哄睡那首');
  ok(lib.pick({ moods: ['soothe'] }).id === 'soothe-night', '按 mood=soothe 挑到安慰那首');
  // 没命中任何 mood 也得给一首，不能报错
  const any = lib.pick({ moods: ['unheard-of'] });
  ok(any && typeof any.id === 'string', 'mood 不认识时也给一首（不至于没得发）');

  // 用过的往后退：同一情景连挑，会换人
  lib.markUsed('sleep-lullaby');
  ok(lib.get('sleep-lullaby').useCount === 1, 'markUsed 记账');
  const counts = {};
  for (let i = 0; i < 12; i++) {
    const song = lib.pick({ moods: ['sleep', 'happy', 'soothe'], random: () => 0 });
    // 真实链路里发完就记账（bridge 的 song-library/send 会 markUsed），必须照着做才谈得上「换人」。
    lib.markUsed(song.id);
    counts[song.id] = (counts[song.id] ?? 0) + 1;
  }
  ok(Object.keys(counts).length >= 2, '连续挑 12 次不会总给同一首');
}

// 3) 清单坏了 / 目录不在
{
  const dir = tmpDir();
  const file = path.join(dir, 'song-library.json');
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  const warns = [];
  const lib = createSongLibrary({ filePath: file, logger: { warn: (m) => warns.push(m) } });
  ok(lib.count() === 0 && warns.length === 1, '清单坏了当作空库，只 warn 一次');
  lib.add({ id: 'x', title: 'x', file: 'audio/songs/x.wav', moods: ['happy'] });
  ok(createSongLibrary({ filePath: file }).count() === 1, '坏文件之后能正常覆盖写入');

  const nested = createSongLibrary({ filePath: path.join(dir, 'deep', 'nested', 'lib.json') });
  nested.add({ id: 'y', title: 'y', file: 'audio/songs/y.wav', moods: [] });
  ok(fs.existsSync(path.join(dir, 'deep', 'nested', 'lib.json')), '目录不存在会自动建');
}

// 4) 标签与重复 id
{
  const dir = tmpDir();
  const lib = createSongLibrary({ filePath: path.join(dir, 'lib.json') });
  lib.add({ id: 'dup', title: '第一版', file: 'audio/songs/dup.wav', moods: ['HAPPY', 'happy', ' 玩 '] });
  const first = lib.get('dup');
  ok(first.moods.length === 2 && first.moods.includes('happy'), 'mood 去重 + 小写化');
  lib.markUsed('dup');
  lib.add({ id: 'dup', title: '重做版', file: 'audio/songs/dup2.wav', moods: ['playful'] });
  const after = lib.get('dup');
  ok(after.title === '重做版' && after.useCount === 1, '重做同一首不清零使用记录');
  ok(lib.count() === 1, '同 id 不会变两条');
  ok(MOOD_LABELS.sleep === '哄睡', 'mood 中文标签表在');
}

console.log('\n曲库：桥接接线');

ok(/import \{ createSongLibrary \} from '\.\/qqb\/song-library\.mjs'/.test(bridgeSrc), 'bridge 引了 song-library');
ok(/const songLibrary = createSongLibrary\(\{/.test(bridgeSrc), 'bridge 建了曲库实例');
ok(/function songLibraryPlayable\(\)/.test(bridgeSrc), '只发「清单有 + 文件在」的那些');
ok(/url\.pathname === '\/api\/socialV2\/song-library'/.test(bridgeSrc), 'GET /api/socialV2/song-library 能看曲库');
ok(/url\.pathname === '\/api\/socialV2\/song-library\/send'/.test(bridgeSrc), 'POST /song-library/send 能发');
ok(/const chosen = wantId[\s\S]{0,200}songLibrary\.pick\(\{ moods: wantMoods, excludeRecent: 3 \}\)/.test(bridgeSrc), '按 mood 挑（避开最近发过的 3 首）');
ok(/songLibrary\.markUsed\(chosen\.id\)/.test(bridgeSrc), '发出去后记账');
ok(/sendVoiceForV2\(target, relFile, \{ label: '唱了首歌', verify: true \}\)/.test(bridgeSrc), '复用 sendVoiceForV2 发语音并回读校验');
ok(/曲库还空着/.test(bridgeSrc), '空库时给出可读错误（409）');

console.log('\n曲库：点名发到别处（2026-10-27 主人要的「发到某某地方或群里」）');

ok(/function resolveSongTarget\(raw, fallbackKey = ''\)/.test(bridgeSrc), '有把「发到哪儿」归一成 key 的解析函数');
ok(/\^\(\?:群\|群聊\|群里\|group\)/.test(bridgeSrc) && /\^\(\?:私聊\|好友\|private\|qq\)/.test(bridgeSrc), '认得「群 851489980 / 私聊 3482501440」这种说法');
ok(/groups\.includes\(id\) && !privs\.includes\(id\)/.test(bridgeSrc), '光给数字时：在白名单群里按群，否则按私聊');
ok(/const target = resolveSongTarget\(wantTarget, key\)/.test(bridgeSrc), '路由里 target 缺省回落到当前会话');
ok(/v2SessionAllowed\(target\)/.test(bridgeSrc) && /目标不在白名单里/.test(bridgeSrc), '点名发别处仍要过白名单');
ok(/shouldBlockSilentReply\(target\)/.test(bridgeSrc), '别处开着静默也不发');
ok(/target: z\.string\(\)\.optional\(\)\.describe\('发到哪儿/.test(mcpSrc), 'MCP 工具把 target 暴露给模型');
ok(/发到了 \$\{data\.target\}/.test(mcpSrc), '发到别处时回话里说清发到哪儿');
// 2026-10-27 实测：曲库存的是仓库根相对路径，而 sendVoiceForV2 按「语音库目录」解析相对路径，
// 直接传会变成 audio/audio/songs/x.wav（报「语音库里找不到」）。必须换算成 songs/x.wav。
ok(/path\.relative\(voiceDirAbs, absFile\)/.test(bridgeSrc), '发给 sendVoiceForV2 的路径要相对语音库目录，不是仓库根');
ok(/relFile\.startsWith\('\.\.'\)/.test(bridgeSrc), '歌不在语音库里就明确报错，别拿库外文件硬发');

console.log('\n曲库：MCP 工具');

ok(/qq_sing_send: 'sing'/.test(mcpSrc), 'qq_sing_send 与 qq_sing 共用 sing 开关');
ok(/'qq_sing_send'/.test(mcpSrc), '注册了 qq_sing_send 工具');
ok(/\/api\/socialV2\/song-library\/send/.test(mcpSrc), '工具打的是曲库发送路由');
ok(/调用返回 ok=true 就代表\*\*已经发出\*\*/.test(mcpSrc), '描述里讲清「秒发、不用等」');

console.log('\n曲库：预生成脚本');

ok(/const SONGS = \[/.test(premakeSrc), '有曲目清单');
ok((premakeSrc.match(/\n  \{\n    id: '/g) ?? []).length >= 5, '清单至少 5 首不一样的');
ok(/moods: \['happy'/.test(premakeSrc) && /moods: \['sleep'\]/.test(premakeSrc), '每首带情景标签');
ok(/--min-free/.test(premakeSrc) && /free < args\.minFree/.test(premakeSrc), '内存不够就停下，不硬上');
ok(/library\.add\(\{/.test(premakeSrc), '生成完写进曲库');
ok(/--json/.test(premakeSrc), '让 sing.mjs 回 JSON 才好判断成功');
// 2026-10-27 实测的坑：--vc 时 --out 那个是原声，换完音色的文件在 JSON 的 file 里；
// 只记 outRel 会让曲库发出去的是 ACE-Step 的原声，不是她的嗓子。
ok(/payload\?\.file \|\| outRel/.test(premakeSrc), '--vc 时入库要记转换后的文件（JSON 的 file），不是 --out');
ok(/fs\.existsSync\(finalAbs\)/.test(premakeSrc), '按最终文件判断成功，别拿原声文件存在就当成了');

console.log('\n曲库：伤感那批 + 翻唱脚本');

// 2026-10-27：主人要「#雨爱》《最后一页》那种伤感女歌手」。
// 伤感 batch 是原创的（现成流行歌的词是别人的版权作品，仓库不存），
// 真想唱某首现成的歌走 sing-cover.mjs——歌词由主人给。
ok(MOOD_LABELS.sad === '伤感', '曲库认得 sad 这个情景');
ok(/moods: \['sad'/.test(premakeSrc), '伤感那几首打了 sad 标签');
ok((premakeSrc.match(/\n  \{\n    id: '/g) ?? []).length >= 20, '曲目清单已经攒到 20 首以上');

const coverSrc = path.join(root, 'scripts', 'sing-cover.mjs');
ok(fs.existsSync(coverSrc), '有翻唱脚本 scripts/sing-cover.mjs');
const coverCode = fs.existsSync(coverSrc) ? fs.readFileSync(coverSrc, 'utf8') : '';
ok(/--lyrics-file/.test(coverCode), '翻唱走 --lyrics-file 传歌词，不在代码里存词');
ok(/state', 'lyrics'/.test(coverCode) || /state\/lyrics/.test(coverCode), '也认 state/lyrics/ 下的 txt');
ok(/--send/.test(coverCode) && /--add/.test(coverCode), '能直接发出去，也能收进曲库');
ok(/createSongLibrary/.test(coverCode), '收进曲库用的是同一套 song-library');
ok(/--ref-strength/.test(coverCode) && /opts\.ref\) args\.push\('--ref'/.test(coverCode), '翻唱脚本能把参考音频（--ref / --ref-strength）透传给 sing.mjs');

console.log(`\n结果：${passed} 通过 0 失败`);