// The ONE resolver for the converter's toolchain: Chromium, playwright-core and Python. Used by extract.mjs,
// `deck.mjs probe` and `deck.mjs selftest` (docs/CONTRACT.md "Toolchain"). Never downloads anything.
//
// Chromium, first hit wins:
//   1. NOAH_PPTX_CHROMIUM            must be an executable file, else a toolchain error names the variable
//   2. /usr/lib/chromium/chromium-headless-shell      (Debian package chromium-headless-shell)
//   3. /usr/lib/chromium/chromium                     (Debian package chromium)
//   4. only with NOAH_PPTX_DEV=1: playwright-core's chromium.executablePath(), if that file exists (a dev box's
//      ~/.cache/ms-playwright) — so a browser an agent downloads into $HOME/.cache is never used in production.
// playwright-core resolves from this file's location (createRequire(import.meta.url) walks up to the app's
// node_modules). Python = NOAH_PPTX_PYTHON or python3.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
/** This file's directory: part of the read-only toolkit (root-owned in the image). */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEBIAN_HEADLESS_SHELL = '/usr/lib/chromium/chromium-headless-shell';
export const DEBIAN_CHROMIUM = '/usr/lib/chromium/chromium';
export const PYTHON_MODULES = ['pptx', 'lxml', 'PIL', 'fontTools', 'defusedxml', 'openpyxl', 'xlsxwriter'];
export const PYTHON_MIN = [3, 10];

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

let PW = null;
let PW_ERROR = null;

/** playwright-core, resolved from the converter directory; null (+ loadPlaywrightError()) when unresolvable. */
export function loadPlaywright() {
  if (PW || PW_ERROR) return PW;
  try {
    PW = require('playwright-core');
  } catch (e) {
    PW_ERROR = e;
  }
  return PW;
}

export function loadPlaywrightError() {
  return PW_ERROR;
}

/** {ok, version} of playwright-core without loading it (package.json only). */
export function playwrightCoreInfo() {
  try {
    const pj = require.resolve('playwright-core/package.json');
    const v = JSON.parse(fs.readFileSync(pj, 'utf8')).version;
    return { ok: true, version: String(v) };
  } catch {
    return { ok: false, version: null };
  }
}

/**
 * {ok, path, source, error}. `error` is an English FACT for an administrator (never an install command).
 */
export function resolveChromium(env = process.env) {
  const explicit = env.NOAH_PPTX_CHROMIUM;
  if (explicit !== undefined && explicit !== '') {
    if (isExecutableFile(explicit)) return { ok: true, path: explicit, source: 'env' };
    return { ok: false, path: explicit, source: 'env', error: `NOAH_PPTX_CHROMIUM (${explicit}) is not an executable file` };
  }
  if (isExecutableFile(DEBIAN_HEADLESS_SHELL)) return { ok: true, path: DEBIAN_HEADLESS_SHELL, source: 'debian-headless-shell' };
  if (isExecutableFile(DEBIAN_CHROMIUM)) return { ok: true, path: DEBIAN_CHROMIUM, source: 'debian-chromium' };
  if (env.NOAH_PPTX_DEV === '1') {
    const pw = loadPlaywright();
    let p = null;
    try {
      p = pw ? pw.chromium.executablePath() : null;
    } catch {
      p = null;
    }
    if (p && isExecutableFile(p)) return { ok: true, path: p, source: 'playwright-cache' };
    return { ok: false, path: p, source: 'playwright-cache', error: 'Chromium headless shell is not installed in this image (NOAH_PPTX_DEV=1: no Playwright-cache browser either)' };
  }
  return { ok: false, path: null, source: null, error: 'Chromium headless shell is not installed in this image' };
}

/** `<exe> --version` (5 s) -> "154.0.8037.57" or null. */
export function chromiumVersion(exe) {
  if (!exe) return null;
  try {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    const m = `${r.stdout || ''} ${r.stderr || ''}`.match(/\d+\.\d+\.\d+\.\d+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

export function pythonExecutable(env = process.env) {
  return env.NOAH_PPTX_PYTHON && env.NOAH_PPTX_PYTHON.trim() ? env.NOAH_PPTX_PYTHON.trim() : 'python3';
}

/** Environment for every Python child: no bytecode, no user site, HOME/TMPDIR = the run temp dir. */
export function pythonEnv(base, runTmp) {
  const env = { ...base, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' };
  if (runTmp) {
    env.HOME = runTmp;
    env.TMPDIR = runTmp;
  }
  return env;
}

const PY_PROBE = [
  'import importlib.util, json, sys',
  `mods = ${JSON.stringify(PYTHON_MODULES)}`,
  'missing = [m for m in mods if importlib.util.find_spec(m) is None]',
  "print(json.dumps({'version': '.'.join(map(str, sys.version_info[:3])), 'missing': missing}))",
].join('\n');

/**
 * {ok, executable, version, missingModules, error}: find_spec only (no imports), Python >= 3.10.
 * `python -c` would put the CURRENT directory first on sys.path — the agent's cwd, often an open repository — so a
 * json.py there would run, and a pptx/ folder there would pass for python-pptx. Isolated mode (-I: no cwd/script
 * dir on sys.path, no PYTHON* variables, no user site) from a toolkit directory as cwd; -B because -I also ignores
 * PYTHONDONTWRITEBYTECODE. The pipeline's own Python children run scripts by path: their sys.path[0] is that
 * script's directory inside the toolkit, never the cwd.
 */
export function probePython(env = process.env, runTmp = null) {
  const exe = pythonExecutable(env);
  const out = { ok: false, executable: exe, version: null, missingModules: [] };
  let r;
  try {
    r = spawnSync(exe, ['-I', '-B', '-c', PY_PROBE], { encoding: 'utf8', timeout: 8000, cwd: HERE, env: pythonEnv(env, runTmp), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return { ...out, error: `Python is not runnable (${exe}): ${e.message}` };
  }
  if (r.error) return { ...out, error: `Python is not runnable (${exe}): ${r.error.code || r.error.message}` };
  let j = null;
  try {
    j = JSON.parse(String(r.stdout || '').trim().split('\n').pop());
  } catch {
    j = null;
  }
  if (!j || r.status !== 0) return { ...out, error: `Python did not answer the module probe (${exe}, exit ${r.status})` };
  out.version = j.version;
  out.missingModules = j.missing;
  const [maj, min] = String(j.version).split('.').map(Number);
  if (maj < PYTHON_MIN[0] || (maj === PYTHON_MIN[0] && min < PYTHON_MIN[1])) {
    return { ...out, error: `Python ${j.version} is older than ${PYTHON_MIN.join('.')} (${exe})` };
  }
  if (j.missing.length) return { ...out, error: `Python modules missing: ${j.missing.join(', ')} (${exe})` };
  out.ok = true;
  return out;
}
