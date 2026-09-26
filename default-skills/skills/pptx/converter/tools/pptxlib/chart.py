"""IR ``chart`` element -> native, editable PowerPoint chart (python-pptx 1.0.2 + lxml post-processing).

Entry point for the builder::

    gf = add_chart(slide, el, ctx)

``el``  = IR chart element (docs/CONTRACT.md): ``box`` (slide CSS px, border-box), ``spec`` (ChartSpec) and
          ``resolved`` = ``{"plotPx": {x, y, w, h} (SLIDE px), "valueMin", "valueMax", "majorUnit"}`` as published
          by lib/chart.js (``data-resolved``) and copied by the extractor.
``ctx`` = builder context: ``ctx.resolve_face(css_weight) -> {"typeface", "bold"}`` (fonts.json rule), optional
          ``ctx.emu(px) -> int``, ``ctx.profile``, ``ctx.poc``, optional ``ctx.warn(msg)``.

Port of the tested reference ``scratch/chart/chart_native.py`` (docs/research/chart-mapping.md) with the same
guarantees: python-pptx writes the chart part + embedded workbook (Edit Data), everything else is inserted in the
ECMA-376 Transitional ``dml-chart.xsd`` sequence (``put``), only legal ``c:dLblPos`` values (``resolve_dlbl_pos``),
group-level ``c:dLbls`` with show* flags only, explicit booleans, positive axis ids, ``manualLayout`` (inner, edge)
fractions within [0, 1], explicit ``c:min``/``c:max``/``c:majorUnit``, profile typeface in latin/ea/cs on every
text-bearing element, ``c:lang`` ko-KR. Additions over the reference (all mirrored by lib/chart.js):

* data labels carry PowerPoint 16's own label-box insets (``lIns/rIns=38100``, ``tIns/bIns=19050`` EMU = 4 / 2 px,
  ``spAutoFit``, as in PowerPoint-written chart parts) so the label box PowerPoint positions is the one the preview
  models; ``wrap="none"`` keeps a label on one line;
* ``kern="0"`` on every chart text style (CONTRACT v2: kerning off on both sides);
* default series / slice colours = the Office 2013+ accent palette (not one colour for every slice);
* an omitted ``dataLabels.position`` resolves to an explicit legal position (clustered bar/column ``outEnd``,
  stacked ``ctr``, line ``t``, pie ``ctr``; doughnut never has one) instead of Office's type-dependent default;
* category labels ``tickLblPos="low"`` when the value axis goes below zero (labels stay at the plot edge instead of
  following the zero line); the axis line itself stays at the zero crossing (``crosses autoZero``);
* a Python port of lib/chart.js ``resolveScale`` (``nice_scale``) is used ONLY when ``resolved`` lacks a value.
"""
from __future__ import annotations

import math
import re
from typing import Callable

from lxml import etree
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import (
    XL_CHART_TYPE,
    XL_LEGEND_POSITION,
    XL_MARKER_STYLE,
    XL_TICK_LABEL_POSITION,
    XL_TICK_MARK,
)
from pptx.util import Emu

__all__ = ["add_chart", "add_native_chart", "resolve_dlbl_pos", "nice_scale", "default_dlbl_position",
           "PALETTE", "ALLOWED_DLBLPOS"]

EMU_PER_PX = 9525
NS = {
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main"

# ---- defaults shared with lib/chart.js (keep both files in sync) ---------------------------------------
PALETTE = ("4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47")  # Office 2013+ accent1..6
TEXT_COLOR = "475569"
DEFAULT_SIZE_PX = 13
DEFAULT_GAP_WIDTH = 150      # ECMA default (c:gapWidth)
DEFAULT_OVERLAP = 0          # ECMA default (c:overlap), 100 forced for stacked
DEFAULT_HOLE_SIZE = 50
LINE_WIDTH_PX = 3.0          # 28575 EMU = 2.25 pt, PowerPoint's default line-series width
MARKER_PX = 7.0              # -> c:marker/c:size = round(7 * 0.75) = 5 pt
GRID_COLOR = "E5E7EB"
DL_INSET_X_EMU = 38100       # PowerPoint 16 data-label bodyPr lIns/rIns (4 px)
DL_INSET_Y_EMU = 19050       # PowerPoint 16 data-label bodyPr tIns/bIns (2 px)


def q(tag: str) -> str:
    prefix, local = tag.split(":")
    return "{%s}%s" % (NS[prefix], local)


def E(tag: str, **attrs) -> etree._Element:
    el = etree.Element(q(tag))
    for k, v in attrs.items():
        el.set(k, str(v))
    return el


# --------------------------------------------------------------------------------------------------------
# Schema child order (ECMA-376 Transitional dml-chart.xsd). Groups of alternatives share a slot.
# --------------------------------------------------------------------------------------------------------
_CHART_GROUPS = ("areaChart", "area3DChart", "lineChart", "line3DChart", "stockChart", "radarChart",
                 "scatterChart", "pieChart", "pie3DChart", "doughnutChart", "barChart", "bar3DChart",
                 "ofPieChart", "surfaceChart", "surface3DChart", "bubbleChart")
_AXES = ("valAx", "catAx", "dateAx", "serAx")
SEQ = {
    "chartSpace": ["date1904", "lang", "roundedCorners", "AlternateContent", "style", "clrMapOvr",
                   "pivotSource", "protection", "chart", "spPr", "txPr", "externalData",
                   "printSettings", "userShapes", "extLst"],
    "chart": ["title", "autoTitleDeleted", "pivotFmts", "view3D", "floor", "sideWall", "backWall",
              "plotArea", "legend", "plotVisOnly", "dispBlanksAs", "showDLblsOverMax", "extLst"],
    "plotArea": ["layout", _CHART_GROUPS, _AXES, "dTable", "spPr", "extLst"],
    "layout": ["manualLayout", "extLst"],
    "manualLayout": ["layoutTarget", "xMode", "yMode", "wMode", "hMode", "x", "y", "w", "h", "extLst"],
    "barChart": ["barDir", "grouping", "varyColors", "ser", "dLbls", "gapWidth", "overlap",
                 "serLines", "axId", "extLst"],
    "lineChart": ["grouping", "varyColors", "ser", "dLbls", "dropLines", "hiLowLines",
                  "upDownBars", "marker", "smooth", "axId", "extLst"],
    "pieChart": ["varyColors", "ser", "dLbls", "firstSliceAng", "extLst"],
    "doughnutChart": ["varyColors", "ser", "dLbls", "firstSliceAng", "holeSize", "extLst"],
    "ser:barChart": ["idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "dPt",
                     "dLbls", "trendline", "errBars", "cat", "val", "shape", "extLst"],
    "ser:lineChart": ["idx", "order", "tx", "spPr", "marker", "dPt", "dLbls", "trendline",
                      "errBars", "cat", "val", "smooth", "extLst"],
    "ser:pieChart": ["idx", "order", "tx", "spPr", "explosion", "dPt", "dLbls", "cat", "val",
                     "extLst"],
    "dPt": ["idx", "invertIfNegative", "marker", "bubble3D", "explosion", "spPr", "pictureOptions",
            "extLst"],
    "marker": ["symbol", "size", "spPr", "extLst"],
    "dLbls": ["dLbl", "delete", "numFmt", "spPr", "txPr", "dLblPos", "showLegendKey", "showVal",
              "showCatName", "showSerName", "showPercent", "showBubbleSize", "separator",
              "showLeaderLines", "leaderLines", "extLst"],
    "catAx": ["axId", "scaling", "delete", "axPos", "majorGridlines", "minorGridlines", "title",
              "numFmt", "majorTickMark", "minorTickMark", "tickLblPos", "spPr", "txPr", "crossAx",
              ("crosses", "crossesAt"), "auto", "lblAlgn", "lblOffset", "tickLblSkip",
              "tickMarkSkip", "noMultiLvlLbl", "extLst"],
    "valAx": ["axId", "scaling", "delete", "axPos", "majorGridlines", "minorGridlines", "title",
              "numFmt", "majorTickMark", "minorTickMark", "tickLblPos", "spPr", "txPr", "crossAx",
              ("crosses", "crossesAt"), "crossBetween", "majorUnit", "minorUnit", "dispUnits",
              "extLst"],
    "scaling": ["logBase", "orientation", "max", "min", "extLst"],
    "legend": ["legendPos", "legendEntry", "layout", "overlay", "spPr", "txPr", "extLst"],
}
SEQ["ser:doughnutChart"] = SEQ["ser:pieChart"]


def _slot(seq, local):
    for i, s in enumerate(seq):
        if local == s or (isinstance(s, tuple) and local in s):
            return i
    raise KeyError(local)


def _seq_for(parent):
    local = etree.QName(parent).localname
    if local == "ser":
        return SEQ["ser:" + etree.QName(parent.getparent()).localname]
    return SEQ[local]


def put(parent, child, replace=True):
    """Insert `child` into `parent` at its schema position (replacing a same-named child)."""
    seq = _seq_for(parent)
    local = etree.QName(child).localname
    slot = _slot(seq, local)
    if replace:
        for old in parent.findall(child.tag):
            parent.remove(old)
    for existing in parent:
        if not isinstance(existing.tag, str):
            continue
        name = etree.QName(existing).localname
        try:
            if _slot(seq, name) > slot:
                existing.addprevious(child)
                return child
        except KeyError:
            continue
    parent.append(child)
    return child


def val_el(tag, val):
    return E(tag, val=val)


_XML_ILLEGAL = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")


def clean_text(s) -> str:
    return _XML_ILLEGAL.sub("", "" if s is None else str(s))


def clean_number(v):
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


_HEX6 = re.compile(r"^[0-9A-Fa-f]{6}$")


def norm_color(c, default=None):
    """'#abc' / 'aabbcc' / 'AABBCCDD' -> 'AABBCC'; anything else -> default."""
    if c is None:
        return default
    s = str(c).strip().lstrip("#")
    if len(s) == 3 and all(ch in "0123456789abcdefABCDEF" for ch in s):
        s = "".join(ch * 2 for ch in s)
    if len(s) == 8:
        s = s[:6]
    return s.upper() if _HEX6.match(s) else default


# --------------------------------------------------------------------------------------------------------
# DrawingML fragments
# --------------------------------------------------------------------------------------------------------
def solid_fill(rgb: str, alpha: float | None = None):
    fill = E("a:solidFill")
    clr = etree.SubElement(fill, q("a:srgbClr"), val=rgb.upper())
    if alpha is not None and alpha < 1:
        etree.SubElement(clr, q("a:alpha"), val=str(round(alpha * 100000)))
    return fill


def sp_pr(fill_rgb: str | None = None, line_rgb: str | None = None, line_w_px: float | None = None,
          round_cap: bool = False):
    """c:spPr. fill None -> a:noFill; line None -> a:ln/a:noFill. Always ends with a:effectLst (no shadow)."""
    sp = E("c:spPr")
    sp.append(solid_fill(fill_rgb) if fill_rgb else E("a:noFill"))
    ln = etree.SubElement(sp, q("a:ln"))
    if line_rgb:
        ln.set("w", str(round((line_w_px or 1) * EMU_PER_PX)))
        if round_cap:
            ln.set("cap", "rnd")
        ln.append(solid_fill(line_rgb))
        etree.SubElement(ln, q("a:round"))
    else:
        etree.SubElement(ln, q("a:noFill"))
    etree.SubElement(sp, q("a:effectLst"))
    return sp


def line_only_sp_pr(line_rgb: str, line_w_px: float, cap: str = "rnd"):
    """spPr for a line series / gridline: no area fill element at all (Office drops *Fill on a line ser,
    MS-OI29500 2.1.1555 b), solid line, round join like PowerPoint."""
    sp = E("c:spPr")
    ln = etree.SubElement(sp, q("a:ln"), w=str(round(line_w_px * EMU_PER_PX)), cap=cap)
    ln.append(solid_fill(line_rgb))
    etree.SubElement(ln, q("a:round"))
    etree.SubElement(sp, q("a:effectLst"))
    return sp


def tx_pr(size_px: float, color: str, face: dict, lang: str = "ko-KR", rot: int | None = 0,
          wrap: bool = True, label_insets: bool = False):
    """c:txPr with explicit latin + ea + cs typefaces (Hangul is rendered with a:ea), kern="0"."""
    txPr = E("c:txPr")
    body = etree.SubElement(txPr, q("a:bodyPr"))
    if rot is not None:
        body.set("rot", str(rot))
    body.set("spcFirstLastPara", "1")
    body.set("vertOverflow", "ellipsis")
    body.set("vert", "horz")
    body.set("wrap", "square" if wrap else "none")
    if label_insets:  # PowerPoint 16's own data-label box (lib/chart.js MODEL.dlInsetX / dlInsetY)
        body.set("lIns", str(DL_INSET_X_EMU))
        body.set("tIns", str(DL_INSET_Y_EMU))
        body.set("rIns", str(DL_INSET_X_EMU))
        body.set("bIns", str(DL_INSET_Y_EMU))
    body.set("anchor", "ctr")
    body.set("anchorCtr", "1")
    if label_insets:
        etree.SubElement(body, q("a:spAutoFit"))
    etree.SubElement(txPr, q("a:lstStyle"))
    p = etree.SubElement(txPr, q("a:p"))
    pPr = etree.SubElement(p, q("a:pPr"))
    d = etree.SubElement(pPr, q("a:defRPr"), sz=str(max(100, round(size_px * 75))),
                         b="1" if face.get("bold") else "0", i="0", u="none", strike="noStrike",
                         kern="0", baseline="0")
    d.append(solid_fill(color))
    for slot in ("a:latin", "a:ea", "a:cs"):
        etree.SubElement(d, q(slot), typeface=face["typeface"])
    etree.SubElement(p, q("a:endParaRPr"), lang=lang)
    return txPr


# --------------------------------------------------------------------------------------------------------
# Data-label positions: [MS-OI29500] 2.1.1456 (Part 1 §21.2.2.48) — anything else = repair/refusal
# --------------------------------------------------------------------------------------------------------
ALLOWED_DLBLPOS = {
    ("barChart", "clustered"): {"inBase", "inEnd", "outEnd", "ctr"},
    ("barChart", "stacked"): {"inBase", "inEnd", "ctr"},
    ("barChart", "percentStacked"): {"inBase", "inEnd", "ctr"},
    ("lineChart", None): {"l", "r", "b", "t", "ctr"},
    ("pieChart", None): {"bestFit", "outEnd", "inEnd", "ctr"},
    ("doughnutChart", None): set(),  # "shall not be specified"
}
# ChartSpec position -> OOXML position per chart group (documented mapping; lib/chart.js must match)
POS_MAP = {
    "barChart": {"outEnd": "outEnd", "inEnd": "inEnd", "ctr": "ctr"},
    "lineChart": {"outEnd": "t", "inEnd": "b", "ctr": "ctr"},
    "pieChart": {"outEnd": "outEnd", "inEnd": "inEnd", "ctr": "ctr"},
    "doughnutChart": {},
}


def default_dlbl_position(group: str, grouping: str | None) -> str | None:
    """ChartSpec position used when dataLabels.position is omitted (lib/chart.js uses the same)."""
    if group == "barChart":
        return "ctr" if grouping in ("stacked", "percentStacked") else "outEnd"
    if group == "lineChart":
        return "outEnd"          # -> 't'
    if group == "pieChart":
        return "ctr"
    return None                  # doughnut: never specified (labels centred on the ring)


def resolve_dlbl_pos(group: str, grouping: str | None, spec_pos: str | None) -> str | None:
    """Return a legal c:dLblPos value or None (= omit the element)."""
    if spec_pos is None:
        spec_pos = default_dlbl_position(group, grouping)
        if spec_pos is None:
            return None
    pos = POS_MAP.get(group, {}).get(spec_pos)
    key = (group, grouping if group == "barChart" else None)
    allowed = ALLOWED_DLBLPOS.get(key, set())
    if pos in allowed:
        return pos
    if group == "barChart" and spec_pos == "outEnd":  # stacked: outEnd illegal -> closest legal
        return "inEnd"
    return None


# --------------------------------------------------------------------------------------------------------
# Value scale fallback (port of lib/chart.js resolveScale; used only when `resolved` lacks a value)
# --------------------------------------------------------------------------------------------------------
_STEP_MANTISSAS = (1, 2, 5)  # Excel's automatic major unit: 1-2-5 x 10^k


def _tidy(v: float) -> float:
    if v == 0 or not math.isfinite(v):
        return v
    return float("%.12g" % v)


def _data_extent(spec):
    t = spec.get("type")
    stacked = spec.get("grouping") == "stacked"
    series = spec.get("series") or []
    ncat = len(spec.get("categories") or [])
    if stacked:
        lo = hi = None
        for i in range(ncat):
            pos = neg = 0.0
            seen = False
            for s in series:
                vals = s.get("values") or []
                v = clean_number(vals[i]) if i < len(vals) else None
                if v is None:
                    continue
                seen = True
                if v >= 0:
                    pos += v
                else:
                    neg += v
            if seen:
                lo = neg if lo is None else min(lo, neg)
                hi = pos if hi is None else max(hi, pos)
        return (lo or 0.0, hi or 0.0) if lo is not None else (0.0, 0.0)
    vals = [clean_number(v) for s in (series[:1] if t == "pie" else series) for v in (s.get("values") or [])]
    vals = [v for v in vals if v is not None]
    if not vals:
        return 0.0, 0.0
    return min(vals), max(vals)


def _intervals(lo, hi, step, fixed_min, fixed_max):
    a = lo if fixed_min else math.floor(lo / step + 1e-9) * step
    b = hi if fixed_max else math.ceil(hi / step - 1e-9) * step
    return (b - a) / step


def _choose_step(lo, hi, fixed_min, fixed_max):
    span = hi - lo
    k0 = math.floor(math.log10(span))
    cands = [m * 10.0 ** k for k in range(k0 - 3, k0 + 2) for m in _STEP_MANTISSAS]
    cands.sort()
    if fixed_min and fixed_max:
        best = None
        for st in cands:
            n = span / st
            if abs(n - round(n)) < 1e-9 and 2 <= round(n) <= 10:
                score = (abs(round(n) - 5), -st)
                if best is None or score < best[0]:
                    best = (score, st)
        if best:
            return best[1]
    for st in cands:
        if _intervals(lo, hi, st, fixed_min, fixed_max) <= 7 + 1e-9:
            return st
    return cands[-1]


def nice_scale(spec: dict) -> tuple[float, float, float]:
    """(valueMin, valueMax, majorUnit) exactly as lib/chart.js resolveScale() computes them."""
    t = spec.get("type")
    va = spec.get("valueAxis") or {}
    umin, umax = clean_number(va.get("min")), clean_number(va.get("max"))
    umaj = clean_number(va.get("majorUnit"))
    if umaj is not None and umaj <= 0:
        umaj = None
    lo, hi = _data_extent(spec)
    if t in ("column", "bar") or spec.get("grouping") == "stacked":
        lo, hi = min(lo, 0.0), max(hi, 0.0)
    else:  # line: Excel's rule — start at zero unless the data sits in a narrow band far from it
        if lo >= 0 and hi > 0 and (hi - lo) / hi >= 1 / 6:
            lo = 0.0
        elif hi <= 0 and lo < 0 and (hi - lo) / -lo >= 1 / 6:
            hi = 0.0
        elif hi > lo:
            pad = 0.05 * (hi - lo)
            lo, hi = (lo - pad if lo != 0 else lo), (hi + pad if hi != 0 else hi)
    if umin is not None:
        lo = umin
    if umax is not None:
        hi = umax
    if not hi > lo:
        if umax is None:
            hi = lo + (abs(lo) or 1.0)
        else:
            lo = hi - (abs(hi) or 1.0)
    step = umaj or _choose_step(lo, hi, umin is not None, umax is not None)
    vmin = umin if umin is not None else math.floor(lo / step + 1e-9) * step
    vmax = umax if umax is not None else math.ceil(hi / step - 1e-9) * step
    if umin is None and lo < 0 and (lo - vmin) < 0.05 * (vmax - vmin):
        vmin -= step
    if umax is None and hi > 0 and (vmax - hi) < 0.05 * (vmax - vmin):
        vmax += step
    return _tidy(vmin), _tidy(vmax), _tidy(step)


# --------------------------------------------------------------------------------------------------------
# Builder entry (IR element + ctx)
# --------------------------------------------------------------------------------------------------------
def _warn(ctx, msg):
    w = getattr(ctx, "warn", None)
    if callable(w):
        w(msg)


def add_chart(slide, el: dict, ctx):
    """Add the IR chart element `el` to `slide` as a native chart; returns the python-pptx GraphicFrame."""
    spec = el["spec"]
    box = el["box"]
    res = el.get("resolved") or {}
    plot = res.get("plotPx")
    plot_rel = None
    if plot:
        plot_rel = {"x": plot["x"] - box["x"], "y": plot["y"] - box["y"], "w": plot["w"], "h": plot["h"]}
    elif spec.get("type") in ("column", "bar", "line", "pie", "doughnut"):
        _warn(ctx, f"chart {el.get('id')}: no resolved.plotPx -> PowerPoint automatic layout (will not match "
                   "the HTML preview)")
    vmin, vmax, major = res.get("valueMin"), res.get("valueMax"), res.get("majorUnit")
    if spec.get("type") in ("column", "bar", "line") and None in (vmin, vmax, major):
        fmin, fmax, fmaj = nice_scale(spec)
        va = spec.get("valueAxis") or {}
        vmin = vmin if vmin is not None else (va.get("min") if va.get("min") is not None else fmin)
        vmax = vmax if vmax is not None else (va.get("max") if va.get("max") is not None else fmax)
        major = major if major is not None else fmaj
        _warn(ctx, f"chart {el.get('id')}: resolved scale incomplete -> builder fallback "
                   f"{vmin}..{vmax} step {major}")
    if el.get("rotationDeg"):
        _warn(ctx, f"chart {el.get('id')}: rotation {el['rotationDeg']} ignored (chart frames cannot rotate)")
    if el.get("opacity", 1) not in (None, 1, 1.0):
        _warn(ctx, f"chart {el.get('id')}: opacity {el['opacity']} ignored")
    emu = getattr(ctx, "emu", None)
    return add_native_chart(slide, spec, box, ctx.resolve_face, plot_px=plot_rel,
                            value_range=(vmin, vmax), major_unit=major, emu=emu,
                            name=el.get("name"))


def _xl_type(spec):
    t, g = spec["type"], spec.get("grouping") or "clustered"
    if t in ("pie", "doughnut"):
        return {"pie": XL_CHART_TYPE.PIE, "doughnut": XL_CHART_TYPE.DOUGHNUT}[t]
    stacked = g == "stacked"
    return {
        ("column", False): XL_CHART_TYPE.COLUMN_CLUSTERED,
        ("column", True): XL_CHART_TYPE.COLUMN_STACKED,
        ("bar", False): XL_CHART_TYPE.BAR_CLUSTERED,
        ("bar", True): XL_CHART_TYPE.BAR_STACKED,
        ("line", False): XL_CHART_TYPE.LINE_MARKERS,
        ("line", True): XL_CHART_TYPE.LINE_MARKERS_STACKED,
    }[(t, stacked)]


def _manual_layout(plot_px, box_px):
    W, H = float(box_px["w"]), float(box_px["h"])
    x, y, w, h = (float(plot_px[k]) for k in ("x", "y", "w", "h"))
    # tolerate float noise of up to 1 px at the frame edges; anything larger is a contract violation
    if x < -1 or y < -1 or x + w > W + 1 or y + h > H + 1 or w <= 0 or h <= 0:
        raise ValueError(f"plot rect {plot_px} outside the chart frame {W}x{H} (Office ignores such a "
                         "manualLayout)")
    x, y = max(0.0, x), max(0.0, y)
    w, h = min(w, W - x), min(h, H - y)
    fr = {"x": x / W, "y": y / H, "w": w / W, "h": h / H}
    for k, v in fr.items():
        if not 0 <= v <= 1:
            raise ValueError(f"manualLayout {k}={v} outside [0,1] (Office ignores it)")
    lay = E("c:layout")
    ml = etree.SubElement(lay, q("c:manualLayout"))
    for tag, v in (("layoutTarget", "inner"), ("xMode", "edge"), ("yMode", "edge")):
        etree.SubElement(ml, q("c:" + tag), val=v)
    for k in ("x", "y", "w", "h"):
        etree.SubElement(ml, q("c:" + k), val=repr(round(fr[k], 6)))
    return lay


def add_native_chart(slide, spec: dict, box_px: dict, face_for_weight: Callable[[int], dict],
                     plot_px: dict | None = None, value_range: tuple | None = None,
                     major_unit: float | None = None, lang: str = "ko-KR",
                     line_width_px: float = LINE_WIDTH_PX, marker_px: float = MARKER_PX,
                     text_color: str = TEXT_COLOR, emu=None, name: str | None = None):
    """Add a native chart for `spec` (CONTRACT ChartSpec) at `box_px` (slide CSS px).

    face_for_weight(cssWeight) -> {"typeface": str, "bold": bool} (fonts.json nearest-weight rule).
    plot_px: inner plot rectangle {x,y,w,h} in px RELATIVE TO THE CHART BOX (lib/chart.js data-resolved.plot);
             None -> PowerPoint's automatic layout (will NOT match the HTML preview).
    value_range: (min, max) resolved by lib/chart.js; major_unit likewise.
    """
    t = spec["type"]
    if t not in ("column", "bar", "line", "pie", "doughnut"):
        raise ValueError(f"unsupported chart type {t!r}")
    cats = list(spec.get("categories") or [])
    series = list(spec.get("series") or [])
    if not cats or not series:
        raise ValueError("chart spec needs categories and series")
    dl = spec.get("dataLabels") or {}
    va = spec.get("valueAxis") or {}
    ca = spec.get("categoryAxis") or {}
    lg = spec.get("legend") or {}
    font_w = spec.get("fontCssWeight") or 400
    base_face = face_for_weight(font_w)
    num_fmt = dl.get("numberFormat") or va.get("numberFormat") or "General"
    to_emu = (lambda px: int(emu(px))) if callable(emu) else (lambda px: int(round(float(px) * EMU_PER_PX)))

    # ---- 1. data + chart part + embedded workbook (python-pptx) -------------------------------------
    # sanitize: str categories (int/date categories silently become numRef/dateAx), XML-1.0-legal text
    # (a control char raises XMLSyntaxError), finite numbers only (NaN/inf raise in XlsxWriter)
    cats = [clean_text(c) for c in cats]
    cd = CategoryChartData(number_format=num_fmt)
    cd.categories = cats
    used = series[:1] if t in ("pie", "doughnut") else series  # Office displays only the first pie series
    for si, s in enumerate(used):
        vals = list(s.get("values") or [])
        vals = (vals + [None] * len(cats))[:len(cats)]
        cd.add_series(clean_text(s.get("name") or f"계열 {si + 1}"), [clean_number(v) for v in vals],
                      number_format=num_fmt)
    x, y, w, h = (Emu(to_emu(box_px[k])) for k in ("x", "y", "w", "h"))
    gf = slide.shapes.add_chart(_xl_type(spec), x, y, w, h, cd)
    if name:
        gf.name = clean_text(name)[:200]
    # python-pptx's frame template locks grouping (<a:graphicFrameLocks noGrp="1"/>, ECMA §20.1.2.2.19: "cannot be
    # combined within other shapes to form a group"), yet the builder groups the chart with its card. PowerPoint writes
    # chart frames with an empty <p:cNvGraphicFramePr/> (3 of 3 PowerPoint-saved chart decks; noGrp only on tables):
    # drop the lock, so Ungroup / Regroup of the chart card works (fixer round 3, VO-02)
    cnv_gf = gf._element.find(f"{{{NS_P}}}nvGraphicFramePr/{{{NS_P}}}cNvGraphicFramePr")
    if cnv_gf is not None:
        for lock in list(cnv_gf):
            cnv_gf.remove(lock)
    chart = gf.chart
    cs = chart._chartSpace  # c:chartSpace (lxml element)
    c_chart = cs.find(q("c:chart"))
    plotArea = c_chart.find(q("c:plotArea"))
    grp = next(e for e in plotArea if etree.QName(e).localname in _CHART_GROUPS)
    gname = etree.QName(grp).localname
    grouping_xml = grp.find(q("c:grouping")).get("val") if gname == "barChart" else None

    # ---- 2. chart space: lang, roundedCorners, transparent frame, base text ---------------------------
    put(cs, val_el("c:lang", lang))
    put(cs, val_el("c:roundedCorners", "0"))
    put(cs, sp_pr())  # noFill + no border
    put(cs, tx_pr(dl.get("sizePx") or ca.get("sizePx") or DEFAULT_SIZE_PX, text_color, base_face, lang,
                  rot=None))

    # ---- 3. no title (python-pptx API -> c:autoTitleDeleted val=1) ------------------------------------
    chart.has_title = False

    # ---- 4. plot area: manual inner layout + transparent -----------------------------------------------
    if plot_px:
        put(plotArea, _manual_layout(plot_px, box_px))
    put(plotArea, sp_pr())

    # ---- 5. chart group ---------------------------------------------------------------------------------
    plot = chart.plots[0]
    # varyColors written with an explicit val (python-pptx drops val="1" because the schema default is
    # true; readers differ on a bare <c:varyColors/>)
    put(grp, val_el("c:varyColors", "1" if gname in ("pieChart", "doughnutChart") else "0"))
    if gname == "barChart":
        plot.gap_width = max(0, min(500, int(round(spec.get("gapWidth", DEFAULT_GAP_WIDTH)))))
        ov = 100 if grouping_xml in ("stacked", "percentStacked") else \
            max(-100, min(100, int(round(spec.get("overlap", DEFAULT_OVERLAP)))))
        plot.overlap = ov
    elif gname == "lineChart":
        put(grp, val_el("c:marker", "1"))
        put(grp, val_el("c:smooth", "0"))
    else:  # pie / doughnut
        put(grp, val_el("c:firstSliceAng", str(int(round(spec.get("firstSliceAng", 0))) % 360)))
        if gname == "doughnutChart":  # REQUIRED by Office (MS-OI29500 2.1.1458), range 1..90
            put(grp, val_el("c:holeSize", str(max(1, min(90, int(round(
                spec.get("holeSize", DEFAULT_HOLE_SIZE))))))))

    # group-level dLbls: ONLY show* flags (MS-OI29500 2.1.1457)
    g_dl = E("c:dLbls")
    for tag in ("showLegendKey", "showVal", "showCatName", "showSerName", "showPercent",
                "showBubbleSize"):
        etree.SubElement(g_dl, q("c:" + tag), val="0")
    if gname in ("pieChart", "doughnutChart"):
        etree.SubElement(g_dl, q("c:showLeaderLines"), val="0")
    put(grp, g_dl)

    # ---- 6. series --------------------------------------------------------------------------------------
    point_colors = spec.get("pointColors") or {}
    dl_pos = resolve_dlbl_pos(gname, grouping_xml, dl.get("position")) if dl.get("show") else None
    dl_face = face_for_weight(dl.get("cssWeight") or font_w)
    dl_color = norm_color(dl.get("color"), text_color)
    pie_like = gname in ("pieChart", "doughnutChart")
    for si, (ser_obj, s) in enumerate(zip(plot.series, used)):
        ser = ser_obj._element
        color = norm_color(s.get("color"), PALETTE[si % len(PALETTE)])
        if gname == "lineChart":
            put(ser, line_only_sp_pr(color, line_width_px))
            ser_obj.marker.style = XL_MARKER_STYLE.CIRCLE
            ser_obj.marker.size = max(2, min(72, round(marker_px * 0.75)))  # c:size is in points
            mk = ser.find(q("c:marker"))
            put(mk, sp_pr(fill_rgb=color, line_rgb=color, line_w_px=1))
            ser_obj.smooth = False
        elif gname == "barChart":
            put(ser, sp_pr(fill_rgb=color))
            ser_obj.invert_if_negative = False
        else:
            put(ser, sp_pr(fill_rgb=color, line_rgb=None))
        # per-point colours (pie slices; or highlighted bars / markers)
        pcs = list(point_colors.get(str(si)) or point_colors.get(si) or [])
        if pie_like:  # every slice gets an explicit colour: pointColors, else the accent palette
            pcs = [norm_color(pcs[i] if i < len(pcs) else None, PALETTE[i % len(PALETTE)])
                   for i in range(len(cats))]
        for old in ser.findall(q("c:dPt")):
            ser.remove(old)
        last_dpt = None
        for pi, rgb in enumerate(pcs):
            rgb = norm_color(rgb)
            if pi >= len(cats) or not rgb:
                continue
            dpt = E("c:dPt")
            etree.SubElement(dpt, q("c:idx"), val=str(pi))
            if gname == "barChart":
                etree.SubElement(dpt, q("c:invertIfNegative"), val="0")
            if gname == "lineChart":
                m = etree.SubElement(dpt, q("c:marker"))
                etree.SubElement(m, q("c:symbol"), val="circle")
                etree.SubElement(m, q("c:size"), val=str(max(2, min(72, round(marker_px * 0.75)))))
                m.append(sp_pr(fill_rgb=rgb, line_rgb=rgb, line_w_px=1))
            else:
                etree.SubElement(dpt, q("c:bubble3D"), val="0")
                dpt.append(sp_pr(fill_rgb=rgb))
            if last_dpt is not None:  # dPt elements stay together, in idx order
                last_dpt.addnext(dpt)
            else:
                put(ser, dpt, replace=False)
            last_dpt = dpt
        # series-level data labels (numFmt/spPr/txPr/dLblPos allowed only here)
        for old in ser.findall(q("c:dLbls")):
            ser.remove(old)
        if dl.get("show"):
            sdl = E("c:dLbls")
            etree.SubElement(sdl, q("c:numFmt"), formatCode=dl.get("numberFormat") or num_fmt,
                             sourceLinked="0")
            sdl.append(sp_pr())
            sdl.append(tx_pr(dl.get("sizePx") or DEFAULT_SIZE_PX, dl_color, dl_face, lang, rot=0,
                             wrap=False, label_insets=True))
            if dl_pos:
                etree.SubElement(sdl, q("c:dLblPos"), val=dl_pos)
            for tag, v in (("showLegendKey", "0"), ("showVal", "1"), ("showCatName", "0"),
                           ("showSerName", "0"), ("showPercent", "0"), ("showBubbleSize", "0")):
                etree.SubElement(sdl, q("c:" + tag), val=v)
            etree.SubElement(sdl, q("c:showLeaderLines"), val="0")
            put(ser, sdl)

    # ---- 7. axes ----------------------------------------------------------------------------------------
    if gname in ("barChart", "lineChart"):
        _style_axes(chart, spec, plotArea, t, va, ca, base_face, lang, value_range, major_unit, num_fmt,
                    text_color)

    # ---- 8. legend --------------------------------------------------------------------------------------
    pos = lg.get("position") or "none"
    if pos == "none":
        chart.has_legend = False
    else:
        chart.has_legend = True
        chart.legend.position = {"top": XL_LEGEND_POSITION.TOP, "bottom": XL_LEGEND_POSITION.BOTTOM,
                                 "right": XL_LEGEND_POSITION.RIGHT}[pos]
        chart.legend.include_in_layout = False  # c:overlay val=0
        leg = c_chart.find(q("c:legend"))
        put(leg, sp_pr())
        put(leg, tx_pr(lg.get("sizePx") or DEFAULT_SIZE_PX, norm_color(lg.get("color"), text_color),
                       base_face, lang, rot=0))

    # ---- 9. chart-level flags ---------------------------------------------------------------------------
    put(c_chart, val_el("c:plotVisOnly", "1"))
    put(c_chart, val_el("c:dispBlanksAs", "gap"))
    # the value axis is locked to the HTML's scale (explicit c:max, chart-mapping rule 4); a value a user later types
    # above that maximum is drawn clipped at the plot's top edge — with its data label still shown (val="1"), so the
    # real number stays visible and the clipping is noticeable, instead of a label that silently disappears (val="0",
    # "whether to show the data labels when the value is greater than the maximum value on the value axis"). No value
    # of a converted chart exceeds its maximum, so nothing renders differently (fixer round 3, EDIT-04)
    put(c_chart, val_el("c:showDLblsOverMax", "1"))
    for scaling in plotArea.iter(q("c:scaling")):  # explicit orientation like PowerPoint
        if scaling.find(q("c:orientation")) is None:
            put(scaling, val_el("c:orientation", "minMax"))
    _positive_axis_ids(plotArea)
    return gf


def _style_axes(chart, spec, plotArea, t, va, ca, base_face, lang, value_range, major_unit, num_fmt,
                text_color):
    cat_ax = chart.category_axis
    val_ax = chart.value_axis
    c_cat = plotArea.find(q("c:catAx"))
    c_val = plotArea.find(q("c:valAx"))

    vmin = va.get("min")
    vmax = va.get("max")
    if value_range:
        vmin = value_range[0] if value_range[0] is not None else vmin
        vmax = value_range[1] if value_range[1] is not None else vmax

    # horizontal bars: first category on top like the HTML (reverse) and keep the value axis at the bottom
    if t == "bar":
        cat_ax.reverse_order = True
        put(c_val, val_el("c:crosses", "max"))

    # category axis: labels, line, no ticks
    cat_ax.major_tick_mark = XL_TICK_MARK.NONE
    cat_ax.minor_tick_mark = XL_TICK_MARK.NONE
    cat_visible = ca.get("visible", True)
    if not cat_visible:
        cat_ax.tick_label_position = XL_TICK_LABEL_POSITION.NONE
    elif vmin is not None and vmin < 0:  # keep labels at the plot edge, not on the zero line
        cat_ax.tick_label_position = XL_TICK_LABEL_POSITION.LOW
    else:
        cat_ax.tick_label_position = XL_TICK_LABEL_POSITION.NEXT_TO_AXIS
    put(c_cat, E("c:numFmt", formatCode="General", sourceLinked="1"))
    line = norm_color(ca.get("lineColor"))
    put(c_cat, sp_pr(line_rgb=line, line_w_px=1) if line and cat_visible else sp_pr())
    put(c_cat, tx_pr(ca.get("sizePx") or DEFAULT_SIZE_PX, norm_color(ca.get("labelColor"), text_color),
                     base_face, lang, rot=0))
    put(c_cat, val_el("c:tickLblSkip", "1"))  # never let PowerPoint skip labels
    put(c_cat, val_el("c:tickMarkSkip", "1"))

    # value axis: explicit scale, number format, gridlines, no axis line
    if vmin is not None:
        val_ax.minimum_scale = float(vmin)
    if vmax is not None:
        val_ax.maximum_scale = float(vmax)
    val_ax.major_tick_mark = XL_TICK_MARK.NONE
    val_ax.minor_tick_mark = XL_TICK_MARK.NONE
    val_ax.tick_labels.number_format = va.get("numberFormat") or num_fmt
    val_ax.tick_labels.number_format_is_linked = False
    if va.get("visible", False):
        val_ax.tick_label_position = XL_TICK_LABEL_POSITION.NEXT_TO_AXIS
    else:  # keep the axis (scale + editability), hide labels; c:delete stays 0
        val_ax.tick_label_position = XL_TICK_LABEL_POSITION.NONE
    put(c_val, sp_pr())  # no axis line
    put(c_val, tx_pr(ca.get("sizePx") or DEFAULT_SIZE_PX, norm_color(ca.get("labelColor"), text_color),
                     base_face, lang, rot=0))
    gl = va.get("gridlines")
    if gl:
        gl = gl if isinstance(gl, dict) else {}
        val_ax.has_major_gridlines = True
        mg = c_val.find(q("c:majorGridlines"))
        for old in mg.findall(q("c:spPr")):
            mg.remove(old)
        mg.append(line_only_sp_pr(norm_color(gl.get("color"), GRID_COLOR), float(gl.get("widthPx") or 1),
                                  cap="flat"))
    else:
        val_ax.has_major_gridlines = False
    if major_unit:
        val_ax.major_unit = float(major_unit)
    put(c_val, val_el("c:crossBetween", "between"))


def _positive_axis_ids(plotArea):
    """[MS-OI29500] 2.1.1432/2.1.1446: axId/crossAx <= 2147483647 and must match an axis."""
    mapping = {}
    next_id = 100000001
    for el in plotArea.iter(q("c:axId")):
        v = el.get("val")
        if v not in mapping:
            mapping[v] = str(next_id)
            next_id += 1
    for el in list(plotArea.iter(q("c:axId"))) + list(plotArea.iter(q("c:crossAx"))):
        el.set("val", mapping[el.get("val")])
