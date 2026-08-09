/* Brick Ledger service worker — makes the app load offline */
const CACHE = 'brickledger-v19';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './zxing-browser.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache the lookup proxy — always hit the live network.
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;

  if (url.origin === location.origin) {
    /* The page itself is network-first.

       It used to be cache-first like everything else, which quietly left the
       app a version behind: the first load after a deploy served stale HTML
       from cache while the new worker installed, and only a *second* reload
       picked up the change. That's how a shipped fix could appear missing on
       a device — the code was deployed, just not being run.

       Falling back to cache keeps it fully usable offline. */
    const isDoc = req.mode === 'navigate' || req.destination === 'document' ||
      url.pathname === '/' || url.pathname.endsWith('.html');

    if (isDoc) {
      e.respondWith(
        fetch(req).then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
      );
      return;
    }

    // Everything else is static and versioned by the cache name: cache-first.
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html')))
    );
    return;
  }

  // Fonts + the ZXing scanner library: cache them after first online load
  // so scanning and typography keep working offline afterwards.
  if (/fonts\.(googleapis|gstatic)\.com|unpkg\.com|jsdelivr\.net/.test(url.host)) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit))
    );
  }
});
