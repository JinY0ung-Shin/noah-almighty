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
 * slide page and touch no DOM on load (00-util.js), so 00-util.js + 20-text.js evaluate as they are.
 */
function inpage<T>(names: string[]): T {
  const dir = path.join(KIT, "tools", "extract", "inpage");
  const src = ["00-util.js", "20-text.js"].map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
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
    expect(p).toMatchObject({ format: "noah-deck-probe", version: 1, converterVersion: "1.0.0" });
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
    expect(fs.readFileSync(path.join(KIT, "VERSION"), "utf8").trim()).toBe("1.0.0");
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
    expect(JSON.parse(fs.readFileSync(rec, "utf8"))).toMatchObject({ format: "noah-deck-selftest-record", version: 1, status: "pass", converterVersion: "1.0.0", differences: 0 });
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
    expect(m).toMatchObject({ format: "noah-deck-preview", version: 1, generator: "noah-pptx-converter/1.0.0", pptx: "fx.pptx", profile: "embedded", slideCount: 3 });
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
