'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withApp } = require('./helpers.js');

describe('languages', () => {
  it('zh and ta translate, fall back to English when a key is missing', async () => {
    await withApp({}, async (t) => {
      const { S, T, instr } = t.app;
      S.lang = 'zh'; assert.equal(T('settings'), '设置'); assert.ok(T('nonexistent') === undefined);
      assert.match(instr({ maneuver: { type: 'turn', modifier: 'left' }, name: 'Jalan A' }), /左转/);
      S.lang = 'ta'; assert.equal(T('close'), 'மூடு');
      assert.match(instr({ maneuver: { type: 'turn', modifier: 'right' }, name: '' }), /வலதுபுறம்/);
      S.lang = 'en'; assert.equal(T('close'), 'Close');
    });
  });
});
