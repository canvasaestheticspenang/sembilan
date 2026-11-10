'use strict';
// Unit tests for sw.js: runs the worker script in a vm with a small fake Cache API and fetch.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
const ORIGIN = 'https://example.org/sembilan/';

function fakeEnv({ failing = () => false } = {}) {
  const stores = new Map();
  const cacheOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (u) => { const k = typeof u === 'string' ? u : u.url; return m.has(k) ? m.get(k).clone() : undefined; },
      put: async (u, res) => { const k = typeof u === 'string' ? u : u.url; m.delete(k); m.set(k, res); },
      delete: async (u) => m.delete(typeof u === 'string' ? u : u.url),
      keys: async () => [...m.keys()].map((url) => ({ url })),
    };
  };
  class Res {
    constructor(body, ok = true, status = 200) { this.body = body; this.ok = ok; this.status = status; }
    clone() { return new Res(this.body, this.ok, this.status); }
  }
  const fetched = [];
  const listeners = {};
  const self = { location: { href: ORIGIN + 'sw.js', origin: 'https://example.org' }, addEventListener: (t, f) => { listeners[t] = f; }, skipWaiting() {}, clients: { claim: async () => {} } };
  const ctx = vm.createContext({
    self, URL, Promise, setTimeout, clearTimeout, Date, Map, module: { exports: {} },
    caches: { open: async (n) => cacheOf(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) },
    fetch: async (u) => {
      const url = typeof u === 'string' ? u : u.url;
      fetched.push(url);
      if (failing(url)) throw new TypeError('offline');
      return new Res('body:' + url);
    },
  });
  vm.runInContext(SRC, ctx);
  const send = (url, extra = {}) => {
    let p; listeners.fetch({ request: { method: 'GET', url, mode: 'cors', ...extra }, respondWith: (x) => { p = x; } });
    return p;
  };
  return { sw: ctx.module.exports, stores, fetched, listeners, send, Res };
}

const TILE = 'https://tiles.openfreemap.org/planet/20260101_001001_pt/14/12975/8174.pbf';

describe('service worker', () => {
  it('classifies URLs: tiles cached, routing/search/weather never', () => {
    const { sw } = fakeEnv();
    const c = sw.classifyCross;
    assert.equal(c('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/1/2'), 'tile');
    assert.equal(c('https://tile.openstreetmap.org/15/1/2.png'), 'tile');
    assert.equal(c(TILE), 'tile');
    assert.equal(c('https://tiles.openfreemap.org/styles/bright'), 'meta');
    assert.equal(c('https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf'), 'tile', 'glyph pbf is also bounded');
    assert.equal(c('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js'), 'lib');
    assert.equal(c('https://unpkg.com/other/x.js'), null);
    for (const u of ['https://valhalla1.openstreetmap.de/route', 'https://router.project-osrm.org/route/v1/driving/1,2;3,4',
      'https://photon.komoot.io/api/?q=x', 'https://overpass-api.de/api/interpreter', 'https://api.open-meteo.com/v1/forecast',
      'https://api.tomtom.com/routing/1/calculateRoute/x', 'https://api.rainviewer.com/public/weather-maps.json']) {
      assert.equal(c(u), null, u);
    }
  });

  it('rider data: small files stay fresh, big ones answer from the saved copy at once', async () => {
    const { sw } = fakeEnv();
    const c = sw.classifyData;
    for (const f of ['index.json', 'cameras.json', 'tolls.json', 'plus-fares.json']) assert.equal(c('/sembilan/data/' + f), 'fresh', f);
    for (const f of ['landmarks.json', 'places/0a1.json', 't/5_100.json', 'cat/fuel/5_100.json']) assert.equal(c('/sembilan/data/' + f), 'fast', f);
    assert.equal(c('/sembilan/data/secret.txt'), null);
    assert.equal(c('/sembilan/index.html'), null);
  });

  it('saved data and tiles are kept across app updates', () => {
    const { sw } = fakeEnv();
    assert.doesNotMatch(sw.DATA_CACHE, /s9-v\d+/);
    assert.doesNotMatch(sw.TILE_CACHE, /s9-v\d+/);
    assert.match(sw.SHELL_CACHE, /s9-v\d+/, 'the app itself is still replaced on update');
  });

  it('after install the landmark, camera and index files are saved; with no signal a saved place shard still answers', async () => {
    let offline = false;
    const e = fakeEnv({ failing: () => offline });
    await e.sw.precacheData();
    const saved = [...e.stores.get(e.sw.DATA_CACHE).keys()];
    for (const f of ['landmarks.json', 'cameras.json', 'index.json']) assert.ok(saved.some((u) => u.endsWith('/data/' + f)), f);
    const shard = 'https://example.org/app/data/places/0a1.json';
    const first = await e.sw.staleWhileRevalidate({ url: shard }, e.sw.DATA_CACHE);
    assert.equal(first.ok, true);
    await new Promise((r) => setTimeout(r, 5));
    offline = true;
    const again = await e.sw.staleWhileRevalidate({ url: shard }, e.sw.DATA_CACHE);
    assert.equal(again.body, 'body:' + shard, 'served from the saved copy with no network');
  });

  it('lruVictims returns the oldest entries beyond the limit', () => {
    const { sw } = fakeEnv();
    assert.deepEqual([...sw.lruVictims(['a', 'b', 'c', 'd'], 3)], ['a']);
    assert.deepEqual([...sw.lruVictims(['a', 'b'], 3)], []);
    assert.equal(sw.MAX_TILES, 600);
  });

  it('install stores the shell; a missing index.html fails the install', async () => {
    const ok = fakeEnv();
    await new Promise((resolve, reject) => ok.listeners.install({ waitUntil: (p) => p.then(resolve, reject) }));
    const shell = ok.stores.get(ok.sw.SHELL_CACHE);
    assert.ok(shell.has(ORIGIN + 'index.html') && shell.has(ORIGIN + 'manifest.webmanifest'));
    assert.ok([...shell.keys()].some((k) => /leaflet\.min\.js$/.test(k)));

    const bad = fakeEnv({ failing: (u) => u.endsWith('/index.html') });
    await assert.rejects(new Promise((resolve, reject) => bad.listeners.install({ waitUntil: (p) => p.then(resolve, reject) })));
    // optional files failing must not block install
    const opt = fakeEnv({ failing: (u) => /tolls\.json|panduan|leaflet/.test(u) });
    await new Promise((resolve, reject) => opt.listeners.install({ waitUntil: (p) => p.then(resolve, reject) }));
  });

  it('vector tiles are cache-first: the second request does not hit the network', async () => {
    const e = fakeEnv();
    await e.send(TILE);
    await new Promise((r) => setTimeout(r, 5));
    const n = e.fetched.length;
    const res = await e.send(TILE);
    assert.equal(res.body, 'body:' + TILE);
    assert.equal(e.fetched.length, n, 'served from cache');
  });

  it('works offline for tiles seen before', async () => {
    let offline = false;
    const e = fakeEnv({ failing: () => offline });
    await e.send(TILE);
    await new Promise((r) => setTimeout(r, 5));
    offline = true;
    assert.equal((await e.send(TILE)).body, 'body:' + TILE);
    await assert.rejects(e.send(TILE.replace('8174', '9999')), 'unseen tile fails (no fake data)');
  });

  it('keeps at most 600 tiles and evicts the least recently used', async () => {
    const e = fakeEnv();
    const url = (i) => `https://tile.openstreetmap.org/15/${i}/1.png`;
    for (let i = 0; i < 600; i++) await e.send(url(i));
    await new Promise((r) => setTimeout(r, 20));
    // touch tile 0 so it becomes the newest
    await e.send(url(0));
    await new Promise((r) => setTimeout(r, 10));
    for (let i = 600; i < 605; i++) { await e.send(url(i)); await new Promise((r) => setTimeout(r, 5)); }
    await new Promise((r) => setTimeout(r, 20));
    const keys = [...e.stores.get(e.sw.TILE_CACHE).keys()];
    assert.equal(keys.length, 600);
    assert.ok(keys.includes(url(0)), 'recently viewed tile survived');
    assert.ok(!keys.includes(url(1)) && !keys.includes(url(5)), 'oldest tiles were evicted');
  });

  it('never intercepts or stores routing, search, weather or non-GET requests', async () => {
    const e = fakeEnv();
    for (const u of ['https://router.project-osrm.org/route/v1/driving/1,2;3,4', 'https://photon.komoot.io/api/?q=x',
      'https://valhalla1.openstreetmap.de/route', 'https://api.open-meteo.com/v1/forecast?x=1', 'https://overpass-api.de/api/interpreter']) {
      assert.equal(e.send(u), undefined, u);
    }
    assert.equal(e.send(TILE, { method: 'POST' }), undefined);
    assert.equal(e.stores.size, 0, 'nothing was cached');
  });
});
