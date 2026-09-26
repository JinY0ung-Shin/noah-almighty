---
name: pptx
description: Use when the user asks for a PowerPoint / PPT / slide deck / presentation (발표자료, 슬라이드, PPT) or wants a .pptx created, restyled or edited. New decks are designed as HTML/CSS slides and converted into a .pptx whose text, shapes, tables and charts are native, editable PowerPoint objects (Pretendard embedded; 맑은 고딕 on request); existing .pptx files and user templates are edited with python-pptx. Delivery via mcp__file_output__share_file.
---

# PowerPoint decks (.pptx)

Deck text follows the user's language (default Korean). Titles state the takeaway.
You design each slide as HTML/CSS with this skill's component kit, check the renders, and convert the deck with
ONE command into a .pptx whose text boxes, shapes, tables and charts are native, editable PowerPoint objects.
Paths in `reference/` and `examples/` are relative to this skill's base directory, `${CLAUDE_SKILL_DIR}`.

## 0. Preflight

Read the "Document deck generation (PPTX)" line of `mcp__system__describe_system` (once per conversation) and
act on its marker:

| the line contains | path |
|---|---|
| `converter: INSTALLED` | HTML path: §1–§8 |
| `toolchain available` + `converter: NOT INSTALLED`, or `toolchain available` with no `converter:` marker | python-pptx path (§9); tell the user the design converter is not installed in this deployment, so the deck will be plainer |
| `UNAVAILABLE` | stop: tell the user a system administrator must rebuild the server image to enable PPT generation |

A tail on that line overrides the table: `read-only`, ``administrator disabled the `pptx` skill`` or
`preview/download need an interactive chat turn` → do not build a deck in this run; explain why in one sentence.
If describe_system is unavailable in this run, `bash ${CLAUDE_SKILL_DIR}/scripts/deck.sh probe` answers the same
question (exit 0 = converter installed, exit 4 = not; it starts no browser; its `selftest` line is informational).

- Never install anything (no pip/apt/npm, no browser download) and never work around a missing toolchain.
- When the system prompt says no one is watching (a scheduled routine, a delegated bot task), never ask questions:
  make sensible choices (the default font profile included), build and deliver. Otherwise follow the system
  prompt's rule for the turn.

## 1. Pick the path

- A NEW deck, or restyling an existing one → HTML (§2–§8). To restyle, read the old deck's text with python-pptx
  (`${CLAUDE_SKILL_DIR}/reference/python-pptx.md` has a snippet) and author new slides; never convert its XML.
- Edit an existing .pptx in place, or build on the user's own template/master → python-pptx (§9).
- A deck this converter built → edit its HTML and rebuild (§8); never python-pptx it.

## 2. Plan the deck

- One takeaway per slide, and that claim is the slide title (a finding such as "revenue and profit both grew by
  double digits", not a topic such as "revenue"). For reference content (onboarding, an org chart, a schedule, a
  directory) the takeaway is what the reader should know or do — "ask your buddy first, then the owning team" —
  and the structure itself (the org tree, the week grid, the directory table) is the slide's one visual.
- Typically 4–10 slides; the hard limit is 60 slides per build (describe_system's deck line shows the limit in
  force; split a larger deck into several builds). A requested slide count includes the cover: when it equals the
  number of topics the user listed, give each topic its slide and put the deck title on the first one instead of
  adding a cover (when interactive and unclear, ask). Eyebrow numbers follow the user's order of topics.
- Never invent figures: use the user's data, exactly as given. When they want a template or give no data, use
  clearly marked sample data — a visible note on the slides like the examples' footer — and say so in your reply.
  When they give only SOME of the figures the deck needs: mark every figure you add where it appears (a caption or
  footnote such as "예시 수치"), make the footer note name the user's figures (identical on every content slide),
  keep slide titles on the user's figures or qualitative — never a title that rests on a sample figure — and in the
  reply list the sample figures to replace and offer to rebuild with the real ones.
- Confirm the outline first only when the request is large or ambiguous AND the chat is interactive; otherwise
  decide and build — a finished draft is easier to correct than a list of questions.

## 3. Deck folder

One folder per deck with an ASCII name (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, e.g. `q3-review`). The title in
the user's language goes into `share_file`'s `name`, never into the folder name.

```
q3-review/
  slides/01-cover.html, 02-kpi.html …   NN-name.html, NN = 01…60, unique; numeric order = slide order
  deck.css                              optional: palette/brand token overrides, linked as ../deck.css
  assets/                               optional: images, referenced as ../assets/<file>
  .build/                               converter scratch: renders, reports, logs (safe to delete)
  q3-review.pptx, q3-review.preview/    written by build (-malgun suffix for the malgun profile)
```

- Create it in the current working directory (the conversation's scratch workspace). When the working directory
  is a repository clone, create it in the scratch workspace listed as an additional working directory, unless the
  user wants the deck committed (`.build/` and the preview folder carry their own `.gitignore`).
- Start from the closest example. `${CLAUDE_SKILL_DIR}/examples/README.md` maps each kind of content (agenda,
  KPI dashboard, trend and mix charts, table, section divider, strategy framework, comparison, roadmap, targets,
  closing, org chart, week schedule, directory) to an example slide: `business-review` is a 4-slide results report,
  `layouts` an 8-slide plan from agenda to decision, `handbook` 3 reference slides (org chart, first-week schedule,
  contacts). `cp -r ${CLAUDE_SKILL_DIR}/examples/business-review ./q3-review` (add slide files from the other decks
  as needed), then delete, renumber and edit slides — rewriting a slide's content is usually one Write of the whole
  file, not many small edits. Never build inside `${CLAUDE_SKILL_DIR}` — it is read-only and the converter refuses
  it.

## 4. Author

Read `${CLAUDE_SKILL_DIR}/reference/AUTHORING.md` once per conversation, before writing the first slide: its rules
are what keep every object native and editable. The essentials:

- Skeleton: one `<main class="slide">` (1280×720); link exactly `../theme/base.css` and `../theme/fonts.css`
  (plus `../deck.css` when the deck has one); the only script is `../lib/chart.js`, on chart slides.
- Type: inherit `var(--font-sans)`; weights 400/600/700/800 only; explicit px line-heights ≥ 1.33 × font size.
- Text lives in leaf text blocks; line breaks are `<br>`; size boxes for text up to ~20 % wider (the 맑은 고딕
  profile) and keep ≥ 2 % free room.
- Only CSS with a PowerPoint equivalent (no filter, blend modes, clip-path, mask, radial/conic gradients,
  background images, text-shadow, pseudo-element content, scale/skew); real `<table>`s with text-only cells;
  charts as `[data-chart]` JSON; characters both fonts have (no emoji, no Hanja in body text).
- Structure hints: `data-layout`, `data-placeholder`, `data-group`, `data-field="slidenum"` (the text is the slide's
  position — renumber after reordering), and `id="footer"` on the shared footer.
- Speaker notes: `<template id="notes">` after `</main>`, one line per paragraph.
- Design (AUTHORING §9): build each slide around ONE visual that proves its title (a chart, bars on one scale, a
  timeline, a big number), keep one colour for one meaning across the deck, leave no dead zones inside cards, and
  vary the composition between neighbouring slides while the header, footer and grid stay fixed.
- Limits: 60 slides per build, 2 MB per slide file, 2,500 elements per slide, 20 MB per asset, 40 megapixels per
  picture (100 per slide), 100 MB of deck inputs, 540 s per run (AUTHORING "Limits").

## 5. Check

```
bash ${CLAUDE_SKILL_DIR}/scripts/deck.sh check <deck>
```

Run it in the FOREGROUND with the Bash tool's `timeout: 600000` — never with `run_in_background` — and never pipe
it (`| grep`, `| tail`): its exit code is the verdict, and a pipe reports the last command's instead. Every run ends
inside its own 540 s budget. It renders every slide in the `embedded` profile (`--profile malgun` for a 맑은 고딕
deck, `--profile both` to also report text that wraps differently between the profiles; `--only 03-table …`
limits the slides) and prints lint errors with slide, element and rule, then each soft-wrapped text with where it
breaks. Fix every error and re-run until it exits 0; the `NOTE malgun weights` line needs no action. Copy the
`Next:` command as printed: it keeps your `--profile`.

- With vision ("Image input (vision): supported" in describe_system — or, without describe_system, when a Read of
  the overview succeeds): Read `<deck>/.build/check/<profile>/overview-1.png` first (12 slides per sheet), then the
  1280×720 renders of changed or suspicious slides in `<deck>/.build/check/<profile>/html/`. Look for collisions,
  cramped text and unbalanced space. Never Read the 1920×1080 previews. After an `--only` check the overview shows
  only those slides, and `html/` still holds older renders of the others.
- Without vision, Read on images is blocked: rely on the check output and `<deck>/.build/check/report.json` —
  0 errors, and every listed soft wrap intended.
- To remove an unwanted wrap, prefer a `<br>` at a phrase boundary, a wider box or a smaller size; if you shorten
  the text instead, keep every figure and fact it states.

## 6. Build

```
bash ${CLAUDE_SKILL_DIR}/scripts/deck.sh build <deck> [--profile malgun] [--author "<name>"]
```

Also in the foreground with `timeout: 600000`, never piped. A build re-runs the check, so for a small edit `build`
alone is enough — its renders are then in `<deck>/.build/<profile>/html/` and
`<deck>/.build/<profile>/overview-1.png` (look there, not in `.build/check/`, which keeps the last check's). Pass
`--author` with the name of the person presenting the deck — normally the user you are talking to, by the name the
system prompt or the conversation gives you (default "Noah Almighty"). `--strict` (optional) also fails on
fidelity drift; decks do not need it. The build writes `<deck>/<deck>.pptx` (`<deck>-malgun.pptx` for the malgun
profile) plus its preview folder and prints the exact share command.

| exit | meaning | what to do |
|---|---|---|
| 0 | built (warnings possible) | deliver (§7) |
| 1 | authoring: lint errors, bad slide names, over a limit | fix the HTML (or split the deck) and re-run |
| 2 | usage: unknown command/flag, bad folder name, deck inside the skill dir, bad `--out`, a `--only` slide the deck does not have | fix the command |
| 3 | conversion: a gate rejected the deck — no new file was written | simplify the named construct and rebuild; if it persists, tell the user the converter cannot build that layout |
| 4 | toolchain (converter missing) or internal (a stage crashed) | toolchain: tell the user an administrator must rebuild the server image — but when describe_system reported `converter: INSTALLED`, retry once, then give the user the log path for the administrator; internal: retry once, then the log path |
| 5 | busy: a check/build of this deck is still running, or no converter slot was free | deck already running: wait for that run (see below), never start a second one; no free slot: retry once, then tell the user the server is busy |
| 6 | timeout: the time budget ran out | fewer slides or images, or split the deck into two builds |

If a Bash result says the command "was moved to the background" (it hit the timeout, or a message arrived while
it was running), it is still running: do not start another check or build of that deck. Wait for its completion
notice, then continue from its output exactly as if it had finished in the foreground.

## 7. Deliver

Only after `build` exited 0:

- Call `mcp__file_output__share_file` with `path` = the built `<deck>/<deck>.pptx` IN PLACE and `name` = the
  title in the user's language plus `.pptx`. Never copy, rename or edit the file after building: its previews are
  bound to those exact bytes, and the card's side panel then shows the converter's exact slide renders. Never
  rasterize or publish slide images yourself to deliver.
- Limits: 3 files per turn, 30 MB per file (the build already refuses a deck over 30 MB).
- Tell the user, in their language: the file is ready, with one line per slide; every text box, shape, table and
  chart is editable in PowerPoint (charts keep their data: right-click → Edit Data, "데이터 편집"); Pretendard
  travels inside the file, so desktop PowerPoint shows it even where it is not installed; PowerPoint for the web
  and Teams/SharePoint previews may show a similar font instead. For a malgun build: the chat preview uses a
  look-alike font; the file names 맑은 고딕 and embeds nothing, so PowerPoint on Windows — and PowerPoint for the web
  or Teams/SharePoint previews opened on a Windows PC — show the real 맑은 고딕, and a PC without it shows a similar
  Korean font.
- When the user will edit the deck, pass on what matters from `${CLAUDE_SKILL_DIR}/reference/EDITING.md` (longer
  text shrinks to fit, fixed chart axes, the footer lives in the slide layout, …).

## 8. Changes

Edit the slide HTML, `build` again and share the new file the same way. Never patch a converted .pptx with
python-pptx: the next build discards the change, and a changed file loses its exact previews.

## 9. Existing decks and templates

To edit an existing .pptx in place, or to build on the user's own template/master, follow
`${CLAUDE_SKILL_DIR}/reference/python-pptx.md` (python-pptx is installed system-wide in the server image;
describe_system says when `python3` cannot import it). The same file covers NEW
decks when describe_system reports `converter: NOT INSTALLED`. For a self-check render,
`bash ${CLAUDE_SKILL_DIR}/scripts/render_deck.sh <file.pptx> <out-dir>` writes one PNG per slide. Deliver with
`mcp__file_output__share_file` as in §7; such files get approximate LibreOffice previews.

## 10. Font profile

- `embedded` (default): Pretendard, embedded in the file (~5 MB of fonts).
- `malgun` (`--profile malgun`): the file names 맑은 고딕 and embeds nothing (small file). Choose it when the user
  asks for 맑은 고딕, when the audience mostly views in PowerPoint for the web or Teams/SharePoint (they ignore
  embedded fonts), for Hanja-heavy text (Pretendard has no Hanja), or when file size matters.
- The same HTML serves both profiles; build both when the user wants both. The malgun previews use a look-alike
  font.

## 11. Review with the user (interactive only)

To iterate on the design before delivery: publish the 1280×720 renders from `<deck>/.build/check/<profile>/html/`
with `mcp__file_output__show_file` + `hidden: true` and embed the returned URLs in ONE `mcp__canvas__show` markdown
artifact (`![Slide 1](<url>)` …); after a revision, re-show it with the SAME `canvasId`. Without the canvas tool,
show a few key slides inline with `show_file`. The final deck is still delivered with `share_file` (§7).

## 12. When something fails

A failed run ends with `FAILED (<class>): …` and a `Next:` line with absolute paths — follow it (its command keeps
the run's flags). Exit 1/2 → fix the HTML or the command; 3 → simplify the named construct; 4 → toolchain:
administrator, internal: retry once — and a toolchain failure while describe_system reports `converter: INSTALLED`
is retried once and then reported with its log path, never as "PPT generation is unavailable"; 5 → wait, never
start a parallel run of the same deck; 6 → fewer slides or images. Never pip/apt/npm install
anything, never edit files under `${CLAUDE_SKILL_DIR}`, and never replace the converter with screenshots pasted
into a .pptx. A failed build leaves the previous `<deck>.pptx` untouched: it does NOT contain your latest edits,
so never share it as if it did.
