# Text mapping: IR `text` element → native PowerPoint text box

> **Historical PoC evidence, preserved for maintainers — not agent-facing.** Written in the HTML→PPTX
> proof of concept before its port into Noah (2026-09) and copied here unchanged below this note. Paths such
> as `scratch/…`, `tools/…`, `out/…`, `fonts/…`, `theme/…`, `slides/…`, `docs/…` and `$POC` refer to that PoC
> tree, and machine paths (`/home/jinyoung/…`, `/mnt/c/Windows/Fonts`) to its dev box — Windows fonts were
> only ever READ in place there, never copied. The shipped converter is `default-skills/skills/pptx/converter/`;
> see [`docs/architecture/pptx-converter.md`](../../architecture/pptx-converter.md) and
> [the index of this directory](../README.md).

Owner: text-mapping lane. Experiments, scripts and raw data: `scratch/text-mapping/` (paths below are relative to
it unless they start with `docs/` or `tools/`). Reference implementation the builder can copy:
`scratch/text-mapping/textmap.py` (+ `pptbreak.py` for the wrap-width check).

**Confidence legend** — **H**: stated by a primary source (ECMA-376, Microsoft Open Specifications, Microsoft
support) or verified here on PowerPoint's own output; **M**: consistent secondary evidence (measurements of native
PowerPoint exports published by other projects, interoperating generator/reader source); **L**: inference.
**Evidence classes used below**: *PPT-mac* = PDF exported by native PowerPoint for Mac 16.111 (office2pdf golden
mocks, re-measured here with PyMuPDF); *PPT-win* = native Windows PowerPoint exports measured by office2pdf (raw
files not published; their issue text is the evidence); *LO* = LibreOffice 7.4.7.2 in `pptx-poc-lo` (= Noah's
preview renderer; evidence about LibreOffice only); *CH* = Chromium 149 (playwright-core 1.61.1, chromium-1228) as the
extractor runs it.

---------------------------------------------------------------------------------------------------------------------

## 0. Summary for the builder

1. **One `p:sp` text box per IR text element**, `txBox="1"`, `prstGeom rect`, no fill, no line (its background is the
   preceding IR `shape`). Insets 0, `anchor="t"`, `<a:noAutofit/>`, `wrap="none"` when the block has no soft wrap,
   else `wrap="square"`. Everything written explicitly (bodyPr/pPr/rPr values are otherwise *inherited* from theme →
   master → defaults, [MS-OI29500] 2.1.1379/2.1.1388/2.1.1399).
2. **Vertical placement**: `box.y = lines[0].baseline − seat`, with PowerPoint's seat model (section 2):
   `share = 1.2·A/(A+D)` from the fonts' **usWinAscent/usWinDescent**; `seat = 0.9·pct·S` when the whole-percent line
   spacing `pct > 100 %`, else `(1.2·pct − 1.2 + share)·S` (S = largest run size on line 1, in pt).
   Verified on 151 lines of native PowerPoint output (all within the export's 0.12 pt half-grid).
3. **Line spacing**: `a:lnSpc/a:spcPct val = round(L / (1.2·S) · 100) · 1000` (L = CSS line-height px, S = font px).
   PowerPoint advances every line **1.2 × S × pct**, font-independent. `spcPts` (exact) is **not** used for line
   spacing: its first-baseline behaviour is unmeasured in PowerPoint.
4. **Paragraph mark and breaks**: `a:endParaRPr` and every `a:br/a:rPr` repeat the text's typefaces and size; a bare
   `endParaRPr` inherits the theme minor font (Calibri) and moves the paragraph's last baseline (measured, section 2.5).
5. **Paragraph spacing**: only `a:spcBef` (spcPts) on paragraphs 2..n, computed from measured baselines (preferred) or
   CSS margins with collapsing; never on the first paragraph; no `spcAft`.
6. **Runs**: `latin`+`ea`+`cs` = face typeface; `lang="ko-KR" altLang="en-US"`; `dirty="0"`; `b` from the face;
   integer attribute forms only (`sz`, `spc`, `baseline`, `alpha val`). No `kern` anywhere (strip `kern="1200"` from
   python-pptx's default text styles) and Chromium with `font-kerning: none`.
7. **Korean**: `eaLnBrk="1" latinLnBrk="0" hangingPunct="0"`; slides must use CSS `word-break: normal` (PowerPoint's
   default breaks Hangul between syllables — seen in PowerPoint's own export; `keep-all` does not match).
8. **Width parity needs a Chromium setting**: the extractor must lay text out with **`text-rendering:
   geometricPrecision`** (or launch with `--font-render-hinting=none`); by default Chromium uses whole-pixel advances
   (−3.1 %…+1.5 % vs the font), PowerPoint uses the font's advances snapped to 1/8 pt.
9. **Wrap-width check** (needs IR `lines[i].text` + `lines[i].paragraph`): choose the box width inside the window in
   which PowerPoint's greedy breaker reproduces Chromium's lines (`pptbreak.width_window`, validated 7/7 on real
   PowerPoint breaks); fall back to hard breaks when no window exists.
10. **Never** emit: percent strings (`"50%"`), `anchor="just|dist"`, a `txBody` without `a:p`, out-of-order children,
    `marL < 0`, `sz < 100`, `lnSpc` with two children (all flagged by Microsoft's Open XML SDK validator, section 7).

---------------------------------------------------------------------------------------------------------------------

## 1. `a:bodyPr`

### XML to write

```xml
<p:sp>
  <p:nvSpPr><p:cNvPr id="…" name="…"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
  <p:spPr>
    <a:xfrm><a:off x="…" y="…"/><a:ext cx="…" cy="…"/></a:xfrm>
    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/>
  </p:spPr>
  <p:txBody>
    <a:bodyPr wrap="none|square" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t">
      <a:noAutofit/>
    </a:bodyPr>
    <a:lstStyle/>
    <a:p>…</a:p>
  </p:txBody>
</p:sp>
```

python-pptx's `add_textbox` writes `<a:bodyPr wrap="none"><a:spAutoFit/></a:bodyPr>` — replace the whole `txBody`
(see `textmap.build_text_shape`):

```python
shape = slide.shapes.add_textbox(Emu(x_emu), Emu(y_emu), Emu(w_emu), Emu(h_emu))
txBody = shape._element.txBody
for child in list(txBody):
    txBody.remove(child)
body = etree.SubElement(txBody, qn("a:bodyPr"))
for k, v in dict(wrap="square" if soft_wrapped else "none", lIns="0", tIns="0", rIns="0", bIns="0",
                 rtlCol="0", anchor="t").items():
    body.set(k, v)
etree.SubElement(body, qn("a:noAutofit"))
etree.SubElement(txBody, qn("a:lstStyle"))
```

| attribute | value | why / evidence | conf. |
|---|---|---|---|
| `lIns tIns rIns bIns` | `0` | defaults are 91440/45720/91440/45720 EMU (ECMA-376 §21.1.2.1.1) and may also be inherited from theme `txDef` or the master ([MS-OI29500] 2.1.1379 b) — the IR box is already the content box | H |
| `wrap` | `none` if the element has **no soft wrap** (every line ends at a paragraph end or `<br>`), else `square` | `none`: "No wrapping occurs on this text body. Words spill out without paying attention to the bounding rectangle boundaries." (§20.1.10.85) — PowerPoint can never reflow such a block. Refinement of the CONTRACT rule "exactly one line": a list whose items are one line each (3 lines, 3 paragraphs) is also safe as `none` | H |
| `anchor` | `t` | the box top is computed from the baseline (section 2), so the anchor must not re-centre; `just`/`dist` are not allowed by Office ([MS-OI29500] 2.1.1337) and fail validation | H |
| autofit | `<a:noAutofit/>` element, explicit | omitting it does **not** mean "off" in Office: "Office uses a hierarchy of text styles to determine if the text should be autofit" ([MS-OI29500] 2.1.1380/2.1.1382); `spAutoFit` resizes the shape, `normAutofit` rescales fonts | H |
| `rtlCol` | `0` | what PowerPoint writes; column order only (§21.1.2.1.1), Office's implied value is false ([MS-OI29500] 2.1.1379 a) | H |
| `vertOverflow`, `horzOverflow` | omit (`overflow`) | text past the box is drawn, not clipped (§21.1.2.1.1) | H |
| `spcFirstLastPara` | omit | irrelevant: the builder never writes space before the first / after the last paragraph | H |
| `upright`, `vert`, `numCol`, `rot` | omit | defaults (false/horz/1/0); rotation belongs on `a:xfrm rot` | H |
| `anchorCtr`, `compatLnSpc`, `forceAA`, `fromWordArt` | omit | implied false ([MS-OI29500] 2.1.1379 a) | H |

**When text exceeds the box.** With `noAutofit` and default overflow, PowerPoint draws the text past the box
(ECMA-376 `vertOverflow`/`horzOverflow` default `overflow`; `wrap="none"`: "Words spill out without paying attention
to the bounding rectangle boundaries"); with `anchor="t"`
overflow goes downward. For `wrap="none"`, LibreOffice 7.4 (measured, `exp/ovf/`) sends a too-wide line right for
`algn="l"`, symmetrically for `ctr` (centre at 639.95 px for a box centred at 640) and left for `r`; PowerPoint is
expected to behave the same (**M**). Chromium differs: CSS start-aligns any line that overflows its box
(measured: `text-align:center` overflow starts at the box's left edge). Overflowing text is already an extractor lint
error; for non-overflowing text all three agree.

**Rotation.** If `rotationDeg ≠ 0`, keep PowerPoint's rotation centre where Chromium's is: after moving `y` for the
baseline, set `h = 2·(cy − y)` with `cy` = content-box centre (`textmap.build_text_shape` does this). This needs the
IR lines of rotated elements in the element's *unrotated* frame (L — not tested).

---------------------------------------------------------------------------------------------------------------------

## 2. Line spacing and first-baseline parity

### 2.1 PowerPoint's model (what the builder targets)

Measured by office2pdf with native one-factor probes, published in their tracker; re-verified here:

* **Line advance = 1.2 × S** with no `lnSpc`, independent of the font (S = largest run size on the line).
  *PPT-win*: "line height = 1.2 × size, font-independent (all three fonts advance exactly 28.80pt at 24pt)" for Arial,
  Calibri, Malgun Gothic, boxes authored and exported by real Windows PowerPoint via COM (office2pdf #485 comment,
  #513). *PPT-mac*: same (office2pdf `pdf.rs` POWERPOINT_LINE_HEIGHT_FACTOR notes; #1177). A third project reports the
  same "≈120 % of point size" pitch against PowerPoint PDF references for Meiryo and Arial at 12/18/24/32 pt, all
  anchors, paragraph and automatic wraps (office-open-xml-viewer PR #1475). **H/M**
* **Baseline inside the line (seat) = share × S**, `share = 1.2 · A/(A+D)` where for every face on the line
  `a = usWinAscent/(usWinAscent+usWinDescent)`, `d = usWinDescent/(…)`, `A = max a`, `D = max d`. hhea/typo metrics are
  not used. *PPT-win*: anchor=t first baseline 0.972 / 0.936 / 0.982 em for Arial / Calibri / Malgun Gothic = the usWin
  shares (Calibri's hhea would give 0.900) (#513). *PPT-mac*: 14 sizes × 10 faces incl. Yu Gothic whose usWin ≠ hhea
  (#1176). **M** (H for the three fonts above)
* **The paragraph mark is a face on the paragraph's last line only**: a bare `<a:endParaRPr lang="en-US"/>` inherits
  `+mn-lt` (Calibri) and changes the last line's share; varying only the mark's typeface moves the last baseline (up to 5.04 pt over
  11–53 pt, #1645) and leaves the others (#1177 table at 17 pt: Calibri 162.00, Arial 162.96, Meiryo 161.04). An *absent* endParaRPr adds no
  face (#1645). **M**
* **`a:br` contributes no metrics**: its `rPr` size/face moves nothing (#1666 probes). **M**
* **`spcPct` ≤ 100 %**: line advance `1.2·pct·S`, the line is shortened *from the top* (descent gap kept):
  `seat = 1.2·pct·S − (1.2 − share)·S` (Arial 38 pt at 85 %: −6.96 pt vs −6.84 pt predicted; 18 Posterama titles)
  (#1074/#1020 in office2pdf `typst_gen_text.rs` notes). **M** (*PPT-mac*)
* **`spcPct` > 100 %**: `seat = 0.9·pct·S`, face-independent; advance `1.2·pct·S` (Arial 6–14 pt × 125/150/200 %;
  Georgia/Verdana/Times at 150 % identical) (#1254). **M** (*PPT-mac*)
* The percentage is **rounded to a whole percent** before use (100.499 % ≡ 100 %) (office2pdf notes). **M**
* *PPT-mac* export positions are rounded to whole points within the text story; the one *PPT-win* comparison
  (19.95 pt vs 18.96 pt Mac for the same paragraph; unrounded model 19.91 pt) suggests Windows does not round (#513).
  The builder ignores this ±0.5 pt effect. **M/L**
* **`anchor="ctr"`** centres the sum of line advances (N × 1.2 em) between the insets (#485, *PPT-win*). **M**

**Independent re-verification here (H for PowerPoint for Mac 16.111).** `analyze_golden.py` matched every text shape
of the 10 office2pdf golden decks (Arial, Arial Bold/Italic, Malgun Gothic/Bold, Courier New; 11–40 pt; anchors t and
ctr; bullets; `spcAft`) to its glyphs in PowerPoint's own PDF, and `verify_ppt_model.py` predicted every baseline
from the XML with the model above (marks = Calibri, usWin values read in place from `/mnt/c/Windows/Fonts`):

| rounding assumption | lines | mean error | MAE | max abs error | within 0.13 pt |
|---|---|---|---|---|---|
| none | 151 | −0.114 pt | 0.245 pt | 0.557 pt | 33 |
| **whole points within the story** | 151 | −0.006 pt | **0.052 pt** | **0.120 pt** | **151** |

(0.12 pt is half of the export's 0.24 pt = 1/300 in position grid.) The 10 pt `spcAft` of bulleted paragraphs adds
exactly between paragraphs.

### 2.2 Chromium's model (what the IR measured)

Blink/LayoutNG, verified exactly in `exp/run*/vertical.txt` (NanumGothic 16/24/40 px, line-heights normal, 1.0, 1.2,
1.5, 2.0): `A = round(asc·S)`, `D = round(desc·S)` with asc/desc from OS/2 typo when USE_TYPO_METRICS is set, else
hhea; first baseline `= line top + floor((L − (A+D))/2) + A` (half-leading, ascent side floored); `line-height:normal`
`= A + D + round(lineGap·S)`. With `text-rendering: geometricPrecision` (subpixel positioning on), Linux Blink
"borrows" one pixel from the ascent when the descent rounds down, moving the baseline up 1 px at 16 px (measured).
**The builder never re-derives this — it uses `lines[0].baseline`.** Two consequences worth knowing:

* google/fonts NanumGothic 3.020: Regular sets USE_TYPO_METRICS (normal line = 1.25 em), **Bold does not** (0.99 em),
  so `line-height: normal` differs by weight. Slides should set explicit line-heights (lint warn on `normal`).
* A different NanumGothic build changes everything: Naver 3.021 (Debian `fonts-nanum`, same family name) has hhea
  920/−230, typo 800/−200/0, usWin 920/230 vs google/fonts' 844/−156, 856/−144/250, 885/198, and 46 different advances.

### 2.3 LibreOffice 7.4's model (Noah's preview)

For every PPTX `p:sp` text body LibreOffice sets `FontIndependentLineSpacing` (`oox/source/ppt/pptshapecontext.cxx`,
7.4 branch), i.e. editeng *FixedCellHeight*: line = 1.2 × font height, **ascent = 1.0 × font height**
(`ImplCalculateFontIndependentLineSpacing`, `impedit3.cxx`). Proportional > 100 % adds the whole surplus above the
line; < 100 % caps the ascent at 80 % of the scaled height; exact (`spcPts`) puts `fix − 0.2·S` above the baseline.
Measured (LO seat vs this model): within ±0.15 px in every clean case (`exp/run3/vertical.txt`). A 2025 commit
extends the same rule to table cells: "Microsoft just ignores the font metrics, and simply adds 20% to the font height
to achieve a 'single spacing' line height" (tdf#165521, Justin Luth).

Consequence for Noah's preview of the builder's output: LO seat − PowerPoint seat = `(1.0 − share)·S` at 100 %
(+0.02 S for NanumGothic), `S·(0.3·pct − 0.2)` above 100 % (+0.175 S at 125 %, +0.3 S at 167 %). LO previews show
text up to **3.6 px lower** than PowerPoint on a typical slide (−0.05…+3.62 px, end-to-end test, section 8).

### 2.4 The builder's formula

For the first line of the first paragraph (all lengths in pt; convert px ↔ pt with ×0.75):

```
S      = max size of the (non-sup/sub) runs of paragraph 0            # line 1 of a uniform paragraph
faces  = faces of those runs (+ the mark's face, identical by rule 4)
share  = 1.2 * max(a_f) / (max(a_f) + max(d_f)),  a_f = winAsc/(winAsc+winDesc), d_f = winDesc/(…)
pct    = round(L_css / (1.2 * S_px) * 100) / 100       # the value written, as PowerPoint will round it
seat   = 0.9 * pct * S                   if pct > 1
       = max(0, (1.2 * pct - 1.2 + share) * S)          otherwise
box.y  = lines[0].baseline_px - seat * 4/3
```

`textmap.py`: `ppt_share`, `ppt_seat_pt`, `ppt_advance_pt`, `whole_percent`, and `build_text_shape`.
`L_css` = `Paragraph.lineHeightPx`; if null, the builder computes Blink's `normal` value from the face file
(`css_normal_line_height_px`) — better: the extractor always resolves it.

Face metrics per profile: *embedded* → usWin of the embedded file (google NanumGothic: 885/198 → share 0.98061);
*malgun* → PowerPoint renders 맑은 고딕, usWin 2229/495 per 2048 (share 0.98194, R and B) — numbers read in place from
`/mnt/c/Windows/Fonts/malgun*.ttf`; production needs them as constants (proposal: `fonts.json` face field
`pptWinMetrics`).

**Why `spcPct` and not `spcPts`.** `spcPct` is the only multi-line mode whose first-baseline placement was measured in
PowerPoint (2.1). `spcPts` gives an exact pitch but PowerPoint's seat for it is unmeasured: office2pdf *assumes* the
≤100 % top-resized rule, betteroffice PR #810 *assumes* centring (validated only against its own LiberationSans
renders, not PowerPoint), LibreOffice uses `fix − 0.2 S`. The whole-percent rounding of `spcPct` costs at most
0.6 % × S per line (e.g. 1.6 × 18 px = 133.33 % → 133 %: −0.07 px/line measured in the model, section 8).

**Mixed sizes.** `spcPct` scales with the largest size *on each line*, CSS px line-height does not. Multi-line
paragraphs with mixed run sizes are a lint **warn**; for them `spcPts = L·75` gives the right pitch at the cost of an
unmeasured seat (L).

Line pitch check: within a paragraph PowerPoint advances `1.2·pct·S` = Chromium's `L` ± rounding; across paragraphs
`(adv_prev − seat_prev) + spcBef + seat_next` (section 3).

### 2.5 Paragraph mark, breaks, empty lines

```xml
<a:p>
  <a:pPr …/>
  <a:r><a:rPr lang="ko-KR" altLang="en-US" sz="1350" b="0" dirty="0">…<a:latin typeface="NanumGothic"/>
       <a:ea typeface="NanumGothic"/><a:cs typeface="NanumGothic"/></a:rPr><a:t>첫 줄</a:t></a:r>
  <a:br><a:rPr …same as the run it follows…/></a:br>
  <a:r>…</a:r>
  <a:endParaRPr lang="ko-KR" altLang="en-US" sz="1350" b="0" dirty="0">…same typefaces…</a:endParaRPr>
</a:p>
```

The python-pptx template's default text style is `latin +mn-lt` = Calibri; a bare mark would add Calibri's usWin
(1950/550) to the last line (NanumGothic+Calibri share 0.9455 vs 0.9806 → last baseline ≈0.7 px higher at 20 px).
An empty paragraph's height comes from its `endParaRPr` (give it explicit size and faces).

### 2.6 Measured (LO and CH, `exp/run3`)

NanumGothic Regular; seat = first baseline − box top (px); pitch = mean baseline step; PPT = model (2.1), not a
measurement.

| size | CSS lh | PPTX lnSpc | CH seat | CH pitch | LO seat | LO pitch | PPT seat | PPT pitch |
|---|---|---|---|---|---|---|---|---|
| 16 | normal | none | 15.00¹ | 20.00 | 16.02 | 19.12 | 15.69 | 19.20 |
| 16 | 1.2 | pct 100 % | 14.00¹ | 19.20 | 15.99 | 19.14 | 15.69 | 19.20 |
| 16 | 1.5 | pct 125 % | 16.99¹ | 24.00 | 20.66 | 23.94 | 18.00 | 24.00 |
| 16 | 2.0 | pct 167 % | 20.99¹ | 32.00 | 28.81 | 31.99 | 24.05 | 32.06 |
| 24 | 1.5 | pct 125 % | 26.00¹ | 36.00 | 31.22 | 35.92 | 27.00 | 36.00 |
| 24 | 1.5 | pts 27 pt | 26.00¹ | 36.00 | 31.22 | 36.00 | (30.73?) | 36.00 |
| 40 | 1.5 | pct 125 % | 44.00 | 60.00 | 52.00 | 59.92 | 45.00 | 60.00 |
| 40 | 2.0 | pts 60 pt | 54.00 | 80.00 | 71.99 | 80.01 | (71.22?) | 80.00 |

¹ run3 uses `geometricPrecision`; at 16 and 24 px it moves Chromium's seat up 1 px versus run1 (Blink's Linux rule
borrows a pixel from the ascent when the descent rounds down); at 40 px the descent rounds up and nothing moves.
"(…?)" = the unmeasured `spcPts` hypothesis. For the `pct` rows the box shift the builder applies (PPT − CH) is
+0.7…+3.1 px — no constant offset could replace the model.

---------------------------------------------------------------------------------------------------------------------

## 3. Paragraph spacing, alignment, indents, bullets

### `a:pPr` (child order: lnSpc, spcBef, spcAft, buClr, buSzPct, buFont, buChar|buAutoNum|buNone, tabLst, defRPr)

```xml
<a:pPr marL="266700" indent="-142875" algn="l" eaLnBrk="1" latinLnBrk="0" hangingPunct="0">
  <a:lnSpc><a:spcPct val="125000"/></a:lnSpc>
  <a:spcBef><a:spcPts val="600"/></a:spcBef>        <!-- paragraphs 2..n only -->
  <a:buSzPct val="100000"/>
  <a:buFont typeface="NanumGothic"/>
  <a:buChar char="•"/>                               <!-- or <a:buAutoNum type="arabicPeriod" startAt="1"/> -->
</a:pPr>
```

* **Paragraph gaps.** PowerPoint adds `spcAft(prev) + spcBef(next)` between paragraphs (golden decks: 10 pt spcAft adds
  exactly); CSS collapses adjacent block margins (max of the two). Emit the whole gap as `spcBef` of the next paragraph,
  `spcAft` never. Exact form (needs `lines[i].paragraph`): `spcBef = (first_baseline(next) − last_baseline(prev)) −
  (adv_prev − seat_prev + seat_next)` (`textmap.exact_gap_px`; e2e: 0.00 px error). Fallback: collapsed CSS margins
  + `(L_prev − adv_prev)`. `spcPts` must be 0…158400 (1/100 pt); clamp negatives to 0 (warn).
  Never write space before the first paragraph — the box position already contains it — so `spcFirstLastPara`
  (ECMA default false: edge spacing not honoured) never matters. **H** (ECMA/validator), **M** (sum behaviour).
* **`algn`**: `l | ctr | r | just` from the IR. Office default for missing `marL`/`indent` is 0 but write both
  ([MS-OI29500] 2.1.1406 a, f; ECMA's implied 347663/−342900 are *not* Office's). `just`: PowerPoint's
  justification of Korean lines and of lines ending in `a:br` is unmeasured — authoring rule: avoid `justify` (L).
* **Indents.** `marL` = li content-box left − text-box left (EMU, ≥ 0 — `ST_TextMargin`); `indent` = −(advance of the
  marker string, i.e. "• " or "1. " including the space, in the li font), clamped to ≥ −marL. PowerPoint puts the
  bullet at `marL + indent` and the text at `marL` on every line: re-measured on PowerPoint's own export (bullet at
  0.00 pt, text at 27.00 pt for `marL=342900 indent=-342900`, first and continuation lines). **H** (PPT-mac)
* **Bullets.** `buFont` = the text face (the bullet glyph is then a face on line 1 like the text — no share change),
  `buSzPct 100000` (integer; percent strings fail validation; Office requires `val`, [MS-OI29500] 2.1.1404),
  `buClr` only when the IR gives a colour (else it follows the text). Numbered: `buAutoNum type="arabicPeriod"`,
  `startAt` 1…32767. LibreOffice places bullet and text ink exactly where Chromium does (dot centre x≈32.5 px, text
  49–51 px, numbers identical, `exp/run3/bullets-compare.png`). Two visible differences remain:
  - Chromium paints `list-style-type: disc` as a geometric dot (6 px at 20 px) while PowerPoint/LO draw the font's
    "•" (4 px). Authoring rule: use a string marker, `list-style-type: "• "`, so Chromium also draws the glyph (M).
  - Chromium right-aligns outside numeric markers ("9." and "10." end at the same x); PowerPoint starts every number
    at `marL+indent`. Use the widest marker for `indent`; keep numbered lists ≤ 9 items or accept ≤ 1 digit shift (L).

---------------------------------------------------------------------------------------------------------------------

## 4. Runs (`a:rPr`)

Attribute/child reference (child order: `ln`, fill, effects, `highlight`, `uLnTx|uLn`, `uFillTx|uFill`, `latin`, `ea`,
`cs`, `sym`, `hlinkClick`, `hlinkMouseOver`, `rtl`, `extLst`):

| IR / CSS | XML | notes | conf. |
|---|---|---|---|
| face (`fontWeight` → fonts.json face) | `<a:latin/><a:ea/><a:cs/>` all `typeface=face.typeface`; `b="1"` iff `face.bold` | Office uses the named typeface when available, else substitution ([MS-OI29500] 2.1.1397 d). With one typeface in all slots the latin/ea/cs slot choice for ambiguous characters (·, ※, quotes) cannot change the font | H |
| language | `lang="ko-KR" altLang="en-US"` on **every** run (also Latin-only runs) | Microsoft KB: in Korean PowerPoint with "Allow Korean text to wrap in the middle of a word" on, English text tagged en-US may wrap mid-word; the documented workaround is tagging it Korean | M |
| `sizePx` | `sz = round(px·75)` (integer, 100…400000) | `ST_TextFontSize`; Office default 1800 when absent ([MS-OI29500] 2.1.1399 e) — always write it | H |
| italic / underline / strike | `i="1"`, `u="sng"`, `strike="sngStrike"` | enumerations only (`u="single"`, `strike="1"` fail validation). NanumGothic has no italic face: Chromium, LO (and PowerPoint, L) synthesise an oblique | H |
| `letterSpacingPx` | `spc = round(px·75)` (1/100 pt, ±400000) | Chromium applies letter-spacing after every character incl. the last (7 chars × 4 px = +28 px, measured) and aligns with it; PowerPoint applies the last run's `spc` after the last glyph too (office2pdf notes) | H (CH) / M |
| kerning | no `kern` attribute anywhere; `sanitize_template()` strips `kern="1200"` from python-pptx's `defaultTextStyle` and master `txStyles` | "Office uses a default value of no kerning if the kern attribute is not specified" ([MS-OI29500] 2.1.1399 a). PowerPoint does kern when a threshold applies (28 of 30 kerning pairs applied in the golden exports, which inherit `kern="1200"`). Chromium must use `font-kerning: none`. `kern="0"` is read as "never" by office2pdf but that is unmeasured | H |
| ligatures | — | PowerPoint never applies `liga`/`clig` (office2pdf #1058, *PPT-mac*); Chromium: `font-variant-ligatures: none` | M |
| `color` + `alpha` × element `opacity` | `<a:solidFill><a:srgbClr val="RRGGBB"><a:alpha val="50000"/></a:srgbClr></a:solidFill>` | 6 hex digits; alpha integer 0…100000 ("50%" fails validation; Office writes integers, [MS-OI29500] 2.1.1329). LO renders it (measured) | H |
| `baseline: super|sub` | `baseline = round(shift/parentPx·100000)`, `shift = parent/3 + 1 px` (super) / `−(parent/5 + 1)` (sub); `sz` = parent size | Blink's rule, measured: raise 7.66 px / lower 5.00 px at 20 px, size ×1/1.2. PowerPoint draws a baseline-shifted run smaller than `sz`: LibreOffice's exporter says "MSO uses default ~58% size" and its importer renders at 58 %; the factor is not confirmed in PowerPoint. Authoring rule: `sup, sub { font-size: .58em }` so both sides agree. Do not inflate `sz` to compensate: LO (and likely PowerPoint) sizes the line box from `sz` (measured: ÷0.58 compensation pushed the LO baseline down ≈12 px) | M/L |
| `<br>` | `<a:br>` + copy of the preceding run's `rPr` | never `\n`/`\v` inside `a:t`; `a:br` has no `a:t` child | H |
| proofing | `dirty="0"`, no `err`, no `noProof` | `dirty` default true = re-check; `err` default false ([MS-OI29500] 2.1.1399 f; ECMA). Avoids squiggles on untouched text while keeping spell check for edits (L for the visual effect) | M |
| `smtClean` | omit | Office default true ([MS-OI29500] 2.1.1399 b) | H |
| text | `clean_text()`: drop XML-illegal C0 controls; strip trailing spaces at paragraph end / before `a:br` | trailing spaces hang in Chromium; PowerPoint's treatment at a hard end is unmeasured | H / L |

python-pptx + lxml (from `textmap.rpr_element`):

```python
r = _el("a:rPr", lang="ko-KR", altLang="en-US", sz=int(round(size_px * 75)), b="1" if face.bold else "0",
        i="1" if run["italic"] else None, u="sng" if run["underline"] else None,
        strike="sngStrike" if run["strike"] else None)
if run["letterSpacingPx"]:
    r.set("spc", str(int(round(run["letterSpacingPx"] * 75))))
r.set("dirty", "0")
fill = _sub(r, "a:solidFill"); clr = _sub(fill, "a:srgbClr", val=run["color"].upper())
if alpha < 0.999:
    _sub(clr, "a:alpha", val=int(round(alpha * 100000)))
for slot in ("a:latin", "a:ea", "a:cs"):
    _sub(r, slot, typeface=face.typeface)
```

---------------------------------------------------------------------------------------------------------------------

## 5. Korean line breaking

**What each engine does (evidence).**

* **PowerPoint** (defaults `eaLnBrk=1`, `latinLnBrk=0`, `hangingPunct=1`): breaks Hangul **between syllables inside
  words** and lets a terminal mark start a line — PowerPoint's own export (09_lecture_ko): "…가정 아래, 관 | 측된 …
  확률이 | 다.", "…뜻인가 | ?". **H** (*PPT-mac*). office2pdf measured that PowerPoint never pulls a Hangul syllable
  down for `? ! . , : ) ” …` (and full-width forms); `%` stays glued; on Windows the mark hangs past the margin
  (office2pdf #438/#515 notes). **M**
* Attribute semantics: `eaLnBrk` = apply East Asian line-breaking (kinsoku) rules ([MS-OI29500] 2.1.1406 c; the binary
  flag `charWrap` = "follows the East Asian text line breaking settings", [MS-PPT] 2.9.25); `latinLnBrk` = a word may
  split mid-word, Office default 0 ([MS-OI29500] 2.1.1406 g; binary `wordWrap` "TRUE: Text wraps at word breaks…
  FALSE: Characters of a word can be split"); `hangingPunct`, Office default 1. These three are the only wrap flags.
  Korean PowerPoint's UI has "한글 단어 잘림 허용" (Allow Korean text to wrap in the middle of a word, on by default);
  which of the flags it writes is **not confirmed** (a Korean tool sets `eaLnBrk="0" latinLnBrk="0"` for it; Korean-
  authored decks carry `latinLnBrk="1"` defaults).
* **Chromium**: `word-break: normal` breaks between Hangul syllables; `keep-all` only at spaces (measured, `exp/run3`).
* **LibreOffice 7.4**: breaks Hangul at spaces *and* at digit→Hangul boundaries ("2028 | 년까지", "1 | 조"), ignores
  `eaLnBrk`, maps `latinLnBrk` to hyphenation, and inserts Asian/Western autospacing (+8…9 % width on mixed text) —
  it cannot match either engine for Korean (LO only).

**Parity test on real PowerPoint breaks** (`exp/parity/`, the 7 wrapped paragraphs of the golden decks, Chromium with
the same fonts read in place, same size and available width):

| Chromium setting | paragraphs broken like PowerPoint |
|---|---|
| `word-break: normal` | **5/7** — the 2 misses are "…create legal **and** / brand risk." (PowerPoint's 1/8-pt advances make the line 0.3 pt too long) and "…뜻인 / **가?**" vs PowerPoint "…뜻인가 / ?" |
| `word-break: keep-all` | 4/7 — additionally misses the syllable break "관 / 측된" |
| PowerPoint break model (`pptbreak.simulate`) | **7/7** |

**Rule.** Slides use `word-break: normal` (the default), `overflow-wrap: normal`, `line-break: auto`,
`<html lang="ko">`; PPTX paragraphs get `eaLnBrk="1" latinLnBrk="0" hangingPunct="0"`. `hangingPunct="0"` because
Chromium never hangs punctuation and a hung mark protrudes past the box; the two residual behaviours (advance rounding,
terminal mark after Hangul) are removed by the wrap-width check (section 6) — both of the misses above have a
feasible width (+0.75 pt and −6.98 pt respectively). If designers want 어절 (word-level) wrapping (`keep-all`), emit
**hard breaks**: `<a:br/>` at every Chromium line end + `wrap="none"`; PowerPoint's own word-level mode for Hangul is
unverified. Hard breaks keep line composition in PowerPoint *and* LibreOffice but do not reflow on edit.

---------------------------------------------------------------------------------------------------------------------

## 6. Horizontal slack and width parity

**Chromium must use the font's advances.** Measured (`exp/adv_variants.*`, NanumGothic, 14–32 px, Korean/Latin/mixed):

| Chromium configuration | width vs font advances (HarfBuzz, no kerning) |
|---|---|
| default, deviceScaleFactor 1 | **−3.11 % … +1.54 %** (whole-pixel advances, e.g. 301 px vs 310.66 px) |
| default, deviceScaleFactor 2 | same (−3.11 % … +1.54 %) |
| `text-rendering: geometricPrecision` | +0.001 % … +0.004 % |
| launch flag `--font-render-hinting=none` | +0.001 % … +0.004 % |

→ base.css (or the extractor's launch args) must switch this on; otherwise wraps and centred positions drift by up to
3 %. **H** (CH)

**PowerPoint's advances**: every nominal advance snapped to 1/8 pt (= 1/576 in) before accumulation (office2pdf #661,
*PPT-mac*: `h,a,n,d` 9.452→9.500 pt, a 0.32 pt overflow flipped a wrap). Re-measured on the golden exports: PowerPoint
line spans vs HarfBuzz-kerned widths of the same font files **+0.10 % mean, sd 0.19 %, range −0.31…+0.51 %**
(146 lines; Malgun ±0.14 %). PowerPoint adds no Asian/Latin autospacing. For NanumGothic the 1/8-pt model is
−0.21…+0.26 % of the ideal width depending on size. **H/M**

**Rules.**

1. **Single-line / no-soft-wrap blocks**: `wrap="none"`, box width = `contentBox.w`, `algn` from the IR. No slack
   needed; alignment differences are ≤ (PPT width − CH width)/2 for `ctr`.
2. **Wrapping blocks with line texts** (IR extension): `textmap.choose_wrap_width_px` → `pptbreak.width_window`: for
   every paragraph, each Chromium line must fit (`W ≥ W_ppt(line)` without trailing spaces) and the next break unit
   must not (`W < W_ppt(line + next unit)`); intersect over paragraphs (add `marL`), pick the current width if inside,
   else the nearest edge ± 0.25 pt. Keep `x` fixed for `l`, the centre for `ctr`, the right edge for `r`. Empty
   window → hard breaks. On the golden paragraphs a window exists 7/7; 5 need no change, one +0.75 pt, one −6.98 pt.
   The embedded profile has the face file; the malgun profile needs Malgun's advances (not on the server — open risk).
3. **Without line texts** (current IR): `W = contentBox.w · max(1, r) + 0.25 px`, `r = W_ppt/W_ideal` of the
   paragraph text (`ppt_width_ratio`). This removes PowerPoint's systematic excess but leaves a few-% per-line chance of
   a different break (probability ≈ width error / break-unit width; one Hangul syllable ≈ 0.94 em).

---------------------------------------------------------------------------------------------------------------------

## 7. Constructs that make PowerPoint repair the file

Validator: Microsoft Open XML SDK 3.3.0 `OpenXmlValidator(FileFormatVersions.Microsoft365)` (build copied from the
shape-table lane, `validate.sh`). One defect per file (`exp/repair_variants.py`, results `exp/repair/validator.txt`).
Schema errors are what PowerPoint's strict parser rejects ("PowerPoint found a problem with content … repair"); the
validator is the closest local proxy (M: not every SDK error is proven to trigger the prompt, and vice versa).

| construct | SDK | note |
|---|---|---|
| valid reference text box (`00_good`), all experiment decks, `e2e.pptx` | 0 errors | |
| `txBody` without `a:p` | **error** | CT_TextBody requires ≥1 `a:p`; python-pptx raises `InvalidXmlError("p:txBody must have at least one a:p")` |
| `a:r` without `a:t` | **error** | |
| rPr child order (`latin` before `solidFill`; `ea` before `latin`) | **error** | |
| pPr child order (`buNone` before `lnSpc`) | **error** | |
| `endParaRPr` before a run | **error** | |
| `lnSpc` with both `spcPct` and `spcPts` | **error** | choice |
| `a:br` containing `a:t` | **error** | |
| `anchor="just"` / `"dist"` | **error** | Office does not allow them ([MS-OI29500] 2.1.1337) |
| percent strings: `alpha="50%"`, `buSzPct="100%"`, `spcPct="125%"`, `baseline="30%"` | **error** | Office reads "…%" but writes integers ([MS-OI29500] 2.1.1329/2.1.1344); the SDK's Office schema types them Int32 |
| `sz="50"`, `sz="1537.5"` | **error** | 100…400000 integer |
| `spc="500000"`, `kern="-1"`, `lvl="9"`, `marL="-9525"`, `spcPts="-100"`, `buSzPct="10000"` | **error** | ranges ±400000, ≥0, 0…8, ≥0, ≥0, 25000…400000 |
| `u="single"`, `strike="1"`, `wrap="wrap"` | **error** | enumerations |
| `srgbClr val="#111111"` / 8 digits | **error** | exactly 6 hex digits |
| two autofit children | **error** | |
| `b="true"`, negative insets, run without `rPr`, empty `typeface=""`, `indent` < −`marL` | valid | schema-valid but avoid: write `0/1`, insets ≥ 0, always `rPr`, a real typeface, clamp `indent ≥ −marL` |

Other rules: XML-illegal characters (C0 controls other than tab/LF/CR, U+FFFE/FFFF) must be removed before writing
`a:t` (lxml refuses them anyway); LF/VT become `a:br`.

---------------------------------------------------------------------------------------------------------------------

## 8. Empirical results (LibreOffice 7.4.7.2 vs Chromium; PowerPoint model where marked)

Reproduce: `cd scratch/text-mapping/exp && ../../../.venv/bin/python gen.py run3 && node measure_chromium.mjs run3 &&
./render_lo.sh scratch/text-mapping/exp/run3 && ../../../.venv/bin/python compare.py run3 && …/python hcompare.py run3`.
LibreOffice renders run in a throw-away container that removes Debian's NanumGothic so only the google/fonts copy used
by Chromium is visible.

* **Vertical** (table 2.6): LO follows its FixedCellHeight model within ±0.15 px; relative to Chromium it is −1.9…+10
  px depending on line-height, i.e. the builder's PowerPoint-targeted boxes preview lower in LO.
* **Horizontal**, single line, wrap none (`exp/run3/horizontal.txt`): CH = ideal ±0.004 % (geometricPrecision);
  LO −0.6…+0.3 % for pure Korean/Latin, **+8.4…+9.2 % for mixed Korean/Latin** (autospacing: "2026 년  3 분기",
  "추세이다 ."); `ctr`/`r` alignment in LO is correct relative to the box but moves by the width error (−54 px worst on
  a 32 px mixed line).
* **Wrapping**: English identical in CH and LO; Korean different in every paragraph (section 5).
* **Runs** (`exp/run3/runs-compare.png`): bold, synthetic italic, underline, strike, tracking, super/subscript,
  alpha all render in LO like CH (plus autospacing).
* **Bullets** (`exp/run3/bullets-compare.png`): positions identical, dot size differs (section 3).
* **End-to-end** (`exp/e2e/`: realistic slide → mini extractor → `textmap.py` → SDK 0 errors → LO), baseline errors
  in px (PPT = independent re-parse of the written XML with the 2.1 model):

  | element | CH baseline | PPT − CH | LO − CH |
  |---|---|---|---|
  | 40 px bold title, lh 1.2 | 98.00 | +0.00 | +0.68 |
  | 20 px subtitle, lh 1.4 | 147.00 | −0.00 | +3.01 |
  | 18 px paragraph, lh 1.6, lines 1/2/3 | 210.00 / 238.80 / 267.59 | 0.00 / −0.07 / −0.14 | +3.62 / +3.47 / +3.32 |
  | 18 px list (3 paragraphs, margins 8 px) | 349 / 384 / 419 | 0.00 / 0.00 / 0.00 | +2.2 (1st) |
  | 48 px KPI, lh 1.1, centred | 241.00 | +0.00 | −0.05 |
  | 14 px caption, right | 653.00 | +0.00 | +1.65 |

* **PowerPoint's own output** (office2pdf golden decks, Mac 16.111): line model 151/151 lines within 0.12 pt;
  widths +0.10 % ± 0.19 %; breaks 7/7 reproduced by `pptbreak`; bullets at `marL+indent`, text at `marL`.

---------------------------------------------------------------------------------------------------------------------

## 9. Changes this implies for other lanes (for the orchestrator)

* **Extractor / base.css** (mandatory for parity): `text-rendering: geometricPrecision` on `.slide` (or
  `--font-render-hinting=none`); `font-kerning: none`; `font-variant-ligatures: none`; `word-break: normal`;
  explicit `line-height` everywhere; `sup, sub { font-size: .58em }`; string list markers (`"• "`). Measure the IR
  with the same settings as the reference PNGs.
* **IR** (proposed extensions): `lines[i].paragraph` (index), `lines[i].text` (rendered text of the line incl.
  trailing spaces); `wrap` = false iff no soft wrap; `lineHeightPx` always resolved (no null); `indentPx` for bullets
  = −(marker string advance); lines of rotated elements in the unrotated frame; element `opacity` folds into run alpha.
* **fonts.json**: per face the usWin pair PowerPoint will use (`pptWinMetrics`), mandatory for the malgun profile
  (Malgun cannot be on the server). Font choice: google/fonts NanumGothic 3.020 lacks Ⅰ–Ⅹ, ①–⑤, ㈜, ℃ and Hanja (社)
  used by the Korean corpus (Chromium and PowerPoint then fall back to *different* fonts); Naver's 3.021 build has
  them (17,666 glyphs, fsType 8) but different metrics and the same family name — whichever is embedded, a user PC
  with the other NanumGothic installed may render with the installed one (open risk). Lint: every character must be in
  the face's cmap.

---------------------------------------------------------------------------------------------------------------------

## 10. Open risks (only real PowerPoint can confirm)

| # | risk | confidence in the chosen rule |
|---|---|---|
| 1 | The line model (1.2 em, usWin share, mark rule) is re-verified on PowerPoint **for Mac** output; Windows evidence is third-party (office2pdf #485/#513, 3 fonts × 3 sizes × 3 anchors, raw files unpublished) | **M-H** |
| 2 | `spcPct` regimes (≤100 % top-resized; >100 % seat 0.9·pct·S; whole-percent rounding) measured on Mac only | **M** |
| 3 | `spcPts` first-baseline placement unmeasured anywhere (hence not used for line spacing) | L (avoided) |
| 4 | Whole-point baseline rounding: Mac export rounds within the story; Windows appears not to; ±0.5 pt either way | M |
| 5 | Korean breaking on **Windows** PowerPoint with `lang="ko-KR"` runs is assumed equal to the Mac export (runs tagged en-US there); the "한글 단어 잘림 허용" ↔ XML mapping is unconfirmed; Windows hangs terminal marks while Mac breaks before them | **M** |
| 6 | 1/8-pt advance rounding measured on Mac exports; assumed identical on Windows (it is PowerPoint's master unit) | M |
| 7 | Super/subscript size: PowerPoint's automatic reduction (~58 % per LibreOffice) unconfirmed; whether the line box uses the declared `sz` | L-M |
| 8 | Whether the bullet font participates in line 1's share (avoided by `buFont` = text face) | M |
| 9 | Justified text (`just`) for Korean and before `a:br`; lines ending with `a:br` in hard-break mode | L (avoid justify) |
| 10 | Font identity: an installed NanumGothic of another build on the user's PC may override the embedded one (metrics and advances differ) | M (risk real) |
| 11 | `kern` absent ⇒ no kerning is per [MS-OI29500]; relying on template sanitising | H |
| 12 | `dirty="0"` suppressing proofing marks on open | L |
| 13 | LibreOffice previews (Noah) will differ: text up to 3.6 px lower, mixed Korean/Latin 8–9 % wider (autospacing, not controllable from PPTX in 7.4), Korean wrapped differently — expected, not a PowerPoint defect | H (measured) |

---------------------------------------------------------------------------------------------------------------------

## Sources

Primary specifications
* ECMA-376 Part 1 (5th ed., 2016) §21.1.2.1.1–21.1.2.4.x (bodyPr, autofit, lnSpc, pPr, spcBef/Aft, spcPct/Pts, rPr,
  latin/ea/cs, bullets) and the transitional `dml-main.xsd` — https://ecma-international.org/publications-and-standards/standards/ecma-376/
  (local text: `src/ecma376-1.txt`, `src/dml-main.xsd`).
* [MS-OI29500] notes (https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/…):
  2.1.1379 bodyPr `b3da041f-d56f-464b-a9b3-2e3274de9caf`; 2.1.1380 noAutofit `56ab6d15-2c9a-4d77-bc6b-3d8a7d98ebf3`;
  2.1.1382 spAutoFit `ed53fa9e-9351-449d-a926-f994efb77a57`; 2.1.1383 defPPr `18292376-7677-4792-8422-8024b97ec52f`;
  2.1.1386 lnSpc `4e043105-2ae4-4b85-baa8-4324ca7a6367`; 2.1.1388 pPr `3bf4b4b9-d1cd-4610-be56-9427e22c5fb4`;
  2.1.1406 lvl1pPr (marL/indent/eaLnBrk/hangingPunct/latinLnBrk/defTabSz) `9b34280e-538e-4811-8af9-761d34f88f20`;
  2.1.1397 latin `e6784cb7-1547-4ee5-addc-730cac8b4d00`; 2.1.1399 rPr (kern, smtClean, baseline, sz, noProof)
  `953e072c-f234-4373-b017-3f1f71eac93b`; 2.1.1404 buSzPct `7d31ebc1-a52e-4e29-975b-99e32babe803`;
  2.1.1329 ST_Percentage `ff18a37e-9bd7-4338-9c37-1e285b5a5dd2`; 2.1.1337 ST_TextAnchoringType
  `86ec6af2-eea6-46a0-9d1e-b2c640d0b129`; 2.1.1344 ST_TextSpacingPercentOrPercentString
  `c4a93e8e-6a08-4e53-b183-75282751b959`; 2.1.1346 ST_TextUnderlineType `94ad7a5d-0d0a-4e7c-926e-3dca76cde068`.
  (All extracted verbatim to `src/oi29500/notes-clean.txt`.)
* [MS-PPT] 2.9.25 PFWrapFlags https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-ppt/4f9ab039-9270-4588-b33f-9d580a117a8f ;
  2.9.3 KinsokuAtom …/f4aeb62d-db31-48ed-9ab7-6369697a62b7 ; 2.9.20 TextPFException …/c15a13b3-db2c-4b50-a7e6-08045581a663
* Microsoft Support: "English text may wrap unexpectedly in the middle of a word in the Korean version of PowerPoint"
  https://support.microsoft.com/en-us/topic/english-text-may-wrap-unexpectedly-in-the-middle-of-a-word-in-the-korean-version-of-powerpoint-16bb477b-a502-c6ba-5da3-daf210a15894

Native-PowerPoint measurements and interoperating code
* office2pdf (developer0hye): golden mocks with native PowerPoint exports
  https://github.com/developer0hye/office2pdf/tree/main/tests/golden_mocks/business (README states the PDFs are
  "exported by the corresponding native Microsoft Office application"; producer = macOS Quartz, app PowerPoint 16);
  line model sources `crates/office2pdf/src/render/pdf.rs` (powerpoint_line_box_split_em), `render/typst_gen_text.rs`
  (percentage regimes, advance grid, ligatures), `parser/pptx_text.rs` (paragraph mark, a:br, Hangul kinsoku);
  issues #438, #485, #513, #661, #702, #1074, #1118, #1176, #1177, #1254 (https://github.com/developer0hye/office2pdf/issues/N).
* office-open-xml-viewer PR #1475 https://github.com/yukiyokotani/office-open-xml-viewer/pull/1475 (1.2× pitch vs
  PowerPoint PDFs).
* betteroffice PR #810 https://github.com/openooxml/betteroffice/pull/810 (centring rule; not PowerPoint-validated).
* LibreOffice core (7.4 branch, https://raw.githubusercontent.com/LibreOffice/core/libreoffice-7-4/…):
  `editeng/source/editeng/impedit3.cxx` (line-spacing rules, ImplCalculateFontIndependentLineSpacing),
  `oox/source/ppt/pptshapecontext.cxx` (FontIndependentLineSpacing for PPTX txBody),
  `oox/source/drawingml/textparagraphpropertiescontext.cxx` (eaLnBrk ignored, latinLnBrk→ParaIsHyphenation,
  hangingPunct), `oox/source/drawingml/textcharacterproperties.cxx` (baseline → escapement 58 %),
  master `oox/source/export/drawingml.cxx` ("MSO uses default ~58% size"); commit tdf#165521
  https://www.mail-archive.com/libreoffice@lists.freedesktop.org/msg353479.html
* python-pptx 1.0.2 `pptx/oxml/text.py` (txBody must have at least one a:p; add_textbox defaults).
* Korean usage of "한글 단어 잘림 허용": https://woongheelee.com/entry/파워포인트-모든-페이지에서-한글-단어-잘림-해결하기 ,
  https://embginger.co.kr/ppt-가독성-향상-한글-단어-잘림-방지-단락-간격-변경/ ; XML use of eaLnBrk/latinLnBrk:
  https://github.com/soohyun9953/healthy-project/pull/4 (AI-generated, not authoritative).
* Fonts: https://github.com/google/fonts/tree/main/ofl/nanumgothic (3.020); Debian `fonts-nanum` (Naver 3.021) in
  the `pptx-poc-lo` image.

Local artefacts: `analyze_golden.py`, `verify_ppt_model.py`, `golden_advances2.py`, `golden-lines.json`,
`exp/gen.py`, `exp/measure_chromium.mjs`, `exp/render_lo.sh`, `exp/compare.py`, `exp/hcompare.py`,
`exp/adv_variants.mjs`, `exp/parity/`, `exp/repair/`, `exp/e2e/`, `textmap.py`, `pptbreak.py`, `validate.sh`.
