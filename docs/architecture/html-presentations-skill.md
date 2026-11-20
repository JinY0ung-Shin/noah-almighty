# html-presentations skill (a slide deck as ONE `.html` file)

> The bundled `html-presentations` skill: where it came from, what Noah's copy changes and why, how a deck
> reaches the user, and what was checked. The pptx skill (HTML slides converted to an editable `.pptx`) is a
> different thing — [`pptx-converter.md`](pptx-converter.md). How a shared `.html` file is drawn is in
> [`chat-sse-media.md`](chat-sse-media.md) and [`client.md`](client.md); principles are in the root
> [`CLAUDE.md`](../../CLAUDE.md).

## What it is (2026-11-20)

`default-skills/skills/html-presentations/` — `SKILL.md` (the page shell, slide patterns, design rules, delivery),
`references/` (three themes, SVG diagram and animation patterns), `assets/example-agent-skills-overview.html` (one
finished deck to study) and `NOTICE.md`. It has no tool and no toolchain: the avatar WRITES one self-contained
`.html` file in the conversation folder (vanilla HTML/CSS/JS, inline SVG, nothing loaded from the network) and
delivers it with `mcp__file_output__share_file`. Like every bundled skill it is found by its folder
(`listPluginRootSkills`) and copied into the sandbox by `piSkills.ts`; nothing in Noah's server or client knows
its name.

Adapted from `skills/html-presentations` of [ericmjl/skills](https://github.com/ericmjl/skills) (commit
`a4be0bf`, `license: MIT` in its `SKILL.md`; the repository has no LICENSE file — `NOTICE.md` records this and
lists every change).

## Why Noah's copy differs: the file is read twice

Noah never runs a page's scripts: the 파일 tab (and an `html` canvas) draw a page through
`canvasHtmlDocument` — DOMPurify, `<iframe sandbox="allow-same-origin">` — and `fitCanvasFrame` then grows the
frame to the page's height. Upstream's deck is built by its script: every slide is `position: absolute;
opacity: 0` until the script marks one `.active`. Drawn by Noah, the upstream exemplar showed NOTHING — 0 of
19 slides, 137 of 137 text elements hidden.

So Noah's page shell is the same deck written the other way round:

- **Without script** the slides are a stack — each `.slide` a block of `min-height: 56.25vw` (16:9 of the
  frame's width), one under the other. That is what the 파일 tab shows.
- **With script** a one-line script in `<head>` sets `html.js`, and every deck-mode rule sits under `.js`
  (`.js .slide { position: absolute; inset: 0; opacity: 0 }`, the nav bar, the overview): in the user's own
  browser the downloaded file is upstream's deck — keys, progress dots, overview grid, the slide kept in the
  URL hash.
- **A hidden start state is always under `.js`** (`.js .slide .anim-fade { opacity: 0 }`): without script
  nothing would reveal it.
- **No `vh` inside a slide; lengths are `vw`.** The frame is fitted to the page, so a `vh` length there grows
  with the page it sizes. Upstream's `vh` spacings were converted at 16:9 (`1vh` = `0.5625vw`). The deck-mode
  chrome (nav bar, overview) keeps `vh`: it exists under `.js` only.
- A supplementary link carries `href="#<slide id>"` next to `data-goto`, so it is an ordinary link where the
  script is not there to catch the click.

Also changed: the description is for an EXPLICIT HTML / web deck only — a PowerPoint request, or a deck with no
format named, stays the pptx skill's (both descriptions would otherwise claim "slide deck"); deck text follows
the user's language (`lang="ko"` in the shell); on an unattended turn the skill's "ask first" step is replaced
by stated assumptions; upstream's second exemplar (`canvas-chat-overview.html`, 118 KB of scripted interactive
demos — the part Noah's view never runs) and the author's notes for his other decks are left out.

## Delivery

`share_file` takes `.html` (30 MB cap; the 파일 tab draws a page up to 1 MiB). The card opens the page in the
파일 tab — the stack. To present, the user downloads the file and opens it in a browser. No share link ever
exports an HTML page ([`share-links.md`](share-links.md)). The skill tells the avatar to say both.

## What was checked

- `tests/html-presentations-skill.test.ts` — text checks of the page shell in `SKILL.md`, the exemplar and the
  animation reference: the `<head>` script, deck mode under `.js` only, no rule or inline style that hides
  an element outside `.js` (the deck-mode chrome aside), no `vh` in a slide, nothing loaded from elsewhere,
  the description's boundary with pptx.
- **In Chromium (2026-11-20, a one-off harness, not in the repo)** — the exemplar and a deck made from the shell
  alone (Korean text, a diagram with a marker, a filter and all three animation classes), each read both ways.
  As a file with scripts on: one slide fills a 1600×900 window, → and Space move to the third slide with `#2`
  in the URL, a reload stays there, Esc opens the overview, no slide's content overflows, no request leaves
  the file. Through DOMPurify into a 760 px wide script-less frame with `fitCanvasFrame`'s loop: no `<script>`
  left, 19 of 19 slides drawn as 760×428 blocks one under the other, no text element hidden, every `.anim-draw`
  path drawn, the SVG markers, `marker-end` attributes and the drop-shadow filter still there, the nav bar
  not shown, and the frame at its final height after ONE step (8123 px; the same on a second fit).

NOT checked: a deck a model actually writes from the skill; the page inside Noah's real 파일 tab (the frame was
rebuilt from `canvasHtml.ts` in a bare page); the downloaded file on a user's machine.
