# -*- coding: utf-8 -*-
"""
BridgeTV — пакеты для остальных платформ (с 0.2.5). Только стандартная библиотека Python.

  python tools/package.py [версия]     -> dist/

  BridgeTV-<v>-web.zip    — веб-версия для любого ПК/ноутбука/телефона: распаковать и запустить
                            start-windows.bat (или start-mac-linux.sh) — откроется в браузере;
                            тот же сервер раздаёт приложение на iPad/телевизор по Wi‑Fi.
  BridgeTV-<v>-tizen.wgt  — Samsung Smart TV (Tizen 2.3+, 2015+). Пакет НЕ подписан: перед
                            установкой подпишите своим сертификатом в Tizen Studio (docs/SMART_TV.md).
  BridgeTV-<v>-webos.ipk  — LG Smart TV (webOS 3+). Установка: режим разработчика + ares-install
                            (docs/SMART_TV.md). Экспериментально.

APK и IPA собирают отдельные workflow (android.yml, ios.yml).
"""
import io
import json
import os
import shutil
import sys
import tarfile
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
APP_ID = "com.kyranashi.bridgetv"
TIZEN_PKG = "BrdgTV0001"           # 10 символов, как требует Tizen


def app_files():
    """(путь в пакете, путь на диске): web/ целиком + каталог и иконки каналов"""
    out = []
    for base, sub in (("web", "web"),):
        for dp, dn, fn in os.walk(os.path.join(ROOT, base)):
            for f in fn:
                full = os.path.join(dp, f)
                out.append((os.path.relpath(full, ROOT).replace("\\", "/"), full))
    out.append(("data/catalog.js", os.path.join(ROOT, "data", "catalog.js")))
    logos = os.path.join(ROOT, "data", "logos")
    if os.path.isdir(logos):
        for f in sorted(os.listdir(logos)):
            out.append(("data/logos/" + f, os.path.join(logos, f)))
    return out


REDIRECT = ('<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>BridgeTV</title>'
            '<meta http-equiv="refresh" content="0; url=web/index.html"></head>'
            '<body style="background:#0b0e14"><a href="web/index.html">BridgeTV</a></body></html>')

START_BAT = r"""@echo off
chcp 65001 >nul
rem BridgeTV — запуск на Windows. Нужен Python 3 (python.org или Microsoft Store).
cd /d "%~dp0"
start "" http://localhost:8080/web/
python tools\serve.py --port 8080
if errorlevel 1 py tools\serve.py --port 8080
pause
"""
START_SH = """#!/bin/sh
# BridgeTV — запуск на macOS / Linux. Нужен Python 3.
cd "$(dirname "$0")"
( sleep 1; (xdg-open http://localhost:8080/web/ || open http://localhost:8080/web/) >/dev/null 2>&1 ) &
python3 tools/serve.py --port 8080
"""
README_WEB = """BridgeTV — веб-версия
=====================

Windows: запустите start-windows.bat (нужен Python 3: https://www.python.org — при установке отметьте "Add to PATH").
macOS / Linux: sh start-mac-linux.sh

Откроется браузер с BridgeTV. В окне сервера будут адреса вида http://192.168.x.x:8080/web/ —
по ним приложение открывается на iPad, телефоне, Smart TV в той же сети Wi-Fi.
Свои фильмы: python tools/serve.py --media "D:\\Фильмы"

Можно и без сервера: откройте index.html двойным щелчком (не будут работать обновление каталога и фильмы с ПК).
Подробно: https://github.com/kyranashi/bridgetv
"""


def build_web(v):
    path = os.path.join(DIST, "BridgeTV-%s-web.zip" % v)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for arc, full in app_files():
            z.write(full, "BridgeTV/" + arc)
        z.writestr("BridgeTV/index.html", REDIRECT)
        z.write(os.path.join(ROOT, "tools", "serve.py"), "BridgeTV/tools/serve.py")
        z.writestr("BridgeTV/start-windows.bat", START_BAT.replace("\n", "\r\n"))
        zi = zipfile.ZipInfo("BridgeTV/start-mac-linux.sh"); zi.external_attr = 0o755 << 16
        z.writestr(zi, START_SH)
        z.writestr("BridgeTV/README.txt", README_WEB.replace("\n", "\r\n"))
        z.write(os.path.join(ROOT, "LICENSE"), "BridgeTV/LICENSE")
    return path


def build_tizen(v):
    cfg = """<?xml version="1.0" encoding="UTF-8"?>
<!-- BridgeTV для Samsung Smart TV (Tizen). Перед установкой подпишите пакет в Tizen Studio. -->
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets"
        id="https://github.com/kyranashi/bridgetv" version="%s" viewmodes="maximized">
    <tizen:application id="%s.BridgeTV" package="%s" required_version="2.3"/>
    <content src="web/index.html"/>
    <icon src="icon.png"/>
    <name>BridgeTV</name>
    <description>Телеканалы, видео и фильмы для любой техники</description>
    <author href="https://github.com/kyranashi/bridgetv">BridgeTV</author>
    <license>MIT</license>
    <feature name="http://tizen.org/feature/screen.size.all"/>
    <tizen:profile name="tv-samsung"/>
    <access origin="*" subdomains="true"/>
    <tizen:privilege name="http://tizen.org/privilege/internet"/>
    <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>
    <tizen:setting screen-orientation="landscape" context-menu="disable" background-support="disable"
                   encryption="disable" install-location="auto" hwkey-event="enable"/>
</widget>
""" % (v, TIZEN_PKG, TIZEN_PKG)
    path = os.path.join(DIST, "BridgeTV-%s-tizen.wgt" % v)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("config.xml", cfg)
        z.write(os.path.join(ROOT, "web", "img", "icon-152.png"), "icon.png")
        z.writestr("index.html", REDIRECT)
        for arc, full in app_files():
            z.write(full, arc)
    return path


def _ar(members):
    """Архив формата ar (из него состоит .ipk, как .deb)"""
    out = io.BytesIO()
    out.write(b"!<arch>\n")
    now = int(time.time())
    for name, data in members:
        hdr = "%-16s%-12d%-6d%-6d%-8s%-10d`\n" % (name, now, 0, 0, "100644", len(data))
        out.write(hdr.encode("ascii"))
        out.write(data)
        if len(data) % 2:
            out.write(b"\n")
    return out.getvalue()


def _tgz(entries):
    """entries: [(путь в архиве, bytes)] -> .tar.gz (каталоги создаются автоматически)"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.GNU_FORMAT) as t:
        dirs = set()
        for arc, data in entries:
            parts = arc.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                d = "/".join(parts[:i])
                if d and d not in dirs and d != ".":
                    dirs.add(d)
                    ti = tarfile.TarInfo(d); ti.type = tarfile.DIRTYPE; ti.mode = 0o755; ti.mtime = int(time.time())
                    t.addfile(ti)
            ti = tarfile.TarInfo(arc); ti.size = len(data); ti.mode = 0o644; ti.mtime = int(time.time())
            t.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def build_webos(v):
    appdir = "./usr/palm/applications/" + APP_ID + "/"
    info = {"id": APP_ID, "version": v, "vendor": "BridgeTV", "type": "web", "main": "web/index.html",
            "title": "BridgeTV", "icon": "icon.png", "largeIcon": "largeIcon.png", "resolution": "1920x1080",
            "disableBackHistoryAPI": True}
    icon = open(os.path.join(ROOT, "web", "img", "icon-152.png"), "rb").read()
    data = [(appdir + "appinfo.json", json.dumps(info, ensure_ascii=False, indent=2).encode("utf-8")),
            (appdir + "icon.png", icon), (appdir + "largeIcon.png", icon),
            (appdir + "index.html", REDIRECT.encode("utf-8"))]
    size = 0
    for arc, full in app_files():
        b = open(full, "rb").read(); size += len(b)
        data.append((appdir + arc, b))
    pkg = {"app": APP_ID, "id": APP_ID, "loc_name": "BridgeTV", "package_format_version": 2, "vendor": "BridgeTV", "version": v}
    data.append(("./usr/palm/packages/" + APP_ID + "/packageinfo.json", json.dumps(pkg).encode("utf-8")))
    control = ("Package: %s\nVersion: %s\nSection: misc\nPriority: optional\nArchitecture: all\nInstalled-Size: %d\n"
               "Maintainer: BridgeTV <https://github.com/kyranashi/bridgetv>\nDescription: BridgeTV\n"
               "webOS-Package-Format-Version: 2\nwebOS-Packager-Version: 1.0.0\n") % (APP_ID, v, size // 1024 + 1)
    ipk = _ar([("debian-binary", b"2.0\n"), ("control.tar.gz", _tgz([("./control", control.encode("utf-8"))])),
               ("data.tar.gz", _tgz(data))])
    path = os.path.join(DIST, "BridgeTV-%s-webos.ipk" % v)
    open(path, "wb").write(ipk)
    return path


def main():
    v = sys.argv[1] if len(sys.argv) > 1 else "dev"
    if os.path.isdir(DIST):
        shutil.rmtree(DIST)
    os.makedirs(DIST)
    for fn in (build_web, build_tizen, build_webos):
        p = fn(v)
        print("OK %-32s %6d KB" % (os.path.basename(p), os.path.getsize(p) // 1024))


if __name__ == "__main__":
    main()
