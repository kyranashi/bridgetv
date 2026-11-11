# -*- coding: utf-8 -*-
"""
BridgeTV — экраны запуска iOS под все устройства (с 0.2.5).

Зачем: iOS показывает приложение на весь экран, только если у него есть экран запуска под
размер устройства. Без него на новых iPhone/iPad приложение открывается «в рамке» (чёрные полосы).
  • iOS 9–13 смотрят на картинки UILaunchImages (их делает этот скрипт);
  • iOS 14+ — на ключ UILaunchScreen в Info.plist (он уже есть, картинки не нужны).

Картинка: тёмный фон приложения и иконка по центру.
Запуск: python tools/make_launch_images.py   (нужен Pillow: pip install pillow)
Результат: ios/res/Default-*.png — список имён совпадает с UILaunchImages в ios/res/Info.plist.
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "ios", "res")
ICON = os.path.join(ROOT, "web", "img", "icon-152.png")
BG = (11, 14, 20, 255)

# имя файла -> размер в пикселях (портрет). Имена — как в UILaunchImages
IMAGES = {
    # iPhone X / XS / 11 Pro (375×812 pt @3x)
    "Default-812h@3x.png": (1125, 2436),
    # iPhone XR / 11 (414×896 pt @2x) и XS Max / 11 Pro Max (@3x)
    "Default-896h@2x.png": (828, 1792),
    "Default-896h@3x.png": (1242, 2688),
    # iPhone 12/13/14 (390×844 @3x), 12/13 Pro Max (428×926 @3x), 14 Pro (393×852), 14 Pro Max (430×932)
    "Default-844h@3x.png": (1170, 2532),
    "Default-926h@3x.png": (1284, 2778),
    "Default-852h@3x.png": (1179, 2556),
    "Default-932h@3x.png": (1290, 2796),
    # iPad Pro 10.5 (834×1112 @2x), iPad Pro 11 (834×1194 @2x), iPad Pro 12.9 (1024×1366 @2x)
    "Default-Portrait-1112h@2x~ipad.png": (1668, 2224),
    "Default-Portrait-1194h@2x~ipad.png": (1668, 2388),
    "Default-Portrait-1366h@2x~ipad.png": (2048, 2732),
    # iPad 10.2 (810×1080 @2x), iPad Air 4/5 (820×1180 @2x), iPad mini 6 (744×1133 @2x)
    "Default-Portrait-1080h@2x~ipad.png": (1620, 2160),
    "Default-Portrait-1180h@2x~ipad.png": (1640, 2360),
    "Default-Portrait-1133h@2x~ipad.png": (1488, 2266),
}


def main():
    icon = Image.open(ICON).convert("RGBA")
    for name, (w, h) in IMAGES.items():
        im = Image.new("RGBA", (w, h), BG)
        side = int(min(w, h) * 0.22)
        ic = icon.resize((side, side), Image.LANCZOS)
        im.paste(ic, ((w - side) // 2, (h - side) // 2), ic)
        im.convert("RGB").save(os.path.join(RES, name), "PNG", optimize=True)
    print("OK: %d launch images" % len(IMAGES))


if __name__ == "__main__":
    main()
