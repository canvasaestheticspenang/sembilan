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

  // By design, petrol stations and R&R count as shelter spots for riders
  // (SHELTERS = ['shelter','fuel','rr']). The data has 1 shelter + 1 petrol station.
  it('shelter chip counts shelters, petrol stations and R&R', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: true, withDB: true }, async (ctx) => {
      await ctx.search('gurney');
      await readyRoute(ctx);
      assert.match(sheetText(ctx), /2 tempat berteduh/);
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
  it('dedupePlaces() keeps same-name results in the same area that are far apart', { timeout: TIMEOUT }, async () => {
    await withApp({}, async ({ app }) => {
      const out = app.dedupePlaces([
        { name: 'Shell', sub: 'Kuala Lumpur', lat: 3.1579, lon: 101.7116 },
        { name: 'Shell', sub: 'Kuala Lumpur', lat: 3.3, lon: 101.9 },
      ]);
      assert.equal(out.length, 2);
    });
  });
});

describe('bottom sheet', () => {
  it('can be minimised by tapping or dragging the handle, and re-opens for a new destination', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: false, withDB: true }, async (ctx) => {
      await ctx.search('gurney');
      const sheet = ctx.document.querySelector('#sheet');
      const fire = (type, y) => ctx.document.querySelector('#sheet .grab').dispatchEvent(new ctx.window.MouseEvent(type, { bubbles: true, clientY: y }));
      assert.ok(!sheet.classList.contains('min'), 'open at first');
      fire('pointerdown', 100); fire('pointerup', 100);
      assert.ok(sheet.classList.contains('min'), 'tap on the handle minimises');
      fire('pointerdown', 100); fire('pointerup', 100);
      assert.ok(!sheet.classList.contains('min'), 'tap again opens');
      fire('pointerdown', 100); fire('pointermove', 160); fire('pointerup', 160);
      assert.ok(sheet.classList.contains('min'), 'dragging down minimises');
      fire('pointerdown', 160); fire('pointermove', 90); fire('pointerup', 90);
      assert.ok(!sheet.classList.contains('min'), 'dragging up opens');
    });
  });
});

describe('TomTom live traffic', () => {
  it('uses TomTom times with a delay note when a key is set, and stays on OSRM times without one', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: false, withDB: true, storage: { tomtom: 'TESTKEY' } }, async (ctx) => {
      await ctx.search('gurney');
      await ctx.waitFor(() => /Includes live traffic/.test(text(ctx, '#sheet')) || /Termasuk trafik/.test(text(ctx, '#sheet')), { what: 'traffic label' });
      assert.ok(ctx.ttCalls.length >= 1, 'TomTom was called');
      assert.match(sheetText(ctx), /50 min/, 'shows 3000 s as 50 min');
      assert.match(sheetText(ctx), /\+10 min/, 'shows the 10 min delay');
    });
    await withApp({ rider: false, withDB: true }, async (ctx) => {
      await ctx.search('gurney');
      assert.equal(ctx.ttCalls.length, 0, 'no key, no TomTom call');
    });
  });
});

describe('Valhalla routing', () => {
  it('shows toll and no-toll alternatives, and asks for motorcycle costing in rider mode', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: true, withDB: true, valhalla: true }, async (ctx) => {
      await ctx.search('gurney');
      assert.equal(ctx.document.querySelectorAll('.rc').length, 3, 'two toll routes plus the no-toll one');
      const t = sheetText(ctx);
      assert.match(t, /Tanpa tol|No tolls/, 'no-toll route is labelled');
      assert.match(t, /Ada tol|Tolls/, 'toll route is labelled');
      assert.equal(Object.keys(ctx.valBodies[0].costing_options)[0], 'motorcycle');
      assert.ok(ctx.valBodies.some((b) => Object.values(b.costing_options)[0].use_tolls === 0), 'asked for a no-toll variant');
    });
    await withApp({ rider: false, withDB: true, valhalla: true }, async (ctx) => {
      await ctx.search('gurney');
      assert.equal(Object.keys(ctx.valBodies[0].costing_options)[0], 'auto', 'car by default');
    });
  });
  it('falls back to the other router when Valhalla fails', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: false, withDB: true }, async (ctx) => {
      await ctx.search('gurney');
      assert.ok(ctx.document.querySelectorAll('.rc').length >= 1, 'routes still shown');
    });
  });
});

describe('toll price estimate', () => {
  it('estimates a car toll on the North-South Expressway and says motorcycles are free', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: false, withDB: true, valhalla: true }, async (ctx) => {
      await ctx.search('gurney');
      await ctx.waitFor(() => /≈ RM0\.75/.test(text(ctx, '#sheet')), { what: 'toll estimate (6.7 km x 0.1124)' });
      assert.match(sheetText(ctx), /anggaran|estimates/i, 'estimate disclaimer is shown');
    });
    await withApp({ rider: true, withDB: true, valhalla: true }, async (ctx) => {
      await ctx.search('gurney');
      assert.match(sheetText(ctx), /percuma untuk motosikal|free for motorcycles/);
      assert.doesNotMatch(sheetText(ctx), /≈ RM/, 'no car price in rider mode');
    });
  });
});

describe('heading-up view and passed route', () => {
  it('cycles north-up / heading-up / 3D and greys the route already passed', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: false }, async (ctx) => {
      await ctx.search('gurney');
      await readyRoute(ctx);
      ctx.document.querySelector('#btnStart').click();
      const b = ctx.document.body;
      assert.ok(b.classList.contains('hv'), 'heading-up is the default while navigating');
      ctx.document.querySelector('#btnView').click();
      assert.ok(b.classList.contains('tv'), '3D on second tap');
      ctx.document.querySelector('#btnView').click();
      assert.ok(!b.classList.contains('hv'), 'north-up on third tap');
      ctx.document.querySelector('#btnView').click();
      assert.ok(b.classList.contains('hv'));
      const z0 = ctx.window.__app.map ? ctx.window.__app.map.getZoom() : null;
      ctx.document.querySelector('#btnZout').click();
      assert.ok(b.classList.contains('hv'), 'zooming keeps heading-up navigation');
      if (z0 != null) assert.equal(ctx.window.__app.map.getZoom(), z0 - 1);
      ctx.document.querySelector('#hdTap').click();
      assert.ok(!b.classList.contains('hv'), 'tapping the map leaves heading-up so it can be dragged');
      ctx.setPos(5.33, 100.4);
      await ctx.sleep(30);
      assert.deepEqual(ctx.errors.map((e) => e.message), []);
    });
  });
});

describe('official PLUS fares', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const plus = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'plus-fares.json'), 'utf8'));
  const idx = (c) => plus.plazas.findIndex((p) => p.c === c);
  const fare = (a, b) => { const [i, j] = [idx(a), idx(b)].sort((x, y) => x - y); return plus.m[i][j - i - 1]; };

  it('has the official table: Jitra to Skudai is RM83.88 and the table is indexed correctly', () => {
    assert.equal(plus.plazas.length, 94);
    assert.equal(fare('JTR', 'SKD'), 83.88);
    assert.equal(fare('SKD', 'JTR'), 83.88);
    assert.equal(fare('TGK', 'PGH'), 3.12);
  });

  it('uses the official fare for a route that passes an entry and an exit plaza, and falls back otherwise', { timeout: TIMEOUT }, async () => {
    await withApp({}, async ({ app }) => {
      app.setTollD({ nse: 0.1124, plazas: [], plus });
      const a = plus.plazas[idx('BTU')].p, b = plus.plazas[idx('BTS')].p;
      const hav = (p, q) => Math.hypot((p[0] - q[0]) * 110540, (p[1] - q[1]) * 111320 * Math.cos(p[0] * Math.PI / 180));
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const coords = [a, mid, b];
      const cum = [0, hav(a, mid), hav(a, mid) + hav(mid, b)];
      const km = cum[2] / 1000;
      const r = { toll: true, coords, cum, tseg: [{ nm: 'Lebuhraya Utara-Selatan', km, i0: 0, i1: 2 }] };
      const f = app.plusFare(r);
      assert.equal(f, fare('BTU', 'BTS'));
      const far = { ...r, coords: [[1, 100], [1.01, 100.01]], cum: [0, 1500], tseg: [{ nm: 'Lebuhraya Utara-Selatan', km: 1.5, i0: 0, i1: 1 }] };
      assert.equal(app.plusFare(far), null, 'no plazas on the route -> estimate is used');
    });
  });
});

describe('pasted coordinates and map links', () => {
  it('turns "3.1390, 101.6869" and a Google Maps URL into a place', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const a = await ctx.app.geocode('3.1390, 101.6869');
      assert.equal(a.length, 1); assert.equal(a[0].lat, 3.139); assert.equal(a[0].lon, 101.6869);
      const g = await ctx.app.geocode('https://www.google.com/maps/place/Uo+Shin/@3.1801,101.6501,17z/data=!3d3.1801!4d101.6502');
      assert.equal(g[0].lat, 3.1801); assert.equal(g[0].lon, 101.6502);
    });
  });
});

describe('place index search', () => {
  it('finds every Uo Shin branch from the place index, nearest first', { timeout: TIMEOUT }, async () => {
    const rows = [
      ['Uo Shin', 5.4172, 100.3213, 'George Town', 'Japanese Restaurant'],
      ['Uo Shin', 3.2194, 101.6460, 'Kepong', 'Japanese Restaurant'],
      ['Uo Shin Hartamas', 3.1650, 101.6500, 'Kuala Lumpur', 'Japanese Restaurant'],
      ['Uo Shin Puchong', 3.0300, 101.6200, 'Puchong', 'Japanese Restaurant'],
    ];
    await withApp({ places: { uo: rows, shin: rows } }, async (ctx) => {
      const r = await ctx.app.geocode('uo shin');
      assert.equal(r.filter((p) => /Uo Shin/.test(p.name)).length, 4);
      assert.ok(/Japanese Restaurant/.test(r[0].sub), 'category shown');
    });
  });
});

describe('avatar and route look', () => {
  it('removes the uploaded face photo and falls back to the arrow', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const url = 'data:image/png;base64,iVBORw0KGgo=';
      assert.equal(ctx.app.storeFace(url), true);
      assert.equal(ctx.app.S.avatar, 'face');
      ctx.app.removeFace();
      assert.equal(ctx.app.S.avatarImg, '');
      assert.equal(ctx.app.S.avatar, 'arrow');
      assert.equal(ctx.app.store.get('avatarImg', null), '');
    });
  });
  const FACE = 'data:image/jpeg;base64,/9j/4AAQ';
  it('choosing an avatar persists in S and swaps the marker content', { timeout: TIMEOUT }, async () => {
    await withApp({ withDB: false }, async (ctx) => {
      ctx.setPos(5.3, 100.4);
      const A = ctx.app;
      await waitFor(() => A.meS.el, { what: 'position marker' });
      assert.equal(ctx.document.querySelector('.me-av').innerHTML, '', 'arrow by default has no avatar art');
      A.setAvatar('dog');
      assert.equal(A.S.avatar, 'dog');
      assert.equal(JSON.parse(ctx.window.localStorage.getItem('s9_avatar')), 'dog');
      assert.ok(ctx.document.querySelector('.me-av svg'), 'dog drawing is in the marker');
      assert.equal(A.meS.el.av.style.display, 'block');
      A.setAvatar('cat');
      assert.notEqual(A.meS.el.av.innerHTML, '');
      assert.ok(A.meS.el.av.isConnected, 'bindings follow the rebuilt marker');
      A.setAvatar('arrow');
      assert.equal(A.meS.el.av.style.display, 'none');
    });
  });

  it('face helpers crop to a centered square and only store image data URLs', { timeout: TIMEOUT }, async () => {
    await withApp({ withDB: false }, async (ctx) => {
      const A = ctx.app;
      assert.deepEqual({ ...A.faceCrop(400, 200) }, { sx: 100, sy: 0, s: 200 });
      assert.deepEqual({ ...A.faceCrop(100, 300) }, { sx: 0, sy: 100, s: 100 });
      assert.equal(A.storeFace('https://evil.example/x.png'), false);
      assert.equal(A.S.avatarImg, '');
      ctx.setPos(5.3, 100.4);
      await waitFor(() => A.meS.el, { what: 'position marker' });
      assert.equal(A.storeFace(FACE), true);
      assert.equal(A.S.avatar, 'face');
      assert.equal(JSON.parse(ctx.window.localStorage.getItem('s9_avatarImg')), FACE);
      assert.equal(ctx.document.querySelector('.me-av img').getAttribute('src'), FACE);
    });
  });

  it('route colour applies to the drawn route and survives navigation with a greyed done part', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: false, withDB: false }, async (ctx) => {
      await ctx.search('gurney');
      const A = ctx.app;
      const colours = () => A.routeLayer.getLayers().map((l) => l.options.color);
      assert.ok(colours().includes('#14b8a6'), 'default teal');
      A.setRouteColor('purple');
      assert.equal(A.S.routeColor, 'purple');
      assert.equal(JSON.parse(ctx.window.localStorage.getItem('s9_routeColor')), 'purple');
      assert.ok(colours().includes('#a855f7') && !colours().includes('#14b8a6'));
      assert.ok(A.routeLayer.getLayers().filter((l) => l.options.weight >= 12).length >= 2, 'glow and casing are thicker than the line');
      ctx.document.querySelector('#btnStart').click();
      assert.ok(A.st.nav.done, 'done polyline exists');
      assert.equal(A.st.nav.done.options.color, '#94a3b8');
      assert.equal(A.st.nav.line.options.color, '#a855f7');
      A.setRouteColor('orange');
      assert.equal(A.st.nav.line.options.color, '#f97316');
      assert.equal(A.st.nav.done.options.color, '#94a3b8');
    });
  });

  it('the picker is reachable from settings', { timeout: TIMEOUT }, async () => {
    await withApp({ withDB: false }, async (ctx) => {
      ctx.document.querySelector('#btnSettings').click();
      ctx.document.querySelector('#mLook').click();
      ctx.document.querySelector('[data-av="cat"]').click();
      ctx.document.querySelector('[data-rc="blue"]').click();
      assert.equal(ctx.app.S.avatar, 'cat');
      assert.equal(ctx.app.S.routeColor, 'blue');
      assert.ok(ctx.document.querySelector('[data-av="cat"]').classList.contains('on'));
    });
  });
});

describe('back button guard', () => {
  it('first back while navigating only warns, second ends navigation', { timeout: TIMEOUT }, async () => {
    await withApp({ rider: false }, async (ctx) => {
      await ctx.search('gurney');
      await readyRoute(ctx);
      ctx.document.querySelector('#btnStart').click();
      assert.ok(ctx.app.st.nav, 'navigating');
      ctx.document.querySelector('#modal').classList.add('hidden');
      ctx.window.dispatchEvent(new ctx.window.PopStateEvent('popstate'));
      assert.ok(ctx.app.st.nav, 'still navigating after the first back');
      ctx.window.dispatchEvent(new ctx.window.PopStateEvent('popstate'));
      assert.ok(!ctx.app.st.nav, 'second back ends navigation');
    });
  });
});
