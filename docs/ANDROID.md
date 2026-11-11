# Android: телефоны, планшеты, Android TV, ТВ-приставки

| | |
|---|---|
| Файл | `BridgeTV-<версия>.apk` (GitHub → Releases или артефакт «Сборка Android») |
| Android | **4.4 KitKat (API 19) и новее**, вплоть до Android 15 |
| Устройства | телефоны, планшеты, **Android TV** и приставки (иконка в меню ТВ, управление пультом) |
| ID пакета | `com.kyranashi.bridgetv` |
| Код | `android/` (Java, без сторонних библиотек) + общий интерфейс `web/` |

## Установка
1. Скачайте `.apk` на устройство (или перекиньте с ПК).
2. Откройте файл → разрешите «Установку из неизвестных источников» для браузера/файлового менеджера (Android 8+ спросит сам; на Android 4.4–7 — Настройки → Безопасность → Неизвестные источники).
3. Android TV / приставка: удобнее всего через приложение «Send Files to TV» или флешку + файловый менеджер; либо `adb install BridgeTV.apk`.
4. Обновление — так же, поверх (если версии подписаны одним ключом, см. ниже).

## Как устроено
| Файл | Что делает |
|---|---|
| `MainActivity.java` | WebView с `assets/www/web/index.html`, полноэкранное видео, кнопка «Назад» (по экранам приложения, на главном — выход), поворот без перезапуска (`configChanges`), на Android < 7.1 — пропуск HTTPS-трансляций с сертификатами Let's Encrypt (только их) |
| `Bridge.java` | мост `window.TVAndroid`: `info()`, `saved()` (синхронно), `postMessage`: `fetch` (без CORS; TLS 1.2 на 4.4; корни Let's Encrypt из `web/certs` для Android < 7.1), `save` (файлы `files/tvstore`), `awake` (не гасить экран), `open`, `download`/`dlDelete` (фильмы в папке приложения, события `TV.nativeEvent('dl', …)`) |
| `app/build.gradle` | копирует `web/` и `data/catalog.js`, `data/logos/` в `assets/www` при сборке; minSdk 19, targetSdk 34 |
| `AndroidManifest.xml` | интернет, без обязательного сенсорного экрана, `LEANBACK_LAUNCHER` и баннер для Android TV, разрешён http (многие трансляции по http) |

В JavaScript (`web/js/core.js`) Android-оболочка определяется по `window.TVAndroid`: `TV.platform === 'android'`, `TV.native === true`, все запросы идут через мост. Качество/озвучку/субтитры YouTube на Android выбирает hls.js (как в браузере), загрузки играются по `file://`-адресу (`TV_NATIVE.fileBase`).

## Сборка
- **GitHub Actions** (`.github/workflows/android.yml`): Java 17, Gradle 8.5, Android Gradle Plugin 8.2 → `BridgeTV-apk`. Push в `main` по путям `android/`, `web/`, `data/` и теги `v*` (APK в релизе).
- **Локально** (нужны JDK 17 и Android SDK): `gradle -p android assembleRelease` → `android/app/build/outputs/apk/release/app-release.apk`.

## Подпись (важно для обновлений)
Android ставит обновление поверх, только если оно подписано **тем же ключом**.
- Ключ проекта создан 10.11.2026 и лежит **только у владельца**: `releases/android-signing/bridgetv-release.p12` и пароль в `PASSWORD.txt` (папка не попадает в git). **Сохраните копию** — без ключа обновления придётся ставить с удалением старой версии.
- Чтобы CI подписывал этим ключом, добавьте два секрета репозитория (один раз, в PowerShell):
  ```powershell
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("releases\android-signing\bridgetv-release.p12")) | gh secret set ANDROID_KEYSTORE_B64 -R kyranashi/bridgetv
  gh secret set ANDROID_KS_PASS -R kyranashi/bridgetv     # вставить пароль из PASSWORD.txt
  ```
  или через сайт: Settings → Secrets and variables → Actions → New repository secret.
- Пока секретов нет, CI подписывает **отладочным ключом** из своего кэша (одинаковым между сборками, пока кэш жив — до 7 дней без сборок).

## Ограничения
- Android 4.4–6: старый встроенный WebView без обновлений. Видео HLS идёт встроенным плеером или hls.js, если WebView поддерживает MSE. На Android 5+ WebView обновляется через Google Play — обновите «Android System WebView».
- Проверка каналов на устройстве (`scan.js`) и загрузки работают через мост — как на iOS.
