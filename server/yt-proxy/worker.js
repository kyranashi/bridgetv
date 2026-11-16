/**
 * BridgeTV — общий поиск YouTube без ключа у пользователя (1.4.0). Cloudflare Worker.
 *
 * Приложение без своего ключа шлёт сюда те же запросы, что шло бы в YouTube Data API v3
 * (https://www.googleapis.com/youtube/v3/…), только без ключа. Сервер:
 *   • пропускает только два метода — search и videos — и только известные параметры;
 *   • добавляет ключ из секрета YT_KEY (ключ живёт на сервере, в приложении и в git его нет);
 *   • кэширует ответы на 6 часов на краю Cloudflare — одинаковый поиск не тратит квоту повторно;
 *   • отвечает CORS только своему сайту (ALLOWED_ORIGINS); приложения ходят без Origin.
 *
 * Квота YouTube Data API бесплатная и жёстко ограничена (10 000 единиц в сутки, поиск — 100):
 * когда она кончается, Google отвечает 403 и приложение пишет «исчерпан на сегодня». Денег это не стоит.
 * Установка — docs/YT_PROXY.md.
 */
const API = 'https://www.googleapis.com/youtube/v3/';
const METHODS = {
  search: ['part', 'maxResults', 'regionCode', 'relevanceLanguage', 'safeSearch', 'q', 'type', 'order', 'eventType', 'videoDuration', 'pageToken'],
  videos: ['part', 'id', 'chart', 'maxResults', 'regionCode']
};
const ALLOWED_ORIGINS = ['https://kyranashi.github.io'];
const TTL = 6 * 3600;

function cors(origin) {
  return origin && ALLOWED_ORIGINS.indexOf(origin) >= 0
    ? { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin' }
    : {};
}

function reply(status, body, origin, extra) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }, cors(origin), extra || {})
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    if (origin && ALLOWED_ORIGINS.indexOf(origin) < 0) return reply(403, { error: 'origin' }, null);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: Object.assign({ 'Access-Control-Allow-Methods': 'GET' }, cors(origin)) });
    if (request.method !== 'GET') return reply(405, { error: 'method' }, origin);
    if (!env.YT_KEY) return reply(503, { error: 'not configured' }, origin);

    const url = new URL(request.url);
    const method = url.pathname.replace(/^\/+|\/+$/g, '');
    const allowed = METHODS[method];
    if (!allowed) return reply(404, { error: 'unknown method' }, origin);

    // Только известные параметры, в постоянном порядке — так кэш срабатывает для одинаковых запросов
    const out = new URLSearchParams();
    for (const name of allowed) {
      const v = url.searchParams.get(name);
      if (v != null && v.length <= 300) out.set(name, v);
    }
    if (+out.get('maxResults') > 30) out.set('maxResults', '30');
    if (method === 'search' && !out.get('q')) return reply(400, { error: 'q' }, origin);

    const cacheKey = new Request('https://yt-proxy.cache/' + method + '?' + out.toString());
    const cache = caches.default;
    let res = await cache.match(cacheKey);
    if (!res) {
      out.set('key', env.YT_KEY);
      const up = await fetch(API + method + '?' + out.toString(), { headers: { 'Accept': 'application/json' } });
      const text = await up.text();
      if (!up.ok) return reply(up.status === 403 ? 403 : 502, { error: 'youtube ' + up.status }, origin);   // текст Google с ключом наружу не отдаём
      res = new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + TTL } });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    }
    return reply(200, await res.text(), origin, { 'Cache-Control': 'public, max-age=' + TTL });
  }
};
