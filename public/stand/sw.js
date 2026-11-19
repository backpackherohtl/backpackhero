// Stand-Spiel offline verfügbar machen: Seite wird beim ersten Laden gemerkt.
// Mit Netz holt sie sich immer die neueste Version, ohne Netz kommt die gemerkte.
const CACHE = 'bh-stand-v3';
const SEITE = '/stand/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(SEITE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) { const kopie = r.clone(); caches.open(CACHE).then((c) => c.put(SEITE, kopie)); }
        return r;
      })
      .catch(() => caches.match(SEITE))
  );
});
