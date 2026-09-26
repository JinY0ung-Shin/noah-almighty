#!/usr/bin/env python3
"""The `shape-table-lint` gate: structural lint of a built PPTX's shapes, pictures, tables and ids.

Extracted from the PoC's shape/table lane (scratch/shape-table/selftest.py ``lint()`` plus the one constant of
scratch/shape-table/stlib.py it uses, ``NO_STYLE_NO_GRID``); the rules are unchanged.

    python3 tools/gates/shape_table_lint.py DECK.pptx [--json OUT.json]

Checks slides AND slide layouts (the builder writes repeated chrome into custom layouts): unique p:cNvPr ids in
1..2^31-1, 6-hex srgbClr, no p:style on shapes, spPr / a:ln / tcPr child order, explicit fill / line / join /
effectLst, outerShdw sx/sy, alphaModFix < 100 %, blip extLst last, table style "No Style, No Grid" without banding
flags, tc counts = gridCol, cell anchors Office accepts, empty cell paragraphs with endParaRPr@sz.
Exit 0 = no problem, 1 = problems, 2 = unreadable input.
"""
import argparse
import json
import sys
import zipfile
from pathlib import Path

from lxml import etree

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pdeathsig  # noqa: E402  tools/pdeathsig.py

NO_STYLE_NO_GRID = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"   # PowerPoint's "No Style, No Grid" table style (stlib)

NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "p": "http://schemas.openxmlformats.org/presentationml/2006/main"}
A = "{%s}" % NS["a"]
P = "{%s}" % NS["p"]
FILLS = {A + t for t in ("noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill")}
GEOMS = {A + "prstGeom", A + "custGeom"}
SPPR_ORDER = [{A + "xfrm"}, GEOMS, FILLS, {A + "ln"}, {A + "effectLst", A + "effectDag"}, {A + "scene3d"}, {A + "sp3d"}, {A + "extLst"}]
LN_ORDER = [{A + t for t in ("noFill", "solidFill", "gradFill", "pattFill")}, {A + "prstDash", A + "custDash"},
            {A + "round", A + "bevel", A + "miter"}, {A + "headEnd"}, {A + "tailEnd"}, {A + "extLst"}]
TCPR_ORDER = [{A + "lnL"}, {A + "lnR"}, {A + "lnT"}, {A + "lnB"}, {A + "lnTlToBr"}, {A + "lnBlToTr"}, {A + "cell3D"}, FILLS,
              {A + "headers"}, {A + "extLst"}]


def in_order(el, groups):
    pos = -1
    for ch in el:
        if not isinstance(ch.tag, str):
            continue
        idx = next((i for i, g in enumerate(groups) if ch.tag in g), None)
        if idx is None or idx < pos:
            return False, ch.tag
        pos = idx
    return True, None


def lint(path):
    problems = []
    z = zipfile.ZipFile(path)
    slides = sorted(n for n in z.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml"))
    # slide layouts too: the builder writes repeated chrome (footer rule, brand mark, page number) into custom
    # layouts; their non-placeholder shapes must meet the same rules (placeholders are template/prompt objects)
    layouts = sorted(n for n in z.namelist() if n.startswith("ppt/slideLayouts/slideLayout") and n.endswith(".xml"))
    for n in slides + layouts:
        root = etree.fromstring(z.read(n))
        ids = [int(c.get("id")) for c in root.iter(P + "cNvPr")]
        if len(ids) != len(set(ids)):
            problems.append(f"{n}: duplicate cNvPr ids")
        if any(i < 1 or i > 2147483647 for i in ids):
            problems.append(f"{n}: cNvPr id outside 1..2^31-1")
        for c in root.iter(A + "srgbClr"):
            v = c.get("val", "")
            if len(v) != 6 or any(ch not in "0123456789ABCDEFabcdef" for ch in v):
                problems.append(f"{n}: bad srgbClr {v!r}")
        for sp in root.iter(P + "sp"):
            name = sp.find(f"{P}nvSpPr/{P}cNvPr").get("name")
            if n in layouts and sp.find(f"{P}nvSpPr/{P}nvPr/{P}ph") is not None:
                continue
            if sp.find(P + "style") is not None:
                problems.append(f"{n}: p:sp '{name}' keeps p:style (theme line/fill/shadow leak; LibreOffice ignores an empty effectLst)")
            spPr = sp.find(P + "spPr")
            ok, bad = in_order(spPr, SPPR_ORDER)
            if not ok:
                problems.append(f"{n}: spPr order violated at {bad} in '{name}'")
            if not any(ch.tag in FILLS for ch in spPr):
                problems.append(f"{n}: '{name}' has no explicit fill")
            ln = spPr.find(A + "ln")
            if ln is None:
                problems.append(f"{n}: '{name}' has no explicit a:ln")
            else:
                ok, bad = in_order(ln, LN_ORDER)
                if not ok:
                    problems.append(f"{n}: a:ln order violated at {bad} in '{name}'")
                if not any(ch.tag in LN_ORDER[0] for ch in ln):
                    problems.append(f"{n}: a:ln without line fill in '{name}' (Office assumes solidFill)")
                if ln.get("w") == "0" and ln.find(A + "noFill") is None:
                    problems.append(f"{n}: a:ln w=0 draws a hairline in '{name}'")
                if ln.find(A + "noFill") is None and ln.find(A + "miter") is None and ln.find(A + "round") is None and ln.find(A + "bevel") is None:
                    problems.append(f"{n}: a:ln without join in '{name}' (default join is round; CSS corners are mitred)")
            if spPr.find(A + "effectLst") is None and spPr.find(A + "effectDag") is None:
                problems.append(f"{n}: '{name}' has no explicit a:effectLst")
            for sh in spPr.iter(A + "outerShdw"):
                if sh.get("sx", "100000") != "100000" or sh.get("sy", "100000") != "100000":
                    problems.append(f"{n}: outerShdw sx/sy != 100% on spPr is not rendered by Office")
        for amf in root.iter(A + "alphaModFix"):
            if int(amf.get("amt", "100000")) >= 100000:
                problems.append(f"{n}: alphaModFix amt >= 100000 (Office wraps modulo 100%)")
        for blip in root.iter(A + "blip"):
            kids = [c.tag for c in blip]
            if A + "extLst" in kids and kids.index(A + "extLst") != len(kids) - 1:
                problems.append(f"{n}: a:blip extLst not last")
        for tbl in root.iter(A + "tbl"):
            tblPr = tbl.find(A + "tblPr")
            sid = tblPr.find(A + "tableStyleId") if tblPr is not None else None
            if sid is None or sid.text != NO_STYLE_NO_GRID:
                problems.append(f"{n}: table style is {None if sid is None else sid.text} (expected No Style, No Grid)")
            # firstRow marks a header row: "No Style, No Grid" has no firstRow formatting, so with this style the
            # flag adds only the semantics (fixer round 2, judge J2-03); banding/first-column/last-row flags stay out
            for att in ("bandRow", "firstCol", "lastRow", "lastCol", "bandCol") + (
                    () if sid is not None and sid.text == NO_STYLE_NO_GRID else ("firstRow",)):
                if tblPr is not None and tblPr.get(att) in ("1", "true"):
                    problems.append(f"{n}: tblPr@{att} set")
            ncols = len(tbl.find(A + "tblGrid"))
            for tr in tbl.iter(A + "tr"):
                if len(tr.findall(A + "tc")) != ncols:
                    problems.append(f"{n}: a:tr has {len(tr.findall(A + 'tc'))} tc for {ncols} gridCol")
                for tc in tr.findall(A + "tc"):
                    kids = [c.tag for c in tc]
                    if A + "tcPr" in kids and A + "txBody" in kids and kids.index(A + "tcPr") < kids.index(A + "txBody"):
                        problems.append(f"{n}: a:tc tcPr before txBody")
                    tcPr = tc.find(A + "tcPr")
                    if tcPr is not None:
                        ok, bad = in_order(tcPr, TCPR_ORDER)
                        if not ok:
                            problems.append(f"{n}: a:tcPr order violated at {bad}")
                        if tcPr.get("anchor") in ("just", "dist"):
                            problems.append(f"{n}: tcPr anchor {tcPr.get('anchor')} not allowed by Office")
                    for p in tc.iter(A + "p"):
                        if p.find(A + "r") is None and (p.find(A + "endParaRPr") is None or p.find(A + "endParaRPr").get("sz") is None):
                            problems.append(f"{n}: empty cell paragraph without endParaRPr@sz (defaults to 18 pt, grows short rows)")
    return problems


def main(argv=None) -> int:
    pdeathsig.arm()
    ap = argparse.ArgumentParser(description="shape/table structural lint of a built PPTX")
    ap.add_argument("pptx")
    ap.add_argument("--json", help="write {problems: [...]} here")
    a = ap.parse_args(argv)
    try:
        problems = lint(a.pptx)
    except (OSError, zipfile.BadZipFile, etree.XMLSyntaxError) as exc:
        print(f"shape_table_lint: error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    print(f"{len(problems)} problem(s)")
    for p in problems:
        print("  -", p)
    if a.json:
        Path(a.json).write_text(json.dumps({"problems": problems}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
