# Client (Svelte + Vite)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Structure, CSP, theme, CSS and Svelte 5 gotchas, hand-mirrored contracts, and client verification.

Companion to the client-area philosophy in [`../../src/client/CLAUDE.md`](../../src/client/CLAUDE.md).

## Structure
- **The frontend is Svelte + Vite under `src/client/`, NOT vanilla `public/`** (migrated 2026-06, commit
  `b8505fb`). `public/` now holds only static assets (favicons, manifest, PWA icons). Entry
  `src/client/index.html` → `src/client/src/main.ts` → `App.svelte`; views in `src/views/*.svelte`, shared
  components in `src/components/*.svelte`, non-UI logic/stores in `src/lib/*.ts`. `lib/state.ts` is the
  central writable store (`appState` + `updateState`/`readState`/`replaceState`/`notify`); other lib:
  `chat`, `loaders`, `api`, `nav`, `slash`, `format`, `dom`, `knowledge`, `onboarding`, `theme`, `sse`.
  Built by `vite build` → `dist/client`, which `app.ts` serves (falling back to `public/`).
- **`src/lib/state.ts`:** `appState` is a Svelte `writable`; mutate via `updateState(fn)`
  (mutate-then-reassign; also recomputes `streaming`), read via `readState()`, patch via
  `replaceState(patch)`, toast via `notify(msg, kind?, {actionLabel?, action?})`. Reactivity comes from the
  store subscription (`$appState`) — no manual `renderView()`.
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
  `script-src 'self' 'wasm-unsafe-eval'`). So remote `<img>` in rendered markdown is BLOCKED and the
  browser can't fetch cross-origin — widen the relevant directive in `app.ts` if a feature needs it. The
  Svelte build emits no inline `<script>`, so a `script-src` with no `'unsafe-inline'` is safe;
  `'wasm-unsafe-eval'` is the one deliberate addition (WebAssembly compilation for the composer mic's
  Silero VAD — it does not enable JS `eval`, see [`stt.md`](./stt.md)).

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
- Global stylesheet + `{@html}`-rendered markdown share class names — avoid bare generic class names (e.g.
  `main`) on dynamically-rendered nodes; the activity-tree root uses `is-main`, not `main`
  (`.main { height: 100dvh }` once stretched the box). Svelte component `<style>` is scoped, but the
  carried-over global CSS and `{@html}` output are not.

## Svelte client pitfalls (svelte-check catches these)
- `<svelte:window>` cannot live inside `{#if}`/blocks — must be top-level. A `use:action` taking a
  parameter must declare a 2nd arg `(node, param?)` or svelte-check errors "Expected 1 arguments, but got
  2". `role="dialog"`/`"tablist"` on a `<nav>`/`<div>` trips an a11y warning — put the role on the right
  element. `AgentResponse.runtime` is only `"local"|"claude"` (errors/blocked surface via `summary`, NOT
  runtime — don't compare runtime to `"error"`).

## Svelte 5 runtime gotchas (svelte-check does NOT catch these)
- **A green svelte-check does NOT mean the behavior is correct — for interaction/layout/timing changes,
  runtime-verify (Playwright fixture, see Verification).** The `autosize` fix (passing `item.draft` as the
  action param + a 2nd-arg signature) compiled AND passed svelte-check yet was a pure no-op at runtime;
  only a real-DOM measurement caught it.
- **A `use:action={param}`'s `update()` runs BEFORE Svelte flushes the bound `value` to the DOM node.** So
  reading layout (`scrollHeight`) synchronously inside `update()` measures the OLD content. This bit the
  composer `autosize` (`lib/dom.ts`): on send, `ChatView` sets `draft=""`; the action's `update()` fired but
  `node.value` was still the old multi-line text at that instant, so `grow()` re-pinned the tall height,
  then Svelte set `value=""` without re-measuring → the textarea never shrank back. Fix: defer the
  param-driven grow with `queueMicrotask(grow)`; keep the `input`-listener path synchronous. General rule:
  when an action must react to a programmatic value change, defer any layout read to a microtask.
- **Legacy mode compiles template FUNCTION CALLS inside `$.untrack()`** (Svelte-4 compile-time dependency
  semantics: only variables referenced DIRECTLY in the expression are tracked). A helper like
  `hasPresetValue(name)` that reads a reactive `let` in its BODY never re-runs when that state changes —
  the CONFLUENCE_PAT 저장 button stayed disabled while typing (`SettingsAccessTab`). Fix pattern: derive
  per-item state in a `$:` map (`presetFilled`/`presetStatusText`) and have the template read the map
  DIRECTLY. Functions that read only their ARGUMENTS (e.g. `canSendMessage(item)`) are fine — the arg is
  the tracked dep. Known latent same-class instances (masked by coincident list refreshes, unverified):
  `Shell.isConversationBusy`/`isConversationStreaming`, `ChatView.canPickModel` — see REFACTORING-BACKLOG.
- **One `updateState` re-evaluates EVERY each-block item's template expressions — and streaming calls it
  once per SSE token.** `$: panes = $appState.chatPanes` re-emits the same array, but `safe_not_equal` is
  always true for objects, so the dirt propagates down to each keyed item. Measured with a probe component
  matching ChatView's shape: a 200-message pane ran 200 template evaluations *per token* (2,000 over 10
  tokens). In the transcript that expression is `renderMarkdown(...)` — 57 ms of `marked` + `DOMPurify` per
  token, all thrown away because the html was identical. Two mitigations are in place, keep them:
  `renderMarkdownCached` (`lib/format.ts`) memoizes PERSISTED message bodies on their source text — live
  streaming text must keep the plain `renderMarkdown` or it just churns the map; and `enhanceMarkdown`
  (`lib/dom.ts`) skips its two `querySelectorAll` sweeps when the param is identity-equal, which is why
  every call site MUST pass the same source string its sibling `{@html}` renders. The real fix is runes
  for this subtree (REFACTORING-BACKLOG T3.10); until then, assume anything in a chat `{#each}` runs at
  token rate and keep it cheap or memoized.
- **`<details>` hides its children, it does not skip rendering them.** A body left in the template costs a
  full markdown parse / component mount for every message on load, on a card most users never open. The
  transcript's "생각 과정" and "작업 내역" cards therefore render on first open, driven by an
  `expandedCards` set fed from `on:toggle` (`ChatView`). Note `toggle` fires as a TASK after `open` flips
  (spec behavior, jsdom matches) — a test must await a macrotask, not just `tick()`. Trade-off accepted:
  Chrome's find-in-page can no longer reach inside an unopened card.

- **Never force a layout inside a component's mount task** (`getBoundingClientRect()`, `offsetHeight`,
  … in `onMount` during the app's initial mount). That layout runs while the `@font-face` Korean
  subsets are still UNLOADED, and in headless Chromium the text it shaped can stay on the system
  fallback for good even after every face reports `loaded` — `document.fonts.check()`/`ready` say
  fine, the pixels are tofu. The DM dock's inset measurement did exactly this and turned the rail's
  탐색/비우기/진영 into boxes in three visual baselines (bisected 2026-09-11 with CDP
  `CSS.getPlatformFontsForNode`; fix = defer the measurement behind a double `requestAnimationFrame`,
  `DirectMessageDock.svelte`). The visual specs' `waitForKoreanFont` now ends with
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
  - ChatView keeps only thin wiring: `use:transcriptStick={item.id}` + `afterUpdate → pin()` + the FAB's
    `jumpToBottom()`; `stickBottom` stays in the pane store (send re-arms it in `lib/chat.ts`).

## Split chat
- Avatar pool = all visible avatars, duplicates allowed (multiple parallel conversations with the same
  avatar incl. your own); the only gate is the 4-pane max. User message bubbles render text directly in
  `.bubble` (which has `white-space: pre-wrap`), NOT wrapped in `<p>` (that adds stray top/bottom margins).
  `GET /api/avatars` (`listPublishedAvatars`) includes the viewer's OWN avatar plus public + group-teammate
  avatars.

## Client ↔ server contracts mirrored by hand
- No shared module across the TS/Svelte ↔ server boundary, so the client re-implements several server
  validators. Update these in lockstep:
  - `normalizeTags` (`lib/format.ts`) ↔ server `normalizeHashtags`
  - repo-href building ↔ server `githubHost` resolution
  - the schedule builder (`RoutineModal.svelte` + `formatRoutineSchedule`/`timeToMinute`/`minuteToTime` in
    `lib/format.ts`) ↔ server `routineSchedule.ts` (once/daily/weekly/interval semantics)
- **`SteerPublic` is hand-mirrored because it lives in a ROUTE module, not `server/types.ts`.**
  `lib/types.ts` re-exports server types through that barrel, but this one is exported from
  `routes/chat.ts`, which `tsconfig.client.json` must never include (it reaches express and
  better-sqlite3 through its imports) — so the interface is declared twice and nothing type-checks across
  the gap. Fields: `id`, `text`, `state` (`queued|delivered|completed|dropped`), `createdAt`, `followUp`
  (the model got it only AFTER a result boundary, so it starts its own turn in the same run), and
  `message` — the persisted `kind:"steer"` user row, present ONLY on the `delivered` frame and `null`
  when the conversation was deleted mid-run. `PendingSteer` (`pane.steers`) has no server counterpart and
  is LIVE-only: `resetLive` clears it and a reattach rebuilds it from the replayed frames.
- **`steer` and `turn_end` are the two frames of a mid-turn message, and `turn_end` is NOT terminal.**
  One `steer {steer}` frame per state change, in order (`queued` → `delivered` → `completed`, or →
  `dropped`), and a `dropped` ALWAYS precedes the run's `cancelled`/`error` frame — `cancelRun`/`closeRun`
  and the run loop's `finally` close the channel before the terminal path emits, so the viewer is told why
  the text came back before being told the run stopped. `turn_end {message, response}` carries the same payload shape as `done` but
  is deliberately absent from `isTerminalFrame` (`lib/chat.ts`), so the reader keeps reading: the visible
  turn was sealed only because a steer is pending and the follow-up turn continues on the SAME run.
  `finalizeVisibleTurn` appends the bubble for both, and `endLiveTurn(pane, true)` keeps
  `streaming`/`liveRunId`/`abortController` where `clearLive` would drop them. Both frames ride the
  replayed event log, so **every handler has to be re-appliable**: messages dedupe by id, and a bounded
  `settledSteers` set keeps a replayed `dropped` from pushing its text into the composer twice and the
  POST's own 200 from re-adding a pending bubble the stream already resolved.
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
- **Group-knowledge toggle saves a per-USER default, fire-and-forget with NO readback.** A new chat pane
  seeds `groupKnowledgeOff` from `state.user.groupKnowledgeOffDefault` (own-avatar panes only). This is what
  lets the toggle reach the **auto-greeting** (fires before the composer is touched). The toggle updates
  `state.user.groupKnowledgeOffDefault` optimistically and PUTs `/api/me/group-knowledge-default` in the
  background; it deliberately does NOT sync `state.user` from the response (rapid toggles resolve out of
  order) and only toasts on failure. Don't "fix" this into an await-and-sync.
- **The model/effort/MCP-group pickers write through to a per-user default** (`PUT /api/me/chat-defaults`),
  same optimistic-update pattern as the group-knowledge toggle: update `state.user.{model,effort,
  mcpToolGroups}Default` then PUT in the background, toast only on failure. New panes seed from these.
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
- **Splitting a multi-tab view into per-tab components: ALWAYS-MOUNT + `active` prop, never `{#if tab}`
  around the child.** In a monolithic tab view, `{#if settingsTab===…}` only swaps the *template* branch
  while the single `<script>`'s `let` form vars persist across tab switches. Rendering each new child
  *inside* `{#if}` unmounts it on every switch and silently loses that state. Faithful split: render all tab
  components UNCONDITIONALLY (always mounted) and pass `active={settingsTab === "…"}`; each child gates only
  its own template (`{#if active && user}`) and initializes form state ONCE at script-init from
  `readState().user`. `SettingsView.svelte` is the worked example (1,013→130 lines; tabs in
  `components/Settings{Profile,Access,Knowledge}Tab.svelte`). The former inline groups tab moved to its
  own left-rail view (`views/GroupsView.svelte`, 2026-08): my-groups cards + the system-admin group
  management that used to be the admin view's 그룹 tab; legacy `#/settings/groups`·`#/admin/groups`
  hashes normalize to `#/groups` in `lib/nav.ts` `routeFromHash`.
- **Admin external avatars are independently lazy-loaded.** `AdminExternalAgentsPanel.svelte` stays
  mounted with an `active` prop so its API cannot blank the existing admin overview and unsaved editor
  state is not coupled to tab switches. Its modal uses explicit `keep|set|clear` API-key intent and
  forces an Explore cache refresh after CRUD so runtime visibility changes appear immediately.

## Client verification
- **`npx svelte-check --tsconfig ./tsconfig.client.json`** is the real client type/template check (also
  `npm run lint:client`); `npx tsc --noEmit` covers shared server types. `vite build` (`npm run
  build:client`) is the production compile; `pretest` runs `vite build --mode test`. ⚠️ Don't trust
  `npm run lint` — the rtk hook misrewrites it to eslint.
- **Svelte component tests** live in `tests/svelte-*.test.ts` (vitest "components" project: jsdom +
  `@sveltejs/vite-plugin-svelte` + `@testing-library/svelte`; `tests/svelte-components.test.ts` is the
  worked example). The glob is load-bearing THREE ways: it routes the file into that project
  (vitest.config.ts), OUT of the root NodeNext tsc program (tsconfig.json `exclude`), and INTO
  `tsconfig.client.json`'s include (svelte-check typechecks it). Non-component client-lib tests use the
  sibling `tests/client-*.test.ts` glob (same tsconfig routing; node env with per-file jsdom pragmas; no
  Svelte plugin). `.svelte` files are NOT in the coverage `include` yet — adding them would sink totals
  below the vitest thresholds until component tests broaden.
- **Isolated UI/layout/interaction behavior CAN be runtime-verified** when no `HTTP_PROXY` is set (check
  `env | grep -i proxy`). Install Playwright on demand (`npm i -D playwright && npx playwright install
  chromium`), build a MINIMAL Svelte fixture **inside the project dir** (a `/tmp` fixture can't resolve
  `vite`/`@sveltejs/vite-plugin-svelte` from `node_modules`) that imports the REAL action/component under
  test, serve it (`node_modules/.bin/vite --config <fixture>/vite.config.mjs`, `configFile:false`,
  `plugins:[svelte()]`), and drive it headless to measure real DOM/layout. Clean up after: `rm -rf` the
  fixture and `npm uninstall` the playwright devDeps so `package.json`/lock stay clean. This caught the
  `autosize` shrink-after-send fix PASSING svelte-check yet FAILING at runtime, and the wheel-animation
  re-engage race in the transcript auto-scroll rewrite.
- ⚠️ **Vite full-reloads the fixture page once after a source edit** (dep re-optimize): everything you
  `evaluate()`d before the reload — seeded DOM, started intervals, window hooks — is silently wiped while
  the driver keeps talking to the fresh page. Warm up first: `goto` → wait ~700ms → `reload()` → then
  run the scenario. (Symptom: assertions on state you "just set" find defaults; `[vite] connecting...`
  appears twice with console piped.) Playwright can't synthesize scrollbar drags in headless Chromium —
  assert that path via unit tests, and report the browser check as skipped rather than green.

## UI-consistency invariants (2026-08 pass) — load-bearing, don't regress
- **`00-tokens.css`가 라운드·그림자·이징의 단일 정의처.** `80-apple-design.css`는 재정의 금지
  (해당 자리에 금지 주석). 과거 이중 정의로 00 값이 전부 죽은 값이 되는 사고가 있었다.
- **`App.svelte`의 모달 DOM 순서가 스택킹을 결정한다** — 전부 같은 `--z-modal`이라
  `ConfirmationDialog`가 마지막이어야 다른 모달 위에 그려진다. 순서 변경 금지(DESIGN.md §4.4).
- **모달 동작(포커스 트랩·inert·초기 포커스·복원)은 `lib/modalBehavior.ts` 공유 모듈** —
  `Modal.svelte`/`PromptModal.svelte`/`CanvasPanel.svelte`(canvas-fs)가 공용. PromptModal 루트
  인스턴스는 Escape=거부·백드롭 닫기 없음(의도), pane 인스턴스는 non-modal(aria-modal/inert 없음).
- **테마 반응성:** `lib/theme.ts`의 `theme` 스토어는 `applyTheme()`만 발행하는 single-writer.
  캔버스형 렌더러(GraphCanvas의 cytoscape 스타일, CanvasPanel의 Vega/mermaid)는 이 스토어를
  구독해 재스타일한다 — `data-theme`을 init에서 한 번만 읽는 패턴으로 되돌리면 토글 시 색이 낡는다.
- **차단 이벤트는 2채널:** `BlockedEvent.uiReason`(한국어, UI 표시용) vs `reason`(영어
  `decision_reason`, SDK/진단용). 클라이언트 `lib/chat.ts`는 `uiReason` 우선. 모델에 가는
  영어 텍스트를 한국어로 바꾸지 말 것(반대도 금지) — `preToolUseHook.ts`가 레퍼런스.
- **admin 외부 아바타 검증 메시지는 `routes/adminExternalAgents.ts`가 `EXTERNAL_AGENTS_JSON[0].`
  접두사를 정규식으로 벗겨 렌더한다** — `externalAgents.ts`의 한국어 throw는 `.field` 형태를
  유지해야 조사가 어색하게 잘리지 않는다.
- **audit log의 status는 `success`/`error` 외에 `ok`도 존재**(`agent/sshIdentityTools.ts`).
  클라이언트 라벨 매핑(`AdminView.svelte`)은 세 값 모두 처리한다.
- **아이콘 경로의 단일 출처는 `lib/icons.ts`** (`ICON_PATHS` + `iconSvg`) — `Icon.svelte`와
  `lib/dom.ts`(imperative innerHTML)가 함께 소비한다. `Icon.svelte`에 경로를 직접 추가하지 말 것.
  `Icon`의 `name`은 bare string이라 **오타는 조용히 빈 SVG로 렌더**된다 — 이름 추가 시 육안 확인.
