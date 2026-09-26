# Shape / picture / table / background mapping — HTML (Chromium) → native PPTX

> **Historical PoC evidence, preserved for maintainers — not agent-facing.** Written in the HTML→PPTX
> proof of concept before its port into Noah (2026-09) and copied here unchanged below this note. Paths such
> as `scratch/…`, `tools/…`, `out/…`, `fonts/…`, `theme/…`, `slides/…`, `docs/…` and `$POC` refer to that PoC
> tree, and machine paths (`/home/jinyoung/…`, `/mnt/c/Windows/Fonts`) to its dev box — Windows fonts were
> only ever READ in place there, never copied. The shipped converter is `default-skills/skills/pptx/converter/`;
> see [`docs/architecture/pptx-converter.md`](../../architecture/pptx-converter.md) and
> [the index of this directory](../README.md).

Status: **FINAL (v3, 2026-09-25)**. Owner: this file + `scratch/shape-table/`.
Reference implementation of everything below: **`scratch/shape-table/stlib.py`** (IR dict → DrawingML via
python-pptx 1.0.2 + lxml). Reusable output lint: **`scratch/shape-table/selftest.py`**. Microsoft's validator
wrapper: `scratch/shape-table/validate.sh` (Open XML SDK 3.3.0, `FileFormatVersions.Microsoft365`).

| tag | meaning |
|---|---|
| **[SPEC]** | ECMA-376 / ISO 29500 schema text, [MS-OI29500], [MS-ODRAWXML], or an official Microsoft answer |
| **[SRC]** | read in the source of Chromium, LibreOffice, python-pptx, Apache POI or Microsoft's Open XML SDK samples |
| **[V-LO]** | measured here in LibreOffice 7.4.7.2 (`pptx-poc-lo`) against a Chromium render — evidence about LibreOffice / Noah's preview only, **not** about PowerPoint |
| **[V-SDK]** | checked here with Microsoft's Open XML SDK validator |
| **[INF]** | reasoned inference |
| **[RISK Rn]** | unproven for Windows PowerPoint — see §10 (with confidence) |

## 0. Builder checklist (the rules that matter most)

1. Remove `p:style` from every `p:sp` python-pptx creates, and always write an explicit fill, an `a:ln` **with** a line fill,
   and an `a:effectLst` (empty = no shadow). python-pptx's default style drags in a theme gradient fill, a 0.75 pt accent
   line and a theme shadow; LibreOffice even ignores the empty `effectLst` while `p:style` is present (§2.1).
2. Inset the geometry by half the border width and shrink the radius by the same amount; a DrawingML line is centred on
   the path, a CSS border lies inside the box (§2.4). Always write `<a:miter lim="800000"/>` — the default join is round.
3. `roundRect adj = round(100000·r / min(w,h))`, clamped to [0, 50000] (§2.2).
4. Linear gradient: `a:lin ang = (cssAngle − 90°)·60000 mod 21600000`, `scaled="0"`, `gs pos = stop·100000`,
   `rotWithShape="1"`; resolve `to <corner>` with the box size; never use python-pptx `gradient_angle` (§2.3).
5. Shadow: `blurRad = emu(blurPx)`, `dist = emu(hypot(ox,oy))`, `dir = atan2(oy,ox) + rotation`, `rotWithShape="0"`,
   no `sx/sy` (spread is not representable) (§2.5).
6. Tables: tableStyleId `{2D5ABB26-0587-4C30-8999-92F81FD0307C}`, no `bandRow`/`firstCol`/`lastRow`/`lastCol`/`bandCol`;
   `firstRow="1"` only to mark a header row of `<th>` cells (fixer round 2, §5.1 note); build `a:tcPr` in schema order
   `lnL lnR lnT lnB … fill`; write each grid-edge border on both neighbours; margins = padding + half border; exact line
   spacing and an `endParaRPr@sz` in every cell paragraph; `a:tr@h` = Chromium row pitch (§5).
7. Pictures: `alphaModFix amt < 100000`, inserted before `a:blip/a:extLst`; SVG = PNG `r:embed` + `asvg:svgBlip` ext (§4).
8. Everything integer, 6-hex colours, no negative extents/distances; run `selftest.py` + `validate.sh` on every build (§6).

---

## 1. Units, number formats, colours

| quantity | rule | source |
|---|---|---|
| length | EMU = round(px × 9525), integer, no unit suffix | contract; [SPEC MS-OI29500 2.1.1319/2.1.1320: Office writes only EMUs] |
| length range | Office restricts ST_Coordinate to int32 and ST_PositiveCoordinate to ≤ 2147483647 | [SPEC MS-OI29500 2.1.1319, 2.1.1330] |
| angle | ST_Angle = 1/60000°, integer; `xfrm@rot` is **clockwise** in Office | [SPEC MS-OI29500 2.1.1283a] |
| positive angle (`lin@ang`, `outerShdw@dir`) | 0 ≤ v < 21600000 → always `mod 21600000` | [SPEC dml-main.xsd ST_PositiveFixedAngle; V-SDK `dir=21600000` rejected] |
| percentage | integer 1/1000 % (50 % → `50000`) | [SPEC MS-OI29500 2.1.1218b, 2.1.1329, 2.1.1332: Office writes only integers]; [V-SDK `"50%"` rejected as not Int32] |
| colour | `<a:srgbClr val="RRGGBB"/>` — exactly 6 hex digits (ST_HexColorRGB = hexBinary, length 3) | [SPEC; V-SDK: 8 digits, `#`, 3 digits all rejected] |
| colour alpha | child `<a:alpha val="round(alpha·100000)"/>`, omit when 1 | [SPEC EG_ColorTransform; V-SDK 150000 rejected] |

IR `opacity` multiplies every alpha the element emits (fill stops, line, shadow; `alphaModFix` for pictures). CSS
`opacity` composites the element as one group; per-object alpha does not, so where a translucent element's own line
overlaps its fill the result differs slightly [INF] (see the split rule, §2.4).

```python
EMU_PER_PX = 9525
def emu(px):     return int(round(px * EMU_PER_PX))
def ang60k(deg): return int(round((deg % 360.0) * 60000)) % 21600000
def pct1000(f):  return max(0, min(100000, int(round(f * 100000))))
```

---

## 2. Shapes (`kind: "shape"`)

### 2.1 Skeleton and the python-pptx `p:style` trap

`slide.shapes.add_shape()` emits `<p:style><a:lnRef idx="1"/><a:fillRef idx="3"/><a:effectRef idx="2"/>
<a:fontRef idx="minor"/></p:style>` (all `accent1`) [SRC `pptx/oxml/shapes/autoshape.py new_autoshape_sp`]. In
python-pptx's default theme these resolve to a 9525-EMU accent line, a **gradient** fill (`fillStyleLst[2]`,
`lin ang=16200000`) and an **outer shadow** (`effectStyleLst[1]`: `blurRad=40000 dist=23000 dir=5400000`, black 35 %)
[SRC `pptx/templates/default.pptx` theme1.xml]. [MS-OI29500] §20.1.8 note a: a missing fill/line/effect in `spPr` is
inherited from the style link; "*Even a valid empty element will block the inheritance. For example, an empty effect
list will not be merged with an inherited effect list*" [SPEC].

Observed in LibreOffice 7.4 (`out/lo-probe/page-3.png`) [V-LO]: python-pptx default + solid fill → accent outline
(74,126,187) **and** theme shadow; `line.fill.background()` removes the outline, shadow stays; adding
`shape.shadow.inherit = False` (empty `<a:effectLst/>`) **still shows the shadow** — LibreOffice does not honour the
blocking rule. With `p:style` removed and nothing else, the shape is invisible (hard-coded defaults `noFill`).

**Rule:** delete `p:style` (optional, `minOccurs=0` in CT_Shape [SPEC pml.xsd]) *and* write fill + `a:ln` (with a
line-fill child) + `a:effectLst` explicitly. Text never goes into these shapes (IR text → `add_textbox`, no style).

Order inside `p:spPr`: `a:xfrm` → `a:prstGeom` → fill → `a:ln` → `a:effectLst` → `a:scene3d` → `a:sp3d` → `a:extLst`;
inside `a:ln`: line fill → `a:prstDash`/`a:custDash` → `a:round`/`a:bevel`/`a:miter` → `a:headEnd` → `a:tailEnd` →
`a:extLst` [SPEC dml-main.xsd; V-SDK both violations rejected].

```xml
<p:sp>
  <p:nvSpPr><p:cNvPr id="13" name="s12-border8-r32"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
  <p:spPr>
    <a:xfrm><a:off x="2800350" y="2990850"/><a:ext cx="2019300" cy="971550"/></a:xfrm>
    <a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 27451"/></a:avLst></a:prstGeom>
    <a:solidFill><a:srgbClr val="EDE9FE"/></a:solidFill>
    <a:ln w="76200" cap="flat" cmpd="sng" algn="ctr">
      <a:solidFill><a:srgbClr val="7C3AED"/></a:solidFill>
      <a:prstDash val="solid"/>
      <a:miter lim="800000"/>
    </a:ln>
    <a:effectLst/>
  </p:spPr>
  <p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/></a:p></p:txBody>
</p:sp>
```

(That is `s12`: CSS box 290,310 220×110, radius 32, 8 px border → geometry 294,314 212×102, radius 28 →
adj = 28/102 = 27451. `p:txBody` is optional; python-pptx always writes one — harmless.)

### 2.2 Geometry

- **rect** → `prst="rect"`. **ellipse** → `prst="ellipse"`. CSS `border-radius: 50%` resolves horizontal radii against
  the width and vertical radii against the height, so it is an exact ellipse on *any* box [SPEC css-backgrounds-3 §5];
  Chromium reports it as `"50%"` [V: computed style probe].
- **roundRect** → `prst="roundRect"` + `<a:gd name="adj" fmla="val N"/>`. Preset definition (ECMA-376 Part 1
  presetShapeDefinitions.xml; copy at `scratch/shape-table/presetShapeDefinitions.xml`): `a = pin 0 adj 50000`,
  `x1 = */ ss a 100000` (ss = min(w,h)), four `arcTo wR=x1 hR=x1` quarter circles; default adj 16667 [SPEC]. So the
  corner radius is `min(w,h)·adj/100000` with a hard maximum `min(w,h)/2`. CSS clamps over-large radii with
  `f = min(Li/Si)`; for a uniform radius that is `min(r, min(w,h)/2)` [SPEC css-backgrounds-3 §4.5] — the same saturation.

```python
def round_rect_adj(r_px, w_px, h_px):          # w,h,r of the geometry actually emitted (after §2.4 inset)
    ss = min(w_px, h_px)
    return 0 if ss <= 0 or r_px <= 0 else max(0, min(50000, int(round(r_px / ss * 100000))))
```

  Chromium does not clamp in computed style (`border-radius: 9999px` → `"9999px"`), so the builder clamp matters.
  Verified [V-LO]: the r = 24 corner's first filled pixel per row matches the circle within ≤ 2 px on the anti-aliased
  first row and exactly below it; the 9999 px pill and the r = 80 on 200×60 clamp render as full semicircles.
- Not representable by `roundRect` → lint: elliptical radii (`20px/10px` → computed `"20px 10px"`), per-corner radii,
  percentage radii other than 50 %.
- `a:off`/`a:ext` = box in EMU; `cx/cy ≥ 0` [SPEC; V-SDK negative `cx` rejected].

### 2.3 Fill

Solid: `<a:solidFill><a:srgbClr val="2563EB"><a:alpha val="50000"/></a:srgbClr></a:solidFill>`
[V-LO: 50 % 2563EB over F1F5F9 → 138,171,241 vs expected 139,172,242; over black → 18,49,117 vs 18,50,118].

**Linear gradient — the two conventions.**

- *CSS* (css-images-3 §3.1.1): angle A, "0 degrees points upwards and positive angles represent clockwise rotation";
  gradient line through the centre with length **`abs(W * sin(A)) + abs(H * cos(A))`**, so 0 %/100 % are where the
  perpendiculars through two opposite corners cross it; constant-colour lines ⟂ the line; stop positions are fractions of
  that length; W × H is the *background positioning area* (padding box by default) [SPEC].
- *OOXML* `a:lin@ang` (ECMA §20.1.8.41): "let its value be x measured clockwise. Then ( -sin x, cos x ) is a vector
  parallel to the line of constant color" → direction (cos x, sin x) in y-down space; 0 = left→right, 5400000 =
  top→bottom [SPEC]. Range: Mike Bowen (Microsoft), 2025-04-17: "*The gradient is interpolated between a range calculated
  from the rotation angle and the anchor rectangle bounds … For a rectangular shape, where the shape path is the same as
  the anchor rectangle, all of the gradient colors appear in the shape … When a linear gradient is applied to other
  shapes, the effect appears as if the shape was a stencil used to crop out the rectangular gradient.*" His 45° figure
  (`scratch/shape-table/src/ms-linear-gradients.png`) shows iso-lines at 45° in slide space on a ~3.3:1 box and range
  limits through the top-left and bottom-right corners [SPEC MS Q&A 2248059]. [MS-OI29500] 2.1.1297b: the gradient
  "encompasses the entire bounding box" [SPEC]. → with `scaled="0"` the range is `|w·cos x| + |h·sin x|`, **the CSS
  expression** with x = A − 90°.
- `scaled="1"`: gradient defined in the unit square and stretched; Microsoft confirmed (2025-05-28) the vector is
  `(h·cos x, w·sin x)` — the ISO text `(w cos x, h sin x)` is an erratum [SPEC MS Q&A 2265121]. That equals CSS *corner
  keywords* (`to bottom right` puts the 50 % line on the other diagonal), not explicit angles. Default `scaled` = false
  [SPEC MS-OI29500 §20.1.8 note a]; PowerPoint has no UI for it (Bowen).

**Mapping (always `scaled="0"`):**

```python
ooxml_ang = ang60k(css_deg - 90.0)              # 180deg→5400000, 90deg→0, 135deg→2700000, 0deg→16200000
def css_corner_to_angle(corner, w, h):          # Chromium keeps keywords: "to right bottom"
    t = math.degrees(math.atan2(h, w))
    return {"top right": t, "bottom right": 180 - t, "bottom left": 180 + t, "top left": 360 - t}[corner]
```

```xml
<a:gradFill rotWithShape="1">
  <a:gsLst>
    <a:gs pos="0"><a:srgbClr val="F43F5E"/></a:gs>
    <a:gs pos="100000"><a:srgbClr val="FBBF24"/></a:gs>
  </a:gsLst>
  <a:lin ang="2700000" scaled="0"/>
</a:gradFill>
```

Verified [V-LO]: 11 samples along the gradient line of 90deg (220×110), 135deg on a 400×110 box and `to bottom right`
on 400×110 (resolved 164.62°) all within **1/255** of Chromium; the `135deg` slide background on 1280×720 is within 1/255 at 6 spot samples.

Stops: `pos = round(p·100000)` in [0, 100000], ≥ 2 stops [SPEC; V-SDK 1 stop and 100001 rejected]. CSS stops may be
outside [0,1] (Chromium keeps `120%`): clip by interpolating at the boundary and add explicit 0/1 end stops (CSS paints
the end colours beyond the list). Equal positions = hard edge (Regina Henschel's PowerPoint test file uses
`pos="40000"` twice and she reports PowerPoint renders it correctly) [SPEC-adjacent, MS Q&A 2265121]; **LibreOffice 7.4
smooths hard stops / multi-stop gradients** (s10: up to 128/255 off) [V-LO] — a Noah-preview limitation.
Transparent stops: CSS interpolates in **premultiplied** sRGB [SPEC css-images-3]; PowerPoint's interpolation space is
undocumented [RISK R3] → give an alpha-0 stop the RGB of its non-transparent neighbour (split into two co-located stops
when the neighbours differ) and do boundary interpolation premultiplied (`stlib._fix_transparent_stops/_clip_stops`).
`rotWithShape="1"` so a rotated shape rotates its gradient like CSS (Office base default too) [SPEC; V-LO s17].
Never `a:path`/`a:tileRect` (Bowen: custom tileRect is buggy). Do not use python-pptx `fill.gradient_angle` — it is
counter-clockwise (`90` writes `ang="16200000"`) and `fill.gradient()` seeds theme colours [SRC `pptx/dml/fill.py`].

### 2.4 Line (CSS border) and the centre-line offset

A DrawingML line is centred on the path (`algn="ctr"`, Office's default; `in` exists but is not portable)
[SPEC MS-OI29500 2.1.1212a, 2.1.1328]; a CSS border lies inside the border box. Emit the geometry inset by bw/2:

```python
i = bw / 2
geom = (x + i, y + i, w - bw, h - bw);  radius = max(0, r - i)     # outer edge r, inner edge r - bw (CSS)
```

```xml
<a:ln w="{emu(bw)}" cap="flat" cmpd="sng" algn="ctr">
  <a:solidFill><a:srgbClr val="0F172A"/></a:solidFill>
  <a:prstDash val="solid"/>
  <a:miter lim="800000"/>
</a:ln>
```

Verified [V-LO]: 8 px border on 40,310 220×110 → dark band x 40–48 and y 310–318 in both renders, sharp corners.
`a:miter` is required: Office's base default join is round [SPEC MS-OI29500 §20.1.8 note a "join (round)"], and
LibreOffice with `a:round` *or with no join element* rounds a 16 px border's outer corner (corner pixel white vs black
with `miter`) [V-LO `out/lo-join`]. `w` ≤ 20116800 [SPEC; V-SDK]. **No border** → `<a:ln><a:noFill/></a:ln>`: never
`w="0"` (Office: "*a resolution-dependent line thickness of 1 device unit*" — LibreOffice draws the 1 px red hairline
[V-LO]) and never an `a:ln` without a fill child (Office: "*assumes the line fill to be `<solidFill>`*"; LibreOffice draws
nothing — the two diverge) [SPEC MS-OI29500 2.1.1212e/f, 2.1.1326].

Dashes. Chromium: `dashed` → dash 2·w / gap ≈ 1·w when w ≥ 3 px, 3·w / 2·w when w < 3, gap re-fitted per side;
`dotted` → 1·w squares for w ≤ 3, round dots at ≈ 2·w pitch for w > 3 [SRC blink `styled_stroke_data.cc`]. DrawingML
presets (multiples of w): `dash` 4:3, `sysDash` 3:1, `dot` 1:3, `sysDot` 1:1, `lgDash` 8:3 [SPEC]. Use:

| CSS | DrawingML |
|---|---|
| `dashed`, w ≥ 3 | `<a:custDash><a:ds d="200000" sp="100000"/></a:custDash>` |
| `dashed`, w < 3 | `<a:custDash><a:ds d="300000" sp="200000"/></a:custDash>` |
| `dotted`, w ≤ 3 | `<a:prstDash val="sysDot"/>` |
| `dotted`, w > 3 | `cap="rnd"` + `<a:prstDash val="sysDot"/>` (PowerPoint's own "Round Dot") |

[V-LO `out/cmp/zoom-dash-dot.png`]: same density and dot size; the phase differs (Chromium anchors a dash on each corner,
DrawingML runs one pattern from the path start, so corners are not always covered and one dash/dot doubles where the
pattern wraps) — low visual impact [RISK R7].

**Split rule.** One shape (fill on the inset geometry + centred line) is exact for an opaque line with a solid fill. Emit
two shapes in paint order — fill-only (no line) then line-only (`a:noFill` fill, inset geometry) — when (a) the line
alpha < 1 (CSS paints the background under the whole border band; the inset fill leaves the outer half uncovered), fill
shape = border box; or (b) the fill is a gradient and there is a border (CSS sizes the gradient to the padding box), fill
shape = padding box, radius r − bw [INF; V-LO s18/s19 match]. `stlib.add_shape(split_policy="auto")` does this.

### 2.5 Outer shadow (CSS `box-shadow`)

```xml
<a:effectLst>
  <a:outerShdw blurRad="{emu(blurPx)}" dist="{emu(hypot(ox,oy))}" dir="{ang60k(atan2(oy,ox)° + rotationDeg)}"
               algn="ctr" rotWithShape="0">
    <a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr>
  </a:outerShdw>
</a:effectLst>
```

- `dist` = offset length, `dir` = its direction clockwise from +x in y-down space (0 right, 5400000 down); both unsigned
  — an up/left shadow is expressed through `dir`, never a negative `dist` [SPEC; V-SDK negative dist rejected; SRC LO
  `effectproperties.cxx` x = cos(dir)·dist, y = sin(dir)·dist]. [V-LO] a 12,12,0 hard shadow lands on x 490–502 /
  y 550–562 in both renders.
- `blurRad`: CSS blurs with a Gaussian of **σ = blur/2** [SPEC css-backgrounds-3 §6.1.2]; Chromium:
  `BlurRadiusToStdDev(radius) = radius * 0.5` [SRC blink `shadow_data.h`]. DrawingML only says "blur radius"; Microsoft
  does not document the kernel. Use `blurRad = emu(blurPx)`. [V-LO] LibreOffice (import code written for Office interop:
  `blurRad` → its shadow blur radius unchanged, bounds grown by that radius) produced a falloff whose fitted σ is 12.1 px
  for a 24 px CSS blur, vs 13.0 px fitted on Chromium (CSS predicts 12) — visually identical. PowerPoint's softness per
  EMU is **[RISK R1]**; if the Windows overlay check shows a mismatch, it is one constant (`blurRad = k·blurPx`).
- `rotWithShape`: CSS offsets are in the element's rotated local space. Office would rotate `dir` with `rotWithShape="1"`,
  but **LibreOffice 7.4 ignores `rotWithShape`** (parsed only for round-trip, never applied) [SRC
  `effectpropertiescontext.cxx`, `effectproperties.cxx`; V-LO s17 shadow went straight down]. Portable encoding:
  pre-rotate `dir` by the element rotation and write `rotWithShape="0"` — then LibreOffice matches Chromium exactly
  (`out/cmp/zoom-rot15-v2.png`) [V-LO], and PowerPoint, which keeps a `rotWithShape="0"` shadow page-aligned by
  definition, draws the same [SPEC ECMA §20.1.8.49 semantics; RISK R2].
- `sx`/`sy` must stay 100 %: "*If the parent element of the effectLst element that contains the outerShdw is an spPr
  element, the shadow will only be rendered if the sx and sy attribute values are 100%*" [SPEC MS-OI29500 2.1.1303a]
  → CSS **spread cannot be emulated** by scaling; spread ≠ 0 → lint warn (drop, or emit an enlarged caster shape).
  `algn="ctr"` is then irrelevant but harmless.
- Semantics gap: CSS casts the shadow "*as if the border-box of the element were opaque … clipped inside the
  border-box*" [SPEC css-backgrounds-3 §6.1.1]; DrawingML derives it from the rendered alpha. A translucent fill shows its
  shadow through itself, a no-fill bordered box casts only an outline shadow → lint warn box-shadow on elements with fill
  alpha < 1 or no fill. Only the first outer shadow is mapped (contract); `innerShdw` is out of scope.

### 2.6 z-order, ids, names

- z-order = document order in `p:spTree` (first = back). IR elements are back→front → append in order.
- `p:cNvPr@id`: required, unique per slide; python-pptx assigns `max(id)+1` [SRC `pptx/shapes/shapetree.py`]. ECMA:
  "*If multiple objects within the same document share the same @id value, then the document shall be considered
  non-conformant*" [SPEC ECMA cNvPr]; "*Office treats the ST_DrawingElementId type as a signed 32-bit integer*" [SPEC
  MS-OI29500 2.1.1321] → ids in 1 … 2147483647. The SDK does **not** catch duplicates, 0 or 3 000 000 000 (only
  > 2^32 − 1) [V-SDK] — enforce it in the builder (`selftest.lint`). PowerPoint's reaction to duplicates: [RISK R9].
- `@name` is required [V-SDK missing name rejected], need not be unique; use the IR id so a user finds objects in the
  Selection Pane; alt text → `@descr`.

### 2.7 Rotation

`<a:xfrm rot="{ang60k(rotationDeg)}">` — clockwise in Office [SPEC MS-OI29500 2.1.1283a], same sense as CSS `rotate()`;
`a:off/a:ext` = the unrotated box, rotated about its centre [SPEC ECMA §20.1.7.6]. Chromium reports rotation as
`matrix(a,b,c,d,…)` → `atan2(b, a)`; with a non-centre `transform-origin` the extractor must move the box so its centre
equals the rendered centre. [V-LO] s17 (15°) overlays Chromium. **Tables cannot rotate**: "*In Office, attributes flipH,
flipV and rot are ignored when applied to a graphicFrame*" [SPEC MS-OI29500 2.1.1283b] → rotated `<table>`/chart = lint
error (the SDK accepts the attribute [V-SDK]).

---

## 3. Slide background

```xml
<p:cSld>
  <p:bg><p:bgPr>
    <a:gradFill rotWithShape="1"><a:gsLst>…</a:gsLst><a:lin ang="2700000" scaled="0"/></a:gradFill>   <!-- or a:solidFill -->
    <a:effectLst/>
  </p:bgPr></p:bg>
  <p:spTree>…
```

- `p:bg` precedes `p:spTree`; `p:bgPr` needs one fill then optional effects [SPEC pml.xsd; V-SDK both violations
  rejected]; no `grpFill` [SPEC MS-OI29500 2.1.1119].
- python-pptx: `slide.background.fill.solid()` creates `<p:bg><p:bgPr><a:noFill/><a:effectLst/>` [SRC
  `pptx/oxml/slide.py`]; then replace the fill child (stlib `set_background`) — for gradients write the §2.3 XML; the
  gradient box is the slide (12192000 × 6858000 EMU), same as CSS on `.slide`. [V-LO] solid and 135deg gradient
  backgrounds match Chromium.
- Alpha: pre-composite over white and write an opaque colour (Chromium composites the page over a white canvas) [INF].

---

## 4. Pictures

### 4.1 PNG at a box

`pic = slide.shapes.add_picture(png, emu(x), emu(y), emu(w), emu(h))` → `p:pic` with `a:blip r:embed`,
`a:stretch/a:fillRect`, `a:picLocks noChangeAspect="1"`, `prstGeom rect`; pass both width and height (the IR PNG is a
4× raster). Rotation `pic.rotation = deg`; alt text `pic._element.nvPicPr.cNvPr.set("descr", alt)`. [V-LO] an RGBA PNG
(translucent circle + opaque square) matches Chromium.

### 4.2 Transparency (overlay variant; IR `opacity` < 1)

```xml
<a:blip r:embed="rId3"><a:alphaModFix amt="50000"/></a:blip>
```

```python
blip = pic._element.blipFill.find(qn("a:blip"))
amf = etree.Element(qn("a:alphaModFix")); amf.set("amt", str(min(99999, pct1000(alpha))))
ext = blip.find(qn("a:extLst"))
ext.addprevious(amf) if ext is not None else blip.append(amf)       # CT_Blip: effects before a:extLst
```

"*Office modulates the alphaModFix value, so the value is interpreted as value modulo 100*" [SPEC MS-OI29500 2.1.1287]
→ never `amt ≥ 100000`; omit for opacity 1. [V-LO] red over white: 25 % → 254,189,189; 50 % → 254,125,125; 99.999 % →
254,3,3; `amt="100000"` renders opaque in LibreOffice (so LibreOffice and Office may disagree exactly there). The SDK
accepts `amt="100000"` and rejects `alphaModFix` after `a:extLst` [V-SDK].

### 4.3 Native SVG with PNG fallback

Exact structure used by Microsoft's own Open XML SDK sample (`samples/Linq/SvgExample/LinqToXmlTools.cs`) and by Apache
POI `XSLFPictureShape.setSvgImage` [SRC]:

```xml
<p:pic>
  <p:nvPicPr>
    <p:cNvPr id="9" name="p02-svg" descr="svg icon"/>
    <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
    <p:nvPr/>
  </p:nvPicPr>
  <p:blipFill>
    <a:blip r:embed="rId3">                                          <!-- PNG fallback -->
      <a:extLst>
        <a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}">
          <asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rId4"/>
        </a:ext>
      </a:extLst>
    </a:blip>
    <a:stretch><a:fillRect/></a:stretch>
  </p:blipFill>
  <p:spPr><a:xfrm>…</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
</p:pic>
```

- Relationships: both parts use the ordinary image relationship
  `http://schemas.openxmlformats.org/officeDocument/2006/relationships/image`; SVG content type `image/svg+xml`
  (POI `XSLFRelation.IMAGE_SVG` = `/ppt/media/image#.svg`) [SRC]. python-pptx writes an `<Override … image/svg+xml>` for
  it (svg is not in its default-extension table); PowerPoint writes `<Default Extension="svg">` — both valid OPC
  [SRC; V-SDK 0 errors].
- `CT_SVGBlip` = `a:AG_Blob` (`r:embed`/`r:link`), namespace `http://schemas.microsoft.com/office/drawing/2016/SVG/main`
  [SPEC MS-ODRAWXML 2.26.1.1, 2.26.3.1, 5.24]; product note <610> "*not available in Office 2013 and earlier*" [SPEC
  MS-ODRAWXML App. B]; Microsoft support lists SVG for PowerPoint for Microsoft 365 and 2019/2021/2024 [SPEC
  support.microsoft.com]. Older readers skip the unknown `a:ext` and draw the PNG.
- [V-LO] LibreOffice 7.4 draws the **PNG** (discriminating probe: red PNG fallback + green SVG → red), i.e. Noah's preview
  always shows the fallback.
- python-pptx cannot load SVG itself; add the part by hand (stlib `add_picture(..., svg_bytes=…)`):

```python
pic = slide.shapes.add_picture(png_path, x, y, w, h)
pkg = slide.part.package
svg_part = Part(PackURI(f"/ppt/media/image{n}.svg"), "image/svg+xml", pkg, svg_bytes)   # n unused in /ppt/media
rid = slide.part.relate_to(svg_part, RT.IMAGE)
blip = pic._element.blipFill.find(qn("a:blip"))
ext_lst = blip.find(qn("a:extLst"))
if ext_lst is None:                      # note: an empty lxml element is falsy — never use `find(...) or ...`
    ext_lst = etree.SubElement(blip, qn("a:extLst"))
ext = etree.SubElement(ext_lst, qn("a:ext")); ext.set("uri", "{96DAC541-7B7A-43D3-8B79-37D633B846F1}")
svg = etree.SubElement(ext, "{http://schemas.microsoft.com/office/drawing/2016/SVG/main}svgBlip",
                       nsmap={"asvg": "http://schemas.microsoft.com/office/drawing/2016/SVG/main"})
svg.set(qn("r:embed"), rid)
```

- The SVG must be self-contained: page CSS (`currentColor`, classes, variables, web fonts) is invisible to PowerPoint →
  inline computed `fill`/`stroke`/fonts, set `xmlns`, `width`/`height`/`viewBox` [INF; RISK R6]. Complex SVG (filters,
  text, masks): ship PNG only.
- Rasterize the fallback **in isolation**: Playwright's `omitBackground` only removes the default white canvas, so an
  in-place element screenshot bakes the slide background into the "transparent" PNG (observed: RGB output with the
  gradient inside; after re-rendering the SVG alone on a transparent page the fallback matched exactly) [V].

---

## 5. Tables (`kind: "table"`)

### 5.1 Frame and default style

`g = slide.shapes.add_table(rows, cols, x, y, w, h)` writes `<a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>
{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}` = "Medium Style 2 - Accent 1" [SRC `pptx/oxml/table.py`; SPEC Microsoft
style-GUID list]. [V-LO] that renders a blue header, banded rows and a white grid.

```python
t = g.table
t.first_row = t.horz_banding = t.first_col = t.last_row = t.last_col = t.vert_banding = False
t._tbl.tblPr.find(qn("a:tableStyleId")).text = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"   # "No Style, No Grid"
```

Fixer round 2 (judge J2-03): the flags were cleared because python-pptx's DEFAULT style styles them; with "No Style,
No Grid" and every cell property explicit (fills, `lnL…lnB`, run `b`/colour/size/typeface), `firstRow="1"` only adds
the header-row semantics (PowerPoint's Table Design > Header Row, the Accessibility Checker's table-header rule,
screen readers' column headers). [V-LO] the deck's slide 3 rendered with and without `firstRow="1"`: 0 pixels differ.
That PowerPoint draws nothing extra rests on the style having no firstRow part, not on a PowerPoint render.

Keep an id rather than deleting the element: PowerPoint itself "*always*" writes `a:tableStyleId`, "*even when the table
style is set to none using the UI*" [SRC python-pptx `tbl-table.rst`]; `{2D5ABB26-…}` is Microsoft's documented "No
Style, No Grid" [SPEC hh273476]; an id that points nowhere gets no style [SPEC MS-OI29500 2.1.1423] but a missing id is
unspecified [RISK R8]. A non-GUID string is a schema error [V-SDK]. [V-LO] both `{2D5ABB26-…}` and "no id" render
unstyled (LibreOffice maps `{2D5ABB26-…}` to its no-accent "Themed-Style-1" = no borders/fills [SRC
`predefined-table-styles.cxx`]). A table style also styles **text**, so every run carries explicit `b`, colour, size and
`latin/ea/cs` (contract).

### 5.2 Grid and frame position

- `gridCol@w` = distance between adjacent vertical grid lines; round **cumulatively** (EMU of each grid line, then
  differences) so lines land on the Chromium positions. Office: 1 … 1000 columns; "*the width of the column is equal to or
  greater than the sum of the marL and marR … plus two points*" (2 pt = 25400 EMU) [SPEC MS-OI29500 2.1.1416, 2.1.1424b,
  2.1.1425]. Every `a:tr` has exactly one `a:tc` per `gridCol`, spanned cells included [SPEC 2.1.1424c, 2.1.1427b —
  the SDK does not check this, V-SDK].
- CSS collapsed model: "*Borders are centered on the grid lines between the cells*" and "*the width of the table
  includes half the table border*" [SPEC CSS 2.1 §17.6.2]. Measured [V]: table border box 40,40 722×226 with a 2 px
  outer border → first grid line at 41, cells 160/200/200/160 wide tile the grid (41, 201, 401, 601, 761). So:
  **frame at `table.x + outerLeft/2, table.y + outerTop/2`**, `columnsPx`/`rowsPx` = cell border-box pitch. PowerPoint
  also centres borders on grid lines, the outer ones on the frame edge. `border-collapse: separate` with spacing → lint.
- Chromium's `getComputedStyle` on a cell returns the cell's *specified* border (1 px) even where the table's 2 px border
  wins the collapse → the extractor must run CSS 2.1 §17.6.2.1 conflict resolution itself.

### 5.3 Row height semantics

`a:tr@h` "*shall be either 0, or greater than the minimal row height … the sum of the minimal heights which can hold the
top margin and the bottom margin plus 2 extra points for each cell*", ≤ 0x3FFFFFFF, not negative [SPEC MS-OI29500
2.1.1427a; the SDK accepts a negative `h`, V-SDK]. It acts as a **minimum**: rows grow to fit text (Apache POI mirrors
PowerPoint with `rowHeights[row] = max(h, textHeight)` [SRC `XSLFTable.updateCellAnchor`]).

LibreOffice rule, measured at 4× [V-LO `out/probe-rows.json`]: laid-out row = **max(h, marT + lines × exact spacing +
marB)** — content 37 px: h ≤ 37 → 37.0 px, h ≥ 37.5 → h exactly; but an empty paragraph whose exact spacing (14 px) is
below the font's natural height (DejaVu 1.164 em ≈ 16.3 px) used the natural height (16 px rows became 17.3 px); and
python-pptx's default empty cell paragraph (no size → 18 pt) grew 16 px rows to ≈ 28 px.

Builder rules:
1. `h = ` Chromium row pitch (cumulative EMU rounding).
2. `marT/marB = padding + half the collapsed border` (§5.5). *Superseded (CONTRACT v2, what the builder writes):* not
   exact `spcPts` spacing (the research round's rule, kept below for the record) but the text-box line model — every
   cell paragraph gets `<a:lnSpc><a:spcPct val="{whole percent of lineHeight / (1.2 × size)}"/></a:lnSpc>` (e.g. 118 000
   for 24 px lines of 17 px text) and explicit `spcBef/spcAft`, and `tr@h ≥ marT + marB + lines × 1.2 × pct × size`
   (PowerPoint's cell model; `tools/pptxlib/table.py`). marT/marB are then shifted together (sum unchanged) so
   PowerPoint's first baseline lands on Chromium's measured one, and the sub-pixel excess of the whole-percent rounding
   (24 / (1.2 · 17) = 117.6 % → 118 %: +0.07 px per line) is absorbed by the non-anchored margin(s), so the grid lines
   stay on Chromium's pixels. Consequence, measured on the deck (fixer round 3, VR-10): `tr@h − (marT + marB + 1.2 ·
   pct · S)` is 2.2–3.2 EMU in every body row of both profiles (190 EMU in the header row) — rows have essentially zero
   slack against the model, so any upward rounding in PowerPoint's cell layout grows them (RUN.md Known gaps, "Table
   rows assume 1.2 × size").
   Research-round rule (superseded): exact spacing `<a:lnSpc><a:spcPts val="{round(lineHeightPx·75)}"/></a:lnSpc>` →
   content height = `marT + Σ lineHeight + marB`, which equals the Chromium pitch for auto-height rows and is ≤ it for
   fixed rows.
3. Every paragraph (also empty and spanned cells) carries `<a:endParaRPr sz="…"/>` = the cell's font size.
4. Lint rows with `h < marT + marB + 2pt` and line heights below ~1.2 em (LibreOffice may use the natural height).
5. Text must break into the same number of lines as in Chromium — table cell text always wraps at the column width, so a
   Korean string that is slightly wider in PowerPoint's font adds a line and grows the row, shifting every later row down
   (file stays valid) [RISK R4; text-mapping owns the metrics].

[V-LO] the test table (header 44, rows 40/40/40/60, merges) keeps all grid lines at exactly the Chromium pixels.

### 5.4 Cell fill and borders — child ORDER

`a:tc`: `a:txBody` → `a:tcPr` → `a:extLst`; `a:tcPr`: `lnL, lnR, lnT, lnB, lnTlToBr, lnBlToTr, cell3D,` fill,
`headers, extLst`; attributes `marL marR marT marB vert anchor anchorCtr horzOverflow` [SPEC; V-SDK fill-before-`lnL` and
`tcPr`-before-`txBody` both rejected]. python-pptx's `cell.fill` only knows `headers/extLst` as successors, so borders
appended after a fill land behind it — rebuild `a:tcPr` in one pass (stlib `add_table`):

```python
tcPr = etree.SubElement(tc, qn("a:tcPr"))                  # after a:txBody
tcPr.set("marL", …); tcPr.set("marR", …); tcPr.set("marT", …); tcPr.set("marB", …); tcPr.set("anchor", "ctr")
for tag, line in (("lnL", left), ("lnR", right), ("lnT", top), ("lnB", bottom)):
    tcPr.append(line_el(line, tag=tag))                   # a:lnX w=… cap cmpd algn + solidFill + prstDash, or noFill
tcPr.append(fill_el(cell_fill))                           # a:noFill | a:solidFill | a:gradFill — LAST
```

"*Office ignores the lnL and lnT elements for interior borders*" and "*requires the neighboring interior borders of two
neighboring table merges to have matching border line properties*" [SPEC MS-OI29500 2.1.1424e/f]: the line between
(r,c) and (r,c+1) comes from `lnR` of (r,c), between rows from `lnB`. Resolve one line per grid edge (CSS collapse winner),
then write it on **both** neighbours (`lnR`+`lnL`, `lnB`+`lnT`) so every reader agrees; "no border" is an explicit
`<a:lnX><a:noFill/></a:lnX>`.

### 5.5 Margins and anchor

- Margins are measured from the grid line and borders are centred on it, so with collapsed borders
  `marL = emu(padding.l + borderLeft/2)` etc. [INF; V-LO text ink within ±1 px horizontally, +1…2 px vertically of
  Chromium in every tested cell, incl. top/middle/bottom anchors and the row-span cell — the residual vertical offset is
  the first-baseline difference owned by text-mapping].
- `anchor` = `t | ctr | b` from `vAlign top | middle | bottom`; never `just`/`dist` ("*Office does not allow this value*"
  [SPEC MS-OI29500 2.1.1337]; V-SDK rejects both on `a:tcPr`).

### 5.6 Merged cells

Office rules [SPEC MS-OI29500 2.1.1424d, 2.1.1426]: top-left cell `gridSpan=C rowSpan=R`; other first-row cells keep
`rowSpan=R`, `hMerge="1"`; other first-column cells keep `gridSpan=C`, `vMerge="1"`; the rest `hMerge="1" vMerge="1"`;
spans stay inside the table, merges never overlap, `rowSpan/gridSpan ≥ 1`. python-pptx `origin.merge(other)` writes
exactly this pattern and moves content to the origin [SRC `pptx/table.py`, `tbl-merge.rst`] → **merge first, then write
text and `tcPr`**. Spanned cells keep one empty paragraph (with `endParaRPr@sz`). The SDK rejects `rowSpan="0"` but not a
`gridSpan` past the edge or an orphan `hMerge` [V-SDK] — rely on python-pptx's merge. Write the merge-origin's fill on all
constituent cells and the region's outer borders on its edge cells. [V-LO] colspan-2 and rowspan-2 cells match.

### 5.7 Text and table-level decoration

`cell.text_frame` takes the same paragraph/run builder as text boxes (exact `lnSpc`, explicit run props, `lang`). The
cell `a:bodyPr` insets are not used; margins live on `a:tcPr`. A table-level background/radius/shadow is a preceding
`shape` (IR); DrawingML cannot clip cell fills to a rounded outline → lint "rounded table with filled corner cells".

---

## 6. Constructs that make PowerPoint offer "repair"

PowerPoint's exact rule set is not public; schema violations in a slide part are the established trigger, with the
offending object typically dropped [INF from practitioner reports, e.g. python-pptx issue #87; RISK R9]. Every row below
was generated as a one-defect variant of the verified test deck (`scratch/shape-table/repair_variants.py`) and run
through Microsoft's Open XML SDK validator (`out/repair/validation.txt`); the clean deck reports 0 errors.

| construct | SDK 3.3.0 (Microsoft365) | Office rule |
|---|---|---|
| `a:ln` before the fill in `p:spPr` | **error** "unexpected child element solidFill" | schema order |
| `a:prstDash` before the line fill in `a:ln` | **error** | schema order |
| fill before `a:lnL` in `a:tcPr`; `a:tcPr` before `a:txBody` | **error** / **error** | schema order |
| `a:alphaModFix` after `a:extLst` in `a:blip` | **error** | schema order |
| `p:bg` after `p:spTree`; `p:bgPr` without a fill | **error** / **error** | schema |
| `srgbClr` `2563EBFF` / `#2563EB` / `F00` | **error** (hexBinary length 3) ×3 | [SPEC] |
| `alpha val="150000"` / `"50%"` | **error** max 100000 / not Int32 | Office writes ints only |
| `gs pos="100001"`; one `gs` | **error** / **error** | [SPEC] |
| negative `outerShdw@dist`, `a:ext@cx`, `ln@w`; `ln w="20116801"`; `dir="21600000"` | **error** ×5 | [SPEC] |
| `a:off x="381000.5"` | **error** not Int64 | integers only |
| `prstDash val="dashed"`; `anchor="just"` / `"dist"` | **error** ×3 | enum / [SPEC MS-OI29500 2.1.1337] |
| `rowSpan="0"`; missing `tblGrid`; `tableStyleId` not a GUID; missing `@name` | **error** ×4 | [SPEC] |
| `r:embed` to a missing relationship | **error** (semantic) | OPC integrity |
| `cNvPr@id` > 4294967295 | **error** | unsignedInt |
| duplicate `cNvPr@id`; id 0; id 3 000 000 000 | *not flagged* | ECMA non-conformant; Office signed int32 [RISK R9] |
| `a:tr` with fewer `a:tc` than `gridCol`; `gridSpan` past the edge; orphan `hMerge`; negative `tr@h` | *not flagged* | [SPEC MS-OI29500 2.1.1424/2.1.1426/2.1.1427] — avoid by construction |
| `rot` on `p:graphicFrame`; `alphaModFix amt="100000"`; `adj` 90000 | *not flagged* (schema-valid) | ignored / wraps to 0 % / clamps — silent visual traps |

Silent traps (no repair, wrong picture): missing line fill (Office: solid), `ln w="0"` (hairline), `p:style` left in place
(theme fill/line/shadow), `amt ≥ 100000`, `outerShdw sx/sy ≠ 100 %` on a shape (not rendered), `rot` on a table, default
round join. `selftest.lint()` checks all of these plus schema order; it flags 10 problems on a plain python-pptx
shape+table and 0 on stlib output [V].

---

## 7. Empirical verification (what was run, what came out)

Pipeline (all in `scratch/shape-table/`): `make_test.py` generates two 1280×720 slides **and** the matching IR dicts from
one spec (22 shapes; table + PNG + inline SVG + gradient background) → `render.mjs` (Chromium 1228 via playwright-core,
dsf 1 and 2; table geometry measured with `getBoundingClientRect`; SVG rasterized at 4× in isolation) → `build_test.py`
(stlib) → `validate.sh` (Open XML SDK) → LibreOffice 7.4.7.2 PDF → pdftoppm 96 dpi → `compare.py` / `measure.py`.
**All LibreOffice numbers describe LibreOffice (Noah's preview), not PowerPoint.**

| check | result |
|---|---|
| Open XML SDK on test, overlay, probe decks | 0 errors each; 29/39 one-defect variants rejected (§6; the 10 accepted ones are listed there), clean deck accepted |
| shape bounding boxes (17 unrotated, unshadowed shapes) | Chromium = IR exactly; LibreOffice within **1 px** |
| roundRect r=24 corner profile | matches the circle; ≤ 2 px on the anti-aliased first row |
| 8 px border band | x 40–48, y 310–318 in both; sharp (mitred) corners |
| gradients 90deg, 135deg on 400×110, `to bottom right` (→164.62°), 135deg slide background | ≤ **1/255** at all samples (11 per shape, 6 on the background) |
| hard-stop gradient (40 %/40 %) | LibreOffice smooths it (up to 128/255) — LibreOffice limitation |
| solid alpha 50 % | within 1/255 of the expected composite |
| hard shadow 12,12 | identical pixel runs |
| blurred shadow 24 px | fitted σ: LibreOffice 12.1 px, Chromium 13.0 px (CSS 12) |
| rotated 15° shape + shadow | `rotWithShape="1"`: LibreOffice wrong (page-down offset); `rotWithShape="0"` + pre-rotated `dir`: matches |
| dashed 4 px / dotted 6 px | same size and density, different phase |
| translucent border / gradient+border (split rule) | match |
| table grid lines and row heights (merges, 2 px outer, 1 px inner) | identical pixel rows/columns |
| table text ink boxes (7 cells, 3 anchors, row-span) | ±1 px x, +1…2 px y |
| alphaModFix 25/50/99.999 % | 254,189,189 / 254,125,125 / 254,3,3 on red-over-white; `amt=100000` opaque |
| SVG with different PNG fallback | LibreOffice draws the PNG |
| `p:style` trap / empty `effectLst` / `ln w=0` / `ln` without fill / default join | see §2.1, §2.4 (all reproduced) |
| row-height sweep (17 cases at 4×) | §5.3 rule |
| whole-slide MAE (Chromium vs LibreOffice) | 1.15 (shapes), 0.86 (table/pictures) on 0–255 |

Artifacts: `out/test.pptx`, `out/test-overlay.pptx` (reference PNG on top at 50 %), `out/cmp/cmp-html-slide{1,2}.png`
(HTML | LibreOffice | ×3 diff), `out/cmp/zoom-*.png`, `out/measure.json`, `out/probe*.pptx` + `out/lo-*`,
`out/repair/*.pptx` + `validation.txt`.

---

## 8. What the extractor must hand over for this mapping to work

1. Border box before rotation, with the centre of the rendered element (non-centre `transform-origin`), and the angle
   from the computed `matrix()`.
2. Gradient: resolve `to <corner>` keywords (Chromium serializes `to right bottom`) with the background-positioning-area
   size; stops may lie outside 0–1 (`120%`) — keep them, the builder clips.
3. Radii as px (Chromium keeps `9999px` unclamped and `50%` as a percentage).
4. Tables: resolved collapsed borders (computed style gives specified borders), cell border boxes as the grid, table
   border box, per-cell padding and `vertical-align`, and whether the table is `border-collapse: collapse`.
5. Inline SVG: markup with computed styles inlined, and a 4× PNG rendered **in isolation** (transparent background).
6. Lint: spread ≠ 0, box-shadow on translucent/no-fill elements, rotated tables, elliptical/per-corner radii, separate
   borders with spacing, rows shorter than `marT + marB + 2pt`.

---

## 9. Sources

Microsoft
- [MS-OI29500] §20.1.8 general note (inheritance, defaults): https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/c0c046ec-a61d-405d-88fe-74d8487a37d7
- [MS-OI29500] notes (all `…/ms-oi29500/<id>`): ln 5564035f-88ff-4ab8-bbfb-d2998a83324d · xfrm c7555d2c-472a-4d15-b230-41046bc41819 ·
  bg 71e8b4e0-e70d-416a-a249-c870d41e6d5e · bgPr c1fadbc6-d063-48b9-b57e-a043969cf6c5 · alpha 8d11d273-22a6-48b8-a212-2b60910659bd ·
  alphaModFix 1c2204d5-0c72-40ca-a3c4-89b803883e90 · blur 9847db85-c8ee-40f0-8c7e-cdca7563544b · gradFill f43f30df-c829-41f3-ba6f-52e9ac3b4e20 ·
  outerShdw a3d8cb72-c704-433b-8d5a-defc6f0700be · ST_Coordinate c35b4461-26a2-4788-a41b-0c99a6c691d8 · ST_Coordinate32 d79b2e50-4715-4cb0-9e8c-bfe7d87d113d ·
  ST_DrawingElementId 9746bb87-3dd0-4c7d-ae43-e3547589def1 · ST_LineWidth 5550378c-b28d-4a11-ab1e-6c6a64630186 · ST_PenAlignment b3bbaebc-f2ca-4a79-9efd-ec0d1d3c6d9c ·
  ST_Percentage ff18a37e-9bd7-4338-9c37-1e285b5a5dd2 · ST_PositiveCoordinate 518012eb-e873-4507-8119-2c51bf1081ed · ST_PositivePercentage c1f1feac-e34c-48d5-b2e2-f67bb67113e7 ·
  ST_TextAnchoringType 86ec6af2-eea6-46a0-9d1e-b2c640d0b129 · gridCol 8de3b402-ef35-4eba-ac7f-cae720425b2a · lnT 90f6fa14-8257-4c82-ad53-be75e8dcbb8f ·
  tableStyleId e12a68d7-7ac8-47de-ad30-f6ee7a5d1c8e · tbl 87e635df-37bf-42ef-87b6-fdd8abac88e1 · tblGrid 460020a0-e12d-47ab-834a-20f6779387b5 ·
  tc f9366bfc-1f6c-4e97-a2f5-40f83aebb61c · tr 312c4c2e-d5b3-4407-932a-1122ed816de0 (TOC: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/toc.json)
- [MS-ODRAWXML] svgBlip https://learn.microsoft.com/en-us/openspecs/office_standards/ms-odrawxml/2451f45e-5d77-4661-86d1-0a017fced779 ·
  CT_SVGBlip …/68e0150d-6a01-4ba5-ac4d-5a18d685229b · schema 5.24 …/cc083f6d-bc38-4ff4-b32a-5bc97df8addc · Pictures ext …/58d882d6-5e9b-4682-95b3-2606577073eb ·
  Product behavior …/25473cfd-41bc-44b9-9cf9-c863922c6bb8
- Microsoft Q&A, `scaled` erratum (Kaszewiak, 2025-05-28): https://learn.microsoft.com/en-us/answers/questions/2265121/error-in-description-of-attribute-scaled-of-linear
- Microsoft Q&A, linear/path gradients (Mike Bowen, 2025-04-17/30) + figure: https://learn.microsoft.com/en-us/answers/questions/2248059/non-preset-a-tilerect-behaves-strange-in-case-of-g
- Table style GUIDs (PowerPoint 2010 list): https://learn.microsoft.com/en-us/previous-versions/office/developer/office-2010/hh273476(v=office.14)
- SVG support: https://support.microsoft.com/en-us/office/edit-svg-images-in-microsoft-365-69f29d39-194a-4072-8c35-dbe5e7ea528c
- Open XML SDK SVG sample: https://raw.githubusercontent.com/dotnet/Open-XML-SDK/main/samples/Linq/SvgExample/LinqToXmlTools.cs ; validator: NuGet DocumentFormat.OpenXml 3.3.0

ECMA-376 / ISO 29500
- Transitional XSDs (ISO/IEC 29500-4:2016) used locally: `~/.claude/plugins/marketplaces/anthropic-agent-skills/skills/pptx/scripts/office/schemas/ISO-IEC29500-4_2016/{dml-main,pml,shared-commonSimpleTypes}.xsd`
- presetShapeDefinitions.xml: https://raw.githubusercontent.com/LibreOffice/core/master/oox/source/drawingml/customshapes/presetShapeDefinitions.xml
- `lin` text: https://c-rex.net/samples/ooxml/e1/Part4/OOXML_P4_DOCX_lin_topic_ID0EDA2MB.html ; `cNvPr`: https://c-rex.net/samples/ooxml/e1/Part4/OOXML_P4_DOCX_cNvPr_topic_ID0EMWGPB.html

CSS / Chromium
- https://www.w3.org/TR/css-images-3/ (§3.1.1 gradient line, premultiplied interpolation) · https://www.w3.org/TR/css-backgrounds-3/ (§4.5 radius clamping, §6.1 shadows) · https://www.w3.org/TR/CSS21/tables.html#collapsing-borders
- https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/style/shadow_data.h (σ = r/2) ·
  …/platform/graphics/styled_stroke_data.cc (dash/dot ratios) · …/core/paint/box_painter_base.cc (BlurAsSigma use)

LibreOffice 7.4 (branch `libreoffice-7-4`) and master
- oox/source/drawingml/effectproperties.cxx, effectpropertiescontext.cxx (shadow import, `rotWithShape` unused) ·
  oox/source/drawingml/table/predefined-table-styles.cxx, tableproperties.cxx · drawinglayer/source/primitive2d/shadowprimitive2d.cxx (master)

python-pptx 1.0.2 / Apache POI
- local `.venv/…/pptx/{oxml/shapes/autoshape.py, oxml/table.py, dml/fill.py, dml/effect.py, oxml/slide.py, opc/spec.py}`;
  analysis docs https://raw.githubusercontent.com/scanny/python-pptx/master/docs/dev/analysis/{tbl-table,tbl-merge,dml-gradient}.rst
- https://raw.githubusercontent.com/apache/poi/trunk/poi-ooxml/src/main/java/org/apache/poi/xslf/usermodel/{XSLFTable,XSLFPictureShape,XSLFRelation}.java

---

## 10. Open risks (only Windows PowerPoint can settle these)

| id | risk | confidence it is fine | how to settle |
|---|---|---|---|
| R1 | PowerPoint's blur kernel for `blurRad` differs from CSS σ = blur/2 (softer/harder shadows) | medium (60 %) | overlay deck: compare a 24 px blur; tune one constant `k` |
| R2 | `rotWithShape="0"` + pre-rotated `dir` reproduces CSS on rotated shapes in PowerPoint | high (85 %) | overlay of s17 |
| R3 | gradient interpolation space (opaque stops) / translucent stops | opaque 75 %, translucent 55 % | overlay of s07/s08; a transparent→colour gradient |
| R4 | table rows keep the Chromium height (exact spacing, margins = padding + half border); rows grow if PowerPoint wraps a line more | 75 % (depends on text metrics) | open slide 2; watch the frame height |
| R5 | Office's minimum row height/column width (+2 pt) enlarges tiny rows/columns | 90 % that the documented rule is what happens | a 4 px spacer row |
| R6 | PowerPoint's SVG renderer vs Chromium for non-trivial SVG; unsupported in Office 2016 MSI (M365 fine) | simple icons 85 %, complex 50 % | keep SVG for flat icons only |
| R7 | dash/dot phase differs from Chromium | certain difference, low impact | — |
| R8 | `{2D5ABB26-…}` renders with no style and no grid in PowerPoint | 95 % | — |
| R9 | PowerPoint-only validity checks the SDK does not model (duplicate ids, merge structure, `tc` count) | 85 % that stlib output opens without repair | open `out/test.pptx` once in PowerPoint |
| R10 | a slide-level transparent background pre-composited over white differs from PowerPoint's slideshow backdrop | 90 % | — |
| R11 | CSS group `opacity` vs per-object alpha on overlapping fill/line | certain small difference | split rule or accept |
| R12 | Noah preview (LibreOffice 7.4) only: hard/multi-stop gradients smoothed, SVG → PNG fallback, text 1–2 px lower | certain (LibreOffice behaviour) | document for users |
