#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用 Edge TTS（微软在线语音）生成「参考音色」wav，喂给 GPT-SoVITS 做零样本音色克隆。

为什么需要它：GPT-SoVITS 是零样本克隆，音色完全由 `refAudio` + `refText` 决定。
机器自带的 SAPI 参考（audio/ref/sapi-ref.wav）是合成音，克隆出来也是机器味；
用 Edge TTS 的自然女声做参考，等于「借一个干净的嗓子」，克隆结果自然得多，
而且不用等主人录样本。

用法（在 qq-bridge 目录下）：
  python scripts/make-ref-voice.py --list
  python scripts/make-ref-voice.py                     # 默认 xiaoyi → audio/ref/edge-xiaoyi.wav
  python scripts/make-ref-voice.py --voice zh-CN-XiaoxiaoNeural --out audio/ref/edge-xiaoxiao.wav
  python scripts/make-ref-voice.py --text "自定义参考文本" --out audio/ref/自定义.wav

注意：
  - 参考文本必须和参考音频**逐字一致**（GPT-SoVITS 靠它对齐音素），改 --text 就要同时
    改 config.json 的 `socialV2.voice.gptsovits.refText`。
  - 需要联网（Edge TTS 走微软的在线合成），并且装好 edge-tts：
    uv pip install --python _gptsovits/env/Scripts/python.exe edge-tts
  - 输出统一转成 32kHz / 16bit / 单声道 wav —— GPT-SoVITS 的参考音频按这个规格最省事。
"""
import argparse
import asyncio
import os
import shutil
import subprocess
import sys
import tempfile
import wave

# Windows 控制台默认 GBK，打印 ✓ / → 这类字符会炸；统一按 UTF-8 输出（替换不了的降级成 ?）
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# 默认参考文本：和 config.json 里 socialV2.voice.gptsovits.refText 保持一致
DEFAULT_TEXT = '主人，我是小鲸鱼。今天晚上天气有点凉，你记得多穿一件衣服再出门呀。'
DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'   # 年轻女声，语气活泼，最像「小鲸鱼」
DEFAULT_OUT = os.path.join('audio', 'ref', 'edge-xiaoyi.wav')


def find_ffmpeg():
    """找 ffmpeg：环境变量 → 本机 GPT-SoVITS 自带 → PATH。"""
    cand = []
    if os.environ.get('FFMPEG_PATH'):
        cand.append(os.environ['FFMPEG_PATH'])
    gsv = os.environ.get('GPTSOVITS_DIR') or r'D:\34825\zhuomian\youqq\_gptsovits'
    cand.append(os.path.join(gsv, 'ffmpeg', 'ffmpeg-master-latest-win64-gpl-shared', 'bin', 'ffmpeg.exe'))
    for c in cand:
        if os.path.isfile(c):
            return c
    found = shutil.which('ffmpeg')
    if found:
        return found
    return None


async def list_voices():
    import edge_tts
    voices = await edge_tts.list_voices()
    zh = [v for v in voices if v['Locale'].startswith('zh-CN')]
    print(f'zh-CN 共 {len(zh)} 个：')
    for v in zh:
        gender = {'Female': '女', 'Male': '男'}.get(v['Gender'], v['Gender'])
        print(f"  {v['ShortName']:<40} {gender}  {v.get('FriendlyName', '')}")


async def synth(text, voice, rate, mp3_path):
    import edge_tts
    comm = edge_tts.Communicate(text, voice, rate=rate)
    await comm.save(mp3_path)


def to_wav(ffmpeg, src, dst, sr=32000):
    cmd = [ffmpeg, '-y', '-loglevel', 'error', '-i', src,
           '-ac', '1', '-ar', str(sr), '-sample_fmt', 's16', dst]
    subprocess.run(cmd, check=True)


def wav_info(path):
    with wave.open(path, 'rb') as w:
        return w.getframerate(), w.getnchannels(), w.getnframes(), w.getnframes() / float(w.getframerate())


def main():
    ap = argparse.ArgumentParser(description='用 Edge TTS 生成 GPT-SoVITS 的参考音色 wav')
    ap.add_argument('--list', action='store_true', help='列出可用的 zh-CN 音色后退出')
    ap.add_argument('--voice', default=DEFAULT_VOICE, help=f'Edge 音色 ShortName（默认 {DEFAULT_VOICE}）')
    ap.add_argument('--text', default=DEFAULT_TEXT, help='参考文本（必须与音频逐字一致，且要同步改 config.json 的 refText）')
    ap.add_argument('--out', default=DEFAULT_OUT, help=f'输出 wav（默认 {DEFAULT_OUT}）')
    ap.add_argument('--rate', default='+0%', help='语速，如 +5%% / -5%%（默认 +0%%）')
    args = ap.parse_args()

    if args.list:
        asyncio.run(list_voices())
        return 0

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        print('✗ 找不到 ffmpeg：装一个，或用环境变量 FFMPEG_PATH 指过去', file=sys.stderr)
        return 1

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        mp3 = os.path.join(tmp, 'ref.mp3')
        print(f'→ Edge TTS 合成（{args.voice}）…')
        try:
            asyncio.run(synth(args.text, args.voice, args.rate, mp3))
        except Exception as e:  # noqa: BLE001 — 网络/音色名错误都归这里，给一句人话提示
            print(f'✗ Edge TTS 合成失败：{e}', file=sys.stderr)
            print('  常见原因：没网 / 音色名拼错（用 --list 查）/ Edge 服务被墙', file=sys.stderr)
            return 1
        if not os.path.isfile(mp3) or os.path.getsize(mp3) < 1024:
            print('✗ Edge TTS 没产出音频（多半是被网络拦了）', file=sys.stderr)
            return 1
        to_wav(ffmpeg, mp3, out)

    sr, ch, frames, secs = wav_info(out)
    print(f'✓ 已生成 {out}')
    print(f'  {frames} 帧 / {secs:.1f} 秒 / {sr}Hz / {ch} 声道 / {os.path.getsize(out)} 字节')
    print('  下一步：把 config.json 的 socialV2.voice.gptsovits.refAudio 指到这个文件，')
    print('          同时确认 refText 与上面 --text 一字不差，然后重启音色服务。')
    return 0


if __name__ == '__main__':
    sys.exit(main())