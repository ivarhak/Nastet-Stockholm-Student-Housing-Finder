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


if __name__ == "__main__":
    unittest.main()
