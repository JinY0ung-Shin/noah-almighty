// In-page extractor code, part 3: <table> → IR table (grid, resolved collapsed borders, cell fills, paragraphs).

const BORDER_STYLE_RANK = { double: 8, solid: 7, dashed: 6, dotted: 5, ridge: 4, outset: 3, groove: 2, inset: 1, none: 0, hidden: 0 };
const BORDER_ORIGIN_RANK = { cell: 6, row: 5, rowgroup: 4, col: 3, colgroup: 2, table: 1 };
const SIDE = { top: 'Top', right: 'Right', bottom: 'Bottom', left: 'Left' };

function borderSide(el, side, origin, order) {
  const s = cs(el);
  const st = s[`border${SIDE[side]}Style`];
  const w = st === 'none' || st === 'hidden' ? 0 : px(s[`border${SIDE[side]}Width`]);
  return { style: st, w, color: s[`border${SIDE[side]}Color`], origin, order, el };
}

/** CSS 2.1 §17.6.2.1 border conflict resolution. cands: candidates, `order` breaks same-origin ties (left/top first). */
function resolveCollapsed(cands, problems) {
  if (cands.some((c) => c.style === 'hidden')) return null;
  const vis = cands.filter((c) => c.style !== 'none' && c.w > 0);
  if (!vis.length) return null;
  vis.sort((a, b) => b.w - a.w || BORDER_STYLE_RANK[b.style] - BORDER_STYLE_RANK[a.style] ||
    BORDER_ORIGIN_RANK[b.origin] - BORDER_ORIGIN_RANK[a.origin] || a.order - b.order);
  return lineFromSide(vis[0], problems);
}

function lineFromSide(side, problems) {
  if (!side || side.style === 'none' || side.style === 'hidden' || side.w <= 0) return null;
  const c = parseColor(side.color) || { color: '000000', alpha: 1 };
  let dash = 'solid';
  if (side.style === 'dashed') dash = 'dashed';
  else if (side.style === 'dotted') dash = 'dotted';
  else if (side.style !== 'solid') problems.add(`border-style ${side.style} is drawn as solid`);
  return { widthPx: r6(side.w), color: c.color, alpha: c.alpha, dash };
}

function sameLine(a, b) {
  if (!a || !b) return a === b;
  return a.widthPx === b.widthPx && a.color === b.color && a.alpha === b.alpha && a.dash === b.dash;
}

function mapVAlign(va, problems) {
  if (va === 'top' || va === 'bottom' || va === 'middle') return va;
  if (va === 'baseline') return 'top';
  problems.add(`vertical-align ${va} in a table cell is emitted as top`);
  return 'top';
}

/** Paragraphs (+ lines) of a table cell: inline-only content → one paragraph, block children → one each. */
function cellParagraphs(td, ctx, problems) {
  const paragraphs = [];
  let lines = [];
  const add = (res, s) => {
    const k = paragraphs.length;
    for (const L of res.lines) L.paragraph = k;
    if (s) {
      res.para.spaceBeforePx = r6(px(s.marginTop));
      res.para.spaceAfterPx = r6(px(s.marginBottom));
    }
    paragraphs.push(res.para);
    lines = lines.concat(res.lines);
    for (const p of res.problems) problems.add(p);
  };
  const visit = (box, isCell) => {
    const kind = textBlockKind(box);
    if (kind === 'block' || kind === 'anon') {
      add(buildParagraph(box, flowRunNodes(box), 0, ctx), isCell ? null : cs(box));
      return;
    }
    if (isListTextElement(box)) {
      const lis = flowItems(box).map((it) => it.el);
      for (const li of lis) {
        const res = buildParagraph(li, flowRunNodes(li), 0, ctx);
        const mk = markerOf(li, ctx);
        if (mk) {
          res.para.bullet = { ...mk.bullet };
          res.para.marginLeftPx = r6(contentBoxOf(li).x - contentBoxOf(td).x);
          res.para.indentPx = r6(-mk.advance);
        }
        add(res, cs(li));
      }
      return;
    }
    for (const it of flowItems(box)) {
      if (it.type === 'run') {
        if (runHasText(it.nodes)) add(buildParagraph(box, it.nodes, 0, ctx), null);
        continue;
      }
      const el = it.el;
      if (isOutOfFlow(el) || isFloat(el) || isLeaf(el)) continue; // reported by the scan below
      if (hasOwnPaint(el)) ctx.lint('error', 'table-content', 'backgrounds/borders of elements inside a table cell are not converted', el);
      visit(el, false);
    }
  };
  visit(td, true);
  // everything the cell's paragraphs cannot carry: out-of-flow / floated boxes, atomic inlines, images, charts,
  // nested tables… (reported once per outermost such element)
  const walk = (e) => {
    for (const d of e.children) {
      if (isNone(d) || /^(script|style|template|noscript)$/.test(d.localName)) continue;
      const why = isOutOfFlow(d) || isFloat(d) ? 'positioned/floating content' : isLeaf(d) ? `<${d.localName}>`
        : isAtomicInline(d) ? `inline-level box (${disp(d)})` : null;
      if (why) { if (isVisible(d) || d.querySelector('*')) ctx.lint('error', 'table-content', `${why} inside a table cell is not converted`, d); continue; }
      walk(d);
    }
  };
  walk(td);
  return { paragraphs, lines };
}

/**
 * Extract a table. Returns {rec, problems}. rec.box = table border box; columnsPx/rowsPx = grid pitch measured from
 * cell/row border boxes (with collapsed borders they tile the grid, lines at border centres).
 */
function extractTable(T, ctx) {
  const problems = new Set();
  const tcs = cs(T);
  const collapse = tcs.borderCollapse === 'collapse';
  const rows = [...T.rows].filter((tr) => !isNone(tr));
  const nR = rows.length;
  if (T.caption) problems.add('<caption> is not converted');
  if (!collapse) {
    const sp = tcs.borderSpacing.split(/\s+/).map(px);
    if (sp.some((v) => v > 0)) problems.add('border-collapse: separate with border-spacing: cells do not tile the grid (spacing dropped)');
  }
  // --- slot grid (HTML table model)
  const grid = [];
  for (let r = 0; r < nR; r++) grid[r] = grid[r] || [];
  const origins = [];
  rows.forEach((tr, r) => {
    let c = 0;
    for (const td of tr.cells) {
      if (isNone(td)) continue;
      while (grid[r][c]) c++;
      let rs = td.rowSpan || 1;
      if (td.rowSpan === 0) rs = nR - r;
      rs = Math.max(1, Math.min(rs, nR - r));
      const csn = Math.max(1, td.colSpan || 1);
      const o = { td, r0: r, c0: c, rs, cs: csn };
      origins.push(o);
      for (let i = 0; i < rs; i++) for (let j = 0; j < csn; j++) {
        grid[r + i] = grid[r + i] || [];
        grid[r + i][c + j] = o;
      }
      c += csn;
    }
  });
  const nC = Math.max(0, ...grid.map((row) => row.length));
  // a transformed row / cell / cell content cannot be expressed inside a PowerPoint table (the IR uses layout geometry)
  for (const part of T.querySelectorAll('*')) {
    if (TREC.has(part)) ctx.lint('error', 'transform', `transform inside a table (<${part.localName}>) is not converted`, part);
  }
  for (let r = 0; r < nR; r++) for (let c = 0; c < nC; c++) if (!grid[r][c]) problems.add('ragged table row (missing cells are emitted empty)');

  // --- grid lines
  const colX = new Array(nC + 1).fill(null);
  const rowY = new Array(nR + 1).fill(null);
  for (const o of origins) {
    const b = rectOf(o.td);
    if (colX[o.c0] === null || o.cs === 1) colX[o.c0] = colX[o.c0] === null ? b.x : colX[o.c0];
    if (colX[o.c0 + o.cs] === null) colX[o.c0 + o.cs] = b.x + b.w;
  }
  rows.forEach((tr, r) => {
    const b = rectOf(tr);
    rowY[r] = b.y;
    rowY[r + 1] = b.y + b.h;
  });
  for (let c = 0; c <= nC; c++) if (colX[c] === null) {
    // interpolate a grid line no cell edge touches (only possible with spans)
    let a = c - 1; while (a >= 0 && colX[a] === null) a--;
    let b = c + 1; while (b <= nC && colX[b] === null) b++;
    colX[c] = colX[a] + ((colX[b] - colX[a]) * (c - a)) / (b - a);
    problems.add('a table grid line is not touched by any cell edge (interpolated)');
  }
  const columnsPx = [];
  for (let c = 0; c < nC; c++) columnsPx.push(r6(colX[c + 1] - colX[c]));
  const rowsPx = [];
  for (let r = 0; r < nR; r++) rowsPx.push(r6(rowY[r + 1] - rowY[r]));

  // --- table parts for border conflict resolution / fills
  const rowGroupOf = (tr) => (tr.parentElement && /^(thead|tbody|tfoot)$/.test(tr.parentElement.localName) ? tr.parentElement : null);
  const cols = new Array(nC).fill(null);
  const colgroups = new Array(nC).fill(null);
  {
    let c = 0;
    for (const cg of T.children) {
      if (cg.localName !== 'colgroup') continue;
      const start = c;
      const colEls = [...cg.children].filter((x) => x.localName === 'col');
      if (colEls.length) for (const col of colEls) for (let k = 0; k < (col.span || 1); k++) { if (c < nC) cols[c] = col; c++; }
      else c += cg.span || 1;
      const end = Math.min(c, nC) - 1;
      for (let k = start; k <= end; k++) colgroups[k] = { el: cg, first: start, last: end };
    }
  }
  const groupFirstLast = new Map();
  rows.forEach((tr, r) => {
    const g = rowGroupOf(tr);
    if (!g) return;
    const v = groupFirstLast.get(g) || { first: r, last: r };
    v.last = r;
    groupFirstLast.set(g, v);
  });

  const hEdge = (r, c) => {
    const above = r > 0 ? grid[r - 1][c] : null;
    const below = r < nR ? grid[r][c] : null;
    if (above && below && above === below) return undefined; // inside a spanning cell
    if (!collapse) return null;
    const cands = [];
    if (above) cands.push(borderSide(above.td, 'bottom', 'cell', 0));
    if (below) cands.push(borderSide(below.td, 'top', 'cell', 1));
    if (r > 0) cands.push(borderSide(rows[r - 1], 'bottom', 'row', 0));
    if (r < nR) cands.push(borderSide(rows[r], 'top', 'row', 1));
    if (r > 0) { const g = rowGroupOf(rows[r - 1]); if (g && groupFirstLast.get(g).last === r - 1) cands.push(borderSide(g, 'bottom', 'rowgroup', 0)); }
    if (r < nR) { const g = rowGroupOf(rows[r]); if (g && groupFirstLast.get(g).first === r) cands.push(borderSide(g, 'top', 'rowgroup', 1)); }
    if (r === 0 || r === nR) {
      const side = r === 0 ? 'top' : 'bottom';
      if (cols[c]) cands.push(borderSide(cols[c], side, 'col', 0));
      if (colgroups[c]) cands.push(borderSide(colgroups[c].el, side, 'colgroup', 0));
      cands.push(borderSide(T, side, 'table', 0));
    }
    return resolveCollapsed(cands, problems);
  };
  const vEdge = (r, c) => {
    const left = c > 0 ? grid[r][c - 1] : null;
    const right = c < nC ? grid[r][c] : null;
    if (left && right && left === right) return undefined;
    if (!collapse) return null;
    const cands = [];
    if (left) cands.push(borderSide(left.td, 'right', 'cell', 0));
    if (right) cands.push(borderSide(right.td, 'left', 'cell', 1));
    if (c === 0 || c === nC) {
      const side = c === 0 ? 'left' : 'right';
      cands.push(borderSide(rows[r], side, 'row', 0));
      const g = rowGroupOf(rows[r]);
      if (g) cands.push(borderSide(g, side, 'rowgroup', 0));
      cands.push(borderSide(T, side, 'table', 0));
    }
    if (c > 0 && cols[c - 1]) cands.push(borderSide(cols[c - 1], 'right', 'col', 0));
    if (c < nC && cols[c]) cands.push(borderSide(cols[c], 'left', 'col', 1));
    if (c > 0 && colgroups[c - 1] && colgroups[c - 1].last === c - 1) cands.push(borderSide(colgroups[c - 1].el, 'right', 'colgroup', 0));
    if (c < nC && colgroups[c] && colgroups[c].first === c) cands.push(borderSide(colgroups[c].el, 'left', 'colgroup', 1));
    return resolveCollapsed(cands, problems);
  };

  const colBg = (c) => [cols[c], colgroups[c] && colgroups[c].el].filter(Boolean).map((e) => cs(e).backgroundColor + cs(e).backgroundImage).join('|');
  const fillOf = (o) => {
    if (o.cs > 1) {
      const own = [o.td, rows[o.r0], rowGroupOf(rows[o.r0])].filter(Boolean).some((e) => { const c = parseColor(cs(e).backgroundColor); return (c && c.alpha > 0) || cs(e).backgroundImage !== 'none'; });
      if (!own && new Set([...Array(o.cs).keys()].map((k) => colBg(o.c0 + k))).size > 1) problems.add('a column-spanning cell lies over columns with different column backgrounds (the first column\'s is used)');
    }
    const layers = [o.td, rows[o.r0], rowGroupOf(rows[o.r0]), cols[o.c0], colgroups[o.c0] && colgroups[o.c0].el].filter(Boolean);
    for (const el of layers) {
      const s = cs(el);
      if (s.backgroundImage && s.backgroundImage !== 'none') {
        const pb = paddingBoxOf(o.td);
        const g = parseGradientLayer(splitTop(s.backgroundImage)[0], pb);
        for (const p of g.problems) problems.add(p);
        if (g.fill) return g.fill;
        problems.add(`table cell background-image (${g.kind}) is not converted`);
      }
      const c = parseColor(s.backgroundColor);
      if (c && c.alpha > 0) {
        if (c.alpha < 1 && el !== layers[layers.length - 1]) problems.add('translucent table cell/row background over another table layer');
        return { type: 'solid', color: c.color, alpha: c.alpha };
      }
    }
    return null;
  };

  const cellOut = [];
  for (let r = 0; r < nR; r++) {
    const row = [];
    for (let c = 0; c < nC; c++) {
      const o = grid[r][c];
      if (!o) {
        row.push({ rowSpan: 1, colSpan: 1, fill: null, borders: { top: hEdge(r, c) || null, right: vEdge(r, c + 1) || null, bottom: hEdge(r + 1, c) || null, left: vEdge(r, c) || null }, paddingPx: { l: 0, t: 0, r: 0, b: 0 }, vAlign: 'top', paragraphs: [], lines: [] });
        continue;
      }
      if (o.r0 !== r || o.c0 !== c) { row.push({ covered: true }); continue; }
      const segs = (fn, list) => {
        const vals = list.map(fn).filter((v) => v !== undefined);
        if (vals.length > 1 && !vals.every((v) => sameLine(v, vals[0]))) problems.add('a spanning cell edge has different collapsed borders per segment (first segment used)');
        return vals.length ? vals[0] : null;
      };
      let borders;
      if (collapse) {
        const cRange = [...Array(o.cs).keys()].map((k) => c + k);
        const rRange = [...Array(o.rs).keys()].map((k) => r + k);
        borders = {
          top: segs((cc) => hEdge(r, cc), cRange),
          right: segs((rr) => vEdge(rr, c + o.cs), rRange),
          bottom: segs((cc) => hEdge(r + o.rs, cc), cRange),
          left: segs((rr) => vEdge(rr, c), rRange),
        };
      } else {
        borders = {};
        for (const side of ['top', 'right', 'bottom', 'left']) borders[side] = lineFromSide(borderSide(o.td, side, 'cell', 0), problems);
      }
      const pad = paddings(o.td);
      const cp = cellParagraphs(o.td, ctx, problems);
      if (o.td.scrollWidth > o.td.clientWidth + 1) {
        ctx.lint('error', 'text-overflow', `table cell content overflows the cell (scroll width ${o.td.scrollWidth} > ${o.td.clientWidth})`, o.td);
      }
      row.push({
        rowSpan: o.rs,
        colSpan: o.cs,
        fill: fillOf(o),
        borders,
        paddingPx: { l: r6(pad.l), t: r6(pad.t), r: r6(pad.r), b: r6(pad.b) },
        vAlign: mapVAlign(cs(o.td).verticalAlign, problems),
        header: o.td.localName === 'th',   // a header cell: a first row of them = PowerPoint's header row (J2-03)
        paragraphs: cp.paragraphs,
        lines: cp.lines,
      });
    }
    cellOut.push(row);
  }

  // rows shorter than marT + marB + 2 pt grow in PowerPoint
  for (let r = 0; r < nR; r++) {
    for (let c = 0; c < nC; c++) {
      const cell = cellOut[r][c];
      if (cell.covered || cell.rowSpan !== 1) continue;
      const bt = cell.borders.top ? cell.borders.top.widthPx / 2 : 0;
      const bb = cell.borders.bottom ? cell.borders.bottom.widthPx / 2 : 0;
      const minH = cell.paddingPx.t + cell.paddingPx.b + bt + bb + 8 / 3;
      if (rowsPx[r] + 1e-6 < minH) problems.add(`row ${r + 1} is shorter than marT + marB + 2 pt (PowerPoint grows it)`);
    }
  }
  // rounded table + filled corner cells
  const rad = usedRadii(T, rectOf(T));
  if (!rad.zero && nR && nC) {
    const corners = [cellOut[0][0], cellOut[0][nC - 1], cellOut[nR - 1][0], cellOut[nR - 1][nC - 1]];
    if (corners.some((cell) => cell && !cell.covered && cell.fill)) problems.add('rounded table with filled corner cells (PowerPoint cannot clip cell fills to the radius)');
  }
  const rec = { kind: 'table', box: rectOf(T), columnsPx, rowsPx, cells: cellOut, collapse };
  return { rec, problems };
}
