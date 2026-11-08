'use strict';
// Tests for the typo pass of searchPlaces in index.html: spelling variants, shard-key probes, corrected tiers,
// landmark typo matches, typo-tolerant category words and the far-result fallback. The inline script is cut from the
// line markers below and run in a vm context with in-memory shards, so the tests exercise the code the app ships.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const from = html.indexOf('const FSQ_STOPWORDS');
const to = html.indexOf('let placesIdxP');
const code = html.slice(from, to) +
  '\n;this.searchPlaces = searchPlaces; this.QU = QU; this.fzPhon = fzPhon; this.fzWordDist = fzWordDist;' +
  ' this.fzKeyVariants = fzKeyVariants; this.fzItemFix = fzItemFix; this.fsqFuzzyItems = fsqFuzzyItems;' +
  ' this.FSQ_PREPARED = FSQ_PREPARED;';
const ctx = { console, document: { querySelector: () => null }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  native: { isNative: false }, PLACES_BASE: 'data/places/', REMOTE_DATA_BASE: 'data/', getJSON: () => Promise.resolve({}) };
vm.createContext(ctx);
vm.runInContext(code, ctx);
const { searchPlaces, QU, fzPhon, fzWordDist, fzKeyVariants, fzItemFix } = ctx;

const PEN = { lat: 5.4141, lon: 100.3288 };

// In-memory shards: key -> rows [name, lat, lon, locality, category]. A missing key is an empty list.
function shardsOf(map) {
  return { getShard: async k => (map[k] || []), getIndex: () => null };
}
async function search(q, shards, extra) {
  return searchPlaces(q, PEN, Object.assign({ limit: 15 }, shards, extra || {}));
}

test('fzPhon folds the spelling variants of Malaysian names to one form', () => {
  assert.equal(fzPhon('syah'), fzPhon('shah'), 'sh and sy');
  assert.equal(fzPhon('shaah'), fzPhon('syah'), 'a doubled vowel folds too');
  assert.equal(fzPhon('phenang'), fzPhon('fenang'), 'ph and f');
  assert.equal(fzPhon('bangsar'), 'bangsar', 'a plain name is unchanged');
  assert.notEqual(fzPhon('kedah'), fzPhon('kedar'), 'different names stay different');
});

test('fzWordDist: a spelling variant of two edits is one typo', () => {
  assert.equal(fzWordDist('syah', 'shaah'), 1, 'sh/sy and a doubled vowel');
  assert.equal(fzWordDist('penang', 'fenang'), 1);
  assert.equal(fzWordDist('butterworth', 'butterwoth'), 1, 'plain typo is unchanged');
  assert.equal(fzWordDist('kuala', 'pasar'), -1, 'unrelated words still never match');
  assert.equal(fzWordDist('gurney', 'gur'), 0, 'prefix is still exact');
});

test('fzKeyVariants probes a letter left out of the first four characters', () => {
  const v = fzKeyVariants('sntral');
  assert.ok(v.includes('sent'), 'the key with a vowel inserted');
  assert.ok(v.every(k => k.length === 4));
  assert.equal(new Set(v).size, v.length);
  assert.ok(fzKeyVariants('sheras').includes('sera'), 'phonetic pair sh/s gives the other spelling');
});

test('fzItemFix returns the corrected words of a typo item', () => {
  const r = fzItemFix(['sunway', 'pyramid', 'mall'], ['sunwey', 'pyramid']);
  assert.equal(r.dist, 1);
  assert.deepEqual([...r.corr], ['sunway', 'pyramid'], 'vm realm array copied to this realm');
  assert.equal(fzItemFix(['sunway'], ['airport']).dist, -1);
});

test('QU: a misspelt category word reads as a category, an exact or name query does not', () => {
  const typo = QU.parseQuery('stesen minyk');
  assert.equal(typo.typoCat, true);
  assert.ok(typo.intentIds.includes('fuel'));
  assert.equal(typo.catOnly, true);
  assert.equal(QU.parseQuery('stesen minyak').typoCat, false, 'exact form is not a typo reading');
  assert.equal(QU.parseQuery('sunway pyramid').typoCat, false, 'no category word');
  assert.equal(QU.parseQuery('stesen minyk', { noTypoCat: true }).typoCat, false, 'option turns it off');
});

test('a misspelt name ranks its near corrected rows above far strict misspellings', async () => {
  // Data holds misspelt "McDonals" rows in other states; the rider in Penang means the McDonald's nearby.
  const shards = shardsOf({
    mcdo: [
      ['McDonals', 3.1376, 101.6095, 'Petaling Jaya', 'Fast Food Restaurant'],
      ['McDonals', 3.0, 101.7, 'Seri Kembangan', 'Fast Food Restaurant'],
      ['McDonals', 2.9, 101.5, 'Bangi', 'Fast Food Restaurant'],
      ['McDonal\'s', 5.4152, 100.3300, 'George Town', 'Fast Food Restaurant']
    ]
  });
  const res = await search('mcdonals', shards);
  assert.equal(res[0].name, 'McDonal\'s');
});

test('strict hits stay ahead of typo hits when a strict hit is good', async () => {
  const shards = shardsOf({
    gurn: [
      ['Gurney Plaza', 5.4375, 100.3096, '', 'Shopping Mall'],
      ['Gurney Walk', 5.4400, 100.3100, '', 'Shopping Mall'],
      ['Gurnet Cafe', 5.4150, 100.3290, '', 'Cafe']
    ]
  });
  const res = await search('gurney', shards);
  assert.equal(res[0].name, 'Gurney Plaza');
  assert.ok(res.findIndex(r => r.name === 'Gurnet Cafe') > 1, 'the misspelt row does not come first');
});

test('a landmark matches its alias through a typo and keeps the curated tier', async () => {
  const landmarks = [{ name: 'Komtar', lat: 5.41588, lon: 100.33092, cat: 'Shopping Mall', base: 'komtar',
    vs: [{ w: ['komtar'], n: 'komtar' }, { w: ['komtar', 'penang'], n: 'komtar penang' }] }];
  const shards = shardsOf({
    komt: [['Komtar Hotel Sdn Bhd', 5.4145, 100.3295, '', 'Hotel']]
  });
  const res = await search('komtr', shards, { landmarks: async () => landmarks });
  assert.equal(res[0].name, 'Komtar');
  assert.equal(res[0].lm, true);
});

test('a misspelt name that reads as a category still finds the named rows nearby', async () => {
  // "pasr malam" names a place. Its category reading must not hide the named night markets close by.
  const shards = shardsOf({
    pasa: [
      ['Pasar Malam Jalan Tull', 5.4245, 100.3290, '', 'Night Market'],
      ['Pasar Malam Kepong', 3.2080, 101.6225, '', 'Night Market']
    ]
  });
  const res = await search('pasr malam', shards);
  assert.equal(res[0].name, 'Pasar Malam Jalan Tull');
});

test('fsqFuzzyItems reports the corrected phrase of each typo row', async () => {
  const shards = shardsOf({ gurn: [['Gurney Plaza', 5.4375, 100.3096, '', 'Shopping Mall']] });
  const out = await ctx.fsqFuzzyItems(['gurny'], ['gurn'], shards.getShard);
  assert.equal(out.length, 1);
  assert.equal(out[0].dist, 1);
  assert.equal(out[0].corr, 'gurney');
});
