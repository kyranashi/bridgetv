/*
 * BridgeTV — внешние сервисы:
 *   TV.yt   — YouTube через открытые зеркала Invidious / Piped (поиск, тренды, эфиры,
 *             каналы, подсказки, получение потока для плеера). Сам выбирает живое зеркало.
 *   TV.arch — «Архив кино»: фильмы и мультфильмы в общественном достоянии (archive.org).
 *   TV.pc   — «Фильмы с ПК»: папка с видео по локальной сети (tools/serve.py или любой http-сервер).
 *
 * Всё нормализуется в универсальные карточки (см. data.js).
 */
(function () {
  /* ================================================================ YouTube (с 0.3.0)
   * Два режима, выбираются автоматически по устройству (TV.yt.mode()):
   *   official — официальный плеер YouTube (IFrame) + официальные данные: YouTube Data API v3
   *              (поиск, тренды, подборки — нужен бесплатный ключ, Настройки) или RSS-ленты каналов
   *              (без ключа, только в приложении — браузер не даёт читать их из-за CORS).
   *              Качество, озвучка и субтитры — в меню самого плеера YouTube.
   *   mirror   — своё зеркало Invidious/Piped (Настройки). Для старых устройств, где официальный
   *              плеер не запускается (iOS 9–11, Android 4.4), или если выбрано вручную.
   *   none     — старое устройство без зеркала: вкладка объясняет, что сделать.
   * Публичные зеркала по умолчанию больше не используются: к ноябрю 2026 все они закрыты.
   */
  var enc = encodeURIComponent;
  var API = 'https://www.googleapis.com/youtube/v3/';

  function mirrorList() {
    var u = String(TV.settings.ytInstance || '').replace(/\/+$/, '');
    return u ? [{ type: /piped/i.test(u) ? 'piped' : 'invidious', url: u }] : [];
  }
  /* Может ли устройство показать официальный плеер YouTube */
  function embedOk() {
    var d = TV.device;
    if (d.ios && d.iosVer && d.iosVer < 12) return false;     // YouTube не поддерживает Safari iOS 9–11
    if (d.android && d.android < 5) return false;              // и старый WebView Android 4.4
    return true;
  }

  /* ---------------- зеркало (Invidious / Piped) ---------------- */
  function call(paths, cb) {
    var it = mirrorList()[0];
    if (!it) return cb('зеркало не указано');
    var path = typeof paths === 'function' ? paths(it) : paths[it.type];
    if (!path) return cb('нет метода');
    TV.ajax(it.url + path, { timeout: 15000 }, function (err, j) {
      if (err || (j && j.error)) cb('зеркало: ' + (err || j.error)); else cb(null, j, it);
    });
  }
  function thumbI(id) { return 'https://i.ytimg.com/vi/' + id + (TV.lite() ? '/default.jpg' : '/mqdefault.jpg'); }
  function pick(arr, w) {
    if (!arr || !arr.length) return '';
    var best = arr[0];
    TV.each(arr, function (t) { if (t.width && t.width >= w && (!best.width || best.width < w || t.width < best.width)) best = t; });
    var u = best.url || '';
    return u.indexOf('//') === 0 ? 'https:' + u : u;
  }
  function idFrom(url, re) { var m = String(url || '').match(re); return m ? m[1] : ''; }
  function normI(arr) {
    var out = [];
    TV.each(arr || [], function (x) {
      if (x.type === 'video' || x.type === 'shortVideo' || (!x.type && x.videoId)) {
        out.push({ k: 'yt', id: x.videoId, n: x.title, sub: x.author, ch: x.authorId, img: thumbI(x.videoId),
          len: x.lengthSeconds || 0, views: x.viewCount || 0, live: !!x.liveNow });
      } else if (x.type === 'channel') {
        out.push({ k: 'ytc', id: x.authorId, n: x.author, sub: x.subCount ? x.subCount + ' подписчиков' : '', img: pick(x.authorThumbnails, 88) });
      }
    });
    return out;
  }
  function normP(arr) {
    var out = [];
    TV.each(arr || [], function (x) {
      if (x.type === 'stream' || (x.url && x.url.indexOf('/watch') === 0)) {
        out.push({ k: 'yt', id: idFrom(x.url, /v=([\w-]{11})/), n: x.title, sub: x.uploaderName, ch: idFrom(x.uploaderUrl, /channel\/([\w-]+)/),
          img: x.thumbnail, len: x.duration > 0 ? x.duration : 0, views: x.views > 0 ? x.views : 0, live: x.duration === -1 });
      } else if (x.type === 'channel') {
        out.push({ k: 'ytc', id: idFrom(x.url, /channel\/([\w-]+)/), n: x.name, img: x.thumbnail, sub: '' });
      }
    });
    return out;
  }
  function clean(r) { return TV.filter(r, function (x) { return x.id && !TV.blocked(x); }); }   // безопасный режим
  function normM(j, it) { return clean(it.type === 'piped' ? normP(j.items || j.relatedStreams || j) : normI(j.videos || j)); }

  /* ---------------- официальные данные: YouTube Data API v3 ---------------- */
  /* Кэш ответов API на 6 часов (бесплатная квота ключа — 10 000 единиц в сутки, поиск стоит 100) */
  function apiCached(key, url, cb) {
    var c = TV.store.get('ytc_' + key, null);
    if (c && TV.now() - c.t < 6 * 3600e3) return cb(null, c.v);
    TV.ajax(url + '&key=' + enc(TV.settings.ytKey), { timeout: 15000 }, function (err, j) {
      if (err) return cb(/403/.test(err) ? 'ключ YouTube API не подходит или исчерпан на сегодня' : err);
      TV.store.set('ytc_' + key, { t: TV.now(), v: j });
      cb(null, j);
    });
  }
  function isoDur(s) {      // PT1H2M3S -> секунды
    var m = String(s || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
  }
  function normApi(items) {
    var out = [];
    TV.each(items || [], function (x) {
      var sn = x.snippet || {}, id = x.id && (x.id.videoId || x.id.channelId || x.id) || '';
      if (typeof id !== 'string') return;
      if ((x.id && x.id.channelId) || x.kind === 'youtube#channel') {
        out.push({ k: 'ytc', id: id, n: sn.title, sub: 'Канал YouTube', img: sn.thumbnails && sn.thumbnails['default'] && sn.thumbnails['default'].url });
        return;
      }
      out.push({ k: 'yt', id: id, n: sn.title, sub: sn.channelTitle, ch: sn.channelId, img: thumbI(id),
        live: sn.liveBroadcastContent === 'live', len: x.contentDetails ? isoDur(x.contentDetails.duration) : 0,
        views: x.statistics ? +x.statistics.viewCount || 0 : 0, date: sn.publishedAt });
    });
    return clean(out);
  }
  /* Добавить длительность и просмотры (1 единица квоты на 50 видео) */
  function withDetails(list, cb) {
    var ids = TV.filter(list, function (x) { return x.k === 'yt'; }).map(function (x) { return x.id; }).slice(0, 50);
    if (!ids.length) return cb(null, list);
    apiCached('v_' + ids.join('').slice(0, 60), API + 'videos?part=contentDetails,statistics&id=' + ids.join(','), function (err, j) {
      if (err) return cb(null, list);
      var by = {};
      TV.each(j.items || [], function (v) { by[v.id] = v; });
      TV.each(list, function (x) {
        var v = by[x.id];
        if (v) { x.len = isoDur(v.contentDetails.duration); x.views = +v.statistics.viewCount || 0; }
      });
      cb(null, list);
    });
  }
  /* RSS-лента канала — официальная, без ключа; только в приложении (в браузере мешает CORS) */
  function rss(channelId, cb) {
    TV.ajax('https://www.youtube.com/feeds/videos.xml?channel_id=' + enc(channelId), { text: true, timeout: 15000 }, function (err, xml) {
      if (err) return cb(err);
      var out = [], re = /<entry>([\s\S]*?)<\/entry>/g, m;
      var tag = function (s, t) { var r = s.match(new RegExp('<' + t + '[^>]*>([^<]*)</' + t + '>')); return r ? r[1] : ''; };
      // &amp; — последним: иначе «&amp;lt;» раскодировалось бы дважды (до «<»). Результат всё равно выводится через TV.esc.
      var un = function (s) { return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); };
      while ((m = re.exec(xml))) {
        var e = m[1], id = tag(e, 'yt:videoId');
        if (!id || /#shorts/i.test(e)) continue;
        out.push({ k: 'yt', id: id, n: un(tag(e, 'title')), sub: un(tag(e, 'name')), ch: tag(e, 'yt:channelId'),
          img: thumbI(id), date: tag(e, 'published'), views: +((e.match(/views="(\d+)"/) || [])[1] || 0) });
      }
      cb(null, clean(out));
    });
  }

  TV.yt = {
    /* official | mirror | none */
    mode: function () {
      var src = TV.settings.ytSource || 'auto', mirror = mirrorList().length > 0;
      if (src === 'mirror') return mirror ? 'mirror' : 'none';
      if (src === 'official') return 'official';
      if (embedOk()) return 'official';
      return mirror ? 'mirror' : 'none';
    },
    embedOk: embedOk,
    hasKey: function () { return !!TV.settings.ytKey; },
    /* Можно ли искать: зеркало, ключ API */
    canSearch: function () { var m = TV.yt.mode(); return m === 'mirror' || (m === 'official' && TV.yt.hasKey()); },
    current: function () { return mirrorList()[0] || null; },
    discover: function () {},
    /* o: { type: 'video'|'channel'|'all', live, duration: short|medium|long, sort: relevance|upload_date|view_count, page } */
    search: function (q, o, cb) {
      o = o || {};
      if (TV.yt.mode() === 'mirror') {
        return call({
          invidious: '/api/v1/search?q=' + enc(q) + '&region=RU&page=' + (o.page || 1) + '&type=' + (o.type || 'video') +
            (o.live ? '&features=live' : '') + (o.duration ? '&duration=' + o.duration : '') + (o.sort ? '&sort_by=' + o.sort : ''),
          piped: '/search?q=' + enc(q) + '&filter=' + (o.type === 'channel' ? 'channels' : o.type === 'all' ? 'all' : 'videos')
        }, function (err, j, it) {
          if (err) return cb(err);
          var r = normM(j, it);
          if (o.live) r = TV.filter(r, function (x) { return x.k !== 'yt' || x.live || !x.len; });
          if (o.duration === 'long') r = TV.filter(r, function (x) { return x.k !== 'yt' || !x.len || x.len >= 1200; });
          cb(null, r);
        });
      }
      if (!TV.yt.hasKey()) return cb('для поиска нужен ключ YouTube API (Ещё → Настройки)');
      var order = o.sort === 'upload_date' ? 'date' : o.sort === 'view_count' ? 'viewCount' : 'relevance';
      var type = o.type === 'channel' ? 'channel' : o.type === 'all' ? 'video,channel' : 'video';
      var url = API + 'search?part=snippet&maxResults=25&regionCode=BY&relevanceLanguage=ru&safeSearch=' + (TV.settings.kids ? 'strict' : 'moderate') + '&q=' + enc(q) +
        '&type=' + type + '&order=' + order + (o.live ? '&eventType=live' : '') +
        (o.duration && type === 'video' ? '&videoDuration=' + o.duration : '');
      var key = 's_' + q + '_' + type + order + (o.live ? 'L' : '') + (o.duration || '') + (o.page || 1);
      // страницы: токен следующей страницы хранится вместе с результатом предыдущей
      var tok = o.page > 1 ? TV.store.get('ytp_' + key.replace(/\d+$/, String(o.page - 1)), '') : '';
      apiCached(key, url + (tok ? '&pageToken=' + tok : ''), function (err, j) {
        if (err) return cb(err);
        if (j.nextPageToken) TV.store.set('ytp_' + key, j.nextPageToken);
        withDetails(normApi(j.items), cb);
      });
    },
    trending: function (cb) {
      if (TV.yt.mode() === 'mirror') return call({ invidious: '/api/v1/trending?region=RU', piped: '/trending?region=RU' }, function (err, j, it) { cb(err, err ? null : normM(j, it)); });
      if (!TV.yt.hasKey()) return cb('нужен ключ YouTube API');
      apiCached('trend', API + 'videos?part=snippet,contentDetails,statistics&chart=mostPopular&maxResults=30&regionCode=BY', function (err, j) {
        cb(err, err ? null : normApi(j.items));
      });
    },
    suggest: function (q, cb) {
      if (TV.yt.mode() === 'mirror') return call({ invidious: '/api/v1/search/suggestions?q=' + enc(q), piped: '/suggestions?query=' + enc(q) },
        function (err, j) { cb(err, err ? [] : (j.suggestions || j || [])); });
      // официальные подсказки поиска Google для YouTube (работают в приложении; в браузере может мешать CORS)
      TV.ajax('https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ru&q=' + enc(q), { timeout: 6000 }, function (err, j) {
        cb(err, err || !j ? [] : (j[1] || []));
      });
    },
    /* Видео канала: зеркало, RSS (без ключа) или API */
    channel: function (id, cb) {
      if (TV.yt.mode() === 'mirror') return call({ invidious: '/api/v1/channels/' + id + '/videos', piped: '/channel/' + id }, function (err, j, it) { cb(err, err ? null : normM(j, it)); });
      rss(id, function (err, list) {
        if (!err && list.length) return cb(null, list);
        if (!TV.yt.hasKey()) return cb(err || 'нет видео');
        apiCached('ch_' + id, API + 'search?part=snippet&channelId=' + enc(id) + '&order=date&maxResults=25&type=video', function (e2, j) {
          cb(e2, e2 ? null : normApi(j.items));
        });
      });
    },
    /* Поток для плеера (только режим зеркала; официальный режим играет во встроенном плеере YouTube) */
    resolve: function (id, cb) {
      call({ invidious: '/api/v1/videos/' + id + '?local=true', piped: '/streams/' + id }, function (err, j, it) {
        if (err) return cb(err);
        var title = j.title || '', url = '', live = !!(j.liveNow || j.livestream);
        if (it.type === 'piped') {
          url = j.hls || '';
          if (!url) {
            var mp4 = TV.filter(j.videoStreams || [], function (s) { return !s.videoOnly && /mp4/i.test(s.mimeType || s.format || ''); });
            if (mp4.length) url = mp4[0].url;
          }
        } else {
          var prog = TV.filter(j.formatStreams || [], function (s) { return /mp4/.test(s.type || ''); });
          if (prog.length && !live) {
            prog.sort(function (a, b) { return parseInt(a.resolution || a.qualityLabel, 10) - parseInt(b.resolution || b.qualityLabel, 10); });
            url = (TV.lite() ? prog[0] : prog[prog.length - 1]).url;
          }
          if (!url && j.hlsUrl) url = j.hlsUrl + (j.hlsUrl.indexOf('?') >= 0 ? '&' : '?') + 'local=true';
          if (url && url.indexOf('/') === 0) url = it.url + url;
        }
        if (!url) return cb('у видео нет совместимого потока');
        var caps = [];
        TV.each(j.captions || j.subtitles || [], function (c) {
          var lang = c.language_code || c.languageCode || c.code || '', u = c.url || '';
          if (!u || !lang) return;
          if (u.indexOf('/') === 0) u = it.url + u;
          caps.push({ lang: lang, name: c.label || c.name || lang, url: u });
        });
        cb(null, { url: url, live: live, title: title, author: j.author || j.uploader || '', captions: caps });
      });
    },
    /* Страница встроенного плеера: на https/http-хостинге — рядом с приложением, из файлов приложения
       (file://, iOS/Android/Windows) — на GitHub Pages: YouTube требует настоящий адрес страницы (Referer). */
    embedUrl: function (id) {
      var base = /^https?:/.test(location.protocol) ? 'yt.html' : TV.PAGES + '/web/yt.html';
      return base + '?v=' + enc(id) + '&hl=ru';
    },
    webUrl: function (id) { return 'https://www.youtube.com/watch?v=' + id; },
    searchWebUrl: function (q) { return 'https://www.youtube.com/results?search_query=' + enc(q); }
  };

  /* Видео официального канала */
  TV.yt.officialChannel = function (s, cb) { TV.yt.channel(s.ch, cb); };
  /* Официальные каналы киностудий — легальный источник советского и белорусского кино.
     id проверены (RSS-лента канала): подтверждённые каналы самих студий. */
  TV.yt.studios = [
    { id: 'mosfilm', title: '🎞 Мосфильм — советское кино (официально)', ch: 'UCEK3tT7DcfWGWJpNEDBdWog' },
    { id: 'soyuz', title: '🧸 Союзмультфильм (официально)', ch: 'UCHS2LM1n3f5cyL-ebgkqyLw' },
    { id: 'belfilm', title: '🇧🇾 Беларусьфильм (официально)', ch: 'UC4NbKSNLUi9C1h-eA3xwRCw' }
  ];

  /* Подборки из RSS-лент официальных каналов (работают без ключа, в приложении). id каналов проверены
     11.11.2026 по их RSS. Ленты одной подборки сливаются и сортируются по дате — свежее первым. */
  TV.yt.feeds = [
    { id: 'new', title: '🆕 Новинки кино — трейлеры и премьеры', chs: [
      'UCoSZkP0mVJd1S5GUGALzdnA',   // Central Partnership — прокат премьер в кино
      'UC4tlrTXCBw6NPZ9nCA3_s9w',   // Кинопоиск
      'UCWOA1ZGywLbqmigxE4Qlvuw',   // Netflix
      'UCq0OueAsdxH6b8nyAspwViw',   // Universal Pictures
      'UC_5niPa-d35gg88HaS7RrIw'] },  // Disney
    { id: 'kidsnew', title: '🧸 Новые мультфильмы', chs: [
      'UC5A-Wp9ujcr5g9sYagAafEA',   // Смешарики
      'UCs_uv3QyUIQjBoL1Ij5BdlQ',   // Фиксики
      'UCHS2LM1n3f5cyL-ebgkqyLw',   // Союзмультфильм
      'UC_IRYSp4auq7hKLvziWVH6w'] },  // Pixar
    { id: 'animenew', title: '🌸 Аниме — новые серии и трейлеры', chs: [
      'UCGbshtvS9t-8CW11W7TooQg',   // Muse Asia (целые серии бесплатно и легально)
      'UC6pGDc4bFGD1_36IKv3FnYg',   // Crunchyroll
      'UCDb0peSmF5rLX7BvuTcJfCw',   // Aniplex USA
      'UCJXUTDi2Lc8Qub4bxICcPCA'] },  // GKIDS
    { id: 'classic', title: '🎞 Классика: Мосфильм и Беларусьфильм', chs: [
      'UCEK3tT7DcfWGWJpNEDBdWog', 'UC4NbKSNLUi9C1h-eA3xwRCw'] }
  ];
  /* Слить ленты нескольких каналов, свежее первым */
  TV.yt.feed = function (f, cb) {
    var left = f.chs.length, all = [], errs = 0;
    TV.each(f.chs, function (ch) {
      TV.yt.channel(ch, function (err, list) {
        if (err) errs++; else all = all.concat(list || []);
        if (--left) return;
        all.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
        cb(all.length ? null : 'не загрузилось', all.slice(0, 40));
      });
    });
  };

  /* Подписки на каналы YouTube (локально) */
  TV.subs = {
    all: function () { return TV.store.get('subs', []); },
    has: function (id) { return TV.indexOf(TV.subs.all(), function (s) { return s.id === id; }) >= 0; },
    toggle: function (c) {
      var a = TV.subs.all(), i = TV.indexOf(a, function (s) { return s.id === c.id; });
      if (i >= 0) a.splice(i, 1); else a.push({ k: 'ytc', id: c.id, n: c.n, img: c.img || '' });
      TV.store.set('subs', a);
      return i < 0;
    }
  };

  /* Полки вкладки «Видео» (нужен ключ API или зеркало). С 1.1.0 — только YouTube: тренды первыми,
     фильмов и трейлеров здесь нет (они во вкладке «Фильмы»); свежее — первым (sort: upload_date). */
  TV.yt.shelves = [
    { id: 'trend', title: '🔥 В тренде на YouTube', trending: true },
    { id: 'tnews', title: '📰 Новое: новости и события', q: 'новости сегодня', sort: 'upload_date' },
    { id: 'anime', title: '🌸 Аниме', q: 'аниме на русском', d: 'medium', sort: 'upload_date' },
    { id: 'kids', title: '🧸 Мультфильмы', q: 'мультфильмы для детей' },
    { id: 'music', title: '🎵 Музыка и клипы', q: 'новые клипы', sort: 'upload_date' },
    { id: 'fun', title: '😂 Юмор', q: 'юмор шоу лучшее' },
    { id: 'science', title: '🔬 Наука и познавательное', q: 'научно популярный фильм', d: 'long' },
    { id: 'sport', title: '⚽ Спорт', q: 'футбол обзор матча' },
    { id: 'games', title: '🎮 Игры', q: 'прохождение игры' },
    { id: 'food', title: '🍳 Кулинария', q: 'рецепты простые вкусные' },
    { id: 'travel', title: '✈️ Путешествия', q: 'путешествие влог' },
    { id: 'live', title: '🔴 Сейчас в эфире', q: 'прямой эфир', live: true }
  ];

  /* Разбор HLS-плейлиста (режим зеркала): качества H.264, озвучки. cb(err, info) */
  TV.yt.hlsInfo = function (url, cb) {
    TV.ajax(url, { text: true, timeout: 15000 }, function (err, text) {
      if (err) return cb(err);
      var info = { heights: [], audio: [], subs: [] }, seenA = {}, m;
      var inf = /#EXT-X-STREAM-INF:([^\n]*)/g;
      while ((m = inf.exec(text))) {
        var h = (m[1].match(/RESOLUTION=\d+x(\d+)/) || [])[1], c = (m[1].match(/CODECS="([^"]*)"/) || [])[1] || '';
        if (h && /avc1/.test(c) && info.heights.indexOf(+h) < 0) info.heights.push(+h);
      }
      info.heights.sort(function (a, b) { return b - a; });
      var med = /#EXT-X-MEDIA:([^\n]*)/g;
      while ((m = med.exec(text))) {
        var a = m[1], type = (a.match(/TYPE=(\w+)/) || [])[1], lang = (a.match(/LANGUAGE="([^"]*)"/) || [])[1] || '',
          name = (a.match(/NAME="([^"]*)"/) || [])[1] || lang;
        if (type === 'AUDIO' && lang && !seenA[lang]) {
          seenA[lang] = 1;
          info.audio.push({ lang: lang, orig: /original/i.test(name) || !/dubbed/i.test(name),
            name: name.replace(/\s*-\s*dubbed/i, ' (перевод)').replace(/\s*-\s*original/i, ' (оригинал)') });
        }
      }
      var rank = function (x) { return /^ru/.test(x.lang) ? 0 : x.orig ? 1 : 2; };
      info.audio.sort(function (x, y) { return rank(x) - rank(y); });
      cb(null, info);
    });
  };

  /* ================================================================ Архив кино */
  var COLL = 'collection:(feature_films OR animationandcartoons OR silent_films OR Film_Noir OR SciFi_Horror OR Comedy_Films OR classic_cartoons)';
  TV.arch = {
    shelves: [
      // Советских фильмов здесь нет: в РФ/РБ они, как правило, ещё охраняются (см. docs/LEGAL.md) —
      // они идут с официальных каналов киностудий (TV.yt.studios)
      { id: 'toons', title: '🧸 Старые мультфильмы', q: 'collection:(classic_cartoons)' },
      { id: 'classic', title: '🎬 Классика мирового кино', q: 'collection:(feature_films)' },
      { id: 'scifi', title: '🚀 Фантастика и ужасы', q: 'collection:(SciFi_Horror)' },
      { id: 'comedy', title: '😄 Комедии', q: 'collection:(Comedy_Films)' },
      { id: 'noir', title: '🕵️ Нуар', q: 'collection:(Film_Noir)' },
      { id: 'silent', title: '🎩 Немое кино', q: 'collection:(silent_films)' }
    ],
    query: function (q, rows, cb) {
      var url = 'https://archive.org/advancedsearch.php?q=' + enc(q + ' AND mediatype:(movies)') +
        '&fl[]=identifier&fl[]=title&fl[]=year&fl[]=runtime&rows=' + (rows || 40) + '&sort[]=downloads+desc&output=json';
      TV.ajax(url, { timeout: 20000 }, function (err, j) {
        if (err) return cb(err);
        var out = [];
        TV.each((j.response && j.response.docs) || [], function (d) {
          var t = d.title; if (t && t.join) t = t[0];
          if (/sex|nude|erotic|porn|xxx|burlesque|stripper/i.test(String(t))) return;   // семейный фильтр
          out.push({ k: 'arch', id: d.identifier, n: t || d.identifier, sub: d.year ? String(d.year) : 'Архив кино',
            img: 'https://archive.org/services/img/' + d.identifier });
        });
        cb(null, out);
      });
    },
    /* f: { genre, years } — фильтры вкладки «Фильмы» (TV.films) */
    search: function (q, cb, f) {
      var t = String(q || '').replace(/[():"\\]/g, ' ').replace(/^\s+|\s+$/g, ''), parts = [];
      f = f || {};
      if (t) parts.push('(title:(' + t + ') OR subject:(' + t + ') OR description:(' + t + '))');
      var g = f.genre && TV.films.genre(f.genre);
      if (g && g.arch) parts.push('subject:(' + g.arch + ')');
      var y = f.years && TV.films.years(f.years);
      if (y) parts.push('year:[' + y.from + ' TO ' + y.to + ']');
      parts.push(g && g.id === 'toon' ? 'collection:(animationandcartoons OR classic_cartoons)' : COLL);
      TV.arch.query(parts.join(' AND '), 40, cb);
    },
    /* Выбор видеофайла: mp4 (H.264). В лёгком режиме — самый маленький. */
    resolve: function (id, cb) {
      TV.ajax('https://archive.org/metadata/' + enc(id), { timeout: 20000 }, function (err, j) {
        if (err) return cb(err);
        if (!j || !j.files) return cb('фильм не найден');
        var mp4 = TV.filter(j.files, function (f) { return /\.(mp4|m4v)$/i.test(f.name); });
        if (!mp4.length) return cb('нет mp4-версии фильма');
        mp4.sort(function (a, b) { return (+a.size || 0) - (+b.size || 0); });
        var f = TV.lite() ? mp4[0] : mp4[mp4.length - 1];
        // для полноценных устройств берём не больше ~2,5 ГБ
        if (!TV.lite()) for (var i = mp4.length - 1; i >= 0; i--) if ((+mp4[i].size || 0) < 2.5e9) { f = mp4[i]; break; }
        var title = (j.metadata && j.metadata.title) || id;
        if (title.join) title = title[0];
        cb(null, { url: 'https://archive.org/download/' + enc(id) + '/' + enc(f.name).replace(/%2F/g, '/'), title: title });
      });
    }
  };

  /* ================================================================ Фильмы с ПК */
  var VIDEO = /\.(mp4|m4v|mov|m3u8|mkv|avi|webm|ts|mp3|m4a)$/i;
  TV.pc = {
    /* Список файлов папки: JSON от tools/serve.py или HTML-список любого http-сервера */
    list: function (url, cb) {
      if (!/\/$/.test(url)) url += '/';
      TV.ajax(url + (url.indexOf('?') >= 0 ? '' : '?json=1'), { text: true, timeout: 10000 }, function (err, text) {
        if (err) return cb(err);
        var out = [];
        var t = String(text).replace(/^\s+/, '');
        if (t.charAt(0) === '[') {
          try {
            TV.each(JSON.parse(t), function (f) {
              out.push({ k: 'pc', id: url + f.href, u: url + f.href, n: f.name, dir: !!f.dir, sub: f.size ? Math.round(f.size / 1048576) + ' МБ' : '' });
            });
          } catch (e) { return cb('ошибка списка'); }
        } else {
          var re = /href="([^"?#]+)"/gi, m, seen = {};
          while ((m = re.exec(t))) {
            var h = m[1];
            if (h === '../' || h.charAt(0) === '/' && h.length < 2 || /^[a-z]+:/i.test(h) || seen[h]) continue;
            seen[h] = 1;
            var dir = /\/$/.test(h);
            if (!dir && !VIDEO.test(h)) continue;
            var name = decodeURIComponent(h.replace(/\/$/, ''));
            out.push({ k: 'pc', id: url + h, u: url + h, n: name, dir: dir });
          }
        }
        out.sort(function (a, b) { return (b.dir - a.dir) || (a.n < b.n ? -1 : 1); });
        cb(null, out);
      });
    },
    /* Что сыграет устройство: iOS/старые браузеры — только mp4/m4v/mov (H.264) и HLS */
    playable: function (name) {
      if (TV.caps) return TV.caps.file(name) ? true : false;
      if (/\.(mkv|avi)$/i.test(name)) return !TV.device.ios && !TV.device.old ? 'maybe' : false;
      return true;
    }
  };
})();
