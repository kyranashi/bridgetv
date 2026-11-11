# -*- coding: utf-8 -*-
"""
BridgeTV — домашний сервер: раздаёт приложение и ваши фильмы на iPad/телевизор/телефон по Wi‑Fi.

  python tools/serve.py                         # приложение на http://<IP-ПК>:8080/
  python tools/serve.py --media "D:\\Фильмы"     # + папка фильмов на /media/
  python tools/serve.py --port 9000

Откройте на устройстве адрес, который напечатает сервер (ПК и устройство — в одной сети Wi‑Fi).
На iPad: Safari → «Поделиться» → «На экран Домой» — получится приложение на весь экран.

Особенности (почему не просто `python -m http.server`):
  * поддержка Range-запросов — без неё iOS/AVPlayer не играет и не перематывает mp4;
  * /media/?json=1 отдаёт список файлов в JSON для вкладки «Фильмы с ПК»;
  * правильные MIME: .m3u8, .mobileconfig (иначе iOS не предложит установить профиль), .der;
  * многопоточный — несколько устройств смотрят одновременно.
Только стандартная библиотека Python 3.8+. Сервер доступен лишь в вашей локальной сети.
"""
import argparse
import html
import json
import mimetypes
import os
import posixpath
import re
import socket
import sys
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXTRA_TYPES = {
    ".m3u8": "application/vnd.apple.mpegurl", ".m3u": "audio/x-mpegurl", ".ts": "video/mp2t",
    ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
    ".webm": "video/webm", ".mobileconfig": "application/x-apple-aspen-config",
    ".der": "application/x-x509-ca-cert", ".json": "application/json; charset=utf-8",
    ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
}
VIDEO = re.compile(r"\.(mp4|m4v|mov|m3u8|mkv|avi|webm|ts|mp3|m4a)$", re.I)
MEDIA_DIR = None


class Handler(SimpleHTTPRequestHandler):
    server_version = "TV-serve/2.0"

    def log_message(self, fmt, *args):
        sys.stdout.write("  %s  %s\n" % (self.address_string(), fmt % args))

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return EXTRA_TYPES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"

    def translate_path(self, path):
        path = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
        if MEDIA_DIR and (path == "/media" or path.startswith("/media/")):
            base, rel = MEDIA_DIR, path[len("/media"):]
        else:
            base, rel = ROOT, path
        parts = [p for p in posixpath.normpath(rel).split("/") if p and p not in (".", "..")]
        # Безопасность: «C:» или «\» в части пути на Windows позволили бы выйти за пределы папки
        if any(":" in p or "\\" in p for p in parts):
            return os.path.join(base, "__forbidden__")
        return os.path.join(base, *parts)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Accept-Ranges", "bytes")
        if self.path.endswith((".js", ".css", ".html", "/")) or "catalog" in self.path:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        p = self.translate_path(self.path)
        if os.path.isdir(p) and "json=1" in self.path:
            return self.list_json(p)
        if os.path.isfile(p) and "Range" in self.headers:
            return self.send_range(p)
        return super().do_GET()

    def list_json(self, p):
        out = []
        try:
            for name in sorted(os.listdir(p), key=str.lower):
                if name.startswith("."):
                    continue
                full = os.path.join(p, name)
                if os.path.isdir(full):
                    out.append({"name": name, "href": urllib.parse.quote(name) + "/", "dir": True})
                elif VIDEO.search(name):
                    out.append({"name": name, "href": urllib.parse.quote(name), "size": os.path.getsize(full)})
        except OSError:
            return self.send_error(404)
        body = json.dumps(out, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_range(self, p):
        size = os.path.getsize(p)
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        if not m:
            return super().do_GET()
        a, b = m.group(1), m.group(2)
        if a == "":
            start, end = max(0, size - int(b or 0)), size - 1
        else:
            start, end = int(a), (int(b) if b else size - 1)
        end = min(end, size - 1)
        if start > end or start >= size:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.end_headers()
            return
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(p))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(p, "rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(256 * 1024, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass  # плеер закрыл соединение при перемотке — это нормально

    def list_directory(self, path):
        # HTML-список с понятными ссылками (для обычного браузера)
        try:
            names = sorted(os.listdir(path), key=str.lower)
        except OSError:
            self.send_error(404)
            return None
        items = "".join('<li><a href="%s">%s</a></li>' % (
            urllib.parse.quote(n) + ("/" if os.path.isdir(os.path.join(path, n)) else ""), html.escape(n))
            for n in names if not n.startswith("."))
        body = ("<!DOCTYPE html><meta charset=utf-8><title>BridgeTV</title><ul>%s</ul>" % items).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        import io
        return io.BytesIO(body)


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(i for i in ips if not i.startswith("127."))


def main():
    global MEDIA_DIR
    ap = argparse.ArgumentParser(description="BridgeTV — домашний сервер")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--media", default="", help="папка с фильмами (будет доступна на /media/)")
    ap.add_argument("--bind", default="0.0.0.0", help="адрес (0.0.0.0 — вся локальная сеть)")
    a = ap.parse_args()
    if a.media:
        MEDIA_DIR = os.path.abspath(a.media)
        if not os.path.isdir(MEDIA_DIR):
            sys.exit("Нет такой папки: " + MEDIA_DIR)
    srv = ThreadingHTTPServer((a.bind, a.port), Handler)
    print("BridgeTV: сервер запущен. Откройте на iPad / телевизоре / телефоне:")
    for ip in lan_ips() or ["<IP этого ПК>"]:
        print("   http://%s:%d/web/" % (ip, a.port))
        if MEDIA_DIR:
            print("   фильмы:  http://%s:%d/media/   (вставьте во вкладке «Фильмы → Фильмы с компьютера»)" % (ip, a.port))
    print("На этом ПК: http://localhost:%d/web/     Остановить: Ctrl+C" % a.port)
    if os.name == "nt":
        print("Если устройство не открывает адрес — разрешите Python в брандмауэре Windows (частная сеть).")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановлено.")


if __name__ == "__main__":
    main()
