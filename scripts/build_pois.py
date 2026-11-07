#!/usr/bin/env python3
"""Build data/my-pois.json for Sembilan from an osmium GeoJSON-seq export.

Usage: build_pois.py <input.geojsonseq> <output.json>

Output format (kept compact for fast loading on phones):
  {"updated": "...", "pois": [[type, lat, lon, name, extra], ...],
   "nomoto": [[name, [lat, lon, lat, lon, ...]], ...]}
  type: fuel | rr | cam | toll | shelter
  extra: fuel -> station name if different from brand; rr -> "services" or "rest_area";
         cam -> maxspeed; shelter -> "pt" for bus-stop shelters
"""
import json, sys, datetime

ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
         "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
         "living_street", "service", "road"}


def centroid(g):
    t, c = g["type"], g["coordinates"]
    if t == "Point":
        return c[1], c[0]
    if t == "LineString":
        pts = c
    elif t == "Polygon":
        pts = c[0]
    elif t == "MultiPolygon":
        pts = c[0][0]
    else:
        return None
    if not pts:
        return None
    return sum(p[1] for p in pts) / len(pts), sum(p[0] for p in pts) / len(pts)


def classify(t):
    if t.get("amenity") == "fuel":
        return "fuel"
    if t.get("highway") in ("services", "rest_area"):
        return "rr"
    if t.get("highway") == "speed_camera":
        return "cam"
    if t.get("barrier") == "toll_booth":
        return "toll"
    if t.get("amenity") == "shelter":
        return "shelter"
    return None


def main(src, dst):
    pois, nomoto, seen = [], [], set()
    with open(src, encoding="utf-8") as fh:
        for line in fh:
            line = line.lstrip("\x1e").strip()
            if not line:
                continue
            f = json.loads(line)
            t, g = f.get("properties") or {}, f.get("geometry")
            if not g:
                continue
            if t.get("motorcycle") == "no" and t.get("highway") in ROADS and g["type"] == "LineString":
                coords = [round(v, 5) for p in g["coordinates"] for v in (p[1], p[0])]
                if len(coords) >= 4:
                    nomoto.append([t.get("name") or t.get("ref") or "", coords])
                continue
            typ = classify(t)
            if not typ:
                continue
            c = centroid(g)
            if not c:
                continue
            lat, lon = round(c[0], 5), round(c[1], 5)
            name, extra = t.get("name") or "", ""
            if typ == "fuel":
                brand = t.get("brand") or t.get("operator") or ""
                name, extra = (brand or name), (name if brand and name and name != brand else "")
            elif typ == "rr":
                extra = t.get("highway")
            elif typ == "cam":
                name, extra = "", t.get("maxspeed") or ""
            elif typ == "shelter":
                extra = "pt" if t.get("shelter_type") == "public_transport" else ""
            key = (typ, lat, lon)
            if key in seen:
                continue
            seen.add(key)
            pois.append([typ, lat, lon, name, extra])
    out = {"updated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
           "source": "OpenStreetMap contributors (ODbL), via Geofabrik",
           "pois": pois, "nomoto": nomoto}
    with open(dst, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    counts = {}
    for p in pois:
        counts[p[0]] = counts.get(p[0], 0) + 1
    print("pois:", counts, "nomoto ways:", len(nomoto))
    if counts.get("fuel", 0) < 500:
        sys.exit("Too few petrol stations - extract looks broken, not writing a bad file")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
