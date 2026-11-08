'use strict';
// Ranking tests for searchPlaces in index.html (mall / prefix / landmark changes). The search block is run as shipped:
// it is pulled out of the inline script by its markers and run in a vm context, with fake shards and landmarks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const from = html.indexOf('const FSQ_STOPWORDS = new Set([');
const to = html.indexOf('let placesIdxP=null');
assert.ok(from > 0 && to > from, 'search block markers found');
const code = html.slice(from, to) +
  '\n;this.normWords = normWords; this.fsqQuality = fsqQuality; this.fsqOrderTier = fsqOrderTier; this.fsqSubUnitAdj = fsqSubUnitAdj;' +
  ' this.fsqCanon = fsqCanon; this.keyOf = keyOf; this.searchPlaces = searchPlaces; this.FSQ_SUBUNIT = FSQ_SUBUNIT;' +
  ' this.FSQ_LM_FAR_KM = FSQ_LM_FAR_KM; this.FSQ_SHORT_Q = FSQ_SHORT_Q;';
const ctx = { PLACES_BASE: 'data/places/', getJSON: async () => { throw new Error('no network in tests'); }, console };
vm.createContext(ctx);
vm.runInContext(code, ctx);
const { normWords, fsqQuality, fsqOrderTier, fsqSubUnitAdj, fsqCanon, keyOf, searchPlaces } = ctx;

// The original normWords, kept here as the reference for the ASCII fast path.
function refNormWords(str) {
  return String(str == null ? '' : str)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

test('normWords: ASCII fast path gives the same words as the reference', () => {
  const samples = ["Gurney Plaza's (Level 4)", 'Mid-Valley', "ab'cd`ef", 'AEON  Tebrau   City', '1 Utama', '', '  ', 'x', 'KL-Sentral@2',
    'Café Ümlaut', 'Sungai Dua’s', 'Sri-Petaling Jaya', null, undefined, 42];
  for (const s of samples) assert.equal(JSON.stringify(normWords(s)), JSON.stringify(refNormWords(s)), JSON.stringify(s));
});

test('fsqQuality: exact, starts-with, phrase-inside tiers are unchanged', () => {
  assert.equal(fsqQuality('gurney plaza', 'gurney plaza'), 3);
  assert.equal(fsqQuality('gurney plaza basement floor', 'gurney plaza'), 2.5);
  assert.equal(fsqQuality('pasar gurney plaza', 'gurney plaza'), 2);
  assert.equal(fsqQuality('gurney', 'mid valley'), 1);
});

test('fsqOrderTier: in order beats any order; whole earlier words beat partial ones; no match is 0', () => {
  assert.equal(fsqOrderTier('senai international airport jhb', 'senai ai'), 1.6, 'last word may be partial');
  assert.equal(fsqQuality('senai international airport jhb', 'senai ai'), 1.6);
  assert.equal(fsqQuality('pasar malam sungai dua', 'sung dua'), 1.3, 'an earlier partial word ranks lower');
  assert.equal(fsqQuality('usm engineering campus', 'usm camp'), 1.6);
  assert.equal(fsqOrderTier('airport senai', 'senai ai'), 1.5, 'the same words out of order still count, below in order');
  assert.equal(fsqOrderTier('city square johor bahru', 'johor bahru cit'), 1.5, 'the alias of "jb" and "cit" in any order');
  assert.equal(fsqOrderTier('airport terminal', 'senai ai'), 0, 'a word missing from the name is no match');
});

test('fsqSubUnitAdj: a sub-unit name ranks below its place unless the rider typed the sub-unit word', () => {
  const adj = (name, q) => fsqSubUnitAdj({ norm: normWords(name).join(' ') }, ' ' + normWords(q).join(' ') + ' ');
  assert.equal(adj('Gurney Plaza Basement Floor', 'gurney plaza'), -1);
  assert.equal(adj('Gurney Plaza 4th floor Toilet', 'gurney plaza'), -1);
  assert.equal(adj('Gurney Plaza Basement Floor', 'gurney plaza basement'), 0, 'typed sub-unit word keeps it');
  assert.equal(adj('Gurney Plaza', 'gurney plaza'), 0);
  assert.equal(adj('Bus Stop Sungai Dua', 'sung dua'), 0, 'a bus stop is a place of its own');
});

// Fake data: rows are [name, lat, lon, locality, category]; each row is served under the shard key of its name words.
function shardsOf(rows) {
  const byKey = new Map();
  for (const r of rows) {
    for (const w of new Set(normWords(r[0]))) {
      const k = keyOf(w);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
  }
  return async k => byKey.get(k) || [];
}
function landmark(name, lat, lon, cat, aliases = []) {
  const vs = [name, ...aliases].map(v => { const w = normWords(v); return { w, n: fsqCanon(w.join(' ')) }; }).filter(v => v.w.length);
  return { name, lat, lon, cat, vs, base: normWords(String(name).replace(/\([^)]*\)/g, ' ')).join(' ') };
}
async function search(q, center, rows, landmarks = []) {
  return searchPlaces(q, center, { getIndex: async () => ({}), getShard: shardsOf(rows), limit: 15, landmarks: async () => landmarks });
}
const JB = { lat: 1.4927, lon: 103.7414 }, KL = { lat: 3.139, lon: 101.6869 }, PEN = { lat: 5.4141, lon: 100.3288 };

test('a row whose own name carries every typed word ranks above one matched only through its locality', async () => {
  const rows = [
    ['AEON Tebrau City', 1.50575, 103.76221, '', 'Shopping Mall'],
    ['City Square Johor Bahru', 1.46207, 103.7639, 'Johor Bahru', 'Shopping Mall'],
  ];
  const out = await search('jb cit', JB, rows);
  assert.equal(out[0].name, 'City Square Johor Bahru');
});

test('a sub-unit of a mall ranks below the mall for the mall name', async () => {
  const rows = [
    ['Gurney Plaza Basement Floor', 5.43770, 100.30960, '', 'Shopping Mall'],
    ['Gurney Plaza', 5.43753, 100.30960, '', 'Shopping Mall'],
  ];
  const out = await search('gurney plaza', PEN, rows);
  assert.equal(out[0].name, 'Gurney Plaza');
  const typed = await search('gurney plaza basement', PEN, rows);
  assert.equal(typed[0].name, 'Gurney Plaza Basement Floor', 'a typed sub-unit word keeps the sub-unit first');
});

test('very short typing puts the nearby completion above a far landmark ("mal" in Johor)', async () => {
  const rows = [['Mall of Medini', 1.5, 103.6, '', 'Shopping Mall']];
  const far = [landmark('AEON Taman Maluri', 3.14, 101.5, 'Shopping Mall', ['aeon taman maluri'])];
  const out = await search('mal', JB, rows, far);
  assert.equal(out[0].name, 'Mall of Medini');
});

test('a far landmark keeps its bonus when the typed text is its own name ("penang airport" from KL)', async () => {
  const rows = [['Bayan lepas, penang airport', 3.10, 101.60, '', 'Airport']];
  const lms = [landmark('Penang International Airport (Bayan Lepas)', 5.29454, 100.25603, 'Airport', ['penang airport'])];
  const out = await search('penang airport', KL, rows, lms);
  assert.equal(out[0].name, 'Penang International Airport (Bayan Lepas)');
});

test('partial typing of a far landmark does not beat the nearby place of that name ("parad" in Johor)', async () => {
  const rows = [['Paradigm Mall', 1.51578, 103.68539, 'Johor Bahru', 'Shopping Mall']];
  const lms = [landmark('Paradigm Mall Petaling Jaya', 3.10509, 101.59572, 'Shopping Mall', ['paradigm'])];
  const out = await search('parad', JB, rows, lms);
  assert.equal(out[0].name, 'Paradigm Mall');
});

test('a landmark within 50 km keeps its full bonus for partial typing', async () => {
  const rows = [['Gurney Drive Hotel', 5.4420, 100.3110, '', 'Hotel']];
  const lms = [landmark('Gurney Drive', 5.44017, 100.30868, 'Food Street', ['gurney drive'])];
  const out = await search('gurney dr', PEN, rows, lms);
  assert.equal(out[0].name, 'Gurney Drive');
});
