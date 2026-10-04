import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest } from "../src/server/types.js";
import { withTempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// canWriteFiles end to end: runPlan derives it ONCE (elevatedToolAccess), hands
// it to describe_system's ctx, and runClaudeAgent stamps it onto the prompt
// request. Both metacognition surfaces must then tell each viewer class the
// same thing about the images it has as files. A missing stamp is silent: the
// prompt falls back to "owner or group agent writes", so a trusted teammate
// would hear read-only from the prompt and place-the-file from describe_system.
// Partial SDK mock (agent-run.test.ts pattern), recording the prompt too.
// ---------------------------------------------------------------------------
const sdkMock = vi.hoisted(() => ({
  calls: [] as { prompt: unknown }[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    query: (args: { prompt: unknown; options: Record<string, unknown> }) => {
      sdkMock.calls.push({ prompt: args.prompt });
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "s1", model: "opus" };
        yield { type: "result", subtype: "success", result: "ok" };
      }
      return gen();
    },
  };
});

// The REAL server, with its ctx recorded: describe_system's half of the pair.
vi.mock("../src/server/agent/systemTools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/agent/systemTools.js")>();
  return { ...actual, buildSystemServer: vi.fn(actual.buildSystemServer) };
});

import { createServices } from "../src/server/app.js";
import { runAgentStream } from "../src/server/agent/index.js";
import { buildSystemServer, imageSourcesLine } from "../src/server/agent/systemTools.js";

let tempDir: string;
const getTempDir = withTempDir("agent-can-write-files", () => {
  tempDir = getTempDir();
  sdkMock.calls.length = 0;
  vi.mocked(buildSystemServer).mockClear();
});

/** The text of the user message run #i sent (the image turn's single message). */
async function userPromptOf(i: number): Promise<string> {
  const prompt = sdkMock.calls[i].prompt;
  if (typeof prompt === "string") return prompt;
  for await (const message of prompt as AsyncIterable<{ message?: { content?: unknown } }>) {
    const content = message.message?.content;
    if (!Array.isArray(content)) return String(content ?? "");
    return content
      .filter((block: { type?: string }) => block.type === "text")
      .map((block: { text?: string }) => block.text ?? "")
      .join("\n");
  }
  return "";
}

describe("canWriteFiles reaches both metacognition surfaces", () => {
  it("tells the owner, a trusted teammate and a plain colleague the same thing on each", async () => {
    const { config, store } = createServices({
      dataDir: path.join(tempDir, "data"),
      agentRuntime: "claude",
      sessionSecret: "test",
      anthropicModel: undefined,
      anthropicApiKey: undefined,
    });
    const owner = store.createUser({ username: "owner", displayName: "오너", password: "password123" });
    const cwd = path.join(tempDir, "ws");
    fs.mkdirSync(path.join(cwd, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "attachments", "a.png"), "x");
    // A vision turn: the image block plus its staged file.
    const base: AgentRequest = {
      message: "이 사진을 덱에 넣어 줘",
      avatar: { id: owner.id, displayName: "오너", alias: "노아", persona: "" },
      conversationId: "conv-1",
      cwd,
      viewerUserId: owner.id,
      viewerName: "오너",
      viewerIsOwner: true,
      autoApprove: true,
      images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
      imageFiles: [{ path: path.join(cwd, "attachments", "a.png"), mediaType: "image/png" }],
    };
    const cases: Array<{ label: string; request: AgentRequest; writes: boolean }> = [
      { label: "owner", request: base, writes: true },
      {
        label: "trusted teammate",
        request: { ...base, viewerUserId: "mate", viewerName: "동료", viewerIsOwner: false, elevated: true },
        writes: true,
      },
      {
        label: "plain colleague",
        request: { ...base, viewerUserId: "colleague", viewerName: "동료", viewerIsOwner: false, elevated: false },
        writes: false,
      },
    ];
    const events = { onDelta: vi.fn(), onStatus: vi.fn(), onToolStart: vi.fn(), onToolEnd: vi.fn() };
    for (const c of cases) {
      await runAgentStream(c.request, [], config, store, events);
    }

    for (const [i, c] of cases.entries()) {
      const ctx = vi.mocked(buildSystemServer).mock.calls[i][1] as Parameters<typeof imageSourcesLine>[0];
      expect(ctx.canWriteFiles, c.label).toBe(c.writes);
      const line = imageSourcesLine(ctx);
      const userPrompt = await userPromptOf(i);
      expect(userPrompt, c.label).toContain("ALSO saved as files in the conversation scratch workspace");
      if (c.writes) {
        expect(line, c.label).toContain("copy that FILE (e.g. into the deck's `assets/`)");
        expect(userPrompt, c.label).toContain("place the FILE itself instead of describing or redrawing it");
      } else {
        expect(line, c.label).toContain("This conversation cannot write files, so you can read them here");
        expect(userPrompt, c.label).toContain("This conversation cannot write files, so you can read these files here");
        expect(userPrompt, c.label).not.toContain("place the FILE itself");
      }
    }
  });
});
