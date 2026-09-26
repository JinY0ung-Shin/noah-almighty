"""Office-specific chart rules that the ECMA XSD cannot express ([MS-OI29500] implementer notes).

lint_chart_xml(root) -> list of (severity, rule, message). severity "error" = rule stated by
Microsoft as required/refused or with field evidence of repair; "warn" = Office silently ignores.
The `chart-lint` gate of tools/deck.mjs (copied from the PoC's chart lane, scratch/chart/office_chart_lint.py; the
rules are unchanged). Exit 1 on any error; warnings are reported (drift).

Usage: chart_lint.py DECK.pptx [...] [--json OUT.json]
"""

import json
import re
import sys
import zipfile
from pathlib import Path

from lxml import etree

C = "http://schemas.openxmlformats.org/drawingml/2006/chart"
NS = {"c": C, "a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
GROUPS = {"areaChart", "area3DChart", "lineChart", "line3DChart", "stockChart", "radarChart",
          "scatterChart", "pieChart", "pie3DChart", "doughnutChart", "barChart", "bar3DChart",
          "ofPieChart", "surfaceChart", "surface3DChart", "bubbleChart"}
PIE_LIKE = {"pieChart", "pie3DChart", "ofPieChart", "doughnutChart"}
# [MS-OI29500] 2.1.1456 (Part 1 §21.2.2.48 dLblPos), when a c:ser is an ancestor
DLBLPOS = {
    "pieChart": {"bestFit", "outEnd", "inEnd", "ctr"},
    "pie3DChart": {"bestFit", "outEnd", "inEnd", "ctr"},
    "ofPieChart": {"bestFit", "outEnd", "inEnd", "ctr"},
    ("barChart", "clustered"): {"inBase", "inEnd", "outEnd", "ctr"},
    ("barChart", "standard"): {"inBase", "inEnd", "outEnd", "ctr"},  # 2-D standard == clustered
    ("barChart", "stacked"): {"inBase", "inEnd", "ctr"},
    ("barChart", "percentStacked"): {"inBase", "inEnd", "ctr"},
    "lineChart": {"l", "r", "b", "t", "ctr"},
    "scatterChart": {"l", "r", "b", "t", "ctr"},
    "bubbleChart": {"l", "r", "b", "t", "ctr"},
    "stockChart": {"l", "r", "b", "t", "ctr"},
    "areaChart": set(), "area3DChart": set(), "bar3DChart": set(), "doughnutChart": set(),
    "line3DChart": set(), "radarChart": set(),
}


def ln(e):
    return etree.QName(e).localname


def group_of(el):
    while el is not None and ln(el) not in GROUPS:
        el = el.getparent()
    return el


def lint_chart_xml(root):
    out = []

    def add(sev, rule, msg):
        out.append((sev, rule, msg))

    # R1 dLblPos legality (series-level and dLbl-level)
    for pos in root.iter("{%s}dLblPos" % C):
        anc = [ln(a) for a in pos.iterancestors()]
        level = "series" if "ser" in anc else "group"
        # MS-OI29500 says any value is allowed when no c:ser ancestor, BUT field reports show a
        # group-level illegal value breaks Office too (python-pptx #1134: bar 'r' on Office 365
        # web, unrepairable; #272: pie t/b/l/r/inBase corrupt) → enforce the table at every level.
        g = group_of(pos)
        gname = ln(g)
        if gname == "barChart":
            grouping = g.find("c:grouping", NS)
            key = ("barChart", grouping.get("val") if grouping is not None else "clustered")
        else:
            key = gname
        allowed = DLBLPOS.get(key)
        if allowed is not None and pos.get("val") not in allowed:
            add("error", "MS-OI29500 2.1.1456" + ("" if level == "series" else " + python-pptx #1134/#272"),
                f"{level}-level dLblPos={pos.get('val')} not allowed in {key} "
                f"(allowed: {sorted(allowed) or 'none'})")
    # R2 group-level dLbls children (2.1.1457)
    for g in root.iter():
        if not isinstance(g.tag, str) or ln(g) not in GROUPS:
            continue
        gd = g.find("c:dLbls", NS)
        if gd is None:
            continue
        for k in gd:
            name = ln(k)
            if name in ("delete", "dLbl", "leaderLines", "numFmt", "spPr", "txPr"):
                # stated as 'Office does not allow'; python-pptx's documented plot.data_labels API
                # writes numFmt/txPr here with no repair reports found → warn, keep them on c:ser
                add("warn", "MS-OI29500 2.1.1457", f"{ln(g)}/dLbls has <{name}> (only allowed under c:ser)")
            if name == "showLeaderLines" and ln(g) not in PIE_LIKE:
                add("warn", "MS-OI29500 2.1.1457/2.1.1549", f"{ln(g)}/dLbls has showLeaderLines")
    # R3 doughnut holeSize required, 1..90
    for d in root.iter("{%s}doughnutChart" % C):
        hs = d.find("c:holeSize", NS)
        if hs is None or hs.get("val") is None:
            add("error", "MS-OI29500 2.1.1458/2.1.1480", "doughnutChart without holeSize/@val")
        else:
            v = int(re.sub(r"%$", "", hs.get("val")))
            if not 1 <= v <= 90:
                add("error", "MS-OI29500 2.1.1586", f"holeSize {v} outside 1..90")
    # R4/R5 manualLayout
    for ml in root.iter("{%s}manualLayout" % C):
        parent_kinds = [ln(a) for a in ml.iterancestors()]
        have = {ln(k): k for k in ml}
        if "plotArea" in parent_kinds[:2] or "legend" in parent_kinds[:2]:
            present = [k for k in "xywh" if k in have]
            if present and len(present) != 4:
                add("error", "MS-OI29500 2.1.1494", f"manualLayout under {parent_kinds[1]} has only {present}")
        if "layoutTarget" in have and parent_kinds[1] != "plotArea":
            add("error", "MS-OI29500 2.1.1486", f"layoutTarget under {parent_kinds[1]}")
        for k in "xy":
            if k in have:
                mode = have.get(k + "Mode")
                mode = mode.get("val") if mode is not None else "factor"
                v = float(have[k].get("val"))
                lo = 0 if mode == "edge" else -1
                if not lo <= v <= 1:
                    add("warn", "MS-OI29500 2.1.1575/2.1.1577", f"{k}={v} ({mode}) → manualLayout ignored")
                if mode != "edge" and parent_kinds[1] in ("plotArea", "legend"):
                    add("warn", "schema default", f"{parent_kinds[1]} {k}Mode is '{mode}' (offset from default position)")
        for k in "wh":
            if k in have and not 0 <= float(have[k].get("val")) <= 1:
                add("warn", "MS-OI29500 2.1.1573/2.1.1477", f"{k} outside [0,1] → manualLayout ignored")
    # R6 axis ids
    plot = root.find("c:chart/c:plotArea", NS)
    if plot is not None:
        ax_ids = {}
        for ax in plot:
            if ln(ax) in ("catAx", "valAx", "dateAx", "serAx"):
                ax_ids[ax.find("c:axId", NS).get("val")] = ax
        for el in plot.iter("{%s}axId" % C, "{%s}crossAx" % C):
            v = int(el.get("val"))
            if not 0 <= v <= 2147483647:
                add("error", "MS-OI29500 2.1.1432/2.1.1446", f"{ln(el)}={v} outside 0..2147483647")
            if el.get("val") not in ax_ids:
                add("error", "MS-OI29500 2.1.1444/2.1.1570", f"{ln(el)}={v} matches no axis")
        if len(ax_ids) > 4:
            add("error", "MS-OI29500 2.1.1523", "more than 4 axes")
    # R7 idx/order unique per chart
    for tag in ("idx", "order"):
        seen = {}
        for ser in root.iter("{%s}ser" % C):
            e = ser.find("c:" + tag, NS)
            if e is None:
                continue
            if e.get("val") in seen:
                add("error", f"MS-OI29500 {'2.1.1482' if tag == 'idx' else '2.1.1509'}",
                    f"duplicate series {tag}={e.get('val')}")
            seen[e.get("val")] = ser
    # R8 showLeaderLines / showPercent = true outside pie-like groups
    for tag, rule in (("showLeaderLines", "2.1.1549"), ("showPercent", "2.1.1551")):
        for e in root.iter("{%s}%s" % (C, tag)):
            g = group_of(e)
            if g is not None and ln(g) not in PIE_LIKE and e.get("val", "1") in ("1", "true"):
                add("error" if tag == "showPercent" else "warn", f"MS-OI29500 {rule}",
                    f"{tag}=1 in {ln(g)}")
    # R9 stacked bar overlap
    for b in root.iter("{%s}barChart" % C):
        gr = b.find("c:grouping", NS)
        ov = b.find("c:overlap", NS)
        if gr is not None and gr.get("val") in ("stacked", "percentStacked"):
            if ov is None or int(str(ov.get("val", "0")).rstrip("%")) != 100:
                add("warn", "LibreOffice chartexport.cxx", "stacked barChart without overlap 100")
    # R10 pie: only first series displayed
    for p in root.iter("{%s}pieChart" % C):
        if len(p.findall("c:ser", NS)) > 1:
            add("warn", "MS-OI29500 2.1.1519", "pieChart with >1 series (only the first is shown)")
    # R11 txPr: only the first a:p is read
    for t in root.iter("{%s}txPr" % C):
        if len(t.findall("a:p", NS)) > 1:
            add("warn", "MS-OI29500 2.1.1566", "txPr with more than one a:p")
    # R12 booleans without val (readers disagree on defaults)
    for e in root.iter():
        if isinstance(e.tag, str) and e.tag.startswith("{%s}" % C) and ln(e) in (
                "varyColors", "smooth", "marker", "autoTitleDeleted", "roundedCorners",
                "invertIfNegative", "showVal", "delete", "plotVisOnly") and len(e) == 0 \
                and e.get("val") is None and ln(e) != "marker":
            add("warn", "explicit booleans", f"<c:{ln(e)}/> without val")
    return out


def main(paths, json_out=None):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import pdeathsig  # tools/pdeathsig.py: die with the parent (deck.mjs)
    pdeathsig.arm()
    bad = 0
    report = []
    for p in paths:
        z = zipfile.ZipFile(p)
        for n in sorted(z.namelist()):
            if re.match(r"ppt/charts/chart\d+\.xml$", n):
                res = lint_chart_xml(etree.fromstring(z.read(n)))
                errs = [r for r in res if r[0] == "error"]
                bad += len(errs)
                print(f"{p}:{n}: {len(errs)} errors, {len(res) - len(errs)} warnings")
                report.append({"part": n, "errors": len(errs), "warnings": len(res) - len(errs),
                               "items": [{"severity": sev, "rule": rule, "message": msg} for sev, rule, msg in res]})
                for sev, rule, msg in res:
                    print(f"   {sev:5} [{rule}] {msg}")
    if json_out:
        Path(json_out).write_text(json.dumps({"charts": report}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return 1 if bad else 0


if __name__ == "__main__":
    argv = sys.argv[1:]
    out = None
    if "--json" in argv:
        i = argv.index("--json")
        out = argv[i + 1] if i + 1 < len(argv) else None
        argv = argv[:i] + argv[i + 2:]
    sys.exit(main(argv, out))
