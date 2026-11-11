# -*- coding: utf-8 -*-
"""
BridgeTV — иконка приложения (с 0.3.0). Оригинальный рисунок, без чужих логотипов и шрифтов:
градиентный квадрат (индиго → бирюза), белая арка «моста» и кнопка Play под ней.

Запуск: python tools/make_icons.py   (нужен Pillow)
Создаёт все размеры:
  ios/res/Icon-*.png            — iOS (29, 40, 60, 76 в @1x/@2x/@3x)
  web/img/icon-152.png, icon-192.png, icon-512.png, icon-maskable-512.png, favicon-32.png
  android/app/src/main/res/mipmap-*/ic_launcher.png и drawable-xhdpi/banner.png (Android TV)
  desktop/build/icon.png (256) и icon.ico — Windows
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024
C1, C2 = (79, 70, 229), (20, 184, 166)       # индиго -> бирюза
BG = (11, 14, 20)


def master(rounded=True, pad=0.0):
    """Иконка 1024×1024. pad — отступ (для «маскируемой» иконки Android/PWA)."""
    grad = Image.new("RGB", (S, S))
    px = grad.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2.0 * S)
            px[x, y] = tuple(int(C1[i] * (1 - t) + C2[i] * t) for i in range(3))
    img = grad.convert("RGBA")
    d = ImageDraw.Draw(img)
    # мягкий блик сверху
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse((-S * 0.3, -S * 0.75, S * 1.3, S * 0.45), fill=(255, 255, 255, 34))
    img = Image.alpha_composite(img, glow)
    d = ImageDraw.Draw(img)
    k = 1.0 - pad * 2
    cx, cy = S / 2, S / 2

    def sc(v):
        return cx + (v - cx) * k

    # экран телевизора
    w = int(S * 0.05 * k)
    d.rounded_rectangle((sc(S * 0.17), sc(S * 0.22), sc(S * 0.83), sc(S * 0.68)), radius=int(S * 0.07 * k), outline=(255, 255, 255, 255), width=w)
    # кнопка Play на экране
    tri = [(sc(S * 0.43), sc(S * 0.33)), (sc(S * 0.43), sc(S * 0.57)), (sc(S * 0.63), sc(S * 0.45))]
    d.polygon(tri, fill=(255, 255, 255, 255))
    # подставка-«мост»: арка между двумя опорами под экраном
    d.arc((sc(S * 0.30), sc(S * 0.70), sc(S * 0.70), sc(S * 1.02)), 200, 340, fill=(255, 255, 255, 235), width=int(w * 0.8))
    for x in (0.33, 0.67):
        d.line((sc(S * x), sc(S * 0.74), sc(S * x), sc(S * 0.83)), fill=(255, 255, 255, 235), width=int(w * 0.7))
    if rounded:
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=255)
        img.putalpha(mask)
    return img


def save(img, size, *path):
    p = os.path.join(ROOT, *path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    img.resize((size, size), Image.LANCZOS).save(p, optimize=True)


def main():
    sq = master(rounded=False)            # iOS сам скругляет углы — отдаём квадрат без прозрачности
    rd = master(rounded=True)
    mk = master(rounded=False, pad=0.12)  # маскируемая: рисунок с полями
    ios = {"Icon-29.png": 29, "Icon-29@2x.png": 58, "Icon-40.png": 40, "Icon-40@2x.png": 80, "Icon-60.png": 60,
           "Icon-60@2x.png": 120, "Icon-60@3x.png": 180, "Icon-76.png": 76, "Icon-76@2x.png": 152}
    flat = sq.convert("RGB")
    for name, size in ios.items():
        save(flat, size, "ios", "res", name)
    save(rd, 152, "web", "img", "icon-152.png")
    save(rd, 192, "web", "img", "icon-192.png")
    save(rd, 512, "web", "img", "icon-512.png")
    save(mk, 512, "web", "img", "icon-maskable-512.png")
    save(rd, 32, "web", "img", "favicon-32.png")
    for d, sz in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        save(rd, sz, "android", "app", "src", "main", "res", "mipmap-" + d, "ic_launcher.png")
    # баннер Android TV 320×180
    b = Image.new("RGBA", (320, 180), BG + (255,))
    ic = rd.resize((116, 116), Image.LANCZOS)
    b.paste(ic, (22, 32), ic)
    dr = ImageDraw.Draw(b)
    font = None
    for f in ("C:/Windows/Fonts/segoeuib.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        if os.path.exists(f):
            font = ImageFont.truetype(f, 32); break
    dr.text((150, 70), "BridgeTV", fill=(232, 236, 243, 255), font=font or ImageFont.load_default())
    os.makedirs(os.path.join(ROOT, "android", "app", "src", "main", "res", "drawable-xhdpi"), exist_ok=True)
    b.save(os.path.join(ROOT, "android", "app", "src", "main", "res", "drawable-xhdpi", "banner.png"), optimize=True)
    # Windows
    os.makedirs(os.path.join(ROOT, "desktop", "build"), exist_ok=True)
    save(rd, 256, "desktop", "build", "icon.png")
    rd.save(os.path.join(ROOT, "desktop", "build", "icon.ico"), sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("OK: icons generated")


if __name__ == "__main__":
    main()
