// craft-runner (the Craft app sidecar) — unit + in-process integration tests with a FAKE app CLI.
// Runs unprivileged: no root, no Docker. Ownership calls are exercised by mapping every owner to the
// test user's own uid; session-uid spawning (privileged only) is covered by the container E2E
// (craft-runner/e2e/).

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "craft-runner");
const FAKE = path.join(ROOT, "test", "fake-app.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = async (name: string): Promise<any> => import(pathToFileURL(path.join(ROOT, "src", name)).href);

const paths = await load("paths.mjs");
const policy = await load("policy.mjs");
const apps = await load("apps.mjs");
const mirror = await load("mirror.mjs");
const uidsMod = await load("uids.mjs");
const jsonl = await load("jsonl.mjs");
const control = await load("control.mjs");
const config = await load("config.mjs");
const runnerMod = await load("runner.mjs");
const semaphore = await load("semaphore.mjs");
const selftest = await load("selftest.mjs");
const auth = await load("auth.mjs");
const procsMod = await load("procs.mjs");
const fsx = await load("fsx.mjs");
const sessionsMod = await load("sessions.mjs");
const relayMod = await load("relay.mjs");
const appProcessMod = await load("appProcess.mjs");

const PC = apps.PHOTOCRAFT;
const MiB = 1024 * 1024;
const SECRET = "s".repeat(40);
const sidOf = (conv: string) => crypto.createHash("sha256").update(`noah-craft:${conv}`).digest("hex").slice(0, 32);
const newToken = () => crypto.randomBytes(32).toString("hex");
const self = () => ({ uid: process.getuid!(), gid: process.getgid!() });

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crt-"));
});
afterEach(() => {
  // The runner's own iterative remover: some tests leave chains deeper than PATH_MAX allows rmSync to walk.
  try {
    fsx.removeTreeAt(path.dirname(tmp), path.basename(tmp));
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** Build a `depth`-level chain `d/d/…/d` under `base` through descriptors (no PATH_MAX limit). */
function deepChain(base: string, depth: number, leafBytes = 100) {
  const D = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY;
  let fd = fs.openSync(base, D);
  for (let i = 0; i < depth; i += 1) {
    fs.mkdirSync(`/proc/self/fd/${fd}/d`);
    const next = fs.openSync(`/proc/self/fd/${fd}/d`, D);
    fs.closeSync(fd);
    fd = next;
  }
  if (leafBytes > 0) fs.writeFileSync(`/proc/self/fd/${fd}/leaf.bin`, Buffer.alloc(leafBytes));
  fs.closeSync(fd);
}
const openFds = () => fs.readdirSync("/proc/self/fd").length;

// ---------------------------------------------------------------------------------------------
describe("ids and paths", () => {
  it("validates sids and tokens strictly", () => {
    expect(paths.isValidSid(sidOf("c1"))).toBe(true);
    expect(paths.isValidSid("A".repeat(32))).toBe(false);
    expect(paths.isValidSid("a".repeat(31))).toBe(false);
    expect(paths.isValidSid("../" + "a".repeat(29))).toBe(false);
    expect(paths.isValidSid(42)).toBe(false);
    expect(paths.isValidToken(newToken())).toBe(true);
    expect(paths.isValidToken(newToken().toUpperCase())).toBe(false);
    expect(paths.isValidToken("a".repeat(65))).toBe(false);
  });

  it("normalizes relative paths and rejects escapes", () => {
    expect(paths.normalizeRelPath("a//./b/c.png")).toEqual({ ok: true, path: "a/b/c.png", parts: ["a", "b", "c.png"] });
    for (const bad of ["", "/etc/passwd", "a/../b", "..", "a\\b", "a\0b", "./.", "a/\u0007bell", ".craft-tmp-x"]) {
      expect(paths.normalizeRelPath(bad).ok, bad).toBe(false);
    }
    expect(paths.normalizeRelPath("a/".repeat(33) + "x", { maxDepth: 32 }).ok).toBe(false);
    expect(paths.nameProblem("x".repeat(256))).toMatch(/255/);
    expect(paths.nameProblem("한글.png")).toBeNull();
  });

  it("lays a session out under the exchange root", () => {
    const sid = sidOf("c1");
    const L = paths.sessionLayout("/exchange", sid, "/tmp/craft");
    expect(L.inDir).toBe(`/exchange/work/${sid}/in`);
    expect(L.outDir).toBe(`/exchange/work/${sid}/out`);
    expect(L.inbox).toBe(`/exchange/inbox/${sid}`);
    expect(L.outbox).toBe(`/exchange/outbox/${sid}`);
    expect(L.home).toBe(`/tmp/craft/${sid}/home`);
    expect(() => paths.sessionLayout("/exchange", "../x", "/tmp")).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
describe("policy", () => {
  const served = new Set<string>(PC.expectedTools);
  const evalCall = (name: string, args?: unknown) => policy.evaluateToolCall(PC, served, name, args);
  const text = (v: { result: { content: { text: string }[] } }) => v.result.content[0].text;

  it("denies bridge-only tools and unknown tools", () => {
    for (const name of ["ui_inspect", "ui_pointer", "control_call"]) {
      const v = evalCall(name, {});
      expect(v.ok).toBe(false);
      expect(v.result.isError).toBe(true);
      expect(text(v)).toMatch(/desktop window/);
    }
    expect(text(evalCall("rm_rf", {}))).toMatch(/Unknown PhotoCraft tool/);
    expect(evalCall("doc_inspect", {}).ok).toBe(true);
    expect(evalCall("doc_inspect", undefined).ok).toBe(true);
    expect(evalCall("doc_inspect", []).ok).toBe(false);
  });

  it("denies ambient-file and indirection commands in command_run, case-insensitively", () => {
    for (const id of ["file.open", "File.Open", " file.open ", "file.automate.batch", "file.scripts.browse", "actions.play", "plugin.install", "prefs.set", "layer.exportAs"]) {
      const v = evalCall("command_run", { id, params: {} });
      expect(v.ok, id).toBe(false);
      expect(text(v)).toMatch(/Denied by the Noah craft-runner/);
    }
    for (const id of ["file.new", "file.close", "filter.blur.gaussianBlur", "prefs.get", "layer.new.layer"]) {
      expect(evalCall("command_run", { id, params: { path: "work" } }).ok, id).toBe(true);
    }
    expect(text(evalCall("command_run", { id: "file.open" }))).toMatch(/doc_open/);
  });

  it("applies param-scoped rules", () => {
    expect(evalCall("command_run", { id: "swatches.import", params: { path: "/etc/x.aco" } }).ok).toBe(false);
    expect(evalCall("command_run", { id: "swatches.import", params: { data: "AAAA" } }).ok).toBe(true);
    expect(evalCall("command_run", { id: "edit.convertToProfile", params: { profile: "/usr/share/x.icc" } }).ok).toBe(false);
    expect(evalCall("command_run", { id: "edit.convertToProfile", params: { profile: "srgb" } }).ok).toBe(true);
    expect(evalCall("command_run", { id: "image.mode.cmyk", params: { profile: "foo.icc" } }).ok).toBe(false);
    expect(evalCall("command_run", { id: "image.adjustments.colorLookup", params: { lut: "warm" } }).ok).toBe(true);
    expect(evalCall("command_run", { id: "image.adjustments.colorLookup", params: { file: "x.cube" } }).ok).toBe(false);
  });

  it("checks EVERY command_batch step and the batch shape", () => {
    const ok = evalCall("command_batch", { steps: [{ id: "layer.new.layer" }, { id: "filter.blur.gaussianBlur", params: { radius: 2 } }] });
    expect(ok.ok).toBe(true);
    const bad = evalCall("command_batch", { steps: [{ id: "layer.new.layer" }, { id: "actions.load", params: { data: "x" } }] });
    expect(bad.ok).toBe(false);
    expect(bad.command).toBe("actions.load");
    expect(text(bad)).toMatch(/step 1/);
    expect(text(bad)).toMatch(/No step of this batch was run/);
    expect(evalCall("command_batch", { steps: { id: "file.open" } }).ok).toBe(false);
    expect(evalCall("command_batch", { steps: [["file.open", {}]] }).ok).toBe(false);
    expect(evalCall("command_batch", {}).ok).toBe(false);
    expect(evalCall("command_run", { id: 7 }).ok).toBe(false);
  });

  it("clamps preview sizes to 1568 (0 = full size is clamped too, default left alone)", () => {
    for (const tool of ["render_preview", "doc_render_preview"]) {
      expect(evalCall(tool, { max_side: 4000 }).args.max_side).toBe(1568);
      expect(evalCall(tool, { max_side: 0 }).args.max_side).toBe(1568);
      expect(evalCall(tool, { max_side: 800 }).args.max_side).toBe(800);
      expect(evalCall(tool, {}).args).toEqual({});
      expect(evalCall(tool, { max_side: "big" }).args.max_side).toBe("big");
    }
    const args = { max_side: 9999 };
    evalCall("render_preview", args);
    expect(args.max_side).toBe(9999); // never mutates the caller's object
  });

  it("filters tools by glob", () => {
    const tools = ["ui_set", "control_call", "doc_open", "uix"].map((name) => ({ name }));
    expect(policy.filterTools(tools, PC.deniedTools).map((t: { name: string }) => t.name)).toEqual(["doc_open", "uix"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("app registry", () => {
  it("ships PhotoCraft 0.16.0 with a valid, bridge-free entry", () => {
    expect(apps.APPS.map((a: { id: string }) => a.id)).toEqual(["photocraft"]);
    expect(() => apps.validateApp(PC)).not.toThrow();
    expect(PC.version).toBe("0.16.0");
    const argv = PC.args({ readRoot: "/r", writeRoot: "/r/out" });
    expect(argv).toEqual(["mcp", "--automation-read-root", "/r", "--automation-write-root", "/r/out"]);
    expect(PC.expectedTools.some((t: string) => t.startsWith("ui_") || t === "control_call")).toBe(false);
  });

  it("rejects trusted-local subcommands, bridge flags and reserved env", () => {
    const bad = (patch: object) => () => apps.validateApp({ ...PC, ...patch });
    expect(bad({ args: () => ["run", "/r", "/r/out"] })).toThrow(/trusted-local/);
    expect(bad({ args: () => ["mcp", "--bridge", "7000", "/r", "/r/out"] })).toThrow(/never allowed/);
    expect(bad({ args: () => ["mcp"] })).toThrow(/both the read and the write root/);
    expect(bad({ env: { HOME: "/" } })).toThrow(/set by the runner/);
    expect(bad({ env: { PHOTOCRAFT_CONTROL_PORT: "1" } })).toThrow(/not allowed/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("planMirror (pure)", () => {
  const L = { maxFileBytes: 100, maxTotalBytes: 250, maxFiles: 3, maxDirs: 2 };
  const f = (p: string, size = 10, mtimeMs = 1000, extra = {}) => ({ path: p, type: "file", size, mtimeMs, ino: 1, dev: 1, ...extra });
  const d = (p: string) => ({ path: p, type: "dir", size: 0, mtimeMs: 1, ino: 1, dev: 1 });

  it("copies new/changed, skips unchanged, deletes absent and foreign entries", () => {
    const plan = mirror.planMirror(
      { entries: [d("a"), f("a/x"), f("b", 10, 2000), f("c")], rejected: [] },
      { entries: [d("a"), f("a/x"), f("b", 10, 1000), f("gone"), d("old"), f("old/y")], foreign: ["evil-link"] },
      L,
    );
    expect(plan.copies.map((e: { path: string }) => e.path)).toEqual(["b", "c"]);
    expect(plan.unchanged).toBe(1);
    expect(plan.removes).toEqual(["evil-link", "gone", "old"]);
    expect(plan.mkdirs).toEqual(["a"]);
  });

  it("enforces per-file, count and total caps and lists rejections", () => {
    const plan = mirror.planMirror(
      { entries: [f("big", 101), f("a", 100), f("b", 100), f("c", 60), f("d", 1)], rejected: [{ path: "s", reason: "symlink rejected" }] },
      { entries: [f("big", 50)], foreign: [] },
      L,
    );
    const reasons = Object.fromEntries(plan.rejected.map((r: { path: string; reason: string }) => [r.path, r.reason]));
    expect(reasons.s).toBe("symlink rejected");
    expect(reasons.big).toMatch(/per-file cap/);
    expect(reasons.c).toMatch(/total size cap/);
    expect(plan.copies.map((e: { path: string }) => e.path)).toEqual(["a", "b", "d"]);
    expect(plan.removes).toEqual(["big"]); // a rejected source never leaves a stale copy behind
    const many = mirror.planMirror({ entries: [f("1"), f("2"), f("3"), f("4")], rejected: [] }, { entries: [], foreign: [] }, L);
    expect(many.rejected[0]).toEqual({ path: "4", reason: "file count cap (3) reached" });
  });

  it("caps directories (and drops their subtree), rejects hard links on request, handles type changes", () => {
    const plan = mirror.planMirror(
      { entries: [d("a"), d("b"), d("c"), f("c/x"), f("h", 5, 1, { nlink: 2 }), d("t")], rejected: [] },
      { entries: [f("t"), d("h")], foreign: [] },
      L,
      { rejectHardlinks: true },
    );
    expect(plan.rejected.map((r: { path: string }) => r.path)).toEqual(["c", "h", "t"]);
    expect(plan.copies).toEqual([]);
    expect(plan.removes).toEqual(["h", "t"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("mirrorTree (real filesystem)", () => {
  const limits = { ...config.DEFAULT_LIMITS };
  const run = (src: string, dst: string, extra = {}) =>
    mirror.mirrorTree({ srcAbs: src, dstAbs: dst, limits, owner: self(), fileMode: 0o600, dirMode: 0o700, ...extra });
  let src: string;
  let dst: string;
  beforeEach(() => {
    src = path.join(tmp, "src");
    dst = path.join(tmp, "dst");
    fs.mkdirSync(src);
    fs.mkdirSync(dst);
  });

  it("mirrors regular files and dirs with mode + mtime, then skips unchanged and deletes absent", async () => {
    fs.mkdirSync(path.join(src, "attachments", "deep"), { recursive: true });
    fs.writeFileSync(path.join(src, "attachments", "a.png"), "aaa");
    fs.writeFileSync(path.join(src, "attachments", "deep", "b.txt"), "bb");
    const r1 = await run(src, dst);
    expect(r1).toMatchObject({ copied: 2, removed: 0, skipped: 0, bytes: 5, rejected: [] });
    const st = fs.statSync(path.join(dst, "attachments", "a.png"));
    expect(st.mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dst, "attachments")).mode & 0o777).toBe(0o700);
    expect(Math.abs(st.mtimeMs - fs.statSync(path.join(src, "attachments", "a.png")).mtimeMs)).toBeLessThan(1);
    expect(r1.files.map((x: { path: string }) => x.path).sort()).toEqual(["attachments/a.png", "attachments/deep/b.txt"]);

    const r2 = await run(src, dst);
    expect(r2).toMatchObject({ copied: 0, skipped: 2 });

    fs.rmSync(path.join(src, "attachments", "deep"), { recursive: true });
    fs.writeFileSync(path.join(src, "attachments", "a.png"), "changed!");
    const r3 = await run(src, dst);
    expect(r3).toMatchObject({ copied: 1, removed: 1 });
    expect(fs.readFileSync(path.join(dst, "attachments", "a.png"), "utf8")).toBe("changed!");
    expect(fs.existsSync(path.join(dst, "attachments", "deep"))).toBe(false);
  });

  it("rejects symlinks and FIFOs in the source without following or blocking", async () => {
    const secret = path.join(tmp, "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET");
    fs.symlinkSync(secret, path.join(src, "link.txt"));
    fs.symlinkSync(tmp, path.join(src, "dirlink"));
    execFileSync("mkfifo", [path.join(src, "pipe")]);
    fs.writeFileSync(path.join(src, "ok.txt"), "ok");
    const r = await run(src, dst);
    expect(r.copied).toBe(1);
    expect(r.rejected).toEqual(
      expect.arrayContaining([
        { path: "link.txt", reason: "symlink rejected" },
        { path: "dirlink", reason: "symlink rejected" },
        { path: "pipe", reason: "fifo rejected" },
      ]),
    );
    expect(fs.readdirSync(dst)).toEqual(["ok.txt"]);
  });

  it("never writes through a symlink planted in the destination", async () => {
    const victim = path.join(tmp, "victim.txt");
    fs.writeFileSync(victim, "original");
    fs.writeFileSync(path.join(src, "x.txt"), "new");
    fs.symlinkSync(victim, path.join(dst, "x.txt"));
    fs.mkdirSync(path.join(tmp, "victimdir"));
    fs.mkdirSync(path.join(src, "sub"));
    fs.writeFileSync(path.join(src, "sub", "y.txt"), "y");
    fs.symlinkSync(path.join(tmp, "victimdir"), path.join(dst, "sub"));
    const r = await run(src, dst);
    expect(r.copied).toBe(2);
    expect(fs.readFileSync(victim, "utf8")).toBe("original");
    expect(fs.lstatSync(path.join(dst, "x.txt")).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(dst, "sub")).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(tmp, "victimdir"))).toEqual([]);
  });

  it("refuses a source or destination root that is a symlink", async () => {
    const linkSrc = path.join(tmp, "linksrc");
    fs.symlinkSync(src, linkSrc);
    await expect(run(linkSrc, dst)).rejects.toThrow(/not a directory/);
    const linkDst = path.join(tmp, "linkdst");
    fs.symlinkSync(dst, linkDst);
    await expect(run(src, linkDst)).rejects.toThrow(/not a directory/);
    // A missing source is an empty tree: everything in the destination goes.
    fs.writeFileSync(path.join(dst, "stale"), "x");
    const r = await run(path.join(tmp, "missing"), dst);
    expect(r.removed).toBe(1);
  });

  it("rejects hard links (sync_out), bad names and over-cap files", async () => {
    fs.writeFileSync(path.join(src, "h1"), "x");
    fs.linkSync(path.join(src, "h1"), path.join(src, "h2"));
    fs.writeFileSync(path.join(src, "bad\u0001name"), "x");
    fs.writeFileSync(path.join(src, "large.bin"), Buffer.alloc(2048));
    const r = await run(src, dst, { rejectHardlinks: true, limits: { ...limits, maxFileBytes: 1024 } });
    const reasons = Object.fromEntries(r.rejected.map((x: { path: string; reason: string }) => [x.path, x.reason]));
    expect(reasons.h1).toBe("hard link rejected");
    expect(reasons.h2).toBe("hard link rejected");
    expect(reasons["bad\u0001name"]).toBe("bad_name");
    expect(r.rejected.find((x: { path: string }) => x.path === "bad\u0001name").detail).toBe("control character in name");
    expect(reasons["large.bin"]).toMatch(/per-file cap/);
    expect(fs.readdirSync(dst)).toEqual([]);
  });

  it("cleans foreign entries and leftover temp files out of the destination", async () => {
    fs.writeFileSync(path.join(dst, ".craft-tmp-deadbeef"), "partial");
    execFileSync("mkfifo", [path.join(dst, "fifo")]);
    const r = await run(src, dst);
    expect(r.removed).toBe(2);
    expect(fs.readdirSync(dst)).toEqual([]);
  });
});


// ---------------------------------------------------------------------------------------------
describe("iterative, depth-capped tree walks (Addendum A4)", () => {
  it("removeEntry deletes a 3000-level chain without recursion and with a bounded number of descriptors", () => {
    const base = path.join(tmp, "victim");
    fs.mkdirSync(base);
    deepChain(base, 3000);
    fs.writeFileSync(path.join(base, "top.txt"), "x");
    const before = openFds();
    fsx.removeTreeAt(tmp, "victim");
    expect(fs.existsSync(base)).toBe(false);
    expect(openFds()).toBe(before); // nothing leaked
  });

  it("removeEntry hoists subtrees found at the depth cap (never descends past it)", () => {
    const base = path.join(tmp, "v");
    fs.mkdirSync(base);
    deepChain(base, 50);
    const D = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY;
    const fd = fs.openSync(tmp, D);
    try {
      fsx.removeEntry(fd, "v", { maxDepth: 4 });
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.existsSync(base)).toBe(false);
  });

  it("removeEntry stops with TreeTooLarge after maxOps (a concurrent writer cannot pin it forever)", () => {
    const base = path.join(tmp, "big");
    fs.mkdirSync(base);
    for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(base, `f${i}`), "x");
    const fd = fs.openSync(tmp, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      expect(() => fsx.removeEntry(fd, "big", { maxOps: 10 })).toThrow(fsx.TreeTooLarge);
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.readdirSync(base).length).toBeLessThan(30); // what was removed stays removed
  });

  it("mirrorTree rejects source entries below 32 levels as too_deep and still mirrors the rest", async () => {
    const src = path.join(tmp, "src");
    const dst = path.join(tmp, "dst");
    fs.mkdirSync(src);
    fs.mkdirSync(dst);
    deepChain(src, 40);
    fs.writeFileSync(path.join(src, "ok.png"), "ok");
    const r = await mirror.mirrorTree({ srcAbs: src, dstAbs: dst, limits: config.DEFAULT_LIMITS, owner: null, fileMode: 0o600, dirMode: 0o700 });
    expect(r.rejected).toEqual([{ path: `${"d/".repeat(32)}d`, reason: "too_deep (more than 32 directory levels)" }]);
    expect(r.srcUnmeasured).toBe(1);
    expect(r.files.map((f: { path: string }) => f.path)).toEqual(["ok.png"]);
    expect(fs.readFileSync(path.join(dst, "ok.png"), "utf8")).toBe("ok");
  });

  it("mirrorTree removes a deep chain planted in the DESTINATION (a 2000-level outbox chain cannot break sync_out)", async () => {
    const src = path.join(tmp, "src");
    const dst = path.join(tmp, "dst");
    fs.mkdirSync(src);
    fs.mkdirSync(dst);
    fs.writeFileSync(path.join(src, "a.png"), "a");
    deepChain(dst, 2000);
    const r = await mirror.mirrorTree({ srcAbs: src, dstAbs: dst, limits: config.DEFAULT_LIMITS, owner: null, fileMode: 0o600, dirMode: 0o700 });
    expect(r.copied).toBe(1);
    expect(fs.readdirSync(dst)).toEqual(["a.png"]);
  });

  it("measureTree sums regular files iteratively and counts directories it will not descend into", () => {
    const base = path.join(tmp, "m");
    fs.mkdirSync(path.join(base, "a"), { recursive: true });
    fs.writeFileSync(path.join(base, "a", "x"), Buffer.alloc(10));
    fs.writeFileSync(path.join(base, "y"), Buffer.alloc(5));
    fs.symlinkSync("/etc/passwd", path.join(base, "link"));
    expect(fsx.measureTree(base)).toEqual({ bytes: 15, files: 2, unmeasured: 0 });
    deepChain(base, 40, 1000);
    expect(fsx.measureTree(base)).toEqual({ bytes: 15, files: 2, unmeasured: 1 });
    expect(fsx.measureTree(path.join(tmp, "missing"))).toEqual({ bytes: 0, files: 0, unmeasured: 0 });
  });
});

describe("review-2 runner hardening (unit)", () => {
  it("N4: walkTree measures a bad-named directory's bytes, rejects it as bad_name with the real problem, never unmeasured", () => {
    const base = path.join(tmp, "w");
    fs.mkdirSync(path.join(base, ".craft-tmp-x", "d"), { recursive: true });
    fs.writeFileSync(path.join(base, ".craft-tmp-x", "d", "f"), Buffer.alloc(70));
    fs.writeFileSync(path.join(base, "ctl\u0001.png"), Buffer.alloc(5));
    fs.writeFileSync(path.join(base, "fine.png"), Buffer.alloc(3));
    const fd = fs.openSync(base, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      const w = fsx.walkTree(fd, { maxDepth: 32, nameProblem: paths.nameProblem });
      expect(w.bytes).toBe(78);
      expect(w.unmeasured).toBe(0);
      expect(w.rejected).toEqual([
        { path: ".craft-tmp-x", reason: "bad_name", detail: "reserved name" },
        { path: "ctl\u0001.png", reason: "bad_name", detail: "control character in name" },
      ]);
      expect(w.entries.map((e: { path: string }) => e.path)).toEqual(["fine.png"]);
      expect(w.foreign.sort()).toEqual([".craft-tmp-x", "ctl\u0001.png"]);
    } finally {
      fs.closeSync(fd);
    }
  });

  it("N7: capRejected keeps every staged/ entry first and caps the rest", () => {
    const rest = Array.from({ length: 5 }, (_, i) => ({ path: `a${i}`, reason: "x" }));
    const staged = [{ path: "staged/a.png", reason: "y" }, { path: "staged", reason: "z" }];
    expect(mirror.capRejected([...rest, ...staged], 2)).toEqual([...staged, rest[0], rest[1]]);
    expect(mirror.capRejected([{ path: "stagedx", reason: "q" }], 0)).toEqual([]);
  });

  it("perf: measureTreeAsync agrees with measureTree (depth cap, symlinks ignored, missing root) without leaking descriptors", async () => {
    const base = path.join(tmp, "m");
    fs.mkdirSync(path.join(base, "a"), { recursive: true });
    fs.writeFileSync(path.join(base, "a", "x"), Buffer.alloc(10));
    fs.writeFileSync(path.join(base, "y"), Buffer.alloc(5));
    fs.symlinkSync("/etc/passwd", path.join(base, "link"));
    deepChain(base, 40, 1000);
    const before = openFds();
    expect(await fsx.measureTreeAsync(base)).toEqual(fsx.measureTree(base));
    expect(await fsx.measureTreeAsync(base)).toEqual({ bytes: 15, files: 2, unmeasured: 1 });
    expect(await fsx.measureTreeAsync(path.join(tmp, "missing"))).toEqual({ bytes: 0, files: 0, unmeasured: 0 });
    expect(openFds()).toBe(before);
  });

  it("N5: the pool skips busy uids, and a failed persist rolls the allocation back", () => {
    const dir = path.join(tmp, "state");
    fs.mkdirSync(dir);
    const file = path.join(dir, "uids.json");
    const pool = new uidsMod.UidPool({ file, min: 20000, max: 20003 }).load();
    let calls = 0;
    expect(pool.allocate(sidOf("a"), { busy: () => (calls++, new Set([20000, 20001])) })).toBe(20002);
    expect(pool.allocate(sidOf("a"), { busy: () => (calls++, new Set()) })).toBe(20002); // known sid: no scan
    expect(calls).toBe(1);
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => pool.allocate(sidOf("b"))).toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(pool.get(sidOf("b"))).toBeUndefined();
    expect(pool.size).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(["uids.json"]); // no temp file left behind
    expect(pool.allocate(sidOf("b"))).toBe(20003); // the cursor was not advanced by the failure
  });

  it("N9: an app is never spawned without a valid non-root uid/gid", async () => {
    expect(() => appProcessMod.assertAppIds({ uid: undefined, gid: undefined })).toThrow(/refusing to spawn/);
    expect(() => appProcessMod.assertAppIds({ uid: 0, gid: 0 })).toThrow(/refusing to spawn/);
    expect(() => appProcessMod.assertAppIds({ uid: 20000, gid: 1000 })).toThrow(/refusing to spawn/);
    expect(() => appProcessMod.assertAppIds({ uid: 20000, gid: 20000 })).not.toThrow();
    expect(() => appProcessMod.assertAppIds({ uid: config.SELFTEST_UID, gid: config.SELFTEST_UID })).not.toThrow();
    expect(() => appProcessMod.assertAppIds(null)).not.toThrow();
    const proc = new appProcessMod.AppProcess({
      app: fakeApp(),
      readRoot: tmp,
      writeRoot: tmp,
      cwd: tmp,
      env: {},
      ids: { uid: undefined, gid: undefined },
      limits: config.DEFAULT_LIMITS,
      log: () => {},
    });
    await expect(proc.start()).rejects.toThrow(/refusing to spawn/);
    expect(proc.child ?? null).toBeNull();
    // The session manager refuses before AppProcess is even built when the sid has no uid.
    const sm = new sessionsMod.SessionManager({
      exchangeDir: tmp,
      tmpRoot: tmp,
      limits: config.DEFAULT_LIMITS,
      maxProcs: 1,
      apps: new Map([["fakecraft", { app: fakeApp(), status: "ready" }]]),
      uids: { get: () => undefined, sids: () => [], size: 0 },
      owner: () => null,
      spawnAsSessionUid: true,
      procs: new FakeProcs(),
      log: () => {},
    });
    const entry = { token: newToken(), sid: sidOf("n9"), revoked: false, procs: new Map(), conns: new Map() };
    await expect(sm.getProc(entry, "fakecraft", {})).rejects.toThrow(/no valid uid/);
    expect(sm.slots.running).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe("uid process killer (Addendum A3)", () => {
  it("parses /proc/<pid>/status and lists real processes (our own pid with our own uid)", () => {
    expect(procsMod.parseProcStatus("Name:\tx\nState:\tS (sleeping)\nUid:\t20001\t20001\t20001\t20001\n")).toEqual({ uids: [20001, 20001, 20001, 20001], state: "S", threads: 1 });
    expect(procsMod.parseProcStatus("State:\tZ (zombie)\nUid:\t20001\t20001\t20001\t20001\nThreads:\t3\n")).toEqual({ uids: [20001, 20001, 20001, 20001], state: "Z", threads: 3 });
    expect(procsMod.parseProcStatus("garbage")).toBeNull();
    const me = procsMod.listProcs().find((p: { pid: number }) => p.pid === process.pid);
    expect(me.uids[0]).toBe(process.getuid!());
  });

  it("SIGKILLs every process of the uid (any of real/effective/saved/fs) REGARDLESS of state, verifies (N1)", async () => {
    const fake = new FakeProcs();
    fake.add(10, 20007);
    fake.add(11, 20007);
    fake.table.push({ pid: 12, uids: [20008, 20007, 20008, 20008], state: "S" }); // saved/effective match too
    fake.add(13, 20007, "Z"); // a plain zombie: killed too (a no-op), never a survivor
    fake.immortal.add(13);
    fake.add(14, 1000);
    const r = await procsMod.killUidProcesses(20007, fake);
    expect(r).toEqual({ ok: true, killed: 3, survivors: [] });
    expect([...new Set(fake.killed)].sort()).toEqual([10, 11, 12, 13]);
    expect(fake.table.map((p) => p.pid).sort()).toEqual([13, 14]);
  });

  it("a zombie thread-group LEADER whose threads still run counts as alive and is killed (N1)", async () => {
    expect(procsMod.isLiveProc({ state: "Z", threads: 1 })).toBe(false);
    expect(procsMod.isLiveProc({ state: "Z", threads: 4 })).toBe(true);
    expect(procsMod.isLiveProc({ state: "X" })).toBe(false);
    expect(procsMod.isLiveProc({ state: "S" })).toBe(true);
    const fake = new FakeProcs();
    fake.add(30, 20010, "Z", 3);
    const r = await procsMod.killUidProcesses(20010, fake, { rounds: 3, waitMs: 0 });
    expect(r).toEqual({ ok: true, killed: 1, survivors: [] });
    expect(fake.killed).toEqual([30]);
    // One whose threads survive the kill is reported, so purge keeps the uid reserved.
    const stuck = new FakeProcs();
    stuck.add(31, 20011, "Z", 2);
    stuck.immortal.add(31);
    expect(await procsMod.killUidProcesses(20011, stuck, { rounds: 2, waitMs: 0 })).toEqual({ ok: false, killed: 1, survivors: [31] });
  });

  it("reports survivors after the bounded rounds", async () => {
    const fake = new FakeProcs();
    fake.add(20, 20009);
    fake.immortal.add(20);
    const r = await procsMod.killUidProcesses(20009, fake, { rounds: 3, waitMs: 0 });
    expect(r).toEqual({ ok: false, killed: 1, survivors: [20] });
    expect(fake.killed).toEqual([20, 20, 20]);
  });

  it("refuses to mass-kill anything but session-pool uids and the self-test uid", async () => {
    const fake = new FakeProcs();
    for (const uid of [0, 1000, 19998, 30000, process.getuid!()]) {
      await expect(procsMod.killUidProcesses(uid, fake)).rejects.toThrow(/refusing/);
    }
    expect(procsMod.killableUid(config.SELFTEST_UID)).toBe(true);
    expect(fake.killed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("reported self-test errors (Addendum A5)", () => {
  it("strips control characters and truncates to 300 characters", () => {
    const raw = `self-test failed: \u001b[31mred\u001b[0m\nline2\tTAB\u0007\u2028 ${"한".repeat(500)}`;
    const out = selftest.sanitizeReportedError(raw);
    expect(Array.from(out).length).toBeLessThanOrEqual(300);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028]/);
    expect(out.startsWith("self-test failed: [31mred [0m line2 TAB")).toBe(true);
    expect(selftest.sanitizeReportedError("short")).toBe("short");
  });
});

describe("budget messages", () => {
  it("say what happened and what to deliver/delete", () => {
    const base = { outBytes: 3 * 1024 * MiB, outMaxBytes: 2 * 1024 * MiB, outUnmeasured: 0, exchangeBytes: 1, exchangeMaxBytes: 20 * 1024 * MiB };
    const s = sessionsMod.budgetMessage({ ...base, over: "session" });
    expect(s).toMatch(/holds 3 GiB, over its 2 GiB per-conversation budget/);
    expect(s).toMatch(/share_file/);
    expect(s).toMatch(/NEW conversation/);
    expect(sessionsMod.budgetMessage({ ...base, outUnmeasured: 1, over: "session" })).toMatch(/more than 32 levels deep/);
    const x = sessionsMod.budgetMessage({ ...base, exchangeBytes: 21 * 1024 * MiB, over: "exchange" });
    expect(x).toMatch(/shared storage holds 21 GiB of its 20 GiB budget/);
    expect(x).toMatch(/delete old conversations/);
    expect(sessionsMod.budgetMessage({ ...base, over: null })).toBe("");
    const xo = { ...base, exchangeBytes: 21 * 1024 * MiB, over: "exchange" };
    expect(sessionsMod.budgetMessage(xo, "open")).toMatch(/no new Craft session can be opened/);
    expect(sessionsMod.budgetMessage(xo, "sync_in")).toMatch(/no new input files were copied in .*stay readable under in\//);
    const r = relayMod.overBudgetResult({ content: [{ type: "text", text: "wrote" }], isError: false }, "over");
    expect(r).toEqual({ content: [{ type: "text", text: "wrote" }, { type: "text", text: "over" }], isError: true });
  });
});

// ---------------------------------------------------------------------------------------------
describe("uid pool", () => {
  it("allocates ROUND-ROBIN (a just-freed uid is reused last), persists the cursor, reloads and frees", () => {
    const file = path.join(tmp, "uids.json");
    const pool = new uidsMod.UidPool({ file, min: 20000, max: 20003 }).load();
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map(sidOf);
    expect(pool.allocate(a)).toBe(20000);
    expect(pool.allocate(b)).toBe(20001);
    expect(pool.allocate(a)).toBe(20000);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    pool.free(a);
    expect(pool.allocate(c)).toBe(20002); // NOT the just-freed 20000
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ v: 2, next: 20003, sessions: { [b]: 20001, [c]: 20002 } });
    const again = new uidsMod.UidPool({ file, min: 20000, max: 20003 }).load();
    expect(again.get(b)).toBe(20001);
    expect(again.get(c)).toBe(20002);
    expect(again.allocate(d)).toBe(20003); // the cursor survived the reload
    expect(again.allocate(e)).toBe(20000); // wraps around to the oldest free uid
    expect(() => again.allocate(sidOf("f"))).toThrow(/exhausted/);
    expect(() => again.allocate("nope")).toThrow(/invalid sid/);
  });

  it("loads a legacy v1 file (bare sid map) and continues after its highest uid", () => {
    const file = path.join(tmp, "uids.json");
    fs.writeFileSync(file, JSON.stringify({ [sidOf("a")]: 20000, [sidOf("b")]: 20005 }));
    const pool = new uidsMod.UidPool({ file, min: 20000, max: 29999 }).load();
    expect(pool.size).toBe(2);
    expect(pool.allocate(sidOf("c"))).toBe(20006);
  });

  it("drops invalid, out-of-range and duplicate entries on load", () => {
    const file = path.join(tmp, "uids.json");
    fs.writeFileSync(file, JSON.stringify({ [sidOf("a")]: 20000, [sidOf("b")]: 20000, bad: 20001, [sidOf("c")]: 5 }));
    const pool = new uidsMod.UidPool({ file, min: 20000, max: 29999 }).load();
    expect(pool.size).toBe(1);
    fs.writeFileSync(file, "{not json");
    expect(new uidsMod.UidPool({ file, min: 20000, max: 29999 }).load().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe("jsonl framing", () => {
  it("splits lines across chunks and reports over-cap lines with a recoverable id", () => {
    const lines: string[] = [];
    const overflows: { head: string; tail: string; bytes: number }[] = [];
    const push = jsonl.createLineSplitter({ maxBytes: 64, onLine: (l: string) => lines.push(l), onOverflow: (o: never) => overflows.push(o) });
    push(Buffer.from('{"a":1}\n{"b"'));
    push(Buffer.from(':2}\n'));
    push(Buffer.from(`{"jsonrpc":"2.0","id":17,"result":"${"x".repeat(200)}`));
    push(Buffer.from(`${"y".repeat(300)}"}\n{"c":3}\n`));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(overflows).toHaveLength(1);
    expect(overflows[0].bytes).toBeGreaterThan(500);
    expect(jsonl.extractJsonRpcId(overflows[0].head, "first")).toBe(17);
    expect(jsonl.extractJsonRpcId('{"params":{"arguments":{"id":"file.open"}},"jsonrpc":"2.0","id":"r-9"}', "last")).toBe("r-9");
    expect(jsonl.extractJsonRpcId('{"text":"\\"id\\":5"}', "first")).toBeUndefined();
  });
});

describe("semaphore", () => {
  it("queues FIFO and times out as Busy", async () => {
    const s = new semaphore.Semaphore(1);
    const r1 = await s.acquire(1000);
    const waiting = s.acquire(1000);
    await expect(s.acquire(20)).rejects.toBeInstanceOf(semaphore.Busy);
    r1();
    r1(); // idempotent
    const r2 = await waiting;
    expect(s.running).toBe(1);
    r2();
    expect(s.running).toBe(0);
  });
});

describe("handshake crypto (Addendum A1/A2)", () => {
  const N1 = "1".repeat(32);
  const N2 = "2".repeat(32);
  const hmac = (key: string, msg: string) => crypto.createHmac("sha256", key).update(msg).digest("hex");

  it("uses the exact labelled HMAC-SHA256 messages, keyed by the secret/token STRING", () => {
    expect(auth.controlClientMac(SECRET, N1)).toBe(hmac(SECRET, `noah-craft-control|client|${N1}`));
    expect(auth.controlServerMac(SECRET, N2)).toBe(hmac(SECRET, `noah-craft-control|server|${N2}`));
    const token = newToken();
    expect(auth.mcpClientMac(token, N1, "photocraft")).toBe(hmac(token, `noah-craft-mcp|client|${N1}|photocraft`));
    expect(auth.mcpServerMac(token, N2)).toBe(hmac(token, `noah-craft-mcp|server|${N2}`));
    expect(auth.tokenIdOf(token)).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    // Direction labels keep a MAC from being reflected into the other slot.
    expect(auth.controlClientMac(SECRET, N1)).not.toBe(auth.controlServerMac(SECRET, N1));
    expect(auth.newNonce()).toMatch(/^[0-9a-f]{32}$/);
    expect(auth.newNonce()).not.toBe(auth.newNonce());
    expect(auth.challengeLine(N1)).toEqual({ op: "challenge", v: 1, nonce: N1 });
  });

  it("macMatches is strict: lowercase 64-hex only, equal values only", () => {
    const m = auth.controlClientMac(SECRET, N1);
    expect(auth.macMatches(m, m)).toBe(true);
    expect(auth.macMatches(m.toUpperCase(), m)).toBe(false);
    expect(auth.macMatches(m.slice(0, 63), m)).toBe(false);
    expect(auth.macMatches(undefined, m)).toBe(false);
    expect(auth.macMatches(auth.controlClientMac(SECRET + "x", N1), m)).toBe(false);
  });

  it("verifyControlHello: right MAC → server MAC; plaintext secret, wrong MAC, bad/reused nonce → null", () => {
    const good = { op: "hello", nonce: N2, mac: auth.controlClientMac(SECRET, N1) };
    expect(control.verifyControlHello(good, SECRET, N1)).toBe(auth.controlServerMac(SECRET, N2));
    expect(control.verifyControlHello({ ...good, secret: SECRET }, SECRET, N1)).toBeNull();
    expect(control.verifyControlHello({ op: "hello", secret: SECRET }, SECRET, N1)).toBeNull();
    expect(control.verifyControlHello({ ...good, mac: auth.controlClientMac("w".repeat(40), N1) }, SECRET, N1)).toBeNull();
    expect(control.verifyControlHello({ ...good, mac: auth.controlClientMac(SECRET, N2) }, SECRET, N1)).toBeNull(); // MAC over another nonce
    expect(control.verifyControlHello({ ...good, nonce: "xyz" }, SECRET, N1)).toBeNull();
    expect(control.verifyControlHello({ ...good, nonce: N1 }, SECRET, N1)).toBeNull(); // echoing the runner nonce
    expect(control.verifyControlHello({ ...good, op: "health" }, SECRET, N1)).toBeNull();
    expect(control.verifyControlHello(good, "", N1)).toBeNull();
  });

  it("loadConfig fails closed on a missing or short secret and bounds CRAFT_MAX_PROCS", () => {
    expect(config.loadConfig({}).secretProblem).toMatch(/not set/);
    expect(config.loadConfig({ CRAFT_CONTROL_SECRET: "short" }).secretProblem).toMatch(/shorter/);
    expect(config.loadConfig({ CRAFT_CONTROL_SECRET: SECRET }).secretProblem).toBeNull();
    expect(config.loadConfig({ CRAFT_MAX_PROCS: "5" }).maxProcs).toBe(5);
    expect(config.loadConfig({ CRAFT_MAX_PROCS: "0" }).maxProcs).toBe(3);
    expect(config.loadConfig({ CRAFT_MAX_PROCS: "x" }).maxProcs).toBe(3);
  });

  it("loadConfig: exchange budget from CRAFT_EXCHANGE_MAX_BYTES (default 20 GiB), token TTL 12 h, out budget 2 GiB", () => {
    expect(config.loadConfig({}).limits.exchangeMaxBytes).toBe(20 * 1024 * MiB);
    expect(config.loadConfig({ CRAFT_EXCHANGE_MAX_BYTES: String(5 * 1024 * MiB) }).limits.exchangeMaxBytes).toBe(5 * 1024 * MiB);
    expect(config.loadConfig({ CRAFT_EXCHANGE_MAX_BYTES: "12" }).limits.exchangeMaxBytes).toBe(20 * 1024 * MiB); // below the floor
    expect(config.DEFAULT_LIMITS.tokenTtlMs).toBe(12 * 3_600_000);
    expect(config.DEFAULT_LIMITS.sessionOutMaxBytes).toBe(2 * 1024 * MiB);
    expect(config.DEFAULT_LIMITS.maxDepth).toBe(32);
  });
});

// ---------------------------------------------------------------------------------------------
// In-process runner + fake app over the real unix sockets.

const FAKE_TOOLS = ["command_run", "command_batch", "doc_open", "doc_export", "render_preview", "whoami", "sleep", "big", "crash", "write_file", "progress"];

function fakeApp(env: Record<string, string> = {}, expectedTools = FAKE_TOOLS) {
  return {
    ...PC,
    id: "fakecraft",
    label: "FakeCraft",
    version: "9.9.9",
    bin: process.execPath,
    args: ({ readRoot, writeRoot }: { readRoot: string; writeRoot: string }) => [
      FAKE,
      "mcp",
      "--automation-read-root",
      readRoot,
      "--automation-write-root",
      writeRoot,
    ],
    env,
    expectedTools,
  };
}

class LineClient {
  socket: net.Socket;
  queue: unknown[] = [];
  waiters: ((v: unknown) => void)[] = [];
  closed: Promise<void>;
  buf = "";
  constructor(sockPath: string) {
    this.socket = net.createConnection(sockPath);
    this.socket.on("data", (b) => {
      this.buf += b.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        const msg = JSON.parse(line);
        const w = this.waiters.shift();
        if (w) w(msg);
        else this.queue.push(msg);
      }
    });
    this.closed = new Promise((r) => this.socket.on("close", () => r()));
    this.socket.on("error", () => {});
  }
  send(obj: unknown) {
    this.socket.write(`${JSON.stringify(obj)}\n`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  next(timeoutMs = 5000): Promise<any> {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for a line")), timeoutMs);
      this.waiters.push((v) => {
        clearTimeout(t);
        resolve(v);
      });
    });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async rpc(msg: any) {
    this.send(msg);
    return this.next();
  }
  end() {
    this.socket.destroy();
  }
}

/** Fake process table for the runner's uid killer (no real /proc, no real signals). */
class FakeProcs {
  table: { pid: number; uids: number[]; state: string; threads?: number }[] = [];
  immortal = new Set<number>();
  killed: number[] = [];
  add(pid: number, uid: number, state = "S", threads = 1) {
    this.table.push({ pid, uids: [uid, uid, uid, uid], state, threads });
  }
  list = () => this.table.map((p) => ({ ...p }));
  kill = (pid: number) => {
    this.killed.push(pid);
    if (!this.immortal.has(pid)) this.table = this.table.filter((p) => p.pid !== pid);
  };
  sleep = async () => {};
}

/** What Noah's control client does (Addendum A1): wait for the challenge, prove the secret, verify the runner. */
async function controlHandshake(c: LineClient, secret = SECRET) {
  const challenge = await c.next();
  expect(challenge).toMatchObject({ op: "challenge", v: 1, nonce: expect.stringMatching(/^[0-9a-f]{32}$/) });
  const nonce = auth.newNonce();
  const reply = await c.rpc({ op: "hello", nonce, mac: auth.controlClientMac(secret, challenge.nonce) });
  return { challenge, nonce, reply, runnerVerified: reply.ok === true && auth.macMatches(reply.mac, auth.controlServerMac(secret, nonce)) };
}

/** What Noah's relay script does (Addendum A2). `macToken`/`macApp` let a test forge a wrong MAC. */
async function attachHandshake(c: LineClient, token: string, app: string, o: { macToken?: string; macApp?: string; extra?: object } = {}) {
  const challenge = await c.next();
  expect(challenge).toMatchObject({ op: "challenge", v: 1 });
  const nonce = auth.newNonce();
  const r = await c.rpc({
    op: "attach",
    app,
    tokenId: auth.tokenIdOf(token),
    nonce,
    mac: auth.mcpClientMac(o.macToken ?? token, challenge.nonce, o.macApp ?? app),
    ...(o.extra ?? {}),
  });
  return { r, runnerVerified: r.ok === true && auth.macMatches(r.mac, auth.mcpServerMac(token, nonce)) };
}

describe("runner over sockets (fake app)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let runner: any;
  let exchange: string;
  let procs: FakeProcs;
  let clock: number | null;
  const clients: LineClient[] = [];

  async function boot(opts: { limits?: object; maxProcs?: number; app?: object } = {}) {
    exchange = path.join(tmp, "x");
    fs.mkdirSync(exchange);
    procs = new FakeProcs();
    clock = null;
    runner = runnerMod.createRunner({
      exchangeDir: exchange,
      tmpRoot: path.join(tmp, "t", "craft"),
      secret: SECRET,
      maxProcs: opts.maxProcs ?? 3,
      limits: { helloTimeoutMs: 2000, ...(opts.limits ?? {}) },
      apps: [opts.app ?? fakeApp()],
      privileged: false,
      ownerOverride: () => self(),
      procs,
      now: () => clock ?? Date.now(),
      log: () => {},
    });
    await runner.start();
    return runner;
  }

  async function ctl() {
    const c = new LineClient(runner.controlPath);
    clients.push(c);
    const hs = await controlHandshake(c);
    expect(hs.reply).toEqual({ ok: true, mac: expect.any(String) });
    expect(hs.runnerVerified).toBe(true);
    let n = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (op: string, args: object = {}): Promise<any> => c.rpc({ id: `r${++n}`, op, ...args });
  }

  async function attach(token: string, app = "fakecraft", o: { macToken?: string; macApp?: string; extra?: object } = {}) {
    const c = new LineClient(runner.mcpPath);
    clients.push(c);
    const { r, runnerVerified } = await attachHandshake(c, token, app, o);
    if (r.ok) expect(runnerVerified).toBe(true);
    return { c, r: r.ok ? { ok: true } : r };
  }

  let rpcId = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (c: LineClient, name: string, args: object = {}): Promise<any> =>
    c.rpc({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });

  async function session(conv = "conv-1") {
    const op = await ctl();
    const sid = sidOf(conv);
    const token = newToken();
    expect((await op("open", { sid })).ok).toBe(true);
    expect((await op("grant", { sid, token })).ok).toBe(true);
    const { c, r } = await attach(token);
    expect(r).toEqual({ ok: true });
    return { op, sid, token, c };
  }

  afterEach(async () => {
    for (const c of clients.splice(0)) c.end();
    if (runner) await runner.stop();
    runner = null;
  });

  it("control: challenge first; a client with the wrong secret, a plaintext secret, a skipped or late hello is refused", async () => {
    await boot();
    // Wrong secret → wrong MAC.
    const bad = new LineClient(runner.controlPath);
    clients.push(bad);
    const hs = await controlHandshake(bad, "w".repeat(40));
    expect(hs.reply).toEqual({ ok: false, error: "unauthorized" });
    await bad.closed;
    // The legacy plaintext hello — even with the RIGHT secret — is never accepted.
    const plain = new LineClient(runner.controlPath);
    clients.push(plain);
    await plain.next();
    expect(await plain.rpc({ op: "hello", secret: SECRET })).toEqual({ ok: false, error: "unauthorized" });
    await plain.closed;
    // A right MAC that also carries the plaintext secret is refused too.
    const both = new LineClient(runner.controlPath);
    clients.push(both);
    const ch = await both.next();
    expect(await both.rpc({ op: "hello", nonce: auth.newNonce(), mac: auth.controlClientMac(SECRET, ch.nonce), secret: SECRET })).toEqual({ ok: false, error: "unauthorized" });
    // A MAC replayed from another connection's challenge fails (fresh nonce per connection).
    const replay = new LineClient(runner.controlPath);
    clients.push(replay);
    const ch2 = await replay.next();
    expect(ch2.nonce).not.toBe(ch.nonce);
    expect(await replay.rpc({ op: "hello", nonce: auth.newNonce(), mac: auth.controlClientMac(SECRET, ch.nonce) })).toEqual({ ok: false, error: "unauthorized" });
    // Ops before the hello.
    const skip = new LineClient(runner.controlPath);
    clients.push(skip);
    await skip.next();
    expect(await skip.rpc({ id: "1", op: "health" })).toEqual({ ok: false, error: "unauthorized" });
    await skip.closed;
    // Silence → hello timeout.
    const silent = new LineClient(runner.controlPath);
    clients.push(silent);
    expect((await silent.next()).op).toBe("challenge");
    expect(await silent.next()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("control: the runner proves the secret back (server MAC over the CLIENT nonce); the secret never crosses the socket", async () => {
    await boot();
    const c = new LineClient(runner.controlPath);
    clients.push(c);
    const sent: Buffer[] = [];
    const write = c.socket.write.bind(c.socket);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c.socket as any).write = (b: any, ...rest: any[]) => {
      sent.push(Buffer.from(b));
      return write(b, ...rest);
    };
    const hs = await controlHandshake(c);
    expect(hs.runnerVerified).toBe(true);
    expect(hs.reply.mac).toBe(auth.controlServerMac(SECRET, hs.nonce));
    expect(hs.reply.mac).not.toBe(auth.controlServerMac(SECRET, hs.challenge.nonce));
    const op = (o: object) => c.rpc({ id: "x", ...o });
    expect(await op({ op: "health" })).toMatchObject({ ok: true });
    expect(await op({ op: "hello", nonce: hs.nonce, mac: "0".repeat(64) })).toMatchObject({ ok: false, error: expect.stringMatching(/unknown op/) });
    expect(Buffer.concat(sent).includes(Buffer.from(SECRET))).toBe(false);
  });

  it("control: a FAKE runner on the socket path learns nothing and cannot pass the client's server-MAC check", async () => {
    await boot();
    // A squatter (same uid as Noah) that does not know the secret. It answers with a guessed MAC, and
    // also tries to use the REAL runner as an oracle by forwarding the client's hello to it.
    const fakePath = path.join(tmp, "fake.sock");
    const captured: string[] = [];
    let oracle: unknown = null;
    const fake = net.createServer((s) => {
      s.write(`${JSON.stringify({ op: "challenge", v: 1, nonce: auth.newNonce() })}\n`);
      s.on("data", async (b) => {
        captured.push(b.toString("utf8"));
        const real = new LineClient(runner.controlPath);
        clients.push(real);
        await real.next(); // the real runner's (different) challenge
        oracle = await real.rpc(JSON.parse(b.toString("utf8")));
        s.write(`${JSON.stringify({ ok: true, mac: crypto.randomBytes(32).toString("hex") })}\n`);
      });
    });
    await new Promise<void>((r) => fake.listen(fakePath, () => r()));
    try {
      const c = new LineClient(fakePath);
      clients.push(c);
      const hs = await controlHandshake(c);
      expect(hs.reply.ok).toBe(true); // the fake CLAIMS success …
      expect(hs.runnerVerified).toBe(false); // … but its MAC does not verify, so Noah sends nothing more
      expect(oracle).toEqual({ ok: false, error: "unauthorized" }); // the real runner is no oracle
      expect(captured.join("")).not.toContain(SECRET);
      c.end();
    } finally {
      await new Promise((r) => fake.close(r));
    }
  });

  it("serves health with the self-tested manifest and creates the exchange layout", async () => {
    await boot();
    const op = await ctl();
    const h = await op("health");
    expect(h).toMatchObject({ id: "r1", ok: true, procs: { running: 0, max: 3 }, sessions: 0 });
    expect(h.apps).toEqual([{ id: "fakecraft", version: "9.9.9", status: "ready", tools: FAKE_TOOLS.length }]);
    const mode = (p: string) => fs.statSync(path.join(exchange, p)).mode & 0o777;
    expect([mode("."), mode("sock"), mode("inbox"), mode("outbox"), mode("work"), mode("state")]).toEqual([0o711, 0o700, 0o711, 0o711, 0o711, 0o700]);
    expect(fs.statSync(runner.controlPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(runner.mcpPath).mode & 0o777).toBe(0o600);
    expect(await op("bogus")).toMatchObject({ ok: false, error: expect.stringMatching(/unknown op/) });
  });

  it("validates sid and token on every op", async () => {
    await boot();
    const op = await ctl();
    for (const sid of ["", "../../etc", "A".repeat(32), "a".repeat(33)]) {
      expect(await op("open", { sid })).toMatchObject({ ok: false, error: expect.stringMatching(/invalid sid/) });
      expect(await op("purge", { sid })).toMatchObject({ ok: false });
    }
    const sid = sidOf("c");
    expect(await op("grant", { sid, token: "abc" })).toMatchObject({ ok: false, error: expect.stringMatching(/invalid token/) });
    expect(await op("revoke", { token: "abc" })).toMatchObject({ ok: false });
    expect(await op("revoke", { token: newToken() })).toEqual({ id: expect.any(String), ok: true });
    expect(await op("sync_out", { sid })).toMatchObject({ ok: false, error: expect.stringMatching(/open first/) });
    const t = newToken();
    // N8: a grant never (re)opens — the sid must be opened first.
    expect(await op("grant", { sid, token: t })).toMatchObject({ ok: false, error: "no such session — open it first" });
    expect(await op("sync_in", { sid })).toMatchObject({ ok: false, error: expect.stringMatching(/open first/) });
    expect(runner.sessions.o.uids.get(sid)).toBeUndefined();
    await op("open", { sid });
    expect(await op("grant", { sid, token: t })).toMatchObject({ ok: true });
    expect(await op("grant", { sid: sidOf("other"), token: t })).toMatchObject({ ok: false, error: expect.stringMatching(/another session/) });
  });

  it("open + sync_in mirror the inbox into a root-owned in/ and report rejections", async () => {
    await boot();
    const op = await ctl();
    const sid = sidOf("c1");
    const opened = await op("open", { sid });
    expect(opened).toMatchObject({ ok: true, sid, inDir: path.join(exchange, "work", sid, "in"), outDir: path.join(exchange, "work", sid, "out") });
    expect(await op("open", { sid })).toMatchObject({ ok: true }); // idempotent
    const inbox = path.join(exchange, "inbox", sid);
    fs.mkdirSync(path.join(inbox, "attachments"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(inbox, "attachments", "cat.png"), "png");
    fs.symlinkSync("/etc/passwd", path.join(inbox, "attachments", "passwd"));
    const r = await op("sync_in", { sid });
    expect(r).toMatchObject({ ok: true, copied: 1, removed: 0, skipped: 0, bytes: 3, rejected: [{ path: "attachments/passwd", reason: "symlink rejected" }] });
    expect(fs.readFileSync(path.join(opened.inDir, "attachments", "cat.png"), "utf8")).toBe("png");
    expect(fs.statSync(path.join(opened.inDir, "attachments", "cat.png")).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(exchange, "work", sid)).mode & 0o777).toBe(0o700);
    fs.rmSync(path.join(inbox, "attachments", "cat.png"));
    expect(await op("sync_in", { sid })).toMatchObject({ removed: 1 });
    expect((await op("health")).sessions).toBe(1);
  });

  it("answers initialize/tools/list from the manifest WITHOUT spawning, then spawns lazily with an initialize replay", async () => {
    await boot();
    const { op, sid, c } = await session();
    const init = await c.rpc({ jsonrpc: "2.0", id: "i1", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "x" } } });
    expect(init.result.serverInfo).toEqual({ name: "fakecraft", version: "9.9.9" });
    expect(init.result.capabilities).toEqual({ tools: {} });
    expect(init.result.instructions).toContain("Fake craft app.");
    expect(init.result.instructions).toContain(path.join(exchange, "work", sid, "in"));
    expect(init.result.instructions).toContain(path.join(exchange, "work", sid, "out"));
    c.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const list = await c.rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(FAKE_TOOLS);
    expect(await c.rpc({ jsonrpc: "2.0", id: 3, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    expect((await c.rpc({ jsonrpc: "2.0", id: 4, method: "resources/list" })).error.code).toBe(-32601);
    expect((await op("health")).procs.running).toBe(0);

    const who = JSON.parse((await call(c, "whoami")).result.content[0].text);
    expect(who).toMatchObject({ initializeCount: 1, initialized: true, cwd: path.join(exchange, "work", sid) });
    expect(Object.keys(who.env).sort()).toEqual(["FONTCONFIG_FILE", "HOME", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]);
    expect(who.env.HOME).toBe(path.join(tmp, "t", "craft", sid, "home"));
    expect(who.env.CRAFT_CONTROL_SECRET).toBeUndefined();
    expect((await op("health")).procs.running).toBe(1);
    const who2 = JSON.parse((await call(c, "whoami")).result.content[0].text);
    expect(who2.pid).toBe(who.pid); // same child for the run
  });

  it("denies tools and commands without spawning and clamps preview size", async () => {
    await boot();
    const { op, c } = await session();
    const denied = await call(c, "ui_inspect");
    expect(denied.result.isError).toBe(true);
    const cmd = await call(c, "command_run", { id: "file.open", params: { path: "/etc/passwd" } });
    expect(cmd.result).toMatchObject({ isError: true });
    expect(cmd.result.content[0].text).toMatch(/file\.open/);
    const batch = await call(c, "command_batch", { steps: [{ id: "layer.new.layer" }, { id: "plugin.install", params: { data: "AA" } }] });
    expect(batch.result.isError).toBe(true);
    expect((await op("health")).procs.running).toBe(0);
    const prev = await call(c, "render_preview", { max_side: 5000 });
    expect(prev.result.content[0].type).toBe("image");
    expect(JSON.parse(prev.result.content[1].text)).toEqual({ max_side: 1568 });
    const ok = await call(c, "command_run", { id: "filter.blur.gaussianBlur", params: { radius: 3 } });
    expect(JSON.parse(ok.result.content[0].text)).toEqual({ ran: "filter.blur.gaussianBlur", params: { radius: 3 } });
  });

  it("syncs out/ to the outbox BEFORE the tool result is returned", async () => {
    await boot();
    const { op, sid, c } = await session();
    const r = await call(c, "doc_export", { path: "renders/final.png", content: "PNGDATA" });
    expect(r.result.isError).toBe(false);
    const out = path.join(exchange, "outbox", sid, "renders", "final.png");
    expect(fs.readFileSync(out, "utf8")).toBe("PNGDATA"); // already there when the response arrived
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    const listing = await op("sync_out", { sid });
    expect(listing.files).toEqual([{ path: "renders/final.png", size: 7, mtimeMs: expect.any(Number) }]);
    // the app can also write outside out/ in its own work dir, but only out/ is mirrored back
    expect(fs.existsSync(path.join(exchange, "outbox", sid, "in"))).toBe(false);
  });

  it("confines doc_open to the read root (fake app honours its roots like PhotoCraft)", async () => {
    await boot();
    const { c } = await session();
    const r = await call(c, "doc_open", { path: "/etc/hostname" });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/automation path rejected/);
  });

  it("replaces an over-cap response with an isError result and keeps the child usable", async () => {
    await boot({ limits: { maxResponseLineBytes: 64 * 1024 } });
    const { c } = await session();
    const r = await call(c, "big", { bytes: 200 * 1024 });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/exceeded the 0\.0625 MiB response cap/);
    const ok = await call(c, "big", { bytes: 10 });
    expect(ok.result.content[0].text).toBe("x".repeat(10));
  });

  it("kills a timed-out child, reports lost documents, and respawns on the next call", async () => {
    await boot({ limits: { callTimeoutMs: 400 } });
    const { op, c } = await session();
    const before = JSON.parse((await call(c, "whoami")).result.content[0].text).pid;
    const r = await call(c, "sleep", { ms: 5000 });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/timed out after 0 s: the FakeCraft process was restarted; open documents were lost — reopen from in\/ or out\//);
    await new Promise((res) => setTimeout(res, 100));
    expect((await op("health")).procs.running).toBe(0);
    const after = JSON.parse((await call(c, "whoami")).result.content[0].text);
    expect(after.pid).not.toBe(before);
    expect(after.initializeCount).toBe(1);
  });

  it("reports a crashed child and recovers", async () => {
    await boot();
    const { c } = await session();
    const r = await call(c, "crash");
    expect(r.result.content[0].text).toMatch(/exited unexpectedly/);
    expect((await call(c, "whoami")).result.isError).toBe(false);
  });

  it("caps live processes globally: an over-cap spawn waits, then answers busy", async () => {
    await boot({ maxProcs: 1, limits: { spawnWaitMs: 300 } });
    const a = await session("conv-a");
    await call(a.c, "whoami");
    const b = await session("conv-b");
    const t0 = Date.now();
    const r = await call(b.c, "whoami");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/busy/);
    // Revoking A frees the slot for B.
    await a.op("revoke", { token: a.token });
    expect((await call(b.c, "whoami")).result.isError).toBe(false);
  });

  it("kills an idle child; the next call respawns it", async () => {
    await boot({ limits: { idleMs: 200 } });
    const { op, c } = await session();
    const p1 = JSON.parse((await call(c, "whoami")).result.content[0].text).pid;
    await new Promise((r) => setTimeout(r, 500));
    expect((await op("health")).procs.running).toBe(0);
    const p2 = JSON.parse((await call(c, "whoami")).result.content[0].text).pid;
    expect(p2).not.toBe(p1);
  });

  it("relays progress, answers child→client requests itself, maps cancellations", async () => {
    await boot();
    const { c } = await session();
    c.send({ jsonrpc: "2.0", id: 900, method: "tools/call", params: { name: "progress", arguments: {}, _meta: { progressToken: "pt" } } });
    const first = await c.next();
    expect(first).toMatchObject({ method: "notifications/progress", params: { progressToken: "pt" } });
    const second = await c.next();
    expect(second).toMatchObject({ id: 900, result: { content: [{ text: "progressed" }] } });
    expect(c.queue).toEqual([]); // the child's roots/list request never reached the client
    c.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 12345 } }); // unknown: ignored
    expect((await call(c, "whoami")).result.isError).toBe(false);
  });

  it("rejects unknown tokens and apps on attach", async () => {
    await boot();
    expect((await attach(newToken())).r).toEqual({ ok: false, error: "unknown or revoked token" });
    const { token } = await session();
    expect((await attach(token, "photocraft")).r).toEqual({ ok: false, error: "unknown app" });
    const garbage = new LineClient(runner.mcpPath);
    clients.push(garbage);
    expect((await garbage.next()).op).toBe("challenge");
    expect(await garbage.rpc({ jsonrpc: "2.0", id: 1, method: "initialize" })).toEqual({ ok: false, error: "first line must be an attach" });
    const badId = new LineClient(runner.mcpPath);
    clients.push(badId);
    const ch = await badId.next();
    expect(await badId.rpc({ op: "attach", app: "fakecraft", tokenId: "nope", nonce: auth.newNonce(), mac: auth.mcpClientMac(token, ch.nonce, "fakecraft") })).toEqual({ ok: false, error: "invalid tokenId" });
  });

  it("attach: a wrong MAC (wrong token, or a MAC bound to another app), a plaintext token, or a bad nonce is refused", async () => {
    await boot();
    const { token } = await session();
    expect((await attach(token, "fakecraft", { macToken: newToken() })).r).toEqual({ ok: false, error: "unauthorized" });
    expect((await attach(token, "fakecraft", { macApp: "photocraft" })).r).toEqual({ ok: false, error: "unauthorized" });
    expect((await attach(token, "fakecraft", { extra: { token } })).r).toEqual({ ok: false, error: "unauthorized" });
    expect((await attach(token, "fakecraft", { extra: { nonce: "short" } })).r).toEqual({ ok: false, error: "unauthorized" });
    // The legacy plaintext attach line.
    const legacy = new LineClient(runner.mcpPath);
    clients.push(legacy);
    await legacy.next();
    expect(await legacy.rpc({ op: "attach", token, app: "fakecraft" })).toEqual({ ok: false, error: "unauthorized" });
    await legacy.closed;
    // A refused attach leaves the token usable.
    expect((await attach(token)).r).toEqual({ ok: true });
  });

  it("attach: the runner answers with the server MAC over the RELAY nonce; the token never crosses the socket", async () => {
    await boot();
    const op = await ctl();
    const sid = sidOf("mac");
    const token = newToken();
    await op("open", { sid });
    await op("grant", { sid, token });
    const c = new LineClient(runner.mcpPath);
    clients.push(c);
    const sent: Buffer[] = [];
    const write = c.socket.write.bind(c.socket);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c.socket as any).write = (b: any, ...rest: any[]) => {
      sent.push(Buffer.from(b));
      return write(b, ...rest);
    };
    const { r, runnerVerified } = await attachHandshake(c, token, "fakecraft");
    expect(r).toEqual({ ok: true, mac: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(runnerVerified).toBe(true);
    const init = await c.rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(init.result.serverInfo.name).toBe("fakecraft");
    expect(Buffer.concat(sent).includes(Buffer.from(token))).toBe(false);
  });

  it("attach: a FAKE runner cannot produce the server MAC and never sees the token", async () => {
    const fakePath = path.join(tmp, "fake-mcp.sock");
    const captured: string[] = [];
    const fake = net.createServer((s) => {
      s.write(`${JSON.stringify({ op: "challenge", v: 1, nonce: auth.newNonce() })}\n`);
      s.on("data", (b) => {
        captured.push(b.toString("utf8"));
        const msg = JSON.parse(b.toString("utf8"));
        // Best a squatter can do: a MAC keyed by what it saw (the tokenId), not the token.
        s.write(`${JSON.stringify({ ok: true, mac: auth.mcpServerMac(msg.tokenId, msg.nonce) })}\n`);
      });
    });
    await new Promise<void>((r) => fake.listen(fakePath, () => r()));
    try {
      const token = newToken();
      const c = new LineClient(fakePath);
      clients.push(c);
      const { r, runnerVerified } = await attachHandshake(c, token, "photocraft");
      expect(r.ok).toBe(true);
      expect(runnerVerified).toBe(false); // the relay would close before forwarding a single CLI byte
      expect(captured.join("")).not.toContain(token);
      c.end();
    } finally {
      await new Promise((r) => fake.close(r));
    }
  });

  it("revoke kills the processes and closes the token's connections; a new grant replaces the old token", async () => {
    await boot();
    const { op, sid, token, c } = await session();
    await call(c, "whoami");
    expect((await op("health")).procs.running).toBe(1);
    const token2 = newToken();
    expect(await op("grant", { sid, token: token2 })).toMatchObject({ ok: true });
    await c.closed;
    expect((await op("health")).procs.running).toBe(0);
    expect((await attach(token)).r.ok).toBe(false);
    const { c: c2, r } = await attach(token2);
    expect(r.ok).toBe(true);
    await call(c2, "whoami");
    expect(await op("revoke", { token: token2 })).toMatchObject({ ok: true });
    await c2.closed;
    expect((await op("health")).procs.running).toBe(0);
  });

  it("a second attach for the same token+app replaces the first connection", async () => {
    await boot();
    const { token, c } = await session();
    const { r } = await attach(token);
    expect(r.ok).toBe(true);
    await c.closed;
  });

  it("purge kills, deletes every session dir and frees the uid", async () => {
    await boot();
    const { op, sid, c } = await session();
    fs.mkdirSync(path.join(exchange, "inbox", sid), { recursive: true });
    fs.writeFileSync(path.join(exchange, "inbox", sid, "a.txt"), "a");
    await op("sync_in", { sid });
    await call(c, "write_file", { path: "x.png", content: "x" });
    expect(await op("purge", { sid })).toMatchObject({ ok: true });
    await c.closed;
    for (const d of ["inbox", "work", "outbox"]) expect(fs.existsSync(path.join(exchange, d, sid)), d).toBe(false);
    expect(fs.existsSync(path.join(tmp, "t", "craft", sid))).toBe(false);
    const h = await op("health");
    expect(h.sessions).toBe(0);
    expect(h.procs.running).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(exchange, "state", "uids.json"), "utf8"))).toMatchObject({ v: 2, sessions: {} });
  });

  it("garbage-collects idle sessions without a live token", async () => {
    await boot({ limits: { sessionGcMs: 1000 } });
    const op = await ctl();
    const idle = sidOf("idle");
    const live = sidOf("live");
    await op("open", { sid: idle });
    await op("open", { sid: live });
    await op("grant", { sid: live, token: newToken() });
    const purged = await runner.sessions.gc(Date.now() + 5000);
    expect(purged).toEqual([idle]);
    expect(fs.existsSync(path.join(exchange, "work", idle))).toBe(false);
    expect(fs.existsSync(path.join(exchange, "work", live))).toBe(true);
  });

  it("tokens expire 12 h after grant: attach refused, a live connection's next call is refused and revoked", async () => {
    await boot();
    clock = Date.now();
    const { op, sid, token, c } = await session();
    expect((await call(c, "whoami")).result.isError).toBe(false);
    clock += 12 * 3_600_000 - 1;
    expect((await call(c, "whoami")).result.isError).toBe(false);
    clock += 1;
    const r = await call(c, "whoami");
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/session expired \(a run token lives 12 h\)/);
    await c.closed; // revoked → connection closed
    expect((await attach(token)).r).toEqual({ ok: false, error: "unknown or revoked token" });
    expect(await op("grant", { sid, token })).toMatchObject({ ok: true }); // the old token is gone: a re-grant is a NEW 12 h token
  });

  it("the sweeper revokes expired tokens (which then no longer pin the session against GC); re-granting an expired token fails", async () => {
    await boot({ limits: { sessionGcMs: 1000 } });
    clock = Date.now();
    const op = await ctl();
    const sid = sidOf("sweep");
    const token = newToken();
    await op("open", { sid });
    await op("grant", { sid, token });
    const { c } = await attach(token);
    expect(await runner.sessions.sweepExpired()).toBe(0);
    clock += 12 * 3_600_000;
    expect(await op("grant", { sid, token })).toMatchObject({ ok: false, error: "token expired" });
    await c.closed;
    const t2 = newToken();
    await op("grant", { sid, token: t2 });
    clock += 12 * 3_600_000;
    expect(await runner.sessions.sweepExpired()).toBe(1);
    expect(runner.sessions.tokens.size).toBe(0);
    expect(await runner.sessions.gc(clock + 5000)).toEqual([sid]);
  });

  it("revoke_all revokes every token, closes every connection and kills every process", async () => {
    await boot();
    const a = await session("conv-a");
    const b = await session("conv-b");
    await call(a.c, "whoami");
    await call(b.c, "whoami");
    expect((await a.op("health")).procs.running).toBe(2);
    expect(await a.op("revoke_all")).toEqual({ id: expect.any(String), ok: true, revoked: 2 });
    await Promise.all([a.c.closed, b.c.closed]);
    expect((await a.op("health")).procs.running).toBe(0);
    expect((await attach(a.token)).r.ok).toBe(false);
    expect((await attach(b.token)).r.ok).toBe(false);
    expect(await a.op("revoke_all")).toMatchObject({ ok: true, revoked: 0 });
  });

  const uidOf = (sid: string) => JSON.parse(fs.readFileSync(path.join(exchange, "state", "uids.json"), "utf8")).sessions[sid];

  it("purge kills EVERY process of the session uid (setsid escapees too) before the uid returns to the pool", async () => {
    await boot();
    const { op, sid } = await session();
    const uid = uidOf(sid);
    procs.add(4001, uid); // escaped its process group
    procs.add(4002, uid + 1); // another session: untouched
    procs.add(4003, 1000);
    expect(await op("purge", { sid })).toMatchObject({ ok: true });
    expect(procs.killed).toContain(4001);
    expect(procs.killed).not.toContain(4002);
    expect(procs.killed).not.toContain(4003);
    expect(uidOf(sid)).toBeUndefined();
  });

  it("revoke kills the uid's stray processes too", async () => {
    await boot();
    const { op, sid, token } = await session();
    procs.add(4101, uidOf(sid));
    await op("revoke", { token });
    expect(procs.killed).toEqual([4101]);
  });

  it("a uid whose processes survive SIGKILL stays RESERVED (purge reports it; GC/purge retry frees it later)", async () => {
    await boot();
    const op = await ctl();
    const sid = sidOf("stuck");
    await op("open", { sid });
    const uid = uidOf(sid);
    procs.add(4201, uid);
    procs.immortal.add(4201);
    const r = await op("purge", { sid });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/survived; the uid stays reserved/) });
    expect(uidOf(sid)).toBe(uid);
    expect(fs.existsSync(path.join(exchange, "work", sid))).toBe(false); // the files are gone regardless
    // Other sessions never get that uid meanwhile.
    for (const conv of ["n1", "n2", "n3"]) {
      await op("open", { sid: sidOf(conv) });
      expect(uidOf(sidOf(conv))).not.toBe(uid);
    }
    procs.immortal.clear();
    expect(await op("purge", { sid })).toMatchObject({ ok: true });
    expect(uidOf(sid)).toBeUndefined();
  });

  it("hands uids out round-robin across purges (a just-freed uid is not reused next)", async () => {
    await boot();
    const op = await ctl();
    const a = sidOf("rr-a");
    await op("open", { sid: a });
    const uidA = uidOf(a);
    await op("purge", { sid: a });
    const b = sidOf("rr-b");
    await op("open", { sid: b });
    expect(uidOf(b)).toBe(uidA + 1);
    expect(JSON.parse(fs.readFileSync(path.join(exchange, "state", "uids.json"), "utf8")).next).toBe(uidA + 2);
  });

  it("purge removes a 3000-level chain in out/ and the inbox, and every other tree, without failing", async () => {
    await boot();
    const { op, sid } = await session();
    deepChain(path.join(exchange, "work", sid, "out"), 3000);
    fs.mkdirSync(path.join(exchange, "inbox", sid), { recursive: true });
    deepChain(path.join(exchange, "inbox", sid), 3000);
    expect(await op("purge", { sid })).toMatchObject({ ok: true });
    for (const d of ["inbox", "work", "outbox"]) expect(fs.existsSync(path.join(exchange, d, sid)), d).toBe(false);
    expect(uidOf(sid)).toBeUndefined();
  });

  it("one tree that cannot be removed never stops purge of the others; the sid stays tracked for a retry", async () => {
    await boot({ limits: { removeMaxOps: 40 } });
    const { op, sid } = await session();
    const inbox = path.join(exchange, "inbox", sid);
    fs.mkdirSync(inbox, { recursive: true });
    for (let i = 0; i < 100; i += 1) fs.writeFileSync(path.join(inbox, `f${i}`), "x");
    const r = await op("purge", { sid });
    expect(r).toMatchObject({ ok: false, error: "purge incomplete: could not remove inbox" });
    expect(fs.existsSync(path.join(exchange, "work", sid))).toBe(false);
    expect(fs.existsSync(path.join(exchange, "outbox", sid))).toBe(false);
    expect(uidOf(sid)).toBeDefined();
  });

  it("sync_out removes a deep chain planted in the outbox and reports too_deep entries of out/", async () => {
    await boot();
    const { op, sid } = await session();
    deepChain(path.join(exchange, "outbox", sid), 2000);
    deepChain(path.join(exchange, "work", sid, "out"), 40);
    fs.writeFileSync(path.join(exchange, "work", sid, "out", "ok.png"), "ok");
    const r = await op("sync_out", { sid });
    expect(r.ok).toBe(true);
    expect(r.files.map((f: { path: string }) => f.path)).toEqual(["ok.png"]);
    expect(r.rejected[0].reason).toMatch(/^too_deep/);
    expect(fs.readdirSync(path.join(exchange, "outbox", sid)).sort()).toEqual(["d", "ok.png"]); // the mirrored 32 levels only
    expect(r.budget).toMatchObject({ over: "session", outUnmeasured: 1, message: expect.stringMatching(/more than 32 levels deep/) });
  });

  it("per-session out/ budget: the call that crosses it becomes isError (content kept), later calls are refused, sync_out reports it", async () => {
    await boot({ limits: { sessionOutMaxBytes: 1000 } });
    const { op, sid, c } = await session();
    const ok = await call(c, "write_file", { path: "small.png", content: "x".repeat(400) });
    expect(ok.result.isError).toBe(false);
    expect((await op("sync_out", { sid })).budget).toEqual({ outBytes: 400, outMaxBytes: 1000, outUnmeasured: 0, exchangeBytes: expect.any(Number), exchangeMaxBytes: 20 * 1024 * MiB, over: null });
    const crossing = await call(c, "write_file", { path: "big.png", content: "y".repeat(2000) });
    expect(crossing.result.isError).toBe(true);
    expect(crossing.result.content[0].text).toMatch(/big\.png/); // the app's own result is kept
    expect(crossing.result.content.at(-1).text).toMatch(/Craft storage budget exceeded: this conversation's out\/ directory holds 2400 bytes, over its 1000 bytes/);
    const refused = await call(c, "whoami");
    expect(refused.result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/Craft app calls in this conversation are refused/) }] });
    const so = await op("sync_out", { sid });
    expect(so.budget).toMatchObject({ over: "session", outBytes: 2400, message: expect.stringMatching(/share_file/) });
  });

  it("global exchange budget: an over-budget exchange refuses calls WITHOUT spawning; health reports usage", async () => {
    await boot({ limits: { exchangeMaxBytes: 500, exchangeMeasureMs: 0 } });
    const { op, sid, c } = await session();
    const inbox = path.join(exchange, "inbox", sid);
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, "huge.png"), Buffer.alloc(800));
    const r = await call(c, "whoami");
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/shared storage holds 800 bytes of its 500 bytes budget/);
    const h = await op("health");
    expect(h.procs.running).toBe(0);
    expect(h.exchange).toEqual({ bytes: 800, maxBytes: 500 });
    expect((await op("sync_out", { sid })).budget).toMatchObject({ over: "exchange" });
  });

  it("N2: over the exchange budget, open of a NEW session and sync_in are refused with a budget object; an existing session still opens", async () => {
    await boot({ limits: { exchangeMaxBytes: 500, exchangeMeasureMs: 0 } });
    const op = await ctl();
    const sid = sidOf("existing");
    expect((await op("open", { sid })).ok).toBe(true);
    const inbox = path.join(exchange, "inbox", sid);
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, "huge.png"), Buffer.alloc(800));
    // A new conversation gets no session (no uid, no directories).
    const fresh = sidOf("fresh");
    const refused = await op("open", { sid: fresh });
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringMatching(/shared storage holds 800 bytes of its 500 bytes budget, so no new Craft session can be opened/),
      budget: { over: "exchange", exchangeBytes: 800, exchangeMaxBytes: 500, message: refused.error },
    });
    expect(runner.sessions.o.uids.get(fresh)).toBeUndefined();
    expect(fs.existsSync(path.join(exchange, "work", fresh))).toBe(false);
    // The existing session still opens (its results can be delivered) …
    expect(await op("open", { sid })).toMatchObject({ ok: true, inDir: expect.any(String) });
    expect((await op("sync_out", { sid })).ok).toBe(true);
    // … but sync_in copies nothing new in.
    const si = await op("sync_in", { sid });
    expect(si).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no new input files were copied in/),
      budget: { over: "exchange", exchangeBytes: 800, exchangeMaxBytes: 500 },
    });
    expect(si.budget.message).toBe(si.error);
    expect(fs.readdirSync(path.join(exchange, "work", sid, "in"))).toEqual([]);
    // Freed space → both work again.
    fs.rmSync(path.join(inbox, "huge.png"));
    fs.writeFileSync(path.join(inbox, "small.png"), "s");
    expect(await op("sync_in", { sid })).toMatchObject({ ok: true, copied: 1, rejectedTotal: 0 });
    expect((await op("open", { sid: fresh })).ok).toBe(true);
  });

  it("N4: a bad-named directory in out/ is MEASURED and rejected as bad_name — never an unmeasured lock-out", async () => {
    await boot({ limits: { sessionOutMaxBytes: 1000 } });
    const { op, sid, c } = await session();
    const out = path.join(exchange, "work", sid, "out");
    fs.mkdirSync(path.join(out, "a\\b", "nested"), { recursive: true });
    fs.writeFileSync(path.join(out, "a\\b", "nested", "x.png"), Buffer.alloc(300));
    fs.writeFileSync(path.join(out, "ok.png"), Buffer.alloc(100));
    const so = await op("sync_out", { sid });
    expect(so.rejected).toEqual([{ path: "a\\b", reason: "bad_name", detail: "separator in name" }]);
    expect(so.budget).toMatchObject({ over: null, outBytes: 400, outUnmeasured: 0 });
    expect((await call(c, "whoami")).result.isError).toBe(false); // not locked out
    // Its bytes count: growing it past the budget is reported as SIZE, not as nesting.
    fs.writeFileSync(path.join(out, "a\\b", "nested", "y.png"), Buffer.alloc(900));
    const over = await op("sync_out", { sid });
    expect(over.budget).toMatchObject({ over: "session", outBytes: 1300, outUnmeasured: 0 });
    expect(over.budget.message).toMatch(/holds 1300 bytes, over its 1000 bytes per-conversation budget/);
    expect(over.budget.message).not.toMatch(/levels deep/);
  });

  it("N5: GC (and boot) remove work/outbox/tmp trees whose sid has no state entry; their uid's processes die first", async () => {
    await boot({ limits: { sessionGcMs: 1000 } });
    const op = await ctl();
    const kept = sidOf("kept");
    await op("open", { sid: kept });
    const orphan = sidOf("orphan");
    for (const d of [path.join(exchange, "work"), path.join(exchange, "outbox"), path.join(tmp, "t", "craft")]) {
      fs.mkdirSync(path.join(d, orphan, "sub"), { recursive: true });
      fs.writeFileSync(path.join(d, orphan, "sub", "f"), "x");
    }
    fs.mkdirSync(path.join(exchange, "work", "not-a-sid")); // never touched
    expect(await runner.sessions.gc(Date.now())).toEqual([]);
    for (const d of [path.join(exchange, "work"), path.join(exchange, "outbox"), path.join(tmp, "t", "craft")]) {
      expect(fs.existsSync(path.join(d, orphan))).toBe(false);
    }
    expect(fs.existsSync(path.join(exchange, "work", "not-a-sid"))).toBe(true);
    expect(fs.existsSync(path.join(exchange, "work", kept))).toBe(true);
    // A restarted runner sweeps them at boot as well.
    await runner.stop();
    fs.mkdirSync(path.join(exchange, "work", orphan));
    fs.rmSync(path.join(exchange, "state", "uids.json")); // state lost: `kept` is an orphan now too
    const again = runnerMod.createRunner({
      exchangeDir: exchange,
      tmpRoot: path.join(tmp, "t", "craft"),
      secret: SECRET,
      limits: { helloTimeoutMs: 2000 },
      apps: [fakeApp()],
      privileged: false,
      ownerOverride: () => self(),
      procs,
      log: () => {},
    });
    runner = again;
    await again.start();
    expect(fs.existsSync(path.join(exchange, "work", orphan))).toBe(false);
    expect(fs.existsSync(path.join(exchange, "work", kept))).toBe(false);
  });

  it("N5: a new session never gets a uid that still owns a process (state lost); the pool skips it", async () => {
    await boot();
    const op = await ctl();
    procs.add(5001, 20000); // a leftover of a session whose state entry was lost
    const sid = sidOf("skip");
    await op("open", { sid });
    expect(uidOf(sid)).toBe(20001);
  });

  it("N7: sync_in lists EVERY staged/ rejection even behind more than 100 other rejections, plus rejectedTotal", async () => {
    await boot();
    const op = await ctl();
    const sid = sidOf("staged");
    await op("open", { sid });
    const inbox = path.join(exchange, "inbox", sid);
    fs.mkdirSync(path.join(inbox, "staged"), { recursive: true });
    for (let i = 0; i < 150; i += 1) fs.symlinkSync("/etc/passwd", path.join(inbox, `a${String(i).padStart(3, "0")}`));
    fs.symlinkSync("/etc/passwd", path.join(inbox, "staged", "logo.png"));
    const r = await op("sync_in", { sid });
    expect(r.ok).toBe(true);
    expect(r.rejectedTotal).toBe(151);
    expect(r.rejected).toHaveLength(101);
    expect(r.rejected[0]).toEqual({ path: "staged/logo.png", reason: "symlink rejected" });
  });

  it("N8: a grant after purge is refused and never resurrects the session; a grant racing a purge dies with it", async () => {
    await boot();
    const { op, sid, token } = await session("deleted");
    expect((await op("purge", { sid })).ok).toBe(true);
    expect(await op("grant", { sid, token: newToken() })).toMatchObject({ ok: false, error: "no such session — open it first" });
    expect(await op("grant", { sid, token })).toMatchObject({ ok: false, error: "no such session — open it first" });
    expect(await op("sync_in", { sid })).toMatchObject({ ok: false, error: expect.stringMatching(/open first/) });
    expect(runner.sessions.o.uids.get(sid)).toBeUndefined();
    expect(fs.existsSync(path.join(exchange, "work", sid))).toBe(false);
    expect(runner.sessions.tokens.size).toBe(0);
    // Concurrent: grant and purge sent back-to-back — whichever order the runner serializes them in,
    // no live token survives for a purged sid.
    const sid2 = sidOf("race");
    await op("open", { sid: sid2 });
    const t2 = newToken();
    const [g, p] = await Promise.all([op("grant", { sid: sid2, token: t2 }), op("purge", { sid: sid2 })]);
    expect(p.ok).toBe(true);
    expect(runner.sessions.o.uids.get(sid2)).toBeUndefined();
    expect(runner.sessions.tokens.has(t2)).toBe(false);
    if (!g.ok) expect(g.error).toBe("no such session — open it first");
    expect((await attach(t2)).r.ok).toBe(false);
  });

  it("reports a failing self-test with control characters stripped and at most 300 characters", async () => {
    await boot({ app: fakeApp({ FAKE_ESCAPE: "1", FAKE_STDERR: `\u001b[31mboom\u001b[0m\n${"z".repeat(1000)}\r\n` }) });
    const h = await (await ctl())("health");
    expect(h.apps[0].status).toBe("failed");
    expect(h.apps[0].error).toMatch(/^self-test failed: confinement failed/);
    expect(Array.from(h.apps[0].error as string).length).toBeLessThanOrEqual(300);
    // eslint-disable-next-line no-control-regex
    expect(h.apps[0].error).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("marks an app failed (never served) when confinement does not hold", async () => {
    await boot({ app: fakeApp({ FAKE_ESCAPE: "1" }) });
    const op = await ctl();
    const h = await op("health");
    expect(h.apps[0]).toMatchObject({ id: "fakecraft", status: "failed", tools: 0 });
    expect(h.apps[0].error).toMatch(/confinement failed/);
    const sid = sidOf("c");
    const token = newToken();
    await op("open", { sid });
    await op("grant", { sid, token });
    expect((await attach(token)).r).toMatchObject({ ok: false, error: expect.stringMatching(/not available/) });
  });

  it("marks an app failed when its tool list drifts or its version does not match", async () => {
    await boot({ app: fakeApp({ FAKE_EXTRA_TOOL: "new_tool" }) });
    let h = await (await ctl())("health");
    expect(h.apps[0].error).toMatch(/drifted.*added: new_tool/);
    for (const c of clients.splice(0)) c.end();
    await runner.stop();
    fs.rmSync(path.join(tmp, "x"), { recursive: true, force: true });
    await boot({ app: fakeApp({ FAKE_VERSION: "1.0.0" }) });
    h = await (await ctl())("health");
    expect(h.apps[0].error).toMatch(/reports version 1\.0\.0, registry pins 9\.9\.9/);
  });
});

describe("self-test helpers", () => {
  it("builds a valid PNG", () => {
    const png = selftest.solidPng(2, 3);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(3);
  });
});

it("MiB helper sanity", () => {
  expect(config.DEFAULT_LIMITS.maxResponseLineBytes).toBe(10 * MiB);
  expect(config.DEFAULT_LIMITS.maxFileBytes).toBe(200 * MiB);
  expect(config.DEFAULT_LIMITS.callTimeoutMs).toBe(120_000);
  expect(config.DEFAULT_LIMITS.idleMs).toBe(600_000);
});
