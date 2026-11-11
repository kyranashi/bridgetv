/*
 * BridgeTV — проверка каналов на самом устройстве (с версии 0.2.2).
 *
 * Зачем: доступность каналов зависит от страны и провайдера. Многие каналы РФ вещают только
 * внутри России, белорусские — только в Беларуси; проверка на компьютере (особенно через VPN)
 * этого не видит. Поэтому каталог проверяется ещё и с самого iPad — из той же сети, где смотрят.
 *
 * Как работает:
 *   - для каждого варианта (ссылки) канала скачивается плейлист .m3u8 (через нативный мост
 *     приложения: без CORS и с корнями Let's Encrypt для iOS 9);
 *   - ответ начинается с #EXTM3U — ссылка рабочая (TV.health.mark(url, true)), иначе — сбой;
 *   - у канала проверяются варианты по очереди до первого рабочего (остальные не трогаем —
 *     экономим время и трафик);
 *   - несколько запросов параллельно (3 в лёгком режиме, 6 в полном);
 *   - пока открыт плеер, проверка стоит на паузе, чтобы не отнимать канал у видео.
 *
 * В браузере (веб-версия) проверка недоступна: браузер не даёт читать чужие плейлисты (CORS).
 * Там остаётся проверка при просмотре (плеер сам запоминает рабочие ссылки).
 */
(function () {
  var S = TV.scan = {};
  var running = false, queue = [], active = 0, done = 0, total = 0, okCh = 0, onDone = null;
  var offline = false, waiting = false;
  var DAY = 864e5;

  S.available = function () { return TV.native; };
  S.running = function () { return running; };
  S.progress = function () { return { done: done, total: total, ok: okCh }; };
  S.lastTime = function () { return TV.store.get('scanT', 0); };

  /* Проверить одну ссылку: cb(true|false) */
  /* cb(true | false | null). null — проверить нельзя (нет интернета): ничего не помечаем */
  function probe(url, cb) {
    if (navigator.onLine === false) { cb(null); return; }
    TV.ajax(url, { text: true, timeout: TV.lite() ? 9000 : 7000 }, function (err, text) {
      if (err === 'нет интернета') { cb(null); return; }
      var ok = !err && /^\s*(﻿)?#EXTM3U/.test(String(text || ''));
      // Заглушки «вещание недоступно в вашем регионе» обычно — короткий плейлист без потоков
      if (ok && !/#EXT-X-STREAM-INF|#EXTINF/.test(text)) ok = false;
      cb(ok);
    });
  }

  /* Канал: варианты по порядку, до первого рабочего */
  function checkChannel(c, cb) {
    var vs = TV.health.variants(c), i = 0;
    (function next() {
      if (i >= vs.length) { cb(false); return; }
      var v = vs[i++];
      probe(v.u, function (ok) {
        if (ok === null) { offline = true; cb(null); return; }   // связь пропала — стоп
        TV.health.mark(v.u, ok);
        if (ok) cb(true); else next();
      });
    })();
  }

  function pump() {
    var par = TV.lite() ? 3 : 6;
    if (!running) return;
    if (offline) {                       // нет интернета: прервать, отметки не трогать
      queue = [];
      if (active === 0) { running = false; TV.emit('scan', S.progress()); TV.toast('Проверка прервана: нет интернета'); }
      return;
    }
    if (TV.player && TV.player.isOpen()) {   // пауза во время просмотра (одна цепочка ожидания)
      if (!waiting) { waiting = true; setTimeout(function () { waiting = false; pump(); }, 3000); }
      return;
    }
    while (active < par && queue.length) {
      var c = queue.shift();
      active++;
      checkChannel(c, function (ok) {
        active--; done++;
        if (ok) okCh++;
        if (done % 10 === 0 || done === total) TV.emit('scan', S.progress());
        if (done === total && !offline) finish(); else pump();
      });
    }
  }

  function finish() {
    running = false;
    TV.store.set('scanT', TV.now());
    TV.emit('scan', S.progress());
    TV.emit('health');
    if (onDone) onDone(S.progress());
  }

  /* Запустить проверку списка каналов (по умолчанию — основные регионы: РФ и РБ) */
  S.start = function (channels, cb) {
    if (!S.available() || running) return false;
    queue = (channels || TV.filter(TV.catalog.get().channels, function (c) {
      return TV.catalog.isPrimaryRegion(c.r) && !TV.blocked(c);
    })).slice(0);
    // Сначала «кнопочные» каналы (с меньшими номерами) — они нужнее всего
    queue.sort(function (a, b) { return (a.num || 999) - (b.num || 999); });
    total = queue.length; done = 0; okCh = 0; active = 0; onDone = cb || null; offline = false;
    if (!total) return false;
    running = true;
    TV.emit('scan', S.progress());
    pump();
    return true;
  };
  S.stop = function () { queue = []; if (running && active === 0) { running = false; TV.emit('scan', S.progress()); } };

  /* Автоматически: раз в сутки и после обновления каталога, через 20 с после запуска */
  S.auto = function () {
    if (!S.available()) return;
    var cat = TV.catalog.get();
    var ver = cat.built || cat.version;      // метка сборки каталога: новый каталог — новая проверка
    var stale = TV.now() - S.lastTime() > DAY || TV.store.get('scanVer', '') !== ver;
    if (!stale) return;
    setTimeout(function () {
      S.start(null, function (p) {
        TV.store.set('scanVer', ver);
        TV.toast('Каналы проверены: работает ' + p.ok + ' из ' + p.total);
      });
    }, 20000);
  };
})();
