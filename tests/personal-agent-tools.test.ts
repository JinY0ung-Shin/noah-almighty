import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvents } from "../src/server/agent/events.js";
import type { AgentRequest, PersonalAgentState } from "../src/server/types.js";
import { callTool, withTempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// Partial SDK mock (agent-run.test.ts pattern): tool()/createSdkMcpServer() stay
// REAL so the in-process servers build, and only `query` is replaced by a fake
// that snapshots each call's `options` — the run loop mutates that object in
// place, so a live reference would read post-mutation state. The registration
// assertions below (allowedTools / mcpServers) are the only way to prove the two
// hand-synced lists agree for a personal-agent run.
// ---------------------------------------------------------------------------
type QueryArgs = { prompt: unknown; options: Record<string, unknown> };
type QueryHandle = AsyncIterable<unknown>;

const sdkMock = vi.hoisted(() => ({
  calls: [] as { options: Record<string, unknown> }[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    query: (args: QueryArgs) => {
      sdkMock.calls.push({ options: { ...args.options } });
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "s1", model: "opus" };
        yield { type: "result", subtype: "success", result: "ok" };
      }
      return gen() as QueryHandle;
    },
  };
});

import { createServices } from "../src/server/app.js";
import { MAX_PERSONAL_AGENTS } from "../src/server/store.js";
import { runAgentStream } from "../src/server/agent/index.js";
import {
  buildPrompt,
  deriveAgentToolAccess,
  planMcpToolFamilies,
} from "../src/server/agent/claudeAgent.js";
import { summarizePersonalAgentState } from "../src/server/agent/ownerState.js";
import {
  buildPersonalAgentOwnerTools,
  buildPersonalAgentSelfTools,
  PERSONAL_AGENT_FIELD_CAPS,
  PERSONAL_AGENT_OWNER_TOOL_NAMES,
  PERSONAL_AGENT_SELF_TOOL_NAMES,
} from "../src/server/agent/personalAgentProfileTools.js";
import { buildSystemTools } from "../src/server/agent/systemTools.js";
import {
  MAX_PERSONAL_AGENT_SKILLS,
  MAX_QUEUED_BOT_TASKS,
  personalAgentAvatarId,
  personalAgentMemoryRoot,
} from "../src/server/personalAgents.js";
import { registerBotTaskDispatcher } from "../src/server/botTaskDispatchBroker.js";
import { buildPreToolUseHook } from "../src/server/agent/preToolUseHook.js";
import { DEFAULT_HEX_SSH_TOOL_POLICY } from "../src/server/hexSshPolicy.js";
import { MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";

let tempDir: string;
const getTempDir = withTempDir("personal-agent-tools", () => {
  tempDir = getTempDir();
  sdkMock.calls.length = 0;
});

/**
 * Fresh services + an ADMIN owner (the first user of a store is auto-granted the
 * system-admin role, which is the phase-1 feature gate) + one of their bots.
 */
function setup(dir: string, opts: { plain?: boolean } = {}) {
  const { config, store } = createServices({
    dataDir: path.join(tempDir, dir),
    agentRuntime: "claude",
    sessionSecret: "test",
    anthropicModel: undefined,
    anthropicApiKey: undefined,
  });
  const admin = store.createUser({
    username: "owner",
    displayName: "오너",
    password: "password123",
  });
  // A SECOND user is a plain (non-admin) one — used for the feature-gate cases.
  const plain = store.createUser({
    username: "plain",
    displayName: "일반",
    password: "password123",
  });
  const owner = opts.plain ? plain : admin;
  const agent = store.createPersonalAgent(owner.id, {
    displayName: "릴리즈 봇",
    alias: "릴봇",
  });
  const cwd = path.join(tempDir, dir, "ws");
  fs.mkdirSync(cwd, { recursive: true });
  // A bot turn is a FULL OWNER run: avatar is the OWNER's own avatar (its id is
  // every capability key) and only `personalAgent` marks the run kind.
  const baseRequest: AgentRequest = {
    message: "안녕",
    avatar: { id: owner.id, displayName: "오너", alias: "노아", persona: "" },
    conversationId: "conv-1",
    cwd,
    viewerUserId: owner.id,
    viewerName: "오너",
    viewerIsOwner: true,
    autoApprove: true,
  };
  const botRequest: AgentRequest = {
    ...baseRequest,
    personalAgent: { agentId: agent.id, ownerUserId: owner.id },
  };
  return { config, store, owner, plain, agent, baseRequest, botRequest };
}

function makeEvents(): AgentEvents {
  return {
    onDelta: vi.fn(),
    onThinking: vi.fn(),
    onThinkingReset: vi.fn(),
    onStatus: vi.fn(),
    onModel: vi.fn(),
    onSessionId: vi.fn(),
    onPlugin: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onTaskStart: vi.fn(),
    onTaskUpdate: vi.fn(),
    onTaskEnd: vi.fn(),
    onAgentStart: vi.fn(),
    onAgentEnd: vi.fn(),
    onBlocked: vi.fn(),
    onPlan: vi.fn(),
  };
}

const lastOptions = () => sdkMock.calls[sdkMock.calls.length - 1].options;
const allowed = () => lastOptions().allowedTools as string[];
const servers = () => Object.keys(lastOptions().mcpServers as Record<string, unknown>);

/**
 * A local bare remote seeded on `main` (the offline knowledge-repo fixture from
 * skill-share.test.ts). The skill-grant tools run a REAL `ensureClone`, so they
 * need a real repo rather than a mock.
 */
function seedRemote(name: string, files: Record<string, string>): string {
  const remote = path.join(tempDir, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { stdio: "pipe" });
  const seed = path.join(tempDir, `${name}-seed`);
  fs.mkdirSync(seed, { recursive: true });
  const g = (...a: string[]) => execFileSync("git", ["-C", seed, ...a], { stdio: "pipe" });
  g("init", "-q");
  g("config", "user.email", "seed@example.com");
  g("config", "user.name", "Seed");
  g("config", "commit.gpgsign", "false");
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(seed, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  g("branch", "-M", "main");
  g("remote", "add", "origin", remote);
  g("push", "-q", "origin", "main");
  return remote;
}

/** Connect `ownerId`'s knowledge repo to a fresh remote holding `slugs` as skills. */
function connectSkillRepo(
  store: ReturnType<typeof setup>["store"],
  ownerId: string,
  name: string,
  slugs: string[],
): void {
  const files: Record<string, string> = { "README.md": "hi" };
  for (const slug of slugs) {
    files[`skills/${slug}/SKILL.md`] =
      `---\nname: ${slug}\ndescription: ${slug} does things\n---\n\n# ${slug}\n`;
  }
  store.setKnowledgeRepo(ownerId, seedRemote(name, files), "main");
}

// ===========================================================================
// Access algebra: a personal-agent run must stay a FULL OWNER run
// ===========================================================================
describe("personal-agent runs keep the owner algebra untouched", () => {
  const ALL = MCP_TOOL_GROUPS.map((g) => g.id);
  const base = {
    message: "m",
    avatar: { id: "u1", displayName: "U", alias: "", persona: "" },
    personalAgent: { agentId: "a1", ownerUserId: "u1" },
  };

  it("deriveAgentToolAccess is identical with and without the personalAgent tag", () => {
    const withTag = deriveAgentToolAccess({
      ...base,
      viewerIsOwner: true,
      autoApprove: true,
    });
    const without = deriveAgentToolAccess({
      message: "m",
      avatar: base.avatar,
      viewerIsOwner: true,
      autoApprove: true,
    });
    expect(withTag).toEqual(without);
    // Spelled out, because this is the whole point of the A-1 capability rule:
    // unlike `groupAgent`, the personal tag is NOT a kill-switch.
    expect(withTag).toMatchObject({
      viewerIsOwner: true,
      ownerToolAccess: true,
      elevatedToolAccess: true,
      elevated: true,
      hexSshViewerClass: "owner",
    });
  });

  it("planMcpToolFamilies keeps every personal family (the bot IS the owner)", () => {
    // planMcpToolFamilies never receives the personal flag; a bot run passes the
    // same `false` a normal owner chat does. Pinned so a future refactor cannot
    // quietly route the personal run through the group-agent containment.
    const plan = planMcpToolFamilies(ALL, false);
    expect(plan.registered).toEqual(ALL);
    expect(plan.runKindBlocked).toEqual([]);
    expect(plan.personalKnowledge).toBe(true);
    expect(plan.browser).toBe(true);
  });
});

// ===========================================================================
// Run-plan registration (the two hand-synced lists)
// ===========================================================================
describe("personal-agent run plan (SDK mocked)", () => {
  it("registers update_profile and the full routine tool set on a bot run", async () => {
    const { config, store, botRequest } = setup("plan-bot");
    await runAgentStream(botRequest, [], config, store, makeEvents());

    expect(servers()).toContain("personal_agent");
    expect(allowed()).toContain("mcp__personal_agent__update_profile");
    // report_task rides EVERY bot run, tracked turn or not — the handler
    // refuses an untracked turn, so the tool set never varies per turn.
    expect(allowed()).toContain("mcp__personal_agent__report_task");
    // 봇 간 위임 rides BOTH sets — a bot may hand work to a sibling bot.
    expect(allowed()).toContain("mcp__personal_agent__delegate_to_bot");
    // Skill grants are the BOT's own allowlist, so they ride the bot set only.
    expect(allowed()).toContain("mcp__personal_agent__adopt_skill");
    expect(allowed()).toContain("mcp__personal_agent__drop_skill");
    // create_agent belongs to the owner's OWN avatar, never to a bot.
    expect(allowed()).not.toContain("mcp__personal_agent__create_agent");
    // A bot schedules its OWN recurring work: the four routine names ride the
    // bot run exactly as they ride an owner run (the handlers self-scope them).
    expect(allowed()).toContain("mcp__system__describe_system");
    expect(allowed()).toContain("mcp__system__list_routines");
    expect(allowed()).toContain("mcp__system__create_routine");
    expect(allowed()).toContain("mcp__system__update_routine");
    expect(allowed()).toContain("mcp__system__delete_routine");
    // Owner capability is untouched: the personal families still register.
    expect(servers()).toContain("repo");
    expect(servers()).toContain("system");
  });

  it("registers create_agent on the owner's own admin run, with routines intact", async () => {
    const { config, store, baseRequest } = setup("plan-owner");
    await runAgentStream(baseRequest, [], config, store, makeEvents());

    expect(servers()).toContain("personal_agent");
    expect(allowed()).toContain("mcp__personal_agent__create_agent");
    // The owner's own avatar hands work to a named bot with the SAME tool.
    expect(allowed()).toContain("mcp__personal_agent__delegate_to_bot");
    expect(allowed()).not.toContain("mcp__personal_agent__update_profile");
    // Delegated tasks exist only inside a bot thread.
    expect(allowed()).not.toContain("mcp__personal_agent__report_task");
    // A bot's skill allowlist is edited by the BOT; the owner's own avatar seeds
    // it at creation (create_agent's `skills`) or the owner uses 설정 → 내 봇.
    expect(allowed()).not.toContain("mcp__personal_agent__adopt_skill");
    expect(allowed()).not.toContain("mcp__personal_agent__drop_skill");
    expect(allowed()).toContain("mcp__system__create_routine");
  });

  it("withholds create_agent from non-admins, headless runs, and consultations", async () => {
    const nonAdmin = setup("plan-nonadmin", { plain: true });
    await runAgentStream(nonAdmin.baseRequest, [], nonAdmin.config, nonAdmin.store, makeEvents());
    expect(servers()).not.toContain("personal_agent");
    expect(allowed()).not.toContain("mcp__personal_agent__create_agent");

    const { config, store, baseRequest } = setup("plan-gates");
    // A scheduled routine holds owner tool access but must not create contacts.
    await runAgentStream(
      { ...baseRequest, headless: true, allowHeadlessTools: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(allowed()).not.toContain("mcp__personal_agent__create_agent");

    await runAgentStream(
      { ...baseRequest, avatarConsultation: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(allowed()).not.toContain("mcp__personal_agent__create_agent");

    // A teammate driving the owner's avatar is not the owner.
    await runAgentStream(
      { ...baseRequest, viewerUserId: "someone-else", viewerIsOwner: false, elevated: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(allowed()).not.toContain("mcp__personal_agent__create_agent");
  });

  it("withholds delegate_to_bot wherever the owner tool set is withheld", async () => {
    // 봇 간 위임 rides the EXISTING registration gates rather than a new one, so
    // every run kind that cannot create a bot cannot hand work to one either —
    // a consultation run in particular, where a teammate's avatar is driving.
    const nonAdmin = setup("delegate-plan-nonadmin", { plain: true });
    await runAgentStream(nonAdmin.baseRequest, [], nonAdmin.config, nonAdmin.store, makeEvents());
    expect(allowed()).not.toContain("mcp__personal_agent__delegate_to_bot");

    const { config, store, baseRequest } = setup("delegate-plan-gates");
    await runAgentStream(
      { ...baseRequest, headless: true, allowHeadlessTools: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(allowed()).not.toContain("mcp__personal_agent__delegate_to_bot");

    await runAgentStream(
      { ...baseRequest, avatarConsultation: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(allowed()).not.toContain("mcp__personal_agent__delegate_to_bot");

    await runAgentStream(
      { ...baseRequest, viewerUserId: "someone-else", viewerIsOwner: false, elevated: true },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(allowed()).not.toContain("mcp__personal_agent__delegate_to_bot");
  });

  it("keeps delegate_to_bot off a GROUP shared-agent run", async () => {
    // A group agent is the other non-users avatar kind and shares NOTHING with
    // this owner's bots — its run must not carry the personal_agent server.
    const { config, store, owner, baseRequest } = setup("delegate-plan-group");
    const group = store.createGroup({ name: "팀", createdBy: owner.id });
    const groupAgent = store.createGroupAgent(group.id, { displayName: "팀 봇" })!;
    await runAgentStream(
      {
        ...baseRequest,
        groupAgent: {
          groupId: group.id,
          agentId: groupAgent.id,
          groupName: group.name,
          viewerRole: "member",
          captureAllowed: false,
        },
      },
      [],
      config,
      store,
      makeEvents(),
    );
    expect(servers()).not.toContain("personal_agent");
    expect(allowed()).not.toContain("mcp__personal_agent__delegate_to_bot");
  });
});

// ===========================================================================
// update_profile (bot self-configuration)
// ===========================================================================
describe("mcp__personal_agent__update_profile", () => {
  it("pins the tool-name lists", () => {
    // Hand-synced with buildPersonalAgentSelfTools: report_task joined the bot
    // set with delegated tasks, and delegate_to_bot joined BOTH sets with 봇 간
    // 위임 (intended contract changes).
    expect([...PERSONAL_AGENT_SELF_TOOL_NAMES]).toEqual([
      "mcp__personal_agent__update_profile",
      "mcp__personal_agent__report_task",
      "mcp__personal_agent__delegate_to_bot",
      // The bot manages its own knowledge-repo skill allowlist (it starts empty).
      "mcp__personal_agent__adopt_skill",
      "mcp__personal_agent__drop_skill",
    ]);
    expect([...PERSONAL_AGENT_OWNER_TOOL_NAMES]).toEqual([
      "mcp__personal_agent__create_agent",
      "mcp__personal_agent__delegate_to_bot",
    ]);
  });

  it("patches the bot, audits it, and says the change lands NEXT turn", async () => {
    const { store, owner, agent } = setup("self-ok");
    const tools = buildPersonalAgentSelfTools(store, {
      agentId: agent.id,
      owner: { id: owner.id, username: "owner", displayName: "오너" },
    });
    const ok = await callTool(tools, "update_profile", {
      persona: "릴리즈 노트만 쓴다",
      alias: "릴봇2",
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain("NEXT turn");
    const updated = store.getPersonalAgentById(agent.id)!;
    expect(updated.persona).toBe("릴리즈 노트만 쓴다");
    expect(updated.alias).toBe("릴봇2");
    // displayName is never patched here.
    expect(updated.displayName).toBe("릴리즈 봇");
    const audit = store
      .listAudit(owner.id, true)
      .find((e) => e.action === "personal_agent_update");
    expect(audit?.detail).toContain(
      `agent=${agent.id} self-config via update_profile (persona, alias)`,
    );
  });

  it("refuses empty patches, over-cap fields, a disabled bot, a foreign actor, and a demoted owner", async () => {
    const { store, owner, plain, agent } = setup("self-gates");
    const ctx = {
      agentId: agent.id,
      owner: { id: owner.id, username: "owner", displayName: "오너" },
    };
    const tools = buildPersonalAgentSelfTools(store, ctx);

    const empty = await callTool(tools, "update_profile", {});
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain("at least one field");

    const overCap = await callTool(tools, "update_profile", {
      alias: "가".repeat(PERSONAL_AGENT_FIELD_CAPS.alias + 1),
    });
    expect(overCap.isError).toBe(true);
    expect(overCap.content[0].text).toContain("limited to 64 characters");

    // Someone else's bot: refused without confirming anything about it.
    const foreign = buildPersonalAgentSelfTools(store, {
      ...ctx,
      owner: { id: plain.id, username: "plain", displayName: "일반" },
    });
    const notMine = await callTool(foreign, "update_profile", { persona: "x" });
    expect(notMine.isError).toBe(true);
    expect(notMine.content[0].text).toContain("belongs to a different user");

    store.updatePersonalAgent(agent.id, { enabled: false });
    const disabled = await callTool(tools, "update_profile", { persona: "x" });
    expect(disabled.isError).toBe(true);
    expect(disabled.content[0].text).toContain("DISABLED");

    // Admin role revoked mid-conversation → the feature gate fails closed, the
    // same way the reach gate will refuse the next turn.
    store.updatePersonalAgent(agent.id, { enabled: true });
    store.setRole(owner.id, "admin", false);
    const demoted = await callTool(tools, "update_profile", { persona: "x" });
    expect(demoted.isError).toBe(true);
    expect(demoted.content[0].text).toContain("administrator-only feature");

    expect(store.getPersonalAgentById(agent.id)!.persona).toBe("");
  });

  it("refuses once the bot row is gone", async () => {
    const { store, owner, agent } = setup("self-deleted");
    const tools = buildPersonalAgentSelfTools(store, {
      agentId: agent.id,
      owner: { id: owner.id, username: "owner", displayName: "오너" },
    });
    store.deletePersonalAgent(agent.id);
    const gone = await callTool(tools, "update_profile", { bio: "x" });
    expect(gone.isError).toBe(true);
    expect(gone.content[0].text).toContain("no longer exists");
  });
});

// ===========================================================================
// report_task (the delegated-task card the owner reads)
// ===========================================================================
describe("mcp__personal_agent__report_task", () => {
  type Setup = ReturnType<typeof setup>;

  /** One RUNNING task — the only state a report is legal from. */
  function runningTask(s: Setup, conversationId = "conv-1") {
    return s.store.createBotTask({
      ownerUserId: s.owner.id,
      agentId: s.agent.id,
      conversationId,
      title: "릴리즈 노트",
      requestText: "이번 주 릴리즈 노트 정리해줘",
      status: "running",
      runId: "run-1",
    });
  }

  function reportTools(s: Setup, taskId: string | null, conversationId = "conv-1") {
    return buildPersonalAgentSelfTools(s.store, {
      agentId: s.agent.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      taskId,
      conversationId,
    });
  }

  it("writes a done report, audits it, and still demands the full answer in the reply", async () => {
    const s = setup("report-done");
    const task = runningTask(s);
    const ok = await callTool(reportTools(s, task.id), "report_task", {
      outcome: "done",
      summary: "릴리즈 노트를 정리해 wiki/에 커밋했습니다.",
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain("marked complete when this turn ends");
    expect(ok.content[0].text).toContain("not just a pointer to this summary");

    const stored = s.store.getBotTask(task.id)!;
    expect(stored.reportedOutcome).toBe("done");
    expect(stored.resultSummary).toBe("릴리즈 노트를 정리해 wiki/에 커밋했습니다.");
    expect(stored.pendingQuestion).toBeNull();
    // The report NEVER moves the status — the turn finalize owns that, so a
    // report without a finalize can't leave a task falsely terminal.
    expect(stored.status).toBe("running");

    const audit = s.store
      .listAudit(s.owner.id, true)
      .find((e) => e.action === "personal_agent_task_report");
    expect(audit?.detail).toContain(`agent=${s.agent.id} task=${task.id} outcome=done`);
    expect(audit?.detail).toContain("conversation=conv-1");
  });

  it("parks a need_input report as the pending question and orders the turn to END", async () => {
    const s = setup("report-need-input");
    const task = runningTask(s);
    const res = await callTool(reportTools(s, task.id), "report_task", {
      outcome: "need_input",
      summary: "어느 브랜치의 커밋을 기준으로 정리할까요?",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("입력 대기");
    expect(res.content[0].text).toContain("END your turn");
    expect(res.content[0].text).toContain("Do not keep working past the question");

    const stored = s.store.getBotTask(task.id)!;
    expect(stored.reportedOutcome).toBe("need_input");
    expect(stored.pendingQuestion).toBe("어느 브랜치의 커밋을 기준으로 정리할까요?");
    // A question is not a result: the summary column stays untouched.
    expect(stored.resultSummary).toBeNull();
    expect(stored.status).toBe("running");
  });

  it("redirects an untracked turn instead of guessing which card to write", async () => {
    const s = setup("report-untracked");
    const task = runningTask(s);
    const res = await callTool(reportTools(s, null), "report_task", {
      outcome: "done",
      summary: "끝냈습니다.",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No delegated task is being tracked");
    expect(res.content[0].text).toContain("do not retry");
    // Nothing was written to the (unrelated) running card.
    expect(s.store.getBotTask(task.id)!.reportedOutcome).toBeNull();
  });

  it("refuses when the task is no longer running", async () => {
    const s = setup("report-not-running");
    const queued = s.store.createBotTask({
      ownerUserId: s.owner.id,
      agentId: s.agent.id,
      conversationId: "conv-1",
      title: "대기 중",
      requestText: "나중에",
      status: "queued",
    });
    const res = await callTool(reportTools(s, queued.id), "report_task", {
      outcome: "done",
      summary: "끝냈습니다.",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("not in a running state anymore");
    const stored = s.store.getBotTask(queued.id)!;
    expect(stored.status).toBe("queued");
    expect(stored.reportedOutcome).toBeNull();
  });

  it("caps the summary and refuses a blank one", async () => {
    const s = setup("report-summary-bounds");
    const task = runningTask(s);
    const tools = reportTools(s, task.id);

    const long = await callTool(tools, "report_task", {
      outcome: "done",
      summary: "가".repeat(2001),
    });
    expect(long.isError).toBe(true);
    expect(long.content[0].text).toContain("limited to 2000 characters");

    const blank = await callTool(tools, "report_task", {
      outcome: "need_input",
      summary: "   ",
    });
    expect(blank.isError).toBe(true);
    expect(blank.content[0].text).toContain("summary is empty");

    expect(s.store.getBotTask(task.id)!.reportedOutcome).toBeNull();
  });

  it("applies the same live gates update_profile does", async () => {
    const s = setup("report-gates");
    const task = runningTask(s);
    const args = { outcome: "done", summary: "끝냈습니다." };

    // Someone else's bot: refused without confirming anything about it.
    const foreign = buildPersonalAgentSelfTools(s.store, {
      agentId: s.agent.id,
      owner: { id: s.plain.id, username: "plain", displayName: "일반" },
      taskId: task.id,
    });
    const notMine = await callTool(foreign, "report_task", args);
    expect(notMine.isError).toBe(true);
    expect(notMine.content[0].text).toContain("belongs to a different user");

    const tools = reportTools(s, task.id);
    s.store.updatePersonalAgent(s.agent.id, { enabled: false });
    const disabled = await callTool(tools, "report_task", args);
    expect(disabled.isError).toBe(true);
    expect(disabled.content[0].text).toContain("DISABLED");

    s.store.updatePersonalAgent(s.agent.id, { enabled: true });
    s.store.setRole(s.owner.id, "admin", false);
    const demoted = await callTool(tools, "report_task", args);
    expect(demoted.isError).toBe(true);
    expect(demoted.content[0].text).toContain("administrator-only feature");

    // Not one of the refusals so far reached the card.
    expect(s.store.getBotTask(task.id)!.reportedOutcome).toBeNull();

    // Deleting the bot cascades its task rows away, so this last case is
    // checked on the refusal alone.
    s.store.setRole(s.owner.id, "admin", true);
    s.store.deletePersonalAgent(s.agent.id);
    const gone = await callTool(tools, "report_task", args);
    expect(gone.isError).toBe(true);
    expect(gone.content[0].text).toContain("no longer exists");
  });
});

// ===========================================================================
// delegate_to_bot (봇 간 위임)
// ===========================================================================
describe("mcp__personal_agent__delegate_to_bot", () => {
  type Setup = ReturnType<typeof setup>;

  /** Every poke the tool sends the dispatcher, without booting index.ts. */
  function spyBroker() {
    const pokes: { ownerUserId: string; conversationId: string }[] = [];
    const dispose = registerBotTaskDispatcher((ownerUserId, conversationId) => {
      pokes.push({ ownerUserId, conversationId });
    });
    return { pokes, dispose };
  }

  /** The delegating BOT's tool set (the self ctx carries the tracked task). */
  function botTools(s: Setup, taskId?: string | null) {
    return buildPersonalAgentSelfTools(s.store, {
      agentId: s.agent.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      taskId,
      conversationId: "conv-1",
    });
  }

  /** The OWNER's main-avatar tool set. */
  function ownerTools(s: Setup) {
    return buildPersonalAgentOwnerTools(s.store, {
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
    });
  }

  /** A second bot of the same owner — the hand-off target. */
  function targetBot(s: Setup, displayName = "리서치 봇", alias = "리서치") {
    return s.store.createPersonalAgent(s.owner.id, { displayName, alias });
  }

  it("queues the hand-off on the target's thread with provenance, and pokes the dispatcher", async () => {
    const s = setup("delegate-ok");
    const target = targetBot(s);
    const broker = spyBroker();
    try {
      const res = await callTool(botTools(s), "delegate_to_bot", {
        target: "리서치 봇",
        request: "다음 주 경쟁사 동향 조사해서 정리해줘",
      });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain("QUEUED on that bot's own thread");
      expect(res.content[0].text).toContain("봇 오피스");
      expect(res.content[0].text).toContain(
        "Tell the owner what you handed off and why in your final reply",
      );
      expect(res.content[0].text).toContain("cannot see this conversation");

      const tasks = s.store.listBotTasks(s.owner.id, { agentId: target.id });
      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      expect(task.status).toBe("queued");
      // Provenance: the DELEGATING bot, at hop 1 (an untracked bot turn opens
      // the chain the same way the owner's own avatar does).
      expect(task.delegatedByAgentId).toBe(s.agent.id);
      expect(task.delegationDepth).toBe(1);
      // The card's label is the raw request, not the prefixed bubble.
      expect(task.title).toBe("다음 주 경쟁사 동향 조사해서 정리해줘");
      expect(task.requestText).toBe(
        "[릴리즈 봇 위임] 다음 주 경쟁사 동향 조사해서 정리해줘",
      );
      expect(res.content[0].text).toContain(task.id);

      // The user turn is persisted on the TARGET's thread, bound to its
      // composite avatar id, so the owner reads the hand-off in context.
      const thread = task.conversationId;
      expect(s.store.getConversationAvatarId(s.owner.id, thread)).toBe(
        personalAgentAvatarId(s.owner.id, target.id),
      );
      const messages = s.store.listMessages(s.owner.id, thread);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe(
        "[릴리즈 봇 위임] 다음 주 경쟁사 동향 조사해서 정리해줘",
      );

      expect(broker.pokes).toEqual([
        { ownerUserId: s.owner.id, conversationId: thread },
      ]);
      const audit = s.store
        .listAudit(s.owner.id, true)
        .find((e) => e.action === "personal_agent_delegate");
      expect(audit?.detail).toContain(`from=${s.agent.id}`);
      expect(audit?.detail).toContain(`to=${target.id} (리서치 봇)`);
      expect(audit?.detail).toContain(`task=${task.id} depth=1`);
    } finally {
      broker.dispose();
    }
  });

  it("labels a MAIN-avatar hand-off as 아바타 and leaves the provenance NULL", async () => {
    const s = setup("delegate-owner-run");
    const target = targetBot(s);
    const broker = spyBroker();
    try {
      const res = await callTool(ownerTools(s), "delegate_to_bot", {
        target: target.id,
        request: "릴리즈 노트 초안 잡아줘",
      });
      expect(res.isError).toBeFalsy();
      const task = s.store.listBotTasks(s.owner.id, { agentId: target.id })[0];
      // NULL provenance + depth 1 is what says "the owner's avatar, not a bot".
      expect(task.delegatedByAgentId).toBeNull();
      expect(task.delegationDepth).toBe(1);
      expect(task.requestText).toBe("[아바타 위임] 릴리즈 노트 초안 잡아줘");
      // Run later from the queue, so its bubble can never anchor a rewind.
      expect(s.store.listMessages(s.owner.id, task.conversationId).at(-1)).toMatchObject({
        role: "user",
        content: "[아바타 위임] 릴리즈 노트 초안 잡아줘",
        kind: "queued",
      });
      expect(broker.pokes).toHaveLength(1);
    } finally {
      broker.dispose();
    }
  });

  it("resolves the target by id, name, and alias — case-insensitively", async () => {
    const s = setup("delegate-resolve");
    const target = targetBot(s);
    const english = s.store.createPersonalAgent(s.owner.id, {
      displayName: "Ops Bot",
    });
    const broker = spyBroker();
    try {
      for (const wanted of [target.id, "리서치 봇", "리서치"]) {
        const res = await callTool(botTools(s), "delegate_to_bot", {
          target: wanted,
          request: `조사: ${wanted}`,
        });
        expect(res.isError).toBeFalsy();
      }
      expect(
        s.store.listBotTasks(s.owner.id, { agentId: target.id }),
      ).toHaveLength(3);

      // A fresh turn's tool set — the per-turn budget is per run, not global.
      const res = await callTool(botTools(s), "delegate_to_bot", {
        target: "  ops bot ",
        request: "배포 로그 확인해줘",
      });
      expect(res.isError).toBeFalsy();
      expect(
        s.store.listBotTasks(s.owner.id, { agentId: english.id }),
      ).toHaveLength(1);
    } finally {
      broker.dispose();
    }
  });

  it("redirects an unknown name, an ambiguous one, a disabled bot, and itself", async () => {
    const s = setup("delegate-target-misses");
    const first = targetBot(s, "리서치 봇", "쌍둥이");
    const second = targetBot(s, "조사 봇", "쌍둥이");
    const broker = spyBroker();
    try {
      const unknown = await callTool(botTools(s), "delegate_to_bot", {
        target: "없는봇",
        request: "뭔가 해줘",
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.content[0].text).toContain('No enabled bot of this owner matches "없는봇"');
      // The redirect names what IS reachable, minus the running bot itself.
      expect(unknown.content[0].text).toContain("리서치 봇");
      expect(unknown.content[0].text).toContain("조사 봇");
      expect(unknown.content[0].text).not.toContain("릴리즈 봇");

      const ambiguous = await callTool(botTools(s), "delegate_to_bot", {
        target: "쌍둥이",
        request: "뭔가 해줘",
      });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.content[0].text).toContain("matches 2 of this owner's bots");
      expect(ambiguous.content[0].text).toContain(`리서치 봇 (id ${first.id})`);
      expect(ambiguous.content[0].text).toContain(`조사 봇 (id ${second.id})`);

      // A DISABLED bot is not a name you can use — it never reaches the reach
      // gate, so the refusal reads as "no such target", not "it failed".
      s.store.updatePersonalAgent(second.id, { enabled: false });
      const disabled = await callTool(botTools(s), "delegate_to_bot", {
        target: "조사 봇",
        request: "뭔가 해줘",
      });
      expect(disabled.isError).toBe(true);
      expect(disabled.content[0].text).toContain("No enabled bot of this owner matches");

      const self = await callTool(botTools(s), "delegate_to_bot", {
        target: "릴리즈 봇",
        request: "내가 할 일",
      });
      expect(self.isError).toBe(true);
      expect(self.content[0].text).toContain("Delegating to yourself is a no-op");

      // Not one refusal queued anything or woke the dispatcher.
      expect(s.store.listBotTasks(s.owner.id)).toHaveLength(0);
      expect(broker.pokes).toHaveLength(0);
    } finally {
      broker.dispose();
    }
  });

  it("refuses when the owner has no other bot at all", async () => {
    const s = setup("delegate-no-siblings");
    const res = await callTool(botTools(s), "delegate_to_bot", {
      target: "아무 봇",
      request: "뭔가 해줘",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("They have no other enabled bot");
  });

  it("re-checks the LIVE reach gate after the roster read", async () => {
    const s = setup("delegate-live-gate");
    const target = targetBot(s);
    // The roster read finds the bot; the reach gate then refuses because the
    // owner lost the admin role that the whole feature is gated on.
    const tools = botTools(s);
    s.store.setRole(s.owner.id, "admin", false);
    const demoted = await callTool(tools, "delegate_to_bot", {
      target: target.id,
      request: "뭔가 해줘",
    });
    expect(demoted.isError).toBe(true);
    // The DELEGATING bot's own gate fires first — same refusal as every other
    // tool on this set.
    expect(demoted.content[0].text).toContain("administrator-only feature");
    expect(s.store.listBotTasks(s.owner.id)).toHaveLength(0);
  });

  it("stops the chain at two hops and keeps counting depth off the TASK", async () => {
    const s = setup("delegate-depth");
    const target = targetBot(s);
    const broker = spyBroker();
    try {
      // A turn whose task is itself a hop-1 delegation may hand off ONCE more.
      const hop1 = s.store.createBotTask({
        ownerUserId: s.owner.id,
        agentId: s.agent.id,
        conversationId: "conv-1",
        title: "1홉",
        requestText: "[아바타 위임] 조사해줘",
        status: "running",
        runId: "run-1",
        delegationDepth: 1,
      });
      const ok = await callTool(botTools(s, hop1.id), "delegate_to_bot", {
        target: target.id,
        request: "이건 리서치 봇 일이야",
      });
      expect(ok.isError).toBeFalsy();
      expect(
        s.store.listBotTasks(s.owner.id, { agentId: target.id })[0].delegationDepth,
      ).toBe(2);

      // At the cap the chain STOPS, no matter how reachable the target is.
      const hop2 = s.store.createBotTask({
        ownerUserId: s.owner.id,
        agentId: s.agent.id,
        conversationId: "conv-1",
        title: "2홉",
        requestText: "[리서치 봇 위임] 더 파봐",
        status: "running",
        runId: "run-2",
        delegationDepth: 2,
      });
      const capped = await callTool(botTools(s, hop2.id), "delegate_to_bot", {
        target: target.id,
        request: "한 번 더",
      });
      expect(capped.isError).toBe(true);
      expect(capped.content[0].text).toContain("already two hand-offs deep");
      expect(capped.content[0].text).toContain("report need_input if you are blocked");
      expect(
        s.store.listBotTasks(s.owner.id, { agentId: target.id }),
      ).toHaveLength(1);
    } finally {
      broker.dispose();
    }
  });

  it("caps ONE turn at three hand-offs, counting only the ones that landed", async () => {
    const s = setup("delegate-turn-budget");
    const target = targetBot(s);
    const broker = spyBroker();
    try {
      const tools = botTools(s);
      // A refusal is not a hand-off: this one must not spend the budget.
      const missed = await callTool(tools, "delegate_to_bot", {
        target: "없는봇",
        request: "뭔가",
      });
      expect(missed.isError).toBe(true);

      for (let i = 0; i < 3; i += 1) {
        const res = await callTool(tools, "delegate_to_bot", {
          target: target.id,
          request: `작업 ${i}`,
        });
        expect(res.isError).toBeFalsy();
      }
      const spent = await callTool(tools, "delegate_to_bot", {
        target: target.id,
        request: "네 번째",
      });
      expect(spent.isError).toBe(true);
      expect(spent.content[0].text).toContain("already handed off 3 request(s) in this turn");
      expect(
        s.store.listBotTasks(s.owner.id, { agentId: target.id }),
      ).toHaveLength(3);
    } finally {
      broker.dispose();
    }
  });

  it("refuses once the target's own queue is full", async () => {
    const s = setup("delegate-queue-full");
    const target = targetBot(s);
    const broker = spyBroker();
    try {
      // Seed the thread the hand-off would land in, then fill its queue.
      const thread = "target-thread";
      s.store.touchConversation(
        s.owner.id,
        thread,
        personalAgentAvatarId(s.owner.id, target.id),
        "안녕",
      );
      for (let i = 0; i < MAX_QUEUED_BOT_TASKS; i += 1) {
        s.store.createBotTask({
          ownerUserId: s.owner.id,
          agentId: target.id,
          conversationId: thread,
          title: `대기 ${i}`,
          requestText: `대기 ${i}`,
          status: "queued",
        });
      }
      const res = await callTool(botTools(s), "delegate_to_bot", {
        target: target.id,
        request: "하나 더",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain(
        `already has ${MAX_QUEUED_BOT_TASKS} requests waiting`,
      );
      expect(
        s.store.listBotTasks(s.owner.id, { agentId: target.id }),
      ).toHaveLength(MAX_QUEUED_BOT_TASKS);
      expect(broker.pokes).toHaveLength(0);
    } finally {
      broker.dispose();
    }
  });

  it("reuses the owner's existing thread with the target, and never a routine one", async () => {
    const s = setup("delegate-thread-choice");
    const target = targetBot(s);
    const targetAvatarId = personalAgentAvatarId(s.owner.id, target.id);
    const broker = spyBroker();
    try {
      // A 예약 작업 thread is the scheduler's own and gets pruned on its terms,
      // so a hand-off must never land in it — even when it is the newest.
      s.store.touchConversation(s.owner.id, "routine-thread", targetAvatarId, "[예약 작업]", {
        isRoutine: true,
      });
      const fresh = await callTool(botTools(s), "delegate_to_bot", {
        target: target.id,
        request: "첫 위임",
      });
      expect(fresh.isError).toBeFalsy();
      const first = s.store.listBotTasks(s.owner.id, { agentId: target.id })[0];
      expect(first.conversationId).not.toBe("routine-thread");

      // The SECOND hand-off joins the thread the first one minted.
      const again = await callTool(botTools(s), "delegate_to_bot", {
        target: target.id,
        request: "두 번째 위임",
      });
      expect(again.isError).toBeFalsy();
      const tasks = s.store.listBotTasks(s.owner.id, { agentId: target.id });
      expect(tasks).toHaveLength(2);
      expect(new Set(tasks.map((t) => t.conversationId)).size).toBe(1);
      expect(s.store.listMessages(s.owner.id, first.conversationId)).toHaveLength(2);
    } finally {
      broker.dispose();
    }
  });

  it("refuses a blank request and a blank target before touching anything", async () => {
    const s = setup("delegate-blank-args");
    const target = targetBot(s);
    const emptyRequest = await callTool(botTools(s), "delegate_to_bot", {
      target: target.id,
      request: "   ",
    });
    expect(emptyRequest.isError).toBe(true);
    expect(emptyRequest.content[0].text).toContain("The `request` is empty");

    const emptyTarget = await callTool(botTools(s), "delegate_to_bot", {
      target: " ",
      request: "뭔가 해줘",
    });
    expect(emptyTarget.isError).toBe(true);
    expect(emptyTarget.content[0].text).toContain("Name which bot to hand this to");
    expect(s.store.listBotTasks(s.owner.id)).toHaveLength(0);
  });

  it("survives an unregistered broker — the task still queues", async () => {
    // Nothing registers a dispatcher in a plain unit run (index.ts never boots),
    // so the poke must be a silent no-op rather than a throw: the row stays
    // queued and the next settle / boot drain picks it up.
    const s = setup("delegate-no-broker");
    const target = targetBot(s);
    const res = await callTool(botTools(s), "delegate_to_bot", {
      target: target.id,
      request: "브로커 없이",
    });
    expect(res.isError).toBeFalsy();
    expect(s.store.listBotTasks(s.owner.id, { agentId: target.id })).toHaveLength(1);
  });
});

// ===========================================================================
// Turn-boundary question protocol (the PreToolUse hook)
// ===========================================================================
describe("AskUserQuestion in a personal-bot conversation", () => {
  const askHook = (
    opts: { personalAgentRun: boolean; headless?: boolean },
    events: AgentEvents = {},
  ) =>
    buildPreToolUseHook(
      events,
      true, // elevated
      ["Read", "Glob", "Grep"],
      opts.headless === true,
      false, // allowHeadlessTools
      true, // autoApprove
      "owner",
      DEFAULT_HEX_SSH_TOOL_POLICY,
      false, // activeRepoMode
      undefined, // toolSkillPolicy
      true, // visionEnabled
      opts.personalAgentRun,
    );

  const ask = (
    opts: { personalAgentRun: boolean; headless?: boolean },
    events: AgentEvents = {},
  ) =>
    askHook(opts, events)(
      {
        tool_name: "AskUserQuestion",
        tool_input: { questions: [{ question: "어느 브랜치?" }] },
        tool_use_id: "q1",
      },
      "q1",
    );

  it("denies the dialog and redirects to report_task, without ever raising it", async () => {
    const onQuestion = vi.fn(async () => ({
      behavior: "completed" as const,
      result: { answers: { "어느 브랜치?": "main" } },
    }));
    const out = await ask({ personalAgentRun: true }, { onQuestion });
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason = out.hookSpecificOutput.permissionDecisionReason ?? "";
    expect(reason).toContain("never block on an interactive question dialog");
    expect(reason).toContain("mcp__personal_agent__report_task with outcome 'need_input'");
    expect(reason).toContain("END your turn with that question in your reply text");
    // The owner may be away: the modal is never opened at all.
    expect(onQuestion).not.toHaveBeenCalled();
  });

  it("wins over the headless branch — one protocol for queued and interactive bot turns", async () => {
    const out = await ask({ personalAgentRun: true, headless: true });
    const reason = out.hookSpecificOutput.permissionDecisionReason ?? "";
    expect(reason).toContain("mcp__personal_agent__report_task");
    expect(reason).not.toContain("Proceed with reasonable assumptions");
  });

  it("leaves a non-bot run on the existing dialog path", async () => {
    const onQuestion = vi.fn(async () => ({
      behavior: "completed" as const,
      result: { answers: { "어느 브랜치?": "main" } },
    }));
    const answered = await ask({ personalAgentRun: false }, { onQuestion });
    expect(onQuestion).toHaveBeenCalledTimes(1);
    // The answer rides the tool's own input, so the tool returns it as its result.
    expect(answered.hookSpecificOutput).toMatchObject({
      permissionDecision: "allow",
      updatedInput: { answers: { "어느 브랜치?": "main" } },
    });
    expect(JSON.stringify(answered.hookSpecificOutput)).not.toContain("report_task");

    // …and a headless non-bot run keeps its own wording.
    const headless = await ask({ personalAgentRun: false, headless: true });
    expect(headless.hookSpecificOutput.permissionDecisionReason).toContain(
      "Proceed with reasonable assumptions",
    );
  });
});

// ===========================================================================
// create_agent (owner's own avatar)
// ===========================================================================
describe("mcp__personal_agent__create_agent", () => {
  it("creates a chattable bot, audits it, and names the routes to it", async () => {
    const { store, owner } = setup("create-ok");
    const tools = buildPersonalAgentOwnerTools(store, {
      owner: { id: owner.id, username: "owner", displayName: "오너" },
    });
    const before = store.countPersonalAgents(owner.id);
    const ok = await callTool(tools, "create_agent", {
      display_name: "  회의록 봇  ",
      persona: "회의록만 정리한다",
    });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain("회의록 봇");
    expect(ok.content[0].text).toContain("내 봇");
    expect(store.countPersonalAgents(owner.id)).toBe(before + 1);
    const created = store
      .listPersonalAgents(owner.id, { includeDisabled: true })
      .find((a) => a.displayName === "회의록 봇")!;
    expect(created.persona).toBe("회의록만 정리한다");
    expect(created.enabled).toBe(true);
    const audit = store
      .listAudit(owner.id, true)
      .find((e) => e.action === "personal_agent_create");
    expect(audit?.detail).toContain(`agent=${created.id} (회의록 봇) via create_agent`);
  });

  it("refuses a non-admin owner, an empty name, an over-cap name, and the roster cap", async () => {
    const { store, plain, owner } = setup("create-gates");
    const nonAdmin = buildPersonalAgentOwnerTools(store, {
      owner: { id: plain.id, username: "plain", displayName: "일반" },
    });
    const denied = await callTool(nonAdmin, "create_agent", { display_name: "봇" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("administrator-only feature");

    const tools = buildPersonalAgentOwnerTools(store, {
      owner: { id: owner.id, username: "owner", displayName: "오너" },
    });
    const empty = await callTool(tools, "create_agent", { display_name: "   " });
    expect(empty.isError).toBe(true);
    expect(empty.content[0].text).toContain("needs a name");

    const longName = await callTool(tools, "create_agent", { display_name: "가".repeat(65) });
    expect(longName.isError).toBe(true);
    expect(longName.content[0].text).toContain("limited to 64 characters");

    // Fill the roster (setup already created one) and hit the store's cap throw.
    while (store.countPersonalAgents(owner.id) < MAX_PERSONAL_AGENTS) {
      store.createPersonalAgent(owner.id, {
        displayName: `봇-${store.countPersonalAgents(owner.id)}`,
      });
    }
    const capped = await callTool(tools, "create_agent", { display_name: "하나 더" });
    expect(capped.isError).toBe(true);
    expect(capped.content[0].text).toContain(`maximum of ${MAX_PERSONAL_AGENTS}`);
    expect(store.countPersonalAgents(owner.id)).toBe(MAX_PERSONAL_AGENTS);
  });

  it("seeds the new bot's skills in ONE call, checked against the owner's repo", async () => {
    const { config, store, owner } = setup("create-skills");
    connectSkillRepo(store, owner.id, "create-skills-repo", ["code-review", "deploy"]);
    const tools = buildPersonalAgentOwnerTools(store, {
      owner: { id: owner.id, username: "owner", displayName: "오너" },
      config,
    });

    // "코딩봇 만들고 code-review 스킬 줘" — one call, not create-then-adopt.
    const ok = await callTool(tools, "create_agent", {
      display_name: "코딩 봇",
      skills: ["code-review", "code-review"],
    });
    expect(ok.isError).toBeFalsy();
    const created = store
      .listPersonalAgents(owner.id, { includeDisabled: true })
      .find((a) => a.displayName === "코딩 봇")!;
    expect(created.selectedSkills).toEqual(["code-review"]);
    // A brand-new bot loads them from its FIRST conversation — no next-turn caveat.
    expect(ok.content[0].text).toContain("first conversation");
    const audit = store
      .listAudit(owner.id, true)
      .find((e) => e.detail?.includes("via create_agent"));
    expect(audit?.detail).toContain("skills=code-review");

    // An unknown slug is refused with the real roster — no bot is created.
    const before = store.countPersonalAgents(owner.id);
    const unknown = await callTool(tools, "create_agent", {
      display_name: "릴리즈 봇",
      skills: ["release-notes"],
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain("code-review, deploy");
    expect(store.countPersonalAgents(owner.id)).toBe(before);

    // Shape failures use the same rule the settings route enforces.
    const bad = await callTool(tools, "create_agent", {
      display_name: "봇",
      skills: ["../../etc"],
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("not a skill directory name");
    expect(store.countPersonalAgents(owner.id)).toBe(before);

    // Without `skills` the repo is never consulted (and no repo is needed).
    const plainSetup = setup("create-skills-norepo");
    const noRepoTools = buildPersonalAgentOwnerTools(plainSetup.store, {
      owner: { id: plainSetup.owner.id, username: "owner", displayName: "오너" },
      config: plainSetup.config,
    });
    const noSkills = await callTool(noRepoTools, "create_agent", { display_name: "빈 봇" });
    expect(noSkills.isError).toBeFalsy();
    expect(noSkills.content[0].text).toContain("carries no skills yet");
  });
});

// ===========================================================================
// adopt_skill / drop_skill (the bot's own knowledge-repo skill allowlist)
// ===========================================================================
describe("mcp__personal_agent__adopt_skill / drop_skill", () => {
  type Setup = ReturnType<typeof setup>;

  /** The bot tool set, with the repo-resolving config unless `noConfig`. */
  function skillTools(s: Setup, opts: { noConfig?: boolean } = {}) {
    return buildPersonalAgentSelfTools(s.store, {
      agentId: s.agent.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      config: opts.noConfig ? undefined : s.config,
    });
  }

  it("grants a repo skill, audits it, and pins the next-CONVERSATION wording", async () => {
    const s = setup("adopt-ok");
    connectSkillRepo(s.store, s.owner.id, "adopt-ok-repo", ["code-review", "pptx-report"]);
    const tools = skillTools(s);

    // A bot starts with NO skills — that is the whole point of the allowlist.
    expect(s.store.getPersonalAgentById(s.agent.id)!.selectedSkills).toEqual([]);

    const ok = await callTool(tools, "adopt_skill", { slug: " code-review " });
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain("code-review");
    // Skill loading resolves at run start, so a grant can never join THIS session.
    expect(ok.content[0].text).toContain(
      "Takes effect from the NEXT conversation (this session keeps its current skill set)",
    );
    expect(s.store.getPersonalAgentById(s.agent.id)!.selectedSkills).toEqual([
      "code-review",
    ]);
    const audit = s.store
      .listAudit(s.owner.id, true)
      .find((e) => e.detail?.includes("adopt_skill"));
    expect(audit?.action).toBe("personal_agent_update");
    expect(audit?.detail).toContain(`agent=${s.agent.id} adopt_skill slug=code-review`);

    // A second grant appends rather than replacing.
    await callTool(tools, "adopt_skill", { slug: "pptx-report" });
    expect(s.store.getPersonalAgentById(s.agent.id)!.selectedSkills).toEqual([
      "code-review",
      "pptx-report",
    ]);

    // Re-adopting is a no-op, reported as such (not an error).
    const again = await callTool(tools, "adopt_skill", { slug: "code-review" });
    expect(again.isError).toBeFalsy();
    expect(again.content[0].text).toContain("already have");
    expect(s.store.getPersonalAgentById(s.agent.id)!.selectedSkills).toHaveLength(2);
  });

  it("lists the owner's real roster instead of accepting an unknown slug", async () => {
    const s = setup("adopt-unknown");
    connectSkillRepo(s.store, s.owner.id, "adopt-unknown-repo", ["code-review", "deploy"]);
    const unknown = await callTool(skillTools(s), "adopt_skill", {
      slug: "release-notes",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('no skill named "release-notes"');
    expect(unknown.content[0].text).toContain("code-review, deploy");
    expect(s.store.getPersonalAgentById(s.agent.id)!.selectedSkills).toEqual([]);

    // A repo with no skills at all says so rather than listing nothing.
    const bare = setup("adopt-bare");
    connectSkillRepo(bare.store, bare.owner.id, "adopt-bare-repo", []);
    const none = await callTool(skillTools(bare), "adopt_skill", { slug: "x" });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toContain("holds no skills yet");
  });

  it("refuses a slug that is not one safe path segment, and a blank one", async () => {
    const s = setup("adopt-shape");
    connectSkillRepo(s.store, s.owner.id, "adopt-shape-repo", ["code-review"]);
    const tools = skillTools(s);

    const blank = await callTool(tools, "adopt_skill", { slug: "   " });
    expect(blank.isError).toBe(true);
    expect(blank.content[0].text).toContain("Name the skill");

    for (const bad of ["../../etc", "a/b", "..", "스킬"]) {
      const res = await callTool(tools, "adopt_skill", { slug: bad });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("not a skill directory name");
    }
    // Refused before the repo is even consulted — nothing was stored.
    expect(s.store.getPersonalAgentById(s.agent.id)!.selectedSkills).toEqual([]);
  });

  it("fails closed with no repo connected and with no config in the run", async () => {
    const s = setup("adopt-no-repo");
    const noRepo = await callTool(skillTools(s), "adopt_skill", { slug: "code-review" });
    expect(noRepo.isError).toBe(true);
    expect(noRepo.content[0].text).toContain("no knowledge repository connected");
    expect(noRepo.content[0].text).toContain("설정 → 지식 저장소");

    // A run that cannot resolve the repo at all refuses rather than granting
    // something unverified.
    connectSkillRepo(s.store, s.owner.id, "adopt-no-config-repo", ["code-review"]);
    const noConfig = await callTool(skillTools(s, { noConfig: true }), "adopt_skill", {
      slug: "code-review",
    });
    expect(noConfig.isError).toBe(true);
    expect(noConfig.content[0].text).toContain("설정 → 내 봇");
    expect(s.store.getPersonalAgentById(s.agent.id)!.selectedSkills).toEqual([]);
  });

  it("stops at the per-bot skill cap", async () => {
    const s = setup("adopt-cap");
    const slugs = Array.from({ length: MAX_PERSONAL_AGENT_SKILLS + 1 }, (_, i) => `s-${i}`);
    connectSkillRepo(s.store, s.owner.id, "adopt-cap-repo", slugs);
    // Fill the allowlist to the ceiling through the store, then try one more.
    s.store.updatePersonalAgent(s.agent.id, {
      selectedSkills: slugs.slice(0, MAX_PERSONAL_AGENT_SKILLS),
    });
    const capped = await callTool(skillTools(s), "adopt_skill", {
      slug: slugs[MAX_PERSONAL_AGENT_SKILLS],
    });
    expect(capped.isError).toBe(true);
    expect(capped.content[0].text).toContain(`limit of ${MAX_PERSONAL_AGENT_SKILLS}`);
    expect(capped.content[0].text).toContain("drop_skill");
    expect(s.store.getPersonalAgentById(s.agent.id)!.selectedSkills).toHaveLength(
      MAX_PERSONAL_AGENT_SKILLS,
    );
  });

  it("drops a grant without touching the repo, and reports an ungranted slug plainly", async () => {
    const s = setup("drop-ok");
    s.store.updatePersonalAgent(s.agent.id, {
      selectedSkills: ["code-review", "deploy"],
    });
    // drop needs no repo at all: it only removes the grant.
    const tools = skillTools(s, { noConfig: true });

    const dropped = await callTool(tools, "drop_skill", { slug: "code-review" });
    expect(dropped.isError).toBeFalsy();
    expect(dropped.content[0].text).toContain('Dropped "code-review"');
    expect(dropped.content[0].text).toContain("untouched in the owner's repository");
    expect(dropped.content[0].text).toContain(
      "Takes effect from the NEXT conversation (this session keeps its current skill set)",
    );
    expect(s.store.getPersonalAgentById(s.agent.id)!.selectedSkills).toEqual(["deploy"]);
    const audit = s.store
      .listAudit(s.owner.id, true)
      .find((e) => e.detail?.includes("drop_skill"));
    expect(audit?.action).toBe("personal_agent_update");
    expect(audit?.detail).toContain(`agent=${s.agent.id} drop_skill slug=code-review`);

    // Not adopted → NOT an error: the state the owner asked for already holds.
    const missing = await callTool(tools, "drop_skill", { slug: "release-notes" });
    expect(missing.isError).toBeFalsy();
    expect(missing.content[0].text).toContain("was not one of your skills");
    expect(missing.content[0].text).toContain("deploy");
    expect(s.store.getPersonalAgentById(s.agent.id)!.selectedSkills).toEqual(["deploy"]);

    const blank = await callTool(tools, "drop_skill", { slug: " " });
    expect(blank.isError).toBe(true);
    expect(blank.content[0].text).toContain("Name the skill");

    // Dropping the last one says so instead of printing an empty list.
    const last = await callTool(tools, "drop_skill", { slug: "deploy" });
    expect(last.content[0].text).toContain("no skills at all");
  });

  it("applies the same live gates update_profile does", async () => {
    const s = setup("skill-gates");
    connectSkillRepo(s.store, s.owner.id, "skill-gates-repo", ["code-review"]);
    const ctx = {
      agentId: s.agent.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      config: s.config,
    };
    const tools = buildPersonalAgentSelfTools(s.store, ctx);

    // Someone else's bot: refused without confirming anything about it.
    const foreign = buildPersonalAgentSelfTools(s.store, {
      ...ctx,
      owner: { id: s.plain.id, username: "plain", displayName: "일반" },
    });
    for (const name of ["adopt_skill", "drop_skill"]) {
      const res = await callTool(foreign, name, { slug: "code-review" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("belongs to a different user");
    }

    s.store.updatePersonalAgent(s.agent.id, { enabled: false });
    for (const name of ["adopt_skill", "drop_skill"]) {
      const res = await callTool(tools, name, { slug: "code-review" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("DISABLED");
    }

    s.store.updatePersonalAgent(s.agent.id, { enabled: true });
    s.store.setRole(s.owner.id, "admin", false);
    for (const name of ["adopt_skill", "drop_skill"]) {
      const res = await callTool(tools, name, { slug: "code-review" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("administrator-only feature");
    }

    s.store.setRole(s.owner.id, "admin", true);
    s.store.deletePersonalAgent(s.agent.id);
    for (const name of ["adopt_skill", "drop_skill"]) {
      const res = await callTool(tools, name, { slug: "code-review" });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("no longer exists");
    }
  });
});

// ===========================================================================
// describe_system (the metacognition mirror of the prompt branch)
// ===========================================================================
describe("describe_system for personal agents", () => {
  function systemTools(
    dir: string,
    opts: { plain?: boolean } = {},
    ctxOverrides: Record<string, unknown> = {},
  ) {
    const s = setup(dir, opts);
    const tools = buildSystemTools(s.store, {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      viewerIsOwner: true,
      config: s.config,
      ...ctxOverrides,
    });
    return { ...s, tools };
  }

  it("prints the bot block, then FALLS THROUGH to the owner state it runs with", async () => {
    const s = setup("desc-bot");
    const withBot = buildSystemTools(s.store, {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      viewerIsOwner: true,
      config: s.config,
      personalAgent: { agentId: s.agent.id, actingUserId: s.owner.id },
    });
    const res = await callTool(withBot, "describe_system", {});
    expect(res.isError).toBeFalsy();
    const body = res.content[0].text;
    expect(body).toContain("Current PERSONAL BOT (내 봇) state:");
    expect(body).toContain("릴리즈 봇");
    expect(body).toContain("Persona/instructions: NOT set");
    expect(body).toContain(`of ${MAX_PERSONAL_AGENTS} personal bots`);
    expect(body).toContain("mcp__personal_agent__update_profile");
    // Routines are AVAILABLE and SELF-SCOPED — the retired phase-1 wording must
    // be gone from both the bot block and the owner-state count line.
    expect(body).toContain("Scheduled routines: AVAILABLE");
    expect(body).toContain("SELF-SCOPED");
    expect(body).toContain("mcp__system__create_routine");
    expect(body).toContain("예약 작업");
    expect(body).not.toContain("Scheduled routines: UNAVAILABLE in this conversation");
    // …and the owner block still follows: a bot run HAS owner capability.
    expect(body).toContain("Current avatar state:");
    expect(body).toContain("Knowledge repository:");
    // The owner-avatar create trigger is NOT offered inside a bot thread.
    expect(body).not.toContain("mcp__personal_agent__create_agent");
    expect(body).not.toContain("NOT listable or manageable from this personal-bot conversation");
    expect(body).toContain("0 of them are YOURS");
  });

  it("reports the memory namespace and the granted-skill roster in the bot block", async () => {
    const s = setup("desc-memory");
    const bot = () =>
      buildSystemTools(s.store, {
        avatarUserId: s.owner.id,
        owner: { id: s.owner.id, username: "owner", displayName: "오너" },
        viewerIsOwner: true,
        config: s.config,
        personalAgent: { agentId: s.agent.id, actingUserId: s.owner.id },
      });
    const root = personalAgentMemoryRoot(s.agent.memoryDir);

    const body = (await callTool(bot(), "describe_system", {})).content[0].text;
    // The memory line names the SAME root that parameterizes the run's scoped
    // repo/brain servers (the both-consumers rule).
    expect(body).toContain(`- Memory: \`${root}/\` inside the owner's knowledge repository`);
    expect(body).toContain(`\`${root}/wiki/\` for curated notes`);
    expect(body).toContain(`\`${root}/CLAUDE.md\` for your standing memory`);
    expect(body).toContain("injected into every one of your turns");
    expect(body).toContain("SCOPED: mcp__brain__search and every mcp__repo__* path operation");
    expect(body).toContain("second brain (root wiki/raw) and your sibling bots' folders are NOT accessible");
    expect(body).toContain("mcp__repo__scaffold_skill/create_repo refuse");
    expect(body).toContain("a commit stages only your folder");
    // The capability line no longer claims the whole knowledge repository.
    expect(body).toContain("narrowed to your own memory folder plus the skills they granted you");
    expect(body).not.toContain(
      "you run with the owner's FULL avatar capability on their behalf (their knowledge repository",
    );
    // No grants yet.
    expect(body).toContain("- Skills granted by the owner: (none yet)");
    expect(body).toContain("mcp__personal_agent__adopt_skill");
    expect(body).toContain("takes effect from your NEXT conversation");

    s.store.updatePersonalAgent(s.agent.id, {
      selectedSkills: ["code-review", "pptx-report"],
    });
    const granted = (await callTool(bot(), "describe_system", {})).content[0].text;
    expect(granted).toContain("- Skills granted by the owner: code-review, pptx-report");
  });

  it("appends per-bot granted-skill counts to the OWNER's roster line", async () => {
    const s = systemTools("desc-roster-grants");
    s.store.updatePersonalAgent(s.agent.id, { selectedSkills: ["code-review"] });
    const body = (await callTool(s.tools, "describe_system", {})).content[0].text;
    expect(body).toContain("(enabled: 릴리즈 봇 (1 granted skill))");
    expect(body).toContain("a bot reaches its own memory folder (agents/<slug>/");
    expect(body).toContain("plus the skills the owner granted it");

    s.store.updatePersonalAgent(s.agent.id, { selectedSkills: [] });
    const none = (await callTool(s.tools, "describe_system", {})).content[0].text;
    expect(none).toContain("(enabled: 릴리즈 봇 (0 granted skills))");
  });

  it("counts the bot's OWN routines separately from the owner's on the state line", async () => {
    const s = setup("desc-routine-count");
    const withBot = buildSystemTools(s.store, {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      viewerIsOwner: true,
      config: s.config,
      personalAgent: { agentId: s.agent.id, actingUserId: s.owner.id },
    });
    s.store.createRoutineJob(s.owner.id, { prompt: "오너 루틴", minuteOfDay: 540 });
    s.store.createRoutineJob(s.owner.id, {
      prompt: "봇 루틴",
      minuteOfDay: 600,
      personalAgentId: s.agent.id,
    });
    const body = (await callTool(withBot, "describe_system", {})).content[0].text;
    // The count line reports the owner's WHOLE roster, then names the bot's share
    // — the two numbers the self-scoped list tool actually returns.
    expect(body).toContain("- Routines: 2 (2 enabled)");
    expect(body).toContain("1 of them are YOURS");
  });

  it("fails closed on a disabled bot, a demoted owner, and a foreign actor", async () => {
    const s = setup("desc-closed");
    const tools = buildSystemTools(s.store, {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      viewerIsOwner: true,
      config: s.config,
      personalAgent: { agentId: s.agent.id, actingUserId: s.owner.id },
    });
    s.store.updatePersonalAgent(s.agent.id, { enabled: false });
    const disabled = await callTool(tools, "describe_system", {});
    expect(disabled.content[0].text).toContain(
      "Current PERSONAL BOT (내 봇) state: UNAVAILABLE.",
    );
    expect(disabled.content[0].text).toContain("was disabled by its owner");
    // The leaky owner half is gone.
    expect(disabled.content[0].text).not.toContain("Current avatar state:");

    s.store.updatePersonalAgent(s.agent.id, { enabled: true });
    s.store.setRole(s.owner.id, "admin", false);
    const demoted = await callTool(tools, "describe_system", {});
    expect(demoted.content[0].text).toContain("UNAVAILABLE.");
    expect(demoted.content[0].text).toContain("no longer holds the admin role");

    // A foreign acting user can learn nothing about the bot.
    const foreign = buildSystemTools(s.store, {
      avatarUserId: s.plain.id,
      owner: { id: s.plain.id, username: "plain", displayName: "일반" },
      viewerIsOwner: true,
      config: s.config,
      personalAgent: { agentId: s.agent.id, actingUserId: s.plain.id },
    });
    const notMine = await callTool(foreign, "describe_system", {});
    expect(notMine.content[0].text).toContain("UNAVAILABLE.");
    expect(notMine.content[0].text).toContain("does not belong to the person");
    expect(notMine.content[0].text).not.toContain("릴리즈 봇");
  });

  it("adds the roster line to the OWNER's own avatar only when the feature is on", async () => {
    const admin = systemTools("desc-roster");
    const res = await callTool(admin.tools, "describe_system", {});
    const body = res.content[0].text;
    expect(body).toContain("Personal bots (내 봇):");
    expect(body).toContain(`1 of ${MAX_PERSONAL_AGENTS} created`);
    expect(body).toContain("릴리즈 봇");
    expect(body).toContain("mcp__personal_agent__create_agent");

    const plain = systemTools("desc-roster-plain", { plain: true });
    const plainBody = (await callTool(plain.tools, "describe_system", {})).content[0].text;
    expect(plainBody).not.toContain("Personal bots (내 봇):");
    expect(plainBody).not.toContain("mcp__personal_agent__create_agent");
  });

  it("summarizePersonalAgentState fails closed for a foreign actor and a missing bot", () => {
    const { store, agent, owner, plain } = setup("summarize");
    expect(summarizePersonalAgentState(store, agent.id, owner.id)).toMatchObject({
      agentId: agent.id,
      displayName: "릴리즈 봇",
      alias: "릴봇",
      personaSet: false,
      enabled: true,
      ownerIsAdmin: true,
      agentCount: 1,
      maxAgents: MAX_PERSONAL_AGENTS,
    });
    expect(summarizePersonalAgentState(store, agent.id, plain.id)).toBeNull();
    expect(summarizePersonalAgentState(store, "ghost", owner.id)).toBeNull();
    store.setRole(owner.id, "admin", false);
    expect(summarizePersonalAgentState(store, agent.id, owner.id)?.ownerIsAdmin).toBe(
      false,
    );
  });

  it("counts the delegated backlog of THIS thread, and only when given one", () => {
    const { store, agent, owner } = setup("queued-count");
    const seed = (conversationId: string) =>
      store.createBotTask({
        ownerUserId: owner.id,
        agentId: agent.id,
        conversationId,
        title: "대기",
        requestText: "나중에",
        status: "queued",
      });
    seed("conv-1");
    seed("conv-1");
    seed("conv-2");
    const count = (conversationId?: string) =>
      summarizePersonalAgentState(store, agent.id, owner.id, conversationId)
        ?.queuedTaskCount;
    expect(count("conv-1")).toBe(2);
    expect(count("conv-2")).toBe(1);
    // No thread in hand → 0, never another conversation's backlog.
    expect(count()).toBe(0);
    // A dispatched task leaves the queue.
    store.markBotTaskRunning(store.nextQueuedBotTask("conv-1")!.id, "run-1");
    expect(count("conv-1")).toBe(1);
  });

  it("reports the delegated-task state, the backlog, and the question protocol", async () => {
    const s = setup("desc-task");
    s.store.createBotTask({
      ownerUserId: s.owner.id,
      agentId: s.agent.id,
      conversationId: "conv-1",
      title: "대기",
      requestText: "나중에",
      status: "queued",
    });
    const ctx = {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      viewerIsOwner: true,
      config: s.config,
    };
    const tracked = buildSystemTools(s.store, {
      ...ctx,
      personalAgent: {
        agentId: s.agent.id,
        actingUserId: s.owner.id,
        taskId: "task-1",
        conversationId: "conv-1",
      },
    });
    const body = (await callTool(tracked, "describe_system", {})).content[0].text;
    expect(body).toContain("Delegated task: this turn IS tracked as a delegated task");
    expect(body).toContain("Queued behind this turn: 1 delegated request(s)");
    expect(body).toContain("never try to run them yourself");
    expect(body).toContain("mcp__personal_agent__report_task");
    expect(body).toContain("AskUserQuestion dialog is DENIED");

    // An untracked turn says so, rather than leaving the model to discover it.
    const untracked = buildSystemTools(s.store, {
      ...ctx,
      personalAgent: { agentId: s.agent.id, actingUserId: s.owner.id },
    });
    const plainBody = (await callTool(untracked, "describe_system", {})).content[0].text;
    expect(plainBody).toContain("is NOT tracked as a delegated task");
    // No conversation id → the backlog reads 0 instead of another thread's.
    expect(plainBody).toContain("Queued behind this turn: 0 delegated request(s)");
    expect(plainBody).not.toContain("never try to run them yourself");
  });
});

// ===========================================================================
// Routine tools inside a bot thread: available, but SELF-SCOPED
// ===========================================================================
describe("routine tools in a personal-bot conversation", () => {
  function routineTools(dir: string) {
    const s = setup(dir);
    const ctx = {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: "owner", displayName: "오너" },
      viewerIsOwner: true,
      config: s.config,
    };
    // The same store seen through the BOT's tools and through the owner's own
    // main-avatar tools — the two scopes this feature has to keep apart.
    return {
      ...s,
      bot: buildSystemTools(s.store, {
        ...ctx,
        personalAgent: { agentId: s.agent.id, actingUserId: s.owner.id },
      }),
      main: buildSystemTools(s.store, ctx),
    };
  }

  it("binds a bot-created routine to the bot and to a composite thread", async () => {
    const { store, owner, agent, bot } = routineTools("routine-create-bot");
    const res = await callTool(bot, "create_routine", {
      prompt: "매일 아침 뉴스 정리",
      name: "아침 브리핑",
      scheduleKind: "daily",
      time: "07:30",
    });
    expect(res.isError).toBeFalsy();
    const [job] = store.listRoutineJobs(owner.id);
    // The ROW keeps the OWNER's uuid (it is every capability key) plus the bot
    // binding; the dedicated thread belongs to the BOT's composite avatar id.
    expect(job.avatarUserId).toBe(owner.id);
    expect(job.personalAgentId).toBe(agent.id);
    expect(store.getConversationAvatarId(owner.id, job.conversationId)).toBe(
      personalAgentAvatarId(owner.id, agent.id),
    );
    // The success text is an action trigger, not a bare confirmation: it names
    // the identity the routine fires as, the thread, and the owner's board.
    const body = res.content[0].text;
    expect(body).toContain("fires AS THIS BOT");
    expect(body).toContain("예약 작업");
    expect(body).toContain("봇 오피스");
    expect(body).toContain('bot="릴리즈 봇" (bot-bound)');
  });

  it("leaves a routine the owner's MAIN avatar creates unbound", async () => {
    const { store, owner, main } = routineTools("routine-create-main");
    const res = await callTool(main, "create_routine", {
      prompt: "주간 회고",
      time: "09:00",
    });
    expect(res.isError).toBeFalsy();
    const [job] = store.listRoutineJobs(owner.id);
    expect(job.personalAgentId).toBeNull();
    expect(store.getConversationAvatarId(owner.id, job.conversationId)).toBe(owner.id);
    expect(res.content[0].text).not.toContain("(bot-bound)");
    expect(res.content[0].text).not.toContain("fires AS THIS BOT");
  });

  it("self-scopes list_routines to the bot, leaving the main avatar whole", async () => {
    const { store, owner, agent, bot, main } = routineTools("routine-list");
    store.createRoutineJob(owner.id, { prompt: "오너 루틴", name: "오너", minuteOfDay: 540 });
    // The owner's routine is not the bot's: an empty listing, not a leak.
    const empty = await callTool(bot, "list_routines", {});
    expect(empty.isError).toBeFalsy();
    expect(empty.content[0].text).toBe("This bot has no scheduled routines yet.");

    store.createRoutineJob(owner.id, {
      prompt: "봇 루틴",
      name: "봇",
      minuteOfDay: 600,
      personalAgentId: agent.id,
    });
    const mine = await callTool(bot, "list_routines", {});
    expect(mine.content[0].text).toContain("1 registered routine(s)");
    expect(mine.content[0].text).toContain('name="봇"');
    expect(mine.content[0].text).not.toContain('name="오너"');

    // The owner's main avatar keeps the whole list and names the bot behind each
    // bound row — it is their management surface for every routine.
    const all = await callTool(main, "list_routines", {});
    expect(all.content[0].text).toContain("2 registered routine(s)");
    expect(all.content[0].text).toContain('name="오너"');
    expect(all.content[0].text).toContain('bot="릴리즈 봇" (bot-bound)');
  });

  it("renders a vanished binding by id instead of inventing a name", async () => {
    const { store, owner, main } = routineTools("routine-orphan");
    store.createRoutineJob(owner.id, {
      prompt: "고아 루틴",
      minuteOfDay: 540,
      personalAgentId: "ghost-bot",
    });
    const body = (await callTool(main, "list_routines", {})).content[0].text;
    expect(body).toContain('bot="ghost-bot" (bot-bound)');
  });

  it("refuses cross-identity update/delete from a bot, accepts its own", async () => {
    const { store, owner, agent, bot, main } = routineTools("routine-scope");
    const ownerJob = store.createRoutineJob(owner.id, { prompt: "오너 루틴", minuteOfDay: 540 });
    const otherBot = store.createPersonalAgent(owner.id, { displayName: "다른 봇" });
    const otherJob = store.createRoutineJob(owner.id, {
      prompt: "다른 봇 루틴",
      minuteOfDay: 570,
      personalAgentId: otherBot.id,
    });
    const mine = store.createRoutineJob(owner.id, {
      prompt: "내 루틴",
      minuteOfDay: 600,
      personalAgentId: agent.id,
    });

    for (const id of [ownerJob.id, otherJob.id]) {
      const updated = await callTool(bot, "update_routine", { id, enabled: false });
      expect(updated.isError).toBe(true);
      expect(updated.content[0].text).toContain("does not belong to this bot");
      expect(updated.content[0].text).toContain("예약 작업");
      const deleted = await callTool(bot, "delete_routine", { id });
      expect(deleted.isError).toBe(true);
      expect(deleted.content[0].text).toContain("does not belong to this bot");
    }
    // A refusal is a NO-OP, not a partial write.
    expect(store.getRoutineJob(owner.id, ownerJob.id)?.enabled).toBe(true);
    expect(store.getRoutineJob(owner.id, otherJob.id)?.enabled).toBe(true);

    const ok = await callTool(bot, "update_routine", { id: mine.id, name: "새 이름" });
    expect(ok.isError).toBeFalsy();
    expect(store.getRoutineJob(owner.id, mine.id)?.name).toBe("새 이름");
    const gone = await callTool(bot, "delete_routine", { id: mine.id });
    expect(gone.isError).toBeFalsy();
    expect(store.getRoutineJob(owner.id, mine.id)).toBeNull();

    // The owner's main avatar manages EVERY routine, bot-bound ones included.
    const adopted = await callTool(main, "update_routine", { id: otherJob.id, enabled: false });
    expect(adopted.isError).toBeFalsy();
    expect(store.getRoutineJob(owner.id, otherJob.id)?.enabled).toBe(false);
    const removed = await callTool(main, "delete_routine", { id: otherJob.id });
    expect(removed.isError).toBeFalsy();
    expect(store.getRoutineJob(owner.id, otherJob.id)).toBeNull();

    // An unknown id stays a plain not-found on both surfaces (no existence probe).
    const missing = await callTool(bot, "delete_routine", { id: "ghost" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toBe("Routine not found.");
  });
});

// ===========================================================================
// Prompt branch
// ===========================================================================
describe("personal-agent prompt branch", () => {
  const state = (over: Partial<PersonalAgentState> = {}): PersonalAgentState => ({
    agentId: "a1",
    ownerUserId: "u1",
    displayName: "릴리즈 봇",
    alias: "릴봇",
    personaSet: false,
    enabled: true,
    ownerIsAdmin: true,
    agentCount: 3,
    maxAgents: MAX_PERSONAL_AGENTS,
    queuedTaskCount: 0,
    // What runPlan hands the prompt: the bot's own memory namespace + the skills
    // the owner granted it (empty = none, the shipped default).
    memoryRoot: "agents/release-bot-a1b2c3d4",
    adoptedSkills: [],
    ...over,
  });
  const req = (over: Partial<AgentRequest> = {}): AgentRequest => ({
    message: "안녕",
    // The OWNER's avatar, as the A-1 rule requires — the identity below must
    // still come out as the BOT's.
    avatar: { id: "u1", displayName: "오너", alias: "노아", persona: "" },
    viewerIsOwner: true,
    viewerName: "오너",
    knowledgeRepoConfigured: true,
    gitTokenSet: true,
    personalAgentState: state(),
    ...over,
  });

  it("speaks as the BOT, not as the owner's own avatar", () => {
    const p = buildPrompt(req(), 0);
    expect(p).toContain('Your name is "릴봇"');
    expect(p).not.toContain('Your name is "노아"');
    expect(p).toContain('You are **"릴봇"**');
    expect(p).toContain("personal bots");
    expect(p).toContain(`3 of ${MAX_PERSONAL_AGENTS} bots`);
    // Still an owner turn: the owner line and owner capability guidance follow.
    expect(p).toContain('this avatar\'s **owner**, "오너"');
  });

  it("falls back to the bot's display name when it has no alias", () => {
    const p = buildPrompt(req({ personalAgentState: state({ alias: "" }) }), 0);
    expect(p).toContain('You are **"릴리즈 봇"**');
    expect(p).not.toContain('Your name is "노아"');
  });

  it("carries the ENFORCED memory namespace, the self-scheduling trigger, and the self-config trigger", () => {
    const p = buildPrompt(req(), 0);
    // The namespace is what the scoped repo/brain servers actually enforce, so
    // the prompt names the real root — not the old "pick your own slug" prose.
    expect(p).toContain("**Your memory** lives at `agents/release-bot-a1b2c3d4/`");
    expect(p).toContain("`agents/release-bot-a1b2c3d4/wiki/` for curated, durable notes");
    expect(p).toContain("`agents/release-bot-a1b2c3d4/raw/` for unprocessed captures");
    expect(p).toContain(
      "`agents/release-bot-a1b2c3d4/CLAUDE.md` for your STANDING memory",
    );
    expect(p).toContain("injected into every one of your turns");
    expect(p).toContain("are SCOPED to that folder");
    expect(p).toContain("sibling bots' folders are neither readable nor writable");
    expect(p).not.toContain("agents/<your-slug>/");
    expect(p).not.toContain("choose one stable ASCII kebab-case slug");
    // Standing guidance, not a refusal: the bot schedules its OWN recurring work
    // and knows the firings arrive as delegated tasks.
    expect(p).toContain("You can schedule your OWN recurring work");
    expect(p).toContain("매일 아침 뉴스 정리해줘");
    expect(p).toContain("confirm the exact schedule wording");
    expect(p).toContain("mcp__system__create_routine");
    expect(p).toContain("report_task protocol applies");
    expect(p).toContain("self-scoped");
    expect(p).toContain("예약 작업");
    // The retired phase-1 refusal must be gone.
    expect(p).not.toContain("Scheduled routines do NOT work in this conversation");
    expect(p).toContain("mcp__personal_agent__update_profile");
    expect(p).toContain("CONFIRM the exact wording");
    expect(p).toContain("Your persona is currently NOT set");
  });

  it("drops the memory namespace when there is no repository to write it in", () => {
    const p = buildPrompt(req({ knowledgeRepoConfigured: false }), 0);
    expect(p).toContain('You are **"릴봇"**');
    expect(p).not.toContain("**Your memory** lives at");
    expect(p).not.toContain("agents/release-bot-a1b2c3d4/");
    // The adopt/drop trigger needs a repository to hold the skills, but the
    // roster itself is still a fact about what loads.
    expect(p).toContain("**Skills the owner granted you**: none granted yet");
    expect(p).not.toContain("mcp__personal_agent__adopt_skill");
    expect(p).toContain("설정 → 내 봇");
  });

  it("states the SCOPED capability, not full knowledge-repository access", () => {
    const p = buildPrompt(req(), 0);
    expect(p).toContain(
      "You act with your owner's capability on their behalf: their secrets, git repositories, plugins, and group knowledge are all yours this turn",
    );
    expect(p).toContain(
      "The ONE narrowing is their personal knowledge repository: what you reach there is your own memory folder plus the skills they granted you, not the whole repository.",
    );
    // The old blanket claim must be gone — it is no longer true.
    expect(p).not.toContain(
      "their knowledge repository, secrets, git repositories, and plugins are all yours",
    );
  });

  it("lists the granted skills with the adopt/drop triggers and next-conversation semantics", () => {
    const none = buildPrompt(req(), 0);
    expect(none).toContain("**Skills the owner granted you**: none granted yet");
    const granted = buildPrompt(
      req({ personalAgentState: state({ adoptedSkills: ["code-review", "pptx"] }) }),
      0,
    );
    expect(granted).toContain(
      "**Skills the owner granted you**: `code-review`, `pptx`",
    );
    expect(granted).toContain("mcp__personal_agent__adopt_skill");
    expect(granted).toContain("mcp__personal_agent__drop_skill");
    expect(granted).toContain("applies from your NEXT conversation, not this turn");
    expect(granted).toContain("The owner grants and revokes these themselves under 설정 → 내 봇.");
  });

  it("scopes the second-brain section to the bot's own memory and drops brain-migrate", () => {
    const p = buildPrompt(req(), 0);
    expect(p).toContain("**Your memory**: `agents/release-bot-a1b2c3d4/wiki/` holds your curated");
    expect(p).toContain("`agents/release-bot-a1b2c3d4/raw/` your unprocessed captures");
    // The search-before-answering directive survives the scoping.
    expect(p).toContain("mcp__brain__search");
    expect(p).toContain("BEFORE answering from memory");
    // brain-migrate seeds the ROOT vault, outside this run's scope; the
    // brain-ingest/reflect/lint skills write there too.
    expect(p).not.toContain("brain-migrate");
    expect(p).not.toContain("brain-ingest");
    expect(p).not.toContain("brain-reflect");
    // No root-vault paths: the owner's own vault is not this bot's.
    expect(p).not.toContain("**Second brain**: your knowledge repository is a vault");
    // The bot writes its own wiki/, so the current-truth convention applies.
    expect(p).toContain("states the CURRENT truth only");
  });

  it("never speaks a persona the bot does not have", () => {
    // What the chat route actually delivers for a persona-less bot: it overlays
    // the identity fields with `??`, so an EMPTY bot persona arrives as "" and
    // never inherits the owner's (routes/chat.ts, pinned on that side too).
    const emptyOverlay = buildPrompt(
      req({ avatar: { id: "u1", displayName: "빈 봇", alias: "", persona: "" } }),
      0,
    );
    expect(emptyOverlay).not.toContain("Persona/instructions:");
    expect(emptyOverlay).toContain('You are **"릴봇"**');

    // Belt and braces on the same outcome: even if a non-empty persona reached
    // this field, a bot whose own personaSet is false must not recite it.
    const withoutPersona = buildPrompt(
      req({
        avatar: { id: "u1", displayName: "오너", alias: "노아", persona: "나는 오너의 아바타다" },
      }),
      0,
    );
    expect(withoutPersona).not.toContain("Persona/instructions:");
    expect(withoutPersona).not.toContain("나는 오너의 아바타다");

    const withPersona = buildPrompt(
      req({
        avatar: { id: "u1", displayName: "오너", alias: "노아", persona: "릴리즈 노트만 쓴다" },
        personalAgentState: state({ personaSet: true }),
      }),
      0,
    );
    expect(withPersona).toContain("Persona/instructions:\n릴리즈 노트만 쓴다");
    expect(withPersona).toContain("Your persona is currently SET");
  });

  it("adds the delegated-task paragraph only when the turn tracks a task", () => {
    const tracked = buildPrompt(
      req({
        personalAgent: { agentId: "a1", ownerUserId: "u1", taskId: "task-1" },
      }),
      0,
    );
    expect(tracked).toContain("**This turn is tracked as a delegated task**");
    expect(tracked).toContain("the owner may be away");
    expect(tracked).toContain("mcp__personal_agent__report_task");
    expect(tracked).toContain("Never use the AskUserQuestion dialog in this conversation");
    // No backlog on this thread → no queue sentence at all.
    expect(tracked).not.toContain("queued behind this one");

    // Same bot, untracked turn (a greeting): the paragraph stays out, so the
    // bot never reports against a card that does not exist.
    const untracked = buildPrompt(
      req({ personalAgent: { agentId: "a1", ownerUserId: "u1" } }),
      0,
    );
    expect(untracked).toContain('You are **"릴봇"**');
    expect(untracked).not.toContain("**This turn is tracked as a delegated task**");
    expect(untracked).not.toContain("mcp__personal_agent__report_task");
  });

  it("names the backlog waiting behind a delegated turn", () => {
    const p = buildPrompt(
      req({
        personalAgent: { agentId: "a1", ownerUserId: "u1", taskId: "task-1" },
        personalAgentState: state({ queuedTaskCount: 2 }),
      }),
      0,
    );
    expect(p).toContain("2 more delegated request(s) are queued behind this one");
    expect(p).toContain("the server dispatches the queue automatically, never you");
  });

  it("keeps getting-started and the create trigger OUT of a bot thread", () => {
    const p = buildPrompt(
      req({ knowledgeRepoConfigured: false, gitTokenSet: false }),
      0,
    );
    expect(p).not.toContain("this owner's setup is still incomplete");
    // create_agent belongs to the owner's own avatar; a bot never offers it.
    expect(p).not.toContain("mcp__personal_agent__create_agent");
  });

  it("gives the OWNER's own avatar the create trigger, gated on the registration flag", () => {
    const owner = buildPrompt(
      req({
        personalAgentState: null,
        personalAgentsEnabled: true,
        personalAgentNames: ["릴리즈 봇", "회의록 봇"],
      }),
      0,
    );
    expect(owner).toContain("**Personal bots (내 봇)**");
    expect(owner).toContain("2 enabled: 릴리즈 봇, 회의록 봇");
    expect(owner).toContain("mcp__personal_agent__create_agent");
    expect(owner).toContain("설정 → 내 봇");
    // The bot identity block stays out of a non-bot run.
    expect(owner).not.toContain('You are **"릴봇"**');

    // Feature off for this owner → no mention of a tool the run lacks.
    const plain = buildPrompt(req({ personalAgentState: null }), 0);
    expect(plain).not.toContain("**Personal bots (내 봇)**");
    expect(plain).not.toContain("mcp__personal_agent__create_agent");
  });
});
