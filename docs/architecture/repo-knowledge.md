# Repo plumbing and knowledge capture

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Clone/commit plumbing shared by the repo families, plus backfill / request_info / second-brain mechanics.

## Repo plumbing (`knowledgeRepo.ts` / `gitRepos.ts` / `repoGitCore.ts` / `repoGitGuards.ts`)
- **Low-level git is shared in `repoGitCore.ts`** (exec wrapper, `currentBranch`, dirty-status) and arg
  guards in `repoGitGuards.ts`. `knowledgeRepo.ts` is a thin context-resolver
  over it (so was `groupKnowledgeRepo.ts` until group knowledge repos were retired 2026-10-30); `gitRepos.ts` uses it too. **They were line-for-line mirrors before** — keep the shared core
  the single edit point for git-safety.
- **`dirtyPaths` flag difference is PRESERVED, not unified:** the knowledge repo uses `--porcelain`,
  `gitRepos` uses `--porcelain -uall`, threaded via the `extraStatusArgs` param. The knowledge-repo
  variant misses files inside otherwise-untracked dirs — a **latent bug flagged for a deliberate
  decision** (T3.7), NOT something to "fix" incidentally.
- **Git safety is THREE separate layers — don't merge them.**
  1. **Arg-safety: ONE validator, every clone path.** `assertSafeGitValue` (`repoGitGuards.ts`,
     re-exported via `repoGitCore.ts`) rejects leading-dash values and `scheme::` remote-helper syntax
     (`ext::sh -c …`). Used by `gitRepos.ts`, `knowledgeRepo.ts`, and
     `marketplace.ts`'s `assertSafeArg` (plugin clones). It is deliberately **transport-agnostic**: a bare
     local path is a LEGITIMATE repo source (`register_repo` accepts one by design, and every offline repo
     test clones from a local bare remote), so this layer must never reject one. Was T3.8 — the three
     non-`gitRepos` paths used to check only for a leading dash and leaned on git's own default protocol
     policy (`fatal: transport 'ext' not allowed`) to stop `ext::`.
  2. **Source/host POLICY: `isInternalGitSource` (`gitCredentials.ts`), the knowledge repo only.**
     It answers "is this on the internal GitHub host?" and **must fail CLOSED** — a non-shorthand source
     needs a PARSEABLE host matching `config.githubHost`. It used to return `true` for `host === null`,
     which (since `looksLikeRepo` accepts anything ending in `.git`) let any authenticated user point their
     knowledge repo at `dataDir/knowledge/<otherUserId>/.git` and read another user's private repo back
     through `/contents`, `/note`, `/graph` and the agent read tools. Was T3.11.
  3. **Registered-repo source policy: `assertAllowedGitSource` (`gitSourcePolicy.ts`), `mcp__git_repo__*`
     only.** Noah clones a registered repo in ITS OWN container (DB, every user's clones, the team-brain
     vault, secrets), so the source decides what Noah's git reads or connects to. Before 2026-11-11 an owner
     run could `register_repo` another user's clone / knowledge clone / the vault by path (also through a
     symlink or `file://`) and get its files, and git connected to loopback in every spelling
     (`2130706433`, `0x7f.1`, `[::ffff:127.0.0.1]`, `0.0.0.0`…). Refused now:
     - a **local path** (or `file://` URL, host ignored, path percent-decoded — as git reads it) whose
       lexical OR symlink-resolved location is inside a Noah-managed root: `dataDir`,
       `pi.workspacesDir`, `defaultPluginsDir`, the app root (`process.cwd()`). A path that does not exist
       yet is judged by its nearest existing ancestor; the four spellings git itself tries (`p`, `p.git`,
       `p/.git`, `p.git/.git`) are all judged. A relative path resolves against Noah's cwd, so a bare word
       (`foo`) is refused as inside the app root. A local repo anywhere else stays a legitimate source.
     - a **host** that IS loopback (`127/8`, `::1`, `localhost`, `*.localhost`), link-local
       (`169.254/16`, `fe80::/10`), `0.0.0.0/8` or `::` — in any `inet_aton` form (decimal/octal/hex,
       1–4 parts) and inside an IPv6 one (mapped `::ffff:`, compatible `::a.b.c.d`, NAT64 `64:ff9b::`) —
       or, on a path about to use the network (`resolve`: clone, sync, push), a name that RESOLVES to one
       (every returned address is checked). RFC 1918 and every other range stay allowed (the internal git
       host is private). The host is read BOTH as git does (authority up to the last `@`, percent-decoded)
       and as Node's URL does, each reading judged; a URL with a backslash/whitespace/control character
       is refused as unreadable (the `gitHostFromSource` differential).
     - a host[:port] that is one of **Noah's own internal services** (`internalServices`: `PI_GATEWAY_URL`,
       `NOAH_MCP_PUBLIC_URL`, `NOAH_EGRESS_CONTROL_URL`) — they sit on private addresses the classes above
       allow on purpose. Matched by name or literal address (any spelling) on every use, and on network
       paths also by what the source and the service RESOLVE to (another name for pi-gateway, its bare
       container address). The port must match (the transport's default when none is written:
       80/443/22/9418), so ssh to the same box or another port on it is not refused. Reason text:
       `host '<h>' is one of Noah's own internal services`.
     - **The configured git host is never judged** (`gitHostFromSource(source) === config.githubHost`,
       exact host[:port]) — an instance whose git host is on loopback keeps working. No other loopback
       use exists in the code or tests.
     - **Where:** `register_repo` checks before anything is stored (a refused source never becomes or
       replaces a row), and `ensureGitRepoCloneLocked` + `pushGitRepoDetailed` check on EVERY use — so a
       row registered before the policy with a refused source is refused at sync/open/commit/push/read
       with the SAME message (`GitSourceRefusedError`, returned verbatim by `sourceRefusal` in
       `gitRepoTools.ts`), never skipped or deleted; `list_repos`/`remove_repo` still work on it. Static
       checks run on every use; the DNS lookup only where the network is used, and a lookup that fails
       or exceeds 5 s passes (git reports its own error — required for the egress-proxy mode, where the
       Noah container resolves nothing).
     - **Transfer config** (`AllowedGitSource.gitConfig`, rides `serverGitEnv` next to the auth header):
       for an http(s) host that is NOT the configured one, `http.followRedirects=false` (git's default
       `initial` follows a 302 on `info/refs`, which sent git to `127.0.0.1` in a local test) and, after
       a successful lookup, `http.curloptResolve=host:port:addrs` (git ≥ 2.37) pins the connection to the
       checked addresses. Consequence: an external repo that answers with a redirect (renamed GitHub
       repo, `http://`→`https://`, a GitLab URL without `.git`) now fails with `The requested URL
       returned error: 301/302` — re-register it under its final URL. The configured host keeps git's
       default redirect behaviour.
     - **Plugins run the same policy (2026-11-11).** `POST /api/me/plugins` accepted anything
       `looksLikeRepo` likes (a path ending in `.git`), so another user's clone or the vault could be added
       and its files landed in `dataDir/plugins/<adder>/…`. Now: the route checks at entry (400, Korean —
       `gitSourceRefusalKorean(error)` keyed on `GitSourceRefusedError.code`, naming no path or address);
       `syncPluginRepoWithStatus` (`plugins.ts`) checks statically BEFORE the clone-once cache can answer
       and with `resolve` before the transfer, passing `gitConfig` to `syncGitRepo` (`sourceConfig`);
       `loadAvatarPluginRoots` never falls back to the cached clone of a refused source (it warns in Korean
       and skips). `/contents` and `/refresh` answer 400 for such a row; the row and its clone are not
       deleted (the owner's DELETE removes both). The bundled `defaultPluginsDir` is read in place, never
       through the clone path, so it is unaffected; there is no operator-configured local marketplace
       path. `mcp__system__add_plugin` (`systemTools.ts`) still stores without the entry check — the sync
       point refuses it, so nothing is cloned or loaded, but the row is created.
     - **Residual, by design or not closable here:** private-network hosts Noah does not know from its
       config (other compose services, anything else on RFC 1918) stay reachable as a blind
       `GET …/info/refs` — RFC 1918 is allowed on purpose; ssh/git transports are not pinned (rebinding
       between check and connect); with `HTTP(S)_PROXY` the PROXY resolves and connects, so only the
       literal checks bind and the pin is unused; the knowledge clone path (`knowledgeRepo.ts`) relies on
       its own internal-host gate, not this policy.
  When you add a repo entry point, decide which layers it needs: arg-safety ALWAYS, host policy only if the
  feature promises an internal-host-only source, the source policy whenever a USER-named source is cloned
  inside Noah's container (`syncGitRepo` is transfer-only: its caller runs the policy and passes
  `sourceConfig`). Offline tests keep their bare remotes OUTSIDE the test's `dataDir`.
- **`withRepoLock` (`gitMutex.ts`) is NOT reentrant by key** — a fn running under `withRepoLock(key,…)`
  must never call it again for the same key (deadlock). Outer ops call the `*Locked` internals directly.
- **`commitAndPushClone` self-heals around the remote:** before pushing it fetches and REBASES local
  commits onto `origin/<branch>` (absorbs non-conflicting external pushes that would otherwise leave the
  clone permanently diverged), and a CLEAN tree with unpushed local commits still pushes them (an explicit
  commit retry after a transient push failure works) — only clean+in-sync returns `false`/"no changes". A
  conflicting rebase is `--abort`ed (local commits preserved) and thrown as **`REBASE_CONFLICT:<files>`**;
  `repoToolKit.commitFailureMessage` decodes that sentinel into a conflict explanation (naming the files,
  telling the model to inform the user, not to retry-loop) instead of the misleading token/branch-protection
  hint. Lives in the shared core.
- **`stripManagedMcpServers` mutates `.mcp.json` in place.** Committable-repo write paths MUST
  `restoreTrackedMcpJson` (from HEAD) before `git add -A`, or the strip gets pushed to the user's repo.
  Preserve that ordering.
- **Knowledge repo = one per user, agent-managed.** The personal repo (`knowledge_repo` column,
  `get/setKnowledgeRepo`) is a FULL clone at `dataDir/knowledge/<userId>`. It's (a) auto-loaded as a
  plugin root in chat/skills/intro via `loadKnowledgeRepoRoots`/`knowledgeRepoSkillSources`, AND (b)
  edited by the avatar through the **owner-only** `mcp__repo__*` MCP server (`agent/repoTools.ts`):
  list/read/write/delete/move/scaffold/commit, plus `create_repo` (creates a GitHub repo via
  `gh repo create` server-side using the stored git token, then connects it with `setKnowledgeRepo`).
  `create_repo` is exposed **only when no repo is connected yet** (`allowCreate` ← `!knowledgeRepoConfigured`).
  Settings stores the repo location (`PUT /api/me/knowledge-repo`) plus an optional plugin subset
  (`knowledge_selected` column, `get/setKnowledgeSelected`, `PUT /api/me/knowledge-repo/selected`,
  inspected via `GET /api/me/knowledge-repo/contents`); `selected: null` = load all. `write_file`/
  `scaffold_skill` only touch the local clone — must be followed by `commit` to persist. (`ensureClone`
  re-syncs with `git checkout -B <branch> origin/<branch>`, not a hard reset.)
- **General git repos (`mcp__git_repo__*`) ≠ the knowledge repo.** Arbitrary work/code repos:
  `git_repositories` table (`get/list/upsert/delete/markGitRepoSynced`), plumbing in `gitRepos.ts`, MCP
  server in `agent/gitRepoTools.ts`. **Single working-surface model (NOT MCP file CRUD):** owner-only
  `register_repo`/`remove_repo`; owner OR trusted may `sync_repo`/`push` (remote git) and
  `open_repo`/`close_repo`. There are **NO status/write_file/delete_file/diff MCP tools** (the read-only
  `list_files`/`read_file`/`grep` exist ONLY for a run outside the owner's sandbox — a trusted colleague's chat, which
  never gets a copy, review #11; see [`pi-runtime.md`](pi-runtime.md) "Working repositories") —
  the avatar OPENS one repo as the conversation's **working directory** (`open_repo`), edits/tests its sandbox
  copy with NATIVE tools (read/edit/bash, local git for status/diff/log), and saves with `mcp__git_repo__commit`
  (`GIT_REPO_PI_COMMIT_TOOL_NAME`), which reads the copy back into the canonical clone. Each tool self-gates
  (`ownerGuard`/`elevatedGuard`, both `&& !headless`); the owner's git token is used server-side only
  (`gitAuthArgs`), with arg-injection (`assertSafeGitValue`) and path-traversal (`resolveInRepo`) guards.
  Public repos on internal hosts / github.com / other HTTPS hosts clone without a token; tokens are
  opportunistic. Unlike the knowledge repo, push EXTENDS to trusted users.
- **Working repository (avatar-opened, NOT a UI picker).** The avatar opens ONE registered git repo as
  this conversation's working directory with `open_repo`; `close_repo` clears it. The selection is held
  per-conversation and **persisted on `conversations.working_repo`** (`repoWorkspace.ts`
  `get/setWorkspaceRepo` are thin wrappers over `store.get/setConversationWorkingRepo`; deleting the
  conversation clears it for free). Persistence — not the old in-memory map — is what lets **routines**
  keep a working repo between their spaced-out runs and across restarts.
  **One shared resolver, `activeRepoResolve.ts` `resolveActiveWorkspaceRepo`, is used by BOTH the chat
  route (turn start) AND the routine scheduler (before a headless run)** so they can't drift: it reads
  the selection → resolves/ensures the canonical clone (no sync) → configures commit identity, and with the
  run's `piWorkspace` only creates a MISSING sandbox copy. That copy is ONE per (principal, owner, repo), shared by
  all of the principal's conversations, so the pi branch takes the run lock on the COPY (`piRepoCopyLockKey` in
  `activeRepoLock.ts` → `locked`; `open_repo`/`sync_repo`/`commit` take the same lock mid-turn and the run keeps it
  until it ends — `RunRepoLocks`) and claims it (`claimPiRepoCopy` → `held` while another conversation that still has
  the repo open left uncommitted changes); the chat route answers 409 and the scheduler skips with `ROUTINE_REPO_BUSY`. The avatar works on that COPY in its principal's sandbox,
  `/workspace/repos/<owner-seg>/<name>/` (design D1): native read/edit/bash + LOCAL git for status/diff/log there,
  while `commit` (reads the copy's working tree back into the canonical clone and commits THERE), `push` and
  `sync_repo` stay MCP. `open_repo` returns the copy's sandbox path and takes effect THIS turn. `open_repo` needs
  `request.conversationId` — the chat route and the scheduler both thread it; only a run with NO conversation
  (e.g. intro gen) can't open one. Noah never runs git in a sandbox `.git` (its config could run commands in Noah's
  container or redirect the token), so the copy's local commits are never read. The canonical clone path is NEVER
  returned to the client. Copy mechanics, caps and the moved-base refusal → [`pi-runtime.md`](pi-runtime.md)
  "Working repositories".

## Knowledge backfill, request_info, second brain — mechanics
- Owner sees pending `request_info` gaps in-app via a "내 아바타" nav badge + a poll/visibility watcher
  that toasts on new gaps (`refreshKnowledgeStatus`/`startKnowledgeWatch` in `lib/loaders.ts`).
- **Knowledge-repo `CLAUDE.md` is injected as standing memory.** The repo-root `CLAUDE.md` of the
  personal repo is read DIRECTLY from the clone (NOT via
  any loader), size-capped, and rendered into the prompt via `AgentRequest.knowledgeMemory` (`loadKnowledgeRepoMemory` in plugins.ts → `knowledgeMemorySection` in
  promptBuilder.ts) — distinct from on-demand skills, with an injection guard. The prompt is frozen per
  conversation (D2, `conversations.pi_instructions`), so the memory is the one read at the conversation's first
  turn; an edit mid-conversation applies from the next conversation. Wired in chat + scheduler;
  intro/hashtag gen leaves it unset. (Group repo CLAUDE.md files were injected too until group knowledge
  repos were retired, 2026-10-30.) `writeRepoTemplate` seeds a
  starter root `CLAUDE.md`.
- **Second brain (#53) = a CONVENTION over the SAME knowledge repo, NOT a new store — PERSONAL.** (The
  ONE instance-wide team brain, back 2026-11-06, is a separate Noah-owned local vault with its own
  proposal queue → [`team-brain.md`](team-brain.md); it shares the `brain` server, but its vault is a
  stricter LLM wiki: server-rendered `raw/` sources, a FIXED server-validated `SCHEMA.md`, server-generated index/log.)
  `wiki/` (curated) + `raw/` (capture) are just directories inside the owner's personal knowledge repo.
  The team brain (`mcp__group_brain__*`, group vault scaffolding, group graph) was REMOVED 2026-10-30 (user
  decision), and group knowledge repos with it; `group_brain`/`group_repo` are retired pi broker ids (`RETIRED_MCP_SERVER_NAMES` in
  `scripts/pi-register-mcp.mjs` deletes stale entries) and reserved shared-MCP names. **Recall** is read-only
  search: `mcp__brain__*` (`search`/`get_note`, gated `elevated`). Both metacognition surfaces (the prompt's
  `brainSection` and the `describe_system` brain line) check the per-conversation `personal_knowledge`
  tool-group toggle FIRST — mirroring `buildRunCapabilities`' `brainActive` — so a deselected group reads as
  OFF, never as active; both also say there is no team repository or team brain
  (`GROUP_REPOS_RETIRED_SENTENCE` — needed because older frozen `pi_instructions` still name the
  `mcp__group_repo__*` tools). **Capture/consolidate** is the
  `brain-ingest`/`brain-reflect` default-skills, which WRITE through `mcp__repo__write_file` + `commit` —
  there is NO separate "brain write" tool, so a
  capture is a repo write plus a commit (uncommitted = not persisted). It composes with the backfill
  loop: `request_info` ESCALATES a true unknown to the owner, `brain-ingest` RETAINS the answer.
- **The Brain policy (user, 2026-11-10, SSOT) — ONE module, `agent/brainPolicy.ts`.** Every rule about
  what goes into the personal brain vs the team brain lives there and nowhere else: `PERSONAL_KNOWLEDGE_DEFINITION`
  (capture WITHOUT asking first, then say what was saved), `TEAM_KNOWLEDGE_DEFINITION` (the four tests — moved
  here, re-exported from `teamBrainTools.ts`), `BRAIN_ROUTING_RULE` (decide the home first; a submission may
  also live in the personal brain until approved and is linked via `personalNotes`), `BRAIN_LINK_CHECK_RULE`
  ("BEFORE A TEAM CARD": search the personal brain for the topic before every team card and pass the notes
  that state the same fact — the execution point of one-fact-one-home, #82), `BRAIN_ONE_HOME_RULE`
  (once approved the team page is canonical), `BRAIN_CONFLICT_RULE` (no precedence: show BOTH, labeled
  내 브레인 / 팀 브레인, and ask), `PROMOTED_NOTE_RULE` (turning an approved note into a link is ASKED in plain
  words with five required points and done only on a yes — never forced, never by the server).
  `brainPolicySection` renders the **Brain policy** prompt section per run (write rules only where the run can
  write; conflict/one-home only with both brains); read_manual's `knowledge` guide uses
  `brainPolicyManualText`; tool results quote the same constants. The brain-* + team-brain-curate skills and
  the repo-template `CLAUDE.md` REFER to "the Brain policy in your instructions" instead of restating it —
  `tests/brain-policy.test.ts` pins both halves. Personal search stays `wiki/`-only (user, 2026-11-10).
  It scores the first `BRAIN_SCAN_CAP` (2000) notes in path order and SAYS when a vault is larger
  (`unscannedNote`, on a hit and on a miss) — the same rule as the team search, [`team-brain.md`](team-brain.md) "Tools".
  Read-time marks of promoted / link notes (`team_page:` frontmatter) → [`team-brain.md`](team-brain.md)
  "Personal-note links".
- **`wiki/` notes state the CURRENT truth; change history lives in `raw/` + git.** `brain-lint` (the
  hygiene default-skill — skill-only, no server lint code; the `[[link]]` resolution the graph view uses
  lives in `knowledgeGraph.ts` — the brain view's clickable `[[links]]` re-resolve client-side in
  `src/client/src/lib/knowledgeGraph.ts` (`resolveWikilink`: title/stem/path, no aliases — keep the
  two in step); the structural `wiki/index.md`, `wiki/log.md` and `_template.md` are
  excluded from BOTH `rankBrainNotes` and `buildKnowledgeGraph`, so an empty vault renders the
  empty state and the TOC never becomes a hub) strips "previously X, changed to Y on <date>" narrative
  out of `wiki/` notes and never edits `raw/` (the original-capture archive) or `wiki/log.md`
  (brain-reflect's append-only pass log); removed history is NOT relocated anywhere. Fixes go through
  `edit_file` (snippet replacement), never a `write_file` rewrite. The WRITE side carries the same rule:
  brain-reflect REPLACES a changed value and records it as one terse `old → new` line in `wiki/log.md`,
  brain-ingest keeps the dated context in the `raw/` capture — `tests/agent-core.test.ts` pins all
  three wordings. The standing prompt states the same rule too (`brainSection` in `promptBuilder.ts`,
  the `currentTruth` sentence) on every WRITE-capable run — owner/routine, shared-account teammate —
  and on no read-only one (plain teammate, consultation), because the avatar also
  edits `wiki/` directly with the repo tools, where a skill-only rule would never reach.
- **Capture notice ("기억" chip):** a SUCCESSFUL `write_file`/`edit_file` under `wiki/` of the personal repo fires `AgentEvents.onMemory` (`MemoryEvent`, gated in the tool
  handlers via `isBrainNotePath`) → SSE `memory` (server-minted `id` so reattach replays dedupe) → a
  `kind:"memory"` activity row (label "기억 추가·갱신됨", detail = note path) that persists
  through the normal activity snapshot. **Rendering is summary-line-only:** `ActivityTree` EXCLUDES
  memory rows from the tree; the chat view's `memoryChip` (`views/chat/controller.tsx`) renders them as a 🧠 chip on the activity
  disclosure's `<summary>` (live + completed cards), so the capture is visible while COLLAPSED —
  the whole point, since the tool list is folded by default. `raw/` writes stay silent BY DESIGN
  (a brain-ingest capture writes raw + wiki — one notice per capture, not two). Fires on write, not
  commit: the capture skills commit immediately after, and per-write is what maps 1:1 to notes.
