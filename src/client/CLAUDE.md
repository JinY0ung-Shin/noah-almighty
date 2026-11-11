# src/client — Claude notes (Svelte + Vite frontend)

Client-layer rules. Read with the root [`CLAUDE.md`](../../CLAUDE.md); mechanics (state API, theme, CSS and
Svelte 5 gotchas, mirrored validators, Playwright recipe) live in
[`docs/architecture/client.md`](../../docs/architecture/client.md); design language in
[`docs/DESIGN.md`](../../docs/DESIGN.md).

- **Svelte 5 + Vite under `src/client/`, NOT vanilla `public/`.** `lib/state.ts` is the central store
  (`updateState` / `readState`, reactivity via `$appState`).
- **Stylesheets came over VERBATIM from the old vanilla frontend**, so restoring a feature means reproducing
  the SAME DOM + class names (parity reference: git `f0a6128`); a new class with no CSS renders unstyled.
  Server types come through the `lib/types.ts` barrel, never re-declared.
- **Strict same-origin CSP** (served by `app.ts`): no inline `<script>`, no `eval`/`Function` renderers, no
  `blob:`/remote images. Keep first-paint theming and rendering CSP-safe; widen a directive only when a
  feature genuinely needs it.
- **Use the shared layer before hand-mirroring:** `src/shared/*` and the server modules whitelisted in
  `tsconfig.client.json`'s `include`. Only legacy mirrors remain (see `client.md`) — don't add more.
- **A green svelte-check (or jsdom) does NOT prove behavior.** Interaction, layout, timing and motion changes
  are verified in a real browser (Playwright).
- **Legacy-mode template deps are resolved at COMPILE time** (every component is non-runes): state read only
  inside a helper the markup calls renders STALE. Pass it as an argument or name it in the markup.
- **Motion is the app's own setting (움직임 줄이기), never the OS's.** No `prefers-reduced-motion` media
  query anywhere in the client (a test fails on one): CSS keys on `:root[data-motion="reduce"]`, JS on
  `prefersReducedMotion()`; no native smooth scroll (`scrollToStart`). Details in `client.md`.
- **Selective motion is gated INSIDE the transition/animation function**, on non-reactive state read when it
  starts. Details in `client.md`.
- **A status indicator that only STATES a problem is a dead end — make it the way to the fix.** Actionable
  states are buttons; each state carries its own TEXT, not just a colour; a gated button makes its
  prerequisite its first step. Cross-view deep links ride a one-shot flag in `lib/state.ts`, not a router
  param.
- **Multi-tab views keep children ALWAYS-MOUNTED with an `active` prop**, never `{#if tab}` — unmounting
  loses unsaved form state. Preserve the settings cards' in-place (no-reload) saves for the same reason.
