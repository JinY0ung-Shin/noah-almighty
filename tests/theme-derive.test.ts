// The pptx skill's brand-colour derive (scripts/theme-check.mjs --derive / --from-pptx): a complete deck.css in the
// brand's colours that passes the skill's own theme audit. Covers the derived palette (a sweep of brands over both
// bases at 0 failures and 0 warnings, where each colour goes, the exact colour kept over hue-matched data series, a
// tip for the other base only when it holds), the file's structure, the CLI contract the SKILL relies on (exit codes,
// nothing on stdout unless it succeeds, colours with or without '#'), reading a template's theme colours out of a
// .pptx (trailing bytes after its zip directory included), the reader's linear time on hostile XML and its part caps,
// and the zip reader's refusals. The audit itself is pinned in tests/pptx-skill.test.ts.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SKILL = path.join(REPO, "default-skills", "skills", "pptx");
const CLI = path.join(SKILL, "scripts", "theme-check.mjs");
const BASE_CSS = fs.readFileSync(path.join(SKILL, "converter", "theme", "base.css"), "utf8");
const themeCss = (name: string) => fs.readFileSync(path.join(SKILL, "themes", `${name}.css`), "utf8");
// Committed converter output built with classic: its theme's accent1/accent2 are classic's brand-600/accent-500.
// READ-ONLY — deck-contract.test.ts binds its sha256.
const MINI_PPTX = path.join(REPO, "tests", "fixtures", "deck-preview", "mini", "mini.pptx");
const tc = import(pathToFileURL(CLI).href);

type Colour = [number, number, number, number];
type Derived = { css: string; audit: { failures: string[]; warnings: string[] }; notes: string[]; rounds: number };

const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

/** HSL hue (degrees) and saturation of #RRGGBB, as the audit measures them. */
function hueSat(hex: string): { h: number; s: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  if (d === 0) return { h: 0, s: 0 };
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: d / (1 - Math.abs(2 * l - 1)) };
}
const hueGap = (a: string, b: string) => {
  const d = Math.abs(hueSat(a).h - hueSat(b).h);
  return Math.min(d, 360 - d);
};
/** CIE L* of #RRGGBB. */
function lstar(hex: string): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

// A derived theme's resolved values (the base.css defaults overlaid with the file, as the audit reads it).
async function valuesOf(css: string) {
  const { cssTokens, resolveToken } = await tc;
  const vars = new Map<string, string>([...cssTokens(BASE_CSS), ...cssTokens(css)]);
  return (t: string): string => String(resolveToken(vars, t)).toUpperCase();
}

// ---- a minimal zip writer for synthetic templates (its own CRC, independent of the reader under test) ----
const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
type ZipEntry = {
  name: string;
  data: string | Buffer;
  stored?: boolean; // method 0 (default: deflate)
  descriptor?: boolean; // general-purpose bit 3: sizes and CRC after the data, zeros in the local header
  flags?: number; // extra general-purpose bits (bit 0 = encrypted)
  usize?: number; // a declared uncompressed size other than the real one (both headers)
  csize?: number; // a declared compressed size other than the real one (central directory only)
};
function makeZip(entries: ZipEntry[], { count }: { count?: number } = {}): Buffer {
  const out: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const body = e.stored ? data : zlib.deflateRawSync(data);
    const flags = (e.flags ?? 0) | (e.descriptor ? 8 : 0), method = e.stored ? 0 : 8, crc = crc32(data);
    const usize = e.usize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!e.descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(usize, 22);
    }
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(e.descriptor ? 16 : 0);
    if (e.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(body.length, 8);
      descriptor.writeUInt32LE(usize, 12);
    }
    out.push(local, name, body, descriptor);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(flags, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(e.csize ?? body.length, 20);
    head.writeUInt32LE(usize, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + body.length + descriptor.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count ?? entries.length, 8);
  end.writeUInt16LE(count ?? entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...out, cd, end]);
}

// ---- synthetic PowerPoint templates ----
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (list: [string, string, string][]) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  list.map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`).join("") +
  "</Relationships>";
const srgb = (hex: string) => `<a:srgbClr val="${hex}"/>`;
const OFFICE_SLOTS: Record<string, string> = {
  dk1: '<a:sysClr val="windowText" lastClr="000000"/>', lt1: '<a:sysClr val="window" lastClr="FFFFFF"/>',
  dk2: srgb("44546A"), lt2: srgb("E7E6E6"), accent1: srgb("4472C4"), accent2: srgb("ED7D31"), accent3: srgb("A5A5A5"),
  accent4: srgb("FFC000"), accent5: srgb("5B9BD5"), accent6: srgb("70AD47"), hlink: srgb("0563C1"), folHlink: srgb("954F72"),
};
const themeXml = (slots: Record<string, string>) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Brand"><a:themeElements>' +
  `<a:clrScheme name="Brand">${Object.entries({ ...OFFICE_SLOTS, ...slots }).map(([k, v]) => `<a:${k}>${v}</a:${k}>`).join("")}</a:clrScheme>` +
  "</a:themeElements></a:theme>";
/**
 * A template whose FIRST slide master (by presentation.xml's sldMasterIdLst, although its relationship is listed
 * second) uses ppt/theme/theme7.xml; ppt/theme/theme1.xml is a decoy with a red accent1 that only a reader
 * ignoring the relationships would pick up.
 */
function template(slots: Record<string, string>, opts: { descriptor?: boolean; noRels?: boolean } = {}): Buffer {
  const parts: ZipEntry[] = [
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "ppt/presentation.xml", data: `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId3"/><p:sldMasterId id="2147483660" r:id="rId2"/></p:sldMasterIdLst></p:presentation>` },
    { name: "ppt/theme/theme1.xml", data: themeXml({ accent1: srgb("FF0000"), accent2: srgb("00FF00") }) },
    { name: "ppt/theme/theme7.xml", data: themeXml(slots), descriptor: opts.descriptor },
  ];
  if (!opts.noRels) {
    parts.push(
      { name: "_rels/.rels", data: rels([["rId1", "officeDocument", "ppt/presentation.xml"]]) },
      { name: "ppt/_rels/presentation.xml.rels", data: rels([["rId1", "theme", "theme/theme1.xml"],
        ["rId2", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId3", "slideMaster", "slideMasters/slideMaster2.xml"]]) },
      { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: rels([["rId1", "theme", "../theme/theme1.xml"]]) },
      { name: "ppt/slideMasters/_rels/slideMaster2.xml.rels", data: rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ["rId2", "theme", "../theme/theme7.xml"]]) },
    );
  }
  return makeZip(parts);
}

let tmp = "";
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "noah-theme-derive-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
const writeTmp = (name: string, data: Buffer | string) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, data);
  return file;
};
/** A copy of the skill (the script, base.css and both bases) with classic.css edited; returns its theme-check.mjs. */
function skillCopy(editClassic: (css: string) => string): string {
  const skill = fs.mkdtempSync(path.join(tmp, "skill-"));
  for (const dir of ["scripts", "themes", path.join("converter", "theme")]) fs.mkdirSync(path.join(skill, dir), { recursive: true });
  fs.copyFileSync(CLI, path.join(skill, "scripts", "theme-check.mjs"));
  fs.writeFileSync(path.join(skill, "converter", "theme", "base.css"), BASE_CSS);
  fs.writeFileSync(path.join(skill, "themes", "classic.css"), editClassic(themeCss("classic")));
  fs.writeFileSync(path.join(skill, "themes", "midnight.css"), themeCss("midnight"));
  return path.join(skill, "scripts", "theme-check.mjs");
}

describe("theme-check.mjs --derive: the derived palette", () => {
  const SWEEP: Record<string, string> = {
    blue: "#1E6FD9", red: "#D0021B", green: "#2E8B57", orange: "#FF7A00", purple: "#7B2CBF", teal: "#008C8C",
    cyan: "#00B7EB", yellow: "#FFD400", brown: "#8B5A2B", pink: "#FF69B4", navy: "#001F5B", lime: "#A4C639",
    gold: "#C9A227", "very dark": "#0B1020", "very light": "#E8F1FF", "pure red": "#FF0000", "pure green": "#00FF00",
    "pure blue": "#0000FF", "pure yellow": "#FFFF00", "pure cyan": "#00FFFF", "pure magenta": "#FF00FF",
    "dark teal": "#0B3D3D",
    // dark and mid-tone brands whose exact colour needs the stepped data series (curr = brand-600 collides with strong)
    burgundy: "#3F0722", coffee: "#2E1400", "dark green": "#01231F", "mid blue": "#206EB1", "corporate blue": "#3075C4",
    // a dull brand next to the grey prior-period colour: its hue cannot keep the data series apart
    "dull teal": "#4B7981",
    // achromatic anchors (saturation < 0.2)
    "near grey": "#6B7280", slate: "#5A6A85", grey: "#808080", black: "#000000", white: "#FFFFFF",
  };
  const chromatic = (hex: string) => hueSat(hex).s >= 0.2;

  for (const base of ["classic", "midnight"]) {
    it(`${base}: every sweep brand passes the audit with no failure and no warning`, async () => {
      const { deriveTheme, auditTheme } = await tc;
      for (const [name, hex] of Object.entries(SWEEP)) {
        const d: Derived = deriveTheme(hex, { base });
        expect(d.audit.failures, `${base} ${name} ${hex}`).toEqual([]);
        expect(d.audit.warnings, `${base} ${name} ${hex}`).toEqual([]);
        // the audit of the emitted TEXT, as the agent's own check reads it
        expect(auditTheme(BASE_CSS, d.css), `${base} ${name}`).toEqual(d.audit);
      }
    });

    it(`${base}: without --accent the brand and the accent stay at least 45° apart`, async () => {
      const { deriveTheme } = await tc;
      // (+ two brands whose painted brand-600 once landed ~0.5° inside 45° after 8-bit rounding)
      const cases = [...Object.entries(SWEEP).filter(([, h]) => chromatic(h)), ["rounding-edge lime", "#ACC231"], ["rounding-edge navy", "#24308D"]];
      for (const [name, hex] of cases) {
        const v = await valuesOf((deriveTheme(hex, { base }) as Derived).css);
        expect(hueGap(v("--c-brand-600"), v("--c-accent-500")), `${base} ${name}`).toBeGreaterThanOrEqual(45);
      }
    });
  }

  it("keeps the brand colour verbatim as brand-600 when it passes, else its hue at the base's brand-600 luminance", async () => {
    const { deriveTheme } = await tc;
    const ok: Derived = deriveTheme("#0055AA");
    expect((await valuesOf(ok.css))("--c-brand-600")).toBe("#0055AA");
    expect(ok.notes[0]).toContain("brand-600 #0055AA: your brand colour, verbatim");
    // too light for text on classic's light page: the same hue, darkened, and the report says why
    const light: Derived = deriveTheme("#FFD400");
    const b600 = (await valuesOf(light.css))("--c-brand-600");
    expect(b600).not.toBe("#FFD400");
    expect(hueGap(b600, "#FFD400")).toBeLessThan(3);
    expect(light.notes[0]).toContain("your #FFD400 in its own hue at classic's brand-600 luminance — as given it fails text on the page");
    expect(light.notes[0]).toContain("--base midnight");
    // the same colour is light enough as text on midnight's dark page
    expect((await valuesOf((deriveTheme("#FFD400", { base: "midnight" }) as Derived).css))("--c-brand-600")).toBe("#FFD400");
  });

  it("keeps the exact colour over hue-matched data series: a dark brand stays verbatim with the series stepped", async () => {
    const { deriveTheme } = await tc;
    // with curr = brand-600 these are too close to the dark strong series for any repair; stepped, they pass as given
    for (const hex of ["#3F0722", "#2E1400"]) {
      const d: Derived = deriveTheme(hex);
      expect(d.audit.failures, hex).toEqual([]);
      expect(d.audit.warnings, hex).toEqual([]);
      expect((await valuesOf(d.css))("--c-brand-600"), hex).toBe(hex);
      expect(d.notes[0], hex).toContain(`brand-600 ${hex}: your brand colour, verbatim`);
      expect(d.notes.join("\n"), hex).toContain("the brand's hue alone does not keep the data series apart: they step in lightness");
    }
  });

  it("suggests the other base only when deriving there keeps the colour verbatim", async () => {
    const { deriveTheme } = await tc;
    // mid-tones neither base keeps: no tip on either (each base used to send the user to the other)
    for (const hex of ["#FF0000", "#3075C4"]) {
      for (const base of ["classic", "midnight"]) {
        const d: Derived = deriveTheme(hex, { base });
        expect((await valuesOf(d.css))("--c-brand-600"), `${base} ${hex}`).not.toBe(hex);
        expect(d.notes[0], `${base} ${hex}`).toContain("— as given it fails ");
        expect(d.notes[0], `${base} ${hex}`).not.toMatch(/stays exact|--base|--accent/);
      }
    }
    // a light colour midnight keeps, and a dark one classic keeps: each tip names the base that does
    const light: Derived = deriveTheme("#FFD400");
    expect(light.notes[0]).toContain("; it stays exact as the brand on --base midnight, or keeps its hue as --accent");
    const dark: Derived = deriveTheme("#0055AA", { base: "midnight" });
    expect((await valuesOf(dark.css))("--c-brand-600")).not.toBe("#0055AA");
    expect(dark.notes[0]).toMatch(/; it stays exact as the brand on --base classic$/);
    expect((await valuesOf((deriveTheme("#0055AA") as Derived).css))("--c-brand-600")).toBe("#0055AA");
  });

  it("names the check that kept a colour passing its own pairs from staying verbatim, and suggests no other base", () => {
    // a copy of the skill whose classic points the PowerPoint dk2/lt2 slots at brand-600 and ink-100: #0064F5 passes
    // every pair named for brand-600 but not ink-100 on it, which no repair can move while brand-600 stays verbatim
    const cli = skillCopy((css) => `${css}:root { --pptx-dk2: var(--c-brand-600); --pptx-lt2: var(--c-ink-100); }\n`);
    const r = spawnSync(process.execPath, [cli, "--derive", "0064F5"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/brand-600 #[0-9A-F]{6}: your #0064F5 in its own hue at classic's brand-600 luminance — with it verbatim, repair still left PowerPoint lt2 on dk2: --pptx-lt2 on --pptx-dk2 = 4\.\d\d:1 \(needs 4\.5:1\)\n/);
    expect(r.stderr).not.toContain("brand-600 #0064F5");
    expect(r.stderr).not.toMatch(/stays exact|some checks still failed/);
  });

  it("re-hues the brand family, leaves neutrals, deltas, surfaces and shapes as the base has them", async () => {
    const { deriveTheme, cssTokens } = await tc;
    for (const base of ["classic", "midnight"]) {
      const own: Map<string, string> = cssTokens(themeCss(base));
      const got: Map<string, string> = cssTokens((deriveTheme("#C8102E", { base }) as Derived).css);
      for (const [t, value] of own) {
        if (/^--(c-ink|c-up|c-down|c-surface|c-on-fill|radius|shadow|card|pptx)-?/.test(t)) expect(got.get(t), `${base} ${t}`).toBe(value);
      }
      const v = await valuesOf(`:root{${[...got].map(([k, x]) => `${k}:${x};`).join("")}}`);
      for (const t of ["--c-brand-950", "--c-brand-900", "--c-brand-700", "--c-brand-100", "--c-brand-50", "--c-cover-to", "--c-series-fcst"]) {
        expect(hueGap(v(t), "#C8102E"), `${base} ${t} ${v(t)}`).toBeLessThan(10);
      }
    }
  });

  it("steps a dull brand's data series in lightness when its hue cannot keep them apart", async () => {
    const { deriveTheme } = await tc;
    for (const base of ["classic", "midnight"]) {
      const d: Derived = deriveTheme("#4B7981", { base });
      expect(d.audit.failures, base).toEqual([]);
      expect(d.notes.join("\n"), base).toContain("the brand's hue alone does not keep the data series apart: they step in lightness");
      // prev stays the base's neutral; the others carry the brand's hue
      const v = await valuesOf(d.css);
      expect(hueSat(v("--c-series-prev")).s, base).toBeLessThan(0.2);
      for (const role of ["curr", "fcst"]) expect(hueGap(v(`--c-series-${role}`), "#4B7981"), `${base} ${role}`).toBeLessThan(6);
    }
  });

  it("gives a grey brand's data series literal lightness steps (classic: mono's L*; midnight: the mirror)", async () => {
    const { deriveTheme } = await tc;
    const steps: Record<string, Record<string, number>> = {
      classic: { strong: 0, curr: 20.6, fcst: 41, prev: 61.3 },
      midnight: { fcst: 46, prev: 67, curr: 88, strong: 67 },
    };
    for (const [base, want] of Object.entries(steps)) {
      const d: Derived = deriveTheme("6B7280", { base });
      expect(d.notes.join("\n")).toContain("a grey brand (saturation 0.09): they step in lightness");
      const v = await valuesOf(d.css);
      for (const [role, L] of Object.entries(want)) {
        expect(d.css, `${base} ${role}`).toMatch(new RegExp(`--c-series-${role}:\\s*#[0-9A-F]{6};`));
        expect(Math.abs(lstar(v(`--c-series-${role}`)) - L), `${base} ${role}`).toBeLessThan(2);
      }
    }
  });

  it("keeps the base accent's own ramp, turns it to the brand's complement when too close, or follows --accent", async () => {
    const { deriveTheme } = await tc;
    // blue brand, amber accent 174° away: classic's accent tokens as they are
    const kept = await valuesOf((deriveTheme("#0055AA") as Derived).css);
    expect(["--c-accent-700", "--c-accent-600", "--c-accent-500", "--c-accent-300", "--c-accent-100"].map(kept))
      .toEqual(["#C2410C", "#EC6A24", "#FF8A3D", "#FFB27D", "#FFEADB"]);
    // an orange brand 5° from classic's amber: the accent turns to the complement
    const orange: Derived = deriveTheme("#FF7A00");
    expect(orange.notes.join("\n")).toContain("classic's accent #FF8A3D is only 5° from the brand, so it turns to the brand's complement");
    const a500 = (await valuesOf(orange.css))("--c-accent-500");
    expect(Math.abs(hueSat(a500).h - ((hueSat("#FF7A00").h + 180) % 360))).toBeLessThan(3);
    // an explicit accent: its hue across the accent family
    const given: Derived = deriveTheme("#0055AA", { accent: "FFB800" });
    const g = await valuesOf(given.css);
    for (const t of ["--c-accent-700", "--c-accent-600", "--c-accent-500", "--c-accent-300", "--c-accent-100"]) {
      expect(hueGap(g(t), "#FFB800"), t).toBeLessThan(4);
    }
    expect(given.notes.join("\n")).toContain("your accent #FFB800 in its own hue at classic's accent luminance");
    // midnight's cover orbit is its accent-coloured decoration: it follows the accent, not the brand
    const { parseColour } = await tc;
    const m = await valuesOf((deriveTheme("#C8102E", { base: "midnight", accent: "#FFB800" }) as Derived).css);
    const orbit: Colour = parseColour(m("--c-cover-orbit"));
    expect(orbit[3]).toBe(0.85);
    expect(hueGap(`#${orbit.slice(0, 3).map((x) => x.toString(16).padStart(2, "0")).join("")}`, "#FFB800")).toBeLessThan(4);
  });

  it("returns the base theme itself for the base's own colours", async () => {
    const { deriveTheme, cssTokens } = await tc;
    // (midnight's own cyan accent is 42° from its blue, so without --accent it would turn to the complement)
    for (const [base, brand, accent] of [["classic", "#2A52D9", "#FF8A3D"], ["classic", "#2A52D9", null], ["midnight", "#7690FF", "22D3EE"]]) {
      const got: Map<string, string> = cssTokens((deriveTheme(brand, { base, accent }) as Derived).css);
      expect([...got], `${base} ${accent}`).toEqual([...cssTokens(themeCss(base as string))]);
    }
  });
});

describe("theme-check.mjs --derive: the deck.css it writes", () => {
  for (const base of ["classic", "midnight"]) {
    it(`${base}: a header, then ONE :root block with classic's tokens in classic's order${base === "midnight" ? " + midnight's PowerPoint slots" : ""}`, async () => {
      const { deriveTheme, cssTokens } = await tc;
      const { css }: Derived = deriveTheme("#0B6E4F", { base });
      expect(css.split("\n")[0]).toBe(`/* deck.css — Derived by theme-check.mjs --derive #0B6E4F --base ${base}.`);
      expect(css).toMatch(/^ \* Fits: .+, in the brand's colours\.$/m);
      const code = css.replace(/\/\*[\s\S]*?\*\//g, "").trim();
      expect(code).toMatch(/^:root\s*\{[^{}]*\}$/);
      const keys = [...(cssTokens(css) as Map<string, string>).keys()];
      const classic = [...(cssTokens(themeCss("classic")) as Map<string, string>).keys()];
      expect(classic).toHaveLength(50);
      expect(keys.filter((k) => !k.startsWith("--pptx-"))).toEqual(classic);
      expect(keys.filter((k) => k.startsWith("--pptx-"))).toEqual(base === "midnight" ? ["--pptx-dk1", "--pptx-lt1", "--pptx-lt2"] : []);
      // colours as #RRGGBB or rgba() only (what the audit and the converter read), never short hex, hsl() or rgb()
      for (const [k, value] of cssTokens(css) as Map<string, string>) {
        expect(value, k).not.toMatch(/#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{8}\b|hsla?\(|rgb\(|oklch/);
        if (/^--c-/.test(k)) expect(value, k).toMatch(/^(#[0-9A-F]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, [\d.]+\)|var\(--c-[a-z0-9-]+\))$/);
      }
    });
  }

  it("a grey brand's header and data series are literals, not references to brand-600/900", async () => {
    const { deriveTheme, cssTokens } = await tc;
    const got: Map<string, string> = cssTokens((deriveTheme("808080") as Derived).css);
    for (const role of ["prev", "curr", "fcst", "strong"]) expect(got.get(`--c-series-${role}`)).toMatch(/^#[0-9A-F]{6}$/);
  });
});

describe("theme-check.mjs --derive: the CLI", () => {
  it("prints the deck.css on stdout and the report on stderr; accepts RRGGBB / RGB with or without #", () => {
    const hashed = run("--derive", "#0055AA");
    expect(hashed.status).toBe(0);
    expect(hashed.stdout.startsWith("/* deck.css — Derived by theme-check.mjs --derive #0055AA --base classic.")).toBe(true);
    expect(hashed.stderr).toContain("theme derive: #0055AA on classic");
    expect(hashed.stderr).toContain("brand-600 #0055AA: your brand colour, verbatim");
    expect(hashed.stderr).toContain("theme check: the derived theme — all 73 checks hold");
    expect(hashed.stderr).not.toContain("/*");
    for (const same of [["--derive", "0055AA"], ["--derive", "05a"], ["--derive=#0055aa"], ["--derive", "0055AA", "--base", "classic"]]) {
      const r = run(...same);
      expect(r.status, same.join(" ")).toBe(0);
      expect(r.stdout, same.join(" ")).toBe(hashed.stdout);
    }
    const dark = run("--derive", "0055AA", "--accent", "#FFB800", "--base", "midnight");
    expect(dark.status).toBe(0);
    expect(dark.stdout.split("\n")[0]).toBe("/* deck.css — Derived by theme-check.mjs --derive #0055AA --accent #FFB800 --base midnight.");
  });

  it("what it prints passes the audit CLI as a deck's deck.css (the SKILL's derive → .new → mv → check flow)", () => {
    const deck = fs.mkdtempSync(path.join(tmp, "deck-"));
    const r = run("--derive", "C8102E", "--base", "midnight");
    expect(r.status).toBe(0);
    fs.writeFileSync(path.join(deck, "deck.css"), r.stdout);
    const check = run(deck);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("all 73 checks hold");
    expect(check.stdout).not.toContain("WARN");
  });

  it("bad input exits 2 with nothing on stdout", () => {
    const missing = path.join(tmp, "missing.pptx");
    for (const args of [
      ["--derive"], // what the shell leaves of an unquoted `--derive #0055AA`
      ["--derive", "--base", "midnight"],
      ["--derive", "blue"],
      ["--derive", "#12345"],
      ["--derive", "0055AA", "--base", "mono"],
      ["--derive", "0055AA", "--accent", "orange"],
      ["--derive", "0055AA", "--derive", "112233"],
      ["--derive", "0055AA", "--from-pptx", MINI_PPTX],
      ["--derive", "0055AA", "--json"],
      ["--accent", "FF8A3D"],
      ["--from-pptx", missing],
    ]) {
      const r = run(...args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).toBe("");
      expect(r.stderr, args.join(" ")).toMatch(/^theme derive: /);
    }
    expect(run("--derive").stderr).toContain("quote a colour written with # (a bare # starts a shell comment): --derive '#0055AA'");
  });

  it("exits 1 with the failing pairs, a Next: hint and nothing on stdout when repair cannot make it pass", () => {
    // a copy of the skill whose classic has captions too light for its page: no brand colour can fix a neutral pair
    const cli = skillCopy((css) => css.replace("--c-ink-500: #667085;", "--c-ink-500: #A0A8B8;"));
    const r = spawnSync(process.execPath, [cli, "--derive", "0055AA"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("theme check: the derived theme — ");
    expect(r.stderr).toContain("FAIL text on the page: --c-ink-500 on --c-ink-50");
    expect(r.stderr).toContain("Next: derive again");
  });

  it("keeps the audit's own CLI as it was", () => {
    expect(run(path.join(SKILL, "themes", "classic.css")).status).toBe(0);
    const usage = run();
    expect(usage.status).toBe(2);
    expect(usage.stderr.split("\n")[0]).toBe("usage: node theme-check.mjs <deck folder | theme .css> [--json]");
    expect(usage.stderr).toContain("--derive <brand colour> [--accent <colour>] [--base classic|midnight]");
  });
});

describe("theme-check.mjs --from-pptx: a template's theme colours", () => {
  it("reads the committed classic deck without changing it, and derives classic back from it", async () => {
    const { readPptxTheme, cssTokens } = await tc;
    const hash = () => crypto.createHash("sha256").update(fs.readFileSync(MINI_PPTX)).digest("hex");
    const before = hash();
    const theme = readPptxTheme(MINI_PPTX);
    expect(theme.part).toBe("ppt/theme/theme1.xml");
    expect(theme.viaMaster).toBe(true);
    expect(theme.slots.accent1).toEqual([0x2a, 0x52, 0xd9, 1]);
    expect(theme.slots.accent2).toEqual([0xff, 0x8a, 0x3d, 1]);
    expect(theme.slots.dk2).toEqual([0x0f, 0x1d, 0x4a, 1]);
    const r = run("--from-pptx", MINI_PPTX);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("theme derive: colours of mini.pptx (its slide master's theme ppt/theme/theme1.xml): brand = accent1 #2A52D9, accent = accent2 #FF8A3D");
    expect(r.stdout.split("\n")[0]).toBe("/* deck.css — Derived by theme-check.mjs --derive #2A52D9 --accent #FF8A3D --base classic.");
    expect(r.stdout).toContain("(those of mini.pptx)");
    // the brand is classic's own blue (within a few degrees — here exactly), so the result is classic itself
    const v = await valuesOf(r.stdout);
    expect(hueGap(v("--c-brand-600"), "#2A52D9")).toBeLessThan(3);
    expect([...(cssTokens(r.stdout) as Map<string, string>)]).toEqual([...cssTokens(themeCss("classic"))]);
    expect(hash()).toBe(before);
  });

  it("follows the relationships to the first slide master's theme, honours sysClr lastClr, and passes over a grey or too-close accent2", async () => {
    const { readPptxTheme, pickPptxColours } = await tc;
    const file = writeTmp("brand.pptx", template({
      accent1: '<a:sysClr val="windowText" lastClr="0B6E4F"/>', accent2: srgb("7F7F7F"), accent3: srgb("2E8B57"), accent4: srgb("C0392B"),
    }));
    const theme = readPptxTheme(file);
    expect(theme.part).toBe("ppt/theme/theme7.xml");
    expect(theme.slots.accent1).toEqual([0x0b, 0x6e, 0x4f, 1]);
    expect(theme.slots.dk1).toEqual([0, 0, 0, 1]);
    const pick = pickPptxColours(theme.slots);
    expect(pick.accent).toEqual([0xc0, 0x39, 0x2b, 1]);
    expect(pick.picks[1]).toBe("accent = accent4 #C0392B (accent2 #7F7F7F is grey; accent3 #2E8B57 is 15° from the brand)");
    const r = run("--from-pptx", file, "--base", "midnight");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("/* deck.css — Derived by theme-check.mjs --derive #0B6E4F --accent #C0392B --base midnight.");
    // --accent overrides the template's pick
    const own = run("--from-pptx", file, "--accent", "FFB800");
    expect(own.status).toBe(0);
    expect(own.stderr).toContain("brand = accent1 #0B6E4F, accent = your --accent");
    expect(own.stdout.split("\n")[0]).toBe("/* deck.css — Derived by theme-check.mjs --derive #0B6E4F --accent #FFB800 --base classic.");
  });

  it("keeps a grey accent1 as a grey brand, and falls back to ppt/theme/theme1.xml without relationships", async () => {
    const { readPptxTheme, pickPptxColours } = await tc;
    const grey = writeTmp("grey.pptx", template({ accent1: srgb("595959"), accent2: srgb("E4002B") }));
    const pick = pickPptxColours(readPptxTheme(grey).slots);
    expect(pick.brand).toEqual([0x59, 0x59, 0x59, 1]);
    expect(pick.picks[0]).toBe("brand = accent1 #595959 (grey: a grey brand)");
    const r = run("--from-pptx", grey);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("a grey brand (saturation 0.00): they step in lightness");
    const bare = readPptxTheme(writeTmp("bare.pptx", template({}, { noRels: true })));
    expect(bare.part).toBe("ppt/theme/theme1.xml");
    expect(bare.viaMaster).toBe(false);
    expect(bare.slots.accent1).toEqual([255, 0, 0, 1]);
  });

  it("accepts an entry whose sizes follow its data in a descriptor (general-purpose bit 3)", async () => {
    const { readPptxTheme } = await tc;
    const theme = readPptxTheme(writeTmp("descriptor.pptx", template({ accent1: srgb("1428A0") }, { descriptor: true })));
    expect(theme.part).toBe("ppt/theme/theme7.xml");
    expect(theme.slots.accent1).toEqual([0x14, 0x28, 0xa0, 1]);
  });

  it("reads a .pptx that a stray byte or a few follow (a download or mail tool's trailing newline)", async () => {
    const { readPptxTheme } = await tc;
    const zip = template({ accent1: srgb("1428A0") });
    const want = readPptxTheme(writeTmp("plain.pptx", zip));
    expect(want.slots.accent1).toEqual([0x14, 0x28, 0xa0, 1]);
    for (const [what, extra] of [["a newline", Buffer.from("\n")], ["16 zero bytes", Buffer.alloc(16)]] as const) {
      const file = writeTmp(`trailing-${what.replace(/\W+/g, "-")}.pptx`, Buffer.concat([zip, extra]));
      expect(readPptxTheme(file), what).toEqual(want);
      const r = run("--from-pptx", file);
      expect(r.status, what).toBe(0);
      expect(r.stdout.split("\n")[0], what).toBe("/* deck.css — Derived by theme-check.mjs --derive #1428A0 --accent #ED7D31 --base classic.");
    }
    // a directory record whose comment would run past the end is no directory, and the file is not called truncated
    const overrun = Buffer.from(zip);
    overrun.writeUInt16LE(50, overrun.length - 2);
    const r = run("--from-pptx", writeTmp("comment-overrun.pptx", overrun));
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("theme derive: not a .pptx (no complete zip directory record near its end)\n");
  });

  it("reads hostile XML in linear time and refuses parts larger than any real one", async () => {
    const { readPptxTheme } = await tc;
    const KiB = 1024;
    // one PowerPoint-shaped template, any of whose parts can be replaced: package rels → presentation → master → theme
    const crafted = (parts: { pkgRels?: string; presentation?: string; theme?: string }) => makeZip([
      { name: "[Content_Types].xml", data: "<Types/>" },
      { name: "_rels/.rels", data: parts.pkgRels ?? rels([["rId1", "officeDocument", "ppt/presentation.xml"]]) },
      { name: "ppt/presentation.xml", data: parts.presentation ?? `<p:presentation xmlns:p="p" xmlns:r="${REL}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst></p:presentation>` },
      { name: "ppt/_rels/presentation.xml.rels", data: rels([["rId1", "slideMaster", "slideMasters/slideMaster1.xml"]]) },
      { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: rels([["rId1", "theme", "../theme/theme1.xml"]]) },
      { name: "ppt/theme/theme1.xml", data: parts.theme ?? themeXml({ accent1: srgb("1428A0") }) },
    ]);
    const fill = (unit: string, bytes: number) => unit.repeat(Math.floor(bytes / unit.length));
    // Each crafted part sits just under its cap (relationships and presentation.xml 1 MiB, the theme 2 MiB), where the
    // backtracking patterns this replaced ran for minutes to hours; the reader is linear, so each takes milliseconds.
    // null: the rest of the template still reads (accent1 = #1428A0); a RegExp: the error it is refused with.
    const cases: [string, Buffer, RegExp | null][] = [
      ["a relationship with a 1 MiB attribute name", crafted({ pkgRels: `<Relationships><Relationship ${fill("a", 1000 * KiB)}></Relationships>` }), null],
      ["relationship openers that never close", crafted({ pkgRels: fill("<Relationship ", 1000 * KiB) }), null],
      ["a relationship whose attribute value never closes", crafted({ pkgRels: `<Relationships><Relationship Target="${fill("x", 1000 * KiB)}` }), null],
      ["a relationship full of names without values", crafted({ pkgRels: `<Relationship ${fill("a = ", 1000 * KiB)}/>` }), null],
      ["sldMasterId openers that never close", crafted({ presentation: fill("<p:sldMasterId ", 1000 * KiB) }), null],
      ["an sldMasterId whose id never closes", crafted({ presentation: `<p:sldMasterId r:id="${fill("x", 1000 * KiB)}` }), null],
      ["clrScheme openers that never close", crafted({ theme: fill("<a:clrScheme>", 2000 * KiB) }), /theme1\.xml has no colour scheme/],
      ["slot openers that never close", crafted({ theme: `<a:clrScheme>${fill("<a:accent1>", 2000 * KiB)}</a:clrScheme>` }), /no accent1 colour/],
      ["colour openers that never close", crafted({ theme: `<a:clrScheme><a:accent1>${fill("<a:srgbClr ", 2000 * KiB)}</a:accent1></a:clrScheme>` }), /no accent1 colour/],
      ["package relationships over 1 MiB", crafted({ pkgRels: fill(" ", 1024 * KiB + 1) }), /_rels\/\.rels is too large to read \(1048577 bytes\)/],
      ["presentation.xml over 1 MiB", crafted({ presentation: fill(" ", 1024 * KiB + 1) }), /ppt\/presentation\.xml is too large to read/],
      ["a theme over 2 MiB", crafted({ theme: themeXml({}) + fill(" ", 2048 * KiB) }), /ppt\/theme\/theme1\.xml is too large to read/],
    ];
    for (const [what, bytes, refused] of cases) {
      const file = writeTmp(`hostile-${what.replace(/\W+/g, "-")}.pptx`, bytes);
      expect(bytes.length, what).toBeLessThan(64 * KiB); // a small file on disk
      // the CLI first, killed if it spins, so a regression fails here instead of hanging the suite
      const r = spawnSync(process.execPath, [CLI, "--from-pptx", file], { encoding: "utf8", timeout: 20_000 });
      expect(r.signal, what).toBeNull();
      expect(r.status, `${what}: ${r.stderr}`).toBe(refused ? 2 : 0);
      if (refused) {
        expect(r.stdout, what).toBe("");
        expect(r.stderr, what).toMatch(refused);
      }
      const t = performance.now();
      let slots: Record<string, Colour | null> | null = null;
      try {
        slots = readPptxTheme(file).slots;
      } catch (e) {
        expect(refused, `${what}: ${(e as Error).message}`).not.toBeNull();
      }
      expect(performance.now() - t, what).toBeLessThan(1000);
      // (a scheme whose accent1 cannot be read is refused by the CLI's pick, not by the reader)
      if (slots) expect(slots.accent1, what).toEqual(refused ? null : [0x14, 0x28, 0xa0, 1]);
    }
  });

  it("refuses truncated, oversized, zip64 and encrypted files with exit 2 and nothing on stdout", () => {
    const good = template({});
    const theme7 = themeXml({ accent1: srgb("1428A0") });
    const zip = (entries: ZipEntry[], opts?: { count?: number }) => makeZip(entries, opts);
    const cases: [string, Buffer, RegExp][] = [
      ["truncated", fs.readFileSync(MINI_PPTX).subarray(0, 9000), /truncated/],
      ["cut inside its directory", good.subarray(0, good.length - 40), /truncated/],
      ["not a zip", Buffer.from("PK but not really a zip file at all"), /not a \.pptx/],
      ["a part declared too large", zip([{ name: "ppt/theme/theme1.xml", data: theme7, usize: 9 * 1024 * 1024 }]), /too large to read/],
      // a zip bomb: 32 MiB of spaces deflated to ~32 KiB, declared as 64 KiB (a plausible size for what it stores)
      ["a part inflating past its size", zip([{ name: "ppt/theme/theme1.xml", data: Buffer.alloc(32 * 1024 * 1024, 32), usize: 64 * 1024 }]), /inflates beyond its declared size/],
      ["a part compressed larger than it could be", zip([{ name: "ppt/theme/theme1.xml", data: crypto.randomBytes(8192), usize: 1024 }]), /sizes are impossible/],
      ["zip64 entry count", zip([{ name: "ppt/theme/theme1.xml", data: theme7 }], { count: 0xffff }), /zip64/],
      ["zip64 entry size", zip([{ name: "ppt/theme/theme1.xml", data: theme7, csize: 0xffffffff }]), /zip64/],
      ["encrypted", zip([{ name: "ppt/theme/theme1.xml", data: theme7, flags: 1 }]), /encrypted/],
      ["no theme", zip([{ name: "ppt/presentation.xml", data: "<p:presentation/>" }]), /has no theme/],
    ];
    for (const [what, bytes, message] of cases) {
      const r = run("--from-pptx", writeTmp(`${what.replace(/\W+/g, "-")}.pptx`, bytes));
      expect(r.status, what).toBe(2);
      expect(r.stdout, what).toBe("");
      expect(r.stderr, what).toMatch(message);
    }
  });
});
