"""The picture a pasted link unfurls into (og:image), drawn at build time.

    python og_image.py --cities _site/cities.json --out _site/og.png

Drawn rather than a static file so the headline figure is the real count at the
moment the site was assembled, like the page description next to it. Uses the
same Archivo and JetBrains Mono the page self-hosts: Pillow can't read woff2, so
fontTools unpacks them in memory and pins the variable axes to one instance.
"""
import argparse
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
W, H = 1200, 630

# The page's dark theme, so a link and the site it opens look like one thing.
BG, PANEL, RULE = "#14171a", "#1a1e21", "#333a3d"
INK, DIM, OCHRE = "#e7ece4", "#8e9a8b", "#d3a244"


def font(name, size, **axes):
    """A vendored variable woff2 at fixed axes, or Pillow's default if that fails.

    A missing font must never stop a deploy — a plainer card beats no card.
    """
    try:
        from fontTools.ttLib import TTFont
        from fontTools.varLib import instancer
        tt = TTFont(ROOT / "vendor" / "fonts" / name)
        tt.flavor = None
        if "fvar" in tt:
            have = {a.axisTag for a in tt["fvar"].axes}
            tt = instancer.instantiateVariableFont(
                tt, {k: v for k, v in axes.items() if k in have})
        buf = io.BytesIO()
        tt.save(buf)
        buf.seek(0)
        return ImageFont.truetype(buf, size)
    except Exception as e:   # noqa: BLE001 — any failure falls back the same way
        print(f"og_image: {name} unavailable ({e}); using the default font")
        return ImageFont.load_default(size)


def draw(cities):
    total = sum(c.get("listings") or 0 for c in cities.values())
    names = [c["name"] for c in cities.values()]
    providers = sorted({p for c in cities.values() for p in c.get("providers") or []})

    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # Panel with a hairline, echoing the sidebar.
    d.rectangle([40, 40, W - 40, H - 40], fill=PANEL, outline=RULE, width=2)

    icon = Image.open(ROOT / "icon-512.png").convert("RGBA").resize((150, 150), Image.LANCZOS)
    img.paste(icon, (90, 90), icon)

    title = font("archivo.woff2", 92, wght=800, wdth=118)
    figure = font("archivo.woff2", 168, wght=800, wdth=112)
    body = font("archivo.woff2", 38, wght=500, wdth=100)
    mono = font("jetbrains-mono.woff2", 24, wght=500)

    d.text((270, 112), "Nästet", font=title, fill=INK)
    d.text((274, 210), "STUDENT HOUSING ON ONE MAP", font=mono, fill=DIM)

    fig = str(total)
    d.text((90, 290), fig, font=figure, fill=OCHRE)
    fx = 90 + d.textlength(fig, font=figure) + 30
    where = names[0] if len(names) == 1 else f"{', '.join(names[:-1])} & {names[-1]}"
    d.text((fx, 345), "homes available now", font=body, fill=INK)
    d.text((fx, 395), f"in {where}", font=body, fill=DIM)

    d.line([90, 500, W - 90, 500], fill=RULE, width=2)
    d.text((90, 525), "nästet.se", font=mono, fill=OCHRE)
    line = " · ".join(providers)
    d.text((W - 90 - d.textlength(line, font=mono), 525), line, font=mono, fill=DIM)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cities", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cities = json.loads(Path(a.cities).read_text(encoding="utf-8"))["cities"]
    draw(cities).save(a.out, optimize=True)
    print(f"og image: {a.out} ({Path(a.out).stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
