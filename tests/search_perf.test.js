'use strict';
// Tests for the search speed-ups in index.html. Each one checks that the result is unchanged:
// parallel shard reads merge in key order, a stale (aborted) search returns nothing, and the
// ASCII fast path of normWords and the cached digit test give the same answers as the old code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { withApp } = require('./helpers.js');

const TIMEOUT = 20000;
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// normWords as shipped, pulled out of the inline script. The reference is the pre-optimisation body.
{
  const from = html.indexOf('const FSQ_ASCII_ONLY');   // the regex constants sit just above the function
  const to = html.indexOf('// Normalised words minus', from);
  assert.ok(from > 0 && to > from, 'normWords markers found');
  var shippedNorm = vm.runInContext(html.slice(from, to) + '\n;normWords', vm.createContext({ String }));
}
function refNormWords(str) {
  return String(str == null ? '' : str)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

test('normWords (ASCII fast path) gives the same words as the reference on random input', () => {
  let seed = 11;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const chars = Array.from("abcXYZ019 -_.,'’`()&/é ü Ç 槟城 ஆ İ ß Ǆ ﬁ ①");
  for (let i = 0; i < 5000; i++) {
    const s = Array.from({ length: rnd(14) }, () => chars[rnd(chars.length)]).join('');
    assert.deepEqual([...shippedNorm(s)], refNormWords(s), 'input ' + JSON.stringify(s));
  }
  for (const v of [null, undefined, '', 42, 'One Utama Shopping Mall', "Gurney's Plaza", 'Jln. Sri-Hartamas 1/2']) {
    assert.deepEqual([...shippedNorm(v)], refNormWords(v), 'value ' + String(v));
  }
});

test('the digit test in fsqTokMatch is unchanged for every single character and for longer words', () => {
  const from = html.indexOf('const FSQ_ALIAS = {');
  const to = html.indexOf('function fsqCanon(str)');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(from, to) + '\n;this.fsqTokMatch = fsqTokMatch; this.FSQ_ALIAS = FSQ_ALIAS;', ctx);
  const ref = (w, t) => {   // the pre-optimisation body
    if (/^\d$/.test(t)) return w === t || w === ctx.FSQ_ALIAS[t];
    if (/^(ii|iii|iv|vi|vii|viii|ix)$/.test(t)) return w === t;
    if (w.startsWith(t)) return true;
    const a = ctx.FSQ_ALIAS[t];
    return !!a && (w === a || (a.length > 3 && w.startsWith(a)));
  };
  const probes = [...'0123456789abcdefjlmnpstuw', '10', '1a', 'ab', 'one', 'satu', ''];
  const words = ['1', 'one', 'satu', 'utama', 'jalan', 'jln', '2', 'two', '', 'x'];
  for (const t of probes) for (const w of words) {
    assert.equal(ctx.fsqTokMatch(w, t), ref(w, t), `fsqTokMatch(${JSON.stringify(w)}, ${JSON.stringify(t)})`);
  }
});

const ROWS_BY_KEY = {
  masj: [['Masjid Negeri', 5.4, 100.3, 'George Town', 'Mosque'], ['Masjid Jamek Sultan', 5.41, 100.31, 'George Town', 'Mosque']],
  mosq: [['Masjid Negeri', 5.4, 100.3, 'George Town', 'Mosque'], ['Mosque Hidayah', 5.402, 100.302, '', 'Mosque']],
  pena: [['Penang Mosque Annex', 5.3, 100.2, '', 'Mosque']],
};
const CENTRE = { lat: 5.4, lon: 100.3 };

test('shard reads that finish out of order give the same result as in-order reads', { timeout: TIMEOUT }, async () => {
  await withApp({}, async (ctx) => {
    const A = ctx.app;
    const plain = async k => (ROWS_BY_KEY[k] ? ROWS_BY_KEY[k].map(r => r.slice()) : null);
    const expected = await A.searchPlaces('masjid', CENTRE, { getIndex: async () => ({}), getShard: plain, limit: 10 });
    // Same rows, but each read resolves after a delay that depends on its key, in reverse key order.
    const delays = { masj: 30, mosq: 10, pena: 5 };
    let inFlight = 0, maxInFlight = 0;
    const slow = k => new Promise(res => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => { inFlight--; res(plain(k)); }, delays[k] || 1);
    });
    const got = await A.searchPlaces('masjid', CENTRE, { getIndex: async () => ({}), getShard: slow, limit: 10 });
    assert.deepEqual(got, expected, 'same places, same order, same scores');
    assert.ok(maxInFlight >= 2, 'the shard reads overlapped (not one after another)');
  });
});

test('a 3-letter query reads its 4-letter prefix shards and returns the same place as before', { timeout: TIMEOUT }, async () => {
  await withApp({}, async (ctx) => {
    const seen = [];
    const getShard = async k => { seen.push(k); return ROWS_BY_KEY[k] ? ROWS_BY_KEY[k].map(r => r.slice()) : null; };
    const r = await ctx.app.searchPlaces('pen', CENTRE, { getIndex: async () => ({}), getShard, limit: 5 });
    assert.ok(seen.includes('pena'), 'the prefix shard pena was read: ' + seen.join(','));
    assert.ok(r.some(p => p.name === 'Penang Mosque Annex'), 'row from the prefix shard is found: ' + r.map(p => p.name));
  });
});

test('an aborted search returns nothing, whether it was aborted before or during the shard reads', { timeout: TIMEOUT }, async () => {
  await withApp({}, async (ctx) => {
    const A = ctx.app;
    const ac = new AbortController();
    ac.abort();
    const before = await A.searchPlaces('masjid', CENTRE, { getIndex: async () => ({}), getShard: async k => ROWS_BY_KEY[k] || null, limit: 10, signal: ac.signal });
    assert.equal(before.length, 0, 'already aborted: no results');

    const ac2 = new AbortController();
    const during = await A.searchPlaces('masjid', CENTRE, {
      getIndex: async () => ({}), limit: 10, signal: ac2.signal,
      getShard: async k => { ac2.abort(); return ROWS_BY_KEY[k] || null; },
    });
    assert.equal(during.length, 0, 'aborted while reading: no results');

    const ok = await A.searchPlaces('masjid', CENTRE, { getIndex: async () => ({}), getShard: async k => ROWS_BY_KEY[k] || null, limit: 10, signal: new AbortController().signal });
    assert.ok(ok.length > 0, 'a search that is not aborted still returns results');
  });
});

test('the landmark list is requested when the search starts, before the shard reads finish', { timeout: TIMEOUT }, async () => {
  await withApp({}, async (ctx) => {
    const log = [];
    const getShard = k => new Promise(res => {
      log.push('shard ' + k);
      setTimeout(() => { log.push('shard done ' + k); res(ROWS_BY_KEY[k] ? ROWS_BY_KEY[k].map(r => r.slice()) : null); }, 15);
    });
    const landmarks = () => { log.push('landmarks'); return []; };
    await ctx.app.searchPlaces('masjid', CENTRE, { getIndex: async () => ({}), getShard, landmarks, limit: 10 });
    assert.ok(log.indexOf('landmarks') < log.indexOf('shard done masj'), 'landmarks asked before the first shard finished: ' + log.join(' | '));
  });
});

test('a 3-letter query asks for its prefix shards together with its name shard', { timeout: TIMEOUT }, async () => {
  await withApp({}, async (ctx) => {
    const log = [];
    const getShard = k => new Promise(res => {
      log.push('start ' + k);
      setTimeout(() => { log.push('done ' + k); res(ROWS_BY_KEY[k] ? ROWS_BY_KEY[k].map(r => r.slice()) : null); }, 15);
    });
    await ctx.app.searchPlaces('pen', CENTRE, { getIndex: async () => ({}), getShard, limit: 5 });
    assert.ok(log.indexOf('start pena') < log.indexOf('done pen'), 'prefix shard pena requested before the name shard pen finished');
  });
});

test('fsqSearch and fsqSearchAlong pass their signal on to the search', () => {
  assert.match(html, /async function fsqSearch\(q,signal\)/);
  assert.match(html, /async function fsqSearchAlong\(q,route,riderAlongM,signal\)/);
  assert.match(html, /fsqSearchAlong\(q,st\.nav\.r,riderAlongNow\(\),signal\):fsqSearch\(q,signal\)/);
});
