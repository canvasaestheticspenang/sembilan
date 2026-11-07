'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp } = require('./helpers.js');

const TIMEOUT = 20000;
const KL = { lat: 3.14, lon: 101.69 };
// 2026-11-07 at the given Malaysia time (UTC+8), as epoch ms.
const myt = (hh, mm = 0) => Date.UTC(2026, 10, 7, hh - 8, mm);
// Minutes after midnight in Malaysia time for an epoch ms value.
const mytMinutes = (ms) => { const d = new Date(ms + 8 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hhmm = (ms) => { const m = mytMinutes(ms); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const isDark = (ctx) => ctx.document.body.classList.contains('dark');

// Moves the injected clock to the given instant and re-evaluates the map theme.
function setClock(ctx, ms) {
  ctx.app.TH.now = () => ms;
  ctx.app.applyTheme();
}

describe('sun calculation', () => {
  it('gives sunrise and sunset for Kuala Lumpur on 2026-11-07 close to 07:00 and 19:15', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const s = ctx.app.sunTimes(myt(12), KL.lat, KL.lon);
      assert.ok(s, 'sun events exist at this latitude');
      const rise = mytMinutes(s.rise), set = mytMinutes(s.set);
      assert.ok(rise >= 6 * 60 + 45 && rise <= 7 * 60 + 15, `sunrise ${hhmm(s.rise)} is between 06:45 and 07:15`);
      assert.ok(set >= 18 * 60 + 55 && set <= 19 * 60 + 25, `sunset ${hhmm(s.set)} is between 18:55 and 19:25`);
      assert.ok(s.rise < s.set, 'sunrise comes before sunset');
    });
  });

  it('returns null where the sun does not set (polar day)', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      assert.equal(ctx.app.sunTimes(Date.UTC(2026, 5, 21, 12), 80, 0), null);
    });
  });
});

describe('auto map theme', () => {
  it('is the default and goes dark at 22:00 and light at 12:00 local time', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      assert.equal(ctx.app.S.theme, 'auto', 'default theme is auto');
      setClock(ctx, myt(22));
      assert.ok(isDark(ctx), 'body has the dark class at 22:00');
      assert.equal(ctx.app.S.dark, true, 'effective dark state is in S.dark');
      setClock(ctx, myt(12));
      assert.ok(!isDark(ctx), 'body does not have the dark class at 12:00');
      assert.equal(ctx.app.S.dark, false);
      assert.equal(ctx.app.store.get('dark', null), null, 'the automatic state is not saved as dark');
    });
  });
});

describe('manual map theme', () => {
  it('Light and Dark override auto and are saved; Auto returns to the clock', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      setClock(ctx, myt(22));
      assert.ok(isDark(ctx));

      ctx.document.querySelector('#btnLayers').click();
      assert.equal(ctx.document.querySelector('#mDark'), null, 'old dark switch is gone');
      ctx.document.querySelector('[data-th="light"]').click();
      assert.equal(ctx.app.S.theme, 'light');
      assert.equal(ctx.app.store.get('theme', null), 'light', 'light is saved');
      assert.ok(!isDark(ctx), 'light overrides the night');
      assert.equal(ctx.document.querySelector('[data-th="light"]').classList.contains('on'), true, 'Light is highlighted');

      ctx.document.querySelector('[data-th="dark"]').click();
      setClock(ctx, myt(12));
      assert.equal(ctx.app.store.get('theme', null), 'dark', 'dark is saved');
      assert.ok(isDark(ctx), 'dark overrides the day');

      ctx.document.querySelector('[data-th="auto"]').click();
      assert.equal(ctx.app.store.get('theme', null), 'auto', 'auto is saved');
      assert.ok(!isDark(ctx), 'auto follows the clock again (noon is light)');
      setClock(ctx, myt(22));
      assert.ok(isDark(ctx), 'auto goes dark at night again');
    });
  });
});

describe('migration of the old dark setting', () => {
  it('a stored dark=true with no theme starts in Dark', { timeout: TIMEOUT }, async () => {
    await withApp({ storage: { dark: true } }, async (ctx) => {
      assert.equal(ctx.app.S.theme, 'dark');
      assert.ok(isDark(ctx), 'map is dark on start');
      setClock(ctx, myt(12));
      assert.ok(isDark(ctx), 'it stays dark at noon');
    });
  });

  it('a stored dark=false with no theme starts in Auto', { timeout: TIMEOUT }, async () => {
    await withApp({ storage: { dark: false } }, async (ctx) => {
      assert.equal(ctx.app.S.theme, 'auto');
    });
  });

  it('a stored theme wins over the old dark setting', { timeout: TIMEOUT }, async () => {
    await withApp({ storage: { dark: true, theme: 'light' } }, async (ctx) => {
      assert.equal(ctx.app.S.theme, 'light');
      assert.ok(!isDark(ctx));
    });
  });
});
