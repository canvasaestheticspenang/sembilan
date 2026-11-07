'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp, waitFor } = require('./helpers.js');

const TIMEOUT = 20000;
const HOUR = 3600e3;
const osrmCalls = (ctx) => ctx.calls.filter((c) => c.url.includes('project-osrm.org')).length;

// Starts navigation on the demo route and returns the saved trip records.
async function startTrip(ctx) {
  await ctx.search('gurney');
  await ctx.routeReady();
  ctx.document.querySelector('#btnStart').click();
  await waitFor(() => ctx.app.st.nav, { what: 'navigation to start' });
  const ls = ctx.window.localStorage;
  return { trip: JSON.parse(ls.getItem('s9_trip')), tripP: JSON.parse(ls.getItem('s9_tripP')) };
}

describe('trip persistence and resume', () => {
  it('saves the active route on start, round-trips it, and clears it when navigation ends', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: true }, async (ctx) => {
      const { trip } = await startTrip(ctx);
      assert.equal(trip.v, 1);
      assert.equal(trip.dest.name, 'Gurney Plaza');
      assert.ok(trip.r.c.length > 50 && trip.r.steps.length === 3, 'geometry and steps are stored');
      assert.ok(!trip.r.steps.some((s) => 'geometry' in s), 'bulky step geometry is not stored');
      const r = ctx.app.rel.relUnpack(trip);
      const orig = ctx.app.st.nav.r;
      assert.equal(r.coords.length, orig.coords.length);
      assert.ok(Math.abs(r.total - orig.total) < 5, 'total length is rebuilt from the geometry');
      assert.equal(r.steps[1].maneuver.modifier, 'right');
      assert.equal(r.steps[1].name, 'Jalan Tol X');
      ctx.document.querySelector('#btnEnd').click();
      assert.equal(ctx.window.localStorage.getItem('s9_trip'), null);
      assert.equal(ctx.window.localStorage.getItem('s9_tripP'), null);
    });
  });

  it('progress is saved (throttled) as the rider moves', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await startTrip(ctx);
      ctx.setPos(5.33, 100.4);
      ctx.app.st.nav.relT = 0;
      ctx.setPos(5.331, 100.4); // progress is written at the start of a tick, from the previous fix
      const p = JSON.parse(ctx.window.localStorage.getItem('s9_tripP'));
      assert.ok(p.last > 20, 'progress index follows the rider');
      ctx.app.st.nav.relT = Date.now();
      const before = ctx.window.localStorage.getItem('s9_tripP');
      ctx.setPos(5.34, 100.4);
      assert.equal(ctx.window.localStorage.getItem('s9_tripP'), before, 'no write within the throttle window');
    });
  });

  it('after a reload offers to resume, and Resume restarts navigation with the saved route and no network', { timeout: TIMEOUT }, async () => {
    let saved;
    await withApp({}, async (ctx) => { saved = await startTrip(ctx); });
    await withApp({ storage: saved, start: { lat: 5.32, lon: 100.4 } }, async (ctx) => {
      const btn = await waitFor(() => ctx.document.querySelector('#rsYes'), { what: 'the resume prompt', timeout: 6000 });
      assert.match(ctx.document.querySelector('#modal').textContent, /Gurney Plaza/);
      const before = ctx.calls.length;
      btn.click();
      await waitFor(() => ctx.app.st.nav, { what: 'navigation to resume' });
      assert.equal(ctx.app.st.dest.name, 'Gurney Plaza');
      assert.ok(ctx.app.st.nav.last > 15, 'progress is recomputed from the GPS position');
      assert.equal(osrmCalls(ctx), 0, 'no routing request was needed');
      assert.equal(ctx.calls.slice(before).filter((c) => /valhalla|osrm|photon/.test(c.url)).length, 0);
      assert.ok(ctx.document.querySelector('#nText').textContent.length > 0, 'turn instruction is shown');
    });
  });

  it('Discard clears the saved trip', { timeout: TIMEOUT }, async () => {
    let saved;
    await withApp({}, async (ctx) => { saved = await startTrip(ctx); });
    await withApp({ storage: saved }, async (ctx) => {
      (await waitFor(() => ctx.document.querySelector('#rsNo'), { what: 'the resume prompt', timeout: 6000 })).click();
      assert.equal(ctx.window.localStorage.getItem('s9_trip'), null);
      assert.equal(ctx.app.st.nav, null);
    });
  });

  it('does not prompt for a trip older than 3 hours, or when the rider is far from the route', { timeout: TIMEOUT }, async () => {
    let saved;
    await withApp({}, async (ctx) => { saved = await startTrip(ctx); });
    const old = { trip: { ...saved.trip, t: Date.now() - 4 * HOUR }, tripP: { ...saved.tripP, t: Date.now() - 4 * HOUR } };
    await withApp({ storage: old }, async (ctx) => {
      await ctx.sleep(700);
      assert.equal(ctx.document.querySelector('#rsYes'), null);
      assert.equal(ctx.window.localStorage.getItem('s9_trip'), null, 'expired trip is dropped');
    });
    await withApp({ storage: saved, start: { lat: 5.5, lon: 101.5 } }, async (ctx) => {
      await ctx.sleep(700);
      assert.equal(ctx.document.querySelector('#rsYes'), null);
    });
  });

  it('relFresh: age window and validation (pure)', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const { trip } = await startTrip(ctx);
      const { relFresh, relValid } = ctx.app.rel;
      const t = trip.t;
      assert.ok(relFresh(trip, null, t + 2.9 * HOUR));
      assert.ok(!relFresh(trip, null, t + 3.1 * HOUR));
      assert.ok(relFresh(trip, { t: t + 2 * HOUR }, t + 4 * HOUR), 'progress updates keep the trip alive');
      assert.ok(!relValid(null) && !relValid({ v: 1 }) && !relValid({ ...trip, r: { ...trip.r, c: [[1, 2]] } }));
    });
  });
});

describe('reroute guard', () => {
  it('relDecide: debounce, 8 s spacing, backoff, offline, poor GPS', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const { relDecide, relBackoff } = ctx.app.rel;
      const base = { off: 3, lastRe: 0, now: 100000, acc: 10, online: true, fails: 0, busy: false };
      assert.equal(relDecide(base), 'reroute');
      assert.equal(relDecide({ ...base, off: 2 }), 'wait', 'needs 3 consecutive off-route fixes');
      assert.equal(relDecide({ ...base, acc: 61 }), 'ignore', 'poor GPS accuracy is ignored');
      assert.equal(relDecide({ ...base, acc: 60 }), 'reroute');
      assert.equal(relDecide({ ...base, busy: true }), 'wait', 'one request in flight at a time');
      assert.equal(relDecide({ ...base, lastRe: 100000 - 7999 }), 'wait', 'at most one request per 8 s');
      assert.equal(relDecide({ ...base, lastRe: 100000 - 8000 }), 'reroute');
      assert.equal(relDecide({ ...base, online: false }), 'offline');
      assert.equal(relDecide({ ...base, fails: 2, lastRe: 100000 - 10000 }), 'wait', 'backoff after failures');
      assert.equal(relDecide({ ...base, fails: 2, lastRe: 100000 - 16000 }), 'reroute');
      assert.deepEqual([0, 1, 2, 3, 4, 5, 99].map(relBackoff), [0, 8000, 16000, 30000, 60000, 120000, 120000]);
    });
  });

  it('ignores off-route fixes with accuracy over 60 m', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await startTrip(ctx);
      const n0 = osrmCalls(ctx);
      for (let i = 0; i < 6; i++) {
        ctx.window.__pos({ coords: { latitude: 5.31, longitude: 100.41, accuracy: 120, speed: 10, heading: 0 }, timestamp: Date.now() });
      }
      await ctx.sleep(30);
      assert.equal(ctx.app.st.nav.off, 0);
      assert.equal(osrmCalls(ctx), n0);
    });
  });

  it('a burst of off-route fixes sends one reroute request, not a storm', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await startTrip(ctx);
      const n0 = osrmCalls(ctx);
      for (let i = 0; i < 12; i++) ctx.setPos(5.31, 100.41);
      await waitFor(() => osrmCalls(ctx) > n0, { what: 'one reroute request' });
      for (let i = 0; i < 12; i++) ctx.setPos(5.311, 100.41);
      await ctx.sleep(50);
      assert.equal(osrmCalls(ctx), n0 + 1);
    });
  });

  it('offline: no routing request, a banner and one voice message, then recovers when back online', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await startTrip(ctx);
      const nav = ctx.window.navigator;
      Object.defineProperty(nav, 'onLine', { value: false, configurable: true });
      const n0 = osrmCalls(ctx), said0 = ctx.said.length;
      for (let i = 0; i < 8; i++) ctx.setPos(5.31, 100.41);
      await ctx.sleep(30);
      assert.equal(osrmCalls(ctx), n0, 'no reroute request while offline');
      const b = ctx.document.querySelector('#relBanner');
      assert.ok(b && !b.classList.contains('hidden'));
      assert.match(b.textContent, /Tiada internet/, 'Malay banner (default language)');
      assert.equal(ctx.said.slice(said0).filter((x) => /Tiada sambungan/.test(x)).length, 1, 'spoken once');
      ctx.app.S.lang = 'en';
      ctx.app.st.nav.reOff = 0;
      ctx.setPos(5.31, 100.41);
      assert.match(b.textContent, /Offline: can't reroute/);
      Object.defineProperty(nav, 'onLine', { value: true, configurable: true });
      ctx.window.dispatchEvent(new ctx.window.Event('online'));
      ctx.setPos(5.31, 100.41);
      await waitFor(() => osrmCalls(ctx) > n0, { what: 'reroute once online' });
      await waitFor(() => b.classList.contains('hidden'), { what: 'banner to clear after reroute' });
    });
  });

  it('a failed reroute backs off and shows the retry message', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await startTrip(ctx);
      const realFetch = ctx.window.fetch;
      let fail = true;
      ctx.window.fetch = (u, o) => (fail && /osrm|valhalla/.test(u) ? Promise.reject(new TypeError('net')) : realFetch(u, o));
      for (let i = 0; i < 4; i++) ctx.setPos(5.31, 100.41);
      await waitFor(() => ctx.app.st.nav.reFail >= 1, { what: 'reroute failure recorded' });
      const b = ctx.document.querySelector('#relBanner');
      assert.ok(!b.classList.contains('hidden'));
      const calls = ctx.calls.length;
      for (let i = 0; i < 6; i++) ctx.setPos(5.31, 100.41);
      await ctx.sleep(30);
      assert.equal(ctx.calls.length, calls, 'no immediate retry (backoff)');
      fail = false;
    });
  });
});

describe('navigation without network', () => {
  it('turn instructions, progress and the grey passed line keep working when every request fails', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: true }, async (ctx) => {
      await startTrip(ctx);
      ctx.window.fetch = () => Promise.reject(new TypeError('offline'));
      Object.defineProperty(ctx.window.navigator, 'onLine', { value: false, configurable: true });
      for (const lat of [5.31, 5.33, 5.355]) ctx.setPos(lat, 100.4);
      await ctx.sleep(20);
      assert.ok(ctx.app.st.nav.last > 50);
      assert.match(ctx.document.querySelector('#nText').textContent, /./);
      assert.ok(ctx.app.st.nav.done.getLatLngs().length > 50, 'passed route is drawn');
      assert.deepEqual(ctx.errors, [], 'no page errors');
    });
  });
});

describe('JS error capture', () => {
  it('records message and file:line, dedupes repeats, and the report lists recent errors even after many other events', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      ctx.window.eval("setTimeout(() => { throw new Error('boom rel'); }, 0)");
      await waitFor(() => ctx.app.LOG.some((e) => e.k === 'err' && e.m === 'boom rel'), { what: 'error in log' });
      for (let i = 0; i < 40; i++) ctx.app.logEv('say', { x: `s${i}` });
      const rep = ctx.app.buildReport('x', 'y');
      assert.match(rep, /err m=boom rel/, 'old error still reported');
      const ev = new ctx.window.Event('unhandledrejection');
      ev.reason = new Error('rejected rel');
      ctx.window.dispatchEvent(ev);
      ctx.window.dispatchEvent(ev);
      assert.equal(ctx.app.LOG.filter((e) => e.m === 'rejected rel').length, 1, 'immediate repeat is dropped');
      assert.equal(ctx.app.rel.relErrInfo({ message: 'plain', filename: 'https://x/app.js', lineno: 4, colno: 7 }).at, 'app.js:4:7');
      assert.ok(ctx.app.buildReport('', '').split('\n').filter((l) => /^\d\d:\d\d:\d\d /.test(l)).length <= 30);
    });
  });
});
