/*
 * BridgeTV — ядро веб-версии: пространство имён, утилиты, хранилище, настройки, профиль устройства.
 *
 * ВАЖНО: весь веб-код пишется на ES5 (без let/const, стрелок, шаблонных строк,
 * Promise/fetch, Array.find/includes, Element.closest), чтобы работать в
 * Safari iOS 9, Android 4.4 WebView и браузерах старых Smart TV.
 */
var TV = window.TV || {};
window.TV = TV;

TV.APP_NAME = 'BridgeTV';    // название; в коде объект по-прежнему называется TV
TV.VERSION = '1.0.0';
/* Репозиторий на GitHub (владелец/имя) — отсюда приложения скачивают свежий каталог.
   Заполнить после публикации, напр. 'ivanov/tv'. Пусто — обновление только с локального сервера. */
TV.REPO = 'kyranashi/bridgetv';
/* Сайт проекта (GitHub Pages): страница встроенного плеера YouTube и веб-версия */
TV.PAGES = 'https://kyranashi.github.io/bridgetv';

/* Нативная оболочка (iOS-приложение) сообщает о себе через window.TV_NATIVE */
/* Android-оболочка (android/, с 0.2.5): мост window.TVAndroid — данные о приложении и сохранённое
   отдаются синхронно (на Android нельзя внедрить скрипт до загрузки страницы так же, как на iOS) */
/* Программа для ПК (desktop/, с 0.3.0): такой же синхронный мост window.TVBridge */
TV._bridge = window.TVAndroid || window.TVBridge || null;
if (TV._bridge && !window.TV_NATIVE) {
  try { window.TV_NATIVE = JSON.parse(TV._bridge.info()); } catch (e) { window.TV_NATIVE = { platform: window.TVBridge ? 'desktop' : 'android' }; }
  try { window.TV_SAVED = JSON.parse(TV._bridge.saved() || '{}'); } catch (e) { window.TV_SAVED = {}; }
}
TV.platform = window.TV_NATIVE ? window.TV_NATIVE.platform : 'web';    // ios | android | desktop | web
TV.native = !!(window.TV_NATIVE && ((window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tv) || TV._bridge));
TV.callNative = function (msg) {
  if (!TV.native) return false;
  try {
    if (TV._bridge) TV._bridge.postMessage(JSON.stringify(msg));
    else window.webkit.messageHandlers.tv.postMessage(msg);
    return true;
  } catch (e) { return false; }
};
TV._ncb = {}; TV._nid = 0;
TV.nativeCb = function (id, err, text, status) {
  var cb = TV._ncb[id]; delete TV._ncb[id];
  if (cb) cb(err, text, status);
};
/* Не гасить экран во время просмотра (в браузере — не поддерживается, игнорируется) */
TV.awake = function (on) { TV.callNative({ cmd: 'awake', on: !!on }); };
/* Открыть ссылку во внешнем браузере / приложении */
TV.openExternal = function (url) { if (!TV.callNative({ cmd: 'open', url: url })) window.open(url, '_blank'); };

/* ------------------------------------------------------------------ утилиты */
TV.$ = function (sel, root) { return (root || document).querySelector(sel); };
TV.$$ = function (sel, root) { return (root || document).querySelectorAll(sel); };

TV.esc = function (s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};

/* Аналог Element.closest (нет в Safari 9) */
TV.closest = function (el, attr) {
  while (el && el.nodeType === 1) {
    if (el.hasAttribute(attr)) return el;
    el = el.parentNode;
  }
  return null;
};

TV.each = function (arr, fn) { for (var i = 0; i < arr.length; i++) fn(arr[i], i); };
TV.isArray = function (a) { return Object.prototype.toString.call(a) === '[object Array]'; };
TV.filter = function (arr, fn) { var r = []; for (var i = 0; i < arr.length; i++) if (fn(arr[i], i)) r.push(arr[i]); return r; };
TV.find = function (arr, fn) { for (var i = 0; i < arr.length; i++) if (fn(arr[i], i)) return arr[i]; return null; };
TV.indexOf = function (arr, fn) { for (var i = 0; i < arr.length; i++) if (fn(arr[i], i)) return i; return -1; };
TV.extend = function (a, b) { for (var k in b) if (b.hasOwnProperty(k)) a[k] = b[k]; return a; };
TV.now = function () { return new Date().getTime(); };

TV.fmtTime = function (sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  var h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  var mm = (h && m < 10 ? '0' : '') + m, ss = (s < 10 ? '0' : '') + s;
  return (h ? h + ':' : '') + mm + ':' + ss;
};
TV.fmtViews = function (n) {
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + ' млн просм.';
  if (n >= 1e3) return Math.round(n / 1e3) + ' тыс. просм.';
  return n + ' просм.';
};

/* Нормализация для поиска: регистр, ё→е, латиница↔кириллица */
var TR = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh', 'з': 'z', 'и': 'i',
  'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu',
  'я': 'ya', 'і': 'i', 'ў': 'u', 'ї': 'i', 'є': 'e' };
TV.norm = function (s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-яіўїє]+/g, ' ').replace(/^\s+|\s+$/g, '');
};
TV.translit = function (s) {
  var out = '', t = TV.norm(s);
  for (var i = 0; i < t.length; i++) { var c = t.charAt(i); out += TR.hasOwnProperty(c) ? TR[c] : c; }
  return out.replace(/kh/g, 'h').replace(/iy|yy/g, 'y');
};
/* «Латинский ключ» для поиска: разные латинские написания одного слова сводятся к одному
   (pervyi / pervij / perviy / pervyy -> pervy; khabar / habar; tv / тв) */
TV.latinKey = function (s) {
  return TV.translit(s).replace(/kh/g, 'h').replace(/[iyj]+/g, 'y').replace(/w/g, 'v').replace(/ph/g, 'f').replace(/ck/g, 'k');
};

/* ------------------------------------------------------------------ сеть */
/* XHR вместо fetch: работает в iOS 6+ и Android 4. cb(err, data) */
TV.ajax = function (url, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  // В нативном приложении — запрос через NSURLSession: без CORS и с корнями Let's Encrypt для iOS 9
  if (TV.native) {
    var id = 'n' + (++TV._nid);
    TV._ncb[id] = function (err, text) {
      if (err) return cb(err);
      if (opts.text) return cb(null, text);
      var j;
      try { j = JSON.parse(text); } catch (e) { return cb('ответ не JSON'); }
      cb(null, j);
    };
    TV.callNative({ cmd: 'fetch', id: id, url: url, timeout: opts.timeout || 15000, method: opts.method || 'GET', body: opts.body || null });
    return null;
  }
  var x = new XMLHttpRequest(), done = false;
  var finish = function (err, data) { if (done) return; done = true; clearTimeout(timer); cb(err, data, x); };
  var timer = setTimeout(function () { try { x.abort(); } catch (e) {} finish('таймаут'); }, opts.timeout || 15000);
  try {
    x.open(opts.method || 'GET', url, true);
  } catch (e) { finish('адрес'); return x; }
  x.onreadystatechange = function () {
    if (x.readyState !== 4) return;
    if (x.status >= 200 && x.status < 300) {
      if (opts.text) return finish(null, x.responseText);
      var j;
      try { j = JSON.parse(x.responseText); } catch (e) { return finish('ответ не JSON'); }
      finish(null, j);
    } else finish(x.status ? 'HTTP ' + x.status : 'нет связи');
  };
  x.send(opts.body || null);
  return x;
};

/* ------------------------------------------------------------------ хранилище */
/* В браузере — localStorage (может бросать исключения: приватный режим Safari, переполнение).
   В iOS-приложении — файлы приложения через мост: localStorage у страниц из file:// в WKWebView
   на iOS 9 ненадёжен (данные могли пропадать после перезапуска). Сохранённое приложение
   передаёт при старте в window.TV_SAVED = {ключ: 'JSON-строка'}. */
TV._mem = TV.native ? (window.TV_SAVED || {}) : null;
TV.store = {
  get: function (k, def) {
    try {
      var v = TV._mem ? TV._mem[k] : window.localStorage.getItem('tv.' + k);
      return v == null ? def : JSON.parse(v);
    } catch (e) { return def; }
  },
  set: function (k, v) {
    var s;
    try { s = JSON.stringify(v); } catch (e) { return false; }
    if (TV._mem) { TV._mem[k] = s; TV.callNative({ cmd: 'save', key: k, value: s }); return true; }
    try { window.localStorage.setItem('tv.' + k, s); return true; }
    catch (e) { return false; }
  },
  del: function (k) {
    if (TV._mem) { delete TV._mem[k]; TV.callNative({ cmd: 'save', key: k, value: null }); return; }
    try { window.localStorage.removeItem('tv.' + k); } catch (e) {}
  },
  keys: function () {
    var out = [];
    if (TV._mem) { for (var k in TV._mem) if (TV._mem.hasOwnProperty(k)) out.push(k); return out; }
    try { for (var i = 0; i < window.localStorage.length; i++) { var n = window.localStorage.key(i); if (n.indexOf('tv.') === 0) out.push(n.slice(3)); } } catch (e) {}
    return out;
  }
};

/* ------------------------------------------------------------------ безопасный режим */
/* Источники организаций, признанных в РФ «нежелательными» и/или в РБ «экстремистскими»:
   просмотр, подписка и распространение их материалов там могут повлечь ответственность.
   По умолчанию скрываются (Настройки → «Безопасный режим»). Список — docs/LEGAL.md. */
TV.BLOCKLIST = {
  channels: ['TVRain.nl', 'CurrentTimeTV.cz', 'Belsat.pl', 'BelsatTV.pl'],
  ytChannels: ['UCBG57608Hukev3d0d-gvLhQ', 'UCdubelOloxR3wzwJG9x8YqQ'],
  names: /настоящее время|current time|телеканал дождь|tv ?rain|белсат|belsat|радыё свабода|радио свобода|radio svaboda|radio liberty|nexta|некста/i
};
TV.blocked = function (it) {
  // Детский режим (родительский контроль, 1.0.0): из телеканалов — только детские
  if (TV.settings && TV.settings.kids && it && it.c && !it.k && it.c !== 'kids') return true;
  if (!TV.settings || !TV.settings.safe || !it) return false;
  var B = TV.BLOCKLIST;
  if (it.id && (B.channels.indexOf(it.id) >= 0 || B.ytChannels.indexOf(it.id) >= 0)) return true;
  if (it.ch && B.ytChannels.indexOf(it.ch) >= 0) return true;
  return B.names.test(String(it.n || '')) && it.k !== 'yt' || B.names.test(String(it.sub || ''));
};

/* ------------------------------------------------------------------ устройство */
TV.device = (function () {
  var ua = navigator.userAgent || '';
  var ios = /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  var iosVer = 0, m = ua.match(/OS (\d+)_/);
  if (ios && m) iosVer = parseInt(m[1], 10);
  var andVer = 0, a = ua.match(/Android (\d+)/);
  if (a) andVer = parseInt(a[1], 10);
  var tv = /SmartTV|SMART-TV|Tizen|Web0S|WebOS|NetCast|BRAVIA|AFT|Android TV|HbbTV|Viera|AppleTV|CrKey/i.test(ua);
  var v = document.createElement('video');
  var nativeHls = !!(v.canPlayType && (v.canPlayType('application/vnd.apple.mpegurl') || v.canPlayType('audio/mpegurl')));
  var mse = !!(window.MediaSource || window.WebKitMediaSource);
  var mem = navigator.deviceMemory || 0, cpu = navigator.hardwareConcurrency || 0;
  var old = (ios && iosVer && iosVer < 12) || (andVer && andVer < 7) || (mem && mem <= 1) || (cpu && cpu <= 2);
  if (window.TV_NATIVE && window.TV_NATIVE.platform === 'ios' && window.TV_NATIVE.os) { iosVer = parseInt(window.TV_NATIVE.os, 10) || iosVer; ios = true; }
  old = old || (ios && iosVer && iosVer < 12);
  return {
    ios: ios, iosVer: iosVer, android: andVer, tv: tv, nativeHls: nativeHls, mse: mse,
    touch: 'ontouchstart' in window, old: !!old,
    oldTls: ios && iosVer && iosVer < 11,   // iOS 9–10 не знают корни Let's Encrypt
    label: (window.TV_NATIVE ? 'приложение · ' : '') + (ios ? 'iOS ' + (iosVer || '?') : andVer ? 'Android ' + andVer : tv ? 'Smart TV' : 'Компьютер')
  };
})();

/* ------------------------------------------------------------------ что умеет устройство (0.3.0) */
/* Какие форматы и качество устройство может проиграть — по нему приложение выбирает качество,
   прячет/помечает файлы, которые не пойдут, и решает, как показывать YouTube. */
TV.caps = (function () {
  var v = document.createElement('video'), MS = window.MediaSource || window.WebKitMediaSource;
  var cp = function (t) { try { return !!(v.canPlayType && v.canPlayType(t)); } catch (e) { return false; } };
  var ms = function (t) { try { return !!(MS && MS.isTypeSupported && MS.isTypeSupported(t)); } catch (e) { return false; } };
  var any = function (t) { return cp(t) || ms(t); };
  var scr = Math.max(screen.width || 0, screen.height || 0) * (window.devicePixelRatio || 1);
  var c = {
    h264: any('video/mp4; codecs="avc1.42E01E"') || TV.device.ios,
    hevc: any('video/mp4; codecs="hvc1.1.6.L93.B0"') || any('video/mp4; codecs="hev1.1.6.L93.B0"'),
    vp9: any('video/webm; codecs="vp9"') || any('video/mp4; codecs="vp09.00.10.08"'),
    av1: any('video/mp4; codecs="av01.0.05M.08"'),
    webm: cp('video/webm'), mkv: cp('video/x-matroska') || cp('video/mkv'),
    hls: TV.device.nativeHls || TV.device.mse
  };
  // разумный максимум качества: экран и мощность (старые устройства — 720p, обычные — 1080p, 4K-экраны с HEVC/VP9 — 2160p)
  c.maxH = TV.device.old ? 720 : (scr >= 3000 && (c.hevc || c.vp9) ? 2160 : 1080);
  /* Сыграет ли файл по имени/типу: true | false */
  c.file = function (name) {
    var n = String(name || '').toLowerCase().split('?')[0];
    if (/\.(mp4|m4v|mov)$/.test(n)) return c.h264;
    if (/\.m3u8?$/.test(n)) return c.hls;
    if (/\.webm$/.test(n)) return c.webm;
    if (/\.mkv$/.test(n)) return c.mkv;
    if (/\.(avi|wmv|flv)$/.test(n)) return false;
    return true;
  };
  return c;
})();

/* ------------------------------------------------------------------ настройки */
TV.defaults = {
  mode: 'auto',          // auto | lite | full — «лёгкий режим» для старой техники
  onlyWorking: true,     // скрывать каналы, которые точно не работают
  logos: true,           // логотипы каналов
  timeout: 12,           // секунд ждать источник, потом пробовать резервный
  ytInstance: '',        // пусто = автовыбор
  catalogUrl: '',        // своя ссылка на catalog.json (обновление без переустановки)
  region: 'ru',          // выбранный регион на вкладке ТВ
  autoNext: true,        // при сбое сам переключать на резервный источник
  safe: true,            // безопасный режим: скрывать источники из TV.BLOCKLIST
  showYT: true,          // вкладка «Видео» (YouTube)
  ytSource: 'auto',     // видео YouTube: auto | official (плеер YouTube) | mirror (своё зеркало)
  ytKey: '',             // свой бесплатный ключ YouTube Data API v3 — поиск и подборки (docs/YOUTUBE.md)
  ytQuality: '720',      // качество видео YouTube: auto | 1080 | 720 | 480 | 360 (A5 уверенно тянет 720p)
  ytAudio: 'ru',         // озвучка: язык перевода, если есть (пусто — оригинал)
  ytSubs: '',            // субтитры: язык или пусто — выключены
  epg: true,             // программа передач (1.0.0)
  nextEp: true,          // в конце видео/серии — следующее через 5 с
  font: '100',           // размер текста: 100 | 115 | 130 (%)
  kids: false,           // детский режим (родительский контроль): только детское
  pin: ''                // PIN родительского контроля (4 цифры), хранится только на устройстве
};
TV.settings = TV.extend(TV.extend({}, TV.defaults), TV.store.get('settings', {}));
TV.saveSettings = function () { TV.store.set('settings', TV.settings); TV.applyMode(); };
TV.lite = function () { return TV.settings.mode === 'lite' || (TV.settings.mode === 'auto' && TV.device.old); };
TV.applyMode = function () {
  var c = document.documentElement.className.replace(/\s*(lite|tvmode|touch|font115|font130|kids)\b/g, '');
  if (TV.lite()) c += ' lite';
  if (TV.settings.font === '115' || TV.settings.font === '130') c += ' font' + TV.settings.font;
  if (TV.settings.kids) c += ' kids';
  if (TV.device.tv) c += ' tvmode';
  if (TV.device.touch) c += ' touch';
  document.documentElement.className = c;
};

/* ------------------------------------------------------------------ события */
TV.bus = { h: {} };
TV.on = function (ev, fn) { (TV.bus.h[ev] = TV.bus.h[ev] || []).push(fn); };
TV.emit = function (ev, a, b) { var l = TV.bus.h[ev] || []; for (var i = 0; i < l.length; i++) l[i](a, b); };

/* Короткое всплывающее сообщение */
TV.toast = function (msg) {
  var t = TV.$('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'show';
  clearTimeout(TV._toastT);
  TV._toastT = setTimeout(function () { t.className = ''; }, 2600);
};
