// Human output, failure footers and exit codes of deck.mjs. Everything printed here is MODEL INPUT: English, and
// every "Next:" line names absolute paths computed from the toolkit location (the skill-dir variable is substituted
// only inside SKILL.md, never in command output).
import fs from 'node:fs';
import path from 'node:path';
import { SKILL } from './deckfs.mjs';

export const EXIT = {
  ok: 0, authoring: 1, usage: 2, conversion: 3, drift: 3, toolchain: 4, internal: 4, busy: 5, timeout: 6,
};

/** A classified failure: cls in authoring|usage|conversion|drift|toolchain|internal|busy|timeout|cancelled. */
export class DeckFailure extends Error {
  constructor(cls, message, { stage = null, next = null, detail = [], exitCode = null, lock = null } = {}) {
    super(message);
    this.cls = cls;
    this.stage = stage;
    this.next = next;
    this.detail = detail;
    this.exitCode = exitCode ?? EXIT[cls] ?? 4;
    this.lock = lock;
  }
}

const SKILL_ABS = path.resolve(SKILL);
export const DECK_SH = path.join(SKILL_ABS, 'scripts', 'deck.sh');
const AUTHORING_MD = path.join(SKILL_ABS, 'reference', 'AUTHORING.md');
const PYTHON_PPTX_MD = path.join(SKILL_ABS, 'reference', 'python-pptx.md');

/** The document author when a build passes no --author (deck.mjs uses the same default). */
export const DEFAULT_AUTHOR = 'Noah Almighty';

/** A shell word for a copied command line: as is when it needs no quoting, else single-quoted. */
export function shq(s) {
  const t = String(s);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(t) ? t : `'${t.replace(/'/g, "'\\''")}'`;
}

/**
 * The deck.sh arguments that repeat a run with the SAME flags, for the Next: lines the agent copies: a Next: line
 * that dropped `--profile malgun` would re-check or build the embedded deck the user did not ask for.
 */
export function rerunArgs(command, deckAbs, { profile = 'embedded', only = [], out = null, author = null, strict = false } = {}) {
  const a = [command, shq(deckAbs)];
  if (profile && profile !== 'embedded') a.push('--profile', profile);
  if (only && only.length) a.push('--only', ...only.map(shq));
  if (out) a.push('--out', shq(out));
  if (author && author !== DEFAULT_AUTHOR) a.push('--author', shq(author));
  if (strict) a.push('--strict');
  return a.join(' ');
}


/** Where AUTHORING.md explains the fix for a lint rule (the Next: line points there, not only at §2). */
const RULE_SECTIONS = {
  'text-overflow': '§4.2–§4.3', 'title-wrap': '§4.3/§8.13', 'text-overlap': '§4.2–§4.3', 'soft-wrap': '§5.3',
  'font-weight': '§4.1', 'font-family': '§4.1', 'missing-glyph': '§4.5', 'mixed-content': '§5.1', 'table-content': '§8.9',
  field: '§8.2', 'chart-spec': '§8.10', 'chart-resolved': '§8.10', 'chart-contrast': '§8.10', 'out-of-bounds': '§6',
};

function ruleSections(rules) {
  const seen = new Map();
  for (const r of rules || []) if (RULE_SECTIONS[r] && !seen.has(r)) seen.set(r, RULE_SECTIONS[r]);
  return seen.size ? `; ${[...seen].map(([r, s]) => `${r}: ${s}`).join(', ')}` : '';
}

export const NEXT = {
  /**
   * This run's toolchain check found pieces missing. Whether that means "not installed" is describe_system's call
   * (SKILL.md §0/§12): a server that reported `converter: INSTALLED` gets a retry and the log, never "unavailable".
   */
  toolchain: () => `Next: do not install packages or download a browser. If describe_system reported \`converter: INSTALLED\` (or an earlier \`deck.sh probe\` exited 0), this is not a missing install: retry the same command once; if it fails again, give the user the log path for the administrator — never tell the user PPT generation is unavailable. Otherwise tell the user a system administrator must rebuild the server image; if describe_system reports the python-pptx toolchain, you may build a simpler deck with python-pptx (see ${PYTHON_PPTX_MD}).`,
  /**
   * The toolchain check passed, then a stage could not use it (Chromium did not start, a converter font file did
   * not load, …): a run-time failure of an INSTALLED converter (SKILL.md §12), never "unavailable".
   */
  toolchainRun: () => 'Next: the converter is installed (this run passed its toolchain check), so do not tell the user PPT generation is unavailable and do not install anything: retry the same command once; if it fails again, tell the user the converter failed on the server and give the administrator the log path.',
  internal: () => 'Next: retry the same command once; if it fails again, tell the user the converter hit an internal error and give the administrator the log path.',
  /** `rerun` = the deck.sh arguments of the failed run (rerunArgs), `rules` = the lint rules that failed. */
  authoring: (deckAbs, { rerun = null, rules = [] } = {}) => `Next: fix the listed elements in the slide HTML (see ${AUTHORING_MD} §2 and "Limits"${ruleSections(rules)}) and run: bash ${DECK_SH} ${rerun || `check ${shq(deckAbs)}`}`,
  conversion: () => 'Next: simplify that construct and rebuild; if it keeps failing, tell the user the converter could not build this layout.',
  busyDeck: () => 'Next: wait for that run to finish (if it was moved to the background, wait for its completion notice); do not start another check/build of this deck meanwhile.',
  busySlot: () => 'Next: retry once; if it fails again, tell the user the server is busy.',
  timeout: () => 'Next: reduce the number of slides or image assets, or split the deck into two builds.',
  usage: () => `Next: fix the command (usage: bash ${DECK_SH} --help).`,
  cancelled: () => 'Next: nothing was changed; run the command again if the interruption was not intended.',
  drift: () => 'Next: maintainers: verify the self-test decks in PowerPoint, then refresh the golden IR (deck.sh selftest --update-golden on a dev box).',
};

export function exitCodeOf(failure) {
  if (!failure) return 0;
  return failure.exitCode ?? EXIT[failure.cls] ?? 4;
}

/** cwd-relative display path; absolute when outside cwd. */
export function disp(abs) {
  if (!abs) return abs;
  const r = path.relative(process.cwd(), abs);
  return !r || r.startsWith('..') || path.isAbsolute(r) ? abs : r;
}

export function mb(bytes) {
  return bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

export function secs(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** "main.slide > section.cards:nth-child(3) > … > p.stat-value" for long DOM paths. */
export function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(' > ');
  return parts.length > 3 ? `${parts[0]} > … > ${parts[parts.length - 1]}` : String(p);
}

/**
 * A lint item that is expected by design and needs no action: a `font-weight` WARN. Weights outside the kit's
 * 400/600/700/800 are errors, so a font-weight warning only ever means a kit weight the profile has no face for —
 * the malgun profile's 600/800, which PowerPoint (and the builder) draw with 맑은 고딕 Bold (AUTHORING §4.1).
 */
export function isExpectedLint(l) {
  return l.severity === 'warn' && l.rule === 'font-weight';
}

/** "lint 0 error(s), 2 warning(s)" (+ the expected notes, which are not warnings to act on). */
export function lintCounts(items) {
  const errors = items.filter((l) => l.severity === 'error').length;
  const expected = items.filter(isExpectedLint).length;
  const warnings = items.length - errors - expected;
  return { errors, warnings, expected, text: `lint ${errors} error(s), ${warnings} warning(s)${expected ? ` (+${expected} expected malgun weight note(s))` : ''}` };
}

/**
 * Up to `max` lint lines (errors first), plus a count of the rest; the [profile] tag only when both were checked.
 * Expected notes (isExpectedLint) are folded into ONE line: 600/800 on every malgun slide is by design, and a
 * wall of identical warnings buries the ones that need action.
 */
export function lintLines(items, slideNames, max = 30, showProfile = false) {
  const expected = items.filter(isExpectedLint);
  const sorted = items.filter((l) => !isExpectedLint(l)).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  const out = [];
  for (const l of sorted.slice(0, max)) {
    const where = l.slide ? `slide ${l.slide}${slideNames.get(l.slide) ? ` (${slideNames.get(l.slide)})` : ''}` : 'deck';
    const prof = showProfile && l.profile ? ` [${l.profile}]` : '';
    out.push(`LINT ${l.severity === 'error' ? 'ERROR' : 'WARN'} ${where}${prof} ${l.rule}${l.path ? ` ${shortPath(l.path)}` : ''}: ${String(l.message).split('\n')[0]}`);
  }
  if (sorted.length > max) out.push(`… ${sorted.length - max} more lint entries in the report`);
  if (expected.length) {
    const slides = new Set(expected.map((l) => l.slide));
    out.push(`NOTE malgun weights: 600/800 text is drawn with 맑은 고딕 Bold on ${slides.size} slide(s) — expected, no action needed (AUTHORING §4.1; ${expected.length} font-weight entries in the report)`);
  }
  return out;
}

/** The two-line (or more) failure footer of Appendix A.8. */
export function footerLines(f) {
  const lines = [`FAILED (${f.cls}): ${f.message}`];
  for (const d of f.detail || []) lines.push(d);
  if (f.next) lines.push(f.next);
  return lines;
}

export class Printer {
  constructor(json) {
    this.json = json;
    this.stream = json ? process.stderr : process.stdout;
    this.count = 0;
  }

  line(s = '') {
    this.count++;
    this.stream.write(`${s}\n`);
  }

  lines(arr) {
    for (const s of arr) this.line(s);
  }
}

export function emitJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 1)}\n`);
}

export function writeJsonFile(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 1)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    /* a report file is best effort; stdout carries the same */
  }
}
