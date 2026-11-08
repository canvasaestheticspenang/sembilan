#!/usr/bin/env python3
"""Overture Maps rows (places + street names) for Malaysia, shaped like build_fsq's query rows.

Used by build_fsq.py --overture. Overture is public on S3 (no login). Places come from theme=places,
streets from theme=transportation (road segments, collapsed to one point per street name per ~2 km cell,
so "Jalan Burma" is searchable without storing every segment).
"""
from __future__ import annotations

import json
import re
import urllib.request

S3 = "s3://overturemaps-us-west-2/release"
# Malaysia incl. Sabah/Sarawak/Labuan. Overture bboxes are lon/lat degrees.
BBOX = (99.5, 0.8, 119.4, 7.5)
STREET_CLASSES = ("motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street")
MIN_CONF = 0.55
DROP_CATS = frozenset("""parking residential_building private_establishments_and_corporates corporate_office
 business_to_business_service construction_services industrial_estate home_service storage_facility
 coworking_space factory warehouse""".split())
REL_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(\.\d+)?$")


def latest_release() -> str:
    with urllib.request.urlopen("https://stac.overturemaps.org/catalog.json", timeout=60) as r:
        return json.load(r)["latest"]


def _where(bb=BBOX):
    return f"bbox.xmin BETWEEN {bb[0]} AND {bb[2]} AND bbox.ymin BETWEEN {bb[1]} AND {bb[3]}"


def place_rows(con, release: str | None = None, source: str | None = None):
    """Rows: (id, name, lat, lon, address, locality, region, [category_label])."""
    src = source or f"{S3}/{release}/theme=places/type=place/*"
    sql = f"""
    SELECT id, names.primary AS name, (bbox.ymin+bbox.ymax)/2 AS lat, (bbox.xmin+bbox.xmax)/2 AS lon,
           COALESCE(addresses[1].freeform,'') AS addr, COALESCE(addresses[1].locality,'') AS loc,
           COALESCE(addresses[1].region,'') AS reg, categories.primary AS cat
    FROM read_parquet('{src}', hive_partitioning=1)
    WHERE {_where()} AND names.primary IS NOT NULL AND confidence >= {MIN_CONF}
      AND COALESCE(addresses[1].country,'MY') = 'MY'
    """
    out = []
    for pid, name, lat, lon, addr, loc, reg, cat in con.execute(sql).fetchall():
        cat = (cat or "").strip()
        if cat in DROP_CATS or not name.strip():
            continue
        label = cat.replace("_", " ").title()
        out.append((f"ov:{pid}", name, lat, lon, addr, loc, reg, [label] if label else []))
    return out


def street_rows(con, release: str | None = None, source: str | None = None):
    """One row per (street name, ~2 km cell)."""
    src = source or f"{S3}/{release}/theme=transportation/type=segment/*"
    cls = ",".join(f"'{c}'" for c in STREET_CLASSES)
    sql = f"""
    SELECT names.primary AS name, round((bbox.ymin+bbox.ymax)/2/0.02)*0.02 AS clat,
           round((bbox.xmin+bbox.xmax)/2/0.02)*0.02 AS clon,
           min((bbox.ymin+bbox.ymax)/2) AS lat, min((bbox.xmin+bbox.xmax)/2) AS lon
    FROM read_parquet('{src}', hive_partitioning=1)
    WHERE {_where()} AND subtype='road' AND class IN ({cls}) AND names.primary IS NOT NULL
    GROUP BY 1,2,3
    """
    out = []
    for name, _, _, lat, lon in con.execute(sql).fetchall():
        name = name.strip()
        if len(name) >= 4:
            out.append((f"ovs:{name}:{lat:.4f}:{lon:.4f}", name, lat, lon, "", "", "", ["Street"]))
    return out
