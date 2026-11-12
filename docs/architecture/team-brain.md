# Team brain (팀 브레인)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> The ONE instance-wide shared knowledge vault (back 2026-11-06, after the per-GROUP brain was retired
> 2026-10-30), restructured the same day into a Karpathy-style LLM wiki (`raw/` sources → schema-validated
> `wiki/` pages compiled by the admin's avatar): the local-only git vault and its fixed schema, the proposal
> queue and its confirm cards, the run-class gating, both metacognition surfaces, the backup mirror, and the UI.

## Decisions (user, 2026-11-06)
- ONE vault per Noah instance (the instance IS the team). **Local git only** — no `origin`, no user
  tokens, no GitHub permissions involved. Only Noah's own code writes it.
- Teammates **read + submit SOURCES**; an **admin's avatar compiles** them into wiki pages at review time
  (the curator is the admin's own interactive run — no background curator, no new run class); the admin
  **presses** the card. An admin's own knowledge / maintenance skips the queue (one press).
- Proposals come **only from the avatar** (no UI form to START one). The avatar proactively offers ("팀에 공유할까요?"),
  driven by the four team-knowledge tests; **no frequency limit** (revisit after real-model use).
- Every state change is a **human press on a chat card** (option A — the model only drafts).
- **No delete** op (a wrong page is corrected with an update; a reversed decision is superseded).
  **Badges** announce results.
- **Backup** = an admin-set repository on the INTERNAL git host, pushed with THAT admin's own token.
- **LLM-wiki restructure (same day, user):** Karpathy-style `raw/` → `wiki/` + server-generated index/log;
  the submitter's avatar runs an **intake interview**; a **FIXED `SCHEMA.md`** in code that the server
  validates on every change; every pre-schema note moved to `raw/legacy/`; a schema change = version bump
  + the admin's one-time migration pass (`team-brain-curate` skill).
- **Provenance is required (same day, user: option C after "출처·작성자·작성일 하나도 작성하게 안되어있다").**
  Every type's intake starts with `TEAM_PROVENANCE_SLOTS` = `source_kind` (one of `TEAM_SOURCE_KINDS`:
  document | link | meeting | message | verified | other) + `source` (the reference itself) + `author` (the
  ORIGINAL's author) + `authored_at` (the original's date) — the server's own `submitted_by/at` stamps say
  who put it into Noah, these say where it came from. The drafter can fill/correct the four ON THE CARD
  while it is a draft (the one in-card edit; still no form to start a proposal). C = A (the slots, asked by
  the avatar) + B (the card edit) + a STRUCTURED origin (kind + reference) — a link is checked as a URL, a
  date as a date, and both are machine-readable in raw frontmatter. SCHEMA.md (wiki page rules) is
  unchanged, so no schema-version bump: raw files are server-rendered, never validated as pages.
- **Brain policy + team policy (user, 2026-11-10, SSOT):** one fact, one home — team knowledge's
  canonical home is the team brain, personal context stays personal; every personal-vs-team rule lives in
  ONE module (`agent/brainPolicy.ts`, see [`repo-knowledge.md`](repo-knowledge.md)). The ADMINS own a
  `POLICY.md` in the vault: knobs the server enforces (frontmatter) + natural-language guidelines (body),
  changed ONLY through an admin's policy card and viewed under 관리자 → 팀 브레인. SCHEMA.md and the fixed
  core stay in code. Approved submissions record the personal notes they came from; nothing ever writes
  the personal repo for it (forcing was rejected: it makes conflict handling harder).
  Decisions: `~/.noah-work/brain-policy-2026-11-10/decisions.md`.
- Designs + rejected alternatives: `~/.noah-work/team-brain-2026-11-06/design.md`,
  `~/.noah-work/team-brain-wiki-2026-11-06/design.md` (+ `research/`: Karpathy gist, follow-ups).

## The vault (`teamBrain.ts`, `teamBrainSchema.ts`)
- `<dataDir>/team-brain`, branch `main`, created lazily (`ensureTeamBrainRepo` = init-or-migrate under
  the lock). Search (`rankBrainNotes`, now with an additive `{prefix}` option) and the graph
  (`buildKnowledgeGraph`) are reused with this root.
- **Layout (schema v2):** `SCHEMA.md` (`TEAM_BRAIN_SCHEMA_MD`, first line `<!-- noah-team-brain-schema: N -->`);
  `POLICY.md` (`TEAM_POLICY_PATH`, the admins' policy — see "Team policy" below; never a page-changeset target,
  in `TEAM_STRUCTURAL_PATHS`);
  `raw/YYYY/MM/<date>-<id8>.md` (`teamRawPath`) = one approved submission, RENDERED BY THE SERVER at apply
  (`renderTeamRaw`: server-stamped submitter/approver, then the provenance answers as frontmatter keys
  `source_kind`/`source`/`author`/`authored_at` (omitted on rows from before they were asked), verbatim
  source, the other intake answers, follow-ups) and never
  a change target; `raw/legacy/…` = pre-schema notes; `wiki/<TEAM_PAGE_FOLDERS[type]>/<slug>.md` = pages;
  `wiki/index.md` REGENERATED from page frontmatter on every commit (`renderTeamIndex`) and `wiki/log.md`
  APPENDED per commit (`formatLogEntry`) — the model never writes either (`TEAM_STRUCTURAL_PATHS`).
- **A raw source is committed only WITH its approved changeset** — reads serve the working tree, so an
  unapproved source must never land there; a rejected/withdrawn source lives only in the DB row.
- **Validation (`parseTeamPage`, `validateChangeset`)** — the schema is enforced, not just prompted:
  required `title`/`type`/`summary`/`sources`/`review_after`; type ⇔ folder; title + aliases unique
  vault-wide (`teamNameKey`, NFC/case-folded) and within the changeset; every `sources` entry an existing
  raw (or the changeset's own new raw — which EVERY changed page must cite); decision `status`
  accepted|superseded with `superseded_by`; ≤ `TEAM_BRAIN_MAX_CHANGES` pages / byte caps; secret scan
  (`findSecretInText`, incl. the writer's own secrets via `ownSecrets`). Errors are agent-facing English,
  returned verbatim so the curator fixes and retries.
- **Migration:** v1 → v2 (2026-11-10) rewrites SCHEMA.md (the review horizon column now names the POLICY.md
  key) and seeds `TEAM_POLICY_DEFAULT_MD` when HEAD has no POLICY.md (an existing one — a restored newer
  mirror — is kept); `initLocked` seeds it on a new vault; `reconcileLocked` cleans it like SCHEMA.md.
  `migrateTeamBrainHoldingLock` — v0 (no marker) → v1 `git mv`s every `wiki/**/*.md` except
  the structural files/templates to `raw/legacy/<rel>`, writes SCHEMA.md, regenerates the index, logs it,
  ONE commit by the Noah identity; a later version bump rewrites SCHEMA.md + log, and the non-conforming
  pages surface in `team_brain_health` for the admin's migration pass. Boot runs `migrateTeamBrainOnBoot`
  (`index.ts`, never throws, schedules a backup push); a restored pre-schema mirror is migrated right
  after the restore. Nothing is deleted (git history + `raw/legacy/`).
- Never handed to a sandbox and never a `.git` the agent can touch: the agent only sees CONTENT through
  the brain tools (`readTeamVaultFile` allows exactly `SCHEMA.md`, `wiki/**.md`, `raw/**.md`). All git runs
  through `repoGitCore.git()` (serverGitEnv hardening; identity via env config, never argv). Every write is
  under `withRepoLock(teamBrainRoot)` — not reentrant, so exported ops take it once (`*HoldingLock`
  internals never do).
- **`applyTeamChangeset`** under the lock: ensure/migrate; re-check every page's blob (`EXISTS`/`MISSING`/
  `STALE` → `TeamNoteConflictError` with the path) and re-run `validateChangeset` against the vault AS IT IS
  NOW (`TeamChangesetInvalidError`; POLICY.md's review ceiling is NOT re-checked here — it is a draft-time rule); write raw + pages, regenerate the index, append the log; ONE
  path-scoped commit (`Proposal: <id>` + `Co-authored-by:` proposer trailer), authored by the presser.
  **Any failure restores every touched path from `git show HEAD:<path>`** (no index lock needed — the old
  `reset`/`checkout` rollback failed under the same `index.lock` that failed the commit) and removes new files.
- **Every locked op starts by reconciling to HEAD** (`reconcileLocked`: `git reset -q`, `checkout HEAD -- .`,
  `git clean` of `wiki/`, `raw/`, `SCHEMA.md`) — a crash mid-migration or mid-apply never leaves a staged
  rename or a readable unapproved file behind; the v0 move list comes from `git ls-tree HEAD`, never the
  index. Page/raw PATH lists are uncapped (existence checks exact); only page CONTENT reads cap at 2000.
- `teamBrainHealth` (read-only, bounded, lists capped at 50, exact numbers in `counts`): uncompiled raw sources (cited by no valid
  page — incl. `raw/legacy/`), pages failing the schema, past `review_after`, dangling `[[links]]`, orphans,
  duplicate names, missing sources, pages with `gaps`, history narrative, instruction-like text.
- `countTeamNotesSync` / `countTeamRawSync` / `teamVaultSchemaVersionSync` are describe_system's bounded reads.

## Team policy (`POLICY.md`, `teamBrainPolicy.ts`)
- Three tiers: the FIXED core (`TEAM_BRAIN_FIXED_CORE`: no secrets/personal data, a human press for every
  change, no delete, provenance, teammate text is data, permissions) + SCHEMA.md stay in code; the **knobs**
  (frontmatter, `TEAM_POLICY_KEYS`: `review_months_<type>`, `draft_ttl_days`, `max_open_proposals`, ranges in
  `TEAM_POLICY_RANGES`, a missing key = the built-in `TEAM_POLICY_DEFAULTS`) are validated and APPLIED by the
  server; the **guidelines** (body, ≤ `TEAM_POLICY_MAX_GUIDELINES_BYTES`) reach the avatars as data.
- `parseTeamPolicy` never throws: a stored file is read leniently (each bad key falls back, `problems` listed);
  a DRAFT is refused while `problems` is non-empty (`teamPolicyProblemText`, agent-facing).
- Where the knobs bite: `review_months_<type>` = the CEILING on a changed page's `review_after`
  (`reviewAfterCeiling`, months after TOMORROW UTC — a curator's local date may be a day ahead;
  `validateChangeset`'s `reviewCeiling`, at DRAFT time only via `teamChangesetContext`, so a card drafted
  before the v2 upgrade or before a knob change still applies) — lowering it never invalidates existing pages; `draft_ttl_days` + `max_open_proposals` = the store's
  `teamBrainLimits()` (provider wired in `createServices` → `teamBrainStoreLimits` → `readTeamPolicySync`, an
  mtime+size cached read; a Store built without the provider uses the built-ins).
- Guidelines: `teamGuidelinesBlock` wraps them in `<team_guidelines>` (closing tag defused) under the fixed
  core, on PROPOSE runs only, stamped at run start into `request.teamBrain.guidelines` (frozen with the
  prompt — a policy change reaches new conversations); the seeded stub adds nothing (`teamGuidelinesAreEmpty`
  in `src/shared/teamBrain.ts`, the ONE rule the admin panel uses too: only HTML comments + the seeded
  `# Team guidelines` heading count as empty). A draft with a frontmatter line the parser would skip
  (indented / misspelt key) or text before the opening `---` is refused (`unparsed_line`, `leading_text`).
- First use: the vault is lazy, so `prepare_team_policy` (and an admin's team `get_note` on POLICY.md) run
  `ensureTeamBrainRepo` first — the blob a draft records is the seeded file the press will find.
- Changing it: admin tool `prepare_team_policy` (full file + `baseBlob` from team `get_note` on POLICY.md —
  refused when stale/missing, unchanged, invalid or secret-bearing) → a `kind: "policy"` row (`path`
  POLICY.md, `content` = new file, `base_blob` = the blob seen) → the card's **팀 정책 반영** →
  `applyPolicyCard` → `applyTeamPolicy` (lock, STALE/invalid re-check, POLICY.md + log op `policy`, ONE commit
  with a `Proposal:` trailer, restore on failure; the boot sweep covers policy cards too). Audit
  `team_brain_policy`.
- Reads: team `get_note` on `POLICY.md` (blob + the settings in force); `describe_system` (propose runs: knobs
  + whether guidelines are set); `GET /api/admin/team-brain/policy` (`TeamPolicyView`: knobs, guidelines,
  Korean `problems`, `teamPolicyHistory` = git log of POLICY.md) for the admin panel.

## Personal-note links (`personal_notes_json`)
- `propose_team_note` / `prepare_team_changes` (with OR without a source — a maintenance card links too,
  #82, 2026-11-10) take `personalNotes` (≤
  `TEAM_BRAIN_MAX_PERSONAL_NOTES` `wiki/` paths of the OWNER's personal brain). brainTools resolves each over the
  owner's clone (`personalNote` callback in `TeamBrainToolsContext`, owner runs with a personal brain only;
  a link note or a missing note is refused) and the row stores `{path, blob}` (`personalNoteBlobId` = git's
  blob id). NOTHING is written to the personal repo — then or later.
- **The link exists only when the avatar passes it — soft by decision.** The server never searches the
  personal brain for candidates. The execution point is `BRAIN_LINK_CHECK_RULE` ("BEFORE A TEAM CARD",
  `brainPolicy.ts`): before every team card the avatar searches the personal brain for the topic and passes
  the notes that state the same fact. `TEAM_OFFER_TO_SHARE` (intake) and `TEAM_ADMIN_FLOW` point at it by
  name (`BRAIN_LINK_CHECK_NAME`), the `personalNotes` parameter description repeats the trigger, and the
  curate skill refers to it. A server-side candidate detector is the next step only if this still misses.
- `listTeamBrainPersonalLinks(owner)` = approved propose rows (pages from their applied approve review) and
  applied direct rows that recorded notes. brainTools marks them at READ time: personal `get_note` prepends
  `PROMOTED: … canonical version is the team page … has / HAS CHANGED since it was submitted` (+ the
  PROMOTED NOTES hint for the owner; a link from a MAINTENANCE card — `fromSource: false`, the direct row
  has no raw `path` — reads "recorded as stating the same fact … was NOT that page's source", because the
  page was compiled from other sources and the note may say more), personal `search` appends a "Team-brain links" block, a note with
  `team_page:` frontmatter reads as a LINK note; `list_team_proposals` (mine) lists them; `describe_system`
  counts them. A teammate's note paths never reach an admin (`/proposals/pending` and a review card's
  `target` send `personalNotes: []`). Converting a note into a link is the owner's avatar ASKING with the five required points
  (`PROMOTED_NOTE_RULE`) — never automatic.

## The queue (`team_brain_proposals`, `store/teamBrain.ts`)
- One table: `kind` = `propose` (teammate source) | `direct` (admin's own changeset, with or without a new
  source) | `review` (admin's decision on a `propose`, `target_id`) | `policy` (admin's POLICY.md change); `status` per `src/shared/teamBrain.ts`
  (adds `needs_info` = 보완 요청); `intake_json` (type + slot answers + gaps + follow-ups) and `changes_json`
  (pages + model-flagged `conflicts`). `path` = the raw path the source will land at (review: the target's;
  maintenance direct: ""). The conversation link is read through a join (todo_items precedent).
- Caps: 64 KB source/page, 15 pages / 256 KB per changeset, POLICY.md `max_open_proposals` (built-in 20) open
  (draft + pending + needs_info) rows per user (checked in the insert transaction); drafts expire
  `draft_ttl_days` (built-in 7) days after their last update (`updated_at` — an
  answered 보완 요청 restarts the clock) OR once their conversation (and so their card) is gone.
- **Approve claims the CARD only; the target becomes `approved` only after the commit lands**
  (`approveTargetAfterCommit`); while that is in flight every other press on the target and the proposer's
  withdraw get 409. Applying ANY review card (and withdrawing the target) cancels the other draft review
  cards for that target (`cancelTeamBrainReviewDrafts`) — an approve drafted before an ask round can never
  commit later; a failed apply restores them and clears decision stamps. The boot sweep
  (`sweepTeamBrainAppliesOnBoot`, last 7 days, one `git log` scan for `Proposal:` trailers) reverts an
  applied card whose commit never landed and approves a target whose commit did.
- `transitionTeamBrainProposal` is compare-and-set on the current status; every decision transition
  (approved / rejected / needs_info) resets `result_seen_at` so a later result badges again; a review press
  claims the card AND its target in ONE transaction. `answerTeamBrainQuestions` is CAS `needs_info → draft`
  and moves the row to the answering conversation.
- One-time row migration (user_version 3): pre-schema `propose` rows still draft/pending keep their note
  text as the SOURCE (path → `teamRawPath`, intake type null = legacy); pre-schema `direct`/`review` drafts
  are cancelled.
- `isActiveAdmin` / `isActiveUser` judge a PERSON live (exists, not suspended, `admin` role).
- Cascades: `deleteUser` → `deleteTeamBrainProposalsForUser` (approved content stays in git);
  `applyConversationRewind` → `withdrawTeamBrainDrafts(conversationId, ids)` — scoped to the rewound
  conversation — for the `team_brain` attachments of dropped messages (a submitted/applied one stays — a
  rewind never undoes the world); a draft that already went through a 보완 요청 round falls back to
  `needs_info` on rewind AND on expiry (its unsent answer dropped), never withdrawn/expired.

## Tools (`agent/teamBrainTools.ts`, on the `brain` server)
- No new MCP server (the 2026-10-29 usability study measured `brain`/`group_brain` confusion): `search`
  and `get_note` take `scope` (`personal`/`team`/`all`); team `get_note` reads `SCHEMA.md`, `wiki/…` and
  `raw/…` (a raw source comes back inside the untrusted wrapper; a wiki page leads with `blob: <id>`, which
  every `update` change must carry as `baseBlob` — a page changed since the read is refused, never reverted); team search lists pages, then
  UNCOMPILED sources (wrapped, labeled "uncompiled source — not yet a wiki page").
- **A search never misses silently.** `rankBrainNotes` scores the first `BRAIN_SCAN_CAP` (2000, = the vault's
  `PAGE_CAP`) notes in PATH order — it was 200 until 2026-11-10, which dropped whole late type folders
  (`wiki/howto/`, `wiki/systems/`) of a wiki past 200 pages with no sign. Beyond the cap the result carries
  `unscanned`, and every team search text (hits AND the no-match line, `teamNoMatchText`) ends with
  `unscannedNote`: "NOT A FULL SEARCH … N note(s) were NOT searched", pointing at `wiki/index.md`.
- Member (`TEAM_BRAIN_PROPOSE_TOOL_NAMES`): `propose_team_note` = a SOURCE submission `{type, title,
  summary, source, answers}` — `checkIntake` against `TEAM_INTAKE_REQUIRED[type]`; missing slots or
  refused provenance (`teamProvenanceProblem`, shared: `source_kind`/`source` never "unknown"
  (`TEAM_INTAKE_NO_UNKNOWN`), kind by id or Korean label → stored as the id, `link` ⇒ http(s) URL,
  `authored_at` = a real `YYYY[-MM[-DD]]` not in the future (1 day slack), ≤ 500 chars each) → ONE error
  listing both, telling the avatar to ask ONCE, in ONE message, only for those (any other "unknown" → a
  gap); an admin is redirected to `prepare_team_changes`. `get_team_proposal` flags a submission whose
  provenance is incomplete (older rows) so the curator can recommend ask. `answer_team_questions` answers a `needs_info` row (appends a
  follow-up, new card). `list_team_proposals`.
- Admin (`TEAM_BRAIN_ADMIN_TOOL_NAMES`): `prepare_team_policy` (above), `get_team_proposal` (raw path to cite, intake/source/follow-ups in
  ONE wrapper, ≤ 5 related pages, "read SCHEMA.md + index first"); `prepare_team_review` approve (a
  validated changeset citing the target's raw) | reject (reason) | ask (1–5 questions → `needs_info`);
  `prepare_team_changes` = the admin's own knowledge (`source` → intake checked, pages cite the
  `raw/new-source.md` placeholder `TEAM_NEW_SOURCE_PLACEHOLDER`, swapped for the minted raw path before
  validation) or maintenance (no source: migration of `raw/legacy/`, lint fixes); `team_brain_health`.
- No tool changes the vault or a row's status: each one at most creates a `draft` row and calls
  `onCard` (→ `AgentEvents.onTeamBrainCard`, stamped with `currentTextAnchor()`), then returns at once
  ("NOTHING is shared yet") — "no tool call ever waits for approval" holds.
- Admin tools re-check `isActiveAdmin(viewer)` per call. Every teammate-written string an admin's agent
  sees sits inside ONE `<untrusted_teammate_text>` wrapper whose closing tag the text cannot forge
  (`untrusted()` defuses any inside). `get_team_proposal` opens only SUBMITTED proposals. Every team read
  carries `TEAM_NOTE_TRUST_NOTE`.
- The curator procedure (review/compile, migration pass, lint fixes) is the bundled `team-brain-curate`
  default skill (admin-only by its tools); `brain-ingest` may OFFER a team submission.

## Metacognition
- Prompt (`teamBrainSection`, frozen, no counts) on the owner, teammate and consultation branches, keyed on
  `request.teamBrain`: the read line + trust note always; on a propose run also `TEAM_KNOWLEDGE_DEFINITION`,
  `TEAM_OFFER_TO_SHARE` (offer + intake: per-type required facts from `TEAM_INTAKE_REQUIRED`) and the member
  or `TEAM_ADMIN_FLOW` ("… its CURATOR"); otherwise "not available in this run".
- The prompt is FROZEN per conversation, so the propose/admin wording is the first turn's: a later routine
  or API turn on the same session, or a role change, can make it overstate. The tool errors and the live
  `describe_system` line stay exact — that is the accepted trade (no volatile text in the frozen part).
- `describe_system` (live): `teamBrainStatusLine` (wiki page count + schema version, migration pending when
  below current; member: can submit sources + unseen results; ADMIN: pending count + health counts —
  uncompiled sources, pages failing SCHEMA.md, past review_after — pointing at `team_brain_health`; every
  propose run: the POLICY.md knobs + whether guidelines are set + promoted-note count) and, for admins,
  `teamBrainBackupLine`. `read_manual` "The team brain" (`systemManual.ts`) describes the same flow and the
  team policy; the `knowledge` guide carries the Brain policy (`brainPolicyManualText`). The old-group line
  redirects to the team brain (`GROUP_REPOS_RETIRED_SENTENCE`, still needed for older frozen prompts).

## Cards and routes (`teamBrainActions.ts`, `routes/teamBrain.ts`)
- A card is a `kind:"team_brain"` `MessageAttachment` (id = proposal id; no file behind it), emitted on the
  `file` SSE event and persisted with the message. `TeamBrainCard.tsx` reads its live state from
  `GET /api/team-brain/cards/:id` — visible ONLY to the row's drafter. The view carries `pages` (per changed
  page: before = committed content, after, stale). Viewing a decided card marks the result seen.
- **Provenance edit** (`PUT …/provenance` `{sourceKind, source, author, authoredAt}` →
  `editTeamBrainProvenance`): only the drafter, only while the row is a `draft` propose or direct-with-source
  (CAS `updateTeamBrainDraftIntake`, bumps `updated_at` = restarts the 7-day clock); `withTeamProvenance`
  merges + re-validates (400 with the Korean `teamProvenanceProblemLabel` texts), secret scan, audit
  `team_brain_edit_provenance`. The view's `provenance` = `{editable, issues}` (null on review/maintenance/
  legacy cards); **submit and a direct apply are refused (409) while `issues` is non-empty** — a draft
  from before provenance was asked fills it on the card first. A review approve of an OLD pending row
  without provenance is allowed (the admin decides; the raw then simply lacks those keys).
- Presses: `POST …/submit` (propose draft → pending; a source has no staleness), `…/withdraw` (propose
  draft/pending/needs_info → withdrawn; direct/review draft → cancelled), `…/apply` (admin; direct →
  `applyTeamChangeset` (log op `direct` with a source, `maintain` without); review approve → target
  approved + commit of target raw + changeset; reject → rejected; ask → target `needs_info` with the
  questions). Apply claims first, writes, and RELEASES the claim on a failed write (409 stale/invalid with a
  Korean message / 500). Each press is audited (`team_brain_submit|withdraw|direct|approve|reject|ask`).
- **A press is TOLD to the avatar at once (user decision 2026-11-11)** — `submit` and `apply`, done or refused;
  취소 / 제안 철회 never. A card tool returns at once, so the drafting turn is usually over when the button is
  pressed and the avatar would learn of it only by looking. `pressTeamBrainCard` (`teamBrainActions.ts`, what
  both routes call) runs the action and RECORDS a report in `store.noteTeamBrainCardPress`
  (`teamBrainCardPress.ts`: `TeamBrainCardPressLog`, process memory, one report per (presser, card), the
  latest press wins, TTL 10 min, 200 at once; a report lost to a restart only costs a look). Recorded for the
  presser's OWN card only (a 404 names nothing). The report is `composeTeamBrainCardPress`: an English text
  starting with `TEAM_BRAIN_CARD_PRESS_MARK` ("[Team-brain card press" — Noah's report, not typed by the
  user; the button pressed, the card by title + draft id, DONE with the committed paths / linked personal
  notes → PROMOTED NOTES, or FAILED with the action's own reason, then what to do now) and a Korean bubble
  (`teamBrainCardPressBubble`, shared: the client draws the same line before the server answers). A failed
  action carries its agent-facing reason in `TeamBrainActionResult.agent` (stale → which path and "draft a new
  card"; invalid → the schema's own English errors, ≤ 10; provenance → the missing slots, "the user fills it
  on the card"; not a draft any more → its status now; 500 → "not the card's fault, press again") — never shown
  in the UI. A REVIEW card is named by ids only: its title is the submission's, a teammate's text.
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
  report when the action THROWS. Standing guidance: `TEAM_CARD_PRESS_NOTE` closes both `TEAM_MEMBER_FLOW` and
  `TEAM_ADMIN_FLOW`, every "card shown" tool result ends "Then stop: Noah tells you what the press did…", the
  `describe_system` team-brain line and `read_manual` say the same. A conversation whose prompt was frozen
  before this still understands the report (it explains itself).
- Reads: `GET /api/team-brain/status` (badge; needs_info counts as a result), `/proposals/mine` (marks seen),
  `/proposals/pending` (admin, read-only), `/graph` (`{graph}`), `/note?path=` (`readTeamVaultFile`).

## Gating (`runCapabilities.ts`)
| Booleans | Rule |
|---|---|
| `teamBrainReadActive` | `elevatedToolAccess \|\| consultationRun` — every run with a known approved principal |
| `teamBrainProposeActive` | `onTeamBrainCard` sink && `ownerToolAccess` && !consultation && !headless && !externalTaskApi (the share-link shape) |
| `teamBrainAdminActive` | propose && `isActiveAdmin(avatar.id)` — on a propose run the viewer IS the owner, so a teammate chatting with an admin's avatar never gets it |
| `brainServerActive` | `brainActive` (personal) \|\| team read — the server also rides runs with no personal repo; `personalActive` makes personal scope refuse there |
- **No MCP tool group**: a new group would be silently OFF for every user with a saved composer selection
  (`selected_mcp_tool_groups` is an explicit list). Consequence: `brain` is now in every owner run's
  servers (`tests/agent-run.test.ts` pins it).
- The pi catalog builds the widest `brain` (team propose + admin tools); `catalogText.ts` adds discovery
  sentences for `propose_team_note`/`list_team_proposals`.

## Backup (`teamBrainBackup.ts`, `AppServices.teamBrainBackup`)
- Settings + status in `app_config` (encrypted): `team_brain_backup` `{url, branch, adminId}` and
  `team_brain_backup_status`. `configure` (PUT `/api/admin/team-brain/backup`) requires `owner/repo` or an
  `https` URL that passes `isInternalGitSource` (fail closed) and `assertSafeGitValue`; the SAVING admin's
  token pushes from then on.
- **Unavailable without an internal host**: `GITHUB_HOST` unset (→ `github.com`) makes `isInternalGitSource`
  accept public github.com and the `owner/repo` shorthand, so `configure` and every push refuse outright.
- Push: debounced 30 s after each commit (`schedule`, timer unref'd) + `POST …/backup/push`;
  `git push -- <url> main:refs/heads/<branch>` under the vault lock — **never `--force`**: only a
  fast-forward lands, so a branch holding history the vault does not know (the mirror after a lost volume,
  a mistyped project repo) is refused with an explanation instead of overwritten. Auth via `gitAuthConfig`
  (env, never argv/disk). Policy, admin status and token are re-checked at PUSH time; failures land in
  `lastError` (admin panel + the admin's describe_system).
- Restore (`POST …/backup/restore`): only into a vault with no notes AND no raw sources (re-checked under the lock; a restored pre-schema mirror is migrated right after); clones to a temp dir, drops
  `origin`, refuses symlinks/submodules (`120000`/`160000`) and a mirror without `wiki/`, renames the old
  vault aside (never deleted). The DB is on the same volume — after a lost volume the queue and settings are
  gone too: re-enter the URL, then 복원.
- Tests drive the real push/clone through a temp `GIT_CONFIG_GLOBAL` `url.<file>.insteadOf` rewrite of the
  internal https URL (`tests/team-brain-backup.test.ts`).

## UI
- Cards never render teammate markdown/HTML: source, intake and diff lines are text (`<pre>`, `<del>`/`<ins>`).
  출처 정보 is its own block (all four rows; a missing one = 미기재 chip, unknown = 모름) above 보충 정보,
  which no longer repeats them. On an editable draft it carries 수정 → an inline form (kind `<select>`,
  source `type=url` for 웹 링크, author, date) validated client-side with the SAME shared rules before the
  PUT; while `issues` is non-empty the form opens by itself, has no 취소, and 제출/반영 stay disabled with a
  line saying why (the gated button's prerequisite is the first step). A direct card shows it outside the
  원본 보기 fold; a review card shows the target's read-only inside it.
  The review/direct card shows "원본 N건 · 페이지 N개", the source, the model-flagged conflicts OPEN, and per
  page a line diff (`src/shared/lineDiff.ts`, bounded LCS, unchanged runs collapsed) with deletions
  prominent ("삭제 N줄" chip). 내 제안 shows 보완 요청 + the admin's questions.
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
  and the graph at 320px or more whatever is stored, and the splitter is hidden once the panes stack. The team
  view's side panel (no node selected) lists 내 제안 (status + rejection reason) and, for admins, 검토 대기
  with a **검토 시작** button per row: `openSeededChat` → a new chat with the admin's OWN avatar, the composer
  pre-filled (not sent) with a review request naming ONLY the proposal id — never the teammate-written
  title, which would otherwise reach the admin's avatar as the admin's own instruction. The 팀 브레인 rail
  badge = `unseenResults + pendingReview`, polled with the knowledge watch (`lib/teamBrain.ts`); a toast on
  growth and the admin panel's 위키 페이지 card open it with `goView("teamBrain")` (the one-shot
  `brainOpenTeamTab` flag is gone).
- 관리자 → 팀 브레인 (`AdminTeamBrainPanel.tsx`): counts + backup address/branch/status, 지금 백업, 백업에서 복원,
  and the read-only 팀 정책 view (settings vs defaults, problems, guidelines as text, change history — changes
  go through the admin's own avatar + a card). A `policy` card shows the POLICY.md line diff and 팀 정책 반영;
  propose/direct cards list their linked 내 브레인 notes.
