#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""让小鲸鱼真的唱一首歌：调 ACE-Step（text-to-song）按歌词生成一段人声+伴奏。

为什么不是 GPT-SoVITS：那是 TTS，只能"说"，没有旋律概念（api_v2.py 里连 sing 相关参数都没有）。
唱歌要一个会写音乐+唱词的模型，ACE-Step 是这里能用上的（8GB 显存，官方支持 --cpu_offload）。

它和音色的关系：ACE-Step 生成的是"随便一个嗓子"唱的歌；要让歌声是小鲸鱼的音色，
再拿这段人声走一次零样本音色转换（Seed-VC 之类）。本脚本只负责生成，--out 就是产物。

用法（在 qq-bridge 目录下，用 _acestep 的 venv python 跑）：
  _acestep/env/Scripts/python.exe scripts/sing.py \
      --tags "chinese pop, female vocal, warm, acoustic" \
      --lyrics "第一句歌词\n第二句歌词" \
      --duration 30 --out audio/sing-demo.wav

参数说明：
  --tags      风格提示（英文更稳）：流派 / 性别 / 情绪 / 乐器
  --lyrics    歌词，用 \n 或 [verse]/[chorus] 分段；也可以 --lyrics-file
  --duration  目标时长（秒），ACE-Step 按它决定段落多少，30~60 比较稳
  --steps     推理步数（默认 24；越高越慢越好听，8GB 机器别超过 40）
  --cpu-offload  8GB 显存的救命开关（默认开）
  --checkpoint-dir  模型目录，默认 ~/.cache/ace-step/checkpoints
"""
import argparse
import os
import sys
import time

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

DEFAULT_TAGS = 'chinese pop, female vocal, warm, gentle, acoustic'
DEFAULT_CKPT = os.path.join(os.path.expanduser('~'), '.cache', 'ace-step', 'checkpoints')


def main():
    ap = argparse.ArgumentParser(description='用 ACE-Step 按歌词生成一首歌')
    ap.add_argument('--lyrics', default='')
    ap.add_argument('--lyrics-file', default='')
    ap.add_argument('--tags', default=DEFAULT_TAGS)
    ap.add_argument('--duration', type=float, default=30.0)
    ap.add_argument('--steps', type=int, default=24)
    ap.add_argument('--seed', type=int, default=-1, help='固定种子可复现；-1 = 随机')
    ap.add_argument('--out', default=os.path.join('audio', 'sing-out.wav'))
    ap.add_argument('--checkpoint-dir', default=os.environ.get('ACESTEP_CHECKPOINT_DIR', DEFAULT_CKPT))
    ap.add_argument('--cpu-offload', type=int, default=1, help='1=开（8GB 显存推荐），0=关')
    ap.add_argument('--overlapped-decode', type=int, default=1)
    args = ap.parse_args()

    lyrics = args.lyrics
    if args.lyrics_file:
        with open(args.lyrics_file, 'r', encoding='utf-8') as f:
            lyrics = f.read()
    lyrics = (lyrics or '').strip()
    if not lyrics:
        print('✗ 没有歌词：用 --lyrics 或 --lyrics-file 给一段', file=sys.stderr)
        return 2
    if not os.path.isdir(args.checkpoint_dir):
        print(f'✗ 找不到模型目录：{args.checkpoint_dir}', file=sys.stderr)
        print('  先下载：https://hf-mirror.com/ACE-Step/ACE-Step-v1-3.5B（约 7.9GB）', file=sys.stderr)
        return 2

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    t0 = time.time()
    print(f'→ 加载 ACE-Step（cpu_offload={bool(args.cpu_offload)}）…', flush=True)
    try:
        from acestep.pipeline_ace_step import ACEStepPipeline
        import torch
    except Exception as e:  # noqa: BLE001
        print(f'✗ import 失败：{e}', file=sys.stderr)
        print('  确认用的是 _acestep/env 里的 python，并且装好了 acestep', file=sys.stderr)
        return 2

    # torchaudio 2.11 起 save() 默认走 torchcodec（我们没装，装它还要 ffmpeg 的 C 库）。
    # 这里把 save 换成 soundfile 后端：ACE-Step 内部就是 torchaudio.save(path, (channels, time), sr)，
    # 而 soundfile 要 (time, channels)，所以转置一下。产物完全一样，还少一个显存外依赖。
    try:
        import torchaudio as _ta
        import soundfile as _sf

        def _save_via_soundfile(filepath, src, sample_rate, **kwargs):
            data = src.detach().cpu().float().numpy() if hasattr(src, 'detach') else src
            if data.ndim == 2:
                data = data.T
            _sf.write(str(filepath), data, int(sample_rate))

        _ta.save = _save_via_soundfile
    except Exception as e:  # noqa: BLE001
        print(f'  ⚠ 没换成 soundfile 后端（{e}），如果一会儿 save 报 torchcodec 就是这个原因', flush=True)

    if torch.cuda.is_available():
        print(f'  GPU: {torch.cuda.get_device_name(0)} / {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f}GB', flush=True)
    else:
        print('  ⚠ 没有可用 CUDA，会在 CPU 上跑（非常慢）', flush=True)

    pipe = ACEStepPipeline(
        checkpoint_dir=args.checkpoint_dir,
        dtype='bfloat16',
        torch_compile=False,
        cpu_offload=bool(args.cpu_offload),
        overlapped_decode=bool(args.overlapped_decode),
    )
    print(f'  模型就绪（{time.time() - t0:.1f}s）', flush=True)

    seeds = None if args.seed < 0 else [args.seed]
    t1 = time.time()
    print(f'→ 生成 {args.duration:.0f}s / {args.steps} 步 …', flush=True)
    pipe(
        prompt=args.tags,
        lyrics=lyrics,
        audio_duration=args.duration,
        infer_step=args.steps,
        manual_seeds=seeds,
        save_path=out,
        format='wav',
        batch_size=1,
    )
    dt = time.time() - t1
    if not os.path.isfile(out):
        print('✗ 生成结束但没有产物文件', file=sys.stderr)
        return 1
    size = os.path.getsize(out)
    total = time.time() - t0
    print(f'✓ 已生成 {out}')
    print(f'  {size} 字节 / 生成耗时 {dt:.1f}s / 总耗时 {total:.1f}s')
    print(f'  想发到 QQ：node scripts/send-voice.mjs send {os.path.relpath(out)} private:<QQ号>')
    return 0


if __name__ == '__main__':
    sys.exit(main())