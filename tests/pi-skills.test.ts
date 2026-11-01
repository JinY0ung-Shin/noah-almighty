/**
 * Skills on pi runs (`agent/pi/piSkills.ts`) for the layouts Noah itself
 * writes: a knowledge repo's marketplace resolves to one plugin root PER skill
 * (`<clone>/skills/<slug>`, SKILL.md at the root — `scaffoldSkill`, learned
 * skills), which must reach the sandbox / mcp__skills__read exactly like
 * `listSkillsInRoots` sees it, under the stable id `knowledge/<slug>`.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServices } from "../src/server/app.js";
import type { AgentRequest, PiRuntimeConfig, PluginRoot } from "../src/server/types.js";
import { piWorkspaceFor } from "../src/server/agent/pi/piWorkspace.js";
import { MAX_INDEX_ENTRIES, materializePiSkills } from "../src/server/agent/pi/piSkills.js";
import { buildSkillsTools } from "../src/server/agent/skillsTools.js";
import { knowledgeClonePath, scaffoldSkill, writeRepoTemplate } from "../src/server/knowledgeRepo.js";
import { listSkillsInRoots, resolvePluginRoots } from "../src/server/plugins.js";
import { buildRunCapabilities, stampPromptRequest } from "../src/server/agent/runCapabilities.js";
import { buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { callTool, makeSkill, withTempDir } from "./helpers.js";

const dir = withTempDir("pi-skills");

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
  const mate = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
  store.touchConversation(owner.id, "conv-1", owner.id, "hello");
  return { store, config, owner, mate };
}

type Config = ReturnType<typeof setup>["config"];

function bundled(config: Config): PluginRoot {
  const defaults = config.defaultPluginsDir;
  fs.mkdirSync(path.join(defaults, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(defaults, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "avatar-defaults" }));
  makeSkill(defaults, "pptx", "---\nname: pptx\ndescription: Decks\n---");
  return { type: "local", path: defaults };
}

/** A knowledge clone exactly as Noah writes it: the repo template, two scaffolded skills, the real root resolution. */
async function knowledge(config: Config, userId: string) {
  const clone = knowledgeClonePath(userId, config);
  fs.mkdirSync(clone, { recursive: true });
  await writeRepoTemplate(clone, "owner/brain");
  await scaffoldSkill(clone, "deploy-runbook", "How we deploy");
  await scaffoldSkill(clone, "learned-one", "A learned skill");
  fs.writeFileSync(path.join(clone, "skills", "deploy-runbook", "steps.md"), "steps in ${CLAUDE_SKILL_DIR}");
  const roots: PluginRoot[] = (await resolvePluginRoots(clone, "knowledge")).map((root) => ({ type: "local", path: root }));
  return { clone, roots };
}

const ids = (plan: { entries: { root: string; dir: string; via: string }[] }) => plan.entries.map((e) => `${e.root}/${e.dir}:${e.via}`);

describe("knowledge-repo skills (root = skill) on pi runs (review #8)", () => {
  it("an owner run copies them under knowledge/<slug>; a colleague reads them through mcp__skills__read", async () => {
    const { config, owner, mate } = setup();
    const { clone, roots: knowledgeRoots } = await knowledge(config, owner.id);
    // resolvePluginRoots hands one root per skill — the layout the old sync missed.
    expect(knowledgeRoots.map((root) => path.relative(clone, root.path)).sort()).toEqual([
      path.join("skills", "deploy-runbook"),
      path.join("skills", "learned-one"),
    ]);
    const pluginRoots = [bundled(config), ...knowledgeRoots];

    const ws = piWorkspaceFor(config, owner.id, "conv-1");
    const own = materializePiSkills({ config, workspace: ws, pluginRoots, ownerRun: true, disabledSkills: [] });
    expect(own.failures).toEqual([]);
    expect(ids(own).sort()).toEqual(["default/pptx:file", "knowledge/deploy-runbook:file", "knowledge/learned-one:file"]);
    const copy = path.join(ws.hostRoot!, ".noah", "skills", "knowledge", "deploy-runbook");
    expect(fs.readFileSync(path.join(copy, "SKILL.md"), "utf8")).toContain("description: How we deploy");
    expect(fs.readFileSync(path.join(copy, "steps.md"), "utf8")).toBe("steps in /workspace/.noah/skills/knowledge/deploy-runbook");
    // The per-skill plugin manifest is Noah's plumbing, not part of the skill.
    expect(fs.existsSync(path.join(copy, ".claude-plugin"))).toBe(false);

    // Parity with what the settings UI (listSkillsInRoots) shows.
    const listed = await listSkillsInRoots(pluginRoots.map((root) => ({ path: root.path, source: "x" })));
    expect(own.entries.map((e) => e.name).sort()).toEqual(listed.map((skill) => skill.name).sort());

    // Ids do not depend on the order the roots come in (no `knowledge-2`).
    const reversed = materializePiSkills({ config, workspace: ws, pluginRoots: [...pluginRoots].reverse(), ownerRun: true, disabledSkills: [] });
    expect(ids(reversed).sort()).toEqual(ids(own).sort());

    // A colleague's run: never copied into their sandbox, served read-only.
    const theirs = piWorkspaceFor(config, mate.id, "conv-9");
    const colleague = materializePiSkills({ config, workspace: theirs, pluginRoots, ownerRun: false, disabledSkills: [] });
    expect(ids(colleague).sort()).toEqual(["default/pptx:file", "knowledge/deploy-runbook:mcp", "knowledge/learned-one:mcp"]);
    expect(fs.existsSync(path.join(theirs.hostRoot!, ".noah", "skills-shared", "knowledge"))).toBe(false);
    const tools = buildSkillsTools({ sources: colleague.mcpSources });
    expect((await callTool(tools, "read", { skill: "knowledge/deploy-runbook" })).content[0].text).toContain("# deploy-runbook");
    expect((await callTool(tools, "read", { skill: "knowledge/deploy-runbook", path: "steps.md" })).content[0].text).toBe(
      "steps in skill:knowledge/deploy-runbook",
    );
  });

  it("a linked root, a linked SKILL.md or a link on the way never counts; the admin policy still applies", async () => {
    const { config, owner, mate } = setup();
    const { clone, roots: knowledgeRoots } = await knowledge(config, owner.id);
    // Another user's private skill, which links must never reach.
    const victim = knowledgeClonePath(mate.id, config);
    makeSkill(victim, "secret", "---\nname: secret\ndescription: Private\n---", "VICTIM-PRIVATE");
    fs.symlinkSync(path.join(victim, "skills", "secret"), path.join(clone, "skills", "linked-root"));
    fs.mkdirSync(path.join(clone, "skills", "linked-md"));
    fs.symlinkSync(path.join(victim, "skills", "secret", "SKILL.md"), path.join(clone, "skills", "linked-md", "SKILL.md"));
    fs.symlinkSync(path.join(victim, "skills"), path.join(clone, "alias"));
    const planted: PluginRoot[] = [
      { type: "local", path: path.join(clone, "skills", "linked-root") },
      { type: "local", path: path.join(clone, "skills", "linked-md") },
      { type: "local", path: path.join(clone, "alias", "secret") },
    ];
    for (const ownerRun of [true, false]) {
      const ws = piWorkspaceFor(config, ownerRun ? owner.id : mate.id, "conv-1");
      const plan = materializePiSkills({
        config,
        workspace: ws,
        pluginRoots: [...knowledgeRoots, ...planted],
        ownerRun,
        disabledSkills: ["learned-one"],
      });
      expect(plan.entries.map((e) => e.dir)).toEqual(["deploy-runbook"]);
      expect([...plan.mcpSources.keys()]).toEqual(ownerRun ? [] : ["knowledge/deploy-runbook"]);
      const copied = path.join(ws.hostRoot!, ".noah", "skills", "knowledge");
      if (ownerRun) expect(fs.readdirSync(copied)).toEqual(["deploy-runbook"]);
    }
    // `<plugin>:<skill>` disables a self skill too (its plugin.json name is the slug).
    const ws = piWorkspaceFor(config, owner.id, "conv-1");
    const plan = materializePiSkills({ config, workspace: ws, pluginRoots: knowledgeRoots, ownerRun: true, disabledSkills: ["deploy-runbook:deploy-runbook"] });
    expect(plan.entries.map((e) => e.dir)).toEqual(["learned-one"]);
  });

  it("past the index cap, both metacognition surfaces say how many skills are not listed", async () => {
    const { store, config, owner } = setup();
    const root = bundled(config);
    for (let n = 0; n < MAX_INDEX_ENTRIES + 4; n += 1) makeSkill(root.path, `s${String(n).padStart(3, "0")}`, `---\nname: s${n}\n---`);
    const ws = piWorkspaceFor(config, owner.id, "conv-1");
    const plan = materializePiSkills({ config, workspace: ws, pluginRoots: [root], ownerRun: true, disabledSkills: [] });
    expect(plan.entries).toHaveLength(MAX_INDEX_ENTRIES);
    expect(plan.omitted).toBe(5);

    const request: AgentRequest = {
      message: "m",
      avatar: { id: owner.id, displayName: "Owner", alias: "", persona: "" },
      conversationId: "conv-1",
      viewerUserId: owner.id,
      viewerIsOwner: true,
      elevated: true,
      autoApprove: true,
    };
    const caps = await buildRunCapabilities(request, [], config, store, {}, undefined, () => 0, { piSkills: plan });
    const prompt = buildSystemPromptAppend(stampPromptRequest(request, caps, config, {}));
    expect(prompt).toContain("and 5 more skills not listed (the index is capped)");
    const instance = (caps.inProcessMcpServers.system as unknown as { instance: McpServer }).instance;
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "1" });
    await instance.connect(b);
    await client.connect(a);
    const result = (await client.callTool({ name: "describe_system", arguments: {} })) as { content: { text: string }[] };
    await client.close();
    expect(result.content[0]!.text).toContain("5 more not listed (the index is capped");
  });
});
