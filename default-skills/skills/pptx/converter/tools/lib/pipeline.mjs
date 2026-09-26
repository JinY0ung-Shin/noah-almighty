// check / build: pre-checks -> deck lock -> toolchain -> slot -> stages under one time budget (docs/CONTRACT.md
// "Runs"). Every child is registered with the Run so a signal or an orphaned parent tears everything down.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  KIT, GENERATOR, MAX_PPTX_BYTES, OUT_NAME_RE, limitsFromEnv, precheckDeck, relPosix,
} from './deckfs.mjs';
import { acquireSlot, defaultNamespace, lockDeck } from './locks.mjs';
import { Children, makeRunDir, runBase, sweepStaleRunDirs } from './proc.mjs';
import {
  DeckFailure, DECK_SH, NEXT, disp, exitCodeOf, footerLines, isExpectedLint, lintCounts, lintLines, mb, rerunArgs, secs, shortPath, writeJsonFile,
} from './report.mjs';
import { runFidelity, runGates } from './gates.mjs';
import { pythonEnv, pythonExecutable } from '../extract/chromium.mjs';
import { toolchainFacts } from './toolchain.mjs';

export const T0 = performance.timeOrigin;
const EXTRACT = path.join(KIT, 'tools', 'extract.mjs');
const BUILD = path.join(KIT, 'tools', 'build_pptx.py');
const PREVIEWS = path.join(KIT, 'tools', 'previews.py');
const LOGS_KEPT = 5;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function lastLine(s) {
  const l = String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  return l.length ? l[l.length - 1].slice(0, 240) : '';
}

function utcStamp(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
}

function humanTime(ms) {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function sha256File(f) {
  return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}

/** One converter run: budget clock (from process start), children, locks, temp dir, cancellation. */
export class Run {
  constructor({ command, budgetSeconds }) {
    this.command = command;
    this.budgetSeconds = budgetSeconds;
    this.budgetMs = budgetSeconds * 1000;
    this.children = new Children();
    this.locks = [];
    this.runTmp = null;
    this.cleaned = false;
    /** {code: 130|143, why} once the run is cancelled (first cause wins). */
    this.cancelState = null;
    /** Aborted on cancellation: wakes a slot wait. */
    this.abort = new AbortController();
  }

  /** Remember a cancellation without acting on it (first cause wins). */
  noteCancel(code, why) {
    if (!this.cancelState) this.cancelState = { code, why };
  }

  /**
   * deck.mjs's signal / orphan / EPIPE handlers: stop every child and wake a slot wait. The pipeline then sees the
   * cancellation at its next step and reports it (FAILED (cancelled), exit 130/143, the report file included).
   */
  cancel(code, why) {
    this.noteCancel(code, why);
    this.abort.abort();
    return this.children.cancelAll();
  }

  /**
   * The `cancelled` failure when the run was cancelled — or when a child died of a SIGTERM/SIGINT/SIGHUP the run did
   * not send (a signal to the whole process group reaches the children as well) — else null.
   */
  cancelledFailure(stage) {
    const sig = this.children.interrupted;
    if (sig) this.noteCancel(sig === 'SIGINT' ? 130 : 143, `a converter process was stopped by ${sig}`);
    const s = this.cancelState;
    if (!s) return null;
    return new DeckFailure('cancelled', `interrupted (${s.why}) — no deliverable was changed.`, { stage, next: NEXT.cancelled(), exitCode: s.code });
  }

  throwIfCancelled(stage) {
    const f = this.cancelledFailure(stage);
    if (f) throw f;
  }

  elapsedMs() {
    return Date.now() - T0;
  }

  remainingMs() {
    return this.budgetMs - this.elapsedMs();
  }

  /** min(cap, remaining - reserve); <= 0 means the stage cannot start. */
  deadline(capMs, reserveMs) {
    return Math.min(capMs ?? Number.POSITIVE_INFINITY, this.remainingMs() - reserveMs);
  }

  timeout(stage) {
    return new DeckFailure('timeout', `the ${stage} stage exceeded the converter's time budget (${Math.round(this.elapsedMs() / 1000)} of ${this.budgetSeconds} s)`, { stage, next: NEXT.timeout() });
  }

  ensureTmp() {
    if (!this.runTmp) {
      const base = runBase();
      sweepStaleRunDirs();
      if (base !== os.tmpdir()) sweepStaleRunDirs(base);
      this.runTmp = makeRunDir();
    }
    return this.runTmp;
  }

  childEnv(extra = {}) {
    const env = { ...process.env, ...extra };
    if (this.runTmp) {
      env.HOME = this.runTmp;
      env.TMPDIR = this.runTmp;
    }
    return env;
  }

  pyEnv(extra = {}) {
    return { ...pythonEnv(process.env, this.runTmp), NOAH_PPTX_PARENT_PID: String(process.pid), ...extra };
  }

  releaseLocks() {
    for (const l of this.locks.splice(0)) l.release();
  }

  cleanup() {
    if (this.cleaned) return;
    this.cleaned = true;
    this.releaseLocks();
    if (this.runTmp) {
      try {
        fs.rmSync(this.runTmp, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------ toolchain
/**
 * The toolchain check of a check/build (the probe's facts, without starting anything). A miss is written to
 * `<logDir>/toolchain.log` so the failure names a log path like every other exit 4: the agent follows NEXT.toolchain,
 * which hands that path to the administrator when describe_system had reported the converter as installed.
 */
function requireToolchain(logDir = null) {
  const t = toolchainFacts();
  if (t.missing.length) {
    let log = null;
    if (logDir) {
      log = path.join(logDir, 'toolchain.log');
      const facts = [
        'deck converter toolchain check: pieces missing (the same facts `deck.sh probe` reports)',
        ...t.missing.map((m) => `  missing: ${m}`),
        `  chromium: ${t.chromium.path || '-'}${t.chromium.source ? ` (${t.chromium.source})` : ''}`,
        `  playwright-core: ${t.playwrightCore.ok ? t.playwrightCore.version : 'not resolvable'}`,
        `  python: ${t.python.executable || '-'} ${t.python.version || ''}`.trimEnd(),
      ];
      try {
        fs.writeFileSync(log, `${facts.join('\n')}\n`);
      } catch {
        log = null;
      }
    }
    throw new DeckFailure('toolchain', `the HTML→PPTX converter's toolchain is incomplete in this environment (${t.missing.join('; ')})${log ? `; log: ${log}` : ''}.`, { stage: 'toolchain', next: NEXT.toolchain() });
  }
  return t;
}

// ------------------------------------------------------------------------------------------------ locks
export async function takeDeckLock(run, deckReal) {
  const l = await lockDeck({ deckRealpath: deckReal, ns: defaultNamespace() });
  if (!l) {
    const info = readJson(path.join(deckReal, '.build', 'run.json')) || {};
    const pid = Number.isInteger(info.pid) ? info.pid : 'unknown';
    const when = info.startedAt ? humanTime(Date.parse(info.startedAt)) : 'at an unknown time';
    const cmd = /^(check|build|selftest)$/.test(info.command) ? info.command : 'check/build';
    throw new DeckFailure('busy', `a ${cmd} of this deck is already running (pid ${pid}, started ${when}).`, { stage: 'lock', next: NEXT.busyDeck() });
  }
  run.locks.push(l);
  return l;
}

export async function takeSlot(run, limits, onWait) {
  const waitMs = Math.max(0, Math.min(limits.slotWaitSeconds * 1000, run.remainingMs() - 60000));
  const s = await acquireSlot({ max: limits.maxConcurrent, waitMs, ns: defaultNamespace(), onWait, signal: run.abort.signal });
  if (!s) {
    run.throwIfCancelled('slot');
    throw new DeckFailure('busy', `no converter slot became free within ${Math.round(waitMs / 1000)} s (other conversions are running).`, { stage: 'slot', next: NEXT.busySlot() });
  }
  run.locks.push(s);
  return s;
}

// ------------------------------------------------------------------------------------------------ deck state
function prepareBuildDir(deckReal, command) {
  const b = path.join(deckReal, '.build');
  fs.mkdirSync(b, { recursive: true });
  const gi = path.join(b, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  writeJsonFile(path.join(b, 'run.json'), { pid: process.pid, command, startedAt: utcStamp() });
  const logs = path.join(b, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let dir = path.join(logs, `${stamp}-${command}`);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(logs, `${stamp}-${command}-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const runs = fs.readdirSync(logs).filter((n) => /^\d{8}-\d{6}-/.test(n)).sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - LOGS_KEPT))) {
    try {
      fs.rmSync(path.join(logs, old), { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  return dir;
}

// ------------------------------------------------------------------------------------------------ stages
/**
 * The classified failure of an extractor result `{ok: false, class, message}`. `where` = "slide N (name): " or '',
 * `log` = the extractor's log. A `toolchain` result comes from a run whose own toolchain check (requireToolchain)
 * PASSED — Chromium did not start, playwright-core did not load in the child, a converter font file did not load —
 * so it is reported as a run-time failure of an installed converter (NEXT.toolchainRun), never as "unavailable".
 */
export function extractFailure(res, { where = '', log, deckAbs, rerun = null }) {
  const msg = String(res.message || '').split('\n');
  // a head that introduces a list ("…did not load:") reads as a sentence once the list moves to the detail lines
  const head = msg[0].replace(/^extract: /, '').replace(/:\s*$/, '');
  const detail = msg.slice(1, 12).filter((l) => l.trim());
  switch (res.class) {
    case 'authoring':
      return new DeckFailure('authoring', `${where}${head}`, { stage: 'extract', detail, next: NEXT.authoring(deckAbs, { rerun }) });
    case 'conversion':
      return new DeckFailure('conversion', `${where}${head}`, { stage: 'extract', detail, next: NEXT.conversion() });
    case 'timeout':
      return new DeckFailure('timeout', `the extract stage timed out (${where}${head})`, { stage: 'extract', detail, next: NEXT.timeout() });
    case 'toolchain':
      return new DeckFailure('toolchain', `the converter is installed (this run passed its toolchain check), but the extract stage could not use it (${head}); log: ${log}.`, { stage: 'extract', detail, next: NEXT.toolchainRun() });
    case 'usage': // runCheck validates --only first; this is the safety net
      return new DeckFailure('usage', head, { stage: 'extract', next: NEXT.usage() });
    default:
      return new DeckFailure('internal', `the extract stage crashed (${head.slice(0, 200)}); log: ${log}.`, { stage: 'extract', detail, next: NEXT.internal() });
  }
}

async function extractStage(run, st, { profile, outDir, fast, only, reserveMs }) {
  const deadline = run.deadline(null, reserveMs);
  if (deadline <= 0) throw run.timeout('extract');
  const resultFile = path.join(run.runTmp, `extract-${profile}-${fast ? 'check' : 'build'}.json`);
  const argv = [EXTRACT, '--deck', st.deckReal, '--profile', profile, '--out', outDir, '--result', resultFile];
  if (fast) argv.push('--fast');
  if (only && only.length) argv.push('--only', ...only);
  const log = path.join(st.logDir, `extract-${profile}${fast ? '-check' : ''}.log`);
  // the parent resolved the ONE browser (with the real HOME); the child gets that exact executable
  const env = run.childEnv({ NOAH_PPTX_CHROMIUM: st.toolchain.chromium.path });
  const r = await run.children.run(process.execPath, argv, { env, deadlineMs: deadline, log });
  const res = readJson(resultFile);
  // the extractor stops on its own signal too (a signal to the whole process group) and then says so in its result
  if (res && res.class === 'cancelled') run.noteCancel(r.code === 130 ? 130 : 143, 'the extractor was stopped by a signal');
  run.throwIfCancelled('extract');
  if (r.timedOut) throw run.timeout('extract');
  if (!res) {
    throw new DeckFailure('internal', `the extract stage crashed (${lastLine(r.stderr) || `exit ${r.code}`}); log: ${log}.`, { stage: 'extract', next: NEXT.internal() });
  }
  if (!res.ok) {
    const name = res.slide ? st.slideNames.get(res.slide) : null;
    const where = res.slide ? `slide ${res.slide}${name ? ` (${name})` : ''}: ` : '';
    throw extractFailure(res, { where, log, deckAbs: st.deckAbs, rerun: st.rerun });
  }
  const ir = readJson(path.join(outDir, 'ir.json'));
  if (!ir) throw new DeckFailure('internal', `the extract stage wrote no IR; log: ${log}.`, { stage: 'extract', next: NEXT.internal() });
  return { ir, ms: r.ms };
}

async function buildStage(run, st, { profile, irPath, candidate, mapPath, author }) {
  const deadline = run.deadline(180000, 45000);
  if (deadline <= 0) throw run.timeout('build');
  const log = path.join(st.logDir, `build-${profile}.log`);
  const argv = [BUILD, '--ir', irPath, '--profile', profile, '--out', candidate, '--map', mapPath, '--author', author];
  const r = await run.children.run(pythonExecutable(), argv, { env: run.pyEnv(st.pyExtraEnv), deadlineMs: deadline, log });
  run.throwIfCancelled('build');
  if (r.timedOut) throw run.timeout('build');
  let summary = null;
  const jl = String(r.stdout || '').split('\n').reverse().find((l) => l.trim().startsWith('{'));
  try {
    summary = jl ? JSON.parse(jl) : null;
  } catch {
    summary = null;
  }
  if (r.code !== 0 || !summary || !fs.existsSync(candidate)) {
    const why = String(r.stderr || '').split('\n').find((l) => /^build_pptx: error:/.test(l)) || lastLine(r.stderr) || `exit ${r.code}`;
    throw new DeckFailure('internal', `the build stage crashed (${why.replace(/^build_pptx: error: /, '').slice(0, 200)}); log: ${log}.`, { stage: 'build', next: NEXT.internal() });
  }
  const warnings = String(r.stderr || '').split('\n').filter((l) => l.startsWith('build_pptx: warning: ')).map((l) => l.slice('build_pptx: warning: '.length));
  return { summary, warnings, ms: r.ms };
}

async function previewsStage(run, st, argv, { stage = 'previews' } = {}) {
  const deadline = run.deadline(60000, 0);
  if (deadline <= 0) throw run.timeout(stage);
  const log = path.join(st.logDir, `${stage}.log`);
  const r = await run.children.run(pythonExecutable(), [PREVIEWS, ...argv], { env: run.pyEnv(), deadlineMs: deadline, log });
  run.throwIfCancelled(stage);
  if (r.timedOut) throw run.timeout(stage);
  let j = null;
  try {
    j = JSON.parse(String(r.stdout || '').trim().split('\n').pop());
  } catch {
    j = null;
  }
  if (r.code !== 0 || !j) {
    throw new DeckFailure('internal', `the ${stage} stage crashed (${lastLine(r.stderr) || `exit ${r.code}`}); log: ${log}.`, { stage, next: NEXT.internal() });
  }
  return { ...j, ms: r.ms };
}

// ------------------------------------------------------------------------------------------------ analysis
function lintOf(ir, profile) {
  return (ir.lint || []).map((l) => ({ slide: l.slide, profile, severity: l.severity, rule: l.rule, message: l.message, path: l.path }));
}

function textElements(ir) {
  const out = [];
  for (const s of ir.slides || []) for (const e of s.elements || []) if (e.kind === 'text') out.push([s, e]);
  return out;
}

function snippet(e) {
  const t = (e.paragraphs || []).map((p) => (p.runs || []).map((r) => (r.break ? ' ' : r.text || '')).join('')).join(' ');
  const c = t.replace(/\s+/g, ' ').trim();
  return c.length > 60 ? `${c.slice(0, 59)}…` : c;
}

/** The word a soft break cuts in two ("전략기획" / "실"), or null when the break falls at a space. */
export function brokenWord(before, after) {
  const a = /(\S+)$/.exec(String(before || '')), b = /^(\S+)/.exec(String(after || ''));
  return a && b ? { word: a[1] + b[1], left: a[1], right: b[1] } : null;
}

/** The element's lines joined with " / " where a line wraps without <br> (what the reader sees), ≤ 90 chars. */
function wrapped(e) {
  const L = e.lines || [];
  let t = '';
  L.forEach((l, i) => {
    t += String(l.text || '');
    if (i + 1 < L.length) t += L[i + 1].paragraph !== l.paragraph || l.hardBreak ? ' ' : ' / ';
  });
  const c = t.replace(/\s+/g, ' ').replace(/ \/ /g, ' / ').trim();
  return c.length > 90 ? `${c.slice(0, 89)}…` : c;
}

/**
 * Text elements that wrap without <br>: a line that is not the last of its paragraph and has no hard break.
 * `breaks` = per soft break the word it cuts ({word, left, right}; null at a space); `wrapped` = the text with
 * " / " where it wraps.
 */
export function softWrapsOf(ir, profile) {
  const out = [];
  for (const [s, e] of textElements(ir)) {
    const L = e.lines || [];
    const soft = L.map((l, i) => (l.hardBreak === false && i + 1 < L.length && L[i + 1].paragraph === l.paragraph ? i : -1)).filter((i) => i >= 0);
    if (!soft.length) continue;
    const breaks = soft.map((i) => brokenWord(L[i].text, L[i + 1].text));
    const w = { slide: s.index, profile, id: e.id, softBreaks: soft.length, lines: L.length, text: snippet(e), wrapped: wrapped(e), breaks };
    if (e.placeholder === 'title' || e.placeholder === 'ctrTitle') w.title = true; // linted as title-wrap already
    out.push(w);
  }
  return out;
}

export function profileWrapDiffsOf(irA, irB) {
  const count = (ir) => {
    const m = new Map();
    for (const [s, e] of textElements(ir)) m.set(`${s.index}|${e.id}`, { slide: s.index, id: e.id, n: (e.lines || []).length, text: snippet(e) });
    return m;
  };
  const a = count(irA), b = count(irB);
  const out = [];
  for (const [k, v] of a) {
    const w = b.get(k);
    if (w && w.n !== v.n) out.push({ slide: v.slide, id: v.id, embedded: v.n, malgun: w.n, text: v.text });
  }
  return out;
}

/**
 * Lines of two DIFFERENT text elements whose boxes intersect by > 1 px on both axes. A line's box is its glyphs'
 * content area — the advance width, and the font's full ascent-to-descent height (1.33 em in malgun, 1.19 em in
 * embedded), taller than the ink — so it sits inside the line box of any text whose line-height obeys AUTHORING §4.2:
 * boxes that intersect mean texts placed closer than the kit's spacing rules allow, even where the ink does not touch
 * yet (a malgun line a few px longer, or PowerPoint's own line placement, closes that gap).
 * `arrangement`: 'side-by-side' when the texts meet along the line (the overlap is a smaller share of the boxes'
 * widths than of their heights: a line that grew into its neighbour), else 'stacked' (one runs over the other);
 * `wrappedTitle`: the id of a slide/cover title of the pair that soft-wraps (its extra line is the usual cause).
 */
export function textOverlapsOf(ir, profile) {
  const out = [];
  for (const s of ir.slides || []) {
    const boxes = [];
    const texts = new Map();
    const wrappedTitles = new Set();
    for (const e of s.elements || []) {
      if (e.kind !== 'text' || Math.abs(e.rotationDeg || 0) > 1e-6) continue;
      texts.set(e.id, snippet(e));
      const L = e.lines || [];
      const soft = L.some((l, i) => l.hardBreak === false && i + 1 < L.length && L[i + 1].paragraph === l.paragraph);
      if (soft && (e.placeholder === 'title' || e.placeholder === 'ctrTitle')) wrappedTitles.add(e.id);
      for (const l of e.lines || []) {
        if (l.left === null || l.right === null || l.left === undefined) continue;
        boxes.push({ id: e.id, x0: l.left, x1: l.right, y0: l.top, y1: l.bottom });
      }
    }
    const seen = new Set();
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i], B = boxes[j];
        if (A.id === B.id) continue;
        const dx = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0);
        const dy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
        if (dx > 1 && dy > 1) {
          const key = [A.id, B.id].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          const fx = dx / Math.max(1e-6, Math.min(A.x1 - A.x0, B.x1 - B.x0));
          const fy = dy / Math.max(1e-6, Math.min(A.y1 - A.y0, B.y1 - B.y0));
          const o = {
            slide: s.index, profile, a: A.id, b: B.id, overlapPx: { x: Math.round(dx * 10) / 10, y: Math.round(dy * 10) / 10 },
            arrangement: fx < fy ? 'side-by-side' : 'stacked', textA: texts.get(A.id), textB: texts.get(B.id),
          };
          const wt = [A.id, B.id].find((id) => wrappedTitles.has(id));
          if (wt) o.wrappedTitle = wt;
          out.push(o);
        }
      }
    }
  }
  return out;
}

const clip = (t, n = 40) => {
  const c = String(t || '').replace(/\s+/g, ' ').trim();
  return c.length > n ? `${c.slice(0, n - 1)}…` : c;
};

/**
 * Lint the check derives from the IR's measured lines (report and exit status only — never written into the IR,
 * so the self-test goldens are unaffected):
 *   text-overlap (error)  the line boxes (glyph content areas, textOverlapsOf) of two elements' text intersect — a
 *                         title that wrapped into the content, a malgun line that grew into its neighbour; PowerPoint
 *                         places the lines as the render does. The message names the spacing rule that applies;
 *   soft-wrap (warn)      a two-line text whose only break cuts a word ("전략기획 / 실"): a label or caption that
 *                         almost fits. Longer paragraphs wrap inside words by design and are only listed.
 */
export function layoutLintOf(ir, profile, { overlaps = textOverlapsOf(ir, profile), softWraps = softWrapsOf(ir, profile) } = {}) {
  const out = [];
  for (const o of overlaps) {
    // what was measured: the lines' full font boxes, not the ink (textOverlapsOf) — so a render can look clear
    const measured = `measured over each line's full font height, ascent to descent (${profile === 'malgun' ? '1.33' : '1.19'} em in this profile, taller than the ink), so the glyphs may not touch yet`;
    const rule = o.arrangement === 'side-by-side'
      ? 'they meet along the line: keep ≥ 16 px between a line\'s end and the next text in the wider malgun profile, whose text is up to 20 % wider — widen the gap or the box, or shorten the text (AUTHORING §4.3)'
      : o.wrappedTitle
        ? `one runs over the other because ${o.wrappedTitle === o.a ? 'this title' : `the title ${shortPath(o.wrappedTitle)}`} wraps onto an extra line: fix its title-wrap error — shorten the title or re-break it with <br> (AUTHORING §4.3; a cover title §8.13)`
        : 'one runs over the other: give each text its own box, stacked without negative margins or overlapping positions, with a line-height ≥ 1.33 × its font size (AUTHORING §4.2)';
    out.push({
      slide: o.slide, profile, severity: 'error', rule: 'text-overlap', path: o.a,
      message: `the line boxes of its text ("${clip(o.textA)}") and of ${shortPath(o.b)} ("${clip(o.textB)}") intersect by ${o.overlapPx.x}×${o.overlapPx.y} px in the ${profile} profile — ${measured}; ${rule}`,
    });
  }
  for (const w of softWraps) {
    const bw = w.lines === 2 && !w.title ? w.breaks[0] : null;
    if (!bw) continue;
    out.push({
      slide: w.slide, profile, severity: 'warn', rule: 'soft-wrap', path: w.id,
      message: `wraps inside the word "${bw.word}" ("${bw.left}" / "${bw.right}") in the ${profile} profile — widen its box, use a smaller size, or put a <br> at a phrase boundary; if you shorten it, keep every figure and fact it states`,
    });
  }
  return out;
}

/**
 * Table cells of the IR that wrap or keep less than 30 % of their width free (AUTHORING §8.9): a cell whose text
 * wraps in PowerPoint grows its row, and the cell text is measured in THIS profile. freePct = the share of the
 * cell's content width (column width minus padding) its longest line leaves free.
 */
export function tableCellsOf(ir, profile, minFree = 0.3) {
  const out = [];
  for (const s of ir.slides || []) {
    for (const e of s.elements || []) {
      if (e.kind !== 'table' || !Array.isArray(e.cells)) continue;
      const cols = e.columnsPx || [];
      e.cells.forEach((row, r) => row.forEach((c, k) => {
        if (!c || c.covered) return;
        const L = (c.lines || []).filter((l) => l.left !== null && l.right !== null && l.left !== undefined);
        if (!L.length) return;
        const w = cols.slice(k, k + (c.colSpan || 1)).reduce((a, b) => a + b, 0) - ((c.paddingPx && c.paddingPx.l) || 0) - ((c.paddingPx && c.paddingPx.r) || 0);
        if (!(w > 0)) return;
        const line = Math.max(...L.map((l) => l.right - l.left));
        const soft = (c.lines || []).filter((l, i, a) => l.hardBreak === false && i + 1 < a.length && a[i + 1].paragraph === l.paragraph).length;
        const free = (w - line) / w;
        if (free >= minFree && !soft) return;
        const text = (c.lines || []).map((l) => l.text || '').join(' ');
        out.push({ slide: s.index, profile, id: e.id, row: r + 1, column: k + 1, text: clip(text), freePct: Math.round(free * 100), softWraps: soft });
      }));
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ helpers
function deckRel(st, abs) {
  return relPosix(st.deckReal, abs);
}

/**
 * The 1280x720 renders of THIS run, from the IR (the slides it extracted, in deck order) — never a directory
 * listing, which would also show the render of a slide that was renamed or deleted since.
 */
function rendersOf(st, irDir, ir) {
  return (ir.slides || []).filter((s) => s.referencePng).map((s) => deckRel(st, path.resolve(irDir, s.referencePng)));
}

function stageLine(name, status, ms, text) {
  return `  ${name.padEnd(9)} ${status.padEnd(5)} ${ms === null ? '    ' : secs(ms).padStart(5)}  ${text}`;
}

const LIST_MAX = 12;

function slideLabel(slideNames, slide, profile, showProfile) {
  const name = slideNames.get(slide);
  return `slide ${slide}${name ? ` (${name})` : ''}${showProfile && profile ? ` [${profile}]` : ''}`;
}

/** The soft-wrap summary plus one line per wrapped block: where it wraps, and the words a break cuts. */
function softWrapLines(softWraps, slideNames, showProfile) {
  if (!softWraps.length) return ['  soft wraps: none'];
  const out = [`  soft wraps: ${softWraps.length} text block(s) wrap without <br> (report: softWraps) — the PowerPoint line breaks may differ; each must be intended:`];
  for (const w of softWraps.slice(0, LIST_MAX)) {
    const cut = w.breaks.filter(Boolean).map((b) => `"${b.word}"`);
    out.push(`    ${slideLabel(slideNames, w.slide, w.profile, showProfile)} ${shortPath(w.id)}: ${w.lines} lines "${w.wrapped}"${cut.length ? ` — breaks inside ${cut.join(', ')}` : ''}`);
  }
  if (softWraps.length > LIST_MAX) out.push(`    … ${softWraps.length - LIST_MAX} more in the report`);
  return out;
}

/** The table-cell summary (only for decks with tables): cells that wrap or keep < 30 % of their width free. */
function tableCellLines(cells, hasTables, slideNames, showProfile) {
  if (!hasTables) return [];
  if (!cells.length) return ['  table cells: every cell stays on one line with ≥ 30 % free width'];
  const out = [`  table cells: ${cells.length} cell(s) wrap or keep < 30 % free width (report: tableCells) — a cell that wraps in PowerPoint grows its row; widen the column or shorten the text:`];
  for (const c of cells.slice(0, LIST_MAX)) {
    out.push(`    ${slideLabel(slideNames, c.slide, c.profile, showProfile)} ${shortPath(c.id)}: row ${c.row}, column ${c.column} "${c.text}" — ${c.softWraps ? 'wraps' : `${Math.max(0, c.freePct)} % free`}`);
  }
  if (cells.length > LIST_MAX) out.push(`    … ${cells.length - LIST_MAX} more in the report`);
  return out;
}

const hasTable = (ir) => (ir.slides || []).some((s) => (s.elements || []).some((e) => e.kind === 'table'));

/** The report's lint block: errors, warnings to act on, and the expected notes (report.mjs isExpectedLint). */
function lintBlock(items) {
  const c = lintCounts(items);
  return { errors: c.errors, warnings: c.warnings, expected: c.expected, items: items.map((l) => (isExpectedLint(l) ? { ...l, expected: true } : l)) };
}

function previousDeliverableOf(file) {
  try {
    const s = fs.statSync(file);
    if (!s.isFile()) return null;
    return { path: file, builtAt: utcStamp(s.mtimeMs), sha256: sha256File(file), mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * The per-run state the prologue fills in (kept outside it so a failure still has the logs dir and locks).
 * `rerun` = the deck.sh arguments that repeat this run with the same flags (every authoring Next: line).
 */
export function newState(deck, rerun = null) {
  return { deckAbs: deck.abs, deckReal: deck.real, name: deck.name, slides: [], slideNames: new Map(), pyExtraEnv: {}, logDir: null, lockWaitMs: 0, deckLock: null, slot: null, rerun };
}

/** `--only` names as the extractor accepts them ("03-table", "03-table.html", "slides/03-table.html") -> "03-table". */
export function onlyNames(only) {
  return [...new Set((only || []).map((n) => String(n).replace(/\.html$/, '').replace(/^slides\//, '')))];
}

/**
 * Shared prologue of check/build: pre-checks (exit 1, before any browser), `--only` names (exit 2), deck lock
 * (exit 5), build dir + logs, toolchain (exit 4), slot (exit 5; skipped when the caller — selftest — already holds one).
 */
async function prologue(run, printer, st, { deck, command, limits, slotHeld = false, only = [] }) {
  const pre = precheckDeck(deck.real, limits);
  st.slides = pre.slides;
  for (const s of pre.slides) st.slideNames.set(s.index, s.name);
  if (pre.problems.length) {
    const f = new DeckFailure('authoring', pre.problems.length === 1 ? pre.problems[0].message : `${pre.problems.length} deck problem(s): ${pre.problems.map((p) => p.message).join('; ')}`,
      { stage: 'precheck', next: NEXT.authoring(deck.abs, { rerun: st.rerun, rules: pre.problems.map((p) => p.rule) }) });
    f.lint = pre.problems.map((p) => ({ slide: null, profile: null, severity: 'error', rule: p.rule, message: p.message, path: p.path }));
    throw f;
  }
  const unknown = onlyNames(only).filter((n) => !pre.slides.some((s) => s.name === n));
  if (unknown.length) {
    throw new DeckFailure('usage', `--only: no such slide(s): ${unknown.join(', ')} (have ${pre.slides.map((s) => s.name).join(', ')})`, { stage: 'usage', next: NEXT.usage() });
  }
  st.deckLock = await takeDeckLock(run, deck.real);
  st.logDir = prepareBuildDir(deck.real, command);
  run.ensureTmp();
  st.toolchain = requireToolchain(st.logDir);
  run.throwIfCancelled('toolchain');
  if (slotHeld) return;
  const tw = Date.now();
  st.slot = await takeSlot(run, limits, ({ max }) => printer.line(`waiting for a converter slot (all ${max} are in use)…`));
  st.lockWaitMs = Date.now() - tw;
  run.throwIfCancelled('slot');
}

function releaseState(st) {
  if (st.deckLock) st.deckLock.release();
  if (st.slot) st.slot.release();
  st.deckLock = null;
  st.slot = null;
}

// ------------------------------------------------------------------------------------------------ check
export async function runCheck(run, printer, { deck, profiles, only, slotHeld = false }) {
  const limits = limitsFromEnv();
  const report = { format: 'noah-deck-run', version: 1, command: 'check', ok: false, exitCode: null, generator: GENERATOR, deck: deck.real, profiles };
  const names = onlyNames(only);
  const st = newState(deck, rerunArgs('check', deck.abs, { profile: profiles.length === 2 ? 'both' : profiles[0], only: names }));
  const timings = { lockWait: 0 };
  try {
    await prologue(run, printer, st, { deck, command: 'check', limits, slotHeld, only });
    report.slideCount = st.slides.length;
    timings.lockWait = st.lockWaitMs;
    const irs = {};
    const lint = [];
    const renders = {};
    const overview = {};
    let extractMs = 0;
    let previewMs = 0;
    for (const p of profiles) {
      const outDir = path.join(deck.real, '.build', 'check', p);
      const ex = await extractStage(run, st, { profile: p, outDir, fast: true, only: names, reserveMs: 30000 });
      extractMs += ex.ms;
      irs[p] = ex.ir;
      lint.push(...lintOf(ex.ir, p));
      renders[p] = rendersOf(st, outDir, ex.ir);
      const pv = await previewsStage(run, st, ['--ir', path.join(outDir, 'ir.json'), '--overview-dir', outDir], { stage: 'overview' });
      previewMs += pv.ms;
      overview[p] = pv.overview.map((f) => deckRel(st, path.join(outDir, f)));
    }
    timings.extract = extractMs;
    timings.overview = previewMs;
    const softWraps = profiles.flatMap((p) => softWrapsOf(irs[p], p));
    const profileWrapDiffs = profiles.length === 2 ? profileWrapDiffsOf(irs.embedded, irs.malgun) : [];
    const textOverlaps = profiles.flatMap((p) => textOverlapsOf(irs[p], p));
    const tableCells = profiles.flatMap((p) => tableCellsOf(irs[p], p));
    for (const p of profiles) {
      lint.push(...layoutLintOf(irs[p], p, { overlaps: textOverlaps.filter((o) => o.profile === p), softWraps: softWraps.filter((w) => w.profile === p) }));
    }
    const errors = lint.filter((l) => l.severity === 'error');
    const counted = (irs[profiles[0]].slides || []).length;
    Object.assign(report, {
      slideCount: counted,
      lint: lintBlock(lint),
      softWraps, profileWrapDiffs, textOverlaps, tableCells, renders, overview,
    });
    if (names.length) report.checkedOnly = names;
    const both = profiles.length > 1;
    const elements = (irs[profiles[0]].slides || []).reduce((n, s) => n + (s.elements || []).length, 0);
    const partial = counted < st.slides.length; // --only: the overview sheet and ir.json hold these slides only
    const scope = partial ? `${counted} of ${st.slides.length} slide(s) (--only: the overview shows these only; html/ keeps older renders of the rest)` : `${counted} slide(s)`;
    printer.line(`deck check: ${disp(deck.abs)} (profile ${profiles.join('+')}, ${scope}, ${secs(run.elapsedMs())} of ${run.budgetSeconds}s)`);
    printer.line(stageLine('extract', errors.length ? 'FAIL' : 'PASS', extractMs, `${counted} slides, ${elements} elements; ${lintCounts(lint).text}`));
    for (const p of profiles) {
      printer.line(stageLine('renders', '', null, `${disp(path.join(deck.real, '.build', 'check', p, 'html'))}/ (${renders[p].length} PNG, 1280x720)   overview: ${overview[p].map((o) => disp(path.join(deck.real, o))).join(', ')}`));
    }
    printer.lines(softWrapLines(softWraps, st.slideNames, both));
    if (both) printer.line(`  profile wrap differences: ${profileWrapDiffs.length ? `${profileWrapDiffs.length} text block(s) wrap differently in malgun (report: profileWrapDiffs)` : 'none'}`);
    printer.line(`  text overlaps: ${textOverlaps.length ? `${textOverlaps.length} pair(s) of text blocks whose line boxes intersect — lint text-overlap below (report: textOverlaps)` : 'none'}`);
    printer.lines(tableCellLines(tableCells, profiles.some((p) => hasTable(irs[p])), st.slideNames, both));
    printer.lines(lintLines(lint, st.slideNames, 30, both));
    timings.total = run.elapsedMs();
    report.timingsMs = timings;
    report.budgetSeconds = run.budgetSeconds;
    report.logs = deckRel(st, st.logDir);
    if (errors.length) {
      throw new DeckFailure('authoring', `${errors.length} lint error(s).`, { stage: 'extract', next: NEXT.authoring(deck.abs, { rerun: st.rerun, rules: errors.map((l) => l.rule) }) });
    }
    report.ok = true;
    report.exitCode = 0;
    report.failure = null;
    // the build command of the checked profile(s): a malgun check is followed by a malgun build, never the default
    const build = (p) => `bash ${DECK_SH} ${rerunArgs('build', deck.abs, { profile: p })}`;
    const builds = both ? `${build('embedded')} (Pretendard embedded) or ${build('malgun')} (맑은 고딕) — the profile you will deliver` : build(profiles[0]);
    const sheets = profiles.map((p) => (overview[p].length ? disp(path.join(deck.real, overview[p][0])) : null)).filter(Boolean);
    printer.line(`Next: look at ${sheets.length ? sheets.join(' and ') : 'the renders'} (and the renders of changed slides); when the slides look right, run: ${builds}${partial ? ` — the build checks all ${st.slides.length} slides, not only the ${counted} checked here` : ''}`);
    writeJsonFile(path.join(deck.real, '.build', 'check', 'report.json'), report);
    return report;
  } catch (e) {
    return finishFailure(e, report, { run, printer, st, reportFile: st.logDir ? path.join(deck.real, '.build', 'check', 'report.json') : null, timings });
  } finally {
    releaseState(st);
  }
}

function finishFailure(e, report, { run, printer, st, reportFile, timings, previous = null }) {
  const f = e instanceof DeckFailure ? e : new DeckFailure('internal', `the converter crashed (${String(e && e.message ? e.message : e).split('\n')[0].slice(0, 200)})${st && st.logDir ? `; log: ${st.logDir}` : ''}.`, { stage: 'internal', next: NEXT.internal() });
  if (f.lint && !report.lint) report.lint = { errors: f.lint.length, warnings: 0, items: f.lint };
  if (f.lint) printer.lines(lintLines(f.lint, st ? st.slideNames : new Map()));
  if (previous) {
    f.detail = [...(f.detail || []), `The previous build ${path.basename(previous.path)} (built ${humanTime(previous.mtimeMs)}) is unchanged and does NOT include these edits.`];
    report.previousDeliverable = { path: previous.path, builtAt: previous.builtAt, sha256: previous.sha256 };
  }
  printer.lines(footerLines(f));
  report.ok = false;
  report.exitCode = exitCodeOf(f);
  report.failure = { class: f.cls, stage: f.stage, message: f.message, next: f.next };
  if (timings) {
    timings.total = run.elapsedMs();
    report.timingsMs = timings;
  }
  report.budgetSeconds = run.budgetSeconds;
  if (st && st.logDir) report.logs = relPosix(st.deckReal, st.logDir);
  if (reportFile) writeJsonFile(reportFile, report);
  return report;
}

// ------------------------------------------------------------------------------------------------ build
export async function runBuild(run, printer, { deck, profile, out, author, strict, pyExtraEnv = {}, slotHeld = false }) {
  const limits = limitsFromEnv();
  const stem = out ? out.replace(/\.pptx$/, '') : `${deck.name}${profile === 'malgun' ? '-malgun' : ''}`;
  const finalPptx = path.join(deck.real, `${stem}.pptx`);
  const previewDir = path.join(deck.real, `${stem}.preview`);
  const previewNew = `${previewDir}.new`;
  const buildDir = path.join(deck.real, '.build', profile);
  const candidate = path.join(buildDir, 'deck.pptx');
  const mapPath = path.join(buildDir, 'deck.map.json');
  const irPath = path.join(buildDir, 'ir.json');
  const report = { format: 'noah-deck-run', version: 1, command: 'build', ok: false, exitCode: null, generator: GENERATOR, deck: deck.real, profile, strict: !!strict };
  const timings = { lockWait: 0 };
  const st = newState(deck, rerunArgs('build', deck.abs, { profile, out, author, strict }));
  st.pyExtraEnv = pyExtraEnv;
  const previous = previousDeliverableOf(finalPptx);
  try {
    if (out && !OUT_NAME_RE.test(out)) throw new DeckFailure('usage', `--out must be a bare file name like q3-review.pptx (ASCII letters, digits, '.', '_' or '-'), got ${JSON.stringify(out)}`, { next: NEXT.usage() });
    await prologue(run, printer, st, { deck, command: 'build', limits, slotHeld });
    report.slideCount = st.slides.length;
    timings.lockWait = st.lockWaitMs;
    fs.rmSync(previewNew, { recursive: true, force: true });
    fs.rmSync(candidate, { force: true });

    // ---- extract (the full check of the build profile)
    const ex = await extractStage(run, st, { profile, outDir: buildDir, fast: false, only: null, reserveMs: 90000 });
    timings.extract = ex.ms;
    const softWraps = softWrapsOf(ex.ir, profile);
    const textOverlaps = textOverlapsOf(ex.ir, profile);
    // the build is the full check of its profile: the layout lint (text overlaps …) blocks it exactly as in `check`
    const lint = [...lintOf(ex.ir, profile), ...layoutLintOf(ex.ir, profile, { overlaps: textOverlaps, softWraps })];
    const lintErrors = lint.filter((l) => l.severity === 'error');
    const elements = (ex.ir.slides || []).reduce((n, s) => n + (s.elements || []).length, 0);
    const renderList = rendersOf(st, buildDir, ex.ir);
    Object.assign(report, {
      lint: lintBlock(lint),
      softWraps, profileWrapDiffs: [], textOverlaps, tableCells: tableCellsOf(ex.ir, profile),
      renders: { [profile]: renderList },
    });
    const stages = [stageLine('extract', lintErrors.length ? 'FAIL' : 'PASS', ex.ms, `${(ex.ir.slides || []).length} slides, ${elements} elements; ${lintCounts(lint).text}`)];
    const flush = (title) => {
      printer.line(title);
      printer.lines(stages);
    };
    if (lintErrors.length) {
      flush(`deck build: ${disp(deck.abs)} (profile ${profile}, ${(ex.ir.slides || []).length} slides, ${secs(run.elapsedMs())} of ${run.budgetSeconds}s)`);
      printer.line(stageLine('renders', '', null, `${disp(path.join(buildDir, 'html'))}/ (${renderList.length} PNG, 1280x720) — this run's renders`));
      printer.lines(lintLines(lint, st.slideNames));
      throw new DeckFailure('authoring', `${lintErrors.length} lint error(s).`, { stage: 'extract', next: NEXT.authoring(deck.abs, { rerun: st.rerun, rules: lintErrors.map((l) => l.rule) }) });
    }

    // ---- build_pptx
    const bs = await buildStage(run, st, { profile, irPath, candidate, mapPath, author });
    timings.build = bs.ms;
    report.build = { warnings: bs.summary.warnings, skipped: bs.summary.skipped, items: bs.warnings.slice(0, 40) };
    stages.push(stageLine('build', bs.summary.skipped ? 'FAIL' : bs.summary.warnings ? 'WARN' : 'PASS', bs.ms, `${bs.summary.warnings} warning(s), ${bs.summary.skipped} skipped`));
    const bytes = fs.statSync(candidate).size;
    const blockers = [];
    const drift = [];
    if (bs.summary.skipped) blockers.push({ gate: 'build', detail: `the builder skipped ${bs.summary.skipped} element(s): ${bs.warnings.filter((w) => /skipped|failed/.test(w)).slice(0, 3).join(' | ')}` });
    if (bs.summary.warnings) drift.push({ gate: 'build', detail: `${bs.summary.warnings} builder warning(s): ${bs.warnings.slice(0, 2).join(' | ')}` });
    if (bytes > MAX_PPTX_BYTES) blockers.push({ gate: 'pptx-too-large', detail: `the built .pptx is ${mb(bytes)}; share_file accepts at most ${MAX_PPTX_BYTES / 1048576} MB — use fewer or smaller images (photos are embedded as JPEG) or split the deck` });

    // ---- gates (parallel) + fidelity
    const fontsJson = JSON.parse(fs.readFileSync(path.join(KIT, 'fonts', 'fonts.json'), 'utf8'));
    const gctx = { py: pythonExecutable(), pptx: candidate, ir: irPath, profile, map: mapPath, work: path.join(st.logDir, 'gates'), buildDir, fontsJson };
    let gates = [];
    let fid = null;
    if (!blockers.length) {
      const gDeadline = run.deadline(120000, 15000);
      if (gDeadline <= 0) throw run.timeout('gates');
      const tg = Date.now();
      gates = await runGates(run.children, gctx, { env: run.pyEnv(), deadlineMs: gDeadline, logDir: st.logDir });
      timings.gates = Date.now() - tg;
      run.throwIfCancelled('gates'); // a stopped gate is no verdict (never crash/internal)
      const fDeadline = run.deadline(120000, 15000);
      if (fDeadline <= 0) throw run.timeout('fidelity');
      fid = await runFidelity(run.children, gctx, { env: run.pyEnv(), deadlineMs: fDeadline, logDir: st.logDir });
      timings.fidelity = fid.ms;
      run.throwIfCancelled('fidelity');
    }
    report.gates = gates.map(({ name, status, blocking, detail, ms, items }) => ({ name, status, blocking, detail, ms, items }));
    if (fid) report.fidelity = { status: fid.status, checks: fid.checks, problems: fid.problems, blockingProblems: fid.blockingProblems || 0, driftProblems: fid.driftProblems || 0, items: fid.items };
    const worst = (arr) => (arr.some((g) => g.status === 'fail') ? 'FAIL' : arr.some((g) => ['crash', 'timeout'].includes(g.status)) ? 'FAIL' : arr.some((g) => g.status === 'warn') ? 'WARN' : 'PASS');
    if (gates.length) {
      const ran = gates.filter((g) => g.status !== 'skip');
      const skipped = gates.length - ran.length;
      stages.push(stageLine('gates', worst(ran), timings.gates, `${ran.map((g) => (g.status === 'pass' ? g.name : `${g.name}(${g.status.toUpperCase()})`)).join(' ')}${skipped ? `  (${skipped} skipped: embedded only)` : ''}`));
    }
    if (fid) stages.push(stageLine('fidelity', fid.status === 'pass' ? 'PASS' : fid.status === 'warn' ? 'WARN' : 'FAIL', fid.ms, fid.status === 'crash' || fid.status === 'timeout' ? fid.detail : `${fid.checks} checks, ${fid.problems} problem(s)${fid.problems ? ` (${fid.blockingProblems} blocking)` : ''}`));
    for (const g of gates) {
      if (g.status === 'fail') blockers.push({ gate: g.name, detail: `${g.detail}${g.items && g.items.length ? `: ${g.items.slice(0, 3).join(' | ')}` : ''}` });
      else if (g.status === 'warn') drift.push({ gate: g.name, detail: `${g.detail}${g.items && g.items.length ? `: ${g.items.slice(0, 2).join(' | ')}` : ''}` });
    }
    if (fid && fid.status === 'fail') {
      const b = fid.items.filter((i) => i.blocking).slice(0, 3);
      blockers.push({ gate: 'fidelity', detail: b.map((i) => `slide ${i.slide} [${i.check}] ${i.ir ? `${i.ir}: ` : ''}${i.message}`).join(' | ') });
    } else if (fid && fid.status === 'warn') {
      drift.push({ gate: 'fidelity', detail: `${fid.driftProblems} drift problem(s): ${fid.items.slice(0, 2).map((i) => `slide ${i.slide} [${i.check}] ${i.message}`).join(' | ')}` });
    }
    const timedOut = gates.filter((g) => g.status === 'timeout').concat(fid && fid.status === 'timeout' ? [{ name: 'fidelity' }] : []);
    const crashedG = gates.filter((g) => g.status === 'crash').concat(fid && fid.status === 'crash' ? [{ name: 'fidelity', detail: fid.detail }] : []);
    const gateLines = [];
    for (const g of [...gates.filter((x) => ['fail', 'warn'].includes(x.status))]) for (const i of (g.items || []).slice(0, 4)) gateLines.push(`GATE ${g.status.toUpperCase()} ${g.name}: ${String(i).slice(0, 220)}`);
    if (fid) for (const i of fid.items.slice(0, 6)) gateLines.push(`GATE ${i.blocking ? 'FAIL' : 'WARN'} fidelity: slide ${i.slide} [${i.check}] ${i.ir ? `${i.ir}: ` : ''}${String(i.message).slice(0, 200)}`);
    const title = `deck build: ${disp(deck.abs)} -> ${disp(finalPptx)} (profile ${profile}, ${(ex.ir.slides || []).length} slides, ${mb(bytes)}, ${secs(run.elapsedMs())} of ${run.budgetSeconds}s)`;
    if (blockers.length || (strict && drift.length)) {
      flush(title);
      printer.lines(gateLines.slice(0, 16));
      printer.lines(lintLines(lint, st.slideNames, 12));
      const all = [...blockers, ...(strict ? drift : [])];
      const first = all[0];
      throw new DeckFailure('conversion', `the ${first.gate} gate rejected the deck${strict && !blockers.length ? ' (--strict: drift blocks)' : ''} — no new deliverable was written.`,
        { stage: 'gates', detail: all.slice(0, 4).map((b) => `${b.gate}: ${b.detail}`.slice(0, 400)), next: NEXT.conversion() });
    }
    if (timedOut.length) {
      flush(title);
      throw new DeckFailure('timeout', `the ${timedOut[0].name} gate exceeded the converter's time budget (${Math.round(run.elapsedMs() / 1000)} of ${run.budgetSeconds} s)`, { stage: 'gates', next: NEXT.timeout() });
    }
    if (crashedG.length) {
      flush(title);
      throw new DeckFailure('internal', `the ${crashedG[0].name} gate crashed (${String(crashedG[0].detail || '').slice(0, 200)}); log: ${path.join(st.logDir, crashedG[0].name === 'fidelity' ? 'fidelity.log' : `gate-${crashedG[0].name}.log`)}.`, { stage: 'gates', next: NEXT.internal() });
    }

    // ---- previews + overview, then the atomic replacement of the deliverable (D22)
    const sha = sha256File(candidate);
    const pv = await previewsStage(run, st, ['--ir', irPath, '--overview-dir', buildDir, '--out-dir', previewNew,
      '--pptx-name', `${stem}.pptx`, '--pptx-sha256', sha, '--profile', profile]);
    timings.previews = pv.ms;
    // the point of no return: a cancellation seen after this line would claim "no deliverable was changed" wrongly,
    // and nothing below awaits, so none can interleave
    run.throwIfCancelled('previews');
    fs.renameSync(candidate, finalPptx);
    fs.rmSync(previewDir, { recursive: true, force: true });
    fs.renameSync(previewNew, previewDir);
    const htmlDir = path.join(buildDir, 'html');
    for (const f of fs.readdirSync(htmlDir)) if (/@2x\.png$/.test(f)) fs.rmSync(path.join(htmlDir, f), { force: true });
    // the build's OWN renders: after a build-only edit these are the current ones (.build/check/ holds the last check's)
    stages.push(stageLine('renders', '', null, `${disp(htmlDir)}/ (${renderList.length} PNG, 1280x720)   overview: ${pv.overview.map((o) => disp(path.join(buildDir, o))).join(', ')} — this build's renders; .build/check/ keeps the last check's`));
    stages.push(stageLine('preview', '', pv.ms, `${disp(previewDir)}/ (${pv.previews.length} renders, 1920x1080, for the chat card)`));
    if (softWraps.length) stages.push(`  soft wraps: ${softWraps.length} text block(s) wrap without <br> (report: softWraps)`);
    Object.assign(report, {
      ok: true, exitCode: 0,
      pptx: { path: finalPptx, bytes, sha256: sha },
      preview: { dir: previewDir, slides: pv.previews.length, width: 1920, height: 1080 },
      previousDeliverable: null,
      overview: { [profile]: pv.overview.map((o) => deckRel(st, path.join(buildDir, o))) },
      warnings: drift.map((d) => `${d.gate}: ${d.detail}`),
      failure: null,
    });
    timings.total = run.elapsedMs();
    Object.assign(report, { timingsMs: timings, budgetSeconds: run.budgetSeconds, logs: deckRel(st, st.logDir) });
    flush(title);
    printer.lines(gateLines.slice(0, 10));
    printer.lines(lintLines(lint, st.slideNames, 12));
    // ABSOLUTE: share_file resolves a relative path against the run's working directory, not the shell's current one
    // (the Bash tool keeps a `cd` between calls), so a cwd-relative path here could name a file that is not there
    printer.line(`Share it IN PLACE: mcp__file_output__share_file path="${finalPptx}" name="<title in the user's language>.pptx".`);
    printer.line('Do not copy, rename or edit the .pptx (its previews are bound to these exact bytes); to change it, edit the HTML and rebuild.');
    writeJsonFile(path.join(buildDir, 'report.json'), report);
    return report;
  } catch (e) {
    try {
      fs.rmSync(candidate, { force: true });
      fs.rmSync(previewNew, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    const file = st.logDir ? path.join(buildDir, 'report.json') : null;
    return finishFailure(e, report, { run, printer, st, reportFile: file, timings, previous: st.logDir ? previous : null });
  } finally {
    releaseState(st);
  }
}

