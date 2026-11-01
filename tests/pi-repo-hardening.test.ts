/**
 * PR #72 review fixes (2026-11-01): reads out of a user-pushed clone never
 * follow a committed link (CLAUDE.md, skills/, .mcp.json, marketplace sources),
 * and the sandbox copy's read-back survives names git would reject or die on.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/server/types.js";
import type { Store } from "../src/server/store.js";
import { listSkillsInRoots, loadKnowledgeRepoMemory, readPluginMcpServers, resolvePluginRoots } from "../src/server/plugins.js";
import { knowledgeClonePath } from "../src/server/knowledgeRepo.js";
import { materializePiSkills } from "../src/server/agent/pi/piSkills.js";
import { piWorkspaceFor } from "../src/server/agent/pi/piWorkspace.js";
import { commitPiRepoCopy, ensurePiRepoCopy, piRepoCopyStatus } from "../src/server/agent/pi/piRepoCopy.js";
import { gitInit, makeSkill, withTempDir } from "./helpers.js";

const dir = withTempDir("pi-repo-hardening");

function config(base: string): AppConfig {
  return { dataDir: path.join(base, "data"), agentRuntime: "pi", pi: { workspacesDir: path.join(base, "ws") } } as unknown as AppConfig;
}

/** Another user's private files Noah can read: they must never surface. */
function victim(base: string) {
  const root = path.join(base, "data", "knowledge", "victim");
  makeSkill(root, "secret-skill", "---\nname: secret-skill\ndescription: VICTIM PRIVATE\n---", "VICTIM BODY");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), "VICTIM CLAUDE.md");
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ jira: { type: "http", url: "https://x", headers: { Authorization: "Bearer VICTIM" } } }));
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "victim" }));
  const secret = path.join(base, "run-secrets", "pi_gateway_api_key");
  fs.mkdirSync(path.dirname(secret), { recursive: true });
  fs.writeFileSync(secret, "PI-SERVICE-KEY");
  return { root, secret };
}

describe("a committed link in the knowledge repo is never followed (review #2/#3)", () => {
  it("CLAUDE.md -> a server secret / another user's CLAUDE.md stays out of the frozen prompt", async () => {
    const base = dir();
    const cfg = config(base);
    const v = victim(base);
    const store = { getKnowledgeRepo: () => ({ repo: "me/knowledge" }) } as unknown as Store;
    const clone = knowledgeClonePath("attacker", cfg);
    fs.mkdirSync(clone, { recursive: true });
    for (const target of [v.secret, path.join(v.root, "CLAUDE.md")]) {
      fs.rmSync(path.join(clone, "CLAUDE.md"), { force: true });
      fs.symlinkSync(target, path.join(clone, "CLAUDE.md"));
      expect((await loadKnowledgeRepoMemory(store, "attacker", cfg)).personal).toBeNull();
    }
    // A link on the way (a linked folder) is refused too; a plain file still loads.
    fs.rmSync(path.join(clone, "CLAUDE.md"));
    fs.writeFileSync(path.join(clone, "CLAUDE.md"), "my memory");
    expect((await loadKnowledgeRepoMemory(store, "attacker", cfg)).personal).toBe("my memory");
  });

  it("a `skills` link copies, indexes and serves none of another user's skills", async () => {
    const base = dir();
    const cfg = config(base);
    const v = victim(base);
    const clone = knowledgeClonePath("attacker", cfg);
    fs.mkdirSync(clone, { recursive: true });
    fs.symlinkSync(path.join(v.root, "skills"), path.join(clone, "skills"));
    const workspace = piWorkspaceFor(cfg, "attacker", "conv-a");
    fs.mkdirSync(workspace.hostRoot!, { recursive: true });
    const plan = materializePiSkills({ config: cfg, workspace, pluginRoots: [{ type: "local", path: clone }], ownerRun: true, disabledSkills: [] });
    expect(plan.entries).toEqual([]);
    expect(plan.mcpSources.size).toBe(0);
    const leaked: string[] = [];
    const scan = (abs: string): void => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const child = path.join(abs, entry.name);
        if (entry.isDirectory()) scan(child);
        else if (entry.isFile() && fs.readFileSync(child, "utf8").includes("VICTIM")) leaked.push(child);
      }
    };
    scan(workspace.hostRoot!);
    expect(leaked).toEqual([]);
    expect(await listSkillsInRoots([{ path: clone, source: "knowledge" }])).toEqual([]);
  }, 20_000);

  it("a linked .mcp.json relays nothing (another user's credential headers)", async () => {
    const base = dir();
    const v = victim(base);
    const root = path.join(base, "data", "plugins", "attacker", "p");
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(path.join(v.root, ".mcp.json"), path.join(root, ".mcp.json"));
    expect(await readPluginMcpServers(root)).toEqual({});
  });

  it("a marketplace source that leaves the repo (`../`, or through a link) is never a plugin root", async () => {
    const base = dir();
    const v = victim(base);
    const repo = path.join(base, "data", "plugins", "attacker", "market");
    fs.mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
    fs.symlinkSync(v.root, path.join(repo, "linked"));
    const rel = path.relative(repo, v.root);
    fs.writeFileSync(
      path.join(repo, ".claude-plugin", "marketplace.json"),
      JSON.stringify({ plugins: [{ name: "up", source: `./${rel}` }, { name: "via-link", source: "./linked" }] }),
    );
    const warnings: string[] = [];
    expect(await resolvePluginRoots(repo, "market", (w) => warnings.push(w))).toEqual([]);
  });
});

describe("sandbox copy read-back never takes the server down (review #4)", () => {
  function setup() {
    const base = dir();
    const cfg = config(base);
    const clonePath = path.join(base, "clone");
    gitInit(clonePath);
    fs.symlinkSync("handbook", path.join(clonePath, "docs"));
    fs.mkdirSync(path.join(clonePath, "handbook"));
    fs.writeFileSync(path.join(clonePath, "handbook", "intro.md"), "intro");
    execFileSync("git", ["-C", clonePath, "add", "-A"]);
    execFileSync("git", ["-C", clonePath, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "docs"]);
    const workspace = piWorkspaceFor(cfg, "owner", "conv-o");
    fs.mkdirSync(workspace.hostRoot!, { recursive: true });
    const ref = { config: cfg, workspace, ownerId: "owner-1", name: "app", clonePath };
    return { ref, copy: path.join(workspace.hostRoot!, "repos", "owner-1", "app") };
  }

  it("pathspec-magic names with many siblings, and a folder where the clone has a link, still commit", async () => {
    const { ref, copy } = setup();
    await ensurePiRepoCopy(ref, "keep");
    // ':!x' / ':(x)y' made git die (exit 128) before reading ~70 KB of stdin:
    // the unhandled EPIPE used to crash the whole process.
    fs.writeFileSync(path.join(copy, ":!x"), "magic");
    fs.writeFileSync(path.join(copy, ":(x)y"), "magic");
    // Pathspec magic only applies at the START of a path, so the siblings sit at the top level too.
    for (let i = 0; i < 8000; i += 1) fs.writeFileSync(path.join(copy, `file-${String(i).padStart(5, "0")}-with-a-longish-name.txt`), "");
    // The copy has no links: the agent re-creates `docs` (a link in the clone) as a real folder.
    fs.mkdirSync(path.join(copy, "docs"));
    fs.writeFileSync(path.join(copy, "docs", "new.md"), "beyond a link");
    fs.writeFileSync(path.join(copy, "handbook", "intro.md"), "edited");

    const status = await piRepoCopyStatus(ref);
    expect(status.kind).toBe("ok");
    const outcome = await commitPiRepoCopy(ref, "edits");
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(outcome.skipped).toContain("docs/new.md");
    const files = execFileSync("git", ["-C", ref.clonePath, "ls-files", "-z"], { encoding: "utf8" }).split("\0");
    expect(files).toEqual(expect.arrayContaining([":!x", ":(x)y", "handbook/intro.md"]));
    expect(fs.readlinkSync(path.join(ref.clonePath, "docs"))).toBe("handbook");
  }, 60_000);
});
