"""PowerPoint object structure: source records, groups (``p:grpSp``), readable names and the IR <-> PPTX map.

* **Records**: every top-level object the builder writes is recorded with the IR element it came from
  (``Rec``); a split shape (fill + border) is two records of one IR element, a table background absorbed into its
  table (``table-bg``) points at the table's frame.
* **Groups** (judge J1-03): the extractor lists the slide's *components* (``slides[].components``: every box with its
  own paint that holds other objects, and every ``data-group`` element) with the IR ids of their members. Innermost
  first, the top-level objects of each component become one ``p:grpSp`` when they are contiguous in paint order
  (so z-order never changes) and there are at least two of them. Never grouped, because PowerPoint cannot group
  them: tables and placeholders (the component is then left ungrouped and reported with ``info``). A split shape
  (one CSS box written as a fill shape + a border shape) is always grouped. Groups use an identity child transform
  (``chOff = off``, ``chExt = ext`` = the members' bounding box), so no child moves.
* **Names** (J1-09): short, readable Selection Pane names (``"stat-value: 1,284억 원"``, ``"card 그룹"``) instead of
  the DOM paths; the DOM path of every object is kept in the map file.
* **Map**: ``<deck stem>.map.json`` lists, per slide and layout part, every object's ``p:cNvPr@id`` with its IR id and
  role — the link the fidelity gate (tools/check_fidelity.py) uses to compare each IR element with its PPTX object.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

from lxml import etree
from pptx.oxml.ns import qn

from .core import sub
from .pictures import DECORATIVE_NS, mark_decorative

SHAPE_TAGS = {qn("p:sp"), qn("p:pic"), qn("p:graphicFrame"), qn("p:grpSp"), qn("p:cxnSp")}
URI_TABLE = "http://schemas.openxmlformats.org/drawingml/2006/table"


@dataclass
class Rec:
    ir_id: str | None           # IR element id (None: a builder-made object)
    kind: str                   # IR kind (shape/text/image/table/chart) or "group"
    role: str                   # main | fill | border | table-bg | group
    node: etree._Element        # the top-level p:sp / p:pic / p:graphicFrame / p:grpSp (after grouping: maybe nested)
    members: frozenset = field(default_factory=frozenset)   # IR ids a group node represents
    extra: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------------------------- capture
def top_nodes(tree) -> list:
    return [c for c in tree if isinstance(c.tag, str) and c.tag in SHAPE_TAGS]


def capture(tree, fn) -> list:
    """Run fn() and return the top-level shape nodes it appended/inserted into the spTree, in document order."""
    before = {id(n) for n in top_nodes(tree)}
    fn()
    return [n for n in top_nodes(tree) if id(n) not in before]


def cnvpr(node):
    nv = next((c for c in node if isinstance(c.tag, str) and etree.QName(c).localname.startswith("nv")), None)
    return nv.find(qn("p:cNvPr")) if nv is not None else None


def is_table_frame(node) -> bool:
    if node.tag != qn("p:graphicFrame"):
        return False
    gd = node.find(f"{qn('a:graphic')}/{qn('a:graphicData')}")
    return gd is not None and gd.get("uri") == URI_TABLE


def is_placeholder(node) -> bool:
    return node.tag == qn("p:sp") and node.find(f"{qn('p:nvSpPr')}/{qn('p:nvPr')}/{qn('p:ph')}") is not None


def contains_ungroupable(node) -> str | None:
    """'table' / 'placeholder' when node (or a descendant) is something PowerPoint cannot put into a group."""
    for n in [node] + [d for d in node.iter() if d is not node and isinstance(d.tag, str) and d.tag in SHAPE_TAGS]:
        if is_table_frame(n):
            return "table"
        if is_placeholder(n):
            return "placeholder"
    return None


# ---------------------------------------------------------------------------------------------- geometry
def node_box(node) -> tuple[float, float, float, float] | None:
    """Axis-aligned bounding box (EMU) of a top-level object, rotation included."""
    if node.tag == qn("p:graphicFrame"):
        xfrm = node.find(qn("p:xfrm"))
    elif node.tag == qn("p:grpSp"):
        xfrm = node.find(f"{qn('p:grpSpPr')}/{qn('a:xfrm')}")
    else:
        xfrm = node.find(f"{qn('p:spPr')}/{qn('a:xfrm')}")
    if xfrm is None:
        return None
    off, ext = xfrm.find(qn("a:off")), xfrm.find(qn("a:ext"))
    if off is None or ext is None:
        return None
    x, y, w, h = (float(off.get("x", 0)), float(off.get("y", 0)), float(ext.get("cx", 0)), float(ext.get("cy", 0)))
    rot = float(xfrm.get("rot", 0)) / 60000.0
    if rot % 360:
        a = math.radians(rot)
        cw = abs(w * math.cos(a)) + abs(h * math.sin(a))
        ch = abs(w * math.sin(a)) + abs(h * math.cos(a))
        cx, cy = x + w / 2, y + h / 2
        return cx - cw / 2, cy - ch / 2, cw, ch
    return x, y, w, h


def make_group(tree, nodes: list, name: str, shape_id: int) -> etree._Element:
    """Wrap `nodes` (contiguous top-level siblings, in order) into a p:grpSp at the first one's position."""
    boxes = [b for b in (node_box(n) for n in nodes) if b is not None]
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[0] + b[2] for b in boxes)
    y1 = max(b[1] + b[3] for b in boxes)
    x0, y0 = int(math.floor(x0)), int(math.floor(y0))
    cx, cy = max(1, int(math.ceil(x1)) - x0), max(1, int(math.ceil(y1)) - y0)
    grp = etree.Element(qn("p:grpSp"))
    nv = sub(grp, "p:nvGrpSpPr")
    sub(nv, "p:cNvPr", id=shape_id, name=name)
    sub(nv, "p:cNvGrpSpPr")
    sub(nv, "p:nvPr")
    gpr = sub(grp, "p:grpSpPr")
    xfrm = sub(gpr, "a:xfrm")
    sub(xfrm, "a:off", x=x0, y=y0)
    sub(xfrm, "a:ext", cx=cx, cy=cy)
    sub(xfrm, "a:chOff", x=x0, y=y0)                     # identity child transform: nothing moves
    sub(xfrm, "a:chExt", cx=cx, cy=cy)
    nodes[0].addprevious(grp)
    for n in nodes:
        grp.append(n)                                    # lxml append moves the element
    return grp


def next_shape_id(tree) -> int:
    ids = [int(c.get("id")) for c in tree.iter(qn("p:cNvPr")) if (c.get("id") or "").isdigit()]
    return max(ids, default=1) + 1


# ---------------------------------------------------------------------------------------------- names
_NTH = re.compile(r":nth-child\(\d+\)")
_SIDE = {"top": "위", "right": "오른쪽", "bottom": "아래", "left": "왼쪽"}


def _steps(ir_id: str) -> list[str]:
    return [s.strip() for s in ir_id.split("::", 1)[0].split(" > ") if s.strip()]


def _label(step: str) -> str:
    step = _NTH.sub("", step)
    if step.startswith("#"):
        return step[1:]
    tag, _, cls = step.partition(".")
    return cls.split(".")[0] if cls else tag


def element_label(ir_id: str | None) -> str:
    """Class (else tag/id) of the element an IR id belongs to; a bare svg/img borrows its parent's label."""
    if not ir_id:
        return "object"
    st = _steps(ir_id)
    if not st:
        return "object"
    lab = _label(st[-1])
    if lab in ("svg", "img") and len(st) > 1:
        return _label(st[-2])
    return lab


def excerpt(text: str, n: int = 28) -> str:
    t = re.sub(r"\s*\n\s*", " / ", text or "")
    t = re.sub(r"\s+", " ", t).strip()
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def text_of(e: dict) -> str:
    out = []
    for p in e.get("paragraphs") or []:
        if not isinstance(p, dict):
            continue
        parts = []
        for r in p.get("runs") or []:
            if not isinstance(r, dict):
                continue
            if r.get("break"):
                parts.append("\n")
            elif r.get("field") == "slidenum":
                parts.append("‹쪽 번호›")
            else:
                parts.append(str(r.get("text") or ""))
        out.append("".join(parts))
    return "\n".join(out)


def object_name(e: dict, role: str = "main") -> str:
    """Readable Selection Pane name for the object(s) an IR element becomes."""
    kind = e.get("kind")
    eid = e.get("id") or ""
    lab = element_label(eid)
    suffix = eid.split("::", 1)[1] if "::" in eid else ""
    suffix = suffix.split("#", 1)[0]
    if kind == "text":
        t = text_of(e)
        if e.get("placeholder") in ("title", "ctrTitle"):
            return f"제목: {excerpt(t)}"
        if e.get("placeholder") == "subTitle":
            return f"부제목: {excerpt(t)}"
        return f"{lab}: {excerpt(t)}" if t.strip() else lab
    if kind == "shape":
        if suffix.startswith("border-"):
            base = f"{lab} {_SIDE.get(suffix[7:], suffix[7:])} 테두리"
        elif suffix.startswith("inline-bg"):
            base = f"{lab} 강조 배경"
        elif suffix.startswith("bg") and suffix != "bg":
            base = f"{lab} 배경 {suffix[2:]}"
        else:
            base = f"{lab} 배경"
        return {"fill": f"{base} (채우기)", "border": f"{base} (테두리)"}.get(role, base)
    if kind == "image":
        return f"{lab} 그림"
    if kind == "table":
        cells = e.get("cells") or []
        head = []
        for c in (cells[0] if cells else []):
            if isinstance(c, dict) and not c.get("covered"):
                head.append(excerpt(text_of({"paragraphs": c.get("paragraphs") or []}), 12))
        return f"표: {excerpt(' · '.join(h for h in head if h), 32)}" if head else "표"
    if kind == "chart":
        spec = e.get("spec") or {}
        names = [str(s.get("name")) for s in spec.get("series") or [] if s.get("name")]
        base = f"차트: {excerpt(', '.join(names), 32)}" if names else "차트"
        # the value axis is locked to the HTML's scale (explicit c:min/c:max): say so where the user looks for the
        # object, so a value typed above the maximum is recognisable as clipping (Format Axis > Bounds) (EDIT-04)
        res = e.get("resolved") or {}
        if spec.get("type") in ("column", "bar", "line") and res.get("valueMin") is not None \
                and res.get("valueMax") is not None:
            nf = (spec.get("valueAxis") or {}).get("numberFormat") or (spec.get("dataLabels") or {}).get("numberFormat")
            base += f" (값 축 {_fmt_value(res['valueMin'], nf)}~{_fmt_value(res['valueMax'], nf)} 고정)"
        return base
    return lab


_CHART_KIND = {"column": "세로 막대형 차트", "bar": "가로 막대형 차트", "line": "꺾은선형 차트", "pie": "원형 차트",
               "doughnut": "도넛형 차트"}


def _fmt_value(v, number_format: str | None) -> str:
    if v is None:
        return "값 없음"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    nf = number_format or ""
    decimals = len(nf.split(".", 1)[1].rstrip("%")) if "." in nf else (0 if f.is_integer() else 2)
    return f"{f:,.{decimals}f}" if "," in nf or not nf else f"{f:.{decimals}f}"


def chart_alt_text(spec: dict, resolved: dict | None = None) -> str:
    """Alt text (``cNvPr@descr``) of a native chart from its spec (judge J2-03): chart kind, categories, every
    series with its values, the value-axis range when it is fixed — what a screen reader user needs, in Korean
    (user-facing text)."""
    spec = spec or {}
    kind = _CHART_KIND.get(spec.get("type"), "차트")
    cats = [str(c) for c in spec.get("categories") or []]
    nf = (spec.get("dataLabels") or {}).get("numberFormat") or (spec.get("valueAxis") or {}).get("numberFormat")
    parts = [f"{kind}: " + " · ".join(cats) if cats else kind]
    series = spec.get("series") or []
    for s in series[:1] if spec.get("type") in ("pie", "doughnut") else series:
        vals = list(s.get("values") or [])
        parts.append(f"{s.get('name') or '계열'} " + " · ".join(_fmt_value(v, nf) for v in vals))
    res = resolved or {}
    if spec.get("type") in ("column", "bar", "line") and res.get("valueMin") is not None \
            and res.get("valueMax") is not None:
        parts.append(f"값 축 {_fmt_value(res['valueMin'], nf)}~{_fmt_value(res['valueMax'], nf)}")
    return ". ".join(parts) + "."


def group_name(comp: dict) -> str:
    if comp.get("name"):
        return str(comp["name"])
    return f"{element_label(comp.get('id'))} 그룹"


# ---------------------------------------------------------------------------------------------- grouping
def group_components(tree, recs: list, components: list, namer, log, where: str) -> int:
    """Group the component members that are top-level in `tree`. `recs` (all records of this tree) gets one group
    record per group made. Returns the number of groups made."""
    ids_of: dict[int, frozenset] = {}
    for r in recs:
        if r.node.getparent() is tree:
            ids_of[id(r.node)] = ids_of.get(id(r.node), frozenset()) | (r.members or frozenset({r.ir_id}))
    made = 0
    comps = [c for c in components if c.get("members")]
    comps.sort(key=lambda c: len(c["members"]))           # innermost first: a child's members are a subset
    for comp in comps:
        mem = frozenset(comp["members"])
        top = top_nodes(tree)
        idx = [i for i, n in enumerate(top) if ids_of.get(id(n)) and ids_of[id(n)] <= mem]
        if len(idx) < 2:
            continue
        label = group_name(comp)
        if idx != list(range(idx[0], idx[-1] + 1)):
            log.info(f"{where}: component {label!r} not grouped: its objects are not contiguous in paint order")
            continue
        nodes = [top[i] for i in idx]
        bad = next((b for b in (contains_ungroupable(n) for n in nodes) if b), None)
        if bad:
            log.info(f"{where}: component {label!r} not grouped: PowerPoint cannot group a {bad}")
            continue
        grp = make_group(tree, nodes, namer(label), next_shape_id(tree))
        if all_decorative(grp):
            # a group of decorative shapes only (the cover's decoration, a card's background + border): the group
            # itself is decorative too — PowerPoint's Accessibility Checker asks groups for alt text, and the Reading
            # Order pane lists only the group (fixer round 3, EDIT-08)
            mark_decorative(cnvpr(grp))
        members = frozenset().union(*(ids_of[id(n)] for n in nodes))
        ids_of[id(grp)] = members
        recs.append(Rec(comp.get("id"), "group", "group", grp, members, {"component": comp.get("id")}))
        made += 1
    return made


def is_decorative(node) -> bool:
    """Empty alt text + Office's decorative flag on the object's cNvPr."""
    c = cnvpr(node)
    if c is None or (c.get("descr") or "").strip():
        return False
    d = c.find(f".//{{{DECORATIVE_NS}}}decorative")
    return d is not None and d.get("val") in ("1", "true")


def all_decorative(grp) -> bool:
    """Every leaf object inside the group is decorative (nested groups descended)."""
    leaves = [d for d in grp.iter() if d is not grp and isinstance(d.tag, str) and d.tag in SHAPE_TAGS
              and d.tag != qn("p:grpSp")]
    return bool(leaves) and all(is_decorative(n) for n in leaves)


def group_split(tree, recs: list, e: dict, nodes: list, namer, log, where: str) -> None:
    """One CSS box written as several shapes (fill + border): always one group."""
    if len(nodes) < 2 or any(n.getparent() is not tree for n in nodes):
        return
    top = top_nodes(tree)
    pos = [top.index(n) for n in nodes]
    if pos != list(range(pos[0], pos[0] + len(nodes))):
        log.info(f"{where}: split shape {e.get('id')!r} not grouped (not contiguous)")
        return
    grp = make_group(tree, nodes, namer(object_name(e)), next_shape_id(tree))
    recs.append(Rec(e.get("id"), "group", "group", grp, frozenset({e.get("id")}), {"split": True}))


# ---------------------------------------------------------------------------------------------- map
def shape_id_of(node) -> int | None:
    c = cnvpr(node)
    try:
        return int(c.get("id")) if c is not None else None
    except (TypeError, ValueError):
        return None


def write_map(path: Path, deck: Path, ir_path: str | None, parts: list[dict]) -> None:
    """parts: [{"part": "ppt/slides/slide1.xml", "kind": "slide"|"layout", "slide": n|None, "name": str|None,
    "records": [Rec]}]"""
    out = {"version": 1, "deck": str(deck), "ir": ir_path, "parts": []}
    for p in parts:
        objs = []
        for r in p["records"]:
            sid = shape_id_of(r.node)
            c = cnvpr(r.node)
            objs.append({"shapeId": sid, "name": c.get("name") if c is not None else None, "ir": r.ir_id,
                         "kind": r.kind, "role": r.role,
                         "members": sorted(m for m in r.members if m) if r.kind == "group" else None,
                         **({k: v for k, v in r.extra.items() if isinstance(v, (str, int, float, bool))})})
        out["parts"].append({k: v for k, v in p.items() if k != "records"} | {"objects": objs})
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
