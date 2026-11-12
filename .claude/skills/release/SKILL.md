---
name: release
description: Cut a Noah Almighty release — run the verification gate, sync the what's-new registry, bump semver, tag, and publish the GitHub release. Use when the user says "릴리즈", "릴리스", "release", "버전 올려서 배포/태그", or asks to publish a version.
---

# Noah Almighty release workflow

Cut a semver release: gates green → what's-new registry synced → version bumped →
`main` pushed → GitHub release published. **Releasing ≠ deploying** — deployment is
a separate internal corporate server; end by reminding the user to deploy the tag.

## 1. Preconditions

- On `main`, synced with origin (`git fetch origin && git status -sb`).
- If unrelated files are dirty, stage release files EXPLICITLY — never `git add -A`
  (`.claude/worktrees/` embedded checkouts + stray edits; see ARCHITECTURE-NOTES §Cross-cutting gotchas).

## 2. Decide the version

- User-named version wins. Otherwise derive from commits since the last tag
  (`git log $(git describe --tags --abbrev=0)..HEAD --oneline`):
  breaking change → major, any `feat` → minor, else patch. Ask if ambiguous.

## 3. Draft the patch notes and get the user's sign-off (MANDATORY GATE)

- Draft BOTH user-facing artifacts:
  - **What's-new entry** for `src/server/releaseNotes.ts` (only if the range has
    USER-VISIBLE changes): date-based unique `id` (`YYYY-MM-DD`, same-day second
    release `YYYY-MM-DD.2`), Korean 해요체 `items` (`{title, body, example?}` —
    `example` renders as a highlighted "try this" hint; write one for features
    users must act on to discover). An item whose feature has a control on
    screen (a button, a menu entry) also gets a `hint` — `{ id: "<release
    id>.<slug>", anchor, body, details? }`, one or two short sentences (plus
    optional small-print `details` lines for specifics such as file types and
    limits, which must match the code); it is shown as a
    bubble AT that control until the user dismisses it. `anchor` must be an
    existing `FeatureHintAnchor`, or add one (mark the control with
    `featureHintAnchor`, give it a side in `FEATURE_HINT_SIDES`). Never reuse
    or rename a hint id. Ordering = array position, newest first;
    never reuse or re-sort ids. Skip for internal-only releases (refactor/docs/
    perf) — keep the dialog meaningful.
  - **GitHub release notes** (Korean, template below) — always drafted.
- Present both drafts VERBATIM in chat and WAIT for the user's explicit approval.
  Apply requested edits and re-present until approved. Until then: no registry
  edit is committed and `gh release create` must not run. Silence ≠ approval.
- After approval, prepend the approved entry to `releaseNotes.ts` exactly as
  signed off; any later wording change re-requires approval.
- App semver and the registry's date ids are INDEPENDENT — don't unify them.

## 4. Verification gate (all must pass before tagging)

```
npx tsc --noEmit
npx tsc -p tsconfig.client.json --noEmit
npm test
npm run build
```

⚠️ Do NOT use `npm run lint` — the rtk hook misrewrites it (see CLAUDE.md).

## 5. Bump + commit + push

- `npm version <x.y.z> --no-git-tag-version` (package.json + lock only).
  NEVER bump the `version: "0.1.0"` strings in `src/server/agent/*Tools.ts` —
  MCP protocol metadata, not the app version.
- Feature work goes in its own conventional commits first; then
  `chore(release): vX.Y.Z` with package.json, package-lock.json (+ release docs).
- `git push origin main`.

## 6. Publish the GitHub release

- Write the step-3 APPROVED notes to a scratch file — publish them as signed off;
  new or changed wording goes back through the step-3 review.
- **Browser-extension update assets (MANDATORY once the policy channel is live):**
  policy-installed extensions read `releases/latest/download/updates.xml` (→ the
  `.crx`), so EVERY release must attach both or the newest release breaks the
  fleet's update check. (The extension-side GitHub self-updater and its
  `noah-bridge-update.json`/`.sig` assets were removed in extension 0.9.0 —
  Defender flagged the fetch-and-write pattern as a dropper; do not resurrect.)
  - `BROWSER_EXTENSION_KEY_FILE=~/.noah/browser-bridge-key.pem npm run build:extension-update -- --tag vX.Y.Z`
    → two files in `dist/extension/`.
  - The deployed Noah address must be baked in: normally `BROWSER_BRIDGE_ORIGINS`
    is already set on the release machine, and the script PRINTS `baked origins:`
    when it is. If it instead prints the no-address NOTE, stop and ask the user
    for the address (then `--origin "https://…"`) — a policy-installed extension
    cannot be hand-edited, so a missing origin makes the bridge fail SILENTLY on
    every machine.
  - The script FAILS on a missing key or a manifest-key mismatch — follow its
    printed bootstrap instructions rather than bypassing them.
  - If the key file does not exist on this machine AND the channel was never
    bootstrapped (no prior release carries these assets), skip with a warning;
    otherwise STOP and ask the user — publishing without them bricks updates.
- `gh release create vX.Y.Z --target main --title "Noah Almighty vX.Y.Z" --notes-file <file> \
   dist/extension/noah-browser-bridge.crx dist/extension/updates.xml`
  (drop the asset paths only in the never-bootstrapped case above;
  gh is authed on this box; origin = github.com/JinY0ung-Shin/noah-almighty).

## 7. Verify + wrap up

- `git ls-remote origin refs/tags/vX.Y.Z 'refs/tags/vX.Y.Z^{}'` must resolve to the
  pushed HEAD; `gh release view vX.Y.Z` must show draft=false.
- Tell the user: release URL + "사내 서버에 이 태그로 배포하면 기존 사용자에게
  '새로워진 기능' 안내가 1회 표시됩니다."

## Rules / edge cases

- **Never move a published tag** that may have consumers. If a minutes-old release
  with no consumers must absorb one more commit, prefer a patch bump; only with the
  user's explicit approval recreate in place:
  `gh release delete vX.Y.Z --cleanup-tag --yes` → `gh release create` at new HEAD.
- **User-facing patch notes ship only with the user's sign-off** (step 3) — never
  commit a what's-new entry or publish GitHub notes the user hasn't approved in
  this conversation, including "small" wording tweaks.
- Language split: this skill, commit messages, code comments → English; GitHub
  release notes and every what's-new string → Korean.

### GitHub notes template (Korean)

```markdown
<한 줄 요약 — 이 릴리스가 사용자에게 주는 가치>

## 달라진 점
- **<기능>** — <사용자 관점 한 줄 설명>

## 내부 변경
- <리팩터링 / 성능 / 문서 등 (없으면 섹션 생략)>
```
