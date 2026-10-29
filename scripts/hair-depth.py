#!/usr/bin/env python
"""只把「头发」压深一点，其它地方不动。

主人 2026-10-29 的原话：身体周围颜色淡淡的就好，但是头发深一点。

做法：HSV 里挑蓝色相（默认 185°~265°）且有一定饱和度的像素做掩膜，
掩膜做一次高斯羽化（避免发丝边缘出现硬边），只对掩膜内的像素加深：
  S × 1.12、V × 0.86  —— 更浓、更暗一点点。
皮肤、白衣、白底、暖色装饰都不在掩膜内，所以「周围」保持淡。

用法：
  python hair-depth.py <图> [--strength 1.0] [--hue-min 185] [--hue-max 265]
原地改写（先写 .tmp 再替换），任何异常都非零退出，调用方当作「没做」即可。
"""
import argparse
import os
import sys

try:
    import numpy as np
    from PIL import Image, ImageFilter
except Exception as exc:  # noqa: BLE001 - 缺库就安静失败
    sys.stderr.write(f'hair-depth: 缺依赖 {exc}\n')
    sys.exit(2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--strength', type=float, default=1.0)
    ap.add_argument('--hue-min', type=float, default=185.0)
    ap.add_argument('--hue-max', type=float, default=265.0)
    args = ap.parse_args()

    strength = max(0.0, min(2.0, float(args.strength)))
    if strength <= 0.01:
        return 0

    src = args.image
    im = Image.open(src).convert('RGB')
    # 掩膜在缩小的图上算（省时间，边缘本来就要羽化）
    small = im.resize((max(1, im.width // 4), max(1, im.height // 4)), Image.BILINEAR)
    hsv = np.asarray(small.convert('HSV'), dtype=np.float32)
    h = hsv[:, :, 0] * 360.0 / 255.0
    s = hsv[:, :, 1] / 255.0
    v = hsv[:, :, 2] / 255.0

    # 蓝色相区间（环绕处理：hue 0~360 不连续，这里两段取或）
    if args.hue_min <= args.hue_max:
        in_hue = (h >= args.hue_min) & (h <= args.hue_max)
    else:
        in_hue = (h >= args.hue_min) | (h <= args.hue_max)
    mask = in_hue & (s > 0.22) & (v > 0.10)
    feather = max(1, min(small.width, small.height) // 120)
    m = Image.fromarray((mask.astype(np.uint8) * 255)).filter(ImageFilter.GaussianBlur(feather))
    m = m.resize(im.size, Image.BILINEAR)
    alpha = (np.asarray(m, dtype=np.float32) / 255.0)[:, :, None]

    base = np.asarray(im, dtype=np.float32)
    deep_hsv = np.asarray(im.convert('HSV'), dtype=np.float32)
    deep_hsv[:, :, 1] = np.clip(deep_hsv[:, :, 1] * (1.0 + 0.12 * strength), 0, 255)
    deep_hsv[:, :, 2] = np.clip(deep_hsv[:, :, 2] * (1.0 - 0.14 * strength), 0, 255)
    deep = np.asarray(Image.fromarray(deep_hsv.astype(np.uint8), 'HSV').convert('RGB'), dtype=np.float32)

    out = base * (1.0 - alpha) + deep * alpha
    tmp = src + '.hair.tmp.png'
    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(tmp, 'PNG')
    os.replace(tmp, src)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f'hair-depth: {exc}\n')
        sys.exit(1)