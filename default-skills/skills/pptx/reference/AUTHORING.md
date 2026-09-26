# Authoring convertible slides (HTML/CSS → editable PowerPoint)

Read this once per conversation, before the first slide. Follow every rule and each slide converts into a .pptx
whose text, shapes, tables and charts are **native, editable PowerPoint objects** that look like the HTML render,
in **both** font profiles. Each rule says *why*, so you can judge a case the list does not cover.

Paths in this file are relative to the pptx skill's base directory (SKILL.md states it as an absolute path):
`examples/business-review/slides/02-kpi.html`, `converter/theme/base.css`. Run the converter exactly as SKILL.md
§5–§6 show (`deck.sh check`, `deck.sh build`); every failure's `Next:` line prints absolute paths. The links
inside slide HTML (`../theme/base.css`) are URLs the converter serves, not files next to your slides.

Reference implementation: `examples/business-review/slides/01-cover.html` … `04-chart.html` (cover, KPI cards,
table, chart), `examples/layouts/slides/01-agenda.html` … `08-closing.html` (agenda, trend and mix charts, section
divider, strategy framework, comparison, timeline, KPI targets, closing — one complete plan),
`examples/handbook/slides/01-org.html` … `03-contacts.html` (org chart, week schedule, directory — reference
content) and the tokens and components in `converter/theme/base.css`. `examples/README.md` maps kinds of content to
the closest slide.

---------------------------------------------------------------------------------------------------------------

## 0. How the converter sees your slide

```
<deck>/slides/NN-name.html ──(headless Chromium, one font profile per run)──▶ IR (boxes, runs, lines, fills…) ──▶ PPTX builder ──▶ gates
```

- The converter renders the slide in Chromium at 1280×720, **walks the DOM** and turns every element into a
  PowerPoint object: an element with a background/border/shadow becomes a **shape**; the nearest element whose
  children are only inline text becomes a **text box** (one per block); `<table>` becomes a **table**; inline
  `<svg>`/`<img>` become **pictures**; `[data-chart]` becomes a **native chart**. It copies measured positions,
  fonts, colours and — crucially — **where each line broke**.
- Two font profiles are built from the same HTML: `embedded` (Pretendard, embedded into the .pptx; the default)
  and `malgun` (the .pptx names 맑은 고딕; the HTML is measured with a metric-matched free stand-in). The **same
  markup must work in both**; Hangul text is up to 20 % wider in `malgun` (§4.3). `deck.sh check` renders one
  profile per run (`--profile both` renders both); each `build` builds one profile.
- Anything that has no native PowerPoint equivalent is a **lint error** — it cannot become an editable object,
  so don't use it, even if it looks nice in the browser.
- The page is sandboxed: only the kit (`/theme/`, `/lib/`, `/fonts/`) and your deck folder are served, every
  other request is blocked, and a Content-Security-Policy lets no script run except the chart renderer. The lint
  says what was blocked and why (§2).

## 1. File skeleton (copy it)

```html
<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>NN 슬라이드 이름 · 덱 제목</title>
<link rel="stylesheet" href="../theme/base.css">
<link rel="stylesheet" href="../theme/fonts.css">
<link rel="stylesheet" href="../deck.css">   <!-- only when the deck has a deck.css (§9) -->
<style>
  /* slide-specific composition only; reuse the base.css tokens and components */
</style>
</head>
<body>
<main class="slide" data-layout="본문">
  …everything visible…   <!-- a picture: <img src="../assets/team.jpg" alt="…" style="width: 480px; height: 320px"> -->
</main>
<template id="notes">
One line per notes paragraph, written flush left.
A second paragraph.
</template>                                  <!-- optional speaker notes -->
<script src="../lib/chart.js"></script>      <!-- only on a slide with a [data-chart] element -->
</body>
</html>
```

| rule | why |
|---|---|
| Link **exactly** `../theme/base.css` and `../theme/fonts.css` (+ `../deck.css` when the deck has one); no other `<link>`, no `@import`, no `<base>`, no `<meta http-equiv="refresh">`, no web-font CDN, no remote URLs | The converter serves only the kit and your deck folder and **blocks every other request** (lints `stylesheet`, `remote-url`, `blocked-request`, `base-url`, `navigation`). `theme/fonts.css` does not exist on disk: the converter serves the active profile's font CSS under that name, which is how one HTML file renders with two font profiles. Opening a slide straight from disk therefore shows the wrong fonts — look at the `deck.sh check` renders instead. A link to a `../deck.css` that does not exist is a `missing-file` error. |
| One `<main class="slide">` (1280×720 CSS px at the page origin); nothing visible outside it | 1 CSS px = 9525 EMU: the slide *is* the PowerPoint slide. `base.css` sizes it; do not resize it. |
| `<html lang="ko">`, `<meta charset="utf-8">` | Korean line-breaking and correct decoding. |
| Scripts: only `<script src="../lib/chart.js"></script>`; no inline `<script>`, no `on*=` handler, no `javascript:` URL | The converter reads a static DOM, and its Content-Security-Policy runs only the chart renderer, which draws an in-page preview of the native chart (lints `script`, `csp-violation`). |
| Slide CSS in one inline `<style>`; inline `style=""` attributes are fine | Computed styles are what counts, not where they are written. |
| Pictures and other files from `../assets/` | Relative URLs into the deck folder are served; each file ≤ 20 MB (`asset-too-large`), each picture ≤ 40 megapixels and one slide's pictures ≤ 100 megapixels together (`image-too-large`). |
| Speaker notes in `<template id="notes">` | Its text becomes the slide's notes: each line one paragraph (leading spaces are kept, so write lines flush left), an empty line an empty paragraph. A template never renders. The converter also reads `[data-notes]`, `aside.notes` and `<script type="text/x-notes">`; use the template. |

## 2. Lint rules — errors are not convertible

Each lint item names the slide, the element (its DOM path, e.g. `main > … > p.stat-value`) and the rule. Errors
fail `check` and `build` (exit 1); warnings are reported — understand each one.

**Constructs PowerPoint cannot hold:**

| lint | severity | why it fails |
|---|---|---|
| `filter`, `backdrop-filter`, `mix-blend-mode` | error | DrawingML shapes have no blur-behind, colour filters or blend modes the builder can emit. |
| `clip-path`, `mask` | error | No clipping of shapes/text in DrawingML; the result would show unclipped content. |
| `gradient-kind`: `radial-gradient`, `conic-gradient` (also `repeating-*`, several background layers) | error | Only linear gradients are mapped. |
| `background-image-url`: `background-image: url(…)` | error | Background pictures are not walked; use an `<img>`/inline `<svg>` element (it becomes a picture). |
| `text-shadow` | error | Not mapped to a text effect; text must render the same without it. |
| `transform` other than `rotate()` / `translate()` (no scale, skew, 3D, `scale:`) | error | PowerPoint's shape transform has position + rotation only; a scaled element's measured text would not match. |
| `border-radius`: non-uniform, elliptical (`20px / 10px`), % other than `50%` | error | Only a rounded rectangle (one radius) and an ellipse (`50%`) exist. |
| `pseudo-content`: `::before` / `::after` with `content` | error | Generated content is not in the DOM the converter walks — it would silently disappear. |
| `multiple-box-shadows`, `inset-box-shadow`, `shadow-spread`, `shadow-translucent` | warn | Only the first outer shadow is mapped; spread is not representable; PowerPoint casts shadows from the rendered alpha, CSS from the border box. |
| `text-overflow`: any element with `scrollWidth > clientWidth` or `scrollHeight > clientHeight` | error | Text that does not fit its box lands somewhere else in PowerPoint. **Includes the glyph content area** — see §4.2, the #1 trap; the message says which fix applies (the line-height the glyphs need, a taller box, or a wider box). |
| `title-wrap` | error | A slide title (`title`/`ctrTitle` placeholder) that wraps without `<br>`: it pushes the header into the content (§4.3; the cover title §8.13). The message says how many Hangul syllables the title's box holds per line in `malgun`. |
| `text-overlap` | error | The line boxes of two elements' text intersect — each line's full font height (ascent to descent, 1.33 em in `malgun`), not only the ink, so the render may still look clear; PowerPoint places the lines as the render does. The message names the rule for the pair: side by side → ≥ 16 px between a line's end and the next text (§4.3); stacked → each text in its own box at a line-height ≥ 1.33 × its size (§4.2); a wrapped title → its `title-wrap` fix. |
| `mixed-content` | error | Bare text beside element children (`<div class="row">매출 <p class="pill">…</p></div>` in a flex row): wrap the text in its own element (§5.1). |
| `font-weight` | error | A weight outside 400/600/700/800 (500, 900, `bolder` on 800): no profile has a face for it (§4.1). |
| `out-of-bounds`: anything outside the 1280×720 slide | error | Nothing may bleed off the edge (no half-visible decorative circles); PowerPoint would show it on the pasteboard. |
| `field` | error | A slide-number field that does not show the slide's position (§8.2). |

**Sandbox and size rules:**

| lint | severity | what triggers it — and the fix |
|---|---|---|
| `script` | error | any `<script>` except `src="../lib/chart.js"` (or the inert `type="text/x-notes"`); any `on*` attribute; any `javascript:` URL. Delete it: slides are static. |
| `stylesheet` | error | a `<link rel="stylesheet">` other than `../theme/base.css`, `../theme/fonts.css` or `../deck.css`; any `@import`. Put the CSS into the slide's `<style>` or `deck.css`. |
| `base-url` | error | a `<base>` element. |
| `navigation` | error | a `<meta http-equiv="refresh">`. |
| `remote-url` | error | an absolute `http:`/`https:`, a protocol-relative `//` or a `file:` URL in `src`, `href`, `srcset` or a CSS `url()`. Copy the file into `assets/` and use `../assets/<file>`. |
| `csp-violation` | error | the page tried something the Content-Security-Policy forbids; the message names the blocked URL and directive. |
| `blocked-request` | error | a request outside the kit and the deck folder was aborted (a typo'd path, a `..` escape, a remote font). |
| `missing-file` | error | a referenced file does not exist. |
| `asset-too-large` | error | a requested file is over 20 MB: shrink or re-encode it. |
| `image-too-large` | error | a picture has more than 40 megapixels, the pictures of one slide have more than 100 megapixels together, or a picture's size cannot be read (a damaged file) — also a base64 `data:` image inside the slide or `deck.css`. It was not loaded: downscale it (the slide shows at most 2560 px of a picture) or re-save it as PNG/JPEG. |
| `dom-size` | error | more than 2,500 elements under `main.slide`: simplify the slide or split it. |
| `missing-glyph` | error | a character no face of the profile has — it would render in a fallback font (§4.5). |

**Pre-checks** (exit 1 before anything renders): `slide-name` (a file in `slides/` not named `NN-name.html`, or
a duplicate `NN`), `slide-count` (more than 60 slides), `slide-too-large` (a slide HTML over 2 MB),
`deck-too-large` (`slides/` + `deck.css` + `assets/` over 100 MB).

**Other errors** name the construct: `background-image`, `background-clip-text`, `border-image`, `font-family`
(§4.1), `rotated-table`, `rotated-chart`, `chart-spec` / `chart-resolved` (§8.10), `table-content` (§8.9),
`unsupported-element` (canvas, video, iframe, form controls), `external-image`, `image-load`, `multi-column`,
`writing-mode`, `zoom`, `slide-size`.

The check also enforces what the text-mapping requires: `font-family` must be `var(--font-sans)`;
`font-weight` ∈ {400, 600, 700, 800}; `line-height` explicit (never `normal`); `word-break: normal`; text never
mixed with non-inline children; every glyph drawn by the profile's own font files (no system fallback); inline
`<svg>` with explicit `width`/`height`; table cells hold text (§8.9).

Warnings worth knowing: `soft-wrap` (a two-line text whose break cuts a word, §5.3), `chart-contrast` (a series
colour under 3:1 on its background, §8.10), `fallback-font`, `not-embedded-glyph`, `line-height-normal`, `text`
(justify, italic without an italic face, mixed sizes in a wrapping paragraph …), `geometric-marker` (use the
`"• "` marker), `list-item-blocks` (§5.4), `group-opacity` (§6), `inline-background` (§5.2), `image`,
`placeholder`, `theme-color`. The malgun profile's `font-weight` notes for 600/800 are expected: the check folds
them into one `NOTE malgun weights` line (§4.1).

## 3. Rendering rules in `converter/theme/base.css` — never override them

| rule (in base.css) | why |
|---|---|
| Chromium runs with `--font-render-hinting=none`, plus `text-rendering: geometricPrecision` | Default hinting rounds every glyph advance to whole px (−6.6 … +4.2 % width error per run); PowerPoint uses the font's own advances. |
| `font-kerning: none` | The builder writes unkerned runs; both sides lay text out unkerned (Pretendard kerning changes a line by up to 1.8 %). |
| `font-variant-ligatures: none` | PowerPoint applies no ligatures; `none` also switches off contextual alternates. |
| `word-break: normal` (**not** `keep-all`), `overflow-wrap: normal`, `line-break: auto` | PowerPoint breaks Hangul between syllables; `keep-all` would break differently. |
| explicit `line-height` on `body` and every text component (px) | Every text element must resolve to px: the builder derives PowerPoint's line spacing and the baseline seat from it. |
| `sup, sub { font-size: .58em; line-height: 0 }` | PowerPoint draws baseline-shifted runs at ~58 %; `line-height: 0` keeps the line box equal to the paragraph's. |
| `ul { list-style-type: "• " }` | A string marker makes Chromium draw the same `•` glyph PowerPoint draws (`disc` is a geometric dot of another size). |
| `b, strong { font-weight: 700 }` | The browser default `bolder` turns a 600 parent into 900 (a face you did not intend). |
| `font-synthesis-weight: none` | Never fake bold: every weight maps to a real face in both profiles. |

## 4. Typography

### 4.1 Family and weights
- Always `font-family: var(--font-sans)` (inherited from `body`; never name a font). Weights **400, 600, 700, 800**
  only. Face mapping: `embedded` → Pretendard Regular / SemiBold / Bold / ExtraBold; `malgun` → 맑은 고딕 Regular
  (400) and **Bold for 600, 700 and 800 alike**.
- Consequence: in `malgun`, 600/700/800 look identical. **Build hierarchy with size and colour first**, weight
  second (the examples use 40 px/800 titles vs 16 px/600 labels vs 14 px/400 captions — distinct in both profiles).
- Expected notes: the `malgun` profile has only 400/700 faces, so 600/800 text is drawn with 맑은 고딕 Bold — by
  design (the builder resolves the nearest face exactly as the browser does). The check prints ONE
  `NOTE malgun weights` line for them (the entries stay in the report); nothing to fix. A weight outside
  400/600/700/800 is a `font-weight` error in both profiles.
- No italics (`em`, `i`, `font-style`): neither profile has italic faces, and Chromium's and PowerPoint's synthetic
  obliques differ. No `text-transform` — write the text as it should appear.

### 4.2 Line-height: explicit px, and at least the tallest profile's content area (the #1 trap)
The malgun stand-in has Malgun Gothic's vertical metrics: ascent + descent = **1.33 em**. Chromium counts a line's
glyph content area as scrollable overflow, so **any line-height smaller than that makes the element report
`scrollHeight > clientHeight` — a `text-overflow` error in the `malgun` profile**, even though nothing is visibly
clipped (44 px numbers at 52 px line-height fail only in `malgun`). Minimum line-height (identical for weights 400
and 800):

| font-size (px) | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 20 | 22 | 24 | 28 | 32 | 36 | 40 | 44 | 48 | 52 | 56 | 60 | 64 | 72 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| min line-height, malgun | 15 | 16 | 17 | 19 | 20 | 21 | 23 | 26 | 28 | 31 | 36 | 42 | 47 | 53 | 58 | 63 | 69 | 74 | 79 | 84 | 94 |
| min line-height, embedded | 13 | 14 | 15 | 17 | 18 | 19 | 20 | 23 | 25 | 28 | 33 | 37 | 42 | 47 | 52 | 57 | 61 | 66 | 70 | 75 | 85 |

Rule of thumb: **line-height ≥ 1.33 × font-size, rounded up** (then snap to the 4 px grid). The base.css type scale
complies: display 60/80, title 40/56, stat 44/60, hero stat 48/64, lead 22/32, body 18/28, dense 16/24,
label/caption 14/20, footer 12/16. For a smaller inline run inside a big line (a unit after a number) set
`line-height: 1` on the run — PowerPoint sizes each line from its largest run, and CSS then does too. When a
`text-overflow` error comes from this trap, its message names the line-height the glyphs need ("raise line-height
to at least 58px"): widening or enlarging the box does not fix it.

**Long paragraphs: pick a line-height PowerPoint reproduces exactly.** PowerPoint stores line spacing as a whole
percent of its 1.2 × font-size line, so each further line of a paragraph lands (whole percent × 1.2 × size −
line-height) px off Chromium's, and the error adds up; the conversion check allows 0.25 px per baseline. Per pair:
16/24 = exactly 125 % (any number of lines); 14/20 −0.008 px per line; 13/20 −0.03; 22/32 −0.056 (≤ 5 lines);
18/28 and 20/28 +0.08 (≤ 4 lines); 17/26 −0.09 (≤ 3 lines); 40/56 +0.16 (≤ 2 lines). A longer paragraph (or list
item) is reported as fidelity drift: still delivered, with its last lines fractionally off, while `--strict`
builds fail. For running text of 5+ lines use 16/24 (the layouts example's lead paragraph does).

### 4.3 Width: design for the wider profile
Measured on the business-review example (104 single-line texts): `malgun` width / `embedded` width = mean
**1.09**, max **1.20** (Hangul-heavy bold text: every title is 1.19–1.20×), min 0.89 (digits: Malgun's are
narrower). Therefore:
- Size every fixed-width container so its text fits at **1.2 × the Pretendard width** — or check both profiles
  (`deck.sh check --profile both` fails on overflow in either).
- Keep **≥ 16 px clearance** between a line's end and any neighbouring object in the wider profile.
- A slide title must stay on ONE line in both profiles: a second line pushes the header into the content (a
  `title-wrap` error, usually with a `text-overlap` error for what it runs into). At 40/56·800 a Hangul syllable is
  ≈ 40 px wide in `malgun` (≈ 33 px in `embedded`), so about 20 syllables fit next to a context chip and about 26
  without one — keep titles shorter than that and check `malgun`. A `title-wrap` error counts it for the title's
  own box and size: the Hangul syllables one `malgun` line holds, spaces not counted (each takes about a third of a
  syllable). Text of two elements whose line boxes intersect (the full font height, not only the ink) is a
  `text-overlap` error in either profile.
- A single line in a **fixed-width container** (a title, an eyebrow, a caption, a label, a meta value) becomes a
  wrapping text box at the HTML width when PowerPoint's line stays ≥ 2 % inside it: the existing line cannot
  reflow, and a line the user lengthens wraps inside its container, as in the HTML — and shrinks to fit when the
  extra line no longer fits the box (PowerPoint's *Shrink text on overflow*; the box is 5 % taller than its text,
  so the unedited text never shrinks). A text whose box follows its content (a pill, a legend label, a footer
  note, a card title in a shrink-wrapped column) or that is `white-space: nowrap` (big numbers) does not wrap: it
  grows instead, also as in the HTML. Either way a slightly different PowerPoint advance only shifts the line end
  by a fraction of a percent.
- Keep ≥ 2 % free room in a fixed-width box (≈ 4 px in a 214 px KPI card) in the wider profile, or the line stays
  non-wrapping and an edited line runs out of its container in PowerPoint.

### 4.4 Letter-spacing, sizes
- `letter-spacing` is fine (it maps to character spacing); use the tokens (`--tracking-tight: -0.02em` for titles
  and big numbers, `--tracking-label: 0.06em` for section labels, `--tracking-caps: 0.12em` for Latin caps).
- Font sizes from the token scale; nothing below 12 px.

### 4.5 Characters
Use characters that exist, with similar widths, in Pretendard **and** Malgun Gothic: Hangul, ASCII,
`· • – — ▲ ▼ ① ■ ● ◆ ~ % ÷ × ±`.
- Avoid **`−` U+2212** (not in Malgun Gothic → PowerPoint falls back to another font). Write negatives with an
  en dash `–4.7%` (or `▼ 4.7%`).
- Avoid `↑ ↓` (stand-in 0.60 em vs Malgun 0.95 em) and `※ →` in text that wraps (width differs by 5–20 %). A
  `→` inside one line with room to spare (a subtitle, a chip) is fine; between two figures in a tight row, draw
  the arrow as an inline SVG icon instead (§8.17).
- No Hanja in body text (Pretendard has none; PowerPoint substitutes a system CJK font) and **no emoji** (no face
  has them). Pretendard also lacks `◎ ☞ ㉠ ㉡ ≒ ∴ ∵` (맑은 고딕 has them): avoid them in the embedded profile, and
  build Hanja-heavy decks with the `malgun` profile (§15).

## 5. Text structure

### 5.1 Leaf text blocks
Text lives in **leaf text elements**: an element whose children are only text and inline tags (`span b strong
em i u s a code small sup sub br`). Each becomes one PowerPoint text box.
- ✅ `<p class="stat-value">1,284<span class="stat-unit">억 원</span></p>` — one paragraph, two runs.
- ✅ `<div class="kpi-top"><div class="icon-badge"><svg …/></div><p class="pill pill--up">▲ 12.4%</p></div>` —
  a flex row whose children are *elements* (whitespace between tags is fine).
- ❌ `<div class="row">매출 <span class="pill">▲ 12%</span></div>` in a flex container — bare text next to an
  element child (`mixed-content`: write `<p>매출</p>`); ❌ `<p>텍스트 <svg/></p>` — a picture inside a paragraph
  (it becomes a separate object that does not reflow with the text); ❌ a picture, a painted box or an
  inline-block inside a table cell (`table-content`, §8.9).

### 5.2 Inline runs carry run properties only
An inline element may change **colour, size, weight, letter-spacing, underline/strike, baseline (sup/sub)** —
exactly what a PowerPoint run can hold. No background, border, padding or margin on inline elements: PowerPoint
runs have no box. Anything with a box (a pill, a tag, a highlight chip) is its **own block element** next to the
text. Spacing between runs = a real space character.

### 5.3 Prefer hard line breaks; never rely on soft wraps matching
- A block whose every line ends at a `<br>` or at the end of a paragraph cannot reflow in PowerPoint: its lines are
  PowerPoint line breaks. When every line stays ≥ 2 % short of its box and the box's width is its container's (not
  `nowrap`, not shrink-to-fit — single lines included, §4.3), the box wraps at the HTML width, so a line the user
  lengthens wraps inside its container. The business-review example is authored that way.
- If a text must soft-wrap, the builder picks a box width at which PowerPoint's breaker reproduces Chromium's
  lines — and the two profiles will usually break at **different** places, often inside a word (the layouts
  example's lead paragraph: 3 lines in `embedded`, 4 in `malgun`). Leave room below it for the extra line of the
  wider profile, and use 16/24 for 5+ lines (§4.2). `deck.sh check` prints every soft-wrapped block with " / " where
  it breaks and the words a break cuts; a two-line text whose break cuts a word ("전략기획 / 실" — a label or
  caption that almost fits) is a `soft-wrap` warning. `--profile both` lists the blocks that wrap differently.
  Where the break matters: split it at a natural phrase boundary with `<br>`, widen the box, use a smaller size,
  or give the text two semantic lines (bold lead + detail, §8.11). Shortening the text is the last resort — keep
  every figure and fact it states, and re-read the claim afterwards.
- Multi-line paragraphs keep **one font size** (PowerPoint's line spacing scales with the largest run on each
  line; mixing sizes across lines drifts). Mixed sizes on a single line are fine.
- No `text-align: justify` (PowerPoint's Korean justification is unmeasured).

### 5.4 Lists
`<ul>` is **one** text element; each `<li>` is a paragraph with the `"• "` bullet. `padding-left` of the `<ul>`
must be **≥ the marker advance: 0.77 em** (12.2 px at 16 px, 13.0 px at 17 px, both profiles) — the bullet then
sits at `padding-left − advance` in both engines; less would push it outside the text box. Space between items:
`li + li { margin-top }`. Don't style `::marker`; the bullet takes the text colour. Numbered lists: `<ol>`, ≤ 9
items (Chromium right-aligns `10.` markers, PowerPoint doesn't). A list item that holds blocks (`<li><div>…`) is
not a convertible list (`list-item-blocks`): use plain rows (`div`s) for structured items, as the agenda does.

## 6. Layout

- Grid: 1280×720, **80 px side margins** (1120 px column), **8 px spacing grid**. Content slides: header at y 56
  (section label 14/20 + title 40/56), content from y 184, footer rule at y 664 (`--header-top`, `--content-top`,
  `--footer-top`). Keep these consistent so slides feel like one deck.
- Absolute positioning and flex/grid are both fine — the converter measures rendered boxes. Fixed heights are fine
  for containers **if** the content fits in both profiles (the overflow lint checks every element).
- Everything must be **inside** the slide — decorative shapes too (compose inside the frame).
- Single-line text keeps the edge your layout anchors: the last item of a `space-between`/`flex-end` row, a
  `margin-left: auto` item, or any text in a right-anchored group (the footer's "note · page number") is written
  right-aligned, so if PowerPoint's line is a fraction wider it grows **away** from the right margin. A text that
  shares a moving group with a shape or icon (a legend label beside its swatch) stays left-anchored to that
  shape. Keep a gap between neighbouring single-line texts of at least ~2 % of the growing text's width (the
  malgun stand-in's worst measured width error vs real Malgun Gothic is 1.9 %, ≈ 6 px on a 300 px line; the
  examples use 16 px).
- Paint order = DOM order (first = back): put decorative shapes first in `<main>`.
- `opacity` on a container is discouraged (CSS composites the group, PowerPoint applies alpha per object); put
  the alpha into each colour (`rgba()`) instead.

## 7. Shapes, colour, effects, pictures

| element | how | why |
|---|---|---|
| rectangle / rounded rectangle | `background` + **one** uniform `border-radius` in px | → rectangle / rounded rectangle; the radius is clamped at min(w,h)/2 exactly like CSS (`999px` = pill). |
| circle / ellipse | `border-radius: 50%` (square box for a circle) | → ellipse. These three are the only geometries: no chevrons, arrows or triangles. |
| borders | **integer px** widths, `solid` (dashed/dotted map but their phase differs) | Chromium snaps border widths to whole px (1.5 → 1, 2.5 → 2), so the render would not be what you wrote. A one-sided border (divider) becomes a thin filled rectangle. |
| colour | hex or `rgba()`; alpha maps to shape/text transparency | Keep text colours opaque unless the translucency is intentional (white 64 % on a dark panel is fine). |
| gradient | `linear-gradient(<angle>, c1 0%, c2 100%)` — two opaque stops preferred | Maps to a linear gradient fill. Transparent stops are unproven in PowerPoint. |
| shadow | one outer `box-shadow: 0 8px 24px rgba(…, .07)` with spread 0, on an **opaque** box | Maps to PowerPoint's outer shadow. Keep shadows soft and subtle: PowerPoint's blur differs slightly from CSS. |
| rotation | `transform: rotate(…)` only (no tables/charts) | Tables and chart frames cannot rotate in Office. |
| icons | inline `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2A52D9" …>` | Becomes a picture (a 4× PNG plus the native SVG). The SVG must be self-contained: **literal** colours (no `currentColor`, no `var()`, no classes), one colour, no `<text>`. |
| photos / raster art | `<img src="../assets/<file>" alt="…">` with an explicit CSS size | Becomes a picture, rendered at up to 4× its CSS size and at most 2560 px on its longest side. A JPEG source that fills its box (`object-fit: fill` or `cover`, no `border-radius`, opacity 1) stays JPEG; anything else becomes PNG. Use JPEG photos at a sensible size: the built .pptx must stay ≤ 30 MB. An empty `alt` marks the picture decorative; give meaningful pictures an `alt`. |

## 8. Component patterns (all in `converter/theme/base.css` or in the examples' `<style>`)

Each is built only from convertible parts: shapes (boxes), leaf text blocks, pictures, a table, a chart. The
business-review example shows 8.1–8.13, the layouts example 8.14–8.21.

**8.1 Slide header** — section label + action title (+ optional context chip on the right).
```html
<header class="slide-header">
  <p class="eyebrow"><span class="eyebrow-num">01</span> 핵심 지표</p>
  <div class="title-row">                                                    <!-- flex row: title | chip -->
    <h1 class="slide-title">매출과 영업이익 모두 두 자릿수 성장</h1>
    <p class="pill pill--outline period">2026년 3분기 · 전년 동기 대비</p>
  </div>
  <p class="slide-sub">…the evidence for the headline, one line…</p>             <!-- optional -->
</header>
```
The title and the chip share `.title-row` (flex, `align-items: flex-end`, 24 px gap; the title `flex: 1`): the
title's box ends before the chip, so a longer title wraps there instead of running under the chip — in the HTML
and in PowerPoint, whose title placeholder gets the same width. With a `.slide-sub` the header ends at y 168:
start the content 32 px below it (business-review slide 3: table at y 200) — the header must not press into the
content. The title states the takeaway (a headline), the label names the topic; when the headline rests on one
figure, put that evidence in `.slide-sub` (16/24, ink-600, key numbers `<strong>`) — not in the small context chip.
The `<h1>` becomes the slide's **title placeholder** (§12). The context chip on the ink-50 page is `.pill--outline`
(white + 1 px brand-200 outline): a brand-50 tint chip is invisible there (1.02:1). **No accent bar under the
title** (an AI-slide cliché; the label + whitespace carry the hierarchy).

**8.2 Footer** — brand mark (two circles), deck name, sample-data note, page number; a 1 px rule on top.
```html
<footer class="slide-footer" id="footer">
  <div class="footer-left"><div class="mark mark--sm" data-group="브랜드 마크"><div class="mark-a"></div><div class="mark-b"></div></div>
    <p class="footer-brand">예시테크</p><p class="footer-text">2026년 3분기 사업 실적 보고</p></div>
  <div class="footer-right"><p class="footer-text">샘플 데이터 · 가상 기업의 예시 수치</p>
    <p class="page-num" data-field="slidenum">2</p></div>
</footer>
```
The page number is a **slide-number field** (`data-field="slidenum"`, §12): PowerPoint renumbers it when slides
are moved, inserted or deleted. Write exactly the number PowerPoint will show — the slide's position, **no zero
padding** (`2`, not `02`); the check fails with `field` otherwise, so renumber after inserting, deleting or
reordering slides. Keep the footer identical on every content slide — the page number sits in a fixed 16 px box
(`.page-num { min-width }`) so the note beside it does not move with the digit widths, and a caveat that concerns
one slide goes next to what it qualifies (business-review slide 4: "단위: 억 원 · 4분기는 전망치" under the chart
title), not into the footer. The builder then moves the whole footer into the slide layout (§12), so a slide added
in PowerPoint gets it too — keep `id="footer"`: it gives the footer the same identity on every slide, however many
sections precede it.

**8.3 Card** — `.card`: white, radius 20, one soft shadow. No coloured side stripe (cliché), no border + shadow +
tint stacks.

**8.4 KPI card** — icon badge + delta pill on top, label, big number with a smaller unit run, a prior-vs-current
micro-visual, divider + caption pinned to the bottom (`margin-top: auto` in a flex column). Height fixed (288 px)
and verified in both profiles. The KPIs the slide title claims lead (`.kpi--hero`: brand-900 card, white text, the
`--up-on-dark` pill — `--down-on-dark` for an unfavourable change —, a glass icon badge); the micro-visual is two
bars on one scale (the larger value = the full track), built from rect shapes only (`data-group` makes them one
PowerPoint group) — it fills the band between the number and the divider with data instead of whitespace. Drawn
bars do not follow an edited number: name their group with the values they encode and that they are resized by
hand (the `data-group` value is the Selection Pane name).
```html
<article class="card kpi kpi--hero">
  <div class="kpi-top">
    <div class="icon-badge icon-badge--sm icon-badge--glass"><svg … width="20" height="20" stroke="#FFFFFF" …>…</svg></div>
    <p class="pill pill--up-on-dark">▲ 12.4%</p>
  </div>
  <p class="stat-label">매출액</p>
  <p class="stat-value">1,284<span class="stat-unit">억 원</span></p>
  <div class="kpi-bars" data-group="비교 막대 — 전년 1,142 · 올해 1,284 (수치 수정 시 길이 직접 조정)">
    <div class="kpi-bar"><p class="kpi-bar-label">전년</p><div class="kpi-bar-track"><div class="kpi-bar-fill" style="width: 88.9%"></div></div></div>
    <div class="kpi-bar"><p class="kpi-bar-label">올해</p><div class="kpi-bar-track"><div class="kpi-bar-fill is-current" style="width: 100%"></div></div></div>
  </div>
  <p class="caption kpi-foot">전년 동기 1,142억 원</p>           <!-- border-top = divider -->
</article>
```

**8.5 Pill** — `.pill` + `.pill--up | --down | --brand | --outline | --glass | --up-on-dark | --down-on-dark`: a
block with padding, `border-radius: 999px`, 13/20 px bold text, `white-space: nowrap`. Up = green on green tint,
down = red on red tint, `--up-on-dark` / `--down-on-dark` the same pair on dark surfaces, `--brand` (brand-50 tint)
only on white surfaces, `--outline` (white + brand-200 border) on the ink-50 page. **Pick the pill by
favourability, not direction**: the colour says good or bad, the ▲/▼ says up or down — a churn, cost or complaint
increase is `▲ 0.9%p` in `pill--down` (`pill--down-on-dark` on a dark card), a cost cut `▼ 12%` in `pill--up`.
It becomes a rounded rectangle + a one-line text box, grouped (§12); never place it inline inside a sentence
(§5.2).

**8.6 Icon badge** — `.icon-badge` 48 px (`--sm` 40 px) circle in the brand tint, one inline SVG centred by flex.
Icons: 24 px grid, 2 px round strokes, one brand colour.

**8.7 Stat** — `.stat-label` (16/24, 600, grey) / `.stat-value` (44/60, 800, tight tracking) with `.stat-unit`
(20 px, 700, `line-height: 1`) / `.caption` (14/20). Numbers: Korean style `1,284억 원` (unit attached, no space
before 억).

**8.8 Summary box** — `.summary`: brand-50 tint, radius 16, flex row with a small white icon badge and one
`.summary-text` paragraph: a bold lead-in run (`<strong>종합 평가</strong>`) then one or two sentences, one sentence
per line via `<br>` so both profiles break identically.

**8.9 Data table** — `.data-table` on a real `<table>` with `<colgroup>` widths:
- header row: `th` dark fill (`--c-brand-900`), white 15 px bold; first column left, numbers right-aligned; write
  it with `<th>` cells — a first row of `<th>` becomes PowerPoint's header row (Table Design > Header Row, the
  Accessibility Checker, screen readers' column headers);
- body: `td` 17/24 px, `border-bottom: 1px` rules; current-period column 600 + dark, prior-period muted;
- coloured deltas as **runs**: `<td><span class="up">+27.4%</span></td>`, `<span class="down">–4.7%</span>`;
- highlight row: `tr.is-highlight td { background }`; total row: `tr.is-total` bold with `border-top: 2px`;
- a table-level white background + soft shadow on the `<table>` itself: the builder writes the background INTO the
  table (every cell without its own fill gets it) and the shadow as the table's own shadow, so inserted rows and a
  moved or resized table keep both; **no radius** and an opaque, single-colour background (anything else stays a
  separate shape behind the table, which cannot follow it); text-only cells (`table-content` otherwise); every cell
  one line with ≥ 30 % horizontal slack (a cell that wraps in PowerPoint grows its row);
- units and definitions in a `.footnote` below (13/20 px);
- a table of words, not figures (a schedule, a directory): add `.data-table--text` (every column left-aligned) and
  give the table the width it needs (`style="width: 704px"`, or a slide rule) — `.data-table` alone right-aligns
  every column but the first and spans the 1120 px column;
- `deck.sh check` prints a `table cells:` line: cells that wrap or keep less than 30 % of their width free in the
  checked profile (report `tableCells`) — widen the column or shorten the text;
- a cell holds text: inline runs, or block children that each become a paragraph; a picture, a painted box
  (background/border), an inline-block or a positioned element inside a cell is `table-content`.

**8.10 Chart panel** — a `.card` holding a header (`.card-title` + `.card-sub` unit line on the left, an **HTML
legend** on the right) and the chart element:
```html
<div class="legend" data-group="범례">
  <div class="legend-item"><div class="swatch" style="background:#8A94A6"></div><p class="legend-label">2025년</p></div>
  …
</div>
<div class="chart" data-chart='{"type":"column","grouping":"clustered","categories":["1Q","2Q","3Q","4Q"],
  "series":[{"name":"2025년","values":[1012,1087,1142,1236],"color":"8A94A6"},
            {"name":"2026년","values":[1148,1209,1284,1410],"color":"2A52D9"}],
  "pointColors":{"1":["2A52D9","2A52D9","2A52D9","6F8FF0"]},
  "dataLabels":{"show":true,"numberFormat":"#,##0","position":"outEnd","color":"344056","sizePx":13,"cssWeight":600},
  "valueAxis":{"visible":false,"min":0,"max":1600},
  "categoryAxis":{"visible":true,"labelColor":"667085","sizePx":14,"lineColor":"C9D0DB"},
  "legend":{"position":"none"},"gapWidth":90,"overlap":-8,"fontCssWeight":400}'></div>
…
<script src="../lib/chart.js"></script>
```
Chart spec: `type` `column|bar|line|pie|doughnut`, `grouping` `clustered|stacked`, `categories`, `series` (`name`,
`values` — `null` for a gap —, `color`); optional `pointColors`, `dataLabels`, `valueAxis` (`visible`, `min`,
`max`, `numberFormat`, `gridlines`), `categoryAxis`, `legend`, `gapWidth`, `overlap`, `holeSize`,
`fontCssWeight`. The chart becomes a native chart with an embedded workbook (PowerPoint's Edit Data works).
One `dataLabels` block styles the labels of every series (format, colour, size, position). A `line` chart draws
3 px lines with round markers, and `outEnd` puts each label above its point. A `doughnut` takes `holeSize` (%),
its slice colours as `pointColors["0"]` and never a label position (its labels sit on the ring); for small slices
use `dataLabels.show: false` and put the values into the HTML legend (§8.15).
Chart rules: the element has explicit width/height and **nothing inside it** (it is atomic; `lib/chart.js` draws
the preview); colours are `RRGGBB` without `#`; give explicit `valueAxis.min/max` (PowerPoint must not auto-scale
what the HTML shows; leave headroom when users will edit values upward — values above the maximum are clipped);
`pointColors` = series index → a **full** per-point colour list (here: the forecast bar in a lighter tint); every
series / point colour ≥ **3:1** on the card (WCAG non-text contrast: prior year `--c-series-prev` #8A94A6 3.06:1,
forecast `--c-series-fcst` #6F8FF0 3.06:1, current year brand-600 6.35:1; the accent as a goal series or bar on white
is `EC6A24` = `--c-accent-600`, 3.16:1 — the accent-500 `FF8A3D` is only 2.35:1 there), checked by the
`chart-contrast` warning; give the forecast ONE encoding across
the deck; only legal label positions (clustered `outEnd/inEnd/ctr/inBase`, stacked no `outEnd`, doughnut none —
an illegal position makes PowerPoint refuse the file); `legend.position: "none"` + an **HTML legend**, because
PowerPoint positions chart legends internally (drift risk) while an HTML legend converts to exact shapes and text —
give it `data-group` so it is one object, grouped with the chart inside the card's group (§12). Keep category
labels short (they must not wrap). A `bar` chart lists `categories` top-down in the given order (the builder
reverses PowerPoint's bottom-up axis). `numberFormat` is an Excel format code, rendered identically by the preview
and PowerPoint: `#,##0` (1,284), `0.0` (8.4), `0%` / `0.0%` with fractions as values (0.084 → 8.4%), or a quoted
literal suffix with the figures as given (`0.0"%"` → 8.4%, `0.0"%p"`, `#,##0"억"`).

**8.11 Insight list** — a `<ul class="insights">` whose items are *headline + detail*, two hard lines of one size:
`<li><strong>분기 최대 매출 경신</strong><br><span class="insight-detail">3분기 1,284억 원, 전년 대비 12.4%
증가</span></li>`. Hierarchy comes from weight/colour, not size (§5.3).

**8.12 Dark hero panel** — `.panel` in `--c-brand-900`, a flex column: a big stat (48/64 px) with its delta pill
(`pill--up-on-dark`, or `pill--down-on-dark` when the change is unfavourable) on top, and the 1 px translucent
rule and the insight list in white / white-66 % pinned to the bottom (`margin-top: auto` on the rule), so the card
has no empty band under its last line. Translucent text is fine; the panel itself is opaque so its shapes and text
stay exact.

**8.13 Cover composition** — a 2-stop `linear-gradient(135deg, …)` slide background (`data-layout="표지"`); on the
right a decorative group (`data-group="장식"`) made only of shapes: a translucent halo circle, a 1 px ring, two
small "orbit" dots on the ring, four pill-shaped bars standing on a baseline rule — all fully inside the slide. A
motif that looks like data IS data: the bar heights are the quarters on one scale from zero, never a freehand rise
that exaggerates the growth. On the left: brand mark + wordmark (`data-group="브랜드"`), a glass pill label with
information the title and meta row do not already give (`대외비`), the 60/80 px title with a `<br>`
(`data-placeholder="ctrTitle"`), a one-line subtitle (`data-placeholder="subTitle"`), a meta row (label/value
pairs over a 1 px rule, fixed 176 px columns so the pitch is the same in both profiles), and the sample-data note.
The title and subtitle boxes (520 / 536 px) end ≥ 16 px before the ring at x 616, so a title line that would run
into the motif wraps instead — a `title-wrap` error: about 8 Hangul syllables fit per 60 px line in `malgun`;
shorten the line or re-split it with `<br>`. On the cover the title is also the file's document title (§12).

**8.14 Agenda** (`examples/layouts/slides/01-agenda.html`) — the sections as white rows on the right
(`.agenda-item`: a `.card` with radius 16, 98 px tall, 16 px apart; the number 28/40·800 brand-600, the title
20/28·700 over a one-line description 16/24, and a `.pill--brand` chip with the section's headline figure — a
promise the section keeps); rows, not `<ol>`/`<li>` (§5.4). On the left a dark summary card (brand-900, 392 × 440,
a flex column): a label, a lead paragraph that soft-wraps on purpose (16/24, §5.3), the goal pinned to the bottom
(`margin-top: auto`: a divider, the 44/60 figure, current-vs-goal bars on one scale with their values, the goal
bar in the accent) and the ask in a translucent box (`rgba(255, 255, 255, .08)`). Pinning the goal to the bottom
gives the wider profile's extra lead line its room without leaving a dead zone in either profile.

**8.15 Trend and mix** (`02-diagnosis.html`) — two native charts in two cards, with ONE colour code (phone = navy
`0F1D4A` on both, the digital channels = brand blues): a `line` chart (two series, `dataLabels.position: "outEnd"`,
a hidden value axis with explicit `min`/`max` that leaves headroom for the top label) and a `doughnut` (one
series, `pointColors["0"]` for the slices, `holeSize: 64`, `dataLabels.show: false`) beside an HTML legend whose
rows carry the values (`data-group="범례"`). The centre label ("68%" over "전화") is a text element positioned over
the hole as a SIBLING of the chart element — text inside the chart element is not converted (`chart-content`). The
evidence for the title is the `.slide-sub` (content from y 200, §8.1), and each card ends with a one-line finding
under a 1 px divider (`margin-top: auto`), a two-line one with a `<br>`.

**8.16 Section divider** (`03-section.html`) — its own `data-layout="간지"` with a dark two-stop gradient (the
builder also keeps a copy of a dark background on the slide itself, so its white text stays readable on another
template); a 72/96 accent number, the 60/80 title (the slide's `<h1>` = its title placeholder), a 22/32 subtitle;
on the right a preview of the section — one translucent row per strategy (`rgba(255, 255, 255, .06)`, radius 16:
a glass icon circle, a tracked 12/16 kicker "전략 1", a 20/28·700 name, one 14/20 line) — so the divider says what
comes next instead of decorating empty space; at the bottom a progress row across the content width — one 4 px
bar + label per section, the current one lit — grouped as `data-group="진행 단계"`.

**8.17 Strategy framework** (`04-strategy.html`) — a "house": the goal as the roof (a brand-900 band, 72 px: a
`pill--glass` label, the goal with its figure in the accent, a right-aligned second target), three pillars as
cards on one grid with the SAME rows (icon badge + kicker + name; a brand-50 metric box with the metric's name and
"from → to", where the arrow is an inline SVG icon between two text elements; three actions as one `<ul>`, 16/24,
`padding-left: 13px`), and the shared foundation as a brand-100 base band. Roof, pillars and base are 16 px apart.

**8.18 Comparison** (`05-comparison.html`) — the verdict is the title and its evidence the subtitle ("B안은 3년
총비용이 8억 원(21%) 적고 …"), so no recommendation box is needed. Two option cards on one grid with the SAME
rows in the same order; each leads with its 3-year total (44/60) over a cost bar on ONE scale (the larger total =
the full 484 px track, 12.74 px per 억 원) made of two pill segments 4 px apart — a shape has one radius, so a bar
rounded only at its outer ends would be a `border-radius` error — with a small legend naming the segments. The
recommended option is the dark card (a white chip, white / white-40 % segments) and states its advantages next to
the figures as green pills in plain words ("8억 원 절감", "5개월 단축") — no arrow, because ▲/▼ mean
increase/decrease elsewhere in the deck. The fact rows (label 16/24 ink-500 left, value 20/28·700 `nowrap` right,
a 1 px rule above each) run to the card's padding. The speaker notes hold the assumptions behind the numbers.

**8.19 Timeline** (`06-timeline.html`) — a month grid (208 px label column + 12 × 76 px): a quarter header and a
month row, one 56 px track per workstream (name 16/24·700, owner and the strategy it serves 13/20), a pill-shaped
bar per task (32 px, `border-radius: 16px`, white 14/20·600 label) coloured by the KIND of work (brand = a
strategy's own work, `--c-ink-500` = the shared work that enables it, named in a small legend), a go-live line at
the key milestone's month (2 px, the accent at 40 % alpha, painted before the tracks so the bars cover it), and a
milestone rail (a 2 px line; dots in a fixed 18 px slot so every label row aligns; the key milestone in the accent
as `--c-accent-700`, the shade a mark on the ink-50 page needs). A bar spanning months a…b sits at
`left = 208 + (a − 1) × 76 + 4` with `width = (b − a + 1) × 76 − 8`; month m's centre is `208 + (m − 1) × 76 + 38`.
Bars and dots are drawn shapes that do not follow an edited date: their `data-group` names state the dates and say
so.

**8.20 KPI targets** (`07-effects.html`) — a scorecard: one white card of KPI rows (88 px, a 1 px rule between
rows): the KPI's name 18/28·700 over a one-line definition 13/20, two bars on the ROW's own scale (the larger value
= 440 px; current in `--c-series-prev`, the target in brand-600, the headline goal in the accent as everywhere in
the deck — `--c-accent-600` on the white card) with each value right after its bar, and the change as a green pill
in words ("50% 단축", "+28%p") —
green = favourable, whichever direction the metric moves. A `.summary` box below shows the arithmetic of the
yearly effect.

**8.21 Closing** (`08-closing.html`) — the ask, not a "thank you": its own `data-layout="맺음"` on the cover's
gradient; an accent kicker, the request as a 48/64 two-line title (`<br>`; the slide's `<h1>` = its title
placeholder), a two-line 18/28 subtitle (`<br>`), the items to approve as numbered translucent rows (a label and
one fact each), and the next three dates on a rail (fixed 384 px pitch, the first one lit, the rail ending at the
last dot) whose `data-group` name lists the dates.

**8.22 Org chart** (`examples/handbook/slides/01-org.html`) — a tree of boxes: the top box (brand-900) with a staff
office beside it, the units as cards on one pitch (262 + 24 px) with their teams as rows and headcounts that add up.
Connector lines are 2 px rectangles (`--c-ink-300`) in ONE `data-group` painted FIRST, so the boxes cover their ends;
there are no connector shapes that follow a moved box, so the group name says to move them by hand. Mark the one
unit or team the reader deals with (a `pill--brand` chip), not every box.

**8.23 Week grid** (`02-first-week.html`) — a schedule as ONE native table: `.data-table--text`, a time column and
one column per day, one session per cell. The kind of session is the cell fill (brand-50 = company-wide, white =
the team's own, accent-100 = the one key meeting), named in a legend of outlined swatches below the table; the
mandatory sessions in bold, explained in the footnote. Keep each session to a few words so every cell stays on one
line (§8.9); merged cells are possible but a single-cell grid is easier to edit.

**8.24 Directory** (`03-contacts.html`) — the action as the title ("막히면 버디, 그다음 담당 부서에 물어보세요"), the
order to ask in as numbered steps on a dark card (the first one lit, an urgent note pinned to the bottom), and who
handles what as a `.data-table--text` of topic, team, extension and channel at the width it needs.

## 9. Design system (tokens in `converter/theme/base.css`)

- **Colour**: one brand (royal blue `--c-brand-600 #2A52D9`, dark surfaces `--c-brand-900 #0F1D4A`, tints 50–300),
  one accent (amber-coral `--c-accent-500 #FF8A3D` for shapes on dark surfaces and for decoration,
  `--c-accent-600 #EC6A24` for a data mark on white — a chart series, a goal bar (3.16:1; 500 is 2.35:1 there) —,
  `--c-accent-700 #C2410C` when it is small text or a mark on the ink-50 page; **one focal use per slide**: the
  cover's current-quarter bar, the section number, the key milestone), cool
  neutrals `--c-ink-50 … 900`, semantic deltas `--c-up-600/50` and `--c-down-600/50`, chart series tokens (keep them
  in sync with the literal `RRGGBB` in `data-chart`).
- **Contrast**: every text ≥ **4.5:1** against what it sits on (WCAG AA for small text — slides are projected): up
  pill 4.8:1, down pill 4.6:1, captions/footer `--c-ink-500` 4.6–5.0:1, section number 4.8:1. `--c-ink-400` is for
  decoration only (2.4:1). Translucent white text on the dark surfaces: keep alpha ≥ 0.56. White text needs at
  least brand-600 behind it (brand-400/500 are too light for small white text).
- **Type**: display 60/80·800, title 40/56·800, stat 44/60·800, hero stat 48/64·800, lead 22/32·400, card title
  18/28·700, body 18/28·400, dense 16/24, section label 14/20·600 tracked, caption 14/20·400, footer 12/16.
- **Space**: 8 px grid (`--sp-1 … --sp-10`), 80 px margins, 24 px gutters between cards, 24–32 px card padding.
- **Shape**: radius 20 (cards), 16 (boxes), 4 (swatches), 999 (pills); `--shadow-card 0 8px 24px /7 %`.
- **PowerPoint theme**: `--pptx-dk1 … --pptx-folHlink` on `:root` map the tokens to the deck's theme colours (dk1
  ink-900, lt1 white, dk2 brand-900, lt2 ink-50, accent1 brand-600, accent2 accent-500, accent3 up-600, accent4
  down-600, accent5 brand-300, accent6 series-prev) — what a user's newly inserted shapes, tables and charts get in
  PowerPoint. The converted objects carry literal colours, so a theme recolour in PowerPoint (Design > Variants >
  Colors) leaves the existing slides unchanged.
- **Re-branding with `deck.css`**: to give a deck other colours, override the tokens in `<deck>/deck.css` (linked
  after `base.css` and `fonts.css` on every slide) instead of editing each slide:
  ```css
  :root {
    --c-brand-900: #123B2E; --c-brand-700: #1B5E45; --c-brand-600: #1F7A5A;
    --c-brand-200: #BFE3D3; --c-brand-50: #EEF8F3;
  }
  ```
  The `--pptx-*` theme slots reference the tokens, so the deck theme follows. Literal colours do not: inline SVG
  `stroke`/`fill`, `data-chart` colours, `style="background:#…"` swatches and hand-written gradients (the cover's
  `#0A1433 → #1B3796`) must be changed by hand — search the slides for the old hex values. Re-check the contrast
  rules with the new colours. `deck.css` may also add deck-wide component rules; it is linked like `base.css`, so
  every rule in §2–§7 applies to it.
- **Compose each slide around ONE visual that proves its title**: the title states the claim, the `.slide-sub`
  its evidence (when one figure carries it), and the dominant object shows it — a native chart, bars on one
  scale, a cost bar, a timeline, a big number. The reader should get the point from the visual before reading a
  label. Reference content (an org chart, a schedule, a directory) has no finding: its title says what the reader
  should know or do, and the structure itself is the visual (§8.22–§8.24).
- **One colour, one meaning, across the deck**: brand-600 = ours / the current period / the recommended option / a
  strategy's own work; grey (`--c-series-prev` in data, `--c-ink-500` for bars) = the prior period / the
  alternative / shared work; brand-900 = the emphasis surface (hero KPIs, the recommended option, a summary card,
  the goal band); the accent = the goal or the key date, once per slide; green = favourable and red = unfavourable,
  whichever way the number moves (a churn rise is ▲ in red, a cost cut ▼ in green — §8.5); ▲/▼ only for
  increase/decrease. A category keeps its colour on every chart (the layouts deck: phone = navy on the line chart
  and on the doughnut).
- **Tie the slides into one argument**: the agenda's chips promise each section's headline figure, a section
  divider previews its section, the closing asks for the decision; a figure that recurs is identical everywhere
  (§10, checklist 5).
- **Fill the frame deliberately**: the content fills the content area (from y 184, or 200 below a subtitle, down to
  about y 624) on the grid; no dead zone inside a card — pin its last block to the bottom (`margin-top: auto`) or
  give it one more meaningful row; pair a light column with a dark emphasis card rather than two equal boxes. On a
  content or divider slide, spend empty space on content (the section divider's preview rows), not on ornaments.
- **Vary the composition** between neighbouring slides (a card grid, a split with a dark card, a full-width chart,
  a scorecard, a dark divider) while the header, footer, grid, type scale and colour code stay fixed: the system
  makes it one deck, the variety keeps it from reading as a template.
- **Avoid the AI-slide clichés**: accent bars under titles, coloured side stripes on cards, gradient text, emoji,
  glassmorphism blur, drop shadows on text.

## 10. Self-check with `deck.sh check` (required before you build)

Run `deck.sh check <deck>` exactly as SKILL.md §5 shows it — in the foreground, Bash `timeout: 600000`. It
renders every slide (the `embedded` profile unless you pass `--profile malgun` or `--profile both`; `--only
03-table …` limits the slides) with the same Chromium, fonts and sandbox the build uses, and writes:

- `<deck>/.build/check/<profile>/html/NN-name.png` — 1280×720 renders, what PowerPoint will show;
- `<deck>/.build/check/<profile>/overview-N.png` — contact sheets, 12 slides each (3 × 4 tiles, numbered);
- `<deck>/.build/check/report.json` — every lint item, the soft-wrapped blocks (`softWraps`), the blocks that wrap
  differently between the profiles (`profileWrapDiffs`, with `--profile both`) and text lines of different
  elements whose line boxes intersect (`textOverlaps`, each with its `arrangement`: `side-by-side` or `stacked`).

It writes the renders and the report even when it exits 1, so you can inspect what failed. Then **look at the
renders** when you have vision — the lint cannot judge balance, legibility or text against shapes. A `build` writes
its own renders to `<deck>/.build/<profile>/html/` and `overview-N.png` (`.build/check/` keeps the last check's).

Checklist:
1. 0 errors (in the profile you will build — both, if you will build both); warnings understood; the
   `NOTE malgun weights` line needs no action.
2. Soft wraps only where intended (the check prints each one with " / " at its breaks); no unintended wrap
   differences between the profiles.
3. No glyph drawn by a fallback font (`fallback-font`, `missing-glyph`).
4. No text overlaps (`text-overlap` errors); nothing within 16 px of a collision in the wider (`malgun`) render —
   text against shapes is not measured, so look.
5. Every number consistent across slides (units sum to totals; the same figure means the same thing everywhere).
6. Page numbers show each slide's position; sample data is visibly marked.

## 11. Previews in Noah

Shared IN PLACE, the built .pptx shows the converter's own renders of your HTML in the file card's side panel
(1920×1080 per slide) — exactly what the build measured. The server binds those renders to the file's bytes: if the
.pptx changed after the build (edited with python-pptx, re-saved), or you share a copy or a renamed file, it falls
back to LibreOffice 7.4 previews, which are approximations — rebuild and share the built file instead. Other
PPTX/DOCX/XLSX/PDF files always get LibreOffice previews. What LibreOffice gets wrong (don't "fix" these in HTML):
text sits lower (~1–3 px for body text, 6–8 px for 40–60 px titles and KPI numbers); mixed Korean/Latin runs are
wider (autospacing: "1,284 억"; 8–9 % on long lines, up to ~14 % on short strings like "2026 년 3 분기"); Korean
wraps differ; doughnut holes are always 50 %; SVG icons render from their PNG fallback (slightly soft); blur is
slightly smaller; gradients are drawn in steps with aliased rounded ends; a run with both letter-spacing and
transparency can lose the right edge of its last glyph. Author for PowerPoint; a LibreOffice preview is an
approximation.

## 12. PowerPoint structure hints (what makes the deck editable like a hand-built one)

The builder turns the HTML into PowerPoint *structure*, not just positioned objects. Four attributes steer it;
everything else is derived.

| hint | where | effect in PowerPoint |
|---|---|---|
| `data-layout="본문"` | `main.slide` | slides with the same value share one **slide layout** named so (else: one per background). It carries the background; objects identical on every slide of the layout (footer rule, brand mark, deck name, page number) are written once INTO the layout — a slide the user inserts gets them. Needs ≥ 2 slides; nothing earlier-painted may overlap a lifted object (the builder checks). "Identical" includes the element's DOM path, so give the footer `id="footer"` (§8.2) |
| `data-group="범례"` | any container | its objects become **one group** named so. Boxes with their own paint that hold other objects (cards, pills, icon badges, a caption with its divider, the footer) are grouped automatically; use the attribute for paint-less containers (a legend, a brand mark, a decoration set). Only objects contiguous in paint order are grouped; tables and placeholders never (PowerPoint cannot group them) |
| `data-field="slidenum"` | the page-number element (or an inline span) | a **slide-number field**: PowerPoint shows each slide's number, also after reordering. The text must be the slide's position without padding (`2`) |
| `data-placeholder="title \| ctrTitle \| subTitle \| none"` | a text element | that **placeholder** (Outline view, the accessibility checker and slide-link pickers read the title). Default: the slide's first `<h1>` is its `title`; the cover uses `ctrTitle`. The layout gets a prompt placeholder in the same style, so a new slide's title looks like the deck's |

Also automatic: readable object names in the Selection Pane (`stat-value: 1,284억 원`, `card 그룹`; the DOM path
of every object is in `.build/<profile>/deck.map.json`), an empty `alt` on an `<img>`/`<svg>` = marked decorative
(give meaningful images an `alt`/`aria-label`), a chart's alt text from its data, text blocks in fixed-width
containers wrap inside their box when edited while `nowrap` numbers and shrink-to-fit texts grow (§4.3), theme
colours from the tokens (§9), document title/author/thumbnail (the file's Title property — SharePoint and Teams
file cards, search — is the first slide's title text, so let slide 1's title be the deck's name rather than a
greeting; the author is `--author`), only the deck's own layouts in PowerPoint's New Slide gallery, speaker notes
from `<template id="notes">`.

## 13. Deck folder

```
<deck>/                          ASCII name: ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ (e.g. q3-review)
  slides/NN-name.html            required; NN = 01…60, unique; slide order = numeric order
  deck.css                       optional; linked as ../deck.css (token overrides for the whole deck, §9)
  assets/                        optional; files referenced as ../assets/<file>
  .build/                        converter-owned scratch (carries a .gitignore); safe to delete
    check/<profile>/…            check renders, contact sheets, IR; check/report.json
    <profile>/…                  the last build's IR, renders (html/, overview-N.png: the current ones after a
                                 build-only edit), object map, reports
    logs/                        one folder per run, the last 5 kept
  <deck>.pptx                    the deliverable (<deck>-malgun.pptx for the malgun profile, or --out <name>.pptx)
  <deck>.preview/                its previews + manifest, bound to the .pptx bytes (carries a .gitignore)
```

- Keep the folder name ASCII; the title in the user's language goes into `share_file`'s `name`. `--out` takes a
  bare ASCII file name only.
- Start from an example: copy its whole folder out of the skill directory, then delete, rename and edit slides. The
  skill directory is read-only; a deck folder inside it is refused.
- To reorder slides, rename the `NN-` prefixes and fix every page-number field (§8.2). Keep names short and ASCII:
  `05-roadmap.html`.
- `check` never touches the deliverable. A failed `build` leaves the previous `<deck>.pptx` and its previews
  untouched (they lack your latest edits) and deletes the rejected candidate.
- Committing a deck commits `slides/`, `deck.css`, `assets/` and optionally the .pptx; `.build/` and the preview
  folder ignore themselves.

## 14. Limits

The converter enforces these per run (an administrator can change them; describe_system's deck line reports the
slide and time limits in force):

| limit | default | when exceeded |
|---|---|---|
| slides per build | 60 | `slide-count` (exit 1) — split the deck into several builds |
| one slide's HTML file | 2 MB | `slide-too-large` (exit 1) |
| elements under `main.slide` | 2,500 | `dom-size` (exit 1) |
| one served file (a picture, `deck.css`) | 20 MB | `asset-too-large` (exit 1) |
| one picture / all pictures of one slide, decoded | 40 / 100 megapixels | `image-too-large` (exit 1) — downscale the pictures |
| deck inputs (`slides/` + `deck.css` + `assets/`) | 100 MB | `deck-too-large` (exit 1) |
| wall-clock time per `check`/`build` | 540 s, waiting for a free converter slot included (≤ 150 s of it) | exit 6 (timeout) — fewer slides or images, or split the deck |
| conversions running at once on the server | 2 | exit 5 (busy) after the slot wait |
| renderer memory per slide page | 512 MB JavaScript heap | the page crashes: exit 3 naming the slide — simplify or split it |
| built .pptx | 30 MB (the `share_file` limit) | exit 3 (`pptx-too-large`) — fewer or smaller photos, JPEG sources |
| pictures | up to 4× their CSS size, at most 2560 px on the longest side | automatic (§7) |

Every run ends inside its budget, before the 600 s ceiling of the Bash tool, so always run it in the foreground.

## 15. Choosing a font profile

| | `embedded` (default) | `malgun` (`--profile malgun`) |
|---|---|---|
| font in the file | Pretendard, 4 weights embedded (~5 MB) | 맑은 고딕 named, nothing embedded (small file) |
| desktop PowerPoint | the designed font everywhere, even where Pretendard is not installed (PowerPoint build ≥ 2411) | the real 맑은 고딕 on Windows |
| PowerPoint for the web, Teams/SharePoint previews, PCs that block embedded fonts | a similar substitute font; 600/800 weights may show as regular | 맑은 고딕 where installed (real bold weights) |
| weights | 400/600/700/800 distinct | 600/700/800 all render as Bold — hierarchy from size and colour (§4.1) |
| Hanja, `◎ ☞ ㉠ ≒ ∴` | not in Pretendard (fallback font) | included |
| chat preview | exact | uses a metric-matched look-alike of 맑은 고딕 |

Choose `malgun` when the user asks for 맑은 고딕, when the audience mostly views in PowerPoint for the web or
Teams/SharePoint, for Hanja-heavy text, when a small file matters (e-mail), or when users will switch the font
themselves (Replace Fonts on the embedded deck flattens its weights — see EDITING.md). Otherwise keep `embedded`.
The HTML is the same: check the profile you will build (§10), and build both when the user wants both.
