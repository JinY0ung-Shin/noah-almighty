# HTML → editable PPTX converter — contract (Noah port of the PoC contract)

The pptx skill's converter turns slides authored as constrained HTML/CSS into a .pptx whose text, shapes, tables and
charts are NATIVE, EDITABLE PowerPoint objects that look like the HTML render in Windows PowerPoint (Microsoft 365).
This file is the maintainers' contract: the Noah-specific parts come first (roots, isolation, runs, gates, previews,
self-test, limits), then the PoC's layout contract (coordinates, fonts, IR, v2 decisions) that the extractor and the
builder implement. Authoring rules for the agent live in the skill's `reference/AUTHORING.md`; the CLI's own
`deck.sh --help` is the source of the command reference.

Two font profiles, chosen per build:

- `embedded` (default) — Pretendard (OFL) is used in the HTML AND embedded into the PPTX, so PowerPoint renders with
  the exact font the layout was measured with.
- `malgun` — the PPTX declares 맑은 고딕 (ships with Windows; cannot be redistributed or installed on the Linux
  server), while the HTML is measured with a metric-matched free substitute (`fonts/README.md`).

## Two roots and the IR path convention

- **KIT** = this directory (`default-skills/skills/pptx/converter/`), read-only at runtime (root-owned in the image).
  It keeps the PoC's layout: `tools/ theme/ lib/ fonts/` (+ `selftest/`, `docs/`). Every KIT-relative path
  (`fonts.json` `file` / `measureFile`, the font CSS, the cmap reader) resolves through `__file__` /
  `import.meta.url`. The converter never writes into KIT; a deck folder inside the skill directory is refused.
- **The deck** = a folder in the agent's workspace, named in ASCII (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`):

  ```
  <deck>/slides/NN-name.html       required; NN = 01…; numeric order; bad or duplicate names = slide-name error
  <deck>/deck.css                  optional; linked as ../deck.css (deck-wide token overrides)
  <deck>/assets/                   optional; ../assets/<file>
  <deck>/.build/                   converter-owned scratch (.gitignore "*"): check/<p>/, <p>/, logs/ (last 5), run.json
  <deck>/<stem>.pptx               the deliverable; stem = folder name (+ "-malgun") or --out
  <deck>/<stem>.preview/           its preview sidecar (.gitignore "*", manifest.json written last)
  ```
- **IR paths** (`source`, `referencePng`, `referencePng2x`, image `src` / `svg`) are **relative to the directory
  containing `ir.json`** (`<deck>/.build/<profile>/`: `../../slides/01-cover.html`, `html/01-cover.png`,
  `assets/02-kpi-img1.png`). The builder, the fidelity gate and inspect resolve them against `dirname(--ir)`.
  `fonts.json` paths stay relative to KIT. Image `src` may end in `.jpg` (raster policy). `referencePng2x` names a file
  deleted after the previews are written; nothing reads it afterwards.
- The internal CSS family `PoC Malgun Substitute` keeps its name: it never reaches a PPTX (the builder writes 맑은 고딕;
  the `font-coverage` gate fails a deck naming the substitute), and renaming it would churn the generated CSS, the IR
  and the golden files.

## Isolation

The browser renders AGENT-AUTHORED HTML, so the converter itself is the boundary (the agent's own Bash runs as the
same uid; nothing here grants more than that shell already has):

- **Origin and router** (`tools/extract/server.mjs`): one origin, `http://deck.local/`. `/theme/*`, `/lib/*`,
  `/fonts/*` → KIT (`theme/fonts.css` → `theme/fonts-<profile>.css`); `/deck.css`, `/slides/*`, `/assets/*` and
  anything else → the deck. realpath containment on both sides (`..`, symlink escapes → aborted, `blocked-request`;
  non-files → 404, `missing-file`), a file over 20 MB → 413 (`asset-too-large`; read through one no-follow descriptor,
  so a file that grows after the size check is still cut off), `data:` / `blob:` continue, every other scheme or host
  is aborted (`blocked-request`, an error). The browser's own `/favicon.ico` probe gets an empty 204 (it is not the
  author's request).
- **Decoded pixels** (`tools/extract/pixels.mjs`): the renderer's heap cap does not cover decoded bitmaps, and a small,
  highly compressible file can decode to gigabytes, so the router reads the pixel size of every deck file that is a
  raster image (PNG/APNG, JPEG, GIF — every frame's extent —, WebP, BMP, ICO/CUR, AVIF) from its HEADER and answers
  413 (`image-too-large`, an error) BEFORE Chromium sees a byte when one picture is over 40 MP, when the distinct
  pictures of one page (a slide, or its raster jobs) would pass 100 MP together, or when a recognised image's size
  cannot be read. A deck HTML/CSS/SVG that embeds such a base64 `data:` image (nested base64 or percent-encoded SVG
  data included) is refused the same way; a refused slide document fails that slide with the reason. The scan of
  `data:` payloads is best effort (a payload it cannot parse is served); toolkit files are never sized.
- **CSP on every served HTML/SVG document** (exact strings):
  - slides: `default-src 'none'; script-src http://deck.local/lib/chart.js; style-src 'self' 'unsafe-inline';
    img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; media-src 'none'; object-src 'none';
    frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`
  - isolated raster pages: the same with `script-src 'none'` and `base-uri 'self'` (they carry `<base href>` = the
    slide URL and embed the slide's SVG markup, which must not run scripts either).
  An exact-path `script-src`: even an agent-written `.js` file in the deck cannot execute. The extractor's own code is
  CDP-injected (`page.evaluate`, `Runtime.evaluate`, `addInitScript`) and exempt. Playwright's string-form
  `waitForFunction` needs page `eval` (`EvalError` under this CSP, measured with 1.61.1), so the chart wait is a
  Node-side `page.evaluate` poll (100 ms). No `'unsafe-eval'` was needed.
- **Network**: `ctx.route` aborts everything but `deck.local`; WebSockets are closed (`routeWebSocket`); service
  workers blocked; downloads off; a black-hole proxy `socks5://127.0.0.1:9` with `<-loopback>` (loopback proxied
  too); no host name resolves: the launch passes `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1` itself,
  because the copy Playwright 1.61.1 adds for a SOCKS proxy carries literal quote characters in argv and Chromium
  rejects it ("Failed parsing rule" in the browser log, measured with Chromium 149; the last copy of a switch wins,
  and Playwright appends the launch `args` after its own); WebRTC limited to proxied UDP
  (`--webrtc-ip-handling-policy=disable_non_proxied_udp --force-webrtc-ip-handling-policy`).
  With the proxy configured, CDP `CSS.enable` sent after the page loaded never returns (its resource re-loader stalls;
  measured with Chromium 149), so the CSS agent is enabled on the blank page before navigation.
- **Resources**: renderer V8 heap `--js-flags=--max-old-space-size=512`; decoded pictures bounded by the router
  (above); page waits 20 s; every extraction `evaluate` raced against 60 s (timeout → page closed, class `timeout`,
  and so is a page operation that outlives Playwright's own 20 s timeout); a renderer crash is class `conversion`
  naming the slide ("the slide page crashed while rendering (too large or complex): simplify or split it"), and so
  is the browser exiting on its own while a slide renders (e.g. the kernel's OOM killer).
- `--no-sandbox` is accepted: the agent's own Bash runs as the same uid with the same reach, and the Chromium sandbox
  cannot start in a default Docker container.

## Noah lints (on top of the PoC's list below)

Errors:

| rule | fires on |
|---|---|
| `script` | any `<script>` except `src="../lib/chart.js"` or the inert `type="text/x-notes"`; any `on*` attribute; a `javascript:` URL |
| `stylesheet` | a `<link rel=stylesheet>` other than `../theme/base.css`, `../theme/fonts.css`, `../deck.css`; any `@import` |
| `base-url` / `navigation` | `<base>` / `<meta http-equiv=refresh>` |
| `remote-url` | an absolute `http(s):`, `//` or `file:` URL in `src` / `href` / `srcset` / `xlink:href` / `poster` / CSS `url()` |
| `csp-violation` | every `securitypolicyviolation` (blocked URI + directive), recorded by a CDP-injected listener |
| `dom-size` | more than 2,500 elements under `main.slide` (the slide is then not extracted) |
| `asset-too-large` | a served file over 20 MB |
| `image-too-large` | a picture over 40 MP, one slide's distinct pictures over 100 MP together, a picture whose pixel size cannot be read, or a deck HTML/CSS/SVG embedding such a base64 `data:` image — refused before Chromium decodes it |
| `slide-name`, `slide-count`, `slide-too-large`, `deck-too-large` | pre-checks before any browser starts (bad/duplicate `NN-name.html`; > 60 slides; a slide over 2 MB; inputs over 100 MB) |

Promoted from the PoC's warnings to errors: `blocked-request`, `missing-glyph`. Speaker notes: `<template
id="notes">` (recommended), `aside.notes`, `[data-notes]` or `<script type="text/x-notes">`, as the PoC's `notesOf()`.

## Runs (`tools/deck.mjs`, via `scripts/deck.sh`)

Commands `check | build | probe | selftest` (`deck.sh --help`). Exit codes: 0 ok · 1 authoring · 2 usage ·
3 conversion (and `drift` with `selftest --fail-on-drift`) · 4 toolchain / internal · 5 busy · 6 timeout ·
130/143 cancelled. Output is English model input; `--json` = exactly one JSON object on stdout (`noah-deck-run`,
`noah-deck-probe`, `noah-deck-selftest`), human text on stderr. Every `Next:` line names absolute paths computed
from KIT.

Order of a check/build: parse arguments (usage, exit 2) → deck folder, names and caps (authoring, exit 1; no
toolchain needed) → the `--only` names against the deck's slides (usage, exit 2) → the per-deck lock (exit 5
"already running") → the toolchain (exit 4) → a host slot (exit 5 "busy") → the stages. `check`: `extract --fast` per profile (no DSF-2 render, no rasters) + overview sheets + the
report (`softWraps` with where each wraps, `profileWrapDiffs` with `--profile both`, `textOverlaps` with each pair's
`arrangement` (`side-by-side` | `stacked`) and a soft-wrapping title of the pair (`wrappedTitle`), `tableCells` =
cells that wrap or keep < 30 % free width; `lint.expected` counts the malgun weight notes printed as one NOTE line)
and the lint it derives from the IR (`text-overlap` error, `soft-wrap` warn); it writes IR, renders and report
even when it exits 1, and never touches a deliverable. `build`: extract (the full check of the build profile) →
`build_pptx.py` → size cap → gates ∥ → fidelity → `previews.py` → the atomic replacement below.

- **Budget**: `NOAH_PPTX_MAX_SECONDS` (default 540; `selftest` 900) from process start, the slot wait included.
  Each stage's deadline = remaining budget − a reserve for the stages after it: extract −90 s (check: −30 s);
  build_pptx ≤ 180 s, −45 s; each gate (parallel) and fidelity ≤ 120 s, −15 s; previews ≤ 60 s. A stage that
  cannot start or misses its deadline is killed → exit 6 (`timeout`). The slot wait is
  `min(NOAH_PPTX_SLOT_WAIT_SECONDS, remaining − 60 s)`.
- **Locks** (`tools/lib/locks.mjs`): abstract UNIX socket names, released by the kernel when the holder dies
  (SIGKILL included); no lock files, no pid/age heuristics, nothing under `/tmp`. Host-wide slots
  `\0noah-pptx/<ns>/slot-<k>` (k < `NOAH_PPTX_MAX_CONCURRENT`, default 2) and a per-deck lock
  `\0noah-pptx/<ns>/deck-<sha256(realpath)[0:32]>`; `<ns>` = `NOAH_PPTX_LOCK_NAMESPACE` or `uid-<uid>`. Abstract names
  are per network namespace: every conversion of one container shares it as long as the agent's Bash is not
  sandboxed into its own netns (if that ever changes, move the locks to flock).
- **Cancellation and temp state**: all temp state of a run lives in `$TMPDIR/noah-pptx-run-<pid>-<rand>/`
  (Chromium profile, `HOME` and `TMPDIR` of every child), removed on exit; dirs whose pid is dead or older than 1 h are
  swept at startup. SIGTERM / SIGINT / SIGHUP, orphaning (the ppid is polled every 2 s) or a closed output pipe
  (EPIPE) → children get SIGTERM, then SIGKILL after 3 s, no new child starts, a slot wait wakes up, locks are
  released, the temp dir removed, exit 130/143. The pipeline itself reports it — `FAILED (cancelled): interrupted
  (<why>) — no deliverable was changed.`, and `failure.class: "cancelled"` in the JSON and the report file — never
  as a crash (`internal`) or a gate verdict: a child stopped by a signal the run did not send (a signal to the whole
  process group) counts as the same cancellation, and the extractor records its own `cancelled` result when it is
  signalled. The last check before the atomic replacement below is a cancellation check, so exit 130/143 always
  means the deliverable is untouched.
  Python children arm `PR_SET_PDEATHSIG` (`tools/pdeathsig.py`; `deck.mjs` passes its pid as `NOAH_PPTX_PARENT_PID` so
  a child whose parent died before `prctl` exits at once); Chromium exits when its CDP pipe closes; the extractor child
  runs its own orphan watchdog (1 s, and EPIPE on its stdout/stderr counts as orphaned) and removes the run dir when
  `deck.mjs` was SIGKILLed during extraction. A `$TMPDIR` longer than 30 characters is not used for run dirs (`/tmp`
  is): the full Chromium build binds `<run dir>/org.chromium.Chromium.XXXXXX/SingletonSocket`, and past the 108-byte
  UNIX socket limit it aborts at startup ("Socket path too long", measured; the headless shell binds no such socket).
- **Delivery (success)**: the gates pass on `.build/<p>/deck.pptx` → its sha256 → `previews.py` writes
  `<stem>.preview.new/` (images, `.gitignore`, then `manifest.json` LAST) → `rename(candidate → <stem>.pptx)` →
  `rm -rf <stem>.preview` → `rename(.new → <stem>.preview)` → the `@2x` renders are deleted. Every intermediate state
  is harmless (the server compares hashes). **Failure**: the candidate is deleted; `<stem>.pptx` and its previews stay
  untouched and the footer says so ("The previous build … is unchanged and does NOT include these edits.").

## Gates and policy (D12)

Gates run as parallel Python children on the candidate, each `pass | warn | fail | crash | skip | timeout` (or
`cancelled` when the run was cancelled under it — then the whole run is reported as cancelled, never scored):

| gate | tool | fail = |
|---|---|---|
| `office-rules` | `tools/office_check.py --json` | any FAIL ([MS-OI29500] / ECMA repair triggers); WARN = drift |
| `shape-table-lint` | `tools/gates/shape_table_lint.py` | any problem (p:style, spPr/ln/tcPr order, fills, joins, ids, table style) |
| `chart-verify` | `tools/gates/chart_verify.py` | chart XSD, python-pptx reopen, embedded workbook vs caches |
| `chart-lint` | `tools/gates/chart_lint.py` | any error (illegal dLblPos, holeSize, …); warnings informational |
| `embed-verify` | `tools/embed_fonts.py --verify` | EOT headers, payload, slot styles, every face byte-identical (embedded only) |
| `indep-check` | `tools/gates/indep_check.py` | any ERROR of the independent font-embedding checker (embedded only; WARN informational) |
| `font-coverage` | `tools/inspect_pptx.py --fonts-only` | a run typeface/style not embedded (embedded) or a substitute named (malgun) |
| `inspect` | `tools/inspect_pptx.py` | an editability ERROR (missing text, table, chart workbook); warnings (e.g. `large-picture` on a photo slide) informational |
| `fidelity` | `tools/check_fidelity.py structure` | a BLOCKING check below; any other problem = drift |
| `build` / `pptx-too-large` | builder summary / file size | a skipped element / a .pptx over 30 MB (share_file's cap) |

**Blocking fidelity checks** (a missing, unmapped or hidden object): `map`, `unmapped`, `missing`, `object`,
`hidden`, `layout-chrome`, `overlay`, `picture`, `chart`, `paint-order`. Every other check name (geometry, colours,
runs, baselines, wraps, chart styling, …) is drift.

Integrity failures BLOCK (exit 3, nothing delivered). Drift WARNS — reported, the deliverable is still written — and
is exactly: non-blocking fidelity problems, office-rules WARN and builder warnings. `--strict` makes drift block too
(examples, tests, smoke). A crashed gate or stage (non-zero exit with a Python traceback, or unparseable output) is
class `internal` (exit 4); a gate killed at its deadline is class `timeout` (exit 6).

## Preview sidecar (`<stem>.preview/manifest.json`)

```json
{"format": "noah-deck-preview", "version": 1, "generator": "noah-pptx-converter/1.0.0", "pptx": "q3-review.pptx",
 "pptxSha256": "<64 lowercase hex of the .pptx bytes>", "profile": "embedded", "createdAt": "2026-09-26T03:00:00Z",
 "slideCount": 6,
 "slides": [{"index": 1, "file": "slide-01.png", "mediaType": "image/png", "sha256": "<hex64>", "width": 1920,
             "height": 1080, "title": "2026년 3분기 사업 실적 보고"}]}
```

Written LAST, after every image; `slides` covers ALL slides in deck order (index 1..N; two-digit file numbers, three
when N > 99). Each image = the slide's @2x render downscaled (Pillow LANCZOS) to 1920×1080: PNG when ≤ 2 MiB, else
JPEG q90 (`.jpg`, `image/jpeg`). Then the first 30 — the ones the server attaches — are FITTED into its 32 MiB budget
(the loader rejects the whole sidecar past it, and 30 PNGs of up to 2 MiB could be 60 MiB): while they exceed it, the
largest is re-encoded one step down `JPEG q90 → 80 → … → 40` (always to a smaller file; largest first, ties to the
earlier slide, so the result is deterministic). 30 JPEGs of pure noise fit at q70, and a 1920×1080 JPEG q90 is far
below the server's 5 MiB per-image cap, so a built deck always fits. `previews.py`'s `ATTACHED_MAX`,
`ATTACHED_BUDGET` and `IMAGE_MAX_BYTES` are pinned to the server's `MAX_PREVIEW_PAGES`,
`MAX_DECK_PREVIEW_TOTAL_BYTES` and `MAX_CHAT_IMAGE_BYTES` by `tests/deck-contract.test.ts`. `title` = the slide's
title/ctrTitle placeholder text (whitespace collapsed, ≤ 120 chars) or omitted. Unknown extra files (`.gitignore`) are ignored by the server, which accepts the sidecar only while
`pptxSha256` equals the bytes it just stored (then attaches the first 30 renders; any rule violation rejects all).
Overview sheets (`overview-N.png`: 3 columns × ≤ 4 rows of 640×360 tiles of the 1× renders, ASCII labels) are
written to `.build/<p>/` (build) and `.build/check/<p>/` (check).

## Self-test and drift (`deck.sh selftest`)

Copies `selftest/deck/` (the PoC's 4 slides verbatim) and `selftest/features/` (`01-photo`: a full-bleed 3000×2000
JPEG → the 2560 px cap and the JPEG path, `../deck.css` overriding `--c-brand-600`; `02-notes-wrap`: a ≥ 3-line
soft-wrapping paragraph, a bulleted list, two-paragraph notes in `<template id="notes">`; `03-image-rounded`: a
rounded PNG → transparent PNG, an inline SVG icon → native svgBlip) into the run temp dir, sets
`SOURCE_DATE_EPOCH`, builds both profiles with the D12 policy and compares each IR with
`selftest/golden/<deck>.<profile>.ir.json`:

- `fail` = an integrity failure, crash or toolchain problem (exit 3/4);
- `drift` = integrity passes but a numeric leaf differs by |Δ| > 0.01, or a string/boolean/null/array length, or the
  lint multiset (severity, rule, slide, path), or the build reported drift → exit 0 with a `DRIFT` line (exit 3,
  class `drift`, with `--fail-on-drift`);
- `pass` otherwise. `--record <file>` writes `{"format":"noah-deck-selftest-record","version":1,"status":…,
  "converterVersion","chromiumVersion","at","maxDelta","differences","lintSetChanged"}` (the image build writes
  `/usr/local/share/noah-almighty/deck-selftest.json`, which `probe` reports; `NOAH_PPTX_SELFTEST_RECORD` overrides).
  `--update-golden` rewrites the goldens (dev box only; refused when KIT is not writable) — run it only after a
  PowerPoint spot-check, then commit. `--keep <dir>` copies the built decks out.

## Limits

| limit | value | env |
|---|---|---|
| slides per build | 60 | `NOAH_PPTX_MAX_SLIDES` |
| time per check/build | 540 s (selftest 900 s) | `NOAH_PPTX_MAX_SECONDS` |
| concurrent conversions (host) | 2 | `NOAH_PPTX_MAX_CONCURRENT` |
| slot wait | 150 s (≤ budget − 60 s) | `NOAH_PPTX_SLOT_WAIT_SECONDS` |
| slide HTML | 2 MB | — |
| elements under `main.slide` | 2,500 | — |
| one served file | 20 MB | — |
| one picture, decoded | 40 MP | — |
| one slide's distinct pictures, decoded | 100 MP | — |
| deck inputs (slides/, deck.css, assets/) | 100 MB | — |
| built .pptx | 30 MB (share_file's cap) | — |
| renderer V8 heap | 512 MB | — |

## Version

`VERSION` (1.0.0); `generator` = `noah-pptx-converter/<VERSION>`. Bump it whenever the output changes; regenerate the
goldens only after a PowerPoint spot-check.

---------------------------------------------------------------------------------------------------------------

The rest of this file is the PoC's layout contract, kept as the extractor and builder implement it. "PoC" / "$POC"
references in it are historical; the paths are the toolkit's.

## Coordinate system

- Slide root in every slide HTML: `<main class="slide">` sized 1280×720 CSS px at the page origin
  (body margin 0, overflow hidden). Viewport 1280×720. IR measurement at deviceScaleFactor 1.
- PPTX slide: 12192000 × 6858000 EMU (13.333in × 7.5in). **1 CSS px = 9525 EMU.**
- Font size: pt = px × 0.75; OOXML `sz` (1/100 pt) = round(px × 75). Letter spacing `spc` (1/100 pt) =
  round(px × 75).

## Fonts (`fonts/fonts.json`, `theme/fonts-<profile>.css`)

```json
{
  "profiles": {
    "embedded": {
      "label": "무료 글꼴 임베딩",
      "cssFamily": "<family name declared in theme/fonts-embedded.css>",
      "embed": true,
      "faces": [
        {"cssWeight": 400, "typeface": "<PowerPoint typeface = OpenType name ID 1 family>",
         "bold": false, "italic": false, "slot": "regular", "file": "fonts/<file>.ttf"}
      ]
    },
    "malgun": {
      "label": "맑은 고딕 지정",
      "cssFamily": "<measurement substitute family declared in theme/fonts-malgun.css>",
      "embed": false,
      "faces": [
        {"cssWeight": 400, "typeface": "맑은 고딕", "bold": false, "italic": false, "slot": "regular",
         "file": null, "measureFile": "fonts/<substitute>.ttf"},
        {"cssWeight": 700, "typeface": "맑은 고딕", "bold": true, "italic": false, "slot": "bold",
         "file": null, "measureFile": "fonts/<substitute-bold>.ttf"}
      ],
      "notes": "<why this substitute; measured width error vs Malgun Gothic>"
    }
  }
}
```

- Builder weight resolution: the face with the nearest `cssWeight` (tie → heavier). The run gets
  `latin` + `ea` + `cs` typeface = `face.typeface` and `b="1"` iff `face.bold`.
- Slide HTML links ONLY `../theme/base.css` and `../theme/fonts.css` (plus the optional deck-wide `../deck.css`);
  the extractor serves the active profile's `theme/fonts-<profile>.css` under the name `theme/fonts.css`. Slides use
  `font-family: var(--font-sans)` and only the weights listed in fonts.json.
- Paths inside fonts.json are relative to KIT (this directory).

## Font embedding API (`tools/embed_fonts.py`)

- `embed_fonts(pptx_in: str, pptx_out: str, faces: list[dict]) -> None` where each face is
  `{"typeface", "slot": "regular"|"bold"|"italic"|"boldItalic", "file"}`. Groups faces by typeface into one
  `<p:embeddedFont>` each; writes whatever PowerPoint needs to render AND edit with the font.
- CLI: `python3 tools/embed_fonts.py IN.pptx OUT.pptx --profile embedded` (reads fonts.json;
  only faces with a non-null `file`).
- Safe to run on a python-pptx output; IN may equal OUT.

## IR (`<deck>/.build/<profile>/ir.json`) — produced by `tools/extract.mjs`, consumed by `tools/build_pptx.py`

```json
{
  "version": 1,
  "profile": "embedded",
  "slideSizePx": {"w": 1280, "h": 720},
  "theme": {"colors": {"dk1": "RRGGBB", "lt1": "…", "dk2": "…", "lt2": "…", "accent1": "…", "…": "…"}} | null,
  "slides": [
    {
      "index": 1, "name": "01-cover", "source": "../../slides/01-cover.html",
      "referencePng": "html/01-cover.png",
      "referencePng2x": "html/01-cover@2x.png",
      "background": "<Fill | null>",
      "elements": ["<Element> … in paint order, back → front"],
      "notes": "<string | null>",
      "layout": "<data-layout of main.slide | null>",
      "components": [{"id": "<DOM path>", "name": "<data-group value | null>", "hint": true, "members": ["<element id>"]}]
    }
  ],
  "lint": [{"slide": 1, "severity": "error|warn", "rule": "...", "message": "...", "path": "..."}]
}
```

All paths in the IR are relative to the directory containing `ir.json` ("IR path convention" above).

### Common element fields

`id` (unique within the slide, a DOM path), `kind`, `box` `{x, y, w, h}` (CSS px floats relative to the
slide origin, border-box, before rotation), `rotationDeg` (0 unless a `rotate()` transform),
`opacity` (product of ancestor opacities, 0..1).

### Value types

- `Fill` = `{"type":"solid","color":"RRGGBB","alpha":0..1}` |
  `{"type":"linear","angleDeg":<CSS gradient angle; 180 = to bottom>,"stops":[{"pos":0..1,"color":"RRGGBB","alpha":0..1}]}`
- `Line` = `{"widthPx":n,"color":"RRGGBB","alpha":0..1,"dash":"solid|dashed|dotted"}`
- `Shadow` = `{"offsetXPx","offsetYPx","blurPx","spreadPx","color":"RRGGBB","alpha"}` (first outer box-shadow)

### `kind: "shape"`

`{"geometry":"rect|roundRect|ellipse","radiusPx":n,"fill":Fill|null,"line":Line|null,"shadow":Shadow|null}`

- Emitted for any element with a visible background, border or shadow — before its children.
- A uniform border becomes `line`. Non-uniform borders: the extractor emits one extra thin filled `rect`
  shape per visible side (no line) right after the element's own shape.
- `border-radius: 50%` on a square box → `ellipse`. Uniform radius → `roundRect` + `radiusPx`.

### `kind: "text"`

```json
{
  "anchor": "top",
  "wrap": true,
  "nowrap": false,
  "shrinkWrap": false,
  "paragraphs": ["<Paragraph>"],
  "lines": [{"top": 0, "bottom": 0, "baseline": 0}],
  "contentBox": {"x": 0, "y": 0, "w": 0, "h": 0}
}
```

- `box` == `contentBox` (border-box minus padding and border) for text elements.
- `wrap` is false iff the block rendered on exactly one line.
- `nowrap` (bool, fixer round 2): CSS forbids wrapping (`white-space: nowrap/pre`, `text-wrap-mode: nowrap`).
- `shrinkWrap` (bool, fixer round 2): the box width follows its content (inline-block, a flex-row item sized by its
  text, abs-pos with auto width, `min-width`, a block inside such a box) — probed in place: padding-right grows by the
  box's free room + 20 px and the border box widens. False = the width is the container's: a longer line would wrap
  inside the box. With `nowrap` it decides the PowerPoint wrap mode of blocks without soft wraps (v2 decision (f)).
- `lines`: one entry per rendered line, slide coordinates in CSS px:
  `{"top","bottom","baseline","text":"<the exact rendered text of that line>","paragraph":<index into paragraphs>}`
  — the builder uses `text` + `paragraph` to pick a PowerPoint box width whose line breaks match
  Chromium's (`pptbreak.width_window`) and to derive paragraph spacing from measured baselines.
- `Paragraph` = `{"align":"l|ctr|r|just","lineHeightPx":n (always RESOLVED to px, never null),"spaceBeforePx":n,"spaceAfterPx":n,
  "marginLeftPx":n,"indentPx":n,"bullet":null|{"type":"char","char":"•","color":"RRGGBB"|null}|
  {"type":"number","scheme":"arabicPeriod","startAt":1},"runs":[Run]}`
- `Run` = `{"text":"…","fontFamily":"<computed first family>","fontWeight":100..900,"italic":bool,
  "underline":bool,"strike":bool,"sizePx":n,"color":"RRGGBB","alpha":0..1,"letterSpacingPx":n,
  "baseline":"normal|super|sub"}` | `{"break":true}` for `<br>`.
- A text block is the nearest element whose children are only inline content (text,
  `span b strong em i u s a code small sup sub br`). Its own background/border is a preceding `shape`.
- Text is the rendered text (collapsed whitespace, `text-transform` applied). A list (`ul/ol`) is ONE
  text element with one paragraph per `li`.
- `placeholder` (optional): `"title" | "ctrTitle" | "subTitle"` — from `data-placeholder` on the text element, else
  `"title"` for the slide's first `<h1>`; the builder writes that PowerPoint placeholder (explicit formatting).
- Run `field` (optional, only on field runs): `"slidenum"` — from `data-field` on the text element or an inline
  ancestor; the builder writes `a:fld type="slidenum"` (PowerPoint computes the number). The HTML must show exactly
  the slide's 1-based index (`"2"`, never `"02"`): lint **error** `field` otherwise.

### `kind: "image"`

`{"src":"assets/<slide>-imgN.png|.jpg","svg":"assets/<slide>-imgN.svg"|null,"alt":"…"}` — inline
`<svg>` and `<img>` are atomic; rasterized at S× = min(4, 2560 / the longer CSS side) with a transparent
background, or as JPEG q90 for an opaque JPEG photo with object-fit fill/cover and no radius (raster policy);
`svg` keeps the original markup of an inline SVG (for an optional native-SVG picture with PNG fallback).

### `kind: "table"`

`{"columnsPx":[…],"rowsPx":[…],"cells":[[Cell…]…]}` with `Cell` = `{"covered":true}` for a cell hidden by
a span, else `{"rowSpan","colSpan","fill":Fill|null,"borders":{"top":Line|null,"right":…,"bottom":…,
"left":…},"paddingPx":{"l","t","r","b"},"vAlign":"top|middle|bottom","header":bool (a `<th>`; fixer round 2),
"paragraphs":[Paragraph],"lines":[…]}` — a first row of header cells becomes the table's header row (`tblPr@firstRow`).
The `<table>` is atomic; a table-level background/radius/shadow is a preceding `shape` in the IR (the builder
absorbs an opaque, square, line-less one INTO the table: cell fills + the table's own shadow — v2 structure (d)).

### `kind: "chart"`

`{"spec": ChartSpec}` — taken verbatim from the element's `data-chart` JSON attribute; the element is atomic
(its in-page SVG preview is NOT walked).

```json
{
  "type": "column|bar|line|pie|doughnut",
  "grouping": "clustered|stacked",
  "categories": ["…"],
  "series": [{"name": "…", "values": [1, 2, null], "color": "RRGGBB"}],
  "pointColors": {"0": ["RRGGBB"]},
  "dataLabels": {"show": true, "numberFormat": "#,##0", "position": "outEnd|inEnd|ctr",
                 "color": "RRGGBB", "sizePx": 13, "cssWeight": 600},
  "valueAxis": {"visible": false, "min": null, "max": null, "numberFormat": "#,##0",
                "gridlines": {"color": "RRGGBB", "widthPx": 1}},
  "categoryAxis": {"visible": true, "labelColor": "RRGGBB", "sizePx": 13, "lineColor": "RRGGBB"},
  "legend": {"position": "none|top|bottom|right", "color": "RRGGBB", "sizePx": 13},
  "gapWidth": 80, "overlap": -10, "holeSize": 60,
  "fontCssWeight": 400
}
```

Every key except `type`, `categories`, `series` is optional. `lib/chart.js` renders the same spec as an
in-page SVG so the HTML reference looks like the native chart, using the geometry rules in
`docs/research/chart-mapping.md` (band/bar-width formulas, pie start angle, default 3 px line + 7 px markers).

`lib/chart.js` publishes what it resolved on each chart element as
`data-resolved='{"plot":{"x","y","w","h"},"valueMin":n,"valueMax":n,"majorUnit":n}'` (plot rect in CSS px
relative to the chart element's border-box; a SQUARE plot for pie/doughnut) and sets
`document.documentElement.dataset.chartsReady = "1"` after every chart is drawn. The extractor waits for that
flag when any `[data-chart]` exists and copies it into the IR chart element as
`"resolved": {"plotPx": {x, y, w, h} (slide coordinates), "valueMin", "valueMax", "majorUnit"}` — the builder
passes these to the native chart (`manualLayout`, explicit `c:min/c:max/c:majorUnit`) so both match.

### Structure hints (fixer round 1)

- `slides[].components`: every element with its own paint that holds other objects (a card, a pill, an icon badge,
  a caption with its divider, the footer) and every `data-group` element, with `members` = the ids of the IR elements
  inside it (its own shapes included). Computed in the page from real DOM ancestry. The builder groups them.
- `slides[].layout`: `data-layout` on `main.slide` (e.g. `"본문"`); slides sharing it share a PowerPoint layout.
- `theme.colors`: the `--pptx-<slot>` custom properties of `:root` (theme/base.css maps them to the design tokens) →
  the deck's `a:clrScheme`.

### Lint (`severity: "error"` = not convertible to native objects)

filter, backdrop-filter, mix-blend-mode, clip-path, mask, radial/conic gradients, `background-image: url()`,
text-shadow, transforms other than rotate/translate, non-uniform border-radius, `::before`/`::after` with
content, multiple box-shadows (warn), inset box-shadow (warn), text overflow (scroll size > client size),
anything outside the slide bounds, a slide-number field that does not show the slide's number (`field`), bare text
beside element children (`mixed-content`), a soft-wrapped slide title (`title-wrap`), a weight outside the kit's
400/600/700/800 (`font-weight`). Warn: `font-weight` for a kit weight the profile lacks (malgun 600/800, expected;
also counts table-cell runs and chart label/axis weights), `chart-contrast`, `placeholder`, `theme-color`.

## v2 decisions — binding for every lane (from docs/research/*.md)

### Rendering side (slides, theme/base.css, extractor)
- Chromium is launched with `--font-render-hinting=none` (default hinting rounds every glyph advance to
  whole px: −6.6…+4.2 % per run). `theme/base.css` also sets `text-rendering: geometricPrecision`,
  `font-kerning: none`, `font-variant-ligatures: none`, `word-break: normal` (NOT keep-all — PowerPoint breaks
  Hangul between syllables), an explicit `line-height` on body (every text element resolves to px),
  `sup/sub { font-size: .58em }`, and list markers as the string `"• "` (`list-style-type: "• "`).
- Await `document.fonts.ready` + one rAF before measuring (unicode-range faces load lazily).
- Never hand-edit `theme/fonts-*.css`; regenerate them with the PoC font generator (preserved for maintainers under
  `docs/pptx-converter/maint/`, see `fonts/README.md`) and its validators.
- Extractor must emit RESOLVED collapsed table borders (computed style gives the specified ones),
  resolved `to <corner>` gradients, rotation from the transform matrix with the box centre corrected for a
  non-centre transform-origin, and icon/SVG PNGs rasterized in isolation (omitBackground does not remove
  page backgrounds).

### PPTX side (builder)
- Kerning OFF on both sides: runs carry `kern="0"`; CSS `font-kerning: none`.
- Line spacing: `a:lnSpc/a:spcPct` everywhere (the measured PowerPoint model in text-mapping.md: line box
  = 1.2 × size, seat formula); do not use spcPts for text boxes. PowerPoint keeps only a WHOLE percent
  (`pptxlib/text.py` `whole_percent`), so a CSS line-height that is not a whole percent of 1.2 × size drifts a
  little per line — e.g. 18/28 is +0.08 px per line and trips `check_fidelity.py`'s `BASELINE_TOL` (0.25 px, a
  drift check that `--strict` blocks) after 4 lines, while 16/24 (exactly 125 %) is exact (measured on a 5-line
  malgun paragraph, 345.320 vs 345.000 px; AUTHORING §4.2 tells authors). Table cells: every cell paragraph (incl.
  empty/spanned) gets explicit lnSpc/spcBef/spcAft and `a:endParaRPr sz`, and `tr@h` must be ≥
  marT + marB + (lines × pct × 1.2 × size) so PowerPoint never grows a row; marT/marB are shifted together (sum
  unchanged) so PowerPoint's first baseline (block anchored t/ctr/b in the spanned rows) lands on the IR cell's
  MEASURED first baseline (fixer round 2: the old font-metric model of Chromium's seat was 1 px off for 17 px
  Pretendard — Blink on Linux moves 1 px from ascent to descent when the descent rounds down).
- Text box geometry: `x = contentBox.x`, `y = lines[0].baseline − seat`, insets 0, `anchor="t"`; autofit (fixer
  round 3, EDIT-01): `noAutofit` for `wrap="none"` (and rotated) boxes, `normAutofit` without `fontScale` /
  `lnSpcReduction` for every `wrap="square"` box, whose height is then ≥ 1.05 × PowerPoint's text height (the box grows
  downward only, so no baseline moves) — an edited, longer text that wraps to more lines shrinks inside its box
  (PowerPoint's own title/body placeholder setting, "Shrink text on overflow") instead of running into the next object,
  while the unedited text never triggers it;
  blocks without soft wraps (single lines included) follow decision (f) (`wrap="square"` at the HTML width when they
  "fit" and the HTML would wrap a longer line in that box, else `wrap="none"`); soft-wrapping blocks get a width from
  `pptbreak.width_window` over `lines[].text` (fallback: 1.02 × width, widened away from the alignment edge; no window
  → hard breaks).
  `a:pPr eaLnBrk="1" latinLnBrk="0" hangingPunct="0"`; runs `lang="ko-KR" altLang="en-US"`.
- Every run: `a:latin` + `a:ea` + `a:cs` = the fonts.json face typeface (exact spelling); `b="1"` only for
  a bold-slot face. Theme `majorFont`/`minorFont` latin/ea/cs = the profile's regular typeface.
- Shapes: never keep `p:style`; `p:spPr` child order xfrm, prstGeom, fill, ln, effectLst; no border =
  `<a:ln><a:noFill/></a:ln>`; `a:miter` joins; border inset per shape-table-mapping.md.
- Charts (fixer round 3): the frame's `cNvGraphicFramePr` carries no lock (python-pptx's `noGrp="1"` is removed —
  PowerPoint writes none on chart frames, and the chart sits in its card's group); `c:showDLblsOverMax val="1"` (a value
  typed above the locked axis maximum keeps its label); the Selection Pane name says the value axis is fixed
  ("… (값 축 0~1,600 고정)").
- Charts: via `slide.shapes.add_chart` only + lxml post-processing (never copy chart frames); only legal
  `dLblPos`; explicit min/max/majorUnit from `resolved`; manualLayout fractions within [0,1].
- Embed fonts LAST (after the final python-pptx save) with `tools/embed_fonts.py`; embedded profile only.
- Structure (fixer round 1, judge J1-01…J1-09): **(a)** one custom slide layout per slide family (`data-layout`, else
  per background) carrying the family's background; elements identical on every slide of a family of ≥ 2 (footer
  rule, brand mark, deck name, page number) are written ONCE into the layout — only when no earlier-painted slide
  object overlaps them, so paint order is unchanged. "Identical" = the same IR `id` AND the same signature
  (`pptxlib/layouts.py` `find_chrome`); the `id` is the element's DOM path (`00-util.js` `pathOf`: `:nth-child`
  steps, or `#<id>` for an element whose `id` attribute is unique), so a footer that sits at a different child
  position on some slide is NOT lifted — give it a unique `id` (the skill's examples use `id="footer"`). The
  master gets the main background; a slide whose background is
  dark (every stop's relative luminance < 0.2: its text is light) ALSO carries its own identical `p:bg` (fixer round 3,
  EDIT-05: moved onto another template it keeps the background its white text needs; light backgrounds keep inheriting,
  so a Slide Master edit still reaches them). **(b)** Page numbers are
  `a:fld type="slidenum"` (cached `‹#›` in a layout). **(c)** The slide title is a `title`/`ctrTitle` placeholder
  with every property explicit (`spcBef`/`spcAft` too); its layout gets a prompt placeholder in the same style.
  `p:ph@idx` as PowerPoint's own layouts write it — `title` / `ctrTitle` none (0), `subTitle` `idx="1"` — unique on
  every slide and layout, so each slide placeholder links to the layout prompt of its own type ([MS-OI29500] 2.1.1127;
  fixer round 3, VO-01 / VR-01).
  **(d)** A table's own opaque, square background shape is absorbed into the table: cells without a fill get its
  colour, its shadow becomes `a:tblPr/a:effectLst` (a table cannot be grouped in PowerPoint). **(e)** Components
  become `p:grpSp` (identity child transform) when contiguous in paint order; never tables or placeholders; a split
  shape (fill + border) is always one group. **(f)** Blocks with only hard breaks — one line included (fixer round 2,
  judge J2-01) — get `wrap="square"` at the HTML width when PowerPoint's width of every line stays ≥ 2 % inside the box
  ("fit") AND the HTML would wrap a longer line inside that box: not `nowrap`, not `shrinkWrap`, no text field (a page
  number never wraps), a single line not rotated and only with the IR flags present. So slide titles, eyebrows,
  captions, labels and meta values in fixed-width containers wrap where the HTML would; numbers (`nowrap`), pills,
  legend labels, footer notes and page numbers keep `wrap="none"`. **(g)** Readable object
  names; the IR id of every object in `<deck>.map.json`; a picture with empty alt = `descr=""` + Office's decorative
  flag, and so is every fill/border shape (it carries no text) and every group whose members are all decorative (fixer
  round 3, EDIT-08); a dark opaque fill shape carries a white default run colour (`a:lstStyle` lvl1pPr defRPr), so text
  typed into it is legible (EDIT-12); a chart frame's `descr` = its kind, categories,
  series values and value range in Korean; a first row of header cells = `tblPr@firstRow` (fixer round 2). The
  template's 11 stock layouts, English master prompts (now `lang="ko-KR"` too), the master's stock date / footer /
  slide-number placeholders (fixer round 3: the footer is layout artwork, and ticking "Footers" in Slide Master view
  would have copied them over it), the 4:3 view guides (now the 16:9 centre, pos 3840 / 2160), "Office Theme" name and
  printer settings are removed/replaced
  (fixer round 2, J2-02): New Slide offers only the deck's own layouts. **(h)** Theme colours from `theme.colors`; docProps (title, author, dates, slide titles, thumbnail).
- Every output deck must pass the converter's gates ("Gates and policy" above). The Microsoft Open XML SDK
  3.3.0 validator (Microsoft365; any error = repair-prompt risk) is dev/CI-only (`scripts/openxml-validator/` in the
  repository, run by the Docker smoke), not part of the image.

### PowerPoint vertical metrics (for the baseline "seat" formula; usWin per unitsPerEm)
| profile | faces | unitsPerEm | usWinAscent | usWinDescent |
|---|---|---|---|---|
| embedded | Pretendard / SemiBold / Bold / ExtraBold | 2048 | 1949 | 494 |
| malgun | 맑은 고딕 regular + bold (Malgun Gothic 6.69, constants — never read the file at build time) | 2048 | 2229 | 495 |

### LibreOffice preview (Noah's server preview for a .pptx without a valid converter sidecar, NOT PowerPoint)
- LibreOffice 7.4 ignores PPTX-embedded fonts: the server image registers Pretendard, Gothic A1 and Selawik with
  fontconfig, with the alias 맑은 고딕/Malgun Gothic → Selawik, Gothic A1 (never `NotoSansKR-VF.ttf`: LibreOffice
  renders its Thin instance).
- Known LibreOffice-only differences (do NOT "fix" them in the converter): baselines lower by
  S·(0.3·pct − 0.2) (FixedCellHeight puts the whole spacing surplus above the line; text-mapping.md §2.3): ~1–3 px
  for body text, 6–8 px for 40–60 px text with line-height > 1.2 × size (judge J1-22 measured +6/+7 px on the
  titles and KPI numbers); mixed Korean/Latin runs wider by autospacing, +8–9 % on long lines and up to ~14 % on
  short strings with several Hangul/Latin boundaries ("2026년 3분기" +13.7 %, J1-21); different Korean wraps;
  holeSize ignored (always 50 %); SVG drawn from the PNG fallback; blur sigma slightly smaller; gradients stepped
  with aliased rounded ends; with the REAL Malgun Gothic table rows 2–3 px taller (cell lines from ascent+descent;
  fixed upstream in 2025, tdf#165521).

