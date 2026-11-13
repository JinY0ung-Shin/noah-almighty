# Team brain (팀 브레인)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> The ONE instance-wide shared knowledge vault (back 2026-11-06, after the per-GROUP brain was retired
> 2026-10-30), a Karpathy-style LLM wiki (`raw/` sources → schema-validated `wiki/` pages). **Since
> 2026-11-13 every approved teammate WRITES it: their own avatar drafts the page changes and their own press
> on the card commits them — the review queue is retired.** This page: the local-only git vault and its fixed
> schema, the cards table and its confirm cards, the retired queue and its upgrade step, the run-class gating,
> both metacognition surfaces, the backup mirror, the UI, and the list of retired names.

## Decisions

### 2026-11-13 (user): every member writes directly — the review queue is retired
- **Every approved (not suspended) member writes directly.** The member's avatar drafts wiki page changes
  with `prepare_team_changes` (proposal kind `direct`) and that member's OWN press on 팀 브레인에 반영 commits
  them — the path an admin's own knowledge already took, with the same intake, provenance and schema
  validation, with or without a new source. There is no reviewer before or after the press.
- **Anyone may edit any page.** No page ownership. The `baseBlob` stale check stays (a page changed since it
  was read is refused, never overwritten) and there is still no delete.
- **Still admin-only:** `POLICY.md` (`prepare_team_policy`, kind `policy`), the backup (settings, push,
  restore) and the migration pass that compiles the pre-schema notes under `raw/legacy/`. The migration pass
  is ENFORCED, not only prompted (owner sub-decision): `legacyCitationRefusal` refuses a non-admin's
  changeset that newly cites a `raw/legacy/` note (→ "Tools").
- **One card, one press** (owner sub-decision): there is no "모두 제출 / 모두 반영" button. Each card is a vault
  commit, so each is read and pressed on its own — the `brain-share` pass included.
- **Rows left open in production were closed with a notice** (owner sub-decision), not converted: a
  submission still draft / pending / needs_info and an unpressed review card become `cancelled` with the
  reason `closed_by_upgrade`; the submitted source text STAYS in the row; the drafter's card says the way
  the team brain is written changed and to ask the avatar again. A full DB backup comes first
  (`retirementGate()`) → "The review queue's retirement".
- **Retired with the queue:** submit for review, approve / reject / ask (보완 요청, `needs_info`), answering
  questions, withdrawing a submission, result badges, pending counts, the 검토 대기 / 내 제안 lists and
  초안 N건 모두 제출. Every name is reserved → "Retired (reserved forever)".
- **Defaults the planner set, treated as decided:** wiki page text is UNTRUSTED input to every avatar that
  reads it (nobody reviewed it); `team_brain_health` is open to every member on a write run; SCHEMA.md's
  wording change is schema v3 with NO migration pass demanded (no page rule changed); a suspended account
  cannot write (re-checked live at the draft and at the press); a conflict a draft flags is judged by the
  DRAFTER on their own card; the raw frontmatter keys (`submitted_by`, `approved_by`, `approved_at`) and the
  log line format stay as they were — both people are the presser now — so the vault format does not churn.
- **Supersedes**, of the decisions below: "teammates read + submit SOURCES, an admin's avatar compiles, the
  admin presses" and "badges announce results" (2026-11-06); the one-press 초안 N건 모두 제출 and its
  reasoning about what reaches an admin (2026-11-12). Everything else below still holds.
- Spec + lane reports: `~/.noah-work/team-wiki-open-write-2026-11-13/` (`spec.md`, `server-report.md`).

### Earlier decisions (user, 2026-11-06 → 2026-11-12) — history; superseded parts are marked
- ONE vault per Noah instance (the instance IS the team). **Local git only** — no `origin`, no user
  tokens, no GitHub permissions involved. Only Noah's own code writes it.
- *(SUPERSEDED 2026-11-13.)* Teammates **read + submit SOURCES**; an **admin's avatar compiles** them into
  wiki pages at review time (the curator was the admin's own interactive run — no background curator, no new
  run class); the admin **presses** the card. An admin's own knowledge / maintenance skipped the queue (one
  press) — that path is now everyone's.
- Cards come **only from the avatar** (no UI form to START one). The avatar proactively offers ("팀에 공유할까요?"),
  driven by the four team-knowledge tests; **no frequency limit** (revisit after real-model use).
- Every state change is a **human press on a chat card** (option A — the model only drafts).
- **No delete** op (a wrong page is corrected with an update; a reversed decision is superseded).
  *(SUPERSEDED 2026-11-13: "**Badges** announce results" — there are no results to announce.)*
- **Backup** = an admin-set repository on the INTERNAL git host, pushed with THAT admin's own token.
- **LLM-wiki restructure (same day, user):** Karpathy-style `raw/` → `wiki/` + server-generated index/log;
  the drafting avatar runs an **intake interview**; a **FIXED `SCHEMA.md`** in code that the server
  validates on every change; every pre-schema note moved to `raw/legacy/`; a page-rule change = version bump
  + the admins' one-time migration pass (`team-brain-curate` skill).
- **Provenance is required (same day, user: option C after "출처·작성자·작성일 하나도 작성하게 안되어있다").**
  Every type's intake starts with `TEAM_PROVENANCE_SLOTS` = `source_kind` (one of `TEAM_SOURCE_KINDS`:
  document | link | meeting | message | verified | other) + `source` (the reference itself) + `author` (the
  ORIGINAL's author) + `authored_at` (the original's date) — the server's own `submitted_by/at` stamps say
  who put it into Noah, these say where it came from. The drafter can fill/correct the four ON THE CARD
  while it is a draft (the one in-card edit; still no form to start a card). C = A (the slots, asked by
  the avatar) + B (the card edit) + a STRUCTURED origin (kind + reference) — a link is checked as a URL, a
  date as a date, and both are machine-readable in raw frontmatter. SCHEMA.md (wiki page rules) is
  unchanged, so no schema-version bump: raw files are server-rendered, never validated as pages.
- **Brain policy + team policy (user, 2026-11-10, SSOT):** one fact, one home — team knowledge's
  canonical home is the team brain, personal context stays personal; every personal-vs-team rule lives in
  ONE module (`agent/brainPolicy.ts`, see [`repo-knowledge.md`](repo-knowledge.md)). The ADMINS own a
  `POLICY.md` in the vault: knobs the server enforces (frontmatter) + natural-language guidelines (body),
  changed ONLY through an admin's policy card and viewed under 관리자 → 팀 브레인. SCHEMA.md and the fixed
  core stay in code. An applied card records the personal notes it came from; nothing ever writes
  the personal repo for it (forcing was rejected: it makes conflict handling harder).
  Decisions: `~/.noah-work/brain-policy-2026-11-10/decisions.md`.
- **Selecting personal notes for the team (user, 2026-11-12):** the `brain-share` skill picks what in the
  personal brain is worth sharing — "너무 세부적인 정보는 말고" became `TEAM_SHARE_LEVEL_RULE`, which gates the
  everyday offer too — and drafts at most `TEAM_SHARE_PASS_MAX` (3) cards per pass. A declined note is
  remembered (`team_share: no`). *(SUPERSEDED 2026-11-13: the drafts went to the admins with ONE press,
  초안 N건 모두 제출; now each card writes the team brain when pressed, so each is pressed on its own.)* Rules →
  [`repo-knowledge.md`](repo-knowledge.md) "Brain policy".
- Designs + rejected alternatives: `~/.noah-work/team-brain-2026-11-06/design.md`,
  `~/.noah-work/team-brain-wiki-2026-11-06/design.md` (+ `research/`: Karpathy gist, follow-ups).

## The vault (`teamBrain.ts`, `teamBrainSchema.ts`)
- `<dataDir>/team-brain`, branch `main`, created lazily (`ensureTeamBrainRepo` = init-or-migrate under
  the lock). Search (`rankBrainNotes`, now with an additive `{prefix}` option) and the graph
  (`buildKnowledgeGraph`) are reused with this root.
- **The graph colors a page by its TYPE (user, 2026-11-13).** `teamBrainGraph` passes `teamSectionOf`: a
  node's `section` is the page's `TeamPageType` (`decision` … `contact`) — taken from the FOLDER
  (`teamPageTypeForPath`), which the schema keeps equal to the frontmatter `type`, so nothing is re-parsed;
  `raw` for a source, `wiki` only for a file the schema would not accept. The client gives each type its
  color, its Korean label (`TEAM_PAGE_TYPE_LABELS`) and a legend chip that also filters by type
  (`lib/knowledgeGraph.ts`). **A new page type needs a color there** — `tests/client-knowledge-graph.test.ts`
  fails without one. The type ids never collide with the personal vault's folder sections (`concept` vs
  `concepts`), so the client needs no "which brain" flag. Raw sources start hidden → `repo-knowledge.md`.
- **Layout (schema v2):** `SCHEMA.md` (`TEAM_BRAIN_SCHEMA_MD`, first line `<!-- noah-team-brain-schema: N -->`);
  `POLICY.md` (`TEAM_POLICY_PATH`, the admins' policy — see "Team policy" below; never a page-changeset target,
  in `TEAM_STRUCTURAL_PATHS`);
  `raw/YYYY/MM/<date>-<id8>.md` (`teamRawPath`) = one source a card brought in, RENDERED BY THE SERVER at
  apply (`renderTeamRaw`) and never a change target; `raw/legacy/…` = pre-schema notes;
  `wiki/<TEAM_PAGE_FOLDERS[type]>/<slug>.md` = pages;
  `wiki/index.md` REGENERATED from page frontmatter on every commit (`renderTeamIndex`) and `wiki/log.md`
  APPENDED per commit (`formatLogEntry`) — the model never writes either (`TEAM_STRUCTURAL_PATHS`).
  The layout is still v2's: schema v3 changed SCHEMA.md's wording only (below).
- **A raw file (`renderTeamRaw`):** frontmatter `title`, `type: raw`, `id` (the card's row id), `page_type`,
  `submitted_by` / `submitted_at` (the row's `created_at`), `approved_by` / `approved_at` (the press), then the
  provenance answers as `source_kind` / `source` / `author` / `authored_at` (omitted on rows from before they
  were asked); body `## Source` (verbatim) and `## Intake` (the other answers + `gaps`). Since 2026-11-13
  `submitted_by` and `approved_by` are the SAME person — the drafter who pressed; the keys are kept so older
  raw files read the same. A raw file written before then may name two people and carry `## Follow-up N`
  sections (the 보완 요청 rounds); nothing renders those any more.
- **A raw source is committed only WITH its changeset** — reads serve the working tree, so the source of a
  card nobody pressed must never land there; a cancelled / expired card's source (and a closed legacy
  submission's) lives only in the DB row.
- **Validation (`parseTeamPage`, `validateChangeset`)** — the schema is enforced, not just prompted:
  required `title`/`type`/`summary`/`sources`/`review_after`; type ⇔ folder; title + aliases unique
  vault-wide (`teamNameKey`, NFC/case-folded) and within the changeset; every `sources` entry an existing
  raw (or the changeset's own new raw — which EVERY changed page must cite); decision `status`
  accepted|superseded with `superseded_by`; ≤ `TEAM_BRAIN_MAX_CHANGES` pages / byte caps; secret scan
  (`findSecretInText`, incl. the writer's own secrets via `ownSecrets`). Errors are agent-facing English,
  returned verbatim so the drafting avatar fixes and retries.
- **Schema versions (`src/shared/teamBrain.ts`).** `TEAM_BRAIN_SCHEMA_VERSION = 3` = the SCHEMA.md text;
  `TEAM_BRAIN_PAGE_RULES_VERSION = 2` = the newest version that changed what a valid page (or the layout) IS.
  v1 (2026-11-06) the LLM wiki; v2 (2026-11-10) the review horizon moved to POLICY.md and POLICY.md joined the
  layout; **v3 (2026-11-13) wording only** — Purpose says every teammate writes it, Layers says "one file per
  source a teammate put in", writing rule 3 says "let the teammate who presses the card decide". **A change
  to SCHEMA.md bumps the schema version; only a change to a page rule bumps the page-rules version WITH it.**
  "Migration pending" is `teamSchemaMigrationPending(version)` (= `version < TEAM_BRAIN_PAGE_RULES_VERSION`;
  `TeamBrainHealth.migrationPending`) — never the plain `version < TEAM_BRAIN_SCHEMA_VERSION`, which would
  announce work for a v2 vault that only waits for the server's own rewrite.
- **Migration (`migrateTeamBrainLocked`, returns the version it migrated FROM or null).** v0 (no marker) → current
  `git mv`s every `wiki/**/*.md` except the structural files/templates to `raw/legacy/<rel>`; every bump
  rewrites SCHEMA.md, seeds `TEAM_POLICY_DEFAULT_MD` when HEAD has no POLICY.md (an existing one — a restored
  newer mirror — is kept), regenerates the index with the remaining pages re-parsed under the NEW rules and
  appends a `migrate` log entry — ONE commit by the Noah identity (`team-brain: migrate to schema vN`). The log
  note says what is left to do: from v0 "N pre-schema notes moved to raw/legacy/; compile them…", from below
  the page-rules version "run team_brain_health and fix the pages it lists", otherwise "SCHEMA.md wording
  only — no page rule changed, nothing to fix" (v2 → v3). `initLocked` seeds POLICY.md on a new vault;
  `reconcileLocked` cleans it like SCHEMA.md. Boot runs `migrateTeamBrainOnBoot` (`index.ts`, never throws,
  schedules a backup push after any migration commit; its log line says "run the team-brain-curate migration
  pass" only when `teamSchemaMigrationPending(from)`); a restored pre-schema mirror is migrated right after
  the restore (`migrateTeamBrainHoldingLock`). Nothing is deleted (git history + `raw/legacy/`).
- Never handed to a sandbox and never a `.git` the agent can touch: the agent only sees CONTENT through
  the brain tools (`readTeamVaultFile` allows exactly `SCHEMA.md`, `POLICY.md`, `wiki/**.md`, `raw/**.md`). All
  git runs through `repoGitCore.git()` (serverGitEnv hardening; identity via env config, never argv). Every
  write is under `withRepoLock(teamBrainRoot)` — not reentrant, so exported ops take it once (`*HoldingLock`
  internals never do).
- **`applyTeamChangeset`** under the lock: ensure/migrate; re-check every page's blob (`EXISTS`/`MISSING`/
  `STALE` → `TeamNoteConflictError` with the path) and re-run `validateChangeset` against the vault AS IT IS
  NOW (`TeamChangesetInvalidError`; POLICY.md's review ceiling is NOT re-checked here — it is a draft-time
  rule); write raw + pages, regenerate the index, append the log (`logOp` = `direct` with a source,
  `maintain` without); ONE path-scoped commit, message `team-brain: <title>` + a `Proposal: <id>` trailer,
  authored by the presser (= the drafter; there is no `Co-authored-by` trailer any more).
  **Any failure restores every touched path from `git show HEAD:<path>`** (no index lock needed — the old
  `reset`/`checkout` rollback failed under the same `index.lock` that failed the commit) and removes new files.
- **A log entry (`formatLogEntry`):** `## [date] <op> | <title> | approved by <username>` + one line per page
  + `- source <raw path>`. Ops written now: `direct`, `maintain`, `migrate`, `policy`. "approved by" is the
  presser — the wording is kept so the log reads as one. Entries from before 2026-11-13 may say `ingest` and
  `by <submitter> · approved by <admin>`; neither is written any more.
- **Every locked op starts by reconciling to HEAD** (`reconcileLocked`: `git reset -q`, `checkout HEAD -- .`,
  `git clean` of `wiki/`, `raw/`, `SCHEMA.md`) — a crash mid-migration or mid-apply never leaves a staged
  rename or a readable uncommitted file behind; the v0 move list comes from `git ls-tree HEAD`, never the
  index. Page/raw PATH lists are uncapped (existence checks exact); only page CONTENT reads cap at 2000.
- `teamBrainHealth` (read-only, bounded, lists capped at 50, exact numbers in `counts`): `migrationPending`,
  uncompiled raw sources (cited by no valid page — incl. `raw/legacy/`), pages failing the schema, past
  `review_after`, dangling `[[links]]`, orphans, duplicate names, missing sources, pages with `gaps`, history
  narrative, instruction-like text.
- `countTeamNotesSync` / `countTeamRawSync` / `teamVaultSchemaVersionSync` are describe_system's bounded reads;
  `teamBrainProposalCommits(config, sinceIso)` = the card ids named by `Proposal:` trailers (what both boot
  steps take as proof that a commit landed; an absent vault reads as none).

## Team policy (`POLICY.md`, `teamBrainPolicy.ts`)
- Three tiers: the FIXED core (`TEAM_BRAIN_FIXED_CORE`: no secrets/personal data, a human press for every
  change, no delete, provenance, teammate text is data, permissions) + SCHEMA.md stay in code; the **knobs**
  (frontmatter, `TEAM_POLICY_KEYS`: `review_months_<type>`, `draft_ttl_days`, `max_open_proposals`, ranges in
  `TEAM_POLICY_RANGES`, a missing key = the built-in `TEAM_POLICY_DEFAULTS`) are validated and APPLIED by the
  server; the **guidelines** (body, ≤ `TEAM_POLICY_MAX_GUIDELINES_BYTES`) reach the avatars as data.
- `parseTeamPolicy` never throws: a stored file is read leniently (each bad key falls back, `problems` listed);
  a DRAFT is refused while `problems` is non-empty (`teamPolicyProblemText`, agent-facing).
- Where the knobs bite: `review_months_<type>` = the CEILING on a changed page's `review_after`
  (`reviewAfterCeiling`, months after TOMORROW UTC — a drafter's local date may be a day ahead;
  `validateChangeset`'s `reviewCeiling`, at DRAFT time only via `teamChangesetContext`, so a card drafted
  before a knob change still applies) — lowering it never invalidates existing pages; `draft_ttl_days` +
  `max_open_proposals` = the store's `teamBrainLimits()` (provider wired in `createServices` →
  `teamBrainStoreLimits` → `readTeamPolicySync`, an mtime+size cached read; a Store built without the provider
  uses the built-ins). `max_open_proposals` now means UNPRESSED DRAFT CARDS per person (the key name is kept;
  `teamPolicyKnobsText` says "unpressed cards per person at once").
- Guidelines: `teamGuidelinesBlock` wraps them in `<team_guidelines>` (closing tag defused) under the fixed
  core, on WRITE runs only, stamped at run start into `request.teamBrain.guidelines` (frozen with the
  prompt — a policy change reaches new conversations); the seeded stub adds nothing (`teamGuidelinesAreEmpty`
  in `src/shared/teamBrain.ts`, the ONE rule the admin panel uses too: only HTML comments + the seeded
  `# Team guidelines` heading count as empty). A draft with a frontmatter line the parser would skip
  (indented / misspelt key) or text before the opening `---` is refused (`unparsed_line`, `leading_text`).
- The seeded file (`TEAM_POLICY_DEFAULT_MD`) explains the knobs in an HTML comment; its wording lost "what
  reviewers check" on 2026-11-13. A vault that already has a POLICY.md keeps its old comment (the file is
  only ever seeded, never rewritten) — harmless, it is a comment.
- First use: the vault is lazy, so `prepare_team_policy` and a WRITE-capable run's team `get_note` of
  `SCHEMA.md` or `POLICY.md` run `ensureTeamBrainRepo` first — the write flow starts by reading the rules, and
  the blob a policy draft records is the seeded file the press will find. A read-only run never creates it.
- Changing it: admin tool `prepare_team_policy` (full file + `baseBlob` from team `get_note` on POLICY.md —
  refused when stale/missing, unchanged, invalid or secret-bearing) → a `kind: "policy"` row (`path`
  POLICY.md, `content` = new file, `base_blob` = the blob seen) → the card's **팀 정책 반영** →
  `applyPolicyCard` → `applyTeamPolicy` (lock, STALE/invalid re-check, POLICY.md + log op `policy`, ONE commit
  with a `Proposal:` trailer, restore on failure; the boot sweep covers policy cards too). Audit
  `team_brain_policy`.
- Reads: team `get_note` on `POLICY.md` (blob + the settings in force, for every run that reads the team
  brain); `describe_system` (write runs: knobs + whether guidelines are set);
  `GET /api/admin/team-brain/policy` (`TeamPolicyView`: knobs, guidelines, Korean `problems`,
  `teamPolicyHistory` = git log of POLICY.md) for the admin panel.

## Personal-note links (`personal_notes_json`)
- `prepare_team_changes` (with OR without a source — a correction links too, #82, 2026-11-10) takes
  `personalNotes` (≤ `TEAM_BRAIN_MAX_PERSONAL_NOTES` `wiki/` paths of the OWNER's personal brain). brainTools
  resolves each over the owner's clone (`personalNote` callback in `TeamBrainToolsContext`, owner runs with a
  personal brain only; a link note or a missing note is refused) and the row stores `{path, blob}`
  (`personalNoteBlobId` = git's blob id, taken when the card is drafted). NOTHING is written to the personal
  repo — then or later.
- **The link exists only when the avatar passes it — soft by decision.** The server never searches the
  personal brain for candidates. The execution point is `BRAIN_LINK_CHECK_RULE` ("BEFORE A TEAM CARD",
  `brainPolicy.ts`): before every team card the avatar searches the personal brain for the topic and passes
  the notes that state the same fact. `TEAM_OFFER_TO_SHARE` (intake) and `TEAM_WRITE_FLOW` point at it by
  name (`BRAIN_LINK_CHECK_NAME`), the `personalNotes` parameter description repeats the trigger, and the
  curate skill refers to it. A server-side candidate detector is the next step only if this still misses.
- A note marked `team_share: no` (`isKeptPersonalNote` — also `false`, quoted, or with a trailing comment; the
  owner's KEPT PERSONAL decision) is refused as a `personalNotes` entry, and the refusal says not to put what
  it says into the team brain without the link either.
- `listTeamBrainPersonalLinks(owner)` = applied `direct` rows that recorded notes, PLUS history: `propose` rows
  approved through the retired queue (pages from the applied approve review on them) — a note promoted before
  2026-11-13 stays marked. brainTools marks them at READ time: personal `get_note` prepends
  `PROMOTED: … went into the team brain as the source of a team-brain change … (card <id>) … has / HAS CHANGED
  since it went in` (+ the PROMOTED NOTES hint for the owner; a link from a card WITHOUT a source —
  `fromSource: false`, the direct row has no raw `path` — reads "recorded as stating the same fact … was NOT
  that page's source", because the page was compiled from other sources and the note may say more), personal
  `search` appends a "Team-brain links" block, a note with `team_page:` frontmatter reads as a LINK note;
  `team_brain_health` lists them for the owner (≤ 20; this listing lived in `list_team_proposals` until
  2026-11-13); `describe_system` counts them. Note paths never reach anyone else: a card view is the
  drafter's only. Converting a note into a link is the owner's avatar ASKING with the five required points
  (`PROMOTED_NOTE_RULE`) — never automatic.

## The cards table (`team_brain_proposals`, `store/teamBrain.ts`)
- One table (the name predates the retirement and is kept): **live `kind`** = `direct` (a teammate's own page
  changeset, with or without a new source) | `policy` (an admin's POLICY.md change) — `TEAM_BRAIN_LIVE_KINDS`;
  **live `status`** = `draft` → `applied` | `cancelled` | `expired` — `TEAM_BRAIN_LIVE_STATUSES`.
  `intake_json` (type + slot answers + gaps) and `changes_json` (pages + model-flagged `conflicts`). `path` =
  the raw path the source will land at (a changeset without a source: ""; policy: `POLICY.md`).
  `decided_by` / `decided_at` = who pressed 반영 and when (the drafter). The conversation link is read through
  a join (todo_items precedent). `createTeamBrainProposal` accepts the live kinds only.
- **Legacy rows stay, as history.** Kinds `propose` (a teammate's source submission) and `review` (an admin's
  decision on one, `target_id` + `decision`), statuses `pending` / `approved` / `rejected` / `needs_info` /
  `withdrawn`: old rows still parse (`TEAM_BRAIN_PROPOSAL_KINDS` / `_STATUSES` = live + legacy;
  `isTeamBrainLegacyKind`), nothing mints or moves a row INTO one, and nothing writes `target_id`, `decision`
  or `result_seen_at` any more (the columns stay). `decision_reason` holds a legacy rejection reason / 보완 요청
  questions — or `TEAM_BRAIN_CLOSED_BY_UPGRADE` (`"closed_by_upgrade"`). `TEAM_BRAIN_DECISIONS` stays only to
  decode them. A kind this build does not know reads as `propose` and an unknown status as `cancelled`
  (`toProposal`): shown, never actionable.
- Caps: 64 KB source/page, 15 pages / 256 KB per changeset, POLICY.md `max_open_proposals` (built-in 20)
  **`draft` rows per user** (the only open state now; checked in the insert transaction, `LIMIT` → the tool's
  "press or cancel earlier ones first"); drafts expire `draft_ttl_days` (built-in 7) days after their last
  update (`updated_at` — a provenance edit on the card restarts the clock) OR once their conversation (and so
  their card) is gone (`expireTeamBrainDrafts`, lazy, run before reads that count or act).
- `transitionTeamBrainProposal` is compare-and-set on the current status and only ever moves a row to a LIVE
  status — the ONE way two presses at once still apply a card once. Apply CLAIMS the card (`draft → applied`
  with the decision stamps), writes, and RELEASES the claim on a failed write (`applied → draft`,
  `clearDecision`).
- Boot sweep (`sweepTeamBrainAppliesOnBoot`, live cards only, last 7 days, one `git log` scan for `Proposal:`
  trailers): a card claimed BEFORE this process started whose commit never landed goes back to `draft`.
- One-time row migration (user_version 3, 2026-11-06, history): pre-schema `propose` rows still
  draft/pending kept their note text as the SOURCE (path → `teamRawPath`, intake type null = legacy);
  pre-schema `direct`/`review` drafts were cancelled.
- `isActiveAdmin` / `isActiveUser` judge a PERSON live (exists, not suspended; + the `admin` role).
- Cascades: `deleteUser` → `deleteTeamBrainProposalsForUser` (committed content stays in git; the user's
  waiting press reports are forgotten); `applyConversationRewind` → `cancelTeamBrainDrafts(conversationId,
  ids)` — scoped to the rewound conversation — for the `team_brain` attachments of dropped messages (an
  applied card stays — a rewind never undoes the world).

## The review queue's retirement (2026-11-13, `teamBrainActions.ts`, `store/retirementBackup.ts`)
- **A boot step, not a `user_version` step:** `retireTeamBrainReviewQueueOnBoot`, wired in `index.ts` AFTER
  `migrateTeamBrainOnBoot` and BEFORE `sweepTeamBrainAppliesOnBoot` (one fire-and-forget promise chain; it
  never throws). Settling an approval that was mid-commit needs the vault's `git log`, which is async, so it
  cannot run inside `migrate()`.
- **Value-guarded, and that is safe here.** The predicate is ONE SQL fragment, `OPEN_TEAM_BRAIN_QUEUE_ROWS_SQL`
  (`store/retirementBackup.ts`): `propose` rows in `draft` / `pending` / `needs_info`, `review` rows in
  `draft`. Nothing mints a queue row any more, so it matches only what an older build left: a second run and
  a fresh DB find nothing (`countOpenTeamBrainQueueRows() === 0` → return), and rows an older build writes
  after a ROLLBACK are closed on the next boot of this one. (The `migrate()` rule "a predicate that can match
  rows the app creates later must be gated on `user_version`" — `src/server/CLAUDE.md` — does not bite: the
  app creates none.)
- **Behind `retirementGate()`.** The same fragment is a predicate of `retirementDataPresent`, so the gate's
  first ask of the boot (the `Store` constructor, before `migrate()`) takes the full DB backup
  (`backups/pre-retire-<stamp>.db`) when an open queue row exists; the step asks the gate again and, when the
  backup FAILED, closes nothing on this boot (one `error` line; the next boot retries). → `server-core.md`
  "Retirement backup and quarantine".
- **In-flight approvals are settled first** (`listTeamBrainInFlightApprovals`: an approve `review` card
  already `applied` whose submission is still `pending` — the previous process died between the claim and
  the commit). The vault is the truth (`teamBrainProposalCommits` since a day before the oldest claim): the
  commit LANDED → the submission becomes `approved` (stamped with the admin who pressed; its personal notes
  stay marked); it never landed → the approve card decided nothing and is closed
  (`cancelled` + `closed_by_upgrade`, decision stamps cleared). **A vault that cannot be read holds the whole
  step** until the next boot — nothing is closed on a guess.
- **Then every open row is closed** in the same transaction (`retireTeamBrainReviewQueue(landed)`): status
  `cancelled`, `decision_reason = TEAM_BRAIN_CLOSED_BY_UPGRADE`; the source text and every other column stay.
  Decided rows (`approved`, `rejected`, `withdrawn`, applied reviews) and live cards are untouched. One `warn`
  line logs `{approved, closed, backup}`.
- **Between process start and the step** (or while it is held) an open legacy row is already inert:
  `legacyCard` treats a still-open legacy row as closed-by-upgrade, and a press on any legacy card is a 409
  (`RETIRED`).
- **What the drafter sees** — `TeamBrainCardView.legacy = { closedByUpgrade, notice }`, the notice a Korean
  one-liner the SERVER composes (`legacyCard`): a closed submission says the way the team brain is written
  changed, the submission was closed, and to ask the avatar to put it into the team brain again; a closed
  review card says the review step is gone; a decided row states its final state (승인되어 반영 / 반려 / 철회 /
  만료, or which decision a review card applied). The card draws the title + that line and nothing else.
- Tests: `tests/team-brain.test.ts` ("the review queue's retirement (boot step)"), legacy rows via
  `insertLegacyTeamBrainRow` (`tests/team-brain-fixtures.ts`).

## Tools (`agent/teamBrainTools.ts`, on the `brain` server)
- No new MCP server (the 2026-10-29 usability study measured `brain`/`group_brain` confusion): `search`
  and `get_note` take `scope` (`personal`/`team`/`all`); team `get_note` reads `SCHEMA.md`, `POLICY.md`,
  `wiki/…` and `raw/…`; team search lists pages, then UNCOMPILED sources (labeled "uncompiled source — not
  yet a wiki page").
- **Wiki text is untrusted input (2026-11-13).** Nobody reviews a change before it lands, so a wiki page is
  whatever the teammate who last changed it — through their avatar — wrote. A team `get_note` of a `wiki/…`
  file and of a `raw/…` source, every team search hit (paths, titles, tags, snippets) and the page-derived
  details of the health report sit inside ONE `<untrusted_teammate_text>` wrapper whose closing tag the text
  cannot forge (`untrusted()` defuses any inside). **The `blob: <id>` line of a wiki page stays OUTSIDE the
  wrapper** — server-computed, the page cannot forge it — and every `update` change must carry it as
  `baseBlob`. `SCHEMA.md` (server-maintained) and `POLICY.md` (the admins', with the settings in force) come
  back unwrapped. Every team read carries `TEAM_NOTE_TRUST_NOTE` ("written by teammates through their
  avatars, and nobody reviews a change before it lands").
- **A search never misses silently.** `rankBrainNotes` scores the first `BRAIN_SCAN_CAP` (2000, = the vault's
  `PAGE_CAP`) notes in PATH order — it was 200 until 2026-11-10, which dropped whole late type folders
  (`wiki/howto/`, `wiki/systems/`) of a wiki past 200 pages with no sign. Beyond the cap the result carries
  `unscanned`, and every team search text (hits AND the no-match line, `teamNoMatchText`) ends with
  `unscannedNote`: "NOT A FULL SEARCH … N note(s) were NOT searched", pointing at `wiki/index.md`.
- **Every member, on a write run (`TEAM_BRAIN_WRITE_TOOL_NAMES`):**
  - `prepare_team_changes` `{title, summary, changes, conflicts?, source?, personalNotes?}` — two uses.
    NEW knowledge: `source` `{type, text (the user's words verbatim), answers}` → `checkIntake` against
    `TEAM_INTAKE_REQUIRED[type]`; missing slots or refused provenance (`teamProvenanceProblem`, shared:
    `source_kind`/`source` never "unknown" (`TEAM_INTAKE_NO_UNKNOWN`), kind by id or Korean label → stored as
    the id, `link` ⇒ http(s) URL, `authored_at` = a real `YYYY[-MM[-DD]]` not in the future (1 day slack),
    ≤ 500 chars each) → ONE error listing both, telling the avatar to ask ONCE, in ONE message, only for those
    (any other "unknown" → a gap); the pages cite the `raw/new-source.md` placeholder
    (`TEAM_NEW_SOURCE_PLACEHOLDER`), swapped for the minted raw path before validation. A CORRECTION or
    maintenance: no `source`; the pages cite existing `raw/` files. Then `validateChangeset`, the `baseBlob`
    check of every update against HEAD, the cap — and a `direct` draft row + the card.
  - `team_brain_health` — the lint report (`teamBrainHealth`) for every member; counts outside the wrapper,
    page-derived detail inside. Admin-only parts of its TEXT, judged live: the "about N cards" estimate; a
    non-admin is told instead that the `raw/legacy/` sources are the admins' migration pass. It ends with
    the caller's own personal notes linked to team pages (`listTeamBrainPersonalLinks`, ≤ 20).
- **Admins (`TEAM_BRAIN_ADMIN_TOOL_NAMES`):** `prepare_team_policy` ("Team policy" above).
- **The migration pass is enforced for admins at DRAFT time — `legacyCitationRefusal`.** After validation,
  for a caller who is not an active admin RIGHT NOW (`store.isActiveAdmin(viewer)`, not the run-start
  boolean), `prepare_team_changes` refuses a changeset in which a page newly cites a `raw/legacy/…` source
  it did not cite at HEAD (every citation of a CREATED page is new). Correcting a page that already cites
  one stays open to everybody, and the refusal says the rest of the changeset can still be drafted. It is
  NOT re-checked at the apply press → "Known gaps".
- **Per-call self-gates** (tools/list is a static catalog): the write tools refuse without `ctx.write` / a
  card sink (`NOT_HERE_WRITE` — "only in the owner's own interactive conversation") and for an account that
  is not `isActiveUser` NOW (`SUSPENDED`); `prepare_team_policy` re-checks `isActiveAdmin(viewer)`
  (`NOT_ADMIN`). Each refusal ends with a no-other-route line.
- No tool changes the vault or a row's status: each one at most creates a `draft` row and calls
  `onCard` (→ `AgentEvents.onTeamBrainCard`, stamped with `currentTextAnchor()`), then returns at once
  ("NOTHING is changed yet") — "no tool call ever waits for approval" holds.
- **A removed tool name still answers — at `/mcp`.** A conversation started before the upgrade has a FROZEN
  prompt (and pi a frozen tool list) naming `propose_team_note`, `answer_team_questions`,
  `list_team_proposals`, `get_team_proposal`, `prepare_team_review`. `RETIRED_TOOL_MESSAGES`
  (`src/server/mcpHttp/endpoint.ts`, keyed `<server>/<tool>`, next to `RETIRED_SERVER_MESSAGES`) answers a
  `tools/call` of one BEFORE the gates, never reaching the server, with an English "was removed … do not
  retry" that redirects to `prepare_team_changes` (and names `team_brain_health`). tools/list and the pi
  catalog never list them (the tools are simply not built). Tests: `tests/mcp-http-endpoint.test.ts`,
  `tests/agent-team-brain.test.ts`.
- The procedure (adding knowledge, corrections, lint fixes; the admin-only migration pass and policy
  section) is the bundled `team-brain-curate` default skill; `brain-share` selects personal notes;
  `brain-ingest` may OFFER a team card.

## Metacognition
- Prompt (`teamBrainSection`, frozen, no counts) on the owner, teammate and consultation branches, keyed on
  `request.teamBrain` (`{read, write, admin, guidelines?}`): the read line ("a wiki every teammate writes
  through their own avatar and anyone may correct … with no review before or after") + trust note always; on
  a WRITE run also `TEAM_KNOWLEDGE_DEFINITION`, `TEAM_SHARE_LEVEL_RULE`, `TEAM_OFFER_TO_SHARE` (offer +
  intake: per-type required facts from `TEAM_INTAKE_REQUIRED`), `TEAM_WRITE_FLOW` (the ONE flow every teammate
  has: read SCHEMA.md + index + the pages, compile ONE changeset, nothing changes until the user presses,
  conflicts listed for the user to judge), then `TEAM_ADMIN_EXTRAS` for an admin (the policy card, the
  migration pass) or `TEAM_ADMIN_ONLY_NOTE` for everyone else (what stays with the admins, and that the
  server refuses a new `raw/legacy/` citation), then `TEAM_CARD_PRESS_NOTE`, then the guidelines block;
  otherwise "Writing to the team brain is not available in this run". The Brain policy section keys its team
  rules on `BrainPolicyScope.teamWrite`.
- The prompt is FROZEN per conversation, so the write/admin wording is the first turn's: a later routine
  or API turn on the same session, or a role change, can make it overstate — and a conversation started
  BEFORE 2026-11-13 still describes the review queue. The tool errors (incl. the retired-tool answers) and
  the live `describe_system` line stay exact — that is the accepted trade (no volatile text in the frozen
  part).
- `describe_system` (live): `teamBrainStatusLine` — wiki page count + schema version ("below the current page
  rules" only when `teamSchemaMigrationPending`); a run that cannot write: "read-only in this run"; EVERY
  write run: that every teammate writes it through `prepare_team_changes` and nobody reviews, the admin line
  (an admin: policy through `prepare_team_policy`, the migration pass is theirs; anyone else: POLICY.md, the
  backup and the migration pass stay with the admins), that a confirm press is reported, the health counts
  (uncompiled sources, pages failing SCHEMA.md, past `review_after`; a bounded scan with a 3 s ceiling that
  degrades to a pointer at `team_brain_health`), the POLICY.md knobs + whether guidelines are set, and the
  promoted-note count. No queue numbers exist any more. Admins also get `teamBrainBackupLine`.
  `read_manual` "The team brain" (`systemManual.ts`) describes the same flow, what stays admin-only, that an
  older version had a review queue (a submission open at the upgrade was closed — ask the avatar again), and
  the team policy; the `knowledge` guide carries the Brain policy (`brainPolicyManualText`). The old-group
  line redirects to the team brain (`GROUP_REPOS_RETIRED_SENTENCE`, still needed for older frozen prompts).

## Cards and routes (`teamBrainActions.ts`, `routes/teamBrain.ts`)
- A card is a `kind:"team_brain"` `MessageAttachment` (id = proposal id; no file behind it), emitted on the
  `file` SSE event and persisted with the message. `TeamBrainCard.tsx` reads its live state from
  `GET /api/team-brain/cards/:id` — visible ONLY to the row's drafter (anyone else: 404). The view
  (`TeamBrainCardView`) = `{ proposal, stale, pages, actions: { apply, cancel }, provenance, legacy }`:
  `pages` per changed page (before = committed content while a draft, after, stale; a policy card: ONE entry,
  POLICY.md); `actions.apply` = a draft that is not stale AND the VIEWER may apply it now
  (`isActiveUser`; a policy card: `isActiveAdmin`); `actions.cancel` = any draft; `legacy` set only on a card
  of the retired queue (then `pages: []`, both actions false, `provenance: null`).
- **Provenance edit** (`PUT …/provenance` `{sourceKind, source, author, authoredAt}` →
  `editTeamBrainProvenance`): only the drafter (an account no longer active: 404), only a `direct` card that
  brings a source (`hasOwnSource`; otherwise 409), only while it is a `draft` (CAS
  `updateTeamBrainDraftIntake`, bumps `updated_at` = restarts the expiry clock); `withTeamProvenance`
  merges + re-validates (400 with the Korean `teamProvenanceProblemLabel` texts), secret scan, audit
  `team_brain_edit_provenance`. The view's `provenance` = `{editable, issues}` (null on a card without an
  own source); **apply is refused (409) while `issues` is non-empty** — a draft fills it on the card first.
- **Apply** (`POST …/apply` → `pressTeamBrainCard` → `applyTeamBrainCard`), checks in order: the presser is
  the row's drafter (else 404); a legacy card → 409 (`RETIRED`); a `policy` card needs `isActiveAdmin` (403
  "관리자만 팀 정책을 바꿀 수 있습니다."), a `direct` card `isActiveUser` (403 "정지된 계정은 팀 브레인 카드를 처리할 수
  없습니다."); still a `draft` (else 409, naming the status now to the avatar); complete provenance; a
  non-empty changeset; then the CLAIM (compare-and-set), `applyTeamChangeset` / `applyTeamPolicy`, and the
  claim RELEASED on a failed write (409 stale / invalid with a Korean message, or 500). The raw file names
  the presser as both submitter and approver. Success schedules a backup push (`onCommitted`).
- **Cancel** (`POST …/cancel` → `cancelTeamBrainCard`; the route was `/withdraw` until 2026-11-13): drafter
  only (404), legacy → 409, suspended → 403, CAS `draft → cancelled` (else 409). Never reported to the avatar.
- **One card, one press.** No batch route exists. What replaces the old batch refresh: when a card is
  APPLIED, every other draft card on screen re-reads (`draftCardRereads`, a module-level set in
  `TeamBrainCard.tsx`) — its commit may have changed a page another draft changes, which is then stale.
- Audit: `team_brain_direct` (a direct apply), `team_brain_policy` (success and error), `team_brain_apply`
  (status `error`, a 500 on a direct apply), `team_brain_cancel`, `team_brain_edit_provenance`, and the
  backup's `team_brain_backup_config` / `team_brain_backup` / `team_brain_restore`.
- **A press is TOLD to the avatar at once (user decision 2026-11-11)** — the confirm button (`apply`:
  팀 브레인에 반영 / 팀 정책 반영), done or refused; 취소 never (`TEAM_BRAIN_CARD_PRESS_ACTIONS = ["apply"]`). A
  card tool returns at once, so the drafting turn is usually over when the button is pressed and the avatar
  would learn of it only by looking. `pressTeamBrainCard` (`teamBrainActions.ts`, what the apply route
  calls) runs the action and RECORDS a report in `store.noteTeamBrainCardPress`
  (`teamBrainCardPress.ts`: `TeamBrainCardPressLog`, process memory, one report per (presser, card), the
  latest press wins, TTL 10 min, 200 at once; a report lost to a restart only costs a look). Recorded for the
  presser's OWN LIVE card only (a 404 names nothing; a legacy card has no button to report). The report is
  `composeTeamBrainCardPress`: an English text starting with `TEAM_BRAIN_CARD_PRESS_MARK` ("[Team-brain card
  press" — Noah's report, not typed by the user; the button pressed, the card by kind + title + draft id, DONE
  with the committed source and pages / linked personal notes → PROMOTED NOTES, or FAILED with the action's
  own reason, then what to do now) and a Korean bubble (`teamBrainCardPressBubble`, shared: the client draws
  the same line before the server answers). A failed action carries its agent-facing reason in
  `TeamBrainActionResult.agent` (stale → which path and "draft a new card"; invalid → the schema's own English
  errors, ≤ 10; provenance → the missing slots, "the user fills it on the card"; not a draft any more → its
  status now; suspended / not an admin → "nothing you draft can change that"; 500 → "not the card's fault,
  press again") — never shown in the UI. The card's title is text the presser's own avatar drafted, so it is
  quoted in the report.
  **Delivery is the presser's chat, and the text is the SERVER's:** both chat routes take ONLY
  `teamBrainCardPress: {proposalId}` and look the report up (no recorded press → 409 "전달할 카드 처리 결과가
  없습니다", so a browser can neither invent a press nor change its outcome) and refuse a chat that is not
  with the presser's own avatar. **Told at most once:** the route TAKES the report in the same tick it looked
  (`takeTeamBrainCardPress` — the turn route has no `await` between its peek and the take just before
  `executeChatTurn`; keep it so), so two requests never both carry it, and gives it back
  (`restoreTeamBrainCardPress`; a newer press of the same card wins) only when it did not reach the avatar:
  the turn was refused before its run opened, the steer was refused, or the steer was `dropped` (stop / error
  before the model took it — `pushRunSteer`'s `onDropped`). Idle pane → `POST /api/chat/stream` (a turn of its
  own: `agentMessage` = the report, `displayMessage` = the bubble; no rewind / regenerate / attachment /
  canvas submission rides it). Answer still streaming → `POST /api/chat/runs/:runId/message` (a steer with
  `displayText` + `cardPress`; see `chat-sse-media.md`). Client: `TeamBrainCard.act` → `reportTeamBrainCardPress`
  (`lib/chat.ts`) for 200 and for the action's own refusals (403 / 409 / 500), its pane read by
  `closest("[data-pane]")` AT THE PRESS (a card in the live bubble is unmounted when its turn ends, maybe
  before the server answers). A steer the run refuses (wrapping up, no channel) and a `dropped` press steer go
  out as a turn once the pane's turn is OVER — `whenPaneIdle` waits for `!streaming && !abortController`
  (≤ 10 min, same conversation): `streaming` drops at the `done` frame, but the send/attach loop's `finally`
  runs later and would wipe the live state of a turn started in between. A press turn that cannot be sent is
  undone without a toast (the card already shows the outcome). `pressTeamBrainCard` also records a failed
  report when the action THROWS. Standing guidance: `TEAM_CARD_PRESS_NOTE` is its own part of every write
  run's team-brain section, every "card shown" tool result ends "Then stop: Noah tells you what the press
  did…" (`CARD_PRESS_REPORTED`), the `describe_system` team-brain line and `read_manual` say the same; when no
  report came the avatar LOOKS (team `get_note` on the pages, or `wiki/log.md`). A conversation whose prompt
  was frozen before this still understands the report (it explains itself). **A new card button goes through
  `pressTeamBrainCard`** and joins `TEAM_BRAIN_CARD_PRESS_ACTIONS`.
- Reads: `GET /api/team-brain/graph` (`{graph}`), `/note?path=` (`readTeamVaultFile`) — any signed-in
  teammate. Admin: `GET /api/admin/team-brain` (`noteCount`, `rawSources`, `uncompiledSources`, `backup`,
  `githubHost` — no `pendingReview` any more), `…/policy`, the backup routes.

## Gating (`runCapabilities.ts`)
| Booleans | Rule |
|---|---|
| `teamBrainReadActive` | `elevatedToolAccess \|\| consultationRun` — every run with a known approved principal |
| `teamBrainWriteActive` (was `teamBrainProposeActive`, same conditions) | `onTeamBrainCard` sink && `ownerToolAccess` && !consultation && !headless && !externalTaskApi (the share-link shape) — every approved teammate's own interactive run; registers `prepare_team_changes` + `team_brain_health` |
| `teamBrainAdminActive` | write && `isActiveAdmin(avatar.id)` — on a write run the viewer IS the owner, so a teammate chatting with an admin's avatar never gets it; opens ONLY `prepare_team_policy` (and the admin wording) |
| `brainServerActive` | `brainActive` (personal) \|\| team read — the server also rides runs with no personal repo; `personalActive` makes personal scope refuse there |
- The same three booleans are stamped as `AgentRequest.teamBrain` (`{read, write, admin}`; `.write` was
  `.propose`) for the prompt and as `SystemToolsContext.teamBrain` for `describe_system`, and key
  `mcpAllowedTools` — the prompt never names a tool the run lacks.
- **No MCP tool group**: a new group would be silently OFF for every user with a saved composer selection
  (`selected_mcp_tool_groups` is an explicit list). Consequence: `brain` is in every owner run's
  servers (`tests/agent-run.test.ts` pins it).
- The pi catalog builds the widest `brain` (team write + admin tools; handlers self-gate per call);
  `catalogText.ts` adds a discovery sentence for `prepare_team_changes`.

## Backup (`teamBrainBackup.ts`, `AppServices.teamBrainBackup`)
- Admin-only (`/api/admin/team-brain*` behind `requireAdmin`), unchanged by 2026-11-13. Settings + status in
  `app_config` (encrypted): `team_brain_backup` `{url, branch, adminId}` and
  `team_brain_backup_status`. `configure` (PUT `/api/admin/team-brain/backup`) requires `owner/repo` or an
  `https` URL that passes `isInternalGitSource` (fail closed) and `assertSafeGitValue`; the SAVING admin's
  token pushes from then on.
- **Unavailable without an internal host**: `GITHUB_HOST` unset (→ `github.com`) makes `isInternalGitSource`
  accept public github.com and the `owner/repo` shorthand, so `configure` and every push refuse outright.
- Push: debounced 30 s after each commit (`schedule`, timer unref'd — any teammate's applied card schedules
  one) + `POST …/backup/push`;
  `git push -- <url> main:refs/heads/<branch>` under the vault lock — **never `--force`**: only a
  fast-forward lands, so a branch holding history the vault does not know (the mirror after a lost volume,
  a mistyped project repo) is refused with an explanation instead of overwritten. Auth via `gitAuthConfig`
  (env, never argv/disk). Policy, admin status and token are re-checked at PUSH time; failures land in
  `lastError` (admin panel + the admin's describe_system).
- Restore (`POST …/backup/restore`): only into a vault with no notes AND no raw sources (re-checked under the lock; a restored pre-schema mirror is migrated right after); clones to a temp dir, drops
  `origin`, refuses symlinks/submodules (`120000`/`160000`) and a mirror without `wiki/`, renames the old
  vault aside (never deleted). The DB is on the same volume — after a lost volume the card rows and settings
  are gone too: re-enter the URL, then 복원.
- Tests drive the real push/clone through a temp `GIT_CONFIG_GLOBAL` `url.<file>.insteadOf` rewrite of the
  internal https URL (`tests/team-brain-backup.test.ts`).

## UI
- **The card (`TeamBrainCard.tsx`) has TWO buttons:** the confirm button (`teamBrainCardButtonLabel`:
  팀 브레인에 반영, or 팀 정책 반영 on a policy card) and 취소. Header: the kind (팀 브레인 변경 / 팀 정책 변경),
  the title and "원본 1건 · 페이지 N개 (새 페이지 a · 수정 b)". Cards never render teammate markdown/HTML:
  source, intake and diff lines are text (`<pre>`, `<del>`/`<ins>`).
  출처 정보 is its own block (all four rows; a missing one = 미기재 chip, unknown = 모름), shown OUTSIDE the
  원본 보기 fold and above 보충 정보, which does not repeat them. On an editable draft it carries 수정 → an
  inline form (kind `<select>`, source `type=url` for 웹 링크, author, date) validated client-side with the
  SAME shared rules before the PUT; while `issues` is non-empty the form opens by itself, has no 취소, and
  the confirm button stays disabled with a line saying why (the gated button's prerequisite is the first
  step). Then the linked 내 브레인 notes, the model-flagged conflicts OPEN (확인이 필요한 충돌 — the drafter is
  the one who judges them), and per page a line diff (`src/shared/lineDiff.ts`, bounded LCS, unchanged runs
  collapsed) with deletions prominent ("삭제 N줄" chip); a `policy` card shows the POLICY.md diff unfolded.
  A draft the server will not let THIS viewer apply (not stale, `actions.apply` false) says so in its status
  line instead of showing the button. A draft re-reads when the tab becomes visible again and when another
  card on screen is applied.
- **A card of the retired queue is history:** the title + the server's ONE line (`view.legacy.notice`; the
  closed-by-upgrade notice in the info tone), no buttons, no provenance form, no diff.
- Team notes render through `renderMarkdown(…, { forbidInlineStyle: true })` — teammate-written HTML must
  not position itself over the app (fake UI); the card shows raw text in `<pre>`.
- **Two rail items (user, 2026-11-06): 내 브레인 (`brain`, `#/brain`) and 팀 브레인 (`teamBrain`,
  `#/teamBrain`)** — the old single 지식 그래프 item with in-view tabs is gone. Both render `BrainView`
  (`scope` prop); 팀 브레인 goes through the thin `TeamBrainView.tsx` wrapper so switching between them
  REMOUNTS (`App.tsx` renders the active view in one place, and React keeps an instance whose component
  type did not change — `BrainView` rendered for both would keep its state). The reading pane's width is
  ONE device-local value for both brains (`localStorage["noah.brainNoteWidth"]`, px; absent = the CSS
  default `min(51%, 720px)`), dragged on the `.brain-splitter` between graph and pane (arrow keys; Home /
  double-click = back to the default) and applied as `--brain-note-w`; the CSS clamp keeps both the pane
  and the graph at 320px or more whatever is stored, and the splitter is hidden once the panes stack.
- **The 팀 브레인 view is READ-ONLY and has no lists (2026-11-13).** With no node selected its side panel
  shows one hint line (ask the avatar to add or correct, then press the card) above the hub notes; the
  내 제안 / 검토 대기 lists, 검토 시작 and 제안 철회 are gone. The rail item has NO badge and nothing polls for
  one: `lib/teamBrain.ts` (status poll, badge, result toasts, `teamBrainCardsChanged`) and
  `ClientState.teamBrainStatus` were deleted.
- 관리자 → 팀 브레인 (`AdminTeamBrainPanel.tsx`): the wiki page count (opens the 팀 브레인 view) and the raw /
  미편찬 counts — no 검토 대기 stat — plus the backup address/branch/status, 지금 백업, 백업에서 복원, and the
  read-only 팀 정책 view (settings vs defaults, problems, guidelines as text, change history — changes go
  through the admin's own avatar + a card).

## Retired (reserved forever)
Retired with the review queue on 2026-11-13. Never mint, mount or reuse one for a new meaning.
- **Tools** (`mcp__brain__…`): `propose_team_note`, `answer_team_questions`, `list_team_proposals`,
  `get_team_proposal`, `prepare_team_review` (answered by `RETIRED_TOOL_MESSAGES`).
- **Proposal kinds:** `propose`, `review`. **Statuses:** `pending`, `approved`, `rejected`, `needs_info`,
  `withdrawn`. **Review decisions:** `approve`, `reject`, `ask` (`TEAM_BRAIN_DECISIONS`, decode only).
  All stay in the types so old rows parse.
- **Routes:** `GET /api/team-brain/status`, `GET /api/team-brain/proposals/mine`,
  `GET /api/team-brain/proposals/pending`, `POST /api/team-brain/cards/:id/submit`, `…/submit-all`,
  `…/withdraw`; the `pendingReview` field of `GET /api/admin/team-brain`.
- **Press actions:** `submit`, `submit_all`.
- **Audit events:** `team_brain_submit`, `team_brain_withdraw`, `team_brain_approve`, `team_brain_reject`,
  `team_brain_ask` (old audit rows keep them).
- **Shared contract:** the `TeamBrainStatus` badge contract (`{unseenResults, pendingReview}`),
  `TEAM_BRAIN_SUBMIT_ALL_MIN`, `isTeamBrainCardPressAction`, `TeamIntakeFollowup` /
  `TeamBrainIntake.followups`, `TeamBrainCardView.target` and `actions.submit / withdraw / submitAll`.
- **Vault:** log op `ingest`, the `Co-authored-by` commit trailer, the raw file's `## Follow-up` sections.
- **Prompt / gating names:** `TEAM_MEMBER_FLOW`, `TEAM_ADMIN_FLOW`, `TEAM_BRAIN_PROPOSE_TOOL_NAMES`,
  `teamBrainProposeActive`, `AgentRequest.teamBrain.propose`, `BrainPolicyScope.teamPropose` (renamed, not
  reserved ids — listed so a grep of an old note lands here).

## Known gaps and what nobody verified
- **The migration-pass rule is a DRAFT-time check only.** `legacyCitationRefusal` runs in
  `prepare_team_changes`; `applyTeamBrainCard` asks only `isActiveUser` for a `direct` card. A drafter who was
  an admin when the card was drafted and was demoted before pressing still commits it. (The policy card IS
  re-checked at the press.)
- POLICY.md's review ceiling is a draft-time rule too (by design — see "Team policy").
- A press report lives in process memory: one lost to a restart costs a look.
- A conversation started before 2026-11-13 keeps its frozen queue wording; only tool results and
  `describe_system` correct it.
- **Not verified by anyone (2026-11-13):** the UI in a real browser; a real pi-gateway session calling a
  retired tool name; the boot chain (vault migrate → queue retirement → sweep) run end to end in one
  process; real production data (the open-row shapes come from the test fixtures).
