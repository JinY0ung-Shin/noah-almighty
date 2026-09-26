// The build gates (D12): parallel Python children with a shared deadline, statuses pass|warn|fail|crash|skip|timeout
// (and cancelled: stopped by the run's cancellation — the pipeline then reports the whole run as cancelled).
// Integrity failures BLOCK (status fail); drift WARNS (status warn, blocks only with --strict) and is exactly: fidelity
// problems outside BLOCKING_FIDELITY_CHECKS, office-rules WARN, builder warnings. Other gates' warnings (chart-lint,
// indep-check, font-coverage, inspect — e.g. inspect's large-picture note on a photo slide) are informational: listed
// in the gate's items, never drift. A crashed gate is class internal, a gate killed at its deadline class timeout.
// docs/CONTRACT.md "Gates" lists what each one checks.
import fs from 'node:fs';
import path from 'node:path';
import { KIT } from './deckfs.mjs';

/** Fidelity check names that mean a missing, unmapped or hidden object: BLOCKING. Every other check is drift. */
export const BLOCKING_FIDELITY_CHECKS = new Set([
  'map', 'unmapped', 'missing', 'object', 'hidden', 'layout-chrome', 'overlay', 'picture', 'chart', 'paint-order',
]);

export const GATE_ORDER = ['office-rules', 'shape-table-lint', 'chart-verify', 'chart-lint', 'embed-verify', 'indep-check', 'font-coverage', 'inspect'];

const T = (...p) => path.join(KIT, 'tools', ...p);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function crashed(r) {
  return /Traceback \(most recent call last\)/.test(`${r.stderr}\n${r.stdout}`);
}

function lastLine(s) {
  const l = String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  return l.length ? l[l.length - 1].slice(0, 300) : '';
}

/**
 * The gate commands for one candidate deck. ctx = {py, pptx, ir, profile, map, work (dir for JSON outputs),
 * buildDir, fontsJson}. Each entry: {name, blocking, argv | skip, parse(r, jsonFile) -> {status, detail, items}}.
 */
export function gateSpecs(ctx) {
  const { pptx, ir, profile, work, buildDir } = ctx;
  const J = (n) => path.join(work, `${n}.json`);
  const prof = ctx.fontsJson.profiles[profile];
  const fontArgs = prof.embed ? prof.faces.filter((f) => f.file).flatMap((f) => ['--font', `${f.typeface}:${f.slot}:${path.join(KIT, f.file)}`]) : [];
  return [
    {
      name: 'office-rules', argv: [T('office_check.py'), pptx, '--no-info', '--quiet', '--json', J('office-rules')],
      parse: (r) => {
        const j = readJson(J('office-rules'));
        const o = Array.isArray(j) ? j[0] : null;
        if (!o || !o.summary) return null;
        const fails = (o.findings || []).filter((f) => f.severity === 'FAIL');
        const warns = (o.findings || []).filter((f) => f.severity === 'WARN');
        const items = [...fails, ...warns].slice(0, 40).map((f) => `${f.severity} ${f.check} ${f.part}: ${f.detail}`);
        return { status: fails.length ? 'fail' : warns.length ? 'warn' : 'pass', detail: `${o.summary.fail} FAIL / ${o.summary.warn} WARN`, items };
      },
    },
    {
      name: 'shape-table-lint', argv: [T('gates', 'shape_table_lint.py'), pptx, '--json', J('shape-table-lint')],
      parse: () => {
        const j = readJson(J('shape-table-lint'));
        if (!j || !Array.isArray(j.problems)) return null;
        return { status: j.problems.length ? 'fail' : 'pass', detail: `${j.problems.length} problem(s)`, items: j.problems.slice(0, 40) };
      },
    },
    {
      name: 'chart-verify', argv: [T('gates', 'chart_verify.py'), pptx, '--json', J('chart-verify')],
      parse: () => {
        const j = readJson(J('chart-verify'));
        if (!j || !Array.isArray(j.failures)) return null;
        return { status: j.failures.length ? 'fail' : 'pass', detail: `${j.charts} chart(s), ${j.failures.length} failure(s)`, items: j.failures.slice(0, 40) };
      },
    },
    {
      name: 'chart-lint', argv: [T('gates', 'chart_lint.py'), pptx, '--json', J('chart-lint')],
      parse: () => {
        const j = readJson(J('chart-lint'));
        if (!j || !Array.isArray(j.charts)) return null;
        const e = j.charts.reduce((s, c) => s + c.errors, 0), w = j.charts.reduce((s, c) => s + c.warnings, 0);
        const items = j.charts.flatMap((c) => c.items.map((i) => `${i.severity} ${c.part} [${i.rule}] ${i.message}`)).slice(0, 40);
        return { status: e ? 'fail' : 'pass', detail: j.charts.length ? `${j.charts.length} chart part(s), ${e} error(s), ${w} warning(s)` : 'no chart parts', items };
      },
    },
    prof.embed ? {
      name: 'embed-verify', argv: [T('embed_fonts.py'), '--verify', pptx, '--profile', profile],
      parse: (r) => {
        let j = null;
        try {
          j = JSON.parse(r.stdout);
        } catch {
          j = null;
        }
        if (!j || !Array.isArray(j.problems)) return null;
        return { status: j.problems.length ? 'fail' : 'pass', detail: `${j.problems.length} problem(s)`, items: j.problems.slice(0, 40) };
      },
    } : { name: 'embed-verify', skip: 'embedded profile only' },
    prof.embed ? {
      name: 'indep-check', argv: [T('gates', 'indep_check.py'), pptx, '--quiet', '--json', J('indep-check'), ...fontArgs],
      parse: () => {
        const j = readJson(J('indep-check'));
        if (!j || !j.summary) return null;
        const errs = (j.items || []).filter((i) => i.level === 'ERROR');
        // WARN = "deviates from what PowerPoint writes / unproven" (e.g. the documented EOT charset choice): reported,
        // not drift (the PoC gate passed on exit 0 too)
        return { status: errs.length ? 'fail' : 'pass', detail: `${j.summary.ERROR || 0} ERROR / ${j.summary.WARN || 0} WARN`, items: errs.slice(0, 40).map((i) => `${i.where}: ${i.msg}`) };
      },
    } : { name: 'indep-check', skip: 'embedded profile only' },
    {
      name: 'font-coverage', argv: [T('inspect_pptx.py'), pptx, '--profile', profile, '--fonts-only', '--out-json', J('font-coverage')],
      parse: () => {
        const j = readJson(J('font-coverage'));
        if (!j || !Array.isArray(j.problems)) return null;
        const e = j.problems.filter((p) => p.severity === 'error'), w = j.problems.filter((p) => p.severity === 'warn');
        return { status: e.length ? 'fail' : 'pass', detail: `${e.length} error(s), ${w.length} warning(s)`, items: [...e, ...w].slice(0, 40).map((p) => `${p.severity} [${p.rule}] ${p.message}`) };
      },
    },
    {
      name: 'inspect', argv: [T('inspect_pptx.py'), pptx, '--ir', ir, '--profile', profile, '--quiet', '--out-json', path.join(buildDir, 'inspect.json')],
      parse: () => {
        const j = readJson(path.join(buildDir, 'inspect.json'));
        if (!j || !j.summary) return null;
        const e = (j.problems || []).filter((p) => p.severity === 'error'), w = (j.problems || []).filter((p) => p.severity === 'warn');
        return { status: e.length ? 'fail' : 'pass', detail: `${e.length} error(s), ${w.length} warning(s)`, items: [...e, ...w].slice(0, 40).map((p) => `${p.severity} [${p.rule}] ${p.message}`) };
      },
    },
  ];
}

/** Run one gate child and classify it. */
async function runGate(children, spec, { py, env, deadlineMs, logDir }) {
  if (spec.skip) return { name: spec.name, status: 'skip', blocking: true, detail: spec.skip, ms: 0, items: [] };
  const r = await children.run(py, spec.argv, { env, deadlineMs, log: path.join(logDir, `gate-${spec.name}.log`) });
  const base = { name: spec.name, blocking: true, ms: r.ms };
  if (r.timedOut) return { ...base, status: 'timeout', detail: `killed at the gate deadline (${Math.round(deadlineMs / 1000)} s)`, items: [] };
  // stopped by the run's cancellation or by a signal to the process group: no verdict (the pipeline reports the
  // run as cancelled, never as a crash)
  if (r.cancelled || r.interrupted) return { ...base, status: 'cancelled', detail: r.interrupted ? `stopped by ${r.interrupted}` : 'cancelled', items: [] };
  if (r.spawnError) return { ...base, status: 'crash', detail: `could not start: ${r.spawnError}`, items: [] };
  let parsed = null;
  try {
    parsed = spec.parse(r);
  } catch {
    parsed = null;
  }
  if (!parsed || crashed(r) || (r.code !== 0 && r.code !== 1)) {
    return { ...base, status: 'crash', detail: `crashed (exit ${r.code === null ? `signal ${r.signal}` : r.code}): ${lastLine(r.stderr) || lastLine(r.stdout) || 'no output'}`, items: [] };
  }
  // a gate that says "fail" must also have exited non-zero, and vice versa (else its output is not trustworthy)
  if ((parsed.status === 'fail') !== (r.code === 1)) {
    return { ...base, status: 'crash', detail: `exit ${r.code} disagrees with its report (${parsed.detail})`, items: [] };
  }
  return { ...base, ...parsed };
}

/** All gates in parallel with one deadline -> [gate result] in GATE_ORDER. */
export async function runGates(children, ctx, { env, deadlineMs, logDir }) {
  fs.mkdirSync(ctx.work, { recursive: true });
  // never score a gate from a previous run's report (the gates/ dir is per run; inspect.json lives in .build/<p>/)
  fs.rmSync(path.join(ctx.buildDir, 'inspect.json'), { force: true });
  const specs = gateSpecs(ctx);
  const res = await Promise.all(specs.map((s) => runGate(children, s, { py: ctx.py, env, deadlineMs, logDir })));
  return GATE_ORDER.map((n) => res.find((g) => g.name === n)).filter(Boolean);
}

/** The structure fidelity gate -> {status, checks, problems, blocking[], drift[], items} (+ crash/timeout). */
export async function runFidelity(children, ctx, { env, deadlineMs, logDir }) {
  const out = path.join(ctx.buildDir, 'fidelity.json');
  try {
    fs.rmSync(out, { force: true });
  } catch {
    /* ignore */
  }
  const argv = [T('check_fidelity.py'), 'structure', ctx.pptx, '--ir', ctx.ir, '--profile', ctx.profile, '--map', ctx.map, '--json', out];
  const r = await children.run(ctx.py, argv, { env, deadlineMs, log: path.join(logDir, 'fidelity.log') });
  if (r.timedOut) return { status: 'timeout', checks: 0, problems: 0, items: [], ms: r.ms, detail: `killed at the stage deadline (${Math.round(deadlineMs / 1000)} s)` };
  if (r.cancelled || r.interrupted) return { status: 'cancelled', checks: 0, problems: 0, items: [], ms: r.ms, detail: r.interrupted ? `stopped by ${r.interrupted}` : 'cancelled' };
  const j = readJson(out);
  if (!j || !Array.isArray(j.problems) || crashed(r) || (r.code !== 0 && r.code !== 1)) {
    return { status: 'crash', checks: 0, problems: 0, items: [], ms: r.ms, detail: `crashed (exit ${r.code === null ? `signal ${r.signal}` : r.code}): ${lastLine(r.stderr) || lastLine(r.stdout) || 'no output'}` };
  }
  const blocking = j.problems.filter((p) => BLOCKING_FIDELITY_CHECKS.has(p.check));
  const drift = j.problems.filter((p) => !BLOCKING_FIDELITY_CHECKS.has(p.check));
  const items = [...blocking, ...drift].slice(0, 40).map((p) => ({ slide: p.slide, check: p.check, ir: p.ir, message: p.message, blocking: BLOCKING_FIDELITY_CHECKS.has(p.check) }));
  return {
    status: blocking.length ? 'fail' : drift.length ? 'warn' : 'pass', checks: j.checks, problems: j.problems.length,
    blockingProblems: blocking.length, driftProblems: drift.length, items, ms: r.ms,
  };
}
