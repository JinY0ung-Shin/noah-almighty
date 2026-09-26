// The toolchain as FACTS for an administrator (never commands): shared by `probe` and by check/build/selftest, so
// every surface reports the same missing pieces. Never launches a browser.
import fs from 'node:fs';
import path from 'node:path';
import { KIT } from './deckfs.mjs';
import { chromiumVersion, playwrightCoreInfo, probePython, resolveChromium } from '../extract/chromium.mjs';

export const DEFAULT_SELFTEST_RECORD = '/usr/local/share/noah-almighty/deck-selftest.json';

/** The build-time self-test record: {status: pass|drift|disabled|not-recorded, chromiumVersion?, at?, ...}. */
export function readSelftestRecord(env = process.env) {
  const file = env.NOAH_PPTX_SELFTEST_RECORD || DEFAULT_SELFTEST_RECORD;
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { status: 'not-recorded' };
  }
  if (!j || j.format !== 'noah-deck-selftest-record' || !['pass', 'drift', 'disabled'].includes(j.status)) return { status: 'not-recorded' };
  const out = { status: j.status };
  for (const k of ['chromiumVersion', 'at', 'maxDelta', 'differences', 'lintSetChanged', 'converterVersion']) if (j[k] !== undefined) out[k] = j[k];
  return out;
}

/** Every file a profile needs: fonts.json faces (file / measureFile) and the url()s of theme/fonts-<p>.css. */
export function fontsPresent() {
  const out = { embedded: false, malgun: false };
  let fj = null;
  try {
    fj = JSON.parse(fs.readFileSync(path.join(KIT, 'fonts', 'fonts.json'), 'utf8'));
  } catch {
    return out;
  }
  for (const p of Object.keys(out)) {
    const prof = fj.profiles && fj.profiles[p];
    if (!prof) continue;
    const files = new Set();
    for (const f of prof.faces || []) {
      if (f.file) files.add(path.join(KIT, f.file));
      if (f.measureFile) files.add(path.join(KIT, f.measureFile));
    }
    let css = '';
    try {
      css = fs.readFileSync(path.join(KIT, 'theme', `fonts-${p}.css`), 'utf8');
    } catch {
      continue;
    }
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) files.add(path.resolve(KIT, 'theme', m[1]));
    out[p] = [...files].every((f) => {
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    });
  }
  return out;
}

/**
 * -> {missing: [facts], chromium: {ok, path, source, version, error?}, playwrightCore, python, fonts, record}.
 * `withVersion` runs `<chromium> --version` (probe); check/build skip it (the extractor reports a start failure).
 */
export function toolchainFacts(env = process.env, { withVersion = false } = {}) {
  const missing = [];
  const record = readSelftestRecord(env);
  if (record.status === 'disabled') missing.push('the image was built without the converter (DECK_CONVERTER=0)');
  const c = resolveChromium(env);
  const chromium = { ok: c.ok, path: c.path || null, source: c.source || null, version: null };
  if (!c.ok) missing.push(c.error);
  else if (withVersion) {
    chromium.version = chromiumVersion(c.path);
    if (!chromium.version) {
      chromium.ok = false;
      missing.push(`Chromium at ${c.path} did not report a version (it does not start)`);
    }
  }
  const pw = playwrightCoreInfo();
  if (!pw.ok) missing.push('playwright-core is not resolvable from the converter directory (DEFAULT_PLUGINS_DIR is outside the app tree)');
  const py = probePython(env);
  if (!py.ok) missing.push(py.error);
  const fonts = fontsPresent();
  for (const p of ['embedded', 'malgun']) if (!fonts[p]) missing.push(`fonts for profile ${p} are missing`);
  return { missing, chromium, playwrightCore: { ok: pw.ok, version: pw.version }, python: py, fonts, record };
}
