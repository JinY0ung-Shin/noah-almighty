# PPTX converter (HTML slides → editable `.pptx`)

> Detail page of [Architecture & Operational Notes](../ARCHITECTURE-NOTES.md).
> The bundled `pptx` skill's converter, the hash-bound preview sidecar `share_file` attaches, the deck
> toolchain probe behind both metacognition surfaces, and the Docker packaging. Operator-facing setup
> (mirrors, build args, golden drift, rollback) is in [`../../README.md`](../../README.md#deck-converter-golden-drift);
> the agent's authoring rules are `default-skills/skills/pptx/reference/AUTHORING.md`; the IR and gate
> contract is `default-skills/skills/pptx/converter/docs/CONTRACT.md`.

## What it is
- **One foreground Bash command turns slide HTML into native PowerPoint.** The avatar writes each slide as
  constrained HTML/CSS with the skill's component kit, runs `deck.sh check` until the lint is clean, then
  `bash ${CLAUDE_SKILL_DIR}/scripts/deck.sh build <deck>`. The `.pptx` carries native, editable text boxes,
  shapes, tables and charts (each chart with its embedded workbook, so 데이터 편집 works). Font profiles:
  `embedded` (default — the four Pretendard faces embedded in the file) and `malgun` (declares 맑은 고딕,
  embeds nothing; ~50 KB instead of ~4.8 MB for the reference deck).
- **Pipeline per profile:** extract (headless Chromium renders every slide, measures it into an IR + reference
  PNGs) → `build_pptx.py` (python-pptx) → the gates, in parallel → fidelity (the IR against the written
  objects) → `previews.py` → deliverable + preview sidecar. It is the proof of concept ported behind two
  roots; the PoC's evidence is preserved under [`../pptx-converter/`](../pptx-converter/README.md).
- **Shell-side on purpose, never an MCP tool.** The `mcp__` auto-allow in the PreToolUse hook fires BEFORE any
  owner check, so an MCP converter would need its own gate; an in-process tool would run a `--no-sandbox`
  Chromium on agent-authored HTML inside the server process, which holds `SESSION_SECRET` and the git tokens
  (they are stripped only from the SUBPROCESS env, `agentSubprocessEnv` in `agent/runPlan.ts`). A Bash call
  runs as the same uid and gains nothing new, and it stays behind the ONE PreToolUse gate: plain colleagues
  and restricted headless runs are read-only. Elevated viewers run it **without a prompt** — every chat turn
  and routine passes `autoApprove: true` — so **the converter's own guards are the boundary**: lints, CSP,
  network block, budgets and locks. The same path works unchanged in routines, bot tasks and the external task API.
- **Existing decks stay python-pptx.** Editing a `.pptx` in place or using a user's own template/master goes
  through `reference/python-pptx.md` (+ `scripts/render_deck.sh` for LibreOffice renders). A converted deck is
  changed by editing its HTML and rebuilding — a python-pptx edit breaks the hash binding (below), which the
  server answers with LibreOffice previews plus a redirecting note.

## Two roots
- **KIT** = `default-skills/skills/pptx/converter/` — the toolkit, READ-ONLY at runtime (root-owned in the
  image, where the Dockerfile precompiles its Python; in the dev tree a test asserts the tree hash is unchanged
  and no `__pycache__` appears). It keeps the
  PoC's internal layout, so every KIT-relative path (`fonts.json`, the generated font CSS, the cmap) resolves
  through `__file__` / `import.meta.url`:
  ```
  converter/  VERSION  requirements.txt  README.md  docs/CONTRACT.md
    tools/deck.mjs + tools/lib/*.mjs (locks.mjs, …)      the orchestrator
    tools/extract.mjs + tools/extract/{browser,server,chromium,cmap}.mjs + inpage/*.js
    tools/build_pptx.py + tools/pptxlib/  embed_fonts.py  eot.py  office_check.py
    tools/check_fidelity.py (structure only)  inspect_pptx.py  previews.py  pdeathsig.py
    tools/gates/{shape_table_lint,chart_verify,chart_lint,indep_check}.py + gates/xsd/ (+ NOTICE.md)
    theme/  lib/chart.js  fonts/  selftest/{deck,features,golden,tools}/
  ```
  The skill around it: `SKILL.md`, `scripts/deck.sh` (exports `PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1`,
  then `exec node …/converter/tools/deck.mjs "$@"`; always invoked as `bash …/deck.sh`, so the exec bit does not
  matter), `scripts/render_deck.sh`, `reference/{AUTHORING,EDITING,python-pptx}.md`,
  `examples/{business-review,layouts,handbook}/`.
- **Deck root** = a folder in the agent's workspace — the conversation scratch workspace (cwd), or, when a
  repository is open, the scratch workspace listed as an additional working directory unless the user wants the
  deck committed. Both are `share_file` roots.
  ```
  <deck>/                  ASCII name ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ (the Korean title goes in share_file `name`)
    slides/NN-name.html    NN = 01…60, order = numeric prefix; a bad or duplicate NN is an error
    deck.css               optional, linked as ../deck.css (palette/brand overrides)
    assets/                optional, ../assets/<file> (≤ 20 MB each)
    .build/                converter scratch, safe to delete; carries .gitignore = "*"
      check/<profile>/…, check/report.json, <profile>/{ir.json, html/, assets/, overview-N.png, report.json, …}
      logs/<yyyymmdd-hhmmss>-<command>/   (last 5 runs kept)     run.json (holder of the deck lock; informational)
    <stem>.pptx            deliverable; stem = folder name (+ "-malgun") or --out
    <stem>.preview/        slide-NN.{png,jpg}, .gitignore = "*", manifest.json (written LAST)
  ```
- **IR paths are relative to the directory of `ir.json`** (`source`, `referencePng`, `referencePng2x`, image
  `src`/`svg`); `fonts.json` `file`/`measureFile` stay KIT-relative. The builder, fidelity and inspect resolve
  against `dirname(--ir)`. `referencePng2x` names a file deleted after the previews are written. The internal CSS
  family `PoC Malgun Substitute` keeps its PoC name: it never reaches a PPTX (the builder writes 맑은 고딕 and the
  `font-coverage` gate forbids naming the substitute), and renaming it would churn the CSS, the IR and the goldens.
- **Hygiene.** The `.gitignore` files make a deck built inside an open repository stage only `slides/`,
  `deck.css`, `assets/` and optionally the `.pptx`; `build` regenerates the previews. A deck folder inside the
  skill directory is refused (exit 2, "copy the example first").

## CLI
The block between the markers is generated from `node default-skills/skills/pptx/converter/tools/deck.mjs --help`
and must never be hand-edited: `tests/deck-contract.test.ts` fails when it drifts from the real output.

<!-- deck-help:begin -->
```text
deck.sh — HTML/CSS slides -> editable PowerPoint (.pptx): the pptx skill's converter

usage:
  deck.sh check    <deck> [--profile embedded|malgun|both] [--only NN-name ...] [--json]
  deck.sh build    <deck> [--profile embedded|malgun] [--out <name>.pptx] [--author <name>] [--strict] [--json]
  deck.sh probe    [--json]
  deck.sh selftest [--profile embedded|malgun|both] [--keep <dir>] [--fail-on-drift] [--record <file>] [--update-golden] [--json]
  deck.sh --help

commands:
  check     render and lint the slides (profile embedded unless --profile; "both" also compares the line wraps
            of the two profiles); writes <deck>/.build/check/<profile>/{html/*.png, overview-N.png, ir.json} and
            <deck>/.build/check/report.json, also when it exits 1; never touches a deliverable
  build     check + convert + validate; on success writes <deck>/<stem>.pptx and <deck>/<stem>.preview/ (the
            exact slide renders share_file attaches); stem = the folder name (+ "-malgun" for the malgun profile)
            or --out; a failed build deletes its candidate and leaves the previous deliverable untouched
  probe     report the toolchain as facts (never starts a browser); exit 0 when the converter is installed
  selftest  build the frozen self-test decks and compare their IR with the golden files

arguments:
  <deck>            an existing folder whose name is ASCII (letters, digits, '.', '_', '-'; at most 64): slides in
                    slides/NN-name.html (NN = 01, 02, ...), optional deck.css and assets/; never a folder inside
                    the skill directory (copy an example into the working directory first)
  --profile         embedded (default: Pretendard embedded in the file) | malgun (맑은 고딕 declared, not embedded)
  --only NN-name    check only these slides (each keeps its slide number)
  --out <name>.pptx a bare file name, written in <deck>
  --author <name>   the document author (default "Noah Almighty")
  --strict          drift blocks too (builder warnings, gate warnings, fidelity drift)
  --json            one JSON report on stdout
  --keep <dir>      selftest: copy the built self-test decks there
  --fail-on-drift   selftest: exit 3 when the IR drifted from the golden files
  --record <file>   selftest: write the self-test record the probe reports
  --update-golden   selftest: rewrite the golden files (dev box only, after a PowerPoint spot-check)

Run check and build in the FOREGROUND (Bash timeout: 600000): every run ends within its time budget
(NOAH_PPTX_MAX_SECONDS, default 540 s). Never run two checks/builds of one deck at the same time.

exit codes:
  0        ok (warnings possible; selftest DRIFT without --fail-on-drift)
  1        authoring: lint errors, missing or badly named slides, over the slide/size caps -> fix the HTML
  2        usage: unknown command or flag, bad deck folder, deck inside the skill directory, bad --out, a --only
           slide the deck does not have
  3        conversion: a blocking gate failed, the .pptx is over 30 MB, a slide page crashed (drift with
           --fail-on-drift) -> simplify the named construct
  4        toolchain / internal: the converter is not installed in this image, an installed one could not start,
           or a stage crashed -> follow the Next: line
  5        busy: this deck is already being checked/built, or no converter slot became free
  6        timeout: a stage or the time budget ran out -> fewer slides or images, or split the deck
  130/143  cancelled (a signal, or the parent process went away); no deliverable changed

environment (all optional):
  NOAH_PPTX_CHROMIUM            browser executable (default: /usr/lib/chromium/chromium-headless-shell)
  NOAH_PPTX_DEV=1               dev boxes only: fall back to the Playwright-cache Chromium
  NOAH_PPTX_PYTHON              Python with the converter's packages (default: python3)
  NOAH_PPTX_MAX_CONCURRENT      host-wide conversion slots (default: 2)
  NOAH_PPTX_SLOT_WAIT_SECONDS   slot wait before exit 5 (default: 150; never more than the budget minus 60 s)
  NOAH_PPTX_MAX_SECONDS         time budget per check/build (default: 540; selftest: 900)
  NOAH_PPTX_MAX_SLIDES          slides per build (default: 60)
  NOAH_PPTX_LOCK_NAMESPACE      lock namespace (default: uid-<uid>)
  NOAH_PPTX_SELFTEST_RECORD     self-test record the probe reads (default: /usr/local/share/noah-almighty/deck-selftest.json)
```
<!-- deck-help:end -->

- `check` renders and lints the build profile only (`--profile both` compares the wrap behavior of both) and
  never touches deliverables; it writes its IR, renders and report even when it exits 1, so the agent can inspect
  them. `build` includes the full check. `--out` takes only a bare `^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.pptx$`
  written in `<deck>`. `--strict` blocks on drift too (examples, tests, the smoke).
- Output: a human summary on stdout (≤ ~60 lines, paths relative to cwd, at most 30 lint lines — except the build's
  `Share it IN PLACE: mcp__file_output__share_file path="…"` line, which names the ABSOLUTE .pptx path: share_file
  resolves a relative path against the run's working directory, not the shell's current one, and the Bash tool keeps
  a `cd` between calls), or with `--json`
  exactly ONE JSON object on stdout (`noah-deck-run` / `noah-deck-probe` / `noah-deck-selftest`) with the human
  text on stderr. Every failure ends in `FAILED (<class>): <message>` + `Next: <what to do>`, and every `Next:`
  line prints ABSOLUTE paths computed from KIT — `${CLAUDE_SKILL_DIR}` is substituted only in the SKILL.md body.
- **A `Next:` command repeats the run's own flags** (`report.mjs` `rerunArgs`, shell-quoted): a check's authoring
  failure re-runs the same `--profile`/`--only`, a build's the same `--profile`/`--out`/`--author`/`--strict`, and a
  successful check names the build of the profile(s) it checked. An agent copies these lines: one that dropped
  `--profile malgun` built the embedded deck the user did not ask for. The authoring `Next:` also names the
  AUTHORING sections of the rules that failed.
- **Layout findings the check derives from the IR** (`pipeline.mjs` `layoutLintOf`, report and exit status only,
  never written into the IR): `text-overlap` errors (two text elements' line boxes intersect — glyph content areas,
  the font's full height, not the ink; the message names the spacing rule for side-by-side, stacked or
  wrapped-title pairs), `soft-wrap` warnings (a two-line text cut inside a word), and the listed soft wraps (with
  " / " at each break) and `tableCells` (< 30 % free width). The malgun profile's expected `font-weight` notes are folded into one `NOTE` line
  (`isExpectedLint`; `lint.expected` in the report) — a wall of them once buried real warnings and made an agent pipe
  the output through `grep`, hiding the exit code.
- **Font audit ≠ toolchain health.** `inpage/60-fonts.js` counts only drawn characters (a collapsed space loads no
  face); an unrequested or still-loading toolkit face is `internal` (retry, then the log), a toolkit font FILE that
  fails to load is `toolchain` — a run-time one: the run's toolchain check had found every file (`browser.mjs`
  `fontLoadFailure`). A false "converter unavailable" on a slide whose only regular-weight space was collapsed
  (malgun) is what this closed.

| exit | class | meaning — what the agent does |
|---|---|---|
| 0 | ok | success (warnings possible; selftest DRIFT without `--fail-on-drift`) |
| 1 | authoring | lint errors, no/bad slide names, over a cap, bad chart spec, charts never ready, no `main.slide` → fix the HTML (or split the deck) |
| 2 | usage | unknown command/flag, missing or non-ASCII deck folder, deck inside the skill dir, bad `--out`, a `--only` slide the deck does not have → fix the command |
| 3 | conversion, drift | a blocking gate failed, deck > 30 MB, builder skipped content, a slide page crashed; `drift` only with `--fail-on-drift` → NOT deliverable; simplify the named construct |
| 4 | toolchain, internal | the run's toolchain check found Chromium / playwright-core / Python modules / fonts missing (`toolchain.log`) → an administrator must rebuild the image — unless describe_system reported `converter: INSTALLED`: then retry once and report the log path; never install anything. The check passed but a stage could not use the toolchain (Chromium did not start, a converter font file did not load) → a run-time failure of the INSTALLED converter: retry once, then the log path, never "unavailable" (SKILL.md §12). A stage crashed (internal) → retry once, then report with the log path |
| 5 | busy | this deck is already being checked/built, or no slot freed up within the wait → wait / retry once |
| 6 | timeout | a stage or the total budget ran out → fewer slides or image assets, or split the deck |
| 130/143 | cancelled | signal or orphaned (no deliverable change) |

## Budgets, caps and locks
- **Order of operations:** parse args → validate the deck folder, names and caps, then the `--only` names against
  the deck's slides (exit 1/2 with NO toolchain needed) → take the per-deck lock (exit 5 "already running", naming
  pid/command/start from `.build/run.json`) →
  resolve the toolchain (exit 4) → wait for a host slot (poll 1 s, one waiting line, give up after
  `min(NOAH_PPTX_SLOT_WAIT_SECONDS, remaining − 60 s)` → exit 5 "busy") → run.
- **Caps** (pre-checks exit 1 before any browser starts; runtime ones are lint errors or exit 6). Defaults are
  reported by `probe` and in `describe_system`:

  | limit | default | override |
  |---|---|---|
  | total wall clock per `check`/`build`, slot wait included | 540 s (`selftest` 900 s) | `NOAH_PPTX_MAX_SECONDS` |
  | slot wait | 150 s (always ≤ budget − 60 s) | `NOAH_PPTX_SLOT_WAIT_SECONDS` |
  | host-wide concurrent conversions | 2 | `NOAH_PPTX_MAX_CONCURRENT` |
  | slides per build | 60 (`slide-count`) | `NOAH_PPTX_MAX_SLIDES` |
  | slide HTML | 2 MB (`slide-too-large`) | — |
  | elements under `main.slide` | 2,500 (`dom-size`) | — |
  | each served file | 20 MB (413 + `asset-too-large`) | — |
  | one picture / one slide's distinct pictures, DECODED | 40 MP / 100 MP (413 + `image-too-large`, before Chromium decodes) | — |
  | deck inputs (`slides/`, `deck.css`, `assets/`) | 100 MB (`deck-too-large`) | — |
  | renderer V8 heap | 512 MB (`--js-flags=--max-old-space-size=512`) | — |
  | built `.pptx` | 30 MB, the `share_file` cap (gate `pptx-too-large`, exit 3) | — |

- **Why 540 s.** The bundled agent CLI moves a foreground Bash command that outlives its 600 s ceiling to the
  BACKGROUND, and a background task delivers its follow-up as a NEW chat message while blocking the user's input
  until it settles. A converter that always ends first never trips that path; the SKILL still says what to do if
  it happens (wait for the notice, never start another run of that deck — a second run exits 5 anyway).
  Per-stage deadlines = remaining budget minus a reserve for the stages after it (extract reserves 90 s in
  `build`, 30 s in `check`, where only the overview sheet follows; build_pptx ≤ 180 s, reserve 45 s; each gate
  ≤ 120 s, reserve 15 s; previews ≤ 60 s); a miss kills the stage and exits 6 (a stage whose deadline is already
  non-positive never starts — e.g. `NOAH_PPTX_MAX_SECONDS=5` exits 6 before launching a browser). Measured on the dev box: a 24-slide extract took 24.4 s and its build 1.06 s.
- **Locks are abstract UNIX socket names** (`net.createServer().listen({ path: "\0…" })`), which the kernel
  releases the instant the holder dies, SIGKILL included — no lock files, no pid/age heuristics, nothing under
  `/tmp`, and PID reuse or stale locks cannot occur by construction. Host slots are
  `\0noah-pptx/<ns>/slot-<k>` for k < `NOAH_PPTX_MAX_CONCURRENT`; the per-deck lock is
  `\0noah-pptx/<ns>/deck-<sha256(realpath)[0:32]>`, held by every `check` and `build`. `<ns>` =
  `NOAH_PPTX_LOCK_NAMESPACE`, default `uid-<uid>` (tests use a random one). libuv creates the sockets CLOEXEC,
  so children never inherit them.
- **Invariant: all conversions share ONE network namespace.** Abstract socket names are per network namespace,
  i.e. per container. Noah's agent Bash is not sandboxed (there is no sandbox option anywhere in `src/server`), so
  every conversion inside the container sees the same names and the slots are truly host-wide. If a Bash sandbox
  with its own network namespace is ever enabled, each sandbox would get its own slots — move the locks to
  `flock` then (backlog item).
- **Memory.** Each conversion is one ~0.4–0.5 GiB Chromium inside the SAME container as the Node server — a
  dev-box measurement, not a production sizing; size `NOAH_PPTX_MAX_CONCURRENT` for the deploy host.

## Gates and the policy
- Gates run as parallel child processes (`python3 KIT/tools/...`) with statuses
  `pass|warn|fail|crash|skip|timeout` (and `cancelled`, which makes the whole run `cancelled`, never a verdict):
  `office-rules` (Office-only rules the SDK does not model),
  `shape-table-lint`, `chart-verify` (chart parts against the ECMA-376 XSDs + the workbook), `chart-lint`,
  `embed-verify` and `indep-check` (embedded profile only), `font-coverage`, `inspect` (editability), then
  `fidelity` (every IR element against its written object through the map).
- **Integrity BLOCKS** (nothing delivered, exit 3): lint errors (exit 1 earlier), builder-skipped elements,
  office-rules FAIL, shape-table-lint, chart-verify, chart-lint errors, embed-verify, indep-check ERROR,
  font-coverage, inspect ERROR, fidelity problems meaning a missing, unmapped or hidden object (the blocking check
  names are listed in KIT `docs/CONTRACT.md`), and a deck over 30 MB.
- **Drift WARNS** (reported, the deliverable is still written): other fidelity problems, office-rules WARN,
  builder warnings. `--strict` makes exactly that drift block too. The warnings of `chart-lint`, `indep-check`,
  `font-coverage` and `inspect` (e.g. the documented EOT-charset note on every embedded deck, the large-picture
  note on a photo slide) and extractor lint warnings (e.g. malgun's expected `font-weight` notes, folded into one
  `NOTE malgun weights` line) are informational — listed in
  the report, never drift — otherwise every embedded deck would fail `--strict`.
- A **crashed** gate or stage (a Python traceback, unparseable output) is class `internal` (exit 4), not a
  conversion verdict; a stage or total **timeout** is class `timeout` (exit 6). Neither is an authoring problem,
  so "simplify the construct" is never the advice for them.

## Isolation: CSP and network
- **Launch:** `headless`, `chromiumSandbox: false`, `--font-render-hinting=none` (without it headless Chromium
  rounds glyph advances to whole px), `--js-flags=--max-old-space-size=512`, WebRTC limited to proxied UDP, a
  black-hole proxy `socks5://127.0.0.1:9` with loopback not bypassed, `--host-resolver-rules=MAP * ~NOTFOUND ,
  EXCLUDE 127.0.0.1` passed by the converter itself (**gotcha:** the copy Playwright 1.61.1 adds for a SOCKS proxy
  keeps its quote characters in argv, and Chromium rejects it — "Failed parsing rule" in the browser log; Chromium
  keeps the last copy of a switch, and the launch `args` come after Playwright's own), `HOME`/`TMPDIR` = the run's
  temp dir. Contexts: `serviceWorkers: 'block'`, `acceptDownloads: false`, `bypassCSP: false`, 1280×720 at DSF 1/2.
  `page.setDefaultTimeout(20000)`; each extraction `evaluate` is raced against 60 s.
- **Router** (`tools/extract/server.mjs`, host `deck.local`): `/theme/*`, `/lib/*`, `/fonts/*` → KIT
  (`theme/fonts.css` → `fonts-<profile>.css`); `/deck.css`, `/slides/*`, `/assets/*` and everything else → the
  deck root. realpath containment per root (`..`, symlink escapes, non-files → 404/abort, reported); files over
  20 MB → 413, reported (read through one no-follow descriptor, so growth after the size check is cut off);
  `data:`/`blob:` continue; every other request is aborted and reported (`blocked-request`, an error). WebSockets
  are closed (`routeWebSocket`).
- **Decoded pixels are bounded by the router, not the heap cap** (the V8 cap does not cover bitmaps; a 1.2 MB
  12000×12000 PNG added ~0.7 GiB to a dev-box build's peak memory and still passed): `tools/extract/pixels.mjs` reads
  the pixel size of every deck raster image from its HEADER (PNG, JPEG, GIF with every frame, WebP, BMP, ICO/CUR,
  AVIF) and the router answers 413 + `image-too-large` BEFORE Chromium sees a byte for a picture over 40 MP, a page
  whose distinct pictures would pass 100 MP, or a recognised image of unreadable size; a deck HTML/CSS/SVG embedding
  such a base64 `data:` image is refused the same way (best effort). A Playwright page timeout is class `timeout`,
  and the browser exiting on its own mid-slide (e.g. an OOM kill) class `conversion` naming the slide.
- **CSP on every HTML response** — slides:
  `default-src 'none'; script-src http://deck.local/lib/chart.js; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`.
  The extractor's isolated raster pages get the same policy with `script-src 'none'` and `base-uri 'self'`. An
  exact-path `script-src` means not even an agent-written `.js` in the deck root can execute. The extractor's own
  code is unaffected (`page.evaluate`, `Runtime.evaluate`, `addInitScript` are CDP-injected and exempt); the
  one Playwright API that needs page `eval` — `waitForFunction` — is replaced by a Node-side 100 ms
  `evaluate` poll.
- **The lints still speak to the author.** An init script records `securitypolicyviolation` events and
  `inpage/05-document.js` inspects the DOM, so the agent learns WHY something did not load: `script`,
  `stylesheet`, `base-url`, `navigation`, `remote-url`, `csp-violation`, `dom-size`, `asset-too-large`,
  `image-too-large`, plus `blocked-request` and `missing-glyph` promoted to errors. A renderer crash on a slide is class `conversion`
  (exit 3) naming the slide.
- `--no-sandbox` is accepted: the agent's own Bash runs as the same uid with the same reach, and the Chromium
  sandbox cannot start in a default Docker container anyway ("Chromium sandboxing failed!").
- **Writes:** only under the deck root (`.build/`, the deliverable, the preview dir) and the run temp dir; KIT
  is never written.

## Deliverable replacement, failure policy, cancellation
- **Success:** gates pass on `.build/<p>/deck.pptx` → its sha256 → `previews.py` writes `<stem>.preview.new/`
  (images, `.gitignore`, `manifest.json` LAST) → `rename(candidate → <stem>.pptx)` → `rm -rf <stem>.preview/` →
  `rename(<stem>.preview.new → <stem>.preview)` → delete the `@2x` renders. Every intermediate state is harmless
  because the server compares hashes (old previews + new pptx = `stale` → LibreOffice); a leftover
  `.preview.new` is removed by the next run.
- **Blocking failure:** delete the candidate so a gate-failed file cannot be shared; leave `<stem>.pptx` and
  `<stem>.preview/` untouched; the report carries `previousDeliverable` and the footer says "The previous build
  `<stem>.pptx` (built <time>) is unchanged and does NOT include these edits."
- **Cancellation:** on SIGTERM/SIGINT/SIGHUP or orphaning (a 2 s `process.ppid` watchdog) `deck.mjs` SIGTERMs its
  children, SIGKILLs them after 3 s, starts no new child, wakes a slot wait, closes the browser, releases its locks,
  removes its run temp dir and exits 130/143. **The pipeline reports it** — `FAILED (cancelled): interrupted (<why>)
  — no deliverable was changed.` and `failure.class: "cancelled"` in `--json` and the report file — never as
  `internal` (whose Next: line says retry and give the administrator the log) or a gate verdict: a child stopped by
  a signal the run did not send (a signal to the whole process group) counts as the same cancellation, the
  extractor writes its own `cancelled` result when signalled, and the last step before the atomic replacement is a
  cancellation check, so 130/143 always means an untouched deliverable. Python children arm `PR_SET_PDEATHSIG`
  (`tools/pdeathsig.py`); Chromium exits when its CDP pipe closes. All temp state lives in `$TMPDIR/noah-pptx-run-<pid>-<rand>/` (Chromium profile, children's
  `HOME`/`TMPDIR`); at startup `deck.mjs` sweeps `noah-pptx-run-*` entries whose pid is dead or that are older
  than 1 h, and touches nothing else. compose's `init: true` reaps whatever is orphaned. A `$TMPDIR` longer than
  30 characters is not used for run dirs (they go to `/tmp`): the full Chromium build aborts with "Socket path
  too long" once `<run dir>/org.chromium.Chromium.XXXXXX/SingletonSocket` passes the 108-byte UNIX socket limit.
  Noah never sets `TMPDIR`, and the Dockerfile's `mktemp -d` is 19 characters.
- **Gotcha: Playwright's own temp dirs follow the NODE process's `os.tmpdir()`.** `chromium.launch()` creates
  `playwright_chromiumdev_profile-*` and `playwright-artifacts-*` there; the launch option `env` reaches only
  the browser. A launcher that set `TMPDIR` only in the launch `env` would leave those two dirs in `/tmp` after a
  SIGKILL, outside the sweep's reach (the Docker smoke's `f/rerun` step fails on exactly that — observed with a
  stub converter). The converter avoids it structurally: `deck.mjs` never launches a browser itself; the
  extract child does, and that child's OWN environment has `HOME`/`TMPDIR` = the run dir, so both dirs land in
  the run dir and go with it. Keep it that way — the image's build-time self-test cannot catch a regression,
  because its RUN sets `TMPDIR` for the whole process.

## Preview sidecar and the server side
- **Manifest** `<stem>.preview/manifest.json` (written by `previews.py`, validated by the server):
  `{format: "noah-deck-preview", version: 1, generator: "noah-pptx-converter/<VERSION>", pptx, pptxSha256,
  profile, createdAt, slideCount, slides: [{index, file, mediaType, sha256, width, height, title?}]}`. `slides`
  covers ALL slides in deck order; each image is the @2x render downscaled (Pillow LANCZOS) to 1920×1080, PNG
  when ≤ 2 MiB else JPEG q90 — and then the first 30 (the attached ones) are FITTED into the loader's 32 MiB budget,
  re-encoding the largest one step down `JPEG q90 → 80 → … → 40` until they fit (30 PNGs of up to 2 MiB could be
  60 MiB, and the loader is all-or-nothing; 30 synthetic photo-heavy renders measured 59 MiB before the fit). `previews.py`
  pins `ATTACHED_MAX`/`ATTACHED_BUDGET`/`IMAGE_MAX_BYTES` to the server's `MAX_PREVIEW_PAGES`/
  `MAX_DECK_PREVIEW_TOTAL_BYTES`/`MAX_CHAT_IMAGE_BYTES` (`tests/deck-contract.test.ts`). `title` is the slide's
  title placeholder text (≤ 120 chars) or absent; unknown extra files in the dir are ignored.
- **`share_file` (routes/chat.ts `onShareFile`)**, for `stored.ext === "pptx"`: `publishWorkspaceFile` returns
  `sourcePath` (the realpath it read) and `sha256` (of the SAME buffer it stored — no TOCTOU gap), then
  `loadConverterPreviews` (`src/server/deckPreview.ts`, async, pure fs, no shell) validates in order:
  realpath the preview dir (ENOENT or a dangling link → `none`) → inside the SAME roots `publishWorkspaceFile`
  used, else `invalid` → `manifest.json` (missing → `none`, the converter writes it LAST) resolving inside the
  preview dir itself, a regular file ≤ 128 KiB (opened non-blocking and no-follow, so a FIFO swapped in cannot
  hang a thread), valid JSON, right format/version → **`pptxSha256` (lowercase hex64) equals the published
  sha256, else `stale`, checked BEFORE any image is read** → profile `embedded`/`malgun`, 1..200 entries,
  `slideCount` (if present) = the entry count, consecutive `index`, unique `^slide-\d{2,3}\.(png|jpg)$` files,
  matching media type/extension, hex64 sha256, int dims 1..8192, `title` omitted or a string ≤ 300 (never
  `null`) → for the first 30 (`MAX_PREVIEW_PAGES`), `readWorkspaceImageAsync` must return exactly the declared
  media type and sha256 for a file that resolves inside the preview dir, within a 32 MiB total. All-or-nothing;
  a rejection detail is a fixed English template that never echoes manifest content.
- `loaded` → all renders are saved through `saveHiddenChatImage(…, card.id)` (hidden, `parentId` = the download
  card, the SAME per-turn hidden budget as LibreOffice previews) with the Korean alt text `슬라이드 N – <title>`
  (controls and bidi marks stripped, ≤ 200 code points), then pushed and emitted in slide order, and LibreOffice
  is skipped; if a save fails midway, the saved ones are deleted and the card falls back to LibreOffice.
  `none`/`stale`/`invalid` → LibreOffice as before. Agent-made images never go through `savePreviewImages`, the
  trusted-renderer path. Every previewable share logs `share_file previews` at info with
  `{conversationId, fileId, previewSource, sidecar}`. The tool result carries facts (`previews`,
  `previewSource`, `previewTotal`, `deckSidecar`) and `fileOutputTools.ts` composes the English notes from them
  — "first 30 of N", the malgun stand-in note, and a redirect to rebuild/share in place for stale/invalid (always)
  and none (only when the converter is installed). Forged previews grant nothing `show_file hidden:true` does not
  already allow. Details: [`chat-sse-media.md`](chat-sse-media.md).

## Probe, markers and where they surface
- **One probe** (`deckRender.ts` `probeDeckToolchain`, deployment-level — NOT owner state, so it is not in
  `ownerState.ts`). The legacy half is unchanged (`python3 -c "import pptx"`, `soffice` + `pdftoppm`; the
  LibreOffice fallback previews need only the last two — `probeDocumentPreviews`); the
  converter half spawns `process.execPath <DEFAULT_PLUGINS_DIR>/skills/pptx/converter/tools/deck.mjs probe
  --json` (spawnSync, 10 s, never launches a browser) with an ALLOWLISTED env (`PATH`, `HOME`, `LANG`, `LC_ALL`,
  `TMPDIR`, `NODE_ENV`, every `NOAH_PPTX_*`, plus `PYTHONDONTWRITEBYTECODE=1`) — no secret reaches it.
  Only a definitive answer is memoized (valid probe JSON, including `converter: false`); a spawn error, timeout
  or bad JSON yields `converter: false` + "converter probe failed: <reason>" and an ASYNC re-probe at most every
  5 minutes, never blocking a turn. Under `NODE_ENV=test` it returns a fixed "not probed" state unless deps are
  injected, so unrelated suites stay hermetic. The parser is strict: `format`/`version`/boolean `converter`;
  with `converter: true` at least one known profile and all eight `limits` keys (else non-definitive); version
  strings must match `^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$` (else dropped); `missing` facts are control-stripped
  and bounded (≤ 12 × ≤ 300 chars) before they reach the model. The spawn is killed with SIGKILL at the timeout
  (a SIGTERM-ignoring probe could otherwise hang the boot) and its stdout is capped at 1 MiB.
- **What `probe` checks:** Chromium (`NOAH_PPTX_CHROMIUM` → `/usr/lib/chromium/chromium-headless-shell` →
  `/usr/lib/chromium/chromium` → Playwright's cached build ONLY with `NOAH_PPTX_DEV=1`, so a browser an agent
  downloads into `$HOME/.cache` is never used in production; version from `--version`), `playwright-core`
  resolvable from KIT via `createRequire` (fails when `DEFAULT_PLUGINS_DIR` sits outside the app tree), Python ≥
  3.10 with `pptx lxml PIL fontTools defusedxml openpyxl xlsxwriter` found by `importlib.util.find_spec`, the
  fonts per profile, the limits, and the build-time self-test record (`not-recorded` on dev boxes). `missing` is
  English FACTS for an administrator, never commands.
- **States** (`deckModeOf`): `converter` → `legacy` (python-pptx + LibreOffice + pdftoppm) → `unavailable`.
  Authoring status (`deckAuthoringStatusFor`, the exact rule of the PreToolUse hook's skill check):
  `skill-disabled` when `pptx` or `<plugin.json name>:pptx` (`avatar-defaults:pptx`) is disabled —
  `other:pptx` is not — else `read-only` without elevated tool access, else `allowed`.
- **The state on BOTH surfaces.** The explicit markers live on `describe_system`'s "Document deck generation
  (PPTX)" line (owner, group-agent and non-owner branches — one helper, `deckCapabilityLine` in
  `agent/systemTools.ts`, so they can never disagree). The prompt's `deckSection` (`agent/promptBuilder.ts`)
  carries no marker: it picks the converter or the legacy standing guidance from the same probe
  (`deckConverterEnabled` wins over `deckRenderingEnabled`). The `share_file` description
  (`deckConverterInstalled`) and the manual's "Presentations and diagrams" paragraph (no availability claims)
  complete the picture:

  | state | the deck line contains | SKILL.md preflight |
  |---|---|---|
  | converter | `toolchain available` + `converter: INSTALLED` (version, Chromium, profiles, limits; a drift clause when the record says drift) | HTML path |
  | legacy, probe present | `toolchain available` + `converter: NOT INSTALLED` (+ the missing facts, "do not install anything yourself") | python-pptx path, tell the user |
  | legacy, older callers | `toolchain available`, no marker | python-pptx path |
  | unavailable | `UNAVAILABLE` + `converter: NOT INSTALLED` (older callers without the probe state: no marker) | stop; an administrator must rebuild |
  | any, tail | `read-only` / ``administrator disabled the `pptx` skill`` / `preview/download need an interactive chat turn` | do not build; explain |

  `converter: INSTALLED` is never a substring of `converter: NOT INSTALLED`, and SKILL.md quotes all three marker
  strings verbatim, so the preflight never parses prose. Standing guidance appears only when the viewer can
  build decks (`deckConverterEnabled` / `deckRenderingEnabled` = toolchain && file output && `allowed`).
- **Boot log:** `index.ts` logs `deck toolchain probe` with `{mode, converter, chromiumVersion, profiles,
  limits, selftest, converterMissing, pythonPptx, libreOffice, definitive}`, plus a warn line
  `deck converter golden drift recorded at image build (README.md#deck-converter-golden-drift)` on drift.

## Docker packaging
- **Layers** (existing ones keep their order):
  1. after `uv`: `ARG DECK_CONVERTER=1`, then ONE apt layer installing `fontconfig` always and
     `chromium-headless-shell` unless `DECK_CONVERTER=0`, asserting `fc-cache` and printing the Chromium version.
     It reuses the mirror the first layer's `apt_mirror_sources.sh` wrote into `debian.sources`. The headless
     shell instead of `chromium`: 72 packages / 461 MB vs 115 / 616 MB, no GTK3/dbus/systemd, 0.30 s vs 0.60 s
     launch, pixel-identical renders and an identical IR. It is driven at
     `/usr/lib/chromium/chromium-headless-shell`, bypassing Debian's `/usr/bin` wrapper (which sources
     `/etc/chromium.d`).
  2. the pip layer: `COPY KIT/requirements.txt /tmp/deck-requirements.txt`, `pip3 install
     --break-system-packages --no-cache-dir -r` (with `--index-url`/`--trusted-host` from the mirror args), delete
     the copy, then assert `soffice`, `pdftoppm` and `import pptx, lxml, PIL, fontTools, defusedxml, openpyxl,
     xlsxwriter`. Pinned (python-pptx 1.0.2, lxml 6.1.3, Pillow 12.3.0, XlsxWriter 3.2.9, typing_extensions
     4.16.0, fonttools 4.66.0, defusedxml 0.7.1, openpyxl 3.1.5, et_xmlfile 2.0.0 — verified on the image's
     Python 3.11.2); installed regardless of `DECK_CONVERTER` since python-pptx is the legacy path too. Never
     apt's `python3-fonttools` (+664 MB of scipy & co.); numpy and uharfbuzz are PoC-only and not installed.
  3. npm: unchanged RUN; `playwright-core` is pinned `1.61.1` in `dependencies`, the same single lock entry
     `@playwright/test` already used (image delta 0). Playwright never downloads a browser.
  4. after `COPY . .` + `npm run build`: `ARG DECK_CONVERTER_STRICT_GOLDEN=0`; copy
     `docker/fontconfig/60-noah-deck-fonts.conf` into `/etc/fonts/conf.d/` + `fc-cache` + assert Pretendard is
     listed; `python3 -m compileall -q KIT/tools` (the skill tree is read-only at runtime); the self-test with
     `TMPDIR`/`HOME` = a `mktemp -d` dir removed in the same RUN,
     `--record /usr/local/share/noah-almighty/deck-selftest.json`, and `--fail-on-drift` only when
     `DECK_CONVERTER_STRICT_GOLDEN=1`; with `DECK_CONVERTER=0` a `{"status":"disabled"}` record instead; finally
     the build fails if `/tmp` holds any `noah-pptx*`/`playwright*`/`deck-*` entry. It runs as root under BuildKit
     (Playwright adds `--no-sandbox`); the throwaway `TMPDIR`/`HOME` keep root-owned leftovers out of `/tmp` and
     `/root`, and the locks never touch the filesystem.
- **Build args** (compose passes both): `DECK_CONVERTER` (default `1`; `0` = no Chromium, no self-test, a
  `disabled` record — the probe then reports "the image was built without the converter (DECK_CONVERTER=0)")
  and `DECK_CONVERTER_STRICT_GOLDEN` (default `0`; `1` = golden drift fails the build).
- **Mirrors:** apt must serve `chromium-headless-shell` + `chromium-common` (bookworm-security 154, or bookworm
  main 150 — verified IR-identical) and ~70 dependencies (131.8 MB of .debs); PyPI must serve every pin for
  CPython 3.11; npm needs nothing new.
- **Runtime:** no compose change beyond the two build args — no `shm_size` (Playwright passes
  `--disable-dev-shm-usage`), no capabilities (`--no-sandbox`), and `init: true` reaps Chromium children. The
  egress overlay's `NODE_OPTIONS` preload only sets an undici dispatcher (harmless for abstract sockets and CDP
  pipes), and the black-hole proxy targets loopback, which the egress iptables allow.
- **Size** (fresh builds of the current vs the proposed Dockerfile): 919.6 MB → 1,130.5 MB of image content
  (+210.8 MB compressed, +541.7 MB uncompressed, +22 %); the containerd store grows 3.35 → 4.1 GB. The skill tree
  is ≈ 28 MB (fonts 25.8 MB), ~11.5 MB compressed in git clones; no LFS, because the closed deploy host could not
  fetch it.
- **Existing deployments:** tag the running image, `git pull`, `docker compose build`, `up -d`; no DB, volume or
  `.env` migration, no new required env, uid 1000 unchanged, old cards keep their stored previews. The exact
  commands, including the rollback, are README
  [`#deck-converter-rollback`](../../README.md#deck-converter-rollback).

## Fonts, licenses and the fontconfig side effect
- **Vendored, unmodified, all SIL OFL 1.1**, with their license texts and a provenance README (versions, URLs,
  SHA-256) in `KIT/fonts/`: Pretendard 1.3.9 static TrueType ×4 (Regular/SemiBold/Bold/ExtraBold — the
  `embedded` profile, embedded into the file as-is: 10.7 MB raw, 4.7 MB deflated), Gothic A1 2.50 ×2 (Hangul)
  and Selawik 1.01 ×2 (Latin, Segoe UI metrics) — the `malgun` profile's metric-matched stand-in for 맑은 고딕 —
  and Noto Sans KR 2.004 VF (the Hanja helper face for the HTML measurements; a Hanja-only subset would be an OFL
  Modified Version, so it ships whole). The font CSS is GENERATED (`fonts.json` + `theme/fonts-*.css`,
  generator preserved in [`../pptx-converter/maint/`](../pptx-converter/maint/)) — never hand-edit it. No
  Windows font is in the repository: the PoC read Malgun Gothic in place only to derive the CSS numbers.
- **fontconfig** (`docker/fontconfig/60-noah-deck-fonts.conf`): registers the fonts dir for LibreOffice —
  Pretendard ×4, Gothic A1 ×2, Selawik ×2, NEVER NotoSansKR-VF (LibreOffice 7.4 draws a variable font's default
  instance, which is Thin) — and aliases 맑은 고딕 / Malgun Gothic → Selawik, Gothic A1. LibreOffice 7.4 ignores
  embedded fonts, so without it the fallback previews of an edited converter deck would show NanumGothic/DejaVu.
  **Accepted side effect:** LibreOffice previews of OTHER documents that name 맑은 고딕 use these closer
  stand-ins too. Chromium resolves the deck's fonts through the converter's `@font-face` rules; the registration
  happens before the build-time self-test, so an effect on the renders would show up as drift.
- **Viewers:** desktop PowerPoint uses the embedded Pretendard (the user's Windows test rendered it; PowerPoint
  builds ≥ 2411). PowerPoint for the web, Teams/SharePoint previews and other web viewers ignore embedded fonts
  and substitute a similar font (layouts held at +5 % / −12 % width in that test); send those audiences — and
  Hanja-heavy decks (Pretendard has no Hanja) — the `malgun` build.

## Chromium drift, goldens and `--update-golden`
- `selftest` copies two frozen decks into its run temp dir, sets `SOURCE_DATE_EPOCH` and builds both profiles:
  `KIT/selftest/deck/` (the PoC's 4 slides verbatim, also the port-equivalence fixture) and
  `KIT/selftest/features/` (a full-bleed 3000×2000 JPEG photo → the 2560 px raster cap and the JPEG path, a
  `deck.css` override, a ≥ 3-line soft wrap, speaker notes in `<template id="notes">`, a rounded transparent PNG
  and an inline SVG icon). Verdicts: `fail` (any integrity failure, crash or toolchain problem → exit 3/4),
  `drift` (integrity passes but the IR differs from `KIT/selftest/golden/<deck>.<profile>.ir.json` — a numeric
  leaf beyond |Δ| > 0.01, or strings/booleans/nulls/array lengths or the lint/warning multiset → exit 0 with a
  `DRIFT` line, exit 3 with `--fail-on-drift`), else `pass`.
- The record (`--record`) is `{format: "noah-deck-selftest-record", version: 1, status, converterVersion,
  chromiumVersion, at, maxDelta, differences, lintSetChanged}`; `probe` reads it from `NOAH_PPTX_SELFTEST_RECORD`
  (default `/usr/local/share/noah-almighty/deck-selftest.json`).
- Drift is recorded, not fatal, by default because the apt mirror follows bookworm-security: a fatal default would
  let the next Chromium security release block every unrelated deploy, and drift alone does not make a broken
  file. The IR was bit-identical across Chromium 149/150/154, so drift should be rare — and it is always visible
  (probe, boot log warn, `describe_system`). The dev smoke always treats it as fatal.
- `--update-golden` rewrites the goldens with the running Chromium; it refuses a read-only KIT, and is run only
  after a PowerPoint spot-check. The maintainer procedure is README
  [`#deck-converter-golden-drift`](../../README.md#deck-converter-golden-drift).
- **Versioning:** `KIT/VERSION` (`1.0.0`) feeds `generator` = `noah-pptx-converter/<VERSION>`; bump it whenever
  the output changes, and regenerate the goldens only after a PowerPoint spot-check.

## Tests and the smoke
| file | covers |
|---|---|
| `tests/deck-converter.test.ts` | CLI contract, caps, `--only` validation, locks (incl. an aborted slot wait), the cwd-proof Python probe, the router's decoded-pixel budget and the image-header reader, static greps over KIT (always run); opt-in e2e: selftest, CSP/network negative controls, the resolver rule, `image-too-large`, renders of renamed slides, deliverable replacement, cancellation (SIGKILL, orphaning, SIGTERM/SIGINT → `cancelled` 143/130 in output and report), budget |
| `tests/pptx-skill.test.ts` | SKILL.md / reference prose pins, frontmatter, markers, `${CLAUDE_SKILL_DIR}` confinement, example lint |
| `tests/deck-preview.test.ts` (+ `routes-chat`, `chat-files`, `chat-images`) | the sidecar loader's edge cases, the `share_file` branches and texts |
| `tests/deck-toolchain.test.ts` (+ `agent-core`, `agent-tools`, `system-manual`) | the probe (injected spawn/clock), memo + async retry, env allowlist, modes, authoring status; prompt/describe_system/manual branches and size caps |
| `tests/deck-packaging.test.ts` | the static Dockerfile / compose / fontconfig / npm + Python pins / `.env.example` / ignore-file / README-anchor / smoke contract |
| `tests/deck-contract.test.ts` (+ `tests/fixtures/deck-preview/mini/`) | a converter-made one-slide malgun fixture accepted by the server loader (plus stale / altered-render / copied-deck rejections); the real `probe --json` through the server's parser; the describe_system markers and tails (owner and non-owner) against SKILL.md's quotes of them; the `--help` block above; `previews.py`'s size caps = the server's; opt-in e2e: the real probe → the INSTALLED marker, photo-heavy previews fitted into the 32 MiB budget and loaded, and a copy of `examples/business-review` built and shared through the loader |

- The toolchain e2e suites run only with `NOAH_PPTX_E2E=1` AND a probe that reports the converter; on a dev box
  also set `NOAH_PPTX_PYTHON=<venv python>` and `NOAH_PPTX_DEV=1`. Everywhere else they skip. Recipe:
  [`build-run-verify.md`](build-run-verify.md#deck-converter).
- **`scripts/deck-docker-smoke.sh`** drives a built image the way production runs it (`--network none --cap-drop
  ALL --security-opt no-new-privileges:true -u node --init`): (a) `/tmp` hygiene + the record says `pass`,
  (b) probe → converter true, (c) `selftest --fail-on-drift`, (d) every `examples/*` deck × both profiles with
  `--strict`, (e) two concurrent checks → exactly one exit 5 "already running", (f) SIGKILL `deck.mjs` mid-build →
  no Chromium/Python after 10 s, the re-run is not refused and leaves `/tmp` clean, (g) the Open XML SDK 3.3.0
  validator (Microsoft365, dev/CI-only source in `scripts/openxml-validator/`) over every produced deck — 0
  errors, (h) server boot (`/api/bootstrap` 200 + the probe log line), (i) with `--baseline-image`, an upgrade
  rehearsal on a data volume the baseline created, (j) a summary table. Run it whenever the converter or the
  Dockerfile changed.

## Known limitations
- PowerPoint itself was only spot-checked by the user (desktop, Windows); the gates are checkers modelled on
  Office's rules and the Open XML SDK, not PowerPoint. Editing behavior users should know (shrink on overflow,
  table rows next to 합계, the fixed chart axis, footer in the 본문 layout, Design > Fonts) is in
  `default-skills/skills/pptx/reference/EDITING.md`.
- LibreOffice previews (edited decks, docx/xlsx/pdf) stay approximate; malgun previews use the stand-in font,
  and the result note says so.
- ≤ 60 slides per build (split bigger decks); no background (`run_in_background`) conversions; no converter
  support for user templates/masters (the python-pptx path covers them); in-deck Korean metadata (layout names
  표지/본문, placeholder prompts, alt text, `계열 N`) is not localized; no MicroType Express compression; no
  Hanja-only NotoSansKR subset; LibreOffice ≥ 25.8 is not targeted.
- The admin skill list shows the old `pptx` description until the CLI version changes (the skill-discovery cache
  key in `skillDiscovery.ts`) — cosmetic.
- Deferred client polish and the open production questions (concurrency sizing, mirror coverage, disk) are in
  [`../REFACTORING-BACKLOG.md`](../REFACTORING-BACKLOG.md#pptx-converter-2026-09--deferred-follow-ups).
