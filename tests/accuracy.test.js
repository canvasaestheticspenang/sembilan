'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp } = require('./helpers.js');

const TIMEOUT = 20000;
const M = 111320; // metres per degree of latitude

describe('position accuracy', () => {
  it('routePoint walks the route by distance and reports the bearing of that stretch', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await ctx.search('gurney');
      const r = await ctx.routeReady();
      const p = ctx.app.routePoint(r, 1000);
      assert.ok(Math.abs((p[0] - 5.3) * M - 1000) < 5, 'about 1 km north of the start');
      assert.ok(Math.abs(p[1] - 100.4) < 1e-6);
      assert.ok(Math.abs(p[2]) < 1 || Math.abs(p[2] - 360) < 1, 'heading north');
      const q = ctx.app.routePoint(r, r.cum[60] + 500);
      assert.ok(Math.abs(q[0] - 5.36) < 1e-6 && q[1] > 100.404, 'past the turn it is on the eastbound road');
      assert.ok(Math.abs(q[2] - 90) < 1, 'heading east');
      const end = ctx.app.routePoint(r, 1e9);
      assert.ok(Math.abs(end[1] - 100.44) < 1e-6, 'never runs past the end of the route');
    });
  });

  it('while moving, the marker aims ahead of the last fix along the route; when stopped it aims at the fix', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await ctx.search('gurney');
      await ctx.routeReady();
      ctx.document.querySelector('#btnStart').click();
      ctx.setPos(5.31, 100.4002, 20); // 20 m/s, slightly off the centre line
      const to = ctx.app.meS.to;
      const ahead = (to[0] - 5.31) * M;
      assert.ok(ahead > 8 && ahead < 60, `aims ${ahead.toFixed(1)} m ahead`);
      assert.ok(Math.abs(to[1] - 100.4) < 1e-6, 'and stays on the route line');
      await ctx.sleep(30);
      ctx.setPos(5.32, 100.4, 0);
      await ctx.sleep(30);
      ctx.setPos(5.32, 100.4, 0);
      assert.ok(Math.abs((ctx.app.meS.to[0] - 5.32) * M) < 3, 'stopped: no lead');
    });
  });

  it('once the rider has really left the route the marker follows the GPS, not the old route', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      await ctx.search('gurney');
      await ctx.routeReady();
      ctx.document.querySelector('#btnStart').click();
      ctx.setPos(5.31, 100.4, 10);
      for (let i = 0; i < 3; i++) { ctx.setPos(5.31, 100.403, 10); await ctx.sleep(15); } // 330 m east of the route
      assert.ok(Math.abs(ctx.app.meS.to[1] - 100.403) < 1e-5, `marker longitude ${ctx.app.meS.to[1]}`);
    });
  });

  it('the rotated map box reaches the farthest screen corner at any heading', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const w = ctx.window, R = ctx.app.viewR('h');
      assert.ok(R >= Math.hypot(w.innerWidth / 2, w.innerHeight / 2), `half-side ${R}`);
      assert.ok(ctx.app.viewR('t') >= R, '3D is at least as large');
    });
  });
});
