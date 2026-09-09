# Noah Almighty

A platform where each user signs up, builds an **avatar** (profile + GitHub plugins +
personal knowledge repo), browses coworkers' avatars, and chats with any avatar they can reach.
Chats run through the Claude Agent SDK with a tiered permission model — read-only for
plain colleagues, elevated (write/SSH/repo) for owners and group co-members.

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
  setup, chat, knowledge, skills/plugins, groups/bots, scheduling, external Task API integration,
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
- **PowerPoint decks**: the avatar can generate PowerPoint (`.pptx`) presentations, preview the
  rendered slides in the chat (in the canvas side panel when enabled, inline otherwise), and hand
  over the finished deck as a download card.
- **draw.io diagrams**: the avatar can author `.drawio` diagrams (or pass along ones it fetched,
  e.g. Confluence attachments) and hand them over as download cards; the chat renders them as
  interactive diagrams (zoom/pan/pages) in the file side panel, fully offline via a vendored
  draw.io viewer.
- **Scheduled routines**: owners can create one-time or recurring chat jobs (`/api/me/routines`)
  for a specific KST date/time, daily/weekly slots, or a fixed interval. The avatar executes
  them headlessly and keeps each run's result in a dedicated routine conversation.
  The `/routine <task>` chat command creates a routine inline. The avatar itself can manage
  routines via the `mcp__system__*_routine` tools.
- **Groups**: the system admin creates named teams (`/api/admin/groups*`) and assigns group
  admins. Group co-membership in an avatar-sharing group is the SOLE source of trust/elevation —
  co-members **auto-trust each other symmetrically**: they see each other's `group`-visibility
  avatars and get elevated tool access (write-capable tools with a per-tool prompt) when chatting
  with a co-member's avatar. There is no per-user "trusted users" list anymore — `isTrustedFor` IS
  group co-membership (`shareAnyGroup`), the single choke point. Each group has one shared
  **knowledge repo** whose skills are auto-loaded for all member avatars; group admins edit it via
  the `mcp__group_repo__*` tools. Group self-serve (member/repo management) is at `/api/me/groups*`.
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
- **External avatars**: operators can register stateless agents in **관리자 ▸ 외부 아바타**
  (encrypted at rest) or as read-only deployment entries with `EXTERNAL_AGENTS_JSON`. They
  appear in Explore and use the same Noah transcript/activity
  UI, while each turn sends the full stored text history to an external
  `POST /v1/agents/messages` endpoint. Their gateway owns model, system prompt, and tools;
  Noah does not expose local model/effort, MCP, repo/plugin, routine, or image controls for
  them. The event stream must declare schema `claude-agent-sdk-message-v1` and wrap normalized
  Claude Agent SDK envelopes in `sdk_message` events. `visibleToGroupIds` (a non-empty list of
  Noah group UUIDs) is REQUIRED for anyone to see the avatar: an entry without it still parses
  but is visible to no one until groups are assigned (the admin UI enforces this on save; env
  entries need the JSON edited + a restart). This group list is a Noah visibility ACL only; it
  neither changes gateway tools nor grants local trust/elevation. System admins must also be
  members of an allowed group to chat; removing membership blocks the next detail/chat request
  but does not erase that user's existing conversation history or interrupt a run already started.
  Existing conversations are bound to their original endpoint, so changing a static env endpoint
  does not forward prior transcripts; start a new conversation after such a change.
  The admin screen supports create/edit, activation, group selection, write-only Gateway API
  keys, safety timeouts, and a side-effect-free Gateway auth/model check. Environment entries
  remain read-only and win an ID collision, so existing deployments keep their behavior.
- **Per-conversation model picker**: the chat composer lets any user choose a model
  tier (Opus / Sonnet / Haiku) per conversation; the choice persists on the conversation
  and rides each turn. **Opus is the default** when nothing is picked. Operators map each
  tier to a concrete model id via `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` (the picker
  shows the mapped id). An env-pinned `ANTHROPIC_MODEL` hard-locks the model and hides the picker.
- **Tiered chat permissions**: the Claude Agent SDK runs with `permissionMode: "default"`.
  A `PreToolUse` hook is the single gate for all tool calls:
  - **Owner** (chatting with own avatar): all tools auto-approved with no prompt, including
    Write/Edit/Bash, repo commit/push, SSH, knowledge-backfill, and routine management.
  - **Elevated viewer** (group co-member in an avatar-sharing group): same tool set, but each
    non-read tool requires an interactive per-tool allow/deny prompt.
  - **Plain colleague / headless routines**: read-only tools only (`READONLY_TOOLS`,
    default `Read,Glob,Grep`), plus in-process MCP tools that self-gate to owner/elevated
    in their handlers.
  - Streaming, markdown rendering, conversations, and per-message actions (copy,
    regenerate, edit-and-resend) are supported for all viewer classes.
- **Admin**: list users, grant/revoke the `admin` role, delete accounts, manage groups
  (create/delete teams, assign group admins, manage members), and configure the subscription
  login (관리자 ▸ 구독 로그인) — paste the output of `claude setup-token` to use a Claude
  subscription instead of an `ANTHROPIC_API_KEY`. System info (model, subscription status,
  API key override) is at `GET /api/admin/system`.

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:48787`, click **회원가입**, and create the first account (it becomes admin).

## Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

The image includes Node.js, git, GitHub CLI (`gh`), Python 3, ripgrep, `jq`, `uv`, LibreOffice,
poppler-utils, Korean (Nanum) fonts, and `python-pptx` (backing the avatar's PowerPoint generation).
SQLite data and uploaded avatar images persist under `APP_DATA_DIR`. The container runs as the
non-root `node` user.

On a closed corporate network, optional build args (in `docker-compose.yml`, all empty by default =
public upstreams) route installs through internal mirrors. Alongside the existing `APT_MIRROR_HOST`,
`NPM_CONFIG_REGISTRY`, and `CA_CERT_FILE`, two cover the PyPI fetch of `python-pptx`:

- `PIP_INDEX_URL` — internal PyPI index URL used by `pip install` at build time.
- `PIP_TRUSTED_HOST` — host to trust when that PyPI mirror uses HTTP or a self-signed cert.

## Speech-to-text (optional)

The composer's mic button records an utterance, posts it to `POST /api/stt`, and drops the
transcript into the chat input. It appears only when a transcription endpoint is configured, so this
whole section is opt-in — as is the `stt` compose service, which lives behind a `stt` profile and is
ignored by a plain `docker compose up`. `Alt+M` toggles recording from anywhere in the chat view, so
you never have to reach for the button.

There are two ways to configure that endpoint: the `STT_URL`/`STT_MODEL`/`STT_LANGUAGE` env trio
below, or the admin panel (관리자 → 시스템), which stores an endpoint at runtime and needs no
redeploy. **The admin value wins** when both are set; env stays the fallback the panel displays and
what a cleared override returns to. Users see the mic appear (or disappear) on their next page load.

Every transcription is biased toward Korean (`STT_LANGUAGE`, default `ko`) rather than leaving the
engine to detect a language: a short Korean utterance is exactly the case auto-detection gets wrong.
Set it to `auto` if your users speak something else, or per endpoint in the admin panel.

The mic stops itself when you finish speaking — a Silero voice-activity detector runs in the browser
(fully offline, served from this deployment like every other asset, and lazy-loaded on the first
recording, so the first mic click fetches roughly 8MB once). Stopping manually and the 60-second cap
both still apply, and a recording with no speech in it is discarded without a transcription request.
There is nothing to configure: it is on wherever the mic button is, and if it fails to load the mic
simply falls back to stopping only when you click it.

The reference engine is **Qwen3-ASR-1.7B** (Apache 2.0) served by vLLM on the deploy host's GPU.
The deploy host has no Hugging Face or internet access, so both artifacts are carried in by hand:

1. **Provision offline.** The engine runs a small DERIVED image, `noah-almighty-stt:v0.27.1-audio`
   (`docker/stt.Dockerfile`): the official `vllm/vllm-openai` image ships **without** vLLM's
   `[audio]` extra, so every transcription request would fail inside it with
   `ImportError: Please install vllm[audio] for audio support` — the derived image adds the four
   packages that extra resolves to (soundfile, PyAV, soxr, scipy) on top of the pinned base and
   changes nothing else. On a machine with internet access, download the weights and build the
   image, then transfer both to the deploy host:

   ```bash
   huggingface-cli download Qwen/Qwen3-ASR-1.7B --local-dir Qwen3-ASR-1.7B
   docker compose --profile stt build stt      # builds noah-almighty-stt:v0.27.1-audio
   docker save noah-almighty-stt:v0.27.1-audio -o noah-stt.tar
   ```

   (Behind a corporate mirror/proxy, export `PIP_INDEX_URL`/`PIP_TRUSTED_HOST` and the proxy vars
   first — the build forwards them exactly like the app image's build, and an intercepting proxy's
   CA rides the same `CA_CERT_FILE` build arg the app image trusts.) On the deploy host, the
   weights go to `./docker/stt-models/Qwen3-ASR-1.7B` (the directory is git-ignored and
   bind-mounted read-only at `/models`), and the image goes straight in with
   `docker load -i noah-stt.tar`, which keeps the name `docker-compose.yml` expects so no edit is
   needed — the offline host never builds anything. If you route it through the corporate registry
   instead, edit the compose file's `image:` to the exact reference you pushed.

2. **Start it.** Add `STT_URL=http://stt:8000/v1` to `.env`, then one command starts the engine and
   recreates the app container so it reads the new `.env`:

   ```bash
   docker compose --profile stt up -d
   ```

   Keep passing `--profile stt` (or export `COMPOSE_PROFILES=stt`) for later `up`/`down` on this
   deployment — without it, compose does not manage the `stt` service at all. The container publishes
   **no host port**: it is reachable only from the compose network, and Noah's authenticated
   `POST /api/stt` is the only way in. First start takes a few minutes to load weights; watch
   `docker compose --profile stt logs -f stt` until the healthcheck goes healthy.

3. **Verify.** Call the upstream from inside the app container, which also proves the compose network
   resolves `stt`. `--noproxy '*'` matters when a corporate `HTTP_PROXY` is set in `.env`:

   ```bash
   docker compose cp sample.wav noah-almighty:/tmp/sample.wav   # a few seconds of mono speech
   docker compose exec noah-almighty curl -sS --noproxy '*' \
     -F file=@/tmp/sample.wav -F model=Qwen/Qwen3-ASR-1.7B \
     http://stt:8000/v1/audio/transcriptions
   # {"text":"..."}
   ```

   Then confirm end to end with the mic button in the composer — this second check is NOT optional
   redundancy: the browser records WebM/Ogg/MP4 (which is what `/api/stt` accepts), and vLLM decodes
   WebM through a different library (PyAV) than the WAV above (libsndfile), so only the mic proves
   the container the fleet actually sends.

**Check this at deploy time:** confirm the vLLM build you pinned exposes `/v1/audio/transcriptions`
for Qwen3-ASR (day-0 support was announced upstream, but it is version-dependent — the `curl` above
is the check). If your pinned build lacks it, point `STT_URL` at any OpenAI-compatible wrapper
serving the same contract: the app depends on the contract, not on vLLM or on this model. A CPU-only
host can run speaches/faster-whisper instead, with no code change.

## Configuration

| Env | Purpose |
| --- | --- |
| `SESSION_SECRET` | Session token hashing secret (required in production). |
| `SECURE_COOKIES` | `true` to mark the session cookie `Secure` (HTTPS-only). Leave unset for plain-HTTP deployments (e.g. local docker-compose) or the cookie is never sent back and login fails. |
| `AGENT_RUNTIME` | `claude` (default) or `local` (offline stub, no plugin execution). |
| `EXTERNAL_AGENTS_JSON` | Optional read-only JSON array of stateless external avatars (the admin UI can manage additional entries). Each entry requires `id`, `displayName`, and exactly one of `endpoint` or `baseUrl`; an exact endpoint must end in `/v1/agents/messages`, while a base URL gets that suffix appended. The v1 contract supports only `agent: "claude"`. Entries also support public `alias`/`bio`/`persona`/`intro`/`hashtags`, a non-empty `visibleToGroupIds` for Noah group visibility (REQUIRED for the avatar to be visible — omitting it keeps the entry parseable but hidden from everyone until groups are assigned), private upstream `model`, `system`, and `apiKeyEnv` (preferred) or `apiKey`, plus positive `connectTimeoutSeconds` (default 15), `idleTimeoutSeconds` (default 120), and `totalTimeoutSeconds` (default 1800). Values are stable group IDs from the admin groups API/UI and are never returned by public avatar APIs. Environment entries are read-only and take precedence over a UI entry with the same ID. Public ids are `external:<id>`. |
| `ANTHROPIC_API_KEY` | Optional; absent → SDK uses subscription token (admin UI) or local Claude Code auth. |
| `ANTHROPIC_MODEL` | Optional. Pin the Claude model (e.g. `claude-opus-4-8`). When set it's a **hard lock**: the per-conversation model picker is hidden. Absent → the resolution chain below (defaulting to Opus). |
| `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL` | Optional. Map each composer model TIER (Fable/Opus/Sonnet/Haiku) to a concrete model id; the picker shows the mapped id. Unset tier → SDK resolves the alias to the account default (shown as just the tier label). Precedence: `ANTHROPIC_MODEL` > user's per-conversation tier > admin override > **Opus** (default). |
| `PORT` / `APP_DATA_DIR` | Server port (default `48787`) / data directory (SQLite DB + avatar images). |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | Optional PEM cert/key paths that switch the app's own listener to HTTPS — set both or the boot refuses (docker-compose mounts `./docker/tls` → `/app/tls`). HTTPS gives pages a secure context, which the browser-bridge one-click update (File System Access) requires. Set `SECURE_COOKIES=true` with it. |
| `READONLY_TOOLS` | Tool allowlist for unelevated colleague chat sessions (default `Read,Glob,Grep`). |
| `GITHUB_HOST` | Internal/default GitHub host for shorthand repo values like `owner/repo` (default `github.com`). Knowledge repos must use this host; full github.com URLs can use `GITHUB_TOKEN`. |
| `GITHUB_CA_CERT` | Optional PEM CA bundle for on-prem GitHub Enterprise (GHES) with a private CA. |
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | Optional corporate proxy for outbound web access — used by the `mcp__web__fetch` avatar tool and inherited by the SDK subprocess (built-in WebFetch/WebSearch). Put intranet hosts/domain suffixes in `NO_PROXY` so they bypass the proxy. |
| `NODE_EXTRA_CA_CERTS` | Optional PEM bundle for intranet HTTPS behind a private corporate CA — honored by the app process (`mcp__web__fetch`) and the SDK subprocess (built-in WebFetch). Docker images built with the `CA_CERT_FILE` arg already contain `/usr/local/share/ca-certificates/extra-proxy-ca.crt`. |
| `CONFLUENCE_URL` | Optional app-wide Confluence Server/Data Center base URL for page, attachment, and image/draw.io asset tools. Per-avatar PATs are stored as the `CONFLUENCE_PAT` user secret. |
| `STT_URL` | Optional OpenAI-compatible speech-to-text base URL including `/v1` (e.g. `http://stt:8000/v1`) — the composer's mic button posts the recording to `<STT_URL>/audio/transcriptions`. **Unset (default) hides the mic button** unless an admin configured an endpoint in 관리자 → 시스템, which also **overrides** this value when both are set. Any engine serving that contract works; see [Speech-to-text](#speech-to-text-optional). |
| `STT_MODEL` | Model name sent with each transcription request (default `Qwen/Qwen3-ASR-1.7B`). Must match what the upstream serves — vLLM's `--served-model-name`. The admin panel can override it per endpoint; an override that names no model inherits this one. |
| `STT_LANGUAGE` | ISO-639-1 code sent with each transcription request to bias it toward one language (default `ko`). Set `auto` to send no language at all and let the engine detect it. The upstream validates the code against what the served model supports. The admin panel can override it under the same precedence as the URL; an override that names no language inherits this one. |
| `BROWSER_ALLOWED_ORIGINS` | Optional comma-separated DEFAULT browser-control allowlist (`intra.example.com,*.corp.local`). Seeded once into a browser whose extension allowlist is still empty — a user-edited or managed (enterprise-policy) list is never touched, and the user can change it afterwards in 설정 → 접근/보안. Entries that would cover Noah's own host (including a bare `*`) are dropped before serving: the app UI must never become drivable by default. |
| `LOG_LEVEL` | Pino log level: `trace`/`debug`/`info`/`warn`/`error` (default `debug` in dev, `info` in prod). |
| `MAX_TURNS` | Maximum agent turns per chat run (default `1000`). |
| `AUTO_COMPACT_WINDOW` | Optional. Compact the conversation near this many context tokens instead of waiting for the model's full context window (lower = cheaper turns, more frequent summarization). Clamped to `100000`–`1000000`; non-numeric or `≤ 0` is ignored. Unset → the model's full window. |
| `ROUTINE_RUN_TIMEOUT_MINUTES` | Wall-clock deadline for one scheduled-routine run (default `30`, minimum `1` — it cannot be disabled). Covers the whole run, model-fallback retries included. `지금 실행` holds its HTTP request open for up to this long, so keep it under any reverse proxy's read timeout. |
| `DEFAULT_PLUGINS_DIR` | Path to built-in skills loaded for every avatar (default `<cwd>/default-skills`). |
| `PLUGIN_AUTO_REFRESH_MINUTES` | Minutes before an enabled avatar plugin clone is refreshed from git at chat/routine start (default `10`; `0` disables auto refresh after the first clone). |
| `BROWSER_BRIDGE_MULTIMEDIA_NOTICE` | `true`/`1`/`on` adds a corporate-policy line to the browser-bridge install guide telling users to unpack the extension into the upload-approved **Multimedia** folder. Default: hidden. |
| `ENV_FILE` | Override the `.env` file path loaded at startup (default `.env` in cwd). |
| `BROWSER_BRIDGE_ORIGINS` | **Release machine only** (`npm run build:extension-update`, not the server). Noah address(es) baked into the released extension's `externally_connectable`, comma-separated; bare origin or match pattern. Required for the policy install channel — a policy-installed extension missing the real address cannot be fixed on the machine and its bridge fails silently. |
| `BROWSER_EXTENSION_KEY_FILE` | **Release machine only.** Path to the RSA private key signing extension updates. Keep it outside the repo and back it up — the extension id derives from it. |

## Security note

Avatar plugins are arbitrary GitHub repositories loaded by the Claude Agent SDK. The tool
permission model is tiered — owners and group co-members can run elevated tools
(Write/Edit/Bash, repo commit/push, SSH); plain colleague chats are read-only. The
`PreToolUse` hook in `src/server/agent/claudeAgent.ts` is the single enforcement gate; all
in-process MCP server handlers self-gate for owner/elevated checks. Loading a third-party
plugin still executes its code on the server. For a public/production deployment, run plugin
execution in a sandbox (container/VM per request, network egress limits).

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

왼쪽 사이드바 하단의 **DM**에서 접속 중인 사용자 또는 이전 대화 상대를 선택해 1:1 메시지를 보냅니다. 모든 로그인 사용자가 그룹·아바타 공개 범위와 관계없이 사용할 수 있습니다. Enter로 전송하고 Shift+Enter로 줄을 바꿉니다.

- 접속 중은 최근 1시간 내 활동 및 유효한 로그인 세션 기준입니다. 화면이 보이는 동안 5초마다 갱신합니다.
- 읽지 않은 메시지는 DM 배지에 표시되며, 대화창을 열어 확인하면 읽음 처리됩니다. 오프라인 상대에게도 기존 대화를 이어서 보낼 수 있습니다.
- 텍스트는 메시지당 최대 4,000자, 사용자당 분당 60개입니다. 이전 메시지는 50개씩 불러옵니다.
- 대화는 서버에 저장되고 재시작 후에도 유지됩니다. DM API에서는 대화 당사자만 내용을 조회할 수 있으며 아바타 대화·지식 저장소에는 포함되지 않습니다. 종단 간 암호화는 제공하지 않습니다.
- 계정 영구 삭제 시 해당 사용자가 보내거나 받은 DM도 삭제됩니다. 첨부파일·메시지 수정/삭제·차단·브라우저 푸시 알림은 제공하지 않습니다.
- 아바타의 사용 안내: 시스템 매뉴얼 `direct-messages` 항목. 아바타가 DM을 읽거나 대신 보내는 도구는 없습니다.
