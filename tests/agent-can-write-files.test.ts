import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRequest } from "../src/server/types.js";
import { withTempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// Placing an image file, end to end: the capability plan derives ONE fact,
// `PiRuntimeFacts.readOnlyBuiltins` (a colleague chat's pi session is
// read_only — user decision 2026-10-31), hands it to describe_system's ctx and
// stamps it onto the prompt request. Both surfaces (describe_system's
// image-sources line, the user prompt's attached-images tails) must then tell
// the owner to place the FILE and every colleague that it can only read it.
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

describe("placing an image file follows the run's read-only fact, on both metacognition surfaces", () => {
  it("tells the owner to place the file and a trusted or plain colleague that it cannot, on each", async () => {
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
    const cases: Array<{ label: string; request: AgentRequest; readOnly: boolean }> = [
      { label: "owner", request: base, readOnly: false },
      {
        label: "trusted teammate",
        request: { ...base, viewerUserId: "mate", viewerName: "동료", viewerIsOwner: false, elevated: true },
        readOnly: true,
      },
      {
        label: "plain colleague",
        request: { ...base, viewerUserId: "colleague", viewerName: "동료", viewerIsOwner: false, elevated: false },
        readOnly: true,
      },
    ];

    for (const [i, c] of cases.entries()) {
      const caps = await buildRunCapabilities(c.request, [], config, store, undefined, undefined, () => 0);
      expect(caps.piRuntimeFacts.readOnlyBuiltins, c.label).toBe(c.readOnly);
      const ctx = vi.mocked(buildSystemServer).mock.calls[i][1] as Parameters<typeof imageSourcesLine>[0];
      const stamped = stampPromptRequest(c.request, caps, config, undefined);

      const line = imageSourcesLine(ctx);
      const userPrompt = buildUserPrompt(stamped);
      const textOnly = buildUserPrompt({ ...stamped, images: undefined });
      expect(userPrompt, c.label).toContain("ALSO saved as files in the conversation folder");
      if (c.readOnly) {
        expect(line, c.label).toContain("you can read those files here but not place them");
        expect(userPrompt, c.label).toContain("you can read these files here but not place them");
        expect(userPrompt, c.label).not.toContain("place the FILE itself");
        expect(textOnly, c.label).not.toContain("inspect or convert with `bash`");
      } else {
        expect(line, c.label).toContain("copy that FILE (e.g. into the deck's `assets/`)");
        expect(userPrompt, c.label).toContain("place the FILE itself instead of describing or redrawing it");
        expect(textOnly, c.label).toContain("inspect or convert with `bash`");
      }
    }
    store.close();
  });
});
