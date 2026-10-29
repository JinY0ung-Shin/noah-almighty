import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest } from "../src/server/types.js";
import { withTempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// canWriteFiles end to end: buildRunCapabilities derives it ONCE (every pi run
// writes in its principal's own sandbox, so it is always true), hands it to
// describe_system's ctx, and stampPromptRequest stamps it onto the prompt
// request. Both metacognition surfaces must then tell each viewer class the
// same thing about the images it has as files. A missing stamp is silent: the
// prompt falls back to "only the owner writes", so a colleague would hear
// read-only from the prompt and place-the-file from describe_system.
// ---------------------------------------------------------------------------

// The REAL server, with its ctx recorded: describe_system's half of the pair.
vi.mock("../src/server/agent/systemTools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/server/agent/systemTools.js")>();
  return { ...actual, buildSystemServer: vi.fn(actual.buildSystemServer) };
});

import { createServices } from "../src/server/app.js";
import { buildRunCapabilities, stampPromptRequest } from "../src/server/agent/runCapabilities.js";
import { buildUserPrompt } from "../src/server/agent/promptBuilder.js";
import { buildSystemServer, imageSourcesLine } from "../src/server/agent/systemTools.js";

let tempDir: string;
const getTempDir = withTempDir("agent-can-write-files", () => {
  tempDir = getTempDir();
  vi.mocked(buildSystemServer).mockClear();
});

describe("canWriteFiles reaches both metacognition surfaces", () => {
  it("tells the owner, a trusted teammate and a plain colleague the same thing on each", async () => {
    const { config, store } = createServices({
      dataDir: path.join(tempDir, "data"),
      agentRuntime: "pi",
      sessionSecret: "test",
      pi: {
        gatewayUrl: "http://pi.invalid",
        apiKey: "k",
        modelMap: {},
        deckSandbox: false,
        workspacesDir: path.join(tempDir, "pi-ws"),
      },
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
    const cases: Array<{ label: string; request: AgentRequest }> = [
      { label: "owner", request: base },
      {
        label: "trusted teammate",
        request: { ...base, viewerUserId: "mate", viewerName: "동료", viewerIsOwner: false, elevated: true },
      },
      {
        label: "plain colleague",
        request: { ...base, viewerUserId: "colleague", viewerName: "동료", viewerIsOwner: false, elevated: false },
      },
    ];

    for (const [i, c] of cases.entries()) {
      const caps = await buildRunCapabilities(c.request, [], config, store, undefined, undefined, () => 0);
      expect(caps.canWriteFiles, c.label).toBe(true);
      const ctx = vi.mocked(buildSystemServer).mock.calls[i][1] as Parameters<typeof imageSourcesLine>[0];
      expect(ctx.canWriteFiles, c.label).toBe(true);
      const stamped = stampPromptRequest(c.request, caps, config, undefined);
      expect(stamped.canWriteFiles, c.label).toBe(true);

      const line = imageSourcesLine(ctx);
      const userPrompt = buildUserPrompt(stamped);
      expect(userPrompt, c.label).toContain("ALSO saved as files in the conversation folder");
      expect(line, c.label).toContain("copy that FILE (e.g. into the deck's `assets/`)");
      expect(userPrompt, c.label).toContain("place the FILE itself instead of describing or redrawing it");
      expect(userPrompt, c.label).not.toContain("This conversation cannot write files");
    }
    store.close();
  });

  it("the stamp is load-bearing: an UNSTAMPED colleague request falls back to read-only on both surfaces", () => {
    const colleague: AgentRequest = {
      message: "m",
      avatar: { id: "owner", displayName: "오너", alias: "", persona: "" },
      viewerUserId: "colleague",
      viewerIsOwner: false,
      images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
      imageFiles: [{ path: "/x/attachments/a.png", mediaType: "image/png" }],
    };
    expect(buildUserPrompt(colleague)).toContain(
      "This conversation cannot write files, so you can read these files here",
    );
    expect(buildUserPrompt(colleague)).not.toContain("place the FILE itself");
    expect(imageSourcesLine({ headless: false, viewerIsOwner: false })).toContain(
      "This conversation cannot write files, so you can read them here",
    );
    // A text-only turn (no image blocks) uses the same flag for its own tail.
    expect(buildUserPrompt({ ...colleague, images: undefined })).toContain(
      "This conversation cannot write files: show one to the user with mcp__file_output__show_file",
    );
    expect(buildUserPrompt({ ...colleague, images: undefined, canWriteFiles: true })).toContain(
      "Handle them as files: show one to the user with mcp__file_output__show_file",
    );
  });
});
