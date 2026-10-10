"""One-off probe for the campus room search: what OSM gave us, and whether
better room sources answer from CI. Run by .github/workflows/probe.yml.
Prints compact lines only, so the tail of the job log is the whole answer."""
import json
import re
import sys
from pathlib import Path

import requests

UA = {"User-Agent": "Nastet/1.0 (https://xn--nstet-gra.se; campus probe)"}


def show(label, url, **kw):
    try:
        r = requests.get(url, headers=UA, timeout=25, **kw)
        body = r.text
        print(f"PROBE {label}: HTTP {r.status_code} {r.headers.get('content-type','')[:40]} {len(body)}ch :: {body[:700]!r}")
        return r
    except Exception as e:  # noqa: BLE001
        print(f"PROBE {label}: {type(e).__name__}: {e}")


cache = Path("data/campus_cache.json")
if cache.exists():
    data = json.loads(cache.read_text())
    for sid, rec in data.items():
        b = rec.get("buildings", [])
        print(f"OSM {sid}: v{rec.get('v')} outline={len(rec.get('outline', []))} · {len(b)} buildings, {len(rec.get('rooms', []))} rooms, {len(rec.get('pois', []))} pois")
        print(f"OSM {sid} refs: {sorted({x['ref'] for x in b if x.get('ref')})}")
        print(f"OSM {sid} names: {sorted({x['name'] for x in b if x.get('name')})}")
        print(f"OSM {sid} rooms: {[r['ref'] for r in rec.get('rooms', [])][:40]}")
else:
    print("OSM: no campus cache")

# KTH's main building (Kollegiesalen) is missing from the campus data: what
# does OSM hold around it, and with which tags?
sys.path.insert(0, ".")
from monitor import OVERPASS_URLS  # noqa: E402
q = """[out:json][timeout:60];
(way["building"](around:180,59.3472,18.0727); relation["building"](around:180,59.3472,18.0727););
out tags center;"""
for url in OVERPASS_URLS:
    try:
        r = requests.post(url, data={"data": q}, headers=UA, timeout=90)
        els = r.json().get("elements", [])
        print(f"MAIN via {url}: {len(els)} buildings")
        for el in els:
            t = el.get("tags", {})
            keep = {k: v for k, v in t.items() if k.startswith(("name", "ref", "addr", "building", "alt_name", "loc_name", "amenity", "operator", "short_name"))}
            print(f"MAIN {el['type']}/{el['id']} {el.get('center')} {keep}")
        break
    except Exception as e:  # noqa: BLE001
        print(f"MAIN via {url}: {type(e).__name__}: {e}")
if cache.exists():
    rec = json.loads(cache.read_text()).get("KTH", {})
    for o in rec.get("outline", []):
        print(f"OUTLINE KTH: {len(o)} pts, lat {min(p[0] for p in o):.4f}-{max(p[0] for p in o):.4f}, lon {min(p[1] for p in o):.4f}-{max(p[1] for p in o):.4f}")
