// Integration contract between the pptx skill's HTML -> editable-PPTX converter
// (default-skills/skills/pptx/converter, CLI scripts/deck.sh) and the server that consumes its outputs:
//  - the preview sidecar the converter writes (<stem>.preview/manifest.json) is accepted by the server loader
//    (publishWorkspaceFile -> loadConverterPreviews), and the sha256 binding rejects edited decks/renders;
//  - the REAL `deck.mjs probe --json` output is parsed by the server's probe parser (probeDeckToolchain);
//  - the describe_system deck line carries the metacognition markers the skill's preflight keys on, and
//    SKILL.md quotes every one of them (plan I12);
//  - the generated `--help` block in docs/architecture/pptx-converter.md equals `deck.mjs --help`;
//  - opt-in e2e (NOAH_PPTX_E2E=1 and the probe reports the converter): a copy of an example deck is built and
//    shared through the server loader.
//
// The fixture tests/fixtures/deck-preview/mini/ is REAL converter output (one malgun slide, so the .pptx carries
// no embedded fonts and stays small). To regenerate it after a converter change that alters its output:
//   cp -r tests/fixtures/deck-preview/mini /tmp/mini && cd /tmp
//   NOAH_PPTX_DEV=1 NOAH_PPTX_PYTHON=~/.venvs/noah-pptx/bin/python \
//     bash <repo>/default-skills/skills/pptx/scripts/deck.sh build mini --profile malgun --out mini.pptx --strict
//   then copy back mini.pptx, mini.preview/manifest.json and mini.preview/slide-01.png — NOT the generated
//   .gitignore files (they contain "*" and would ignore the fixture itself) and not .build/.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServices } from "../src/server/app.js";
import { publishWorkspaceFile } from "../src/server/chatFiles.js";
import { MAX_CHAT_IMAGE_BYTES } from "../src/server/chatImages.js";
import { loadConverterPreviews, MAX_DECK_PREVIEW_TOTAL_BYTES } from "../src/server/deckPreview.js";
import {
  __setDeckRenderingForTests,
  __setDeckToolchainForTests,
  deckModeOf,
  MAX_PREVIEW_PAGES,
  probeDeckToolchain,
  type DeckToolchainState,
} from "../src/server/deckRender.js";
import { buildSystemTools, type SystemToolsContext } from "../src/server/agent/systemTools.js";
import type { AppConfig } from "../src/server/types.js";
import { callTool } from "./helpers.js";

const REPO = path.resolve(import.meta.dirname, "..");
const PLUGINS = path.join(REPO, "default-skills");
const SKILL = path.join(PLUGINS, "skills", "pptx");
const DECK_SH = path.join(SKILL, "scripts", "deck.sh");
const DECK_MJS = path.join(SKILL, "converter", "tools", "deck.mjs");
const FIXTURE = path.join(REPO, "tests", "fixtures", "deck-preview", "mini");

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const INSTALL_WORDS = /\b(apt|apt-get|pip|pip3|npm|npx|install)\b/i;

const tmpRoots: string[] = [];
function tmp(label: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `noah-deckcontract-${label}-`));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

/** A temp workspace holding a copy of the committed fixture deck folder at `<ws>/mini`. */
function fixtureWorkspace(label: string): string {
  const ws = tmp(label);
  fs.cpSync(FIXTURE, path.join(ws, "mini"), { recursive: true });
  return ws;
}

function publish(ws: string, rel: string) {
  const config = { dataDir: path.join(ws, ".data") } as AppConfig;
  const result = publishWorkspaceFile(config, "conv-contract", rel, [ws]);
  if (!("attachment" in result)) throw new Error(`publishWorkspaceFile failed: ${result.error}`);
  return result;
}

// ------------------------------------------------------------------------------------ preview sidecar
describe("converter preview sidecar -> server loader (committed fixture)", () => {
  it("the fixture is self-consistent real converter output (plan I5)", () => {
    const pptx = fs.readFileSync(path.join(FIXTURE, "mini.pptx"));
    const png = fs.readFileSync(path.join(FIXTURE, "mini.preview", "slide-01.png"));
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, "mini.preview", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      format: "noah-deck-preview",
      version: 1,
      pptx: "mini.pptx",
      pptxSha256: sha256(pptx),
      profile: "malgun",
      slideCount: 1,
      slides: [
        {
          index: 1,
          file: "slide-01.png",
          mediaType: "image/png",
          sha256: sha256(png),
          width: 1920,
          height: 1080,
          title: "미리보기 계약 확인",
        },
      ],
    });
    expect(manifest.generator).toMatch(/^noah-pptx-converter\/\d+\.\d+\.\d+$/);
    expect(manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // A real 1920x1080 PNG (IHDR), not a stand-in.
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1920, 1080]);
    // The generated .gitignore files ("*") were deliberately NOT committed.
    expect(fs.existsSync(path.join(FIXTURE, "mini.preview", ".gitignore"))).toBe(false);
    expect(fs.existsSync(path.join(FIXTURE, ".build"))).toBe(false);
  });

  it("publishWorkspaceFile -> loadConverterPreviews loads the renders with the Korean title and media type", async () => {
    const ws = fixtureWorkspace("loaded");
    const published = publish(ws, "mini/mini.pptx");
    expect(published.sourcePath).toBe(fs.realpathSync(path.join(ws, "mini", "mini.pptx")));
    const load = await loadConverterPreviews({
      sourcePath: published.sourcePath,
      sha256: published.sha256,
      allowedRoots: [ws],
    });
    expect(load.status).toBe("loaded");
    if (load.status !== "loaded") return;
    expect(load.total).toBe(1);
    expect(load.profile).toBe("malgun");
    expect(load.slides).toHaveLength(1);
    expect(load.slides[0]).toMatchObject({ index: 1, mediaType: "image/png", name: "슬라이드 1 – 미리보기 계약 확인" });
    expect(load.slides[0].buffer.equals(fs.readFileSync(path.join(FIXTURE, "mini.preview", "slide-01.png")))).toBe(true);
  });

  it("sharing through a symlink still finds the sidecar next to the real file", async () => {
    const ws = fixtureWorkspace("symlink");
    fs.symlinkSync(path.join(ws, "mini", "mini.pptx"), path.join(ws, "final.pptx"));
    const published = publish(ws, "final.pptx");
    const load = await loadConverterPreviews({
      sourcePath: published.sourcePath,
      sha256: published.sha256,
      allowedRoots: [ws],
    });
    expect(load.status).toBe("loaded");
  });

  it("one flipped .pptx byte -> stale (the renders are bound to the exact bytes)", async () => {
    const ws = fixtureWorkspace("stale");
    const file = path.join(ws, "mini", "mini.pptx");
    const bytes = fs.readFileSync(file);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    fs.writeFileSync(file, bytes);
    const published = publish(ws, "mini/mini.pptx");
    const load = await loadConverterPreviews({
      sourcePath: published.sourcePath,
      sha256: published.sha256,
      allowedRoots: [ws],
    });
    expect(load).toEqual({
      status: "rejected",
      reason: "stale",
      detail: "the .pptx changed after the converter built it",
    });
  });

  it("an altered render -> invalid (per-file sha256)", async () => {
    const ws = fixtureWorkspace("invalid");
    const file = path.join(ws, "mini", "mini.preview", "slide-01.png");
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 20] ^= 0xff; // still a PNG by magic; only the digest can catch it
    fs.writeFileSync(file, bytes);
    const published = publish(ws, "mini/mini.pptx");
    const load = await loadConverterPreviews({
      sourcePath: published.sourcePath,
      sha256: published.sha256,
      allowedRoots: [ws],
    });
    expect(load).toEqual({
      status: "rejected",
      reason: "invalid",
      detail: "slide 1's render does not match its sha256",
    });
  });

  it("a copied/renamed deck has no sidecar -> none", async () => {
    const ws = fixtureWorkspace("none");
    fs.copyFileSync(path.join(ws, "mini", "mini.pptx"), path.join(ws, "copy.pptx"));
    const published = publish(ws, "copy.pptx");
    const load = await loadConverterPreviews({
      sourcePath: published.sourcePath,
      sha256: published.sha256,
      allowedRoots: [ws],
    });
    expect(load).toEqual({ status: "none" });
  });
});

// ------------------------------------------------------------------------------------ real probe
describe("real `deck.mjs probe --json` parsed by the server probe", () => {
  beforeEach(() => {
    __setDeckToolchainForTests(null);
    // Pin the legacy half so the test never spawns soffice/pdftoppm/python3 for it.
    __setDeckRenderingForTests(false);
  });
  afterEach(() => {
    __setDeckToolchainForTests(null);
    __setDeckRenderingForTests(null);
    vi.unstubAllEnvs();
  });

  it("an unusable Chromium -> definitive converter:false with an administrator fact, never a command", () => {
    // NOAH_PPTX_* pass the probe's env allowlist; an explicit bad browser path wins over every fallback.
    vi.stubEnv("NOAH_PPTX_CHROMIUM", "/nonexistent");
    const state = probeDeckToolchain({ defaultPluginsDir: PLUGINS }, { spawnSync });
    expect(state.definitive).toBe(true);
    expect(state.converter).toBe(false);
    expect(state.profiles).toEqual([]);
    expect(state.limits).toBeUndefined();
    expect(state.converterVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(state.converterMissing.some((fact) => /chromium/i.test(fact))).toBe(true);
    for (const fact of state.converterMissing) {
      expect(fact).not.toMatch(INSTALL_WORDS);
      expect(fact).not.toMatch(/^converter probe failed/); // the JSON was read, not a spawn/parse failure
    }
    expect(state.pptxSkillNames).toEqual(["pptx", "avatar-defaults:pptx"]);
    expect(deckModeOf(state)).toBe("unavailable"); // the legacy half is pinned false above
    // Definitive → memoized: a second call does not spawn again.
    const spy = vi.fn(spawnSync);
    expect(probeDeckToolchain({ defaultPluginsDir: PLUGINS }, { spawnSync: spy as unknown as typeof spawnSync })).toBe(
      state,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("the Dockerfile's DECK_CONVERTER=0 record -> converter:false naming the opt-out, selftest disabled", () => {
    // The EXACT record the Dockerfile writes for a legacy image (so a drift between the image build and the
    // probe's record reader fails here, not in the field).
    const dockerfile = fs.readFileSync(path.join(REPO, "Dockerfile"), "utf8");
    const printed = dockerfile.match(/printf '(\{"format":"noah-deck-selftest-record"[^']*\})\\n'/);
    expect(printed, "the Dockerfile's disabled-record printf").not.toBeNull();
    const record = path.join(tmp("record"), "deck-selftest.json");
    fs.writeFileSync(record, `${printed![1]}\n`);
    vi.stubEnv("NOAH_PPTX_SELFTEST_RECORD", record);
    const state = probeDeckToolchain({ defaultPluginsDir: PLUGINS }, { spawnSync });
    expect(state.definitive).toBe(true);
    expect(state.converter).toBe(false);
    expect(state.selftest).toBe("disabled");
    expect(state.converterMissing).toContain("the image was built without the converter (DECK_CONVERTER=0)");
  });
});

// ------------------------------------------------------------------------------------ markers (I12)
describe("describe_system deck markers vs SKILL.md preflight (plan I12)", () => {
  const LIMITS = {
    maxSlides: 60,
    maxSeconds: 540,
    maxSlideHtmlBytes: 2097152,
    maxDomElements: 2500,
    maxAssetBytes: 20971520,
    maxDeckInputBytes: 104857600,
    maxConcurrent: 2,
    slotWaitSeconds: 150,
  };
  const CONVERTER: DeckToolchainState = {
    pythonPptx: true,
    libreOffice: true,
    converter: true,
    converterVersion: "1.0.0",
    chromiumVersion: "154.0.8037.57",
    profiles: ["embedded", "malgun"],
    limits: LIMITS,
    selftest: "pass",
    converterMissing: [],
    pptxSkillNames: ["pptx", "avatar-defaults:pptx"],
    definitive: true,
  };
  const LEGACY: DeckToolchainState = {
    ...CONVERTER,
    converter: false,
    converterVersion: "1.0.0",
    chromiumVersion: undefined,
    profiles: [],
    limits: undefined,
    selftest: "disabled",
    converterMissing: ["the image was built without the converter (DECK_CONVERTER=0)"],
  };
  const UNAVAILABLE: DeckToolchainState = {
    ...LEGACY,
    pythonPptx: false,
    libreOffice: false,
    converterMissing: ["Chromium headless shell is not installed in this image"],
  };
  const PREFIX = "- Document deck generation (PPTX): ";
  const TAILS = {
    "read-only": "read-only",
    "skill-disabled": "administrator disabled the `pptx` skill",
    "no-file-output": "preview/download need an interactive chat turn",
  } as const;
  const ALLOWED_TAIL = " — use the `pptx` skill";
  const skillMd = fs.readFileSync(path.join(SKILL, "SKILL.md"), "utf8");

  let services: ReturnType<typeof createServices>;
  let owner: ReturnType<ReturnType<typeof createServices>["store"]["createUser"]>;
  beforeEach(() => {
    services = createServices({ dataDir: tmp("describe"), agentRuntime: "local", sessionSecret: "t" });
    owner = services.store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  });
  function deckLine(ctx: Partial<SystemToolsContext>, viewerIsOwner = true): Promise<string> {
    const { store, config } = services;
    const tools = buildSystemTools(store, {
      avatarUserId: owner.id,
      owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
      config,
      viewerIsOwner,
      ...ctx,
    });
    return callTool(tools, "describe_system", {}).then((r) => {
      const body = r.content[0].text ?? "";
      const lines = body.split("\n").filter((line) => line.startsWith(PREFIX));
      expect(lines, body).toHaveLength(1);
      return lines[0];
    });
  }

  it("the three toolchain states render exactly the I12 markers (owner, file output, allowed)", async () => {
    expect([deckModeOf(CONVERTER), deckModeOf(LEGACY), deckModeOf(UNAVAILABLE)]).toEqual([
      "converter",
      "legacy",
      "unavailable",
    ]);
    const allowed = { fileOutputEnabled: true, deckAuthoring: "allowed" as const };

    const converter = await deckLine({ ...allowed, deckToolchain: CONVERTER });
    expect(converter).toContain("toolchain available");
    expect(converter).toContain("converter: INSTALLED");
    expect(converter).not.toContain("converter: NOT INSTALLED");
    expect(converter).not.toContain("UNAVAILABLE");
    expect(converter).toContain(ALLOWED_TAIL);

    const legacy = await deckLine({ ...allowed, deckToolchain: LEGACY });
    expect(legacy).toContain("toolchain available");
    expect(legacy).toContain("converter: NOT INSTALLED");
    expect(legacy).toContain("(the image was built without the converter (DECK_CONVERTER=0))");
    expect(legacy).toContain(ALLOWED_TAIL);

    // Older callers (no probe state): the legacy wording WITHOUT any converter marker.
    const older = await deckLine({ ...allowed, deckRenderingAvailable: true });
    expect(older).toContain("toolchain available");
    expect(older).not.toMatch(/converter: /);

    const unavailable = await deckLine({ ...allowed, deckToolchain: UNAVAILABLE });
    expect(unavailable).toContain("UNAVAILABLE");
    expect(unavailable).toContain("converter: NOT INSTALLED");
    expect(unavailable).not.toContain("toolchain available");
    expect(unavailable).not.toContain(ALLOWED_TAIL);
  });

  it("each tail overrides the allowed guidance, by precedence skill-disabled > read-only > no file output", async () => {
    for (const state of [CONVERTER, LEGACY]) {
      const readOnly = await deckLine({ deckToolchain: state, fileOutputEnabled: true, deckAuthoring: "read-only" });
      expect(readOnly).toContain(TAILS["read-only"]);
      const disabled = await deckLine({
        deckToolchain: state,
        fileOutputEnabled: false,
        deckAuthoring: "skill-disabled",
      });
      expect(disabled).toContain(TAILS["skill-disabled"]);
      expect(disabled).not.toContain(TAILS["no-file-output"]);
      const noFileOutput = await deckLine({ deckToolchain: state, fileOutputEnabled: false, deckAuthoring: "allowed" });
      expect(noFileOutput).toContain(TAILS["no-file-output"]);
      for (const line of [readOnly, disabled, noFileOutput]) {
        expect(line).not.toContain(ALLOWED_TAIL);
        expect(line).toContain(state.converter ? "converter: INSTALLED" : "converter: NOT INSTALLED");
      }
    }
  });

  it("a non-owner viewer gets the same deck line with its own tail", async () => {
    const line = await deckLine({ deckToolchain: CONVERTER, fileOutputEnabled: true, deckAuthoring: "read-only" }, false);
    expect(line).toContain("converter: INSTALLED");
    expect(line).toContain(TAILS["read-only"]);
  });

  it("SKILL.md quotes every marker and tail the deck line can carry, and keys its preflight on them", () => {
    for (const marker of ["converter: INSTALLED", "converter: NOT INSTALLED", "UNAVAILABLE", "toolchain available"]) {
      expect(skillMd, marker).toContain(`\`${marker}\``);
    }
    for (const tail of Object.values(TAILS)) expect(skillMd, tail).toContain(tail);
    expect(skillMd).toContain("Document deck generation (PPTX)");
    expect(skillMd).toContain("mcp__system__describe_system");
    // The positive marker is never a substring of the negative one, so a naive `includes` cannot misfire.
    expect("converter: NOT INSTALLED".includes("converter: INSTALLED")).toBe(false);
  });
});

// ------------------------------------------------------------------------------------ preview size budget
/** `NAME = 32 * 1024 * 1024`-style integer constants of the converter's previews.py. */
function previewsPyConstant(name: string): number {
  const src = fs.readFileSync(path.join(SKILL, "converter", "tools", "previews.py"), "utf8");
  const m = src.match(new RegExp(`^${name} = ([\\d *_]+)$`, "m"));
  if (!m) throw new Error(`previews.py has no integer constant ${name}`);
  return m[1].split("*").map((f) => Number(f.trim().replace(/_/g, ""))).reduce((a, b) => a * b, 1);
}

describe("preview size budget: what the converter writes fits what the server accepts", () => {
  it("previews.py uses the server's own caps (the loader rejects the WHOLE sidecar past any of them)", () => {
    expect(previewsPyConstant("ATTACHED_MAX")).toBe(MAX_PREVIEW_PAGES);
    expect(previewsPyConstant("ATTACHED_BUDGET")).toBe(MAX_DECK_PREVIEW_TOTAL_BYTES);
    expect(previewsPyConstant("IMAGE_MAX_BYTES")).toBe(MAX_CHAT_IMAGE_BYTES);
    // a PNG preview can never pass the per-image cap on its own
    expect(previewsPyConstant("PNG_MAX_BYTES")).toBeLessThan(MAX_CHAT_IMAGE_BYTES);
  });
});

// ------------------------------------------------------------------------------------ docs
describe("docs/architecture/pptx-converter.md --help block", () => {
  it("equals `deck.mjs --help` exactly", () => {
    const help = spawnSync(process.execPath, [DECK_MJS, "--help"], { encoding: "utf8", timeout: 30_000 });
    expect(help.status).toBe(0);
    expect(help.stdout.length).toBeGreaterThan(0);
    const page = fs.readFileSync(path.join(REPO, "docs", "architecture", "pptx-converter.md"), "utf8");
    const block = page.match(/<!-- deck-help:begin -->\n```text\n([\s\S]*?)```\n<!-- deck-help:end -->/);
    expect(block, "the deck-help markers must wrap one ```text fence").not.toBeNull();
    expect(block![1]).toBe(help.stdout);
    // `bash deck.sh --help` is the same text (the wrapper only execs deck.mjs).
    const viaSh = spawnSync("bash", [DECK_SH, "--help"], { encoding: "utf8", timeout: 30_000 });
    expect(viaSh.status).toBe(0);
    expect(viaSh.stdout).toBe(help.stdout);
  });
});

// ------------------------------------------------------------------------------------ opt-in e2e
const probeNow = (() => {
  if (process.env.NOAH_PPTX_E2E !== "1") return { converter: false };
  try {
    return JSON.parse(
      spawnSync("bash", [DECK_SH, "probe", "--json"], { encoding: "utf8", timeout: 60_000, cwd: os.tmpdir() }).stdout,
    );
  } catch {
    return { converter: false };
  }
})();
const E2E = process.env.NOAH_PPTX_E2E === "1" && probeNow.converter === true;

describe.skipIf(!E2E)("converter e2e through the server (NOAH_PPTX_E2E=1)", () => {
  afterEach(() => {
    __setDeckToolchainForTests(null);
    __setDeckRenderingForTests(null);
    vi.unstubAllEnvs();
  });

  it("the real probe with this toolchain -> converter state with limits and profiles, and the INSTALLED marker", async () => {
    __setDeckToolchainForTests(null);
    __setDeckRenderingForTests(false);
    const state = probeDeckToolchain({ defaultPluginsDir: PLUGINS }, { spawnSync });
    expect(state).toMatchObject({
      converter: true,
      definitive: true,
      converterMissing: [],
      limits: { maxSlides: 60, maxSeconds: 540, maxConcurrent: 2, slotWaitSeconds: 150 },
    });
    expect(state.profiles).toEqual(expect.arrayContaining(["embedded"]));
    expect(state.chromiumVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(deckModeOf(state)).toBe("converter");

    const dataDir = tmp("e2e-describe");
    const { store, config } = createServices({ dataDir, agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const body =
      (
        await callTool(
          buildSystemTools(store, {
            avatarUserId: owner.id,
            owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
            config,
            viewerIsOwner: true,
            deckToolchain: state,
            fileOutputEnabled: true,
            deckAuthoring: "allowed",
          }),
          "describe_system",
          {},
        )
      ).content[0].text ?? "";
    const line = body.split("\n").find((l) => l.startsWith("- Document deck generation (PPTX): ")) ?? "";
    expect(line).toContain("converter: INSTALLED");
    expect(line).toContain(`Chromium ${state.chromiumVersion}`);
    expect(line).not.toContain("self-test:");
  });

  it("a drift record (the shape `selftest --record` writes) reaches describe_system as the drift clause", async () => {
    const record = path.join(tmp("drift"), "deck-selftest.json");
    fs.writeFileSync(
      record,
      `${JSON.stringify({
        format: "noah-deck-selftest-record",
        version: 1,
        status: "drift",
        converterVersion: "1.0.0",
        chromiumVersion: "154.0.8037.57",
        at: "2026-09-26T03:00:00Z",
        maxDelta: 0.5,
        differences: 3,
        lintSetChanged: false,
      })}\n`,
    );
    vi.stubEnv("NOAH_PPTX_SELFTEST_RECORD", record);
    __setDeckToolchainForTests(null);
    __setDeckRenderingForTests(false);
    const state = probeDeckToolchain({ defaultPluginsDir: PLUGINS }, { spawnSync });
    vi.unstubAllEnvs();
    expect(state).toMatchObject({ converter: true, definitive: true, selftest: "drift" });

    const { store, config } = createServices({ dataDir: tmp("e2e-drift"), agentRuntime: "local", sessionSecret: "t" });
    const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
    const body =
      (
        await callTool(
          buildSystemTools(store, {
            avatarUserId: owner.id,
            owner: { id: owner.id, username: owner.username, displayName: owner.displayName },
            config,
            viewerIsOwner: true,
            deckToolchain: state,
            fileOutputEnabled: true,
            deckAuthoring: "allowed",
          }),
          "describe_system",
          {},
        )
      ).content[0].text ?? "";
    const line = body.split("\n").find((l) => l.startsWith("- Document deck generation (PPTX): ")) ?? "";
    expect(line).toContain("converter: INSTALLED");
    expect(line).toContain(
      "self-test: reference-render drift was recorded at image build — output still passes every integrity gate; mention it only if the user reports layout problems",
    );
  });

  it("photo-heavy previews that would total ~48 MiB as PNG are fitted into the 32 MiB budget and load (first 30 only)", async () => {
    const py = process.env.NOAH_PPTX_PYTHON || "python3";
    const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    const ws = tmp("e2e-budget");
    const irDir = path.join(ws, "deck", ".build", "embedded");
    // one render whose right 40 % is fine photo-like detail (~1.6 MiB as a 1920x1080 PNG, under the 2 MiB PNG
    // rule), used for 32 slides: 30 attached PNGs would be ~48 MiB against the server's 32 MiB
    const make = [
      "import json, os, shutil, sys", "from PIL import Image, ImageFilter", "d, n = sys.argv[1], int(sys.argv[2])",
      "os.makedirs(os.path.join(d, 'html'))", "W, H = 2560, 1440", "im = Image.new('RGB', (W, H), (240, 242, 245))",
      "pw = int(W * 0.4)", "im.paste(Image.frombytes('RGB', (pw, H), os.urandom(pw * H * 3)).filter(ImageFilter.GaussianBlur(1.2)), (W - pw, 0))",
      "im.save(os.path.join(d, 'r2.png'), compress_level=1)", "im.resize((1280, 720)).save(os.path.join(d, 'r1.png'))",
      "slides = []",
      "for i in range(1, n + 1):",
      "    s = f'{i:02d}-s'",
      "    shutil.copy(os.path.join(d, 'r2.png'), os.path.join(d, 'html', s + '@2x.png'))",
      "    shutil.copy(os.path.join(d, 'r1.png'), os.path.join(d, 'html', s + '.png'))",
      "    slides.append({'index': i, 'name': s, 'referencePng': 'html/' + s + '.png', 'referencePng2x': 'html/' + s + '@2x.png', 'elements': []})",
      "json.dump({'slides': slides}, open(os.path.join(d, 'ir.json'), 'w'))",
    ].join("\n");
    const gen = spawnSync(py, ["-c", make, irDir, "32"], { env, encoding: "utf8", timeout: 120_000 });
    expect(gen.status, gen.stderr).toBe(0);
    const sha = "a".repeat(64);
    const run = spawnSync(py, [path.join(SKILL, "converter", "tools", "previews.py"), "--ir", path.join(irDir, "ir.json"),
      "--overview-dir", irDir, "--out-dir", path.join(ws, "deck", "x.preview"), "--pptx-name", "x.pptx", "--pptx-sha256", sha,
      "--profile", "embedded"], { env, encoding: "utf8", timeout: 120_000 });
    expect(run.status, run.stderr).toBe(0);
    const previews = JSON.parse(run.stdout.trim().split("\n").pop()!).previews as { index: number; mediaType: string; bytes: number }[];
    expect(previews).toHaveLength(32);
    const head = previews.slice(0, MAX_PREVIEW_PAGES);
    const pngBytes = previews[31].bytes; // slide 32 is never attached, so it keeps the plain rule: PNG
    expect(previews[30].mediaType).toBe("image/png");
    expect(previews[31].mediaType).toBe("image/png");
    expect(pngBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(pngBytes * MAX_PREVIEW_PAGES).toBeGreaterThan(MAX_DECK_PREVIEW_TOTAL_BYTES); // the fit was needed
    expect(head.some((p) => p.mediaType === "image/jpeg")).toBe(true);
    expect(head.some((p) => p.mediaType === "image/png")).toBe(true); // only as many as needed were re-encoded
    expect(head.reduce((n, p) => n + p.bytes, 0)).toBeLessThanOrEqual(MAX_DECK_PREVIEW_TOTAL_BYTES);
    const files = fs.readdirSync(path.join(ws, "deck", "x.preview")).filter((f) => f.startsWith("slide-")).sort();
    expect(files).toHaveLength(32); // a re-encoded preview leaves no stale .png behind

    const load = await loadConverterPreviews({ sourcePath: path.join(ws, "deck", "x.pptx"), sha256: sha, allowedRoots: [ws] });
    expect(load.status, JSON.stringify(load)).toBe("loaded");
    if (load.status !== "loaded") return;
    expect(load.slides).toHaveLength(MAX_PREVIEW_PAGES);
    expect(load.total).toBe(32);
  }, 300_000);

  it("builds a copy of examples/business-review and the server loader attaches its exact renders", async () => {
    const ws = tmp("e2e-share");
    fs.cpSync(path.join(SKILL, "examples", "business-review"), path.join(ws, "business-review"), { recursive: true });
    const run = spawnSync("bash", [DECK_SH, "build", "business-review", "--json"], {
      cwd: ws,
      env: process.env,
      encoding: "utf8",
      timeout: 600_000,
    });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report).toMatchObject({ format: "noah-deck-run", command: "build", ok: true, slideCount: 4 });

    const published = publish(ws, "business-review/business-review.pptx");
    expect(published.sha256).toBe(report.pptx.sha256);
    const load = await loadConverterPreviews({
      sourcePath: published.sourcePath,
      sha256: published.sha256,
      allowedRoots: [ws],
    });
    expect(load.status).toBe("loaded");
    if (load.status !== "loaded") return;
    expect(load.total).toBe(4);
    expect(load.profile).toBe("embedded");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(ws, "business-review", "business-review.preview", "manifest.json"), "utf8"),
    );
    expect(load.slides.map((s) => s.index)).toEqual([1, 2, 3, 4]);
    load.slides.forEach((slide, i) => {
      const entry = manifest.slides[i];
      expect(slide.mediaType).toBe(entry.mediaType);
      expect(slide.name).toBe(entry.title ? `슬라이드 ${i + 1} – ${entry.title}` : `슬라이드 ${i + 1}`);
      expect(sha256(slide.buffer)).toBe(entry.sha256);
    });
    // The skill tree stays clean: no bytecode or build folders under default-skills.
    const stray: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.name === "__pycache__" || e.name === ".build") stray.push(p);
        else if (e.isDirectory()) walk(p);
      }
    };
    walk(PLUGINS);
    expect(stray).toEqual([]);
  }, 600_000);
});
