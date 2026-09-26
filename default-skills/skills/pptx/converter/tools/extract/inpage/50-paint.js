// In-page extractor code, part 5: paint order, transforms, record placement.
//
// Paint order follows CSS 2.1 Appendix E as Blink implements it:
//   stacking context S: (1) S's own background/border/shadow, (2) child stacking contexts with z < 0,
//   (3) backgrounds of in-flow non-positioned block-level descendants (tree order), (4) floats (atomically),
//   (5) inline content in tree order: text blocks, replaced elements (img/svg/chart content), atomic inlines,
//       flex/grid items (atomically, order-modified document order), (6) positioned descendants with z-index
//       auto/0 and z = 0 stacking contexts (opacity/transform/… count as z = 0) in tree order, (7) z > 0.
//   "Atomically" / positioned z:auto = painted as if a stacking context, but positioned descendants and real
//   stacking contexts inside it belong to the parent stacking context.
// IR simplifications: a table (cell fills + text) is ONE item placed at its step-3 position; a text block is one
// item at its step-5 position; inline elements never become layers (their text is a run of the paragraph).

let TREC = new Map();    // element → transform values captured before neutralisation
let AABB = new Map();    // element → rendered (transformed) border-box AABB before neutralisation
let G_CACHE = new Map(); // element → accumulated 2D transform (slide coordinates)
let OUT = null;
let CTX = null;
let CHECKED_AABB = new Set();

const TRANSFORM_NEUTRAL = [['transform', 'translate(0px)'], ['rotate', 'none'], ['translate', 'none'], ['scale', 'none']];

function hasTransformStyle(s) {
  return s.transform !== 'none' || s.rotate !== 'none' || s.translate !== 'none' || s.scale !== 'none';
}

/** Capture transforms (pristine) and neutralise them so every rect below is an untransformed layout rect. */
function neutraliseTransforms() {
  const all = [ROOT, ...ROOT.querySelectorAll('*')];
  const saved = [];
  for (const el of all) {
    if (el !== ROOT && el.closest('svg') && !isOuterSvg(el)) continue; // SVG internals are rasterised as a whole
    const s = getComputedStyle(el);
    if (!hasTransformStyle(s)) continue;
    if (s.display === 'inline' && !isReplaced(el)) continue; // transforms do not apply to inline boxes
    TREC.set(el, { transform: s.transform, rotate: s.rotate, translate: s.translate, scale: s.scale, origin: s.transformOrigin });
  }
  // rendered AABBs of everything inside a transformed subtree (for the placement self-check)
  for (const el of TREC.keys()) {
    for (const d of [el, ...el.querySelectorAll('*')]) if (!AABB.has(d)) AABB.set(d, d.getBoundingClientRect());
  }
  for (const el of TREC.keys()) {
    saved.push([el, el.getAttribute('style')]);
    for (const [p, v] of TRANSFORM_NEUTRAL) el.style.setProperty(p, v, 'important');
  }
  return () => {
    for (const [el, st] of saved) {
      if (st === null) el.removeAttribute('style');
      else el.setAttribute('style', st);
    }
  };
}

function accTransform(el) {
  if (!el || el === ROOT.parentElement) return IDENT;
  if (G_CACHE.has(el)) return G_CACHE.get(el);
  let G = el === ROOT || !el.parentElement ? IDENT : accTransform(el.parentElement);
  const rec = TREC.get(el);
  if (rec) {
    const L = localTransformOf(el, rec, rectOf(el));
    for (const p of L.problems) lint('error', 'transform', p, el);
    if (!L.problems.length && !isRigid(L.M)) lint('error', 'transform', `transform other than rotate/translate: transform=${rec.transform} scale=${rec.scale} (emitted unscaled)`, el);
    G = mmul(G, L.M);
  }
  G_CACHE.set(el, G);
  return G;
}

/** Self-check: G applied to the layout box must reproduce Chromium's rendered bounding box. */
function checkAabb(el, G) {
  if (CHECKED_AABB.has(el) || !AABB.has(el)) return;
  CHECKED_AABB.add(el);
  const b = rectOf(el);
  const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]].map(([x, y]) => mapply(G, x, y));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const q = AABB.get(el);
  const act = { x0: q.left - ORIGIN.x, y0: q.top - ORIGIN.y, x1: q.right - ORIGIN.x, y1: q.bottom - ORIGIN.y };
  const err = Math.max(Math.abs(Math.min(...xs) - act.x0), Math.abs(Math.min(...ys) - act.y0), Math.abs(Math.max(...xs) - act.x1), Math.abs(Math.max(...ys) - act.y1));
  if (err > 0.5) lint('warn', 'transform-check', `rotated/translated placement differs from the rendered box by ${r6(err)} px`, el);
}

function opacityOf(el) {
  let o = 1;
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(cs(e).opacity);
  return o;
}

function shiftLines(lines, dx, dy) {
  return lines.map((L) => ({
    top: r6(L.top + dy), bottom: r6(L.bottom + dy), baseline: r6(L.baseline + dy), text: L.text, paragraph: L.paragraph,
    left: L.left === null ? null : r6(L.left + dx), right: L.right === null ? null : r6(L.right + dx), hardBreak: L.hardBreak,
  }));
}

/** Partial record (untransformed layout coordinates) → IR element (contract field order). */
function place(rec, srcEl, suffix) {
  const G = accTransform(srcEl);
  const b = rec.kind === 'text' ? rec.contentBox : rec.box;
  let dx = 0, dy = 0, rot = 0;
  if (!isIdentity(G)) {
    const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const c2 = mapply(G, c.x, c.y);
    dx = c2.x - c.x;
    dy = c2.y - c.y;
    rot = Math.round(rotationOf(G) * 1e4) / 1e4; // the computed matrix has 6 significant digits
    checkAabb(srcEl, G);
  }
  const box = rbox({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });
  const out = { id: pathOf(srcEl) + suffix, kind: rec.kind, box, rotationDeg: r6(rot), opacity: r6(opacityOf(srcEl)) };
  switch (rec.kind) {
    case 'shape':
      out.geometry = rec.geometry;
      out.radiusPx = rec.radiusPx;
      out.fill = rec.fill;
      out.line = rec.line;
      out.shadow = rec.shadow;
      break;
    case 'text':
      out.anchor = rec.anchor;
      out.wrap = rec.wrap;
      out.nowrap = rec.nowrap;
      out.shrinkWrap = rec.shrinkWrap;
      out.paragraphs = rec.paragraphs;
      out.lines = shiftLines(rec.lines, dx, dy);
      out.contentBox = box;
      if (rec.placeholder) out.placeholder = rec.placeholder;
      break;
    case 'image':
      out.src = rec.src;
      out.svg = rec.svg;
      out.alt = rec.alt;
      break;
    case 'table':
      if (Math.abs(rot) > 1e-6) lint('error', 'rotated-table', 'tables cannot be rotated in PowerPoint (graphicFrame rot is ignored)', srcEl);
      out.columnsPx = rec.columnsPx;
      out.rowsPx = rec.rowsPx;
      out.cells = rec.cells.map((row) => row.map((cell) => (cell.covered ? cell : { ...cell, lines: shiftLines(cell.lines, dx, dy) })));
      break;
    case 'chart':
      if (Math.abs(rot) > 1e-6) lint('error', 'rotated-chart', 'charts cannot be rotated in PowerPoint (graphicFrame rot is ignored)', srcEl);
      out.spec = rec.spec;
      out.resolved = rec.resolved ? {
        plotPx: rec.resolved.plotPx ? rbox({ x: rec.resolved.plotPx.x + dx, y: rec.resolved.plotPx.y + dy, w: rec.resolved.plotPx.w, h: rec.resolved.plotPx.h }) : null,
        valueMin: rec.resolved.valueMin, valueMax: rec.resolved.valueMax, majorUnit: rec.resolved.majorUnit,
      } : null;
      break;
    default:
      break;
  }
  // geometry lints on the placed element
  const rad = (Math.abs(rot) * Math.PI) / 180;
  const cw = Math.abs(box.w * Math.cos(rad)) + Math.abs(box.h * Math.sin(rad));
  const ch = Math.abs(box.w * Math.sin(rad)) + Math.abs(box.h * Math.cos(rad));
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  let x0 = cx - cw / 2, x1 = cx + cw / 2, y0 = cy - ch / 2, y1 = cy + ch / 2;
  if (rec.kind === 'text' && Math.abs(rot) < 1e-6) {
    // the glyphs themselves (a nowrap line can run past its box)
    for (const L of out.lines) {
      if (L.left !== null) { x0 = Math.min(x0, L.left); x1 = Math.max(x1, L.right); }
      y0 = Math.min(y0, L.top);
      y1 = Math.max(y1, L.bottom);
    }
  }
  const W = CTX.slideW, H = CTX.slideH;
  if (x0 < -0.5 || y0 < -0.5 || x1 > W + 0.5 || y1 > H + 0.5) {
    lint('error', 'out-of-bounds', `${rec.kind} extends outside the ${W}x${H} slide (${r6(x0)},${r6(y0)} – ${r6(x1)},${r6(y1)})`, out.id);
  }
  out._src = srcEl;
  return out;
}

function push(rec, srcEl, suffix) {
  // a fully transparent object (opacity 0 on it or an ancestor) is invisible in the HTML: not emitted
  if (opacityOf(srcEl) <= 1e-6) return null;
  const out = place(rec, srcEl, suffix);
  OUT.elements.push(out);
  return out;
}

// ------------------------------------------------------------------------------------------ paint walk
function elementChildren(E) {
  const out = [];
  for (const n of E.children) {
    if (/^(script|style|template|noscript)$/.test(n.localName)) continue;
    if (isNone(n)) continue;
    if (isContents(n)) out.push(...elementChildren(n));
    else out.push(n);
  }
  return out;
}

function isInlineContent(el) {
  return isInlineDisplay(el) && !isReplaced(el) && !isChart(el);
}

function isLayerEl(el) {
  if (el === ROOT) return false;
  if (isInlineContent(el)) return false;
  return isStackingContext(el) || isPositioned(el);
}

function collectLayers(S) {
  const res = [];
  let i = 0;
  const visit = (E) => {
    for (const C of elementChildren(E)) {
      if (isInlineContent(C)) {
        const s = cs(C);
        if (s.position === 'relative' && ['top', 'left', 'bottom', 'right'].some((k) => s[k] !== 'auto' && px(s[k]) !== 0)) {
          lint('warn', 'positioned-inline', 'relatively positioned inline text: the offset is not converted', C);
        }
        visit(C);
        continue;
      }
      if (isStackingContext(C)) { res.push({ el: C, sc: true, z: zIndexOf(C), i: i++ }); continue; }
      if (isPositioned(C)) res.push({ el: C, sc: false, z: 0, i: i++ });
      if (!isLeaf(C)) visit(C);
    }
  };
  visit(S);
  return res;
}

function byZ(a, b) {
  return a.z - b.z || a.i - b.i;
}

function paintStackingContext(S) {
  paintOwn(S);
  const layers = collectLayers(S);
  const neg = layers.filter((l) => l.sc && l.z < 0).sort(byZ);
  const zero = layers.filter((l) => !l.sc || l.z === 0);
  const pos = layers.filter((l) => l.sc && l.z > 0).sort(byZ);
  if (S === ROOT && neg.length && !rootIsRealStackingContext() && CTX.rootOpaque) {
    // main.slide is not a stacking context: z < 0 layers paint below its (opaque) background → invisible
    for (const l of neg) lint('warn', 'hidden-negative-z', 'z-index < 0 inside a non-stacking-context slide root is painted behind the slide background (invisible); not emitted', l.el);
  } else {
    for (const l of neg) paintStackingContext(l.el);
  }
  paintFlow(S);
  for (const l of zero) {
    if (l.sc) paintStackingContext(l.el);
    else paintAtomic(l.el);
  }
  for (const l of pos) paintStackingContext(l.el);
}

/** Positioned z:auto boxes, floats, inline-blocks, flex/grid items: own paint + flow content. */
function paintAtomic(el) {
  paintOwn(el);
  paintFlow(el);
}

function paintOwn(el) {
  CTX.cur = el;
  if (el === ROOT) {
    const shapes = ownShapes(el, CTX, { slideRoot: true });
    OUT.background = shapes.background !== undefined ? shapes.background : slideBackground(CTX);
    for (const r of shapes) push(r, el, r._suffix);
    return;
  }
  const collapseTable = isTable(el) && cs(el).borderCollapse === 'collapse';
  for (const r of ownShapes(el, CTX, { noBorder: collapseTable })) push(r, el, r._suffix);
}

function paintFlow(R) {
  if (isLeaf(R)) { paintLeaf(R); return; }
  if (isListTextElement(R)) { emitText({ kind: 'list', el: R }); return; }
  const tk = textBlockKind(R);
  if (tk === 'block') { emitText({ kind: 'block', el: R }); return; }
  if (tk === 'anon') { emitText({ kind: 'anon', el: R, nodes: flowRunNodes(R), onlyItem: true }); return; }
  const L = { bg: [], floats: [], inline: [] };
  walkFlow(R, L);
  for (const it of L.bg) doItem(it);
  for (const it of L.floats) doItem(it);
  for (const it of L.inline) doItem(it);
}

function walkFlow(E, L) {
  const items = flowItems(E);
  const inflow = items.filter((it) => it.type === 'run' || !(isOutOfFlow(it.el) || isFloat(it.el)));
  let k = 0;
  for (const it of items) {
    if (it.type === 'run') {
      if (runHasText(it.nodes)) L.inline.push({ t: 'run', parent: E, nodes: it.nodes, k: k++, onlyItem: inflow.length === 1 });
      else for (const n of it.nodes) if (n.nodeType === 1 && !isLayerEl(n)) L.inline.push({ t: 'atomic', el: n });
      continue;
    }
    const C = it.el;
    if (isLayerEl(C)) continue;
    if (isFloat(C)) { L.floats.push({ t: 'atomic', el: C }); continue; }
    if (isFlexGridItem(C) || isAtomicInline(C)) { L.inline.push({ t: 'atomic', el: C }); continue; }
    // in-flow, non-positioned, block-level
    if (disp(C) === 'list-item' && textBlockKind(C) !== 'block' && cs(C).listStyleType !== 'none') {
      lint('warn', 'list-item-blocks', 'list item with block content: its bullet is not converted (only list items with inline content become bulleted paragraphs)', C);
    }
    L.bg.push({ t: 'own', el: C });
    if (isTable(C)) { L.bg.push({ t: 'leaf', el: C }); continue; }
    if (isLeaf(C)) { L.inline.push({ t: 'leaf', el: C }); continue; }
    if (isListTextElement(C)) { L.inline.push({ t: 'text', spec: { kind: 'list', el: C } }); continue; }
    const tk = textBlockKind(C);
    if (tk === 'block') { L.inline.push({ t: 'text', spec: { kind: 'block', el: C } }); continue; }
    if (tk === 'anon') { L.inline.push({ t: 'text', spec: { kind: 'anon', el: C, nodes: flowRunNodes(C), onlyItem: true } }); continue; }
    walkFlow(C, L);
  }
}

function doItem(it) {
  switch (it.t) {
    case 'own': paintOwn(it.el); break;
    case 'leaf': paintLeaf(it.el); break;
    case 'text': emitText(it.spec); break;
    case 'run': emitText({ kind: 'run', el: it.parent, nodes: it.nodes, k: it.k, onlyItem: it.onlyItem }); break;
    case 'atomic': paintAtomic(it.el); break;
    default: break;
  }
}

function paintLeaf(el) {
  CTX.cur = el;
  if (!isVisible(el) && !isTable(el)) return;
  if (isTable(el)) {
    const { rec, problems } = extractTable(el, CTX);
    for (const p of problems) lint('warn', 'table', p, el);
    push(rec, el, '::table');
  } else if (isChart(el)) {
    const rec = chartRecord(el, CTX);
    if (rec) push(rec, el, '::chart');
  } else if (isImage(el)) {
    const r = imageRecord(el, CTX);
    if (r) {
      const out = push(r.rec, el, '::image');
      if (out) OUT.images.push({ id: out.id, job: r.job });
    }
  } else if (isUnsupported(el)) {
    lint('error', 'unsupported-element', `<${el.localName}> is not converted`, el);
  }
}

/** Inline elements with their own background/border inside a paragraph → shapes per line fragment. */
function inlineBackgrounds(nodes, host) {
  const els = [];
  const walk = (list) => {
    for (const n of list) {
      if (n.nodeType !== 1 || n.localName === 'br' || isAtomicInline(n) || isOutOfFlow(n) || isFloat(n) || !isPureInline(n)) continue;
      els.push(n);
      walk(childNodesFlat(n));
    }
  };
  walk(nodes);
  for (const el of els) {
    if (!hasOwnPaint(el) || !isVisible(el)) continue;
    lint('warn', 'inline-background', 'background/border on inline text is emitted as separate shapes (they do not follow text edits)', el);
    const s = cs(el);
    const bg = parseColor(s.backgroundColor);
    const t = sideInfo(el, 'top');
    const line = t.visible ? { widthPx: r6(t.w), color: t.color, alpha: t.alpha, dash: dashOf(t.style, new Set()) } : null;
    let i = 0;
    for (const q of el.getClientRects()) {
      if (q.width <= 0 || q.height <= 0) continue;
      const rec = { kind: 'shape', box: qrect(q), geometry: 'rect', radiusPx: 0, fill: bg && bg.alpha > 0 ? { type: 'solid', color: bg.color, alpha: bg.alpha } : null, line, shadow: null };
      const rad = usedRadii(el, rec.box);
      if (!rad.zero && rad.uniform) { rec.geometry = 'roundRect'; rec.radiusPx = r6(rad.corners[0][0]); }
      push(rec, el, `::inline-bg${++i}`);
    }
  }
}

function emitText(spec) {
  const host = spec.el;
  CTX.cur = host;
  if (spec.kind !== 'run') TEXT_ROOTS.add(host);
  const G = accTransform(host);
  spec.rotated = Math.abs(rotationOf(G)) > 1e-6;
  const nodes = spec.kind === 'list' ? flowItems(host).flatMap((it) => (it.el ? flowRunNodes(it.el) : [])) : (spec.nodes || flowRunNodes(host));
  if (spec.kind === 'list') for (const it of flowItems(host)) inlineBackgrounds(flowRunNodes(it.el), it.el);
  else inlineBackgrounds(nodes, host);
  const res = extractText(spec, CTX);
  for (const p of res.problems) lint('warn', 'text', p, host);
  const runs = res.rec.paragraphs.flatMap((p) => p.runs.filter((r) => !r.break));
  const visible = runs.some((r) => r.alpha > 0 && r.text.trim() !== '');
  const suffix = spec.kind === 'run' ? `::text${spec.k + 1}` : '::text';
  if (visible && res.rec.lines.length) {
    const out = push(res.rec, host, suffix);
    // overflow: scroll size > client size, or a line ends past the content box
    if (out && (spec.kind === 'block' || spec.kind === 'list' || spec.kind === 'anon')) {
      const ovx = host.scrollWidth > host.clientWidth + 1;
      const ovy = host.scrollHeight > host.clientHeight + 1;
      const cb = contentBoxOf(host);
      const hx = res.rec.lines.some((L) => L.right !== null && L.right > cb.x + cb.w + 0.5);
      if (ovx || ovy || hx) lint('error', 'text-overflow', `text overflows its box (scroll ${host.scrollWidth}x${host.scrollHeight} > client ${host.clientWidth}x${host.clientHeight}${hx ? '; a line ends past the content box' : ''})${overflowFix(res.rec, runs, { vertical: ovy && !ovx && !hx })}`, out.id);
    }
    // bare text beside element children: an anonymous box without an element of its own (AUTHORING §5.1). It has no
    // stable identity or box and, in a flex/grid container, it is an anonymous item whose width is only estimated
    if (out && spec.kind === 'run' && !spec.onlyItem) {
      const bare = runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
      const show = bare.length > 30 ? `${bare.slice(0, 29)}…` : bare;
      lint('error', 'mixed-content', `bare text "${show}" sits beside element children of this ${isFlexGrid(host) ? 'flex/grid container' : 'element'}: wrap it in its own element, e.g. <p>${show}</p> (AUTHORING §5.1)`, host);
    }
  }
  for (const h of res.holes) if (!isLayerEl(h)) paintAtomic(h);
}

/**
 * The fix a text-overflow needs, told apart by what overflows: glyphs taller than the line-height (the malgun
 * profile's 1.33 em content area, AUTHORING §4.2 — a wider or taller box does not help), lines that do not fit a
 * fixed height, or a line wider than its box.
 */
function overflowFix(rec, runs, { vertical }) {
  if (!vertical) return ' — widen the box, shorten the text or break it with <br> (the malgun profile is up to 20 % wider; AUTHORING §4.3)';
  const glyph = Math.max(0, ...rec.lines.map((L) => (Number.isFinite(L.bottom - L.top) ? L.bottom - L.top : 0)));
  const lh = Math.min(...rec.paragraphs.map((p) => p.lineHeightPx));
  const size = Math.max(0, ...runs.filter((r) => r.baseline === 'normal').map((r) => r.sizePx));
  // Chromium reports scroll overflow once the content area exceeds the line box by more than about a pixel: the
  // least line-height that fits = the glyph height − 1 (it reproduces the AUTHORING §4.2 table in both profiles)
  const need = Math.ceil(glyph - 1 - 1e-6);
  if (Number.isFinite(lh) && glyph > 0 && need > lh) {
    return ` — the line-height ${r6(lh)}px is below the ${need}px this profile's glyphs need${size ? ` at ${r6(size)}px` : ''}: raise line-height to at least ${need}px (AUTHORING §4.2 table; the kit uses 1.33 × the size on the 4 px grid) — a wider or taller box does not fix this`;
  }
  return ' — the box is too short for its lines: give it more height, fewer lines or a smaller size (AUTHORING §6: fixed heights must fit in both profiles)';
}

// ------------------------------------------------------------------------------------------ CSS feature lint
function lintStyles() {
  const all = [ROOT, ...ROOT.querySelectorAll('*')];
  for (const el of all) {
    if (el !== ROOT && el.closest('svg') && !isOuterSvg(el)) continue;
    if (el.closest('[data-chart]') && !isChart(el)) continue;
    if (isNone(el)) continue;
    const s = cs(el);
    if (s.filter !== 'none') lint('error', 'filter', `filter: ${s.filter}`, el);
    if (s.backdropFilter && s.backdropFilter !== 'none') lint('error', 'backdrop-filter', `backdrop-filter: ${s.backdropFilter}`, el);
    if (s.mixBlendMode !== 'normal') lint('error', 'mix-blend-mode', `mix-blend-mode: ${s.mixBlendMode}`, el);
    if (s.clipPath !== 'none') lint('error', 'clip-path', `clip-path: ${s.clipPath}`, el);
    if ((s.maskImage && s.maskImage !== 'none') || (s.webkitMaskImage && s.webkitMaskImage !== 'none')) lint('error', 'mask', 'mask-image', el);
    if (s.textShadow !== 'none') lint('error', 'text-shadow', `text-shadow: ${s.textShadow}`, el);
    for (const pe of ['::before', '::after']) {
      const c = getComputedStyle(el, pe).content;
      if (c && c !== 'none' && c !== 'normal') lint('error', 'pseudo-content', `${pe} with content ${c.slice(0, 60)} is not converted`, el);
    }
    if (s.writingMode && s.writingMode !== 'horizontal-tb') lint('error', 'writing-mode', `writing-mode: ${s.writingMode}`, el);
    if (s.zoom && s.zoom !== '1' && s.zoom !== 'normal') lint('error', 'zoom', `zoom: ${s.zoom}`, el);
    if (s.offsetPath && s.offsetPath !== 'none') lint('error', 'transform', `offset-path: ${s.offsetPath}`, el);
    if (s.perspective !== 'none') lint('error', 'transform', `perspective: ${s.perspective}`, el);
    if (s.borderImageSource && s.borderImageSource !== 'none') lint('error', 'border-image', `border-image ${s.borderImageSource.slice(0, 60)} is not converted`, el);
    if (s.outlineStyle && s.outlineStyle !== 'none' && px(s.outlineWidth) > 0) {
      const oc = parseColor(s.outlineColor);
      if (oc && oc.alpha > 0) lint('warn', 'outline', `outline ${s.outlineWidth} ${s.outlineStyle} is not converted`, el);
    }
    if ((s.columnCount && s.columnCount !== 'auto') || (s.columnWidth && s.columnWidth !== 'auto')) {
      lint('error', 'multi-column', `multi-column layout (column-count ${s.columnCount}, column-width ${s.columnWidth}) is not converted`, el);
    }
    // text properties PowerPoint cannot reproduce (warn: the text converts, its layout may differ)
    const tfeat = [];
    if (s.fontVariantNumeric && s.fontVariantNumeric !== 'normal') tfeat.push(`font-variant-numeric: ${s.fontVariantNumeric}`);
    if (s.fontVariantCaps && s.fontVariantCaps !== 'normal') tfeat.push(`font-variant-caps: ${s.fontVariantCaps}`);
    if (s.fontVariantEastAsian && s.fontVariantEastAsian !== 'normal') tfeat.push(`font-variant-east-asian: ${s.fontVariantEastAsian}`);
    if (s.fontFeatureSettings && s.fontFeatureSettings !== 'normal') tfeat.push(`font-feature-settings: ${s.fontFeatureSettings}`);
    if (s.fontVariationSettings && s.fontVariationSettings !== 'normal') tfeat.push(`font-variation-settings: ${s.fontVariationSettings}`);
    if (px(s.wordSpacing) !== 0) tfeat.push(`word-spacing: ${s.wordSpacing}`);
    if (s.hyphens === 'auto') tfeat.push('hyphens: auto');
    const dl = s.textDecorationLine || 'none';
    if (dl !== 'none' && (s.textDecorationStyle !== 'solid' || /overline/.test(dl))) tfeat.push(`text-decoration ${dl} ${s.textDecorationStyle}`);
    if (dl !== 'none' && s.textDecorationColor && parseColor(s.textDecorationColor)?.color !== parseColor(s.color)?.color) tfeat.push(`text-decoration-color ${s.textDecorationColor} (PowerPoint draws the line in the text colour)`);
    if (dl !== 'none' && s.textDecorationThickness && !/^(auto|from-font)$/.test(s.textDecorationThickness)) tfeat.push(`text-decoration-thickness ${s.textDecorationThickness}`);
    const own = el.childNodes && [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim());
    if (tfeat.length && own) lint('warn', 'text-feature', `${tfeat.join('; ')} is not reproduced by PowerPoint text`, el);
    if (own && !isInlineContent(el)) {
      // ::first-letter / ::first-line rules restyle part of the text without DOM nodes the walk could see
      for (const pe of ['::first-letter', '::first-line']) {
        const ps = getComputedStyle(el, pe);
        const diff = ['fontSize', 'fontWeight', 'fontStyle', 'color', 'letterSpacing', 'textTransform', 'fontFamily', 'textDecorationLine']
          .filter((k) => ps[k] !== s[k]);
        if (diff.length) lint('error', 'pseudo-content', `${pe} styling (${diff.join(', ')}) is not converted`, el);
      }
    }
    if (el !== ROOT && isInlineContent(el) && el.localName !== 'br') {
      const hs = px(s.paddingLeft) + px(s.paddingRight) + px(s.marginLeft) + px(s.marginRight) + px(s.borderLeftWidth) + px(s.borderRightWidth);
      if (Math.abs(hs) > 0.01) lint('warn', 'inline-spacing', 'horizontal padding/margin/border on inline text shifts the following text (PowerPoint runs have none)', el);
    }
    if (el !== ROOT && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) {
      // descendants whose border box leaves this clip are cut in Chromium, not in PowerPoint
      const pb = paddingBoxOf(el);
      const rad = usedRadii(el, rectOf(el));
      const bw = borderWidths(el);
      for (const d of el.querySelectorAll('*')) {
        if (isNone(d) || (d.closest('svg') && !isOuterSvg(d)) || isInlineContent(d)) continue;
        const b = rectOf(d);
        if (b.w <= 0 || b.h <= 0) continue;
        if (b.x < pb.x - 0.5 || b.y < pb.y - 0.5 || b.x + b.w > pb.x + pb.w + 0.5 || b.y + b.h > pb.y + pb.h + 0.5) {
          lint('warn', 'overflow-clip', `clipped by an ancestor with overflow ${s.overflowX}/${s.overflowY} (${pathOf(el)}); PowerPoint shows it unclipped`, d);
        } else if (!rad.zero && (hasOwnPaint(d) || isImage(d))) {
          // the ancestor's rounded corners clip this box in Chromium (inner radius = outer − border)
          const [tl, tr, br, bl] = rad.corners;
          const corners = [
            [pb.x, pb.y, tl[0] - bw.l, tl[1] - bw.t], [pb.x + pb.w - (tr[0] - bw.r), pb.y, tr[0] - bw.r, tr[1] - bw.t],
            [pb.x + pb.w - (br[0] - bw.r), pb.y + pb.h - (br[1] - bw.b), br[0] - bw.r, br[1] - bw.b], [pb.x, pb.y + pb.h - (bl[1] - bw.b), bl[0] - bw.l, bl[1] - bw.b],
          ];
          const hit = corners.some(([cx, cy, cw, ch]) => cw > 0.5 && ch > 0.5 && b.x < cx + cw - 0.5 && b.x + b.w > cx + 0.5 && b.y < cy + ch - 0.5 && b.y + b.h > cy + 0.5);
          if (hit) lint('warn', 'rounded-clip', `the rounded corners of ${pathOf(el)} (overflow ${s.overflowX}) clip this box in the HTML; PowerPoint draws its corners square`, d);
        }
      }
    }
  }
  // anything visible outside main.slide is not part of the PowerPoint slide
  for (const el of document.body.children) {
    if (el === ROOT || el.contains(ROOT) || /^(script|style|template|noscript)$/.test(el.localName)) continue;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility !== 'visible') continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && el.localName !== 'aside') lint('warn', 'outside-slide', `<${el.localName}> outside main.slide is rendered but not converted`, el.localName + (el.id ? '#' + el.id : ''));
  }
  // animations make the reference render time-dependent
  try {
    const anims = document.getAnimations().filter((a) => a.playState === 'running');
    if (anims.length) lint('warn', 'animation', `${anims.length} running CSS animation(s)/transition(s): the reference PNG is a single frame`, ROOT);
  } catch (e) { /* ignore */ }
}
