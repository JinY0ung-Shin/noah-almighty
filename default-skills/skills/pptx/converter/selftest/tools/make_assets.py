#!/usr/bin/env python3
"""Provenance of the features self-test deck's assets (synthetic, deterministic; no third-party imagery).

    python3 selftest/tools/make_assets.py [--out selftest/features/assets]

* ``photo.jpg`` — 3000x2000 synthetic "landscape" (sky gradient, sun, three hill bands), baseline JPEG q84, 4:2:0.
  3000 px wide on purpose: the extractor's raster cap (2560 px) and its JPEG path (an opaque JPEG <img> with
  object-fit: cover) must both engage. Kept <= 300 KB.
* ``rounded.png`` — 720x480 RGBA illustration (diagonal gradient + circles); shown with border-radius, so the
  extractor bakes the rounded clip into a transparent PNG.

The committed files are the output of this script (Pillow 12.3.0); rerunning it is only needed to change them.
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw


def lerp(a, b, t):
    return tuple(int(round(x + (y - x) * t)) for x, y in zip(a, b))


def photo(w=3000, h=2000) -> Image.Image:
    img = Image.new("RGB", (w, h))
    top, bottom = (42, 82, 160), (250, 196, 150)
    px = img.load()
    for y in range(h):
        c = lerp(top, bottom, (y / (h - 1)) ** 1.3)
        for x in range(w):
            px[x, y] = c
    d = ImageDraw.Draw(img)
    d.ellipse((2050, 420, 2450, 820), fill=(255, 236, 196))
    bands = [((64, 96, 140), 1180, 150, 0.0015), ((46, 74, 112), 1420, 120, 0.0023), ((28, 48, 76), 1660, 90, 0.0031)]
    for color, base, amp, freq in bands:
        pts = [(x, base - amp * math.sin(x * freq) - 0.4 * amp * math.sin(x * freq * 2.7 + 1.3)) for x in range(0, w + 1, 20)]
        d.polygon(pts + [(w, h), (0, h)], fill=color)
    return img


def rounded(w=720, h=480) -> Image.Image:
    img = Image.new("RGBA", (w, h))
    a, b = (14, 124, 102), (74, 110, 242)
    px = img.load()
    for y in range(h):
        for x in range(w):
            c = lerp(a, b, (x / (w - 1) + y / (h - 1)) / 2)
            px[x, y] = c + (255,)
    d = ImageDraw.Draw(img)
    d.ellipse((460, 60, 680, 280), fill=(255, 255, 255, 70))
    d.ellipse((80, 250, 300, 470), fill=(255, 178, 125, 200))
    d.rectangle((300, 180, 420, 300), fill=(255, 255, 255, 150))
    return img


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "features" / "assets")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    photo().save(a.out / "photo.jpg", "JPEG", quality=84, subsampling=2, optimize=True)
    rounded().save(a.out / "rounded.png", "PNG", optimize=True)
    for n in ("photo.jpg", "rounded.png"):
        print(n, (a.out / n).stat().st_size, "bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
