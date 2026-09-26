// Deck folder rules shared by deck.mjs and extract.mjs: the two roots, names, slide enumeration, caps and limits.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_IMAGE_PIXELS, MAX_PAGE_IMAGE_PIXELS, MAX_SERVED_BYTES } from '../extract/server.mjs';

/** KIT = the converter directory (read-only at runtime); SKILL = the pptx skill directory around it. */
export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILL = path.resolve(KIT, '..');
export const VERSION = (() => {
  try {
    return fs.readFileSync(path.join(KIT, 'VERSION'), 'utf8').trim();
  } catch {
    return '0.0.0';
  }
})();
export const GENERATOR = `noah-pptx-converter/${VERSION}`;

export const DECK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const OUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.pptx$/;
export const SLIDE_NAME_RE = /^(\d{2})-([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.html$/;
export const PROFILES = ['embedded', 'malgun'];

const MiB = 1024 * 1024;

function envInt(env, key, def, min = 1) {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isInteger(n) && n >= min ? n : def;
}

/** The converter's caps (I4 env + fixed limits); reported by `deck.mjs probe`. */
export function limitsFromEnv(env = process.env) {
  return {
    maxSlides: envInt(env, 'NOAH_PPTX_MAX_SLIDES', 60),
    maxSeconds: envInt(env, 'NOAH_PPTX_MAX_SECONDS', 540),
    maxSlideHtmlBytes: 2 * MiB,
    maxDomElements: 2500,
    maxAssetBytes: MAX_SERVED_BYTES,
    maxDeckInputBytes: 100 * MiB,
    maxConcurrent: envInt(env, 'NOAH_PPTX_MAX_CONCURRENT', 2),
    slotWaitSeconds: envInt(env, 'NOAH_PPTX_SLOT_WAIT_SECONDS', 150, 0),
    // decoded pixels (the router refuses a bigger picture before Chromium decodes it: image-too-large)
    maxImagePixels: MAX_IMAGE_PIXELS,
    maxSlideImagePixels: MAX_PAGE_IMAGE_PIXELS,
  };
}

export const MAX_PPTX_BYTES = 30 * MiB;   // share_file's per-file cap

export function isInside(child, root) {
  return child === root || child.startsWith(root + path.sep);
}

export function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** POSIX relative path from `from` (a directory) to `to`. */
export function relPosix(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

/**
 * The deck folder argument -> {abs, real, name} or {error} (usage errors: exit 2).
 * The name is the basename of the real directory (the deliverable's stem).
 */
export function resolveDeckArg(arg, cwd = process.cwd()) {
  if (!arg) return { error: 'missing <deck> folder argument' };
  const abs = path.resolve(cwd, arg);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { error: `deck folder not found: ${abs}` };
  }
  if (!st.isDirectory()) return { error: `not a directory: ${abs}` };
  const real = fs.realpathSync(abs);
  const name = path.basename(real);
  if (!DECK_NAME_RE.test(name)) {
    return { error: `the deck folder name "${name}" must be ASCII letters, digits, '.', '_' or '-' (at most 64, starting with a letter or digit); put the user-facing title in share_file's name instead` };
  }
  const skillReal = realpathOrNull(SKILL) || SKILL;
  if (isInside(real, skillReal)) {
    return { error: `the deck folder ${real} is inside the pptx skill directory (read-only): copy the example into the working directory first and build the copy` };
  }
  return { abs, real, name };
}

/**
 * slides/NN-name.html in numeric order. -> {slides: [{index, nn, name, file, rel, bytes}], problems: [{rule, message, path}]}
 * index = 1-based deck order. Names outside the pattern and duplicate NN are problems (slide-name).
 */
export function listSlides(deckReal) {
  const dir = path.join(deckReal, 'slides');
  const problems = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { slides: [], problems: [{ rule: 'slide-name', message: `no slides/ folder in ${deckReal}: write each slide as slides/NN-name.html (NN = 01, 02, …)`, path: 'slides/' }] };
  }
  const byNN = new Map();
  const slides = [];
  for (const e of entries) {
    if (!/\.html?$/i.test(e.name)) continue;
    const rel = `slides/${e.name}`;
    const m = SLIDE_NAME_RE.exec(e.name);
    if (!m || Number(m[1]) < 1) {
      problems.push({ rule: 'slide-name', message: `${rel}: slide files must be named NN-name.html (NN = 01…99, name = ASCII letters, digits, '.', '_' or '-')`, path: rel });
      continue;
    }
    const file = path.join(dir, e.name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      problems.push({ rule: 'slide-name', message: `${rel}: not readable`, path: rel });
      continue;
    }
    if (!st.isFile()) {
      problems.push({ rule: 'slide-name', message: `${rel}: not a file`, path: rel });
      continue;
    }
    const nn = Number(m[1]);
    if (byNN.has(nn)) {
      problems.push({ rule: 'slide-name', message: `${rel}: duplicate slide number ${m[1]} (also ${byNN.get(nn)})`, path: rel });
      continue;
    }
    byNN.set(nn, rel);
    slides.push({ nn, name: e.name.replace(/\.html$/, ''), file, rel, bytes: st.size });
  }
  slides.sort((a, b) => a.nn - b.nn);
  slides.forEach((s, i) => { s.index = i + 1; });
  return { slides, problems };
}

/** Bytes of the deck's inputs (slides/, deck.css, assets/), symlinked directories not followed. */
export function deckInputBytes(deckReal) {
  let total = 0;
  const walk = (p, depth) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      try {
        const t = fs.statSync(p);
        if (t.isFile()) total += t.size;
      } catch {
        /* dangling */
      }
      return;
    }
    if (st.isFile()) {
      total += st.size;
      return;
    }
    if (st.isDirectory() && depth < 32) {
      let names = [];
      try {
        names = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const n of names) walk(path.join(p, n), depth + 1);
    }
  };
  walk(path.join(deckReal, 'slides'), 0);
  walk(path.join(deckReal, 'deck.css'), 0);
  walk(path.join(deckReal, 'assets'), 0);
  return total;
}

/**
 * Pre-checks before any browser starts (authoring, exit 1): names, count, per-slide size, input size.
 * -> {slides, problems: [{rule, message, path}]}
 */
export function precheckDeck(deckReal, limits) {
  const { slides, problems } = listSlides(deckReal);
  if (!slides.length && !problems.length) {
    problems.push({ rule: 'slide-name', message: 'the deck has no slides: write each slide as slides/NN-name.html (NN = 01, 02, …)', path: 'slides/' });
  }
  if (slides.length > limits.maxSlides) {
    problems.push({ rule: 'slide-count', message: `the deck has ${slides.length} slides; the limit is ${limits.maxSlides} per build (split the deck into two builds)`, path: 'slides/' });
  }
  for (const s of slides) {
    if (s.bytes > limits.maxSlideHtmlBytes) {
      problems.push({ rule: 'slide-too-large', message: `${s.rel} is ${(s.bytes / MiB).toFixed(1)} MB; a slide's HTML may be at most ${limits.maxSlideHtmlBytes / MiB} MB (move images to assets/ and reference them as ../assets/<file>)`, path: s.rel });
    }
  }
  const bytes = deckInputBytes(deckReal);
  if (bytes > limits.maxDeckInputBytes) {
    problems.push({ rule: 'deck-too-large', message: `the deck's inputs (slides/, deck.css, assets/) are ${(bytes / MiB).toFixed(1)} MB; the limit is ${limits.maxDeckInputBytes / MiB} MB`, path: '.' });
  }
  return { slides, problems, inputBytes: bytes };
}
