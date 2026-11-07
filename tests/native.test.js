'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp } = require('./helpers.js');

const TIMEOUT = 20000;

// A fake Capacitor runtime with the three plugins the bridge uses.
function fakeCapacitor(log) {
  const watchers = new Map();
  let n = 0;
  const Plugins = {
    BackgroundGeolocation: {
      async addWatcher(opts, cb) { const id = `w${++n}`; watchers.set(id, cb); log.push(['addWatcher', opts]); return id; },
      async removeWatcher({ id }) { watchers.delete(id); log.push(['removeWatcher', id]); },
    },
    TextToSpeech: {
      async speak(o) { log.push(['tts.speak', o]); },
      async stop() { log.push(['tts.stop']); },
    },
    KeepAwake: {
      async keepAwake() { log.push(['keepAwake']); },
      async allowSleep() { log.push(['allowSleep']); },
    },
  };
  return { cap: { isNativePlatform: () => true, Plugins }, watchers };
}

describe('native bridge on the web (no Capacitor)', () => {
  it('is not native and uses navigator.geolocation, speechSynthesis and the Wake Lock API', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const { native } = ctx.app;
      const w = ctx.window;
      assert.equal(native.isNative, false);

      // GPS: the app's own startWatch already went through the bridge to the fake navigator.geolocation.
      assert.equal(typeof w.__pos, 'function', 'navigator.geolocation.watchPosition received the app callback');
      let got = null;
      const id = native.watchPosition((p) => { got = p; }, () => {});
      assert.equal(id, 1, 'returns the id from navigator.geolocation');
      w.__pos({ coords: { latitude: 1, longitude: 2 }, timestamp: 5 });
      assert.equal(got.coords.latitude, 1);

      // Speech
      assert.equal(native.speak('Belok kiri', 'ms-MY', { rate: 1.1 }), true);
      assert.deepEqual(ctx.said.slice(-1), ['Belok kiri']);

      // Wake lock
      let req = null;
      Object.defineProperty(w.navigator, 'wakeLock', { configurable: true, value: { request: async (t) => { req = t; return { release() {} }; } } });
      const lock = await native.keepAwake();
      assert.equal(req, 'screen');
      assert.equal(typeof lock.release, 'function');
    });
  });

  it('loads places from the relative data/places/ folder and still registers nothing native', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      assert.equal(ctx.app.PLACES_BASE, 'data/places/');
      assert.match(ctx.app.REMOTE_DATA_BASE, /^https:\/\/canvasaestheticspenang\.github\.io\/sembilan\/data\/$/);
    });
  });

  it('app speech goes to speechSynthesis when voice is on', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      ctx.window.eval('0'); // keep jsdom warm
      const before = ctx.said.length;
      ctx.app.native.speak('Hello', 'en-GB');
      assert.equal(ctx.said.length, before + 1);
    });
  });
});

describe('native bridge on a device (fake Capacitor)', () => {
  const boot = (log, extra = {}) => {
    const { cap, watchers } = fakeCapacitor(log);
    return { opts: { beforeBoot: (w) => { w.Capacitor = cap; }, ...extra }, watchers };
  };

  it('uses the background geolocation plugin and maps fixes to the web shape', { timeout: TIMEOUT }, async () => {
    const log = [];
    const { opts, watchers } = boot(log, { start: { lat: 5.3, lon: 100.4 } });
    await withApp(opts, async (ctx) => {
      const { native, st, S } = ctx.app;
      assert.equal(native.isNative, true);
      assert.equal(ctx.window.__pos, undefined, 'the browser geolocation was not used');
      await ctx.sleep(10);
      const add = log.find((e) => e[0] === 'addWatcher');
      assert.ok(add, 'app startWatch registered a plugin watcher');
      assert.equal(add[1].requestPermissions, true);
      assert.ok(add[1].backgroundTitle && add[1].backgroundMessage, 'foreground-service notification text is set');
      assert.equal(add[1].backgroundTitle, S.lang === 'ms' ? 'Sembilan sedang menjejak lokasi' : 'Sembilan is using your location');

      // A fix from the plugin moves the app's position dot.
      const cb = [...watchers.values()][0];
      cb({ latitude: 5.41, longitude: 100.33, accuracy: 7, speed: 12, bearing: 90, time: 1234 });
      assert.equal(st.here.lat, 5.41);
      assert.equal(st.here.lon, 100.33);
      assert.equal(st.here.speed, 12);
      assert.equal(st.here.heading, 90);

      // Negative speed (unknown) becomes null; permission errors become code 1.
      let pos = null, err = null;
      native.watchPosition((p) => { pos = p; }, (e) => { err = e; });
      await ctx.sleep(5);
      const cb2 = [...watchers.values()][1];
      cb2({ latitude: 1, longitude: 2, accuracy: 3, speed: -1 });
      assert.equal(pos.coords.speed, null);
      cb2(undefined, { code: 'NOT_AUTHORIZED', message: 'denied' });
      assert.equal(err.code, 1);
    });
  });

  it('clearWatch removes the plugin watcher, even if called before it registered', { timeout: TIMEOUT }, async () => {
    const log = [];
    const { opts, watchers } = boot(log);
    await withApp(opts, async (ctx) => {
      const { native } = ctx.app;
      await ctx.sleep(5);
      const h = native.watchPosition(() => {}, () => {});
      native.clearWatch(h); // immediately, before addWatcher resolves
      await ctx.sleep(10);
      const id = [...log].reverse().find((e) => e[0] === 'removeWatcher');
      assert.ok(id, 'late-registered watcher was removed');
      const h2 = native.watchPosition(() => {}, () => {});
      await ctx.sleep(10);
      const before = watchers.size;
      native.clearWatch(h2);
      assert.equal(watchers.size, before - 1);
    });
  });

  it('speaks through the TTS plugin, stops it, and does not touch speechSynthesis', { timeout: TIMEOUT }, async () => {
    const log = [];
    const { opts } = boot(log);
    await withApp(opts, async (ctx) => {
      const { native, S } = ctx.app;
      S.voice = true; S.lang = 'ms';
      native.speak('Belok kanan', 'ms-MY', { rate: 1.02 });
      const sp = log.find((e) => e[0] === 'tts.speak')[1];
      assert.equal(sp.text, 'Belok kanan');
      assert.equal(sp.lang, 'ms-MY');
      assert.equal(sp.rate, 1.02);
      assert.deepEqual(ctx.said, [], 'speechSynthesis not used');
      native.stopSpeech();
      assert.ok(log.some((e) => e[0] === 'tts.stop'));
    });
  });

  it('keepAwake uses the KeepAwake plugin and release() allows sleep', { timeout: TIMEOUT }, async () => {
    const log = [];
    const { opts } = boot(log);
    await withApp(opts, async (ctx) => {
      const lock = await ctx.app.native.keepAwake();
      assert.ok(log.some((e) => e[0] === 'keepAwake'));
      await lock.release();
      assert.ok(log.some((e) => e[0] === 'allowSleep'));
    });
  });

  it('fetches places from the remote base URL, unless the build bundled them', { timeout: TIMEOUT }, async () => {
    const log = [];
    await withApp(boot(log).opts, async (ctx) => {
      assert.equal(ctx.app.PLACES_BASE, 'https://canvasaestheticspenang.github.io/sembilan/data/places/');
    });
    // Same page with the build marker flipped to "local" (what build-www --with-places does).
    const local = { ...boot([]).opts, transformPage: (h) => h.replace('content="remote"', 'content="local"') };
    await withApp(local, async (ctx) => {
      assert.equal(ctx.app.PLACES_BASE, 'data/places/');
    });
  });

  it('does not register the service worker on native', { timeout: TIMEOUT }, async () => {
    const log = [];
    let registered = 0;
    const opts = boot(log).opts;
    const prev = opts.beforeBoot;
    opts.beforeBoot = (w) => { prev(w); Object.defineProperty(w.navigator, 'serviceWorker', { configurable: true, value: { register: () => { registered++; return Promise.resolve(); } } }); };
    await withApp(opts, async (ctx) => {
      await ctx.sleep(10);
      assert.equal(registered, 0);
    });
  });
});
