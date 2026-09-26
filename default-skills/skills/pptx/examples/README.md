# Example decks

Three example decks, each a complete deck folder (`slides/NN-name.html`). Paths here are relative to the pptx
skill's base directory; SKILL.md §3 shows the copy command with the absolute path. All three use the same brand,
tokens and footer, so slides from any of them can be mixed in one deck. Every slide builds with
`deck.sh build --strict` in both font profiles (`--strict` is a maintainer check; decks do not need it).

## Using an example

1. **Copy the whole folder out of the skill directory** under a new ASCII name, e.g.
   `cp -r <this directory>/business-review ./q3-review`. Never build inside the skill directory: it is read-only,
   and the converter refuses a deck folder there. To mix slides from several decks, copy one deck, then copy the
   other decks' slide files into its `slides/` and give them the same footer (the deck name differs): the builder
   moves only the footer objects that are identical on every content slide into the slide layout, so a differing
   deck name would stay behind on each slide and be missing from slides added in PowerPoint (AUTHORING §8.2).
2. **Keep only the slides you need**, then renumber: the `NN-` file prefixes run 01, 02, … in slide order, and
   every page-number field (each element with `data-field="slidenum"`: the footer's `.page-num`, and the
   bottom-right number of the section divider and the closing) shows the slide's new position (the check fails
   with `field` otherwise).
3. **Replace all sample content.** The company (예시테크), people, dates, every figure, insight bullet, team name
   and contact are fictional. Once the slides carry the user's real data, remove the sample-data notes (the
   footer's "샘플 데이터 · 가상 기업의 예시 수치" (handbook: "… 예시 정보") and the bottom note of the dark slides:
   cover, section divider, closing); keep them only when you deliver a template with placeholder figures, and when only some figures are
   the user's, mark the rest (SKILL.md §2). Never leave an example figure or claim in a real deck, and keep every
   figure that appears on several slides identical everywhere. When the user's company, department, presenter or
   date is unknown, never invent one: remove the footer's `.footer-brand` and the cover's wordmark (the two-circle
   mark may stay), and fill the cover's meta row only with facts from the request (or remove the row).
4. **Keep what makes the slides convert**: the stylesheet links, `data-layout`, `data-group`,
   `data-placeholder`, `data-field`, the footer's `id="footer"` and the header/footer markup. Copy slide-specific
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
| `05-comparison.html` | two options with the same rows; each leads with its 3-year total and a cost bar on one scale, the recommended one as the dark card with advantage pills; the evidence in the subtitle; speaker notes in `<template id="notes">` | §8.18, §1 |
| `06-timeline.html` | a month-grid roadmap: quarter and month headers, one bar per workstream coloured by kind of work (with a legend), a go-live line and a milestone rail with one key milestone | §8.19 |
| `07-effects.html` | a KPI scorecard: current vs target as paired bars per row, the change as a pill in words, the goal in the accent colour, and a summary box with the yearly effect | §8.20 |
| `08-closing.html` | closing on its own layout (`data-layout="맺음"`): the decision as the title, the three items to approve, and the next steps on a rail | §8.21 |

## `handbook/` — 2026년 신입사원 온보딩 가이드 (3 slides: reference content)

| slide | what it shows | AUTHORING |
|---|---|---|
| `01-org.html` | org chart: the CEO box and a staff office on top, four division cards on one pitch with their teams and headcounts (each total = the sum of its teams), connector lines as 2 px rectangles painted first, the onboarding owner marked with a pill | §8.22 |
| `02-first-week.html` | a week grid as ONE native table (`.data-table--text`, every column left-aligned): time rows × weekday columns, the kind of session as the cell fill with a legend, the mandatory sessions in bold, the evidence for the title in the subtitle | §8.23, §8.9 |
| `03-contacts.html` | directory: the order to ask in on a dark card (numbered steps, an urgent note with `pill--down-on-dark`) next to a text table of topic, team, extension and chat channel at the width it needs; speaker notes | §8.24 |

The titles state what the reader should know or do — reference content has no finding to report.

The layouts and handbook decks have no cover of their own: put `business-review/slides/01-cover.html` (re-titled)
in front of them when a deck needs one.
