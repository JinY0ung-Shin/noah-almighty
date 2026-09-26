// In-page extractor code, part 9: public API (window.__pptx).

async function readyImpl() {
  let rounds = 0;
  let loading = [];
  for (; rounds < 60; rounds++) {
    if (document.body) void document.body.offsetHeight; // force layout: lazy unicode-range faces start loading
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    loading = [...document.fonts].filter((f) => f.status === 'loading');
    if (!loading.length) break;
  }
  await Promise.all([...document.images].map((im) => (im.complete ? null : new Promise((r) => { im.addEventListener('load', r, { once: true }); im.addEventListener('error', r, { once: true }); }))));
  await new Promise((r) => requestAnimationFrame(() => r()));
  // each face with its @font-face src: whose face it is (the toolkit's or the deck's) decides the failure class
  const src = faceSources();
  return {
    rounds,
    stillLoading: loading.map((f) => ({ family: f.family, weight: f.weight, style: f.style, unicodeRange: f.unicodeRange, status: f.status, src: src.get(f) || null })),
  };
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Layout fingerprint: every element box + every text fragment rect (1/64 px), for DSF-1 vs DSF-2 parity. */
function fingerprintImpl() {
  const root = document.querySelector('main.slide');
  if (!root) return null;
  const q = (v) => Math.round(v * 64);
  const parts = [];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const r = el.getBoundingClientRect();
    parts.push(`${q(r.left)},${q(r.top)},${q(r.width)},${q(r.height)}`);
  }
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  let count = 0;
  while ((n = w.nextNode())) {
    const rg = document.createRange();
    rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) { parts.push(`t${q(r.left)},${q(r.top)},${q(r.width)}`); count++; }
  }
  return { hash: fnv1a(parts.join(';')), boxes: parts.length - count, fragments: count };
}

function notesOf() {
  const withAttr = document.querySelector('[data-notes]');
  if (withAttr && withAttr.getAttribute('data-notes').trim()) return withAttr.getAttribute('data-notes').trim();
  const el = document.querySelector('aside.notes, template#notes, script[type="text/x-notes"]');
  if (!el) return null;
  const t = (el.localName === 'template' ? el.content.textContent : el.textContent).replace(/[ \t]+\n/g, '\n').trim();
  return t || null;
}

/**
 * PowerPoint theme colours (a:clrScheme) from the CSS custom properties --pptx-<slot> on :root (theme/base.css maps
 * them to the design tokens). Only slots that resolve to an opaque colour are returned; null when none is set.
 */
function themeColorsOf() {
  const slots = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  const st = getComputedStyle(document.documentElement);
  const colors = {};
  for (const k of slots) {
    const v = st.getPropertyValue(`--pptx-${k}`).trim();
    if (!v) continue;
    const c = parseColor(v);
    if (c && c.alpha >= 1) colors[k] = c.color;
    else lint('warn', 'theme-color', `--pptx-${k}: ${v} is not an opaque colour (ignored)`, ROOT);
  }
  return Object.keys(colors).length ? { colors } : null;
}

function extractImpl(opts) {
  const root = document.querySelector('main.slide');
  if (!root) throw new Error('no <main class="slide"> element in the page');
  beginRun(root);
  TREC = new Map();
  AABB = new Map();
  G_CACHE = new Map();
  CHECKED_AABB = new Set();
  OUT = { background: null, elements: [], images: [] };
  CTX = {
    cur: root,
    lint: (sev, rule, msg, where) => lint(sev, rule, msg, where === undefined ? CTX.cur : where),
    stats: { verified: 0, lineChecks: [] },
    verifyBaselines: opts.verifyBaselines !== false,
    verifyAllLines: !!opts.verifyAllLines,
    weightUse: new Map(),
    cssFamily: opts.cssFamily || null,
    // agent-facing names of the CSS families (cmap.mjs familyLabels): lint text never calls a stand-in the profile font
    familyLabels: opts.familyLabels || {},
    faceWeights: opts.faceWeights || [],
    kitWeights: opts.kitWeights || [],
    hasItalic: !!opts.hasItalic,
    slideW: opts.slideW || 1280,
    slideH: opts.slideH || 720,
    rootOpaque: false,
    titleSeen: false,
  };
  const q0 = root.getBoundingClientRect();
  ORIGIN = { x: q0.left, y: q0.top };
  if (Math.abs(q0.left) > 0.01 || Math.abs(q0.top) > 0.01) lint('warn', 'slide-origin', `main.slide is at ${q0.left},${q0.top}, not at the page origin`, root);
  if (Math.abs(q0.width - CTX.slideW) > 0.01 || Math.abs(q0.height - CTX.slideH) > 0.01) lint('error', 'slide-size', `main.slide is ${q0.width}x${q0.height}, not ${CTX.slideW}x${CTX.slideH}`, root);
  for (const el of [document.documentElement, document.body]) {
    const s = getComputedStyle(el);
    if (hasTransformStyle(s) || parseFloat(s.zoom || '1') !== 1) lint('error', 'transform', `<${el.localName}> is transformed/zoomed`, el.localName);
  }
  const restore = neutraliseTransforms();
  let notes = null;
  try {
    CS_CACHE = new Map();
    const q = root.getBoundingClientRect();
    ORIGIN = { x: q.left, y: q.top };
    const rb = parseColor(cs(root).backgroundColor);
    CTX.rootOpaque = !!(rb && rb.alpha >= 1) || (cs(root).backgroundImage && cs(root).backgroundImage !== 'none');
    lintStyles();
    paintStackingContext(root);
    notes = notesOf();
    // table-cell runs and chart text resolve to faces too (extractText only sees text elements)
    const useWeight = (w, path) => {
      if (!Number.isFinite(w) || !CTX.faceWeights.length || CTX.faceWeights.includes(w)) return;
      const u = CTX.weightUse.get(w) || [];
      u.push(path);
      CTX.weightUse.set(w, u);
    };
    for (const e of OUT.elements) {
      if (e.kind === 'table') {
        const ws = new Set();
        for (const row of e.cells) for (const c of row) if (!c.covered) for (const pp of c.paragraphs) for (const r of pp.runs) if (!r.break) ws.add(r.fontWeight);
        for (const w of ws) useWeight(w, e.id);
      } else if (e.kind === 'chart' && e.spec) {
        const ws = new Set([Number(e.spec.fontCssWeight ?? 400)]);
        if (e.spec.dataLabels && e.spec.dataLabels.show !== false && e.spec.dataLabels.cssWeight !== undefined) ws.add(Number(e.spec.dataLabels.cssWeight));
        for (const w of ws) useWeight(w, e.id);
      }
    }
    for (const [w, paths] of CTX.weightUse) {
      const kinds = new Map();
      for (const pth of paths) {
        const k = /::table$/.test(pth) ? 'table' : /::chart$/.test(pth) ? 'chart' : 'text';
        kinds.set(k, (kinds.get(k) || 0) + 1);
      }
      const what = [...kinds].map(([k, n]) => `${n} ${k} element(s)`).join(', ');
      // a weight the kit has no face for in ANY profile is an authoring mistake (500, 900, `bolder` on 800 …); a kit
      // weight this profile lacks (malgun: 600/800) is drawn with the nearest face BY DESIGN — a note, not a fault
      if (CTX.kitWeights.length && !CTX.kitWeights.includes(w)) {
        lint('error', 'font-weight', `font-weight ${w} is not a kit weight: ${what} — use ${CTX.kitWeights.join(', ')} (AUTHORING §4.1)`, paths[0]);
      } else {
        lint('warn', 'font-weight', `font-weight ${w} is not a fonts.json face weight (${CTX.faceWeights.join('/')}): ${what}; the builder resolves the nearest face — expected in this profile (AUTHORING §4.1)`, paths[0]);
      }
    }
    // group opacity is applied per object in PowerPoint
    const perAncestor = new Map();
    for (const e of OUT.elements) {
      for (let a = e._src; a && a !== document.documentElement; a = a.parentElement) {
        if (parseFloat(cs(a).opacity) < 1) perAncestor.set(a, (perAncestor.get(a) || 0) + 1);
      }
    }
    for (const [a, n] of perAncestor) if (n > 1) lint('warn', 'group-opacity', `opacity ${cs(a).opacity} on a group of ${n} objects is applied to each object (overlaps differ from CSS group opacity)`, a);
  } finally {
    restore();
    endMeas();
    CS_CACHE = new Map();
  }
  // unique ids (defensive)
  const seen = new Map();
  const elements = OUT.elements.map((e) => {
    const { _src, ...rest } = e;
    const n = seen.get(rest.id) || 0;
    seen.set(rest.id, n + 1);
    if (n) rest.id = `${rest.id}#${n + 1}`;
    return rest;
  });
  // components for the builder's PowerPoint groups (docs/AUTHORING.md §12): every box with its own paint that holds
  // other objects, and every [data-group] element; members = IR ids of the objects inside it (own shapes included).
  // Computed here because DOM ancestry is exact (an id'd element restarts the path, so paths alone cannot tell).
  const painted = new Set();
  OUT.elements.forEach((e) => {
    if (e.kind === 'shape' && e._src && /::(bg\d*|border-(top|right|bottom|left))$/.test(e.id)) painted.add(e._src);
  });
  const comps = new Map();
  OUT.elements.forEach((e, k) => {
    for (let a = e._src; a && a.nodeType === 1 && a !== root && root.contains(a); a = a.parentElement) {
      const hint = a.hasAttribute('data-group');
      if (!hint && !painted.has(a)) continue;
      let c = comps.get(a);
      if (!c) {
        c = { id: pathOf(a), name: hint ? (a.getAttribute('data-group').trim() || null) : null, hint, members: [] };
        comps.set(a, c);
      }
      c.members.push(elements[k].id);
    }
  });
  const components = [...comps.values()].filter((c) => c.members.length >= 2);
  // data-layout on main.slide = the slide layout slides share (background, repeated chrome, title placeholder)
  const layoutAttr = root.getAttribute('data-layout');
  return {
    background: OUT.background,
    elements,
    notes,
    components,
    layout: layoutAttr && layoutAttr.trim() ? layoutAttr.trim() : null,
    theme: themeColorsOf(),
    lint: LINT.map(({ _k, ...l }) => l),
    images: OUT.images,
    stats: { baselineProbes: CTX.stats.verified, elements: elements.length, lineChecks: CTX.stats.lineChecks, lineSkips: CTX.stats.lineSkips || 0 },
  };
}

window.__pptx = {
  ready: readyImpl,
  fingerprint: fingerprintImpl,
  verifyFonts: () => {
    const root = document.querySelector('main.slide');
    if (!root) throw new Error('no <main class="slide"> element in the page');
    beginRun(root);
    const r = verifyFontsImpl(root);
    // visible text nodes, for the CDP platform-font check (CSS.getPlatformFontsForNode on a TEXT node reports exactly
    // the fonts of that node; on an element Blink aggregates two levels of descendants)
    const nodes = [];
    const paths = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const p = n.parentElement;
      if (!p || !n.data.trim()) continue;
      if (p.checkVisibility && !p.checkVisibility()) continue;
      nodes.push(n);
      paths.push(pathOf(p));
    }
    window.__pptxTextEls = nodes;
    return { ...r, textElPaths: paths };
  },
  extract: extractImpl,
  documentLint: documentLintImpl, // Noah: 05-document.js (script / stylesheet / remote-url / dom-size lints)
};
