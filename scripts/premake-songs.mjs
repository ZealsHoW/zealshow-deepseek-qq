#!/usr/bin/env node
// 预先唱好几条不一样的歌，存进曲库 —— 到时候 qq_sing_send 按情景秒发。
//
// 用法：
//   node scripts/premake-songs.mjs                 # 把清单里缺的都补上
//   node scripts/premake-songs.mjs --only happy-day,sleep-lullaby
//   node scripts/premake-songs.mjs --force         # 已有的也重做（会覆盖同名音频）
//   node scripts/premake-songs.mjs --list          # 只看清单和库里现状
//
// 为什么不在桥接里跑：生成一首 1~5 分钟、吃 7~10 GB，桥接里跑会把她的聊天一起拖住。
// 这个脚本是离线批处理，一条一条来，生成完写进 state/song-library.json。
//
// 内存：默认要求可用物理内存 ≥ 5500 MB 才开下一条（ACE-Step 权重 7.7 GB，靠页面文件硬撑会非常慢）。
// 想放宽就 --min-free 4000，想更严就 --min-free 7000。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSongLibrary } from '../src/qqb/song-library.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// 曲目清单：每一条都挑一个不同的情景，歌词自己写、别抄别人的歌。
const SONGS = [
  {
    id: 'happy-day',
    title: '今天风很轻',
    moods: ['happy', 'cheer'],
    tags: 'chinese pop, female vocal, warm, gentle, acoustic, ukulele',
    duration: 22,
    steps: 22,
    lyrics: [
      '小鲸鱼游呀游',
      '把尾巴摇成一个小圈',
      '今天的风很轻',
      '吹得心事都跑了',
      '你要是也开心',
      '就跟我一起哼这一段'
    ].join('\n')
  },
  {
    id: 'soothe-night',
    title: '别难过呀',
    moods: ['soothe', 'sorry'],
    tags: 'chinese pop, female vocal, soft, slow, piano, gentle',
    duration: 24,
    steps: 24,
    lyrics: [
      '别低着头呀',
      '我在这儿呢',
      '那些没做好的事',
      '明天再说也行',
      '你先喝口水',
      '我唱完这句就不吵你了'
    ].join('\n')
  },
  {
    id: 'sleep-lullaby',
    title: '月亮挂在窗边',
    moods: ['sleep'],
    tags: 'lullaby, soft female vocal, piano, music box, slow, quiet',
    duration: 26,
    steps: 24,
    lyrics: [
      '月亮挂在窗边',
      '替我把灯关掉',
      '今天的累就放在枕头底下',
      '明天醒来再捡',
      '睡吧睡吧',
      '我数到三就不说话了'
    ].join('\n')
  },
  {
    id: 'birthday-cake',
    title: '今天是你的日子',
    moods: ['birthday', 'happy'],
    tags: 'chinese pop, bright female vocal, cheerful, drums, warm',
    duration: 22,
    steps: 22,
    lyrics: [
      '今天是你的日子',
      '蜡烛我替你许了愿',
      '蛋糕上的奶油有点歪',
      '但心意是正着的',
      '祝你生日快乐',
      '每一年都比上一年多笑一点'
    ].join('\n')
  },
  {
    id: 'miss-you',
    title: '好几天没见了',
    moods: ['miss'],
    tags: 'chinese pop, female vocal, mellow, guitar, slow, tender',
    duration: 24,
    steps: 24,
    lyrics: [
      '好几天没见了',
      '我把想说的话存起来',
      '攒成一小段歌',
      '等你有空的时候放给你听',
      '你要是听见了',
      '就当我刚刚抱了你一下'
    ].join('\n')
  },
  {
    id: 'playful-brat',
    title: '谁说我只会撒娇',
    moods: ['playful'],
    tags: 'chinese pop, cute female vocal, bouncy, bass, playful',
    duration: 20,
    steps: 20,
    lyrics: [
      '谁说我只会撒娇',
      '我还会唱跑调的歌',
      '你要是敢笑我',
      '我就再唱一遍给你听',
      '反正你也跑不掉',
      '乖乖坐着当我的听众'
    ].join('\n')
  }
];

function parseArgs(argv) {
  const out = { only: null, force: false, list: false, minFree: 5500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '--list') out.list = true;
    else if (a === '--only') out.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--min-free') out.minFree = Math.max(1000, Number(argv[++i]) || 5500);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const libraryFile = path.join(root, 'state', 'song-library.json');
const audioDir = path.join(root, 'audio', 'songs');
const library = createSongLibrary({
  filePath: libraryFile,
  audioDir,
  logger: { warn: (m) => console.warn(`  ⚠️  ${m}`) }
});

const freeMb = () => Math.round(os.freemem() / 1048576);

if (args.list) {
  console.log(`曲库清单：${libraryFile}`);
  console.log(`音频目录：${audioDir}`);
  const stats = library.stats();
  console.log(`库里 ${stats.count} 首，可用内存 ${freeMb()} MB\n`);
  for (const song of SONGS) {
    const have = library.get(song.id);
    const fileOk = have?.file && fs.existsSync(path.join(root, have.file));
    console.log(`${have && fileOk ? '✅' : '⬜'} ${song.id.padEnd(16)} ${song.title}  [${song.moods.join('/')}] ${have ? `(用过 ${have.useCount} 次)` : ''}`);
  }
  process.exit(0);
}

function sing(song) {
  return new Promise((resolve) => {
    const outRel = path.join('audio', 'songs', `${song.id}.wav`);
    const outAbs = path.join(root, outRel);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    const argv = [
      path.join(root, 'scripts', 'sing.mjs'),
      '--lyrics', song.lyrics,
      '--tags', song.tags,
      '--duration', String(song.duration),
      '--steps', String(song.steps),
      '--out', outRel,
      '--json'
    ];
    const startedAt = Date.now();
    const child = spawn(process.execPath, argv, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => resolve({ ok: false, error: `起不来：${err?.message ?? err}` }));
    child.on('close', (code) => {
      const ms = Date.now() - startedAt;
      const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
      let payload = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try { payload = JSON.parse(lines[i]); break; } catch { /* 继续往前找 */ }
      }
      if (code !== 0 || !payload?.file || !fs.existsSync(outAbs)) {
        const tail = (stderr.trim().split(/\r?\n/).pop() || stdout.trim().split(/\r?\n/).pop() || '').slice(0, 300);
        resolve({ ok: false, ms, error: `exit=${code}：${tail}` });
        return;
      }
      resolve({ ok: true, ms, payload, outRel, bytes: fs.statSync(outAbs).size });
    });
  });
}

const todo = SONGS.filter((song) => {
  if (args.only && !args.only.includes(song.id)) return false;
  if (args.force) return true;
  const have = library.get(song.id);
  return !(have?.file && fs.existsSync(path.join(root, have.file)));
});

console.log(`要生成 ${todo.length} 首（共 ${SONGS.length} 首在清单里），当前可用内存 ${freeMb()} MB`);
if (!todo.length) {
  console.log('都做完了，不用再生成。');
  process.exit(0);
}

for (const song of todo) {
  const free = freeMb();
  if (free < args.minFree) {
    console.log(`\n⏸  可用内存只有 ${free} MB（< ${args.minFree} MB），先不做了。`);
    console.log('   腾点内存再来：powershell -NoProfile -File scripts/mem-free.ps1');
    process.exit(3);
  }
  console.log(`\n▶  ${song.id}（${song.title}）[${song.moods.join('/')}] ${song.duration}s / ${song.steps} steps，可用 ${free} MB`);
  const result = await sing(song);
  if (!result.ok) {
    console.log(`   ✗ 失败（${Math.round((result.ms ?? 0) / 1000)}s）：${result.error}`);
    continue;
  }
  library.add({
    id: song.id,
    title: song.title,
    file: result.outRel.split(path.sep).join('/'),
    moods: song.moods,
    tags: song.tags,
    durationSec: song.duration,
    bytes: result.bytes,
    lyrics: song.lyrics
  });
  console.log(`   ✅ 好了：${result.outRel}（${(result.bytes / 1024 / 1024).toFixed(1)} MB，用时 ${Math.round(result.ms / 1000)}s）`);
}

const stats = library.stats();
console.log(`\n曲库现在有 ${stats.count} 首，合计 ${Math.round(stats.totalSeconds)} 秒。`);