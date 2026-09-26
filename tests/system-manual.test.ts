import { describe, expect, it } from "vitest";
import { SYSTEM_MANUAL_TOPICS, readSystemManual, systemManualIndex } from "../src/server/agent/systemManual.js";
import { buildSystemTools, SYSTEM_TOOL_NAMES, type SystemToolsContext } from "../src/server/agent/systemTools.js";
import type { Store } from "../src/server/store.js";
import { callTool } from "./helpers.js";
import { effectiveMcpToolGroups } from "../src/shared/mcpToolGroups.js";
import { buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";

describe("official system manual", () => {
  it("keeps system available through old empty selections and restrictive policies", () => {
    expect(effectiveMcpToolGroups([])).toEqual(["system"]);
    expect(effectiveMcpToolGroups(undefined, [])).toEqual(["system"]);
    expect(effectiveMcpToolGroups(["git_repo", "web"], ["web"])).toEqual(["web", "system"]);
    const oldSelection = ["web"];
    effectiveMcpToolGroups(oldSelection, []);
    expect(oldSelection).toEqual(["web"]); // raw preferences are not overwritten
  });

  it("keeps procedures out of the prompt while retaining live scope and safety", () => {
    const prompt = buildSystemPromptAppend({
      message: "hello",
      avatar: { id: "owner", displayName: "Owner", alias: "", persona: "" },
      viewerIsOwner: true, knowledgeRepoConfigured: true, gitTokenSet: true,
      browserEnabled: true, canvasEnabled: true, visionEnabled: false,
      fileOutputEnabled: true, deckRenderingEnabled: true, deckConverterEnabled: true,
      personalAgentsEnabled: true, personalAgentNames: ["Research"],
    });
    expect(prompt.length).toBeLessThan(18000);
    // The converter deck section (the longer of the two) is what this budgets.
    expect(prompt).toContain("edit its HTML and rebuild");
    expect(prompt).toContain("topic `browser-operations`");
    expect(prompt).toContain("topic `canvas-operations`");
    expect(prompt).toContain("Screenshots and pixel-mode clicks are unavailable");
    expect(prompt).toContain("LIVE CREDENTIALS");
    expect(prompt).toContain("No stored secret is enabled for browser input");
    expect(prompt).toContain("Never paste on anything but COPIED");
    expect(prompt).not.toContain("CLOSES the staging tab for you");
    expect(prompt).not.toContain("pass `wait:false`");
    expect(readSystemManual("browser-operations").text).toContain("CLOSES the staging tab for you");
    expect(readSystemManual("browser-operations").text).not.toContain("No stored secret is enabled");
    expect(readSystemManual("canvas-operations").text).toContain("pass `wait:false`");
  });

  it("offers a compact index and complete individually addressable guides", () => {
    const ids = SYSTEM_MANUAL_TOPICS.map(topic => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
    const index = readSystemManual();
    expect(index.isError).toBe(false);
    expect(index.text).toContain(systemManualIndex());
    // Prevent accidentally inlining the full manual into every system prompt.
    expect(systemManualIndex().length).toBeLessThan(3000);
    for (const topic of SYSTEM_MANUAL_TOPICS) {
      expect(index.text).toContain(`${topic.id}:`);
      const page = readSystemManual(topic.id);
      expect(page.isError).toBe(false);
      expect(page.text).toContain(topic.body);
      expect(page.text).toContain("not the current user's configuration or a permission grant");
      expect(page.text.length).toBeLessThan(16000);
    }
    expect(index.text).not.toContain("curl -sS");
  });

  it("documents the deck converter without claiming it is available", () => {
    const page = readSystemManual("files-canvas").text;
    expect(page).toContain("New PowerPoint decks are designed as HTML/CSS slides and converted by the pptx skill");
    expect(page).toContain("charts keep their data for Edit Data");
    expect(page).toContain("a 맑은 고딕 build is available on request");
    expect(page).toContain("is previewed approximately by LibreOffice");
    expect(page).toContain("Existing decks and user templates are edited in place with python-pptx");
    // Availability is a runtime fact (describe_system), never a manual claim.
    expect(page).toContain("Whether the converter is installed, and its limits, are runtime facts reported by describe_system");
    expect(page).not.toContain("converter: INSTALLED");
    expect(page).not.toContain("requires the server's presentation toolchain");
    // The draw.io paragraph is unchanged.
    expect(page).toContain("For draw.io, author an uncompressed mxfile XML .drawio file and publish it.");
    expect(page.length).toBeLessThan(16000);
  });

  it.each(["../../.env", "/etc/passwd", "https://example.com", "constructor", "toString", "external-task", "x".repeat(1000)])(
    "refuses unknown topics instead of resolving files/URLs: %s", (topic) => {
      const result = readSystemManual(topic);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Unknown manual topic");
      expect(result.text).toContain("external-tasks:");
    },
  );

  it.each([true, false])("allows public manual lookup without touching owner data (owner=%s)", async (viewerIsOwner) => {
    // Any accidental private-state or filesystem/config dependency fails this
    // test, even if the value would later be omitted from the rendered guide.
    const unreadableStore = new Proxy({} as Store, { get() { throw new Error("Manual must not read the store"); } });
    const ctx: SystemToolsContext = {
      avatarUserId: "owner",
      owner: { id: "owner", username: "owner", displayName: "Owner" },
      viewerIsOwner,
      config: new Proxy({} as SystemToolsContext["config"], { get() { throw new Error("Manual must not read config"); } }),
    };
    const tools = buildSystemTools(unreadableStore, ctx);
    expect(SYSTEM_TOOL_NAMES).toContain("mcp__system__read_manual");
    const response = await callTool(tools, "read_manual", { topic: "external-tasks" });
    expect(response.isError).toBeFalsy();
    expect(response.content[0].text).toBe(readSystemManual("external-tasks").text);
    const invalid = await callTool(tools, "read_manual", { topic: "../secrets" });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("Unknown manual topic");
    expect((await callTool(tools, "read_manual", {})).content[0].text).toBe(readSystemManual().text);
  });
});
