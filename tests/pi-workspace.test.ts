/**
 * pi runs' files (lane I2): the host↔sandbox path mapping every Noah tool goes
 * through, the conversation-folder staging + cascades + D3 move, skills
 * materialized into the sandbox (and mcp__skills__read for colleagues), the
 * working-repo COPY round trip (design D1) and the deck state from
 * PI_DECK_SANDBOX on both metacognition surfaces.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServices } from "../src/server/app.js";
import type { AgentRequest, PiRuntimeConfig } from "../src/server/types.js";
import type { AgentEvents, FileOutputResult, ShareFileRequest } from "../src/server/agent/events.js";
import {
  LEGACY_MOVED_MARKER,
  moveLegacyConversationWorkspace,
  piToolPathToHost,
  piWorkspaceFor,
  stagePiAttachmentFiles,
} from "../src/server/agent/pi/piWorkspace.js";
import { piRunWorkspace, preparePiRunWorkspace } from "../src/server/agent/pi/piRuntime.js";
import { materializePiSkills, rewriteSkillMarkdown } from "../src/server/agent/pi/piSkills.js";
import { buildSkillsTools } from "../src/server/agent/skillsTools.js";
import { commitPiRepoCopy, ensurePiRepoCopy, piRepoCopySandboxPath } from "../src/server/agent/pi/piRepoCopy.js";
import { buildGitRepoTools, GIT_REPO_PI_COMMIT_TOOL_NAME } from "../src/server/agent/gitRepoTools.js";
import { buildRunCapabilities, stampPromptRequest } from "../src/server/agent/runCapabilities.js";
import { buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { deckCapabilityLine } from "../src/server/agent/systemTools.js";
import { piSandboxDeckToolchain } from "../src/server/deckRender.js";
import { deleteConversationWorkspaceCopies, workspaceDirFor } from "../src/server/workspace.js";
import { PI_MCP_SERVER_NAMES, noahMcpCatalog } from "../src/server/agent/pi/mcpCatalog.js";
import { callTool, gitInit, makeBareRemote, makeSkill, withTempDir } from "./helpers.js";

const dir = withTempDir("pi-workspace");

const PI: PiRuntimeConfig = { gatewayUrl: "http://pi.invalid", apiKey: "k", modelMap: {}, deckSandbox: false };

let services: ReturnType<typeof createServices> | undefined;
afterEach(() => {
  services?.store.close();
  services = undefined;
});

function setup(pi: Partial<PiRuntimeConfig> = {}, dataName = "data") {
  services = createServices({
    dataDir: path.join(dir(), dataName),
    agentRuntime: "pi",
    sessionSecret: "t",
    defaultPluginsDir: path.join(dir(), "defaults"),
    pi: { ...PI, workspacesDir: path.join(dir(), "ws"), ...pi },
  });
  const { store, config } = services;
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  const mate = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
  store.touchConversation(owner.id, "conv-1", owner.id, "hello");
  return { store, config, owner, mate };
}

async function callServerTool(server: unknown, name: string, args: Record<string, unknown>) {
  const instance = (server as { instance: McpServer }).instance;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await instance.connect(b);
  await client.connect(a);
  try {
    return (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  } finally {
    await client.close();
  }
}

describe("sandbox path mapping", () => {
  it("absolute /workspace and shell-relative paths map; anything else is refused with a redirect", () => {
    const { config, owner } = setup();
    const ws = piWorkspaceFor(config, owner.id, "conv-1");
    fs.mkdirSync(ws.hostConversationDir!, { recursive: true });
    expect(piToolPathToHost(ws, "/workspace/c/conv-1/a.txt")).toEqual({ hostPath: path.join(ws.hostConversationDir!, "a.txt") });
    // pi's shell starts in /workspace, so a relative path means what bash made of it.
    expect(piToolPathToHost(ws, "out/report.txt")).toEqual({ hostPath: path.join(ws.hostRoot!, "out", "report.txt") });
    const outside = piToolPathToHost(ws, "/tmp/x.png");
    expect(outside).toMatchObject({ error: expect.stringContaining("/workspace/c/conv-1/") });
    // A link the sandbox planted cannot point Noah out of the user's root.
    fs.symlinkSync("/etc", path.join(ws.hostRoot!, "escape"));
    expect("error" in piToolPathToHost(ws, "/workspace/escape/passwd")).toBe(true);
  });

  it("the run's workspace is decided from the run class (owner + trusted colleague yes, read-only classes no)", () => {
    const { config, owner, mate } = setup();
    const base = { avatar: { id: owner.id }, conversationId: "conv-1", autoApprove: true };
    expect(piRunWorkspace(config, { ...base, viewerUserId: owner.id, viewerIsOwner: true })?.principal).toBe(owner.id);
    expect(piRunWorkspace(config, { ...base, viewerUserId: mate.id, viewerIsOwner: false, elevated: true })?.principal).toBe(mate.id);
    expect(piRunWorkspace(config, { ...base, viewerUserId: mate.id, viewerIsOwner: false })).toBeNull();
    expect(piRunWorkspace({ ...config, agentRuntime: "claude" }, { ...base, viewerUserId: owner.id, viewerIsOwner: true })).toBeNull();
  });

  it("staged attachments in the conversation folder are listed by sandbox path without a copy", () => {
    const { config, owner } = setup();
    const ws = piWorkspaceFor(config, owner.id, "conv-1");
    const host = path.join(ws.hostConversationDir!, "attachments", "img-1.png");
    fs.mkdirSync(path.dirname(host), { recursive: true });
    fs.writeFileSync(host, "png");
    const [staged] = stagePiAttachmentFiles(ws, [{ path: host, mediaType: "image/png", name: "a.png" }]);
    expect(staged!.path).toBe(`${ws.conversationDir}/attachments/img-1.png`);
    expect(fs.readdirSync(path.dirname(host))).toEqual(["img-1.png"]);
  });
});

describe("conversation folder lifecycle", () => {
  it("D3: the first pi turn moves the SDK-era files in once — no links, no overwrite, idempotent", () => {
    const { config, owner } = setup();
    const legacy = workspaceDirFor(config, owner.id, "conv-1");
    fs.mkdirSync(path.join(legacy, "deck", "assets"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "deck", "assets", "a.png"), "a");
    fs.writeFileSync(path.join(legacy, "notes.md"), "old notes");
    fs.writeFileSync(path.join(legacy, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync("/etc/passwd", path.join(legacy, "link"));
    const run = { avatar: { id: owner.id }, conversationId: "conv-1", viewerUserId: owner.id, viewerIsOwner: true, autoApprove: true };
    const ws = piWorkspaceFor(config, owner.id, "conv-1");
    fs.mkdirSync(ws.hostConversationDir!, { recursive: true });
    fs.writeFileSync(path.join(ws.hostConversationDir!, "notes.md"), "sandbox notes");

    expect(preparePiRunWorkspace(config, run, legacy)?.hostConversationDir).toBe(ws.hostConversationDir);
    const target = ws.hostConversationDir!;
    expect(fs.readFileSync(path.join(target, "deck", "assets", "a.png"), "utf8")).toBe("a");
    expect(fs.statSync(path.join(target, "run.sh")).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(path.join(target, "notes.md"), "utf8")).toBe("sandbox notes"); // never overwritten
    expect(fs.existsSync(path.join(target, "link"))).toBe(false); // links stay behind
    expect(fs.readFileSync(path.join(legacy, "notes.md"), "utf8")).toBe("old notes");
    expect(fs.existsSync(path.join(legacy, "deck"))).toBe(false);
    expect(fs.existsSync(path.join(legacy, LEGACY_MOVED_MARKER))).toBe(true);
    // Idempotent: a later turn does nothing.
    fs.writeFileSync(path.join(legacy, "late.txt"), "x");
    expect(moveLegacyConversationWorkspace(legacy, ws).alreadyDone).toBe(true);
    expect(fs.existsSync(path.join(target, "late.txt"))).toBe(false);
  });

  it("conversation deletion sweeps the server-written copies in the sandbox folder and nothing else", () => {
    const { config, owner, mate } = setup();
    for (const principal of [owner.id, mate.id]) {
      const folder = piWorkspaceFor(config, principal, "conv-1").hostConversationDir!;
      for (const sub of ["attachments", "captures", "confluence", "deck"]) {
        fs.mkdirSync(path.join(folder, sub), { recursive: true });
        fs.writeFileSync(path.join(folder, sub, "f"), "x");
      }
    }
    const other = piWorkspaceFor(config, owner.id, "conv-2").hostConversationDir!;
    fs.mkdirSync(path.join(other, "attachments"), { recursive: true });
    deleteConversationWorkspaceCopies(config, ["conv-1"]);
    for (const principal of [owner.id, mate.id]) {
      const folder = piWorkspaceFor(config, principal, "conv-1").hostConversationDir!;
      expect(fs.readdirSync(folder)).toEqual(["deck"]);
    }
    expect(fs.existsSync(path.join(other, "attachments"))).toBe(true);
  });
});

describe("skills in the sandbox", () => {
  function roots(config: ReturnType<typeof setup>["config"]) {
    const defaults = config.defaultPluginsDir;
    fs.mkdirSync(path.join(defaults, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(defaults, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "avatar-defaults" }));
    makeSkill(defaults, "pptx", "---\nname: pptx\ndescription: Decks\n---", "Run `bash ${CLAUDE_SKILL_DIR}/scripts/deck.sh` with `timeout: 600000`.");
    fs.mkdirSync(path.join(defaults, "skills", "pptx", "scripts", "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(defaults, "skills", "pptx", "scripts", "deck.sh"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(defaults, "skills", "pptx", "scripts", "__pycache__", "x.pyc"), "x");
    makeSkill(defaults, "drawio", "---\nname: drawio\ndescription: Diagrams\n---");
    const knowledge = path.join(config.dataDir, "knowledge", "owner");
    makeSkill(knowledge, "mine", "---\nname: mine\ndescription: Private\n---", "See ${CLAUDE_SKILL_DIR}/ref.md");
    fs.writeFileSync(path.join(knowledge, "skills", "mine", "ref.md"), "ref body");
    return [{ type: "local" as const, path: defaults }, { type: "local" as const, path: knowledge }];
  }

  it("owner runs get every root as files, rewritten for pi; disabled skills are left out; re-sync heals", () => {
    const { config, owner } = setup();
    const ws = piWorkspaceFor(config, owner.id, "conv-1");
    const pluginRoots = roots(config);
    const plan = materializePiSkills({ config, workspace: ws, pluginRoots, ownerRun: true, disabledSkills: ["avatar-defaults:drawio"] });
    expect(plan.entries.map((e) => `${e.root}/${e.dir}:${e.via}`)).toEqual(["default/pptx:file", "knowledge/mine:file"]);
    expect(plan.mcpSources.size).toBe(0);
    const skills = path.join(ws.hostRoot!, ".noah", "skills");
    const md = fs.readFileSync(path.join(skills, "default", "pptx", "SKILL.md"), "utf8");
    expect(md).toContain("bash /workspace/.noah/skills/default/pptx/scripts/deck.sh");
    expect(md).toContain("timeout: 600`");
    expect(md).not.toContain("CLAUDE_SKILL_DIR");
    expect(fs.statSync(path.join(skills, "default", "pptx", "scripts", "deck.sh")).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(skills, "default", "pptx", "scripts", "__pycache__"))).toBe(false);
    expect(fs.existsSync(path.join(skills, "default", "drawio"))).toBe(false);
    expect(plan.entries[0]!.skillMd).toBe("/workspace/.noah/skills/default/pptx/SKILL.md");

    // An edit in the sandbox copy is healed; a stale root goes; nothing outside .noah/skills is touched.
    fs.writeFileSync(path.join(skills, "default", "pptx", "SKILL.md"), "tampered");
    fs.mkdirSync(path.join(skills, "gone"));
    fs.writeFileSync(path.join(ws.hostRoot!, "keep.txt"), "mine");
    materializePiSkills({ config, workspace: ws, pluginRoots, ownerRun: true, disabledSkills: [] });
    expect(fs.readFileSync(path.join(skills, "default", "pptx", "SKILL.md"), "utf8")).toContain("deck.sh");
    expect(fs.existsSync(path.join(skills, "gone"))).toBe(false);
    expect(fs.existsSync(path.join(skills, "default", "drawio", "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(ws.hostRoot!, "keep.txt"), "utf8")).toBe("mine");
  });

  it("a colleague's sandbox only receives the bundled skills; the owner's are read through mcp__skills__read", async () => {
    const { config, mate } = setup();
    const ws = piWorkspaceFor(config, mate.id, "conv-1");
    const plan = materializePiSkills({ config, workspace: ws, pluginRoots: roots(config), ownerRun: false, disabledSkills: [] });
    expect(plan.entries.filter((e) => e.via === "mcp").map((e) => `${e.root}/${e.dir}`)).toEqual(["knowledge/mine"]);
    expect(fs.existsSync(path.join(ws.hostRoot!, ".noah", "skills", "knowledge"))).toBe(false);
    expect(fs.existsSync(path.join(ws.hostRoot!, ".noah", "skills", "default", "pptx", "SKILL.md"))).toBe(true);

    const tools = buildSkillsTools({ sources: plan.mcpSources });
    const read = await callTool(tools, "read", { skill: "knowledge/mine" });
    expect(read.content[0].text).toContain("See skill:knowledge/mine/ref.md");
    expect((await callTool(tools, "read", { skill: "knowledge/mine", path: "ref.md" })).content[0].text).toBe("ref body");
    expect((await callTool(tools, "read", { skill: "knowledge/mine", path: "../../x" })).isError).toBe(true);
    expect((await callTool(tools, "read", { skill: "default/pptx" })).isError).toBe(true);
    expect((await callTool(buildSkillsTools({}), "read", { skill: "knowledge/mine" })).isError).toBe(true);
  });

  it("the skill index rides the pi instructions", () => {
    const prompt = buildSystemPromptAppend({
      message: "m",
      avatar: { id: "o", displayName: "O", alias: "", persona: "" },
      viewerIsOwner: true,
      piRuntime: {
        shellSecretsUnavailable: [],
        skills: [
          { root: "default", dir: "pptx", name: "pptx", description: "Decks", via: "file", skillMd: "/workspace/.noah/skills/default/pptx/SKILL.md" },
          { root: "knowledge", dir: "mine", name: "mine", description: "Private", via: "mcp" },
        ],
      },
    });
    expect(prompt).toContain("**Skills**: before a task one of these covers, READ its SKILL.md first");
    expect(prompt).toContain("- pptx — Decks (`/workspace/.noah/skills/default/pptx/SKILL.md`)");
    expect(prompt).toContain("mcp__skills__read skill `knowledge/mine`");
  });

  it("rewrites only the Claude Code specifics", () => {
    expect(rewriteSkillMarkdown("a ${CLAUDE_SKILL_DIR}/b timeout: 600000 c timeout: 6000", "/s")).toBe("a /s/b timeout: 600 c timeout: 6000");
  });
});

describe("working-repo copy (D1)", () => {
  function repoSetup() {
    const s = setup();
    const remote = makeBareRemote(path.join(dir(), "remote.git"));
    const seed = path.join(dir(), "seed");
    gitInit(seed);
    const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { stdio: "pipe" }).toString().trim();
    fs.writeFileSync(path.join(seed, ".gitignore"), "build/\n");
    fs.writeFileSync(path.join(seed, "gone.txt"), "bye");
    g(seed, "add", "-A");
    g(seed, "commit", "-q", "-m", "seed");
    g(seed, "branch", "-M", "main");
    g(seed, "remote", "add", "origin", remote);
    g(seed, "push", "-q", "origin", "main");
    s.store.touchConversation(s.mate.id, "conv-m", s.owner.id, "mate thread");
    const tools = (viewer: { id: string; owner: boolean }, conversationId: string) =>
      buildGitRepoTools(s.store, {
        avatarUserId: s.owner.id,
        owner: { id: s.owner.id, username: "owner", displayName: "Owner" },
        viewerIsOwner: viewer.owner,
        elevated: true,
        config: s.config,
        conversationId,
        runtime: "pi",
        piWorkspace: piWorkspaceFor(s.config, viewer.id, conversationId),
      });
    return { ...s, remote, g, tools };
  }

  it("open → edit in the sandbox copy → commit → push lands in the remote; Noah's clone is the only git it runs", async () => {
    const s = repoSetup();
    const owner = s.tools({ id: s.owner.id, owner: true }, "conv-1");
    expect(owner.map((t) => t.name)).toContain(GIT_REPO_PI_COMMIT_TOOL_NAME.replace("mcp__git_repo__", ""));
    expect((await callTool(owner, "register_repo", { repo: s.remote, name: "app", branch: "main" })).isError).toBeFalsy();
    const open = await callTool(owner, "open_repo", { name: "app" });
    const sandboxPath = piRepoCopySandboxPath(s.owner.id, "app");
    expect(open.content[0].text).toContain(sandboxPath);
    const copy = path.join(piWorkspaceFor(s.config, s.owner.id, "conv-1").hostRoot!, "repos", s.owner.id, "app");
    expect(fs.existsSync(path.join(copy, ".git", "HEAD"))).toBe(true);
    expect(fs.readFileSync(path.join(copy, "README.md"), "utf8")).toBe("hello");

    // The agent's work: edit, add, delete, an ignored build dir, a link, and a
    // sandbox-local git commit Noah must ignore.
    fs.writeFileSync(path.join(copy, "README.md"), "edited");
    fs.mkdirSync(path.join(copy, "src"));
    fs.writeFileSync(path.join(copy, "src", "new.ts"), "export {};\n");
    fs.unlinkSync(path.join(copy, "gone.txt"));
    fs.mkdirSync(path.join(copy, "build"));
    fs.writeFileSync(path.join(copy, "build", "out.js"), "x");
    fs.symlinkSync("/etc/passwd", path.join(copy, "leak"));
    fs.writeFileSync(path.join(copy, ".git", "hooks", "pre-commit"), "#!/bin/sh\ntouch /tmp/pwned\n", { mode: 0o755 });

    const commit = await callTool(owner, "commit", { name: "app", message: "feat: from the sandbox" });
    expect(commit.isError).toBeFalsy();
    expect(commit.content[0].text).toMatch(/Committed [0-9a-f]{8} to 'app' \(2 file\(s\) written, 1 deleted\)/);
    expect(commit.content[0].text).toContain("leak");
    const push = await callTool(owner, "push", { name: "app" });
    expect(push.content[0].text).toContain("Pushed the changes: app -> main");
    const files = s.g(s.remote, "ls-tree", "-r", "--name-only", "main").split("\n");
    expect(files).toEqual(expect.arrayContaining(["README.md", "src/new.ts", ".gitignore"]));
    expect(files).not.toContain("gone.txt");
    expect(files).not.toContain("build/out.js");
    expect(files).not.toContain("leak");
    expect(s.g(s.remote, "log", "-1", "--format=%s", "main")).toBe("feat: from the sandbox");
    // The copy's .git was refreshed from Noah's clone: same HEAD.
    expect(fs.readFileSync(path.join(copy, ".git", "HEAD"), "utf8")).toContain("refs/heads/main");
    expect((await callTool(owner, "commit", { name: "app", message: "again" })).content[0].text).toContain("Nothing to commit");
  });

  it("a colleague works on their own copy; a commit over a moved base is refused with a re-open redirect", async () => {
    const s = repoSetup();
    const owner = s.tools({ id: s.owner.id, owner: true }, "conv-1");
    const mate = s.tools({ id: s.mate.id, owner: false }, "conv-m");
    await callTool(owner, "register_repo", { repo: s.remote, name: "app", branch: "main" });
    await callTool(owner, "open_repo", { name: "app" });
    await callTool(mate, "open_repo", { name: "app" });
    const ownerCopy = path.join(piWorkspaceFor(s.config, s.owner.id, "conv-1").hostRoot!, "repos", s.owner.id, "app");
    const mateCopy = path.join(piWorkspaceFor(s.config, s.mate.id, "conv-m").hostRoot!, "repos", s.owner.id, "app");
    expect(ownerCopy).not.toBe(mateCopy);
    fs.writeFileSync(path.join(ownerCopy, "README.md"), "owner");
    fs.writeFileSync(path.join(mateCopy, "README.md"), "mate");
    expect((await callTool(owner, "commit", { name: "app", message: "owner first" })).isError).toBeFalsy();
    const refused = await callTool(mate, "commit", { name: "app", message: "mate second" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("mcp__git_repo__open_repo");
    // Re-open: the stale copy moves aside, a fresh one carries the owner's commit.
    const reopen = await callTool(mate, "open_repo", { name: "app" });
    expect(reopen.content[0].text).toContain(".prev");
    expect(fs.readFileSync(path.join(mateCopy, "README.md"), "utf8")).toBe("owner");
    expect(fs.readFileSync(`${mateCopy}.prev/README.md`, "utf8")).toBe("mate");
    // sync is refused while the copy has uncommitted work.
    fs.writeFileSync(path.join(mateCopy, "README.md"), "mate again");
    expect((await callTool(mate, "sync_repo", { name: "app" })).content[0].text).toContain("uncommitted file change");
  });

  it("ensure keeps a current copy and its uncommitted edits", async () => {
    const s = repoSetup();
    const owner = s.tools({ id: s.owner.id, owner: true }, "conv-1");
    await callTool(owner, "register_repo", { repo: s.remote, name: "app", branch: "main" });
    const ref = {
      config: s.config,
      workspace: piWorkspaceFor(s.config, s.owner.id, "conv-1"),
      ownerId: s.owner.id,
      name: "app",
      clonePath: path.join(s.config.dataDir, "git-repos", s.owner.id, "app"),
    };
    expect((await ensurePiRepoCopy(ref, "keep")).outcome).toBe("created");
    const copy = path.join(ref.workspace.hostRoot!, "repos", s.owner.id, "app");
    fs.writeFileSync(path.join(copy, "README.md"), "wip");
    expect((await ensurePiRepoCopy(ref, "keep")).outcome).toBe("kept");
    expect((await ensurePiRepoCopy(ref, "when-missing")).outcome).toBe("kept");
    expect(fs.readFileSync(path.join(copy, "README.md"), "utf8")).toBe("wip");
    await expect(commitPiRepoCopy(ref, "  ")).rejects.toThrow("commit message");
  });
});

describe("run capabilities on pi", () => {
  function request(owner: { id: string }, over: Partial<AgentRequest> = {}): AgentRequest {
    return {
      message: "m",
      avatar: { id: owner.id, displayName: "Owner", alias: "", persona: "" },
      conversationId: "conv-1",
      viewerUserId: owner.id,
      viewerIsOwner: true,
      elevated: true,
      autoApprove: true,
      ...over,
    };
  }

  it("share_file receives the HOST path of a /workspace path; a /tmp path is refused before the sink", async () => {
    const { store, config, owner } = setup();
    const ws = piWorkspaceFor(config, owner.id, "conv-1");
    const seen: ShareFileRequest[] = [];
    const events: AgentEvents = {
      onFile: async () => ({ behavior: "error", message: "unused" }),
      onShareFile: async (req): Promise<FileOutputResult> => {
        seen.push(req);
        return { behavior: "error", message: "stop" };
      },
    };
    const caps = await buildRunCapabilities(request(owner, { cwd: ws.hostConversationDir }), [], config, store, events, undefined, () => 0, {
      runtime: "pi",
      piConversationDir: ws.conversationDir,
      piWorkspace: ws,
    });
    const server = caps.inProcessMcpServers.file_output;
    await callServerTool(server, "share_file", { path: "/workspace/out/report.txt" });
    expect(seen).toEqual([{ path: path.join(ws.hostRoot!, "out", "report.txt") }]);
    const refused = await callServerTool(server, "share_file", { path: "/tmp/report.txt" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("only read files under /workspace");
    expect(seen).toHaveLength(1);
  });

  it("deck state comes from PI_DECK_SANDBOX on BOTH surfaces, and git_repo commit / skills read are gated per run", async () => {
    const off = setup();
    const offCaps = await buildRunCapabilities(request(off.owner), [], off.config, off.store, undefined, undefined, () => 0, {
      runtime: "pi",
    });
    expect(offCaps.deckToolchain.converter).toBe(false);
    expect(deckCapabilityLine({ deckToolchain: offCaps.deckToolchain, deckAuthoring: "allowed", fileOutputEnabled: true })).toContain(
      "PI_DECK_SANDBOX",
    );
    expect(offCaps.mcpAllowedTools).toContain(GIT_REPO_PI_COMMIT_TOOL_NAME);
    expect(offCaps.mcpAllowedTools).not.toContain("mcp__skills__read");
    off.store.close();
    services = undefined;

    const on = setup({ deckSandbox: true }, "data-on");
    const caps = await buildRunCapabilities(
      request(on.owner, { activeRepoName: "app" }),
      [],
      on.config,
      on.store,
      { onFile: async () => ({ behavior: "error", message: "x" }) },
      undefined,
      () => 0,
      {
        runtime: "pi",
        piSkills: { entries: [], mcpSources: new Map([["knowledge/mine", dir()]]), failures: [] },
      },
    );
    expect(caps.deckToolchain).toMatchObject({ converter: true, limits: { maxConcurrent: 1 } });
    expect(deckCapabilityLine({ deckToolchain: caps.deckToolchain, deckAuthoring: "allowed", fileOutputEnabled: true })).toContain(
      "converter: INSTALLED",
    );
    expect(caps.mcpAllowedTools).toContain("mcp__skills__read");
    expect(caps.piRuntimeFacts?.activeRepoDir).toBe(piRepoCopySandboxPath(on.owner.id, "app"));
    const prompt = buildSystemPromptAppend(stampPromptRequest(request(on.owner, { activeRepoName: "app" }), caps, on.config, undefined));
    expect(prompt).toContain(`Your working copy is \`${piRepoCopySandboxPath(on.owner.id, "app")}/\``);
    expect(piSandboxDeckToolchain({ defaultPluginsDir: "", pi: undefined }).converter).toBe(false);
  });

  it("the static catalog lists the skills server and the pi git_repo wording", async () => {
    const { store, config } = setup();
    expect(PI_MCP_SERVER_NAMES).toContain("skills");
    const catalog = await noahMcpCatalog(store, config);
    expect(catalog.skills.map((t) => t.name)).toEqual(["read"]);
    const gitTools = catalog.git_repo.map((t) => t.name);
    expect(gitTools).toContain("commit");
    expect(catalog.git_repo.find((t) => t.name === "open_repo")?.description).toContain("/workspace/repos/");
  });
});
