#!/bin/bash
# Установка окружения сборки под Linux x86_64 (проверено 09.11.2026).
# Результат: $HOME/iosbuild/tc (clang + ld64 + ldid) и iPhoneOS10.3.sdk (есть armv7).
set -e
mkdir -p "$HOME/iosbuild" && cd "$HOME/iosbuild"
# 1) Тулчейн (clang 11 + ld64-609 + ldid) от L1ghtmann (используется theos)
curl -L -o tc.tar.xz https://github.com/L1ghtmann/llvm-project/releases/latest/download/iOSToolchain-x86_64.tar.xz
mkdir -p tc && tar -xJf tc.tar.xz -C tc
# 2) SDK iOS 10.3 (последний SDK со слайсами armv7 в .tbd)
git clone --depth 1 --filter=blob:none --sparse https://github.com/theos/sdks.git sdks
cd sdks && git sparse-checkout set iPhoneOS10.3.sdk && cd ..
# 3) Патч: в SDK из theos вырезаны armv7-only символы рантайма objc (_stret).
TBD=sdks/iPhoneOS10.3.sdk/usr/lib/libobjc.A.tbd
python3 - "$TBD" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
if "_objc_msgSend_stret" not in s:
    extra="""  - archs:                [ armv7, armv7s ]
    symbols:              [ _objc_msgSend_stret, _objc_msgSendSuper_stret,
                            _objc_msgSendSuper2_stret, _objc_msgForward_stret,
                            _objc_msgSend_stret_debug, _objc_msgSendSuper2_stret_debug ]
"""
    i=s.rstrip().rfind("..."); s=s[:i]+extra+s[i:]; open(p,"w").write(s)
PY
echo "Готово. Сборка: bash src/build.sh"
# Ограничения стабов: не использовать @try/@catch, оператор % для знаковых чисел,
# литерал @[] (символ ___NSArray0__ есть только с iOS 10) — см. README.
