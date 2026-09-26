// Browser plumbing: hardened launch, open a slide with readiness waits, in-page script injection, CDP font check,
// isolated rasters (docs/CONTRACT.md "Isolation", "Raster policy").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, makeRouter, resolveUrlPath } from './server.mjs';
import { loadPlaywright, loadPlaywrightError, resolveChromium } from './chromium.mjs';
import { agentFamily } from './cmap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const VIEWPORT = { width: 1280, height: 720 };
/** No host name resolves (loopback excepted — the black-hole proxy lives there). */
export const HOST_RESOLVER_RULES = 'MAP * ~NOTFOUND , EXCLUDE 127.0.0.1';
export const LAUNCH_ARGS = [
  '--font-render-hinting=none',                        // the layout contract (CONTRACT v2): unhinted advances
  '--js-flags=--max-old-space-size=512',               // renderer V8 heap cap
  '--webrtc-ip-handling-policy=disable_non_proxied_udp', // WebRTC never leaves through UDP
  '--force-webrtc-ip-handling-policy',
  // For a SOCKS proxy Playwright (1.61.1) passes --host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE 127.0.0.1" WITH
  // the quote characters in argv (there is no shell to strip them), and Chromium rejects that rule ("Failed parsing
  // rule" in the browser log, measured with Chromium 149). Chromium keeps the LAST copy of a switch, and Playwright
  // appends these args after its own, so this unquoted copy is the one in force.
  `--host-resolver-rules=${HOST_RESOLVER_RULES}`,
];
// Black-hole proxy: nothing the router does not answer can reach a network (loopback is proxied too).
export const PROXY = { server: 'socks5://127.0.0.1:9', bypass: '<-loopback>' };
export const EVALUATE_TIMEOUT_MS = 60000;
export const RASTER_MAX_SCALE = 4;
export const RASTER_MAX_PX = 2560;

export class ExtractError extends Error {
  /** cls: authoring | toolchain | conversion | timeout | internal */
  constructor(message, cls = 'internal', slide = null) {
    super(message);
    this.cls = cls;
    this.slide = slide;
  }
}

/** The in-page extractor: tools/extract/inpage/*.js concatenated (sorted) into one function scope. */
export function inpageSource() {
  const dir = path.join(HERE, 'inpage');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  const body = files.map((f) => `// ---- ${f}\n` + fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  return `(() => {\n${body}\n})();`;
}

/** Launch the resolved Chromium, hardened. `runTmp` = the run temp dir (HOME/TMPDIR of the browser). */
export async function launch({ runTmp = null } = {}) {
  const pw = loadPlaywright();
  if (!pw) {
    const e = loadPlaywrightError();
    throw new ExtractError(`playwright-core is not resolvable from the converter directory (DEFAULT_PLUGINS_DIR outside the app tree)${e ? `: ${String(e.message).split('\n')[0]}` : ''}`, 'toolchain');
  }
  const c = resolveChromium();
  if (!c.ok) throw new ExtractError(c.error, 'toolchain');
  const env = { ...process.env };
  if (runTmp) {
    env.HOME = runTmp;
    env.TMPDIR = runTmp;
  }
  try {
    return await pw.chromium.launch({
      executablePath: c.path, headless: true, chromiumSandbox: false, args: LAUNCH_ARGS, proxy: PROXY, env,
      timeout: 60000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,  // extract.mjs owns signals
    });
  } catch (e) {
    const m = String(e && e.message);
    const why = /Socket path too long/.test(m) ? 'its singleton socket path under TMPDIR is too long (the run directory must stay under ~60 characters)' : m.split('\n')[0];
    throw new ExtractError(`Chromium (${c.path}) did not start: ${why}`, 'toolchain');
  }
}

/** page.route does not see WebSockets: close every one (no network at all). */
async function blockWebSockets(ctx, onBlocked) {
  if (typeof ctx.routeWebSocket !== 'function') return;
  await ctx.routeWebSocket(/.*/, (ws) => {
    onBlocked?.(ws.url());
    ws.close({ code: 1008, reason: 'blocked by the extractor (no network)' });
  });
}

/** CDP-injected (CSP-exempt) recorder of securitypolicyviolation events, read back by extract.mjs. */
function recordCspViolations() {
  window.__pptxCsp = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    if (window.__pptxCsp.length >= 200) return;
    window.__pptxCsp.push({
      blockedURI: String(e.blockedURI || ''), directive: String(e.effectiveDirective || e.violatedDirective || ''),
      sample: String(e.sample || '').slice(0, 80), line: e.lineNumber || 0,
    });
  }, true);
}

async function newContext(browser, dsf) {
  return browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: dsf, serviceWorkers: 'block', acceptDownloads: false, bypassCSP: false,
  });
}

export function isCrash(e) {
  return /Target crashed|Page crashed|crashed/i.test(String(e && e.message));
}

/** Playwright's own timeout (a page operation outliving page.setDefaultTimeout) — not a converter crash. */
export function isPlaywrightTimeout(e) {
  return !!e && (e.name === 'TimeoutError' || /Timeout \d+ms exceeded/.test(String(e.message)));
}

/** Race a page operation against `ms`; a timeout closes the page (the run then fails with class `timeout`). */
export async function withTimeout(page, ms, what, fn, slide = null) {
  let timer = null;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new ExtractError(`${what} did not finish within ${Math.round(ms / 1000)} s`, 'timeout', slide)), ms);
  });
  try {
    return await Promise.race([fn(), t]);
  } catch (e) {
    if (e instanceof ExtractError && e.cls === 'timeout') await page.close().catch(() => {});
    else if (isCrash(e)) throw new ExtractError('the slide page crashed while rendering (too large or complex): simplify or split it', 'conversion', slide);
    else if (isPlaywrightTimeout(e)) {
      await page.close().catch(() => {});
      throw new ExtractError(`${what} did not finish in time (${String(e.message).split('\n')[0].slice(0, 160)})`, 'timeout', slide);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Node-side poll (100 ms) instead of page.waitForFunction, whose string form needs page eval (forbidden by CSP). */
async function pollUntil(page, fn, timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return true;
    if (Date.now() - t0 >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Open `rel` (deck-relative, e.g. "slides/01-cover.html") in a fresh context at `dsf`, wait for charts + fonts +
 * images, and verify that every font face the slide uses is loaded. Returns {ctx, page, events, fonts, nCharts}.
 */
export async function openSlide(browser, { kit, deck, profile, rel, dsf, timeoutMs = 20000, source, slide = null, cssAgent = false, familyLabels = {} }) {
  const events = { blocked: [], missing: [], tooLarge: [], imageTooLarge: [], console: [], pageErrors: [], crashed: false };
  const ctx = await newContext(browser, dsf);
  await ctx.addInitScript(recordCspViolations);
  await ctx.route('**/*', makeRouter({
    kit, deck, profile, events: {
      blocked: (u) => events.blocked.push(u), missing: (u) => events.missing.push(u),
      tooLarge: (u, n) => events.tooLarge.push({ url: u, bytes: n }),
      imageTooLarge: (e) => events.imageTooLarge.push(e),
    },
  }));
  await blockWebSockets(ctx, (u) => events.blocked.push(u));
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeoutMs);
  // The CDP CSS agent (platformFonts) must be enabled BEFORE navigation: enabled after load, its resource
  // re-loader never finishes while the black-hole proxy is configured (measured with Chromium 149, both the
  // Playwright proxy option and raw --proxy-server). On about:blank it has nothing to load.
  let cdp = null;
  if (cssAgent) {
    cdp = await ctx.newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
  }
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') events.console.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => events.pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('crash', () => { events.crashed = true; });
  const url = BASE + rel.split(/[\\/]/).map(encodeURIComponent).join('/');
  let resp;
  try {
    resp = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  } catch (e) {
    if (isCrash(e) || events.crashed) throw new ExtractError('the slide page crashed while rendering (too large or complex): simplify or split it', 'conversion', slide);
    if (/Timeout/i.test(String(e.message))) throw new ExtractError(`${rel}: the slide did not finish loading within ${Math.round(timeoutMs / 1000)} s`, 'timeout', slide);
    throw e;
  }
  if (!resp || !resp.ok()) {
    // the router refused the slide document itself (a too-large embedded data: image): say why
    const refused = events.imageTooLarge.find((e) => e.url === url);
    if (refused) throw new ExtractError(`image-too-large: ${refused.message}`, 'authoring', slide);
    throw new ExtractError(`${rel}: could not load the slide (${resp ? resp.status() : 'no response'})`, 'authoring', slide);
  }
  await withTimeout(page, EVALUATE_TIMEOUT_MS, `${rel}: injecting the extractor`, () => page.evaluate(source), slide);
  const nCharts = await page.evaluate(() => document.querySelectorAll('[data-chart]').length);
  if (nCharts) {
    const ok = await withTimeout(page, timeoutMs + 5000, `${rel}: waiting for the charts`,
      () => pollUntil(page, () => document.documentElement.dataset.chartsReady === '1', timeoutMs), slide);
    if (!ok) {
      throw new ExtractError(`${rel}: ${nCharts} [data-chart] element(s) but document.documentElement.dataset.chartsReady never became "1" within ${timeoutMs / 1000} s — ../lib/chart.js did not finish (or is not loaded). Page errors: ${events.pageErrors.join(' | ') || 'none'}`, 'authoring', slide);
    }
  }
  const ready = await withTimeout(page, EVALUATE_TIMEOUT_MS, `${rel}: waiting for fonts and images`, () => page.evaluate(() => window.__pptx.ready()), slide);
  const fonts = await withTimeout(page, EVALUATE_TIMEOUT_MS, `${rel}: verifying fonts`, () => page.evaluate(() => window.__pptx.verifyFonts()), slide);
  const bad = fontLoadFailure({ rel, profile, dsf, ready, fonts, missing: events.missing, familyLabels });
  if (bad) throw new ExtractError(bad.message, bad.cls, slide);
  return { ctx, page, events, fonts, nCharts, cdp };
}

/** A face's @font-face src names a toolkit font file (../fonts/…), not one of the deck's (assets/…). */
function isKitFontSrc(src) {
  const s = String(src || '');
  return /\.\.\/fonts\/|\/fonts\//.test(s) && !/assets\//.test(s);
}

/**
 * The failure of a slide whose fonts are not all loaded after the readiness wait, or null. `ready` = in-page
 * ready() ({stillLoading: faces still 'loading' when the wait gave up}), `fonts` = verifyFonts() ({failures: faces
 * the text needs that are not 'loaded', plus any face in 'error'}); every face carries the src of its @font-face.
 *
 * Who is at fault decides the class (docs/architecture/pptx-converter.md "Font audit ≠ toolchain health"):
 *   - any face of the deck's own (@font-face in deck.css or the slide), or one that cannot be attributed →
 *     `authoring` (the deck's font: fix the slide);
 *   - only toolkit faces, every one of them 'error' (its file exists — the toolchain check found every font file —
 *     but did not load) → `toolchain`, reported as a run-time failure of the installed converter;
 *   - only toolkit faces, some never requested ('unloaded') or still loading → `internal`: a fault of this audit,
 *     never of the slide or the deployment, so the agent retries and reports the log instead of fixing the slide or
 *     telling the user that PPT generation is unavailable.
 */
export function fontLoadFailure({ rel, profile, dsf, ready, fonts, missing = [], familyLabels = {} }) {
  const loading = (ready && ready.stillLoading) || [];
  const failures = (fonts && fonts.failures) || [];
  if (!loading.length && !failures.length) return null;
  const faces = [...failures, ...loading];
  const kitOnly = faces.every((f) => isKitFontSrc(f.src));
  const cls = !kitOnly ? 'authoring' : faces.every((f) => f.status === 'error') ? 'toolchain' : 'internal';
  const face = (f) => `${agentFamily(f.family, familyLabels)} weight ${f.weight}${f.style ? ` ${f.style}` : ''} unicode-range ${f.unicodeRange || 'all'}`;
  const lines = failures.map((f) => `  - ${face(f)}: status '${f.status}'${f.src ? ` src ${f.src}` : ''}${f.chars ? ` (needed for "${f.chars}" in ${f.path})` : ''}`);
  for (const f of loading) lines.push(`  - still loading after the wait: ${face(f)}${f.src ? ` src ${f.src}` : ''}`);
  if (missing.length) lines.push(`  missing files: ${missing.join(', ')}`);
  return {
    cls,
    message: `${rel} [${profile}, dsf ${dsf}]: font face(s) used by the slide did not load${cls === 'internal' ? ' (a converter fault, not the slide\'s)' : ''}:\n${lines.join('\n')}`,
  };
}

/**
 * CDP CSS.getPlatformFontsForNode for every visible text node (window.__pptxTextEls, set by verifyFonts).
 * `cdp` = the session openSlide({cssAgent: true}) enabled before navigation.
 */
export async function platformFonts(page, cdp) {
  try {
    await cdp.send('DOM.getDocument', { depth: -1 });
    const arr = await cdp.send('Runtime.evaluate', { expression: 'window.__pptxTextEls', returnByValue: false });
    const props = await cdp.send('Runtime.getProperties', { objectId: arr.result.objectId, ownProperties: true });
    const items = props.result.filter((p) => /^\d+$/.test(p.name)).sort((a, b) => Number(a.name) - Number(b.name));
    const out = [];
    for (const p of items) {
      const { nodeId } = await cdp.send('DOM.requestNode', { objectId: p.value.objectId });
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      out.push(fonts);
    }
    return out;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Media type of an <img> job's source: data: URL header, else the served file's magic bytes. */
export function sourceMediaType(url, { kit, deck, profile }) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol === 'data:') {
    const m = /^data:([^;,]+)/i.exec(url);
    return m ? m[1].toLowerCase() : null;
  }
  const r = resolveUrlPath(u.pathname, { kit, deck, profile });
  if (!r.file) return null;
  try {
    const fd = fs.openSync(r.file, 'r');
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    fs.closeSync(fd);
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    if (b.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  } catch {
    return null;
  }
  return null;
}

/**
 * Raster policy (D18): scale S = min(4, 2560 / longest CSS side) — icons keep 4x, a full-slide image gets 2560 px —
 * and JPEG q90 for an <img> whose source is a JPEG, painted over its whole box (object-fit fill/cover), square and
 * fully opaque; everything else PNG with a transparent background.
 */
export function rasterPlan(job, { opacity = 1, sourceType = null } = {}) {
  const w = Math.max(1e-3, job.w), h = Math.max(1e-3, job.h);
  const S = Math.min(RASTER_MAX_SCALE, RASTER_MAX_PX / Math.max(w, h));
  const st = job.style || {};
  const jpeg = job.type === 'img' && sourceType === 'image/jpeg' && ['fill', 'cover'].includes(st.objectFit || 'fill')
    && !st.borderRadius && Math.abs(Number(opacity) - 1) < 1e-9;
  return { S, format: jpeg ? 'jpeg' : 'png' };
}

/**
 * Render every image job in isolation (own page, transparent background) at scale S and write the files.
 * jobs: [{job, outAbs, S, format}] with job = {type:'svg', markup, w, h, baseUrl} | {type:'img', url, style, w, h, baseUrl}
 *
 * The element is drawn at S x its CSS size in a DSF-1 page (vector content and image resampling land on the same
 * device pixels as a DSF-S render of the 1x element) and the screenshot clip is ceil(Sw) x ceil(Sh) px: screenshot
 * clips are whole CSS px (Playwright and CDP both round/floor them), so a DSF-S render of a fractional box would come
 * out rounded UP to the next whole CSS px with transparent padding that PowerPoint then squeezes into the box.
 */
export async function rasterize(browser, { kit, deck, profile, jobs, timeoutMs = 20000, slide = null }) {
  if (!jobs.length) return [];
  const virtual = new Map();
  const ctx = await newContext(browser, 1);
  await ctx.route('**/*', makeRouter({ kit, deck, profile, virtual }));
  await blockWebSockets(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeoutMs);
  const results = [];
  try {
    let k = 0;
    for (const { job, outAbs, S, format } of jobs) {
      const scalePx = (v) => String(v).replace(/(-?[\d.]+(?:e[-+]?\d+)?)px/gi, (m, n) => `${parseFloat(n) * S}px`);
      const w = Math.max(1e-3, job.w), h = Math.max(1e-3, job.h);
      const W = Math.max(1, Math.ceil(w * S - 1e-6)), H = Math.max(1, Math.ceil(h * S - 1e-6));
      // <base>: relative references inside the markup resolve as in the slide; fonts.css for SVG <text>
      const base = job.baseUrl ? `<base href="${job.baseUrl.replace(/"/g, '&quot;')}">` : '';
      const head = `<!doctype html><html><head><meta charset="utf-8">${base}<link rel="stylesheet" href="${BASE}theme/fonts.css">` +
        '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}#x{display:block}</style></head><body>';
      let bodyHtml;
      if (job.type === 'svg') {
        bodyHtml = job.markup.replace(/^<svg\b/, '<svg id="x"');
      } else {
        const st = job.style || {};
        const css = [`width:${w * S}px`, `height:${h * S}px`, `object-fit:${st.objectFit || 'fill'}`,
          `object-position:${scalePx(st.objectPosition || '50% 50%')}`,
          st.borderRadius ? `border-radius:${scalePx(st.borderRadius)}` : '', st.imageRendering ? `image-rendering:${st.imageRendering}` : ''].filter(Boolean).join(';');
        bodyHtml = `<img id="x" src="${job.url.replace(/"/g, '&quot;')}" style="${css}">`;
      }
      const vpath = `__raster/${k++}.html`;
      virtual.set(vpath, head + bodyHtml + '</body></html>');
      await page.setViewportSize({ width: W + 2, height: H + 2 });
      await withTimeout(page, EVALUATE_TIMEOUT_MS, 'loading an isolated image render', () => page.goto(BASE + vpath, { waitUntil: 'load', timeout: timeoutMs }), slide);
      const box = await withTimeout(page, EVALUATE_TIMEOUT_MS, 'an isolated image render', () => page.evaluate(async ({ w, h, S }) => {
        const x = document.getElementById('x');
        if (x && x.localName === 'svg') {
          // user units stay the 1x CSS px of the slide: a viewBox for the 1x size, then draw it S x larger
          if (!x.getAttribute('viewBox')) x.setAttribute('viewBox', `0 0 ${w} ${h}`);
          x.setAttribute('width', String(w * S));
          x.setAttribute('height', String(h * S));
        }
        await document.fonts.ready;
        const im = document.querySelector('img');
        if (im && !im.complete) await new Promise((r) => { im.onload = im.onerror = r; });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const r = x ? x.getBoundingClientRect() : null;
        return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
      }, { w, h, S }), slide);
      const shot = { path: outAbs, clip: { x: 0, y: 0, width: W, height: H }, animations: 'disabled', caret: 'hide' };
      if (format === 'jpeg') Object.assign(shot, { type: 'jpeg', quality: 90 });
      else shot.omitBackground = true;
      await withTimeout(page, EVALUATE_TIMEOUT_MS, 'an isolated image render', () => page.screenshot(shot), slide);
      results.push({ outAbs, cssW: box ? box.w / S : w, cssH: box ? box.h / S : h, pxW: W, pxH: H, S, format });
    }
  } finally {
    await ctx.close();
  }
  return results;
}
