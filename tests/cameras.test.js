'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withApp, waitFor } = require('./helpers.js');

const TIMEOUT = 20000;
// Demo route runs north along lon 100.40 from lat 5.30. 0.001 deg of latitude is about 110.5 m.
const CAMS = {
  asof: '2026-11-01',
  src: 'SYNTHETIC TEST DATA',
  c: [
    [5.33, 100.4001, 0, null, 60],     // about 11 m from the route: on it
    [5.335, 100.4003, 0, null, 90],    // about 33 m away: just outside the 25 m limit
    [5.34, 100.41, 0, null, null],     // 1 km east: another road
  ],
};
const spoken = (ctx) => ctx.said.filter((s) => /^(Kamera laju \d|Speed camera \d)/.test(s));
const banner = (ctx) => ctx.document.querySelector('#camAlert');

async function startNav(ctx) {
  await ctx.search('gurney');
  await ctx.routeReady();
  ctx.document.querySelector('#btnStart').click();
  await waitFor(() => ctx.app.SC.all, { what: 'camera data' });
}
async function drive(ctx, lats, speed = 10) {
  for (const lat of lats) {
    ctx.setPos(lat, 100.4, speed);
    await ctx.sleep(15);
  }
}

describe('speed camera alerts', () => {
  it('loads data/cameras.json lazily at navigation start only', { timeout: TIMEOUT }, async () => {
    await withApp({ cameras: CAMS }, async (ctx) => {
      await ctx.search('gurney');
      await ctx.routeReady();
      assert.equal(ctx.cameraFetches, 0, 'nothing fetched before navigation');
      ctx.document.querySelector('#btnStart').click();
      await waitFor(() => ctx.cameraFetches === 1 && ctx.app.SC.all, { what: 'camera data' });
    });
  });

  it('warns once at about 400 m and once at about 150 m, never behind, ignores cameras off the route', { timeout: TIMEOUT }, async () => {
    await withApp({ cameras: CAMS, withDB: false, storage: { lang: 'en' } }, async (ctx) => {
      await startNav(ctx);
      await drive(ctx, [5.31, 5.3245]);                      // 480 m away: silent
      assert.equal(spoken(ctx).length, 0);
      assert.ok(banner(ctx).classList.contains('hidden'));

      await drive(ctx, [5.3266, 5.3268, 5.327]);             // ~370-330 m: far warning, once
      assert.equal(spoken(ctx).length, 1);
      assert.match(spoken(ctx)[0], /^Speed camera 400 m ahead, limit 60 kilometres per hour$/);
      assert.ok(!banner(ctx).classList.contains('hidden'));
      assert.match(banner(ctx).textContent, /Speed camera .* limit 60 · you 36 km\/h/);

      await drive(ctx, [5.328, 5.3285]);                     // ~220-165 m: no repeat
      assert.equal(spoken(ctx).length, 1);

      await drive(ctx, [5.3292, 5.3295]);                    // ~120-60 m: near warning, once
      assert.equal(spoken(ctx).length, 2);
      assert.match(spoken(ctx)[1], /^Speed camera \d+ m ahead/);

      await drive(ctx, [5.3302, 5.332, 5.334, 5.336]);       // passed it: banner gone, no more speech
      assert.equal(spoken(ctx).length, 2, 'the camera behind you and the 33 m-off camera stay silent');
      assert.ok(banner(ctx).classList.contains('hidden'));
      assert.deepEqual(ctx.errors.map((e) => e.message), []);
    });
  });

  it('flags speeding against the known limit, in Malay by default', { timeout: TIMEOUT }, async () => {
    await withApp({ cameras: CAMS, withDB: false }, async (ctx) => {
      await startNav(ctx);
      await drive(ctx, [5.3266], 20);                        // 72 km/h in a 60 zone
      assert.equal(spoken(ctx).length, 1);
      assert.match(spoken(ctx)[0], /^Kamera laju .* di hadapan, had laju 60 kilometer sejam\. Perlahan sedikit$/);
      assert.match(banner(ctx).textContent, /had 60 · anda 72 km\/j/);
      assert.ok(banner(ctx).classList.contains('over'));
    });
  });

  it('a camera first seen inside 150 m gets a single warning', { timeout: TIMEOUT }, async () => {
    await withApp({ cameras: CAMS, withDB: false }, async (ctx) => {
      await startNav(ctx);
      await drive(ctx, [5.329, 5.3292, 5.3295]);
      assert.equal(spoken(ctx).length, 1);
    });
  });

  it('is silent when the setting is off, and does not even download the file', { timeout: TIMEOUT }, async () => {
    await withApp({ cameras: CAMS, withDB: false, storage: { camAlerts: false } }, async (ctx) => {
      await ctx.search('gurney');
      await ctx.routeReady();
      ctx.document.querySelector('#btnStart').click();
      await drive(ctx, [5.3266, 5.329, 5.3295]);
      assert.equal(spoken(ctx).length, 0);
      assert.equal(ctx.cameraFetches, 0);
      assert.ok(banner(ctx) === null || banner(ctx).classList.contains('hidden'));
    });
  });

  it('can be switched off from the settings modal in the middle of a trip', { timeout: TIMEOUT }, async () => {
    await withApp({ cameras: CAMS, withDB: false }, async (ctx) => {
      await startNav(ctx);
      await drive(ctx, [5.3266]);
      assert.equal(spoken(ctx).length, 1);
      ctx.document.querySelector('#btnSettings').click();
      const sw = ctx.document.querySelector('#mSC');
      assert.ok(sw.classList.contains('on'), 'default is on');
      sw.click();
      assert.equal(ctx.app.S.camAlerts, false);
      assert.equal(ctx.window.localStorage.getItem('s9_camAlerts'), 'false');
      await drive(ctx, [5.3292]);
      assert.equal(spoken(ctx).length, 1, 'no near warning after switching off');
      assert.ok(banner(ctx).classList.contains('hidden'));
    });
  });

  it('settings text says the list is incomplete', { timeout: TIMEOUT }, async () => {
    for (const [lang, label] of [['en', 'Speed camera alerts'], ['ms', 'Amaran kamera laju']]) {
      await withApp({ storage: { lang } }, async (ctx) => {
        ctx.document.querySelector('#btnSettings').click();
        const html = ctx.document.querySelector('#modal').textContent;
        assert.ok(html.includes(label));
        assert.ok(html.includes(lang === 'en' ? 'Not all cameras are listed; obey signs.' : 'Tidak semua kamera disenaraikan; patuhi papan tanda.'));
      });
    }
  });

  it('missing or broken camera file changes nothing', { timeout: TIMEOUT }, async () => {
    await withApp({ withDB: false }, async (ctx) => {   // data/cameras.json answers 404
      await ctx.search('gurney');
      await ctx.routeReady();
      ctx.document.querySelector('#btnStart').click();
      await drive(ctx, [5.3266, 5.329]);
      assert.equal(spoken(ctx).length, 0);
      assert.deepEqual(ctx.errors.map((e) => e.message), []);
    });
  });

  it('service worker treats cameras.json like the other data files (network first)', () => {
    const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    const m = sw.match(/if \((\/\\\/data\\\/\([^\n]*?\)\$\/)\.test\(url\.pathname\)\)/);
    assert.ok(m, 'data regexp found');
    const re = eval(m[1]); // eslint-disable-line no-eval
    assert.ok(re.test('/sembilan/data/cameras.json'));
    assert.ok(re.test('/sembilan/data/tolls.json'));
    assert.ok(!re.test('/sembilan/data/cameras.json.bak'));
  });
});

// Python-side tests for scripts/build_cameras.py (mocked Overpass response, no network).
describe('build_cameras.py', () => {
  it('passes its unittest suite', { timeout: 60000 }, (t) => {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync('python3', ['-I', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_build_cameras.py'], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8',
    });
    if (r.error && r.error.code === 'ENOENT') return t.skip('python3 not installed');
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});
