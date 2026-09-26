#!/usr/bin/env python3
"""Slide previews and overview sheets (Pillow). Run by tools/deck.mjs; never by the agent.

    python3 tools/previews.py --ir <IR dir>/ir.json --overview-dir DIR [--out-dir <stem>.preview.new
                              --pptx-name <stem>.pptx --pptx-sha256 HEX --profile P]

* previews (only with --out-dir): every slide's @2x render (IR ``referencePng2x``, else ``referencePng``) downscaled
  with LANCZOS to 1920x1080 -> ``slide-NN.png`` when the PNG is <= 2 MiB, else ``slide-NN.jpg`` (JPEG q90); then the
  first 30 (the ones share_file attaches) are fitted into the server's 32 MiB budget: while they exceed it, the
  largest one is re-encoded as JPEG (q90, then 80 … 40) — the server rejects the WHOLE sidecar past that budget;
  then ``.gitignore`` ("*"); then ``manifest.json`` LAST (docs/CONTRACT.md "Preview sidecar"): the server attaches
  these renders to share_file's card only while ``pptxSha256`` equals the bytes it stored;
* overview sheets: 3 columns x <= 4 rows of 640x360 tiles of the 1x renders (``referencePng``) with ASCII labels
  (slide number + file name) -> ``overview-N.png`` in --overview-dir.

Prints one JSON object: {"previews": [{index, file, mediaType, sha256, width, height, bytes, title}],
"overview": [file...], "manifest": path | null}. Exit 0 ok, 1 an input render is missing/unreadable, 2 usage.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import io
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pdeathsig  # noqa: E402  tools/pdeathsig.py

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

FORMAT = "noah-deck-preview"
VERSION = 1
PREVIEW_SIZE = (1920, 1080)
PNG_MAX_BYTES = 2 * 1024 * 1024
JPEG_QUALITY = 90
# What the server accepts (tests/deck-contract.test.ts pins these to the TypeScript constants): it attaches the first
# ATTACHED_MAX renders (MAX_PREVIEW_PAGES, src/server/deckRender.ts) only while they total <= ATTACHED_BUDGET
# (MAX_DECK_PREVIEW_TOTAL_BYTES, src/server/deckPreview.ts) and each is <= IMAGE_MAX_BYTES (MAX_CHAT_IMAGE_BYTES,
# src/server/chatImages.ts) — one violation rejects the whole sidecar. PNG_MAX_BYTES keeps every PNG under the
# per-image cap, and a 1920x1080 JPEG q90 stays far below it (pure noise: ~1.5 MiB), so only the total needs fitting:
# 30 PNGs of up to 2 MiB would be 60 MiB.
ATTACHED_MAX = 30
ATTACHED_BUDGET = 32 * 1024 * 1024
IMAGE_MAX_BYTES = 5 * 1024 * 1024
# The re-encoding steps of the fit; 30 JPEGs of pure noise at q70 are ~27 MiB, so the ladder always ends inside it.
JPEG_LADDER = (90, 80, 70, 60, 50, 40)
TILE = (640, 360)
COLS, ROWS = 3, 4
GUTTER = 8
LABEL_H = 30
TITLE_MAX = 120
KIT = Path(__file__).resolve().parents[1]


def generator() -> str:
    try:
        v = (KIT / "VERSION").read_text(encoding="utf-8").strip()
    except OSError:
        v = "0.0.0"
    return f"noah-pptx-converter/{v}"


def title_of(slide: dict) -> str | None:
    """The slide's title / ctrTitle placeholder text (as the builder names the slide), whitespace collapsed."""
    for e in slide.get("elements") or []:
        if not isinstance(e, dict) or e.get("kind") != "text" or e.get("placeholder") not in ("title", "ctrTitle"):
            continue
        parts = []
        for p in e.get("paragraphs") or []:
            for r in (p.get("runs") if isinstance(p, dict) else None) or []:
                if isinstance(r, dict) and not r.get("break"):
                    parts.append(str(r.get("text") or ""))
                else:
                    parts.append(" ")
            parts.append(" ")
        t = " ".join("".join(parts).split())
        if t:
            return t[:TITLE_MAX]
    return None


def resolve(ir_dir: Path, p) -> Path | None:
    if not p:
        return None
    q = Path(str(p))
    return q if q.is_absolute() else ir_dir / q


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def render_preview(src: Path) -> Image.Image:
    """The render flattened onto white and downscaled (LANCZOS) to the preview size."""
    with Image.open(src) as im:
        im.load()
        if im.mode in ("RGBA", "LA", "P"):
            rgba = im.convert("RGBA")
            bg = Image.new("RGB", rgba.size, (255, 255, 255))
            bg.paste(rgba, mask=rgba.split()[-1])
            rgb = bg
        else:
            rgb = im.convert("RGB")
    return rgb.resize(PREVIEW_SIZE, Image.LANCZOS)


def _encode(rgb: Image.Image, quality: int | None) -> bytes:
    buf = io.BytesIO()
    if quality is None:
        rgb.save(buf, "PNG")
    else:
        rgb.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def encode_preview(src: Path) -> tuple[bytes, int | None]:
    """-> (bytes, quality): PNG (quality None) when it is <= PNG_MAX_BYTES, else JPEG q90."""
    rgb = render_preview(src)
    data = _encode(rgb, None)
    if len(data) <= PNG_MAX_BYTES:
        return data, None
    return _encode(rgb, JPEG_QUALITY), JPEG_QUALITY


def _store(out_dir: Path, e: dict, data: bytes, quality: int | None, width: int) -> None:
    """Write one preview file and (re)fill its entry; a changed extension removes the previous file."""
    ext, media = ("png", "image/png") if quality is None else ("jpg", "image/jpeg")
    name = f"slide-{e['index']:0{width}d}.{ext}"
    old = e.get("file")
    (out_dir / name).write_bytes(data)
    if old and old != name:
        (out_dir / old).unlink(missing_ok=True)
    e.update({"file": name, "mediaType": media, "sha256": sha256(data), "bytes": len(data), "quality": quality})


def fit_attached(entries: list, out_dir: Path, width: int) -> None:
    """Re-encode the largest of the first ATTACHED_MAX previews, one JPEG_LADDER step at a time (always to a smaller
    file), until they total <= ATTACHED_BUDGET — or nothing can shrink any more (then the server falls back to
    LibreOffice previews; not reachable for 1920x1080 renders, see JPEG_LADDER). Deterministic: largest first, ties
    to the earlier slide."""
    head = entries[:ATTACHED_MAX]
    stuck: set[int] = set()
    while sum(e["bytes"] for e in head) > ATTACHED_BUDGET:
        cands = [e for e in head if e["index"] not in stuck and e["quality"] != JPEG_LADDER[-1]]
        if not cands:
            return
        e = max(cands, key=lambda x: (x["bytes"], -x["index"]))
        if e["quality"] is None:                 # the written PNG is lossless: the same pixels, no second resize
            with Image.open(out_dir / e["file"]) as im:
                rgb = im.convert("RGB")
        else:                                    # never re-encode a JPEG from a JPEG
            rgb = render_preview(e["src"])
        steps = JPEG_LADDER if e["quality"] is None else tuple(q for q in JPEG_LADDER if q < e["quality"])
        for q in steps:
            data = _encode(rgb, q)
            if len(data) < e["bytes"]:
                _store(out_dir, e, data, q, width)
                break
        else:
            stuck.add(e["index"])


def write_previews(ir: dict, ir_dir: Path, out_dir: Path, *, pptx_name: str, pptx_sha: str, profile: str) -> tuple[list, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    slides = [s for s in ir.get("slides") or [] if isinstance(s, dict)]
    width = 3 if len(slides) > 99 else 2
    entries = []
    for i, s in enumerate(slides, 1):
        src = resolve(ir_dir, s.get("referencePng2x"))
        if src is None or not src.is_file():
            src = resolve(ir_dir, s.get("referencePng"))
        if src is None or not src.is_file():
            raise FileNotFoundError(f"slide {i}: no render ({s.get('referencePng2x') or s.get('referencePng')})")
        data, quality = encode_preview(src)
        e = {"index": i, "src": src, "width": PREVIEW_SIZE[0], "height": PREVIEW_SIZE[1]}
        _store(out_dir, e, data, quality, width)
        t = title_of(s)
        if t:
            e["title"] = t
        entries.append(e)
    fit_attached(entries, out_dir, width)
    for e in entries:
        del e["src"]
    (out_dir / ".gitignore").write_text("*\n", encoding="utf-8")
    manifest = {
        "format": FORMAT, "version": VERSION, "generator": generator(), "pptx": pptx_name, "pptxSha256": pptx_sha,
        "profile": profile,
        "createdAt": _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "slideCount": len(entries),
        "slides": [{k: e[k] for k in ("index", "file", "mediaType", "sha256", "width", "height", "title") if k in e}
                   for e in entries],
    }
    mp = out_dir / "manifest.json"
    tmp = out_dir / ".manifest.json.tmp"
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    os.replace(tmp, mp)                      # LAST: the sidecar is complete once the manifest exists
    return entries, mp


def _font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:                        # Pillow < 10.1: bitmap default font
        return ImageFont.load_default()


def write_overviews(ir: dict, ir_dir: Path, out_dir: Path) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("overview-*.png"):
        old.unlink()
    slides = [s for s in ir.get("slides") or [] if isinstance(s, dict)]
    per = COLS * ROWS
    font = _font(20)
    files = []
    for sheet in range(0, len(slides), per):
        chunk = slides[sheet:sheet + per]
        rows = (len(chunk) + COLS - 1) // COLS
        W = COLS * TILE[0] + (COLS + 1) * GUTTER
        H = rows * (TILE[1] + LABEL_H) + (rows + 1) * GUTTER
        img = Image.new("RGB", (W, H), (38, 42, 51))
        draw = ImageDraw.Draw(img)
        for k, s in enumerate(chunk):
            r, c = divmod(k, COLS)
            x = GUTTER + c * (TILE[0] + GUTTER)
            y = GUTTER + r * (TILE[1] + LABEL_H + GUTTER)
            src = resolve(ir_dir, s.get("referencePng"))
            if src is None or not src.is_file():
                raise FileNotFoundError(f"slide {s.get('index')}: no 1x render ({s.get('referencePng')})")
            with Image.open(src) as im:
                tile = im.convert("RGB").resize(TILE, Image.LANCZOS)
            img.paste(tile, (x, y + LABEL_H))
            label = f"{s.get('index')}  {s.get('name') or ''}"
            label = label.encode("ascii", "replace").decode("ascii")
            draw.text((x + 2, y + 4), label, fill=(235, 238, 243), font=font)
        name = f"overview-{sheet // per + 1}.png"
        img.save(out_dir / name, "PNG")
        files.append(name)
    return files


def main(argv=None) -> int:
    pdeathsig.arm()
    ap = argparse.ArgumentParser(description="1920x1080 slide previews + overview sheets for a built deck")
    ap.add_argument("--ir", required=True, type=Path)
    ap.add_argument("--overview-dir", required=True, type=Path)
    ap.add_argument("--out-dir", type=Path, help="the new preview sidecar directory (<stem>.preview.new)")
    ap.add_argument("--pptx-name")
    ap.add_argument("--pptx-sha256")
    ap.add_argument("--profile", choices=["embedded", "malgun"])
    a = ap.parse_args(argv)
    if a.out_dir and not (a.pptx_name and a.pptx_sha256 and a.profile):
        ap.error("--out-dir needs --pptx-name, --pptx-sha256 and --profile")
    if a.pptx_sha256 and (len(a.pptx_sha256) != 64 or any(ch not in "0123456789abcdef" for ch in a.pptx_sha256)):
        ap.error("--pptx-sha256 must be 64 lowercase hex digits")
    try:
        ir = json.loads(a.ir.read_text(encoding="utf-8"))
        ir_dir = a.ir.resolve().parent
        entries, mp = ([], None)
        if a.out_dir:
            entries, mp = write_previews(ir, ir_dir, a.out_dir, pptx_name=a.pptx_name, pptx_sha=a.pptx_sha256,
                                         profile=a.profile)
        overview = write_overviews(ir, ir_dir, a.overview_dir)
    except (OSError, ValueError) as exc:
        print(f"previews: error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"previews": entries, "overview": overview, "manifest": str(mp) if mp else None},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
