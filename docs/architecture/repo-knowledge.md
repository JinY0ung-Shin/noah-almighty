# Repo plumbing and knowledge capture

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Clone/commit plumbing shared by the repo families, plus backfill / request_info / second-brain mechanics,
> and the personal vault's two homes (the repository, or the bundled memory service with a git mirror).

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
       path. `mcp__system__plugin` action `add` (`systemTools.ts`) still stores without the entry check — the sync
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
  re-syncs with `git checkout -B <branch> origin/<branch>`, not a hard reset.) **The one exception is a
  vault note of an owner whose vault home is `memory`**: it never touches the clone and is saved when
  written → "Personal vault: two homes" below.
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
  any loader; for an owner whose vault home is `memory`, from the memory service instead — same cap,
  "Personal vault: two homes" below), size-capped, and rendered into the prompt via `AgentRequest.knowledgeMemory` (`loadKnowledgeRepoMemory` in plugins.ts → `knowledgeMemorySection` in
  promptBuilder.ts) — distinct from on-demand skills, with an injection guard. The prompt is frozen per
  conversation (D2, `conversations.pi_instructions`), so the memory is the one read at the conversation's first
  turn; an edit mid-conversation applies from the next conversation. Wired in chat + scheduler;
  intro/hashtag gen leaves it unset. (Group repo CLAUDE.md files were injected too until group knowledge
  repos were retired, 2026-10-30.) `writeRepoTemplate` seeds a
  starter root `CLAUDE.md`.
- **Second brain (#53) = a CONVENTION (`wiki/` + `raw/` paths) behind the SAME repo tools — PERSONAL.** It
  is not a tool family of its own, and for an owner whose vault home is `repo` it is not a store of its own
  either: the notes are files of the knowledge repo. For home `memory` the same paths, tools and gates reach
  the memory service ("Personal vault: two homes" below); this bullet describes what both share. (The
  ONE instance-wide team brain, back 2026-11-06, is a separate Noah-owned local vault that every teammate
  writes through cards they press themselves (no review queue since 2026-11-13) →
  [`team-brain.md`](team-brain.md); it shares the `brain` server, but its vault is a
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
  capture is a repo write plus a commit (home `repo`: uncommitted = not persisted; home `memory`: the note
  is saved by the write and the commit pushes its copy — the skills say "commit after writing" for both,
  state no home of their own, and tell saved from not saved by the tool result's words). It composes with the backfill
  loop: `request_info` ESCALATES a true unknown to the owner, `brain-ingest` RETAINS the answer.
- **The Brain policy (user, 2026-11-10, SSOT) — ONE module, `agent/brainPolicy.ts`.** Every rule about
  what goes into the personal brain vs the team brain lives there and nowhere else: `PERSONAL_KNOWLEDGE_DEFINITION`
  (capture WITHOUT asking first, then say what was saved), `TEAM_KNOWLEDGE_DEFINITION` (the four tests — moved
  here, re-exported from `teamBrainTools.ts`), `BRAIN_ROUTING_RULE` (decide the home first; team knowledge may
  also live in the personal brain while the user has not said yes or has not pressed its card, and is linked
  via `personalNotes` when the card is drafted), `BRAIN_LINK_CHECK_RULE`
  ("BEFORE A TEAM CARD": search the personal brain for the topic before every `prepare_team_changes` card —
  new knowledge and corrections alike — and pass the notes
  that state the same fact — the execution point of one-fact-one-home, #82), `BRAIN_ONE_HOME_RULE`
  (once a fact is in the team brain the team page is canonical), `BRAIN_CONFLICT_RULE` (no precedence: show
  BOTH, labeled 내 브레인 / 팀 브레인, and ask; the team-side fix is a correction card the user presses),
  `PROMOTED_NOTE_RULE` (turning a note whose fact went into the team brain into a link is ASKED in plain
  words with five required points and done only on a yes — never forced, never by the server).
  The wording follows the 2026-11-13 change (every teammate writes the team brain directly; nothing is
  "submitted" or "approved" any more) — the rules themselves did not change.
  `brainPolicySection` renders the **Brain policy** prompt section per run (write rules only where the run can
  write; conflict/one-home only with both brains). **The prompt carries only the rules judged on EVERY turn**
  (PERSONAL KNOWLEDGE, WHERE IT GOES, ONE FACT ONE HOME, WHEN THEY DISAGREE — prompt diet, user 2026-11-17);
  the rules with a known moment (BEFORE A TEAM CARD, SELECTING FOR THE TEAM, KEPT PERSONAL, PROMOTED NOTES)
  ride it only as ONE pointer that names each moment, and their text is read_manual topic `brain-policy`
  (`BRAIN_POLICY_MANUAL_TOPIC`, `brainPolicyManualText`; the `knowledge` guide embeds it too). Every tool result
  that hits such a moment names the rule AND the topic (`inBrainPolicy(name)`); the owner's `get_note` on a
  PROMOTED note carries `PROMOTED_NOTE_RULE` itself. **A new rule goes into the prompt only when it is judged
  on every turn; otherwise into the topic, with a pointer moment and a tool result that names it.** The
  brain-* + team-brain-curate skills and the repo-template `CLAUDE.md` REFER to `BRAIN_POLICY_REFERENCE` ("the
  Brain policy (`mcp__system__read_manual` topic `brain-policy`)") instead of restating it —
  `tests/brain-policy.test.ts` pins both halves. Personal search stays `wiki/`-only (user, 2026-11-10).
  It scores the first `BRAIN_SCAN_CAP` (2000) notes in path order and SAYS when a vault is larger
  (`unscannedNote`, on a hit and on a miss) — the same rule as the team search, [`team-brain.md`](team-brain.md) "Tools".
  Read-time marks of promoted / link notes (`team_page:` frontmatter) → [`team-brain.md`](team-brain.md)
  "Personal-note links".
- **Selecting personal notes for the team (user, 2026-11-12) — the `brain-share` default skill + three rules in
  `brainPolicy.ts`.** `TEAM_SHARE_LEVEL_RULE` ("THE RIGHT LEVEL": the reusable conclusion, never the working
  detail; only the PART of a note that states it) sits next to the four tests in the team-brain prompt
  section and the manual, so it gates the everyday OFFER TO SHARE and the selection pass alike.
  `TEAM_SHARE_PASS_RULE` ("SELECTING FOR THE TEAM", runs that can capture AND write the team brain): asking
  for the pass is the yes to DRAFT, never to share; at most `TEAM_SHARE_PASS_MAX` (3) cards per pass — a
  default the admins' POLICY.md guidelines may replace (it is the avatar's own bound, so the server has
  nothing to enforce; `max_open_proposals` stays the hard cap) and, since nobody reviews a card after the
  press, small enough to read before pressing; **each card is a `prepare_team_changes` card that writes the
  team brain when pressed, so each is pressed on its own — there is no button for all of them (2026-11-13;
  the 초안 N건 모두 제출 press went with the review queue)**; never a LINK / PROMOTED / kept-personal note or a
  fact that the team brain or an unpressed card of this conversation already holds; in a pass the source is
  the note's passage (verbatim) and the intake comes from the note
  — the `prepare_team_changes` description says the same, so the two never pull apart. `BRAIN_KEPT_PERSONAL_RULE` ("KEPT PERSONAL"): a declined note (or one whose card the user cancelled and, asked once, wants left out) gets
  frontmatter `team_share: no` (`PERSONAL_TEAM_SHARE_KEY`), written by the avatar with `mcp__repo__edit_file`
  + commit — the owner's own decision in the owner's own repo, so it is not the "nothing writes the personal
  repo" case (that one is about applied cards). The server's one part: `personalNotes` refuses such a note
  (`isKeptPersonalNote`, `brainTools.ts`). The skill is procedure only — no number, no criteria, no key
  spelling of its own (`tests/brain-policy.test.ts`); in a run without `prepare_team_changes` it stops instead
  of judging by rules the run does not carry. `brain-reflect` ends with ONE line pointing at it, on runs that
  can write the team brain only. The cards and their press → [`team-brain.md`](team-brain.md) "Cards and routes".
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
- **The graph opens with `raw/` hidden (user, 2026-11-13), both brains.** The server still returns every
  `raw/` node (`buildKnowledgeGraph` is unchanged); the client's `defaultHiddenSections`
  (`lib/knowledgeGraph.ts`) starts the legend with the raw chip OFF — unless raw notes are all the vault
  has — and every newly loaded graph starts from that default again. Hiding is view-only: search, the
  side lists and the note counts still include raw. `GraphCanvas` frames the visible nodes after the
  layout, re-frames when the legend SHOWS a section, and shows a hidden section by itself when a note in
  it is opened from outside the canvas (search, a side list, a `[[link]]`).
- **A node's `section` is its color and its legend chip.** The personal vault's is the folder
  (`vaultSectionOf`: `raw` / `sources` / `entities` / `concepts` / `synthesis`, else `wiki`); the team
  vault passes its own (`buildKnowledgeGraph(root, { sectionOf })`) → [`team-brain.md`](team-brain.md).
  Colors, labels and legend order live in ONE place, `lib/knowledgeGraph.ts` (`SECTION_COLORS` — read its
  comment before changing a hue: the set is measured, not picked by eye).
- **Capture notice ("기억" chip):** a SUCCESSFUL `write_file`/`edit_file` under `wiki/` of the personal repo fires `AgentEvents.onMemory` (`MemoryEvent`, gated in the tool
  handlers via `isBrainNotePath`) → SSE `memory` (server-minted `id` so reattach replays dedupe) → a
  `kind:"memory"` activity row (label "기억 추가·갱신됨", detail = note path) that persists
  through the normal activity snapshot. **Rendering is summary-line-only:** `ActivityTree` EXCLUDES
  memory rows from the tree; the chat view's `memoryChip` (`views/chat/controller.tsx`) renders them as a 🧠 chip on the activity
  disclosure's `<summary>` (live + completed cards), so the capture is visible while COLLAPSED —
  the whole point, since the tool list is folded by default. `raw/` writes stay silent BY DESIGN
  (a brain-ingest capture writes raw + wiki — one notice per capture, not two). Fires on write, not
  commit: the capture skills commit immediately after, and per-write is what maps 1:1 to notes. The same
  for both vault homes.

## Personal vault: two homes (#84, 2026-11-17)

An owner's **personal vault** is the repo-root `CLAUDE.md` plus every `.md` note under `wiki/` and `raw/` of
their knowledge repository. Where it is stored — its **home** — is per owner: `repo` (the clone on disk IS the
vault, as it always was) or `memory` (the bundled stack's memory service is the vault, and the repository
receives a copy). Everything else in the knowledge repo (skills, plugins, `.gitkeep`, images, any non-markdown
file, also under `wiki/`/`raw/`) is a **repo path** and lives in git whatever the home. The team brain is not
part of this: it stays Noah's own local vault ([`team-brain.md`](team-brain.md)).

### The rule and its questions (`personalVault.ts`)
- **ONE writer per owner.** Home `repo`: the clone code, unchanged. Home `memory`: a vault note is read and
  written ONLY through the service; the clone's files at vault paths are the mirror's copies (or, while the
  mirror is on hold, the connected repository's own notes) — written by the mirror alone, read by nobody.
  There is no fallback from one to the other: a second writer is what the design removes.
- **Every vault WRITE of an owner, in BOTH homes, runs in the owner's vault write queue and decides the home
  INSIDE it** (`withVaultWrite(store, config, userId, fn)`: `fn` gets `{ home: "repo" }` — run the clone code
  here, inside the queue — or `{ home: "memory", vault }`, a writer whose `write`/`edit`/`remove` do not take
  the queue again and that is closed when `fn` returns, `VAULT_WRITER_CLOSED`). The cutover and the rollback
  hold the SAME queue (`withVaultWriteLock`), so a tool call can never pick a home, wait, and write into the
  one that is no longer the vault — whatever run it comes from (owner chat, routine, task API, a
  shared-account teammate). That, not run tracking, is what makes a flip safe. A write queued behind a
  cutover or rollback simply runs after it, against the new home. **A new tool path that changes a vault
  path goes through `withVaultWrite`**; `VAULT_HOME_CHANGED` stays as a defensive error it should not reach.
- **Lock order is always vault write queue → clone repo lock** (`withRepoLock`). Take the repo lock INSIDE
  the queue's callback, never around it; nothing holding the repo lock asks for the queue. The queue is in
  process and NOT reentrant: inside it use the queue's writer or the `MemoryClient`, never a
  `memoryVaultFor` write, `withVaultWrite` or `withVaultWriteLock` for the same owner.
- **"Is this path a vault note?" → `isPersonalVaultPath(rel)`**, never a regex of your own. It is NARROWER than
  "`CLAUDE.md` or `(wiki|raw)/**.md`": a markdown file the service cannot hold stays a repo path (a folder or
  name starting with a dot such as `wiki/.obsidian/x.md`, a backslash or control character, more than 16
  segments, a path over 512 bytes or a segment over 255). `normalizeVaultPath` strips leading `./` and `/`,
  posix-normalizes and NFC-normalizes (the form the service stores). **A tool's path ARGUMENT is classified
  by ONE function, `vaultNotePathOf` (`repoToolKit.ts`, used by the repo tools and `brainTools.ts`)**, which
  reads it the way the clone file ops would resolve it — so no spelling of a note (`./wiki/a.md`,
  `wiki//a.md`, `wiki/x/../a.md`, `wiki/a.md/`) reaches the clone's copy.
- **"Where does this owner's vault live?" → `vaultHomeOf(store, userId)`**: a `personal_vaults` row = `memory`
  (`store/personalVault.ts`). The instance setting `personalVaultMode` (fails to `repo`) is only the TARGET
  the migration works towards — never read it to decide where to read or write.
- **`memoryVaultFor(store, config, userId)`** — for READS (and for a write that is not a tool's vault change):
  the owner's `MemoryVault` when the home is `memory`, else `null` (= the clone code). It never throws and
  never falls back: a row on a server with no memory service configured yields a vault whose every method
  rejects with `MemoryUnavailableError` (`reason: "not_configured"`).
- **`MemoryVault`** (`list` / `read` / `exists` / `write` / `edit` / `remove` / `search`) throws the SAME
  sentinels as `knowledgeRepo` so tool wording is shared (`NOT_FOUND`, `INVALID_PATH` — also for a non-vault
  path or a folder —, `FILE_TOO_LARGE`, the `editFile` ones), `MemoryRefusedError` as it is (`wiki_full`,
  `invalid_content`, a `stale` that survived the one retry) and `MemoryUnavailableError` as it is. `list()` is
  in code-unit path order (`CLAUDE.md` < `raw/…` < `wiki/…`); there are no folder operations (a folder
  delete/move works per note); `exists()` reads the whole note.
- **The row** (`personal_vaults`): provenance (`migratedAt`, `sourceRepo`, `sourceCommit`) and the mirror's
  state — `mirrorDirty` + `mirrorSeq`, `mirrorSyncedAt`, `mirrorError`, `mirrorNotice`, `mirrorHold`
  (`"checking" | "confirm" | null`), `mirrorReplaceAll`. **The deletion ledger** (`personal_vault_deletes`:
  `recordVaultDelete` / `listVaultDeletes` / `clearVaultDeletes`) lists the paths Noah deleted and the mirror
  has not settled yet. `clearPersonalVault` and `deleteUser` remove both.
- **The mirror is marked dirty for every change that was SENT** (`markVaultMirrorDirty`, bumping
  `mirrorSeq`), also when the answer was lost — and a lost answer marks it ONCE MORE 60 s later
  (`VAULT_LOST_ANSWER_REMARK_MS`): the service may carry the change out after a pass already read the old
  content and recorded itself clean. `MemoryVault.remove` writes the ledger entry BEFORE it asks the service.
- **The brain still requires a connected knowledge repo** (`knowledgeRepoConfigured` gates are unchanged), and
  no tool name, argument, run-class gate or path changed: what changed is where a vault note is stored.

### What reads and writes the service for home `memory` (`agent/repoTools.ts`, `repoToolKit.ts`, `brainTools.ts`)
- **The tools never touch a clone file at a vault path** — not to read, write, move or delete it. Those files
  are the mirror's. A folder that holds nothing but such files "does not exist" for the tools.
- `mcp__repo__list_files` → `mergeVaultTree`: the clone tree with its vault-note entries dropped and every
  service note listed. Under `wiki/` and `raw/` a folder is shown only when it holds a repo file or a
  service note (the service has no empty folders).
- `read_file` / `write_file` / `edit_file` / `delete_file` on a vault path → the service. A vault note's
  success text says it "is saved now" and that `mcp__repo__commit` pushes its copy (`VAULT_NOTE_SAVED`; a
  deletion / a move "is saved now" likewise); a repo path keeps "(Not committed yet — push it with
  mcp__repo__commit.)". The standing guidance keys on exactly these two phrases (skills, tour, manual).
- **A folder delete** removes the folder's notes in the service (first — a failure there leaves the clone
  untouched) and, in the clone, ONLY the repo files under it; a failure half-way says how many notes went.
- **`move_file`** is carried out file by file, each on the side it belongs to (note → note in the service;
  note → repo path; repo file → note; repo file → repo path). **A folder move MERGES into an existing
  destination**: it refuses, before anything moves, only a destination file that exists with DIFFERENT text
  (a folder move never overwrites; a single file's move does, as a rename always did), a folder onto a note
  path, and a file/folder mismatch. **It is RESUMABLE**: a destination that already holds exactly the
  source's text counts as copied — only the source is then removed — so the same call finishes a move that
  failed half-way, and a failure names the files that exist at BOTH paths at that moment.
- **Two refusals that close what the spelling cannot see** (both only for home `memory`):
  `assertNoVaultAlias` — a path that is not a vault path as spelled but RESOLVES, through a link committed in
  the repository, into the clone's vault folders (`notes -> wiki`: `notes/a.md`) is `INVALID_PATH` (a delete
  of the link itself is allowed); `noteTreeCollision` — creating a repo file at `wiki/topic` while notes live
  under `wiki/topic/`, or a path under a note (`wiki/a.md/x.txt`), is refused: the mirror could no longer
  write that folder.
- **`mcp__repo__commit`** (`commitWithVaultMirror`): mirror → commit → fetch and rebase onto what the remote
  got meanwhile → mirror AGAIN on the rebased tree → commit that if it changed anything → push → record.
  Detail under "The git mirror". The tool itself holds no lock: `commitAndPush` takes the clone's repo lock
  and runs the tool's `beforeCommit` hook inside it (twice when it rebased). The result reports the LAST
  pass, so "up to date" is said only when the pass on the rebased tree succeeded; a copy that was not updated
  is worded as "the notes themselves are saved; only their copy is behind", with the hold state named
  (`checking`: follows by itself; `confirm`: tell the owner) and a notice quoted.
- `mcp__brain__search` (personal) → `MemoryVault.search`; `get_note` and `personalNotes` → `MemoryVault.read`
  (paths through `vaultNotePathOf`). Team marks and `personalNoteBlobId` are computed from the returned
  content exactly as before (a git blob id is a hash of the content). **In a search of BOTH brains a
  personal side that could not be searched — unavailable OR refused — is an error next to the team hits**,
  never a silent "no personal match".
- The graph and note routes (`routes/knowledgeRepo.ts`, `knowledgeGraph.ts`) and a consultation's recall.
- **The standing memory** (`loadKnowledgeRepoMemory` → `readVaultClaudeMd`, same 6,000-character cap and
  truncation mark) is read with a **3 s deadline** (`STANDING_MEMORY_VAULT_DEADLINE_MS`) so a hanging service
  cannot hold a turn. When the service is down or too slow, the slot carries
  `STANDING_MEMORY_UNAVAILABLE_NOTICE` instead of the text (Noah's notice, not the owner's words — the
  guidance could not be loaded, it is not empty, and how to read it later): the prompt is frozen per
  conversation, and a missing memory must never look like "the owner has no standing guidance". A missing or
  empty `CLAUDE.md` is still simply nothing.
- `create_repo` / the repository template: inside the write queue; repo paths go to the clone, the template's
  vault notes (`CLAUDE.md`, `wiki/index.md`, `wiki/log.md`, `wiki/_template.md`) to the service unless the
  vault already holds a note at that path.
- The 기억 chip (`onMemory`) fires as before, on the write.
- **A service failure is reported AS a failure**: tools answer with an error that says the memory service is
  unavailable and that this is not an empty result (`memoryUnavailableMessage` — for a write: the change may
  or may not have landed, read again before repeating it); routes answer 503 with a Korean `apiError`
  (`메모리 서비스` — text a teammate reads never names pi-gateway). Never "not found", "no match" or an
  empty graph.

### The service contract Noah relies on (`memory/memoryClient.ts`)
The service is pi-gateway's `apps/memory`: one markdown wiki per owner. Noah uses its PROGRAM API only, with
`Authorization: Bearer <key>` and the owner in the URL — the Noah user id the CALLER decided on, never a
model argument (`OWNER_PATTERN` is checked before the id becomes a URL).

| Request | Answer |
|---|---|
| `GET /wiki/<owner>/notes?prefix=<folder>` | `{notes:[{path,bytes}]}`, path order; `prefix` is a FOLDER |
| `GET /wiki/<owner>/note?path=` | `{path,content,hash}` — the whole note |
| `PUT /wiki/<owner>/note` `{path,content,hash?}` | `{path,hash,created}`; no hash = create (409 `exists`), hash = replace (409 `stale` when changed or gone) |
| `DELETE /wiki/<owner>/note?path=&hash=` | `{path}`; a missing note is 404 `not_found` (the client resolves) |
| `GET /wiki/<owner>/search?q=&limit=&prefix=` | `{hits:[{path,title,tags,snippet,score}],unscanned}`, limit 1..20 |
| `DELETE /wiki/<owner>` | `{deleted:true}` |

- **Its rules:** relative `.md` paths stored NFC, no segment starting with a dot, no `..`, at most 16 segments;
  a note is at most 512 KiB of UTF-8 text without NUL (`VAULT_NOTE_MAX_BYTES` = `knowledgeRepo`'s
  `MAX_FILE_BYTES`); `hash` = sha256 hex of the bytes; a wiki holds at most 10,000 notes / 256 MiB.
- **Two failures, kept apart on purpose.** `MemoryRefusedError` (`code`, `status`): the service answered and
  said no — a coded 4xx other than 401 / `no_route`, and 507 `wiki_full` (a refusal the owner can fix, not an
  outage). `MemoryUnavailableError` (`reason`: `not_configured` | `network` | `timeout` | `unauthorized` |
  `no_route` | `server_error` | `bad_answer`): it could not be used at all. A caller reports the second as an
  outage — never as "no such note".
- **The client:** 15 s per request, redirects refused (the key goes to the configured address only), answers
  capped at 32 MiB, the key scrubbed from every error and log line, only a system error CODE passed on from a
  transport failure. `memoryClientFor(store, config)` is the one client of an app instance (null when
  `config.memory` is unset); tests install a double with `setMemoryClientForTests`
  (`tests/helpers/fakeMemory.ts` — the same rules by hand, never imported by `src/`).
- **Config** (`parseMemoryConfig`, `config.ts`): `PI_MEMORY_URL` + `PI_MEMORY_API_KEY_FILE`, both or neither
  (neither = `config.memory` undefined: the feature is off and nobody can be moved). The key is read from a
  FILE only — an inline `PI_MEMORY_API_KEY`, half a configuration, or an unreadable/empty file stops the boot
  — so it never enters `process.env` and no child inherits it. The URL joins `internalServices`
  (`gitSourcePolicy.ts`): it cannot be registered as a git source.
- **Not one of pi's MCP servers** (decided 2026-11-17): pi has no per-request server filter, so a registered
  memory server would show every Noah session a second, UNGATED set of memory tools, and a broker registration
  can only name the requesting user, never an avatar owner. Noah's own `repo` / `brain` tools are the only
  way in, so every run-class gate stays where it was. **This is an OPERATOR rule, not an enforced one:**
  nothing in Noah's code prevents or detects a registration made on pi's MCP page — the rule and what breaks
  are in [`pi-runtime.md`](pi-runtime.md) ("Memory service").

### The git mirror (`vaultMirror.ts`, `repoGitCore.ts`)
The repository keeps a COPY that Noah's server writes and never reads back to decide content.
- **What one pass does to the clone** (`syncVaultMirror`), for paths where `isPersonalVaultPath` is true and
  for no other file:
  - ADD / REPLACE every note the service holds (a file is compared only to skip an identical write).
  - **DELETE only what Noah deleted:** a clone vault file is removed when its path is in the owner's deletion
    ledger AND the service no longer holds it. The entries a pass settled are cleared when that pass is
    recorded ok; an entry whose note the pass still saw stays.
  - **A clone vault file the service lacks and the ledger does not name is NEVER deleted** — a note that only
    exists in git, a wiped service volume. The pass still ends `synced` and leaves a NOTICE on the row:
    `repository notes not in the memory service: <count>` (`VAULT_MIRROR_NOTICE`). There is no
    empty-service guard and no error for it any more: deleting the last note reaches the repository (it is in
    the ledger), and a wiped service deletes nothing.
  - **The one exception is the owner's own press:** with the row's one-shot `mirrorReplaceAll` set (by
    `mirror-confirm`, below) that pass makes the repository's vault paths EQUAL to the service — unledgered
    vault files are deleted too — and the flag is cleared with the record.
- **Never through a link:** every clone file operation of the mirror (list, write, unlink, rmdir) goes through
  one helper (`CloneVaultFiles`) whose one gate (`locate`) walks down from the clone root and crosses plain
  folders only. A WRITE below a linked folder (or a file where a folder should be) fails the pass (`path
  blocked: …`); a DELETE or a lookup there is treated as "the mirror has no file there" — nothing is touched.
  A link sitting at a note's own path is replaced by a plain file, never written through. Only Noah's canonical
  clone (`dataDir/knowledge/<userId>`) is touched — never a sandbox copy.
- **`push: true`** (the background loop, the rollback, the first record after a cutover) also commits as the
  owner (`VAULT_MIRROR_COMMIT_MESSAGE`) and pushes with the owner's stored token — an ordinary, never forced
  push. **`push: false, locked: true`** only writes the working tree and returns `pending`; the caller (the
  `commit` tool's hook) finalizes it with `finishVaultMirror` once ITS push is over — synced when it went
  through, the failure when it did not. Row and ledger are settled only after a push.
- **A commit never fights a direct git edit of a vault note** (`commitAndPushClone` with `vaultPaths`): when
  the local commits have to be rebased onto remote ones and a rebase stop's conflicted paths are ALL vault
  paths, the local side — the service's content — is kept (`keepLocalSide`: its text where it has the file,
  its deletion where it deleted a file both knew) and the rebase goes on; the edit stays in git history. A
  path only the REMOTE added (a rename done in git, say) is kept, not deleted, and is counted in the notice.
  **A conflict that touches any other path aborts** as before (local commits preserved,
  `REBASE_CONFLICT:<files>`), as does a rebase that cannot start. After the rebase and before the push the
  mirror hook runs AGAIN (`afterRebase`, only when a rebase actually happened) — the remote's commits may
  have changed vault files — and what it changes is a second commit on top (`followUpMessage`: "Mirror vault
  notes from Noah"). Then push. Options: `commitAndPush` takes `beforeCommit` + `vaultPaths`;
  `commitAndPushClone` takes `checkStaged`, `vaultPaths`, `afterRebase`, `followUpMessage`.
- **Nothing to commit and nothing unpushed = no fetch.** `commitAndPushClone` returns before it fetches, so a
  direct git edit of a vault note stays on the remote until a later pass has something to push — an idle
  vault leaves it standing.
- **A pass re-checks under the lock:** after it has the clone's repo lock it reads the row again — a rollback
  (no row) ends it with nothing done, a hold that arrived while it waited is `skipped: hold`.
- **When:** on every `mcp__repo__commit` of that owner, and in the background loop (`startVaultMirrorLoop`,
  started at boot only when `config.memory` is set): at start EVERY vault is marked for a pass — a crash
  between a service write and its dirty mark loses the mark — then a pass runs right away and again 60 s
  after each one ends; it mirrors the dirty owners one at a time and stops early when the service is down.
- **A write that arrives during a pass is not lost:** the pass reads `mirrorSeq` before it reads the service
  and hands it back, and `recordVaultMirror` clears `mirrorDirty` only if the row was not marked since.
- **The background pass never touches a clone with uncommitted changes OUTSIDE vault paths** (`skipped:
  repo_dirty`, `mirrorError = "repo has uncommitted changes"`, stays dirty): the avatar's own `commit` carries
  the mirror. That keeps `git add -A` safe without stashing (`checkStaged` looks at the staged paths once
  more).
- **A failed push pauses nothing in memory:** the note stays saved, the row stays dirty, `mirrorError` says
  why (`VAULT_MIRROR_ERROR`: stable texts — `no git token`, `memory service unavailable (<reason>)`, `push
  failed: …`, `rebase conflict: …` (outside the vault), `path blocked: …`, …), the next pass retries.
- **Hold (`mirrorHold`):** `checking` or `confirm` — the mirror writes nothing into the connected repository
  (`skipped: hold`); see "Repository connected or changed" below.
- **A vault note EDITED directly in git is not read back** — the next mirror commit restores the service's
  version, and the edit stays in git history. **A note ADDED directly in git stays there** (the notice) but
  is not part of the brain: search and read do not see it. The repository template, the settings card and
  both self-knowledge surfaces say so.

### Moving a vault (`vaultMigration.ts`, `routes/personalVault.ts`)
Per owner, one at a time, resumable; ONE background job per app instance, started by an admin route or by a
repository change, never at boot. Until an owner is cut over they work on the repository exactly as before.
- **The migration takes NO database backup — the way back is in how it works.** A cutover deletes and
  rewrites no source file and adds ONE database row; every note is read back and hash-compared before the
  home flips; a failed import withdraws what that attempt wrote (`discardImported` — only notes that still
  are exactly what it sent), so the service is left as it was found; a rollback requires the mirror to end
  `synced` first, so the repository holds every note before the row goes; whatever a rollback or a leftover
  clear would delete from the service without a copy elsewhere is set aside first (quarantine, in Noah's data
  dir).
- **What `store.retirementGate()` does here:** it is asked before every cutover, every rollback and the
  leftover-clearing step, and it only REFUSES. The gate backs the database up at boot ONLY when retired data
  is present (`retirementDataPresent` — an ordinary boot writes no backup file); when that backup FAILED, the
  gate stays closed for the rest of that boot and these steps answer `backup_failed` until a later boot's
  backup works. Do not describe it as "the migration backs up first".
- **Dry run** (`planVaultMigration`): what would be imported and what would not — nothing is skipped
  silently. `skipped` lists files under `wiki/` / `raw/` that are not vault notes (`VAULT_SKIP`: not markdown,
  a dot name, too deep, too long, a link, …): they stay in the repository and are served from the clone. It
  changes nothing in the service or the database (each clone is synced with its remote, as any run does), so
  it is not audited.
- **Cutover** (`cutoverVault`; idempotent — a note already there with the same hash is skipped) holds the
  owner's vault write queue for its whole length, then the clone's repo lock. It syncs the clone, checks that
  the clone IS its remote branch, scans the vault files without following a link, compares with what the
  service holds, imports, and verifies. **The home flips only when the service holds EXACTLY the clone's
  vault** — every note read back with the clone's hash and no other vault note of that owner in the service.
  **What it decided before it waited is asked again once the lock is held, and what a flip depends on once
  more in the same tick as the flip:** the user still exists, the SAME repository and branch are connected, no
  run is in progress — otherwise it stops (`no_user`, `repo_changed`, `run_in_progress`) and withdraws what it
  imported; a newly connected repository is handled by its own hook. The first mirror record follows; its
  failure never undoes the move.
- **`ownerRunInProgress` is a courtesy, not the safety:** it counts the owner's routines and their chat /
  task-API turns on their own avatar, and — on a SHARED account, where teammates write the repository too —
  any teammate's chat with the avatar. It only avoids moving a vault under a run whose frozen prompt describes
  the other home; a write can never straddle a flip because of the write queue (above).
- **Blockers** (`VAULT_BLOCKER`, `<code>: <detail>`; the admin screen words them in Korean). A blocked owner
  stays on `repo` and is retried on the next pass.
  - `no_git_token` — no git token at all, or (an https remote) none for THAT repository's host. Checked
    before anything is fetched: a vault moved without a token could never be mirrored.
  - `sync_failed`, `uncommitted_changes`, `unpushed_commits` — the clone must be exactly its remote branch.
  - `note_too_large` (over 512 KiB), `not_utf8`, `invalid_content` (a NUL) — the service could not hold it.
  - `note_conflict` — two files of the CLONE are one note path once normalized (NFC), with different
    content. Nothing to do with the service: the owner has to settle it in the repository.
  - `vault_folder_link` — `wiki` or `raw` in the repository is a link or a file, not a plain folder: the
    mirror never writes through a link, so no note under it could ever be copied back.
  - **The two leftover blockers** (`VAULT_LEFTOVER_BLOCKERS` — the admin screen offers 남은 사본 비우기 on
    exactly these codes): **`service_note_conflict`** — the SERVICE already holds a different note at a path
    of the clone; **`service_only_note`** — the SERVICE holds a vault note the clone does not have. Both mean
    the service still holds something for an owner on `repo`; the owner is not moved until it is cleared.
  - `repo_changed` — the connected repository or branch changed while this owner was being looked at; the
    new one is handled on its own. `no_user` — no such user, or the user was deleted meanwhile.
  - `wiki_full`, `source_changed` (a file changed while it was imported), `verify_failed`, `refused`,
    `memory_not_configured`, `memory_unavailable`, `backup_failed`, `run_in_progress`, `internal_error`.
- **Every earlier state has an outcome:** a repo with `wiki/` and/or `raw/` → notes and `CLAUDE.md` imported;
  a repo that predates the vault layout → `CLAUDE.md` imported if present (`brain-migrate` then builds the
  skeleton in the service through the same repo tools); no repository → `no_repo`, nothing to import (the
  vault starts in the service when one is connected).
- **Rollback** (`rollbackVault(store, config, userId, { expect })`), inside the owner's write queue:
  1. `expect` (`"memory"` | `"repo"`) is the home the caller believes the owner has. When it is not, NOTHING
     is done (`home_mismatch`) — a stale screen must not turn "discard the leftover copy" into a real
     rollback, or the reverse.
  2. The gate, then `syncVaultMirror({ push: true })` must end `synced` and the row must not be dirty. A
     mirror on hold, without a repository, blocked by a dirty clone, failed or still behind refuses with its
     reason (`VAULT_ROLLBACK_REFUSAL`). It never falls back to an older copy. **A notice does NOT block:**
     the repository then holds everything the service has, and more.
  3. Wiki notes that are NOT vault paths (the mirror does not carry them) are quarantined — before the flip,
     so a note that cannot be saved leaves everything as it was (`leftover_not_saved`).
  4. `clearPersonalVault` (the flip), THEN `deleteWiki(owner)` — a wiki deleted under a row that still says
     `memory` would be mirrored as deletions.
- **Recovery after a lost service volume = roll the owner back, then move them again.** The mirror of an
  emptied service deletes nothing (no ledger entry names those notes), ends `synced` with a notice, the
  rollback goes through, and the repository — which still holds the notes as last pushed — is the vault
  again; the next cutover imports them. Notes written after the last successful push are gone with the
  volume.
- **Clearing a leftover copy:** for an owner ALREADY on `repo` the same call with `expect: "repo"` (the admin
  screen's 메모리 서비스에 남은 사본 비우기) discards what the service still holds for them — nothing reads
  it, and it blocks the next cutover (`service_only_note`, `service_note_conflict`) until it is gone. That
  copy was never verified against the repository, so every note of the wiki — vault path or not — that the
  owner's clone does not hold BYTE FOR BYTE (the clone as it is on disk, no link followed) is quarantined
  first; a note that cannot be read or put aside stops the step and nothing is deleted
  (`leftover_not_saved`). A successful clear also drops that owner's cached report.
- **The quarantine** (`quarantineLeftoverNotes`): written under `<dataDir>/personal-vault-leftover/<user>/
  <time>/<note path>` and moved at once to `<dataDir>/retired/<boot stamp>/` + the same path with the
  retirement helpers (`openRetirementSweep`, `quarantineRetired`; Noah never prunes it). Nothing to set aside
  → nothing is written. The audit row states the counts; the HTTP answer stays `{ ok: true }`.
- **Operating order — to KEEP someone on the repository, set the mode to `repo` FIRST, then roll back.**
  While the mode is `memory`, a rolled-back owner is cut over again by the next pass or by their next
  repository change. Mode `memory` → `repo` only stops NEW cutovers (also in the middle of a pass); it
  rolls nobody back.
- **Repository connected or changed** (`onKnowledgeRepoChanged`, fire-and-forget, called by
  `PUT /api/me/knowledge-repo` when the repository OR its branch changed — a branch holds its own vault
  files; a re-save of the same pair is not a change — and by `create_repo` after its first commit).
  - Home `repo`, mode `memory`: the owner is cut over, queued behind any running job. Only
    `run_in_progress` is retried here (a repository the avatar created with `create_repo` is connected in the
    middle of a run); every other blocker waits for the next pass.
  - Home `memory`: **the hold is set to `checking` the moment the change is stored** — before anything could
    write into the new repository — and an armed `mirrorReplaceAll` is disarmed (it confirmed the PREVIOUS
    repository). The queued check (`settleRepoChange`, inside the write queue and the repo lock, re-reading
    the connected repository and branch before every change of state) then settles it:
    - **lift** (and mark dirty — the mirror continues into it): the repository holds no vault file, or every
      vault note it holds is already in the service with the same content (a repository reconnected);
    - **`confirm`**: both hold notes and the repository has vault notes of its own — only the owner's press
      lets the copy replace them;
    - **import**: the service's wiki is EMPTY and the repository holds vault notes → they are imported as in a
      cutover (same blockers) and the hold is lifted;
    - **stays `checking`**: the repository could not be looked at or the import was blocked (no token,
      unreachable, the service down, a blocker) — or the owner connected yet another repository meanwhile,
      which has its own check queued.
  - **Retries:** both follow-ups are retried every 60 s, at most 30 times (`repoChangeRetry`), and every
    migration pass re-checks every mirror still `checking`. The owner can ask for the look again NOW
    (`POST /api/me/personal-vault/mirror-recheck`, the settings card's 지금 다시 확인): it does nothing unless
    the hold is `checking`, and never changes the hold by itself.
  - **The owner's press** (`POST /api/me/personal-vault/mirror-confirm`, body `{ repo, branch }`): accepted
    only in the `confirm` state and only when the connected repository and branch are the ones the body names
    (a stale screen confirms nothing) — every other case is 409. It lifts the hold, arms `mirrorReplaceAll`
    and marks the mirror dirty: the next pass makes the repository's vault paths equal to the service.
  - A disconnected repository changes nothing: there is nothing to import and nowhere to mirror.
- **Deleting a user:** `deleteWiki(owner)` runs INSIDE that owner's vault write queue (`routes/admin.ts`,
  best effort, logged) — after any queued write or cutover in progress, so the wiki cannot come back; a
  cutover in progress sees the user is gone right before the flip and does not flip. `deleteUser` removes the
  row and the ledger. No quarantine here: the user is being deleted.
- **Routes** (`createPersonalVaultRouter`, mounted after the admin router):
  | Route | Who | What | Audit id |
  |---|---|---|---|
  | `GET /api/admin/personal-vaults` | admin | mode, `serviceConfigured`, `running`, per owner: state, repo, `migratedAt`, mirror, the last report this process still holds | — |
  | `POST /api/admin/personal-vaults/dry-run` | admin | `{ reports }`, 4 owners at a time | — (changes nothing) |
  | `POST /api/admin/personal-vaults/mode` | admin | `{ mode }` → `{ mode, started }`; `memory` starts a pass, refused 409 with no service configured | `set_personal_vault_mode` |
  | `POST /api/admin/personal-vaults/run` | admin | 202 `{ started }` (false when one is running; audited only when it started); 409 while the mode is `repo` or no service is configured | `personal_vault_run` |
  | `POST /api/admin/personal-vaults/:userId/rollback` | admin | body `{ expect: "memory" \| "repo" }` (400 without it) → `{ ok: true }`; 409 with the Korean reason when refused, also for a home that is not the expected one. The audit row says which of the two happened, with the quarantine counts | `personal_vault_rollback` |
  | `GET /api/me/personal-vault` | owner | `{ home, mirror }` (`mirror` null for home `repo`) | — |
  | `POST /api/me/personal-vault/mirror-recheck` | owner | 202 `{ started }` (false unless the hold is `checking`) | — |
  | `POST /api/me/personal-vault/mirror-confirm` | owner | body `{ repo, branch }` → `{ ok: true }`; 409 otherwise | `personal_vault_mirror_confirm` |

  `mirror` in both GETs is `{ dirty, syncedAt, error, hold: "checking" | "confirm" | null, notice }`.
  UI: 관리자 → 시스템 → 개인 브레인 이전; 설정 → 지식·플러그인 → 지식 저장소 (브레인 노트 보관) —
  [`client.md`](client.md) "Personal vault screens".

### Search: what differs from `rankBrainNotes`
`MemoryVault.search` asks the service with prefix `wiki` and drops `wiki/index.md`, `wiki/log.md` and
`*_template.md` itself, returning the same `BrainSearchResult`. What is the SERVICE's and Noah cannot change:
- the body score looks at the whole note text INCLUDING its frontmatter block (the clone ranker scores the
  body without it), so a word that appears only in frontmatter can now hit;
- `no_vault` needs at least one note under `wiki/` or `raw/` — the service has no empty folders, so a vault
  that holds no note yet reads as missing;
- the service returns at most 20 hits, structural pages included: Noah asks for `limit + 3` (then for 20), so
  at limit 18–20 a few hits can be missing when index / log / template match the query;
- **a query is cut to its first 500 UTF-16 code units** (`searchQueryOf`; one fewer when the cut would split
  a surrogate pair). The service's rule is `z.string().max(500)`, and what that counts depends on its zod
  version (the one it pins counts code points, an older one UTF-16 units); 500 UTF-16 units is at most 500
  code points, so the cut passes either way. `rankBrainNotes` takes any length, so a long query is cut, not
  refused.

The 2,000-note scan cap and its `unscanned` report are the same on both sides.

### Self-knowledge (both surfaces)
- **Shared facts:** `OwnerState.vault` (`summarizeOwnerState`): `home`, `migratedAt`, `mirror` (`dirty`,
  `syncedAt`, `error`, `notice`, `hold`), `serviceConfigured`.
- **Frozen prompt** (`AgentRequest.vaultHome`, stamped ONLY as `"memory"` by `stampPromptRequest`, on every
  viewer class): `vaultMemoryHomeParagraph` in `brainSection`, three texts —
  `owner` (where the vault lived when the conversation started, saved on write, what `commit` pushes, the
  one-way copy, an outage is not an empty brain, and that `describe_system` reports the live state);
  `writer` (a shared-account teammate: the same facts WITHOUT the `describe_system` promise — a non-owner's
  `describe_system` carries no owner state — and "the tool result is right"); `reader` (a plain teammate, a
  consultation: the location and the outage rule). The THREE "not pushed until you commit" sentences are
  replaced for this home (`knowledgeRepoSection`'s last sentence, `brainSection`'s commit rule, the
  shared-account teammate paragraph's parenthesis). An owner whose vault is in the service but who has NO
  repository connected hears, next to "no repository yet", that the notes are still there and unreachable
  through the tools (`VAULT_MEMORY_NO_REPO_SENTENCE`). Nothing live rides the prompt, and "commit after
  writing" stays the instruction — which is also what keeps a frozen conversation right if its owner's vault
  moves (in either direction) mid-conversation.
- **`describe_system`** (owner only, `personalVaultLines`):
  - home `repo` with a repository connected: ONE line — the vault is the knowledge repository and a note is
    saved only by `mcp__repo__commit`; without a repository: no line;
  - home `memory`: `Personal vault` (home + since when), `Memory service` (ONE listing of the vault's `raw/`
    folder, bounded to 3 s: reachable / UNREACHABLE with the reason in words / answering but refused),
    `Vault copy in the repository` (`vaultMirrorStateText`: up to date, BEHIND, BEHIND after a failure — with
    a next step that depends on why, a text the table does not know getting the generic one —, CHECKING,
    WAITING FOR THE OWNER; a notice is quoted as stored and explained: repository notes the service does not
    hold, nothing deleted, not part of the brain);
  - home `memory` with NO repository: the vault line says the notes are there but unreachable, the copy line
    says there is nowhere to copy to, and neither names a tool that would refuse.
- **Home `repo` renders the prompt exactly as before, and `describe_system` differs by that one line** — also
  on a server with a memory service and mode `memory` (`tests/vault-self-knowledge.test.ts` pins the line and
  compares everything else).
- **Text every owner shares states no home:** the brain-* skills, `knowledge-backfill`, the capture tour, the
  manual's `knowledge` topic and the repository template say "commit after writing" and tell saved from not
  saved by the tool result's own words — "Not committed yet" is not saved until `mcp__repo__commit`
  succeeds; "is saved now" is saved. The home-specific fact is said only where it is rendered per owner.

### What Noah does not verify, and known limits
- **That a write landed as sent.** A `put`'s answer is trusted; only the migration reads notes back and
  compares hashes.
- **Writers other than Noah.** Noah assumes it is the service's only client for these wikis. A `stale` /
  `exists` is retried once on what is there now; whatever another client wrote is mirrored into the
  repository like any note. Nothing prevents or detects the service being registered on pi's MCP page.
- **The repository's vault files after cutover.** They are never read back to decide content: a direct git
  edit is not detected, only overwritten; that the remote holds the copy is known from the push having
  succeeded, nothing more.
- **A `.gitignore` that ignores vault paths yields `synced` without a push.** `git add -A` stages nothing,
  there is nothing to commit, and the pass is recorded ok — the repository then holds no copy and nothing
  says so.
- **The mirror reads EVERY note of the service on every pass** (8 at a time), also when one note changed: a
  large vault makes every pass, and every `commit`, proportionally slower.
- **No backoff on a failing push:** a dirty owner is retried every pass (60 s after the last one ended) for
  as long as it fails; only the log line is once per cause.
- **A stale ledger entry plus a lost service volume deletes that one repository file.** An entry is written
  BEFORE the service is asked; when the deletion was then refused or failed, the entry stays (harmless while
  the service holds the note). If the service later loses the note for another reason, the next pass reads
  "Noah deleted it, the service no longer has it" and removes the repository file — git history keeps it.
- **Rename conflicts other than rename/rename are untested** in the vault-conflict resolution.
- **One guard has no deterministic test:** the `O_NOFOLLOW` on opening a note file in the mirror is a second
  guard behind an `lstat` check (removing it alone fails no test, by design).
- **A file that is not UTF-8, moved onto a vault path.** A repo file → note move reads the file as text
  (`readFile`, utf8), so bytes that are not UTF-8 are not preserved in the note; the migration blocks on such
  a file (`not_utf8`), the move does not.
- **A long dry run can outlast the browser:** the client gives every request 120 s (`lib/api.ts`), and a dry
  run syncs every owner's clone (4 at a time). The server finishes and keeps the reports, but the screen
  shows a timeout; reload it.
- **The service's ranking** (above) and its limits — Noah learns of a full wiki or an over-long path from
  the refusal.
- **The service's durability.** Noah backs up nothing of the service's data (and takes no database backup
  for a move); the only other copy of a `memory`-home vault is its repository mirror, which can be behind.
- **Exclusion across processes.** The per-owner write queue and the one-job-at-a-time migration are in
  process (one Noah process per instance).
- **More than reachability in `describe_system`:** its check is one listing, not a write.
- **A moved owner on a real stack.** The boot test (`96-memory.mjs`, `build-run-verify.md`) saw the real
  service give the answers the client depends on, from inside Noah's container — but nobody is moved there
  (no git host with a knowledge repository), so the cutover, the tools of a moved owner, the mirror's push
  and a rollback are tested only against a scripted `fetch` and the hand-written double.

Tests (all in the tree): `tests/memory-client.test.ts`, `tests/personal-vault.test.ts` (paths, vault, store,
queue, ledger), `tests/vault-tools.test.ts`, `tests/vault-readers.test.ts` (tools, routes, standing memory),
`tests/vault-mirror.test.ts`, `tests/vault-migration.test.ts`, `tests/routes-personal-vault.test.ts`,
`tests/vault-self-knowledge.test.ts`, `tests/client-vault-codes.test.ts` (the client's translation tables
cover exactly the server's code lists); the two screens — `tests/react-settings-vault.test.tsx`,
`tests/react-admin-vaults.test.tsx` ([`client.md`](client.md) "Personal vault screens"). The double they
share is `tests/helpers/fakeMemory.ts`.
