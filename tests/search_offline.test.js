'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp } = require('./helpers.js');

describe('search on a weak or missing signal', () => {
  it('with no connection the online sources are not tried and on-device results still come back', { timeout: 20000 }, async () => {
    await withApp({ landmarks: [['Kuala Lumpur International Airport (KLIA)', 2.73402, 101.70515, 'airport', ['klia', 'kl airport']]] }, async (ctx) => {
      Object.defineProperty(ctx.window.navigator, 'onLine', { value: false, configurable: true });
      const before = ctx.calls.filter((c) => /photon|nominatim/.test(c.url)).length;
      const res = await ctx.app.geocode('klia');
      assert.ok(res.length > 0, 'place found offline');
      assert.match(res[0].name, /KLIA/);
      assert.equal(ctx.calls.filter((c) => /photon|nominatim/.test(c.url)).length, before, 'no online search attempted');
    });
  });
});
