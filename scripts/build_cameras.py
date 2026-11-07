#!/usr/bin/env python3
"""Build data/cameras.json: Malaysian fixed speed-camera nodes from OpenStreetMap.

Source: Overpass API (OpenStreetMap, ODbL 1.0). Nothing from Waze, Google, TuJu,
Lapan or any other app is used. See docs/speed-cameras.md.

Output (compact JSON):
  {"asof": "YYYY-MM-DD", "src": "...", "c": [[lat, lon, type, dir|null, limit|null], ...]}
  type   0 = speed camera (highway=speed_camera / enforcement=maxspeed device)
         1 = same, but tagged as AES / AWAS (JPJ) in name, operator, ref, brand...
  dir    camera bearing in degrees (0-359) when OSM has a numeric/cardinal direction, else null
  limit  km/h when OSM has a plain numeric maxspeed, else null

Usage:  python3 scripts/build_cameras.py [out.json] [--min N] [--endpoint URL ...]
Exit status is non-zero (and the existing file is left untouched) if Overpass
cannot be reached or returns suspiciously few cameras.
"""
import argparse
import datetime
import json
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Peninsular Malaysia + Sabah + Sarawak. Also catches bits of Singapore, Brunei
# and neighbours; harmless for an on-route lookup.
BBOX = (0.8, 99.5, 7.5, 119.5)  # south, west, north, east
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
USER_AGENT = "sembilan-data-build/1.0 (weekly GitHub Actions job)"
SRC = "OpenStreetMap contributors, ODbL 1.0 (openstreetmap.org/copyright)"
MIN_DEFAULT = 20
CARDINALS = {
    "N": 0, "NNE": 22, "NE": 45, "ENE": 67, "E": 90, "ESE": 112, "SE": 135, "SSE": 157,
    "S": 180, "SSW": 202, "SW": 225, "WSW": 247, "W": 270, "WNW": 292, "NW": 315, "NNW": 337,
}
AES_RE = re.compile(r"\b(aes|awas|jpj)\b", re.I)


def build_query(bbox=BBOX, timeout=180):
    b = ",".join(str(x) for x in bbox)
    return (
        f"[out:json][timeout:{timeout}][bbox:{b}];"
        'rel["type"="enforcement"]["enforcement"="maxspeed"]->.r;'
        '(node["highway"="speed_camera"];node["enforcement"="maxspeed"];node(r.r:"device"););'
        "out body;"
    )


def parse_limit(v):
    """'60' or '60 km/h' -> 60; anything else (mph, signals, conditional) -> None."""
    if not v:
        return None
    m = re.fullmatch(r"\s*(\d{2,3})\s*(km/h|kmh|kph)?\s*", str(v), re.I)
    if not m:
        return None
    n = int(m.group(1))
    return n if 20 <= n <= 130 else None


def parse_dir(v):
    """Degrees 0-359 from a numeric or cardinal direction; forward/backward/both -> None."""
    if not v:
        return None
    s = str(v).strip().upper()
    if s in CARDINALS:
        return CARDINALS[s]
    try:
        d = float(s)
    except ValueError:
        return None
    return int(round(d)) % 360 if 0 <= d <= 360 else None


def parse(data):
    """Overpass JSON -> sorted, de-duplicated camera rows."""
    rows = {}
    for el in data.get("elements", []):
        if el.get("type") != "node" or "lat" not in el or "lon" not in el:
            continue
        t = el.get("tags") or {}
        lat, lon = round(float(el["lat"]), 5), round(float(el["lon"]), 5)
        if not (BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]):
            continue
        text = " ".join(str(t.get(k, "")) for k in ("name", "operator", "ref", "brand", "description", "note"))
        typ = 1 if AES_RE.search(text) else 0
        row = (lat, lon, typ, parse_dir(t.get("direction") or t.get("camera:direction")), parse_limit(t.get("maxspeed")))
        rows[row] = row
    return [list(r) for r in sorted(rows, key=lambda r: (r[0], r[1], r[2], -1 if r[3] is None else r[3]))]


def fetch(query, endpoints=ENDPOINTS, attempts=4, sleep=None, opener=None):
    """POST the query with retry/backoff, rotating endpoints. Returns parsed JSON."""
    sleep = sleep or time.sleep
    opener = opener or urllib.request.urlopen
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for n in range(attempts):
        url = endpoints[n % len(endpoints)]
        req = urllib.request.Request(url, data=body, headers={"User-Agent": USER_AGENT})
        try:
            with opener(req, timeout=240) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last = e
            # Overpass asks for a 30 s pause after 429 (rate limit) / 406 (rejected); 504 = busy.
            wait = 30 if e.code in (429, 406) else 10 * (2 ** n)
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
            last = e
            wait = 10 * (2 ** n)
        print(f"overpass attempt {n + 1}/{attempts} failed on {url}: {last}", file=sys.stderr)
        if n < attempts - 1:
            sleep(wait + random.uniform(0, 3))
    raise RuntimeError(f"Overpass unreachable after {attempts} attempts: {last}")


def build(data, today=None):
    stamp = (data.get("osm3s") or {}).get("timestamp_osm_base", "")[:10]
    asof = stamp if re.fullmatch(r"\d{4}-\d{2}-\d{2}", stamp) else (today or datetime.date.today().isoformat())
    return {"asof": asof, "src": SRC, "c": parse(data)}


def dump(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("out", nargs="?", default="data/cameras.json")
    ap.add_argument("--min", type=int, default=MIN_DEFAULT, help="refuse to write fewer cameras than this")
    ap.add_argument("--endpoint", action="append", help="Overpass endpoint (repeatable)")
    a = ap.parse_args(argv)
    result = build(fetch(build_query(), a.endpoint or ENDPOINTS))
    if len(result["c"]) < a.min:
        print(f"only {len(result['c'])} cameras (< {a.min}); keeping the existing file", file=sys.stderr)
        return 1
    with open(a.out, "w", encoding="utf-8") as f:
        f.write(dump(result))
    print(f"wrote {len(result['c'])} cameras to {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
