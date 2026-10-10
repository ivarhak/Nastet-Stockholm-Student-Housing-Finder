"""Offline parts of enrich.py: link discovery, dB parsing, plan rendering.

Run with:  python -m unittest discover -s tests
"""
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import enrich  # noqa: E402


class EnrichTest(unittest.TestCase):
    def test_plan_links_prefer_pdf_and_resolve_relative(self):
        html = ('<a href="/kontakt">Kontakt</a>'
                '<a href="/media/abc/bild.jpg">Planritning</a>'
                '<a href="/globalassets/plan_1313.pdf?v=2&amp;x=1">Ladda ner</a>')
        links = enrich.find_plan_links(html, "https://sssb.se/objekt/?refid=1")
        self.assertEqual(links[0], "https://sssb.se/globalassets/plan_1313.pdf?v=2&x=1")
        self.assertIn("https://sssb.se/media/abc/bild.jpg", links)
        self.assertNotIn("https://sssb.se/kontakt", links)

    def test_widget_documents(self):
        # The shape run 462 got back from SSSB's objektdokument widget.
        body = ('cb({"html":{"alert":"","objektdokument":"\\n<div class=\\"ObjektDokument\\">\\n<ul>\\n'
                '<li class=\\"DokumentItem TypVanrit\\">\\n<a class=\\"btn\\" target=\\"_blank\\" '
                'href=\\"//minasidor.sssb.se/spin/?id=207375&amp;idHash=ASkuk3mI9-o\\">Planritning</a></li>'
                '<li class=\\"DokumentItem TypOvrigt\\"><a href=\\"/x\\">Info</a></li></ul></div>"}})')
        docs = enrich.documents_from_widget(body)
        self.assertEqual(docs[0][0], "TypVanrit")
        self.assertEqual(docs[0][1], "//minasidor.sssb.se/spin/?id=207375&idHash=ASkuk3mI9-o")
        self.assertEqual(len(docs), 2)

    def test_campus_clipped_to_university_outline(self):
        sq = lambda a, b: [{"lat": a, "lon": a}, {"lat": a, "lon": b}, {"lat": b, "lon": b}, {"lat": b, "lon": a}, {"lat": a, "lon": a}]
        els = [{"type": "way", "tags": {"amenity": "university", "name": "Kungliga Tekniska högskolan"}, "geometry": sq(0, 1)},
               {"type": "way", "tags": {"amenity": "university", "name": "Kungliga Musikhögskolan"}, "geometry": sq(2, 3)},
               {"type": "way", "tags": {"building": "yes", "name": "KTH: D"}, "geometry": sq(.4, .5)},
               {"type": "way", "tags": {"building": "church", "name": "Engelbrektskyrkan"}, "geometry": sq(2.2, 2.3)},
               {"type": "node", "lat": .2, "lon": .2, "tags": {"entrance": "main"}},
               {"type": "node", "lat": 5, "lon": 5, "tags": {"entrance": "yes"}}]
        d = enrich.campus_from_elements(els, enrich.CAMPUS_NAMES["KTH"])
        self.assertEqual([b["name"] for b in d["buildings"]], ["KTH: D"])
        self.assertEqual(len(d["pois"]), 1)
        self.assertEqual(len(d["outline"]), 1)

    def test_campus_without_outline_uses_its_own_buildings(self):
        sq = lambda a, b: [{"lat": a, "lon": a}, {"lat": a, "lon": b}, {"lat": b, "lon": b}, {"lat": b, "lon": a}, {"lat": a, "lon": a}]
        els = [{"type": "way", "tags": {"building": "yes", "name": "KTH: D"}, "geometry": sq(59.3470, 59.3472)},
               {"type": "way", "tags": {"building": "yes", "name": "KTH: Q"}, "geometry": sq(59.3480, 59.3482)},
               {"type": "way", "tags": {"building": "yes", "name": "M-huset"}, "geometry": sq(59.3475, 59.3476)},
               {"type": "way", "tags": {"building": "church", "name": "Engelbrektskyrkan"}, "geometry": sq(59.3420, 59.3421)}]
        d = enrich.campus_from_elements(els, enrich.CAMPUS_NAMES["KTH"])
        names = [b["name"] for b in d["buildings"]]
        self.assertIn("M-huset", names)            # between KTH's own buildings
        self.assertNotIn("Engelbrektskyrkan", names)
        self.assertEqual(len(d["outline"]), 1)

    def test_db_from_attrs(self):
        self.assertEqual(enrich.db_from_attrs({"OBJECTID": 7, "dB_intervall": "55-60 dBA"}), 55.0)
        self.assertEqual(enrich.db_from_attrs({"LEQ24": 62}), 62.0)
        self.assertIsNone(enrich.db_from_attrs({"OBJECTID": 7, "Shape__Area": 1234.5}))

    def test_noise_bands(self):
        self.assertEqual(enrich.noise_band(40), "quiet")
        self.assertEqual(enrich.noise_band(50), "moderate")
        self.assertEqual(enrich.noise_band(60), "noisy")
        self.assertEqual(enrich.noise_band(70), "very_noisy")

    def test_render_pdf_page_one(self):
        try:
            import fitz
        except ImportError:
            self.skipTest("PyMuPDF not installed")
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        page.draw_rect(fitz.Rect(50, 50, 545, 400), color=(0, 0, 0), width=2)
        png = enrich.render_plan(doc.tobytes(), "application/pdf")
        from PIL import Image
        img = Image.open(io.BytesIO(png))
        self.assertEqual(img.width, enrich.PLAN_WIDTH)
        self.assertLess(len(png), 60_000)
        # The drawing (a 495x350 box on an A4 page) is cropped out of the page,
        # so the result is wider than it is tall, not A4-shaped.
        self.assertLess(img.height, img.width)


if __name__ == "__main__":
    unittest.main()
