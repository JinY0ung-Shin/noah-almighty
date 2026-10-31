# Noah Almighty

A platform where each user signs up, builds an **avatar** (profile + GitHub plugins +
personal knowledge repo), browses coworkers' avatars, and chats with any avatar they can reach.
Every chat turn runs on a bundled pi-gateway, each in the acting user's own network-less sandbox;
the owner's data (knowledge repo, secrets, SSH, to-dos) is reached only through Noah's MCP tools,
which check owner/group trust themselves.

## What it does

- **Shared outbound domain blocking**: an optional [egress policy overlay](docs/egress-policy.md)
  (Docker/containerd) routes every local avatar and server-side tool through one domain-filtering
  proxy and blocks direct IP/DNS connections at the container firewall. System admins add, remove
  and apply blocked domains under **관리자 → 가입·접근 → 외부 통신 차단**; each change is audited,
  and the guide covers verification and rollback. The user's own browser bridge is outside this
  boundary, and connections that cannot go through the proxy (direct SSH and the like) are
  blocked as well.
- **Built-in usage manual**: local avatars receive a compact feature index on every turn and
  read detailed guides through `mcp__system__read_manual` (the always-on system tool group). Guides cover
  setup, chat, knowledge, skills/plugins, groups, scheduling, external Task API integration,
  repositories, browser/web, credentials/SSH, artifacts and administration. Current account
  capabilities are checked separately through `describe_system`.
- **Accounts**: self-service signup with username + password (no invite codes). The
  first user to sign up becomes the **admin**. SQLite-backed users + roles (`admin`/`member`).
- **Avatar profile**: display name, uploaded profile picture (with a generated
  initials/gradient fallback), one-line bio, an optional persona / system prompt, and
  **capability hashtags** (역량 해시태그) the avatar can **auto-generate** from its own
  skills/persona (just like the self-introduction). Avatars are visible only to the owner's
  group teammates (default) or to no one (**비공개**), set from **내 아바타** — there is no
  public-to-everyone state, so a user in no group chats only with their own avatar.
- **Personal knowledge repo**: each user connects one dedicated GitHub repo where their
  avatar accumulates work knowledge and skills. It is **auto-loaded into the avatar** (its
  skills become available in chat), and the avatar **manages it itself**: in an owner chat
  the avatar can list/read/write files, scaffold skills (`skills/<name>/SKILL.md`), and
  commit & push — via the owner-only `mcp__repo__*` tools. Settings just points at the repo
  (a GitHub link); there is no in-app file editor.
- **Delegation loop**: grow your avatar by turning repeated work, project rules, runbooks,
  and answers to teammate questions into skills / knowledge files / routines, then delegate
  more of that work back to the avatar over time.
- **PowerPoint decks**: the avatar designs new decks as HTML/CSS slides and converts them into a
  `.pptx` whose text boxes, shapes, tables and charts are native, editable PowerPoint objects
  (charts keep their data for *데이터 편집*). The avatar picks one of six themes (classic, mono,
  editorial, midnight, forest, violet) to fit the topic and audience, or follows the user's
  style and brand colours; switching the theme is one rebuild. Pretendard is embedded in the
  file by default; a 맑은 고딕 build is available on request. The deck arrives as a download
  card whose side panel shows the converter's exact slide renders. Existing decks and user
  templates are edited in place with python-pptx and previewed approximately by LibreOffice. Mechanics:
  [`docs/architecture/pptx-converter.md`](docs/architecture/pptx-converter.md).
- **PPT share links (공유 링크)**: the owner of a conversation can turn a generated deck's download card
  into a login-required link — with **공유 링크** next to the card, or by asking their own avatar for a
  link in a chat with it. Anyone signed in to Noah who has the link can page through the slide renders,
  present them full screen and download the `.pptx` (speaker notes included) until the link expires:
  1, 7 (default) or 30 days, fixed at creation. Links are revocable any time under **내 아바타 → 권한·연결
  → 공유 링크**. A link exports one file — it grants no
  access to the conversation or the avatar. Mechanics:
  [`docs/architecture/share-links.md`](docs/architecture/share-links.md).
- **draw.io diagrams**: the avatar can author `.drawio` diagrams (or pass along ones it fetched,
  e.g. Confluence attachments) and hand them over as download cards; the chat renders them as
  interactive diagrams (zoom/pan/pages) in the file side panel, fully offline via a vendored
  draw.io viewer.
- **Scheduled routines**: owners can create one-time or recurring chat jobs (`/api/me/routines`)
  for a specific KST date/time, daily/weekly slots, or a fixed interval. The avatar executes
  them headlessly and keeps each run's result in a dedicated routine conversation.
  The `/routine <task>` chat command creates a routine inline. The avatar itself can manage
  routines via the `mcp__system__*_routine` tools.
- **To-do list (할 일)**: each user keeps one work to-do list — a title plus an optional memo, due
  date (a date, never a time), priority and tags. The **할 일** tab (right below 대화) shows it in detail
  with 오늘/예정/마감 지남/전체/완료 filters, and a toggle under the chat input pins a compact card to the
  top right of the chat. The owner's own avatar manages the same list through the owner-only
  `mcp__todo__*` tools: it adds items on request (or `/todo <내용>`), offers once to add clear action
  items that come up in a conversation, and completes or edits them; routines and the external task API
  can add items too (an API-submitted task cannot delete one). Mechanics:
  [`docs/architecture/todos.md`](docs/architecture/todos.md).
- **Groups**: the system admin creates named teams (`/api/admin/groups*`) and assigns group
  admins. Group co-membership in an avatar-sharing group is the SOLE source of trust/elevation —
  co-members **auto-trust each other symmetrically**: they see each other's `group`-visibility
  avatars and get elevated tool access (write-capable tools with a per-tool prompt) when chatting
  with a co-member's avatar. There is no per-user "trusted users" list anymore — `isTrustedFor` IS
  group co-membership (`shareAnyGroup`), the single choke point. Groups have no shared knowledge
  repo (retired 2026-10-30); team knowledge travels as shared skills. Group self-serve (member
  management, avatar sharing, shared-skill channel) is at `/api/me/groups*`.
- **Knowledge-backfill loop**: when the avatar notices a knowledge gap it can file a
  `request_info` gap. The owner sees pending gaps in the **내 아바타** nav badge and receives
  an in-app toast; clicking through lets them answer and feed the answer back to the avatar,
  which resolves the gap via `mcp__knowledge__resolve_request`.
- **Teammate avatars**: browse coworkers' published avatars and ask them work questions or
  request research, review, summarization, and other tasks against the knowledge and skills
  their owners have built up.
- **Per-user plugins**: each user can also add other GitHub plugin repos (read-only) to their
  avatar, separate from the knowledge repo.
- **Per-user Git tokens**: each user can store an internal `GIT_TOKEN` user secret for the
  configured `GITHUB_HOST` and an optional `GITHUB_TOKEN` for github.com. Tokens are
  AES-256-GCM encrypted at rest, keyed from `SESSION_SECRET`, and supplied to git via an
  `http.extraHeader`, so they are never written into any clone's `.git/config`. The knowledge
  repo is always expected to live on the internal `GITHUB_HOST`. Public general git repos can
  be cloned/synced without a token; push still requires whatever write credential the remote accepts.
- **SSH tools**: when the owner stores an `SSH_PRIVATE_KEY` secret and trusts target hosts,
  the avatar can use allowed SSH tools to work on servers reachable from the app host, such as
  checking logs, inspecting files, or running commands under the configured policy.
- **Onboarding**: after first login a skippable guided step explains the main workflows,
  gives starter prompts, optionally stores the internal `GIT_TOKEN`, and can generate an
  `SSH_PRIVATE_KEY` keypair immediately. External github.com `GITHUB_TOKEN` setup and
  knowledge repo / branch setup can happen later through settings.
- **Discovery**: published avatars appear in the Explore directory, searchable by name or
  **capability hashtag**; anyone can start a chat. Group co-members also see each other's
  unpublished avatars. An avatar can look up other avatars' capabilities mid-chat
  (the shared read-only `mcp__avatars__search_avatars` tool) and point you to a
  better-suited teammate when a request is outside its own expertise.
- **Per-conversation model picker**: the chat composer lets any user choose a model
  tier (Fable / Opus / Sonnet / Haiku) per conversation; the choice persists on the conversation
  and rides each turn. **Opus is the default** when nothing is picked. Operators map every
  tier to a pi-gateway model id with `PI_MODEL_MAP` (the picker shows the mapped id).
- **Per-user sandboxes, tiered data access**: each run executes in the ACTING user's own pi
  sandbox with the full tool set (shell, files) — a colleague chatting with your avatar works in
  the colleague's sandbox, never yours. What separates owners, group co-members (avatar-sharing
  groups) and plain colleagues is what Noah's MCP tools let each of them reach: owner-only tools
  (repo commit/push, SSH, secrets, routines, to-dos) check the owner in their handlers.
  - Streaming, markdown rendering, conversations, and per-message actions (copy,
    regenerate, edit-and-resend) are supported for all viewer classes.
- **Admin**: list users, grant/revoke the `admin` role, delete accounts and manage groups
  (create/delete teams, assign group admins, manage members). The LLM endpoints are configured
  in pi-gateway's own admin page (README "Deployment").

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:48787`, click **회원가입**, and create the first account (it becomes admin).

## Deployment

Noah runs as one Docker Compose stack together with its own pi-gateway: every agent turn runs on
pi-gateway (`POST /v1/responses`), and each user's files and commands live in that user's network-less
pi sandbox. Design and mechanics: [docs/architecture/pi-runtime.md](docs/architecture/pi-runtime.md).
`docker-compose.yml` **includes** pi-gateway's own `docker-compose.yml` from a pi-gateway checkout
(compose `include:`) and adds Noah's instance configuration on top
([`docker/pi/compose.override.yml`](docker/pi/compose.override.yml)); pi-gateway's code is used as it is,
never copied into this repository.

### Prerequisites

- Linux x86_64 host, **Docker Engine 25 or newer** with the Compose v2 plugin (≥ 2.24: `include` with an
  override list, `additional_contexts: service:`) and buildx. Verified with Engine 29.9 / Compose 5.6.
- **A Docker daemon that runs no other pi-gateway.** pi's sandboxd adopts, reaps and removes every sandbox
  container labelled `pi-gateway.instance=default` on its daemon, and its egress socket volume has a fixed
  name (`pi-gateway-proxy-sock`) — neither can be changed by configuration. Two pi-gateway stacks on one
  daemon delete each other's sandboxes.
- **The pi-gateway submodule** (`vendor/pi-gateway`, pinned by this repository's commit; pi's code is used as
  it is, never edited here). Clone with `--recursive`, or after a plain clone:
  ```bash
  git submodule update --init
  ```
  `git submodule status` shows the pinned commit. `PI_GATEWAY_DIR` in `.env` points the stack at another
  checkout instead (an existing deployment's `../pi-gateway`, see Upgrade).
- `openssl` and root on the host (pi's `scripts/setup-host.sh` creates the secret files).
- An LLM endpoint pi-gateway can call (OpenAI-compatible `/v1/chat/completions` or Anthropic-compatible
  `/v1/messages`, with tool calling). Model credentials live in pi-gateway only, never in Noah.

### First boot

1. **Write Noah's `.env`:** `cp .env.example .env`, then set at least `SESSION_SECRET`, `PI_GATEWAY_HOME`
   (pi's data root, e.g. `/srv/pi-gateway`; `PI_GATEWAY_SECRETS` only when it is not `$PI_GATEWAY_HOME/secrets`)
   and `PI_MODEL_MAP`. Values in Noah's `.env` win over pi-gateway's `.env` inside pi's compose file too, so
   the keys both read (`LOG_LEVEL`, `NODE_EXTRA_CA_CERTS`, `NPM_CONFIG_REGISTRY`, `PIP_INDEX_URL`,
   `PI_GATEWAY_HOME`, `PI_GATEWAY_SECRETS`) must mean the same thing for both; `NODE_EXTRA_CA_CERTS` is a
   **host** path.
2. **Prepare the host** (idempotent; re-run whenever pi's service key changes). It reads `PI_GATEWAY_HOME`
   (and `PI_GATEWAY_SECRETS`, `PI_GATEWAY_DIR`) from that `.env`:
   ```bash
   sudo docker/pi/setup-host.sh
   ```
   - **pi-gateway's half** (it runs the submodule's `scripts/setup-host.sh` with the same values): creates
     `$PI_GATEWAY_HOME/workspaces` (uid 1000 — the same uid as Noah's container, which mounts it),
     `$PI_GATEWAY_HOME/plugins`, one 0400 copy of each secret per pi service under `$PI_GATEWAY_SECRETS`, and
     adds `PI_GATEWAY_HOME`, `PI_GATEWAY_SECRETS`, `DOCKER_GID` to `vendor/pi-gateway/.env` (git-ignored
     there); whatever already exists is kept. Review the rest of pi's settings in that file (`cp
     .env.example .env` there first if you want its comments): `GATEWAY_BIND_ADDR`/`GATEWAY_PORT` (where pi's
     admin page and API listen, default `127.0.0.1:8080`), the turn and `SANDBOX_*` limits (size them first:
     [Sizing pi-gateway](#sizing-pi-gateway)), `SANDBOX_EGRESS_ALLOW`, `APT_MIRROR_URL`…
   - **Noah's half:** checks the workspaces owner, copies pi's service key to
     `$PI_GATEWAY_SECRETS/noah/pi_gateway_api_key` (uid 1000, 0400 — pi's one-copy-per-service convention;
     compose mounts it into Noah as a secret, so the key never sits in `.env`) and checks that pi's admin key
     is set.
3. **Build and start everything:**
   ```bash
   docker compose up -d --build
   docker compose ps    # gateway, sandboxd, mcp-broker, egress-proxy healthy, noah-almighty healthy;
                        # sandbox-image, pi-sandbox-image and pi-setup exited (0)
   docker compose logs pi-setup
   ```
   Start order: pi's `sandbox-image` and `egress-proxy` → Noah's deck sandbox image `pi-sandbox-image`
   (built FROM pi's sandbox image; the build runs the converter self-test, about 35 s) → `sandboxd` →
   `mcp-broker` → `gateway` (healthy) → `pi-setup` → `noah-almighty`. `pi-setup` registers one broker entry per
   Noah MCP server, deploys Noah's system prompt (`scripts/pi-system-prompt.md`, live prompt `noah`) and turns
   off pi's `request_admin` / `present_file` built-ins; it is idempotent and re-runs on every `up`.
4. **Configure the LLM in pi-gateway:** open pi's admin page (`http://127.0.0.1:8080/admin` on the host by
   default; key: `$PI_GATEWAY_SECRETS/gateway/admin_api_key`) → **LLM**, add the corporate LLM server and its
   models and pick a default (pi-gateway's `docs/OPERATIONS.md` §3.3). Until then every chat turn fails with
   pi's `llm_not_configured`. Map Noah's composer tiers to those model ids with `PI_MODEL_MAP`.
5. Open `http://<host>:48787`, click **회원가입**, and create the first account (it becomes admin).

### What the stack wires up

| | |
|---|---|
| Noah → pi | `http://gateway:8080` over pi's `edge` network, with pi's service key from the compose secret (`PI_GATEWAY_API_KEY_FILE`). |
| pi's broker → Noah `/mcp/<server>` | `http://noah-almighty:48787` over `noah-mcp`, an internal network only the broker and Noah are on. The broker has a pinned address there (`NOAH_MCP_BROKER_IP`, default `172.30.248.10` in `NOAH_MCP_SUBNET` `172.30.248.0/24`), and Noah's `NOAH_MCP_ALLOWED_CIDRS` defaults to exactly that address, so no other container, and no published-port client, passes `/mcp`'s source check; each call still needs a per-run token Noah mints itself. Change both variables if the subnet collides with a network your host routes to. |
| sandboxes | No network at all (`network_mode: none`, pi's sandboxd). Their only exit is pi's egress-proxy, which opens only what pi's `SANDBOX_EGRESS_ALLOW` lists — keep Noah's address out of it: the broker, not the sandbox, calls Noah. |
| workspaces | `$PI_GATEWAY_HOME/workspaces` is bind-mounted read-write into Noah at `/srv/pi-workspaces` (`PI_WORKSPACES_DIR`): Noah stages attachments, captures and Confluence files into each user's sandbox folder and reads shared files and deck previews from it. uid 1000 on both sides. |
| sandbox image | `noah-almighty/pi-sandbox:${NOAH_PI_SANDBOX_TAG:-latest}` ([docker/pi-sandbox](docker/pi-sandbox/README.md)), built FROM pi's own `pi-gateway/sandbox:latest` and set as sandboxd's `SANDBOX_IMAGE`; pi's own image keeps its own tag. It carries the pptx skill's converter (Chromium headless shell, the pinned Python set, the deck fonts), so `PI_DECK_SANDBOX=true` is fixed. |
| Noah image | No agent runs in it any more. It keeps what the server itself runs: git (server-side repository work), `gh` (create_repo), LibreOffice + poppler + the deck fonts (share_file's approximate previews), python3-cryptography/paramiko (SSH key generation, known_hosts), the hex-ssh MCP server (relayed to pi), and the MCP bridge scripts. No Chromium, Python package set, uv or ripgrep (those are in the sandbox image). |

docker-compose.yml FIXES `AGENT_RUNTIME=pi`, `PI_GATEWAY_URL`, `PI_GATEWAY_API_KEY_FILE`, `PI_WORKSPACES_DIR`,
`PI_DECK_SANDBOX` and the default `NOAH_MCP_PUBLIC_URL` / `NOAH_MCP_ALLOWED_CIDRS` for the container; `.env`
cannot override the fixed ones.

**Native TLS** (`TLS_CERT_FILE`/`TLS_KEY_FILE`): the broker must reach Noah by the name its certificate
carries. Set `NOAH_MCP_PUBLIC_URL=https://<that name>:<PORT>` and `NOAH_MCP_HOST_ALIAS=<that name>` (a network
alias on `noah-mcp`), and make sure pi's broker trusts the issuing CA (`NODE_EXTRA_CA_CERTS`).

**gVisor:** with `SANDBOX_RUNTIME=runsc` in pi-gateway's `.env`, raise `SANDBOX_PIDS_LIMIT`: the gVisor
sentry's own threads count against the sandbox's pids cgroup, and a deck build at the default 256 kills the
sandbox (`WaitPID ... failed: EOF`). Peaks of 340–550 were measured for one build
([docker/pi-sandbox/README.md](docker/pi-sandbox/README.md)), so use at least 1024; pi-gateway's
`docs/OPERATIONS.md` §7 recommends starting at 4096. Install and register runsc as that section describes.

### Sizing pi-gateway

pi-gateway's defaults fit a small team. They are pi's own settings: set them in **pi-gateway's `.env`**, then
`docker compose up -d`. Example for a peak of 100–200 concurrent turns with at most 8 per user:

| pi `.env` | pi default | Example | At the default |
|---|---|---|---|
| `MAX_CONCURRENT_TURNS` | `16` | `250` (peak + headroom) | Turns over the limit queue; after `TURN_QUEUE_TIMEOUT_SECONDS` (120) pi answers 503, Noah tries the stream open 4 times in all with backoff, then the turn fails. |
| `MAX_CONCURRENT_TURNS_PER_USER` | `3` | `8` | A user's 4th simultaneous conversation waits until one of the first three finishes. |
| `SANDBOX_MEMORY` / `SANDBOX_CPUS` | `1g` / `1` | `4g` / `2` | All of one user's turns share ONE sandbox: with 8 at once, a deck build (one ≈ 0.5 GiB Chromium; builds queue one at a time per sandbox) and the other turns' commands (python, pandas…) share 1 GiB and one CPU. Both are caps, not reservations. |

Measured with the example values (2026-10-31, the e2e stack in dind on a 12-core dev box, a stub model, every
turn holding a `sleep` in its sandbox):

- 200 concurrent turns from 200 users, started over 60 s: none queued; at the peak pi's services used ≈ 1.1 GiB
  PSS (gateway 0.6, broker 0.4), the 200 sandbox containers with their containerd shims ≈ 0.85 GiB, Noah
  ≈ 1.35 GiB — ≈ 3.3 GiB in all, before whatever the turns' own commands use.
- 200 live sessions holding 400 KiB of history each added ≈ 100 MiB to the gateway's heap (its V8 limit is
  ≈ 4 GiB).
- One user's 8 simultaneous turns all ran in parallel.

**Session starts, not concurrent turns, are the limit.** pi starts a session on a conversation's first turn,
after `SESSION_IDLE_SECONDS` without one (it unloads the idle session and rebuilds it on the next turn), and on a
model/effort change, and every start lists all of Noah's MCP servers through the broker. 200 starts in the same
second saturated the gateway and the broker (one core each): their internal calls hit a 10 s connect timeout,
so up to half of those sessions started WITHOUT Noah's tools (a session keeps the tool list it started with) and
most of their sandbox commands failed (`sandboxd is unreachable`); a larger libuv threadpool
(`UV_THREADPOOL_SIZE`) did not help. The same 200 starts spread at 3–20 per second ran clean (at 10–20 per
second, one session in 200 missed its tool list). Noah itself starts at most `ROUTINE_MAX_CONCURRENT_RUNS` (10)
routines and 4 task-API runs at once.

So the bundle sets pi's `SESSION_IDLE_SECONDS` to **1800** (pi's default is 300, which makes every 5-minute
pause in a conversation a session start), from Noah's own `NOAH_PI_SESSION_IDLE_SECONDS` — a
`SESSION_IDLE_SECONDS` in pi-gateway's `.env` is ignored. Longer keeps more sessions loaded (800 live sessions
held ≈ 600 MiB of gateway heap in the runs above) and refreshes
the relayed tool lists (공용 MCP servers, plugin MCP, hex-ssh) later: a newly bound or added server shows up
once the conversation has been idle that long, or in a new conversation. Going past an hour gains little.

### Closed networks (build mirrors)

Every build arg is empty by default (= public upstreams); set them in Noah's `.env` or the shell.

- **Noah image:** `APT_MIRROR_HOST`, `NPM_CONFIG_REGISTRY`, `CA_CERT_FILE` (a corporate proxy CA inside the
  build context, e.g. `docker/tls-fullchain.crt`), and the standard `HTTP(S)_PROXY`/`NO_PROXY` args.
- **Deck sandbox image:** `PIP_INDEX_URL` / `PIP_TRUSTED_HOST` (every pin of
  `default-skills/skills/pptx/converter/requirements.txt` as a CPython 3.12 wheel), `NPM_CONFIG_REGISTRY`
  (`playwright-core`), `CA_CERT_FILE`. Its apt follows the mirror pi's sandbox image was built with, which must
  then also serve Debian trixie's `chromium-headless-shell` and `chromium-common`. uv is a pinned GitHub
  release download.
- **pi-gateway's images:** `APT_MIRROR_URL`, `APT_SECURITY_MIRROR_URL`, `GOPROXY` in pi-gateway's `.env`;
  `NPM_CONFIG_REGISTRY` and `PIP_INDEX_URL` are shared with Noah's (Noah's `.env` wins).

### Upgrade

- **Noah:** `git pull && git submodule update --init`, then `docker compose up -d --build`. The submodule
  carries the pi-gateway pin, so a pin move arrives with the pull. `pi-setup` re-registers what changed.
- **Deployments from before the submodule** (pi-gateway checked out at `../pi-gateway`): pi's `.env` lives
  there, and without it pi's compose loses `DOCKER_GID`, `GATEWAY_BIND_ADDR` and the rest. Either copy it once
  (`cp ../pi-gateway/.env vendor/pi-gateway/.env`) and retire the old checkout, or keep using it with
  `PI_GATEWAY_DIR=../pi-gateway` in Noah's `.env` and check out the submodule's commit there
  (`git submodule status`). The compose project name is unchanged, so pi's volumes stay attached.
- **A new sandbox image only applies to new sandboxes.** Running ones keep the old image until idle
  (`SANDBOX_IDLE_SECONDS`, 15 min); to switch at once (workspaces stay):
  `docker rm -f $(docker ps -aq --filter label=pi-gateway.sandbox=1)`.
- Existing SDK-era deployments: see "Moving an existing deployment to pi" below.

### Deck converter golden drift

Decks are built inside the user's pi sandbox by the image `pi-sandbox-image` builds
([docker/pi-sandbox](docker/pi-sandbox/README.md)). Its build-time self-test converts two frozen reference
decks in both font profiles.

- An **integrity** failure — a gate rejects a deck, a stage crashes, the toolchain is incomplete — always
  FAILS the build.
- **Golden drift** — the image's Chromium lays the reference decks out differently from the committed golden
  IR (a numeric delta beyond 0.01 px, or a changed lint/warning set) while every integrity gate still passes —
  is RECORDED in the image (`/usr/local/share/noah-almighty/deck-selftest.json`, printed at the end of the
  build), not fatal. Decks keep building and passing every integrity gate; their layout may differ slightly
  from the reference renders.

Drift is not fatal by default so that the next Chromium security update cannot block every unrelated deploy.
`DECK_CONVERTER_STRICT_GOLDEN=1` makes it fatal. When drift is recorded, maintainers:

1. Render the reference decks with the image's own Chromium and open them in desktop PowerPoint (opens without
   a repair prompt, text inside its boxes, tables and charts editable):
   `docker/pi-sandbox/verify.sh --image noah-almighty/pi-sandbox:latest --keep /tmp/deck-drift --quick`.
2. If they look right, regenerate the goldens on a dev box —
   `bash default-skills/skills/pptx/scripts/deck.sh selftest --update-golden` — with that SAME Chromium build
   (point `NOAH_PPTX_CHROMIUM` at it), commit them, and rebuild the image.
3. If they look wrong, keep the previous image (next section) and report the regression; do not update the
   goldens.

### Deck converter rollback

Both images this repository builds can be rolled back by tag. Before an upgrade, tag the running ones:

```bash
NOAH_IMG="$(docker compose config --images noah-almighty)"
docker image tag "$NOAH_IMG:latest" "$NOAH_IMG:pre-upgrade"
docker image tag noah-almighty/pi-sandbox:latest noah-almighty/pi-sandbox:pre-upgrade
```

Roll back (same shell):

```bash
docker image tag "$NOAH_IMG:pre-upgrade" "$NOAH_IMG:latest"
docker image tag noah-almighty/pi-sandbox:pre-upgrade noah-almighty/pi-sandbox:latest
docker compose up -d --no-build
docker rm -f $(docker ps -aq --filter label=pi-gateway.sandbox=1)   # sandboxes pick the image up again
```

Delete the `:pre-upgrade` tags once the new images have proven themselves. pi-gateway's own images
(`pi-gateway/*:latest`) roll back the same way, or by checking out the previous Noah commit
(`git submodule update` moves pi with it) and rebuilding.

### Moving an existing deployment to pi

An SDK-era Noah deployment (single `noah-almighty` service) moves over without a data migration: the project
name, the `noah-almighty-data` volume and uid 1000 are unchanged, and retired data is backed up and
quarantined at the first boot (next section) — the old CLI transcripts in `APP_DATA_DIR/agent-sessions`
included.

1. Tag the running image for rollback (as above).
2. Check out the pi-gateway submodule (`git submodule update --init`).
3. In `.env`: add `PI_GATEWAY_HOME` (and `PI_GATEWAY_SECRETS` if not the default) and `PI_MODEL_MAP`; set
   `NODE_EXTRA_CA_CERTS` to the CA's **host** path or remove it (the old in-image path
   `/usr/local/share/ca-certificates/extra-proxy-ca.crt` does not exist on the host and stops `up`); remove
   `AGENT_RUNTIME`, `DECK_CONVERTER`, `UV_DEFAULT_INDEX`/`UV_INDEX` and the Claude-SDK-only keys (`ANTHROPIC_*`,
   `MAX_TURNS`, `AUTO_COMPACT_WINDOW`, `READONLY_TOOLS`) — Noah ignores them. Move the model endpoint and its
   credentials to pi-gateway's LLM page; the admin UI's Claude subscription token is gone.
4. `sudo docker/pi/setup-host.sh` (First boot step 2), `docker compose up -d --build`, then configure the LLM
   in pi (First boot step 4).
5. **Rollback** to the SDK-era release: `git checkout` that release, re-tag the old image as `latest`, and
   `docker compose up -d --no-build noah-almighty`. pi's services keep running until
   `docker compose down` from the new checkout; nothing of Noah's data volume depends on them. The first pi boot
   did change two things the old release reads, though: it DELETED the stored Claude subscription token
   (`claude_oauth_token` — paste it again in the old admin UI, or restore it from
   `APP_DATA_DIR/backups/pre-retire-<stamp>.db`) and MOVED the CLI transcripts (`agent-sessions`) to
   `APP_DATA_DIR/retired/<stamp>/` — move them back, or older conversations continue from their text history
   only. Turns taken on pi have no CLI transcript either way.

The optional egress overlay ([docs/egress-policy.md](docs/egress-policy.md)) is not yet supported together
with the bundled pi-gateway: its firewall admits only its own proxy, so Noah cannot reach pi's gateway.

### Retirement backups and quarantine

Removed features (personal bots, external avatars, group shared agents, server agents, Craft apps, STT)
are cleaned out of an existing deployment at boot. Before any of that deletes data, Noah:

- **backs up the whole SQLite DB** to `APP_DATA_DIR/backups/pre-retire-<UTC stamp>.db` (file 0600,
  folder 0700), once per boot that still has retired data — never on a clean or already-retired DB. The
  boot log has one `database backed up before retiring removed features` line with the path and size.
- **moves, never deletes, every retired file** to `APP_DATA_DIR/retired/<same stamp>/`, at the same
  path relative to `APP_DATA_DIR` (chat media, workspace trees and copies, SDK session files, avatar
  images, `runtime/craft-purge`). A symlink is moved as a link; its target is never touched. An item
  on another filesystem (EXDEV) is left in place, logged, and retried on later boots.

If the backup fails (disk full, `backups` is not a folder or is a symlink), the boot logs
`database backup before retirement FAILED` and skips EVERY retirement step — nothing is dropped, purged
or moved — and the next boot tries again. Free space or fix the folder, then restart.

**Both folders hold full user data** (conversations, encrypted secrets readable with this deployment's
`SESSION_SECRET`, files) and are never pruned, served or swept by Noah — account deletion does not reach
them either. Keep them owner-only and delete them yourself when satisfied:

```bash
# inside the data volume (APP_DATA_DIR, /app/data in the image)
ls -l backups/ retired/
chmod -R u+w retired/<stamp>     # only if a read-only tree refuses rm
rm -rf retired/<stamp> backups/pre-retire-<stamp>.db
```

To restore: stop Noah, replace `noah-almighty.db` with the backup (and remove `noah-almighty.db-wal` /
`-shm`), move the items you need from `retired/<stamp>/` back to the same relative paths, then start the
release you are rolling back to. Starting this release again retires the same data again (with a new
backup and quarantine).

## Configuration

| Env | Purpose |
| --- | --- |
| `SESSION_SECRET` | Session token hashing secret (required in production). |
| `SECURE_COOKIES` | `true` to mark the session cookie `Secure` (HTTPS-only). Leave unset for plain-HTTP deployments (e.g. local docker-compose) or the cookie is never sent back and login fails. |
| `AGENT_RUNTIME` | `pi` (default; every turn runs on pi-gateway — see `docs/architecture/pi-runtime.md`) or `local` (deterministic offline stub for tests). `claude` is retired and stops the boot. **Fixed to `pi` by docker-compose.yml.** |
| `PI_GATEWAY_URL` / `PI_GATEWAY_API_KEY` / `PI_GATEWAY_API_KEY_FILE` | The pi-gateway origin and its service key — inline, or a file holding only the key (trimmed). Set ONE: both, or an unreadable/empty file, stops the boot. The key is server-only (it can run turns as any user): an inline key is scrubbed from the process env after boot, a file's key never enters it. **Fixed by docker-compose.yml** (`http://gateway:8080`, the compose secret `/run/secrets/pi_gateway_api_key`; a `PI_GATEWAY_API_KEY` in `.env` would stop the boot); set them yourself only for a native run. |
| `PI_WORKSPACES_DIR` | Path of pi's `$PI_GATEWAY_HOME/workspaces` as Noah sees it (same host, same uid). Noah creates each conversation's `/workspace/c/<id>` folder and stages attachments there. **Fixed by docker-compose.yml** (`/srv/pi-workspaces`, a bind mount of `$PI_GATEWAY_HOME/workspaces`). |
| `NOAH_MCP_PUBLIC_URL` | The base URL pi's MCP broker uses to reach this Noah's `/mcp/<server>` (registered by the `pi-setup` service through `scripts/pi-register-mcp.mjs`, logged at boot). Compose default `http://noah-almighty:<PORT>`; set it (with `NOAH_MCP_HOST_ALIAS`) only for native TLS. |
| `NOAH_MCP_ALLOWED_CIDRS` | Comma-separated addresses/CIDRs (IPv4/IPv6) allowed to reach `/mcp/<server>`, matched on the TCP peer (never `X-Forwarded-For`); others get 403 before the token is read. An invalid entry stops the boot. Compose default: the broker's pinned address, `${NOAH_MCP_BROKER_IP}/32`. Unset (native run) = open — then bind/firewall the port to the broker's network. |
| `PI_MODEL_MAP` | **Required.** JSON, composer tier → pi model id, or `{"model": "...", "contextWindow": N}` (the window feeds the context badge). Every tier (`fable`, `opus`, `sonnet`, `haiku`) must be mapped: it is the only tier → model source, model fallbacks included. Malformed or incomplete → the boot stops. The models themselves (and their credentials) are configured in pi-gateway. |
| `PI_DECK_SANDBOX` | `true` when the pi sandbox image carries the deck toolchain (`docker/pi-sandbox`). **Fixed to `true` by docker-compose.yml**, which builds and wires that image. |
| `EXTERNAL_AGENTS_JSON` | **Retired** — external avatars were removed (2026-10-29). If still set, the server ignores it and logs one warning at boot; delete it from `.env`. The first boot of that release also permanently deletes every external-avatar conversation (messages, canvases, share links, attachments), the admin-managed external-avatar registry and their profile images. |
| `PI_GATEWAY_DIR` / `PI_GATEWAY_HOME` / `PI_GATEWAY_SECRETS` | Compose only. The pi-gateway checkout (default the `./vendor/pi-gateway` submodule), pi's data root (**required**) and secrets dir (default `$PI_GATEWAY_HOME/secrets`) — the same values as pi-gateway's `.env`. |
| `NOAH_MCP_SUBNET` / `NOAH_MCP_BROKER_IP` / `NOAH_MCP_HOST_ALIAS` / `NOAH_PI_SANDBOX_TAG` | Compose only: the internal broker↔Noah network (default `172.30.248.0/24`), the broker's pinned address on it (`172.30.248.10`), Noah's extra name there (native TLS), and the tag of the deck sandbox image (`latest`). |
| `NOAH_PI_SESSION_IDLE_SECONDS` | Compose only: pi's `SESSION_IDLE_SECONDS` (default `1800`; a value in pi-gateway's `.env` is ignored) — see [Sizing pi-gateway](#sizing-pi-gateway). |
| `PORT` / `APP_DATA_DIR` |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | Optional PEM cert/key paths that switch the app's own listener to HTTPS — set both or the boot refuses (docker-compose mounts `./docker/tls` → `/app/tls`). HTTPS gives pages a secure context, which the browser-bridge one-click update (File System Access) requires. Set `SECURE_COOKIES=true` with it. |
| `GITHUB_HOST` | Internal/default GitHub host for shorthand repo values like `owner/repo` (default `github.com`). Knowledge repos must use this host; full github.com URLs can use `GITHUB_TOKEN`. |
| `GITHUB_CA_CERT` | Optional PEM CA bundle for on-prem GitHub Enterprise (GHES) with a private CA. |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Optional corporate proxy for Noah's own outbound web access — the `mcp__web__fetch` avatar tool and the MCP servers Noah relays. Put intranet hosts/domain suffixes in `NO_PROXY` so they bypass the proxy. Sandbox egress is pi-gateway's `SANDBOX_EGRESS_ALLOW`. |
| `NODE_EXTRA_CA_CERTS` | Optional PEM bundle for intranet HTTPS behind a private corporate CA, as a **host** path: compose mounts it read-only into Noah (app fetch, `mcp__web__fetch`, MCP relays) and pi-gateway's compose into its gateway and broker — one key for both (README "Deployment"). A CA baked in with the `CA_CERT_FILE` build arg covers git/curl, not Node. |
| `CONFLUENCE_URL` | Optional app-wide Confluence Server/Data Center base URL for page, attachment, and image/draw.io asset tools. Per-avatar PATs are stored as the `CONFLUENCE_PAT` user secret. |
| `BROWSER_ALLOWED_ORIGINS` | Optional comma-separated DEFAULT browser-control allowlist (`intra.example.com,*.corp.local`). Seeded once into a browser whose extension allowlist is still empty — a user-edited or managed (enterprise-policy) list is never touched, and the user can change it afterwards in 설정 → 접근/보안. Entries that would cover Noah's own host (including a bare `*`) are dropped before serving: the app UI must never become drivable by default. |
| `LOG_LEVEL` | Pino log level: `trace`/`debug`/`info`/`warn`/`error` (default `debug` in dev, `info` in prod). |
| `ROUTINE_RUN_TIMEOUT_MINUTES` | Wall-clock deadline for one scheduled-routine run (default `30`, minimum `1` — it cannot be disabled). Covers the whole run, model-fallback retries included. `지금 실행` holds its HTTP request open for up to this long, so keep it under any reverse proxy's read timeout. |
| `ROUTINE_MAX_CONCURRENT_RUNS` | How many scheduled routines may run at once across the server (default `10`; must be a whole number ≥ `1`, anything else falls back to the default). Each run is a full agent process, so this bounds the burst when many routines fall due together or after downtime. A due routine over the cap waits for a free slot. `지금 실행` is never refused by the cap but occupies a slot while it runs. |
| `ROUTINE_MAX_CONCURRENT_RUNS_PER_USER` | How many of one user's routines may run at once (default `2`, same validation). Keep it below `ROUTINE_MAX_CONCURRENT_RUNS` so one user with many due routines can't take every slot. |
| `AVATAR_TASK_TIMEOUT_MINUTES` | Wall-clock deadline for one external task API run (`POST /api/v1/avatar/tasks`; default `300` = 5 hours, minimum `1` — it cannot be disabled). Covers the whole run, including time waiting on a question. A single pending request (question, permission or canvas input) still expires after 30 minutes without a response. |
| `DEFAULT_PLUGINS_DIR` | Path to built-in skills loaded for every avatar (default `<cwd>/default-skills`). Keep it inside the app tree: on a dev box the pptx skill's converter resolves `playwright-core` from the app's `node_modules`. |
| `NOAH_PPTX_*` | Dev boxes / native checkouts only: tuning of the pptx skill's deck converter (`NOAH_PPTX_MAX_CONCURRENT`, `NOAH_PPTX_SLOT_WAIT_SECONDS`, `NOAH_PPTX_MAX_SECONDS`, `NOAH_PPTX_MAX_SLIDES`, `NOAH_PPTX_CHROMIUM` / `NOAH_PPTX_PYTHON`, `NOAH_PPTX_SELFTEST_RECORD`, `NOAH_PPTX_DEV`, `NOAH_PPTX_LOCK_NAMESPACE`). In the Docker stack decks build in the pi sandbox, whose image fixes its own values. See `.env.example` and [docs/architecture/pptx-converter.md](docs/architecture/pptx-converter.md). |
| `PLUGIN_AUTO_REFRESH_MINUTES` | Minutes before an enabled avatar plugin clone is refreshed from git at chat/routine start (default `10`; `0` disables auto refresh after the first clone). |
| `BROWSER_BRIDGE_MULTIMEDIA_NOTICE` | `true`/`1`/`on` adds a corporate-policy line to the browser-bridge install guide telling users to unpack the extension into the upload-approved **Multimedia** folder. Default: hidden. |
| `ENV_FILE` | Override the `.env` file path loaded at startup (default `.env` in cwd). |
| `BROWSER_BRIDGE_ORIGINS` | **Release machine only** (`npm run build:extension-update`, not the server). Noah address(es) baked into the released extension's `externally_connectable`, comma-separated; bare origin or match pattern. Required for the policy install channel — a policy-installed extension missing the real address cannot be fixed on the machine and its bridge fails silently. |
| `BROWSER_EXTENSION_KEY_FILE` | **Release machine only.** Path to the RSA private key signing extension updates. Keep it outside the repo and back it up — the extension id derives from it. |

## Security note

Agent turns never run in Noah's container: each one runs in the acting user's pi-gateway sandbox
(no network, read-only root filesystem, its own workspace), and the sandbox reaches Noah only
through pi's MCP broker with a per-run token Noah mints — `/mcp` additionally admits only the
broker's address. Every Noah MCP handler self-gates owner/elevated access, and the group trust
check (`isTrustedFor`) stays the single choke point for peer trust. Installed plugins' HTTP MCP
servers are relayed by Noah; stdio MCP servers from knowledge, group or plugin repositories are
not started. Keep pi-gateway's `SANDBOX_EGRESS_ALLOW` minimal, and never list Noah in it.

## Verification

```bash
npm run lint
npm test
npm run build
```

`npm test` first runs `pretest` (`npm run build:client -- --mode test`), which builds the
Svelte/Vite client — a client compile error aborts the run before any Vitest test executes.

Smoke test: sign up (first user = admin) → open **내 아바타**, set a name/picture/bio,
click **아바타가 자동 생성** under 역량 해시태그, add a plugin → create a group in the admin
panel and add a second account to it → from that account, open **탐색**, search by a
hashtag, pick the teammate's avatar, and chat. Confirm the response streams and renders
markdown.

### 외부 아바타 작업 API

외부 시스템에서 개인 API 키로 자신의 아바타에게 자유로운 지시를 보내고, 작업 상태·결과를 조회하거나 추가 질문에 응답할 수 있습니다. **내 아바타 → 권한·연결 → 외부 작업 API**에서 키를 발급하세요. 호출 예제와 실행 정책은 [외부 아바타 작업 API 문서](docs/avatar-task-api.md)를 참고하세요.

### 사용자 간 DM

화면 오른쪽 아래 **메시지** 바를 누르면 작은 대화창이 위로 올라옵니다. 접속 중인 사용자 또는 이전 대화 상대를 선택해 1:1 메시지를 보냅니다. 모든 로그인 사용자가 그룹·아바타 공개 범위와 관계없이 사용할 수 있습니다. Enter로 전송하고 Shift+Enter로 줄을 바꿉니다.

- 대화창은 어느 화면에서든 보이고 모달이 아니어서 뒤 화면을 그대로 사용할 수 있습니다. 접으면 바만 남고, 펼친 상태와 마지막 대화 상대는 브라우저에 기억됩니다.
- 대화창 바깥을 누르면 접힙니다. 누른 곳은 그대로 동작하며, 보던 대화와 입력 중인 글은 유지되므로 다시 펼치면 이어서 씁니다.
- 화면이 좁은 모바일에서는 전체 너비 하단 시트로 열리며, 손잡이를 아래로 끌어 접습니다.
- 접속 중은 최근 1시간 내 활동 및 유효한 로그인 세션 기준입니다. 화면이 보이는 동안 5초마다 갱신하며, 접속 중 인원 수는 바에 표시됩니다.
- 읽지 않은 메시지는 바의 빨간 배지에 표시되고 새 메시지가 오면 한 번 커졌다 돌아옵니다. 대화를 펼쳐 확인하면 읽음 처리됩니다. 오프라인 상대에게도 기존 대화를 이어서 보낼 수 있습니다.
- 내가 보낸 메시지에는 상대가 열어 본 가장 최근 메시지 아래에 **읽음**, 그보다 나중에 보낸 메시지 아래에 **안 읽음**이 표시됩니다. 상대가 대화창을 펼쳐 확인한 시점에 읽음으로 기록되므로 표시가 5초 갱신 주기만큼 늦을 수 있습니다.
- 텍스트는 메시지당 최대 4,000자, 사용자당 분당 60개입니다. 이전 메시지는 50개씩 불러옵니다.
- 대화는 서버에 저장되고 재시작 후에도 유지됩니다. DM API에서는 대화 당사자만 내용을 조회할 수 있으며 아바타 대화·지식 저장소에는 포함되지 않습니다. 종단 간 암호화는 제공하지 않습니다.
- 계정 영구 삭제 시 해당 사용자가 보내거나 받은 DM도 삭제됩니다. 첨부파일·메시지 수정/삭제·차단·브라우저 푸시 알림은 제공하지 않습니다.
- 아바타의 사용 안내: 시스템 매뉴얼 `direct-messages` 항목. 아바타가 DM을 읽거나 대신 보내는 도구는 없습니다.
