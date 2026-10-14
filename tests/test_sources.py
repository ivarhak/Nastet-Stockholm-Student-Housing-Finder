"""Source parsing and data-integrity checks, from the live audit on 2026-10-14.

Each case is a real shape seen on the landlord's own pages that day.
"""
from datetime import datetime, timezone, timedelta

import history
import monitor as m


def card(type_, addr, extras="", values="Strix 16 m² 3 622 kr 2026-10-16 268 (5st) 2"):
    return (f"Previous Next {type_} {addr} {extras} Område: Boyta: Hyra: Inflyttning: "
            f"Ködagar: Våning: {values}")


def test_sssb_type_with_entrance_letter_and_multiword_street():
    # Both used to fail: no type at all, or "1 rum & pentry Norra".
    assert m._parse_card_fields(card("Rum i korridor", "Armégatan 32 A / 1213", "10 mån hyra Elström ingår Max 4 år"))[0] == "Rum i korridor"
    assert m._parse_card_fields(card("1 rum & pentry", "Norra Stationsgatan 99 / 1673"))[0] == "1 rum & pentry"
    assert m._parse_card_fields(card("Rum i kollektiv", "Kammakargatan 36 A / 1402"))[0] == "Rum i kollektiv"
    assert m._parse_card_fields(card("1 rum & kök", "Forskarbacken 10 / 1002"))[0] == "1 rum & kök"


def test_sssb_rent_months_and_electricity():
    text = card("Rum i korridor", "Armégatan 32 A / 1213", "10 mån hyra Elström ingår Max 4 år")
    assert m._parse_card_extras(text)["rent_months"] == 10
    assert m._parse_card_extras(card("1 rum & kök", "Forskarbacken 10 / 1002"))["rent_months"] is None
    assert m._parse_el_included("Elström ingår ej") is False
    assert m._parse_el_included("Elström ingår") is True
    assert m._parse_el_included("nothing said") is None


def test_dotnet_dates_are_swedish_dates():
    # SGS stamps 1 January 2027 at local midnight = 23:00 UTC on 31 December.
    assert m._dotnet_date("/Date(1798758000000)/") == "2027-01-01"
    assert m._dotnet_date("/Date(1792015140000)/") == "2026-10-14"   # 23:59 local deadline


def test_sgs_details():
    d = {"application": {"openTo": "/Date(1792015140000)/"},
         "location": {"floorDisplayName": "Våning 1", "officialApartmentNumber": "1103",
                      "address": {"address": "Volrat Thamsgatan 20 "}},
         "included": [{"displayName": "2026 års hyra"}, {"displayName": "Elförbrukning tillkommer"}]}
    out = m._sgs_details(d)
    assert out == {"deadline": "2026-10-14", "floor": 1, "el_included": False,
                   "apartment_id": "Volrat Thamsgatan 20#1103"}
    assert m._sgs_details({"included": [{"displayName": "El ingår"}]})["el_included"] is True


BF_PAGE = """
<span class="apartment-facts__text">Boyta</span> <span class="apartment-facts__heading">25 kvm</span>
<span class="apartment-facts__text">Inflytt</span> <span class="apartment-facts__heading">2026-11-01</span>
<strong>Längsta anmälda kötider på denna bostad:</strong> <ul class="u-list-disc"> <li>2026-09-09</li> <li>2025-09-08</li> </ul>
<strong>Förmedlingshistorik</strong> De senaste tolv månaderna har vi förmedlat 174 studentbost&#xE4;der med 1 rum i
Johanneshov. 25 procent av dem hade en kötid kortare än 1 år.
"""


def test_bf_detail_page():
    out = m._bf_parse_detail(BF_PAGE)
    assert out["move_in"] == "2026-11-01"
    assert out["bf_queue_dates"] == ["2025-09-08", "2026-09-09"]          # earliest first: the leader
    assert out["bf_history"] == {"placed": 174, "pct_under": 25, "years": 1}
    assert m._bf_parse_detail("<html>no applicants</html>")["bf_queue_dates"] == []


def test_bf_details_are_fetched_once_then_reused():
    now = datetime(2026, 10, 14, 8, tzinfo=timezone.utc)

    class R:
        status_code = 200
        text = BF_PAGE
        def raise_for_status(self): pass
    calls = []
    fetch = lambda url: (calls.append(url), R())[1]
    rows = [{"id": "bf-1", "provider": "Bostadsförmedlingen", "url": "u1"}]
    m.bf_enrich_details(rows, [], now=now, fetch=fetch)
    assert calls == ["u1"] and rows[0]["move_in"] == "2026-11-01"
    again = [{"id": "bf-1", "provider": "Bostadsförmedlingen", "url": "u1"}]
    m.bf_enrich_details(again, rows, now=now + timedelta(hours=2), fetch=fetch)
    assert calls == ["u1"] and again[0]["bf_queue_dates"] == ["2025-09-08", "2026-09-09"]
    m.bf_enrich_details(again, rows, now=now + timedelta(hours=7), fetch=fetch)
    assert calls == ["u1", "u1"]


def test_a_provider_answering_nothing_keeps_the_last_open_listings():
    now = datetime(2026, 10, 10, 12, tzinfo=timezone.utc)
    prev = {"generated_at": (now - timedelta(hours=2)).isoformat(),
            "listings": [{"id": f"sgs-{i}", "provider": "SGS", "deadline": "2026-10-14"} for i in range(6)]
                        + [{"id": "sgs-old", "provider": "SGS", "deadline": "2026-10-01"}]}
    rows, notes = m._guard_empty_provider("SGS", [], [], prev, now=now)
    assert len(rows) == 6 and "kept the 6 still open" in notes[0]
    # A real answer is never second-guessed, and an old snapshot isn't reused.
    assert m._guard_empty_provider("SGS", [{"id": "x"}], [], prev, now=now)[0] == [{"id": "x"}]
    stale = {**prev, "generated_at": (now - timedelta(hours=48)).isoformat()}
    assert m._guard_empty_provider("SGS", [], [], stale, now=now)[0] == []
    # Too few before to call it a hiccup.
    few = {**prev, "listings": prev["listings"][:3]}
    assert m._guard_empty_provider("SGS", [], [], few, now=now)[0] == []


def test_af_units_are_the_product_not_the_building():
    a = {"id": "af-14351", "provider": "AF Bostäder", "address": "Kämnärsvägen 63", "size_sqm": 27.0, "floor": 1}
    b = {**a, "id": "af-14352"}
    assert history.unit_key(a) != history.unit_key(b)
    sgs = {"id": "sgs-x", "provider": "SGS", "apartment_id": "Volrat Thamsgatan 20#1103"}
    assert history.unit_key(sgs) == "SGS:apt:Volrat Thamsgatan 20#1103"


def test_history_moves_old_af_records_to_their_own_unit(tmp_path):
    import json
    city = tmp_path / "lund"
    city.mkdir()
    # The state the old key left behind: three flats filed as one unit.
    old = "AF Bostäder:Kämnärsvägen 63:27.0:1"
    t0 = "2026-10-09T20:00:00+00:00"
    (city / "units.json").write_text(json.dumps({old: [
        {"id": "af-14352", "first_seen": t0, "closed_at": "2026-10-11T22:00:00+00:00", "final_days": None},
        {"id": "af-14356", "first_seen": t0, "closed_at": "2026-10-10T01:00:00+00:00", "final_days": None},
        {"id": "af-14351", "first_seen": "2026-10-12T22:00:00+00:00"}]}))
    (city / "open.json").write_text(json.dumps({"af-14351": {
        "provider": "AF Bostäder", "unit": old, "first_seen": "2026-10-12T22:00:00+00:00",
        "last_seen": "2026-10-13T22:00:00+00:00", "obs": []}}))
    listing = {"id": "af-14351", "provider": "AF Bostäder", "address": "Kämnärsvägen 63", "size_sqm": 27.0,
               "floor": 1, "area": "Troja", "rent_sek": 6800}
    history.update_city(tmp_path, "lund", {"listings": [listing]}, now="2026-10-14T06:00:00+00:00")
    summary = history.summarize_city(tmp_path, "lund", today="2026-10-14")
    assert "af-14351" not in summary["relisted"]          # was "back on the market ×2"
    units = json.loads((city / "units.json").read_text())
    assert [o["id"] for o in units["af-14351"]] == ["af-14351"]
    assert sorted(o["id"] for o in units[old]) == ["af-14352", "af-14356"]


def test_gate_shows_the_condition_still_missing(tmp_path):
    summary = history.summarize_city(tmp_path, "nowhere", today="2026-10-14")
    pw = summary["gates"]["projected_wait"]
    assert pw["unit"] in ("closings", "days") and pw["ready"] is False


def test_a_listing_missing_for_one_run_is_not_new_again():
    now = datetime(2026, 10, 11, 12, tzinfo=timezone.utc)
    prev = {"generated_at": (now - timedelta(hours=1)).isoformat(),
            "listings": [{"id": "a", "first_seen": "2026-10-01T00:00:00+00:00"}],
            "recently_gone": {"b": {"first_seen": "2026-10-02T00:00:00+00:00",
                                     "gone_at": (now - timedelta(hours=3)).isoformat()},
                              "old": {"first_seen": "2026-09-01T00:00:00+00:00",
                                      "gone_at": (now - timedelta(days=5)).isoformat()}}}
    gone = m._recently_gone(prev, [{"id": "b"}], now)
    assert set(gone) == {"a"}                       # b is back, old has expired
    assert gone["a"]["first_seen"] == "2026-10-01T00:00:00+00:00"


def test_history_reopens_a_blip_instead_of_counting_a_relisting(tmp_path):
    import json
    l = {"id": "sgs-x", "provider": "SGS", "address": "Mejerigatan 2", "size_sqm": 20, "floor": 5,
         "area": "Mejeriet", "rent_sek": 4000}
    history.update_city(tmp_path, "goteborg", {"listings": [l]}, now="2026-10-09T12:00:00+00:00")
    history.update_city(tmp_path, "goteborg", {"listings": []}, now="2026-10-10T12:00:00+00:00")   # the empty answer
    history.update_city(tmp_path, "goteborg", {"listings": [l]}, now="2026-10-11T00:00:00+00:00")
    s = history.summarize_city(tmp_path, "goteborg", today="2026-10-11")
    assert s["relisted"] == {}
    closed = json.loads((tmp_path / "goteborg" / "closed-2026-10.json").read_text())
    assert "sgs-x" not in closed
    opened = json.loads((tmp_path / "goteborg" / "open.json").read_text())
    assert opened["sgs-x"]["first_seen"] == "2026-10-09T12:00:00+00:00"


def test_room_suffix_is_geocoded_as_its_building(monkeypatch):
    seen = []

    class R:
        def raise_for_status(self): pass
        def json(self): return [{"lat": "57.68", "lon": "12.00"}]
    monkeypatch.setattr(m.requests, "get", lambda url, params=None, **kw: (seen.append(params["q"]), R())[1])
    monkeypatch.setattr(m.time, "sleep", lambda s: None)
    monkeypatch.setattr(m, "_save_address_cache", lambda c: None)
    cache = {"Mejerigatan 2 B Rum 533": None}       # the old cached "nothing"
    assert m.geocode_listing_address("Mejerigatan 2 B Rum 533", "Ostkupan", cache,
                                     hint="Mejerigatan 2, 41248, Göteborg, Sweden") == [57.68, 12.0]
    assert seen == ["Mejerigatan 2, 41248, Göteborg, Sweden"] and "Mejerigatan 2 B" in cache
