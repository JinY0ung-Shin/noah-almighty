import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitAuthConfig, serverGitEnv } from "../src/server/marketplace.js";
import { git } from "../src/server/repoGitCore.js";

const execFileAsync = promisify(execFile);

// Real git, no network: the env-borne config must reach git exactly like `-c`,
// and the clone-local hooks the agent can write must never run in server git (#71).
describe("server git environment", () => {
  let repo: string;
  beforeEach(async () => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "noah-server-git-"));
    await execFileAsync("git", ["init", "-q", repo]);
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("delivers the auth header to git through the environment only", async () => {
    const auth = gitAuthConfig("https://github.com/o/r.git", "tok");
    const { stdout } = await execFileAsync("git", ["-C", repo, "config", "--get", "http.extraHeader"], {
      env: serverGitEnv(auth),
    });
    expect(stdout.trim()).toBe(auth[0][1]);
  });

  it("never runs a clone's own hooks", async () => {
    const marker = path.join(repo, "hook-ran");
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x"]);
    expect(fs.existsSync(marker)).toBe(false);
    // Control: the same hook DOES run for a plain git invocation.
    await execFileAsync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "y"]);
    expect(fs.existsSync(marker)).toBe(true);
  });
});
