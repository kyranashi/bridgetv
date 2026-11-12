/*
 * BridgeTV — фильмы: поиск с фильтрами и загрузки (с версии 0.2.4).
 *
 *   TV.films.search(q, f, cb) — общий поиск фильмов по двум источникам:
 *       • YouTube — только длинные ролики (от 20 минут): фильмы и сериалы, в т.ч. официальные
 *         каналы киностудий; запрос дополняется жанром, годами и происхождением;
 *       • Архив кино (archive.org) — фильмы в общественном достоянии: жанр — по полю subject,
 *         годы — по полю year. Для «Советские и российские» архив не используется (там они,
 *         как правило, выложены без прав — см. docs/LEGAL.md).
 *     f: { genre: id, years: id, origin: 'all'|'su'|'foreign' }
 *   TV.films.google(q) — открыть поиск Google в браузере (Safari).
 *   TV.dl — загрузки на устройство (только в приложении, через нативный мост):
 *       скачиваются только mp4: фильмы Архива кино (общественное достояние), свои ссылки и файлы с ПК.
 *       Видео YouTube не скачиваются — это запрещают правила YouTube.
 */
(function () {
  var F = TV.films = {};

  F.genres = [
    { id: 'all', name: 'Все жанры' },
    { id: 'comedy', name: 'Комедия', q: 'комедия', arch: 'comedy' },
    { id: 'drama', name: 'Драма', q: 'драма', arch: 'drama' },
    { id: 'action', name: 'Боевик', q: 'боевик', arch: 'action' },
    { id: 'scifi', name: 'Фантастика', q: 'фантастика', arch: '"science fiction" OR sci-fi' },
    { id: 'horror', name: 'Ужасы', q: 'ужасы', arch: 'horror' },
    { id: 'crime', name: 'Детектив', q: 'детектив', arch: 'mystery OR crime OR noir' },
    { id: 'romance', name: 'Мелодрама', q: 'мелодрама', arch: 'romance' },
    { id: 'war', name: 'Военный', q: 'военный фильм', arch: 'war' },
    { id: 'adventure', name: 'Приключения', q: 'приключения', arch: 'adventure' },
    { id: 'western', name: 'Вестерн', q: 'вестерн', arch: 'western' },
    { id: 'toon', name: 'Мультфильм', q: 'мультфильм', arch: '' },
    { id: 'anime', name: 'Аниме', q: 'аниме фильм', arch: 'anime' },
    { id: 'thriller', name: 'Триллер', q: 'триллер', arch: 'thriller OR suspense' },
    { id: 'fantasy', name: 'Фэнтези', q: 'фэнтези', arch: 'fantasy' },
    { id: 'family', name: 'Семейный', q: 'семейный фильм', arch: 'family' },
    { id: 'history', name: 'Исторический', q: 'исторический фильм', arch: 'history OR historical' },
    { id: 'bio', name: 'Биография', q: 'биографический фильм', arch: 'biography' },
    { id: 'musical', name: 'Мюзикл', q: 'мюзикл', arch: 'musical' },
    { id: 'sport', name: 'Спорт', q: 'фильм про спорт', arch: 'sports' },
    { id: 'series', name: 'Сериалы', q: 'сериал все серии', arch: 'television' },
    { id: 'docs', name: 'Документальный', q: 'документальный фильм', arch: 'documentary' }
  ];
  F.yearsList = [
    { id: 'all', name: 'Любые годы' },
    { id: '2020', name: '2020-е', from: 2020, to: 2029, q: '2020-х' },
    { id: '2010', name: '2010-е', from: 2010, to: 2019, q: '2010-х' },
    { id: '2000', name: '2000-е', from: 2000, to: 2009, q: '2000-х' },
    { id: '1990', name: '90-е', from: 1990, to: 1999, q: '90-х' },
    { id: '1980', name: '80-е', from: 1980, to: 1989, q: '80-х' },
    { id: '1970', name: '70-е', from: 1970, to: 1979, q: '70-х' },
    { id: '1960', name: '60-е', from: 1960, to: 1969, q: '60-х' },
    { id: '1950', name: '50-е', from: 1950, to: 1959, q: '50-х' },
    { id: 'old', name: 'До 1950', from: 1890, to: 1949, q: 'старый' }
  ];
  F.origins = [
    { id: 'all', name: 'Все страны' },
    { id: 'su', name: 'Советские и российские', q: 'советский' },
    { id: 'foreign', name: 'Зарубежные', q: 'зарубежный' }
  ];
  F.genre = function (id) { return TV.find(F.genres, function (g) { return g.id === id && id !== 'all'; }); };
  F.years = function (id) { return TV.find(F.yearsList, function (y) { return y.id === id && id !== 'all'; }); };
  F.origin = function (id) { return TV.find(F.origins, function (o) { return o.id === id && id !== 'all'; }); };

  /* Текст запроса к YouTube: «<запрос> <жанр> <происхождение> <годы> фильм» */
  function ytQuery(q, f) {
    var g = F.genre(f.genre), y = F.years(f.years), o = F.origin(f.origin), parts = [];
    if (q) parts.push(q);
    if (o) parts.push(o.q);
    if (g) parts.push(g.q);
    if (y) parts.push(y.q);
    if (!q || g || y || o) parts.push(g && g.id === 'toon' ? '' : 'фильм');
    parts.push('полностью');
    return parts.join(' ').replace(/\s+/g, ' ');
  }

  /* cb(частичный результат) вызывается дважды: когда ответит YouTube и когда ответит архив */
  F.search = function (q, f, cb) {
    f = f || {};
    q = String(q || '').replace(/^\s+|\s+$/g, '');
    var res = { yt: null, arch: null, ytErr: '', archErr: '' };
    if (TV.settings.showYT && TV.yt.canSearch()) {
      TV.yt.search(ytQuery(q, f), { duration: 'long' }, function (err, arr) {
        res.yt = err ? [] : TV.filter(arr, function (x) {
          // «Советские и российские» — только с русским названием (поиск YouTube подмешивает чужое)
          return x.k === 'yt' && !x.live && (f.origin !== 'su' || /[А-Яа-яЁё]{3}/.test(x.n));
        });
        if (err) res.ytErr = String(err);
        cb(res);
      });
    } else res.yt = [];
    if (f.origin === 'su') { res.arch = []; cb(res); return; }
    TV.arch.search(q, function (err, arr) {
      res.arch = err ? [] : arr;
      if (err) res.archErr = String(err);
      cb(res);
    }, f);
  };

  /* ================================================================ каталог фильмов (1.1.0) */
  /* data/movies.json собирает tools/build_movies.py (каталог Apple + русские названия из Wikidata)
     раз в день и публикует на GitHub Pages. Только фильмы, новые первыми. Сами фильмы не
     показываются — официальный трейлер и ссылки «Где смотреть». Держим в памяти. */
  var MV = null, FREE = [], mvT = 0, mvBusy = false, mvWait = [];
  var M = TV.movies = {};
  M.genres = [
    { id: 'all', name: 'Все жанры' }, { id: 'action', name: 'Боевики' }, { id: 'comedy', name: 'Комедии' },
    { id: 'drama', name: 'Драмы' }, { id: 'thriller', name: 'Триллеры' }, { id: 'horror', name: 'Ужасы' },
    { id: 'scifi', name: 'Фантастика' }, { id: 'family', name: 'Семейные и мультфильмы' }, { id: 'anime', name: 'Аниме' },
    { id: 'romance', name: 'Мелодрамы' }, { id: 'doc', name: 'Документальные' }, { id: 'sport', name: 'Спорт' },
    { id: 'war', name: 'Военные' }, { id: 'classic', name: 'Классика' }, { id: 'other', name: 'Другое' }
  ];
  M.yearsList = [
    { id: 'all', name: 'Любой год' }, { id: 'y0', name: String(new Date().getFullYear()), from: new Date().getFullYear(), to: 9999 },
    { id: 'y1', name: String(new Date().getFullYear() - 1), from: new Date().getFullYear() - 1, to: new Date().getFullYear() - 1 },
    { id: 'y2', name: String(new Date().getFullYear() - 2), from: new Date().getFullYear() - 2, to: new Date().getFullYear() - 2 },
    { id: 'y20', name: '2020-е', from: 2020, to: 2029 }, { id: 'y10', name: '2010-е', from: 2010, to: 2019 }, { id: 'old', name: 'Раньше', from: 0, to: 2009 }
  ];
  M.genreName = function (id) { var g = TV.find(M.genres, function (x) { return x.id === id; }); return g && id !== 'all' ? g.name : ''; };
  M.ready = function () { return !!MV; };
  M.load = function (cb) {
    if (MV && TV.now() - mvT < 12 * 36e5) { if (cb) cb(null); return; }
    if (cb) mvWait.push(cb);
    if (mvBusy) return;
    mvBusy = true;
    var src = [];
    if (/^https?:/.test(location.protocol)) src.push('../data/movies.json');
    if (TV.PAGES) src.push(TV.PAGES + '/data/movies.json');
    var i = 0;
    (function next(lastErr) {
      var done = function (err) { mvBusy = false; var w = mvWait; mvWait = []; TV.each(w, function (f) { f(err); }); };
      if (i >= src.length) return done(lastErr || 'каталог фильмов недоступен');
      TV.ajax(src[i++] + '?d=' + Math.floor(TV.now() / 36e5), { timeout: 40000 }, function (err, j) {
        if (err || !j || !TV.isArray(j.movies)) return next(err || 'формат');
        var ok = [], web = /^https:\/\/[^\s"'<>]+$/;
        TV.each(j.movies, function (m) {           // берём только корректные записи (защита от подмены)
          if (m && typeof m.id === 'string' && typeof m.t === 'string' && web.test(m.p || '') && (!m.tr || web.test(m.tr)) && (!m.url || web.test(m.url))) {
            if (typeof m.dr !== 'string' || typeof m.wa !== 'string' || !m.wa) { m.dr = ''; m.wa = ''; }
            ok.push(m);
          }
        });
        var fr = [], img = /^https:\/\/[^\s"'<>]+$/;
        TV.each(TV.isArray(j.free) ? j.free : [], function (v) {      // бесплатно у правообладателей (Rutube)
          if (v && /^[0-9a-f]{32}$/.test(v.id || '') && typeof v.t === 'string' && (!v.img || img.test(v.img))) fr.push(v);
        });
        FREE = fr;
        MV = ok; mvT = TV.now();
        done(null);
      });
    })('');
  };
  /* Детский режим: только семейные с рейтингом G / PG */
  function allowed(m) { return !TV.settings.kids || (m.g === 'family' && /^(G|PG|NR|)$/.test(m.r || '')); }
  /* f: { q, genre, years } -> фильмы, новые первыми (каталог уже так отсортирован) */
  M.find = function (f) {
    f = f || {};
    var q = TV.norm(f.q || ''), y = TV.find(M.yearsList, function (x) { return x.id === f.years && x.id !== 'all'; });
    return TV.filter(MV || [], function (m) {
      if (!allowed(m)) return false;
      if (f.genre && f.genre !== 'all' && m.g !== f.genre) return false;
      if (y && (m.y < y.from || m.y > y.to)) return false;
      if (q && TV.norm(m.t + ' ' + (m.to || '') + ' ' + (m.dir || '')).indexOf(q) < 0) return false;
      return true;
    });
  };
  /* Бесплатно у правообладателей (1.3.0): f: { q, kind: 'all'|'film'|'series', studio } — новые первыми.
     Детский режим — только с возрастной маркой до 6+. */
  M.free = function (f) {
    f = f || {};
    var q = TV.norm(f.q || '');
    return TV.filter(FREE, function (v) {
      if (TV.settings.kids && (v.age || 0) > 6) return false;
      if (f.kind === 'film' && v.ser) return false;
      if (f.kind === 'series' && !v.ser) return false;
      if (f.studio && v.a !== f.studio) return false;
      if (q && TV.norm(v.t + ' ' + (v.full || '') + ' ' + v.a).indexOf(q) < 0) return false;
      return true;
    });
  };
  M.studios = function () { var s = [], seen = {}; TV.each(FREE, function (v) { if (!seen[v.a]) { seen[v.a] = 1; s.push(v.a); } }); return s; };
  M.freeItem = function (v) {
    return { k: 'rt', id: v.id, n: v.t, sub: v.a + ' · ' + (v.ser ? 'сериал, ' : '') + v.min + ' мин' + (v.age ? ' · ' + v.age + '+' : ''), img: v.img, len: v.min * 60 };
  };
  M.freeItems = function (list, max) { var out = []; for (var i = 0; i < list.length && (!max || i < max); i++) out.push(M.freeItem(list[i])); return out; };
  M.freeById = function (id) { return TV.find(FREE, function (v) { return v.id === id; }); };
  M.byId = function (id) { return TV.find(MV || [], function (m) { return m.id === id; }); };
  /* Карточка для сеток приложения */
  M.item = function (m) { return { k: 'mv', id: m.id, n: m.t, sub: m.y + (M.genreName(m.g) ? ' · ' + M.genreName(m.g) : ''), img: m.p }; };
  M.items = function (list, max) { var out = []; for (var i = 0; i < list.length && (!max || i < max); i++) out.push(M.item(list[i])); return out; };
  /* Где смотреть (легальные сервисы): поиск по названию */
  M.where = function (m) {
    var q = encodeURIComponent(m.t + (m.y ? ' ' + m.y : ''));
    var out = [{ n: 'Кинопоиск', u: 'https://www.kinopoisk.ru/index.php?kp_query=' + encodeURIComponent(m.t) }];
    if (m.url) out.push({ n: 'Apple TV', u: m.url });
    out.push({ n: 'Иви', u: 'https://www.ivi.ru/search/?q=' + encodeURIComponent(m.t) });
    out.push({ n: 'Найти в Google', u: 'https://www.google.com/search?q=' + q + '+смотреть+онлайн+легально' });
    return out;
  };

  F.google = function (q) {
    TV.openExternal('https://www.google.com/search?q=' + encodeURIComponent((q || '') + ' фильм смотреть онлайн'));
  };

  /* ================================================================ загрузки */
  /* Список загрузок: [{ id, n, sub, img, file, size, got, done, err }] — хранится в TV.store */
  var D = TV.dl = {};
  // iOS отдаёт файлы через локальный сервер (port), Android — прямым file://-адресом (fileBase)
  D.available = function () { return TV.native && !!(window.TV_NATIVE && (window.TV_NATIVE.port || window.TV_NATIVE.fileBase)); };
  D.all = function () { return TV.store.get('downloads', []); };
  function save(list) { TV.store.set('downloads', list); TV.emit('dl'); }
  function find(id) { return TV.find(D.all(), function (d) { return d.id === id; }); }
  D.get = find;
  D.canDownload = function (it) { return D.available() && it && (it.k === 'arch' || it.k === 'url' || it.k === 'pc'); };
  /* Адрес для плеера: локальный сервер приложения (поддерживает перемотку) */
  D.fileUrl = function (d) {
    if (window.TV_NATIVE.port) return 'http://127.0.0.1:' + window.TV_NATIVE.port + '/file/' + encodeURIComponent(d.file);
    return window.TV_NATIVE.fileBase + encodeURIComponent(d.file);
  };

  D.start = function (it, cb) {
    if (!D.canDownload(it)) return cb && cb('нельзя скачать');
    var id = it.k + ':' + (it.id || it.u);
    if (find(id)) return cb && cb('уже в загрузках');
    var go = function (url) {
      if (!/\.(mp4|m4v|mov)(\?|$)/i.test(url)) return cb && cb('скачать можно только mp4');
      var list = D.all();
      list.unshift({ id: id, k: it.k, n: it.n, sub: it.sub || '', img: it.img || '', file: '', size: 0, got: 0, done: false });
      save(list);
      TV.callNative({ cmd: 'download', id: id, url: url });
      if (cb) cb(null);
    };
    if (it.k === 'arch') TV.arch.resolve(it.id, function (err, r) { if (err) { if (cb) cb(err); } else go(r.url); });
    else go(it.u);
  };
  D.remove = function (id) {
    var d = find(id);
    if (d) TV.callNative({ cmd: 'dlDelete', id: id, file: d.file });
    save(TV.filter(D.all(), function (x) { return x.id !== id; }));
  };

  /* События от приложения: {id, got, size} — прогресс; {id, file, done:true} — готово; {id, err} — ошибка */
  TV.nativeEvent = function (name, data) {
    if (name === 'voice') { TV.emit('voice', data || {}); return; }       // голосовой поиск (Android, 1.0.0)
    if (name !== 'dl' || !data) return;
    var list = D.all(), d = TV.find(list, function (x) { return x.id === data.id; });
    if (!d) return;
    if (data.got != null) d.got = data.got;
    if (data.size) d.size = data.size;
    if (data.file) d.file = data.file;
    if (data.done) { d.done = true; d.err = ''; TV.toast('Скачано: ' + d.n); }
    if (data.err) { d.err = data.err; TV.toast('Не скачалось: ' + d.n); }
    save(list);
  };
  /* Загрузки не переживают перезапуск приложения: незаконченные помечаем, чтобы скачать заново */
  (function () {
    var list = D.all(), changed = false;
    TV.each(list, function (d) { if (!d.done && !d.err) { d.err = 'прервано — удалите и скачайте заново'; changed = true; } });
    if (changed) TV.store.set('downloads', list);
  })();

  /* Карточка для плеера из загрузки */
  D.item = function (d) { return { k: 'dl', id: d.id, n: d.n, sub: '📥 На устройстве', img: d.img, u: D.fileUrl(d) }; };
})();
