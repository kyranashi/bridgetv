/*
 * BridgeTV — данные: каталог каналов, избранное, история, «здоровье» ссылок,
 * свои ссылки и плейлисты, подписки YouTube, позиции просмотра.
 *
 * Универсальная «карточка» (item), которой обмениваются экраны, плеер,
 * избранное и история:
 *   { k: 'ch'|'yt'|'ytc'|'url'|'arch'|'pc', id, n: название, sub: подпись, img: картинка, ... }
 *   ch   — телеканал из каталога (id канала)
 *   yt   — видео/эфир YouTube (id видео), live: true для эфира
 *   ytc  — канал YouTube (id канала) — только в избранном/подписках
 *   url  — своя ссылка (u: адрес .m3u8/.mp4)
 *   arch — фильм из Архива Интернета (id = identifier)
 *   pc   — файл с компьютера по локальной сети (u: адрес)
 */
(function () {
  var S = TV.store;

  /* ------------------------------------------------------------ каталог */
  var cat = { regions: [], categories: [], channels: [], version: '' };
  var byId = {};

  function index() {
    byId = {};
    TV.each(cat.channels, function (c) {
      byId[c.id] = c;
      c._s = TV.norm(c.n) + ' ' + TV.latinKey(c.n) + ' ' + TV.norm(c.id);
    });
  }

  TV.catalog = {
    load: function () {
      var bundled = window.TV_CATALOG || null;
      var cached = S.get('catalog', null);
      var base = bundled;
      // более свежий по метке сборки (built), для старых каталогов — по дате версии
      var stamp = function (c) { return (c && (c.built || c.version)) || ''; };
      if (cached && cached.channels && (!bundled || stamp(cached) > stamp(bundled))) base = cached;
      if (base) cat = { regions: base.regions || [], categories: base.categories || [],
        channels: (base.channels || []).slice(0), version: base.version || '', checked: base.checked || '',
        built: base.built || '' };
      // Свои плейлисты (импорт M3U) — отдельный «регион» «Мои плейлисты»
      var pls = S.get('playlists', []);
      if (pls.length) {
        cat.regions.push({ id: 'my', name: 'Мои плейлисты', flag: '📁', primary: false, mine: true });
        TV.each(pls, function (p) {
          TV.each(p.channels, function (c, i) {
            cat.channels.push({ id: c.id, n: c.n, r: 'my', c: 'general', l: c.l || '', v: c.v, num: i + 1, pl: p.name });
          });
        });
      }
      index();
      return cat;
    },
    get: function () { return cat; },
    byId: function (id) { return byId[id] || null; },
    region: function (id) { return TV.find(cat.regions, function (r) { return r.id === id; }); },
    primary: function () { return TV.filter(cat.regions, function (r) { return r.primary; }); },
    extra: function () { return TV.filter(cat.regions, function (r) { return !r.primary; }); },
    catName: function (id) { var c = TV.find(cat.categories, function (x) { return x.id === id; }); return c ? c.name : ''; },

    /* Список каналов с фильтрами: {region, cat, onlyWorking} */
    list: function (o) {
      o = o || {};
      return TV.filter(cat.channels, function (c) {
        if (TV.blocked(c)) return false;
        if (o.region && o.region !== 'all' && c.r !== o.region) return false;
        if (o.region === 'all' && !TV.catalog.isPrimaryRegion(c.r)) return false;
        if (o.cat && o.cat !== 'all' && c.c !== o.cat) return false;
        if (o.onlyWorking && !TV.health.channelAlive(c)) return false;
        return true;
      });
    },
    isPrimaryRegion: function (rid) { var r = TV.catalog.region(rid); return !!(r && r.primary); },
    dead: function () { return TV.filter(cat.channels, function (c) { return !TV.blocked(c) && !TV.health.channelAlive(c); }); },

    search: function (q, limit) {
      var n = TV.norm(q), t = TV.latinKey(q);
      if (!n) return [];
      var res = [], words = n.split(' ');
      // «новости», «спорт», «детские»… — ещё и все каналы этой категории
      var catHit = TV.find(cat.categories, function (x) { var cn = TV.norm(x.name); return cn.indexOf(n) === 0 || (n.length > 3 && n.indexOf(cn.slice(0, 5)) === 0); });
      TV.each(cat.channels, function (c) {
        if (TV.blocked(c)) return;
        var ok = true;
        for (var i = 0; i < words.length; i++) if (c._s.indexOf(words[i]) < 0) { ok = false; break; }
        if (!ok && t && c._s.indexOf(t) >= 0) ok = true;
        if (!ok && catHit && c.c === catHit.id && TV.catalog.isPrimaryRegion(c.r)) ok = true;
        if (/^\d+$/.test(n) && c.num === parseInt(n, 10) && TV.catalog.isPrimaryRegion(c.r)) ok = true;
        if (!ok) return;
        var score = (c._s.indexOf(n) === 0 ? 0 : 1) + (TV.catalog.isPrimaryRegion(c.r) ? 0 : 2) + (TV.health.channelAlive(c) ? 0 : 4);
        res.push({ c: c, s: score });
      });
      res.sort(function (a, b) { return a.s - b.s || a.c.n.length - b.c.n.length; });
      var out = [];
      for (var i = 0; i < res.length && out.length < (limit || 200); i++) out.push(res[i].c);
      return out;
    },

    /* Обновление каталога по ссылке без переустановки приложения */
    /* Защита (0.3.0): скачанный каталог принимается, только если он устроен как наш —
       списки нужной формы, разумного размера, ссылки на потоки и логотипы — только http/https.
       Даже подменённый каталог не сможет подсунуть javascript:/file:-адреса. */
    valid: function (j) {
      var web = /^https?:\/\/[^\s"'<>]+$/i, ch = j.channels, i, k, c, v;
      if (!TV.isArray(ch) || ch.length < 10 || ch.length > 50000) return false;
      if ((j.regions && !TV.isArray(j.regions)) || (j.categories && !TV.isArray(j.categories))) return false;
      for (i = 0; i < ch.length; i++) {
        c = ch[i];
        if (!c || typeof c.id !== 'string' || typeof c.n !== 'string' || c.n.length > 200 || !TV.isArray(c.v) || c.v.length > 50) return false;
        if (c.l && (typeof c.l !== 'string' || !web.test(c.l))) return false;
        for (k = 0; k < c.v.length; k++) {
          v = c.v[k];
          if (!v || typeof v.u !== 'string' || v.u.length > 4096 || !web.test(v.u)) return false;
        }
      }
      return true;
    },
    update: function (url, cb) {
      TV.ajax(url, { timeout: 30000 }, function (err, j) {
        if (err || !j || !j.channels) return cb(err || 'не каталог');
        if (!TV.catalog.valid(j)) return cb('каталог повреждён');
        if (!S.set('catalog', j)) return cb('мало места в браузере');
        TV.catalog.load();
        cb(null, j);
      });
    }
  };

  /* ------------------------------------------------------------ здоровье ссылок */
  /* health[url] = { s: 1 работал | -1 сбой, t: время, f: подряд сбоев } */
  var H = S.get('health', {});
  var DAY = 864e5;
  var saveH = (function () { var t; return function () { clearTimeout(t); t = setTimeout(function () { S.set('health', H); }, 800); }; })();

  TV.health = {
    mark: function (url, ok) {
      var h = H[url] || { f: 0 };
      h.s = ok ? 1 : -1; h.t = TV.now(); h.f = ok ? 0 : (h.f || 0) + 1;
      H[url] = h; saveH();
    },
    get: function (url) { return H[url] || null; },
    /* Свежий локальный сбой (за 3 дня) */
    failed: function (url) { var h = H[url]; return !!(h && h.s === -1 && TV.now() - h.t < 3 * DAY); },
    worked: function (url) { var h = H[url]; return !!(h && h.s === 1 && TV.now() - h.t < 14 * DAY); },
    channelAlive: function (c) {
      var anyWorked = false, allFailed = true;
      for (var i = 0; i < c.v.length; i++) {
        if (TV.health.worked(c.v[i].u)) anyWorked = true;
        if (!TV.health.failed(c.v[i].u)) allFailed = false;
      }
      if (anyWorked) return true;
      if (c.ok === 0) return false;           // проверка каталога: не работает
      return !(allFailed && c.v.length);       // у нас все варианты падали
    },
    /* Статус для точки на карточке: ok | slow | dead | unknown */
    status: function (c) {
      for (var i = 0; i < c.v.length; i++) if (TV.health.worked(c.v[i].u)) return 'ok';
      if (!TV.health.channelAlive(c)) return 'dead';
      if (c.ok === 1) return c.v[0] && c.v[0].s === 2 ? 'slow' : 'ok';
      return 'unknown';
    },
    /* Порядок источников: недавно работавшие → по каталогу → недавно падавшие */
    variants: function (c) {
      var v = c.v.slice(0);
      var rank = function (x) { return TV.health.worked(x.u) ? 0 : TV.health.failed(x.u) ? 3 : x.s === 3 || x.s === -1 ? 2 : 1; };
      v.sort(function (a, b) { return rank(a) - rank(b); });
      return v;
    },
    reset: function (c) {
      if (!c) { H = {}; S.set('health', H); return; }
      TV.each(c.v, function (v) { delete H[v.u]; }); saveH();
    }
  };

  /* ------------------------------------------------------------ избранное */
  var key = function (it) { return it.k + ':' + (it.id || it.u); };
  var slim = function (it) {
    var o = { k: it.k, id: it.id, n: it.n };
    TV.each(['sub', 'img', 'u', 'live', 'len'], function (f) { if (it[f] != null && it[f] !== '') o[f] = it[f]; });
    return o;
  };
  TV.fav = {
    all: function () { return S.get('fav', []); },
    of: function (k) { return TV.filter(TV.fav.all(), function (x) { return x.k === k; }); },
    has: function (it) { var k = key(it); return TV.indexOf(TV.fav.all(), function (x) { return key(x) === k; }) >= 0; },
    toggle: function (it) {
      var a = TV.fav.all(), k = key(it), i = TV.indexOf(a, function (x) { return key(x) === k; });
      if (i >= 0) a.splice(i, 1); else a.push(slim(it));
      S.set('fav', a); TV.emit('fav');
      return i < 0;
    },
    move: function (it, d) {
      var a = TV.fav.all(), k = key(it), i = TV.indexOf(a, function (x) { return key(x) === k; });
      // ищем соседа того же типа
      var j = i + d;
      while (j >= 0 && j < a.length && a[j].k !== it.k) j += d;
      if (i < 0 || j < 0 || j >= a.length) return;
      var t = a[i]; a[i] = a[j]; a[j] = t;
      S.set('fav', a); TV.emit('fav');
    }
  };

  /* ------------------------------------------------------------ история */
  TV.history = {
    all: function () { return S.get('hist', []); },
    add: function (it) {
      var a = TV.history.all(), k = key(it);
      a = TV.filter(a, function (x) { return key(x) !== k; });
      var s = slim(it); s.t = TV.now();
      a.unshift(s);
      S.set('hist', a.slice(0, 40));
    },
    clear: function () { S.set('hist', []); }
  };

  /* Позиции просмотра фильмов/видео: «Продолжить с 41:12» */
  TV.positions = {
    get: function (id) { var p = S.get('pos', {}); return p[id] || 0; },
    set: function (id, sec, dur) {
      var p = S.get('pos', {});
      if (!sec || (dur && sec > dur - 30)) delete p[id]; else p[id] = Math.floor(sec);
      S.set('pos', p);
    }
  };

  /* История поисковых запросов */
  TV.searches = {
    all: function () { return S.get('searches', []); },
    add: function (q) {
      q = String(q).replace(/^\s+|\s+$/g, ''); if (!q) return;
      var a = TV.filter(TV.searches.all(), function (x) { return x !== q; });
      a.unshift(q); S.set('searches', a.slice(0, 15));
    },
    clear: function () { S.set('searches', []); }
  };

  /* ------------------------------------------------------------ свои ссылки и плейлисты */
  TV.links = {
    all: function () { return S.get('links', []); },
    add: function (n, u) {
      var a = TV.links.all();
      a.unshift({ k: 'url', id: 'u' + TV.now(), n: n || u.split('/').pop() || 'Ссылка', u: u });
      S.set('links', a);
    },
    remove: function (id) { S.set('links', TV.filter(TV.links.all(), function (x) { return x.id !== id; })); }
  };

  /* Разбор M3U-плейлиста в каналы {id, n, l, v:[{u}]} */
  TV.parseM3U = function (text, plId) {
    var lines = String(text).split(/\r?\n/), out = [], cur = null;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].replace(/^\s+|\s+$/g, '');
      if (!l) continue;
      if (l.indexOf('#EXTINF') === 0) {
        var name = l.indexOf(',') >= 0 ? l.slice(l.lastIndexOf(',') + 1) : 'Канал';
        var logo = (l.match(/tvg-logo="([^"]*)"/) || [])[1] || '';
        cur = { n: name.replace(/^\s+|\s+$/g, ''), l: logo };
      } else if (l.charAt(0) !== '#') {
        var c = cur || { n: l.split('/').pop() };
        out.push({ id: plId + ':' + out.length, n: c.n, l: c.l || '', v: [{ u: l }] });
        cur = null;
      }
    }
    return out;
  };
  TV.playlists = {
    all: function () { return S.get('playlists', []); },
    add: function (name, url, cb) {
      TV.ajax(url, { text: true, timeout: 30000 }, function (err, text) {
        if (err) return cb(err);
        var id = 'pl' + TV.now();
        var chans = TV.parseM3U(text, id);
        if (!chans.length) return cb('в плейлисте нет ссылок');
        var a = TV.playlists.all();
        a.push({ id: id, name: name || 'Плейлист', url: url, channels: chans });
        if (!S.set('playlists', a)) return cb('плейлист слишком большой для памяти браузера');
        TV.catalog.load();
        cb(null, chans.length);
      });
    },
    remove: function (id) {
      S.set('playlists', TV.filter(TV.playlists.all(), function (p) { return p.id !== id; }));
      TV.catalog.load();
    }
  };

  /* ------------------------------------------------------------ программа передач (1.0.0) */
  /* data/epg.json собирает tools/build_epg.py раз в день и публикует на GitHub Pages.
     { built, ch: { id канала: [[начало, конец, название], …] } }, время — unix-секунды.
     Держим только в памяти (≈1 МБ — в localStorage старого iPad не поместится вместе с каталогом)
     и перезагружаем раз в 6 часов. */
  var EPG = null, epgT = 0, epgBusy = false;
  function epgSources() {
    var s = [];
    if (/^https?:/.test(location.protocol)) s.push('../data/epg.json');     // свой сервер / GitHub Pages
    if (TV.PAGES) s.push(TV.PAGES + '/data/epg.json');
    return s;
  }
  TV.epg = {
    ready: function () { return !!EPG; },
    load: function (cb) {
      if (EPG && TV.now() - epgT < 6 * 36e5) { if (cb) cb(null); return; }
      if (epgBusy || !TV.settings.epg) { if (cb) cb('busy'); return; }
      epgBusy = true;
      var src = epgSources(), i = 0;
      (function next(lastErr) {
        if (i >= src.length) { epgBusy = false; if (cb) cb(lastErr || 'нет программы'); return; }
        TV.ajax(src[i++] + '?d=' + Math.floor(TV.now() / 36e5), { timeout: 30000 }, function (err, j) {
          if (err || !j || !j.ch || typeof j.ch !== 'object') return next(err || 'формат');
          EPG = j.ch; epgT = TV.now(); epgBusy = false;
          TV.emit('epg');
          if (cb) cb(null);
        });
      })('');
    },
    /* Передачи канала: [{a, b, t}] (a, b — мс) */
    list: function (id) {
      var l = EPG && EPG[id], out = [];
      if (!TV.isArray(l)) return out;
      for (var i = 0; i < l.length; i++) {
        var p = l[i];
        if (TV.isArray(p) && typeof p[2] === 'string') out.push({ a: p[0] * 1000, b: p[1] * 1000, t: p[2] });
      }
      return out;
    },
    /* Что идёт сейчас и далее: { cur, next, pct } или null */
    now: function (id) {
      var l = TV.epg.list(id), t = TV.now();
      for (var i = 0; i < l.length; i++) {
        if (l[i].a <= t && t < l[i].b) return { cur: l[i], next: l[i + 1] || null, pct: Math.round((t - l[i].a) / (l[i].b - l[i].a) * 100) };
      }
      return null;
    },
    hm: function (ms) { var d = new Date(ms), m = d.getMinutes(); return d.getHours() + ':' + (m < 10 ? '0' : '') + m; }
  };
})();
