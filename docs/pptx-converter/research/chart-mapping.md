# ChartSpec → native, editable PowerPoint chart (python-pptx 1.0.2)

> **Historical PoC evidence, preserved for maintainers — not agent-facing.** Written in the HTML→PPTX
> proof of concept before its port into Noah (2026-09) and copied here unchanged below this note. Paths such
> as `scratch/…`, `tools/…`, `out/…`, `fonts/…`, `theme/…`, `slides/…`, `docs/…` and `$POC` refer to that PoC
> tree, and machine paths (`/home/jinyoung/…`, `/mnt/c/Windows/Fonts`) to its dev box — Windows fonts were
> only ever READ in place there, never copied. The shipped converter is `default-skills/skills/pptx/converter/`;
> see [`docs/architecture/pptx-converter.md`](../../architecture/pptx-converter.md) and
> [the index of this directory](../README.md).

Status: **complete** (2026-09-25). Owner: chart-mapping lane. Everything below marked [LOCAL] was
executed; everything about PowerPoint itself comes from primary sources or PowerPoint-written XML and
is labelled so. Nobody could run PowerPoint — §15 lists what only PowerPoint can confirm.

Evidence labels:
- **[SPEC]** ECMA-376 5th ed. Part 1 text / Transitional XSD `dml-chart.xsd`; [MS-OI29500] implementer notes.
- **[PPT-XML]** observed in chart parts that Windows PowerPoint wrote (`docProps/app.xml` = "Microsoft
  Office PowerPoint", AppVersion 16.0000 = 2016/2019/2021/Microsoft 365, 15.0000 = 2013). Corpus: 44 classic chart
  parts (37 × PowerPoint 16, 7 × 2013; plus 2 chartEx parts) from 35 decks in LibreOffice/POI/python-pptx test data (`scratch/chart/corpus/scan.py` →
  `scan.json`; full samples in `scratch/chart/corpus/ppt16/`).
- **[GEN]** what an interoperating generator/reader does (LibreOffice `oox`, PptxGenJS, python-pptx source).
- **[FIELD]** public bug reports against real PowerPoint.
- **[LOCAL]** executed here. LibreOffice 7.4.7.2 renders (`pptx-poc-lo`) are evidence about LibreOffice
  (= Noah's preview), NOT proof of PowerPoint behavior.

## 0. Files (all under `scratch/chart/`)

| file | what |
|---|---|
| `chart_native.py` | **the implementation**: `add_native_chart(slide, spec, box_px, face_for_weight, plot_px=…, value_range=…, major_unit=…)` — python-pptx + schema-ordered lxml post-processing. Liftable into `tools/build_pptx.py`. |
| `office_chart_lint.py` | Office rules the XSD cannot express ([MS-OI29500] + field reports). Build gate: exit 1 on any error. |
| `verify_deck.py` | XSD validation of every chart part (Transitional `dml-chart.xsd`), python-pptx reopen, embedded xlsx opened with openpyxl and every `c:f` cross-checked against the cached points. |
| `make_sample_deck.py` → `out/chart-samples.pptx` | 7 charts: clustered column, stacked column, horizontal bar with point colors, line with markers, pie, doughnut, stacked horizontal bar with visible value axis. |
| `experiments.py` → `out/experiments.pptx` | firstSliceAng direction; `layoutTarget` inner vs outer. |
| `make_negative_controls.py` → `out/negative-controls.pptx` | plain python-pptx usage with known-bad label positions (proves the checks bite). |
| `out/lo/page-N.png`, `out/lo-exp/page-N.png` | LibreOffice 7.4 renders (96 dpi → 1 px = 1 CSS px). |
| `sources/` | every fetched primary source (MS-OI29500 chart notes `ms-oi29500-chart-clean.txt`, ECMA-376 XSD + Part 1 text, LibreOffice/PptxGenJS sources at pinned SHAs). |

## 1. TL;DR rules for the builder

1. Create the chart with `slide.shapes.add_chart(xl_type, x, y, cx, cy, CategoryChartData)` — python-pptx
   writes the chart part, the embedded xlsx, `c:externalData`+`c:autoUpdate val=0`, rels and content types,
   i.e. everything Edit Data needs [LOCAL: workbook embedded, rel + content type correct, every `c:f` matches
   the sheet; the Edit Data click itself is on the PowerPoint checklist §16]. Then post-process `chart._chartSpace` with lxml. Every element python-pptx
   does not manage is inserted **in schema order** (`put()` in `chart_native.py`, sequences in §13.3), and
   every boolean gets an **explicit `val`** (the schema default of `CT_Boolean` is `true`; LibreOffice's
   defaults for a missing `val` depend on the app version in `docProps/app.xml`).
2. **Never emit an illegal `c:dLblPos`** for the chart type — at any level (group, series, point). Table in §8.
   This is the rule with the strongest evidence of "PowerPoint repairs/refuses the file".
3. Pin the plot area: `c:plotArea/c:layout/c:manualLayout` = `layoutTarget inner`, `xMode edge`, `yMode edge`,
   `x,y,w,h` = plot rectangle ÷ chart-frame size (all four, each in [0,1]). This is exactly the element form
   PowerPoint itself writes (§3). With `inner`, the rectangle is exactly where bars/lines/pie are drawn.
4. Never let PowerPoint auto-choose what the HTML must match: explicit axis `c:min`/`c:max`, `c:majorUnit`
   when gridlines show, `c:gapWidth`, `c:overlap` (100 for stacked), `c:holeSize`, `c:firstSliceAng`,
   `c:crossBetween val="between"`, `c:tickLblSkip val="1"`, label `rot="0"`.
5. No title: `chart.has_title = False` (→ `c:autoTitleDeleted val="1"`, no `c:title`).
6. Fonts: explicit `a:latin` + `a:ea` + `a:cs` = profile typeface in `c:txPr/a:p/a:pPr/a:defRPr` at the chart
   space AND on every text-bearing element (both axes, each series' `c:dLbls`, legend); `c:lang val="ko-KR"`
   and `a:endParaRPr lang="ko-KR"`. Hangul uses the `ea` slot.
7. Group-level `c:dLbls` (child of `c:barChart` …) carries ONLY `show*` flags (all 0); `numFmt`, `spPr`,
   `txPr`, `dLblPos`, `showVal=1` go on each **series** `c:ser/c:dLbls`. `showLeaderLines val="0"` outside pies.
8. Transparent: chart-space and plot-area `c:spPr` = `a:noFill` + `a:ln/a:noFill` + `a:effectLst`;
   `c:roundedCorners val="0"`.
9. No `mc:AlternateContent`/`c14:style`, no chartStyle/chartColorStyle parts (§12).
10. Sanitize input: categories → `str`, strip XML-1.0-illegal characters, values → finite float or `None`.
11. Gate every build: XSD-valid chart XML (`verify_deck.py`) + `office_chart_lint.py` with 0 errors.
12. **Contract addition needed** (orchestrator): the chart element in the IR must carry the plot rectangle and
    the resolved value scale that `lib/chart.js` used (§3.4). Without it the native plot area cannot match.

## 2. ChartSpec → python-pptx / XML mapping

| ChartSpec | python-pptx API (1.0.2) | XML written (post-processing) | notes / source |
|---|---|---|---|
| `type`+`grouping` | `XL_CHART_TYPE.COLUMN_CLUSTERED/COLUMN_STACKED/BAR_CLUSTERED/BAR_STACKED/LINE_MARKERS/PIE/DOUGHNUT` | — | `bar` = horizontal (`c:barDir val="bar"`) |
| `categories` | `CategoryChartData.categories` (as `str`) | `c:cat/c:strRef` (+ `Sheet1!$A$2:$A$n`) | int categories become `c:numRef` [LOCAL] |
| `series[].name/values` | `cd.add_series(name, values, number_format=nf)` | `c:tx/c:strRef`, `c:val/c:numRef`; `None` → no `c:pt` (gap) | NaN/inf raise in XlsxWriter [LOCAL] |
| `series[].color` | — (`format.fill` works, but spPr order/ln is set explicitly) | bar/pie: `c:ser/c:spPr` solidFill + `a:ln/a:noFill`; line: `a:ln w cap="rnd"` solidFill + marker `c:spPr` | [SPEC] MS-OI29500 2.1.1555: Office drops `*Fill` on a line `ser` |
| `pointColors{"i":[…]}` | (`series.points[i].format.fill` possible) | `c:dPt(idx, invertIfNegative 0 [bar], bubble3D 0, spPr)` in idx order | [PPT-XML] pie/doughnut `dPt` form |
| `dataLabels.show` | — | series `c:dLbls`: `showVal 1`, other show* 0, `showLeaderLines 0`; group `c:dLbls` all 0 | §8 |
| `dataLabels.numberFormat` | (`series.data_labels.number_format` exists) | series `c:dLbls/c:numFmt formatCode=… sourceLinked="0"`; also the workbook/numCache format | sourceLinked 0 → Edit Data cannot change it |
| `dataLabels.position` | — | series `c:dLbls/c:dLblPos` via `resolve_dlbl_pos()` (omitted when illegal) | §8 table |
| `dataLabels.color/sizePx/cssWeight` | — | series `c:dLbls/c:txPr` `defRPr sz=round(px·75) b=face.bold` + solidFill + latin/ea/cs | face = fonts.json nearest-weight rule |
| `valueAxis.visible` | `value_axis.tick_label_position = NEXT_TO_AXIS / NONE` | `c:tickLblPos`; `c:delete` stays 0 (scale + editability kept) | PowerPoint's own hidden axis uses `c:delete val=1` [PPT-XML]; both open |
| `valueAxis.min/max` | `value_axis.minimum_scale / maximum_scale` | `c:scaling/c:orientation minMax, c:max, c:min` | always explicit (resolved by lib/chart.js if null) |
| `valueAxis.numberFormat` | `value_axis.tick_labels.number_format`, `…number_format_is_linked = False` | `c:numFmt sourceLinked="0"` | |
| `valueAxis.gridlines` | `value_axis.has_major_gridlines = True/False` | `c:majorGridlines/c:spPr/a:ln w=round(px·9525) cap="flat"` solidFill | + `value_axis.major_unit` |
| (no axis line) | — | valAx `c:spPr` `a:noFill` + `a:ln/a:noFill` | [PPT-XML] |
| `categoryAxis.visible` | `category_axis.tick_label_position` | `c:tickLblPos nextTo/none` | |
| `categoryAxis.labelColor/sizePx` | — | catAx `c:txPr` (`rot="0"`) | value-axis labels reuse these (ChartSpec has no valueAxis label style) |
| `categoryAxis.lineColor` | — | catAx `c:spPr/a:ln w="9525"` solidFill (1 px) | |
| (no tick marks) | `major_tick_mark = minor_tick_mark = XL_TICK_MARK.NONE` (both axes) | `c:majorTickMark/minorTickMark val="none"` | [PPT-XML] PowerPoint 16 default |
| `legend.position` | `chart.has_legend`, `chart.legend.position` (TOP/BOTTOM/RIGHT), `legend.include_in_layout = False` | `c:legend(legendPos, overlay 0, spPr noFill, txPr)`; `none` → no `c:legend` | legend placement inside the frame is PowerPoint-internal (§15) |
| `legend.color/sizePx` | — | `c:legend/c:txPr` | |
| `gapWidth` / `overlap` | `plot.gap_width` / `plot.overlap` | `c:gapWidth`, `c:overlap` (forced 100 if stacked) | 0..500 / −100..100 [SPEC XSD] |
| `holeSize` | none | `c:doughnutChart/c:holeSize val` (1..90, **required**) | python-pptx writes 50 by default |
| `firstSliceAng` (not in CONTRACT; proposed optional, default 0) | none | `c:firstSliceAng val` (0..360, clockwise from 12 o'clock) | python-pptx pie template lacks it |
| `fontCssWeight` | (`chart.font` would only set `a:latin`) | chart-space `c:txPr` + axis/legend `c:txPr` face | python-pptx has no `a:ea` API |
| (builder defaults, not in ChartSpec) | `series.marker.style = CIRCLE`, `.size`, `series.smooth = False` | line `a:ln w="28575"` (3 px = 2.25 pt = PowerPoint's default [PPT-XML]), marker `c:size` = round(px·0.75) pt (2..72) | propose optional `lineWidthPx`, `markerSizePx`; lib/chart.js must use the same defaults |

### 2.1 Core code (excerpt of `scratch/chart/chart_native.py`, tested)

```python
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION, XL_MARKER_STYLE, XL_TICK_LABEL_POSITION, XL_TICK_MARK
from pptx.util import Emu

cd = CategoryChartData(number_format=num_fmt)            # num_fmt = dataLabels.numberFormat or valueAxis.numberFormat or "General"
cd.categories = [clean_text(c) for c in spec["categories"]]
for s in (spec["series"][:1] if spec["type"] == "pie" else spec["series"]):   # Office shows only a pie's 1st series
    cd.add_series(clean_text(s["name"]), [clean_number(v) for v in s["values"]], number_format=num_fmt)
gf = slide.shapes.add_chart(xl_type, Emu(round(box["x"]*9525)), Emu(round(box["y"]*9525)),
                            Emu(round(box["w"]*9525)), Emu(round(box["h"]*9525)), cd)
chart = gf.chart; cs = chart._chartSpace                 # lxml c:chartSpace

put(cs, val_el("c:lang", "ko-KR")); put(cs, val_el("c:roundedCorners", "0"))
put(cs, sp_pr()); put(cs, tx_pr(size_px, color, base_face))          # transparent frame + base text
chart.has_title = False                                   # c:autoTitleDeleted val="1"
put(plotArea, manual_layout_inner(plot_px, box))          # §3
put(plotArea, sp_pr())
put(grp, val_el("c:varyColors", "1" if pie_like else "0"))
plot = chart.plots[0]
plot.gap_width = spec.get("gapWidth", 150); plot.overlap = 100 if stacked else spec.get("overlap", 0)
# per series: spPr, dPt, series-level dLbls (numFmt, spPr, txPr, dLblPos, show*), markers, smooth
# axes: reverse_order for 'bar', tick marks NONE, tick_label_position, number_format(+is_linked False),
#       minimum_scale/maximum_scale/major_unit, has_major_gridlines + gridline spPr, txPr, tickLblSkip 1
# legend: has_legend / legend.position / include_in_layout False / txPr
put(c_chart, val_el("c:plotVisOnly", "1")); put(c_chart, val_el("c:dispBlanksAs", "gap"))
put(c_chart, val_el("c:showDLblsOverMax", "0")); positive_axis_ids(plotArea)
```

`put(parent, child)` removes any same-named child and inserts `child` before the first sibling whose schema
slot is later (sequences in §13.3). This is what keeps hand-written elements from creating order errors.

### 2.2 Resulting XML (from `out/chart-samples.pptx`, chart 2, caches trimmed)

```xml
<c:chartSpace xmlns:c="…/drawingml/2006/chart" xmlns:a="…/drawingml/2006/main" xmlns:r="…/relationships">
  <c:date1904 val="0"/>
  <c:lang val="ko-KR"/>
  <c:roundedCorners val="0"/>
  <c:chart>
    <c:autoTitleDeleted val="1"/>
    <c:plotArea>
      <c:layout><c:manualLayout>
        <c:layoutTarget val="inner"/><c:xMode val="edge"/><c:yMode val="edge"/>
        <c:x val="0.071429"/><c:y val="0.111111"/><c:w val="0.875"/><c:h val="0.740741"/>
      </c:manualLayout></c:layout>
      <c:barChart>
        <c:barDir val="col"/><c:grouping val="stacked"/><c:varyColors val="0"/>
        <c:ser>
          <c:idx val="0"/><c:order val="0"/>
          <c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache>…</c:strCache></c:strRef></c:tx>
          <c:spPr><a:solidFill><a:srgbClr val="1D4ED8"/></a:solidFill><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>
          <c:invertIfNegative val="0"/>
          <c:dLbls>
            <c:numFmt formatCode="0" sourceLinked="0"/>
            <c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>
            <c:txPr>
              <a:bodyPr rot="0" spcFirstLastPara="1" vertOverflow="ellipsis" vert="horz" wrap="none" anchor="ctr" anchorCtr="1"/>
              <a:lstStyle/>
              <a:p><a:pPr><a:defRPr sz="900" b="1" i="0" u="none" strike="noStrike" kern="1200" baseline="0">
                <a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>
                <a:latin typeface="NanumGothic"/><a:ea typeface="NanumGothic"/><a:cs typeface="NanumGothic"/>
              </a:defRPr></a:pPr><a:endParaRPr lang="ko-KR"/></a:p>
            </c:txPr>
            <c:dLblPos val="inEnd"/>   <!-- spec asked outEnd: illegal for stacked → inEnd -->
            <c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/>
            <c:showPercent val="0"/><c:showBubbleSize val="0"/><c:showLeaderLines val="0"/>
          </c:dLbls>
          <c:cat><c:strRef><c:f>Sheet1!$A$2:$A$6</c:f>…</c:strRef></c:cat>
          <c:val><c:numRef><c:f>Sheet1!$B$2:$B$6</c:f>…</c:numRef></c:val>
        </c:ser>
        …
        <c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/>
          <c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>
        <c:gapWidth val="60"/><c:overlap val="100"/>
        <c:axId val="100000001"/><c:axId val="100000002"/>
      </c:barChart>
      <c:catAx>
        <c:axId val="100000001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>
        <c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/>
        <c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>
        <c:spPr><a:noFill/><a:ln w="9525"><a:solidFill><a:srgbClr val="94A3B8"/></a:solidFill><a:round/></a:ln><a:effectLst/></c:spPr>
        <c:txPr>… sz="1050" … latin/ea/cs …</c:txPr>
        <c:crossAx val="100000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/>
        <c:lblOffset val="100"/><c:tickLblSkip val="1"/><c:tickMarkSkip val="1"/><c:noMultiLvlLbl val="0"/>
      </c:catAx>
      <c:valAx>
        <c:axId val="100000002"/>
        <c:scaling><c:orientation val="minMax"/><c:max val="100.0"/><c:min val="0.0"/></c:scaling>
        <c:delete val="0"/><c:axPos val="l"/>
        <c:majorGridlines><c:spPr><a:ln w="9525" cap="flat"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill><a:round/></a:ln><a:effectLst/></c:spPr></c:majorGridlines>
        <c:numFmt formatCode="#,##0&quot;건&quot;" sourceLinked="0"/>
        <c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>
        <c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>
        <c:txPr>…</c:txPr>
        <c:crossAx val="100000001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/><c:majorUnit val="25.0"/>
      </c:valAx>
      <c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>
    </c:plotArea>
    <c:legend><c:legendPos val="b"/><c:overlay val="0"/><c:spPr>…noFill…</c:spPr><c:txPr>…</c:txPr></c:legend>
    <c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/>
  </c:chart>
  <c:spPr><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></c:spPr>
  <c:txPr>… base size/color, latin/ea/cs = profile typeface, endParaRPr lang="ko-KR" …</c:txPr>
  <c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData>
</c:chartSpace>
```

## 3. Chart frame vs plot area, c:layout / c:manualLayout

### 3.1 Semantics
- The chart space fills the `p:graphicFrame` (`p:xfrm` off/ext = the IR `box`). `c:manualLayout` values are
  "a fraction of the width [height] of the chart" [SPEC ECMA-376-1 §21.2.2.232 x, §21.2.2.229 w, §21.2.2.235 y].
- `xMode`/`yMode`: `edge` = x/y is the absolute left/top; `factor` = offset from the element's default position
  [SPEC §21.2.2.232, §21.2.3.20]. **The schema default is `factor`** (`CT_LayoutMode val default="factor"`),
  so `xMode`/`yMode` MUST be written as `edge`. `wMode`/`hMode`: `factor` (default) = w/h are width/height;
  `edge` = right/bottom [SPEC §21.2.3.20].
- `layoutTarget`: `inner` = "the plot area size shall determine the size of the plot area, not including the
  tick marks and axis labels"; `outer` (schema default) includes them [SPEC §21.2.3.21, §21.2.2.89]. **Use
  inner**: the rectangle is then exactly the region the bars/lines/gridlines occupy, independent of label metrics.
- Office rules [SPEC MS-OI29500]: under `plotArea`/`legend` all of x,y,w,h are required if one is (2.1.1494);
  a value outside [0,1] (edge) makes Office ignore the whole `manualLayout` (2.1.1573, 2.1.1575, 2.1.1577,
  2.1.1477); an in-range rectangle that would leave the chart is moved inside (2.1.1575 b); `layoutTarget`
  only under `plotArea` (2.1.1486); Office saves only `xMode/yMode=edge`, `wMode/hMode=factor`
  (2.1.1576/2.1.1578/2.1.1574/2.1.1479) — the exact form we write. Data-label layouts are different (offsets).
- [PPT-XML] every PowerPoint 16 plot-area manual layout in the corpus is
  `layoutTarget inner, xMode edge, yMode edge, x, y, w, h` (`corpus/ppt16/tdf116163-col-manualLayout.xml`);
  PptxGenJS writes the same (`gen-charts.ts` makeXmlCharts).
- [GEN] LibreOffice import: rectangle = chart size × fraction (`converterbase.cxx`
  `LayoutConverter::calcAbsRectangle`); `inner` → `setDiagramPositionExcludingAxes`, `outer` → `…IncludingAxes`;
  "for pie charts, always set inner plot area size to exclude the data labels as Excel does"
  (`plotareaconverter.cxx` l.637).

### 3.2 Verified in LibreOffice [LOCAL]
Chart box (80,110,1120×540), plot rect (80,60,980×400) → fractions 0.071429/0.111111/0.875/0.740741:
gridlines/axis span x 160–1140, y 169/170–569/570 in the 96-dpi render, i.e. exactly the requested slide
rectangle. Same rectangle with `outer`: bar region shrinks to y 181–543 (labels moved inside) → confirms
`inner` is the right target (`experiments.py`).

### 3.3 Geometry the HTML preview (`lib/chart.js`) must reproduce inside the plot rect P
Derived from the spec definitions (gap = % of bar width between clusters, overlap = % of bar width
[SPEC §21.2.2.75, §21.2.2.131, MS-OI29500 2.1.1475/2.1.1512]) and checked against the LibreOffice render:

- Value scale: `y = P.y + P.h·(max − v)/(max − min)` (columns/lines); horizontal bars `x = P.x + P.w·(v − min)/(max − min)`.
- Category band `B = P.w / nCats` (columns, left→right) or `P.h / nCats` (bars, **top→bottom** because the
  builder sets `reverse_order` + value axis `c:crosses val="max"`).
- Clustered: bar thickness `w = B / (N − (N−1)·O/100 + G/100)`; series i starts at
  `bandStart + (G/100)·w/2 + i·w·(1 − O/100)`. Stacked: `w = B / (1 + G/100)`, starts at `bandStart + (G/100)·w/2`.
  [LOCAL] N=2, G=80, O=−10, B=245 → predicted w=84.48, bars 193.8–278.3 / 286.7–371.2 …; LibreOffice drew
  194–277 / 287–370, 439–522 / 532–615, 684–767, 929–1012 / 1022–1105 (≤1 px). Heights exact (value 120 of
  0..300 → top y 410).
- Line points at band centres `x_i = P.x + (i + 0.5)·B` (`crossBetween between`) [LOCAL: x≈241 = 160+81.7].
  Missing value = gap (`dispBlanksAs gap`) [LOCAL].
- Pie: circle inscribed in P (give a square P), centre = centre of P; first slice starts `firstSliceAng`°
  clockwise from 12 o'clock and slices run clockwise in category order [SPEC §21.2.2.68; LOCAL: with 90° the
  first 25 % slice sits at 135°]. Doughnut inner radius = `holeSize`% of the outer radius ("% of the size of
  the plot area" [SPEC §21.2.2.82]) — **LibreOffice ignores holeSize** (always 50 %, see §15).
- Gridlines at `min + k·majorUnit`.

### 3.4 Contract addition required (for the orchestrator)
ChartSpec has no plot rectangle and allows null min/max, so the builder cannot know where `lib/chart.js` drew
the plot. Proposal: `lib/chart.js` writes the geometry it actually used on the chart element, e.g.
`data-chart-resolved='{"plotPx":{"x":…,"y":…,"w":…,"h":…},"valueMin":…,"valueMax":…,"majorUnit":…}'`
(px relative to the element's border box), and the extractor copies it into the IR chart element as
`resolved`. The builder passes `plot_px`, `value_range`, `major_unit` to `add_native_chart`. Without it the
builder must fall back to PowerPoint's automatic layout, which will not match the preview.

## 4. Fonts: latin + ea typeface, c:txPr at chart level and per element, c:lang

- [PPT-XML] PowerPoint writes element-level `c:txPr` on axes and on series data labels with
  `<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>` (theme minor font) and a
  chart-space `c:txPr`; `c:lang` on 44/44 charts (en-US, hu-HU, pl-PL, …).
- Hangul is rendered with the `a:ea` typeface. With `+mn-ea` and the default Office theme minor font
  (`<a:ea typeface=""/>` + `<a:font script="Hang" typeface="맑은 고딕"/>`, e.g. the theme embedded in
  PptxGenJS `gen-charts.ts`) Hangul labels would resolve to 맑은 고딕 → write the profile typeface explicitly
  into `a:latin`, `a:ea` and `a:cs` on the chart space and on each axis / series `c:dLbls` / legend `c:txPr`.
  Weight: fonts.json rule (nearest `cssWeight`, tie → heavier) → `typeface` + `b="1"` iff `face.bold`.
- `sz = round(px × 75)` (e.g. 13 px → 975). [SPEC MS-OI29500 2.1.1566] only the first `a:p` of a `c:txPr` is read.
- Axis/label `a:bodyPr rot="0"` (horizontal). PowerPoint's own files carry `rot="-60000000"` [PPT-XML], an
  out-of-range sentinel (automatic); LibreOffice maps anything outside ±90° to 0 (`objectformatter.cxx`
  `convertTextRotation`). Writing 0 prevents automatic 45° rotation of long Hangul labels.
- `c:lang val="ko-KR"` = "primary editing language" [SPEC §21.2.2.87] — harmless metadata for Korean users.
- LibreOffice preview quirk [LOCAL]: LO inserts visible spacing between Latin digits and Hangul in chart text
  ("1 분기", "100 건"). DrawingML paragraph properties have no autospace attribute (only `eaLnBrk`,
  `latinLnBrk`, `hangingPunct`), so nothing in the file can switch it off; PowerPoint is not expected to add it
  (unverified). Preview-only; the text lane will likely see the same in slide text.
- **Embedded-font risk** — see §15 R1.

## 5. Column / bar

- `XL_CHART_TYPE.COLUMN_*` → `c:barDir val="col"`, `BAR_*` → `"bar"`. For `bar`, `category_axis.reverse_order
  = True` (first category on top, like HTML) and value axis `c:crosses val="max"` so the value axis stays at
  the bottom [SPEC §21.2.2.33, ST_Crosses; MS-OI29500 2.1.1433: Office positions axes by `crosses` +
  `orientation`, ignoring `axPos`] [LOCAL: labels at the bottom, first category on top].
- [PPT-XML] clustered default `gapWidth 219`, `overlap -27`; stacked `overlap 100`; `varyColors val="0"`;
  series `spPr` solidFill + `a:ln/a:noFill`; `invertIfNegative val="0"`.
- Stacked MUST have `overlap 100`: [GEN] LibreOffice exporter "Export the Overlap value with 100% for stacked
  charts … unlike the MS Office, which is interpreted differently" (`chartexport.cxx` l.3471); python-pptx
  writes 100 for its stacked types.
- Ranges [SPEC XSD]: gapWidth 0..500 (default 150 %), overlap −100..100 (default 0 %).

## 6. Line

- `XL_CHART_TYPE.LINE_MARKERS`; per series `c:spPr` = `a:ln w="28575" cap="rnd"` + solidFill + `a:round`
  (no fill element), `series.marker.style = XL_MARKER_STYLE.CIRCLE`, `series.marker.size` (pt, 2..72) +
  marker `c:spPr` fill/line = series color, `series.smooth = False`; group `c:marker val=1`, `c:smooth val=0`.
- [SPEC MS-OI29500 2.1.1495] group `c:marker` is ignored by Office (markers come from per-series `c:marker`);
  2.1.1555 Office does not persist `*Fill` on a line `ser`.
- [GEN] PptxGenJS: marker symbols `plus`/`star`/`x` unsupported by PowerPoint 2013/Online (`gen-objects.ts` l.251).

## 7. Pie / doughnut

- Doughnut **requires** `c:holeSize` with `val` [SPEC MS-OI29500 2.1.1458, 2.1.1480]; Office range 1..90
  (2.1.1586; the Transitional XSD is also 1..90). `firstSliceAng` 0..360 [SPEC §21.2.3.15].
- Office shows only the first series of a pie (2.1.1519) → the builder passes only `series[0]`.
- `varyColors val="1"` + one `c:dPt(idx, bubble3D 0, spPr)` per slice (explicit colors win; `varyColors` is
  ignored with several series, 2.1.1571). [PPT-XML] same form.
- Plot rect = the pie's bounding square (§3.3). Labels: pie `bestFit/outEnd/inEnd/ctr`; doughnut: no
  `dLblPos` at all (labels sit centred on the ring = Office default `ctr`).

## 8. Data labels (and which positions make PowerPoint refuse the file)

Allowed `c:dLblPos` [SPEC MS-OI29500 2.1.1456, §21.2.2.48]:

| chart group | allowed | Office default (omitted) | ChartSpec `position` → written |
|---|---|---|---|
| `pieChart` | `bestFit`, `outEnd`, `inEnd`, `ctr` | bestFit | outEnd→outEnd, inEnd→inEnd, ctr→ctr |
| `barChart` clustered | `inBase`, `inEnd`, `outEnd`, `ctr` | outEnd | same |
| `barChart` stacked / percentStacked | `inBase`, `inEnd`, `ctr` (**no outEnd**) | ctr | outEnd→**inEnd**, inEnd, ctr |
| `lineChart` (and scatter, bubble, stock) | `l`, `r`, `b`, `t`, `ctr` | r | outEnd→`t`, inEnd→`b`, ctr→ctr |
| `doughnutChart`, area, radar, bar3D, line3D | **none — must not be specified** | ctr (doughnut) | omitted |

`lib/chart.js` must apply the same mapping (stacked "outEnd" is drawn inside end; doughnut labels on the ring).

Evidence that violations break files:
- [SPEC] the table above ("this element shall not be specified" for doughnut etc.).
- [GEN] LibreOffice exporter: "We must not export label placement property when the chart type doesn't
  support this option in MS Office, else MS Office would think the file is corrupt & refuse to open it. For
  allowed values see 2.1.1456 … [MS-OI29500]" (`chartexport.cxx` l.5958); it never writes dLblPos for doughnut.
- [FIELD] PptxGenJS #768 (line `bestFit` → PowerPoint asks to repair and fails), #788 (bar `t` → "crashing
  ppt"); fixed by validating against the same table (`gen-objects.ts` l.227). python-pptx #1134 (2026, open):
  `plot.data_labels.position = RIGHT` on a clustered **bar** (group-level `c:dLbls`) "breaks opening the
  presentation in Office 365 (web)", cannot be repaired; #272: pie with ABOVE/BELOW/INSIDE_BASE/RIGHT/LEFT →
  corrupt. So although [MS-OI29500] says any value is allowed when no `c:ser` is an ancestor, enforce the
  table at every level.

Structure:
- [SPEC 2.1.1457] "Office does not allow delete, dLbl, leaderLines, numFmt, showLeaderLines, spPr or txPr
  child elements when the parent is not ser" → group-level `c:dLbls` = show* flags only. [PPT-XML] exactly
  that (plus `showLeaderLines` on pies). Note: python-pptx's documented `plot.data_labels.number_format/.font`
  writes `numFmt`/`txPr` there; no repair reports were found for it, so the lint grades it `warn` — the builder
  simply never does it.
- Series level: `numFmt(sourceLinked 0), spPr(noFill), txPr, dLblPos?, showLegendKey 0, showVal 1,
  showCatName 0, showSerName 0, showPercent 0, showBubbleSize 0, showLeaderLines 0` — the order and content
  PowerPoint writes [PPT-XML]. python-pptx's `CT_DLbls.new_dLbls()` writes `showLeaderLines val="1"` for every
  chart type; [SPEC 2.1.1549] restricts it to pie/doughnut → the builder writes 0.
- [SPEC 2.1.1551] `showPercent` only under pie/doughnut → always 0 here.

## 9. Axes and gridlines

- [PPT-XML] PowerPoint 16: `majorTickMark none`, `minorTickMark none`, `tickLblPos nextTo`, catAx `numFmt
  General sourceLinked=1`, valAx `numFmt` + `sourceLinked`, value-axis `spPr` `a:ln/a:noFill`, gridlines
  `c:majorGridlines/c:spPr/a:ln w="9525"`; hidden axis `c:delete val="1"`.
- Explicit scale: `c:scaling` = `orientation`, `max`, `min` (schema order); `c:majorUnit` when gridlines show.
  `c:crossBetween val="between"` ("If not specified, then the application should choose" [SPEC §21.2.2.32]).
- `c:tickLblSkip val="1"`, `c:tickMarkSkip val="1"`: PowerPoint may otherwise skip category labels; with 1
  it wraps them instead (`wrap="square"`).
- [SPEC MS-OI29500 2.1.1432/2.1.1446/2.1.1444/2.1.1570] `axId`/`crossAx` ≤ 2147483647 and must match an axis.
  python-pptx's bar/column template uses negative IDs (`-2068027336`) — invalid `xsd:unsignedInt`
  [LOCAL: XSD rejects it]; the builder renumbers to 100000001… (PowerPoint 16 writes e.g. 2113668271).

## 10. Legend, title, rounded corners, transparent chart space

- [PPT-XML] chart-space and plot-area `c:spPr` = `<a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/>`;
  `c:roundedCorners val="0"` in 44/44 classic parts.
- [SPEC 2.1.1431] `autoTitleDeleted` only applies when no `c:title` exists → `chart.has_title = False`.
- Legend: `legendPos` b/t/r, `overlay 0`, `spPr` noFill, `txPr` fonts; none → no `c:legend`. A manual legend
  layout would need all four of x,y,w,h (2.1.1494) — not used (see §15 R3).

## 11. Embedded workbook ("Edit Data")

- python-pptx writes `/ppt/embeddings/Microsoft_Excel_Sheet{n}.xlsx` (XlsxWriter), content type
  `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, relationship type `…/package` from the
  chart part, `c:externalData r:id` + `c:autoUpdate val="0"` — the same shape PowerPoint writes [PPT-XML: 42/44 parts embed an xlsx via a `package`
  relationship (41 named `Microsoft_Excel_Worksheet*.xlsx`), 2 link an external workbook; all `autoUpdate 0`]; [SPEC 2.1.1466] the rel must exist on the chart part.
- Layout: `Sheet1`, A1 empty, categories A2:A(n+1), series names B1…, values below; the chart's `c:f`
  formulas point at exactly these cells. [LOCAL] all 7 workbooks open with openpyxl 3.1.5 and every `c:f`
  resolves to the same values as the `c:strCache`/`c:numCache` points (including `None` gaps).
- Don't: deep-copy a chart graphicFrame to another slide (dangling `r:id`), delete the embedding part, or
  change `c:f` without rewriting the workbook. Values edited in Excel keep the chart formatting (formatting
  lives in the chart part; data label `numFmt sourceLinked=0` keeps its format).

## 12. Do we need c14 / mc:AlternateContent or chart style/color parts?

No. `c:style` is optional in `CT_ChartSpace` [SPEC XSD]; [PPT-XML] 42/44 PowerPoint parts write
`mc:AlternateContent` + `c14:style` (41 × 102, 1 × 118; fallback `c:style`), 2/44 write a plain `c:style`, and 6/44
PowerPoint parts have no chartStyle/chartColorStyle parts and python-pptx writes neither (except its radar template); every visual
property is explicit here, so the style would only affect defaults we override. Omitting them keeps the XML
free of MCE constructs (which a strict validator would have to preprocess). PowerPoint creates the style parts
itself if the user later picks a Chart Style.

## 13. PowerPoint repair triggers for python-pptx charts and how to avoid them

### 13.1 Triggers

| # | trigger | evidence | avoided by |
|---|---|---|---|
| 1 | `c:dLblPos` not allowed for the chart group (at any level) | [SPEC] 2.1.1456; [GEN] LibreOffice "would think the file is corrupt & refuse to open it"; [FIELD] PptxGenJS #768/#788, python-pptx #1134/#272 | `resolve_dlbl_pos()`; lint R1 |
| 2 | duplicate `c:order` (or `c:idx`) between series | [SPEC] 2.1.1509/2.1.1482 "Office requires … unique"; [FIELD] python-pptx #123 comment: PowerPoint "will complain and remove all shapes in the slide" after repair | python-pptx sets idx=order=i; never renumber; lint R7 |
| 3 | child elements out of schema order / wrong element | generic OOXML (PowerPoint validates the part); python-pptx #396 (scanny: "it happens whenever the XML is invalid") | `put()` inserts by `dml-chart.xsd` sequence; XSD gate |
| 4 | `axId`/`crossAx` that match no axis, > 2147483647, > 4 axes | [SPEC] 2.1.1432/2.1.1446/2.1.1444/2.1.1570/2.1.1523 "Office requires" | renumber to positive IDs; lint R6 |
| 5 | doughnut without `c:holeSize`/`@val` or out of 1..90 | [SPEC] 2.1.1458/2.1.1480/2.1.1586 "Office requires" | always written; lint R3 |
| 6 | partial `manualLayout` (x/y without w/h) under plotArea/legend; `layoutTarget` outside plotArea | [SPEC] 2.1.1494/2.1.1486 "Office requires" | all four written; lint R4/R5 |
| 7 | `showPercent val=1` outside pie/doughnut | [SPEC] 2.1.1551 "Office requires" | always 0; lint R8 |
| 8 | `barDir` without `val`, `serLines` > 1 | [SPEC] 2.1.1439, 2.1.1438 | python-pptx template |
| 9 | chart shape copied without its chart part (dangling `r:id`) / duplicate zip entries | [FIELD] python-pptx #396 comments | only `add_chart` |
| 10 | NaN/inf values, XML-illegal control chars, non-str categories | [LOCAL] TypeError in XlsxWriter / lxml XMLSyntaxError at build time; int categories → `c:numRef` | `clean_number()`, `clean_text()` |

Lower-risk items the builder also neutralizes (stated as Office rules, no repair reports found): group-level
`numFmt/spPr/txPr` in `c:dLbls` (2.1.1457), `showLeaderLines val=1` outside pies (2.1.1549), bare booleans.

### 13.2 What XSD validity does and does not prove
[LOCAL] Strict validation of PowerPoint's own 44 chart parts (MCE fallback applied): only 18 pass. PowerPoint
writes `c:chart/c:extLst` **before** `c:showDLblsOverMax` and puts 0 or 2 children inside one `c:ext`, both
contrary to the XSD. So the XSD gate is conservative (sufficient, not necessary); our output contains no
extension content and passes it. The lint was run on the same 44 PowerPoint parts: **0 errors** (no false
alarms); its only warnings concerned data-label layouts and were scoped out.

### 13.3 Schema sequences used by `put()` (Transitional `dml-chart.xsd`)
- chartSpace: date1904, lang, roundedCorners, [AlternateContent|style], clrMapOvr, pivotSource, protection,
  chart, spPr, txPr, externalData, printSettings, userShapes, extLst
- chart: title, autoTitleDeleted, pivotFmts, view3D, floor, sideWall, backWall, plotArea, legend,
  plotVisOnly, dispBlanksAs, showDLblsOverMax, extLst
- plotArea: layout, (chart groups)*, (valAx|catAx|dateAx|serAx)*, dTable, spPr, extLst
- manualLayout: layoutTarget, xMode, yMode, wMode, hMode, x, y, w, h, extLst
- barChart: barDir, grouping, varyColors, ser*, dLbls, gapWidth, overlap, serLines*, axId×2, extLst
- lineChart: grouping, varyColors, ser*, dLbls, dropLines, hiLowLines, upDownBars, marker, smooth, axId×2, extLst
- pieChart: varyColors, ser*, dLbls, firstSliceAng, extLst; doughnutChart: … firstSliceAng, holeSize, extLst
- bar ser: idx, order, tx, spPr, invertIfNegative, pictureOptions, dPt*, dLbls, trendline*, errBars, cat, val, shape, extLst
- line ser: idx, order, tx, spPr, marker, dPt*, dLbls, trendline*, errBars, cat, val, smooth, extLst
- pie ser: idx, order, tx, spPr, explosion, dPt*, dLbls, cat, val, extLst
- dPt: idx, invertIfNegative, marker, bubble3D, explosion, spPr, pictureOptions, extLst
- dLbls: dLbl*, (delete | numFmt, spPr, txPr, dLblPos, showLegendKey, showVal, showCatName, showSerName,
  showPercent, showBubbleSize, separator, showLeaderLines, leaderLines), extLst
- catAx/valAx: axId, scaling(logBase, orientation, max, min), delete, axPos, majorGridlines, minorGridlines,
  title, numFmt, majorTickMark, minorTickMark, tickLblPos, spPr, txPr, crossAx, crosses|crossesAt, then catAx:
  auto, lblAlgn, lblOffset, tickLblSkip, tickMarkSkip, noMultiLvlLbl / valAx: crossBetween, majorUnit,
  minorUnit, dispUnits; extLst
- legend: legendPos, legendEntry*, layout, overlay, spPr, txPr, extLst
- a:defRPr children: ln, (fill), (effect), highlight, uLn…, uFill…, latin, ea, cs, sym, hlinkClick, …

## 14. Empirical verification (what was executed, real outcomes) [LOCAL]

1. `make_sample_deck.py` → `out/chart-samples.pptx` (7 charts, typeface NanumGothic, Hangul labels).
2. `verify_deck.py out/chart-samples.pptx` → **7 charts, 0 failures**: each chart part XSD-valid; content
   type chart+xml; `c:externalData`+`c:autoUpdate`; rel type `package`; embedded workbook content type
   `…spreadsheetml.sheet`; openpyxl 3.1.5 opens every workbook (`Sheet1`, e.g. A1:C5 for chart 1); every `c:f`
   (series names, categories, values) equals the cache; python-pptx 1.0.2 reopens every chart with the right
   `chart_type`, series names, values (with `None`) and categories. Log: `out/verify-chart-samples.txt`.
3. `office_chart_lint.py out/chart-samples.pptx` → 0 errors, 0 warnings on all 7 (`out/lint-chart-samples.txt`).
4. Negative controls (`make_negative_controls.py`): python-pptx stacked + OUTSIDE_END, doughnut + OUTSIDE_END,
   line + BEST_FIT via the documented plot-level API → lint errors on all three positions; raw python-pptx
   column charts fail the XSD on the negative `crossAx`.
5. Positive control: the 44 PowerPoint 15/16 chart parts → lint 0 errors; XSD result in §13.2.
6. LibreOffice 7.4.7.2 renders (`out/lo/page-1..7.png`): plot rectangles exact; bar geometry = §3.3 formula
   within 1 px; value scale exact; category order/`crosses=max` as intended; stacked labels at inside end;
   line gap for `None`; pie first slice at 12 o'clock clockwise; transparent frame; no title; Hangul rendered
   in NanumGothic. Deviations (LibreOffice only): doughnut hole 50 % instead of 60 %; Latin–Hangul spacing.
7. `experiments.py` (`out/lo-exp/`): `firstSliceAng=90` → first slice between 3 and 6 o'clock; `inner` vs
   `outer` → 169–569 vs 181–543.
8. `test_chart_native.py` (regression tests): sanitizer (NaN/inf → gap, control chars stripped, int categories →
   strings), `resolve_dlbl_pos` against the full [MS-OI29500] table, manualLayout range guard, and the full
   build → XSD → lint → workbook pipeline.
9. Code quality: pyflakes clean on `scratch/chart/*.py`.

## 15. Open risks (only PowerPoint can confirm)

| # | risk | confidence / impact | mitigation |
|---|---|---|---|
| R1 | **Embedded font not used for chart axis labels / legend** (embedded profile). Confidence figures in this table are the author's estimates. [FIELD] 2017 report (Office 365 ProPlus 1705): embedded fonts failed in axis labels and legend but worked in data labels and titles; a volunteer could not reproduce; unresolved. A volunteer moderator (2023) says "Fonts can be embedded in a presentation, but not in a chart" and suggests theme-font references. | 40 % that current PowerPoint still does this; impact: Hangul axis labels fall back to another font (width drift) | Test first (§16 step 4). Fallbacks: (a) set the theme minor latin/ea font to the embedded typeface and write `+mn-lt`/`+mn-ea` in chart txPr; (b) hide axis labels/legend in the chart (`tickLblPos none`, no legend) and draw them as slide text boxes. The `malgun` profile is unaffected. |
| R2 | PowerPoint honors `layoutTarget inner` + `edge` exactly as LibreOffice does (plot rect = fractions of the frame) | 85 % — matches ECMA text and PowerPoint's own files, measured only in LO | acceptance deck slide overlay |
| R3 | Text placement is PowerPoint-internal: category-label gap below the axis, outEnd label gap, legend entry size/spacing/position, wrapping of long labels | 90 % that a few px of drift exists | keep labels short; if exact placement matters, draw legend/labels as slide text |
| R4 | Bar thickness/offset formula (§3.3) in PowerPoint | 85 % (derived from spec semantics; verified in LO) | acceptance deck |
| R5 | `rot="0"` on axis/label text is honored as horizontal (not "automatic") | 85 % | — |
| R6 | Fractional font sizes (`sz="975"` = 9.75 pt) render at 9.75 pt in chart text | 80 %; ≤0.25 pt error otherwise | round to 0.5 pt if drift is seen |
| R7 | PowerPoint for the web is stricter than desktop (python-pptx #1134 failed on web) | medium | builder already follows the strictest reading |
| R8 | LibreOffice preview ≠ PowerPoint for doughnut hole (always 50 %) and Latin–Hangul spacing | certain (observed + LO source `//FIXME: holeSize`) | accept for the Noah preview, or keep holeSize = 50 in designs |
| R9 | `NanumGothic` in the sample deck is not installed on the user's Windows → PowerPoint substitutes | certain for the sample; not for real output | builder uses the profile typeface |

## 16. PowerPoint acceptance checklist (for the user, Windows PowerPoint / Microsoft 365)

1. Open `\\wsl.localhost\Ubuntu-24.04\home\jinyoung\pptx-poc\scratch\chart\out\chart-samples.pptx` →
   expect **no** "PowerPoint found a problem with content" prompt (7 slides, 7 charts).
2. Compare each slide with `scratch\chart\out\lo\page-N.png` (LibreOffice): plot rectangles, bar widths,
   scale and colors should coincide; note any offset in labels/legend (R3).
3. Right-click a chart → **Edit Data** → the Excel window shows Sheet1 with the Hangul categories and series;
   change a number → the chart updates and keeps its colors/labels.
4. Font check (R1): after the fonts lane lands, rebuild with `CHART_TYPEFACE=<embedded typeface>`, run
   `tools/embed_fonts.py … --profile embedded` on the deck, open it on a PC **without** that font installed,
   click a category label and a data label: both should render in the embedded font.
5. Slide 2 labels sit inside the segment tops (stacked `outEnd` → `inEnd`); slide 6 doughnut hole = 60 %.

## 17. Sources

Microsoft / ECMA
- [MS-OI29500] 2.1.1456 dLblPos: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/e2b1697c-7adc-463d-9081-3daef72f656f
- 2.1.1457 dLbls: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/953e5879-8008-4d14-a8bc-fbe39d848e0a
- 2.1.1455 dLbl: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/f4264e4b-7a40-405d-a32c-e804b2fcaac3
- 2.1.1494 manualLayout: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/8ef04866-6150-457e-9997-509ec5a80cf5
- 2.1.1486 layoutTarget: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/63d53b16-d3cf-4361-b048-75462a9a40e7
- 2.1.1575 x / 2.1.1576 xMode / 2.1.1577 y / 2.1.1578 yMode / 2.1.1573 w / 2.1.1574 wMode / 2.1.1477 h / 2.1.1479 hMode:
  …/39d7c733-19c2-4442-87d9-97c0efce4cda, …/033c001f-a29a-4817-a32a-75394f971109, …/8c46e53b-c525-4bb6-8927-59d133a60a06,
  …/3e552fb6-fb17-40bd-aa1c-6628425e5b8a, …/251f0661-860c-455e-bc94-a20c41df76c7, …/67d2127f-6922-43a2-9ffe-e4d67615136d,
  …/2492a099-586a-4b75-99a5-39bb273e5c0a, …/4d59213a-27af-4901-9006-ff11f30589b4 (prefix https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/)
- 2.1.1458 doughnutChart …/715e20be-5789-467d-b9ec-5a39ae8a307b; 2.1.1480 holeSize …/21355c07-074d-42ba-8c5e-37e6f33692ac; 2.1.1586 ST_HoleSize …/56d2baaf-961d-4e81-bc6f-09d90ef42a68
- 2.1.1431 autoTitleDeleted …/94796dcb-1512-4541-b4d0-9514d4070913; 2.1.1432 axId …/089f849f-fcd6-4fa0-a281-35aa6a432a16; 2.1.1446 crossAx …/195a0d2d-3977-477a-86de-d88b14745e13; 2.1.1433 axPos …/5989881e-d2de-44f3-8792-8dbded2e2b00; 2.1.1444 catAx …/c6aec8b1-cbe3-4239-ba00-b837970abc14; 2.1.1570 valAx …/a00fdd02-4b9f-424a-9f7e-6bc5239c298e; 2.1.1523 plotArea …/83596c29-eda7-4a40-a24d-721aa7b23b3f
- 2.1.1482 idx …/6ceb7cd8-40d8-4c66-95fa-130240a4a22a; 2.1.1509 order …/3bb9ee04-625a-48d9-8462-c6b25dc8a319; 2.1.1549 showLeaderLines …/52830fc3-8068-4e69-9e0e-9fdb4d45e7ee; 2.1.1551 showPercent …/5ab67be7-75d9-474c-8104-d1167f77b169; 2.1.1519 pieChart …/f2797eb1-3b5e-4a40-be3e-344faa60f3dc; 2.1.1571 varyColors …/c929a5be-b7e4-401b-a9b5-699079e2705c
- 2.1.1566 txPr …/7567be8d-0d5e-4265-a80b-52a3006799b3; 2.1.1555 spPr …/efeb511d-3275-4e5d-a518-04bd555d9540; 2.1.1495 marker (show) …/72be6907-2aa4-474d-a8e2-9b5fb073bd8a; 2.1.1475 gapWidth …/2f482e39-6b11-4a3b-a3c4-3c46edfb3fc9; 2.1.1512 overlap …/4abcc447-4ee3-422c-b12f-0eb93ab89779; 2.1.1466 externalData …/3749a690-7ce7-4cf0-897a-cb98f767dd91; 2.1.1452 dispBlanksAs …/1942c028-3c4e-4dd9-a379-b12a9b7914df; 2.1.1439 barDir …/e99b822a-a75c-4a26-8b42-0136b3acee5b; 2.1.1438 barChart …/4f86580b-39ca-4555-8ef8-44b2f35f3648
- [MS-OI29500] TOC: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/toc.json (all 198 chart-section texts in `scratch/chart/sources/ms-oi29500-chart-clean.txt`)
- ECMA-376 5th ed. Part 1 (normative text §21.2): https://ecma-international.org/wp-content/uploads/ECMA-376-1_5th_edition_december_2016.zip
- ECMA-376 5th ed. Part 4 (Transitional XSD `dml-chart.xsd`): https://ecma-international.org/wp-content/uploads/ECMA-376-4_5th_edition_december_2016.zip

Generators / readers (pinned)
- LibreOffice `chartexport.cxx` (l.3471 overlap, l.3566 holeSize FIXME, l.5958 dLblPos, l.3030 layoutTarget):
  https://github.com/LibreOffice/core/blob/e92d181289fd7c9d7a173eb9dee23b0bf910b143/oox/source/export/chartexport.cxx
- LibreOffice `plotareaconverter.cxx` (l.637): https://github.com/LibreOffice/core/blob/e92d181289fd7c9d7a173eb9dee23b0bf910b143/oox/source/drawingml/chart/plotareaconverter.cxx
- LibreOffice `converterbase.cxx` (l.353 calcAbsRectangle): https://github.com/LibreOffice/core/blob/e92d181289fd7c9d7a173eb9dee23b0bf910b143/oox/source/drawingml/chart/converterbase.cxx
- LibreOffice `objectformatter.cxx` (convertTextRotation), `typegroupmodel.cxx`, `chartspacemodel.cxx`, `chartspacefragment.cxx`, `xmlfilterbase.cxx` (same SHA, `oox/source/…`)
- PptxGenJS `gen-charts.ts`, `gen-objects.ts` (l.227 dLblPos validation, l.251 marker symbols): https://github.com/gitbrent/PptxGenJS/blob/3c9ec1b687c174952166f6a34b5e87ebf69fa469/src/gen-objects.ts
- python-pptx 1.0.2 installed source (`pptx/chart/xmlwriter.py`, `pptx/oxml/chart/datalabel.py` `new_dLbls`),
  data-label analysis: https://github.com/scanny/python-pptx/blob/278b47b1dedd5b46ee84c286e77cdfb0bf4594be/docs/dev/analysis/cht-data-labels.rst

Field reports
- PptxGenJS #768 https://github.com/gitbrent/PptxGenJS/issues/768 · #788 https://github.com/gitbrent/PptxGenJS/issues/788 · PR #938 https://github.com/gitbrent/PptxGenJS/pull/938
- python-pptx #1134 https://github.com/scanny/python-pptx/issues/1134 · #272 https://github.com/scanny/python-pptx/issues/272 · #123 https://github.com/scanny/python-pptx/issues/123 · #396 https://github.com/scanny/python-pptx/issues/396
- Embedded fonts in charts: https://learn.microsoft.com/en-us/answers/questions/5cef5fac-acc7-4866-8ac8-a671470cb623/embedded-font-not-showing-in-certain-parts-of (2017) ·
  https://learn.microsoft.com/en-us/answers/questions/5200063/embedded-font-in-chart-showing-up-as-a-different-f (2023)

PowerPoint-written XML corpus
- LibreOffice test data (`chart2/qa/extras/data/pptx`, `sd/qa/unit/data/pptx`, `oox/qa/unit/data`), Apache POI
  `test-data/slideshow`, python-pptx `features/steps/test_files` — sparse clones in `scratch/chart/corpus/`.
