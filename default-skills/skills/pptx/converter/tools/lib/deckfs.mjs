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

// ------------------------------------------------------------------------------------------------ theme link
// elements whose content never becomes linked elements: raw text / RCDATA, a template's inert fragment, and noscript
// (the slide pages run with scripting on)
const INERT_TAGS = new Set(['script', 'style', 'template', 'textarea', 'title', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes']);
const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', sol: '/', period: '.', hyphen: '-', lowbar: '_' };
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r';

function decodeRefs(v) {
  return v.replace(/&(?:#(\d+)|#[xX]([0-9A-Fa-f]+)|([A-Za-z]+));?/g, (m, dec, hex, name) => {
    if (dec || hex) {
      const cp = dec ? Number(dec) : parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : m;
  });
}

/**
 * The stylesheets a slide's HTML applies, in document order: the trimmed `href` of every <link> whose rel has the
 * token `stylesheet` (not `alternate`), that is not `disabled`, is CSS (no `type`, or text/css) and applies to the
 * screen (no `media`, or all / screen). A static scan in the manner of the HTML tokenizer — no browser, and
 * linear in the file (a regex scan could retry an unterminated quote at every `<`, and this runs on deck.mjs's event
 * loop): comments are skipped, and so is the content of the elements whose content never becomes a linked element
 * (INERT_TAGS); an unclosed comment, tag, quote or inert element runs to the end of the file, as in the parser.
 * Attribute names are case-insensitive, the first of a duplicated attribute wins, values may be unquoted and carry
 * character references.
 */
export function linkedStylesheets(html) {
  const s = String(html);
  const n = s.length;
  const out = [];
  let i = 0;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end < 0) break;
      i = end + 3;
      continue;
    }
    const nm = /^[A-Za-z][^\s/>]*/.exec(s.slice(lt + 1, lt + 65));
    if (!nm) { // an end tag, <!doctype>, a stray "<"
      i = lt + 1;
      continue;
    }
    const tag = nm[0].toLowerCase();
    const attrs = new Map();
    let j = lt + 1 + nm[0].length;
    let closed = false;
    while (j < n) {
      if (s[j] === '>') {
        closed = true;
        j++;
        break;
      }
      if (isSpace(s[j]) || s[j] === '/') {
        j++;
        continue;
      }
      let k = j + 1; // a name may start with "=" (the tokenizer keeps it)
      while (k < n && !isSpace(s[k]) && s[k] !== '/' && s[k] !== '>' && s[k] !== '=') k++;
      const name = s.slice(j, k).toLowerCase();
      while (k < n && isSpace(s[k])) k++;
      let value = '';
      if (s[k] === '=') {
        k++;
        while (k < n && isSpace(s[k])) k++;
        if (s[k] === '"' || s[k] === "'") {
          const e = s.indexOf(s[k], k + 1);
          if (e < 0) {
            k = n;
            break;
          }
          value = s.slice(k + 1, e);
          k = e + 1;
        } else {
          const e0 = k;
          while (k < n && !isSpace(s[k]) && s[k] !== '>') k++;
          value = s.slice(e0, k);
        }
      }
      if (!attrs.has(name)) attrs.set(name, decodeRefs(value));
      j = k;
    }
    if (!closed) break;
    i = j;
    if (INERT_TAGS.has(tag)) {
      const close = new RegExp(`</${tag}(?=[\\s/>])`, 'gi');
      close.lastIndex = i;
      const c = close.exec(s);
      const gt = c ? s.indexOf('>', c.index) : -1;
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }
    if (tag !== 'link') continue;
    const rel = (attrs.get('rel') || '').toLowerCase().split(/[\t\n\f\r ]+/);
    const type = attrs.has('type') ? attrs.get('type').trim().toLowerCase() : 'text/css';
    const media = attrs.has('media') ? attrs.get('media').trim().toLowerCase() : '';
    if (!rel.includes('stylesheet') || rel.includes('alternate') || attrs.has('disabled')) continue;
    if (type !== 'text/css' || !['', 'all', 'screen'].includes(media)) continue;
    out.push((attrs.get('href') || '').trim());
  }
  return out;
}

export const THEME_LINK_MISSING = 'this slide does not link ../deck.css, so it shows the kit\'s default theme, not the deck\'s: add <link rel="stylesheet" href="../deck.css"> after the ../theme/fonts.css link';
export const THEME_LINK_ORDER = 'this slide links ../deck.css before ../theme/base.css, so the kit\'s default theme overrides the deck\'s: link ../deck.css last, after ../theme/base.css and ../theme/fonts.css';

/**
 * `theme-link` (warn) for the given slides of a deck that has a deck.css: a slide that does not link ../deck.css
 * renders the kit's default theme (classic) inside, say, a midnight deck, and one that links it BEFORE
 * ../theme/base.css has the deck's tokens overridden by base.css's own `:root` — both silently. Read from the slide
 * files (linkedStylesheets): the page cannot know whether deck.css exists without requesting it, and a failed
 * request is itself an error. -> lint items {slide, profile: null, severity, rule, message, path: null}; report and
 * exit status only, never written into the IR (like the layout lint).
 */
export function themeLinkLint(deckReal, slides) {
  try {
    if (!fs.statSync(path.join(deckReal, 'deck.css')).isFile()) return [];
  } catch {
    return [];
  }
  const out = [];
  for (const s of slides) {
    let hrefs;
    try {
      hrefs = linkedStylesheets(fs.readFileSync(s.file, 'utf8'));
    } catch {
      continue;
    }
    // the last application of each sheet decides which one wins (both use :root)
    const deck = hrefs.lastIndexOf('../deck.css');
    const message = deck < 0 ? THEME_LINK_MISSING : hrefs.lastIndexOf('../theme/base.css') > deck ? THEME_LINK_ORDER : null;
    if (message) out.push({ slide: s.index, profile: null, severity: 'warn', rule: 'theme-link', message, path: null });
  }
  return out;
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
