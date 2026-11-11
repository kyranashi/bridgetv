# Smart TV, ПК и другие платформы

| Платформа | Файл | Как поставить |
|---|---|---|
| **Любой ПК** (Windows, macOS, Linux), ноутбук | `BridgeTV-<v>-web.zip` | распаковать → `start-windows.bat` (или `sh start-mac-linux.sh`). Нужен Python 3. Откроется браузер; этот же сервер раздаёт приложение по Wi‑Fi на iPad/телефоны/ТВ |
| Любой браузер онлайн | — | https://kyranashi.github.io/bridgetv/web/ (часть http-каналов на https-странице недоступна) |
| **Samsung Smart TV** (Tizen 2.3+, 2015+) | `BridgeTV-<v>-tizen.wgt` | см. ниже: пакет нужно подписать своим сертификатом |
| **LG Smart TV** (webOS 3+) | `BridgeTV-<v>-webos.ipk` | режим разработчика + `ares-install` (экспериментально) |
| **Android TV**, Xiaomi Mi Box, Fire TV и др. | `BridgeTV-<v>.apk` | см. [ANDROID.md](ANDROID.md) |
| Любой ТВ со встроенным браузером | — | открыть адрес из окна `start-windows.bat` (`http://192.168.x.x:8080/web/`) |

Пакеты собирает `tools/package.py` (CI: `.github/workflows/packages.yml`).

## Samsung (Tizen) — `.wgt`
Samsung не устанавливает неподписанные пакеты. Один раз:
1. Установите **Tizen Studio** + расширение «TV Extensions» и «Samsung Certificate Extension».
2. На ТВ: Apps → набрать на пульте `12345` → Developer mode **On**, IP = адрес ПК → перезагрузить ТВ.
3. В Tizen Studio: Certificate Manager → создать сертификат Samsung (TV) с DUID вашего телевизора.
4. Подписать и установить:
   ```bash
   tizen package -t wgt -s <имя_профиля_сертификата> -- BridgeTV-0.2.5-tizen.wgt
   sdb connect <IP_телевизора>
   tizen install -n BridgeTV-0.2.5-tizen.wgt -t <имя_ТВ_из_sdb_devices>
   ```
Пульт: стрелки, OK, Назад (10009), цифры, CH±, Play/Pause — регистрируются в `web/js/nav.js`.

## LG (webOS) — `.ipk`
1. На ТВ установите приложение **Developer Mode** из LG Content Store, войдите аккаунтом LG Developer, включите Dev Mode и Key Server.
2. На ПК: `npm install -g @webos-tools/cli`, затем
   ```bash
   ares-setup-device          # добавить ТВ по IP с паролем из Developer Mode
   ares-install --device tv BridgeTV-0.2.5-webos.ipk
   ```
Режим разработчика LG действует 50 часов и продлевается в приложении. Пакет собран вручную по формату webOS (ar + control/data) — если `ares-install` откажется, соберите из папки `dist` командой `ares-package` (появится в следующих версиях как основной путь).

## Почему не «одним файлом для всех»
У каждой системы свой формат и своя обязательная подпись: Apple (IPA) — сертификат Apple, Samsung — сертификат Samsung, Android — ключ разработчика. Интерфейс у всех один (`web/`), меняется только упаковка.
