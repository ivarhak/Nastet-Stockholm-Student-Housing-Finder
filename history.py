"""Nästet's memory.

Every scrape is a snapshot of what's available *right now*. Several features
need to know what happened before — what an SSSB room actually went for, how
the market compares with usual, whether a flat has been back on the market —
and a snapshot can't answer any of that. This module keeps that history on a
separate `data` branch and publishes a compact summary next to the site.

Layout under the history directory, per city:

    <city>/open.json              listings seen on the latest run, keyed by id
    <city>/closed-YYYY-MM.json    listings that disappeared, by month closed
    <city>/units.json             physical flat → every time it was listed
    <city>/daily.json             one aggregate row per provider per day

Each listing record keeps its observations only when they change, so a room
that sits at "91 days (3 applicants)" for a week costs one entry, not 168.

The published summary (history-<city>.json) carries a `gates` block: one entry
per data-hungry feature, with whether there's enough history yet and how far
along it is. The dashboard reads those and shows "enabled when more data has
been collected" until a feature's numbers would mean something. The thresholds
live in GATES below, in one place, so they can be argued about.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ── Readiness thresholds ─────────────────────────────────────────────────────
# Chosen so that a number the page shows is a median of something rather than
# an anecdote. Each is the *minimum*; more is better.
GATES = {
    # The market gauge compares the last week with the weeks before it, so it
    # needs at least four weeks of daily rows to have a baseline at all.
    "market": {"days": 28},
    # "What areas went for" — a median per area needs a handful of closings in
    # enough areas for the map colouring to say anything.
    "difficulty": {"finals": 30, "areas_with_3": 5},
    # Projected wait reads per segment (area × type), the thinnest slice.
    "projected_wait": {"finals": 30, "days": 21},
    # How much the leader's days typically climb in the last day before a
    # listing closes — needs listings observed for at least 24 h before closing.
    "pick3": {"uplift_samples": 20},
    # A re-listing can only be noticed once a flat has had time to close and
    # come back, so "not re-listed" means nothing until a month has passed.
    "relisting": {"days": 30},
    # Rent per m² against comparable flats — needs enough comparables per
    # provider and type for a median to be fair.
    "value": {"comparables": 15},
}

# A listing whose last observation is this close to when it disappeared is
# treated as having run to its deadline; earlier disappearances (withdrawn,
# scrape gaps) don't count as a "final" figure.
FINAL_GAP_HOURS = 6


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse_ts(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _load(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _save(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Sorted and indented so the data branch's diffs are readable line by line.
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1, sort_keys=True),
                    encoding="utf-8")


# ── Classification ───────────────────────────────────────────────────────────

def type_class(listing: dict) -> str:
    """corridor | 1room | 2plus. Coarse on purpose: finer slices would leave
    each one too few closings to take a median of."""
    t = (listing.get("type") or "").lower()
    # "Rum i kollektiv" — a room in a shared flat — competes with corridor
    # rooms, not with flats of its own size; live data has both side by side.
    if "korridor" in t or "corridor" in t or "kollektiv" in t:
        return "corridor"
    m = re.match(r"\s*(\d+)\s*(rum|room)", t)
    if m:
        return "1room" if int(m.group(1)) <= 1 else "2plus"
    if "studio" in t or "student" in t or "etta" in t:
        return "1room"
    size = listing.get("size_sqm") or 0
    if size and size < 20:
        return "corridor"
    return "1room" if not size or size < 40 else "2plus"


def unit_key(listing: dict) -> str:
    """The physical flat, so the same one listed twice can be recognised.

    SSSB's id is already the room (area + address + apartment number). BF's
    ad id changes on every re-post, but its LägenhetId doesn't. Everything
    else falls back to address + size + floor, which is close enough to tell
    one flat from its neighbours.
    """
    lid = str(listing.get("id") or "")
    if lid.startswith("sssb-"):
        return lid
    if listing.get("apartment_id"):
        return f"{listing.get('provider')}:apt:{listing['apartment_id']}"
    return (f"{listing.get('provider')}:{listing.get('address')}:"
            f"{listing.get('size_sqm')}:{listing.get('floor')}")


def segment_key(area: str | None, cls: str) -> str:
    return f"{area or 'Unknown'}|{cls}"


def rent_per_sqm(listing: dict) -> float | None:
    rent, size = listing.get("rent_sek"), listing.get("size_sqm")
    try:
        rent, size = float(rent), float(size)
    except (TypeError, ValueError):
        return None
    return round(rent / size, 1) if rent > 0 and size > 0 else None


# ── Updating ─────────────────────────────────────────────────────────────────

def update_city(hist_dir: Path, city: str, payload: dict, now: str | None = None) -> dict:
    """Fold one scrape's payload into the city's history. Returns counts for
    the run log."""
    now = now or payload.get("generated_at") or _now_iso()
    cdir = hist_dir / city
    open_ = _load(cdir / "open.json", {})
    units = _load(cdir / "units.json", {})
    daily = _load(cdir / "daily.json", {})

    seen_ids = set()
    opened = relisted = 0
    for l in payload.get("listings") or []:
        lid = str(l.get("id"))
        seen_ids.add(lid)
        obs_point = [now, l.get("queue_days"), l.get("applicants")]
        rec = open_.get(lid)
        if rec is None:
            ukey = unit_key(l)
            prior = units.get(ukey, [])
            rec = {
                "provider": l.get("provider"), "area": l.get("area"),
                "type": l.get("type"), "class": type_class(l),
                "rent": l.get("rent_sek"), "size": l.get("size_sqm"),
                "floor": l.get("floor"), "address": l.get("address"),
                "unit": ukey, "deadline": l.get("deadline"),
                "move_in": l.get("move_in"),
                "published_at": l.get("published_at"),
                "first_seen": now, "last_seen": now,
                "obs": [obs_point],
                # Earlier listings of the same flat — the re-listing signal.
                "prior_listings": len(prior),
            }
            open_[lid] = rec
            units.setdefault(ukey, []).append({"id": lid, "first_seen": now})
            opened += 1
            relisted += 1 if prior else 0
        else:
            rec["last_seen"] = now
            rec["rent"] = l.get("rent_sek", rec.get("rent"))
            # Only record a change: the leader's days and the applicant count
            # are what move; storing every unchanged hour would bloat the file.
            last = rec["obs"][-1] if rec.get("obs") else None
            if not last or last[1:] != obs_point[1:]:
                rec.setdefault("obs", []).append(obs_point)

    # Anything open that this scrape didn't see has closed.
    closed_now = 0
    now_dt = _parse_ts(now)
    for lid in [k for k in open_ if k not in seen_ids]:
        rec = open_.pop(lid)
        rec["closed_at"] = now
        last_seen = _parse_ts(rec.get("last_seen"))
        gap_h = (now_dt - last_seen).total_seconds() / 3600 if now_dt and last_seen else 999
        # The last leader figure we saw. Only trusted as "what it took" when we
        # were watching up to the end — and even then it's a floor, since
        # applicants who register in the final minutes are never observed.
        days = [o[1] for o in rec.get("obs", []) if isinstance(o[1], (int, float))]
        rec["final_days"] = days[-1] if days and gap_h <= FINAL_GAP_HOURS else None
        shard = cdir / f"closed-{now[:7]}.json"
        closed = _load(shard, {})
        closed[lid] = rec
        _save(shard, closed)
        for occ in units.get(rec.get("unit"), []):
            if occ["id"] == lid and "closed_at" not in occ:
                occ["closed_at"] = now
                occ["final_days"] = rec["final_days"]
        closed_now += 1

    # One aggregate row per provider per day; the day's last run wins.
    day = now[:10]
    rows = {}
    for l in payload.get("listings") or []:
        p = l.get("provider") or "?"
        r = rows.setdefault(p, {"available": 0, "rent_sqm": [], "leader_days": []})
        r["available"] += 1
        v = rent_per_sqm(l)
        if v:
            r["rent_sqm"].append(v)
        if isinstance(l.get("queue_days"), (int, float)):
            r["leader_days"].append(l["queue_days"])
    daily[day] = {
        p: {
            "available": r["available"],
            "median_rent_sqm": round(statistics.median(r["rent_sqm"]), 1) if r["rent_sqm"] else None,
            "median_leader_days": statistics.median(r["leader_days"]) if r["leader_days"] else None,
            "new": sum(1 for rec in open_.values()
                       if rec.get("provider") == p and str(rec.get("first_seen", ""))[:10] == day),
        }
        for p, r in rows.items()
    }

    _save(cdir / "open.json", open_)
    _save(cdir / "units.json", units)
    _save(cdir / "daily.json", daily)
    return {"opened": opened, "relisted": relisted, "closed": closed_now,
            "open": len(open_), "days": len(daily)}


# ── Summarising ──────────────────────────────────────────────────────────────

def _closed_records(cdir: Path) -> dict:
    out = {}
    for shard in sorted(cdir.glob("closed-*.json")):
        out.update(_load(shard, {}))
    return out


def _quantiles(values: list) -> dict:
    v = sorted(values)
    if not v:
        return {}
    def q(p):
        i = (len(v) - 1) * p
        lo, hi = int(i), min(int(i) + 1, len(v) - 1)
        return round(v[lo] + (v[hi] - v[lo]) * (i - lo))
    return {"n": len(v), "p25": q(0.25), "median": q(0.5), "p75": q(0.75)}


def _uplift_ratios(closed: dict) -> list:
    """For listings watched for at least a day before closing: final days ÷
    the leader's days 24 h before. How much late applicants push it up."""
    ratios = []
    for rec in closed.values():
        final = rec.get("final_days")
        closed_at = _parse_ts(rec.get("closed_at"))
        if not final or not closed_at:
            continue
        cutoff = closed_at - timedelta(hours=24)
        earlier = [o for o in rec.get("obs", [])
                   if isinstance(o[1], (int, float)) and o[1] > 0
                   and (_parse_ts(o[0]) or closed_at) <= cutoff]
        if earlier:
            ratios.append(final / earlier[-1][1])
    return ratios


def _median_or_none(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return statistics.median(xs) if xs else None


def market_summary(daily: dict, closed: dict, today: str) -> dict | None:
    """Last 7 days against the weeks before them: availability, rent per m²,
    and (SSSB) what closings went for. None until there is a baseline."""
    days = sorted(daily)
    if len(days) < GATES["market"]["days"]:
        return None
    cut = (datetime.fromisoformat(today) - timedelta(days=7)).date().isoformat()
    base_from = (datetime.fromisoformat(today) - timedelta(days=63)).date().isoformat()

    def avg_over(lo, hi, field, agg):
        vals = []
        for d in days:
            if lo <= d < hi:
                rows = daily[d].values()
                v = agg([r.get(field) for r in rows if r.get(field) is not None])
                if v is not None:
                    vals.append(v)
        return statistics.mean(vals) if vals else None

    total = lambda xs: sum(xs) if xs else None
    now_avail = avg_over(cut, "9999", "available", total)
    base_avail = avg_over(base_from, cut, "available", total)
    now_rent = avg_over(cut, "9999", "median_rent_sqm", _median_or_none)
    base_rent = avg_over(base_from, cut, "median_rent_sqm", _median_or_none)

    def finals_between(lo, hi):
        return [r["final_days"] for r in closed.values()
                if r.get("final_days") and lo <= str(r.get("closed_at", ""))[:10] < hi]
    now_fin = _median_or_none(finals_between(cut, "9999"))
    base_fin = _median_or_none(finals_between(base_from, cut))

    # Each component as "how much better than usual", positive = better for a
    # seeker: more available, cheaper, fewer days needed.
    comps = {}
    if now_avail and base_avail:
        comps["availability"] = round(now_avail / base_avail - 1, 3)
    if now_rent and base_rent:
        comps["rent"] = round(base_rent / now_rent - 1, 3)
    if now_fin and base_fin:
        comps["difficulty"] = round(base_fin / now_fin - 1, 3)
    if not comps:
        return None
    score = statistics.mean(comps.values())
    verdict = "better" if score > 0.10 else "tighter" if score < -0.10 else "typical"
    return {
        "verdict": verdict, "score": round(score, 3), "components": comps,
        "now": {"available": now_avail and round(now_avail, 1),
                "rent_sqm": now_rent and round(now_rent, 1), "final_days": now_fin},
        "baseline": {"available": base_avail and round(base_avail, 1),
                     "rent_sqm": base_rent and round(base_rent, 1), "final_days": base_fin},
        # Sparkline material: total available per day.
        "series": [[d, sum(r.get("available") or 0 for r in daily[d].values())] for d in days[-90:]],
    }


def summarize_city(hist_dir: Path, city: str, today: str | None = None) -> dict:
    cdir = hist_dir / city
    open_ = _load(cdir / "open.json", {})
    units = _load(cdir / "units.json", {})
    daily = _load(cdir / "daily.json", {})
    closed = _closed_records(cdir)
    today = today or _now_iso()[:10]
    days_collected = len(daily)

    finals = [r for r in closed.values() if r.get("final_days")]
    segs, areas = {}, {}
    for r in finals:
        segs.setdefault(segment_key(r.get("area"), r.get("class")), []).append(
            (r["final_days"], str(r.get("closed_at", ""))[:10]))
        areas.setdefault(r.get("area") or "Unknown", []).append(r["final_days"])
    segments = {
        k: {**_quantiles([d for d, _ in v]),
            "recent": sorted(v, key=lambda x: x[1])[-8:]}
        for k, v in segs.items()
    }
    area_stats = {k: _quantiles(v) for k, v in areas.items()}
    areas_with_3 = sum(1 for v in area_stats.values() if v.get("n", 0) >= 3)

    ratios = _uplift_ratios(closed)
    uplift = ({"median_ratio": round(statistics.median(ratios), 3),
               "p75_ratio": round(_quantiles([r * 1000 for r in ratios])["p75"] / 1000, 3),
               "n": len(ratios)} if ratios else {"n": 0})

    # Comparables for the value badge: what's open now plus everything closed
    # in the last 60 days, per provider and type class.
    since = (datetime.fromisoformat(today) - timedelta(days=60)).date().isoformat()
    comp = {}
    for r in list(open_.values()) + [r for r in closed.values()
                                     if str(r.get("closed_at", ""))[:10] >= since]:
        v = rent_per_sqm({"rent_sek": r.get("rent"), "size_sqm": r.get("size")})
        if v:
            comp.setdefault(f"{r.get('provider')}|{r.get('class')}", []).append(v)
    value = {k: {"n": len(v), "median_rent_sqm": round(statistics.median(v), 1),
                 "p25": round(sorted(v)[len(v) // 4], 1)}
             for k, v in comp.items()}
    max_comps = max((x["n"] for x in value.values()), default=0)

    # Re-listings among what's open right now.
    relisted = {}
    for lid, r in open_.items():
        prior = [o for o in units.get(r.get("unit"), []) if o["id"] != lid or o.get("closed_at")]
        prior = [o for o in prior if o.get("closed_at")]
        if prior:
            last = max(prior, key=lambda o: o["closed_at"])
            relisted[lid] = {"times": len(prior), "last_closed": last["closed_at"][:10],
                             "last_final_days": last.get("final_days")}

    g = GATES
    gates = {
        "market": {"ready": days_collected >= g["market"]["days"],
                   "have": days_collected, "need": g["market"]["days"], "unit": "days"},
        "difficulty": {"ready": len(finals) >= g["difficulty"]["finals"]
                       and areas_with_3 >= g["difficulty"]["areas_with_3"],
                       "have": len(finals), "need": g["difficulty"]["finals"], "unit": "closings"},
        "projected_wait": {"ready": len(finals) >= g["projected_wait"]["finals"]
                           and days_collected >= g["projected_wait"]["days"],
                           "have": len(finals), "need": g["projected_wait"]["finals"],
                           "unit": "closings"},
        "pick3": {"ready": uplift["n"] >= g["pick3"]["uplift_samples"],
                  "have": uplift["n"], "need": g["pick3"]["uplift_samples"],
                  "unit": "closings"},
        "relisting": {"ready": days_collected >= g["relisting"]["days"],
                      "have": days_collected, "need": g["relisting"]["days"], "unit": "days"},
        "value": {"ready": max_comps >= g["value"]["comparables"],
                  "have": max_comps, "need": g["value"]["comparables"],
                  "unit": "comparable listings"},
    }
    return {
        "city": city, "generated_at": _now_iso(),
        "since": min(daily) if daily else None, "days_collected": days_collected,
        "gates": gates, "segments": segments, "areas": area_stats,
        "uplift": uplift, "value": value, "relisted": relisted,
        "market": market_summary(daily, closed, today),
    }


# ── CLI ──────────────────────────────────────────────────────────────────────

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("mode", choices=["update", "summarize"])
    ap.add_argument("--history", required=True, type=Path,
                    help="history directory (on the data branch checkout)")
    ap.add_argument("--out", type=Path, help="where summarize writes history-<city>.json")
    args = ap.parse_args(argv)

    sys.path.insert(0, str(Path(__file__).parent))
    from monitor import CITIES, listings_file  # noqa: E402  (heavy; only on the CLI)

    for cid, conf in CITIES.items():
        if not conf.get("enabled", True):
            continue
        if args.mode == "update":
            path = listings_file(cid)
            if not path.exists():
                print(f"history {cid}: no payload — skipped")
                continue
            r = update_city(args.history, cid, _load(path, {}))
            # Verbose on purpose: this is how a broken history gets noticed.
            print(f"history {cid}: +{r['opened']} opened ({r['relisted']} re-listed), "
                  f"{r['closed']} closed, {r['open']} open, {r['days']} day(s) of history")
        else:
            if not args.out:
                ap.error("summarize needs --out")
            s = summarize_city(args.history, cid)
            args.out.mkdir(parents=True, exist_ok=True)
            (args.out / f"history-{cid}.json").write_text(
                json.dumps(s, ensure_ascii=False), encoding="utf-8")
            ready = [k for k, v in s["gates"].items() if v["ready"]]
            waiting = [f"{k} {v['have']}/{v['need']}" for k, v in s["gates"].items() if not v["ready"]]
            print(f"history {cid}: {s['days_collected']} day(s) · ready: {', '.join(ready) or 'none'}"
                  f" · collecting: {', '.join(waiting) or 'nothing'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
