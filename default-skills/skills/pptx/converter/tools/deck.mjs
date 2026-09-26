#!/usr/bin/env node
// The pptx skill's converter CLI: HTML/CSS slides -> native, editable PowerPoint. Run through scripts/deck.sh.
//   check | build | probe | selftest | --help        (docs/CONTRACT.md; the --help text below is the docs' source)
// Output is English model input; with --json, stdout is exactly one JSON object and the human text goes to stderr.
import { DEFAULT_AUTHOR, DeckFailure, EXIT, NEXT, Printer, emitJson, exitCodeOf, footerLines } from './lib/report.mjs';
import { PROFILES, limitsFromEnv, resolveDeckArg } from './lib/deckfs.mjs';
import { Run, runBuild, runCheck } from './lib/pipeline.mjs';
import { probe, probeLines } from './lib/probe.mjs';
import { runSelftest } from './lib/selftest.mjs';
import { watchParent } from './lib/proc.mjs';

export const HELP = `deck.sh — HTML/CSS slides -> editable PowerPoint (.pptx): the pptx skill's converter

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
`;

const COMMANDS = new Set(['check', 'build', 'probe', 'selftest']);
const SPEC = {
  check: { values: new Set(['--profile', '--only']), flags: new Set(['--json']), positional: 1 },
  build: { values: new Set(['--profile', '--out', '--author']), flags: new Set(['--strict', '--json']), positional: 1 },
  probe: { values: new Set(), flags: new Set(['--json']), positional: 0 },
  selftest: { values: new Set(['--profile', '--keep', '--record']), flags: new Set(['--fail-on-drift', '--update-golden', '--json']), positional: 0 },
};

function usageError(msg) {
  return new DeckFailure('usage', msg, { stage: 'usage', next: NEXT.usage() });
}

function parse(argv) {
  const cmd = argv[0];
  if (!COMMANDS.has(cmd)) throw usageError(cmd ? `unknown command "${cmd}" (check, build, probe, selftest or --help)` : 'missing command (check, build, probe, selftest or --help)');
  const spec = SPEC[cmd];
  const a = { cmd, pos: [], values: {}, flags: new Set(), only: [] };
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--help' || t === '-h') return { help: true };
    if (spec.flags.has(t)) {
      a.flags.add(t);
    } else if (spec.values.has(t)) {
      if (t === '--only') {
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) a.only.push(argv[++i]);
        if (!a.only.length) throw usageError('--only needs at least one slide name (NN-name)');
        continue;
      }
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw usageError(`${t} needs a value`);
      if (a.values[t] !== undefined) throw usageError(`${t} given twice`);
      a.values[t] = argv[++i];
    } else if (t.startsWith('-')) {
      throw usageError(`unknown flag ${t} for "${cmd}"`);
    } else {
      a.pos.push(t);
    }
  }
  if (a.pos.length > spec.positional) throw usageError(`unexpected argument "${a.pos[spec.positional]}"`);
  if (spec.positional && !a.pos.length) throw usageError(`"${cmd}" needs a <deck> folder`);
  return a;
}

function profilesOf(value, { allowBoth, def }) {
  if (value === undefined) return def;
  if (value === 'both' && allowBoth) return [...PROFILES];
  if (PROFILES.includes(value)) return [value];
  throw usageError(`--profile must be ${allowBoth ? 'embedded, malgun or both' : 'embedded or malgun'} (got "${value}")`);
}

let RUN = null;
let PRINTER = null;
let JSON_MODE = false;
let CANCELLING = false;
let CURRENT = { command: null };
/** How long cancel() leaves the pipeline to report the cancellation itself once the children are gone. */
const CANCEL_SETTLE_MS = 5000;

/** Print a failure that has no run report (the footer, plus the one JSON object with --json), then exit. */
function exitWith(f) {
  try {
    if (PRINTER) PRINTER.lines(footerLines(f));
    if (JSON_MODE) {
      const selftest = CURRENT.command === 'selftest';
      emitJson({ format: selftest ? 'noah-deck-selftest' : 'noah-deck-run', version: 1, command: CURRENT.command, ok: false, ...(selftest ? { status: 'fail' } : {}),
        exitCode: exitCodeOf(f), failure: { class: f.cls, stage: f.stage, message: f.message, next: f.next } });
    }
  } finally {
    process.exit(exitCodeOf(f));
  }
}

/**
 * SIGTERM / SIGINT / SIGHUP, orphaning or a closed output pipe. The run stops its children (none starts after this)
 * and wakes a slot wait; the pipeline sees it at its next step and REPORTS the run as cancelled itself — FAILED
 * (cancelled), exit 130/143, report.json — through main()'s normal exit, never as a crash. Only when that has not
 * happened shortly after the children are gone (or no run exists yet) is the cancellation reported here.
 */
async function cancel(code, why) {
  if (CANCELLING) return;
  CANCELLING = true;
  if (RUN) {
    await RUN.cancel(code, why).catch(() => {});
    await new Promise((r) => setTimeout(r, CANCEL_SETTLE_MS));
    RUN.cleanup();
  }
  exitWith((RUN && RUN.cancelledFailure('cancelled'))
    || new DeckFailure('cancelled', `interrupted (${why}) — no deliverable was changed.`, { stage: 'cancelled', next: NEXT.cancelled(), exitCode: code }));
}

async function main(argv) {
  JSON_MODE = argv.includes('--json');
  PRINTER = new Printer(JSON_MODE);
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    if (!argv.length) {
      process.stderr.write(HELP);
      return EXIT.usage;
    }
    process.stdout.write(HELP);
    return 0;
  }
  let a;
  try {
    a = parse(argv);
  } catch (f) {
    PRINTER.lines(footerLines(f));
    if (JSON_MODE) emitJson({ format: 'noah-deck-run', version: 1, command: COMMANDS.has(argv[0]) ? argv[0] : null, ok: false, exitCode: exitCodeOf(f), failure: { class: f.cls, stage: 'usage', message: f.message, next: f.next } });
    return exitCodeOf(f);
  }
  if (a.help) {
    process.stdout.write(HELP);
    return 0;
  }
  CURRENT = { command: a.cmd };
  if (a.cmd === 'probe') {
    const p = probe();
    if (JSON_MODE) emitJson(p);
    PRINTER.lines(probeLines(p));
    return p.converter ? 0 : EXIT.toolchain;
  }
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 143]]) process.on(sig, () => { cancel(code, sig); });
  watchParent(() => { cancel(143, 'the parent process went away'); }, 2000);
  // the reader of our output is gone (EPIPE): nobody will see the result — cancel instead of crashing
  for (const s of [process.stdout, process.stderr]) s.on('error', (e) => { if (e && e.code === 'EPIPE') cancel(143, 'the output pipe closed'); });
  if (a.cmd === 'selftest') {
    RUN = new Run({ command: 'selftest', budgetSeconds: 900 });
    let profiles;
    try {
      profiles = profilesOf(a.values['--profile'], { allowBoth: true, def: [...PROFILES] });
    } catch (f) {
      PRINTER.lines(footerLines(f));
      if (JSON_MODE) emitJson({ format: 'noah-deck-selftest', version: 1, ok: false, status: 'fail', exitCode: exitCodeOf(f), failure: { class: f.cls, stage: 'usage', message: f.message, next: f.next } });
      return exitCodeOf(f);
    }
    const rep = await runSelftest(RUN, PRINTER, {
      profiles, keep: a.values['--keep'] || null, failOnDrift: a.flags.has('--fail-on-drift'),
      record: a.values['--record'] || null, updateGolden: a.flags.has('--update-golden'),
    });
    if (JSON_MODE) emitJson(rep);
    return rep.exitCode ?? (rep.ok ? 0 : 4);
  }
  // check / build
  const limits = limitsFromEnv();
  RUN = new Run({ command: a.cmd, budgetSeconds: limits.maxSeconds });
  let rep;
  try {
    const deck = resolveDeckArg(a.pos[0]);
    if (deck.error) throw usageError(deck.error);
    if (a.cmd === 'check') {
      const profiles = profilesOf(a.values['--profile'], { allowBoth: true, def: ['embedded'] });
      rep = await runCheck(RUN, PRINTER, { deck, profiles, only: a.only });
    } else {
      const [profile] = profilesOf(a.values['--profile'], { allowBoth: false, def: ['embedded'] });
      const author = a.values['--author'] ?? DEFAULT_AUTHOR;
      if (!author.trim() || author.length > 100 || /[\u0000-\u001f\u007f]/.test(author)) throw usageError('--author must be 1-100 characters without control characters');
      rep = await runBuild(RUN, PRINTER, { deck, profile, out: a.values['--out'] || null, author, strict: a.flags.has('--strict') });
    }
  } catch (f) {
    if (!(f instanceof DeckFailure)) throw f;
    PRINTER.lines(footerLines(f));
    rep = { format: 'noah-deck-run', version: 1, command: a.cmd, ok: false, exitCode: exitCodeOf(f), failure: { class: f.cls, stage: f.stage, message: f.message, next: f.next } };
  }
  if (JSON_MODE) emitJson(rep);
  return rep.exitCode ?? (rep.ok ? 0 : 4);
}

main(process.argv.slice(2)).then((code) => {
  if (RUN) RUN.cleanup();
  process.exit(code);
}).catch((e) => {
  if (RUN) RUN.cleanup();
  // a classified failure that escaped its stage keeps its class; anything thrown while a cancellation is in flight
  // is a consequence of it (children killed, browser closed) — neither is an internal crash
  if (e instanceof DeckFailure) exitWith(e);
  const cancelled = RUN && RUN.cancelledFailure('cancelled');
  if (cancelled) exitWith(cancelled);
  const f = new DeckFailure('internal', `the converter crashed (${String(e && e.message ? e.message : e).split('\n')[0].slice(0, 200)}).`, { stage: 'internal', next: NEXT.internal() });
  process.stderr.write(`${e && e.stack ? e.stack : e}\n`);
  exitWith(f);
});
