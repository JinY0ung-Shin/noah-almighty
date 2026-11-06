# Browser bridge — addressing: uids, clicks, tabs, frames

> Detail page of [Architecture & Operational Notes](../../ARCHITECTURE-NOTES.md).
> `click_at`'s two modes, uid lifetime, the pinned working tab, the settle tail, and how frames are walked.

- **Elements are addressed by `backendNodeId`; screenshot-pixel `click_at` is the deliberate escape hatch** for
  targets the AX tree does not expose (canvas widgets, AX-invisible controls).
- **`click_at` has TWO modes and they share nothing but a name.** UID mode (`uid` +
  `xFraction`/`yFraction`, 0–1, default 0.5 centre) resolves the ref, takes `DOM.getContentQuads` on the
  ref's OWN session, and clicks a fraction of the element's bounding box clamped 1px inside — no
  screenshot, no `lastShot`, no drift check. `landedOn` is BEST-EFFORT here: `describePoint` takes the
  full session target (not a bare tabId) and is asked on the ref's own session with the same point that
  is clicked, so a frame-local coordinate is resolved in the space it was measured in — and its
  `getContentQuads` containment cross-check is what makes that safe by construction, degrading to null
  whenever the spaces disagree instead of naming the wrong element. Missing `landedOn` is therefore
  still EXPECTED in uid mode and must not warn (unlike pixel mode, whose absence IS the warning); the
  tool text tells the model to confirm the effect in the returned snapshot instead. The mode is chosen
  in `background.js` by `typeof message.uid === "string" && message.uid`, and `browserTools` rejects
  both-or-neither before the wire. `clampFraction` refuses `Number(null) === 0` explicitly — the relay
  sends `null` for an omitted field, which would otherwise click the left edge instead of the centre.
  A uid-mode click needs an ANCHOR element to be a fraction OF; every `<canvas>` mints one through
  `INTERACTIVE_ROLES` (named or not — snapshots.md rule 5), which is what keeps a drawn surface reachable
  on a VISION-OFF run, where pixel mode does not exist at all. And elements that are
  clickable but absent from the AX tree no longer need a fraction guess in the first place: a FULL
  snapshot lists them with ordinary uids in its trailing `clickable but not in the accessibility tree`
  section (snapshots.md), which `click`/`click_at`/`hover` resolve like any other uid.
- **PIXEL mode clicks by SCREENSHOT-PIXEL coordinates, not CSS coordinates.** A capture is bounded to
  `SCREENSHOT_MAX_WIDTH` 1400 PHYSICAL px — and, since #66, additionally pre-fitted to the size Claude's
  API resizes an image to (snapshots.md) — and the browser then applies the user's own browser zoom and
  the display's device scale factor on top, so the pixels the model sees differ from CSS px by more than
  that downscale. The extension remembers the LAST capture's whole mapping (`lastShot`:
  tabId/mode/scale/clip dims plus the MEASURED `imageWidth`/`imageHeight` and per-axis
  `pxPerCssX`/`pxPerCssY`) and inverts those MEASURED factors at click time — the theoretical
  `pxPerCss = scale × zoom × dsf` is only the fallback for a bitmap `jpegDimensions` could not parse,
  since #66's measured ≈×1.145 skew is consistent with a bitmap 7/8 of the size that formula predicted
  (snapshots.md).
  `clipWidth`/`clipHeight` stay CSS px because the drift check below compares them against fresh
  `cssVisualViewport` metrics (the geometry contract itself is in snapshots.md). Viewport captures
  only; element/fullPage clips are page-absolute and refused with a redirect to a plain viewport
  screenshot. Same lifetime rule as uids: coordinates are only valid for
  the screenshot that produced them — enforced at CLICK time, not mint time: the branch re-reads
  `Page.getLayoutMetrics` and refuses on URL/scroll/viewport-size drift (a stale image size would even
  pass the bounds check). Before dispatching, the point is hit-tested read-only through `hitNodeAt`
  (`DOM.getNodeForLocation` + `describeNode`, geometry cross-checked via `getContentQuads`): an
  answer counts only when its own quads CONTAIN the point, and a rejected first ask is RETRIED with
  the point translated by the scroll offset — `getNodeForLocation` answers in DOCUMENT space on a
  scrolled page while quads and `Input.*` are viewport space (probe-pinned in
  `tests/visual/scrolled-hit-facts.spec.ts`; the un-retried check made every scrolled-page landing
  report "could NOT be identified" even as the click itself hit). A point neither space can vouch for
  degrades to silence, never a lie. The
  landed-on element rides back (`landedOn`, quarantined as page content, capped in the relay). An
  UNIDENTIFIED landing is stated as a warning in the tool result ("could NOT be identified") — absence
  must never read as success, since the landed-on report is the one thing keeping a blind click honest.
- **A pixel-mode result STATES the coordinate space it used, because a wrong SPACE and a wrong AIM look
  identical.** Claude answers pixel questions in the space of the image the API resized for it, not in
  the bytes the bridge produced (snapshots.md), so #66's symptom was a click landing one menu row high
  behind a landed-on report that read like an ordinary miss. On success the pixel branch appends
  `pixelPointNote` — `Pixel (x, y) on the W×H px screenshot → viewport point (cssX, cssY) of cssW×cssH
  CSS px` — followed by the standing rule: if the element below is not the target, the coordinate space
  is off, so compare where that element sits on the screenshot with where you aimed, correct ONCE, or
  switch to uid mode. `drag` appends the two-ended `pixelDragNote`. Both ride the existing `note`
  channel (no new wire field), and the SAME rule is written into the `click_at`/`drag`/`screenshot` tool
  descriptions and the promptBuilder browser paragraph — a note read once is not guidance; the diagnosis
  has to be standing per-turn text WITH an in-result mapping to check it against. UID-mode branches are
  untouched: a fraction of an element's own box has no image space to be wrong about.
- **An extension older than 0.26.0 pre-fits nothing, so the SERVER states the caveat instead.**
  `browserTools.ts`'s screenshot handler decodes the returned image with the server's own TypeScript
  port of the vision math (`agent/visionImage.ts` — `jpegDimensions`, `visionFits`, `visionFitSize`) and,
  for a VIEWPORT capture whose bitmap does NOT fit the standard tier, appends a bridge-authored caveat
  OUTSIDE the untrusted wrapper: the real W×H, the size a standard-resolution model sees natively, and
  the factor to multiply a consistently-missing pixel click by — once, then re-check the landed-on
  element. A capture that already fits adds nothing (so a current extension never triggers it), `uid`
  and `fullPage` captures are skipped, and every step is guarded: an image that will not decode adds no
  caveat and never fails the tool call.
- **A uid is STABLE for the life of the worker, not for one snapshot.** `refMap` (uid → ref) plus the
  reverse `uidByNode` (`${tabId}:${sessionId||"root"}:${backendNodeId}` → uid) are never reset per
  snapshot: `mintUid` returns the uid an element already has, so re-snapshotting a page that re-orders
  itself (a rolling newsstand) no longer repoints "e42" at a stranger — a re-rendered element is simply
  a NEW element with a new uid, and a dead one fails loudly. Bound by `REF_MAP_MAX` (30k, both maps
  cleared at the start of a snapshot past it) and swept per tab on `close_tab` and `chrome.tabs.onRemoved`.
  `refSeq` deliberately keeps counting across an eviction — reusing numbers would reintroduce exactly
  the wrong-element bug. A uid that RESOLVES but whose node is gone gets a written recovery instruction,
  not raw CDP text: `nodeCall(ref, …)` maps `/no node|not found|could not find node/i` and wraps
  `centerOf`/`quadsOf`, `focusForInput`, captureShot's uid branch and selectOption's `describeNode`.
  `resolveRef`'s unknown-uid message is unchanged.
- **A uid still dies with its DOCUMENT — the one lifetime it does not outlive.** Chrome REUSES
  `backendNodeId`s across documents in a tab, so a uid minted before a navigation could resolve cleanly
  on the next page and point at an unrelated element: the same wrong-element bug `uidByNode` fixed for
  re-renders, arriving through navigation instead. The worker now invalidates a document's uids when
  that document is replaced, so a stale uid raises an explicit "belongs to a previous page … take a
  fresh snapshot" error instead of quietly operating on a stranger. Both agent-facing surfaces state it
  (`snapshot`'s description, the promptBuilder browser paragraph): no uid survives
  `navigate`/`navigate_back` or a click that loads a different document.
- **The WORKING TAB is pinned across turns, and losing it is ANNOUNCED, not silent.** The tab every op
  acts on is persisted in `chrome.storage.session` (survives service-worker suspension, dies with the
  browser session), so the tab a previous turn opened is still the tab this turn acts on. When it is
  gone the bridge falls back to another tab in the group and says WHICH through the `note` channel; a
  tab the page opened itself (`target=_blank`) is announced the same way. `list_tabs`' `*` marks that
  tab, and its description now says the marker means "the working tab, pinned until you switch it or it
  closes" — the agent used to read `*` as "wherever we happen to be". The ONE place the bridge
  re-points that pin on its own initiative is the clipboard-staging auto-close (actions.md): closing a
  `COPIED` staging tab restores the id remembered when `new_tab` opened it, or `null` when that tab is
  gone — never a guess at a plausible substitute — so the unknown case still falls into `targetTab`'s
  oldest-tab fallback and is ANNOUNCED through the same `note`, exactly as when a tab closes by itself.
- **The common action tail settles, and it never reports a done action as failed.** `SETTLE_OPS`
  (INPUT_OPS + navigate/navigate_back/new_tab/handle_dialog) wait `ACTION_SETTLE_MS` (350) before the
  tail re-reads the tab: a page's answer to input is async, so the old immediate snapshot showed the
  state BEFORE the autocomplete/menu/validation appeared and the agent read the action as a no-op
  (`wait_for` keeps its own loop and does not settle). If the tail snapshot then THROWS, the reply is
  still `ok:true` with `snapshot: ""` plus `snapshotError` — the action already happened, and failing
  the whole op made the agent retry and navigate twice. `snapshotError` is a full five-layer field
  (`browserTools.report` appends it OUTSIDE the untrusted wrapper, since it is bridge-authored, and
  names read_text/snapshot as the check instead of the action).
- **`getFullAXTree` covers only the MAIN frame, so frames are walked THREE ways.** `axSources(tab)`
  returns the root session, then one source per non-main frame id from `Page.getFrameTree` (read-only
  structure, ids only — one of the two frame additions to `CDP_ALLOWLIST`, `DOM.getFrameOwner` being
  the other, next bullet), then one per OOPIF child session.
  Without the middle kind a SAME-process iframe rendered as an empty `Iframe "name"` line with all its
  content missing. Root-session frame ids for OOPIFs fail there and are absorbed by the per-source
  try/continue, since that content arrives via the child session. Frame uids ride the session that
  fetched them (backendNodeIds are unique per target), so click/type are unchanged. `read_text`'s
  uid-scoped path stays session-scoped but falls through that session's frame trees when
  `renderAxText` returns null, before raising the stale-uid error.
- **A HOLLOW scoped read is re-read against what the DOM says the element contains.** Field case: on a
  map page, `snapshot(uid=region "Map")` / `read_text(uid=…)` answered the region line alone (3 chars)
  while the UNSCOPED walk printed 47 markers under that very uid — the markers are AX nodes DETACHED
  from the region's childIds (only the full walk's orphan sweep reaches them), and part of a pane can be
  a same-process child frame (a different AX source entirely). When a scoped render comes back hollow
  (≤ 3 atoms for snapshot, < 400 chars for read_text — `HOLLOW_SCOPE_*`), `scopeDomIdsOf` collects the
  element's DOM-subtree backendNodeIds once (`DOM.describeNode depth:-1 pierce`, capped
  `SCOPE_DOM_IDS_MAX` 4000 — deliberately NOT `SUBTREE_SCAN_MAX`, which the obscured-click guard is
  tuned to), the walk re-runs with `scopeDomIds` (in-scope detached nodes adopted as extra roots;
  `walkAxNodes` 4th param), and frames whose OWNER sits inside the set (`framesInsideScope`,
  `DOM.getFrameOwner` on the ref's own session only) are appended — snapshot with local `frame fN:`
  headers, read_text as continuing text. Uids stay identical across the re-render (mintUid answers from
  `uidByNode`); any CDP failure skips enrichment (an addition, never a new failure); nested OOPIFs are
  out of scope. Two more rungs cover the ways this still ended empty in the field: STILL-hollow after
  enrichment repolls once (`STALE_SNAPSHOT_REPOLL_MS` wait + `flushLifecycle`, then a FRESH
  `sourceAxNodes` fetch AND freshly re-asked `scopeDomIdsOf` — a live pane re-creates its DOM
  continuously, so both the tree and the id set in hand can predate the rebuild; the longer answer
  wins, the repoll never subtracts), and a start node NO tree contains is not declared gone until the
  DOM agrees — if `scopeDomIdsOf` still answers, the walk runs SWEEP-ONLY (`scopeDomIds` with no start
  id renders exactly the in-scope nodes — `walkAxNodes`' third mode) over the main tree plus in-scope
  frames, because an unnamed overlay or a mid-rebuild pane is alive in the DOM while absent from the
  AX tree, and the stale-uid error would discard a uid that still works. A SCOPED answer of zero
  atoms / empty text is never returned bare: `HOLLOW_SCOPE_SNAPSHOT_NOTE` / `HOLLOW_SCOPE_TEXT_NOTE`
  say the element renders nothing of its own and where to look instead (a SIBLING layer; `snapshot`
  without uid; `click_at` with fractions) — an empty answer reads as a broken tool, and the /entry_ad
  backdrop is the field case.
- **Frame content is LABELLED, not just stitched in — and the header itself is the way IN.** A child
  frame's block is preceded by a header and the owning `Iframe` element's line carries a matching
  ` (frame fN)` (`renderAxTree`'s `frameLabels`: owner backendNodeId → label, printed LAST on the line
  because it says where the element's CONTENTS went, not what the element is). Without the pairing a
  stitched snapshot read as one flat document and the agent could not tell which of three iframes it
  was acting inside. The owner is resolved with `DOM.getFrameOwner` — newly allowlisted, the other
  half of the read-only structure question `Page.getFrameTree` already answers (ids only, no content).
  `Iframe` elements mint uids, so `snapshot { uid }` can scope INTO one frame — but on naver map only
  ONE of seven frames had a visible `Iframe` line, so `frame f1:`…`f7:` named nothing recognizable and
  offered nothing reachable. The header (`frameHeader`) is now
  `frame f2 [e88]: "장소 검색" — https://…`, built from the frame's OWN RootWebArea: name = title,
  AX `url` = document, and the minted uid is the frame's ENTRY HANDLE — `DOM.describeNode` populates
  `frameId` on a document node as it does on an owner element, so `frameSourceFor` scopes a snapshot
  to it, and read_text's `startBackendNodeId` walk finds the node among the scoped sources with no new
  branch. Every part degrades independently back to the bare `frame fN:`.
- **`drag` (0.21.0) reuses click_at's two addressing modes end to end.** UID mode: start = `uid` +
  `xFraction`/`yFraction`, end = `toUid` + `toXFraction`/`toYFraction` (`toUid` omitted = same element,
  the canvas case — the server tool then demands at least one to-fraction so the "drag" is not a click).
  Pixel mode: `x`/`y` → `toX`/`toY` through the same `lastShot` inversion and drift check as click_at
  (`shotCssPoint`, extracted from the click_at branch so the two can never diverge). Geometry is the
  round-10 lesson applied twice: `quadsOf` SCROLLS, so the end element is brought on screen first, the
  start second (freshest), and the end is RE-read scroll-free (`rawQuadsOf`) in that final state; an end
  the final viewport cannot contain refuses with "cannot both be brought on screen at once". Both ends
  must resolve to ONE renderer session — a cross-frame drag is refused, not half-dispatched. The event
  shape (`dragPointer`) is press → interpolated `mouseMoved`s (≤16 steps, ≤60px apart, 12ms pauses) →
  release; `tests/visual/drag-facts.spec.ts` pins that this drags a JS handler exactly, that
  press+release alone is a click, and that Chromium SYNTHESIZES `event.buttons` on moves from its
  tracked press state (a dispatched `buttons: 0` mid-drag still reads as 1 on the page). NATIVE HTML5
  `draggable="true"` rides the browser's own drag controller, which mouse events cannot start
  (`Input.dispatchDragEvent` stays outside `CDP_ALLOWLIST`) — the tool description owns that limit.
