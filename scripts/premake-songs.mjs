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
  },
  // 2026-10-27 追加：主人要「多一点」，按日常会用到的时候补一打。
  {
    id: 'morning-sun',
    title: '太阳先醒',
    moods: ['happy', 'cheer'],
    tags: 'chinese pop, bright female vocal, upbeat, ukulele, morning',
    duration: 22,
    steps: 22,
    lyrics: [
      '太阳比我起得早',
      '窗帘缝里挤进来一条光',
      '被子说再躺五分钟',
      '我说好就五分钟',
      '起床啦起床啦',
      '今天的你也要顺顺利利'
    ].join('\n')
  },
  {
    id: 'goodnight-kiss',
    title: '晚安亲亲',
    moods: ['sleep', 'soothe'],
    tags: 'lullaby, music box, soft female vocal, slow, dreamy',
    duration: 26,
    steps: 24,
    lyrics: [
      '灯关掉一半',
      '留一盏给我唱歌',
      '你闭上眼睛',
      '我把今天都收进抽屉',
      '晚安呀晚安',
      '明天醒了先叫我的名字'
    ].join('\n')
  },
  {
    id: 'rainy-window',
    title: '下雨的窗',
    moods: ['soothe', 'miss'],
    tags: 'chinese pop, lo-fi, soft piano, rain, gentle female vocal',
    duration: 24,
    steps: 24,
    lyrics: [
      '雨敲在窗子上',
      '像谁在很小声地说话',
      '我把杯子捧热',
      '把没说完的话咽回去',
      '你要是也在下雨',
      '就当这首是递过去的伞'
    ].join('\n')
  },
  {
    id: 'exam-luck',
    title: '考神保佑',
    moods: ['cheer'],
    tags: 'chinese pop, energetic female vocal, drums, driving, upbeat',
    duration: 20,
    steps: 22,
    lyrics: [
      '笔盖拧开',
      '深呼吸三次',
      '不会的先跳过',
      '会的别手抖',
      '你复习过的每一页',
      '今晚都站在你这边'
    ].join('\n')
  },
  {
    id: 'apology-cake',
    title: '对不起嘛',
    moods: ['sorry', 'soothe'],
    tags: 'chinese pop, cute female vocal, acoustic guitar, warm, playful',
    duration: 22,
    steps: 22,
    lyrics: [
      '刚才是我不对',
      '话说重了一点点',
      '我把道歉烤成一块小蛋糕',
      '奶油抹得有点歪',
      '你尝一口好不好',
      '吃完了就不许再生气了'
    ].join('\n')
  },
  {
    id: 'newyear-firework',
    title: '新年烟花',
    moods: ['happy', 'cheer'],
    tags: 'chinese pop, festive, bells, bright female vocal, celebratory',
    duration: 24,
    steps: 24,
    lyrics: [
      '烟花在楼顶炸开',
      '把整条街都照亮',
      '旧的一年有点粗糙',
      '新的一年要好好的',
      '许个愿吧',
      '我替你数到三'
    ].join('\n')
  },
  {
    id: 'long-night',
    title: '夜还很长',
    moods: ['soothe', 'sleep'],
    tags: 'ambient, soft humming, slow, warm pad, gentle female vocal',
    duration: 26,
    steps: 22,
    lyrics: [
      '夜还很长',
      '不用急着睡着',
      '我在这儿慢慢哼',
      '你听着就好',
      '想说就说两句',
      '不想说我们就一起安静'
    ].join('\n')
  },
  {
    id: 'proud-of-you',
    title: '为你骄傲',
    moods: ['cheer'],
    tags: 'chinese pop, anthemic, female vocal, strings, uplifting',
    duration: 24,
    steps: 24,
    lyrics: [
      '你可能自己没发现',
      '你比上个月厉害多了',
      '那些熬过去的晚上',
      '都算数',
      '所以抬头',
      '这首歌是给你的'
    ].join('\n')
  },
  {
    id: 'silly-dance',
    title: '跟我乱跳',
    moods: ['playful', 'happy'],
    tags: 'funk, bouncy bass, cute female vocal, dance, playful',
    duration: 20,
    steps: 20,
    lyrics: [
      '左脚右脚随便踩',
      '不用管拍子对不对',
      '反正现在没人看',
      '你就当自己是主角',
      '跳得难看也没关系',
      '我陪你一起难看'
    ].join('\n')
  },
  {
    id: 'hug-now',
    title: '现在抱一下',
    moods: ['soothe', 'miss'],
    tags: 'chinese R&B, soft female vocal, warm, slow groove, gentle',
    duration: 22,
    steps: 22,
    lyrics: [
      '不用说话',
      '靠过来一点就好',
      '我把手放在你背上',
      '数你呼吸的节拍',
      '累就累一会儿',
      '我在呢'
    ].join('\n')
  },
  {
    id: 'weekend-lazy',
    title: '周末别起床',
    moods: ['happy', 'playful'],
    tags: 'bossa nova, light female vocal, guitar, lazy afternoon, warm',
    duration: 22,
    steps: 22,
    lyrics: [
      '周末的早上',
      '闹钟已经被我关掉',
      '早饭等它凉一点',
      '我们先把觉睡完',
      '躺着也算正经事',
      '今天谁也别勤快'
    ].join('\n')
  },
  {
    id: 'thank-you',
    title: '谢谢你呀',
    moods: ['cheer', 'soothe'],
    tags: 'chinese folk pop, warm female vocal, acoustic, sincere, gentle',
    duration: 22,
    steps: 22,
    lyrics: [
      '谢谢你呀',
      '把我这点小毛病都接住',
      '我不会说很漂亮的话',
      '就把这句唱得认真一点',
      '以后也这样吧',
      '你往前走 我跟着'
    ].join('\n')
  },
  // 2026-10-27 追加：主人说「伤感女歌手那种也行」。这些是**原创**词曲，不是翻唱；
  // 想让她唱某首现成的歌，用 scripts/sing-cover.mjs（歌词自己给，见 README）。
  {
    id: 'sad-rain',
    title: '雨停之前',
    moods: ['sad', 'miss'],
    tags: 'mandopop ballad, sad female vocal, piano, strings, slow, emotional',
    duration: 26,
    steps: 24,
    lyrics: [
      '雨下到第三天',
      '窗台上的水一直往下淌',
      '你说过雨停了就来',
      '我数着每一滴',
      '伞还在门后站着',
      '它比我先学会等'
    ].join('\n')
  },
  {
    id: 'sad-old-phone',
    title: '旧手机',
    moods: ['sad', 'miss'],
    tags: 'mandopop ballad, breathy female vocal, soft piano, slow, melancholic',
    duration: 24,
    steps: 24,
    lyrics: [
      '旧手机还在充电',
      '里面存着没删的语音',
      '我不敢点开第二条',
      '怕听见那天的你',
      '原来最舍不得的',
      '是还能重放的从前'
    ].join('\n')
  },
  {
    id: 'sad-third-winter',
    title: '第三个冬天',
    moods: ['sad', 'soothe'],
    tags: 'mandopop ballad, sad female vocal, cello, strings, slow, wintry',
    duration: 28,
    steps: 24,
    lyrics: [
      '第三个冬天',
      '我还是会多买一杯热的',
      '走到路口才想起来',
      '没有人接过去了',
      '手插回口袋里',
      '假装只是忘了'
    ].join('\n')
  },
  {
    id: 'sad-leave-first',
    title: '先说离开的人',
    moods: ['sad'],
    tags: 'mandopop ballad, emotional female vocal, acoustic guitar, slow, raw',
    duration: 26,
    steps: 24,
    lyrics: [
      '先说离开的人',
      '总是走得最轻',
      '门带上那一下',
      '把整间屋子都掏空了',
      '我后来学到',
      '不哭也算一种告别'
    ].join('\n')
  },
  {
    id: 'sad-city-night',
    title: '城市睡着了',
    moods: ['sad', 'sleep'],
    tags: 'mandopop ballad, airy female vocal, ambient pad, slow, night',
    duration: 26,
    steps: 22,
    lyrics: [
      '城市睡着了',
      '只有我这盏灯还醒着',
      '楼下的便利店',
      '亮得像一句没说完的话',
      '我想我不难过',
      '我只是还没睡'
    ].join('\n')
  },
  {
    id: 'sad-empty-seat',
    title: '空座位',
    moods: ['sad', 'miss'],
    tags: 'mandopop ballad, sad female vocal, piano, cello, slow, cinematic',
    duration: 28,
    steps: 24,
    lyrics: [
      '电影开场以后',
      '旁边那个位置一直空着',
      '我把爆米花分成两份',
      '一份放到凉了',
      '散场灯亮起来',
      '我才发现我一直在等'
    ].join('\n')
  }
];

function parseArgs(argv) {
  const out = { only: null, force: false, list: false, minFree: 5500, vc: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '--list') out.list = true;
    else if (a === '--only') out.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--min-free') out.minFree = Math.max(1000, Number(argv[++i]) || 5500);
    // 换成她自己的音色（Seed-VC）。默认关：ACE-Step 自己的女声也够用，而且 VC 要多花几十秒。
    else if (a === '--vc') out.vc = true;
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
    if (args.vc) argv.push('--vc');
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
      // --vc 时 sing.mjs 的 JSON 里给的是"换完音色"的那个文件（vc_v2_*.wav），
      // 不是 --out 那个原始产物；入库要记转换后的（2026-10-27 实测踩到：只记 outRel 会让曲库发原声）。
      const finalRel = String(payload?.file || outRel).split(path.sep).join('/');
      const finalAbs = path.resolve(root, finalRel);
      if (code !== 0 || !payload?.file || !fs.existsSync(finalAbs)) {
        const tail = (stderr.trim().split(/\r?\n/).pop() || stdout.trim().split(/\r?\n/).pop() || '').slice(0, 300);
        resolve({ ok: false, ms, error: `exit=${code}：${tail}` });
        return;
      }
      resolve({ ok: true, ms, payload, outRel: finalRel, bytes: fs.statSync(finalAbs).size });
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