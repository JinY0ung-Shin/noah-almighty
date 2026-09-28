// In-page extractor code, part 4.5: photo slots — PowerPoint's EMPTY picture placeholder (docs/CONTRACT.md
// `kind: "placeholder"`, converter 1.2.0). data-placeholder="pic" on a box the slide lays out (a <div> with a width
// and a height) marks a slot the user fills in PowerPoint by clicking its icon; data-prompt is the Korean prompt
// PowerPoint shows in it. The slot is ATOMIC (isLeaf, 10-style.js): its own paint (fill, dashed border) is an ordinary
// shape emitted before it, and its children are an HTML-only hint (an icon and a line of text) the converter drops —
// so the CSS lints skip them (inPicSlot, 50-paint.js lintStyles). Lints: placeholder-prompt, placeholder-size and
// placeholder-content (errors), placeholder-geometry (warn); rotated-placeholder is raised where every element is
// placed (50-paint.js place()). Each slot's IR `slot` = its ordinal in DOCUMENT order (numberPicSlots). Nothing here
// fires on a slide without the attribute.

const PIC_PROMPT_MAX = 80;                        // characters (code points) of a data-prompt
const PIC_MIN_SIDE = 24;                          // px: a slot narrower or lower than this holds no photo
const PIC_LINE_BREAK = /[\n\r\v\f\u2028\u2029]/;

/** data-placeholder="pic" on an element (trimmed, case-sensitive like the text roles). */
function hasPicAttr(el) {
  const v = el && el.nodeType === 1 ? el.getAttribute('data-placeholder') : null;
  return v !== null && v.trim() === 'pic';
}

/**
 * A photo slot: data-placeholder="pic" on an element that lays out as a box of its own — a block container or a
 * flex/grid container, never the slide root, a picture, table, chart or other replaced element, inline text,
 * display: contents or a table part. Everywhere else lintPicPlaceholders reports the attribute (placeholder-content)
 * and the element converts as it otherwise would.
 */
function isPicPlaceholder(el) {
  if (!hasPicAttr(el) || el === ROOT) return false;
  if (isReplaced(el) || isChart(el) || isTable(el)) return false;
  const d = disp(el);
  if (d === 'table-cell' || d === 'table-caption') return false;
  return isBlockContainer(el) || isFlexGrid(el);
}

/** The IR prompt of a data-prompt value: whitespace runs collapsed to one space, trimmed; null when absent / empty. */
function picPromptText(raw) {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).replace(/\s+/g, ' ').trim();
  return t || null;
}

/** The placeholder-prompt message for a data-prompt value (null = a valid prompt). Pure: evaluated in the tests. */
function picPromptProblem(raw) {
  const how = `one line of at most ${PIC_PROMPT_MAX} characters, e.g. data-prompt="제품 사진을 넣으세요"`;
  if (raw === null || raw === undefined) {
    return `the photo slot has no data-prompt: add the Korean prompt PowerPoint shows in the empty placeholder (${how})`;
  }
  const t = String(raw).trim();
  if (!t) return `the photo slot's data-prompt is empty: write the Korean prompt PowerPoint shows in the empty placeholder (${how})`;
  if (PIC_LINE_BREAK.test(t)) return `the photo slot's data-prompt spans several lines: PowerPoint shows the prompt as one line — write it on one line (${how})`;
  const n = [...t].length;
  if (n > PIC_PROMPT_MAX) return `the photo slot's data-prompt has ${n} characters, more than ${PIC_PROMPT_MAX}: PowerPoint shows it inside the slot — keep it to a short instruction (${how})`;
  return null;
}

/**
 * The placeholder-size message for a slot's border box (null = both sides at least PIC_MIN_SIDE px). A slot without
 * a height of its own collapses to its border (the kit's dashed frame: 4 px) when its hint is positioned, and the
 * picture placeholder PowerPoint gets would be that sliver. Pure: evaluated in the tests.
 */
function picSizeProblem(w, h) {
  if (w >= PIC_MIN_SIDE && h >= PIC_MIN_SIDE) return null;
  const n = (v) => String(Math.round(v * 100) / 100);
  return `the photo slot is ${n(w)}×${n(h)} px, too small for a photo (each side needs at least ${PIC_MIN_SIDE} px): give the slot an explicit width and height, e.g. style="width:240px;height:240px"`;
}

/**
 * A photo slot → partial IR record: its BORDER box (where PowerPoint places an inserted photo, covering the frame),
 * the pic role and its prompt (`slot` is numbered afterwards, numberPicSlots). The prompt is checked first
 * (placeholder-prompt), then the size (placeholder-size: a degenerate slot is an error, never a silent drop — the
 * record is still emitted, so the slot keeps its place in the numbering), and a rounded slot warns
 * (placeholder-geometry): the picture placeholder is a rectangle, so the photo would show square corners over it.
 */
function picPlaceholderRecord(el, ctx) {
  const box = rectOf(el);
  const raw = el.getAttribute('data-prompt');
  const problem = picPromptProblem(raw);
  if (problem) ctx.lint('error', 'placeholder-prompt', problem, el);
  const small = picSizeProblem(box.w, box.h);
  if (small) ctx.lint('error', 'placeholder-size', small, el);
  const rad = usedRadii(el, box);
  if (!rad.zero) {
    const r = rad.raw.every((v) => v === rad.raw[0]) ? rad.raw[0] : rad.raw.join(' ');
    ctx.lint('warn', 'placeholder-geometry', `the photo slot has rounded corners (border-radius: ${r}): PowerPoint's picture placeholder is a rectangle, so an inserted photo shows square corners over the rounded frame — give the slot border-radius: 0`, el);
  }
  return { kind: 'placeholder', box, placeholder: 'pic', prompt: picPromptText(raw) };
}

/**
 * IR `slot` of every photo slot the slide emitted: its ordinal (0, 1, …) among them in DOCUMENT order. The builder
 * writes slot k as picture placeholder idx 13+k, and the slides of one layout share the prompt of each idx — so the
 * slots pair across those slides by their order in the markup (1st slot, 2nd slot …), whatever the paint order
 * (z-index, a transform, absolute vs in-flow positioning) makes of them.
 */
function numberPicSlots(elements) {
  const slots = elements.filter((e) => e.kind === 'placeholder' && e._src);   // one record per slot element
  slots.sort((a, b) => (a._src === b._src ? 0 : a._src.compareDocumentPosition(b._src) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  slots.forEach((e, k) => { e.slot = k; });
}

/**
 * Inside a photo slot (a descendant, not the slot itself): part of its HTML-only hint, which never reaches the
 * .pptx — so the CSS lints (lintStyles) skip it, as they skip SVG internals and chart descendants.
 */
function inPicSlot(el) {
  const p = el.parentElement;
  if (!p || !p.closest('[data-placeholder]')) return false;
  for (let a = p; a && a !== ROOT; a = a.parentElement) if (isPicPlaceholder(a)) return true;
  return false;
}

/** What a photo slot holds that its HTML-only hint must not: [what, …] (a real picture, a table, a chart, a role). */
function picSlotContent(slot) {
  const found = [];
  const add = (what) => { if (!found.includes(what)) found.push(what); };
  for (const d of slot.querySelectorAll('img, table, [data-chart], [data-placeholder]')) {
    if (d.localName === 'img') add('an <img>');
    else if (d.localName === 'table') add('a <table>');
    else if (d.hasAttribute('data-chart')) add('a chart');
    else {
      const v = d.getAttribute('data-placeholder').trim();
      if (v !== 'none') add(v === 'pic' ? 'another photo slot' : `a data-placeholder="${v}" element`);
    }
  }
  return found;
}

/**
 * placeholder-content (errors): data-placeholder="pic" where no photo slot can be — on main.slide, on a picture,
 * table, chart or other replaced element, on inline text / display: contents / a table part, inside a table, chart
 * or picture — and, on a slot, content its HTML-only hint would silently drop from the .pptx. A slot nested in
 * another is reported once, on the outer slot. Elements that are not rendered (display: none) are skipped.
 */
function lintPicPlaceholders() {
  for (const el of [ROOT, ...ROOT.querySelectorAll('[data-placeholder]')]) {
    if (!hasPicAttr(el)) continue;
    if (el === ROOT) {
      lint('error', 'placeholder-content', 'data-placeholder="pic" on main.slide: a photo slot is a box INSIDE the slide — put the attribute on a <div> with a width and a height', el);
      continue;
    }
    let hidden = false;
    let inSlot = false;
    let inLeaf = null;
    for (let a = el; a && a !== ROOT; a = a.parentElement) {
      if (a.nodeType === 1 && isNone(a)) hidden = true;
      if (a === el) continue;
      if (isPicPlaceholder(a)) inSlot = true;
      else if (!inLeaf && (isChart(a) || isImage(a) || isTable(a) || isUnsupported(a))) inLeaf = a;
    }
    if (hidden || inSlot) continue;
    if (inLeaf) {
      const what = isTable(inLeaf) ? 'a <table>' : isChart(inLeaf) ? 'a chart' : `an <${inLeaf.localName}>`;
      lint('error', 'placeholder-content', `data-placeholder="pic" inside ${what} is never converted: a photo slot must be a box of the slide itself, outside tables, charts and pictures`, el);
      continue;
    }
    if (isReplaced(el) || isChart(el) || isTable(el)) {
      const what = isTable(el) ? 'a <table>' : isChart(el) ? 'a chart' : `an <${el.localName}>`;
      lint('error', 'placeholder-content', `data-placeholder="pic" on ${what}: a photo slot is an EMPTY box PowerPoint fills with the user's photo — put the attribute (and data-prompt) on a <div> with a width and a height`, el);
      continue;
    }
    if (!isPicPlaceholder(el)) {
      lint('error', 'placeholder-content', `data-placeholder="pic" on an element with display: ${disp(el)}: a photo slot needs a box of its own — use a <div> (display block, flex or grid: in the flow, a flex/grid item or absolutely positioned) with a width and a height`, el);
      continue;
    }
    const inner = picSlotContent(el);
    if (inner.length) {
      lint('error', 'placeholder-content', `the photo slot holds ${inner.join(', ')}: everything inside a slot is an HTML-only hint the converter drops (PowerPoint gets an EMPTY picture placeholder) — keep only an icon and a <p> hint inside, and put captions, pictures and other content next to the slot`, el);
    }
  }
}
