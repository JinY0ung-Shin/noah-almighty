"""IR `text` element -> one native PowerPoint text box; paragraph/run writer shared with table cells.

Port of scratch/text-mapping/textmap.py (docs/research/text-mapping.md) with the CONTRACT v2 decisions:

* box: x = contentBox.x, y = lines[0].baseline - seat (PowerPoint's seat model, §2), insets 0, ``anchor="t"``;
  ``noAutofit`` for ``wrap="none"``; a ``wrap="square"`` box gets ``normAutofit`` (no fontScale) and a height >= 1.05 x
  PowerPoint's text height, so an edited text that wraps to more lines shrinks inside the box instead of running into
  the next object, while the unedited text never triggers it (fixer round 3, EDIT-01);
* blocks whose lines all end at hard breaks (``<br>`` / paragraph ends) — single-line blocks included (judge
  J2-01): ``wrap="square"`` at the HTML box width when PowerPoint's width of EVERY line (1/8-pt advances) stays at
  least FIT_MARGIN_REL of the box short of the box edge and the HTML would wrap a longer line inside that box
  (``fit_allowed``: not CSS ``nowrap``, not ``shrinkWrap``, no text field; single lines need the IR flags and no
  rotation) — "fit" mode (J1-05): the existing lines cannot reflow, an edited line wraps inside its container;
  otherwise ``wrap="none"`` (a nowrap number, a pill, a legend label, a footer note, a page number);
* wrapping blocks: width from ``pptbreak.window_for_breaks`` over ``lines[].text`` (the interval of widths in which
  PowerPoint's greedy breaker ends every line where Chromium did), kept at the HTML width when that is inside the
  window with a safety margin, else moved into it; no line texts / no advance model -> 1.02 x width; no window ->
  hard breaks (``a:br`` at Chromium's line ends + ``wrap="none"``). Width changes keep the left edge (l/just),
  the centre (ctr) or the right edge (r);
* ``a:lnSpc/a:spcPct`` (whole percent) in every paragraph; paragraph gaps as ``spcBef`` from the measured baselines
  (fallback: collapsed CSS margins); ``pPr eaLnBrk="1" latinLnBrk="0" hangingPunct="0"``; bullets with the text face;
* runs: ``lang="ko-KR" altLang="en-US"``, ``sz``, ``b`` from the face, ``kern="0"``, ``dirty="0"``, colour with alpha
  x element opacity, ``latin``/``ea``/``cs`` = face typeface; ``a:br`` and ``a:endParaRPr`` repeat the run's rPr;
  a run with ``field`` (IR, from ``data-field``) is written as ``a:fld type=…`` (PowerPoint computes the text:
  ``slidenum`` = the slide's number, right after reordering/inserting slides);
* an element with ``placeholder`` (title / ctrTitle / subTitle) becomes that placeholder (``p:ph``) with every
  property explicit (xfrm, bodyPr, spacing, rPr), so no layout/master formatting applies to what the HTML shows;
  ``idx`` as PowerPoint's own layouts write it (subTitle ``idx="1"``, title/ctrTitle none = 0): unique per slide and
  layout, so the slide placeholder links to the right layout prompt ([MS-OI29500] 2.1.1127, fixer round 3).
"""
from __future__ import annotations

import copy
import math
import re
import uuid
from dataclasses import dataclass, field

from pptx.oxml.ns import qn
from pptx.util import Emu

from . import pptbreak
from .core import PX_PER_PT, ang60k, clamp, el, emu, norm_color, num, srgb, sub

WRAP_SLACK = 1.02          # fonts.md §2.9 fallback when no line texts / advance model
# ST_TextAutonumberScheme (dml-main.xsd); anything else would fail schema validation
AUTONUM_SCHEMES = frozenset("""alphaLcParenBoth alphaUcParenBoth alphaLcParenR alphaUcParenR alphaLcPeriod alphaUcPeriod
    arabicParenBoth arabicParenR arabicPeriod arabicPlain romanLcParenBoth romanUcParenBoth romanLcParenR romanUcParenR
    romanLcPeriod romanUcPeriod circleNumDbPlain circleNumWdBlackPlain circleNumWdWhitePlain arabicDbPeriod
    arabicDbPlain ea1ChsPeriod ea1ChsPlain ea1ChtPeriod ea1ChtPlain ea1JpnChsDbPeriod ea1JpnKorPlain ea1JpnKorPeriod
    arabic1Minus arabic2Minus hebrew2Minus thaiAlphaPeriod thaiAlphaParenR thaiAlphaParenBoth thaiNumPeriod
    thaiNumParenR thaiNumParenBoth hindiAlphaPeriod hindiNumPeriod hindiNumParenR hindiAlpha1Period""".split())
MARGIN_ABS_PT = 0.25       # reference: nearest window edge +/- 0.25 pt
MARGIN_REL_EXACT = 0.004   # model = the very font file PowerPoint gets (embedded): PPT widths +0.10 % +/- 0.19 %
MARGIN_REL_SUBST = 0.010   # model = metric-matched substitute (malgun): per-line sd 0.26 %, p99 0.9 %
FIT_MARGIN_REL = 0.02      # "fit" mode: every line >= 2 % of the box shorter than the box (> the substitute's worst
                           # per-line error vs real Malgun Gothic, 1.9 %, docs/research/fonts.md)
AUTOFIT_SLACK_REL = 0.05   # wrap="square" boxes (normAutofit): box >= 1.05 x PowerPoint's text height, so "shrink text
                           # on overflow" never fires on the unedited text (fixer round 3, EDIT-01)
PLACEHOLDER_TYPES = ("title", "ctrTitle", "subTitle")
# p:ph@idx per type ([MS-OI29500] 2.1.1127: no two placeholders of a slide / layout may share an idx; a slide
# placeholder inherits from the layout placeholder with the SAME idx). PowerPoint's own Title Slide layout writes
# ctrTitle without idx (0) and subTitle idx="1"; title stays 0 (fixer round 3, VO-01 / VR-01)
PLACEHOLDER_IDX = {"title": None, "ctrTitle": None, "subTitle": "1"}


# ---------------------------------------------------------------------------------------------- line model
def ppt_share(faces) -> float:
    """PowerPoint's above-baseline share of its 1.2 em line for the faces on one line (usWin metrics)."""
    a = max(f.unit_line[0] for f in faces)
    d = max(f.unit_line[1] for f in faces)
    return 1.2 * a / (a + d)


def whole_percent(pct: float) -> int:
    """lnSpc percentage PowerPoint will use (it rounds to a whole percent)."""
    return int(math.floor(pct * 100 + 0.5))


def ppt_seat_pt(size_pt: float, share: float, pct_whole: int) -> float:
    pct = pct_whole / 100.0
    if pct > 1.0:
        return 0.9 * pct * size_pt
    return max(0.0, (1.2 * pct - 1.2 + share) * size_pt)


def ppt_advance_pt(size_pt: float, pct_whole: int) -> float:
    return 1.2 * (pct_whole / 100.0) * size_pt


# ---------------------------------------------------------------------------------------------- text cleaning
_BAD_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")
_LINE_SEP = re.compile("\r\n|[\n\r\x0b\u2028\u2029]")
_WS_EDGE = " \t\n"


def clean_text(s: str) -> str:
    return _BAD_XML.sub("", s)


def _norm_runs(ir_runs) -> list[dict]:
    """IR runs -> text runs and {"break": True}; LF/CR/VT inside a run become breaks, XML-illegal chars dropped."""
    out = []
    for r in ir_runs or []:
        if not isinstance(r, dict):
            continue
        if r.get("break"):
            out.append({"break": True})
            continue
        parts = _LINE_SEP.split(str(r.get("text") or ""))
        for k, part in enumerate(parts):
            if k:
                out.append({"break": True})
            part = clean_text(part).replace("\t", " ")
            if part:
                out.append(dict(r, text=part))
    return out


# ---------------------------------------------------------------------------------------------- paragraphs
@dataclass
class Para:
    ir: dict
    runs: list
    text: str
    char_run: list                 # run index per character ('\n' = <br>)
    size_px: float                 # largest normal-baseline run size (PowerPoint's S for the paragraph)
    face0: object                  # face of the first text run (bullet font, empty-paragraph mark)
    mark_face: object              # face of the paragraph mark (= last normal-baseline text run)
    faces: set
    pct: int
    has_text: bool
    lines: list = field(default_factory=list)       # IR lines of this paragraph, visual order
    starts: list | None = None                      # aligned [start, end) of each line in `text`
    ends: list | None = None
    soft: list = field(default_factory=list)        # indices in `text` where Chromium soft-wrapped
    line_size_px: list = field(default_factory=list)
    line_faces: list = field(default_factory=list)


def _run_size(r) -> float | None:
    v = num(r.get("sizePx"), 0.0)
    return v if v > 0 else None


def analyze_paragraph(p: dict, profile, default_size_px: float = 16.0) -> Para:
    runs = _norm_runs(p.get("runs"))
    text, char_run = [], []
    for i, r in enumerate(runs):
        t = "\n" if r.get("break") else r["text"]
        text.append(t)
        char_run.extend([i] * len(t))
    text = "".join(text)
    trs = [r for r in runs if not r.get("break")]
    normal = [r for r in trs if r.get("baseline", "normal") in (None, "normal") and _run_size(r)]
    sized = normal or [r for r in trs if _run_size(r)] or [r for r in (p.get("runs") or []) if isinstance(r, dict)
                                                           and _run_size(r)]
    size_px = max((_run_size(r) for r in sized), default=None) or default_size_px
    faces = {profile.resolve(r.get("fontWeight", 400)) for r in trs} or {profile.resolve(400)}
    face0 = profile.resolve(trs[0].get("fontWeight", 400)) if trs else profile.resolve(400)
    norm_trs = [r for r in trs if r.get("baseline", "normal") in (None, "normal")]
    mark_face = profile.resolve(norm_trs[-1].get("fontWeight", 400)) if norm_trs else face0
    lh = num(p.get("lineHeightPx"), 0.0)
    if lh <= 0:
        lh = 1.2 * size_px
    pct = clamp(whole_percent(lh / (1.2 * size_px)), 1, 13200)
    return Para(ir=p, runs=runs, text=text, char_run=char_run, size_px=size_px, face0=face0,
                mark_face=mark_face, faces=faces, pct=pct, has_text=bool(trs))


def align_lines(text: str, line_texts: list[str]):
    """Locate each Chromium line (IR lines[].text) in the paragraph text. Returns (starts, ends) of the lines'
    non-blank cores, or None when the line texts do not reproduce the paragraph text."""
    starts, ends, pos = [], [], 0
    for lt in line_texts:
        core = str(lt).replace("\n", "").strip(_WS_EDGE)
        if not core:
            starts.append(pos)
            ends.append(pos)
            continue
        idx = text.find(core, pos)
        if idx < 0 or text[pos:idx].strip(_WS_EDGE):
            return None
        starts.append(idx)
        ends.append(idx + len(core))
        pos = idx + len(core)
    if text[pos:].strip(_WS_EDGE):
        return None
    return starts, ends


def map_lines(paras: list[Para], lines: list[dict], profile) -> bool:
    """Attach IR lines to paragraphs; align line texts. Returns True when every paragraph with text got an exact
    line alignment (line texts present and consistent)."""
    if not lines or any(not isinstance(L, dict) or "paragraph" not in L for L in lines):
        return False
    for L in lines:
        pi = L.get("paragraph")
        if not isinstance(pi, int) or not 0 <= pi < len(paras):
            return False
        paras[pi].lines.append(L)
    ok = True
    for p in paras:
        if not p.lines:
            ok = ok and not p.has_text
            continue
        texts = [L.get("text") for L in p.lines]
        al = align_lines(p.text, texts) if all(isinstance(t, str) for t in texts) else None
        if al is None:
            ok = False
            p.line_size_px = [p.size_px] * len(p.lines)
            p.line_faces = [p.faces] * len(p.lines)
            continue
        p.starts, p.ends = al
        for k in range(len(p.lines) - 1):
            gap = p.text[p.ends[k]:p.starts[k + 1]]
            if "\n" not in gap and p.starts[k + 1] > p.starts[k]:
                p.soft.append(p.starts[k + 1])
        for k in range(len(p.lines)):
            ris = {p.char_run[i] for i in range(p.starts[k], p.ends[k]) if p.text[i] != "\n"}
            rs = [p.runs[j] for j in sorted(ris)]
            normal = [r for r in rs if r.get("baseline", "normal") in (None, "normal") and _run_size(r)]
            sizes = [_run_size(r) for r in (normal or rs) if _run_size(r)]
            p.line_size_px.append(max(sizes) if sizes else p.size_px)
            p.line_faces.append({profile.resolve(r.get("fontWeight", 400)) for r in rs} or {p.face0})
    return ok


def _line_metrics_px(p: Para, k: int | None, *, with_mark: bool):
    """(advance, seat) in px of line k of paragraph p under PowerPoint's model."""
    if k is None or not p.line_size_px:
        size_px, faces = p.size_px, set(p.faces)
    else:
        size_px, faces = p.line_size_px[k], set(p.line_faces[k])
    if with_mark:
        faces.add(p.mark_face)
    size_pt = size_px * 0.75
    adv = ppt_advance_pt(size_pt, p.pct) * PX_PER_PT
    seat = ppt_seat_pt(size_pt, ppt_share(faces), p.pct) * PX_PER_PT
    return adv, seat


def paragraph_gap_px(prev: dict, nxt: dict) -> float:
    """Block-sibling margin collapsing (both positive): the larger margin wins (CSS 2.1 8.3.1)."""
    a, b = num(prev.get("spaceAfterPx")), num(nxt.get("spaceBeforePx"))
    if a >= 0 and b >= 0:
        return max(a, b)
    return a + b


# ---------------------------------------------------------------------------------------------- runs
def run_rpr(tag: str, run: dict, face, *, size_pt: float, opacity: float = 1.0,
            baseline_pct1000: int | None = None, warn=None):
    """<a:rPr>/<a:endParaRPr>. Child order (CT_TextCharacterProperties): ln, fill, effect, highlight,
    uLnTx/uLn, uFillTx/uFill, latin, ea, cs, sym, hlinkClick, hlinkMouseOver, rtl, extLst."""
    sz = clamp(int(round(size_pt * 100)), 100, 400000)                # ST_TextFontSize 100..400000
    r = el(tag, lang="ko-KR", altLang="en-US", sz=sz, b="1" if face.bold else "0",
           i="1" if run.get("italic") else None,
           u="sng" if run.get("underline") else None,
           strike="sngStrike" if run.get("strike") else None,
           kern="0")
    ls = num(run.get("letterSpacingPx"))
    if ls:
        r.set("spc", str(clamp(int(round(ls * 75)), -400000, 400000)))  # 1/100 pt (ST_TextPoint)
    if baseline_pct1000:
        r.set("baseline", str(baseline_pct1000))
    r.set("dirty", "0")
    fill = sub(r, "a:solidFill")
    alpha = num(run.get("alpha"), 1.0) * opacity
    fill.append(srgb(norm_color(run.get("color"), warn), clamp(alpha, 0.0, 1.0)))
    for slot in ("a:latin", "a:ea", "a:cs"):
        sub(r, slot, typeface=face.typeface)
    return r


def _items(p: Para, hard_breaks=()) -> list[tuple]:
    """Paragraph content as ("t", run_index, text) / ("br", run_index) items. `hard_breaks`: soft-wrap indices
    that become <a:br/> (hard-break mode). Trailing spaces before every break and at the paragraph end are dropped
    (they hang in Chromium). Leading spaces are dropped only after a soft wrap turned into <a:br/>: at the paragraph
    start and after an IR break they are rendered text (the extractor already removed collapsible spaces; what is
    left is pre/pre-wrap indentation)."""
    hb = set(hard_breaks)
    items, buf, cur = [], [], None

    def flush():
        nonlocal buf
        if buf:
            items.append(["t", cur, "".join(buf)])
            buf = []

    for i, ch in enumerate(p.text):
        ri = p.char_run[i]
        if i in hb:
            flush()
            items.append(["br", None, "soft"])
        if ch == "\n":
            flush()
            items.append(["br", None, "ir"])
            continue
        if ri != cur:
            flush()
            cur = ri
        buf.append(ch)
    flush()
    # trim spaces at line edges (see docstring)
    out = []
    for k, it in enumerate(items):
        if it[0] == "t":
            after_soft = k > 0 and items[k - 1][0] == "br" and items[k - 1][2] == "soft"
            next_br = k == len(items) - 1 or items[k + 1][0] == "br"
            t = it[2]
            if after_soft:
                t = t.lstrip(" ")
            if next_br:
                t = t.rstrip(" ")
            if not t:
                continue
            it = ["t", it[1], t]
        out.append(it)
    # a:br takes the rPr of the run before it (else the next one)
    last = None
    for it in out:
        if it[0] == "t":
            last = it[1]
        elif last is not None:
            it[1] = last
    nxt = None
    for it in reversed(out):
        if it[0] == "t":
            nxt = it[1]
        elif it[1] is None:
            it[1] = nxt
    return [tuple(it[:2]) if it[0] == "br" else tuple(it) for it in out]


def _parent_size_px(p: Para, ri: int) -> float:
    """Size of the text a super/subscript run belongs to: the nearest normal-baseline run before it (else after)."""
    order = list(range(ri - 1, -1, -1)) + list(range(ri + 1, len(p.runs)))
    for j in order:
        r = p.runs[j]
        if not r.get("break") and r.get("baseline", "normal") in (None, "normal") and _run_size(r):
            return _run_size(r)
    return p.size_px


def field_guid(key: str) -> str:
    """Deterministic ST_Guid for an a:fld (unique per field instance in the deck)."""
    return "{" + str(uuid.uuid5(uuid.NAMESPACE_URL, "pptx-poc-field:" + key)).upper() + "}"


def write_paragraph(ap, p: Para, *, profile, opacity: float = 1.0, marl_emu: int = 0, indent_emu: int = 0,
                    algn: str = "l", spc_bef_px: float | None = None, spc_aft_px: float | None = None,
                    explicit_spacing: bool = False, hard_breaks=(), warn=None, field_key: str = ""):
    """Fill an empty <a:p> with pPr, runs (text fields as a:fld), breaks and the paragraph mark."""
    ppr = sub(ap, "a:pPr", marL=max(0, int(marl_emu)), indent=max(int(indent_emu), -max(0, int(marl_emu))),
              algn=algn, eaLnBrk=1, latinLnBrk=0, hangingPunct=0)
    # child order: lnSpc, spcBef, spcAft, buClrTx/buClr, buSzTx/buSzPct/buSzPts, buFontTx/buFont, buNone/buAutoNum/buChar
    ln = sub(ppr, "a:lnSpc")
    sub(ln, "a:spcPct", val=p.pct * 1000)
    if explicit_spacing or (spc_bef_px is not None and spc_bef_px > 0.01):
        sb = sub(ppr, "a:spcBef")
        sub(sb, "a:spcPts", val=clamp(int(round(max(0.0, spc_bef_px or 0.0) * 75)), 0, 158400))
    if explicit_spacing:
        sa = sub(ppr, "a:spcAft")
        sub(sa, "a:spcPts", val=clamp(int(round(max(0.0, spc_aft_px or 0.0) * 75)), 0, 158400))
    bullet = p.ir.get("bullet")
    if isinstance(bullet, dict) and bullet.get("type") in ("char", "number"):
        if bullet.get("color"):
            bc = sub(ppr, "a:buClr")
            bc.append(srgb(norm_color(bullet["color"], warn)))
        sub(ppr, "a:buSzPct", val=100000)
        sub(ppr, "a:buFont", typeface=p.face0.typeface)
        if bullet["type"] == "char":
            ch = clean_text(str(bullet.get("char") or "•"))[:1] or "•"
            sub(ppr, "a:buChar", char=ch)
        else:
            try:
                start = int(bullet.get("startAt", 1))
            except (TypeError, ValueError):
                start = 1
            scheme = bullet.get("scheme") if bullet.get("scheme") in AUTONUM_SCHEMES else "arabicPeriod"
            if bullet.get("scheme") not in (None, scheme) and warn:
                warn(f"bullet scheme {bullet.get('scheme')!r} is not an OOXML autonumber scheme -> arabicPeriod")
            sub(ppr, "a:buAutoNum", type=scheme, startAt=clamp(start, 1, 32767))
    else:
        sub(ppr, "a:buNone")

    last_rpr = None
    first_rpr = None
    rprs = {}
    for it in _items(p, hard_breaks):
        if it[0] == "t":
            run = p.runs[it[1]]
            face = profile.resolve(run.get("fontWeight", 400))
            base = run.get("baseline", "normal")
            if base in ("super", "sub"):
                parent = _parent_size_px(p, it[1])
                shift = parent / 3 + 1 if base == "super" else -(parent / 5 + 1)          # Blink's rule
                bl = clamp(int(round(shift / parent * 100000)), -100000, 100000)
                # declared size = parent size; PowerPoint draws baseline-shifted runs smaller (~58 %), like
                # `sup, sub { font-size: .58em }` in base.css (text-mapping.md §4)
                rpr = run_rpr("a:rPr", run, face, size_pt=parent * 0.75, opacity=opacity, baseline_pct1000=bl,
                              warn=warn)
            else:
                rpr = run_rpr("a:rPr", run, face, size_pt=(_run_size(run) or p.size_px) * 0.75,
                              opacity=opacity, warn=warn)
            ftype = run.get("field")
            if ftype:                                   # CT_TextField: rPr, pPr, t
                r = sub(ap, "a:fld", id=field_guid(f"{field_key}|{it[1]}"), type=str(ftype))
            else:
                r = sub(ap, "a:r")
            r.append(rpr)
            t = sub(r, "a:t")
            t.text = it[2]
            rprs[it[1]] = rpr
            if base in (None, "normal"):
                last_rpr = rpr
            if first_rpr is None:
                first_rpr = rpr
        else:
            br = sub(ap, "a:br")
            src = rprs.get(it[1]) if it[1] is not None else None
            if src is None and it[1] is not None:
                run = p.runs[it[1]]
                src = run_rpr("a:rPr", run, profile.resolve(run.get("fontWeight", 400)),
                              size_pt=(_run_size(run) or p.size_px) * 0.75, opacity=opacity, warn=warn)
            if src is None:
                src = run_rpr("a:rPr", {"color": "000000"}, p.face0, size_pt=p.size_px * 0.75, warn=warn)
            b = copy.deepcopy(src)
            b.tag = qn("a:rPr")
            for att in ("baseline",):
                b.attrib.pop(att, None)
            br.append(b)
    # paragraph mark: same face and size as the text -> adds no new face to the last line (text-mapping §2.5)
    mark_src = last_rpr if last_rpr is not None else first_rpr
    if mark_src is None:
        mark_src = run_rpr("a:rPr", {"color": "000000"}, p.face0, size_pt=p.size_px * 0.75, warn=warn)
    end = copy.deepcopy(mark_src)
    end.tag = qn("a:endParaRPr")
    for att in ("baseline", "spc", "u", "strike"):
        end.attrib.pop(att, None)
    if last_rpr is None:
        end.set("sz", str(clamp(int(round(p.size_px * 75)), 100, 400000)))
    ap.append(end)
    return ap


# ---------------------------------------------------------------------------------------------- width choice
def para_ppt_advances(p: Para, model, lo: int, hi: int) -> list[float]:
    """PowerPoint advances (1/8-pt snapped nominal advances + letter-spacing) of p.text[lo:hi]."""
    out = []
    for i in range(lo, hi):
        ch = p.text[i]
        run = p.runs[p.char_run[i]] if ch != "\n" else None
        if run is None or run.get("break"):
            out.append(0.0)
            continue
        size_px = _run_size(run) or p.size_px
        a = model.em(ch, int(num(run.get("fontWeight"), 400))) * size_px * 0.75
        out.append(pptbreak.snap_pt(a) + num(run.get("letterSpacingPx")) * 0.75)
    return out


def _segments(text: str):
    s = 0
    for i, ch in enumerate(text):
        if ch == "\n":
            yield s, i
            s = i + 1
    yield s, len(text)


def wrap_window_pt(paras: list[Para], model, marl_px: list[float]):
    """Intersection over all paragraphs/segments of the widths (pt, box width incl. marL) that reproduce
    Chromium's line breaks. None = no common width (-> hard breaks)."""
    lo, hi = 0.0, float("inf")
    for p, ml in zip(paras, marl_px):
        if not p.has_text:
            continue
        bullet = p.ir.get("bullet")
        indent_pt = 0.0 if bullet else num(p.ir.get("indentPx")) * 0.75
        for si, (s, e) in enumerate(_segments(p.text)):
            seg = p.text[s:e]
            if not seg.strip(" "):
                continue
            brs = [b - s for b in p.soft if s < b < e]
            adv = para_ppt_advances(p, model, s, e)
            win = pptbreak.window_for_breaks(seg, adv, brs, first_offset=indent_pt if si == 0 else 0.0)
            if win is None:
                return None
            lo = max(lo, win[0] + ml * 0.75)
            hi = min(hi, win[1] + ml * 0.75)
    return (lo, hi) if lo < hi else None


def hard_lines_fit(paras: list[Para], model, marl_px: list[float], indent_px: list[float], w_box_px: float) -> int:
    """Number of lines when every (hard-broken) line of the block, measured with PowerPoint's 1/8-pt advances from
    its start (marL, + indent on a paragraph's first line without a bullet), ends at least FIT_MARGIN_REL of the box
    before the box edge — at that width PowerPoint's breaker leaves every line as it is; 0 otherwise (a soft wrap, an
    unaligned line text, a line too close to the edge)."""
    limit_pt = w_box_px * 0.75 * (1.0 - FIT_MARGIN_REL)
    n = 0
    for p, ml, ind in zip(paras, marl_px, indent_px):
        if not p.has_text:
            continue
        if p.starts is None or p.soft:
            return 0
        for k in range(len(p.lines)):
            s, e = p.starts[k], p.ends[k]
            w = sum(para_ppt_advances(p, model, s, e))
            start = ml * 0.75 + (ind * 0.75 if k == 0 and not p.ir.get("bullet") else 0.0)
            if start + w > limit_pt:
                return 0
            n += 1
    return n


def fit_allowed(el_ir: dict, n_lines: int, has_field: bool, rotated: bool) -> bool:
    """May a block whose lines all end at hard breaks wrap at its HTML width (``wrap="square"``, "fit")?

    Only when the HTML would wrap a longer line inside the same box (judge J2-01): not CSS ``nowrap`` (it never
    wraps), not ``shrinkWrap`` (the box would widen first), not a text field (a page number must never wrap). A
    single-line block additionally needs the extractor's explicit flags (an IR without them keeps ``wrap="none"``) and
    no rotation (a rotated box is written symmetric about its centre)."""
    if has_field or el_ir.get("nowrap") is True or el_ir.get("shrinkWrap") is True:
        return False
    if n_lines > 1:
        return True
    return n_lines == 1 and el_ir.get("nowrap") is False and el_ir.get("shrinkWrap") is False and not rotated


def choose_width_pt(win, w_pt: float, rel_margin: float) -> float:
    lo, hi = win
    m = max(MARGIN_ABS_PT, rel_margin * lo)
    if hi - lo <= 2 * m:
        return (lo + hi) / 2 if math.isfinite(hi) else lo + m
    return clamp(w_pt, lo + m, hi - m)


# ---------------------------------------------------------------------------------------------- text box
def add_text(slide, el_ir: dict, ctx):
    """Add one native text box for an IR text element. Returns the python-pptx shape (or None)."""
    prof, log = ctx.prof, ctx.log
    warn = log.warn
    eid = el_ir.get("id", "text")
    ir_paras = [p for p in (el_ir.get("paragraphs") or []) if isinstance(p, dict)]
    if not ir_paras:
        log.skip(f"slide {ctx.slide_index}: text {eid!r} has no paragraphs — skipped")
        return None
    cb = el_ir.get("contentBox") or el_ir.get("box") or {}
    cx0, cy0 = num(cb.get("x")), num(cb.get("y"))
    cw, ch = max(0.0, num(cb.get("w"))), max(0.0, num(cb.get("h")))
    opacity = clamp(num(el_ir.get("opacity"), 1.0), 0.0, 1.0)
    rot = num(el_ir.get("rotationDeg"))

    # paragraphs (sizes of empty paragraphs borrowed from a neighbour)
    paras = []
    default = 16.0
    for p in ir_paras:
        pa = analyze_paragraph(p, prof, default)
        paras.append(pa)
        default = pa.size_px
    lines = [L for L in (el_ir.get("lines") or []) if isinstance(L, dict)]
    exact = map_lines(paras, lines, prof)
    have_para_idx = bool(lines) and all("paragraph" in L for L in lines)
    # an empty paragraph that Chromium did not render as a line would add a PowerPoint line: drop it
    if have_para_idx:
        keep = [p for p in paras if p.lines or p.has_text or "\n" in p.text]
        if len(keep) != len(paras) and keep:
            warn(f"slide {ctx.slide_index}: text {eid!r}: dropped {len(paras) - len(keep)} empty paragraph(s) "
                 "that Chromium did not render")
            paras = keep
    for p in paras:
        if not p.line_size_px and p.lines:
            p.line_size_px = [p.size_px] * len(p.lines)
            p.line_faces = [p.faces] * len(p.lines)

    # bullets/hanging indents left of the box: widen the box to the left so every marker is inside
    marl = [max(0.0, num(p.ir.get("marginLeftPx"))) for p in paras]
    indent = [num(p.ir.get("indentPx")) for p in paras]
    overhang = max([0.0] + [-(m + i) for m, i in zip(marl, indent)])
    x_left, w_box = cx0 - overhang, cw + overhang
    marl = [m + overhang for m in marl]

    # --- wrap mode and width
    align0 = {"l": "l", "ctr": "ctr", "r": "r", "just": "just"}.get(paras[0].ir.get("align", "l"), "l")
    soft_any = any(p.soft for p in paras) if exact else bool(el_ir.get("wrap"))
    mode, width_px = "none", w_box
    model = prof.advance_model
    if soft_any:
        if exact and model is not None:
            win = wrap_window_pt(paras, model, marl)
            if win is None:
                mode = "hard"
            else:
                rel = MARGIN_REL_EXACT if all(f.file for f in prof.faces) else MARGIN_REL_SUBST
                width_px = choose_width_pt(win, w_box * 0.75, rel) / 0.75
                mode = "window"
        else:
            mode, width_px = "slack", w_box * WRAP_SLACK
    elif exact and model is not None:
        n_fit = hard_lines_fit(paras, model, marl, indent, w_box)
        has_fld = any(r.get("field") for p in paras for r in p.runs if not r.get("break"))
        if n_fit and fit_allowed(el_ir, n_fit, has_fld, bool(rot)):
            mode = "fit"                              # hard-broken lines, all well inside the box: wrap="square"
    if mode == "hard":
        width_px = w_box
    if align0 == "ctr":
        x = x_left + (w_box - width_px) / 2
    elif align0 == "r":
        x = x_left + w_box - width_px
    else:
        x = x_left
    wrap_square = mode in ("window", "slack", "fit")

    # --- vertical: box top from the first measured baseline and PowerPoint's seat model
    p0 = paras[0]
    one_line0 = len(p0.lines) <= 1
    adv0, seat0 = _line_metrics_px(p0, 0 if p0.line_size_px else None, with_mark=one_line0)
    first_baseline = num(p0.lines[0].get("baseline"), None) if p0.lines else None
    if first_baseline is None and lines:
        first_baseline = num(lines[0].get("baseline"), None)
    y = (first_baseline - seat0) if first_baseline is not None else cy0

    # --- paragraph gaps (spcBef of paragraphs 2..n) and PowerPoint's total text height
    gaps = [0.0]
    for pi in range(1, len(paras)):
        prev, cur = paras[pi - 1], paras[pi]
        gap = None
        if prev.lines and cur.lines:
            kl = len(prev.lines) - 1
            adv_p, seat_p = _line_metrics_px(prev, kl, with_mark=True)
            _, seat_c = _line_metrics_px(cur, 0, with_mark=len(cur.lines) <= 1)
            step = num(cur.lines[0].get("baseline")) - num(prev.lines[-1].get("baseline"))
            gap = step - (adv_p - seat_p + seat_c)
        if gap is None:
            css_lh_prev = num(prev.ir.get("lineHeightPx"), 0.0) or prev.pct / 100 * 1.2 * prev.size_px
            gap = paragraph_gap_px(prev.ir, cur.ir) + (css_lh_prev - ppt_advance_pt(prev.size_px * 0.75, prev.pct)
                                                       * PX_PER_PT)
        if gap < -0.5:
            warn(f"slide {ctx.slide_index}: text {eid!r}: negative paragraph gap {gap:.2f}px clamped to 0")
        gaps.append(max(0.0, gap))
    text_h = 0.0
    for pi, p in enumerate(paras):
        n = max(1, len(p.lines)) if p.lines else max(1, p.text.count("\n") + 1)
        if mode == "hard":
            n = max(n, len(p.soft) + p.text.count("\n") + 1)
        text_h += gaps[pi]
        for k in range(n):
            text_h += _line_metrics_px(p, k if k < len(p.line_size_px) else None, with_mark=False)[0]

    # --- box geometry (rotation about the CSS box centre: symmetric box + insets)
    ins = [0.0, 0.0, 0.0, 0.0]            # l, t, r, b (px)
    if rot:
        bx = el_ir.get("box") or cb
        ccx = num(bx.get("x")) + num(bx.get("w")) / 2
        ccy = num(bx.get("y")) + num(bx.get("h")) / 2
        hw = max(ccx - x, x + width_px - ccx, 0.5)
        hh = max(ccy - y, y + text_h - ccy, 0.5)
        ins = [x - (ccx - hw), y - (ccy - hh), (ccx + hw) - (x + width_px), (ccy + hh) - (y + text_h)]
        ins = [max(0.0, v) for v in ins]
        bxx, byy, bw, bh = ccx - hw, ccy - hh, 2 * hw, 2 * hh
    else:
        bxx, byy, bw = x, y, width_px
        bh = max(cy0 + ch - y, text_h, 1.0)
    # a wrap="square" box wraps an edited, longer text inside its HTML width; the extra lines would run into whatever
    # follows (a title's second line under the cards / over the subtitle, a stat label onto its number). normAutofit
    # (PowerPoint's own title/body placeholder setting, "Shrink text on overflow") shrinks such text into the box
    # instead; no fontScale is written (100 %), and the box is >= 5 % taller than PowerPoint's text height, so the
    # unedited text never triggers it (anchor t: the extra height below changes no baseline). Rotated boxes and
    # wrap="none" boxes (which never overflow vertically) keep noAutofit (fixer round 3, EDIT-01 / EDIT-03)
    autofit = wrap_square and not rot
    if autofit:
        bh = max(bh, text_h * (1.0 + AUTOFIT_SLACK_REL))

    shape = slide.shapes.add_textbox(Emu(emu(bxx)), Emu(emu(byy)), Emu(max(0, emu(bw))), Emu(max(0, emu(bh))))
    shape.name = ctx.namer(ctx.name_for(el_ir) if hasattr(ctx, "name_for") else eid)
    sp = shape._element
    ph_type = el_ir.get("placeholder") if el_ir.get("placeholder") in PLACEHOLDER_TYPES else None
    if ph_type:
        make_placeholder(sp, ph_type)
    spPr = sp.spPr
    ln = sub(spPr, "a:ln")
    sub(ln, "a:noFill")
    sub(spPr, "a:effectLst")
    if rot:
        spPr.find(qn("a:xfrm")).set("rot", str(ang60k(rot)))
    txBody = sp.txBody
    for child in list(txBody):
        txBody.remove(child)
    body = sub(txBody, "a:bodyPr", wrap="square" if wrap_square else "none",
               lIns=emu(ins[0]), tIns=emu(ins[1]), rIns=emu(ins[2]), bIns=emu(ins[3]), rtlCol=0, anchor="t")
    sub(body, "a:normAutofit" if autofit else "a:noAutofit")
    if autofit:
        ctx.stats["text:autofit"] = ctx.stats.get("text:autofit", 0) + 1
    sub(txBody, "a:lstStyle")
    for pi, p in enumerate(paras):
        ap = sub(txBody, "a:p")
        algn = {"l": "l", "ctr": "ctr", "r": "r", "just": "just"}.get(p.ir.get("align", "l"), "l")
        write_paragraph(ap, p, profile=prof, opacity=opacity, marl_emu=emu(marl[pi]),
                        indent_emu=emu(indent[pi]), algn=algn, spc_bef_px=gaps[pi] if pi else None,
                        spc_aft_px=0.0 if ph_type else None, explicit_spacing=bool(ph_type),
                        hard_breaks=p.soft if mode == "hard" else (), warn=warn,
                        field_key=f"{getattr(ctx, 'slide_index', 0)}|{eid}|{pi}")
    ctx.stats[f"text:{mode}"] = ctx.stats.get(f"text:{mode}", 0) + 1
    if ph_type:
        ctx.stats[f"placeholder:{ph_type}"] = ctx.stats.get(f"placeholder:{ph_type}", 0) + 1
    if any(r.get("field") for p in paras for r in p.runs if not r.get("break")):
        ctx.stats["text:field"] = ctx.stats.get("text:field", 0) + 1
    return shape


def make_placeholder(sp, ph_type: str) -> None:
    """Turn a text box p:sp into a placeholder of `ph_type` (``<a:spLocks noGrp="1"/>`` like PowerPoint's own)."""
    nv = sp.find(qn("p:nvSpPr"))
    cnvsp = nv.find(qn("p:cNvSpPr"))
    cnvsp.attrib.pop("txBox", None)
    for c in list(cnvsp):
        cnvsp.remove(c)
    sub(cnvsp, "a:spLocks", noGrp="1")
    nvpr = nv.find(qn("p:nvPr"))
    for c in list(nvpr):
        nvpr.remove(c)
    sub(nvpr, "p:ph", type=ph_type, idx=PLACEHOLDER_IDX.get(ph_type))
