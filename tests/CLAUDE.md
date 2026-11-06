# tests — Claude notes

vitest files by area (`agent-*`, `pi-*`, `client-*`, `svelte-*`, `store`, `infra`, `app`, `routes-*`,
`chat-*`, `retire-*`, …) plus `helpers.ts`, `setup-dom.ts`, and Playwright `visual/*.spec.ts`. Gate and the
one-file recipe: root [`CLAUDE.md`](../CLAUDE.md) "Verification gate"; detail in
[`docs/architecture/build-run-verify.md`](../docs/architecture/build-run-verify.md).

- **The vitest project is chosen by FILENAME.** `svelte-*.test.ts` → `components` (jsdom + Svelte); every
  other `*.test.ts` → `unit` (node, no DOM, no Svelte transform). A new component test must be `svelte-*`.
- **`helpers.ts` wires up nothing** — thin real primitives only. Each file builds its own
  `createServices`+`createApp` and mocks the agent runtime itself (`vi.mock` of `agent/index.js`, or
  `AGENT_RUNTIME=local`); the pi runner is tested against a scripted fake, the real gateway only under
  `PI_E2E_LIVE=1`.
- **`callTool` bypasses zod validation** (calls the handler directly), so schema bounds are not exercised —
  assert them against `tool.inputSchema`.
- **`withTempDir` registers hooks — call it at module/describe scope**, never inside `it()`; its accessor is
  `undefined` until the first `beforeEach`.
- **jsdom never lays out.** `setup-dom.ts` polyfills only what Svelte 5 needs to run; real timing/layout is
  covered ONLY by the Playwright visual suite.
- **`pretest` builds the client and runs only via `npm test`.** A red `npm test` with zero test output is
  almost always a broken client build, not a failing test.
- **Visual specs never run under `npm test`** — only `npm run test:visual` (`tests/run-visual.mjs`), which
  needs port 5173 free.
- **Deck converter e2e suites are OPT-IN** (`NOAH_PPTX_E2E=1` + an installed toolchain); elsewhere they skip,
  so a green `npm test` proves nothing about conversion. Recipe: `build-run-verify.md` "Deck converter".
- **Coverage thresholds gate only `test:coverage`**; a miss there is a threshold miss, not flakiness — the
  floor only ever rises.
- **Intended CONTRACT changes update their pinned tests; regressions do not.** Prompt/tool-text pins are
  substrings. When a fix deliberately changes a route's status/shape, update the pin and say so; never
  loosen a test to hide a regression.
