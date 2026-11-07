'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp, waitFor } = require('./helpers.js');

const TIMEOUT = 20000;
const text = (ctx, sel) => ctx.document.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim() ?? '';
const sheetText = (ctx) => text(ctx, '#sheet');

// Waits for the route cards plus the POIs (and rain forecast in motorcycle mode).
const readyRoute = (ctx) => ctx.routeReady();

describe('car mode', () => {
  it('shows route duration and the no-traffic label, with no toll or highway toggles', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: false, withDB: false }, async (ctx) => {
      await ctx.search('gurney');
      await readyRoute(ctx);
      const card = ctx.document.querySelector('.rc');
      assert.ok(card, 'route card is shown');
      assert.match(card.textContent, /15 min/, 'duration from the route is shown');
      assert.match(card.textContent, /tanpa trafik/, 'no-traffic label is shown');
      assert.equal(ctx.document.querySelector('#swToll'), null, '#swToll does not exist');
      assert.equal(ctx.document.querySelector('#swHwy'), null, '#swHwy does not exist');
      assert.equal(ctx.document.querySelector('.chip.bad'), null, 'no motorcycle warning in car mode');
      assert.deepEqual(ctx.unexpected, [], 'no unmocked network calls');
    });
  });
});

describe('motorcycle mode with the data file', () => {
  it('shows the no-motorcycle warning chip', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: true, withDB: true }, async (ctx) => {
      await ctx.search('gurney');
      await readyRoute(ctx);
      const warn = ctx.document.querySelector('.chip.bad');
      assert.ok(warn, 'warning chip is shown');
      assert.match(warn.textContent, /Larangan motosikal/);
      assert.match(warn.textContent, /Jalan Tol X/);
    });
  });

  it('shows a shelter count chip', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: true, withDB: true }, async (ctx) => {
      await ctx.search('gurney');
      await readyRoute(ctx);
      assert.match(sheetText(ctx), /tempat berteduh/, 'shelter chip is shown');
    });
  });

  // Real bug in index.html: the shelter chip counts fuel stations and R&R too, because
  // SHELTERS = ['shelter', 'fuel', 'rr'] is used for the chip. The data has one shelter.
  it('shelter chip shows only the number of shelters', { timeout: TIMEOUT, todo: 'BUG in index.html: shelter chip counts fuel and R&R as shelters (SHELTERS includes fuel and rr); data has 1 shelter but chip says 2' }, async () => {
    await withApp({ rider: true, withDB: true }, async (ctx) => {
      await ctx.search('gurney');
      await readyRoute(ctx);
      assert.match(sheetText(ctx), /1 tempat berteduh/);
    });
  });

  it('never calls Overpass when the data file is present', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: true, withDB: true }, async (ctx) => {
      await ctx.search('gurney');
      await readyRoute(ctx);
      assert.equal(ctx.overpassCalls, 0, 'Overpass was not called');
      assert.ok(ctx.dbFetches >= 1, 'data file was read');
      assert.deepEqual(ctx.unexpected, [], 'no unmocked network calls');
    });
  });

  it('does not list a POI that is far from the route', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: true, withDB: true }, async (ctx) => {
      await ctx.search('gurney');
      const r = await readyRoute(ctx);
      assert.match(sheetText(ctx), /Petronas/, 'a nearby petrol station is listed');
      assert.ok(!sheetText(ctx).includes('Far away'), 'far-away station is not listed');
      assert.ok(r.pois.every((p) => p.off <= 5000), 'every listed POI is within 5 km of the route');
    });
  });
});

describe('motorcycle mode without the data file', () => {
  it('falls back to Overpass and still shows the no-motorcycle warning', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: true, withDB: false }, async (ctx) => {
      await ctx.search('gurney');
      await readyRoute(ctx);
      assert.ok(ctx.overpassCalls >= 1, 'Overpass was called');
      const warn = ctx.document.querySelector('.chip.bad');
      assert.ok(warn, 'warning chip is shown');
      assert.match(warn.textContent, /Larangan motosikal/);
      assert.deepEqual(ctx.unexpected, [], 'no unmocked network calls');
    });
  });
});

describe('navigation', () => {
  it('shows the right turn, the rain alert and speaks the speed-camera prompt', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: true, withDB: true }, async (ctx) => {
      await ctx.search('gurney');
      await readyRoute(ctx);
      ctx.document.querySelector('#btnStart').click();
      assert.ok(ctx.document.body.classList.contains('navigating'), 'navigation mode is on');

      // The camera sits at lat 5.35: it is ahead at 5.345 and behind by 5.355.
      for (const lat of [5.31, 5.33, 5.345]) {
        ctx.setPos(lat, 100.4);
        await ctx.sleep(20);
      }
      const cam = ctx.document.querySelector('#alert');
      assert.ok(!cam.classList.contains('hidden'), 'camera alert is visible');
      assert.match(cam.textContent, /Kamera laju di hadapan/);
      await waitFor(() => ctx.said.some((s) => s.includes('Kamera laju di hadapan')), { what: 'speed camera prompt' });

      ctx.setPos(5.355, 100.4);
      await waitFor(() => text(ctx, '#nText') === 'Belok kanan ke Jalan Tol X', { what: 'turn instruction' });
      assert.match(text(ctx, '#nDist'), /\d+ m$/, 'distance to the turn is in metres');

      const rain = ctx.document.querySelector('#rainAlert');
      assert.ok(!rain.classList.contains('hidden'), 'rain alert is visible');
      assert.match(rain.textContent, /Hujan lebat/);
      assert.deepEqual(ctx.errors.map((e) => e.message), [], 'no page errors');
    });
  });
});

describe('long routes', () => {
  it('loads a 120 km route in chunks and survives one failed Overpass request', { timeout: TIMEOUT }, async () => {
    // Overpass request 0 fails; the app tries the next server and the route still loads.
    await withApp({ rider: false, withDB: false, route: 'long', overpass: 'bbox', overpassFails: (n) => n === 0 }, async (ctx) => {
      await ctx.search('gurney');
      const r = await readyRoute(ctx);
      assert.ok(r.total > 110000, 'route is about 120 km');
      assert.equal(r.poisPartial, false, 'nothing was dropped');
      assert.equal(r.pois.filter((p) => p.type === 'fuel').length, 5, 'one fuel stop per 25 km chunk');
      assert.ok(ctx.overpassCalls >= 6, 'five chunks plus one retry');
      assert.match(sheetText(ctx), /5 stesen petrol/);
    });
  });

  it('keeps the other chunks when one whole chunk fails, and says so', { timeout: TIMEOUT }, async () => {
    // All three servers fail for the first chunk (requests 0-2) only.
    await withApp({ rider: false, withDB: false, route: 'long', overpass: 'bbox', overpassFails: (n) => n < 3 }, async (ctx) => {
      await ctx.search('gurney');
      const r = await readyRoute(ctx);
      assert.equal(r.pois.filter((p) => p.type === 'fuel').length, 4, 'chunks 2 to 5 are kept');
      assert.equal(r.poisPartial, true);
      assert.match(sheetText(ctx), /Sebahagian laluan tidak dapat dimuatkan/);
    });
  });
});

describe('unit: instructions and search results', () => {
  it('trivial() drops "new name" and "continue straight" steps but keeps turns and forks', { timeout: TIMEOUT }, async () => {
    await withApp({}, async ({ app }) => {
      const s = (type, modifier, name = 'Jalan X') => ({ maneuver: { type, modifier }, name });
      assert.equal(app.trivial(s('new name', undefined)), true);
      assert.equal(app.trivial(s('continue', 'straight')), true);
      assert.equal(app.trivial(s('turn', 'right')), false);
      assert.equal(app.trivial(s('continue', 'left')), false);
      assert.equal(app.trivial(s('fork', 'slight left')), false);
    });
  });

  it('instr() gives the turn in Bahasa Malaysia with the road name', { timeout: TIMEOUT }, async () => {
    await withApp({}, async ({ app }) => {
      const out = app.instr({ maneuver: { type: 'turn', modifier: 'right' }, name: 'Jalan Tol X' });
      assert.equal(out, 'Belok kanan ke Jalan Tol X');
    });
  });

  it('dedupePlaces() merges same-name results within 500 m', { timeout: TIMEOUT }, async () => {
    await withApp({}, async ({ app }) => {
      const out = app.dedupePlaces([
        { name: 'KLCC', sub: 'Jalan Ampang, Kuala Lumpur', lat: 3.1579, lon: 101.7116 },
        { name: 'KLCC', sub: 'Jalan Ampang, Kuala Lumpur', lat: 3.1585, lon: 101.712 },
        { name: 'KLCC', sub: 'Jalan P. Ramlee, Kuala Lumpur', lat: 3.1575, lon: 101.7123 },
        { name: 'KLCC Park', sub: 'Kuala Lumpur', lat: 3.155, lon: 101.714 },
      ]);
      assert.deepEqual(Array.from(out, (p) => p.name), ['KLCC', 'KLCC Park']);
    });
  });

  it('dedupePlaces() keeps same-name results that are about 2 km apart', { timeout: TIMEOUT }, async () => {
    await withApp({}, async ({ app }) => {
      const out = app.dedupePlaces([
        { name: 'Shell', sub: 'Jalan Ampang, Kuala Lumpur', lat: 3.1579, lon: 101.7116 },
        { name: 'Shell', sub: 'Jalan Sultan Ismail, Kuala Lumpur', lat: 3.1759, lon: 101.7116 },
      ]);
      assert.equal(out.length, 2);
    });
  });

  // Real bug in index.html: dedupePlaces() merges any two same-name results with the same
  // "sub" text, however far apart they are, because of the `o.sub === p.sub` test.
  it('dedupePlaces() keeps same-name results in the same area that are far apart', { timeout: TIMEOUT, todo: 'BUG in index.html: dedupePlaces merges same-name places with the same area text even when they are ~25 km apart (the 500 m rule is not applied)' }, async () => {
    await withApp({}, async ({ app }) => {
      const out = app.dedupePlaces([
        { name: 'Shell', sub: 'Kuala Lumpur', lat: 3.1579, lon: 101.7116 },
        { name: 'Shell', sub: 'Kuala Lumpur', lat: 3.3, lon: 101.9 },
      ]);
      assert.equal(out.length, 2);
    });
  });
});
