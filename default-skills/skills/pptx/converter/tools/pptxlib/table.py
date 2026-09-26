"""IR `table` element -> native PowerPoint table (port of scratch/shape-table/stlib.add_table + the v2 rules).

docs/research/shape-table-mapping.md §5 and CONTRACT v2:
* tableStyleId {2D5ABB26-…} ("No Style, No Grid"), no banding/first-column/last-row flags; ``firstRow="1"`` only
  when the IR's first row is header cells (``<th>``: the header-row semantics, nothing visible — fixer round 2);
* frame at (table.x + outerLeft/2, table.y + outerTop/2) — CSS collapsed borders are centred on the grid lines;
  gridCol/tr sizes rounded cumulatively so grid lines land on the Chromium positions;
* merges first (python-pptx writes the MS-OI29500 span/merge flags), then text and a:tcPr;
* a:tcPr in schema order lnL lnR lnT lnB … fill; each grid edge's border written on BOTH neighbours;
  margins = padding + half the collapsed border; anchor t/ctr/b;
* every cell paragraph (also empty/spanned) gets explicit lnSpc (spcPct) / spcBef / spcAft and an
  a:endParaRPr@sz; ``tr@h >= marT + marB + lines x pct x 1.2 x size`` (PowerPoint's model, with the line count
  simulated at the cell's width) so PowerPoint never grows a row;
* builder refinements (same models as the text boxes): the cell's side margins are nudged (alignment-aware, never
  below 0) when PowerPoint's 1/8-pt advances would otherwise break a line differently from Chromium, and marT/marB
  are shifted together (sum unchanged) so the first baseline sits where Chromium put it (Chromium's seat from the
  IR's measured first line of the cell; fixer round 2);
* table-level background (judge J1-01): the IR's preceding ``<table>::bg`` shape (opaque solid, square, no line —
  ``table_bg_of``) is absorbed INTO the table: every cell without a fill of its own gets the table background colour
  (a translucent cell fill is composited over it, as CSS paints the cell over the table background) and the shape's
  shadow becomes the table's own ``a:tblPr/a:effectLst`` shadow (PowerPoint's Table Design > Effects > Shadow). No
  separate rectangle remains, so inserted rows, a moved or resized table keep the white background and the shadow
  (a table cannot be grouped in PowerPoint, so a caster shape could never follow it). Anything else (rounded,
  gradient or translucent table backgrounds, a table border in the separate model) keeps the preceding shape.
"""
from __future__ import annotations

import math

from lxml import etree
from pptx.oxml.ns import qn
from pptx.util import Emu

from . import pptbreak
from .core import clamp, emu, norm_color, num, sub
from .shapes import effect_el, fill_el, line_el
from .text import (MARGIN_ABS_PT, MARGIN_REL_EXACT, MARGIN_REL_SUBST, PX_PER_PT, _segments, analyze_paragraph,
                   paragraph_gap_px, para_ppt_advances, ppt_advance_pt, ppt_seat_pt, ppt_share, write_paragraph)

NO_STYLE_NO_GRID = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"
ABSORB_MAX_PX = 1.0        # largest PowerPoint-vs-Chromium content excess absorbed by margins instead of row growth


def _line_w(line) -> float:
    return num(line.get("widthPx")) if isinstance(line, dict) else 0.0


def _merge_edge(cur, new):
    """Collapsed-border resolution of one grid edge seen from two cells (resolved borders should agree)."""
    if not isinstance(new, dict) or _line_w(new) <= 0:
        return cur
    if not isinstance(cur, dict) or _line_w(cur) <= 0:
        return new
    return new if _line_w(new) > _line_w(cur) else cur


def _css_advances(p, model, s, e):
    out = []
    for i in range(s, e):
        ch = p.text[i]
        run = p.runs[p.char_run[i]] if ch != "\n" else None
        if run is None or run.get("break"):
            out.append(0.0)
            continue
        size_px = num(run.get("sizePx"), 0.0) or p.size_px
        out.append(model.em(ch, int(num(run.get("fontWeight"), 400))) * size_px * 0.75
                   + num(run.get("letterSpacingPx")) * 0.75)
    return out


def _count_lines(p, model, avail_pt: float, snapped: bool) -> tuple[int, list[int]]:
    """(lines, soft-break indices) of paragraph p at width avail_pt with Chromium-like (snapped=False) or
    PowerPoint (snapped=True) advances and the shared greedy breaker."""
    n, soft = 0, []
    for s, e in _segments(p.text):
        seg = p.text[s:e]
        if not seg.strip(" ") or model is None:
            n += 1
            continue
        adv = para_ppt_advances(p, model, s, e) if snapped else _css_advances(p, model, s, e)
        lines = pptbreak.simulate_adv(seg, adv, avail_pt)
        n += len(lines)
        pos = s
        for L in lines[:-1]:
            pos += len(L)
            soft.append(pos)
    return max(1, n), soft


def _chromium_seat_px(p, model, line: dict | None = None) -> float | None:
    """Chromium's baseline below the top of its first line box (px). From the IR's MEASURED first line when the cell
    has one (text fragment top/bottom/baseline; Blink floors the half-leading above the text), else modelled from the
    font's rounded ascent/descent. The model misses Blink's Linux rule that moves 1 px from the ascent to the descent
    when the descent was rounded down (Pretendard 17 px: 15 / 5, not 16 / 4), which put every body row 1 px low —
    found by the fidelity gate's cell-baseline check (judge J2-08)."""
    S = p.size_px
    L = num(p.ir.get("lineHeightPx"), 0.0) or 1.2 * S
    if isinstance(line, dict) and all(isinstance(line.get(k), (int, float)) for k in ("top", "bottom", "baseline")):
        fh = float(line["bottom"]) - float(line["top"])
        if 0 < fh <= L + 1e-6:
            return math.floor((L - fh) / 2) + (float(line["baseline"]) - float(line["top"]))
    if model is None:
        return None
    try:
        asc, desc = model.css_line_metrics(int(num(p.runs[0].get("fontWeight"), 400)) if p.runs else 400)
    except Exception:  # noqa: BLE001
        return None
    A, D = round(asc * S), round(desc * S)
    return math.floor((L - (A + D)) / 2) + A


def is_header_row(cells) -> bool:
    """True when every cell of the first row (a column-spanned slot counts with its origin) is a header cell."""
    if not cells or not isinstance(cells[0], list) or not cells[0]:
        return False
    origin = [c for c in cells[0] if isinstance(c, dict) and not c.get("covered")]
    return bool(origin) and all(c.get("header") is True for c in origin)


def table_bg_of(shape: dict | None, table: dict) -> dict | None:
    """The IR shape that is `table`'s own background (``<id>::bg`` right before ``<id>::table``) when it can live
    inside the table: opaque solid fill, square corners, no line, no rotation, same box. None otherwise."""
    if not isinstance(shape, dict) or shape.get("kind") != "shape" or not isinstance(table, dict):
        return None
    tid = str(table.get("id") or "")
    if not tid.endswith("::table") or shape.get("id") != tid[: -len("::table")] + "::bg":
        return None
    f = shape.get("fill")
    if not isinstance(f, dict) or f.get("type") != "solid":
        return None
    if num(f.get("alpha"), 1.0) * num(shape.get("opacity"), 1.0) < 0.99999 or shape.get("line"):
        return None
    if shape.get("geometry", "rect") != "rect" and num(shape.get("radiusPx")) > 0:
        return None
    if num(shape.get("rotationDeg")) or num(table.get("rotationDeg")):
        return None
    a, b = shape.get("box") or {}, table.get("box") or {}
    if any(abs(num(a.get(k)) - num(b.get(k))) > 0.5 for k in ("x", "y", "w", "h")):
        return None
    return shape


def _over(fill, bg_rgb: str):
    """Solid cell fill composited over the opaque table background (CSS paints the cell over it)."""
    if not isinstance(fill, dict) or fill.get("type") != "solid":
        return fill
    a = clamp(num(fill.get("alpha"), 1.0), 0.0, 1.0)
    if a >= 0.99999:
        return fill
    c = [int(norm_color(fill.get("color"))[k:k + 2], 16) for k in (0, 2, 4)]
    g = [int(bg_rgb[k:k + 2], 16) for k in (0, 2, 4)]
    return {"type": "solid", "color": "".join(f"{round(x * a + y * (1 - a)):02X}" for x, y in zip(c, g)), "alpha": 1.0}


def add_table(slide, e: dict, ctx, table_bg: dict | None = None):
    prof, log = ctx.prof, ctx.log
    warn = log.warn
    eid = e.get("id", "table")
    cols = [max(0.0, num(v)) for v in (e.get("columnsPx") or [])]
    rows = [max(0.0, num(v)) for v in (e.get("rowsPx") or [])]
    cells = e.get("cells") or []
    nR, nC = len(rows), len(cols)
    if not nR or not nC or len(cells) != nR or any(len(r) != nC for r in cells):
        log.skip(f"slide {ctx.slide_index}: table {eid!r}: grid {nR}x{nC} does not match cells — skipped")
        return None
    if num(e.get("rotationDeg")):
        warn(f"slide {ctx.slide_index}: table {eid!r}: rotation ignored (Office ignores rot on a graphicFrame)")
    op = clamp(num(e.get("opacity"), 1.0), 0.0, 1.0)
    model = prof.advance_model
    rel_margin = MARGIN_REL_EXACT if all(f.file for f in prof.faces) else MARGIN_REL_SUBST

    # --- spans (validated) and origin map
    origin, span = {}, {}
    for r in range(nR):
        for c in range(nC):
            cell = cells[r][c] if isinstance(cells[r][c], dict) else {"covered": True}
            if cell.get("covered"):
                continue
            rs = clamp(int(num(cell.get("rowSpan"), 1) or 1), 1, nR - r)
            cs = clamp(int(num(cell.get("colSpan"), 1) or 1), 1, nC - c)
            if any((rr, cc) in origin for rr in range(r, r + rs) for cc in range(c, c + cs)):
                warn(f"slide {ctx.slide_index}: table {eid!r}: overlapping span at ({r},{c}) — span dropped")
                rs = cs = 1
                if (r, c) in origin:
                    continue
            span[(r, c)] = (rs, cs)
            for rr in range(r, r + rs):
                for cc in range(c, c + cs):
                    origin[(rr, cc)] = (r, c)
    for r in range(nR):
        for c in range(nC):
            if (r, c) not in origin:            # a covered cell nobody spans: make it a plain empty cell
                warn(f"slide {ctx.slide_index}: table {eid!r}: orphan covered cell ({r},{c}) -> empty cell")
                origin[(r, c)] = (r, c)
                span[(r, c)] = (1, 1)
                cells[r][c] = {"rowSpan": 1, "colSpan": 1, "paragraphs": []}

    # --- one border per grid edge: V[r][c] (c = 0..nC), H[r][c] (r = 0..nR)
    V = [[None] * (nC + 1) for _ in range(nR)]
    H = [[None] * nC for _ in range(nR + 1)]
    for (r, c), (rs, cs) in span.items():
        b = cells[r][c].get("borders") or {}
        for rr in range(r, r + rs):
            V[rr][c] = _merge_edge(V[rr][c], b.get("left"))
            V[rr][c + cs] = _merge_edge(V[rr][c + cs], b.get("right"))
        for cc in range(c, c + cs):
            H[r][cc] = _merge_edge(H[r][cc], b.get("top"))
            H[r + rs][cc] = _merge_edge(H[r + rs][cc], b.get("bottom"))

    box = e.get("box") or {}
    x0 = num(box.get("x")) + _line_w(V[0][0]) / 2.0
    y0 = num(box.get("y")) + _line_w(H[0][0]) / 2.0
    gshape = slide.shapes.add_table(nR, nC, Emu(emu(x0)), Emu(emu(y0)), Emu(max(1, emu(sum(cols)))),
                                    Emu(max(1, emu(sum(rows)))))
    gshape.name = ctx.namer(ctx.name_for(e) if hasattr(ctx, "name_for") else eid)
    tbl = gshape.table
    tbl.first_row = tbl.horz_banding = tbl.first_col = tbl.last_row = tbl.last_col = tbl.vert_banding = False
    # a first row of header cells (IR `header`, <th>) is PowerPoint's header row: Table Design > Header Row,
    # the Accessibility Checker's table-header rule, screen readers' column headers (judge J2-03). "No Style, No Grid"
    # has no firstRow formatting and every cell property is explicit, so the flag changes nothing visible.
    if is_header_row(cells):
        tbl.first_row = True
        ctx.stats["table:header-row"] = ctx.stats.get("table:header-row", 0) + 1
    sid = tbl._tbl.tblPr.find(qn("a:tableStyleId"))
    if sid is None:
        sid = etree.SubElement(tbl._tbl.tblPr, qn("a:tableStyleId"))
    sid.text = NO_STYLE_NO_GRID
    bg_rgb = None
    if table_bg is not None:
        bg_rgb = norm_color(table_bg["fill"].get("color"), warn)
        if isinstance(table_bg.get("shadow"), dict):
            if num(table_bg["shadow"].get("spreadPx")):
                warn(f"slide {ctx.slide_index}: table {eid!r}: box-shadow spread is not representable (dropped)")
            # CT_TableProperties: fill, effect, tableStyleId — the table's own shadow (Table Design > Effects)
            sid.addprevious(effect_el(table_bg["shadow"], clamp(num(table_bg.get("opacity"), 1.0), 0.0, 1.0), 0.0,
                                      warn))
        ctx.stats["table:bg-absorbed"] = ctx.stats.get("table:bg-absorbed", 0) + 1
    acc, prev = 0.0, 0
    col_emu = []
    for c, wpx in enumerate(cols):
        acc += wpx
        v = emu(acc)
        col_emu.append(max(1, v - prev))
        tbl.columns[c].width = Emu(col_emu[-1])
        prev = v
    acc, prev = 0.0, 0
    row_emu = []
    for r, hpx in enumerate(rows):
        acc += hpx
        v = emu(acc)
        row_emu.append(max(0, v - prev))
        prev = v

    # merges first
    for (r, c), (rs, cs) in span.items():
        if rs > 1 or cs > 1:
            tbl.cell(r, c).merge(tbl.cell(r + rs - 1, c + cs - 1))

    # default size for empty cells: the table's most common run size
    sizes = {}
    for (r, c) in span:
        for p in cells[r][c].get("paragraphs") or []:
            for run in (p.get("runs") or []) if isinstance(p, dict) else []:
                if isinstance(run, dict) and num(run.get("sizePx")) > 0:
                    k = num(run.get("sizePx"))
                    sizes[k] = sizes.get(k, 0) + len(str(run.get("text") or ""))
    default_px = max(sizes, key=sizes.get) if sizes else 14.0

    # --- per origin cell: paragraphs, margins, needed height
    plan = {}
    for (r, c), (rs, cs) in span.items():
        src = cells[r][c]
        pad = src.get("paddingPx") or {}
        bl, br = _line_w(V[r][c]) / 2.0, _line_w(V[r][c + cs]) / 2.0
        bt, bb = _line_w(H[r][c]) / 2.0, _line_w(H[r + rs][c]) / 2.0
        mar = {"l": num(pad.get("l")) + bl, "r": num(pad.get("r")) + br,
               "t": num(pad.get("t")) + bt, "b": num(pad.get("b")) + bb}
        irp = [p for p in (src.get("paragraphs") or []) if isinstance(p, dict)] or [{"runs": []}]
        paras, d = [], default_px
        for p in irp:
            pa = analyze_paragraph(p, prof, d)
            paras.append(pa)
            d = pa.size_px
        width_px = sum(cols[c:c + cs])
        align = {"l": "l", "ctr": "ctr", "r": "r", "just": "just"}.get(irp[0].get("align", "l"), "l")
        # wrap parity: Chromium's lines (simulated with the CSS advances) must also be PowerPoint's
        avail_px = width_px - mar["l"] - mar["r"]
        if model is not None and avail_px > 0 and any(p.has_text for p in paras):
            lo, hi = 0.0, float("inf")
            for p in paras:
                if not p.has_text:
                    continue
                _, soft = _count_lines(p, model, avail_px * 0.75, snapped=False)
                p.soft = soft
                for s, e2 in _segments(p.text):
                    seg = p.text[s:e2]
                    if not seg.strip(" "):
                        continue
                    brs = [b - s for b in soft if s < b < e2]
                    win = pptbreak.window_for_breaks(seg, para_ppt_advances(p, model, s, e2), brs)
                    if win is None:
                        lo, hi = 1.0, 0.0
                        break
                    lo, hi = max(lo, win[0]), min(hi, win[1])
            a_pt = avail_px * 0.75
            m = max(MARGIN_ABS_PT, rel_margin * lo)
            if lo < hi:
                target = (lo + hi) / 2 if hi - lo <= 2 * m else clamp(a_pt, lo + m, hi - m)
                delta_px = (target - a_pt) / 0.75
                if abs(delta_px) > 1e-3:
                    if align == "r":
                        take = {"l": delta_px}
                    elif align == "ctr":
                        take = {"l": delta_px / 2, "r": delta_px / 2}
                    else:
                        take = {"r": delta_px}
                    for side, dv in take.items():
                        mar[side] = max(0.0, mar[side] - dv)
                    ctx.stats["table:margin-nudge"] = ctx.stats.get("table:margin-nudge", 0) + 1
        avail_pt = max(0.0, (width_px - mar["l"] - mar["r"]) * 0.75)
        # PowerPoint's content height at that width
        need = mar["t"] + mar["b"]
        gaps = [0.0]
        for i, p in enumerate(paras):
            nlines = _count_lines(p, model, avail_pt, snapped=True)[0] if p.has_text else max(
                1, p.text.count("\n") + 1)
            if i:
                prv = paras[i - 1]
                css_lh = num(prv.ir.get("lineHeightPx"), 0.0) or 1.2 * prv.size_px
                g = paragraph_gap_px(prv.ir, p.ir) + (css_lh - ppt_advance_pt(prv.size_px * 0.75, prv.pct) * PX_PER_PT)
                gaps.append(max(0.0, g))
                need += gaps[-1]
            need += nlines * ppt_advance_pt(p.size_px * 0.75, p.pct) * PX_PER_PT
        # first-baseline parity, marT + marB unchanged: PowerPoint's first baseline (its cell model: the text block
        # anchored t / ctr / b inside the spanned rows minus marT/marB, 1.2 x pct x S per line, baseline at the seat)
        # is put ON Chromium's measured first baseline of the cell (IR lines; fixer round 2 — the seat-difference
        # rule assumed Chromium's content box at padding + half border, which a collapsed-border quirk can move by a
        # fraction of a px); a cell without measured lines shifts by (Chromium seat - PowerPoint seat)
        p0 = paras[0]
        ppt_seat = ppt_seat_pt(p0.size_px * 0.75, ppt_share({p0.face0, p0.mark_face} | set(p0.faces)),
                               p0.pct) * PX_PER_PT
        first_line = next((L for L in (src.get("lines") or []) if isinstance(L, dict) and L.get("paragraph", 0) == 0
                           and isinstance(L.get("baseline"), (int, float))), None)
        dlt = None
        if first_line is not None:
            row_top = y0 + sum(rows[:r])
            area_t, area_b = row_top + mar["t"], row_top + sum(rows[r:r + rs]) - mar["b"]
            block_h = need - mar["t"] - mar["b"]
            va = src.get("vAlign", "top")
            top = area_t if va == "top" else (area_b - block_h if va == "bottom" else (area_t + area_b - block_h) / 2)
            dlt = float(first_line["baseline"]) - (top + ppt_seat)
        else:
            chr_seat = _chromium_seat_px(p0, model)
            if chr_seat is not None:
                dlt = chr_seat - ppt_seat
        if dlt is not None and abs(dlt) < 0.5 * p0.size_px:
            dlt = clamp(dlt, -mar["t"], mar["b"])
            mar["t"] += dlt
            mar["b"] -= dlt
        plan[(r, c)] = dict(paras=paras, gaps=gaps, mar=mar, need=need, align=align)

    # --- row heights: tr@h >= PowerPoint's content height of every cell (spans: over the spanned rows).
    # A sub-pixel excess (whole-percent spcPct rounding, e.g. 24/(1.2*17) = 117.6 % -> 118 %: +0.07 px per line) is
    # absorbed by the cell's non-anchored margin(s) so the grid lines stay on Chromium's pixels; only a real deficit
    # (e.g. PowerPoint needing an extra line) grows the row.
    grown = []
    for (r, c), (rs, cs) in sorted(span.items(), key=lambda kv: kv[1][0]):
        pl = plan[(r, c)]
        need_emu = int(math.ceil(pl["need"] * 9525))
        have = sum(row_emu[r:r + rs])
        deficit_px = (need_emu - have) / 9525
        if 0 < deficit_px <= ABSORB_MAX_PX:
            v = cells[r][c].get("vAlign", "top")
            sides = {"top": ("b",), "bottom": ("t",)}.get(v, ("t", "b"))
            mar = pl["mar"]
            if all(mar[s] >= deficit_px / len(sides) for s in sides):
                for s in sides:
                    mar[s] -= deficit_px / len(sides) + 1 / 9525      # + 1 EMU against rounding
                ctx.stats["table:margin-absorb"] = ctx.stats.get("table:margin-absorb", 0) + 1
                continue
        if need_emu > have:
            row_emu[r + rs - 1] += need_emu - have
            grown.append((r + rs - 1, (need_emu - have) / 9525))
    for r in range(nR):
        tbl.rows[r].height = Emu(row_emu[r])
    if grown:
        worst = max(grown, key=lambda g: g[1])
        warn(f"slide {ctx.slide_index}: table {eid!r}: {len(grown)} row(s) grown so PowerPoint needs no auto-grow "
             f"(max +{worst[1]:.2f}px on row {worst[0]})")

    # --- cells
    for r in range(nR):
        for c in range(nC):
            orr, occ = origin[(r, c)]
            src = cells[orr][occ]
            pl = plan[(orr, occ)]
            rs, cs = span[(orr, occ)]
            tc = tbl.cell(r, c)._tc
            old = tc.find(qn("a:tcPr"))
            if old is not None:
                tc.remove(old)
            tcPr = etree.SubElement(tc, qn("a:tcPr"))          # after a:txBody (CT_TableCell order)
            mar = pl["mar"]
            tcPr.set("marL", str(max(0, emu(mar["l"]))))
            tcPr.set("marR", str(max(0, emu(mar["r"]))))
            tcPr.set("marT", str(max(0, emu(mar["t"]))))
            tcPr.set("marB", str(max(0, emu(mar["b"]))))
            tcPr.set("anchor", {"top": "t", "middle": "ctr", "bottom": "b"}.get(src.get("vAlign", "top"), "t"))
            # grid-edge borders; the merge ORIGIN carries the region's outer right/bottom edges (readers such as
            # LibreOffice draw a merged cell with the origin's lnR/lnB — measured: without this the outer edge of a
            # row/col-spanned cell vanishes); covered cells keep their own grid edges (interior ones are noFill)
            is_origin = (r, c) == (orr, occ)
            right = V[r][c + cs] if is_origin else V[r][c + 1]
            bottom = H[r + rs][c] if is_origin else H[r + 1][c]
            tcPr.append(line_el(V[r][c], op, tag="a:lnL", warn=warn))
            tcPr.append(line_el(right, op, tag="a:lnR", warn=warn))
            tcPr.append(line_el(H[r][c], op, tag="a:lnT", warn=warn))
            tcPr.append(line_el(bottom, op, tag="a:lnB", warn=warn))
            cfill = src.get("fill")
            if bg_rgb is not None:                                 # the table background, inside the table
                cfill = _over(cfill, bg_rgb) if isinstance(cfill, dict) else {"type": "solid", "color": bg_rgb,
                                                                                "alpha": 1.0}
            tcPr.append(fill_el(cfill, op, warn))                  # fill LAST
            txBody = tc.find(qn("a:txBody"))
            for p_old in txBody.findall(qn("a:p")):
                txBody.remove(p_old)
            if (r, c) == (orr, occ):
                paras, gaps = pl["paras"], pl["gaps"]
            else:                                                  # spanned cell: one empty paragraph
                p0 = pl["paras"][0]
                paras = [analyze_paragraph({"runs": [], "lineHeightPx": p0.ir.get("lineHeightPx"),
                                            "align": p0.ir.get("align", "l")}, prof, p0.size_px)]
                paras[0].face0 = paras[0].mark_face = p0.face0
                gaps = [0.0]
            for i, p in enumerate(paras):
                ap = sub(txBody, "a:p")
                algn = {"l": "l", "ctr": "ctr", "r": "r", "just": "just"}.get(p.ir.get("align", "l"), "l")
                write_paragraph(ap, p, profile=prof, opacity=op, algn=algn, spc_bef_px=gaps[i], spc_aft_px=0.0,
                                explicit_spacing=True, marl_emu=max(0, emu(num(p.ir.get("marginLeftPx")))),
                                indent_emu=emu(num(p.ir.get("indentPx"))), warn=warn)
    ctx.stats["table"] = ctx.stats.get("table", 0) + 1
    return gshape
