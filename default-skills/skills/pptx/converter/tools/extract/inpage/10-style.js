// In-page extractor code, part 1: box classification (display kinds, stacking contexts, layers, text blocks).

const BLOCK_CONTAINER_DISPLAYS = new Set([
  'block', 'inline-block', 'list-item', 'flow-root', 'table-cell', 'table-caption', 'inline flow-root',
  'block flow', 'block flow-root', 'list-item block', 'inline list-item', 'block list-item', 'flow-root list-item',
]);
const FLEXGRID_DISPLAYS = new Set(['flex', 'inline-flex', 'grid', 'inline-grid', 'block flex', 'inline flex', 'block grid', 'inline grid']);
const ATOMIC_INLINE_DISPLAYS = new Set(['inline-block', 'inline-flex', 'inline-grid', 'inline-table', 'inline flow-root',
  'inline flex', 'inline grid', 'inline table', 'inline list-item']);
const INLINE_TAGS = new Set(['span', 'b', 'strong', 'em', 'i', 'u', 's', 'a', 'code', 'small', 'sup', 'sub', 'br', 'mark',
  'abbr', 'time', 'q', 'cite', 'del', 'ins', 'label', 'data', 'var', 'kbd', 'samp', 'dfn', 'bdi', 'bdo', 'wbr', 'font', 'strike', 'big', 'tt']);
const REPLACED_TAGS = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'object', 'embed', 'input', 'select', 'textarea',
  'button', 'meter', 'progress', 'audio', 'picture', 'math']);
const UNSUPPORTED_TAGS = new Set(['video', 'canvas', 'iframe', 'object', 'embed', 'input', 'select', 'textarea', 'button',
  'meter', 'progress', 'audio', 'math']);

function disp(el) { return cs(el).display; }
function isNone(el) { return disp(el) === 'none'; }
function isContents(el) { return disp(el) === 'contents'; }
function isVisible(el) { return cs(el).visibility === 'visible'; }
function isOutOfFlow(el) { const p = cs(el).position; return p === 'absolute' || p === 'fixed'; }
function isPositioned(el) { return cs(el).position !== 'static'; }
function isFloat(el) { return cs(el).float !== 'none' && !isOutOfFlow(el); }
function isOuterSvg(el) { return el.localName === 'svg' && el instanceof SVGSVGElement && !el.ownerSVGElement; }

function isBlockContainer(el) { return BLOCK_CONTAINER_DISPLAYS.has(disp(el)); }
function isFlexGrid(el) { return FLEXGRID_DISPLAYS.has(disp(el)); }
function isInlineDisplay(el) { return disp(el) === 'inline'; }

/** Nearest ancestor that generates a box (skipping display:contents). */
function boxParent(el) {
  let p = el.parentElement;
  while (p && p !== ROOT && isContents(p)) p = p.parentElement;
  return p;
}

function isFlexGridItem(el) {
  if (el === ROOT || isOutOfFlow(el)) return false;
  const p = boxParent(el);
  return !!p && isFlexGrid(p);
}

// Leaf kinds are atomic in the IR: their subtree is never walked for painting.
function isChart(el) { return el.nodeType === 1 && el.hasAttribute('data-chart'); }
function isImage(el) { return el.localName === 'img' || isOuterSvg(el); }
function isTable(el) { return el.localName === 'table'; }
function isUnsupported(el) { return UNSUPPORTED_TAGS.has(el.localName); }
function isLeaf(el) { return isChart(el) || isImage(el) || isTable(el) || isUnsupported(el); }

function isReplaced(el) { return REPLACED_TAGS.has(el.localName) || isOuterSvg(el); }

/** Atomic inline-level box: inline-block & co., or an inline-level replaced element. */
function isAtomicInline(el) {
  const d = disp(el);
  if (ATOMIC_INLINE_DISPLAYS.has(d)) return true;
  if (d === 'inline' && (isReplaced(el) || isChart(el))) return true;
  return false;
}

/** Does `el` establish a stacking context? (CSS 2.1 E + css-position/css-color/css-transforms/compositing.) */
function isStackingContext(el) {
  if (el === ROOT) return true;
  const s = cs(el);
  const pos = s.position;
  if (pos === 'fixed' || pos === 'sticky') return true;
  if (pos !== 'static' && s.zIndex !== 'auto') return true;
  if (s.zIndex !== 'auto' && isFlexGridItem(el)) return true;
  if (parseFloat(s.opacity) < 1) return true;
  if (s.transform !== 'none' || s.rotate !== 'none' || s.translate !== 'none' || s.scale !== 'none') return true;
  if (s.filter !== 'none' || (s.backdropFilter && s.backdropFilter !== 'none')) return true;
  if (s.mixBlendMode !== 'normal' || s.isolation === 'isolate') return true;
  if (s.clipPath !== 'none') return true;
  if ((s.maskImage && s.maskImage !== 'none') || (s.webkitMaskImage && s.webkitMaskImage !== 'none')) return true;
  if (s.perspective !== 'none') return true;
  if (/opacity|transform|translate|rotate|scale|filter|perspective|clip-path|mask|backdrop|isolation|z-index/.test(s.willChange)) return true;
  if (/paint|layout|strict|content/.test(s.contain)) return true;
  if (s.containerType && s.containerType !== 'normal') return true;
  if (s.viewTransitionName && s.viewTransitionName !== 'none') return true;
  return false;
}

/** True for the root as painted by CSS, i.e. is main.slide itself a stacking context in the page? */
function rootIsRealStackingContext() {
  const saved = ROOT;
  // evaluate the rules without the "el === ROOT" shortcut
  const s = cs(saved);
  const pos = s.position;
  if (pos === 'fixed' || pos === 'sticky') return true;
  if (pos !== 'static' && s.zIndex !== 'auto') return true;
  if (parseFloat(s.opacity) < 1 || s.transform !== 'none' || s.filter !== 'none' || s.isolation === 'isolate') return true;
  if (/paint|layout|strict|content/.test(s.contain)) return true;
  return false;
}

function zIndexOf(el) {
  const z = cs(el).zIndex;
  if (z === 'auto') return 0;
  if (isPositioned(el) || isFlexGridItem(el)) return parseInt(z, 10) || 0;
  return 0;
}

/**
 * Child "boxes" of an element, in DOM order, flattening display:contents and dropping display:none elements,
 * comments and processing instructions. Text nodes are returned as-is.
 */
function childNodesFlat(el) {
  const out = [];
  for (const n of el.childNodes) {
    if (n.nodeType === 3) out.push(n);
    else if (n.nodeType === 1) {
      if (n.localName === 'script' || n.localName === 'style' || n.localName === 'template' || n.localName === 'noscript') continue;
      if (isNone(n)) continue;
      if (isContents(n)) out.push(...childNodesFlat(n));
      else out.push(n);
    }
  }
  return out;
}

function isCollapsibleWhitespaceText(n) {
  if (n.nodeType !== 3) return false;
  const ws = cs(n.parentElement).whiteSpaceCollapse || cs(n.parentElement).whiteSpace;
  if (/preserve|pre|break-spaces/.test(ws) && !/preserve-breaks|pre-line/.test(ws)) return n.data.length === 0;
  return /^[ \t\n\r\f]*$/.test(n.data);
}

/** Pure inline element (display inline, not replaced/atomic) whose subtree is also pure inline. */
function isPureInline(el) {
  if (el.localName === 'br') return true;
  if (!isInlineDisplay(el) || isReplaced(el) || isChart(el)) return false;
  for (const n of childNodesFlat(el)) {
    if (n.nodeType === 3) continue;
    if (isOutOfFlow(n) || isFloat(n)) continue;          // taken out of the inline flow
    if (isAtomicInline(n)) continue;                     // a "hole" inside the text
    if (!isPureInline(n)) return false;
  }
  return true;
}

/**
 * Flow items of a box, in (order-modified for flex/grid) document order:
 *   {type:'el', el}      element child (block-level, float, out-of-flow, flex/grid item, or atomic inline)
 *   {type:'run', nodes}  a maximal run of inline-level content (text, pure inline elements, br, atomic inlines)
 *                        = an anonymous block box (block container) or an anonymous flex/grid item.
 * Whitespace-only runs are dropped.
 */
function flowItems(el) {
  const items = [];
  const flexgrid = isFlexGrid(el);
  let run = null;
  const flush = () => {
    if (run && run.nodes.some((n) => (n.nodeType === 3 ? !isCollapsibleWhitespaceText(n) : true))) items.push(run);
    run = null;
  };
  for (const n of childNodesFlat(el)) {
    if (n.nodeType === 3) {
      if (!run) run = { type: 'run', nodes: [] };
      run.nodes.push(n);
      continue;
    }
    if (flexgrid) {
      // every in-flow element child is a (blockified) flex/grid item; text runs are anonymous items
      flush();
      items.push({ type: 'el', el: n });
      continue;
    }
    if (isOutOfFlow(n) || isFloat(n)) {
      // out-of-flow boxes do not split an inline run (they leave a placeholder only)
      if (run) run.nodes.push(n);
      else items.push({ type: 'el', el: n });
      continue;
    }
    if (n.localName === 'br' || isPureInline(n) || isAtomicInline(n)) {
      if (!run) run = { type: 'run', nodes: [] };
      run.nodes.push(n);
      continue;
    }
    flush();
    items.push({ type: 'el', el: n });
  }
  flush();
  if (flexgrid) {
    // order-modified document order (stable)
    const ord = (it) => (it.type === 'el' ? parseInt(cs(it.el).order, 10) || 0 : 0);
    items.forEach((it, i) => { it._i = i; });
    items.sort((a, b) => ord(a) - ord(b) || a._i - b._i);
  }
  // hoist out-of-flow/float placeholders out of runs (they are painted separately)
  const out = [];
  for (const it of items) {
    if (it.type !== 'run') { out.push(it); continue; }
    const inflow = it.nodes.filter((n) => n.nodeType === 3 || !(isOutOfFlow(n) || isFloat(n)));
    const oof = it.nodes.filter((n) => n.nodeType === 1 && (isOutOfFlow(n) || isFloat(n)));
    if (inflow.some((n) => (n.nodeType === 3 ? !isCollapsibleWhitespaceText(n) : true))) out.push({ type: 'run', nodes: inflow });
    for (const n of oof) out.push({ type: 'el', el: n });
  }
  return out;
}

/** Inline run has visible text or a <br> (atomic inlines alone do not make a text block). */
function runHasText(nodes) {
  for (const n of nodes) {
    if (n.nodeType === 3) {
      if (!isCollapsibleWhitespaceText(n)) return true;
    } else if (n.localName === 'br') return true;
    else if (n.nodeType === 1 && !isAtomicInline(n) && isPureInline(n) && runHasText(childNodesFlat(n))) return true;
  }
  return false;
}

/**
 * Text-block classification of an element:
 *   'block'   block container whose in-flow content is ONE inline run with text (the element is the paragraph)
 *   'anon'    flex/grid container whose only in-flow item is one anonymous text item
 *   null      otherwise
 */
function textBlockKind(el) {
  if (TBK_CACHE.has(el)) return TBK_CACHE.get(el);
  let kind = null;
  if (!isLeaf(el)) {
    const items = flowItems(el);
    const inflow = items.filter((it) => it.type === 'run' || !(isOutOfFlow(it.el) || isFloat(it.el)));
    if (inflow.length === 1 && inflow[0].type === 'run' && runHasText(inflow[0].nodes)) {
      if (isBlockContainer(el)) kind = 'block';
      else if (isFlexGrid(el)) kind = 'anon';
    }
  }
  TBK_CACHE.set(el, kind);
  return kind;
}

/** A ul/ol whose in-flow children are all list items that are text blocks → one text element. */
function isListTextElement(el) {
  if (el.localName !== 'ul' && el.localName !== 'ol') return false;
  if (!isBlockContainer(el)) return false;
  const items = flowItems(el);
  if (!items.length) return false;
  for (const it of items) {
    if (it.type !== 'el') return false;
    const li = it.el;
    if (isOutOfFlow(li) || isFloat(li)) return false;
    if (disp(li) !== 'list-item' && li.localName !== 'li') return false;
    if (textBlockKind(li) !== 'block') return false;
    if (isStackingContext(li) || isPositioned(li)) return false;
  }
  return true;
}

/** Nearest ancestor that is a text root (a text block element or a list text element), or null. */
function inTextBlock(el) {
  let p = el.parentElement;
  while (p && p !== ROOT.parentElement) {
    if (TEXT_ROOTS.has(p)) return p;
    p = p.parentElement;
  }
  return null;
}
