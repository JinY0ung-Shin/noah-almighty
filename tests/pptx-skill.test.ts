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

// The declarations of the rule an example slide's <style> writes for `selector` (the selector starting a line,
// comments stripped), whitespace collapsed; "" when there is none.
function cssRule(rel: string, selector: string): string {
  const style = (/<style>([\s\S]*?)<\/style>/.exec(read(rel))?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return prose(new RegExp(`^[ \\t]*${escaped}[ \\t]*\\{([^}]*)\\}`, "m").exec(style)?.[1] ?? "");
}

// The longest run of characters two lines share, spaces ignored: a restated sentence shares a long one.
function longestSharedRun(a: string, b: string): number {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  const row = new Array<number>(y.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= x.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= y.length; j++) {
      const above = row[j];
      row[j] = x[i - 1] === y[j - 1] ? diagonal + 1 : 0;
      best = Math.max(best, row[j]);
      diagonal = above;
    }
  }
  return best;
}

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
    // plus the flags of scripts/theme-check.mjs, which §3 runs to derive a theme from brand colours (its usage names them)
    const themeCheckFlags = ["derive", "accent", "base", "from-pptx"];
    for (const f of themeCheckFlags) expect(read("scripts/theme-check.mjs"), f).toContain(`--${f} `);
    const flags = [...body.matchAll(/(?<![\w(-])--([a-z][a-z0-9-]*)/g)].map((m) => m[1]);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.filter((f) => !known.has(f) && !themeCheckFlags.includes(f))).toEqual([]);
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
    // brand colours are DERIVED, and a failed derive (nothing on stdout) never truncates the deck's theme
    expect(flat).toContain("> ./q3-review/deck.css.new && mv ./q3-review/deck.css.new ./q3-review/deck.css");
    expect(flat).toContain("quote every colour (a bare `#` starts a shell comment)");
    // a template's colours for a NEW deck; building on the template itself stays the python-pptx path
    expect(flat).toContain("building ON its own masters and layouts is the python-pptx path (§1)");
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

  it("lists each theme's Feel and Avoid lines under the table, verbatim from the theme file", () => {
    for (const theme of THEMES) {
      const css = read(`themes/${theme}.css`);
      // single header lines right after Fits:, each ending in a period
      expect(css, theme).toMatch(/^ \* Fits: [^\n]+\.\n \* Feel: [^\n]+\.\n \* Avoid: [^\n]+\.\n/m);
      const feel = /^ \* Feel: (.*)\.$/m.exec(css)?.[1];
      const avoid = /^ \* Avoid: (.*)\.$/m.exec(css)?.[1];
      // the scoping question's theme options paraphrase these, so the SKILL shows the file's own words
      expect(flat, theme).toContain(`\`${theme}\` — Feel: ${feel}; Avoid: ${avoid}`);
    }
  });

  it("asks at most ONE scoping question, and only where someone can answer it now", () => {
    for (const pin of [
      "ONE `AskUserQuestion` call",
      "At most once per conversation",
      "`테마`",
      "`어떤 느낌으로 만들까요?`",
      "`분량`",
      "`몇 장 정도로 만들까요?`",
      "`용도`",
      "`어디에 쓰실 자료인가요?`",
      "`보고서형 — 읽는 문서`",
      "`발표형 — 화면에 띄워 발표`",
      // the recommended option is marked in the user's language, not with the CLI's English suffix
      "(`(추천)`)",
      "`이 구성으로 진행할까요?`",
      "Decide and build — a finished draft is easier to correct than a list of questions",
    ]) {
      expect(flat, pin).toContain(pin);
    }
    // §2's two older asks (an unclear slide count, the outline check) are folded into that one call
    expect(flat).not.toContain("when interactive and unclear, ask");
    expect(flat).not.toContain("Confirm the outline first");
    // The hook DENIES the dialog in headless runs, but an external-task-API turn PARKS it, so the skill keys
    // that exclusion on the provenance marker the prompt carries for those turns — quoted verbatim, and still there.
    const marker = "This turn was submitted by an **EXTERNAL SYSTEM**";
    expect(flat).toContain(`\`${marker}\``);
    expect(fs.readFileSync(path.join(REPO, "src", "server", "agent", "promptBuilder.ts"), "utf8")).toContain(marker);
  });

  it("reviews in rounds of per-slide notes that always deliver the latest file first", () => {
    const review = prose(body.slice(body.indexOf("## 11. Review with the user"), body.indexOf("## 12.")));
    for (const pin of [
      // the file is delivered every round, never held back for a "done"
      "`deck.sh build` exits 0 → `share_file` the new .pptx IN PLACE (§7)",
      // renders from the build's own folder: .build/check is stale after a build
      "from `<deck>/.build/<profile>/html/`",
      "at most 30 hidden images",
      // the cap binds EVERY round (a theme change on a 31–60-slide deck re-publishes every slide), not only round 1
      "One turn publishes at most 30 hidden images, in every round",
      "publish the `overview-N.png` sheets from `<deck>/.build/<profile>/` instead",
      // every round's file is a NEW card, and a share link keeps opening the card it was made for
      "A share link opens the card it was made for, and each round's file is a new card",
      "say in the round's reply that it still shows the earlier version",
      "only if the user asks, and then suggest revoking the old one",
      // a non-blocking canvas as the turn's last call: its form unlocks only when the turn ends
      "with `wait: false` as the LAST tool call of the turn",
      "`required: false`",
      "`### 3번 슬라이드 – 매출 추이`",
      "`번호: 요청`",
      "`예) 3: 제목을 더 짧게`",
      // round-scoped control ids: the panel keeps the values of a re-used id
      "`r1-s03`, `r1-all`",
      "A message with an older round's ids is a resend of notes already applied",
      "Apply ALL of them, then ONE rebuild",
      "submitting empty, or simply stopping, ends the review",
    ]) {
      expect(review, pin).toContain(pin);
    }
  });

  it("makes speaker notes the talk track, in the SKILL and in AUTHORING", () => {
    expect(flat).toContain("the talk track, what the presenter SAYS");
    expect(flat).toContain("never into a separate .md file");
    // whoever gets the .pptx gets its notes: the delivery message says so
    expect(flat).toContain("each slide's speaker notes hold its talk track and are part of the .pptx");
    // the opener moves on (never restates the previous bridge); ONE timing-cue form, the one every example uses
    expect(flat).toContain("an opener that moves on from the previous slide's bridge (never repeats it)");
    expect(flat).toContain("a timing cue in parentheses at the end of the last line (`(약 1분)`)");
    const authoring = prose(read("reference/AUTHORING.md"));
    expect(authoring).toContain("Speaker notes in `<template id=\"notes\">`: the talk track");
    expect(authoring).toContain("never the slide text pasted");
    expect(authoring).toContain("the template is parsed as HTML, so markup and anything in `<…>` vanish");
    expect(authoring).toContain("an opener that moves on from the previous slide's bridge");
    expect(authoring).toContain("a timing cue in parentheses at the end of the last line (`(약 1분)`");
    expect(authoring).not.toContain("The speaker notes hold the assumptions behind the numbers");
  });

  it("makes a share link only on an explicit ask, through the tool and describe_system line the server really has", () => {
    const deliver = prose(body.slice(body.indexOf("## 7. Deliver"), body.indexOf("## 8.")));
    for (const pin of [
      "only when the user explicitly asks for one (a plain 공유해 줘 about the deck is the `share_file` above)",
      "Call `mcp__file_output__create_share_link` after delivering the deck when describe_system's `Share links` line says this run has it",
      "otherwise point them to the `공유 링크` button next to the file card",
      "whoever opens it can also download the .pptx, speaker notes included",
    ]) {
      expect(deliver, pin).toContain(pin);
    }
    // the names the SKILL relies on are the ones the server exposes (tool name, describe_system line, settings path)
    const agentSrc = (file: string) => fs.readFileSync(path.join(REPO, "src", "server", "agent", file), "utf8");
    expect(agentSrc("fileOutputTools.ts")).toContain('"mcp__file_output__create_share_link"');
    expect(agentSrc("systemTools.ts")).toContain('"- Share links (mcp__file_output__create_share_link): "');
    expect(agentSrc("systemTools.ts")).toContain('"내 아바타 → 권한·연결 → 공유 링크"');
    expect(flat).toContain("내 아바타 → 권한·연결 → 공유 링크");
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
      // photo slots (converter 1.2.0: inpage 45-placeholder.js; placeholder-layout from lib/pipeline.mjs layoutLintOf):
      // report.mjs points each of them at AUTHORING §7
      "placeholder-prompt", "placeholder-content", "placeholder-geometry", "rotated-placeholder", "placeholder-size",
      "placeholder-layout",
      // text over a picture or a photo slot, judged at its worst case (converter 1.3.0; report.mjs points it at §7)
      "text-on-picture",
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
      "Design > Fonts", "Teams", "Embed fonts in the file",
      // a slide alone on its layout (a photo slide) keeps its footer ON the slide: the builder lifts only from ≥ 2
      "The exception is a slide that is the only one on its layout",
      "A layout made from a single slide (a team slide with photo slots) brings no footer or page number",
      // pictures: a swapped photo keeps the scrim that keeps its text legible
      "Change Picture", "Text over a photo sits on a scrim"]) {
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

  it("documents photo slots where the agent and the user meet them, and the examples' slots hold only their hint", () => {
    // converter 1.2.0: data-placeholder="pic" = PowerPoint's EMPTY picture placeholder; every child is an HTML-only hint
    expect(prose(body)).toContain("A photo the user adds later is a photo slot: `data-placeholder=\"pic\"`");
    expect(prose(body)).toContain("everything inside it is an HTML-only hint, so captions go next to it (AUTHORING §7)");
    const authoring = prose(read("reference/AUTHORING.md"));
    expect(authoring).toContain("EVERY child of the slot is an HTML-only hint dropped from the .pptx");
    expect(authoring).toContain("| `data-placeholder=\"pic\"` + `data-prompt=\"…\"` | a sized box — a photo slot (§7) |");
    // slots pair across a layout's slides by DOCUMENT order (converter: IR `slot`, idx = 13 + slot), a layout that mixes
    // photo and non-photo slides is warned about, a sliver of a slot is an error, and the hint pair is audited (§9)
    expect(authoring).toContain("share each slot's prompt by DOCUMENT order — the 1st slot in the markup, the 2nd …");
    expect(authoring).toContain("a layout shared with slides that have no slot would hand every New Slide empty slots too (`placeholder-layout`)");
    expect(authoring).toContain("(each at least 24 px, else `placeholder-size`)");
    expect(authoring).toContain("`--c-ink-600` on the slot's `--c-ink-100` fill");
    expect(authoring).toContain("ink-600 on ink-100 (the photo-slot hint, §7)");
    expect(authoring).toContain("A photo slide alone on its layout keeps its footer and page number on the slide itself");
    // the README's per-person prompts meet the shared-layout rule: a second team slide gets its own layout
    expect(prose(read("examples/README.md"))).toContain("give it its own `data-layout` (e.g. `함께할 사람 2`), or put one generic prompt");
    // the SKILL puts photo slides on their own layout and has a photo-slot warning fixed before delivery
    expect(prose(body)).toContain("(`.photo-slot`), on a slide with its own `data-layout`");
    expect(prose(body)).toContain("a photo-slot warning first — `placeholder-layout`");
    expect(prose(read("reference/EDITING.md"))).toContain("Click the icon to insert a photo");
    for (const cls of [".photo-slot", ".photo-slot-hint"]) expect(BASE_CSS, cls).toContain(`${cls} {`);
    let slots = 0;
    for (const rel of exampleFiles.filter((f) => f.endsWith(".html"))) {
      const html = read(rel);
      for (const m of html.matchAll(/<div\b([^>]*\bdata-placeholder="pic"[^>]*)>([\s\S]*?)<\/div>/g)) {
        slots++;
        const prompt = /\bdata-prompt="([^"]*)"/.exec(m[1])?.[1] ?? "";
        // the placeholder-prompt rule: one line of at most 80 characters
        expect(prompt.trim(), rel).not.toBe("");
        expect(prompt, rel).not.toMatch(/[\r\n]/);
        expect([...prompt].length, rel).toBeLessThanOrEqual(80);
        expect(m[1], rel).toMatch(/\bclass="photo-slot"/);
        // nothing but the hint inside (no nested box, no caption): its only text repeats the prompt
        expect(m[2], rel).not.toMatch(/<div\b|<img\b|<table\b|data-chart=/);
        expect(m[2].replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), rel).toBe(prompt);
      }
    }
    expect(slots).toBeGreaterThan(1);
    // the team slide ties its text to the slot: one 224 px column centred in the card (the role pill ends on the
    // photo's right edge), the note pinned to the bottom — no empty band beside the photo or under the note
    const team = (selector: string) => cssRule("examples/handbook/slides/04-team.html", selector);
    expect(team(".person")).toContain("align-items: center");
    expect(team(".person .photo-slot")).toContain("width: 224px; height: 224px");
    for (const selector of [".person-head", ".person-role", ".person-note"]) expect(team(selector), selector).toContain("width: 224px");
    expect(team(".person-note")).toContain("margin-top: auto");
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
    // §9 Brand colours: the same derive-then-replace pattern as SKILL.md §3
    expect(authoring).toContain("> <deck>/deck.css.new && mv <deck>/deck.css.new <deck>/deck.css");
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

  it("ships business-review, handbook, layouts, talk and visual", () => {
    expect(decks).toEqual(["business-review", "handbook", "layouts", "talk", "visual"]);
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

      it("writes speaker notes as a short plain-text talk track (2–5 flush-left lines, no markup)", () => {
        for (const name of slides) {
          const html = fs.readFileSync(path.join(deckDir, "slides", name), "utf8");
          const notes = /<template id="notes">([\s\S]*?)<\/template>/.exec(html)?.[1];
          if (notes === undefined) continue;
          const lines = notes.split("\n").filter((line) => line.trim());
          expect(lines.length, name).toBeGreaterThanOrEqual(2);
          expect(lines.length, name).toBeLessThanOrEqual(5);
          // leading spaces reach the notes paragraph, and the template is parsed as HTML: a tag would vanish
          for (const line of lines) expect(line, name).toMatch(/^\S/);
          expect(notes, name).not.toMatch(/<[A-Za-z/!?]/);
        }
      });

      it("writes a timing cue only as '(약 N분)' at the end of the last notes line (one form across the examples)", () => {
        for (const name of slides) {
          const html = fs.readFileSync(path.join(deckDir, "slides", name), "utf8");
          const notes = /<template id="notes">([\s\S]*?)<\/template>/.exec(html)?.[1];
          if (notes === undefined) continue;
          const lines = notes.split("\n").filter((line) => line.trim());
          // a parenthesised cue anywhere, or a bare cue on a line of its own (which reads like a line to say aloud)
          const cues = [...notes.matchAll(/\(약 ?\d+ ?(?:분|초)\)|^약 ?\d+ ?(?:분|초)$/gm)];
          expect(cues.length, name).toBeLessThanOrEqual(1);
          if (cues.length) expect(lines[lines.length - 1], name).toMatch(/\S \(약 \d+(?:분|초)\)$/);
        }
      });

      it("opens a slide's notes without restating the bridge the previous slide's notes ended on", () => {
        const notesOf = (name: string) =>
          /<template id="notes">([\s\S]*?)<\/template>/
            .exec(fs.readFileSync(path.join(deckDir, "slides", name), "utf8"))?.[1]
            ?.split("\n")
            .filter((line) => line.trim());
        for (let i = 1; i < slides.length; i++) {
          const before = notesOf(slides[i - 1]);
          const after = notesOf(slides[i]);
          if (!before?.length || !after?.length) continue;
          // a verbatim restatement shares a long run ("첫 3개월 동안 곁에서 도와줄 세 사람을" was 16); sentence endings
          // ("습니다.") share a few characters, which is fine
          expect(longestSharedRun(before[before.length - 1], after[0]), `${slides[i - 1]} → ${slides[i]}`).toBeLessThan(10);
        }
      });
    });
  }

  it("the layouts deck demonstrates speaker notes", () => {
    const html = read("examples/layouts/slides/05-comparison.html");
    expect(html).toContain('<template id="notes">');
  });

  it("the talk deck is 발표형: at most ~40 words on each slide, every slide with a talk track", () => {
    const dir = path.join(SKILL, "examples", "talk", "slides");
    for (const name of fs.readdirSync(dir)) {
      const html = fs.readFileSync(path.join(dir, name), "utf8");
      const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "";
      const words = main
        .replace(/<svg[\s\S]*?<\/svg>/g, " ")
        .replace(/<\/?(?:span|strong|b)\b[^>]*>/g, "") // inline runs do not break a word ("14<span>시간</span>")
        .replace(/<[^>]+>/g, " ")
        .split(/\s+/)
        .filter((w) => w && !["·", "—", "–"].includes(w));
      expect(words.length, name).toBeLessThanOrEqual(40);
      expect(html, name).toContain('<template id="notes">');
    }
  });

  it("the 발표형 sizes SKILL.md §2, AUTHORING §8.25 and the README quote are the ones the talk deck uses", () => {
    expect(prose(body)).toContain("the headline at display size (60/80; an opening statement 84/112, a quote or the closing ask 72/96)");
    expect(prose(body)).toContain("supporting text at lead sizes (22/32 to 28/40)");
    const authoring = prose(read("reference/AUTHORING.md"));
    expect(authoring).toContain("**8.25 Talk slides (발표형)**");
    expect(authoring).toContain("(60/80; the opening statement 84/112, a quote or the closing ask 72/96)");
    expect(prose(read("examples/README.md"))).toContain("(60/80, the statement 84/112, the quote and the closing 72/96)");
    const px = (rel: string, size: number, lh: number) =>
      expect(read(`examples/talk/slides/${rel}`), rel).toContain(`font-size: ${size}px; line-height: ${lh}px`);
    px("01-statement.html", 84, 112);
    px("02-big-number.html", 280, 376);
    px("03-quote.html", 72, 96);
    px("05-versus.html", 120, 160);
    px("06-closing.html", 72, 96);
    // labels 18/28 and supporting text at lead sizes — the opener's meta row and the closing's date rail included
    expect(authoring).toContain("labels at 18/28, a meta row's labels and a rail's dates included");
    expect(prose(body)).toContain("supporting text at lead sizes (22/32 to 28/40) and labels at 18/28");
    const talk = (rel: string, selector: string) => cssRule(`examples/talk/slides/${rel}`, selector);
    expect(talk("01-statement.html", ".meta-label")).toContain("font-size: 18px; line-height: 28px");
    expect(talk("01-statement.html", ".meta-value")).toContain("font-size: var(--fs-lead); line-height: var(--lh-lead)");
    expect(talk("06-closing.html", ".step-date")).toContain("font-size: 18px; line-height: 28px");
    expect(talk("06-closing.html", ".step-name")).toContain("font-size: var(--fs-lead); line-height: var(--lh-lead)");
    // ...and the floor itself, on every talk slide: each font size resolves to ≥ 18 px, except the micro chrome (the
    // sample-data note and the page number, 12/16) — so no supporting text slips under it unnoticed
    const sizePx = (value: string) => {
      const token = /^var\((--fs-[a-z0-9-]+)\)$/.exec(value)?.[1];
      return Number(/^(\d+(?:\.\d+)?)px$/.exec(token ? (BASE_TOKENS.get(token) ?? "") : value)?.[1] ?? Number.NaN);
    };
    let sized = 0;
    for (const name of fs.readdirSync(path.join(SKILL, "examples", "talk", "slides"))) {
      const style = (/<style>([\s\S]*?)<\/style>/.exec(read(`examples/talk/slides/${name}`))?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of style.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const selector = m[1].trim();
        const size = /(?:^|;)\s*font-size:\s*([^;]+?)\s*(?:;|$)/.exec(m[2])?.[1];
        if (!size) continue;
        sized++;
        if (/-(?:note|page)$/.test(selector)) expect(sizePx(size), `${name} ${selector}`).toBe(12);
        else expect(sizePx(size), `${name} ${selector}: ${size}`).toBeGreaterThanOrEqual(18);
      }
    }
    expect(sized).toBeGreaterThan(20);
    // the big number meets the lead's last baseline in BOTH profiles: one flex row aligned on the last baselines
    expect(talk("02-big-number.html", ".bignum")).toContain("display: flex; align-items: last baseline");
    expect(authoring).toContain("one flex row with `align-items: last baseline`");
    // a headline figure keeps its scope on the slide: a reader without the speaker never sees the notes
    expect(authoring).toContain("What a headline figure counts stays on the slide");
    expect(prose(body)).toContain("while a headline figure keeps its scope on the slide");
  });
});

// Decks that SHOW: every slide's visual AND its source are planned before the HTML, and a picture the avatar is shown
// (an attachment, a browser capture, a Confluence diagram) is a FILE it places. Text stays a legitimate visual: the
// user explicitly rejected any check or warning that fires because a slide has no image.
describe("pptx pictures (SKILL §2 visual sources, AUTHORING §7 captures and scrims, examples/visual)", () => {
  const flat = prose(body);
  const authoring = prose(read("reference/AUTHORING.md"));
  const readme = prose(read("examples/README.md"));
  const VISUAL = "examples/visual";
  const visualSlides = fs.readdirSync(path.join(SKILL, VISUAL, "slides")).sort();

  it("plans each slide's visual and its source before any HTML, from the sources the run has", () => {
    for (const pin of [
      "Give every slide its main visual AND its source before you write any HTML",
      "the user's figures: a native chart; a structure (steps, parts, an org): a diagram from the kit's shapes",
      // a draw.io diagram is placed by its PNG preview: the mxfile source is no image (`image-load`)
      "A draw.io diagram goes in as its PNG preview",
      "never the `.drawio` source: that is an mxfile, not an image, and an `<img>` of it fails `image-load`",
      // copy by the ABSOLUTE path (a deck in a repository clone is not in the scratch workspace); earlier turns' images
      "Copy the chosen file by the ABSOLUTE path its listing or tool result gives",
      "`cp <absolute path> <deck>/assets/site.jpg`",
      "Images attached on EARLIER turns are not listed again: `ls` the scratch workspace's `attachments/`",
      "the file itself, never a description or a redrawing of it",
      "Never present a drawn mock-up as a real screen, never capture pages the deck is not about",
      "capture the element, not the whole screen — when an element shows personal data, capture a narrower one that shows none (there is no masking step)",
      // the outline for a large request names each slide's visual (the existing chat-outline mechanism)
      "one line per slide, naming its takeaway and its visual",
    ]) {
      expect(flat, pin).toContain(pin);
    }
    // The names the SKILL keys on are the server's own, read from the SOURCES as text (no imports): the describe_system
    // line that says which sources this run has, and the three scratch-workspace folders the server writes.
    const serverSrc = (rel: string) => fs.readFileSync(path.join(REPO, "src", "server", rel), "utf8");
    const label = /const IMAGE_SOURCES_LINE_PREFIX = "- ([^"]+): ";/.exec(serverSrc("agent/systemTools.ts"))?.[1];
    expect(label).toBe("Images for documents and decks");
    expect(flat).toContain(`describe_system's \`${label}\` line says which of these this run has`);
    const subdir = (rel: string) => [...serverSrc(rel).matchAll(/workspaceSubdirForWrite\(\s*\w+,\s*"([^"]+)"\s*\)/g)].map((m) => m[1]);
    const [attachments] = subdir("chatImages.ts");
    const [captures] = subdir("chatFiles.ts");
    const confluence = /const WORKSPACE_SAVE_DIR = "([^"]+)";/.exec(serverSrc("agent/confluenceTools.ts"))?.[1];
    expect([attachments, captures, confluence]).toEqual(["attachments", "captures", "confluence"]);
    expect(serverSrc("agent/confluenceTools.ts")).toMatch(/\bsave_to_workspace: z\b/);
    expect(flat).toContain(`each is also saved as a file in \`${attachments}/\``);
    expect(flat).toContain(`whose copy is saved in \`${captures}/\``);
    expect(flat).toContain(`\`mcp__confluence__get_attachment\` with \`save_to_workspace: true\` saves it in \`${confluence}/\``);
    expect(flat).toContain("`mcp__browser__screenshot` with the element's `uid` from a snapshot");
    // the tools the SKILL names are the server's own (the Confluence save option is lane C's addition)
    const agentSrc = (file: string) => fs.readFileSync(path.join(REPO, "src", "server", "agent", file), "utf8");
    expect(agentSrc("browserTools.ts")).toContain('"mcp__browser__screenshot"');
    expect(agentSrc("browserTools.ts")).toMatch(/"screenshot",[\s\S]{0,4000}\buid: z/);
    for (const t of ["mcp__confluence__get_attachment", "mcp__confluence__extract_page_assets"]) {
      expect(agentSrc("confluenceTools.ts"), t).toContain(`"${t}"`);
      expect(flat, t).toContain(`\`${t}\``);
    }
  });

  it("keeps text a legitimate visual and never polices image presence", () => {
    expect(flat).toContain("Text is a legitimate visual — never add an image just to have one");
    expect(authoring).toContain("text is a legitimate visual, and no slide gets an image just to have one");
    expect(flat).toContain(
      "a photo or screen capture, a chart, bars on one scale, a timeline, a diagram, a big number — or, for a statement or a quote, the words at display size",
    );
    // no rule, check or warning about a slide WITHOUT a picture — in the SKILL, the references or the README
    for (const [name, text] of [["SKILL.md", flat], ["AUTHORING.md", authoring], ["README.md", readme],
      ["EDITING.md", prose(read("reference/EDITING.md"))]] as const) {
      expect(text, name).not.toMatch(/`(?:no|missing)-(?:image|picture|photo|visual)`|`(?:image|picture|photo|visual)-(?:missing|required)`|`text-only(?:-slide)?`/);
      expect(text, name).not.toMatch(/(?:warn|error|lint|flag)[^.]{0,40}\b(?:slide|slides)\b[^.]{0,30}\b(?:without|with no|lacks?)\b[^.]{0,20}\b(?:image|picture|photo|visual)s?\b/i);
    }
  });

  it("documents captures, scrims and the text-on-picture rule where the agent reads them", () => {
    for (const pin of [
      // the lint row (§2): the worst case under each line, and where the fix is
      "| `text-on-picture` | error |",
      "The fix: a scrim under the text, an opaque card, or the text moved off the picture (§7)",
      // §7 captures: own aspect, never upscaled, markers opaque, source captioned
      "at the capture's OWN aspect: the whole capture with `object-fit: contain`",
      "`object-fit: cover` + `object-position: top` to show the top of a UI",
      "Never show a capture larger than its own pixels",
      "A drawn mock-up never poses as a real screen",
      "capture a narrower one that shows none — never place it unmasked, and there is no masking step",
      // a PNG's transparent area is picture too: the check judges the whole <img> box
      "a PNG's transparent area counts as picture too",
      // §7 scrims: a LEAF sibling in brand-950, the arithmetic's numbers (0.72 is the number the lint's message names)
      "ONE leaf box painted after the picture and before the text",
      "`background: var(--c-brand-950); opacity: 0.72` under white text",
      "the check's message names ≥ 0.72, the kit standard, because it also carries 80 % white text in every theme",
      "translucent white text on it needs ≥ 75 % (74 % fails in `forest` at 4.4995:1; the examples use 80 %)",
      "Keep the scrim a SIBLING of the text, never its container",
      // §8.27 models an element capture of the main area, never the whole screen; the checklist names the rule
      "an element capture (`mcp__browser__screenshot` with the `uid` of the app's main container), never the whole screen",
      "no `text-on-picture` error",
      // §8.25's old "no dark scrim" became the scrim rule; §8.26–§8.30 describe the visual deck
      "the split keeps the whole photo in view where text over it would need a scrim (§7, §8.26)",
      "**8.26 Photo cover**", "**8.27 Capture in a browser frame**", "**8.28 Numbered callouts on a capture**",
      "**8.29 Phone screens, before and after**", "**8.30 Photo slot under a scrim**",
      "the visual deck 8.26–8.30",
    ]) {
      expect(authoring, pin).toContain(pin);
    }
    expect(authoring).not.toContain("allow no dark scrim");
    // the SKILL's essentials name the rule and the scrim; the delivery message names the pictures and the slots
    expect(flat).toContain("Text over a photo or a photo slot sits on a scrim");
    expect(flat).toContain("`text-on-picture` rule");
    expect(flat).toContain("naming the slides that show their attached images or your captures");
    expect(flat).toContain("what goes into each empty photo slot");
    // the examples README: the family, its assets' provenance, and no synthetic picture left in a real deck
    expect(readme).toContain("## `visual/` — 2026년 고객 포털 개편 결과 보고 (5 slides: built on pictures)");
    expect(readme).toContain("drawn by `converter/selftest/tools/make_assets.py --visual`");
    expect(readme).toContain("Never keep a synthetic picture in a real deck, and never pass a drawn screen off as a capture");
    expect(readme).not.toContain("use a photo the user provides (into the deck's `assets/`), or pick another slide");
    // without a real picture: words, a chart or a diagram first; a photo slot only for what the user will photograph
    expect(readme).toContain("Without a real picture, the slide's visual is the words themselves, a chart or a diagram");
    expect(readme).toContain("only when the slide is about something the user will photograph (people, a venue, a product)");
    expect(readme).toContain("there is no masking step, so capture a narrower element that shows none");
  });

  it("the visual deck's scrims keep every text at >= 4.5:1 over ANY picture, in every theme (the text-on-picture worst case)", async () => {
    const { resolveToken, parseColour, contrast } = await import(pathToFileURL(path.join(SKILL, "scripts", "theme-check.mjs")).href);
    const over = (fg: number[], a: number, bg: number[]) => [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
    const WHITE = [255, 255, 255];
    // white text at alpha `a` on a theme's brand-950 scrim at `opacity`, over its worst picture pixel (pure white or
    // pure black); a translucent text is blended over the composite first
    const worstOn = (theme: string, opacity: number, a: number) => {
      const vars = new Map([...BASE_TOKENS, ...cssTokens(read(`themes/${theme}.css`))]);
      const s = parseColour(resolveToken(vars, "--c-brand-950"));
      return Math.min(...[WHITE, [0, 0, 0]].map((base) => {
        const c = over(s, opacity, base);
        return contrast(over(WHITE, a, c), c);
      }));
    };
    const scrimSlides = visualSlides.filter((name) => read(`${VISUAL}/slides/${name}`).includes('class="scrim"'));
    expect(scrimSlides).toEqual(["01-photo-hero.html", "05-photo-slot-hero.html"]);
    for (const name of scrimSlides) {
      const rel = `${VISUAL}/slides/${name}`;
      const html = read(rel);
      // a LEAF sibling painted after the picture (an <img> or the photo slot) and before every text
      expect(html, name).toContain('<div class="scrim"></div>');
      const picture = Math.max(html.indexOf("<img "), html.indexOf('data-placeholder="pic"'));
      expect(picture, name).toBeGreaterThan(html.indexOf("<main"));
      expect(html.indexOf('<div class="scrim"></div>'), name).toBeGreaterThan(picture);
      const scrim = cssRule(rel, ".scrim");
      expect(scrim, name).toContain("background: var(--c-brand-950)");
      const opacity = Number(/opacity: ([\d.]+)/.exec(scrim)?.[1]);
      expect(opacity, name).toBe(0.72);
      // every text colour on the slide: white, or white at >= 80 % (§8.26: the secondary text, no fainter — AUTHORING
      // §7's contrast floor on this scrim is 75 %, pinned below)
      const style = (/<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
      const colours = [...style.matchAll(/(?:^|[\s;{])color:\s*([^;}]+)/g)].map((m) => m[1].trim());
      expect(colours.length, name).toBeGreaterThan(4);
      const alphas = colours.map((c) => (c === "var(--c-white)" ? 1 : Number(/^rgba\(255, 255, 255, ([\d.]+)\)$/.exec(c)?.[1])));
      for (const [k, a] of alphas.entries()) expect(a, `${name}: color ${colours[k]}`).toBeGreaterThanOrEqual(0.8);
      // the arithmetic of the slide's comment, recomputed on each theme's own brand-950 (small-text threshold)
      for (const theme of THEMES) {
        for (const a of new Set(alphas)) {
          expect(worstOn(theme, opacity, a), `${name} ${theme}: white ${a} on brand-950 at ${opacity}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    // AUTHORING §7's numbers for the 0.72 scrim: translucent white text needs >= 75 % (74 % fails in forest), and the
    // lint's message names 0.72 because 0.64 fails 80 % white text in exactly these four themes
    for (const theme of THEMES) expect(worstOn(theme, 0.72, 0.75), `${theme}: white 75 %`).toBeGreaterThanOrEqual(4.5);
    expect(worstOn("forest", 0.72, 0.74)).toBeLessThan(4.5);
    expect(THEMES.filter((theme) => worstOn(theme, 0.64, 0.8) < 4.5)).toEqual(["classic", "editorial", "forest", "violet"]);
  });

  it("the visual deck shows each capture at its own aspect and never larger than its pixels", () => {
    const pngSize = (rel: string) => {
      const b = fs.readFileSync(path.join(SKILL, rel));
      expect(b.subarray(1, 4).toString("latin1"), rel).toBe("PNG");
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    };
    let captures = 0;
    for (const name of visualSlides) {
      const rel = `${VISUAL}/slides/${name}`;
      for (const m of read(rel).matchAll(/<img class="([a-z-]+)" src="\.\.\/assets\/([a-z0-9-]+\.png)"/g)) {
        captures++;
        const { w: W, h: H } = pngSize(`${VISUAL}/assets/${m[2]}`);
        const rule = cssRule(rel, `.${m[1]}`);
        const w = Number(/(?:^|; )width: (\d+)px/.exec(rule)?.[1]);
        const h = Number(/(?:^|; )height: (\d+)px/.exec(rule)?.[1]);
        const fit = /object-fit: (contain|cover)/.exec(rule)?.[1];
        expect(fit, `${name} .${m[1]}`).toBeDefined();
        const scale = fit === "contain" ? Math.min(w / W, h / H) : Math.max(w / W, h / H);
        expect(scale, `${name} .${m[1]}: ${w}x${h} of ${W}x${H}`).toBeLessThanOrEqual(1);
        // contain: the frame has the capture's aspect, so no letterbox band shows
        if (fit === "contain") expect(Math.abs(w / h - W / H) / (W / H), `${name} .${m[1]}`).toBeLessThan(0.01);
        else expect(rule, `${name} .${m[1]}`).toContain("object-position: top");
      }
    }
    expect(captures).toBe(4);
  });

  it("ships synthetic, deterministic, small assets (make_assets.py --visual; the photo is the self-test's own)", () => {
    const assets = filesUnder(`${VISUAL}/assets`);
    expect(assets.map((f) => path.basename(f))).toEqual(["capture-phone-after.png", "capture-phone-before.png", "capture-web.png", "photo.jpg"]);
    const total = assets.reduce((n, f) => n + fs.statSync(path.join(SKILL, f)).size, 0);
    expect(total).toBeLessThan(1.5 * 1024 * 1024);
    const photo = fs.readFileSync(path.join(SKILL, "converter", "selftest", "features", "assets", "photo.jpg"));
    expect(fs.readFileSync(path.join(SKILL, VISUAL, "assets", "photo.jpg")).equals(photo)).toBe(true);
    expect(fs.readFileSync(path.join(SKILL, "examples", "talk", "assets", "photo.jpg")).equals(photo)).toBe(true);
    const tool = read("converter/selftest/tools/make_assets.py");
    for (const pin of ["--visual", "capture-web.png", "capture-phone-before.png", "capture-phone-after.png",
      "layout_engine=ImageFont.Layout.BASIC", "Pretendard-"]) {
      expect(tool, pin).toContain(pin);
    }
  });
});
