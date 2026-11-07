'use strict';
// Test harness: runs the app's inline script in jsdom with Leaflet from node_modules,
// a fake GPS, a fake speech engine and a fetch() that serves canned data for every
// web service the app calls. Nothing here touches the network: any URL that is not
// mocked is rejected and recorded in ctx.unexpected.

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const REPO = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(REPO, 'index.html');
const LEAFLET_JS = path.join(REPO, 'node_modules', 'leaflet', 'dist', 'leaflet.js');

const DEFAULT_START = { lat: 5.3, lon: 100.4 };

// Canned data for the Malaysian POI file (data/index.json + data/t/*.json tiles), as the app expects it.
const DEFAULT_DB = {
  updated: '2026-11-01',
  pois: [
    ['fuel', 5.32, 100.4001, 'Petronas', ''],
    ['shelter', 5.345, 100.4002, '', 'pt'],
    ['cam', 5.35, 100.4001, '', '60'],
    ['fuel', 5.5, 101.5, 'Far away', ''],
  ],
  nomoto: [['Jalan Tol X', [5.36, 100.41, 5.36, 100.42, 5.36, 100.43]]],
};

// Overpass answer used when the test does not ask for bbox-based data.
const FIXED_OVERPASS = [
  { type: 'node', lat: 5.32, lon: 100.4001, tags: { amenity: 'fuel', brand: 'Petronas' } },
  { type: 'node', lat: 5.345, lon: 100.4002, tags: { amenity: 'shelter', shelter_type: 'public_transport' } },
  { type: 'node', lat: 5.35, lon: 100.4001, tags: { highway: 'speed_camera', maxspeed: '60' } },
  { type: 'way', tags: { highway: 'primary', motorcycle: 'no', name: 'Jalan Tol X' },
    geometry: [{ lat: 5.36, lon: 100.41 }, { lat: 5.36, lon: 100.42 }, { lat: 5.36, lon: 100.43 }] },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls fn until it returns a truthy value, or fails after the timeout.
async function waitFor(fn, { timeout = 4000, every = 10, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(every);
  }
}

// Reads index.html and returns the page markup (external scripts and stylesheets
// removed) plus the app's own inline script. The app script is the largest inline
// <script> without a src attribute.
function readAppParts() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const inline = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter((m) => !/\ssrc\s*=/i.test(m[1] || ''))
    .map((m) => m[2]);
  if (!inline.length) throw new Error('index.html has no inline <script>');
  const app = inline.reduce((a, b) => (b.length > a.length ? b : a));
  const page = html
    .replace(/<script\b[^>]*\bsrc\s*=[^>]*><\/script>/gi, '')
    .replace(/<link\b[^>]*\bhref\s*=\s*["']https?:[^>]*>/gi, '');
  return { page, app };
}

// One OSRM step: a list of [lon, lat] points plus its maneuver.
function step(points, type, modifier, name) {
  return { geometry: { coordinates: points }, maneuver: { type, modifier }, name };
}

// Demo route: 6.7 km north on lon 100.40, then 4.4 km east on lat 5.36
// (a right turn onto "Jalan Tol X" at lat 5.36). Two alternatives, same shape.
function demoRoute(summary) {
  const north = [];
  for (let i = 0; i <= 60; i++) north.push([100.4, 5.3 + i * 0.001]);
  const east = [];
  for (let i = 0; i <= 40; i++) east.push([100.4 + i * 0.001, 5.36]);
  return {
    distance: 10000,
    duration: 900,
    legs: [{
      summary,
      steps: [
        step(north, 'depart', null, 'Jalan Utama'),
        step(east, 'turn', 'right', 'Jalan Tol X'),
        step([east[40], east[40]], 'arrive', null, ''),
      ],
    }],
  };
}

// Long route: 120 km straight north on lon 100.40, from lat 5.00 to 6.08.
function longRoute() {
  const pts = [];
  for (let i = 0; i <= 1080; i++) pts.push([100.4, 5.0 + i * 0.001]);
  return {
    distance: 120000,
    duration: 7200,
    legs: [{
      summary: 'Lebuh Raya Utara Selatan',
      steps: [
        step(pts, 'depart', null, 'Lebuh Raya Utara Selatan'),
        step([pts[1080], pts[1080]], 'arrive', null, ''),
      ],
    }],
  };
}

const jsonOk = (body) => ({ ok: true, status: 200, json: async () => body });
// Valhalla answer: shape is a polyline6 string, maneuvers index into it.
function enc6(pts) {
  let la = 0, lo = 0, out = '';
  const put = (v) => { v = v < 0 ? ~(v << 1) : v << 1; while (v >= 32) { out += String.fromCharCode((32 | (v & 31)) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
  for (const [a, b] of pts) { const x = Math.round(a * 1e6), y = Math.round(b * 1e6); put(x - la); put(y - lo); la = x; lo = y; }
  return out;
}
function valTrip(km, toll) {
  const pts = []; for (let i = 0; i <= 60; i++) pts.push([5.3 + i * 0.001, 100.4]);
  return { status: 0, summary: { length: km, time: km * 90, has_toll: toll, has_highway: toll },
    legs: [{ shape: enc6(pts), maneuvers: [
      { type: 1, begin_shape_index: 0, end_shape_index: 60, street_names: [toll ? 'E1/Lebuhraya Utara–Selatan' : 'Jalan Biasa'], length: km, toll },
      { type: 4, begin_shape_index: 60, length: 0 } ] }] };
}
const notFound = () => ({ ok: false, status: 404, json: async () => { throw new SyntaxError('not found'); } });

/**
 * Boots index.html in jsdom with every network service mocked.
 *
 * Options:
 *   rider          motorcycle mode on (default false)
 *   withDB         serve data/my-pois.json; false makes it 404 (default true)
 *   overpassFails  true: every Overpass request fails. Function (n, url) => bool:
 *                  decides per request, n = 0-based Overpass request counter
 *   rainAt         fraction (0..1) of the route where rain starts; > 1 means dry (default 0.8)
 *   route          'demo' (default, 11 km with a turn) or 'long' (120 km straight)
 *   overpass       'fixed' (default) or 'bbox' (one fuel stop and one camera per query box)
 *   cameras        body served for data/cameras.json (default: 404, i.e. no camera data)
 *   start          {lat, lon} of the GPS fix before the test starts (default 5.3, 100.4)
 *   storage        {key: value} saved in localStorage before the app starts, under the s9_ prefix
 *
 * Returns a context object. Call ctx.close() when done (the app has timers).
 */
async function bootApp(opts = {}) {
  const cfg = {
    rider: false, withDB: true, overpassFails: false, rainAt: 0.8,
    route: 'demo', overpass: 'fixed', start: DEFAULT_START, ...opts, storage: { cartoon: false, ...(opts.storage || {}) },
  };
  const parts = readAppParts();
  const app = parts.app;
  const page = typeof cfg.transformPage === 'function' ? cfg.transformPage(parts.page) : parts.page;

  const said = [];
  const calls = [];
  const unexpected = [];
  const errors = [];
  let overpassCount = 0;
  let dbFetches = 0;
  let cameraFetches = 0;
  const ttCalls = [];
  const valBodies = [];

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const dom = new JSDOM(page, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://example.org/',
    virtualConsole,
  });
  const w = dom.window;

  const ok = (body) => jsonOk(body);
  const serveRoutes = () => (cfg.route === 'long' ? [longRoute()] : [demoRoute('Laluan A'), demoRoute('Laluan B')]);

  w.fetch = async (url, opt = {}) => {
    calls.push({ url, method: (opt && opt.method) || 'GET' });
    const now = Date.now() / 1000;

    if (url.includes('rainviewer.com')) {
      return ok({ host: 'https://tilecache.rainviewer.com', radar: { past: [{ time: now, path: '/v2/radar/x' }] } });
    }
    if (url.includes('valhalla1.openstreetmap.de')) {
      if (!cfg.valhalla) return notFound();
      const body = JSON.parse(opt.body);
      valBodies.push(body);
      const noToll = Object.values(body.costing_options)[0].use_tolls === 0;
      return ok(noToll ? { trip: valTrip(9.5, false) } : { trip: valTrip(6.7, true), alternates: [{ trip: valTrip(7.4, true) }] });
    }
    if (url.includes('project-osrm.org')) {
      return ok({ code: 'Ok', routes: serveRoutes() });
    }
    if (url.includes('open-meteo.com')) {
      const n = decodeURIComponent(url.match(/latitude=([^&]+)/)[1]).split(',').length;
      // Quarter-hour slots starting at the next quarter hour, as Open-Meteo returns them.
      const slots = Array.from({ length: 48 }, (_, i) => Math.ceil(now / 900) * 900 + i * 900);
      return ok(Array.from({ length: n }, (_, k) => {
        const wet = n > 1 && k / (n - 1) >= cfg.rainAt;
        return { minutely_15: { time: slots, precipitation: slots.map((_, i) => (wet && i < 3 ? 2.5 : 0)) } };
      }));
    }
    if (url.includes('overpass')) {
      const n = overpassCount++;
      const fail = typeof cfg.overpassFails === 'function' ? cfg.overpassFails(n, url) : cfg.overpassFails;
      if (fail) throw new TypeError(`test: Overpass request ${n} fails`);
      if (cfg.overpass === 'bbox') {
        const q = decodeURIComponent(String(opt.body || '').replace(/^data=/, ''));
        const m = q.match(/bbox:([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)/);
        const [s, , nLat] = m.slice(1).map(Number);
        const lat = (s + nLat) / 2;
        return ok({ elements: [
          { type: 'node', id: 1000 + n, lat, lon: 100.4002, tags: { amenity: 'fuel', brand: 'Shell' } },
          { type: 'node', id: 2000 + n, lat: lat + 0.01, lon: 100.4001, tags: { highway: 'speed_camera', maxspeed: '90' } },
        ] });
      }
      return ok({ elements: FIXED_OVERPASS });
    }
    if (url.includes('api.tomtom.com/routing')) {
      ttCalls.push(url);
      return ok({ routes: [{ summary: { travelTimeInSeconds: 3000, trafficDelayInSeconds: 600, noTrafficTravelTimeInSeconds: 2400 } }] });
    }
    if (url.includes('photon.komoot.io')) {
      return ok({ features: [{ geometry: { coordinates: [100.44, 5.36] }, properties: { name: 'Gurney Plaza', city: 'George Town' } }] });
    }
    if (url.includes('data/places/index.json')) {
      return cfg.places ? ok({ v: 1, keys: Object.fromEntries(Object.keys(cfg.places).map((k) => [k, cfg.places[k].length])) }) : notFound();
    }
    if (/data\/places\/[a-z0-9]+\.json/.test(url)) {
      const k = url.match(/places\/([a-z0-9]+)\.json/)[1];
      return cfg.places && cfg.places[k] ? ok(cfg.places[k]) : notFound();
    }
    if (url.includes('data/cameras.json')) {
      cameraFetches++;
      return cfg.cameras ? ok(cfg.cameras) : notFound();
    }
    if (url.includes('data/plus-fares.json')) {
      return ok(JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'plus-fares.json'), 'utf8')));
    }
    if (url.includes('data/tolls.json')) {
      return ok(JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'tolls.json'), 'utf8')));
    }
    if (url.includes('data/index.json')) {
      return cfg.withDB ? ok({ updated: DEFAULT_DB.updated, tiles: { '5_100': 5 } }) : notFound();
    }
    if (url.includes('data/t/')) {
      dbFetches++;
      return cfg.withDB && url.includes('5_100') ? ok({ pois: DEFAULT_DB.pois, nomoto: DEFAULT_DB.nomoto }) : notFound();
    }
    unexpected.push(url);
    throw new TypeError(`test: blocked network request to ${url}`);
  };

  // Fake GPS: the app's watchPosition callback is captured so tests can move the dot.
  w.navigator.geolocation = {
    watchPosition(success) { w.__pos = success; return 1; },
    clearWatch() {},
  };
  // Fake speech engine: records what the app says.
  w.speechSynthesis = { getVoices: () => [], cancel() {}, speak(u) { said.push(u.text); } };
  w.SpeechSynthesisUtterance = function Utterance(text) { this.text = text; };

  if (typeof cfg.beforeBoot === 'function') cfg.beforeBoot(w); // e.g. inject a fake Capacitor

  if (cfg.rider) w.localStorage.setItem('s9_rider', 'true');
  w.localStorage.setItem('s9_tomtom', JSON.stringify('')); // tests must not use the built-in key
  for (const [k, v] of Object.entries(cfg.storage)) w.localStorage.setItem(`s9_${k}`, JSON.stringify(v));

  // Leaflet comes from node_modules instead of the CDN <script> that was stripped.
  w.eval(fs.readFileSync(LEAFLET_JS, 'utf8'));

  // The app's top-level functions and constants are not globals (the script is strict),
  // so expose the few internals the tests need by appending one line to the same script.
  w.eval(`${app}\n;window.__app={native,PLACES_BASE,REMOTE_DATA_BASE,map,geocode,plusFare,estToll,setTollD:(d)=>{tollD=d},S,st,T,trivial,instr,dedupePlaces,LOG,logEv,buildReport,waUrl,fmtLog,store,TH,sunTimes,applyTheme,setBase,CARTOON,setCartoon,MAP_THEMES,cartoonPal,meS,SC,setAvatar,storeFace,faceCrop,setRouteColor,routeCols,openLook,drawMe,get routeLayer(){return routeLayer}};\n;window.__app.rel=relApi();`);
  w.__said = said;

  const ctx = {
    window: w,
    document: w.document,
    app: w.__app,
    said,
    calls,
    unexpected,
    errors,
    sleep,
    waitFor,
    get overpassCalls() { return overpassCount; },
    get dbFetches() { return dbFetches; },
    get cameraFetches() { return cameraFetches; },
    ttCalls,
    valBodies,
    setPos(lat, lon, speed = 10) {
      if (!w.__pos) return; // native boot: no browser GPS
      w.__pos({ coords: { latitude: lat, longitude: lon, accuracy: 10, speed, heading: 0 }, timestamp: Date.now() });
    },
    // Types a destination, picks the first suggestion and waits for the route cards.
    async search(text) {
      const input = w.document.querySelector('#qDest');
      input.value = text;
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      const item = await waitFor(() => w.document.querySelector('.si[data-i="0"]'), { what: 'a search suggestion' });
      item.click();
      await waitFor(() => w.document.querySelector('.rc'), { what: 'route cards' });
    },
    // The selected route, once it has its along-route POIs (and rain, in motorcycle mode).
    async routeReady() {
      return waitFor(() => {
        const r = w.__app.st.routes[w.__app.st.sel];
        if (!r || !Array.isArray(r.pois)) return null;
        if (w.__app.S.rider && (!r.rain || r.rain === 'loading')) return null;
        return r;
      }, { what: 'route POIs to load' });
    },
    close() { w.close(); },
  };

  ctx.setPos(cfg.start.lat, cfg.start.lon);
  await sleep(5); // let the boot code's first callbacks run
  return ctx;
}

// Runs fn with a freshly booted app and always closes it afterwards.
async function withApp(opts, fn) {
  const ctx = await bootApp(opts);
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

module.exports = { bootApp, withApp, waitFor, sleep, DEFAULT_DB, FIXED_OVERPASS };
