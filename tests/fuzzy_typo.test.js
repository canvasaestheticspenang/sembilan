'use strict';
// Unit tests for the typo pass in index.html. The helpers are pulled out of the
// inline script by their line markers, so the tests run the code the app ships.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const from = html.indexOf("const FSQ_ALIAS = {");
const to = html.indexOf("function fsqCanon(str)");
// FSQ_ALIAS, fsqTokMatch, fsqMatches and the typo block all sit between these markers.
const code = html.slice(from, to) +
  "\n;this.fzDL = fzDL; this.fzWordDist = fzWordDist; this.fzItemDist = fzItemDist; this.fzKeyVariants = fzKeyVariants; this.FZ_BAND = FZ_BAND;";
const ctx = {};
vm.createContext(ctx);
vm.runInContext(code, ctx);
const { fzDL, fzWordDist, fzItemDist, fzKeyVariants, FZ_BAND } = ctx;

// Reference OSA distance without early exit.
function refOSA(a, b) {
  const d = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}

test('fzDL matches the reference OSA distance, with early exit above max', () => {
  const alpha = 'abcd';
  let seed = 7;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const word = () => Array.from({ length: rnd(7) }, () => alpha[rnd(alpha.length)]).join('');
  for (let i = 0; i < 3000; i++) {
    const a = word(), b = word(), max = rnd(3) + 1;
    const exact = refOSA(a, b);
    assert.equal(fzDL(a, b, max), exact <= max ? exact : max + 1, `${a} vs ${b} max ${max}`);
  }
  assert.equal(fzDL('ca', 'abc', 3), 3, 'OSA: "ca" to "abc" is 3 (no unrestricted transposition)');
});

test('fzWordDist: typo words within the allowed distance', () => {
  assert.equal(fzWordDist('gurney', 'gurny'), 1);
  assert.equal(fzWordDist('mcdonalds', 'mcdonals'), 1);
  assert.equal(fzWordDist('pavilion', 'pavillion'), 1);
  assert.equal(fzWordDist('sunway', 'sunwey'), 1);
  assert.equal(fzWordDist('butterworth', 'butterwoth'), 1);
  assert.equal(fzWordDist('universiti', 'universti'), 1);
  assert.equal(fzWordDist('universiti', 'univerrsti'), 2, '8+ chars allow 2 edits');
  assert.equal(fzWordDist('universiti', 'uniivrsitt'), -1, 'three edits exceed the 8+ allowance');
});

test('fzWordDist: exact and prefix hits return 0, non-matches return -1', () => {
  assert.equal(fzWordDist('gurney', 'gurney'), 0);
  assert.equal(fzWordDist('gurney', 'gur'), 0, 'short prefix is an exact-prefix hit');
  assert.equal(fzWordDist('gurney', 'gurnyxyz'), -1);
  assert.equal(fzWordDist('kuala', 'pasar'), -1);
  assert.equal(fzWordDist('sentral', 'sen'), 0);
  assert.equal(fzWordDist('lumpur', 'lumpu2'), -1, 'tokens with digits never fuzz');
});

test('fzWordDist: tokens under 4 chars never fuzz', () => {
  assert.equal(fzWordDist('mall', 'mal1'), -1);
  assert.equal(fzWordDist('pen', 'pn'), -1);
});

test('fzItemDist takes the worst token over the best word per token', () => {
  const words = ['sunway', 'pyramid', 'shopping', 'mall'];
  assert.equal(fzItemDist(words, ['sunwey', 'pyramid']), 1);
  assert.equal(fzItemDist(words, ['sunwey', 'pyrmid']), 1);
  assert.equal(fzItemDist(words, ['sunway', 'mall']), 0);
  assert.equal(fzItemDist(words, ['sunwey', 'airport']), -1);
});

test('fzKeyVariants: single edits of the 4-char shard key, 4 chars each, no duplicates', () => {
  const v = fzKeyVariants('suwnay');
  assert.ok(v.includes('sunw'), 'transposition of the typed key');
  for (const k of v) assert.equal(k.length, 4);
  assert.equal(new Set(v).size, v.length);
  assert.ok(fzKeyVariants('gurney').includes('gurn') === false, 'the typed key itself is excluded');
  assert.ok(fzKeyVariants('mcdnalds').length > 0);
});

test('fuzzy band sits below any strict score', () => {
  // Strict scores: quality (1..3) + category (-1.2..1.1) - distance term (at most 2.2).
  const strictMin = 1 - 1.2 - 2.2;
  assert.ok(FZ_BAND + 3 + 1.1 - 1.5 < strictMin - 50, 'band is far below strict scores');
});
