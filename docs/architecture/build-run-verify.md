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
- `docker compose config` — validate compose/env wiring before Docker changes.
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
- `docker build` and `docker run` DO work here. Smoke-test:
  `docker run -d -e SESSION_SECRET=x <img>` then `docker exec <c> curl -fsS --noproxy '*'
  localhost:48787/api/bootstrap` (the unauth health probe + HEALTHCHECK). `SESSION_SECRET`
  is REQUIRED to boot (`NODE_ENV=production`), the image runs as non-root `node` (so `uv` /
  global bins must be world-accessible, NOT symlinked into `/root`), and `docker stop` should
  exit in <1s via the SIGTERM handler in `index.ts`.
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
Chromium and a Python with the pinned set. The image has both; a dev box borrows Playwright's cached
Chromium and a venv.
- **Dev venv** (Python 3.11 = the image's): `uv venv ~/.venvs/noah-pptx --python 3.11 && uv pip install
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
- **Baseline image = a FRESH build of `main`,** never an old local tag:
  `git worktree add /tmp/noah-main main && docker build -t noah-almighty:baseline-main /tmp/noah-main`,
  then `git worktree remove /tmp/noah-main`. Compare sizes with `docker image inspect -f '{{.Size}}' <img>`
  (expect ≈ +0.21 GB compressed content / +0.54 GB uncompressed for the converter).
- **Docker smoke:** `docker build -t noah-almighty:deck-verify .` (the log must show
  `deck converter selftest: PASS`; `--progress=plain` prints it), then
  `scripts/deck-docker-smoke.sh --image noah-almighty:deck-verify --baseline-image noah-almighty:baseline-main
  --require-validator` (add `--validator-dll <dir>/Validator.dll` to reuse a built validator, `--keep <dir>`
  to keep the decks and logs). It runs every conversion under `--network none --cap-drop ALL
  --security-opt no-new-privileges:true -u node --init`; its steps (a)–(j) are listed in the script header.
  Without `--validator-dll` it builds `scripts/openxml-validator/` with `mcr.microsoft.com/dotnet/sdk:8.0`
  (needs NuGet; build recipe in that directory's README) and SKIPs the validation with a warning when it
  cannot — `--require-validator` turns that into a FAIL. Run the smoke whenever the converter or the
  Dockerfile changed.
- **Legacy variant:** `docker build --build-arg DECK_CONVERTER=0 -t noah-almighty:deck-legacy .` must
  build; `docker run --rm noah-almighty:deck-legacy bash /app/default-skills/skills/pptx/scripts/deck.sh
  probe --json` → `"converter": false`, exit 4, and `missing` names "the image was built without the
  converter (DECK_CONVERTER=0)"; the boot log's probe line shows mode `legacy`.
- **One Dockerfile fragment** (the apt or pip layer, the fontconfig registration) can be tried without a
  full build in a throwaway container, as above; the self-test fragment needs the whole app tree, so test it
  through a real build.
