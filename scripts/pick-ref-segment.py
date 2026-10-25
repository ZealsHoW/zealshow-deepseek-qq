# -*- coding: utf-8 -*-
"""从一段长录音里挑出「音色参考片段」的候选：句子级转写 + 按标点边界切片。

为什么要有这个脚本（2026-10-25，主人丢来 sound\\小鲸.wav 说「就用这个当音色」）：
GPT-SoVITS 的参考音频要 3~10 秒、干净人声、并且配一段逐字文本 —— 113 秒的录音
整段丢进去不行，凭听感随手切也不行（切到一半的词，逐字文本就对不上，克隆出来会
吞字、改调）。所以先用 funasr 把每句话的起止时间转出来，再按句子边界切候选，
最后用 scripts/voice-probe.mjs 逐条合成同一句探针，量哪条的 F0 / 频谱质心
最贴近源片段，选那条。

用法：
  python scripts/pick-ref-segment.py --audio ../sound/小鲸.wav
  python scripts/pick-ref-segment.py --audio ../sound/小鲸.wav --out-dir audio/cand \
      --min-seconds 4 --max-seconds 10 --max-segments 8

产物（默认 audio/cand/）：
  sentences.json            每句 {start, end, text}（秒 + 原文）
  seg-<序号>-<起>-<止>.wav  候选片段，32 kHz / 单声道 / pcm_s16le，已过清洗链

依赖：funasr（本机装在 _gptsovits/env 里）+ ffmpeg（路径默认取 config.json 的
socialV2.voice.ffmpegPath）。首次跑要下模型，用 HF 镜像能快些：
  $env:HF_ENDPOINT='https://hf-mirror.com'; $env:HF_HOME='../_hf-cache'
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

# 清洗链有讲究（2026-10-25 主人听完三条样音的评价：「都有杂音，感觉有回声」）。
# 旧链是「高通 → 压缩 → 限幅 → loudnorm」，压缩和限幅把句子之间的底噪、房间混响
# 尾巴一起抬了起来 —— 克隆时 GPT-SoVITS 会把这些也学进去，听感就是「回声 / 杂音」。
# 所以默认改成 gentle：只去隆隆声 + 温和降噪 + 剪掉首尾静音，不做任何动态处理，
# 也不动整体增益（参考音频响度不影响克隆结果，但动态处理会改变音色）。
CLEAN_CHAINS = {
    # 默认：保留原始动态，只做最小干预
    'gentle': (
        'highpass=f=70,'
        'afftdn=nr=6:nf=-55,'
        'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,'
        'areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse'
    ),
    # 什么都不做（素材本身已经很干净时首选，少处理一层少一种失真）
    'off': 'anull',
    # 老链，只为了复现历史音色样本
    'legacy': (
        'highpass=f=70,'
        'acompressor=threshold=-18dB:ratio=2.5:attack=8:release=120,'
        'alimiter=limit=0.70,'
        'loudnorm=I=-17:TP=-3:LRA=9'
    ),
}


def clean_chain(name):
    if name not in CLEAN_CHAINS:
        sys.exit('不认识的清洗链：%s（可选 %s）' % (name, ' / '.join(CLEAN_CHAINS)))
    return CLEAN_CHAINS[name]


def pitch_filter(semitones, sample_rate=32000):
    """参考音频升/降调：改采样率再拉回时长，音高平移 N 个半音、时长不变。

    2026-10-25：主人听完小鲸 A/B 两版说「B 的方向」（B = 参考升 1 个半音，F0 307 → 334）。
    参考音频的音高会原封不动带进克隆结果，所以「音色偏暗/偏飘」时挪参考比自己通嗓快。
    注意：一次别超过 ±2 个半音 —— 变调同时改共振峰，降多了吐字会糊（实测 −3 就把
    「主人」听成「主任」），这是削音色不是修音色。

    坑：`asetrate` 用的是**输入**的采样率。原始录音常是 44.1 kHz，如果直接写
    `asetrate=32000*R`，ffmpeg 会把 44.1k 的样点当成 33.9k 播 → 整段变慢 1.3 倍、
    音高也掉下去（2026-10-25 实测：想要 +1 半音，结果 F0 294 → 226、6.55s 变 9.0s）。
    所以先在前面补一次 `aresample=32000`，把速率对齐再变调。
    """
    if not semitones:
        return ''
    ratio = 2 ** (float(semitones) / 12.0)
    return ('aresample=%d,asetrate=%d*%.6f,aresample=%d,atempo=%.6f,'
            % (sample_rate, sample_rate, ratio, sample_rate, 1.0 / ratio))


def load_config(root):
    path = os.path.join(root, 'config.json')
    if not os.path.exists(path):
        return {}
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def resolve_ffmpeg(root, explicit):
    if explicit:
        return explicit
    cfg = load_config(root)
    voice = ((cfg.get('socialV2') or {}).get('voice') or {})
    if voice.get('ffmpegPath'):
        p = voice['ffmpegPath']
        return p if os.path.isabs(p) else os.path.abspath(os.path.join(root, p))
    found = shutil.which('ffmpeg')
    if found:
        return found
    sys.exit('找不到 ffmpeg：用 --ffmpeg 指定，或在 config.json 里配 socialV2.voice.ffmpegPath')


def transcribe_sentences(audio):
    """返回 [{start, end, text}]，时间单位秒。"""
    try:
        from funasr import AutoModel
    except Exception as e:
        sys.exit(f'没装 funasr：{e}（本机用 _gptsovits/env/Scripts/python.exe 跑）')
    model = AutoModel(model='paraformer-zh', vad_model='fsmn-vad', punc_model='ct-punc',
                      hub='hf', disable_update=True)
    r = model.generate(input=audio, batch_size_s=60, sentence_timestamp=True)
    info = (r[0].get('sentence_info') if r else None) or []
    out = []
    for s in info:
        text = (s.get('text') or '').strip()
        if not text:
            continue
        out.append({'start': round(s['start'] / 1000.0, 3), 'end': round(s['end'] / 1000.0, 3), 'text': text})
    return out


def merge_sentences(sentences, max_seconds, gap_seconds=0.6):
    """把太短的句子按「相邻且间隔不大」合并成 4~10 秒的候选。"""
    merged = []
    for s in sentences:
        if merged and (s['end'] - merged[-1]['start']) <= max_seconds and (s['start'] - merged[-1]['end']) <= gap_seconds:
            merged[-1]['end'] = s['end']
            merged[-1]['text'] += s['text']
        else:
            merged.append(dict(s))
    return merged


def safe_name(seconds):
    return ('%.2f' % seconds).replace('.', 'p')


def slice_audio(ffmpeg, audio, start, end, out_path, chain='gentle', pitch=0.0):
    dur = max(0.1, end - start)
    af = pitch_filter(pitch) + clean_chain(chain)
    cmd = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
           '-ss', '%.3f' % start, '-t', '%.3f' % dur, '-i', audio,
           '-af', af, '-ar', '32000', '-ac', '1', '-c:a', 'pcm_s16le', out_path]
    subprocess.run(cmd, check=True)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap = argparse.ArgumentParser(description='从长录音里切出音色参考片段候选')
    ap.add_argument('--audio', required=True, help='源录音（wav/mp3/mp4 都行，ffmpeg 能解的）')
    ap.add_argument('--out-dir', default=os.path.join(root, 'audio', 'cand'))
    ap.add_argument('--ffmpeg', default=None)
    ap.add_argument('--min-seconds', type=float, default=4.0, help='候选最短时长')
    ap.add_argument('--max-seconds', type=float, default=10.0, help='候选最长时长（GPT-SoVITS 最好别超过 10 秒）')
    ap.add_argument('--max-segments', type=int, default=8)
    ap.add_argument('--clean', default='gentle', choices=list(CLEAN_CHAINS),
                    help='清洗链：gentle（默认，只去隆隆声+轻降噪+剪静音）/ off（不处理）/ legacy（老链，带压缩和 loudnorm）')
    ap.add_argument('--no-slice', action='store_true', help='只打印句子，不切音频')
    ap.add_argument('--pitch', type=float, default=0.0,
                    help='对切出来的候选升/降调几个半音（默认 0；±1~2 之内，降多了吐字会糊）')
    args = ap.parse_args()

    audio = args.audio if os.path.isabs(args.audio) else os.path.abspath(args.audio)
    if not os.path.exists(audio):
        sys.exit(f'找不到音频：{audio}')
    ffmpeg = None if args.no_slice else resolve_ffmpeg(root, args.ffmpeg)
    os.makedirs(args.out_dir, exist_ok=True)

    print(f'转写中：{audio}')
    sentences = transcribe_sentences(audio)
    if not sentences:
        sys.exit('一句话都没转出来：检查音频是否有人声 / 模型是否下载完整')
    print(f'句子 {len(sentences)} 句，共 {sum(len(s["text"]) for s in sentences)} 字')

    cands = [s for s in merge_sentences(sentences, args.max_seconds)
             if args.min_seconds <= (s['end'] - s['start']) <= args.max_seconds]
    if not cands:
        cands = sorted(sentences, key=lambda s: -(s['end'] - s['start']))[:args.max_segments]
        print('⚠️ 没有落进时长方框的句子，退回按「最长」取')
    cands = cands[:args.max_segments]

    manifest = []
    for i, s in enumerate(cands, 1):
        item = {'index': i, 'start': s['start'], 'end': s['end'], 'text': s['text']}
        if args.pitch:
            item['pitch'] = args.pitch
        if not args.no_slice:
            suffix = ('-p%s' % ('%.1f' % args.pitch).replace('.0', '').replace('-', 'm')) if args.pitch else ''
            name = 'seg-%02d-%s-%s%s.wav' % (i, safe_name(s['start']), safe_name(s['end']), suffix)
            out = os.path.join(args.out_dir, name)
            slice_audio(ffmpeg, audio, s['start'], s['end'], out, args.clean, args.pitch)
            item['file'] = os.path.join(args.out_dir, name)
            item['bytes'] = os.path.getsize(out)
        manifest.append(item)
        print('[%d] %6.2f → %6.2f (%4.2fs) %s' % (i, s['start'], s['end'], s['end'] - s['start'], s['text']))

    path = os.path.join(args.out_dir, 'sentences.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'audio': audio, 'sentences': sentences, 'candidates': manifest}, f, ensure_ascii=False, indent=1)
    print(f'已写出：{path}')
    print('下一步：用 scripts/voice-probe.mjs --ref <候选> --ref-text "<对应文本>" 逐条合成同一句探针，')
    print('        量中位 F0 / 频谱质心跟源片段比，选最贴近、且 ASR 完整的那条。')


if __name__ == '__main__':
    main()