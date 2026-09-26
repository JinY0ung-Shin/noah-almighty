// In-page extractor code, part 0: shared helpers.
// All tools/extract/inpage/*.js files are concatenated (sorted by name) into ONE function scope and evaluated in
// the slide page; they share top-level declarations. Nothing here touches the DOM on load.

/* global document, window, getComputedStyle, NodeFilter, CSS */

const EPS = 1e-6;

/** Round to 6 decimals: keeps Blink's 1/64 px LayoutUnits exact and makes the JSON deterministic. */
function r6(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  const x = Math.round(v * 1e6) / 1e6;
  return Object.is(x, -0) ? 0 : x;
}

function rbox(b) {
  return { x: r6(b.x), y: r6(b.y), w: r6(b.w), h: r6(b.h) };
}

// ------------------------------------------------------------------------------------------ run state
// Reset by beginRun() at the start of every extraction call.
let ROOT = null;          // main.slide
let ORIGIN = { x: 0, y: 0 }; // viewport position of the slide origin (neutral layout)
let LINT = [];
let CS_CACHE = new Map();
let MEAS = null;          // measuring container (child of <html>, outside the slide)
let TBK_CACHE = new Map(); // element -> text block kind
let TEXT_ROOTS = new Set(); // elements emitted as text roots (their inline descendants are runs, not boxes)
let FIXED_OBJECTS = null; // painted/replaced boxes = fixed PowerPoint objects (growthAnchor), built lazily

function beginRun(root) {
  ROOT = root;
  LINT = [];
  CS_CACHE = new Map();
  PATH_CACHE = new Map();
  OFFSET_CACHE = new Map();
  WIDTH_CACHE = new Map();
  TBK_CACHE = new Map();
  TEXT_ROOTS = new Set();
  FIXED_OBJECTS = null;
}

function lint(severity, rule, message, where) {
  const path = where == null ? null : (typeof where === 'string' ? where : pathOf(where));
  const key = `${severity}|${rule}|${path}|${message}`;
  if (LINT.some((l) => l._k === key)) return;
  LINT.push({ _k: key, severity, rule, message, path });
}

function cs(el) {
  let s = CS_CACHE.get(el);
  if (!s) {
    s = getComputedStyle(el);
    CS_CACHE.set(el, s);
  }
  return s;
}

function px(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// Viewport rect → slide coordinates.
function rectOf(el) {
  const q = el.getBoundingClientRect();
  return { x: q.left - ORIGIN.x, y: q.top - ORIGIN.y, w: q.width, h: q.height };
}

function qrect(q) {
  return { x: q.left - ORIGIN.x, y: q.top - ORIGIN.y, w: q.width, h: q.height };
}

function borderWidths(el) {
  const s = cs(el);
  return { t: px(s.borderTopWidth), r: px(s.borderRightWidth), b: px(s.borderBottomWidth), l: px(s.borderLeftWidth) };
}

function paddings(el) {
  const s = cs(el);
  return { t: px(s.paddingTop), r: px(s.paddingRight), b: px(s.paddingBottom), l: px(s.paddingLeft) };
}

function contentBoxOf(el) {
  const b = rectOf(el);
  const bw = borderWidths(el);
  const p = paddings(el);
  return { x: b.x + bw.l + p.l, y: b.y + bw.t + p.t, w: b.w - bw.l - bw.r - p.l - p.r, h: b.h - bw.t - bw.b - p.t - p.b };
}

function paddingBoxOf(el) {
  const b = rectOf(el);
  const bw = borderWidths(el);
  return { x: b.x + bw.l, y: b.y + bw.t, w: b.w - bw.l - bw.r, h: b.h - bw.t - bw.b };
}

// ------------------------------------------------------------------------------------------ ids
let PATH_CACHE = new Map();

/** Stable, human-readable DOM path that is also a valid CSS selector for the element. */
function pathOf(el) {
  if (!el) return null;
  let p = PATH_CACHE.get(el);
  if (p) return p;
  if (el === ROOT) {
    p = ROOT.id && document.querySelectorAll('#' + CSS.escape(ROOT.id)).length === 1 ? '#' + CSS.escape(ROOT.id) : 'main.slide';
  } else if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
    p = '#' + CSS.escape(el.id);
  } else {
    const parent = el.parentElement;
    let step = el.localName;
    const cls = el.classList && el.classList.length ? '.' + CSS.escape(el.classList[0]) : '';
    step += cls;
    if (parent) {
      const idx = Array.prototype.indexOf.call(parent.children, el) + 1;
      step += `:nth-child(${idx})`;
      p = (parent === document.body || !ROOT.contains(parent) ? parent.localName : pathOf(parent)) + ' > ' + step;
    } else {
      p = step;
    }
  }
  PATH_CACHE.set(el, p);
  return p;
}

// ------------------------------------------------------------------------------------------ CSS value parsing
/** Split at top-level separators (commas by default), ignoring separators inside parentheses/quotes. */
function splitTop(str, sep = ',') {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of str) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) {
      if (cur.trim() !== '' || sep !== ' ') out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur.trim());
  return out.filter((s) => s !== '');
}

const HEX2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();

let COLOR_CANVAS = null;
/** CSS color → {color:'RRGGBB', alpha:0..1}. Handles rgb()/rgba()/color(srgb …); anything else via a canvas pixel. */
function parseColor(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (s === '' || s === 'none') return null;
  if (s === 'transparent') return { color: '000000', alpha: 0 };
  let m = s.match(/^rgba?\(\s*([-\d.e+]+)(?:\s*,\s*|\s+)([-\d.e+]+)(?:\s*,\s*|\s+)([-\d.e+]+)(?:\s*(?:,|\/)\s*([-\d.e+]+)(%?))?\s*\)$/i);
  if (m) {
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[5] === '%') a /= 100;
    return { color: HEX2(+m[1]) + HEX2(+m[2]) + HEX2(+m[3]), alpha: r6(Math.max(0, Math.min(1, a))) };
  }
  m = s.match(/^color\(\s*srgb\s+([-\d.e+]+)\s+([-\d.e+]+)\s+([-\d.e+]+)(?:\s*\/\s*([-\d.e+]+)(%?))?\s*\)$/i);
  if (m) {
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[5] === '%') a /= 100;
    return { color: HEX2(+m[1] * 255) + HEX2(+m[2] * 255) + HEX2(+m[3] * 255), alpha: r6(Math.max(0, Math.min(1, a))) };
  }
  // Fallback (oklch(), lab(), named colours, …): let the canvas convert to sRGB.
  if (!COLOR_CANVAS) {
    COLOR_CANVAS = document.createElement('canvas');
    COLOR_CANVAS.width = COLOR_CANVAS.height = 1;
  }
  const ctx = COLOR_CANVAS.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = s;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  const alpha = d[3] / 255;
  if (alpha === 0) return { color: '000000', alpha: 0 };
  // un-premultiply is not needed: getImageData returns un-premultiplied values
  return { color: HEX2(d[0]) + HEX2(d[1]) + HEX2(d[2]), alpha: r6(alpha) };
}

function parseAngleDeg(tok) {
  const m = String(tok).trim().match(/^([-\d.e+]+)(deg|rad|grad|turn)$/i);
  if (!m) return null;
  const v = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case 'deg': return v;
    case 'rad': return (v * 180) / Math.PI;
    case 'grad': return v * 0.9;
    case 'turn': return v * 360;
    default: return null;
  }
}

function normDeg(a) {
  let x = a % 360;
  if (x < 0) x += 360;
  return x;
}

/** CSS `to <side-or-corner>` → CSS gradient angle for a W×H background positioning area (css-images-3 §3.1.1). */
function sideCornerToAngle(words, w, h) {
  const set = new Set(words);
  const t = (Math.atan2(h, w) * 180) / Math.PI;
  const top = set.has('top'), bottom = set.has('bottom'), left = set.has('left'), right = set.has('right');
  if (top && right) return t;
  if (bottom && right) return 180 - t;
  if (bottom && left) return 180 + t;
  if (top && left) return 360 - t;
  if (top) return 0;
  if (right) return 90;
  if (bottom) return 180;
  if (left) return 270;
  return 180;
}

/**
 * Parse ONE computed background-image layer. Returns {fill, problems[]} where fill is an IR linear Fill, or
 * {fill:null, kind:'radial'|'conic'|'url'|'other'} for layers the IR cannot express.
 * box = background positioning area (padding box) used for corner keywords and px stop positions.
 */
function parseGradientLayer(layer, box) {
  const problems = [];
  const s = layer.trim();
  if (s === 'none') return { fill: null, kind: 'none', problems };
  if (/^url\(/i.test(s)) return { fill: null, kind: 'url', problems };
  if (/^(repeating-)?(radial|conic)-gradient\(/i.test(s)) return { fill: null, kind: s.match(/radial|conic/i)[0].toLowerCase(), problems };
  const m = s.match(/^(repeating-)?linear-gradient\((.*)\)$/is);
  if (!m) return { fill: null, kind: 'other', problems };
  if (m[1]) problems.push('repeating-linear-gradient is drawn as a plain linear gradient');
  const args = splitTop(m[2]);
  let angle = 180;
  let i = 0;
  const first = args[0] || '';
  if (/^in\s/i.test(first)) { problems.push(`gradient interpolation "${first}" ignored`); i = 1; }
  const head = args[i] || '';
  const ang = parseAngleDeg(head.split(/\s+/)[0]);
  if (ang !== null && /^[-\d.e+]+(deg|rad|grad|turn)(\s+in\s.*)?$/i.test(head)) {
    angle = ang;
    i++;
  } else if (/^to\s/i.test(head)) {
    const words = head.replace(/\s+in\s.*$/i, '').split(/\s+/).slice(1).map((x) => x.toLowerCase());
    angle = sideCornerToAngle(words, box.w, box.h);
    i++;
  } else if (/^in\s/i.test(head)) {
    problems.push(`gradient interpolation "${head}" ignored`);
    i++;
  }
  const A = (angle * Math.PI) / 180;
  const lineLen = Math.abs(box.w * Math.sin(A)) + Math.abs(box.h * Math.cos(A)) || 1;
  const raw = [];
  for (const arg of args.slice(i)) {
    // "<color> [<pos> [<pos>]]" or a lone interpolation hint "<pos>"
    const parts = splitTop(arg, ' ');
    const posTok = [];
    let colorTok = null;
    for (const p of parts) {
      if (/^[-\d.e+]+(%|px)$/i.test(p) || /^calc\(/i.test(p)) posTok.push(p);
      else colorTok = colorTok ? colorTok + ' ' + p : p;
    }
    if (!colorTok) { problems.push('gradient colour hint ignored'); continue; }
    const c = parseColor(colorTok);
    if (!c) { problems.push(`unparsed gradient colour ${colorTok}`); continue; }
    const toFrac = (t) => {
      if (/%$/.test(t)) return parseFloat(t) / 100;
      if (/px$/i.test(t)) return parseFloat(t) / lineLen;
      problems.push(`gradient stop position ${t} ignored`);
      return null;
    };
    if (posTok.length === 0) raw.push({ pos: null, ...c });
    for (const t of posTok.slice(0, 2)) raw.push({ pos: toFrac(t), ...c });
  }
  if (raw.length < 1) return { fill: null, kind: 'other', problems: problems.concat('gradient without colour stops') };
  if (raw.length === 1) raw.push({ ...raw[0], pos: null });
  // CSS stop fix-up: first 0, last 1, monotonic, evenly distribute runs of missing positions.
  if (raw[0].pos == null) raw[0].pos = 0;
  if (raw[raw.length - 1].pos == null) raw[raw.length - 1].pos = Math.max(1, ...raw.filter((r) => r.pos != null).map((r) => r.pos));
  let maxSeen = -Infinity;
  for (const r of raw) {
    if (r.pos != null) {
      if (r.pos < maxSeen) r.pos = maxSeen;
      maxSeen = r.pos;
    }
  }
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].pos != null) continue;
    let j = k;
    while (raw[j].pos == null) j++;
    const a = raw[k - 1].pos, b = raw[j].pos, n = j - k + 1;
    for (let q = k; q < j; q++) raw[q].pos = a + ((b - a) * (q - k + 1)) / n;
    k = j;
  }
  const stops = clipStops(raw.map((r) => ({ pos: r.pos, color: r.color, alpha: r.alpha })))
    .map((r) => ({ pos: r6(r.pos), color: r.color, alpha: r6(r.alpha) }));
  return { fill: { type: 'linear', angleDeg: r6(normDeg(angle)), stops }, kind: 'linear', problems };
}

/** Colour of a (fixed-up, monotonic) stop list at position t: premultiplied sRGB interpolation (CSS Images 4 §3.4). */
function stopColorAt(stops, t) {
  if (t <= stops[0].pos) return { color: stops[0].color, alpha: stops[0].alpha };
  const last = stops[stops.length - 1];
  if (t >= last.pos) return { color: last.color, alpha: last.alpha };
  let k = 0;
  while (k < stops.length - 2 && stops[k + 1].pos <= t) k++; // last stop at or before t (hard stops: take the later one)
  const a = stops[k], b = stops[k + 1];
  const f = b.pos > a.pos ? (t - a.pos) / (b.pos - a.pos) : 1;
  const rgb = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const ca = rgb(a.color).map((v) => v * a.alpha), cb = rgb(b.color).map((v) => v * b.alpha);
  const alpha = a.alpha + (b.alpha - a.alpha) * f;
  const pm = ca.map((v, i) => v + (cb[i] - v) * f);
  const c = alpha > 0 ? pm.map((v) => v / alpha) : rgb(f < 0.5 ? a.color : b.color);
  return { color: c.map(HEX2).join(''), alpha };
}

/**
 * Restrict a stop list to the gradient line's 0..1 range (the IR/DrawingML range): stops outside are replaced by the
 * interpolated colour AT 0 / 1, so the visible part of the gradient is unchanged.
 */
function clipStops(stops) {
  if (stops.every((s) => s.pos >= 0 && s.pos <= 1)) return stops;
  const inside = stops.filter((s) => s.pos > 0 && s.pos < 1);
  const at0 = stops.filter((s) => s.pos === 0), at1 = stops.filter((s) => s.pos === 1);
  const out = [];
  out.push(at0.length ? at0[at0.length - 1] : { pos: 0, ...stopColorAt(stops, 0) });
  out.push(...inside);
  out.push(at1.length ? at1[0] : { pos: 1, ...stopColorAt(stops, 1) });
  return out.map((s) => ({ pos: Math.min(1, Math.max(0, s.pos)), color: s.color, alpha: s.alpha }));
}

/** Computed box-shadow → [{offsetXPx, offsetYPx, blurPx, spreadPx, color, alpha, inset}] */
function parseShadows(str) {
  if (!str || str === 'none') return [];
  const out = [];
  for (const one of splitTop(str)) {
    const toks = splitTop(one, ' ');
    let inset = false;
    let color = null;
    const lens = [];
    for (const t of toks) {
      if (t === 'inset') inset = true;
      else if (/^[-\d.e+]+(px)?$/i.test(t)) lens.push(parseFloat(t));
      else color = parseColor(t);
    }
    if (!color) color = { color: '000000', alpha: 1 };
    out.push({ offsetXPx: lens[0] || 0, offsetYPx: lens[1] || 0, blurPx: lens[2] || 0, spreadPx: lens[3] || 0, color: color.color, alpha: color.alpha, inset });
  }
  return out;
}

/**
 * Resolve the four corner radii to USED px values (css-backgrounds-3 §5.5 clamping). Returns
 * {corners:[[rx,ry]×4 (tl,tr,br,bl)], uniform:bool, circular:bool, ellipse:bool, r}.
 */
function usedRadii(el, box) {
  const s = cs(el);
  const vals = [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius];
  const corners = vals.map((v) => {
    const parts = String(v).trim().split(/\s+/);
    const res = (t, basis) => (/%$/.test(t) ? (parseFloat(t) / 100) * basis : px(t));
    const rx = res(parts[0], box.w);
    const ry = res(parts[1] !== undefined ? parts[1] : parts[0], box.h);
    return [rx, ry];
  });
  const sumTop = corners[0][0] + corners[1][0], sumBottom = corners[3][0] + corners[2][0];
  const sumLeft = corners[0][1] + corners[3][1], sumRight = corners[1][1] + corners[2][1];
  let f = 1;
  if (sumTop > 0) f = Math.min(f, box.w / sumTop);
  if (sumBottom > 0) f = Math.min(f, box.w / sumBottom);
  if (sumLeft > 0) f = Math.min(f, box.h / sumLeft);
  if (sumRight > 0) f = Math.min(f, box.h / sumRight);
  if (f < 1) for (const c of corners) { c[0] *= f; c[1] *= f; }
  const all = corners.flat();
  const zero = all.every((v) => v <= EPS);
  const uniform = all.every((v) => Math.abs(v - corners[0][0]) <= 0.01) || zero;
  const halfW = box.w / 2, halfH = box.h / 2;
  const ellipse = !zero && corners.every(([rx, ry]) => Math.abs(rx - halfW) <= 0.01 && Math.abs(ry - halfH) <= 0.01);
  const sameCorners = corners.every(([rx, ry]) => Math.abs(rx - corners[0][0]) <= 0.01 && Math.abs(ry - corners[0][1]) <= 0.01);
  return { corners, zero, uniform, ellipse, sameCorners, raw: vals };
}

// ------------------------------------------------------------------------------------------ 2D affine matrices
// [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f  (CSS matrix() order)
const IDENT = [1, 0, 0, 1, 0, 0];

function mmul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ];
}

function mapply(M, x, y) {
  return { x: M[0] * x + M[2] * y + M[4], y: M[1] * x + M[3] * y + M[5] };
}

function isIdentity(M) {
  return Math.abs(M[0] - 1) < 1e-9 && Math.abs(M[1]) < 1e-9 && Math.abs(M[2]) < 1e-9 && Math.abs(M[3] - 1) < 1e-9 &&
    Math.abs(M[4]) < 1e-9 && Math.abs(M[5]) < 1e-9;
}

function isRigid(M) {
  return Math.abs(M[0] - M[3]) < 1e-5 && Math.abs(M[1] + M[2]) < 1e-5 && Math.abs(M[0] * M[0] + M[1] * M[1] - 1) < 1e-5;
}

function rotationOf(M) {
  let d = (Math.atan2(M[1], M[0]) * 180) / Math.PI;
  if (d <= -180) d += 360;
  if (Math.abs(d) < 1e-7) d = 0;
  return d;
}

/** Parse a computed `transform` value into a 2D matrix; {m, problem} (problem = string when not 2D-representable). */
function parseTransform(str) {
  if (!str || str === 'none') return { m: IDENT.slice(), problem: null };
  let m = str.match(/^matrix\(([^)]*)\)$/);
  if (m) {
    const v = m[1].split(',').map(Number);
    return { m: v, problem: null };
  }
  m = str.match(/^matrix3d\(([^)]*)\)$/);
  if (m) {
    const v = m[1].split(',').map(Number);
    const flat2d = Math.abs(v[2]) < 1e-9 && Math.abs(v[3]) < 1e-9 && Math.abs(v[6]) < 1e-9 && Math.abs(v[7]) < 1e-9 &&
      Math.abs(v[8]) < 1e-9 && Math.abs(v[9]) < 1e-9 && Math.abs(v[10] - 1) < 1e-9 && Math.abs(v[11]) < 1e-9 &&
      Math.abs(v[14]) < 1e-9 && Math.abs(v[15] - 1) < 1e-9;
    return { m: [v[0], v[1], v[4], v[5], v[12], v[13]], problem: flat2d ? null : '3D transform (matrix3d)' };
  }
  return { m: IDENT.slice(), problem: `unparsed transform ${str}` };
}

/** Full local transform (translate · rotate · scale · transform, about transform-origin) of `el` in slide coords. */
function localTransformOf(el, rec, box) {
  // rec: {transform, rotate, translate, scale, origin} captured BEFORE neutralisation
  const problems = [];
  const t = parseTransform(rec.transform);
  if (t.problem) problems.push(t.problem);
  let M = t.m;
  if (rec.scale && rec.scale !== 'none') {
    const v = rec.scale.split(/\s+/).map(parseFloat);
    const sx = v[0], sy = v.length > 1 ? v[1] : v[0];
    M = mmul([sx, 0, 0, sy, 0, 0], M);
  }
  if (rec.rotate && rec.rotate !== 'none') {
    const parts = rec.rotate.trim().split(/\s+/);
    let deg = parseAngleDeg(parts[parts.length - 1]);
    if (parts.length > 1) {
      const axis = parts.slice(0, -1);
      const isZ = axis.length === 1 ? axis[0] === 'z' : (axis.length === 3 && +axis[0] === 0 && +axis[1] === 0 && +axis[2] > 0);
      if (!isZ) problems.push(`3D rotate: ${rec.rotate}`);
    }
    if (deg === null) { problems.push(`unparsed rotate ${rec.rotate}`); deg = 0; }
    const a = (deg * Math.PI) / 180;
    M = mmul([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0], M);
  }
  if (rec.translate && rec.translate !== 'none') {
    const v = rec.translate.split(/\s+/);
    const res = (tok, basis) => (/%$/.test(tok) ? (parseFloat(tok) / 100) * basis : px(tok));
    const tx = res(v[0], box.w), ty = v.length > 1 ? res(v[1], box.h) : 0;
    if (v.length > 2 && px(v[2]) !== 0) problems.push(`3D translate: ${rec.translate}`);
    M = mmul([1, 0, 0, 1, tx, ty], M);
  }
  const o = rec.origin.split(/\s+/).map(px);
  const ox = box.x + (o[0] || 0), oy = box.y + (o[1] || 0);
  return { M: mmul(mmul([1, 0, 0, 1, ox, oy], M), [1, 0, 0, 1, -ox, -oy]), problems };
}
