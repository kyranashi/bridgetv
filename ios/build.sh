#!/bin/bash
# Сборка BridgeTV.ipa для iOS 9+ (armv7 + arm64) на Linux / WSL / GitHub Actions.
# Окружение: bash tools/setup_toolchain.sh (один раз).
# Результат: ios/build/BridgeTV.ipa
set -e
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
T=${IOS_TC:-$HOME/iosbuild/tc/linux/iphone/bin}
SDK=${IOS_SDK:-$HOME/iosbuild/sdks/iPhoneOS10.3.sdk}
ARCHS=${ARCHS:-"armv7 arm64"}
APP=build/Payload/BridgeTV.app

rm -rf build && mkdir -p "$APP"

# 1) Компиляция под каждую архитектуру и склейка в «толстый» бинарник
"$T/clang" --version | head -n 1
OBJS=""
for A in $ARCHS; do
  # -fobjc-runtime=ios-9.0 — иначе clang вставит objc_alloc (iOS 12+) и
  # objc_unsafeClaimAutoreleasedReturnValue (iOS 10+), и приложение не запустится на iOS 9
  "$T/clang" -target $A-apple-ios9.0 -fobjc-runtime=ios-9.0 -fno-objc-convert-messages-to-runtime-calls \
    -isysroot "$SDK" -fobjc-arc -fno-objc-exceptions -fno-exceptions \
    -O2 -Wall -Wno-unused-variable -Wno-deprecated-declarations \
    src/main.m -o build/TV-$A \
    -framework UIKit -framework Foundation -framework WebKit -framework AVFoundation \
    -framework Security -framework CoreGraphics -framework QuartzCore \
    -fuse-ld="$T/ld" 2>&1 | grep -v "built for iOS Simulator" || true
  test -f build/TV-$A
  OBJS="$OBJS build/TV-$A"
done
"$T/lipo" -create $OBJS -output "$APP/BridgeTV" 2>/dev/null || cp build/TV-armv7 "$APP/BridgeTV"

# 2) Ресурсы: иконки, Info.plist
cp res/* "$APP/"

# 3) Веб-интерфейс и каталог (www/web, www/data). hls.js на iOS не нужен — HLS играет система.
mkdir -p "$APP/www/data"
cp -R "$ROOT/web" "$APP/www/web"
rm -rf "$APP/www/web/vendor"
cp "$ROOT/data/catalog.js" "$APP/www/data/catalog.js"
cp -R "$ROOT/data/logos" "$APP/www/data/logos"   # встроенные иконки каналов РФ/РБ (tools/build_logos.py)

# 4) Пометка «современный SDK» (минимальная iOS остаётся 9.0) — полный экран на новых iPhone/iPad
python3 "$ROOT/tools/set_sdk_version.py" "$APP/BridgeTV" 14.0

# 5) Подпись: fakesign (ldid) — для джейлбрейка с AppSync. Без джейлбрейка .ipa переподписывают
#    Sideloadly / AltStore / TrollStore своим Apple ID — см. docs/IOS.md
"$T/ldid" -S "$APP/BridgeTV"

(cd build && zip -qr BridgeTV.ipa Payload)
ls -la build/BridgeTV.ipa

# 5) Совместимость с iOS 9: min version и отсутствие символов iOS 10+
python3 "$ROOT/tools/check_ipa.py" build/BridgeTV.ipa
