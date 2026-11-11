/*
 * BridgeTV — плеер (полноэкранный слой поверх приложения).
 *
 * Один плеер для всего: телеканалы (переключение ◀ ▶, номер с пульта, список
 * каналов сбоку), YouTube-видео и эфиры, фильмы (перемотка, «продолжить с…»).
 *
 * Как борется с «долго грузит / не работает»:
 *   1. Источники канала идут в порядке «недавно работал → по проверке каталога →
 *      недавно падал» (TV.health.variants).
 *   2. На каждый источник — таймаут (Настройки → 8–20 с). Не успел — следующий.
 *   3. Результат запоминается: рабочие поднимаются вверх, мёртвые уходят в «Не работают».
 *   4. hls.js в лёгком режиме стартует с самого лёгкого качества и ограничен 480p.
 *   5. http-ссылки на https-странице браузер блокирует — такие источники пропускаются
 *      сразу, без ожидания (в нативном приложении и при локальном запуске их нет).
 */
(function () {
  var P = TV.player = {};
  var scrollY0 = 0;
  var el, video, hls = null, state = null, hideT = null, srcT = null, posT = null, numBuf = '', numT = null, uiOn = true;

  function $(s) { return TV.$(s, el); }

  /* ------------------------------------------------------------ разметка */
  function build() {
    el = document.createElement('div');
    el.id = 'player';
    el.innerHTML =
      '<video id="pv" playsinline webkit-playsinline x-webkit-airplay="allow" preload="auto"></video>' +
      '<div class="p-status"><div class="spin"></div><div class="p-msg"></div><div class="p-actions"></div></div>' +
      '<div class="p-num"></div>' +
      '<div class="p-ui">' +
      '  <div class="p-top">' +
      '    <button class="pbtn" data-p="close" aria-label="Назад">✕</button>' +
      '    <div class="p-title"><b></b><span></span></div>' +
      '    <button class="pbtn" data-p="dl" aria-label="Скачать" title="Скачать на устройство">⬇</button>' +
      '    <button class="pbtn" data-p="opts" aria-label="Качество, озвучка, субтитры" title="Качество, озвучка, субтитры">⚙</button>' +
      '    <button class="pbtn" data-p="fav" aria-label="В избранное">☆</button>' +
      '    <button class="pbtn" data-p="list" aria-label="Список">☰</button>' +
      '  </div>' +
      '  <div class="p-bottom">' +
      '    <div class="p-seek"><span class="p-cur">0:00</span><input type="range" min="0" max="1000" value="0" class="p-range"><span class="p-dur">0:00</span></div>' +
      '    <div class="p-row">' +
      '      <button class="pbtn big" data-p="prev">◀</button>' +
      '      <button class="pbtn big" data-p="back10">−10</button>' +
      '      <button class="pbtn big" data-p="play">❚❚</button>' +
      '      <button class="pbtn big" data-p="fwd10">+10</button>' +
      '      <button class="pbtn big" data-p="next">▶</button>' +
      '      <button class="pbtn" data-p="src" title="Другой источник">⇄</button>' +
      '      <button class="pbtn" data-p="fs" title="Во весь экран">⛶</button>' +
      '    </div>' +
      '  </div>' +
      '</div>' +
      '<div class="p-side" data-panel="1"><div class="p-side-h"><span>Каналы</span><button class="pbtn" data-p="sideclose" aria-label="Закрыть список">✕</button></div><div class="p-side-list"></div></div>' +
      '<div class="p-opts" data-panel="1"></div>';
    document.body.appendChild(el);
    video = $('#pv');

    el.addEventListener('click', onClick, false);
    var range = $('.p-range');
    range.addEventListener('input', function () {
      if (video.duration && isFinite(video.duration)) video.currentTime = range.value / 1000 * video.duration;
      showUi();
    }, false);

    video.addEventListener('playing', onPlaying, false);
    video.addEventListener('loadedmetadata', function () { if (!hls) applyMediaTracks(); }, false);
    video.addEventListener('waiting', function () { if (state && state.started) busy(true, 'Буферизация…'); }, false);
    video.addEventListener('error', function () { fail('ошибка воспроизведения'); }, false);
    video.addEventListener('timeupdate', onTime, false);
    video.addEventListener('pause', function () { setPlayIcon(); }, false);
    video.addEventListener('play', function () { setPlayIcon(); }, false);
    video.addEventListener('ended', function () { if (state && !state.live) P.step(1); }, false);

    // Свайпы: ◀ ▶ — канал, вниз — закрыть
    var sx, sy, st;
    el.addEventListener('touchstart', function (e) { var t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = TV.now(); }, false);
    el.addEventListener('touchend', function (e) {
      if (!state || TV.now() - st > 600) return;
      var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (TV.closest(e.target, 'data-p') || TV.closest(e.target, 'data-side')) return;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) { P.step(dx < 0 ? 1 : -1); }
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) { P.close(); }
    }, false);
  }

  /* ------------------------------------------------------------ открытие */
  /* items — карточки или каналы каталога; index — с какого начать */
  P.open = function (items, index, opts) {
    if (!el) build();
    opts = opts || {};
    state = { items: items, index: index || 0, live: false, started: false, vi: 0, variants: [], url: '', opts: opts };
    el.className = 'open';
    // Страница под плеером скрывается (html.playing #app { display:none }): при повороте
    // устройства пересчитывается только видео, без сотен карточек — поворот без рывков.
    // Позиция прокрутки запоминается и возвращается после закрытия.
    if (!/(^| )playing( |$)/.test(document.documentElement.className)) {
      scrollY0 = window.pageYOffset || 0;
      document.documentElement.className += ' playing';
    }
    $('.p-side').className = 'p-side';
    TV.nav && TV.nav.push(el);
    TV.awake(true);
    playCurrent();
  };
  P.isOpen = function () { return !!(state && el && /open/.test(el.className)); };

  P.close = function () {
    if (!state) return;
    savePos();
    stop();
    state = null;
    TV.awake(false);
    el.className = '';
    document.documentElement.className = document.documentElement.className.replace(/\s*playing/g, '');
    window.scrollTo(0, scrollY0);
    if (document.webkitFullscreenElement || document.fullscreenElement) {
      try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {}
    }
    TV.nav && TV.nav.pop();
    TV.emit('playerClosed');
  };

  P.step = function (d) {
    if (!state || state.items.length < 2) return;
    savePos();
    var n = state.items.length;
    state.index = (state.index + d + n) % n;
    playCurrent();
  };
  P.jumpNumber = function (num) {
    if (!state) return;
    var i = TV.indexOf(state.items, function (c) { return c.num === num; });
    if (i < 0 && num >= 1 && num <= state.items.length) i = num - 1;
    if (i >= 0) { state.index = i; playCurrent(); }
    else TV.toast('Нет канала ' + num);
  };

  function cur() { return state && state.items[state.index]; }

  function playCurrent() {
    var it = cur();
    if (!it) return;
    stop();
    state.started = false; state.vi = 0; state.variants = []; state.live = false; state.resolved = null;
    state.isCh = !!(it.v && it.v.length) || it.k === 'ch';
    state.preferHlsJs = it.k === 'yt';    // у YouTube раздельные дорожки — hls.js справляется лучше
    var ch = it.k === 'ch' && !it.v ? TV.catalog.byId(it.id) : it;
    if (state.isCh && ch) {
      state.ch = ch; state.live = true;
      state.variants = TV.health.variants(ch);
      setTitle(ch.n, (ch.num ? '№' + ch.num + ' · ' : '') + regionName(ch.r));
      TV.history.add({ k: 'ch', id: ch.id, n: ch.n, img: ch.l });
      tryVariant();
    } else if (it.k === 'yt' && TV.yt.mode() !== 'mirror') {
      state.ch = null;
      setTitle(it.n, it.sub || '');
      playEmbed(it);
    } else {
      state.ch = null;
      setTitle(it.n, it.sub || '');
      busy(true, 'Загрузка…');
      resolveItem(it, function (err, r) {
        if (!state || cur() !== it) return;
        if (err) return showError(err, false);
        state.live = !!r.live;
        state.srcUrl = r.url;
        state.variants = [{ u: ytUrl(it, r.url) }];
        if (r.title && !it.n) setTitle(r.title, it.sub || '');
        TV.history.add(it);
        // качества, озвучки и субтитры для меню ⚙ (только у видео YouTube в HLS)
        state.tracks = null;
        // субтитры — из API зеркала; русские первыми
        var caps = (r.captions || []).slice(0), rk = function (x) { return /^ru/.test(x.lang) ? 0 : /^en/.test(x.lang) ? 1 : 2; };
        caps.sort(function (x, y) { return rk(x) - rk(y); });
        state.captions = caps;
        if (it.k === 'yt' && isHlsUrl(r.url)) TV.yt.hlsInfo(r.url, function (e, info) {
          if (state && cur() === it && !e) { info.subs = caps; state.tracks = info; renderUi(); }
        });
        else state.tracks = { heights: [], audio: [], subs: caps };
        tryVariant();
      });
    }
    uiOn = true;
    renderUi();
    renderSide();
    clearTimeout(hideT);
  }

  /* ------------------------------------------------------------ официальный плеер YouTube (0.3.0)
     Видео YouTube на устройствах, где он работает, показывает официальный плеер (web/yt.html на
     GitHub Pages). Он сообщает о событиях через postMessage; принимаем их только от своих страниц. */
  var embedT = null;
  function stopEmbed() {
    clearTimeout(embedT);
    var f = el && $('.p-embed');
    if (f) { try { f.src = 'about:blank'; } catch (e) {} f.parentNode.removeChild(f); }
  }
  function playEmbed(it) {
    stop();
    if (TV.yt.mode() === 'none') {
      showError('На этом устройстве официальный плеер YouTube не работает (старая система). ' +
        'Укажите своё зеркало: Ещё → Настройки → «Своё зеркало».', false);
      return;
    }
    state.embed = true; state.live = !!it.live;
    busy(true, 'Загрузка плеера YouTube…');
    var f = document.createElement('iframe');
    f.className = 'p-embed';
    f.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
    f.setAttribute('allowfullscreen', '');
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.src = TV.yt.embedUrl(it.id);
    el.insertBefore(f, video.nextSibling);
    TV.history.add(it);
    clearTimeout(embedT);
    embedT = setTimeout(function () {
      if (state && state.embed && !state.started) showError('Плеер YouTube не ответил. Проверьте интернет или откройте видео на YouTube.', true);
    }, 30000);
    renderUi();
  }
  function embedOrigins() { return [location.origin, TV.PAGES.replace(/^(https:\/\/[^\/]+).*/, '$1')]; }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.bt !== 'yt' || !state || !state.embed) return;
    if (embedOrigins().indexOf(e.origin) < 0 && e.origin !== 'null') return;   // только наши страницы
    if (cur() && d.v && cur().id !== d.v) return;
    if (d.ev === 'ready' || d.ev === 'playing') {
      clearTimeout(embedT); busy(false);
      if (!state.started) { state.started = true; scheduleHide(); }
    } else if (d.ev === 'ended') {
      if (state.items.length > 1) P.step(1);
    } else if (d.ev === 'error') {
      clearTimeout(embedT);
      var why = d.code === 101 || d.code === 150 || d.code === 152 || d.code === 153
        ? 'YouTube не разрешил показ во встроенном плеере (запрет автора, возрастное ограничение или проверка «не бот» — бывает при VPN).'
        : d.code === 100 ? 'Видео удалено или скрыто.' : d.code === 1 ? 'Не загрузился плеер YouTube (нет связи с YouTube).' : 'YouTube не смог показать видео (код ' + d.code + ').';
      showError(why, true);
    }
  }, false);

  function regionName(rid) { var r = TV.catalog.region(rid); return r ? r.flag + ' ' + r.name : ''; }

  /* ------------------------------------------------------------ качество, озвучка, субтитры */
  /* Выбранное качество (высота кадра); 0 — авто. На iPad mini 1 (A5) разумный максимум — 720/1080 H.264 */
  function wantHeight() { var q = TV.settings.ytQuality; return q === 'auto' ? 0 : parseInt(q, 10) || 720; }

  /* В iOS-приложении встроенный HLS-плеер не даёт выбрать качество и озвучку из JavaScript,
     поэтому видео YouTube идёт через локальный сервер приложения (ios/src/main.m, TVLocalServer):
     он отдаёт тот же плейлист, оставив выбранное качество, только H.264 и нужную озвучку/субтитры
     «по умолчанию». В браузере то же делает hls.js (см. applyHlsJs). */
  function ytUrl(it, url) {
    var port = window.TV_NATIVE && window.TV_NATIVE.port;
    if (it.k !== 'yt' || !port || !isHlsUrl(url)) return url;
    return 'http://127.0.0.1:' + port + '/hls?u=' + encodeURIComponent(url) + '&h=' + wantHeight() +
      '&a=' + encodeURIComponent(TV.settings.ytAudio || '') + '&s=' + encodeURIComponent(TV.settings.ytSubs || '');
  }

  function langOk(l, want) { return !!(l && want && String(l).toLowerCase().indexOf(want) === 0); }

  /* hls.js: уровень качества, дорожка озвучки, субтитры */
  function applyHlsJs() {
    if (!hls || !state || state.isCh) return;
    var h = wantHeight(), best = -1;
    if (hls.levels && hls.levels.length) {
      TV.each(hls.levels, function (l, i) {
        var codecOk = !l.videoCodec || /avc1/.test(l.videoCodec);
        if (codecOk && l.height && (!h || l.height <= h) && (best < 0 || l.height > hls.levels[best].height)) best = i;
      });
      if (h && best >= 0) { hls.currentLevel = best; hls.loadLevel = best; } else if (best >= 0) hls.autoLevelCapping = best;
    }
    var a = TV.settings.ytAudio, s = TV.settings.ytSubs;
    if (hls.audioTracks && hls.audioTracks.length) {
      var ai = TV.indexOf(hls.audioTracks, function (t) { return langOk(t.lang, a); });
      if (ai < 0) ai = TV.indexOf(hls.audioTracks, function (t) { return /original/i.test(t.name || ''); });
      if (ai >= 0 && hls.audioTrack !== ai) hls.audioTrack = ai;
    }
    // субтитры потока не используем: через зеркало их плейлисты не грузятся (см. setSubtitles)
    if (hls.subtitleTracks && hls.subtitleTracks.length && hls.subtitleTrack !== -1) hls.subtitleTrack = -1;
  }

  /* Встроенный плеер (Safari, iOS): дорожки озвучки и субтитров из HLS через audioTracks/textTracks */
  function applyMediaTracks() {
    if (!state || state.isCh) return;
    var a = TV.settings.ytAudio, s = TV.settings.ytSubs, i;
    var at = video.audioTracks;
    if (at && at.length > 1 && a) {
      var hit = -1;
      for (i = 0; i < at.length; i++) if (langOk(at[i].language, a)) { hit = i; break; }
      if (hit >= 0) for (i = 0; i < at.length; i++) at[i].enabled = i === hit;
    }
    setSubtitles();
  }

  /* Субтитры: файл VTT с зеркала скачивается (через мост приложения — без CORS) и подключается
     к плееру дорожкой <track> через blob-адрес. Работает и в hls.js, и во встроенном плеере iOS. */
  var subUrl = null, subGen = 0;
  /* У YouTube соседние реплики накладываются по времени — на экране строки дублируются.
     Обрезаем конец каждой реплики к началу следующей. */
  function tidyCues(track) {
    var c = track && track.cues;
    if (!c) return;
    for (var i = 0; i + 1 < c.length; i++) if (c[i].endTime > c[i + 1].startTime) { try { c[i].endTime = c[i + 1].startTime; } catch (e) {} }
  }
  /* То же на уровне текста VTT (надёжнее: срабатывает до подключения дорожки) */
  function tidyVtt(text) {
    var T = /(\d{2}:)?\d{2}:\d{2}\.\d{3}/g, lines = String(text).split(/\r?\n/), idx = [];
    for (var i = 0; i < lines.length; i++) if (lines[i].indexOf('-->') > 0) idx.push(i);
    var sec = function (t) { var p = t.split(':'), s = 0; for (var k = 0; k < p.length; k++) s = s * 60 + parseFloat(p[k]); return s; };
    for (var j = 0; j + 1 < idx.length; j++) {
      var a = lines[idx[j]].match(T), b = lines[idx[j + 1]].match(T);
      if (a && b && a.length >= 2 && sec(a[1]) > sec(b[0])) lines[idx[j]] = lines[idx[j]].replace(a[1], b[0]);
    }
    return lines.join('\n');
  }
  function setSubtitles() {
    var gen = ++subGen;   // защита от гонки: подключается только последний запрошенный файл
    var old = video.querySelectorAll('track'), i;
    for (i = 0; i < old.length; i++) video.removeChild(old[i]);
    if (subUrl && window.URL && URL.revokeObjectURL) { try { URL.revokeObjectURL(subUrl); } catch (e) {} subUrl = null; }
    var tt = video.textTracks;
    if (tt) for (i = 0; i < tt.length; i++) if (tt[i].kind !== 'metadata') tt[i].mode = 'disabled';
    var want = TV.settings.ytSubs, it = cur();
    if (!state || !want || !state.captions) return;
    var c = TV.find(state.captions, function (x) { return langOk(x.lang, want); });
    if (!c) return;
    TV.ajax(c.url, { text: true, timeout: 15000 }, function (err, text) {
      if (gen !== subGen) return;
      if (err || !state || cur() !== it || !/WEBVTT/.test(text || '')) { if (err) TV.toast('Субтитры не загрузились'); return; }
      var src;
      text = tidyVtt(text);
      try { subUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' })); src = subUrl; }
      catch (e) { src = 'data:text/vtt;charset=utf-8,' + encodeURIComponent(text); }
      var tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.srclang = c.lang; tr.label = c.name; tr.src = src; tr['default'] = true;
      tr.addEventListener('load', function () { if (tr.track) { tr.track.mode = 'showing'; tidyCues(tr.track); } }, false);
      video.appendChild(tr);
      if (tr.track) tr.track.mode = 'showing';
    });
  }

  /* Сменить качество/озвучку/субтитры и продолжить с того же места */
  function setTrackOption(kind, val) {
    var key = kind === 'q' ? 'ytQuality' : kind === 'a' ? 'ytAudio' : 'ytSubs';
    TV.settings[key] = val; TV.saveSettings();
    closeOpts();
    if (!state || !state.srcUrl) return;
    if (kind === 's') { setSubtitles(); return; }                // субтитры — дорожкой <track>, без перезагрузки
    if (hls && kind !== 'q') { applyHlsJs(); return; }          // hls.js переключает озвучку на лету
    if (!window.TV_NATIVE && kind !== 'q') { applyMediaTracks(); return; }
    state.resumeAt = video.currentTime || 0;
    state.variants = [{ u: ytUrl(cur(), state.srcUrl) }];
    state.vi = 0; state.started = false;
    tryVariant();
  }

  function openOpts() {
    $('.p-side').className = 'p-side';
    var t = state && state.tracks, s = TV.settings, h = '<div class="p-opts-in"><div class="p-opts-h">Настройки видео<button class="pbtn" data-p="optsclose">✕</button></div>';
    var item = function (kind, val, label, on) {
      return '<button class="p-opt' + (on ? ' on' : '') + '" data-p="opt:' + kind + ':' + TV.esc(val) + '">' + TV.esc(label) + '</button>';
    };
    var heights = (t && t.heights.length ? t.heights : [1080, 720, 480, 360]);
    h += '<h4>Качество</h4>' + item('q', 'auto', 'Авто', s.ytQuality === 'auto');
    TV.each(heights, function (x) { if (x >= 240 && x <= 1080) h += item('q', String(x), x + 'p' + (x >= 720 ? ' HD' : ''), String(s.ytQuality) === String(x)); });
    if (t && t.audio.length > 1) {
      h += '<h4>Озвучка</h4>';
      TV.each(t.audio, function (x) { h += item('a', x.orig ? '' : x.lang, x.name, x.orig ? !s.ytAudio || !TV.find(t.audio, function (y) { return langOk(y.lang, s.ytAudio) && !y.orig; }) : langOk(x.lang, s.ytAudio)); });
    }
    if (t && t.subs.length) {
      h += '<h4>Субтитры</h4>' + item('s', '', 'Выключены', !s.ytSubs);
      TV.each(t.subs, function (x) { h += item('s', x.lang, x.name, langOk(x.lang, s.ytSubs)); });
    }
    if (!t) h += '<p class="note">Озвучка и субтитры появятся, когда видео загрузится.</p>';
    h += '</div>';
    var o = $('.p-opts'); o.innerHTML = h; o.className = 'p-opts open';
    showUi(true);
  }
  function closeOpts() { var o = $('.p-opts'); if (o) o.className = 'p-opts'; scheduleHide(); }

  function resolveItem(it, cb) {
    if (it.k === 'yt') return TV.yt.resolve(it.id, cb);
    if (it.k === 'arch') return TV.arch.resolve(it.id, cb);
    if (it.u) return cb(null, { url: it.u, live: /\.m3u8?(\?|$)/i.test(it.u) && it.k === 'url' && !!it.live });
    cb('нет ссылки');
  }

  /* ------------------------------------------------------------ источники */
  function tryVariant() {
    if (!state) return;
    var v = state.variants[state.vi];
    if (!v) return showError(state.isCh ? 'Канал сейчас не отвечает ни по одному источнику.' : 'Не удалось открыть видео.', true);
    var url = v.u;
    if (location.protocol === 'https:' && /^http:/i.test(url)) {
      // браузер не даст загрузить http-поток со страницы https — пробуем https-версию адреса
      url = url.replace(/^http:/i, 'https:');
    }
    state.url = url;
    state.altTried = false; state.mediaRecovered = false;
    var tot = state.variants.length;
    busy(true, state.isCh ? 'Подключаюсь' + (tot > 1 ? ' · источник ' + (state.vi + 1) + ' из ' + tot : '') + '…' : 'Загрузка…');
    load(url, v.h);
    clearTimeout(srcT);
    var sec = TV.settings.timeout || 12;
    if (TV.lite()) sec += 4;
    srcT = setTimeout(function () { if (state && !state.started) fail('таймаут ' + sec + ' с'); }, sec * 1000);
  }

  function fail(why) {
    if (!state) return;
    if (state.started) {           // уже играло и оборвалось — один раз пробуем переподключиться
      if (!state.retried) { state.retried = true; state.started = false; busy(true, 'Связь прервалась, переподключаюсь…'); load(state.url); return; }
    }
    clearTimeout(srcT);
    // Тот же источник другим движком (встроенный HLS ↔ hls.js), прежде чем считать его мёртвым
    if (!state.altTried && isHlsUrl(state.url) && TV.device.mse && TV.device.nativeHls && !TV.device.ios) {
      state.altTried = true;
      busy(true, 'Пробую другой способ воспроизведения…');
      load(state.url, null, state.engine === 'hlsjs' ? 'native' : 'hlsjs');
      srcT = setTimeout(function () { if (state && !state.started) fail('таймаут'); }, (TV.settings.timeout || 12) * 1000);
      return;
    }
    // без интернета ссылка не виновата — не помечаем её мёртвой
    if (state.isCh && navigator.onLine !== false) TV.health.mark(state.variants[state.vi].u, false);
    state.vi++;
    if (state.vi < state.variants.length && TV.settings.autoNext) tryVariant();
    else showError((state.isCh ? 'Канал не отвечает' : 'Видео не открылось') + ' (' + why + ').', true);
  }

  function onPlaying() {
    if (!state) return;
    clearTimeout(srcT);
    busy(false);
    if (!state.started) {
      state.started = true; state.retried = false;
      if (state.isCh) { TV.health.mark(state.variants[state.vi].u, true); TV.emit('health'); }
      var it = cur();
      if (state.resumeAt > 1) {               // смена качества — продолжить с того же места
        try { video.currentTime = state.resumeAt; } catch (e) {}
        state.resumeAt = 0;
      } else if (!state.live && it && it.id) {
        var p = TV.positions.get(it.k + it.id);
        if (p > 5) { try { video.currentTime = p; } catch (e) {} TV.toast('Продолжаю с ' + TV.fmtTime(p)); }
      }
      if (!hls) applyMediaTracks(); else setSubtitles();
      scheduleHide();
    }
    renderUi();
  }

  /* ------------------------------------------------------------ движок */
  function stop() {
    stopEmbed();
    if (state) state.embed = false;
    clearTimeout(srcT); clearInterval(posT);
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}
  }

  var hlsLoading = false, hlsWait = [];
  function withHls(cb) {
    if (window.Hls) return cb(window.Hls);
    hlsWait.push(cb);
    if (hlsLoading) return;
    hlsLoading = true;
    var s = document.createElement('script');
    s.src = 'vendor/hls.min.js';
    s.onload = function () { var w = hlsWait; hlsWait = []; TV.each(w, function (f) { f(window.Hls); }); };
    s.onerror = function () { var w = hlsWait; hlsWait = []; TV.each(w, function (f) { f(null); }); hlsLoading = false; };
    document.head.appendChild(s);
  }

  function isHlsUrl(url) { return /\.m3u8?(\?|$)|\/manifest\/hls|\/hls_|m3u8/i.test(url); }

  /* force: 'hlsjs' | 'native' — какой движок использовать (по умолчанию выбирается сам) */
  function load(url, headers, force) {
    stop();
    var isHls = isHlsUrl(url);
    var useHlsJs = isHls && TV.device.mse && (force === 'hlsjs' ||
      (!force && (!TV.device.nativeHls || (state.preferHlsJs && !TV.device.ios))));
    state.engine = useHlsJs ? 'hlsjs' : 'native';
    if (!useHlsJs) {
      video.src = url;
      playSafe();
      startPosTimer();
      return;
    }
    withHls(function (Hls) {
      if (!state || state.url !== url) return;
      if (!Hls || !Hls.isSupported()) { video.src = url; playSafe(); return; }
      var lite = TV.lite(), yt = !state.isCh && cur() && cur().k === 'yt';
      hls = new Hls({
        // для видео YouTube качество задаёт пользователь (меню ⚙), не размер окна
        startLevel: lite && !yt ? 0 : -1, capLevelToPlayerSize: !yt, maxBufferLength: lite ? 10 : 30,
        maxMaxBufferLength: lite ? 20 : 60, backBufferLength: lite ? 5 : 30, enableWorker: !lite,
        manifestLoadingTimeOut: 8000, manifestLoadingMaxRetry: 1, levelLoadingTimeOut: 8000, fragLoadingTimeOut: 15000,
        abrEwmaDefaultEstimate: lite ? 300000 : 1000000,
        // субтитры потока YouTube через зеркало не грузятся — свои субтитры подключаются дорожкой <track>
        enableWebVTT: !yt, subtitleDisplay: !yt
      });
      if (yt) {
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, applyHlsJs);
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, applyHlsJs);
      }
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        if (yt) { applyHlsJs(); playSafe(); return; }
        if (lite && hls.levels) {          // в лёгком режиме — не выше 480p (телеканалы)
          var cap = -1;
          TV.each(hls.levels, function (l, i) { if (!l.height || l.height <= 480) cap = i; });
          if (cap >= 0) hls.autoLevelCapping = cap;
        }
        playSafe();
      });
      hls.on(Hls.Events.ERROR, function (e, d) {
        // ошибка субтитров или запасной дорожки звука не должна останавливать видео
        if (/subtitle/i.test(d.details || '')) { try { hls.subtitleTrack = -1; } catch (x) {} return; }
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !state.mediaRecovered) { state.mediaRecovered = true; hls.recoverMediaError(); return; }
        fail(d.details || 'ошибка сети');
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      startPosTimer();
    });
  }

  function playSafe() {
    try {
      var p = video.play();
      if (p && p['catch']) p['catch'](function (e) {
        if (e && e.name === 'NotAllowedError') { busy(false); showTapToPlay(); }
      });
    } catch (e) {}
  }
  function showTapToPlay() {
    msg('Нажмите ▶, чтобы начать', [['play', '▶ Смотреть']]);
  }

  function startPosTimer() {
    clearInterval(posT);
    posT = setInterval(savePos, 5000);
  }
  function savePos() {
    if (!state || state.live || !state.started) return;
    var it = cur();
    if (it && it.id && video.currentTime) TV.positions.set(it.k + it.id, video.currentTime, video.duration);
  }

  /* ------------------------------------------------------------ интерфейс */
  function setTitle(t, s) { $('.p-title b').textContent = t || ''; $('.p-title span').textContent = s || ''; }

  function busy(on, text) {
    var st = $('.p-status');
    st.className = 'p-status' + (on ? ' busy' : '');
    $('.p-msg').textContent = on ? (text || '') : '';
    $('.p-actions').innerHTML = '';
  }
  function msg(text, actions) {
    var st = $('.p-status');
    st.className = 'p-status show';
    $('.p-msg').textContent = text;
    var h = '';
    TV.each(actions || [], function (a) { h += '<button class="pbtn wide" data-p="' + a[0] + '">' + TV.esc(a[1]) + '</button>'; });
    $('.p-actions').innerHTML = h;
    showUi(true);
  }
  function showError(text, canRetry) {
    clearTimeout(srcT);
    var acts = [];
    if (canRetry) acts.push(['retry', '↻ Ещё раз']);
    if (state && state.items.length > 1) acts.push(['next', 'Следующий ▶']);
    if (state && state.ch) acts.push(['report', 'Скрыть канал']);
    if (state && cur() && cur().k === 'yt') acts.push(['web', 'Открыть на YouTube']);
    acts.push(['close', 'Назад']);
    var hint = '';
    if (TV.device.oldTls) hint = '\nСтарая iOS: если не открывается почти ничего — установите сертификаты (Ещё → Помощь).';
    msg(text + hint, acts);
  }

  function renderUi() {
    if (!state) return;
    var it = cur(), live = state.live || state.isCh, multi = state.items.length > 1;
    el.className = 'open' + (live ? ' live' : ' vod') + (multi ? ' multi' : '') + (state.isCh ? ' ch' : '') + (state.embed ? ' embed' : '') + (uiOn || state.embed ? ' ui' : '');
    var favIt = state.ch ? { k: 'ch', id: state.ch.id, n: state.ch.n, img: state.ch.l } : it;
    $('[data-p=fav]').textContent = favIt && TV.fav.has(favIt) ? '★' : '☆';
    $('[data-p=src]').style.display = state.isCh && state.variants.length > 1 ? '' : 'none';
    // ⚙ — только в режиме зеркала (у официального плеера YouTube своё меню качества, озвучки и субтитров)
    $('[data-p=opts]').style.display = it && it.k === 'yt' && !state.live && !state.embed ? '' : 'none';
    $('[data-p=dl]').style.display = TV.dl && TV.dl.canDownload(it) && !TV.dl.get(it.k + ':' + (it.id || it.u)) ? '' : 'none';
    setPlayIcon();
  }
  function setPlayIcon() { if (el) $('[data-p=play]').textContent = video.paused ? '▶' : '❚❚'; }

  function onTime() {
    if (!state || state.live) return;
    var d = video.duration;
    if (!d || !isFinite(d)) return;
    $('.p-cur').textContent = TV.fmtTime(video.currentTime);
    $('.p-dur').textContent = TV.fmtTime(d);
    if (!/p-ui-active/.test(el.className)) $('.p-range').value = Math.round(video.currentTime / d * 1000);
  }

  function setUi(on) {
    uiOn = on;
    el.className = el.className.replace(/\s*\bui\b/g, '') + (on ? ' ui' : '');
  }
  function showUi(stay) {
    if (!el) return;
    setUi(true);
    clearTimeout(hideT);
    if (!stay) scheduleHide();
  }
  function scheduleHide() {
    clearTimeout(hideT);
    hideT = setTimeout(function () {
      if (!state || !state.started || /open/.test($('.p-side').className) || /show/.test($('.p-status').className)) return;
      setUi(false);
    }, TV.lite() ? 3500 : 4500);
  }
  P.toggleUi = function () { if (uiOn) setUi(false); else showUi(); };

  function renderSide() {
    if (!state || state.items.length < 2) { $('.p-side-list').innerHTML = ''; return; }
    var h = '', from = Math.max(0, state.index - 40), to = Math.min(state.items.length, state.index + 60);
    for (var i = from; i < to; i++) {
      var c = state.items[i];
      h += '<button class="p-side-i' + (i === state.index ? ' cur' : '') + '" data-side="' + i + '">' +
        '<i>' + (c.num || i + 1) + '</i>' + TV.esc(c.n) + '</button>';
    }
    $('.p-side-list').innerHTML = h;
    var curEl = $('.p-side-i.cur');
    if (curEl) $('.p-side-list').scrollTop = curEl.offsetTop - 120;
  }
  P.toggleSide = function () {
    var s = $('.p-side');
    closeOpts();
    if (/open/.test(s.className)) s.className = 'p-side';
    else {
      // заголовок: «Каналы» для ТВ, «Список» для видео и фильмов
      $('.p-side-h span').textContent = state && state.isCh ? 'Каналы' : 'Список';
      s.className = 'p-side open'; renderSide(); showUi(true);
    }
  };

  /* Набор номера канала с пульта/клавиатуры */
  P.digit = function (d) {
    numBuf = (numBuf + d).slice(-3);
    var n = $('.p-num');
    n.textContent = numBuf; n.className = 'p-num show';
    clearTimeout(numT);
    numT = setTimeout(function () {
      n.className = 'p-num';
      var num = parseInt(numBuf, 10); numBuf = '';
      if (num) P.jumpNumber(num);
    }, 1400);
  };

  P.togglePlay = function () { if (video.paused) playSafe(); else video.pause(); showUi(); };
  P.seek = function (d) {
    if (state && !state.live && video.duration) { video.currentTime = Math.max(0, Math.min(video.duration - 1, video.currentTime + d)); showUi(); }
  };
  P.isLive = function () { return !!(state && (state.live || state.isCh)); };
  /* Для отладки из консоли: TV.player.debug() */
  P.debug = function () { return { hls: hls, state: state, video: video }; };

  /* Открыта боковая панель (список ☰ или меню ⚙)? Тогда касание мимо неё — закрыть её */
  P.panelOpen = function () { return !!(el && (/open/.test($('.p-side').className) || /open/.test($('.p-opts').className))); };
  P.closePanels = function () { $('.p-side').className = 'p-side'; closeOpts(); };

  function onClick(e) {
    var side = TV.closest(e.target, 'data-side');
    if (side) { state.index = parseInt(side.getAttribute('data-side'), 10); $('.p-side').className = 'p-side'; playCurrent(); return; }
    var b = TV.closest(e.target, 'data-p');
    var inPanel = TV.closest(e.target, 'data-panel');
    if (!b && !inPanel && P.panelOpen()) { P.closePanels(); return; }   // касание по видео — закрыть список/меню
    if (!b) { if (!inPanel) P.toggleUi(); return; }
    var a = b.getAttribute('data-p');
    if (a === 'sideclose') { $('.p-side').className = 'p-side'; scheduleHide(); return; }
    if (a.indexOf('opt:') === 0) { var parts = a.split(':'); setTrackOption(parts[1], parts.slice(2).join(':')); return; }
    if (a === 'opts') { openOpts(); return; }
    if (a === 'optsclose') { closeOpts(); return; }
    if (a === 'dl') {
      TV.dl.start(cur(), function (err) { TV.toast(err ? 'Не получилось: ' + err : '⬇ Скачивается — Фильмы → Загрузки'); renderUi(); });
      return;
    }
    showUi();
    if (a === 'close') P.close();
    else if (a === 'prev') P.step(-1);
    else if (a === 'next') P.step(1);
    else if (a === 'play') P.togglePlay();
    else if (a === 'back10') P.seek(-10);
    else if (a === 'fwd10') P.seek(30);
    else if (a === 'list') P.toggleSide();
    else if (a === 'retry' && cur() && cur().k === 'yt' && TV.yt.mode() !== 'mirror') { state.started = false; playEmbed(cur()); }
    else if (a === 'retry') { if (state.ch) state.variants = TV.health.variants(state.ch); state.vi = 0; tryVariant(); }
    else if (a === 'src') { if (state.variants.length > 1) { state.vi = (state.vi + 1) % state.variants.length; tryVariant(); } }
    else if (a === 'report') { TV.each(state.ch.v, function (v) { TV.health.mark(v.u, false); }); TV.emit('health'); TV.toast('Канал перенесён в «Не работают»'); P.step(1); }
    else if (a === 'web') { TV.openExternal(TV.yt.webUrl(cur().id)); }
    else if (a === 'fav') {
      var it = state.ch ? { k: 'ch', id: state.ch.id, n: state.ch.n, img: state.ch.l } : cur();
      TV.toast(TV.fav.toggle(it) ? '★ Добавлено в избранное' : 'Убрано из избранного');
      renderUi();
    } else if (a === 'fs') {
      var r = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
      if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else if (r) r.call(el);
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    }
  }
})();
