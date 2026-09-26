# Refactoring backlog (Tier 3 + deferred)

This is the deferred remainder of the 2026-06 codebase-cleanup pass. **Tier 1** (24 behavior-preserving dedup/cleanup wins) and **Tier 2** (structural god-file splits) have **landed** on the work branch and are verified green (lint clean, build clean, 300 tests pass). What follows is the work that was **intentionally NOT done** because it is larger, riskier, alters behavior, or needs a dedicated review — captured so it isn't lost.

Each item lists: files · why · risk · effort · breaking.

---

## Deferred from Tier 2

### T2.6 — Split `public/app.js` into ES modules — ✅ DONE (2026-06)
- **Done:** `public/app.js` is now a thin entry; feature code lives in `public/js/*.js` with `core.js` as the leaf primitives module (and `public/styles.css` split into `public/styles/*.css`). `pretest` now `node --check`s every module; import graph validated statically. Module map + the core-stays-a-leaf rule were documented in `public/CLAUDE.md` (since removed — the vanilla `public/` frontend was superseded by the Svelte migration). **Still needs a human browser smoke-test before relying on it** (no runtime verification in this env).

---

## Tier 3 — larger / riskier (behavior-preserving but needs care)

### T3.1 — Split the `Store` god-class — ✅ DONE (2026-06)
- **Done:** `src/server/store.ts` is now a barrel re-exporting an UNCHANGED public surface. The single `Store` facade is preserved via mixin composition (`store/index.ts` `Store extends ComposedStore`); shared base + schema/migrations live in `store/internal.ts` (`StoreBase`); per-domain method groups + `*Row` interfaces moved into `store/{users,avatars,conversations,groups,routines,knowledgeRepo,secrets,admin}.ts`. All ~110 call sites + `createServices` keep `new Store(config)` + `store.foo()`. Verified by full lint/test/build.

### T3.2 — Centralize the avatar-visibility SQL predicate
- **Done** (with the `public`-removal + avatar-sharing work): the co-membership join now lives in ONE
  module-scope fragment, `SHARING_TEAMMATES` in `src/server/store/avatars.ts` (incl. the
  `groups.avatar_sharing` gate), shared by `VISIBILITY_WHERE` (list + search), `groupTeammateIds`,
  `shareAnyGroup`, and `sharedGroupNames`. Parity is pinned by the store scope-parity + avatar-sharing
  matrix tests.

### T3.3 — Dedupe the knowledge-repo MCP tool family (3-way, incl. `create_repo`)
- **Files:** `src/server/agent/repoTools.ts`, `groupRepoTools.ts`
- **Why:** Larger version of the Tier-2 `repoToolKit` extraction, now including the `create_repo` body (host/token/name-regex, best-effort seed). Preserve the create→connect→best-effort-seed ordering.
- **risk:** med · **effort:** M · **breaking:** no

### T3.4 — Type the SDK message / hook surface
- **Files:** `src/server/agent/sdkMessageHandlers.ts`, `events.ts`, `preToolUseHook.ts`
- **Why:** ~15 sites thread SDK messages through `Record<string,unknown>` + `asString`/`isRecord`. Hand-authored discriminated unions matching the pinned SDK version would catch field-name typos at compile time. Also fix the stale `PermissionRequest` doc comment (`canUseTool` is unused headlessly).
- **Why deferred:** Large, and coupled to the pinned SDK version.
- **risk:** med · **effort:** L · **breaking:** no

### T3.5 — Make `allowedTools` + `mcpServers` data-driven
- **Files:** `src/server/agent/claudeAgent.ts`
- **Why:** Two hand-synced lists keyed on the same servers — adding a server to one but not the other is a silent bug. Reduce a descriptor array `{name, server, toolNames, active}` into both. Verify against the `agent-core`/`agent-tools` test expectations.
- **risk:** med · **effort:** M · **breaking:** no

### T3.6 — Converge the two git-token context conventions
- **Files:** `src/server/gitRepos.ts`, `knowledgeRepo.ts`, `groupKnowledgeRepo.ts`
- **Why:** `gitRepos` pre-resolves a single token at context-build; the knowledge contexts carry raw `{token, externalToken}` + per-call `tokenForGitUrl`. Adopting `gitRepos`' model removes the "optional for back-compat" debt but **alters when host-routing runs** — needs a token-routing test pass.
- **risk:** med · **effort:** M · **breaking:** no

---

## Explicitly breaking / needs a deliberate decision — DO NOT batch

### T3.7 — Unify the `dirtyPaths` porcelain flag ⚠️ BEHAVIOR CHANGE
- **Files:** `knowledgeRepo.ts`/`groupKnowledgeRepo.ts` (`--porcelain`) vs `gitRepos.ts` (`--porcelain -uall`), parameterized today via `repoGitCore`'s `extraStatusArgs`.
- **The issue:** the knowledge-repo "any changes?" short-circuit currently **misses files inside otherwise-untracked directories**. This looks like a **latent bug, not intent** — but switching to `-uall` everywhere **changes when commits fire**. Confirm it's a bug, add explicit test coverage, then change deliberately.
- **risk:** high (behavior) · **effort:** S

### T3.8 — Close the `ext::sh` arg-injection asymmetry 🔒 SECURITY — ✅ DONE (2026-07)
- **Done:** `assertSafeGitValue` (leading dash + `scheme::` remote-helper) now lives in `repoGitGuards.ts` as the SINGLE arg-safety validator, re-exported through `repoGitCore.ts` and used by **all four** clone paths: `gitRepos.ts` (unchanged behavior), `knowledgeRepo.ts` + `groupKnowledgeRepo.ts` (previously leading-dash only), and `marketplace.ts` `assertSafeArg` (the plugin clone path, also previously leading-dash only). Unit matrix in `infra.test.ts`, clone-path tests in `routes-repo.test.ts`.
- **Measured while fixing:** `ext::` was never actually reachable — git refuses it by default (`fatal: transport 'ext' not allowed`, verified on git 2.43.0). The defense was git's default protocol policy, NOT app code, so `protocol.ext.allow`/`GIT_ALLOW_PROTOCOL` or a differently-built git would have re-opened it. The validator no longer depends on that default.
- **Deliberately NOT changed:** the validator stays transport-agnostic. Local paths must keep cloning — `register_repo` accepts them by design and every offline repo test clones from a local bare remote. Source/host POLICY is a separate layer (see the `isInternalGitSource` note below).

### T3.11 — `isInternalGitSource` failed open on unparseable hosts 🔒 SECURITY — ✅ DONE (2026-07)
- **Files:** `gitCredentials.ts`, entry points `routes/knowledgeRepo.ts` + `routes/groups.ts`
- **The issue:** `isInternalGitSource` returned `true` when `gitHostFromSource` yielded `null`. That branch was already dead for `owner/repo` shorthand (handled above it), so its only effect was to admit values with NO parseable host — bare filesystem paths and `scheme::` syntax — past the single check that enforces "the knowledge repo must live on the internal GitHub host". `looksLikeRepo` accepts anything ending in `.git`, and `marketplaceCloneUrl` passes non-shorthand values through unchanged, so `/data/knowledge/<otherUserId>/.git` cleared every gate.
- **Impact (verified by reproducing the clone):** any authenticated user could connect their knowledge repo to another user's clone under `dataDir/knowledge/<id>`, or a group repo under `dataDir/group-knowledge/<id>` they were not a member of, then read it back via `/api/me/knowledge-repo/{contents,note,graph}` and the agent's `mcp__repo__read_file` / `mcp__brain__search`. No tool access required — plain HTTP. Group admins had the same path for group repos, exposing the target to every member.
- **Done:** the `host === null` fail-open is gone — a non-shorthand source must have a PARSEABLE host equal to the internal host. Regression tests at both route entry points plus an `isInternalGitSource` unit matrix.
- **risk:** high (security) · **effort:** S

### T3.9 — zod-ify HTTP bodies + `asyncHandler`
- **Files:** `src/server/routes/*`, `index.ts`
- (a) Shared validators (`parseSelected`, `parseKnowledgeRepoBody`) — low risk, can do anytime.
- (b) Full zod schemas + Express-5/`asyncHandler` so the central error middleware becomes reachable — **changes error responses**, so it's a behavior change, out of scope for a pure restructure. Defer (b).
- **risk:** med · **effort:** M · **breaking:** (b) yes

### T3.10 — audit remaining untracked template function calls (Svelte 5 legacy)
- **Files:** `src/client/src/components/Shell.svelte` (`isConversationBusy`/`isConversationStreaming`),
  `src/client/src/views/ChatView.svelte` (`canPickModel`)
- Same class as the fixed CONFLUENCE_PAT save-button bug ([`architecture/client.md`](architecture/client.md) §Svelte 5 runtime gotchas):
  the template calls a helper whose BODY reads reactive state → compiled with `$.untrack` → the attribute
  goes stale until an unrelated invalidation. These are currently masked by coincident list/store
  refreshes (unverified). Verify each with a Playwright fixture, then convert to `$:` derived maps the
  template reads DIRECTLY. Helpers reading only their arguments are fine — leave them.
- **risk:** low · **effort:** S · **breaking:** no

---

## Coverage gaps (not refactors — flagged)
- **`rateLimit.ts` ~26% covered; ZERO tests assert a 429.** Security-adjacent, can silently regress. Add an integration test (hammer an endpoint past the window → expect 429). low/M.
- **`scheduler.ts` tick / due-job selection loop is untested.** Add a due-selection unit test. low/M.
  Partially addressed (2026-07): `tests/scheduler.test.ts` now covers the FAILURE path (timeout-cause
  substitution, partial-output persistence, non-timeout errors) by mocking `runAgentStream` so a run can
  hang until the deadline aborts it. The **tick / due-job selection loop itself is still untested.**
- `claudeAgent.ts` ~36% is expected (the SDK subprocess path); the pure helpers are covered — lower priority.

---

## UI consistency pass (2026-08-04) — deferred remainder

The 5-axis UI audit + fix pass landed (see DESIGN.md §5 item 9). Deliberately NOT done, in order of value:

### U1 — Rename legacy button/chip class names in markup
- **What:** `.primary`→`.btn.primary`, `.ghost-sm`→`.btn.ghost.sm`, `.linkish`→`.btn.link`,
  `.meta-badge`/`.plugin-chip`→`.tag` variants — ~180 markup sites.
- **Why deferred:** the classes are TRUE aliases now (grouped selectors), so renaming is zero visual
  gain + churn risk without a browser. Converge per-file when touching a file anyway. After the last
  usage of a legacy name is gone, delete its alias entry from the grouped selectors.
- **risk:** low · **effort:** M · **breaking:** no

### U2 — Remaining bespoke chips onto `.tag`
- **What:** `.weekday-chip`(36px square — genuinely different interaction), `.nav-badge`(fixed 18px h),
  `.q-chip`, `.agent-badge`, `.task-badge`, `.setup-badge`, `.routine-chip`, `.inbox-chip`,
  `.canvas-answered-badge`, `.group-add-chip`, `.slash-option-tag`, GraphCanvas legend/node chips.
- **Why deferred:** several are structurally different (fixed geometry, interactive), not just styled
  differently — each needs a per-case call, some may stay documented exceptions.
- **risk:** low · **effort:** M · **breaking:** no

### U3 — `.workspace` rail collapse animates `grid-template-columns` (layout property)
- **Where:** `80-apple-design.css` (§2.5-deviation comment on site). Convert to transform/opacity
  choreography. Needs a browser to tune; Playwright fixture recommended.
- **risk:** med (visual) · **effort:** M · **breaking:** no

### U4 — Empty-state base family
- 6 empty-state classes (`.empty-note`, `.empty-state`, `.conv-empty`, `.routine-empty`,
  `.routine-run-empty`, `.brain-empty`) share no base; two carry icon+heading+action treatment.
  Define `.empty` base + modifier like §4.2. Low value until a new empty state is added.
- **risk:** low · **effort:** S · **breaking:** no

### U5 — CanvasPanel remaining glyph buttons
- `›` `‹` (collapse/expand), `⤢` (fullscreen), `−`/`+` (zoom) are text glyphs; Icon set lacks
  maximize/zoom icons. Add icons to `lib/icons.ts`, swap, and verify the 28px boxes optically.
- **risk:** low · **effort:** S · **breaking:** no

### U6 — Odds and ends
- `--ease` token now has ZERO CSS consumers (gesture handoff is JS springs) — delete it and its
  DESIGN.md §2.5 reservation, or keep as documented reserve. Decide once U3 lands.
- `.small` doubles as text-span modifier and button size — consider splitting (`.btn.sm` only).
- `knowledgeRepo.ts` scaffolded document templates use 하세요체 — out of UI scope; align if the
  template ever becomes user-visible copy.
- Playwright smoke for the a11y-critical paths (PromptModal trap/Escape=deny, theme-toggle restyle,
  focus-ring visibility in `prefers-contrast: more`) — the 2026-08 pass was verified by gate + review
  agents only; DESIGN.md §5 still calls for a human browser sweep (light/dark × 채팅/탐색/설정/관리자).

## Background phase (2026-08) — deferred hardening

The SDK-native background-task continuation (visible turn finalized at the first `result` while the
session keeps running; wake-ups delivered as new messages — see [`architecture/chat-sse-media.md`](architecture/chat-sse-media.md)) shipped
with two deliberate v1 limits worth revisiting:

### BG1 — New user message during a background phase still 409s
- **Files:** `src/server/routes/chat.ts` (active-run 409), `runRegistry.ts`
- **Why:** Concurrent turns would resume the SAME SDK session transcript from a second process while
  the first is still appending wake-up turns — unresolved write/fork semantics. v1 keeps the lock and
  tells the user (background-specific 409 + prompt guidance to the avatar). Options: queue the message
  for after `bg_end`, or cancel-with-confirm from the composer.
- **risk:** med · **effort:** M · **breaking:** no

### BG2 — Server restart kills pending background work silently
- **Files:** `runRegistry.ts` (in-memory), `routes/chat.ts`
- **Why:** The phase lives in the run registry + SDK subprocess; a restart drops both. The transcript
  keeps the "started in background" tool_result, so the NEXT turn's model may believe work is pending.
  Options: persist a `background_pending` marker per conversation and, on restart, append a Korean
  notice message ("서버 재시작으로 백그라운드 작업이 중단되었습니다") + a prompt fact so the avatar
  knows the work died.
- **risk:** low · **effort:** M · **breaking:** no

## Browser screenshot vision fit (2026-09) — deferred follow-up

The issue-#66 fix pre-fits every VIEWPORT screenshot to Claude's STANDARD resolution tier and measures
the returned bitmap instead of trusting the capture formula (see
[`architecture/browser-bridge/snapshots.md`](architecture/browser-bridge/snapshots.md)). One deliberate
limit shipped with it:

### BV1 — Tier-aware screenshot fit
- **Files:** `extension/axtree.js` (`viewportShotScale`, the `VISION_STANDARD_*` constants),
  `extension/background.js` (`captureShot`), `src/server/agent/visionImage.ts`, plus one optional op
  field across the five wire layers (`agent/browserTools.ts` → `agent/events.ts` → `routes/chat.ts` →
  client `lib/browserBridge.ts` → `background.js`).
- **Why:** the fit target is the standard tier (1568 px per edge / 1568 visual tokens) for EVERY model,
  while a Claude 4.7+ model reads the high-resolution tier (2576 px / 4784 tokens). A tall/portrait
  viewport is therefore downscaled further than such a model needs and loses legibility it could have
  had. Passing the run's resolution tier down as an OPTIONAL screenshot-op field (absent = standard, so
  every old build and every unwired caller keeps today's behavior) would restore full fidelity there.
- **Why deferred:** the serving model's tier is not knowable from where the decision is made. The
  composer offers model TIER aliases that each deployment maps to concrete models
  (`ANTHROPIC_DEFAULT_<TIER>_MODEL`, see `modelVisionPolicy.ts` / `visionForModel`), so "which
  resolution tier will actually serve this run" needs new admin config or a probe — and guessing the
  OTHER way (fitting to high-res for a standard-tier model) puts #66's ×1.6 coordinate skew straight
  back. Standard-tier fitting is exact for every Claude model, so the cost of waiting is fidelity only.
- **risk:** med · **effort:** M · **breaking:** no

## PPTX converter (2026-09) — deferred follow-ups

The pptx skill's HTML→editable-PPTX converter shipped with the server hand-off (hash-bound previews) and
no client change (see [`architecture/pptx-converter.md`](architecture/pptx-converter.md)). Recorded, not
built:

### PC1 — Client polish for converter previews (none needed for correctness)
- **Files:** `src/client/src/components/FilePreviewPanel.svelte`, `panelSlides` (`views/ChatView.svelte`,
  `lib/bubbleSegments.ts`).
- **What (four optional fixes):** (a) append slides that arrive late to an already-open panel; (b) prefer
  the stamped slides (`parentId` = the card) in `panelSlides`; (c) the status line's handling of hidden
  attachments; (d) empty-state copy when the renders failed.
- **Why deferred:** the existing hidden-image + `parentId` shape already renders any aspect ratio and size,
  and the LibreOffice race behind (a) is pre-existing and nearly absent for converter decks.
- **risk:** low · **effort:** S–M · **breaking:** no

### PC2 — Open production questions (the converter runs with these defaults)
- **Concurrency sizing:** `NOAH_PPTX_MAX_CONCURRENT=2` — each conversion is a ~0.4–0.5 GiB Chromium inside the
  app container (1.1 GiB for three at once on the dev box, which is NOT a production sizing); ask the deploy
  host's RAM/CPU and adjust.
- **Mirrors:** does the corporate apt mirror proxy `/debian-security` (Chromium 154)? Without it bookworm main's
  150 installs, verified IR-identical. Does the PyPI mirror carry the pinned cp311 wheels?
- **Disk:** +0.55 GB uncompressed per image, plus the `:pre-deck` rollback tag until it is pruned, plus the
  build cache.
- **Defaults to confirm with the user:** docProps author `Noah Almighty` (the skill passes `--author` when it
  knows the user's name); the tour's `약 2분` duration after the first real runs; Korean in-deck metadata
  (layout names, placeholder prompts, alt text) for non-Korean users; the 60-slide cap per build (a higher cap
  needs the 540 s budget and the 600 s Bash ceiling revisited); the what's-new entry (drafted, added only by
  the release step after the wording is approved).

### PC3 — Run the deck Docker smoke in the release checklist
- **Files:** `.claude/skills/release/SKILL.md` (+ `architecture/build-run-verify.md`'s release bullet, kept in
  sync with it).
- **What:** when a release contains converter or Dockerfile changes, run
  `scripts/deck-docker-smoke.sh --image <fresh build> --baseline-image <fresh build of the previous release>
  --require-validator` before tagging. Nothing but this smoke exercises the image's Chromium, the pinned Python
  set and the container hardening together.
- **risk:** low · **effort:** S · **breaking:** no

### PC4 — Move the converter locks to `flock` if the agent Bash ever gets its own network namespace
- **Files:** `default-skills/skills/pptx/converter/tools/lib/locks.mjs`.
- **Why:** the host-wide slots and per-deck locks are abstract UNIX socket names, which are per network
  namespace. Today every conversion in the container shares one namespace (the agent Bash is not sandboxed),
  so they are truly host-wide. A Bash sandbox with its own namespace would silently give each sandbox its own
  slots — then switch to `flock` on a file every sandbox sees (and keep the kernel-release-on-death property).
- **risk:** med · **effort:** S · **breaking:** no

### PC5 — Out of scope for the first version (recorded)
- Converter support for user templates/masters (the python-pptx path covers them); localized in-deck
  metadata; MicroType Express font compression; a Hanja-only NotoSansKR subset (an OFL Modified Version);
  LibreOffice ≥ 25.8 (embedded-font support in previews); decks over 60 slides in one build; background
  (`run_in_background`) conversions.

## Recommended order when picking this up
1. Cheap + independent: the two coverage-gap tests, T3.9(a).
2. After Tier-1/2 settle: T3.2 → T3.5 (test-guarded, medium).
3. T3.1 (Store split) — dedicated review + full test run, solo.
4. Deliberate/risky, each on its own: **T3.8 (security review)**, **T3.7 (confirm bug + test)**, then T2.6 (browser-verified), T3.4/T3.6.
