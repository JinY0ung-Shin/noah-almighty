# Repo plumbing and knowledge capture

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Clone/commit plumbing shared by the repo families, plus backfill / request_info / second-brain mechanics,
> and the personal vault: its ONE home (the bundled memory service), the writer queue, the service contract and
> the one-time import of a repository's own notes.

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
  `scaffold_skill` on a REPOSITORY file only touch the local clone — must be followed by `commit` to persist.
  (`ensureClone` re-syncs with `git checkout -B <branch> origin/<branch>`, not a hard reset.) **A vault note
  (the root `CLAUDE.md`, the `.md` notes under `wiki/` and `raw/`) is not a file of the repository**: it never
  touches the clone, is saved when written and is no part of a commit → "Personal vault" below.
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
- **The owner's root `CLAUDE.md` is injected as standing memory.** It is a note of the personal vault, so it
  is read from the memory service — never from the clone, whose `CLAUDE.md` file (if any) is read by nobody —
  only while a knowledge repository is connected, size-capped, and rendered into the prompt via
  `AgentRequest.knowledgeMemory` (`loadKnowledgeRepoMemory` in plugins.ts → `knowledgeMemorySection` in
  promptBuilder.ts; deadline and outage notice → "Personal vault" below) — distinct from on-demand skills,
  with an injection guard. The prompt is frozen per
  conversation (D2, `conversations.pi_instructions`), so the memory is the one read at the conversation's first
  turn; an edit mid-conversation applies from the next conversation. Wired in chat + scheduler;
  intro/hashtag gen leaves it unset. (Group repo CLAUDE.md files were injected too until group knowledge
  repos were retired, 2026-10-30.) `create_repo` seeds a starter root `CLAUDE.md` into the vault (the
  repository template's vault notes go to the memory service, not into the first commit).
- **Second brain (#53) = a CONVENTION (`wiki/` + `raw/` paths) behind the SAME repo tools — PERSONAL.** It
  is not a tool family of its own: the repo tools, at those paths, read and write the owner's personal vault
  in the memory service ("Personal vault" below), under the gates the repo tools always had. (The
  ONE instance-wide team brain, back 2026-11-06, is a separate Noah-owned local vault that every teammate
  writes through cards they press themselves (no review queue since 2026-11-13) →
  [`team-brain.md`](team-brain.md); it shares the `brain` server, but its vault is a
  stricter LLM wiki: server-rendered `raw/` sources, a FIXED server-validated `SCHEMA.md`, server-generated index/log.)
  `wiki/` (curated) + `raw/` (capture) are path prefixes of the owner's vault notes, named after the
  knowledge repository's layout; only the files there that are NOT vault notes (an image, a dot folder) are
  files of the repository.
  The team brain (`mcp__group_brain__*`, group vault scaffolding, group graph) was REMOVED 2026-10-30 (user
  decision), and group knowledge repos with it; `group_brain`/`group_repo` are retired pi broker ids (`RETIRED_MCP_SERVER_NAMES` in
  `scripts/pi-register-mcp.mjs` deletes stale entries) and reserved shared-MCP names. **Recall** is read-only
  search: `mcp__brain__*` (`search`/`get_note`, gated `elevated`). Both metacognition surfaces (the prompt's
  `brainSection` and the `describe_system` brain line) check the per-conversation `personal_knowledge`
  tool-group toggle FIRST — mirroring `buildRunCapabilities`' `brainActive` — so a deselected group reads as
  OFF, never as active; both also say there is no team repository or team brain
  (`GROUP_REPOS_RETIRED_SENTENCE` — needed because older frozen `pi_instructions` still name the
  `mcp__group_repo__*` tools). **Capture/consolidate** is the
  `brain-ingest`/`brain-reflect` default-skills, which WRITE through `mcp__repo__write_file` —
  there is NO separate "brain write" tool, so a capture is a repo-tool write, and it is saved by that write
  (nothing to commit; the skills tell saved from not saved by the tool result's words — "is saved now" for a
  vault note, "Not committed yet" for a repository file). It composes with the backfill
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
  The memory service scores the first 2,000 notes in path order and the tool SAYS when a vault is larger
  (`unscannedNote`, on a hit and on a miss) — the same rule as the team search (`BRAIN_SCAN_CAP`),
  [`team-brain.md`](team-brain.md) "Tools".
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
  (saved by the write) — the owner's own decision in the owner's own brain, so it is not the "nothing writes
  the personal brain" case (that one is about applied cards). The server's one part: `personalNotes` refuses such a note
  (`isKeptPersonalNote`, `brainTools.ts`). The skill is procedure only — no number, no criteria, no key
  spelling of its own (`tests/brain-policy.test.ts`); in a run without `prepare_team_changes` it stops instead
  of judging by rules the run does not carry. `brain-reflect` ends with ONE line pointing at it, on runs that
  can write the team brain only. The cards and their press → [`team-brain.md`](team-brain.md) "Cards and routes".
- **`wiki/` notes state the CURRENT truth; change history lives in `raw/` and in the memory service's own
  per-wiki history** (which no Noah tool reads — [`pi-runtime.md`](pi-runtime.md) "Memory service").
  `brain-lint` (the
  hygiene default-skill — skill-only, no server lint code; the `[[link]]` resolution the graph view uses
  lives in `knowledgeGraph.ts` (`buildKnowledgeGraphFromNotes` over the vault's notes for the personal brain,
  `buildKnowledgeGraph` over the team vault's folder) — the brain view's clickable `[[links]]` re-resolve client-side in
  `src/client/src/lib/knowledgeGraph.ts` (`resolveWikilink`: title/stem/path, no aliases — keep the
  two in step); the structural `wiki/index.md`, `wiki/log.md` and `_template.md` are
  excluded from BOTH search (`MemoryVault.search`; `rankBrainNotes` for the team vault) and the graph, so an
  empty vault renders the
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
  `raw/` node (the graph builders are unchanged); the client's `defaultHiddenSections`
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
- **Capture notice ("기억" chip):** a SUCCESSFUL `write_file`/`edit_file` under `wiki/` of the personal vault fires `AgentEvents.onMemory` (`MemoryEvent`, gated in the tool
  handlers via `isBrainNotePath`) → SSE `memory` (server-minted `id` so reattach replays dedupe) → a
  `kind:"memory"` activity row (label "기억 추가·갱신됨", detail = note path) that persists
  through the normal activity snapshot. **Rendering is summary-line-only:** `ActivityTree` EXCLUDES
  memory rows from the tree; the chat view's `memoryChip` (`views/chat/controller.tsx`) renders them as a 🧠 chip on the activity
  disclosure's `<summary>` (live + completed cards), so the capture is visible while COLLAPSED —
  the whole point, since the tool list is folded by default. `raw/` writes stay silent BY DESIGN
  (a brain-ingest capture writes raw + wiki — one notice per capture, not two). It fires on the write, which
  is also what saves the note, and per-write is what maps 1:1 to notes.

## Personal vault: ONE home, the memory service (#84; the only home since 2026-11-20)

An owner's **personal vault** is the repo-root `CLAUDE.md` plus every `.md` note under `wiki/` and `raw/` of
their knowledge repository's layout. It lives in the bundled stack's memory service (pi-gateway's
`apps/memory`, one wiki per owner) — for EVERY owner; there is no other home and no copy elsewhere.
Everything else in the knowledge repo (skills, plugins, `.gitkeep`, images, any non-markdown file, also under
`wiki/`/`raw/`) is a **repo path** and lives in git. The team brain is not part of this: it stays Noah's own
local vault ([`team-brain.md`](team-brain.md)).

### The rule and its questions (`personalVault.ts`)
- **ONE home, ONE writer per owner.** A vault note is read and written ONLY through the service
  (`MemoryVault`). A clone file at a vault path — a copy the retired mirror left, or a note a connected
  repository brought along — is read by nobody but the one-time import (below) and is no tool's to write,
  move or delete. There is no fallback to the clone: a second place a note could be is what the design
  removes.
- **Every vault WRITE of an owner runs in the owner's vault write queue.** A tool operation that changes a
  vault path uses `withVaultWrite(store, config, userId, fn)`: `fn` gets a `MemoryVaultWriter` whose
  `write`/`edit`/`remove` do not take the queue again (its reads are the ordinary ones) and that is closed
  when `fn` returns (`VAULT_WRITER_CLOSED`) — so a tool's read-then-write sees no other Noah write in
  between, whatever run it comes from (owner chat, routine, task API, a shared-account teammate). A single
  `write`/`edit`/`remove` of a `memoryVaultFor` vault takes the queue by itself. The import and the user
  delete hold the SAME queue through `withVaultWriteLock`. **A new tool path that changes a vault path goes
  through `withVaultWrite`.**
- **Lock order is always vault write queue → clone repo lock** (`withRepoLock`). Take the repo lock INSIDE
  the queue's callback, never around it; nothing holding the repo lock asks for the queue. The queue is in
  process and NOT reentrant: inside it use the queue's writer or the `MemoryClient`, never a
  `memoryVaultFor` write, `withVaultWrite` or `withVaultWriteLock` for the same owner (it would wait for
  itself).
- **"Is this path a vault note?" → `isPersonalVaultPath(rel)`**, never a regex of your own. It is NARROWER than
  "`CLAUDE.md` or `(wiki|raw)/**.md`": a markdown file the service cannot hold stays a repo path (a folder or
  name starting with a dot such as `wiki/.obsidian/x.md`, a backslash or control character, more than 16
  segments, a path over 512 bytes or a segment over 255). `normalizeVaultPath` strips leading `./` and `/`,
  posix-normalizes and NFC-normalizes (the form the service stores). **A tool's path ARGUMENT is classified
  by ONE function, `vaultNotePathOf` (`repoToolKit.ts`, used by the repo tools, `brainTools.ts` and the note
  route)**, which reads it the way the clone file ops would resolve it — so no spelling of a note
  (`./wiki/a.md`, `wiki//a.md`, `wiki/x/../a.md`, `wiki/a.md/`) reaches a clone file at a vault path.
- **`memoryVaultFor(store, config, userId)`** — the owner's `MemoryVault`, for READS (and for a write that is
  not a tool's read-then-write). It is never null and never throws: on a server with no memory service
  configured it is a vault whose every method rejects with `MemoryUnavailableError`
  (`reason: "not_configured"`). **A new reader goes through it.**
- **`MemoryVault`** (`list` / `read` / `exists` / `write` / `edit` / `remove` / `search`) throws the SAME
  sentinels as `knowledgeRepo` so tool wording is shared (`NOT_FOUND`, `INVALID_PATH` — also for a non-vault
  path or a folder —, `FILE_TOO_LARGE`, the `editFile` ones), `MemoryRefusedError` as it is (`wiki_full`,
  `invalid_content`, a `stale` that survived the one retry) and `MemoryUnavailableError` as it is. `list()` is
  in code-unit path order (`CLAUDE.md` < `raw/…` < `wiki/…`) and returns vault notes only; there are no
  folder operations (a folder delete/move works per note); `exists()` reads the whole note.
- **The store holds nothing about WHERE a vault lives** (`store/personalVault.ts`): no row, no setting. What
  it keeps is only the pending repository imports (`personal_vault_imports`, below).
- **The brain still requires a connected knowledge repo** (the `knowledgeRepoConfigured` gates are
  unchanged): the tools that reach a vault note are the repo and brain tools, which refuse or are not
  registered without one. Notes written while a repository was connected stay in the service and are
  unreachable until one is connected again — never reported as gone ("Self-knowledge" below).
- **A server without a memory service has no personal brain.** With `config.memory` unset (a native run
  without `PI_MEMORY_URL` / `PI_MEMORY_API_KEY_FILE`) every vault use fails as unavailable
  (`not_configured`) on every surface; nothing falls back to the clone.

### What reads and writes the service (`agent/repoTools.ts`, `repoToolKit.ts`, `brainTools.ts`)
- **The tools never touch a clone file at a vault path** — not to read, write, move or delete it. A folder
  that holds nothing but such files "does not exist" for the tools.
- `mcp__repo__list_files` → `mergeVaultTree`: the clone tree with its vault-path entries dropped and every
  service note listed. Under `wiki/` and `raw/` a folder is shown only when it holds a repo file or a
  service note (the service has no empty folders).
- `read_file` / `write_file` / `edit_file` / `delete_file` on a vault path → the service. A vault note's
  success text says it "is saved now" and that there is nothing to commit (`VAULT_NOTE_SAVED`; a deletion / a
  move "is saved now" likewise); a repo path keeps "(Not committed yet — push it with mcp__repo__commit.)".
  The standing guidance keys on exactly these two phrases (skills, tour, manual, the tool descriptions'
  `twoKinds` sentence).
- **A folder delete** removes the folder's notes in the service (first — a failure there leaves the clone
  untouched) and, in the clone, ONLY the repo files under it; a failure half-way says how many notes went.
- **`move_file`** is carried out file by file, each on the side it belongs to (note → note in the service;
  note → repo path; repo file → note; repo file → repo path). **A folder move MERGES into an existing
  destination**: it refuses, before anything moves, only a destination file that exists with DIFFERENT text
  (a folder move never overwrites; a single file's move does, as a rename always did), a folder onto a note
  path, and a file/folder mismatch. **It is RESUMABLE**: a destination that already holds exactly the
  source's text counts as copied — only the source is then removed — so the same call finishes a move that
  failed half-way, and a failure names the files that exist at BOTH paths at that moment.
- **Two refusals that close what the spelling cannot see:** `assertNoVaultAlias` — a path that is not a vault
  path as spelled but RESOLVES, through a link committed in the repository, into the clone's vault folders
  (`notes -> wiki`: `notes/a.md`) is `INVALID_PATH` (a delete of the link itself is allowed);
  `noteTreeCollision` — creating a repo file at `wiki/topic` while notes live under `wiki/topic/`, or a path
  under a note (`wiki/a.md/x.txt`), is refused: the one tree the tools show would hold a file and a folder
  of the same name.
- **`mcp__repo__commit` carries repository files only.** `commitAndPush(ctx, message, identity)` takes the
  clone's repo lock and runs `commitAndPushClone`: add → commit → fetch → rebase when behind → push ("Repo
  plumbing" above). It has no vault hook and writes no note into the clone. A clone that does not exist yet
  (a turn that only wrote vault notes never needs one) or a clean one answers "no changes" plus
  `VAULT_NOTES_NEED_NO_COMMIT` — vault notes are saved when written and are not copied to the repository.
- `mcp__brain__search` (personal) → `MemoryVault.search`; `get_note` and `personalNotes` → `MemoryVault.read`
  (paths through `vaultNotePathOf`; a markdown file under `wiki/` that is not a vault note is read from the
  clone, behind `assertNoVaultAlias`). Team marks and `personalNoteBlobId` are computed from the returned
  content (a git blob id is a hash of the content). **In a search of BOTH brains a personal side that could
  not be searched — unavailable OR refused — is an error next to the team hits**, never a silent "no
  personal match".
- The graph and note routes (`routes/knowledgeRepo.ts`: `buildKnowledgeGraphFromNotes` over `MemoryVault`;
  a note is read from the service, a non-vault markdown file from the clone) and a consultation's recall.
- **The standing memory** (`loadKnowledgeRepoMemory` → `readVaultClaudeMd`, a 6,000-character cap and a
  truncation mark; only with a repository connected) is read with a **3 s deadline**
  (`STANDING_MEMORY_VAULT_DEADLINE_MS`) so a hanging service cannot hold a turn. When the service is down,
  not configured or too slow, the slot carries `STANDING_MEMORY_UNAVAILABLE_NOTICE` instead of the text
  (Noah's notice, not the owner's words — the guidance could not be loaded, it is not empty, and how to read
  it later): the prompt is frozen per conversation, and a missing memory must never look like "the owner has
  no standing guidance". A missing or empty `CLAUDE.md` is still simply nothing.
- **`create_repo` / the repository template:** inside the write queue. A new repository that already holds
  vault notes of its own gets NO template (those files are not a tool's to touch; the import below judges
  them). Otherwise the template is written into the clone, its vault notes (`CLAUDE.md`, `wiki/index.md`,
  `wiki/log.md`, `wiki/_template.md`) are taken out of the clone again and written to the service unless the
  vault already holds a note at that path (`moveTemplateNotesToVault`), and the rest is the first commit.
- The 기억 chip (`onMemory`) fires on the write.
- **A service failure is reported AS a failure**: tools answer with an error that says the memory service is
  unavailable and that this is not an empty result (`memoryUnavailableMessage` — for a write: the change may
  or may not have landed, read again before repeating it); routes answer 503 with a Korean `apiError`
  (`메모리 서비스` — text a teammate reads never names pi-gateway). Never "not found", "no match" or an
  empty graph.
- **Deleting a user:** `deleteWiki(owner)` runs INSIDE that owner's vault write queue (`routes/admin.ts`,
  best effort, logged) — behind any queued write or import, so nothing re-creates the wiki afterwards. A
  pending import of that user finds the user gone at its next attempt and drops itself.

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
  `MAX_FILE_BYTES`); `hash` = sha256 hex of the bytes; a wiki holds at most 10,000 notes / 256 MiB
  (`MEMORY_WIKI_MAX_NOTES` / `MEMORY_WIKI_MAX_BYTES`).
- **It keeps each wiki's change history itself** — a local git per wiki inside its own volume, nothing
  pushed anywhere. Noah has no route or tool that reads it; what Noah can meet of it (a change whose commit
  failed answers as an outage) → [`pi-runtime.md`](pi-runtime.md) "Memory service".
- **Two failures, kept apart on purpose.** `MemoryRefusedError` (`code`, `status`): the service answered and
  said no — a coded 4xx other than 401 / `no_route`, and 507 `wiki_full` (a refusal the owner can fix, not an
  outage). `MemoryUnavailableError` (`reason`: `not_configured` | `network` | `timeout` | `unauthorized` |
  `no_route` | `server_error` | `bad_answer`): it could not be used at all. A caller reports the second as an
  outage — never as "no such note".
- **The client:** 15 s per request, redirects refused (the key goes to the configured address only), answers
  capped at 32 MiB, the key scrubbed from every error and log line, only a system error CODE passed on from a
  transport failure. `memoryClientFor(store, config)` is the one client of an app instance (null when
  `config.memory` is unset — `memoryVaultFor` then hands out the vault that fails every call); tests install
  a double with `setMemoryClientForTests` (`tests/helpers/fakeMemory.ts` — the same rules by hand, never
  imported by `src/`).
- **Config** (`parseMemoryConfig`, `config.ts`): `PI_MEMORY_URL` + `PI_MEMORY_API_KEY_FILE`, both or neither
  (neither = `config.memory` undefined: this server has no personal brain). The key is read from a FILE only
  — an inline `PI_MEMORY_API_KEY`, half a configuration, or an unreadable/empty file stops the boot — so it
  never enters `process.env` and no child inherits it. The URL joins `internalServices`
  (`gitSourcePolicy.ts`): it cannot be registered as a git source.
- **Not one of pi's MCP servers** (decided 2026-11-17): pi has no per-request server filter, so a registered
  memory server would show every Noah session a second, UNGATED set of memory tools, and a broker registration
  can only name the requesting user, never an avatar owner. Noah's own `repo` / `brain` tools are the only
  way in, so every run-class gate stays where it was. **This is an OPERATOR rule, not an enforced one:**
  nothing in Noah's code prevents or detects a registration made on pi's MCP page — the rule and what breaks
  are in [`pi-runtime.md`](pi-runtime.md) ("Memory service").

### Importing a repository's own notes (`vaultImport.ts`)
No tool reads a clone file at a vault path, so a repository that is connected WITH notes of its own
(`CLAUDE.md`, `.md` under `wiki/` and `raw/`) would leave them where the brain never sees them. The import is
the ONE path that brings them in — and the only thing that ever reads those files.
- **When:** `onKnowledgeRepoChanged(store, config, userId)` — fire and forget, called by
  `PUT /api/me/knowledge-repo` when the repository OR its branch changed (a branch holds its own files; a
  re-save of the same pair is not a change) and by `create_repo` once the repository is connected — records
  the owner as pending `check` and queues a look. A DISCONNECTED repository ends whatever was pending. A new
  repository is judged afresh: an import that had begun for the previous one is not continued.
  `resumeVaultImports` (boot, `index.ts`) queues every import an earlier process left pending, and takes
  over the never-moved owners (below).
- **A newly connected repository: only into an EMPTY vault.** The look (`check`) imports nothing when the
  owner's wiki already holds a vault note (`vault_not_empty`): a repository that still carries the copies the
  retired mirror wrote must never bring back a note its owner deleted since. The repository's notes then
  simply stay in the repository.
- **A never-moved owner: straight to `import`.** For an owner whose notes were never moved into the service
  the repository IS the vault, so their import is not a look that a note in the service could call off (an
  avatar may have built a `brain-migrate` skeleton on the empty brain first): it creates whatever is missing.
- **Never overwrites.** The import creates (`put` without a hash) the notes the service does not hold; a
  note that exists — also one written meanwhile, `exists` — is left as it is. One whose text differs from
  the repository's file is named in the outcome and the log (`differs`).
- **About ONE repository.** An attempt re-reads the connected repository and branch before it advances or
  clears the pending state and before every note it creates; when they changed while it ran it stops
  (`repo_changed`) and leaves the state to the attempt the change queued. Notes it had already created stay.
- **Resumable** (`store/personalVault.ts`: app_config key `personal_vault_imports`, JSON
  `{ userId: "check" | "import" }`): `check` = the repository has not been looked at; `import` = the look
  said yes and the import began, so every repository note the service does not hold yet is still to be
  created. An attempt that cannot finish (`retry`: no memory service configured, the clone could not be
  synced, the service unavailable) leaves the stage as it is and — except for `not_configured` — is tried
  again by a timer: after 60 s, then doubling up to 30 min, at most 6 rounds per process (`retryLater`; a
  round re-queues everyone still pending), after which it waits for the next boot. An attempt that ends
  (`imported`, or `nothing`: no user, no repository, vault not empty, no notes) clears it.
- **What one attempt does** (`runVaultImport`, never throws): inside the owner's vault write queue it lists
  the wiki, then — inside the clone's repo lock — syncs the clone (`ensureCloneLocked`) and scans its working
  tree for vault paths without following a link at any folder or file (`scanRepoNotes`, `O_NOFOLLOW`), then
  creates the notes. A file the service could not take is SKIPPED and named in the log, never a blocker:
  `not_a_file`, `too_large` (over 512 KiB), `not_utf8`, `nul`, `duplicate_path` (two clone files that are
  one note path once NFC-normalized — the first one scanned is kept), or the service's own refusal code.
- **A repository file is never changed or deleted** — imported or skipped, it stays in the repository,
  where nothing updates it any more.
- **One import at a time per app instance**, in the background (`enqueue`; tests wait with
  `whenVaultImportsIdle`). Nothing is audited and no screen shows a pending import; the AVATAR hears of it:
  a personal `mcp__brain__search` of an empty vault answers `VAULT_IMPORT_PENDING` instead of `NO_VAULT`
  while the owner is pending ("do NOT run `brain-migrate`"), and the owner's `describe_system` carries a
  `Repository import: PENDING` line. The log line is the record (`module: "vault-import"`; `warn` when
  something was skipped).
- **A commit never carries a vault path.** `commitAndPush` (`knowledgeRepo.ts`) passes
  `leaveOut: isPersonalVaultPath` to `commitAndPushClone` (`repoGitCore.ts`): after `git add -A`, staged
  changes at vault-note paths are taken out of the index again (the files stay as they are), so what the
  retired mirror left uncommitted in a clone, or a repository's own notes that were edited there, never
  rides a skill commit into the repository. Only such changes = nothing to commit.

### Search: what differs from the team brain's `rankBrainNotes`
`MemoryVault.search` asks the service with prefix `wiki` and drops `wiki/index.md`, `wiki/log.md` and
`*_template.md` itself, returning the same `BrainSearchResult` the team search returns. The ranking is the
SERVICE's and Noah cannot change it — so the personal and the team brain rank differently:
- the body score looks at the whole note text INCLUDING its frontmatter block (the team ranker scores the
  body without it), so a word that appears only in frontmatter can hit;
- `no_vault` needs at least one note under `wiki/` or `raw/` — the service has no empty folders, so a vault
  that holds no note yet reads as missing;
- the service returns at most 20 hits, structural pages included: Noah asks for `limit + 3` (then for 20), so
  at limit 18–20 a few hits can be missing when index / log / template match the query;
- **the ranking is BM25 (pi `1d4a1fe`, 2026-11-19).** Title and aliases, tags and the whole note are scored
  separately and weighted 5·3·1, so title > tag > body holds on both sides, but: an English word matches only
  as a WHOLE word (`deploy` does not find `deployment`; the team ranker's substring match does), Korean is cut
  into two-character pieces so a word still matches with another particle (`결함을` finds `결함이`; the team
  ranker needs the same string), a rare word counts for more and a long note for less, and scores are
  decimals. Seen through Noah's built client on a real stack: `build-run-verify.md` (pi `9f579dd`);
- **a query with no letter or digit in it is answered by Noah, never sent** (`hasSearchWord`): the service
  refuses it with `invalid_query` (a blank query always; one of symbols only, `?!`, since `1d4a1fe`), and it
  can match no note there. It is no hit, never a refusal;
- **a query is cut to its first 500 UTF-16 code units** (`searchQueryOf`; one fewer when the cut would split
  a surrogate pair). The service's rule is `z.string().max(500)`, and what that counts depends on its zod
  version (the one it pins counts code points, an older one UTF-16 units); 500 UTF-16 units is at most 500
  code points, so the cut passes either way. A long query is cut, not refused.

The 2,000-note scan cap and its `unscanned` report are the same on both sides.

### Self-knowledge (both surfaces)
- **Shared facts:** `OwnerState.vault` (`summarizeOwnerState`) is ONE fact, `serviceConfigured` — there is no
  "where" left to report. The texts both surfaces share live in `ownerState.ts`: `VAULT_NOTES_PHRASE` (what
  a vault is), `vaultOutageRule` (an outage is never an empty brain), `VAULT_MEMORY_NO_REPO_SENTENCE`.
- **Frozen prompt** — `vaultMemoryHomeParagraph(viewer)` in `brainSection`, on every run that has the brain
  (no request stamp decides it), three texts: `owner` (the vault is in the memory service, not in the git
  repository; a note is saved the moment its write, edit, move or delete succeeds, with nothing to commit and
  no copy in the repository; the service keeps the change history; a note file in the repository itself is
  not part of the brain; an outage is not an empty brain; `describe_system` reports whether the service
  answers right now); `writer` (a shared-account teammate: the same facts WITHOUT the `describe_system`
  pointer — a non-owner's `describe_system` carries no owner state); `reader` (a plain teammate, a
  consultation: the location and the outage rule). `knowledgeRepoSection` says "not pushed until you commit"
  only of repository files outside the vault. With NO repository connected the owner hears, next to "no
  repository yet", that any notes written while one was connected are still kept and unreachable through
  the tools — never gone. Nothing live rides the prompt.
- **`describe_system`** (owner only, `personalVaultLines`):
  - a repository connected: `Personal vault` (what it is, where it lives, saved when written, nothing copied
    to the repository, a note file found there is an old copy) and `Memory service` (`probeMemoryVault` in
    `memoryClient.ts`: ONE listing of the vault's `raw/` folder, bounded to 3 s — the check the settings card
    uses too: reachable / UNREACHABLE with the reason in words, `not_configured` included / answering but
    refused);
  - NO repository, a memory service configured: ONE line — notes written earlier are still there but
    unreachable, naming no tool that would refuse; the service is not asked;
  - no repository and no memory service: no line.
- **Text every owner shares says the same thing:** the brain-* skills, `knowledge-backfill`, the capture
  tour, the manual's `knowledge` topic and the repository template tell saved from not saved by the tool
  result's own words — "is saved now" is saved, with nothing to commit; "Not committed yet" (a repository
  file) is not saved until `mcp__repo__commit` succeeds.
- **Routes** (`createPersonalVaultRouter`, mounted after the admin router; neither changes anything, neither
  is audited):
  | Route | Who | What |
  |---|---|---|
  | `GET /api/admin/personal-vaults/usage` | admin | `{ serviceConfigured, limits: { notes, bytes }, owners }` — per owner (a user with a knowledge repository connected; there is no other record of "has the brain set up") `{ userId, notes, bytes }` from ONE `list` of their wiki, or `{ userId, error: "unavailable" \| "refused" \| "timeout" }`; 4 owners at a time, 10 s each. Counts and sizes ONLY — no note path or content ever leaves here (option 1 of the 2026-11-18 choice: an admin sees how full a brain is, never what is in it). `limits` = `MEMORY_WIKI_MAX_NOTES` / `MEMORY_WIKI_MAX_BYTES` (pi's `wiki.ts` limits). No memory service: `{ serviceConfigured: false, limits, owners: [] }` |
  | `GET /api/me/personal-vault` | owner | `{ serviceConfigured, service }` — `serviceConfigured` false = no memory service on this server (nothing of the brain works); `service` (null without one): `ok` \| `unavailable` \| `refused` from `probeMemoryVault` — the SAME bounded check as `describe_system`'s `Memory service` line, run on every read, so the card states an outage |

  UI: 관리자 → 시스템 → 개인 브레인 사용량; 설정 → 지식·플러그인 → 지식 저장소 (브레인 노트 보관) —
  [`client.md`](client.md) "Personal vault screens".

### What Noah does not verify, and known limits
- **The service's volume is the only copy.** Notes and their history exist nowhere else: Noah backs up
  nothing of the service's data and pushes nothing to an external git, so the backup of pi's `memory-data`
  volume is the operator's, and there is no way back to a repository home.
- **That a write landed as sent.** A `put`'s answer is trusted; nothing reads a note back to compare.
- **Writers other than Noah.** Noah assumes it is the service's only client for these wikis. A `stale` /
  `exists` is retried once on what is there now. Nothing prevents or detects the service being registered on
  pi's MCP page.
- **A repository's vault files are otherwise never read.** Outside the import no code looks at them: old
  mirror copies stay as last pushed and silently fall behind, a note added or edited directly in git is not
  part of the brain, and nothing tells the owner so beyond the standing texts.
- **The import is all or nothing about emptiness.** One vault note in the wiki — the starter template
  `create_repo` seeded, a leftover an earlier rollback could not delete — and a newly connected repository's
  notes are not imported at all; there is no merge and no screen that offers one.
- **A write that lands before a pending look ends it.** `check` judges emptiness when it RUNS: a note
  written through a tool while the look of a NEWLY CONNECTED repository was still pending makes the vault
  non-empty, and the repository's notes are then not imported. (The avatar is told not to build a skeleton
  meanwhile — `VAULT_IMPORT_PENDING` — but the frozen prompt of an older conversation still names
  `brain-migrate` for `NO_VAULT`.)
- **A resumed import does not ask again.** Stage `import` creates every repository note the service does not
  hold, without a second look at whether the vault is empty — also a note the owner deleted between the
  attempt that failed and the one that finished.
- **A never-moved owner's import can mix two sources.** It never overwrites, so a note that already sits in
  the service at the same path — a skeleton built meanwhile, or a stale copy an old rollback could not
  delete — wins over the repository's file (logged as `differs`), and a note only that stale copy holds
  stays. Nothing quarantines such a leftover any more.
- **A change at a vault path stays dirty in the clone.** It is never committed (above) and never dropped,
  so it can keep git from switching the clone to another branch — then the import ends `retry`
  (`sync_failed`) and the tools keep serving the previous branch's repository files. Commits the mirror made
  but could not push ARE pushed by the next commit, and can conflict with a direct edit in the repository
  (`REBASE_CONFLICT`, settled by hand).
- **The import reads the clone as the sync left it — on the connected branch.** A clone that could not
  switch branches (uncommitted repository files in the way — `alignBranch` keeps it) is NOT scanned: the
  attempt ends `retry` (`sync_failed`), so the previous branch's notes are never taken for the connected
  one's. What is not checked: that the clone is at that branch's remote tip — unpushed local commits and
  uncommitted changes of the connected branch are scanned as they are.
- **A pending import gives up for the process after its retry rounds** (about an hour and a half in all);
  then only a boot (`resumeVaultImports`) or the owner's next repository change looks again. No screen shows
  it — the avatar's `describe_system` line does.
- **A file that is not UTF-8, moved onto a vault path.** A repo file → note move reads the file as text
  (`readFile`, utf8), so bytes that are not UTF-8 are not preserved in the note; the import skips such a
  file (`not_utf8`), the move does not.
- **The service's ranking** (above) and its limits — Noah learns of a full wiki or an over-long path from
  the refusal.
- **Exclusion across processes.** The per-owner write queue and the one-at-a-time import are in process
  (one Noah process per instance).
- **More than reachability in `describe_system`:** its check is one listing, not a write.
- **An owner's tools on a real stack.** The boot test (`96-memory.mjs`, `build-run-verify.md`) saw the real
  service give the answers the client depends on, from inside Noah's container — but that stack has no git
  host with a knowledge repository, so the tools of an owner with a connected repository and the import are
  tested only against a scripted `fetch` and the hand-written double.

### Retired 2026-11-20 (reserved forever)
Until 2026-11-20 a vault had two homes per owner — `repo` (the clone was the vault) or `memory` (the service,
with a push-only copy written back into the owner's repository) — and an admin-run migration moved owners
between them. The owner decided on ONE home once the service kept history itself (pi `2759ae2`). Retired, and
never to be minted again: the `repo` home for vault notes; the git mirror (`vaultMirror.ts`) with its hold
states (`checking` / `confirm`), notices and the commit hooks in `commitAndPush` / `commitAndPushClone`; the
deletion ledger; the migration (`vaultMigration.ts`: dry run, cutover, rollback, pass, leftover clearing,
blockers); the tables `personal_vaults` and `personal_vault_deletes`; the setting `personal_vault_mode`; the
routes `GET /api/admin/personal-vaults`, `POST /api/admin/personal-vaults/dry-run`, `…/mode`, `…/run`,
`…/:userId/rollback`, `POST /api/me/personal-vault/mirror-recheck`, `…/mirror-confirm`; the admin screen 개인
브레인 이전 and the copy state of the settings card; `AgentRequest.vaultHome`.

**What an upgrade does** (`store/internal.ts` `migrate()`). ABOVE `retirementGate()` — this build reads
every vault from the service whether or not the backup worked — and ONCE per database
(`recordUnmovedVaultOwners`; the marker `retired:personal_vault_repo_home`, read by existence, so a later boot
never records again, also after an older build re-created the table empty): the owners whose notes are still
only in their repository are recorded under the app_config key `personal_vault_import_stragglers` — everyone
with a repository connected and no `personal_vaults` row, or, in a database from before that table existed,
everyone with a repository connected. A new database has no users yet and only gets the marker. The same
boot's `resumeVaultImports` takes that list ONCE (`takeVaultImportStragglers`, logged), records each owner as
pending `import` and queues them. BEHIND the gate (the full database backup first; a failed backup holds the
step until a later boot's backup works; `retirementBackup.ts` lists the two tables and the setting as retired
data): both tables and the setting key are dropped. No note is deleted anywhere: the service's wikis and the repositories are
untouched, the copies the mirror pushed stay in users' repositories and stop updating, and the quarantine
folders an earlier rollback left (`retired/<stamp>/personal-vault-leftover/`) stay where they are.

Tests (all in the tree): `tests/memory-client.test.ts`, `tests/personal-vault.test.ts` (paths, vault, queue,
the import store, the retirement), `tests/vault-tools.test.ts`, `tests/vault-readers.test.ts` (tools, routes,
standing memory), `tests/vault-import.test.ts`, `tests/knowledge-commit-push.test.ts`,
`tests/routes-personal-vault.test.ts`, `tests/vault-self-knowledge.test.ts`; the two screens —
`tests/react-settings-vault.test.tsx`, `tests/react-admin-vaults.test.tsx` ([`client.md`](client.md)
"Personal vault screens"). The double they share is `tests/helpers/fakeMemory.ts`.
