#!/usr/bin/env python3
"""Build the category tiles that category-only searches ("masjid", "hospital near me") read.

usage: python3 scripts/build_category_tiles.py <places_dir> <out_dir> [--index-html index.html]
                                              [--tile 0.2] [--fine 0.1]

Reads the shard files of data/places/ (rows [name, lat, lon, locality, category]) and the
category lists of QU_ALIASES in index.html (the single source of truth for which Foursquare
categories an intent covers). Writes:

  <out_dir>/cat/<intent>/<latTile>_<lonTile>.json   {"cats": [...], "rows": [[name, lat, lon, locality, catIndex], ...]}
  <out_dir>/cat/manifest.json                        tile size per intent, row counts, byte sizes

latTile = floor(lat / tileDeg). Intents in FINE_IDS use the finer --fine tile (dense categories).
Defaults 0.2 / 0.1 degrees: same search results as 0.1 / 0.05 in the benchmark, half the files (about 28k instead of 55k).
The app works without this folder: a missing cat/manifest.json makes category-only queries fall
back to the name shards. Run it in a GitHub Action (or by hand) and publish the cat/ folder next
to data/places/. Nothing here is needed at build time for the app itself.
"""
import argparse
import json
import math
import os
import re
import sys

FINE_IDS = {'restaurant', 'stall', 'malay_food', 'cafe', 'car_repair', 'clinic', 'apartment', 'kopitiam',
            'chinese_food', 'hair', 'burger', 'clothing'}


def load_aliases(index_html):
    """Return the QU_ALIASES object embedded in index.html."""
    text = open(index_html, encoding='utf8').read()
    start = text.index('const QU_ALIASES = ') + len('const QU_ALIASES = ')
    end = text.index(';\nQU.setAliases(QU_ALIASES);', start)
    return json.loads(text[start:end])


def cat_pattern_to_re(s):
    if s.startswith('*'):
        return '.*' + re.escape(s[1:])
    if s.endswith('*'):
        return re.escape(s[:-1]) + '.*'
    return re.escape(s)


def intent_regexes(aliases):
    """id -> (label, compiled regex, cats) for every category concept that lists cats (same rule as QU.intentRegexes)."""
    out = {}
    for c in aliases.get('categories', []):
        cats = c.get('cats') or []
        uniq = []
        for x in cats:
            if x not in uniq:
                uniq.append(x)
        if not uniq:
            continue
        pat = '^(?:' + '|'.join(cat_pattern_to_re(x) for x in uniq) + ')$'
        out[c['id']] = (c.get('label') or c['id'], re.compile(pat, re.I), cats)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('places_dir')
    ap.add_argument('out_dir')
    ap.add_argument('--index-html', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'index.html'))
    ap.add_argument('--tile', type=float, default=0.2)
    ap.add_argument('--fine', type=float, default=0.1)
    args = ap.parse_args()

    regs = intent_regexes(load_aliases(args.index_html))
    ids = list(regs.keys())
    tile_of = {i: (args.fine if i in FINE_IDS else args.tile) for i in ids}
    per = {i: {} for i in ids}          # id -> tileKey -> {'cats': [], 'catIdx': {}, 'rows': []}
    memo = {}
    seen = set()
    files = shard_rows = 0

    def intents_for(cat):
        if cat not in memo:
            memo[cat] = [i for i in ids if regs[i][1].match(cat)]
        return memo[cat]

    for fn in sorted(f for f in os.listdir(args.places_dir) if f.endswith('.json')):
        try:
            with open(os.path.join(args.places_dir, fn), encoding='utf8') as fh:
                arr = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(arr, list):
            continue
        files += 1
        for r in arr:
            if not isinstance(r, list) or len(r) < 3:
                continue
            shard_rows += 1
            cat = '' if len(r) < 5 or r[4] is None else str(r[4])
            targets = intents_for(cat)
            if not targets:
                continue
            name = '' if r[0] is None else str(r[0])
            key = (name, r[1], r[2], cat)
            if key in seen:            # a place is stored under each of its name-word shards
                continue
            seen.add(key)
            loc = '' if len(r) < 4 or r[3] is None else str(r[3])
            for i in targets:
                t = tile_of[i]
                tk = '%d_%d' % (math.floor(r[1] / t), math.floor(r[2] / t))
                bucket = per[i].get(tk)
                if bucket is None:
                    bucket = per[i][tk] = {'cats': [], 'catIdx': {}, 'rows': []}
                ci = bucket['catIdx'].get(cat)
                if ci is None:
                    ci = bucket['catIdx'][cat] = len(bucket['cats'])
                    bucket['cats'].append(cat)
                bucket['rows'].append([name, r[1], r[2], loc, ci])

    cat_dir = os.path.join(args.out_dir, 'cat')
    manifest = {'tileDeg': args.tile, 'fineTileDeg': args.fine, 'shardFilesRead': files,
                'shardRowsRead': shard_rows, 'intents': {}}
    total_bytes = total_tiles = total_rows = 0
    for i in ids:
        tiles = per[i]
        if not tiles:
            continue
        d = os.path.join(cat_dir, i)
        os.makedirs(d, exist_ok=True)
        sizes = []
        rows = 0
        for tk, b in tiles.items():
            txt = json.dumps({'cats': b['cats'], 'rows': b['rows']}, ensure_ascii=False, separators=(',', ':'))
            data = txt.encode('utf8')
            with open(os.path.join(d, tk + '.json'), 'wb') as fh:
                fh.write(data)
            sizes.append(len(data))
            rows += len(b['rows'])
        sizes.sort()
        manifest['intents'][i] = {'label': regs[i][0], 'tileDeg': tile_of[i], 'tiles': len(tiles), 'rows': rows,
                                  'rawBytes': sum(sizes), 'tileBytesMedian': sizes[len(sizes) // 2],
                                  'tileBytesMax': sizes[-1]}
        total_bytes += sum(sizes)
        total_tiles += len(tiles)
        total_rows += rows
    os.makedirs(cat_dir, exist_ok=True)
    with open(os.path.join(cat_dir, 'manifest.json'), 'w', encoding='utf8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
    print(json.dumps({'intents': len(manifest['intents']), 'tileFiles': total_tiles, 'rows': total_rows,
                      'totalMB': round(total_bytes / 1e6, 2), 'shardFiles': files}))


if __name__ == '__main__':
    sys.exit(main())
