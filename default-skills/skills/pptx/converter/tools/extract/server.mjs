// Request routing for the extractor: TWO roots behind one origin, http://deck.local/ — everything else is aborted.
//
//   /theme/*, /lib/*, /fonts/*   -> the read-only toolkit (KIT = this skill's converter/ directory);
//                                   /theme/fonts.css -> KIT/theme/fonts-<profile>.css
//   /deck.css, /slides/*, /assets/*, anything else -> the deck folder in the workspace
//
// Containment is checked on the realpath of both sides (a `..` or a symlink that leaves its root is blocked), a
// file over MAX_SERVED_BYTES answers 413 (read through one descriptor, so a file that grows after the size check is
// still cut off), data:/blob: continue, every other scheme/host is aborted. A deck image whose DECODED size would be
// too large — over MAX_IMAGE_PIXELS, or pushing one page's images past MAX_PAGE_IMAGE_PIXELS, or of unreadable size —
// answers 413 before Chromium sees a byte, and so does a deck HTML/CSS/SVG that embeds such a base64 data: image
// (tools/extract/pixels.mjs). Every HTML/SVG response carries a Content-Security-Policy: agent-authored slides can
// never run inline scripts, handlers or any script but the toolkit's chart.js, and can reach nothing
// (docs/CONTRACT.md "Isolation").
import fs from 'node:fs';
import path from 'node:path';
import { dataImages, imageSize } from './pixels.mjs';

export const HOST = 'deck.local';
export const BASE = `http://${HOST}/`;
export const MAX_SERVED_BYTES = 20 * 1024 * 1024;
/** Decoded pixels of one picture (~160 MB as RGBA): a 40 MP photo still renders; a pixel bomb never reaches Chromium. */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** Decoded pixels of all distinct pictures one slide page loads (~400 MB as RGBA). */
export const MAX_PAGE_IMAGE_PIXELS = 100_000_000;
const KIT_DIRS = new Set(['theme', 'lib', 'fonts']);
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.svg']);

/** The CSP of every slide document (exact-path script-src: only the toolkit's chart renderer can execute). */
export const SLIDE_CSP = [
  "default-src 'none'", `script-src ${BASE}lib/chart.js`, "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'none'", "media-src 'none'",
  "object-src 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

/** The isolated raster pages: same policy, no script at all, <base href> = the slide URL allowed. */
export const RASTER_CSP = [
  "default-src 'none'", "script-src 'none'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'none'", "media-src 'none'",
  "object-src 'none'", "frame-src 'none'", "worker-src 'none'", "base-uri 'self'", "form-action 'none'",
].join('; ');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function inside(child, root) {
  return child === root || child.startsWith(root + path.sep);
}

function realOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Map a deck.local URL path ("/slides/01-cover.html") to {file (realpath), root: 'kit'|'deck', rel} or
 * {error: 'escape'|'missing'|'not-file'}. Shared by the router and by extract.mjs (copying an <img src=*.svg>).
 */
export function resolveUrlPath(pathname, { kit, deck, profile }) {
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return { error: 'escape' };
  }
  if (rel.includes('\0')) return { error: 'escape' };
  if (rel === 'theme/fonts.css') rel = `theme/fonts-${profile}.css`;
  const first = rel.split('/')[0];
  const which = KIT_DIRS.has(first) ? 'kit' : 'deck';
  const rootAbs = path.resolve(which === 'kit' ? kit : deck);
  const abs = path.resolve(rootAbs, rel);
  if (!inside(abs, rootAbs)) return { error: 'escape', root: which, rel };
  const rootReal = realOrNull(rootAbs) || rootAbs;
  const real = realOrNull(abs);
  if (real === null) return { error: 'missing', root: which, rel };
  if (!inside(real, rootReal)) return { error: 'escape', root: which, rel };
  let st;
  try {
    st = fs.statSync(real);
  } catch {
    return { error: 'missing', root: which, rel };
  }
  if (!st.isFile()) return { error: 'not-file', root: which, rel };
  return { file: real, root: which, rel, size: st.size };
}

export function mediaTypeOf(file) {
  return TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Read a file through ONE descriptor (no-follow, non-blocking: a symlink or FIFO swapped in after the realpath check
 * is never followed or waited on), at most `max` bytes: {buf, st} | {tooLarge: bytes} | {notFile: true}. Never a
 * stat-then-read race: the size cap holds for the bytes actually read.
 */
export function readBounded(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return { notFile: true };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { notFile: true };
    if (st.size > max) return { tooLarge: st.size };
    const chunks = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(Math.max(st.size, 1), max) + 1);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      total += n;
      if (total > max) return { tooLarge: total };
      chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
    return { buf: Buffer.concat(chunks, total), st };
  } finally {
    fs.closeSync(fd);
  }
}

const mp = (px) => `${(px / 1e6).toFixed(1)} MP`;
const DATA_SCAN_CACHE = new Map();   // realpath|size|mtime -> dataImages() of that text (deck.css is served per page)

function dataImagesOf(file, buf, st) {
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  let v = DATA_SCAN_CACHE.get(key);
  if (!v) {
    v = dataImages(buf.toString('utf8'));
    DATA_SCAN_CACHE.set(key, v);
  }
  return v;
}

/**
 * The pixel budget of ONE page (one router = one browser context = one slide page, or one slide's raster jobs):
 * check(rel, file, buf, st) -> null (serve it) or the English reason to refuse it (413 + an image-too-large lint).
 */
export function pageImageBudget({ maxImagePixels = MAX_IMAGE_PIXELS, maxPagePixels = MAX_PAGE_IMAGE_PIXELS } = {}) {
  const seen = new Set();   // realpaths and data: payload hashes already counted on this page
  let total = 0;
  const admit = (id, px, what) => {
    if (seen.has(id)) return null;
    if (total + px > maxPagePixels) {
      return `${what} (${mp(px)}) would bring this slide's pictures to ${mp(total + px)}; the pictures of one slide may total at most ${mp(maxPagePixels)} — downscale them`;
    }
    seen.add(id);
    total += px;
    return null;
  };
  const tooBig = (what, s) => `${what} is ${s.width}x${s.height} px (${mp(s.width * s.height)}); a picture may have at most ${mp(maxImagePixels)} — downscale it (the slide shows at most 2560 px of it)`;
  return (rel, file, buf, st) => {
    const s = imageSize(buf);
    if (s) {
      if (s.width === null) return `${rel} is a ${s.format.toUpperCase()} image whose pixel size cannot be read from its header (a damaged or unusual file) — re-save it as PNG or JPEG`;
      if (s.width * s.height > maxImagePixels) return tooBig(rel, s);
      return admit(file, s.width * s.height, rel);
    }
    if (!TEXT_EXT.has(path.extname(file).toLowerCase())) return null;
    for (const d of dataImagesOf(file, buf, st)) {
      const what = `a base64 data: image in ${rel}`;
      if (d.width * d.height > maxImagePixels) return tooBig(what, d);
      const why = admit(`data:${d.key}`, d.width * d.height, what);
      if (why) return why;
    }
    return null;
  };
}

/**
 * Build a Playwright route handler.
 *   kit, deck   absolute toolkit / deck roots
 *   profile     font profile: theme/fonts.css -> theme/fonts-<profile>.css
 *   virtual     Map<string path, string html> of in-memory pages (isolation renders; RASTER_CSP)
 *   events      {blocked(url, why), missing(url), tooLarge(url, bytes), imageTooLarge({url, rel, message})} callbacks
 *   budget      the page's pixel budget (pageImageBudget options); one router serves one page
 */
export function makeRouter({ kit, deck, profile, virtual = new Map(), events = {}, budget = {} }) {
  const pixels = pageImageBudget(budget);
  return async (route) => {
    const req = route.request();
    let url;
    try {
      url = new URL(req.url());
    } catch {
      events.blocked?.(req.url(), 'unparsable URL');
      return route.abort('blockedbyclient');
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
    if (url.protocol !== 'http:' || url.host !== HOST) {
      events.blocked?.(req.url(), 'outside the deck (network is blocked)');
      return route.abort('blockedbyclient');
    }
    const vkey = (() => {
      try {
        return decodeURIComponent(url.pathname).replace(/^\/+/, '');
      } catch {
        return null;
      }
    })();
    // the browser's own favicon probe (seen in the network log after load) is not the author's request: never a lint
    if (vkey === 'favicon.ico') return route.fulfill({ status: 204, body: '' });
    if (vkey !== null && virtual.has(vkey)) {
      return route.fulfill({
        status: 200, contentType: TYPES['.html'], body: virtual.get(vkey),
        headers: { 'cache-control': 'no-store', 'content-security-policy': RASTER_CSP },
      });
    }
    const r = resolveUrlPath(url.pathname, { kit, deck, profile });
    if (r.error === 'escape') {
      events.blocked?.(req.url(), 'path escapes its root');
      return route.abort('blockedbyclient');
    }
    if (r.error) {
      events.missing?.(req.url());
      return route.fulfill({ status: 404, contentType: 'text/plain', body: `not found: ${r.rel || url.pathname}` });
    }
    const read = r.size > MAX_SERVED_BYTES ? { tooLarge: r.size } : readBounded(r.file, MAX_SERVED_BYTES);
    if (read.tooLarge) {
      events.tooLarge?.(req.url(), read.tooLarge);
      return route.fulfill({ status: 413, contentType: 'text/plain', body: `too large: ${r.rel} (${read.tooLarge} bytes)` });
    }
    if (read.notFile) {
      events.missing?.(req.url());
      return route.fulfill({ status: 404, contentType: 'text/plain', body: `not found: ${r.rel}` });
    }
    // the toolkit is trusted; a deck file is refused BEFORE Chromium decodes it when its pixels would be too many
    const why = r.root === 'deck' ? pixels(r.rel, r.file, read.buf, read.st) : null;
    if (why) {
      events.imageTooLarge?.({ url: req.url(), rel: r.rel, message: why });
      return route.fulfill({ status: 413, contentType: 'text/plain', body: `refused: ${why}` });
    }
    const type = mediaTypeOf(r.file);
    const headers = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
    if (/^(text\/html|image\/svg\+xml)/.test(type)) headers['content-security-policy'] = SLIDE_CSP;
    return route.fulfill({ status: 200, contentType: type, body: read.buf, headers });
  };
}
