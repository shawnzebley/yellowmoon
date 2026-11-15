// Service worker: adds the cross-origin isolation headers GitHub Pages cannot send (threads need
// SharedArrayBuffer), and keeps the app on the phone so it opens offline after the first visit.
const VERSION = '__VERSION__';
const CACHE = `yellowmoon-${VERSION}`;
const BIG = ['ym.wasm', 'data.pack'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

function isolated(resp) {
  if (!resp || resp.status === 0 || resp.type === 'opaque') return resp;
  const h = new Headers(resp.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const big = BIG.some((n) => url.pathname.endsWith('/' + n));
    if (big) {
      const hit = await cache.match(e.request);
      if (hit) return isolated(hit);
      const resp = await fetch(e.request);
      if (resp.ok) await cache.put(e.request, resp.clone());
      return isolated(resp);
    }
    try {
      const resp = await fetch(e.request);
      if (resp.ok) cache.put(e.request, resp.clone());
      return isolated(resp);
    } catch {
      return isolated(await cache.match(e.request));
    }
  })());
});
