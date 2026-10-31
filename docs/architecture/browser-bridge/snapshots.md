# Browser bridge — snapshot and reading-view rendering

> Detail page of [Architecture & Operational Notes](../../ARCHITECTURE-NOTES.md).
> Atom budgeting, state flags, table rows, respacing, links and images, and the nine `axtree.js` rules.

- **Snapshots are budgeted uid-first, and the budget unit is an ATOM, not a physical line.**
  `capSnapshot` (extension side, `axtree.js`) fits every snapshot into its character budget
  (`SNAPSHOT_MAX_CHARS` 30000 by default, tightenable per call — next bullet) by keeping `[uid]` atoms
  before prose — cut TEXT is recoverable via offset-chunked `read_text`, a cut uid is unreachable — and
  says what it dropped. The builders hand it the renderer's lines ARRAY (one entry per element; a
  textbox value can hold newlines): under a tightened `maxChars`, per-physical-line keeping cut a
  GitHub blob's 44.7 KB textbox value into NON-contiguous pieces with no marker and no closing quote,
  different on every call. An atom is kept or dropped whole; a uid atom too big to keep whole is
  HEAD-kept AFTER the whole-atom uid pass (so one oversized value cannot cost the page's other
  elements their uids) with a `[cut by the maxChars budget: … read_text (uid eN) …]` marker. String
  input still splits per line (legacy callers);
  `browserTools.report()` keeps a coarser defensive cap for old installed builds. Related renderer
  choices: links print their AX `url` property (`→ https://…`, so results can be compared without a
  click-and-load per candidate), NAMED table/tree rows and focusable non-opaque nodes mint uids
  (`NAMED_CLICKABLE_ROLES` — draw.io-style `<tr>` menus were visible but unclickable), and input ops
  focus via `focusForInput`, which falls back to a real centre click when `DOM.focus` refuses
  (ProseMirror bodies, canvases).
- **`snapshot` takes `uid` and `maxChars`; since 0.16.0 EVERY snapshot-returning action takes
  `maxChars` too, and `wait_for` returns no snapshot at all.** All optional, all full five-layer fields
  (`browserTools` zod → `BrowserRequest` → `routes/chat.ts` relay → `BridgeOperation` →
  `background.js`) — though widening `maxChars` to the 12 action tools needed NO wire work, because the
  chat relay always forwarded the field for every op; only the tool schemas (one shared
  `MAX_CHARS_SCHEMA`) and the extension's `op === "snapshot"` gate had to move. `uid` renders only that
  element's subtree (a frame header's uid scopes into that frame) and a dead uid raises read_text's
  re-snapshot error, not a silent whole-page fallback. `maxChars` tightens `capSnapshot`'s budget and is
  RE-CLAMPED extension-side to [500, 30000] (0.24.0; the floor was 2000 before — issue #63: an agent
  steps through a long task paying this budget on EVERY action, and the smallest useful confirmation
  is a few uid lines, not two thousand characters), so the wire value can only ever shrink the cap.
  The two floors move in LOCKSTEP (`MAX_CHARS_SCHEMA` server-side, `SNAPSHOT_CHARS_MIN`
  extension-side): an old build re-clamps a 500 up to 2000 — handing back four times what was asked
  for, a degrade, not a break.
  `wait_for` skips the action tail's snapshot read entirely (its own match loop still walks uncapped):
  one yes/no answer used to cost ~25 KB of page walk. Old builds ignore all of this and keep returning
  full snapshots — a degrade, not a break, which is why `BROWSER_EXTENSION_MIN_COMPATIBLE` stays 0.6.0.
- **A `screenshot` crosses THREE pixel units and only the middle one is the protocol's.** Every clip
  `captureShot` builds — viewport, element quads, `cssContentSize` — is CSS px;
  `Page.captureScreenshot` reads its `clip` as DIP = CSS px × `cssVisualViewport.zoom` (the user's own
  Ctrl+/−); the bitmap it returns is PHYSICAL px = clip × `scale` × the display's device scale factor.
  Probe-pinned in `tests/visual/zoom-capture.spec.ts` — measured across dsf × zoom × all three capture
  modes, since the protocol documents none of it. CSS and DIP coincide at 100% zoom ALONE, which is how
  an unconverted clip shipped for so long: correct on the developer's own unzoomed window, while in the
  FIELD it cropped the bottom-right 1−1/zoom of the visible page — a fifth at 125%, a third at 150% —
  and the model was handed that partial image as the viewport. So the clip converts once (× zoom) after
  the three branches build it; `SCREENSHOT_MAX_WIDTH` and the ~8000px-per-edge vision ceiling are
  measured on the PHYSICAL edge, because a 150%-scaled Windows display returns a bitmap half again over
  a CSS-measured cap; and `lastShot` keeps the clip in CSS px for the drift check plus
  `pxPerCss = scale × zoom × dsf` as the PREDICTED image-px-per-CSS-px factor — since #66 only a
  fallback, because the inversion reads the MEASURED bitmap instead (next two bullets, addressing.md).
  Both factors ride the ONE metrics read — zoom from `cssVisualViewport.zoom`, zoom × dsf from
  `visualViewport.clientWidth / cssVisualViewport.clientWidth`, the physical twin of the CSS block — and
  each falls back to the pre-conversion arithmetic when its field is absent. That one metrics read
  happens AFTER the uid branch's `quadsOf` — `scrollIntoViewIfNeeded` inside it CHANGES the scroll,
  and the quads it returns are relative to the POST-scroll viewport, so a `pageX`/`pageY` read before
  the scroll stitched the page-absolute clip out of two scroll positions: any element that started
  off-viewport captured a region offset by exactly the scroll delta (probe-pinned in
  `tests/visual/scrolled-hit-facts.spec.ts`; the field case was a ruler page whose button-10 capture
  showed button-4). The uid MAP's capture
  converts its clip the same way but leaves the PAYLOAD in CSS: the viewer draws boxes in exactly the
  doc size that payload declares, so converting the declared size too would move every box off its
  element.
- **A screenshot has a FOURTH pixel unit the bridge cannot measure — the size Claude's API resizes it
  to — so a VIEWPORT capture is PRE-FITTED to that size.** Claude answers a pixel question in the space
  of the image it SEES, which is the API's own aspect-preserving downscale to the model's native limits
  (https://platform.claude.com/docs/en/build-with-claude/vision +
  https://platform.claude.com/docs/en/build-with-claude/vision-coordinates, both fetched 2026-09-02):
  the STANDARD tier (every model before Claude 4.7) caps the long edge at 1568 px AND the whole image at
  1568 visual tokens — one token per 28×28 patch, `ceil(w/28) × ceil(h/28)` — while the high-resolution
  tier (Claude 4.7+) allows 2576 px / 4784 tokens; padding to the next multiple of 28 is added
  bottom/right only and never shifts the origin. Field case (issue #66): a 1400×2197 portrait capture is
  3950 tokens, so a standard-tier model is handed it resized to 874×1372 — a coordinate space ×1.60
  away from the bytes sent — and NO layer told either side the image's size. The report itself
  measured a pure ≈×1.145 scale skew (zero offset), which neither tier's resize alone produces; the
  leading explanation is the second defect (next bullet: the mapping was predicted, never measured),
  and only a REPORTED mapping can tell a wrong space from a wrong aim. `captureShot`'s viewport branch
  therefore takes its `scale` from `viewportShotScale` (`axtree.js`, pure and unit-tested): the existing
  physical caps first, then — when the resulting bitmap would not `visionFits` — shrunk to
  `visionFitSize` of it, the docs' own binary search ported faithfully (round-half-to-even on the short
  edge, so the reference table's `1075×1520 → 924×1307` reproduces exactly). The shrink RE-CHECKS in a
  bounded loop rather than trusting one pass: the fit is computed on the ROUNDED bitmap size, and a
  single pixel of rounding can put the result back over a 28px patch boundary. The target is the STANDARD
  tier for EVERY model, because the serving model's tier is NOT knowable here — the composer's model
  choices are pi-gateway's model ids with only an admin vision flag (`modelVisionPolicy.ts`, `visionForModel`)
  — and standard is the one answer that is exact for every Claude model, costing only fidelity on tall
  viewports for a high-resolution-tier one (the common 1920×1080 viewport already fits at 1400×788 =
  1450 tokens, unchanged; tier-aware fitting is a backlog item). ELEMENT and fullPage captures are
  deliberately NOT fitted: uid-mode fractions are scale-invariant, and fullPage never feeds coordinates
  at all (pixel mode refuses it) — which is exactly where a standard-tier fit would gut a long page's
  legibility.
- **The pixel→CSS mapping is MEASURED off the returned JPEG, and every screenshot says how big the image
  is.** `pxPerCss = scale × zoom × dsf` is a PREDICTION about bytes Chrome had not returned yet, and
  #66's other half is most likely exactly that gap: the reported ≈×1.145 skew is what a bitmap 7/8 of
  the predicted size would produce (unconfirmed — the field display could not be inspected), and
  nothing ever compared the two. So the worker parses the
  capture's own SOF marker (`jpegDimensions`, `axtree.js`, pure: SOI, segment walk, SOF = `0xC0`–`0xCF`
  minus DHT/JPG/DAC, stop at SOS/EOI, `0xFF` fill tolerated; the first ~64 KiB is decoded first and the
  whole payload only when the SOF is not in it) and stores `imageWidth`/`imageHeight` plus per-axis
  `pxPerCssX`/`pxPerCssY` on `lastShot`. Those are the truth `shotCssPoint` bounds-checks and inverts
  (addressing.md); the theoretical factor survives ONLY as the fallback for a bitmap that will not
  parse. And because the model cannot measure the image it is looking at, EVERY screenshot result
  carries `screenshotImageNote` on the bridge `note` channel that already existed: a viewport capture
  reports `Image: W×H px = the visible viewport (cssW×cssH CSS px), k image px per CSS px` — plus the
  browser zoom and display scale when either is not 1 — and states that `click_at`/`drag` pixel
  coordinates are positions on THIS image (x 0–W−1, y 0–H−1); an element capture says to aim inside it
  with uid-mode fractions instead; a fullPage capture says pixel coordinates cannot be measured on it
  and to take a plain viewport screenshot. Extension-side only (manifest 0.26.0), so
  `BROWSER_EXTENSION_MIN_COMPATIBLE` stays put and an old build simply captures unfitted and says
  nothing — the case the server's own oversize caveat covers (addressing.md, contract.md).
- **An EMPTY walk is retried and then says it is empty; it never passes for a blank page.** Two different
  too-early reads get two different treatments in the action tail. A snapshot BYTE-IDENTICAL to the
  previous one gets one 250ms re-poll (`STALE_SNAPSHOT_REPOLL_MS`) — a late AX flush after the lifecycle
  tick `flushLifecycle` forces. A snapshot with NO atoms at all gets up to three 500ms re-polls
  (`EMPTY_SNAPSHOT_REPOLL*`), because that is the between-DOCUMENTS case: an action that navigates can
  outrun `waitForLoad`, whose poll sees the OLD document already `complete` when the submit's navigation
  has not started yet, so the tree is momentarily gone. Field case: `type(submit)` into naver's search box
  answered zero elements where the next snapshot held 532. If it is still empty after the re-polls the
  result carries `EMPTY_SNAPSHOT_NOTE` — FIRST in the note, ahead of any tab notice, since an empty view
  reframes every other line and `capNote` truncates the tail. Silence here was the actual bug: an empty
  snapshot and a genuinely blank page are the same bytes, and the agent has no way to tell them apart.
  Scoped reads are exempt — `buildScopedSnapshot` already answers a hollow scope in words.
- **Snapshots print STATE, so a toggle click can be VERIFIED instead of assumed** (`stateFlags`):
  `[checked]`/`[unchecked]`/`[checked=mixed]` and `[pressed]`/`[unpressed]`/`[pressed=mixed]` print
  BOTH ways — "not checked" is exactly the fact a verifying read is after — while `[selected]` and
  `[disabled]` print only when true (every option in a listbox is unselected and every control is
  enabled; the false form is pure noise). `[expanded]`/`[collapsed]` covers disclosures. Read through
  `axStateFlag`, which normalizes Chrome's boolean-or-string delivery to true/false/"mixed"/undefined —
  a raw truthiness read printed half a page's checked boxes as unchecked. Range controls
  (slider/spinbutton) additionally print `[min 0 max 5]` via `rangeFlags` from the AX
  `valuemin`/`valuemax` properties — `slider = "5"` alone gave an agent no scale to aim at. `step` is
  deliberately NOT printed or read from AX: measured (`tests/visual/ax-facts.spec.ts`), Chrome does not
  expose it there at all, so the slider driver reads the DOM `step` attribute only.
- **BOTH views group a table ROW onto one line, and membership is found by CLIMBING, not by one hop.**
  One line per cell made a 650-cell finance table force the agent to COUNT columns to find where a row
  began — but the original `container.role ∈ ROW_ROLES` test broke on every REAL table: a cell whose
  text lives on a nested LINK is itself nameless (never printed), and the link's container is the CELL,
  not the row, so Wikipedia's GDP table printed the rank on its own line and split its header row into
  six. Each renderer now keeps a per-render `parentOf` map and climbs it (`rowChain`, 25-hop bound):
  a piece whose nearest row matches the open row APPENDS — ` | ` when its nearest CELL changed; more of
  the SAME cell is GLUED in the reading view (`glueSegments` on carried-whitespace evidence — see the
  rejoin bullet below — so a footnote marker reads back as `China[n 1]` like the page; the snapshot
  view keeps the space, its pieces are decorated renderings) — and a row slot nulled by run suppression starts a fresh line
  rather than resurrecting a deleted duplicate. Cells keep their full rendering, uid included, and the
  joined line still starts with the first cell's, which is what `capSnapshot`'s uid-first keep
  classifies it by.
- **The snapshot view is INDENTED by emitted depth, and single values are PRINT-CAPPED with markers.**
  `walkAxNodes` passes `emit` a depth (emitting ancestors only); `renderAxTree` prefixes one space per
  level (cap 12 — indentation is budget), which is what lets an agent tell a submenu from its parent
  and a review from the card above it. Every in-place rewrite keeps the indent of the position it
  rewrites (runs, byHref upgrades, row appends), and `capSnapshot`'s uid regex tolerates the leading
  spaces. A value longer than `VALUE_PRINT_MAX` (3000) prints with an explicit
  `[value truncated: showing N of M chars — read the full text with mcp__browser__read_text (uid eK)]`
  marker (names: 1000, `[label truncated: …]`); the caps apply to the PRINTED line only — echo
  suppression, run joining and href identity compare RAW strings, and `renderAxText` never clips, since
  it is the recovery channel the marker names. Field case: a GitHub blob view's hidden textarea
  (44.7 KB file) ate 504 of 1204 snapshot lines and served silently corrupted text. Probe-measured
  (`tests/visual/ax-facts.spec.ts`): Chrome does NOT truncate AX values (42 000 chars round-trip
  byte-identical), so that corruption was the PAGE's own virtualized DOM re-windowing the textarea —
  unfixable from here; the marker is what stops partial text posing as complete.
- **A name is RE-SPACED only when its descendants' text fully ACCOUNTS for it.** Chrome computes some
  names by welding descendant text together — a Naver Maps place button arrives as
  `button "영업 종료별점 4.76리뷰7,262TV 식스센스"` — and the separated child texts that could have
  been read instead are then deleted as a run-level ECHO of that very name, so the structure was
  unrecoverable. `respacedName` (inside `walkAxNodes`, feeding both renderers AND ancestor coverage)
  consume-matches the trimmed segments against the raw name (≥ 2 segments, 300-node bound): each must
  sit contiguously where the previous ended, and the only thing allowed BETWEEN two is whitespace the
  raw name carries and no segment does — Chrome's own block-boundary separator (probe-verified on
  naver's rating rows: the visually-hidden absolutely-positioned `place_blind` span holding 별점 makes
  Chrome write `별점 4.87` into the name while every child StaticText is edge-dry, which the old
  `segments.join("") === rawName` gate could never pass — every rating row printed welded). A segment
  carrying its OWN edge space declines the whole name (the PROSE GUARD: "옥수수 " + "크림 뇨끼" +
  "랑 …" is the page's own typography, and re-spacing it puts a space before a postposition), and the
  walk still aborts on TEXT_LEVEL wrappers, which split runs MID-word by construction ("검색어 광교역"
  must never become "검색어 광교 역"). Rebuild: a Chrome-separator seam gets its one space back; a dry
  seam is glued (word|word only) — a fully-welded name therefore behaves byte-identically to before,
  and the pinned honest limit is now a name mixing BOTH seam kinds ("가격 안내" over "가격"+"안"+"내"
  ships "가격 안 내" instead of declining; the trade un-welds every rating row this rule exists for).
  Segments are not StaticTexts only: a NAMED descendant contributes its NAME and is not walked into
  (accname semantics), and a reconstruction that fails still prints today's welded name — the benign
  direction.
- **Every rejoin site restores the whitespace the page's own text nodes CARRY, and guesses only when
  both edges are dry.** `glueSegments`' word|word character rule alone deleted real page spaces at
  every punctuation seam — Wikipedia read back as `deleted,check the deletion log`,
  `Wiktionary(dictionary)`, `currency.[3]Such fluctuations`, and a country list lost every `, `
  separator — because `walkAxNodes` trims names at emit and the trim destroys the evidence.
  `nameEdges` re-reads the UNTRIMMED name at each glue site (leading/trailing `\s`; `trail` suppressed
  when the piece printed a value, since the joined text then ends with the value); both renderers'
  inline runs and read_text's same-cell appends pass that evidence as `glueSegments`' third argument —
  a carried space wins over the character rule, while weld-only seams (`[`+`n 2`+`]`,
  `request a new article`+`.`, `Search for "`+`Accessibility tree`+`"`) stay exactly as the page wrote
  them. A same-cell seam has one more space source, structural rather than textual: SIBLING blocks in
  one cell (`crossesBlocks` — neither piece's container encloses the other's), because two `<p>`s in a
  cell have no text node spanning their edge, while `China` + `[n 1]` (same block, different depths)
  keeps welding.
- **A NAMED image outside every interactive ancestor mints a uid — and a SURFACE is not an
  "interactive ancestor".** Naver map markers surface as `image "음식점"` with nothing clickable above
  them, so reaching one was a click_at pixel gamble; but blanket image-uids would double a SERP with
  refs whose real click target is the wrapping link. `renderAxTree` tracks `interactiveOf` per emitted
  node and climbs `parentOf`: a link/button/named-row ancestor suppresses the image's uid, while
  `SURFACE_ROLES` (`region`/`application`/`canvas` — the map body itself, which mints a uid as a
  coordinate PLANE, not as the click target) are climbed PAST, because counting them re-lost exactly
  the markers the rule exists for. The ancestor test lives in the renderer, NOT in `isActionableNode` —
  that predicate is per-node and shared with `unlabeledInteractiveIds`, which has no chain to walk.
  Chrome's role string is `image` (probe-verified; `img` also tolerated). A marker's NEIGHBOURING label
  is FOLDED onto its line: 47 markers all named `image "음식점"` were clickable but indistinguishable, so
  a plain StaticText that lands immediately after a marker-minted image line (same container, ≤ 120
  chars, no value) rewrites that line to `image "음식점 <shop name>"` and is consumed — it never opens a
  run, joins a row, or mints anything (`pendingMarker`; `format()` returns `{line, uid, suffix}` so the
  rewrite cannot mint a second uid).
- **A password field's value renders as BULLETS everywhere the snapshot can see it, and
  `DOMSnapshot.captureSnapshot`'s `inputValue` is the one place it does not.** Chromium masks an
  `<input type=password>` in BOTH `getFullAXTree` and `getPartialAXTree` as one `•` per character
  (measured — `tests/visual/password-facts.spec.ts`), which is why a snapshot returned by the very op
  that typed a stored secret carries no credential, and why the extension can verify that write by
  LENGTH without ever holding the value as a comparable string. `captureSnapshot` is the exception: its
  `inputValue` column carries the PLAINTEXT of every field on the page. The clickable section below
  already ignores it (labels come from aria-label/title/alt/text), and the secret write's frame
  attribution reads only `documentURL` — **`inputValue` must never be rendered, quoted, or logged.**
- **A FULL snapshot also reports what the accessibility tree cannot see at all: DOM-clickable elements.**
  VOC field case: thumbnail grids built from bare `<div>`/`<canvas>` (a click listener and/or
  `cursor:pointer`, no role, no name, no tabindex) have NO accessibility-tree entry, so the walk minted no
  uid and the agent could not click a card it could plainly see in a screenshot — the one failure the
  image-uid and named-container rules above do not reach, because there is no AX node to attach a uid to.
  After the tree renders, the UNSCOPED path additionally calls `DOMSnapshot.captureSnapshot`
  (`computedStyles: ["cursor"]`, root session only — newly allowlisted, read-only, executes no page JS,
  the same exfiltration class as `getFullAXTree`) and appends a bounded trailing
  `clickable but not in the accessibility tree (DOM click listeners / pointer cursor):` section of
  `[e123] clickable "<label>" (dom: div#thumb.card)` lines. TWO signals, because neither alone finds the
  field case: Chrome's own `isClickable` (a real click listener ON the node) MISSES React-style ROOT
  DELEGATION entirely — measured, not assumed, and the reason the second signal exists — while
  pointer-cursor nodes catch those, taken at the BOUNDARY (the outermost element that INTRODUCES
  `cursor:pointer`) because the property inherits and a grid would otherwise report every descendant of
  every card. The guards all say "this is not the real target": BODY/HTML dropped, zero-area and
  < 12×12 boxes dropped, boxes covering > 50% of the viewport dropped (delegated containers and
  backdrops), any element whose backendNodeId — or an ancestor's, or a descendant's — ALREADY minted a
  uid in this render dropped (the AX element is the target; the DOM node around it is its wrapper), and
  among nested survivors the outermost wins — EXCEPT for a nested node that both carries its own click
  listener and covers under 80% of that ancestor's box, which is a distinct CONTROL rather than a layer
  over the same click. That exception is load-bearing, not a nicety: entry_ad's modal box has a listener
  that only calls `stopPropagation` and wraps the "Close" strip that actually dismisses it, so pruning the
  strip left a page with no route to unblock it at all (the click UNDERNEATH is correctly refused). The
  area test is what keeps the tile-plus-overlay case at one uid, and root delegation is untouched either
  way (there the tiles have no listener of their own). Since 0.24.0 the section runs TWO budgets (issue #62: 128
  interchangeable Confluence table cells crowded the editor's real controls out of the old 40-element
  cap): the walk COLLECTS up to 200 candidates (`EXTRA_CLICKABLE_COLLECT_MAX`, background.js — still
  zero CDP round trips per item), and `groupClickableItems` (`axtree.js`, pure, unit-tested) decides
  what earns one of the 40 PRINTED lines — a run of ≥ 4 elements sharing a SIGNATURE (the DOM hint
  minus its `#id` segment, `td#c12.confluenceTd` → `td.confluenceTd`; an empty signature never
  groups, there would be nothing to name the kind by) prints its first 2 with uids plus ONE unminted
  `… N more like the 2 above (td.confluenceTd)` summary line placed right after them, so the table
  costs 3 lines instead of the whole cap. Only PRINTED items mint uids (the rule the old cap already
  followed), and the trailing "N more" atom counts BOTH what the collection walk left behind and what
  the print budget dropped — a summary the limit cut contributes the members it stood for — never
  silently: a cap the agent cannot see is indistinguishable from the
  element not existing, which is the very bug this section fixes. Label and hint are derived PURELY from
  the DOMSnapshot payload already in hand (aria-label → title → descendant `img` alt → descendant text;
  hint = `tag#id.classes`), so the whole section costs ZERO extra CDP round trips beyond that one
  capture — no `describeNode` budget like rule 9's DOM hints. Uids ride the ordinary `mintUid`/`uidByNode`
  maps, so stability, document-lifetime invalidation and click/click_at/hover resolution all work with NO
  new op and no new wire field. Scoped and hollow-scope renders are unchanged — a deliberate v1 boundary
  (the guards are tuned against a whole-viewport picture; the hollow note now points at the full snapshot
  instead) — and `wait_for`'s internal match loop opts out (`withExtraClickables: false`): its 500ms
  polls stopped returning a snapshot at all in 0.16.0 precisely to stay cheap, and a whole-document
  serialization per poll would reverse that; the element becomes reachable one action later, in the
  settle tail's enriched snapshot. The truncation notice names the recoveries that genuinely work
  (screenshot + pixel click_at, or narrowing what the page shows), because scrolling cannot change a
  document-order selection and a scoped snapshot lacks the section entirely. Any CDP failure skips
  enrichment SILENTLY: it is an addition, never a new way for a snapshot
  to fail. Extension-side only (`axtree.js` + `background.js`, manifest 0.18.0), so
  `BROWSER_EXTENSION_MIN_COMPATIBLE` stays put — an old build simply lacks the section, a degrade rather
  than a break — and `snapshot`'s tool description says "MAY end with" for exactly that reason.
- **A link is never folded out of RUNNING PROSE, and the reading view keeps links in their sentence.**
  byHref folding deleted Wikipedia's mid-sentence "log in or create an account" (same href as the
  Personal-tools menu link printed far above), leaving "You need to and be autoconfirmed". An open
  StaticText run sharing the link's container marks the sentence as still being written: such a link
  prints instead of folding (SERP duplicates have no run beside them and fold as before). In
  `renderAxText`, a named link JOINS the text run outright — in the reading view a mid-sentence link is
  a word of the sentence, and breaking the line at it left prose in stubs.
- **Nine `axtree.js` rules exist because each one silently DELETED, DROWNED, or made UNREACHABLE real
  page content.**
  (1) `AXValue.value` is not always a string — a slider/spinbutton reports a number and `.trim()` threw,
  failing all three read tools on the whole page; both name and value are `String(… ?? "")`, with `??`
  not `||` so a numeric 0 prints as "0". (2) Echo suppression matches on TOKEN boundaries
  (`containsAsToken`), not `String.includes`: a substring hit let an ancestor label like
  "달력 2026.08.08" swallow every calendar cell named "2"/"8"/"20"/"26" — but a needle whose own edge
  IS a boundary character carries that boundary with it (a `[n 1]` link under a `China[n 1]` cell sits
  at a non-boundary `a` and printed the reference twice; digits-at-both-ends needles like "26" still
  demand real boundaries). Lines that are nothing but an EMPTY bracket pair (`( )`, `[ ]` — an opener
  AND a closer required, so a source listing's lone `}` survives) are dropped at both renderers' final
  filter, never a `[uid]` line. (3) `walkAxNodes` passes each
  emission its nearest emitting ancestor as `container`, which is what lets both renderers rejoin a
  paragraph that per-word `<span>`s split into a word per line, and lets `renderAxText` keep a table's
  row on one ` | `-separated line (`CELL_ROLES` inside `ROW_ROLES`) instead of a vertical list of cells.
  (4) `renderAxTree` folds links sharing a FULL href onto one line at the first occurrence's position,
  upgrading it in place when a later duplicate carries a longer name — one SERP result arrives as four
  to six links to the same destination. `linkHref` returns the URL untruncated because it is the dedupe
  identity; `printableUrl` applies `LINK_URL_MAX`, now 500 — a query with its tracking parameters or a
  doc anchor has to survive WHOLE, since a truncated URL names a target no tool can follow, which is
  worse than printing none; the cap still bounds what it exists for (data: URIs, tracker payloads).
  SAME-DOCUMENT fragment links are excluded from folding entirely: Chrome hands `href="#edit"` back
  ALREADY RESOLVED as `https://site/page#edit`, so it walked straight past the literal `#` test, every
  row of a ten-row table shared ONE href, and rows 2-10 lost their edit/delete links SILENTLY — no line
  in the snapshot at all. `documentUrl` (the RootWebArea's own url, its own fragment stripped because a
  page LOADED at an anchor reports one) is resolved ONCE per render and compared via `stripFragment`, so
  a `#sec` pointing at ANOTHER page stays a real destination and folds as before.
  Three later rules answer the same class of failure:
  (5) NAMED `region`/`application` containers mint uids (`NAMED_CONTAINER_UID_ROLES`) — a map's
  drawn body has no accessible children at all, so the container's own uid is the only thing click_at's uid
  mode can aim at; nameless ones stay structure, and `region` remains in `OPAQUE_NAME_ROLES` (a uid says
  "actionable", not "my name covers my subtree"). `canvas`/`Canvas` sit in BOTH sets too, but their uid
  does not come from here: every canvas mints through `INTERACTIVE_ROLES`, named or not (a real canvas is
  usually nameless, and Chrome computes a plain `<canvas>` as CamelCase `Canvas` — probe-measured), the
  field fix that keeps diagram editors and vision-off fraction clicks reachable. Their membership here is
  the SURFACE half of the meaning: `SURFACE_ROLES` now DERIVES from this set (one list, so the two cannot
  drift), and the opaque entry keeps a canvas's aria-label — which never comes from what it draws — from
  suppressing its fallback text as echo.
  (6) `renderAxTree` falls back to the AX `description`
  (where a `title` attribute lands) when an interactive node has neither name nor value, so a page of
  icon-only `button ""` lines becomes distinguishable; it never replaces a real name and never feeds
  ancestor coverage. (7) Echo suppression is TWO-layered: per-node token matching, plus a RUN-level
  whitespace-insensitive check at close — a `<mark>` highlight splits a sentence mid-word, so no fragment
  sits on a token boundary and the rejoined run repeated the container's whole label as a second line.
  Only runs of ≥ 2 segments may be dropped (a lone StaticText inside a longer label is the calendar
  case, rule 2), and suppression NULLS the slot, filtered out once at the end, because `byHref` holds
  line indices that must stay valid for the rest of the walk. (8) Inline TEXT-LEVEL SEMANTIC roles are
  STRUCTURAL (`TEXT_LEVEL_ROLES` — `mark`/`strong`/`emphasis`/`superscript`/`subscript`/`deletion`/
  `insertion`, the exact strings Chrome emits for `<mark>`/`<strong>`/`<em>`/`<sup>`/`<sub>`/`<del>`,`<s>`/
  `<ins>`, verified against `getFullAXTree`; `<b>`/`<i>`/`<span>` already arrive as `generic`). Rule 7
  alone was not enough: the highlight wrapper printed NOTHING yet still became the `container` of the
  fragment inside it while the rest of the sentence sat on the real container, so the halves never joined
  into one run and the ≥2-segment suppression never saw them — an autocomplete option re-spelled its own
  label as two extra lines. `code` and `time` are deliberately excluded: `<pre><code>` is a block, and
  dissolving it would glue a listing into the surrounding prose. (9) An interactive node with NO name, no
  value and no description gets a DOM hint printed beside its empty label
  (`[e48] button "" (dom: #map-zoom-in)`). `axtree.js` stays pure — `unlabeledInteractiveIds` only NAMES
  the nodes worth asking about (through `isActionableNode`, the one interactive predicate it now shares
  with `renderAxTree` so the two cannot drift), and `background.js` does the asking: `buildDomHint`
  (`DOM.describeNode` depth 2 → `#id`, else two class tokens, else an input's `type`, else a nested
  img/svg's alt/aria-label/title or the first text, clipped to `HINT_MAX_CHARS` 60), at most
  `HINT_FETCH_PER_SNAPSHOT` (8) UNCACHED lookups per snapshot, cached in `hintByNode` keyed exactly like
  `uidByNode` — misses cached as `""` so they are not re-paid, swept by `forgetTabRefs` (by key prefix, so
  a hint cannot outlive its tab even if the uid was already evicted) and cleared with the `REF_MAP_MAX`
  eviction. `renderAxText` gets NO hints: the reading view has no uids to disambiguate.
