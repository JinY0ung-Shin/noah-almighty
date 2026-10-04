// The pptx skill's HTML -> editable-PPTX converter (default-skills/skills/pptx/converter, run through
// scripts/deck.sh). Two parts:
//  - toolchain-free (always, in `npm test`): the CLI contract, caps, locks and static checks of the toolkit;
//  - toolchain e2e (opt-in: NOAH_PPTX_E2E=1 AND `deck.sh probe` reports the converter; on a dev box also
//    NOAH_PPTX_PYTHON=<venv python> NOAH_PPTX_DEV=1): self-test, check/build, CSP and network negative controls,
//    the preview sidecar, the failure policy, budgets and cancellation.
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");
const SKILL = path.join(REPO, "default-skills", "skills", "pptx");
const KIT = path.join(SKILL, "converter");
const DECK_SH = path.join(SKILL, "scripts", "deck.sh");
const LOCKS = path.join(KIT, "tools", "lib", "locks.mjs");

type Run = { code: number | null; stdout: string; stderr: string; out: string };

function deck(args: string[], env: Record<string, string | undefined> = {}, opts: { cwd?: string; timeout?: number } = {}): Run {
  const r: SpawnSyncReturns<string> = spawnSync("bash", [DECK_SH, ...args], {
    cwd: opts.cwd ?? os.tmpdir(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: opts.timeout ?? 60_000,
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const tmpRoots: string[] = [];
function tmp(label: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `noah-deckconv-${label}-`));
  tmpRoots.push(d);
  return d;
}

const SLIDE = (body: string, head = "") => `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>test</title>
<link rel="stylesheet" href="../theme/base.css">
<link rel="stylesheet" href="../theme/fonts.css">
${head}
</head>
<body>
<main class="slide" data-layout="본문">
${body}
</main>
</body>
</html>
`;

/** A deck folder `<root>/<name>/slides/NN-*.html` with the given slide bodies. */
function makeDeck(root: string, name: string, slides: Record<string, string>): string {
  const d = path.join(root, name);
  fs.mkdirSync(path.join(d, "slides"), { recursive: true });
  for (const [file, html] of Object.entries(slides)) fs.writeFileSync(path.join(d, "slides", file), html);
  return d;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function treeHash(dir: string): string {
  const h = crypto.createHash("sha256");
  for (const f of walk(dir).sort()) {
    h.update(path.relative(dir, f));
    h.update(fs.readFileSync(f));
  }
  return h.digest("hex");
}

function findNamed(dir: string, names: Set<string>, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (names.has(e.name)) out.push(p);
    if (e.isDirectory()) findNamed(p, names, out);
  }
  return out;
}

/**
 * Pure helpers of the in-page extractor, evaluated in Node: tools/extract/inpage/*.js share one function scope in the
 * slide page and touch no DOM on load (00-util.js), so 00-util.js + 20-text.js evaluate as they are. `files` adds
 * further parts of that scope (40-shapes.js declares functions only, so it evaluates without a DOM too).
 */
function inpage<T>(names: string[], files: string[] = ["00-util.js", "20-text.js"]): T {
  const dir = path.join(KIT, "tools", "extract", "inpage");
  const src = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  return new Function(`${src}\nreturn { ${names.join(", ")} };`)() as T;
}

const hex64 = /^[0-9a-f]{64}$/;
const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** A PNG signature + IHDR chunk claiming w x h — all the converter's header reader looks at (no pixel data). */
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; // bit depth
  b[25] = 2; // RGB
  return b;
}

afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
  // running the suite never leaves bytecode or build folders in the (read-only at runtime) skill tree
  expect(findNamed(path.join(REPO, "default-skills"), new Set(["__pycache__", ".build"]))).toEqual([]);
});

// ------------------------------------------------------------------------------------------------ toolchain-free
describe("deck converter CLI (toolchain-free)", () => {
  it("--help exits 0 and prints the documented usage lines", () => {
    const r = deck(["--help"]);
    expect(r.code).toBe(0);
    for (const line of [
      "deck.sh check    <deck> [--profile embedded|malgun|both] [--only NN-name ...] [--json]",
      "deck.sh build    <deck> [--profile embedded|malgun] [--out <name>.pptx] [--author <name>] [--strict] [--json]",
      "deck.sh probe    [--json]",
      "deck.sh selftest [--profile embedded|malgun|both] [--keep <dir>] [--fail-on-drift] [--record <file>] [--update-golden] [--json]",
      "deck.sh --help",
    ]) {
      expect(r.stdout).toContain(line);
    }
    expect(r.stdout).toContain("FOREGROUND (Bash timeout: 600000)");
    // stable text: the docs block is generated from it (no absolute paths, no versions)
    expect(r.stdout).not.toContain(REPO);
    expect(deck(["-h"]).stdout).toBe(r.stdout);
  });

  it("usage errors exit 2 with a FAILED (usage) footer", () => {
    const root = tmp("usage");
    const ok = makeDeck(root, "q3-review", { "01-a.html": SLIDE("<p>x</p>") });
    const cases: [string[], RegExp][] = [
      [["bogus"], /unknown command "bogus"/],
      [["check", ok, "--bogus"], /unknown flag --bogus/],
      [["check", path.join(root, "missing-deck")], /deck folder not found/],
      [["build", ok, "--out", "../x.pptx"], /--out must be a bare file name/],
      [["build", ok, "--out", "x.ppt"], /--out must be a bare file name/],
      [["build", ok, "--profile", "both"], /--profile must be embedded or malgun/],
      [["check"], /needs a <deck> folder/],
    ];
    for (const [args, re] of cases) {
      const r = deck(args, { NOAH_PPTX_CHROMIUM: "/nonexistent" });
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.out).toMatch(/FAILED \(usage\)/);
      expect(r.out).toMatch(re);
      expect(r.out).toContain(`Next: fix the command (usage: bash ${DECK_SH} --help).`);
    }
    // non-ASCII deck folder name
    const ko = makeDeck(root, "분기보고", { "01-a.html": SLIDE("<p>x</p>") });
    const r = deck(["check", ko], { NOAH_PPTX_CHROMIUM: "/nonexistent" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/must be ASCII/);
    // a deck inside the skill directory (the examples/fixtures must be copied first)
    const inside = deck(["check", path.join(KIT, "selftest", "deck")], { NOAH_PPTX_CHROMIUM: "/nonexistent" });
    expect(inside.code).toBe(2);
    expect(inside.out).toMatch(/inside the pptx skill directory/);
    // --json: exactly one JSON object on stdout
    const j = deck(["build", ok, "--out", "../x.pptx", "--json"], { NOAH_PPTX_CHROMIUM: "/nonexistent" });
    expect(j.code).toBe(2);
    const rep = JSON.parse(j.stdout);
    expect(rep).toMatchObject({ format: "noah-deck-run", version: 1, ok: false, exitCode: 2, failure: { class: "usage" } });
  });

  it("an unknown --only slide is a usage error (exit 2) found before the lock and the toolchain", () => {
    const root = tmp("only");
    const d = makeDeck(root, "q3", { "01-cover.html": SLIDE("<p>a</p>"), "03-table.html": SLIDE("<p>b</p>") });
    // NOAH_PPTX_CHROMIUM=/nonexistent: a name that passed validation would stop at the toolchain (exit 4)
    const r = deck(["check", d, "--only", "03-tabel", "99-nope", "--json"], { NOAH_PPTX_CHROMIUM: "/nonexistent" });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).failure).toMatchObject({ class: "usage" });
    expect(r.stderr).toContain("FAILED (usage): --only: no such slide(s): 03-tabel, 99-nope (have 01-cover, 03-table)");
    expect(r.stderr).toContain(`Next: fix the command (usage: bash ${DECK_SH} --help).`);
    expect(fs.existsSync(path.join(d, ".build"))).toBe(false);
    // the spellings the extractor accepts pass validation
    expect(deck(["check", d, "--only", "03-table.html", "slides/01-cover.html"], { NOAH_PPTX_CHROMIUM: "/nonexistent" }).code).toBe(4);
  });

  it("the Python probe ignores the caller's cwd: a json.py there never runs, a pptx/ folder is not python-pptx", () => {
    const clean = tmp("pyclean");
    const shadow = tmp("pyshadow");
    const marker = path.join(shadow, "MARKER");
    const payload = `open(${JSON.stringify(marker)}, "w").write("ran")\n`;
    for (const f of ["json.py", "importlib.py", "sys.py"]) fs.writeFileSync(path.join(shadow, f), payload);
    for (const m of ["pptx", "lxml", "PIL", "fontTools", "defusedxml", "openpyxl", "xlsxwriter"]) fs.mkdirSync(path.join(shadow, m));
    const a = JSON.parse(deck(["probe", "--json"], {}, { cwd: clean }).stdout);
    const b = JSON.parse(deck(["probe", "--json"], {}, { cwd: shadow }).stdout);
    expect(fs.existsSync(marker)).toBe(false);
    expect(b.python).toEqual(a.python);
    expect(b.converter).toBe(a.converter);
  });

  it("caps are authoring errors (exit 1) found before any toolchain lookup", () => {
    const root = tmp("caps");
    const three = makeDeck(root, "three", {
      "01-a.html": SLIDE("<p>a</p>"), "02-b.html": SLIDE("<p>b</p>"), "03-c.html": SLIDE("<p>c</p>"),
    });
    // NOAH_PPTX_CHROMIUM=/nonexistent would be exit 4 if the toolchain were looked up first
    const r = deck(["check", three, "--json"], { NOAH_PPTX_MAX_SLIDES: "2", NOAH_PPTX_CHROMIUM: "/nonexistent" });
    expect(r.code).toBe(1);
    const rep = JSON.parse(r.stdout);
    expect(rep.failure.class).toBe("authoring");
    expect(rep.lint.items.map((l: { rule: string }) => l.rule)).toContain("slide-count");
    expect(r.stderr).toMatch(/the deck has 3 slides; the limit is 2 per build/);
    expect(r.stderr).toContain(`reference/AUTHORING.md §2 and "Limits") and run: bash ${DECK_SH} check ${three}`);
    expect(fs.existsSync(path.join(three, ".build"))).toBe(false);

    const big = makeDeck(root, "big", { "01-a.html": SLIDE(`<p>a</p><!-- ${"x".repeat(2_150_000)} -->`) });
    const b = deck(["build", big], { NOAH_PPTX_CHROMIUM: "/nonexistent" });
    expect(b.code).toBe(1);
    expect(b.out).toMatch(/LINT ERROR deck slide-too-large/);

    const names = makeDeck(root, "names", { "1-a.html": SLIDE("<p>a</p>"), "02-b.html": SLIDE("<p>b</p>"), "02-c.html": SLIDE("<p>c</p>") });
    const n = deck(["check", names, "--json"], { NOAH_PPTX_CHROMIUM: "/nonexistent" });
    expect(n.code).toBe(1);
    const nr = JSON.parse(n.stdout);
    expect(nr.lint.items.filter((l: { rule: string }) => l.rule === "slide-name")).toHaveLength(2);

    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    expect(deck(["check", empty], { NOAH_PPTX_CHROMIUM: "/nonexistent" }).code).toBe(1);
  });

  it("Next: commands repeat the run's flags, shell-quoted; expected malgun weight notes fold into one line", async () => {
    const R = await import(pathToFileURL(path.join(KIT, "tools", "lib", "report.mjs")).href);
    expect(R.shq("/tmp/q3-review")).toBe("/tmp/q3-review");
    expect(R.shq("김 노아")).toBe("'김 노아'");
    expect(R.shq("it's")).toBe("'it'\\''s'");
    expect(R.rerunArgs("check", "/w/q3", { profile: "embedded" })).toBe("check /w/q3");
    expect(R.rerunArgs("check", "/w/q3", { profile: "both", only: ["02-kpi", "04-chart"] })).toBe("check /w/q3 --profile both --only 02-kpi 04-chart");
    expect(R.rerunArgs("build", "/w/my deck", { profile: "malgun", out: "q3.pptx", author: "김노아", strict: true }))
      .toBe("build '/w/my deck' --profile malgun --out q3.pptx --author '김노아' --strict");
    expect(R.rerunArgs("build", "/w/q3", { profile: "embedded", author: "Noah Almighty" })).toBe("build /w/q3");
    expect(R.NEXT.authoring("/w/q3", { rerun: "check /w/q3 --profile malgun", rules: ["text-overflow", "slide-count", "text-overflow"] }))
      .toBe(`Next: fix the listed elements in the slide HTML (see ${path.join(SKILL, "reference", "AUTHORING.md")} §2 and "Limits"; text-overflow: §4.2–§4.3) and run: bash ${DECK_SH} check /w/q3 --profile malgun`);
    const items = [
      { slide: 1, profile: "malgun", severity: "warn", rule: "font-weight", message: "font-weight 600 is not a fonts.json face weight (400/700)", path: "a" },
      { slide: 2, profile: "malgun", severity: "warn", rule: "font-weight", message: "font-weight 800 is not a fonts.json face weight (400/700)", path: "b" },
      { slide: 2, profile: "malgun", severity: "error", rule: "font-weight", message: "font-weight 500 is not a kit weight", path: "c" },
      { slide: 2, profile: "malgun", severity: "warn", rule: "soft-wrap", message: "wraps inside the word", path: "d" },
    ];
    expect(R.lintCounts(items)).toMatchObject({ errors: 1, warnings: 1, expected: 2 });
    const lines = R.lintLines(items, new Map([[1, "01-a"], [2, "02-b"]]));
    expect(lines.filter((l: string) => l.startsWith("LINT "))).toEqual([
      "LINT ERROR slide 2 (02-b) font-weight c: font-weight 500 is not a kit weight",
      "LINT WARN slide 2 (02-b) soft-wrap d: wraps inside the word",
    ]);
    expect(lines.at(-1)).toBe("NOTE malgun weights: 600/800 text is drawn with 맑은 고딕 Bold on 2 slide(s) — expected, no action needed (AUTHORING §4.1; 2 font-weight entries in the report)");
  });

  it("layout findings from the IR: line-box overlaps are errors naming their spacing rule, a two-line text cut inside a word warns, table cells below 30 % free", async () => {
    const P = await import(pathToFileURL(path.join(KIT, "tools", "lib", "pipeline.mjs")).href);
    const line = (text: string, left: number, right: number, top: number, extra: object = {}) => ({ text, left, right, top, bottom: top + 21, baseline: top + 17, paragraph: 0, hardBreak: false, ...extra });
    const run = (text: string) => ({ text, fontWeight: 400, sizePx: 16, baseline: "normal" });
    const ir = {
      slides: [{
        index: 3,
        elements: [
          { id: "t1", kind: "text", placeholder: "title", paragraphs: [{ runs: [run("긴 제목")] }], lines: [line("긴 ", 80, 200, 80), line("제목", 80, 160, 104)] },
          { id: "t2", kind: "text", paragraphs: [{ runs: [run("본문")] }], lines: [line("본문", 90, 130, 110)] },
          { id: "t3", kind: "text", paragraphs: [{ runs: [run("전략기획실")] }], lines: [line("전략기획", 500, 564, 300), line("실", 500, 516, 324)] },
          { id: "t4", kind: "text", paragraphs: [{ runs: [run("가 나 다")] }], lines: [line("가 나 ", 700, 740, 300), line("다", 700, 716, 324)] },
          // side by side: a label grown 6 px into the value beside it; stacked: two texts 6 px into each other
          { id: "t5", kind: "text", paragraphs: [{ runs: [run("왼쪽 라벨 길어짐")] }], lines: [line("왼쪽 라벨 길어짐", 80, 296, 560)] },
          { id: "t6", kind: "text", paragraphs: [{ runs: [run("값")] }], lines: [line("값", 290, 330, 560)] },
          { id: "t7", kind: "text", paragraphs: [{ runs: [run("위 텍스트")] }], lines: [line("위 텍스트", 600, 700, 600)] },
          { id: "t8", kind: "text", paragraphs: [{ runs: [run("아래 텍스트")] }], lines: [line("아래 텍스트", 610, 720, 615)] },
          {
            id: "tb", kind: "table", columnsPx: [200, 100],
            cells: [[
              { paddingPx: { l: 20, r: 20 }, lines: [line("엔터프라이즈 솔루션", 100, 250, 400)] },
              { paddingPx: { l: 20, r: 20 }, lines: [line("1", 350, 360, 400)] },
            ]],
          },
        ],
      }],
    };
    type Overlap = { a: string; b: string; arrangement: string; wrappedTitle?: string };
    expect(P.textOverlapsOf(ir, "malgun").map((o: Overlap) => [o.a, o.b, o.arrangement, o.wrappedTitle ?? null]))
      .toEqual([["t1", "t2", "stacked", "t1"], ["t5", "t6", "side-by-side", null], ["t7", "t8", "stacked", null]]);
    const lint = P.layoutLintOf(ir, "malgun");
    const overlaps = lint.filter((l: { rule: string }) => l.rule === "text-overlap");
    expect(overlaps.map((l: { path: string; severity: string }) => [l.path, l.severity])).toEqual([["t1", "error"], ["t5", "error"], ["t7", "error"]]);
    // what was measured (the lines' full font height, not the ink) and the spacing rule for how the pair meets
    expect(overlaps[0].message).toBe("the line boxes of its text (\"긴 제목\") and of t2 (\"본문\") intersect by 40×15 px in the malgun profile — measured over each line's full font height, ascent to descent (1.33 em in this profile, taller than the ink), so the glyphs may not touch yet; one runs over the other because this title wraps onto an extra line: fix its title-wrap error — shorten the title or re-break it with <br> (AUTHORING §4.3; a cover title §8.13)");
    expect(overlaps[1].message).toContain("intersect by 6×21 px in the malgun profile — measured over each line's full font height, ascent to descent (1.33 em in this profile, taller than the ink), so the glyphs may not touch yet; they meet along the line: keep ≥ 16 px between a line's end and the next text in the wider malgun profile, whose text is up to 20 % wider — widen the gap or the box, or shorten the text (AUTHORING §4.3)");
    expect(overlaps[2].message).toContain("; one runs over the other: give each text its own box, stacked without negative margins or overlapping positions, with a line-height ≥ 1.33 × its font size (AUTHORING §4.2)");
    for (const l of overlaps) expect(l.message).not.toMatch(/\bits text \(.*\) overlaps\b/);
    expect(P.layoutLintOf(ir, "embedded").find((l: { path: string }) => l.path === "t5").message).toContain("ascent to descent (1.19 em in this profile, taller than the ink)");
    // the title's own wrap is title-wrap (in-page); only the label cut inside a word warns — not a break at a space
    const warns = lint.filter((l: { rule: string }) => l.rule === "soft-wrap");
    expect(warns.map((l: { path: string }) => l.path)).toEqual(["t3"]);
    expect(warns[0].message.startsWith('wraps inside the word "전략기획실" ("전략기획" / "실") in the malgun profile')).toBe(true);
    const sw = P.softWrapsOf(ir, "malgun");
    expect(sw.find((w: { id: string }) => w.id === "t3")).toMatchObject({ wrapped: "전략기획 / 실", breaks: [{ word: "전략기획실", left: "전략기획", right: "실" }] });
    expect(sw.find((w: { id: string }) => w.id === "t4").breaks).toEqual([null]);
    expect(P.tableCellsOf(ir, "malgun")).toEqual([{ slide: 3, profile: "malgun", id: "tb", row: 1, column: 1, text: "엔터프라이즈 솔루션", freePct: 6, softWraps: 0 }]);
  });

  it("probe --json follows the probe contract; a missing Chromium is a fact, never an install command", () => {
    const r = deck(["probe", "--json"]);
    const p = JSON.parse(r.stdout);
    expect(p).toMatchObject({ format: "noah-deck-probe", version: 1, converterVersion: "1.3.0" });
    expect(typeof p.converter).toBe("boolean");
    expect(r.code).toBe(p.converter ? 0 : 4);
    for (const k of ["chromium", "playwrightCore", "python", "fonts", "profiles", "limits", "selftest", "missing"]) expect(p).toHaveProperty(k);
    expect(p.limits).toEqual({
      maxSlides: 60, maxSeconds: 540, maxSlideHtmlBytes: 2097152, maxDomElements: 2500,
      maxAssetBytes: 20971520, maxDeckInputBytes: 104857600, maxConcurrent: 2, slotWaitSeconds: 150,
      maxImagePixels: 40_000_000, maxSlideImagePixels: 100_000_000,
    });
    expect(p.fonts).toEqual({ embedded: true, malgun: true });

    const n = deck(["probe", "--json"], { NOAH_PPTX_CHROMIUM: "/nonexistent", NOAH_PPTX_SELFTEST_RECORD: "/nonexistent/record.json" });
    expect(n.code).toBe(4);
    const q = JSON.parse(n.stdout);
    expect(q.converter).toBe(false);
    expect(q.profiles).toEqual([]);
    expect(q.selftest).toEqual({ status: "not-recorded" });
    const chromiumFact = q.missing.find((m: string) => /Chromium|NOAH_PPTX_CHROMIUM/.test(m));
    expect(chromiumFact).toBeTruthy();
    for (const m of q.missing) expect(m).not.toMatch(/\b(apt|apt-get|pip|npm|npx|install)\b/);
    expect(n.stderr).toMatch(/converter NOT INSTALLED/);
  });

  it("probe reports the build-time self-test record (and the DECK_CONVERTER=0 state)", () => {
    const root = tmp("record");
    const rec = path.join(root, "rec.json");
    fs.writeFileSync(rec, JSON.stringify({ format: "noah-deck-selftest-record", version: 1, status: "drift", converterVersion: "1.0.0", chromiumVersion: "154.0.8037.57", at: "2026-09-26T03:00:00Z", maxDelta: 0.4, differences: 3, lintSetChanged: false }));
    const p = JSON.parse(deck(["probe", "--json"], { NOAH_PPTX_SELFTEST_RECORD: rec }).stdout);
    expect(p.selftest).toMatchObject({ status: "drift", chromiumVersion: "154.0.8037.57", maxDelta: 0.4, differences: 3 });
    fs.writeFileSync(rec, JSON.stringify({ format: "noah-deck-selftest-record", version: 1, status: "disabled" }));
    const d = deck(["probe", "--json"], { NOAH_PPTX_SELFTEST_RECORD: rec, NOAH_PPTX_CHROMIUM: "/nonexistent" });
    const q = JSON.parse(d.stdout);
    expect(q.converter).toBe(false);
    expect(q.missing).toContain("the image was built without the converter (DECK_CONVERTER=0)");
  });

  it("build without the toolchain exits 4: an administrator must rebuild — unless describe_system said INSTALLED (SKILL §12)", () => {
    const root = tmp("toolchain");
    const d = makeDeck(root, "q3", { "01-a.html": SLIDE("<p>a</p>") });
    const r = deck(["build", d], { NOAH_PPTX_CHROMIUM: "/nonexistent", NOAH_PPTX_LOCK_NAMESPACE: `t${process.pid}tc` });
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/FAILED \(toolchain\): the HTML→PPTX converter's toolchain is incomplete in this environment \(NOAH_PPTX_CHROMIUM \(\/nonexistent\) is not an executable file/);
    // the facts land in a log the administrator gets when describe_system had reported the converter as installed
    const log = /; log: (\S+toolchain\.log)\./.exec(r.out)?.[1];
    expect(log && fs.readFileSync(log, "utf8")).toContain("missing: NOAH_PPTX_CHROMIUM (/nonexistent) is not an executable file");
    expect(r.out).toContain("Next: do not install packages or download a browser. If describe_system reported `converter: INSTALLED` (or an earlier `deck.sh probe` exited 0), this is not a missing install: retry the same command once; if it fails again, give the user the log path for the administrator — never tell the user PPT generation is unavailable. Otherwise tell the user a system administrator must rebuild the server image;");
    expect(r.out).toContain(path.join(SKILL, "reference", "python-pptx.md"));
    // the lock was taken and released; the build dir is converter-owned and git-ignored
    expect(fs.readFileSync(path.join(d, ".build", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("a toolchain failure after the toolchain check passed is a run-time failure of the INSTALLED converter: retry, then the log (SKILL §12)", async () => {
    const R = await import(pathToFileURL(path.join(KIT, "tools", "lib", "report.mjs")).href);
    const P = await import(pathToFileURL(path.join(KIT, "tools", "lib", "pipeline.mjs")).href);
    const log = "/w/q3/.build/logs/20260926-000000-check/extract-embedded-check.log";
    const fields = (f: { cls: string; exitCode: number; stage: string; message: string; next: string }) => ({ cls: f.cls, exitCode: f.exitCode, stage: f.stage, message: f.message, next: f.next });
    const run = R.NEXT.toolchainRun();
    expect(run).toBe("Next: the converter is installed (this run passed its toolchain check), so do not tell the user PPT generation is unavailable and do not install anything: retry the same command once; if it fails again, tell the user the converter failed on the server and give the administrator the log path.");
    // what the extractor reports as `toolchain` once deck.mjs's own check passed: the browser did not start, a
    // converter font file did not load — never "unavailable in this deployment", never "rebuild the image"
    for (const message of [
      "Chromium (/usr/lib/chromium/chromium-headless-shell) did not start: browserType.launch: Target page, context or browser has been closed",
      "slides/01-a.html [malgun, dsf 1]: font face(s) used by the slide did not load:\n  - \"PoC Malgun Substitute\" weight 1 549 normal unicode-range all: status 'error' src url(\"../fonts/GothicA1-Regular.ttf\")",
    ]) {
      const f = fields(P.extractFailure({ ok: false, class: "toolchain", message, slide: null }, { where: "", log, deckAbs: "/w/q3" }));
      expect(f).toEqual({
        cls: "toolchain", exitCode: 4, stage: "extract", next: run,
        message: `the converter is installed (this run passed its toolchain check), but the extract stage could not use it (${message.split("\n")[0].replace(/:\s*$/, "")}); log: ${log}.`,
      });
      expect(`${f.message} ${f.next}`).not.toMatch(/rebuild|unavailable in this deployment/);
    }
    // a missing toolchain defers to describe_system: "rebuild" only when the server did not report the converter
    expect(R.NEXT.toolchain()).toMatch(/^Next: do not install packages or download a browser\. If describe_system reported `converter: INSTALLED` .*retry the same command once; if it fails again, give the user the log path for the administrator — never tell the user PPT generation is unavailable\. Otherwise tell the user a system administrator must rebuild the server image;/);
    // the other classes keep their own footers
    expect(fields(P.extractFailure({ ok: false, class: "internal", message: "slides/01-a.html [malgun, dsf 1]: font face(s) used by the slide did not load (a converter fault, not the slide's):\n  - x" }, { log, deckAbs: "/w/q3" })))
      .toEqual({ cls: "internal", exitCode: 4, stage: "extract", message: `the extract stage crashed (slides/01-a.html [malgun, dsf 1]: font face(s) used by the slide did not load (a converter fault, not the slide's)); log: ${log}.`, next: R.NEXT.internal() });
    expect(fields(P.extractFailure({ ok: false, class: "authoring", message: "slides/02-b.html: no <main class=\"slide\">" }, { where: "slide 2 (02-b): ", log, deckAbs: "/w/q3", rerun: "check /w/q3 --profile malgun" })))
      .toEqual({ cls: "authoring", exitCode: 1, stage: "extract", message: "slide 2 (02-b): slides/02-b.html: no <main class=\"slide\">", next: R.NEXT.authoring("/w/q3", { rerun: "check /w/q3 --profile malgun" }) });
  });

  it("font audit: only toolkit faces never requested or still loading are internal; toolkit file errors toolchain; any deck face authoring", async () => {
    const B = await import(pathToFileURL(path.join(KIT, "tools", "extract", "browser.mjs")).href);
    const C = await import(pathToFileURL(path.join(KIT, "tools", "extract", "cmap.mjs")).href);
    const familyLabels = C.familyLabels(JSON.parse(fs.readFileSync(path.join(KIT, "fonts", "fonts.json"), "utf8")));
    const kit = (status: string, extra: object = {}) => ({ family: "\"PoC Malgun Substitute\"", weight: "1 549", style: "normal", unicodeRange: "U+20, U+A0", status, src: "url(\"../fonts/selawk.ttf\") format(\"truetype\")", ...extra });
    const deckFace = (status: string) => ({ family: "\"Deck Face\"", weight: "400", style: "normal", unicodeRange: "U+0-10FFFF", status, src: "url(\"../assets/deck.woff2\")" });
    const at = { rel: "slides/01-a.html", profile: "malgun", dsf: 1, familyLabels };
    const none = { stillLoading: [] };
    const ok = { failures: [] };
    expect(B.fontLoadFailure({ ...at, ready: none, fonts: ok })).toBeNull();
    // a toolkit face still loading when the wait gave up, with nothing else wrong: a fault of the audit, never the slide's
    const loading = B.fontLoadFailure({ ...at, ready: { stillLoading: [kit("loading")] }, fonts: ok });
    expect(loading.cls).toBe("internal");
    expect(loading.message).toBe("slides/01-a.html [malgun, dsf 1]: font face(s) used by the slide did not load (a converter fault, not the slide's):\n  - still loading after the wait: \"PoC Malgun Substitute\" (the malgun profile's metric-matched stand-in for 맑은 고딕) weight 1 549 normal unicode-range U+20, U+A0 src url(\"../fonts/selawk.ttf\") format(\"truetype\")");
    expect(B.fontLoadFailure({ ...at, ready: none, fonts: { failures: [kit("unloaded", { chars: " ", path: "main.slide > p" })] } }).cls).toBe("internal");
    expect(B.fontLoadFailure({ ...at, ready: { stillLoading: [kit("loading")] }, fonts: { failures: [kit("error")] } }).cls).toBe("internal");
    // every toolkit face errored: its file (present at the toolchain check) did not load
    const broken = B.fontLoadFailure({ ...at, ready: none, fonts: { failures: [kit("error"), kit("error", { unicodeRange: "" })] } });
    expect(broken.cls).toBe("toolchain");
    expect(broken.message).not.toContain("a converter fault");
    // a face of the deck's own — or one the audit cannot attribute — is the deck's to fix
    expect(B.fontLoadFailure({ ...at, ready: { stillLoading: [deckFace("loading")] }, fonts: ok }).cls).toBe("authoring");
    expect(B.fontLoadFailure({ ...at, ready: { stillLoading: [kit("loading")] }, fonts: { failures: [deckFace("error")] } }).cls).toBe("authoring");
    expect(B.fontLoadFailure({ ...at, ready: none, fonts: { failures: [kit("error", { src: null })] } }).cls).toBe("authoring");
    expect(B.fontLoadFailure({ ...at, ready: none, fonts: { failures: [deckFace("error")] }, missing: ["http://deck.local/assets/deck.woff2"] }).message)
      .toBe("slides/01-a.html [malgun, dsf 1]: font face(s) used by the slide did not load:\n  - \"Deck Face\" weight 400 normal unicode-range U+0-10FFFF: status 'error' src url(\"../assets/deck.woff2\")\n  missing files: http://deck.local/assets/deck.woff2");
  });

  it("agent-facing font names: the malgun stand-in is named by what it stands in for, never as \"the profile font\"", async () => {
    const C = await import(pathToFileURL(path.join(KIT, "tools", "extract", "cmap.mjs")).href);
    const fontsJson = JSON.parse(fs.readFileSync(path.join(KIT, "fonts", "fonts.json"), "utf8"));
    // the internal family keeps its name (CSS, IR and goldens use it); only the text the agent reads changes
    expect(fontsJson.profiles.malgun.cssFamily).toBe("PoC Malgun Substitute");
    const labels = C.familyLabels(fontsJson);
    expect(labels).toEqual({ "PoC Malgun Substitute": "the malgun profile's metric-matched stand-in for 맑은 고딕" });
    expect(C.agentFamily("\"PoC Malgun Substitute\"", labels)).toBe("\"PoC Malgun Substitute\" (the malgun profile's metric-matched stand-in for 맑은 고딕)");
    expect(C.agentFamily("Arial", labels)).toBe("\"Arial\"");
    expect(C.familyList("Arial, \"PoC Malgun Substitute\", sans-serif")).toEqual(["Arial", "PoC Malgun Substitute", "sans-serif"]);
    expect(C.familyList("'a, b', c")).toEqual(["a, b", "c"]);
    const { fontFamilyMessage } = inpage<{ fontFamilyMessage: (used: string, css: string, labels: object) => string }>(["fontFamilyMessage"]);
    expect(fontFamilyMessage("Pretendard", "PoC Malgun Substitute", labels)).toBe("text uses font-family \"Pretendard\", not the profile font (the malgun profile's metric-matched stand-in for 맑은 고딕): never name a font — inherit font-family: var(--font-sans) (AUTHORING §4.1)");
    expect(fontFamilyMessage("Arial", "Pretendard", labels)).toBe("text uses font-family \"Arial\", not the profile font \"Pretendard\": never name a font — inherit font-family: var(--font-sans) (AUTHORING §4.1)");
    expect(fontFamilyMessage("PoC Malgun Substitute", "Pretendard", labels)).toBe("text uses font-family \"PoC Malgun Substitute\" (the malgun profile's metric-matched stand-in for 맑은 고딕), not the profile font \"Pretendard\": never name a font — inherit font-family: var(--font-sans) (AUTHORING §4.1)");
    // no agent-facing text prints the profile's CSS family raw
    for (const f of ["tools/extract/inpage/20-text.js", "tools/extract.mjs", "tools/extract/browser.mjs"]) {
      const s = fs.readFileSync(path.join(KIT, f), "utf8");
      expect(s, f).not.toMatch(/profile font "\$\{ctx\.cssFamily\}"|font-family \$\{unq\(u\.fontFamily\)\}|- "\$\{f\.family\}"/);
    }
  });

  it("title-wrap guidance follows the title kind: the cover title (§8.13) and a slide title (§4.3), from the title's own box", () => {
    const { titleWrapMessage } = inpage<{ titleWrapMessage: (kind: string, n: number, size: number, ls: number, w: number) => string }>(["titleWrapMessage"]);
    // the kit cover: 60 px (--tracking-display -0.025em) in a 520 px box — AUTHORING §8.13 says about 8 per malgun line
    expect(titleWrapMessage("ctrTitle", 3, 60, -1.5, 520)).toBe("the cover title wraps onto 3 lines without <br> in this profile — its 520 px box holds about 8 Hangul syllables per 60 px line in the malgun profile (the wider one; a space takes about a third of a syllable): shorten the line or re-split it with <br> (AUTHORING §8.13)");
    expect(fs.readFileSync(path.join(SKILL, "reference", "AUTHORING.md"), "utf8")).toContain("about 8 Hangul syllables fit per 60 px line in `malgun`");
    // a slide title: 40 px (-0.02em) across the 1120 px column; a 48 px closing title gets its own count
    expect(titleWrapMessage("title", 2, 40, -0.8, 1120)).toBe("the slide title wraps onto 2 lines without <br> in this profile — its 1120 px box holds about 28 Hangul syllables per 40 px line in the malgun profile (the wider one; a space takes about a third of a syllable): shorten it or, where the layout leaves room, break it on purpose with <br> (AUTHORING §4.3)");
    expect(titleWrapMessage("title", 3, 48, -0.96, 700)).toContain("its 700 px box holds about 14 Hangul syllables per 48 px line in the malgun profile");
  });

  it("chart-range: a drawn value outside an explicit value axis warns (stack totals when stacked), a covered one never does", () => {
    type Res = { valueMin: number | null; valueMax: number | null; dataMin: number | null; dataMax: number | null; stacked?: boolean };
    const { chartRangeLint } = inpage<{ chartRangeLint: (el: null, r: Res, ctx: { lint: (s: string, rule: string, m: string) => void }) => void }>(
      ["chartRangeLint"],
      ["00-util.js", "20-text.js", "40-shapes.js"],
    );
    const warn = (r: Res): string[] => {
      const out: string[] = [];
      chartRangeLint(null, r, { lint: (severity, rule, message) => out.push(`${severity} ${rule}: ${message}`) });
      return out;
    };
    // the clipped bar keeps its true data label, so the chart misstates its own data — the message says so
    expect(warn({ valueMin: 0, valueMax: 150, dataMin: 80, dataMax: 900, stacked: false })).toEqual([
      "warn chart-range: the largest value drawn, 900, is above valueAxis.max 150 — PowerPoint clips it at the axis"
      + " while its data label still reads the true number: raise the maximum (AUTHORING §8.10)",
    ]);
    // stacked: the bound applies to the stack total, and the message names it (each value alone is under the max)
    expect(warn({ valueMin: 0, valueMax: 50, dataMin: 0, dataMax: 80, stacked: true })[0]).toContain("the largest stack total drawn, 80, is above valueAxis.max 50");
    expect(warn({ valueMin: 0, valueMax: 50, dataMin: -40, dataMax: 10, stacked: false })[0]).toContain("the lowest value drawn, -40, is below valueAxis.min 0 — PowerPoint clips it");
    expect(warn({ valueMin: -10, valueMax: 50, dataMin: -40, dataMax: 900, stacked: false })).toHaveLength(2);
    // no warning: exactly on the bound, inside it, a derived scale (null bounds), or pie/doughnut (no value axis)
    expect(warn({ valueMin: 0, valueMax: 50, dataMin: 0, dataMax: 50, stacked: false })).toEqual([]);
    expect(warn({ valueMin: 0, valueMax: 100, dataMin: 0, dataMax: 80, stacked: true })).toEqual([]);
    expect(warn({ valueMin: null, valueMax: null, dataMin: 10, dataMax: 9999, stacked: false })).toEqual([]);
    expect(warn({ valueMin: null, valueMax: null, dataMin: null, dataMax: null })).toEqual([]);
    // documented for the agent wherever the lint vocabulary is listed
    expect(fs.readFileSync(path.join(SKILL, "reference", "AUTHORING.md"), "utf8")).toContain("`chart-range`");
    expect(fs.readFileSync(path.join(KIT, "tools", "extract", "README.md"), "utf8")).toContain("`chart-range`");
  });

  it("photo slots: the data-prompt rule and the IR prompt; the four lints are documented, raised with their severities and point the Next: line at AUTHORING §7", async () => {
    const S = inpage<{ PIC_PROMPT_MAX: number; picPromptProblem: (raw: string | null) => string | null; picPromptText: (raw: string | null) => string | null }>(
      ["PIC_PROMPT_MAX", "picPromptProblem", "picPromptText"],
      ["00-util.js", "45-placeholder.js"],
    );
    expect(S.PIC_PROMPT_MAX).toBe(80);
    // valid: one line of at most 80 characters (code points, so 80 emoji pass); the IR collapses whitespace runs
    for (const ok of ["제품 사진을 넣으세요", "  앞뒤 공백  ", "가".repeat(80), "📷".repeat(80)]) expect(S.picPromptProblem(ok), ok).toBeNull();
    expect(S.picPromptText("  팀원   사진을\t넣으세요 ")).toBe("팀원 사진을 넣으세요");
    expect(S.picPromptText(null)).toBeNull();
    expect(S.picPromptText("   ")).toBeNull();
    // placeholder-prompt: missing, empty, on several lines, too long — each message says what to write
    const how = 'one line of at most 80 characters, e.g. data-prompt="제품 사진을 넣으세요"';
    expect(S.picPromptProblem(null)).toBe(`the photo slot has no data-prompt: add the Korean prompt PowerPoint shows in the empty placeholder (${how})`);
    expect(S.picPromptProblem(" \t")).toBe(`the photo slot's data-prompt is empty: write the Korean prompt PowerPoint shows in the empty placeholder (${how})`);
    for (const sep of ["\n", "\r\n", " "]) expect(S.picPromptProblem(`첫 줄${sep}둘째 줄`)).toMatch(/^the photo slot's data-prompt spans several lines: PowerPoint shows the prompt as one line/);
    expect(S.picPromptProblem("가".repeat(81))).toMatch(/^the photo slot's data-prompt has 81 characters, more than 80: /);
    // the source raises exactly these names, with these severities (rotation where every element is placed)
    const src = (f: string) => fs.readFileSync(path.join(KIT, "tools", "extract", "inpage", f), "utf8");
    for (const [f, call] of [
      ["45-placeholder.js", "ctx.lint('error', 'placeholder-prompt'"], ["45-placeholder.js", "ctx.lint('warn', 'placeholder-geometry'"],
      ["45-placeholder.js", "lint('error', 'placeholder-content'"], ["50-paint.js", "lint('error', 'rotated-placeholder'"],
    ]) expect(src(f), call).toContain(call);
    // the text roles stay three (the extractor and the builder): "pic" is named only in the placeholder warn's message
    expect(src("20-text.js")).toContain("const PLACEHOLDER_TYPES = new Set(['title', 'ctrTitle', 'subTitle']);");
    expect(src("20-text.js")).toContain('"pic" marks a photo slot');
    expect(fs.readFileSync(path.join(KIT, "tools", "pptxlib", "text.py"), "utf8")).toContain('PLACEHOLDER_TYPES = ("title", "ctrTitle", "subTitle")');
    // the builder and the gate share no code: both pin the idx scheme 13 + k
    for (const f of ["tools/pptxlib/placeholders.py", "tools/check_fidelity.py"]) expect(fs.readFileSync(path.join(KIT, f), "utf8"), f).toMatch(/^PIC_IDX0 = 13\b/m);
    // the Next: line points at the photo-slot row; the contract and the extractor docs list every rule
    const rules = ["placeholder-prompt", "placeholder-content", "placeholder-geometry", "rotated-placeholder"];
    const R = await import(pathToFileURL(path.join(KIT, "tools", "lib", "report.mjs")).href);
    expect(R.NEXT.authoring("/w/q3", { rules })).toContain("; placeholder-prompt: §7, placeholder-content: §7, placeholder-geometry: §7, rotated-placeholder: §7)");
    const contract = fs.readFileSync(path.join(KIT, "docs", "CONTRACT.md"), "utf8");
    const extractDocs = fs.readFileSync(path.join(KIT, "tools", "extract", "README.md"), "utf8");
    for (const rule of rules) {
      expect(contract, rule).toContain(`\`${rule}\``);
      expect(extractDocs, rule).toContain(`\`${rule}\``);
    }
    expect(contract).toContain('### `kind: "placeholder"` (1.2.0)');
    // the kit's slot component colours only through existing tokens (no new --c-* a theme would have to set)
    const css = fs.readFileSync(path.join(KIT, "theme", "base.css"), "utf8");
    const slotCss = css.slice(css.indexOf(".photo-slot {"));
    expect(slotCss).toMatch(/^\.photo-slot \{[^}]*border: 2px dashed var\(--c-ink-300\);/);
    for (const m of slotCss.matchAll(/var\((--[a-z0-9-]+)\)/g)) expect(css.slice(0, css.indexOf(".photo-slot {")), m[1]).toContain(`${m[1]}:`);
  });

  it("photo slots: a degenerate slot is a placeholder-size error, photo slides sharing a layout with slot-less slides warn (grouped as the builder groups them), slots number in document order, the hint is ink-600", async () => {
    const S = inpage<{ PIC_MIN_SIDE: number; picSizeProblem: (w: number, h: number) => string | null }>(["PIC_MIN_SIDE", "picSizeProblem"], ["00-util.js", "45-placeholder.js"]);
    expect(S.PIC_MIN_SIDE).toBe(24);
    for (const [w, h] of [[240, 240], [24, 24], [1280, 24]]) expect(S.picSizeProblem(w, h), `${w}x${h}`).toBeNull();
    // the kit's dashed frame around a slot without a height: 240×4 — named with its measured size and the fix
    expect(S.picSizeProblem(240, 4)).toBe('the photo slot is 240×4 px, too small for a photo (each side needs at least 24 px): give the slot an explicit width and height, e.g. style="width:240px;height:240px"');
    expect(S.picSizeProblem(0, 200)).toMatch(/^the photo slot is 0×200 px, too small/);
    expect(S.picSizeProblem(23.994, 100.126)).toMatch(/^the photo slot is 23\.99×100\.13 px, too small/);
    // the extractor raises it as an error after the prompt check, never a silent drop; the CSS lints skip a slot's hint
    const src = (f: string) => fs.readFileSync(path.join(KIT, "tools", "extract", "inpage", f), "utf8");
    const rec = src("45-placeholder.js");
    expect(rec).toContain("ctx.lint('error', 'placeholder-size'");
    expect(rec.indexOf("ctx.lint('error', 'placeholder-prompt'")).toBeLessThan(rec.indexOf("ctx.lint('error', 'placeholder-size'"));
    expect(rec).not.toMatch(/box\.w <= 0 \|\| box\.h <= 0\) return null/);
    expect(src("50-paint.js")).toContain("if (el !== ROOT && inPicSlot(el)) continue;");
    expect(src("50-paint.js")).toContain("out.slot = null;");
    expect(src("90-main.js")).toContain("numberPicSlots(OUT.elements);");

    // placeholder-layout: families keyed like pptxlib/layouts.py plan_layouts — data-layout, else the background
    const P = await import(pathToFileURL(path.join(KIT, "tools", "lib", "pipeline.mjs")).href);
    const slot = { kind: "placeholder", placeholder: "pic", prompt: "사진", slot: 0 };
    const text = { kind: "text", paragraphs: [], lines: [] };
    const white = { type: "solid", color: "FFFFFF", alpha: 1 };
    const ir = {
      slides: [
        { index: 1, name: "01-cover", layout: "표지", background: white, elements: [text] },
        { index: 2, name: "02-team", layout: "본문", background: white, elements: [text, slot] },
        { index: 3, name: "03-kpi", layout: "본문", background: white, elements: [text] },
        { index: 4, name: "04-table", layout: "본문", background: white, elements: [text] },
        // no data-layout: one family per background — the same fill with its keys in another order is the same family
        { index: 5, name: "05-a", layout: null, background: { type: "solid", color: "F4F6FA", alpha: 1 }, elements: [slot, { ...slot, slot: 1 }] },
        { index: 6, name: "06-b", layout: null, background: { alpha: 1, color: "F4F6FA", type: "solid" }, elements: [text] },
        { index: 7, name: "07-c", layout: null, background: { type: "solid", color: "0F1D4A", alpha: 1 }, elements: [text] },
        // every slide of the family has slots (1 and 2): nothing to warn about
        { index: 8, name: "08-one", layout: "사진", background: white, elements: [slot] },
        { index: 9, name: "09-two", layout: "사진", background: white, elements: [slot, { ...slot, slot: 1 }] },
      ],
    };
    expect(P.photoLayoutsOf(ir)).toEqual([
      { layout: "본문", photo: [{ index: 2, name: "02-team" }], plain: [{ index: 3, name: "03-kpi" }, { index: 4, name: "04-table" }] },
      { layout: null, photo: [{ index: 5, name: "05-a" }], plain: [{ index: 6, name: "06-b" }] },
    ]);
    const warns = P.layoutLintOf(ir, "embedded").filter((l: { rule: string }) => l.rule === "placeholder-layout");
    expect(warns).toEqual([
      {
        slide: 2, profile: null, severity: "warn", rule: "placeholder-layout", path: null,
        message: 'slide 2 (02-team) puts photo slots into the layout "본문", which slides 3 (03-kpi) and 4 (04-table) also use: PowerPoint copies a layout\'s picture placeholders onto every New Slide made from it, so a new slide from "본문" would come with empty photo slots — give the photo slide its own data-layout',
      },
      {
        slide: 5, profile: null, severity: "warn", rule: "placeholder-layout", path: null,
        message: "slide 5 (05-a) puts photo slots into the layout the slides without a data-layout share by background, which slide 6 (06-b) also uses: PowerPoint copies a layout's picture placeholders onto every New Slide made from it, so a new slide from that layout would come with empty photo slots — give the photo slide its own data-layout",
      },
    ]);
    // several photo slides: plural; a check of two profiles reports it once (the second passes photoLayouts: false)
    const two = { slides: [{ index: 1, name: "a", layout: "본문", elements: [slot] }, { index: 2, name: "b", layout: "본문", elements: [slot] }, { index: 3, name: "c", layout: "본문", elements: [] }] };
    expect(P.layoutLintOf(two, "malgun").find((l: { rule: string }) => l.rule === "placeholder-layout").message)
      .toMatch(/^slides 1 \(a\) and 2 \(b\) put photo slots into the layout "본문", which slide 3 \(c\) also uses: .* give the photo slides their own data-layout$/);
    expect(P.layoutLintOf(two, "malgun", { photoLayouts: false }).filter((l: { rule: string }) => l.rule === "placeholder-layout")).toEqual([]);
    expect(fs.readFileSync(path.join(KIT, "tools", "lib", "pipeline.mjs"), "utf8")).toContain("photoLayouts: p === profiles[0]");

    // both rules point the Next: line at the §7 photo-slot row and are documented wherever the lint vocabulary is
    const R = await import(pathToFileURL(path.join(KIT, "tools", "lib", "report.mjs")).href);
    expect(R.NEXT.authoring("/w/q3", { rules: ["placeholder-size", "placeholder-layout"] })).toContain("; placeholder-size: §7, placeholder-layout: §7)");
    const contract = fs.readFileSync(path.join(KIT, "docs", "CONTRACT.md"), "utf8");
    const extractDocs = fs.readFileSync(path.join(KIT, "tools", "extract", "README.md"), "utf8");
    for (const rule of ["placeholder-size", "placeholder-layout"]) {
      expect(contract, rule).toContain(`\`${rule}\``);
      expect(extractDocs, rule).toContain(`\`${rule}\``);
    }
    // the IR's slot: documented with its field order and in the 1.2.0 note; builder and gate read it (13 + slot)
    expect(contract).toContain('`{"placeholder": "pic", "prompt": "<data-prompt> | null", "slot": 0}`');
    expect(contract).toMatch(/1\.2\.0 adds \*\*photo slots\*\*[\s\S]*?with its `slot` — the slot's ordinal among the slide's slots in DOCUMENT order/);
    expect(fs.readFileSync(path.join(KIT, "tools", "build_pptx.py"), "utf8")).toContain('kw["idx"] = placeholders.PIC_IDX0 + slot');
    expect(fs.readFileSync(path.join(KIT, "tools", "check_fidelity.py"), "utf8")).toContain("want_idx = str(PIC_IDX0 + slot) if ok_slot else None");

    // the hint the renders show is text on the slot's ink-100 fill: ink-600 (≥ 4.5:1 in every shipped theme)
    const css = fs.readFileSync(path.join(KIT, "theme", "base.css"), "utf8");
    for (const sel of [".photo-slot {", ".photo-slot-hint {"]) {
      const block = css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
      expect(block, sel).toContain("color: var(--c-ink-600);");
      expect(block, sel).not.toContain("--c-ink-500");
    }
  });

  it("text-on-picture: text over an <img> or a photo slot keeps 4.5:1 (3:1 large) against ANY photo, through the layers painted between them", async () => {
    type El = Record<string, unknown>;
    type Finding = { el: El; ratio: number; need: number; large: boolean; line: number; picture: El; above: El[]; through: number; textAlpha: number; partly: boolean; bounded: boolean; boundBy: "element" | "slide" | null };
    const T = inpage<{
      tpcFindings: (els: El[], bg: El | null) => Finding[]; tpcMessage: (f: Finding) => string; TPC_NEED: number; TPC_NEED_LARGE: number;
      tpcWorstRatio: (t: number[], a: number, lo: number[], hi: number[]) => number;
      tpcBoundRatio: (t: number[], a: number, lo: number[], hi: number[]) => number;
    }>(
      ["tpcFindings", "tpcMessage", "TPC_NEED", "TPC_NEED_LARGE", "tpcWorstRatio", "tpcBoundRatio"],
      ["00-util.js", "55-text-on-picture.js"],
    );
    expect([T.TPC_NEED, T.TPC_NEED_LARGE]).toEqual([4.5, 3]);
    // independent WCAG arithmetic: sRGB compositing over the worst picture pixel (pure white under a dark scrim)
    const rgb = (h: string) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
    const cr = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const over = (c: number[], a: number, k: number[]) => c.map((v, i) => v * a + k[i] * (1 - a));
    const WHITE = [1, 1, 1], BLACK = [0, 0, 0];
    const CLASSIC_950 = "0A1433", FOREST_950 = "05241A"; // --c-brand-950 of the classic and forest themes
    const whiteOn = (hex: string, a: number) => cr(WHITE, over(rgb(hex), a, WHITE));

    const solid = (color: string, alpha = 1) => ({ type: "solid", color, alpha });
    const photo = (extra: El = {}): El => ({ id: "main.slide > img.photo:nth-child(1)::image", kind: "image", box: { x: 0, y: 0, w: 1280, h: 720 }, rotationDeg: 0, opacity: 1, src: null, svg: null, alt: "", _src: { localName: "img" }, ...extra });
    const slot = (extra: El = {}): El => ({ id: "#hero::placeholder", kind: "placeholder", box: { x: 0, y: 0, w: 1280, h: 720 }, rotationDeg: 0, opacity: 1, placeholder: "pic", prompt: "배경 사진을 넣으세요", slot: 0, ...extra });
    const shape = (id: string, b: [number, number, number, number], fill: El, opacity = 1, extra: El = {}): El => ({
      id: `main.slide > div.${id}:nth-child(2)::bg`, kind: "shape", box: { x: b[0], y: b[1], w: b[2], h: b[3] }, rotationDeg: 0, opacity, geometry: "rect", radiusPx: 0, fill, line: null, shadow: null, ...extra,
    });
    const scrim = (opacity: number, color = CLASSIC_950, b: [number, number, number, number] = [0, 0, 1280, 720]) => shape("scrim", b, solid(color), opacity);
    type TextOpts = { x?: number; y?: number; w?: number; size?: number; weight?: number; color?: string; alpha?: number; opacity?: number; runs?: El[]; lines?: El[] };
    const text = (t: string, o: TextOpts = {}): El => {
      const { x = 80, y = 300, w = 520, size = 16, weight = 400, color = "FFFFFF", alpha = 1, opacity = 1 } = o;
      return {
        id: "main.slide > h1.hero:nth-child(3)::text", kind: "text", box: { x, y, w, h: 40 }, rotationDeg: 0, opacity,
        paragraphs: [{ runs: o.runs ?? [{ text: t, sizePx: size, fontWeight: weight, color, alpha }], bullet: null, indentPx: 0 }],
        lines: o.lines ?? [{ top: y, bottom: y + 24, left: x, right: x + w, text: t, paragraph: 0, hardBreak: false }],
      };
    };
    const find = (els: El[]) => T.tpcFindings(els, solid("F4F6FA"));
    const one = (els: El[]) => {
      const f = find(els);
      expect(f).toHaveLength(1);
      return f[0];
    };
    const FIX = "fix: a scrim under the text (a dark token box, e.g. var(--c-brand-950) at opacity ≥ 0.72, under white text; or a light one under dark text), an opaque card, or move the text off the picture (AUTHORING §7)";

    // a dark scrim: 0.72 passes (the worst photo pixel is pure white: 7.31:1), 0.3 fails — named with ratio, share and fix
    expect(whiteOn(CLASSIC_950, 0.72)).toBeGreaterThan(7.3);
    expect(find([photo(), scrim(0.72), text("사진 위 제목")])).toEqual([]);
    const thin = one([photo(), scrim(0.3), text("사진 위 제목")]);
    expect(thin).toMatchObject({ need: 4.5, large: false, line: 0, partly: false });
    expect(thin.ratio).toBeCloseTo(whiteOn(CLASSIC_950, 0.3), 6);
    expect(thin.through).toBeCloseTo(0.7, 6);
    expect(T.tpcMessage(thin)).toBe(`its text ("사진 위 제목") is painted on the picture main.slide > img.photo:nth-child(1) at a worst-case contrast of ${Math.floor(whiteOn(CLASSIC_950, 0.3) * 100) / 100}:1, below the 4.5:1 it needs (3:1 only when every run is ≥ 24 px, or ≥ 18.66 px at weight ≥ 700) — the layer between them (main.slide > div.scrim:nth-child(2)) still lets 70 % of the picture through at the weakest point. A photo can put any colour behind text, pure white and pure black included; ${FIX}`);
    // no layer at all: 1:1 (any photo has a pixel of the text's own colour)
    const bare = one([photo(), text("막 없는 제목")]);
    expect(bare.ratio).toBe(1);
    expect(T.tpcMessage(bare)).toContain("at a worst-case contrast of 1:1, below the 4.5:1 it needs (3:1 only when every run is ≥ 24 px, or ≥ 18.66 px at weight ≥ 700) — it lies on the bare picture, with no layer between them.");
    // dark text over the same bare photo is just as illegible: a light scrim fixes it
    expect(one([photo(), text("어두운 글자", { color: "111A2E" })]).ratio).toBe(1);
    expect(find([photo(), shape("light", [0, 0, 1280, 720], solid("FFFFFF"), 0.8), text("어두운 글자", { color: "111A2E" })])).toEqual([]);
    // the number the message names is the kit's standard: a brand-950 scrim at 0.72 holds white AND 80 % white text in
    // every shipped theme (read from the theme files), where 0.64 fails 80 % white text in four of them
    const themeDir = path.join(SKILL, "themes");
    const brand950 = Object.fromEntries(fs.readdirSync(themeDir).filter((f) => f.endsWith(".css")).sort().map((f) => {
      const m = /--c-brand-950:\s*#([0-9A-Fa-f]{6})\b/.exec(fs.readFileSync(path.join(themeDir, f), "utf8"));
      return [f.replace(/\.css$/, ""), m![1].toUpperCase()];
    }));
    expect(Object.keys(brand950)).toEqual(["classic", "editorial", "forest", "midnight", "mono", "violet"]);
    const fails = (a: number, alpha: number) => Object.entries(brand950).filter(([, hex]) => find([photo(), scrim(a, hex), text("막 위 글자", { alpha })]).length).map(([t]) => t);
    expect([fails(0.72, 1), fails(0.72, 0.8)]).toEqual([[], []]);
    expect(fails(0.64, 0.8)).toEqual(["classic", "editorial", "forest", "violet"]);
    expect(T.tpcMessage(bare)).toContain("at opacity ≥ 0.72, under white text");

    // a gradient scrim is judged at the weakest corner of the covered box: to the right, alpha 1 → 0 across the slide
    const fade = shape("fade", [0, 0, 1280, 720], { type: "linear", angleDeg: 90, stops: [{ pos: 0, color: CLASSIC_950, alpha: 1 }, { pos: 1, color: "000000", alpha: 0 }] });
    const g = one([photo(), fade, text("그라데이션 위 제목", { x: 80, w: 520 })]);
    expect(g.ratio).toBeCloseTo(whiteOn(CLASSIC_950, 1 - 600 / 1280), 6); // x = 600: the line's right end
    expect(g.ratio).toBeLessThan(whiteOn(CLASSIC_950, 1 - 340 / 1280)); // weaker than at its centre
    expect(g.through).toBeCloseTo(600 / 1280, 6);
    expect(find([photo(), fade, text("왼쪽 짧은 제목", { x: 80, w: 120 })])).toEqual([]); // x ≤ 200: alpha ≥ 0.84
    // a stop inside the box is its extreme: an opaque band 0–40 % that fades out by 60 %, then a stop back to 0.5 at 100 %
    const bandFade = shape("fade", [0, 0, 1280, 720], {
      type: "linear", angleDeg: 90,
      stops: [{ pos: 0, color: CLASSIC_950, alpha: 1 }, { pos: 0.4, color: CLASSIC_950, alpha: 1 }, { pos: 0.6, color: CLASSIC_950, alpha: 0 }, { pos: 1, color: CLASSIC_950, alpha: 0.5 }],
    });
    const mid = one([photo(), bandFade, text("가운데를 지나는 줄", { x: 700, w: 400 })]); // 700–1100 spans the transparent stop at 768
    expect(mid.ratio).toBe(1);
    expect(mid.through).toBeCloseTo(1, 6);
    // a ramp between DIFFERENT colours can be darker inside than at either end (sRGB interpolation): 80 % red → green
    // over a black pixel leaves black display text 2.82:1 about a quarter of the way, while both ends of the covered
    // span pass 3:1 — the line is judged in slabs of 1/64 of the ramp, each by the box of everything in it: never
    // above the true worst, and stricter by at most what the ramp changes across one slab
    const hue = shape("hue", [0, 0, 1280, 720], { type: "linear", angleDeg: 90, stops: [{ pos: 0, color: "FF0000", alpha: 0.8 }, { pos: 1, color: "00FF00", alpha: 0.8 }] });
    const onRamp = (t: number, backdrop: number[]) => cr(BLACK, over([1 - t, t, 0], 0.8, backdrop)); // black text at ramp position t
    const span = (f: (t: number) => number, t0: number, t1: number) => Math.min(...Array.from({ length: 2001 }, (_, i) => f(t0 + ((t1 - t0) * i) / 2000)));
    const [t0, t1] = [80 / 1280, 1200 / 1280];
    expect(Math.min(onRamp(t0, BLACK), onRamp(t1, BLACK))).toBeGreaterThan(3); // the corners alone would pass
    const dip = one([photo(), hue, text("색이 바뀌는 막", { x: 80, w: 1120, size: 56, weight: 800, color: "000000" })]);
    expect(dip).toMatchObject({ need: 3, large: true, bounded: false });
    const trueDip = span((t) => onRamp(t, BLACK), t0, t1);
    expect(trueDip).toBeCloseTo(2.82, 2);
    expect(dip.ratio).toBeLessThanOrEqual(trueDip + 1e-9);
    expect(dip.ratio).toBeGreaterThan(trueDip * 0.97);
    // … and one colour fading in over ANOTHER coloured layer dips too: red 0 → 100 % over a 60 % green layer. The line
    // spans t 0.35–0.95, so its corners and centre (t 0.65) pass 3:1 and only the inside (t ≈ 0.5) fails
    const green = shape("green", [0, 0, 1280, 720], solid("00FF00"), 0.6);
    const redIn = shape("redin", [0, 0, 1280, 720], { type: "linear", angleDeg: 90, stops: [{ pos: 0, color: "FF0000", alpha: 0 }, { pos: 1, color: "FF0000", alpha: 1 }] });
    const overGreen = (t: number) => cr(BLACK, over([1, 0, 0], t, over([0, 1, 0], 0.6, BLACK)));
    expect(Math.min(overGreen(0.35), overGreen(0.65), overGreen(0.95))).toBeGreaterThan(3);
    const dip2 = one([photo(), green, redIn, text("초록 위 빨강", { x: 448, w: 768, size: 56, weight: 800, color: "000000" })]);
    const trueDip2 = span(overGreen, 0.35, 0.95);
    expect(trueDip2).toBeLessThan(3);
    expect(dip2.ratio).toBeLessThanOrEqual(trueDip2 + 1e-9);
    expect(dip2.ratio).toBeGreaterThan(trueDip2 * 0.97);
    // a single-hue ramp straight over an opaque picture stays exact as a whole (the fades above): what it lets through
    // only narrows as its alpha grows, so the box over the line is the box where its alpha is lowest

    // partial coverage: the uncovered part of a line box is the bare picture
    const half = one([photo(), scrim(0.9, CLASSIC_950, [0, 0, 400, 720]), text("절반만 덮인 줄")]);
    expect(half).toMatchObject({ ratio: 1, partly: true });
    expect(T.tpcMessage(half)).toContain("— part of it lies outside the layers above the picture, on the bare picture.");
    // two scrims side by side cover it together (the line is cut at their edges); a sub-pixel seam is layout rounding
    expect(find([photo(), scrim(0.9, CLASSIC_950, [0, 0, 400, 720]), scrim(0.9, CLASSIC_950, [400, 0, 880, 720]), text("나란한 두 막")])).toEqual([]);
    expect(find([photo(), scrim(0.9, CLASSIC_950, [0, 0, 400, 720]), scrim(0.9, CLASSIC_950, [400.6, 0, 879.4, 720]), text("틈 0.6 px")])).toEqual([]);
    expect(one([photo(), scrim(0.9, CLASSIC_950, [0, 0, 400, 720]), scrim(0.9, CLASSIC_950, [404, 0, 876, 720]), text("틈 4 px")]).ratio).toBe(1);
    // several lines: the line that leaves the band is named
    const band = scrim(0.9, CLASSIC_950, [0, 0, 1280, 330]);
    const two = text("", {
      runs: [{ text: "첫째 줄둘째 줄", sizePx: 16, fontWeight: 400, color: "FFFFFF", alpha: 1 }],
      lines: [
        { top: 300, bottom: 324, left: 80, right: 600, text: "첫째 줄", paragraph: 0, hardBreak: false },
        { top: 340, bottom: 364, left: 80, right: 600, text: "둘째 줄", paragraph: 0, hardBreak: false },
      ],
    });
    const second = one([photo(), band, two]);
    expect(second).toMatchObject({ line: 1, ratio: 1, partly: false });
    expect(T.tpcMessage(second)).toContain('— line 2 ("둘째 줄") lies on the bare picture, with no layer between them.');

    // an opaque card hides the photo: the text on it is not on the picture (the self-test's features/01-photo)
    const card = shape("card", [80, 200, 560, 330], solid("FFFFFF"), 1, { geometry: "roundRect", radiusPx: 20 });
    expect(find([photo(), card, text("카드 위 글자", { x: 120, y: 300, w: 480, color: "111A2E" })])).toEqual([]);
    // … but a line box that pokes into the card's rounded corner shows the bare picture there
    const corner = one([photo(), card, text("모서리까지", { x: 82, y: 202, w: 300, color: "111A2E" })]);
    expect(corner).toMatchObject({ ratio: 1, partly: true });
    // an opaque marker circle holding a digit (a callout on a capture) hides it; a wider label sticks out of the circle
    const marker = shape("marker", [100, 100, 40, 40], solid("2A52D9"), 1, { geometry: "ellipse" });
    const digit = (l: number, r: number) => text("1", { lines: [{ top: 108, bottom: 132, left: l, right: r, text: "1", paragraph: 0, hardBreak: false }], size: 18, weight: 700 });
    expect(find([photo(), marker, digit(115, 125)])).toEqual([]);
    expect(one([photo(), marker, digit(98, 142)]).partly).toBe(true);
    // a rotated scrim covers what its rotated box covers: a diamond around the line passes, a line through its tip fails
    const diamond = shape("diamond", [300, 200, 300, 300], solid(CLASSIC_950), 1, { rotationDeg: 45 });
    expect(find([photo(), diamond, text("다이아몬드 안", { x: 380, y: 330, w: 140 })])).toEqual([]);
    expect(one([photo(), diamond, text("다이아몬드 끝", { x: 520, y: 330, w: 200 })]).ratio).toBe(1);

    // a photo slot is a picture: whatever photo the user inserts later
    const onSlot = one([slot(), text("사진 칸 위 제목")]);
    expect(onSlot.ratio).toBe(1);
    expect(T.tpcMessage(onSlot)).toContain('is painted on the photo slot #hero (any photo the user inserts) at a worst-case contrast of 1:1');
    expect(find([slot(), scrim(0.72), text("사진 칸 위 제목")])).toEqual([]);
    // … inserted OPAQUE, whatever the slot's CSS opacity (PowerPoint's placeholder carries no alpha): on a dark slide a
    // slot at 0.3 still puts a white photo pixel behind white text, while an <img> at 0.3 stays faded in PowerPoint too
    const dark = solid(CLASSIC_950);
    const faintSlot = T.tpcFindings([slot({ opacity: 0.3 }), text("흐린 사진 칸 위", { size: 16 })], dark);
    expect(faintSlot.map((f) => [f.ratio, f.need, f.through])).toEqual([[1, 4.5, 1]]);
    expect(T.tpcFindings([photo({ opacity: 0.3 }), text("흐린 사진 위", { size: 16 })], dark)).toEqual([]);
    expect(find([slot({ opacity: 0.3 }), text("밝은 슬라이드의 흐린 칸 위", { size: 16 })])).toHaveLength(1);
    // an inline <svg> is an icon, not a picture; the same box as an <img> is one
    expect(find([photo({ _src: { localName: "svg" } }), text("아이콘 위 글자")])).toEqual([]);
    expect(find([photo({ _src: { localName: "img" } }), text("그림 위 글자")])).toHaveLength(1);
    // paint order: text painted BEFORE the picture is under it, not on it; text beside a picture or 1 px into it is not on it
    expect(find([text("사진 아래 글자"), photo()])).toEqual([]);
    expect(find([photo({ box: { x: 0, y: 0, w: 640, h: 720 } }), text("사진 옆 글자", { x: 720, w: 400 })])).toEqual([]);
    expect(find([photo({ box: { x: 0, y: 0, w: 81, h: 720 } }), text("1 px 걸친 글자", { x: 80, w: 400 })])).toEqual([]);
    // a text-only slide is never examined: nothing here fires because a slide HAS no picture
    expect(find([text("글자만 있는 슬라이드", { color: "111A2E" })])).toEqual([]);
    expect(T.tpcFindings([], null)).toEqual([]);

    // large text needs 3:1: every run ≥ 24 px, or ≥ 18.66 px at weight ≥ 700 (a 0.5 scrim gives 3.46:1)
    const r50 = whiteOn(CLASSIC_950, 0.5);
    expect(r50).toBeGreaterThan(3);
    expect(r50).toBeLessThan(4.5);
    const at50 = (o: TextOpts) => find([photo(), scrim(0.5), text("글자 크기", o)]);
    expect(at50({ size: 24 })).toEqual([]);
    expect(at50({ size: 18.66, weight: 700 })).toEqual([]);
    expect(at50({ size: 16 })).toMatchObject([{ need: 4.5, large: false }]);
    expect(at50({ size: 18.66, weight: 600 })).toMatchObject([{ need: 4.5, large: false }]);
    expect(at50({ size: 23, weight: 400 })).toMatchObject([{ need: 4.5, large: false }]);
    expect(at50({ runs: [{ text: "큰 ", sizePx: 24, fontWeight: 800, color: "FFFFFF", alpha: 1 }, { text: "작은", sizePx: 16, fontWeight: 400, color: "FFFFFF", alpha: 1 }] }))
      .toMatchObject([{ need: 4.5, large: false }]); // every run: one small run makes the whole text small
    const bigThin = one([photo(), scrim(0.3), text("큰 제목", { size: 56, weight: 800 })]);
    expect(bigThin).toMatchObject({ need: 3, large: true });
    expect(T.tpcMessage(bigThin)).toContain(", below the 3:1 large text needs — ");

    // translucent text is blended over the composite first: white 72 % on a forest brand-950 scrim at 0.72
    const worstTranslucent = Math.min(...[BLACK, WHITE].map((base) => {
      const C = over(rgb(FOREST_950), 0.72, base);
      return cr(over(WHITE, 0.72, C), C);
    }));
    expect(worstTranslucent).toBeGreaterThan(4.3);
    expect(worstTranslucent).toBeLessThan(4.5);
    const tr = one([photo(), scrim(0.72, FOREST_950), text("반투명 글자", { alpha: 0.72 })]);
    expect(tr.ratio).toBeCloseTo(worstTranslucent, 3);
    expect(tr.textAlpha).toBeCloseTo(0.72, 6);
    expect(T.tpcMessage(tr)).toContain("still lets 28 % of the picture through at the weakest point, and the text colour itself is translucent (alpha 0.72).");
    expect(find([photo(), scrim(0.72, FOREST_950), text("불투명 글자")])).toEqual([]); // opaque white: 6.63:1
    expect(find([photo(), scrim(0.72, FOREST_950), text("큰 반투명 글자", { alpha: 0.72, size: 28 })])).toEqual([]); // large: 3:1
    // the element's own opacity (the IR product of its ancestors') fades its text the same way
    expect(one([photo(), scrim(0.72, FOREST_950), text("흐린 요소", { opacity: 0.72 })]).ratio).toBeCloseTo(worstTranslucent, 3);
    // translucent text is judged over the whole box of reachable composites (each channel on its own between lo and
    // hi), not only along the grey diagonal — under a coloured layer the diagonal misses worse pixels, for grey and
    // coloured text alike; a brute-force search of the box agrees with the per-channel search
    const boxSearch = (tc: number[], a: number, lo: number[], hi: number[], n = 32) => {
      let w = Infinity, lighter = false, darker = false;
      for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) for (let k = 0; k <= n; k++) {
        const C = [lo[0] + ((hi[0] - lo[0]) * i) / n, lo[1] + ((hi[1] - lo[1]) * j) / n, lo[2] + ((hi[2] - lo[2]) * k) / n];
        const tp = over(tc, a, C);
        if (lum(tp) > lum(C)) lighter = true; else if (lum(tp) < lum(C)) darker = true;
        w = Math.min(w, cr(tp, C));
      }
      return lighter && darker ? 1 : w;
    };
    const diagonalSearch = (tc: number[], a: number, lo: number[], hi: number[], n = 64) =>
      Math.min(...Array.from({ length: n + 1 }, (_, i) => { const C = lo.map((v, k) => v + ((hi[k] - v) * i) / n); return cr(over(tc, a, C), C); }));
    const tinted = (c: number[], a: number) => [c.map((v) => v * a), c.map((v) => v * a + 1 - a)]; // [lo, hi] under a layer
    for (const [tc, a, [lo, hi]] of [
      [[0.767, 0.767, 0.767], 0.309, [[0.547, 0.031, 0.137], [0.762, 0.246, 0.351]]], // grey text, red-tinted composite
      [[1, 1, 1], 0.333, tinted([0.792, 0.014, 0.693], 0.723)], // white text under a magenta layer
      [[0.033, 0.879, 0.874], 0.54, [[0.745, 0.024, 0.019], [0.95, 0.228, 0.223]]], // cyan text, red composite
    ] as [number[], number, number[][]][]) {
      const exact = T.tpcWorstRatio(tc, a, lo, hi), brute = boxSearch(tc, a, lo, hi);
      expect(exact).toBeLessThanOrEqual(brute + 1e-9);
      expect(exact).toBeGreaterThan(brute - 0.01);
      expect(exact).toBeLessThan(diagonalSearch(tc, a, lo, hi) - 0.05);
    }
    // opaque text stays exact, and a text colour between the two ends is 1:1 (translucent or not)
    expect(T.tpcWorstRatio([1, 1, 1], 1, rgb(CLASSIC_950).map((v) => v * 0.72), over(rgb(CLASSIC_950), 0.72, WHITE))).toBeCloseTo(whiteOn(CLASSIC_950, 0.72), 9);
    expect(T.tpcWorstRatio([0.5, 0.5, 0.5], 0.6, [0, 0, 0], [1, 1, 1])).toBe(1);
    // the 256-step grid is lowered by a bound of what it can miss: never above a 4096-step search of the same box, and
    // below it by at most about 0.03 %
    const fineWorst = (tc: number[], a: number, lo: number[], hi: number[], n = 4096) => {
      const W = [0.2126, 0.7152, 0.0722];
      const grid = [0, 1, 2].map((k) => Array.from({ length: n + 1 }, (_, i) => {
        const c = lo[k] + ((hi[k] - lo[k]) * i) / n;
        return { c: W[k] * lin(c), t: W[k] * lin(a * tc[k] + (1 - a) * c) };
      }));
      const lighter = grid.reduce((s, g) => s + Math.min(...g.map((p) => p.t - p.c)), 0) > 0;
      const num = (p: { c: number; t: number }) => (lighter ? p.t : p.c), den = (p: { c: number; t: number }) => (lighter ? p.c : p.t);
      let lam = Infinity;
      for (let next = (0.05 + grid.reduce((s, g) => s + num(g[0]), 0)) / (0.05 + grid.reduce((s, g) => s + den(g[0]), 0)); next < lam - 1e-13;) {
        lam = next;
        const pick = grid.map((g) => g.reduce((b, p) => (num(p) - lam * den(p) < num(b) - lam * den(b) ? p : b)));
        next = (0.05 + pick.reduce((s, p) => s + num(p), 0)) / (0.05 + pick.reduce((s, p) => s + den(p), 0));
      }
      return lam;
    };
    for (const [tc, a, lo, hi] of [
      [[1, 1, 1], 0.8, rgb(FOREST_950).map((v) => v * 0.72), over(rgb(FOREST_950), 0.72, WHITE)], // the kit's 80 % white on forest's scrim
      [[1, 0.9, 0.6], 0.55, [0.31, 0.12, 0.05], [0.62, 0.4, 0.33]], // interior optimum: yellowish text over a warm box
      [[0.05, 0.1, 0.3], 0.7, [0.55, 0.6, 0.62], [0.95, 0.97, 0.99]], // darker text over a light box
      // optima between grid values: the bare 256-step grid reads above the 4096-step search here (by ~2·10⁻⁶)
      [[0.389, 0.186, 0.444], 0.795, [0.075, 0.399, 0.509], [0.861, 0.757, 0.962]],
      [[0.763, 0.42, 0.09], 0.636, [0.207, 0.559, 0.093], [0.932, 0.9, 0.576]],
    ] as [number[], number, number[], number[]][]) {
      const exact = T.tpcWorstRatio(tc, a, lo, hi), fine = fineWorst(tc, a, lo, hi);
      expect(exact).toBeLessThanOrEqual(fine + 1e-12);
      expect(exact).toBeGreaterThan(fine * (1 - 3e-4));
    }
    // the cheap bound used past the work limit is never above the search, and exact for opaque text
    // mulberry32: its 32-bit state stays exact (an LCG multiplied in doubles loses bits past 2^53)
    const rnd = ((a: number) => () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    })(20261003);
    for (let i = 0; i < 200; i++) {
      const lo = [rnd(), rnd(), rnd()].map((v) => v * 0.6), hi = lo.map((v) => v + rnd() * (1 - v));
      const tc = [rnd(), rnd(), rnd()], a = i % 4 ? 0.3 + 0.7 * rnd() : 1;
      const exact = T.tpcWorstRatio(tc, a, lo, hi), bound = T.tpcBoundRatio(tc, a, lo, hi);
      expect(bound).toBeLessThanOrEqual(exact + 1e-9);
      if (a === 1) expect(bound).toBeCloseTo(exact, 12);
    }

    // NEVER more lenient than the exact worst case: random layer stacks over a photo (solid, single-hue and two-hue
    // ramps, across the slide), against an independent point model — 201 positions along the line, each with the
    // photo's corners (opaque text) or a 6-step grid of photo colours (translucent text). A text the lint passes, the
    // model passes; a text it fails, it fails at no more than the model's worst
    type Fill = { type: string; color?: string; alpha?: number; angleDeg?: number; stops?: { pos: number; color: string; alpha: number }[] };
    const fillAt = (f: Fill, t: number) => {
      if (f.type === "solid") return { pm: rgb(f.color!).map((v) => v * (f.alpha ?? 1)), a: f.alpha ?? 1 };
      const [s0, s1] = f.stops!;
      const pm = rgb(s0.color).map((v, k) => v * s0.alpha + (rgb(s1.color)[k] * s1.alpha - v * s0.alpha) * t);
      return { pm, a: s0.alpha + (s1.alpha - s0.alpha) * t };
    };
    const hex = (c: number[]) => c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
    for (let i = 0; i < 40; i++) {
      const dark = i % 2 === 0;
      const tone = () => hex([rnd(), rnd(), rnd()].map((v) => (dark ? v * 0.3 : 0.7 + v * 0.3)));
      const layers = Array.from({ length: 1 + (i % 2) }, (_, j) => {
        const kind = (i + j) % 3, c0 = tone();
        const f: Fill = kind === 0 ? solid(c0, 0.4 + 0.6 * rnd()) // kind 1: a single-hue ramp, kind 2: two hues
          : { type: "linear", angleDeg: 90, stops: [{ pos: 0, color: c0, alpha: 0.3 + 0.7 * rnd() }, { pos: 1, color: kind === 1 ? c0 : tone(), alpha: 0.3 + 0.7 * rnd() }] };
        return { f, o: 0.5 + 0.5 * rnd() };
      });
      const tc = dark ? "FFFFFF" : "111A2E", a = i % 3 ? 1 : 0.6 + 0.4 * rnd();
      const els = [photo(), ...layers.map((L, j) => shape(`l${j}`, [0, 0, 1280, 720], L.f, L.o)), text("임의의 막", { x: 80, w: 1120, color: tc, alpha: a })];
      const T0 = rgb(tc);
      let model = Infinity;
      for (let p = 0; p <= 200; p++) {
        const t = (80 + (1120 * p) / 200) / 1280;
        const at = (P: number[]) => layers.reduce((C, L) => { const { pm, a: fa } = fillAt(L.f, t); return C.map((c, k) => pm[k] * L.o + c * (1 - fa * L.o)); }, P);
        const pixels = a === 1 ? [[0, 0, 0], [1, 1, 1]] : Array.from({ length: 216 }, (_, q) => [q % 6, Math.floor(q / 6) % 6, Math.floor(q / 36)].map((v) => v / 5));
        let lighter = false, darker = false, w = Infinity;
        for (const P of pixels) {
          const C = at(P), tp = over(T0, a, C);
          if (lum(tp) > lum(C)) lighter = true; else darker = true;
          w = Math.min(w, cr(tp, C));
        }
        if (a === 1 && lighter && darker) w = 1; // the text's luminance lies between the photo's two ends
        model = Math.min(model, w);
      }
      const f = find(els);
      if (!f.length) expect(model, `scene ${i}`).toBeGreaterThanOrEqual(4.5 - 1e-9);
      else expect(f[0].ratio, `scene ${i}`).toBeLessThanOrEqual(model + 1e-9);
    }

    // the work bound: past it, only bounds that are never more lenient — a piece cut no further, one box per piece,
    // translucent text against the box's corners — and the message says so. A tiny budget forces it here: 80 % white
    // text on forest's 0.72 scrim passes the exact search (4.95:1) but not the corner bound
    const tpcTextOf = (el: El) => ((el.paragraphs as { runs: { text: string }[] }[])[0].runs[0].text);
    const tpcSource = ["00-util.js", "55-text-on-picture.js"].map((f) => fs.readFileSync(path.join(KIT, "tools", "extract", "inpage", f), "utf8")).join("\n");
    const tight = (...edits: [string | RegExp, string][]) => {
      let src = tpcSource;
      for (const [from, to] of edits) {
        expect(src).toMatch(from);
        src = src.replace(from, to);
      }
      return new Function(`${src}\nreturn { tpcFindings, tpcMessage };`)() as { tpcFindings: typeof T.tpcFindings; tpcMessage: typeof T.tpcMessage };
    };
    const scrimmed = [photo(), scrim(0.72, FOREST_950), text("막 위 반투명 글자", { alpha: 0.8 })];
    expect(find(scrimmed)).toEqual([]);
    const NO_ELEMENT_WORK: [string, string] = ["const TPC_ELEMENT_WORK = 2 ** 19;", "const TPC_ELEMENT_WORK = 0;"];
    const perElement = tight(NO_ELEMENT_WORK);
    const forced = perElement.tpcFindings(scrimmed, solid("F4F6FA"));
    expect(forced).toMatchObject([{ bounded: true, boundBy: "element", need: 4.5 }]);
    expect(forced[0].ratio).toBeLessThan(4.95);
    expect(perElement.tpcMessage(forced[0])).toContain(":1 or better (a safe bound, not the exact value: too many shapes overlap this text to search exactly — merge or remove the translucent shapes under it, or give it one plain scrim, and the check measures it exactly), below the 4.5:1");
    expect(perElement.tpcFindings(scrimmed, solid("F4F6FA"))).toEqual(forced); // deterministic: counted work, not time
    // a text the exact search fails keeps failing, at no more than its exact ratio; opaque text stays exact on one box
    const weak = [photo(), scrim(0.5, FOREST_950), text("약한 막 위 글자", { alpha: 0.8 })];
    expect(perElement.tpcFindings(weak, solid("F4F6FA"))[0].ratio).toBeLessThanOrEqual(one(weak).ratio + 1e-9);
    const opaqueOnScrim = [photo(), scrim(0.5), text("불투명 글자")];
    expect(perElement.tpcFindings(opaqueOnScrim, solid("F4F6FA"))[0].ratio).toBeCloseTo(one(opaqueOnScrim).ratio, 12);
    // … a ramp that would be cut into slabs is judged by one box (stricter), and the slide's budget caps all elements
    const coarseDip = perElement.tpcFindings([photo(), hue, text("색이 바뀌는 막", { x: 80, w: 1120, size: 56, weight: 800, color: "000000" })], solid("F4F6FA"));
    expect(coarseDip[0]).toMatchObject({ bounded: true });
    expect(coarseDip[0].ratio).toBeLessThanOrEqual(dip.ratio + 1e-9);
    // the slide's budget is spent in paint order, but each text keeps its first 2^10 units: a caption painted after
    // texts that used the slide's budget up is still searched exactly. The innocent caption — AUTHORING §7's recipe,
    // 80 % white on forest's brand-950 at 0.72, the photo and one scrim under it — passes even with no slide budget
    // left at all, and after a first text that used all 60 units (a walk 3, a box 3, a translucent search 48)
    const perSlide = tight(["const TPC_SLIDE_WORK = 2 ** 20;", "const TPC_SLIDE_WORK = 0;"]);
    expect(perSlide.tpcFindings(scrimmed, solid("F4F6FA"))).toEqual([]);
    const busySlide = tight(["const TPC_SLIDE_WORK = 2 ** 20;", "const TPC_SLIDE_WORK = 60;"]);
    const caption = [photo(), scrim(0.72, FOREST_950), text("첫째 글자", { alpha: 0.8 }), text("사진 설명", { alpha: 0.8, y: 400 })];
    expect(busySlide.tpcFindings(caption, solid("F4F6FA"))).toEqual([]);
    // … searched exactly, not just passed: on a weaker scrim the same two captions fail at their exact ratios, unbounded
    const weakCaption = [photo(), scrim(0.5, FOREST_950), text("첫째 글자", { alpha: 0.8 }), text("사진 설명", { alpha: 0.8, y: 400 })];
    const exactRatios = find(weakCaption).map((f) => [f.ratio, false]);
    expect(exactRatios).toHaveLength(2);
    expect(busySlide.tpcFindings(weakCaption, solid("F4F6FA")).map((f) => [f.ratio, f.bounded])).toEqual(exactRatios);
    // a text heavier than its floor (30 lines over a 0.74 → 0.72 ramp: a new box on every line, so no search repeats)
    // after the first text used the slide's budget takes the corner bound past its floor (about 4.3:1 near 0.72,
    // where the search reads 4.95:1), and the message says why
    const ramp = shape("ramp", [0, 0, 1280, 720], { type: "linear", angleDeg: 180, stops: [{ pos: 0, color: FOREST_950, alpha: 0.74 }, { pos: 1, color: FOREST_950, alpha: 0.72 }] });
    const tall = text("", {
      runs: [{ text: "긴 본문", sizePx: 16, fontWeight: 400, color: "FFFFFF", alpha: 0.8 }],
      lines: Array.from({ length: 30 }, (_, i) => ({ top: i * 24, bottom: i * 24 + 20, left: 80, right: 600, text: "긴 본문", paragraph: 0, hardBreak: false })),
    });
    const heavyAfter = [photo(), ramp, text("첫째 글자", { alpha: 0.8 }), tall];
    expect(find(heavyAfter)).toEqual([]); // the exact search passes both
    const late = busySlide.tpcFindings(heavyAfter, solid("F4F6FA"));
    expect(late).toMatchObject([{ bounded: true, boundBy: "slide" }]);
    expect(busySlide.tpcMessage(late[0])).toContain("or better (a safe bound, not the exact value: the texts painted before this one used up the slide's search budget — merge or remove the translucent shapes under the texts on this slide, or give them plain scrims, and the check measures this one exactly), below the 4.5:1");
    // the slide's budget is one budget for all its texts: with 2,000 units the first 30-line text (about 1,620) is
    // searched exactly, and the second gets only its floor before the bound
    const twoTall = tight(["const TPC_SLIDE_WORK = 2 ** 20;", "const TPC_SLIDE_WORK = 2000;"]).tpcFindings([photo(), ramp, tall, { ...tall, id: "main.slide > p.second:nth-child(4)::text" }], solid("F4F6FA"));
    expect(twoTall.map((f) => [f.el.id, f.boundBy])).toEqual([["main.slide > p.second:nth-child(4)::text", "slide"]]);
    // past the bound a curved edge is followed no further: the circle may or may not cover any part of the piece it
    // crosses (opaque text over a 0.6 scrim circle that the line pokes out of fails either way; only the exact walk
    // knows it exactly) — while an axis-aligned edge still cuts, so a line running off the slide where the photo and
    // its scrim both end is no 1:1
    const coarseOnly = tight(NO_ELEMENT_WORK, [/spent\(\) \{ return [^}]*\}/, "spent() { return false; }"]);
    const ring = shape("ring", [60, 260, 200, 200], solid(CLASSIC_950), 0.6, { geometry: "ellipse" });
    const poke = [photo(), ring, text("원 밖으로", { x: 120, y: 330, w: 200 })];
    expect(one(poke)).toMatchObject({ ratio: 1, bounded: false });
    expect(coarseOnly.tpcFindings(poke, solid("F4F6FA"))).toMatchObject([{ ratio: 1, bounded: true }]);
    const offSlide = [photo(), scrim(0.72), text("슬라이드 밖으로", { y: 710 })]; // line box 710–734, the slide ends at 720
    expect(find(offSlide)).toEqual([]);
    expect(coarseOnly.tpcFindings(offSlide, solid("F4F6FA"))).toEqual([]);
    // … and twice past the bound the rest of a line is one piece: the photo and its scrim may each be absent there —
    // never within a text's floor, whatever the slide has left
    expect(perElement.tpcFindings(offSlide, solid("F4F6FA"))).toMatchObject([{ ratio: 1, bounded: true }]);
    expect(perSlide.tpcFindings(offSlide, solid("F4F6FA"))).toEqual([]);

    // the lint: the extractor raises it on the painted slide, as an error, and the Next: line points at AUTHORING §7
    const src = (f: string) => fs.readFileSync(path.join(KIT, "tools", "extract", "inpage", f), "utf8");
    expect(src("55-text-on-picture.js")).toContain("lint('error', 'text-on-picture', tpcMessage(f), f.el._src || f.el.id)");
    expect(src("90-main.js")).toContain("textOnPictureLint(OUT.elements, OUT.background, { w: CTX.slideW, h: CTX.slideH });");
    expect(src("90-main.js").indexOf("numberPicSlots(OUT.elements);")).toBeLessThan(src("90-main.js").indexOf("textOnPictureLint("));
    const R = await import(pathToFileURL(path.join(KIT, "tools", "lib", "report.mjs")).href);
    expect(R.NEXT.authoring("/w/q3", { rules: ["text-on-picture"] })).toContain("; text-on-picture: §7)");
    for (const doc of [path.join(KIT, "docs", "CONTRACT.md"), path.join(KIT, "tools", "extract", "README.md")]) {
      expect(fs.readFileSync(doc, "utf8"), doc).toContain("`text-on-picture`");
    }
    expect(fs.readFileSync(path.join(KIT, "docs", "CONTRACT.md"), "utf8")).toContain("1.3.0 narrows the input contract with ONE error lint, **`text-on-picture`**");
  });

  type ChartField = { path: string; get: () => unknown; set: (v: unknown) => void };
  type ChartToken = { value: string; hex: string | null };
  const chartTokens = () => inpage<{
    CHART_COLOR_FIELDS: string[];
    chartTokenRef: (v: unknown) => string | null;
    chartColorFields: (spec: unknown) => ChartField[];
    resolveChartTokens: (spec: unknown, lookup: (name: string) => ChartToken) => string[];
  }>(["CHART_COLOR_FIELDS", "chartTokenRef", "chartColorFields", "resolveChartTokens"], ["00-util.js", "20-text.js", "40-shapes.js"]);

  it("chart theme tokens: var(--name) without a fallback; the walker covers every colour field chart.py reads, exactly as lib/chart.js does", () => {
    const H = chartTokens();
    expect(H.chartTokenRef("var(--c-series-curr)")).toBe("--c-series-curr");
    expect(H.chartTokenRef("  var( --c-ink_500 )  ")).toBe("--c-ink_500");
    for (const v of ["var(--c-x, #FFFFFF)", "var(c-x)", "var(--c-x) var(--c-y)", "VAR(--c-x)", "2A52D9", "#2A52D9", "", null, 42]) {
      expect(H.chartTokenRef(v), String(v)).toBeNull();
    }
    // every colour field, in list order, under the path its error names (the value axis labels use labelColor)
    const full = () => ({
      type: "column", categories: ["1Q", "2Q"],
      series: [{ name: "A", values: [1, 2], color: "col:s0" }, { name: "B", values: [3, 4], color: "col:s1" }],
      pointColors: { "0": ["col:p00", "col:p01"], "1": ["col:p10"] },
      dataLabels: { show: true, numberFormat: "#,##0", color: "col:dl" },
      valueAxis: { visible: false, gridlines: { color: "col:grid", widthPx: 1 } },
      categoryAxis: { visible: true, labelColor: "col:label", lineColor: "col:line" },
      legend: { position: "top", color: "col:legend" },
    });
    const fields = H.chartColorFields(full());
    expect(fields.map((f) => [f.path, f.get()])).toEqual([
      ["series[0].color", "col:s0"], ["series[1].color", "col:s1"],
      ['pointColors["0"][0]', "col:p00"], ['pointColors["0"][1]', "col:p01"], ['pointColors["1"][0]', "col:p10"],
      ["dataLabels.color", "col:dl"], ["valueAxis.gridlines.color", "col:grid"],
      ["categoryAxis.labelColor", "col:label"], ["categoryAxis.lineColor", "col:line"], ["legend.color", "col:legend"],
    ]);
    expect(JSON.stringify(full()).match(/col:/g)).toHaveLength(fields.length); // ...and nothing else
    // absent or mistyped branches are skipped, never thrown on
    expect(H.chartColorFields({ series: "x", pointColors: ["y"], valueAxis: { gridlines: true }, legend: null })).toEqual([]);
    expect(H.chartColorFields(null)).toEqual([]);

    // lib/chart.js resolves the same fields for the in-page preview: the same list, walked the same way
    type Holder = Record<string | number, unknown>;
    const mod = { exports: {} as { COLOR_FIELDS: string[]; colorFields: (spec: unknown, visit: (holder: Holder, key: string | number) => void) => void; tokenRef: (v: unknown) => string | null } };
    new Function("module", fs.readFileSync(path.join(KIT, "lib", "chart.js"), "utf8"))(mod);
    const C = mod.exports;
    expect(C.COLOR_FIELDS).toEqual(H.CHART_COLOR_FIELDS);
    const a = full();
    const b = full();
    for (const f of H.chartColorFields(a)) f.set(`seen:${f.get()}`);
    C.colorFields(b, (holder, key) => { holder[key] = `seen:${holder[key]}`; });
    expect(b).toEqual(a);
    for (const v of ["var(--c-x)", " var( --c-x ) ", "var(--c-x, #fff)", "VAR(--c-x)", "2A52D9", null]) expect(C.tokenRef(v), String(v)).toBe(H.chartTokenRef(v));
  });

  it("chart theme tokens: resolved in place to RRGGBB; each field that does not resolve is one chart-spec message; a hex spec is untouched", () => {
    const H = chartTokens();
    const spec = {
      type: "column", categories: ["1Q", "2Q"],
      series: [{ name: "A", values: [1, 2], color: "var(--c-series-curr)" }, { name: "B", values: [3, 4], color: "8A94A6" }],
      pointColors: { "0": [" var( --c-series-fcst ) ", "#6F8FF0"] },
      dataLabels: { show: true, color: "var(--c-seris-curr)" },
      valueAxis: { gridlines: { color: "var(--c-cover-fcst)", widthPx: 1 } },
      categoryAxis: { labelColor: "var(--c-ink-500, #667085)", lineColor: "var(--c-ink-300)" },
      legend: { position: "top", color: "var(--c-gap)" },
    };
    const TOKENS: Record<string, ChartToken> = {
      "--c-series-curr": { value: "#123456", hex: "123456" },
      "--c-series-fcst": { value: "#6f8ff0", hex: "6F8FF0" },
      "--c-ink-300": { value: "#C9D0DB", hex: "C9D0DB" },
      "--c-cover-fcst": { value: "rgba(111, 143, 240, 0.55)", hex: null },
      "--c-gap": { value: "12px", hex: null },
    };
    const asked: string[] = [];
    const problems = H.resolveChartTokens(spec, (name) => {
      asked.push(name);
      return TOKENS[name] ?? { value: "", hex: null };
    });
    expect(spec.series.map((s) => s.color)).toEqual(["123456", "8A94A6"]);
    expect(spec.pointColors["0"]).toEqual(["6F8FF0", "#6F8FF0"]);
    expect(spec.categoryAxis.lineColor).toBe("C9D0DB");
    // a field that does not resolve keeps its text (the error blocks the build)
    expect([spec.dataLabels.color, spec.valueAxis.gridlines.color, spec.categoryAxis.labelColor, spec.legend.color])
      .toEqual(["var(--c-seris-curr)", "var(--c-cover-fcst)", "var(--c-ink-500, #667085)", "var(--c-gap)"]);
    expect(problems).toEqual([
      "dataLabels.color: var(--c-seris-curr) is not defined for this chart — define it in deck.css or use a theme token",
      "valueAxis.gridlines.color: var(--c-cover-fcst) must resolve to an opaque colour (got rgba(111, 143, 240, 0.55))",
      "categoryAxis.labelColor: var(--c-ink-500, #667085) is not a colour token — write exactly var(--token-name), without a fallback, or a literal RRGGBB",
      "legend.color: var(--c-gap) must resolve to an opaque colour (got 12px)",
    ]);
    expect(asked).toEqual(["--c-series-curr", "--c-series-fcst", "--c-seris-curr", "--c-cover-fcst", "--c-ink-300", "--c-gap"]);
    // a spec without references — the frozen self-test deck's chart — is untouched byte for byte, and never looked up
    const golden = JSON.parse(fs.readFileSync(path.join(KIT, "selftest", "golden", "deck.embedded.ir.json"), "utf8"));
    const chart = golden.slides.flatMap((s: { elements: { kind: string }[] }) => s.elements).find((e: { kind: string }) => e.kind === "chart");
    const before = JSON.stringify(chart.spec);
    expect(H.resolveChartTokens(chart.spec, () => { throw new Error("looked up"); })).toEqual([]);
    expect(JSON.stringify(chart.spec)).toBe(before);
  });

  it("theme-link: a slide of a deck with deck.css that does not apply ../deck.css after ../theme/base.css warns (a static scan of its links)", async () => {
    const D = await import(pathToFileURL(path.join(KIT, "tools", "lib", "deckfs.mjs")).href);
    const link = (href: string, extra = "") => `<link rel="stylesheet" href="${href}"${extra}>`;
    const kit = link("../theme/base.css") + link("../theme/fonts.css");
    // what the HTML parser applies: rel tokens and attribute names case-insensitive, unquoted values, entities
    expect(D.linkedStylesheets(`${kit}<LINK REL="StyleSheet" HREF=../deck.css>`)).toEqual(["../theme/base.css", "../theme/fonts.css", "../deck.css"]);
    expect(D.linkedStylesheets(`<link href=' ../deck.css ' rel="preload stylesheet"/>`)).toEqual(["../deck.css"]);
    expect(D.linkedStylesheets(`<link rel="stylesheet" href="..&#47;deck&period;css">`)).toEqual(["../deck.css"]);
    expect(D.linkedStylesheets(`<link rel="stylesheet" href="../deck.css" href="../x.css" media="screen" type="text/css">`)).toEqual(["../deck.css"]);
    // ...and what it never applies: comments, inert content, alternate / disabled / print / non-CSS links
    for (const html of [
      `<!-- ${link("../deck.css")} -->`, `<template id="notes">${link("../deck.css")}</template>`,
      `<script type="text/x-notes">${link("../deck.css")}</script>`, `<noscript>${link("../deck.css")}</noscript>`,
      `<textarea>${link("../deck.css")}</textarea>`, `<title>${link("../deck.css")}</title>`,
      link("../deck.css", ' rel="alternate stylesheet"').replace('rel="stylesheet" ', ""), link("../deck.css", " disabled"),
      link("../deck.css", ' media="print"'), link("../deck.css", ' type="text/less"'), `<link rel="preload" href="../deck.css">`,
      `<!-- unclosed ${link("../deck.css")}`, `<p title="unclosed ${link("../deck.css")}`, `<div data-x='${link("../deck.css")}'></div>`,
    ]) {
      expect(D.linkedStylesheets(html), html).toEqual([]);
    }
    expect(D.linkedStylesheets(`<script>if (a<b) x = "</p>";</script >${link("../deck.css")}`)).toEqual(["../deck.css"]);
    // linear in the input: a pathological slide cannot stall deck.mjs's event loop (a regex scan would be quadratic)
    const t0 = Date.now();
    expect(D.linkedStylesheets(`<a "${"<b x ".repeat(200_000)}`)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(2_000);

    const root = tmp("themelink");
    const head = (links: string) => SLIDE("<p>x</p>").replace('<link rel="stylesheet" href="../theme/base.css">\n<link rel="stylesheet" href="../theme/fonts.css">', links);
    const d = makeDeck(root, "tl", {
      "01-ok.html": head(kit + link("../deck.css")),
      "02-missing.html": head(kit),
      "03-first.html": head(link("../deck.css") + kit),
      "04-twice.html": head(link("../deck.css") + kit + link("../deck.css")),
      "05-commented.html": head(`${kit}<!-- ${link("../deck.css")} -->`),
    });
    const slides = D.listSlides(d).slides;
    expect(D.themeLinkLint(d, slides)).toEqual([]); // no deck.css: every slide shows the kit's theme by design
    fs.writeFileSync(path.join(d, "deck.css"), ":root { --c-brand-600: #0F766E; }\n");
    const lint = D.themeLinkLint(d, slides);
    expect(lint.map((l: { slide: number; message: string }) => [l.slide, l.message])).toEqual([
      [2, "this slide does not link ../deck.css, so it shows the kit's default theme, not the deck's: add <link rel=\"stylesheet\" href=\"../deck.css\"> after the ../theme/fonts.css link"],
      [3, "this slide links ../deck.css before ../theme/base.css, so the kit's default theme overrides the deck's: link ../deck.css last, after ../theme/base.css and ../theme/fonts.css"],
      [5, D.THEME_LINK_MISSING],
    ]);
    for (const l of lint) expect(l).toMatchObject({ profile: null, severity: "warn", rule: "theme-link", path: null });
    expect(D.themeLinkLint(d, slides.filter((s: { name: string }) => s.name === "01-ok"))).toEqual([]); // --only
    // documented wherever the lint vocabulary is listed
    expect(fs.readFileSync(path.join(KIT, "docs", "CONTRACT.md"), "utf8")).toContain("`theme-link`");
    expect(fs.readFileSync(path.join(KIT, "tools", "extract", "README.md"), "utf8")).toContain("`theme-link`");
  });

  it("locks: held names refuse a second holder, a SIGKILLed holder frees its slot, the slot wait times out", async () => {
    const L = await import(pathToFileURL(LOCKS).href);
    const ns = `t${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
    const a = await L.tryLock(L.slotName(ns, 0));
    expect(a).toBeTruthy();
    expect(await L.tryLock(L.slotName(ns, 0))).toBeNull();
    a.release();
    await new Promise((r) => setTimeout(r, 30));
    const again = await L.tryLock(L.slotName(ns, 0));
    expect(again).toBeTruthy();
    again.release();

    const src = `import(${JSON.stringify(pathToFileURL(LOCKS).href)}).then(async (L) => { const s = await L.acquireSlot({ max: 1, waitMs: 0, ns: ${JSON.stringify(ns)} }); process.stdout.write(s ? 'held ' + s.k + '\\n' : 'none\\n'); setInterval(() => {}, 1000); });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", src], { stdio: ["ignore", "pipe", "inherit"] });
    const first = await new Promise<string>((resolve) => child.stdout.once("data", (d) => resolve(String(d))));
    expect(first.trim()).toBe("held 0");
    const t0 = Date.now();
    expect(await L.acquireSlot({ max: 1, waitMs: 500, ns })).toBeNull();
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(450);
    expect(waited).toBeLessThan(1500);
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    const s = await L.acquireSlot({ max: 1, waitMs: 0, ns });
    expect(s).toBeTruthy();
    expect(s.k).toBe(0);
    s.release();
    // two slots: a second holder gets k = 1
    const s0 = await L.acquireSlot({ max: 2, waitMs: 0, ns });
    const s1 = await L.acquireSlot({ max: 2, waitMs: 0, ns });
    expect([s0.k, s1.k]).toEqual([0, 1]);
    // a cancelled run wakes up from its slot wait at once (and never takes a slot after the abort)
    const ac = new AbortController();
    const t1 = Date.now();
    const waiting = L.acquireSlot({ max: 2, waitMs: 30_000, ns, signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    expect(await waiting).toBeNull();
    expect(Date.now() - t1).toBeLessThan(2_000);
    s0.release();
    s1.release();
    await new Promise((r) => setTimeout(r, 30));
    expect(await L.acquireSlot({ max: 2, waitMs: 0, ns, signal: ac.signal })).toBeNull();
  });

  it("a second check/build of the same deck exits 5 before any toolchain use", async () => {
    const L = await import(pathToFileURL(LOCKS).href);
    const ns = `t${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
    const root = tmp("decklock");
    const d = makeDeck(root, "q3", { "01-a.html": SLIDE("<p>a</p>") });
    const held = await L.lockDeck({ deckRealpath: fs.realpathSync(d), ns });
    expect(held).toBeTruthy();
    try {
      const r = deck(["check", d], { NOAH_PPTX_LOCK_NAMESPACE: ns, NOAH_PPTX_CHROMIUM: "/nonexistent" });
      expect(r.code).toBe(5);
      expect(r.out).toMatch(/FAILED \(busy\): a check\/build of this deck is already running/);
      expect(r.out).toContain("Next: wait for that run to finish");
      // another deck is not blocked by it (it proceeds to the toolchain and stops there)
      const other = makeDeck(root, "other", { "01-a.html": SLIDE("<p>a</p>") });
      expect(deck(["check", other], { NOAH_PPTX_LOCK_NAMESPACE: ns, NOAH_PPTX_CHROMIUM: "/nonexistent" }).code).toBe(4);
    } finally {
      held.release();
    }
  });

  it("router: two roots, realpath containment, the 20 MB cap, CSP on every document, nothing else reachable", async () => {
    const S = await import(pathToFileURL(path.join(KIT, "tools", "extract", "server.mjs")).href);
    const root = tmp("router");
    const d = makeDeck(root, "q3", { "01-a.html": SLIDE("<p>a</p>") });
    fs.mkdirSync(path.join(d, "assets"));
    fs.writeFileSync(path.join(root, "outside.png"), "secret");
    fs.symlinkSync(path.join(root, "outside.png"), path.join(d, "assets", "link.png"));
    fs.writeFileSync(path.join(d, "assets", "ok.png"), "png");
    const big = path.join(d, "assets", "big.png");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 21 * 1024 * 1024);
    const events: { blocked: string[]; missing: string[]; tooLarge: string[] } = { blocked: [], missing: [], tooLarge: [] };
    const virtual = new Map([["__raster/0.html", "<p>raster</p>"]]);
    const router = S.makeRouter({
      kit: KIT, deck: d, profile: "malgun", virtual,
      events: { blocked: (u: string) => events.blocked.push(u), missing: (u: string) => events.missing.push(u), tooLarge: (u: string) => events.tooLarge.push(u) },
    });
    type Out = { kind: string; status?: number; headers?: Record<string, string>; body?: Buffer | string; contentType?: string };
    const call = async (url: string): Promise<Out> => {
      let out: Out = { kind: "none" };
      await router({
        request: () => ({ url: () => url }),
        fulfill: async (o: { status: number; headers?: Record<string, string>; body: Buffer | string; contentType: string }) => { out = { kind: "fulfill", ...o }; },
        abort: async () => { out = { kind: "abort" }; },
        continue: async () => { out = { kind: "continue" }; },
      });
      return out;
    };
    const slide = await call("http://deck.local/slides/01-a.html");
    expect(slide).toMatchObject({ kind: "fulfill", status: 200 });
    expect(slide.headers?.["content-security-policy"]).toBe(
      "default-src 'none'; script-src http://deck.local/lib/chart.js; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'",
    );
    const raster = await call("http://deck.local/__raster/0.html");
    expect(raster.headers?.["content-security-policy"]).toBe(
      "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'self'; form-action 'none'",
    );
    // theme/lib/fonts come from the toolkit; fonts.css is the profile's generated stylesheet
    const fonts = await call("http://deck.local/theme/fonts.css");
    expect(String(fonts.body)).toBe(fs.readFileSync(path.join(KIT, "theme", "fonts-malgun.css"), "utf8"));
    expect((await call("http://deck.local/lib/chart.js")).status).toBe(200);
    expect((await call("http://deck.local/assets/ok.png")).status).toBe(200);
    // escapes and foreign origins are aborted and reported; a missing file is a 404; a big one a 413
    expect((await call("http://deck.local/assets/link.png")).kind).toBe("abort");
    expect((await call("http://deck.local/..%2F..%2Foutside.png")).kind).toBe("abort"); // an encoded traversal
    expect((await call("http://deck.local/assets/%E0%A4%A.png")).kind).toBe("abort");
    expect((await call("http://127.0.0.1:9/x.png")).kind).toBe("abort");
    expect((await call("https://deck.local/slides/01-a.html")).kind).toBe("abort");
    expect(events.blocked).toHaveLength(5);
    expect((await call("http://deck.local/assets/nope.png")).status).toBe(404);
    expect(events.missing).toEqual(["http://deck.local/assets/nope.png"]);
    expect((await call("http://deck.local/assets/big.png")).status).toBe(413);
    expect(events.tooLarge).toEqual(["http://deck.local/assets/big.png"]);
    expect((await call("data:image/png;base64,iVBORw0KGgo=")).kind).toBe("continue");
    expect((await call("http://deck.local/favicon.ico")).status).toBe(204);
  });

  it("router: a picture is refused by its DECODED size before Chromium sees it (image-too-large), per picture and per page", async () => {
    const S = await import(pathToFileURL(path.join(KIT, "tools", "extract", "server.mjs")).href);
    const root = tmp("pixels");
    const d = makeDeck(root, "q3", { "01-a.html": SLIDE("<p>a</p>") });
    const a = path.join(d, "assets");
    fs.mkdirSync(a);
    fs.writeFileSync(path.join(a, "bomb.png"), pngHeader(12000, 12000)); // 144 MP in 33 bytes
    for (const f of ["p1.png", "p2.png", "p3.png"]) fs.writeFileSync(path.join(a, f), pngHeader(6000, 6000)); // 36 MP each
    fs.writeFileSync(path.join(a, "broken.png"), pngHeader(10, 10).subarray(0, 20));
    fs.writeFileSync(path.join(a, "ok.png"), pngHeader(400, 300));
    fs.writeFileSync(path.join(d, "deck.css"), `.x{background:url(data:image/png;base64,${pngHeader(12000, 12000).toString("base64")})}`);
    fs.writeFileSync(path.join(d, "slides", "02-b.html"), SLIDE(`<img src="data:image/png;base64,${pngHeader(9000, 9000).toString("base64")}">`));
    const events: { url: string; rel: string; message: string }[] = [];
    const page = () => S.makeRouter({ kit: KIT, deck: d, profile: "embedded", events: { imageTooLarge: (e: { url: string; rel: string; message: string }) => events.push(e) } });
    const call = async (router: (r: unknown) => Promise<void>, rel: string) => {
      let status = 0;
      await router({
        request: () => ({ url: () => `http://deck.local/${rel}` }),
        fulfill: async (o: { status: number }) => { status = o.status; },
        abort: async () => { status = -1; },
        continue: async () => { status = -2; },
      });
      return status;
    };
    const r1 = page();
    expect(await call(r1, "assets/bomb.png")).toBe(413);
    expect(events.at(-1)!.message).toBe("assets/bomb.png is 12000x12000 px (144.0 MP); a picture may have at most 40.0 MP — downscale it (the slide shows at most 2560 px of it)");
    expect(await call(r1, "assets/p1.png")).toBe(200);
    expect(await call(r1, "assets/p2.png")).toBe(200);
    expect(await call(r1, "assets/p1.png")).toBe(200); // the same picture twice counts once
    expect(await call(r1, "assets/p3.png")).toBe(413);
    expect(events.at(-1)!.message).toContain("assets/p3.png (36.0 MP) would bring this slide's pictures to 108.0 MP; the pictures of one slide may total at most 100.0 MP");
    expect(await call(r1, "assets/broken.png")).toBe(413);
    expect(events.at(-1)!.message).toContain("assets/broken.png is a PNG image whose pixel size cannot be read");
    expect(await call(r1, "assets/ok.png")).toBe(200);
    // base64 data: images inside a served stylesheet or slide are sized too (the whole text is refused)
    expect(await call(r1, "deck.css")).toBe(413);
    expect(events.at(-1)!.message).toContain("a base64 data: image in deck.css is 12000x12000 px (144.0 MP)");
    expect(await call(r1, "slides/02-b.html")).toBe(413);
    expect(events.at(-1)!.message).toContain("a base64 data: image in slides/02-b.html is 9000x9000 px (81.0 MP)");
    expect(await call(r1, "slides/01-a.html")).toBe(200);
    // the budget is per page: the next slide's page starts from zero; the toolkit is never sized
    const r2 = page();
    expect(await call(r2, "assets/p3.png")).toBe(200);
    expect(await call(r2, "fonts/Pretendard-Regular.ttf")).toBe(200);
    expect(await call(r2, "lib/chart.js")).toBe(200);
  });

  it("image headers: the pixel size of every raster format Chromium decodes, without decoding", async () => {
    const P = await import(pathToFileURL(path.join(KIT, "tools", "extract", "pixels.mjs")).href);
    const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
    const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
    const u24le = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
    const box = (type: string, ...p: Buffer[]) => { const body = Buffer.concat(p); return Buffer.concat([u32be(8 + body.length), Buffer.from(type, "latin1"), body]); };
    const fullBox = (type: string, ...p: Buffer[]) => box(type, Buffer.alloc(4), ...p);
    const riff = (chunk: string, data: Buffer) => Buffer.concat([Buffer.from("RIFF", "latin1"), u32le(4 + 8 + data.length), Buffer.from("WEBP", "latin1"), Buffer.from(chunk, "latin1"), u32le(data.length), data]);
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14), // APP0
      Buffer.from([0xff, 0xff, 0xc2, 0x00, 0x11, 0x08]), Buffer.from([0x0f, 0xa0, 0x1f, 0x40]), Buffer.alloc(12), // fill byte, SOF2 4000x8000
    ]);
    const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), u16le(10), u16le(10), Buffer.from([0, 0, 0]),
      Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]), // graphic control extension
      Buffer.from([0x2c]), u16le(100), u16le(50), u16le(5000), u16le(4000), Buffer.from([0, 2, 2, 0x4c, 0x01, 0, 0x3b])]);
    const bmp = Buffer.concat([Buffer.from("BM", "latin1"), Buffer.alloc(12), u32le(40), u32le(7000), u32le(-6000 >>> 0), Buffer.alloc(28)]);
    const icoOf = (img: Buffer) => Buffer.concat([u16le(0), u16le(1), u16le(1), Buffer.from([0, 0, 0, 0]), u16le(1), u16le(32), u32le(img.length), u32le(22), img]);
    const avif = Buffer.concat([
      box("ftyp", Buffer.from("avif", "latin1"), u32be(0), Buffer.from("mif1miaf", "latin1")),
      fullBox("meta", fullBox("hdlr", Buffer.alloc(20)), box("iprp", box("ipco", fullBox("ispe", u32be(9000), u32be(8000)), fullBox("ispe", u32be(512), u32be(512))))),
    ]);
    const cases: [string, Buffer, unknown][] = [
      ["png", pngHeader(1234, 567), { format: "png", width: 1234, height: 567 }],
      ["jpeg (APP0, fill byte, progressive SOF2)", jpeg, { format: "jpeg", width: 8000, height: 4000 }],
      ["gif (a frame larger than the screen)", gif, { format: "gif", width: 5100, height: 4050 }],
      ["webp VP8X canvas", riff("VP8X", Buffer.concat([Buffer.alloc(4), u24le(7999), u24le(5999)])), { format: "webp", width: 8000, height: 6000 }],
      ["webp VP8L", riff("VP8L", Buffer.concat([Buffer.from([0x2f]), u32le((2999) | (1999 << 14)), Buffer.alloc(5)])), { format: "webp", width: 3000, height: 2000 }],
      ["webp VP8", riff("VP8 ", Buffer.concat([Buffer.alloc(3), Buffer.from([0x9d, 0x01, 0x2a]), u16le(4000), u16le(3000), Buffer.alloc(2)])), { format: "webp", width: 4000, height: 3000 }],
      ["bmp (top-down)", bmp, { format: "bmp", width: 7000, height: 6000 }],
      ["ico embedding a PNG beyond the 256 px directory", icoOf(pngHeader(12000, 12000)), { format: "ico", width: 12000, height: 12000 }],
      ["avif (largest ispe)", avif, { format: "avif", width: 9000, height: 8000 }],
      ["truncated png", pngHeader(10, 10).subarray(0, 20), { format: "png", width: null, height: null }],
      ["jpeg without a frame header", Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0, 0]), { format: "jpeg", width: null, height: null }],
      ["text", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), null],
      ["a font", fs.readFileSync(path.join(KIT, "fonts", "Pretendard-Regular.ttf")), null],
    ];
    for (const [label, buf, want] of cases) expect(P.imageSize(buf), label).toEqual(want);
    // data: images in text: plain, nested in a base64 SVG, inside a percent-encoded SVG — one entry per payload
    const b64 = pngHeader(12000, 12000).toString("base64");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,${b64}"/></svg>`;
    const sizes = (t: string) => P.dataImages(t).map((x: { width: number; height: number }) => [x.width, x.height]);
    expect(sizes(`<img src="data:image/png;base64,${b64.replace(/(.{20})/g, "$1\n")}">`)).toEqual([[12000, 12000]]);
    expect(sizes(`a{b:url(data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")})}`)).toEqual([[12000, 12000]]);
    expect(sizes(`<img src="data:image/svg+xml,${encodeURIComponent(svg)}">`)).toEqual([[12000, 12000]]);
    expect(sizes(`<img src="data:image/png;base64,${b64}"><img src="data:image/png;base64,${b64}">`)).toEqual([[12000, 12000]]);
    expect(sizes("<p>data:image/png;base64, no payload</p>")).toEqual([]);
  });

  it("raster policy: <= 4x and <= 2560 px; JPEG only for opaque, box-filling JPEG photos", async () => {
    const B = await import(pathToFileURL(path.join(KIT, "tools", "extract", "browser.mjs")).href);
    const icon = B.rasterPlan({ type: "svg", w: 24, h: 24 });
    expect(icon).toEqual({ S: 4, format: "png" });
    const photo = { type: "img", w: 1280, h: 720, style: { objectFit: "cover" } };
    expect(B.rasterPlan(photo, { sourceType: "image/jpeg" })).toEqual({ S: 2, format: "jpeg" });
    expect(B.rasterPlan(photo, { sourceType: "image/png" }).format).toBe("png");
    expect(B.rasterPlan(photo, { sourceType: "image/jpeg", opacity: 0.5 }).format).toBe("png");
    expect(B.rasterPlan({ ...photo, style: { objectFit: "contain" } }, { sourceType: "image/jpeg" }).format).toBe("png");
    expect(B.rasterPlan({ ...photo, style: { objectFit: "cover", borderRadius: "16px" } }, { sourceType: "image/jpeg" }).format).toBe("png");
    expect(B.rasterPlan({ type: "img", w: 3000, h: 100, style: {} }, { sourceType: "image/jpeg" })).toEqual({ S: 2560 / 3000, format: "jpeg" });
    // Playwright passes its own --host-resolver-rules with literal quotes, which Chromium rejects; the converter's
    // unquoted copy comes after it (the last copy of a switch wins)
    expect(B.LAUNCH_ARGS).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
    for (const a of B.LAUNCH_ARGS as string[]) expect(a, a).not.toMatch(/["']/);
  });

  it("the toolkit carries no PoC paths, no overlay deck, no numpy, no skill-dir variable", () => {
    const text = walk(KIT).filter((f) => /\.(mjs|js|py|md|json|css|html|txt|sh)$/.test(f) && !/\/xsd\//.test(f) && !/\/golden\//.test(f));
    expect(text.length).toBeGreaterThan(40);
    const bad: string[] = [];
    for (const f of text) {
      const s = fs.readFileSync(f, "utf8");
      for (const [re, what] of [
        [/\/home\/jinyoung/, "/home/jinyoung"], [/poc\.local/, "poc.local"], [/--overlay\b/, "--overlay"],
        [/add_overlay/, "add_overlay"], [/^\s*(import numpy|from numpy)/m, "numpy import"], [/\$\{CLAUDE_SKILL_DIR\}/, "${CLAUDE_SKILL_DIR}"],
      ] as [RegExp, string][]) {
        if (re.test(s)) bad.push(`${path.relative(KIT, f)}: ${what}`);
      }
    }
    expect(bad).toEqual([]);
    expect(fs.readFileSync(path.join(KIT, "VERSION"), "utf8").trim()).toBe("1.3.0");
    expect(fs.readFileSync(path.join(KIT, "requirements.txt"), "utf8").trim().split("\n")).toEqual([
      "python-pptx==1.0.2", "lxml==6.1.3", "Pillow==12.3.0", "XlsxWriter==3.2.9", "typing_extensions==4.16.0",
      "fonttools==4.66.0", "defusedxml==0.7.1", "openpyxl==3.1.5", "et_xmlfile==2.0.0",
    ]);
    // I1 paths other lanes consume
    for (const p of ["tools/deck.mjs", "tools/lib/locks.mjs", "fonts/fonts.json", "fonts/README.md", "selftest/deck/slides/01-cover.html",
      "selftest/features/deck.css", "selftest/features/assets/photo.jpg", "selftest/golden/deck.embedded.ir.json",
      "selftest/golden/features.malgun.ir.json", "selftest/tools/make_assets.py", "tools/gates/xsd/NOTICE.md", "docs/CONTRACT.md"]) {
      expect(fs.existsSync(path.join(KIT, p)), p).toBe(true);
    }
    expect(fs.statSync(path.join(KIT, "selftest", "features", "assets", "photo.jpg")).size).toBeLessThanOrEqual(300 * 1024);
    // the in-page CSP is exactly the documented policy
    const server = fs.readFileSync(path.join(KIT, "tools", "extract", "server.mjs"), "utf8");
    expect(server).toContain("\"default-src 'none'\", `script-src ${BASE}lib/chart.js`");
    // deck.sh is the I2 wrapper
    expect(fs.readFileSync(DECK_SH, "utf8")).toContain('exec node "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../converter/tools/deck.mjs" "$@"');
  });
});

// ------------------------------------------------------------------------------------------------ toolchain e2e
const probeNow = (() => {
  if (process.env.NOAH_PPTX_E2E !== "1") return { converter: false };
  try {
    return JSON.parse(deck(["probe", "--json"]).stdout);
  } catch {
    return { converter: false };
  }
})();
const E2E = process.env.NOAH_PPTX_E2E === "1" && probeNow.converter === true;

/** Minimal ZIP reader (stored + deflate) for asserting PPTX parts. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip");
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize);
    out.set(name, method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function imageSize(b: Buffer): { type: string; w: number; h: number } | null {
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: "image/png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: "image/jpeg", w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

function procsMatching(needle: string): number[] {
  const out: number[] = [];
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, "utf8");
      if (cmd.includes(needle)) out.push(Number(d));
    } catch {
      /* gone */
    }
  }
  return out;
}

const until = async (cond: () => boolean, ms: number, step = 100) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
};

function copyFixture(name: "deck" | "features", root: string, as: string = name): string {
  const d = path.join(root, as);
  fs.cpSync(path.join(KIT, "selftest", name), d, { recursive: true });
  return d;
}

describe.skipIf(!E2E)("deck converter e2e (NOAH_PPTX_E2E=1)", () => {
  let kitHash = "";
  beforeAll(() => {
    kitHash = treeHash(KIT);
  });
  afterAll(() => {
    expect(treeHash(KIT)).toBe(kitHash);
    expect(findNamed(KIT, new Set(["__pycache__"]))).toEqual([]);
  });

  it("selftest --fail-on-drift passes both decks in both profiles", () => {
    const root = tmp("selftest");
    const rec = path.join(root, "record.json");
    const r = deck(["selftest", "--fail-on-drift", "--record", rec, "--json"], {}, { timeout: 600_000 });
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ format: "noah-deck-selftest", version: 1, ok: true, status: "pass" });
    for (const d of ["deck", "features"]) {
      for (const p of ["embedded", "malgun"]) {
        expect(j.decks[d][p].build.ok).toBe(true);
        expect(j.decks[d][p].golden).toMatchObject({ status: "match", lintSetChanged: false });
      }
    }
    expect(r.stderr).toMatch(/deck converter selftest: PASS \(Chromium [\d.]+; deck 4\+4 slides, features 3\+3 slides; golden match\)/);
    expect(JSON.parse(fs.readFileSync(rec, "utf8"))).toMatchObject({ format: "noah-deck-selftest-record", version: 1, status: "pass", converterVersion: "1.3.0", differences: 0 });
  }, 600_000);

  it("check renders, lints and reports (never a deliverable); --only keeps slide numbers", () => {
    const root = tmp("check");
    const d = copyFixture("deck", root, "q3-review");
    const r = deck(["check", d, "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.stderr).toBe(0);
    const rep = JSON.parse(r.stdout);
    expect(rep).toMatchObject({ format: "noah-deck-run", version: 1, command: "check", ok: true, profiles: ["embedded"], slideCount: 4 });
    expect(rep.lint.errors).toBe(0);
    expect(rep.renders.embedded).toHaveLength(4);
    for (const f of [...rep.renders.embedded, ...rep.overview.embedded]) expect(fs.existsSync(path.join(d, f)), f).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(d, ".build", "check", "report.json"), "utf8")).ok).toBe(true);
    expect(fs.readdirSync(d).filter((f) => f.endsWith(".pptx") || f.endsWith(".preview"))).toEqual([]);
    const only = deck(["check", d, "--only", "03-table", "--json"], {}, { timeout: 300_000 });
    expect(only.code, only.stderr).toBe(0);
    const o = JSON.parse(only.stdout);
    expect(o.lint.items.filter((l: { rule: string }) => l.rule === "field")).toEqual([]);
    expect(o.renders.embedded).toEqual([".build/check/embedded/html/03-table.png"]); // this run's slides only
    const ir = JSON.parse(fs.readFileSync(path.join(d, ".build", "check", "embedded", "ir.json"), "utf8"));
    expect(ir.slides.map((s: { index: number }) => s.index)).toEqual([3]);
    // a renamed slide: the report and the renders folder show the deck as it is now, never the old name
    fs.renameSync(path.join(d, "slides", "04-chart.html"), path.join(d, "slides", "04-trend.html"));
    const renamed = deck(["check", d, "--json"], {}, { timeout: 300_000 });
    expect(renamed.code, renamed.stderr).toBe(0);
    const want = ["01-cover", "02-kpi", "03-table", "04-trend"].map((n) => `.build/check/embedded/html/${n}.png`);
    expect(JSON.parse(renamed.stdout).renders.embedded).toEqual(want);
    expect(fs.readdirSync(path.join(d, ".build", "check", "embedded", "html")).sort()).toEqual(want.map((f) => path.basename(f)));
    expect(renamed.stderr).toContain("(4 PNG, 1280x720)");
  }, 300_000);

  it("authoring feedback: a collapsed space never fails malgun as a toolchain fault; the lint names each fix; Next: keeps the flags", () => {
    const root = tmp("feedback");
    const at = (y: number, style = "") => `position:absolute;left:80px;top:${y}px;${style}`;
    const d = makeDeck(root, "fb", {
      // the only regular-weight space is a collapsed trailing one: the malgun profile serves U+0020 from a face of its
      // own, which Chromium therefore never loads — once reported as "the converter is unavailable" (exit 4)
      "01-trailing.html": SLIDE(`<p class="eyebrow" style="${at(56)}">01 프로브</p><p style="${at(200, "font-size:18px;line-height:28px")}">매출 </p>`),
      "02-mixed.html": SLIDE(`<div style="${at(200, "display:flex;gap:8px;align-items:center")}">매출 <p class="pill pill--up">▲ 12%</p></div>`),
      "03-weight.html": SLIDE(`<p style="${at(200, "font-weight:500")}">굵기 500</p>`),
      "04-lineheight.html": SLIDE(`<p style="${at(200, "width:1120px;font-size:44px;line-height:52px;font-weight:800")}">1,284억 원</p>`),
      "05-title.html": SLIDE(`<header class="slide-header"><p class="eyebrow">01 프로브</p><h1 class="slide-title">신입사원 온보딩 첫 주에는 전사 공통 교육과 팀별 적응 프로그램을 모두 마쳐야 합니다</h1></header><p style="${at(140)}">본문</p>`),
    });
    const one = deck(["check", d, "--profile", "malgun", "--only", "01-trailing"], {}, { timeout: 300_000 });
    expect(one.code, one.out).toBe(0);
    expect(one.out).not.toMatch(/FAILED \(toolchain\)|did not load/);
    // the success Next: builds the profile that was checked, and says the build checks every slide
    expect(one.out).toContain(`run: bash ${DECK_SH} build ${d} --profile malgun — the build checks all 5 slides, not only the 1 checked here`);
    expect(one.out).toContain("NOTE malgun weights: 600/800 text is drawn with 맑은 고딕 Bold on 1 slide(s) — expected, no action needed");
    expect(one.out).not.toMatch(/LINT WARN .* font-weight/);

    const all = deck(["check", d, "--profile", "both", "--json"], {}, { timeout: 300_000 });
    expect(all.code, all.stderr).toBe(1);
    const rep = JSON.parse(all.stdout);
    const items = rep.lint.items as { slide: number; profile: string; severity: string; rule: string; message: string }[];
    const has = (slide: number, profile: string, rule: string, severity = "error") =>
      items.find((l) => l.slide === slide && l.profile === profile && l.rule === rule && l.severity === severity);
    for (const p of ["embedded", "malgun"]) {
      expect(has(1, p, "mixed-content"), `trailing ${p}`).toBeUndefined();
      expect(has(2, p, "mixed-content")?.message, `mixed ${p}`).toContain('bare text "매출" sits beside element children of this flex/grid container: wrap it in its own element, e.g. <p>매출</p>');
      expect(has(3, p, "font-weight")?.message, `weight ${p}`).toContain("font-weight 500 is not a kit weight");
      expect(has(5, p, "title-wrap"), `title ${p}`).toBeTruthy();
      expect(has(5, p, "text-overlap"), `overlap ${p}`).toBeTruthy();
    }
    // the #1 trap names the line-height the glyphs need (the AUTHORING §4.2 table: 58 px for 44 px text in malgun)
    expect(has(4, "malgun", "text-overflow")?.message).toContain("raise line-height to at least 58px");
    expect(has(4, "embedded", "text-overflow")).toBeUndefined();
    // expected malgun weight notes are marked, counted apart and folded into one line
    expect(rep.lint.expected).toBeGreaterThan(0);
    expect(items.filter((l) => l.rule === "font-weight" && l.severity === "warn").every((l) => (l as { expected?: boolean }).expected)).toBe(true);
    expect(rep.softWraps.some((w: { slide: number; wrapped: string }) => w.slide === 5 && w.wrapped.includes(" / "))).toBe(true);
    expect(all.stderr).toContain(`and run: bash ${DECK_SH} check ${d} --profile both`);
    expect(all.stderr).toMatch(/"Limits"; [^)]*mixed-content: §5\.1/);

    // a failed build repeats ITS command: profile and author included (quoted for the shell)
    const b = deck(["build", d, "--profile", "malgun", "--author", "김 노아"], {}, { timeout: 300_000 });
    expect(b.code).toBe(1);
    expect(b.out).toContain(`and run: bash ${DECK_SH} build ${d} --profile malgun --author '김 노아'`);
    expect(b.out).toContain(`${path.join("fb", ".build", "malgun", "html")}/ (5 PNG, 1280x720) — this run's renders`);
  }, 300_000);

  it("agent-facing lint text: the title kind's guidance, the malgun stand-in's name, the spacing rule of an overlap", () => {
    const root = tmp("linttext");
    const cover = fs.readFileSync(path.join(SKILL, "examples", "business-review", "slides", "01-cover.html"), "utf8");
    expect(cover).toContain("2026년 3분기<br>사업 실적 보고");
    const at = (x: number, y: number, style = "") => `position:absolute;left:${x}px;top:${y}px;${style}`;
    const d = makeDeck(root, "lt", {
      // the kit cover (60 px title in its 520 px box) with a first line too long for it
      "01-cover.html": cover.replace("2026년 3분기<br>사업 실적 보고", "2026년 3분기 사업 실적과<br>하반기 전략 보고"),
      "02-title.html": SLIDE(`<header class="slide-header"><p class="eyebrow">01 프로브</p><h1 class="slide-title">신입사원 온보딩 첫 주에는 전사 공통 교육과 팀별 적응 프로그램을 모두 마쳐야 합니다</h1></header>`),
      // a named font; a label that grows into the value beside it in malgun only
      "03-named.html": SLIDE(`<p style="${at(80, 200, "font-family:'Pretendard'")}">글꼴 지정</p><p style="${at(80, 400, "font-size:18px;line-height:28px")}">왼쪽 라벨 텍스트가 길어짐</p><p style="${at(290, 400, "font-size:18px;line-height:28px")}">오른쪽 값</p>`),
    });
    const r = deck(["check", d, "--profile", "both", "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.stderr).toBe(1);
    const items = JSON.parse(r.stdout).lint.items as { slide: number; profile: string; rule: string; message: string }[];
    const find = (slide: number, profile: string, rule: string) => items.filter((l) => l.slide === slide && l.profile === profile && l.rule === rule).map((l) => l.message);
    for (const p of ["embedded", "malgun"]) {
      expect(find(1, p, "title-wrap"), p).toEqual(["the cover title wraps onto 3 lines without <br> in this profile — its 520 px box holds about 8 Hangul syllables per 60 px line in the malgun profile (the wider one; a space takes about a third of a syllable): shorten the line or re-split it with <br> (AUTHORING §8.13)"]);
      expect(find(2, p, "title-wrap")[0], p).toMatch(/^the slide title wraps onto 2 lines without <br> in this profile — its 1120 px box holds about 28 Hangul syllables per 40 px line in the malgun profile .*\(AUTHORING §4\.3\)$/);
      expect(find(1, p, "text-overlap")[0], p).toContain("because this title wraps onto an extra line: fix its title-wrap error");
    }
    expect(find(3, "malgun", "font-family")).toEqual(["text uses font-family \"Pretendard\", not the profile font (the malgun profile's metric-matched stand-in for 맑은 고딕): never name a font — inherit font-family: var(--font-sans) (AUTHORING §4.1)"]);
    // the stand-in's internal family name never reaches the agent through the lint
    expect(items.filter((l) => /PoC Malgun Substitute/.test(l.message))).toEqual([]);
    const side = find(3, "malgun", "text-overlap");
    expect(side).toHaveLength(1);
    expect(side[0]).toMatch(/^the line boxes of its text \("왼쪽 라벨 텍스트가 길어짐"\) and of main\.slide > p:nth-child\(3\)::text \("오른쪽 값"\) intersect by [\d.]+×[\d.]+ px in the malgun profile — measured over each line's full font height, ascent to descent \(1\.33 em in this profile, taller than the ink\), so the glyphs may not touch yet; they meet along the line: keep ≥ 16 px/);
    expect(find(3, "embedded", "text-overlap")).toEqual([]);
  }, 300_000);

  it("an installed converter whose browser does not start fails as a run-time toolchain fault: retry, then the log — never \"rebuild\"", async () => {
    const R = await import(pathToFileURL(path.join(KIT, "tools", "lib", "report.mjs")).href);
    const root = tmp("nolaunch");
    const fake = path.join(root, "chromium");
    // answers the probe's --version like the real one, then never starts a browser (a launch failure on a host
    // whose toolchain is complete)
    fs.writeFileSync(fake, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"Chromium 149.0.7827.55\"; exit 0; fi\necho \"cannot start\" >&2\nexit 1\n", { mode: 0o755 });
    const env = { NOAH_PPTX_CHROMIUM: fake };
    expect(JSON.parse(deck(["probe", "--json"], env).stdout).converter).toBe(true); // describe_system: INSTALLED
    const d = makeDeck(root, "q3", { "01-a.html": SLIDE('<p class="card-title" style="position:absolute;left:80px;top:80px">a</p>') });
    const r = deck(["check", d, "--json"], env, { timeout: 120_000 });
    expect(r.code, r.stderr).toBe(4);
    const f = JSON.parse(r.stdout).failure;
    expect(f).toMatchObject({ class: "toolchain", stage: "extract", next: R.NEXT.toolchainRun() });
    expect(f.message.startsWith(`the converter is installed (this run passed its toolchain check), but the extract stage could not use it (Chromium (${fake}) did not start: `)).toBe(true);
    const log = /; log: (\S+extract-embedded-check\.log)\.$/.exec(f.message)?.[1];
    expect(log && fs.existsSync(log)).toBe(true);
    expect(r.stderr).toContain(`FAILED (toolchain): ${f.message}`);
    expect(r.stderr).not.toMatch(/rebuild the server image|unavailable in this deployment/);
  }, 120_000);

  it("a toolkit font file that exists but does not load is the installed converter's run-time fault, never the slide's", () => {
    // a copy of the skill (never the real one) with a truncated Gothic A1 Regular: present, so the toolchain check
    // passes, but unreadable — its faces error in the page, one of them a face the slide's text does not need
    const root = tmp("badfont");
    const skill = path.join(root, "pptx");
    for (const dir of ["scripts", "converter"]) fs.cpSync(path.join(SKILL, dir), path.join(skill, dir), { recursive: true });
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules")); // playwright-core resolves upwards
    const font = path.join(skill, "converter", "fonts", "GothicA1-Regular.ttf");
    fs.writeFileSync(font, fs.readFileSync(font).subarray(0, 2000));
    const d = makeDeck(root, "q3", { "01-a.html": SLIDE('<p style="position:absolute;left:80px;top:80px">가나다</p>') });
    const r = spawnSync("bash", [path.join(skill, "scripts", "deck.sh"), "check", d, "--profile", "malgun", "--json"], { cwd: root, env: process.env, encoding: "utf8", timeout: 300_000 });
    expect(r.status, r.stderr).toBe(4);
    const f = JSON.parse(r.stdout).failure;
    expect(f).toMatchObject({ class: "toolchain", stage: "extract" });
    expect(f.message).toMatch(/^the converter is installed \(this run passed its toolchain check\), but the extract stage could not use it \(slides\/01-a\.html \[malgun, dsf 1\]: font face\(s\) used by the slide did not load\); log: \S+extract-malgun-check\.log\.$/);
    // the face the text does not need carries its src too: once reported as the slide's font ("fix the slide HTML")
    expect(r.stderr).toContain("\"PoC Malgun Substitute\" (the malgun profile's metric-matched stand-in for 맑은 고딕) weight 1 549 normal unicode-range U+0-10FFFF: status 'error' src url(\"../fonts/GothicA1-Regular.ttf\")");
    expect(r.stderr).not.toMatch(/FAILED \(authoring\)|fix the listed elements|rebuild the server image/);
  }, 300_000);

  it("unsupported CSS is an authoring error naming the rule", () => {
    const root = tmp("filter");
    const d = makeDeck(root, "blur", { "01-a.html": SLIDE('<p class="card-title" style="position:absolute;left:80px;top:80px;filter: blur(2px)">흐림</p>') });
    const r = deck(["check", d], {}, { timeout: 300_000 });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/LINT ERROR slide 1 \(01-a\) filter main\.slide > p\.card-title:nth-child\(1\): filter: blur\(2px\)/);
    expect(r.out).toMatch(/FAILED \(authoring\): 1 lint error\(s\)\./);
  }, 300_000);

  it("CSP + network block: no slide script runs, nothing reaches the network, the lints say why", async () => {
    let hits = 0;
    const srv = http.createServer((_req, res) => { hits++; res.end("x"); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const root = tmp("csp");
      const body = [
        '<p class="card-title" style="position:absolute;left:80px;top:80px">CSP</p>',
        "<script>document.querySelector('main.slide').insertAdjacentHTML('beforeend','<p>PWNED-INLINE</p>')</script>",
        `<img src="x" style="position:absolute;left:80px;top:200px;width:40px;height:40px" onerror="document.querySelector('main.slide').insertAdjacentHTML('beforeend','<p>PWNED-HANDLER</p>')">`,
        `<img src="http://127.0.0.1:${port}/x.png" style="position:absolute;left:200px;top:200px;width:40px;height:40px">`,
      ].join("\n");
      const d = makeDeck(root, "csp", { "01-a.html": SLIDE(body, `<link rel="stylesheet" href="http://127.0.0.1:${port}/evil.css">`) });
      const r = deck(["check", d, "--json"], {}, { timeout: 300_000 });
      expect(r.code).toBe(1);
      const rep = JSON.parse(r.stdout);
      const rules = new Set(rep.lint.items.map((l: { rule: string }) => l.rule));
      for (const rule of ["script", "remote-url", "csp-violation", "stylesheet"]) expect(rules.has(rule), rule).toBe(true);
      const ir = fs.readFileSync(path.join(d, ".build", "check", "embedded", "ir.json"), "utf8");
      expect(ir).not.toContain("PWNED-INLINE");
      expect(ir).not.toContain("PWNED-HANDLER");
      expect(hits).toBe(0);
    } finally {
      srv.close();
    }
  }, 300_000);

  it("build writes the deliverable and a hash-bound preview sidecar; a failed rebuild keeps both", () => {
    const root = tmp("build");
    const d = copyFixture("features", root, "fx");
    const r = deck(["build", d, "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.stderr).toBe(0);
    const rep = JSON.parse(r.stdout);
    const pptx = path.join(d, "fx.pptx");
    const bytes = fs.readFileSync(pptx);
    expect(rep).toMatchObject({ command: "build", ok: true, profile: "embedded", slideCount: 3, previousDeliverable: null, failure: null });
    expect(rep.pptx).toEqual({ path: fs.realpathSync(pptx), bytes: bytes.length, sha256: sha256(bytes) });
    expect(rep.gates.map((g: { name: string }) => g.name)).toEqual(["office-rules", "shape-table-lint", "chart-verify", "chart-lint", "embed-verify", "indep-check", "font-coverage", "inspect"]);
    expect(rep.fidelity.status).toBe("pass");
    // ABSOLUTE: share_file resolves a relative path against the run's working directory, not the shell's cwd
    expect(r.stderr).toContain(`Share it IN PLACE: mcp__file_output__share_file path="${fs.realpathSync(pptx)}" name="`);

    // the sidecar (I5): manifest written last, bound to the exact bytes
    const pdir = path.join(d, "fx.preview");
    const m = JSON.parse(fs.readFileSync(path.join(pdir, "manifest.json"), "utf8"));
    expect(m).toMatchObject({ format: "noah-deck-preview", version: 1, generator: "noah-pptx-converter/1.3.0", pptx: "fx.pptx", profile: "embedded", slideCount: 3 });
    expect(m.pptxSha256).toBe(sha256(bytes));
    expect(m.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(m.slides.map((s: { index: number }) => s.index)).toEqual([1, 2, 3]);
    for (const s of m.slides) {
      expect(s.file).toMatch(/^slide-\d{2,3}\.(png|jpg)$/);
      expect(s.mediaType).toBe(s.file.endsWith(".png") ? "image/png" : "image/jpeg");
      const img = fs.readFileSync(path.join(pdir, s.file));
      expect(s.sha256).toMatch(hex64);
      expect(sha256(img)).toBe(s.sha256);
      expect(imageSize(img)).toEqual({ type: s.mediaType, w: 1920, h: 1080 });
      expect([s.width, s.height]).toEqual([1920, 1080]);
    }
    expect(m.slides.map((s: { title?: string }) => s.title)).toEqual(["사진과 덱 스타일 변환 점검", "긴 문단과 목록, 발표자 노트", "둥근 모서리 그림과 SVG 아이콘"]);
    expect(fs.readFileSync(path.join(pdir, ".gitignore"), "utf8")).toBe("*\n");
    expect(fs.readFileSync(path.join(d, ".build", ".gitignore"), "utf8")).toBe("*\n");
    expect(fs.readdirSync(path.join(d, ".build", "embedded", "html")).filter((f) => f.includes("@2x"))).toEqual([]);

    // the deck: the photo is a JPEG picture, the notes slide has its notes and the notes master is listed
    const z = readZip(bytes);
    const media = [...z.keys()].filter((n) => n.startsWith("ppt/media/"));
    expect(media.some((n) => n.endsWith(".jpg") && z.get(n)![0] === 0xff && z.get(n)![1] === 0xd8)).toBe(true);
    expect(media.some((n) => n.endsWith(".svg"))).toBe(true);
    const notes = [...z.keys()].filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
    expect(notes).toHaveLength(1);
    expect(z.get(notes[0])!.toString("utf8")).toContain("첫째 문단");
    expect(z.get("ppt/presentation.xml")!.toString("utf8")).toMatch(/<p:notesMasterIdLst><p:notesMasterId r:id="rId\d+"\/><\/p:notesMasterIdLst>/);

    // a failing rebuild (lint error) keeps the deliverable and its previews byte-identical and removes a candidate
    const before = new Map(walk(pdir).map((f) => [f, sha256(fs.readFileSync(f))]));
    const candidate = path.join(d, ".build", "embedded", "deck.pptx");
    fs.writeFileSync(candidate, "stale candidate");
    const slide = path.join(d, "slides", "02-notes-wrap.html");
    fs.writeFileSync(slide, fs.readFileSync(slide, "utf8").replace('<p class="wrap-text">', '<p class="wrap-text" style="filter: blur(1px)">'));
    const f = deck(["build", d, "--json"], {}, { timeout: 300_000 });
    expect(f.code).toBe(1);
    const fr = JSON.parse(f.stdout);
    expect(fr.failure.class).toBe("authoring");
    expect(fr.previousDeliverable).toMatchObject({ path: fs.realpathSync(pptx), sha256: sha256(bytes) });
    expect(f.stderr).toMatch(/The previous build fx\.pptx \(built .+\) is unchanged and does NOT include these edits\./);
    expect(fs.existsSync(candidate)).toBe(false);
    expect(sha256(fs.readFileSync(pptx))).toBe(sha256(bytes));
    expect(new Map(walk(pdir).map((p) => [p, sha256(fs.readFileSync(p))]))).toEqual(before);
    expect(fs.existsSync(`${pdir}.new`)).toBe(false);
  }, 600_000);

  it("previews: a render whose 1920x1080 PNG exceeds 2 MiB becomes a JPEG q90 preview", () => {
    const py = process.env.NOAH_PPTX_PYTHON || "python3";
    const root = tmp("prevjpeg");
    const make = [
      "import json, os, sys", "from PIL import Image", "d = sys.argv[1]", "os.makedirs(os.path.join(d, 'html'))",
      "Image.frombytes('RGB', (2560, 1440), os.urandom(2560 * 1440 * 3)).save(os.path.join(d, 'html', '01-a@2x.png'))",
      "Image.new('RGB', (1280, 720), (200, 210, 220)).save(os.path.join(d, 'html', '01-a.png'))",
      "json.dump({'slides': [{'index': 1, 'name': '01-a', 'referencePng': 'html/01-a.png', 'referencePng2x': 'html/01-a@2x.png', 'elements': []}]}, open(os.path.join(d, 'ir.json'), 'w'))",
    ].join("\n");
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    expect(spawnSync(py, ["-c", make, root], { env }).status).toBe(0);
    const r = spawnSync(py, [path.join(KIT, "tools", "previews.py"), "--ir", path.join(root, "ir.json"), "--overview-dir", root,
      "--out-dir", path.join(root, "x.preview"), "--pptx-name", "x.pptx", "--pptx-sha256", "a".repeat(64), "--profile", "embedded"], { env, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const m = JSON.parse(fs.readFileSync(path.join(root, "x.preview", "manifest.json"), "utf8"));
    expect(m.slides).toHaveLength(1);
    expect(m.slides[0]).toMatchObject({ index: 1, file: "slide-01.jpg", mediaType: "image/jpeg", width: 1920, height: 1080 });
    expect(m.slides[0]).not.toHaveProperty("title");
    const img = fs.readFileSync(path.join(root, "x.preview", "slide-01.jpg"));
    expect(imageSize(img)).toEqual({ type: "image/jpeg", w: 1920, h: 1080 });
    expect(sha256(img)).toBe(m.slides[0].sha256);
    expect(fs.existsSync(path.join(root, "overview-1.png"))).toBe(true);
  }, 120_000);

  it("the time budget ends a run with exit 6", () => {
    const root = tmp("budget");
    const d = copyFixture("deck", root);
    const r = deck(["build", d], { NOAH_PPTX_MAX_SECONDS: "5" }, { timeout: 120_000 });
    expect(r.code).toBe(6);
    expect(r.out).toMatch(/FAILED \(timeout\): the extract stage exceeded the converter's time budget \(\d+ of 5 s\)/);
    expect(r.out).toContain("Next: reduce the number of slides or image assets, or split the deck into two builds.");
  }, 120_000);

  const waitForBrowser = (tmpDir: string) => until(() => procsMatching(tmpDir).some((p) => {
    try {
      return /chrom/i.test(fs.readFileSync(`/proc/${p}/cmdline`, "utf8"));
    } catch {
      return false;
    }
  }), 60_000);

  it("cancellation: SIGKILL of deck.mjs during extract leaves no Chromium, Python or run dir", async () => {
    const root = tmp("cancel1");
    const d = copyFixture("deck", root);
    // a SHORT TMPDIR (the run dir must live in it: a long one falls back to /tmp, see tools/lib/proc.mjs runBase)
    const tdir = fs.mkdtempSync("/tmp/ndc-");
    tmpRoots.push(tdir);
    const child = spawn("bash", [DECK_SH, "build", d], { env: { ...process.env, TMPDIR: tdir }, stdio: "ignore" });
    expect(await waitForBrowser(tdir)).toBe(true);
    child.kill("SIGKILL"); // deck.sh exec's node: this is deck.mjs itself
    expect(await until(() => procsMatching(tdir).length === 0 && procsMatching(d).length === 0, 10_000)).toBe(true);
    expect(await until(() => fs.readdirSync(tdir).filter((n) => n.startsWith("noah-pptx-run-")).length === 0, 3_000)).toBe(true);
    expect(fs.existsSync(path.join(d, "deck.pptx"))).toBe(false);
  }, 120_000);

  it("cancellation: SIGKILL of the parent shell -> the orphaned deck.mjs exits within 5 s and cleans up", async () => {
    const root = tmp("cancel2");
    const d = copyFixture("deck", root);
    const tdir = fs.mkdtempSync("/tmp/ndc-");
    tmpRoots.push(tdir);
    const sh = spawn("bash", ["-c", `bash ${JSON.stringify(DECK_SH)} build ${JSON.stringify(d)}; echo done`], { env: { ...process.env, TMPDIR: tdir }, stdio: "ignore" });
    expect(await waitForBrowser(tdir)).toBe(true);
    const deckPid = procsMatching("deck.mjs").find((p) => {
      try {
        return fs.readFileSync(`/proc/${p}/cmdline`, "utf8").includes(d);
      } catch {
        return false;
      }
    });
    expect(deckPid).toBeTruthy();
    sh.kill("SIGKILL");
    expect(await until(() => !fs.existsSync(`/proc/${deckPid}`), 5_000)).toBe(true);
    expect(await until(() => procsMatching(tdir).length === 0 && procsMatching(d).length === 0, 10_000)).toBe(true);
    expect(fs.readdirSync(tdir).filter((n) => n.startsWith("noah-pptx-run-"))).toEqual([]);
    // what the run left for a later reader: cancelled, never "internal, retry, give the administrator the log"
    const rep = JSON.parse(fs.readFileSync(path.join(d, ".build", "embedded", "report.json"), "utf8"));
    expect(rep).toMatchObject({ ok: false, exitCode: 143, failure: { class: "cancelled", message: "interrupted (the parent process went away) — no deliverable was changed." } });
  }, 120_000);

  /** Run deck.sh <args> in the background, send `sig` once its browser is up -> {code, stdout, out (stdout + stderr)}. */
  const signalled = async (args: string[], sig: NodeJS.Signals) => {
    const tdir = fs.mkdtempSync("/tmp/ndc-");
    tmpRoots.push(tdir);
    const child = spawn("bash", [DECK_SH, ...args], { env: { ...process.env, TMPDIR: tdir }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => { stdout += String(b); });
    child.stderr.on("data", (b) => { stderr += String(b); });
    const exited = new Promise<number | null>((r) => child.once("close", (code) => r(code)));
    expect(await waitForBrowser(tdir)).toBe(true);
    child.kill(sig); // deck.sh exec's node: this is deck.mjs itself
    const code = await exited;
    expect(await until(() => procsMatching(tdir).length === 0, 10_000)).toBe(true);
    expect(fs.readdirSync(tdir).filter((n) => n.startsWith("noah-pptx-run-"))).toEqual([]);
    return { code, stdout, out: `${stdout}${stderr}` };
  };

  it("cancellation: SIGTERM / SIGINT during extract -> FAILED (cancelled), exit 143 / 130, and the report says so", async () => {
    const root = tmp("cancel3");
    const d = copyFixture("deck", root);
    const t = await signalled(["check", d], "SIGTERM");
    expect(t.code).toBe(143);
    expect(t.out).toContain("FAILED (cancelled): interrupted (SIGTERM) — no deliverable was changed.");
    expect(t.out).toContain("Next: nothing was changed; run the command again if the interruption was not intended.");
    expect(t.out).not.toMatch(/FAILED \(internal\)|retry the same command/);
    expect(JSON.parse(fs.readFileSync(path.join(d, ".build", "check", "report.json"), "utf8"))).toMatchObject({ ok: false, exitCode: 143, failure: { class: "cancelled", stage: "extract" } });

    const i = await signalled(["build", d, "--json"], "SIGINT");
    expect(i.code).toBe(130);
    const rep = JSON.parse(i.stdout); // --json: exactly one JSON object on stdout, the cancellation included
    expect(rep).toMatchObject({ command: "build", ok: false, exitCode: 130, failure: { class: "cancelled", message: "interrupted (SIGINT) — no deliverable was changed." } });
    expect(JSON.parse(fs.readFileSync(path.join(d, ".build", "embedded", "report.json"), "utf8")).failure.class).toBe("cancelled");
    expect(fs.existsSync(path.join(d, "deck.pptx"))).toBe(false);
    expect(fs.existsSync(path.join(d, ".build", "embedded", "deck.pptx"))).toBe(false);
  }, 180_000);

  it("a picture whose decoded size is too large is refused before the browser decodes it (image-too-large)", () => {
    const root = tmp("pixels-e2e");
    const d = makeDeck(root, "px", {
      "01-a.html": SLIDE('<p class="card-title" style="position:absolute;left:80px;top:80px">그림</p><img src="../assets/bomb.png" alt="" style="position:absolute;left:640px;top:0;width:640px;height:720px">'),
    });
    fs.mkdirSync(path.join(d, "assets"));
    fs.writeFileSync(path.join(d, "assets", "bomb.png"), pngHeader(12000, 12000));
    const r = deck(["check", d, "--json"], {}, { timeout: 300_000 });
    expect(r.code).toBe(1);
    const items = JSON.parse(r.stdout).lint.items as { rule: string; message: string }[];
    expect(items.find((l) => l.rule === "image-too-large")?.message).toBe("assets/bomb.png is 12000x12000 px (144.0 MP); a picture may have at most 40.0 MP — downscale it (the slide shows at most 2560 px of it)");
    expect(r.stderr).toMatch(/LINT ERROR slide 1 \(01-a\) image-too-large: assets\/bomb\.png is 12000x12000 px/);
  }, 300_000);

  it("chart-range e2e: a value the axis cannot show warns on that slide only, and never fails the build", () => {
    const root = tmp("chart-range-e2e");
    const slide = (spec: string) =>
      SLIDE(
        '<p class="card-title" style="position:absolute;left:80px;top:80px">분기별 값</p>'
          + `<div class="chart" style="position:absolute;left:80px;top:160px;width:1000px;height:400px" data-chart='${spec}'></div>`,
      ).replace("</body>", '<script src="../lib/chart.js"></script>\n</body>');
    const bars = (values: string, max: number) =>
      `{"type":"column","grouping":"clustered","categories":["1Q","2Q","3Q"],"series":[{"name":"A","values":[${values}],"color":"2A52D9"}],`
      + `"dataLabels":{"show":true,"numberFormat":"#,##0","position":"outEnd"},"valueAxis":{"visible":false,"min":0,"max":${max}},"legend":{"position":"none"}}`;
    const d = makeDeck(root, "cr", {
      "01-over.html": slide(bars("80,120,900", 150)), // 900 is drawn clipped at 150 but still labelled 900
      "02-ok.html": slide(bars("80,120,140", 150)),
    });
    const r = deck(["check", d, "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.out).toBe(0); // a warning, like chart-contrast: the chart converts either way
    const items = JSON.parse(r.stdout).lint.items as { slide: number; severity: string; rule: string; message: string }[];
    const range = items.filter((l) => l.rule === "chart-range");
    expect(range.map((l) => [l.slide, l.severity])).toEqual([[1, "warn"]]);
    expect(range[0].message).toContain("the largest value drawn, 900, is above valueAxis.max 150");
    expect(r.stderr).toMatch(/LINT WARN slide 1 \(01-over\) chart-range/);
  }, 300_000);

  /** A slide with one [data-chart] element (inside `wrap`, which gets the chart as {chart}), deck.css and chart.js. */
  const chartSlide = (title: string, spec: object, wrap = "{chart}", chartStyle = "position:absolute;left:80px;top:160px;width:1000px;height:400px") =>
    SLIDE(
      `<p class="card-title" style="position:absolute;left:80px;top:80px">${title}</p>`
        + wrap.replace("{chart}", () => `<div class="chart" style="${chartStyle}" data-chart='${JSON.stringify(spec)}'></div>`),
      '<link rel="stylesheet" href="../deck.css">',
    ).replace("</body>", '<script src="../lib/chart.js"></script>\n</body>');

  it("theme tokens e2e: chart colours named as CSS custom properties resolve against the chart (deck.css wins) into the IR, the chart XML and the preview", () => {
    const root = tmp("chart-tokens");
    const ink500 = /--c-ink-500:\s*#([0-9A-Fa-f]{6})\b/.exec(fs.readFileSync(path.join(KIT, "theme", "base.css"), "utf8"))?.[1].toUpperCase();
    expect(ink500, "theme/base.css defines --c-ink-500 as a literal hex").toMatch(/^[0-9A-F]{6}$/);
    const spec = {
      type: "column", grouping: "clustered", categories: ["1Q", "2Q", "3Q"],
      series: [
        { name: "2025년", values: [80, 120, 140], color: "var(--t-prev)" },
        { name: "2026년", values: [90, 130, 150], color: "var(--c-series-curr)" },
      ],
      pointColors: { "1": ["var(--c-series-curr)", "var(--c-series-curr)", "var(--t-card)"] },
      dataLabels: { show: true, numberFormat: "#,##0", position: "outEnd", color: "var(--t-text)", sizePx: 13, cssWeight: 600 },
      valueAxis: { visible: false, min: 0, max: 200, gridlines: { color: "var(--t-grid)", widthPx: 1 } },
      categoryAxis: { visible: true, labelColor: "var(--c-ink-500)", sizePx: 14, lineColor: "var(--t-axis)" },
      legend: { position: "top", color: "var(--t-text)", sizePx: 13 },
    };
    // --t-card is set on the card, not :root: a token resolves against the chart element's computed style
    const d = makeDeck(root, "tk", {
      "01-chart.html": chartSlide("분기별 매출", spec,
        '<section class="card" style="position:absolute;left:80px;top:150px;width:1000px;height:460px;padding:24px;box-sizing:border-box;--t-card:#6F8FF0">{chart}</section>',
        "width:952px;height:412px"),
    });
    // the deck's theme overrides a base.css token (--c-series-curr) and adds its own; --c-ink-500 stays base.css's
    fs.writeFileSync(path.join(d, "deck.css"), ":root { --c-series-curr: #123456; --t-prev: #8A94A6; --t-text: #3F4A5C; --t-grid: #E3E8EF; --t-axis: #C9D0DB; }\n");
    const r = deck(["build", d, "--strict", "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).lint.items.filter((l: { rule: string }) => l.rule.startsWith("chart-"))).toEqual([]);
    const ir = JSON.parse(fs.readFileSync(path.join(d, ".build", "embedded", "ir.json"), "utf8"));
    const chart = ir.slides[0].elements.find((e: { kind: string }) => e.kind === "chart");
    expect(chart.spec).toMatchObject({
      series: [{ color: "8A94A6" }, { color: "123456" }],
      pointColors: { "1": ["123456", "123456", "6F8FF0"] },
      dataLabels: { color: "3F4A5C" },
      valueAxis: { gridlines: { color: "E3E8EF" } },
      categoryAxis: { labelColor: ink500, lineColor: "C9D0DB" },
      legend: { color: "3F4A5C" },
    });
    expect(JSON.stringify(chart.spec)).not.toContain("var(");
    // the native chart carries the resolved colours (the strict build's fidelity gate compared them with the IR)
    const z = readZip(fs.readFileSync(path.join(d, "tk.pptx")));
    const xml = [...z.keys()].filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n)).map((n) => z.get(n)!.toString("utf8")).join("\n");
    for (const c of ["8A94A6", "123456", "6F8FF0", "3F4A5C", "E3E8EF", ink500!, "C9D0DB"]) expect(xml, c).toContain(`<a:srgbClr val="${c}"`);
    // the preview (lib/chart.js) drew the bars of the reference render in the deck's colours, never the palette's
    const count = [
      "import json, sys", "from PIL import Image",
      "have = {c: n for n, c in Image.open(sys.argv[1]).convert('RGB').getcolors(1 << 24)}",
      "print(json.dumps({h: have.get(tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)), 0) for h in sys.argv[2:]}))",
    ].join("\n");
    const png = path.join(d, ".build", "embedded", "html", "01-chart.png");
    const px = spawnSync(process.env.NOAH_PPTX_PYTHON || "python3", ["-c", count, png, "123456", "6F8FF0", "8A94A6", "4472C4", "ED7D31"],
      { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(px.status, px.stderr).toBe(0);
    const n = JSON.parse(px.stdout);
    for (const c of ["123456", "6F8FF0", "8A94A6"]) expect(n[c], c).toBeGreaterThan(5000);
    expect(n["4472C4"] + n["ED7D31"]).toBe(0);
  }, 300_000);

  it("theme tokens e2e: a token that does not resolve is a chart-spec error naming the field; check exits 1", () => {
    const root = tmp("chart-tokens-bad");
    const d = makeDeck(root, "bad", {
      "01-bad.html": chartSlide("분기별 값", {
        type: "column", categories: ["1Q", "2Q"],
        series: [{ name: "A", values: [80, 120], color: "var(--c-does-not-exist)" }],
        dataLabels: { show: true, color: "var(--c-ink-500, #667085)" },
        categoryAxis: { visible: true, labelColor: "var(--t-soft)" },
        legend: { position: "none" },
      }),
    });
    fs.writeFileSync(path.join(d, "deck.css"), ":root { --t-soft: rgba(1, 2, 3, 0.5); }\n");
    const r = deck(["check", d, "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.out).toBe(1);
    const items = (JSON.parse(r.stdout).lint.items as { severity: string; rule: string; message: string }[]).filter((l) => l.rule === "chart-spec");
    expect(items.map((l) => [l.severity, l.message]).sort()).toEqual([
      ["error", "categoryAxis.labelColor: var(--t-soft) must resolve to an opaque colour (got rgba(1, 2, 3, 0.5))"],
      ["error", "dataLabels.color: var(--c-ink-500, #667085) is not a colour token — write exactly var(--token-name), without a fallback, or a literal RRGGBB"],
      ["error", "series[0].color: var(--c-does-not-exist) is not defined for this chart — define it in deck.css or use a theme token"],
    ]);
    expect(r.stderr).toMatch(/LINT ERROR slide 1 \(01-bad\) chart-spec .*: series\[0\]\.color: var\(--c-does-not-exist\) is not defined for this chart/);
  }, 300_000);

  it("currentColor icons e2e: the container's CSS color is baked into the SVG without an image warning, and each icon ships as a native svgBlip", () => {
    const root = tmp("icons");
    const icon = (id: string, attrs: string, pathAttrs = "") =>
      `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ${attrs}><path ${pathAttrs}d="M20 6 9 17l-5-5"/></svg>`;
    const at = (x: number, style: string) => `position:absolute;left:${x}px;top:200px;width:48px;height:48px;display:flex;align-items:center;justify-content:center;${style}`;
    const d = makeDeck(root, "ic", {
      "01-icons.html": SLIDE(
        '<p class="card-title" style="position:absolute;left:80px;top:80px">아이콘</p>'
          + `<div style="${at(80, "color:#C2410C")}">${icon("ic-accent", 'fill="none" stroke="currentColor" stroke-width="2"')}</div>`
          // black equals the standalone value: still written (a bare currentColor would ship as PNG only)
          + `<div style="${at(160, "color:#000000")}">${icon("ic-black", 'fill="currentColor"')}</div>`
          // translucent, authored on the path: the alpha lands in stroke-opacity
          + `<div style="${at(240, "color:rgba(255, 255, 255, 0.6);background:#1B2A4A;border-radius:50%")}">${icon("ic-soft", 'fill="none" stroke-width="2"', 'stroke="currentColor" ')}</div>`
          // translucent, authored ONCE on the root and inherited by the path: the path differs from the rewritten
          // root (its alpha), so it is written too — and still never named as a page resolution
          + `<div style="${at(320, "color:rgba(255, 255, 255, 0.6);background:#1B2A4A;border-radius:50%")}">${icon("ic-root", 'fill="none" stroke="currentColor" stroke-width="2"')}</div>`,
      ),
    });
    const r = deck(["build", d, "--strict", "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).lint.items.filter((l: { rule: string }) => l.rule === "image")).toEqual([]);
    const ir = JSON.parse(fs.readFileSync(path.join(d, ".build", "embedded", "ir.json"), "utf8"));
    const svgOf = (id: string): string => {
      const e = ir.slides[0].elements.find((x: { id: string }) => x.id === `#${id}::image`);
      expect(e?.svg, id).toMatch(/^assets\/01-icons-img\d+\.svg$/);
      return fs.readFileSync(path.join(d, ".build", "embedded", e.svg), "utf8");
    };
    const [accent, black, soft, rooted] = ["ic-accent", "ic-black", "ic-soft", "ic-root"].map(svgOf);
    for (const s of [accent, black, soft, rooted]) expect(s).not.toMatch(/currentcolor/i);
    expect(accent).toContain('stroke="#C2410C"');
    expect(accent).toContain('<path d="M20 6 9 17l-5-5"/>'); // an opaque inherited paint: nothing to write on the path
    expect(black).toContain('fill="#000000"');
    expect(soft).toMatch(/<path stroke="#FFFFFF" [^>]*stroke-opacity="0\.6"/);
    expect(rooted).toMatch(/^<svg [^>]*stroke="#FFFFFF"[^>]*stroke-opacity="0\.6"/);
    expect(rooted).toMatch(/<path d="M20 6 9 17l-5-5" stroke="#FFFFFF" stroke-opacity="0\.6"\/>/);
    const slide = readZip(fs.readFileSync(path.join(d, "ic.pptx"))).get("ppt/slides/slide1.xml")!.toString("utf8");
    expect(slide.match(/<asvg:svgBlip /g)).toHaveLength(4);
  }, 300_000);

  /** {colour: count} of exact RRGGBB pixels in a PNG (Pillow). */
  const pixelCounts = (png: string, colors: string[]): Record<string, number> => {
    const count = [
      "import json, sys", "from PIL import Image",
      "have = {c: n for n, c in Image.open(sys.argv[1]).convert('RGB').getcolors(1 << 24)}",
      "print(json.dumps({h: have.get(tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)), 0) for h in sys.argv[2:]}))",
    ].join("\n");
    const px = spawnSync(process.env.NOAH_PPTX_PYTHON || "python3", ["-c", count, png, ...colors],
      { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(px.status, px.stderr).toBe(0);
    return JSON.parse(px.stdout);
  };

  it("theme tokens e2e: a token that needs the page — light-dark(), color-mix() with currentcolor — gives the IR exactly the colour the preview drew", () => {
    const root = tmp("chart-tokens-ctx");
    const spec = {
      type: "column", grouping: "clustered", categories: ["1Q", "2Q", "3Q"],
      series: [
        { name: "2025년", values: [80, 120, 140], color: "var(--t-ld)" },
        { name: "2026년", values: [90, 130, 150], color: "var(--t-mix)" },
      ],
      dataLabels: { show: false },
      valueAxis: { visible: false, min: 0, max: 200 },
      categoryAxis: { visible: true, labelColor: "3F4A5C", sizePx: 14, lineColor: "C9D0DB" },
      legend: { position: "none" },
    };
    // currentcolor inside the mix is the CHART's colour: only a probe in the page knows it
    const d = makeDeck(root, "tc", {
      "01-chart.html": chartSlide("분기별 값", spec, "{chart}", "position:absolute;left:80px;top:160px;width:1000px;height:400px;color:#2A52D9"),
    });
    fs.writeFileSync(path.join(d, "deck.css"), ":root { --t-ld: light-dark(#D94A2A, #2AD94A); --t-mix: color-mix(in srgb, currentcolor 70%, #000000); }\n");
    const r = deck(["build", d, "--strict", "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).lint.items.filter((l: { rule: string }) => l.rule === "chart-spec")).toEqual([]);
    const ir = JSON.parse(fs.readFileSync(path.join(d, ".build", "embedded", "ir.json"), "utf8"));
    const [ld, mix] = ir.slides[0].elements.find((e: { kind: string }) => e.kind === "chart").spec.series.map((s: { color: string }) => s.color);
    // the page's colour scheme is light; a context-free canvas read both values as opaque black
    expect(ld).toBe("D94A2A");
    expect(mix).toMatch(/^[0-9A-F]{6}$/);
    expect(mix).not.toBe("000000");
    // lib/chart.js drew the bars of the reference render in exactly the IR's colours, and the native chart has them
    const n = pixelCounts(path.join(d, ".build", "embedded", "html", "01-chart.png"), [ld, mix]);
    for (const c of [ld, mix]) expect(n[c], c).toBeGreaterThan(5000);
    const z = readZip(fs.readFileSync(path.join(d, "tc.pptx")));
    const xml = [...z.keys()].filter((k) => /^ppt\/charts\/chart\d+\.xml$/.test(k)).map((k) => z.get(k)!.toString("utf8")).join("\n");
    for (const c of [ld, mix]) expect(xml, c).toContain(`<a:srgbClr val="${c}"`);
  }, 300_000);

  it("theme-link e2e: a slide of a deck with deck.css that does not link it, or links it before base.css, warns in check and build and fails neither", () => {
    const root = tmp("theme-link");
    const body = (t: string) => `<p class="card-title" style="position:absolute;left:80px;top:80px">${t}</p>`;
    const deckLink = '<link rel="stylesheet" href="../deck.css">';
    const d = makeDeck(root, "tl", {
      "01-ok.html": SLIDE(body("연결됨"), deckLink),
      "02-missing.html": SLIDE(body("연결 안 됨")),
      "03-first.html": SLIDE(body("순서 틀림")).replace('<link rel="stylesheet" href="../theme/base.css">', `${deckLink}\n<link rel="stylesheet" href="../theme/base.css">`),
    });
    fs.writeFileSync(path.join(d, "deck.css"), ":root { --c-brand-600: #0F766E; }\n");
    const themeLink = (stdout: string) => (JSON.parse(stdout).lint.items as { slide: number; profile: string | null; severity: string; rule: string; message: string }[])
      .filter((l) => l.rule === "theme-link").map((l) => [l.slide, l.profile, l.severity, l.message]);
    const want = [
      [2, null, "warn", "this slide does not link ../deck.css, so it shows the kit's default theme, not the deck's: add <link rel=\"stylesheet\" href=\"../deck.css\"> after the ../theme/fonts.css link"],
      [3, null, "warn", "this slide links ../deck.css before ../theme/base.css, so the kit's default theme overrides the deck's: link ../deck.css last, after ../theme/base.css and ../theme/fonts.css"],
    ];
    const c = deck(["check", d, "--profile", "both", "--json"], {}, { timeout: 300_000 });
    expect(c.code, c.stderr).toBe(0);
    expect(themeLink(c.stdout)).toEqual(want); // once per slide, not per profile
    expect(c.stderr).toContain("LINT WARN slide 2 (02-missing) theme-link: this slide does not link ../deck.css");
    const only = deck(["check", d, "--only", "01-ok", "--json"], {}, { timeout: 300_000 });
    expect(only.code, only.stderr).toBe(0);
    expect(themeLink(only.stdout)).toEqual([]);
    const b = deck(["build", d, "--strict", "--json"], {}, { timeout: 300_000 });
    expect(b.code, b.stderr).toBe(0);
    expect(themeLink(b.stdout)).toEqual(want);
  }, 300_000);

  it("theme-color e2e: --pptx-dk1 lighter than --pptx-lt1 warns — the slots are semantic", () => {
    const root = tmp("theme-color");
    const d = makeDeck(root, "tcol", {
      "01-a.html": SLIDE('<p class="card-title" style="position:absolute;left:80px;top:80px">슬롯</p>', '<link rel="stylesheet" href="../deck.css">'),
    });
    fs.writeFileSync(path.join(d, "deck.css"), ":root { --pptx-dk1: #F2F5FA; --pptx-lt1: #0A0E1A; }\n");
    const r = deck(["check", d, "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.stderr).toBe(0);
    const items = (JSON.parse(r.stdout).lint.items as { slide: number; severity: string; rule: string; message: string }[]).filter((l) => l.rule === "theme-color");
    expect(items.map((l) => [l.slide, l.severity, l.message])).toEqual([[1, "warn",
      "--pptx-dk1 (#F2F5FA) is lighter than --pptx-lt1 (#0A0E1A): the slots are semantic — dk1 is the dark text/background colour and lt1 the light one, whatever the page colour (PowerPoint gives a dark slide's text lt1) — swap them in deck.css"]]);
    // the kit's own slots are semantic
    fs.writeFileSync(path.join(d, "deck.css"), ":root { }\n");
    const ok = deck(["check", d, "--json"], {}, { timeout: 300_000 });
    expect((JSON.parse(ok.stdout).lint.items as { rule: string }[]).filter((l) => l.rule === "theme-color")).toEqual([]);
  }, 300_000);

  it("dark colour map e2e: dark slides and layouts map text to lt1, a light slide on a dark layout keeps the identity map, a fill's default text is the more legible theme colour", () => {
    const root = tmp("clrmap");
    const at = (x: number, y: number, w: number, h: number, style: string) => `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;${style}`;
    const slideOn = (layout: string, bg: string, body: string) =>
      SLIDE(body).replace('<main class="slide" data-layout="본문">', `<main class="slide" data-layout="${layout}" style="background:${bg}">`);
    const text = (t: string, color: string) => `<p class="card-title" style="position:absolute;left:80px;top:80px;color:${color}">${t}</p>`;
    // #mark is identical on every 표지 slide: lifted into that layout from the LIGHT first slide, so its default text
    // is chosen again on the layout's (dark) map
    const mark = `<div id="mark" style="${at(1040, 600, 160, 48, "background:#FFFFFF")}"></div>`;
    const d = makeDeck(root, "cmap", {
      "01-cover.html": slideOn("표지", "#FFFFFF", text("밝은 표지", "#111A2E") + mark),
      "02-dark.html": slideOn("표지", "#0A0E1A", text("어두운 슬라이드", "#FFFFFF") + mark
        + `<div id="chip" style="${at(80, 200, 200, 120, "background:#FFFFFF")}"></div><div id="navy" style="${at(400, 200, 200, 120, "background:#1A2759")}"></div>`),
      "03-dark.html": slideOn("표지", "#0A0E1A", text("두 번째 어두운 슬라이드", "#FFFFFF") + mark),
      "04-light.html": slideOn("본문", "#FFFFFF", text("밝은 본문", "#111A2E")
        + `<div id="navy2" style="${at(80, 200, 200, 120, "background:#1A2759")}"></div><div id="white2" style="${at(400, 200, 200, 120, "background:#FFFFFF;border:1px solid #C9D0DB")}"></div>`),
    });
    const r = deck(["build", d, "--strict", "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).fidelity.status).toBe("pass"); // clrmap + default-text, both drift: --strict blocks them
    const buildDir = path.join(d, ".build", "embedded");
    const { dk1, lt1 } = JSON.parse(fs.readFileSync(path.join(buildDir, "ir.json"), "utf8")).theme.colors;
    expect([dk1, lt1]).toEqual([expect.stringMatching(/^[0-9A-F]{6}$/), "FFFFFF"]);
    const z = readZip(fs.readFileSync(path.join(d, "cmap.pptx")));
    const xml = (part: string) => z.get(part)!.toString("utf8");
    const MAP = (bg1: string, tx1: string, bg2: string, tx2: string) => `<p:clrMapOvr><a:overrideClrMapping bg1="${bg1}" tx1="${tx1}" bg2="${bg2}" tx2="${tx2}" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>`;
    const [DARK, LIGHT, INHERIT] = [MAP("dk1", "lt1", "dk2", "lt2"), MAP("lt1", "dk1", "lt2", "dk2"), "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>"];
    const mapOf = (part: string) => /<p:clrMapOvr>.*?<\/p:clrMapOvr>/.exec(xml(part))?.[0];
    expect([1, 2, 3, 4].map((n) => mapOf(`ppt/slides/slide${n}.xml`))).toEqual([LIGHT, DARK, DARK, INHERIT]);
    const layouts = [...z.keys()].filter((k) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(k));
    const layoutNamed = (name: string) => layouts.find((k) => xml(k).includes(`<p:cSld name="${name}">`))!;
    expect(mapOf(layoutNamed("표지"))).toBe(DARK);
    expect(mapOf(layoutNamed("본문"))).toBe(INHERIT);
    // the default run colour of each fill shape, found through the object map
    const map = JSON.parse(fs.readFileSync(path.join(buildDir, "deck.map.json"), "utf8"));
    const defaultText = (ir: string): string | null => {
      const part = map.parts.find((p: { objects: { ir: string }[] }) => p.objects.some((o) => o.ir === ir));
      const id = part.objects.find((o: { ir: string }) => o.ir === ir).shapeId;
      const sp = [...xml(part.part).matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).find((b) => b.includes(`<p:cNvPr id="${id}" `))!;
      expect(sp, ir).toBeTruthy();
      return /<a:lstStyle><a:lvl1pPr><a:defRPr><a:solidFill><a:srgbClr val="([0-9A-F]{6})"\/>/.exec(sp)?.[1] ?? (sp.includes("<a:lstStyle/>") ? null : "unexpected");
    };
    expect(map.parts.find((p: { objects: { ir: string }[] }) => p.objects.some((o) => o.ir === "#mark::bg")).kind).toBe("layout");
    expect(Object.fromEntries(["#mark::bg", "#chip::bg", "#navy::bg", "#navy2::bg", "#white2::bg"].map((id) => [id, defaultText(id)]))).toEqual({
      "#mark::bg": dk1, // white on the dark 표지 layout: its map gives lt1, so the dark colour is written
      "#chip::bg": dk1, // white on a dark slide: likewise
      "#navy::bg": null, // navy on a dark slide: tx1 = lt1 already
      "#navy2::bg": lt1, // navy on a light slide: white, as before
      "#white2::bg": null, // white on a light slide: tx1 = dk1 already
    });
    // the office-rules gate checked every override (CLR-01)
    const logs = path.join(d, ".build", "logs");
    const office = JSON.parse(fs.readFileSync(path.join(logs, fs.readdirSync(logs).sort().at(-1)!, "gates", "office-rules.json"), "utf8"))[0];
    expect(office.summary.checks_run["CLR-01"]).toBeGreaterThanOrEqual(6);
    expect(office.findings.filter((f: { check: string }) => f.check === "CLR-01")).toEqual([]);
  }, 300_000);

  const SLOT_ICON = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/></svg>';
  const slot = (id: string, style: string, prompt: string | null, inner = `${SLOT_ICON}<p class="photo-slot-hint">힌트: ${prompt ?? ""}</p>`) =>
    `<div class="photo-slot" id="${id}" data-placeholder="pic"${prompt === null ? "" : ` data-prompt="${prompt}"`} style="${style}">${inner}</div>`;

  it("photo slots e2e: a family of two slides with a lifted footer, one and two slots → picture placeholders idx 13 / 14 and their union in the layout (fresh ids, prompts); --strict, no builder warning; the gate catches a slot that is not one", () => {
    const root = tmp("slots");
    const at = (x: number) => `position:absolute;left:${x}px;top:184px;width:240px;height:240px`;
    const title = (t: string) => `<header class="slide-header"><h1 class="slide-title">${t}</h1></header>`;
    const footer = (n: number) => `<footer class="slide-footer" id="footer"><div class="footer-left"><p class="footer-brand">예시테크</p></div><div class="footer-right"><p class="footer-text">샘플 데이터</p><p class="page-num" data-field="slidenum">${n}</p></div></footer>`;
    // idx 14 is first used on the SECOND slide, whose ids collide with the chrome lifted from the first: the layout's
    // placeholders must take fresh ids (a builder warning would fail --strict)
    const d = makeDeck(root, "slots", {
      "01-one.html": SLIDE(title("사진 한 장") + slot("lead", at(80), "팀장 사진을 넣으세요") + footer(1)),
      "02-two.html": SLIDE(title("사진 두 장") + slot("lead2", at(80), "팀장 사진을 넣으세요") + slot("buddy", at(400), "버디 사진을 넣으세요") + footer(2)),
    });
    const r = deck(["build", d, "--strict", "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.stderr).toBe(0);
    const rep = JSON.parse(r.stdout);
    expect(rep.build).toMatchObject({ warnings: 0, skipped: 0 });
    expect(rep.fidelity.status).toBe("pass");
    const buildDir = path.join(d, ".build", "embedded");
    // the IR: one atomic element per slot (border box, prompt); the HTML-only hint never reaches it
    type El = { id: string; kind: string; prompt?: string | null; slot?: number; paragraphs?: unknown };
    const ir = JSON.parse(fs.readFileSync(path.join(buildDir, "ir.json"), "utf8"));
    const slotsOf = (i: number) => (ir.slides[i].elements as El[]).filter((e) => e.kind === "placeholder");
    expect(slotsOf(0)).toEqual([{ id: "#lead::placeholder", kind: "placeholder", box: { x: 80, y: 184, w: 240, h: 240 }, rotationDeg: 0, opacity: 1, placeholder: "pic", prompt: "팀장 사진을 넣으세요", slot: 0 }]);
    expect(slotsOf(1).map((e) => [e.id, e.prompt, e.slot])).toEqual([["#lead2::placeholder", "팀장 사진을 넣으세요", 0], ["#buddy::placeholder", "버디 사진을 넣으세요", 1]]);
    expect(JSON.stringify(ir.slides.map((s: { elements: El[] }) => s.elements.filter((e) => e.kind === "text")))).not.toContain("힌트");
    expect(ir.lint.filter((l: { rule: string }) => /placeholder/.test(l.rule))).toEqual([]);

    const pptx = path.join(d, "slots.pptx");
    const z = readZip(fs.readFileSync(pptx));
    const xml = (part: string) => z.get(part)!.toString("utf8");
    const picSps = (part: string) => [...xml(part).matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).filter((b) => b.includes('<p:ph type="pic"'));
    // the slides: an empty picture placeholder with an explicit spPr (xfrm = the border box, painting nothing), no txBody
    const s1 = picSps("ppt/slides/slide1.xml");
    expect(s1).toHaveLength(1);
    expect(s1[0]).toMatch(new RegExp('^<p:sp><p:nvSpPr><p:cNvPr id="\\d+" name="그림 개체 틀: 팀장 사진을 넣으세요"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
      + '<p:nvPr><p:ph type="pic" idx="13"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="762000" y="1752600"/><a:ext cx="2286000" cy="2286000"/></a:xfrm>'
      + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/></p:spPr></p:sp>$'));
    expect(picSps("ppt/slides/slide2.xml").map((b) => /idx="(\d+)"/.exec(b)![1])).toEqual(["13", "14"]);
    expect(xml("ppt/slides/slide2.xml")).not.toContain("힌트");
    // the layout: the union (13 from slide 1, 14 first used on slide 2), unique ids, the prompts, beside the lifted footer
    const map = JSON.parse(fs.readFileSync(path.join(buildDir, "deck.map.json"), "utf8"));
    type Obj = { shapeId: number; ir: string | null; kind: string; role: string; ph?: string; idx?: number };
    const slideObjs = (n: number): Obj[] => map.parts.find((p: { kind: string; slide?: number }) => p.kind === "slide" && p.slide === n).objects;
    expect(slideObjs(2).filter((o) => o.kind === "placeholder").map((o) => [o.ir, o.role, o.ph, o.idx])).toEqual([
      ["#lead2::placeholder", "main", "pic", 13], ["#buddy::placeholder", "main", "pic", 14]]);
    const lay = map.parts.find((p: { kind: string; name?: string }) => p.kind === "layout" && p.name === "본문");
    const ids = [...xml(lay.part).matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const lpics = picSps(lay.part);
    expect(lpics.map((b) => [/idx="(\d+)"/.exec(b)![1], /hasCustomPrompt="1"/.test(b), /<a:t>([^<]*)<\/a:t>/.exec(b)?.[1]])).toEqual([
      ["13", true, "팀장 사진을 넣으세요"], ["14", true, "버디 사진을 넣으세요"]]);
    for (const b of lpics) {
      expect(b).toContain('<a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="1400">');
      expect(b).toContain('<a:r><a:rPr lang="ko-KR" altLang="en-US"/>');
    }
    expect((lay.objects as Obj[]).filter((o) => o.role === "layout-placeholder").map((o) => [o.ph, o.idx ?? null, o.ir])).toEqual([
      ["title", null, null], ["pic", 13, null], ["pic", 14, null]]);
    expect((lay.objects as Obj[]).some((o) => o.ir === "#footer::border-top")).toBe(true);
    // office-rules: every idx unique and linked to a layout placeholder of its type (PH-01 / SLD-02 / SLD-03 ran)
    const logs = path.join(d, ".build", "logs");
    const office = JSON.parse(fs.readFileSync(path.join(logs, fs.readdirSync(logs).sort().at(-1)!, "gates", "office-rules.json"), "utf8"))[0];
    for (const c of ["PH-01", "SLD-02", "SLD-03"]) {
      expect(office.summary.checks_run[c], c).toBeGreaterThan(0);
      expect(office.findings.filter((f: { check: string }) => f.check === c), c).toEqual([]);
    }
    // schema: the slide, layout and master parts validate against ECMA-376 PresentationML (the vendored pml.xsd). The
    // Open XML SDK validator (a repair-prompt proxy) cannot run on a dev box without .NET: where one is built
    // (NOAH_OPENXML_VALIDATOR_DLL + dotnet) it runs here too; the deck Docker smoke always runs it
    const py = process.env.NOAH_PPTX_PYTHON || "python3";
    const xsd = spawnSync(py, ["-c", [
      "import re, sys, zipfile", "from lxml import etree",
      "schema = etree.XMLSchema(etree.parse(sys.argv[1])); z = zipfile.ZipFile(sys.argv[2]); bad = []",
      "for n in sorted(z.namelist()):",
      "    if re.match(r'ppt/(slides/slide|slideLayouts/slideLayout|slideMasters/slideMaster)\\d+\\.xml$', n) and not schema.validate(etree.fromstring(z.read(n))):",
      "        bad.append(f'{n}: {schema.error_log.last_error}')",
      "print('\\n'.join(bad)); sys.exit(1 if bad else 0)",
    ].join("\n"), path.join(KIT, "tools", "gates", "xsd", "pml.xsd"), pptx], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(xsd.status, `${xsd.stdout}${xsd.stderr}`).toBe(0);
    const dll = process.env.NOAH_OPENXML_VALIDATOR_DLL;
    if (dll && spawnSync("dotnet", ["--version"]).status === 0) {
      const v = spawnSync("dotnet", [dll, pptx], { encoding: "utf8" });
      expect(v.status, v.stdout).toBe(0);
      expect(v.stdout).toContain(": 0 error(s)");
    }

    // the gate: a slot written as an ordinary shape is `object` (blocking); a wrong idx is `placeholder` drift (and an
    // unlinked placeholder); a later slide whose data-prompt differs from the layout's shows the wrong prompt (drift)
    const irMut = path.join(buildDir, "ir-mut.json");
    const irJson = JSON.parse(fs.readFileSync(path.join(buildDir, "ir.json"), "utf8"));
    irJson.slides[1].elements.find((e: El) => e.id === "#lead2::placeholder").prompt = "팀원 사진을 넣으세요";
    fs.writeFileSync(irMut, JSON.stringify(irJson));
    const neg = spawnSync(py, ["-c", [
      "import json, subprocess, sys, zipfile",
      "kit, src, ir, ir_mut, mp = sys.argv[1:6]",
      "def mutated(tag, part, old, new):",
      "    dst = f'{src}.{tag}.pptx'; zin = zipfile.ZipFile(src); zout = zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED)",
      "    for i in zin.infolist():",
      "        b = zin.read(i.filename)",
      "        if i.filename == part:",
      "            assert old in b, (part, old); b = b.replace(old, new, 1)",
      "        zout.writestr(i, b)",
      "    zout.close(); return dst",
      "def problems(pptx, irp):",
      "    out = pptx + '.json'",
      "    subprocess.run([sys.executable, '-B', f'{kit}/tools/check_fidelity.py', 'structure', pptx, '--ir', irp, '--profile', 'embedded', '--map', mp, '--json', out], capture_output=True)",
      "    return sorted({(p['check'], p['ir'] or '') for p in json.load(open(out))['problems']})",
      "print(json.dumps({",
      "    'shape': problems(mutated('shape', 'ppt/slides/slide1.xml', b'<p:nvPr><p:ph type=\"pic\" idx=\"13\"/></p:nvPr>', b'<p:nvPr/>'), ir),",
      "    'idx': problems(mutated('idx', 'ppt/slides/slide2.xml', b'idx=\"14\"', b'idx=\"15\"'), ir),",
      "    'prompt': problems(src, ir_mut),",
      "}))",
    ].join("\n"), KIT, pptx, path.join(buildDir, "ir.json"), irMut, path.join(buildDir, "deck.map.json")], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(neg.status, neg.stderr).toBe(0);
    expect(JSON.parse(neg.stdout)).toEqual({
      shape: [["object", "#lead::placeholder"]],
      idx: [["placeholder", "#buddy::placeholder"], ["placeholder-link", ""]],
      prompt: [["placeholder", "#lead2::placeholder"]],
    });
  }, 300_000);

  it("photo slot prompts e2e: the prompt is coloured for the slot's own frame — on the slide, and in the layout only where that frame is lifted chrome; slots pair in document order; photo slides sharing a layout with slot-less ones warn; --strict", () => {
    const root = tmp("slot-colour");
    const at = (x: number, y: number, w: number, h: number, extra = "") => `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;${extra}`;
    const on = (layout: string, bg: string | null, body: string) =>
      SLIDE(body).replace('<main class="slide" data-layout="본문">', `<main class="slide" data-layout="${layout}"${bg ? ` style="background:${bg}"` : ""}>`);
    const h1 = (t: string, color: string, x = 80, w = 1120) => `<h1 style="position:absolute;left:${x}px;top:56px;width:${w}px;margin:0;font-size:40px;line-height:56px;font-weight:800;color:${color}">${t}</h1>`;
    const DARK = "#0F1D4A"; // the kit's brand-900
    const well = at(720, 200, 400, 400);
    const row = (a: string, b: string) => `<section style="margin:220px 0 0 80px;display:flex;gap:32px;width:600px">${a}${b}</section>`;
    const d = makeDeck(root, "sc", {
      // a dark slide of its own layout with the kit's light frame: the slide colours its prompt, the layout keeps tx1
      "01-dark.html": on("어두운 사진", DARK, slot("site", at(0, 0, 640, 720), "현장 사진을 넣으세요") + h1("어두운 슬라이드", "#FFFFFF", 720, 480)),
      // a dark family whose #well is identical on every slide: its frame is lifted into the layout, whose prompt then
      // carries the colour; on slide 4 another slot (#dim, a dark well) comes first in the markup and takes idx 13
      "02-lift-a.html": on("어두운 세 장", DARK, h1("하나", "#FFFFFF") + slot("well", well, "현장 사진을 넣으세요")),
      "03-lift-b.html": on("어두운 세 장", DARK, h1("둘", "#FFFFFF") + slot("well", well, "현장 사진을 넣으세요")),
      "04-lift-c.html": on("어두운 세 장", DARK, h1("셋", "#FFFFFF") + slot("dim", at(80, 200, 400, 400, "background:#2A52D9"), "현장 사진을 넣으세요")
        + slot("well", well, "현장 사진을 넣으세요")),
      // a light slide with a dark photo well; the same layout without any slot (placeholder-layout)
      "05-dark-well.html": on("본문", null, h1("밝은 슬라이드", "#111A2E") + slot("dwell", at(80, 200, 400, 400, `background:${DARK}`), "매장 사진을 넣으세요")),
      "06-plain.html": on("본문", null, h1("사진 없는 본문", "#111A2E") + '<p class="card-title" style="position:absolute;left:80px;top:200px">본문 한 줄</p>'),
      // paint order 2, 3, 1 (an absolutely positioned slot first in the markup, then an in-flow flex row) vs 1, 2, 3
      "07-mix-a.html": on("세 칸", null, h1("섞인 배치", "#111A2E") + slot("m1", at(900, 220, 240, 200), "첫째 사진을 넣으세요")
        + row(slot("m2", "flex:none;width:240px;height:200px", "둘째 사진을 넣으세요"), slot("m3", "flex:none;width:240px;height:200px", "셋째 사진을 넣으세요"))),
      "08-mix-b.html": on("세 칸", null, h1("모두 절대 배치", "#111A2E") + slot("n1", at(80, 220, 240, 200), "첫째 사진을 넣으세요")
        + slot("n2", at(400, 220, 240, 200), "둘째 사진을 넣으세요") + slot("n3", at(720, 220, 240, 200), "셋째 사진을 넣으세요")),
    });
    const r = deck(["build", d, "--strict", "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.stderr).toBe(0);
    const rep = JSON.parse(r.stdout);
    expect(rep.build).toMatchObject({ warnings: 0, skipped: 0 });
    expect(rep.fidelity.status).toBe("pass"); // the prompt colour on each frame is a `placeholder` / `layout-prompt` check
    // placeholder-layout: once, on the photo slide, naming the slide without a slot (a warning: --strict still builds)
    type Lint = { slide: number; profile: string | null; severity: string; rule: string; path: string | null; message: string };
    const fam = (rep.lint.items as Lint[]).filter((l) => l.rule === "placeholder-layout");
    expect(fam.map((l) => [l.slide, l.profile, l.severity, l.path])).toEqual([[5, null, "warn", null]]);
    expect(fam[0].message).toContain('slide 5 (05-dark-well) puts photo slots into the layout "본문", which slide 6 (06-plain) also uses');
    const buildDir = path.join(d, ".build", "embedded");
    const ir = JSON.parse(fs.readFileSync(path.join(buildDir, "ir.json"), "utf8"));
    type El = { id: string; kind: string; slot?: number; fill?: { color: string } | null };
    const els = (n: number) => ir.slides[n - 1].elements as El[];
    // the IR lists slots in paint order, numbered in document order: slide 7 paints 2, 3, 1
    const slotsOf = (n: number) => els(n).filter((e) => e.kind === "placeholder").map((e) => [e.id, e.slot]);
    expect(slotsOf(7)).toEqual([["#m2::placeholder", 1], ["#m3::placeholder", 2], ["#m1::placeholder", 0]]);
    expect(slotsOf(8)).toEqual([["#n1::placeholder", 0], ["#n2::placeholder", 1], ["#n3::placeholder", 2]]);
    expect(slotsOf(4)).toEqual([["#dim::placeholder", 0], ["#well::placeholder", 1]]);

    // the prompt colour PowerPoint resolves: the slide's own lstStyle, else its layout placeholder's, else tx1 on the
    // slide's colour map (its own override, else its layout's, else the master's identity map)
    const { dk1, lt1 } = ir.theme.colors as Record<string, string>;
    expect([dk1, lt1]).toEqual(["111A2E", "FFFFFF"]);
    const z = readZip(fs.readFileSync(path.join(d, "sc.pptx")));
    const xml = (part: string) => z.get(part)!.toString("utf8");
    const map = JSON.parse(fs.readFileSync(path.join(buildDir, "deck.map.json"), "utf8"));
    const layoutPart = (name: string): string => map.parts.find((p: { kind: string; name?: string }) => p.kind === "layout" && p.name === name).part;
    const layoutOf = (n: number) => `ppt/slideLayouts/${/Target="\.\.\/slideLayouts\/(slideLayout\d+\.xml)"/.exec(xml(`ppt/slides/_rels/slide${n}.xml.rels`))![1]}`;
    const picSp = (part: string, idx: number) => [...xml(part).matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((m) => m[0]).find((b) => b.includes(`<p:ph type="pic" idx="${idx}"`));
    const own = (sp: string | undefined) => (sp && /<a:lstStyle><a:lvl1pPr[^>]*>(?:<a:buNone\/>)?<a:defRPr[^>]*><a:solidFill><a:srgbClr val="([0-9A-F]{6})"\/>/.exec(sp)?.[1]) || null;
    const tx1 = (part: string) => /<a:overrideClrMapping [^>]*\btx1="(\w+)"/.exec(xml(part))?.[1] ?? null;
    const theme: Record<string, string> = { dk1, lt1 };
    const shown = (n: number, idx: number) => {
      const s = `ppt/slides/slide${n}.xml`;
      const lay = layoutOf(n);
      return { own: own(picSp(s, idx)), layout: own(picSp(lay, idx)), resolved: own(picSp(s, idx)) ?? own(picSp(lay, idx)) ?? theme[tx1(s) ?? tx1(lay) ?? "dk1"] };
    };
    expect(shown(1, 13)).toEqual({ own: dk1, layout: null, resolved: dk1 }); // dark slide, light frame: was lt1 (1.14:1)
    expect(shown(2, 13)).toEqual({ own: null, layout: dk1, resolved: dk1 }); // the lifted frame's colour, from the layout
    expect(shown(3, 13)).toEqual({ own: null, layout: dk1, resolved: dk1 });
    expect(shown(4, 13)).toEqual({ own: lt1, layout: dk1, resolved: lt1 }); // #dim's dark well overrides the layout's
    expect(shown(4, 14)).toEqual({ own: null, layout: dk1, resolved: dk1 });
    expect(shown(5, 13)).toEqual({ own: lt1, layout: null, resolved: lt1 }); // a light slide's dark photo well
    for (const [n, idx] of [[7, 13], [7, 14], [7, 15], [8, 13], [8, 14], [8, 15]]) expect(shown(n, idx), `slide ${n} idx ${idx}`).toEqual({ own: null, layout: null, resolved: dk1 });
    // every prompt ≥ 4.5:1 on its slot's own frame (the IR's ::bg shape of the slot)
    const lum = (h: string) => {
      const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    for (const [n, idx, sid] of [[1, 13, "site"], [2, 13, "well"], [3, 13, "well"], [4, 13, "dim"], [4, 14, "well"], [5, 13, "dwell"], [7, 13, "m1"], [8, 14, "n2"]] as [number, number, string][]) {
      const frame = els(n).find((e) => e.id === `#${sid}::bg`)!.fill!.color;
      expect(contrast(shown(n, idx).resolved, frame), `slide ${n} #${sid} on ${frame}`).toBeGreaterThanOrEqual(4.5);
    }
    // the slide's colour-only txBody: after spPr, no run, no hasCustomPrompt
    expect(picSp("ppt/slides/slide1.xml", 13)).toMatch(new RegExp('<p:ph type="pic" idx="13"/></p:nvPr></p:nvSpPr><p:spPr>.*</p:spPr><p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr><a:solidFill><a:srgbClr val="111A2E"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="ko-KR" altLang="en-US"/></a:p></p:txBody></p:sp>$'));
    // layouts: a New Slide shows the prompt on the layout's own background (tx1 on its map) unless the frame was lifted
    const dark1 = layoutPart("어두운 사진");
    expect(own(picSp(dark1, 13))).toBeNull();
    expect(tx1(dark1)).toBe("lt1");
    expect(contrast(lt1, "0F1D4A")).toBeGreaterThan(4.5);
    const dark3 = layoutPart("어두운 세 장");
    expect(map.parts.find((p: { part: string }) => p.part === dark3).objects.filter((o: { ir: string | null }) => o.ir === "#well::bg").map((o: { role: string }) => o.role).sort()).toEqual(["border", "fill"]);
    for (const idx of [13, 14]) expect(picSp(dark3, idx), `idx ${idx}`).toContain('<a:defRPr sz="1400"><a:solidFill><a:srgbClr val="111A2E"/></a:solidFill><a:latin typeface=');
    for (const name of ["본문", "세 칸"]) expect(picSp(layoutPart(name), 13), name).not.toContain("<a:solidFill>");
    // schema: the slide, layout and master parts validate against ECMA-376 PresentationML (the vendored pml.xsd)
    const py = process.env.NOAH_PPTX_PYTHON || "python3";
    const pptx = path.join(d, "sc.pptx");
    const xsd = spawnSync(py, ["-c", [
      "import re, sys, zipfile", "from lxml import etree",
      "schema = etree.XMLSchema(etree.parse(sys.argv[1])); z = zipfile.ZipFile(sys.argv[2]); bad = []",
      "for n in sorted(z.namelist()):",
      "    if re.match(r'ppt/(slides/slide|slideLayouts/slideLayout|slideMasters/slideMaster)\\d+\\.xml$', n) and not schema.validate(etree.fromstring(z.read(n))):",
      "        bad.append(f'{n}: {schema.error_log.last_error}')",
      "print('\\n'.join(bad)); sys.exit(1 if bad else 0)",
    ].join("\n"), path.join(KIT, "tools", "gates", "xsd", "pml.xsd"), pptx], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(xsd.status, `${xsd.stdout}${xsd.stderr}`).toBe(0);

    // the gate: the dark slide without its colour (white on the light frame again), a prompt run in a slide slot, a
    // colour in a layout whose slot frame was not lifted — each drift
    const TXB = '<p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr><a:solidFill><a:srgbClr val="111A2E"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle><a:p><a:endParaRPr lang="ko-KR" altLang="en-US"/></a:p></p:txBody>';
    const neg = spawnSync(py, ["-c", [
      "import json, subprocess, sys, zipfile",
      "kit, src, ir, mp, lay, txb = sys.argv[1:7]",
      "def mutated(tag, part, old, new):",
      "    dst = f'{src}.{tag}.pptx'; zin = zipfile.ZipFile(src); zout = zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED)",
      "    for i in zin.infolist():",
      "        b = zin.read(i.filename)",
      "        if i.filename == part:",
      "            assert old in b, (part, old); b = b.replace(old, new, 1)",
      "        zout.writestr(i, b)",
      "    zout.close(); return dst",
      "def problems(pptx):",
      "    out = pptx + '.json'",
      "    subprocess.run([sys.executable, '-B', f'{kit}/tools/check_fidelity.py', 'structure', pptx, '--ir', ir, '--profile', 'embedded', '--map', mp, '--json', out], capture_output=True)",
      "    return sorted({(p['check'], p['ir'] or '') for p in json.load(open(out))['problems']})",
      "t = txb.encode()",
      "print(json.dumps({",
      "    'uncoloured': problems(mutated('uncoloured', 'ppt/slides/slide1.xml', t, b'')),",
      "    'run': problems(mutated('run', 'ppt/slides/slide1.xml', t, t.replace(b'<a:p><a:endParaRPr', b'<a:p><a:r><a:rPr lang=\"ko-KR\"/><a:t>x</a:t></a:r><a:endParaRPr'))),",
      "    'layout': problems(mutated('layout', lay, b'<a:defRPr sz=\"1400\"><a:latin', b'<a:defRPr sz=\"1400\"><a:solidFill><a:srgbClr val=\"FFFFFF\"/></a:solidFill><a:latin')),",
      "}))",
    ].join("\n"), KIT, pptx, path.join(buildDir, "ir.json"), path.join(buildDir, "deck.map.json"), layoutPart("본문"), TXB], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    expect(neg.status, neg.stderr).toBe(0);
    expect(JSON.parse(neg.stdout)).toEqual({
      uncoloured: [["placeholder", "#site::placeholder"]],
      run: [["placeholder", "#site::placeholder"]],
      layout: [["layout-prompt", ""]],
    });
  }, 300_000);

  it("photo slot lints e2e: data-prompt, content, placement and rotation are errors, a rounded slot warns, each on its own element; a slot that is a stacking context stays one object", () => {
    const root = tmp("slot-lint");
    const at = (x: number, y: number, extra = "") => `position:absolute;left:${x}px;top:${y}px;width:160px;height:160px;${extra}`;
    const d = makeDeck(root, "sl", {
      "01-prompt.html": SLIDE([
        slot("none", at(40, 40), null), slot("lines", at(240, 40), "첫 줄\n둘째 줄"),
        slot("long", at(440, 40), "가".repeat(81)), slot("max", at(640, 40), "나".repeat(80)),
      ].join("\n")),
      "02-content.html": SLIDE([
        slot("round", at(40, 40, "border-radius:16px"), "둥근 칸"),
        slot("rot", at(240, 40, "transform:rotate(5deg)"), "회전한 칸"),
        slot("withimg", at(440, 40), "사진이 든 칸", '<img src="../assets/photo.jpg" alt="" style="width:40px;height:40px">'),
        `<img id="onimg" data-placeholder="pic" data-prompt="그림 위" src="../assets/photo.jpg" alt="" style="${at(640, 40)}">`,
        '<p class="card-title" style="position:absolute;left:40px;top:300px">글 <span id="onspan" data-placeholder="pic">인라인</span> 끝</p>',
        '<table id="tbl" style="position:absolute;left:40px;top:400px"><tr><td><div id="intable" data-placeholder="pic" data-prompt="표 안">칸</div></td></tr></table>',
        slot("outer", at(840, 40), "바깥 칸", '<div id="inner" data-placeholder="pic" data-prompt="안쪽 칸" style="width:40px;height:40px"></div>'),
        slot("zslot", at(1040, 40, "z-index:2"), "쌓임 맥락", '<p style="position:absolute;left:8px;top:8px">위치 잡은 힌트</p>'),
      ].join("\n")),
      "03-root.html": SLIDE('<p class="card-title" style="position:absolute;left:80px;top:80px">루트</p>')
        .replace('<main class="slide" data-layout="본문">', '<main class="slide" data-layout="본문" data-placeholder="pic">'),
      // placeholder-size: the kit's dashed frame around a slot without a height (its hint positioned) is 240×4; without a
      // border 240×0; no width 0×200; a 20 px slot without a prompt is reported for both, the prompt first
      "04-size.html": SLIDE([
        slot("autoh", "position:absolute;left:40px;top:40px;width:240px;height:auto", "높이 자동 칸", '<p class="photo-slot-hint" style="position:absolute;left:0;top:0;width:240px">힌트</p>'),
        slot("zeroh", "position:absolute;left:320px;top:40px;width:240px;height:auto;border:0;background:none", "테두리 없는 칸", '<p class="photo-slot-hint" style="position:absolute;left:0;top:0;width:240px">힌트</p>'),
        slot("zerow", "position:absolute;left:600px;top:40px;width:0;height:200px;border:0;padding:0", "폭 없는 칸", '<p class="photo-slot-hint" style="position:absolute;left:0;top:0;width:200px">힌트</p>'),
        slot("tiny", "position:absolute;left:900px;top:40px;width:20px;height:20px;border:0", null, ""),
      ].join("\n")),
      // a slot's hint is HTML-only: CSS PowerPoint cannot reproduce is no lint there (it never reaches the .pptx)
      "05-hint.html": SLIDE([
        slot("shadow", at(40, 40), "그림자 힌트", '<p class="photo-slot-hint" id="shadowhint" style="text-shadow:0 1px 2px rgba(0,0,0,0.4)">그림자 힌트</p>'),
        slot("filt", at(240, 40), "필터 힌트", `${SLOT_ICON.replace("<svg ", '<svg id="filtericon" style="filter:blur(0.5px)" ')}<p class="photo-slot-hint" id="filterhint" style="filter:blur(0.5px)">필터 힌트</p>`),
        slot("clip", at(440, 40, "overflow:hidden"), "잘린 힌트", '<p class="photo-slot-hint" id="cliphint" style="width:400px;white-space:nowrap">잘린 힌트가 칸 밖으로 넘칩니다 아주 길게</p>'),
        // a clipping card around a slot: the slot fits, only its (dropped) hint overflows — no lint either
        `<div id="clipcard" style="position:absolute;left:640px;top:40px;width:200px;height:200px;overflow:hidden">${slot("inclip", "width:160px;height:160px", "카드 안 칸", '<p class="photo-slot-hint" id="cliphint2" style="width:400px;white-space:nowrap">카드 밖으로 넘치는 힌트입니다 아주 길게</p>')}</div>`,
        // the slot itself is still linted like any element: its frame is a shape PowerPoint draws
        slot("filtslot", at(880, 40, "filter:blur(1px)"), "필터 칸"),
      ].join("\n")),
    });
    fs.mkdirSync(path.join(d, "assets"));
    fs.copyFileSync(path.join(KIT, "selftest", "features", "assets", "photo.jpg"), path.join(d, "assets", "photo.jpg"));
    const r = deck(["check", d, "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.stderr).toBe(1);
    type Lint = { slide: number; severity: string; rule: string; path: string | null; message: string };
    const all = JSON.parse(r.stdout).lint.items as Lint[];
    const items = all.filter((l) => /placeholder/.test(l.rule));
    const got = items.map((l) => [l.slide, l.severity, l.rule, l.path]).sort((a, b) => String(a).localeCompare(String(b)));
    expect(got).toEqual([
      [1, "error", "placeholder-prompt", "#lines"], [1, "error", "placeholder-prompt", "#long"], [1, "error", "placeholder-prompt", "#none"],
      [1, "warn", "placeholder-layout", null],
      [2, "error", "placeholder-content", "#intable"], [2, "error", "placeholder-content", "#onimg"], [2, "error", "placeholder-content", "#onspan"],
      [2, "error", "placeholder-content", "#outer"], [2, "error", "placeholder-content", "#withimg"],
      [2, "error", "rotated-placeholder", "#rot"], [2, "warn", "placeholder-geometry", "#round"],
      [3, "error", "placeholder-content", "main.slide"],
      [4, "error", "placeholder-prompt", "#tiny"],
      [4, "error", "placeholder-size", "#autoh"], [4, "error", "placeholder-size", "#tiny"], [4, "error", "placeholder-size", "#zeroh"], [4, "error", "placeholder-size", "#zerow"],
    ].sort((a, b) => String(a).localeCompare(String(b))));
    const size = (p: string) => items.find((l) => l.path === p && l.rule === "placeholder-size")!.message;
    expect([size("#autoh"), size("#zeroh"), size("#zerow"), size("#tiny")].map((m) => /is (\S+) px, too small/.exec(m)![1])).toEqual(["240×4", "240×0", "0×200", "20×20"]);
    expect(size("#autoh")).toContain("give the slot an explicit width and height");
    expect(items.findIndex((l) => l.path === "#tiny" && l.rule === "placeholder-prompt")).toBeLessThan(items.findIndex((l) => l.path === "#tiny" && l.rule === "placeholder-size"));
    // the slide without a slot shares 본문 with the photo slides
    expect(items.find((l) => l.rule === "placeholder-layout")!.message).toContain('put photo slots into the layout "본문", which slide 3 (03-root) also uses');
    // nothing on a hint: no text-shadow / filter errors, no overflow-clip warning — but the slot itself keeps its lints
    expect(all.filter((l) => /shadowhint|filterhint|filtericon|cliphint/.test(String(l.path)))).toEqual([]);
    expect(all.filter((l) => ["text-shadow", "filter", "overflow-clip"].includes(l.rule)).map((l) => [l.slide, l.severity, l.rule, l.path])).toEqual([[5, "error", "filter", "#filtslot"]]);
    const msg = (p: string) => items.find((l) => l.path === p)!.message;
    expect(msg("#withimg")).toBe("the photo slot holds an <img>: everything inside a slot is an HTML-only hint the converter drops (PowerPoint gets an EMPTY picture placeholder) — keep only an icon and a <p> hint inside, and put captions, pictures and other content next to the slot");
    expect(msg("#outer")).toContain("the photo slot holds another photo slot");
    expect(msg("#onspan")).toContain("data-placeholder=\"pic\" on an element with display: inline: a photo slot needs a box of its own");
    expect(msg("#intable")).toContain("data-placeholder=\"pic\" inside a <table> is never converted");
    expect(msg("#round")).toContain("(border-radius: 16px)");
    expect(r.stderr).toContain("placeholder-prompt: §7");
    // the IR: an invalid prompt is null, a rotated slot keeps its rotation (the error blocks the build), and a slot that is a
    // stacking context is its frame + the slot — its positioned hint never becomes an object
    const ir = JSON.parse(fs.readFileSync(path.join(d, ".build", "check", "embedded", "ir.json"), "utf8"));
    const els = (i: number) => ir.slides[i].elements as { id: string; kind: string; prompt?: string | null; rotationDeg: number }[];
    expect(els(0).filter((e) => e.kind === "placeholder").map((e) => [e.id, e.prompt === null ? null : e.prompt!.length])).toEqual([
      ["#none::placeholder", null], ["#lines::placeholder", 8], ["#long::placeholder", 81], ["#max::placeholder", 80]]);
    expect(els(1).find((e) => e.id === "#rot::placeholder")!.rotationDeg).toBe(5);
    expect(els(1).filter((e) => e.id.startsWith("#zslot")).map((e) => e.id)).toEqual(["#zslot::bg", "#zslot::placeholder"]);
    expect(JSON.stringify(els(1))).not.toContain("위치 잡은 힌트");
    // misplaced attributes convert as they otherwise would: the picture stays a picture, the span stays text
    expect(els(1).find((e) => e.id === "#onimg::image")).toBeTruthy();
    expect(JSON.stringify(els(1).filter((e) => e.kind === "text"))).toContain("인라인");
    // a degenerate slot is still emitted with its measured box (the error blocks the build), numbered in document order
    const sized = (els(3) as unknown as { id: string; kind: string; box: { w: number; h: number }; slot: number }[]).filter((e) => e.kind === "placeholder");
    expect(sized.map((e) => [e.id, e.box.w, e.box.h, e.slot])).toEqual([
      ["#autoh::placeholder", 240, 4, 0], ["#zeroh::placeholder", 240, 0, 1], ["#zerow::placeholder", 0, 200, 2], ["#tiny::placeholder", 20, 20, 3]]);
  }, 300_000);

  it("text-on-picture e2e: text over an <img> or a photo slot needs a layer that holds for ANY photo — in check and build, both profiles; the passing slides build with --strict", () => {
    const root = tmp("on-picture");
    const photo = '<img id="photo" src="../assets/photo.jpg" alt="합성 사진" style="position:absolute;left:0;top:0;width:1280px;height:720px;object-fit:cover">';
    const scrim = (id: string, style: string) => `<div id="${id}" style="position:absolute;background:var(--c-brand-950);${style}"></div>`;
    const h1 = (id: string, t: string, top = 200, color = "var(--c-white)") =>
      `<h1 id="${id}" style="position:absolute;left:80px;top:${top}px;width:640px;margin:0;font-size:56px;line-height:76px;font-weight:800;color:${color}">${t}</h1>`;
    const lead = (id: string, t: string) =>
      `<p id="${id}" style="position:absolute;left:80px;top:320px;width:600px;margin:0;font-size:22px;line-height:32px;color:rgba(255, 255, 255, 0.8)">${t}</p>`;
    const photoSlot = (id: string) => `<div class="photo-slot" id="${id}" data-placeholder="pic" data-prompt="배경 사진을 넣으세요" style="position:absolute;left:0;top:0;width:1280px;height:720px">${SLOT_ICON}<p class="photo-slot-hint">배경 사진을 넣으세요</p></div>`;
    const on = (layout: string, body: string) => SLIDE(body).replace('<main class="slide" data-layout="본문">', `<main class="slide" data-layout="${layout}">`);
    const d = makeDeck(root, "onpic", {
      // a brand-950 scrim at 0.72 under white text (the lead 80 % white): legible over every photo
      "01-scrim.html": on("사진 표지", photo + scrim("scrim", "left:0;top:0;width:760px;height:720px;opacity:0.72") + h1("t1", "사진 위 제목") + lead("l1", "막이 모든 사진에서 글자를 지킵니다")),
      "02-bare.html": on("사진 표지 2", photo + h1("t2", "막 없는 제목")),
      // 0.5: the display headline keeps the 3:1 large text needs, the 22 px lead misses 4.5:1
      "03-thin.html": on("사진 표지 3", photo + scrim("thin", "left:0;top:0;width:760px;height:720px;opacity:0.5") + h1("t3", "큰 제목은 괜찮습니다") + lead("l3", "작은 본문은 부족합니다")),
      // a photo slot: the band keeps the headline legible for whatever photo the user inserts; the slot's hint is exempt
      "04-slot.html": on("사진 칸 표지", photoSlot("slot4") + scrim("band", "left:0;top:408px;width:1280px;height:312px;opacity:0.72") + h1("t4", "사진 칸 위 제목", 480)),
      "05-slot-bare.html": on("사진 칸 표지 2", photoSlot("slot5") + h1("t5", "사진 칸 위 제목", 480)),
      // an inline <svg> icon is no picture
      "06-icon.html": on("아이콘", `<div style="position:absolute;left:80px;top:160px;width:400px;height:400px;color:var(--c-brand-600)">${SLOT_ICON.replace('width="32" height="32"', 'width="400" height="400"')}</div>`
        + h1("t6", "아이콘 위 제목", 300, "var(--c-ink-900)")),
    });
    fs.mkdirSync(path.join(d, "assets"));
    fs.copyFileSync(path.join(KIT, "selftest", "features", "assets", "photo.jpg"), path.join(d, "assets", "photo.jpg"));
    type Lint = { slide: number; profile: string | null; severity: string; rule: string; path: string | null; message: string };
    const onPicture = (items: Lint[]) => items.filter((l) => l.rule === "text-on-picture");
    const r = deck(["check", d, "--profile", "both", "--json"], {}, { timeout: 300_000 });
    expect(r.code, r.stderr).toBe(1);
    const items = onPicture(JSON.parse(r.stdout).lint.items as Lint[]);
    expect(items.map((l) => [l.slide, l.profile, l.severity, l.path]).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      [2, "embedded", "error", "#t2"], [2, "malgun", "error", "#t2"], [3, "embedded", "error", "#l3"], [3, "malgun", "error", "#l3"],
      [5, "embedded", "error", "#t5"], [5, "malgun", "error", "#t5"],
    ]);
    const msg = (p: string) => items.find((l) => l.path === p && l.profile === "embedded")!.message;
    expect(msg("#t2")).toBe('its text ("막 없는 제목") is painted on the picture #photo at a worst-case contrast of 1:1, below the 3:1 large text needs — it lies on the bare picture, with no layer between them. A photo can put any colour behind text, pure white and pure black included; fix: a scrim under the text (a dark token box, e.g. var(--c-brand-950) at opacity ≥ 0.72, under white text; or a light one under dark text), an opaque card, or move the text off the picture (AUTHORING §7)');
    expect(msg("#l3")).toMatch(/^its text \("작은 본문은 부족합니다"\) is painted on the picture #photo at a worst-case contrast of [23]\.\d+:1, below the 4\.5:1 it needs \(3:1 only when every run is ≥ 24 px, or ≥ 18\.66 px at weight ≥ 700\) — the layer between them \(#thin\) still lets 50 % of the picture through at the weakest point, and the text colour itself is translucent \(alpha 0\.8\)\. /);
    expect(msg("#t5")).toContain("is painted on the photo slot #slot5 (any photo the user inserts) at a worst-case contrast of 1:1");
    expect(r.stderr).toContain("text-on-picture: §7");
    // the lint lives in the IR's lint (the extractor's), the IR itself is what it was: pictures, the slot, the scrim shapes
    const ir = JSON.parse(fs.readFileSync(path.join(d, ".build", "check", "embedded", "ir.json"), "utf8"));
    expect(ir.lint.filter((l: Lint) => l.rule === "text-on-picture").map((l: Lint) => [l.slide, l.path])).toEqual([[2, "#t2"], [3, "#l3"], [5, "#t5"]]);
    expect(ir.slides[0].elements.map((e: { id: string; kind: string }) => [e.id, e.kind])).toEqual([
      ["#photo::image", "image"], ["#scrim::bg", "shape"], ["#t1::text", "text"], ["#l1::text", "text"]]);
    // build runs the same check: it stops at the lint; without the failing slides the rest builds with --strict
    const b = deck(["build", d, "--json"], {}, { timeout: 300_000 });
    expect(b.code, b.stderr).toBe(1);
    expect(onPicture(JSON.parse(b.stdout).lint.items as Lint[]).map((l) => [l.slide, l.path])).toEqual([[2, "#t2"], [3, "#l3"], [5, "#t5"]]);
    for (const f of ["02-bare.html", "03-thin.html", "05-slot-bare.html"]) fs.rmSync(path.join(d, "slides", f));
    const ok = deck(["build", d, "--strict", "--json"], {}, { timeout: 300_000 });
    expect(ok.code, ok.stderr).toBe(0);
    const rep = JSON.parse(ok.stdout);
    expect(onPicture(rep.lint.items as Lint[])).toEqual([]);
    expect(rep.build).toMatchObject({ warnings: 0, skipped: 0 });
    expect(fs.existsSync(path.join(d, "onpic.pptx"))).toBe(true);
  }, 300_000);

  it("no host name resolves in the browser: the converter's --host-resolver-rules parses (Playwright's quoted copy does not)", () => {
    const root = tmp("resolver");
    const d = makeDeck(root, "rr", { "01-a.html": SLIDE('<p class="card-title" style="position:absolute;left:80px;top:80px">규칙</p>') });
    const r = deck(["check", d], { DEBUG: "pw:browser" }, { timeout: 300_000 });
    expect(r.code, r.out).toBe(0);
    const logs = path.join(d, ".build", "logs");
    const log = fs.readFileSync(path.join(logs, fs.readdirSync(logs)[0], "extract-embedded-check.log"), "utf8");
    expect(log).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1");
    expect(log).not.toContain("Failed parsing rule");
  }, 300_000);
});
