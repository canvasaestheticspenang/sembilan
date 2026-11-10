'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp } = require('./helpers.js');

const TIMEOUT = 20000;

describe('opt-in search log', () => {
  it('is off by default and records nothing', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await ctx.search('gurney');
      assert.equal(ctx.app.SLOG.on, false);
      assert.equal(ctx.app.SLOG.rows.length, 0);
      assert.equal(ctx.app.store.get('slogRows', null), null, 'nothing written to storage');
    });
  });

  it('when on, a picked search is stored as query, results, rank and name, with no coordinates or time', { timeout: TIMEOUT }, async () => {
    await withApp({ storage: { slog: true } }, async (ctx) => {
      await ctx.search('gurney');
      const rows = ctx.app.store.get('slogRows');
      assert.equal(rows.length, 1);
      const [q, n, rank, name] = rows[0];
      assert.equal(q, 'gurney'); assert.ok(n >= 1); assert.equal(rank, 1); assert.match(name, /Gurney/);
      assert.equal(rows[0].length, 4, 'only four fields');
      assert.doesNotMatch(ctx.app.SLOG.text(), /\d+\.\d{3,}/, 'no coordinates in the export');
    });
  });

  it('typing on replaces the pending query; an unrelated query logs the previous one as not picked', { timeout: TIMEOUT }, async () => {
    await withApp({ storage: { slog: true } }, async (ctx) => {
      const L = ctx.app.SLOG;
      L.shown('kl', 5); L.shown('klia', 3);
      assert.equal(L.rows.length, 0, 'still typing');
      L.shown('masjid', 4);
      assert.equal(JSON.stringify(L.rows), JSON.stringify([['klia', 3, 0, '']]));
      L.flush();
      assert.equal(JSON.stringify(L.rows[1]), JSON.stringify(['masjid', 4, 0, '']));
    });
  });

  it('masks phone-like numbers, caps the log, and clears', { timeout: TIMEOUT }, async () => {
    await withApp({ storage: { slog: true } }, async (ctx) => {
      const L = ctx.app.SLOG;
      L.pick('no 12 jalan 3 0123456789', { name: 'A|B' }, 2, 7);
      assert.equal(JSON.stringify(L.rows[0]), JSON.stringify(['no 12 jalan 3 #', 7, 2, 'A B']));
      for (let i = 0; i < 400; i++) L.pick('q' + i, { name: 'x' }, 1, 3);
      assert.equal(L.rows.length, 300);
      L.clear();
      assert.equal(ctx.app.store.get('slogRows').length, 0);
    });
  });

  it('settings toggle turns it on and shows the send and clear buttons', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      ctx.document.querySelector('#btnSettings').click();
      assert.equal(ctx.document.querySelector('#mSlogBtns').style.display, 'none');
      ctx.document.querySelector('#mSlog').click();
      assert.equal(ctx.app.SLOG.on, true);
      assert.equal(ctx.app.store.get('slog'), true);
      assert.equal(ctx.document.querySelector('#mSlogBtns').style.display, 'flex');
      const keys = Object.keys(ctx.app.SLOG.L.en).sort();
      for (const l of ['ms', 'zh', 'ta']) assert.deepEqual(Object.keys(ctx.app.SLOG.L[l]).sort(), keys, l);
    });
  });
});
