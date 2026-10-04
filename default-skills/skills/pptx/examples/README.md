# Example decks

Five example decks, each a complete deck folder (`slides/NN-name.html` + `deck.css`, plus `assets/` for the talk and
visual decks' pictures). Paths here are relative to the pptx skill's base directory; SKILL.md §3 shows the copy
command with the absolute path. All five ship the `classic` theme as their `deck.css` and use the same footer, so
slides from any of them can be mixed in one deck — and every colour, surface and radius in them is a theme token, so
copying another `themes/<theme>.css` over the deck's `deck.css` restyles all of it (SKILL.md §3). Three are documents
to read (보고서형: the kit's standard sizes, full sentences, tables); `visual` shows how a slide carries a picture — a
photo, a screen capture, phone screens, a photo slot for the user's own photo — with text that stays legible on it;
`talk` is a deck to present (발표형: few words at display sizes, the details in the speaker notes). Every slide builds
with `deck.sh build --strict` in both font profiles and every theme (`--strict` is a maintainer check; decks do not
need it).

## Using an example

1. **Copy the whole folder out of the skill directory** under a new ASCII name, e.g.
   `cp -r <this directory>/business-review ./q3-review`, then copy the theme you chose over its `deck.css`
   (`cp <skill directory>/themes/midnight.css ./q3-review/deck.css`). Never build inside the skill directory: it is
   read-only, and the converter refuses a deck folder there. To mix slides from several decks, copy one deck, then copy the
   other decks' slide files into its `slides/` and give them the same footer (the deck name differs): the builder
   moves only the footer objects that are identical on every content slide into the slide layout, so a differing
   deck name would stay behind on each slide and be missing from slides added in PowerPoint (AUTHORING §8.2).
2. **Keep only the slides you need**, then renumber: the `NN-` file prefixes run 01, 02, … in slide order, and
   every page-number field (each element with `data-field="slidenum"`: the footer's `.page-num`, and the
   bottom-right number of the section divider, the closing, the talk deck's photo slide and the visual deck's
   photo-slot slide) shows the slide's new position (the check fails with `field` otherwise).
3. **Replace all sample content.** The company (예시테크), people, dates, every figure, insight bullet, quote, team
   name and contact are fictional. Once the slides carry the user's real data, remove the sample-data notes (the
   footer's "샘플 데이터 · 가상 기업의 예시 수치" (handbook: "… 예시 정보", visual: "… 예시 수치와 합성 화면") and the
   bottom note of the dark slides: cover, statement, section divider, photo panel, closing, the photo cover and the
   photo-slot slide); keep them only when you deliver a template with placeholder figures, and when only some
   figures are the user's, mark the rest (SKILL.md §2). Never leave an example figure or claim in a real deck, and
   keep every figure that appears on several slides identical everywhere. When the user's company, department,
   presenter or date is unknown, never invent one: remove the footer's `.footer-brand` and the cover's wordmark (the
   two-circle mark may stay), and fill the cover's meta row only with facts from the request (or remove the row). A
   quote is someone's actual words: use one the user gives, never write one yourself. The photo and the screen
   captures of the talk and visual decks are synthetic placeholders: replace each with the file SKILL.md §2 planned
   for that slide — the user's attached image (`attachments/`), a capture of the system the deck is about
   (`captures/`), a Confluence diagram (`confluence/`, a draw.io diagram as its PNG preview) — copied into the deck's
   `assets/`, and rewrite its `alt` and the capture's source caption. Without a real picture, the slide's visual is
   the words themselves, a chart or a diagram; a photo slot for the user to fill
   (`visual/slides/05-photo-slot-hero.html`, the handbook team slide) only when the slide is about something the user
   will photograph (people, a venue, a product). Never keep a synthetic picture in a real deck, and never pass a drawn
   screen off as a capture. When the capture changes, recompute the frame's size from its aspect and the callout
   markers' positions from its pixels (each slide's `<style>` comment shows how). The photo slots (the handbook team
   slide's, the visual deck's photo-slot slide) stay empty in the .pptx for the user to fill: rewrite each
   `data-prompt` (and the hint that repeats it) to say whose or which photo goes there. A second team slide on the
   same `data-layout` as the handbook's would show THOSE prompts in its slots, because the slides of one layout share
   each slot's prompt by document order (AUTHORING §7): give it its own `data-layout` (e.g. `함께할 사람 2`), or put one
   generic prompt (`팀원 사진을 넣으세요`) on both slides.
4. **Keep what makes the slides convert and restyle**: the three stylesheet links (`../deck.css` included), the
   theme tokens instead of literal colours (`var(--c-…)`, `"var(--c-series-curr)"` in chart specs,
   `stroke="currentColor"` icons), `data-layout`, `data-group`, `data-placeholder`, `data-field`, the footer's
   `id="footer"` and the header/footer markup. Copy slide-specific
   CSS from the example's inline `<style>`; the shared components live in `converter/theme/base.css` (never edit
   it — override tokens in `<deck>/deck.css`, AUTHORING §9). Drawn bars, timeline bars and dots are sized by hand
   from the numbers they show: recompute their `width`/`left` when the numbers change (the formulas are in each
   slide's `<style>` comment and in AUTHORING §8).
5. Run `deck.sh check`, fix what it reports, then `build` (SKILL.md §5–§6).

## Which slide for which content

| content | start from |
|---|---|
| cover | `business-review/slides/01-cover.html` |
| agenda + one-card executive summary (why, the goal, the ask) | `layouts/slides/01-agenda.html` |
| KPI dashboard (4 figures + a verdict) | `business-review/slides/02-kpi.html` |
| a trend and a mix (line chart + doughnut) | `layouts/slides/02-diagnosis.html` |
| figures by unit (native table) | `business-review/slides/03-table.html` |
| a trend and its takeaways (column chart + dark insight panel) | `business-review/slides/04-chart.html` |
| section divider | `layouts/slides/03-section.html` |
| strategy framework: goal, three pillars, shared foundation | `layouts/slides/04-strategy.html` |
| two options compared, one recommended | `layouts/slides/05-comparison.html` |
| roadmap / schedule | `layouts/slides/06-timeline.html` |
| targets: current vs goal per KPI | `layouts/slides/07-effects.html` |
| closing: the decision you ask for and the next steps | `layouts/slides/08-closing.html` |
| org chart: units as a tree of boxes with connector lines | `handbook/slides/01-org.html` |
| schedule / week grid: sessions by day and time (a native text table) | `handbook/slides/02-first-week.html` |
| directory / contacts: the order to ask in + who handles what | `handbook/slides/03-contacts.html` |
| team / people with photos the user adds later: empty photo slots | `handbook/slides/04-team.html` |
| a photo that sets the scene, with the title on a scrim over it (a cover) | `visual/slides/01-photo-hero.html` |
| the screen of the system the deck is about, in a browser window, with numbered notes beside it | `visual/slides/02-capture-frame.html` |
| what to look at on a screen: numbered markers on a capture, the explanations below | `visual/slides/03-capture-callouts.html` |
| a mobile screen before vs after, in phone frames, with the figures that changed | `visual/slides/04-phone-screens.html` |
| a full-bleed photo the user adds later, with text that stays legible on any photo (here: the closing) | `visual/slides/05-photo-slot-hero.html` |
| talk (발표형) opener: the talk's one claim as a display statement, the event and who/when/where | `talk/slides/01-statement.html` |
| talk: one big number that proves the headline, with one sentence on what it counts | `talk/slides/02-big-number.html` |
| talk: one voice — a quote the user gave you, with its source | `talk/slides/03-quote.html` |
| talk: a photo that carries the mood, the message and two figures on a panel beside it | `talk/slides/04-image-led.html` |
| talk: before vs after — two halves with the same rows, one figure each | `talk/slides/05-versus.html` |
| talk closing: the one thing you ask the audience for, and the next dates | `talk/slides/06-closing.html` |

## `business-review/` — 2026년 3분기 사업 실적 보고 (4 slides)

| slide | what it shows | AUTHORING |
|---|---|---|
| `01-cover.html` | cover on a dark two-stop gradient (`data-layout="표지"`): brand mark, a confidentiality pill, a two-line title (`ctrTitle`), a subtitle (`subTitle`), a meta row on fixed columns, a decorative motif whose bars are real data | §8.13 |
| `02-kpi.html` | four KPI cards — the two the title claims as dark hero cards — with delta pills, prior-vs-current micro-bars and captions, plus a summary box | §8.1, §8.4–§8.8 |
| `03-table.html` | a native table with a header row, a highlighted row, a total row and coloured deltas, footnotes, and a subtitle carrying the evidence for the title | §8.1, §8.9 |
| `04-chart.html` | a native column chart (editable data, fixed axis, a lighter forecast bar) with an HTML legend, next to a dark panel with a big stat and a headline + detail insight list | §8.10–§8.12 |

## `layouts/` — 2027년 고객 경험 혁신 계획 (8 slides: a complete plan, from agenda to decision)

| slide | what it shows | AUTHORING |
|---|---|---|
| `01-agenda.html` | agenda: the four sections as white rows (number, title, one line, a chip with the section's headline figure) next to a dark summary card — a lead paragraph that soft-wraps on purpose (3 lines in `embedded`, 4 in `malgun`), the goal with current-vs-goal bars, and the ask | §8.14, §4.2, §5.3 |
| `02-diagnosis.html` | two native charts with one colour code: a line chart (two series, labels above the points) and a doughnut with a centre label and an HTML legend with values; a subtitle with the evidence and a finding under each chart | §8.15, §8.10 |
| `03-section.html` | section divider on its own layout (`data-layout="간지"`): a big section number, the title, a preview of the section's three strategies (icon rows), and the progress through the deck's sections | §8.16 |
| `04-strategy.html` | strategy framework ("house"): the goal as a dark roof band, three pillars with the same rows (a target metric from → to with an icon arrow, three actions), the shared foundation as a base band | §8.17 |
| `05-comparison.html` | two options with the same rows; each leads with its 3-year total and a cost bar on one scale, the recommended one as the dark card with advantage pills; the evidence in the subtitle; speaker notes as a talk track in `<template id="notes">` | §8.18, §1 |
| `06-timeline.html` | a month-grid roadmap: quarter and month headers, one bar per workstream coloured by kind of work (with a legend), a go-live line and a milestone rail with one key milestone | §8.19 |
| `07-effects.html` | a KPI scorecard: current vs target as paired bars per row, the change as a pill in words, the goal in the accent colour, and a summary box with the yearly effect | §8.20 |
| `08-closing.html` | closing on its own layout (`data-layout="맺음"`): the decision as the title, the three items to approve, and the next steps on a rail | §8.21 |

## `handbook/` — 2026년 신입사원 온보딩 가이드 (4 slides: reference content)

| slide | what it shows | AUTHORING |
|---|---|---|
| `01-org.html` | org chart: the CEO box and a staff office on top, four division cards on one pitch with their teams and headcounts (each total = the sum of its teams), connector lines as 2 px rectangles painted first, the onboarding owner marked with a pill | §8.22 |
| `02-first-week.html` | a week grid as ONE native table (`.data-table--text`, every column left-aligned): time rows × weekday columns, the kind of session as the cell fill with a legend, the mandatory sessions in bold, the evidence for the title in the subtitle | §8.23, §8.9 |
| `03-contacts.html` | directory: the order to ask in on a dark card (numbered steps, an urgent note with `pill--down-on-dark`) next to a text table of topic, team, extension and chat channel at the width it needs; speaker notes as a talk track | §8.24 |
| `04-team.html` | people on their own layout (`data-layout="함께할 사람"`): three cards, each led by a SQUARE photo slot (`.photo-slot` + `data-placeholder="pic"` + `data-prompt`: an EMPTY PowerPoint picture placeholder the user fills by clicking its icon), with the name and a role pill, the role line and a two-line note BELOW the slot, on the slot's own 224 px column (everything inside a slot is an HTML-only hint); speaker notes as a talk track | §7, §12 |

The titles state what the reader should know or do — reference content has no finding to report.

## `visual/` — 2026년 고객 포털 개편 결과 보고 (5 slides: built on pictures)

Each slide's visual is a picture — the kind SKILL.md §2 plans before any HTML: a photo the user attached, a capture of
the system the deck is about, a photo slot for a photo the user adds later. Every text on a picture sits on a scrim,
beside the picture or on an opaque marker, so the check's `text-on-picture` rule passes in every theme; the slides'
`<style>` comments show the arithmetic.

| slide | what it shows | AUTHORING |
|---|---|---|
| `01-photo-hero.html` | a cover on its own layout (`data-layout="사진 표지"`): a full-bleed photo (`object-fit: cover`), a scrim over the text column (brand-950 at 0.72: legible over any photo in every theme) and on it the brand, a kicker, the two-line title (`ctrTitle`), the subtitle (`subTitle`), the meta row and the sample-data note — all white, the secondary text at 80 % | §8.26, §7 |
| `02-capture-frame.html` | a capture of the system's main area (an element capture, never the whole screen) in a browser window drawn from shapes (the chrome box, three dots, an address pill; the capture inset at its own 1.6 aspect, `object-fit: contain`), its source as a caption under it, three numbered notes beside it and a summary box pinned to the window's bottom | §8.27, §7 |
| `03-capture-callouts.html` | the top of the same capture (`object-fit: cover` + `object-position: top`, cut below the KPI tiles) with three opaque numbered markers ON the controls it explains, the explanations in three cards below (each with a locator line) and the evidence for the title in the subtitle | §8.28, §7 |
| `04-phone-screens.html` | before vs after: two phone bezels drawn from shapes around the captures (their 0.5 aspect kept), an arrow between them, a label under each, and a card with the two metrics that changed (paired bars on each metric's own scale, the change as a green pill) | §8.29, §8.20 |
| `05-photo-slot-hero.html` | the closing on its own layout (`data-layout="사진 맺음"`): a full-bleed EMPTY photo slot the user fills in PowerPoint and over it — as siblings, never inside it — a scrim band with the ask as the title, the next dates on a rail, the sample-data note and the page number: legible for whatever photo goes in | §8.30, §7, §12 |

`visual/assets/` is synthetic, drawn by `converter/selftest/tools/make_assets.py --visual` (no third-party imagery, no
screen of a real product): `photo.jpg` is the same byte copy of `converter/selftest/features/assets/photo.jpg` as the
talk deck's, `capture-web.png` (1600 × 1000) an invented support dashboard, and `capture-phone-before.png` /
`capture-phone-after.png` (750 × 1500) one invented request form before and after — every label drawn with the
bundled Pretendard faces, the customer names already masked by the invented system itself. A real capture must not
show personal data either: there is no masking step, so capture a narrower element that shows none (an element
capture by `uid`, never the whole screen).

## `talk/` — 셀프 서비스 시범 운영 (6 slides: a talk, 발표형)

A deck to present, not to read: at most about 40 words per slide (footer included), the headline at display size in
one or two hard lines (60/80, the statement 84/112, the quote and the closing 72/96), supporting text at lead sizes
(22/32 to 28/40) and labels at 18/28, figures as big as the slide allows, and everything the speaker says beyond
that in the speaker notes — each slide's `<template id="notes">` is its talk track (what to say, the exact figures
to cite, the transition to the next slide, a timing cue in parentheses at the end).

| slide | what it shows | AUTHORING |
|---|---|---|
| `01-statement.html` | opener on the cover gradient (`data-layout="표지"`): an accent kicker with the event, the talk's claim as a two-line 84/112 statement (`ctrTitle`), who/when/where on a meta row, a moon motif of shapes | §8.25, §8.13 |
| `02-big-number.html` | a two-line display headline, the proof as a 280 px figure in the brand colour (optically aligned with the headline), and beside it a bar of the same share over one lead sentence on what the figure counts, its last line on the figure's baseline (one flex row, `align-items: last baseline`) | §8.25, §8.7 |
| `03-quote.html` | one voice, centred: a quote mark drawn as a filled `currentColor` SVG, the quote as the slide's 72/96 title, its source under a short rule; the survey figures behind it in the notes | §8.25, §7 |
| `04-image-led.html` | a photo filling the left half (`object-fit: cover`, `object-position` for the crop) on its own layout (`data-layout="사진"`), and EVERY text on the dark panel beside it — headline, lead, two figures, the sample-data note and the page number | §8.25, §7, §12 |
| `05-versus.html` | before vs after: two cards with the same rows (who answers, then the one figure that changed, pinned to the bottom), the after card dark, a connector circle cut into both cards on the seam; the headline names whose wait the figures count | §8.25, §8.18 |
| `06-closing.html` | closing on its own layout (`data-layout="맺음"`): the one ask as a 72/96 title, where to send it, the next three dates on a rail, the opener's moon again | §8.25, §8.21 |

`talk/assets/photo.jpg` is synthetic, not a photograph: a byte copy of the converter self-test's
`converter/selftest/features/assets/photo.jpg`, drawn by `converter/selftest/tools/make_assets.py` (no third-party
imagery, so it can ship).

The layouts and handbook decks have no cover of their own: put `business-review/slides/01-cover.html` (re-titled)
in front of them when a deck needs one — or `visual/slides/01-photo-hero.html` when the user gives a photo for it.
The talk deck opens with its statement slide instead.
