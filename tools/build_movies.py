# -*- coding: utf-8 -*-
"""
BridgeTV — каталог фильмов для вкладки «Фильмы» (с 1.1.0).

  python tools/build_movies.py         -> data/movies.json

Источники (открытые и официальные, без пиратства):
  • каталог фильмов Apple (iTunes RSS «топ фильмов» по жанрам + iTunes Lookup API) — названия,
    постеры, даты выхода, жанры, описания, возрастной рейтинг, длительность, режиссёр и
    ОФИЦИАЛЬНЫЙ трейлер (preview, mp4/H.264 — играет даже на iPad с iOS 9);
  • топ фильмов Apple для России — русские названия популярных фильмов;
  • Wikidata (SPARQL) — русские названия новых фильмов по английскому названию и году.
Сами фильмы приложение не показывает и не скачивает: «Трейлер», ссылки «Где смотреть»
(Apple TV, Кинопоиск, поиск легальных онлайн-кинотеатров).

Формат: { "built": unix, "src": "...", "movies": [ {id, t, to, y, date, g, d, p, tr, r, min, dir, url}, … ] }
отсортировано по дате выхода — новые первыми. Обновляется раз в день (.github/workflows/pages.yml),
публикуется на GitHub Pages и в репозиторий не коммитится. Только стандартная библиотека Python.
"""
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "movies.json")
UA = {"User-Agent": "BridgeTV-catalog/1.1 (+https://github.com/kyranashi/bridgetv)"}

# Жанры каталога Apple (id для RSS) -> наш жанр
GENRES = [(None, None), (4401, "action"), (4404, "comedy"), (4406, "drama"), (4408, "horror"), (4410, "family"),
          (4412, "romance"), (4413, "scifi"), (4416, "thriller"), (4405, "doc"), (4402, "anime"), (4403, "classic"),
          (4420, "indie"), (4409, "music"), (4419, "western"), (4417, "anime")]
GENRE_NAME = {  # primaryGenreName Apple -> наш id
    "Action & Adventure": "action", "Comedy": "comedy", "Drama": "drama", "Horror": "horror", "Kids & Family": "family",
    "Romance": "romance", "Sci-Fi & Fantasy": "scifi", "Thriller": "thriller", "Documentary": "doc", "Anime": "anime",
    "Classics": "classic", "Independent": "indie", "Music Feature Films": "music", "Musicals": "music", "Western": "western",
    "Foreign": "foreign", "Sports": "sport", "Holiday": "family", "Concert Films": "music", "Short Films": "short",
    "Military and War": "war", "Japanese Cinema": "anime", "Russian": "foreign",
}
SKIP_GENRES = {"short"}


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            return json.loads(urllib.request.urlopen(req, timeout=60).read().decode("utf-8"))
        except Exception as e:
            if i == tries - 1:
                print("  ! %s: %s" % (url[:90], e))
                return None
            time.sleep(2 + i * 3)


def rss_ids(country, genre):
    url = "https://itunes.apple.com/%s/rss/topmovies/limit=200%s/json" % (country, "/genre=%d" % genre if genre else "")
    j = get(url)
    out = []
    for e in ((j or {}).get("feed") or {}).get("entry") or []:
        try:
            out.append((e["id"]["attributes"]["im:id"], e["im:name"]["label"]))
        except (KeyError, TypeError):
            pass
    return out


def lookup(ids, country):
    res = {}
    for i in range(0, len(ids), 150):
        j = get("https://itunes.apple.com/lookup?country=%s&id=%s" % (country, ",".join(ids[i:i + 150])))
        for r in (j or {}).get("results") or []:
            if r.get("kind") == "feature-movie":
                res[str(r["trackId"])] = r
        time.sleep(1)
    return res


def poster(url, size):
    # artworkUrl100 …/source/100x100bb.jpg -> нужный размер (2:3)
    return re.sub(r"/[0-9]+x[0-9]+(bb)?\.(jpg|png)$", "/%dx%dbb.jpg" % (size, size * 3 // 2), url or "")


def norm(s):
    s = (s or "").lower().replace("ё", "е")
    s = re.sub(r"\(\d{4}\)|\[.*?\]", "", s)
    return re.sub(r"[^0-9a-zа-я]+", "", s)


def wikidata_ru(titles):
    """{(норм. англ. название, год): русское название}. Запросы порциями по точным английским названиям."""
    out = {}
    titles = sorted(set(titles))
    for i in range(0, len(titles), 60):
        part = titles[i:i + 60]
        vals = " ".join('"%s"@en' % t.replace("\\", "").replace('"', "") for t in part)
        q = """SELECT ?en ?ru ?d ?art WHERE {
          VALUES ?en { %s }
          ?f rdfs:label ?en; wdt:P31 wd:Q11424.
          OPTIONAL { ?f wdt:P577 ?d }
          ?f rdfs:label ?ru FILTER(LANG(?ru) = "ru")
          OPTIONAL { ?art schema:about ?f; schema:isPartOf <https://ru.wikipedia.org/> }
        }""" % vals
        j = get("https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(q))
        for b in ((j or {}).get("results") or {}).get("bindings") or []:
            try:
                y = int(b["d"]["value"][:4]) if "d" in b else 0
                art = urllib.parse.unquote(b["art"]["value"].split("/wiki/", 1)[1]).replace("_", " ") if "art" in b else ""
                val = (b["ru"]["value"], art)
                # год — обязательный признак совпадения; «без года» — только если в Wikidata даты нет
                out.setdefault((norm(b["en"]["value"]), y), val)
            except (KeyError, ValueError, IndexError):
                pass
        time.sleep(1)
    print("Wikidata: русских названий %d" % len(out))
    return out


def ru_name(wd, en, y):
    """(русское название, статья ру-Википедии) или (None, '')"""
    for yy in (y, y - 1, y + 1, 0):
        t = wd.get((norm(en), yy))
        if t:
            return t
    return (None, "")


def wiki_ru_intro(titles):
    """{статья: первые предложения статьи ру-Википедии} — русское описание фильма (CC BY-SA, с указанием источника)"""
    out, titles = {}, sorted(set(t for t in titles if t))
    for i in range(0, len(titles), 20):
        part = titles[i:i + 20]
        url = ("https://ru.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1"
               "&exsentences=4&redirects=1&titles=" + urllib.parse.quote("|".join(part)))
        j = get(url) or {}
        q = j.get("query") or {}
        back = {}
        for r in q.get("redirects") or []:
            back[r["to"]] = r["from"]
        for r in q.get("normalized") or []:
            back.setdefault(r["to"], r["from"])
        for p in (q.get("pages") or {}).values():
            txt = re.sub(r"\s+", " ", p.get("extract") or "").strip()
            txt = re.sub(r"\s*\([^()]*(англ\.|англ |МФА)[^()]*\)", "", txt)    # убрать «(англ. …)» в начале статьи
            if len(txt) > 40:
                out[back.get(p.get("title"), p.get("title"))] = txt[:600]
        time.sleep(0.5)
    print("Википедия: русских описаний %d" % len(out))
    return out


def main():
    ids, ru_title = [], {}
    for g, _ in GENRES:
        for i, name in rss_ids("us", g):
            if i not in ids:
                ids.append(i)
        time.sleep(1)
    print("Apple US: %d фильмов" % len(ids))
    ru_ids = []
    for i, name in rss_ids("ru", None):
        ru_title[i] = name
        ru_ids.append(i)
    details = lookup(ids, "us")
    ru_details = lookup([i for i in ru_ids if i not in details], "ru")
    now = time.time()
    wd = wikidata_ru([re.sub(r"\s*\(\d{4}\)$", "", r.get("trackName") or "") for r in details.values() if r.get("trackName")])
    arts = [ru_name(wd, re.sub(r"\s*\(\d{4}\)$", "", r.get("trackName") or ""), int((r.get("releaseDate") or "0000")[:4] or 0))[1]
            for r in details.values()]
    intro = wiki_ru_intro(arts)
    movies = []
    for mid, r in list(details.items()) + list(ru_details.items()):
        date = (r.get("releaseDate") or "")[:10]
        if not date or not r.get("artworkUrl100"):
            continue
        y = int(date[:4])
        g = GENRE_NAME.get(r.get("primaryGenreName") or "", "other")
        if g in SKIP_GENRES:
            continue
        en = r.get("trackName") or ""
        wt, art = ru_name(wd, re.sub(r"\s*\(\d{4}\)$", "", en), y)
        t = ru_title.get(mid) or wt or en
        movies.append({
            "id": "it" + mid, "t": t[:120], "to": en[:120] if en != t else "", "y": y, "date": date, "g": g,
            "d": re.sub(r"\s+", " ", r.get("longDescription") or "")[:450],
            # русское описание — начало статьи ру-Википедии (CC BY-SA 4.0), «wa» — название статьи для ссылки
            "dr": intro.get(art, ""), "wa": art if intro.get(art) else "",
            "p": poster(r["artworkUrl100"], 300), "tr": r.get("previewUrl") or "",
            "r": r.get("contentAdvisoryRating") or "", "min": int(int(r.get("trackTimeMillis") or 0) / 60000),
            "dir": (r.get("artistName") or "")[:80], "url": (r.get("trackViewUrl") or "").split("?")[0],
            "c": "ru" if mid in ru_title else "us",
        })
    movies.sort(key=lambda m: m["date"], reverse=True)
    if len(movies) < 50:
        sys.exit("Фильмов слишком мало (%d) — источник изменился?" % len(movies))
    with io.open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"built": int(now), "src": "Apple iTunes, Wikidata", "movies": movies}, f, ensure_ascii=False, separators=(",", ":"))
    ru = sum(1 for m in movies if re.search("[а-яА-Я]", m["t"]))
    print("С русским описанием: %d" % sum(1 for m in movies if m["dr"]))
    print("Фильмов: %d (с русским названием %d, с трейлером %d), %d КБ" % (
        len(movies), ru, sum(1 for m in movies if m["tr"]), os.path.getsize(OUT) // 1024))


if __name__ == "__main__":
    main()
