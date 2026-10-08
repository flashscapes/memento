"""Draw Memento's home-screen icon: the wordmark's lowercase m and champagne dot on warm charcoal.

Usage: python3 tools/make_icons.py   (needs Pillow). Writes public/icons/*.png.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "node_modules/@fontsource/manrope/files/manrope-latin-800-normal.woff"
OUT = ROOT / "public/icons"
BG, INK, ACCENT = (23, 22, 20), (244, 239, 230), (200, 172, 120)


def icon(size, pad_scale=1.0):
    s = size * 4  # draw large, then scale down for clean edges
    img = Image.new("RGB", (s, s), BG)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(FONT), int(s * 0.64 * pad_scale))
    l, t, r, b = d.textbbox((0, 0), "m", font=font)
    dot = int(s * 0.055 * pad_scale)
    gap = int(s * 0.03 * pad_scale)
    w = (r - l) + gap + dot
    x = (s - w) / 2 - l
    y = (s - (b - t)) / 2 - t
    d.text((x, y), "m", font=font, fill=INK)
    # the dot sits on the baseline, as in the wordmark
    cx = x + r + gap + dot / 2
    cy = y + b - dot / 2
    d.ellipse((cx - dot / 2, cy - dot / 2, cx + dot / 2, cy + dot / 2), fill=ACCENT)
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
icon(180).save(OUT / "apple-touch-icon.png")
icon(192).save(OUT / "icon-192.png")
icon(512).save(OUT / "icon-512.png")
icon(512, 0.72).save(OUT / "icon-maskable-512.png")  # extra margin so a round mask never clips it
print("icons written")
