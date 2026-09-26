import {
  spawn as realSpawn,
  spawnSync as realSpawnSync,
  type SpawnOptions,
  type SpawnSyncOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "./helpers.js";

// Capture the deck-render child logger: "each failure is logged at warn" is a
// contract (a failed probe must be visible to the operator), and the logger is
// its only observable output.
const logs = vi.hoisted(() => {
  const entries: { level: string; payload: Record<string, unknown>; msg: string }[] = [];
  const child: Record<string, unknown> = {};
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
    child[level] = (payload?: unknown, msg?: string) => {
      entries.push({
        level,
        payload: (typeof payload === "object" && payload ? payload : {}) as Record<string, unknown>,
        msg: typeof payload === "string" ? payload : (msg ?? ""),
      });
    };
  }
  child.child = () => child;
  return { entries, child };
});
vi.mock("../src/server/logger.js", () => ({ default: logs.child }));

import {
  __setDeckRenderingForTests,
  __setDeckToolchainForTests,
  deckAuthoringStatusFor,
  deckConverterScript,
  deckGuidanceFlags,
  deckModeOf,
  deckToolchainLogFields,
  probeDeckRendering,
  probeDeckToolchain,
  probeDocumentPreviews,
  renderDocumentPreviews,
  type DeckToolchainState,
} from "../src/server/deckRender.js";

type SpawnSyncFn = typeof realSpawnSync;
type SpawnFn = typeof realSpawn;

const PROBE_OK = {
  format: "noah-deck-probe",
  version: 1,
  converter: true,
  converterVersion: "1.0.0",
  chromium: {
    ok: true,
    path: "/usr/lib/chromium/chromium-headless-shell",
    source: "debian-headless-shell",
    version: "154.0.8037.57",
  },
  playwrightCore: { ok: true, version: "1.61.1" },
  python: { ok: true, executable: "python3", version: "3.11.2", missingModules: [] },
  fonts: { embedded: true, malgun: true },
  profiles: ["embedded", "malgun"],
  limits: {
    maxSlides: 60,
    maxSeconds: 540,
    maxSlideHtmlBytes: 2097152,
    maxDomElements: 2500,
    maxAssetBytes: 20971520,
    maxDeckInputBytes: 104857600,
    maxConcurrent: 2,
    slotWaitSeconds: 150,
  },
  selftest: { status: "pass", chromiumVersion: "154.0.8037.57", at: "2026-09-26T03:00:00Z", maxDelta: 0, differences: 0 },
  missing: [],
};

const PROBE_NO_CHROMIUM = {
  ...PROBE_OK,
  converter: false,
  chromium: { ok: false, path: null, source: null, version: null },
  selftest: { status: "not-recorded" },
  missing: ["Chromium headless shell is not installed in this image"],
};

const probeJson = (value: unknown) => JSON.stringify(value);

/** A scripted spawnSync that records every call. */
function fakeSpawnSync(result: Record<string, unknown> | (() => Record<string, unknown>)) {
  const calls: { command: string; args: string[]; options: SpawnSyncOptions }[] = [];
  const fn = ((command: string, args: string[], options: SpawnSyncOptions) => {
    calls.push({ command, args, options });
    const base = { pid: 4242, output: [], stdout: "", stderr: "", status: 0, signal: null };
    return { ...base, ...(typeof result === "function" ? result() : result) };
  }) as unknown as SpawnSyncFn;
  return { fn, calls };
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = Object.assign(new EventEmitter(), { resume: () => undefined });
  killed: string[] = [];
  kill(signal?: string) {
    this.killed.push(signal ?? "SIGTERM");
    // A killed probe closes with the signal, exactly like a real child.
    queueMicrotask(() => this.emit("close", null, signal ?? "SIGTERM"));
    return true;
  }
}

/** A scripted async spawn: the test drives each child's output/exit by hand. */
function fakeSpawn() {
  const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
  const children: FakeChild[] = [];
  const fn = ((command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as SpawnFn;
  return { fn, calls, children };
}

/** Let the background re-probe's promise chain settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const MINUTE = 60_000;

const tempDir = withTempDir("deck-toolchain");

/** A DEFAULT_PLUGINS_DIR with plugin.json and (optionally) the converter script. */
function pluginsDir(opts: { pluginName?: string | null; script?: string | null } = {}) {
  const dir = path.join(tempDir(), `plugins-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  if (opts.pluginName !== null) {
    fs.writeFileSync(
      path.join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: opts.pluginName ?? "avatar-defaults", version: "0.1.0" }),
    );
  }
  const script = deckConverterScript(dir);
  if (opts.script !== null) {
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, opts.script ?? "// probe stub (never executed by fakes)\n");
  }
  return { dir, script, config: { defaultPluginsDir: dir } };
}

beforeEach(() => {
  logs.entries.length = 0;
  __setDeckToolchainForTests(null);
  // Pin the legacy half so no test shells out to soffice/pdftoppm/python3.
  __setDeckRenderingForTests(false);
});

afterEach(() => {
  __setDeckToolchainForTests(null);
  __setDeckRenderingForTests(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("probeDeckToolchain — definitive results", () => {
  it("reads a converter probe into the state and memoizes it", () => {
    const p = pluginsDir();
    const sync = fakeSpawnSync({ status: 0, stdout: probeJson(PROBE_OK) });
    const state = probeDeckToolchain(p.config, { spawnSync: sync.fn, now: () => 1_000 });

    expect(state).toEqual({
      pythonPptx: false,
      libreOffice: false,
      converter: true,
      converterVersion: "1.0.0",
      chromiumVersion: "154.0.8037.57",
      profiles: ["embedded", "malgun"],
      limits: PROBE_OK.limits,
      selftest: "pass",
      converterMissing: [],
      pptxSkillNames: ["pptx", "avatar-defaults:pptx"],
      definitive: true,
    });
    expect(deckModeOf(state)).toBe("converter");
    // The exact command: the server's own node binary on the skill's script.
    expect(sync.calls).toHaveLength(1);
    expect(sync.calls[0].command).toBe(process.execPath);
    expect(sync.calls[0].args).toEqual([p.script, "probe", "--json"]);
    expect(sync.calls[0].options).toMatchObject({ timeout: 10_000, killSignal: "SIGKILL" });

    // Memoized for the process lifetime: no second spawn, same object.
    const spawn = fakeSpawn();
    const again = probeDeckToolchain(p.config, { spawnSync: sync.fn, spawn: spawn.fn, now: () => 1_000 + 60 * MINUTE });
    expect(again).toBe(state);
    expect(sync.calls).toHaveLength(1);
    expect(spawn.calls).toHaveLength(0);
    // Frozen: a consumer cannot mutate the shared memo.
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.profiles)).toBe(true);
  });

  it("treats a valid converter:false report (exit 4) as definitive, facts included", () => {
    const p = pluginsDir();
    const sync = fakeSpawnSync({ status: 4, stdout: probeJson(PROBE_NO_CHROMIUM) });
    const state = probeDeckToolchain(p.config, { spawnSync: sync.fn, now: () => 0 });
    expect(state.converter).toBe(false);
    expect(state.definitive).toBe(true);
    expect(state.converterMissing).toEqual(["Chromium headless shell is not installed in this image"]);
    expect(state.profiles).toEqual([]);
    expect(state.limits).toBeUndefined();
    expect(state.selftest).toBe("not-recorded");
    // A second call does not spawn — not even much later.
    const spawn = fakeSpawn();
    probeDeckToolchain(p.config, { spawnSync: sync.fn, spawn: spawn.fn, now: () => 999 * MINUTE });
    expect(sync.calls).toHaveLength(1);
    expect(spawn.calls).toHaveLength(0);
    // No warn: a definitive "not installed" is an answer, not a probe failure.
    expect(logs.entries.filter((e) => e.level === "warn")).toEqual([]);
  });

  it("reports a missing converter script definitively without spawning", () => {
    const p = pluginsDir({ script: null });
    const sync = fakeSpawnSync({ status: 0, stdout: probeJson(PROBE_OK) });
    const state = probeDeckToolchain(p.config, { spawnSync: sync.fn, now: () => 0 });
    expect(sync.calls).toHaveLength(0);
    expect(state.converter).toBe(false);
    expect(state.definitive).toBe(true);
    expect(state.converterMissing).toEqual([
      `converter scripts not found under DEFAULT_PLUGINS_DIR (${p.script})`,
    ]);
  });

  it("carries the legacy half from the one legacy probe memo", () => {
    __setDeckRenderingForTests(true);
    expect(probeDeckRendering()).toBe(true);
    const p = pluginsDir();
    const state = probeDeckToolchain(p.config, {
      spawnSync: fakeSpawnSync({ status: 4, stdout: probeJson(PROBE_NO_CHROMIUM) }).fn,
    });
    expect(state).toMatchObject({ pythonPptx: true, libreOffice: true, converter: false });
    expect(deckModeOf(state)).toBe("legacy");
  });

  it("keeps drift / disabled self-test states and drops unknown ones", () => {
    const cases: [unknown, DeckToolchainState["selftest"]][] = [
      [{ status: "drift", maxDelta: 1.5 }, "drift"],
      [{ status: "disabled" }, "disabled"],
      [{ status: "weird" }, "not-recorded"],
      [undefined, "not-recorded"],
    ];
    for (const [selftest, expected] of cases) {
      __setDeckToolchainForTests(null);
      const p = pluginsDir();
      const state = probeDeckToolchain(p.config, {
        spawnSync: fakeSpawnSync({ stdout: probeJson({ ...PROBE_OK, selftest }) }).fn,
      });
      expect(state.selftest, JSON.stringify(selftest)).toBe(expected);
      expect(state.definitive).toBe(true);
    }
  });

  it("cleans the administrator facts it relays to the model", () => {
    const p = pluginsDir();
    const noisy = {
      ...PROBE_NO_CHROMIUM,
      chromium: { version: "154; rm -rf /" },
      missing: [
        "Python modules missing:\u0000 fontTools,\n openpyxl (python3)",
        42,
        "   ",
        "x".repeat(500),
        ...Array.from({ length: 20 }, (_, i) => `fact ${i}`),
      ],
    };
    const state = probeDeckToolchain(p.config, {
      spawnSync: fakeSpawnSync({ status: 4, stdout: probeJson(noisy) }).fn,
    });
    expect(state.converterMissing[0]).toBe("Python modules missing: fontTools, openpyxl (python3)");
    expect(state.converterMissing[1]).toBe(`${"x".repeat(300)}…`);
    expect(state.converterMissing).toHaveLength(12);
    // A version string that is not a version is dropped, never relayed.
    expect(state.chromiumVersion).toBeUndefined();
  });
});

describe("probeDeckToolchain — non-definitive results and the background re-probe", () => {
  const failures: [string, Record<string, unknown>, RegExp][] = [
    ["garbage output", { status: 1, stdout: "Segmentation fault\n" }, /not valid JSON \(exit 1\)/],
    ["empty output", { status: 0, stdout: "" }, /printed no JSON/],
    [
      "a timeout",
      { status: null, signal: "SIGKILL", error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }) },
      /timed out after 10 s/,
    ],
    [
      "a spawn error",
      { status: null, error: Object.assign(new Error("spawnSync node EACCES"), { code: "EACCES" }) },
      /could not run the probe \(EACCES\)/,
    ],
    [
      "oversized output",
      { status: null, error: Object.assign(new Error("stdout maxBuffer exceeded"), { code: "ENOBUFS" }) },
      /more than 1048576 bytes/,
    ],
    ["a crash signal", { status: null, signal: "SIGSEGV", stdout: "" }, /killed by SIGSEGV/],
    ["a wrong format", { stdout: probeJson({ ...PROBE_OK, format: "noah-deck-run" }) }, /unexpected probe format/],
    ["a wrong version", { stdout: probeJson({ ...PROBE_OK, version: 2 }) }, /unexpected probe format/],
    ["a non-boolean converter", { stdout: probeJson({ ...PROBE_OK, converter: "yes" }) }, /boolean `converter`/],
    ["a converter without limits", { stdout: probeJson({ ...PROBE_OK, limits: { maxSlides: 60 } }) }, /without valid limits/],
    ["a converter without profiles", { stdout: probeJson({ ...PROBE_OK, profiles: ["comic-sans"] }) }, /usable font profile/],
    ["a JSON array", { stdout: "[1,2]" }, /not a JSON object/],
  ];

  it.each(failures)("%s → converter false, non-definitive, logged at warn", (_label, result, reason) => {
    const p = pluginsDir();
    const state = probeDeckToolchain(p.config, { spawnSync: fakeSpawnSync(result).fn, now: () => 0 });
    expect(state.converter).toBe(false);
    expect(state.definitive).toBe(false);
    expect(state.profiles).toEqual([]);
    expect(state.converterMissing).toHaveLength(1);
    expect(state.converterMissing[0]).toMatch(/^converter probe failed: /);
    expect(state.converterMissing[0]).toMatch(reason);
    const warns = logs.entries.filter((e) => e.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].payload.script).toBe(p.script);
  });

  it("a throwing spawnSync is a failed probe, not a crash", () => {
    const p = pluginsDir();
    const throwing = (() => {
      throw new Error("boom");
    }) as unknown as SpawnSyncFn;
    const state = probeDeckToolchain(p.config, { spawnSync: throwing, now: () => 0 });
    expect(state.definitive).toBe(false);
    expect(state.converterMissing[0]).toBe("converter probe failed: could not run the probe (boom)");
  });

  it("re-probes asynchronously at most every 5 minutes and lets a good result replace the memo", async () => {
    const p = pluginsDir();
    let clock = 10 * MINUTE;
    const now = () => clock;
    const sync = fakeSpawnSync({ status: 1, stdout: "not json" });
    const spawn = fakeSpawn();
    const deps = { spawnSync: sync.fn, spawn: spawn.fn, now };

    const first = probeDeckToolchain(p.config, deps);
    expect(first.definitive).toBe(false);

    // Within 5 minutes: the SAME non-definitive state, and no spawn of any kind.
    clock += 4 * MINUTE;
    expect(probeDeckToolchain(p.config, deps)).toBe(first);
    expect(sync.calls).toHaveLength(1);
    expect(spawn.calls).toHaveLength(0);

    // After 5 minutes: one background spawn; the call itself never blocks and
    // still answers with the stale state.
    clock += 1 * MINUTE;
    expect(probeDeckToolchain(p.config, deps)).toBe(first);
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0].command).toBe(process.execPath);
    expect(spawn.calls[0].args).toEqual([p.script, "probe", "--json"]);
    // While it is in flight, even a much later call starts no second one.
    clock += 30 * MINUTE;
    probeDeckToolchain(p.config, deps);
    expect(spawn.calls).toHaveLength(1);

    const child = spawn.children[0];
    child.stdout.emit("data", Buffer.from(probeJson(PROBE_OK)));
    child.emit("close", 0, null);
    await flush();

    const settled = probeDeckToolchain(p.config, deps);
    expect(settled.converter).toBe(true);
    expect(settled.definitive).toBe(true);
    expect(settled.limits).toEqual(PROBE_OK.limits);
    // Definitive now: memoized forever, no further spawns.
    clock += 60 * MINUTE;
    expect(probeDeckToolchain(p.config, deps)).toBe(settled);
    expect(spawn.calls).toHaveLength(1);
    expect(sync.calls).toHaveLength(1);
    expect(logs.entries.some((e) => e.level === "info" && e.msg === "deck toolchain re-probe settled")).toBe(true);
  });

  it("keeps retrying after a failed re-probe, with the new reason and a warn each time", async () => {
    const p = pluginsDir();
    let clock = 0;
    const spawn = fakeSpawn();
    const deps = { spawnSync: fakeSpawnSync({ status: 1, stdout: "junk" }).fn, spawn: spawn.fn, now: () => clock };
    probeDeckToolchain(p.config, deps);

    clock = 5 * MINUTE;
    probeDeckToolchain(p.config, deps);
    spawn.children[0].emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
    await flush();
    const afterError = probeDeckToolchain(p.config, deps);
    expect(afterError.definitive).toBe(false);
    expect(afterError.converterMissing).toEqual(["converter probe failed: could not run the probe (ENOENT)"]);
    expect(logs.entries.filter((e) => e.level === "warn")).toHaveLength(2);

    // The throttle counts from the RETRY, not from the boot probe.
    clock = 9 * MINUTE;
    probeDeckToolchain(p.config, deps);
    expect(spawn.calls).toHaveLength(1);
    clock = 10 * MINUTE;
    probeDeckToolchain(p.config, deps);
    expect(spawn.calls).toHaveLength(2);
    spawn.children[1].stdout.emit("data", "{\"format\":\"noah-deck-probe\"");
    spawn.children[1].emit("close", 1, null);
    await flush();
    expect(probeDeckToolchain(p.config, deps).converterMissing[0]).toMatch(/not valid JSON \(exit 1\)/);
    expect(logs.entries.filter((e) => e.level === "warn")).toHaveLength(3);
  });

  it("kills a background probe that hangs past 10 s or floods its output", async () => {
    const p = pluginsDir();
    let clock = 0;
    const spawn = fakeSpawn();
    const deps = { spawnSync: fakeSpawnSync({ stdout: "" }).fn, spawn: spawn.fn, now: () => clock };
    probeDeckToolchain(p.config, deps);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    clock = 5 * MINUTE;
    probeDeckToolchain(p.config, deps);
    vi.advanceTimersByTime(10_000);
    expect(spawn.children[0].killed).toEqual(["SIGKILL"]);
    vi.useRealTimers();
    await flush();
    expect(probeDeckToolchain(p.config, deps).converterMissing[0]).toBe(
      "converter probe failed: timed out after 10 s",
    );

    clock = 10 * MINUTE;
    probeDeckToolchain(p.config, deps);
    const flood = spawn.children[1];
    flood.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1, 0x20));
    expect(flood.killed).toEqual(["SIGKILL"]);
    await flush();
    expect(probeDeckToolchain(p.config, deps).converterMissing[0]).toMatch(/more than 1048576 bytes/);
  });

  it("a throwing async spawn, or a script removed before the re-probe, still settles the memo", async () => {
    const p = pluginsDir();
    let clock = 0;
    const throwingSpawn = (() => {
      throw new Error("spawn exploded");
    }) as unknown as SpawnFn;
    const deps = { spawnSync: fakeSpawnSync({ stdout: "" }).fn, spawn: throwingSpawn, now: () => clock };
    probeDeckToolchain(p.config, deps);
    clock = 5 * MINUTE;
    probeDeckToolchain(p.config, deps);
    await flush();
    expect(probeDeckToolchain(p.config, deps).converterMissing).toEqual([
      "converter probe failed: could not run the probe (spawn exploded)",
    ]);

    // The script vanished (DEFAULT_PLUGINS_DIR re-pointed / image changed):
    // that is a definitive answer, and the background probe never spawns.
    fs.rmSync(p.script);
    const spawn = fakeSpawn();
    clock = 10 * MINUTE;
    probeDeckToolchain(p.config, { ...deps, spawn: spawn.fn });
    await flush();
    const gone = probeDeckToolchain(p.config, { ...deps, spawn: spawn.fn });
    expect(spawn.calls).toHaveLength(0);
    expect(gone.definitive).toBe(true);
    expect(gone.converterMissing[0]).toMatch(/^converter scripts not found under DEFAULT_PLUGINS_DIR/);
  });

  it("a test reset discards a background probe still in flight", async () => {
    const p = pluginsDir();
    let clock = 0;
    const spawn = fakeSpawn();
    const deps = { spawnSync: fakeSpawnSync({ stdout: "" }).fn, spawn: spawn.fn, now: () => clock };
    probeDeckToolchain(p.config, deps);
    clock = 5 * MINUTE;
    probeDeckToolchain(p.config, deps);
    const pinned = { ...probeDeckToolchain(p.config, deps), converterMissing: ["pinned"], definitive: true };
    __setDeckToolchainForTests(pinned);
    spawn.children[0].stdout.emit("data", probeJson(PROBE_OK));
    spawn.children[0].emit("close", 0, null);
    await flush();
    expect(probeDeckToolchain(p.config, deps)).toBe(pinned);
  });
});

describe("probeDeckToolchain — environment and real child processes", () => {
  it("passes ONLY the allowlisted environment to the probe (sync and async)", async () => {
    vi.stubEnv("SESSION_SECRET", "top-secret-session");
    vi.stubEnv("GIT_TOKEN", "ghp_should_never_leak");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-should-never-leak");
    vi.stubEnv("NODE_OPTIONS", "--require /evil.js");
    vi.stubEnv("NOAH_PPTX_CHROMIUM", "/nonexistent");
    vi.stubEnv("NOAH_PPTX_MAX_SECONDS", "300");
    vi.stubEnv("LANG", "C.UTF-8");
    const p = pluginsDir();
    let clock = 0;
    const sync = fakeSpawnSync({ stdout: "" });
    const spawn = fakeSpawn();
    const deps = { spawnSync: sync.fn, spawn: spawn.fn, now: () => clock };
    probeDeckToolchain(p.config, deps);
    clock = 5 * MINUTE;
    probeDeckToolchain(p.config, deps);

    for (const env of [sync.calls[0].options.env, spawn.calls[0].options.env]) {
      expect(env).toBeDefined();
      const keys = Object.keys(env!);
      expect(env).toMatchObject({
        NOAH_PPTX_CHROMIUM: "/nonexistent",
        NOAH_PPTX_MAX_SECONDS: "300",
        LANG: "C.UTF-8",
        PYTHONDONTWRITEBYTECODE: "1",
        PATH: process.env.PATH,
      });
      expect(keys).not.toContain("SESSION_SECRET");
      expect(keys).not.toContain("GIT_TOKEN");
      expect(keys).not.toContain("ANTHROPIC_API_KEY");
      expect(keys).not.toContain("NODE_OPTIONS");
      const allowed = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "NODE_ENV", "PYTHONDONTWRITEBYTECODE"]);
      expect(keys.filter((key) => !allowed.has(key) && !key.startsWith("NOAH_PPTX_"))).toEqual([]);
    }
    // Settle the background probe so no timer outlives the test.
    spawn.children[0].emit("close", 1, null);
    await flush();
  });

  it("parses a REAL child's output and sees only the allowlisted env inside it", () => {
    vi.stubEnv("SESSION_SECRET", "top-secret-session");
    vi.stubEnv("NOAH_PPTX_LOCK_NAMESPACE", "lane-d-test");
    // A stand-in deck.mjs: prints a converter:false probe whose one "missing"
    // fact is the environment it was given (names only).
    const p = pluginsDir({
      script: [
        `const probe = ${probeJson(PROBE_NO_CHROMIUM)};`,
        "probe.missing = [",
        "  'env=' + Object.keys(process.env).sort().join(','),",
        "  'argv=' + process.argv.slice(2).join(' '),",
        "];",
        "process.stdout.write(JSON.stringify(probe));",
        "process.exitCode = 4;",
      ].join("\n"),
    });
    const state = probeDeckToolchain(p.config, { spawnSync: realSpawnSync });
    expect(state.definitive).toBe(true);
    expect(state.converter).toBe(false);
    const envFact = state.converterMissing.find((fact) => fact.startsWith("env="))!;
    expect(envFact).toContain("NOAH_PPTX_LOCK_NAMESPACE");
    expect(envFact).toContain("PYTHONDONTWRITEBYTECODE");
    expect(envFact).not.toContain("SESSION_SECRET");
    expect(state.converterMissing).toContain("argv=probe --json");
  });

  it("re-probes through a REAL async child once a broken probe is fixed", async () => {
    const p = pluginsDir({ script: "process.stdout.write('not json yet');\n" });
    let clock = 0;
    const deps = { spawnSync: realSpawnSync, spawn: realSpawn, now: () => clock };
    expect(probeDeckToolchain(p.config, deps).definitive).toBe(false);
    fs.writeFileSync(p.script, `process.stdout.write(${JSON.stringify(probeJson(PROBE_OK))});\n`);
    clock = 5 * MINUTE;
    probeDeckToolchain(p.config, deps);
    await vi.waitFor(() => expect(probeDeckToolchain(p.config, deps).converter).toBe(true), {
      timeout: 10_000,
      interval: 50,
    });
    expect(probeDeckToolchain(p.config, deps).definitive).toBe(true);
  });
});

describe("probeDeckToolchain — test hooks and hermetic default", () => {
  it("never spawns under NODE_ENV=test without injected deps", () => {
    expect(process.env.NODE_ENV).toBe("test");
    const marker = path.join(tempDir(), "probe-ran");
    // deck.mjs is ESM: the stub writes a marker file if it ever runs.
    const p = pluginsDir({
      script: `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
    });
    // Positive control: the stub really does write the marker when run.
    expect(realSpawnSync(process.execPath, [p.script]).status).toBe(0);
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);

    const state = probeDeckToolchain(p.config);
    expect(fs.existsSync(marker)).toBe(false);
    expect(state).toMatchObject({
      converter: false,
      profiles: [],
      selftest: "not-recorded",
      converterMissing: ["the converter was not probed in this test environment"],
      // Skill names are a file read, not a spawn: admin-disabled gating stays real.
      pptxSkillNames: ["pptx", "avatar-defaults:pptx"],
      definitive: false,
    });
    // Legacy half: a peek at the legacy memo (pinned false here), never a spawn.
    expect(state.pythonPptx).toBe(false);
    __setDeckRenderingForTests(true);
    expect(probeDeckToolchain(p.config)).toMatchObject({ pythonPptx: true, libreOffice: true });
    __setDeckRenderingForTests(null);
    expect(probeDeckToolchain(p.config)).toMatchObject({ pythonPptx: false, libreOffice: false });

    // Not memoized: a later call WITH deps really probes.
    const sync = fakeSpawnSync({ stdout: probeJson(PROBE_OK) });
    __setDeckRenderingForTests(false);
    expect(probeDeckToolchain(p.config, { spawnSync: sync.fn }).converter).toBe(true);
    expect(sync.calls).toHaveLength(1);
  });

  it("__setDeckToolchainForTests pins a state and null clears it", () => {
    const pinned: DeckToolchainState = {
      pythonPptx: true,
      libreOffice: true,
      converter: true,
      converterVersion: "9.9.9",
      profiles: ["embedded"],
      limits: PROBE_OK.limits,
      selftest: "drift",
      converterMissing: [],
      pptxSkillNames: ["pptx"],
      definitive: true,
    };
    __setDeckToolchainForTests(pinned);
    expect(probeDeckToolchain({ defaultPluginsDir: "/nowhere" })).toBe(pinned);
    const sync = fakeSpawnSync({ stdout: "" });
    expect(probeDeckToolchain({ defaultPluginsDir: "/nowhere" }, { spawnSync: sync.fn })).toBe(pinned);
    expect(sync.calls).toHaveLength(0);
    __setDeckToolchainForTests(null);
    expect(probeDeckToolchain({ defaultPluginsDir: "/nowhere" }).converterMissing).toEqual([
      "the converter was not probed in this test environment",
    ]);
  });

  it("keeps probeDeckRendering's override semantics", () => {
    __setDeckRenderingForTests(true);
    expect(probeDeckRendering()).toBe(true);
    __setDeckRenderingForTests(false);
    expect(probeDeckRendering()).toBe(false);
  });
});

describe("pptx skill names, modes and authoring status", () => {
  it("reads the plugin name from plugin.json", () => {
    const named = pluginsDir({ pluginName: "custom-defaults" });
    expect(
      probeDeckToolchain(named.config, { spawnSync: fakeSpawnSync({ stdout: probeJson(PROBE_OK) }).fn }).pptxSkillNames,
    ).toEqual(["pptx", "custom-defaults:pptx"]);

    for (const broken of [null, "has:colon", "", "../escape"]) {
      __setDeckToolchainForTests(null);
      const p = pluginsDir({ pluginName: broken });
      expect(
        probeDeckToolchain(p.config, { spawnSync: fakeSpawnSync({ stdout: probeJson(PROBE_OK) }).fn }).pptxSkillNames,
        String(broken),
      ).toEqual(["pptx"]);
    }
    __setDeckToolchainForTests(null);
    const garbled = pluginsDir();
    fs.writeFileSync(path.join(garbled.dir, ".claude-plugin", "plugin.json"), "{not json");
    expect(
      probeDeckToolchain(garbled.config, { spawnSync: fakeSpawnSync({ stdout: probeJson(PROBE_OK) }).fn }).pptxSkillNames,
    ).toEqual(["pptx"]);
  });

  it("the bundled default-skills plugin is avatar-defaults", () => {
    // The real DEFAULT_PLUGINS_DIR of this repo (read via the hermetic path).
    const repoDefaults = path.join(process.cwd(), "default-skills");
    expect(probeDeckToolchain({ defaultPluginsDir: repoDefaults }).pptxSkillNames).toEqual([
      "pptx",
      "avatar-defaults:pptx",
    ]);
    expect(deckConverterScript(repoDefaults)).toBe(
      path.join(repoDefaults, "skills", "pptx", "converter", "tools", "deck.mjs"),
    );
  });

  it("deckModeOf truth table", () => {
    const base: DeckToolchainState = {
      pythonPptx: false,
      libreOffice: false,
      converter: false,
      profiles: [],
      selftest: "not-recorded",
      converterMissing: [],
      pptxSkillNames: ["pptx"],
      definitive: true,
    };
    const rows: [Partial<DeckToolchainState>, string][] = [
      [{ converter: true }, "converter"],
      [{ converter: true, pythonPptx: true, libreOffice: true }, "converter"],
      [{ pythonPptx: true, libreOffice: true }, "legacy"],
      [{ pythonPptx: true }, "unavailable"],
      [{ libreOffice: true }, "unavailable"],
      [{}, "unavailable"],
    ];
    for (const [over, mode] of rows) {
      expect(deckModeOf({ ...base, ...over }), JSON.stringify(over)).toBe(mode);
    }
  });

  it("deckAuthoringStatusFor mirrors the hook's exact skill rule, then Bash/Write access", () => {
    const names = ["pptx", "avatar-defaults:pptx"];
    const status = (elevatedToolAccess: boolean, disabledSkills: string[]) =>
      deckAuthoringStatusFor({ elevatedToolAccess, disabledSkills, pptxSkillNames: names });
    expect(status(true, [])).toBe("allowed");
    expect(status(true, ["pptx"])).toBe("skill-disabled");
    expect(status(true, ["avatar-defaults:pptx"])).toBe("skill-disabled");
    // A DIFFERENT plugin's pptx skill does not disable the bundled one.
    expect(status(true, ["other:pptx"])).toBe("allowed");
    expect(status(true, ["docx", "drawio"])).toBe("allowed");
    expect(status(false, [])).toBe("read-only");
    // skill-disabled takes precedence over read-only.
    expect(status(false, ["pptx"])).toBe("skill-disabled");
  });

  it("deckGuidanceFlags needs the toolchain, file output and an allowed author", () => {
    const flags = (over: Partial<Parameters<typeof deckGuidanceFlags>[0]>) =>
      deckGuidanceFlags({
        deckRenderingAvailable: true,
        deckConverterInstalled: true,
        fileOutputActive: true,
        deckAuthoring: "allowed",
        ...over,
      });
    expect(flags({})).toEqual({ deckRenderingEnabled: true, deckConverterEnabled: true });
    expect(flags({ deckConverterInstalled: false })).toEqual({ deckRenderingEnabled: true, deckConverterEnabled: false });
    expect(flags({ deckRenderingAvailable: false })).toEqual({ deckRenderingEnabled: false, deckConverterEnabled: true });
    for (const off of [
      { fileOutputActive: false },
      { deckAuthoring: "read-only" as const },
      { deckAuthoring: "skill-disabled" as const },
    ]) {
      expect(flags(off), JSON.stringify(off)).toEqual({ deckRenderingEnabled: false, deckConverterEnabled: false });
    }
  });

  it("deckToolchainLogFields names the mode and every boot-log field", () => {
    const p = pluginsDir();
    const state = probeDeckToolchain(p.config, { spawnSync: fakeSpawnSync({ stdout: probeJson(PROBE_OK) }).fn });
    expect(deckToolchainLogFields(state)).toEqual({
      mode: "converter",
      converter: true,
      chromiumVersion: "154.0.8037.57",
      profiles: ["embedded", "malgun"],
      limits: PROBE_OK.limits,
      selftest: "pass",
      converterMissing: [],
      pythonPptx: false,
      libreOffice: false,
      definitive: true,
    });
  });
});

describe("share_file preview gate (LibreOffice + pdftoppm, not python-pptx)", () => {
  /** A fake `pdftoppm` first on PATH: writes one PNG page and logs each call. */
  function fakePdftoppm(): { calls: string } {
    const bin = path.join(tempDir(), "bin");
    fs.mkdirSync(bin, { recursive: true });
    const calls = path.join(tempDir(), "pdftoppm-calls.log");
    const script = path.join(bin, "pdftoppm");
    fs.writeFileSync(
      script,
      `#!/bin/sh\necho "$@" >> '${calls}'\nfor a in "$@"; do last="$a"; done\nprintf '\\211PNG\\r\\n\\032\\n' > "$last-1.png"\n`,
    );
    fs.chmodSync(script, 0o755);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    return { calls };
  }

  function samplePdf(): string {
    const pdf = path.join(tempDir(), "report.pdf");
    fs.writeFileSync(pdf, "%PDF-1.4\n");
    return pdf;
  }

  it("probeDocumentPreviews needs soffice + pdftoppm only", () => {
    __setDeckRenderingForTests({ soffice: true, pdftoppm: true, pythonPptx: false });
    expect(probeDeckRendering()).toBe(false);
    expect(probeDocumentPreviews()).toBe(true);
    __setDeckRenderingForTests({ soffice: true, pdftoppm: false, pythonPptx: true });
    expect(probeDocumentPreviews()).toBe(false);
    __setDeckRenderingForTests({ pdftoppm: true, pythonPptx: true });
    expect(probeDocumentPreviews()).toBe(false);
  });

  it("renders share_file previews on a host without python-pptx", async () => {
    const { calls } = fakePdftoppm();
    __setDeckRenderingForTests({ soffice: true, pdftoppm: true, pythonPptx: false });
    const pages = await renderDocumentPreviews(samplePdf(), "pdf");
    expect(pages).toHaveLength(1);
    expect(pages[0].subarray(0, 4).toString("latin1")).toBe("\x89PNG");
    expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("skips previews without spawning when pdftoppm is missing", async () => {
    const { calls } = fakePdftoppm();
    __setDeckRenderingForTests({ soffice: true, pdftoppm: false, pythonPptx: true });
    expect(await renderDocumentPreviews(samplePdf(), "pdf")).toEqual([]);
    expect(fs.existsSync(calls)).toBe(false);
  });
});
