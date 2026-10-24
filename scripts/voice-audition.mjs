#!/usr/bin/env node
// 音色试听 / 切换：用「同一句台词 + 不同参考音频」各合成一遍，听完再决定用哪个。
//
// 为什么要有它：GPT-SoVITS 是零样本克隆，音色完全由 config.json 里的
// refAudio（参考音频）+ refText（参考文本）决定。换音色不用训练模型，
// 换一对参考文件就行 —— 但这个"换"必须能被听见，否则等于瞎猜。
//
// 用法（在 qq-bridge 目录下）：
//   node scripts/voice-audition.mjs                       # 默认拿 audio/ref/edge-*.wav 全试一遍
//   node scripts/voice-audition.mjs --text "自定义台词"
//   node scripts/voice-audition.mjs --candidates audio/ref/edge-xiaoyi.wav,audio/ref/edge-xiaoxiao.wav
//   node scripts/voice-audition.mjs --set audio/ref/edge-xiaoyi.wav
//       把 config.json 的 refAudio 切到它（refText 用 --ref-text 指定，默认沿用配置里的），
//       并打印「谁被改了」，改完记得让桥接/音色服务重新读配置。
//
// 前置：GPT-SoVITS 服务在跑（scripts/gptsovits-serve.ps1，127.0.0.1:9880）。
// 生成参考音频：python scripts/make-ref-voice.py --voice zh-CN-XiaoyiNeural
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gptsovitsSettings, gptsovitsHealth, synthesizeWithGptSoVits } from '../src/qqb/tts-gptsovits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// QQ_BRIDGE_CONFIG 让测试（和换装/多实例）能指向别的配置文件，默认才是仓库里的 config.json
const CONFIG_PATH = process.env.QQ_BRIDGE_CONFIG
  ? path.resolve(process.env.QQ_BRIDGE_CONFIG)
  : path.join(ROOT, 'config.json');

const DEFAULT_TEXT = '主人，你在听吗？这是我新的声音，你觉得怎么样呀？要是喜欢，我以后就用这个声音跟你说话啦。';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) out[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function readConfig() {
  const text = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(text);
  return { text, cfg };
}

function voiceCfg(cfg) {
  return cfg?.socialV2?.voice?.tts?.gptsovits ?? {};
}

function listCandidates() {
  const dir = path.join(ROOT, 'audio', 'ref');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(wav|mp3|flac|ogg)$/i.test(f) && !/^sapi-/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { text: configText, cfg } = readConfig();
  const g = voiceCfg(cfg);
  const root = ROOT;

  // ── 切换参考音频 ──────────────────────────────────────────────────────────
  if (args.set) {
    const target = path.resolve(ROOT, String(args.set));
    if (!fs.existsSync(target)) {
      console.error(`❌ 找不到参考音频：${target}`);
      console.error('   先跑 python scripts/make-ref-voice.py 生成一个，或用 --set 指定已有文件。');
      process.exitCode = 1;
      return;
    }
    const refText = String(args['ref-text'] || g.refText || '').trim();
    if (!refText) {
      console.error('❌ refText 是空的：参考文本必须与音频逐字一致，用 --ref-text 指定。');
      process.exitCode = 1;
      return;
    }
    const rel = path.relative(ROOT, target).split(path.sep).join('/');
    const before = { refAudio: g.refAudio, refText: g.refText };
    cfg.socialV2 ??= {};
    cfg.socialV2.voice ??= {};
    cfg.socialV2.voice.tts ??= {};
    cfg.socialV2.voice.tts.gptsovits ??= {};
    cfg.socialV2.voice.tts.gptsovits.refAudio = rel;
    cfg.socialV2.voice.tts.gptsovits.refText = refText;
    // 只改这两个键，其余字节尽量原样：先 parse 再 stringify（缩进沿用 2 空格 + 结尾换行）
    const next = `${JSON.stringify(cfg, null, 2)}\n`;
    const check = JSON.parse(next);
    if (JSON.stringify(check) !== JSON.stringify(cfg)) {
      console.error('❌ 回写校验失败（round-trip 不一致），没有写盘');
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(CONFIG_PATH, next);
    console.log('✓ 已切换音色参考：');
    console.log(`   refAudio: ${before.refAudio} → ${rel}`);
    console.log(`   refText : "${refText}"`);
    console.log('   桥接每次发语音都会重新读配置，不用重启；音色服务本身按 tts_infer.yaml 加载权重，与参考音频无关。');
    return;
  }

  const settings = gptsovitsSettings({ ...g, enabled: g.enabled !== false }, { root });
  const text = String(args.text || DEFAULT_TEXT);

  console.log(`音色服务：${settings.baseUrl}`);
  const health = await gptsovitsHealth({ baseUrl: settings.baseUrl, timeoutMs: settings.healthTimeoutMs }).catch(() => ({ ok: false }));
  if (!health.ok) {
    console.error('❌ GPT-SoVITS 服务没起：先跑 scripts/gptsovits-serve.ps1（或 schtasks /run /tn "\\qq-bridge-watchdog"）');
    process.exitCode = 1;
    return;
  }
  const wrong = gptsovitsSettings(settings, { root }).refText;
  if (wrong !== undefined && !String(wrong).trim()) {
    console.error('❌ 配置里的 refText 是空的，零样本克隆必须有参考文本');
    process.exitCode = 1;
    return;
  }

  const candidates = args.candidates
    ? String(args.candidates).split(',').map((s) => path.resolve(ROOT, s.trim())).filter(Boolean)
    : listCandidates();
  if (!candidates.length) {
    console.error('❌ 没有候选参考音频：先跑 python scripts/make-ref-voice.py');
    process.exitCode = 1;
    return;
  }

  console.log(`台词：${text}`);
  console.log(`候选：${candidates.length} 个\n`);

  const results = [];
  for (const ref of candidates) {
    const name = path.basename(ref, path.extname(ref));
    const outPath = path.join(ROOT, 'audio', `audition-${name}.wav`);
    const t0 = Date.now();
    try {
      const r = await synthesizeWithGptSoVits({
        text,
        outPath,
        root,
        settings: { ...settings, refAudio: ref, refText: String(g.refText || '').trim() },
        timeoutMs: Math.max(settings.timeoutMs, 180000)
      });
      const secs = r.bytes / (32000 * 2); // 32kHz / 16bit 单声道估算
      console.log(`  ✅ ${name.padEnd(16)} ${String(r.bytes).padStart(8)} 字节  ~${secs.toFixed(1)}s  ${Date.now() - t0}ms  → ${path.relative(ROOT, outPath)}`);
      results.push({ name, path: outPath, bytes: r.bytes });
    } catch (error) {
      console.error(`  ❌ ${name.padEnd(16)} ${error?.message ?? error}`);
    }
  }

  if (!results.length) {
    console.error('\n全部失败：看一眼 _gptsovits/serve.log');
    process.exitCode = 1;
    return;
  }
  console.log(`\n共 ${results.length} 个可听：`);
  for (const r of results) console.log(`  node scripts/send-voice.mjs send ${path.relative(ROOT, r.path)} private:<QQ号>`);
  console.log('\n选定后切换：node scripts/voice-audition.mjs --set <参考音频>');
}

main().catch((error) => {
  console.error(`❌ ${error?.stack ?? error}`);
  process.exitCode = 1;
});