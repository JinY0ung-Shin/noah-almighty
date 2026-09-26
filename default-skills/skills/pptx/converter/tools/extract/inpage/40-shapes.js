// In-page extractor code, part 4: box decorations → IR shapes; <img>/<svg> → IR images; [data-chart] → IR charts.

function sideInfo(el, side) {
  const s = cs(el);
  const S = SIDE[side];
  const style = s[`border${S}Style`];
  const w = style === 'none' || style === 'hidden' ? 0 : px(s[`border${S}Width`]);
  const c = parseColor(s[`border${S}Color`]) || { color: '000000', alpha: 0 };
  return { style, w, color: c.color, alpha: c.alpha, visible: w > 0 && c.alpha > 0 };
}

function dashOf(style, problems) {
  if (style === 'dashed') return 'dashed';
  if (style === 'dotted') return 'dotted';
  if (style !== 'solid') problems.add(`border-style ${style} is drawn as solid`);
  return 'solid';
}

/**
 * Own paint of an element box (background, border, box-shadow) → partial IR shape records (untransformed layout
 * coordinates, paint order). opts.noBorder: the element's border is painted elsewhere (collapsed table).
 * opts.noFill: the fill goes elsewhere (slide background).
 */
function ownShapes(el, ctx, opts = {}) {
  const out = [];
  if (!isVisible(el)) return out;
  const s = cs(el);
  const box = rectOf(el);
  if (box.w <= 0 || box.h <= 0) return out;
  const problems = new Set();

  // ---- geometry
  const rad = usedRadii(el, box);
  let geometry = 'rect';
  let radiusPx = 0;
  if (rad.zero) geometry = 'rect';
  else if (rad.ellipse) geometry = 'ellipse';
  else if (rad.uniform) {
    const r = rad.corners[0][0];
    if (Math.abs(box.w - box.h) < 0.01 && r >= box.w / 2 - 0.01) geometry = 'ellipse';
    else { geometry = 'roundRect'; radiusPx = r; }
  } else {
    ctx.lint('error', 'border-radius', `non-uniform/elliptical border-radius (${rad.raw.join(' / ')}) is not a PowerPoint roundRect`, el);
    const rs = rad.corners.map(([rx, ry]) => Math.min(rx, ry)).sort((a, b) => a - b);
    radiusPx = rs[1];
    geometry = radiusPx > 0 ? 'roundRect' : 'rect';
  }

  // ---- border
  const sides = { top: sideInfo(el, 'top'), right: sideInfo(el, 'right'), bottom: sideInfo(el, 'bottom'), left: sideInfo(el, 'left') };
  const vis = Object.values(sides).filter((x) => x.visible);
  let line = null;
  let sideRects = [];
  if (!opts.noBorder && vis.length) {
    const t = sides.top;
    const uniform = Object.values(sides).every((x) => x.visible && x.w === t.w && x.style === t.style && x.color === t.color && x.alpha === t.alpha);
    if (uniform) line = { widthPx: r6(t.w), color: t.color, alpha: t.alpha, dash: dashOf(t.style, problems) };
    else {
      if (!rad.zero) problems.add('non-uniform border on a rounded box: per-side border rectangles ignore the radius');
      for (const [side, x] of Object.entries(sides)) {
        if (!x.visible) continue;
        if (x.style !== 'solid') problems.add(`per-side ${x.style} border is drawn as a solid rectangle`);
        const r = side === 'top' ? { x: box.x, y: box.y, w: box.w, h: x.w }
          : side === 'bottom' ? { x: box.x, y: box.y + box.h - x.w, w: box.w, h: x.w }
          : side === 'left' ? { x: box.x, y: box.y, w: x.w, h: box.h }
          : { x: box.x + box.w - x.w, y: box.y, w: x.w, h: box.h };
        sideRects.push({ side, box: r, fill: { type: 'solid', color: x.color, alpha: x.alpha } });
      }
    }
  }

  // ---- shadow
  const shadows = parseShadows(s.boxShadow);
  const outer = shadows.filter((x) => !x.inset && x.alpha > 0);
  if (shadows.length > 1) ctx.lint('warn', 'multiple-box-shadows', `${shadows.length} box-shadows: only the first outer shadow is converted`, el);
  if (shadows.some((x) => x.inset)) ctx.lint('warn', 'inset-box-shadow', 'inset box-shadow is not converted', el);
  let shadow = null;
  if (outer.length) {
    const o = outer[0];
    shadow = { offsetXPx: r6(o.offsetXPx), offsetYPx: r6(o.offsetYPx), blurPx: r6(o.blurPx), spreadPx: r6(o.spreadPx), color: o.color, alpha: o.alpha };
    if (o.spreadPx !== 0) ctx.lint('warn', 'shadow-spread', `box-shadow spread ${o.spreadPx}px cannot be represented (dropped)`, el);
  }

  // ---- fills (background-color below background-image layers; the first listed layer is on top)
  const fills = [];
  const bgc = parseColor(s.backgroundColor);
  const pbox = paddingBoxOf(el);
  const layers = s.backgroundImage && s.backgroundImage !== 'none' ? splitTop(s.backgroundImage) : [];
  const grads = [];
  for (const layer of layers.slice().reverse()) {
    const g = parseGradientLayer(layer, pbox);
    for (const p of g.problems) problems.add(p);
    if (g.kind === 'none') continue;
    if (g.kind === 'url') { ctx.lint('error', 'background-image-url', 'background-image: url() is not converted', el); continue; }
    if (g.kind === 'radial' || g.kind === 'conic') { ctx.lint('error', 'gradient-kind', `${g.kind} gradients are not converted`, el); continue; }
    if (!g.fill) { ctx.lint('error', 'background-image', `unparsed background-image layer ${layer.slice(0, 80)}`, el); continue; }
    grads.push(g.fill);
  }
  if (grads.length) {
    const bi = (v) => splitTop(v || '').some((x) => !/^(auto|auto auto|0% 0%|0px 0px|left top|repeat|padding-box|border-box)$/.test(x));
    if (bi(s.backgroundSize) || bi(s.backgroundPosition)) problems.add('background-size/position on a gradient is ignored');
    if (splitTop(s.backgroundClip).some((x) => x !== 'border-box')) problems.add('background-clip other than border-box is ignored');
    if (splitTop(s.backgroundClip).some((x) => x === 'text')) ctx.lint('error', 'background-clip-text', 'background-clip: text is not converted', el);
  }
  const opaqueGrad = grads.length && grads[0].stops.every((st) => st.alpha >= 1);
  if (bgc && bgc.alpha > 0 && !(grads.length && opaqueGrad)) fills.push({ type: 'solid', color: bgc.color, alpha: bgc.alpha });
  fills.push(...grads);
  if (grads.length > 1) problems.add('several background-image layers are emitted as stacked shapes');
  if (opts.noFill) fills.length = 0;
  // slide root: its bottom fill layer is the slide background (composited over the page canvas when translucent,
  // as the reference screenshot shows it); the layers above it become full-slide shapes; its shadow is off-slide
  let first = 0;
  if (opts.slideRoot) {
    out.background = fills.length ? overCanvas(fills[0]) : undefined;
    first = fills.length ? 1 : 0;
    shadow = null;
  }
  const emitted = fills.slice(first);

  // ---- records: first shape carries the shadow and (when only one fill) the line
  const mk = (suffix, fill, ln, sh, b = box, geom = geometry, r = radiusPx) => ({
    kind: 'shape', _suffix: suffix, box: b, geometry: geom, radiusPx: r6(geom === 'roundRect' ? r : 0),
    fill, line: ln, shadow: sh,
  });
  const sfx = (i) => (i + first === 0 ? '::bg' : `::bg${i + first + 1}`);
  if (emitted.length <= 1) {
    if (emitted.length || line || shadow) out.push(mk(emitted.length ? sfx(0) : '::bg', emitted[0] || null, line, shadow));
  } else {
    emitted.forEach((f, i) => out.push(mk(sfx(i), f, i === emitted.length - 1 ? line : null, i === 0 ? shadow : null)));
  }
  for (const sr of sideRects) out.push(mk(`::border-${sr.side}`, sr.fill, null, null, sr.box, 'rect', 0));
  if (shadow && out.length) {
    const f = fills[0];
    if (!f || (f.type === 'solid' && f.alpha < 1) || (f.type === 'linear' && f.stops.some((x) => x.alpha < 1))) {
      ctx.lint('warn', 'shadow-translucent', 'box-shadow on a box without an opaque fill: PowerPoint casts it from the drawn pixels, CSS from the whole border box', el);
    }
  }
  for (const p of problems) ctx.lint('warn', 'shape', p, el);
  return out;
}

/** Opaque colour of the page canvas below main.slide (html/body background, else Chromium's white). */
function canvasColor() {
  let K = { color: 'FFFFFF', alpha: 1 };
  for (const el of [document.documentElement, document.body]) {
    const c = parseColor(cs(el).backgroundColor);
    if (c && c.alpha > 0) K = { color: blendHex(c.color, c.alpha, K.color), alpha: 1 };
  }
  return K;
}

/** hex colour `c` with alpha `a` over opaque hex `k` */
function blendHex(c, a, k) {
  const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const x = rgb(c), y = rgb(k);
  return x.map((v, i) => HEX2(v * a + y[i] * (1 - a))).join('');
}

/** A slide background fill made opaque over the page canvas (PowerPoint's slide background has nothing below it). */
function overCanvas(f) {
  if (!f) return f;
  const K = canvasColor().color;
  if (f.type === 'solid') return f.alpha >= 1 ? f : { type: 'solid', color: blendHex(f.color, f.alpha, K), alpha: 1 };
  if (f.stops.every((st) => st.alpha >= 1)) return f;
  // compositing a premultiplied-linear gradient over a constant colour is linear between the stops: exact
  return { ...f, stops: f.stops.map((st) => ({ pos: st.pos, color: blendHex(st.color, st.alpha, K), alpha: 1 })) };
}

/** Background fill of the slide when main.slide paints none: body/html (Chromium paints them on the canvas). */
function slideBackground(ctx) {
  for (const el of [document.body, document.documentElement]) {
    const s = cs(el);
    const layers = s.backgroundImage && s.backgroundImage !== 'none' ? splitTop(s.backgroundImage) : [];
    for (const layer of layers) {
      const g = parseGradientLayer(layer, paddingBoxOf(ROOT));
      if (g.fill) {
        if (layers.length > 1) ctx.lint('warn', 'background', 'only the top background-image layer of the page is converted', el);
        const f = g.fill;
        return f.stops.every((st) => st.alpha >= 1) ? f
          : { ...f, stops: f.stops.map((st) => ({ pos: st.pos, color: blendHex(st.color, st.alpha, 'FFFFFF'), alpha: 1 })) };
      }
      if (g.kind === 'url') ctx.lint('error', 'background-image-url', 'page background-image: url() is not converted', el);
      else if (g.kind === 'radial' || g.kind === 'conic') ctx.lint('error', 'gradient-kind', `${g.kind} page background is not converted`, el);
    }
  }
  return { type: 'solid', ...canvasColor() }; // html/body background colour, or Chromium's white canvas
}

// ------------------------------------------------------------------------------------------ images
// SVG presentation properties (SVG 2 §6.6 / "presentation attributes"). The serializer compares their computed values
// in the page with the values the same markup gets STANDALONE (no page CSS) and writes only the differences back as
// presentation attributes — so an author-compliant icon keeps its original markup byte for byte (+ xmlns/size).
const SVG_PAINT_PROPS = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color']);
const SVG_LENGTH_PROPS = new Set(['stroke-width', 'stroke-dashoffset', 'font-size', 'letter-spacing', 'word-spacing', 'baseline-shift']);
const SVG_PRES_PROPS = ['display', 'visibility', 'opacity', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'clip-rule', 'clip-path', 'mask', 'filter', 'stop-color', 'stop-opacity', 'flood-color', 'flood-opacity', 'lighting-color',
  'paint-order', 'vector-effect', 'shape-rendering', 'marker-start', 'marker-mid', 'marker-end', 'mix-blend-mode',
  'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'font-family', 'font-size', 'font-weight',
  'font-style', 'font-stretch', 'letter-spacing', 'word-spacing', 'text-decoration', 'text-rendering', 'writing-mode',
  'direction', 'font-kerning', 'font-variant-ligatures', 'font-feature-settings', 'font-variant-numeric',
  'font-variant-east-asian', 'font-variation-settings', 'transform', 'color-interpolation',
  'color-interpolation-filters', 'image-rendering', 'overflow'];
// CSS-only properties (not SVG presentation attributes): written into a style attribute
const SVG_CSS_ONLY = new Set(['font-kerning', 'font-variant-ligatures', 'font-feature-settings', 'font-variant-numeric',
  'font-variant-east-asian', 'font-variation-settings']);
// the outer <svg>'s own opacity/visibility/display/transform/blend belong to the IR element, not to the picture
const SVG_ROOT_SKIP = new Set(['display', 'visibility', 'opacity', 'transform', 'mix-blend-mode', 'filter', 'clip-path', 'mask', 'overflow']);
// content copied into <defs> (a <symbol> drawn through <use>, a gradient) inherits from where it is USED, not from its
// live original's ancestors: only its non-inherited properties are compared
const SVG_NON_INHERITED = new Set(['display', 'opacity', 'clip-path', 'mask', 'filter', 'stop-color', 'stop-opacity',
  'flood-color', 'flood-opacity', 'lighting-color', 'transform', 'overflow', 'mix-blend-mode', 'vector-effect',
  'alignment-baseline', 'baseline-shift', 'text-decoration']);
// text layout properties matter only when the SVG has text (they always differ: the page body sets the font)
const SVG_TEXT_ONLY = new Set(['text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift', 'font-family',
  'font-size', 'font-weight', 'font-style', 'font-stretch', 'letter-spacing', 'word-spacing', 'text-decoration',
  'text-rendering', 'writing-mode', 'direction', 'font-kerning', 'font-variant-ligatures', 'font-feature-settings',
  'font-variant-numeric', 'font-variant-east-asian', 'font-variation-settings']);
const SVG_NS_URI = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Computed SVG property value → presentation-attribute syntax (hex colours, unitless px). null = keep as is. */
function svgAttrValue(prop, v, liveStyle, problems) {
  if (SVG_PAINT_PROPS.has(prop)) {
    if (/^(none|currentcolor)$/i.test(v) || /^url\(/i.test(v)) return { v: v.replace(/url\("([^"]*)"\)/, 'url($1)') };
    const c = parseColor(v);
    if (!c) return { v };
    const out = { v: '#' + c.color };
    if (c.alpha < 1) {
      const op = prop === 'fill' ? 'fill-opacity' : prop === 'stroke' ? 'stroke-opacity' : prop === 'stop-color' ? 'stop-opacity' : prop === 'flood-color' ? 'flood-opacity' : null;
      if (op) out.extra = [op, String(r6(parseFloat(liveStyle.getPropertyValue(op) || '1') * c.alpha))];
      else problems.add(`translucent ${prop} in SVG content`);
    }
    return out;
  }
  if (SVG_LENGTH_PROPS.has(prop)) return { v: v.replace(/(-?[\d.e+]+)px\b/g, '$1') };
  if (prop === 'stroke-dasharray') return { v: v === 'none' ? 'none' : v.replace(/px/g, '').replace(/,\s*/g, ' ') };
  if (prop === 'transform') {
    problems.add('CSS transform on SVG content (baked into the SVG as a matrix, transform-origin not applied)');
    return { v };
  }
  return { v };
}

/** Ids referenced by an element (href / xlink:href / url(#id) in attributes and style). */
function svgRefs(el) {
  const ids = [];
  for (const a of el.attributes) {
    const v = a.value;
    if ((a.localName === 'href') && v.startsWith('#')) ids.push(v.slice(1));
    for (const m of v.matchAll(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/g)) ids.push(m[1]);
  }
  return ids;
}

/**
 * Self-contained markup of an inline <svg>: the ORIGINAL markup plus (a) xmlns, explicit width/height of the content
 * box and the viewBox, (b) copies of elements it references outside itself (<use href>, url(#…) paint servers,
 * recursively) in a <defs>, (c) presentation attributes for every property whose computed value in the page differs
 * from the standalone value (page CSS, currentColor, inherited colour…), written in hex / unitless form.
 * Returns {markup, resolved: [property names that had to be resolved]}.
 */
function serializeSvg(svg, w, h, problems) {
  const doc = svg.ownerDocument;
  const clone = svg.cloneNode(true);
  // (b) external references: copy the referenced elements into a <defs> (live originals kept for the comparison)
  const liveOf = new Map(); // clone element → live element
  const pair = (c, l) => {
    const cs_ = [c, ...c.querySelectorAll('*')], ls = [l, ...l.querySelectorAll('*')];
    cs_.forEach((x, i) => { if (ls[i]) liveOf.set(x, ls[i]); });
  };
  pair(clone, svg);
  let defs = null;
  const copied = new Set(); // clone elements that are copies of referenced content
  for (let guard = 0; guard < 20; guard++) {
    let added = 0;
    for (const e of [clone, ...clone.querySelectorAll('*')]) {
      for (const id of svgRefs(e)) {
        if (clone.querySelector('#' + CSS.escape(id))) continue;
        const ref = doc.getElementById(id);
        if (!ref || !(ref instanceof SVGElement)) { problems.add(`SVG references missing #${id}`); continue; }
        if (!defs) { defs = doc.createElementNS(SVG_NS_URI, 'defs'); clone.insertBefore(defs, clone.firstChild); }
        const copy = ref.cloneNode(true);
        defs.appendChild(copy);
        pair(copy, ref);
        for (const x of [copy, ...copy.querySelectorAll('*')]) copied.add(x);
        added++;
      }
    }
    if (!added) break;
  }
  // (a) root: drop layout CSS (style attribute), explicit size, viewBox, namespaces
  clone.removeAttribute('style');
  clone.setAttribute('width', String(r6(w)));
  clone.setAttribute('height', String(r6(h)));
  if (!clone.getAttribute('viewBox') && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) {
    const vb = svg.viewBox.baseVal;
    clone.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
  }
  // (c) standalone twin inside a shadow root (page stylesheets do not apply; `all: initial` blocks inheritance)
  const host = document.createElement('x-pptx-svghost');
  host.style.cssText = 'all: initial; position: absolute; left: -100000px; top: 0; display: block';
  document.documentElement.appendChild(host);
  const twin = clone.cloneNode(true);
  host.attachShadow({ mode: 'open' }).appendChild(twin);
  const outs = [clone, ...clone.querySelectorAll('*')];
  const twins = [twin, ...twin.querySelectorAll('*')];
  const isCopied = outs.map((o) => copied.has(o));
  const resolved = new Set();
  const hasText = !!clone.querySelector('text, tspan, textPath');
  try {
    outs.forEach((O, i) => {
      const T = twins[i];
      const L = liveOf.get(O);
      if (!T || !L) return;
      const ls = getComputedStyle(L);
      if (ls.filter && ls.filter !== 'none' && i > 0) problems.add('SVG content uses filter (PowerPoint SVG rendering may differ; the PNG fallback is exact)');
      for (const p of SVG_PRES_PROPS) {
        if (i === 0 && SVG_ROOT_SKIP.has(p)) continue;
        if (isCopied[i] && !SVG_NON_INHERITED.has(p)) continue;
        if (!hasText && SVG_TEXT_ONLY.has(p)) continue;
        const lv = ls.getPropertyValue(p);
        const tv = getComputedStyle(T).getPropertyValue(p); // re-read: attributes set on ancestors propagate
        if (lv === tv || !lv) continue;
        const a = SVG_CSS_ONLY.has(p) ? { v: lv } : svgAttrValue(p, lv, ls, problems);
        for (const E of [O, T]) {
          if (SVG_CSS_ONLY.has(p)) { E.style.setProperty(p, a.v); continue; }
          E.style.removeProperty(p);
          if (E.getAttribute('style') === '') E.removeAttribute('style');
          E.setAttribute(p, a.v);
          if (a.extra) { E.style.removeProperty(a.extra[0]); E.setAttribute(a.extra[0], a.extra[1]); }
        }
        resolved.add(p);
      }
    });
  } finally {
    host.remove();
  }
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', SVG_NS_URI);
  const markupHasXlink = [clone, ...clone.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => a.namespaceURI === XLINK_NS));
  if (markupHasXlink && !clone.getAttribute('xmlns:xlink')) clone.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xlink', XLINK_NS);
  if (hasText) problems.add('text inside an SVG is rasterised/kept as SVG, not editable text');
  return { markup: new XMLSerializer().serializeToString(clone), resolved: [...resolved] };
}

/** <img> / inline <svg> → partial IR image record + raster job. box = content box (where the pixels are). */
function imageRecord(el, ctx) {
  const problems = new Set();
  const cb = contentBoxOf(el);
  const rec = { kind: 'image', box: cb, src: null, svg: null, alt: '' };
  const job = { w: cb.w, h: cb.h };
  if (cb.w <= 0 || cb.h <= 0) return null;
  if (isOuterSvg(el)) {
    const title = el.querySelector('title');
    rec.alt = el.getAttribute('aria-label') || (title ? title.textContent.trim() : '');
    job.type = 'svg';
    const ser = serializeSvg(el, cb.w, cb.h, problems);
    job.markup = ser.markup;
    job.baseUrl = document.baseURI;
    if (ser.resolved.length) problems.add(`SVG presentation properties set by page CSS / inheritance were resolved into the markup: ${ser.resolved.join(', ')} (author the icon self-contained)`);
  } else {
    rec.alt = el.getAttribute('alt') || '';
    const src = el.currentSrc || el.src || '';
    let u = null;
    try { u = new URL(src, document.baseURI); } catch (e) { u = null; }
    if (!u || (u.protocol !== 'data:' && u.host !== location.host)) {
      ctx.lint('error', 'external-image', `image source ${String(src).slice(0, 120)} is outside the deck (the converter has no network; use ../assets/<file>)`, el);
      return null;
    }
    if (!el.complete || !el.naturalWidth) {
      ctx.lint('error', 'image-load', `image ${String(src).slice(0, 120)} did not load`, el);
      return null;
    }
    const s = cs(el);
    job.type = 'img';
    job.url = u.href;
    job.style = { objectFit: s.objectFit, objectPosition: s.objectPosition, imageRendering: s.imageRendering };
    if (u.protocol !== 'data:' && /\.svg$/i.test(u.pathname)) job.svgPath = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    // rounded clip of the replaced content (inner radius = outer radius − border)
    const rad = usedRadii(el, rectOf(el));
    if (!rad.zero) {
      const bw = borderWidths(el);
      const cr = rad.corners;
      const inner = [[cr[0][0] - bw.l, cr[0][1] - bw.t], [cr[1][0] - bw.r, cr[1][1] - bw.t], [cr[2][0] - bw.r, cr[2][1] - bw.b], [cr[3][0] - bw.l, cr[3][1] - bw.b]]
        .map(([x, y]) => [Math.max(0, x), Math.max(0, y)]);
      job.style.borderRadius = `${inner.map((c) => c[0] + 'px').join(' ')} / ${inner.map((c) => c[1] + 'px').join(' ')}`;
      problems.add('rounded <img>: the corner clip is baked into the PNG');
    }
  }
  for (const p of problems) ctx.lint('warn', 'image', p, el);
  return { rec, job };
}

// ------------------------------------------------------------------------------------------ charts
/** WCAG 2 relative luminance of 'RRGGBB'. */
function luminance(hex) {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrastRatio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/**
 * The opaque colour a chart is drawn on ('RRGGBB'): its own and its ancestors' background colours composited up
 * to the first opaque one (html is white). null when a gradient or picture lies under it (not one colour).
 */
function chartBackdrop(el) {
  const layers = [];
  for (let e = el; e; e = e.parentElement) {
    const s = cs(e);
    if (s.backgroundImage && s.backgroundImage !== 'none') return null;
    const c = parseColor(s.backgroundColor);
    if (c && c.alpha > 0) {
      layers.push(c);
      if (c.alpha >= 0.999) break;
    }
    if (e === document.documentElement) layers.push({ color: 'FFFFFF', alpha: 1 });
  }
  let rgb = null;
  for (const l of layers.reverse()) {
    const v = [0, 2, 4].map((i) => parseInt(l.color.slice(i, i + 2), 16));
    rgb = rgb ? v.map((x, i) => x * l.alpha + rgb[i] * (1 - l.alpha)) : v;
  }
  return rgb ? rgb.map(HEX2).join('') : null;
}

/**
 * Chart series and point colours need ≥ 3:1 against the chart's background (WCAG 1.4.11 non-text contrast,
 * AUTHORING §8.10): the accent-500 #FF8A3D the kit uses for shapes is only 2.35:1 on white (accent-600 EC6A24:
 * 3.16:1). A warning — the chart converts either way.
 */
function chartContrastLint(el, spec, ctx) {
  const bg = chartBackdrop(el);
  if (!bg) return;
  const seen = new Set();
  const check = (color, what) => {
    const c = String(color || '').replace(/^#/, '').toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(c) || seen.has(c)) return;
    seen.add(c);
    const r = contrastRatio(c, bg);
    if (r < 3 - 1e-9) ctx.lint('warn', 'chart-contrast', `${what} colour ${c} is ${Math.floor(r * 100) / 100}:1 against the chart's background ${bg} — series and points need ≥ 3:1 (AUTHORING §8.10; the accent on white is EC6A24, --c-accent-600)`, el);
  };
  spec.series.forEach((s, i) => {
    const name = s && s.name !== undefined ? `series "${s.name}"` : `series ${i + 1}`;
    if (s && s.color) check(s.color, name);
    const pts = spec.pointColors && spec.pointColors[String(i)];
    if (Array.isArray(pts)) pts.forEach((p) => check(p, `a point of ${name}`));
  });
}

function chartRecord(el, ctx) {
  let spec = null;
  try {
    spec = JSON.parse(el.getAttribute('data-chart'));
  } catch (e) {
    ctx.lint('error', 'chart-spec', `data-chart is not valid JSON: ${e.message}`, el);
    return null;
  }
  const bad = [];
  if (!spec || typeof spec !== 'object') bad.push('not an object');
  else {
    if (!['column', 'bar', 'line', 'pie', 'doughnut'].includes(spec.type)) bad.push(`type ${JSON.stringify(spec.type)}`);
    if (!Array.isArray(spec.categories)) bad.push('categories');
    if (!Array.isArray(spec.series) || !spec.series.length) bad.push('series');
  }
  if (bad.length) ctx.lint('error', 'chart-spec', `invalid ChartSpec (${bad.join(', ')})`, el);
  const box = rectOf(el);
  let resolved = null;
  const raw = el.getAttribute('data-resolved');
  if (!raw) ctx.lint('error', 'chart-resolved', 'chart element has no data-resolved (lib/chart.js must publish the plot rect and value scale)', el);
  else {
    try {
      const r = JSON.parse(raw);
      const p = r.plot || r.plotPx;
      resolved = {
        plotPx: p ? { x: box.x + p.x, y: box.y + p.y, w: p.w, h: p.h } : null,
        valueMin: r.valueMin ?? null,
        valueMax: r.valueMax ?? null,
        majorUnit: r.majorUnit ?? null,
      };
      if (!p) ctx.lint('error', 'chart-resolved', 'data-resolved has no plot rectangle', el);
    } catch (e) {
      ctx.lint('error', 'chart-resolved', `data-resolved is not valid JSON: ${e.message}`, el);
    }
  }
  if (spec && typeof spec === 'object' && Array.isArray(spec.series)) chartContrastLint(el, spec, ctx);
  // content of the chart element other than its SVG preview is lost
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (n.data.trim() && !n.parentElement.closest('svg')) {
      ctx.lint('warn', 'chart-content', 'text inside the chart element (outside its SVG preview) is not converted', el);
      break;
    }
  }
  return { kind: 'chart', box, spec, resolved };
}
