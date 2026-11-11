/*
 * BridgeTV — service worker веб-приложения (PWA, с 0.3.0).
 * Делает веб-версию устанавливаемым приложением (ПК, Android, iOS 16.4+, ТВ) и открывает
 * интерфейс без интернета. Видео, каналы и YouTube по-прежнему идут из сети.
 *   • файлы интерфейса — «сначала кэш, обновление в фоне»;
 *   • каталог каналов — «сначала сеть» (свежий список), без сети — из кэша;
 *   • чужие адреса (видео, API, картинки) не кэшируются и не трогаются.
 * Старые браузеры (iOS 9–11) service worker не знают — для них всё работает как обычный сайт.
 */
var CACHE = 'bridgetv-0.3.0';
var SHELL = ['index.html', 'install.html', 'yt.html', 'css/app.css', 'js/core.js', 'js/data.js', 'js/services.js', 'js/scan.js',
  'js/films.js', 'js/player.js', 'js/nav.js', 'js/app.js', 'vendor/hls.min.js', 'manifest.json',
  'img/icon-192.png', 'img/icon-512.png', 'img/icon-152.png', '../data/catalog.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches['delete'](k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;     // чужое — без вмешательства
  if (/\/data\/(catalog\.(js|json)|logos\/)/.test(url.pathname) && !/logos/.test(url.pathname)) {
    e.respondWith(fetch(req).then(function (r) {           // каталог: сначала сеть
      var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return r;
    })['catch'](function () { return caches.match(req); }));
    return;
  }
  e.respondWith(caches.match(req).then(function (hit) {     // интерфейс: кэш + обновление в фоне
    var net = fetch(req).then(function (r) {
      if (r.ok) { var copy = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return r;
    })['catch'](function () { return hit; });
    return hit || net;
  }));
});
