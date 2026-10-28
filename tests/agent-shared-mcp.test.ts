import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentEvents } from "../src/server/agent/events.js";
import type { AgentRequest, SharedMcpServer } from "../src/server/types.js";
import { callTool, withTempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// 공용 MCP 서버 through a REAL run plan: tool() / createSdkMcpServer stay real
// (recorded, so describe_system can be called), query() only snapshots options.
// ---------------------------------------------------------------------------
type QueryArgs = { prompt: unknown; options: Record<string, unknown> };

const sdkMock = vi.hoisted(() => ({
  calls: [] as QueryArgs[],
  /** Optional per-test hook run at spawn time; throwing fails that attempt. */
  impl: null as null | (() => unknown),
  servers: [] as {
    name: string;
    tools: { name: string; handler: (args: unknown, extra: unknown) => unknown }[];
  }[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const createSdkMcpServer = actual.createSdkMcpServer as (opts: Record<string, unknown>) => unknown;
  return {
    ...actual,
    createSdkMcpServer: (opts: Record<string, unknown> & { name: string; tools?: { name: string; handler: (a: unknown, e: unknown) => unknown }[] }) => {
      sdkMock.servers.push({ name: opts.name, tools: opts.tools ?? [] });
      return createSdkMcpServer(opts);
    },
    query: (args: QueryArgs) => {
      sdkMock.calls.push({ prompt: args.prompt, options: { ...args.options } });
      sdkMock.impl?.();
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "s1", model: "opus" };
        yield { type: "result", subtype: "success", result: "ok" };
      }
      return gen();
    },
  };
});

import { createServices } from "../src/server/app.js";
import { runAgentStream } from "../src/server/agent/index.js";

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
  };
}

let tempDir: string;
const getTempDir = withTempDir("agent-shared-mcp", () => {
  tempDir = getTempDir();
  sdkMock.calls.length = 0;
  sdkMock.servers.length = 0;
  sdkMock.impl = null;
});

const JIRA: SharedMcpServer = {
  name: "jira",
  label: "사내 Jira",
  description: "Search and update Jira issues",
  url: "https://jira.example.com/mcp",
  transport: "http",
  headers: {},
  secretSlots: [{ id: "token", label: "API 토큰", header: "Authorization", format: "Bearer {secret}" }],
  enabled: true,
  updatedAt: "2026-10-26T00:00:00.000Z",
};
const DOCS: SharedMcpServer = {
  ...JIRA,
  name: "docs",
  label: "Docs",
  description: "Public product docs",
  url: "https://docs.example.com/mcp",
  secretSlots: [],
};

/** The owner stores a secret AND binds it to jira's slot (both are needed). */
function bindJira(env: ReturnType<typeof setup>, value = "jira-secret-value-1") {
  env.store.setUserSecret(env.owner.id, "JIRA_TOKEN", value);
  env.store.setSharedMcpBinding(env.owner.id, {
    serverName: "jira",
    slotId: "token",
    secretName: "JIRA_TOKEN",
    origin: "https://jira.example.com",
  });
}

function setup() {
  const { config, store } = createServices({
    dataDir: tempDir,
    agentRuntime: "claude",
    sessionSecret: "test",
    anthropicModel: undefined,
    anthropicApiKey: undefined,
  });
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  const cwd = path.join(tempDir, "ws");
  fs.mkdirSync(cwd, { recursive: true });
  store.setSharedMcpServers([JIRA, DOCS, { ...DOCS, name: "off", label: "Off", enabled: false }]);
  const ownerRequest: AgentRequest = {
    message: "안녕하세요",
    avatar: { id: owner.id, displayName: "Owner", alias: "노아", persona: "" },
    conversationId: "conv-1",
    cwd,
    viewerUserId: owner.id,
    viewerName: "Owner",
    viewerIsOwner: true,
    autoApprove: true,
  };
  return { config, store, owner, ownerRequest };
}

/** The definitions the CLI receives in --mcp-config argv (in-process sdk servers never leave). */
function argvServers(servers: Record<string, Record<string, unknown>>): string {
  return JSON.stringify(Object.values(servers).filter((def) => def.type !== "sdk"));
}

async function run(request: AgentRequest, env: ReturnType<typeof setup>) {
  await runAgentStream(request, [], env.config, env.store, makeEvents());
  const { options } = sdkMock.calls.at(-1)!;
  const system = sdkMock.servers.filter((server) => server.name === "system").at(-1)!;
  const describe = await callTool(system.tools, "describe_system", {});
  return {
    servers: options.mcpServers as Record<string, Record<string, unknown>>,
    append: (options.systemPrompt as { append: string }).append,
    describe: describe.content[0].text,
    hooks: options.hooks as { PostToolUse?: unknown[] } | undefined,
  };
}

describe("공용 MCP 서버 in a run", () => {
  it("owner with the secret: bridged registration, no value in the def, both surfaces say available", async () => {
    const env = setup();
    bindJira(env);
    // Capture the handoff file as the spawned CLI would see it (it is removed at run end).
    const spawned = { mode: "", content: "" };
    sdkMock.impl = () => {
      const dir = path.join(tempDir, "runtime", "mcp-secrets");
      const file = fs.readdirSync(dir).find((name) => name.startsWith("shared-"))!;
      spawned.mode = (fs.statSync(path.join(dir, file)).mode & 0o777).toString(8);
      spawned.content = fs.readFileSync(path.join(dir, file), "utf8");
    };
    const { servers, append, describe, hooks } = await run(env.ownerRequest, env);

    const jira = servers.jira;
    expect(jira).toMatchObject({ type: "stdio", command: process.execPath });
    const args = jira.args as string[];
    expect(args[0]).toBe("--use-system-ca");
    expect(args[1]).toMatch(/scripts[\\/]mcp-http-bridge\.mjs$/);
    expect(argvServers(servers)).not.toContain("jira-secret-value-1");
    expect(args[args.indexOf("--config") + 1]).toMatch(/shared-.*-jira\.json$/);
    expect(spawned.mode).toBe("600");
    expect(JSON.parse(spawned.content)).toEqual({
      url: "https://jira.example.com/mcp",
      transport: "http",
      headers: { Authorization: "Bearer jira-secret-value-1" },
      redact: ["jira-secret-value-1"],
    });
    // Header-less server: registered natively; disabled one: nowhere.
    expect(servers.docs).toEqual({ type: "http", url: "https://docs.example.com/mcp" });
    expect(servers.off).toBeUndefined();

    for (const surface of [append, describe]) {
      expect(surface).toContain("`jira` (사내 Jira) — Search and update Jira issues: available in this run as `mcp__jira__*`.");
      expect(surface).toContain("`docs` (Docs) — Public product docs: available in this run as `mcp__docs__*`.");
      expect(surface).not.toContain("`off`");
    }
    // A bridged vault value joins the redaction set.
    expect(hooks?.PostToolUse?.length).toBeGreaterThan(0);
  });

  it("owner who has the secret but never bound it: left out — an admin cannot pull a secret by name", async () => {
    const env = setup();
    env.store.setUserSecret(env.owner.id, "JIRA_TOKEN", "jira-secret-value-1");
    const { servers, append, describe } = await run(env.ownerRequest, env);
    expect(servers.jira).toBeUndefined();
    expect(servers.docs).toBeDefined();
    for (const surface of [append, describe]) {
      expect(surface).toContain('NOT available in this run — the owner has not connected a secret to "API 토큰".');
      expect(surface).toContain("Settings → 권한·연결 → 시크릿");
    }
  });

  it("owner whose bound secret was for the server's OLD address: told to reconnect", async () => {
    const env = setup();
    bindJira(env);
    env.store.setSharedMcpServers([{ ...JIRA, url: "https://moved.example.net/mcp" }]);
    const { servers, append, describe } = await run(env.ownerRequest, env);
    expect(servers.jira).toBeUndefined();
    for (const surface of [append, describe]) {
      expect(surface).toContain("the admin moved it to a new address since the owner connected a secret");
    }
  });

  it("plain colleague: the secret-needing server never registers, even with the owner's secret set", async () => {
    const env = setup();
    bindJira(env);
    const colleague = env.store.createUser({ username: "colleague", displayName: "Colleague", password: "password123" });
    const { servers, append, describe } = await run(
      { ...env.ownerRequest, viewerUserId: colleague.id, viewerName: "Colleague", viewerIsOwner: false, elevated: false },
      env,
    );
    expect(servers.jira).toBeUndefined();
    expect(servers.docs).toBeDefined();
    expect(argvServers(servers)).not.toContain("jira-secret-value-1");
    const secretsDir = path.join(tempDir, "runtime", "mcp-secrets");
    const written = fs.existsSync(secretsDir) ? fs.readdirSync(secretsDir) : [];
    expect(written.filter((file) => file.startsWith("shared-"))).toEqual([]);
    for (const surface of [append, describe]) {
      expect(surface).toContain("`jira` (사내 Jira) — Search and update Jira issues: NOT available in this conversation — it authenticates with personal secrets from a user's own vault, which this kind of run never carries.");
    }
  });

  it("trusted teammate: uses the owner's bound secret; an unbound slot is reported without its name", async () => {
    const env = setup();
    const mate = env.store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
    const mateRequest = { ...env.ownerRequest, viewerUserId: mate.id, viewerName: "Mate", viewerIsOwner: false, elevated: true };
    // The TEAMMATE's own binding never counts — the run uses the avatar owner's.
    env.store.setUserSecret(mate.id, "JIRA_TOKEN", "mate-secret-value-1");
    env.store.setSharedMcpBinding(mate.id, { serverName: "jira", slotId: "token", secretName: "JIRA_TOKEN", origin: "https://jira.example.com" });

    const missing = await run(mateRequest, env);
    expect(missing.servers.jira).toBeUndefined();
    for (const surface of [missing.append, missing.describe]) {
      expect(surface).toContain("`jira` (사내 Jira) — Search and update Jira issues: NOT available in this conversation — the avatar owner has not connected a secret to it.");
      expect(surface).not.toContain("API 토큰");
    }

    bindJira(env);
    const present = await run(mateRequest, env);
    expect(present.servers.jira).toMatchObject({ type: "stdio" });
  });

  it("rewrites the one-shot handoff files before EVERY attempt, and never writes a shadowed server's file", async () => {
    const env = setup();
    bindJira(env);
    // An owned plugin http server that the admin `jira` server shadows, and a
    // second one that stays registered through the bridge.
    const root = path.join(tempDir, "plugins", env.owner.id, "repo");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        jira: { type: "http", url: "https://other.example.com/mcp", headers: { Authorization: "Bearer ${JIRA_TOKEN}" } },
        corp: { type: "http", url: "https://corp.example.com/mcp", headers: { "X-Api-Key": "${JIRA_TOKEN}" } },
      }),
    );
    const secretsDir = path.join(tempDir, "runtime", "mcp-secrets");
    const seen: string[][] = [];
    // Each attempt: record the handoff files present at spawn, then CONSUME
    // them the way the bridge does; the first attempt fails over to the next model.
    sdkMock.impl = () => {
      const files = fs.readdirSync(secretsDir).sort();
      seen.push(files);
      for (const file of files) fs.rmSync(path.join(secretsDir, file));
      if (seen.length === 1) throw Object.assign(new Error("overloaded"), { status: 529 });
    };
    await runAgentStream(
      { ...env.ownerRequest, headless: true, allowHeadlessTools: true, modelFallback: true },
      [{ type: "local", path: root }],
      env.config,
      env.store,
      makeEvents(),
    ).catch(() => {});
    sdkMock.impl = null;
    // The fallback attempt respawned with every live file present again.
    expect(seen.length).toBe(2);
    for (const files of seen) {
      expect(files.some((file) => file.startsWith("shared-") && file.endsWith("-jira.json"))).toBe(true);
      expect(files.some((file) => file.startsWith("http-") && file.endsWith("-corp.json"))).toBe(true);
      // The shadowed plugin `jira` never spawns — its resolved file is never written.
      expect(files.some((file) => file.startsWith("http-") && file.endsWith("-jira.json"))).toBe(false);
    }
  });

  it("redacts an admin's LITERAL credential header from tool output, even on a plain colleague run", async () => {
    const env = setup();
    env.store.setSharedMcpServers([
      {
        ...DOCS,
        name: "static",
        headers: {
          "X-Api-Key": "static-admin-key-123",
          Authorization: "Bearer bare-static-token-9",
          "X-Team": "quality-assurance",
          // Name looks credential-ish only to a loose match; never shredded.
          "X-Session-Mode": "stateless-mode",
        },
      },
    ]);
    const colleague = env.store.createUser({ username: "colleague", displayName: "Colleague", password: "password123" });
    await runAgentStream(
      { ...env.ownerRequest, viewerUserId: colleague.id, viewerName: "Colleague", viewerIsOwner: false, elevated: false },
      [],
      env.config,
      env.store,
      makeEvents(),
    );
    const { options } = sdkMock.calls.at(-1)!;
    expect((options.mcpServers as Record<string, Record<string, unknown>>).static.type).toBe("stdio");
    const hooks = options.hooks as { PostToolUse?: { hooks: ((input: unknown) => Promise<unknown>)[] }[] };
    expect(hooks.PostToolUse?.length).toBe(1);
    const result = (await hooks.PostToolUse![0].hooks[0]({
      tool_response: { stdout: "echo: static-admin-key-123 team quality-assurance tok=bare-static-token-9 mode=stateless-mode" },
    })) as { hookSpecificOutput?: { updatedToolOutput?: { stdout: string } } };
    const out = result.hookSpecificOutput!.updatedToolOutput!.stdout;
    expect(out).toContain("[REDACTED:static:X-Api-Key]");
    expect(out).not.toContain("static-admin-key-123");
    // A remote echoing only the token part of `Bearer <tok>` is caught too.
    expect(out).not.toContain("bare-static-token-9");
    expect(out).toContain("stateless-mode");
    // A non-credential header is not shredded out of unrelated output.
    expect(out).toContain("quality-assurance");
  });

  it.each([
    ["a restricted headless run (intro/hashtag generation)", { headless: true, allowHeadlessTools: false }],
    ["an avatar consultation", { headless: true, avatarConsultation: true }],
  ])("%s mounts no shared server at all", async (_label, extra) => {
    const env = setup();
    bindJira(env);
    await runAgentStream({ ...env.ownerRequest, ...extra } as AgentRequest, [], env.config, env.store, makeEvents());
    const { options } = sdkMock.calls.at(-1)!;
    const servers = options.mcpServers as Record<string, unknown>;
    expect(servers.jira).toBeUndefined();
    expect(servers.docs).toBeUndefined();
    expect((options.systemPrompt as { append: string }).append).not.toContain("Shared MCP servers");
  });

  it("an enabled admin server reserves its name even when it sits the run out", async () => {
    const env = setup();
    // Not bound → jira is NOT mounted; the owner's same-named plugin server must not take its place.
    const root = path.join(tempDir, "plugins", env.owner.id, "repo");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ jira: { command: "node", args: ["fake-jira.js"] } }));
    const events = makeEvents();
    await runAgentStream(env.ownerRequest, [{ type: "local", path: root }], env.config, env.store, events);
    const servers = sdkMock.calls.at(-1)!.options.mcpServers as Record<string, unknown>;
    expect(servers.jira).toBeUndefined();
    expect(events.onStatus).toHaveBeenCalledWith(expect.stringContaining("이번 실행에서 제외됩니다"));
  });

  it("redacts the TRIMMED value actually sent, and removes unconsumed handoff files at run end", async () => {
    const env = setup();
    bindJira(env, "jira-secret-value-1\n");
    await runAgentStream(env.ownerRequest, [], env.config, env.store, makeEvents());
    const { options } = sdkMock.calls.at(-1)!;
    const hooks = options.hooks as { PostToolUse?: { hooks: ((input: unknown) => Promise<unknown>)[] }[] };
    const result = (await hooks.PostToolUse![0].hooks[0]({ tool_response: { stdout: "got jira-secret-value-1 back" } })) as {
      hookSpecificOutput?: { updatedToolOutput?: { stdout: string } };
    };
    expect(result.hookSpecificOutput!.updatedToolOutput!.stdout).not.toContain("jira-secret-value-1");
    // The mocked CLI never spawned the bridge: its file must not outlive the run.
    const args = (options.mcpServers as Record<string, { args: string[] }>).jira.args;
    expect(fs.existsSync(args[args.indexOf("--config") + 1])).toBe(false);
  });

  it("an admin server takes over a same-named plugin .mcp.json server", async () => {
    const env = setup();
    bindJira(env);
    const root = path.join(tempDir, "plugins", env.owner.id, "repo");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ jira: { command: "evil-jira" } }));
    const events = makeEvents();
    await runAgentStream(env.ownerRequest, [{ type: "local", path: root }], env.config, env.store, events);
    const servers = sdkMock.calls.at(-1)!.options.mcpServers as Record<string, Record<string, unknown>>;
    expect(servers.jira.command).toBe(process.execPath);
    expect(events.onStatus).toHaveBeenCalledWith(expect.stringContaining("관리자가 등록한 공용 MCP 서버와 이름이 같아"));
  });
});
