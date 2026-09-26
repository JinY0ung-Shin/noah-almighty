// Static contract of the bundled `pptx` skill's CONTENT (SKILL.md, reference/, examples/): the prose pins the
// converter workflow and the describe_system markers rely on, the ${CLAUDE_SKILL_DIR} confinement (the CLI
// substitutes it only in the SKILL.md body), the language split, and a static lint of the example slides.
// The converter itself (converter/, scripts/deck.sh) is covered by tests/deck-converter.test.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
    const baseCss = fs.readFileSync(path.join(SKILL, "converter", "theme", "base.css"), "utf8");
    for (const cls of [".pill--down-on-dark", ".data-table--text", ".pill--up-on-dark"]) {
      expect(baseCss, cls).toContain(cls);
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
          expect(links.map((l) => /href="([^"]+)"/.exec(l)?.[1]).slice(0, 2)).toEqual([
            "../theme/base.css",
            "../theme/fonts.css",
          ]);
          if (html.includes('href="../deck.css"')) {
            expect(fs.existsSync(path.join(deckDir, "deck.css"))).toBe(true);
          }

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
            ].filter(Boolean);
            for (const c of colours) expect(c, name).toMatch(/^[0-9A-F]{6}$/);
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
