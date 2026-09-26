#!/usr/bin/env node
// HTML slides -> IR (docs/CONTRACT.md) for tools/build_pptx.py. Normally run by tools/deck.mjs, not by hand.
//
//   node tools/extract.mjs --deck <dir> --profile <embedded|malgun> [--out <dir>] [--only NN-name ...] [--fast]
//                          [--strict] [--no-verify] [--timeout <s>] [--result <file>]
//
// Options:
//   --deck <dir>        the deck folder: slides/NN-*.html (numeric order), optional deck.css and assets/
//   --out <dir>         IR directory (default <deck>/.build/<profile>); ir.json, html/*.png, assets/*
//   --only <names…>     extract only these slides (NN-name), each keeping its deck index
//   --fast              check mode: no DSF-2 reference and no isolated image rasters (images get no src)
//   --strict            exit 1 when the lint has errors (the IR is written either way)
//   --no-verify         skip the in-place baseline verification probes
//   --timeout <s>       per-wait timeout (default 20)
//   --result <file>     write {"ok", "class", "message", "slide"} there (success or failure)
// Every IR path is relative to the IR directory (CONTRACT "IR path convention").
// Exit codes: 0 ok, 1 authoring (lint errors with --strict, charts never ready, no main.slide, a deck font that
// did not load), 2 usage, 3 conversion (a slide page crashed), 4 toolchain / internal, 6 timeout, 130/143 cancelled
// (a signal or the parent went away; the result's class is then "cancelled").
import fs from 'node:fs';
import path from 'node:path';
import { launch, openSlide, platformFonts, rasterize, rasterPlan, sourceMediaType, inpageSource, withTimeout, isCrash, isPlaywrightTimeout, EVALUATE_TIMEOUT_MS, ExtractError } from './extract/browser.mjs';
import { agentFamily, familyLabels, familyList, profileFaces, uncovered, notIn } from './extract/cmap.mjs';
import { resolveUrlPath } from './extract/server.mjs';
import { KIT, listSlides, limitsFromEnv, relPosix } from './lib/deckfs.mjs';
import { watchParent } from './lib/proc.mjs';

const SLIDE = { w: 1280, h: 720 };
const EXIT = { authoring: 1, usage: 2, conversion: 3, toolchain: 4, internal: 4, timeout: 6 };

let RESULT_FILE = null;
let BROWSER = null;
let LAUNCHING = null;   // the in-flight chromium.launch (a shutdown waits for it, then closes that browser)
let CLOSING = false;    // main() is closing the browser itself
let BROWSER_LOST = false; // the browser disconnected on its own (OOM kill, crash) while slides were being rendered
let CURRENT = null;     // {index, rel} of the slide being rendered
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

function writeResult(obj) {
  if (!RESULT_FILE) return;
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify(obj) + '\n');
  } catch {
    /* the parent treats a missing result as internal */
  }
}

function fail(cls, message, slide = null) {
  writeResult({ ok: false, class: cls, message, slide });
  console.error(`extract: FAILED (${cls})\n${message}`);
  exitNow(EXIT[cls] ?? 4);
}

/**
 * Exit; when deck.mjs died (SIGKILL) remove its run temp dir first — this is the last process of that run (the browser
 * is closed by then). Retried: a Chromium that is still exiting may briefly recreate its profile inside it.
 */
function exitNow(code) {
  const t = process.env.TMPDIR || '';
  if (process.ppid !== PPID0 && new RegExp(`^noah-pptx-run-${PPID0}-[0-9a-f]+$`).test(path.basename(t))) {
    for (let i = 0; i < 15; i++) {
      try {
        fs.rmSync(t, { recursive: true, force: true });
      } catch {
        /* retried; the next run's startup sweep removes a leftover */
      }
      Atomics.wait(SLEEP, 0, 0, 200);
      if (!fs.existsSync(t)) break;
    }
  }
  process.exit(code);
}

function usage(msg) {
  const u = 'usage: node tools/extract.mjs --deck <dir> --profile <embedded|malgun> [--out <dir>] [--only NN-name ...] [--fast] [--strict] [--no-verify] [--timeout s] [--result file]';
  if (!msg) {
    console.log(u);
    process.exit(0);
  }
  fail('usage', `extract: ${msg}\n${u}`);
}

function parseArgs(argv) {
  const a = { deck: null, profile: null, out: null, only: [], fast: false, strict: false, verify: true, timeout: 20, result: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) usage(`${t} needs a value`);
      return argv[++i];
    };
    if (t === '--deck') a.deck = val();
    else if (t === '--profile') a.profile = val();
    else if (t === '--out') a.out = val();
    else if (t === '--only') { while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) a.only.push(argv[++i]); }
    else if (t === '--fast') a.fast = true;
    else if (t === '--strict') a.strict = true;
    else if (t === '--no-verify') a.verify = false;
    else if (t === '--timeout') a.timeout = Number(val());
    else if (t === '--result') a.result = val();
    else if (t === '-h' || t === '--help') usage();
    else usage(`unknown argument ${t}`);
  }
  RESULT_FILE = a.result ? path.resolve(a.result) : null;
  if (!a.deck) usage('--deck is required');
  if (!a.profile) usage('--profile is required');
  if (!Number.isFinite(a.timeout) || a.timeout <= 0) usage('--timeout must be a positive number of seconds');
  return a;
}

/** All text an IR element will carry into PowerPoint (runs, bullet glyphs, table cells, chart labels). */
function textsOf(e) {
  const fromParas = (ps) => ps.flatMap((p) => [...p.runs.filter((r) => !r.break).map((r) => r.text), p.bullet && p.bullet.type === 'char' ? p.bullet.char : '']);
  if (e.kind === 'text') return fromParas(e.paragraphs);
  if (e.kind === 'table') return e.cells.flat().filter((c) => !c.covered).flatMap((c) => fromParas(c.paragraphs));
  if (e.kind === 'chart' && e.spec) return [...(e.spec.categories || []).map(String), ...(e.spec.series || []).map((x) => String(x.name ?? ''))];
  return [];
}

const cpList = (chars) => chars.map((c) => `"${c}" U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(', ');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deck = fs.realpathSync(path.resolve(args.deck));
  const fontsJson = JSON.parse(fs.readFileSync(path.join(KIT, 'fonts/fonts.json'), 'utf8'));
  const prof = fontsJson.profiles[args.profile];
  if (!prof) usage(`unknown profile ${args.profile} (fonts.json has ${Object.keys(fontsJson.profiles).join(', ')})`);
  if (!fs.existsSync(path.join(KIT, `theme/fonts-${args.profile}.css`))) fail('toolchain', `theme/fonts-${args.profile}.css is missing from the converter`);
  const limits = limitsFromEnv();

  const listed = listSlides(deck);
  if (listed.problems.length) fail('authoring', listed.problems.map((p) => p.message).join('\n'));
  let slides = listed.slides;
  if (args.only.length) {
    const want = new Set(args.only.map((n) => n.replace(/\.html$/, '').replace(/^slides\//, '')));
    const unknown = [...want].filter((n) => !slides.some((s) => s.name === n));
    if (unknown.length) usage(`--only: no such slide(s): ${unknown.join(', ')} (have ${slides.map((s) => s.name).join(', ')})`);
    slides = slides.filter((s) => want.has(s.name));
  }
  if (!slides.length) fail('authoring', 'no slides (slides/NN-name.html)');

  const outAbs = path.resolve(args.out || path.join(deck, '.build', args.profile));
  fs.mkdirSync(path.join(outAbs, 'html'), { recursive: true });
  fs.mkdirSync(path.join(outAbs, 'assets'), { recursive: true });
  // a full run owns html/ and assets/: drop the renders and rasters of slides that no longer exist (renamed or
  // deleted), so the folder the agent reads renders from never shows a slide the deck does not have
  if (!args.only.length) {
    const names = new Set(slides.map((s) => s.name));
    for (const [dir, re] of [['html', /^(.+?)(?:@2x)?\.png$/], ['assets', /^(.+)-img\d+\.(?:png|jpg|svg)$/]]) {
      for (const f of fs.readdirSync(path.join(outAbs, dir))) {
        const m = re.exec(f);
        if (m && names.has(m[1])) continue;
        const p = path.join(outAbs, dir, f);
        if (!fs.lstatSync(p).isDirectory()) fs.rmSync(p, { force: true });
      }
    }
  }
  const irPath = path.join(outAbs, 'ir.json');
  if (fs.existsSync(irPath)) fs.rmSync(irPath); // a failed run must never leave a stale IR behind
  const rel = (abs) => relPosix(outAbs, abs);
  const roots = { kit: KIT, deck, profile: args.profile };

  const source = inpageSource();
  // agent-facing names of the CSS families (the malgun stand-in is never "the profile font": cmap.mjs familyLabels)
  const labels = familyLabels(fontsJson);
  const opts = {
    cssFamily: prof.cssFamily,
    familyLabels: labels,
    faceWeights: prof.faces.map((f) => f.cssWeight),
    // every weight some profile has a face for (400/600/700/800): anything else is an authoring error
    kitWeights: [...new Set(Object.values(fontsJson.profiles).flatMap((p) => p.faces.map((f) => f.cssWeight)))].sort((a, b) => a - b),
    hasItalic: prof.faces.some((f) => f.italic),
    verifyBaselines: args.verify,
    slideW: SLIDE.w,
    slideH: SLIDE.h,
  };
  const timeoutMs = Math.max(1, args.timeout) * 1000;
  const cssFaces = profileFaces(KIT, args.profile).filter((f) => f.family === prof.cssFamily);
  const embedFiles = prof.embed ? prof.faces.filter((f) => f.file).map((f) => path.join(KIT, f.file)) : null;
  LAUNCHING = launch({ runTmp: process.env.TMPDIR || null });
  BROWSER = await LAUNCHING;
  LAUNCHING = null;
  if (SHUTTING_DOWN) return;
  // the browser going away on its own (the kernel's OOM killer, a crash) is the slide's problem, not ours
  BROWSER.on('disconnected', () => { if (!CLOSING && !SHUTTING_DOWN) BROWSER_LOST = true; });
  const ir = { version: 1, profile: args.profile, slideSizePx: { w: SLIDE.w, h: SLIDE.h }, theme: null, slides: [], lint: [] };
  try {
    for (const sl of slides) {
      const abs = sl.file;
      const srcRel = sl.rel;                     // deck-relative (served path)
      const name = sl.name;
      const index = sl.index;
      CURRENT = { index, rel: srcRel };
      const lint = [];
      const L = (severity, rule, message, p = null) => lint.push({ slide: index, severity, rule, message, path: p });
      for (const f of fs.readdirSync(path.join(outAbs, 'assets'))) if (f.startsWith(`${name}-`)) fs.rmSync(path.join(outAbs, 'assets', f));
      const png1Abs = path.join(outAbs, 'html', `${name}.png`);
      const png2Abs = path.join(outAbs, 'html', `${name}@2x.png`);
      for (const p of [png1Abs, png2Abs]) if (fs.existsSync(p)) fs.rmSync(p);

      // ---- DSF 1: fonts verified -> reference PNG -> extraction
      const s1 = await openSlide(BROWSER, { ...roots, rel: srcRel, dsf: 1, timeoutMs, source, slide: index, cssAgent: true, familyLabels: labels });
      const { page } = s1;
      // document-level lints (scripts, stylesheets, remote URLs, DOM size) and the CSP's own violation reports
      const docLint = await withTimeout(page, EVALUATE_TIMEOUT_MS, `${srcRel}: document lint`, () => page.evaluate((o) => window.__pptx.documentLint(o), { maxDomElements: limits.maxDomElements }), index);
      const csp = await page.evaluate(() => window.__pptxCsp || []);
      const unq = (f) => String(f).replace(/"/g, '');
      const nonProfile = new Map();
      for (const u of s1.fonts.unmatched) {
        const e = nonProfile.get(u.fontFamily) || { ...u, n: 0 };
        e.n++;
        nonProfile.set(u.fontFamily, e);
      }
      for (const u of nonProfile.values()) {
        // the first family is the one without a face; the rest of the computed list would print the kit's internal
        // family names (var(--font-sans) expanded), so it is elided
        const fams = familyList(u.fontFamily);
        L('warn', 'non-profile-font', `text rendered with font-family ${agentFamily(fams[0], labels)}${fams.length > 1 ? ', …' : ''} (no @font-face for its first family), e.g. "${u.sample}"${u.n > 1 ? ` (${u.n} style groups)` : ''}`, u.path);
      }
      // system fonts that drew glyphs, one entry per family (first element + counts)
      const pf = await withTimeout(page, EVALUATE_TIMEOUT_MS, `${srcRel}: the platform-font check`, () => platformFonts(page, s1.cdp), index);
      const fallback = new Map();
      pf.forEach((fonts, k) => {
        for (const f of fonts) {
          if (f.isCustomFont) continue;
          const prev = fallback.get(f.familyName);
          const p = s1.fonts.textElPaths[k];
          if (prev) { prev.glyphs += f.glyphCount; prev.paths.add(p); }
          else fallback.set(f.familyName, { family: f.familyName, glyphs: f.glyphCount, path: p, paths: new Set([p]) });
        }
      });
      for (const f of fallback.values()) {
        L('warn', 'fallback-font', `${f.glyphs} glyph(s) in ${f.paths.size} element(s) rendered with the system font "${unq(f.family)}" (not covered by the profile fonts; PowerPoint will substitute differently)`, f.path);
      }
      const fp1 = await page.evaluate(() => window.__pptx.fingerprint());
      const slideEl = await page.$('main.slide');
      if (!slideEl) throw new ExtractError(`${srcRel}: no <main class="slide"> (start from the skeleton in the authoring guide)`, 'authoring', index);
      await withTimeout(page, EVALUATE_TIMEOUT_MS, `${srcRel}: the reference render`, () => slideEl.screenshot({ path: png1Abs, animations: 'disabled', caret: 'hide', scale: 'device' }), index);
      const domTooLarge = docLint.some((l) => l.rule === 'dom-size');
      const ex = domTooLarge
        ? { background: null, elements: [], notes: null, components: [], layout: null, theme: null, lint: [], images: [] }
        : await withTimeout(page, EVALUATE_TIMEOUT_MS, `${srcRel}: the extraction`, () => page.evaluate((o) => window.__pptx.extract(o), opts), index);
      const fp1b = await page.evaluate(() => window.__pptx.fingerprint());
      if (fp1b.hash !== fp1.hash) L('warn', 'extractor-restore', 'the page layout changed after extraction (measurement probes were not fully undone)');
      // request timing is not deterministic: dedupe + sort
      for (const u of [...new Set(s1.events.blocked)].sort()) L('error', 'blocked-request', `blocked request ${u}: the converter has no network and serves only the deck folder and the toolkit (use ../assets/<file>)`);
      for (const u of [...new Set(s1.events.missing)].sort()) L('error', 'missing-file', `404 ${u}`);
      for (const t of s1.events.tooLarge) L('error', 'asset-too-large', `${t.url} is ${(t.bytes / 1048576).toFixed(1)} MB; a served file may be at most ${limits.maxAssetBytes / 1048576} MB (downscale or compress it)`);
      for (const m of [...new Set(s1.events.imageTooLarge.map((t) => t.message))]) L('error', 'image-too-large', m);
      for (const e of s1.events.pageErrors) L('warn', 'page-error', e);
      const seenCsp = new Set();
      for (const v of csp) {
        const key = `${v.directive}|${v.blockedURI}`;
        if (seenCsp.has(key)) continue;
        seenCsp.add(key);
        L('error', 'csp-violation', `blocked by the converter's Content-Security-Policy (${v.directive}): ${v.blockedURI || 'inline'}${v.sample ? ` "${v.sample}"` : ''}`);
      }
      for (const l of docLint) L(l.severity, l.rule, l.message, l.path);
      await s1.ctx.close();

      // ---- images: isolated rasters (D18: scale <= 4x and <= 2560 px; JPEG for opaque JPEG photos) + SVG markup
      const jobs = [];
      let k = 0;
      const byId = new Map(ex.elements.map((e) => [e.id, e]));
      if (!args.fast) {
        for (const im of ex.images) {
          k++;
          const el = byId.get(im.id);
          const plan = rasterPlan(im.job, { opacity: el.opacity, sourceType: im.job.type === 'img' ? sourceMediaType(im.job.url, roots) : null });
          const ext = plan.format === 'jpeg' ? 'jpg' : 'png';
          const baseAbs = path.join(outAbs, 'assets', `${name}-img${k}`);
          el.src = rel(`${baseAbs}.${ext}`);
          if (im.job.type === 'svg') {
            fs.writeFileSync(`${baseAbs}.svg`, im.job.markup);
            el.svg = rel(`${baseAbs}.svg`);
          } else if (im.job.svgPath) {
            const r = resolveUrlPath(new URL(im.job.url).pathname, roots);
            if (r.file) {
              fs.copyFileSync(r.file, `${baseAbs}.svg`);
              el.svg = rel(`${baseAbs}.svg`);
            }
          }
          jobs.push({ job: im.job, outAbs: `${baseAbs}.${ext}`, id: im.id, S: plan.S, format: plan.format });
        }
        const rr = await rasterize(BROWSER, { ...roots, jobs, timeoutMs, slide: index });
        rr.forEach((r, j) => {
          const e = byId.get(jobs[j].id);
          if (Math.abs(r.cssW - e.box.w) > 0.5 || Math.abs(r.cssH - e.box.h) > 0.5) L('warn', 'image-raster', `isolated render is ${r.cssW}x${r.cssH} CSS px, element box ${e.box.w}x${e.box.h}`, e.id);
        });

        // ---- DSF 2 reference (separate context), with a layout parity check against DSF 1
        const s2 = await openSlide(BROWSER, { ...roots, rel: srcRel, dsf: 2, timeoutMs, source, slide: index, familyLabels: labels });
        const fp2 = await s2.page.evaluate(() => window.__pptx.fingerprint());
        if (fp2.hash !== fp1.hash) L('warn', 'dsf-layout', 'the DSF-2 layout differs from the DSF-1 layout (the @2x reference may not match the IR)');
        const main2 = await s2.page.$('main.slide');
        await withTimeout(s2.page, EVALUATE_TIMEOUT_MS, `${srcRel}: the @2x render`, () => main2.screenshot({ path: png2Abs, animations: 'disabled', caret: 'hide', scale: 'device' }), index);
        await s2.ctx.close();
      }

      // glyph coverage: characters no profile face has (tofu / system fallback in the HTML), and — embedded
      // profile — characters drawn by a helper face that is not embedded (PowerPoint substitutes a system font)
      for (const e of ex.elements) {
        const t = textsOf(e).join('');
        if (!t) continue;
        const miss = uncovered(t, cssFaces);
        if (miss.length) L('error', 'missing-glyph', `no profile font has a glyph for ${cpList(miss)} (tofu or a system fallback font in the HTML): use another character or the other font profile`, e.id);
        if (embedFiles) {
          const ne = notIn(t, embedFiles).filter((c) => !miss.includes(c));
          if (ne.length) L('warn', 'not-embedded-glyph', `${cpList(ne)} are not in the embedded font files; PowerPoint draws them with a system fallback font`, e.id);
        }
      }
      // text fields: PowerPoint computes the displayed value, so the HTML must already show exactly that
      for (const e of ex.elements) {
        if (e.kind !== 'text') continue;
        for (const p of e.paragraphs) {
          for (const r of p.runs) {
            if (r.break || r.field !== 'slidenum') continue;
            if (r.text.trim() !== String(index)) {
              L('error', 'field', `slide-number field shows "${r.text}", but PowerPoint displays slide ${index}'s number as "${index}" (no zero padding, no other text inside the field)`, e.id);
            }
          }
        }
      }
      if (ex.theme) {
        if (!ir.theme) ir.theme = ex.theme;
        else if (JSON.stringify(ir.theme) !== JSON.stringify(ex.theme)) L('warn', 'theme-color', 'the --pptx-* theme colours differ from the first slide\'s (the deck has one theme; the first slide\'s are used)');
      }
      for (const l of ex.lint) lint.push({ slide: index, severity: l.severity, rule: l.rule, message: l.message, path: l.path });
      ir.slides.push({
        index, name, source: rel(abs), referencePng: rel(png1Abs), referencePng2x: args.fast ? null : rel(png2Abs),
        background: ex.background, elements: ex.elements, notes: ex.notes,
        layout: ex.layout, components: ex.components,
      });
      ir.lint.push(...lint);
      const kinds = {};
      for (const e of ex.elements) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
      const nErr = lint.filter((l) => l.severity === 'error').length, nWarn = lint.length - nErr;
      console.log(`${String(index).padStart(2)} ${name}: ${ex.elements.length} elements ${JSON.stringify(kinds)}; lint ${nErr} error(s), ${nWarn} warning(s)`);
    }
  } finally {
    const b = BROWSER;
    BROWSER = null;
    CLOSING = true;
    if (b) await b.close().catch(() => {});
  }
  CURRENT = null;
  if (SHUTTING_DOWN) return; // interrupted after the last slide: the cancellation stands (shutdown() exits)
  fs.writeFileSync(irPath, JSON.stringify(ir, null, 1) + '\n');
  const errors = ir.lint.filter((l) => l.severity === 'error');
  console.log(`wrote ${irPath} (${ir.slides.length} slide(s), ${ir.lint.length} lint entries, ${errors.length} error(s))`);
  writeResult({ ok: true, class: null, message: null, slide: null, slides: ir.slides.length, lintErrors: errors.length });
  if (args.strict && errors.length) process.exit(1);
}

let SHUTTING_DOWN = false;
/**
 * A signal, or the parent went away: record the run as `cancelled` (so deck.mjs never reports it as a crash), close
 * the browser and exit 130/143. From here on the shutdown owns the exit: whatever main() is doing fails as a
 * consequence (the browser closes under it), and main() stays quiet about it.
 */
async function shutdown(code, why) {
  if (SHUTTING_DOWN) return;
  SHUTTING_DOWN = true;
  writeResult({ ok: false, class: 'cancelled', message: `interrupted (${why})`, slide: null });
  let b = BROWSER;
  BROWSER = null;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!b && LAUNCHING) b = await Promise.race([LAUNCHING.catch(() => null), wait(15000).then(() => null)]);
  if (b) await Promise.race([b.close().catch(() => {}), wait(3000)]);
  exitNow(code);
}

// the parent (deck.mjs) went away: never keep Chromium running unattended
const PPID0 = process.ppid;
watchParent(() => { shutdown(143, 'the parent process went away'); }, 1000);
// a write to the dead parent's pipe raises EPIPE: that also means the parent is gone (never an uncaught crash)
for (const s of [process.stdout, process.stderr]) s.on('error', (e) => { if (e && e.code === 'EPIPE') shutdown(143, 'the output pipe closed'); });
for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 143]]) process.on(sig, () => { shutdown(code, sig); });

main().catch((e) => {
  if (SHUTTING_DOWN) return; // shutdown() reports and exits
  const b = BROWSER;
  BROWSER = null;
  const done = () => {
    if (e instanceof ExtractError) fail(e.cls, e.message, e.slide);
    // a raw Playwright error while a slide renders: its own timeout, or the browser gone (e.g. out of memory)
    const at = CURRENT ? `${CURRENT.rel}: ` : '';
    const first = String(e && e.message ? e.message : e).split('\n')[0].slice(0, 160);
    if (CURRENT && isPlaywrightTimeout(e)) fail('timeout', `${at}a page operation did not finish in time (${first})`, CURRENT.index);
    if (CURRENT && (BROWSER_LOST || isCrash(e))) {
      fail('conversion', `${at}the browser exited while rendering the slide (it may have run out of memory: too large or complex): simplify or split it`, CURRENT.index);
    }
    fail('internal', `the extractor crashed: ${e && e.stack ? e.stack : e}`);
  };
  if (b) b.close().catch(() => {}).finally(done);
  else done();
});
