/* MTG Board service worker: app shell + card image cache */
const SHELL = 'mtg-shell-v1';
const IMG = 'mtg-img-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k.startsWith('mtg-shell-') && k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);

  // Card images: cache first, never refetch once stored.
  if (u.hostname.endsWith('scryfall.io')) {
    e.respondWith((async () => {
      const c = await caches.open(IMG);
      const hit = await c.match(req.url);
      if (hit) return hit;
      try {
        const r = await fetch(req.url, { mode: 'cors' });
        if (r.ok) c.put(req.url, r.clone());
        return r;
      } catch (err) {
        const r = await fetch(req);
        if (r.ok || r.type === 'opaque') c.put(req.url, r.clone());
        return r;
      }
    })());
    return;
  }

  // App shell: serve cached copy straight away, refresh it in the background.
  if (u.origin === location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(SHELL);
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      return (await net) || (await c.match('./')) || Response.error();
    })());
  }
});
