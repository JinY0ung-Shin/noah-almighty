// Glyph coverage from font files (sfnt 'cmap' formats 4 and 12) and the profile's @font-face composite.
import fs from 'node:fs';
import path from 'node:path';

const CACHE = new Map();

/** Set of code points that map to a non-zero glyph in a TrueType/OpenType file. */
export function coverage(file) {
  if (CACHE.has(file)) return CACHE.get(file);
  const buf = fs.readFileSync(file);
  const set = new Set();
  const numTables = buf.readUInt16BE(4);
  let cmap = null;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + 16 * i;
    if (buf.toString('latin1', rec, rec + 4) === 'cmap') cmap = buf.readUInt32BE(rec + 8);
  }
  if (cmap === null) throw new Error(`${file}: no cmap table`);
  const n = buf.readUInt16BE(cmap + 2);
  const subs = [];
  for (let i = 0; i < n; i++) {
    const r = cmap + 4 + 8 * i;
    const pid = buf.readUInt16BE(r), eid = buf.readUInt16BE(r + 2), off = cmap + buf.readUInt32BE(r + 4);
    subs.push({ pid, eid, off, fmt: buf.readUInt16BE(off) });
  }
  const pick = subs.find((s) => s.fmt === 12 && ((s.pid === 3 && s.eid === 10) || s.pid === 0))
    || subs.find((s) => s.fmt === 4 && ((s.pid === 3 && (s.eid === 1 || s.eid === 0)) || s.pid === 0));
  if (!pick) throw new Error(`${file}: no Unicode cmap (format 4/12)`);
  const o = pick.off;
  if (pick.fmt === 12) {
    const groups = buf.readUInt32BE(o + 12);
    for (let g = 0; g < groups; g++) {
      const p = o + 16 + 12 * g;
      const start = buf.readUInt32BE(p), end = buf.readUInt32BE(p + 4), gid = buf.readUInt32BE(p + 8);
      for (let c = start; c <= end; c++) if (gid + (c - start) !== 0) set.add(c);
    }
  } else {
    const segX2 = buf.readUInt16BE(o + 6);
    const seg = segX2 / 2;
    const endP = o + 14, startP = endP + segX2 + 2, deltaP = startP + segX2, rangeP = deltaP + segX2;
    for (let s = 0; s < seg; s++) {
      const end = buf.readUInt16BE(endP + 2 * s), start = buf.readUInt16BE(startP + 2 * s);
      const delta = buf.readInt16BE(deltaP + 2 * s), ro = buf.readUInt16BE(rangeP + 2 * s);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let gid;
        if (ro === 0) gid = (c + delta) & 0xffff;
        else {
          const gp = rangeP + 2 * s + ro + 2 * (c - start);
          gid = buf.readUInt16BE(gp);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        if (gid !== 0) set.add(c);
      }
    }
  }
  CACHE.set(file, set);
  return set;
}

function parseRanges(str) {
  if (!str) return [[0, 0x10ffff]];
  return str.split(',').map((t) => {
    const u = t.trim().replace(/^u\+/i, '');
    if (u.includes('?')) return [parseInt(u.replace(/\?/g, '0'), 16), parseInt(u.replace(/\?/g, 'F'), 16)];
    const [a, b] = u.split('-');
    return [parseInt(a, 16), parseInt(b || a, 16)];
  });
}

/**
 * Faces of the profile CSS: [{family, file (abs), ranges}] — what Chromium can draw the slide text with.
 */
export function profileFaces(root, profile) {
  const cssPath = path.join(root, 'theme', `fonts-${profile}.css`);
  const css = fs.readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const faces = [];
  for (const m of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const body = m[1];
    const fam = (body.match(/font-family\s*:\s*([^;]+);/) || [])[1];
    const url = (body.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/) || [])[1];
    const ur = (body.match(/unicode-range\s*:\s*([^;]+);/) || [])[1];
    if (!fam || !url) continue;
    faces.push({ family: fam.trim().replace(/^["']|["']$/g, ''), file: path.resolve(path.dirname(cssPath), url), ranges: parseRanges(ur) });
  }
  return faces;
}

const inR = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);

/** Characters of `text` that no face (unicode-range ∩ cmap) covers. */
export function uncovered(text, faces) {
  const out = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x20 || cp === 0xa0 || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfeff) continue;
    const ok = faces.some((f) => inR(cp, f.ranges) && coverage(f.file).has(cp));
    if (!ok) out.add(ch);
  }
  return [...out];
}

/** Characters covered by `faces` in the HTML but absent from every file in `files` (e.g. the embedded faces). */
export function notIn(text, files) {
  const out = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x20 || cp === 0xa0) continue;
    if (!files.some((f) => coverage(f).has(cp))) out.add(ch);
  }
  return [...out];
}

/**
 * Agent-facing names of the profiles' CSS families: {cssFamily: label} from fonts.json. A family that IS the font the
 * .pptx names needs no label (embedded: "Pretendard"); a measurement stand-in does — the malgun profile measures with
 * "PoC Malgun Substitute", a composite of OFL fonts metric-matched to 맑은 고딕 whose internal name never reaches a
 * .pptx (the builder writes 맑은 고딕) — so agent-facing text never presents it as "the profile font".
 */
export function familyLabels(fontsJson) {
  const out = {};
  for (const [name, p] of Object.entries((fontsJson && fontsJson.profiles) || {})) {
    if (!p || !p.cssFamily) continue;
    const faces = p.faces || [];
    const typeface = (faces.find((f) => f.cssWeight === 400) || faces[0] || {}).typeface;
    if (typeface && typeface !== p.cssFamily) out[p.cssFamily] = `the ${name} profile's metric-matched stand-in for ${typeface}`;
  }
  return out;
}

const bareFamily = (name) => String(name == null ? '' : name).trim().replace(/^["']|["']$/g, '');

/** A family name as agent-facing text: quoted, followed by what it is when it is a measurement stand-in. */
export function agentFamily(name, labels = {}) {
  const n = bareFamily(name);
  return labels[n] ? `"${n}" (${labels[n]})` : `"${n}"`;
}

/** The families of a computed font-family list, unquoted ('Arial, "PoC Malgun Substitute", sans-serif' -> 3). */
export function familyList(list) {
  const out = [];
  let cur = '';
  let q = null;
  for (const ch of String(list == null ? '' : list)) {
    if (q) {
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map(bareFamily).filter(Boolean);
}
