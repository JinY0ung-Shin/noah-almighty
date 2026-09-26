#!/usr/bin/env python3
"""Editability audit of a built deck against its IR and fonts/fonts.json (the `inspect` and `font-coverage` gates).

    python3 tools/inspect_pptx.py DECK.pptx --ir <IR dir>/ir.json --profile embedded [--out-json F] [--out-txt F]
        -> the text report on stdout; report files ONLY where --out-json / --out-txt say (none by default)
    python3 tools/inspect_pptx.py DECK.pptx --profile embedded --fonts-only   # font gate, no report files

Checks (each finding is ERROR or WARN; exit 1 when there is any ERROR):

* per slide: native text boxes (``p:sp`` with ``txBox="1"``), autoshapes (+ how many carry text), pictures, tables,
  charts, groups, connectors, other graphic frames — groups are descended (group transforms applied);
* every picture with its area; > 20 % of the slide is flagged as possible non-editable content (WARN), except the
  overlay picture (a full-slide picture that is topmost and translucent, or named/described "overlay"/"HTML reference"/
  "HTML 기준");
  picture-filled shapes and image backgrounds are flagged the same way; any overlay picture is flagged too (the
  converter never writes one: a deliverable must not carry a reference image);
* every IR text string is found in the PPTX on the same slide: text-element paragraphs in text boxes/autoshapes,
  table-cell text in table cells, chart categories and series names in the chart caches; match levels ``exact``
  (after whitespace normalisation), ``whitespace`` (equal once all whitespace/line breaks are removed — e.g. the
  builder's hard breaks), ``split`` (inside one shape's text, paragraphing differs), ``elsewhere`` (only in another
  kind of container: WARN), ``missing`` (ERROR); PPTX text the IR does not have is listed (WARN);
* charts: matched to IR chart elements by position; type/grouping; the embedded workbook exists (package relationship,
  xlsx content type), opens with openpyxl, every ``c:f`` resolves to the cached points, and categories, series names
  and values equal the IR ChartSpec;
* fonts: typefaces used by runs (``latin``/``ea``/``cs``) in slides and chart text vs fonts.json — every typeface in the
  profile, ``latin`` = ``ea`` = ``cs``, (typeface, ``b``) is a fonts.json face (no synthetic bold), theme
  major/minor fonts; the faces the IR's weights resolve to (nearest cssWeight, tie -> heavier) vs the faces used;
  ``embedded``: every used typeface/style has an embedded font part whose EOT header parses (tools/eot.py), carries
  FamilyName == typeface and wraps the fonts.json file byte-for-byte; ``malgun``: nothing embedded and no measurement
  substitute (Gothic A1, Selawik, …) named anywhere;
* XML hygiene: unique ``p:cNvPr`` ids per slide (1..2^31-1), 6-hex ``srgbClr`` (slides and charts), no ``p:style`` on
  shapes/pictures/connectors, no line-break/control characters inside ``a:t``.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import io
import json
import posixpath
import re
import sys
import unicodedata
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from lxml import etree

KIT = Path(__file__).resolve().parent.parent   # the converter toolkit (fonts.json paths are relative to it)
POC = KIT                                      # PoC name, kept as an alias
sys.path.insert(0, str(KIT / "tools"))
import eot  # noqa: E402  tools/eot.py
import pdeathsig  # noqa: E402  tools/pdeathsig.py

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
    "ct": "http://schemas.openxmlformats.org/package/2006/content-types",
    "asvg": "http://schemas.microsoft.com/office/drawing/2016/SVG/main",
}
P, A, R, C = (f"{{{NS[k]}}}" for k in ("p", "a", "r", "c"))
EMU_PER_PX = 9525
SLIDE_W, SLIDE_H = 12192000, 6858000
URI_TABLE = "http://schemas.openxmlformats.org/drawingml/2006/table"
URI_CHART = "http://schemas.openxmlformats.org/drawingml/2006/chart"
REL_OFFICE_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
REL_FONT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font"
REL_PACKAGE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/package"
REL_THEME = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme"
REL_MASTER = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"
REL_NOTES = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide"
CT_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
CT_FONTDATA = "application/x-fontdata"
PICTURE_AREA_LIMIT = 0.20
MIN_SUBSTRING = 4  # compact length below which an IR string must match a whole paragraph/cell (no substring luck)
CHART_GROUPS = {"areaChart", "area3DChart", "lineChart", "line3DChart", "stockChart", "radarChart", "scatterChart",
                "pieChart", "pie3DChart", "doughnutChart", "barChart", "bar3DChart", "ofPieChart", "surfaceChart",
                "surface3DChart", "bubbleChart"}
# Names that must never reach a malgun-profile deck: the HTML measurement substitutes (docs/research/fonts.md)
MALGUN_SUBSTITUTES = ("Gothic A1", "Selawik", "PoC Malgun Substitute", "Noto Sans KR", "NotoSansKR")
THEME_REF = {"+mn-lt": ("minor", "latin"), "+mn-ea": ("minor", "ea"), "+mn-cs": ("minor", "cs"),
             "+mj-lt": ("major", "latin"), "+mj-ea": ("major", "ea"), "+mj-cs": ("major", "cs")}
_SPACES = dict.fromkeys(map(ord, "            "
                                 "  　\t"), " ")
_ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍⁠﻿­"), None)


def ln(el) -> str:
    return etree.QName(el).localname if isinstance(el.tag, str) else ""


def px(emu: float) -> float:
    return round(emu / EMU_PER_PX, 2)


# ------------------------------------------------------------------------------------------------ text normalisation
def norm(s: str) -> str:
    s = unicodedata.normalize("NFC", s or "").replace("\r\n", "\n").replace("\r", "\n").replace("\v", "\n")
    s = s.translate(_SPACES).translate(_ZERO_WIDTH)
    s = re.sub(r" +", " ", s)
    s = re.sub(r" *\n *", "\n", s)
    return s.strip()


def compact(s: str) -> str:
    return re.sub(r"\s+", "", norm(s))


def short(s: str, n: int = 60) -> str:
    s = s.replace("\n", "⏎")
    return s if len(s) <= n else s[: n - 1] + "…"


# ------------------------------------------------------------------------------------------------ report
class Report:
    def __init__(self) -> None:
        self.problems: list[dict] = []

    def add(self, severity: str, rule: str, message: str, slide: int | None = None, **extra) -> None:
        item = {"severity": severity, "slide": slide, "rule": rule, "message": message}
        item.update({k: v for k, v in extra.items() if v is not None})
        self.problems.append(item)

    def error(self, rule, message, slide=None, **kw):
        self.add("error", rule, message, slide, **kw)

    def warn(self, rule, message, slide=None, **kw):
        self.add("warn", rule, message, slide, **kw)

    def count(self, sev: str) -> int:
        return sum(1 for p in self.problems if p["severity"] == sev)


# ------------------------------------------------------------------------------------------------ package access
class Package:
    def __init__(self, path: Path):
        self.path = path
        self.zip = zipfile.ZipFile(path)
        self.names = set(self.zip.namelist())
        self._xml: dict[str, etree._Element] = {}
        ct = self.xml("[Content_Types].xml")
        self.defaults = {(d.get("Extension") or "").lower(): d.get("ContentType")
                         for d in ct.iter(f"{{{NS['ct']}}}Default")}
        self.overrides = {(o.get("PartName") or "").lstrip("/"): o.get("ContentType")
                          for o in ct.iter(f"{{{NS['ct']}}}Override")}
        rels = self.rels("")
        main = [t for (typ, t, mode) in rels.values() if typ == REL_OFFICE_DOC and mode != "External"]
        if len(main) != 1:
            raise ValueError(f"{len(main)} officeDocument relationships in _rels/.rels")
        self.main = main[0]

    def read(self, part: str) -> bytes:
        return self.zip.read(part)

    def xml(self, part: str) -> etree._Element:
        if part not in self._xml:
            parser = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True)
            self._xml[part] = etree.fromstring(self.zip.read(part), parser=parser)
        return self._xml[part]

    def rels(self, part: str) -> dict[str, tuple[str, str, str | None]]:
        """rId -> (type, resolved target part name or external URL, TargetMode)."""
        d, f = posixpath.split(part)
        rels_part = posixpath.join(d, "_rels", f + ".rels") if part else "_rels/.rels"
        if rels_part not in self.names:
            return {}
        out = {}
        for rel in self.xml(rels_part).iter(f"{{{NS['pr']}}}Relationship"):
            target, mode = rel.get("Target") or "", rel.get("TargetMode")
            if mode != "External":
                target = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(d, target))
            out[rel.get("Id")] = (rel.get("Type"), target, mode)
        return out

    def content_type(self, part: str) -> str | None:
        if part in self.overrides:
            return self.overrides[part]
        base = posixpath.basename(part)
        return self.defaults.get(base.rsplit(".", 1)[-1].lower() if "." in base else "")


# ------------------------------------------------------------------------------------------------ shape tree
@dataclass
class Item:
    kind: str                 # textBox autoshape picture table chart group connector graphicFrame contentPart
    el: etree._Element
    name: str
    id: int | None
    box: tuple[float, float, float, float]  # EMU, slide coordinates
    rot: float
    depth: int
    top_index: int
    extra: dict = field(default_factory=dict)


def _xfrm_box(xfrm, xf) -> tuple[tuple[float, float, float, float], float]:
    if xfrm is None:
        return (0.0, 0.0, 0.0, 0.0), 0.0
    off, ext = xfrm.find(A + "off"), xfrm.find(A + "ext")
    x = float(off.get("x", 0)) if off is not None else 0.0
    y = float(off.get("y", 0)) if off is not None else 0.0
    cx = float(ext.get("cx", 0)) if ext is not None else 0.0
    cy = float(ext.get("cy", 0)) if ext is not None else 0.0
    sx, sy, tx, ty = xf
    return (sx * x + tx, sy * y + ty, sx * cx, sy * cy), float(xfrm.get("rot", 0)) / 60000.0


def walk_tree(container, xf=(1.0, 1.0, 0.0, 0.0), depth=0, out=None, top=None) -> list[Item]:
    out = [] if out is None else out
    children = [c for c in container if isinstance(c.tag, str)]
    for i, child in enumerate(children):
        top_index = i if top is None else top
        tag = ln(child)
        if tag == "AlternateContent":
            chosen = child.find(f"{{{NS['mc']}}}Fallback")
            if chosen is None:
                chosen = child.find(f"{{{NS['mc']}}}Choice")
            if chosen is not None:
                walk_tree(chosen, xf, depth, out, top_index)
            continue
        nv = next((c for c in child if ln(c).startswith("nv")), None)
        cnv = nv.find(P + "cNvPr") if nv is not None else None
        name = cnv.get("name", "") if cnv is not None else ""
        try:
            sid = int(cnv.get("id")) if cnv is not None and cnv.get("id") is not None else None
        except ValueError:
            sid = None
        if tag == "sp":
            box, rot = _xfrm_box(child.find(f"{P}spPr/{A}xfrm"), xf)
            tx = nv.find(P + "cNvSpPr") if nv is not None else None
            kind = "textBox" if tx is not None and tx.get("txBox") in ("1", "true") else "autoshape"
            out.append(Item(kind, child, name, sid, box, rot, depth, top_index,
                            {"placeholder": nv is not None and nv.find(f"{P}nvPr/{P}ph") is not None}))
        elif tag == "pic":
            box, rot = _xfrm_box(child.find(f"{P}spPr/{A}xfrm"), xf)
            out.append(Item("picture", child, name, sid, box, rot, depth, top_index))
        elif tag == "cxnSp":
            box, rot = _xfrm_box(child.find(f"{P}spPr/{A}xfrm"), xf)
            out.append(Item("connector", child, name, sid, box, rot, depth, top_index))
        elif tag == "graphicFrame":
            box, rot = _xfrm_box(child.find(P + "xfrm"), xf)
            gd = child.find(f"{A}graphic/{A}graphicData")
            uri = gd.get("uri") if gd is not None else None
            kind = {URI_TABLE: "table", URI_CHART: "chart"}.get(uri, "graphicFrame")
            out.append(Item(kind, child, name, sid, box, rot, depth, top_index, {"uri": uri}))
        elif tag == "grpSp":
            xfrm = child.find(f"{P}grpSpPr/{A}xfrm")
            box, rot = _xfrm_box(xfrm, xf)
            out.append(Item("group", child, name, sid, box, rot, depth, top_index))
            nxf = xf
            if xfrm is not None:
                off, ext = xfrm.find(A + "off"), xfrm.find(A + "ext")
                choff, chext = xfrm.find(A + "chOff"), xfrm.find(A + "chExt")
                if None not in (off, ext, choff, chext):
                    gsx = float(ext.get("cx")) / float(chext.get("cx")) if float(chext.get("cx")) else 1.0
                    gsy = float(ext.get("cy")) / float(chext.get("cy")) if float(chext.get("cy")) else 1.0
                    gtx = float(off.get("x")) - float(choff.get("x")) * gsx
                    gty = float(off.get("y")) - float(choff.get("y")) * gsy
                    sx, sy, tx_, ty_ = xf
                    nxf = (sx * gsx, sy * gsy, sx * gtx + tx_, sy * gty + ty_)
            walk_tree(child, nxf, depth + 1, out, top_index)
        elif tag == "contentPart":
            out.append(Item("contentPart", child, name, sid, (0, 0, 0, 0), 0.0, depth, top_index))
    return out


def para_text(p, slide_no: int | None = None) -> str:
    """Displayed text of a paragraph; a slidenum field shows the slide's number (PowerPoint computes it, the cached
    a:t of a layout/master field is '‹#›')."""
    parts = []
    for el in p:
        t = ln(el)
        if t == "fld" and el.get("type") == "slidenum" and slide_no is not None:
            parts.append(str(slide_no))
        elif t in ("r", "fld"):
            te = el.find(A + "t")
            parts.append(te.text or "" if te is not None else "")
        elif t == "br":
            parts.append("\n")
    return "".join(parts)


def txbody_paragraphs(txBody, slide_no: int | None = None) -> list[str]:
    return [para_text(p, slide_no) for p in txBody.findall(A + "p")] if txBody is not None else []


def inherited_items(pkg, slide_part: str, slide_root) -> list:
    """Non-placeholder objects a slide displays from its layout (and the layout's master), honouring
    showMasterSp="0" on the slide / layout: slide chrome the builder moved into a custom layout (footer rule, brand,
    page-number field) is still part of what the slide shows."""
    out = []
    lay = next((t for (typ, t, m) in pkg.rels(slide_part).values() if typ.endswith("/slideLayout")), None)
    if lay is None or lay not in pkg.names or slide_root.get("showMasterSp") in ("0", "false"):
        return out
    lroot = pkg.xml(lay)
    parts = [(lay, lroot)]
    if lroot.get("showMasterSp") not in ("0", "false"):
        mst = next((t for (typ, t, m) in pkg.rels(lay).values() if typ == REL_MASTER), None)
        if mst and mst in pkg.names:
            parts.append((mst, pkg.xml(mst)))
    for part, root in parts:
        tree = root.find(f"{P}cSld/{P}spTree")
        for it in walk_tree(tree) if tree is not None else []:
            if not it.extra.get("placeholder"):
                it.extra["part"] = part
                out.append(it)
    return out


# ------------------------------------------------------------------------------------------------ fonts.json / IR
def load_profile(fonts_json: Path, profile: str) -> dict:
    cfg = json.loads(fonts_json.read_text(encoding="utf-8"))
    try:
        return cfg["profiles"][profile]
    except KeyError as exc:
        raise SystemExit(f"inspect_pptx: error: profile {profile!r} not in {fonts_json}") from exc


def face_for_weight(faces: list[dict], w) -> dict:
    """CONTRACT builder rule: nearest cssWeight, tie -> heavier (a missing/non-numeric weight counts as 400)."""
    try:
        w = float(w)
    except (TypeError, ValueError):
        w = 400.0
    return min(faces, key=lambda f: (abs(f["cssWeight"] - w), -f["cssWeight"]))


def ir_para_text(para: dict) -> str:
    return "".join("\n" if r.get("break") else (r.get("text") or "") for r in para.get("runs") or [])


def ir_strings(slide: dict) -> list[dict]:
    """IR text strings of one slide: {kind: text|table|chart-category|chart-series, source, text}."""
    out = []
    for e in slide.get("elements") or []:
        k = e.get("kind")
        if k == "text":
            for i, para in enumerate(e.get("paragraphs") or []):
                t = ir_para_text(para)
                if norm(t):
                    out.append({"kind": "text", "source": f"{e.get('id')} ¶{i + 1}", "text": t})
        elif k == "table":
            for ri, row in enumerate(e.get("cells") or []):
                for ci, cell in enumerate(row):
                    if cell.get("covered"):
                        continue
                    t = "\n".join(ir_para_text(p) for p in cell.get("paragraphs") or [])
                    if norm(t):
                        out.append({"kind": "table", "source": f"{e.get('id')} [{ri + 1},{ci + 1}]", "text": t})
        elif k == "chart":
            spec = e.get("spec") or {}
            for i, cat in enumerate(spec.get("categories") or []):
                if norm(str(cat)):
                    out.append({"kind": "chart-category", "source": f"{e.get('id')} category {i + 1}", "text": str(cat)})
            for i, s in enumerate(spec.get("series") or []):
                if norm(str(s.get("name") or "")):
                    out.append({"kind": "chart-series", "source": f"{e.get('id')} series {i + 1}", "text": str(s["name"])})
    return out


def ir_expected_faces(slide: dict, faces: list[dict]) -> set[tuple[str, bool]]:
    exp = set()

    def add(w):
        f = face_for_weight(faces, w)
        exp.add((f["typeface"], bool(f["bold"])))

    for e in slide.get("elements") or []:
        paras = []
        if e.get("kind") == "text":
            paras = e.get("paragraphs") or []
        elif e.get("kind") == "table":
            paras = [p for row in e.get("cells") or [] for c in row if not c.get("covered") for p in c.get("paragraphs") or []]
        elif e.get("kind") == "chart":
            spec = e.get("spec") or {}
            add(spec.get("fontCssWeight", 400))
            dl = spec.get("dataLabels") or {}
            if dl.get("show"):
                add(dl.get("cssWeight", spec.get("fontCssWeight", 400)))
        for p in paras:
            for r in p.get("runs") or []:
                if not r.get("break") and (r.get("text") or "").strip():
                    add(r.get("fontWeight", 400))
    return exp


# ------------------------------------------------------------------------------------------------ charts
_REF_RE = re.compile(r"^(?:'((?:[^']|'')+)'|([^'!]+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$")


def chart_type_of(root) -> tuple[str, str | None, list]:
    plot = root.find(f"{C}chart/{C}plotArea")
    groups = [g for g in plot if ln(g) in CHART_GROUPS] if plot is not None else []
    if not groups:
        return "none", None, []
    g = groups[0]
    tag = ln(g)
    grouping = g.find(C + "grouping")
    grouping = grouping.get("val") if grouping is not None else None
    if tag in ("barChart", "bar3DChart"):
        bd = g.find(C + "barDir")
        kind = "bar" if bd is not None and bd.get("val") == "bar" else "column"
    else:
        kind = {"lineChart": "line", "pieChart": "pie", "doughnutChart": "doughnut"}.get(tag, tag)
    return kind, grouping, groups


def _cache_points(cache) -> list:
    if cache is None:
        return []
    ptc = cache.find(C + "ptCount")
    n = int(ptc.get("val")) if ptc is not None else 0
    vals: list = [None] * n
    for pt in cache.findall(C + "pt"):
        i = int(pt.get("idx"))
        v = pt.find(C + "v")
        if i >= len(vals):
            vals.extend([None] * (i + 1 - len(vals)))
        vals[i] = v.text if v is not None else None
    return vals


def _ref_and_cache(el) -> tuple[str | None, list, str]:
    """(formula, cached values, 'str'|'num') of a c:tx / c:cat / c:val element."""
    if el is None:
        return None, [], "none"
    for tag, kind in (("strRef", "str"), ("numRef", "num"), ("multiLvlStrRef", "str")):
        ref = el.find(C + tag)
        if ref is not None:
            f = ref.find(C + "f")
            cache = ref.find(C + ("strCache" if tag == "strRef" else "numCache" if tag == "numRef" else "multiLvlStrCache"))
            if tag == "multiLvlStrRef" and cache is not None:
                lvl = cache.find(C + "lvl")
                vals = _cache_points(lvl) if lvl is not None else []
                ptc = cache.find(C + "ptCount")
                if ptc is not None and len(vals) < int(ptc.get("val")):
                    vals += [None] * (int(ptc.get("val")) - len(vals))
            else:
                vals = _cache_points(cache)
            return (f.text if f is not None else None), vals, kind
    for tag, kind in (("strLit", "str"), ("numLit", "num")):
        lit = el.find(C + tag)
        if lit is not None:
            return None, _cache_points(lit), kind
    v = el.find(C + "v")
    if v is not None:
        return None, [v.text], "str"
    return None, [], "none"


def resolve_ref(wb, ref: str) -> list:
    from openpyxl.utils import column_index_from_string
    m = _REF_RE.match(ref.strip())
    if not m:
        raise ValueError(f"unsupported reference {ref!r}")
    sheet = m.group(1).replace("''", "'") if m.group(1) else m.group(2)
    if sheet not in wb.sheetnames:
        raise ValueError(f"sheet {sheet!r} not in workbook {wb.sheetnames}")
    ws = wb[sheet]
    c1, r1 = column_index_from_string(m.group(3)), int(m.group(4))
    c2 = column_index_from_string(m.group(5)) if m.group(5) else c1
    r2 = int(m.group(6)) if m.group(6) else r1
    return [cell for row in ws.iter_rows(min_row=r1, max_row=r2, min_col=c1, max_col=c2, values_only=True)
            for cell in row]


def _num(v):
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return v


def same_number(a, b) -> bool:
    a, b = _num(a), _num(b)
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, float) and isinstance(b, float):
        return abs(a - b) <= 1e-9 * max(1.0, abs(a))
    return str(a) == str(b)


def cell_str(v) -> str:
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return "" if v is None else str(v)


def inspect_chart(pkg: Package, slide_part: str, item: Item, spec: dict | None, rep: Report, sidx: int) -> dict:
    info: dict = {"name": item.name, "id": item.id, "boxPx": _box_px(item.box)}
    gd = item.el.find(f"{A}graphic/{A}graphicData")
    cref = gd.find(C + "chart") if gd is not None else None
    rid = cref.get(R + "id") if cref is not None else None
    rel = pkg.rels(slide_part).get(rid)
    if rel is None or rel[1] not in pkg.names:
        rep.error("chart-part-missing", f"chart '{item.name}': r:id {rid} does not resolve to a chart part", sidx)
        info["error"] = "chart part missing"
        return info
    part = rel[1]
    info["part"] = part
    root = pkg.xml(part)
    kind, grouping, groups = chart_type_of(root)
    info.update({"type": kind, "grouping": grouping})
    series = []
    for g in groups:
        for ser in g.findall(C + "ser"):
            nf, nv, _ = _ref_and_cache(ser.find(C + "tx"))
            cf, cv, ck = _ref_and_cache(ser.find(C + "cat"))
            vf, vv, _ = _ref_and_cache(ser.find(C + "val"))
            series.append({"name": nv[0] if nv else None, "nameRef": nf, "catRef": cf, "categories": cv,
                           "valRef": vf, "values": [_num(v) for v in vv]})
    info["series"] = [{"name": s["name"], "values": s["values"]} for s in series]
    info["categories"] = series[0]["categories"] if series else []
    # ---- embedded workbook
    wbinfo: dict = {"readable": False}
    info["workbook"] = wbinfo
    ed = root.find(C + "externalData")
    wb = None
    if ed is None:
        rep.error("chart-no-workbook", f"chart '{item.name}' ({part}) has no c:externalData: Edit Data cannot work", sidx)
    else:
        erel = pkg.rels(part).get(ed.get(R + "id"))
        if erel is None:
            rep.error("chart-no-workbook", f"chart '{item.name}': externalData r:id {ed.get(R + 'id')} has no relationship", sidx)
        elif erel[2] == "External" or erel[0] != REL_PACKAGE:
            rep.error("chart-workbook-not-embedded", f"chart '{item.name}': externalData is {erel[0]} "
                      f"({'external link' if erel[2] == 'External' else 'not a package'}), not an embedded workbook", sidx)
            wbinfo["target"] = erel[1]
        elif erel[1] not in pkg.names:
            rep.error("chart-no-workbook", f"chart '{item.name}': embedded workbook {erel[1]} is missing", sidx)
        else:
            wbinfo["part"] = erel[1]
            wbinfo["contentType"] = pkg.content_type(erel[1])
            if wbinfo["contentType"] != CT_XLSX:
                rep.error("chart-workbook-content-type", f"chart '{item.name}': workbook content type "
                          f"{wbinfo['contentType']!r}, expected xlsx", sidx)
            try:
                import openpyxl
                wb = openpyxl.load_workbook(io.BytesIO(pkg.read(erel[1])), data_only=True)
                wbinfo["readable"] = True
                wbinfo["sheets"] = wb.sheetnames
            except Exception as exc:  # noqa: BLE001 - any failure = not editable
                rep.error("chart-workbook-unreadable", f"chart '{item.name}': openpyxl cannot read {erel[1]}: "
                          f"{type(exc).__name__}: {exc}", sidx)
    # every c:f must resolve to the cached points
    if wb is not None:
        bad = []
        n_refs = 0
        for s in series:
            for ref, cached in ((s["nameRef"], [s["name"]]), (s["catRef"], s["categories"]), (s["valRef"], s["values"])):
                if not ref:
                    continue
                n_refs += 1
                try:
                    cells = resolve_ref(wb, ref)
                except (ValueError, KeyError) as exc:
                    bad.append(f"{ref}: {exc}")
                    continue
                if len(cells) != len(cached) or not all(same_number(a, b) if isinstance(_num(b), float) or b is None
                                                        else cell_str(a) == str(b) for a, b in zip(cells, cached)):
                    bad.append(f"{ref}: workbook {[cell_str(c) for c in cells][:8]} != cache {cached[:8]}")
        wbinfo["refsChecked"] = n_refs
        wbinfo["cacheMatchesWorkbook"] = not bad
        for b in bad[:5]:
            rep.error("chart-cache-vs-workbook", f"chart '{item.name}': {b}", sidx)
        # workbook values as the spec sees them
        wb_series = []
        for s in series:
            try:
                name = cell_str(resolve_ref(wb, s["nameRef"])[0]) if s["nameRef"] else s["name"]
                cats = [cell_str(v) for v in resolve_ref(wb, s["catRef"])] if s["catRef"] else s["categories"]
                vals = [_num(v) for v in resolve_ref(wb, s["valRef"])] if s["valRef"] else s["values"]
            except (ValueError, KeyError, IndexError):
                name, cats, vals = s["name"], s["categories"], s["values"]
            wb_series.append({"name": name, "categories": cats, "values": vals})
        wbinfo["series"] = wb_series
    # ---- vs the IR ChartSpec
    if spec is not None:
        mism = []
        want_type = spec.get("type")
        if want_type != kind:
            mism.append(f"type {kind!r} != spec {want_type!r}")
        if kind in ("column", "bar"):
            want_g = spec.get("grouping") or "clustered"
            if (grouping or "clustered") != want_g:
                mism.append(f"grouping {grouping!r} != spec {want_g!r}")
        sseries = spec.get("series") or []
        src = wbinfo.get("series") if wb is not None else None
        if len(series) != len(sseries):
            mism.append(f"{len(series)} series != spec {len(sseries)}")
        want_cats = [str(c) for c in spec.get("categories") or []]
        for i, (ss, ps) in enumerate(zip(sseries, series)):
            for label, data in (("cache", ps), ("workbook", src[i] if src else None)):
                if data is None:
                    continue
                if norm(str(data["name"] or "")) != norm(str(ss.get("name") or "")):
                    mism.append(f"series {i + 1} name ({label}) {data['name']!r} != spec {ss.get('name')!r}")
                if [norm(cell_str(c)) for c in data["categories"]] != [norm(c) for c in want_cats]:
                    mism.append(f"series {i + 1} categories ({label}) {data['categories'][:6]} != spec {want_cats[:6]}")
                sv = list(ss.get("values") or [])
                dv = list(data["values"])
                if len(sv) != len(dv) or not all(same_number(a, b) for a, b in zip(sv, dv)):
                    mism.append(f"series {i + 1} values ({label}) {dv[:8]} != spec {sv[:8]}")
        info["matchesSpec"] = not mism
        info["specMismatches"] = mism
        for m in mism[:8]:
            rep.error("chart-vs-spec", f"chart '{item.name}': {m}", sidx)
    return info


# ------------------------------------------------------------------------------------------------ helpers
def _box_px(box) -> dict:
    return {"x": px(box[0]), "y": px(box[1]), "w": px(box[2]), "h": px(box[3])}


def _iou(a, b) -> float:
    ax0, ay0, ax1, ay1 = a[0], a[1], a[0] + a[2], a[1] + a[3]
    bx0, by0, bx1, by1 = b[0], b[1], b[0] + b[2], b[1] + b[3]
    iw, ih = max(0.0, min(ax1, bx1) - max(ax0, bx0)), max(0.0, min(ay1, by1) - max(ay0, by0))
    inter = iw * ih
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def blip_alpha(blip) -> float:
    if blip is None:
        return 1.0
    amf = blip.find(A + "alphaModFix")
    return int(amf.get("amt", 100000)) / 100000.0 if amf is not None else 1.0


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ------------------------------------------------------------------------------------------------ fonts
@dataclass
class FontUse:
    kind: str          # run br endPara chartText chartRun
    latin: str | None
    ea: str | None
    cs: str | None
    bold: bool | None  # None = inherited
    italic: bool
    slide: int | None


def rpr_uses(root, slide: int | None, chart: bool) -> list[FontUse]:
    out = []
    for el in root.iter(A + "rPr", A + "endParaRPr", A + "defRPr"):
        parent = el.getparent()
        tag, ptag = ln(el), ln(parent)
        if chart:
            if tag == "defRPr" and any(ln(a) == "txPr" for a in el.iterancestors()):
                kind = "chartText"
            elif tag == "rPr":
                kind = "chartRun"
            else:
                continue
        else:
            if tag == "rPr" and ptag in ("r", "fld"):
                kind = "run"
            elif tag == "rPr" and ptag == "br":
                kind = "br"
            elif tag == "endParaRPr":
                kind = "endPara"
            else:
                continue  # defRPr in slide-level list styles
        tf = {}
        for slot in ("latin", "ea", "cs"):
            e = el.find(A + slot)
            tf[slot] = e.get("typeface") if e is not None else None
        b = el.get("b")
        out.append(FontUse(kind, tf["latin"], tf["ea"], tf["cs"],
                           None if b is None else b in ("1", "true"), el.get("i") in ("1", "true"), slide))
    # runs without any rPr inherit everything
    if not chart:
        for r in root.iter(A + "r"):
            if r.find(A + "rPr") is None:
                out.append(FontUse("run", None, None, None, None, False, slide))
    return out


def theme_fonts(pkg: Package) -> tuple[dict, list[str]]:
    """{major|minor: {latin, ea, cs, scripts{script: typeface}}} of the first master's theme, and the theme part."""
    pres_rels = pkg.rels(pkg.main)
    masters = [t for (typ, t, m) in pres_rels.values() if typ == REL_MASTER]
    themes = []
    for mst in masters:
        themes += [t for (typ, t, m) in pkg.rels(mst).values() if typ == REL_THEME and t in pkg.names]
    if not themes:
        themes = [t for (typ, t, m) in pres_rels.values() if typ == REL_THEME and t in pkg.names]
    out = {}
    if themes:
        root = pkg.xml(themes[0])
        for which in ("major", "minor"):
            f = root.find(f".//{A}fontScheme/{A}{which}Font")
            if f is None:
                continue
            d = {}
            for slot in ("latin", "ea", "cs"):
                e = f.find(A + slot)
                d[slot] = e.get("typeface") if e is not None else None
            d["scripts"] = {e.get("script"): e.get("typeface") for e in f.findall(A + "font")}
            out[which] = d
    return out, sorted(set(themes))


def resolve_theme_ref(tf: str | None, slot: str, theme: dict) -> str | None:
    if tf is None:
        return None
    if tf in THEME_REF:
        which, s = THEME_REF[tf]
        return (theme.get(which) or {}).get(s)
    return tf


# ------------------------------------------------------------------------------------------------ the audit
def inspect(pptx: Path, profile: str, ir_path: Path | None, fonts_json: Path, *, fonts_only: bool = False) -> dict:
    rep = Report()
    prof = load_profile(fonts_json, profile)
    faces = prof.get("faces") or []
    allowed_tf = {f["typeface"] for f in faces}
    allowed_faces = {(f["typeface"], bool(f["bold"]), bool(f.get("italic"))) for f in faces}
    regular = next((f["typeface"] for f in sorted(faces, key=lambda f: abs(f["cssWeight"] - 400))
                    if f.get("slot") == "regular"), faces[0]["typeface"] if faces else None)
    doc: dict = {"tool": "tools/inspect_pptx.py",
                 "createdAt": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
                 "pptx": _rel(pptx), "profile": profile, "ir": _rel(ir_path) if ir_path else None,
                 "fontsJson": _rel(fonts_json)}
    try:
        raw = pptx.read_bytes()
        doc["sha256"] = sha256(raw)
        pkg = Package(pptx)
    except (OSError, zipfile.BadZipFile, KeyError, ValueError, etree.XMLSyntaxError) as exc:
        rep.error("package-unreadable", f"cannot open {pptx} as an OOXML package: {exc}")
        doc.update({"problems": rep.problems, "summary": {"errors": 1, "warnings": 0, "verdict": "FAIL"}})
        return doc
    ir = None
    if ir_path is not None:
        try:
            ir = json.loads(ir_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            rep.error("ir-unreadable", f"cannot read IR {ir_path}: {exc}")
        if ir is not None and ir.get("profile") not in (None, profile):
            rep.error("ir-profile", f"IR profile is {ir.get('profile')!r}, not {profile!r}")
    ir_slides = sorted((ir or {}).get("slides") or [], key=lambda s: s.get("index", 0))

    # ---- deck level
    pres = pkg.xml(pkg.main)
    pres_rels = pkg.rels(pkg.main)
    sz = pres.find(P + "sldSz")
    cx, cy = (int(sz.get("cx")), int(sz.get("cy"))) if sz is not None else (0, 0)
    slide_parts = []
    for sid in pres.iter(P + "sldId"):
        rel = pres_rels.get(sid.get(R + "id"))
        slide_parts.append(rel[1] if rel else None)
    deck = {"slideSizeEmu": [cx, cy], "slides": len(slide_parts), "irSlides": len(ir_slides) if ir else None}
    doc["deck"] = deck
    if (cx, cy) != (SLIDE_W, SLIDE_H):
        rep.error("slide-size", f"slide size {cx}x{cy} EMU, CONTRACT is {SLIDE_W}x{SLIDE_H} (1280x720 px)")
    if ir and len(ir_slides) != len(slide_parts):
        rep.error("slide-count", f"PPTX has {len(slide_parts)} slides, IR has {len(ir_slides)}")
    if not fonts_only:
        try:
            from pptx import Presentation
            Presentation(str(pptx))
            deck["pythonPptxOpens"] = True
        except Exception as exc:  # noqa: BLE001
            deck["pythonPptxOpens"] = False
            rep.error("python-pptx-open", f"python-pptx cannot open the deck: {type(exc).__name__}: {exc}")
        lint = [l for l in (ir or {}).get("lint") or [] if l.get("severity") == "error"]
        if lint:
            rep.warn("ir-lint", f"IR carries {len(lint)} extractor lint error(s) (not convertible to native objects): "
                     + "; ".join(f"slide {l.get('slide')} {l.get('rule')}" for l in lint[:5]))

    theme, theme_parts = theme_fonts(pkg)
    uses: list[FontUse] = []
    slides_out = []
    overlay_total = 0
    for sidx, part in enumerate(slide_parts, 1):
        irs = ir_slides[sidx - 1] if sidx - 1 < len(ir_slides) else None
        srow: dict = {"index": sidx, "name": (irs or {}).get("name"), "part": part}
        slides_out.append(srow)
        if part is None or part not in pkg.names:
            rep.error("slide-part-missing", f"slide {sidx}: part {part} missing", sidx)
            continue
        root = pkg.xml(part)
        srels = pkg.rels(part)
        tree = root.find(f"{P}cSld/{P}spTree")
        items = walk_tree(tree) if tree is not None else []
        top_count = len([c for c in tree if isinstance(c.tag, str) and ln(c) not in ("nvGrpSpPr", "grpSpPr", "extLst")]) \
            if tree is not None else 0
        if root.get("show") in ("0", "false"):
            rep.warn("hidden-slide", f"slide {sidx} is hidden (show=0): slide shows and LibreOffice's PDF export skip it",
                     sidx)
        # fonts used on this slide (+ its charts)
        uses += rpr_uses(root, sidx, chart=False)
        chart_items = [it for it in items if it.kind == "chart"]
        for it in chart_items:
            gd = it.el.find(f"{A}graphic/{A}graphicData")
            cref = gd.find(C + "chart") if gd is not None else None
            rel = srels.get(cref.get(R + "id")) if cref is not None else None
            if rel and rel[1] in pkg.names:
                uses += rpr_uses(pkg.xml(rel[1]), sidx, chart=True)
        if fonts_only:
            continue

        # ---- counts
        cnt = Counter(it.kind for it in items)
        counts = {"textBoxes": cnt["textBox"], "autoshapes": cnt["autoshape"],
                  "autoshapesWithText": sum(1 for it in items if it.kind == "autoshape"
                                            and any(norm(t) for t in txbody_paragraphs(it.el.find(P + "txBody")))),
                  "pictures": cnt["picture"], "tables": cnt["table"], "charts": cnt["chart"], "groups": cnt["group"],
                  "connectors": cnt["connector"], "otherGraphicFrames": cnt["graphicFrame"] + cnt["contentPart"],
                  "placeholders": sum(1 for it in items if it.extra.get("placeholder"))}
        srow["counts"] = counts
        if counts["otherGraphicFrames"]:
            uris = sorted({str(it.extra.get("uri")) for it in items if it.kind in ("graphicFrame", "contentPart")})
            rep.warn("other-graphic-frame", f"slide {sidx}: {counts['otherGraphicFrames']} graphic frame(s) that are "
                     f"neither table nor chart ({uris}) — SmartArt/OLE/ink are not the PoC's native objects", sidx)

        # ---- background
        bg = root.find(f"{P}cSld/{P}bg")
        bginfo = {"type": "inherited"}
        if bg is not None:
            bgpr = bg.find(P + "bgPr")
            if bgpr is not None:
                fill = next((ln(c) for c in bgpr if ln(c).endswith("Fill")), "none")
                bginfo = {"type": {"solidFill": "solid", "gradFill": "gradient", "blipFill": "image",
                                   "pattFill": "pattern", "noFill": "none", "grpFill": "group"}.get(fill, fill)}
            elif bg.find(P + "bgRef") is not None:
                bginfo = {"type": "themeRef"}
        srow["background"] = bginfo
        if bginfo["type"] == "image":
            rep.warn("background-image", f"slide {sidx}: the slide background is a picture (possible flattened, "
                     "non-editable content)", sidx)

        # ---- pictures (p:pic, and shapes filled with a picture)
        pics = []
        slide_area = float(cx * cy) if cx and cy else float(SLIDE_W * SLIDE_H)
        for it in items:
            blip = None
            if it.kind == "picture":
                blip = it.el.find(f"{P}blipFill/{A}blip")
            elif it.kind in ("autoshape", "textBox"):
                bf = it.el.find(f"{P}spPr/{A}blipFill")
                if bf is None:
                    continue
                blip = bf.find(A + "blip")
            else:
                continue
            nv = it.el.find(f"{P}nvPicPr/{P}cNvPr") if it.kind == "picture" else it.el.find(f"{P}nvSpPr/{P}cNvPr")
            descr = nv.get("descr", "") if nv is not None else ""
            vis_w = max(0.0, min(it.box[0] + it.box[2], cx) - max(it.box[0], 0))
            vis_h = max(0.0, min(it.box[1] + it.box[3], cy) - max(it.box[1], 0))
            area = vis_w * vis_h / slide_area
            alpha = blip_alpha(blip)
            named = bool(re.search(r"overlay|html reference|html 기준", f"{it.name} {descr}", re.I))
            topmost = it.depth == 0 and it.top_index == top_count - 1
            overlay = area >= 0.95 and ((topmost and alpha < 1.0) or named)
            rid = blip.get(R + "embed") if blip is not None else None
            rel = srels.get(rid) if rid else None
            img = {"part": rel[1] if rel else None, "contentType": pkg.content_type(rel[1]) if rel else None}
            if rel and rel[1] in pkg.names:
                try:
                    from PIL import Image
                    with Image.open(io.BytesIO(pkg.read(rel[1]))) as im:
                        img["pixelSize"] = list(im.size)
                except Exception:  # noqa: BLE001
                    img["pixelSize"] = None
            elif rid:
                rep.error("picture-missing-media", f"slide {sidx}: picture '{it.name}' r:embed {rid} does not resolve", sidx)
            svg = blip is not None and blip.find(f".//{{{NS['asvg']}}}svgBlip") is not None
            prow = {"name": it.name, "id": it.id, "kind": "picture" if it.kind == "picture" else "pictureFill",
                    "descr": descr, "boxPx": _box_px(it.box), "areaPct": round(area * 100, 2), "alpha": round(alpha, 4),
                    "overlay": overlay, "svg": svg, "image": img, "flag": None}
            if overlay:
                overlay_total += 1
            elif area > PICTURE_AREA_LIMIT:
                prow["flag"] = "large"
                rep.warn("large-picture", f"slide {sidx}: picture '{it.name}' covers {area * 100:.1f}% of the slide "
                         f"(> {PICTURE_AREA_LIMIT * 100:.0f}%): possible non-editable content", sidx)
            pics.append(prow)
        srow["pictures"] = pics
        srow["rasterCoveragePct"] = round(sum(p_["areaPct"] for p_ in pics if not p_["overlay"]), 2)
        if irs is not None:
            ir_kinds = Counter(e.get("kind") for e in irs.get("elements") or [])
            n_pics = sum(1 for p_ in pics if not p_["overlay"])
            if n_pics > ir_kinds["image"]:
                rep.warn("extra-picture", f"slide {sidx}: {n_pics} picture(s) but the IR has {ir_kinds['image']} image "
                         "element(s) — something was rasterised instead of built natively", sidx)
            if counts["tables"] < ir_kinds["table"]:
                rep.error("table-missing", f"slide {sidx}: the IR has {ir_kinds['table']} table(s), the PPTX "
                          f"{counts['tables']} native table(s)", sidx)

        # ---- PPTX text inventory (the slide's own objects + the non-placeholder objects of its layout/master)
        sp_texts = []   # (shape name, [paragraph texts])
        tbl_cells = []  # (shape name, cell text)
        chart_texts = []  # (chart name, text, 'category'|'series')
        inh = inherited_items(pkg, part, root)
        srow["inherited"] = {"objects": len(inh), "parts": sorted({it.extra["part"] for it in inh}),
                             "textBoxes": sum(1 for it in inh if it.kind == "textBox")}
        for it in items + [x for x in inh if x.kind in ("textBox", "autoshape")]:
            if it.kind in ("textBox", "autoshape"):
                paras = txbody_paragraphs(it.el.find(P + "txBody"), sidx)
                if "part" in it.extra:
                    it = Item(it.kind, it.el, f"{it.extra['part'].rsplit('/', 1)[-1]}: {it.name}", it.id, it.box, it.rot,
                              it.depth, it.top_index, it.extra)
                if any(norm(t) for t in paras):
                    sp_texts.append((it.name, paras))
                for t in it.el.iter(A + "t"):
                    if t.text and re.search(r"[\n\r\v\t\x00-\x08\x0b\x0c\x0e-\x1f]", t.text):
                        rep.warn("control-char-in-text", f"slide {sidx}: '{it.name}' has a line break/control character "
                                 f"inside a:t ({short(t.text)!r}); use a:br / separate paragraphs", sidx)
            elif it.kind == "table":
                for tc in it.el.iter(A + "tc"):
                    t = "\n".join(txbody_paragraphs(tc.find(A + "txBody")))
                    if norm(t):
                        tbl_cells.append((it.name, t))
        chart_rows = []
        ir_charts = [e for e in (irs or {}).get("elements") or [] if e.get("kind") == "chart"]
        # pair PPTX charts with IR charts by position (greedy IoU), falling back to order
        pairs: dict[int, dict] = {}
        free = list(range(len(ir_charts)))
        for ci, it in enumerate(chart_items):
            best, best_iou = None, 0.0
            for j in free:
                b = ir_charts[j].get("box") or {}
                iou = _iou(it.box, (b.get("x", 0) * EMU_PER_PX, b.get("y", 0) * EMU_PER_PX,
                                    b.get("w", 0) * EMU_PER_PX, b.get("h", 0) * EMU_PER_PX))
                if iou > best_iou:
                    best, best_iou = j, iou
            if best is None and free:
                best = free[0]
            if best is not None:
                free.remove(best)
                pairs[ci] = {"ir": ir_charts[best], "iou": round(best_iou, 3)}
        for ci, it in enumerate(chart_items):
            pr = pairs.get(ci)
            spec = (pr["ir"].get("spec") if pr else None) if ir else None
            row = inspect_chart(pkg, part, it, spec, rep, sidx)
            if pr:
                row["irElement"] = pr["ir"].get("id")
                row["iou"] = pr["iou"]
                if pr["iou"] < 0.5:
                    rep.warn("chart-position", f"slide {sidx}: chart '{it.name}' overlaps its IR chart "
                             f"{pr['ir'].get('id')} with IoU {pr['iou']}", sidx)
            elif ir:
                rep.error("chart-extra", f"slide {sidx}: chart '{it.name}' has no IR chart element", sidx)
            chart_rows.append(row)
            for s in row.get("series") or []:
                if s.get("name"):
                    chart_texts.append((it.name, str(s["name"]), "series"))
            for c in row.get("categories") or []:
                if c is not None:
                    chart_texts.append((it.name, str(c), "category"))
        for j in free:
            rep.error("chart-missing", f"slide {sidx}: IR chart {ir_charts[j].get('id')} has no native chart in the PPTX",
                      sidx)
        srow["charts"] = chart_rows

        # ---- IR text strings vs PPTX
        if irs is not None:
            sp_para_exact = {}
            sp_para_compact = {}
            sp_whole_compact = []
            for name, paras in sp_texts:
                for t in paras:
                    if norm(t):
                        sp_para_exact.setdefault(norm(t), name)
                        sp_para_compact.setdefault(compact(t), name)
                sp_whole_compact.append((name, compact("\n".join(paras))))
            cell_exact = {norm(t): n for n, t in tbl_cells}
            cell_compact = {compact(t): n for n, t in tbl_cells}
            cell_whole = [(n, compact(t)) for n, t in tbl_cells]
            chart_exact = {norm(t): n for n, t, _ in chart_texts}
            chart_compact = {compact(t): n for n, t, _ in chart_texts}
            everything = compact("\n".join(["\n".join(p) for _, p in sp_texts] + [t for _, t in tbl_cells]
                                           + [t for _, t, _ in chart_texts]))
            results = []
            for s in ir_strings(irs):
                t, k = s["text"], s["kind"]
                nt, ct = norm(t), compact(t)
                match, where = "missing", None
                if k == "text":
                    tables = ((sp_para_exact, "exact"), (sp_para_compact, "whitespace"))
                    whole = sp_whole_compact
                elif k == "table":
                    tables = ((cell_exact, "exact"), (cell_compact, "whitespace"))
                    whole = cell_whole
                else:
                    tables = ((chart_exact, "exact"), (chart_compact, "whitespace"))
                    whole = []
                for d, level in tables:
                    key = nt if level == "exact" else ct
                    if key in d:
                        match, where = level, d[key]
                        break
                if match == "missing" and len(ct) >= MIN_SUBSTRING:  # short strings must match a whole paragraph/cell
                    hit = next((n for n, wc in whole if ct in wc), None)
                    if hit is not None:
                        match, where = "split", hit
                    elif ct in everything:
                        match = "elsewhere"
                results.append({**s, "match": match, "foundIn": where})
                if match == "missing":
                    rep.error("text-missing", f"slide {sidx}: IR {k} string {short(t)!r} ({s['source']}) not found in the "
                              "PPTX", sidx)
                elif match == "elsewhere":
                    rep.warn("text-elsewhere", f"slide {sidx}: IR {k} string {short(t)!r} ({s['source']}) only found in "
                             "another kind of object", sidx)
            # PPTX text the IR does not have
            ir_all = [compact(s["text"]) for s in ir_strings(irs)]
            ir_set = set(ir_all)
            extra = []
            for name, paras in sp_texts:
                for t in paras:
                    c_ = compact(t)
                    if c_ and c_ not in ir_set and not any(c_ in x for x in ir_all):
                        extra.append({"shape": name, "text": t})
            for name, t in tbl_cells:
                c_ = compact(t)
                if c_ and c_ not in ir_set and not any(c_ in x for x in ir_all):
                    extra.append({"shape": name, "text": t})
            for e in extra:
                rep.warn("text-extra", f"slide {sidx}: PPTX text {short(e['text'])!r} in '{e['shape']}' is not in the IR",
                         sidx)
            lv = Counter(r["match"] for r in results)
            srow["text"] = {"irStrings": len(results), "found": len(results) - lv["missing"],
                            "byMatch": dict(lv), "strings": results, "extraText": extra}
            # notes (informational)
            if irs.get("notes"):
                nrel = next((t for (typ, t, m) in srels.values() if typ == REL_NOTES), None)
                ntext = ""
                if nrel and nrel in pkg.names:
                    ntext = "\n".join(para_text(p) for p in pkg.xml(nrel).iter(A + "p"))
                srow["notes"] = {"ir": True, "found": bool(ntext) and compact(irs["notes"]) in compact(ntext)}
                if not srow["notes"]["found"]:
                    rep.warn("notes-missing", f"slide {sidx}: IR speaker notes not found in the PPTX notes", sidx)

        # ---- hygiene
        ids = [int(c.get("id")) for c in root.iter(P + "cNvPr") if (c.get("id") or "").lstrip("-").isdigit()]
        dup = sorted(i for i, n in Counter(ids).items() if n > 1)
        if dup:
            rep.error("duplicate-id", f"slide {sidx}: duplicate cNvPr ids {dup}", sidx)
        badid = [i for i in ids if not 1 <= i <= 2147483647]
        if badid:
            rep.error("id-range", f"slide {sidx}: cNvPr ids outside 1..2^31-1: {badid}", sidx)
        colour_parts = [(part, root)] + [(r_[1], pkg.xml(r_[1])) for r_ in srels.values()
                                         if r_[1].startswith("ppt/charts/") and r_[1].endswith(".xml") and r_[1] in pkg.names]
        bad_colours = []
        for pn, xr in colour_parts:
            for c in xr.iter(A + "srgbClr"):
                v = c.get("val") or ""
                if not re.fullmatch(r"[0-9A-Fa-f]{6}", v):
                    bad_colours.append(f"{pn}:{v!r}")
        if bad_colours:
            rep.error("bad-colour", f"slide {sidx}: srgbClr values that are not 6 hex digits: {bad_colours[:6]}", sidx)
        styled = [it.name for it in items if it.kind in ("textBox", "autoshape", "picture", "connector")
                  and it.el.find(P + "style") is not None]
        if styled:
            rep.error("p-style", f"slide {sidx}: {len(styled)} shape(s) keep p:style (theme fill/line/shadow leak): "
                      f"{styled[:6]}", sidx)
        scheme = sum(1 for _ in root.iter(A + "schemeClr"))
        srow["hygiene"] = {"cNvPrIds": len(ids), "duplicateIds": dup, "badColours": bad_colours[:20],
                           "pStyle": styled, "schemeClrRefs": scheme}
        off = [it.name for it in items if it.depth == 0 and it.kind != "group" and
               (it.box[0] < -EMU_PER_PX or it.box[1] < -EMU_PER_PX or it.box[0] + it.box[2] > cx + EMU_PER_PX
                or it.box[1] + it.box[3] > cy + EMU_PER_PX)]
        if off:
            rep.warn("off-slide", f"slide {sidx}: {len(off)} object(s) extend past the slide edge: {off[:6]}", sidx)
        rot_frames = [it.name for it in items if it.kind in ("table", "chart") and it.rot]
        if rot_frames:
            rep.warn("rotated-frame", f"slide {sidx}: rotation on graphic frames is ignored by Office: {rot_frames}", sidx)

        # ---- expected vs used faces on this slide
        if irs is not None and faces:
            exp = ir_expected_faces(irs, faces)
            used = set()
            for u in uses:
                if u.slide == sidx and u.kind in ("run", "chartText", "chartRun"):
                    tf = resolve_theme_ref(u.latin or u.ea, "latin", theme)
                    if tf:
                        used.add((tf, bool(u.bold)))
            srow["faces"] = {"expectedFromIr": sorted(map(list, exp)), "usedByRuns": sorted(map(list, used))}
            for tf, b in sorted(exp - used):
                rep.warn("face-not-used", f"slide {sidx}: the IR's weights resolve to {tf!r}{' bold' if b else ''} but no "
                         "run on the slide uses it (weight mapping?)", sidx)
            for tf, b in sorted((used - exp) & {(f['typeface'], bool(f['bold'])) for f in faces}):
                rep.warn("face-unexpected", f"slide {sidx}: runs use {tf!r}{' bold' if b else ''}, which no IR weight on "
                         "the slide resolves to", sidx)

    doc["slides"] = slides_out
    if not fonts_only and overlay_total:
        rep.warn("overlay-in-clean-deck", f"{overlay_total} full-slide translucent/overlay picture(s) in the deck — a "
                 "deliverable must not carry a reference image")

    # ---- fonts
    doc["fonts"] = font_section(pkg, pres, pres_rels, profile, prof, faces, allowed_tf, allowed_faces, regular, theme,
                                theme_parts, uses, rep)

    # ---- summary
    errs, warns = rep.count("error"), rep.count("warn")
    summary = {"errors": errs, "warnings": warns, "verdict": "PASS" if not errs else "FAIL"}
    if not fonts_only:
        tot = Counter()
        for s in slides_out:
            for k, v in (s.get("counts") or {}).items():
                tot[k] += v
        summary["counts"] = dict(tot)
        strings = [x for s in slides_out for x in (s.get("text") or {}).get("strings", [])]
        summary["irText"] = {"total": len(strings), "found": sum(1 for x in strings if x["match"] != "missing"),
                             "byMatch": dict(Counter(x["match"] for x in strings))}
        charts = [c for s in slides_out for c in s.get("charts") or []]
        summary["charts"] = {"total": len(charts),
                             "workbookReadable": sum(1 for c in charts if (c.get("workbook") or {}).get("readable")),
                             "matchesSpec": sum(1 for c in charts if c.get("matchesSpec")) if ir else None}
        pics = [p for s in slides_out for p in s.get("pictures") or []]
        summary["pictures"] = {"total": len(pics), "large": sum(1 for p in pics if p["flag"] == "large"),
                               "overlay": sum(1 for p in pics if p["overlay"]),
                               "maxRasterCoveragePct": max((s.get("rasterCoveragePct", 0) for s in slides_out), default=0)}
    doc["summary"] = summary
    doc["problems"] = rep.problems
    return doc


def font_section(pkg, pres, pres_rels, profile, prof, faces, allowed_tf, allowed_faces, regular, theme, theme_parts,
                 uses, rep: Report) -> dict:
    out: dict = {"allowedTypefaces": sorted(allowed_tf), "profileFaces": [
        {"typeface": f["typeface"], "bold": bool(f["bold"]), "italic": bool(f.get("italic")), "cssWeight": f["cssWeight"],
         "slot": f.get("slot")} for f in faces], "theme": theme, "themeParts": theme_parts}
    by_role: dict[str, Counter] = {"latin": Counter(), "ea": Counter(), "cs": Counter()}
    combos: Counter = Counter()
    kinds = Counter(u.kind for u in uses)
    out["propertySets"] = dict(kinds)
    agg = defaultdict(lambda: [0, set()])  # (severity, rule, message-key) -> [count, slides]

    def note(sev, rule, msg, slide):
        a = agg[(sev, rule, msg)]
        a[0] += 1
        if slide is not None:
            a[1].add(slide)

    used_styles: dict[str, set[str]] = defaultdict(set)  # typeface -> {regular, bold, italic, boldItalic}
    for u in uses:
        strict = u.kind in ("run", "chartText", "chartRun")
        vals = {"latin": u.latin, "ea": u.ea, "cs": u.cs}
        missing = [k for k, v in vals.items() if not v]
        if len(missing) == 3 and not strict:
            # a bare a:br/a:endParaRPr inherits the master text style (+mn-*) = the theme minor font
            inh = {k: (theme.get("minor") or {}).get(k) for k in ("latin", "ea", "cs")}
            bad_inh = sorted({v for v in inh.values() if v not in allowed_tf}, key=str)
            if bad_inh:
                note("warn", "font-slot-missing", f"{'a:br run properties' if u.kind == 'br' else 'paragraph mark (endParaRPr)'}"
                     f" without typefaces inherits the theme minor font {bad_inh} (not a fonts.json typeface; it sizes "
                     "the last line box)", u.slide)
            continue
        if missing and (strict or len(missing) < 3):
            what = "run" if u.kind == "run" else {"br": "a:br run properties", "endPara": "paragraph mark (endParaRPr)",
                                                   "chartText": "chart text (txPr)", "chartRun": "chart rich-text run"}[u.kind]
            if strict:
                note("error", "font-slot-missing", f"{what} without a:{'/a:'.join(missing)} (falls back to the theme / "
                     "script font; CONTRACT: latin+ea+cs = fonts.json typeface)", u.slide)
            else:
                note("warn", "font-slot-missing", f"{what} without a:{'/a:'.join(missing)} (inherits the theme font; "
                     "text-mapping: repeat the run's typefaces)", u.slide)
        resolved = {k: resolve_theme_ref(v, k, theme) for k, v in vals.items()}
        for k, v in resolved.items():
            if v:
                by_role[k][v] += 1
                if v not in allowed_tf:
                    note("error" if strict or u.kind in ("br", "endPara") else "warn", "typeface-not-in-profile",
                         f"{k} typeface {v!r}{' (via ' + vals[k] + ')' if vals[k] != v else ''} is not a fonts.json "
                         f"{profile} typeface {sorted(allowed_tf)}", u.slide)
        present = {v for v in resolved.values() if v}
        if len(present) > 1:
            note("warn", "mixed-slot-typefaces", f"latin/ea/cs name different typefaces {sorted(present)}", u.slide)
        tf = resolved["latin"] or resolved["ea"] or resolved["cs"]
        if not tf or not strict:
            continue
        bold = bool(u.bold)
        combos[(tf, bold, u.italic)] += 1
        style = ("boldItalic" if u.italic else "bold") if bold else ("italic" if u.italic else "regular")
        used_styles[tf].add(style)
        if tf in allowed_tf and (tf, bold, False) not in {(a, b, False) for a, b, _ in allowed_faces}:
            note("error", "synthetic-bold", f"{tf!r} with b={'1' if bold else '0'} is not a fonts.json face (PowerPoint "
                 "would synthesise/choose another weight)", u.slide)
        if u.italic and not any(i for _, _, i in allowed_faces):
            note("warn", "synthetic-italic", f"italic run in {tf!r}: fonts.json has no italic face (oblique is "
                 "synthesised on every renderer)", u.slide)
    out["usedByRole"] = {k: dict(v.most_common()) for k, v in by_role.items()}
    out["combos"] = [{"typeface": t, "bold": b, "italic": i, "count": n, "inFontsJson": (t, b, i) in allowed_faces}
                     for (t, b, i), n in sorted(combos.items(), key=lambda kv: -kv[1])]
    # theme fonts
    for which in ("major", "minor"):
        d = theme.get(which) or {}
        for slot in ("latin", "ea", "cs"):
            if d.get(slot) != regular:        # error (fixer round 3, VR-06): new text boxes / placeholders use it
                note("error", "theme-font", f"theme {which}Font {slot} is {d.get(slot)!r}, CONTRACT wants the profile's "
                     f"regular typeface {regular!r}", None)
    # ---- embedded fonts
    efl = pres.find(P + "embeddedFontLst")
    entries = {}
    if efl is not None:
        for ef in efl.findall(P + "embeddedFont"):
            f = ef.find(P + "font")
            tf = f.get("typeface") if f is not None else None
            slots = {}
            for s in ef:
                if ln(s) in ("regular", "bold", "italic", "boldItalic"):
                    rel = pres_rels.get(s.get(R + "id"))
                    slots[ln(s)] = rel[1] if rel else None
            entries[tf] = {"attrs": dict(f.attrib) if f is not None else {}, "slots": slots}
    file_hash = {}
    for f in faces:
        if f.get("file"):
            try:
                file_hash[sha256((KIT / f["file"]).read_bytes())] = f["file"]
            except OSError:
                pass
    emb_out = {"embedTrueTypeFonts": pres.get("embedTrueTypeFonts"), "saveSubsetFonts": pres.get("saveSubsetFonts"),
               "typefaces": {}}
    for tf, e in entries.items():
        trow = {"attrs": e["attrs"], "slots": {}}
        for slot, part in e["slots"].items():
            srow: dict = {"part": part}
            if part is None or part not in pkg.names:
                note("error", "embedded-font-part-missing", f"embeddedFont {tf!r}/{slot}: relationship target missing", None)
                trow["slots"][slot] = srow
                continue
            blob = pkg.read(part)
            srow["contentType"] = pkg.content_type(part)
            srow["bytes"] = len(blob)
            if srow["contentType"] != CT_FONTDATA:
                note("error", "embedded-font-content-type", f"{part}: content type {srow['contentType']!r}, expected "
                     f"{CT_FONTDATA}", None)
            try:
                hdr, payload = eot.parse_eot(blob)
                srow["eot"] = {"version": f"{hdr.version:#010x}", "flags": hdr.flag_names(), "familyName": hdr.family_name,
                               "styleName": hdr.style_name, "fullName": hdr.full_name, "weight": hdr.weight,
                               "italic": hdr.italic, "fsType": eot.describe_fs_type(hdr.fs_type),
                               "charset": hdr.charset, "eotSize": hdr.eot_size, "fontDataSize": hdr.font_data_size}
                probs = [p for p in eot.verify_eot(blob, expect_family=tf) if not p.startswith("note:")]
                srow["eotProblems"] = probs
                for p in probs:
                    note("error", "embedded-font-eot", f"{part} ({tf}/{slot}): {p}", None)
                if hdr.flags & (eot.TTEMBED_SUBSET | eot.TTEMBED_TTCOMPRESSED | eot.TTEMBED_XORENCRYPTDATA):
                    note("warn", "embedded-font-flags", f"{part}: EOT flags {hdr.flag_names()} (tools/embed_fonts.py "
                         "writes raw full fonts)", None)
                srow["payloadSha256"] = sha256(payload)
                srow["matchesFontsJsonFile"] = file_hash.get(srow["payloadSha256"])
                if profile == "embedded" and srow["matchesFontsJsonFile"] is None:
                    note("warn", "embedded-font-foreign", f"{part} ({tf}/{slot}): payload is not byte-identical to any "
                         "fonts.json file", None)
            except eot.EOTError as exc:
                srow["eotError"] = str(exc)
                note("error", "embedded-font-eot", f"{part} ({tf}/{slot}): EOT header does not parse: {exc}", None)
            trow["slots"][slot] = srow
        emb_out["typefaces"][tf] = trow
    out["embedded"] = emb_out
    if profile == "embedded" or prof.get("embed"):
        if efl is None:
            note("error", "fonts-not-embedded", "the embedded profile deck has no p:embeddedFontLst (run "
                 "tools/embed_fonts.py after the final save)", None)
        elif pres.get("embedTrueTypeFonts") not in ("1", "true"):
            note("error", "embed-flag", "p:embeddedFontLst present but embedTrueTypeFonts is not true", None)
        if pres.get("saveSubsetFonts") in ("1", "true"):
            note("warn", "save-subset", "saveSubsetFonts=1: PowerPoint's next save would subset the fonts (not editable "
                 "for new characters)", None)
        lower = {k.lower(): k for k in entries if k}
        for tf, styles in sorted(used_styles.items()):
            if tf not in allowed_tf:
                continue  # already an error; embedding it would not help
            ent = entries.get(tf)
            if ent is None and tf.lower() in lower:
                note("warn", "embedded-font-case", f"typeface {tf!r} is embedded as {lower[tf.lower()]!r} (case differs)",
                     None)
                ent = entries[lower[tf.lower()]]
            if ent is None:
                note("error", "font-not-embedded", f"typeface {tf!r} is used by runs but has no embedded font", None)
                continue
            for style in sorted(styles):
                need = style if style in ("regular", "bold") else ("bold" if style == "boldItalic" else "regular")
                if need not in ent["slots"]:
                    note("error", "embedded-slot-missing", f"runs use {tf!r} {style} but the embedded font has no "
                         f"{need} slot (slots: {sorted(ent['slots'])}) — PowerPoint would synthesise it", None)
        for tf in entries:
            if tf and tf not in used_styles and tf.lower() not in {t.lower() for t in used_styles}:
                note("warn", "embedded-font-unused", f"embedded typeface {tf!r} is not used by any run ([MS-OE376] "
                     "2.1.1134: every embedded font must be used)", None)
    else:
        if efl is not None:
            note("error", "malgun-embeds-fonts", f"the {profile} profile must not embed fonts, but the deck embeds "
                 f"{sorted(k for k in entries if k)}", None)
        leaks = set()
        for name in pkg.names:
            if name.endswith((".xml", ".rels")) and not name.startswith("docProps/"):
                data = pkg.read(name).decode("utf-8", "replace")
                for s in MALGUN_SUBSTITUTES:
                    if re.search(r'typeface="[^"]*' + re.escape(s), data):
                        leaks.add((s, name))
        for s, name in sorted(leaks):
            note("error", "substitute-leak", f"measurement substitute {s!r} is named in {name} (the {profile} deck must "
                 "only name 맑은 고딕)", None)
    for (sev, rule, msg), (n, slides) in sorted(agg.items(), key=lambda kv: (kv[0][0] != "error", kv[0][1])):
        where = f"slides {sorted(slides)}" if slides else "deck"
        rep.add(sev, rule, f"{msg} — {n}× ({where})", min(slides) if len(slides) == 1 else None)
    return out


def _rel(p: Path | None) -> str | None:
    if p is None:
        return None
    p = Path(p).resolve()
    try:
        return str(p.relative_to(KIT))
    except ValueError:
        return str(p)


# ------------------------------------------------------------------------------------------------ text report
def render_text(doc: dict) -> str:
    L = []
    s = doc.get("summary", {})
    L.append(f"inspect_pptx: {doc['pptx']}  (profile {doc['profile']}, IR {doc.get('ir')})")
    L.append(f"verdict: {s.get('verdict')} — {s.get('errors')} error(s), {s.get('warnings')} warning(s)")
    d = doc.get("deck") or {}
    if d:
        L.append(f"deck: {d.get('slides')} slide(s) (IR: {d.get('irSlides')}), slide size {d['slideSizeEmu'][0]}x"
                 f"{d['slideSizeEmu'][1]} EMU, python-pptx opens: {d.get('pythonPptxOpens')}")
    if s.get("irText"):
        t = s["irText"]
        L.append(f"IR text strings: {t['found']}/{t['total']} found {t['byMatch']}")
    if s.get("charts"):
        c = s["charts"]
        L.append(f"charts: {c['total']}, workbook readable {c['workbookReadable']}, matches spec {c['matchesSpec']}")
    if s.get("pictures"):
        p = s["pictures"]
        L.append(f"pictures: {p['total']} ({p['large']} large, {p['overlay']} overlay)")
    L.append("")
    for sl in doc.get("slides") or []:
        c = sl.get("counts")
        if not c:
            continue
        L.append(f"slide {sl['index']} {sl.get('name') or ''}: text boxes {c['textBoxes']}, autoshapes {c['autoshapes']} "
                 f"({c['autoshapesWithText']} with text), pictures {c['pictures']}, tables {c['tables']}, charts "
                 f"{c['charts']}, groups {c['groups']}, connectors {c['connectors']}, other frames "
                 f"{c['otherGraphicFrames']}; background {sl['background']['type']}; raster coverage "
                 f"{sl.get('rasterCoveragePct', 0)}%")
        for p in sl.get("pictures") or []:
            tag = "OVERLAY (exempt)" if p["overlay"] else ("LARGE > 20%" if p["flag"] else "ok")
            L.append(f"   picture '{p['name']}' id {p['id']}: {p['areaPct']:.2f}% of slide, alpha {p['alpha']}, "
                     f"svg {p['svg']}, image {p['image'].get('pixelSize')} -> {tag}")
        t = sl.get("text")
        if t:
            L.append(f"   IR text: {t['found']}/{t['irStrings']} found {t['byMatch']}; extra PPTX text: {len(t['extraText'])}")
            for x in t["strings"]:
                if x["match"] not in ("exact",):
                    L.append(f"      [{x['match']}] {x['source']}: {short(x['text'], 70)!r}")
        for ch in sl.get("charts") or []:
            wb = ch.get("workbook") or {}
            L.append(f"   chart '{ch.get('name')}' {ch.get('type')}/{ch.get('grouping')} -> IR {ch.get('irElement')} "
                     f"(IoU {ch.get('iou')}): workbook {wb.get('part')} readable {wb.get('readable')}, cache==workbook "
                     f"{wb.get('cacheMatchesWorkbook')}, matches spec {ch.get('matchesSpec')}")
        f = sl.get("faces")
        if f:
            L.append(f"   faces: expected {f['expectedFromIr']} used {f['usedByRuns']}")
    fo = doc.get("fonts") or {}
    if fo:
        L.append("")
        L.append(f"fonts (profile typefaces {fo.get('allowedTypefaces')}):")
        for role, cnt in (fo.get("usedByRole") or {}).items():
            L.append(f"   {role:5}: {cnt}")
        for cmb in fo.get("combos") or []:
            L.append(f"   face {cmb['typeface']!r} bold={cmb['bold']} italic={cmb['italic']}: {cmb['count']} "
                     f"{'(fonts.json face)' if cmb['inFontsJson'] else '(NOT a fonts.json face)'}")
        th = fo.get("theme") or {}
        L.append(f"   theme: major {({k: v for k, v in (th.get('major') or {}).items() if k != 'scripts'})} minor "
                 f"{({k: v for k, v in (th.get('minor') or {}).items() if k != 'scripts'})}")
        emb = fo.get("embedded") or {}
        L.append(f"   embedded: embedTrueTypeFonts={emb.get('embedTrueTypeFonts')} saveSubsetFonts={emb.get('saveSubsetFonts')}")
        for tf, e in (emb.get("typefaces") or {}).items():
            for slot, sr in e["slots"].items():
                h = sr.get("eot") or {}
                L.append(f"      {tf!r}/{slot}: {sr.get('part')} {sr.get('bytes')} B, EOT {h.get('version')} flags "
                         f"{h.get('flags')} family {h.get('familyName')!r} style {h.get('styleName')!r} weight "
                         f"{h.get('weight')} fsType {h.get('fsType')}; = {sr.get('matchesFontsJsonFile')}"
                         f"{'; ' + str(sr.get('eotProblems') or sr.get('eotError')) if (sr.get('eotProblems') or sr.get('eotError')) else ''}")
    L.append("")
    L.append("problems:" if doc.get("problems") else "problems: none")
    for p in doc.get("problems") or []:
        L.append(f"   {p['severity'].upper():5} [{p['rule']}] {p['message']}")
    return "\n".join(L) + "\n"


def main(argv: list[str] | None = None) -> int:
    pdeathsig.arm()
    ap = argparse.ArgumentParser(description="Editability audit of a PPTX vs its IR and fonts.json.")
    ap.add_argument("pptx", type=Path)
    ap.add_argument("--ir", type=Path, help="<deck>/.build/<profile>/ir.json (text/chart/face checks need it)")
    ap.add_argument("--profile", required=True, choices=["embedded", "malgun"])
    ap.add_argument("--fonts-json", type=Path, default=KIT / "fonts" / "fonts.json")
    ap.add_argument("--out-json", type=Path, help="write the JSON report here (default: none)")
    ap.add_argument("--out-txt", type=Path, help="write the text report here (default: none)")
    ap.add_argument("--fonts-only", action="store_true",
                    help="only the font checks; print a one-line summary, write no report unless --out-json is given")
    ap.add_argument("--quiet", action="store_true", help="do not print the text report")
    args = ap.parse_args(argv)
    if not args.pptx.is_file():
        print(f"inspect_pptx: error: {args.pptx} not found", file=sys.stderr)
        return 2
    doc = inspect(args.pptx, args.profile, args.ir, args.fonts_json, fonts_only=args.fonts_only)
    if args.fonts_only:
        errs = [p for p in doc["problems"] if p["severity"] == "error"]
        warns = [p for p in doc["problems"] if p["severity"] == "warn"]
        emb = ((doc.get("fonts") or {}).get("embedded") or {}).get("typefaces") or {}
        print(f"font-check {doc['summary']['verdict']}: {len(errs)} error(s), {len(warns)} warning(s); used "
              f"{sorted({c['typeface'] + (' bold' if c['bold'] else '') for c in (doc.get('fonts') or {}).get('combos', [])})}; "
              f"embedded {sorted(f'{t}/{s}' for t, e in emb.items() for s in e['slots'])}")
        for p in errs + warns:
            print(f"   {p['severity'].upper():5} [{p['rule']}] {p['message']}")
        if not args.out_json and not args.out_txt:
            return 1 if errs else 0
    text = render_text(doc)
    written = []
    if args.out_json:
        args.out_json.parent.mkdir(parents=True, exist_ok=True)
        args.out_json.write_text(json.dumps(doc, ensure_ascii=False, indent=1, default=str) + "\n", encoding="utf-8")
        written.append(str(args.out_json))
    if args.out_txt:
        args.out_txt.parent.mkdir(parents=True, exist_ok=True)
        args.out_txt.write_text(text, encoding="utf-8")
        written.append(str(args.out_txt))
    if not args.quiet and not args.fonts_only:
        sys.stdout.write(text)
    print(f"inspect_pptx: {doc['summary']['verdict']} ({doc['summary']['errors']} errors, "
          f"{doc['summary']['warnings']} warnings)" + (f" -> {' + '.join(written)}" if written else ""))
    return 1 if doc["summary"]["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
