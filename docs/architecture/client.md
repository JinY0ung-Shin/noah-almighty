# Client (React + Vite)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Structure, CSP, theme, CSS and React rules and gotchas, hand-mirrored contracts, and client verification.

Companion to the client-area philosophy in [`../../src/client/CLAUDE.md`](../../src/client/CLAUDE.md).

## Structure
- **The frontend is React 19 + Vite under `src/client/`, NOT vanilla `public/`.** History: vanilla JS until
  2026-06 (commit `b8505fb` moved it to Svelte 5), Svelte until 2026-11-12 (branch `feat/react-migration`
  ported it 1:1 to React — same DOM, classes, text and behaviour; the last commit that has BOTH apps side by
  side, `18e98d7`, is the parity reference for the Svelte app). Static assets (favicons, manifest, PWA icons,
  `sw.js`, the draw.io viewer) live in `src/client/public/` (Vite's `publicDir`); the old repo-root `public/`
  is gone. Entry `src/client/index.html` → `src/client/src/main.tsx` → `App.tsx`; views in `src/views/*.tsx`
  (the chat view is `views/ChatView.tsx` + `views/chat/{controller,Transcript,Composer}.tsx`), shared
  components in `src/components/*.tsx`, non-UI logic/stores in `src/lib/*.ts`. `lib/state.ts` is the central
  store (`appState` + `updateState`/`readState`/`replaceState`/`notify`); other lib: `chat`, `loaders`, `api`,
  `nav`, `slash`, `format`, `dom`, `knowledge`, `onboarding`, `theme`, `sse`. The React plumbing is four
  files: `lib/store.ts` (the store primitive), `lib/hooks.ts` (reading stores, attaching actions, listeners),
  `lib/transition.ts` + `lib/presence.tsx` (enter/exit motion). Built by `vite build` → `dist/client`, which
  `app.ts` serves (no build → only the SPA fallback's 404 hint).
- **`src/lib/state.ts`:** `appState` is a `writable` from `lib/store.ts` (the client's own store primitive:
  `subscribe` hands the current value at once, an OBJECT always publishes even when it is the same
  reference, a `set` made inside a subscriber is queued behind the notification in progress); mutate via
  `updateState(fn)` (mutate-then-republish the SAME object; also recomputes `streaming`), read via
  `readState()`, patch via `replaceState(patch)`, toast via `notify(msg, kind?, {actionLabel?, action?})`.
  Components read it with `useAppState()` (`lib/hooks.ts`), which re-renders on every publication — no
  manual `renderView()`.
- **Server types are shared, not re-declared.** `src/lib/types.ts` re-exports from
  `../../../server/types.js` (and `tsconfig.client.json` includes `src/server/types.ts` +
  `routineSchedule.ts`). Import server types through that barrel.
- **The old vanilla frontend lives in git at `f0a6128`** (`git show f0a6128:public/js/<file>`) — the parity
  reference. Stylesheets were carried over VERBATIM from `public/styles/*.css` to `src/client/styles/*.css`
  (same filenames `00-tokens`→`70-modals-groups`, same class names), loaded via `@import` in
  `src/client/src/styles.css` (cascade = import order), NOT `<link>` tags. So porting/restoring a feature =
  reproducing the SAME DOM structure + class names the old vanilla JS emitted — don't invent new class
  names (e.g. tabs use `.settings-tabs`/`.settings-tab` for BOTH Settings AND Admin; a custom `.tabbar` has
  NO CSS and renders unstyled). Spacing `--s-*`/color/radii tokens live in `00-tokens.css`.
- Markdown rendered with `marked` + sanitized with `DOMPurify` (`renderMarkdown` in `lib/format.ts`,
  bundled by Vite — not the old `/vendor` ESM routes).

## CSP
- **`app.ts` serves a strict same-origin CSP** (`connect-src 'self'`, `img-src 'self' data:`,
  `script-src 'self'`). So remote `<img>` in rendered markdown is BLOCKED and the
  browser can't fetch cross-origin — widen the relevant directive in `app.ts` if a feature needs it. The
  production build emits no inline `<script>`, so a `script-src` with no `'unsafe-inline'` is safe (the dev
  server's Fast Refresh preamble would be one — `main.tsx` imports it as a module instead, see
  `vite.config.ts`); nothing
  compiles WebAssembly either, so `'wasm-unsafe-eval'` stays out too.

## Theme (light / dark / system) — `src/lib/theme.ts`
- **One device-local preference, resolved in JS, applied as an attribute.** `localStorage["noah-theme"]` is
  `system` (default) | `light` | `dark`; `applyTheme()` resolves it (system →
  `matchMedia('(prefers-color-scheme: dark)')`) and sets `<html data-theme="dark">` (light removes the
  attr). `watchSystemTheme()` re-applies on OS change only while the pref is `system`. The rail-footer
  button cycles 시스템→라이트→다크.
- **The dark token block is SINGLE-SOURCE: `:root[data-theme="dark"]` in `00-tokens.css`**, NOT a
  `@media (prefers-color-scheme: dark)` duplicate. There IS a deliberate ~3-line
  `@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }` fallback setting ONLY `--bg`; it
  stops matching once JS sets `[data-theme]`, and its sole job is to kill the first-paint light flash for
  OS-dark users — keep it minimal.
- **The inline-`<script>`-in-`<head>` anti-FOUC trick is impossible** (CSP blocks inline scripts). The
  CSS-only `--bg` fallback is the substitute; any first-paint theming must stay CSS-only.

## Motion preference (움직임 줄이기) — `src/lib/motion.ts`
- **Motion is the APP's setting, never the operating system's (2026-11-11).** Chrome reports a PC whose
  system animations are off (Windows 설정 > 접근성 > 시각 효과, "최적 성능" presets, some remote sessions) as
  `prefers-reduced-motion: reduce`; following it silently removed every animation AND the paced answer text
  on such machines. So nothing in `src/client/{src,styles}` reads that media query any more
  (`tests/motion-os-independence.test.ts` fails on a new one). One device-local preference, like the
  theme: `localStorage["noah-motion"]` is absent (= `full`, the default) | `reduce`; `applyMotionPref()`
  writes `<html data-motion="reduce">` (full removes the attr) and runs in `main.ts` BEFORE the first
  mount. The switch is 설정 > 프로필 > 움직임 줄이기 (no server round-trip). There is deliberately no
  "follow the system" choice — that is the dependency this removed.
- **CSS keys on the attribute, JS on `prefersReducedMotion()`.** Reduced rules are
  `:root[data-motion="reduce"] …`; motion-only rules are `:root:not([data-motion="reduce"]) …` (in a
  component's scoped style: `:global(:root[data-motion="reduce"]) .x`). The global quiet rule
  (`40-responsive-core.css`) sets every animation/transition duration to 0.001ms, so a new FINITE CSS
  animation needs no rule of its own to go quiet. An `infinite` one does NOT stop — it loops every
  0.001ms — so it needs its own `:root[data-motion="reduce"] .x { animation: none }` (the shimmer, the
  caret, the presenter); spinners are deliberately re-enabled next to the global rule. `prefersReducedMotion()` is
  read when a motion STARTS (`springValue`, the stream reveal, the theme cross-fade, every
  transition gate).
- **`scrollToStart(el)` replaces `scrollIntoView({ behavior: "smooth" })`.** The browser's own smooth
  scroll is switched off by the same OS setting and cannot be overridden, so the two "reveal the pane
  below the list" scrolls (할 일, 예약 작업; stacked ≤ 980px) spring `scrollTop` of the nearest scrollable
  ancestor instead — same scroller and end position as the native call (checked in Chromium) — and let go
  on the viewer's wheel/touch/pointer/key. Still OS-bound and left alone: the browser's wheel/keyboard
  scroll animation, and `prefers-reduced-transparency` (materials turn opaque).
- **Entrances added with it (all in `80-apple-design.css`, entrance only, transform/opacity only):** the
  MCP 도구 panel, composer attachment thumbnails/chips, the 맨 아래로 button, the file-drop overlay, and the
  side panel's head/body (opacity only — a transform would shift the rects the canvas/graph renderers
  measure while they mount; the width is never animated). The slash menu stays instant (keyboard-opened).
  A conversation the viewer deletes one at a time leaves by fading while its height closes
  (`Shell.tsx` `conversationOut`, gated on a plain Set); when that empties its date group the row's
  exit never runs (its `<Presence>` sits inside the group, which is leaving as a whole), so the GROUP leaves
  the same way (`groupOut`),
  taking the list gap and — for a first group — the next group's `.conv-group + .conv-group` margin with
  it. Deleting the LAST conversation swaps to the empty state at once (the list's `<Presence>` goes with the
  branch). No FLIP there — the rail list reconciles on every store write and would measure every row.
  Known limit: these CSS entrances replay when their element REMOUNTS for another reason (returning to
  the chat view with attachments staged or the side panel open, single ↔ split) — the same as the
  existing `.message` entrance.

## CSS gotchas (`src/client/styles/*.css`)
- **Input chrome comes ONLY from `.field input`, not a global rule.** The global
  `button,input,select,textarea` rule (`10-base.css`) sets just `font`/`color: inherit`. All input styling
  is the canonical `.field input, .field select, …` rule (`20-shell-chat.css`) and applies ONLY inside a
  `.field` ancestor. A bare `<input>` in a custom row renders unthemed — new form controls MUST sit inside
  `.field` or fold into that canonical selector.
- **Code-block colors are deliberately FIXED across light AND dark** via `--code-*` tokens
  (`00-tokens.css`). Do NOT remap them to semantic `--ok`/`--danger` (those invert in dark and are
  unreadable on the always-dark code surface).
- **Undefined CSS custom props fail silently.** `var(--undefined)` with no fallback renders invalid with no
  console error. Scan after CSS edits.
- **Tabs (Settings AND Admin) use `.settings-tabs`/`.settings-tab`** (icon + `<span>` label). A custom
  `.tabbar` class has NO CSS and renders unstyled.
- Global stylesheet + rendered (`dangerouslySetInnerHTML`) markdown share class names — avoid bare generic class names (e.g.
  `main`) on dynamically-rendered nodes; the activity-tree root uses `is-main`, not `main`
  (`.main { height: 100dvh }` once stretched the box). A component's own `X.css` is scoped by hand (below), but the
  carried-over global CSS and rendered-HTML output are not.
- **A `<style>` in rendered HTML (`dangerouslySetInnerHTML`) — HTML or inline-SVG — is a stylesheet for the WHOLE app**, so
  `renderMarkdown` forbids it (`FORBID_TAGS`; inline `style=""` stays). DOMPurify's default only LOOKED like
  it stripped one: it drops a `<style>` that LEADS the input (the parser hoists it into `<head>`, and only
  `<body>` is returned) but keeps one after content. Canvas `html` pages get their own document and drawings
  (`svg`/`mermaid`) their own shadow root instead ([chat-sse-media.md](chat-sse-media.md) § Visual canvas).

## React client rules and gotchas
The rules every component was ported under (2026-11-12). `tsc` catches none of them; most show only in a
real browser.

- **A green typecheck does NOT mean the behavior is correct — for interaction/layout/timing changes,
  runtime-verify (Playwright fixture, see Verification).** The composer `autosize` fix once compiled and
  type-checked yet was a pure no-op at runtime; only a real-DOM measurement caught it.
- **The state is MUTATED IN PLACE.** `updateState(fn)` changes the one state object and publishes the same
  reference; arrays and panes inside it keep their identity. `useAppState()`/`useStore()` re-render through
  a VERSION counter (`useStoreVersion`), not through the value. So: derive from the store in the render
  body; never give a store object to a `useMemo`/`useEffect`/`useCallback` dependency array expecting it to
  change (use primitives read from it, or the version); never `memo()` a component that takes store objects.
  The one place identity IS the contract: `state.conversations` is always REPLACED, never mutated (below).
- **A function sees the render that created it** (stale closures). Anything that runs LATER — after an
  `await`, in a timer, in a listener or observer registered once, in a promise callback — reads through a
  ref (`useLatest`, or a ref kept current) and writes with a functional update. A value that is both
  rendered and read later needs both: state for the render, a ref set by the same setter for the late read.
  Ten components carry a local `useLive`/`useLiveState` for exactly this (REFACTORING-BACKLOG: lift one).
- **There is no `$:`.** A derived value is a `const` in the render body. Something that REACTS is a
  `useEffect`/`useLayoutEffect` with PRIMITIVE deps, or no deps plus an explicit "did it change" guard in a
  ref. "Reset local state when a prop/id changes" is the render-time pattern (`usePropState` in
  `lib/hooks.ts`). Nothing writes a store, calls `notify`, or sets another component's state during render.
- **Mount work that must be on screen in the FIRST paint is a `useLayoutEffect`** (a `load()` that flips
  the view to "불러오는 중…", a panel's first fetch): in a `useEffect` the empty state shows for a frame.
  Work that READS layout stays out of the mount commit (font tofu, below).
- **Actions are attached with `useAction(action, param)`** (`lib/hooks.ts`): the action runs when the
  element mounts, `update(param)` after a render that changed `param` — an object parameter counts as
  changed on every render — and `destroy()` when it unmounts. `update` runs AFTER the DOM has the new
  value (the composer `autosize` in `lib/dom.ts` still defers its param-driven grow with
  `queueMicrotask`, a leftover from when the caller updated the DOM later; it is harmless). A hook, so one
  per element: an element inside `.map()` gets its own small component. With your own ref too:
  `useMergedRef(myRef, useAction(…))` — a ref callback whose identity changes is detached and attached
  again, which would restart the action.
- **An exit transition needs `<Presence>` in the PARENT** (`lib/presence.tsx`), around the conditional or
  the keyed list; the element's own component calls `useTransition(ref, {in, out})` or `{both}` (one
  reversible transition), or the element is a `<Transition tag=… />`. A removed child stays MOUNTED — with
  the props it last had, `inert`, its effects and listeners live — until every transition inside it has
  played; then it is removed in the same turn. An intro plays only for a child that arrives AFTER its
  `<Presence>` mounted. `in` and `out` given separately are independent (a child coming back mid-exit drops
  the exit and arrives afresh); `both` turns around from where it is. No `<Presence>` above: the intro
  plays and there is no exit. Every `<Modal>` (and every component that renders one) is rendered by its
  parent inside `<Presence>` with a `key`. The numbers and the keyframe sampling (`lib/transition.ts`:
  `fade`/`fly`/`slide`, one keyframe per 60 Hz frame along the easing curve) are the ones the Svelte app
  used.
- **Component styles: `X.css` next to `X.tsx`, scoped by hand.** The scope class `cmp-<kebab-name>` goes on
  every top-level element the component renders (portaled ones too; a component whose root is a `<Modal>`
  passes it as `cardClass`), and every selector carries `:is(.cmp-x, .cmp-x *)` on its first compound —
  which keeps the +1 class of specificity the old scoped styles had. A private `@keyframes` is named
  `cmp-x-<name>`. A scoped rule reaches INTO child components and into rendered HTML, which scoped styles
  never did: where a component renders sanitized HTML (DOMPurify keeps `class`), the suffix also carries
  `:where(:not(.the-html-container *))` — `views/BrainView.css` (notes), `components/AvatarCapabilitiesModal.css`
  (`.ai-intro`), `views/ChatView.css` (`.md`) — so author-written HTML cannot dress up as app UI.
- **Whitespace is written out.** JSX drops the space between inline siblings on separate lines and joins
  multi-line text with single spaces. Where text and inline elements sit in normal inline flow the space is
  an explicit `{" "}`; where the element is `white-space: pre-line`/`pre-wrap` (`.empty-note`, `.conv-empty`,
  user bubbles) a line break in the copy is an explicit `{"\n"}`. Inside flex/grid containers neither
  matters. (`text {expr}` also becomes two text nodes — a 0.02 px shaping difference, not a bug.)
- **`aria-*`/`data-*` booleans are passed through** (`aria-busy={busy}` prints `"false"`); `undefined`
  removes the attribute. Real boolean attributes (`disabled`, `hidden`, `inert`, `open`) are present/absent.
- **Controlled inputs.** `onChange` IS the native `input` event; a text field that must react to the
  native `change` (commit/blur) uses a native listener through a ref (the 할 일 editor's date input). A
  checkbox/select the ORIGINAL bound one-way — the DOM kept what the user clicked while a save was in
  flight — is reproduced, not "fixed": `OneWayCheckbox`/`OneWaySelect` in `SettingsAccessTab.tsx`,
  `signupPick` in `AdminView.tsx`. A controlled `<textarea>` also gets its first value as a text child, and
  a controlled checkbox a `checked=""` attribute — React artifacts, not differences.
- **A portal's events bubble through the REACT tree.** A handler on a container above a portaled child
  (the fullscreen canvas stage, a portaled dialog) receives that child's click/key/drag events, which only
  reached `<body>` before. Container handlers guard with `currentTarget.contains(target)` — the six guards
  in `views/chat/controller.tsx` (pane drag/drop, workbench drop, split-pane focus). The other way round,
  React handlers run AFTER native listeners on ancestors below the root, and `stopPropagation()` does not
  stop those: a handler that relied on that order is attached natively.
- **React restores focus after a commit.** If the element focused before a commit is still in the document
  afterwards, React focuses it again — undoing a focus move made in a layout-effect CLEANUP. Hand focus
  over in an effect BODY or an event handler (`PromptModal.tsx`; `Modal.tsx` is safe because its focused
  node leaves with it). After `flushSync(() => setState(…))` the DOM is current and focus can move at once
  (`ShareLinkDialog`, `SlidePresenter`).
- **A render error unmounts the whole tree.** `components/ErrorBoundary.tsx`: `ViewBoundary` around the
  active view (a notice with 다시 시도; the rail and dialogs stay usable; it forgets the error when another
  view is shown) and `AppBoundary` around the app (a reload card). Errors in effects and event handlers are
  not caught by either. `{list.map(…)}` over a missing array throws where the old `{#each}` drew nothing —
  the server always sends the array; a tolerant read (`keys?.length`) exists only where a test stub did not.
- **No `<StrictMode>`** (`main.tsx`): its development-only second run of every effect would boot the app
  twice and re-run effects that consume one-shot state. `AnswerUi` also runs its `update()` side effects
  (persist, the ui-report queue) while rendering, from a mount-time closure — harmless duplicates today,
  to be moved before StrictMode or concurrent rendering is ever switched on.

### Where the port deliberately differs from the Svelte original
Found by rendering both with the same fixtures. Three defects of the original are NOT reproduced:
`SettingsPluginSelect`'s 선택 저장 never became enabled (its dirty flag had no dependencies);
a canvas option button's `aria-pressed` stayed `"false"` after a click; `PromptModal` did not move focus
to 건너뛰기 when the NEXT queued question arrived. A fourth was fixed right after the port (2026-11-12,
reproduced in a real browser first): in the SINGLE pane one `.transcript` element serves whichever pane is
shown, and its stick controller stayed bound to the pane it was created for — after a new chat or another
conversation, wheel-up no longer detached, 맨 아래로 never appeared and a streamed answer pulled the reader
back down. The `transcriptStick` action now has an `update(paneId)` that hands the element to the new
pane's controller (`tests/react-chat-stick.test.tsx`).

## Rendering and motion facts (don't regress)
- **One `updateState` re-renders EVERYTHING under `useAppState()` — and streaming calls it once per SSE
  token.** The state object is mutated in place, so nothing below it can be compared and no row can be
  skipped (no `memo()`): a 200-message pane renders 200 rows *per token*. In the transcript the costly
  expression is `renderMarkdown(...)` — 57 ms of `marked` + `DOMPurify` per token when it was measured
  uncached, all thrown away because the html was identical. Two mitigations are in place, keep them:
  `renderMarkdownCached` (`lib/format.ts`) memoizes PERSISTED message bodies on their source text — live
  streaming text must never go through that map (it would churn it); it has its own path, below; and `enhanceMarkdown`
  (`lib/dom.ts`) skips its two `querySelectorAll` sweeps when the param is identity-equal, which is why
  every call site MUST pass the same source string its sibling `dangerouslySetInnerHTML` renders. Assume
  anything in a transcript row runs at token rate and keep it cheap or cached. (Measured in jsdom at the
  port, 200 rows × 54 tokens: no DOM mutation in stored rows, 33–37 ms per token.)
- **The LIVE answer renders by BLOCK, paced, and never re-parses what is settled (2026-11-11).**
  `lib/streamMarkdown.ts` (`createStreamMarkdown`) splits the live text at marked's top-level tokens; a block
  is settled only when a BLANK line precedes the cut and the first line after it is complete (marked's block
  lexer decides line by line, so nothing before that can still change — a list absorbing the next line, a
  setext heading, an open fence). Settled blocks are parsed + sanitized once; only the open tail re-renders.
  **The bar is equality with `renderMarkdown(wholeText)` at every prefix** (`tests/client-stream-markdown.test.ts`
  checks every prefix and a seeded fuzz), so it falls back to a whole render where a split would differ:
  reference-style link definitions (one definition rewrites earlier blocks) and, from the first raw-HTML token
  to the end, one block (tags can span blocks). `dom.ts`'s `markdownBlocks` action swaps only the nodes of a
  block whose html changed — no wrapper element per block, so the DOM is the whole-render tree and `.md`
  CSS applies unchanged. `lib/streamHeal.ts` closes the open tail FOR DISPLAY ONLY (`**`, backticks, a
  half-typed link, a table still arriving, a marker line with no meaning yet); stored text, copied text and
  attachment anchors (`bubbleSegments.ts`, raw length) never see it. A block still being written carries
  `open` (not its html): a ` ```mermaid ` block is drawn as its diagram only once that is gone
  (`lib/mermaidBlock.ts` — [chat-sse-media.md](chat-sse-media.md) § Inline UI).
  `lib/streamReveal.ts` paces what is shown (EMA arrival rate, ~0.25 s behind, ≤ 3× catch-up, word
  boundaries, injectable clock): `pane.liveText` is ALWAYS the full text and the reveal store only says how
  many characters show, so 중지 / an error / a text fold / a delivered steer / the finalizer cannot lose or
  duplicate text — they read the pane. It is off under the app's 움직임 줄이기 (never the OS setting; read when a reveal STARTS),
  flushes on `visibilitychange` and when frames stall, flushes everything when a card (`file` frame) arrives so
  a card never precedes its text, and drains the rest inside ~0.3 s on the stored bubble at turn end.
  The thinking card shows elapsed seconds and the current sub-heading in its collapsed header and renders
  its body only when OPEN; a stored message carries `AgentResponse.thinkingMs` (the server's estimate: the
  sum of gaps between consecutive thinking chunks, gaps over 5 s dropped, `done` turns only).
- **A code block has a header bar** (`wrapCodeBlock` in `dom.ts`): language label · 줄바꿈 toggle · 복사,
  always visible (it replaced the hover-only copy overlay everywhere `enhanceMarkdown` runs). A fence still
  streaming gets text appended, never rebuilt, so the toggle, focus and scroll survive. `copyText` returns
  `Promise<boolean>`, falls back to a selection copy when `clipboard.writeText` THROWS (not only when it is
  missing), and puts its temporary textarea inside the open dialog (a focus trap blocks one on `<body>`).
- **The conversation list is grouped by day and prefetches on intent.** `lib/conversationGroups.ts`
  (`groupConversationsByDate(conversations, now)`, pure, local-midnight boundaries) → 오늘 / 어제 / 지난 7일 /
  지난 30일 / 그 이전; `Shell` re-groups at local midnight and on tab return. `lib/conversationPrefetch.ts`
  starts the messages + avatar load on hover (120 ms dwell), `pointerdown` or keyboard focus and hands the
  click the SAME request (`takeConversationLoad` inside `loadPaneForConversation` — one applier, no second
  path); never for the open conversation or one with an active run. ONE store subscription drops the cache:
  the user changing → all; `state.conversations` being REPLACED (list reload after every turn, delete, 비우기,
  rename) → all; a conversation open in a pane → that one; TTL 15 s. **So a list row must be changed by
  replacing the array, never mutated in place** (the memo and the invalidation both key on its identity).
  Trade-off: a conversation changed elsewhere can open up to 15 s stale.
- **`<details>` hides its children, it does not skip rendering them.** A body left in the template costs a
  full markdown parse / component mount for every message on load, on a card most users never open. The
  transcript's "생각 과정" and "작업 내역" cards therefore render on first open, driven by an
  `expandedCards` set fed from `onToggle` (`views/chat/Transcript.tsx`). Note `toggle` fires as a TASK after
  `open` flips (spec behavior, jsdom matches) — a test must await a macrotask, not just a flushed render. Trade-off accepted:
  Chrome's find-in-page can no longer reach inside an unopened card.

- **An inline `<chart>` holds its place** (`components/widget/WidgetChart.tsx`, 2026-11-12). The frame has
  the plot's height (the `height` prop, default 240 px) from its first frame — before the chart chunk is
  loaded, and while a chart that will enter waits to come on screen — so the text that FOLLOWS a chart is
  never painted in its place and pushed down. (Under Vega the chart had no height until its asynchronous
  render landed, and blinked out and back when the stored message replaced the live bubble.) The drawing is
  `ChartDrawing.tsx` (Recharts), its own lazy chunk: keep Recharts out of every other module. Mechanics and
  the entrance rule: `chat-sse-media.md` § Inline UI. jsdom lays nothing out and the library sizes itself
  from its container's measured box, so `tests/react-widget-chart.test.tsx` gives that container a size.
- **Conditional motion on a keyed list is gated INSIDE the transition/animation function, on NON-reactive
  state read when it starts** (the 할 일 card animates only the avatar's changes; `components/TodoOverlay.tsx`).
  A removed row is frozen by `<Presence>` with its LAST props, so the gate reads plain module state
  (`takeAvatarDeparture`, `avatarChangeFlushing`), never a prop. The row glide is a hand-written FLIP
  (`CardMotion`): "before" rects are taken by `ListSnapshot.getSnapshotBeforeUpdate` — the commit's DOM
  change has not happened yet — and only in a commit where the list identity changed; "after", the hold
  (absolute + translate) and the glide start in the card's layout effect. Give the list a positioned
  ancestor, and hold a TOP-anchored, content-sized container's height while rows glide or it overflows
  mid-motion (a classic scrollbar flashes). Never hold a BOTTOM-anchored one (it shrinks from the top, so a
  hold makes the rows glide up and then snap back down when it releases), nor under reduced motion (no
  glide to cover — the release becomes a second, delayed jump). Rows that must glide from where they WERE
  need a position snapshot taken before the change (`onBeforeAvatarChange`). An equal list delivered as a
  NEW array still counts as a change and re-measures every row — keep the array's identity when nothing
  changed. The glide is TRANSLATE-ONLY: items can change size and a scale would squash their text. Arrival
  keyframes need `backwards` fill: a finished `forwards`/`both` animation stays in `getAnimations()` and
  the FLIP skips an element that has animations. jsdom rects are all zero, so only Playwright sees any of
  this (`tests/visual/todo-overlay.spec.ts`).

- **Never force a layout inside a component's mount commit** (`getBoundingClientRect()`, `offsetHeight`,
  … in a mount effect during the app's initial mount). That layout runs while the `@font-face` Korean
  subsets are still UNLOADED, and in headless Chromium the text it shaped can stay on the system
  fallback for good even after every face reports `loaded` — `document.fonts.check()`/`ready` say
  fine, the pixels are tofu. The (since removed) DM dock's inset measurement did exactly this and turned
  the rail's 탐색/비우기/진영 into boxes in three visual baselines (bisected 2026-09-11 with CDP
  `CSS.getPlatformFontsForNode`; fix = defer the measurement behind a double `requestAnimationFrame`). The visual specs' `waitForKoreanFont` now ends with
  `assertNoFallbackHangul`, which asks the renderer which platform font each Hangul node used and fails
  the test instead of baking tofu into a baseline. Measure after first paint, or from a
  `ResizeObserver` callback.

## Chat transcript auto-scroll (stick-to-bottom)
- **User intent is read from INPUT events (wheel/touch/pointer), never inferred from scroll deltas.**
  Scroll-event heuristics lost twice over: mid-stream re-pins reset the viewport between wheel notches
  (so per-event deltas/distances never accumulate — slow trackpad drags are 1–4px/event and a single
  notch always lands back inside any near-bottom zone), and the wheel's scroll event can coalesce with
  our own pin into one net-downward move. That's what made auto-scroll "work sometimes" for years.
  Mechanism (all in `lib/autoscroll.ts` `createStickController`, one per pane; decision function
  `lib/scroll.ts` `nextStickBottom` is pure + unit-tested):
  - wheel-up → detach SYNCHRONOUSLY (before the scroll even applies); touch drag-down > 8px → detach;
    held pointer (scrollbar drag) or recent wheel/touch marks scroll events `userGesture`, which
    detaches on ANY ≥1px upward move that doesn't land at the bottom.
  - Browser range-clamps (content shrink / composer autosize growing the viewport) also decrease
    scrollTop but always LAND at the new bottom — that landing spot is the discriminator, both for
    detach (skip clamps) and re-engage (require top to INCREASE into the bottom zone; you can't reach
    the bottom by scrolling up, so a clamp can never re-stick a reader).
  - **Chromium ANIMATES wheel/keyboard scrolls**: after a re-engage/FAB-jump our pin overtakes the
    still-flying animation, whose next frame then looks like an upward move. A 250ms grace window
    (re-armed by down-wheels) suppresses heuristic detaches; direct input (wheel-up/touch/scrollbar)
    bypasses it. Without this, wheeling down to the bottom re-engaged and instantly un-engaged.
  - Nested vertical scrollers inside the transcript (`.activity-live > .agent-activity`) consume
    wheel-up themselves while they can still scroll up — the controller walks target→transcript and
    skips detach so the inner pane scrolls without killing the outer stick.
  - `overflow-anchor: none` sits on BOTH `.transcript` and `.transcript-inner` (scroll anchoring would
    silently reposition scrollTop after our pin, invisible to JS).
  - The view keeps only thin wiring: each pane's transcript element gets
    `useAction(ctx.transcriptStick, item.id)` (`views/chat/Transcript.tsx`), a layout effect with no
    dependency array re-pins every pane after each render (`views/chat/controller.tsx`), and the FAB calls
    `jumpToBottom()`; `stickBottom` stays in the pane store (send re-arms it in `lib/chat.ts`). In the
    single-pane layout the element outlives the pane, so the action's `update(paneId)` re-binds it to the
    new pane's controller when the pane is replaced.

## Split chat
- Avatar pool = all visible avatars, duplicates allowed (multiple parallel conversations with the same
  avatar incl. your own); the only gate is the 4-pane max. User message bubbles render text directly in
  `.bubble` (which has `white-space: pre-wrap`), NOT wrapped in `<p>` (that adds stray top/bottom margins).
  `GET /api/avatars` (`listPublishedAvatars`) includes the viewer's OWN avatar plus every teammate's 팀 공개
  (`group`) avatar — every visible non-own avatar is a teammate's, so Explore carries no membership badge.

## 할 일 tab and chat card
Mechanics → [`todos.md`](todos.md). Load-bearing for any change here: ONE store slice feeds the rail
badge, the tab and the card; concurrent loads share one in-flight GET and only WRITES make a load stale
(self-invalidating loads livelocked a direct `#/todos` open); the card mounts inside the active pane's
`.chat-body` and picks pinned/popover/sheet from a `ResizeObserver`, never a layout read in a mount effect;
transient dismissals never persist the per-browser preference; the card has NO add path (the tab and
the avatar add); and only the avatar's own changes animate — a tool-end claim diffed on the next
applied load, never the poll or the viewer's own edits.

## Share hash view (`#/share/<token>`) and the deck-card link controls
Mechanics of the links themselves → [`share-links.md`](share-links.md).
- **The first view only a link opens** (`views/ShareView.tsx`; not in the rail). `state.shareToken` holds
  the token and `currentRoute()` writes it back — load-bearing, because every run-stream `open` frame
  re-runs `syncHash(true)` and the URL would otherwise collapse to `#/share`. The
  view refetches in a layout effect keyed on the token STRING (plus a `token !== loadedFor` guard), so a
  second link opened while it is mounted loads — and never draws the previous deck under the new token. The tab title comes from `state.shareTitle`, since
  `setDocumentTitle` rewrites the title on every store emission.
- **The state comes from the HTTP STATUS, via `openShareLink` (`lib/shareLinks.ts`)**: only a 404 is a dead
  link; a timeout, 5xx or 429 is 다시 시도 (never tell a recipient a live link expired). `lib/api.ts` errors
  carry `ApiError.status` for exactly this. A token failing `SHARE_TOKEN_RE` never reaches fetch.
- **Payload strings are the deck author's** — rendered as text only (no `dangerouslySetInnerHTML`/markdown), and only
  normalized same-origin `/api/share/…` paths become an `<img>` or the download (`isShareAssetUrl`).
- **Viewer tickets live `SHARE_TICKET_TTL_MINUTES` (30)**: a viewer open ≥ 25 minutes re-opens the link
  with `refresh: true` before presenting, downloading or retrying a render (a refresh is not a counted view).
- **`SlidePresenter`** requests element fullscreen; the same markup is its fixed-overlay fallback. Leaving
  fullscreen by ANY route (`fullscreenchange` with `fullscreenElement` null) ends present mode, because Esc
  in fullscreen never reaches the page. Initial focus is the stage (tabindex -1), never 닫기, so the first
  Space/Enter turns the page.
- **First visit**: AuthView shows `공유받은 PPT를 보려면 Noah에 로그인하세요.` whenever the hash is
  `#/share/…` — tracked on `hashchange`, since a link pasted into a tab already on the login screen is a
  same-document navigation (no reload, no remount), and `state.view` cannot drive it (boot leaves it at
  `explore` until `enterApp`);
  `enterApp` holds onboarding and what's-new while the app STARTS on the share view (nothing is marked seen,
  so they surface on the first view change); `handleSessionExpired` keeps a `#/share/` hash — and only that
  one — so the deck reopens right after the next login.
- **`ShareLinkDialog` never calls `confirmAction` or `notify`.** ChatView owns the ONE instance — the chat
  card's link button and the deck tab's 공유 링크 (`FileTab`'s `onShare` callback) both open it there,
  because a tab unmounts when it is closed (and the side panel with its last tab) and would take an open
  dialog with it, mid-create included. It is a portaled Modal (mounted inside the
  chat view, a fixed overlay would sit in that view's stacking contexts), and a portaled modal inerts
  everything else under `<body>` — App's ConfirmationDialog and Toasts included, so either call would
  mount inert and hidden underneath. Revoke confirms inline; errors render in the card. jsdom ignores
  `inert`, so `tests/react-share-link-dialog.test.tsx` pins this by spy AND by import (a regex over the
  source: keep comments that mention those names AFTER the import block). The settings list
  (`SettingsShareLinks`) is not a modal and uses `confirmAction` with explicit options.
- **The dialog clears `busy` IN THE SAME COMMIT that mounts the next footer** (공유 해제 after a create,
  공유 링크 만들기 after a revoke; one `flushSync` sets the phase and `busy` together, and the two footers
  are keyed so React inserts new buttons instead of re-labelling the old ones): a button inserted disabled starts at `--disabled-opacity` and fades in
  over the global 160 ms button transition (공유 해제 read as unavailable right after a create), and
  `focus()` on a still-disabled button is a no-op. `copyText`'s button flash (`lib/dom.ts`) saves the
  button's content, `aria-label` and `title` once per 1.2 s window and restores them EXACTLY (an attribute
  the button lacked is removed again), so a second click cannot make the check icon permanent and a
  text-named button never keeps "복사됨" as its name; the dialog's 복사 is named `공유 링크 복사`.
- **Link controls appear on PPTX cards only**, and the chat card's `link` button only on PERSISTED cards (a live card has no stored message
  the server could find; `FileTab` disables its button with a title instead).
- **`panelSlides` IS the shared `cardSlideAttachments`**: the card's stamped renders when there are any,
  otherwise the legacy unstamped ones — never both (the deck-review loop publishes unstamped hidden canvas
  renders in the same turn as the deck, and mixing them showed every slide twice).
- **A canvas WITH controls always takes the side panel** (`handleCanvas` → `revealSideTab` with `force`),
  so a review form is never hidden behind the deck tab the owner is reading; the deck's tab stays open
  beside it.

## Side panel: canvases + opened files as ONE tab strip
- **One frame, not two panels taking turns.** `SidePanel.tsx` owns the width (ONE key,
  `canvasPanelWidth`; the old `filePanelWidth` only seeds it), the collapse state and the tab strip;
  `lib/sidePanel.ts` `sideTabs` is the single order (the pane's canvases, then `pane.fileTabs` in open
  order) for the strip, its arrow keys and `neighborTab` (the fallback when the shown tab goes away).
  Before the merge a `.drawio` preview and a canvas swapped the slot as two differently built panels with
  their own widths, and the swap UNMOUNTED the other one — a half-typed canvas answer was lost.
- **Every tab stays mounted** (the CLIENT CLAUDE.md always-mount rule). `CanvasTab` drops only its card
  DOM while hidden — typed control/edit values live in its component state — so a hidden tab never adds a
  second iframe/svg to the panel. It renders only while it (or its fullscreen view) shows and only when
  type/content/theme changed (`renderIfChanged`, a ref-guarded layout effect): the `canvas` prop cannot be
  compared — the state is mutated in place and the tab re-renders on EVERY store write — so an unguarded
  render ran DOMPurify — or all of mermaid — per keystroke for
  every tab. A refinement in place re-seeds an UNTOUCHED edit draft (an edited one stays) and adds defaults
  for new control ids while re-used ids keep what was typed (a SENT draft counts as untouched, so the
  avatar's reply version replaces it). **The fullscreen stage is portaled to `<body>`** (`createPortal`; its React events therefore bubble into
  the chat view's handlers, which guard against them): `.canvas-panel`'s
  backdrop-filter is the containing block of every fixed-position descendant, so inside the panel
  "fullscreen" covered only the panel (and a hidden tabpanel hid it outright). It stays open when the
  avatar shows another tab; when the restore to its ⤢ misses, closing it focuses the card's new ⤢ (tab
  shown again) or else the shown tab — never `<body>`. `FileTab` keeps
  its DOM (the draw.io viewer has no `destroy()`): it paints only into a body that has a width (hidden tab
  or collapsed panel = 0) and its ResizeObserver repaints (debounced) when the width changes —
  `.canvas-body` reserves its scrollbar gutter, so a tall diagram's scrollbar cannot flip that width.
- **Inline UI is not a canvas: `components/widget/AnswerUi.tsx` draws an answer that holds UI tags, in
  the bubble.** ChatView decides with `containsInlineUi` (`src/shared/widget/detect.ts`, imports nothing)
  and lazy-loads the component, parser and interpreter on the first such answer (a dynamic `import()` then
  `setState`, like mermaid — not `React.lazy`; `AnswerUi` does not subscribe to the store, its parent
  re-renders it); the
  live bubble and the stored message are two instances, and what the viewer set mid-stream is handed from
  one to the other (`lib/widgetState.ts`). Its state is per message, next to nothing else: the side panel,
  `CanvasTab` and the canvas tables are not involved. A sortable `<table>` keeps its sort in `WidgetTable`'s
  own state (view state — not UI state, not persisted, not sent) and `<svg>` is drawn by `WidgetSvg` through
  `lib/widgetSvg.ts` into a shadow root that is updated in place. The view model is rebuilt by
  `lib/widgetView.ts` and the components only draw it. The UI blocks sit OUTSIDE the answer's `.md`
  containers (`.answer-ui`), so prose rules (`.md p`) do not style them; `.wg-*` lives in
  `styles/25-canvas-widget.css`. Mechanics and the trust boundary: `chat-sse-media.md` § Inline UI.
  `AnswerUi` also draws the samples of 인라인 UI 갤러리 (`views/UiGalleryView.tsx`, `#/uiGallery`, not in
  the rail) through its `outbox` prop — a preview that sends, keeps and reports nothing — and what
  APPEARS in an answer enters: `lib/uiEntrance.ts` decides when (once per answer while it is written, every
  time the viewer brings something up, never from the history) and plays blocks, stat values, progress bars
  and table rows; a `<chart>` enters with its library's own motion (`ChartDrawing.tsx`) and `lib/mermaidEntrance.ts` plans the
  parts of a ```mermaid diagram. Web Animations held
  until the thing is on screen; the data-sized ones (a chart, a count) run longer than the 120–240 ms UI
  transitions of DESIGN §2.5.
- **Selection** = `pane.sideTab`; `null` means the default (`resolveSideTab`: the latest canvas still
  `pending`, else the latest canvas, else the latest file; answering or skipping a default-shown ask pins
  it first, so the panel does not jump once `pending` clears). **What the avatar shows takes the panel while the pane FOLLOWS** (`sideFollow` undefined/true);
  a pick by the viewer (`selectSideTab`, a file-card `openFileTab`) stops following, and every send
  re-arms it (next to `stickBottom`). Not following → the viewer's tab stays and the new one gets a dot
  (`sideUnseen`, tab keys); `revealSideTab` pins the CURRENT tab first, because a new last canvas would
  otherwise become the default and take the panel anyway. A canvas WITH controls is the exception — it
  always takes the panel and sets the one-shot `sideExpand`, which SidePanel consumes to leave the
  collapsed strip WITHOUT persisting it (a file-card click sets it too, and so does a live `.drawio` the
  pane follows: its preview never hid behind the strip before the merge). The collapsed strip carries a dot (and says so in
  its aria-label) while a tab needs a look or the shown tab changed since the panel was folded.
- **A replayed run log never re-opens, re-selects or re-counts.** The server replays a run's WHOLE log on
  every (re)attach, so `pane.sideSeen` is a per-run watermark of the highest canvas/file frame id the pane
  applied, and `attachActiveRun` passes the run snapshot's `lastEventId` as `seenThrough`: what the run
  logged before the pane attached is history. A replayed frame still rebuilds state (content, pending,
  ids) but never selects a tab, re-opens a `.drawio` tab the viewer closed, marks a dot or bumps the
  client-side version count. Frames without a numeric id (tests) count as new. With nothing picked, the
  default prefers the latest canvas still `pending`, so a pane returning to a parked run shows the ask —
  even one that refined an older canvas in place — and moves on once a replayed `prompt_resolved` clears it.
- **Deleting a canvas is its own confirmed action** (CanvasTab's trash → `confirmAction` → `deleteCanvas`,
  which cancels a parked ask first). The strip's × only ever closes a FILE tab, which its card reopens.
- **Split view keeps file cards as downloads** and the live `.drawio` auto-open single-pane only: the one
  side panel serves the ACTIVE pane, and a tab opened unasked in another pane would surface later.

## Client ↔ server contracts mirrored by hand
- **New cross-boundary code goes into `src/shared/*`** (modules both sides compile, e.g. the import-free
  `mcpToolGroups.ts`, `todos.ts`) or a server module listed in `tsconfig.client.json`'s `include` (today
  `types.ts`, `routineSchedule.ts`, `experimentalFeatures.ts`, `releaseNotes.ts`, `effortLevels.ts`,
  `hexSshPolicy.ts`) — never a
  hand-copy. The pairs below predate that layer and are still mirrored by hand; update them in lockstep:
  - `normalizeTags` (`lib/format.ts`) ↔ server `normalizeHashtags`
  - repo-href building ↔ server `githubHost` resolution
  - the schedule builder (`RoutineModal.tsx` + `formatRoutineSchedule` in `lib/format.ts`) ↔ server
    `routineSchedule.ts` (once/daily/weekly/interval semantics)
- **`SteerPublic` is hand-mirrored because it lives in a ROUTE module, not `server/types.ts`.**
  `lib/types.ts` re-exports server types through that barrel, but this one is exported from
  `routes/chat.ts`, which `tsconfig.client.json` must never include (it reaches express and
  better-sqlite3 through its imports) — so the interface is declared twice and nothing type-checks across
  the gap. Fields: `id`, `text`, `state` (`queued|delivered|completed|dropped`), `createdAt`, `followUp`
  (true when the model got it only AFTER the current answer, as its own follow-up turn in the same run — the
  fallback; false when pi folded it into the running turn), and
  `message` — the persisted `kind:"steer"` user row, present ONLY on the `delivered` frame and `null`
  when the conversation was deleted mid-run. `PendingSteer` (`pane.steers`) has no server counterpart and
  is LIVE-only: `resetLive` clears it and a reattach rebuilds it from the replayed frames.
- **`steer` and `turn_end` are the two frames of a mid-turn message, and `turn_end` is NOT terminal.**
  One `steer {steer}` frame per state change, in order (`queued` → `delivered` → `completed`, or →
  `dropped`), and a `dropped` ALWAYS precedes the run's `cancelled`/`error` frame — `cancelRun`/`closeRun`
  and the run loop's `finally` close the channel before the terminal path emits, so the viewer is told why
  the text came back before being told the run stopped. `turn_end {message, response}` carries the same payload shape as `done` but
  is deliberately absent from `isTerminalFrame` (`lib/chat.ts`), so the reader keeps reading: the visible
  turn was sealed only because a steer is pending and the follow-up turn continues on the SAME run. The
  `open` frame carries no delivery mode: the composer's hint is always "작업 도중에 전달돼 진행 중인 일을 바꿀 수
  있어요", and a delivered row's badge comes from its position (`steerBadgeLabel` — "응답 중 전달" for a steer folded
  into the running turn, "답변 뒤 전달" for a follow-up one).
  `finalizeVisibleTurn` appends the bubble for both, and `endLiveTurn(pane, true)` keeps
  `streaming`/`liveRunId`/`abortController` where `clearLive` would drop them. Both frames ride the
  replayed event log, so **every handler has to be re-appliable**: messages dedupe by id, and a bounded
  `settledSteers` set keeps a replayed `dropped` from pushing its text into the composer twice and the
  POST's own 200 from re-adding a pending bubble the stream already resolved.
- **Rewind is an inline edit that sends through `sendMessage`, and it names rows by SERVER id.** 편집 on an
  ordinary user row (never a steer or `kind:"queued"` row, never while streaming) opens `pane.rewindEdit`
  in that bubble; 보내기 → `confirmAction` → `sendMessage(…, {rewindFromMessageId})`, which truncates
  optimistically and puts everything back from a local snapshot on a refusal before `open`. The anchor
  rules are hand-mirrored: the client's regenerate anchor (last NON-steer user row, hidden when it is
  queued) must match `findRegenerateAnchorId`, and an edit anchor must be a row the server knows — so
  `open.userMessageId` (and a `cancelled` frame's message) replaces the optimistic bubble's `newId()` —
  but the transcript is keyed on `messageKey` (the row's birth id, kept in the client-only `clientKey`),
  so the adoption updates the node in place instead of re-mounting it and replaying `bubble-in`.
  `applyLoadedConversation` MERGES a re-read by id (server rows decide membership and order; a matched
  row keeps its `clientKey` and an activity snapshot the server does not have yet). A regenerate never
  adopts (a stale tab's server may re-run another row) — the run-end re-read settles its ids.
  At `open` a rewind also closes the side-panel tabs of dropped files and refetches canvases (keeping ones
  this run already showed) — once, replay-safe.
- **The activity snapshot is WHITELISTED server-side.** The client seals the live tree and PUTs it to
  `/api/messages/:id/activity`, and `sanitizeActivity` (`routes/chat.ts`) rebuilds every agent/tool/task
  row from an explicit field list. A field added to `LiveAgentNode`/`LiveToolRow`/`LiveTaskRow` but not
  there works live and silently vanishes on reload — add it to `AgentActivity` (`server/types.ts`) and the
  sanitizer together, with a round-trip assertion in `tests/routes-chat.test.ts` (`name` is the
  worked example).
- **Admin presence badge: the client poll interval bounds the server window from BELOW.**
  `users.last_seen_at` is stamped by EVERY authenticated request, and `startKnowledgeWatch`
  (`lib/loaders.ts`) is what keeps it warm for an idle-but-open tab — it polls once a minute and ONLY while
  `document.hidden` is false. `PRESENCE_WINDOW_MS` (`store/internal.ts`) must therefore stay above that
  interval with room for one missed tick, so ~2 min is the floor; shortening the window below it, or
  lengthening the poll interval, makes the badge flicker to zero for people who are right there.
- **The window is currently 1 hour, which means "around recently", NOT "at the screen now."** At that width
  the visibility gate stops being load-bearing (one visible moment in the hour is enough) and someone who
  closed the tab 59 minutes ago still counts. It was widened from 3 min deliberately — 3 min emptied the
  badge whenever people switched tabs. Consequences to respect: never relabel the badge as live presence,
  always surface `AdminPresence.windowMinutes` in the UI (the tooltip and empty state do), and expect the
  per-row ages to carry the real signal. Still not `AdminStats.activeSessions`, which counts 14-DAY login
  cookies and so never decays within a workday. If the window ever changes, the two `windowMinutes`
  assertions (`tests/store.test.ts` straddles the boundary at 59/61 min, `tests/app.test.ts`) fail loudly by
  design.

## Behavior gotchas (don't "fix" these)
- **The model/effort/MCP-group pickers write through to a per-user default, fire-and-forget with NO
  readback** (`PUT /api/me/chat-defaults`): update `state.user.{model,effort,mcpToolGroups}Default`
  optimistically then PUT in the background, toast only on failure — never sync `state.user` from the
  response (rapid picks resolve out of order). New panes seed from these, which is what lets a pick reach
  the **auto-greeting**. (The retired group-knowledge toggle worked the same way.)
- Some settings cards (profile/visibility/secrets) save WITHOUT a full reload to avoid wiping unsaved form
  text — preserve in-place updates there.
- **A `secret`-carrying browser op is version-gated CLIENT-side, and the value passes straight through.**
  `handleBrowserOp` (`lib/chat.ts`) probes `readAllowedOrigins()` for the INSTALLED build before forwarding
  anything that has `secret` (or a field `secret`); below `SECRET_INPUT_MIN_EXTENSION_VERSION` (`0.28.0`,
  `lib/browserBridge.ts`) it answers `/api/chat/respond` with an English update instruction and never sends
  `secretText`/`secretValue`. The gate lives HERE rather than in `BROWSER_EXTENSION_MIN_COMPATIBLE` (still
  `0.6.0`) because an old build types NOTHING and reports success — a silent no-op on one op, not a broken
  contract, so ordering a fleet-wide reinstall would be the wrong trade. An UNREACHABLE extension keeps its
  own "not reachable" reason instead of a version story it can't support. The plaintext never reaches
  `setStatus`, the pane store, or a console: the Korean labels (`브라우저에 시크릿을 입력하는 중…` /
  `브라우저 폼을 채우는 중(시크릿 포함)…`) say only THAT one rides along.
- **The 시크릿 card's `브라우저 입력` control never saves on the tick.** Ticking it opens the inline
  허용 사이트 editor; the `PATCH /api/me/secrets/:name` `{ browser: { enabled, hosts, passwordOnly } }` waits
  for 저장, because the allowed hosts ARE the policy and an enabled secret with none would be meaningless.
  Host syntax is deliberately NOT mirrored client-side (`normalizeBrowserSecretHosts` on the server is the
  single, all-or-nothing set of rules) — the input is only split on comma/space/newline and the server's
  Korean `apiError` is surfaced verbatim via `notify`. Reserved git/SSH names get no control at all
  (`isBrowserExposableSecret`), the same line the 셸 노출 toggle draws.
- **A multi-tab view's tabs are ALWAYS-MOUNTED components with an `active` prop, never
  `{tab === "x" && <Child />}`.** A child rendered conditionally unmounts on every tab switch and silently
  loses its unsaved form state. Render all tab components UNCONDITIONALLY and pass
  `active={settingsTab === "…"}`; each child gates only its own markup (`active && user ? … : null`, after
  its hooks) and initializes form state ONCE from `readState().user`. `SettingsView.tsx` is the worked
  example (tabs in `components/Settings{Profile,Access,Knowledge}Tab.tsx`).
- **관리자 ▸ 도구·스킬 (`#/admin/tools`, between 시스템 and 감사 로그) holds the two team-wide admin panels**
  (single team, 2026-11-06 — [`team-trust.md`](team-trust.md)). `AdminToolPolicyPanel.tsx` (MCP 도구 정책)
  edits the ONE global allowlist through `GET/PUT /api/admin/tool-policy`; `system` is shown checked and
  non-toggleable, and a save calls `refreshMe` so the admin's own composer picks up the clamp at once.
  `AdminSharedSkillsPanel.tsx` (공유 스킬 관리) lists `GET /api/admin/shared-skills` with a search box and
  a 차단 N개 count, and blocks/unblocks through `confirmAction`; a 공유 목록에 없는 차단 section lists
  the response's `otherBlocks` (blocks with no active share row) so they can be lifted too. The signup-mode control (가입·접근 ▸ 회원가입 정책) offers only
  승인제 / 가입 차단 (a stored `open` or no value shows as 승인제), and the visibility control (`SettingsProfileTab`, admin `AdminUserRow`) reads
  팀 공개 / 비공개. Old `#/groups` bookmarks land on 탐색 and `#/admin/groups` opens 관리자 on its current tab (`lib/nav.ts`).
- **Agent cards fold only when SEVERAL agents share one tree.** `ActivityTree` decides at the root (≥2
  sub-agents among the rows it renders) and nested trees inherit
  the decision. Each sub-agent card that has rows then gets a disclosure header (`@name` on older snapshots, label,
  `도구 N개 · 태스크 M개`, chevron) and shows only its latest tool row (its latest task row when it has no
  tools). A lone agent, a card with no rows yet and the main agent's own rows never fold. Open state is
  the module store `openAgentCards` (`lib/agentCards.ts`), keyed by agent id so the card the viewer
  opened stays open while the live bubble finalizes into the stored message; it is session-only on
  purpose. The header is a real `<button>` that strips the global button chrome (and the press scale),
  so it keeps the coarse-pointer 44 px min-height — on touch a card's head grows once when its first row
  arrives. Both the button and the static head WRAP instead of clipping when a line is too narrow:
  whatever no longer fits (the label, the count + chevron, or both) moves down, and the label's
  `flex-basis: 6em` is what keeps a merely long label truncating on one line wherever the bubble is
  wide. The 에이전트 badge is `flex:none`+`nowrap` because `.bubble`'s inherited `overflow-wrap:anywhere`
  otherwise broke it into one syllable per line on phones.

## Client verification
- **`npx tsc -p tsconfig.client.json --noEmit`** is the client typecheck (also `npm run lint:client`);
  `npx tsc --noEmit` covers the server and the shared types. `vite build` (`npm run build:client`) is the
  production compile; `pretest` runs `vite build --mode test`. ⚠️ Don't trust `npm run lint` — the rtk hook
  misrewrites it to eslint. There is no eslint config: `react-hooks/exhaustive-deps` comments in the source
  are documentation, nothing checks them.
- **React component tests** live in `tests/react-*.test.tsx` (vitest "react" project: jsdom +
  `@vitejs/plugin-react` + `@testing-library/react`, setup files `tests/setup-dom.ts` + `tests/setup-react.ts`;
  `tests/react-foundation.test.tsx` is the worked example and covers the plumbing). The glob is load-bearing
  THREE ways: it routes the file into that project (vitest.config.ts), OUT of the root NodeNext tsc program
  (tsconfig.json `exclude`), and INTO `tsconfig.client.json`'s include. Non-component client-lib tests use
  the sibling `tests/client-*.test.ts` glob (same tsconfig routing; node env with per-file jsdom pragmas).
  `.tsx` files are NOT in the coverage `include` — adding them would sink totals below the vitest
  thresholds until component tests broaden. In a test: store writes made while a component is mounted go
  inside `act`; an exit keeps its element for a moment (inert) — assert absence with `waitFor`; RTL
  `waitFor`/`findBy*` do not advance under vitest FAKE timers (use `act` + `vi.advanceTimersByTimeAsync`);
  jsdom does not reflect React's `inert` attribute as a property (assert `hasAttribute("inert")`).
- **Isolated UI/layout/interaction behavior CAN be runtime-verified** when no `HTTP_PROXY` is set (check
  `env | grep -i proxy`). Playwright is already installed (`@playwright/test` devDep + `playwright-core`; fetch a browser with
  `node node_modules/@playwright/test/cli.js install chromium` if missing), build a MINIMAL React fixture **inside the project dir** (a `/tmp` fixture can't resolve
  `vite`/`@vitejs/plugin-react` from `node_modules`) that imports the REAL action/component under
  test, serve it (`node_modules/.bin/vite --config <fixture>/vite.config.mjs`, `configFile:false`,
  `plugins:[react()]`), and drive it headless to measure real DOM/layout. Clean up after: `rm -rf` the
  fixture. This caught the
  `autosize` shrink-after-send fix PASSING the typecheck yet FAILING at runtime, and the wheel-animation
  re-engage race in the transcript auto-scroll rewrite.
- **The whole app can be driven against the `local` runtime** (`AGENT_RUNTIME=local`, a private
  `APP_DATA_DIR` and `PORT`): a Vite server whose proxy points at that server gives real API shapes and the
  scripted `demo …` runs for every chat flow, and the built app served by that server runs under the real
  CSP. The React port was accepted this way: the same 33 screens and the same live flows (send, stream,
  thinking, tools, six canvas kinds, inline UI, mid-turn message, error, edit-and-resend, regenerate, split,
  할 일 card, slash menu) gave the same DOM in both apps, and the visual suite gave the same results.
- ⚠️ **Vite full-reloads the fixture page once after a source edit** (dep re-optimize): everything you
  `evaluate()`d before the reload — seeded DOM, started intervals, window hooks — is silently wiped while
  the driver keeps talking to the fresh page. Warm up first: `goto` → wait ~700ms → `reload()` → then
  run the scenario. (Symptom: assertions on state you "just set" find defaults; `[vite] connecting...`
  appears twice with console piped.) Playwright can't synthesize scrollbar drags in headless Chromium —
  assert that path via unit tests, and report the browser check as skipped rather than green.

## UI-consistency invariants (2026-08 pass) — load-bearing, don't regress
- **`00-tokens.css`가 라운드·그림자·이징의 단일 정의처.** `80-apple-design.css`는 재정의 금지
  (해당 자리에 금지 주석). 과거 이중 정의로 00 값이 전부 죽은 값이 되는 사고가 있었다.
- **`App.tsx`의 모달 DOM 순서가 스택킹을 결정한다** — 전부 같은 `--z-modal`이라
  `ConfirmationDialog`가 마지막이어야 다른 모달 위에 그려진다. 순서 변경 금지(DESIGN.md §4.4).
- **모달 동작(포커스 트랩·inert·초기 포커스·복원)은 `lib/modalBehavior.ts` 공유 모듈** —
  `Modal.tsx`/`PromptModal.tsx`/`CanvasTab.tsx`(canvas-fs)가 공용. PromptModal 루트
  인스턴스는 Escape=거부·백드롭 닫기 없음(의도), pane 인스턴스는 non-modal(aria-modal/inert 없음).
- **테마 반응성:** `lib/theme.ts`의 `theme` 스토어는 `applyTheme()`만 발행하는 single-writer.
  캔버스형 렌더러(GraphCanvas의 cytoscape 스타일, CanvasTab의 mermaid)는 이 스토어를
  구독해 재스타일한다 — `data-theme`을 init에서 한 번만 읽는 패턴으로 되돌리면 토글 시 색이 낡는다.
- **차단 이벤트는 2채널:** `BlockedEvent.uiReason`(한국어, UI 표시용) vs `reason`(영어, 진단용).
  클라이언트 `lib/chat.ts`는 `uiReason` 우선. 모델에 가는 영어 텍스트를 한국어로 바꾸지 말 것(반대도 금지).
  이 이벤트를 내던 SDK PreToolUse hook은 없어졌고, pi 런타임에는 아직 내는 곳이 없다 — 다시 쓸 때도 이 분리를 지킨다.
- **audit log의 status는 `success`/`error` 외에 `ok`도 존재**(`agent/sshIdentityTools.ts`).
  클라이언트 라벨 매핑(`AdminView.tsx`)은 세 값 모두 처리한다.
- **아이콘 경로의 단일 출처는 `lib/icons.ts`** (`ICON_PATHS` + `iconSvg`) — `Icon.tsx`와
  `lib/dom.ts`(imperative innerHTML)가 함께 소비한다. `Icon.tsx`에 경로를 직접 추가하지 말 것.
  `Icon`의 `name`은 bare string이라 **오타는 조용히 빈 SVG로 렌더**된다 — 이름 추가 시 육안 확인.
- **A status indicator that only STATES a problem is a dead end — make it the way to the fix.** The composer's
  browser-bridge badge is a `<button>` into the install guide on every rung that names something ACTIONABLE, and
  an inert `<span>` only when the install matches the server bundle exactly. Each rung (`data-status`
  `current`/`compatible`/`outdated`/`unreachable`, styled `--ok`/`--info`/`--warn`/`--danger`) carries its OWN
  TEXT, not just its colour — two rungs told apart by hue alone are one rung to anyone who can't separate the
  dots. Same for gated buttons: a disabled button whose prerequisite is unstated reads as broken, so make the
  prerequisite the button's FIRST STEP on the same click (which is also the user gesture a file picker needs).
  Cross-view deep links ride a ONE-SHOT flag in `lib/state.ts` (`browserGuideRequested`, set by the badge and
  `WhatsNewModal`, consumed and cleared by `SettingsAccessTab` on activation), never a router param.
