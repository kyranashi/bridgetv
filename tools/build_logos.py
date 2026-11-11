# -*- coding: utf-8 -*-
"""
BridgeTV — иконки каналов (с версии 0.2.3).

Что делает:
  1. Дополняет логотипы в data/catalog.json: у кого нет — ищет в базе iptv-org
     (api/logos.json по id канала; для каналов из Free-TV — по названию через api/channels.json).
  2. Для основных регионов (РФ, РБ) скачивает уменьшенные иконки 80×80 PNG в data/logos/
     и записывает путь в поле канала "li" (local icon). Эти иконки встраиваются в приложение:
     показываются мгновенно, без интернета и не зависят от блокировок imgur/wikimedia и
     от старых сертификатов iOS 9.
     Уменьшение делает открытый сервис wsrv.nl (ничего ставить не нужно).
  3. Пересохраняет data/catalog.json и data/catalog.js.

Запуск (после build_catalog.py):  python tools/build_logos.py
  --regions ru,by     для каких регионов встраивать иконки
  --force             перекачать все иконки заново
Повторный запуск докачивает только новые.
"""
import argparse
import concurrent.futures as cf
import hashlib
import io
import json
import os
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_catalog as bc  # noqa: E402

LOGOS = os.path.join(bc.DATA, "logos")
SIZE = 80


def best_logos():
    """{id канала: url} — лучший логотип: используемый, PNG/SVG→PNG, ширина ближе к 256."""
    out = {}
    try:
        for L in json.loads(bc.get(bc.PAGES + "/api/logos.json")):
            if L.get("feed") or not L.get("url"):
                continue
            score = (1 if L.get("in_use") else 0, 1 if (L.get("format") or "").upper() in ("PNG", "SVG") else 0,
                     -abs((L.get("width") or 0) - 256))
            cur = out.get(L["channel"])
            if cur is None or score > cur[0]:
                out[L["channel"]] = (score, L["url"])
    except Exception as e:
        bc.log("  ! logos.json недоступен:", e)
    return {k: v[1] for k, v in out.items()}


def fill_missing(cat):
    logos = best_logos()
    meta = bc.load_meta()
    # индекс «ключ названия -> id» для каналов РФ/РБ из метаданных (для каналов Free-TV)
    by_name = {}
    for cid, m in meta.items():
        if (m.get("country") or "").upper() in ("RU", "BY"):
            for n in [m.get("name", "")] + list(m.get("alt_names") or []):
                by_name.setdefault(bc.name_key(n), cid)
    added = 0
    for ch in cat["channels"]:
        if ch.get("l"):
            continue
        cid = ch["id"] if ch["id"] in logos else by_name.get(bc.name_key(ch["n"]))
        if cid and logos.get(cid):
            ch["l"] = logos[cid]
            added += 1
    bc.log(f"  логотипов добавлено: {added}")


def fname(url):
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:16] + ".png"


def _download(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (BridgeTV-logos/1.0)"})
    with urllib.request.urlopen(req, timeout=40) as r:
        # imgur в некоторых странах (напр. Великобритания) отдаёт картинку-заглушку с кодом 200
        # и статусом «Content not available in your country» — такую не сохраняем
        if "not available" in (r.reason or "").lower():
            raise ValueError("недоступно в стране: " + r.reason)
        return r.read()


def fetch_icon(url, path):
    """Скачать логотип и уменьшить до 80×80 (прозрачный фон, логотип по центру).
    1) напрямую + Pillow (imgur не пускает сервисы-ресайзеры: HTTP 429);
    2) запасной путь — wsrv.nl (умеет SVG, которые Pillow не читает)."""
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(_download(url)))
        im = im.convert("RGBA")
        bbox = im.getbbox()                 # обрезать пустые поля вокруг логотипа
        if bbox:
            im = im.crop(bbox)
        im.thumbnail((SIZE, SIZE), Image.LANCZOS)
        canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        canvas.paste(im, ((SIZE - im.width) // 2, (SIZE - im.height) // 2), im)
        canvas.save(path, "PNG", optimize=True)
        return os.path.getsize(path)
    except Exception:
        pass
    data = _download("https://wsrv.nl/?" + urllib.parse.urlencode({
        "url": url, "w": SIZE, "h": SIZE, "fit": "contain", "output": "png", "trim": 2}))
    if not data.startswith(b"\x89PNG"):
        raise ValueError("не PNG")
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--regions", default="ru,by")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    regions = set(a.regions.split(","))

    with io.open(bc.OUT_JSON, encoding="utf-8") as f:
        cat = json.load(f)
    bc.log("Дополняю логотипы…")
    fill_missing(cat)

    os.makedirs(LOGOS, exist_ok=True)
    jobs = {}
    for ch in cat["channels"]:
        ch.pop("li", None)
        if ch["r"] in regions and ch.get("l"):
            fn = fname(ch["l"])
            jobs.setdefault(fn, ch["l"])
            ch["li"] = "logos/" + fn
    todo = {fn: u for fn, u in jobs.items() if a.force or not os.path.exists(os.path.join(LOGOS, fn))}
    bc.log(f"Иконки: всего {len(jobs)}, скачать {len(todo)}…")
    ok, failed = 0, set()
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        futs = {ex.submit(fetch_icon, u, os.path.join(LOGOS, fn)): fn for fn, u in todo.items()}
        for fut in cf.as_completed(futs):
            try:
                fut.result()
                ok += 1
            except Exception:
                failed.add(futs[fut])
    for ch in cat["channels"]:          # иконка не скачалась — остаётся ссылка «l» из сети
        if ch.get("li") and ch["li"][6:] in failed:
            ch.pop("li")
    # Удалить иконки, которые больше не нужны
    keep = set(jobs) - failed
    for f in os.listdir(LOGOS):
        if f.endswith(".png") and f not in keep:
            os.remove(os.path.join(LOGOS, f))
    total = sum(os.path.getsize(os.path.join(LOGOS, f)) for f in os.listdir(LOGOS) if f.endswith(".png"))
    bc.log(f"  скачано {ok}, не удалось {len(failed)}; в папке {len(keep)} иконок, {total // 1024} КБ")
    bc.save(cat)


if __name__ == "__main__":
    sys.exit(main())
