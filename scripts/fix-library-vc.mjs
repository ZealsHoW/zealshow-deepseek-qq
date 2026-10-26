// 一次性修复：把曲库里 6 首的 file 指向「换过音色」的 vc_v2_*.wav（2026-10-27 实测到的问题）
// 用法：node scripts/fix-library-vc.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSongLibrary } from '../src/qqb/song-library.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const library = createSongLibrary({ filePath: path.join(root, 'state', 'song-library.json') });
const songsDir = path.join(root, 'audio', 'songs');

let fixed = 0;
for (const entry of library.entries()) {
  const hit = fs.readdirSync(songsDir).find((f) => f.startsWith(`vc_v2_${entry.id}_`) && f.endsWith('.wav'));
  if (!hit) { console.log(`⚠️ ${entry.id}：没找到 vc_v2_ 文件，保持 ${entry.file}`); continue; }
  const rel = `audio/songs/${hit}`;
  if (entry.file === rel) { console.log(`✅ ${entry.id}：已经是转换后的文件`); continue; }
  library.add({ ...entry, file: rel, bytes: fs.statSync(path.join(songsDir, hit)).size });
  console.log(`🔧 ${entry.id}：${entry.file} → ${rel}`);
  fixed += 1;
}
const stats = library.stats();
console.log(`\n改完 ${fixed} 首；曲库 ${stats.count} 首、${stats.totalSeconds} 秒`);