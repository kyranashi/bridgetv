/*
 * BridgeTV — управление с пульта и клавиатуры (Smart TV, приставки, ПК).
 *
 * Стрелки — перемещение фокуса по экрану «по направлению» (пространственная навигация),
 * OK/Enter — нажать, Назад/Esc/Backspace — назад.
 * В плеере: ◀ ▶ — канал (или перемотка у фильмов), ▲ ▼ — канал, цифры — номер канала,
 * OK — показать/скрыть панель, Пробел — пауза, CH+/CH− (PageUp/PageDown) — канал.
 */
(function () {
  var stack = [];
  var K = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, ESC: 27, BACK: 8, SPACE: 32,
    PGUP: 33, PGDN: 34, TIZEN_BACK: 10009, WEBOS_BACK: 461, CH_UP: 427, CH_DOWN: 428,
    PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, FF: 417, RW: 412 };

  /* Samsung Tizen: цифры, CH± и медиакнопки пульта приходят в приложение только после регистрации */
  try {
    if (window.tizen && tizen.tvinputdevice) {
      TV.each(['ChannelUp', 'ChannelDown', 'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind',
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], function (k) { try { tizen.tvinputdevice.registerKey(k); } catch (e) {} });
    }
  } catch (e) {}

  TV.nav = {
    push: function (root) { stack.push(root); },
    pop: function () { stack.pop(); },
    root: function () { return stack.length ? stack[stack.length - 1] : document.getElementById('app'); }
  };

  function visible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function focusables(root) {
    var all = TV.$$('button, a[href], input, select, textarea, [tabindex]', root), out = [];
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (!e.disabled && e.getAttribute('tabindex') !== '-1' && visible(e)) out.push(e);
    }
    // нижнее меню доступно и на экранах приложения
    if (!stack.length) {
      var tabs = TV.$$('#tabbar button');
      for (var j = 0; j < tabs.length; j++) if (visible(tabs[j])) out.push(tabs[j]);
    }
    return out;
  }
  function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  function move(dir) {
    var root = TV.nav.root(), list = focusables(root), curEl = document.activeElement;
    if (!list.length) return;
    if (!curEl || curEl === document.body || TV.indexOf(list, function (e) { return e === curEl; }) < 0) {
      list[0].focus(); return;
    }
    var cr = curEl.getBoundingClientRect(), c = center(cr), best = null, bestD = 1e9;
    TV.each(list, function (e) {
      if (e === curEl) return;
      var r = e.getBoundingClientRect(), p = center(r);
      var dx = p.x - c.x, dy = p.y - c.y, main, side;
      if (dir === 'L') { if (r.right > cr.left + 2) return; main = -dx; side = Math.abs(dy); }
      if (dir === 'R') { if (r.left < cr.right - 2) return; main = dx; side = Math.abs(dy); }
      if (dir === 'U') { if (r.bottom > cr.top + 2) return; main = -dy; side = Math.abs(dx); }
      if (dir === 'D') { if (r.top < cr.bottom - 2) return; main = dy; side = Math.abs(dx); }
      var d = main + side * 2.5;
      if (d < bestD) { bestD = d; best = e; }
    });
    if (best) {
      best.focus();
      if (best.scrollIntoView) {
        var r = best.getBoundingClientRect();
        if (r.top < 60 || r.bottom > window.innerHeight - 70) best.scrollIntoView(false);
      }
      // горизонтальные полки
      var shelf = TV.closest(best, 'data-shelf');
      if (shelf) {
        var br = best.getBoundingClientRect(), sr = shelf.getBoundingClientRect();
        if (br.left < sr.left || br.right > sr.right) shelf.scrollLeft += br.left - sr.left - 20;
      }
    }
  }

  function inInput() {
    var a = document.activeElement;
    return a && (a.tagName === 'INPUT' && a.type !== 'range' && a.type !== 'checkbox' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
  }

  /* Рамка фокуса видна только при управлении с клавиатуры/пульта (html.kbd);
     касание или мышь — убирает её (на телевизорах — всегда видна) */
  var setKbd = function (on) {
    var h = document.documentElement, has = /(^| )kbd( |$)/.test(h.className);
    if (on && !has) h.className += ' kbd';
    else if (!on && has && !TV.device.tv) h.className = h.className.replace(/(^| )kbd( |$)/, ' ');
  };
  if (TV.device.tv) setKbd(true);
  document.addEventListener('touchstart', function () { setKbd(false); }, true);
  document.addEventListener('mousedown', function () { setKbd(false); }, true);

  document.addEventListener('keydown', function (e) {
    if (e.keyCode >= 9 && e.keyCode <= 40 || e.keyCode > 400) setKbd(true);
    var k = e.keyCode, P = TV.player;
    var isBack = k === K.ESC || k === K.TIZEN_BACK || k === K.WEBOS_BACK || (k === K.BACK && !inInput());

    if (P && P.isOpen()) {
      var live = P.isLive();
      if (isBack) { if (P.panelOpen && P.panelOpen()) P.closePanels(); else P.close(); }
      else if (k >= 48 && k <= 57 && live) { P.digit(k - 48); }
      else if (k >= 96 && k <= 105 && live) { P.digit(k - 96); }
      else if (k === K.UP || k === K.PGUP || k === K.CH_UP) { if (live) P.step(1); else move('U'); }
      else if (k === K.DOWN || k === K.PGDN || k === K.CH_DOWN) { if (live) P.step(-1); else move('D'); }
      else if (k === K.LEFT) { if (document.activeElement && TV.closest(document.activeElement, 'data-p') && /ui/.test(document.getElementById('player').className)) move('L'); else if (live) P.step(-1); else P.seek(-10); }
      else if (k === K.RIGHT) { if (document.activeElement && TV.closest(document.activeElement, 'data-p') && /ui/.test(document.getElementById('player').className)) move('R'); else if (live) P.step(1); else P.seek(30); }
      else if (k === K.SPACE || k === K.PLAY || k === K.PAUSE || k === K.PLAYPAUSE) { P.togglePlay(); }
      else if (k === K.FF) { P.seek(30); }
      else if (k === K.RW) { P.seek(-10); }
      else if (k === K.ENTER) {
        var a = document.activeElement;
        if (a && a !== document.body && TV.closest(a, 'data-p')) return; // нажмётся как кнопка
        P.toggleUi();
      } else return;
      e.preventDefault();
      return;
    }

    if (inInput()) {
      if (k === K.ESC) document.activeElement.blur();
      if (k === K.DOWN) { move('D'); e.preventDefault(); }
      if (k === K.UP) { move('U'); e.preventDefault(); }
      return;
    }
    if (isBack) { if (TV.app && TV.app.back()) e.preventDefault(); return; }
    if (k === K.LEFT) move('L');
    else if (k === K.RIGHT) move('R');
    else if (k === K.UP) move('U');
    else if (k === K.DOWN) move('D');
    else if ((k >= 48 && k <= 57) || (k >= 96 && k <= 105)) { if (TV.app) TV.app.digit(k >= 96 ? k - 96 : k - 48); }
    else return;
    e.preventDefault();
  }, false);
})();
