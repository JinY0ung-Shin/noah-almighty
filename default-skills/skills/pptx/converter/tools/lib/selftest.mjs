// `deck.mjs selftest`: build the two frozen decks (selftest/deck = the PoC's 4 slides, selftest/features = images,
// JPEG, deck.css, notes, soft wraps) in the run temp dir with the D12 policy and compare their IR with the golden
// files (docs/CONTRACT.md "Self-test"). fail = an integrity failure / crash / toolchain problem; drift = integrity
// passes but the IR (numeric leaf |d| > 0.01, strings, booleans, nulls, lengths) or the lint/warning set differs.
import fs from 'node:fs';
import path from 'node:path';
import { KIT, VERSION, limitsFromEnv, resolveDeckArg } from './deckfs.mjs';
import { DeckFailure, NEXT, disp, exitCodeOf, footerLines, writeJsonFile } from './report.mjs';
import { runBuild, takeSlot } from './pipeline.mjs';
import { toolchainFacts } from './toolchain.mjs';

export const SELFTEST_DECKS = ['deck', 'features'];
export const GOLDEN_DIR = path.join(KIT, 'selftest', 'golden');
export const NUMERIC_TOL = 0.01;
const SOURCE_DATE_EPOCH = '1767225600'; // 2026-01-01T00:00:00Z: reproducible docProps in the self-test decks

/** Structural IR diff (the lint list is compared separately, as a multiset). */
export function compareIr(golden, actual, tol = NUMERIC_TOL) {
  const differences = [];
  let numericLeaves = 0;
  let maxDelta = 0;
  let diffCount = 0;
  let driftLeaves = 0;
  const add = (p, m) => {
    diffCount++;
    if (differences.length < 20) differences.push(`${p}: ${m}`);
  };
  const walk = (a, b, p) => {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) return add(p, 'array vs non-array');
      if (a.length !== b.length) return add(p, `length ${a.length} vs ${b.length}`);
      a.forEach((x, i) => walk(x, b[i], `${p}[${i}]`));
      return undefined;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (p === '' && k === 'lint') continue;
        if (!(k in a) || !(k in b)) add(`${p}/${k}`, `missing in ${k in a ? 'actual' : 'golden'}`);
        else walk(a[k], b[k], `${p}/${k}`);
      }
      return undefined;
    }
    if (typeof a === 'number' && typeof b === 'number') {
      numericLeaves++;
      const d = Math.abs(a - b);
      if (d > maxDelta) maxDelta = d;
      if (d > tol) {
        driftLeaves++;
        add(p, `${a} vs ${b} (|d| ${Math.round(d * 1e6) / 1e6})`);
      }
      return undefined;
    }
    if (a !== b) add(p, `${JSON.stringify(a)?.slice(0, 60)} vs ${JSON.stringify(b)?.slice(0, 60)}`);
    return undefined;
  };
  walk(golden, actual, '');
  const ms = (ir) => {
    const m = new Map();
    for (const l of ir.lint || []) {
      const k = `${l.severity}|${l.rule}|${l.slide}|${l.path}`;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  };
  const ga = ms(golden), aa = ms(actual);
  const lintSetChanged = ga.size !== aa.size || [...ga].some(([k, v]) => aa.get(k) !== v);
  return { numericLeaves, maxDelta: Math.round(maxDelta * 1e6) / 1e6, driftLeaves, differences, diffCount, lintSetChanged };
}

function copyDir(src, dst) {
  fs.cpSync(src, dst, { recursive: true, dereference: false, errorOnExist: false, force: true });
}

class QuietPrinter {
  constructor() {
    this.buf = [];
    this.json = true;
  }

  line(s = '') {
    this.buf.push(s);
  }

  lines(a) {
    for (const s of a) this.line(s);
  }
}

export async function runSelftest(run, printer, { profiles, keep, failOnDrift, record, updateGolden }) {
  const t0 = Date.now();
  const facts = toolchainFacts(process.env, { withVersion: true });
  const chromium = facts.chromium;
  const out = { format: 'noah-deck-selftest', version: 1, ok: false, status: 'fail', converterVersion: VERSION, chromium, decks: {}, durationMs: 0 };
  if (facts.missing.length) {
    const f = new DeckFailure('toolchain', `the HTML→PPTX converter's toolchain is incomplete in this environment (${facts.missing.join('; ')}).`, { stage: 'toolchain', next: NEXT.toolchain() });
    printer.line(`deck converter selftest: FAIL (toolchain: ${facts.missing.join('; ')})`);
    printer.lines(footerLines(f));
    out.failure = { class: f.cls, stage: f.stage, message: f.message, next: f.next };
    out.exitCode = exitCodeOf(f);
    return out;
  }
  if (updateGolden) {
    try {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      fs.accessSync(GOLDEN_DIR, fs.constants.W_OK);
    } catch {
      const f = new DeckFailure('usage', `--update-golden refused: ${GOLDEN_DIR} is not writable (goldens are refreshed on a dev box only)`, { next: NEXT.usage() });
      printer.lines(footerLines(f));
      out.failure = { class: f.cls, stage: 'selftest', message: f.message, next: f.next };
      out.exitCode = exitCodeOf(f);
      return out;
    }
  }
  const limits = limitsFromEnv();
  run.ensureTmp();
  try {
    await takeSlot(run, limits, ({ max }) => printer.line(`waiting for a converter slot (all ${max} are in use)…`));
  } catch (f) {
    if (!(f instanceof DeckFailure)) throw f;
    // busy (no free slot) or cancelled while waiting: a classified failure, never a crash
    printer.line(`deck converter selftest: FAIL (${f.cls})`);
    printer.lines(footerLines(f));
    out.failure = { class: f.cls, stage: f.stage, message: f.message, next: f.next };
    out.exitCode = exitCodeOf(f);
    out.durationMs = Date.now() - t0;
    return out;
  }
  const work = path.join(run.runTmp, 'selftest');
  fs.mkdirSync(work, { recursive: true });
  let failure = null;
  let failedAt = null;
  const agg = { maxDelta: 0, differences: 0, driftLeaves: 0, lintSetChanged: false, buildDrift: false };
  const counts = {};
  for (const name of SELFTEST_DECKS) {
    const src = path.join(KIT, 'selftest', name);
    const dst = path.join(work, name);
    copyDir(src, dst);
    const deck = resolveDeckArg(dst);
    out.decks[name] = {};
    counts[name] = [];
    for (const profile of profiles) {
      const q = new QuietPrinter();
      const rep = await runBuild(run, q, { deck, profile, out: null, author: 'Noah Almighty', strict: false, pyExtraEnv: { SOURCE_DATE_EPOCH }, slotHeld: true });
      const entry = { build: rep };
      out.decks[name][profile] = entry;
      if (!rep.ok) {
        failure = rep.failure;
        failedAt = { name, profile, lines: q.buf, exitCode: rep.exitCode };
        break;
      }
      counts[name].push(rep.slideCount);
      const irFile = path.join(deck.real, '.build', profile, 'ir.json');
      const ir = JSON.parse(fs.readFileSync(irFile, 'utf8'));
      const goldenFile = path.join(GOLDEN_DIR, `${name}.${profile}.ir.json`);
      if (updateGolden) {
        fs.writeFileSync(goldenFile, `${JSON.stringify(ir, null, 1)}\n`);
        entry.golden = { status: 'updated', file: path.relative(KIT, goldenFile) };
        continue;
      }
      let golden = null;
      try {
        golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
      } catch {
        golden = null;
      }
      if (!golden) {
        entry.golden = { status: 'drift', numericLeaves: 0, maxDelta: 0, lintSetChanged: true, differences: [`no golden file ${path.relative(KIT, goldenFile)}`] };
        agg.differences++;
        agg.lintSetChanged = true;
        continue;
      }
      const cmp = compareIr(golden, ir);
      const buildDrift = (rep.warnings || []).length > 0;
      const drift = cmp.diffCount > 0 || cmp.lintSetChanged || buildDrift;
      entry.golden = {
        status: drift ? 'drift' : 'match', numericLeaves: cmp.numericLeaves, maxDelta: cmp.maxDelta, lintSetChanged: cmp.lintSetChanged,
        differences: [...cmp.differences, ...(rep.warnings || []).map((w) => `build drift: ${w}`)].slice(0, 20),
      };
      agg.maxDelta = Math.max(agg.maxDelta, cmp.maxDelta);
      agg.differences += cmp.diffCount + (buildDrift ? rep.warnings.length : 0);
      agg.driftLeaves += cmp.driftLeaves;
      agg.lintSetChanged = agg.lintSetChanged || cmp.lintSetChanged;
      agg.buildDrift = agg.buildDrift || buildDrift;
    }
    if (failure) break;
  }
  if (keep) {
    try {
      fs.mkdirSync(keep, { recursive: true });
      for (const name of SELFTEST_DECKS) if (fs.existsSync(path.join(work, name))) copyDir(path.join(work, name), path.join(path.resolve(keep), name));
    } catch (e) {
      printer.line(`deck converter selftest: warning: --keep ${keep} failed (${e.message})`);
    }
  }
  out.durationMs = Date.now() - t0;
  const ver = chromium.version || 'unknown';
  if (failure) {
    out.status = 'fail';
    out.failure = failure;
    out.exitCode = failedAt.exitCode;
    printer.line(`deck converter selftest: FAIL (Chromium ${ver}; ${failedAt.name} ${failedAt.profile}: ${failure.class})`);
    printer.lines(failedAt.lines.slice(-30));
    return out;
  }
  const shape = SELFTEST_DECKS.map((n) => `${n} ${counts[n].join('+')} slides`).join(', ');
  if (updateGolden) {
    out.ok = true;
    out.status = 'pass';
    out.exitCode = 0;
    printer.line(`deck converter selftest: PASS (Chromium ${ver}; ${shape}; golden files UPDATED in ${disp(GOLDEN_DIR)} — commit them after a PowerPoint spot-check)`);
    return out;
  }
  const drift = agg.differences > 0 || agg.lintSetChanged;
  out.status = drift ? 'drift' : 'pass';
  out.ok = !drift || !failOnDrift;
  const rec = {
    format: 'noah-deck-selftest-record', version: 1, status: drift ? 'drift' : 'pass', converterVersion: VERSION,
    chromiumVersion: chromium.version, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), maxDelta: agg.maxDelta,
    differences: agg.differences, lintSetChanged: agg.lintSetChanged,
  };
  out.record = rec;
  if (record) writeJsonFile(path.resolve(record), rec);
  if (!drift) {
    out.exitCode = 0;
    printer.line(`deck converter selftest: PASS (Chromium ${ver}; ${shape}; golden match)`);
    return out;
  }
  printer.line(`deck converter selftest: DRIFT (Chromium ${ver}; max Δ ${agg.maxDelta} px on ${agg.driftLeaves} leaves; lint set changed: ${agg.lintSetChanged ? 'yes' : 'no'}) — recorded in ${record || '(no --record file)'}. Decks still pass every integrity gate. Maintainers: see README.md#deck-converter-golden-drift (verify in PowerPoint, then run "bash default-skills/skills/pptx/scripts/deck.sh selftest --update-golden" on a dev box, commit, rebuild the image).`);
  for (const name of SELFTEST_DECKS) {
    for (const profile of profiles) {
      const g = out.decks[name][profile] && out.decks[name][profile].golden;
      if (g && g.status === 'drift') for (const d of g.differences.slice(0, 5)) printer.line(`  ${name} ${profile}: ${d}`);
    }
  }
  if (failOnDrift) {
    const f = new DeckFailure('drift', 'the self-test IR differs from the golden files (--fail-on-drift).', { stage: 'selftest', next: NEXT.drift() });
    printer.lines(footerLines(f));
    out.failure = { class: f.cls, stage: f.stage, message: f.message, next: f.next };
    out.exitCode = exitCodeOf(f);
  } else {
    out.exitCode = 0;
  }
  return out;
}
