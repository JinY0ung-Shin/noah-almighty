/**
 * Working-repo sandbox copies (design D1, `agent/pi/piRepoCopy.ts`) — the
 * PR #72 review fixes on top of the round trip `pi-workspace.test.ts` pins:
 * large indexes (#15), a copy whose git HEAD moved (#6), and uncommitted edits
 * that a sync/refresh must never destroy (#13).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServices } from "../src/server/app.js";
import type { PiRuntimeConfig } from "../src/server/types.js";
import { piWorkspaceFor } from "../src/server/agent/pi/piWorkspace.js";
import { CopyTooLargeError, ensurePiRepoCopy } from "../src/server/agent/pi/piRepoCopy.js";
import { decodeExecError } from "../src/server/agent/mcpTools.js";
import { gitInit, withTempDir } from "./helpers.js";

const dir = withTempDir("pi-repo-copy");

const PI: PiRuntimeConfig = { gatewayUrl: "http://pi.invalid", apiKey: "k", deckSandbox: false };

let services: ReturnType<typeof createServices> | undefined;
afterEach(() => {
  services?.store.close();
  services = undefined;
});

function setup() {
  services = createServices({
    dataDir: path.join(dir(), "data"),
    agentRuntime: "pi",
    sessionSecret: "t",
    defaultPluginsDir: path.join(dir(), "defaults"),
    pi: { ...PI, workspacesDir: path.join(dir(), "ws") },
  });
  const { store, config } = services;
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  return { store, config, owner };
}

const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" }).toString().trim();

describe("large indexes (review #15)", () => {
  /** A canonical clone whose index lists `count` entries (no files on disk: they are skipped as deleted). */
  function cloneWithIndex(count: number): string {
    const clone = path.join(dir(), `clone-${count}`);
    gitInit(clone);
    const blob = g(clone, "hash-object", "-w", path.join(clone, "README.md"));
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
      lines.push(`100644 ${blob}\tsrc/generated/module-${String(index).padStart(6, "0")}/component-implementation-with-a-longer-name.ts`);
    }
    execFileSync("git", ["-C", clone, "update-index", "--index-info"], { input: lines.join("\n") + "\n", stdio: ["pipe", "pipe", "pipe"] });
    return clone;
  }

  it("an index past the old 1 MiB buffer still copies; one past COPY_MAX_FILES is refused as too large", async () => {
    const s = setup();
    const ref = (clonePath: string) => ({
      config: s.config,
      workspace: piWorkspaceFor(s.config, s.owner.id, "conv-1"),
      ownerId: s.owner.id,
      name: path.basename(clonePath),
      clonePath,
    });
    const big = cloneWithIndex(18_000); // ~1.4 MB of `ls-files -z` (the old execFile buffer was 1 MiB)
    const created = await ensurePiRepoCopy(ref(big), "keep");
    expect(created.outcome).toBe("created");
    await expect(ensurePiRepoCopy(ref(cloneWithIndex(50_001)), "keep")).rejects.toBeInstanceOf(CopyTooLargeError);
  }, 60_000);

  it("decodeExecError caps a megabyte of stdout to a few KB", () => {
    const error = Object.assign(new Error("Command failed: git ls-files -z"), {
      stdout: "x/".repeat(512 * 1024),
      stderr: "fatal: " + "y".repeat(10_000),
    });
    const { message } = decodeExecError(error);
    expect(message.length).toBeLessThanOrEqual(4200);
    expect(message).toContain("fatal: ");
    expect(message).toContain("truncated");
  });
});
