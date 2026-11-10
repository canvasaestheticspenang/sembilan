'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp } = require('./helpers.js');

const TIMEOUT = 20000;
// A 20 km route predicted at 1800 s (40 km/h). Rides `km` of it at `kmh`, one tick per second.
function trip(P, kmh, km, { stopAt = -1, stopFor = 0, r = { duration: 1800, total: 20000 }, t0 = Date.UTC(2026, 10, 8, 3) } = {}) {
  const n = {}; P.start(n);
  let now = t0, along = 0; const v = kmh / 3.6;
  P.tick(n, r, 0, v, now);
  while (along < km * 1000) {
    if (stopAt >= 0 && along >= stopAt * 1000 && stopFor > 0) { stopFor--; now += 1000; P.tick(n, r, along, 0, now); continue; }
    now += 1000; along += v; P.tick(n, r, along, v, now);
  }
  return { n, r, k: P.end(n) };
}

describe('ETA learns from the rider', () => {
  it('no data: ETA is unchanged', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      assert.equal(ctx.app.PACE.f({ duration: 100, total: 1000 }), 1);
    });
  });

  it('a rider who is consistently 25% faster gets shorter ETAs, eased in with distance', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const P = ctx.app.PACE; const d = new Date(Date.UTC(2026, 10, 8, 3));
      const a = trip(P, 50, 10); // 50 km/h against a 40 km/h prediction
      assert.ok(Math.abs(a.k - 0.8) < 0.01, `ratio ${a.k}`);
      const f1 = P.f(a.r, d);
      assert.ok(f1 < 1 && f1 > 0.9, `after 10 km only part of the correction applies: ${f1}`);
      for (let i = 0; i < 4; i++) trip(P, 50, 10);
      const f2 = P.f(a.r, d);
      assert.ok(Math.abs(f2 - 0.8) < 0.01, `after 50 km the full correction applies: ${f2}`);
      assert.ok(Math.abs(P.dur(a.r, d) - 1440) < 20, '30 min estimate becomes 24 min');
      assert.match(P.sum(), /20% lebih pantas .*5 perjalanan/);
      assert.ok(ctx.app.store.get('pace'), 'saved on the device');
    });
  });

  it('a petrol stop is not counted; a red light is', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const P = ctx.app.PACE;
      const petrol = trip(P, 40, 10, { stopAt: 5, stopFor: 600 });
      assert.ok(Math.abs(petrol.k - 1) < 0.15, `10 min stop mostly ignored: ${petrol.k}`);
      P.clear();
      const light = trip(P, 40, 10, { stopAt: 5, stopFor: 90 });
      assert.ok(light.k > 1.08, `90 s red light counts: ${light.k}`);
    });
  });

  it('short trips and absurd ratios are ignored; the factor is clamped; off and reset work', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const P = ctx.app.PACE; const d = new Date(Date.UTC(2026, 10, 8, 3));
      assert.equal(trip(P, 50, 1).k, null, 'under 2 km');
      assert.equal(trip(P, 160, 10, { r: { duration: 7200, total: 20000 } }).k, null, 'ratio below 0.3');
      for (let i = 0; i < 6; i++) trip(P, 20, 10); // half the predicted speed: ratio 2
      const r = { duration: 1800, total: 20000 };
      assert.ok(P.f(r, d) <= 1.6 + 1e-9, 'never more than +60%');
      P.on = false; assert.equal(P.f(r, d), 1); P.on = true;
      P.clear(); assert.equal(P.f(r, d), 1);
    });
  });

  it('kinds of trip are learned separately', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const P = ctx.app.PACE; const d = new Date(Date.UTC(2026, 10, 8, 3));
      for (let i = 0; i < 5; i++) trip(P, 50, 10);
      assert.ok(P.f({ duration: 1800, total: 20000 }, d) < 0.85);
      assert.equal(P.f({ duration: 1800, total: 20000, hwy: true }, d), 1, 'expressway trips have their own data');
      assert.notEqual(P.key({}, new Date(2026, 10, 9, 8, 0)), P.key({}, new Date(2026, 10, 9, 11, 0)), 'Monday 8 am is rush hour, 11 am is not');
      const keys = Object.keys(P.L.en).sort();
      for (const l of ['ms', 'zh', 'ta']) assert.deepEqual(Object.keys(P.L[l]).sort(), keys, l);
    });
  });

  it('navigation shows the corrected ETA and marks the route card', { timeout: TIMEOUT }, async () => {
    await withApp({ storage: { lang: 'en' } }, async (ctx) => {
      const P = ctx.app.PACE;
      await ctx.search('gurney');
      const r = await ctx.routeReady();
      P.b[P.key(r)] = { k: 0.8, km: 100, n: 9 };
      ctx.document.querySelector('#btnSettings').click(); // any re-render path: reopen the sheet below
      ctx.document.querySelector('#modal').classList.add('hidden');
      ctx.document.querySelector('#btnStart').click();
      ctx.setPos(5.3, 100.4, 10);
      const rem = ctx.app.st.nav.remT;
      assert.ok(Math.abs(rem - r.duration * 0.8) < r.duration * 0.02, `remaining ${rem} vs ${r.duration}`);
    });
  });
});
