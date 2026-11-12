# src/client — Claude notes (React + Vite frontend)

Client-layer rules. Read with the root [`CLAUDE.md`](../../CLAUDE.md); mechanics (state API, theme, CSS and
React gotchas, mirrored validators, Playwright recipe) live in
[`docs/architecture/client.md`](../../docs/architecture/client.md); design language in
[`docs/DESIGN.md`](../../docs/DESIGN.md).

- **React 19 + Vite under `src/client/`, NOT vanilla `public/`** (Svelte until 2026-11-12). `lib/state.ts` is
  the central store (`updateState` / `readState`); components read it with `useAppState()` (`lib/hooks.ts`).
- **Stylesheets came over VERBATIM from the old vanilla frontend**, so restoring a feature means reproducing
  the SAME DOM + class names (parity reference: git `f0a6128`); a new class with no CSS renders unstyled.
  Server types come through the `lib/types.ts` barrel, never re-declared.
- **Strict same-origin CSP** (served by `app.ts`): no inline `<script>`, no `eval`/`Function` renderers, no
  `blob:`/remote images. Keep first-paint theming and rendering CSP-safe; widen a directive only when a
  feature genuinely needs it.
- **Use the shared layer before hand-mirroring:** `src/shared/*` and the server modules whitelisted in
  `tsconfig.client.json`'s `include`. Only legacy mirrors remain (see `client.md`) — don't add more.
- **A green typecheck (or jsdom) does NOT prove behavior.** Interaction, layout, timing and motion changes
  are verified in a real browser (Playwright).
- **The app state is MUTATED IN PLACE** (`updateState` publishes the same object again). Derive from it in
  the render body; never `memo()` a component that takes store objects, and never put one in a dependency
  array expecting it to change (use primitives read from it, or `useStoreVersion`). Everything under
  `useAppState()` re-renders on every store write — once per streamed token — so keep it cheap or cached.
- **A function sees the render that created it.** Whatever runs LATER (after an `await`, in a timer, in a
  listener registered once) reads through a ref (`useLatest`) and writes with a functional update.
- **An exit transition needs `<Presence>` in the PARENT** (`lib/presence.tsx`); every `<Modal>` is rendered
  inside one, with a `key`. Without it the element is simply gone, with no motion.
- **Component styles are `X.css`, scoped by hand:** the `cmp-<name>` class on every root the component
  renders, `:is(.cmp-x, .cmp-x *)` on each selector, and `:where(:not(.html-container *))` wherever the
  component renders sanitized HTML (a scoped rule must not dress author-written HTML as app UI).
- **A portal's events bubble through the REACT tree**, not the DOM: a container handler above a portaled
  child (a dialog, the fullscreen stage) guards with `currentTarget.contains(target)`.
- **A render error unmounts the whole tree.** Keep `ViewBoundary` around the active view and `AppBoundary`
  around the app (`components/ErrorBoundary.tsx`) — without them one bad row is a blank page.
- **Motion is the app's own setting (움직임 줄이기), never the OS's.** No `prefers-reduced-motion` media
  query anywhere in the client (a test fails on one): CSS keys on `:root[data-motion="reduce"]`, JS on
  `prefersReducedMotion()`; no native smooth scroll (`scrollToStart`). Details in `client.md`.
- **Selective motion is gated INSIDE the transition/animation function**, on non-reactive state read when it
  starts. Details in `client.md`.
- **A status indicator that only STATES a problem is a dead end — make it the way to the fix.** Actionable
  states are buttons; each state carries its own TEXT, not just a colour; a gated button makes its
  prerequisite its first step. Cross-view deep links ride a one-shot flag in `lib/state.ts`, not a router
  param.
- **Multi-tab views keep children ALWAYS-MOUNTED with an `active` prop**, never `{tab === "x" && <Child />}`
  — unmounting loses unsaved form state. Preserve the settings cards' in-place (no-reload) saves for the
  same reason.
