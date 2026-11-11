import { describe, expect, it } from "vitest";
import {
  INLINE_UI_MANUAL_EXAMPLES,
  SYSTEM_MANUAL_TOPICS,
  readSystemManual,
  systemManualIndex,
} from "../src/server/agent/systemManual.js";
import { checkWidget } from "../src/shared/widget/check.js";
import { WIDGET_ICON_NAMES } from "../src/shared/widget/icons.js";
import { widgetComponentReference } from "../src/shared/widget/spec.js";
import { svgReference } from "../src/shared/widget/svg.js";
import { INLINE_UI_REPORT_TITLE } from "../src/shared/widget/guide.js";
import { buildSystemTools, SYSTEM_TOOL_NAMES, type SystemToolsContext } from "../src/server/agent/systemTools.js";
import type { Store } from "../src/server/store.js";
import { callTool } from "./helpers.js";
import { effectiveMcpToolGroups } from "../src/shared/mcpToolGroups.js";
import { buildPiTurnPreamble, buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import type { AgentRequest } from "../src/server/types.js";

describe("official system manual", () => {
  it("keeps system available through old empty selections and restrictive policies", () => {
    expect(effectiveMcpToolGroups([])).toEqual(["system"]);
    expect(effectiveMcpToolGroups(undefined, [])).toEqual(["system"]);
    expect(effectiveMcpToolGroups(["git_repo", "canvas"], ["canvas"])).toEqual(["canvas", "system"]);
    const oldSelection = ["canvas"];
    effectiveMcpToolGroups(oldSelection, []);
    expect(oldSelection).toEqual(["canvas"]); // raw preferences are not overwritten
  });

  it("keeps procedures out of the prompt while retaining live scope and safety", () => {
    // A TRIPWIRE against procedures creeping into the standing prompt — NOT a
    // bound on real owner prompts. The config is maximal over the BOOLEAN
    // feature flags only (shareLinksEnabled and todoState included: every
    // interactive owner run with file output carries the first, and every owner
    // run with the to-do tools the last; midTurnMessages is set too, but its
    // line rides the per-turn preamble, never the standing append) and sets no
    // data-driven field. Real owner turns also carry sections this cap does not
    // measure: the External task API line (avatarApiKeyCount is stamped even at
    // 0 keys), the web-fetch proxy note, and the group, secret, Confluence and
    // experimental-feature sections. A flag-maximal owner turn already measures
    // about 19.1k characters (about 20.5k in one avatar-sharing group), so the
    // margin under 18,000 is not real headroom: keep standing sections short
    // and put procedures in the manual. Vision is the one flag with TWO real
    // states, so both are budgeted: OFF carries the no-vision notes, ON the
    // image-file sentence and the saved-capture wording.
    const flags = {
      message: "hello",
      avatar: { id: "owner", displayName: "Owner", alias: "", persona: "" },
      viewerIsOwner: true, knowledgeRepoConfigured: true, gitTokenSet: true,
      browserEnabled: true, canvasEnabled: true, visionEnabled: false,
      fileOutputEnabled: true, deckRenderingEnabled: true, deckConverterEnabled: true,
      midTurnMessages: true, shareLinksEnabled: true,
      // A flag here: its list frozen per conversation (`snapshot`) is data-driven,
      // like every other field this tripwire leaves out.
      todoState: { deleteEnabled: true },
    };
    const prompt = buildSystemPromptAppend(flags);
    expect(prompt.length).toBeLessThan(18000);
    const visionPrompt = buildSystemPromptAppend({ ...flags, visionEnabled: true });
    expect(visionPrompt.length).toBeLessThan(18000);
    expect(visionPrompt).toContain("Images you are shown are also FILES in the scratch workspace");
    expect(visionPrompt).toContain("saved in the scratch workspace's `captures/`");
    expect(visionPrompt).not.toContain("Screenshots and pixel-mode clicks are unavailable");
    // The mid-turn line is a per-turn fact: it rides the pi turn preamble, so
    // it neither appears in nor counts against the standing append.
    expect(prompt).not.toContain("The user may send additional messages");
    expect(buildPiTurnPreamble(flags as unknown as AgentRequest)).toContain(
      "The user may send additional messages while you are working.",
    );
    expect(prompt).toContain("Share links: `create_share_link`, ONLY if the user asks for a link.");
    expect(prompt).toContain("manage it ONLY with `mcp__todo__*`");
    // The converter deck section (the longer of the two) is what this budgets.
    expect(prompt).toContain("edit its HTML and rebuild");
    expect(prompt).toContain("topic `browser-operations`");
    expect(prompt).toContain("topic `canvas-operations`");
    expect(prompt).toContain("Screenshots and pixel-mode clicks are unavailable");
    expect(prompt).toContain("LIVE CREDENTIALS");
    expect(prompt).toContain("No stored secret is enabled for browser input");
    expect(prompt).toContain("Never paste on anything but COPIED");
    expect(prompt).not.toContain("CLOSES the staging tab for you");
    expect(prompt).not.toContain("Reserve `svg`/`html` for bespoke visuals");
    expect(readSystemManual("browser-operations").text).toContain("CLOSES the staging tab for you");
    expect(readSystemManual("browser-operations").text).not.toContain("No stored secret is enabled");
    expect(readSystemManual("canvas-operations").text).toContain("Reserve `svg`/`html` for bespoke visuals");
    expect(readSystemManual("canvas-operations").text).toContain("Double-quote every node/edge label");
  });

  it("canvas-operations states the never-wait behavior of this runtime (the old blocking sentence is gone)", () => {
    // The tool has no blocking mode on pi (design D8); the manual used to say it
    // BLOCKS by default and offered `wait:false`, contradicting the tool text.
    const page = readSystemManual("canvas-operations").text;
    expect(page).toContain("The tool NEVER waits on this runtime");
    expect(page).toContain("arrives as their NEXT message referencing the canvas");
    expect(page).toContain("(`wait` is ignored)");
    expect(page).not.toContain("BLOCKS until the user submits");
    expect(page).not.toContain("pass `wait:false`");
    // A side-panel artifact with five content types; what the user only sees
    // or operates is inline UI — routed to its own topic, not restated here.
    expect(page).toContain("(`markdown` | `vega` | `mermaid` | `svg` | `html`).");
    expect(page).toContain("Use it for an ARTIFACT you work out WITH the user in the side panel");
    expect(page).toContain(
      "A chart, table, calculator or dashboard the user only needs to SEE or operate in the answer is NOT a canvas: write it in your answer text as inline UI (topic `inline-ui`; describe_system says whether this run has it).",
    );
    expect(page).toContain("The former contentType `widget` is retired — `show` refuses it");
    expect(page).toContain("For a side-panel DATA CHART use `vega`");
    for (const stale of ["| `widget`", "canvas-widget", "EXPERIMENTAL", "실험 기능", "For something the user OPERATES"]) {
      expect(page).not.toContain(stale);
    }
  });

  it("retires topic `canvas-widget`: not in the index, never a page, and a redirect to `inline-ui` instead of 'unknown topic'", () => {
    const ids: string[] = SYSTEM_MANUAL_TOPICS.map((topic) => topic.id);
    expect(ids).not.toContain("canvas-widget");
    expect(ids).toContain("inline-ui");
    expect(readSystemManual().text).not.toContain("canvas-widget");
    const retired = readSystemManual("canvas-widget");
    expect(retired.isError).toBe(true);
    expect(retired.text).toBe(
      "Manual topic `canvas-widget` is retired: interactive UI is no longer a canvas content type (`mcp__canvas__show` refuses contentType 'widget'). " +
        "It is now written directly in your answer text as inline UI, with no tool call — call read_manual with topic `inline-ui` for the guide that replaced it.",
    );
    expect(retired.text).not.toContain("Unknown manual topic");
    // An id that merely looks like one is still unknown (no prototype lookups).
    for (const unknown of ["canvas-widgets", "constructor", "toString", "__proto__"]) {
      expect(readSystemManual(unknown).text.startsWith("Unknown manual topic.")).toBe(true);
    }
  });

  it("documents inline UI: where to write it, grammar, send/submit, limits, leniency, and examples the checker accepts", () => {
    expect(readSystemManual().text).toContain("- inline-ui: Inline UI reference");
    const page = readSystemManual("inline-ui").text;
    // It is the ANSWER TEXT, not a tool and not the side panel.
    expect(page).toContain("**Inline UI** is UI you write directly in your ANSWER TEXT.");
    expect(page).toContain("There is no tool to call and nothing opens in the side panel.");
    expect(page).toContain("you are NOT called and never see the values the user sets");
    // Availability is a runtime fact — the manual defers to describe_system.
    expect(page).toContain("Interactive chat turns only — a routine, an external-task turn or a consultation answers in plain Markdown; describe_system is authoritative");
    expect(page).toContain("Answer a plain question in plain Markdown; never decorate, and do not repeat in prose what the UI shows.");
    expect(page).toContain("is a canvas: topic `canvas-operations`");
    // Where and how: final answer, own line at top level, Markdown between tags, never in a fence.
    expect(page).toContain("In your FINAL answer text. Text written before a tool call is folded into the reasoning view, where tags are not drawn.");
    expect(page).toContain("A tag starts on its own line at the TOP LEVEL of the answer, indented at most 3 spaces");
    expect(page).toContain("Never inside a fenced code block");
    expect(page).toContain("Top-level text between tags is ordinary Markdown, and STATIC");
    // Document structure + the two things that only work in a handler.
    for (const piece of ["{@state name = expr}", "{@const name = expr}", "{#each list as item, index}", "{#if cond}", "TOP LEVEL only"]) {
      expect(page).toContain(piece);
    }
    expect(page).toContain("work ONLY inside an event handler");
    expect(page).toContain("no `Math.random`");
    // The component list is the shared spec's own text, never a hand copy.
    expect(page).toContain(`## Components\n${widgetComponentReference()}`);
    // The TWO ways back to the avatar, each an ordinary next message.
    expect(page).toContain("Only two things come back, each as the user's NEXT message");
    expect(page).toContain('`<button send="Compare the two plans in a table">Compare plans</button>` — a natural FOLLOW-UP');
    expect(page).toContain("The user sees the text before pressing; 1–2,000 characters");
    expect(page).toContain("must not start with `/`");
    expect(page).toContain(
      '`<submit values={{ months, rate }}>Proceed</submit>` — STRUCTURED values. Posts the label followed by one `- key: value` line per value ("Proceed", "- months: 12", "- rate: 4.5").',
    );
    expect(page).toContain("≤ 20 keys");
    expect(page).toContain("≤ 8,000 characters");
    // Links open; images are this conversation's own, by the URL a hidden show_file returns.
    expect(page).toContain("Links open in a new tab and send you nothing: `<button href>`, `<link href>`, `[text](https://…)` in text — absolute http(s) only.");
    expect(page).toContain("publish the file with `mcp__file_output__show_file` + `hidden:true` and pass the returned URL unchanged");
    expect(page).toContain("remote and `data:` URLs are refused");
    // Runtime budgets stay; state is the browser's.
    expect(page).toContain("≤ 50 state variables");
    expect(page).toContain("50,000 evaluation steps");
    expect(page).toContain("a table ≤ 500 rows");
    expect(page).toContain("kept in THEIR browser only");
    // Leniency + the render report, by the shared title.
    expect(page).toContain("Nothing checks your answer before it is drawn. A tag or prop that does not exist is dropped where it stands and the rest still draws");
    expect(page).toContain(`told to you at the start of your next turn ("${INLINE_UI_REPORT_TITLE}")`);
    // Nothing of the canvas it used to be is left to mislead.
    for (const stale of [
      "mcp__canvas__show",
      "canvasId",
      "`controls`",
      "editable",
      "Content ≤ 20,000 characters",
      "EXPERIMENTAL",
      "실험 기능",
      "widget",
      "references this canvas",
      "Canvas render report",
      "call show again",
    ]) {
      expect(page, stale).not.toContain(stale);
    }
    // The spec's own reference documents the declared-action props and the two chart forms.
    expect(widgetComponentReference()).toContain("send: text");
    expect(widgetComponentReference()).toContain("<image />");
    expect(widgetComponentReference()).toContain("<link>");
    expect(widgetComponentReference()).toContain("type: bar|line|area|pie|donut");
    // A manual example that does not parse teaches a broken grammar: every
    // example goes through the static checker.
    for (const [name, source] of Object.entries(INLINE_UI_MANUAL_EXAMPLES) as [string, string][]) {
      expect(page).toContain(source);
      const verdict = checkWidget(source);
      expect(verdict, `${name}: ${verdict.ok ? "" : verdict.error}`).toMatchObject({ ok: true });
    }
    expect(checkWidget(INLINE_UI_MANUAL_EXAMPLES.calculator)).toEqual({ ok: true, submits: true });
    expect(checkWidget(INLINE_UI_MANUAL_EXAMPLES.filteredTable)).toEqual({ ok: true, submits: false });
    expect(checkWidget(INLINE_UI_MANUAL_EXAMPLES.gauge)).toEqual({ ok: true, submits: false });
    // Examples are written the way an answer writes them: not inside a code fence.
    expect(page).not.toContain("```");
    // The sortable table, the icons and the state-bound <svg>: each is in the generated reference
    // (the spec's own text) and shown once in an example — and the page still fits its cap.
    expect(page).toContain("sortable: bool (headers sort on click — the viewer's own view; your rows and state are untouched)");
    expect(page).toContain(`Icons: ${WIDGET_ICON_NAMES.join(" ")}`);
    expect(page).toContain(svgReference());
    expect(page).toContain("NOT available: style class href events font-family, <style> <script> <use> <image> <a> <foreignObject>, filters, animation");
    expect(page).toContain("colours are default muted accent success warning danger info surface subtle line");
    expect(page).toContain("## Example: filtered sortable table, chart, icon");
    expect(INLINE_UI_MANUAL_EXAMPLES.filteredTable).toContain("<table sortable columns=");
    expect(INLINE_UI_MANUAL_EXAMPLES.filteredTable).toContain('<icon name="activity" color="muted" />');
    // The chart example uses the simple form (data + type + xKey + series), not a Vega-Lite spec.
    expect(INLINE_UI_MANUAL_EXAMPLES.filteredTable).toContain(
      '<chart type="bar" data={shown} xKey="month" series={[{ key: "sales", label: "Sales" }, { key: "cost", label: "Cost" }]} unit="만원"',
    );
    expect(INLINE_UI_MANUAL_EXAMPLES.filteredTable).not.toContain("spec={");
    expect(page).toContain("## Example: svg gauge bound to a slider");
    expect(INLINE_UI_MANUAL_EXAMPLES.gauge).toContain('<svg viewBox="0 0 200 110" label="Progress">');
    expect(INLINE_UI_MANUAL_EXAMPLES.gauge).toContain("x2={100 + 70 * Math.cos(a)} y2={100 - 70 * Math.sin(a)}");
    expect(page).toContain("a filterable or sortable table, a gauge or chart driven by sliders");
    expect(page.length).toBeLessThan(16000);
    // One example shows the follow-up button next to the structured submit.
    expect(INLINE_UI_MANUAL_EXAMPLES.calculator).toContain('<button send="금리를 더 낮출 방법을 알려줘" variant="ghost">');
    expect(INLINE_UI_MANUAL_EXAMPLES.calculator).toContain("<submit values={{ amount, months, rate }}>");
    // The user-facing product page: always on, where it appears, what reaches the avatar, where it is off.
    const product = readSystemManual("files-canvas").text;
    expect(product).toContain("## Inline UI in an answer");
    expect(product).toContain("There is no setting to turn on and nothing opens in the side panel");
    expect(product).toContain("a chart or calculator the user just looks at or operates is inline UI, not a canvas (avatar reference: topic `inline-ui`)");
    expect(product).toContain("a submit button (its label and the chosen values become the user's next message)");
    expect(product).toContain("a button that posts a follow-up chat message, whose text is shown before it is pressed");
    expect(product).toContain("Routines, external Task API runs and avatar consultations answer in plain text");
    for (const stale of ["캔버스 위젯", "실험 기능", "experimental"]) {
      expect(product).not.toContain(stale);
    }
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

  it("documents /compact as the USER's command, not a tool of the avatar", () => {
    const page = readSystemManual("chat").text;
    expect(page).toContain("sending \`/compact\` as its own message");
    expect(page).toContain("The avatar cannot run it — suggest the command to the user.");
    expect(page).toContain("Editing an earlier message rewinds the conversation to it");
  });

  it("no longer documents background work (background tasks are disabled)", () => {
    expect(readSystemManual("chat").text).not.toContain("## Background work");
    const tasks = readSystemManual("external-tasks").text;
    expect(tasks).not.toContain("Background follow-up reports");
    expect(tasks).not.toContain("background phase");
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

  it("documents the share-link exception to conversation-scoped artifacts without claiming availability", () => {
    const page = readSystemManual("files-canvas").text;
    expect(page).toContain("Artifacts are scoped to their conversation, with one exception: a share link for a PPTX download card.");
    expect(page).toContain("speaker notes included");
    expect(page).toContain("1, 7 or 30 days, 7 by default, fixed at creation");
    // One active link per delivered CARD: a rebuilt deck delivered again is a
    // new card, and the earlier link keeps its earlier file (finding agent-1).
    expect(page).toContain("Each delivered deck card has at most one active link, and a link keeps opening the file it was made for");
    expect(page).toContain(
      "a rebuilt deck delivered again is a new card, so sharing it takes a new link, while the earlier link keeps showing the earlier version until it expires or is revoked",
    );
    expect(page).not.toContain("a deck has at most one active link");
    expect(page).toContain("It is a human-initiated export, like downloading the file and forwarding it");
    expect(page).toContain("내 아바타 → 권한·연결 → 공유 링크");
    // Availability stays a runtime fact, never a manual claim.
    expect(page).toContain("Whether the avatar can create one in this run is a runtime fact reported by describe_system.");
    expect(page).not.toContain("create_share_link");
    // The sentences that followed the scoping rule are unchanged.
    expect(page).toContain("Do not assume a local temporary file will become visible without publication.");
    // The compact index every prompt embeds did not grow a topic.
    expect(systemManualIndex(true)).not.toMatch(/share link/i);
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
