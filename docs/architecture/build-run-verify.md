# Build, run, verify

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Dev servers, the verification gate, Docker/TLS/CA, release mechanics, and the deck converter's dev
> setup, opt-in suites and Docker smoke.

- `npm run dev` — `concurrently` runs `dev:server` (tsx watch, port 48787) + `dev:client`
  (vite, port 5173, proxies `/api`,`/users`,`/fonts` → 48787).
- `npm run lint && npm test && npm run build` — standard verification gate. `lint` =
  `tsc --noEmit` (server) **+ `svelte-check`** (client); `build` = server tsc + `vite build`
  (→ `dist/client`); `pretest` runs `vite build --mode test`, so a client compile break fails
  the test gate.
- **Client checks (run these directly):** `npx tsc --noEmit` and
  `npx svelte-check --tsconfig ./tsconfig.client.json`. ⚠️ The rtk hook misrewrites
  `npm run lint` to eslint and fails — don't rely on it; run the two commands above. `npm run
  build:client` (vite) / `npm run lint:client` (svelte-check) also work. `tsconfig.client.json`
  pulls in `src/server/types.ts` + `routineSchedule.ts` so the client shares server types via
  the `src/client/src/lib/types.ts` re-export barrel — import server types through it.
- `rtk proxy npx vitest run tests/<file>.test.ts` — run ONE test file (full suite is ~16s); the
  suites are split agent-core/agent-tools/store/infra/app/chat-history.
- `docker compose config` — validate compose/env wiring before Docker changes. The stack INCLUDES
  pi-gateway's compose from `${PI_GATEWAY_DIR:-../pi-gateway}` (README "Deployment"), so `config` needs a
  pi-gateway checkout (a `git -C ~/pi-gateway archive <pin> | tar -x -C <dir>` export works), a Noah `.env`
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

## Verifying the running app / UI
- Verifying the local server: WHEN a corporate `HTTP_PROXY` is set it intercepts `localhost`
  (returns "Access Denied") — hit the dev server with `curl --noproxy '*' localhost:<port>/...`.
  But the proxy is NOT always present (check `env | grep -i proxy`); with no proxy you CAN install
  a browser engine and runtime-verify isolated UI (Playwright fixture — see
  [`client.md`](client.md) §Client verification).
- Running the FULL app here is impractical (it talks to a separate deployment, no local DB) — so
  feature-level changes ride on svelte-check + careful reading + the `f0a6128` parity reference + a
  human browser smoke test.
- For visual/layout bugs, inspect the *rendered* state (screenshot + DevTools computed styles),
  don't reason from CSS source alone — collisions/inherited rules aren't visible in the source.

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
- **Combined-stack boot test — NEVER on the host daemon** (the user's own pi-gateway runs there; a second
  sandboxd adopts/removes its sandboxes and the egress socket volume name is fixed). Use a private
  privileged `docker:29-dind` on its own network, the way the 2026-10-29 verification did:
  `docker network create --subnet 10.217.0.0/24 noahcompose-net`, `docker run -d --name noahcompose-dind
  --privileged --network noahcompose-net -e DOCKER_TLS_CERTDIR= -v <dir>:<dir> docker:29-dind dockerd
  --host=unix:///var/run/docker.sock --default-address-pool base=10.218.0.0/16,size=24`, with `<dir>` holding a
  `git archive` of HEAD + the working compose files, a pi-gateway export at the pin, a `home/` (workspaces 0700,
  plugins 0777) and `secrets/` made by hand (files 0444 so uid 10001 reads them without root; Noah's copy 0400),
  `DOCKER_GID` = the dind socket's gid. Then inside it `docker compose build` (~10 min cold) and `up -d`, and
  check: `pi-setup` logs one `PUT` per server then `ok … (unchanged)` on a re-run; `/api/bootstrap` answers;
  from `mcp-broker` `POST http://noah-almighty:48787/mcp/repo` → **401**, from `gateway` and from the published
  port → **403**; Noah `GET http://gateway:8080/v1/models` with the mounted key → 200; and pi's
  `scripts/security-check/run.mjs` (run in `sandboxd`, `--internal noah-almighty:48787` plus each Noah IP) →
  all PASS, sandboxes `noah-almighty/pi-sandbox:latest` with network `none`. Tear the dind and its volume down
  afterwards; leave `noahpi-dind` (the pi e2e instance) alone.
- `docker build` and `docker run` DO work here (plain `docker build -t <unique tag> .` of the Noah image only —
  never `docker compose build` on the host: pi's `sandbox-image` service would retag `pi-gateway/sandbox:latest`).
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
- **`scripts/deck-docker-smoke.sh` targets the pre-pi Noah image** (a converter inside the app container);
  it no longer applies to the Noah image of this branch.
- **One Dockerfile fragment** (an apt layer, the fontconfig registration) can be tried without a full build in
  a throwaway container, as above; the sandbox image's self-test needs the skill tree, so test it through a
  real build.
