#!/usr/bin/env python3
"""
update_data.py — rebuild Tellinki's data files from OpenStreetMap.

Fetches bicycle parking, repair stations, drinking water points and the
baana network for the Helsinki capital region via the public Overpass API,
strips everything the site doesn't render, and writes compact GeoJSON.

Usage:
    pip install requests
    python3 update_data.py                  # update all datasets
    python3 update_data.py --only parking,water

Output files (written next to this script):
    parking.json    bicycle parking (stands / rack / safe_loops / two-tier)
    mech.geojson    bicycle repair stations
    water.geojson   drinking water points
    baanat.geojson  baana routes (one MultiLineString per route relation)
    data-meta.json  {"updated": "dd.mm.yyyy"} shown in the site's info bar

No API key needed. Overpass is a shared public service — run this when you
want fresh data, not in a loop. See https://dev.overpass-api.de/no_mills.html
"""

import argparse
import json
import os
import sys
import tempfile
import time
from datetime import date

import requests

# Tried in order; some mirrors rate-limit or block unknown user agents.
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter",
]
USER_AGENT = "TellinkiDataUpdater/1.0 (https://www.tellinki.com)"
# Same view bounds as the map (south, west, north, east).
BBOX = "60.089,24.459,60.330,25.514"

PARKING_TYPES = ("stands", "safe_loops", "two-tier", "rack")
PARKING_TYPE_RE = "^(" + "|".join(PARKING_TYPES) + ")$"


def overpass(query: str) -> dict:
    """Run an Overpass query, falling back across public mirrors."""
    last_error: Exception | None = None
    for url in OVERPASS_URLS:
        for attempt in (1, 2):
            try:
                r = requests.post(
                    url,
                    data={"data": query},
                    timeout=180,
                    headers={"User-Agent": USER_AGENT},
                )
                r.raise_for_status()
                return r.json()
            except (requests.RequestException, json.JSONDecodeError) as e:
                last_error = e
                print(f"  {url} failed ({e})", file=sys.stderr)
                if attempt == 1:
                    time.sleep(15)
        print("  trying next mirror…", file=sys.stderr)
    raise RuntimeError(f"All Overpass mirrors failed: {last_error}")


def atomic_write_json(path: str, payload: dict) -> int:
    """Write compact JSON atomically; returns byte size."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)
    return os.path.getsize(path)


def num(v):
    """Parse a non-negative int from an OSM tag value, else None."""
    if v is None:
        return None
    try:
        n = int(str(v).strip())
        return n if n >= 0 else None
    except ValueError:
        return None


def point_feature(osm_id: str, lat: float, lon: float, props: dict) -> dict:
    props = {k: v for k, v in props.items() if v is not None}
    props["id"] = osm_id  # e.g. "node/123" — used for "edit in OSM" links
    return {
        "type": "Feature",
        "properties": props,
        "geometry": {
            "type": "Point",
            "coordinates": [round(lon, 6), round(lat, 6)],
        },
    }


def element_center(el: dict):
    """(lat, lon) for a node, or the center of a way/relation."""
    if el["type"] == "node":
        return el.get("lat"), el.get("lon")
    c = el.get("center") or {}
    return c.get("lat"), c.get("lon")


# ── Parking ──────────────────────────────────────────────────────────────────

def build_parking() -> dict:
    q = f"""[out:json][timeout:120];
nwr["amenity"="bicycle_parking"]["bicycle_parking"~"{PARKING_TYPE_RE}"]({BBOX});
out tags center;"""
    data = overpass(q)
    feats = []
    for el in data.get("elements", []):
        lat, lon = element_center(el)
        if lat is None or lon is None:
            continue
        tags = el.get("tags", {})
        props = {"bicycle_parking": tags.get("bicycle_parking")}
        cap = num(tags.get("capacity"))
        if cap is not None:
            props["capacity"] = cap
        if tags.get("covered") in ("yes", "partial"):
            props["covered"] = tags["covered"]
        cargo = num(tags.get("capacity:cargo_bike"))
        if cargo:
            props["capacity:cargo_bike"] = cargo
        if tags.get("access") == "private":
            props["access"] = "private"  # dimmed marker on the map
        if tags.get("name"):
            props["name"] = tags["name"]
        feats.append(point_feature(f'{el["type"]}/{el["id"]}', lat, lon, props))
    return {"type": "FeatureCollection", "features": feats}


# ── Repair stations ──────────────────────────────────────────────────────────

MECH_KEEP_PREFIXES = ("service:bicycle:",)
MECH_KEEP_KEYS = {
    "amenity", "name", "operator", "opening_hours",
    "addr:street", "addr:housenumber", "addr:city",
}


def build_mech() -> dict:
    q = f"""[out:json][timeout:120];
nwr["amenity"="bicycle_repair_station"]({BBOX});
out tags center;"""
    data = overpass(q)
    feats = []
    for el in data.get("elements", []):
        lat, lon = element_center(el)
        if lat is None or lon is None:
            continue
        tags = el.get("tags", {})
        props = {
            k: v for k, v in tags.items()
            if k in MECH_KEEP_KEYS or any(k.startswith(p) for p in MECH_KEEP_PREFIXES)
        }
        feats.append(point_feature(f'{el["type"]}/{el["id"]}', lat, lon, props))
    return {"type": "FeatureCollection", "features": feats}


# ── Drinking water ───────────────────────────────────────────────────────────

def build_water() -> dict:
    q = f"""[out:json][timeout:120];
nwr["amenity"="drinking_water"]({BBOX});
out tags center;"""
    data = overpass(q)
    feats = []
    for el in data.get("elements", []):
        lat, lon = element_center(el)
        if lat is None or lon is None:
            continue
        tags = el.get("tags", {})
        props = {}
        if tags.get("name"):
            props["name"] = tags["name"]
        if tags.get("seasonal"):
            props["seasonal"] = tags["seasonal"]
        feats.append(point_feature(f'{el["type"]}/{el["id"]}', lat, lon, props))
    return {"type": "FeatureCollection", "features": feats}


# ── Baana network ────────────────────────────────────────────────────────────

BAANA_NETWORK_RELATION = 13923968  # "Pääkaupunkiseudun baanaverkko" — finished baanas only


def build_baanat() -> dict:
    # Baanas are mapped as route=bicycle relations. Only fetch routes that
    # belong to the "Pääkaupunkiseudun baanaverkko" superrelation (OSM id
    # 13923968, description "Valmiit baanat") — other baana relations are
    # planned routes and should not be shown.
    # Two queries total: list the member relations, then fetch all their
    # geometries at once (per-relation queries are slow and flaky).
    data = overpass(
        f'[out:json][timeout:120];relation({BAANA_NETWORK_RELATION});out body;'
    )
    member_ids = [
        m["ref"]
        for el in data.get("elements", [])
        for m in el.get("members", [])
        if m.get("type") == "relation"
    ]
    if not member_ids:
        raise RuntimeError("Baana network relation has no member relations")

    ids = ",".join(str(i) for i in member_ids)
    geom_data = overpass(f'[out:json][timeout:240];relation(id:{ids});out geom;')

    # Several baanas are mapped as two relations (e.g. per segment) — merge
    # by (name, ref) so each route becomes one feature with one shield.
    merged = {}
    for rel in geom_data.get("elements", []):
        tags = rel.get("tags", {})
        name = tags.get("name", "")
        if not name:
            continue
        lines = []
        for m in rel.get("members", []):
            if m.get("type") != "way" or not m.get("geometry"):
                continue
            lines.append(
                [[round(p["lon"], 6), round(p["lat"], 6)] for p in m["geometry"]]
            )
        if not lines:
            continue
        key = (name, tags.get("ref") or None)
        merged.setdefault(key, []).extend(lines)

    feats = []
    for (name, ref), lines in merged.items():
        props = {"name": name}
        if ref:
            props["ref"] = ref
        geom = (
            {"type": "LineString", "coordinates": lines[0]}
            if len(lines) == 1
            else {"type": "MultiLineString", "coordinates": lines}
        )
        feats.append({"type": "Feature", "properties": props, "geometry": geom})
    feats.sort(key=lambda f: f["properties"]["name"])
    return {"type": "FeatureCollection", "features": feats}


BUILDERS = {
    "parking": ("parking.json", build_parking),
    "mech": ("mech.geojson", build_mech),
    "water": ("water.geojson", build_water),
    "baanat": ("baanat.geojson", build_baanat),
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--only",
        help="comma-separated subset of: " + ", ".join(BUILDERS),
        default=None,
    )
    args = ap.parse_args()

    wanted = list(BUILDERS)
    if args.only:
        wanted = [w.strip() for w in args.only.split(",") if w.strip()]
        unknown = set(wanted) - set(BUILDERS)
        if unknown:
            print(f"Unknown dataset(s): {', '.join(unknown)}", file=sys.stderr)
            return 2

    here = os.path.dirname(os.path.abspath(__file__))
    for key in wanted:
        filename, builder = BUILDERS[key]
        print(f"Fetching {key}…")
        fc = builder()
        n = len(fc["features"])
        path = os.path.join(here, filename)
        size = atomic_write_json(path, fc)
        print(f"  → {filename}: {n} features, {size / 1024:.0f} KiB")

    meta_path = os.path.join(here, "data-meta.json")
    today = date.today().strftime("%d.%m.%Y")
    atomic_write_json(meta_path, {"updated": today})
    print(f"  → data-meta.json: {today}")
    print("Done. Commit and push the changed files to update the site.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
