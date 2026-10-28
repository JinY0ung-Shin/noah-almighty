// Admin builtin tool/skill on-off policy: validators, the skills-allowlist
// math (discovery cache ∪ plugin-root scan − disabled), and the PreToolUse
// hook + prompt enforcement/meta-cognition surfaces.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// The discovery preflight opens a REAL SDK session (`query()` in streaming-input
// mode). Replace ONLY `query` with a per-test fake and keep everything else real
// — tool()/createSdkMcpServer() are used at import time by the in-process MCP
// servers that createServices pulls in. Each call records a SNAPSHOT of the
// options bag so assertions read what the preflight actually asked for.
// ---------------------------------------------------------------------------
type PreflightQuery = AsyncIterable<unknown> & {
  supportedCommands?: () => Promise<Array<{ name?: unknown; description?: unknown }>>;
};
type PreflightArgs = { prompt: unknown; options: Record<string, unknown> };

const sdkMock = vi.hoisted(() => ({
  impl: null as null | ((args: PreflightArgs) => PreflightQuery),
  calls: [] as Record<string, unknown>[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    query: (args: PreflightArgs) => {
      sdkMock.calls.push({ ...args.options });
      if (!sdkMock.impl) {
        throw new Error("sdkMock.impl not programmed for this test");
      }
      return sdkMock.impl(args);
    },
  };
});

import { createServices } from "../src/server/app.js";
import {
  DEFAULT_TOOL_SKILL_POLICY,
  TOGGLABLE_BUILTIN_TOOLS,
  disallowedEntriesForPolicy,
  normalizeSkillDiscoveryCache,
  normalizeToolSkillPolicy,
  parseToolSkillPolicy,
  type SkillDiscoveryCache,
} from "../src/server/toolSkillPolicy.js";
import {
  bundledCliVersion,
  computeSkillsOption,
  discoverGlobalSkills,
  freshSkillDiscoveryCache,
  listPluginRootSkills,
  skillMdMeta,
} from "../src/server/agent/skillDiscovery.js";
import { buildPreToolUseHook } from "../src/server/agent/preToolUseHook.js";
import { buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { DEFAULT_HEX_SSH_TOOL_POLICY } from "../src/server/hexSshPolicy.js";
import type { AgentRequest } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";

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

  it("compiles the policy into disallowedTools entries", () => {
    const policy = { disabledTools: ["WebFetch"], disabledSkills: ["code-review"] };
    expect(disallowedEntriesForPolicy(policy)).toEqual(["WebFetch", "Skill(code-review)"]);
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

  it("reads the discovery cache leniently", () => {
    expect(normalizeSkillDiscoveryCache(null)).toBeNull();
    expect(normalizeSkillDiscoveryCache({ cliVersion: "", skills: [] })).toBeNull();
    expect(normalizeSkillDiscoveryCache({ cliVersion: "1.0.0", skills: "nope" })).toBeNull();
    expect(
      normalizeSkillDiscoveryCache({
        cliVersion: "1.0.0",
        fetchedAt: "t",
        skills: [{ name: "a", description: "d" }, { description: "nameless" }, "junk"],
      }),
    ).toEqual({ cliVersion: "1.0.0", fetchedAt: "t", skills: [{ name: "a", description: "d" }] });
  });
});

describe("skill discovery helpers", () => {
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

  it("computes the skills option with fail-open visibility", () => {
    const emptyPolicy = { disabledTools: [], disabledSkills: [] };
    const policy = { disabledTools: [], disabledSkills: ["code-review", "qualified-skill"] };
    const cache: SkillDiscoveryCache = {
      cliVersion: "2.1.185",
      fetchedAt: "t",
      skills: [
        { name: "code-review", description: "" },
        { name: "verify", description: "" },
        { name: "some-plugin:qualified-skill", description: "" },
      ],
    };
    // Nothing disabled → pre-feature behavior.
    expect(computeSkillsOption(emptyPolicy, cache, [])).toBe("all");
    // Disabled but no fresh cache → visibility fail-open (hook still denies).
    expect(computeSkillsOption(policy, null, [])).toBe("all");

    const root = tmpDir();
    writeSkill(root, "gamma", "---\nname: gamma-skill\n---\n");
    // Allowlist = (cache ∪ plugin roots) − disabled; a disabled bare name also
    // strips the plugin-qualified form.
    expect(computeSkillsOption(policy, cache, [root])).toEqual(["gamma-skill", "verify"]);
  });

  it("skips a skills/ subdirectory that carries no SKILL.md", () => {
    // The scan feeds an ALLOWLIST, so a stray directory must not invent a skill
    // name (the CLI would never load one, and the entry would be inert noise).
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
    // rather than discarded, so a name/description still reaches the allowlist.
    const openEnded = path.join(root, "SKILL.md");
    fs.writeFileSync(openEnded, '---\nname: "quoted-name"\ndescription: still readable\n');
    expect(skillMdMeta(openEnded)).toEqual({
      name: "quoted-name",
      description: "still readable",
    });
  });
});

describe("global skill discovery (preflight + cache)", () => {
  afterEach(() => {
    sdkMock.impl = null;
    sdkMock.calls.length = 0;
  });

  function services(label: string) {
    return createServices({
      dataDir: path.join(tmpDir(), label),
      agentRuntime: "local",
      sessionSecret: "t",
    });
  }

  /**
   * A query handle shaped like the SDK's: async-iterable (the preflight drains it
   * so the CLI subprocess is reaped) with an optional `supportedCommands()`.
   * `kickInput` starts the caller's idle input generator, which is what registers
   * the abort listener the preflight relies on to end the session.
   */
  function preflightHandle(
    args: PreflightArgs,
    opts: {
      supportedCommands?: () => Promise<Array<{ name?: unknown; description?: unknown }>>;
      drainMessages?: unknown[];
      drainError?: unknown;
      drainHangs?: boolean;
      kickInput?: boolean;
    },
  ): PreflightQuery {
    if (opts.kickInput !== false) {
      void (args.prompt as AsyncGenerator<never>).next();
    }
    async function* drain(): AsyncGenerator<unknown> {
      for (const message of opts.drainMessages ?? []) {
        yield message;
      }
      if (opts.drainError) {
        throw opts.drainError;
      }
      if (opts.drainHangs) {
        // A CLI that takes the abort but never closes its message stream.
        await new Promise<void>(() => {});
      }
    }
    const handle = drain() as PreflightQuery;
    if (opts.supportedCommands) {
      handle.supportedCommands = opts.supportedCommands;
    }
    return handle;
  }

  const commands = async () => [
    { name: "code-review", description: "Review the current diff" },
    { name: "plugin:deep-research" },
    { name: "", description: "nameless commands are dropped" },
    { description: "so are shapeless ones" },
  ];

  it("reads the bundled CLI version out of the installed SDK's package metadata", () => {
    // The discovery cache is keyed by this value, so it must be the SDK's real
    // claudeCodeVersion — an "unknown" fallback would make every cache stale.
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"),
        "utf8",
      ),
    ) as { version?: string; claudeCodeVersion?: string };
    expect(bundledCliVersion()).toBe(pkg.claudeCodeVersion || pkg.version || "unknown");
    expect(bundledCliVersion()).not.toBe("unknown");
  });

  it("treats a stored cache as fresh only while it matches the bundled CLI version", () => {
    const { store } = services("fresh-cache");
    expect(freshSkillDiscoveryCache(store)).toBeNull();

    store.setSkillDiscoveryCache({
      cliVersion: "0.0.0-stale",
      fetchedAt: "t",
      skills: [{ name: "old-skill", description: "" }],
    });
    // After an SDK upgrade the stale list could omit new built-ins, so it is
    // dropped rather than used to compute an allowlist.
    expect(freshSkillDiscoveryCache(store)).toBeNull();

    const current = {
      cliVersion: bundledCliVersion(),
      fetchedAt: "t",
      skills: [{ name: "new-skill", description: "" }],
    };
    store.setSkillDiscoveryCache(current);
    expect(freshSkillDiscoveryCache(store)).toEqual(current);
  });

  it("runs one auth-free preflight, keeps only named commands, and caches the result", async () => {
    const { store, config } = services("preflight-ok");
    sdkMock.impl = (args) => preflightHandle(args, { supportedCommands: commands });

    const cache = await discoverGlobalSkills(store, config);
    expect(cache.cliVersion).toBe(bundledCliVersion());
    expect(cache.skills).toEqual([
      { name: "code-review", description: "Review the current diff" },
      { name: "plugin:deep-research", description: "" },
    ]);
    // Persisted, so the next boot answers from app_config instead of re-running it.
    expect(store.getSkillDiscoveryCache()).toEqual(cache);

    // The session must be incapable of spending a turn: no user message is ever
    // sent, only the app default-skills root is mounted, and the CLI writes into
    // the app's own session dir.
    expect(sdkMock.calls).toHaveLength(1);
    const options = sdkMock.calls[0];
    expect(options.skills).toBe("all");
    expect(options.settingSources).toEqual([]);
    expect(options.settings).toEqual({ crossSessionInbound: "refuse" });
    expect(options.strictMcpConfig).toBe(true);
    expect(options.maxTurns).toBe(1);
    expect(options.cwd).toBe(config.dataDir);
    expect(options.plugins).toEqual([{ type: "local", path: config.defaultPluginsDir }]);
    expect((options.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(config.agentSessionsDir);
    expect(fs.existsSync(config.agentSessionsDir)).toBe(true);
  });

  it("answers a fresh cache without touching the SDK, and refreshes a stale one", async () => {
    const { store, config } = services("preflight-cached");
    const stored = {
      cliVersion: bundledCliVersion(),
      fetchedAt: "2026-01-01T00:00:00.000Z",
      skills: [{ name: "cached-skill", description: "from app_config" }],
    };
    store.setSkillDiscoveryCache(stored);
    // sdkMock.impl stays null: a query() call here would throw.
    expect(await discoverGlobalSkills(store, config)).toEqual(stored);
    expect(sdkMock.calls).toHaveLength(0);

    store.setSkillDiscoveryCache({ ...stored, cliVersion: "0.0.0-stale" });
    sdkMock.impl = (args) => preflightHandle(args, { supportedCommands: commands });
    const refreshed = await discoverGlobalSkills(store, config);
    expect(refreshed.cliVersion).toBe(bundledCliVersion());
    expect(refreshed.skills.map((s) => s.name)).toEqual(["code-review", "plugin:deep-research"]);
    expect(sdkMock.calls).toHaveLength(1);
  });

  it("shares ONE preflight between concurrent callers", async () => {
    const { store, config } = services("preflight-single-flight");
    let release: (() => void) | null = null;
    sdkMock.impl = (args) =>
      preflightHandle(args, {
        supportedCommands: () =>
          new Promise((resolve) => {
            release = () => resolve([{ name: "slow-skill" }]);
          }),
      });

    const first = discoverGlobalSkills(store, config);
    const second = discoverGlobalSkills(store, config);
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    const [a, b] = await Promise.all([first, second]);

    expect(sdkMock.calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(a.skills).toEqual([{ name: "slow-skill", description: "" }]);
  });

  it("propagates a preflight failure and clears the single-flight guard", async () => {
    const { store, config } = services("preflight-fail");
    // An SDK whose query handle lacks supportedCommands() cannot enumerate skills.
    sdkMock.impl = (args) => preflightHandle(args, {});
    await expect(discoverGlobalSkills(store, config)).rejects.toThrow(
      "SDK query() has no supportedCommands()",
    );
    // Nothing cached — the admin route reports the failure, agent runs fail open.
    expect(store.getSkillDiscoveryCache()).toBeNull();

    // The guard was released, so a later attempt runs a NEW preflight.
    sdkMock.impl = (args) => preflightHandle(args, { supportedCommands: commands });
    const cache = await discoverGlobalSkills(store, config);
    expect(cache.skills.map((s) => s.name)).toEqual(["code-review", "plugin:deep-research"]);
    expect(sdkMock.calls).toHaveLength(2);
  });

  it("drains the aborted session's remaining messages and swallows its abort error", async () => {
    // The drain exists to reap the CLI subprocess; whatever it yields is
    // discarded and an abort-time throw must not lose the enumerated skills.
    const { store, config } = services("preflight-drain-error");
    sdkMock.impl = (args) =>
      preflightHandle(args, {
        supportedCommands: async () => [{ name: "survivor" }],
        drainMessages: [{ type: "system", subtype: "init" }],
        drainError: new Error("AbortError: session aborted"),
      });
    const cache = await discoverGlobalSkills(store, config);
    expect(cache.skills).toEqual([{ name: "survivor", description: "" }]);
    expect(store.getSkillDiscoveryCache()?.skills).toEqual([{ name: "survivor", description: "" }]);
  });

  it("aborts a hung preflight at the hard timeout so the admin panel cannot wedge", async () => {
    const { store, config } = services("preflight-timeout");
    vi.useFakeTimers();
    try {
      let abortedAfterMs: number | null = null;
      const startedAt = Date.now();
      sdkMock.impl = (args) => {
        const { signal } = args.options.abortController as AbortController;
        return preflightHandle(args, {
          // A CLI that never answers: the only thing that settles this is the
          // preflight's own abort.
          supportedCommands: () =>
            new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  abortedAfterMs = Date.now() - startedAt;
                  resolve([]);
                },
                { once: true },
              );
            }),
        });
      };
      const pending = discoverGlobalSkills(store, config);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(abortedAfterMs).toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
      const cache = await pending;
      expect(abortedAfterMs).toBe(30_000);
      expect(cache.skills).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the post-abort drain by the same hard timeout, keeping the enumerated skills", async () => {
    // The cap covers the WHOLE preflight: a CLI that answers supportedCommands()
    // but never closes its message stream used to hang the drain forever, past
    // the cap, with the admin request awaiting it inline.
    const { store, config } = services("preflight-drain-hang");
    vi.useFakeTimers();
    try {
      sdkMock.impl = (args) =>
        preflightHandle(args, {
          supportedCommands: async () => [{ name: "enumerated" }],
          drainMessages: [{ type: "system", subtype: "init" }],
          drainHangs: true,
        });
      const pending = discoverGlobalSkills(store, config);
      let settled: "resolved" | "rejected" | null = null;
      void pending.then(
        () => (settled = "resolved"),
        () => (settled = "rejected"),
      );

      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
      // The drain only reaps the subprocess, so losing it costs nothing — the
      // skills it already enumerated survive, exactly like a drain that throws.
      expect(settled).toBe("resolved");
      expect((await pending).skills).toEqual([{ name: "enumerated", description: "" }]);

      // The single-flight guard was released: a discovery that goes stale runs
      // a NEW preflight rather than replaying the abandoned one.
      store.setSkillDiscoveryCache({ cliVersion: "0.0.0-stale", fetchedAt: "t", skills: [] });
      sdkMock.impl = (args) => preflightHandle(args, { supportedCommands: commands });
      const next = await discoverGlobalSkills(store, config);
      expect(next.skills.map((s) => s.name)).toEqual(["code-review", "plugin:deep-research"]);
      expect(sdkMock.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails the discovery when the CLI ignores the abort entirely", async () => {
    // Nothing here ever settles on its own — the deadline is the only exit. It
    // fails rather than caching an empty list, so the panel reports the failure
    // and runs keep failing open to "all".
    const { store, config } = services("preflight-deaf-cli");
    vi.useFakeTimers();
    try {
      sdkMock.impl = (args) =>
        preflightHandle(args, {
          supportedCommands: () => new Promise(() => {}),
          drainHangs: true,
        });
      const pending = discoverGlobalSkills(store, config);
      const outcome = pending.then(
        () => "resolved",
        (error: unknown) => (error as Error).message,
      );

      await vi.advanceTimersByTimeAsync(30_000);
      expect(await outcome).toBe("skill discovery preflight timed out after 30000ms");
      expect(store.getSkillDiscoveryCache()).toBeNull();

      // Guard released here too, so the admin can retry without a restart.
      sdkMock.impl = (args) => preflightHandle(args, { supportedCommands: commands });
      const cache = await discoverGlobalSkills(store, config);
      expect(cache.skills.map((s) => s.name)).toEqual(["code-review", "plugin:deep-research"]);
      expect(sdkMock.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("PreToolUse hook admin tool/skill policy", () => {
  const READONLY = ["Read", "Glob", "Grep"];

  function policyHook(
    policy: { disabledTools: string[]; disabledSkills: string[] },
    events: AgentEvents = {},
  ) {
    return buildPreToolUseHook(
      events,
      true,
      READONLY,
      false,
      false,
      true,
      "owner",
      DEFAULT_HEX_SSH_TOOL_POLICY,
      false,
      policy,
    );
  }

  it("denies an admin-disabled skill with a redirecting reason and Korean block notice", async () => {
    const blocked: string[] = [];
    const hook = policyHook(
      { disabledTools: [], disabledSkills: ["code-review"] },
      { onBlocked: (info) => void blocked.push(info.uiReason ?? "") },
    );
    const out = await hook(
      { tool_name: "Skill", tool_input: { skill: "code-review" }, tool_use_id: "t1" },
      "t1",
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("disabled by the system administrator");
    expect(blocked[0]).toContain("관리자가 비활성화한 스킬");
  });

  it("denies a plugin-qualified invocation of a disabled bare skill name", async () => {
    const hook = policyHook({ disabledTools: [], disabledSkills: ["security-review"] });
    const out = await hook(
      { tool_name: "Skill", tool_input: { skill: "some-plugin:security-review" }, tool_use_id: "t2" },
      "t2",
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("still auto-allows other skills and read-only tools under a policy", async () => {
    const hook = policyHook({ disabledTools: ["WebFetch"], disabledSkills: ["code-review"] });
    const skill = await hook(
      { tool_name: "Skill", tool_input: { skill: "verify" }, tool_use_id: "t3" },
      "t3",
    );
    expect(skill.hookSpecificOutput.permissionDecision).toBe("allow");
    const read = await hook(
      { tool_name: "Read", tool_input: { file_path: "/tmp/x" }, tool_use_id: "t4" },
      "t4",
    );
    expect(read.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  it("denies an admin-disabled built-in tool even for an auto-approving owner", async () => {
    const hook = policyHook({ disabledTools: ["WebFetch"], disabledSkills: [] });
    const out = await hook(
      { tool_name: "WebFetch", tool_input: { url: "https://example.com" }, tool_use_id: "t5" },
      "t5",
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("disabled by the system administrator");
  });

  it("denies the retired orchestration tools even for an auto-approving owner with no policy", async () => {
    const hook = policyHook({ disabledTools: [], disabledSkills: [] });
    for (const [name, input] of [
      ["SendMessage", { to: "reviewer", message: "hi" }],
      ["Workflow", { name: "spec" }],
      ["EnterPlanMode", {}],
      ["ExitPlanMode", { plan: "1. do it" }],
      ["TeamCreate", { team_name: "t" }],
      ["TeamDelete", {}],
    ] as const) {
      const out = await hook({ tool_name: name, tool_input: input, tool_use_id: `t-${name}` }, `t-${name}`);
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain("is not available in this deployment");
    }
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
