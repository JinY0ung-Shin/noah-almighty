import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { retireCraftApps } from "../src/server/retireCraftApps.js";
import { withTempDir } from "./helpers.js";

describe("retireCraftApps (boot cleanup of the removed Craft apps)", () => {
  const dir = withTempDir("retire-craft");
  const STAMP = "2026-10-29T00-00-00.000Z-abcdef";
  const open = { retirementGate: () => ({ allowed: true, stamp: STAMP }) };
  const quarantined = (...parts: string[]) => path.join(dir(), "retired", STAMP, ...parts);

  it("quarantines the purge retry queue and leaves the rest of runtime/ alone", () => {
    const runtime = path.join(dir(), "runtime");
    fs.mkdirSync(path.join(runtime, "craft-purge"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "craft-purge", "s-0123"), "");
    fs.mkdirSync(path.join(runtime, "mcp-secrets"), { recursive: true });
    retireCraftApps({ config: { dataDir: dir() }, store: open });
    expect(fs.existsSync(path.join(runtime, "craft-purge"))).toBe(false);
    expect(fs.existsSync(quarantined("runtime", "craft-purge", "s-0123"))).toBe(true);
    expect(fs.existsSync(path.join(runtime, "mcp-secrets"))).toBe(true);
  });

  it("is a harmless no-op when there is nothing to remove", () => {
    expect(() => retireCraftApps({ config: { dataDir: dir() }, store: open })).not.toThrow();
    expect(() => retireCraftApps({ config: { dataDir: path.join(dir(), "missing") }, store: open })).not.toThrow();
    expect(fs.existsSync(path.join(dir(), "retired"))).toBe(false);
  });

  it("moves a symlink in its place AS a link, without following it", () => {
    const target = path.join(dir(), "elsewhere");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep"), "x");
    fs.mkdirSync(path.join(dir(), "runtime"));
    fs.symlinkSync(target, path.join(dir(), "runtime", "craft-purge"));
    retireCraftApps({ config: { dataDir: dir() }, store: open });
    expect(fs.existsSync(path.join(dir(), "runtime", "craft-purge"))).toBe(false);
    expect(fs.readlinkSync(quarantined("runtime", "craft-purge"))).toBe(target);
    expect(fs.readFileSync(path.join(target, "keep"), "utf8")).toBe("x");
  });

  it("leaves the queue in place on a boot whose pre-retirement backup failed", () => {
    fs.mkdirSync(path.join(dir(), "runtime", "craft-purge"), { recursive: true });
    retireCraftApps({ config: { dataDir: dir() }, store: { retirementGate: () => ({ allowed: false, stamp: STAMP }) } });
    expect(fs.existsSync(path.join(dir(), "runtime", "craft-purge"))).toBe(true);
    expect(fs.existsSync(path.join(dir(), "retired"))).toBe(false);
  });
});
