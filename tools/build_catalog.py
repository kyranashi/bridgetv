# -*- coding: utf-8 -*-
"""
BridgeTV — сборщик каталога каналов.

Что делает:
  1. Скачивает открытые плейлисты iptv-org (только публичные бесплатные трансляции).
  2. Группирует ссылки одного канала в «варианты» (резервные источники).
  3. Россия и Беларусь — основные регионы (кнопки 1..N как на пульте),
     остальные страны и тематические подборки «Мир» — раздел «Дополнительно».
  4. Проверяет каждую ссылку как iPad (см. check_streams.py) и сортирует
     варианты: рабочие и быстрые — первыми, мёртвые — в «Не работают».
  5. Пишет data/catalog.json (для приложений) и data/catalog.js (для веб-версии
     и старых браузеров, которые не умеют грузить JSON с file://).

Запуск:
  python tools/build_catalog.py              # собрать + проверить (2–5 мин)
  python tools/build_catalog.py --no-check   # только собрать
  python tools/build_catalog.py --recheck    # только перепроверить текущий каталог
  python tools/build_catalog.py --only ru,by # собрать только эти регионы

Зависимости: только стандартная библиотека Python 3.8+.
"""
import argparse
import collections
import datetime
import io
import json
import os
import re
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_streams  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT_JSON = os.path.join(DATA, "catalog.json")
OUT_JS = os.path.join(DATA, "catalog.js")

PAGES = "https://iptv-org.github.io"
RAW = "https://raw.githubusercontent.com/iptv-org"

# ---------------------------------------------------------------------------
# Регионы: id, название, флаг, основной?, сколько вариантов одного канала держать
# ---------------------------------------------------------------------------
REGIONS = [
    ("ru", "Россия", "🇷🇺", True, 8),
    ("by", "Беларусь", "🇧🇾", True, 8),
    ("ua", "Украина", "🇺🇦", False, 2),
    ("kz", "Казахстан", "🇰🇿", False, 2),
    ("uz", "Узбекистан", "🇺🇿", False, 2),
    ("kg", "Кыргызстан", "🇰🇬", False, 2),
    ("tj", "Таджикистан", "🇹🇯", False, 2),
    ("ge", "Грузия", "🇬🇪", False, 2),
    ("am", "Армения", "🇦🇲", False, 2),
    ("az", "Азербайджан", "🇦🇿", False, 2),
    ("md", "Молдова", "🇲🇩", False, 2),
    ("lv", "Латвия", "🇱🇻", False, 2),
    ("lt", "Литва", "🇱🇹", False, 2),
    ("ee", "Эстония", "🇪🇪", False, 2),
    ("pl", "Польша", "🇵🇱", False, 2),
    ("il", "Израиль", "🇮🇱", False, 2),
    ("de", "Германия", "🇩🇪", False, 1),
    ("tr", "Турция", "🇹🇷", False, 1),
]
# Тематические подборки «Мир»: категория iptv-org -> (id, название, лимит)
WORLD_SRC = {"us", "uk", "gb", "de", "fr", "it", "es", "tr", "ca", "au"}
WORLD = [
    ("news", "w-news", "Мир: Новости", 60),
    ("sports", "w-sport", "Мир: Спорт", 40),
    ("kids", "w-kids", "Мир: Детские", 40),
    ("music", "w-music", "Мир: Музыка", 50),
    ("movies", "w-movies", "Мир: Кино", 50),
    ("documentary", "w-docs", "Мир: Познавательные", 50),
]

# Наши категории (порядок = порядок вкладок в приложении)
# Порядок = порядок секций на экране (после «Главных каналов») и вкладок категорий
CATEGORIES = [
    ("news", "Новости"), ("sport", "Спорт"), ("movies", "Кино и сериалы"), ("kids", "Детские"),
    ("music", "Музыка"), ("docs", "Познавательные"), ("fun", "Развлечения"), ("general", "Общие"),
    ("region", "Региональные"), ("religion", "Религия"),
]
CAT_MAP = {
    "general": "general", "news": "news", "business": "news", "weather": "news", "legislative": "news",
    "sports": "sport", "outdoor": "sport",
    "movies": "movies", "series": "movies", "classic": "movies",
    "kids": "kids", "animation": "kids", "family": "kids",
    "music": "music",
    "documentary": "docs", "science": "docs", "education": "docs", "travel": "docs", "culture": "docs",
    "history": "docs",
    "entertainment": "fun", "comedy": "fun", "lifestyle": "fun", "cooking": "fun", "auto": "fun",
    "relax": "fun",
    "religious": "religion",
}
SKIP_CATS = {"shop", "xxx"}

# Платные пакеты — не включаем (в открытом доступе их ссылки обычно нелегальны или мертвы)
PAY = re.compile(r"^(kino ?tv|kinohit|kinopremiera|kinosvidanie|kinokomedia|kinomix|kinoseria|match!? ?(premier|futbol|arena|igra|boec|strana)|nashe novoe kino|amedia|viasat|setanta|premier|okko|kinopoisk|tv1000|eurosport|start ?(air|world)|tnt4|dom kino premium)", re.I)

# Порядок «как на пульте». Россия: первый и второй мультиплексы (1–20).
# В каждой группе — латинские id iptv-org и кириллические ключи name_key().
RU_TOP = [
    ["perviykanal", "channelone", "1kanal", "первый"], ["rossiya1", "russia1", "россия1"],
    ["matchtv", "match", "матчтв"], ["ntv", "нтв"],
    ["5kanal", "pyatyykanal", "piatyikanal", "channel5", "пятый"], ["rossiyak", "kultura", "rossiyakultura", "россияк"],
    ["rossiya24", "russia24", "россия24"], ["karusel", "карусель"], ["otr", "отр"],
    ["tvtsentr", "tvc", "tvcentr", "твцентр"], ["rentv", "рентв"], ["spas", "спас"],
    ["sts", "стс"], ["domashniy", "domashny", "домашний"], ["tv3", "тв3"], ["pyatnitsa", "friday", "пятница"],
    ["zvezda", "звезда"], ["mir", "мир"], ["tnt", "тнт"], ["muztv", "музтв"],
]
BY_TOP = [
    ["belarus1", "беларусь1"], ["belarus2", "беларусь2"], ["belarus3", "беларусь3"], ["ont", "онт"],
    ["stv", "stolichnoetv", "ств"], ["ntvbelarus", "нтвбеларусь"], ["rtrbelarus", "ртрбеларусь"],
    ["mirbelarus", "мирбеларусь"], ["belarus5", "беларусь5"], ["belarus24", "беларусь24"], ["vtv"],
]


def log(*a):
    print(*a, flush=True)


def get(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": "TV-catalog/2.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def norm_id(cid):
    return re.sub(r"[^a-z0-9]", "", cid.split(".")[0].lower())


def is_cyr(s):
    return bool(re.search(r"[А-Яа-яЁёІіЎў]", s or ""))


# ---------------------------------------------------------------------------
# Разбор M3U
# ---------------------------------------------------------------------------
ATTR = re.compile(r'([a-z\-]+)="([^"]*)"')


def parse_m3u(text):
    """-> список dict(id, feed, name, url, logo, cats, quality, geo, part, ua, ref)"""
    out, cur, opts = [], None, {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXTINF"):
            attrs = dict(ATTR.findall(line))
            # Название — после атрибутов (в атрибутах бывают запятые, напр. в user-agent)
            bare = ATTR.sub("", line)
            title = bare.split(",", 1)[1].strip() if "," in bare else ""
            opts = {}
            if attrs.get("http-user-agent"):
                opts["ua"] = attrs["http-user-agent"]
            if attrs.get("http-referrer"):
                opts["ref"] = attrs["http-referrer"]
            tid = attrs.get("tvg-id", "")
            q = re.search(r"\((\d{3,4}p)\)", title)
            cur = dict(
                id=tid.split("@")[0], feed=(tid.split("@")[1] if "@" in tid else ""),
                name=re.sub(r"\s*\(\d{3,4}p\)|\s*\[[^\]]*\]", "", title).strip(),
                logo=attrs.get("tvg-logo", ""),
                cats=[c.strip().lower() for c in re.split(r"[;,]", attrs.get("group-title", "")) if c.strip()],
                quality=q.group(1) if q else "",
                geo="[Geo-blocked]" in title, part="[Not 24/7]" in title,
            )
        elif line.startswith("#EXTVLCOPT:http-user-agent="):
            opts["ua"] = line.split("=", 1)[1]
        elif line.startswith("#EXTVLCOPT:http-referrer="):
            opts["ref"] = line.split("=", 1)[1]
        elif line.startswith("#"):
            continue
        elif cur is not None:
            cur["url"] = line
            cur.update(opts)
            out.append(cur)
            cur, opts = None, {}
    return out


def load_meta():
    """channels.json из API iptv-org: альтернативные (кириллические) имена, категории, закрытые."""
    meta = {}
    try:
        for c in json.loads(get(PAGES + "/api/channels.json")):
            meta[c["id"]] = c
        log(f"  метаданные: {len(meta)} каналов")
    except Exception as e:  # каталог соберётся и без них, просто с латинскими названиями
        log(f"  ! метаданные недоступны: {e}")
    return meta


def fetch_list(url):
    try:
        return parse_m3u(get(url))
    except Exception as e:
        log(f"  ! {url}: {e}")
        return []


def fetch_country(cc):
    """Объединение двух файлов iptv-org: выборка по стране канала (countries/) и полный файл
    потоков страны (streams/ — в нём больше ссылок, в т.ч. без привязки к каналу).
    Дубликаты ссылок отбрасываются."""
    seen, out = set(), []
    for url in (f"{PAGES}/iptv/countries/{cc}.m3u", f"{RAW}/iptv/master/streams/{cc}.m3u"):
        for it in fetch_list(url):
            if it["url"] not in seen:
                seen.add(it["url"])
                out.append(it)
    return out


# ---------------------------------------------------------------------------
# Дополнительные источники (с версии 0.2.2)
# ---------------------------------------------------------------------------
# Free-TV/IPTV — курируемый список бесплатных каналов по странам. В нём есть основные
# каналы РФ/РБ, которых нет или которые мертвы в iptv-org (ТНТ, СТС, Пятница!, ОНТ, СТВ…).
FREETV = "https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8"
FREETV_GROUPS = {"Russia": "ru", "Belarus": "by"}
# Русскоязычные каналы со всего мира (iptv-org, по языку вещания)
LANG_RUS = f"{PAGES}/iptv/languages/rus.m3u"

# Латинские буквы, похожие на кириллицу (в источниках встречается «Dомашний»)
LOOKALIKE = str.maketrans("aeopcxykmthbdAEOPCXYKMTHBD", "аеорсхукмтнвдАЕОРСХУКМТНВД")
# Разные написания одного канала -> общий ключ
NAME_ALIAS = {
    "россиякультура": "россияк", "культура": "россияк", "россия1hd": "россия1", "первыйканалhd": "первый",
    "твц": "твцентр", "пятницa": "пятница", "матч": "матчтв", "матчтвhd": "матчтв", "нтвhd": "нтв",
    "5канал": "пятый", "пятыйканал": "пятый", "первыйканал": "первый", "1канал": "первый",
    "общественноетелевидениероссии": "отр", "россияк": "россияк", "планетартр": "ртрпланета",
}


def name_key(name):
    """Ключ для склейки одного канала из разных источников: «Россия-1 (1080p) Ⓢ» -> «россия1»."""
    s = re.sub(r"\(.*?\)|\[.*?\]", "", name or "")
    if is_cyr(s):
        s = s.translate(LOOKALIKE)
    s = s.lower().replace("ё", "е")
    s = re.sub(r"[^0-9a-zа-яіў]+", "", s)
    s = re.sub(r"(hd|sd|fhd|uhd|4k)$", "", s)
    return NAME_ALIAS.get(s, s)


def guess_cat(name):
    n = name.lower()
    for pat, cat in ((r"24|новост|news|рбк|вести|известия", "news"), (r"спорт|матч|футбол|бокс", "sport"),
                     (r"карусель|мульт|детск|kids|уникум|о!", "kids"), (r"муз|music|mtv|ру тв|ля-минор", "music"),
                     (r"кино|фильм|сериал|мелодрам|детектив", "movies"),
                     (r"культура|история|наука|моя планета|точка|travel|авто|охот|рыбал", "docs"),
                     (r"спас|союз|православ", "religion")):
        if re.search(pat, n):
            return cat
    return "general"


def fetch_freetv():
    """Free-TV: {регион: [элементы]}; значки Ⓢ Ⓖ Ⓨ и т.п. убираются из названий.
    Ссылки на YouTube, VK, OK.ru и DASH (.mpd) пропускаются — старые устройства их не сыграют."""
    out = {r: [] for r in FREETV_GROUPS.values()}
    for it in fetch_list(FREETV):
        grp = (it["cats"] or [""])[0]
        reg = FREETV_GROUPS.get(next((g for g in FREETV_GROUPS if g.lower() == grp), ""))
        if not reg:
            continue
        it["geo"] = it["geo"] or "Ⓖ" in it["name"]
        it["name"] = re.sub(r"[Ⓐ-ⓩ]", "", it["name"]).strip()
        it["cats"] = []
        it["src"] = "free-tv"
        out[reg].append(it)
    return out


def merge_by_name(chans, items, region, max_var):
    """Добавляет ссылки из другого источника к каналам с тем же названием (как резервные
    варианты); если такого канала нет — создаёт новый."""
    idx = {}
    for ch in chans:
        idx.setdefault(name_key(ch["n"]), ch)
    added_v = added_c = 0
    for it in items:
        if not playable_url(it.get("url", "")):
            continue
        k = name_key(it["name"])
        if not k:
            continue
        ch = idx.get(k)
        if ch is None:
            ch = {"id": "ftv-" + region + "-" + k, "n": it["name"], "r": region, "c": guess_cat(it["name"]),
                  "l": it.get("logo", ""), "v": []}
            chans.append(ch)
            idx[k] = ch
            added_c += 1
        elif is_cyr(it["name"]) and re.search(r"[A-Za-z]", ch["n"]) and is_cyr(ch["n"]):
            ch["n"] = it["name"]          # «Dомашний» -> «Домашний»
        if len(ch["v"]) >= max_var or any(v["u"] == it["url"] for v in ch["v"]):
            continue
        v = {"u": it["url"], "src": it.get("src", "")}
        if it.get("quality"):
            v["q"] = it["quality"]
        if it.get("geo"):
            v["geo"] = 1
        ch["v"].append(v)
        added_v += 1
    return added_c, added_v


def fetch_category(cat):
    try:
        return parse_m3u(get(f"{PAGES}/iptv/categories/{cat}.m3u"))
    except Exception as e:
        log(f"  ! категория {cat}: {e}")
        return []


# ---------------------------------------------------------------------------
# Сборка
# ---------------------------------------------------------------------------
def playable_url(u):
    """iOS 9 / AVPlayer и hls.js понимают только HLS (.m3u8). mp4 тоже допустим."""
    low = u.lower().split("?")[0]
    if not low.startswith(("http://", "https://")):
        return False
    return ".m3u8" in low or low.endswith(".m3u") or low.endswith(".mp4") or "m3u8" in u.lower()


def display_name(it, meta):
    m = meta.get(it["id"]) or {}
    if not is_cyr(it["name"]):
        for alt in m.get("alt_names") or []:
            if is_cyr(alt):
                return alt
    return it["name"] or m.get("name") or it["id"]


def our_cat(cats, meta_cats):
    for c in list(cats) + list(meta_cats or []):
        c = c.lower()
        if c in SKIP_CATS:
            return None
        if c in CAT_MAP:
            return CAT_MAP[c]
    return "general"


def group_channels(items, region, max_var, meta, top=None):
    """Схлопывает потоки одного канала в один канал с вариантами."""
    chans = collections.OrderedDict()
    for it in items:
        if not playable_url(it.get("url", "")):
            continue
        m = meta.get(it["id"]) or {}
        if m.get("is_nsfw") or m.get("closed"):
            continue
        if re.search(r"xxx|adult|18\+|erotic", it["name"], re.I):
            continue
        cat = our_cat(it["cats"], m.get("categories"))
        if cat is None:
            continue
        name = display_name(it, meta)
        if region == "ru" and PAY.match(it["name"]) and not is_cyr(it["name"]):
            continue
        key = it["id"] or re.sub(r"\W+", "", name.lower())
        ch = chans.get(key)
        if ch is None:
            ch = chans[key] = {
                "id": key, "n": name, "r": region, "c": cat, "l": it.get("logo", ""),
                "v": [], "_nid": norm_id(key) if it["id"] else re.sub(r"\W+", "", it["name"].lower()),
            }
        if len(ch["v"]) >= max_var or any(v["u"] == it["url"] for v in ch["v"]):
            continue
        v = {"u": it["url"]}
        if it["quality"]:
            v["q"] = it["quality"]
        if it["geo"]:
            v["geo"] = 1
        if it["part"]:
            v["part"] = 1
        if it.get("ua") or it.get("ref"):
            v["h"] = {k: it[k] for k in ("ua", "ref") if it.get(k)}
        ch["v"].append(v)
        if not ch["l"] and it.get("logo"):
            ch["l"] = it["logo"]
    result = list(chans.values())
    if top is not False:
        sort_region(result, top)
    return result


def sort_region(result, top=None):
    """Порядок как на пульте: сначала «кнопочные» каналы (по латинскому id iptv-org или по
    кириллическому названию), дальше по категориям и алфавиту."""
    order = [c for c, _ in CATEGORIES]

    def rank(ch):
        ch.pop("top", None)
        if top:
            nid, nk = ch.get("_nid", ""), name_key(ch["n"])
            for i, alts in enumerate(top):
                if nid in alts or nk in alts:
                    ch["top"] = 1          # «Главные каналы» — секция в начале списка
                    return (0, i, "")
        # внутри категории — по алфавиту: сначала кириллица, потом латиница, потом с цифр (ё = е)
        n = ch["n"].lower().replace("ё", "е")
        kind = 2 if n[:1].isdigit() else 0 if is_cyr(n[:1]) else 1
        return (1, order.index(ch["c"]), kind, n)
    result.sort(key=rank)
    for ch in result:
        ch.pop("_nid", None)


def reorganize(channels, meta):
    """Наведение порядка (с 0.2.3): региональные каналы — в «Региональные», сортировка каждого
    региона (Главные → категории по порядку → алфавит) и сквозные номера сверху вниз."""
    by_name = {}
    for cid, m in meta.items():
        for n in [m.get("name", "")] + list(m.get("alt_names") or []):
            by_name.setdefault(name_key(n), cid)
    # Зона вещания основного фида канала (iptv-org api/feeds.json): «c/RU» — вся страна,
    # «s/RU-KYA» — область, «ct/…» — город. Только область/город -> местный канал.
    local = set()
    try:
        for f in json.loads(get(PAGES + "/api/feeds.json")):
            area = f.get("broadcast_area") or []
            if f.get("is_main") and area and all(not x.startswith(("c/", "r/")) for x in area):
                local.add(f["channel"])
    except Exception as e:
        log(f"  ! feeds.json недоступен: {e}")
    moved = 0
    for ch in channels:
        if ch["r"].startswith("w-") or ch["c"] not in ("general", "news", "fun"):
            continue
        cid = ch["id"] if ch["id"] in meta else by_name.get(name_key(ch["n"]), "")
        if cid in local:
            ch["c"] = "region"
            moved += 1
    tops = {"ru": RU_TOP, "by": BY_TOP}
    out, regions = [], []
    for ch in channels:
        if ch["r"] not in regions:
            regions.append(ch["r"])
    for r in regions:
        part = [c for c in channels if c["r"] == r]
        sort_region(part, tops.get(r))
        for i, c in enumerate(part):
            c["num"] = i + 1
        out += part
    channels[:] = out
    log(f"  сортировка: в «Региональные» перенесено {moved}")


EXTRA = os.path.join(DATA, "sources_extra.json")


def merge_extra(channels):
    """Ручные источники из data/sources_extra.json (см. docs/CATALOG.md).
    Если канал с таким id есть — ссылки добавляются ПЕРВЫМИ вариантами, иначе канал создаётся."""
    if not os.path.exists(EXTRA):
        return
    with io.open(EXTRA, encoding="utf-8") as f:
        extra = json.load(f).get("channels", [])
    by_id = {c["id"]: c for c in channels}
    for e in extra:
        urls = [{"u": u} if isinstance(u, str) else u for u in e.get("v", [])]
        ch = by_id.get(e["id"])
        if ch:
            known = set(v["u"] for v in ch["v"])
            ch["v"] = [v for v in urls if v["u"] not in known] + ch["v"]
        elif urls:
            ch = {"id": e["id"], "n": e.get("n", e["id"]), "r": e.get("r", "ru"), "c": e.get("c", "general"),
                  "l": e.get("l", ""), "v": urls}
            channels.append(ch)
            by_id[ch["id"]] = ch
    log(f"  ручные источники: {len(extra)}")


def build(only=None):
    meta = load_meta()
    channels, regions = [], []
    freetv = fetch_freetv()
    rus = fetch_list(LANG_RUS)
    for cc, name, flag, primary, mv in REGIONS:
        if only and cc not in only:
            continue
        items = fetch_country(cc)
        if primary:   # + русскоязычные потоки каналов этой страны, которых нет в файлах страны
            known = set(i["url"] for i in items)
            items += [i for i in rus if i["id"].rsplit(".", 1)[-1].lower() == cc and i["url"] not in known]
        top = RU_TOP if cc == "ru" else BY_TOP if cc == "by" else None
        chans = group_channels(items, cc, mv, meta, False)
        msg = f"  {flag} {name}: {len(items)} ссылок -> {len(chans)} каналов"
        if freetv.get(cc):
            nc, nv = merge_by_name(chans, freetv[cc], cc, mv)
            msg += f"; Free-TV: +{nv} ссылок, +{nc} новых каналов"
        sort_region(chans, top)
        log(msg)
        regions.append({"id": cc, "name": name, "flag": flag, "primary": primary})
        channels += chans

    # Русскоязычные каналы других стран (RTVi, Русский мир, международные версии…)
    if not only or "rus" in only:
        seen = set(c["id"] for c in channels)
        seen_names = set(name_key(c["n"]) for c in channels if c["r"] in ("ru", "by"))
        items = [i for i in rus if i["id"] not in seen and i["id"].rsplit(".", 1)[-1].lower() not in ("ru", "by", "ua")]
        chans = [c for c in group_channels(items, "rus", 3, meta, None) if name_key(c["n"]) not in seen_names]
        log(f"  🗣 Русскоязычные (мир): {len(chans)} каналов")
        regions.append({"id": "rus", "name": "Русскоязычные (мир)", "flag": "🗣", "primary": False})
        channels += chans

    if not only or "world" in only:
        seen = set(ch["id"] for ch in channels)
        for cat, rid, title, lim in WORLD:
            items = [i for i in fetch_category(cat)
                     if i["id"].rsplit(".", 1)[-1].lower() in WORLD_SRC and not i["geo"] and not i["part"]]
            chans = [c for c in group_channels(items, rid, 1, meta) if c["id"] not in seen][:lim]
            for c in chans:
                seen.add(c["id"])
                c["c"] = {"news": "news", "sports": "sport", "kids": "kids", "music": "music",
                          "movies": "movies", "documentary": "docs"}[cat]
            log(f"  🌐 {title}: {len(chans)} каналов")
            regions.append({"id": rid, "name": title, "flag": "🌐", "primary": False, "world": True})
            channels += chans

    merge_extra(channels)

    # Порядок, «Региональные» и номера каналов (как кнопки на пульте)
    reorganize(channels, meta)
    return {
        "app": "BridgeTV", "format": 2,
        "version": datetime.date.today().isoformat(),
        "source": "iptv-org (https://github.com/iptv-org/iptv) — только открытые бесплатные трансляции",
        "regions": regions,
        "categories": [{"id": c, "name": n} for c, n in CATEGORIES],
        "channels": channels,
    }


def save(cat):
    os.makedirs(DATA, exist_ok=True)
    # точная метка сборки: приложение берёт более свежий каталог (встроенный или скачанный)
    cat["built"] = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    body = json.dumps(cat, ensure_ascii=False, separators=(",", ":"))
    with io.open(OUT_JSON, "w", encoding="utf-8") as f:
        f.write(body)
    with io.open(OUT_JS, "w", encoding="utf-8") as f:
        f.write("/* Сгенерировано tools/build_catalog.py — не редактировать вручную */\nwindow.TV_CATALOG=" + body + ";\n")
    total = len(cat["channels"])
    alive = sum(1 for c in cat["channels"] if c.get("ok", 1))
    log(f"OK: {total} каналов ({alive} рабочих), {sum(len(c['v']) for c in cat['channels'])} ссылок, "
        f"{len(body) // 1024} КБ -> {OUT_JSON}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-check", action="store_true", help="не проверять ссылки")
    ap.add_argument("--recheck", action="store_true", help="перепроверить существующий data/catalog.json")
    ap.add_argument("--only", default="", help="регионы через запятую, напр. ru,by,world")
    ap.add_argument("--workers", type=int, default=48, help="параллельных проверок")
    ap.add_argument("--timeout", type=float, default=8.0, help="таймаут на запрос, сек")
    ap.add_argument("--soft", default="", help="мягкая проверка регионов (через запятую), напр. ru,by — "
                    "для запуска из-за границы (GitHub Actions), чтобы не прятать гео-каналы")
    ap.add_argument("--reorg", action="store_true", help="только пересортировать текущий каталог (без сети и проверки)")
    a = ap.parse_args()

    if a.reorg:   # только навести порядок в текущем каталоге, без скачивания и проверки
        with io.open(OUT_JSON, encoding="utf-8") as f:
            cat = json.load(f)
        cat["categories"] = [{"id": c, "name": n} for c, n in CATEGORIES]
        reorganize(cat["channels"], load_meta())
        save(cat)
        return
    if a.recheck:
        with io.open(OUT_JSON, encoding="utf-8") as f:
            cat = json.load(f)
    else:
        log("Скачиваю плейлисты iptv-org…")
        cat = build(set(a.only.split(",")) if a.only else None)
    if not a.no_check:
        log(f"Проверяю ссылки ({a.workers} потоков, таймаут {a.timeout} с)…")
        check_streams.check_catalog(cat, workers=a.workers, timeout=a.timeout, log=log,
                                    soft=set(filter(None, a.soft.split(","))))
    save(cat)


if __name__ == "__main__":
    sys.exit(main())
