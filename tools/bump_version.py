# -*- coding: utf-8 -*-
"""
BridgeTV — смена версии во всех местах сразу (схема версий — docs/VERSIONING.md).

  python tools/bump_version.py patch   # 0.2.5 -> 0.2.6  мелкие правки и исправления
  python tools/bump_version.py minor   # 0.2.5 -> 0.3.0  глобальное обновление (номер правок обнуляется)
  python tools/bump_version.py major   # 0.2.5 -> 1.0.0  основной полноценный релиз
  python tools/bump_version.py 0.2.7   # задать версию явно

Меняет: web/js/core.js (TV.VERSION), ios/src/main.m (kAppVersion), ios/res/Info.plist
(CFBundleShortVersionString; CFBundleVersion +1), android/app/build.gradle (versionName; versionCode +1),
web/sw.js (имя кэша PWA), desktop/package.json, README.md (строка «Версия»). Номера сборок CFBundleVersion и versionCode только растут — иначе
iOS/Android не поставят обновление поверх.
После: допишите раздел в CHANGELOG.md и шаг в docs/devlog/, затем  git tag v<версия>  и  git push --tags.
"""
import datetime
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def path(*p):
    return os.path.join(ROOT, *p)


def read(p):
    return io.open(path(p), encoding="utf-8").read()


def write(p, s):
    io.open(path(p), "w", encoding="utf-8", newline="\n").write(s)


def current():
    return re.search(r"TV\.VERSION = '([^']+)'", read("web/js/core.js")).group(1)


def next_version(cur, how):
    if re.match(r"^\d+\.\d+\.\d+$", how):
        return how
    a, b, c = [int(x) for x in cur.split(".")]
    if how == "major":
        return "%d.0.0" % (a + 1)
    if how == "minor":
        return "%d.%d.0" % (a, b + 1)
    if how == "patch":
        return "%d.%d.%d" % (a, b, c + 1)
    sys.exit("Укажите patch | minor | major | X.Y.Z")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cur = current()
    new = next_version(cur, sys.argv[1])
    today = datetime.date.today().strftime("%d.%m.%Y")

    s = read("web/js/core.js")
    write("web/js/core.js", re.sub(r"TV\.VERSION = '[^']+'", "TV.VERSION = '%s'" % new, s))

    s = read("ios/src/main.m")
    write("ios/src/main.m", re.sub(r'kAppVersion = @"[^"]+"', 'kAppVersion = @"%s"' % new, s))

    s = read("ios/res/Info.plist")
    s = re.sub(r"(<key>CFBundleShortVersionString</key>\s*<string>)[^<]+", r"\g<1>" + new, s)
    s = re.sub(r"(<key>CFBundleVersion</key>\s*<string>)(\d+)", lambda m: m.group(1) + str(int(m.group(2)) + 1), s)
    write("ios/res/Info.plist", s)

    s = read("android/app/build.gradle")
    s = re.sub(r'versionName "[^"]+"', 'versionName "%s"' % new, s)
    s = re.sub(r"versionCode (\d+)", lambda m: "versionCode %d" % (int(m.group(1)) + 1), s)
    write("android/app/build.gradle", s)

    s = read("web/sw.js")          # новое имя кэша — PWA заберёт свежие файлы
    write("web/sw.js", re.sub(r"var CACHE = 'bridgetv-[^']+'", "var CACHE = 'bridgetv-%s'" % new, s))

    s = read("desktop/package.json")
    write("desktop/package.json", re.sub(r'"version": "[^"]+"', '"version": "%s"' % new, s, count=1))

    s = read("README.md")
    write("README.md", re.sub(r"\| Версия \| \*\*[^*]+\*\* \([^)]*\)", "| Версия | **%s** (%s)" % (new, today), s))

    print("Версия: %s -> %s" % (cur, new))
    print("Дальше: раздел в CHANGELOG.md, шаг в docs/devlog/, затем  git tag v%s && git push --tags" % new)


if __name__ == "__main__":
    main()
