"""History store: observations, closings, re-listings and readiness gates.

Run with:  python -m unittest discover -s tests
"""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import history  # noqa: E402


def ts(day, hour=12):
    return (datetime(2026, 10, 1, tzinfo=timezone.utc) + timedelta(days=day, hours=hour - 12)
            ).isoformat(timespec="seconds")


def sssb(room, area="Jerum", days=100, apps=3, rent=5000, size=18, typ="Rum i korridor"):
    return {"id": f"sssb-{area}-Studentbacken 1-{room}", "provider": "SSSB", "area": area,
            "type": typ, "queue_days": days, "applicants": apps, "rent_sek": rent,
            "size_sqm": size, "address": "Studentbacken 1"}


def bf(ad, apt, rent=7000, size=25):
    return {"id": f"bf-{ad}", "provider": "Bostadsförmedlingen", "area": "Kärrtorp",
            "type": "1 rum och kök", "rent_sek": rent, "size_sqm": size,
            "apartment_id": apt, "address": "Söderarmsvägen 30"}


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.h = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_at(self, when, listings):
        return history.update_city(self.h, "stockholm",
                                   {"generated_at": when, "listings": listings}, now=when)

    def test_observations_only_recorded_on_change(self):
        for hour in range(10, 16):
            self.run_at(ts(0, hour), [sssb(1101, days=100)])
        self.run_at(ts(0, 16), [sssb(1101, days=140, apps=5)])
        rec = json.loads((self.h / "stockholm/open.json").read_text())["sssb-Jerum-Studentbacken 1-1101"]
        self.assertEqual(len(rec["obs"]), 2, "unchanged hours must not each add a row")
        self.assertEqual(rec["obs"][-1][1:], [140, 5])

    def test_close_keeps_final_days_when_watched_to_the_end(self):
        self.run_at(ts(0, 9), [sssb(1101, days=80)])
        self.run_at(ts(1, 9), [sssb(1101, days=120)])
        self.run_at(ts(1, 12), [])                      # gone 3 h after last sight
        closed = json.loads((self.h / f"stockholm/closed-{ts(1)[:7]}.json").read_text())
        self.assertEqual(closed["sssb-Jerum-Studentbacken 1-1101"]["final_days"], 120)

    def test_no_final_when_it_vanished_during_a_gap(self):
        self.run_at(ts(0, 9), [sssb(1101, days=80)])
        self.run_at(ts(2, 9), [])                       # 48 h unseen — not trustworthy
        closed = json.loads((self.h / f"stockholm/closed-{ts(2)[:7]}.json").read_text())
        self.assertIsNone(closed["sssb-Jerum-Studentbacken 1-1101"]["final_days"])

    def test_bf_relisting_is_recognised_by_flat_not_ad(self):
        self.run_at(ts(0), [bf(500, apt="A-77")])
        self.run_at(ts(3), [])                          # nobody took it
        r = self.run_at(ts(10), [bf(612, apt="A-77")])  # same flat, new ad number
        self.assertEqual(r["relisted"], 1)
        s = history.summarize_city(self.h, "stockholm", today=ts(10)[:10])
        self.assertIn("bf-612", s["relisted"])
        self.assertEqual(s["relisted"]["bf-612"]["times"], 1)

    def test_sssb_room_back_on_the_market(self):
        self.run_at(ts(0, 9), [sssb(1101, days=90)])
        self.run_at(ts(0, 12), [])
        self.run_at(ts(20), [sssb(1101, days=30)])
        s = history.summarize_city(self.h, "stockholm", today=ts(20)[:10])
        self.assertIn("sssb-Jerum-Studentbacken 1-1101", s["relisted"])
        self.assertEqual(s["relisted"]["sssb-Jerum-Studentbacken 1-1101"]["last_final_days"], 90)

    def test_gates_start_closed_and_say_how_far_along(self):
        self.run_at(ts(0), [sssb(1101)])
        s = history.summarize_city(self.h, "stockholm", today=ts(0)[:10])
        for name, g in s["gates"].items():
            self.assertFalse(g["ready"], name)
            self.assertIn("have", g)
            self.assertIn("need", g)
        self.assertIsNone(s["market"])

    def test_difficulty_and_market_open_once_there_is_enough(self):
        areas = ["Jerum", "Lappkärrsberget", "Kungshamra", "Idun", "Strix", "Forum"]
        room = 1000
        for day in range(40):
            listings = []
            for i, area in enumerate(areas):
                room += 1
                listings.append(sssb(room, area=area, days=100 + i * 50 + day))
            self.run_at(ts(day, 9), listings)
            self.run_at(ts(day, 12), [])                # all close the same day
        s = history.summarize_city(self.h, "stockholm", today=ts(39)[:10])
        self.assertTrue(s["gates"]["difficulty"]["ready"])
        self.assertTrue(s["gates"]["market"]["ready"])
        self.assertTrue(s["gates"]["projected_wait"]["ready"])
        self.assertGreater(s["areas"]["Forum"]["median"], s["areas"]["Jerum"]["median"])
        self.assertIsNotNone(s["market"])
        self.assertIn(s["market"]["verdict"], {"better", "typical", "tighter"})

    def test_uplift_needs_a_day_of_observation_before_closing(self):
        for i in range(25):
            room = 2000 + i
            self.run_at(ts(i, 8), [sssb(room, days=100)])
            self.run_at(ts(i + 1, 9), [sssb(room, days=130)])   # +30% over the last day
            self.run_at(ts(i + 1, 11), [])
        s = history.summarize_city(self.h, "stockholm", today=ts(26)[:10])
        self.assertTrue(s["gates"]["pick3"]["ready"])
        self.assertAlmostEqual(s["uplift"]["median_ratio"], 1.3, places=2)

    def test_value_comparables(self):
        listings = [sssb(3000 + i, rent=4500 + i * 10, size=18) for i in range(16)]
        self.run_at(ts(0), listings)
        s = history.summarize_city(self.h, "stockholm", today=ts(0)[:10])
        self.assertTrue(s["gates"]["value"]["ready"])
        self.assertIn("SSSB|corridor", s["value"])

    def test_type_class(self):
        self.assertEqual(history.type_class({"type": "Rum i korridor"}), "corridor")
        self.assertEqual(history.type_class({"type": "Corridor room (dorm)"}), "corridor")
        self.assertEqual(history.type_class({"type": "1 rum & pentry"}), "1room")
        self.assertEqual(history.type_class({"type": "2 rum och kök"}), "2plus")
        self.assertEqual(history.type_class({"type": None, "size_sqm": 45}), "2plus")


if __name__ == "__main__":
    unittest.main()
