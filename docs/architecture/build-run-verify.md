# Build, run, verify

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Dev servers, the verification gate, Docker/TLS/CA, release mechanics, and the deck converter's dev
> setup, opt-in suites and Docker smoke.

- `npm run dev` — `concurrently` runs `dev:server` (tsx watch, port 48787) + `dev:client`
  (vite, port 5173, proxies `/api`,`/users`,`/fonts` → 48787).
- `npm run lint && npm test && npm run build` — standard verification gate. `lint` =
  `tsc --noEmit` (server) **+ `tsc -p tsconfig.client.json --noEmit`** (client; `svelte-check` went with the
  Svelte app on 2026-11-12); `build` = server tsc + `vite build`
  (→ `dist/client`); `pretest` runs `vite build --mode test`, so a client compile break fails
  the test gate.
- **Client checks (run these directly):** `npx tsc --noEmit` and
  `npx tsc -p tsconfig.client.json --noEmit`. ⚠️ The rtk hook misrewrites
  `npm run lint` to eslint and fails — don't rely on it; run the two commands above. `npm run
  build:client` (vite) / `npm run lint:client` (the client `tsc`) also work. `tsconfig.client.json`
  pulls in `src/server/types.ts` + `routineSchedule.ts` so the client shares server types via
  the `src/client/src/lib/types.ts` re-export barrel — import server types through it.
- **The client is React 19 since 2026-11-12** (`@vitejs/plugin-react`; Svelte and its tooling are gone —
  [`client.md`](client.md)). The plugin's dev-server Fast Refresh preamble is normally an INLINE `<script>`,
  which the app's CSP (`script-src 'self'`) blocks, so `vite.config.ts` drops that HTML injection and
  `main.tsx` imports the same preamble as a module (`@vitejs/plugin-react/preamble`, empty in a production
  build). Production bundle after the move (gzip): the entry chunk grew from ~74 kB to ~136 kB (the React
  runtime), the per-view chunks shrank (ChatView ~49 → ~40 kB), total JS is about the same.
- `rtk proxy npx vitest run tests/<file>.test.ts` — run ONE test file (full suite is ~16s); see
  "Tests" below for the layout.
- `docker compose config` — validate compose/env wiring before Docker changes. The stack INCLUDES
  pi-gateway's compose from `${PI_GATEWAY_DIR:-./vendor/pi-gateway}` (the submodule; README "Deployment"), so
  `config` needs it checked out (`git submodule update --init`), a Noah `.env`
  (the `env_file` must exist) and pi's required vars (`PI_GATEWAY_HOME`, `DOCKER_GID`). Run it from a scratch
  COPY of the compose files (`docker-compose.yml`, `docker/`), never against the repo's real `.env`.
  `config` has no daemon side effects; `build`/`up` do — see "Combined-stack boot test" below.
- `CA_CERT_FILE=docker/tls-fullchain.crt docker compose build` — build with a local on-prem CA file.
- **Release = version bump + tag + GitHub release** (since v1.0.0, 2026-07-29; the full procedure
  is encoded as the project **`/release` skill** in `.claude/skills/release/SKILL.md` — keep the two
  in sync; user-facing patch notes (what's-new entry + GitHub notes) require the user's explicit
  sign-off before commit/publish):
  `npm version <x.y.z> --no-git-tag-version` (package.json + lock), commit `chore(release): vX.Y.Z`,
  push main, `gh release create vX.Y.Z --target main --title "Noah Almighty vX.Y.Z" --notes-file <f>`
  (gh is authed on this box; origin = github.com/JinY0ung-Shin/noah-almighty). App semver is
  INDEPENDENT of the what's-new registry (`releaseNotes.ts` keeps date-based ids) — prepend a registry
  entry for user-visible changes either way. The `version: "0.1.0"` strings in the in-process MCP
  servers (`agent/*Tools.ts`) are MCP protocol metadata, NOT the app version — don't bump them.
  **Every release must also attach the two browser-extension assets** (`noah-browser-bridge.crx` +
  `updates.xml`, built by
  `BROWSER_EXTENSION_KEY_FILE=… npm run build:extension-update -- --tag vX.Y.Z`): the enterprise
  policy reads `releases/latest/download/…`, so a release without them breaks the update check for
  the whole fleet. See [`browser-bridge/extension.md`](browser-bridge/extension.md).

- **Dev box ≠ deploy target.** Coding happens on a WSL2 box; deployment is a separate internal corporate server
  (no local DB, `localhost` is not the deploy env). Any schema / UID / volume / `SESSION_SECRET` change needs an
  EXISTING-deployment migration path, not just fresh-install behavior.
- **Release notes never advertise macOS** — the user fleet is Windows/Linux only
  ([`browser-bridge/extension.md`](browser-bridge/extension.md)).

## Tests
- **Layout:** ~170 vitest files in `tests/`, named by area (`agent-*`, `pi-*`, `client-*`, `react-*`, `browser-*`,
  `deck-*`, `share-*`, `routes-*`, `chat-*`, `retire-*`, `store`, `infra`, `app`, …) plus `helpers.ts`,
  `setup-dom.ts`, `setup-react.ts` and the Playwright `visual/*.spec.ts`.
- **The vitest project is chosen purely by FILENAME.** `tests/react-*.test.tsx` → `react` (jsdom +
  `@vitejs/plugin-react` + `@testing-library/react`, `setupFiles: ["tests/setup-dom.ts",
  "tests/setup-react.ts"]`); every `tests/**/*.test.ts` → `unit` (node, no DOM, no JSX transform; client-lib
  tests are `client-*.test.ts` with per-file jsdom pragmas). The same glob routes the typecheck: `react-*.test.tsx`
  and `client-*.test.ts` are in `tsconfig.client.json`'s `include` and out of the root NodeNext program.
  ⚠️ A component test named `*.test.tsx` WITHOUT the `react-` prefix matches NEITHER project and neither
  tsconfig — it is silently never run nor typechecked. (`setup-react.ts` registers Testing Library's `cleanup`
  by hand: vitest runs without globals, so RTL's automatic `afterEach` never installs.)
- **Two React-test gotchas.** RTL's `waitFor`/`findBy*` do not advance under vitest FAKE timers (their
  wrapper waits on a real `setTimeout(0)` and finds no `jest` global) — use `act` +
  `vi.advanceTimersByTimeAsync`. jsdom does not reflect React's `inert` attribute as a property — assert
  `hasAttribute("inert")`. A store write made while a component is mounted goes inside `act`.
- **`helpers.ts` wires up NOTHING itself** — thin real primitives (supertest wrapper, SSE frame parser, temp-dir
  registrar, git/plugin/marketplace fixture builders, `callTool`, stdio JSON-RPC client). Each file builds its OWN
  `createServices`+`createApp` and mocks the runtime itself (`vi.mock("../src/server/agent/index.js")` via
  `vi.hoisted`, or `AGENT_RUNTIME=local`); the pi runner runs against a scripted fake in `pi-runner.test.ts`, the
  real gateway only under `PI_E2E_LIVE=1`.
- **`callTool(tools, name, args)` finds the tool and calls its `handler(args, {})` DIRECTLY**, bypassing the server's zod validation, so a
  schema bound (`.max(N)`/`.min()`) is not exercised — assert it against `tool.inputSchema`.
- **`withTempDir(label, onSetup?)` registers `beforeEach`/`afterEach`** — call it at module/describe scope, never
  inside `it()`. Its accessor is `undefined` until the first `beforeEach`; the
  `let tempDir; const get = withTempDir(label, () => { tempDir = get(); })` idiom captures the fresh
  `fs.mkdtempSync` dir (cleaned per test).
- **`setup-dom.ts` polyfills exactly three jsdom gaps** the client needs: `Element.prototype.animate`
  (`lib/transition.ts` `runTransition` plays every enter/exit transition through Web Animations — a zero-time
  stand-in whose `onfinish` fires on a microtask), `Element.prototype.getAnimations` (the 할 일 card's
  hand-written FLIP in `TodoOverlay.tsx` asks a leaving row for its running animations before it holds it)
  and `ResizeObserver` (the transcript's autoscroll controller) — safe only because jsdom never lays out; real
  timing/layout is covered ONLY by the Playwright visual suite.
- **`pretest` (`npm run build:client -- --mode test`) runs only through `npm test`, not `npx vitest`.** A red
  `npm test` with ZERO test output almost always means the CLIENT BUILD broke. No test reads `dist/client`.
- **Visual specs never run under `npm test`** (the two projects include only `*.test.ts` / `react-*.test.tsx`). They run via
  `npm run test:visual` (`tests/run-visual.mjs`), which starts its own Vite on `127.0.0.1:5173` with
  `strictPort` — it fails if 5173 is taken, and a bare `npx playwright test` connection-refuses.
- **Coverage thresholds are ONE global gate under `--coverage` only** (`test:coverage`). A green list with a red
  `test:coverage` is a threshold miss, not flakiness; the floor sits a hair under achieved coverage and only rises.
- **Intended CONTRACT changes update their pinned tests; regressions do not.** Prompt/tool-text pins are
  `toContain`/`not.toContain` substrings (`agent-core.test.ts`): adding a section is safe, changing an existing
  string breaks a pin. When a fix deliberately changes a route's status/shape, update the pin and say so; never
  loosen a test to hide a regression.

## Verifying the running app / UI
- Verifying the local server: WHEN a corporate `HTTP_PROXY` is set it intercepts `localhost`
  (returns "Access Denied") — hit the dev server with `curl --noproxy '*' localhost:<port>/...`.
  But the proxy is NOT always present (check `env | grep -i proxy`); with no proxy you CAN install
  a browser engine and runtime-verify isolated UI (Playwright fixture — see
  [`client.md`](client.md) §Client verification).
- Running the FULL app here is impractical (it talks to a separate deployment, no local DB) — so
  feature-level changes ride on the typecheck + careful reading + the parity references (`f0a6128` for
  the vanilla frontend, `18e98d7` for the Svelte app — the last commit that has it) + a human browser smoke
  test.
- For visual/layout bugs, inspect the *rendered* state (screenshot + DevTools computed styles),
  don't reason from CSS source alone — collisions/inherited rules aren't visible in the source.

## The `local` stub as a scripted demo (`AGENT_RUNTIME=local`)
The only real runtime is pi-gateway, which this workstation cannot reach, so nothing that needs a run (thinking
card, tool rows, canvases, inline UI, mid-turn messages) could be SEEN here. The stub
(`agent/localRunner.ts`, scenario data in `agent/localScenarios.ts`) therefore replays scripted runs through the
run's `AgentEvents`, in the order and shapes `pi/runPiAgent.ts` + `pi/eventAdapter.ts` produce them. It runs no
model, tool or plugin, uses no network, writes no file and has no randomness.

- **Entry points.** `runAgentStream` calls `runLocalAgentStream(request, events, abortController, deps?)`;
  `runLocalAgent(request)` is the event-less response (echo, the listing, a submission echo — a scenario only
  says it needs the event stream). `deps.sleep` is the injectable wait: `tests/agent-local-runner.test.ts` passes
  an immediate one, so no test sleeps. To watch it: `AGENT_RUNTIME=local npm run dev`, open a chat with your own
  avatar and type `demo`.
- **The echo is unchanged.** Any message that is not EXACTLY `demo` / `demo <name>` (case-insensitive, one line)
  answers `[local] <message>` with one status label and 40-codepoint deltas, no delay — what `app.test.ts` and the
  e2e harness pin. Commands are plain words on purpose: a `/`-leading message is expanded by the chat route.
- **Scenarios** (`demo` alone lists them in Korean; text the stub prints is user-facing, so Korean):

  | Command | What it emits, in order |
  | --- | --- |
  | `demo text` | `onStatus` → `onDelta`×N (6 codepoints / 20 ms): headings, lists, a table, fenced code, a 130-char unbroken token, mixed Korean/English → `onTurnResult{steerPending:false}` |
  | `demo thinking` | `onThinking`×N, then `onDelta`×N — never interleaved |
  | `demo tools` | thinking → narration → `onToolStart`/`onToolEnd` for `LS`, `Read`, `Grep` → narration → `Bash` + `Glob` started together (`Bash` ends `ok:false`) → `Edit`, `mcp__skills__read` → the answer. Each start also sets the `실행 중: <label>` status. The two narration blocks are demoted with `onTextFold` at the first delta of the next block, as the adapter does |
  | `demo canvas` | six `mcp__canvas__show` rows, each `onToolStart` → `onCanvas` → `onToolEnd`: markdown (`editable`), a mermaid chart (`xychart-beta`), a mermaid flow, svg, html, and a markdown with seven `controls` (`interaction: "async"`) |
  | `demo ui` | an ANSWER that holds inline UI, streamed like `demo text` (`onDelta`×N, no tool row, no canvas event): Markdown, a calculator (`{@state}`, sliders, `<button send>`, `<submit>`), a dashboard (stat cards, a bar and a donut `<chart>` in the simple form), tabs with a sortable table, and a fenced tag that must stay source |
  | `demo error` | thinking + a partial answer, then throws `PiTurnFailedError("server_error")` (status 502) — the route keeps the partial and appends its "try another model" notice |
  | `demo long` | 30 lines, one every 600 ms (≈18 s) — for 중지 and mid-turn messages |
  | `demo attachments` | for each image ATTACHED to that message (`request.imageFiles`, the staged workspace copies): a `mcp__file_output__show_file` row around `onFile`, the returned card stamped with its text anchor. No image attached → it asks for one |

- **Canvas submission echo.** A turn whose agent message is the one the route builds for `canvasSubmission`
  (`On the canvas "<title>" (id: …), The user responded on the canvas:` + `- key: value` lines, and/or
  `The user edited the canvas … content to:`) answers with the received values as a table, so the round trip of a
  controls form or an `editable` canvas is visible. (An inline UI `<submit>` is an ordinary user message: the
  stub echoes it like any other text.)
- **Canvases go straight to the events sink** (`events.onCanvas`, the request shape `canvasTools.ts` emits —
  the test feeds every demo canvas to the REAL tool and compares).
  Artifact ids are `local-demo-<conversationId>-<name>`: a repeated demo refines the same canvases in place.
- **`demo ui` is only text.** Inline UI has no server step, so the scenario is an answer and nothing else; each
  UI block and the whole answer pass the shared static check in `tests/agent-local-runner.test.ts`, and
  `tests/visual/inline-ui.spec.ts` streams the same answer through the real client.
- **중지** — every wait and every emit checks the run's abort signal and throws `PiGatewayError("aborted")`, the real
  runner's error; the route's cancel path keeps the partial.
- **Mid-turn messages** use the one inbound channel (`events.steers`) with the real runner's two paths: a message
  queued at a step boundary is delivered into the running turn (`noteLifecycle(id, "started")` — a block boundary,
  so the text before it is folded — and acknowledged in the stream); one still queued when the turn ends, or
  starting with `/`, becomes ONE follow-up turn (`noteResultBoundary` → `onTurnResult{steerPending:true}` →
  delivered → the follow-up text → the final `onTurnResult`). The channel is closed on every exit.
- **Not mirrored:** no pi session exists, so `onModel`, `onSessionId`, `onResumePoint` and `usage` never appear
  (the context badge, resume and exact rewind stay pi-only). **Not driven:** the 할 일 card (it is drawn from
  `store/todos.ts` rows re-read when an `mcp__todo__*` row ends; the stub gets no store and must not write the
  owner's list), download cards (`onShareFile` needs a document file and the stub writes none), AskUserQuestion,
  subagent cards, team-brain cards, 기억 rows, compaction and the browser bridge.
- **Reachability.** Only `runAgentStream`'s `config.agentRuntime === "local"` branch calls the stub, and
  `parseRuntime` (`config.ts`) accepts `pi` | `local` only — a deployment on pi cannot reach any of it.

## Docker
- **Layer order is the build-speed contract.** Slow, rarely-changing steps sit ABOVE the app
  `COPY`: apt (+ its soffice/pdftoppm/python self-check) → CA → hex-ssh → `npm install` → deck-font
  registration (`COPY` of the pptx skill tree + `fc-cache`; inputs = that tree + `docker/fontconfig`) →
  `COPY --exclude=default-skills/skills/pptx . .` → `npm run build` (~6 s). A step whose inputs are the
  pptx skill, dependencies or pinned tools must not move below that final `COPY`, or every code change
  re-runs it. apt/npm/node-gyp downloads ride `RUN --mount=type=cache` (never in a layer). Keep the
  Dockerfile free of a `# syntax=` line — it pulls the frontend from Docker Hub, unreachable on the closed
  deploy network; the built-in frontend (Docker 23+) already supports `--mount` and `COPY --exclude`.
  `.dockerignore` keeps `docs/`, `tests/` and `docker/tls/` (deploy-host TLS keys — bind-mounted, never
  baked) out; `docker/pi/` must stay IN (the `pi-setup` service runs `docker/pi/pi-setup.sh` from the image).
- **No agent runs in the Noah image** (pi-gateway runs every turn): no Chromium, pip set, uv, ripgrep or
  converter self-test there — those live in the deck sandbox image (`docker/pi-sandbox`, its own
  `verify.sh`). `tests/deck-packaging.test.ts` pins both halves.
- **The stack is one compose project with pi-gateway's services included** (`include:` +
  `docker/pi/compose.override.yml`; `tests/infra-compose.test.ts` pins it). Two compose facts it relies on,
  both verified with `docker compose config`: (1) the INCLUDING project's `.env`/shell wins over the included
  project's `.env` inside the included file — hence the shared-keys list in `.env.example`; (2) a service of
  the same name in a later `-f` file MERGES into the included one silently — never reuse a pi service name
  (`gateway`, `sandboxd`, `mcp-broker`, `egress-proxy`, `sandbox-image`) in an overlay.
- **Combined-stack boot test — in a private dind, not on the host daemon** (the host runs the user's own dev
  pi-gateway — the bundled stack from this checkout, or a standalone one, ONE per daemon: a second sandboxd
  adopts/removes its sandboxes and the egress socket volume name is fixed). Use a private
  privileged `docker:29-dind` on its own network, the way the 2026-10-29 verification did:
  `docker network create --subnet 10.217.0.0/24 noahcompose-net`, `docker run -d --name noahcompose-dind
  --privileged --network noahcompose-net -e DOCKER_TLS_CERTDIR= -v <dir>:<dir> docker:29-dind dockerd
  --host=unix:///var/run/docker.sock --default-address-pool base=10.218.0.0/16,size=24`, with `<dir>` holding a
  `git archive` of HEAD + the working compose files, a pi-gateway export at the pin, a `home/` (workspaces 0700,
  plugins 0777) and `secrets/` made by hand (files 0444 so uid 10001 reads them without root; Noah's copy 0400),
  `DOCKER_GID` = the dind socket's gid. The dind image lacks bash/curl: `apk add bash curl` first (setup-host.sh
  is bash). Then inside it `docker compose build` (~10 min cold) and `up -d`, and
  check: `pi-setup` logs one `PUT` per server then `ok … (unchanged)` on a re-run; `/api/bootstrap` answers;
  from `mcp-broker` `POST http://noah-almighty:48787/mcp/repo` → **401**, from `gateway` and from the published
  port → **403**; Noah `GET http://gateway:8080/v1/models` with the mounted key → 200; the `/admin` proxy (Noah's
  copy of pi's admin key, `secrets/noah/pi_gateway_admin_api_key` 0400) → `GET /admin/api/session` as a Noah admin
  200 `{authenticated:true}`, anonymous **403** `noah_session_required` (never 401: pi's UI would answer that with
  its own key login form), `/admin/` serves pi's UI with pi's CSP (a scripted MUTATING `/admin/api` call must send
  the panel's `Origin`, `Referer: …/admin/`, `Sec-Fetch-Site: same-origin` and `X-Admin-Request: 1`, else 403
  `csrf` — intended); and pi's
  `scripts/security-check/run.mjs` (run in `sandboxd`, `--internal noah-almighty:48787` plus each Noah IP; its rootfs
  is read-only, so pipe the script instead of `docker cp`: `docker compose exec -T sandboxd node --input-type=module
  - <args> < vendor/pi-gateway/scripts/security-check/run.mjs`) →
  all PASS, sandboxes `noah-almighty/pi-sandbox:latest` with network `none`. **Existing-volume ownership (#79):**
  `docker compose stop noah-almighty`, `chown 0:0` the volume root via `docker compose run --rm --no-deps --user
  0:0 --entrypoint sh noah-almighty -c 'chown 0:0 /app/data'` → `setup-host.sh` fails with `error: volume … root
  is uid 0`, `up -d` leaves Noah restarting with one fatal `data directory /app/data is not writable` log; the
  README "Data volume ownership" repair → `setup-host.sh` `ok`, Noah healthy, `backups/` created when retired
  data is present. Tear the dind and its volume down
  afterwards; leave `noahpi-dind` (the pi e2e instance) alone.
  **Recipe notes from the 2026-11-11 runs (pi `100a63d`, then `7e8e3d6` — the pin that was committed; all
  checks PASS; scripts, a one-shot `run-all.sh` and evidence in `~/.noah-work/boot-test-2026-11-11b/`):** give the dind a NAMED volume and a fixed address (`-v
  noahcompose-dind-data:/var/lib/docker --ip 10.217.0.2`) — without `-v` the volume is anonymous and "tear the
  volume down" needs `docker rm -v`, and the published port is reached from the host at the dind's network
  IP; `home/` and `secrets/` need not be made by hand — `bash docker/pi/setup-host.sh </dev/null` inside the
  dind creates them (close stdin: pi's setup-host asks for a git token with `read`; it also PRINTS the new
  admin/api keys, so filter a saved log; what it creates is owned by root/10001, so clean up inside the dind);
  a cold build took 188 s on this box, not ~10 min; `~/.noah-work/pi-e2e/` (RUNBOOK, build-images.sh,
  compose.override.yml) is for the STANDALONE pi e2e instance — only `fake-llm.mjs` is reusable here, with
  `--host 0.0.0.0`; registering the fake LLM with `PUT /admin/api/llm` needs only `defaultModel` — with no
  `falcon` tier an owner turn runs on pi's default model (checked); `security-check/run.mjs --internal …`
  REPLACES pi's default internal targets (gateway/sandboxd/mcp-broker), so run it once more without
  arguments; a mutating `/admin/api` call needs `X-Admin-Request: 1` plus same-origin evidence
  (`Sec-Fetch-Site: same-origin` or Noah's own `Origin`) — `Referer` may be absent, but if present must be
  under `/admin`. **Per-bump model-driven checks worth repeating** (scripts `30-`…`40-` there): a document
  turn (`files` → `/workspace/uploads/<name>` byte-identical in the OWNER's sandbox, pi's `[Attached file: …]`
  markers plus Noah's preamble line in the model's request, the colleague refusal, a regenerate re-sending),
  the tool list (`Agent`/`SendMessage` present), a scripted `Agent` call (Noah's SSE frames are `agent` …
  `agent_end`, nested tools carry the `agentId`), the same-origin gate with and without `TRUSTED_ORIGINS`, and —
  when pi's System One (the optional `mcp_search` decision model) matters — that `mcp_search` returns Noah
  tools in the model's order, falls back to BM25 when it is removed or fails, and that
  `/admin/api/systemone/calls` is admin-only through Noah's proxy. **Since pi `8930c49` (tracing)** the stack
  has a sixth pi service, `jaeger`: check that it is up on `control` only with no published port, that a turn
  leaves a trace (`GET /admin/api/history/<session>/traces` through Noah's proxy as an admin; a member gets
  403), that the trace JSON contains NO text of the prompt or of a tool's arguments (send a unique marker and
  grep for it), that neither the Noah container nor a sandbox can reach `jaeger:16686`/`:4318`, and that
  `NOAH_PI_JAEGER_IMAGE` really swaps the image (retag it inside the dind and point the variable there).
  Run 2026-11-11 at `8930c49` (`~/.noah-work/boot-test-2026-11-11c/`, scripts `70-`…`74-`): all PASS, and
  it showed: `docker ps` lists the image's EXPOSEd ports for `jaeger` WITHOUT a mapping (`->`) — judge by
  `PortBindings` being empty, not by an empty column; turns made while `jaeger` is stopped complete normally
  but their traces are LOST and no service logs an export warning (the traces route answers 503
  `trace_store_unavailable`), so a dead trace store is not visible in the logs; Jaeger itself logs a steady
  `[::1]:4317 connection refused` warning (its self-telemetry, a pi-side config gap — bounded by log
  rotation); changing `NOAH_PI_JAEGER_IMAGE` in `.env` also recreates the Noah container (the whole `.env` is
  its `env_file`); pi's security-check has no jaeger target unless given `--internal jaeger:4318 --internal
  jaeger:16686`. Footprint after 60 traces / 432 spans: 36 MiB RSS, 1.5 MB on `jaeger-data` (the 7-day TTL and
  growth under real load were not measured). Finding a conversation's trace: pi's session id is not Noah's
  conversation id — `messages.sdk_session_id` holds `resp_<pi session uuid>_<turn>`, and
  `GET /admin/api/history?user=<Noah user id>` lists that user's pi sessions.
  **pi `939f064` (2026-11-11, admin UI restyle + the Pretendard font — a UI-only bump):** `run-all.sh` all
  PASS (`~/.noah-work/boot-test-2026-11-11d/`; the tracing scripts `70-`…`74-` were not re-run). pi's commit
  had only been looked at with mock data, so `25-admin-ui-real-gateway.mjs` there looks at it against the
  real gateway THROUGH Noah's `/admin` proxy (38/38): the three Pretendard woff2 (2.23 MiB; the "latin"
  files carry the whole Korean set) arrive as `font/woff2` for an admin and are a 302 for anyone else, pi's
  CSP (`default-src 'self'`) covers them, and all 12 pages render in headless Chromium, light and dark, with
  no page error, CSP violation or failed request, the font actually loaded, and no sideways page scroll at
  400px. Worth repeating whenever pi's UI changes. The admin-ui build now pulls `@fontsource/pretendard`
  from the npm registry — a deployment that builds behind an npm mirror needs that package there.
  **pi `359f1ba` (2026-11-13, the usage badge's context figure — `context_tokens` = the last call's input +
  output, and an honest figure right after a compaction):** `run-all.sh` all PASS on the fresh stack
  (`~/.noah-work/boot-test-2026-11-13/`; tracing scripts not re-run), plus `80-context-usage.mjs` there
  (19/19): an ordinary turn reports input + output; a turn whose usage crosses `window − 16,384` ends in pi's
  automatic compaction and a `/compact` compacts on demand, and in both the reported context matches
  `system + (usage before − system) × (conversation after ÷ before)` recomputed from what pi sent the fake
  LLM (within 0.1%); the next turn reports the model's real usage again. Notes for the next run: a
  compaction whose cut splits a turn asks the model TWICE (history, then the turn's head) — enqueue two
  summary turns, and tell summary requests apart by their empty `tools`; put the fake-LLM marker in EVERY
  user message (the one in a summarized message is gone afterwards); make the summarized part large (a
  cut keeps ~20,000 estimated tokens of the tail, so two ~130K-char answers summarize only the first).
  Re-running `run-all.sh` on a stack that already ran it fails ONE check by design (`30-documents`: "the
  owner's sandbox is the only one" — the first run's other sandboxes are still there).
  **pi `ad2d30f` (2026-11-13, the admin panel's 운영 → 실행 시간 page: statistics over the last 7 days' turns,
  up to 500, read from Jaeger on every open — `GET /admin/api/traces/stats`):** `run-all.sh` all PASS on a
  fresh stack (`~/.noah-work/boot-test-2026-11-13b/`), `70-tracing-static.sh` and `71-tracing-turn.mjs`
  (25/25 — the session traces route now filters on the turn span) re-run, and `75-trace-stats.mjs` there
  (30/30) is the look pi's commit did not take, through Noah's `/admin` proxy against the real gateway: an
  admin gets 200, a member and an anonymous caller 403; the turn count, the turn-time p50/p95 and the
  slowest turn equal what is recomputed from Jaeger's own answer; `mcp_call` is listed per real tool as
  `execute_tool mcp_call <server>/<tool>` (`todo/add_todos`); the answer holds pi session ids and nothing of
  the conversation (no marker of the prompt, command, result or MCP argument, no Noah user or conversation
  id); the read is an audit row `pi_admin_proxy` (`GET /admin/api/traces/stats`); with `jaeger` stopped it
  is `503 trace_store_unavailable` after ~10 s and the same turns are back once it starts.
  `25-admin-ui-real-gateway.mjs` with `timing` added (40/40): all 13 pages render, light and dark. Measured
  at the 500-turn cap (scripted turns of 6–7 spans each): 80–145 ms and ~2.2 KB per open — real turns carry
  more spans, so this is a floor, not the production figure. Note for the next run: a Node client that
  waits out a `compose stop` (10 s) meets Noah's closed keep-alive socket (`other side closed`) — retry once.
  **pi `fed9753` (2026-11-13, a fix to that page: a model's output speed is its output tokens ÷ its call
  time, no longer ÷ the time after the first token):** the bug was visible in the run above (the scripted
  model at 32,050 token/s). `run-all.sh` all PASS on a fresh stack (`~/.noah-work/boot-test-2026-11-13c/`),
  `71-tracing-turn.mjs` 25/25, `75-trace-stats.mjs` 31/31 — the new check recomputes the speed from Jaeger's
  raw `chat` spans (820 output tokens over 420 ms → 1,953 token/s, equal to the route's) — and
  `25-admin-ui-real-gateway.mjs` 42/42 (the page states how the speed is counted, light and dark).
  **pi `e0681aa` (2026-11-13, that page as charts: a turn-time trend over time from a new `timeline` in the
  statistics answer, a split bar for where the time went, bars in its three tables — pi's commit looked at it
  with MOCK data only):** `run-all.sh` all PASS on a fresh stack (`~/.noah-work/boot-test-2026-11-13d/`,
  one `drive.sh` for the whole run), `71-tracing-turn.mjs` 25/25, `75-trace-stats.mjs` 37/37 — the six new
  checks hold the timeline to the answer it rides in (a step pi offers, buckets on UTC boundaries of the step,
  ascending and contiguous, their turns adding up to the turn count, no bucket's p95 above the slowest turn) —
  and `25-admin-ui-real-gateway.mjs` 48/48: through Noah's `/admin` proxy against the real gateway the trend
  draws (two lines, a count bar per bucket), hovering a bucket puts its values in the legend line, light and
  dark, with no page error or CSP violation. NOT seen with real data: more than one bucket — the stack was
  minutes old, so all 19 turns fell into ONE 5-minute bucket (two dots, no line segment, no gap).
  **The same run is the first build of Noah's image with `libreoffice-writer`** and carries
  `85-workspace-files.mjs` (26/26), the 파일 tab against the real stack: the listing and the file route read the
  owner's sandbox workspace through the workspaces mount (`uploads/` holds the documents of the document
  turns; `c/` names all 14 conversations by title), and a pdf (3 pages), a pptx (3) and a **docx (1 — it could
  not load before this image)** render through `/api/me/workspace/preview` to PNG pages with a 1600 px long
  side in about a second each; a second ask is the cache; the pages are a 404 for another user and a 401
  without a session; nothing is left under `.work` and no soffice process stays. Notes for the next run: the
  dind's BusyBox `chown` has no `--reference` (use `chown "$(stat -c %u:%g dir)"`), and Noah's image has no
  `ps` (count `/proc/[0-9]*/comm`).
  **pi `5adb8e5` (2026-11-13, files in MCP tool results — a binary `resource` block is saved into the run's
  sandbox at `/workspace/artifacts/<pi session id>/<name>-<sha8><ext>`; the broker counts files apart, 28 MiB
  per result; pi's own tests saw only a FAKE sandbox):** `run-all.sh` all PASS on a fresh stack
  (`~/.noah-work/boot-test-2026-11-13e/`), `71-` 25/25, `75-` 37/37, `25-` 48/48, `85-` 26/26, and the new
  `86-mcp-files.mjs` 20/20 against a file-returning fixture MCP server registered in pi's broker
  (`06-mcp-fixture.sh`: a sibling container, `PUT /admin/api/mcp/servers/filefix` with pi's admin key): the
  model's tool result carries the path, size, sha256 and MIME and none of the base64; the file is byte-identical
  through the model's own shell, `docker exec` in the OWNER's sandbox container and the host workspace; the
  same file again is the same path, another conversation is another session folder; **a 28 MiB file goes
  through the real sandboxd in a 1.4 s turn** and 28 MiB + 1 byte comes back as a tool error naming the limit
  with nothing saved; a declared size or sha256 that differs is refused with the reason; a uri ending in
  `../../.home/.bashrc` lands as `artifact-<sha8>.bin` inside the folder; a colleague's chat (`read_only`) runs
  the tool and saves nothing; no `.part-` file is left; the gateway, broker and sandboxd logs carry no uri and
  no content. The 파일 tab lists `artifacts/` at the workspace root with one folder per pi session — the other
  conversations' folders show too — and downloads the file byte-identical. After the run: gateway 428 MiB,
  broker 277 MiB (one 28 MiB transfer at a time; several at once were not measured). Notes for the next run:
  the fake LLM routes by the FIRST `[[fake:KEY]]` marker of a request, so every turn of one conversation must
  reuse ONE key (a new key per turn silently gets the echo default — a 40 ms "turn" with no tool call); the
  sandbox writes files 0666 in 0777 folders (its umask), the workspace root above them stays 0700.
  **pi `89a69bd` (2026-11-14, workspace files as MCP tool arguments — a property a server marks
  `"x-workspace-file": true` is shown to the model as a `/workspace` path and filled by the gateway with
  `{filename, mimeType, size, sha256, data}`; the broker's request limit is 48 MiB; pi's own tests saw only a
  FAKE sandbox):** `run-all.sh` all PASS on a fresh stack (`~/.noah-work/boot-test-2026-11-14/`), `75-` 37/37,
  `25-` 48/48, `85-` 26/26, `86-mcp-files.mjs` 20/20, and the new `87-mcp-file-args.mjs` 19/19 against a
  `stage` tool added to the fixture MCP server (`06-mcp-fixture.sh`): `mcp_search` shows the argument as a
  path string; two files the model made in its sandbox (a binary with NULs, a csv under a relative path with a
  space) arrive with the bytes hashing to the sandbox's own `sha256sum` and name, MIME, size and checksum
  declared; **a 28 MiB file goes through the real sandboxd and broker in a 2.1 s turn**; 28 MiB plus one more
  file is refused with the limit named; a path outside `/workspace` (absolute, `..`, `/tmp`), a missing file,
  an empty one, an `.exe`, a directory, a symlink and a path THROUGH a symlinked folder are each refused with
  their own sentence, and a good file in the same call is not sent either (the tool is never called); a
  colleague's chat (`read_only`) is refused; the model's own requests and the gateway, broker and sandboxd
  logs carry the path, never the base64. This is also the first boot of the stack with the team brain's
  direct-write change (`e61ba4f`): Noah logged no error-level line (a fresh database — the queue-retirement
  step has nothing to close there, so the upgrade path itself was NOT exercised). `71-tracing-turn.mjs` was
  24/25 in the run and 25/25 alone afterwards: the one miss was Jaeger's own `@jaeger@warnings` span
  attribute ("clock skew adjustment disabled; not applying calculated delta of -33 ms") — a child span
  stamped a few ms before its parent, nothing pi wrote; a check that lists attribute keys should skip
  `@jaeger@*`. After the run: gateway 205 MiB, broker 195 MiB.
  **pi `08d35cb` (2026-11-14, plugin marketplaces — a refresh reinstalls the plugins that have a new version
  (its answer gains `updated`), and the gateway refreshes every marketplace once an hour; pi's tests drive the
  service in-process, and its commit looked at neither the panel's notice nor the running timer):**
  `run-all.sh` all PASS on a fresh stack (`~/.noah-work/boot-test-2026-11-14b/`), `71-` 25/25, `75-` 37/37,
  `25-` 48/48, `85-` 26/26, `86-` 20/20, `87-` 19/19, and the new `88-plugin-refresh.mjs` against a marketplace
  a fixture serves over smart HTTP (`07-git-fixture.sh`: `git http-backend` behind a small CGI server, a sibling
  container on the host's own pi gateway image — node, git and the backend in one image). Through Noah's
  `/admin` proxy: the marketplace is added and two plugins installed; a refresh with nothing new answers
  `updated: []` and reinstalls nothing; a version committed afterwards is unknown to the gateway until the
  refresh, which answers `updated: ["alpha@bootmk v1.1.0"]` and leaves the other plugin untouched; a member gets
  403; in a real browser the notice names the updated plugin and, for a plugin whose `plugin.json` cannot be
  read, says it is left as it was, with the reason — that plugin stays on its installed version with an
  업데이트 있음 badge and its skill stays readable; a conversation that began before the update is told the OLD
  skill description on its next turn, a new conversation the new one; every pressed refresh is a
  `pi_admin_proxy` audit row. 21/23 in the run: the two misses were the script asking for a skill by its bare
  name — pi lists a plugin's skill as `<plugin>:<skill>` (`alpha:alpha-skill`); asked again by that name, both
  answered. **NOT seen: the hourly timer.** `89-plugin-timer.mjs` there leaves a version unfetched and waits for
  the gateway's first tick, one hour after it starts; the run was stopped before the tick, so that the timer
  fires in the real gateway, and what it logs, still rest on pi's code and tests alone.
  **pi `92a69dd` (2026-11-14, pi's agent libraries 1.2.0 → 1.5.2 — `d2d6704`: pi-coding-agent, pi-agent-core,
  pi-ai, pi-mcp; tool arguments are now validated by pi-schema — plus two commits that change only pi's own
  docs; pi's commit ran its typecheck, vitest and Docker e2e and NO turn against an LLM):** `run-all.sh` all PASS
  on a fresh stack (`~/.noah-work/boot-test-2026-11-14c/`, Noah `cf5b2fa`; the gateway image holds all five
  `@earendil-works/pi-*` packages at 1.5.2), `71-` 25/25, `75-` 37/37, `25-` 48/48, `85-` 26/26, `86-` 20/20,
  `87-` 19/19, `88-` 23/23 (the script asks for a plugin's skill as `<plugin>:<skill>` now), no error-level line
  in the six services' logs at the end (Noah's begins at its last recreate by `40-same-origin.sh`), and four new
  looks. **(1) `90-pi-validation.mjs` 13/13** — scripted calls in
  ONE owner conversation, each answer read back from the model's next request. Converted and run:
  `mcp__system__list_recent_conversations {sinceHours: "24", limit: "3"}` answers its list, and
  `mcp__todo__add_todos {items: {title}}` (ONE object where an array is listed) adds the item. Refused by pi
  before Noah is called, as a tool result in a turn that completes: a missing required argument
  (`Validation failed for tool "mcp__todo__update_todo":` / `  - id: missing` / the received arguments /
  `Parameters of mcp__todo__update_todo: <the listed schema>`), a word for a number (`- sinceHours: expected
  integer, got string`), a value outside a listed enum (`- status: expected one of ["open",…]`), `bash {}`
  (`- command: missing`). Tool-call JSON that is cut off runs NOTHING: `bash` with
  `{"command":"echo …","timeout":` answers `Invalid arguments for tool "bash": Unexpected end of JSON input` and
  the echo never ran; an `mcp_call` cut after its first item added nothing. Passed through to Noah: an unknown
  argument name (`list_todos {state}` — Noah's own gate answers `Unknown argument name …; valid: …`). **Seen and
  NOT wanted: an array sent as a JSON STRING passes** — `tags: "[\"알파\",\"베타\"]"` is wrapped into a one-item
  array and the to-do is stored with the single tag `["알파","베타"]` (→ `pi-runtime.md` "Tool discovery").
  **(2) `91-validator-matrix.mjs`** — 18 argument cases through pi-ai's `validateToolArguments` with plain JSON
  schemas, in the OLD gateway image (the host's, pi-ai 1.2.0) and the new one (`docker run --rm -i --network none
  --entrypoint node -w /app pi-gateway/gateway:latest --input-type=module - < script`): 10 differ. Three in
  behaviour — one string or one object where an array is listed, and an array as a JSON string, were refused
  (`must be array`) and are now wrapped; seven in wording only (`must have required properties id` → `missing`,
  `must be integer` → `expected integer, got string`, `must be equal to one of the allowed values` → `expected
  one of [...]`, `must not have additional properties` → `unknown field`, `must be <= 5` → `expected <= 5`).
  Numeric strings, `"true"`, a number for a string and a dropped optional `null` were ALREADY converted by 1.2.0
  — for a tool's plain JSON schema that part of pi's commit message is not a change. **(3) the model's requests
  of `50-subagent.mjs`, diffed against the `…-14b` run:** 12 tool declarations (9 for a subagent), all identical
  — `Agent` included, as pi's commit says — except `grep`, whose `glob` is now described as "relative to path,
  e.g. '*.ts', 'src/**/*.ts' … A pattern without '/' matches file names at any depth"; the system prompt is the
  same length; pi's `user-agent` is `pi/1.5.2 (linux; node/v22.23.5; x64)` (was `pi (linux <kernel>; x64)`).
  **(4) `92-grep-glob.mjs` 3/5 — the two misses are a pi defect this bump makes visible:** the gateway runs
  ripgrep in the sandbox with the session's cwd, so a glob holding a `/` is matched against `/workspace`, not
  against `path`: with `path: /workspace/gv` both `sub/**/*.txt` and `sub/*.txt` answer `No matches found`
  (`gv/sub/*.txt` and `**/sub/*.txt` find the file; `*.txt` finds every depth; with no `path` the two coincide).
  The gateway's code did not change — the description that now offers `src/**/*.ts` did. To fix in pi
  (`apps/gateway/src/tools/grep.ts`), not here. **NOT seen:** the other fixes pi's commit names (no unpaired
  tool result after a cut-off answer is recovered; no cap on a summary's output) — they rest on pi's tests; what
  1.2.0 did with cut-off JSON through the stack (only 1.5.2 was booted; that it ran on the fields that arrived
  is pi's statement); any turn with a real model. After the run: gateway 216 MiB, broker 214 MiB. The fake LLM
  there takes `rawArguments` (argument text sent as is) for a tool call that is not whole JSON; once the stack
  is down, pi-ai's validator alone runs from npm (`npm i @earendil-works/pi-ai@<version>` in a scratch folder).
  **pi `cbbb1b7` (2026-11-14, the fix for that grep defect — the gateway runs ripgrep IN the searched directory
  and searches `.`, so a glob holding a `/` is relative to `path`, and a leading `./` on a glob is dropped; pi's
  commit tested it against a fake `rg` and never ran it in a container) — booted together with Noah `313f80b`
  (`unwrapStringList`; the canvas `contentType` without a listed enum):** `run-all.sh` all PASS on a fresh
  stack (`~/.noah-work/boot-test-2026-11-14d/`), `75-` 37/37, `25-` 48/48, `85-` 26/26, `86-` 20/20, `87-` 19/19,
  `88-` 23/23, no error-level line in the six services' logs at the end. **`92-grep-glob.mjs` 10/10** (the five
  checks that were 3/5, and five more) with the real `rg` in the owner's sandbox: with `path: /workspace/gv`,
  `sub/**/*.txt` finds the two files under `sub/` and `sub/*.txt` the one (both were `No matches found`),
  `./sub/*.txt` the same one, `!sub/**` the two files outside `sub/`, `*.txt` every depth; results are still
  named relative to `path` (`sub/b.txt:1: …`), a `path` that is ONE file answers by its file name, and with no
  `path` a glob written from `/workspace` works as before. The other side of the fix: a glob written from
  `/workspace` with a `path` elsewhere (`gv/sub/*.txt`), which used to match, now answers `No matches found` —
  what the description says. **`90-pi-validation.mjs` 22/22** — the 13 checks of the last run pass as before,
  and for `313f80b`: `add_todos` with `tags: "[\"알파\",\"베타\"]"` stores TWO tags (`#알파 #베타`;
  it was the one tag `["알파","베타"]`), `update_todo` with `tags: "[\"감마\",\"델타\"]"` replaces them with two,
  and ONE tag that only looks like a list (`tags: "[긴급]"`, wrapped by pi) stays the one tag `[긴급]`; through
  pi's `mcp_call`, `mcp__canvas__show` with `contentType: "widget"` answers `WIDGET_RETIRED_ERROR` and `"vega"`
  answers `VEGA_RETIRED_ERROR` (both equal to the constants, character for character — pi said `expected one
  of [...]` before), `"pdf"` answers `Unknown contentType 'pdf'. Use one of: 'markdown', 'mermaid', 'svg',
  'html'. Nothing was shown.`, `"markdown"` is shown, and `mcp_search` shows the argument as a plain string
  with the four values in its description and no `enum`. A LISTED enum is still pi's to refuse
  (`list_todos {status: "everything"}` → `status: expected one of [...]`). `71-tracing-turn.mjs` was 24/25 in
  the run and again alone — Jaeger's own `@jaeger@warnings` attribute once more (`clock skew adjustment
  disabled; not applying calculated delta of -36 ms`); the script there now lists `@jaeger@*` keys without
  judging them, as the note above asked, and is 25/25. **NOT seen:** the team brain's `personalNotes` /
  `conflicts` through the stack (the same helper; Noah's unit tests only); a `.gitignore`d or very large tree
  under the new cwd; any turn with a real model. After the run: gateway 226 MiB, broker 206 MiB.
  **pi `02a023e` (2026-11-14, the per-turn tool call limit — 200 in pi's code until now — is a setting on the
  panel's 기본 도구 page, 1–10000, kept in pi's DB and read when a turn or a subagent call starts; `GET
  /admin/api/tools` gains `maxToolCallsPerTurn`, `PUT /admin/api/tool-call-limit {value}` sets it; pi's tests
  drive the route in-process and its commit looked at the page with a FAKE API only):** `run-all.sh` all PASS
  on a fresh stack (`~/.noah-work/boot-test-2026-11-14e/`, Noah `1081102`), `71-` 25/25, `75-` 37/37, `25-`
  48/48, `85-` 26/26, `86-` 20/20, `87-` 19/19, `88-` 23/23, `90-` 22/22, `92-` 10/10, no error-level line in
  the six services' logs at the end, and the new **`93-tool-call-limit.mjs` 23/23**, through Noah's `/admin`
  proxy as a Noah admin against the real gateway. The fresh stack answers `maxToolCallsPerTurn: 200` and an
  owner turn with 4 tool calls completes; `PUT {value: 3}` → 200 `{"maxToolCallsPerTurn":3}` and the GET shows
  3; `0`, `10001`, `2.5` and `"3"` → 400 `invalid_tool_call_limit` ("value must be an integer from 1 to 10000")
  with the value unchanged; a member (PUT and GET) and an anonymous caller get 403, and an admin's PUT without
  the panel's headers 403 `csrf`. At 3, with NO restart: a turn with 3 calls completes; a turn whose scripted
  model makes a 4th call is stopped — the 4th command never ran (its file holds `1 2 3`), the model is not
  asked a 5th time, and Noah's stream is an ordinary `done` (no `error` frame) whose answer is `응답이 최대 처리
  단계에 도달해 중단되었습니다. 질문을 더 작게 나눠 다시 시도해 주세요.` with `response.resultError:
  "error_max_turns"`; that text is the row the conversation keeps. **A stopped turn whose model had already
  WRITTEN something answers with that text alone — no stop message and no `resultError`** (→ `pi-runtime.md`
  "pi admin panel proxy"). In a real browser the page shows 턴당 도구 호출 상한 with the value in force, 저장
  stays disabled for the same value, `0` and `10001`, and saving 5 shows 저장했습니다. 다음 턴부터 적용됩니다.
  with no page error, failed call or CSP violation. Back at 200 the conversation that was stopped goes on
  (4 calls complete). Noah's audit log holds one `pi_admin_proxy` row per PUT that reached pi (7: three
  `success`, four `error`), each detail exactly `PUT /admin/api/tool-call-limit` — never the value; the three
  refusals Noah made itself and the GETs leave no such row. The gateway logs `tool call limit updated` WITH the
  value (3, 5, 200) and logs nothing for a stopped turn; neither does Noah. **NOT seen:** a subagent call
  stopped at the limit (pi's tests), the value surviving a gateway restart (pi's DB — not restarted here), a
  change made while a turn is running, any turn with a real model. After the run: gateway 265 MiB, broker
  155 MiB.
  **A model-driven check in that stack** (done for `/compact`, 2026-11-10): run the scripted fake LLM
  (`~/.noah-work/pi-e2e/fake-llm.mjs`, `node:22-bookworm-slim`) as a SIBLING container on `noahcompose-net`
  with a fixed `--ip`, `PUT /admin/api/llm` on the gateway's `edge` address with pi's admin key, then drive
  Noah's published port from the host (`~/.noah-work/pi-compose/boot-1110/compact-e2e.mjs`; the first signup
  is the admin — a second one waits for approval, so later runs log in). For a compaction to have anything
  to summarize, the OLDER part must be a turn BEFORE the message that crosses pi's `keepRecentTokens`: pi cuts
  at a message boundary and keeps the crossing message itself, so one huge first message is all "recent".
- `docker build` and `docker run` DO work here (plain `docker build -t <unique tag> .` of the Noah image). The
  user's dev stack on the host is this checkout's own `docker compose up -d --build`; never run it while a
  standalone pi-gateway stack is up on the same daemon (`docker ps --filter label=com.docker.compose.service=sandboxd`).
  Smoke-test: `docker run -d -e SESSION_SECRET=x -e AGENT_RUNTIME=local <img>` then `docker exec <c> curl -fsS
  --noproxy '*' localhost:48787/api/bootstrap` (the unauth health probe + HEALTHCHECK). `SESSION_SECRET` is
  REQUIRED to boot (`NODE_ENV=production`), the image runs as non-root `node` (so global bins must be
  world-accessible, NOT symlinked into `/root`), and `docker stop` should exit in <1s via the SIGTERM handler
  in `index.ts`.
- **Native HTTPS mode:** `TLS_CERT_FILE`+`TLS_KEY_FILE` (both, or the boot refuses — never a
  silent HTTP fallback) switch `createAppServer` to `https.createServer`; TLS ends in the app, so
  no proxy read-timeout/buffering sits in front of agent SSE. compose mounts `./docker/tls` →
  `/app/tls` (contents gitignored), HEALTHCHECK probes http then https `-k` (the cert names the
  deploy host, not localhost). Flipping an EXISTING http deployment: set `SECURE_COOKIES=true`,
  and every installed browser-bridge extension keeps answering only the old `http://` origin
  (`externally_connectable` is origin-gated) — users re-download the zip (re-stamped with the
  https origin) or hand-add it; the one-click updater cannot bridge that gap because it rides the
  very page↔extension channel that broke. The container runs as `node` (uid 1000): a root-owned
  mode-600 key in `./docker/tls` reads as EACCES at boot — make the PEMs readable by uid 1000.
- **`CA_CERT_FILE` (#76, #77) is ONE file directly under `docker/` (`.crt`/`.pem`, never `docker/tls/`) and
  reaches every build that fetches over HTTPS, with verification ON** — never `GOSUMDB=off`, `strict-ssl=false`
  or `NODE_TLS_REJECT_UNAUTHORIZED=0` (the Noah image's npm steps used the last two until #77).
  - **System store: `docker/install-extra-ca.sh <pem> <prefix>`** (Noah `Dockerfile`, `docker/pi-sandbox/Dockerfile`,
    `docker/egress/proxy.Dockerfile`, `docker/pi/golang-ca.Dockerfile`; Debian and Alpine). It splits a PEM bundle
    into one `<prefix>-NN.crt` per certificate — `update-ca-certificates` hashes only one certificate per file and
    just WARNS (`does not contain exactly one certificate or CRL: skipping`), exit 0 — finds the updater on PATH
    or in `/usr/sbin`, `/usr/local/sbin`, `/sbin` (pi's sandbox base sets a build PATH without sbin), then fails
    the build unless every certificate's first base64 line is in `/etc/ssl/certs/ca-certificates.crt`. The
    placeholder `docker/extra-ca.crt.example` is a no-op.
  - **Node never reads the system store.** Every `npm install` in the Noah image and the deck sandbox runs with
    `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` (the bundle that now holds the CA). A new Node network
    step does the same.
  - **Build contexts must admit the inputs.** The root `.dockerignore` does; `docker/pi-sandbox/Dockerfile.dockerignore`
    is an allowlist and lists `docker/install-extra-ca.sh`, `docker/*.crt`, `docker/*.pem`. A new per-Dockerfile
    ignore file must too — the test parses both and pins that no other one exists.
  - **pi's builds take the CA through pi's own base-image build args**, set by `docker/pi/compose.override.yml`
    with `additional_contexts: service:<builder>`, so pi's Dockerfile and compose file stay untouched:
    `egress-proxy` gets `GO_IMAGE: pi-go-builder` (`docker/pi/golang-ca.Dockerfile`: pi's Go image + the system
    store), and gateway / sandboxd / mcp-broker get `NODE_IMAGE: pi-node-builder` (`docker/pi/node-ca.Dockerfile`:
    pi's Node image + `NODE_EXTRA_CA_CERTS=/etc/noah-node-ca.pem`, written by `docker/pi/node-ca-bundle.cjs` as
    Node's own roots plus every CA certificate, each parsed as X.509 or the build fails; roots keep it valid when
    no CA is set). `node:22-bookworm-slim` has no `ca-certificates`, and installing it would need pi's apt mirror
    args, which live in pi's `.env` and are not visible to Noah's services — hence the Node-only file. The ENV is
    inherited by pi's runtime images: gateway and broker override it from pi's compose (their own mount, or empty
    = unset); sandboxd just trusts the same roots plus the operator CA. pi's own `sandbox-image` takes its CA as pi's build secret
    `extra_ca`, which pi points at `NODE_EXTRA_CA_CERTS` (a host path, `/dev/null` when unset); Noah's
    `docker-compose.yml` REDEFINES that secret as `CA_CERT_FILE`. **Every build input must live inside the
    project directory:** Compose >= 5.6 builds through bake, which refuses a secret/context file outside it
    (`additional privileges requested: pass "--allow=fs.read=…"`, even `/dev/null`; `COMPOSE_BAKE=false` does
    not help — only `BUILDX_BAKE_ENTITLEMENTS_FS=0`, which switches the check off). Runtime bind mounts are
    unaffected. `GO_BASE_IMAGE` / `NODE_BASE_IMAGE`
    must equal the pinned pi Dockerfile's `GO_IMAGE` / `NODE_IMAGE` defaults — the test fails when a pi bump
    moves one; update both together.
  - Tests: `tests/docker-extra-ca.test.ts` (scripts run for real against a temp store, ignore-file parsing,
    wiring pins). Real builds behind a test-CA HTTPS mirror: opt-in `NOAH_DOCKER_CA_E2E=1
    rtk proxy npx vitest run tests/docker-ca-e2e.test.ts` (needs docker, openssl, internet; several minutes).
- **Dockerfile CA trust is PER-STAGE.** The `CA_CERT_FILE`→`update-ca-certificates` block
  lives in the `base` stage and covers ONLY that stage — an HTTPS fetch (curl/npm/cargo) in a
  *different* earlier stage hits the corporate intercepting proxy with no trusted CA and dies
  `SSL peer certificate ... was not ok`. Put any network step in `base`, AFTER that block.
  (uv is fetched as a pinned prebuilt GitHub-release binary in `base` for exactly this reason;
  rtk — removed 2026-08 along with the whole Bash-rewrite feature, it stalled the single-process
  server with a blocking `spawnSync` per Bash call — originally hit this trap as a `FROM rust`
  `cargo install` builder stage.) Test one RUN step without a full
  build: `docker run --rm node:22-bookworm-slim bash -c '<step>'`.

## Deck converter
The pptx skill's HTML→PPTX converter (mechanics: [`pptx-converter.md`](pptx-converter.md)) needs a
Chromium and a Python with the pinned set. In a deployment it runs inside each user's pi sandbox, whose
image (`docker/pi-sandbox`, Python 3.12, trixie Chromium) has both; the Noah image has neither. A dev box
borrows Playwright's cached Chromium and a venv.
- **Dev venv** (any CPython the pins have wheels for; the sandbox image is 3.12): `uv venv ~/.venvs/noah-pptx --python 3.11 && uv pip install
  --python ~/.venvs/noah-pptx/bin/python -r default-skills/skills/pptx/converter/requirements.txt`.
- **Dev `.env`** (the server's boot probe and the agent shell both read it):
  `NOAH_PPTX_PYTHON=/home/<you>/.venvs/noah-pptx/bin/python` — ABSOLUTE, `.env` values are not
  `~`-expanded — and `NOAH_PPTX_DEV=1`, which lets the resolver fall back to Playwright's cached Chromium
  (`~/.cache/ms-playwright/chromium-<rev>`, the one the visual suite installs; if it is missing:
  `node node_modules/playwright-core/cli.js install chromium`). Never set `NOAH_PPTX_DEV` on a deployment.
  Check with `node default-skills/skills/pptx/converter/tools/deck.mjs probe --json` → `"converter": true`,
  then boot `npm run dev:server` once and read its `deck toolchain probe` log line.
- **Opt-in e2e suites** (they SKIP without the opt-in, so a green `npm test` says nothing about
  conversion): `NOAH_PPTX_E2E=1 NOAH_PPTX_DEV=1 NOAH_PPTX_PYTHON=~/.venvs/noah-pptx/bin/python
  npx vitest run tests/deck-converter.test.ts tests/deck-contract.test.ts` — expect no skips. Also
  `bash default-skills/skills/pptx/scripts/deck.sh selftest --fail-on-drift` (both decks, both profiles),
  and `git status` must show no `__pycache__` or `.build` under `default-skills/`.
- **Sandbox image:** `docker compose build pi-sandbox-image` inside the dind of "Combined-stack boot test"
  (never on the host — it builds pi's `sandbox-image` first), or plain `docker build -f
  docker/pi-sandbox/Dockerfile -t noahpi/sandbox:<tag> .` FROM an existing pi sandbox image. The build log
  must show `deck converter selftest: PASS`; then `docker/pi-sandbox/verify.sh --image <tag>` runs every
  conversion under sandboxd's flags (`--runsc` adds a gVisor run). Run it whenever the converter, its pins
  or `docker/pi-sandbox` changed.
- **`scripts/deck-docker-smoke.sh` is retired** (it drove the pre-pi Noah image's converter, which is gone);
  `docker/pi-sandbox/verify.sh` is the deck image check. Its two uncovered steps (SIGKILL mid-build, Open XML
  validation) are backlog PC3.
- **One Dockerfile fragment** (an apt layer, the fontconfig registration) can be tried without a full build in
  a throwaway container, as above; the sandbox image's self-test needs the skill tree, so test it through a
  real build.
