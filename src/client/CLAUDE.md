# src/client — Claude notes (Svelte + Vite frontend)

Client-area direction. Read with the **root [`CLAUDE.md`](../../CLAUDE.md)** ("Frontend"/CSP, build,
SSE chat, language split). The detailed mechanics (state store API, theme single-source, every CSS
gotcha, the Svelte 5 timing traps, hand-mirrored validators, Playwright verification recipe) live in
**[`../../docs/architecture/client.md`](../../docs/architecture/client.md)**. Design language →
[`../../docs/DESIGN.md`](../../docs/DESIGN.md).

Durable principles for this layer:

- **Svelte 5 + Vite under `src/client/`, NOT vanilla `public/`** (migrated 2026-06). `lib/state.ts` is the
  central writable store — mutate via `updateState`, read via `readState`; reactivity comes from the
  `$appState` subscription, there's no manual `renderView()`.
- **Stylesheets were carried over VERBATIM from the old vanilla frontend** (same filenames, same class
  names). So porting/restoring a feature = reproducing the SAME DOM structure + class names — don't invent
  new ones (a custom class with no CSS renders unstyled). The old frontend is the parity reference at git
  `f0a6128`. Server types are SHARED via the `lib/types.ts` re-export barrel, never re-declared.
- **`app.ts` serves a strict same-origin CSP** (`connect-src 'self'`; `script-src 'self'
  'wasm-unsafe-eval'` — wasm COMPILATION only, for the composer mic's Silero VAD). So: no inline
  `<script>` (the build emits none), no `eval`, no `blob:`/remote `<img>`, no `Function`-ctor renderers —
  any first-paint theming or content rendering must stay CSP-safe (the canvas/theme designs are built
  around this). Widen a directive in `app.ts` only when a feature genuinely needs it.
- **A green svelte-check does NOT mean the behavior is correct.** For interaction/layout/timing changes,
  runtime-verify (Playwright fixture). svelte-check catches type/template errors; it shipped a no-op
  `autosize` fix that only a real-DOM measurement caught.
- **Legacy-mode template dependencies are resolved at COMPILE time** (every component here is non-runes).
  A template expression depends only on what the MARKUP names — helper calls are `untrack`ed, so state
  read solely inside a helper's closure renders STALE (the composer mic's `title` froze this way). Pass
  the state as an argument (`attachHint(item, $appState)`) or name it in the markup (`{@const}`).
  Neither svelte-check nor jsdom catches it: unrelated store writes re-evaluate the expression and mask
  the staleness — only a real browser shows it.
- **Motion that should play only for SOME changes is gated inside the transition/animation function,
  on non-reactive state read when it starts** — a removed keyed row only sees its last render's params,
  and `animate:` lists need a positioned container whose height is held only when it is TOP-anchored. Details in `client.md` (Svelte 5 runtime
  gotchas); verify geometry in Playwright, never jsdom.
- **There IS a shared layer — reach for it before hand-mirroring.** `src/shared/*`
  (`mcpToolGroups.ts`, `sdkToolPresentation.ts`) is imported by BOTH sides, and `tsconfig.client.json`'s
  `include` list is the whitelist of server modules the client may import directly (`server/types.ts`,
  `modelTiers`, `effortLevels`, `experimentalFeatures`, `releaseNotes`). New cross-boundary code goes
  there, never a second copy. Only LEGACY mirrors remain (`normalizeTags` vs the server's
  `normalizeHashtags`, repo-href in `lib/format.ts`) — update those in lockstep, don't add more.
- **A status indicator that only STATES a problem is a dead end — make it the way to the fix.** The
  composer's browser-bridge badge is a `<button>` into the install guide on every rung that names
  something ACTIONABLE, and an inert `<span>` only when the install exactly matches the server bundle
  (a control nobody needs is clutter in an already dense hint row). Its four rungs
  (`data-status`: `current`/`compatible`/`outdated`/`unreachable`, styled `--ok`/`--info`/`--warn`/
  `--danger`) each carry their OWN TEXT, not just their own colour — two rungs distinguished by hue
  alone are one rung to anyone who can't separate the dots. Same rule for gated
  buttons: a disabled button whose prerequisite is unstated reads as broken — make the prerequisite the
  button's FIRST STEP on the same click, which is also the user gesture a file picker needs. Cross-view
  deep links ride a ONE-SHOT flag in `lib/state.ts` (`browserGuideRequested`, set by the badge and the
  what's-new dialog, consumed and cleared by `SettingsAccessTab` on activation), not a router param.
- **Splitting a multi-tab view: ALWAYS-MOUNT children + an `active` prop, never `{#if tab}` around the
  child** — wrapping in `{#if}` unmounts and silently loses typed-but-unsaved form state. Several settings
  cards also save WITHOUT a full reload for the same reason; preserve those in-place updates.
