# Шаг 03 — Правовой разбор, хранение данных, работа без ПК (0.2.0)

**Запрос.** Работа только от Wi‑Fi без ПК; юридическая часть (можно ли вставлять YouTube); поиск ошибок.

## Хранение данных через мост
localStorage у страниц из `file://` в WKWebView на iOS 9 ненадёжен — избранное могло пропадать. Теперь в приложении:
```js
// web/js/core.js — TV.store: в приложении данные в памяти + сохранение файлом через мост
if (TV._mem) { TV._mem[k] = s; TV.callNative({ cmd: 'save', key: k, value: s }); return true; }
```
```objc
// ios/src/main.m — TVStoreFiles: Library/Application Support/tvstore/<ключ>.json;
// при запуске всё сохранённое передаётся странице как window.TV_SAVED
```

## Правовое (подробно — [LEGAL.md](../LEGAL.md))
- Вкладка YouTube → «Видео», без логотипа, с оговоркой и выключателем (`settings.showYT`).
- Советское кино — только с официальных каналов киностудий (`TV.yt.studios`, id зафиксированы).
- **Безопасный режим** (`TV.BLOCKLIST`, `TV.blocked()` в `core.js`) скрывает «Дождь», «Настоящее Время» и др.
- Лицензия hls.js приложена.

## Сертификаты
Добавлен корень Sectigo R46 (CDN jsDelivr). Цепочки проверены: Google и wsrv.nl упираются в GlobalSign Root CA (есть в iOS 9), archive.org — GoDaddy (есть).
