// Sembilan service worker: keeps the app shell, Leaflet, icons, the POI file and
// viewed map tiles (raster Esri/OSM and OpenFreeMap vector tiles, ~300, LRU) available offline. Routing, search, Overpass, weather and radar
// requests are never intercepted; POST and other non-GET requests are never cached.

const VERSION = 's9-v26';
const PREFIX = 'sembilan-';
const SHELL_CACHE = `${PREFIX}${VERSION}-shell`;
const DATA_CACHE = `${PREFIX}${VERSION}-data`;
const TILE_CACHE = `${PREFIX}${VERSION}-tiles`;
const META_CACHE = `${PREFIX}${VERSION}-meta`;
const MAX_TILES = 300; // bounded LRU of viewed map tiles (raster and vector)
const NAV_TIMEOUT_MS = 4000; // slow network on the app page: fall back to the cached copy

// Relative to this file, so the app works under the /sembilan/ sub-path.
// Must all download or the install fails (the previous worker then keeps serving).
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png'];
// Nice to have offline; a failure here never blocks the install.
const EXTRA = ['./icon-512.png', './icon-maskable-512.png', './panduan.html', './data/tolls.json', './data/plus-fares.json'];
const INDEX_URL = new URL('./index.html', self.location.href).href;

const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';

const TILE_HOSTS = ['server.arcgisonline.com', 'tile.openstreetmap.org'];
const OFM_HOST = 'tiles.openfreemap.org';
const LIB_HOSTS = ['unpkg.com']; // MapLibre for the cartoon map (versioned URLs, immutable)
// Routing, search, traffic, weather and radar answers are never stored.
const NEVER_CACHE_HOSTS = ['valhalla1.openstreetmap.de', 'router.project-osrm.org', 'photon.komoot.io', 'nominatim.openstreetmap.org',
  'api.tomtom.com', 'overpass-api.de', 'overpass.kumi.systems', 'api.open-meteo.com', 'api.rainviewer.com', 'tilecache.rainviewer.com'];

// Pure helpers (also unit-tested). kind: 'tile' (cache-first, LRU), 'meta' (map style/sprites/fonts: network-first),
// 'lib' (cache-first, unbounded but tiny), or null (not handled).
function classifyCross(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return null; }
  const h = u.hostname;
  if (NEVER_CACHE_HOSTS.includes(h) || /overpass/.test(h)) return null;
  if (h === 'cdnjs.cloudflare.com' && u.pathname.startsWith('/ajax/libs/leaflet/')) return 'lib';
  if (LIB_HOSTS.includes(h) && /maplibre/.test(u.pathname)) return 'lib';
  if (TILE_HOSTS.includes(h)) return 'tile';
  if (h === OFM_HOST) return /\.(pbf|mvt|png|jpe?g|webp)$/.test(u.pathname) ? 'tile' : 'meta';
  return null;
}
// Which tile URLs to delete so at most `max` remain; `keys` is oldest first.
function lruVictims(keys, max) { return keys.length > max ? keys.slice(0, keys.length - max) : []; }

async function fetchOk(url, tries) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok) return res;
      last = new Error('HTTP ' + res.status);
    } catch (err) { last = err; }
  }
  throw last;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const abs = (p) => new URL(p, self.location.href).href;
    // The app shell is required: retried, and the install fails if it cannot be stored.
    await Promise.all(SHELL.map(async (p) => { const u = abs(p); await cache.put(u, await fetchOk(u, 3)); }));
    // Leaflet and the extras are best effort (cached on first use otherwise).
    await Promise.all([LEAFLET_CSS, LEAFLET_JS, ...EXTRA.map(abs)].map(async (u) => {
      try { await cache.put(u, await fetchOk(u, 2)); } catch (err) { /* offline during install */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, DATA_CACHE, TILE_CACHE, META_CACHE]);
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
  if (url.origin !== self.location.origin && NEVER_CACHE_HOSTS.includes(url.hostname)) return;

  if (url.origin === self.location.origin) {
    // App page: network first so updates show immediately when online.
    if (req.mode === 'navigate') {
      event.respondWith(networkFirst(req, SHELL_CACHE, INDEX_URL, NAV_TIMEOUT_MS));
      return;
    }
    if (/\/data\/(index\.json|tolls\.json|plus-fares\.json|cameras\.json|places\/[a-z0-9]+\.json|t\/[\d_-]+\.json)$/.test(url.pathname)) {
      event.respondWith(networkFirst(req, DATA_CACHE));
      return;
    }
    if (/\/icon[^/]*\.(png|svg)$/.test(url.pathname)) {
      event.respondWith(cacheFirst(req, SHELL_CACHE));
      return;
    }
    return;
  }

  const kind = classifyCross(req.url);
  if (kind === 'lib') { event.respondWith(cacheFirst(req, SHELL_CACHE)); return; }
  if (kind === 'tile') { event.respondWith(tileCacheFirst(req)); return; }
  if (kind === 'meta') { event.respondWith(networkFirst(req, META_CACHE, undefined, 5000)); return; }
  // Anything else (routing, geocoding, Overpass, weather, radar) goes straight to the network.
});

async function networkFirst(req, cacheName, fallbackUrl, timeoutMs) {
  const cache = await caches.open(cacheName);
  const cached = async () => (await cache.match(req.url, { ignoreSearch: true }))
    || (fallbackUrl ? await cache.match(fallbackUrl) : undefined);
  try {
    let net = fetchRevalidate(req);
    if (timeoutMs) {
      const hit = await cached();
      if (hit) { // only race against the clock when there is something to fall back to
        net.catch(() => {}); // a late failure must not be unhandled
        const slow = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
        const res = await Promise.race([net, slow]);
        if (!res) { net.then((r) => { if (r.ok) cache.put(req.url, r.clone()).catch(() => {}); }).catch(() => {}); return hit; }
        net = Promise.resolve(res);
      }
    }
    const res = await net;
    if (res.ok) cache.put(req.url, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cached();
    if (hit) return hit;
    throw err;
  }
}

// Revalidate (GitHub Pages caches pages for 10 min); cross-origin map metadata goes through CORS mode.
function fetchRevalidate(req) {
  return new URL(req.url).origin === self.location.origin ? fetch(req, { cache: 'no-cache' }) : corsFetch(req);
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await corsFetch(req);
  if (res.ok) cache.put(req.url, res.clone()).catch(() => {});
  return res;
}

const touched = new Map(); // url -> last time it was moved to the "newest" end of the cache
async function tileCacheFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req.url);
  if (hit) {
    // LRU: cache.keys() is in insertion order, so re-insert a viewed tile (at most once a minute per tile).
    const now = Date.now();
    if (now - (touched.get(req.url) || 0) > 60000) {
      touched.set(req.url, now);
      if (touched.size > 2000) touched.clear();
      const copy = hit.clone();
      cache.delete(req.url).then(() => cache.put(req.url, copy)).catch(() => {});
    }
    return hit;
  }
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
  for (const k of lruVictims(keys.map((r) => r.url), max)) await cache.delete(k);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyCross, lruVictims, trimCache, tileCacheFirst, networkFirst, MAX_TILES, SHELL_CACHE, TILE_CACHE, META_CACHE };
}
