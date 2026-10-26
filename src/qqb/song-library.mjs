// 预生成曲库：先把歌做好存起来，到时候按情景挑一首直接发。
//
// 为什么要有它：ACE-Step 生成一首歌要 1~5 分钟、吃 7~10 GB（这台机 16 GB，2026-10-26 13:44 那次
// 就是硬上把整机压到假死 16 分钟）。等人来点歌再现场做，她只能回一句「等我几分钟」然后干等着。
// 所以改成「有空先唱好几条不一样的，存着」，用的时候 qq_sing_send 秒发。
//
// 清单存 state/song-library.json，音频放 audio/songs/<id>.wav（.gitignore 里，不入库）。
// 一条歌长这样：
//   { id, title, file, moods: ['happy'], tags: 'chinese pop, female vocal', durationSec: 22,
//     bytes, lyrics, createdAt, useCount, lastUsedAt }
import fs from 'node:fs';
import path from 'node:path';

export const SONG_MOODS = ['happy', 'soothe', 'sleep', 'birthday', 'miss', 'playful', 'cheer', 'sorry'];
export const MOOD_LABELS = {
  happy: '开心',
  soothe: '安慰',
  sleep: '哄睡',
  birthday: '生日',
  miss: '想他',
  playful: '调皮',
  cheer: '打气',
  sorry: '道歉'
};

function cleanMoods(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[,，\s]+/);
  return [...new Set(list.map((m) => String(m).trim().toLowerCase()).filter(Boolean))];
}

function cleanTitle(input, fallbackId) {
  const t = String(input ?? '').trim();
  return (t || fallbackId || '没起名字的歌').slice(0, 60);
}

export function createSongLibrary({ filePath, audioDir = null, logger = null, now = () => Date.now() } = {}) {
  const storeFile = filePath ? path.resolve(filePath) : null;
  const warn = (message) => { try { logger?.warn?.(message); } catch { /* 记日志失败不影响唱歌 */ } };

  function emptyData() {
    return { version: 1, songs: [] };
  }

  function load() {
    if (!storeFile) return emptyData();
    try {
      if (!fs.existsSync(storeFile)) return emptyData();
      const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      const songs = Array.isArray(raw?.songs) ? raw.songs : [];
      return { version: 1, songs: songs.filter((s) => s && typeof s.id === 'string' && s.id) };
    } catch (err) {
      // 清单坏了不该让她没法唱歌：当作空库，下一次写入会覆盖掉坏文件。
      warn(`曲库清单读不出来（当作空的）：${err?.message ?? err}`);
      return emptyData();
    }
  }

  let data = load();

  function save() {
    if (!storeFile) return false;
    try {
      fs.mkdirSync(path.dirname(storeFile), { recursive: true });
      const tmp = `${storeFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, storeFile);
      return true;
    } catch (err) {
      warn(`曲库清单写不进去：${err?.message ?? err}`);
      return false;
    }
  }

  function entries() {
    return data.songs.map((s) => ({ ...s }));
  }

  function get(id) {
    const hit = data.songs.find((s) => s.id === String(id ?? ''));
    return hit ? { ...hit } : null;
  }

  function count() {
    return data.songs.length;
  }

  function add(entry = {}) {
    const id = String(entry.id ?? '').trim();
    if (!id) throw new Error('曲目 id 不能为空');
    const item = {
      id,
      title: cleanTitle(entry.title, id),
      file: String(entry.file ?? '').trim(),
      moods: cleanMoods(entry.moods),
      tags: String(entry.tags ?? '').trim().slice(0, 200),
      durationSec: Number.isFinite(Number(entry.durationSec)) ? Number(entry.durationSec) : null,
      bytes: Number.isFinite(Number(entry.bytes)) ? Number(entry.bytes) : null,
      lyrics: String(entry.lyrics ?? '').slice(0, 2000),
      createdAt: Number(entry.createdAt ?? now()),
      useCount: 0,
      lastUsedAt: 0
    };
    const idx = data.songs.findIndex((s) => s.id === id);
    if (idx >= 0) {
      // 重做同一首：保留使用记录，别让「用过几次」清零。
      item.useCount = Number(data.songs[idx].useCount ?? 0);
      item.lastUsedAt = Number(data.songs[idx].lastUsedAt ?? 0);
      data.songs[idx] = item;
    } else {
      data.songs.push(item);
    }
    save();
    return { ...item };
  }

  function remove(id) {
    const before = data.songs.length;
    data.songs = data.songs.filter((s) => s.id !== String(id ?? ''));
    if (data.songs.length !== before) save();
    return data.songs.length !== before;
  }

  // 按情景挑一首：命中 mood 的优先，用得少的优先，很久没用的优先，同分里随机，免得每次都同一首。
  function pick({ moods = [], excludeRecent = 0, random = Math.random } = {}) {
    const want = cleanMoods(moods);
    if (!data.songs.length) return null;
    const recent = excludeRecent > 0
      ? [...data.songs].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)).slice(0, excludeRecent).map((s) => s.id)
      : [];
    const scored = data.songs.map((song) => {
      const overlap = want.filter((m) => (song.moods ?? []).includes(m)).length;
      let score = overlap * 4;
      score -= Math.min(Number(song.useCount ?? 0), 10) * 0.6;
      const idleDays = song.lastUsedAt ? (now() - song.lastUsedAt) / 86400000 : 30;
      score += Math.min(idleDays, 30) * 0.12;
      if (recent.includes(song.id)) score -= 2.5;
      return { song, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 0;
    const near = scored.filter((s) => s.score >= best - 0.5);
    return { ...near[Math.min(near.length - 1, Math.floor(random() * near.length))].song };
  }

  function markUsed(id, at = now()) {
    const song = data.songs.find((s) => s.id === String(id ?? ''));
    if (!song) return false;
    song.useCount = Number(song.useCount ?? 0) + 1;
    song.lastUsedAt = at;
    save();
    return true;
  }

  function stats() {
    const moods = {};
    for (const song of data.songs) for (const m of song.moods ?? []) moods[m] = (moods[m] ?? 0) + 1;
    const totalSeconds = data.songs.reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0);
    const last = data.songs.reduce((max, s) => Math.max(max, Number(s.createdAt) || 0), 0);
    return {
      count: data.songs.length,
      moods,
      labels: MOOD_LABELS,
      totalSeconds,
      lastGeneratedAt: last || null,
      filePath: storeFile,
      audioDir
    };
  }

  function reload() {
    data = load();
    return count();
  }

  return { entries, get, count, add, remove, pick, markUsed, stats, reload, filePath: storeFile };
}