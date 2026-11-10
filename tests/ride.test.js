'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp } = require('./helpers.js');

const TIMEOUT = 20000;
// Feeds the ride tracker fixes 1 s apart heading north at ~10 m/s (0.00009 deg latitude is ~10 m).
function ride(R, n, { lat = 5.3, t = 1e12, acc = 10, speed = 10 } = {}) {
  for (let i = 0; i <= n; i++) R.pos({ lat: lat + i * 0.00009, lon: 100.4, acc, speed, t: t + i * 1000 });
}

describe('ride tracker', () => {
  it('counts distance only from trustworthy, moving fixes', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const R = ctx.app.RIDE;
      R.prev = null; R.start('X');
      ride(R, 100);
      assert.ok(Math.abs(R.trip.km - 1.0) < 0.02, `about 1 km, got ${R.trip.km}`);
      assert.equal(Math.round(R.trip.mov), 100, 'moving time is 100 s');
      const km = R.trip.km;
      R.pos({ lat: 6.3, lon: 100.4, acc: 10, speed: 10, t: 1e12 + 101000 }); // 100 km jump in one second
      assert.equal(R.trip.km, km, 'a GPS jump adds nothing');
      R.prev = null; ride(R, 20, { acc: 80 });
      assert.equal(R.trip.km, km, 'poor accuracy adds nothing');
      R.prev = null; ride(R, 20, { speed: 0 });
      assert.equal(R.trip.km, km, 'standing still adds nothing');
    });
  });

  it('ending navigation after a real ride shows the summary card, with no top speed', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const R = ctx.app.RIDE;
      await ctx.search('gurney');
      await ctx.routeReady();
      ctx.document.querySelector('#btnStart').click();
      R.prev = null; ride(R, 100);
      ctx.document.querySelector('#btnEnd').click();
      const sum = ctx.document.querySelector('#rideSum');
      assert.ok(sum, 'summary card is shown');
      assert.ok(!ctx.document.querySelector('#modal').classList.contains('hidden'));
      assert.match(sum.textContent, /1\.0 km/);
      assert.match(sum.textContent, /36 km\/j/, 'average speed in BM units');
      assert.doesNotMatch(ctx.document.querySelector('#modal').textContent, /max|laju tertinggi|top speed/i);
      assert.equal(ctx.app.store.get('rideTotal').n, 1, 'lifetime total is saved');
      assert.deepEqual(ctx.errors.map((e) => e.message), [], 'no page errors');
    });
  });

  it('a trip shorter than 300 m shows no card', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await ctx.search('gurney');
      await ctx.routeReady();
      ctx.document.querySelector('#btnStart').click();
      ctx.document.querySelector('#btnEnd').click();
      assert.equal(ctx.document.querySelector('#rideSum'), null);
    });
  });

  it('fuel: counts down, warns once by voice with the next petrol station, and resets on fill', { timeout: TIMEOUT }, async () => {
    await withApp({ storage: { lang: 'en' } }, async (ctx) => {
      const R = ctx.app.RIDE;
      assert.equal(R.left(), null, 'off until a range is set');
      R.setRange(100); R.prev = null; ride(R, 1000); // ~10 km
      assert.equal(R.left(), 90);
      assert.ok(Math.abs(ctx.app.store.get('fuel').km - 10) < 0.3, 'saved to this device');
      const n = {}; const r = { pois: [{ type: 'fuel', name: 'Petronas', along: 3000 }] };
      const before = ctx.said.length;
      R.navTick(n, r, 0, 50000); // 50 km to go, 90 km of fuel
      assert.equal(ctx.said.length, before, 'no warning when fuel is enough');
      R.navTick(n, r, 0, 120000); // 120 km to go
      assert.equal(ctx.said.length, before + 1);
      assert.match(ctx.said.at(-1), /Fuel for about 90 kilometres; this trip is 120 kilometres.*Petronas, 3\.0 km/);
      R.navTick(n, r, 0, 120000);
      assert.equal(ctx.said.length, before + 1, 'not repeated');
      R.fuel.km = 97; R.navTick(n, r, 0, 120000);
      assert.match(ctx.said.at(-1), /Fuel is low, about 3 kilometres left/, 'second warning when nearly empty');
      R.fill();
      assert.equal(R.left(), 100);
      R.setRange('');
      assert.equal(R.left(), null, 'empty value turns it off');
    });
  });

  it('settings has the tank range field', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      ctx.document.querySelector('#btnSettings').click();
      const f = ctx.document.querySelector('#mFuel');
      assert.ok(f);
      f.value = '180'; f.dispatchEvent(new ctx.window.Event('change'));
      assert.equal(ctx.app.RIDE.left(), 180);
      assert.match(ctx.document.querySelector('#mFuelLeft').textContent, /180 km/);
    });
  });

  it('all four languages have every string', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const L = ctx.app.RIDE.L; const keys = Object.keys(L.en).sort();
      for (const l of ['ms', 'zh', 'ta']) assert.deepEqual(Object.keys(L[l]).sort(), keys, l);
    });
  });
});
