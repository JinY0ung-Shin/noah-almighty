// In-page extractor code, part 5.5: text-on-picture — text painted over a picture must stay legible for ANY photo
// (docs/CONTRACT.md "Noah lints", converter 1.3.0; AUTHORING §7).
//
// A picture — an <img>, or a photo slot (data-placeholder="pic", whose photo the user inserts later) — can put any
// colour behind the text painted over it. For every text element whose line boxes cross a picture painted BEFORE it,
// the lint finds a WORST-CASE contrast over those line boxes that is never above the true one:
//   - each line box is cut at the layers' edges (and bisected along curved or slanted ones, a cell centre deciding at
//     the last pixel) into pieces under a fixed set of layers, so a line box only partly under a layer is judged on
//     its uncovered part too;
//   - over a piece, the layers painted between the picture and the text (shape fills, solid or linear-gradient, times
//     each element's opacity — the IR's per-object alpha, which is how PowerPoint draws them) are composited in sRGB
//     like the browser over a pure-black and a pure-white picture: every channel of the composite rises with the
//     picture's, so every photo's composite lies in the box between those two ends, and a gradient's extremes over
//     the piece are at its corners and the stops between. A photo slot counts as opaque whatever its CSS opacity:
//     PowerPoint inserts the user's photo into the placeholder without alpha. The box is exact where nothing that
//     shows varies, and under a single-hue ramp (one colour fading in alpha) painted straight over an opaque picture,
//     whose box only narrows as its alpha grows. Any other gradient — stops of DIFFERENT colours, or a ramp over
//     anything but an opaque picture (another layer, a translucent <img>; the slide background's, through a
//     translucent <img>), whose luminance can dip inside the ramp (sRGB interpolation: red → green is darker a quarter
//     of the way than at either end) — is judged in slabs of at most 1/64 of its shortest stop segment (at most 256
//     per piece), each by its own box: stricter than exact by at most what the layers change across one slab;
//   - opaque text is judged exactly against the box: 1:1 when its luminance lies between the box's two ends, else
//     against the nearer one. A translucent text colour is blended over the composite first; its worst composite is
//     searched over the whole box (each channel on its own — luminance is a sum of per-channel terms) on a 256-step
//     grid per channel, lowered by a bound of what the grid can miss (at most about 0.03 %);
//   - where the layers hide the picture completely (an opaque card) no picture pixel shows and the text is not on it;
//   - the search work is bounded: 2^19 units per element and 2^20 per slide (deterministic, about a microsecond each),
//     and the slide's budget never takes a text's first 2^10, so a caption late on a busy slide is still searched
//     exactly. Past a budget, the rest is judged by bounds that are only ever STRICTER — a piece no longer halved
//     along curved or slanted edges (a layer over part of it may or may not be there; twice past, the rest of a line
//     is one piece), one box per piece, translucent text against the box's corners — and a finding they decide says
//     so, and which budget ran out.
// Threshold 4.5:1; 3:1 when every run is large (>= 24 px, or >= 18.66 px at weight >= 700). Regions thinner than a
// pixel are ignored (layout rounding), and a line box must cross a picture by > 1 px on both axes. Inline <svg> icons
// are not pictures; the text inside a photo slot is its HTML-only hint, which never reaches the element list. Table
// cells and chart labels are not checked (both are atomic objects). Everything but textOnPictureLint is pure — numbers
// in, findings out — and is evaluated in the tests. Nothing here fires on a slide without a picture.

const TPC_MIN_PX = 1;              // regions thinner than this are ignored: sub-pixel slivers of layout rounding
const TPC_NEED = 4.5;              // WCAG 1.4.3 text contrast
const TPC_NEED_LARGE = 3;          // large text: every run >= 24 px, or >= 18.66 px (14 pt) at weight >= 700
const TPC_LARGE_PX = 24;
const TPC_LARGE_BOLD_PX = 18.66;
const TPC_VISIBLE = 0.5 / 255;     // a picture showing through by less than half an 8-bit step is hidden
const TPC_CHANNEL_STEPS = 256;     // translucent text: grid of each channel's range in the per-channel search
const TPC_LIN2 = (2.4 * 1.4) / 1.055 ** 2; // the largest second derivative of tpcLin on [0, 1] (at 1): the grid's error
const TPC_SLAB_STEPS = 64;         // a gradient not exact as a whole: slabs of 1/64 of its shortest stop segment ...
const TPC_MAX_SLABS = 256;         // ... at most this many per piece
const TPC_ELEMENT_WORK = 2 ** 19;  // search work one text element may spend (units of about a microsecond) ...
const TPC_SLIDE_WORK = 2 ** 20;    // ... and one slide; past either, only cheaper bounds that are never more lenient
const TPC_ELEMENT_FLOOR = 2 ** 10; // ... but the first units of each text are its own, whatever the slide has left
const TPC_SEARCH_WORK = 48;        // one translucent search (tpcWorstRatio), in those units

/** sRGB channel 0..1 → linear light (WCAG 2, the formula scripts/theme-check.mjs uses). */
function tpcLin(v) {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB triple 0..1. */
function tpcLum(c) {
  return 0.2126 * tpcLin(c[0]) + 0.7152 * tpcLin(c[1]) + 0.0722 * tpcLin(c[2]);
}

function tpcRatio(la, lb) {
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function tpcRgb(hex) {
  const h = String(hex || '000000');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

/** A picture for this rule: an <img> or a photo slot. An inline <svg> is an icon, never a picture here. */
function tpcIsPicture(e) {
  if (!e) return false;
  if (e.kind === 'placeholder') return true;
  return e.kind === 'image' && !!e._src && String(e._src.localName || '').toLowerCase() === 'img';
}

function tpcFillVisible(f) {
  if (!f) return false;
  if (f.type === 'linear') return Array.isArray(f.stops) && f.stops.some((s) => (s.alpha ?? 1) > 0);
  return (f.alpha ?? 1) > 0;
}

/**
 * An element's region in slide coordinates: its box rotated about the box centre (as place() positions it), with its
 * geometry (a picture or a slot is a rectangle; a shape a rect, roundRect or ellipse) and its axis-aligned bounds.
 * `k` = its paint index.
 */
function tpcShape(e, k) {
  const b = e.box;
  const deg = e.rotationDeg || 0;
  const th = (deg * Math.PI) / 180;
  const cos = Math.cos(th), sin = Math.sin(th);
  const hw = b.w / 2, hh = b.h / 2;
  const cx = b.x + hw, cy = b.y + hh;
  const geom = e.kind === 'shape' && (e.geometry === 'ellipse' || e.geometry === 'roundRect') ? e.geometry : 'rect';
  const r = geom === 'roundRect' ? Math.max(0, Math.min(e.radiusPx || 0, hw, hh)) : 0;
  const ex = Math.abs(hw * cos) + Math.abs(hh * sin), ey = Math.abs(hw * sin) + Math.abs(hh * cos);
  return { e, k, picture: tpcIsPicture(e), deg, cos, sin, hw, hh, cx, cy, geom, r, x0: cx - ex, x1: cx + ex, y0: cy - ey, y1: cy + ey };
}

/** Is slide point (x, y) inside the region (its edge included)? */
function tpcInside(S, x, y) {
  const dx = x - S.cx, dy = y - S.cy;
  const lx = Math.abs(dx * S.cos + dy * S.sin), ly = Math.abs(-dx * S.sin + dy * S.cos);
  const eps = 1e-6;
  if (lx > S.hw + eps || ly > S.hh + eps) return false;
  if (S.geom === 'ellipse') return S.hw > 0 && S.hh > 0 && (lx / S.hw) ** 2 + (ly / S.hh) ** 2 <= 1 + 1e-6;
  if (S.r > 0) {
    const qx = lx - (S.hw - S.r), qy = ly - (S.hh - S.r);
    if (qx > 0 && qy > 0) return qx * qx + qy * qy <= S.r * S.r + eps;
  }
  return true;
}

/** Separating-axis test: the region's (rotated) box and a convex quad share no interior. */
function tpcSeparated(S, quad) {
  const box = [[-S.hw, -S.hh], [S.hw, -S.hh], [S.hw, S.hh], [-S.hw, S.hh]]
    .map(([lx, ly]) => [S.cx + lx * S.cos - ly * S.sin, S.cy + lx * S.sin + ly * S.cos]);
  for (const poly of [box, quad]) {
    for (let i = 0; i < 4; i++) {
      const a = poly[i], b = poly[(i + 1) % 4];
      const ax = a[1] - b[1], ay = b[0] - a[0];
      const n = Math.hypot(ax, ay);
      if (n < 1e-12) continue;
      let p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
      for (const [x, y] of box) { const v = (x * ax + y * ay) / n; if (v < p0) p0 = v; if (v > p1) p1 = v; }
      for (const [x, y] of quad) { const v = (x * ax + y * ay) / n; if (v < q0) q0 = v; if (v > q1) q1 = v; }
      if (p1 <= q0 + 1e-6 || q1 <= p0 + 1e-6) return true;
    }
  }
  return false;
}

/** The text element's own frame: its lines are unrotated in it; points map to the slide about the box centre. */
function tpcFrame(t) {
  const deg = t.rotationDeg || 0;
  if (Math.abs(deg) <= 1e-6) return { deg: 0, toSlide: (x, y) => [x, y], toLocal: (x, y) => [x, y] };
  const th = (deg * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
  const cx = t.box.x + t.box.w / 2, cy = t.box.y + t.box.h / 2;
  return {
    deg,
    toSlide: (x, y) => { const dx = x - cx, dy = y - cy; return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]; },
    toLocal: (x, y) => { const dx = x - cx, dy = y - cy; return [cx + dx * cos + dy * sin, cy - dx * sin + dy * cos]; },
  };
}

/** Position 0..1 on a CSS linear gradient's line for slide point (x, y), in the element's own (unrotated) box. */
function tpcGradT(fill, S, x, y) {
  const dx = x - S.cx, dy = y - S.cy;
  const lx = dx * S.cos + dy * S.sin, ly = -dx * S.sin + dy * S.cos;
  const A = ((fill.angleDeg ?? 180) * Math.PI) / 180;
  const ux = Math.sin(A), uy = -Math.cos(A);
  const len = Math.abs(2 * S.hw * ux) + Math.abs(2 * S.hh * uy) || 1;
  return (lx * ux + ly * uy) / len + 0.5;
}

/** A stop list at t, premultiplied sRGB (CSS Images 4, as stopColorAt): {pm: [r·a, g·a, b·a], a}. */
function tpcStopAt(stops, t) {
  const pmOf = (s) => tpcRgb(s.color).map((v) => v * (s.alpha ?? 1));
  const first = stops[0], last = stops[stops.length - 1];
  if (t <= first.pos) return { pm: pmOf(first), a: first.alpha ?? 1 };
  if (t >= last.pos) return { pm: pmOf(last), a: last.alpha ?? 1 };
  let k = 0;
  while (k < stops.length - 2 && stops[k + 1].pos <= t) k++;
  const A = stops[k], B = stops[k + 1];
  const f = B.pos > A.pos ? (t - A.pos) / (B.pos - A.pos) : 1;
  const pa = pmOf(A), pb = pmOf(B);
  return { pm: pa.map((v, i) => v + (pb[i] - v) * f), a: (A.alpha ?? 1) + ((B.alpha ?? 1) - (A.alpha ?? 1)) * f };
}

/**
 * A fill's paint over a region (its corner points `quad`), premultiplied: [{pm, a}] — one value for a solid fill; for
 * a gradient, its value at the region's lowest and highest position and every stop between (the stop's own colour,
 * so both sides of a hard edge count). Between those it is linear, so every channel's extremes are among them.
 */
function tpcFillRange(fill, S, quad) {
  if (!(fill.type === 'linear' && Array.isArray(fill.stops) && fill.stops.length)) {
    const a = fill.alpha ?? 1;
    return [{ pm: tpcRgb(fill.color).map((v) => v * a), a }];
  }
  const ts = quad.map(([x, y]) => tpcGradT(fill, S, x, y));
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  const out = [tpcStopAt(fill.stops, t0), tpcStopAt(fill.stops, t1)];
  for (const s of fill.stops) {
    if (s.pos >= t0 && s.pos <= t1) out.push({ pm: tpcRgb(s.color).map((v) => v * (s.alpha ?? 1)), a: s.alpha ?? 1 });
  }
  return out;
}

/**
 * The box of every composite over a region (its corner points `quad`, slide coordinates) under the covering regions
 * (paint order), over the slide background: `lo` with every picture pure black, `hi` with every picture pure white
 * (sRGB 0..1), each channel at its extreme over the region; `thr` = the most of the pictures that shows through
 * anywhere in it; `top` = the topmost picture, `above` = the fill layers painted after it that paint here. Every
 * layer's output rises with what lies under it, so the bounds carry through. A region in `maybe` may or may not
 * cover this one (a piece left uncut past the work bound): the box holds both. A photo slot is opaque whatever its
 * CSS opacity: the photo the user inserts into PowerPoint's placeholder carries no alpha (pptxlib writes none on a
 * placeholder).
 */
function tpcEnclose(covering, maybe, BG, quad) {
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const f of tpcFillRange(BG.e.fill, BG, quad)) {
    for (let i = 0; i < 3; i++) {
      const v = f.pm[i] + (1 - f.a); // the slide background is opaque (over the page's white when it is not)
      if (v < lo[i]) lo[i] = v;
      if (v > hi[i]) hi[i] = v;
    }
  }
  let thr = 0;
  let top = null;
  let above = [];
  for (const S of covering) {
    if (S.picture) {
      // a picture that may be absent only widens the box: the same bounds
      const o = S.e.kind === 'placeholder' ? 1 : (S.e.opacity ?? 1);
      lo = lo.map((v) => v * (1 - o));
      hi = hi.map((v) => o + v * (1 - o));
      thr = o + thr * (1 - o);
      top = S;
      above = [];
      continue;
    }
    const o = S.e.opacity ?? 1;
    const may = !!(maybe && maybe.has(S));
    const L = may ? lo.slice() : [Infinity, Infinity, Infinity];
    const H = may ? hi.slice() : [-Infinity, -Infinity, -Infinity];
    let aMin = may ? 0 : Infinity;
    let aMax = 0;
    for (const f of tpcFillRange(S.e.fill, S, quad)) {
      const a = f.a * o;
      if (a < aMin) aMin = a;
      if (a > aMax) aMax = a;
      for (let i = 0; i < 3; i++) {
        const l = f.pm[i] * o + lo[i] * (1 - a), h = f.pm[i] * o + hi[i] * (1 - a);
        if (l < L[i]) L[i] = l;
        if (h > H[i]) H[i] = h;
      }
    }
    if (aMax <= 0) continue;
    lo = L;
    hi = H;
    thr *= 1 - aMin;
    if (top) above.push(S);
  }
  return { lo, hi, thr, top, above };
}

const TPC_W = [0.2126, 0.7152, 0.0722];
// the per-channel grids of tpcWorstRatio: the composite's (0-2) and the blended text's (3-5) weighted linear light
const TPC_GRID = [0, 1, 2, 3, 4, 5].map(() => new Float64Array(TPC_CHANNEL_STEPS + 1));

/**
 * The worst contrast of a text colour T (sRGB 0..1) at alpha `a` over any composite C in the box lo ≤ C ≤ hi —
 * every channel reachable on its own, since a photo's channels are independent — never above the true worst. Opaque
 * text: exact — 1 when its luminance lies between the two ends, else the nearer end. Translucent text is blended
 * over the composite first (T' = a·T + (1 − a)·C), so both luminances move with C; both are sums of per-channel
 * terms (WCAG luminance), which makes the search separable: the text's lead over the composite (L(T') − L(C)) spans
 * the sum of its per-channel extremes — a range that can hold 0 means text and composite may trade places (1:1) —
 * and the smallest ratio (L(T') + .05) / (L(C) + .05), or its inverse for darker text, is found by Dinkelbach's
 * iteration, each step a per-channel minimum over a TPC_CHANNEL_STEPS grid. Between two grid values a per-channel
 * term can fall below the lower of them by at most M·h²/8 (M bounds its second derivative: TPC_LIN2 times its
 * weights; h = the step), so the lead's range is widened by that much and the grid's minimum lowered by that bound
 * over the smallest denominator in the box: the result is never above the true worst, and below it by at most
 * about 0.03 %.
 */
function tpcWorstRatio(T, a, lo, hi) {
  if (a >= 1 - 1e-9) {
    const lt = tpcLum(T), l0 = tpcLum(lo), l1 = tpcLum(hi);
    if (lt >= l0 - 1e-12 && lt <= l1 + 1e-12) return 1;
    return Math.min(tpcRatio(lt, l0), tpcRatio(lt, l1));
  }
  const n = TPC_CHANNEL_STEPS, b = 1 - a;
  const C = TPC_GRID.slice(0, 3), X = TPC_GRID.slice(3);
  const h = [0, 0, 0];
  let dMin = 0, dMax = 0, slack = 0;
  for (let k = 0; k < 3; k++) {
    const w = TPC_W[k], tk = a * T[k];
    h[k] = (hi[k] - lo[k]) / n;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i <= n; i++) {
      const c = lo[k] + h[k] * i;
      const vc = w * tpcLin(c), vt = w * tpcLin(tk + b * c);
      C[k][i] = vc;
      X[k][i] = vt;
      const d = vt - vc;
      if (d < mn) mn = d;
      if (d > mx) mx = d;
    }
    dMin += mn;
    dMax += mx;
    slack += (w * TPC_LIN2 * (b * b + 1) * h[k] * h[k]) / 8;
  }
  if (dMin - slack <= 1e-12 && dMax + slack >= -1e-12) return 1;
  // lighter text: minimise (ΣT' + .05) / (ΣC + .05); darker text: its inverse
  const lighter = dMin - slack > 0;
  const N = lighter ? X : C, D = lighter ? C : X;
  const at = (i0, i1, i2) => (0.05 + N[0][i0] + N[1][i1] + N[2][i2]) / (0.05 + D[0][i0] + D[1][i1] + D[2][i2]);
  let lam = Math.min(at(0, 0, 0), at(n, n, n));
  const pick = [0, 0, 0];
  for (let it = 0; it < 60; it++) {
    for (let k = 0; k < 3; k++) {
      const nk = N[k], dk = D[k];
      let best = 0, bv = Infinity;
      for (let i = 0; i <= n; i++) {
        const v = nk[i] - lam * dk[i];
        if (v < bv) {
          bv = v;
          best = i;
        }
      }
      pick[k] = best;
    }
    const next = at(pick[0], pick[1], pick[2]);
    if (!(next < lam - 1e-13)) break;
    lam = next;
  }
  // num − lam·den can fall below its grid minimum by E = Σ M·h²/8, and on the grid it is ≥ den·(lam − λ) ≥
  // Dmin·(lam − λ) for λ ≤ lam: so the true minimum ratio is at least lam − E / Dmin
  let E = 0;
  for (let k = 0; k < 3; k++) E += (TPC_W[k] * TPC_LIN2 * (lighter ? b * b + lam : 1 + lam * b * b) * h[k] * h[k]) / 8;
  return Math.max(1, lam - E / (0.05 + D[0][0] + D[1][0] + D[2][0]));
}

/**
 * A cheap bound of tpcWorstRatio, used past the work bound: the blended text over the box's darkest and lightest
 * corner against the box's lightest and darkest — never above the true worst (often well below it for translucent
 * text); exact for opaque text.
 */
function tpcBoundRatio(T, a, lo, hi) {
  const tl = tpcLum(T.map((v, k) => a * v + (1 - a) * lo[k])), th = tpcLum(T.map((v, k) => a * v + (1 - a) * hi[k]));
  const cl = tpcLum(lo), ch = tpcLum(hi);
  if (tl > ch + 1e-12) return tpcRatio(tl, ch);
  if (th < cl - 1e-12) return tpcRatio(th, cl);
  return 1;
}

/**
 * A gradient whose painted stops (alpha > 0) have more than one colour: its luminance can dip INSIDE a ramp. A
 * single-hue ramp — one colour fading in alpha (a transparent stop's colour is never painted: premultiplied) — moves
 * every channel of what lies under it toward that one colour.
 */
function tpcHueShift(fill) {
  const painted = new Set((fill.stops || []).filter((s) => (s.alpha ?? 1) > 0).map((s) => String(s.color).toUpperCase()));
  return painted.size > 1;
}

/**
 * The slabs to judge a piece in (cells of its text frame), and whether the work bound took finer ones away. One — the
 * piece itself — when nothing that shows varies over it, or only single-hue ramps painted straight over an opaque
 * picture: as such a ramp's alpha grows, `lo` never falls and `hi` never rises in any channel — the box only narrows
 * toward its colour — so the box over the piece is the box where its alpha is lowest, exactly. Any other gradient
 * that shows — stops of different colours (sRGB interpolation: red → green is darkest a quarter of the way), one
 * colour fading over another layer or a translucent picture, the slide background's under a translucent <img> — can
 * be darker inside than at either end, so the piece is cut along the axis where it varies most into slabs that each
 * span at most 1/TPC_SLAB_STEPS of its shortest stop segment there (at most TPC_MAX_SLABS), each judged by its own
 * box: stricter than exact by at most what the layers change across one slab. `coarse` (past the work bound): one.
 */
function tpcSlabs(cell, covering, BG, F, coarse) {
  // only what lies above the last opaque picture shows (the slide background only when none hides it)
  let from = -1;
  covering.forEach((S, i) => {
    if (S.picture && (S.e.kind === 'placeholder' || (S.e.opacity ?? 1) >= 1 - 1e-9)) from = i;
  });
  const dense = covering.filter((S, i) => i > from && !S.picture && S.e.fill && S.e.fill.type === 'linear'
    && (from < 0 || i !== from + 1 || tpcHueShift(S.e.fill)));
  if (from < 0 && BG.e.fill.type === 'linear') dense.push(BG);
  let K = 1;
  let axis = 'x';
  for (const S of dense) {
    const t = (x, y) => {
      const [sx, sy] = F.toSlide(x, y);
      return tpcGradT(S.e.fill, S, sx, sy);
    };
    const ts = [t(cell.x0, cell.y0), t(cell.x1, cell.y0), t(cell.x0, cell.y1), t(cell.x1, cell.y1)];
    const t0 = Math.min(...ts), t1 = Math.max(...ts);
    // the shortest stop segment the piece spans (a hard edge, two stops at one position, is no ramp)
    const stops = S.e.fill.stops || [];
    let seg = Infinity;
    for (let i = 0; i + 1 < stops.length; i++) {
      const p = stops[i].pos, q = stops[i + 1].pos;
      if (q > p && q > t0 && p < t1) seg = Math.min(seg, q - p);
    }
    if (!(seg < Infinity)) continue;
    const k = Math.min(TPC_MAX_SLABS, Math.ceil(((t1 - t0) * TPC_SLAB_STEPS) / seg - 1e-9));
    if (k > K) {
      K = k;
      axis = Math.abs(ts[1] - ts[0]) >= Math.abs(ts[2] - ts[0]) ? 'x' : 'y';
    }
  }
  if (K <= 1 || coarse) return { cells: [cell], reduced: K > 1 };
  const cells = [];
  for (let i = 0; i < K; i++) {
    cells.push(axis === 'x'
      ? { ...cell, x0: cell.x0 + ((cell.x1 - cell.x0) * i) / K, x1: cell.x0 + ((cell.x1 - cell.x0) * (i + 1)) / K }
      : { ...cell, y0: cell.y0 + ((cell.y1 - cell.y0) * i) / K, y1: cell.y0 + ((cell.y1 - cell.y0) * (i + 1)) / K });
  }
  return { cells, reduced: false };
}

/**
 * Cut a line-box cell (text frame) until every candidate region covers each piece fully or not at all: at the edges
 * of regions that are axis-aligned in the frame (exact), else by halving the longer side; a piece under a pixel on
 * both sides takes the regions that hold its centre. `visit(cell, quad, covering, maybe)` gets each piece with the
 * regions covering it, in paint order. Pieces thinner than TPC_MIN_PX are ignored. Past the work bound (`work`) a
 * piece is no longer halved along curved or slanted edges, and twice past it not cut at all: `maybe` holds the
 * regions that cover only part of it.
 */
function tpcWalk(cell, cands, F, visit, depth, work) {
  if (work.stop) return;
  const w = cell.x1 - cell.x0, h = cell.y1 - cell.y0;
  if (w < TPC_MIN_PX || h < TPC_MIN_PX) return;
  const quad = [[cell.x0, cell.y0], [cell.x1, cell.y0], [cell.x1, cell.y1], [cell.x0, cell.y1]].map(([x, y]) => F.toSlide(x, y));
  work.spend(1 + cands.length);
  const inside = new Set();
  const partial = [];
  for (const S of cands) {
    if (quad.every(([x, y]) => tpcInside(S, x, y))) inside.add(S);
    else if (!tpcSeparated(S, quad)) partial.push(S);
  }
  if (!partial.length) {
    visit(cell, quad, cands.filter((S) => inside.has(S)), null);
    return;
  }
  const keep = new Set([...inside, ...partial]);
  const next = cands.filter((S) => keep.has(S));
  // twice past the work bound, not even an axis-aligned edge cuts: the rest of the line is one piece
  if (work.spent()) {
    visit(cell, quad, next, new Set(partial));
    return;
  }
  const go = (a, b) => {
    tpcWalk(a, next, F, visit, depth + 1, work);
    tpcWalk(b, next, F, visit, depth + 1, work);
  };
  for (const S of partial) {
    if (Math.abs(S.deg - F.deg) > 1e-6) continue;
    const [lx, ly] = F.toLocal(S.cx, S.cy);
    for (const x of [lx - S.hw, lx + S.hw]) {
      if (x > cell.x0 + 1e-6 && x < cell.x1 - 1e-6) return go({ ...cell, x1: x }, { ...cell, x0: x });
    }
    for (const y of [ly - S.hh, ly + S.hh]) {
      if (y > cell.y0 + 1e-6 && y < cell.y1 - 1e-6) return go({ ...cell, y1: y }, { ...cell, y0: y });
    }
  }
  // past the work bound a curved or slanted edge is followed no further (an axis-aligned one still cuts, above: one
  // cut per edge): the regions still covering only part of the piece may or may not be there
  if (work.coarse()) {
    visit(cell, quad, next, new Set(partial));
    return;
  }
  if ((w < 2 * TPC_MIN_PX && h < 2 * TPC_MIN_PX) || depth > 64) {
    const [x, y] = F.toSlide((cell.x0 + cell.x1) / 2, (cell.y0 + cell.y1) / 2);
    visit(cell, quad, next.filter((S) => inside.has(S) || tpcInside(S, x, y)), null);
    return;
  }
  if (w >= h) {
    const m = (cell.x0 + cell.x1) / 2;
    return go({ ...cell, x1: m }, { ...cell, x0: m });
  }
  const m = (cell.y0 + cell.y1) / 2;
  return go({ ...cell, y1: m }, { ...cell, y0: m });
}

/**
 * The runs drawn on each line of a text element: lines and runs come from the same characters, so a line's text is
 * a slice of its paragraph's run texts (<br> runs carry none). [{L, index, runs}]
 */
function tpcLineRuns(e) {
  const paras = (e.paragraphs || []).map((p) => {
    const out = [];
    let pos = 0;
    for (const r of p.runs || []) {
      if (r.break) continue;
      const t = String(r.text || '');
      out.push({ s: pos, e: pos + t.length, r });
      pos += t.length;
    }
    return out;
  });
  const at = new Map();
  return (e.lines || []).map((L, index) => {
    const s = at.get(L.paragraph) || 0;
    const n = String(L.text || '').length;
    at.set(L.paragraph, s + n);
    const runs = (paras[L.paragraph] || [])
      .filter((x) => x.e > s && x.s < s + n && /\S/.test(String(x.r.text || '').slice(Math.max(0, s - x.s), s + n - x.s)))
      .map((x) => x.r);
    return { L, index, runs };
  });
}

function tpcText(e) {
  return (e.paragraphs || []).map((p) => (p.runs || []).map((r) => (r.break ? ' ' : r.text || '')).join('')).join(' ');
}

/**
 * Every text element drawn on a picture below the contrast it needs: [{el, ratio, need, large, line, lineText, lines,
 * picture, above, through, textAlpha, partly, bounded, boundBy}] — the worst point of each element (`line` = its
 * 0-based line index, `through` = the share of the picture showing there, `above` = the layers between picture and
 * text there, `partly` = that line box is partly under a layer elsewhere, `bounded` = that worst came from a bound the
 * work limit forced, stricter than the exact search, `boundBy` = the budget that ran out: 'element' or 'slide').
 * `elements` in paint order (IR records; a picture is recognised by tpcIsPicture), `background` = the slide's
 * background Fill, `slide` = its size.
 */
function tpcFindings(elements, background, slide = { w: 1280, h: 720 }) {
  const els = elements || [];
  const BG = {
    e: { fill: background || { type: 'solid', color: 'FFFFFF', alpha: 1 }, opacity: 1 }, picture: false,
    deg: 0, cos: 1, sin: 0, hw: slide.w / 2, hh: slide.h / 2, cx: slide.w / 2, cy: slide.h / 2,
  };
  const regions = [];
  els.forEach((e, k) => {
    if (!e || !e.box || !(e.box.w > 0) || !(e.box.h > 0) || !((e.opacity ?? 1) > 0)) return;
    if (tpcIsPicture(e) || (e.kind === 'shape' && tpcFillVisible(e.fill))) regions.push(tpcShape(e, k));
  });
  if (!regions.some((S) => S.picture)) return [];
  // the search work left: deterministic units (not time), so every run of a deck gives the same findings. The slide's
  // budget is spent in paint order, so each text keeps a floor of its own: a later caption is searched exactly however
  // much the texts painted before it used (`by` = which budget a bound came from)
  const work = {
    slide: TPC_SLIDE_WORK, el: 0, stop: false,
    spend(n) { this.el -= n; this.slide -= n; },
    floor() { return this.el >= TPC_ELEMENT_WORK - TPC_ELEMENT_FLOOR; },
    coarse() { return this.el <= 0 || (this.slide <= 0 && !this.floor()); },
    spent() { return this.el <= -TPC_ELEMENT_WORK || (this.slide <= -TPC_SLIDE_WORK && !this.floor()); },
    by() { return this.el <= 0 ? 'element' : 'slide'; },
  };
  const out = [];
  els.forEach((e, k) => {
    if (!e || e.kind !== 'text' || !e.box) return;
    const before = regions.filter((S) => S.k < k);
    if (!before.some((S) => S.picture)) return;
    const op = e.opacity ?? 1;
    const vis = (r) => !r.break && /\S/.test(String(r.text || '')) && (r.alpha ?? 1) * op > 0.004;
    const all = (e.paragraphs || []).flatMap((p) => (p.runs || []).filter(vis));
    if (!all.length) return;
    const large = all.every((r) => r.sizePx >= TPC_LARGE_PX - 1e-6 || (r.sizePx >= TPC_LARGE_BOLD_PX - 1e-6 && r.fontWeight >= 700));
    const need = large ? TPC_NEED_LARGE : TPC_NEED;
    const F = tpcFrame(e);
    const lines = tpcLineRuns(e);
    const drawn = lines.filter(({ L }) => L.left !== null && L.left !== undefined && L.right !== null && L.right !== undefined).length;
    work.el = TPC_ELEMENT_WORK;
    work.stop = false;
    const memo = new Map(); // translucent searches already made: the same box and text give the same ratio
    let worst = null;
    for (const { L, index, runs } of lines) {
      if (work.stop) break; // a 1:1 line was found: nothing can be lower
      if (L.left === null || L.left === undefined || L.right === null || L.right === undefined) continue;
      // the text colours drawn on this line, each once
      const use = [];
      for (const r of runs.some(vis) ? runs.filter(vis) : all) {
        const a = Math.max(0, Math.min(1, (r.alpha ?? 1) * op));
        const key = `${String(r.color).toUpperCase()}/${a}`;
        if (!use.some((u) => u.key === key)) use.push({ key, T: tpcRgb(r.color), a });
      }
      const para = (e.paragraphs || [])[L.paragraph];
      const opensPara = index === 0 || lines[index - 1].L.paragraph !== L.paragraph;
      // an outside list marker hangs left of the line's first character
      const x0 = para && para.bullet && opensPara ? L.left - Math.abs(para.indentPx || 0) : L.left;
      const cell = { x0, x1: L.right, y0: L.top, y1: L.bottom };
      if (cell.x1 - cell.x0 < TPC_MIN_PX || cell.y1 - cell.y0 < TPC_MIN_PX) continue;
      const q = [[cell.x0, cell.y0], [cell.x1, cell.y0], [cell.x1, cell.y1], [cell.x0, cell.y1]].map(([x, y]) => F.toSlide(x, y));
      const qx0 = Math.min(...q.map((p) => p[0])), qx1 = Math.max(...q.map((p) => p[0]));
      const qy0 = Math.min(...q.map((p) => p[1])), qy1 = Math.max(...q.map((p) => p[1]));
      const cands = before.filter((S) => S.x1 > qx0 && S.x0 < qx1 && S.y1 > qy0 && S.y0 < qy1);
      const crosses = (S) => S.picture && Math.min(S.x1, qx1) - Math.max(S.x0, qx0) > 1 && Math.min(S.y1, qy1) - Math.max(S.y0, qy0) > 1;
      if (!cands.some(crosses)) continue;
      let lineWorst = null;
      let covered = false;
      tpcWalk(cell, cands, F, (c, quad, covering, maybe) => {
        if (!covering.some((S) => S.picture)) return;
        // after a 1:1 point only `covered` is still open: the piece as a whole answers it
        const done = !!lineWorst && lineWorst.ratio <= 1 + 1e-12;
        const slabs = tpcSlabs(c, covering, BG, F, done || work.coarse());
        for (const sub of slabs.cells) {
          const box = sub === c ? quad
            : [[sub.x0, sub.y0], [sub.x1, sub.y0], [sub.x1, sub.y1], [sub.x0, sub.y1]].map(([x, y]) => F.toSlide(x, y));
          const m = tpcEnclose(covering, maybe, BG, box);
          work.spend(1 + covering.length);
          if (m.above.length) covered = true; // a layer over the picture here (an opaque one hides it)
          if (done || m.thr <= TPC_VISIBLE) continue;
          for (const u of use) {
            let ratio;
            let bounded = !!maybe || slabs.reduced;
            if (u.a >= 1 - 1e-9) {
              ratio = tpcWorstRatio(u.T, 1, m.lo, m.hi);
              work.spend(1);
            } else if (work.coarse()) {
              ratio = tpcBoundRatio(u.T, u.a, m.lo, m.hi);
              work.spend(1);
              bounded = true;
            } else {
              const key = `${u.key}|${m.lo}|${m.hi}`;
              ratio = memo.get(key);
              if (ratio === undefined) {
                ratio = tpcWorstRatio(u.T, u.a, m.lo, m.hi);
                memo.set(key, ratio);
                work.spend(TPC_SEARCH_WORK);
              }
            }
            if (!lineWorst || ratio < lineWorst.ratio - 1e-12) {
              lineWorst = { ratio, picture: m.top.e, above: m.above.map((S) => S.e), through: m.thr, textAlpha: u.a, bounded, boundBy: bounded ? work.by() : null };
            }
          }
        }
      }, 0, work);
      if (lineWorst && (!worst || lineWorst.ratio < worst.ratio - 1e-12)) {
        worst = { ...lineWorst, line: index, lineText: L.text, partly: covered && !lineWorst.above.length };
      }
      if (worst && worst.ratio <= 1 + 1e-12) work.stop = true;
    }
    if (worst && worst.ratio < need - 1e-9) out.push({ el: e, need, large, lines: drawn, ...worst });
  });
  return out;
}

/** The DOM path of an IR id (its "::kind" suffix dropped), shortened like report.mjs shortPath for long paths. */
function tpcPath(id) {
  const p = String(id || '').replace(/::[a-z-]+\d*(#\d+)?$/, '');
  const parts = p.split(' > ');
  return parts.length > 3 ? `${parts[0]} > … > ${parts[parts.length - 1]}` : p;
}

/** The agent-facing text-on-picture message of a finding: the text, the picture, the ratio, why, and the fix. */
function tpcMessage(f) {
  const clip = (t, n) => {
    const c = String(t || '').replace(/\s+/g, ' ').trim();
    return c.length > n ? `${c.slice(0, n - 1)}…` : c;
  };
  const ratio = Math.floor(f.ratio * 100) / 100;
  const pic = f.picture.kind === 'placeholder' ? `the photo slot ${tpcPath(f.picture.id)} (any photo the user inserts)` : `the picture ${tpcPath(f.picture.id)}`;
  const need = f.large
    ? `the ${f.need}:1 large text needs`
    : `the ${f.need}:1 it needs (3:1 only when every run is ≥ ${TPC_LARGE_PX} px, or ≥ ${TPC_LARGE_BOLD_PX} px at weight ≥ 700)`;
  const where = f.lines > 1 ? `line ${f.line + 1} ("${clip(f.lineText, 30)}")` : null;
  let why;
  if (!f.above.length) {
    const what = where || 'it';
    why = f.partly
      ? `part of ${what} lies outside the layers above the picture, on the bare picture`
      : `${what} lies on the bare picture, with no layer between them`;
  } else {
    const layers = f.above.length === 1 ? `the layer between them (${tpcPath(f.above[0].id)}) still lets` : `the ${f.above.length} layers between them (${f.above.map((a) => tpcPath(a.id)).join(', ')}) still let`;
    why = `${where ? `on ${where} ` : ''}${layers} ${Math.round(f.through * 100)} % of the picture through at the weakest point`;
  }
  const alpha = f.textAlpha < 1 - 1e-9 ? `, and the text colour itself is translucent (alpha ${Math.round(f.textAlpha * 100) / 100})` : '';
  let bound = '';
  if (f.bounded && f.boundBy === 'slide') {
    bound = ' or better (a safe bound, not the exact value: the texts painted before this one used up the slide\'s search budget'
      + ' — merge or remove the translucent shapes under the texts on this slide, or give them plain scrims, and the check'
      + ' measures this one exactly)';
  } else if (f.bounded) {
    bound = ' or better (a safe bound, not the exact value: too many shapes overlap this text to search exactly — merge or'
      + ' remove the translucent shapes under it, or give it one plain scrim, and the check measures it exactly)';
  }
  return `its text ("${clip(tpcText(f.el), 40)}") is painted on ${pic} at a worst-case contrast of ${ratio}:1${bound}, below ${need} — ${why}${alpha}. `
    + 'A photo can put any colour behind text, pure white and pure black included; fix: a scrim under the text (a dark token box, '
    + 'e.g. var(--c-brand-950) at opacity ≥ 0.72, under white text; or a light one under dark text), an opaque card, or move the text '
    + 'off the picture (AUTHORING §7)';
}

/** The lint over the painted slide (90-main.js): one text-on-picture error per text element that fails. */
function textOnPictureLint(elements, background, slide) {
  for (const f of tpcFindings(elements, background, slide)) lint('error', 'text-on-picture', tpcMessage(f), f.el._src || f.el.id);
}
