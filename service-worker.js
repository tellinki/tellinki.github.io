/*
 * Tellinki.com service worker.
 *
 * Strategy:
 *  - App shell (HTML/CSS/JS/icons): cache-first, so the app opens offline.
 *  - Data files (parking.json, *.geojson, data-meta.json): network-first,
 *    so fresh data actually reaches users; cache is the offline fallback.
 *  - Cross-origin (map tiles, live city-bike API): straight to network,
 *    never cached.
 *
 * Bump VERSION when the app shell changes to roll the cache.
 */
const VERSION = 'tellinki-v2.0.0';
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;

const SHELL_URLS = [
  './',
  'index.html',
  'manifest.json',
  'css/style.css',
  'css/leaflet.css',
  'css/MarkerCluster.css',
  'css/MarkerCluster.Default.css',
  'css/L.Control.Locate.min.css',
  'css/images/marker-icon.png',
  'css/images/marker-icon-2x.png',
  'css/images/marker-shadow.png',
  'js/leaflet.js',
  'js/leaflet.markercluster.js',
  'js/L.Control.Locate.min.js',
  'js/app.js',
  'images/icons/icon-192x192.png',
  'images/icons/icon-stand.png',
  'images/icons/icon-rack.png',
  'images/icons/icon-safeloop.png',
  'images/icons/icon-twotier.png'
];

const DATA_RE = /\/(parking\.json|[^/]+\.geojson|data-meta\.json)$/;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  const keep = [SHELL_CACHE, DATA_CACHE];
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(n => !keep.includes(n)).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // tiles, live APIs: network only

  event.respondWith(DATA_RE.test(url.pathname) ? networkFirst(request) : cacheFirst(request));
});
