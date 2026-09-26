# tests — Claude notes

~38 vitest files by area (`agent-*`, `client-*`, `svelte-*`, `store`, `infra`, `app`, `routes-*`,
`chat-*`, `external-agent*`, `group-agent`) plus `helpers.ts`, `setup-dom.ts`, and Playwright
`visual/*.spec.ts`. Verification gate + one-file recipe live in the root
**[`CLAUDE.md`](../CLAUDE.md)** §Verification gate.

Non-obvious infrastructure constraints:

- **The vitest PROJECT a file lands in is decided purely by FILENAME.** `tests/svelte-*.test.ts` →
  `"components"` project (jsdom + Svelte plugins + `setupFiles: ["tests/setup-dom.ts"]`); everything else
  `*.test.ts` → `"unit"` project (node env, no DOM, no Svelte transform). A Svelte-mounting test WITHOUT the
  `svelte-` prefix lands in `unit`, where `document`/`window` are absent and `.svelte` imports don't even
  transform — it fails loudly. New component test → name it `svelte-*`.
- **`helpers.ts` wires up NOTHING itself** — no shared "boot the app" helper, no mocking utility. Every
  export is a thin real primitive (supertest wrapper, SSE frame parser, temp-dir registrar, git/plugin/
  marketplace fixture builders, `callTool` MCP invoker, stdio JSON-RPC client). Each file builds its OWN
  `createServices`+`createApp`, and mocks the SDK with its own `vi.mock("../src/server/agent/index.js")`
  via `vi.hoisted` when it needs deterministic agent output.
- **`callTool(tool, args)` calls `tool.handler(args, {})` DIRECTLY — it bypasses the SDK's zod validation.**
  So a tool's `z.string().max(N)` / `.min()` schema bound is NOT exercised by `callTool`; only runtime
  checks inside the handler are. Assert schema caps against `tool.inputSchema` if you need them covered.
- **`withTempDir(label, onSetup?)` registers `beforeEach`/`afterEach` — call it at module/describe scope,
  never inside an `it()`.** Its returned accessor is `undefined` until the first `beforeEach` fires; the
  `let tempDir; const getTempDir = withTempDir(label, () => { tempDir = getTempDir(); })` idiom captures the
  fresh real OS temp dir (`fs.mkdtempSync`, cleaned per-test) at the right time.
- **`setup-dom.ts` polyfills exactly two jsdom gaps** Svelte 5 needs: `Element.prototype.animate` (transition
  directives) and `ResizeObserver` (the transcript's autoscroll controller). Both are safe only because jsdom
  layout never changes; real timing/layout behavior is covered ONLY by the Playwright visual suite.
- **`pretest` (`npm run build:client -- --mode test`) runs only through `npm test`, NOT `npx vitest`.** A red
  `npm test` with ZERO test output almost always means the CLIENT BUILD broke (a Svelte/TS error aborts
  before any test runs), not a test failure. No test reads `dist/client`.
- **Visual tests are never touched by `npm test`** — both vitest projects only `include` `*.test.ts`, and
  visual specs are `*.spec.ts`. They run only via `node tests/run-visual.mjs` (`npm run test:visual`), which
  starts its own Vite dev server on `127.0.0.1:5173` (`strictPort`) — so it fails if 5173 is occupied, and
  `npx playwright test` run directly (skipping the script) connection-refuses. See the memory note on the
  `.bin` symlink quirk.
- **The deck converter's toolchain e2e suites are OPT-IN** (`deck-converter.test.ts`, `deck-contract.test.ts`):
  they run only with `NOAH_PPTX_E2E=1` AND a converter probe that says installed — a Python with the pinned
  set (`NOAH_PPTX_PYTHON=<venv python>`, from `default-skills/skills/pptx/converter/requirements.txt`) and a
  resolvable Chromium (`NOAH_PPTX_DEV=1` accepts Playwright's cached one on a dev box). Everywhere else they
  SKIP, so a green `npm test` proves nothing about conversion itself; only their toolchain-free parts (the
  CLI contract, caps, locks and static greps; the committed converter fixture through the server loader, the
  real probe's JSON through the server parser, the describe_system markers vs SKILL.md, the `--help` docs block)
  and the static `deck-packaging.test.ts` always run. Recipe: `docs/architecture/build-run-verify.md` §Deck
  converter.
- **Coverage thresholds are a single global gate under `--coverage` only** (`test:coverage`). An all-green
  test list with a failing `test:coverage` is a threshold miss, not flakiness — the floor is set "a hair
  under" achieved coverage and is meant to rise, never fall.
- **Intended CONTRACT changes update their pinned tests; behavior regressions do not.** Prompt/tool-text
  tests assert with `toContain`/`not.toContain` substrings (adding a section is safe; changing an existing
  string breaks a pin) — see `agent-core.test.ts`. When a fix deliberately changes a route's status/shape,
  update the pin and say so; never loosen a test to hide a regression.
