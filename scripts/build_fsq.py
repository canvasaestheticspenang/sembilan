#!/usr/bin/env python3
"""Build static JSON search shards from the Foursquare OS Places dataset (Malaysia).

Output in --out DIR:
  <key>.json  JSON array of rows [name, lat, lon, area, cat] (compact)
  index.json  {"v":1,"built":...,"release":...,"n":...,"keys":{key: rows}}
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import math
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

import duckdb

S3_ROOT = "s3://fsq-os-places-us-east-1/release"
MAX_ROWS = 6000
DEDUPE_METERS = 60.0
STOPWORDS = frozenset(
    "jalan jln lorong lrg restoran restaurant kedai taman sekolah the and "
    "sdn bhd cafe kafe shop store".split()
)
RELEASE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DT_RE = re.compile(r"dt=(\d{4}-\d{2}-\d{2})")
SHARD_RE = re.compile(r"^[a-z0-9]+\.json$")

SELECT_SQL = """
SELECT fsq_place_id, name, latitude, longitude, address, locality, region,
       fsq_category_labels
FROM read_parquet(?)
WHERE country = 'MY'
  AND name IS NOT NULL AND trim(name) <> ''
  AND latitude IS NOT NULL AND longitude IS NOT NULL
  AND date_closed IS NULL
"""


def normalise_words(name: str) -> list[str]:
    s = unicodedata.normalize("NFKD", name)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    return [w for w in re.split(r"[^a-z0-9]+", s) if w]


def keys_for(words: list[str]) -> set[str]:
    keys = set()
    for w in words:
        if len(w) < 2 or w in STOPWORDS:
            continue
        keys.add(w[:4] if len(w) >= 4 else w)
    return keys


def dist_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371000.0 * math.asin(min(1.0, math.sqrt(a)))


def discover_release(con: duckdb.DuckDBPyConnection) -> str:
    pattern = f"{S3_ROOT}/dt=*/places/parquet/places-00000.zstd.parquet"
    try:
        files = [r[0] for r in con.execute("SELECT file FROM glob(?)", [pattern]).fetchall()]
    except duckdb.Error as e:
        raise SystemExit(f"Could not list S3 to find the newest release ({e}). Pass --release YYYY-MM-DD.")
    dates = {m.group(1) for f in files if (m := DT_RE.search(f))}
    if not dates:
        raise SystemExit("No dt=YYYY-MM-DD release folders found on S3. Pass --release YYYY-MM-DD.")
    return max(dates)


def build_records(rows) -> tuple[list[dict], int]:
    """Turn query rows into records with keys. Returns (records, places_without_keys)."""
    records: list[dict] = []
    no_keys = 0
    for pid, name, lat, lon, address, locality, region, labels in rows:
        name = name.strip()
        words = normalise_words(name)
        keys = keys_for(words)
        if not keys:
            no_keys += 1
            continue
        addr = (address or "").strip()
        area = (locality or region or "").strip()
        cat = ""
        if labels and labels[0]:
            cat = str(labels[0]).split(">")[-1].strip()
        records.append({
            "pid": pid,
            "name": name,
            "nname": " ".join(words),
            "lat": float(lat),
            "lon": float(lon),
            "area": area,
            "cat": cat,
            "keys": keys,
            "has_info": bool(addr or area),
        })
    # Rows with address/area first, so the dedupe keeps the richer copy and the cap keeps it.
    records.sort(key=lambda r: (not r["has_info"], str(r["pid"])))
    return records, no_keys


def dedupe(records: list[dict]) -> tuple[list[dict], int]:
    """Drop records with the same normalised name within DEDUPE_METERS of a kept one."""
    grid: dict[str, dict[tuple[int, int], list[tuple[float, float]]]] = defaultdict(dict)
    kept: list[dict] = []
    dropped = 0
    for r in records:
        ci, cj = math.floor(r["lat"] * 1000), math.floor(r["lon"] * 1000)
        cells = grid[r["nname"]]
        is_dup = False
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for plat, plon in cells.get((ci + di, cj + dj), ()):
                    if dist_m(r["lat"], r["lon"], plat, plon) <= DEDUPE_METERS:
                        is_dup = True
                        break
                if is_dup:
                    break
            if is_dup:
                break
        if is_dup:
            dropped += 1
            continue
        cells.setdefault((ci, cj), []).append((r["lat"], r["lon"]))
        kept.append(r)
    return kept, dropped


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build Foursquare Malaysia search shards.")
    ap.add_argument("--out", required=True, type=Path, help="output directory")
    ap.add_argument("--release", help="release date YYYY-MM-DD (default: newest on S3)")
    ap.add_argument("--input", help="parquet file, glob or directory to read instead of S3")
    args = ap.parse_args(argv)

    if args.release is not None and not RELEASE_RE.match(args.release):
        ap.error("--release must look like YYYY-MM-DD")

    con = duckdb.connect()
    if args.input is None or args.input.startswith("s3://"):
        try:
            con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-east-1';")
        except duckdb.Error as e:
            raise SystemExit(f"Could not load DuckDB httpfs extension: {e}")

    if args.input:
        source = args.input
        if Path(source).is_dir():
            source = str(Path(source) / "*.parquet")
        label = args.release or args.input
    else:
        release = args.release or discover_release(con)
        source = f"{S3_ROOT}/dt={release}/places/parquet/*.parquet"
        label = release
    print(f"source:  {source}")
    print(f"release: {label}")

    try:
        rows = con.execute(SELECT_SQL, [source]).fetchall()
    except duckdb.Error as e:
        raise SystemExit(f"Failed to read {source}: {e}")
    print(f"rows after MY/open/name/coords filter: {len(rows)}")

    records, no_keys = build_records(rows)
    kept, dropped_dedupe = dedupe(records)

    shards: dict[str, list[dict]] = defaultdict(list)
    for r in kept:
        for k in r["keys"]:
            shards[k].append(r)

    capped_entries = 0
    for k, lst in shards.items():
        lst.sort(key=lambda r: not r["has_info"])  # stable: keeps priority order within groups
        if len(lst) > MAX_ROWS:
            capped_entries += len(lst) - MAX_ROWS
            shards[k] = lst[:MAX_ROWS]

    present = {id(r) for lst in shards.values() for r in lst}
    places_out = len(present)
    dropped_cap_places = len(kept) - places_out

    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    for old in out.iterdir():  # clear stale shards from an earlier build
        if old.is_file() and SHARD_RE.match(old.name) and old.name != "index.json":
            old.unlink()

    shard_stats = []
    for k in sorted(shards):
        lst = shards[k]
        payload = [[r["name"], round(r["lat"], 5), round(r["lon"], 5), r["area"], r["cat"]] for r in lst]
        data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        (out / f"{k}.json").write_bytes(data)
        shard_stats.append((k, len(lst), len(data), len(gzip.compress(data, compresslevel=9))))

    index = {
        "v": 1,
        "built": dt.datetime.now(dt.timezone.utc).date().isoformat(),
        "release": label,
        "n": places_out,
        "keys": {k: rows_n for k, rows_n, _, _ in shard_stats},
    }
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    total_raw = sum(s[2] for s in shard_stats)
    total_gz = sum(s[3] for s in shard_stats)
    print()
    print(f"unique places written: {places_out}")
    print(f"shards:                {len(shard_stats)}")
    print(f"total raw bytes:       {total_raw:,}")
    print(f"total gzip -9 bytes:   {total_gz:,}")
    print(f"dropped, no searchable words: {no_keys}")
    print(f"dropped, dedupe (<= {DEDUPE_METERS:.0f} m, same name): {dropped_dedupe}")
    print(f"dropped, shard cap ({MAX_ROWS} rows): {capped_entries} shard entries, "
          f"{dropped_cap_places} places missing from every shard")
    print()
    print("10 biggest shards:")
    print(f"  {'key':<8}{'rows':>8}{'raw':>12}{'gzip':>10}")
    for k, n, raw, gz in sorted(shard_stats, key=lambda s: s[2], reverse=True)[:10]:
        print(f"  {k:<8}{n:>8}{raw:>12,}{gz:>10,}")
    if not shard_stats:
        print("WARNING: no places matched; index.json written with zero keys.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
