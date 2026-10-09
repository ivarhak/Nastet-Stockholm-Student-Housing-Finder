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
        print(f"OSM {sid}: {len(b)} buildings, {len(rec.get('rooms', []))} rooms, {len(rec.get('pois', []))} pois")
        print(f"OSM {sid} refs: {sorted({x['ref'] for x in b if x.get('ref')})}")
        print(f"OSM {sid} names: {sorted({x['name'] for x in b if x.get('name')})}")
        print(f"OSM {sid} rooms: {[r['ref'] for r in rec.get('rooms', [])][:40]}")
else:
    print("OSM: no campus cache")

# MazeMap: public search used by its web client. Find the campus ids first.
for q in ["KTH", "Stockholms universitet", "Södra huset"]:
    show(f"mazemap campus '{q}'", "https://api.mazemap.com/search/equery/",
         params={"q": q, "rows": 5, "start": 0, "withpois": "true", "withbuilding": "true",
                 "withtype": "true", "withcampus": "true"})
show("mazemap campus list", "https://api.mazemap.com/api/campus/", params={"srid": 4326})
for q in ["D2", "Q31", "E1"]:
    show(f"mazemap room '{q}'", "https://api.mazemap.com/search/equery/",
         params={"q": q, "rows": 5, "start": 0, "withpois": "true", "withbuilding": "true",
                 "withtype": "true", "withcampus": "true", "campusid": 1})

# KTH's own places API — paths seen in KTH's public pages; any that answer win.
for path in ["https://api.kth.se/api/places/v3/room/name/D2",
             "https://api.kth.se/api/places/v3/buildings",
             "https://www.kth.se/api/places/v3/room/name/D2",
             "https://www.kth.se/places/room/name/D2"]:
    show("kth " + path.split("/api/")[-1] if "/api/" in path else "kth page", path)
