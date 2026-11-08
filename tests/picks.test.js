'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp } = require('./helpers.js');

const TIMEOUT = 20000;

// Two places with the same name stem and the same neutral category. A is nearer the
// start point (5.3, 100.4), B is further away, so with no learning A ranks first.
const PLACES = {
  alph: [
    ['Alpha Cafe', 5.31, 100.41, 'Georgetown', 'Cafe'],
    ['Alpha Cafe Two', 5.36, 100.46, 'Bayan Lepas', 'Cafe'],
  ],
};
// Array.from builds a Node-realm array, so deepStrictEqual works on jsdom results.
const NAMES = (list) => Array.from(list, (p) => p.name);

// Route-side fixtures: a straight 120 km route north on lon 100.4 (coords are [lat, lon]).
const ROUTE = { coords: Array.from({ length: 1081 }, (_, i) => [5.0 + i * 0.001, 100.4]) };
const ALONG_PLACES = {
  alph: [
    ['Alpha Ahead', 5.9, 100.4, 'Gerik', 'Cafe'],
    ['Alpha Behind', 5.1, 100.4, 'Ipoh', 'Cafe'],
  ],
};

// Types a query and waits for its suggestions to appear.
async function typeQuery(ctx, text, index) {
  const w = ctx.window;
  const input = w.document.querySelector('#qDest');
  input.value = text;
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
  await ctx.waitFor(() => w.document.querySelector(`.si[data-i="${index}"]`), { what: `suggestion ${index}` });
}

// Searches with the app's storage, then clicks the suggestion at index.
async function typeAndPick(ctx, text, index) {
  await typeQuery(ctx, text, index);
  ctx.window.document.querySelector(`.si[data-i="${index}"]`).click();
}

describe('learned picks in search', () => {
  it('ranks a place the rider picked for this query above where it was', { timeout: TIMEOUT }, async () => {
    await withApp({ places: PLACES, withDB: false }, async (ctx) => {
      const before = NAMES(await ctx.app.fsqSearch('alpha'));
      assert.equal(before[0], 'Alpha Cafe', 'nearer place is first with nothing learned');
      await typeAndPick(ctx, 'alpha', 1);
      const after = NAMES(await ctx.app.fsqSearch('alpha'));
      assert.equal(after[0], 'Alpha Cafe Two', 'the picked place moves to the top for the same query');
      assert.deepEqual(ctx.unexpected, [], 'no unmocked network calls');
    });
  });

  it('records the pick on the device only, sending no query text anywhere', { timeout: TIMEOUT }, async () => {
    await withApp({ places: PLACES, withDB: false }, async (ctx) => {
      await typeQuery(ctx, 'alpha', 1);
      const callsBefore = ctx.calls.length;
      ctx.window.document.querySelector('.si[data-i="1"]').click();
      // Picking starts the route request as before; none of the requests after the click may carry the query.
      const after = ctx.calls.slice(callsBefore).map((c) => c.url).join('\n');
      assert.ok(!/alpha/i.test(after), 'no request after the pick contains the typed query');
      const raw = ctx.window.localStorage.getItem('s9_picks');
      assert.ok(raw, 'pick is stored under s9_picks');
      const model = JSON.parse(raw);
      assert.equal(model.v, 1);
      const entries = Object.values(model.picks);
      assert.equal(entries.length, 1);
      assert.deepEqual(Object.keys(entries[0]).sort(), ['c', 'p', 'q', 't']);
      assert.equal(entries[0].q, 'alpha');
      assert.match(entries[0].p, /^alpha cafe two@5\.360,100\.460$/);
    });
  });

  it('does not learn from a recent or saved destination shown without a search', { timeout: TIMEOUT }, async () => {
    await withApp({ places: PLACES, withDB: false, storage: { recent: [{ name: 'Alpha Cafe', lat: 5.31, lon: 100.41, sub: '' }] } }, async (ctx) => {
      const w = ctx.window;
      const input = w.document.querySelector('#qDest');
      input.dispatchEvent(new w.Event('focus', { bubbles: true }));
      await ctx.waitFor(() => w.document.querySelector('.si[data-i="0"]'), { what: 'recent suggestion' });
      w.document.querySelector('.si[data-i="0"]').click();
      const model = JSON.parse(w.localStorage.getItem('s9_picks') || '{"picks":{}}');
      assert.equal(Object.keys(model.picks || {}).length, 0, 'no query entry is written for a recent pick');
      assert.equal(model.recent[0].p, 'alpha cafe@5.310,100.410', 'the place still moves to the recent list');
    });
  });

  it('is neutral when nothing has been learned', { timeout: TIMEOUT }, async () => {
    await withApp({ places: PLACES, withDB: false }, async (ctx) => {
      const rows = await ctx.app.fsqSearch('alpha');
      const boosts = ctx.app.pickBoostMany(ctx.app.PICKS_STORE, 'alpha', rows);
      assert.deepEqual(boosts, rows.map(() => 0), 'every boost is zero with an empty store');
    });
  });

  it('keeps the default order when the stored picks are corrupt', { timeout: TIMEOUT }, async () => {
    await withApp({ places: PLACES, withDB: false }, async (ctx) => {
      ctx.window.localStorage.setItem('s9_picks', '{not json');
      const names = NAMES(await ctx.app.fsqSearch('alpha'));
      assert.equal(names[0], 'Alpha Cafe');
    });
  });

  it('never throws when storage is blocked or full', { timeout: TIMEOUT }, async () => {
    await withApp({ places: PLACES, withDB: false }, async (ctx) => {
      const blocked = {
        getItem() { throw new Error('denied'); },
        setItem() { throw new Error('denied'); },
        removeItem() { throw new Error('denied'); },
      };
      const place = { name: 'Alpha Cafe Two', lat: 5.36, lon: 100.46 };
      assert.equal(ctx.app.recordPick(blocked, 'alpha', place, Date.now()), false);
      assert.equal(ctx.app.clearAllPicks(blocked), false);
      const proto = ctx.window.Storage.prototype;
      const real = proto.setItem;
      proto.setItem = function () { throw new Error('QuotaExceededError'); };
      try {
        assert.equal(ctx.app.recordPick(ctx.app.PICKS_STORE, 'alpha', place, Date.now()), false);
      } finally {
        proto.setItem = real;
      }
      assert.equal(NAMES(await ctx.app.fsqSearch('alpha'))[0], 'Alpha Cafe', 'default order after failed writes');
    });
  });
});

describe('clear learned searches', () => {
  it('removes everything learned and restores the default order', { timeout: TIMEOUT }, async () => {
    await withApp({ places: PLACES, withDB: false }, async (ctx) => {
      await typeAndPick(ctx, 'alpha', 1);
      assert.equal(NAMES(await ctx.app.fsqSearch('alpha'))[0], 'Alpha Cafe Two');
      ctx.document.querySelector('#btnSettings').click();
      ctx.document.querySelector('#mClearPicks').click();
      assert.equal(ctx.window.localStorage.getItem('s9_picks'), null, 'stored picks are removed');
      assert.equal(NAMES(await ctx.app.fsqSearch('alpha'))[0], 'Alpha Cafe', 'default order is back');
    });
  });

  it('has the settings strings in Malay, English, Chinese and Tamil', { timeout: TIMEOUT }, async () => {
    await withApp({ places: PLACES, withDB: false }, async (ctx) => {
      const keys = ['learnT', 'learnB', 'learnNote', 'learnDone'];
      for (const lang of ['ms', 'en', 'zh', 'ta']) {
        for (const k of keys) {
          const v = ctx.app.I[lang][k];
          assert.ok(typeof v === 'string' && v.length > 0, `${lang}.${k} is set`);
        }
      }
      assert.notEqual(ctx.app.I.zh.learnB, ctx.app.I.en.learnB);
      assert.notEqual(ctx.app.I.ta.learnT, ctx.app.I.en.learnT);
    });
  });
});

describe('along-route search while navigating', () => {
  it('ranks places ahead on the route above places behind, regardless of the map centre', { timeout: TIMEOUT }, async () => {
    await withApp({ places: ALONG_PLACES, withDB: false }, async (ctx) => {
      const riderAlongM = 55600; // rider at about lat 5.5
      const rows = await ctx.app.fsqSearchAlong('alpha', ROUTE, riderAlongM);
      assert.deepEqual(NAMES(rows), ['Alpha Ahead', 'Alpha Behind']);
      assert.ok(rows[0].lat > rows[1].lat, 'the place ahead is the northern one');
      assert.equal(typeof rows[0].sub, 'string');
    });
  });

  it('geocode uses the along-route order while navigating and keeps the route order', { timeout: TIMEOUT }, async () => {
    await withApp({ places: ALONG_PLACES, withDB: false }, async (ctx) => {
      const coords = ROUTE.coords;
      const cum = coords.map((_, i) => i * 111.2);
      ctx.app.st.nav = { r: { coords, cum }, last: 495 }; // rider about 55 km along
      try {
        const list = await ctx.app.geocode('alpha', new ctx.window.AbortController().signal);
        const names = Array.from(list, (p) => p.name);
        assert.ok(names.indexOf('Alpha Ahead') >= 0 && names.indexOf('Alpha Ahead') < names.indexOf('Alpha Behind'), 'ahead is listed before behind');
      } finally {
        ctx.app.st.nav = null;
      }
    });
  });
});
