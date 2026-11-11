# Архитектура и описание кода

## 1. Идея

Один интерфейс на все платформы + тонкие нативные оболочки там, где браузеру не хватает возможностей.

```
                ┌────────────────────────── web/ (ES5, без фреймворков) ──────────────────────────┐
                │  app.js (экраны) · player.js · nav.js (пульт) · services.js · data.js · core.js │
                └───────────────┬─────────────────────────┬──────────────────────────┬─────────────┘
                                │                         │                          │
             iOS-приложение (ios/src/main.m)     Браузер / «На экран Домой»     Smart TV / Android
             WKWebView + мост «tv»:              Safari iOS 9+, Chrome,         браузер или WebView
             • fetch без CORS и с корнями        Firefox, Edge, Android 4.4+    (см. PLATFORMS.md)
               Let's Encrypt для iOS 9
             • экран не гаснет, профиль
               сертификатов одной кнопкой
                                │                         │
                                └──────────┬──────────────┘
                                           ▼
          data/catalog.json|js  ←  tools/build_catalog.py + check_streams.py  ←  iptv-org
          YouTube: официальный плеер (IFrame) + Data API/RSS или своё зеркало  ·  Фильмы: archive.org  ·  Фильмы с ПК: tools/serve.py
```

Почему так, а не полностью нативно (как в v1.0):
- **Разные платформы** — один код интерфейса работает на iPad, Android, ТВ и ПК; нативная часть iOS — ~330 строк.
- **Старая техника** — веб-код написан на ES5 и строит разметку строками (быстро даже без JIT), есть «лёгкий режим».
- **Обновления без переустановки** — каталог каналов скачивается из репозитория.
- iOS 9 сам проигрывает HLS (AVFoundation внутри `<video>`), поэтому на iPad видео декодируется аппаратно, как и в нативном плеере.

## 2. Веб-интерфейс (`web/`)

Скрипты подключаются по порядку в `web/index.html`, всё живёт в глобальном объекте `TV` (историческое внутреннее имя; название приложения — BridgeTV).

| Файл | Ответственность | Ключевое |
|---|---|---|
| `../data/catalog.js` | Каталог каналов (`window.TV_CATALOG`) | генерируется, не править руками |
| `js/core.js` | Утилиты, сеть, хранилище, профиль устройства, настройки, события, мост к iOS | `TV.ajax`, `TV.store`, `TV.device`, `TV.settings`, `TV.lite()`, `TV.native`, `TV.callNative`, `TV.toast` |
| `js/data.js` | Модель данных | `TV.catalog`, `TV.health`, `TV.fav`, `TV.history`, `TV.positions`, `TV.searches`, `TV.links`, `TV.playlists`, `TV.parseM3U` |
| `js/services.js` | Внешние сервисы | `TV.yt` (поиск, тренды, эфиры, каналы, подсказки, поток), `TV.subs`, `TV.arch`, `TV.pc` |
| `../data/logos/` | Встроенные иконки каналов РФ/РБ 80×80 (поле `li` у канала) | `chLogo()` в app.js: иконка → логотип из сети → буквы |
| `js/films.js` | Фильмы: жанры, годы, страны, общий поиск YouTube + архив, Google, загрузки | `TV.films.search()`, `TV.dl.start()`, `TV.nativeEvent()` |
| `js/scan.js` | Проверка каналов на самом устройстве (только в приложении) | `TV.scan.start()`, `TV.scan.auto()`, прогресс через событие `scan` |
| `js/player.js` | Полноэкранный плеер | `TV.player.open(items, index)`, перебор источников, hls.js, позиции |
| `js/nav.js` | Пульт и клавиатура | пространственная навигация, клавиши ТВ |
| `js/app.js` | Экраны и навигация | `TV.app.start()`, `S.<экран>()`, `act()` |

### 2.1. Универсальная карточка (item)

Все экраны, плеер, избранное и история обмениваются одной структурой:

```js
{ k: 'ch' | 'yt' | 'ytc' | 'url' | 'arch' | 'pc',   // тип
  id: '…',            // id канала каталога / видео / канала YouTube / фильма архива
  n: 'Название', sub: 'подпись', img: 'картинка',
  u: 'ссылка',        // для url / pc
  live: true,         // эфир
  len: 1234 }         // длительность, с
```
Телеканал каталога (`k:'ch'`) в списках передаётся целиком (с вариантами `v`), а в избранном/истории — только `{k:'ch', id}` и находится через `TV.catalog.byId()`.

### 2.2. Каталог (`TV.catalog`)

- `load()` — берёт встроенный `TV_CATALOG` или более свежий из `localStorage('tv.catalog')`, добавляет «Мои плейлисты» (регион `my`), строит индекс поиска (`_s` = нормализованное имя + транслит + id).
- `list({region, cat, onlyWorking})` — фильтрация. `region:'all'` = все основные (РФ+РБ).
- `primary()` / `extra()` — основные регионы и «Дополнительно».
- `search(q)` — по словам, транслиту, номеру канала и категории; рейтинг: начало названия → основной регион → рабочий.
- `update(url)` — скачать новый каталог и сохранить локально.

### 2.3. «Здоровье» ссылок (`TV.health`) — почему нерабочие каналы не мешают

Два источника знаний:
1. **Проверка каталога** (`tools/check_streams.py`): у каждого варианта `s` (1 рабочий, 2 медленный, 3 гео/запрет, −1 мёртвый), у канала `ok` (1/0). Варианты уже отсортированы: быстрые рабочие — первыми.
2. **Опыт этого устройства** (`localStorage('tv.health')`): `{url: {s: 1|-1, t: время, f: сбоев подряд}}`. Пишется плеером.

Правила:
- `channelAlive(c)`: работал у нас за 14 дней → жив; каталог говорит `ok:0` → мёртв; все варианты падали у нас за 3 дня → мёртв.
- `variants(c)`: порядок перебора — «работал у нас» → «по каталогу» → «гео/мёртв по каталогу» → «падал у нас».
- Отметки устаревают сами, так что ожившие ссылки возвращаются в списки.

### 2.4. Плеер (`TV.player`)

`open(items, index)` → `playCurrent()`:
- телеканал → `TV.health.variants()` → `tryVariant()` по очереди;
- YouTube / архив → `TV.yt.resolve()` / `TV.arch.resolve()` → одна ссылка → `tryVariant()`.

`tryVariant()`:
1. На https-странице `http://` меняется на `https://` (иначе браузер заблокирует смешанное содержимое).
2. `load(url, headers, force)` выбирает движок: встроенный HLS (`<video src>`: iOS, Safari, новый Chrome) или **hls.js** (браузеры с MSE без встроенного HLS; для YouTube предпочитается hls.js — у YouTube раздельные дорожки звука и видео).
3. Таймер `settings.timeout` (+4 с в лёгком режиме). Событие `playing` = успех → `health.mark(url, true)`.
4. Ошибка/таймаут → `fail()`: сперва тот же источник другим движком, потом следующий вариант, потом сообщение с кнопками «Ещё раз», «Следующий», «Скрыть канал», «Открыть на YouTube».

Прочее: свайпы (◀ ▶ канал, вниз — закрыть), боковой список каналов, набор номера (`P.digit`), позиции фильмов каждые 5 с (`TV.positions`), в лёгком режиме hls.js стартует с минимального качества и ограничен 480p.

### 2.5. YouTube (`TV.yt`)

С 0.3.0 — три режима, `TV.yt.mode()` выбирает по устройству и настройке `ytSource` (подробно — [YOUTUBE.md](YOUTUBE.md)):

| Режим | Данные | Плеер |
|---|---|---|
| `official` | YouTube Data API v3 с ключом пользователя (`apiCached()`, кэш 6 ч, `normApi()`), RSS-ленты каналов (`channel()` → `rss()`), подсказки `suggestqueries` | `web/yt.html` (IFrame API) во `iframe.p-embed`, события через `postMessage` с проверкой origin (`player.js: playEmbed`) |
| `mirror` | своё Invidious/Piped (`normI`, `normP`) | `resolve(id)` → mp4/HLS в обычном плеере, качество/озвучка/субтитры ⚙ |
| `none` | — | — |

- `embedOk()` — официальный плеер не работает на iOS < 12 и Android < 5.
- `TV.yt.feeds` — подборки официальных каналов, `TV.yt.feed()` сливает ленты и сортирует по дате.
- `yt.html` лежит на GitHub Pages (`TV.PAGES`), потому что YouTube требует у встроенного плеера настоящий Referer, а у страниц из `file://` и своих схем его нет.
- Превью — с `i.ytimg.com`.

### 2.5b. Функции 1.0.0

| Функция | Где | Как |
|---|---|---|
| Программа передач | `tools/build_epg.py` → GitHub Pages `data/epg.json`; `data.js: TV.epg` | в памяти, обновление раз в 6 ч; `player.js: chSub/openGuide`, `app.js: epgNow` |
| Перемотка эфира | `player.js: dvrWindow/liveTick/P.liveSeek` | окно `video.seekable` > 60 с → классы `dvr`, `behind` |
| Следующая серия | `player.js: nextSoon` | 5-секундный отсчёт, настройка `nextEp` |
| Детский режим | `core.js: TV.blocked`, `app.js: feedsList/archList/ytSearchShelves/pinGate/S.pin` | только `kids`, PIN |
| Крупный текст | `core.js: applyMode` + CSS `zoom` | классы `font115`, `font130` |
| Перенос избранного | `app.js: exportBackup/importBackup/S.backup` | `BTV1:` + base64(JSON) |
| Голосовой поиск | `app.js: voiceOk/startVoice`; Android `MainActivity.startVoice` | Web Speech API или `RecognizerIntent` → `TV.nativeEvent('voice')` |

### 2.5a. Возможности устройства (`TV.caps`, с 0.3.0)

`core.js` проверяет `canPlayType` и `MediaSource.isTypeSupported`: `h264`, `hevc`, `vp9`, `av1`, `webm`, `mkv`, `hls`, `maxH` (720 на старых, 1080, 2160 на 4K-экранах с HEVC/VP9). `TV.caps.file(name)` — сможет ли устройство сыграть файл (используют фильмы с ПК). Показывается в Настройках → «Ваше устройство».

### 2.6. Фильмы

- `TV.arch` — archive.org: полки (`advancedsearch` по коллекциям общественного достояния), поиск, `resolve()` выбирает mp4 (в лёгком режиме — самый маленький). Семейный фильтр по названию.
- `TV.pc` — папка по сети: JSON от `tools/serve.py` (`?json=1`) или HTML-список любого http-сервера.
- `TV.links` / `TV.playlists` — свои ссылки и M3U (плейлисты становятся регионом «Мои плейлисты»).

### 2.7. Экраны (`TV.app`)

- 6 вкладок, у каждой свой стек экранов `stacks[tab] = [{s:'tv'}, {s:'region', id:'ua'}…]`; позиция прокрутки сохраняется.
- `S.<имя>(params)` возвращает `{title, html, right?, after?}`; `render()` вставляет разметку; `after()` догружает полки (YouTube, архив) и заменяет заглушки через `fill(id, html)`, только если экран ещё открыт.
- Все клики — один обработчик по `data-a` (действие) / `data-x` (аргумент) → `act()`. Формы — `data-form`, настройки — `data-set`.
- Списки для плеера регистрируются `reg(id, items)`; карточка хранит `data-l` (id списка) и `data-i` (индекс) — плеер получает весь список для переключения ◀ ▶.
- Длинные списки выводятся порциями (48 в лёгком режиме, 120 в полном) с кнопкой «Показать ещё» — DOM остаётся маленьким.
- Долгое нажатие (600 мс) или правая кнопка мыши на карточке — в избранное.
- Экраны: `tv`, `region`, `search`, `yt`, `ytlist`, `ytch`, `movies`, `archlist`, `pc`, `fav`, `more`, `extra`, `dead`, `settings`, `help`.

### 2.8. Пульт (`nav.js`)

Стрелки двигают фокус к ближайшему элементу в направлении (вес поперечного смещения ×2,5); полки прокручиваются за фокусом. Коды «Назад» Tizen (10009) и webOS (461), CH± (427/428), медиаклавиши. В плеере: ▲▼/CH± — канал, ◀▶ — канал или перемотка, цифры — номер, OK — панель, пробел — пауза.

### 2.9. Хранилище (`localStorage`, префикс `tv.`)

| Ключ | Что |
|---|---|
| `settings` | настройки (`TV.defaults`) |
| `catalog` | скачанный каталог (если новее встроенного) |
| `health` | отметки ссылок |
| `fav`, `hist`, `pos`, `searches` | избранное, история (40), позиции фильмов, запросы (15) |
| `links`, `playlists`, `subs` | свои ссылки, M3U-плейлисты, подписки YouTube |
| `ytInstances`, `ytActive`, `ytDiscoverT` | зеркала YouTube |
| `pcUrl` | адрес «Фильмы с ПК» |

Все обращения обёрнуты в try/catch (приватный режим Safari, переполнение).

### 2.10. Правила кода (веб)

ES5 для Safari iOS 9 и старых ТВ: нет `let/const`, стрелок, шаблонных строк, `fetch`, `Promise`-цепочек, `Array.find/includes`, `Element.closest`, `Object.assign`, `NodeList.forEach`; есть замены `TV.find`, `TV.filter`, `TV.closest`, `TV.extend`. CSS: без grid, без `gap` у flex, без CSS-переменных, с префиксами `-webkit-` для flex/transform. Пользовательский текст — через `TV.esc()`.

## 3. iOS-оболочка (`ios/src/main.m`)

| Класс | Что делает |
|---|---|
| `TVTrust` | общий `NSURLSession`. Делегат доверия: сначала обычная проверка iOS; если корень неизвестен — та же проверка с корнями ISRG (X1, X2, YR, YE) из `www/web/certs/*.der` как доверенными. Чужие сертификаты не принимаются |
| `TVProfileServer` | однократный HTTP-сервер на `127.0.0.1:<случайный порт>` на 60 с: отдаёт `BridgeTV-roots.mobileconfig` и открывает Safari — так iOS предлагает установить профиль |
| `TVWebVC` | `WKWebView` с `www/web/index.html` (`loadFileURL`), внедряет `window.TV_NATIVE`, мост `tv`, открывает внешние ссылки в Safari, перезагружается при падении процесса WebKit (нехватка памяти) |
| `TVWeakHandler` | разрывает цикл удержания `WKUserContentController` → контроллер |
| `TVLocalServer` | HTTP-сервер на 127.0.0.1:18080–18099: `/hls` — переписанный плейлист YouTube (качество, только H.264, озвучка/субтитры по умолчанию), `/file/<имя>` — скачанные фильмы с Range | `TVRewriteMaster()` |
| `TVDownloads` | загрузки mp4 через NSURLSession в `Documents/BridgeTV-downloads`, события прогресса в JS | `TV.nativeEvent('dl', …)` |
| `AppDelegate` | аудиосессия `Playback` (звук при беззвучном режиме), кэш URL, окно |

Мост (JS → натив): `{cmd:'fetch', id, url, timeout, method, body}` → ответ `TV.nativeCb(id, err, text, status)`; `{cmd:'awake', on}`; `{cmd:'open', url}`; `{cmd:'certs'}`. В JS `TV.ajax` сам выбирает мост, если `TV.native`.

**Защита моста (0.3.0):** команды принимаются только от главного фрейма (`frameInfo.isMainFrame`); адреса для `fetch`, `open`, `download` — только http/https (`TVWebURLFrom`); метод — только GET/POST; главная страница не уходит на чужие сайты (`decidePolicyForNavigationAction`). Те же правила — в Android (`Bridge.isWeb`, лимиты размеров) и в программе для ПК (`desktop/main.js`, [DESKTOP.md](DESKTOP.md)). Кроме того, `web/index.html` задаёт Content Security Policy, а `TV.catalog.valid()` проверяет структуру скачанного каталога.

## 4. Инструменты (`tools/`)

- `build_catalog.py` — скачивает плейлисты iptv-org по странам и категориям, объединяет ссылки одного канала в варианты, берёт кириллические названия из метаданных, сортирует «как на пульте» (`RU_TOP`, `BY_TOP`), добавляет `data/sources_extra.json`, нумерует, вызывает проверку, пишет `catalog.json` и `catalog.js`. Подробно — [CATALOG.md](CATALOG.md).
- `build_logos.py` — дополняет логотипы из базы iptv-org и делает встроенные иконки 80×80 для РФ/РБ (Pillow; заглушки imgur отбрасываются).
- `check_streams.py` — проверка «глазами iPad» (User-Agent AppleCoreMedia, master → самый лёгкий не-HEVC вариант → media-плейлист → 2 КБ первого сегмента), 48 потоков.
- `serve.py` — домашний сервер: Range-запросы (без них iOS не играет mp4), JSON-список папки, MIME для `.m3u8`/`.mobileconfig`, многопоточность.
- `make_cert_profile.py` — профиль `.mobileconfig` из `web/certs/*.der`.
- `setup_toolchain.sh` — clang + ld64 + ldid + iPhoneOS10.3.sdk на Linux.

## 5. Потоки данных: что происходит при нажатии на канал

```
карточка (data-l, data-i) → act('play') → TV.player.open(lists[l], i)
 → playCurrent(): ch = item; variants = TV.health.variants(ch); история += ch
 → tryVariant(0): load(url) → <video>/hls.js; таймер 12 с
     ├─ 'playing' → health.mark(url, ok) → скрыть индикатор, через 4,5 с спрятать панель
     └─ ошибка/таймаут → другой движок → tryVariant(1) → … → сообщение с кнопками
 → закрытие: позиция фильма, TV.awake(false), перерисовка экрана (обновлённые статусы)
```
