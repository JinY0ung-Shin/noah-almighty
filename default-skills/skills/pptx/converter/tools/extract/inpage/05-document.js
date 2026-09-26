// In-page extractor code, part 0.5: document-level lints of the Noah converter (docs/CONTRACT.md "Noah lints").
// The page runs under a Content-Security-Policy (tools/extract/server.mjs), so none of this ever EXECUTES; these
// lints tell the author WHY a script, stylesheet or remote file did not load. Exposed as window.__pptx.documentLint
// (90-main.js); returns [{severity, rule, message, path}] and never touches the layout.

const DOC_ALLOWED_STYLESHEETS = ['../theme/base.css', '../theme/fonts.css', '../deck.css'];
const DOC_ALLOWED_SCRIPT_SRC = '../lib/chart.js';
const DOC_INERT_SCRIPT_TYPE = 'text/x-notes';
const DOC_REMOTE_RE = /^\s*(https?:|\/\/|file:)/i;
const DOC_CSS_REMOTE_RE = /url\(\s*(['"]?)\s*((?:https?:|\/\/|file:)[^'")\s]*)/gi;
const DOC_XLINK_NS = 'http://www.w3.org/1999/xlink';
const DOC_URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action', 'formaction', 'data', 'poster', 'background', 'srcset']);

function docWhere(el) {
  if (!el || el.nodeType !== 1) return null;
  if (ROOT && ROOT.contains(el)) return pathOf(el);
  const parent = el.parentElement;
  const idx = parent ? Array.prototype.indexOf.call(parent.children, el) + 1 : 1;
  return `${parent ? parent.localName + ' > ' : ''}${el.localName}:nth-child(${idx})`;
}

function docShort(s, n = 100) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function documentLintImpl(opts = {}) {
  const maxDom = Number(opts.maxDomElements) || 2500;
  const out = [];
  const seen = new Set();
  const add = (severity, rule, message, where) => {
    const key = `${rule}|${where}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ severity, rule, message, path: where });
  };
  const root = document.querySelector('main.slide');
  if (root) beginRun(root);
  else ROOT = null;
  const all = [...document.querySelectorAll('*')];

  // ---- scripts: only the toolkit's chart renderer (and the inert notes block) may appear
  for (const s of document.querySelectorAll('script')) {
    const type = (s.getAttribute('type') || '').trim().toLowerCase();
    if (type === DOC_INERT_SCRIPT_TYPE) continue;
    const src = s.getAttribute('src');
    if (src !== null && src.trim() === DOC_ALLOWED_SCRIPT_SRC) continue;
    const what = src !== null ? `<script src="${docShort(src, 80)}">` : `inline <script> "${docShort(s.textContent, 60)}"`;
    add('error', 'script', `${what} is not allowed: slides may only load ${DOC_ALLOWED_SCRIPT_SRC} (the converter never runs slide scripts)`, docWhere(s));
  }
  for (const el of all) {
    for (const a of el.attributes) {
      const name = a.name.toLowerCase();
      if (/^on/.test(name)) {
        add('error', 'script', `event-handler attribute ${name}="${docShort(a.value, 60)}" is not allowed (the converter never runs slide scripts)`, docWhere(el));
      } else if (DOC_URL_ATTRS.has(name) && /^\s*javascript:/i.test(String(a.value).replace(/[\u0000-\u001f]/g, ''))) {
        add('error', 'script', `javascript: URL in ${name} is not allowed (the converter never runs slide scripts)`, docWhere(el));
      }
    }
  }

  // ---- stylesheets: base.css, fonts.css, deck.css only; no @import
  for (const l of document.querySelectorAll('link')) {
    const rel = (l.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) continue;
    const href = (l.getAttribute('href') || '').trim();
    if (!DOC_ALLOWED_STYLESHEETS.includes(href)) {
      add('error', 'stylesheet', `<link rel="stylesheet" href="${docShort(href, 80)}"> is not allowed: link only ${DOC_ALLOWED_STYLESHEETS.join(', ')}`, docWhere(l));
    }
  }
  const visitRules = (rules, owner) => {
    for (const r of rules) {
      if (r.type === 3 || (r.constructor && r.constructor.name === 'CSSImportRule')) {
        add('error', 'stylesheet', `@import ${docShort(r.href, 80)} is not allowed: link the stylesheet directly (only ${DOC_ALLOWED_STYLESHEETS.join(', ')})`, owner);
      } else if (r.cssRules) {
        try { visitRules(r.cssRules, owner); } catch (e) { /* ignore */ }
      }
    }
  };
  for (const sh of document.styleSheets) {
    const owner = sh.ownerNode ? docWhere(sh.ownerNode) : null;
    try { visitRules(sh.cssRules, owner); } catch (e) { /* cross-origin sheet: blocked anyway */ }
  }
  for (const st of document.querySelectorAll('style')) {
    if (/@import\b/i.test(st.textContent || '')) add('error', 'stylesheet', '@import is not allowed: link the stylesheet directly', docWhere(st));
  }

  // ---- <base>, <meta http-equiv=refresh>
  for (const b of document.querySelectorAll('base')) {
    add('error', 'base-url', `<base href="${docShort(b.getAttribute('href'), 80)}"> is not allowed (links resolve relative to the slide file)`, docWhere(b));
  }
  for (const m of document.querySelectorAll('meta[http-equiv]')) {
    if ((m.getAttribute('http-equiv') || '').trim().toLowerCase() === 'refresh') {
      add('error', 'navigation', '<meta http-equiv="refresh"> is not allowed (a slide never navigates)', docWhere(m));
    }
  }

  // ---- remote URLs: src / href / srcset / xlink:href / poster, and CSS url()
  const remote = (el, attr, value) => {
    add('error', 'remote-url', `${attr}="${docShort(value, 100)}" is a remote/absolute URL: the converter has no network — put the file in the deck's assets/ folder and reference it as ../assets/<file>`, docWhere(el));
  };
  for (const el of all) {
    for (const attr of ['src', 'href', 'poster']) {
      const v = el.getAttribute(attr);
      if (v !== null && DOC_REMOTE_RE.test(v)) remote(el, attr, v);
    }
    const xl = el.getAttributeNS(DOC_XLINK_NS, 'href');
    if (xl !== null && DOC_REMOTE_RE.test(xl)) remote(el, 'xlink:href', xl);
    const ss = el.getAttribute('srcset');
    if (ss !== null) {
      for (const cand of ss.split(',')) {
        const u = cand.trim().split(/\s+/)[0] || '';
        if (DOC_REMOTE_RE.test(u)) remote(el, 'srcset', u);
      }
    }
    const style = el.getAttribute('style');
    if (style) for (const m of style.matchAll(DOC_CSS_REMOTE_RE)) remote(el, 'style url()', m[2]);
  }
  const cssTexts = [];
  for (const st of document.querySelectorAll('style')) cssTexts.push([st.textContent || '', docWhere(st)]);
  for (const sh of document.styleSheets) {
    if (!sh.href || !sh.ownerNode) continue;
    let text = '';
    try { text = [...sh.cssRules].map((r) => r.cssText).join('\n'); } catch (e) { text = ''; }
    cssTexts.push([text, docWhere(sh.ownerNode)]);
  }
  for (const [text, where] of cssTexts) {
    for (const m of text.matchAll(DOC_CSS_REMOTE_RE)) {
      add('error', 'remote-url', `CSS url(${docShort(m[2], 100)}) is a remote/absolute URL: the converter has no network — put the file in the deck's assets/ folder and use url(../assets/<file>)`, where);
    }
  }

  // ---- DOM size
  if (root) {
    const n = root.querySelectorAll('*').length;
    if (n > maxDom) add('error', 'dom-size', `main.slide has ${n} elements (limit ${maxDom}): simplify the slide or split it`, pathOf(root));
  }
  return out;
}
