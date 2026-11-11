/*
 * BridgeTV для ПК (Windows / Linux), с 0.3.0. Тонкая оболочка Electron вокруг того же web/,
 * что и в остальных версиях. Код интерфейса не меняется — он видит мост window.TVBridge.
 *
 * Безопасность (docs/SECURITY.md):
 *   • страница — в песочнице: contextIsolation, sandbox, без Node.js, webSecurity включена;
 *   • файлы приложения отдаются по своей схеме bridgetv://app/ только из папки www (без выхода наружу);
 *   • переходы на чужие страницы запрещены, новые окна не открываются — ссылки уходят в браузер
 *     (только http/https);
 *   • разрешения сайтов (камера, микрофон, геолокация, уведомления…) отклоняются, кроме полноэкранного режима;
 *   • команды моста — по списку, с проверкой типов и размеров;
 *   • Electron Fuses (package.json): нельзя запустить как Node, нельзя подменить код вне asar.
 */
'use strict';
const { app, BrowserWindow, protocol, ipcMain, shell, net, session, powerSaveBlocker, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

const SCHEME = 'bridgetv';
const ORIGIN = SCHEME + '://app';
const WWW = app.isPackaged ? path.join(process.resourcesPath, 'www') : path.join(__dirname, '..');
const DATA = () => app.getPath('userData');
const STORE = () => path.join(DATA(), 'tvstore');
const DL = () => path.join(DATA(), 'downloads');
const MAX_FETCH = 32 * 1024 * 1024;              // ответ fetch не больше 32 МБ
const MAX_SAVE = 8 * 1024 * 1024;                // одна запись хранилища не больше 8 МБ

// Схема не «secure»: IPTV-потоки часто идут по http, а с защищённой страницы браузер их заблокировал бы.
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

if (!app.requestSingleInstanceLock()) app.quit();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.txt': 'text/plain; charset=utf-8' };

// Политика содержимого для страниц приложения: скрипты только свои, без eval
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src * data: blob:; media-src * data: blob:; connect-src *; frame-src https://kyranashi.github.io https://www.youtube-nocookie.com https://www.youtube.com; " +
  "worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

/** Безопасно сопоставить путь запроса с файлом внутри base (без ../) */
function inside(base, rel) {
  let r;
  try { r = decodeURIComponent(rel); } catch (e) { return null; }
  if (r.indexOf('\0') >= 0) return null;
  const b = path.resolve(base), p = path.resolve(b, '.' + path.sep + r.replace(/\//g, path.sep));
  return p.startsWith(b + path.sep) ? p : null;
}

/** Отдать файл, с поддержкой Range (перемотка видео) */
function serveFile(file, req) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return new Response('not found', { status: 404 }); }
  if (!st.isFile()) return new Response('not found', { status: 404 });
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
  if (type.indexOf('text/html') === 0) headers['Content-Security-Policy'] = CSP;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
  if (range && st.size > 0) {
    let start = range[1] ? parseInt(range[1], 10) : st.size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : st.size - 1;
    if (!(start >= 0) || start >= st.size) return new Response('', { status: 416, headers: { 'Content-Range': 'bytes */' + st.size } });
    end = Math.min(end, st.size - 1);
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers });
  }
  headers['Content-Length'] = String(st.size);
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
}

function handleScheme(req) {
  const u = new URL(req.url);
  if (u.host !== 'app') return new Response('forbidden', { status: 403 });
  let file = null;
  if (u.pathname.indexOf('/dl/') === 0) file = inside(DL(), u.pathname.slice(4));
  else if (/^\/web\//.test(u.pathname)) file = inside(path.join(WWW, 'web'), u.pathname.slice(5));
  else if (/^\/data\//.test(u.pathname)) file = inside(path.join(WWW, 'data'), u.pathname.slice(6));
  return file ? serveFile(file, req) : new Response('forbidden', { status: 403 });
}

const isWeb = (url) => { try { const p = new URL(url).protocol; return p === 'https:' || p === 'http:'; } catch (e) { return false; } };

// ------------------------------------------------------------------ мост
let win = null, awakeId = -1;

function js(code) { if (win && !win.isDestroyed()) win.webContents.executeJavaScript(code, false).catch(() => {}); }

ipcMain.on('tv:info', (e) => {
  e.returnValue = JSON.stringify({ platform: 'desktop', app: app.getVersion(), os: process.platform + ' ' + process.getSystemVersion(),
    model: 'PC', fileBase: ORIGIN + '/dl/' });
});
ipcMain.on('tv:saved', (e) => {
  const out = {};
  try {
    for (const n of fs.readdirSync(STORE())) if (/^[A-Za-z0-9_-]{1,64}\.json$/.test(n)) out[n.slice(0, -5)] = fs.readFileSync(path.join(STORE(), n), 'utf8');
  } catch (err) { /* ещё нет данных */ }
  e.returnValue = JSON.stringify(out);
});
ipcMain.on('tv:msg', (e, json) => {
  if (!win || e.sender !== win.webContents) return;                  // только наше окно
  let m;
  try { m = JSON.parse(json); } catch (err) { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.cmd) {
    case 'fetch': return doFetch(m);
    case 'save': return save(m.key, m.value);
    case 'awake': return awake(!!m.on);
    case 'open': if (isWeb(m.url)) shell.openExternal(m.url); return;
    case 'download': return download(String(m.id || ''), m.url);
    case 'dlDelete': { const f = inside(DL(), path.basename(String(m.file || ''))); if (f) fs.unlink(f, () => {}); return; }
    default: return;                                                    // неизвестные команды игнорируются
  }
});

async function doFetch(m) {
  const id = String(m.id || '');
  let err = null, text = '', code = 0;
  if (!isWeb(m.url)) { err = 'адрес'; }
  else {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.min(Math.max(parseInt(m.timeout, 10) || 15000, 1000), 120000));
    try {
      const method = m.method === 'POST' ? 'POST' : 'GET';
      const r = await net.fetch(m.url, { method, body: method === 'POST' && typeof m.body === 'string' ? m.body : undefined,
        signal: ctl.signal, headers: { 'User-Agent': 'BridgeTV-Desktop/' + app.getVersion() } });
      code = r.status;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_FETCH) throw new Error('big');
      text = buf.toString('utf8');
      if (code < 200 || code >= 300) err = 'HTTP ' + code;
    } catch (ex) {
      err = ex && ex.name === 'AbortError' ? 'таймаут' : ex && ex.message === 'big' ? 'слишком большой ответ' : 'нет связи';
    } finally { clearTimeout(t); }
  }
  js('TV.nativeCb.apply(null,' + JSON.stringify([id, err, text, code]) + ')');
}

function save(key, value) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) return;
  const f = path.join(STORE(), key + '.json');
  if (value == null) { fs.unlink(f, () => {}); return; }
  if (typeof value !== 'string' || value.length > MAX_SAVE) return;
  fs.mkdirSync(STORE(), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFile(tmp, value, 'utf8', (e) => { if (!e) fs.rename(tmp, f, () => {}); });
}

function awake(on) {
  if (on && awakeId < 0) awakeId = powerSaveBlocker.start('prevent-display-sleep');
  else if (!on && awakeId >= 0) { powerSaveBlocker.stop(awakeId); awakeId = -1; }
}

async function download(id, url) {
  const ev = (o) => js('TV.nativeEvent&&TV.nativeEvent("dl",' + JSON.stringify(Object.assign({ id }, o)) + ')');
  if (!isWeb(url) || !id || id.length > 2048) return ev({ err: 'адрес' });
  fs.mkdirSync(DL(), { recursive: true });
  const name = 'dl-' + Date.now() + '.mp4', dest = path.join(DL(), name);
  try {
    const r = await net.fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const size = parseInt(r.headers.get('content-length'), 10) || 0;
    const out = fs.createWriteStream(dest);
    const reader = r.body.getReader();
    let got = 0, last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((res) => out.once('drain', res));
      if (Date.now() - last > 1000) { last = Date.now(); ev(size ? { got, size } : { got }); }
    }
    await new Promise((res) => out.end(res));
    ev({ file: name, done: true, size: got, got });
  } catch (ex) {
    fs.unlink(dest, () => {});
    ev({ err: 'обрыв загрузки' });
  }
}

// ------------------------------------------------------------------ окно
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 360, minHeight: 480, backgroundColor: '#0a0d14', title: 'BridgeTV',
    icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: !app.isPackaged }
  });
  win.once('ready-to-show', () => win.show());
  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => { if (isWeb(url)) shell.openExternal(url); return { action: 'deny' }; });
  wc.on('will-navigate', (e, url) => { if (url.indexOf(ORIGIN + '/') !== 0) { e.preventDefault(); if (isWeb(url)) shell.openExternal(url); } });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  win.on('enter-full-screen', () => js('document.documentElement.classList.add("fs")'));
  win.on('leave-full-screen', () => js('document.documentElement.classList.remove("fs")'));
  win.loadURL(ORIGIN + '/web/index.html');
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('web-contents-created', (e, wc) => {
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  protocol.handle(SCHEME, handleScheme);
  const ses = session.defaultSession;
  // Разрешения: только полноэкранный режим (видео). Камера, микрофон, геолокация и прочее — нет.
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(perm === 'fullscreen'));
  ses.setPermissionCheckHandler((wc, perm) => perm === 'fullscreen');
  // Каналы без заголовков CORS: в программе (в отличие от браузера) разрешаем их читать только нашей странице.
  ses.webRequest.onHeadersReceived((d, cb) => {
    const h = d.responseHeaders || {};
    // только запросы самой страницы приложения (не встроенного плеера YouTube и не других фреймов)
    let fromApp = false;
    try { fromApp = !!(win && !win.isDestroyed() && d.frame && d.frame === win.webContents.mainFrame) && d.resourceType !== 'subFrame' && d.resourceType !== 'mainFrame'; } catch (e) { fromApp = false; }
    if (fromApp && /^https?:/.test(d.url)) {
      for (const k of Object.keys(h)) if (/^access-control-allow-(origin|credentials)$/i.test(k)) delete h[k];
      h['Access-Control-Allow-Origin'] = [ORIGIN];
    }
    cb({ responseHeaders: h });
  });
  createWindow();
});
app.on('window-all-closed', () => app.quit());
