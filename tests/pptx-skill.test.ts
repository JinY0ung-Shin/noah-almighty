// Static contract of the bundled `pptx` skill's CONTENT (SKILL.md, reference/, examples/): the prose pins the
// converter workflow and the describe_system markers rely on, the ${CLAUDE_SKILL_DIR} confinement (the CLI
// substitutes it only in the SKILL.md body), the language split, and a static lint of the example slides.
// The converter itself (converter/, scripts/deck.sh) is covered by tests/deck-converter.test.ts.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { listSkillsInRoots } from "../src/server/plugins.js";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_SKILLS = path.join(REPO, "default-skills");
const SKILL = path.join(DEFAULT_SKILLS, "skills", "pptx");
const read = (rel: string) => fs.readFileSync(path.join(SKILL, rel), "utf8");
// Prose pins: collapse whitespace so a re-wrapped line never breaks a phrase.
const prose = (text: string) => text.replace(/\s+/g, " ");

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error("SKILL.md has no leading frontmatter block");
  return { frontmatter: match[1], body: match[2] };
}

function filesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(path.relative(SKILL, abs));
    }
  };
  walk(path.join(SKILL, rel));
  return out.sort();
}

const hangul = (s: string) => (s.match(/[가-힣]/g) ?? []).length;
const latin = (s: string) => (s.match(/[A-Za-z]/g) ?? []).length;
const hangulShare = (s: string) => hangul(s) / Math.max(1, hangul(s) + latin(s));

// The custom properties a stylesheet declares in its `:root` blocks (comments stripped), in declaration order.
function cssTokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out.set(m[1], m[2].trim());
  }
  return out;
}
const BASE_CSS = fs.readFileSync(path.join(SKILL, "converter", "theme", "base.css"), "utf8");
const BASE_TOKENS = cssTokens(BASE_CSS);
const THEMES = ["classic", "editorial", "forest", "midnight", "mono", "violet"];

const skillMd = read("SKILL.md");
const { frontmatter, body } = splitFrontmatter(skillMd);
const description = /^description:\s*(.*)$/m.exec(frontmatter)?.[1] ?? "";

describe("pptx SKILL.md frontmatter", () => {
  it("is named pptx and describes the skill in English with the Korean trigger words", () => {
    expect(frontmatter).toMatch(/^name: pptx$/m);
    expect(description).toContain("발표자료");
    expect(description).toContain("슬라이드");
    expect(description).toContain("mcp__file_output__share_file");
    // mostly ASCII English: the Korean trigger words and the font name only
    expect(hangulShare(description)).toBeLessThan(0.08);
  });

  it("keeps the description a single YAML-safe plain scalar", () => {
    // one line (the app's frontmatter scanner reads one line), and nothing a YAML parser would read as structure
    expect(frontmatter.split(/\r?\n/).filter((l) => l.startsWith("description:"))).toHaveLength(1);
    expect(description).not.toMatch(/: |\s#/);
    expect(description).not.toMatch(/^["'>|&*!%@`{[-]/);
  });

  it("is what the app's skill listing reads for the bundled default skills", async () => {
    const skills = await listSkillsInRoots([{ path: DEFAULT_SKILLS, source: "default" }]);
    const pptx = skills.find((s) => s.name === "pptx");
    expect(pptx?.description).toBe(description.trim());
    expect(pptx?.description).toContain("native, editable PowerPoint objects");
  });
});

describe("pptx SKILL.md body", () => {
  const flat = prose(body);

  it("is English (Hangul under 3 % of letters)", () => {
    expect(hangulShare(body)).toBeLessThan(0.03);
  });

  it("pins the converter workflow", () => {
    for (const pin of [
      "mcp__system__describe_system",
      "deck.sh check",
      "deck.sh build",
      "mcp__file_output__share_file",
      "IN PLACE",
      "timeout: 600000",
      "foreground",
      "60 slides",
      "python-pptx",
      "UNAVAILABLE",
      "was moved to the background",
      "run_in_background",
      "hidden: true",
      "mcp__canvas__show",
      "canvasId",
    ]) {
      expect(flat, pin).toContain(pin);
    }
  });

  it("pins what trial runs of the skill got wrong", () => {
    // the exit code is the verdict: a pipe would report grep's
    expect(flat).toContain("never pipe it");
    // partial data: sample figures marked where they appear, titles never resting on them
    expect(flat).toContain("When they give only SOME of the figures the deck needs");
    expect(flat).toContain("never a title that rests on a sample figure");
    // a requested slide count includes the cover
    expect(flat).toContain("A requested slide count includes the cover");
    // after a build-only edit the current renders are the build's own
    expect(flat).toContain("`<deck>/.build/<profile>/html/`");
    // a toolchain failure while the converter is reported installed is retried and reported, never "unavailable"
    expect(flat).toContain("never as \"PPT generation is unavailable\"");
  });

  it("quotes the describe_system markers and tails verbatim (I12, Appendix A.2)", () => {
    for (const marker of [
      "`converter: INSTALLED`",
      "`converter: NOT INSTALLED`",
      "`toolchain available`",
      "`UNAVAILABLE`",
      "`read-only`",
      "``administrator disabled the `pptx` skill``",
      "`preview/download need an interactive chat turn`",
    ]) {
      expect(flat, marker).toContain(marker);
    }
    // the positive marker is never a substring of the negative one, so a plain `contains` check is safe
    expect("converter: NOT INSTALLED".includes("converter: INSTALLED")).toBe(false);
  });

  it("covers every deck.sh exit code and only uses flags the CLI defines (I2)", () => {
    for (const code of ["0", "1", "2", "3", "4", "5", "6"]) {
      expect(body, `exit ${code}`).toMatch(new RegExp(`^\\| ${code} \\|`, "m"));
    }
    const known = new Set([
      "profile", "only", "json", "out", "author", "strict", "keep", "fail-on-drift", "record", "update-golden", "help",
    ]);
    const flags = [...body.matchAll(/(?<![\w(-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.filter((f) => !known.has(f))).toEqual([]);
  });

  it("names the base directory once and never uses a placeholder or a host path", () => {
    expect(body).toContain(
      "Paths in `reference/` and `examples/` are relative to this skill's base directory, `${CLAUDE_SKILL_DIR}`",
    );
    expect(skillMd).not.toContain("<skill-dir>");
    expect(skillMd).not.toContain("/home/");
  });

  it("makes the theme a planned choice, not a default (themes/, SKILL.md §3)", () => {
    expect(flat).toContain("Pick the deck's theme with the plan (§3)");
    expect(flat).toContain("never the default by habit");
    expect(flat).toContain("cp ${CLAUDE_SKILL_DIR}/themes/<theme>.css ./q3-review/deck.css");
    expect(flat).toContain("`classic` is for formal business reporting, not a fallback");
    expect(flat).toContain("Never reconstruct a company's brand colours from memory");
    expect(flat).toContain("the theme you chose and one or two others that would suit this deck");
    expect(flat).toContain("To switch the theme, copy another theme over `deck.css` and rebuild");
    // one table row per shipped theme, whose "fits" cell is the theme file's own Fits: line (one source of truth for
    // the choice: an agent reading either sees the same scope)
    for (const theme of THEMES) {
      const row = new RegExp(`^\\| \`${theme}\` \\| [^|]+ \\| ([^|]+) \\|$`, "m").exec(body);
      expect(row, theme).not.toBeNull();
      const fits = /^ \* Fits: (.*)\.$/m.exec(read(`themes/${theme}.css`))?.[1];
      expect(row?.[1], theme).toBe(fits);
    }
  });

  it("points every ${CLAUDE_SKILL_DIR} path at a file or directory of the skill", () => {
    const refs = [...body.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([A-Za-z0-9._\-/]+)/g)].map((m) =>
      m[1].replace(/[./]+$/, ""),
    );
    expect(refs.length).toBeGreaterThan(5);
    // scripts/deck.sh and converter/ are Lane A's files: this passes once the converter port is merged
    const missing = [...new Set(refs)].filter((rel) => !fs.existsSync(path.join(SKILL, rel)));
    expect(missing).toEqual([]);
  });
});

describe("pptx reference/ and examples/", () => {
  const referenceFiles = filesUnder("reference");
  const exampleFiles = filesUnder("examples");

  it("ships the three references", () => {
    expect(referenceFiles).toEqual(["reference/AUTHORING.md", "reference/EDITING.md", "reference/python-pptx.md"]);
  });

  it("never uses ${CLAUDE_SKILL_DIR}, a placeholder or a host path (the CLI substitutes only in SKILL.md)", () => {
    for (const rel of [...referenceFiles, ...exampleFiles]) {
      const text = read(rel);
      expect(text, rel).not.toContain("${CLAUDE_SKILL_DIR}");
      expect(text, rel).not.toContain("CLAUDE_SKILL_DIR");
      expect(text, rel).not.toContain("<skill-dir>");
      expect(text, rel).not.toContain("/home/");
    }
  });

  it("AUTHORING documents deck.sh check, every Noah lint rule and the limits (I7, D21)", () => {
    const authoring = prose(read("reference/AUTHORING.md"));
    expect(authoring).toContain("deck.sh check");
    for (const rule of [
      "script", "stylesheet", "base-url", "navigation", "remote-url", "csp-violation", "dom-size", "asset-too-large",
      "image-too-large", "slide-name", "slide-count", "slide-too-large", "deck-too-large", "blocked-request", "missing-glyph",
      // the check's own layout and structure rules (tools/lib/pipeline.mjs layoutLintOf, inpage 20-text/50-paint)
      "mixed-content", "title-wrap", "text-overlap", "soft-wrap", "chart-contrast", "font-weight",
    ]) {
      expect(authoring, rule).toContain(`\`${rule}\``);
    }
    // the kit components the rules point at exist in base.css
    for (const cls of [".pill--down-on-dark", ".data-table--text", ".pill--up-on-dark", ".card--emphasis"]) {
      expect(BASE_CSS, cls).toContain(cls);
      expect(authoring, cls).toContain(cls.slice(1));
    }
    for (const limit of ["60", "540 s", "150 s", "2 MB", "2,500", "20 MB", "100 MB", "30 MB", "512 MB", "2560 px"]) {
      expect(authoring, limit).toContain(limit);
    }
    for (const heading of ["## 2. Lint rules", "## 10. Self-check", "## 11. Previews in Noah", "## 13. Deck folder",
      "## 14. Limits", "## 15. Choosing a font profile"]) {
      expect(authoring, heading).toContain(heading);
    }
    // the kit's allowed links and the notes container
    for (const pin of ["../theme/base.css", "../theme/fonts.css", "../deck.css", "../lib/chart.js", "../assets/",
      '<template id="notes">', 'id="footer"']) {
      expect(authoring, pin).toContain(pin);
    }
  });

  it("AUTHORING carries no PoC-only paths or review history", () => {
    const authoring = read("reference/AUTHORING.md");
    for (const residue of ["poc.local", "scratch/", "run_all.sh", "render.mjs", "validate_all", "--overlay",
      "fixer round", "J1-", "J2-", "EDIT-", "VO-0", "VR-0", "CONTRACT.md", "research/"]) {
      expect(authoring, residue).not.toContain(residue);
    }
    // "judge" as a verb is fine; the review history ("judge J2-20", "(judge") is not
    expect(authoring).not.toMatch(/\bjudge J\d|\(judge\b/i);
  });

  it("EDITING and python-pptx cover what users and the legacy path need", () => {
    const editing = prose(read("reference/EDITING.md"));
    for (const pin of ["2411", "Shrink text on overflow", "합계", "Reset", "Slide Master", "본문", "Replace Fonts",
      "Design > Fonts", "Teams", "Embed fonts in the file"]) {
      expect(editing, pin).toContain(pin);
    }
    const legacy = prose(read("reference/python-pptx.md"));
    for (const pin of ["converter: NOT INSTALLED", "NanumGothic", "scripts/render_deck.sh", "mcp__file_output__share_file",
      ".potx", "replace_data"]) {
      expect(legacy, pin).toContain(pin);
    }
    expect(fs.existsSync(path.join(SKILL, "scripts", "render_deck.sh"))).toBe(true);
  });

  it("examples/README.md describes every example slide", () => {
    const readme = read("examples/README.md");
    for (const rel of exampleFiles.filter((f) => f.endsWith(".html"))) {
      expect(readme, rel).toContain(path.basename(rel));
    }
  });

  it("every example slide path named in README, AUTHORING or EDITING exists", () => {
    const named = new Set<string>();
    for (const [rel, prefix] of [
      ["examples/README.md", "examples/"],
      ["reference/AUTHORING.md", ""],
      ["reference/EDITING.md", ""],
    ] as const) {
      for (const m of read(rel).matchAll(/`((?:examples\/)?[a-z-]+\/slides\/\d{2}-[a-z0-9-]+\.html)`/g)) {
        named.add(m[1].startsWith("examples/") ? m[1] : prefix + m[1]);
      }
    }
    expect(named.size).toBeGreaterThan(8);
    const missing = [...named].filter((rel) => !fs.existsSync(path.join(SKILL, rel)));
    expect(missing).toEqual([]);
  });
});

describe("pptx themes (themes/*.css: complete token sets for <deck>/deck.css)", () => {
  const themeCss = (name: string) => read(`themes/${name}.css`);
  const resolve = (vars: Map<string, string>, v: string, depth = 0): string => {
    if (depth > 20) throw new Error(`var() loop at ${v}`);
    return v.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/gi, (_, n: string) => {
      const next = vars.get(n);
      if (next === undefined) throw new Error(`undefined ${n}`);
      return resolve(vars, next, depth + 1);
    });
  };
  const themeVars = (name: string) => new Map([...BASE_TOKENS, ...cssTokens(themeCss(name))]);

  it("ships the six themes", () => {
    expect(filesUnder("themes")).toEqual(THEMES.map((t) => `themes/${t}.css`));
  });

  for (const name of THEMES) {
    it(`${name}: one :root block of token declarations, only tokens base.css defines, nothing remote`, () => {
      const css = themeCss(name).replace(/\/\*[\s\S]*?\*\//g, "").trim();
      expect(css).toMatch(/^:root\s*\{[^{}]*\}$/);
      for (const line of css.slice(css.indexOf("{") + 1, css.lastIndexOf("}")).split(";")) {
        if (line.trim()) expect(line.trim(), name).toMatch(/^--[a-z0-9-]+\s*:\s*[^:]+$/);
      }
      expect(css).not.toMatch(/@import|url\(|https?:|\/\//i);
      const unknown = [...cssTokens(css).keys()].filter((k) => !BASE_TOKENS.has(k));
      expect(unknown, name).toEqual([]);
      // every value resolves (no dangling var())
      const vars = themeVars(name);
      for (const k of cssTokens(css).keys()) expect(() => resolve(vars, vars.get(k) ?? ""), `${name} ${k}`).not.toThrow();
    });

    it(`${name}: sets every theme token (the same set as classic; PowerPoint slots optional)`, () => {
      const own = [...cssTokens(themeCss(name)).keys()].filter((k) => !k.startsWith("--pptx-"));
      expect(own).toEqual([...cssTokens(themeCss("classic")).keys()]);
    });
  }

  it("classic IS the base.css defaults, token for token", () => {
    const base = new Map(BASE_TOKENS);
    const classic = themeVars("classic");
    for (const k of cssTokens(themeCss("classic")).keys()) {
      expect(resolve(classic, classic.get(k) ?? "").toUpperCase(), k).toBe(resolve(base, base.get(k) ?? "").toUpperCase());
    }
  });

  // The contrast pairs, data-colour distinctness, semantic PowerPoint slots and hue families live in ONE place: the
  // skill's own scripts/theme-check.mjs, which the agent runs on a custom deck.css (AUTHORING §9). Every shipped theme
  // must pass it without a failure or a warning.
  const themeCheck = import(pathToFileURL(path.join(SKILL, "scripts", "theme-check.mjs")).href);
  for (const name of THEMES) {
    it(`${name}: passes scripts/theme-check.mjs (contrast, distinct data colours, semantic slots, one hue per family)`, async () => {
      const { auditTheme } = await themeCheck;
      const r = auditTheme(BASE_CSS, themeCss(name));
      expect(r.failures, name).toEqual([]);
      expect(r.warnings, name).toEqual([]);
    });
  }

  it("theme-check.mjs flags what it claims to, from the CLI the agent runs", async () => {
    const cli = path.join(SKILL, "scripts", "theme-check.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-theme-check-"));
    try {
      const run = (arg: string) => spawnSync(process.execPath, [cli, arg], { encoding: "utf8" });
      expect(run(path.join(SKILL, "themes", "midnight.css")).status).toBe(0);
      // a deck folder is read as <deck>/deck.css; low-contrast captions fail with the pair named
      fs.writeFileSync(path.join(dir, "deck.css"), themeCss("classic").replace("--c-ink-500: #667085;", "--c-ink-500: #A0A8B8;"));
      const bad = run(dir);
      expect(bad.status).toBe(1);
      expect(bad.stdout).toContain("FAIL text on the page: --c-ink-500 on --c-ink-50");
      // a brand colour pasted into a copy of classic: every blue left behind is a hue warning, not a failure
      fs.writeFileSync(path.join(dir, "deck.css"), themeCss("classic").replace("--c-brand-600: #2A52D9;", "--c-brand-600: #C8102E;"));
      const brand = run(dir);
      expect(brand.status).toBe(0);
      for (const t of ["--c-cover-to", "--c-cover-fcst", "--c-series-fcst", "--c-brand-900"]) expect(brand.stdout).toContain(`WARN hue leftover? ${t} `);
      // non-semantic PowerPoint slots (the dark colour lighter than the light one)
      fs.writeFileSync(path.join(dir, "deck.css"), `${themeCss("classic")}\n:root { --pptx-dk1: #FFFFFF; --pptx-lt1: #111A2E; }`);
      expect(run(dir).stdout).toContain("PowerPoint slots must be semantic");
      expect(run(path.join(dir, "missing.css")).status).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("every token a theme can change is set by classic (so no theme silently inherits a classic value)", () => {
    const themable = [...BASE_TOKENS.keys()].filter(
      (k) => (/^--c-/.test(k) && k !== "--c-white") || /^--(radius|shadow|card)-/.test(k),
    );
    expect([...cssTokens(themeCss("classic")).keys()].sort()).toEqual(themable.sort());
  });

  it("the example charts' tokens resolve to an opaque colour in every theme (the converter's chart-spec rule)", async () => {
    const { resolveToken, parseColour } = await themeCheck;
    const used = new Set<string>();
    for (const rel of filesUnder("examples").filter((f) => f.endsWith(".html"))) {
      for (const m of read(rel).matchAll(/data-chart='([^']*)'/g)) {
        for (const t of m[1].matchAll(/var\((--[a-z0-9-]+)\)/g)) used.add(t[1]);
      }
    }
    expect(used.size).toBeGreaterThan(4);
    for (const name of THEMES) {
      const vars = themeVars(name);
      for (const t of used) expect(parseColour(resolveToken(vars, t))[3], `${name} ${t}`).toBe(1);
    }
  });

  it("AUTHORING §9 and the examples README name the themes", () => {
    const authoring = prose(read("reference/AUTHORING.md"));
    for (const theme of THEMES) expect(authoring, theme).toContain(`\`${theme}\``);
    expect(authoring).toContain("## 9. Design system: tokens and themes");
    expect(authoring).toContain('class="card card--emphasis');
    expect(prose(read("examples/README.md"))).toContain("ship the `classic` theme as their `deck.css`");
    // base.css says the same
    expect(BASE_CSS).toContain(".card--emphasis");
    expect(BASE_CSS).toContain("the defaults below ARE themes/classic.css");
  });
});

describe("pptx example decks (static lint of the slide HTML)", () => {
  const decks = fs
    .readdirSync(path.join(SKILL, "examples"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  it("ships business-review, handbook and layouts", () => {
    expect(decks).toEqual(["business-review", "handbook", "layouts"]);
  });

  for (const deck of decks) {
    describe(deck, () => {
      const deckDir = path.join(SKILL, "examples", deck);
      const slides = fs.readdirSync(path.join(deckDir, "slides")).sort();

      it("uses an ASCII deck folder name and NN-name.html slide files numbered 01…N", () => {
        expect(deck).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
        expect(slides.length).toBeGreaterThan(0);
        slides.forEach((name, i) => {
          expect(name).toMatch(/^\d{2}-[a-z0-9-]+\.html$/);
          expect(Number(name.slice(0, 2))).toBe(i + 1);
        });
      });

      slides.forEach((name, i) => {
        const html = fs.readFileSync(path.join(deckDir, "slides", name), "utf8");
        it(`${name}: skeleton, allowed links and scripts only, no remote or executable content`, () => {
          expect(html).toMatch(/^<!doctype html>/i);
          expect(html).toContain('<html lang="ko">');
          expect(html).toContain('<meta charset="utf-8">');
          expect(html.match(/<main class="slide[ "]/g) ?? []).toHaveLength(1);
          expect(html).toMatch(/<main class="slide[^"]*" data-layout="[^"]+"/);

          const allowedCss = new Set(["../theme/base.css", "../theme/fonts.css", "../deck.css"]);
          const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
          for (const link of links) {
            expect(link, link).toMatch(/^<link rel="stylesheet" href="[^"]+">$/);
            expect(allowedCss.has(/href="([^"]+)"/.exec(link)?.[1] ?? ""), link).toBe(true);
          }
          // the deck's theme is its deck.css: every example slide links it last
          expect(links.map((l) => /href="([^"]+)"/.exec(l)?.[1])).toEqual([
            "../theme/base.css",
            "../theme/fonts.css",
            "../deck.css",
          ]);

          const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
          for (const script of scripts) {
            expect(['<script src="../lib/chart.js">', '<script type="text/x-notes">']).toContain(script);
          }
          const usesChart = html.includes("data-chart=");
          expect(html.includes('<script src="../lib/chart.js"></script>')).toBe(usesChart);

          expect(html).not.toMatch(/\son[a-z]+\s*=/i);
          expect(html).not.toMatch(/javascript:/i);
          expect(html).not.toMatch(/@import/i);
          expect(html).not.toMatch(/<base\b/i);
          expect(html).not.toMatch(/http-equiv/i);
          expect(html).not.toMatch(/\b(?:src|href|srcset)\s*=\s*["'](?:[a-z]+:|\/\/)/i);
          expect(html).not.toMatch(/url\(\s*["']?(?:[a-z]+:|\/\/)/i);
          expect(Buffer.byteLength(html)).toBeLessThan(2 * 1024 * 1024);
        });

        it(`${name}: colours come from the theme tokens (no literal hex; currentColor icons)`, () => {
          // white overlays (rgba(255, 255, 255, a)) on the dark emphasis surfaces are the one literal colour
          expect(html.match(/#[0-9A-Fa-f]{3,8}\b/g) ?? []).toEqual([]);
          const rgba = [...html.matchAll(/rgba?\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, ""));
          for (const args of rgba) expect(args, name).toMatch(/^255,255,255,0?\.\d+$/);
          for (const m of html.matchAll(/<svg\b[^>]*>/g)) {
            expect(m[0], name).toContain('stroke="currentColor"');
            expect(m[0], name).toContain('fill="none"');
          }
          for (const m of html.matchAll(/var\((--[a-z0-9-]+)\)/g)) expect(BASE_TOKENS.has(m[1]), `${name}: ${m[1]}`).toBe(true);
          // no other way to write a colour either: named colours, hsl()/hwb()/lab()/oklch()/color() in any colour-bearing
          // declaration (slide <style>, inline style=""); keywords that carry no colour are fine
          const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>|style="([^"]*)"/g)].map((m) => m[1] ?? m[2]).join(";");
          const colourProps = /^(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|box-shadow|outline(-color)?|fill|stroke)$/;
          for (const decl of css.replace(/\/\*[\s\S]*?\*\//g, "").split(/[;{}]/)) {
            const m = /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/.exec(decl);
            if (!m || !colourProps.test(m[1])) continue;
            const rest = m[2].replace(/var\(--[a-z0-9-]+\)|rgba\(255, 255, 255, 0?\.\d+\)|linear-gradient|\d+(\.\d+)?(px|deg|%)?/g, "");
            expect(rest, `${name}: ${m[1]}: ${m[2]}`).not.toMatch(/\b(?!(solid|none|transparent|currentColor|inherit|dashed|dotted)\b)[a-z]{3,}\b|\b(hsla?|hwb|lab|lch|oklab|oklch|color)\(/i);
          }
        });

        it(`${name}: page number = slide position, stable footer id, marked sample data`, () => {
          const fields = [...html.matchAll(/data-field="slidenum">([^<]*)</g)].map((m) => m[1]);
          for (const value of fields) expect(value).toBe(String(i + 1));
          if (html.includes('class="slide-footer"')) {
            expect(html).toContain('<footer class="slide-footer" id="footer">');
            expect(fields).toHaveLength(1);
          }
          expect(html).toContain("샘플 데이터");
        });
      });

      it("ships the classic theme as its deck.css", () => {
        expect(fs.readFileSync(path.join(deckDir, "deck.css"), "utf8")).toBe(read("themes/classic.css"));
      });

      it("repeats one identical footer on every content slide (the builder lifts it into the layout)", () => {
        const footers = slides
          .map((name) => fs.readFileSync(path.join(deckDir, "slides", name), "utf8"))
          .map((html) => /<footer class="slide-footer" id="footer">[\s\S]*?<\/footer>/.exec(html)?.[0])
          .filter((f): f is string => Boolean(f))
          .map((f) => f.replace(/data-field="slidenum">\d+</, 'data-field="slidenum">N<'));
        expect(footers.length).toBeGreaterThan(1);
        expect(new Set(footers).size).toBe(1);
      });

      it("writes chart specs the converter accepts (AUTHORING §8.10)", () => {
        for (const name of slides) {
          const html = fs.readFileSync(path.join(deckDir, "slides", name), "utf8");
          for (const m of html.matchAll(/data-chart='([^']*)'/g)) {
            const spec = JSON.parse(m[1]);
            expect(["column", "bar", "line", "pie", "doughnut"], name).toContain(spec.type);
            expect(Array.isArray(spec.categories) && spec.series.length > 0, name).toBe(true);
            for (const series of spec.series) expect(series.values.length, name).toBe(spec.categories.length);
            const colours = [
              ...spec.series.map((x: { color?: string }) => x.color),
              ...Object.values((spec.pointColors ?? {}) as Record<string, string[]>).flat(),
              spec.dataLabels?.color,
              spec.valueAxis?.gridlines?.color,
              spec.categoryAxis?.labelColor,
              spec.categoryAxis?.lineColor,
              spec.legend?.color,
            ].filter(Boolean);
            // theme tokens (the converter resolves them), so a theme recolours the chart
            for (const c of colours) {
              expect(c, name).toMatch(/^var\(--c-[a-z0-9-]+\)$/);
              expect(BASE_TOKENS.has(/--c-[a-z0-9-]+/.exec(c)?.[0] ?? ""), `${name}: ${c}`).toBe(true);
            }
            const pos = spec.dataLabels?.position;
            if (spec.type === "doughnut") expect(pos, name).toBeUndefined();
            if (spec.grouping === "stacked") expect(pos, name).not.toBe("outEnd");
            if (spec.type !== "pie" && spec.type !== "doughnut") {
              expect(typeof spec.valueAxis?.min, name).toBe("number");
              expect(typeof spec.valueAxis?.max, name).toBe("number");
            }
          }
        }
      });

      it("keeps speaker notes outside <main> when a slide has them", () => {
        for (const name of slides) {
          const html = fs.readFileSync(path.join(deckDir, "slides", name), "utf8");
          const at = html.indexOf('<template id="notes">');
          if (at >= 0) expect(at).toBeGreaterThan(html.indexOf("</main>"));
        }
      });
    });
  }

  it("the layouts deck demonstrates speaker notes", () => {
    const html = read("examples/layouts/slides/05-comparison.html");
    expect(html).toContain('<template id="notes">');
  });
});
