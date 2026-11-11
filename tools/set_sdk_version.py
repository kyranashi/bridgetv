# -*- coding: utf-8 -*-
"""
BridgeTV — пометить бинарник iOS как собранный под современный SDK (с 0.2.5).

Зачем: приложение собирается SDK iOS 10.3 (последний с armv7 для iPad mini 1). Новые iOS
показывают такие «старые» приложения в режиме совместимости: на iPhone с «чёлкой» — в рамке,
без использования всего экрана. В Mach-O-заголовке (LC_VERSION_MIN_IPHONEOS) есть два поля:
  version — минимальная iOS (остаётся 9.0, иначе не запустится на iPad mini 1);
  sdk     — версия SDK, под которую «собрано» (меняем на 14.0).
Вместе с ключом UILaunchScreen в Info.plist это включает полноэкранный режим на новых устройствах.
Старые iOS поле sdk не проверяют.

Запуск: python tools/set_sdk_version.py <бинарник> [14.0]   — выполняется в ios/build.sh до подписи.
"""
import struct
import sys

LC_VERSION_MIN_IPHONEOS = 0x25


def patch_slice(buf, off, sdk):
    magic = struct.unpack_from("<I", buf, off)[0]
    is64 = magic == 0xFEEDFACF
    ncmds = struct.unpack_from("<I", buf, off + 16)[0]
    p = off + (32 if is64 else 28)
    done = 0
    for _ in range(ncmds):
        cmd, size = struct.unpack_from("<II", buf, p)
        if cmd == LC_VERSION_MIN_IPHONEOS:
            struct.pack_into("<I", buf, p + 12, sdk)
            done += 1
        p += size
    return done


def main():
    path = sys.argv[1]
    major, minor = (sys.argv[2] if len(sys.argv) > 2 else "14.0").split(".")[:2]
    sdk = (int(major) << 16) | (int(minor) << 8)
    buf = bytearray(open(path, "rb").read())
    total = 0
    if struct.unpack_from(">I", buf, 0)[0] == 0xCAFEBABE:      # «толстый» бинарник: armv7 + arm64
        n = struct.unpack_from(">I", buf, 4)[0]
        for i in range(n):
            off = struct.unpack_from(">I", buf, 8 + i * 20 + 8)[0]
            total += patch_slice(buf, off, sdk)
    else:
        total += patch_slice(buf, 0, sdk)
    open(path, "wb").write(buf)
    print("SDK %s.%s записан в %d срез(а)" % (major, minor, total))
    return 0 if total else 1


if __name__ == "__main__":
    sys.exit(main())
