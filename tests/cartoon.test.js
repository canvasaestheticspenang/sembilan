'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp, sleep } = require('./helpers.js');

const TIMEOUT = 20000;

// A stand-in for L.maplibreGL: a Leaflet layer wrapping a tiny fake MapLibre map.
function installFake(ctx, { fail } = {}) {
  const w = ctx.window, L = w.L;
  const made = [];
  const handlers = {};
  const gm = {
    painted: [],
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    once(ev, fn) { this.on(ev, fn); },
    emit(ev, arg) { (handlers[ev] || []).forEach((fn) => fn(arg)); },
    getStyle: () => ({ layers: [
      { id: 'background', type: 'background' },
      { id: 'water', type: 'fill' },
      { id: 'highway-primary', type: 'line' },
      { id: 'highway-primary-casing', type: 'line' },
      { id: 'poi_r20', type: 'symbol' },
    ] }),
    getPaintProperty: () => ['interpolate', ['exponential', 1.2], ['zoom'], 5, 0.5, 18, 20],
    setPaintProperty(id, p, v) { this.painted.push([id, p, v]); },
    setLayoutProperty() {},
  };
  const Fake = L.Layer.extend({
    onAdd() { made.push(this); },
    onRemove() {},
    getMaplibreMap() { return gm; },
  });
  ctx.app.CARTOON.load = async () => {
    ctx.loads = (ctx.loads || 0) + 1;
    if (fail) throw new Error('offline');
    L.maplibreGL = (opts) => { ctx.glOpts = opts; return new Fake(); };
  };
  return { gm, made };
}

describe('cartoon map (experimental)', () => {
  it('is off by default and the layers menu offers it', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      assert.equal(ctx.app.S.cartoon, false);
      ctx.document.querySelector('#btnLayers').click();
      assert.ok(ctx.document.querySelector('#mCartoon'), 'switch exists');
      assert.equal(ctx.document.querySelector('#mCartoon').classList.contains('on'), false);
    });
  });

  it('picking it saves the choice, calls the loader and swaps raster for vector once loaded', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      const { gm, made } = installFake(ctx);
      ctx.document.querySelector('#btnLayers').click();
      ctx.document.querySelector('#mCartoon').click();
      assert.equal(ctx.app.S.cartoon, true);
      assert.equal(ctx.app.store.get('cartoon', null), true, 'saved');
      await ctx.waitFor(() => made.length === 1, { what: 'the vector layer' });
      assert.equal(ctx.loads, 1);
      gm.emit('load');
      assert.ok(gm.painted.some(([id, p]) => id === 'water' && p === 'fill-color'), 'restyled after load');
      const w = gm.painted.find(([id, p]) => id === 'highway-primary' && p === 'line-width');
      assert.equal(w[2][4], 0.5 * 1.35, 'road widths are scaled up');
      assert.equal(w[2][6], 20 * 1.35);
      // zoom buttons still drive Leaflet's zoom
      const z = ctx.app.map.getZoom();
      ctx.document.querySelector('#btnZin').click();
      await ctx.waitFor(() => ctx.app.map.getZoom() > z, { what: 'zoom in' });
      assert.deepEqual(ctx.errors, []);
      // switching off removes the vector layer and restores raster
      ctx.document.querySelector('#mCartoon').click();
      assert.equal(ctx.app.S.cartoon, false);
      assert.equal(ctx.app.store.get('cartoon', null), false);
      assert.equal(ctx.app.map.hasLayer(made[0]), false);
    });
  });

  it('falls back to raster, turns the choice off and toasts when loading fails', { timeout: TIMEOUT }, async () => {
    await withApp({}, async (ctx) => {
      installFake(ctx, { fail: true });
      ctx.document.querySelector('#btnLayers').click();
      ctx.document.querySelector('#mCartoon').click();
      await ctx.waitFor(() => ctx.app.S.cartoon === false, { what: 'fallback' });
      assert.equal(ctx.app.store.get('cartoon', null), false);
      assert.match(ctx.document.querySelector('#toast').textContent, /Peta kartun tidak dapat dimuatkan/);
      assert.equal(ctx.document.querySelector('#mCartoon').classList.contains('on'), false);
      assert.ok(ctx.document.querySelector('.leaflet-tile-pane img, .leaflet-tile-pane .leaflet-layer'), 'raster base is back');
      await sleep(20);
      assert.deepEqual(ctx.errors, []);
      assert.deepEqual(ctx.unexpected, []);
    });
  });

  it('falls back when the style never loads (MapLibre error event)', { timeout: TIMEOUT }, async () => {
    await withApp({ storage: { lang: 'en' } }, async (ctx) => {
      const { gm, made } = installFake(ctx);
      ctx.document.querySelector('#btnLayers').click();
      ctx.document.querySelector('#mCartoon').click();
      await ctx.waitFor(() => made.length === 1, { what: 'the vector layer' });
      gm.emit('error', { error: new Error('style 404') });
      assert.equal(ctx.app.S.cartoon, false);
      assert.match(ctx.document.querySelector('#toast').textContent, /Cartoon map could not load/);
      assert.equal(ctx.app.map.hasLayer(made[0]), false);
    });
  });
});
