# Шаг 02 — GitHub и сборка .ipa в облаке (0.2.0)

**Запрос.** Выложить проект на GitHub, собрать `.ipa` для iPad.

## Сделано
- Репозиторий (сейчас `kyranashi/bridgetv`), автор коммитов — скрытая почта GitHub.
- `.github/workflows/ios.yml` — сборка `.ipa` на Linux тулчейном clang + ld64 + ldid и iPhoneOS10.3.sdk (последний SDK с armv7).
- `.github/workflows/pages.yml` — веб-версия на GitHub Pages; `catalog.yml` — еженедельное обновление каталога.
- `.gitattributes` — переводы строк LF (иначе `.sh` ломаются на Linux).

## Ошибка, которую поймали до установки
Первая «успешная» сборка содержала функции рантайма, которых нет в iOS 9: `objc_alloc` (iOS 12+) и `objc_unsafeClaimAutoreleasedReturnValue` (iOS 10+). На iPad приложение упало бы при запуске.

Исправление:
```bash
# ios/build.sh
clang -target armv7-apple-ios9.0 -fobjc-runtime=ios-9.0 -fno-objc-convert-messages-to-runtime-calls ...
```
```objc
// ios/src/main.m — clang 11 всё равно вставляет вызов, когда результат метода отбрасывается;
// своя реализация: объект уже в autorelease-пуле, просто вернуть указатель
void *objc_unsafeClaimAutoreleasedReturnValue(void *obj) { return obj; }
```
И автопроверка: `tools/check_ipa.py` разбирает Mach-O и валит сборку, если есть символы iOS 10+ или минимальная версия не 9.0.
