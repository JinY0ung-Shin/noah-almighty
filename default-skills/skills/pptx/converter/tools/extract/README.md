# Extractor — HTML slides → IR (`tools/extract.mjs`)

Implements the IR of [`docs/CONTRACT.md`](../../docs/CONTRACT.md) (incl. the v2 decisions). Consumer:
`tools/build_pptx.py`. Normally run by `tools/deck.mjs` (check: `--fast`; build: full), never by the agent. The
PoC's extractor test suites (`scratch/extract/…`, cited below as evidence) stay with the PoC; the maintainer copy of
its research lives under `docs/pptx-converter/`.

```
node tools/extract.mjs --deck <dir> --profile <embedded|malgun> [--out <dir>] [--only NN-name ...] [--fast]
                       [--strict] [--no-verify] [--timeout <s>] [--result <file>]
```

- slides: `<deck>/slides/NN-name.html` in numeric order (`--only` keeps each slide's deck index, so a slide-number
  field still checks against its real number).
- writes `<out>/ir.json` (default `<out>` = `<deck>/.build/<profile>`), `html/<slide>.png` (1×) +
  `html/<slide>@2x.png`, `assets/<slide>-imgN.png|.jpg|.svg`. **Every IR path is relative to the IR directory**
  (`source` = `../../slides/…`, `referencePng` = `html/…`, image `src` = `assets/…`); `fonts.json` paths stay relative
  to the toolkit. `ir.json` is deleted first, so a failed run never leaves a stale IR.
- `--fast` (check mode): no DSF-2 reference and no isolated image rasters (images carry no `src`).
- exit 0 ok (IR written; lint errors possible) · 1 authoring: lint errors with `--strict`, charts never ready, a
  missing `<main class="slide">`, a deck font face that did not load · 2 usage · 3 conversion: a slide page crashed ·
  4 toolchain / internal · 6 timeout (a page wait or an extraction `evaluate` over 60 s). `--result <file>` receives
  `{"ok", "class", "message", "slide"}` either way; `deck.mjs` maps it to its own exit classes. `--no-verify` skips
  the in-place first-baseline probes (they never changed a value in the test suite; keep them on).

## Isolation (Noah)

- **Two roots behind one origin** (`extract/server.mjs`): `http://deck.local/theme/*`, `/lib/*`, `/fonts/*` serve the
  read-only toolkit (`theme/fonts.css` → `theme/fonts-<profile>.css`); `/deck.css`, `/slides/*`, `/assets/*` and
  everything else serve the deck folder. realpath containment on both sides (`..` or a symlink leaving its root →
  aborted + `blocked-request`), files over 20 MB → 413 + `asset-too-large` (read through one no-follow descriptor),
  `data:`/`blob:` continue, any other scheme or host is aborted.
- **Decoded pixels** (`extract/pixels.mjs`): a deck picture over 40 MP, a page whose distinct pictures would pass
  100 MP, or a recognised image of unreadable size → 413 + `image-too-large` BEFORE Chromium decodes it (the V8 heap
  cap does not cover bitmaps; a 1.2 MB 12000×12000 PNG decodes to ~0.6 GB). Sizes come from the headers of PNG,
  JPEG, GIF (every frame), WebP, BMP, ICO/CUR and AVIF; a deck HTML/CSS/SVG embedding such a base64 `data:` image is
  refused the same way (best effort).
- **CSP on every served document**: slides `default-src 'none'; script-src http://deck.local/lib/chart.js;
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none';
  media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`;
  the isolated raster pages the same with `script-src 'none'` and `base-uri 'self'`. No inline script, handler or
  foreign script ever runs. A CDP init script (exempt from the CSP) records `securitypolicyviolation` events →
  `csp-violation` lint.
- **Launch** (`extract/browser.mjs`): the ONE resolved executable (`extract/chromium.mjs`), headless,
  `--font-render-hinting=none`, `--js-flags=--max-old-space-size=512`, WebRTC limited to proxied UDP, a black-hole
  SOCKS proxy `socks5://127.0.0.1:9` for everything (loopback included), `--host-resolver-rules=MAP * ~NOTFOUND ,
  EXCLUDE 127.0.0.1` (passed by the converter: the copy Playwright adds for a SOCKS proxy keeps its quote characters
  in argv and Chromium rejects it — "Failed parsing rule"; the last copy of a switch wins), `HOME`/`TMPDIR` = the run
  temp dir. Contexts: service workers blocked, downloads off, `bypassCSP: false`; WebSockets closed through
  `routeWebSocket`.
- **Readiness without page eval**: Playwright's string-form `waitForFunction` evaluates a string in the page, which the
  CSP forbids (`EvalError`, measured), so the chart wait is a Node-side `page.evaluate` poll every 100 ms.
  `page.evaluate` / `Runtime.evaluate` / `addInitScript` are CDP-injected and exempt.
- **The CDP CSS agent is enabled before navigation**: enabled after load, its resource re-loader never finishes
  while the black-hole proxy is configured (measured with Chromium 149), which would hang the platform-font check.
- **Budgets**: page waits 20 s (`--timeout`), every extraction `evaluate` raced against 60 s (timeout → the page is
  closed, class `timeout`, as is a page operation outliving Playwright's own timeout); a renderer crash — or the
  browser exiting on its own while a slide renders — is class `conversion` naming the slide. A signal, or the parent
  going away (the orphan watchdog), records the result `{"ok": false, "class": "cancelled"}`, closes the browser
  (and, when `deck.mjs` was SIGKILLed, removes its run temp dir) and exits 130/143; whatever the extraction was
  doing then fails quietly — it is never reported as a crash.

## Pipeline (per slide)

1. **Context at DSF 1** (viewport 1280×720, the launch of "Isolation" above). Every request goes through the
   router; aborted requests are linted (`blocked-request`, 404 → `missing-file`, > 20 MB → `asset-too-large`,
   too many decoded pixels → `image-too-large`). A full run (no `--only`) first drops the `html/` renders and
   `assets/` rasters of slides that no longer exist.
   The document lints (`inpage/05-document.js`) and the CSP violations are collected first.
2. **Readiness**: if a `[data-chart]` exists, wait for `html[data-charts-ready="1"]` (timeout → authoring, with the
   page errors). Then force layout + `document.fonts.ready` + two rAFs, repeated until no face is `loading`; wait for images.
3. **Font verification** (`inpage/60-fonts.js`): for every rendered text group (family, weight, style, incl. list
   markers and SVG text) the `@font-face` that CSS Fonts 4 matching selects for each character (style → weight →
   unicode-range, later rules first) must be `loaded`, else a failure listing face, src, characters and element. Then CDP
   `CSS.getPlatformFontsForNode` per text node: glyphs drawn by a non-web font → `fallback-font` warn.
4. **Reference PNG** = `main.slide` element screenshot at DSF 1 (`referencePng`).
5. **Extraction** (`window.__pptx.extract`, `inpage/*.js` concatenated): transforms are captured and neutralised
   first (every rect below is an untransformed layout rect), the walk runs, the DOM is restored; a layout fingerprint
   before/after proves the probes were undone (`extractor-restore`).
6. **Images**: every `<img>`/inline `<svg>` is re-rendered **in isolation** (own page, transparent background,
   `<base href>` = the slide, `fonts.css` linked) → `assets/<slide>-imgN.png` at S× the content box, S = min(4,
   2560 / the longer CSS side) (raster policy: icons keep 4×, a full-slide image gets 2560 px): the element is drawn
   at S× its CSS size in a DSF-1 page and clipped to ceil(Sw)×ceil(Sh) px (identical pixels to a DSF-S render for
   integral sizes — tested byte for byte; screenshot clips are whole CSS px, so a DSF-S render of a fractional box
   would be padded up to the next CSS px). An `<img>` whose source is a JPEG, with `object-fit` fill/cover, no
   border-radius and opacity 1 is written as JPEG q90 (`.jpg`); everything else PNG. Not scale-invariant:
   `vector-effect: non-scaling-stroke`.
7. **DSF 2 reference** in a separate context → `referencePng2x`; its layout fingerprint must equal DSF 1's (`dsf-layout`).
8. **Glyph coverage** from the font files' cmaps: characters no profile face covers (`missing-glyph`, an error); embedded profile:
   characters not in the embedded files (`not-embedded-glyph`, PowerPoint would substitute).

Deterministic: two runs give an identical IR and byte-identical PNGs (tested). Ids are DOM paths (`#id` when unique,
else `parent > tag.class:nth-child(n)`) + a kind suffix (`::bg`, `::border-left`, `::bg2`, `::text`, `::text2`,
`::inline-bg1`, `::table`, `::chart`, `::image`).

## Emission rules

Coordinates: CSS px relative to the slide origin, **untransformed** layout geometry. Chromium paints box
decorations and replaced content pixel-snapped to whole CSS px, also at DSF 2/4 (inline `<svg>`: origin rounded half
up, drawing size unchanged; `<img>`: the whole rect snapped — `scratch/extract/exp/exp8_snap.mjs`); the IR keeps the
layout values, ≤ 0.5 px from the reference PNG.

**Shapes** (`inpage/40-shapes.js`) — any visible box with a background, border or outer shadow, emitted before its
content. `box` = border box. Geometry from the USED radii (CSS clamping applied): all zero → `rect`; every corner
= half the box → `ellipse` (`50%`, also a square with radius ≥ side/2); one uniform radius → `roundRect` + `radiusPx`
(outer radius, as CSS); anything else → lint error + `roundRect` with the median radius. Uniform visible border →
`line` (`dash` solid/dashed/dotted; double/groove/… → solid + warn); non-uniform → one filled `rect` per visible side
(`::border-<side>`, full-length edges, no mitre) right after the element's shape. Fill: `background-color`
below the `background-image` layers; one linear gradient → `Fill linear` (`angleDeg` = CSS angle, `to <corner>`
resolved against the padding box, stop positions resolved to 0..1 of the gradient line, stops outside 0..1 replaced
by the colour interpolated at 0/1 in premultiplied sRGB); several fills → stacked shapes `::bg`, `::bg2`… (the line
on the top one, the shadow on the bottom one). Shadow = first outer `box-shadow` (offsets in the element's own,
unrotated frame, as CSS). A collapsed `<table>`'s border belongs to its cells (not a shape); `main.slide`'s bottom fill layer
is the slide `background` (made opaque over the page canvas when translucent, exactly as the reference screenshot
shows it; body/html/white when main.slide paints none), its other layers and its border are full-slide shapes.

**Text** (`inpage/20-text.js`) — a text element is the nearest box whose in-flow content is ONE inline run with text:
a block container (`p`, `div`, `li`, `td`-like, inline-block, …), a flex/grid container holding only one anonymous
text item, or an anonymous run beside block siblings (`::text1`, `::text2`, box from its line boxes). Inline
descendants (`span b strong em i u s a code small sup sub br` and any other pure inline element) become runs;
`display: contents` is flattened; out-of-flow/floated children are separate items; atomic inlines (inline-block, img,
svg) are cut out of the text and emitted after it (`text` warn: they do not reflow). `ul/ol` whose items are all
inline-only list items → ONE element, one paragraph per `li` (`spaceBeforePx`/`AfterPx` = li margins,
`marginLeftPx` = li content left − text box left, `indentPx` = −marker advance (widest marker for numbers) so the bullet
sits at `marL + indent` = Chromium's marker box; bullet `color` only when `::marker` differs from the first run).
- runs: rendered text after CSS white-space processing (collapse, `pre`/`pre-wrap`/`pre-line` newlines → breaks,
  trailing collapsible spaces removed at hard line ends) and `text-transform`; `<br>` → `{"break": true}` (a trailing
  `<br>` creates no line in CSS and is dropped); consecutive characters with identical style merge. `fontFamily` =
  computed first family, `alpha` = colour alpha × opacity of inline ancestors inside the text element (the element's
  own/ancestor opacity is `opacity`), `baseline` super/sub from `vertical-align` (other values → baseline + warn).
- `lines[]`: one per rendered line box, found from per-character `Range.getClientRects()` (a new line starts when the
  measured baseline changes or the pen moves left). `top`/`bottom` = union of the line's glyph fragments;
  `baseline` = fragment top + the font's baseline offset, the offset measured with a 0×0 `inline-block` probe beside the
  same text in the same computed font (exact: identical to an in-place probe for every line of every fixture and slide,
  `test_baselines.mjs`); the first line is additionally re-measured in place (`baseline-verify` if it ever differed).
  Empty lines (`<br><br>`) are probed after the `<br>`. `text` = the exact rendered text of the line (soft-wrap
  space kept at the end of its line) so that `"".join(line texts)` == the paragraph's run texts; `paragraph` = index.
- `lineHeightPx` always px: explicit line-height, or for `normal` the measured baseline pitch / a measured line box
  (+ `line-height-normal` warn). `wrap` = (number of lines ≠ 1). `box` = `contentBox` = content box of the text
  element, except: anonymous runs (line-box extents), outside list markers (box starts at the marker), single-line
  text with cut-out atomic inlines (text extent), a single-line shrink-wrapped flex/grid item centred/end-aligned by
  its parent (parent content box + that alignment, so PowerPoint keeps Chromium's anchor), a shrink-wrapped pill with
  its own paint — block or `inline-flex` — (`align` → `ctr`, box = the pill's content box), shrink-wrapped
  positioned text anchored by `right:` (→ `r`) or centred with `translateX(-50%)` (→ `ctr`), and lines uniformly
  moved by a float (box moved with them, `line-start` warn). Any other shrink-wrapped single-line text (untransformed,
  no cut-out inlines) gets a **growth probe** (`growthAnchor`): its box is widened in place by 20 px (padding-right)
  and the edge Chromium keeps fixed decides `l` / `r` / `ctr` — e.g. the last item of a `space-between` / `flex-end`
  row, `margin-left: auto`, or every item of a shrink-wrapped group that is itself right-anchored (a footer's
  "note · page number") → `r`. `r`/`ctr` is kept only if NO painted/replaced box (shape, image, chart, table) moved
  with the text in the probe: PowerPoint keeps those fixed, so a legend label beside its swatch stays `l`
  (`scratch/extract/fixtures/f16-growth-anchors.html`, asserted by `scratch/integration/test_growth_anchor.py`).
  These anchors only decide which edge stays fixed when PowerPoint's single line is a fraction wider/narrower than
  Chromium's.
- `nowrap` / `shrinkWrap` (fixer round 2, judge J2-01): how the HTML would treat a LONGER line. `nowrap` = the host's
  computed `text-wrap-mode` is `nowrap` (or `white-space` `nowrap`/`pre`); `shrinkWrap` = `widthFollowsContent`: the
  host's padding-right is grown in place by the box's free room + 20 px (!important, style attribute restored exactly)
  and its border box re-read — a width set by the container does not change (the text would wrap inside it), a
  shrink-to-fit box grows (a pill, a flex-row item, a footer note, a legend label, a min-width page number, a card
  title inside a shrink-wrapped column). The builder writes `wrap="square"` at the HTML width only when both are false
  (and the lines fit, CONTRACT v2 (f)).
- Extra (non-CONTRACT) line fields: `left`/`right` (ink extent of the line, null for an empty line), `hardBreak`.

**Tables** (`inpage/30-table.js`) — `<table>` is atomic: slot grid from `rows/cells` with `rowSpan`/`colSpan`
(`covered` for hidden slots; `header` = the cell is a `<th>`, fixer round 2). `columnsPx`/`rowsPx` = grid pitch between border centres measured from cell and row
border boxes. Borders per cell side = the RESOLVED collapsed border (CSS 2.1 §17.6.2.1: `hidden` wins, then width,
style, origin cell > row > row group > column > column group > table, then left/top), `separate` model → the
cell's own borders. Fill = first painted layer of cell → row → row group → column → column group (gradients
→ linear fill). `paddingPx`, `vAlign` (top/middle/bottom; baseline → top). Cell paragraphs: inline content → one
paragraph, block children / lists → one each (margins → spacing). Extra: `cells[r][c].lines` (same format as text).
A table background/shadow is the preceding `::bg` shape. Anything a cell's paragraphs cannot carry (images,
inline-blocks, positioned/floated boxes, boxes with their own paint, transforms on table parts, content wider than
the cell) is a lint error (`table-content`, `transform`, `text-overflow`) — nothing is dropped silently.

**Charts** — `[data-chart]` is atomic (its SVG preview is not walked): `spec` = the parsed attribute verbatim,
`resolved` = `data-resolved` with `plot` converted to slide px (`plotPx`), `valueMin`, `valueMax`, `majorUnit`.
Errors: invalid JSON/spec, missing `data-resolved`, rotation.

**Images** — `<img>` and outer `<svg>` are atomic; `box` = content box; `alt` = `alt` / `aria-label` / `<title>`.
PNG: isolated 4× render (`<img>`: same `object-fit`/`object-position`, rounded clip baked in; `<svg>`: the `svg`
markup). `svg` (inline SVG only, and `<img src="*.svg">` copied): the **original markup** + `xmlns`, explicit
`width`/`height`, `viewBox`, copies of referenced elements outside it (`<use href>`, `url(#…)` paint servers) in a
`<defs>`, and — only where the page changed something — presentation attributes: each property's computed value in
the page is compared with the value the same markup gets standalone (a twin in a shadow root with `all: initial`),
differences are written as hex / unitless attributes (`image` warn lists them). Author-compliant icons come out byte
for byte as written. Raster fidelity is tested against the in-page pixels (`test_images.mjs`, mean |Δ| ≤ 0.31/255).

**Structure hints** (docs/AUTHORING.md §12; the builder turns them into PowerPoint structure):
- `placeholder` on a text element: `data-placeholder` (`title|ctrTitle|subTitle`, `none` = opt out), else `title`
  for the slide's first `<h1>` in paint order; a second title is a plain text box (`placeholder` warn).
- `field` on a run: `data-field` on the text element or an inline ancestor (`slidenum`); a field run never merges
  with neighbouring text; an unknown type → plain text + `field` warn. `extract.mjs` checks a `slidenum` run shows
  the slide's 1-based index (`field` error otherwise: PowerPoint would display another string).
- `slides[].components`: every element that emitted its own `::bg*`/`::border-*` shape and holds other IR elements,
  and every `[data-group]` element, as `{id, name, hint, members}` (members = IR ids in its subtree, own shapes
  included, from real DOM ancestry — an `#id` step restarts a path, so paths alone cannot tell ancestry).
- `slides[].layout` = `data-layout` of `main.slide`; top-level `theme.colors` = opaque `--pptx-<slot>` custom
  properties of `:root` (dk1 lt1 dk2 lt2 accent1–6 hlink folHlink), from the first slide (`theme-color` warn when a
  later slide differs or a value is not an opaque colour).

**Opacity** = product of the element's and all ancestors' `opacity`; fully transparent objects are not emitted.
**Rotation**: the accumulated 2D matrix of every `transform`/`rotate`/`translate`/`scale` on the element and its
ancestors (about each `transform-origin`); `rotationDeg` from the matrix, the box keeps its size and is moved so its
centre is where Chromium draws the centre (correct for any origin); text lines move with it (unrotated frame). A
self-check maps the layout box through the matrix and compares with the rendered bounding box (`transform-check`).
Non-rigid matrices (scale, skew) and 3D → `transform` error.

## Paint order (`inpage/50-paint.js`)

CSS 2.1 Appendix E per stacking context: own background → z < 0 child contexts → in-flow block backgrounds in tree
order → floats → inline content in tree order (text elements, atomic inlines, flex/grid items in `order`-modified
order, images, charts) → positioned z:auto / z:0 descendants in tree order → z > 0 in z order. Stacking contexts:
positioned + z-index, flex/grid items with z-index, opacity < 1, transforms, filter, blend, isolation, clip-path,
mask, contain, will-change, … . Positioned z:auto boxes, floats and atomic inlines paint "as if" stacking contexts
(their positioned descendants join the parent context).

Limitations (by construction of the IR): a text element is one object at its inline-content step (backgrounds of
inline boxes inside it → `::inline-bg` shapes right before it; atomic inlines inside text right after it); a table
(fills, borders, text) is one object at its block-background step; `z-index < 0` children of a non-stacking-context
`main.slide` with an opaque background are invisible in Chromium and not emitted (`hidden-negative-z`);
`::before/::after`, `outline`, `border-image`, multi-column are not emitted (lint). Verified end to end by pixel probes
(`check_ir.py --pixels`: for every opaque solid shape a point no later element covers must show its colour in the
reference PNG).

## Lint (`severity: error` = not convertible)

Noah additions (errors): `script` (any `<script>` but `src="../lib/chart.js"` or the inert `type="text/x-notes"`, any
`on*` attribute, any `javascript:` URL), `stylesheet` (a `<link rel=stylesheet>` other than `../theme/base.css`,
`../theme/fonts.css`, `../deck.css`; any `@import`), `base-url` (`<base>`), `navigation` (`<meta http-equiv=refresh>`),
`remote-url` (an absolute `http(s):`, `//` or `file:` URL in `src` / `href` / `srcset` / `xlink:href` / `poster` / CSS
`url()`), `csp-violation` (every `securitypolicyviolation`, with the blocked URI and directive), `dom-size` (more than
2,500 elements under `main.slide`; the slide is then not extracted), `asset-too-large` (a served file over 20 MB),
`image-too-large` (a picture over 40 MP, a slide's pictures over 100 MP, an unreadable picture size, or such a base64
`data:` image in a deck HTML/CSS/SVG);
`deck.mjs` adds the pre-checks `slide-name`, `slide-count`, `slide-too-large`, `deck-too-large`. Promoted from the
PoC's warnings to errors: `blocked-request`, `missing-glyph`.

error: `filter`, `backdrop-filter`, `mix-blend-mode`, `clip-path`, `mask`, `gradient-kind` (radial/conic),
`background-image-url`, `background-image`, `background-clip-text`, `border-image`, `text-shadow`, `transform`
(scale/skew/3D/perspective/offset-path, transformed html/body), `border-radius` (non-uniform/elliptical),
`pseudo-content` (`::before/::after` with content, `::first-letter`/`::first-line` styling), `text-overflow`
(scroll size > client size or a line past the content box; table cells too), `out-of-bounds` (object — for text also
its glyph lines — outside 1280×720), `font-family` (not the profile family), `rotated-table`, `rotated-chart`,
`chart-spec`, `chart-resolved`, `table-content`, `unsupported-element` (canvas, video, iframe, form controls…),
`external-image`, `image-load`, `missing-file`, `multi-column`, `writing-mode`, `zoom`, `slide-size`, `field`
(a slide-number field whose text is not the slide's number), `mixed-content` (bare text beside element children —
an anonymous box, `::textN` in the IR), `title-wrap` (a `title`/`ctrTitle` placeholder that soft-wraps),
`font-weight` (a weight no profile has a face for: anything but the fonts.json union 400/600/700/800 —
`opts.kitWeights`). `text-overflow` messages name the fix: the line-height the glyphs need (glyph height − 1, which
reproduces the AUTHORING §4.2 table), a taller box, or a wider box.
warn: `multiple-box-shadows`, `inset-box-shadow`, `shadow-spread`, `shadow-translucent`, `group-opacity`,
`font-weight` (a kit weight the profile has no face for — 600/800 in malgun, expected: `deck.mjs` folds them into one
NOTE line; counts text elements, table-cell runs and chart label/axis weights), `chart-contrast` (a series or point
colour under 3:1 against the chart's composited background), `field`, `placeholder`, `theme-color`,
`line-height-normal`, `fallback-font`,
`non-profile-font`, `not-embedded-glyph`, `inline-background`, `inline-spacing`, `positioned-inline`,
`text-feature` (tabular nums, wavy/coloured decorations, word-spacing, …), `text` (justify, rtl, italic without an
italic face, mixed sizes in a wrapping paragraph, a line pitch ≠ the line-height, atomic inline inside text …), `line-start`, `geometric-marker`
(`disc/circle/square`: use `"• "`), `marker-inside`, `marker-string`, `marker-scheme`, `marker-sequence`,
`marker-content`, `list-style-image`, `list-item-blocks`, `table` (spans with differing borders/backgrounds,
separate borders with spacing, rows shorter than PowerPoint's minimum, rounded tables with filled corners…), `image`
(rounded img, resolved SVG properties, SVG text/filters), `overflow-clip`, `rounded-clip`, `outline`,
`hidden-negative-z`, `transform-check`, `outside-slide`, `animation`, `page-error`, `dsf-layout`,
`extractor-restore`, `baseline-verify`, `image-raster`, `slide-origin`, `chart-content`, `background`, `shape`.

Every entry has `slide`, `severity`, `rule`, `message`, `path` (the element's DOM path / IR id). `deck.mjs` adds lint
it derives from the IR's measured lines (never written into the IR, so the goldens are unaffected): `text-overlap`
(error: the line boxes of two text elements — each line's glyph content area, the font's full ascent-to-descent
height, not the ink — intersect by > 1 px on both axes; the message names the spacing rule for the pair's
arrangement: side by side, stacked, or a wrapped title) and `soft-wrap` (warn: a two-line text whose break cuts a
word). `title-wrap` messages count the Hangul syllables the title's own box holds per line in malgun (1 em each, plus
the letter-spacing) and point a cover title (`ctrTitle`) at AUTHORING §8.13, a slide title at §4.3; `font-family`
messages name the malgun profile's family by what it is — a metric-matched stand-in for 맑은 고딕 (`cmap.mjs`
`familyLabels`), never "the profile font" by its internal name.

The font audit (`inpage/60-fonts.js`) counts only characters Chromium lays out: a collapsible white-space character
counts where its client rect has a width — a collapsed space loads no face (the malgun profile serves U+0020 from a
face of its own), so counting it made an unrequested face "needed". A toolkit face that is `unloaded` is a fault of
the audit (`internal`), and so is one still `loading` when the readiness wait gives up (`ready()` reports each with
its `src`); a toolkit face whose file errors is a `toolchain` fault (reported as a run-time failure of the installed
converter: retry, then the log), any other face the deck's (`browser.mjs` `fontLoadFailure`).

## Files

`extract.mjs` (CLI, per-slide orchestration, glyph coverage) · `extract/server.mjs` (two-root routing, CSP) ·
`extract/chromium.mjs` (the one Chromium / playwright-core / Python resolver) ·
`extract/browser.mjs` (hardened launch, readiness, CDP font check, isolation rasters, raster policy) · `extract/cmap.mjs`
(cmap coverage) · `extract/inpage/00-util.js` (colours, gradients, shadows, radii, matrices) · `05-document.js` (Noah's
document lints) · `10-style.js` (box classification, flow
items, stacking contexts) · `20-text.js` · `30-table.js` · `40-shapes.js` (shapes, images, SVG, charts) ·
`50-paint.js` (paint order, transforms, placement, CSS lint) · `60-fonts.js` · `90-main.js` (`window.__pptx`).
