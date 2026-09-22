# Repo plumbing and knowledge capture

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> Clone/commit plumbing shared by the repo families, plus backfill / request_info / second-brain mechanics.

## Repo plumbing (`knowledgeRepo.ts` / `groupKnowledgeRepo.ts` / `gitRepos.ts` / `repoGitCore.ts` / `repoGitGuards.ts`)
- **Low-level git is shared in `repoGitCore.ts`** (exec wrapper, `currentBranch`, dirty-status) and arg
  guards in `repoGitGuards.ts`. `knowledgeRepo.ts` + `groupKnowledgeRepo.ts` are thin context-resolvers
  over it; `gitRepos.ts` uses it too. **They were line-for-line mirrors before** — keep the shared core
  the single edit point for git-safety.
- **`dirtyPaths` flag difference is PRESERVED, not unified:** knowledge/group repos use `--porcelain`,
  `gitRepos` uses `--porcelain -uall`, threaded via the `extraStatusArgs` param. The knowledge-repo
  variant misses files inside otherwise-untracked dirs — a **latent bug flagged for a deliberate
  decision** (T3.7), NOT something to "fix" incidentally.
- **Git safety is TWO separate layers — don't merge them.**
  1. **Arg-safety: ONE validator, every clone path.** `assertSafeGitValue` (`repoGitGuards.ts`,
     re-exported via `repoGitCore.ts`) rejects leading-dash values and `scheme::` remote-helper syntax
     (`ext::sh -c …`). Used by `gitRepos.ts`, `knowledgeRepo.ts`, `groupKnowledgeRepo.ts`, and
     `marketplace.ts`'s `assertSafeArg` (plugin clones). It is deliberately **transport-agnostic**: a bare
     local path is a LEGITIMATE repo source (`register_repo` accepts one by design, and every offline repo
     test clones from a local bare remote), so this layer must never reject one. Was T3.8 — the three
     non-`gitRepos` paths used to check only for a leading dash and leaned on git's own default protocol
     policy (`fatal: transport 'ext' not allowed`) to stop `ext::`.
  2. **Source/host POLICY: `isInternalGitSource` (`gitCredentials.ts`), knowledge + group repos only.**
     It answers "is this on the internal GitHub host?" and **must fail CLOSED** — a non-shorthand source
     needs a PARSEABLE host matching `config.githubHost`. It used to return `true` for `host === null`,
     which (since `looksLikeRepo` accepts anything ending in `.git`) let any authenticated user point their
     knowledge repo at `dataDir/knowledge/<otherUserId>/.git` and read another user's private repo back
     through `/contents`, `/note`, `/graph` and the agent read tools. Was T3.11.
  When you add a repo entry point, decide which layer it needs: arg-safety ALWAYS, host policy only if the
  feature promises an internal-host-only source.
- **`withRepoLock` (`gitMutex.ts`) is NOT reentrant by key** — a fn running under `withRepoLock(key,…)`
  must never call it again for the same key (deadlock). Outer ops call the `*Locked` internals directly.
- **`commitAndPushClone` self-heals around the remote:** before pushing it fetches and REBASES local
  commits onto `origin/<branch>` (absorbs non-conflicting external pushes that would otherwise leave the
  clone permanently diverged), and a CLEAN tree with unpushed local commits still pushes them (an explicit
  commit retry after a transient push failure works) — only clean+in-sync returns `false`/"no changes". A
  conflicting rebase is `--abort`ed (local commits preserved) and thrown as **`REBASE_CONFLICT:<files>`**;
  `repoToolKit.commitFailureMessage` decodes that sentinel into a conflict explanation (naming the files,
  telling the model to inform the user, not to retry-loop) instead of the misleading token/branch-protection
  hint. Applies to BOTH personal and group knowledge repos (shared core).
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
  `open_repo`/`close_repo`. There are **NO status/list_files/read_file/write_file/delete_file/diff/commit
  MCP tools** — the avatar OPENS one repo as the conversation's **working directory** (`open_repo`) and
  edits/tests/commits it with NATIVE tools (Read/Edit/Bash local git). Each tool self-gates
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
  **The SDK cwd is fixed when a turn starts**, so `open_repo` takes effect **from the NEXT turn**.
  **One shared resolver, `activeRepoResolve.ts` `resolveActiveWorkspaceRepo`, is used by BOTH the chat
  route (turn start) AND the routine scheduler (before a headless run)** so they can't drift: it reads
  the selection → resolves/ensures the clone (no sync) → takes the per-clone lock → configures commit
  identity → returns the clone path as the SDK **cwd** (per-conversation scratch dir rides along as
  `additionalDirectories`) + a `release()` the caller invokes when the run ends. From then the avatar
  edits/tests with native Read/Edit/Bash + LOCAL git; only `push`/`sync_repo` stay MCP. `open_repo` needs
  `request.conversationId` — the chat route and the scheduler both thread it; only a run with NO
  conversation (e.g. intro gen) can't open one. A per-clone-path lock (`activeRepoLock.ts`) serializes
  concurrent opens (chat → 409; a routine whose repo is busy/missing logs and falls back to scratch).
  `preToolUseHook`'s `activeRepoMode` (= `Boolean(request.activeRepoName)`) is an INTEGRITY (not security)
  guard: denies remote/branch/history-rewriting/destructive Bash git, allows read-only git + local
  staging/commit. The clone path is NEVER returned to the client.

## Knowledge backfill, request_info, second brain — mechanics
- Owner sees pending `request_info` gaps in-app via a "내 아바타" nav badge + a poll/visibility watcher
  that toasts on new gaps (`refreshKnowledgeStatus`/`startKnowledgeWatch` in `lib/loaders.ts`).
- **Knowledge-repo `CLAUDE.md` is injected as standing memory.** The repo-root `CLAUDE.md` of the
  personal repo (ALWAYS) + each ENABLED group repo is read DIRECTLY from the clone (NOT via
  settingSources, which stays `[]`), size-capped, and pushed into the prompt EVERY turn via
  `AgentRequest.knowledgeMemory` (`loadKnowledgeRepoMemory` in plugins.ts → `knowledgeMemorySection` in
  promptBuilder.ts) — distinct from on-demand skills, with an injection guard. Wired in chat + scheduler
  (routines = all groups, no toggle); intro/hashtag gen leaves it unset. `writeRepoTemplate` seeds a
  starter root `CLAUDE.md`.
- **Second brain (#53) = a CONVENTION over the SAME knowledge repo, NOT a new store.** `wiki/` (curated)
  + `raw/` (capture) are just directories inside the existing personal/group knowledge repo. **Recall**
  is read-only search: `mcp__brain__*` (personal, `search`/`get_note`, gated `elevated`) and
  `mcp__group_brain__*` (one group, read gated on group-MEMBERship). Both metacognition surfaces (the
  prompt's `brainSection`/`groupsSection` and the `describe_system` brain lines) check the per-conversation
  `personal_knowledge`/`group_knowledge` tool-group toggle FIRST — mirroring runPlan's
  `brainActive`/`groupBrainActive` — so a deselected group reads as OFF, never as active. **Capture/consolidate** is the
  `brain-ingest`/`brain-reflect` default-skills, which WRITE through `mcp__repo__write_file` (personal) /
  `mcp__group_repo__write_file` (group) + `commit` — there is NO separate "brain write" tool, so a
  capture is a repo write plus a commit (uncommitted = not persisted). It composes with the backfill
  loop: `request_info` ESCALATES a true unknown to the owner, `brain-ingest` RETAINS the answer.
- **`wiki/` notes state the CURRENT truth; change history lives in `raw/` + git.** `brain-lint` (the
  hygiene default-skill — skill-only, no server lint code; the `[[link]]` resolution the graph view uses
  lives in `knowledgeGraph.ts`; the structural `wiki/index.md`, `wiki/log.md` and `_template.md` are
  excluded from BOTH `rankBrainNotes` and `buildKnowledgeGraph`, so an empty vault renders the
  empty state and the TOC never becomes a hub) strips "previously X, changed to Y on <date>" narrative
  out of `wiki/` notes and never edits `raw/` (the original-capture archive) or `wiki/log.md`
  (brain-reflect's append-only pass log); removed history is NOT relocated anywhere. Fixes go through
  `edit_file` (snippet replacement), never a `write_file` rewrite. The WRITE side carries the same rule:
  brain-reflect REPLACES a changed value and records it as one terse `old → new` line in `wiki/log.md`,
  brain-ingest keeps the dated context in the `raw/` capture — `tests/agent-core.test.ts` pins all
  three wordings. The standing prompt states the same rule too (`brainSection` in `promptBuilder.ts`,
  the `currentTruth` sentence) on every WRITE-capable run — owner/routine, shared-account teammate,
  personal bot — and on no read-only one (plain teammate, consultation), because the avatar also
  edits `wiki/` directly with the repo tools, where a skill-only rule would never reach.
- **`agents/<dir>/` is the same convention one level down.** Each personal bot (내 봇) keeps its own
  `wiki/` + `raw/` + `CLAUDE.md` under `agents/<memory_dir>/` in the SAME personal repo; the root
  `wiki/`/`raw/` vault stays the OWNER's and is untouched by (and unreachable from) a bot run. A
  scoped bot `commit` stages with a pathspec (`git add -A -- agents/<dir>`) so it can never sweep the
  owner's unrelated working-tree changes out of the shared clone. Rest →
  [personal-agents.md](personal-agents.md).
- **Capture notice ("기억" chip):** a SUCCESSFUL `write_file`/`edit_file` under `wiki/` (personal or
  group repo, incl. group-agent runs) fires `AgentEvents.onMemory` (`MemoryEvent`, gated in the tool
  handlers via `isBrainNotePath`) → SSE `memory` (server-minted `id` so reattach replays dedupe) → a
  `kind:"memory"` activity row (label "기억/그룹 기억 추가·갱신됨", detail = note path) that persists
  through the normal activity snapshot. **Rendering is summary-line-only:** `ActivityTree` EXCLUDES
  memory rows from the tree; `ChatView.memoryChip` renders them as a 🧠 chip on the activity
  disclosure's `<summary>` (live + completed cards), so the capture is visible while COLLAPSED —
  the whole point, since the tool list is folded by default. `raw/` writes stay silent BY DESIGN
  (a brain-ingest capture writes raw + wiki — one notice per capture, not two). Fires on write, not
  commit: the capture skills commit immediately after, and per-write is what maps 1:1 to notes.
