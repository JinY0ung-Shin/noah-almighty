#!/usr/bin/env python3
"""Fidelity gates (judge J1-19, J2-08…J2-10): does the written PPTX draw every IR element where the HTML has it, in
its colours, with the properties PowerPoint renders?

    python3 tools/check_fidelity.py structure DECK.pptx --ir <IR dir>/ir.json --profile P [--map M]
                                            [--json fidelity.json] [--tol 0.02]

(The Noah port keeps the `structure` gate only; the PoC's LibreOffice `pixels` gate is a PoC-only QA tool. IR paths
resolve against the directory of --ir.)

``structure`` reads the WRITTEN XML (slide parts, the slides' layouts, the master, chart parts, media parts) and
compares it, object by object, with the IR — the link is the builder's ``<deck stem>.map.json`` (p:cNvPr id -> IR
id), since objects carry human names. Every IR element must have its object(s); every object of a slide / custom
layout must be in the map. Per kind (geometry tolerance ``--tol`` px, default 0.02 = 190 EMU; the builder rounds to
1 EMU):

* every object: not hidden (``cNvPr@hidden``), not flipped (``xfrm@flipH/flipV``);
* shape: preset (rect / roundRect + adj / ellipse), box (inset by half the border, as DrawingML centres lines on the
  path), fill colour + alpha x opacity (gradients: stop colours at 0 and 1, angle), line width/colour/alpha, outer
  shadow (blurRad, dist, dir, colour, alpha), rotation, the decorative flag (or alt text); a split shape: fill box + border box; a table background
  absorbed into its table: the table's ``tblPr`` shadow and every cell without an own fill = the background colour;
* text box: the text area (xfrm minus lIns/rIns) at the anchored edge (left for l/just, right for r, centre for
  ctr); insets 0 (a rotated box: >= 0, symmetric about the CSS centre), ``anchor="t"``, ``noAutofit`` (no
  normAutofit/spAutoFit), horizontal (``vert``), one column, no body rotation, a frame without fill/line/effects;
  ``wrap`` (J2-01, CONTRACT v2 (f)): a block with only hard breaks — one line included — is ``square`` at its HTML
  width exactly when the HTML would wrap a longer line inside that box (IR ``nowrap``/``shrinkWrap`` false, no text
  field, single lines not rotated) AND PowerPoint's width of every written line (1/8-pt advances + spc, from marL /
  indent) stays >= 2 % inside the box, else ``none``; every ``square`` box is re-broken with PowerPoint's greedy
  breaker from the written runs/marL/width and must give Chromium's lines; per paragraph: alignment, lnSpc, marL /
  indent (IR marginLeftPx / indentPx, hanging bullets included), bullet (buNone / buChar char + buClr + buFont +
  buSzPct / buAutoNum scheme + startAt); per visible character: text, size, colour, alpha, bold flag, typeface
  (latin = ea = cs = the fonts.json face), italic, underline, strike, baseline shift (super/sub), letter spacing
  (``spc`` absent when the IR has none), caps / highlight / text effects / outline absent, ``kern="0"``, text
  fields (``a:fld`` for IR ``field`` runs; a slide-number field shows that slide's number); PowerPoint's predicted
  baseline of EVERY line (text-mapping.md §2: box top + tIns + seat, 1.2 x pct x size per line, spcBef) vs
  Chromium's (tolerance 0.25 px); placeholders (``p:ph`` type = IR ``placeholder``);
* image: box, rotation, the picture's PNG and native SVG parts byte-identical to the IR assets (sha-256), no blip
  effect except the IR opacity's ``alphaModFix``, no cropping (``srcRect``) or tiling, a plain frame, alt text or
  the decorative flag;
* table: frame position (half the outer borders), grid lines (cumulative), rows never shorter than Chromium's, cell
  fills, collapsed border widths/colours per grid edge, the header-row flag (``firstRow`` iff the first row is header
  cells, no banding flags); per cell: ``anchor`` = IR vAlign, paragraph alignment and
  marL/indent/bullets, the anchored-edge margin (text starts / ends where Chromium's lines do), PowerPoint's lines at
  the cell's text width = Chromium's, the predicted baseline of every line (anchor t / ctr / b inside the row
  heights minus marT/marB) vs Chromium's; every character with its style (as for text boxes);
* chart: frame box and the chart part against the IR spec + ``resolved``: chart type / direction / grouping,
  series names, categories and cached values, series / data-point colours (bar/pie fill, line colour + width),
  gapWidth / overlap / holeSize, data labels (shown or not, position, number format, size, colour, bold, typeface),
  value axis min / max / majorUnit / gridlines / label visibility, category axis line and label size / colour /
  typeface, plot area ``manualLayout`` (inner, edge) = resolved.plotPx (1e-4), legend presence / position, no title,
  alt text (``descr``) present;
* paint order (J2-10): the slide's objects, groups descended, in IR paint order (a split shape or a table with its
  absorbed background counts once); layout chrome (painted before every slide object) only where no lower-indexed
  slide object overlaps it;
* groups: identity child transform (chOff = off, chExt = ext) and a box holding every child;
* slide background: the effective fill (slide -> layout -> master) = the IR background (over white; a gradient stop by
  stop and by angle).

Fixer round 3 (review findings VO-01, VR-02…VR-08, EDIT-01/-04/-05/-08/-12) adds: autofit (``normAutofit`` without a
stored shrink on every ``wrap="square"`` box, text area >= 1.05 x PowerPoint's text height; ``noAutofit`` otherwise);
placeholder ``idx`` (unique per part, PowerPoint's values) and the slide -> layout placeholder link; every layout prompt =
the slide placeholder it came from; theme colours = IR ``theme.colors``, theme fonts = the profile's regular face; the
template residue (no master date/footer/slide-number placeholders, Korean prompts proofed ko-KR, 16:9 view guides);
chart axis orientation, series order / idx, ``showDLblsOverMax``; table merges vs the IR spans, ``rtl``, cell ``vert``,
the dash of every line / border; paragraph ``rtl`` / ``fontAlgn`` / line-breaking flags, paragraph marks no taller than
their runs; hidden slides (``show``, app.xml); a dark background pinned on its slide; decorative groups; light default
text in dark fills; no overlay picture in the deck; an object without ``a:xfrm`` is reported, not a crash.

Exit status: 0 PASS, 1 FAIL, 2 usage / missing input.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import zipfile
from pathlib import Path

from lxml import etree

KIT = Path(__file__).resolve().parent.parent   # the converter toolkit
POC = KIT                                      # PoC name, kept as an alias
sys.path.insert(0, str(KIT / "tools"))
IR_DIR = Path(".")                             # set by structure(): IR paths are relative to the IR directory
from pptxlib import fonts as F  # noqa: E402  fonts.json semantics + the advance model (the HTML's own fonts)
from pptxlib import pptbreak  # noqa: E402    PowerPoint's greedy breaker (text-mapping.md §5)
import pdeathsig  # noqa: E402                tools/pdeathsig.py


def ir_file(p) -> Path:
    """An IR path (image src/svg) -> the file, relative to the IR directory (CONTRACT "IR path convention")."""
    q = Path(str(p))
    return q if q.is_absolute() else IR_DIR / q

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
      "asvg": "http://schemas.microsoft.com/office/drawing/2016/SVG/main",
      "adec": "http://schemas.microsoft.com/office/drawing/2017/decorative",
      "pr": "http://schemas.openxmlformats.org/package/2006/relationships"}
A, P, C, R = (f"{{{NS[k]}}}" for k in ("a", "p", "c", "r"))
EMU = 9525.0
SHAPES = {P + "sp", P + "pic", P + "graphicFrame", P + "grpSp", P + "cxnSp"}
URI_TABLE = "http://schemas.openxmlformats.org/drawingml/2006/table"
URI_CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart"
BASELINE_TOL = 0.25
FIT_MARGIN_REL = 0.02       # CONTRACT v2 (f): "fit" = every line >= 2 % inside the box
FIT_BAND_PT = 0.05          # a line this close to the fit limit may go either way (rounding of sz/spc)
EDGE_TOL = 0.05             # px: a cell's anchored text edge vs Chromium's line (margins are whole EMU)
AUTOFIT = ("noAutofit", "normAutofit", "spAutoFit")
AUTOFIT_SLACK_REL = 0.05    # normAutofit boxes: text area >= 1.05 x PowerPoint's text height (CONTRACT v2, round 3)
PLACEHOLDER_IDX = {"title": None, "ctrTitle": None, "subTitle": "1"}   # what PowerPoint's own layouts write


# ============================================================================================== helpers
def px(v) -> float:
    return float(v) / EMU


def emu(v) -> int:
    return int(round(float(v) * EMU))


def ln(el) -> str:
    return etree.QName(el).localname if isinstance(el.tag, str) else ""


def num(v, d=0.0) -> float:
    try:
        f = float(v)
        return f if math.isfinite(f) else d
    except (TypeError, ValueError):
        return d


def truthy(v) -> bool:
    return v in ("1", "true")


class Problems:
    def __init__(self):
        self.items: list[dict] = []
        self.checked = 0

    # every call site passes `where` = (slide number, part name) first: add(*where, ir_id, check, message)
    def add(self, slide, part, ir, check, msg):
        self.items.append({"slide": slide, "part": part, "ir": ir, "check": check, "message": msg})

    def expect(self, cond, slide, part, ir, check, msg):
        self.checked += 1
        if not cond:
            self.add(slide, part, ir, check, msg)
        return cond


def xfrm_of(node):
    if node.tag == P + "graphicFrame":
        return node.find(P + "xfrm")
    if node.tag == P + "grpSp":
        return node.find(f"{P}grpSpPr/{A}xfrm")
    return node.find(f"{P}spPr/{A}xfrm")


class NoGeometry(Exception):
    """An object without its own a:xfrm off/ext (valid OOXML: a placeholder then inherits its layout's position). The
    builder always writes explicit geometry, so the gate reports it as a problem instead of crashing (VR-08)."""


def box_of(node) -> tuple[float, float, float, float, float]:
    x = xfrm_of(node)
    off, ext = (x.find(A + "off"), x.find(A + "ext")) if x is not None else (None, None)
    if off is None or ext is None:
        c = cnv_of(node)
        raise NoGeometry(f"{ln(node)} {c.get('name') if c is not None else '?'!r} has no a:xfrm off/ext (position "
                         "inherited from its layout — the builder writes every position explicitly)")
    return (px(off.get("x")), px(off.get("y")), px(ext.get("cx")), px(ext.get("cy")), num(x.get("rot")) / 60000.0)


def color_alpha(el):
    """(RRGGBB, alpha) of the first srgbClr under a fill element, or None."""
    if el is None:
        return None
    c = el.find(A + "srgbClr")
    if c is None:
        return None
    a = c.find(A + "alpha")
    return c.get("val"), (int(a.get("val")) / 100000.0 if a is not None else 1.0)


def fill_of(parent):
    for c in parent:
        if ln(c) in ("noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"):
            return c
    return None


def over_white(color: str, alpha: float) -> str:
    c = [int(color[k:k + 2], 16) for k in (0, 2, 4)]
    return "".join(f"{round(v * alpha + 255 * (1 - alpha)):02X}" for v in c)


def luminance(color: str, alpha: float = 1.0) -> float:
    """WCAG relative luminance of a colour composited over white."""
    def ch(v):
        c = (v * alpha + 255 * (1 - alpha)) / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(color[k:k + 2], 16) for k in (0, 2, 4))
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


DARK_LUMINANCE = 0.2          # every stop darker: a surface that carries light text (builder: layouts / shapes)


def fill_is_dark(fill, opacity: float = 1.0, need_opaque: bool = True) -> bool:
    if not isinstance(fill, dict):
        return False
    stops = [(fill.get("color"), num(fill.get("alpha"), 1.0))] if fill.get("type") == "solid" else \
        [(q.get("color"), num(q.get("alpha"), 1.0)) for q in fill.get("stops") or [] if isinstance(q, dict)] \
        if fill.get("type") == "linear" else []
    stops = [(str(c or "").lstrip("#").upper(), a) for c, a in stops]
    if not stops or any(len(c) != 6 for c, _ in stops) or (need_opaque and any(a * opacity < 0.99 for _, a in stops)):
        return False
    return max(luminance(c, 1.0 if need_opaque else a) for c, a in stops) < DARK_LUMINANCE


def rot_equal(a, b) -> bool:
    return abs(((a - b) + 180) % 360 - 180) < 0.01


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ============================================================================================== package
class Deck:
    def __init__(self, path: Path):
        self.z = zipfile.ZipFile(path)
        self.names = set(self.z.namelist())
        self._x = {}

    def xml(self, part):
        if part not in self._x:
            self._x[part] = etree.fromstring(self.z.read(part))
        return self._x[part]

    def rels(self, part):
        d, f = part.rsplit("/", 1)
        rp = f"{d}/_rels/{f}.rels"
        if rp not in self.names:
            return {}
        out = {}
        for r in self.xml(rp).iter(f"{{{NS['pr']}}}Relationship"):
            t = r.get("Target")
            if r.get("TargetMode") != "External":
                parts = (d + "/" + t).split("/")
                stack = []
                for s in parts:
                    if s == "..":
                        stack.pop()
                    elif s and s != ".":
                        stack.append(s)
                t = "/".join(stack)
            out[r.get("Id")] = (r.get("Type"), t)
        return out

    def related(self, part, suffix):
        return next((t for (typ, t) in self.rels(part).values() if typ.endswith(suffix)), None)

    def target(self, part, rid):
        t = self.rels(part).get(rid)
        return t[1] if t else None


def walk(container, out=None):
    out = [] if out is None else out
    for c in container:
        if isinstance(c.tag, str) and c.tag in SHAPES:
            out.append(c)
            if c.tag == P + "grpSp":
                walk(c, out)
    return out


def cnv_of(node):
    nv = next((c for c in node if ln(c).startswith("nv")), None)
    return nv.find(P + "cNvPr") if nv is not None else None


# ============================================================================================== text model
class TextModel:
    """PowerPoint's line model (text-mapping.md §2) + the profile's faces (fonts.json)."""

    def __init__(self, profile: str):
        self.prof = F.load_profile(profile)
        self.model = self.prof.advance_model
        self.inv = {(f.typeface, f.bold): f.css_weight for f in self.prof.faces}
        self.share_of = {(f.typeface, f.bold): (f.win_ascent / (f.win_ascent + f.win_descent),
                                                f.win_descent / (f.win_ascent + f.win_descent))
                         for f in self.prof.faces}

    def face(self, weight):
        return self.prof.resolve(weight)

    def seat_pt(self, size_pt, pct, faces) -> float:
        us = [self.share_of.get(fc, (0.8, 0.2)) for fc in faces] or [(0.8, 0.2)]
        a, d = max(u[0] for u in us), max(u[1] for u in us)
        share = 1.2 * a / (a + d)
        return 0.9 * pct * size_pt if pct > 1 else (1.2 * pct - 1.2 + share) * size_pt

    def adv_pt(self, ch, rpr) -> float:
        """PowerPoint advance (1/8-pt snapped nominal advance + spc) of one character of a written run."""
        size_pt = int(rpr.get("sz")) / 100.0 * (0.58 if int(rpr.get("baseline", 0) or 0) else 1.0)
        lat = rpr.find(A + "latin")
        w = self.inv.get((lat.get("typeface") if lat is not None else None, truthy(rpr.get("b"))), 400)
        return pptbreak.snap_pt(self.model.em(ch, w) * size_pt) + int(rpr.get("spc", 0)) / 100.0


def xml_runs(ap):
    """[(kind 'r'|'fld'|'br', rPr, text, fld type)] of an a:p."""
    out = []
    for c in ap:
        t = ln(c)
        if t in ("r", "fld"):
            te = c.find(A + "t")
            out.append((t, c.find(A + "rPr"), te.text or "" if te is not None else "", c.get("type")))
        elif t == "br":
            out.append(("br", c.find(A + "rPr"), "\n", None))
    return out


def ir_chars(para, slide_no=None):
    """Visible characters of an IR paragraph with their run (spaces and breaks dropped)."""
    out = []
    for r in para.get("runs") or []:
        if not isinstance(r, dict) or r.get("break"):
            continue
        txt = str(r.get("text") or "")
        for ch in txt:
            if not ch.isspace():
                out.append((ch, r))
    return out


def check_runs(prob, tm: TextModel, where, ir_id, ir_paras, xml_paras, opacity, slide_no, in_layout):
    """Every visible character: same text, run size/colour/alpha/bold/typeface/italic/underline/strike/baseline
    shift/spacing/field, no caps/highlight/effects/outline, kerning off."""
    ic = [c for p in ir_paras for c in ir_chars(p)]
    xc = []
    for ap in xml_paras:
        for kind, rpr, t, ftype in xml_runs(ap):
            if kind == "br":
                continue
            if kind == "fld" and ftype == "slidenum":
                t = str(slide_no)
            for ch in t:
                if not ch.isspace():
                    xc.append((ch, rpr, kind, ftype))
    txt_i = "".join(c for c, _ in ic)
    txt_x = "".join(c for c, *_ in xc)
    if not prob.expect(txt_i == txt_x, *where, ir_id, "text", f"text {txt_x!r} != IR {txt_i!r}"):
        return
    bad = {}
    for (ch, r), (_, rpr, kind, ftype) in zip(ic, xc):
        face = tm.face(r.get("fontWeight", 400))
        base = r.get("baseline", "normal") or "normal"
        want_sz = int(round(num(r.get("sizePx")) * 75))
        if base == "normal" and int(rpr.get("sz", -1)) != want_sz:
            bad.setdefault("size", f"sz {rpr.get('sz')} != {want_sz} at {ch!r}")
        ca = color_alpha(rpr.find(A + "solidFill"))
        want_a = num(r.get("alpha"), 1.0) * opacity
        if ca is None or ca[0] != str(r.get("color")).upper() or abs(ca[1] - want_a) > 0.006:
            bad.setdefault("colour", f"{ca} != {r.get('color')}@{want_a:.3f} at {ch!r}")
        if truthy(rpr.get("b")) != bool(face.bold):
            bad.setdefault("bold", f"b={rpr.get('b')} but weight {r.get('fontWeight')} -> {face.typeface}/{face.bold}")
        tfs = {rpr.find(A + s).get("typeface") if rpr.find(A + s) is not None else None for s in ("latin", "ea", "cs")}
        if tfs != {face.typeface}:
            bad.setdefault("typeface", f"{sorted(map(str, tfs))} != {face.typeface!r}")
        if truthy(rpr.get("i")) != bool(r.get("italic")):
            bad.setdefault("italic", f"i={rpr.get('i')} but IR italic={r.get('italic')} at {ch!r}")
        u = rpr.get("u")
        if (u not in (None, "none")) != bool(r.get("underline")) or (r.get("underline") and u != "sng"):
            bad.setdefault("underline", f"u={u} but IR underline={r.get('underline')} at {ch!r}")
        st = rpr.get("strike")
        if (st not in (None, "noStrike")) != bool(r.get("strike")) or (r.get("strike") and st != "sngStrike"):
            bad.setdefault("strike", f"strike={st} but IR strike={r.get('strike')} at {ch!r}")
        bl = int(num(rpr.get("baseline"), 0))
        if not ((base == "super" and bl > 0) or (base == "sub" and bl < 0) or (base == "normal" and bl == 0)):
            bad.setdefault("baseline", f"baseline={rpr.get('baseline')} but IR {base} at {ch!r}")
        want_spc = int(round(num(r.get("letterSpacingPx")) * 75))
        if int(num(rpr.get("spc"), 0)) != want_spc:
            bad.setdefault("spacing", f"spc {rpr.get('spc')} != {want_spc} at {ch!r}")
        if rpr.get("cap") not in (None, "none"):
            bad.setdefault("caps", f"cap={rpr.get('cap')} (the IR text is already transformed)")
        eff = rpr.find(A + "effectLst")
        outline = rpr.find(A + "ln")
        if rpr.find(A + "highlight") is not None or (eff is not None and len(eff)) or rpr.find(A + "effectDag") \
                is not None or (outline is not None and outline.find(A + "noFill") is None):
            bad.setdefault("effect", f"highlight/effect/outline on the run at {ch!r}")
        if rpr.get("kern") != "0":
            bad.setdefault("kern", "kern != 0")
        want_f = r.get("field")
        if (want_f or None) != (ftype if kind == "fld" else None):
            bad.setdefault("field", f"IR field {want_f!r} vs {'a:fld ' + str(ftype) if kind == 'fld' else 'a:r'}")
    for k, m in bad.items():
        prob.add(*where, ir_id, f"run-{k}", m)
    prob.checked += len(ic)


def check_para_marks(prob, where, eid, xml_paras, label) -> None:
    """A paragraph mark (a:endParaRPr) never taller than the paragraph's runs: PowerPoint sizes the paragraph's last line
    by the mark too, so a 40 pt mark after 14 pt text would push the line down (the builder copies the last run's size;
    fixer round 3, VR-05)."""
    for k, ap in enumerate(xml_paras):
        end = ap.find(A + "endParaRPr")
        sizes = [int(num(c.find(A + "rPr").get("sz"), 0)) for c in ap if ln(c) in ("r", "fld")
                 and c.find(A + "rPr") is not None and c.find(A + "rPr").get("sz")]
        if end is None or end.get("sz") is None or not sizes:
            continue
        prob.expect(int(num(end.get("sz"), 0)) <= max(sizes), *where, eid, "para-mark",
                    f"{label} paragraph {k}: endParaRPr sz {end.get('sz')} > the paragraph's largest run {max(sizes)}")


def _is_bullet(ppr) -> bool:
    return ppr is not None and (ppr.find(A + "buChar") is not None or ppr.find(A + "buAutoNum") is not None)


def simulate_paras(tm: TextModel, xml_paras, body_w_pt):
    """PowerPoint's lines of wrap=square text at body width `body_w_pt` from the written XML: [(paragraph, text)]."""
    out = []
    for pi, ap in enumerate(xml_paras):
        ppr = ap.find(A + "pPr")
        marl = int(ppr.get("marL", 0)) / 12700.0 if ppr is not None else 0.0
        indent = int(ppr.get("indent", 0)) / 12700.0 if ppr is not None else 0.0
        segs = [[]]
        for kind, rpr, t, _ in xml_runs(ap):
            if kind == "br":
                segs.append([])
                continue
            segs[-1].extend((c, tm.adv_pt(c, rpr)) for c in t)
        for si_, seg in enumerate(segs):
            text = "".join(c for c, _ in seg)
            adv = [a for _, a in seg]
            first_off = indent if (si_ == 0 and not _is_bullet(ppr)) else 0.0
            if first_off and adv:               # a first-line indent: the first line starts that much further in
                adv = [adv[0] + first_off] + adv[1:]
            lines = pptbreak.simulate_adv(text, adv, body_w_pt - marl) if text else [""]
            out.extend((pi, L) for L in lines)
    return out


def xml_hard_line_widths(tm: TextModel, xml_paras) -> list[tuple[float, int]]:
    """(width pt, characters) of every hard line (paragraph / a:br segment) of written text in PowerPoint's
    advances, measured from the line's start: marL, + indent on a paragraph's first line without a bullet (CONTRACT
    v2 (f) "fit")."""
    out = []
    for ap in xml_paras:
        ppr = ap.find(A + "pPr")
        marl = int(ppr.get("marL", 0)) / 12700.0 if ppr is not None else 0.0
        indent = int(ppr.get("indent", 0)) / 12700.0 if ppr is not None else 0.0
        segs = [[]]
        for kind, rpr, t, _ in xml_runs(ap):
            if kind == "br":
                segs.append([])
            else:
                segs[-1].extend((c, rpr) for c in t)
        for si_, seg in enumerate(segs):
            text = "".join(c for c, _ in seg)
            core = text.strip(" \t")
            if not core:
                continue
            lo = len(text) - len(text.lstrip(" \t"))
            w = sum(tm.adv_pt(c, rpr) for c, rpr in seg[lo:lo + len(core)])
            out.append((marl + (indent if si_ == 0 and not _is_bullet(ppr) else 0.0) + w, len(core)))
    return out


def lines_align(xml_paras, ir_lines) -> bool:
    """Do the IR line texts reproduce the written paragraphs' text (whitespace ignored)? Only then does the builder
    know where each Chromium line starts, i.e. can it measure the lines for "fit"."""
    by_p = {}
    for L in ir_lines:
        by_p.setdefault(L.get("paragraph"), []).append(str(L.get("text") or ""))
    for pi, ap in enumerate(xml_paras):
        xml_t = "".join(t for kind, _, t, _ in xml_runs(ap) if kind != "br")
        if "".join(xml_t.split()) != "".join("".join(by_p.get(pi, [])).split()):
            return False
    return True


def line_stack(tm: TextModel, xml_paras, ir_lines):
    """PowerPoint's vertical model (text-mapping.md §2.1) of written text: [(IR line, baseline offset from the text
    block's top)] and the block's height, px (1.2 x pct x S per line, S = the line's largest normal run, the baseline
    at the seat of the line's faces; spcBef between paragraphs)."""
    cur = 0.0
    out = []
    for pi, ap in enumerate(xml_paras):
        ppr = ap.find(A + "pPr")
        pct_el = ppr.find(f"{A}lnSpc/{A}spcPct") if ppr is not None else None
        pct = round(int(pct_el.get("val")) / 1000) / 100 if pct_el is not None else 1.0
        bef = ppr.find(f"{A}spcBef/{A}spcPts") if ppr is not None else None
        if pi and bef is not None:
            cur += int(bef.get("val")) / 100 * 4 / 3
        chars = []
        for kind, rpr, t, _ in xml_runs(ap):
            if kind == "br":
                chars.append(("\n", None, None))
                continue
            lat = rpr.find(A + "latin")
            face = (lat.get("typeface") if lat is not None else None, truthy(rpr.get("b")))
            size = None if int(num(rpr.get("baseline"), 0)) else int(rpr.get("sz")) / 100
            chars.extend((c, size, face) for c in t)
        end = ap.find(A + "endParaRPr")
        mark_face = None
        if end is not None and end.find(A + "latin") is not None:
            mark_face = (end.find(A + "latin").get("typeface"), truthy(end.get("b")))
        text = "".join(c for c, _, _ in chars)
        lines = [L for L in ir_lines if L.get("paragraph") == pi]
        starts, pos = [], 0
        for L in lines:
            core = str(L.get("text") or "").strip()
            i = text.find(core, pos) if core else pos
            starts.append(max(i, pos))
            pos = max(i, pos) + len(core)
        for k, L in enumerate(lines):
            lo, hi = starts[k], (starts[k + 1] if k + 1 < len(lines) else len(text))
            seg = [(sz, fc) for c, sz, fc in chars[lo:hi] if c != "\n"]
            sizes = [sz for sz, _ in seg if sz]
            S = max(sizes) if sizes else (int(end.get("sz")) / 100 if end is not None and end.get("sz") else 12.0)
            faces = {fc for _, fc in seg if fc} | ({mark_face} if k == len(lines) - 1 and mark_face else set())
            out.append((L, tm.seat_pt(S, pct, faces) * 4 / 3 + cur))
            cur += 1.2 * pct * S * 4 / 3
    return out, cur


def ir_has_soft_wrap(ir_lines) -> bool:
    """A line that ends inside its paragraph without a hard break = Chromium soft-wrapped there."""
    by_p = {}
    for L in ir_lines:
        by_p.setdefault(L.get("paragraph"), []).append(L)
    return any(not L.get("hardBreak") for ls in by_p.values() for L in ls[:-1])


def fit_eligible(e: dict, n_lines: int, has_field: bool, rot: float) -> bool:
    """CONTRACT v2 (f) / judge J2-01: would the HTML wrap a longer line inside this block's own box?"""
    if has_field or e.get("nowrap") is True or e.get("shrinkWrap") is True:
        return False
    if n_lines > 1:
        return True
    return n_lines == 1 and e.get("nowrap") is False and e.get("shrinkWrap") is False and not rot


# ============================================================================================== paragraph props
def expected_indents(paras: list[dict], overhang_ok: bool = True) -> list[tuple[int, int]]:
    """(marL, indent) EMU the builder must write per IR paragraph: marginLeftPx / indentPx, a hanging marker left of
    the box moved inside it (text boxes: the box is widened by the largest overhang), indent >= -marL."""
    marl = [max(0.0, num(p.get("marginLeftPx"))) for p in paras]
    ind = [num(p.get("indentPx")) for p in paras]
    over = max([0.0] + [-(m + i) for m, i in zip(marl, ind)]) if overhang_ok else 0.0
    out = []
    for m, i in zip(marl, ind):
        me = max(0, emu(m + over))
        out.append((me, max(emu(i), -me)))
    return out


def check_paragraph_props(prob, tm, where, eid, p, ppr, want_ml, label):
    """Alignment, marL/indent and the bullet of one written paragraph vs its IR paragraph."""
    prob.expect(ppr is not None and ppr.get("algn", "l") == (p.get("align") or "l"), *where, eid, "align",
                f"{label}: algn {ppr.get('algn') if ppr is not None else None} != {p.get('align')}")
    if ppr is None:
        return
    # paragraph flags PowerPoint renders (fixer round 3, VR-05): left-to-right, runs of different sizes on the
    # baseline (fontAlgn auto/base; "t" would hang a smaller unit from the line top), and CONTRACT v2's line breaking
    # written explicitly on every paragraph (eaLnBrk=1 latinLnBrk=0 hangingPunct=0: Hangul breaks between syllables
    # like Chromium's word-break: normal, whatever the master/theme says)
    flags = {k: ppr.get(k) for k in ("rtl", "fontAlgn", "eaLnBrk", "latinLnBrk", "hangingPunct")}
    ok = not truthy(flags["rtl"]) and flags["fontAlgn"] in (None, "auto", "base") and truthy(flags["eaLnBrk"]) \
        and flags["latinLnBrk"] in ("0", "false") and flags["hangingPunct"] in ("0", "false")
    prob.expect(ok, *where, eid, "para-flags", f"{label}: pPr {flags} (expected ltr, fontAlgn auto/base, eaLnBrk=1 "
                "latinLnBrk=0 hangingPunct=0)")
    got = (int(ppr.get("marL", 0)), int(ppr.get("indent", 0)))
    prob.expect(abs(got[0] - want_ml[0]) <= 1 and abs(got[1] - want_ml[1]) <= 1, *where, eid, "indent",
                f"{label}: marL/indent {got} EMU != {want_ml} (IR marginLeftPx {p.get('marginLeftPx')}, "
                f"indentPx {p.get('indentPx')})")
    bu = {ln(c): c for c in ppr if ln(c).startswith("bu")}
    b = p.get("bullet")
    first = next((r for r in p.get("runs") or [] if isinstance(r, dict) and not r.get("break")), None)
    face0 = tm.face(first.get("fontWeight", 400) if first else 400)
    if not isinstance(b, dict) or b.get("type") not in ("char", "number"):
        ok = "buNone" in bu and "buChar" not in bu and "buAutoNum" not in bu
        msg = f"{label}: bullet {sorted(bu)} but the IR has none (buNone)"
    else:
        want_c = str(b.get("color")).upper() if b.get("color") else None
        clr = color_alpha(bu["buClr"]) if "buClr" in bu else None
        ok = (clr is None) if want_c is None else (clr is not None and clr[0] == want_c)
        ok = ok and "buSzPts" not in bu and "buSzPct" in bu and int(bu["buSzPct"].get("val", 0)) == 100000
        ok = ok and "buFont" in bu and bu["buFont"].get("typeface") == face0.typeface
        if b["type"] == "char":
            ok = ok and "buChar" in bu and bu["buChar"].get("char") == (str(b.get("char") or "•")[:1] or "•")
        else:
            an = bu.get("buAutoNum")
            ok = ok and an is not None and an.get("type") == (b.get("scheme") or "arabicPeriod") \
                and int(an.get("startAt", 1)) == int(num(b.get("startAt"), 1))
        msg = (f"{label}: bullet {[(k, dict(v.attrib)) for k, v in bu.items()]} != IR {b} "
               f"(buFont {face0.typeface!r}, colour {want_c or 'text'})")
    prob.expect(ok, *where, eid, "bullet", msg)


# ============================================================================================== element checks
def expected_autofit(body, rot) -> str:
    """CONTRACT v2 (fixer round 3, EDIT-01): a wrap="square" box (not rotated) shrinks an edited, overflowing text
    (normAutofit, PowerPoint's own title/body placeholder setting); wrap="none" (never overflows vertically) and
    rotated boxes keep noAutofit."""
    return "normAutofit" if body.get("wrap", "square") == "square" and not rot else "noAutofit"


def check_text_frame(prob, where, eid, sp, rot):
    """The text box itself: insets, anchoring, autofit, direction, columns; a frame that paints nothing."""
    body = sp.find(f"{P}txBody/{A}bodyPr")
    ins = [int(body.get(k, d)) for k, d in (("lIns", 91440), ("tIns", 45720), ("rIns", 91440), ("bIns", 45720))]
    if not rot:
        prob.expect(ins == [0, 0, 0, 0], *where, eid, "insets", f"bodyPr insets l/t/r/b {ins} EMU (builder: 0)")
    else:
        prob.expect(min(ins) >= 0, *where, eid, "insets", f"negative bodyPr inset {ins}")
    prob.expect(body.get("anchor", "t") == "t" and not truthy(body.get("anchorCtr")), *where, eid, "anchor",
                f"anchor={body.get('anchor')} anchorCtr={body.get('anchorCtr')} (builder: top, text at its baseline)")
    fits = [c for c in body if ln(c) in AUTOFIT]
    want_fit = expected_autofit(body, rot)
    ok = [ln(c) for c in fits] == [want_fit]
    if ok and want_fit == "normAutofit":             # no stored shrink: the unedited text renders at 100 % / 0 %
        ok = int(num(fits[0].get("fontScale"), 100000)) == 100000 and int(num(fits[0].get("lnSpcReduction"), 0)) == 0
    prob.expect(ok, *where, eid, "autofit",
                f"autofit {[(ln(c), dict(c.attrib)) for c in fits] or ['(none: inherited)']} (builder: {want_fit} for "
                f"wrap={body.get('wrap', 'square')!r}, no fontScale / lnSpcReduction)")
    prob.expect(body.get("vert", "horz") == "horz", *where, eid, "vert", f"vert={body.get('vert')} (horizontal text)")
    prob.expect(int(num(body.get("rot"), 0)) == 0 and not truthy(body.get("upright")), *where, eid, "body-rot",
                f"bodyPr rot={body.get('rot')} upright={body.get('upright')}")
    prob.expect(int(num(body.get("numCol"), 1)) == 1, *where, eid, "columns", f"numCol={body.get('numCol')}")
    sppr = sp.find(P + "spPr")
    f = fill_of(sppr)
    lnel = sppr.find(A + "ln")
    eff = sppr.find(A + "effectLst")
    g = sppr.find(A + "prstGeom")
    prob.expect((f is None or ln(f) == "noFill") and (lnel is None or lnel.find(A + "noFill") is not None)
                and (eff is None or len(eff) == 0) and (g is None or g.get("prst") == "rect"), *where, eid, "frame",
                "the text box frame paints something (fill, line, effect or a non-rect preset)")


def check_text(prob, tm, where, e, sp, slide_no, in_layout, tol):
    eid = e.get("id")
    cb = e.get("contentBox") or e.get("box") or {}
    paras = [p for p in e.get("paragraphs") or [] if isinstance(p, dict)]
    x, y, w, h, rot = box_of(sp)
    body = sp.find(f"{P}txBody/{A}bodyPr")
    lins, rins = px(body.get("lIns", 91440)), px(body.get("rIns", 91440))
    tx0, tx1 = x + lins, x + w - rins                      # the text area PowerPoint lays lines out in
    marl = [max(0.0, num(p.get("marginLeftPx"))) for p in paras]
    ind = [num(p.get("indentPx")) for p in paras]
    over = max([0.0] + [-(m + i) for m, i in zip(marl, ind)])
    x_left, w_box = num(cb.get("x")) - over, num(cb.get("w")) + over
    a0 = (paras[0].get("align") if paras else "l") or "l"
    has_field = any(r.get("field") for p in paras for r in p.get("runs") or [] if isinstance(r, dict))
    if a0 == "r":
        prob.expect(abs(tx1 - (x_left + w_box)) <= tol, *where, eid, "text-x",
                    f"text area right edge {tx1:.3f} != {x_left + w_box:.3f}")
    elif a0 == "ctr":
        prob.expect(abs((tx0 + tx1) / 2 - (x_left + w_box / 2)) <= tol, *where, eid, "text-x",
                    f"text area centre {(tx0 + tx1) / 2:.3f} != {x_left + w_box / 2:.3f}")
    else:
        prob.expect(abs(tx0 - x_left) <= tol, *where, eid, "text-x", f"text area left edge {tx0:.3f} != {x_left:.3f}")
    prob.expect(rot_equal(rot, num(e.get("rotationDeg"))), *where, eid, "rotation",
                f"rot {rot} != {e.get('rotationDeg')}")
    check_text_frame(prob, where, eid, sp, rot)
    xml_paras = sp.findall(f"{P}txBody/{A}p")
    lines = [L for L in e.get("lines") or [] if isinstance(L, dict)]
    wrap = body.get("wrap", "square")
    avail_pt = (tx1 - tx0) * 0.75
    soft = ir_has_soft_wrap(lines)
    if not soft:
        # hard breaks only (one line included): the box is the HTML box; square iff "fit" (CONTRACT v2 (f), J2-01)
        if not rot:
            prob.expect(abs((tx1 - tx0) - w_box) <= tol, *where, eid, "text-w",
                        f"text area width {tx1 - tx0:.3f} != the HTML box {w_box:.3f}")
        eligible = fit_eligible(e, len(lines), has_field, rot)
        if tm.model is not None:
            widths = xml_hard_line_widths(tm, xml_paras)
            limit = avail_pt * (1.0 - FIT_MARGIN_REL)
            # the builder decides from the IR (exact sizes / letter spacing), this from the written sz/spc (rounded to
            # 1/100 pt): a line within that rounding of the limit may go either way
            band = lambda n: FIT_BAND_PT + 0.005 * n  # noqa: E731
            fits = bool(widths) and all(v <= limit + band(n) for v, n in widths)
            clear = bool(widths) and all(v <= limit - band(n) for v, n in widths)
            want = "square" if eligible and clear else ("none" if not (eligible and fits) else None)
            if want == "square" and not lines_align(xml_paras, lines):
                want = None                       # the builder cannot measure unaligned lines: it keeps "none"
            why = ("fits and would wrap inside its HTML box" if want == "square" else
                   "CSS nowrap / shrink-to-fit box / text field / rotated" if not eligible else
                   f"a line is not >= 2 % inside the box ({max((v for v, _ in widths), default=0):.2f} > "
                   f"{limit:.2f} pt)")
            prob.expect(want is None or wrap == want, *where, eid, "wrap",
                        f"wrap={wrap!r}, expected {want!r}: {why}")
    if wrap == "square" and tm.model is not None:
        got = [(p_, t.strip()) for p_, t in simulate_paras(tm, xml_paras, avail_pt)]
        want_l = [(L.get("paragraph"), str(L.get("text") or "").strip()) for L in lines]
        prob.expect(got == want_l, *where, eid, "wrap-lines",
                    f"PowerPoint would break into {len(got)} line(s) {got[:3]}… vs Chromium {want_l[:3]}…")
    if not rot:
        stack, block_h = line_stack(tm, xml_paras, lines)
        top = y + px(body.get("tIns", 45720))
        for L, off in stack:
            pred = top + off
            if not prob.expect(abs(pred - num(L.get("baseline"))) <= BASELINE_TOL, *where, eid, "baseline",
                               f"PowerPoint baseline {pred:.3f} vs Chromium {num(L.get('baseline')):.3f} "
                               f"(line {str(L.get('text'))[:20]!r})"):
                break
        if expected_autofit(body, rot) == "normAutofit" and stack:
            # "shrink on overflow" must never fire on the unedited text: the text area is >= 5 % taller than
            # PowerPoint's text height (fixer round 3, EDIT-01)
            area_h = h - px(body.get("tIns", 45720)) - px(body.get("bIns", 45720))
            prob.expect(area_h >= block_h * (1.0 + AUTOFIT_SLACK_REL) - BASELINE_TOL, *where, eid, "autofit-slack",
                        f"text area height {area_h:.3f} px < {1 + AUTOFIT_SLACK_REL:.2f} x PowerPoint's text height "
                        f"{block_h:.3f} px: normAutofit could shrink the unedited text")
    prob.expect(len(xml_paras) == len(paras), *where, eid, "paragraphs",
                f"{len(xml_paras)} a:p for {len(paras)} IR paragraph(s)")
    for k, (p, ap, ml) in enumerate(zip(paras, xml_paras, expected_indents(paras))):
        check_paragraph_props(prob, tm, where, eid, p, ap.find(A + "pPr"), ml, f"paragraph {k}")
    check_runs(prob, tm, where, eid, paras, xml_paras, num(e.get("opacity"), 1.0), slide_no, in_layout)
    check_para_marks(prob, where, eid, xml_paras, "text")
    ph = sp.find(f"{P}nvSpPr/{P}nvPr/{P}ph")
    want_ph = e.get("placeholder")
    prob.expect((ph.get("type") if ph is not None else None) == want_ph, *where, eid, "placeholder",
                f"placeholder {ph.get('type') if ph is not None else None} != IR {want_ph}")
    if ph is not None and want_ph in PLACEHOLDER_IDX:
        prob.expect(ph.get("idx") == PLACEHOLDER_IDX[want_ph], *where, eid, "placeholder",
                    f"{want_ph} placeholder idx {ph.get('idx')!r} != {PLACEHOLDER_IDX[want_ph]!r} (PowerPoint's own "
                    "Title Slide layout: ctrTitle / title without idx, subTitle idx=\"1\")")
    if has_field and not in_layout:
        for fld in sp.iter(A + "fld"):
            if fld.get("type") == "slidenum":
                t = fld.find(A + "t")
                prob.expect(t is not None and t.text == str(slide_no), *where, eid, "field",
                            f"slide-number field text {t.text if t is not None else None!r} on slide {slide_no}")


def expected_shape_boxes(e):
    """[(role, (x, y, w, h), radius, fill, line, shadow)] the builder must write for an IR shape."""
    b = e.get("box") or {}
    bx, by, bw_, bh_ = num(b.get("x")), num(b.get("y")), max(0.0, num(b.get("w"))), max(0.0, num(b.get("h")))
    fill, line, shadow = e.get("fill"), e.get("line"), e.get("shadow")
    if not isinstance(line, dict) or num(line.get("widthPx")) <= 0:
        line = None
    op = num(e.get("opacity"), 1.0)
    bw = num(line.get("widthPx")) if line else 0.0
    if line and bw * 2 > min(bw_, bh_) > 0:
        bw = min(bw_, bh_) / 2
    r = max(0.0, num(e.get("radiusPx")))
    has_fill = isinstance(fill, dict)
    translucent = bool(line) and num(line.get("alpha"), 1.0) * op < 1.0
    grad_line = bool(line) and has_fill and fill.get("type") == "linear"
    broken = bool(line) and line.get("dash", "solid") in ("dashed", "dotted")
    i = bw / 2.0
    inset = (bx + i, by + i, max(0.0, bw_ - bw), max(0.0, bh_ - bw))
    if not (has_fill and line is not None and (translucent or grad_line or broken)):
        return [("main", inset, max(0.0, r - i), fill, line, shadow)]
    if grad_line:
        fb, fr = (bx + bw, by + bw, max(0.0, bw_ - 2 * bw), max(0.0, bh_ - 2 * bw)), max(0.0, r - bw)
    else:
        fb, fr = (bx, by, bw_, bh_), r
    return [("fill", fb, fr, fill, None, shadow), ("border", inset, max(0.0, r - i), None, line, None)]


def check_fill(prob, where, eid, parent, fill, op, label):
    f = fill_of(parent)
    if not isinstance(fill, dict) or (fill.get("type") == "solid" and num(fill.get("alpha"), 1.0) * op <= 0):
        prob.expect(f is not None and ln(f) == "noFill", *where, eid, "fill", f"{label}: expected noFill, got "
                    f"{ln(f) if f is not None else None}")
        return
    if fill.get("type") == "solid":
        ca = color_alpha(f) if f is not None and ln(f) == "solidFill" else None
        want = (str(fill.get("color")).upper(), num(fill.get("alpha"), 1.0) * op)
        prob.expect(ca is not None and ca[0] == want[0] and abs(ca[1] - want[1]) <= 0.006, *where, eid, "fill",
                    f"{label}: {ca} != {want[0]}@{want[1]:.3f}")
    elif fill.get("type") == "linear":
        ok = f is not None and ln(f) == "gradFill"
        if ok:
            gs = f.findall(f"{A}gsLst/{A}gs")
            stops = sorted((s for s in fill.get("stops") or [] if isinstance(s, dict)), key=lambda s: num(s.get("pos")))
            first = color_alpha(gs[0]) if gs else None
            last = color_alpha(gs[-1]) if gs else None
            ok = bool(gs) and first is not None and last is not None and int(gs[0].get("pos")) == 0 \
                and int(gs[-1].get("pos")) == 100000
            if ok and stops and 0 <= num(stops[0].get("pos")) and num(stops[-1].get("pos")) <= 1:
                ok = first[0] == str(stops[0].get("color")).upper() and last[0] == str(stops[-1].get("color")).upper()
            lin = f.find(A + "lin")
            want_ang = int(round(((num(fill.get("angleDeg"), 180) - 90) % 360) * 60000)) % 21600000
            ok = ok and lin is not None and abs(int(lin.get("ang")) - want_ang) <= 1
        prob.expect(ok, *where, eid, "fill", f"{label}: gradient stops/angle differ from the IR")


def dash_of(lnel) -> str:
    """The IR dash class a written a:ln / a:lnX draws (builder: prstDash solid | custDash | prstDash sysDot)."""
    if lnel is None:
        return "solid"
    if lnel.find(A + "custDash") is not None:
        return "dashed"
    pd = lnel.find(A + "prstDash")
    v = pd.get("val") if pd is not None else "solid"
    return {"solid": "solid", "sysDot": "dotted"}.get(v, f"prstDash {v}")


def check_dash(prob, where, eid, lnel, line, label) -> None:
    """A solid CSS border stays solid, dashed / dotted keep their class (fixer round 3, VR-04)."""
    want = (line.get("dash") or "solid") if isinstance(line, dict) else "solid"
    got = dash_of(lnel)
    prob.expect(got == want, *where, eid, "line-dash", f"{label}: line dash {got!r} != IR {want!r}")


def check_line(prob, where, eid, sppr, line, op, label):
    lnel = sppr.find(A + "ln")
    if not isinstance(line, dict):
        prob.expect(lnel is not None and lnel.find(A + "noFill") is not None, *where, eid, "line",
                    f"{label}: expected no line")
        return
    ca = color_alpha(lnel.find(A + "solidFill")) if lnel is not None else None
    want_w = int(round(num(line.get("widthPx")) * EMU))
    ok = lnel is not None and abs(int(lnel.get("w", -1)) - want_w) <= 1 and ca is not None \
        and ca[0] == str(line.get("color")).upper() and abs(ca[1] - num(line.get("alpha"), 1.0) * op) <= 0.006
    prob.expect(ok, *where, eid, "line", f"{label}: line w={lnel.get('w') if lnel is not None else None} {ca} vs "
                f"{want_w} {line.get('color')}@{num(line.get('alpha'), 1.0) * op:.3f}")
    check_dash(prob, where, eid, lnel, line, label)


def check_shadow(prob, where, eid, eff_parent, shadow, op, rot, label):
    eff = eff_parent.find(A + "effectLst") if eff_parent is not None else None
    sh = eff.find(A + "outerShdw") if eff is not None else None
    if not isinstance(shadow, dict) or num(shadow.get("alpha"), 1.0) * op <= 0:
        prob.expect(sh is None, *where, eid, "shadow", f"{label}: unexpected outer shadow")
        return
    ox, oy = num(shadow.get("offsetXPx")), num(shadow.get("offsetYPx"))
    dist = math.hypot(ox, oy)
    want = {"blurRad": int(round(max(0.0, num(shadow.get("blurPx"))) * EMU)), "dist": int(round(dist * EMU))}
    d = (math.degrees(math.atan2(oy, ox)) + rot) if dist > 0 else 0.0
    want_dir = int(round((d % 360.0) * 60000)) % 21600000
    ca = color_alpha(sh) if sh is not None else None
    ok = sh is not None and all(abs(int(sh.get(k, -9)) - v) <= 1 for k, v in want.items()) \
        and abs(int(sh.get("dir", 0)) - want_dir) <= 1 and ca is not None \
        and ca[0] == str(shadow.get("color")).upper() and abs(ca[1] - num(shadow.get("alpha"), 1.0) * op) <= 0.006
    prob.expect(ok, *where, eid, "shadow", f"{label}: shadow {dict(sh.attrib) if sh is not None else None} {ca} vs "
                f"{want} dir {want_dir} {shadow.get('color')}@{num(shadow.get('alpha'), 1) * op:.3f}")


def check_shape(prob, where, e, nodes_by_role, tol):
    eid = e.get("id")
    op = num(e.get("opacity"), 1.0)
    rot = num(e.get("rotationDeg"))
    for role, (bx, by, bw, bh), r, fill, line, shadow in expected_shape_boxes(e):
        node = nodes_by_role.get(role)
        if not prob.expect(node is not None, *where, eid, "object", f"no {role} object"):
            continue
        x, y, w, h, nrot = box_of(node)
        prob.expect(max(abs(x - bx), abs(y - by), abs(w - bw), abs(h - bh)) <= tol, *where, eid, "geometry",
                    f"{role} box ({x:.3f},{y:.3f} {w:.3f}x{h:.3f}) != ({bx:.3f},{by:.3f} {bw:.3f}x{bh:.3f})")
        prob.expect(rot_equal(nrot, rot), *where, eid, "rotation", f"rot {nrot} != {rot}")
        sppr = node.find(P + "spPr")
        g = sppr.find(A + "prstGeom")
        geom = e.get("geometry", "rect")
        adj = 0
        if geom == "roundRect" and r > 0 and min(w, h) > 0:
            adj = max(0, min(50000, int(round(r / min(bw, bh) * 100000))))
        want_prst = "ellipse" if geom == "ellipse" else ("roundRect" if geom == "roundRect" and adj > 0 else "rect")
        ok = g is not None and g.get("prst") == want_prst
        if ok and want_prst == "roundRect":
            gd = g.find(f"{A}avLst/{A}gd")
            ok = gd is not None and abs(int(gd.get("fmla", "val 0").split()[-1]) - adj) <= 1
        prob.expect(ok, *where, eid, "geometry", f"preset {g.get('prst') if g is not None else None} != {want_prst}"
                    + (f" adj {adj}" if want_prst == "roundRect" else ""))
        check_fill(prob, where, eid, sppr, fill, op, role)
        check_line(prob, where, eid, sppr, line, op, role)
        check_shadow(prob, where, eid, sppr, shadow, op, rot, role)
        if fill_is_dark(fill, op):                  # text typed into it must be legible (EDIT-12)
            d = node.find(f"{P}txBody/{A}lstStyle/{A}lvl1pPr/{A}defRPr")
            ca = color_alpha(d.find(A + "solidFill")) if d is not None else None
            prob.expect(ca is not None and luminance(ca[0]) > 0.5, *where, eid, "default-text",
                        f"{role}: dark fill without a light default text colour (lstStyle defRPr {ca})")
        cnv = cnv_of(node)
        dec = cnv.find(f".//{{{NS['adec']}}}decorative") if cnv is not None else None
        prob.expect(cnv is not None and ((cnv.get("descr") or "").strip() or (dec is not None and dec.get("val") == "1")),
                    *where, eid, "alt", f"{role}: a shape without alt text or the decorative flag")


def check_image(prob, deck, part, where, e, node, tol):
    eid = e.get("id")
    b = e.get("box") or {}
    x, y, w, h, rot = box_of(node)
    prob.expect(max(abs(x - num(b.get("x"))), abs(y - num(b.get("y"))), abs(w - num(b.get("w"))),
                    abs(h - num(b.get("h")))) <= tol, *where, eid, "geometry",
                f"picture ({x:.3f},{y:.3f} {w:.3f}x{h:.3f}) != IR {b}")
    prob.expect(rot_equal(rot, num(e.get("rotationDeg"))), *where, eid, "rotation",
                f"rot {rot} != {e.get('rotationDeg')}")
    bf = node.find(P + "blipFill")
    blip = bf.find(A + "blip") if bf is not None else None
    if not prob.expect(blip is not None, *where, eid, "picture", "p:pic without a:blip"):
        return
    # identity: the picture's parts are the IR assets, byte for byte (a swapped or wrong icon fails)
    src = e.get("src")
    tgt = deck.target(part, blip.get(R + "embed"))
    if src:
        f = ir_file(src)
        ok = tgt in deck.names and f.is_file() and sha(deck.z.read(tgt)) == sha(f.read_bytes())
        prob.expect(ok, *where, eid, "picture", f"PNG part {tgt} is not the IR asset {src}")
    svgb = blip.find(f".//{{{NS['asvg']}}}svgBlip")
    if e.get("svg"):
        prob.expect(svgb is not None, *where, eid, "svg", "IR has an SVG but the picture carries no native SVG (svgBlip)")
    if svgb is not None:
        st = deck.target(part, svgb.get(R + "embed"))
        f = ir_file(e.get("svg") or "")
        ok = bool(e.get("svg")) and st in deck.names and f.is_file() and sha(deck.z.read(st)) == sha(f.read_bytes())
        prob.expect(ok, *where, eid, "picture", f"SVG part {st} is not the IR asset {e.get('svg')}")
    # effects: only the IR opacity (alphaModFix), nothing that recolours, fades or crops the picture
    op = num(e.get("opacity"), 1.0)
    kids = [ln(c) for c in blip]
    allowed = {"extLst"} | ({"alphaModFix"} if op < 0.99999 else set())
    prob.expect(all(k in allowed for k in kids), *where, eid, "picture-effect",
                f"blip effects {[k for k in kids if k not in allowed]} (IR opacity {op})")
    amf = blip.find(A + "alphaModFix")
    if op < 0.99999:
        prob.expect(amf is not None and abs(int(amf.get("amt", 100000)) - op * 100000) <= 2, *where, eid,
                    "picture-effect", f"alphaModFix {amf.get('amt') if amf is not None else None} != opacity {op}")
    sr = bf.find(A + "srcRect")
    prob.expect(sr is None or all(int(sr.get(k, 0)) == 0 for k in ("l", "t", "r", "b")), *where, eid, "picture-crop",
                f"srcRect {dict(sr.attrib) if sr is not None else None} crops the picture")
    fr = bf.find(f"{A}stretch/{A}fillRect")
    prob.expect(bf.find(A + "tile") is None and fr is not None
                and all(int(fr.get(k, 0)) == 0 for k in ("l", "t", "r", "b")), *where, eid, "picture-crop",
                "the picture is tiled or not stretched to its frame")
    sppr = node.find(P + "spPr")
    g = sppr.find(A + "prstGeom") if sppr is not None else None
    lnel = sppr.find(A + "ln") if sppr is not None else None
    eff = sppr.find(A + "effectLst") if sppr is not None else None
    prob.expect((g is None or g.get("prst") == "rect") and (lnel is None or lnel.find(A + "noFill") is not None
                                                           or not len(lnel)) and (eff is None or len(eff) == 0),
                *where, eid, "frame", "the picture frame has a non-rect preset, a line or an effect")
    cnv = cnv_of(node)
    alt = str(e.get("alt") or "").strip()
    if alt:
        prob.expect(cnv.get("descr") == alt, *where, eid, "alt", f"descr {cnv.get('descr')!r} != alt {alt!r}")
    else:
        dec = cnv.find(f".//{{{NS['adec']}}}decorative")
        prob.expect(cnv.get("descr", "") == "" and dec is not None and dec.get("val") == "1", *where, eid, "alt",
                    f"empty alt: expected descr='' + decorative flag, got descr={cnv.get('descr')!r}")


def _merge_edge(cur, new):
    wn = num(new.get("widthPx")) if isinstance(new, dict) else 0
    wc = num(cur.get("widthPx")) if isinstance(cur, dict) else 0
    if wn <= 0:
        return cur
    if wc <= 0:
        return new
    return new if wn > wc else cur


def check_cell_text(prob, tm, where, eid, cell, tc, tcpr, cx0, cx1, cy0, cy1, label):
    """One origin cell's text: anchor, paragraph props, anchored-edge margins, PowerPoint's lines, baselines."""
    paras = [p for p in cell.get("paragraphs") or [] if isinstance(p, dict)]
    xps = tc.findall(f"{A}txBody/{A}p")
    want_anchor = {"top": "t", "middle": "ctr", "bottom": "b"}.get(cell.get("vAlign", "top"), "t")
    anchor = tcpr.get("anchor", "t")
    prob.expect(anchor == want_anchor, *where, eid, "cell-anchor",
                f"{label}: anchor {anchor} != IR vAlign {cell.get('vAlign')}")
    ind = expected_indents(paras, overhang_ok=False)
    for k, (p, ap) in enumerate(zip(paras, xps)):
        check_paragraph_props(prob, tm, where, eid, p, ap.find(A + "pPr"), ind[k], f"{label} paragraph {k}")
    marl, marr = px(tcpr.get("marL", 91440)), px(tcpr.get("marR", 91440))
    mart, marb = px(tcpr.get("marT", 45720)), px(tcpr.get("marB", 45720))
    lines = [L for L in cell.get("lines") or [] if isinstance(L, dict)]
    seen = set()
    for L in lines:
        pi = L.get("paragraph")
        if not isinstance(pi, int) or not 0 <= pi < len(paras) or L.get("left") is None:
            continue
        first = pi not in seen
        seen.add(pi)
        p = paras[pi]
        a = p.get("align") or "l"
        start = cx0 + marl + num(p.get("marginLeftPx")) + (num(p.get("indentPx")) if first and not p.get("bullet")
                                                           else 0.0)
        if a == "r":
            got, want = cx1 - marr, num(L.get("right"))
        elif a == "ctr":
            got, want = (start + cx1 - marr) / 2, (num(L.get("left")) + num(L.get("right"))) / 2
        elif a == "just":
            continue
        else:
            got, want = start, num(L.get("left"))
        if not prob.expect(abs(got - want) <= EDGE_TOL, *where, eid, "cell-margin",
                           f"{label}: {a}-aligned text edge {got:.3f} != Chromium's {want:.3f} "
                           f"(marL {marl:.2f} marR {marr:.2f} px)"):
            break
    if not lines or tm.model is None:
        return
    avail_pt = max(0.0, (cx1 - cx0 - marl - marr) * 0.75)
    got_l = [(p_, t.strip()) for p_, t in simulate_paras(tm, xps, avail_pt)]
    want_l = [(L.get("paragraph"), str(L.get("text") or "").strip()) for L in lines]
    if not prob.expect(got_l == want_l, *where, eid, "cell-wrap",
                       f"{label}: PowerPoint would break into {got_l[:3]} vs Chromium {want_l[:3]}"):
        return
    stack, block_h = line_stack(tm, xps, lines)
    top, bot = cy0 + mart, cy1 - marb
    y0 = {"t": top, "ctr": (top + bot - block_h) / 2, "b": bot - block_h}.get(anchor, top)
    for L, off in stack:
        pred = y0 + off
        if not prob.expect(abs(pred - num(L.get("baseline"))) <= BASELINE_TOL, *where, eid, "cell-baseline",
                           f"{label}: PowerPoint baseline {pred:.3f} vs Chromium {num(L.get('baseline')):.3f} "
                           f"(line {str(L.get('text'))[:20]!r}, anchor {anchor})"):
            break


def check_table_spans(prob, where, eid, trs, span, nR, nC) -> None:
    """Merges = the IR's spans, written as [MS-OI29500] 21.1.3.13 d describes (python-pptx's merge): the origin
    carries rowSpan/gridSpan, the rest of the merge's top row rowSpan, its left column gridSpan, covered cells hMerge
    (right of the origin column) / vMerge (below the origin row); no other cell spans or merges. Every cell's text runs
    horizontally (tcPr vert absent / horz) (fixer round 3, VR-04)."""
    origin = {}
    for (r0, c0), (rs, cs) in span.items():
        for rr in range(r0, min(nR, r0 + rs)):
            for cc in range(c0, min(nC, c0 + cs)):
                origin[(rr, cc)] = (r0, c0)
    bad = []
    for r, tr in enumerate(trs):
        for c, tc in enumerate(tr.findall(A + "tc")):
            r0, c0 = origin.get((r, c), (r, c))
            rs, cs = span.get((r0, c0), (1, 1))
            want = {"rowSpan": rs if r == r0 else 1, "gridSpan": cs if c == c0 else 1,
                    "hMerge": c > c0, "vMerge": r > r0}
            got = {"rowSpan": int(num(tc.get("rowSpan"), 1)), "gridSpan": int(num(tc.get("gridSpan"), 1)),
                   "hMerge": truthy(tc.get("hMerge")), "vMerge": truthy(tc.get("vMerge"))}
            if got != want:
                bad.append(f"({r},{c}) {got} != {want}")
            tcpr = tc.find(A + "tcPr")
            if tcpr is not None and tcpr.get("vert", "horz") != "horz":
                bad.append(f"({r},{c}) vert={tcpr.get('vert')}")
    prob.expect(not bad, *where, eid, "table-spans", f"cell spans / merges / text direction differ from the IR: "
                f"{bad[:4]}")


def check_table(prob, tm, where, e, gf, bg, tol, slide_no):
    eid = e.get("id")
    cols = [num(v) for v in e.get("columnsPx") or []]
    rows = [num(v) for v in e.get("rowsPx") or []]
    cells = e.get("cells") or []
    nR, nC = len(rows), len(cols)
    tbl = gf.find(f"{A}graphic/{A}graphicData/{A}tbl")
    if not prob.expect(tbl is not None, *where, eid, "object", "graphicFrame without a:tbl"):
        return
    # resolved edges (same collapse rule the IR's resolved borders need)
    V = [[None] * (nC + 1) for _ in range(nR)]
    H = [[None] * nC for _ in range(nR + 1)]
    span = {}
    for r in range(nR):
        for c in range(nC):
            cell = cells[r][c] if r < len(cells) and c < len(cells[r]) and isinstance(cells[r][c], dict) else {}
            if cell.get("covered"):
                continue
            rs, cs = max(1, int(num(cell.get("rowSpan"), 1))), max(1, int(num(cell.get("colSpan"), 1)))
            span[(r, c)] = (rs, cs)
            bd = cell.get("borders") or {}
            for rr in range(r, min(nR, r + rs)):
                V[rr][c] = _merge_edge(V[rr][c], bd.get("left"))
                V[rr][min(nC, c + cs)] = _merge_edge(V[rr][min(nC, c + cs)], bd.get("right"))
            for cc in range(c, min(nC, c + cs)):
                H[r][cc] = _merge_edge(H[r][cc], bd.get("top"))
                H[min(nR, r + rs)][cc] = _merge_edge(H[min(nR, r + rs)][cc], bd.get("bottom"))
    b = e.get("box") or {}
    lw = lambda L: num(L.get("widthPx")) if isinstance(L, dict) else 0.0  # noqa: E731
    x0, y0 = num(b.get("x")) + lw(V[0][0]) / 2 if nR else 0, num(b.get("y")) + lw(H[0][0]) / 2 if nC else 0
    x, y, w, h, _ = box_of(gf)
    prob.expect(abs(x - x0) <= tol and abs(y - y0) <= tol, *where, eid, "geometry",
                f"table frame at ({x:.3f},{y:.3f}) != ({x0:.3f},{y0:.3f})")
    gcols = [px(g.get("w")) for g in tbl.findall(f"{A}tblGrid/{A}gridCol")]
    acc_x = acc_i = 0.0
    ok = len(gcols) == nC
    for gw, cw in zip(gcols, cols):
        acc_x += gw
        acc_i += cw
        ok = ok and abs(acc_x - acc_i) <= tol
    prob.expect(ok, *where, eid, "grid", f"grid columns {gcols} vs IR {cols}")
    trs = tbl.findall(A + "tr")
    heights = [px(tr.get("h")) for tr in trs]
    acc_x = acc_i = 0.0
    grown = []
    for k, (hh, rh) in enumerate(zip(heights, rows)):
        acc_x += hh
        acc_i += rh
        if acc_x < acc_i - tol:
            prob.add(*where, eid, "grid", f"row {k} ends at {acc_x:.3f} before Chromium's {acc_i:.3f}")
        elif acc_x > acc_i + tol:
            grown.append(k)
    prob.expect(len(trs) == nR, *where, eid, "grid", f"{len(trs)} rows vs IR {nR}")
    if grown:
        prob.add(*where, eid, "grid", f"rows {grown} taller than Chromium's (the builder grew them)")
    # header row (IR header cells in row 0 -> tblPr@firstRow, J2-03); no banding / first-column / last-row flags
    tp = tbl.find(A + "tblPr")
    row0 = [c for c in (cells[0] if cells else []) if isinstance(c, dict) and not c.get("covered")]
    want_first = bool(row0) and all(c.get("header") is True for c in row0)
    flags = {k: truthy(tp.get(k)) if tp is not None else False
             for k in ("firstRow", "bandRow", "firstCol", "lastRow", "lastCol", "bandCol")}
    prob.expect(flags["firstRow"] == want_first and not any(v for k, v in flags.items() if k != "firstRow"), *where,
                eid, "table-flags", f"tblPr flags {[k for k, v in flags.items() if v]} (header row expected: {want_first})")
    prob.expect(tp is None or not truthy(tp.get("rtl")), *where, eid, "table-flags",
                "tblPr rtl=1: PowerPoint lays the columns out right to left (VR-04)")
    check_table_spans(prob, where, eid, trs, span, nR, nC)
    bg_rgb = None
    if isinstance(bg, dict):
        bg_rgb = str((bg.get("fill") or {}).get("color")).upper()
        check_shadow(prob, where, eid, tbl.find(A + "tblPr"), bg.get("shadow"), num(bg.get("opacity"), 1.0), 0.0,
                     "table background shadow (tblPr)")
    col_x = [x + sum(gcols[:k]) for k in range(len(gcols) + 1)]
    row_y = [y + sum(heights[:k]) for k in range(len(heights) + 1)]
    for (r, c), (rs, cs) in span.items():
        if r >= len(trs):
            continue
        tcs = trs[r].findall(A + "tc")
        if c >= len(tcs):
            continue
        tc = tcs[c]
        cell = cells[r][c]
        tcpr = tc.find(A + "tcPr")
        want = cell.get("fill")
        if bg_rgb:
            if not isinstance(want, dict):
                want = {"type": "solid", "color": bg_rgb, "alpha": 1.0}
            elif want.get("type") == "solid" and num(want.get("alpha"), 1.0) < 0.99999:
                a = num(want.get("alpha"), 1.0)
                cc_ = [int(str(want["color"])[k:k + 2], 16) for k in (0, 2, 4)]
                gg = [int(bg_rgb[k:k + 2], 16) for k in (0, 2, 4)]
                want = {"type": "solid", "color": "".join(f"{round(p_ * a + q * (1 - a)):02X}" for p_, q in zip(cc_, gg)),
                        "alpha": 1.0}
        check_fill(prob, where, eid, tcpr, want, num(e.get("opacity"), 1.0), f"cell ({r},{c})")
        for tag, edge in (("lnL", V[r][c]), ("lnR", V[r][min(nC, c + cs)]), ("lnT", H[r][c]),
                          ("lnB", H[min(nR, r + rs)][c])):
            el = tcpr.find(A + tag)
            if isinstance(edge, dict) and num(edge.get("widthPx")) > 0:
                ca = color_alpha(el.find(A + "solidFill")) if el is not None else None
                ok = el is not None and abs(int(el.get("w", -1)) - int(round(num(edge["widthPx"]) * EMU))) <= 1 \
                    and ca is not None and ca[0] == str(edge.get("color")).upper()
                prob.expect(ok, *where, eid, "border", f"cell ({r},{c}) {tag} {ca} w={el.get('w') if el is not None else None}"
                            f" vs {edge.get('color')} {edge.get('widthPx')}px")
                check_dash(prob, where, eid, el, edge, f"cell ({r},{c}) {tag}")
            else:
                prob.expect(el is not None and el.find(A + "noFill") is not None, *where, eid, "border",
                            f"cell ({r},{c}) {tag}: expected no border")
        if c + cs < len(col_x) and r + rs < len(row_y):
            check_cell_text(prob, tm, where, eid, cell, tc, tcpr, col_x[c], col_x[c + cs], row_y[r], row_y[r + rs],
                            f"cell ({r},{c})")
        paras = [p for p in cell.get("paragraphs") or [] if isinstance(p, dict)]
        check_runs(prob, tm, where, eid, paras, tc.findall(f"{A}txBody/{A}p"), num(e.get("opacity"), 1.0),
                   slide_no, False)
        check_para_marks(prob, where, eid, tc.findall(f"{A}txBody/{A}p"), f"cell ({r},{c})")


def check_frame(prob, where, e, node, tol, label):
    b = e.get("box") or {}
    x, y, w, h, _ = box_of(node)
    prob.expect(max(abs(x - num(b.get("x"))), abs(y - num(b.get("y"))), abs(w - num(b.get("w"))),
                    abs(h - num(b.get("h")))) <= tol, *where, e.get("id"), "geometry",
                f"{label} frame ({x:.3f},{y:.3f} {w:.3f}x{h:.3f}) != IR {b}")


# ---------------------------------------------------------------------------------------------- charts
def _norm_hex(c):
    s = str(c or "").strip().lstrip("#").upper()
    return s if len(s) == 6 and all(ch in "0123456789ABCDEF" for ch in s) else None


def _cval(el, tag, default=None):
    x = el.find(C + tag) if el is not None else None
    return x.get("val") if x is not None else default


def _sp_fill(sppr):
    return color_alpha(sppr.find(A + "solidFill")) if sppr is not None else None


def _def_rpr(txpr):
    return txpr.find(f"{A}p/{A}pPr/{A}defRPr") if txpr is not None else None


def check_chart(prob, tm, deck, part, where, e, gf):
    """The chart part vs the IR spec + resolved (what PowerPoint draws: data, colours, scale, labels, layout)."""
    from pptxlib import chart as CH                  # documented defaults + the contract's dLblPos mapping only
    eid = e.get("id")
    spec = e.get("spec") or {}
    res = e.get("resolved") or {}
    gd = gf.find(f"{A}graphic/{A}graphicData")
    cref = gd.find(C + "chart") if gd is not None else None
    tgt = deck.target(part, cref.get(R + "id")) if cref is not None else None
    if not prob.expect(tgt in deck.names, *where, eid, "chart", f"chart part {tgt} not found"):
        return
    cs = deck.xml(tgt)
    chart = cs.find(C + "chart")
    plot = chart.find(C + "plotArea")
    t = spec.get("type")
    gname = {"column": "barChart", "bar": "barChart", "line": "lineChart", "pie": "pieChart",
             "doughnut": "doughnutChart"}.get(t)
    grp = plot.find(C + gname) if gname else None
    if not prob.expect(grp is not None, *where, eid, "chart-type", f"no c:{gname} for spec type {t!r}"):
        return
    others = [ln(c) for c in plot if ln(c).endswith("Chart") and ln(c) != gname]
    prob.expect(not others, *where, eid, "chart-type", f"extra chart groups {others}")
    grouping = spec.get("grouping") or "clustered"
    if gname == "barChart":
        prob.expect(_cval(grp, "barDir") == ("bar" if t == "bar" else "col"), *where, eid, "chart-type",
                    f"barDir {_cval(grp, 'barDir')} for {t}")
        prob.expect(_cval(grp, "grouping") == grouping, *where, eid, "chart-type",
                    f"grouping {_cval(grp, 'grouping')} != {grouping}")
    elif gname == "lineChart":
        prob.expect(_cval(grp, "grouping") == ("stacked" if grouping == "stacked" else "standard"), *where, eid,
                    "chart-type", f"line grouping {_cval(grp, 'grouping')}")
    pie = gname in ("pieChart", "doughnutChart")
    prob.expect(_cval(grp, "varyColors") == ("1" if pie else "0"), *where, eid, "chart-colour",
                f"varyColors {_cval(grp, 'varyColors')}")
    # ---- series: names, categories, cached values, colours
    cats = [str(c) for c in spec.get("categories") or []]
    series = list(spec.get("series") or [])
    used = series[:1] if pie else series
    sers = grp.findall(C + "ser")
    prob.expect(len(sers) == len(used), *where, eid, "chart-data", f"{len(sers)} series vs spec {len(used)}")
    # plot order = the spec's series order (c:order: PowerPoint draws the clusters' bars in this order, the labels
    # move with them), c:idx unique (fixer round 3, VR-03)
    orders = [int(num(_cval(sr, "order"), -1)) for sr in sers]
    idxs = [int(num(_cval(sr, "idx"), -1)) for sr in sers]
    prob.expect(orders == list(range(len(sers))) and len(set(idxs)) == len(idxs) and min(idxs, default=0) >= 0, *where,
                eid, "chart-order", f"series c:order {orders} / c:idx {idxs} (expected order 0..{len(sers) - 1} in spec "
                "order, unique idx)")
    point_colors = spec.get("pointColors") or {}
    for si, (ser, s) in enumerate(zip(sers, used)):
        lab = f"series {si}"
        name = ser.find(f"{C}tx/{C}strRef/{C}strCache/{C}pt/{C}v")
        prob.expect(name is not None and name.text == str(s.get("name") or f"계열 {si + 1}"), *where, eid, "chart-data",
                    f"{lab}: name {name.text if name is not None else None!r} != {s.get('name')!r}")
        cpts = {int(p.get("idx")): p.findtext(C + "v") for p in ser.findall(f"{C}cat//{C}pt")}
        prob.expect([cpts.get(i) for i in range(len(cats))] == cats, *where, eid, "chart-data",
                    f"{lab}: categories {cpts} != {cats}")
        vpts = {int(p.get("idx")): num(p.findtext(C + "v"), None) for p in ser.findall(f"{C}val//{C}pt")}
        vals = (list(s.get("values") or []) + [None] * len(cats))[:len(cats)]
        want_v = [None if v is None else float(v) for v in vals]
        got_v = [vpts.get(i) for i in range(len(cats))]
        prob.expect(all((a is None and b is None) or (a is not None and b is not None and abs(a - b) <= 1e-9)
                        for a, b in zip(got_v, want_v)), *where, eid, "chart-data",
                    f"{lab}: cached values {got_v} != spec {want_v}")
        color = _norm_hex(s.get("color")) or CH.PALETTE[si % len(CH.PALETTE)]
        sppr = ser.find(C + "spPr")
        if gname == "lineChart":
            lnel = sppr.find(A + "ln") if sppr is not None else None
            ca = color_alpha(lnel.find(A + "solidFill")) if lnel is not None else None
            prob.expect(ca is not None and ca[0] == color and abs(int(lnel.get("w", -1)) - emu(CH.LINE_WIDTH_PX)) <= 1,
                        *where, eid, "chart-colour", f"{lab}: line {ca} w={lnel.get('w') if lnel is not None else None}"
                        f" != {color} {emu(CH.LINE_WIDTH_PX)}")
        elif not pie:
            ca = _sp_fill(sppr)
            prob.expect(ca is not None and ca[0] == color and ca[1] >= 0.999, *where, eid, "chart-colour",
                        f"{lab}: fill {ca} != {color}")
        pcs = list(point_colors.get(str(si)) or point_colors.get(si) or [])
        if pie:
            pcs = [(_norm_hex(pcs[i]) if i < len(pcs) else None) or CH.PALETTE[i % len(CH.PALETTE)]
                   for i in range(len(cats))]
        want_pts = {i: _norm_hex(c) for i, c in enumerate(pcs) if i < len(cats) and _norm_hex(c)}
        got_pts = {}
        for dpt in ser.findall(C + "dPt"):
            i = int(_cval(dpt, "idx", -1))
            sp_ = dpt.find(f"{C}marker/{C}spPr") if gname == "lineChart" else dpt.find(C + "spPr")
            ca = _sp_fill(sp_)
            got_pts[i] = ca[0] if ca else None
        prob.expect(got_pts == want_pts, *where, eid, "chart-colour", f"{lab}: point colours {got_pts} != {want_pts}")
    # ---- bar geometry / pie options
    if gname == "barChart":
        want_gap = max(0, min(500, int(round(num(spec.get("gapWidth"), CH.DEFAULT_GAP_WIDTH)))))
        want_ov = 100 if grouping == "stacked" else max(-100, min(100, int(round(num(spec.get("overlap"),
                                                                                     CH.DEFAULT_OVERLAP)))))
        prob.expect(int(num(_cval(grp, "gapWidth"), 150)) == want_gap and int(num(_cval(grp, "overlap"), 0)) == want_ov,
                    *where, eid, "chart-bars", f"gapWidth/overlap {_cval(grp, 'gapWidth')}/{_cval(grp, 'overlap')} "
                    f"!= {want_gap}/{want_ov}")
    if gname == "doughnutChart":
        want_h = max(1, min(90, int(round(num(spec.get("holeSize"), CH.DEFAULT_HOLE_SIZE)))))
        prob.expect(int(num(_cval(grp, "holeSize"), 50)) == want_h, *where, eid, "chart-bars",
                    f"holeSize {_cval(grp, 'holeSize')} != {want_h}")
    # ---- data labels
    dl = spec.get("dataLabels") or {}
    show = bool(dl.get("show"))
    font_w = spec.get("fontCssWeight") or 400
    dl_face = tm.face(dl.get("cssWeight") or font_w)
    base_face = tm.face(font_w)
    want_pos = CH.resolve_dlbl_pos(gname, _cval(grp, "grouping") if gname == "barChart" else None,
                                   dl.get("position")) if show else None
    for si, ser in enumerate(sers):
        lab = f"series {si} labels"
        sdl = ser.find(C + "dLbls")
        shown = sdl is not None and _cval(sdl, "showVal") == "1" and _cval(sdl, "delete") != "1"
        if not prob.expect(shown == show, *where, eid, "chart-labels", f"{lab}: shown={shown}, spec show={show}"):
            continue
        if not show:
            continue
        others_on = [k for k in ("showLegendKey", "showCatName", "showSerName", "showPercent", "showBubbleSize")
                     if _cval(sdl, k) == "1"]
        prob.expect(not others_on and not sdl.findall(C + "dLbl"), *where, eid, "chart-labels",
                    f"{lab}: extra label content {others_on} / per-point labels")
        prob.expect(_cval(sdl, "dLblPos") == want_pos, *where, eid, "chart-labels",
                    f"{lab}: dLblPos {_cval(sdl, 'dLblPos')} != {want_pos}")
        nf = sdl.find(C + "numFmt")
        want_nf = dl.get("numberFormat") or (spec.get("valueAxis") or {}).get("numberFormat") or "General"
        prob.expect(nf is not None and nf.get("formatCode") == want_nf, *where, eid, "chart-labels",
                    f"{lab}: numFmt {nf.get('formatCode') if nf is not None else None!r} != {want_nf!r}")
        d = _def_rpr(sdl.find(C + "txPr"))
        want_sz = max(100, round((num(dl.get("sizePx")) or CH.DEFAULT_SIZE_PX) * 75))
        want_c = _norm_hex(dl.get("color")) or CH.TEXT_COLOR
        ok = d is not None and int(num(d.get("sz"), -1)) == want_sz and truthy(d.get("b")) == bool(dl_face.bold) \
            and (color_alpha(d.find(A + "solidFill")) or (None,))[0] == want_c \
            and {d.find(A + s).get("typeface") if d.find(A + s) is not None else None
                 for s in ("latin", "ea", "cs")} == {dl_face.typeface}
        prob.expect(ok, *where, eid, "chart-labels", f"{lab}: text {dict(d.attrib) if d is not None else None} != sz "
                    f"{want_sz} {want_c} {dl_face.typeface}/{'b' if dl_face.bold else 'r'}")
    gdl = grp.find(C + "dLbls")
    if gdl is not None:
        prob.expect(all(_cval(gdl, k) != "1" for k in ("showLegendKey", "showVal", "showCatName", "showSerName",
                                                        "showPercent", "showBubbleSize")),
                    *where, eid, "chart-labels", "group-level dLbls turn labels on for every series")
    # ---- axes
    va, ca_ = spec.get("valueAxis") or {}, spec.get("categoryAxis") or {}
    if gname in ("barChart", "lineChart"):
        vax, cax = plot.find(C + "valAx"), plot.find(C + "catAx")
        if prob.expect(vax is not None and cax is not None, *where, eid, "chart-axes", "missing value/category axis"):
            vmin = res.get("valueMin") if res.get("valueMin") is not None else va.get("min")
            vmax = res.get("valueMax") if res.get("valueMax") is not None else va.get("max")
            major = res.get("majorUnit")
            sc = vax.find(C + "scaling")
            got = (num(_cval(sc, "min"), None), num(_cval(sc, "max"), None), num(_cval(vax, "majorUnit"), None))
            want = (None if vmin is None else float(vmin), None if vmax is None else float(vmax),
                    None if major is None else float(major))
            prob.expect(all((g_ is None and w_ is None) or (g_ is not None and w_ is not None and abs(g_ - w_) <= 1e-9)
                            for g_, w_ in zip(got, want)), *where, eid, "chart-scale",
                        f"value axis min/max/majorUnit {got} != resolved {want}")
            prob.expect(_cval(vax, "delete", "0") == "0" and _cval(cax, "delete", "0") == "0", *where, eid,
                        "chart-axes", "an axis is deleted (the scale / labels change)")
            # axis direction (fixer round 3, VR-03): values grow upward / rightward (minMax: maxMin would hang the bars
            # from the top); categories in spec order — reversed (maxMin) only for horizontal bars, whose first
            # category is drawn on top like the HTML
            want_cat = "maxMin" if t == "bar" else "minMax"
            got_o = (_cval(vax.find(C + "scaling"), "orientation", "minMax"),
                     _cval(cax.find(C + "scaling"), "orientation", "minMax"))
            prob.expect(got_o == ("minMax", want_cat), *where, eid, "chart-axes",
                        f"axis orientation value/category {got_o} != ('minMax', {want_cat!r})")
            prob.expect(_cval(vax, "tickLblPos") == ("nextTo" if va.get("visible", False) else "none"), *where, eid,
                        "chart-axes", f"value labels tickLblPos {_cval(vax, 'tickLblPos')}")
            gl = va.get("gridlines")
            mg = vax.find(C + "majorGridlines")
            if gl:
                gl = gl if isinstance(gl, dict) else {}
                lnel = mg.find(f"{C}spPr/{A}ln") if mg is not None else None
                cc = color_alpha(lnel.find(A + "solidFill")) if lnel is not None else None
                want_gc = _norm_hex(gl.get("color")) or CH.GRID_COLOR
                prob.expect(cc is not None and cc[0] == want_gc and abs(int(lnel.get("w", -1))
                                                                        - emu(num(gl.get("widthPx")) or 1)) <= 1,
                            *where, eid, "chart-axes", f"gridlines {cc} != {want_gc}")
            else:
                prob.expect(mg is None and vax.find(C + "minorGridlines") is None, *where, eid, "chart-axes",
                            "gridlines drawn but the spec has none")
            cat_vis = ca_.get("visible", True)
            want_tlp = "none" if not cat_vis else ("low" if vmin is not None and float(vmin) < 0 else "nextTo")
            prob.expect(_cval(cax, "tickLblPos") == want_tlp, *where, eid, "chart-axes",
                        f"category labels tickLblPos {_cval(cax, 'tickLblPos')} != {want_tlp}")
            lnel = cax.find(f"{C}spPr/{A}ln")
            line_c = _norm_hex(ca_.get("lineColor"))
            if line_c and cat_vis:
                cc = color_alpha(lnel.find(A + "solidFill")) if lnel is not None else None
                prob.expect(cc is not None and cc[0] == line_c and abs(int(lnel.get("w", -1)) - 9525) <= 1, *where,
                            eid, "chart-axes", f"category axis line {cc} != {line_c} 1 px")
            else:
                prob.expect(lnel is None or lnel.find(A + "noFill") is not None, *where, eid, "chart-axes",
                            "category axis line drawn but the spec has none")
            if cat_vis:
                d = _def_rpr(cax.find(C + "txPr"))
                want_sz = max(100, round((num(ca_.get("sizePx")) or CH.DEFAULT_SIZE_PX) * 75))
                want_c = _norm_hex(ca_.get("labelColor")) or CH.TEXT_COLOR
                ok = d is not None and int(num(d.get("sz"), -1)) == want_sz \
                    and truthy(d.get("b")) == bool(base_face.bold) \
                    and (color_alpha(d.find(A + "solidFill")) or (None,))[0] == want_c \
                    and {d.find(A + s).get("typeface") if d.find(A + s) is not None else None
                         for s in ("latin", "ea", "cs")} == {base_face.typeface}
                prob.expect(ok, *where, eid, "chart-axes", f"category labels {dict(d.attrib) if d is not None else None}"
                            f" != sz {want_sz} {want_c} {base_face.typeface}")
    # ---- plot area layout = resolved.plotPx
    plot_px = res.get("plotPx")
    ml = plot.find(f"{C}layout/{C}manualLayout")
    if plot_px:
        b = e.get("box") or {}
        W, H = num(b.get("w")), num(b.get("h"))
        want = {"x": (num(plot_px.get("x")) - num(b.get("x"))) / W, "y": (num(plot_px.get("y")) - num(b.get("y"))) / H,
                "w": num(plot_px.get("w")) / W, "h": num(plot_px.get("h")) / H}
        got = {k: num(_cval(ml, k), None) for k in "xywh"} if ml is not None else {}
        ok = ml is not None and _cval(ml, "layoutTarget") == "inner" and _cval(ml, "xMode") == "edge" \
            and _cval(ml, "yMode") == "edge" and all(got.get(k) is not None and abs(got[k] - v) <= 1e-4
                                                     for k, v in want.items())
        prob.expect(ok, *where, eid, "chart-layout", f"plot manualLayout {got} != resolved plotPx {want}")
    # ---- legend, title
    pos = (spec.get("legend") or {}).get("position") or "none"
    leg = chart.find(C + "legend")
    if pos == "none":
        prob.expect(leg is None, *where, eid, "chart-legend", "a native legend is drawn but the spec has none")
    else:
        prob.expect(leg is not None and _cval(leg, "legendPos") == {"top": "t", "bottom": "b", "right": "r"}.get(pos),
                    *where, eid, "chart-legend", f"legend {_cval(leg, 'legendPos') if leg is not None else None} != {pos}")
    prob.expect(chart.find(C + "title") is None and _cval(chart, "autoTitleDeleted") == "1", *where, eid, "chart-title",
                "the chart shows a title (the HTML has none)")
    if gname in ("barChart", "lineChart"):          # a value typed above the locked c:max keeps its label (EDIT-04)
        prob.expect(_cval(chart, "showDLblsOverMax") == "1", *where, eid, "chart-labels",
                    f"showDLblsOverMax {_cval(chart, 'showDLblsOverMax')!r}: a value above the fixed axis maximum would "
                    "lose its data label")
    descr = (cnv_of(gf).get("descr") or "").strip() if cnv_of(gf) is not None else ""
    prob.expect(bool(descr), *where, eid, "alt", "chart frame without alt text (cNvPr@descr)")


# ---------------------------------------------------------------------------------------------- groups, backgrounds
def _decorative(node) -> bool:
    c = cnv_of(node)
    d = c.find(f".//{{{NS['adec']}}}decorative") if c is not None else None
    return c is not None and not (c.get("descr") or "").strip() and d is not None and d.get("val") in ("1", "true")


def check_group(prob, where, node):
    leaves = [d for d in walk(node) if d.tag != P + "grpSp"]
    if leaves and all(_decorative(d) for d in leaves):  # EDIT-08: a group of decorative shapes is decorative too
        prob.expect(_decorative(node), *where, None, "alt", f"group {cnv_of(node).get('name')!r}: every member is "
                    "decorative but the group is not marked decorative (Accessibility Checker: missing alt text)")
    x = xfrm_of(node)
    off, ext, cho, che = (x.find(A + t) for t in ("off", "ext", "chOff", "chExt"))
    name = cnv_of(node).get("name")
    ok = None not in (off, ext, cho, che) and off.get("x") == cho.get("x") and off.get("y") == cho.get("y") \
        and ext.get("cx") == che.get("cx") and ext.get("cy") == che.get("cy")
    prob.expect(ok, *where, None, "group", f"group {name!r}: child transform is not the identity")
    gx, gy, gw, gh, _ = box_of(node)
    for c in node:
        if not (isinstance(c.tag, str) and c.tag in SHAPES):
            continue
        cx, cy, cw, ch, crot = box_of(c)
        if crot:
            continue
        inside = cx >= gx - 1e-3 and cy >= gy - 1e-3 and cx + cw <= gx + gw + 1e-3 and cy + ch <= gy + gh + 1e-3
        prob.expect(inside, *where, None, "group", f"group {name!r}: child {cnv_of(c).get('name')!r} outside its box")


def effective_background(deck: Deck, slide_part: str):
    for part in (slide_part, deck.related(slide_part, "/slideLayout")):
        if part is None:
            continue
        bg = deck.xml(part).find(f"{P}cSld/{P}bg/{P}bgPr")
        if bg is not None:
            return part, fill_of(bg)
        lay = part
    mst = deck.related(lay, "/slideMaster") if lay else None
    if mst:
        bg = deck.xml(mst).find(f"{P}cSld/{P}bg/{P}bgPr")
        if bg is not None:
            return mst, fill_of(bg)
    return None, None


def background_mismatch(f, want) -> str | None:
    """Why a written background fill (bgPr child) is not the IR background (composited over white), or None. A linear
    gradient is compared stop by stop (positions, colours; the builder's clip/transparent-stop handling aside) and by its
    angle (lin ang = CSS angle - 90, fixer round 3: the cover's own background gradient was compared by its end colours
    only)."""
    if not isinstance(want, dict):
        want = {"type": "solid", "color": "FFFFFF", "alpha": 1.0}
    if want.get("type") == "solid":
        wc = over_white(str(want.get("color")).upper(), num(want.get("alpha"), 1.0))
        ca = color_alpha(f) if f is not None and ln(f) == "solidFill" else None
        return None if ca is not None and ca[0] == wc and ca[1] >= 0.999 else f"{ca} != {wc}"
    if f is None or ln(f) != "gradFill":
        return f"{ln(f) if f is not None else None} is not a gradient"
    stops = sorted((q for q in want.get("stops") or [] if isinstance(q, dict)), key=lambda q: num(q.get("pos")))
    gs = f.findall(f"{A}gsLst/{A}gs")
    got = [(int(g.get("pos", -1)), (color_alpha(g) or (None,))[0]) for g in gs]
    wantc = [(int(round(num(q.get("pos")) * 100000)), over_white(str(q.get("color")).upper(), num(q.get("alpha"), 1.0)))
             for q in stops]
    simple = stops and all(0 <= num(q.get("pos")) <= 1 and num(q.get("alpha"), 1.0) >= 0.999 for q in stops) \
        and num(stops[0].get("pos")) == 0 and num(stops[-1].get("pos")) == 1
    if simple and got != wantc:
        return f"stops {got} != IR {wantc}"
    if not simple and (len(gs) < 2 or got[0][1] != wantc[0][1] or got[-1][1] != wantc[-1][1]):
        return f"end stops {got[:1] + got[-1:]} != IR {wantc[:1] + wantc[-1:]}"
    lin = f.find(A + "lin")
    want_ang = int(round(((num(want.get("angleDeg"), 180) - 90) % 360) * 60000)) % 21600000
    if lin is None or abs(int(num(lin.get("ang"), -1)) - want_ang) > 1:
        return f"angle {lin.get('ang') if lin is not None else None} != {want_ang} (CSS {want.get('angleDeg')} deg)"
    return None


def check_background(prob, deck, where, s, slide_part):
    want = s.get("background")
    part, f = effective_background(deck, slide_part)
    if fill_is_dark(want, need_opaque=False):     # light text on it: the slide keeps its own copy (EDIT-05)
        prob.expect(part == slide_part, *where, None, "background-pin",
                    f"dark background inherited from {part}: moved onto another template the slide would lose it and "
                    "its light text (the slide must carry its own p:bg)")
    why = background_mismatch(f, want)
    prob.expect(why is None, *where, None, "background", f"effective background ({part}) is not the IR's: {why}")
    lay = deck.related(slide_part, "/slideLayout")
    if part == slide_part and lay in deck.names and fill_is_dark(want, need_opaque=False):
        # a pinned copy: the layout (what New Slide gives) must carry the same background
        bg = deck.xml(lay).find(f"{P}cSld/{P}bg/{P}bgPr")
        why = background_mismatch(fill_of(bg) if bg is not None else None, want)
        prob.expect(why is None, *where, None, "background", f"layout {lay} background differs from its pinned copy on "
                    f"the slide: {why}")


# ---------------------------------------------------------------------------------------------- paint order
def ir_extent(e: dict) -> tuple[float, float, float, float]:
    """Painted extent (px) of an IR element: its box, text lines, shadow; +1 px (the lift rule's own measure)."""
    b = e.get("box") or {}
    x0, y0 = num(b.get("x")), num(b.get("y"))
    x1, y1 = x0 + num(b.get("w")), y0 + num(b.get("h"))
    for L in e.get("lines") or []:
        if not isinstance(L, dict):
            continue
        if L.get("left") is not None:
            x0, x1 = min(x0, num(L.get("left"))), max(x1, num(L.get("right")))
        y0, y1 = min(y0, num(L.get("top"), y0)), max(y1, num(L.get("bottom"), y1))
    sh = e.get("shadow")
    if isinstance(sh, dict):
        blur = abs(num(sh.get("blurPx"))) + abs(num(sh.get("spreadPx")))
        dx, dy = num(sh.get("offsetXPx")), num(sh.get("offsetYPx"))
        x0, x1 = min(x0, x0 + dx - blur), max(x1, x1 + dx + blur)
        y0, y1 = min(y0, y0 + dy - blur), max(y1, y1 + dy + blur)
    return x0 - 1, y0 - 1, x1 + 1, y1 + 1


def _overlap(a, b) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def paint_sequence(deck, q, idx):
    """Mapped objects of part `q` in PowerPoint's paint order (groups descended): [(name, lo, hi, ir ids)] where
    lo/hi = the smallest/largest IR paint index the object stands for (a table with its absorbed background: two)."""
    irs_of = {}
    for o in q.get("objects") or []:
        if o.get("kind") in ("group", "placeholder", "overlay") or not o.get("ir"):
            continue
        irs_of.setdefault(o.get("shapeId"), set()).add(o["ir"])
    tree = deck.xml(q["part"]).find(f"{P}cSld/{P}spTree")
    out = []
    for n in walk(tree):
        if n.tag == P + "grpSp":
            continue
        c = cnv_of(n)
        sid = int(c.get("id")) if c is not None and (c.get("id") or "").isdigit() else None
        ks = sorted(idx[i] for i in irs_of.get(sid, ()) if i in idx)
        if ks:
            out.append((c.get("name"), ks[0], ks[-1], irs_of[sid]))
    return out


def check_paint_order(prob, deck, s, sp_q, lp_q, elements):
    """Slide objects in IR paint order; layout chrome (drawn before every slide object) only over what it may cover."""
    sno = s.get("index")
    idx = {e.get("id"): k for k, e in enumerate(elements)}
    seq = paint_sequence(deck, sp_q, idx)
    for (n0, lo0, hi0, _), (n1, lo1, hi1, _) in zip(seq, seq[1:]):
        prob.expect(lo1 >= hi0, sno, sp_q["part"], None, "paint-order",
                    f"{n1!r} (IR #{lo1}) is drawn after {n0!r} (IR #{hi0}): the HTML paints it first")
    if lp_q is None:
        return
    lay = [t for t in paint_sequence(deck, lp_q, idx)]
    for (n0, lo0, hi0, _), (n1, lo1, hi1, _) in zip(lay, lay[1:]):
        prob.expect(lo1 >= hi0, sno, lp_q["part"], None, "paint-order",
                    f"layout: {n1!r} (IR #{lo1}) is drawn after {n0!r} (IR #{hi0})")
    for name, lo, hi, irs in lay:
        ext = [ir_extent(elements[idx[i]]) for i in irs if i in idx]
        for n1, lo1, hi1, irs1 in seq:
            if hi1 >= lo:
                continue                          # painted after the chrome in the HTML too
            ext1 = [ir_extent(elements[idx[i]]) for i in irs1 if i in idx]
            if not prob.expect(not any(_overlap(a, b) for a in ext for b in ext1), sno, lp_q["part"], None,
                               "paint-order", f"layout {name!r} (IR #{lo}) is drawn under slide object {n1!r} "
                               f"(IR #{hi1}), which the HTML paints first and which overlaps it"):
                break


# ---------------------------------------------------------------------------------------------- placeholders, overlay
def ph_list(root) -> list[tuple[str, int, str]]:
    """(type, idx, name) of every placeholder of a slide / layout part (type default "obj", idx default 0)."""
    out = []
    for sp in root.iter(P + "sp"):
        ph = sp.find(f"{P}nvSpPr/{P}nvPr/{P}ph")
        if ph is not None:
            c = cnv_of(sp)
            out.append((ph.get("type", "obj"), int(num(ph.get("idx"), 0)), c.get("name") if c is not None else "?"))
    return out


def check_placeholders(prob, deck, parts) -> None:
    """[MS-OI29500] 2.1.1127 (fixer round 3, VO-01 / VR-01): no two placeholders of a slide or layout share an idx, and
    every slide placeholder inherits from the layout placeholder with the SAME idx — which must be of its type (a
    ctrTitle resolving to the subtitle prompt would move a reset title into the subtitle's box and style)."""
    for part, q in parts.items():
        if part not in deck.names:
            continue
        phs = ph_list(deck.xml(part))
        idxs = [i for _, i, _ in phs]
        dup = sorted({i for i in idxs if idxs.count(i) > 1})
        prob.expect(not dup, q.get("slide"), part, None, "placeholder-idx",
                    f"placeholders share idx {dup}: {[(t, i, n) for t, i, n in phs if i in dup]}")
        if q.get("kind") != "slide":
            continue
        lay = deck.related(part, "/slideLayout")
        lphs = {}
        for t, i, _ in (ph_list(deck.xml(lay)) if lay in deck.names else []):
            lphs.setdefault(i, t)
        for t, i, name in phs:
            prob.expect(lphs.get(i) == t, q.get("slide"), part, None, "placeholder-link",
                        f"slide placeholder {name!r} ({t}, idx {i}) links to layout placeholder {lphs.get(i)!r} "
                        f"(same idx) in {lay}")


def check_overlay(prob, deck, s, q) -> None:
    """The converter writes no overlay picture (the PoC's review deck is not shipped): a map record of one fails
    (a stray, unmapped overlay picture already fails "unmapped")."""
    sno, part = s.get("index"), q["part"]
    ovs = [o for o in q.get("objects") or [] if o.get("kind") == "overlay"]
    prob.expect(not ovs, sno, part, None, "overlay", f"{len(ovs)} overlay picture(s) in the deck")


def check_element(prob, tm, deck, where, q0, e, kind, nodes, objs, node_of, elements, sno, in_layout, tol) -> None:
    """One IR element vs its mapped PPTX object(s)."""
    if kind == "shape":
        if "table-bg" in nodes:
            return                                  # checked with its table (cell fills + tblPr shadow)
        check_shape(prob, where, e, nodes, tol)
    elif kind == "text":
        n = nodes.get("main")
        if n is not None:
            check_text(prob, tm, where, e, n, sno, in_layout, tol)
    elif kind == "image":
        n = nodes.get("main")
        if n is not None:
            check_image(prob, deck, q0["part"], where, e, n, tol)
    elif kind == "table":
        n = nodes.get("main")
        bg = None
        for e2 in elements:
            if any(o.get("role") == "table-bg" for _, o in objs.get(e2.get("id"), [])):
                if any(node_of.get((q.get("part"), o.get("shapeId"))) is n for q, o in objs.get(e2.get("id"), [])):
                    bg = e2
        if n is not None:
            check_table(prob, tm, where, e, n, bg, tol, sno)
    elif kind == "chart":
        n = nodes.get("main")
        if n is not None:
            check_frame(prob, where, e, n, tol, "chart")
            check_chart(prob, tm, deck, q0["part"], where, e, n)


# ---------------------------------------------------------------------------------------------- template state
LAYOUT_PROMPTS = {"title": "제목을 입력하세요", "ctrTitle": "제목을 입력하세요", "subTitle": "부제목을 입력하세요"}


def _canon(el, drop=()) -> str:
    """Attribute + child XML of an element, namespace prefixes and dropped attributes aside (comparison key)."""
    if el is None:
        return "None"
    c = etree.fromstring(etree.tostring(el))
    for k in drop:
        c.attrib.pop(k, None)
    c.tag = "x"
    return etree.tostring(c, method="c14n").decode()


def check_layout_prompts(prob, deck, parts) -> None:
    """What PowerPoint gives a NEW slide / Home > Reset (fixer round 3, VR-06): every layout prompt placeholder equals
    the slide placeholder it was made from (the family's first slide with that type) — same type / idx, position and
    width (height >= the slide's), bodyPr (wrap square, normAutofit without a stored shrink), paragraph style (algn,
    indents, line breaking, lnSpc / spcBef / spcAft) and run style (size, bold, colour, typefaces, spacing) as
    lstStyle lvl1pPr / defRPr — and shows PowerPoint's Korean custom prompt."""
    for lpart, q in parts.items():
        if q.get("kind") != "layout" or lpart not in deck.names:
            continue
        slides = [s for s in (q.get("slides") or [])]
        lroot = deck.xml(lpart)
        for o in q.get("objects") or []:
            if o.get("kind") != "placeholder":
                continue
            t = o.get("ph")
            lsp = next((sp for sp in lroot.iter(P + "sp") if cnv_of(sp) is not None
                        and cnv_of(sp).get("id") == str(o.get("shapeId"))), None)
            src = None
            for sno in slides:
                sq = next((x for x in parts.values() if x.get("kind") == "slide" and x.get("slide") == sno), None)
                if sq is None:
                    continue
                for sp in deck.xml(sq["part"]).iter(P + "sp"):
                    ph = sp.find(f"{P}nvSpPr/{P}nvPr/{P}ph")
                    if ph is not None and ph.get("type") == t:
                        src = sp
                        break
                if src is not None:
                    break
            if not prob.expect(lsp is not None and src is not None, None, lpart, None, "layout-prompt",
                               f"layout prompt {t!r}: placeholder or its source slide placeholder not found"):
                continue
            lph, sph = (x.find(f"{P}nvSpPr/{P}nvPr/{P}ph") for x in (lsp, src))
            bad = []
            if (lph.get("type"), lph.get("idx")) != (sph.get("type"), sph.get("idx")):
                bad.append(f"type/idx {(lph.get('type'), lph.get('idx'))} != slide {(sph.get('type'), sph.get('idx'))}")
            if lph.get("hasCustomPrompt") not in ("1", "true"):
                bad.append("no hasCustomPrompt")
            lx, ly, lw, lh, lr = box_of(lsp)
            sx, sy, sw, sh, sr = box_of(src)
            if max(abs(lx - sx), abs(ly - sy), abs(lw - sw)) > 1e-6 or lh < sh - 1e-6 or lr != sr:
                bad.append(f"box ({lx:.2f},{ly:.2f} {lw:.2f}x{lh:.2f}) != slide ({sx:.2f},{sy:.2f} {sw:.2f}x{sh:.2f})")
            lb, sb = (x.find(f"{P}txBody/{A}bodyPr") for x in (lsp, src))
            if _canon(lb, ("wrap",)) != _canon(sb, ("wrap",)) and not (
                    sb.find(A + "noAutofit") is not None and lb.find(A + "normAutofit") is not None):
                bad.append("bodyPr differs from the slide placeholder's")
            fits = [ln(c) for c in lb if ln(c) in AUTOFIT]
            naf = lb.find(A + "normAutofit")
            if lb.get("wrap") != "square" or fits != ["normAutofit"] or naf.get("fontScale") or naf.get("lnSpcReduction"):
                bad.append(f"bodyPr wrap={lb.get('wrap')} autofit {fits} (expected square + normAutofit)")
            lvl = lsp.find(f"{P}txBody/{A}lstStyle/{A}lvl1pPr")
            sp0 = src.find(f"{P}txBody/{A}p")
            sppr = sp0.find(A + "pPr") if sp0 is not None else None
            srpr = sp0.find(f"{A}r/{A}rPr") if sp0 is not None else None
            if lvl is None or sppr is None or srpr is None:
                bad.append("no lstStyle lvl1pPr / slide paragraph to compare")
            else:
                for k in ("algn", "marL", "indent", "eaLnBrk", "latinLnBrk", "hangingPunct"):
                    if lvl.get(k) != sppr.get(k):
                        bad.append(f"lvl1pPr {k}={lvl.get(k)!r} != slide {sppr.get(k)!r}")
                for tag in ("lnSpc", "spcBef", "spcAft"):
                    if _canon(lvl.find(A + tag)) != _canon(sppr.find(A + tag)):
                        bad.append(f"lvl1pPr {tag} differs")
                if _canon(lvl.find(A + "defRPr"), ("lang", "altLang", "dirty", "baseline")) != \
                        _canon(srpr, ("lang", "altLang", "dirty", "baseline")):
                    bad.append(f"defRPr {_canon(lvl.find(A + 'defRPr'))[:80]} != slide run {_canon(srpr)[:80]}")
            prompt = "".join(lsp.find(P + "txBody").itertext()).strip()
            if prompt != LAYOUT_PROMPTS.get(t):
                bad.append(f"prompt {prompt!r}")
            prob.expect(not bad, None, lpart, None, "layout-prompt", f"layout prompt {t!r}: {bad[:3]}")


def check_template_residue(prob, deck) -> None:
    """python-pptx template state the builder replaces (fixer round 3): the master carries no stock date / footer /
    slide-number placeholders (the deck's footer is layout artwork; "Footers" in Slide Master view would copy them over
    it, EDIT-07), its Korean prompts are proofed as Korean (VO-05), and the view guides sit on the slide's centre lines
    (VO-04: pos in 1/576 inch)."""
    masters = sorted(n for n in deck.names if n.startswith("ppt/slideMasters/slideMaster") and n.endswith(".xml"))
    for mst in masters:
        root = deck.xml(mst)
        stock = [t for t, _, _ in ph_list(root) if t in ("dt", "ftr", "sldNum")]
        prob.expect(not stock, None, mst, None, "template", f"master keeps the template's {stock} placeholders")
        bad = []
        for t in root.iter(A + "t"):
            if t.text and any("가" <= ch <= "힣" for ch in t.text):
                rpr = t.getparent().find(A + "rPr")
                if rpr is None or rpr.get("lang") != "ko-KR":
                    bad.append(f"{t.text!r} lang={rpr.get('lang') if rpr is not None else None}")
        prob.expect(not bad, None, mst, None, "template", f"Korean master prompts proofed as another language: {bad[:3]}")
    vp = "ppt/viewProps.xml"
    if vp in deck.names and "ppt/presentation.xml" in deck.names:
        sz = deck.xml("ppt/presentation.xml").find(P + "sldSz")
        want = {"vert": round(int(sz.get("cx")) / 914400 * 576 / 2), "horz": round(int(sz.get("cy")) / 914400 * 576 / 2)}
        got = [(g.get("orient", "vert"), int(num(g.get("pos"), -1))) for g in deck.xml(vp).iter(P + "guide")]
        prob.expect(all(pos == want[o] for o, pos in got), None, vp, None, "template",
                    f"view guides {got} not on the slide's centre lines {want}")


def check_theme(prob, deck, ir, tm) -> None:
    """Theme = the deck (fixer round 3, VR-06; CONTRACT v2 "Theme majorFont/minorFont latin/ea/cs = the profile's
    regular typeface", J1-07 "clrScheme = the deck palette"): what New Slide, a new text box or an inserted shape /
    chart takes from the deck."""
    masters = sorted(n for n in deck.names if n.startswith("ppt/slideMasters/slideMaster") and n.endswith(".xml"))
    colors = (ir.get("theme") or {}).get("colors") or {}
    regular = tm.prof.regular.typeface
    for mst in masters:
        th = deck.related(mst, "/theme")
        if not prob.expect(th in deck.names, None, mst, None, "theme", f"{mst}: no theme part"):
            continue
        root = deck.xml(th)
        cs = root.find(f"{A}themeElements/{A}clrScheme")
        bad = []
        for slot, want in colors.items():
            got = cs.find(f"{A}{slot}/{A}srgbClr") if cs is not None else None
            if got is None or got.get("val", "").upper() != str(want).upper():
                bad.append(f"{slot} {got.get('val') if got is not None else None} != {want}")
        prob.expect(not bad, None, th, None, "theme-colors", f"clrScheme vs IR theme.colors: {bad[:4]}")
        bad = []
        for which in ("majorFont", "minorFont"):
            f = root.find(f"{A}themeElements/{A}fontScheme/{A}{which}")
            for slot in ("latin", "ea", "cs"):
                e_ = f.find(A + slot) if f is not None else None
                if e_ is None or e_.get("typeface") != regular:
                    bad.append(f"{which} {slot} {e_.get('typeface') if e_ is not None else None!r}")
            hang = [x.get("typeface") for x in (f.findall(A + "font") if f is not None else []) if x.get("script") == "Hang"]
            if hang and hang != [regular]:
                bad.append(f"{which} Hang {hang}")
        prob.expect(not bad, None, th, None, "theme-fonts", f"theme fonts != the profile's regular typeface {regular!r}: "
                    f"{bad[:4]}")


# ============================================================================================== structure gate
def structure(args) -> dict:
    global IR_DIR
    prob = Problems()
    IR_DIR = Path(args.ir).resolve().parent
    pptx = Path(args.pptx)
    mp = Path(args.map) if args.map else pptx.with_suffix(".map.json")
    for f in (pptx, Path(args.ir), mp):
        if not f.is_file():
            raise SystemExit(f"check_fidelity: {f} not found")
    ir = json.loads(Path(args.ir).read_text(encoding="utf-8"))
    m = json.loads(mp.read_text(encoding="utf-8"))
    deck = Deck(pptx)
    tm = TextModel(args.profile)
    tol = args.tol
    parts = {q["part"]: q for q in m.get("parts") or []}
    # map integrity: every mapped id exists, every object of a mapped part is mapped; nothing hidden or flipped
    node_of = {}
    for part, q in parts.items():
        if part not in deck.names:
            prob.add(None, part, None, "map", f"map part {part} is not in the deck")
            continue
        tree = deck.xml(part).find(f"{P}cSld/{P}spTree")
        nodes = walk(tree)
        by_id = {}
        for n in nodes:
            c = cnv_of(n)
            if c is not None and (c.get("id") or "").isdigit():
                by_id[int(c.get("id"))] = n
        mapped = set()
        for o in q.get("objects") or []:
            n = by_id.get(o.get("shapeId"))
            prob.expect(n is not None, q.get("slide"), part, None, "map",
                        f"object {o.get('shapeId')} ({o.get('name')!r}) missing from {part}")
            if n is not None:
                node_of[(part, o.get("shapeId"))] = n
                mapped.add(o.get("shapeId"))
        for sid, n in by_id.items():
            prob.expect(sid in mapped, q.get("slide"), part, None, "unmapped",
                        f"{part}: object {sid} {cnv_of(n).get('name')!r} has no IR source in the map")
        for n in nodes:
            c = cnv_of(n)
            name = c.get("name") if c is not None else None
            prob.expect(c is None or not truthy(c.get("hidden")), q.get("slide"), part, None, "hidden",
                        f"{part}: object {name!r} is hidden (cNvPr@hidden)")
            xf = xfrm_of(n)
            prob.expect(xf is None or not (truthy(xf.get("flipH")) or truthy(xf.get("flipV"))), q.get("slide"), part,
                        None, "flip", f"{part}: object {name!r} is flipped (the HTML has no flips)")
            if n.tag == P + "grpSp":
                try:
                    check_group(prob, (q.get("slide"), part), n)
                except NoGeometry as exc:
                    prob.add(q.get("slide"), part, None, "geometry", str(exc))
    check_placeholders(prob, deck, parts)
    try:
        check_layout_prompts(prob, deck, parts)
    except NoGeometry as exc:
        prob.add(None, None, None, "geometry", str(exc))
    check_theme(prob, deck, ir, tm)
    check_template_residue(prob, deck)
    slides = sorted((s for s in ir.get("slides") or [] if isinstance(s, dict)), key=lambda s: s.get("index", 0))
    for s in slides:
        sno = s.get("index")
        sp = next((q for q in parts.values() if q["kind"] == "slide" and q.get("slide") == sno), None)
        if not prob.expect(sp is not None, sno, None, None, "map", f"slide {sno} is not in the map"):
            continue
        lp = parts.get(sp.get("layoutPart"))
        check_background(prob, deck, (sno, sp["part"]), s, sp["part"])
        show = deck.xml(sp["part"]).get("show", "1")
        prob.expect(show not in ("0", "false"), sno, sp["part"], None, "hidden",
                    f"p:sld show={show}: the slide is skipped in the slide show (VR-05)")
        try:
            check_overlay(prob, deck, s, sp)
        except NoGeometry as exc:
            prob.add(sno, sp["part"], None, "geometry", str(exc))
        objs = {}
        for q in (sp, lp):
            if q is None:
                continue
            for o in q.get("objects") or []:
                if o.get("ir") and o.get("kind") != "group":
                    objs.setdefault(o["ir"], []).append((q, o))
        elements = [e for e in s.get("elements") or [] if isinstance(e, dict)]
        check_paint_order(prob, deck, s, sp, lp, elements)
        if lp is not None:                           # this slide's chrome lives in its layout: it must be shown
            ids = {e.get("id") for e in elements}
            lifted = [o for o in lp.get("objects") or [] if o.get("ir") in ids and o.get("kind") != "group"]
            show = deck.xml(sp["part"]).get("showMasterSp", "1")
            prob.expect(not lifted or show not in ("0", "false"), sno, sp["part"], None, "layout-chrome",
                        f"showMasterSp={show}: the {len(lifted)} layout object(s) of this slide (footer, page number…) "
                        "are not drawn")
        for e in elements:
            eid, kind = e.get("id"), e.get("kind")
            found = objs.get(eid, [])
            if not prob.expect(bool(found), sno, sp["part"], eid, "missing", f"IR {kind} has no PPTX object"):
                continue
            q0 = found[0][0]
            in_layout = q0 is lp
            where = (sno, q0["part"])
            nodes = {o.get("role"): node_of.get((q.get("part"), o.get("shapeId"))) for q, o in found}
            if not prob.expect(any(v is not None for v in nodes.values()), *where, eid, "missing",
                               f"IR {kind}: its mapped object is not in {q0['part']}"):
                continue
            try:
                check_element(prob, tm, deck, where, q0, e, kind, nodes, objs, node_of, elements, sno, in_layout, tol)
            except NoGeometry as exc:
                prob.add(*where, eid, "geometry", str(exc))
    if "docProps/app.xml" in deck.names:                # docProps must agree: no hidden slide (VR-05)
        hs = deck.xml("docProps/app.xml").find("{http://schemas.openxmlformats.org/officeDocument/2006/extended-properties}HiddenSlides")
        prob.expect(hs is None or int(num(hs.text, 0)) == 0, None, "docProps/app.xml", None, "hidden",
                    f"app.xml HiddenSlides={hs.text if hs is not None else None}")
    n_err = len(prob.items)
    return {"tool": "tools/check_fidelity.py structure", "pptx": str(pptx), "ir": args.ir, "map": str(mp),
            "checks": prob.checked, "problems": prob.items, "verdict": "PASS" if not n_err else "FAIL"}


# ============================================================================================== CLI
def main(argv=None) -> int:
    pdeathsig.arm()
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    a1 = sub.add_parser("structure", help="IR <-> PPTX object cross-check (geometry, colour, text, structure)")
    a1.add_argument("pptx")
    a1.add_argument("--ir", required=True)
    a1.add_argument("--profile", required=True, choices=["embedded", "malgun"])
    a1.add_argument("--map", help="default: <pptx without .pptx>.map.json")
    a1.add_argument("--tol", type=float, default=0.02, help="geometry tolerance in px (default 0.02)")
    a1.add_argument("--json", help="write the report here")
    args = ap.parse_args(argv)
    rep = structure(args)
    if args.json:
        Path(args.json).parent.mkdir(parents=True, exist_ok=True)
        Path(args.json).write_text(json.dumps(rep, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    probs = rep["problems"]
    for p in probs[:40]:
        print(f"  FAIL slide {p['slide']} [{p['check']}] {str(p.get('ir') or '')[-60:]}: {p['message']}")
    print(f"check_fidelity: structure {rep['verdict']} — {rep['checks']} checks, {len(probs)} problem(s) "
          f"({args.pptx})")
    return 0 if rep["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
