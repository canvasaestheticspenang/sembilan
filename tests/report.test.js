'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp, waitFor } = require('./helpers.js');

const TIMEOUT = 20000;

// Starts navigation to the first search result and moves the fake GPS past the speed camera.
async function navigate(ctx) {
  await ctx.search('gurney');
  await ctx.routeReady();
  ctx.document.querySelector('#btnStart').click();
  for (const lat of [5.31, 5.33, 5.345, 5.355]) {
    ctx.setPos(lat, 100.4);
    await ctx.sleep(20);
  }
}

// Every latitude/longitude value in the report, as text.
const coordValues = (rep) => [...rep.matchAll(/\b(?:la|lo)=(\S+)/g)].map((m) => m[1])
  .concat([...rep.matchAll(/Position: (\S+),(\S+) /g)].flatMap((m) => [m[1], m[2]]))
  .concat([...rep.matchAll(/mlat=(\S+?)&mlon=(\S+?)#/g)].flatMap((m) => [m[1], m[2]]));

describe('trip log and problem report', () => {
  it('after a simulated navigation the report has the destination, a spoken prompt and 4-decimal coordinates', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await navigate(ctx);
      const rep = ctx.app.buildReport('Arahan salah / Wrong direction', 'Belok salah di simpang');
      assert.match(rep, /^Sembilan laporan 2026\.11\.07/);
      assert.match(rep, /Destination: Gurney Plaza/, 'destination is in the report');
      assert.match(rep, /start d=Gurney Plaza/, 'the navigation start is in the log');
      assert.ok(ctx.said.length > 0, 'the app spoke at least one prompt');
      assert.ok(rep.includes(ctx.said[0]), 'the first spoken prompt is in the log');
      assert.match(rep, /Position: 5\.3550,100\.4000 \(/, 'current position is shown');
      assert.match(rep, /mlat=5\.3550&mlon=100\.4000#map=17\/5\.3550\/100\.4000/, 'OpenStreetMap link uses the same position');
      const values = coordValues(rep);
      assert.ok(values.length >= 4, 'coordinates were found');
      for (const v of values) assert.match(v, /^-?\d+\.\d{4}$/, `${v} has exactly 4 decimals`);
      assert.deepEqual(ctx.errors.map((e) => e.message), [], 'no page errors');
    });
  });

  it('never puts the family WhatsApp number in the report or in the WhatsApp link', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const fam = '60123456789';
      ctx.app.S.family = fam;
      await navigate(ctx);
      const rep = ctx.app.buildReport('Hujan / Rain', '');
      assert.ok(!rep.includes(fam), 'full number is not in the report');
      assert.ok(!rep.includes('123456789'), 'no part of the number is in the report');
      const url = ctx.app.waUrl(rep);
      assert.ok(!url.includes(fam) && !url.includes('123456789'), 'the WhatsApp link does not carry it either');
      assert.equal(decodeURIComponent(url.slice(url.indexOf('?text=') + 6)), rep, 'the link carries the report text exactly');
    });
  });

  it('keeps the report under 3600 characters even with 300 log entries and long input', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      ctx.app.st.dest = { lat: 5.3, lon: 100.4, name: 'N'.repeat(300) };
      for (let i = 0; i < 300; i++) ctx.app.logEv('say', { x: `Teruskan ${'jalan panjang '.repeat(20)} ${i}` });
      ctx.app.logEv('say', { x: 'MARK-LAST' });
      assert.equal(ctx.app.LOG.length, 300, 'the log is capped at 300 entries');
      const rep = ctx.app.buildReport('Lain-lain / Other', 'x'.repeat(5000));
      assert.ok(rep.length < 3600, `report is ${rep.length} characters`);
      assert.ok(rep.includes('MARK-LAST'), 'the newest log line is kept when lines are trimmed');
      const lines = rep.split('\n');
      const logLines = lines.slice(lines.indexOf('Log (last 25):') + 1);
      assert.ok(logLines.length <= 25, 'at most the last 25 log lines');
    });
  });

  it('captures an uncaught page error in the trip log, as a message only', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      ctx.window.eval("setTimeout(() => { throw new Error('boom test'); }, 0)");
      await waitFor(() => ctx.app.LOG.some((e) => e.k === 'err' && e.m === 'boom test'), { what: 'the page error in the log' });
      const entry = ctx.app.LOG.find((e) => e.k === 'err');
      assert.ok(Object.keys(entry).every((k) => ['k', 'm', 't', 'at'].includes(k)), 'only the message and file:line are stored, no stack');
      if (entry.at) assert.match(entry.at, /^[^\s]*:\d+:\d+$/, 'at is file:line:col');
      assert.match(ctx.app.buildReport('', ''), /err m=boom test/, 'the error appears in the report');
    });
  });

  it('keeps the newest 300 entries in the ring buffer', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      for (let i = 0; i < 305; i++) ctx.app.logEv('say', { x: `n${i}` });
      assert.equal(ctx.app.LOG.length, 300);
      assert.equal(ctx.app.LOG[0].x, 'n5', 'the five oldest entries were dropped');
      assert.equal(ctx.app.LOG[299].x, 'n304');
    });
  });

  it('writes the trip log to storage when navigation ends', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await navigate(ctx);
      ctx.document.querySelector('#btnEnd').click();
      const saved = JSON.parse(ctx.window.localStorage.getItem('s9_triplog'));
      assert.ok(saved.some((e) => e.k === 'start'), 'start is stored');
      assert.ok(saved.some((e) => e.k === 'end'), 'end is stored');
    });
  });

  it('opening the report during navigation does not stop navigation', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await navigate(ctx);
      ctx.document.querySelector('#btnReport').click();
      assert.ok(ctx.document.body.classList.contains('navigating'), 'navigation mode is still on');
      assert.ok(ctx.app.st.nav, 'navigation state is kept');
      assert.ok(ctx.document.querySelector('#rpSendBtn'), 'the report dialog is open');
      ctx.setPos(5.34, 100.4);
      assert.equal(ctx.app.st.here.lat, 5.34, 'GPS fixes are still handled during navigation');
    });
  });

  it('the report can be opened from Settings', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      ctx.document.querySelector('#btnSettings').click();
      ctx.document.querySelector('#mReport').click();
      assert.ok(ctx.document.querySelector('#rpTxt'), 'the report dialog opened from Settings');
    });
  });

  it('Copy falls back to a selectable text box when the clipboard is unavailable', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      ctx.document.querySelector('#btnSettings').click();
      ctx.document.querySelector('#mReport').click();
      ctx.document.querySelector('#rpCopyBtn').click();
      const out = await waitFor(() => {
        const el = ctx.document.querySelector('#rpOut');
        return el && !el.classList.contains('hidden') ? el : null;
      }, { what: 'the fallback text box' });
      assert.ok(out.readOnly, 'the fallback box is read-only');
      assert.match(out.value, /Sembilan laporan 2026\.11\.07/);
    });
  });

  it('builds a valid report with no GPS fix and no destination', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      ctx.app.st.here = null;
      const rep = ctx.app.buildReport('', '');
      assert.match(rep, /Destination: -/);
      assert.match(rep, /Position: -/);
      assert.match(rep, /Log \(last 25\):\n-$/);
    });
  });

  it('waUrl() targets the given number, or no number to let the tester pick', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      assert.equal(ctx.app.waUrl('hello'), 'https://wa.me/?text=hello');
      assert.equal(ctx.app.waUrl('a b', '+60 12-345'), 'https://wa.me/6012345?text=a%20b');
    });
  });
});
