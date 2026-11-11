# -*- coding: utf-8 -*-
"""
BridgeTV — программа передач (EPG) для каналов России и Беларуси (с 1.0.0).

  python tools/build_epg.py            -> data/epg.json (≈ 0.3–0.6 МБ)

Источник — открытый XMLTV-гид epg.pw (epg_RU, в нём есть и белорусские каналы).
Каналы гида сопоставляются с каталогом по названию (тот же ключ, что при склейке каталога,
без «+2», «+4» — часовых сдвигов). В файл попадает окно «−2 часа … +30 часов» —
приложению этого хватает на «Сейчас / Далее» и программу на сегодня-завтра.

Формат data/epg.json:
  { "built": unix, "src": "epg.pw", "ch": { "<id канала каталога>": [[начало, конец, "название"], …] } }
Время — unix-секунды (UTC). Обновляется раз в день в .github/workflows/pages.yml и
публикуется на GitHub Pages (в репозиторий не коммитится — история не растёт).
Только стандартная библиотека Python.
"""
import gzip
import io
import json
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from calendar import timegm

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_catalog import name_key  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, "data", "catalog.json")
OUT = os.path.join(ROOT, "data", "epg.json")
SOURCES = ["https://epg.pw/xmltv/epg_RU.xml.gz"]
BEFORE, AFTER = 2 * 3600, 30 * 3600
# Названия в гиде, которые отличаются от каталога
ALIAS = {"ствбеларусь": "ств", "матч": "матчтв", "онтбеларусь": "онт"}
MAX_TITLE = 90


def parse_time(s):
    """'20261111000000 +0300' -> unix"""
    m = re.match(r"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})", s or "")
    if not m:
        return None
    y, mo, d, h, mi, se = (int(x) for x in m.groups()[:6])
    off = (int(m.group(8)) * 3600 + int(m.group(9)) * 60) * (1 if m.group(7) == "+" else -1)
    return timegm((y, mo, d, h, mi, se, 0, 0, 0)) - off


def guide_key(name):
    n = re.sub(r"\s*\(?\+\d+\)?\s*$", "", name or "")          # «Россия 1 +4» — сдвиг по часовым поясам
    if n != (name or ""):
        return None
    n = re.sub(r"\b(international|int|europe|европа|hd|fhd|uhd|sd|4k)\b", "", n, flags=re.I)
    k = name_key(n)
    return ALIAS.get(k, k)


def main():
    cat = json.load(io.open(CATALOG, encoding="utf-8"))
    want = {}                                           # ключ имени -> [id каналов каталога]
    for c in cat["channels"]:
        if c.get("r") in ("ru", "by"):
            want.setdefault(name_key(c["n"]), []).append(c["id"])
    now = int(time.time())
    lo, hi = now - BEFORE, now + AFTER
    out, gid2cat = {}, {}
    for url in SOURCES:
        print("EPG:", url)
        req = urllib.request.Request(url, headers={"User-Agent": "BridgeTV-EPG/1.0 (+https://github.com/kyranashi/bridgetv)"})
        raw = urllib.request.urlopen(req, timeout=180).read()
        for ev, el in ET.iterparse(io.BytesIO(gzip.decompress(raw)), events=("end",)):
            if el.tag == "channel":
                k = guide_key(el.findtext("display-name"))
                if k and k in want and el.get("id") not in gid2cat:
                    gid2cat[el.get("id")] = want[k]
                el.clear()
            elif el.tag == "programme":
                ids = gid2cat.get(el.get("channel"))
                if ids:
                    a, b = parse_time(el.get("start")), parse_time(el.get("stop"))
                    t = (el.findtext("title") or "").strip()
                    if a and b and b > lo and a < hi and t:
                        for cid in ids:
                            out.setdefault(cid, []).append([a, b, t[:MAX_TITLE]])
                el.clear()
    for cid in out:
        seen, lst = set(), []
        for p in sorted(out[cid]):
            if p[0] not in seen:
                seen.add(p[0]); lst.append(p)
        out[cid] = lst
    data = {"built": now, "src": "epg.pw", "ch": out}
    if len(out) < 10:
        sys.exit("EPG: слишком мало каналов (%d) — источник изменился?" % len(out))
    with io.open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("EPG: каналов %d, передач %d, %d КБ" % (len(out), sum(len(v) for v in out.values()), os.path.getsize(OUT) // 1024))


if __name__ == "__main__":
    main()
