"""Build-time extras for the published payloads: floor plans, bike isochrones
and road/rail noise.

    python enrich.py --site _site [--only floorplans,isochrones,noise]

Runs after the site is assembled and edits _site/listings-<city>.json in
place. Every part is optional: a source that refuses or changes shape prints
why and leaves the payload as it was — none of this is worth failing a deploy
over. Everything fetched is cached under data/ (see the workflow's cache
paths), so a normal hourly run makes almost no requests:

  data/floorplans/<key>.png + index.json   rendered page 1 of each SSSB plan PDF
  data/isochrone_cache.json                one Valhalla polygon set per campus
  data/noise_cache.json                    noise band per ~10 m grid point
  data/campus_cache.json                   OSM buildings and rooms per campus map

Verbose on purpose, like monitor.py: these sources can only be reached from
CI, so the log is the debugger.
"""
import argparse
import hashlib
import io
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from monitor import CITIES, USER_AGENT  # noqa: E402

DATA = Path(__file__).resolve().parent / "data"
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              f"(KHTML, like Gecko) Chrome/126 Safari/537.36 {USER_AGENT}")


def now():
    return datetime.now(timezone.utc)


def load(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save(path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")


# ── Floor plans ──────────────────────────────────────────────────────────────
# SSSB's object page links a PDF floor plan. Page 1 is rendered to a small PNG
# and published under /floorplans/, linking back to the original. Keyed by the
# listing id (the physical room), so a room re-listed next year reuses its plan.

PLAN_LINK_RE = re.compile(r"plan|ritning|layout", re.I)
FLOORPLAN_DIR = DATA / "floorplans"
FLOORPLAN_INDEX = FLOORPLAN_DIR / "index.json"
PLAN_WIDTH = 640
PLAN_RETRY_DAYS = 7          # a room whose page had no plan isn't asked again for a week
PLAN_PARSER = 4              # bump when find_plan_links changes, to re-check old misses
MAX_NEW_PLANS_PER_RUN = 25   # politeness: a cold cache fills over a few runs


def plan_key(listing_id: str) -> str:
    return hashlib.sha1(listing_id.encode("utf-8")).hexdigest()[:16]


def find_plan_links(html: str, base: str) -> list[str]:
    """Candidate floor-plan URLs on an object page: PDF links first, then
    images, either named like a plan in the href or the link text."""
    links = []
    for m in re.finditer(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html, re.I | re.S):
        href, text = m.group(1), re.sub(r"<[^>]+>", " ", m.group(2))
        if PLAN_LINK_RE.search(href) or PLAN_LINK_RE.search(text):
            links.append(urljoin(base, href.replace("&amp;", "&")))
    for m in re.finditer(r'(?:src|href|data-src)="([^"]+\.(?:pdf|png|jpe?g|webp)[^"]*)"', html, re.I):
        if PLAN_LINK_RE.search(m.group(1)):
            links.append(urljoin(base, m.group(1).replace("&amp;", "&")))
    pdfs = [u for u in links if ".pdf" in u.lower()]
    seen, out = set(), []
    for u in pdfs + links:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


# The object page fills its "pdf-links" box with a script widget
# (data-widget="objektdokument"); the documents come from SSSB's widget
# endpoint, keyed by the same refid as the page.
# Only the JSONP form answers (without callback= it's HTTP 400). The reply is
# cb({"html": {"objektdokument": "<div class=ObjektDokument><ul><li
# class='DokumentItem TypVanrit'><a href='//minasidor.sssb.se/spin/?id=…'>…"}})
# — one <li> per document, typed by class; TypVanrit is the floor plan.
WIDGET_URLS = [
    "https://minasidor.sssb.se/widgets/?callback=cb&refid={refid}&widgets%5B%5D=objektdokument",
]
PLAN_DOC_TYPES = ("TypVanrit", "TypPlan", "TypRitning")


def documents_from_widget(body: str) -> list[tuple[str, str, str]]:
    """[(type class, href, link text)] from the objektdokument JSONP reply."""
    m = re.search(r"^[\w$.]*\((.*)\)\s*;?\s*$", body.strip(), re.S)
    try:
        payload = json.loads(m.group(1) if m else body)
        html = (payload.get("html") or {}).get("objektdokument") or ""
    except (ValueError, AttributeError):
        html = body
    docs = []
    for li in re.finditer(r'<li[^>]*class="[^"]*\b(Typ\w+)[^"]*"[^>]*>(.*?)</li>', html, re.S):
        a = re.search(r'href="([^"]+)"[^>]*>(.*?)</a>', li.group(2), re.S)
        if a:
            text = re.sub(r"<[^>]+>|\s+", " ", a.group(2)).strip()
            docs.append((li.group(1), a.group(1).replace("&amp;", "&"), text))
    return docs


def widget_plan_links(session, page_url: str, debug: bool) -> list[str]:
    m = re.search(r"refid=([0-9a-fA-F]+)", page_url)
    if not m:
        return []
    for tmpl in WIDGET_URLS:
        url = tmpl.format(refid=m.group(1))
        try:
            r = session.get(url, timeout=20, headers={"Referer": page_url, "X-Requested-With": "XMLHttpRequest"})
        except requests.RequestException as e:
            if debug:
                print(f"    widget {url}: {type(e).__name__}: {e}")
            continue
        docs = documents_from_widget(r.text)
        if debug:
            print(f"    widget: HTTP {r.status_code}, documents {[(t, txt) for t, _, txt in docs]}")
        plans = [h for t, h, txt in docs if t in PLAN_DOC_TYPES or re.search(r"ritning|plan", txt, re.I)]
        if plans:
            return [urljoin(page_url, h) if not h.startswith("//") else "https:" + h for h in plans]
    return []


def render_plan(blob: bytes, content_type: str) -> bytes | None:
    """PNG bytes, PLAN_WIDTH wide, from a PDF (page 1) or an image."""
    from PIL import Image
    if blob[:4] == b"%PDF" or "pdf" in content_type:
        import fitz  # PyMuPDF
        doc = fitz.open(stream=blob, filetype="pdf")
        if not doc.page_count:
            return None
        page = doc[0]
        zoom = PLAN_WIDTH / max(1, page.rect.width)
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
    else:
        img = Image.open(io.BytesIO(blob))
        img = img.convert("RGB")
        if img.width > PLAN_WIDTH:
            img = img.resize((PLAN_WIDTH, round(img.height * PLAN_WIDTH / img.width)), Image.LANCZOS)
    # Plans are line drawings: a 64-colour palette keeps them sharp and small.
    out = io.BytesIO()
    img.convert("RGB").quantize(colors=64).save(out, "PNG", optimize=True)
    return out.getvalue()


def enrich_floorplans(site: Path, payloads: dict) -> None:
    index = load(FLOORPLAN_INDEX, {})
    session = requests.Session()
    session.headers.update({"User-Agent": BROWSER_UA, "Accept-Language": "sv,en;q=0.8"})
    fetched = attached = 0
    shown_debug = False
    for city, data in payloads.items():
        for l in data["listings"]:
            if l.get("provider") != "SSSB" or not l.get("url"):
                continue
            key = plan_key(l["id"])
            rec = index.get(key)
            stale_miss = (rec and not rec.get("file")
                          and (rec.get("parser") != PLAN_PARSER
                               or rec.get("checked", "") < (now() - timedelta(days=PLAN_RETRY_DAYS)).isoformat()))
            if (rec is None or stale_miss) and fetched < MAX_NEW_PLANS_PER_RUN:
                fetched += 1
                rec = {"checked": now().isoformat(timespec="seconds"), "file": None, "src": None,
                       "parser": PLAN_PARSER}
                try:
                    page = session.get(l["url"], timeout=20)
                    page.raise_for_status()
                    cands = find_plan_links(page.text, page.url) or \
                        widget_plan_links(session, page.url, debug=not shown_debug)
                    if not shown_debug:
                        # The first page's candidates, so a changed page layout
                        # shows up here rather than as silently missing plans.
                        shown_debug = True
                        print(f"  floorplans: first object page {page.url} ({len(page.text):,} chars) — "
                              f"plan candidates {cands[:3]}")
                        # Where the page mentions a plan, and what it loads —
                        # enough to find the real source if it's fetched by script.
                        for m in list(re.finditer(r"planritning|ritning|floor ?plan|\.pdf|bilagor|dokument", page.text, re.I))[:8]:
                            snip = page.text[max(0, m.start() - 160):m.end() + 160].replace("\n", " ")
                            print(f"    …{snip}…")
                        apis = sorted(set(re.findall(r'["\'](/[^"\']*(?:api|Api|widget|ajax)[^"\']*)["\']', page.text)))[:15]
                        print(f"    script-ish paths: {apis}")
                        srcs = re.findall(r'<script[^>]+src=["\']([^"\']+)', page.text)[:12]
                        mentions = sorted(set(re.findall(r'[\w/.:-]*widgets[\w/.?=&%-]*', page.text)))[:10]
                        print(f"    script srcs: {srcs}")
                        print(f"    'widgets' mentions: {mentions}")
                    for url in cands[:3]:
                        r = session.get(url, timeout=30)
                        if not r.ok or len(r.content) < 1000:
                            continue
                        png = render_plan(r.content, r.headers.get("Content-Type", ""))
                        if png:
                            FLOORPLAN_DIR.mkdir(parents=True, exist_ok=True)
                            (FLOORPLAN_DIR / f"{key}.png").write_bytes(png)
                            rec.update(file=f"{key}.png", src=url)
                            break
                    time.sleep(0.5)
                except Exception as e:  # noqa: BLE001 — one room must not stop the rest
                    print(f"  floorplans: {l['id']}: {type(e).__name__}: {e}")
                index[key] = rec
            if rec and rec.get("file") and (FLOORPLAN_DIR / rec["file"]).exists():
                out = site / "floorplans" / rec["file"]
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes((FLOORPLAN_DIR / rec["file"]).read_bytes())
                l["floorplan"] = f"floorplans/{rec['file']}"
                l["floorplan_src"] = rec["src"]
                attached += 1
    save(FLOORPLAN_INDEX, index)
    have = sum(1 for r in index.values() if r.get("file"))
    print(f"floorplans: {attached} attached · {fetched} pages checked this run · "
          f"{have}/{len(index)} rooms in the cache have a plan")


# ── Bike isochrones ──────────────────────────────────────────────────────────
# One request per campus to Valhalla's public server (the same one monitor.py
# routes bikes on), refreshed monthly — streets don't move faster than that.

ISOCHRONE_URL = "https://valhalla1.openstreetmap.de/isochrone"
ISOCHRONE_CACHE = DATA / "isochrone_cache.json"
CONTOURS = [10, 15, 20, 30, 45, 60]
# Valhalla's default service limit is four contours per request.
CONTOUR_BATCH = 4
ISOCHRONE_MAX_AGE_DAYS = 30


def round_coords(geom):
    """5 decimals (~1 m) — Valhalla returns 6, and the file is a third smaller."""
    if isinstance(geom, list):
        return [round_coords(g) for g in geom] if geom and isinstance(geom[0], list) \
            else [round(v, 5) for v in geom]
    return geom


def coarse(geom):
    """4 decimals (~11 m), dropping points that collapse onto the previous one."""
    if isinstance(geom, list) and geom and isinstance(geom[0], (int, float)):
        return [round(v, 4) for v in geom]
    if isinstance(geom, list) and geom and isinstance(geom[0], list) and geom[0] and isinstance(geom[0][0], (int, float)):
        pts = []
        for p in geom:
            q = [round(v, 4) for v in p]
            if not pts or q != pts[-1]:
                pts.append(q)
        return pts
    return [coarse(g) for g in geom] if isinstance(geom, list) else geom


def enrich_isochrones(site: Path, payloads: dict) -> None:
    cache = load(ISOCHRONE_CACHE, {})
    asked = 0
    for city, data in payloads.items():
        schools = data.get("schools") or CITIES.get(city, {}).get("schools") or {}
        out = {}
        for sid, school in schools.items():
            coords = school.get("coords")
            if not coords:
                continue
            ckey = f"{coords[0]:.5f},{coords[1]:.5f}|{','.join(map(str, CONTOURS))}"
            rec = cache.get(ckey)
            fresh = rec and rec.get("at", "") > (now() - timedelta(days=ISOCHRONE_MAX_AGE_DAYS)).isoformat()
            if not fresh:
                asked += 1
                feats = []
                try:
                    for i in range(0, len(CONTOURS), CONTOUR_BATCH):
                        # POST with a JSON body, the same shape monitor.py's
                        # working /route calls use.
                        req = {"locations": [{"lat": coords[0], "lon": coords[1]}], "costing": "bicycle",
                               "contours": [{"time": m} for m in CONTOURS[i:i + CONTOUR_BATCH]],
                               "polygons": True, "denoise": 0.5, "generalize": 40}
                        r = requests.post(ISOCHRONE_URL, json=req, headers={"User-Agent": USER_AGENT}, timeout=40)
                        if not r.ok:
                            raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
                        fc = r.json()
                        feats += [{"type": "Feature", "properties": {"min": f["properties"].get("contour")},
                                   "geometry": {"type": f["geometry"]["type"],
                                                "coordinates": round_coords(f["geometry"]["coordinates"])}}
                                  for f in fc.get("features", [])]
                        time.sleep(1.0)
                    if feats:
                        rec = {"at": now().isoformat(timespec="seconds"), "features": feats}
                        cache[ckey] = rec
                        print(f"  isochrones: {city}/{sid}: {len(feats)} contours "
                              f"({len(json.dumps(feats)) // 1024} KB)")
                    else:
                        print(f"  isochrones: {city}/{sid}: no features in response")
                except Exception as e:  # noqa: BLE001
                    print(f"  isochrones: {city}/{sid}: {type(e).__name__}: {e}"
                          f"{' (keeping the older copy)' if rec else ''}")
            if rec and rec.get("features"):
                # Largest first, so the smaller rings draw on top. One file per
                # campus, at ~11 m precision: the page only ever draws one
                # campus, and the full set was ~750 KB for Stockholm.
                feats = sorted(rec["features"], key=lambda f: -(f["properties"]["min"] or 0))
                feats = [{**f, "geometry": {**f["geometry"], "coordinates": coarse(f["geometry"]["coordinates"])}}
                         for f in feats]
                name = f"isochrones-{city}-{re.sub(r'[^A-Za-z0-9-]', '', sid)}.json"
                (site / name).write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                                    separators=(",", ":")))
                out[sid] = name
        if out:
            data["isochrones"] = out
        print(f"isochrones: {city}: {len(out)}/{len(schools)} campuses")
    save(ISOCHRONE_CACHE, cache)
    print(f"isochrones: {asked} requested this run")


# ── Noise (Stockholm) ────────────────────────────────────────────────────────
# Stockholm stad's noise map (Bullerkartan 2022): modelled 24 h equivalent
# level from road and rail traffic, published as an ArcGIS feature service.
# Indicative only — modelled at the façade, not measured, and blind to which
# side of the building a room faces. The service URL is looked up from its
# ArcGIS Online item so a re-published layer is followed automatically.

NOISE_ITEM = "https://www.arcgis.com/sharing/rest/content/items/ce2b61853e594b7fa70de53eed7e9ef2"
NOISE_CACHE = DATA / "noise_cache.json"
NOISE_CITIES = {"stockholm"}
MAX_NOISE_LOOKUPS_PER_RUN = 200
NOISE_CACHE_VERSION = 2          # bump to re-query every point after a parsing change
DB_RE = re.compile(r"(\d{2})\s*(?:[-–]\s*(\d{2}))?")


def noise_band(db_low: float) -> str:
    if db_low < 45:
        return "quiet"
    if db_low < 55:
        return "moderate"
    if db_low < 65:
        return "noisy"
    return "very_noisy"


def noise_service(session) -> list[str]:
    """Query URLs of the polygon layers behind the noise map item."""
    item = session.get(NOISE_ITEM, params={"f": "json"}, timeout=20).json()
    url = item.get("url")
    print(f"  noise: item '{item.get('title')}' type={item.get('type')} url={url}")
    if not url:
        return []
    url = url.rstrip("/")
    if re.search(r"/\d+$", url):
        return [url + "/query"]
    svc = session.get(url, params={"f": "json"}, timeout=20).json()
    layers = svc.get("layers") or []
    print(f"  noise: layers {[(x.get('id'), x.get('name'), x.get('geometryType')) for x in layers][:8]}")
    polys = [x for x in layers if x.get("geometryType") in (None, "esriGeometryPolygon")]
    # Road and rail only, when there's a layer for exactly that — the other
    # one adds aircraft, which isn't what the chip says it measures.
    road_rail = [x for x in polys if re.search(r"väg.{0,6}tåg", x.get("name", ""), re.I)
                 and not re.search(r"flyg", x.get("name", ""), re.I)]
    return [f"{url}/{x['id']}/query" for x in (road_rail or polys)]


def db_from_attrs(attrs: dict) -> float | None:
    """The lower bound of the dB interval, from whichever attribute holds it."""
    if isinstance(attrs.get("ISOV1"), (int, float)):     # Bullerkartan 2022
        return float(attrs["ISOV1"])
    for k, v in attrs.items():
        if v is None:
            continue
        name = k.lower()
        if isinstance(v, (int, float)) and any(w in name for w in ("db", "leq", "niva", "nivå", "ljud", "klass", "grid")):
            if 30 <= v <= 90:
                return float(v)
        if isinstance(v, str) and ("db" in v.lower() or any(w in name for w in ("db", "leq", "niva", "klass", "intervall"))):
            m = DB_RE.search(v)
            if m and 30 <= int(m.group(1)) <= 90:
                return float(m.group(1))
    return None


def enrich_noise(site: Path, payloads: dict) -> None:
    cache = load(NOISE_CACHE, {})
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    layers, looked, attached, shown = None, 0, 0, False
    for city, data in payloads.items():
        if city not in NOISE_CITIES:
            continue
        for l in data["listings"]:
            coords = l.get("coords") or (data.get("areas", {}).get(l.get("area"), {}) or {}).get("coords")
            if not coords:
                continue
            # ~10 m grid: buildings on the same corner share a lookup.
            key = f"{coords[0]:.4f},{coords[1]:.4f}"
            if (key not in cache or cache[key].get("v") != NOISE_CACHE_VERSION) \
                    and looked < MAX_NOISE_LOOKUPS_PER_RUN:
                if layers is None:
                    try:
                        layers = noise_service(session)
                    except Exception as e:  # noqa: BLE001
                        print(f"noise: service lookup failed: {type(e).__name__}: {e}")
                        layers = []
                if not layers:
                    break
                looked += 1
                best, best_hi = None, None
                for q in layers:
                    try:
                        r = session.get(q, params={
                            "geometry": f"{coords[1]},{coords[0]}", "geometryType": "esriGeometryPoint",
                            "inSR": 4326, "spatialRel": "esriSpatialRelIntersects",
                            "outFields": "*", "returnGeometry": "false", "f": "json"}, timeout=20)
                        feats = r.json().get("features") or []
                        if not shown and feats:
                            shown = True
                            print(f"  noise: sample attributes {feats[0].get('attributes')}")
                        for f in feats:
                            attrs = f.get("attributes") or {}
                            db = db_from_attrs(attrs)
                            if db is not None and (best is None or db > best):
                                best = db
                                hi = attrs.get("ISOV2")
                                best_hi = float(hi) if isinstance(hi, (int, float)) else None
                    except Exception as e:  # noqa: BLE001
                        print(f"  noise: {key}: {type(e).__name__}: {e}")
                # Outside every modelled band means below the lowest one.
                cache[key] = {"db": best, "hi": best_hi, "v": NOISE_CACHE_VERSION,
                              "at": now().isoformat(timespec="seconds")}
                time.sleep(0.2)
            rec = cache.get(key)
            if rec is not None:
                db = rec.get("db")
                l["noise"] = {"db": db, "hi": rec.get("hi"),
                              "band": noise_band(db) if db is not None else "quiet"}
                attached += 1
        print(f"noise: {city}: {attached} listings tagged · {looked} lookups this run")
    save(NOISE_CACHE, cache)


# ── Campus maps ──────────────────────────────────────────────────────────────
# Buildings, mapped rooms, entrances and a few amenities for the campuses the
# page offers a campus map for, from OpenStreetMap. Room search in the page
# works from these: a room code's letters name its building ("D2" → building
# D / D-huset), and any room OSM has mapped indoors is matched exactly.
# Refreshed monthly; the campus barely changes and Overpass is a shared service.

CAMPUSES = {
    # school id: (city, south, west, north, east)
    "KTH": ("stockholm", 59.3440, 18.0600, 59.3545, 18.0790),
    "SU": ("stockholm", 59.3590, 18.0440, 59.3720, 18.0680),
}
CAMPUS_CACHE = DATA / "campus_cache.json"
CAMPUS_MAX_AGE_DAYS = 30


def _ring(geom):
    """[[lat, lon], …] at 5 decimals, thinned to every other vertex past 40."""
    pts = [[round(p["lat"], 5), round(p["lon"], 5)] for p in geom or []]
    return pts[::2] + [pts[-1]] if len(pts) > 40 else pts


def _center(pts):
    return [round(sum(p[0] for p in pts) / len(pts), 6), round(sum(p[1] for p in pts) / len(pts), 6)] if pts else None


def campus_from_elements(elements: list) -> dict:
    buildings, rooms, pois = [], [], []
    for e in elements:
        tags = e.get("tags") or {}
        if e["type"] == "way" and e.get("geometry"):
            pts = _ring(e["geometry"])
        elif e["type"] == "relation":
            outer = [m for m in e.get("members", []) if m.get("role") == "outer" and m.get("geometry")]
            pts = _ring(outer[0]["geometry"]) if outer else []
        else:
            pts = []
        at = [round(e["lat"], 6), round(e["lon"], 6)] if "lat" in e else _center(pts)
        if not at:
            continue
        if tags.get("building") and pts:
            name, ref = tags.get("name"), tags.get("ref") or tags.get("building:ref")
            if not (name or ref or tags.get("addr:street")):
                continue   # an unnamed shed is no use to a room search
            buildings.append({"name": name, "ref": ref, "alt": tags.get("alt_name") or tags.get("old_name"),
                              "addr": " ".join(filter(None, [tags.get("addr:street"), tags.get("addr:housenumber")])) or None,
                              "levels": tags.get("building:levels"), "poly": pts, "at": at})
        elif tags.get("indoor") == "room" or tags.get("room"):
            ref = tags.get("ref") or tags.get("name")
            if ref:
                rooms.append({"ref": ref, "name": tags.get("name"), "level": tags.get("level"), "at": at})
        elif tags.get("entrance") or tags.get("amenity") in ("library", "cafe", "restaurant", "fast_food", "bicycle_parking", "toilets"):
            kind = "entrance" if tags.get("entrance") else tags["amenity"]
            if kind == "bicycle_parking" and not tags.get("name"):
                continue
            pois.append({"kind": kind, "name": tags.get("name") or tags.get("ref"), "at": at})
    return {"buildings": buildings, "rooms": rooms, "pois": pois}


def enrich_campus(site: Path, payloads: dict) -> None:
    from monitor import OVERPASS_URLS
    cache = load(CAMPUS_CACHE, {})
    for sid, (city, s, w, n, e) in CAMPUSES.items():
        if city not in payloads:
            continue
        rec = cache.get(sid)
        if not rec or rec.get("at", "") < (now() - timedelta(days=CAMPUS_MAX_AGE_DAYS)).isoformat():
            bbox = f"{s},{w},{n},{e}"
            # Only what a search can use: buildings with a name or ref (all
            # buildings with geometry made every mirror time out), rooms with a
            # ref, entrances and a few amenities.
            query = f"""[out:json][timeout:60][bbox:{bbox}];
(
  way["building"]["name"];
  way["building"]["ref"];
  relation["building"]["name"];
  nwr["indoor"="room"]["ref"];
  node["entrance"];
  node["amenity"~"^(library|cafe|restaurant|fast_food|toilets)$"];
);
out geom qt;"""
            attempts = [u for u in OVERPASS_URLS] * 2
            for n_try, url in enumerate(attempts):
                if n_try == len(OVERPASS_URLS):
                    time.sleep(20)      # every mirror refused once; give them a moment
                try:
                    r = requests.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=90)
                    if not r.ok:
                        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:200]!r}")
                    data = campus_from_elements(r.json().get("elements", []))
                    rec = {"at": now().isoformat(timespec="seconds"), **data}
                    cache[sid] = rec
                    refs = sorted({b["ref"] for b in data["buildings"] if b.get("ref")})[:40]
                    names = sorted({b["name"] for b in data["buildings"] if b.get("name")})[:25]
                    print(f"  campus {sid}: {url} → {len(data['buildings'])} buildings, "
                          f"{len(data['rooms'])} rooms, {len(data['pois'])} points")
                    print(f"    building refs: {refs}")
                    print(f"    building names: {names}")
                    break
                except Exception as ex:  # noqa: BLE001
                    print(f"  campus {sid}: {url} → {type(ex).__name__}: {ex}")
        if rec and rec.get("buildings"):
            out = {k: rec[k] for k in ("buildings", "rooms", "pois")}
            out["bbox"] = [[s, w], [n, e]]
            (site / f"campus-{sid}.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")),
                                                     encoding="utf-8")
            payloads[city].setdefault("campus_maps", {})[sid] = f"campus-{sid}.json"
            print(f"campus {sid}: published {len(rec['buildings'])} buildings")
    save(CAMPUS_CACHE, cache)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="_site")
    ap.add_argument("--only", default="floorplans,isochrones,noise,campus")
    a = ap.parse_args(argv)
    site = Path(a.site)
    payloads = {}
    for p in sorted(site.glob("listings-*.json")):
        payloads[p.stem.removeprefix("listings-")] = json.loads(p.read_text(encoding="utf-8"))
    if not payloads:
        print("enrich: no payloads in", site)
        return 0
    steps = {"floorplans": enrich_floorplans, "isochrones": enrich_isochrones, "noise": enrich_noise,
             "campus": enrich_campus}
    for name in a.only.split(","):
        fn = steps.get(name.strip())
        if not fn:
            continue
        print(f"── enrich: {name}")
        try:
            fn(site, payloads)
        except Exception as e:  # noqa: BLE001 — extras never fail a deploy
            print(f"::warning title=enrich {name}::{type(e).__name__}: {e}")
    for city, data in payloads.items():
        (site / f"listings-{city}.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
