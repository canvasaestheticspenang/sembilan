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
import os
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
       {labels}
FROM read_parquet(?)
WHERE country = 'MY'
  AND name IS NOT NULL AND trim(name) <> ''
  AND latitude IS NOT NULL AND longitude IS NOT NULL
  AND date_closed IS NULL
"""
HF_REPO = "foursquare/fsq-os-places"


def hf_release(token: str, release: str | None) -> str:
    """Newest dt=YYYY-MM-DD release of the (gated) Hugging Face dataset, or the one asked for."""
    if release:
        return release
    try:
        from huggingface_hub import HfApi
        files = HfApi().list_repo_files(HF_REPO, repo_type="dataset", token=token)
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"Could not list the Hugging Face dataset ({e}). Check HF_TOKEN and that you accepted the dataset terms, or pass --release.")
    dates = {m.group(1) for f in files if "/places/parquet/" in f and (m := DT_RE.search(f))}
    if not dates:
        raise SystemExit("No places release found on Hugging Face. Pass --release YYYY-MM-DD.")
    return max(dates)


def normalise_words(name: str) -> list[str]:
    s = unicodedata.normalize("NFKD", name)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    return [w for w in re.split(r"[^a-z0-9]+", s) if w]


MAX_KEY_WORDS = 2  # only the first N searchable words of a name get a shard entry (keeps the index small)
DROP_CATS = frozenset([
    "College Classroom", "College Academic Building", "College Lab", "College Residence Hall",
    "College Student Center", "Student Center", "Structure", "Road", "Housing Development",
    "Miscellaneous Store", "Food Truck", "Office", "Factory", "Parking", "Coworking Space", "Warehouse or Wholesale Store", "Building", "Corporate Office", "Business Service", "Construction", "Industrial Estate", "Home (private)", "Residential Building",
])
CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]")


def keys_for(words: list[str]) -> set[str]:
    """Shard keys for a name, in priority order: the first searchable word (usually the brand),
    then the longest remaining word (usually the most distinctive); MAX_KEY_WORDS in total."""
    cand = [w for w in words if len(w) >= 2 and w not in STOPWORDS]
    if not cand:
        return set()
    picked = [cand[0]]
    rest = sorted(range(1, len(cand)), key=lambda i: (-len(cand[i]), i))
    for i in rest:
        if len(picked) >= MAX_KEY_WORDS:
            break
        picked.append(cand[i])
    return {w[:4] if len(w) >= 4 else w for w in picked}


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
    dropped_noise = 0
    for pid, name, lat, lon, address, locality, region, labels in rows:
        name = name.strip()
        words = normalise_words(name)
        keys = keys_for(words)
        if not keys:
            no_keys += 1
            continue
        addr = (address or "").strip()
        area = (locality or "").strip()
        if not area or CJK_RE.search(area):
            area = (region or "").strip()
            if CJK_RE.search(area):
                area = ""
        cat = ""
        if labels and labels[0]:
            cat = str(labels[0]).split(">")[-1].strip()
        if cat in DROP_CATS or (not cat and not area and not addr):
            dropped_noise += 1
            continue
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
    return records, no_keys + dropped_noise


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
    ap.add_argument("--keys-in-index", action="store_true", help="list every shard key in index.json (large; the app does not need it)")
    ap.add_argument("--input", help="parquet file, glob or directory to read instead of S3")
    args = ap.parse_args(argv)

    if args.release is not None and not RELEASE_RE.match(args.release):
        ap.error("--release must look like YYYY-MM-DD")

    con = duckdb.connect()
    token = os.environ.get("HF_TOKEN", "").strip()
    use_hf = args.input is None and bool(token)
    if args.input is None or args.input.startswith("s3://") or use_hf:
        try:
            con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-east-1';")
        except duckdb.Error as e:
            raise SystemExit(f"Could not load DuckDB httpfs extension: {e}")

    if args.input:
        source = args.input
        if Path(source).is_dir():
            source = str(Path(source) / "*.parquet")
        label = args.release or args.input
    elif use_hf:
        release = hf_release(token, args.release)
        con.execute("CREATE SECRET hf_secret (TYPE HUGGINGFACE, TOKEN '" + token.replace("'", "") + "')")
        source = f"hf://datasets/{HF_REPO}/release/dt={release}/places/parquet/*.parquet"
        label = release
    else:
        release = args.release or discover_release(con)
        source = f"{S3_ROOT}/dt={release}/places/parquet/*.parquet"
        label = release
    print(f"source:  {source}")
    print(f"release: {label}")

    try:
        cols = {r[0] for r in con.execute("DESCRIBE SELECT * FROM read_parquet(?)", [source]).fetchall()}
        labels = "fsq_category_labels" if "fsq_category_labels" in cols else "NULL::VARCHAR[] AS fsq_category_labels"
        print(f"category labels column: {'yes' if 'fsq_category_labels' in cols else 'no (category text left empty)'}")
        rows = con.execute(SELECT_SQL.format(labels=labels), [source]).fetchall()
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
        "nkeys": len(shard_stats),
        "keys": {k: rows_n for k, rows_n, _, _ in shard_stats} if args.keys_in_index else {},
    }
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")

    total_raw = sum(s[2] for s in shard_stats)
    total_gz = sum(s[3] for s in shard_stats)
    print()
    print(f"unique places written: {places_out}")
    print(f"shards:                {len(shard_stats)}")
    print(f"total raw bytes:       {total_raw:,}")
    print(f"total gzip -9 bytes:   {total_gz:,}")
    print(f"dropped (no searchable words / noise categories): {no_keys}")
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
