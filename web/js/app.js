/*
 * BridgeTV — экраны приложения и навигация между ними.
 *
 * Вкладки (нижнее меню / боковая панель на широком экране):
 *   ТВ        — Россия и Беларусь, категории, «Продолжить», номера как на пульте
 *   Поиск     — как на YouTube: подсказки, история, результаты по ТВ, видео, эфирам, фильмам
 *   YouTube   — эфиры, тренды, подборки, подписки
 *   Фильмы    — свои ссылки, M3U-плейлисты, фильмы с ПК, архив кино
 *   Избранное — каналы, видео, YouTube-каналы, фильмы (с сортировкой)
 *   Ещё       — Дополнительно (другие страны и «Мир»), Не работают, Настройки, Помощь
 *
 * У каждой вкладки свой стек экранов (как в iOS): {s: 'имя экрана', ...параметры}.
 * Разметка строится строками (быстро на старых устройствах), события — одним
 * делегированным обработчиком по атрибутам data-a (действие) и data-x (аргумент).
 */
(function () {
  var A = TV.app = {};
  var TABS = [
    { id: 'tv', icon: '📺', name: 'ТВ' }, { id: 'search', icon: '🔍', name: 'Поиск' },
    { id: 'yt', icon: '▶️', name: 'Видео' }, { id: 'movies', icon: '🎬', name: 'Фильмы' },
    { id: 'fav', icon: '⭐', name: 'Избранное' }, { id: 'more', icon: '☰', name: 'Ещё' }
  ];
  var tab = 'tv';
  var stacks = {};
  TV.each(TABS, function (t) { stacks[t.id] = [{ s: t.id }]; });
  var lists = {};                       // id списка -> массив карточек (для плеера)
  var ui = { cat: {}, limit: {}, q: '', sTab: 'all', res: null, favTab: 'ch', favEdit: false };
  var cache = {};                       // кэш ответов YouTube/архива на время сеанса
  var main, head;
  var esc = TV.esc;

  /* ================================================================ карточки */
  function reg(id, arr) { lists[id] = arr; return id; }
  function pageSize() { return TV.lite() ? 48 : 120; }

  function initials(n) {
    var w = String(n || '?').replace(/[^\wА-Яа-яЁё ]/g, '').split(' ');
    return esc(((w[0] || '?').charAt(0) + (w[1] ? w[1].charAt(0) : '')).toUpperCase());
  }
  /* Логотип канала: встроенная иконка 80×80 (data/logos, есть у каналов РФ/РБ — грузится
     мгновенно и без интернета) или картинка из сети */
  function chLogo(c) {
    if (!TV.settings.logos) return '';
    // Встроенной иконки может не быть, если каталог скачан новее приложения — тогда берём из сети
    if (c.li) return '<img src="../data/' + esc(c.li) + '" alt="" data-r="' + esc(remoteLogo(c.l)) + '" onerror="' + FALLBACK + '">';
    return logo(c.l);
  }
  var FALLBACK = "var r=this.getAttribute('data-r');if(r){this.removeAttribute('data-r');this.src=r}else{this.style.display='none'}";
  function remoteLogo(url) {
    if (!url) return '';
    // В лёгком режиме — уменьшенная копия через открытый ресайзер (экономит память старых устройств)
    return TV.lite() ? 'https://wsrv.nl/?w=96&h=96&fit=contain&output=png&url=' + encodeURIComponent(url.replace(/^https?:\/\//, '')) : url;
  }
  function logo(url) {
    if (!url || !TV.settings.logos) return '';
    return '<img src="' + esc(remoteLogo(url)) + '" alt="" onerror="this.style.display=\'none\'">';
  }

  /* «Сейчас в эфире» под названием канала (программа передач, 1.0.0) */
  function epgNow(c) {
    var e = TV.epg && TV.epg.now(c.id);
    return e ? '<small>' + esc(e.cur.t) + '</small>' : '';
  }
  function chCard(c, l, i) {
    var st = TV.health.status(c);
    var fav = TV.fav.has({ k: 'ch', id: c.id });
    return '<button class="card ch st-' + st + '" data-a="play" data-l="' + l + '" data-i="' + i + '">' +
      '<span class="num">' + (c.num || '') + '</span>' +
      '<span class="logo"><b>' + initials(c.n) + '</b>' + chLogo(c) + '</span>' +
      '<span class="nm">' + esc(c.n) + epgNow(c) + '</span>' +
      '<span class="meta"><i class="dot"></i>' + (fav ? '<i class="star">★</i>' : '') + '</span>' +
      '</button>';
  }
  function vCard(it, l, i) {
    if (it.k === 'ytc') {
      return '<button class="card vc" data-a="ytch" data-l="' + l + '" data-i="' + i + '">' +
        '<span class="ava">' + (it.img ? '<img src="' + esc(it.img) + '" alt="">' : initials(it.n)) + '</span>' +
        '<span class="t">' + esc(it.n) + '</span><span class="s">' + esc(it.sub || 'Канал YouTube') + '</span></button>';
    }
    var badge = it.live ? '<em class="live">● В ЭФИРЕ</em>' : it.len ? '<em>' + TV.fmtTime(it.len) + '</em>' : '';
    var pos = it.id ? TV.positions.get(it.k + it.id) : 0;
    var bar = pos && it.len ? '<i class="prog" style="width:' + Math.min(100, Math.round(pos / it.len * 100)) + '%"></i>' : '';
    return '<button class="card v" data-a="play" data-l="' + l + '" data-i="' + i + '">' +
      '<span class="th">' + (it.img ? '<img src="' + esc(it.img) + '" alt="" onerror="this.style.display=\'none\'">' : '') + badge + bar + '</span>' +
      '<span class="t">' + esc(it.n) + '</span>' +
      '<span class="s">' + esc([it.sub, it.views ? TV.fmtViews(it.views) : ''].join(it.sub && it.views ? ' · ' : '')) + '</span></button>';
  }
  function card(it, l, i) { return it.v || it.k === 'ch' && TV.catalog.byId(it.id) ? chCard(it.v ? it : TV.catalog.byId(it.id), l, i) : vCard(it, l, i); }

  function grid(items, l, cls) {
    reg(l, items);
    var lim = ui.limit[l] || pageSize(), h = '<div class="grid ' + (cls || '') + '">';
    for (var i = 0; i < items.length && i < lim; i++) h += card(items[i], l, i);
    h += '</div>';
    if (items.length > lim) h += '<button class="more-btn" data-a="morelist" data-x="' + l + '">Показать ещё (' + (items.length - lim) + ')</button>';
    return h;
  }
  /* Сетка с секциями: «⭐ Главные каналы», затем категории по порядку каталога (Новости, Спорт…).
     Каталог уже отсортирован так же (tools/build_catalog.py → reorganize), поэтому секции идут
     подряд, а номера каналов растут сверху вниз. У каждой секции — своё «Показать ещё». */
  function sectionGrid(items, l) {
    reg(l, items);
    var h = '', i = 0, per = TV.lite() ? 24 : 60;
    while (i < items.length) {
      var key = items[i].top ? 'top' : items[i].c, j = i;
      while (j < items.length && (items[j].top ? 'top' : items[j].c) === key) j++;
      var name = key === 'top' ? '⭐ Главные каналы' : TV.catalog.catName(key) || 'Другие';
      var lim = ui.limit[l + '#' + key] || per;
      h += '<div class="sec-h"><h3>' + esc(name) + '</h3><i>' + (j - i) + '</i></div><div class="grid chs">';
      for (var k = i; k < j && k < i + lim; k++) h += chCard(items[k], l, k);
      h += '</div>';
      if (j - i > lim) h += '<button class="more-btn" data-a="moresec" data-x="' + esc(l + '#' + key) + '">Показать ещё (' + (j - i - lim) + ')</button>';
      i = j;
    }
    return h;
  }

  function shelf(title, items, l, moreAct, moreArg) {
    reg(l, items);
    var h = '<section class="shelf"><div class="sh-h"><h3>' + esc(title) + '</h3>' +
      (moreAct ? '<button class="link" data-a="' + moreAct + '" data-x="' + esc(moreArg || '') + '">Все ›</button>' : '') + '</div>' +
      '<div class="sh-row" data-shelf="1">';
    for (var i = 0; i < items.length && i < 20; i++) h += card(items[i], l, i);
    return h + '</div></section>';
  }
  function placeholder(id, title) {
    return '<section class="shelf" id="' + id + '"><div class="sh-h"><h3>' + esc(title) + '</h3></div>' +
      '<div class="sh-row loading"><span class="spin small"></span> Загрузка…</div></section>';
  }
  function empty(text, icon) { return '<div class="empty"><div class="ei">' + (icon || '📭') + '</div>' + text + '</div>'; }
  function row(act, x, icon, title, sub, right) {
    return '<button class="row" data-a="' + act + '" data-x="' + esc(x || '') + '"><span class="ri">' + icon + '</span>' +
      '<span class="rt"><b>' + esc(title) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
      '<span class="rr">' + (right == null ? '›' : esc(right)) + '</span></button>';
  }
  function chips(items, active, act) {
    var h = '<div class="chips" data-shelf="1">';
    TV.each(items, function (c) {
      h += '<button class="chip' + (c.id === active ? ' on' : '') + '" data-a="' + act + '" data-x="' + esc(c.id) + '">' +
        esc(c.name) + (c.count != null ? ' <i>' + c.count + '</i>' : '') + '</button>';
    });
    return h + '</div>';
  }

  /* Заполнить место-заглушку, если экран ещё на месте */
  function fill(id, html) { var e = document.getElementById(id); if (e) e.outerHTML = html; }
  function cached(key, loader, cb) {
    var c = cache[key];
    if (c && TV.now() - c.t < 10 * 60000) return cb(null, c.v);
    loader(function (err, v) { if (!err) cache[key] = { t: TV.now(), v: v }; cb(err, v); });
  }

  /* ================================================================ экраны */
  var S = {};

  /* ---------- Список каналов региона: категории + фильтр «только рабочие» ---------- */
  function channelList(region, l) {
    var all = TV.catalog.list({ region: region, onlyWorking: TV.settings.onlyWorking });
    var counts = {}, cats = [{ id: 'all', name: 'Все', count: all.length }];
    TV.each(all, function (c) { counts[c.c] = (counts[c.c] || 0) + 1; });
    TV.each(TV.catalog.get().categories, function (c) { if (counts[c.id]) cats.push({ id: c.id, name: c.name, count: counts[c.id] }); });
    var cat = ui.cat[region] || 'all';
    if (cat !== 'all' && !counts[cat]) cat = 'all';
    var items = cat === 'all' ? all : TV.filter(all, function (c) { return c.c === cat; });
    var deadN = TV.catalog.list({ region: region }).length - all.length;
    var h = chips(cats, cat, 'cat:' + region);
    h += '<div class="toolbar"><button class="toggle' + (TV.settings.onlyWorking ? ' on' : '') + '" data-a="onlyWorking">' +
      '<i></i>Только рабочие</button>' +
      (TV.settings.onlyWorking && deadN > 0 ? '<button class="link" data-a="go" data-x="more/dead">Скрыто нерабочих: ' + deadN + '</button>' : '') +
      scanButton() + '</div>';
    h += items.length ? (cat === 'all' ? sectionGrid(items, l) : grid(items, l, 'chs')) : empty('Здесь пока нет рабочих каналов.<br>Выключите «Только рабочие» или обновите каталог.');
    return h;
  }

  /* Кнопка «Проверить каналы» / индикатор хода проверки (только в приложении — см. scan.js) */
  function scanButton() {
    if (!TV.scan.available()) return '';
    if (TV.scan.running()) {
      var p = TV.scan.progress();
      return '<span class="scan" id="scanbar"><span class="spin small"></span>Проверка: ' + p.done + ' из ' + p.total + ' · работает ' + p.ok + '</span>';
    }
    return '<button class="link" data-a="scan" id="scanbar">🔄 Проверить каналы</button>';
  }

  S.tv = function () {
    var cat = TV.catalog.get();
    var prim = TV.catalog.primary();
    var region = TV.settings.region;
    if (region !== 'all' && !TV.catalog.region(region)) region = prim.length ? prim[0].id : 'all';
    var pills = [];
    TV.each(prim, function (r) { pills.push({ id: r.id, name: r.flag + ' ' + r.name }); });
    if (prim.length > 1) pills.push({ id: 'all', name: 'Все' });
    var h = '<div class="pills">' + chips(pills, region, 'region').replace('</div>', '') +
      '<button class="chip ghost" data-a="go" data-x="more/extra">🌍 Другие страны ›</button></div></div>';
    // Продолжить просмотр
    if (TV.settings.kids) h = '<div class="kids-bar"><b>🧸 Детский режим</b><button class="btn" data-a="kidsExit">Выйти (PIN)</button></div>' + h;
    var hist = TV.filter(TV.history.all(), function (x) { return x.k === 'ch' && TV.catalog.byId(x.id) && !TV.blocked(TV.catalog.byId(x.id)); });
    if (hist.length) {
      var hc = []; TV.each(hist.slice(0, 12), function (x) { hc.push(TV.catalog.byId(x.id)); });
      h += shelf('▶ Продолжить', hc, 'hist');
    }
    h += channelList(region, 'tv-' + region);
    if (!cat.channels.length) h = empty('Каталог каналов не загрузился.<br>Ещё → Обновить каталог.', '⚠️');
    return { title: '📺 ' + TV.APP_NAME, html: h, right: '<button class="hbtn" data-a="tab" data-x="search" aria-label="Поиск">🔍</button>' };
  };

  S.region = function (p) {
    var r = TV.catalog.region(p.id) || { name: p.id, flag: '' };
    return { title: r.flag + ' ' + r.name, html: channelList(p.id, 'reg-' + p.id) };
  };

  /* ---------- Голосовой поиск (1.0.0) ----------
     Android / Android TV — системное распознавание речи через мост (TV_NATIVE.voice);
     Chrome, Edge, Safari 14.5+ — Web Speech API. В программе для ПК и старых браузерах кнопки нет. */
  function voiceOk() {
    if (window.TV_NATIVE && window.TV_NATIVE.voice) return true;
    return TV.platform === 'web' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }
  function startVoice() {
    if (window.TV_NATIVE && window.TV_NATIVE.voice) { TV.callNative({ cmd: 'voice' }); TV.toast('🎤 Говорите…'); return; }
    var R = window.SpeechRecognition || window.webkitSpeechRecognition;
    try {
      var r = new R();
      r.lang = 'ru-RU'; r.maxAlternatives = 1; r.interimResults = false;
      r.onresult = function (e) { var t = e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript; if (t) TV.emit('voice', { text: t }); };
      r.onerror = function (e) { TV.toast(e && e.error === 'not-allowed' ? 'Нет доступа к микрофону' : 'Не расслышал, попробуйте ещё'); };
      r.start(); TV.toast('🎤 Говорите…');
    } catch (e) { TV.toast('Голосовой поиск недоступен'); }
  }

  /* ---------- Поиск ---------- */
  var POPULAR = ['новости', 'мультфильмы', 'футбол', 'музыка', 'фильм', 'Беларусь 1', 'НТВ', 'прямой эфир'];
  S.search = function () {
    var h = '<form class="sbar" data-form="search" action="#"><input type="search" name="q" id="q" autocomplete="off" ' +
      'autocorrect="off" placeholder="Каналы, видео, эфиры, фильмы" value="' + esc(ui.q) + '">' +
      (voiceOk() ? '<button class="sbtn mic" type="button" data-a="voice" aria-label="Голосовой поиск" title="Сказать">🎤</button>' : '') +
      '<button class="sbtn" type="submit">Найти</button></form><div id="sugg" class="sugg"></div>';
    if (!ui.res) {
      var hist = TV.searches.all();
      if (hist.length) {
        h += '<div class="sh-h"><h3>Вы искали</h3><button class="link" data-a="clearSearches">Очистить</button></div><div class="chips wrap">';
        TV.each(hist, function (q) { h += '<button class="chip" data-a="q" data-x="' + esc(q) + '">🕘 ' + esc(q) + '</button>'; });
        h += '</div>';
      }
      h += '<div class="sh-h"><h3>Популярное</h3></div><div class="chips wrap">';
      TV.each(POPULAR, function (q) { h += '<button class="chip" data-a="q" data-x="' + esc(q) + '">' + esc(q) + '</button>'; });
      h += '</div>';
      return { title: 'Поиск', html: h };
    }
    var R = ui.res;
    var tabsArr = [{ id: 'all', name: 'Всё' }, { id: 'tv', name: 'ТВ-каналы', count: R.tv.length }];
    if (TV.settings.showYT) tabsArr.push({ id: 'video', name: 'Видео' }, { id: 'live', name: 'Эфиры' }, { id: 'ytc', name: 'Каналы YouTube' });
    tabsArr.push({ id: 'film', name: 'Фильмы' });
    h += chips(tabsArr, ui.sTab, 'stab');
    var t = ui.sTab;
    if (t === 'all') {
      if (R.tv.length) h += shelf('📺 Телеканалы', R.tv, 's-tv', 'stab', 'tv');
      h += R.video ? (R.video.length ? shelf('▶️ Видео', TV.filter(R.video, function (x) { return x.k === 'yt'; }), 's-v', 'stab', 'video') : '') : placeholder('ph-video', '▶️ Видео');
      h += R.film ? (R.film.length ? shelf('🎬 Фильмы (архив)', R.film, 's-f', 'stab', 'film') : '') : placeholder('ph-film', '🎬 Фильмы');
      if (R.video && R.film && !R.tv.length && !R.video.length && !R.film.length) h += empty('Ничего не найдено. Попробуйте другое слово.', '🔍');
      if (R.vErr) h += '<p class="note">YouTube: ' + esc(R.vErr) + '</p>';
    } else if (t === 'tv') {
      h += R.tv.length ? grid(R.tv, 's-tv2', 'chs') : empty('Телеканалов не найдено.');
    } else {
      var key = t === 'film' ? 'film' : t;
      var arr = R[key];
      if (!arr) { h += '<div id="ph-' + key + '" class="loading-big"><span class="spin"></span></div>'; loadSearchPart(key); }
      else {
        if (t === 'video') arr = TV.filter(arr, function (x) { return x.k === 'yt'; });
        h += arr.length ? grid(arr, 's-' + key, t === 'ytc' ? 'vcs' : 'vs') : empty(R[key + 'Err'] || 'Ничего не найдено.');
      }
    }
    return { title: 'Поиск', html: h };
  };

  function runSearch(q) {
    q = String(q || '').replace(/^\s+|\s+$/g, '');
    ui.q = q; ui.sTab = 'all';
    if (!q) { ui.res = null; render(); return; }
    TV.searches.add(q);
    ui.res = { q: q, tv: TV.catalog.search(q, 60) };
    if (!TV.settings.showYT) { ui.res.video = []; ui.res.live = []; ui.res.ytc = []; }
    render();
    if (TV.settings.showYT && TV.yt.canSearch()) loadSearchPart('video');
    else { ui.res.video = []; ui.res.vErr = TV.settings.showYT ? 'для поиска видео нужен ключ YouTube API или зеркало (Ещё → Настройки)' : ''; }
    loadSearchPart('film');
  }
  function loadSearchPart(key) {
    var R = ui.res; if (!R || R['l_' + key]) return;
    R['l_' + key] = 1;
    var q = R.q, done = function (err, arr) {
      if (ui.res !== R) return;
      R[key] = arr || []; if (err) R[key + 'Err'] = String(err);
      if (key === 'video') R.vErr = err;
      if (tab === 'search') render(true);
    };
    if (key === 'video') TV.yt.search(q, { type: 'all' }, function (e, a) {
      if (!e) R.ytc = TV.filter(a, function (x) { return x.k === 'ytc'; });
      done(e, a);
    });
    else if (key === 'live') TV.yt.search(q, { live: true }, done);
    else if (key === 'ytc') TV.yt.search(q, { type: 'channel' }, done);
    else if (key === 'film') TV.arch.search(q, done);
  }

  /* Подсказки при вводе: каналы + история + YouTube */
  var suggT = null, suggQ = '';
  function suggest(q) {
    clearTimeout(suggT);
    var box = document.getElementById('sugg');
    if (!box) return;
    q = q.replace(/^\s+/, '');
    if (!q) { box.innerHTML = ''; return; }
    suggQ = q;
    var h = '', chs = TV.catalog.search(q, 4);
    TV.each(chs, function (c) {
      h += '<button class="sg" data-a="playch" data-x="' + esc(c.id) + '">📺 ' + esc(c.n) + '<small>' + (c.num ? '№' + c.num : '') + '</small></button>';
    });
    TV.each(TV.filter(TV.searches.all(), function (s) { return s.toLowerCase().indexOf(q.toLowerCase()) === 0; }).slice(0, 3), function (s) {
      h += '<button class="sg" data-a="q" data-x="' + esc(s) + '">🕘 ' + esc(s) + '</button>';
    });
    box.innerHTML = h;
    suggT = setTimeout(function () {
      TV.yt.suggest(q, function (err, arr) {
        if (err || suggQ !== q || !document.getElementById('sugg')) return;
        var x = '';
        TV.each(arr.slice(0, 6), function (s) { x += '<button class="sg" data-a="q" data-x="' + esc(s) + '">🔍 ' + esc(s) + '</button>'; });
        document.getElementById('sugg').innerHTML = h + x;
      });
    }, TV.lite() ? 600 : 300);
  }

  /* ---------- Видео (YouTube) ----------
     С 0.2.4: строка поиска с фильтрами (тип: видео/эфиры, длительность, сортировка) и рубрики
     обычных видео; эфиры — отдельный фильтр и последняя полка. */
  var yv = { q: '', type: 'video', dur: '', sort: '', page: 1, res: null };
  /* Карточка-подсказка о режиме YouTube (0.3.0) */
  function ytModeNote() {
    var m = TV.yt.mode();
    if (m === 'none') return '<section class="box"><h3>▶️ Видео на этом устройстве</h3><p class="note">Официальный плеер YouTube не поддерживает ' +
      'эту версию системы (' + esc(TV.device.label) + '). Можно подключить своё зеркало Invidious — тогда видео пойдут и здесь.</p>' +
      '<button class="btn primary" data-a="go" data-x="more/settings">Настройки → своё зеркало</button></section>';
    if (m === 'official' && !TV.yt.hasKey()) return '<section class="box"><h3>🔑 Поиск и подборки YouTube</h3><p class="note">Видео играют в официальном ' +
      'плеере YouTube. Для поиска и подборок нужен бесплатный ключ YouTube API (5 минут, один раз) — без ключа доступны ' +
      'подборки официальных каналов — новинки кино, мультфильмы, аниме' + (TV.native ? '' : ' (в приложении BridgeTV)') + ' и поиск на сайте YouTube.</p>' +
      '<button class="btn primary" data-a="go" data-x="more/ytkey">Как получить ключ</button></section>';
    return '';
  }

  S.yt = function () {
    var h = '<form class="sbar" data-form="ytsearch" action="#"><input type="search" name="q" autocomplete="off" autocorrect="off" ' +
      'placeholder="Искать видео, фильмы, сериалы, музыку" value="' + esc(yv.q) + '"><button class="sbtn" type="submit">Найти</button></form>';
    h += '<div class="filters">' + chips([{ id: 'video', name: '▶️ Видео' }, { id: 'live', name: '🔴 Прямые эфиры' }], yv.type, 'yvtype');
    if (yv.q && yv.type === 'video') {
      h += chips([{ id: '', name: 'Любая длина' }, { id: 'short', name: 'До 4 мин' }, { id: 'medium', name: '4–20 мин' },
        { id: 'long', name: 'Больше 20 мин (фильмы, сериалы)' }], yv.dur, 'yvdur') +
        chips([{ id: '', name: 'Подходящие' }, { id: 'upload_date', name: 'Новые' }, { id: 'view_count', name: 'Популярные' }], yv.sort, 'yvsort');
    }
    h += '</div>';
    if ((yv.q || yv.type === 'live') && !TV.yt.canSearch()) {
      // без ключа и зеркала искать негде — откроем поиск на сайте YouTube
      if (yv.q) TV.openExternal(TV.yt.searchWebUrl(yv.q));
      yv.q = ''; yv.type = 'video';
      return { title: '▶️ Видео', html: h + ytModeNote(), after: loadYtShelves };
    }
    if (yv.q || yv.type === 'live') {
      if (!yv.res) return { title: '▶️ Видео', html: h + '<div class="loading-big"><span class="spin"></span></div>', after: runYv };
      if (yv.res.err && !yv.res.items.length) h += empty('Не загрузилось: ' + esc(yv.res.err), '⚠️');
      else if (!yv.res.items.length) h += empty('Ничего не найдено. Попробуйте другие слова.', '🔍');
      else {
        h += grid(yv.res.items, 'yv-res', 'vs');
        h += '<button class="more-btn" data-a="yvmore">Ещё результаты</button>';
      }
      return { title: '▶️ Видео', html: h };
    }
    h += ytModeNote();
    var subs = TV.subs.all();
    if (subs.length) h += shelf('📌 Мои подписки', subs, 'yt-subs');
    TV.each(ytShelves(), function (s) { h += placeholder('ytsh-' + s.id, s.title); });
    var inst = TV.yt.current(), m = TV.yt.mode();
    if (m === 'official') h += '<p class="note">Видео играют в официальном плеере YouTube (качество и субтитры — кнопками плеера). ' +
      'Приложение не связано с YouTube и Google. <button class="link" data-a="go" data-x="more/settings">Источник видео</button></p>';
    else if (m === 'mirror') h += '<p class="note">Качество, озвучку (перевод) и субтитры можно выбрать в плеере кнопкой ⚙. ' +
      'Видео идут через ваше зеркало ' + esc(inst ? inst.url.replace(/^https?:\/\//, '') : '') +
      '. Приложение не связано с YouTube и Google. <button class="link" data-a="go" data-x="more/settings">Настройки</button></p>';
    return { title: '▶️ Видео', html: h, after: loadYtShelves };
  };
  /* Поиск на вкладке «Видео»; more — дозагрузить следующую страницу */
  function runYv(more) {
    var q = yv.q || 'прямой эфир', want = yv;
    TV.yt.search(q, { live: yv.type === 'live', duration: yv.type === 'live' ? '' : yv.dur, sort: yv.sort, page: yv.page },
      function (err, arr) {
        if (want !== yv) return;
        var items = TV.filter(arr || [], function (x) { return x.k === 'yt'; });
        if (more && yv.res) { yv.res.items = yv.res.items.concat(items); yv.res.err = err; }
        else yv.res = { items: items, err: err };
        if (tab === 'yt' && stacks.yt.length === 1) render(!!more);
      });
  }
  /* Полки: с ключом/зеркалом — рубрики; без них — официальные каналы киностудий (RSS) */
  /* Детский режим (родительский контроль): только детские подборки */
  function feedsList() { return TV.settings.kids ? TV.filter(TV.yt.feeds, function (f) { return f.id === 'kidsnew'; }) : TV.yt.feeds; }
  function archList() { return TV.settings.kids ? TV.filter(TV.arch.shelves, function (s) { return s.id === 'toons'; }) : TV.arch.shelves; }
  function ytSearchShelves() { return TV.settings.kids ? TV.filter(TV.yt.shelves, function (s) { return s.id === 'kids'; }) : TV.yt.shelves; }
  function ytShelves() {
    var m = TV.yt.mode();
    if (m === 'none') return [];
    var out = [];
    // RSS-ленты официальных каналов — в приложении (без ключа) или через API (с ключом)
    if (m === 'official' && (TV.native || TV.yt.hasKey())) TV.each(feedsList(), function (f) { out.push({ id: 'f-' + f.id, title: f.title, feed: f }); });
    if (TV.yt.canSearch()) out = out.slice(0, 3).concat(ytSearchShelves()).concat(out.slice(3));   // новинки — первыми
    return out;
  }
  function loadYtShelves() {
    var i = 0, list = ytShelves();
    // На старых устройствах грузим полки по одной, на новых — по три параллельно
    var par = TV.lite() ? 1 : 3;
    function nextShelf() {
      if (i >= list.length || tab !== 'yt' || stacks.yt.length > 1 || yv.q || yv.type !== 'video') return;
      var s = list[i++];
      var loader = s.trending ? function (cb) { TV.yt.trending(cb); }
        : s.feed ? function (cb) { TV.yt.feed(s.feed, cb); }
        : s.ch ? function (cb) { TV.yt.channel(s.ch, cb); }
        : function (cb) { TV.yt.search(s.q, { live: s.live, duration: s.d, sort: s.sort }, cb); };
      cached('sh:' + s.id, loader, function (err, items) {
        if (err) fill('ytsh-' + s.id, '<section class="shelf"><div class="sh-h"><h3>' + esc(s.title) + '</h3></div><p class="note">Не загрузилось: ' + esc(err) + '</p></section>');
        else fill('ytsh-' + s.id, items.length ? shelf(s.title, TV.filter(items, function (x) { return x.k === 'yt'; }), 'ytl-' + s.id, 'ytshelf', s.id) : '');
        nextShelf();
      });
    }
    for (var k = 0; k < par; k++) nextShelf();
  }

  S.ytlist = function (p) {
    var s = TV.find(ytShelves(), function (x) { return x.id === p.id; }) || { title: 'Видео' };
    var key = 'sh:' + p.id, c = cache[key];
    if (!c) return { title: s.title, html: '<div class="loading-big"><span class="spin"></span></div>' };
    return { title: s.title, html: grid(TV.filter(c.v, function (x) { return x.k === 'yt'; }), 'ytfull-' + p.id, 'vs') };
  };

  S.ytch = function (p) {
    var key = 'ch:' + p.id, c = cache[key];
    var sub = TV.subs.has(p.id);
    var h = '<div class="ch-head">' + (p.img ? '<img src="' + esc(p.img) + '" alt="">' : '') + '<b>' + esc(p.n) + '</b>' +
      '<button class="btn' + (sub ? '' : ' primary') + '" data-a="subscribe">' + (sub ? '✓ Вы подписаны' : '+ Подписаться') + '</button></div>';
    if (!c) {
      h += '<div class="loading-big"><span class="spin"></span></div>';
      return { title: p.n, html: h, after: function () {
        TV.yt.channel(p.id, function (err, items) {
          if (!err) cache[key] = { t: TV.now(), v: items };
          if (top().s === 'ytch' && top().id === p.id) { if (err) TV.toast('Канал не загрузился: ' + err); render(true); }
        });
      } };
    }
    return { title: p.n, html: h + (c.v.length ? grid(c.v, 'ytch-' + p.id, 'vs') : empty('Видео не найдено.')) };
  };

  /* ---------- Фильмы ----------
     С 0.2.4: поиск фильмов с фильтрами (жанр, годы, советские/зарубежные) по YouTube (полнометражные
     ролики) и Архиву кино, «Искать в Google», загрузки на устройство, фильмы с ПК и свои ссылки. */
  var fm = { q: '', genre: 'all', years: 'all', origin: 'all', res: null };
  function fmActive() { return !!(fm.q || fm.genre !== 'all' || fm.years !== 'all' || fm.origin !== 'all'); }
  S.movies = function () {
    var h = '<form class="sbar" data-form="fmsearch" action="#"><input type="search" name="q" autocomplete="off" autocorrect="off" ' +
      'placeholder="Найти фильм: название, актёр, режиссёр" value="' + esc(fm.q) + '"><button class="sbtn" type="submit">Найти</button></form>';
    h += '<div class="filters">' + chips(TV.films.genres, fm.genre, 'fmgenre') + chips(TV.films.yearsList, fm.years, 'fmyears') +
      chips(TV.films.origins, fm.origin, 'fmorigin') + '</div>';
    var dls = TV.dl.all();
    h += '<div class="tools"><button class="btn" data-a="google">🔎 Искать в Google</button>' +
      (TV.dl.available() ? '<button class="btn" data-a="go" data-x="movies/downloads">📥 Загрузки' + (dls.length ? ' (' + dls.length + ')' : '') + '</button>' : '') +
      '<button class="btn" data-a="scrollto" data-x="box-pc">💻 С компьютера</button>' +
      '<button class="btn" data-a="scrollto" data-x="box-links">🔗 По ссылке</button></div>';
    var after = loadArchShelves;
    if (fmActive()) {
      if (!fm.res) { h += '<div class="loading-big"><span class="spin"></span></div>'; after = runFm; }
      else {
        var R = fm.res;
        if (R.yt === null) h += placeholderBig();
        else if (R.yt.length) h += '<div class="sec-h"><h3>▶️ Фильмы на YouTube</h3><i>' + R.yt.length + '</i></div>' + grid(R.yt, 'fm-yt', 'vs');
        if (R.arch === null) h += placeholderBig();
        else if (R.arch.length) h += '<div class="sec-h"><h3>🎞 Архив кино (общественное достояние)</h3><i>' + R.arch.length + '</i></div>' + grid(R.arch, 'fm-ar', 'vs');
        if (R.yt && R.arch && !R.yt.length && !R.arch.length)
          h += empty('Ничего не найдено. Попробуйте другие фильтры или «Искать в Google».', '🎬');
        after = null;
      }
    } else {
      var cont = TV.filter(TV.history.all(), function (x) { return x.k !== 'ch' && x.id && TV.positions.get(x.k + x.id) > 0; });
      if (cont.length) h += shelf('⏯ Продолжить просмотр', cont.slice(0, 15), 'mv-cont');
      var ready = TV.filter(dls, function (d) { return d.done; });
      if (ready.length) { var di = []; TV.each(ready, function (d) { di.push(TV.dl.item(d)); }); h += shelf('📥 Скачанные', di, 'mv-dl', 'go', 'movies/downloads'); }
      if (ytFeedsOk()) TV.each(feedsList(), function (f) { h += placeholder('fdsh-' + f.id, f.title); });
      TV.each(archList(), function (s) { h += placeholder('arsh-' + s.id, s.title); });
      h += '<p class="note">Новинки — трейлеры и премьеры с официальных каналов прокатчиков и онлайн-кинотеатров; аниме — с официальных ' +
        'каналов правообладателей. «Архив кино» — фильмы в общественном достоянии (archive.org). Фильмы из архива, свои ссылки и файлы с ПК можно скачать на устройство (кнопка ⬇ в плеере).</p>';
    }

    h += '<section class="box" id="box-links"><h3>🔗 Мои ссылки</h3>' +
      '<form class="form" data-form="addlink" action="#"><input name="u" type="url" placeholder="Ссылка на видео .m3u8 / .mp4" autocapitalize="off">' +
      '<input name="n" placeholder="Название (необязательно)"><button class="btn primary" type="submit">Добавить</button></form>';
    var links = TV.links.all();
    if (links.length) {
      reg('links', links);
      TV.each(links, function (x, i) {
        h += '<div class="lrow"><button class="row" data-a="play" data-l="links" data-i="' + i + '"><span class="ri">▶</span>' +
          '<span class="rt"><b>' + esc(x.n) + '</b><small>' + esc(x.u) + '</small></span></button>' +
          '<button class="icon-btn" data-a="dellink" data-x="' + esc(x.id) + '" aria-label="Удалить">✕</button></div>';
      });
    }
    h += '</section>';

    h += '<section class="box"><h3>📁 Плейлисты M3U</h3><p class="note">Свой список каналов или фильмов по ссылке. Появится в ТВ → Другие страны → «Мои плейлисты».</p>' +
      '<form class="form" data-form="addpl" action="#"><input name="u" type="url" placeholder="Ссылка на .m3u / .m3u8" autocapitalize="off">' +
      '<input name="n" placeholder="Название"><button class="btn primary" type="submit">Загрузить</button></form>';
    TV.each(TV.playlists.all(), function (p) {
      h += '<div class="lrow"><button class="row" data-a="go" data-x="tv/region:my"><span class="ri">📁</span><span class="rt"><b>' + esc(p.name) +
        '</b><small>' + p.channels.length + ' ссылок</small></span></button><button class="icon-btn" data-a="delpl" data-x="' + esc(p.id) + '">✕</button></div>';
    });
    h += '</section>';

    var pcUrl = TV.store.get('pcUrl', '');
    h += '<section class="box" id="box-pc"><h3>💻 Фильмы с компьютера</h3><p class="note">На ПК запустите <code>python tools/serve.py --media "D:\\Фильмы"</code> и введите адрес, который он покажет. iPad и старые устройства играют mp4/m4v/mov (H.264). Файл можно скачать на iPad кнопкой ⬇ в плеере — тогда ПК для просмотра не нужен.</p>' +
      '<form class="form" data-form="pc" action="#"><input name="u" type="url" value="' + esc(pcUrl) + '" placeholder="http://192.168.1.10:8080/media/" autocapitalize="off">' +
      '<button class="btn primary" type="submit">Открыть</button></form></section>';
    return { title: '🎬 Фильмы', html: h, after: after };
  };
  /* Можно ли показать подборки официальных каналов YouTube на этом устройстве */
  function ytFeedsOk() {
    var m = TV.settings.showYT ? TV.yt.mode() : 'none';
    return m === 'mirror' || (m === 'official' && (TV.native || TV.yt.hasKey()));
  }
  function placeholderBig() { return '<div class="loading-big"><span class="spin"></span></div>'; }
  function runFm() {
    var want = fm;
    TV.films.search(fm.q, { genre: fm.genre, years: fm.years, origin: fm.origin }, function (res) {
      if (want !== fm) return;
      fm.res = res;
      if (tab === 'movies' && stacks.movies.length === 1) render(true);
    });
  }

  /* Загрузки на устройство (только в приложении) */
  S.downloads = function () {
    var list = TV.dl.all(), h = '';
    if (!list.length) return { title: '📥 Загрузки', html: empty('Здесь будут скачанные фильмы. Скачать можно фильмы Архива кино, свои ссылки и файлы с ПК — кнопкой ⬇ в плеере.', '📥') };
    h += '<div class="rows">';
    TV.each(list, function (d) {
      var pct = d.size ? Math.min(100, Math.round(d.got / d.size * 100)) : 0;
      var sub = d.done ? (d.size ? Math.round(d.size / 1048576) + ' МБ · можно смотреть без интернета' : 'Готово')
        : d.err ? 'Ошибка: ' + d.err : 'Скачивается… ' + pct + '%' + (d.size ? ' из ' + Math.round(d.size / 1048576) + ' МБ' : '');
      h += '<div class="lrow"><button class="row" data-a="dlplay" data-x="' + esc(d.id) + '"' + (d.done ? '' : ' disabled') + '><span class="ri">' + (d.done ? '▶' : d.err ? '⚠️' : '⬇') + '</span>' +
        '<span class="rt"><b>' + esc(d.n) + '</b><small>' + esc(sub) + '</small>' + (!d.done && !d.err ? '<span class="dl-prog"><i style="width:' + pct + '%"></i></span>' : '') + '</span></button>' +
        '<button class="icon-btn" data-a="dldel" data-x="' + esc(d.id) + '" aria-label="Удалить">✕</button></div>';
    });
    h += '</div><p class="note">Файлы хранятся в приложении. Удаление здесь освобождает место на устройстве.</p>';
    return { title: '📥 Загрузки', html: h };
  };

  function loadArchShelves() {
    // Очередь: сначала официальные киностудии (YouTube), потом архив
    var jobs = [];
    if (ytFeedsOk()) TV.each(feedsList(), function (f) {
      jobs.push({ ph: 'fdsh-' + f.id, key: 'fd:' + f.id, title: f.title, l: 'fdl-' + f.id,
        load: function (cb) { TV.yt.feed(f, cb); } });
    });
    TV.each(archList(), function (s) {
      jobs.push({ ph: 'arsh-' + s.id, key: 'ar:' + s.id, title: s.title, l: 'arl-' + s.id, more: s.id,
        load: function (cb) { TV.arch.query(s.q, 40, cb); } });
    });
    var i = 0;
    function nextShelf() {
      if (i >= jobs.length || tab !== 'movies' || stacks.movies.length > 1) return;
      var j = jobs[i++];
      cached(j.key, j.load, function (err, items) {
        var vids = TV.filter(items || [], function (x) { return x.k !== 'ytc'; });
        fill(j.ph, err || !vids.length ? '' : shelf(j.title, vids, j.l, j.more ? 'archshelf' : null, j.more));
        nextShelf();
      });
    }
    nextShelf(); if (!TV.lite()) nextShelf();
  }
  S.archlist = function (p) {
    var s = TV.find(TV.arch.shelves, function (x) { return x.id === p.id; }), c = cache['ar:' + p.id];
    return { title: s.title, html: c ? grid(c.v, 'arfull-' + p.id, 'vs') : '<div class="loading-big"><span class="spin"></span></div>' };
  };

  S.pc = function (p) {
    var key = 'pc:' + p.url, c = cache[key];
    if (!c) return { title: decodeURIComponent(p.url.replace(/\/$/, '').split('/').pop() || 'Папка'),
      html: '<div class="loading-big"><span class="spin"></span></div>', after: function () {
        TV.pc.list(p.url, function (err, items) {
          if (err) { TV.toast('Папка не открылась: ' + err); A.back(); return; }
          cache[key] = { t: TV.now(), v: items };
          if (top().s === 'pc') render(true);
        });
      } };
    var dirs = TV.filter(c.v, function (x) { return x.dir; }), files = TV.filter(c.v, function (x) { return !x.dir; });
    var h = '';
    TV.each(dirs, function (d) { h += row('pcdir', d.u, '📁', d.n, '', null); });
    reg('pcf', files);
    TV.each(files, function (f, i) {
      var ok = TV.pc.playable(f.n);
      h += '<button class="row' + (ok ? '' : ' dim') + '" data-a="play" data-l="pcf" data-i="' + i + '"><span class="ri">🎞</span>' +
        '<span class="rt"><b>' + esc(f.n) + '</b><small>' + esc(f.sub || '') + (ok ? '' : ' · формат может не открыться на этом устройстве') + '</small></span><span class="rr">▶</span></button>';
    });
    if (!c.v.length) h = empty('В папке нет видео.');
    return { title: decodeURIComponent(p.url.replace(/\/$/, '').split('/').pop() || 'Папка'), html: '<div class="rows">' + h + '</div>' };
  };

  /* ---------- Избранное ---------- */
  S.fav = function () {
    var groups = [
      { id: 'ch', name: '📺 Каналы', items: TV.filter(TV.fav.of('ch'), function (x) { return TV.catalog.byId(x.id); }) },
      { id: 'yt', name: '▶️ Видео', items: TV.fav.of('yt') },
      { id: 'ytc', name: '👤 YouTube-каналы', items: TV.subs.all().concat(TV.fav.of('ytc')) },
      { id: 'film', name: '🎬 Фильмы и ссылки', items: TV.filter(TV.fav.all(), function (x) { return x.k === 'arch' || x.k === 'url' || x.k === 'pc'; }) }
    ];
    var g = TV.find(groups, function (x) { return x.id === ui.favTab; }) || groups[0];
    var cs = []; TV.each(groups, function (x) { cs.push({ id: x.id, name: x.name, count: x.items.length }); });
    var h = chips(cs, g.id, 'favtab');
    if (!g.items.length) {
      h += empty(g.id === 'ch' ? 'Добавляйте каналы кнопкой ☆ в плеере или долгим нажатием на карточку.' :
        g.id === 'ytc' ? 'Подпишитесь на канал YouTube — его видео будут здесь.' : 'Пока пусто. ☆ в плеере добавляет сюда.', '⭐');
      return { title: '⭐ Избранное', html: h };
    }
    if (g.id === 'ch') {
      h += '<div class="toolbar"><button class="toggle' + (ui.favEdit ? ' on' : '') + '" data-a="favedit"><i></i>Порядок и удаление</button></div>';
      var chans = []; TV.each(g.items, function (x) { chans.push(TV.catalog.byId(x.id)); });
      if (ui.favEdit) {
        h += '<div class="rows">';
        TV.each(chans, function (c, i) {
          h += '<div class="lrow"><span class="row static"><span class="ri">' + (i + 1) + '</span><span class="rt"><b>' + esc(c.n) + '</b></span></span>' +
            '<button class="icon-btn" data-a="favup" data-x="' + esc(c.id) + '">▲</button><button class="icon-btn" data-a="favdown" data-x="' + esc(c.id) + '">▼</button>' +
            '<button class="icon-btn" data-a="favdel" data-x="' + esc(c.id) + '">✕</button></div>';
        });
        h += '</div>';
      } else h += grid(chans, 'fav-ch', 'chs');
    } else h += grid(g.items, 'fav-' + g.id, g.id === 'ytc' ? 'vcs' : 'vs');
    return { title: '⭐ Избранное', html: h };
  };

  /* ---------- Ещё ---------- */
  S.more = function () {
    var cat = TV.catalog.get();
    var dead = TV.catalog.dead().length;
    var h = '<div class="rows">' +
      row('go', 'more/extra', '🌍', 'Дополнительно: другие страны', 'Украина, Казахстан, Польша… и подборки «Мир»') +
      row('go', 'more/dead', '🚫', 'Не работают', 'Каналы, которые сейчас не отвечают', String(dead)) +
      row('go', 'more/settings', '⚙️', 'Настройки', 'Режим для старой техники, качество, YouTube') +
      row('updateCatalog', '', '🔄', 'Обновить список каналов', 'Каталог от ' + (cat.version || '—') + (cat.checked ? ', проверен ' + cat.checked : ''), '') +
      (TV.scan.available() ? row('scan', '', '🩺', 'Проверить каналы на этом устройстве',
        TV.scan.running() ? 'Идёт проверка…' : TV.scan.lastTime() ? 'Последняя: ' + new Date(TV.scan.lastTime()).toLocaleString() : 'Ещё не проверялись', '') : '') +
      row('go', 'more/help', '❓', 'Помощь и сертификаты', 'Если ничего не грузится на старом iPad') +
      row('install', '', '📲', 'Установить на другие устройства', 'Windows, Linux, Android, iPhone/iPad, Smart TV', '›') +
      '</div><p class="note center">' + esc(TV.APP_NAME) + ' ' + TV.VERSION + ' · ' + esc(TV.device.label) +
      ' · режим: ' + (TV.lite() ? 'лёгкий' : 'полный') + '<br>Открытый код · только бесплатные открытые трансляции</p>';
    return { title: 'Ещё', html: h };
  };
  S.extra = function () {
    var h = '<div class="rows">', world = '';
    TV.each(TV.catalog.extra(), function (r) {
      var total = TV.catalog.list({ region: r.id }).length, ok = TV.catalog.list({ region: r.id, onlyWorking: true }).length;
      var line = row('go', 'more/region:' + r.id, r.flag, r.name, ok + ' рабочих из ' + total, '›');
      if (r.world) world += line; else h += line;
    });
    h += '</div>';
    if (world) h += '<div class="sh-h"><h3>Подборки «Мир»</h3></div><div class="rows">' + world + '</div>';
    return { title: '🌍 Дополнительно', html: h };
  };
  S.dead = function () {
    var d = TV.catalog.dead();
    var h = '<p class="note">Каналы, которые не ответили при проверке каталога или у вас. Ссылки иногда оживают — можно попробовать. ' +
      'Если канал заработает, он сам вернётся в списки.</p><div class="toolbar"><button class="btn" data-a="resetHealth">Сбросить мои отметки</button></div>';
    var prim = TV.filter(d, function (c) { return TV.catalog.isPrimaryRegion(c.r); });
    var other = TV.filter(d, function (c) { return !TV.catalog.isPrimaryRegion(c.r); });
    if (prim.length) h += '<div class="sh-h"><h3>Россия и Беларусь · ' + prim.length + '</h3></div>' + grid(prim, 'dead-p', 'chs');
    if (other.length) h += '<div class="sh-h"><h3>Другие страны · ' + other.length + '</h3></div>' + grid(other, 'dead-o', 'chs');
    if (!d.length) h += empty('Все каналы работают 🎉', '✅');
    return { title: '🚫 Не работают', html: h };
  };

  function sel(name, opts, val) {
    var h = '<select data-set="' + name + '">';
    TV.each(opts, function (o) { h += '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(val) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; });
    return h + '</select>';
  }
  function sw(name, title, sub) {
    return '<button class="row" data-a="set" data-x="' + name + '"><span class="rt"><b>' + esc(title) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') +
      '</span><span class="switch' + (TV.settings[name] ? ' on' : '') + '"><i></i></span></button>';
  }
  /* ---------- Родительский контроль (1.0.0) ----------
     PIN задаётся в Настройках; в детском режиме Настройки и выход из режима — только по PIN.
     PIN хранится на устройстве (это защита от ребёнка, а не от взлома). */
  var pinOk = false;
  S.pin = function () {
    var h = '<section class="box"><h3>🔒 Родительский контроль</h3><p class="note">Введите PIN, чтобы открыть настройки или выключить детский режим.</p>' +
      '<form class="form" data-form="pin" action="#"><input name="u" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="PIN">' +
      '<button class="btn primary" type="submit">Открыть</button></form></section>';
    return { title: '🔒 PIN', html: h };
  };
  function pinGate() { return TV.settings.kids && /^\d{4}$/.test(TV.settings.pin || '') && !pinOk; }

  /* ---------- Перенос избранного и настроек (1.0.0) ----------
     Код = base64(JSON) с избранным, подписками, ссылками, плейлистами, историей поиска и настройками.
     Ключ YouTube и PIN не переносятся. Без сервера: код копируется или сохраняется файлом. */
  var BK_KEYS = ['fav', 'subs', 'links', 'playlists', 'searches', 'pos'];
  function exportBackup() {
    var o = { app: 'BridgeTV', v: 1, t: TV.now(), data: {}, settings: {} };
    TV.each(BK_KEYS, function (k) { var v = TV.store.get(k, null); if (v != null) o.data[k] = v; });
    for (var k in TV.settings) if (TV.settings.hasOwnProperty(k) && k !== 'ytKey' && k !== 'pin' && k !== 'kids') o.settings[k] = TV.settings[k];
    try { return 'BTV1:' + btoa(unescape(encodeURIComponent(JSON.stringify(o)))); } catch (e) { return ''; }
  }
  function importBackup(code) {
    code = String(code || '').replace(/\s+/g, '');
    if (code.indexOf('BTV1:') !== 0 || code.length > 4e6) return 0;
    var o;
    try { o = JSON.parse(decodeURIComponent(escape(atob(code.slice(5))))); } catch (e) { return 0; }
    if (!o || o.app !== 'BridgeTV' || typeof o.data !== 'object') return 0;
    var n = 0;
    TV.each(BK_KEYS, function (k) { if (o.data[k] != null && typeof o.data[k] === 'object') { TV.store.set(k, o.data[k]); n++; } });
    if (o.settings && typeof o.settings === 'object') {
      for (var k in o.settings) if (o.settings.hasOwnProperty(k) && TV.defaults.hasOwnProperty(k) && k !== 'ytKey' && k !== 'pin' && k !== 'kids' &&
        typeof o.settings[k] === typeof TV.defaults[k]) TV.settings[k] = o.settings[k];
      TV.saveSettings(); n++;
    }
    var favs = (o.data.fav && o.data.fav.length) || 0;
    return n ? (favs ? favs + ' в избранном' : 'настройки') : 0;
  }
  function saveBackupFile() {
    var code = exportBackup();
    try {
      var a = document.createElement('a');
      a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(code);
      a.download = 'BridgeTV-перенос.txt';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } catch (e) { TV.toast('Не получилось — скопируйте код'); }
  }
  S.backup = function () {
    var h = '<section class="box"><h3>📤 Перенести на другое устройство</h3><p class="note">Скопируйте этот код (или сохраните файлом) и вставьте на другом устройстве ниже. ' +
      'В коде — избранное, подписки, ссылки, плейлисты и настройки. Ключ YouTube и PIN не переносятся.</p>' +
      '<textarea class="code" id="bk-out" readonly>' + esc(exportBackup()) + '</textarea>' +
      '<div class="tools"><button class="btn primary" data-a="backupCopy">Копировать</button>' +
      (TV.native ? '' : '<button class="btn" data-a="backupFile">Сохранить файлом</button>') + '</div></section>' +
      '<section class="box"><h3>📥 Получить с другого устройства</h3><p class="note">Вставьте код. Избранное и настройки этого устройства заменятся.</p>' +
      '<textarea class="code" id="bk-in" placeholder="BTV1:…"></textarea>' +
      '<div class="tools"><button class="btn primary" data-a="backupLoad">Загрузить</button></div></section>';
    return { title: '🔄 Перенос избранного', html: h };
  };

  S.settings = function () {
    if (pinGate()) return S.pin();
    var s = TV.settings;
    var h = '<div class="rows">' +
      '<label class="row"><span class="rt"><b>Режим устройства</b><small>Лёгкий: меньше анимаций и картинок, качество до 480p, экономия памяти</small></span>' +
      sel('mode', [['auto', 'Авто (' + (TV.device.old ? 'лёгкий' : 'полный') + ')'], ['lite', 'Лёгкий'], ['full', 'Полный']], s.mode) + '</label>' +
      sw('onlyWorking', 'Только рабочие каналы', 'Прятать каналы, которые не отвечают') +
      sw('autoNext', 'Резервные источники', 'Если канал не ответил — сразу пробовать другой источник') +
      sw('logos', 'Логотипы каналов', 'Выключите на очень медленном интернете') +
      sw('safe', 'Безопасный режим', 'Скрывать источники, признанные нежелательными в РФ или экстремистскими в РБ (см. Помощь → Правовая информация)') +
      sw('showYT', 'Вкладка «Видео» (YouTube)', 'Видео и подборки YouTube. Выключите, если не нужно') +
      sw('epg', 'Программа передач', 'Что идёт сейчас и дальше — на карточках каналов и в плеере (📋)') +
      sw('nextEp', 'Следующее видео автоматически', 'В конце видео или серии — следующее через 5 секунд') +
      '<label class="row"><span class="rt"><b>Размер текста</b><small>Крупнее — удобнее издалека и для пожилых</small></span>' +
      sel('font', [['100', 'Обычный'], ['115', 'Крупный'], ['130', 'Очень крупный']], s.font) + '</label>' +
      '</div><div class="sh-h"><h3>Родительский контроль</h3></div><div class="rows">' +
      '<label class="row"><span class="rt"><b>PIN</b><small>4 цифры. Нужен, чтобы выйти из детского режима и открыть настройки</small></span>' +
      '<input data-set="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" placeholder="····" value="' + esc(s.pin) + '"></label>' +
      sw('kids', 'Детский режим', 'Только детские каналы, мультфильмы и строгий безопасный поиск YouTube') +
      '<label class="row"><span class="rt"><b>Ждать источник</b><small>Сколько секунд ждать ответа, прежде чем перейти к резервному</small></span>' +
      sel('timeout', [[8, '8 с'], [12, '12 с'], [16, '16 с'], [20, '20 с']], s.timeout) + '</label>' +
      '</div><div class="sh-h"><h3>Видео YouTube</h3></div><div class="rows">' +
      '<label class="row"><span class="rt"><b>Источник видео</b><small>Сейчас: ' + esc(ytModeName()) + '</small></span>' +
      sel('ytSource', [['auto', 'Авто (по устройству)'], ['official', 'Официальный плеер YouTube'], ['mirror', 'Своё зеркало']], s.ytSource) + '</label>' +
      '<label class="row col"><span class="rt"><b>Ключ YouTube API</b><small>Для поиска и подборок. Бесплатно — <button class="link" data-a="go" data-x="more/ytkey">как получить</button>. Хранится только на этом устройстве.</small></span>' +
      '<input data-set="ytKey" type="password" autocomplete="off" placeholder="AIza…" value="' + esc(s.ytKey) + '"></label>' +
      '<label class="row col"><span class="rt"><b>Своё зеркало Invidious/Piped</b><small>Для старых устройств, где официальный плеер не работает (iPad на iOS 9–11, Android 4.4)</small></span>' +
      '<input data-set="ytInstance" type="url" placeholder="https://…" value="' + esc(s.ytInstance) + '"></label>' +
      '</div><div class="sh-h"><h3>Ваше устройство</h3></div><div class="rows">' + capsRows() +
      '</div><div class="sh-h"><h3>Каталог</h3></div><div class="rows">' +
      '<label class="row col"><span class="rt"><b>Адрес каталога</b><small>Пусто — с сервера, откуда открыто приложение</small></span>' +
      '<input data-set="catalogUrl" type="url" placeholder="https://…/catalog.json" value="' + esc(s.catalogUrl) + '"></label>' +
      row('updateCatalog', '', '🔄', 'Обновить каталог сейчас', '', '') +
      '</div><div class="sh-h"><h3>Данные</h3></div><div class="rows">' +
      row('go', 'more/backup', '🔄', 'Перенести избранное на другое устройство', 'Код или файл — без регистрации', '›') +
      row('clearHistory', '', '🕘', 'Очистить историю просмотра', '', '') +
      row('resetHealth', '', '🩺', 'Сбросить отметки «не работает»', '', '') +
      row('resetAll', '', '⚠️', 'Сбросить всё', 'Избранное, настройки, ссылки', '') +
      '</div>';
    return { title: '⚙️ Настройки', html: h };
  };
  function ytModeName() {
    var m = TV.yt.mode();
    return m === 'official' ? 'официальный плеер YouTube' + (TV.yt.hasKey() ? ' + поиск по ключу' : ' (без ключа — подборки официальных каналов)')
      : m === 'mirror' ? 'своё зеркало' : 'не поддерживается этим устройством';
  }
  /* Что умеет это устройство (TV.caps) */
  function capsRows() {
    var c = TV.caps, y = function (b) { return b ? '✅' : '—'; };
    var line = function (t, v) { return '<div class="row static"><span class="rt"><b>' + esc(t) + '</b></span><span class="rr">' + v + '</span></div>'; };
    return line('Система', esc(TV.device.label)) + line('Режим', TV.lite() ? 'лёгкий (старое устройство)' : 'полный') +
      line('Лучшее качество', c.maxH >= 2160 ? '4K' : c.maxH + 'p') + line('H.264 (почти всё видео)', y(c.h264)) +
      line('HEVC / H.265', y(c.hevc)) + line('VP9', y(c.vp9)) + line('AV1', y(c.av1)) + line('Трансляции HLS', y(c.hls)) +
      line('Файлы WebM / MKV', y(c.webm) + ' / ' + y(c.mkv)) + line('Официальный плеер YouTube', y(TV.yt.embedOk()));
  }
  /* Как получить ключ YouTube API (0.3.0) */
  S.ytkey = function () {
    return { title: '🔑 Ключ YouTube API', html: '<div class="help">' +
      '<p>Ключ даёт приложению официальный доступ к поиску и подборкам YouTube. Бесплатно: до ~100 поисков в день ' +
      '(подборки кэшируются на 6 часов и почти не расходуют лимит). Ключ хранится только на этом устройстве.</p>' +
      '<h3>Как получить (5 минут, один раз)</h3><ol>' +
      '<li>На компьютере откройте <b>console.cloud.google.com</b> и войдите аккаунтом Google.</li>' +
      '<li>Создайте проект (любое название, например BridgeTV).</li>' +
      '<li>«API и сервисы» → «Библиотека» → найдите <b>YouTube Data API v3</b> → «Включить».</li>' +
      '<li>«API и сервисы» → «Учётные данные» → «Создать учётные данные» → «Ключ API». Скопируйте ключ (начинается с AIza).</li>' +
      '<li>Для безопасности: в настройках ключа «Ограничения API» → только YouTube Data API v3.</li>' +
      '<li>Вставьте ключ: Ещё → Настройки → «Ключ YouTube API».</li></ol>' +
      '<p class="note">Без ключа работают подборки официальных каналов (новинки, мультфильмы, аниме) в приложении и поиск на сайте YouTube.</p>' +
      '<p class="note">Используя ключ, вы принимаете <button class="link" data-a="ext" data-x="https://www.youtube.com/t/terms">Условия YouTube</button>; ' +
      'данные обрабатываются по <button class="link" data-a="ext" data-x="https://policies.google.com/privacy">Политике конфиденциальности Google</button>. ' +
      'Политика BridgeTV — <button class="link" data-a="ext" data-x="https://github.com/kyranashi/bridgetv/blob/main/docs/PRIVACY.md">docs/PRIVACY.md</button>.</p>' +
      '<button class="btn primary" data-a="go" data-x="more/settings">Открыть настройки</button></div>' };
  };

  S.help = function () {
    var h = '<div class="help">' +
      '<h3>Каналы долго грузятся или не открываются</h3><ul>' +
      '<li>Приложение само пробует резервные источники и запоминает, какие работают. Нерабочие уходят в «Ещё → Не работают».</li>' +
      '<li>Список каналов проверяется и обновляется: «Ещё → Обновить список каналов».</li>' +
      '<li>Некоторые каналы показывают только в своей стране (гео-блок).</li></ul>' +
      '<h3>Старый iPad / iPhone (iOS 9–10)</h3>' +
      '<p>Старые iOS не знают современные сертификаты Let\'s Encrypt, поэтому многие сайты и трансляции (и зеркала YouTube) на них не открываются. ' +
      'Один раз установите профиль с корневыми сертификатами — он ничего не отслеживает и удаляется в Настройках iPad.</p>' +
      '<a class="btn primary" href="certs/BridgeTV-roots.mobileconfig">Установить сертификаты</a>' +
      '<p class="note">Откройте эту страницу в Safari → «Установить» → Настройки → Основные → Профили. ' +
      'Если профиль не ставится, откройте по очереди: <a href="certs/isrgrootx1.der">X1</a> · <a href="certs/root-yr.der">YR</a> · ' +
      '<a href="certs/isrg-root-x2.der">X2</a> · <a href="certs/root-ye.der">YE</a> · <a href="certs/sectigo-r46.der">Sectigo R46</a></p>' +
      '<h3>Управление</h3><ul>' +
      '<li>Плеер: свайп ◀ ▶ — канал, вниз — закрыть, касание — показать кнопки, ☰ — список каналов, ⇄ — другой источник.</li>' +
      '<li>Долгое нажатие на канал — в избранное.</li>' +
      '<li>Пульт / клавиатура: стрелки и OK, ▲▼ и CH± — каналы, цифры — номер канала, Назад — выход.</li></ul>' +
      '<h3>Без компьютера</h3><p>Приложению нужен только Wi‑Fi: интерфейс и список каналов встроены, обновления каталога, ' +
      'видео и фильмы загружаются из интернета. Компьютер нужен лишь для необязательного раздела «Фильмы с компьютера».</p>' +
      '<h3>Правовая информация</h3><ul>' +
      '<li>Приложение не хранит и не транслирует видео: оно открывает ссылки на бесплатные трансляции из открытых каталогов iptv-org и Free-TV. ' +
      'Платные каналы исключены. Правообладатель может попросить убрать ссылку через GitHub (Issues) — она будет удалена.</li>' +
      '<li>Вкладка «Видео» показывает ролики в официальном плеере YouTube, подборки — с официальных каналов правообладателей, поиск — через официальный API с вашим ключом. ' +
      'На старых устройствах можно указать своё зеркало — это ваш выбор. Приложение не связано с YouTube и Google. Вкладку можно выключить в Настройках.</li>' +
      '<li>Новинки — трейлеры и премьеры с каналов прокатчиков и студий; классика — с официальных каналов киностудий; «Архив кино» — фильмы в общественном достоянии. Пиратские каналы не подключаются.</li>' +
      '<li>Безопасный режим (включён) скрывает источники организаций, признанных в РФ нежелательными или в РБ экстремистскими: ' +
      'там ответственность возможна даже для зрителей и подписчиков.</li>' +
      '<li>Приложение не собирает данные и не требует входа. YouTube и сайты трансляций видят ваш IP-адрес, как в обычном браузере. Ключ YouTube API хранится только на устройстве.</li></ul>' +
      '<h3>На iPad как приложение</h3><p>Safari → «Поделиться» → «На экран Домой». Откроется на весь экран, как обычное приложение.</p>' +
      '<h3>О программе</h3><p>' + esc(TV.APP_NAME) + ' ' + TV.VERSION + ' — открытый код. Каналы — открытые каталоги iptv-org и Free-TV (только бесплатные каналы), иконки каналов — для узнавания, ' +
      'YouTube — официальный плеер и API, фильмы — официальные каналы и archive.org (общественное достояние). ' +
      'Политика конфиденциальности и аудит — в папке docs проекта на GitHub.</p></div>';
    return { title: '❓ Помощь', html: h };
  };

  /* ================================================================ навигация */
  function top() { var s = stacks[tab]; return s[s.length - 1]; }

  function render(keepScroll) {
    var t = top(), fn = S[t.s] || S.tv;
    var y = window.pageYOffset;
    var r = fn(t);
    var depth = stacks[tab].length;
    head.innerHTML = (depth > 1 ? '<button class="hbtn back" data-a="back" aria-label="Назад">‹</button>' : '') +
      '<h1>' + esc(r.title) + '</h1><div class="hright">' + (r.right || '') + '</div>';
    main.innerHTML = r.html;
    if (!keepScroll) { main.className = ''; void main.offsetWidth; main.className = 'anim'; }   // плавное появление (CSS, не в лёгком режиме)
    var tb = TV.$$('#tabbar button');
    for (var i = 0; i < tb.length; i++) tb[i].className = tb[i].getAttribute('data-x') === tab ? 'on' : '';
    window.scrollTo(0, keepScroll ? y : (t.y || 0));
    if (r.after) r.after();
    if (tab === 'search' && !ui.res && !keepScroll && !TV.device.touch) { var q = document.getElementById('q'); if (q) q.focus(); }
  }
  A.render = render;

  function push(s) { top().y = window.pageYOffset; stacks[tab].push(s); render(); }
  A.go = function (path) {
    // "вкладка/экран:параметр", напр. "more/region:ua"
    var parts = path.split('/'), t = parts[0], scr = parts[1];
    if (t !== tab) switchTab(t, !!scr);
    if (scr) {
      var p = scr.split(':'), s = { s: p[0] };
      if (p[0] === 'region') s.id = p[1];  // напр. «movies/downloads» — экран загрузок
      push(s);
    }
  };
  function switchTab(t, quiet) {
    if (stacks[tab].length) top().y = window.pageYOffset;
    if (t === tab && stacks[t].length > 1) stacks[t] = [stacks[t][0]];  // повторное нажатие — в корень
    tab = t;
    if (!quiet) render();
  }
  A.back = function () {
    if (TV.player.isOpen()) { TV.player.close(); return true; }
    if (stacks[tab].length > 1) { stacks[tab].pop(); render(); return true; }
    if (tab === 'search' && ui.res) { ui.res = null; ui.q = ''; render(); return true; }
    if (tab === 'yt' && (yv.q || yv.type !== 'video')) { yv = { q: '', type: 'video', dur: '', sort: '', page: 1, res: null }; render(); return true; }
    if (tab === 'movies' && fmActive()) { fm = { q: '', genre: 'all', years: 'all', origin: 'all', res: null }; render(); return true; }
    if (tab !== 'tv') { switchTab('tv'); return true; }
    return false;
  };

  /* Набор номера на главном экране: открыть канал по номеру */
  var dBuf = '', dT = null;
  A.digit = function (d) {
    if (tab !== 'tv' || stacks.tv.length > 1) return;
    dBuf = (dBuf + d).slice(-3);
    TV.toast('Канал ' + dBuf);
    clearTimeout(dT);
    dT = setTimeout(function () {
      var num = parseInt(dBuf, 10); dBuf = '';
      var l = lists['tv-' + TV.settings.region] || [];
      var i = TV.indexOf(l, function (c) { return c.num === num; });
      if (i >= 0) TV.player.open(l, i); else TV.toast('Нет канала ' + num);
    }, 1300);
  };

  /* ================================================================ действия */
  function act(a, x, el) {
    var c = a.split(':');
    switch (c[0]) {
      case 'tab': switchTab(x); break;
      case 'back': A.back(); break;
      case 'go': A.go(x); break;
      case 'play': {
        var l = el.getAttribute('data-l'), i = parseInt(el.getAttribute('data-i'), 10);
        // из «Продолжить» — переключать ◀ ▶ по всему списку региона, а не только по недавним
        if (l === 'hist' && lists[l] && lists[l][i]) {
          var hc0 = lists[l][i], full = lists['tv-' + TV.settings.region] || TV.catalog.list({ region: hc0.r, onlyWorking: TV.settings.onlyWorking });
          var fi = TV.indexOf(full, function (c) { return c.id === hc0.id; });
          if (fi >= 0) { TV.player.open(full, fi); break; }
        }
        if (lists[l]) TV.player.open(lists[l], i);
        break;
      }
      case 'playch': {
        var ch = TV.catalog.byId(x);
        if (ch) TV.player.open([ch], 0);
        break;
      }
      case 'region': TV.settings.region = x; TV.saveSettings(); render(); break;
      case 'cat': ui.cat[c[1]] = x; render(true); break;
      case 'onlyWorking': TV.settings.onlyWorking = !TV.settings.onlyWorking; TV.saveSettings(); render(true); break;
      case 'morelist': ui.limit[x] = (ui.limit[x] || pageSize()) + pageSize(); render(true); break;
      case 'moresec': ui.limit[x] = (ui.limit[x] || (TV.lite() ? 24 : 60)) + 1000; render(true); break;
      case 'q': { ui.q = x; runSearch(x); if (tab !== 'search') switchTab('search'); break; }
      case 'stab': if (tab !== 'search') switchTab('search', true); ui.sTab = x; render(); break;
      case 'clearSearches': TV.searches.clear(); render(true); break;
      case 'ytshelf': push({ s: 'ytlist', id: x }); break;
      case 'yvtype': yv.type = x; yv.res = null; yv.page = 1; render(); break;
      case 'yvdur': yv.dur = x; yv.res = null; yv.page = 1; render(); break;
      case 'yvsort': yv.sort = x; yv.res = null; yv.page = 1; render(); break;
      case 'yvmore': yv.page++; runYv(true); TV.toast('Загружаю ещё…'); break;
      case 'fmgenre': fm.genre = x; fm.res = null; render(); break;
      case 'fmyears': fm.years = x; fm.res = null; render(); break;
      case 'fmorigin': fm.origin = x; fm.res = null; render(); break;
      case 'google': TV.films.google(fm.q); break;
      case 'scrollto': { var t2 = document.getElementById(x); if (t2 && t2.scrollIntoView) t2.scrollIntoView(true); window.scrollBy(0, -60); break; }
      case 'dlplay': { var d = TV.dl.get(x); if (d && d.done) TV.player.open([TV.dl.item(d)], 0); break; }
      case 'dldel': if (confirm('Удалить загрузку?')) { TV.dl.remove(x); render(true); } break;
      case 'archshelf': push({ s: 'archlist', id: x }); break;
      case 'ytch': {
        var it = lists[el.getAttribute('data-l')][parseInt(el.getAttribute('data-i'), 10)];
        if (tab !== 'yt' && tab !== 'search' && tab !== 'fav') switchTab('yt', true);
        push({ s: 'ytch', id: it.id, n: it.n, img: it.img });
        break;
      }
      case 'subscribe': {
        var t = top();
        TV.toast(TV.subs.toggle({ id: t.id, n: t.n, img: t.img }) ? 'Вы подписались' : 'Подписка отменена');
        render(true);
        break;
      }
      case 'favtab': ui.favTab = x; render(); break;
      case 'favedit': ui.favEdit = !ui.favEdit; render(true); break;
      case 'favup': TV.fav.move({ k: 'ch', id: x }, -1); render(true); break;
      case 'favdown': TV.fav.move({ k: 'ch', id: x }, 1); render(true); break;
      case 'favdel': TV.fav.toggle({ k: 'ch', id: x }); render(true); break;
      case 'dellink': TV.links.remove(x); render(true); break;
      case 'delpl': if (confirm('Удалить плейлист?')) { TV.playlists.remove(x); render(true); } break;
      case 'pcdir': push({ s: 'pc', url: x }); break;
      case 'set':
        if (x === 'kids' && !TV.settings.kids && !/^\d{4}$/.test(TV.settings.pin || '')) { TV.toast('Сначала задайте PIN (4 цифры)'); break; }
        TV.settings[x] = !TV.settings[x]; TV.saveSettings();
        if (x === 'showYT' || x === 'safe' || x === 'kids') { cache = {}; ui.res = null; fm.res = null; yv.res = null; buildTabs(); }
        if (x === 'kids') { pinOk = !TV.settings.kids; TV.toast(TV.settings.kids ? '🧸 Детский режим включён' : 'Детский режим выключен'); }
        if (x === 'epg' && TV.settings.epg) TV.epg.load();
        render(true); break;
      case 'kidsExit': push({ s: 'pin' }); break;
      case 'voice': startVoice(); break;
      case 'backupCopy': {
        var ta = document.getElementById('bk-out');
        if (ta) { ta.focus(); ta.select(); try { document.execCommand('copy'); TV.toast('Скопировано'); } catch (e2) { TV.toast('Выделено — скопируйте вручную'); } }
        break;
      }
      case 'backupFile': saveBackupFile(); break;
      case 'backupLoad': {
        var inp = document.getElementById('bk-in'), r = importBackup(inp ? inp.value : '');
        TV.toast(r ? 'Перенесено: ' + r : 'Код не подошёл — скопируйте его целиком');
        if (r) { cache = {}; buildTabs(); setTimeout(function () { location.reload(); }, 900); }
        break;
      }
      case 'updateCatalog': updateCatalog(); break;
      case 'install': TV.openExternal(TV.PAGES + '/web/install.html'); break;
      case 'ext': if (/^https:\/\//.test(x)) TV.openExternal(x); break;
      case 'scan':
        if (TV.scan.start(null, function (p) { TV.toast('Готово: работает ' + p.ok + ' из ' + p.total); })) render(true);
        break;
      case 'clearHistory': TV.history.clear(); TV.toast('История очищена'); break;
      case 'resetHealth': TV.health.reset(); TV.toast('Отметки сброшены'); render(true); break;
      case 'resetAll':
        if (confirm('Сбросить избранное, настройки, ссылки и историю?')) {
          TV.each(TV.store.keys(), function (k) { TV.store.del(k); });
          setTimeout(function () { location.reload(); }, 300);   // дать мосту записать удаление
        }
        break;
    }
  }

  /* Откуда брать свежий каталог: своя ссылка → сервер, с которого открыто приложение →
     репозиторий GitHub (через CDN jsDelivr и напрямую). Пробуем по очереди. */
  function catalogSources() {
    if (TV.settings.catalogUrl) return [TV.settings.catalogUrl];
    var s = [];
    if (/^https?:/.test(location.protocol)) s.push('../data/catalog.json');
    if (TV.REPO) {
      s.push('https://cdn.jsdelivr.net/gh/' + TV.REPO + '@main/data/catalog.json');
      s.push('https://raw.githubusercontent.com/' + TV.REPO + '/main/data/catalog.json');
    }
    return s;
  }
  /* quiet — фоновое автообновление: без сообщений, и только если каталог действительно новее */
  function updateCatalog(quiet, done) {
    var src = catalogSources(), i = 0, before = TV.catalog.get().version || '';
    if (!src.length) { if (!quiet) TV.toast('Укажите адрес каталога в Настройках'); return; }
    if (!quiet) TV.toast('Обновляю каталог…');
    TV.store.set('catUpdT', TV.now());
    (function next(lastErr) {
      if (i >= src.length) { if (!quiet) TV.toast('Не удалось: ' + lastErr); if (done) done(false); return; }
      var url = src[i++];
      TV.catalog.update(url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + TV.now(), function (err, j) {
        if (err) return next(err);
        if (!quiet) TV.toast('Каталог обновлён: ' + j.channels.length + ' каналов');
        else if ((j.version || '') > before) TV.toast('Список каналов обновлён');
        render(true);
        if (done) done(true);
      });
    })('');
  }
  /* Раз в 2 дня приложение само скачивает свежий каталог (он обновляется на GitHub автоматически),
     затем проверяет каналы на устройстве (scan.js). */
  function autoUpdate() {
    var due = TV.now() - TV.store.get('catUpdT', 0) > 2 * 864e5;
    if (due && catalogSources().length) setTimeout(function () { updateCatalog(true, function () { TV.scan.auto(); }); }, 5000);
    else TV.scan.auto();
  }

  function onSubmit(e) {
    var f = TV.closest(e.target, 'data-form');
    if (!f) return;
    e.preventDefault();
    var kind = f.getAttribute('data-form'), u = f.u ? f.u.value.replace(/^\s+|\s+$/g, '') : '', n = f.n ? f.n.value : '';
    if (kind === 'pin') {
      if (f.u.value === TV.settings.pin) {
        pinOk = true;
        if (top().s === 'pin') stacks[tab].pop();
        if (TV.settings.kids && tab === 'tv') { TV.settings.kids = false; TV.saveSettings(); cache = {}; ui.res = null; buildTabs(); TV.toast('Детский режим выключен'); }
        render();
      } else { f.u.value = ''; TV.toast('Неверный PIN'); }
      return;
    }
    if (kind === 'search') { var q = f.q.value; if (document.activeElement) document.activeElement.blur(); runSearch(q); return; }
    if (kind === 'ytsearch' || kind === 'fmsearch') {
      if (document.activeElement) document.activeElement.blur();
      var qq = String(f.q.value || '').replace(/^\s+|\s+$/g, '');
      if (qq) TV.searches.add(qq);
      if (kind === 'ytsearch') { yv.q = qq; yv.res = null; yv.page = 1; } else { fm.q = qq; fm.res = null; }
      render(); return;
    }
    if (!/^https?:\/\//i.test(u)) { TV.toast('Нужна ссылка, начинающаяся с http:// или https://'); return; }
    if (kind === 'addlink') { TV.links.add(n, u); TV.toast('Ссылка добавлена'); render(true); }
    else if (kind === 'addpl') {
      TV.toast('Загружаю плейлист…');
      TV.playlists.add(n, u, function (err, cnt) { TV.toast(err ? 'Ошибка: ' + err : 'Добавлено ссылок: ' + cnt); render(true); });
    } else if (kind === 'pc') { TV.store.set('pcUrl', u); push({ s: 'pc', url: /\/$/.test(u) ? u : u + '/' }); }
  }

  /* Долгое нажатие на карточку канала — в избранное */
  function longPress(el) {
    var l = el.getAttribute('data-l'), i = parseInt(el.getAttribute('data-i'), 10), it = lists[l] && lists[l][i];
    if (!it) return;
    var f = it.v ? { k: 'ch', id: it.id, n: it.n, img: it.l } : it;
    TV.toast(TV.fav.toggle(f) ? '★ ' + it.n + ' — в избранном' : it.n + ' — убрано из избранного');
    render(true);
  }

  /* Нижнее меню; вкладка «Видео» — только если включена в Настройках */
  function buildTabs() {
    var tb = '';
    TV.each(TABS, function (t) {
      if (t.id === 'yt' && !TV.settings.showYT) return;
      tb += '<button data-a="tab" data-x="' + t.id + '"><span>' + t.icon + '</span>' + t.name + '</button>';
    });
    document.getElementById('tabbar').innerHTML = tb;
    if (tab === 'yt' && !TV.settings.showYT) tab = 'tv';
  }

  /* ================================================================ запуск */
  A.start = function () {
    TV.applyMode();
    TV.catalog.load();
    var app = document.getElementById('app');
    head = document.getElementById('head');
    main = document.getElementById('main');
    buildTabs();

    var lpT = null, lpFired = false;
    document.addEventListener('click', function (e) {
      if (TV.player.isOpen() && TV.closest(e.target, 'id') && TV.closest(e.target, 'id').id === 'player') return;
      if (lpFired) { lpFired = false; e.preventDefault(); return; }
      var b = TV.closest(e.target, 'data-a');
      if (!b) return;
      if (b.tagName === 'A') return;
      e.preventDefault();
      act(b.getAttribute('data-a'), b.getAttribute('data-x'), b);
    }, false);
    app.addEventListener('submit', onSubmit, false);
    app.addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-set');
      if (!k) return;
      var v = e.target.value;
      if (k === 'pin' && v && !/^\d{4}$/.test(v)) { TV.toast('PIN — ровно 4 цифры'); return; }
      TV.settings[k] = k === 'timeout' ? parseInt(v, 10) : v;
      TV.saveSettings();
      if (k === 'ytInstance' || k === 'ytKey' || k === 'ytSource') { cache = {}; yv.res = null; }
      if (k === 'mode' || k === 'font') render(true);
      TV.toast('Сохранено');
    }, false);
    app.addEventListener('input', function (e) { if (e.target.id === 'q') suggest(e.target.value); }, false);
    app.addEventListener('touchstart', function (e) {
      var b = TV.closest(e.target, 'data-a');
      lpFired = false;
      if (!b || b.getAttribute('data-a') !== 'play') return;
      lpT = setTimeout(function () { lpFired = true; longPress(b); }, 600);
    }, false);
    var cancel = function () { clearTimeout(lpT); };
    app.addEventListener('touchmove', cancel, false);
    app.addEventListener('touchend', cancel, false);
    app.addEventListener('contextmenu', function (e) {
      var b = TV.closest(e.target, 'data-a');
      if (b && b.getAttribute('data-a') === 'play') { e.preventDefault(); longPress(b); }
    }, false);

    TV.on('playerClosed', function () { render(true); });
    // Программа передач пришла — обновить карточки каналов (без прокрутки)
    TV.on('epg', function () { if ((tab === 'tv' || top().s === 'region') && !(TV.player && TV.player.isOpen())) render(true); });
    // Голосовой поиск: распознанный текст — в поиск
    TV.on('voice', function (d) {
      if (!d || !d.text) { TV.toast(d && d.err ? 'Голосовой поиск: ' + d.err : 'Не расслышал'); return; }
      ui.q = String(d.text).slice(0, 200);
      if (tab !== 'search') switchTab('search', true);
      runSearch(ui.q);
    });
    setTimeout(function () { TV.epg.load(); }, TV.lite() ? 6000 : 2500);
    setInterval(function () { TV.epg.load(); }, 36e5);
    TV.on('fav', function () {});
    TV.on('dl', function () { if (top().s === 'downloads') render(true); });
    // Ход проверки каналов: обновляем только индикатор, а по окончании — весь экран
    TV.on('scan', function () {
      var bar = document.getElementById('scanbar');
      if (!TV.scan.running()) { if (tab === 'tv' || top().s === 'dead') render(true); return; }
      if (bar) bar.outerHTML = scanButton();
    });
    render();
    TV.yt.discover();
    autoUpdate();
  };
})();
