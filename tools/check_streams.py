# -*- coding: utf-8 -*-
"""
BridgeTV — проверка HLS-ссылок «глазами iPad».

Для каждой ссылки:
  1. GET master-плейлиста с User-Agent плеера iOS 9 (AppleCoreMedia).
  2. Если это master — разбор вариантов (BANDWIDTH, RESOLUTION, CODECS),
     выбор самого лёгкого варианта не в HEVC (старые устройства HEVC не умеют).
  3. GET media-плейлиста, проверка DRM (SAMPLE-AES = не сыграет).
  4. Запрос первых 2 КБ первого сегмента — канал реально отдаёт видео.

Результат пишется в сам вариант:
  s   — статус: 1 рабочий, 2 медленный (>4 с), 3 гео-блок/запрет (403/451),
        -1 не работает, 0 не проверялся
  ms  — время до первого байта видео, мс
  hi  — максимальная высота кадра (720, 1080…), lo — минимальная
  hevc— 1, если есть только HEVC-варианты (на старых iPad/Android не пойдёт)
  e   — короткая причина ошибки (для «Не работают»)

Каналу ставится ok=1, если хоть один вариант рабочий (s=1/2), и варианты
сортируются: быстрые рабочие — первыми.

Можно запустить отдельно:  python tools/check_streams.py URL [URL…]
"""
import concurrent.futures as cf
import http.client
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA_IPAD = "AppleCoreMedia/1.0.0.13G36 (iPad; U; CPU OS 9_3_5 like Mac OS X; ru_ru)"
SLOW_MS = 4000
OK, SLOW, GEO, DEAD, UNKNOWN = 1, 2, 3, -1, 0
RANK = {OK: 0, SLOW: 1, UNKNOWN: 2, GEO: 3, DEAD: 4}

_ctx = ssl.create_default_context()


class Fail(Exception):
    def __init__(self, status, reason):
        super().__init__(reason)
        self.status, self.reason = status, reason


def fetch(url, headers, timeout, limit, rng=None):
    h = dict(headers)
    if rng:
        h["Range"] = rng
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ctx) as r:
            return r.geturl(), r.headers.get("Content-Type", ""), r.read(limit)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403, 451):
            raise Fail(GEO, f"HTTP {e.code}")
        raise Fail(DEAD, f"HTTP {e.code}")
    except (ssl.SSLError, ssl.CertificateError) as e:
        raise Fail(DEAD, "TLS")
    except urllib.error.URLError as e:
        r = e.reason
        if isinstance(r, (ssl.SSLError, ssl.CertificateError)):
            raise Fail(DEAD, "TLS")
        if isinstance(r, socket.timeout) or "timed out" in str(r):
            raise Fail(DEAD, "таймаут")
        if isinstance(r, socket.gaierror):
            raise Fail(DEAD, "нет домена")
        raise Fail(DEAD, "нет связи")
    except (socket.timeout, TimeoutError):
        raise Fail(DEAD, "таймаут")
    except (http.client.HTTPException, ConnectionError, OSError, ValueError):
        raise Fail(DEAD, "обрыв")


STREAM_INF = re.compile(r"#EXT-X-STREAM-INF:([^\n]*)\n\s*([^\n#][^\n]*)")


def parse_master(text, base):
    out = []
    for attrs, uri in STREAM_INF.findall(text):
        bw = re.search(r"BANDWIDTH=(\d+)", attrs)
        res = re.search(r"RESOLUTION=\d+x(\d+)", attrs)
        codecs = re.search(r'CODECS="([^"]*)"', attrs)
        out.append(dict(
            bw=int(bw.group(1)) if bw else 0,
            h=int(res.group(1)) if res else 0,
            hevc=bool(codecs and re.search(r"hvc1|hev1|av01|vp09", codecs.group(1))),
            uri=urllib.parse.urljoin(base, uri.strip()),
        ))
    return out


def probe(url, timeout=8.0, extra=None):
    """-> dict(s, ms, hi, lo, hevc, e)"""
    extra = extra or {}
    hdr = {"User-Agent": extra.get("ua") or UA_IPAD, "Accept": "*/*"}
    if extra.get("ref"):
        hdr["Referer"] = extra["ref"]
    t0 = time.time()
    res = {}
    try:
        final, ctype, body = fetch(url, hdr, timeout, 512 * 1024)
        text = body.decode("utf-8", "replace").lstrip("﻿ \r\n\t")
        if url.lower().split("?")[0].endswith(".mp4") or ctype.startswith("video/"):
            res.update(s=OK)
        elif not text.startswith("#EXTM3U"):
            raise Fail(DEAD, "не плейлист")
        else:
            media_url, media = final, text
            if "#EXT-X-STREAM-INF" in text:
                vs = parse_master(text, final)
                if not vs:
                    raise Fail(DEAD, "пустой master")
                hs = [v["h"] for v in vs if v["h"]]
                if hs:
                    res["hi"], res["lo"] = max(hs), min(hs)
                good = [v for v in vs if not v["hevc"]]
                if not good:
                    res["hevc"] = 1
                    raise Fail(DEAD, "только HEVC")
                pick = min(good, key=lambda v: v["bw"] or 10 ** 9)
                media_url, ctype, body = fetch(pick["uri"], hdr, timeout, 512 * 1024)
                media = body.decode("utf-8", "replace")
                if "#EXTM3U" not in media[:64]:
                    raise Fail(DEAD, "битый вариант")
            if "METHOD=SAMPLE-AES" in media or "com.apple.streamingkeydelivery" in media:
                raise Fail(DEAD, "DRM")
            seg = None
            for line in media.splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    seg = urllib.parse.urljoin(media_url, line)
                    break
            if not seg:
                raise Fail(DEAD, "нет сегментов")
            fetch(seg, hdr, timeout, 2048, rng="bytes=0-2047")
            res["s"] = OK
        res["ms"] = int((time.time() - t0) * 1000)
        if res["ms"] > SLOW_MS:
            res["s"] = SLOW
    except Fail as f:
        res.update(s=f.status, e=f.reason)
    return res


def _apply(v, r):
    for k in ("s", "ms", "hi", "lo", "hevc", "e"):
        v.pop(k, None)
    v.update(r)


HARD = ("нет домена", "HTTP 404", "HTTP 410", "не плейлист", "только HEVC", "DRM")


def check_catalog(cat, workers=48, timeout=8.0, log=print, soft=()):
    """soft — регионы, которые проверяются «мягко» (для проверки из-за границы, напр. в GitHub
    Actions): канал прячется, только если ВСЕ его ссылки точно мертвы (нет домена, 404, DRM…),
    а не просто недоступны из чужой страны."""
    jobs = [(ch, v) for ch in cat["channels"] for v in ch["v"]]
    done, t0 = 0, time.time()
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(probe, v["u"], timeout, v.get("h")): (ch, v) for ch, v in jobs}
        for fut in cf.as_completed(futs):
            ch, v = futs[fut]
            try:
                _apply(v, fut.result())
            except Exception as e:  # защита от неожиданных падений одного потока
                _apply(v, {"s": DEAD, "e": type(e).__name__})
            done += 1
            if done % 200 == 0 or done == len(jobs):
                log(f"  {done}/{len(jobs)}  ({int(time.time() - t0)} с)")
    stat = {OK: 0, SLOW: 0, GEO: 0, DEAD: 0}
    for ch in cat["channels"]:
        ch["v"].sort(key=lambda v: (RANK.get(v.get("s", 0), 2), v.get("ms", 10 ** 6)))
        best = ch["v"][0].get("s", 0) if ch["v"] else DEAD
        ch["ok"] = 1 if best in (OK, SLOW) else 0
        if not ch["ok"] and ch["r"] in soft and not all(v.get("e") in HARD for v in ch["v"]):
            ch["ok"] = 1   # возможно, работает только внутри страны — не прячем
        for v in ch["v"]:
            stat[v.get("s", DEAD)] = stat.get(v.get("s", DEAD), 0) + 1
    cat["checked"] = time.strftime("%Y-%m-%d %H:%M")
    log(f"  итог ссылок: рабочих {stat[OK]}, медленных {stat[SLOW]}, гео/запрет {stat[GEO]}, "
        f"мёртвых {stat[DEAD]}")
    log(f"  каналов рабочих: {sum(c['ok'] for c in cat['channels'])} из {len(cat['channels'])}")
    return cat


if __name__ == "__main__":
    for u in sys.argv[1:]:
        print(u, probe(u))
