// In-page extractor code, part 6: web-font verification.
// Every @font-face the slide's text needs (CSS Fonts 4 matching: family, style, weight, then unicode-range with
// later rules first) must have status 'loaded' before anything is measured.

function parseUnicodeRange(str) {
  if (!str || /^u\+0-10ffff$/i.test(str.trim())) return [[0, 0x10ffff]];
  return splitTop(str).map((tok) => {
    const t = tok.trim().replace(/^u\+/i, '');
    if (t.includes('?')) return [parseInt(t.replace(/\?/g, '0'), 16), parseInt(t.replace(/\?/g, 'F'), 16)];
    const [a, b] = t.split('-');
    return [parseInt(a, 16), parseInt(b || a, 16)];
  });
}

function inRanges(cp, ranges) {
  for (const [a, b] of ranges) if (cp >= a && cp <= b) return true;
  return false;
}

function weightRangeOf(w) {
  const kw = { normal: 400, bold: 700 };
  const v = String(w).trim().split(/\s+/).map((x) => (kw[x] !== undefined ? kw[x] : parseFloat(x)));
  return [v[0], v.length > 1 ? v[1] : v[0]];
}

function normFamily(f) {
  return String(f).trim().replace(/^["']|["']$/g, '').toLowerCase();
}

/** @font-face rules in document order: [{family, src, weight, style, unicodeRange}] */
function fontFaceRules() {
  const out = [];
  const visit = (rules) => {
    for (const r of rules) {
      if (r.constructor.name === 'CSSFontFaceRule' || r.type === 5) {
        const st = r.style;
        out.push({ family: normFamily(st.getPropertyValue('font-family')), src: st.getPropertyValue('src'),
          weight: st.getPropertyValue('font-weight'), style: st.getPropertyValue('font-style'),
          unicodeRange: st.getPropertyValue('unicode-range') });
      } else if (r.styleSheet) {
        try { visit(r.styleSheet.cssRules); } catch (e) { /* cross-origin */ }
      } else if (r.cssRules) {
        try { visit(r.cssRules); } catch (e) { /* ignore */ }
      }
    }
  };
  for (const sh of document.styleSheets) {
    try { visit(sh.cssRules); } catch (e) { /* cross-origin sheet */ }
  }
  return out;
}

function faceTable() {
  const rules = fontFaceRules();
  const byFam = new Map();
  let i = 0;
  for (const f of document.fonts) {
    const fam = normFamily(f.family);
    const list = byFam.get(fam) || [];
    list.push({ face: f, order: i++, wr: weightRangeOf(f.weight), style: f.style, ranges: parseUnicodeRange(f.unicodeRange) });
    byFam.set(fam, list);
  }
  for (const [fam, list] of byFam) {
    const rs = rules.filter((r) => r.family === fam);
    list.forEach((e, k) => { e.src = rs[k] ? rs[k].src : null; });
  }
  return byFam;
}

/** FontFace -> the src of its @font-face rule (null when unknown): tells a toolkit face from one of the deck's. */
function faceSources() {
  const m = new Map();
  for (const list of faceTable().values()) for (const e of list) m.set(e.face, e.src);
  return m;
}

/** CSS Fonts 4 §5.2: candidate faces of one family for a (weight, style) request, in definition order. */
function matchFaces(list, weight, style) {
  const it = /italic/.test(style), ob = /oblique/.test(style);
  const pref = it ? ['italic', 'oblique', 'normal'] : ob ? ['oblique', 'italic', 'normal'] : ['normal', 'oblique', 'italic'];
  let cands = [];
  for (const p of pref) {
    cands = list.filter((e) => (e.style.startsWith('oblique') ? 'oblique' : e.style) === p);
    if (cands.length) break;
  }
  if (!cands.length) cands = list.slice();
  const inside = cands.filter((e) => weight >= e.wr[0] && weight <= e.wr[1]);
  if (inside.length) return inside;
  // nearest weight in the CSS search direction
  const score = (e) => {
    const lo = e.wr[0], hi = e.wr[1];
    const below = hi < weight, dist = below ? weight - hi : lo - weight;
    if (weight >= 400 && weight <= 500) {
      if (!below && lo <= 500) return dist;            // weight..500 ascending
      if (below) return 1000 + dist;                    // below, descending
      return 2000 + dist;                               // above 500, ascending
    }
    if (weight < 400) return below ? dist : 1000 + dist;
    return below ? 1000 + dist : dist;
  };
  const best = Math.min(...cands.map(score));
  return cands.filter((e) => score(e) === best);
}

/**
 * The characters of text node `n` that Chromium actually lays out. Collapsible white space (space, tab, line feed,
 * carriage return, form feed) counts only where it is drawn: a collapsed or removed space (the trailing space of a
 * block, the space after bare text beside a flex item, a run of spaces, a space at a soft line end) has no glyph,
 * so Chromium never requests the face that covers it — counting it would make that face "needed" and report an
 * unloaded face (the malgun profile serves U+0020 from a face of its own). A drawn space has a client rect with a
 * width; a collapsed one has none or a zero-width one. Other characters (NBSP, U+3000 …) are never collapsed.
 */
function renderedChars(n) {
  const d = n.data;
  let out = '';
  let rg = null;
  for (let i = 0; i < d.length;) {
    const ch = String.fromCodePoint(d.codePointAt(i));
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      if (!rg) rg = document.createRange();
      rg.setStart(n, i);
      rg.setEnd(n, i + ch.length);
      let drawn = false;
      for (const q of rg.getClientRects()) if (q.width > 0) { drawn = true; break; }
      if (drawn) out += ' ';
    } else {
      out += ch;
    }
    i += ch.length;
  }
  return out;
}

/** All rendered text of the slide (incl. SVG text and list markers) grouped by computed font request. */
function renderedTextGroups(root) {
  const groups = new Map();
  const add = (s, text, el) => {
    const key = `${s.fontFamily}|${s.fontWeight}|${s.fontStyle}`;
    let g = groups.get(key);
    if (!g) { g = { fontFamily: s.fontFamily, weight: parseFloat(s.fontWeight), style: s.fontStyle, chars: new Map() }; groups.set(key, g); }
    for (const ch of text) {
      if (/[\n\r\t\f]/.test(ch)) continue;
      if (!g.chars.has(ch)) g.chars.set(ch, el);
    }
  };
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const p = n.parentElement;
    if (!p || !n.data.trim()) continue;
    if (/^(script|style|template|title|desc)$/.test(p.localName)) continue;
    if (p.checkVisibility && !p.checkVisibility()) continue;
    const s = getComputedStyle(p);
    const tt = s.textTransform;
    let t = renderedChars(n);
    if (!t) continue;
    if (tt === 'uppercase') t = t.toUpperCase();
    else if (tt === 'lowercase') t = t.toLowerCase();
    else if (tt === 'capitalize') t = t + t.toUpperCase();
    add(s, t, p);
  }
  for (const li of root.querySelectorAll('li')) {
    if (li.checkVisibility && !li.checkVisibility()) continue;
    const s = getComputedStyle(li);
    if (s.display !== 'list-item' || s.listStyleType === 'none') continue;
    const str = cssStringValue(s.listStyleType);
    add(getComputedStyle(li, '::marker'), str !== null ? str : '0123456789. •', li);
  }
  return groups;
}

/**
 * Verify the fonts the slide uses. Returns {failures:[…], unmatched:[…], faces:[…]} — failures = required faces not
 * 'loaded'; unmatched = text whose first family has no @font-face (rendered with a system font).
 */
function verifyFontsImpl(root) {
  const table = faceTable();
  const failures = [];
  const unmatched = [];
  const needed = new Map();
  for (const g of renderedTextGroups(root).values()) {
    const fams = splitTop(g.fontFamily).map(normFamily);
    const fam = fams.find((f) => table.has(f));
    if (!fam) {
      unmatched.push({ fontFamily: g.fontFamily, sample: [...g.chars.keys()].slice(0, 12).join(''), path: pathOf(g.chars.values().next().value) });
      continue;
    }
    if (fam !== fams[0]) unmatched.push({ fontFamily: g.fontFamily, sample: [...g.chars.keys()].slice(0, 12).join(''), path: pathOf(g.chars.values().next().value) });
    const cands = matchFaces(table.get(fam), g.weight, g.style);
    for (const [ch, el] of g.chars) {
      const cp = ch.codePointAt(0);
      let face = null;
      for (let k = cands.length - 1; k >= 0; k--) if (inRanges(cp, cands[k].ranges)) { face = cands[k]; break; }
      if (!face) continue; // no face covers it: falls back past this family (reported by the CDP font check)
      const e = needed.get(face.face) || { e: face, chars: '', path: pathOf(el) };
      if (e.chars.length < 16 && !e.chars.includes(ch)) e.chars += ch;
      needed.set(face.face, e);
    }
  }
  for (const [face, info] of needed) {
    if (face.status !== 'loaded') {
      failures.push({ family: face.family, weight: face.weight, style: face.style, unicodeRange: face.unicodeRange,
        status: face.status, src: info.e.src, chars: info.chars, path: info.path });
    }
  }
  const srcOf = new Map([...table.values()].flatMap((list) => list.map((e) => [e.face, e.src])));
  for (const f of document.fonts) {
    if (f.status === 'error' && !needed.has(f)) failures.push({ family: f.family, weight: f.weight, style: f.style, unicodeRange: f.unicodeRange, status: f.status, src: srcOf.get(f) || null, chars: '', path: null });
  }
  const faces = [...needed.values()].map((v) => ({ family: v.e.face.family, weight: v.e.face.weight, unicodeRange: v.e.face.unicodeRange, status: v.e.face.status, chars: v.chars }));
  return { failures, unmatched, faces };
}
