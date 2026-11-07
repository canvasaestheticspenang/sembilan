// Sembilan service worker: keeps the app shell, Leaflet, icons, the POI file and
// map tiles available offline. Routing, search, Overpass, weather and radar
// requests are never intercepted; POST and other non-GET requests are never cached.

const VERSION = 's9-v20';
const PREFIX = 'sembilan-';
const SHELL_CACHE = `${PREFIX}${VERSION}-shell`;
const DATA_CACHE = `${PREFIX}${VERSION}-data`;
const TILE_CACHE = `${PREFIX}${VERSION}-tiles`;
const MAX_TILES = 800;

// Relative to this file, so the app works under the /sembilan/ sub-path.
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png'];
const INDEX_URL = new URL('./index.html', self.location.href).href;

const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';

const TILE_HOSTS = ['server.arcgisonline.com', 'tile.openstreetmap.org'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const urls = [...SHELL.map((p) => new URL(p, self.location.href).href), LEAFLET_CSS, LEAFLET_JS];
    // Best effort: a failed download must not stop the worker from installing.
    await Promise.all(urls.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
      } catch (err) {
        // Offline during install; the file is cached on first use instead.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE, TILE_CACHE]);
    for (const key of await caches.keys()) {
      // Only touch this app's caches; the origin is shared with other GitHub Pages sites.
      if (key.startsWith(PREFIX) && !keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // App page: network first so updates show immediately when online.
    if (req.mode === 'navigate') {
      event.respondWith(networkFirst(req, SHELL_CACHE, INDEX_URL));
      return;
    }
    if (/\/data\/(index\.json|tolls\.json|plus-fares\.json|places\/[a-z0-9]+\.json|t\/[\d_-]+\.json)$/.test(url.pathname)) {
      event.respondWith(networkFirst(req, DATA_CACHE));
      return;
    }
    if (/\/icon[^/]*\.(png|svg)$/.test(url.pathname)) {
      event.respondWith(cacheFirst(req, SHELL_CACHE));
      return;
    }
    return;
  }

  if (url.hostname === 'cdnjs.cloudflare.com' && url.pathname.startsWith('/ajax/libs/leaflet/')) {
    event.respondWith(cacheFirst(req, SHELL_CACHE));
    return;
  }

  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(tileCacheFirst(req));
    return;
  }
  // Anything else (routing, geocoding, Overpass, weather, radar) goes straight to the network.
});

async function networkFirst(req, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req, { cache: 'no-cache' }); // revalidate: GitHub Pages caches pages for 10 min
    if (res.ok) cache.put(req.url, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = (await cache.match(req.url, { ignoreSearch: true }))
      || (fallbackUrl ? await cache.match(fallbackUrl) : undefined);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await corsFetch(req);
  if (res.ok) cache.put(req.url, res.clone()).catch(() => {});
  return res;
}

async function tileCacheFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await corsFetch(req);
  // Only cache real successes: opaque responses can hide errors and cost
  // several MB each against the browser's storage quota.
  if (res.ok) {
    cache.put(req.url, res.clone())
      .then(() => trimCache(TILE_CACHE, MAX_TILES))
      .catch(() => {});
  }
  return res;
}

// Cross-origin files (Leaflet CDN, Esri and OSM tiles) all send CORS headers,
// so fetch them in cors mode to get a readable status; fall back to the
// original request (not cached) if that fails.
async function corsFetch(req) {
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  if (sameOrigin) return fetch(req);
  try {
    return await fetch(req.url, { mode: 'cors', credentials: 'omit' });
  } catch (err) {
    return fetch(req);
  }
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys(); // insertion order, so the first entries are the oldest
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}
