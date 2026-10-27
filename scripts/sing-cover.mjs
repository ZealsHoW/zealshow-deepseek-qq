// 让她「翻唱」某首歌：歌词自己给，她用自己的音色唱出来。
//
// 为什么不是内置歌单：现成的流行歌词是别人的版权作品，仓库里不存、也不替主人补全。
// 想听哪首，把歌词贴进一个 txt（或者直接放进 state/lyrics/），这条命令负责：
//   歌词文件 → ACE-Step 生成 → Seed-VC 换成她的音色 →（可选）发出去 / 收进曲库。
//
// 用法：
//   node scripts/sing-cover.mjs state/lyrics/雨爱.txt --send private:3482501440
//   node scripts/sing-cover.mjs 雨爱 --duration 30 --mood sad --add
//   node scripts/sing-cover.mjs 雨爱 --no-vc --out audio/songs/cover-yuai.wav
//
// 参数：
//   第一个位置参数      歌词文件路径；找不到就当 state/lyrics/<名字>.txt 找
//   --send <key>        唱完直接发到 group:群号 / private:QQ号（走 send-voice.mjs）
//   --tags "..."        ACE-Step 风格标签（默认伤感女声慢歌）
//   --duration <秒>     8~60，默认 30
//   --steps <n>         8~40，默认 26
//   --title "名字"      收进曲库时的标题（默认用歌词文件名）
//   --mood a,b          收进曲库的情景标签（默认 sad）
//   --add               唱完收进曲库（qq_sing_send 以后能直接点）
//   --no-vc             不换音色（ACE-Step 的原声）
//   --out <路径>        输出位置（默认 audio/songs/cover-<slug>.wav）
//   --ref <音频>        参考音频（audio2audio）：只影响曲风/配器/律动，不会让她照着原曲的旋律唱
//   --ref-strength <0~1> 参考的相似强度，默认 0.6（越大越贴参考的编曲气质）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSongLibrary } from '../src/qqb/song-library.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opts = { send: '', tags: 'mandopop ballad, sad female vocal, piano, strings, slow, emotional', duration: 30, steps: 26, title: '', moods: ['sad'], add: false, vc: true, out: '', ref: '', refStrength: 0.6 };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--send') opts.send = String(argv[++i] ?? '');
  else if (a === '--tags') opts.tags = String(argv[++i] ?? opts.tags);
  else if (a === '--duration') opts.duration = Math.min(Math.max(Number(argv[++i]) || 30, 8), 60);
  else if (a === '--steps') opts.steps = Math.min(Math.max(Number(argv[++i]) || 26, 8), 40);
  else if (a === '--title') opts.title = String(argv[++i] ?? '');
  else if (a === '--mood') opts.moods = String(argv[++i] ?? 'sad').split(/[,，\s]+/).filter(Boolean);
  else if (a === '--add') opts.add = true;
  else if (a === '--no-vc') opts.vc = false;
  else if (a === '--out') opts.out = String(argv[++i] ?? '');
  else if (a === '--ref') opts.ref = String(argv[++i] ?? '');
  else if (a === '--ref-strength') opts.refStrength = Math.min(Math.max(Number(argv[++i]) || 0.6, 0), 1);
  else rest.push(a);
}

const input = rest[0];
if (!input) {
  console.error('用法：node scripts/sing-cover.mjs <歌词文件> [--send private:QQ号] [--add] [--title 名字]');
  process.exit(2);
}

function findLyrics(name) {
  const candidates = [
    path.resolve(root, name),
    path.resolve(root, 'state', 'lyrics', name),
    path.resolve(root, 'state', 'lyrics', `${name}.txt`)
  ];
  for (const p of candidates) if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  return null;
}

const lyricsPath = findLyrics(input);
if (!lyricsPath) {
  console.error(`找不到歌词文件：${input}（也试过 state/lyrics/${input}.txt）`);
  console.error('把歌词存成一个 txt 放进去就行，一行一句。');
  process.exit(2);
}
const lyrics = fs.readFileSync(lyricsPath, 'utf8').trim();
if (!lyrics) { console.error(`歌词文件是空的：${lyricsPath}`); process.exit(2); }
if (lyrics.length > 1200) {
  console.error(`歌词太长（${lyrics.length} 字，上限 1200）：唱歌接口只吃这么长，分成两段唱吧。`);
  process.exit(2);
}

const slugBase = path.basename(lyricsPath).replace(/\.txt$/i, '');
const slug = slugBase.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'cover';
const outRel = (opts.out || path.join('audio', 'songs', `cover-${slug}.wav`)).split(path.sep).join('/');
const title = opts.title || slugBase;

const args = [path.join(root, 'scripts', 'sing.mjs'), '--lyrics-file', lyricsPath, '--tags', opts.tags, '--duration', String(opts.duration), '--steps', String(opts.steps), '--out', outRel, '--json'];
if (opts.vc) args.push('--vc');
if (opts.ref) args.push('--ref', String(opts.ref), '--ref-strength', String(opts.refStrength));
if (opts.send) args.push('--send', opts.send);

console.log(`▶ 唱《${title}》：${lyrics.split(/\r?\n/).filter(Boolean).length} 句 / ${opts.duration}s${opts.vc ? ' / 换她的音色' : ''}`);
const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', (b) => { stdout += b.toString(); process.stdout.write(b); });
child.stderr.on('data', (b) => { stderr += b.toString(); });
child.on('close', (code) => {
  if (code !== 0) {
    console.error(`✗ 没唱成（exit=${code}）`);
    if (stderr.trim()) console.error(stderr.trim().split(/\r?\n/).slice(-4).join('\n'));
    process.exit(code || 1);
  }
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  let payload = null;
  for (let i = lines.length - 1; i >= 0 && !payload; i--) { try { payload = JSON.parse(lines[i]); } catch { /* 继续往前找 */ } }
  const finalRel = String(payload?.file ?? outRel).split(path.sep).join('/');
  console.log(`✓ 成品：${finalRel}`);
  if (!opts.add) return finish(finalRel);
  const abs = path.resolve(root, finalRel);
  if (!fs.existsSync(abs)) { console.error(`✗ 收进曲库失败：文件不在 ${finalRel}`); process.exit(1); }
  const library = createSongLibrary({ filePath: path.join(root, 'state', 'song-library.json') });
  library.add({ id: `cover-${slug}`, title, file: finalRel, moods: opts.moods, tags: opts.tags, durationSec: Number(opts.duration), bytes: fs.statSync(abs).size, lyrics });
  console.log(`✓ 已收进曲库：cover-${slug}（情景 ${opts.moods.join('/')}），以后 qq_sing_send 能直接点`);
  finish(finalRel);
});

function finish(finalRel) {
  if (opts.send) console.log(`→ 已按 --send 发出（见上面 send-voice 的输出）；要再发一次：node scripts/send-voice.mjs send ${finalRel} ${opts.send}`);
  else console.log(`要发出去：node scripts/send-voice.mjs send ${finalRel} private:3482501440`);
  process.exit(0);
}