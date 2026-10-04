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
- `converter: INSTALLED` and a NEW deck in an interactive chat: §2's one scoping question comes next, before you
  read AUTHORING (§4).

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
- Give every slide its main visual AND its source before you write any HTML: what the slide shows to prove its
  title, and the file or data it comes from. describe_system's `Images for documents and decks` line says which of
  these this run has:
  - the images attached to the conversation: each is also saved as a file in `attachments/` (the user's message
    lists the paths);
  - with browser control connected, the system or page the deck is about: an element capture —
    `mcp__browser__screenshot` with the element's `uid` from a snapshot — whose copy is saved in `captures/` (the
    result names the path);
  - a diagram or picture on a Confluence page: `mcp__confluence__get_attachment` with `save_to_workspace: true`
    saves it in `confluence/` (`mcp__confluence__extract_page_assets` lists a page's images and draw.io diagrams).
    A draw.io diagram goes in as its PNG preview — the image attachment `extract_page_assets` matches to it (under
    `matched.drawioAttachments`) — never the `.drawio` source: that is an mxfile, not an image, and an `<img>` of it fails
    `image-load`;
  - the user's figures: a native chart; a structure (steps, parts, an org): a diagram from the kit's shapes;
  - or, deliberately, text: a statement, a quote, an agenda. Text is a legitimate visual — never add an image just
    to have one.

  Those folders are in the conversation scratch workspace. Copy the chosen file by the ABSOLUTE path its listing or
  tool result gives — with a repository open the working directory is the clone (§3), where a relative path misses
  them — into the deck's `assets/` under a short ASCII name (`cp <absolute path> <deck>/assets/site.jpg`), and
  place it as `../assets/<file>`: the file itself, never a description or a redrawing of it. Images attached on
  EARLIER turns are not listed again: `ls` the scratch workspace's `attachments/` (the
  `Images for documents and decks` line names the workspace). Never present a drawn mock-up as a real screen, never
  capture pages the deck is not about, and keep personal data and secrets off a capture: capture the element, not the
  whole screen — when an element shows personal data, capture a narrower one that shows none (there is no masking
  step).
- Typically 4–10 slides; the hard limit is 60 slides per build (describe_system's deck line shows the limit in
  force; split a larger deck into several builds). A requested slide count includes the cover: when it equals the
  number of topics the user listed, give each topic its slide and put the deck title on the first one instead of
  adding a cover. Eyebrow numbers follow the user's order of topics.
- Never invent figures: use the user's data, exactly as given. When they want a template or give no data, use
  clearly marked sample data — a visible note on the slides like the examples' footer — and say so in your reply.
  When they give only SOME of the figures the deck needs: mark every figure you add where it appears (a caption or
  footnote such as "예시 수치"), make the footer note name the user's figures (identical on every content slide),
  keep slide titles on the user's figures or qualitative — never a title that rests on a sample figure — and in the
  reply list the sample figures to replace and offer to rebuild with the real ones.
- Decide and build — a finished draft is easier to correct than a list of questions. The one exception is the
  scoping question below, and it also carries the outline check: for a large or ambiguous request, write the
  outline in your chat text right before that call — one line per slide, naming its takeaway and its visual — and
  let a one-line `이 구성으로 진행할까요?` replace one of its questions — never a separate question first.
- Pick the deck's theme with the plan (§3): a look that fits the topic, the audience and the tone — never the
  default by habit.

**One scoping question** (HTML path, NEW deck, interactive chat). Right after §0 reported `converter: INSTALLED`
and before you read AUTHORING, ONE `AskUserQuestion` call settles what the request leaves open:

- At most once per conversation: never for an edit, a rebuild or a theme switch of a deck from this conversation,
  and a later deck in the same conversation reuses the earlier answers. Ask only the questions still open (the
  user named a theme, brand colours, a length or the use → drop that question); skip the call when nothing is open
  or the user said to decide ("알아서").
- Never where nobody can answer it now: a scheduled routine or automated task, a personal-bot conversation (the
  hook denies the dialog there) or a delegated task, and a turn whose system prompt says
  `This turn was submitted by an **EXTERNAL SYSTEM**` (the external task API: the dialog is not blocked there and
  would park the task until someone answers it). Group-agent and teammate chats are interactive: ask there too.
- Up to 3 questions in that one call, every label and description in the user's language. The FIRST option of
  every question is the one you recommend, marked in the user's language at the end of its label (`(추천)`), not
  with the English `(Recommended)` the tool's own guidance suggests. The dialog needs an answer to every question,
  so each first option must be one you would build with. Never add an "Other" option: the dialog adds `직접 입력`
  itself (brand colours, another theme, any other wish).
  1. header `테마`, question `어떤 느낌으로 만들까요?`: the three themes that fit best (§3), labelled by name in the
     user's script (`포레스트 (추천)`), each described in ≤ ~40 characters by its look and Feel line
     (`짙은 초록·민트, 차분하고 신뢰감 있는 느낌`).
  2. header `분량`, question `몇 장 정도로 만들까요?`: e.g. `짧게 — 표지 포함 5장 내외` / `보통 — 8~10장` /
     `길게 — 12장 이상` (a requested count includes the cover).
  3. header `용도`, question `어디에 쓰실 자료인가요?`: `보고서형 — 읽는 문서` / `발표형 — 화면에 띄워 발표`.
     보고서형: the kit's standard sizes, full sentences, tables welcome. 발표형: ≤ ~40 words per slide in total
     (footer included), the headline at display size (60/80; an opening statement 84/112, a quote or the closing
     ask 72/96) in ≤ 2 hard lines, supporting text at lead sizes (22/32 to 28/40) and labels at 18/28, the one
     figure that carries the slide as a single big line (72 to 280 px), the details moved into the speaker notes
     (§4) while a headline figure keeps its scope on the slide; the `talk` example deck
     (`${CLAUDE_SKILL_DIR}/examples/talk/`, AUTHORING §8.25) shows the patterns.
- An answer that needs values ("직접 입력: 우리 회사 색") → build with the closest theme now and ask for the values
  in your reply. Skipped, cancelled or unanswered → build with the defaults: the theme by topic (§3), 보고서형
  unless the user said 발표, 발표용 or 투사, typically 4–10 slides.

## 3. Deck folder and theme

One folder per deck with an ASCII name (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, e.g. `q3-review`). The title in
the user's language goes into `share_file`'s `name`, never into the folder name.

```
q3-review/
  slides/01-cover.html, 02-kpi.html …   NN-name.html, NN = 01…60, unique; numeric order = slide order
  deck.css                              the theme: a copy of one of the skill's themes (linked as ../deck.css)
  assets/                               optional: images, referenced as ../assets/<file>
  .build/                               converter scratch: renders, reports, logs (safe to delete)
  q3-review.pptx, q3-review.preview/    written by build (-malgun suffix for the malgun profile)
```

- Create it in the current working directory (the conversation's scratch workspace). When the working directory
  is a repository clone, create it in the scratch workspace listed as an additional working directory, unless the
  user wants the deck committed (`.build/` and the preview folder carry their own `.gitignore`).
- Start from the closest example. `${CLAUDE_SKILL_DIR}/examples/README.md` maps each kind of content (agenda,
  KPI dashboard, trend and mix charts, table, section divider, strategy framework, comparison, roadmap, targets,
  closing, org chart, week schedule, directory, team with photos, pictures — a photo cover, a screen capture, callouts
  on a capture, phone screens, a photo the user adds later — and for a talk: statement, big number, quote, photo,
  before/after) to an example slide: `business-review` is a 4-slide results report, `layouts` an 8-slide plan from
  agenda to decision, `handbook` 4 reference slides (org chart, first-week schedule, contacts, team with photo
  slots), `visual` 5 slides built on pictures (a photo cover under a scrim, a screen capture in a browser frame,
  numbered callouts on a capture, phone screens before/after, a full-bleed photo slot), `talk` a 6-slide talk to
  present (발표형: statement, big number, quote, photo, before/after, closing).
  `cp -r ${CLAUDE_SKILL_DIR}/examples/business-review ./q3-review` (a 발표형 deck starts from `talk`; add slide files
  from the other decks as needed, `${CLAUDE_SKILL_DIR}/examples/visual/` for the slides that carry a picture), then
  delete, renumber and edit slides — rewriting a slide's content is usually one Write of the whole file, not many
  small edits. Never build inside `${CLAUDE_SKILL_DIR}` — it is read-only and the converter refuses it.
- Then give the deck its theme: `cp ${CLAUDE_SKILL_DIR}/themes/<theme>.css ./q3-review/deck.css` (the examples ship
  `classic`). Every slide links `../deck.css`, and every colour, surface, radius and shadow in the kit and the
  examples comes from its tokens, so the copy restyles the whole deck — covers, cards, tables, charts and icons.

| theme | look | fits |
|---|---|---|
| `classic` | royal blue, navy emphasis, one amber accent; soft white cards on a cool grey page | business results, plans and budgets, formal reports to management |
| `mono` | black and greys on white, one signal-red accent; hairline cards, 4 px corners, square tags | strategy summaries, research and analysis, design reviews, executive one-pagers |
| `editorial` | warm ivory page, espresso and terracotta, mustard accent; outlined paper cards | culture and people, brand stories, workshops and retrospectives |
| `midnight` | dark page and cards, electric blue, cyan accent | technology, engineering, AI and product demos, conference talks |
| `forest` | deep green with mint tints, sunflower accent | ESG and sustainability, public sector, healthcare, safety, training and education |
| `violet` | vivid violet, plum emphasis, coral-pink accent; large corners | marketing and campaigns, events and launches, creative proposals |

How each theme feels, and where it misleads (the same lines head each theme file):

- `classic` — Feel: formal, dependable and orderly, the familiar look of a management report; Avoid: culture,
  people and creative topics or festive events, where the corporate blue reads cold and generic
- `mono` — Feel: quiet, precise and analytical, with type and numbers carrying every slide; Avoid: celebrations,
  onboarding and people stories, where the stark black and red read severe
- `editorial` — Feel: warm, human and crafted, like a magazine spread; Avoid: financial results, technical
  deep-dives and compliance reports, where the warm paper look reads casual
- `midnight` — Feel: modern, technical and high-contrast, made for a big screen in a dim room; Avoid: decks that
  will be printed, and conservative audiences who expect a light corporate look
- `forest` — Feel: calm, trustworthy and caring, steady rather than salesy; Avoid: sales pitches, product launches
  and tech demos, where the calm green feels slow
- `violet` — Feel: energetic, bold and playful, made to stand out; Avoid: financial reporting, compliance, safety
  and sensitive news, where the vivid colours read frivolous

- Choose by the topic, the audience and the tone of the request; `classic` is for formal business reporting, not a
  fallback. The user's own words win: a named theme or look ("어둡게", "심플하게", "따뜻한 느낌"), or brand colours.
- Brand colours the user gives: derive the theme from them rather than editing values — `node
  ${CLAUDE_SKILL_DIR}/scripts/theme-check.mjs --derive '#0055AA' --accent '#FFB800' > ./q3-review/deck.css.new && mv
  ./q3-review/deck.css.new ./q3-review/deck.css`. The main colour is the brand; `--accent` is the second colour (leave
  it out to keep the base theme's accent); add `--base midnight` for a dark deck; quote every colour (a bare `#`
  starts a shell comment). For a new deck in the colours of a PowerPoint file the user attached (a template or an
  old deck), `--from-pptx <file.pptx>` in place of `--derive '…'` takes that file's theme colours — building ON its
  own masters and layouts is the python-pptx path (§1). It builds on `classic` (or `midnight`), keeps its neutrals,
  surfaces and shapes, prints a complete deck.css only when that passes the theme check (exit 1: nothing passed —
  try another accent or the other base; exit 2: a bad colour or file), and reports where each colour went: tell the
  user when their exact colour had to change (a light brand colour is darkened to stay legible on a light page). A
  look no theme has (a dark deck that is not about technology): copy the closest theme, replace its values in
  `deck.css` (AUTHORING §9 lists what follows), then run `node ${CLAUDE_SKILL_DIR}/scripts/theme-check.mjs
  ./q3-review`: fix every FAIL (contrast, data colours too alike), replace every `hue leftover?` WARN. Never
  reconstruct a company's brand colours from memory — use the ones the user states, or a theme.
- The cover and the closing are the slides people remember: keep the theme, but re-compose the example's decorative
  motif around the topic (its bars stand for real figures; a deck without such figures gets a motif of its own —
  circles, a ring, a band of shapes, a photo from the user under a scrim, as in the `visual` deck's cover).

## 4. Author

Read `${CLAUDE_SKILL_DIR}/reference/AUTHORING.md` once per conversation, before writing the first slide: its rules
are what keep every object native and editable. The essentials:

- Skeleton: one `<main class="slide">` (1280×720); link exactly `../theme/base.css`, `../theme/fonts.css` and
  `../deck.css` (the theme — a slide without it shows the default look); the only script is `../lib/chart.js`, on
  chart slides.
- Type: inherit `var(--font-sans)`; weights 400/600/700/800 only; explicit px line-heights ≥ 1.33 × font size.
- Colour through the theme's tokens: `var(--c-…)` in CSS and in inline `style` attributes, `"var(--c-series-curr)"`
  for a `data-chart` colour, `stroke="currentColor"` on an icon (it takes its container's CSS `color`); on a box that
  must follow the theme, `var(--c-surface)`, never `var(--c-white)`. A literal colour stays behind when the theme
  changes — only for something that must not follow it (a logo's own colour).
- Text lives in leaf text blocks; line breaks are `<br>`; size boxes for text up to ~20 % wider (the 맑은 고딕
  profile) and keep ≥ 2 % free room.
- Only CSS with a PowerPoint equivalent (no filter, blend modes, clip-path, mask, radial/conic gradients,
  background images, text-shadow, pseudo-element content, scale/skew); real `<table>`s with text-only cells;
  charts as `[data-chart]` JSON; characters both fonts have (no emoji, no Hanja in body text).
- Structure hints: `data-layout`, `data-placeholder`, `data-group`, `data-field="slidenum"` (the text is the slide's
  position — renumber after reordering), and `id="footer"` on the shared footer. A photo the user adds later is a
  photo slot: `data-placeholder="pic"` + a one-line `data-prompt` in the user's language on a sized, square-cornered
  box (`.photo-slot`), on a slide with its own `data-layout` — PowerPoint's empty picture placeholder; everything
  inside it is an HTML-only hint, so captions go next to it (AUTHORING §7).
- Pictures (AUTHORING §7): `<img src="../assets/<file>" alt="…">` with an explicit size. A screen capture keeps its
  own aspect (`object-fit: contain` in a frame of that aspect, or `cover` + `object-position: top` for the top of a
  UI) and is never shown larger than its pixels. Text over a photo or a photo slot sits on a scrim (a leaf
  `var(--c-brand-950)` box at opacity 0.72 under white text), an opaque card, or beside the picture: the check's
  `text-on-picture` rule fails text that a light or dark photo could swallow.
- Speaker notes: `<template id="notes">` after `</main>`, one line per paragraph — the talk track, what the presenter
  SAYS: an opener that moves on from the previous slide's bridge (never repeats it), the key point in spoken
  sentences (not the slide text pasted), the exact figures to cite as the slide shows them, a bridge to the next
  slide, optionally a timing cue in parentheses at the end of the last line (`(약 1분)`); 2–5 short lines. Plain
  text only: the template is parsed as HTML, so markup and anything in `<…>` vanish. A script or 대본 the user asks
  for goes into the notes, never into a separate .md file.
- Design (AUTHORING §9): build each slide around ONE visual that proves its title (a photo or screen capture, a
  chart, bars on one scale, a timeline, a diagram, a big number — or, for a statement or a quote, the words at
  display size), keep one colour for one meaning across the deck, leave no dead zones inside cards, and vary the
  composition between neighbouring slides while the header, footer and grid stay fixed. A 발표형 deck (§2)
  keeps to AUTHORING §8.25: few words at display sizes, the rest in the speaker notes.
- Limits: 60 slides per build, 2 MB per slide file, 2,500 elements per slide, 20 MB per asset, 40 megapixels per
  picture (100 per slide), 100 MB of deck inputs, 540 s per run (AUTHORING "Limits").

## 5. Check

```
bash ${CLAUDE_SKILL_DIR}/scripts/deck.sh check <deck> --profile both
```

**Check a Korean deck with `--profile both`** — not only the profile you will build. Hangul is up to 20 % wider in
`malgun` (§10), so a cramped table cell, an overflowing box or a line that breaks mid-word usually shows up in
`malgun` ALONE: the default `embedded`-only check reports the same HTML as 0 errors, 0 warnings and you ship the
defect. `--profile both` renders both and fails on an error in either. Only for an all-Latin deck, or a re-check
of one slide you just edited (`--only 03-table …`), is a single profile enough.

Run it in the FOREGROUND with the Bash tool's `timeout: 600000` — never with `run_in_background` — and never pipe
it (`| grep`, `| tail`): its exit code is the verdict, and a pipe reports the last command's instead. Every run ends
inside its own 540 s budget (both profiles included). It prints lint errors with slide, element and rule, then each
soft-wrapped text with where it breaks, the blocks that wrap differently between the profiles, and table cells with
too little slack. Fix every error and re-run until it exits 0; the `NOTE malgun weights` line needs no action. Copy
the `Next:` command as printed: it keeps your `--profile`.

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
| 0 | built (warnings possible) | deliver (§7); a photo-slot warning first — `placeholder-layout` (New Slide would bring empty slots) or a fidelity `[placeholder]` line (PowerPoint shows another slide's prompt): fix it (AUTHORING §7) and rebuild |
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
- A link other people can open: only when the user explicitly asks for one (a plain 공유해 줘 about the deck is the
  `share_file` above). Call `mcp__file_output__create_share_link` after delivering the deck when describe_system's
  `Share links` line says this run has it; otherwise point them to the `공유 링크` button next to the file card
  (a group-agent thread cannot be link-shared at all: say so).
  With a link, say that whoever opens it can also download the .pptx, speaker notes included.
- Tell the user, in their language: the file is ready, with one line per slide — naming the slides that show
  their attached images or your captures (and what each capture shows), and what goes into each empty photo slot (its
  prompt; they insert the photo in PowerPoint); the theme you chose and one or two others that would suit this deck (a
  rebuild away); every text box, shape, table and chart is editable in PowerPoint
  (charts keep their data: right-click → Edit Data, "데이터 편집"); each slide's speaker notes hold its talk track and
  are part of the .pptx, so whoever gets the file (a download, a forwarded copy, a share link) can read them;
  Pretendard travels inside the file, so desktop PowerPoint shows it even where it is not installed; PowerPoint for
  the web and Teams/SharePoint previews may show a similar font instead. For a malgun build: the chat preview uses a
  look-alike font; the file names 맑은 고딕 and embeds nothing, so PowerPoint on Windows — and PowerPoint for the web
  or Teams/SharePoint previews opened on a Windows PC — show the real 맑은 고딕, and a PC without it shows a similar
  Korean font.
- When the user will edit the deck, pass on what matters from `${CLAUDE_SKILL_DIR}/reference/EDITING.md` (longer
  text shrinks to fit, fixed chart axes, the footer lives in the slide layout (on the slide itself when the slide is
  alone on its layout), an empty photo slot takes a photo from its icon, a photo or capture is swapped with Change
  Picture and the scrim above it stays, …).

## 8. Changes

Edit the slide HTML, `build` again and share the new file the same way (in an interactive chat, that is the next
review round, §11). To switch the theme, copy another theme over `deck.css` and rebuild — nothing else changes.
Never patch a converted .pptx with python-pptx: the next build discards the change, and a changed file loses its
exact previews.

## 9. Existing decks and templates

To edit an existing .pptx in place, or to build on the user's own template/master, follow
`${CLAUDE_SKILL_DIR}/reference/python-pptx.md` (python-pptx is installed system-wide in the server image;
describe_system names the interpreter to run it with, and says when it is not importable at all). The same file covers NEW
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

In an interactive chat, every build that exits 0 is delivered AND opens a review round: the user writes notes per
slide on ONE canvas, and you apply all of them with one rebuild. Not in the runs §2 excludes (routines and
automated tasks, personal-bot conversations and delegated tasks, EXTERNAL SYSTEM turns): there, deliver (§7) and
finish. Each round, in this order:

1. `deck.sh build` exits 0 → `share_file` the new .pptx IN PLACE (§7). The user always has the latest file; never
   hold it back until they say they are done. A share link opens the card it was made for, and each round's file
   is a new card: if this conversation already made a link, say in the round's reply that it still shows the
   earlier version. Make a new one (`create_share_link` after this round's `share_file`) only if the user asks,
   and then suggest revoking the old one in 내 아바타 → 권한·연결 → 공유 링크.
2. Publish renders with `mcp__file_output__show_file` + `hidden: true` from `<deck>/.build/<profile>/html/`, the
   build's own (not `.build/check/`, which is stale after a build). Round 1: every slide. Later rounds: only the
   slides whose HTML changed, plus every slide after a theme, footer or numbering change; reuse the other URLs
   (show_file copies the bytes, so they keep showing their render). One turn publishes at most 30 hidden images,
   in every round: when a round needs more than 30 renders (round 1 of a deck over 30 slides; a later round after
   a theme, footer or numbering change on such a deck, or with more than 30 changed slides), publish the
   `overview-N.png` sheets from `<deck>/.build/<profile>/` instead.
3. `mcp__canvas__show` (markdown; from round 2 on, pass the `canvasId` the first call returned) with `wait: false`
   as the LAST tool call of the turn: its form stays locked until the turn ends. Before each image a heading, and
   Korean alt text: `### 3번 슬라이드 – 매출 추이`, then `![3번 슬라이드 – 매출 추이](<url>)` (an overview sheet's
   heading names its slide range). Controls, all `type: "text"` with `required: false`: up to 11 slides → one per
   slide, its label identical to that slide's heading (the form sits below all the images), placeholder
   `수정 요청`, plus one overall note (`전체 의견`); 12 or more → ONE `multiline` control for all slides
   (`슬라이드별 수정 요청`), one request per line as `번호: 요청` (placeholder `예) 3: 제목을 더 짧게`), plus the
   overall note — a canvas holds at most 12 controls. Ids carry the round: `r1-s03`, `r1-all` (`r1-list` for the
   multiline box), next round `r2-…` — the panel keeps what was typed under a re-used id.
4. End the turn with your reply: in round 1 the §7 message; in a later round the notes you applied, the ones you
   skipped and why, and a question about any unclear note (never guess). Close with one line: fill in the notes
   and submit; submitting empty, or simply stopping, ends the review — the delivered file is already the latest.

The notes arrive as the next user message, `On the canvas "…" (id: …), The user responded on the canvas:` and one
`- <id>: <value>` line per control (empty = no note). Apply ALL of them, then ONE rebuild (when they change a lot of
Korean text, `check --profile both` first — §5, §6) and the next round. An all-empty submission ends the review:
say so in one line, no rebuild. A message with an older round's ids is a resend of notes already applied: do not
apply them again. Without the canvas tool (a group-agent chat, or the owner has not enabled the experimental
`canvas` feature), list the slides in your reply and invite `번호: 요청` lines in the chat. To let the user pick the
look, check two or three fitting themes on the same slides (one copy of the deck folder per theme, `--only
01-cover 02-…`) and show those renders, from each copy's `.build/check/<profile>/html/`, side by side on the canvas.

## 12. When something fails

A failed run ends with `FAILED (<class>): …` and a `Next:` line with absolute paths — follow it (its command keeps
the run's flags). Exit 1/2 → fix the HTML or the command; 3 → simplify the named construct; 4 → toolchain:
administrator, internal: retry once — and a toolchain failure while describe_system reports `converter: INSTALLED`
is retried once and then reported with its log path, never as "PPT generation is unavailable"; 5 → wait, never
start a parallel run of the same deck; 6 → fewer slides or images. Never pip/apt/npm install
anything, never edit files under `${CLAUDE_SKILL_DIR}`, and never replace the converter with screenshots pasted
into a .pptx. A failed build leaves the previous `<deck>.pptx` untouched: it does NOT contain your latest edits,
so never share it as if it did.
