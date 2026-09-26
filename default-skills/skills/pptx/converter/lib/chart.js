/* lib/chart.js — in-page SVG preview of CONTRACT ChartSpec charts (docs/CONTRACT.md "kind: chart").
 *
 * Renders every [data-chart] element as an inline <svg> whose geometry follows the native PowerPoint chart that
 * tools/pptxlib/chart.py builds from the same spec (the repository's docs/pptx-converter/research/chart-mapping.md §3.3):
 *   - plot rect P = the chart's c:manualLayout (layoutTarget inner, edge) — published as data-resolved.plot;
 *   - value scale y = P.y + P.h·(max − v)/(max − min) (bars: x = P.x + P.w·(v − min)/(max − min));
 *   - band B = P.w / nCats (columns, left → right) or P.h / nCats (bars, TOP → bottom: the builder reverses the
 *     category axis and crosses the value axis at max); clustered bar thickness w = B / (N − (N−1)·O + G) with
 *     G = gapWidth/100, O = overlap/100, series i at bandStart + G·w/2 + i·w·(1 − O); stacked w = B / (1 + G);
 *   - line points at band centres, 3 px round-capped line, circle markers c:size 5 pt (= round(7 px · 0.75)),
 *     null = gap; gridlines at min + k·majorUnit; category axis line at the zero crossing (autoZero);
 *   - pie/doughnut: circle inscribed in the SQUARE plot rect, first slice at firstSliceAng° clockwise from
 *     12 o'clock, slices clockwise in category order, hole = holeSize % of the outer radius;
 *   - data-label positions mapped exactly like chart.py resolve_dlbl_pos (stacked outEnd → inEnd, line
 *     outEnd → t / inEnd → b, doughnut: centred on the ring);
 *   - text: var(--font-sans), weights/sizes/colours from the spec, PowerPoint's line box (1.2 × size) with the
 *     baseline seat 1.2·A/(A+D)·size (usWin metrics, text-mapping.md §2.1; A/D measured from the loaded font);
 *   - legend: Office entry order (clustered horizontal bars list the last series first; stacked columns/lines
 *     reverse a right legend), square keys 0.45 × the face's line box, auto-positioned against the FRAME.
 * Label/legend offsets that PowerPoint computes internally (not in the file) are the MODEL constants below: where
 * PowerPoint evidence exists they follow it (label-box insets PowerPoint writes; office2pdf's fits to native
 * PowerPoint 16.112 exports for the legend key, key gap and right-legend clearance; ONLYOFFICE's Office-emulating
 * rules for pie inside-end labels), everything else is calibrated on LibreOffice 7.4 (Noah's preview renderer),
 * measured with scratch/chart-builder/run.sh (compare.py). Never tuned to a known LibreOffice-only artefact
 * (bottom-legend unit bug, ignored holeSize, corner-anchored inside-end pie labels, "low" label offset).
 *
 * Publishes on each chart element data-resolved='{"plot":{x,y,w,h},"valueMin","valueMax","majorUnit"}' (plot in
 * CSS px relative to the element's border box; square for pie/doughnut, whose scale fields are null) and sets
 * document.documentElement.dataset.chartsReady = "1" once every chart is drawn. Plain ES2020, no dependencies.
 * API: window.NoahChart = { renderAll, renderChart, resolveScale, formatNumber, MODEL, ready }.
 */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  // ---- defaults shared with tools/pptxlib/chart.py (keep both files in sync) ------------------------------
  var PALETTE = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];  // Office 2013+ accents
  var TEXT_COLOR = '475569';
  var DEFAULT_SIZE = 13;
  var DEFAULT_GAP_WIDTH = 150;
  var DEFAULT_OVERLAP = 0;
  var DEFAULT_HOLE = 50;
  var GRID_COLOR = 'E5E7EB';
  var LINE_WIDTH_PX = 3;          // a:ln w=28575
  var MARKER_PT = 5;              // c:marker/c:size = round(7 px × 0.75)
  var MARKER_LINE_PX = 1;         // marker outline a:ln w=9525

  // ---- layout model (offsets PowerPoint positions internally) ---------------------------------------------
  var MODEL = {
    lineBox: 1.2,          // PowerPoint line box = 1.2 × font size
    dlInsetX: 4,           // data-label bodyPr lIns/rIns = 38100 EMU (written by chart.py)
    dlInsetY: 2,           // data-label bodyPr tIns/bIns = 19050 EMU
    dlGap: 1.5,            // column end → data-label box (box carries the insets): text line 3.5 px from the
                           // bar ≈ 0.285·S, the text distance office2pdf's native PowerPoint measurements imply
    dlGapH: 0,             // horizontal bar end → label box: text starts lIns (4 px) after the bar end
    lineLabelGap: 2,       // marker edge → line data-label box
    catGap: 2.5,           // category axis → category label line box (columns / lines)
    catGapH: 3.8,          // category label right edge → plot left (horizontal bars)
    valGap: 5,             // value label right edge → plot left (columns / lines)
    valGapV: 2.5,          // plot bottom → value label line box (horizontal bars)
    // legend (auto-positioned; S = legend font px). PowerPoint-measured where known (office2pdf fits to native
    // PowerPoint 16.112 exports; sources in scratch/chart-builder/sources/), else LibreOffice 7.4 VLegend.cxx:
    legendKeyBox: 0.45,    // PowerPoint: square key side = 0.45 × the face's hhea line box × S (11 exports)
    legendKeyGapPt: -0.375,// PowerPoint: key → label = 0.5 × key − 0.375 pt
    legendLineKey: 25.6,   // px: line-series key length (19.2 pt, Excel native; LibreOffice uses 8 mm)
    legendRightPad: 13.5,  // px: widest right-legend label ends 10.127 pt from the frame's right edge (PowerPoint)
    legendMarginTB: 6.99,  // LibreOffice: frame top/bottom → legend box (1.85 mm)
    legendPadY: 0.2,       // LibreOffice: × S, min 3.78 px (top/bottom box padding)
    legendEntryGap: 0.66,  // LibreOffice: × S, min 3.78 px (between entries of a horizontal legend)
    legendRowGap: 0.2,     // LibreOffice: × S, min 3.78 px (between rows of a vertical legend)
    legendMinPx: 3.78,
    legendPlotGap: 8,      // legend ↔ plot/axis labels (layout reserve only)
    pieCtrRadius: 0.5,     // pie "ctr" label centre, fraction of the radius
    pieLabelGap: 4,        // layout reserve around a pie with outEnd labels (beyond pieOutOffset)
    pieOutOffset: 5.67,    // outEnd anchor distance outside the rim (LibreOffice: 150/100 mm)
    lowExtra: 8,           // extra reserve beside tickLblPos="low" labels (value axis below zero): LibreOffice
                           // draws them ~6 px further out and shrinks a manual plot whose labels leave the frame
    maxCatLines: 3,
    slack: 1.02            // width reserve factor for text PowerPoint measures (Malgun substitute slack)
  };

  // ---------------------------------------------------------------------------------------------- utilities
  function num(v) {
    if (v === null || v === undefined || typeof v === 'boolean' || v === '') return null;
    var f = Number(v);
    return isFinite(f) ? f : null;
  }
  function tidy(v) { return (v === 0 || !isFinite(v)) ? v : Number(v.toPrecision(12)); }
  function hex(c, def) {
    if (c === null || c === undefined) return def;
    var s = String(c).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.replace(/(.)/g, '$1$1');
    if (/^[0-9a-fA-F]{8}$/.test(s)) s = s.slice(0, 6);
    return /^[0-9a-fA-F]{6}$/.test(s) ? s.toUpperCase() : def;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function r3(v) { return Math.round(v * 1000) / 1000; }

  // ------------------------------------------------------------------------------------ Excel number format
  function splitSections(fmt) {
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < fmt.length; i++) {
      var ch = fmt[i];
      if (inQ) { cur += ch; if (ch === '"') inQ = false; continue; }
      if (ch === '"') { inQ = true; cur += ch; continue; }
      if (ch === '\\' && i + 1 < fmt.length) { cur += ch + fmt[++i]; continue; }
      if (ch === ';') { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }
  function tokenize(sec) {
    var toks = [];
    for (var i = 0; i < sec.length; i++) {
      var ch = sec[i];
      if (ch === '"') {
        var j = sec.indexOf('"', i + 1);
        if (j < 0) j = sec.length;
        toks.push({ k: 'lit', v: sec.slice(i + 1, j) });
        i = j;
      } else if (ch === '\\') {
        if (i + 1 < sec.length) toks.push({ k: 'lit', v: sec[++i] });
      } else if (ch === '[') {
        var e = sec.indexOf(']', i);
        i = e < 0 ? sec.length : e;
      } else if (ch === '_') {
        i++;
        toks.push({ k: 'lit', v: ' ' });
      } else if (ch === '*') {
        i++;
      } else if (/^general/i.test(sec.slice(i, i + 7))) {
        toks.push({ k: 'general' });
        i += 6;
      } else if (ch === '0' || ch === '#' || ch === '?') {
        toks.push({ k: 'd', v: ch });
      } else if (ch === '.') {
        toks.push({ k: 'dot' });
      } else if (ch === ',') {
        toks.push({ k: 'comma' });
      } else if (ch === '%') {
        toks.push({ k: 'pct' });
      } else {
        toks.push({ k: 'lit', v: ch });
      }
    }
    return toks;
  }
  function generalNumber(v) {
    if (v === 0) return '0';
    var a = Math.abs(v);
    if (a >= 1e11 || a < 1e-9) {
      var parts = v.toExponential(5).split('e');
      var mant = parts[0].indexOf('.') >= 0 ? parts[0].replace(/0+$/, '').replace(/\.$/, '') : parts[0];
      var ex = parseInt(parts[1], 10);
      return mant + 'E' + (ex < 0 ? '-' : '+') + (Math.abs(ex) < 10 ? '0' : '') + Math.abs(ex);
    }
    var intDigits = Math.max(1, Math.floor(Math.log10(a)) + 1);
    var s = String(Number(v.toFixed(Math.max(0, 10 - intDigits))));
    return s.indexOf('e') >= 0 ? generalNumber(Number(v.toPrecision(6))) : s;
  }
  function roundFixed(x, d) {  // half away from zero, decimal-safe
    var r = Math.round(Number(Number(x.toPrecision(15)) + 'e' + d));
    return Number(r + 'e-' + d).toFixed(d);
  }
  /** Excel/PowerPoint number format subset: sections (pos;neg;zero), "literals", \x, [..] stripped, _x, *x,
   *  0 # ? placeholders, thousands separator, trailing-comma scaling, %, General. */
  function formatNumber(value, fmt) {
    var v = num(value);
    if (v === null) return '';
    fmt = (fmt === null || fmt === undefined || fmt === '') ? 'General' : String(fmt);
    var secs = splitSections(fmt);
    var sec = secs[0], neg = false;
    if (v < 0 && secs.length >= 2) { sec = secs[1]; v = -v; }
    else if (v === 0 && secs.length >= 3) { sec = secs[2]; }
    else if (v < 0) { neg = true; v = -v; }
    var toks = tokenize(sec), i;
    var pct = toks.filter(function (t) { return t.k === 'pct'; }).length;
    var first = -1, last = -1;
    for (i = 0; i < toks.length; i++) {
      if (toks[i].k === 'd') { if (first < 0) first = i; last = i; }
    }
    var x = v * Math.pow(100, pct);
    var out = '';
    if (first < 0) {  // no digit placeholders: General and/or literals
      var hasGeneral = false;
      toks.forEach(function (t) {
        if (t.k === 'general') { hasGeneral = true; out += generalNumber(x); }
        else if (t.k === 'lit') out += t.v;
        else if (t.k === 'pct') out += '%';
        else if (t.k === 'dot') out += '.';
        else if (t.k === 'comma') out += ',';
      });
      return (neg && hasGeneral && x !== 0 ? '-' : '') + out;
    }
    // a leading dot directly before the first digit belongs to the number (".00")
    if (first > 0 && toks[first - 1].k === 'dot') first -= 1;
    var intPh = [], fracPh = [], seenDot = false, grouping = false, commaPending = false, scale = 0, inner = '';
    for (i = first; i <= last; i++) {
      var t = toks[i];
      if (t.k === 'dot') { if (!seenDot) seenDot = true; else inner += '.'; continue; }
      if (t.k === 'd') {
        if (seenDot) fracPh.push(t.v); else { if (commaPending && intPh.length) grouping = true; intPh.push(t.v); }
        commaPending = false;
        continue;
      }
      if (t.k === 'comma') {
        if (!seenDot) {
          // a comma followed by the dot scales by 1000 ("0,.0" is rare); between digits = grouping
          if (i + 1 <= last && toks[i + 1].k === 'dot') scale++; else commaPending = true;
        }
        continue;
      }
      if (t.k === 'lit') inner += t.v;
      else if (t.k === 'pct') inner += '%';
    }
    var j = last + 1;
    while (j < toks.length && toks[j].k === 'comma') { scale++; j++; }
    x = x / Math.pow(1000, scale);
    var s = roundFixed(x, fracPh.length);
    var parts = s.split('.'), ip = parts[0], fp = parts[1] || '';
    var minInt = intPh.filter(function (c) { return c === '0'; }).length;
    if (ip === '0' && minInt === 0) ip = '';
    while (ip.length < minInt) ip = '0' + ip;
    if (grouping) ip = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    for (var k = fracPh.length - 1; k >= 0 && fracPh[k] !== '0' && fp.charAt(fp.length - 1) === '0'; k--) {
      fp = fp.slice(0, -1);
    }
    var numStr = ip + (seenDot ? '.' + fp : '');
    var pre = '', post = '';
    for (i = 0; i < first; i++) pre += tokText(toks[i]);
    for (i = j; i < toks.length; i++) post += tokText(toks[i]);
    out = pre + numStr + inner + post;
    var isZero = Number(s) === 0;
    return (neg && !isZero ? '-' : '') + out;
  }
  function tokText(t) {
    return t.k === 'lit' ? t.v : t.k === 'pct' ? '%' : t.k === 'dot' ? '.' : t.k === 'comma' ? ',' :
      t.k === 'd' ? (t.v === '0' ? '0' : '') : '';
  }

  // ----------------------------------------------------------------------------------------------- scale
  var STEP_MANTISSAS = [1, 2, 5];  // Excel's automatic major unit: 1-2-5 × 10^k
  function dataExtent(spec) {
    var series = spec.series || [], ncat = (spec.categories || []).length, i, lo = null, hi = null;
    if (spec.grouping === 'stacked') {
      for (i = 0; i < ncat; i++) {
        var pos = 0, neg = 0, seen = false;
        series.forEach(function (s) {
          var v = num((s.values || [])[i]);
          if (v === null) return;
          seen = true;
          if (v >= 0) pos += v; else neg += v;
        });
        if (seen) { lo = lo === null ? neg : Math.min(lo, neg); hi = hi === null ? pos : Math.max(hi, pos); }
      }
      return lo === null ? [0, 0] : [lo, hi];
    }
    series.forEach(function (s) {
      (s.values || []).forEach(function (raw) {
        var v = num(raw);
        if (v === null) return;
        lo = lo === null ? v : Math.min(lo, v);
        hi = hi === null ? v : Math.max(hi, v);
      });
    });
    return lo === null ? [0, 0] : [lo, hi];
  }
  function intervals(lo, hi, step, fixedMin, fixedMax) {
    var a = fixedMin ? lo : Math.floor(lo / step + 1e-9) * step;
    var b = fixedMax ? hi : Math.ceil(hi / step - 1e-9) * step;
    return (b - a) / step;
  }
  function chooseStep(lo, hi, fixedMin, fixedMax) {
    var span = hi - lo, k0 = Math.floor(Math.log10(span)), cands = [], k, m;
    for (k = k0 - 3; k <= k0 + 1; k++) for (m = 0; m < STEP_MANTISSAS.length; m++) cands.push(STEP_MANTISSAS[m] * Math.pow(10, k));
    cands.sort(function (a, b) { return a - b; });
    if (fixedMin && fixedMax) {
      var best = null;
      cands.forEach(function (st) {
        var n = span / st, rn = Math.round(n);
        if (Math.abs(n - rn) < 1e-9 && rn >= 2 && rn <= 10) {
          var score = [Math.abs(rn - 5), -st];
          if (!best || score[0] < best[0][0] || (score[0] === best[0][0] && score[1] < best[0][1])) best = [score, st];
        }
      });
      if (best) return best[1];
    }
    for (k = 0; k < cands.length; k++) {
      if (intervals(lo, hi, cands[k], fixedMin, fixedMax) <= 7 + 1e-9) return cands[k];
    }
    return cands[cands.length - 1];
  }
  /** {valueMin, valueMax, majorUnit}: spec values when given, else an Excel-like nice scale
   *  (tools/pptxlib/chart.py nice_scale is the identical Python port). */
  function resolveScale(spec) {
    var t = spec.type, va = spec.valueAxis || {};
    var umin = num(va.min), umax = num(va.max), umaj = num(va.majorUnit);
    if (umaj !== null && umaj <= 0) umaj = null;
    var ext = dataExtent(spec), lo = ext[0], hi = ext[1];
    if (t === 'column' || t === 'bar' || spec.grouping === 'stacked') {
      lo = Math.min(lo, 0); hi = Math.max(hi, 0);
    } else if (lo >= 0 && hi > 0 && (hi - lo) / hi >= 1 / 6) {
      lo = 0;
    } else if (hi <= 0 && lo < 0 && (hi - lo) / -lo >= 1 / 6) {
      hi = 0;
    } else if (hi > lo) {
      var pad = 0.05 * (hi - lo);
      lo = lo !== 0 ? lo - pad : lo;
      hi = hi !== 0 ? hi + pad : hi;
    }
    if (umin !== null) lo = umin;
    if (umax !== null) hi = umax;
    if (!(hi > lo)) {
      if (umax === null) hi = lo + (Math.abs(lo) || 1); else lo = hi - (Math.abs(hi) || 1);
    }
    var step = umaj || chooseStep(lo, hi, umin !== null, umax !== null);
    var vmin = umin !== null ? umin : Math.floor(lo / step + 1e-9) * step;
    var vmax = umax !== null ? umax : Math.ceil(hi / step - 1e-9) * step;
    if (umin === null && lo < 0 && (lo - vmin) < 0.05 * (vmax - vmin)) vmin -= step;
    if (umax === null && hi > 0 && (vmax - hi) < 0.05 * (vmax - vmin)) vmax += step;
    return { valueMin: tidy(vmin), valueMax: tidy(vmax), majorUnit: tidy(step) };
  }

  // ------------------------------------------------------------------------- data-label position (chart.py)
  function groupOf(t) { return (t === 'column' || t === 'bar') ? 'barChart' : t === 'line' ? 'lineChart' : t === 'pie' ? 'pieChart' : 'doughnutChart'; }
  var ALLOWED = {
    'barChart:clustered': ['inBase', 'inEnd', 'outEnd', 'ctr'],
    'barChart:stacked': ['inBase', 'inEnd', 'ctr'],
    'lineChart': ['l', 'r', 'b', 't', 'ctr'],
    'pieChart': ['bestFit', 'outEnd', 'inEnd', 'ctr'],
    'doughnutChart': []
  };
  var POS_MAP = {
    barChart: { outEnd: 'outEnd', inEnd: 'inEnd', ctr: 'ctr' },
    lineChart: { outEnd: 't', inEnd: 'b', ctr: 'ctr' },
    pieChart: { outEnd: 'outEnd', inEnd: 'inEnd', ctr: 'ctr' },
    doughnutChart: {}
  };
  function resolveDlPos(spec) {
    var g = groupOf(spec.type), stacked = spec.grouping === 'stacked';
    var p = (spec.dataLabels || {}).position;
    if (!p) p = g === 'barChart' ? (stacked ? 'ctr' : 'outEnd') : g === 'lineChart' ? 'outEnd' : g === 'pieChart' ? 'ctr' : null;
    if (!p) return null;
    var pos = POS_MAP[g][p];
    var allowed = ALLOWED[g === 'barChart' ? g + ':' + (stacked ? 'stacked' : 'clustered') : g];
    if (allowed.indexOf(pos) >= 0) return pos;
    if (g === 'barChart' && p === 'outEnd') return 'inEnd';
    return null;
  }

  // ---------------------------------------------------------------------------------- text metrics/measure
  var metricCache = {};
  function fontShare(family, weight) {
    var key = family + '|' + weight;
    if (metricCache[key]) return metricCache[key];
    var a = 0.8, d = 0.2;
    try {
      var cv = document.createElement('canvas').getContext('2d');
      cv.font = weight + ' 100px ' + family;
      var m = cv.measureText('0가Ag');
      if (m.fontBoundingBoxAscent > 0 && m.fontBoundingBoxDescent >= 0) { a = m.fontBoundingBoxAscent; d = m.fontBoundingBoxDescent; }
    } catch (e) { /* keep defaults */ }
    var res = { share: MODEL.lineBox * a / (a + d), ascent: a / 100, descent: d / 100 };
    metricCache[key] = res;
    return res;
  }

  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(SVGNS, tag);
    if (attrs) for (var k in attrs) if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  }

  function Measurer(svg) {
    var cache = {};
    this.width = function (text, size, weight) {
      var key = size + '|' + weight + '|' + text;
      if (cache[key] !== undefined) return cache[key];
      var t = svgEl('text', { x: 0, y: -1000, 'font-size': size, 'font-weight': weight }, svg);
      t.textContent = text;
      var w = text ? t.getComputedTextLength() : 0;
      svg.removeChild(t);
      cache[key] = w;
      return w;
    };
  }

  var HANGUL_OR_CJK = /[ᄀ-ᇿ　-〿㄰-㆏㐀-䶿一-鿿가-힣豈-﫿＀-￯]/;
  /** Greedy line breaking: at spaces, and between Hangul/CJK characters (PowerPoint eaLnBrk). */
  function wrapText(text, maxW, size, weight, meas, maxLines) {
    text = String(text);
    if (maxW <= 0 || meas.width(text, size, weight) <= maxW) return [text];
    var units = [], cur = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === ' ') { cur += ch; units.push(cur); cur = ''; continue; }
      if (HANGUL_OR_CJK.test(ch)) { if (cur && !/ $/.test(cur) && !HANGUL_OR_CJK.test(cur[cur.length - 1])) { units.push(cur); cur = ''; } cur += ch; units.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur) units.push(cur);
    var lines = [], line = '';
    units.forEach(function (u) {
      var cand = line + u;
      if (line && meas.width(cand.replace(/ +$/, ''), size, weight) > maxW) { lines.push(line.replace(/ +$/, '')); line = u.replace(/^ +/, ''); }
      else line = cand;
    });
    if (line) lines.push(line.replace(/ +$/, ''));
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines - 1).concat([lines.slice(maxLines - 1).join('')]); }
    return lines;
  }

  // ------------------------------------------------------------------------------------------ one chart
  function parseSpec(el) {
    var raw = el.getAttribute('data-chart');
    var spec = JSON.parse(raw);
    if (!spec || typeof spec !== 'object') throw new Error('data-chart is not a JSON object');
    if (['column', 'bar', 'line', 'pie', 'doughnut'].indexOf(spec.type) < 0) throw new Error('unsupported chart type ' + spec.type);
    if (!Array.isArray(spec.categories) || !spec.categories.length) throw new Error('chart needs categories');
    if (!Array.isArray(spec.series) || !spec.series.length) throw new Error('chart needs series');
    return spec;
  }

  /** Everything that does not need layout: normalised options, scale, formatted strings (for font loading). */
  function prepare(el) {
    var spec = parseSpec(el);
    var t = spec.type, pie = (t === 'pie' || t === 'doughnut');
    var dl = spec.dataLabels || {}, va = spec.valueAxis || {}, ca = spec.categoryAxis || {}, lg = spec.legend || {};
    var cats = spec.categories.map(function (c) { return c === null || c === undefined ? '' : String(c); });
    var series = pie ? spec.series.slice(0, 1) : spec.series.slice();
    var n = cats.length;
    var values = series.map(function (s) { var vs = s.values || []; var out = []; for (var i = 0; i < n; i++) out.push(num(vs[i])); return out; });
    var baseW = spec.fontCssWeight || 400;
    var numFmt = dl.numberFormat || va.numberFormat || 'General';
    var o = {
      el: el, spec: spec, type: t, pie: pie, stacked: spec.grouping === 'stacked', cats: cats, series: series, values: values,
      n: n, baseW: baseW,
      dl: { show: !!dl.show, fmt: dl.numberFormat || numFmt, size: dl.sizePx || DEFAULT_SIZE, weight: dl.cssWeight || baseW,
            color: hex(dl.color, TEXT_COLOR), pos: dl.show ? resolveDlPos(spec) : null },
      va: { visible: !!va.visible, fmt: va.numberFormat || numFmt,
            grid: va.gridlines ? { color: hex((va.gridlines || {}).color, GRID_COLOR), width: num((va.gridlines || {}).widthPx) || 1 } : null },
      ca: { visible: ca.visible !== false, size: ca.sizePx || DEFAULT_SIZE, color: hex(ca.labelColor, TEXT_COLOR), line: hex(ca.lineColor, null) },
      lg: { pos: lg.position || 'none', size: lg.sizePx || DEFAULT_SIZE, color: hex(lg.color, TEXT_COLOR) },
      gap: clamp(Math.round(num(spec.gapWidth) === null ? DEFAULT_GAP_WIDTH : num(spec.gapWidth)), 0, 500) / 100,
      overlap: (spec.grouping === 'stacked' ? 100 : clamp(Math.round(num(spec.overlap) === null ? DEFAULT_OVERLAP : num(spec.overlap)), -100, 100)) / 100,
      hole: clamp(Math.round(num(spec.holeSize) === null ? DEFAULT_HOLE : num(spec.holeSize)), 1, 90) / 100,
      firstAngle: (Math.round(num(spec.firstSliceAng) || 0) % 360 + 360) % 360
    };
    o.colors = series.map(function (s, i) { return hex(s.color, PALETTE[i % PALETTE.length]); });
    var pcs = spec.pointColors || {};
    o.pointColor = function (si, pi) {
      var list = pcs[String(si)];
      var c = list ? hex(list[pi], null) : null;
      if (pie) return c || PALETTE[pi % PALETTE.length];
      return c || o.colors[si];
    };
    o.scale = pie ? null : resolveScale(spec);
    // strings per font (for document.fonts.load before measuring)
    var texts = [];
    var baseFont = { w: baseW, text: '' };
    cats.forEach(function (c) { baseFont.text += c; });
    series.forEach(function (s) { baseFont.text += (s.name || ''); });
    if (o.scale && o.va.visible) {
      for (var k = 0; ; k++) {
        var v = tidy(o.scale.valueMin + k * o.scale.majorUnit);
        if (v > o.scale.valueMax + 1e-9 || k > 1000) break;
        baseFont.text += formatNumber(v, o.va.fmt);
      }
    }
    texts.push(baseFont);
    if (o.dl.show) {
      var dlt = '';
      values.forEach(function (vs) { vs.forEach(function (v) { if (v !== null) dlt += formatNumber(v, o.dl.fmt); }); });
      texts.push({ w: o.dl.weight, text: dlt });
    }
    o.texts = texts;
    return o;
  }

  function fontList(el) {
    var cs = getComputedStyle(el);
    var f = (cs.getPropertyValue('--font-sans') || '').trim();
    return f || cs.fontFamily || 'sans-serif';
  }

  function boxOf(el) {
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    var W = r.width, H = r.height;
    if (cs.transform && cs.transform !== 'none') { W = el.offsetWidth; H = el.offsetHeight; }
    var px = function (p) { return parseFloat(cs.getPropertyValue(p)) || 0; };
    var b = { l: px('border-left-width'), t: px('border-top-width'), r: px('border-right-width'), b: px('border-bottom-width') };
    var p = { l: px('padding-left'), t: px('padding-top'), r: px('padding-right'), b: px('padding-bottom') };
    return { W: W, H: H, b: b, C: { x: b.l + p.l, y: b.t + p.t, w: W - b.l - b.r - p.l - p.r, h: H - b.t - b.b - p.t - p.b }, position: cs.position };
  }

  function renderChart(el, prepared) {
    var o = prepared || prepare(el);
    var bx = boxOf(el), W = bx.W, H = bx.H, C = bx.C;
    if (!(W >= 20 && H >= 20 && C.w > 0 && C.h > 0)) throw new Error('chart element too small to draw (' + W + 'x' + H + ')');
    if (bx.position === 'static') el.style.position = 'relative';
    Array.prototype.slice.call(el.children).forEach(function (c) { if (c.getAttribute && c.hasAttribute('data-chart-svg')) el.removeChild(c); });
    var svg = svgEl('svg', {
      'data-chart-svg': '1', xmlns: SVGNS, width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true',
      style: 'position:absolute;left:' + (-bx.b.l) + 'px;top:' + (-bx.b.t) + 'px;overflow:visible;pointer-events:none;' +
        'font-family:var(--font-sans);font-style:normal;font-kerning:none;font-variant-ligatures:none;' +
        'font-feature-settings:normal;letter-spacing:normal;word-spacing:normal;text-transform:none;' +
        'text-rendering:geometricPrecision;fill:currentColor'
    });
    el.appendChild(svg);
    var family = fontList(el);
    var meas = new Measurer(svg);
    var ctx = { o: o, svg: svg, meas: meas, family: family, W: W, H: H, C: C };
    ctx.share = function (w) { return fontShare(family, w).share; };

    var legend = layoutLegend(ctx);
    var R = { x: C.x, y: C.y, w: C.w, h: C.h };
    if (legend) {
      var L = legend.box, g = MODEL.legendPlotGap;
      if (o.lg.pos === 'top') { var nt = Math.max(R.y, L.y + L.h + g); R.h -= nt - R.y; R.y = nt; }
      else if (o.lg.pos === 'bottom') { R.h = Math.min(R.y + R.h, L.y - g) - R.y; }
      else if (o.lg.pos === 'right') { R.w = Math.min(R.x + R.w, L.x - g) - R.x; }
    }
    var P;
    if (o.pie) P = layoutPie(ctx, R);
    else if (o.type === 'bar') P = layoutBar(ctx, R);
    else P = layoutColumn(ctx, R);
    ctx.P = P;

    var gGrid = svgEl('g', { 'class': 'grid' }, svg);
    var gSeries = svgEl('g', { 'class': 'series' }, svg);
    var gAxis = svgEl('g', { 'class': 'axis' }, svg);
    var gLabels = svgEl('g', { 'class': 'labels' }, svg);
    ctx.g = { grid: gGrid, series: gSeries, axis: gAxis, labels: gLabels };
    if (o.pie) drawPie(ctx);
    else if (o.type === 'bar') drawBar(ctx);
    else drawColumnOrLine(ctx);
    if (legend) drawLegend(ctx, legend);

    var resolved = { plot: { x: r3(P.x), y: r3(P.y), w: r3(P.w), h: r3(P.h) },
                     valueMin: o.scale ? o.scale.valueMin : null, valueMax: o.scale ? o.scale.valueMax : null,
                     majorUnit: o.scale ? o.scale.majorUnit : null };
    el.setAttribute('data-resolved', JSON.stringify(resolved));
    return resolved;
  }

  // ---- text helpers
  function text(ctx, parent, str, x, baseline, size, weight, colorHex, anchor) {
    var t = svgEl('text', { x: r3(x), y: r3(baseline), 'font-size': size, 'font-weight': weight, fill: '#' + colorHex,
                            'text-anchor': anchor || 'start' }, parent);
    t.textContent = str;
    return t;
  }
  // baseline of line k of a block whose line-box top is `top`
  function baseAt(ctx, top, size, weight, k) { return top + ctx.share(weight) * size + (k || 0) * MODEL.lineBox * size; }
  // baseline of a single line vertically centred on cy
  function baseMid(ctx, cy, size, weight) { return cy - MODEL.lineBox * size / 2 + ctx.share(weight) * size; }

  // ---------------------------------------------------------------------------------------------- legend
  function legendEntries(ctx) {
    var o = ctx.o;
    if (o.pie) return o.cats.map(function (c, i) { return { text: c, color: o.pointColor(0, i), kind: 'box' }; });
    var list = o.series.map(function (s, i) { return { text: s.name || ('계열 ' + (i + 1)), color: o.colors[i], kind: o.type === 'line' ? 'line' : 'box' }; });
    // Office legend order (Peltier, "Order of Series and Legend Entries in Excel Charts", 2019; LibreOffice
    // VSeriesPlotter::createLegendEntries tdf#125335/#134247): clustered horizontal bars list series in the
    // visual order of an UNreversed bar chart (last series first) at every legend position — reversing the
    // category axis (which chart.py does) does not change it; stacked columns/lines reverse a right legend.
    if ((o.type === 'bar' && !o.stacked) || (o.type !== 'bar' && o.stacked && o.lg.pos === 'right')) list.reverse();
    return list;
  }
  function lgv(k, S) { return Math.max(MODEL.legendMinPx, MODEL[k] * S); }
  function layoutLegend(ctx) {
    var o = ctx.o;
    if (['top', 'bottom', 'right'].indexOf(o.lg.pos) < 0) return null;
    var S = o.lg.size, w = o.baseW, meas = ctx.meas;
    var rowH = MODEL.lineBox * S, padX = 0, padY = lgv('legendPadY', S);
    var fm = fontShare(ctx.family, w);
    var keyH = MODEL.legendKeyBox * (fm.ascent + fm.descent) * S;
    var keyGap = Math.max(0, 0.5 * keyH + MODEL.legendKeyGapPt / 0.75);
    var entries = legendEntries(ctx);
    var keyW = keyH;
    entries.forEach(function (e) { if (e.kind === 'line') keyW = Math.max(keyW, MODEL.legendLineKey); });
    entries = entries.map(function (e) {
      var tw = meas.width(e.text, S, w);
      return { text: e.text, color: e.color, kind: e.kind, kw: keyW, kh: keyH, tw: tw, w: keyW + keyGap + tw };
    });
    var box, rows = [];
    if (o.lg.pos === 'right') {
      var maxW = 0, rowGap = lgv('legendRowGap', S);
      entries.forEach(function (e) { maxW = Math.max(maxW, e.w); rows.push([e]); });
      var h = rows.length * rowH + (rows.length - 1) * rowGap + 2 * padY;
      var bw = maxW + 2 * padX;
      box = { x: ctx.W - MODEL.legendRightPad - bw, y: (ctx.H - h) / 2, w: bw, h: h };
      rows.rowGap = rowGap;
    } else {
      var gap = lgv('legendEntryGap', S), avail = ctx.W - 2 * MODEL.legendRightPad, row = [], rw = 0, widths = [];
      entries.forEach(function (e) {
        var add = (row.length ? gap : 0) + e.w;
        if (row.length && rw + add > avail) { rows.push(row); widths.push(rw); row = []; rw = 0; add = e.w; }
        row.push(e); rw += add;
      });
      if (row.length) { rows.push(row); widths.push(rw); }
      var mw = Math.max.apply(null, widths), rg = lgv('legendRowGap', S);
      var bh = rows.length * rowH + (rows.length - 1) * rg + 2 * padY;
      var bw2 = mw + 2 * padX;
      box = { x: (ctx.W - bw2) / 2, y: o.lg.pos === 'top' ? MODEL.legendMarginTB : ctx.H - MODEL.legendMarginTB - bh, w: bw2, h: bh };
      rows.widths = widths; rows.gap = gap; rows.rowGap = rg;
    }
    return { box: box, rows: rows, rowH: rowH, padX: padX, padY: padY, keyGap: keyGap };
  }
  function drawLegend(ctx, L) {
    var o = ctx.o, S = o.lg.size, w = o.baseW;
    var g = svgEl('g', { 'class': 'legend' }, ctx.svg);
    L.rows.forEach(function (row, ri) {
      var top = L.box.y + L.padY + ri * (L.rowH + L.rows.rowGap);
      var cy = top + L.rowH / 2;
      var x;
      if (o.lg.pos === 'right') x = L.box.x + L.padX;
      else x = L.box.x + L.padX + (L.box.w - 2 * L.padX - L.rows.widths[ri]) / 2;
      row.forEach(function (e, ei) {
        if (ei) x += L.rows.gap;
        if (e.kind === 'line') {
          svgEl('line', { x1: r3(x), y1: r3(cy), x2: r3(x + e.kw), y2: r3(cy), stroke: '#' + e.color, 'stroke-width': LINE_WIDTH_PX,
                          'stroke-linecap': 'round' }, g);
          var mr = MARKER_PT / 0.75 / 2;
          svgEl('circle', { cx: r3(x + e.kw / 2), cy: r3(cy), r: r3(mr), fill: '#' + e.color, stroke: '#' + e.color, 'stroke-width': MARKER_LINE_PX }, g);
        } else {
          svgEl('rect', { x: r3(x + (e.kw - e.kh) / 2), y: r3(cy - e.kh / 2), width: r3(e.kh), height: r3(e.kh), fill: '#' + e.color }, g);
        }
        text(ctx, g, e.text, x + e.kw + L.keyGap, baseMid(ctx, cy, S, w), S, w, o.lg.color, 'start');
        x += e.w;
      });
    });
  }

  // -------------------------------------------------------------------------------- column / line layout
  function gridValues(scale) {
    var out = [];
    for (var k = 0; k <= 1000; k++) {
      var v = tidy(scale.valueMin + k * scale.majorUnit);
      if (v > scale.valueMax + 1e-9 * Math.max(1, Math.abs(scale.valueMax))) break;
      out.push(v);
    }
    return out;
  }
  function maxValueLabelWidth(ctx) {
    var o = ctx.o, m = 0;
    gridValues(o.scale).forEach(function (v) { m = Math.max(m, ctx.meas.width(formatNumber(v, o.va.fmt), o.ca.size, o.baseW)); });
    return m * MODEL.slack;
  }
  function seriesExtremes(o) {  // largest positive end / most negative end drawn (stack sums for stacked)
    var hi = null, lo = null;
    for (var i = 0; i < o.n; i++) {
      if (o.stacked) {
        var p = 0, q = 0, seen = false;
        o.values.forEach(function (vs) { var v = vs[i]; if (v === null) return; seen = true; if (v >= 0) p += v; else q += v; });
        if (seen) { hi = hi === null ? p : Math.max(hi, p); lo = lo === null ? q : Math.min(lo, q); }
      } else {
        o.values.forEach(function (vs) { var v = vs[i]; if (v === null) return; hi = hi === null ? v : Math.max(hi, v); lo = lo === null ? v : Math.min(lo, v); });
      }
    }
    return { hi: hi, lo: lo };
  }
  function dlBoxH(o) { return MODEL.lineBox * o.dl.size + 2 * MODEL.dlInsetY; }
  function markerR() { return MARKER_PT / 0.75 / 2 + MARKER_LINE_PX / 2; }

  function layoutColumn(ctx, R) {
    var o = ctx.o, sc = o.scale, span = sc.valueMax - sc.valueMin;
    var left = o.va.visible ? maxValueLabelWidth(ctx) + MODEL.valGap : 0;
    var P = { x: Math.round(R.x + left), y: 0, w: 0, h: 0 };
    P.w = Math.floor(R.x + R.w - P.x);
    var B = P.w / o.n;
    // category labels (wrapped to the band width)
    var nLines = 0;
    ctx.catLines = o.cats.map(function (c) {
      var ls = o.ca.visible ? wrapText(c, B / MODEL.slack, o.ca.size, o.baseW, ctx.meas, MODEL.maxCatLines) : [];
      nLines = Math.max(nLines, ls.length);
      return ls;
    });
    var bottom = nLines ? MODEL.catGap + nLines * MODEL.lineBox * o.ca.size + (sc.valueMin < 0 ? MODEL.lowExtra : 0) : 0;
    var top = o.va.visible ? MODEL.lineBox * o.ca.size / 2 : 0;
    var ex = seriesExtremes(o);
    var need = 0;  // space above the highest value end
    if (o.type === 'line') need = markerR() + ((o.dl.show && (o.dl.pos === 't')) ? MODEL.lineLabelGap + dlBoxH(o) : 0);
    else if (o.dl.show && o.dl.pos === 'outEnd') need = MODEL.dlGap + dlBoxH(o);
    var yBottom = R.y + R.h - bottom;
    if (need > 0 && ex.hi !== null && ex.hi > 0) {
      var f = clamp((sc.valueMax - Math.min(ex.hi, sc.valueMax)) / span, 0, 0.999);  // fraction of P.h above the value
      var Hb = yBottom - R.y;
      top = Math.max(top, (need - f * Hb) / (1 - f));
    }
    P.y = Math.round(R.y + Math.max(0, top));
    P.h = Math.floor(yBottom - P.y);
    if (P.h < 10) P.h = Math.max(1, Math.floor(R.y + R.h - P.y));
    return P;
  }

  function vy(ctx, v) { var s = ctx.o.scale, P = ctx.P; return P.y + P.h * (s.valueMax - v) / (s.valueMax - s.valueMin); }
  function vx(ctx, v) { var s = ctx.o.scale, P = ctx.P; return P.x + P.w * (v - s.valueMin) / (s.valueMax - s.valueMin); }

  function drawGrid(ctx, horizontal) {
    var o = ctx.o, P = ctx.P;
    if (!o.va.grid) return;
    gridValues(o.scale).forEach(function (v) {
      if (horizontal) { var y = vy(ctx, v); svgEl('line', { x1: P.x, y1: r3(y), x2: P.x + P.w, y2: r3(y), stroke: '#' + o.va.grid.color, 'stroke-width': o.va.grid.width }, ctx.g.grid); }
      else { var x = vx(ctx, v); svgEl('line', { x1: r3(x), y1: P.y, x2: r3(x), y2: P.y + P.h, stroke: '#' + o.va.grid.color, 'stroke-width': o.va.grid.width }, ctx.g.grid); }
    });
  }

  function barGeometry(o, B) {
    var G = o.gap, O = o.overlap, N = o.stacked ? 1 : o.series.length;
    var w = B / (N - (N - 1) * O + G);
    return { w: w, start: G * w / 2, step: w * (1 - O) };
  }

  function drawColumnOrLine(ctx) {
    var o = ctx.o, P = ctx.P, sc = o.scale, B = P.w / o.n;
    drawGrid(ctx, true);
    var base = clamp(0, sc.valueMin, sc.valueMax);
    var labels = [];
    if (o.type === 'column') {
      var geo = barGeometry(o, B);
      for (var i = 0; i < o.n; i++) {
        var band = P.x + i * B, pos = 0, neg = 0;
        o.values.forEach(function (vs, si) {
          var v = vs[i];
          if (v === null) return;
          var from, to, x0;
          if (o.stacked) { x0 = band + geo.start; if (v >= 0) { from = pos; to = pos + v; pos = to; } else { from = neg; to = neg + v; neg = to; } }
          else { x0 = band + geo.start + si * geo.step; from = base; to = v; }
          var y0 = vy(ctx, clamp(from, sc.valueMin, sc.valueMax)), y1 = vy(ctx, clamp(to, sc.valueMin, sc.valueMax));
          svgEl('rect', { x: r3(x0), y: r3(Math.min(y0, y1)), width: r3(geo.w), height: r3(Math.abs(y1 - y0)), fill: '#' + o.pointColor(si, i) }, ctx.g.series);
          if (o.dl.show) labels.push({ v: v, x0: x0, w: geo.w, yEnd: y1, yStart: y0, up: to >= from });
        });
      }
      labels.forEach(function (L) { columnLabel(ctx, L); });
    } else {
      var cum = o.values[0].map(function () { return 0; });
      o.values.forEach(function (vs, si) {
        var pts = vs.map(function (v, i) {
          if (v === null) return null;
          var val = o.stacked ? (cum[i] += v) : v;
          return { x: P.x + (i + 0.5) * B, y: vy(ctx, val), v: v, i: i };
        });
        var d = '', pen = false;
        pts.forEach(function (p) { if (!p) { pen = false; return; } d += (pen ? 'L' : 'M') + r3(p.x) + ' ' + r3(p.y); pen = true; });
        if (d) svgEl('path', { d: d, fill: 'none', stroke: '#' + o.colors[si], 'stroke-width': LINE_WIDTH_PX, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, ctx.g.series);
        pts.forEach(function (p) {
          if (!p) return;
          var c = o.pointColor(si, p.i);
          svgEl('circle', { cx: r3(p.x), cy: r3(p.y), r: r3(MARKER_PT / 0.75 / 2), fill: '#' + c, stroke: '#' + c, 'stroke-width': MARKER_LINE_PX }, ctx.g.series);
          if (o.dl.show) labels.push(p);
        });
      });
      labels.forEach(function (p) { lineLabel(ctx, p); });
    }
    // category axis line at the zero crossing
    if (o.ca.visible && o.ca.line) {
      var ya = vy(ctx, base);
      svgEl('line', { x1: P.x, y1: r3(ya), x2: P.x + P.w, y2: r3(ya), stroke: '#' + o.ca.line, 'stroke-width': 1 }, ctx.g.axis);
    }
    // category labels (tickLblPos nextTo, or low when the axis goes below zero: both at the plot bottom)
    if (o.ca.visible) {
      var top = P.y + P.h + MODEL.catGap;
      ctx.catLines.forEach(function (lines, i) {
        var cx = P.x + (i + 0.5) * B;
        lines.forEach(function (ln, k) { text(ctx, ctx.g.labels, ln, cx, baseAt(ctx, top, o.ca.size, o.baseW, k), o.ca.size, o.baseW, o.ca.color, 'middle'); });
      });
    }
    // value labels (next to the value axis = left of the plot)
    if (o.va.visible) {
      gridValues(sc).forEach(function (v) {
        text(ctx, ctx.g.labels, formatNumber(v, o.va.fmt), P.x - MODEL.valGap, baseMid(ctx, vy(ctx, v), o.ca.size, o.baseW), o.ca.size, o.baseW, o.ca.color, 'end');
      });
    }
  }

  function columnLabel(ctx, L) {
    var o = ctx.o, S = o.dl.size, w = o.dl.weight, bh = dlBoxH(o), cx = L.x0 + L.w / 2, top;
    var str = formatNumber(L.v, o.dl.fmt);
    var pos = o.dl.pos;
    if (pos === 'outEnd') top = L.up ? L.yEnd - MODEL.dlGap - bh : L.yEnd + MODEL.dlGap;
    else if (pos === 'inEnd') top = L.up ? L.yEnd + MODEL.dlGap : L.yEnd - MODEL.dlGap - bh;
    else if (pos === 'inBase') top = L.up ? L.yStart - MODEL.dlGap - bh : L.yStart + MODEL.dlGap;
    else top = (L.yEnd + L.yStart) / 2 - bh / 2;  // ctr
    text(ctx, ctx.g.labels, str, cx, baseAt(ctx, top + MODEL.dlInsetY, S, w), S, w, o.dl.color, 'middle');
  }

  function lineLabel(ctx, p) {
    var o = ctx.o, S = o.dl.size, w = o.dl.weight, bh = dlBoxH(o), str = formatNumber(p.v, o.dl.fmt), off = markerR() + MODEL.lineLabelGap;
    var pos = o.dl.pos, top, x = p.x, anchor = 'middle';
    if (pos === 't') top = p.y - off - bh;
    else if (pos === 'b') top = p.y + off;
    else if (pos === 'r') { top = p.y - bh / 2; x = p.x + off + MODEL.dlInsetX; anchor = 'start'; }
    else if (pos === 'l') { top = p.y - bh / 2; x = p.x - off - MODEL.dlInsetX; anchor = 'end'; }
    else top = p.y - bh / 2;  // ctr
    text(ctx, ctx.g.labels, str, x, baseAt(ctx, top + MODEL.dlInsetY, S, w), S, w, o.dl.color, anchor);
  }

  // ------------------------------------------------------------------------------------- horizontal bars
  function layoutBar(ctx, R) {
    var o = ctx.o, sc = o.scale, span = sc.valueMax - sc.valueMin, S = o.ca.size;
    var maxCatW = 0;
    var capW = R.w * 0.4;
    ctx.catLines = o.cats.map(function (c) {
      if (!o.ca.visible) return [];
      var ls = wrapText(c, capW, S, o.baseW, ctx.meas, MODEL.maxCatLines);
      ls.forEach(function (l) { maxCatW = Math.max(maxCatW, ctx.meas.width(l, S, o.baseW)); });
      return ls;
    });
    var left = o.ca.visible ? maxCatW * MODEL.slack + MODEL.catGapH + (sc.valueMin < 0 ? MODEL.lowExtra : 0) : 0;
    var bottom = o.va.visible ? MODEL.valGapV + MODEL.lineBox * S : 0;
    var right = 0;
    if (o.va.visible) {
      var gv = gridValues(sc);
      right = ctx.meas.width(formatNumber(gv[gv.length - 1], o.va.fmt), S, o.baseW) / 2;
    }
    var P = { x: Math.round(R.x + left), y: Math.round(R.y), w: 0, h: 0 };
    if (o.dl.show && o.dl.pos === 'outEnd') {
      var ex = seriesExtremes(o), mw = 0;
      o.values.forEach(function (vs) { vs.forEach(function (v) { if (v !== null) mw = Math.max(mw, ctx.meas.width(formatNumber(v, o.dl.fmt), o.dl.size, o.dl.weight)); }); });
      var need = MODEL.dlGapH + 2 * MODEL.dlInsetX + mw * MODEL.slack;
      if (ex.hi !== null && ex.hi > 0) {
        var f = clamp((sc.valueMax - Math.min(ex.hi, sc.valueMax)) / span, 0, 0.999);
        var Wb = R.x + R.w - P.x;
        right = Math.max(right, (need - f * Wb) / (1 - f));
      }
    }
    P.w = Math.floor(R.x + R.w - Math.max(0, right) - P.x);
    P.h = Math.floor(R.y + R.h - bottom - P.y);
    return P;
  }

  function drawBar(ctx) {
    var o = ctx.o, P = ctx.P, sc = o.scale, B = P.h / o.n, geo = barGeometry(o, B);
    drawGrid(ctx, false);
    var base = clamp(0, sc.valueMin, sc.valueMax), labels = [];
    for (var i = 0; i < o.n; i++) {
      var band = P.y + i * B, pos = 0, neg = 0;
      o.values.forEach(function (vs, si) {
        var v = vs[i];
        if (v === null) return;
        var from, to, y0;
        if (o.stacked) { y0 = band + geo.start; if (v >= 0) { from = pos; to = pos + v; pos = to; } else { from = neg; to = neg + v; neg = to; } }
        else { y0 = band + geo.start + si * geo.step; from = base; to = v; }
        var x0 = vx(ctx, clamp(from, sc.valueMin, sc.valueMax)), x1 = vx(ctx, clamp(to, sc.valueMin, sc.valueMax));
        svgEl('rect', { x: r3(Math.min(x0, x1)), y: r3(y0), width: r3(Math.abs(x1 - x0)), height: r3(geo.w), fill: '#' + o.pointColor(si, i) }, ctx.g.series);
        if (o.dl.show) labels.push({ v: v, y0: y0, h: geo.w, xEnd: x1, xStart: x0, up: to >= from });
      });
    }
    labels.forEach(function (L) {
      var S = o.dl.size, w = o.dl.weight, cy = L.y0 + L.h / 2, str = formatNumber(L.v, o.dl.fmt), x, anchor;
      var pos = o.dl.pos;
      var gH = MODEL.dlGapH + MODEL.dlInsetX;
      if (pos === 'outEnd') { x = L.up ? L.xEnd + gH : L.xEnd - gH; anchor = L.up ? 'start' : 'end'; }
      else if (pos === 'inEnd') { x = L.up ? L.xEnd - gH : L.xEnd + gH; anchor = L.up ? 'end' : 'start'; }
      else if (pos === 'inBase') { x = L.up ? L.xStart + gH : L.xStart - gH; anchor = L.up ? 'start' : 'end'; }
      else { x = (L.xStart + L.xEnd) / 2; anchor = 'middle'; }
      text(ctx, ctx.g.labels, str, x, baseMid(ctx, cy, S, w), S, w, o.dl.color, anchor);
    });
    if (o.ca.visible && o.ca.line) {
      var xa = vx(ctx, base);
      svgEl('line', { x1: r3(xa), y1: P.y, x2: r3(xa), y2: P.y + P.h, stroke: '#' + o.ca.line, 'stroke-width': 1 }, ctx.g.axis);
    }
    if (o.ca.visible) {
      var S2 = o.ca.size;
      ctx.catLines.forEach(function (lines, i) {
        var cy = P.y + (i + 0.5) * B, top = cy - lines.length * MODEL.lineBox * S2 / 2;
        lines.forEach(function (ln, k) { text(ctx, ctx.g.labels, ln, P.x - MODEL.catGapH, baseAt(ctx, top, S2, o.baseW, k), S2, o.baseW, o.ca.color, 'end'); });
      });
    }
    if (o.va.visible) {
      var topV = P.y + P.h + MODEL.valGapV;
      gridValues(sc).forEach(function (v) {
        text(ctx, ctx.g.labels, formatNumber(v, o.va.fmt), vx(ctx, v), baseAt(ctx, topV, o.ca.size, o.baseW), o.ca.size, o.baseW, o.ca.color, 'middle');
      });
    }
  }

  // --------------------------------------------------------------------------------------- pie / doughnut
  function layoutPie(ctx, R) {
    var o = ctx.o, marg = 0;
    if (o.dl.show && o.type === 'pie' && o.dl.pos === 'outEnd') {
      var mw = 0;
      o.values[0].forEach(function (v) { if (v !== null) mw = Math.max(mw, ctx.meas.width(formatNumber(v, o.dl.fmt), o.dl.size, o.dl.weight)); });
      marg = Math.max(mw * MODEL.slack + 2 * MODEL.dlInsetX, dlBoxH(o)) + MODEL.pieOutOffset + MODEL.pieLabelGap;
    }
    var side = Math.floor(Math.max(1, Math.min(R.w, R.h) - 2 * marg));
    return { x: Math.round(R.x + (R.w - side) / 2), y: Math.round(R.y + (R.h - side) / 2), w: side, h: side };
  }
  function polar(cx, cy, r, deg) { var a = deg * Math.PI / 180; return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a) }; }
  function drawPie(ctx) {
    var o = ctx.o, P = ctx.P, cx = P.x + P.w / 2, cy = P.y + P.h / 2, r = P.w / 2;
    var ri = o.type === 'doughnut' ? r * o.hole : 0;
    var vals = o.values[0], total = 0;
    vals.forEach(function (v) { if (v !== null && v > 0) total += v; });
    if (!(total > 0)) return;
    var ang = o.firstAngle, labels = [];
    vals.forEach(function (v, i) {
      if (v === null || v <= 0) return;
      var sweep = v / total * 360, a0 = ang, a1 = ang + sweep, color = '#' + o.pointColor(0, i), d;
      if (sweep >= 359.999) {
        d = 'M' + r3(cx) + ' ' + r3(cy - r) + 'A' + r + ' ' + r + ' 0 1 1 ' + r3(cx) + ' ' + r3(cy + r) + 'A' + r + ' ' + r + ' 0 1 1 ' + r3(cx) + ' ' + r3(cy - r) + 'Z';
        if (ri > 0) d += 'M' + r3(cx) + ' ' + r3(cy - ri) + 'A' + ri + ' ' + ri + ' 0 1 0 ' + r3(cx) + ' ' + r3(cy + ri) + 'A' + ri + ' ' + ri + ' 0 1 0 ' + r3(cx) + ' ' + r3(cy - ri) + 'Z';
      } else {
        var large = sweep > 180 ? 1 : 0, p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1);
        if (ri > 0) {
          var q1 = polar(cx, cy, ri, a1), q0 = polar(cx, cy, ri, a0);
          d = 'M' + r3(p0.x) + ' ' + r3(p0.y) + 'A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + r3(p1.x) + ' ' + r3(p1.y) +
              'L' + r3(q1.x) + ' ' + r3(q1.y) + 'A' + ri + ' ' + ri + ' 0 ' + large + ' 0 ' + r3(q0.x) + ' ' + r3(q0.y) + 'Z';
        } else {
          d = 'M' + r3(cx) + ' ' + r3(cy) + 'L' + r3(p0.x) + ' ' + r3(p0.y) + 'A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + r3(p1.x) + ' ' + r3(p1.y) + 'Z';
        }
      }
      svgEl('path', { d: d, fill: color, 'fill-rule': 'evenodd' }, ctx.g.series);
      if (o.dl.show) labels.push({ v: v, mid: a0 + sweep / 2 });
      ang = a1;
    });
    var S = o.dl.size, w = o.dl.weight, bh = dlBoxH(o);
    labels.forEach(function (L) {
      var str = formatNumber(L.v, o.dl.fmt), tw = ctx.meas.width(str, S, w), bw = tw + 2 * MODEL.dlInsetX;
      var a = L.mid * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a), lx, ly;
      if (o.type === 'doughnut' || o.dl.pos === 'ctr' || !o.dl.pos) {
        var dist = o.type === 'doughnut' ? (r + ri) / 2 : r * MODEL.pieCtrRadius;  // ring middle / half radius
        lx = cx + dist * dx; ly = cy + dist * dy;
      } else if (o.dl.pos === 'inEnd') {
        // centre on the bisector, pushed out until the box corner facing the rim touches the circle
        // (ONLYOFFICE ChartsDrawer _calculateInEndDLblPosition; LibreOffice instead anchors a corner 1.5 mm
        // inside the rim)
        var hx = (dx >= 0 ? 1 : -1) * bw / 2, hy = (dy >= 0 ? 1 : -1) * bh / 2;
        var A = r * r, Bq = 2 * (r * dx * hx + r * dy * hy), Cq = hx * hx + hy * hy - r * r, disc = Bq * Bq - 4 * A * Cq;
        var t = disc >= 0 ? (-Bq + Math.sqrt(disc)) / (2 * A) : 0.5;
        if (!(t > 0 && t < 1)) t = 0.5;
        lx = cx + t * r * dx; ly = cy + t * r * dy;
      } else {
        // outEnd: anchor = rim point of the bisector pushed out radially by MODEL.pieOutOffset; the label box is
        // attached to it by the corner (or edge centre within 5° of an axis) facing the pie — LibreOffice
        // PolarLabelPositionHelper (ONLYOFFICE uses the same corner rule without the axis zones / offset)
        var ro = r + MODEL.pieOutOffset, px = cx + ro * dx, py = cy + ro * dy;
        var m = ((90 - L.mid) % 360 + 360) % 360;  // math angle, counter-clockwise from 3 o'clock
        var hx, hy;  // -1: label extends left/up of the anchor, 0: centred, +1: right/down
        if (m <= 5 || m >= 355) { hx = 1; hy = 0; }
        else if (m < 85) { hx = 1; hy = -1; }
        else if (m <= 95) { hx = 0; hy = -1; }
        else if (m < 175) { hx = -1; hy = -1; }
        else if (m <= 185) { hx = -1; hy = 0; }
        else if (m < 265) { hx = -1; hy = 1; }
        else if (m <= 275) { hx = 0; hy = 1; }
        else { hx = 1; hy = 1; }
        lx = px + hx * bw / 2; ly = py + hy * bh / 2;
      }
      text(ctx, ctx.g.labels, str, lx, baseMid(ctx, ly, S, w), S, w, o.dl.color, 'middle');
    });
  }

  // ------------------------------------------------------------------------------------------ all charts
  function loadFonts(preps) {
    if (!document.fonts || !document.fonts.load) return Promise.resolve();
    var jobs = [];
    preps.forEach(function (o) {
      var fam = fontList(o.el);
      o.texts.forEach(function (t) {
        var sample = (t.text || '') + ' 0123456789';
        jobs.push(document.fonts.load(t.w + ' 16px ' + fam, sample).catch(function () {}));
      });
    });
    return Promise.all(jobs);
  }
  function nextFrame() {
    return new Promise(function (res) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { res(); }); else setTimeout(res, 0);
    });
  }
  async function renderAll(root) {
    var els = Array.prototype.slice.call((root || document).querySelectorAll('[data-chart]'));
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* ignore */ } }
    var preps = [];
    els.forEach(function (el) {
      try { preps.push(prepare(el)); } catch (e) { el.setAttribute('data-chart-error', String(e && e.message || e)); console.error('chart.js:', e); }
    });
    await loadFonts(preps);
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* ignore */ } }
    metricCache = {};
    preps.forEach(function (o) {
      try { renderChart(o.el, o); o.el.removeAttribute('data-chart-error'); }
      catch (e) { o.el.setAttribute('data-chart-error', String(e && e.message || e)); console.error('chart.js:', e); }
    });
    await nextFrame();
    document.documentElement.dataset.chartsReady = '1';
    return els.length;
  }

  var api = { version: '2026-09-26', renderAll: renderAll, renderChart: renderChart, resolveScale: resolveScale, formatNumber: formatNumber,
              resolveDlPos: resolveDlPos, MODEL: MODEL, PALETTE: PALETTE };
  if (typeof window !== 'undefined') window.NoahChart = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined' && typeof window !== 'undefined' && !window.NOAH_CHART_MANUAL) {
    var start = function () { api.ready = renderAll(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }
})();
