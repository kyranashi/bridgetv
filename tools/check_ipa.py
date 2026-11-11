# -*- coding: utf-8 -*-
"""
Проверка BridgeTV.ipa на совместимость с iOS 9 (без otool/nm — работает и на Windows).

Для каждой архитектуры в бинарнике:
  * LC_VERSION_MIN_IPHONEOS должен быть 9.0;
  * среди внешних символов не должно быть тех, что появились в iOS 10+ —
    иначе приложение упадёт при запуске на iPad mini 1 (dyld: Symbol not found).

Запуск:  python tools/check_ipa.py ios/build/BridgeTV.ipa      (код выхода 1 — есть проблемы)
"""
import re
import struct
import sys
import zipfile

MIN_OS = "9.0"
# Символы рантайма, которых нет в iOS 9 (clang вставляет их сам при новом таргете/рантайме)
FORBIDDEN = re.compile(
    r"^(_objc_alloc|_objc_alloc_init|_objc_opt_\w+|_objc_unsafeClaimAutoreleasedReturnValue|"
    r"___NSArray0__|___NSDictionary0__|___isPlatformVersionAtLeast|___isOSVersionAtLeast|"
    r"_objc_retainAutoreleasedReturnValue_?\w*Claim\w*)$")
CPU = {0xC: "armv7", 0x100000C: "arm64"}


def slices(b):
    if struct.unpack(">I", b[:4])[0] == 0xCAFEBABE:
        n = struct.unpack(">I", b[4:8])[0]
        for i in range(n):
            cpu, _sub, off, size, _al = struct.unpack(">5I", b[8 + i * 20:28 + i * 20])
            yield cpu, b[off:off + size]
    else:
        yield struct.unpack("<I", b[4:8])[0], b


def inspect(m):
    is64 = struct.unpack("<I", m[:4])[0] == 0xFEEDFACF
    ncmds = struct.unpack("<I", m[16:20])[0]
    p, minver, und = (32 if is64 else 28), None, []
    for _ in range(ncmds):
        cmd, sz = struct.unpack("<2I", m[p:p + 8])
        if cmd == 0x25:  # LC_VERSION_MIN_IPHONEOS
            v = struct.unpack("<I", m[p + 8:p + 12])[0]
            minver = "%d.%d" % (v >> 16, (v >> 8) & 255)
        elif cmd == 0x32:  # LC_BUILD_VERSION
            v = struct.unpack("<I", m[p + 12:p + 16])[0]
            minver = "%d.%d" % (v >> 16, (v >> 8) & 255)
        elif cmd == 0x2:  # LC_SYMTAB
            symoff, nsyms, stroff, _ = struct.unpack("<4I", m[p + 8:p + 24])
            es = 16 if is64 else 12
            for i in range(nsyms):
                e = m[symoff + i * es: symoff + (i + 1) * es]
                strx, ntype = struct.unpack("<IB", e[:5])
                if (ntype & 0x0E) == 0 and (ntype & 1):  # N_UNDF | N_EXT
                    und.append(m[stroff + strx: m.index(b"\0", stroff + strx)].decode())
        p += sz
    return minver, und


def main(path):
    z = zipfile.ZipFile(path)
    # бинарник: Payload/<Имя>.app/<Имя> (имя приложения может меняться)
    exe = next(n for n in z.namelist() if re.match(r"^Payload/([^/]+)\.app/\1$", n))
    b = z.read(exe)
    ok = True
    for cpu, m in slices(b):
        minver, und = inspect(m)
        bad = [s for s in und if FORBIDDEN.match(s)]
        print("%-6s min iOS %s, внешних символов %d%s" % (
            CPU.get(cpu, hex(cpu)), minver, len(und), (", ЗАПРЕЩЕНЫ: " + ", ".join(bad)) if bad else ", ок"))
        if bad or minver != MIN_OS:
            ok = False
    print("OK: совместимо с iOS 9" if ok else "ОШИБКА: сборка не запустится на iOS 9")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "ios/build/BridgeTV.ipa"))
