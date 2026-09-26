// In-page extractor code, part 2: text blocks → IR text elements (paragraphs, runs, lines).

let OFFSET_CACHE = new Map();
let WIDTH_CACHE = new Map();

// Font-related computed properties copied onto measuring elements.
const FONT_PROPS = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant-caps',
  'font-variant-east-asian', 'font-variant-ligatures', 'font-variant-numeric', 'font-variant-position',
  'font-variant-alternates', 'font-feature-settings', 'font-variation-settings', 'font-kerning', 'font-optical-sizing',
  'font-size-adjust', 'font-synthesis-weight', 'font-synthesis-style', 'font-synthesis-small-caps', 'text-rendering',
  '-webkit-font-smoothing'];

function copyFont(dst, s) {
  for (const p of FONT_PROPS) {
    const v = s.getPropertyValue(p);
    if (v) dst.style.setProperty(p, v);
  }
}

function langOf(el) {
  const l = el.closest('[lang]');
  return l ? l.getAttribute('lang') : '';
}

function ensureMeas() {
  if (!MEAS || !MEAS.isConnected) {
    MEAS = document.createElement('x-pptx-measure');
    MEAS.style.cssText = 'position:absolute;left:0;top:0;display:block;visibility:hidden;pointer-events:none;margin:0;padding:0;border:0;width:max-content';
    document.documentElement.appendChild(MEAS);
  }
  return MEAS;
}

function endMeas() {
  if (MEAS) MEAS.remove();
  MEAS = null;
}

/**
 * Baseline position inside a text fragment: {off: baseline − fragmentTop, h: fragmentHeight} for `sample` drawn in
 * the font of element `el`. Measured with a 0×0 inline-block probe (its bottom margin edge sits on the baseline)
 * next to the same text in a detached measuring element, so it is exact for Blink's rounded font metrics.
 */
function fontOffset(el, sample) {
  const s = cs(el);
  const lang = langOf(el);
  const key = FONT_PROPS.map((p) => s.getPropertyValue(p)).join('|') + '|' + lang + '|' + sample;
  let v = OFFSET_CACHE.get(key);
  if (v) return v;
  const d = document.createElement('x-pptx-line');
  d.style.cssText = 'display:block;white-space:pre;line-height:normal;margin:0;padding:0;border:0;letter-spacing:0;text-transform:none';
  copyFont(d, s);
  if (lang) d.setAttribute('lang', lang);
  const t = document.createTextNode(sample || 'x');
  const pr = document.createElement('x-pptx-probe');
  pr.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;margin:0;padding:0;border:0';
  d.appendChild(t);
  d.appendChild(pr);
  ensureMeas().appendChild(d);
  const rg = document.createRange();
  rg.setStart(t, 0);
  rg.setEnd(t, t.length);
  const q = rg.getClientRects()[0] || rg.getBoundingClientRect();
  const base = pr.getBoundingClientRect().top;
  v = { off: base - q.top, h: q.height };
  d.remove();
  OFFSET_CACHE.set(key, v);
  return v;
}

/** Advance of `text` (white-space: pre) in the font of computed style `s` (letter-spacing included). */
function textAdvance(s, text, lang) {
  const key = FONT_PROPS.map((p) => s.getPropertyValue(p)).join('|') + '|' + s.letterSpacing + '|' + lang + '|' + text;
  let v = WIDTH_CACHE.get(key);
  if (v !== undefined) return v;
  const d = document.createElement('x-pptx-span');
  d.style.cssText = 'display:inline-block;white-space:pre;margin:0;padding:0;border:0;text-transform:none';
  copyFont(d, s);
  d.style.letterSpacing = s.letterSpacing;
  if (lang) d.setAttribute('lang', lang);
  d.textContent = text;
  ensureMeas().appendChild(d);
  v = d.getBoundingClientRect().width;
  d.remove();
  WIDTH_CACHE.set(key, v);
  return v;
}

function firstFamily(ff) {
  const f = splitTop(ff)[0] || '';
  return f.replace(/^["']|["']$/g, '').trim();
}

function mapAlign(ta, dir) {
  const rtl = dir === 'rtl';
  switch (ta) {
    case 'center': case '-webkit-center': case '-internal-center': return 'ctr';
    case 'right': case '-webkit-right': return 'r';
    case 'justify': return 'just';
    case 'end': return rtl ? 'l' : 'r';
    case 'left': case '-webkit-left': return 'l';
    case 'start': default: return rtl ? 'r' : 'l';
  }
}

function wsMode(el) {
  const s = cs(el);
  const c = s.whiteSpaceCollapse;
  if (c) {
    if (c === 'collapse') return 'collapse';
    if (c === 'preserve-breaks') return 'preserve-breaks';
    return 'preserve';
  }
  const w = s.whiteSpace;
  if (w === 'normal' || w === 'nowrap') return 'collapse';
  if (w === 'pre-line') return 'preserve-breaks';
  return 'preserve';
}

/** Inline content → flat sequence of text / br / hole (atomic inline) items with their inline ancestor chain. */
function collectInline(nodes) {
  const seq = [];
  const walk = (list, chain) => {
    for (const n of list) {
      if (n.nodeType === 3) { seq.push({ t: 'text', node: n, chain }); continue; }
      if (n.nodeType !== 1) continue;
      if (n.localName === 'br') { seq.push({ t: 'br', el: n, chain }); continue; }
      if (isOutOfFlow(n) || isFloat(n)) continue;
      if (isAtomicInline(n) || !isPureInline(n)) { seq.push({ t: 'hole', el: n, chain }); continue; }
      walk(childNodesFlat(n), chain.concat([n]));
    }
  };
  walk(nodes, []);
  return seq;
}

function transformText(ch, el, prevCh) {
  const tt = cs(el).textTransform;
  if (!tt || tt === 'none') return ch;
  const lang = langOf(el) || undefined;
  if (tt === 'uppercase') return ch.toLocaleUpperCase(lang);
  if (tt === 'lowercase') return ch.toLocaleLowerCase(lang);
  if (tt === 'capitalize') {
    const atWordStart = prevCh == null || /[\s \-–—(\[{"'“‘/]/.test(prevCh);
    return atWordStart ? ch.toLocaleUpperCase(lang) : ch;
  }
  return ch;
}

/**
 * CSS white-space processing (phase I collapsing + removal of collapsible spaces at hard line starts/ends) and
 * text-transform. Returns tokens {k:'c', ch, node, off, len, el, chain, collapsible} | {k:'br', el} | {k:'hole', el}.
 */
function renderTokens(seq, problems) {
  const out = [];
  let prevSpace = true; // block start behaves like "after a collapsible space"
  let prevCh = null;
  const trimTrailing = () => {
    while (out.length && out[out.length - 1].k === 'c' && out[out.length - 1].collapsible) out.pop();
  };
  for (const it of seq) {
    if (it.t === 'br') {
      trimTrailing();
      out.push({ k: 'br', el: it.el, chain: it.chain });
      prevSpace = true;
      prevCh = null;
      continue;
    }
    if (it.t === 'hole') {
      out.push({ k: 'hole', el: it.el, chain: it.chain });
      prevSpace = false;
      prevCh = 'x';
      continue;
    }
    const node = it.node;
    const el = node.parentElement;
    const mode = wsMode(el);
    const data = node.data;
    let i = 0;
    for (const ch of data) {
      const off = i;
      i += ch.length;
      if (ch === '­') { problems.add('soft hyphen (U+00AD) dropped'); continue; }
      if (mode === 'collapse' || mode === 'preserve-breaks') {
        if (ch === '\n' && mode === 'preserve-breaks') {
          trimTrailing();
          out.push({ k: 'br', el: null, newline: true, node, off });
          prevSpace = true;
          prevCh = null;
          continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
          if (prevSpace) continue;
          out.push({ k: 'c', ch: ' ', node, off, len: ch.length, el, chain: it.chain, collapsible: true });
          prevSpace = true;
          prevCh = ' ';
          continue;
        }
      } else {
        if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && data[off + 1] === '\n') continue;
          out.push({ k: 'br', el: null, newline: true, node, off });
          prevSpace = false;
          prevCh = null;
          continue;
        }
        if (ch === '\t') problems.add('tab character in preserved white-space (PowerPoint tab stops differ)');
      }
      const rch = transformText(ch, el, prevCh);
      out.push({ k: 'c', ch: rch, node, off, len: ch.length, el, chain: it.chain, collapsible: false });
      prevSpace = false;
      prevCh = ch;
    }
  }
  trimTrailing();
  // a collapsible space right after a leading hole / right before a trailing hole is not text
  return out;
}

function charRects(tok) {
  const rg = document.createRange();
  rg.setStart(tok.node, tok.off);
  rg.setEnd(tok.node, tok.off + tok.len);
  return rg.getClientRects();
}

/** Visual offset of relatively positioned inline ancestors (the IR emits the run in flow, so remove it). */
function relOffset(chain) {
  let dx = 0, dy = 0;
  for (const e of chain) {
    const s = cs(e);
    if (s.position !== 'relative') continue;
    if (s.top !== 'auto') dy += px(s.top);
    else if (s.bottom !== 'auto') dy -= px(s.bottom);
    if (s.left !== 'auto') dx += px(s.left);
    else if (s.right !== 'auto') dx -= px(s.right);
  }
  return { dx, dy };
}

/** Layout rect of a character token (relative offsets of its inline ancestors removed), or null. */
function charRect(tok) {
  const q = charRects(tok)[0];
  if (!q) return null;
  const { dx, dy } = relOffset(tok.chain || []);
  if (!dx && !dy) return q;
  return { left: q.left - dx, right: q.right - dx, top: q.top - dy, bottom: q.bottom - dy, width: q.width, height: q.height };
}

function isSpaceTok(tok) {
  return tok.k === 'c' && /^[ \t ]$/.test(tok.ch) && tok.ch !== ' ';
}

/** Vertical-align shift between the text's element and the paragraph container: null | 'super' | 'sub' | other. */
function shiftOf(el, container) {
  for (let e = el; e && e !== container && e !== ROOT; e = e.parentElement) {
    const va = cs(e).verticalAlign;
    if (va && va !== 'baseline') return va;
  }
  return null;
}

function decorationsOf(el) {
  let underline = false, strike = false;
  for (let e = el; e && e !== ROOT.parentElement; e = e.parentElement) {
    const d = cs(e).textDecorationLine || '';
    if (d.includes('underline')) underline = true;
    if (d.includes('line-through')) strike = true;
    // decorations do not propagate into atomic inlines, floats or out-of-flow boxes
    if (e !== el && (isAtomicInline(e) || isFloat(e) || isOutOfFlow(e))) break;
    if (isAtomicInline(e) || isFloat(e) || isOutOfFlow(e)) break;
  }
  return { underline, strike };
}

function runStyleOf(tok, container) {
  const el = tok.el;
  const s = cs(el);
  const fill = s.webkitTextFillColor && s.webkitTextFillColor !== s.color ? s.webkitTextFillColor : s.color;
  const col = parseColor(fill) || { color: '000000', alpha: 1 };
  let alpha = col.alpha;
  for (const e of tok.chain) alpha *= parseFloat(cs(e).opacity);
  if (!isVisible(el)) alpha = 0;
  const shift = shiftOf(el, container);
  const dec = decorationsOf(el);
  const field = fieldOf(el, container);
  const st = {
    fontFamily: firstFamily(s.fontFamily),
    fontWeight: r6(parseFloat(s.fontWeight)),
    italic: /italic|oblique/.test(s.fontStyle),
    underline: dec.underline,
    strike: dec.strike,
    sizePx: r6(px(s.fontSize)),
    color: col.color,
    alpha: r6(alpha),
    letterSpacingPx: r6(s.letterSpacing === 'normal' ? 0 : px(s.letterSpacing)),
    baseline: shift === 'super' ? 'super' : shift === 'sub' ? 'sub' : 'normal',
  };
  if (field) st.field = field; // only present on field runs (keeps every other run's IR unchanged)
  return st;
}

// `field` (undefined for ordinary text) keeps a field run from merging with the text around it
const RUN_KEYS = ['fontFamily', 'fontWeight', 'italic', 'underline', 'strike', 'sizePx', 'color', 'alpha', 'letterSpacingPx', 'baseline', 'field'];
const FIELD_TYPES = new Set(['slidenum']);

/**
 * `data-field` on the text element or an inline ancestor of the text: the run is a PowerPoint text field
 * (`a:fld`) whose displayed value PowerPoint computes — `slidenum` = the slide's number, so it stays right when
 * slides are reordered, inserted or deleted. The HTML must show what PowerPoint will show (extract.mjs checks the
 * number); an unknown type is linted and emitted as plain text.
 */
function fieldOf(el, container) {
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
    const f = e.getAttribute('data-field');
    if (f !== null) {
      const t = f.trim().toLowerCase();
      if (FIELD_TYPES.has(t)) return t;
      lint('warn', 'field', `data-field="${f}" is not a supported field type (${[...FIELD_TYPES].join(', ')}); emitted as plain text`, e);
      return null;
    }
    if (e === container || e === ROOT) break;
  }
  return null;
}

/** Insert a 0×0 probe after `el` (or before `refNode`) and read the baseline it sits on (slide coords). */
function probeBaselineAfter(el) {
  const pr = document.createElement('x-pptx-probe');
  pr.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;margin:0;padding:0;border:0';
  el.after(pr);
  const y = pr.getBoundingClientRect().top - ORIGIN.y;
  pr.remove();
  return y;
}

function probeBaselineBefore(node) {
  const pr = document.createElement('x-pptx-probe');
  pr.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;margin:0;padding:0;border:0';
  node.parentNode.insertBefore(pr, node);
  const y = pr.getBoundingClientRect().top - ORIGIN.y;
  pr.remove();
  return y;
}

/**
 * Build one IR paragraph and its lines from inline content.
 *   container  element whose computed style gives the paragraph properties (p, li, td, flex container…)
 *   nodes      inline nodes of the paragraph
 *   pIndex     paragraph index recorded on the lines
 * Returns {para, lines, holes, text, problems}
 */
function buildParagraph(container, nodes, pIndex, ctx) {
  const problems = new Set();
  const seq = collectInline(nodes);
  let toks = renderTokens(seq, problems);
  const holes = toks.filter((t) => t.k === 'hole').map((t) => t.el);
  // spaces adjacent to a leading/trailing hole are not part of the text
  while (toks.length && toks[0].k === 'hole') {
    toks.shift();
    while (toks.length && isSpaceTok(toks[0]) && toks[0].collapsible) toks.shift();
  }
  while (toks.length && toks[toks.length - 1].k === 'hole') {
    toks.pop();
    while (toks.length && isSpaceTok(toks[toks.length - 1]) && toks[toks.length - 1].collapsible) toks.pop();
  }
  const innerHoles = toks.filter((t) => t.k === 'hole').length;
  toks = toks.filter((t) => t.k !== 'hole');

  // ---- lines
  const lines = [];
  let cur = null;
  const newLine = () => {
    cur = { toks: [], baseline: null, top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity, hardBreak: false, brEl: null, startTok: null };
    lines.push(cur);
  };
  newLine();
  let prev = null; // last non-space char rect
  for (const tok of toks) {
    if (tok.k === 'br') {
      cur.hardBreak = true;
      cur.brEl = tok.el;
      newLine();
      prev = null;
      continue;
    }
    const q = isSpaceTok(tok) ? null : charRect(tok);
    if (!q) {
      cur.toks.push(tok);
      continue;
    }
    const shift = shiftOf(tok.el, container);
    const hasInk = cur.toks.some((t) => !isSpaceTok(t));
    if (!shift) {
      const fo = fontOffset(tok.el, tok.ch.length === 1 || tok.ch.length === 2 ? tok.ch : tok.node.data.substr(tok.off, tok.len));
      const b = q.top - ORIGIN.y + fo.off;
      if (cur.baseline === null) {
        if (hasInk && prev && q.left < prev.left - 0.5) { newLine(); }
        cur.baseline = b;
      } else if (Math.abs(b - cur.baseline) > 0.5) {
        newLine();
        cur.baseline = b;
      }
    } else {
      if (!['super', 'sub'].includes(shift)) problems.add(`vertical-align: ${shift} on inline text is emitted as baseline`);
      if (hasInk && prev && q.left < prev.left - 0.5) newLine();
    }
    if (!cur.startTok) cur.startTok = tok;
    cur.toks.push(tok);
    cur.top = Math.min(cur.top, q.top - ORIGIN.y);
    cur.bottom = Math.max(cur.bottom, q.bottom - ORIGIN.y);
    cur.left = Math.min(cur.left, q.left - ORIGIN.x);
    cur.right = Math.max(cur.right, q.right - ORIGIN.x);
    prev = q;
  }
  // a trailing <br> creates no line box in CSS (but an a:br at the end would in PowerPoint): drop it
  let droppedTrailingBreak = false;
  if (lines.length > 1 && lines[lines.length - 1].toks.length === 0) {
    lines.pop();
    lines[lines.length - 1].hardBreak = false;
    droppedTrailingBreak = true;
  }

  // ---- paragraph line height (always resolved to px)
  const ps = cs(container);
  let lineHeightPx;
  if (ps.lineHeight === 'normal') {
    const bl = lines.filter((L) => L.baseline !== null).map((L) => L.baseline);
    const pitches = [];
    for (let k = 1; k < bl.length; k++) pitches.push(bl[k] - bl[k - 1]);
    if (pitches.length) {
      pitches.sort((a, b) => a - b);
      lineHeightPx = pitches[Math.floor(pitches.length / 2)];
    } else {
      const d = document.createElement('x-pptx-line');
      d.style.cssText = 'display:block;white-space:pre;line-height:normal;margin:0;padding:0;border:0';
      copyFont(d, ps);
      const lang = langOf(container);
      if (lang) d.setAttribute('lang', lang);
      d.textContent = toks.filter((t) => t.k === 'c').map((t) => t.ch).join('').slice(0, 80) || 'x';
      ensureMeas().appendChild(d);
      lineHeightPx = d.getBoundingClientRect().height;
      d.remove();
    }
    ctx.lint('warn', 'line-height-normal', `line-height: normal resolved to ${r6(lineHeightPx)}px from the layout; set an explicit px line-height`);
  } else {
    lineHeightPx = px(ps.lineHeight);
  }

  // ---- baselines for lines without a baseline-aligned glyph (empty lines, sup/sub-only lines)
  const strut = fontOffset(container, 'x');
  for (let k = 0; k < lines.length; k++) {
    const L = lines[k];
    if (L.baseline !== null) continue;
    let b = null;
    const prevL = lines[k - 1];
    if (prevL && prevL.brEl) b = probeBaselineAfter(prevL.brEl);
    else if (k === 0 && toks.length && toks[0].k === 'br' && toks[0].el) {
      const n = toks[0].el;
      b = probeBaselineAfter(n) - lineHeightPx; // line 0 ends with the leading <br>
      // measure directly: probe before the <br>
      const pr = document.createElement('x-pptx-probe');
      pr.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;margin:0;padding:0;border:0';
      n.parentNode.insertBefore(pr, n);
      b = pr.getBoundingClientRect().top - ORIGIN.y;
      pr.remove();
    }
    if (b === null) {
      const ref = lines.slice(0, k).reverse().find((x) => x.baseline !== null);
      if (ref) b = ref.baseline + lineHeightPx * (k - lines.indexOf(ref));
      else {
        const nxt = lines.slice(k + 1).find((x) => x.baseline !== null);
        b = nxt ? nxt.baseline - lineHeightPx * (lines.indexOf(nxt) - k) : contentBoxOf(container).y + strut.off;
      }
      if (L.toks.some((t) => !isSpaceTok(t))) problems.add('baseline of a line with only super/subscript text estimated from the line pitch');
    }
    L.baseline = b;
    if (!Number.isFinite(L.top)) { L.top = b - strut.off; L.bottom = L.top + strut.h; }
  }

  // ---- verification probe for the first line (exact in-place measurement, layout change → skipped)
  const first = lines[0];
  if (ctx.verifyBaselines && first && first.startTok && !shiftOf(first.startTok.el, container)) {
    const t = first.startTok;
    const par = t.node.parentElement;
    // the probe must be inline-level where it is inserted (inside a flex/grid container it would be an item)
    const inlineCtx = par && (isInlineDisplay(par) || isBlockContainer(par)) && !isFlexGrid(par);
    if (inlineCtx && t.off === 0 && t.node.data.length && !/\s/.test(t.node.data[0])) {
      const before = charRects(t)[0];
      const bx = before.left, by = before.top;
      const pr = document.createElement('x-pptx-probe');
      pr.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;margin:0;padding:0;border:0';
      t.node.parentNode.insertBefore(pr, t.node);
      const after = charRects(t)[0];
      const y = pr.getBoundingClientRect().top - ORIGIN.y;
      const moved = !after || Math.abs(after.left - bx) > 0.001 || Math.abs(after.top - by) > 0.001;
      pr.remove();
      if (!moved && Math.abs(y - first.baseline) > 0.02) {
        ctx.lint('warn', 'baseline-verify', `first baseline ${r6(first.baseline)} (font offset) vs ${r6(y)} (in-place probe)`);
        first.baseline = y;
      }
      ctx.stats.verified++;
    }
  }

  // ---- runs
  const runs = [];
  let lastKey = null;
  for (const tok of toks) {
    if (tok.k === 'br') {
      runs.push({ break: true });
      lastKey = null;
      continue;
    }
    const st = runStyleOf(tok, container);
    const key = RUN_KEYS.map((k) => st[k]).join('|');
    if (key === lastKey) runs[runs.length - 1].text += tok.ch;
    else {
      runs.push({ text: tok.ch, ...st });
      lastKey = key;
    }
  }
  if (droppedTrailingBreak && runs.length && runs[runs.length - 1].break) runs.pop();

  // ---- line records
  const outLines = lines.map((L) => {
    const text = L.toks.filter((t) => t.k === 'c').map((t) => t.ch).join('');
    return {
      top: L.top, bottom: L.bottom, baseline: L.baseline, text, paragraph: pIndex,
      left: Number.isFinite(L.left) ? L.left : null, right: Number.isFinite(L.right) ? L.right : null,
      hardBreak: !!L.hardBreak,
    };
  });

  const sizes = new Set(runs.filter((r) => !r.break && r.baseline === 'normal' && r.text.trim()).map((r) => r.sizePx));
  if (sizes.size > 1 && outLines.length > 1) problems.add('multi-line paragraph with mixed run sizes (PowerPoint line pitch follows the largest size per line)');
  // PowerPoint advances every line of a paragraph by the same spacing: a measured pitch that differs from the
  // line-height (a taller inline line-height, a raised sup/sub, mixed sizes…) will drift
  for (let k = 1; k < outLines.length; k++) {
    const pitch = outLines[k].baseline - outLines[k - 1].baseline;
    if (Math.abs(pitch - lineHeightPx) > 0.5) {
      problems.add(`line pitch ${r6(pitch)}px between lines ${k} and ${k + 1} differs from the line-height ${r6(lineHeightPx)}px (PowerPoint advances every line by the paragraph's line spacing)`);
      break;
    }
  }
  if (innerHoles) problems.add('atomic inline element (inline-block/img/svg) inside wrapping text: it is emitted as a separate object and will not reflow with the text');

  const align = mapAlign(ps.textAlign, ps.direction);
  if (align === 'just') problems.add('text-align: justify (PowerPoint justification of Korean lines is unmeasured)');
  if (ps.direction === 'rtl') problems.add('right-to-left text');
  if (ps.textOverflow === 'ellipsis') problems.add('text-overflow: ellipsis is not representable');
  if (ps.webkitTextStrokeWidth && px(ps.webkitTextStrokeWidth) > 0) problems.add('-webkit-text-stroke is dropped');
  const indent = px(ps.textIndent);
  const para = {
    align,
    lineHeightPx: r6(lineHeightPx),
    spaceBeforePx: 0,
    spaceAfterPx: 0,
    marginLeftPx: 0,
    indentPx: r6(indent),
    bullet: null,
    runs,
  };
  const text = toks.map((t) => (t.k === 'br' ? '\n' : t.ch)).join('');
  if (ctx.verifyAllLines) verifyLineBaselines(container, lines, ctx);
  return { para, lines: outLines, holes, text, problems, strut };
}

/**
 * TEST MODE (opts.verifyAllLines): independent check of every line baseline. A soft-wrapped line k is re-measured
 * by forcing the same break with a <br> right before its first character and reading a 0×0 probe placed there;
 * a line after a <br> is probed right after that <br>. The DOM is restored exactly (split text node re-merged).
 */
function verifyLineBaselines(container, lines, ctx) {
  const mkProbe = () => {
    const pr = document.createElement('x-pptx-probe');
    pr.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;margin:0;padding:0;border:0';
    return pr;
  };
  for (let k = 1; k < lines.length; k++) {
    const L = lines[k], prevL = lines[k - 1];
    let y = null;
    if (prevL.brEl) y = probeBaselineAfter(prevL.brEl);
    else if (!prevL.hardBreak && L.startTok) {
      const t = L.startTok;
      const par = t.node.parentNode;
      if (!par || isFlexGrid(par) || shiftOf(t.el, container)) continue;
      const node = t.node;
      // the forced break must not perturb the layout (shrink-to-fit boxes, auto table columns re-size)
      const snap = () => {
        const c = container.getBoundingClientRect();
        const a = lines[0].startTok ? charRects(lines[0].startTok)[0] : null;
        const b = prevL.startTok ? charRects(prevL.startTok)[0] : null;
        return [c.left, c.top, c.width, c.height, a ? a.left : 0, a ? a.top : 0, b ? b.left : 0, b ? b.top : 0];
      };
      const before = snap();
      const second = t.off > 0 ? node.splitText(t.off) : node;
      const br = document.createElement('br');
      const pr = mkProbe();
      par.insertBefore(br, second);
      par.insertBefore(pr, second);
      y = pr.getBoundingClientRect().top - ORIGIN.y;
      const after = snap();
      if (after.some((v, i) => Math.abs(v - before[i]) > 0.01)) { y = null; ctx.stats.lineSkips = (ctx.stats.lineSkips || 0) + 1; }
      br.remove();
      pr.remove();
      if (second !== node) {
        node.data += second.data;
        second.remove();
      }
    }
    if (y !== null) ctx.stats.lineChecks.push({ path: pathOf(container), line: k, ir: L.baseline, probe: y });
  }
}

// ------------------------------------------------------------------------------------------ lists / bullets
const NUM_SCHEMES = {
  decimal: 'arabicPeriod', 'lower-alpha': 'alphaLcPeriod', 'lower-latin': 'alphaLcPeriod', 'upper-alpha': 'alphaUcPeriod',
  'upper-latin': 'alphaUcPeriod', 'lower-roman': 'romanLcPeriod', 'upper-roman': 'romanUcPeriod',
};

function cssStringValue(v) {
  const m = String(v).match(/^"((?:[^"\\]|\\.)*)"$/) || String(v).match(/^'((?:[^'\\]|\\.)*)'$/);
  if (!m) return null;
  return m[1].replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1');
}

function roman(n) {
  const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}

function alpha(n) {
  let s = '';
  while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

/** Ordinals of the list items of a list element (ol start/reversed, li value). */
function ordinals(list) {
  const items = [...list.children].filter((c) => c.localName === 'li');
  const reversed = list.localName === 'ol' && list.reversed;
  let n = list.localName === 'ol' ? (list.hasAttribute('start') ? list.start : (reversed ? items.length : 1)) : 1;
  const out = new Map();
  for (const li of items) {
    if (li.hasAttribute('value')) n = li.value;
    out.set(li, n);
    n += reversed ? -1 : 1;
  }
  return out;
}

/** Marker info for a list item: {bullet, markerText, advance} or null. */
function markerOf(li, ctx) {
  const s = cs(li);
  if (disp(li) !== 'list-item') return null;
  const lst = s.listStyleType;
  const ms = getComputedStyle(li, '::marker');
  const mcontent = ms.content;
  if (mcontent && mcontent !== 'normal' && mcontent !== 'none') ctx.lint('warn', 'marker-content', `::marker content ${mcontent} is not converted (the list-style-type is used)`, li);
  if (s.listStyleImage && s.listStyleImage !== 'none') ctx.lint('warn', 'list-style-image', 'list-style-image is not converted', li);
  if (!lst || lst === 'none') return null;
  const color = parseColor(ms.color);
  let text = null, bullet = null;
  const str = cssStringValue(lst);
  if (str !== null) {
    text = str;
    const ch = str.trim();
    if (!ch) return null;
    if ([...ch].length > 1) ctx.lint('warn', 'marker-string', `marker string "${str}" has more than one character; only "${[...ch][0]}" is used`, li);
    bullet = { type: 'char', char: [...ch][0], color: null };
  } else if (lst === 'disc' || lst === 'circle' || lst === 'square') {
    const ch = { disc: '•', circle: '◦', square: '▪' }[lst];
    text = ch + ' ';
    bullet = { type: 'char', char: ch, color: null };
    ctx.lint('warn', 'geometric-marker', `list-style-type: ${lst} is painted as a geometric shape by Chromium; use list-style-type: "${ch} "`, li);
  } else {
    const list = li.parentElement;
    const ords = list ? ordinals(list) : new Map();
    const ord = ords.get(li) || 1;
    const seq = [...ords.values()];
    if (seq.some((v, i) => v !== seq[0] + i) || seq.some((v) => v < 1)) {
      ctx.lint('warn', 'marker-sequence', `list numbering ${seq.join(', ')} is not consecutive from ${seq[0]} (reversed / li value): each paragraph carries its own startAt, which PowerPoint may renumber`, list);
    }
    let scheme = NUM_SCHEMES[lst];
    if (!scheme) {
      ctx.lint('warn', 'marker-scheme', `list-style-type: ${lst} is emitted as arabicPeriod numbering`, li);
      scheme = 'arabicPeriod';
    }
    const label = scheme.startsWith('arabic') ? String(ord) : scheme.startsWith('alphaLc') ? alpha(ord) : scheme.startsWith('alphaUc') ? alpha(ord).toUpperCase()
      : scheme.startsWith('romanLc') ? roman(ord) : roman(ord).toUpperCase();
    text = label + '. ';
    bullet = { type: 'number', scheme, startAt: Math.min(32767, Math.max(1, ord)), color: null }; // ST_TextBulletStartAtNum
  }
  const advance = textAdvance(ms, text, langOf(li));
  if (s.listStylePosition === 'inside') ctx.lint('warn', 'marker-inside', 'list-style-position: inside (PowerPoint hangs every line at the bullet indent)', li);
  return { bullet, text, advance, color };
}

// ------------------------------------------------------------------------------------------ text elements
function flowRunNodes(el) {
  const items = flowItems(el);
  const run = items.find((it) => it.type === 'run');
  return run ? run.nodes : [];
}

/**
 * Effective alignment + horizontal box for single-line text whose box is shrink-wrapped by its parent:
 * keep PowerPoint's anchor where Chromium's layout anchored the text (centre of a centred flex item, …).
 */
function flexAnchor(itemEl, flexParent, isOnlyItem) {
  if (!flexParent || !isOnlyItem) return null;
  const ps = cs(flexParent);
  const d = ps.display;
  if (/grid/.test(d)) {
    const ji = cs(itemEl || flexParent).justifySelf;
    const j = ji === 'auto' || ji === 'normal' ? ps.justifyItems : ji;
    if (/center/.test(j)) return 'ctr';
    if (/end|right/.test(j)) return 'r';
    return null;
  }
  const dir = ps.flexDirection;
  if (dir === 'row' || dir === 'row-reverse') {
    const j = ps.justifyContent;
    if (/center|space-around|space-evenly/.test(j)) return 'ctr';
    if (/flex-end|end|right/.test(j)) return dir === 'row' ? 'r' : 'l';
    if (dir === 'row-reverse' && /normal|flex-start|start|space-between/.test(j)) return 'r';
    return null;
  }
  const a = itemEl ? (cs(itemEl).alignSelf === 'auto' ? ps.alignItems : cs(itemEl).alignSelf) : ps.alignItems;
  if (/center/.test(a)) return 'ctr';
  if (/flex-end|end|right/.test(a)) return 'r';
  return null;
}

/** Boxes the builder emits as FIXED PowerPoint objects: anything with its own paint, images, charts, tables. */
function fixedObjects() {
  if (!FIXED_OBJECTS) {
    FIXED_OBJECTS = [];
    for (const el of ROOT.querySelectorAll('*')) {
      if (el.closest('svg') && !isOuterSvg(el)) continue;
      if (isNone(el) || isContents(el)) continue;
      if (isImage(el) || isChart(el) || isTable(el) || hasOwnPaint(el)) FIXED_OBJECTS.push(el);
    }
  }
  return FIXED_OBJECTS;
}

/**
 * Which edge of a shrink-wrapped single-line text box does the CSS layout keep fixed when the text gets wider?
 * Probed in place: the box is widened by PROBE_DX (padding-right, !important) and its border box re-read — left
 * edge fixed → 'l'; right edge fixed → 'r' (last item of a space-between / flex-end row, an item of a shrink-wrapped
 * group that is itself right-anchored: a footer's "note · page number" group); both edges moved by half → 'ctr'.
 * No room to grow, a changed height (wrapping) or any other movement → null. The style attribute is restored
 * exactly. 'r'/'ctr' is returned only when NO fixed object (fixedObjects) moved or resized with the text: PowerPoint
 * keeps those where they are, so a text that CSS would push them with keeps growing into its free side instead (a
 * legend label next to its swatch stays 'l'). Only decides which edge PowerPoint keeps fixed (wrap=none).
 */
function growthAnchor(el) {
  const PROBE_DX = 20;
  const TOL = 0.02; // > 1/64 px
  const objs = fixedObjects().filter((o) => o !== el && !el.contains(o));
  const rect = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
  const b0 = rect(el);
  const o0 = objs.map(rect);
  const saved = el.getAttribute('style');
  el.style.setProperty('padding-right', `${px(cs(el).paddingRight) + PROBE_DX}px`, 'important');
  const b1 = rect(el);
  const moved = objs.some((o, i) => rect(o).some((v, k) => Math.abs(v - o0[i][k]) > TOL));
  if (saved === null) el.removeAttribute('style');
  else el.setAttribute('style', saved);
  const grow = (b1[2] - b1[0]) - (b0[2] - b0[0]);
  if (Math.abs((b1[3] - b1[1]) - (b0[3] - b0[1])) > TOL || Math.abs(b1[1] - b0[1]) > TOL || grow < PROBE_DX * 0.9) return null;
  const dl = b1[0] - b0[0], dr = b1[2] - b0[2];
  if (Math.abs(dl) <= TOL) return 'l';
  let a = null;
  if (Math.abs(dr) <= TOL && Math.abs(dl + grow) <= 2 * TOL) a = 'r';
  else if (Math.abs(dl + grow / 2) <= 2 * TOL && Math.abs(dr - grow / 2) <= 2 * TOL) a = 'ctr';
  return a && !moved ? a : null;
}

/**
 * Does the border-box width of `el` follow its content? Probed in place like growthAnchor: padding-right grows by
 * the box's free room + 20 px (so the content is wider than the current box) and the border box is re-read. A width
 * the container sets (a block in a block / flex column / grid cell, `flex: 1`, an explicit width with border-box
 * sizing) does not change — the content box shrinks and the text wraps; a shrink-to-fit box (inline-block, a
 * flex-row item with an auto basis, abs-pos with auto width, a min-width box, a block inside such a box) grows.
 * The style attribute is restored exactly.
 */
function widthFollowsContent(el, room) {
  const w0 = el.getBoundingClientRect().width;
  const saved = el.getAttribute('style');
  el.style.setProperty('padding-right', `${px(cs(el).paddingRight) + Math.max(0, room) + 20}px`, 'important');
  const w1 = el.getBoundingClientRect().width;
  if (saved === null) el.removeAttribute('style');
  else el.setAttribute('style', saved);
  return w1 - w0 > 0.5;
}

/**
 * Extract one text element.
 *   spec.kind: 'block' (element is the paragraph), 'list' (ul/ol, one paragraph per li), 'anon' (flex/grid
 *   container holding one anonymous text item), 'run' (anonymous run inside a parent with block siblings)
 * Returns {el (IR element, untransformed coordinates), holes[], problems}
 */
function extractText(spec, ctx) {
  const { kind } = spec;
  const host = spec.el;                      // element whose path/opacity/transform the text belongs to
  const paragraphs = [];
  let lines = [];
  const holes = [];
  const problems = new Set();
  const addP = (res) => {
    paragraphs.push(res.para);
    lines = lines.concat(res.lines);
    holes.push(...res.holes);
    for (const p of res.problems) problems.add(p);
  };
  let box;
  if (kind === 'list') {
    const lis = flowItems(host).map((it) => it.el);
    const ul = contentBoxOf(host);
    const infos = lis.map((li) => ({ li, cb: contentBoxOf(li), mk: markerOf(li, ctx) }));
    let x0 = ul.x;
    for (const i of infos) if (i.mk && cs(i.li).listStylePosition !== 'inside') x0 = Math.min(x0, i.cb.x - i.mk.advance);
    const maxAdv = Math.max(0, ...infos.filter((i) => i.mk && i.mk.bullet.type === 'number').map((i) => i.mk.advance));
    infos.forEach((info, k) => {
      const res = buildParagraph(info.li, flowRunNodes(info.li), k, ctx);
      const s = cs(info.li);
      res.para.spaceBeforePx = r6(px(s.marginTop));
      res.para.spaceAfterPx = r6(px(s.marginBottom));
      if (px(s.paddingTop) || px(s.paddingBottom) || px(s.borderTopWidth) || px(s.borderBottomWidth)) problems.add('list item with vertical padding/border (spacing is taken from the measured baselines)');
      res.para.marginLeftPx = r6(info.cb.x - x0);
      if (info.mk) {
        const b = { ...info.mk.bullet };
        const firstRun = res.para.runs.find((r) => !r.break);
        if (info.mk.color && (!firstRun || firstRun.color !== info.mk.color.color || Math.abs(firstRun.alpha - info.mk.color.alpha) > 1e-3)) b.color = info.mk.color.color;
        res.para.bullet = b;
        const adv = b.type === 'number' ? maxAdv : info.mk.advance;
        if (cs(info.li).listStylePosition === 'inside') {
          res.para.marginLeftPx = r6(info.cb.x - x0 + info.mk.advance);
          res.para.indentPx = r6(-info.mk.advance);
        } else res.para.indentPx = r6(-adv + px(s.textIndent));
        if (firstRun && Math.abs(firstRun.sizePx - px(getComputedStyle(info.li, '::marker').fontSize)) > 0.01) problems.add('bullet size follows the first run in PowerPoint, the li font size in HTML');
      }
      addP(res);
    });
    box = { x: x0, y: ul.y, w: ul.x + ul.w - x0, h: ul.h };
  } else if (kind === 'block') {
    const res = buildParagraph(host, flowRunNodes(host), 0, ctx);
    const cb = contentBoxOf(host);
    box = cb;
    const mk = disp(host) === 'list-item' ? markerOf(host, ctx) : null;
    if (mk) {
      const b = { ...mk.bullet };
      const firstRun = res.para.runs.find((r) => !r.break);
      if (mk.color && (!firstRun || firstRun.color !== mk.color.color)) b.color = mk.color.color;
      res.para.bullet = b;
      const inside = cs(host).listStylePosition === 'inside';
      // outside marker: the text box starts at the marker (bullet at marL + indent = cb.x − advance)
      box = { x: cb.x - (inside ? 0 : mk.advance), y: cb.y, w: cb.w + (inside ? 0 : mk.advance), h: cb.h };
      res.para.marginLeftPx = r6(mk.advance);
      res.para.indentPx = r6(-mk.advance + (inside ? 0 : px(cs(host).textIndent)));
    }
    addP(res);
  } else {
    // 'anon' (flex/grid container with one anonymous text item) or 'run' (anonymous block / item among siblings)
    const container = host;
    const res = buildParagraph(container, spec.nodes, 0, ctx);
    addP(res);
    const cb = contentBoxOf(container);
    const withText = lines.filter((L) => L.left !== null);
    const x0 = withText.length ? Math.min(...withText.map((L) => L.left)) : cb.x;
    const x1 = withText.length ? Math.max(...withText.map((L) => L.right)) : cb.x + cb.w;
    // line box = text fragment ± half-leading (Blink floors the half above the text)
    const lh = res.para.lineHeightPx;
    const firstL = lines[0], lastL = lines[lines.length - 1];
    const y0 = firstL.top - Math.floor((lh - (firstL.bottom - firstL.top)) / 2);
    const y1 = lastL.bottom + (lh - (lastL.bottom - lastL.top)) - Math.floor((lh - (lastL.bottom - lastL.top)) / 2);
    if (isFlexGrid(container)) {
      if (lines.length === 1) box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      else {
        box = { x: spec.onlyItem ? cb.x : x0, y: y0, w: spec.onlyItem ? cb.w : x1 - x0, h: y1 - y0 };
        if (!spec.onlyItem) problems.add('wrapping anonymous flex/grid item beside other items: its box width is approximated by its line extents');
      }
    } else {
      box = { x: cb.x, y: y0, w: cb.w, h: y1 - y0 };
    }
  }

  // single-line text with atomic-inline holes: the text box covers the text only
  if (holes.length && lines.length === 1 && lines[0].left !== null) {
    const L = lines[0];
    box = { x: L.left, y: box.y, w: L.right - L.left, h: box.h };
  }

  // Anchor for single-line text (wrap=false: the box width only decides which edge PowerPoint keeps fixed when its
  // line is a little wider/narrower than Chromium's). A shrink-wrapped box centred/end-aligned by its flex/grid
  // parent gets the parent's content box + that anchor; a shrink-wrapped box with its own paint (pill, badge) is
  // centred so both paddings stay equal. Never widened for rotated text (the box centre is the rotation centre).
  if (lines.length === 1 && paragraphs.length === 1 && lines[0].left !== null) {
    const L = lines[0];
    const shrink = Math.abs((L.right - L.left) - box.w) < 0.75;
    let done = false;
    if (kind === 'anon' && !spec.rotated) {
      const anchor = flexAnchor(null, host, true);
      if (anchor) {
        const fcb = contentBoxOf(host);
        box = { x: fcb.x, y: box.y, w: fcb.w, h: box.h };
        paragraphs[0].align = anchor;
        done = true;
      }
    } else if (kind === 'block' && shrink && !spec.rotated && isFlexGridItem(host)) {
      const fp = boxParent(host);
      const inflow = flowItems(fp).filter((it) => it.type === 'run' || !(isOutOfFlow(it.el) || isFloat(it.el)));
      const anchor = flexAnchor(host, fp, inflow.length === 1);
      if (anchor) {
        const fcb = contentBoxOf(fp);
        box = { x: fcb.x, y: box.y, w: fcb.w, h: box.h };
        paragraphs[0].align = anchor;
        done = true;
      }
    }
    if (!done && kind === 'anon' && !spec.rotated && hasOwnPaint(host)) {
      // shrink-wrapped flex/grid pill (inline-flex badge…): centre in the host's content box
      const fcb = contentBoxOf(host);
      if (Math.abs((L.right - L.left) - fcb.w) < 0.75) {
        box = { x: fcb.x, y: box.y, w: fcb.w, h: box.h };
        paragraphs[0].align = 'ctr';
        done = true;
      }
    }
    if (!done && kind === 'block' && shrink && paragraphs[0].align === 'l') {
      const tr = TREC.get(host);
      const m = tr ? parseTransform(tr.transform).m : null;
      if (hasOwnPaint(host)) paragraphs[0].align = 'ctr';
      // positioned by its centre (left: X; transform: translateX(-50%)) → keep the centre fixed
      else if (m && isRigid(m) && Math.abs(rotationOf(m)) < 1e-6 && Math.abs(m[4] + rectOf(host).w / 2) < 0.5) paragraphs[0].align = 'ctr';
      else if (tr && tr.translate && tr.translate !== 'none' && /^-50%$/.test(tr.translate.trim().split(/\s+/)[0])) paragraphs[0].align = 'ctr';
      // anchored by its right edge (right: X; left: auto) → keep the right edge fixed
      else if (isOutOfFlow(host) && !isAutoInset(host, 'right') && isAutoInset(host, 'left')) paragraphs[0].align = 'r';
      // anything else (flex/grid/inline layout): ask the layout itself which edge a wider text would keep
      else if (!spec.rotated && !holes.length && !tr) {
        const a = growthAnchor(host);
        if (a && a !== 'l') paragraphs[0].align = a;
      }
    }
  }
  box = checkLineStarts(box, paragraphs, lines, holes, spec, ctx);
  // How the HTML would treat a LONGER line (judge J2-01; the builder's wrap mode for blocks without soft wraps):
  //   nowrap     — CSS forbids wrapping (white-space: nowrap / pre, text-wrap-mode: nowrap): never wraps;
  //   shrinkWrap — the box width follows the content (inline-block, a flex-row item sized by its text, abs-pos with
  //                auto width, min-width, a block inside such a box): the box widens before anything wraps;
  //   neither    — the width is the container's: the line wraps inside the box (PowerPoint wrap="square").
  const hs = cs(host);
  const nowrap = hs.textWrapMode === 'nowrap' || /^(nowrap|pre)$/.test(hs.whiteSpace);
  const lineW = Math.max(0, ...lines.filter((L) => L.left !== null).map((L) => L.right - L.left));
  const shrinkWrap = widthFollowsContent(host, box.w - lineW);
  const rec = {
    kind: 'text',
    anchor: 'top',
    wrap: lines.length !== 1,
    nowrap,
    shrinkWrap,
    paragraphs,
    lines,
    contentBox: box,
  };
  // family check (fonts.json profile)
  const fams = new Set(paragraphs.flatMap((p) => p.runs.filter((r) => !r.break).map((r) => r.fontFamily)));
  for (const f of fams) if (ctx.cssFamily && f !== ctx.cssFamily) ctx.lint('error', 'font-family', fontFamilyMessage(f, ctx.cssFamily, ctx.familyLabels));
  const weights = new Set(paragraphs.flatMap((p) => p.runs.filter((r) => !r.break).map((r) => r.fontWeight)));
  for (const w of weights) {
    if (!ctx.faceWeights.length || ctx.faceWeights.includes(w)) continue;
    const u = ctx.weightUse.get(w) || [];
    u.push(pathOf(host));
    ctx.weightUse.set(w, u);
  }
  if (paragraphs.some((p) => p.runs.some((r) => r.italic)) && !ctx.hasItalic) problems.add('italic text: the profile has no italic face (synthetic oblique)');
  // PowerPoint placeholder role (Outline view, the accessibility checker's slide titles, slide-link pickers):
  // data-placeholder="title|ctrTitle|subTitle|none" on the text element, else the slide's first <h1> is its title
  const phAttr = host.getAttribute ? host.getAttribute('data-placeholder') : null;
  let placeholder = null;
  if (phAttr !== null) {
    const v = phAttr.trim();
    if (PLACEHOLDER_TYPES.has(v)) placeholder = v;
    else if (v !== 'none') ctx.lint('warn', 'placeholder', `data-placeholder="${phAttr}" is not one of ${[...PLACEHOLDER_TYPES].join(', ')}, none`);
  } else if (host.localName === 'h1' && kind === 'block' && !ctx.titleSeen) {
    placeholder = 'title';
  }
  if (placeholder === 'title' || placeholder === 'ctrTitle') {
    if (ctx.titleSeen) {
      ctx.lint('warn', 'placeholder', `a second slide title (${placeholder}) is emitted as a plain text box`);
      placeholder = null;
    } else ctx.titleSeen = true;
  }
  if (placeholder) rec.placeholder = placeholder;
  // a slide title keeps its lines (AUTHORING §4.3): a soft-wrapped title pushes the header into the content, and
  // PowerPoint's title placeholder wraps (or shrinks) it on its own
  if (placeholder === 'title' || placeholder === 'ctrTitle') {
    const soft = lines.filter((L, i) => !L.hardBreak && i + 1 < lines.length && lines[i + 1].paragraph === L.paragraph).length;
    if (soft) {
      const ls = hs.letterSpacing === 'normal' ? 0 : px(hs.letterSpacing);
      ctx.lint('error', 'title-wrap', titleWrapMessage(placeholder, lines.length, px(hs.fontSize), ls, box.w));
    }
  }
  return { rec, holes, problems };
}

const PLACEHOLDER_TYPES = new Set(['title', 'ctrTitle', 'subTitle']);

/**
 * The font-family lint. `labels` = the agent-facing names of the profiles' CSS families (cmap.mjs familyLabels): the
 * malgun profile measures with a metric-matched stand-in for 맑은 고딕 whose internal family name never reaches a
 * .pptx, so the message names what it stands in for instead of calling that name "the profile font".
 */
function fontFamilyMessage(used, cssFamily, labels) {
  const L = labels || {};
  const named = (f) => (L[f] ? `"${f}" (${L[f]})` : `"${f}"`);
  const profileFont = L[cssFamily] ? `(${L[cssFamily]})` : `"${cssFamily}"`;
  return `text uses font-family ${named(used)}, not the profile font ${profileFont}: never name a font — inherit font-family: var(--font-sans) (AUTHORING §4.1)`;
}

/**
 * The title-wrap lint, per title kind: the cover title (`ctrTitle`, AUTHORING §8.13: 60 px in a 520 px box, about 8
 * Hangul syllables per line in malgun) or a slide title (`title`, §4.3: 40 px, about 20 beside a context chip). The
 * syllable count is this title's own: its box width over one Hangul syllable of the WIDER profile — 맑은 고딕 draws
 * every Hangul syllable 1 em wide (the malgun stand-in exactly so) — plus the letter-spacing.
 */
function titleWrapMessage(kind, nLines, sizePx, letterSpacingPx, boxW) {
  const pitch = sizePx + (letterSpacingPx || 0);
  const fit = pitch > 0 ? Math.max(0, Math.floor(boxW / pitch + 1e-6)) : 0;
  const cap = `its ${Math.round(boxW)} px box holds about ${fit} Hangul syllables per ${r6(sizePx)} px line in the malgun profile (the wider one; a space takes about a third of a syllable)`;
  if (kind === 'ctrTitle') {
    return `the cover title wraps onto ${nLines} lines without <br> in this profile — ${cap}: shorten the line or re-split it with <br> (AUTHORING §8.13)`;
  }
  return `the slide title wraps onto ${nLines} lines without <br> in this profile — ${cap}: shorten it or, where the layout leaves room, break it on purpose with <br> (AUTHORING §4.3)`;
}

/**
 * PowerPoint starts every line of a left-aligned paragraph at marL (the first line at marL + indent unless it has a
 * bullet). A float beside the text, a negative margin, … moves Chromium's line starts instead. If EVERY line is moved
 * by the same amount, the box is moved with them; otherwise the difference is linted. Returns the (new) box.
 */
function checkLineStarts(box, paragraphs, lines, holes, spec, ctx) {
  if (holes.length || spec.rotated) return box;
  const devs = [];
  let seen = new Set();
  for (const L of lines) {
    const p = paragraphs[L.paragraph];
    const first = !seen.has(L.paragraph);
    seen.add(L.paragraph);
    if (!p || p.align !== 'l' || L.left === null || /^\s/.test(L.text)) continue;
    const expect = box.x + p.marginLeftPx + (first && !p.bullet ? p.indentPx : 0);
    devs.push(L.left - expect);
  }
  if (!devs.length || devs.every((d) => Math.abs(d) <= 1)) return box;
  const d0 = devs[0];
  if (devs.length === lines.length && devs.every((d) => Math.abs(d - d0) <= 0.5) && d0 > 0 && d0 < box.w) {
    ctx.lint('warn', 'line-start', `every line starts ${r6(d0)}px right of the text box edge (a float or margin beside the text); the text box is moved with the lines`);
    return { x: box.x + d0, y: box.y, w: box.w - d0, h: box.h };
  }
  const worst = devs.reduce((m, d) => (Math.abs(d) > Math.abs(m) ? d : m), 0);
  ctx.lint('warn', 'line-start', `line starts differ from the box edge by up to ${r6(worst)}px (text flowing around a float?); PowerPoint starts every line at the box edge`);
  return box;
}

/** Is the inset property `side` of `el` computed `auto`? (Typed OM: getComputedStyle gives the used value.) */
function isAutoInset(el, side) {
  try {
    return String(el.computedStyleMap().get(side)) === 'auto';
  } catch (e) {
    return false;
  }
}

/** Does the element paint a background/border/shadow of its own? */
function hasOwnPaint(el) {
  const s = cs(el);
  const bg = parseColor(s.backgroundColor);
  if (bg && bg.alpha > 0) return true;
  if (s.backgroundImage && s.backgroundImage !== 'none') return true;
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    if (px(s[`border${side}Width`]) > 0 && !/none|hidden/.test(s[`border${side}Style`])) {
      const c = parseColor(s[`border${side}Color`]);
      if (c && c.alpha > 0) return true;
    }
  }
  return parseShadows(s.boxShadow).some((sh) => sh.alpha > 0);
}
