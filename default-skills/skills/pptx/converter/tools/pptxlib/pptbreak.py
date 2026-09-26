"""Model of PowerPoint's greedy line breaking, for the builder's wrap-width check.

Ported from scratch/text-mapping/pptbreak.py (validated 7/7 on real PowerPoint breaks, docs/research/
text-mapping.md §5/§6) and generalised to a per-character advance list, so mixed runs (weights, sizes,
letter-spacing) are modelled character by character.

Width model: every nominal glyph advance snapped to 1/8 pt (office2pdf #661) — no kerning (runs carry kern="0",
Chromium uses font-kerning: none); the trailing spaces of a line do not count. Break opportunities: after a space,
between two Hangul syllables (PowerPoint's default eaLnBrk=1 breaks Hangul mid-word, observed in its own export),
before a terminal mark that follows a Hangul syllable, after a hyphen between letters, before Hangul after a
closing quote/paren. Latin words never break (latinLnBrk=0).
"""
from __future__ import annotations

import bisect
import re
from functools import lru_cache
from itertools import accumulate

HANGUL = re.compile(r"[가-힣]")
TERMINAL = set("?!.,:)”…？！。、．，：）")


def snap_pt(a: float) -> float:
    """PowerPoint's advance grid: 1/8 pt."""
    return round(a * 8) / 8


def ppt_advances(nominal_pt: list[float]) -> list[float]:
    return [snap_pt(a) for a in nominal_pt]


def break_opportunities(text: str) -> list[int]:
    """Indices i where a line may end before text[i] (break between i-1 and i)."""
    ops = []
    for i in range(1, len(text)):
        a, b = text[i - 1], text[i]
        if a == " " and b != " ":
            ops.append(i)
        elif HANGUL.match(a) and HANGUL.match(b):
            ops.append(i)
        elif HANGUL.match(a) and b in TERMINAL:
            ops.append(i)
        elif a == "-" and i >= 2 and text[i - 2].isalpha() and b.isalpha():
            ops.append(i)
        elif HANGUL.match(b) and a not in " \"'(“‘[" and not HANGUL.match(a) and not a.isdigit() \
                and not a.isalpha():
            ops.append(i)                       # e.g. after a closing quote/paren before Hangul
    return ops


class _Widths:
    def __init__(self, text: str, adv: list[float]):
        if len(adv) != len(text):
            raise ValueError("one advance per character required")
        self.text = text
        self.pre = [0.0] + list(accumulate(adv))

    def stripped_end(self, s: int, e: int) -> int:
        while e > s and self.text[e - 1] == " ":
            e -= 1
        return e

    def width(self, s: int, e: int) -> float:
        """Width of text[s:e] without its trailing spaces (they hang)."""
        e = self.stripped_end(s, e)
        return self.pre[e] - self.pre[s]


def simulate_adv(text: str, adv: list[float], avail_pt: float, ops: list[int] | None = None) -> list[str]:
    """PowerPoint's greedy breaking of `text` with per-character advances `adv` (pt) at width `avail_pt`."""
    if not text:
        return [""]
    W = _Widths(text, adv)
    ops = sorted(set((break_opportunities(text) if ops is None else ops)) | {len(text)})
    lines, start = [], 0
    while start < len(text):
        best = None
        k = bisect.bisect_right(ops, start)
        for e in ops[k:]:
            if W.width(start, e) <= avail_pt + 1e-6:
                best = e
            else:
                break
        if best is None:                         # nothing fits: take the first opportunity (overflow)
            best = ops[k] if k < len(ops) else len(text)
        lines.append(text[start:best])
        start = best
    return lines


def window_for_breaks(text: str, adv: list[float], breaks: list[int], ops: list[int] | None = None,
                      first_offset: float = 0.0):
    """[lo, hi) of available widths (pt) for which PowerPoint's greedy breaker ends lines exactly at `breaks`
    (indices where Chromium started a new line inside this hard-break segment). None when no width can.
    `first_offset` (pt): extra space the first line uses (a first-line text indent)."""
    W = _Widths(text, adv)
    opl = break_opportunities(text) if ops is None else list(ops)
    opset = set(opl)
    op_sorted = sorted(opset | {len(text)})
    starts = [0] + list(breaks)
    ends = list(breaks) + [len(text)]
    lo, hi = 0.0, float("inf")
    for i, (s, e) in enumerate(zip(starts, ends)):
        if e <= s:
            return None
        off = first_offset if i == 0 else 0.0
        lo = max(lo, W.width(s, e) + off)                     # the line must fit
        if i < len(starts) - 1:
            if e not in opset:
                return None                                   # Chromium broke where PowerPoint cannot
            k = bisect.bisect_right(op_sorted, e)
            nxt = op_sorted[k] if k < len(op_sorted) else len(text)
            hi = min(hi, W.width(s, nxt) + off)               # ... and the next unit must not fit
    return (lo, hi) if lo < hi else None


# ---------------------------------------------------------------------------------------------- reference API
@lru_cache(maxsize=None)
def _font(path):
    from fontTools.ttLib import TTFont
    tt = TTFont(path, lazy=True)
    return tt["head"].unitsPerEm, tt.getBestCmap(), tt["hmtx"]


def glyph_advances_pt(text: str, font_file: str, size_pt: float, kern: bool = False) -> list[float]:
    """Per-character PowerPoint advances (pt) from one font file: snapped nominal advance (+ optional kerning,
    as in the reference; the builder never kerns)."""
    upm, cmap, hm = _font(font_file)
    nominal = []
    for ch in text:
        g = cmap.get(ord(ch))
        a = hm[g][0] / upm * size_pt if g is not None else 0.5 * size_pt
        nominal.append(snap_pt(a))
    if kern:
        import uharfbuzz as hb
        face = hb.Face(hb.Blob.from_file_path(font_file))
        f = hb.Font(face)
        f.scale = (face.upem, face.upem)
        bufs = []
        for k in (True, False):
            b = hb.Buffer(); b.add_str(text); b.guess_segment_properties()
            hb.shape(f, b, {"kern": k, "liga": False, "clig": False, "calt": False})
            bufs.append(b)
        if len(bufs[0].glyph_positions) == len(text):
            for i, (pk, pn) in enumerate(zip(bufs[0].glyph_positions, bufs[1].glyph_positions)):
                nominal[i] += (pk.x_advance - pn.x_advance) / upm * size_pt
    return nominal


def simulate(text: str, font_file: str, size_pt: float, avail_pt: float, kern: bool = False) -> list[str]:
    return simulate_adv(text, glyph_advances_pt(text, font_file, size_pt, kern), avail_pt)


def line_width_pt(text: str, font_file: str, size_pt: float, kern: bool = False) -> float:
    t = text.rstrip(" ")
    return sum(glyph_advances_pt(t, font_file, size_pt, kern))


def width_window(chromium_lines: list[str], font_file: str, size_pt: float, kern: bool = False):
    """Reference signature: interval [lo, hi) of widths (pt) reproducing `chromium_lines` (trailing spaces
    included) with one font file and size. None when no width can reproduce them."""
    text = "".join(chromium_lines)
    adv = glyph_advances_pt(text, font_file, size_pt, kern)
    breaks, pos = [], 0
    for line in chromium_lines[:-1]:
        pos += len(line)
        breaks.append(pos)
    return window_for_breaks(text, adv, breaks)
