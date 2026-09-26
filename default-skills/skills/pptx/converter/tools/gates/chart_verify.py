"""The `chart-verify` gate: a PPTX's charts — XSD validity, python-pptx reopen, embedded xlsx (openpyxl) vs caches.

Ported from the PoC's chart lane (scratch/chart/verify_deck.py); the checks are unchanged, the ECMA-376
transitional XSDs live next to this file (xsd/, see xsd/NOTICE.md).

Usage: chart_verify.py DECK.pptx [--json OUT.json]
Exit code 1 if any check fails.
"""

import argparse
import io
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path

import openpyxl
from lxml import etree
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

XSD_DIR = str(Path(__file__).resolve().parent / "xsd")
NS = {"c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
      "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006"}

schema = etree.XMLSchema(etree.parse(f"{XSD_DIR}/dml-chart.xsd"))
fails = []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)


def mce_fallback(root):
    """Apply MCE like a non-c14 consumer: replace mc:AlternateContent by its Fallback content."""
    for ac in root.findall(".//mc:AlternateContent", NS):
        fb = ac.find("mc:Fallback", NS)
        parent = ac.getparent()
        idx = parent.index(ac)
        parent.remove(ac)
        if fb is not None:
            for k in reversed(list(fb)):
                parent.insert(idx, k)
    return root


def ref_cells(ws, ref):
    m = re.fullmatch(r"(?:'?([^'!]+)'?!)?\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?", ref)
    c1, r1, c2, r2 = m.group(2), int(m.group(3)), m.group(4) or m.group(2), int(m.group(5) or m.group(3))
    out = []
    for row in ws[f"{c1}{r1}:{c2}{r2}"]:
        for cell in row:
            out.append(cell.value)
    return out


def iter_shapes(shapes):
    """Every shape, descending into groups (a chart grouped with its card must still be checked)."""
    for shp in shapes:
        yield shp
        if shp.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from iter_shapes(shp.shapes)


def verify(path):
    z = zipfile.ZipFile(path)
    ct = etree.fromstring(z.read("[Content_Types].xml"))
    overrides = {o.get("PartName"): o.get("ContentType") for o in ct}
    defaults = {d.get("Extension"): d.get("ContentType") for d in ct if d.get("Extension")}
    prs = Presentation(path)
    n = 0
    # every chart part a slide references must be reached by the shape walk below (a group the walk did not enter
    # would otherwise pass as "0 charts checked")
    referenced = set()
    for slide in prs.slides:
        for rel in slide.part.rels.values():
            if rel.reltype.endswith("/chart"):
                referenced.add(str(rel.target_part.partname))
    seen = set()
    for si, slide in enumerate(prs.slides, 1):
        for shp in iter_shapes(slide.shapes):
            if not getattr(shp, "has_chart", False) or not shp.has_chart:
                continue
            seen.add(str(shp.chart.part.partname))
            n += 1
            chart = shp.chart
            part = chart.part
            pname = str(part.partname)
            print(f"slide {si}: {pname} type={chart.chart_type} series={[s.name for s in chart.plots[0].series]}")
            xml = etree.fromstring(z.read(pname.lstrip("/")))
            check(overrides.get(pname) == "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
                  f"content type of {pname}")
            v = etree.fromstring(etree.tostring(xml))
            ok = schema.validate(mce_fallback(v))
            check(ok, f"XSD-valid {pname}" + ("" if ok else f": {schema.error_log.last_error}"))
            # external data → embedded package
            ed = xml.find("c:externalData", NS)
            check(ed is not None and ed.find("c:autoUpdate", NS) is not None, "c:externalData + c:autoUpdate present")
            rid = ed.get("{%s}id" % NS["r"])
            rels = etree.fromstring(z.read(posixpath.join(posixpath.dirname(pname.lstrip('/')), "_rels",
                                                          posixpath.basename(pname) + ".rels")))
            rel = next(r for r in rels if r.get("Id") == rid)
            check(rel.get("Type").endswith("/package"), f"externalData rel type = package ({rel.get('Type')})")
            target = posixpath.normpath(posixpath.join(posixpath.dirname(pname), rel.get("Target")))
            ext = target.rsplit(".", 1)[-1]
            ctype = overrides.get(target) or defaults.get(ext)
            check(ctype == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                  f"embedded workbook {target} content type {ctype}")
            blob = z.read(target.lstrip("/"))
            wb = openpyxl.load_workbook(io.BytesIO(blob))
            ws = wb[wb.sheetnames[0]]
            print(f"  workbook sheets={wb.sheetnames} dims={ws.dimensions}")
            for r in ws.iter_rows(values_only=True):
                print("   ", r)
            # every c:f must resolve to the same values as the cache
            for f in xml.iter("{%s}f" % NS["c"]):
                cache = f.getnext()
                cells = ref_cells(ws, f.text)
                pts = {}
                ptc = None
                if cache is not None:
                    ptc_el = cache.find("c:ptCount", NS)
                    ptc = int(ptc_el.get("val")) if ptc_el is not None else None
                    for pt in cache.findall("c:pt", NS):
                        pts[int(pt.get("idx"))] = pt.find("c:v", NS).text
                same = True
                for i, cv in enumerate(cells):
                    pv = pts.get(i)
                    if cv is None and pv is None:
                        continue
                    if pv is None or cv is None:
                        same = False
                        break
                    try:
                        same &= abs(float(pv) - float(cv)) < 1e-9
                    except ValueError:
                        same &= str(pv) == str(cv)
                check(same and (ptc is None or ptc == len(cells)), f"{f.text} == cache ({len(cells)} pts)")
            # python-pptx reopen of values
            for s in chart.plots[0].series:
                print(f"  reopened {s.name!r}: {list(s.values)}")
            print("  categories:", list(chart.plots[0].categories))
    check(seen == referenced, f"every referenced chart part checked ({len(seen)}/{len(referenced)})")
    print(f"{n} charts checked, {len(fails)} failures")
    return n, list(fails)


def main(argv=None) -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import pdeathsig  # tools/pdeathsig.py: die with the parent (deck.mjs)
    pdeathsig.arm()
    ap = argparse.ArgumentParser(description="chart XSD / workbook / cache verification of a PPTX")
    ap.add_argument("pptx")
    ap.add_argument("--json", help="write {charts, failures} here")
    a = ap.parse_args(argv)
    n, failures = verify(a.pptx)
    if a.json:
        Path(a.json).write_text(json.dumps({"charts": n, "failures": failures}, ensure_ascii=False, indent=1) + "\n",
                                encoding="utf-8")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
