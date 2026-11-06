// #79: a data volume whose ROOT the app uid cannot write (a root-owned root left
// by a volume created before the non-root `node` user) must stop the boot
// before the DB opens, instead of serving while every new folder — the
// retirement backup, team-brain/, pi-repo-copies/ — fails with EACCES.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/server/config.js";
import logger from "../src/server/logger.js";
import { DataDirNotWritableError, assertDataDirWritable } from "../src/server/store/dataDirWritable.js";
import { Store } from "../src/server/store.js";
import { withTempDir } from "./helpers.js";

const tempDir = withTempDir("data-dir-writable");

// root ignores directory permission bits, so the refusal cannot be staged there.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** A data directory with an existing writable DB-like file, but a read-only root. */
function readOnlyRoot(): string {
  const dir = path.join(tempDir(), "data");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "existing.txt"), "kept");
  fs.chmodSync(dir, 0o555);
  return dir;
}

// Runs before withTempDir's cleanup (vitest runs afterEach hooks in reverse), so
// its recursive removal can delete the read-only root.
afterEach(() => {
  vi.restoreAllMocks();
  const dir = path.join(tempDir(), "data");
  if (fs.existsSync(dir)) {
    fs.chmodSync(dir, 0o755);
  }
});

describe("assertDataDirWritable", () => {
  it("passes on a writable root and leaves no probe behind", () => {
    const dir = tempDir();
    assertDataDirWritable(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it.skipIf(asRoot)("refuses a root the process cannot create folders in, naming owner, mode and the repair", () => {
    const dir = readOnlyRoot();
    let caught: unknown;
    try {
      assertDataDirWritable(dir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DataDirNotWritableError);
    const err = caught as DataDirNotWritableError;
    expect(err.detail).toMatchObject({
      dataDir: dir,
      code: "EACCES",
      processUid: process.getuid?.() ?? null,
      ownerUid: fs.statSync(dir).uid,
      mode: "0555",
    });
    expect(err.message).toContain("not writable");
    expect(err.message).toContain('"Upgrade" → "Data volume ownership"');
    // Nothing in the data directory was touched.
    expect(fs.readdirSync(dir)).toEqual(["existing.txt"]);
  });

  it("rethrows an error that is not a permission refusal", () => {
    expect(() => assertDataDirWritable(path.join(tempDir(), "missing", "deeper"))).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
});

describe("Store boot", () => {
  it.skipIf(asRoot)("stops before opening the DB and logs one fatal line with the detail", () => {
    const dir = readOnlyRoot();
    const fatal = vi.spyOn(logger, "fatal").mockImplementation(() => logger);
    const config = loadConfig({ dataDir: dir, agentRuntime: "local", sessionSecret: "t" });
    expect(() => new Store(config)).toThrow(DataDirNotWritableError);
    expect(fatal).toHaveBeenCalledTimes(1);
    expect(fatal.mock.calls[0][0]).toMatchObject({ dataDir: dir, code: "EACCES" });
    // No DB (and no backups/ folder) was created.
    expect(fs.readdirSync(dir)).toEqual(["existing.txt"]);
  });

  it("boots normally on a writable data directory", () => {
    const config = loadConfig({ dataDir: path.join(tempDir(), "ok"), agentRuntime: "local", sessionSecret: "t" });
    const store = new Store(config);
    store.close();
    expect(fs.readdirSync(config.dataDir).filter((name) => name.startsWith(".write-probe-"))).toEqual([]);
  });
});
