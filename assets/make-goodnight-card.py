from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

# 路径都从本文件的位置推导，可以用环境变量覆盖。
# （原来这里写死了作者本机的绝对路径 —— 那种东西一进公开仓库就是永久记录，改不回。）
HERE = os.path.dirname(os.path.abspath(__file__))
OUTBOX = os.path.normpath(os.path.join(HERE, '..', 'state', 'outbox'))
SRC = os.environ.get('GOODNIGHT_SRC', os.path.join(OUTBOX, 'whale-src.png'))
OUT = os.environ.get('GOODNIGHT_OUT', os.path.join(OUTBOX, 'goodnight-whale.png'))
FONT = os.environ.get('GOODNIGHT_FONT', os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts', 'msyhbd.ttc'))

W, H = 760, 700
top, bot = (10, 20, 48), (34, 70, 136)
bg = Image.new("RGB", (1, H))
for y in range(H):
    t = y / (H - 1)
    bg.putpixel((0, y), tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
canvas = bg.resize((W, H)).convert("RGBA")
d = ImageDraw.Draw(canvas, "RGBA")

import random
rnd = random.Random(20261023)
for _ in range(170):
    x, y = rnd.randint(4, W - 4), rnd.randint(4, int(H * 0.68))
    r = rnd.choice([1, 1, 1, 2])
    a = rnd.randint(70, 230)
    d.ellipse([x, y, x + r, y + r], fill=(255, 255, 255, a))

d.ellipse([W - 132, 34, W - 62, 104], fill=(255, 243, 205, 240))
d.ellipse([W - 150, 22, W - 80, 92], fill=(14, 26, 58, 255))

# 角色卡片：圆角 + 细边框 + 投影，让原图的深色底看起来是刻意的取景
char = Image.open(SRC).convert("RGBA")
dw = 500
dh = round(dw * char.height / char.width)
char = char.resize((dw, dh), Image.LANCZOS)
cx, cy = (W - dw) // 2, 66
radius = 26

mask = Image.new("L", (dw, dh), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, dw - 1, dh - 1], radius=radius, fill=255)
card = Image.new("RGBA", (dw, dh), (0, 0, 0, 0))
card.paste(char, (0, 0), mask)

# 投影
shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.rounded_rectangle([cx + 6, cy + 10, cx + dw + 6, cy + dh + 10], radius=radius, fill=(0, 0, 0, 160))
shadow = shadow.filter(ImageFilter.GaussianBlur(16))
canvas = Image.alpha_composite(canvas, shadow)

# 背后柔光
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(glow).rounded_rectangle([cx - 18, cy - 18, cx + dw + 18, cy + dh + 18], radius=radius + 14, fill=(120, 190, 255, 55))
glow = glow.filter(ImageFilter.GaussianBlur(22))
canvas = Image.alpha_composite(canvas, glow)
canvas.alpha_composite(card, (cx, cy))

d = ImageDraw.Draw(canvas, "RGBA")
d.rounded_rectangle([cx, cy, cx + dw - 1, cy + dh - 1], radius=radius, outline=(150, 200, 255, 190), width=2)

text = "爸爸妈妈晚安"
font = ImageFont.truetype(FONT, 62)
bbox = d.textbbox((0, 0), text, font=font)
tx = (W - (bbox[2] - bbox[0])) / 2
ty = H - 196

glow2 = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ImageDraw.Draw(glow2).text((tx, ty), text, font=font, fill=(150, 210, 255, 210))
glow2 = glow2.filter(ImageFilter.GaussianBlur(11))
canvas = Image.alpha_composite(canvas, glow2)
d = ImageDraw.Draw(canvas, "RGBA")
d.text((tx + 3, ty + 3), text, font=font, fill=(0, 0, 0, 170))
d.text((tx, ty), text, font=font, fill=(240, 248, 255, 255))

hx, hy, s = W / 2, H - 66, 9
d.polygon([(hx, hy + s * 1.6), (hx - s * 2.0, hy - s * 0.1), (hx - s * 1.2, hy - s * 1.5),
           (hx, hy - s * 0.4), (hx + s * 1.2, hy - s * 1.5), (hx + s * 2.0, hy - s * 0.1)],
          fill=(255, 122, 152, 235))

canvas.convert("RGB").save(OUT, "PNG", optimize=True)
print("saved", OUT)
