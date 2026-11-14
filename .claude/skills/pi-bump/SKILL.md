---
name: pi-bump
description: Bump the bundled pi-gateway submodule (vendor/pi-gateway) to pi's newest pushed commit and verify it with the combined-stack boot test — a private docker-in-docker stack of Noah + a real pi + a scripted fake LLM — then write the two bump notes. Use when the user says "pi 올려줘", "pi-gateway 범프", "서브모듈 올려줘", "pi 최신으로 맞춰줘", "pi 최신 커밋으로", "bump pi", "bump pi-gateway", or asks to move / update the pi submodule.
---

# pi-gateway bump

Noah ships with its pi-gateway as ONE compose stack; the pin is the submodule `vendor/pi-gateway`. A bump moves
that pin to a **pushed** pi commit, proves the combined stack still boots and behaves, and records what was and
was not seen. pi's code and compose file are never edited from here.

What the stack is and why it runs in a private dind: `docs/architecture/build-run-verify.md` ("Combined-stack
boot test") — read it once; this file only says how to run it. Reply to the user in Korean.

## Hard rules for the main tree

- You change ONLY: the submodule checkout, `docs/architecture/build-run-verify.md`,
  `docs/architecture/pi-runtime.md` — and this skill's own files when you add a check to it.
- Another session may be editing the same tree. NEVER `git stash`, `git reset`, `git checkout -- <path>`,
  `git clean`, `git add -A` / `git add .`. Look at `git status --short` first so you know what is not yours.
- Stage by name, and only: `vendor/pi-gateway`, the two docs, files under `.claude/skills/pi-bump/` that you
  changed. Check `git diff --cached --stat` before committing.
- Commit only when the user asked for the bump to be committed; push only when they asked for a push.
- Do not run Noah's `npm test` as part of a bump (and never while a docker build runs — heavy vitest files
  time out under that load).

## Steps

Run from the repository root. Every long step runs in the FOREGROUND with a 10-minute tool timeout; never end
your turn while one is running.

**1. Find the target and read what changed.**

```bash
git status --short                                   # what is already dirty — leave it
OLD=$(git rev-parse HEAD:vendor/pi-gateway)
git -C vendor/pi-gateway fetch origin
NEW=$(git -C vendor/pi-gateway rev-parse origin/main)   # pi's newest PUSHED commit
git -C vendor/pi-gateway log --format='%h %s%n%b' "$OLD..$NEW"
git -C vendor/pi-gateway diff --stat "$OLD..$NEW"
```

`OLD == NEW` → nothing to bump; say so and stop. Otherwise read every commit: which are code, which only docs;
what behaviour changes for a model or an admin; and what pi's commit says it did NOT verify (a fake sandbox, a
mock API, no real gateway) — that gap is what this run's one new check should close. Then grep Noah (`src/`,
`tests/`, `docs/`, `scripts/`, `default-skills/` — not `vendor/`) for anything that depends on the changed
behaviour or wording. Report what you find; a Noah code change is the user's decision, not part of the bump.

**2. Move the submodule.**

```bash
git -C vendor/pi-gateway checkout "$NEW"             # git status now shows " M vendor/pi-gateway"
```

**3. Prepare a run directory — outside the repo, new for every run.**

```bash
RUN=<a directory that does not exist>                # so far: ~/.noah-work/boot-test-<YYYY-MM-DD><letter>
.claude/skills/pi-bump/boot-test/prepare.sh "$RUN"
```

It copies the scripts and fixtures, exports `git archive HEAD` with `vendor/pi-gateway` at the commit the
submodule is checked out at, writes a throwaway `.env`, and prints `tested-state.txt` (both commits; whether
the pi commit is on a remote branch; tracked Noah changes that are NOT in the export). It refuses an existing
directory, a directory inside the repo, and a host that still has `noahcompose-*` resources from an earlier run.
Nothing in the skill folder is ever run directly — only the copy in `$RUN/scripts/`.

**4. Run it.** Two foreground calls (each under the 10-minute limit), or `drive.sh` alone for both:

```bash
"$RUN/scripts/drive.sh" build     # dind → setup-host → docker compose build (~3 min cold) → up      ~4 min
"$RUN/scripts/drive.sh" checks    # run-all → extras → final state                                   ~3 min
```

The build is half of a run's wall time and needs nothing from you: write the bump's check (step 5) while it
runs, not after. Each step prints one line, `<step> exit=<rc>  <n>/<m> passed`, with its `FAIL` lines under it; the last line
is `== done: every step passed` or `== done: N step(s) FAILED`, and the exit status says the same. The same
text is in `$RUN/logs/drive.log`; each step's full output is in `$RUN/evidence/`. A healthy run at pi `680f300`:

```
10-accounts 6/6 · 21-admin-proxy 11/11 · 24-llm-no-falcon-tier 3/3 · 23-admin-ui-assets 3/3
30-documents 30/30 · 31-documents-extra 21/21 · 32-second-user-own 3/3 · 50-subagent 9/9 · 55-systemone 22/22
65-shell-step-verdicts 33/33   (judges the steps that only print: 05, 20, 04, 22, 40, 60)
71-tracing-turn 25/25 · 75-trace-stats 37/37 · 25-admin-ui-real 48/48 · 85-workspace-files 26/26
86-mcp-files 20/20 · 87-mcp-file-args 19/19 · 88-plugin-refresh 23/23
90-pi-validation 22/22 · 92-grep-glob 10/10 · 93-tool-call-limit 23/23 · 94-turn-timings 13/13
80-context-usage 19/19
95-final-state 1/1             (no error-level line in any service's log; prints memory)
```

A count that differs is a finding: read that step's evidence file before anything else. A `FAIL` is either the
bump's effect on Noah (report it), a check that asserts pi's old behaviour (update the check in the skill
folder and say so), or a known trap (below). Do not "fix" a failure by deleting the check.

**5. Add the bump's ONE quick check** (next section), run it against the stack that is still up.

**6. Tear down — by name, this run only.**

```bash
"$RUN/scripts/99-teardown.sh"     # ends with: containers: none / volumes: none / networks: none
```

It removes the `noahcompose-*` containers, volume and network and the run's `secrets/` and `home/`; scripts,
logs and evidence stay in `$RUN`. Never prune, never glob-delete; leave `noahpi-*` and the host's own
`noah-almighty-*` stack alone.

**7. Re-fetch before you write anything down.** `git -C vendor/pi-gateway fetch origin` again: the user often
pushes one more small commit while a bump is in progress. If `origin/main` moved, go back to step 1 with the
new commit and a new run directory — the notes and the commit name ONE tested commit.

**8. Write the notes, then report** (sections below). Commit / push only if asked.

## Adding a check

A bump gets ONE new check, and only a quick one: what pi's commit changed, seen through Noah's stack (through
Noah's `/admin` proxy as a Noah admin, or as an owner's chat turn), ideally the thing pi's commit says it did
not look at. Minutes of work, seconds of run time.

- **A check that needs a long wall-clock wait is NOT added.** Write "not seen: …, rests on pi's tests" in the
  note instead, or ask the user first — they objected to an hour's wait for a check nobody asked for
  (`89-plugin-timer.mjs` is that check; it stays out of the default run).
- Write and iterate in `$RUN/scripts/` while the stack is up (`node NN-name.mjs`). When it passes, copy the
  file into `.claude/skills/pi-bump/boot-test/scripts/` and add its `extra` line to `drive.sh` THERE too — a
  check that lives only in a run directory is lost. It is a regression guard from then on.
- Name: `NN-<what>.mjs`; the number only groups files (drive.sh's order is explicit). Bump guards are `90`–`94`,
  `96`–`98`, then `100`+ (`94` is taken; the next free one is `96`). Evidence file: one capital letter + name (`L-tool-call-limit.log`).
- Helpers, all in `scripts/e2e-common.mjs`: `loadState()` (the `owner` — a Noah admin — and `second`, a member:
  `{id, username, cookie}`), `client(cookie)` (`.get/.post/.put`), `turn(client, {avatarId, conversationId,
  message})` → `{status, frames, of(event)}`, `fake.enqueue(key, turns)` / `fake.requests(key)` /
  `fake.reset(key)`, `textOf`, `check(name, ok, detail)`, `finish()`, `dind(...argv)` / `dindTry`, `W` (the run
  directory), `repoRequire("playwright")` for a real browser.
- The fake LLM (`scripts/fake-llm.mjs`, header documents it) answers what you enqueue: a turn is
  `{text?, toolCalls?: [{name, arguments}], usage?, error?, …}`; `rawArguments` sends argument text that is not
  whole JSON. It routes a request by the FIRST `[[fake:KEY]]` marker in the conversation, so ONE key per
  conversation — a new key per turn silently gets the echo default. Read what a tool answered from the next
  request's `role: "tool"` messages.
- A mutating call through `/admin` needs the panel's headers (`PANEL` in `21-admin-proxy.mjs`).
- Patterns to copy: `93-tool-call-limit.mjs` (admin API + turns + a real browser page + the audit log),
  `90-pi-validation.mjs` (`mcp_call` to Noah's own tools), `92-grep-glob.mjs` (a pi built-in in the sandbox).
- Judge what must hold with `check`; print what you only want on record (`(recorded, not judged) …`).

Out of the default run, each with a header saying when to run it by hand: `89-plugin-timer.mjs` (an hour),
`91-validator-matrix.mjs` (needs an older gateway image), `70-tracing-static.sh` / `72-tracing-ops.sh` (the
tracing service; `72-` restarts containers — run it last).

## The two doc notes

- **`docs/architecture/build-run-verify.md`** — always. One new paragraph after the previous bump's, before
  "**A model-driven check in that stack**":
  `**pi <sha7> (<date>, <what changed> — <what pi's own commit did and did not look at>):**` then: the run
  directory and the Noah commit; the counts step by step; the new check with its count and what was SEEN
  through the stack, in the words of the evidence (status codes, the exact text a model or a user reads);
  anything seen and left as it is; `**NOT seen:**` — every claim that rests on pi's tests or was skipped;
  `After the run: gateway N MiB, broker N MiB` (from `95-final-state`). Be exact about observed versus assumed.
- **`docs/architecture/pi-runtime.md`** — only when the bump changes what Noah's runtime does or relies on: a
  bullet in the section it belongs to, stated as what is true NOW. If the bump makes an older sentence false,
  rewrite that sentence instead of adding a contradicting one.
- Same style as the neighbours: plain statements, wrapped near 115 columns, one hunk per file. Past bump
  paragraphs are history — do not edit them.

## Commit message (when asked)

```
chore(pi): bump pi-gateway to <sha7> (<what changes for Noah, in one clause>)

<What changes for Noah: for a user, an admin, a model. "Nothing in Noah's code changes." when true.>

<Boot test on a fresh dind stack (<run dir>, Noah <sha7>): the counts, then the new check and what it saw.>

<Seen and left as is: … — only if there is such a thing.>

<Not seen: …>
```

End with the attribution line this session was given. `git add vendor/pi-gateway
docs/architecture/build-run-verify.md docs/architecture/pi-runtime.md` (+ the skill files you changed) —
nothing else.

## Report to the user (Korean)

What the pi commits change for Noah; PASS/FAIL with the counts and the evidence directory; findings that need
their decision, each with `file:line`; what was not run and not seen; which files changed and whether anything
was committed or pushed.

## Traps

- **One run per host daemon.** The names `noahcompose-*` and the addresses (`10.217.0.0/24`) are fixed.
- **`drive.sh checks` runs once per stack.** A second run on the same stack fails four steps by design —
  `30-documents` ("the owner's sandbox is the only one"), `75-trace-stats`, `88-plugin-refresh` and
  `93-tool-call-limit` each count on the state of a fresh stack. For a re-run, tear down and prepare a new run
  directory. `71-`, `25-`, `85-`…`87-`, `90-`, `92-`, `94-` and `80-` can be re-run alone with `node`.
- **Jaeger's `@jaeger@warnings`** (clock-skew notes on a span) are Jaeger's, not pi's: `71-` lists and skips
  `@jaeger@*` keys. A new check that lists span attributes must skip them too.
- **A backgrounded build can leave you idle forever.** Foreground, or — if you must background it — wait on
  the `== done` line of `logs/drive.log` with a foreground loop.
- **`pkill -f <pattern>` kills its own shell here.** Stop things by container name or PID.
- **prepare.sh exports HEAD.** An uncommitted Noah change is not in the stack; `tested-state.txt` lists such
  files. Say which commit was tested.
- **Host prerequisites:** docker, Node 22, `npm ci` done in the repo with Playwright's Chromium installed
  (three checks open a real browser), the images `docker:29-dind` and `node:22-bookworm-slim`, and — for the
  plugin-marketplace fixture of `88-` — an image with node, git and git-http-backend on the HOST daemon
  (`pi-gateway/gateway:latest` where the bundled stack runs; otherwise `GIT_FIXTURE_IMAGE=<image>`).
- **`90-pi-validation.mjs` quotes pi's validation wording on purpose.** A pi library bump that rewords it
  fails there; update the expectation and tell the user what a model now reads.
- **`evidence/state.json`** holds the session cookies of the run's throwaway accounts; `run.env` their
  password. They die with the stack; do not copy them anywhere.
