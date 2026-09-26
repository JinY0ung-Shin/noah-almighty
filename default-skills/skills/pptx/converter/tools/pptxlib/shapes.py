"""IR `shape` elements and slide backgrounds -> native DrawingML (port of scratch/shape-table/stlib.py).

docs/research/shape-table-mapping.md §0 checklist:
1. no ``p:style``; always an explicit fill, an ``a:ln`` with a line fill, and an ``a:effectLst``;
   ``p:spPr`` child order xfrm, prstGeom, fill, ln, effectLst;
2. geometry inset by half the border width (a DrawingML line is centred on the path, a CSS border lies inside the
   box), radius shrunk by the same amount; ``a:miter lim="800000"`` joins;
3. ``roundRect adj = round(100000 r / min(w,h))`` clamped to [0, 50000];
4. linear gradient ``lin ang = (cssAngle - 90) * 60000 mod 21600000``, ``scaled="0"``, stops clipped to [0,1],
   transparent stops take their neighbour's RGB (CSS interpolates premultiplied), ``rotWithShape="1"``;
5. outer shadow: ``blurRad = emu(blur)``, ``dist = emu(hypot)``, ``dir = atan2 + rotation``, ``rotWithShape="0"``,
   no sx/sy (spread cannot be represented);
6. split rule: translucent border or gradient+border -> fill shape + line shape;
7. every shape is marked decorative (``descr=""`` + Office's decorative flag: it carries no text).
IR ``opacity`` multiplies every alpha the element emits.
"""
from __future__ import annotations

import math

from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn
from pptx.util import Emu

from .core import SLIDE_H_PX, SLIDE_W_PX, ang60k, clamp, el, emu, norm_color, num, pct1000, rel_luminance, srgb, sub
from .pictures import mark_decorative


# ---------------------------------------------------------------------------------------------- fills
def _clip_stops(stops):
    """Clip CSS stops to [0,1] (OOXML gs@pos range), interpolating colours (premultiplied) at the boundary."""
    def lerp(a, b, t):
        ca = [int(a["color"][i:i + 2], 16) for i in (0, 2, 4)]
        cb = [int(b["color"][i:i + 2], 16) for i in (0, 2, 4)]
        al = a["alpha"] + (b["alpha"] - a["alpha"]) * t
        if al <= 0:
            c = [x + (y - x) * t for x, y in zip(ca, cb)]
        else:
            c = [(x * a["alpha"] * (1 - t) + y * b["alpha"] * t) / al for x, y in zip(ca, cb)]
        return {"pos": None, "color": "".join(f"{max(0, min(255, round(v))):02X}" for v in c), "alpha": al}
    out = []
    for i, s in enumerate(stops):
        if 0.0 <= s["pos"] <= 1.0:
            out.append(dict(s))
        if i + 1 < len(stops):
            n = stops[i + 1]
            for edge in (0.0, 1.0):
                if (s["pos"] - edge) * (n["pos"] - edge) < 0:
                    t = (edge - s["pos"]) / (n["pos"] - s["pos"])
                    m = lerp(s, n, t)
                    m["pos"] = edge
                    out.append(m)
    out.sort(key=lambda s: s["pos"])
    if out and out[0]["pos"] > 0:
        out.insert(0, dict(out[0], pos=0.0))
    if out and out[-1]["pos"] < 1:
        out.append(dict(out[-1], pos=1.0))
    return out


def _fix_transparent_stops(stops):
    """Give every alpha-0 stop the RGB of its non-transparent neighbour(s) so a non-premultiplied interpolator
    reproduces CSS's premultiplied result (two co-located stops when the neighbours differ)."""
    out = []
    n = len(stops)
    for i, s in enumerate(stops):
        if s["alpha"] > 0:
            out.append(dict(s))
            continue
        left = stops[i - 1]["color"] if i > 0 and stops[i - 1]["alpha"] > 0 else None
        right = stops[i + 1]["color"] if i + 1 < n and stops[i + 1]["alpha"] > 0 else None
        if left and right and left != right:
            out.append(dict(s, color=left))
            out.append(dict(s, color=right))
        else:
            out.append(dict(s, color=left or right or s["color"]))
    return out


def _norm_stops(fill, warn=None):
    stops = []
    for s in fill.get("stops") or []:
        if not isinstance(s, dict):
            continue
        stops.append({"pos": num(s.get("pos")), "color": norm_color(s.get("color"), warn),
                      "alpha": clamp(num(s.get("alpha"), 1.0), 0.0, 1.0)})
    stops.sort(key=lambda s: s["pos"])          # CSS: a stop before its predecessor is clamped (stable order)
    return stops


def fill_el(fill, opacity: float = 1.0, warn=None):
    """IR Fill -> a:noFill | a:solidFill | a:gradFill (linear, scaled=0)."""
    if not isinstance(fill, dict):
        return el("a:noFill")
    if fill.get("type") == "solid":
        a = clamp(num(fill.get("alpha"), 1.0), 0.0, 1.0) * opacity
        if a <= 0:
            return el("a:noFill")
        e = el("a:solidFill")
        e.append(srgb(norm_color(fill.get("color"), warn), a))
        return e
    if fill.get("type") == "linear":
        stops = _norm_stops(fill, warn)
        if not stops:
            return el("a:noFill")
        if len(stops) == 1:
            return fill_el({"type": "solid", "color": stops[0]["color"], "alpha": stops[0]["alpha"]}, opacity, warn)
        stops = _clip_stops(_fix_transparent_stops(stops))
        e = el("a:gradFill", rotWithShape="1")
        gs_lst = sub(e, "a:gsLst")
        for s in stops:
            gs = sub(gs_lst, "a:gs", pos=pct1000(s["pos"]))
            gs.append(srgb(s["color"], s.get("alpha", 1.0) * opacity))
        sub(e, "a:lin", ang=ang60k(num(fill.get("angleDeg"), 180.0) - 90.0), scaled="0")
        return e
    if warn:
        warn(f"unsupported fill type {fill.get('type')!r} -> no fill")
    return el("a:noFill")


def dash_el(dash: str, width_px: float):
    if dash == "dashed":
        e = el("a:custDash")
        if width_px >= 3:
            sub(e, "a:ds", d=200000, sp=100000)
        else:
            sub(e, "a:ds", d=300000, sp=200000)
        return e, "flat"
    if dash == "dotted":
        return el("a:prstDash", val="sysDot"), ("rnd" if width_px > 3 else "flat")
    return el("a:prstDash", val="solid"), "flat"


def line_el(line, opacity: float = 1.0, tag: str = "a:ln", warn=None):
    """IR Line -> a:ln (or a:lnL/lnR/lnT/lnB) with explicit fill, dash and (for a:ln) mitred join.
    None / zero width / invisible -> a line with a:noFill (never w="0": Office draws a hairline)."""
    e = el(tag)
    w = num(line.get("widthPx")) if isinstance(line, dict) else 0.0
    a = clamp(num(line.get("alpha"), 1.0), 0.0, 1.0) * opacity if isinstance(line, dict) else 0.0
    if w <= 0 or a <= 0:
        sub(e, "a:noFill")
        return e
    dash, cap = dash_el(line.get("dash", "solid"), w)
    e.set("w", str(clamp(emu(w), 1, 20116800)))
    e.set("cap", cap)
    e.set("cmpd", "sng")
    e.set("algn", "ctr")
    sf = sub(e, "a:solidFill")
    sf.append(srgb(norm_color(line.get("color"), warn), a))
    e.append(dash)
    if tag == "a:ln":
        sub(e, "a:miter", lim=800000)
    return e


def effect_el(shadow, opacity: float = 1.0, rot_deg: float = 0.0, warn=None):
    """IR Shadow -> a:effectLst (empty when None: blocks theme/style effect inheritance).
    CSS offsets live in the element's local (rotated) space: pre-rotate `dir` and write rotWithShape="0"
    (PowerPoint and LibreOffice 7.4 — which ignores rotWithShape — then agree)."""
    e = el("a:effectLst")
    if not isinstance(shadow, dict):
        return e
    a = clamp(num(shadow.get("alpha"), 1.0), 0.0, 1.0) * opacity
    if a <= 0:
        return e
    ox, oy = num(shadow.get("offsetXPx")), num(shadow.get("offsetYPx"))
    dist = math.hypot(ox, oy)
    d = (math.degrees(math.atan2(oy, ox)) + rot_deg) if dist > 0 else 0.0
    sh = sub(e, "a:outerShdw", blurRad=clamp(emu(max(0.0, num(shadow.get("blurPx")))), 0, 2147483647),
             dist=clamp(emu(dist), 0, 2147483647), dir=ang60k(d), algn="ctr", rotWithShape="0")
    sh.append(srgb(norm_color(shadow.get("color"), warn), a))
    return e


# ---------------------------------------------------------------------------------------------- geometry
def round_rect_adj(r_px: float, w_px: float, h_px: float) -> int:
    ss = min(w_px, h_px)
    if ss <= 0 or r_px <= 0:
        return 0
    return max(0, min(50000, int(round(r_px / ss * 100000))))


def prst_geom(geometry: str, r: float, w: float, h: float):
    prst = {"rect": "rect", "roundRect": "roundRect", "ellipse": "ellipse"}.get(geometry, "rect")
    if prst == "roundRect" and (r <= 0 or round_rect_adj(r, w, h) == 0):
        prst = "rect"
    g = el("a:prstGeom", prst=prst)
    av = sub(g, "a:avLst")
    if prst == "roundRect":
        sub(av, "a:gd", name="adj", fmla=f"val {round_rect_adj(r, w, h)}")
    return g


def new_sp(slide, name: str, x, y, w, h, rot_deg: float):
    """python-pptx autoshape with p:style removed and spPr reduced to xfrm (caller appends the rest)."""
    shp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Emu(emu(x)), Emu(emu(y)), Emu(max(0, emu(w))),
                                 Emu(max(0, emu(h))))
    sp = shp._element
    style = sp.find(qn("p:style"))
    if style is not None:
        sp.remove(style)
    shp.name = name
    spPr = sp.spPr
    for child in list(spPr):
        if child.tag != qn("a:xfrm"):
            spPr.remove(child)
    if rot_deg:
        spPr.find(qn("a:xfrm")).set("rot", str(ang60k(rot_deg)))
    return shp, spPr


def add_shape(slide, e: dict, ctx, split_policy: str = "auto"):
    """IR shape -> one or two p:sp (split: fill shape + line shape, §2.4). Returns the list of shapes."""
    warn = ctx.log.warn
    box = e.get("box") or {}
    bx, by, bw_, bh_ = num(box.get("x")), num(box.get("y")), max(0.0, num(box.get("w"))), max(0.0, num(box.get("h")))
    geom = e.get("geometry", "rect")
    if geom not in ("rect", "roundRect", "ellipse"):
        warn(f"slide {ctx.slide_index}: shape {e.get('id')!r}: geometry {geom!r} -> rect")
        geom = "rect"
    radius = max(0.0, num(e.get("radiusPx")))
    fill, line, shadow = e.get("fill"), e.get("line"), e.get("shadow")
    if not isinstance(line, dict) or num(line.get("widthPx")) <= 0:
        line = None
    op = clamp(num(e.get("opacity"), 1.0), 0.0, 1.0)
    rot = num(e.get("rotationDeg"))
    bw = num(line["widthPx"]) if line else 0.0
    if line and bw * 2 > min(bw_, bh_) and min(bw_, bh_) > 0:
        bw = min(bw_, bh_) / 2                   # CSS: borders wider than the box fill it
        line = dict(line, widthPx=bw)
    has_fill = isinstance(fill, dict)
    translucent_line = bool(line) and clamp(num(line.get("alpha"), 1.0), 0, 1) * op < 1.0
    gradient_with_line = bool(line) and has_fill and fill.get("type") == "linear"
    # dashed/dotted border: CSS paints the background under the whole border band (the gaps show the fill) and
    # casts box-shadow from the full border box; one DrawingML shape would leave the outer half of every gap
    # unfilled and derive its shadow from the dashes (seen in the LibreOffice render of the fixture)
    broken_line = bool(line) and line.get("dash", "solid") in ("dashed", "dotted")
    split = split_policy == "always" or (split_policy == "auto" and has_fill and line is not None
                                         and (translucent_line or gradient_with_line or broken_line))
    if isinstance(shadow, dict) and num(shadow.get("spreadPx")):
        warn(f"slide {ctx.slide_index}: shape {e.get('id')!r}: box-shadow spread {shadow.get('spreadPx')}px is "
             "not representable (dropped)")
    name = e.get("id", "shape")
    out = []

    def one(label, fbox, fr, fill_, line_, shadow_):
        role = {"": "main", " fill": "fill", " border": "border"}[label]
        nm = ctx.name_for(e, role) if hasattr(ctx, "name_for") else f"{name}{label}"
        shp, spPr = new_sp(slide, ctx.namer(nm), fbox[0], fbox[1], fbox[2], fbox[3], rot)
        spPr.append(prst_geom(geom, fr, fbox[2], fbox[3]))
        spPr.append(fill_el(fill_, op, warn))
        spPr.append(line_el(line_, op, warn=warn))
        spPr.append(effect_el(shadow_, op, rot, warn))
        # a fill/border shape carries no text: Office's decorative flag, so the Accessibility Checker does not ask
        # for alt text and screen readers skip it (judge J2-03; text boxes, pictures and charts carry their text)
        mark_decorative(shp._element.nvSpPr.cNvPr)
        if is_dark_fill(fill_, op):
            light_default_text(shp._element)
        out.append(shp)

    i = bw / 2.0
    inset = (bx + i, by + i, max(0.0, bw_ - bw), max(0.0, bh_ - bw))
    if not split:
        one("", inset, max(0.0, radius - i), fill, line, shadow)
        return out
    if gradient_with_line:          # CSS sizes the gradient to the padding box
        fb = (bx + bw, by + bw, max(0.0, bw_ - 2 * bw), max(0.0, bh_ - 2 * bw))
        fr = max(0.0, radius - bw)
    else:                           # CSS paints the background under the (translucent) border band
        fb = (bx, by, bw_, bh_)
        fr = radius
    one(" fill", fb, fr, fill, None, shadow)
    one(" border", inset, max(0.0, radius - i), None, line, None)
    return out


DARK_FILL_MAX_LUMINANCE = 0.2


def is_dark_fill(fill, opacity: float = 1.0) -> bool:
    """An opaque solid / gradient fill whose every stop is darker than DARK_FILL_MAX_LUMINANCE (a navy card, the
    panel): text typed into it would be the master's dark default colour (tx1) on a dark surface."""
    if not isinstance(fill, dict):
        return False
    if fill.get("type") == "solid":
        stops = [(fill.get("color"), num(fill.get("alpha"), 1.0))]
    elif fill.get("type") == "linear":
        stops = [(s.get("color"), num(s.get("alpha"), 1.0)) for s in fill.get("stops") or [] if isinstance(s, dict)]
    else:
        return False
    if not stops or any(a * opacity < 0.99 for _, a in stops):
        return False
    return max(rel_luminance(norm_color(c)) for c, _ in stops) < DARK_FILL_MAX_LUMINANCE


def light_default_text(sp) -> None:
    """White default run colour (a:lstStyle lvl1pPr defRPr) in a dark fill shape's empty text body: a user who selects
    the card / panel and starts typing gets legible text (fixer round 3, EDIT-12). The shape shows no text, so nothing
    renders differently."""
    tx = sp.find(qn("p:txBody"))
    lst = tx.find(qn("a:lstStyle")) if tx is not None else None
    if lst is None:
        return
    lvl = sub(lst, "a:lvl1pPr")
    d = sub(lvl, "a:defRPr")
    sf = sub(d, "a:solidFill")
    sub(sf, "a:srgbClr", val="FFFFFF")


# ---------------------------------------------------------------------------------------------- background
def _over_white(color: str, alpha: float) -> str:
    c = [int(color[k:k + 2], 16) for k in (0, 2, 4)]
    return "".join(f"{round(v * alpha + 255 * (1 - alpha)):02X}" for v in c)


def set_background(slide, fill, warn=None):
    """Slide background: explicit solid/gradient fill. Alpha is pre-composited over white (Chromium composites the
    page over a white canvas; for gradients compositing each stop is exact). None -> explicit white."""
    if not isinstance(fill, dict) or fill.get("type") not in ("solid", "linear"):
        if fill is not None and warn:
            warn(f"unsupported background {fill!r} -> white")
        fill = {"type": "solid", "color": "FFFFFF", "alpha": 1.0}
    f = dict(fill)
    if f["type"] == "solid":
        a = clamp(num(f.get("alpha"), 1.0), 0.0, 1.0)
        f = {"type": "solid", "color": _over_white(norm_color(f.get("color"), warn), a), "alpha": 1.0}
    else:
        stops = []
        for s in _norm_stops(f, warn):
            stops.append({"pos": s["pos"], "color": _over_white(s["color"], s["alpha"]), "alpha": 1.0})
        f = {"type": "linear", "angleDeg": f.get("angleDeg", 180.0), "stops": stops}
    slide.background.fill.solid()             # creates p:bg/p:bgPr
    bgPr = slide._element.cSld.bg.bgPr
    for child in list(bgPr):
        bgPr.remove(child)
    bgPr.append(fill_el(f, 1.0, warn))
    bgPr.append(el("a:effectLst"))


def full_slide_box():
    return {"x": 0.0, "y": 0.0, "w": float(SLIDE_W_PX), "h": float(SLIDE_H_PX)}
