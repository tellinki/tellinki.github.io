/*
 * Tellinki.com service worker.
 *
 * Strategy:
 *  - App shell (HTML/CSS/JS/icons): cache-first, so the app opens offline.
 *  - Data files (parking.json, *.geojson, data-meta.json): network-first,
 *    so fresh data actually reaches users; cache is the offline fallback.
 *  - Map tiles (tile.openstreetmap.de): cache-first with a bounded cache,
 *    so repeat visits render the base map almost instantly. Tiles are
 *    opaque responses; OSM allows reasonable client-side caching.
 *  - Other cross-origin (live city-bike API): straight to network.
 *
 * Bump VERSION when the app shell changes to roll the cache.
 */
const VERSION = 'tellinki-v2.2.4';
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;
const TILE_CACHE = `tiles-${VERSION}`;
const TILE_MAX_ITEMS = 600; // ~a few MB of tiles, trimmed oldest-first
const TILE_HOSTS = ['tile.openstreetmap.de'];

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
  const keep = [SHELL_CACHE, DATA_CACHE, TILE_CACHE];
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

async function trimCache(cacheName, maxItems) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i <= keys.length - maxItems; i++) {
    await cache.delete(keys[i]);
  }
}

async function tileFirst(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Tile <img> requests are no-cors → opaque responses (status 0) are fine.
  if (response.ok || response.type === 'opaque') {
    cache.put(request, response.clone())
      .then(() => trimCache(TILE_CACHE, TILE_MAX_ITEMS))
      .catch(() => {});
  }
  return response;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    if (TILE_HOSTS.includes(url.hostname)) {
      event.respondWith(tileFirst(request));
    }
    return; // everything else cross-origin: network only
  }

  event.respondWith(DATA_RE.test(url.pathname) ? networkFirst(request) : cacheFirst(request));
});
