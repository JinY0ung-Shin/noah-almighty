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
import { buildGitRepoTools } from "../src/server/agent/gitRepoTools.js";
import { callTool, gitInit, withTempDir } from "./helpers.js";

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

/** A registered repo `app` (origin with `main` and a diverging `release`), opened by the owner in conv-1. */
function repoSetup() {
  const s = setup();
  const remote = path.join(dir(), "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { stdio: "pipe" });
  const seed = path.join(dir(), "seed");
  gitInit(seed);
  g(seed, "branch", "-M", "main");
  fs.writeFileSync(path.join(seed, "shared.md"), "v1");
  fs.writeFileSync(path.join(seed, "main-only.txt"), "main");
  g(seed, "add", "-A");
  g(seed, "commit", "-q", "-m", "main work");
  g(seed, "checkout", "-q", "-b", "release", "HEAD~1");
  fs.writeFileSync(path.join(seed, "release-only.txt"), "release");
  g(seed, "add", "-A");
  g(seed, "commit", "-q", "-m", "release work");
  g(seed, "remote", "add", "origin", remote);
  g(seed, "push", "-q", "origin", "main", "release");
  const toolsFor = (conversationId: string) =>
    buildGitRepoTools(s.store, {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: "owner", displayName: "Owner" },
      viewerIsOwner: true,
      elevated: true,
      config: s.config,
      conversationId,
      piWorkspace: piWorkspaceFor(s.config, s.owner.id, conversationId),
    });
  const tools = toolsFor("conv-1");
  const copy = path.join(piWorkspaceFor(s.config, s.owner.id, "conv-1").hostRoot!, "repos", s.owner.id, "app");
  const clone = path.join(s.config.dataDir, "git-repos", s.owner.id, "app");
  // What the agent runs in its sandbox copy.
  const inCopy = (...a: string[]) =>
    execFileSync("git", ["-C", copy, "-c", "user.name=a", "-c", "user.email=a@x", "-c", "commit.gpgsign=false", ...a], { stdio: "pipe" })
      .toString()
      .trim();
  return { ...s, remote, seed, tools, toolsFor, copy, clone, inCopy };
}

describe("a copy whose git HEAD left its base (review #6)", () => {
  it("checkout/reset in the copy is refused; commits on the base and a detached base are not", async () => {
    const s = repoSetup();
    expect((await callTool(s.tools, "register_repo", { repo: s.remote, name: "app", branch: "main" })).isError).toBeFalsy();
    expect((await callTool(s.tools, "open_repo", { name: "app" })).isError).toBeFalsy();
    const canonicalHead = g(s.clone, "rev-parse", "HEAD");

    // checkout release: the working tree becomes release's, which would delete main's files.
    s.inCopy("checkout", "-q", "release");
    fs.writeFileSync(path.join(s.copy, "README.md"), "edited on release");
    const refused = await callTool(s.tools, "commit", { name: "app", message: "oops" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("is no longer on the commit Noah gave it");
    expect(refused.content[0].text).toContain("Never checkout/switch/reset/rebase in the copy");
    expect(g(s.clone, "rev-parse", "HEAD")).toBe(canonicalHead);
    expect(g(s.clone, "ls-files")).toContain("main-only.txt");
    const sync = await callTool(s.tools, "sync_repo", { name: "app" });
    expect(sync.isError).toBe(true);
    expect(sync.content[0].text).toContain("Not synced: the git HEAD of your sandbox copy");

    // Switching back (edits ride along) makes it committable again.
    s.inCopy("checkout", "-q", "main");
    expect(fs.readFileSync(path.join(s.copy, "README.md"), "utf8")).toBe("edited on release");
    expect((await callTool(s.tools, "commit", { name: "app", message: "edit readme" })).isError).toBeFalsy();

    // A sandbox-local (loose) commit on the base is fine; so is a detached HEAD at the base.
    fs.writeFileSync(path.join(s.copy, "local.txt"), "local");
    s.inCopy("add", "-A");
    s.inCopy("commit", "-q", "-m", "sandbox-local");
    const local = await callTool(s.tools, "commit", { name: "app", message: "from a local commit" });
    expect(local.content[0].text).toMatch(/Committed [0-9a-f]{8}/);
    s.inCopy("checkout", "-q", "--detach");
    fs.writeFileSync(path.join(s.copy, "detached.txt"), "d");
    expect((await callTool(s.tools, "commit", { name: "app", message: "detached at base" })).content[0].text).toMatch(/Committed/);

    // reset --hard HEAD~1 moves the copy BEHIND its base: refused, nothing applied.
    const before = g(s.clone, "rev-parse", "HEAD");
    s.inCopy("reset", "-q", "--hard", "HEAD~1");
    const reset = await callTool(s.tools, "commit", { name: "app", message: "after reset" });
    expect(reset.isError).toBe(true);
    expect(reset.content[0].text).toContain("is no longer on the commit Noah gave it");
    expect(g(s.clone, "rev-parse", "HEAD")).toBe(before);
    expect(g(s.clone, "ls-files")).toContain("detached.txt");

    // open_repo is the way out: a diverged copy is not "kept".
    const reopen = await callTool(s.tools, "open_repo", { name: "app" });
    expect(reopen.content[0].text).toContain("a fresh copy of the current state");
    expect(fs.existsSync(path.join(s.copy, "detached.txt"))).toBe(true);
    expect((await callTool(s.tools, "commit", { name: "app", message: "noop" })).content[0].text).toContain("Nothing to commit");
  });
});
