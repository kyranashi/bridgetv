# -*- coding: utf-8 -*-
"""
BridgeTV — подборки «Видео» без ключа YouTube (с 1.4.0).

  python tools/build_ytfeeds.py        -> data/ytfeeds.json

Берёт официальные RSS-ленты каналов из `TV.yt.feeds` (web/js/services.js — один список на всё),
сливает ленты каждой подборки (свежее первым, без Shorts) и собирает «Популярное за 3 дня» —
свежие ролики всех подборок по числу просмотров. Это замена трендов без ключа API.

Зачем на сервере сборки: в браузере RSS YouTube не читается (CORS), а так подборки
работают везде — на сайте, на ПК, в приложениях. Публикуется на GitHub Pages раз в день
(.github/workflows/pages.yml), в репозиторий не коммитится. Только стандартная библиотека Python.
"""
import io
import json
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "web", "js", "services.js")
OUT = os.path.join(ROOT, "data", "ytfeeds.json")
UA = {"User-Agent": "BridgeTV-feeds/1.4 (+https://github.com/kyranashi/bridgetv)"}
NS = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015",
      "m": "http://search.yahoo.com/mrss/"}
PER_FEED = 40
TREND_DAYS = 3


def feeds_from_js():
    """[{id, chs}] из TV.yt.feeds в services.js"""
    js = io.open(SRC, encoding="utf-8").read()
    block = js[js.index("TV.yt.feeds = ["):]
    block = block[:block.index("];")]
    out = []
    for m in re.finditer(r"\{\s*id:\s*'([\w-]+)'.*?chs:\s*\[(.*?)\]\s*\}", block, re.S):
        chs = re.findall(r"'(UC[\w-]{22})'", m.group(2))
        if chs:
            out.append({"id": m.group(1), "chs": chs})
    return out


def channel(cid):
    req = urllib.request.Request("https://www.youtube.com/feeds/videos.xml?channel_id=" + cid, headers=UA)
    root = ET.fromstring(urllib.request.urlopen(req, timeout=30).read())
    author = root.findtext("a:title", "", NS)
    items = []
    for e in root.findall("a:entry", NS):
        vid = e.findtext("yt:videoId", "", NS)
        link = (e.find("a:link", NS).get("href") if e.find("a:link", NS) is not None else "") or ""
        if not re.match(r"^[\w-]{11}$", vid) or "/shorts/" in link:
            continue
        title = e.findtext("a:title", "", NS)
        if "#shorts" in title.lower():
            continue
        st = e.find("m:group/m:community/m:statistics", NS)
        items.append({"id": vid, "n": title[:200], "sub": author[:80], "ch": cid,
                      "date": e.findtext("a:published", "", NS)[:19],
                      "views": int(st.get("views") or 0) if st is not None else 0})
    return items


def main():
    feeds, data, seen_all = feeds_from_js(), {}, {}
    for f in feeds:
        allv = []
        for cid in f["chs"]:
            try:
                allv += channel(cid)
            except Exception as ex:
                print("  ! %s %s: %s" % (f["id"], cid, ex))
            time.sleep(0.3)
        allv.sort(key=lambda v: v["date"], reverse=True)
        data[f["id"]] = allv[:PER_FEED]
        for v in allv:
            seen_all.setdefault(v["id"], v)
        print("%s: %d" % (f["id"], len(data[f["id"]])))
    # Популярное за 3 дня — свежие ролики всех подборок по просмотрам (кроме трейлеров кино и киностудий)
    since = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - TREND_DAYS * 86400))
    skip = set(v["id"] for k in ("new", "classic") for v in data.get(k, []))
    trend = [v for v in seen_all.values() if v["date"] >= since and v["id"] not in skip]
    trend.sort(key=lambda v: v["views"], reverse=True)
    per_ch, mix = {}, []                      # не больше 4 роликов с одного канала — полка разнообразная
    for v in trend:
        if per_ch.get(v["ch"], 0) < 4:
            per_ch[v["ch"]] = per_ch.get(v["ch"], 0) + 1
            mix.append(v)
    data["trend"] = mix[:PER_FEED]
    if sum(len(v) for v in data.values()) < 20:
        sys.exit("Подборок слишком мало — YouTube не ответил?")
    with io.open(OUT, "w", encoding="utf-8", newline="\n") as fo:
        json.dump({"built": int(time.time()), "feeds": data}, fo, ensure_ascii=False, separators=(",", ":"))
    print("Популярное за %d дня: %d · файл %d КБ" % (TREND_DAYS, len(data["trend"]), os.path.getsize(OUT) // 1024))


if __name__ == "__main__":
    main()
