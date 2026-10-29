/**
 * SDK-path pins: what the Claude Agent SDK runner sends the model — the system
 * append, every in-process MCP tool listing and describe_system — compared
 * byte for byte against fixtures captured BEFORE pi-only changes landed. A
 * pi-runtime change (tool discovery, compact descriptions, strict arguments)
 * must leave these untouched; an intentional change to text both runtimes
 * share updates the fixture in the same commit, so the diff shows exactly
 * what the SDK model now reads.
 *
 * Regenerate (only for an intentional shared-text change): PIN_UPDATE=1 npx vitest run tests/sdk-pin.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServices } from "../src/server/app.js";
import type { AgentRequest } from "../src/server/types.js";
import type { AgentEvents } from "../src/server/agent/events.js";
import { SteerChannel } from "../src/server/agent/steerChannel.js";
import { buildRunCapabilities, stampPromptRequest } from "../src/server/agent/runCapabilities.js";
import { listServerTools } from "../src/server/agent/pi/mcpCatalog.js";
import { buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { withTempDir } from "./helpers.js";

const dir = withTempDir("sdk-pin");
const FIXTURES = path.join(import.meta.dirname, "fixtures", "sdk-pin");
const UPDATE = process.env.PIN_UPDATE === "1";

let services: ReturnType<typeof createServices> | undefined;
afterEach(() => {
  services?.store.close();
  services = undefined;
});

function pin(name: string, actual: string): void {
  const file = path.join(FIXTURES, name);
  if (UPDATE) {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  const expected = fs.readFileSync(file, "utf8");
  if (actual !== expected && process.env.PIN_DUMP) fs.writeFileSync(path.join(process.env.PIN_DUMP, name), actual);
  expect(actual, `${name} changed — regenerate only for an intentional shared-text change`).toBe(expected);
}

/** Ids and temp paths vary per run; everything else must be byte-stable. */
function normalize(text: string, ids: Record<string, string>): string {
  let out = text.split(dir()).join("<tmp>").replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?Z?)?( KST)?/g, "<now>").replace(/today is \d{4}-\d{2}-\d{2}/g, "today is <today>");
  for (const [id, label] of Object.entries(ids)) out = out.split(id).join(label);
  return out;
}

async function callTool(server: { instance: McpServer }, name: string): Promise<string> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "pin", version: "1" });
  await server.instance.connect(b);
  await client.connect(a);
  try {
    const result = (await client.callTool({ name, arguments: {} })) as { content: { text: string }[] };
    return result.content.map((c) => c.text).join("\n");
  } finally {
    await client.close();
  }
}

function setup() {
  services = createServices({
    dataDir: path.join(dir(), "data"),
    agentRuntime: "claude",
    sessionSecret: "t",
    defaultPluginsDir: path.join(dir(), "defaults"),
  });
  const { store, config } = services;
  const owner = store.createUser({ username: "owner", displayName: "Owner", password: "password123" });
  const mate = store.createUser({ username: "mate", displayName: "Mate", password: "password123" });
  const group = store.createGroup({ name: "team", createdBy: owner.id });
  store.addGroupMember(group.id, owner.id, "admin");
  store.addGroupMember(group.id, mate.id, "member");
  store.setGroupAvatarSharing(group.id, true);
  store.setUserSecret(owner.id, "API_TOKEN", "tok-123456789");
  store.touchConversation(owner.id, "conv-1", owner.id, "hello");
  return { store, config, owner, mate, ids: { [owner.id]: "<owner>", [mate.id]: "<mate>", [group.id]: "<group>" } };
}

/** An interactive owner chat with every sink a chat turn wires (browser, canvas, files, share links, steers). */
function chatEvents(): AgentEvents {
  const unused = async () => ({ behavior: "error", message: "unused" }) as never;
  return {
    steers: new SteerChannel(),
    onFile: unused,
    onShareFile: unused,
    onShareLink: unused,
    onBrowser: unused,
    onCanvas: unused,
  } as AgentEvents;
}

describe("SDK runner pins (byte-identical across pi-only changes)", () => {
  it("owner chat: system append, every MCP tool listing, describe_system", async () => {
    const { store, config, owner, ids } = setup();
    const request: AgentRequest = {
      message: "m",
      avatar: { id: owner.id, displayName: "Owner", alias: "", persona: "" },
      conversationId: "conv-1",
      viewerUserId: owner.id,
      viewerName: "Owner",
      viewerIsOwner: true,
      elevated: true,
      autoApprove: true,
      cwd: path.join(dir(), "cwd"),
      gitTokenSet: true,
      knowledgeRepoConfigured: true,
    };
    const events = chatEvents();
    const caps = await buildRunCapabilities(request, [], config, store, events, undefined, () => 0);
    const prompt = buildSystemPromptAppend(stampPromptRequest(request, caps, config, events));
    pin("owner-chat.prompt.txt", normalize(prompt, ids));
    const servers = caps.inProcessMcpServers as Record<string, { instance: McpServer } | undefined>;
    const listing: Record<string, unknown> = {};
    for (const name of Object.keys(servers).sort()) {
      const server = servers[name];
      if (server?.instance) listing[name] = await listServerTools(server.instance);
    }
    pin("owner-chat.tools.json", normalize(`${JSON.stringify(listing, null, 1)}\n`, ids));
    // Servers this request does not register (no knowledge repo connected) — same builders the SDK run uses.
    const { buildBrainServer } = await import("../src/server/agent/brainTools.js");
    const { buildGroupBrainServer } = await import("../src/server/agent/groupBrainTools.js");
    const base = { avatarUserId: owner.id, owner: { id: owner.id, username: "owner", displayName: "Owner" }, viewerIsOwner: true, config };
    const unregistered = {
      brain: await listServerTools(buildBrainServer(store, base).instance),
      group_brain: await listServerTools(buildGroupBrainServer(store, base).instance),
    };
    pin("unregistered.tools.json", normalize(`${JSON.stringify(unregistered, null, 1)}\n`, ids));
    pin("owner-chat.allowed-tools.json", `${JSON.stringify([...caps.mcpAllowedTools].sort(), null, 1)}\n`);
    // A fresh plan: listing above closed the servers it connected.
    const again = await buildRunCapabilities(request, [], config, store, chatEvents(), undefined, () => 0);
    const describe = await callTool(again.inProcessMcpServers.system as { instance: McpServer }, "describe_system");
    pin("owner-chat.describe-system.txt", normalize(describe, ids));
  });

  it("trusted colleague and owner routine: system append", async () => {
    const { store, config, owner, mate, ids } = setup();
    const colleague: AgentRequest = {
      message: "m",
      avatar: { id: owner.id, displayName: "Owner", alias: "", persona: "" },
      conversationId: "conv-2",
      viewerUserId: mate.id,
      viewerName: "Mate",
      viewerIsOwner: false,
      elevated: true,
      cwd: path.join(dir(), "cwd2"),
    };
    const colleagueCaps = await buildRunCapabilities(colleague, [], config, store, chatEvents(), undefined, () => 0);
    pin("colleague.prompt.txt", normalize(buildSystemPromptAppend(stampPromptRequest(colleague, colleagueCaps, config, chatEvents())), ids));
    const routine: AgentRequest = {
      message: "m",
      avatar: { id: owner.id, displayName: "Owner", alias: "", persona: "" },
      conversationId: "conv-3",
      viewerUserId: owner.id,
      viewerIsOwner: true,
      elevated: true,
      autoApprove: true,
      headless: true,
      allowHeadlessTools: true,
      cwd: path.join(dir(), "cwd3"),
    };
    const routineCaps = await buildRunCapabilities(routine, [], config, store, undefined, undefined, () => 0);
    pin("routine.prompt.txt", normalize(buildSystemPromptAppend(stampPromptRequest(routine, routineCaps, config, undefined)), ids));
  });
});
