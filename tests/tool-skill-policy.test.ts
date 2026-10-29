// Admin builtin tool/skill on-off policy: validators, the global skill list
// (plugin-root scan of the bundled default-skills, served by GET
// /api/admin/system), and the prompt meta-cognition surface.
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";

import { createApp, createServices } from "../src/server/app.js";
import {
  DEFAULT_TOOL_SKILL_POLICY,
  TOGGLABLE_BUILTIN_TOOLS,
  normalizeToolSkillPolicy,
  parseToolSkillPolicy,
} from "../src/server/toolSkillPolicy.js";
import { listPluginRootSkills, skillMdMeta } from "../src/server/agent/skillCatalog.js";
import { buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import type { AgentRequest } from "../src/server/types.js";
import { makeSkill, signup } from "./helpers.js";

const tempDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-skill-policy-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("tool/skill policy validators", () => {
  it("keeps the core tools out of the togglable catalog", () => {
    const names = TOGGLABLE_BUILTIN_TOOLS.flatMap((tool) => tool.names);
    expect(names).toEqual(
      expect.arrayContaining(["WebFetch", "WebSearch"]),
    );
    // The retired agent-teams / workflow toggles are gone with their features.
    expect(names).not.toContain("SendMessage");
    expect(names).not.toContain("Workflow");
    expect(TOGGLABLE_BUILTIN_TOOLS.map((tool) => tool.id)).not.toContain("agent_teams");
    expect(TOGGLABLE_BUILTIN_TOOLS.map((tool) => tool.id)).not.toContain("workflow");
    for (const core of ["Bash", "Read", "Glob", "Grep", "Edit", "Write", "Skill", "AskUserQuestion"]) {
      expect(names).not.toContain(core);
    }
  });

  it("parses a valid policy strictly, deduplicating entries", () => {
    expect(
      parseToolSkillPolicy({
        disabledTools: ["WebFetch", "WebFetch"],
        disabledSkills: ["code-review", "code-review", "plugin:deep-research"],
      }),
    ).toEqual({
      disabledTools: ["WebFetch"],
      disabledSkills: ["code-review", "plugin:deep-research"],
    });
  });

  it("rejects malformed policies at the write boundary", () => {
    expect(parseToolSkillPolicy(null)).toBeNull();
    expect(parseToolSkillPolicy([])).toBeNull();
    expect(parseToolSkillPolicy({ disabledTools: [] })).toBeNull();
    expect(parseToolSkillPolicy({ disabledTools: "WebFetch", disabledSkills: [] })).toBeNull();
    // Core tools outside the togglable catalog must never be disable-able via the API.
    expect(parseToolSkillPolicy({ disabledTools: ["Bash"], disabledSkills: [] })).toBeNull();
    expect(parseToolSkillPolicy({ disabledTools: [], disabledSkills: ["bad name"] })).toBeNull();
    expect(parseToolSkillPolicy({ disabledTools: [], disabledSkills: ["skill(x)"] })).toBeNull();
    expect(
      parseToolSkillPolicy({
        disabledTools: [],
        disabledSkills: Array.from({ length: 201 }, (_, i) => `skill-${i}`),
      }),
    ).toBeNull();
  });

  it("normalizes stored values leniently (corrupt → safe default)", () => {
    expect(normalizeToolSkillPolicy(null)).toEqual(DEFAULT_TOOL_SKILL_POLICY);
    expect(normalizeToolSkillPolicy("garbage")).toEqual(DEFAULT_TOOL_SKILL_POLICY);
    expect(
      normalizeToolSkillPolicy({
        disabledTools: ["WebSearch", "Bash", 42],
        disabledSkills: ["ok-skill", "bad name", null],
      }),
    ).toEqual({ disabledTools: ["WebSearch"], disabledSkills: ["ok-skill"] });
  });

  it("normalizes a stored policy's retired SendMessage/Workflow toggles away on read", () => {
    expect(
      normalizeToolSkillPolicy({
        disabledTools: ["SendMessage", "WebFetch", "Workflow"],
        disabledSkills: [],
      }),
    ).toEqual({ disabledTools: ["WebFetch"], disabledSkills: [] });
    // …and the strict admin write path rejects them like any unknown name.
    expect(parseToolSkillPolicy({ disabledTools: ["SendMessage"], disabledSkills: [] })).toBeNull();
    expect(parseToolSkillPolicy({ disabledTools: ["Workflow"], disabledSkills: [] })).toBeNull();
  });

});

describe("skill catalog helpers", () => {
  function writeSkill(root: string, dir: string, frontmatter?: string) {
    const skillDir = path.join(root, "skills", dir);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      frontmatter !== undefined ? frontmatter : "no frontmatter body\n",
    );
  }

  it("enumerates plugin-root skills from SKILL.md frontmatter with directory fallback", () => {
    const root = tmpDir();
    writeSkill(root, "alpha", "---\nname: alpha-skill\ndescription: Alpha helper\n---\nbody\n");
    writeSkill(root, "beta");
    // Non-directory entries under skills/ are ignored.
    fs.writeFileSync(path.join(root, "skills", "stray.md"), "x");
    const skills = listPluginRootSkills([root, path.join(root, "missing-root")]);
    expect(skills).toEqual([
      { name: "alpha-skill", description: "Alpha helper" },
      { name: "beta", description: "" },
    ]);
  });

  it("skips a skills/ subdirectory that carries no SKILL.md", () => {
    // The scan feeds the admin list and the pi skill sync, so a stray directory
    // must not invent a skill name nothing would ever load.
    const root = tmpDir();
    writeSkill(root, "real", "---\nname: real-skill\n---\n");
    fs.mkdirSync(path.join(root, "skills", "empty-dir"), { recursive: true });
    expect(listPluginRootSkills([root])).toEqual([{ name: "real-skill", description: "" }]);
  });

  it("de-duplicates a skill name shared by two roots, keeping the first root's copy", () => {
    const first = tmpDir();
    const second = tmpDir();
    writeSkill(first, "dup", "---\nname: shared\ndescription: from the first root\n---\n");
    writeSkill(second, "dup", "---\nname: shared\ndescription: from the second root\n---\n");
    expect(listPluginRootSkills([first, second])).toEqual([
      { name: "shared", description: "from the first root" },
    ]);
  });

  it("skillMdMeta tolerates an unreadable file and an unterminated frontmatter block", () => {
    expect(skillMdMeta(path.join(tmpDir(), "does-not-exist", "SKILL.md"))).toEqual({});

    const root = tmpDir();
    // Opening `---` but no closing fence: the whole head is treated as frontmatter
    // rather than discarded, so a name/description still reaches the catalog.
    const openEnded = path.join(root, "SKILL.md");
    fs.writeFileSync(openEnded, '---\nname: "quoted-name"\ndescription: still readable\n');
    expect(skillMdMeta(openEnded)).toEqual({
      name: "quoted-name",
      description: "still readable",
    });
  });
});

describe("admin global skill list (GET /api/admin/system)", () => {
  async function adminSystem(defaultPluginsDir: string) {
    const services = createServices({
      dataDir: path.join(tmpDir(), "data"),
      agentRuntime: "local",
      sessionSecret: "t",
      defaultPluginsDir,
    });
    const agent = request.agent(createApp(services));
    // The first signup on a fresh app is the system admin.
    await signup(agent, "admin").expect(201);
    const res = await agent.get("/api/admin/system").expect(200);
    return res.body.system as {
      skillDiscovery: { fetchedAt: string; skills: { name: string; description: string }[] } & Record<string, unknown>;
    };
  }

  it("lists the default-skills plugin root's skills from disk, with no CLI version", async () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "defaults" }));
    makeSkill(root, "alpha", "---\nname: alpha-skill\ndescription: Alpha helper\n---");
    makeSkill(root, "beta", "no frontmatter");

    const system = await adminSystem(root);
    expect(system.skillDiscovery.skills).toEqual(listPluginRootSkills([root]));
    expect(system.skillDiscovery.skills).toEqual([
      { name: "alpha-skill", description: "Alpha helper" },
      { name: "beta", description: "" },
    ]);
    expect(Number.isNaN(Date.parse(system.skillDiscovery.fetchedAt))).toBe(false);
    // The retired SDK preflight keyed its cache by the bundled CLI version.
    expect(system.skillDiscovery).not.toHaveProperty("cliVersion");
  });

  it("reads the list fresh on every request, so a new SKILL.md shows without a restart", async () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "defaults" }));
    makeSkill(root, "first", "---\nname: first\n---");
    const services = createServices({
      dataDir: path.join(tmpDir(), "data"),
      agentRuntime: "local",
      sessionSecret: "t",
      defaultPluginsDir: root,
    });
    const agent = request.agent(createApp(services));
    await signup(agent, "admin").expect(201);
    let res = await agent.get("/api/admin/system").expect(200);
    expect(res.body.system.skillDiscovery.skills.map((s: { name: string }) => s.name)).toEqual(["first"]);
    makeSkill(root, "second", "---\nname: second\n---");
    res = await agent.get("/api/admin/system").expect(200);
    expect(res.body.system.skillDiscovery.skills.map((s: { name: string }) => s.name).sort()).toEqual([
      "first",
      "second",
    ]);
  });

  it("answers an empty list (never an error) when the default plugin dir is missing", async () => {
    const system = await adminSystem(path.join(tmpDir(), "no-such-dir"));
    expect(system.skillDiscovery.skills).toEqual([]);
  });

  it("lists the repo-bundled default-skills root as shipped", async () => {
    const bundled = path.join(process.cwd(), "default-skills");
    const system = await adminSystem(bundled);
    const names = system.skillDiscovery.skills.map((s) => s.name);
    expect(names).toEqual(listPluginRootSkills([bundled]).map((s) => s.name));
    expect(names).toEqual(expect.arrayContaining(["pptx", "brain-search"]));
  });

  it("is admin-gated", async () => {
    const services = createServices({
      dataDir: path.join(tmpDir(), "data"),
      agentRuntime: "local",
      sessionSecret: "t",
    });
    const app = createApp(services);
    await signup(request.agent(app), "admin").expect(201);
    const member = request.agent(app);
    await signup(member, "member").expect(201);
    await member.get("/api/admin/system").expect(403);
  });
});

describe("prompt admin-disabled note", () => {
  const baseRequest = {
    message: "안녕",
    avatar: { id: "a1", displayName: "아바타", alias: "", persona: "" },
  } as unknown as AgentRequest;

  it("adds the standing note when the admin disabled tools or skills", () => {
    const prompt = buildSystemPromptAppend({
      ...baseRequest,
      adminDisabledTools: ["WebFetch", "WebSearch"],
      adminDisabledSkills: ["code-review"],
    });
    expect(prompt).toContain("system administrator disabled");
    expect(prompt).toContain("`WebFetch`");
    expect(prompt).toContain("`code-review`");
    expect(prompt).toContain("Do not attempt, retry, or suggest them");
  });

  it("omits the note when nothing is disabled", () => {
    expect(buildSystemPromptAppend(baseRequest)).not.toContain("system administrator disabled");
  });
});

// ---- per-model-tier vision policy (modelVisionPolicy.ts) ----
import {
  normalizeModelVisionPolicy,
  parseModelVisionPolicy,
  visionForModel,
} from "../src/server/modelVisionPolicy.js";

describe("model vision policy", () => {
  it("normalize keeps only known tiers with strict-boolean values", () => {
    expect(normalizeModelVisionPolicy(null)).toEqual({});
    expect(normalizeModelVisionPolicy("junk")).toEqual({});
    expect(normalizeModelVisionPolicy({ opus: true, haiku: "no", gpt: false })).toEqual({ opus: true });
  });

  it("parse rejects unknown tiers, non-boolean values, and non-object shapes", () => {
    expect(parseModelVisionPolicy({ opus: false })).toEqual({ opus: false });
    expect(parseModelVisionPolicy({})).toEqual({});
    expect(parseModelVisionPolicy({ gpt: true })).toBeNull();
    expect(parseModelVisionPolicy({ opus: 1 })).toBeNull();
    expect(parseModelVisionPolicy([])).toBeNull();
    expect(parseModelVisionPolicy(null)).toBeNull();
  });

  it("visionForModel: tiers consult the policy; concrete ids and unset tiers inherit the default", () => {
    const policy = { sonnet: false };
    expect(visionForModel("sonnet", policy, true)).toBe(false);
    expect(visionForModel("opus", policy, true)).toBe(true);
    expect(visionForModel("opus", policy, false)).toBe(false);
    expect(visionForModel("claude-opus-4-8", policy, true)).toBe(true);
    expect(visionForModel(null, policy, false)).toBe(false);
    expect(visionForModel(undefined, policy, true)).toBe(true);
  });
});
