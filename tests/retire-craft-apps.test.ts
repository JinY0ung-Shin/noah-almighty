import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { retireCraftApps } from "../src/server/retireCraftApps.js";
import { withTempDir } from "./helpers.js";

describe("retireCraftApps (boot cleanup of the removed Craft apps)", () => {
  const dir = withTempDir("retire-craft");

  it("removes the purge retry queue and leaves the rest of runtime/ alone", () => {
    const runtime = path.join(dir(), "runtime");
    fs.mkdirSync(path.join(runtime, "craft-purge"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "craft-purge", "s-0123"), "");
    fs.mkdirSync(path.join(runtime, "mcp-secrets"), { recursive: true });
    retireCraftApps({ dataDir: dir() });
    expect(fs.existsSync(path.join(runtime, "craft-purge"))).toBe(false);
    expect(fs.existsSync(path.join(runtime, "mcp-secrets"))).toBe(true);
  });

  it("is a harmless no-op when there is nothing to remove", () => {
    expect(() => retireCraftApps({ dataDir: dir() })).not.toThrow();
    expect(() => retireCraftApps({ dataDir: path.join(dir(), "missing") })).not.toThrow();
  });

  it("unlinks a symlink in its place without following it", () => {
    const target = path.join(dir(), "elsewhere");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep"), "x");
    fs.mkdirSync(path.join(dir(), "runtime"));
    fs.symlinkSync(target, path.join(dir(), "runtime", "craft-purge"));
    retireCraftApps({ dataDir: dir() });
    expect(fs.existsSync(path.join(dir(), "runtime", "craft-purge"))).toBe(false);
    expect(fs.readFileSync(path.join(target, "keep"), "utf8")).toBe("x");
  });
});
