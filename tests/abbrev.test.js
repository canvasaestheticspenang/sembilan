'use strict';
// Abbreviation, spelling-variant, numeral and modifier handling, and the ranking rules they depend on.
// Part A runs the query-understanding module (QU) pulled out of index.html by its markers.
// Part B runs searchPlaces in the app itself, with canned shard rows and landmarks.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { withApp } = require('./helpers.js');

const TIMEOUT = 20000;
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const qFrom = html.indexOf('var QU = (function');
const qTo = html.indexOf('// Prefix-quality tier');
assert.ok(qFrom > 0 && qTo > qFrom, 'QU module and alias tables found by their markers');
const ctxQ = {};
vm.createContext(ctxQ);
// typoCatSpans (in QU) calls fzDL, the edit distance defined in the typo section: load it too.
const dFrom = html.indexOf('// Optimal-string-alignment distance');
const dTo = html.indexOf('// Word-level distance between a typed token');
assert.ok(dFrom > 0 && dTo > dFrom, 'fzDL found by its markers');
vm.runInContext(html.slice(qFrom, qTo) + '\n' + html.slice(dFrom, dTo) + '\n;this.QU = QU;', ctxQ);
const QU = ctxQ.QU;

const alts = (t) => QU.tokenAlts(t);
const parse = (q) => QU.parseQuery(q);

describe('query understanding: abbreviations, spelling variants and numerals', () => {
  it('road, place and school abbreviations expand both ways', () => {
    assert.ok(alts('jln').includes('jalan'));
    assert.ok(alts('tmn').includes('taman'));
    assert.ok(alts('bdr').includes('bandar'));
    assert.ok(alts('kg').includes('kampung') && alts('kg').includes('kampong'), 'kampong spelling');
    assert.ok(alts('lbh').includes('lebuh'));
    assert.ok(alts('blk').includes('blok') && alts('blk').includes('block'), 'block words');
    assert.ok(alts('srjk').includes('sekolah rendah jenis kebangsaan'));
    assert.ok(alts('smjk').includes('sekolah menengah jenis kebangsaan'));
    assert.ok(alts('poli').includes('politeknik'));
  });

  it('Penang and Malaysian spelling variants: tg, sungei, pulo', () => {
    assert.ok(alts('tg').includes('tanjong') && alts('tg').includes('tanjung'), 'tg as tanjung and tanjong');
    assert.ok(alts('tanjong').includes('tanjung'), 'the older spelling links back');
    assert.ok(alts('sg').includes('sungei') && alts('sg').includes('sungai'), 'sungai and sungei');
    assert.ok(alts('pulo').includes('pulau'));
  });

  it('university, hospital and transport acronyms expand to their full names', () => {
    assert.ok(alts('uthm').includes('universiti tun hussein onn malaysia'));
    assert.ok(alts('upsi').includes('universiti pendidikan sultan idris'));
    assert.ok(alts('umk').includes('universiti malaysia kelantan'));
    assert.ok(alts('hukm').includes('hospital universiti kebangsaan malaysia'));
    assert.ok(alts('hkl').includes('hospital kuala lumpur'));
    assert.ok(alts('hpp').includes('hospital pulau pinang'));
    assert.ok(alts('tbs').includes('terminal bersepadu selatan'));
    assert.ok(alts('mrsm').includes('maktab rendah sains mara'));
    assert.ok(alts('ktm').includes('keretapi tanah melayu'), 'existing entry kept');
  });

  it('numerals: Malay words and roman numerals link to the digit', () => {
    assert.ok(alts('dua').includes('2') && alts('2').includes('dua'));
    assert.ok(alts('satu').includes('1'));
    assert.ok(alts('ii').includes('2') && alts('2').includes('ii'), 'roman II');
    assert.ok(alts('sepuluh').includes('10'));
    assert.ok(alts('one').includes('1'), 'existing English numeral kept');
  });

  it('brand spellings: one brand as one word or two', () => {
    assert.ok(alts('maybank').includes('may bank'));
    assert.ok(alts('ambank').includes('am bank'));
    assert.ok(alts('bsn').includes('bank simpanan nasional'));
    assert.ok(alts('mcd').includes('mcdonald'));
    assert.ok(alts('7eleven').includes('7 eleven'));
    assert.ok(alts('familymart').includes('family mart'));
    assert.ok(alts('speedmart').includes('speed mart'));
    assert.ok(alts('oldtown').includes('old town'));
  });

  it('a modifier is dropped from a query that names a category, kept otherwise', () => {
    const hotel = parse('hotel murah');
    assert.equal(hotel.intentLabel, 'Hotel');
    assert.equal(hotel.catOnly, true, 'no name words left: category only');
    assert.equal(hotel.tokens.length, 0);
    assert.equal(parse('kedai kopi 24 jam').catOnly, true);
    assert.equal(JSON.stringify(parse('murah').tokens.map((t) => t.t)), '["murah"]', 'no category: the word stays a name word');
  });
});

describe('search ranking: far landmarks, category-only rows, shard keys', () => {
  const PEN = { lat: 5.4141, lon: 100.3288 };
  const KL = { lat: 3.139, lon: 101.687 };
  // Shard rows: [name, lat, lon, locality, cat]
  const search = (ctx, q, rows, centre, opts = {}) => ctx.app.searchPlaces(q, centre, {
    getIndex: async () => ({}), getShard: async () => rows, limit: 8, landmarks: ctx.app.getLandmarks, ...opts,
  });

  it('a far curated landmark does not outrank the rows near the rider', { timeout: TIMEOUT }, async () => {
    const lms = [['Pasar Malam Kepong', 3.20237, 101.64501, 'night_market', ['kepong night market', 'pasar malam kepong']]];
    const rows = [
      ['Pasar Malam Jalan Tull', 5.4170, 100.3320, 'Penang', 'Night Market'],
      ['Pasar Malam Tanjung Tokong', 5.4500, 100.3500, 'Penang', 'Night Market'],
    ];
    await withApp({ landmarks: lms }, async (ctx) => {
      const r = await search(ctx, 'pasar malam', rows, PEN);
      assert.equal(r[0].name, 'Pasar Malam Jalan Tull', 'the rider\'s own night market first: ' + r.map((p) => p.name));
      assert.ok(r.some((p) => p.name === 'Pasar Malam Kepong'), 'the far one is still listed');
    });
  });

  it('a landmark whose alias (not its name or category) carries the typed word is not the category', { timeout: TIMEOUT }, async () => {
    const lms = [['Bangsar LRT Station', 3.12762, 101.67907, 'rail', ['bangsar lrt', 'bank rakyat bangsar']]];
    const rows = [['CIMB Bank', 3.1400, 101.6880, 'Kuala Lumpur', 'Bank']];
    await withApp({ landmarks: lms }, async (ctx) => {
      const r = await search(ctx, 'bank', rows, KL);
      assert.equal(r[0].name, 'CIMB Bank', 'a bank first: ' + r.map((p) => p.name));
    });
  });

  it('a row named with the typed word leads a curated landmark that only shares the category', { timeout: TIMEOUT }, async () => {
    const lms = [['Masjid Kapitan Keling, George Town', 5.41661, 100.33759, 'religion', ['kapitan keling mosque', 'masjid kapitan']]];   // about 0.3 km
    const rows = [['Surau Cosmopoint Penang', 5.4141, 100.3400, '', 'Mosque']];   // about 1.2 km, the name spells "surau"
    await withApp({ landmarks: lms }, async (ctx) => {
      const r = await search(ctx, 'surau', rows, PEN);
      assert.equal(r[0].name, 'Surau Cosmopoint Penang', 'the surau first: ' + r.map((p) => p.name));
      assert.ok(r.some((p) => p.name === 'Masjid Kapitan Keling, George Town'), 'the mosque is still listed');
    });
  });

  it('"hotel murah" lists the hotels near the rider, not only names that carry "murah"', { timeout: TIMEOUT }, async () => {
    const rows = [
      ['Hotel murah', 5.4500, 100.3600, 'Penang', 'Hotel'],
      ['Hotel Seri Malaysia', 5.4160, 100.3300, '', 'Hotel'],
    ];
    await withApp({ landmarks: [] }, async (ctx) => {
      const r = await search(ctx, 'hotel murah', rows, PEN);
      assert.equal(r[0].name, 'Hotel Seri Malaysia', 'the near hotel first: ' + r.map((p) => p.name));
    });
  });

  it('"taman desa 2" finds "Taman Desa II"; the roman rule keeps "IIUM" out', { timeout: TIMEOUT }, async () => {
    const rows = [
      ['Taman Desa II', 5.4200, 100.3330, 'Penang', ''],
      ['IIUM Taman Desa', 5.4210, 100.3340, 'Penang', ''],
    ];
    await withApp({ landmarks: [] }, async (ctx) => {
      const r = await search(ctx, 'taman desa 2', rows, PEN);
      assert.equal(r[0].name, 'Taman Desa II', 'roman II found by the digit: ' + r.map((p) => p.name));
      assert.ok(!r.some((p) => /IIUM/.test(p.name)), '"2" is not a prefix of "iium": ' + r.map((p) => p.name));
    });
  });

  it('"sungai 2" finds "Sungai Dua" (Malay numeral)', { timeout: TIMEOUT }, async () => {
    const rows = [['Sungai Dua Printing', 5.4300, 100.3600, 'Gelugor', '']];
    await withApp({ landmarks: [] }, async (ctx) => {
      const r = await search(ctx, 'sungai 2', rows, PEN);
      assert.equal(r[0] && r[0].name, 'Sungai Dua Printing', r.map((p) => p.name).join(', '));
    });
  });

  it('"sg wang" finds "Sungei Wang Plaza" (sungai and sungei are one word)', { timeout: TIMEOUT }, async () => {
    const rows = [['Sungei Wang Plaza', 3.14512, 101.71132, 'Kuala Lumpur', 'Shopping Mall']];
    // the shard holds "sung" words only, so the alias key ("sung" from sungei) must be read
    await withApp({ landmarks: [] }, async (ctx) => {
      const r = await ctx.app.searchPlaces('sg wang', KL, {
        getIndex: async () => ({}), getShard: async (k) => (k === 'sung' ? rows : null), limit: 8, landmarks: ctx.app.getLandmarks,
      });
      assert.equal(r[0] && r[0].name, 'Sungei Wang Plaza', r.map((p) => p.name).join(', '));
    });
  });

  it('"tg tokong" reads the tanjung shard for a row spelt "Tanjung Tokong"', { timeout: TIMEOUT }, async () => {
    const rows = [['Tanjung Tokong Ferry', 5.4700, 100.3100, 'Penang', 'Ferry']];
    await withApp({ landmarks: [] }, async (ctx) => {
      const r = await ctx.app.searchPlaces('tg tokong', PEN, {
        getIndex: async () => ({}), getShard: async (k) => (k === 'tanj' ? rows : null), limit: 8, landmarks: ctx.app.getLandmarks,
      });
      assert.equal(r[0] && r[0].name, 'Tanjung Tokong Ferry', r.map((p) => p.name).join(', '));
    });
  });

  it('a category word\'s own shard is read even when spelling variants also need shards', { timeout: TIMEOUT }, async () => {
    // "pulau" has a spelling variant ("pulo") that adds a shard key; the hospital shard must still be read
    const rows = [['Forensic, General Hospital Pulau Pinang', 5.41492, 100.33835, '', 'Hospital']];
    // Rows from the name shards already hold a strict hospital hit, so the typo pass (which reads every key) stays off.
    const plain = [['Pulau Pinang Plaza', 5.4300, 100.3400, '', ''], ['Hospital Seberang Jaya Pulau Pinang', 5.4310, 100.3410, '', 'Hospital'], ['Pulau Pinang Hall', 5.4320, 100.3420, '', '']];
    await withApp({ landmarks: [] }, async (ctx) => {
      const r = await ctx.app.searchPlaces('hospital pulau pinang', PEN, {
        getIndex: async () => ({}), getShard: async (k) => (k === 'hosp' ? rows : (k === 'pula' || k === 'pina') ? plain : null), limit: 8, landmarks: ctx.app.getLandmarks,
      });
      assert.ok(r.some((p) => /Forensic/.test(p.name)), 'hospital shard read: ' + r.map((p) => p.name));
    });
  });
});
