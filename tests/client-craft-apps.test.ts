// @vitest-environment jsdom
// Craft apps (admin-only beta, spec P1 §7) on the client:
// - which `craft_*` tool groups the composer may offer (admin + toggle on +
//   that app's runner `ready`), and that they stay DEFAULT-OFF per conversation
//   (neither the registry default nor a remembered default carries one);
// - the `craft_preview` SSE frame showing its card in the side panel under the
//   app's Korean name, by the unified panel's follow rule (follow → take the
//   panel; the viewer picked a tab → a dot), one live tab per app, and never
//   re-opened by a replayed log or in split view.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachRun, openFileTab, startChatWith } from "../src/client/src/lib/chat.js";
import {
  CRAFT_TOOL_GROUP_IDS,
  craftAppLabelKo,
  craftAppsFromMe,
  hiddenCraftToolGroups,
  normalizeCraftApps,
  refreshCraftApps,
} from "../src/client/src/lib/craftApps.js";
import { resolveSideTab } from "../src/client/src/lib/sidePanel.js";
import { appState, readState, replaceState, toasts, updateState } from "../src/client/src/lib/state.js";
import { CRAFT_APPS } from "../src/shared/craftApps.js";
import { DEFAULT_MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";
import type { ChatPane } from "../src/client/src/lib/types.js";

const PRISTINE = structuredClone(readState());
const admin = { id: "owner", roles: ["admin"] } as any;
const member = { id: "member", roles: [] } as any;

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
  replaceState({ user: admin });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("craft tool-group availability", () => {
  const allReady = { enabled: true, apps: CRAFT_APPS.map((app) => ({ id: app.id, status: "ready" as const })) };

  it("covers exactly the four registry apps, labelled in Korean", () => {
    expect([...CRAFT_TOOL_GROUP_IDS].sort()).toEqual(
      ["craft_designcraft", "craft_figcraft", "craft_photocraft", "craft_vectorcraft"],
    );
    expect(craftAppLabelKo("photocraft")).toBe("포토크래프트");
    expect(craftAppLabelKo("unknown-app")).toBe("unknown-app");
  });

  it("hides every craft group unless an admin's feature is on and the app is ready", () => {
    expect([...hiddenCraftToolGroups(null, admin)].sort()).toEqual([...CRAFT_TOOL_GROUP_IDS].sort());
    expect(hiddenCraftToolGroups({ ...allReady, enabled: false }, admin).size).toBe(4);
    // A non-admin never sees them, whatever a stale craftApps says.
    expect(hiddenCraftToolGroups(allReady, member).size).toBe(4);
    expect(hiddenCraftToolGroups(allReady, null).size).toBe(4);
    const mixed = {
      enabled: true,
      apps: [
        { id: "photocraft", status: "ready" as const },
        { id: "vectorcraft", status: "failed" as const },
        { id: "designcraft", status: "unavailable" as const },
      ],
    };
    // figcraft is missing from the report → hidden too.
    expect([...hiddenCraftToolGroups(mixed, admin)].sort()).toEqual(
      ["craft_designcraft", "craft_figcraft", "craft_vectorcraft"],
    );
    expect(hiddenCraftToolGroups(allReady, admin).size).toBe(0);
  });

  it("parses /api/me's craftApps from the response or the user, failing closed", () => {
    const info = { enabled: true, apps: [{ id: "photocraft", status: "ready" }] };
    expect(craftAppsFromMe({ user: {}, craftApps: info })).toEqual(info);
    expect(craftAppsFromMe({ user: { craftApps: info } })).toEqual(info);
    expect(craftAppsFromMe({ user: {} })).toBeNull();
    expect(normalizeCraftApps({ enabled: "yes", apps: [{ id: "photocraft", status: "weird" }, null, { id: 3 }] })).toEqual({
      enabled: false,
      apps: [],
    });
  });

  it("a new conversation never gains a craft group, even from a remembered default", async () => {
    expect(DEFAULT_MCP_TOOL_GROUPS.some((id) => CRAFT_TOOL_GROUP_IDS.has(id))).toBe(false);
    replaceState({ user: { ...admin, mcpToolGroupsDefault: ["web", "craft_photocraft", "system"] } });
    const avatar = { id: "av-new", alias: "노아", displayName: "Noah", isOwn: true, runtime: "local" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ avatar, conversations: [], messages: [] }) })),
    );
    await startChatWith(avatar as any);
    const created = readState().chatPanes.at(-1)!;
    expect(created.mcpToolGroups).toEqual(["web", "system"]);
  });

  it("refreshes craftApps for admins only and keeps the last value on a failure", async () => {
    const info = { enabled: true, apps: [{ id: "photocraft", status: "ready" as const }] };
    await refreshCraftApps(async () => ({ user: admin, craftApps: info }));
    expect(readState().craftApps).toEqual(info);
    await refreshCraftApps(async () => {
      throw new Error("offline");
    });
    expect(readState().craftApps).toEqual(info);
    replaceState({ user: member, craftApps: null });
    const fetchMe = vi.fn(async () => ({ craftApps: info }));
    await refreshCraftApps(fetchMe);
    expect(fetchMe).not.toHaveBeenCalled();
    expect(readState().craftApps).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* craft_preview → side panel                                          */
/* ------------------------------------------------------------------ */

let paneSeq = 0;
function seedPane(overrides: Partial<ChatPane> = {}): string {
  const id = overrides.id ?? `craft-pane${++paneSeq}`;
  const pane = {
    id,
    avatar: { id: "av1", alias: "노아", displayName: "Noah", isOwn: true } as any,
    conversationId: `conv-${id}`,
    messages: [],
    draft: "",
    streaming: false,
    liveText: "",
    liveAttachments: [],
    liveTextBreakPending: false,
    liveThinking: "",
    thinkingActive: false,
    livePlan: "",
    planPending: false,
    planReview: null,
    planReviewSubmitting: false,
    liveStatus: "",
    liveRunId: null,
    liveAgents: [],
    liveTools: [],
    liveTasks: [],
    livePlugins: [],
    liveStatusStickyUntil: 0,
    groupKnowledgeOff: [],
    mcpToolGroups: [...DEFAULT_MCP_TOOL_GROUPS],
    canvases: [],
    sideTab: null,
    stickBottom: true,
    usage: null,
    abortController: null,
    ...overrides,
  } as ChatPane;
  updateState((s) => {
    s.chatPanes.push(pane);
    s.activePaneId = pane.id;
  });
  return id;
}

function pane(id: string): ChatPane {
  return readState().chatPanes.find((p) => p.id === id)!;
}

/** One read of a run's log, each frame carrying the server's numeric id. */
async function readLog(paneId: string, runId: string, frames: Array<[number, string, unknown]>): Promise<void> {
  const enc = new TextEncoder();
  const chunks = frames.map(([id, event, data]) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else {
        readState().chatPanes.find((p) => p.id === paneId)?.abortController?.abort();
        controller.close();
      }
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) =>
      String(input).includes(`/api/chat/runs/${runId}/events`)
        ? { ok: true, status: 200, body, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ ok: true }) },
    ),
  );
  await attachRun(paneId, runId);
}

/** The visible card + hidden slide pair the server publishes for one preview. */
function preview(n: number) {
  const card = { id: `pc-${n}`, kind: "file", mediaType: "image/png", name: `미리보기 ${n}.png`, size: 10 };
  const slide = { id: `pc-${n}-s`, kind: "image", mediaType: "image/png", name: `미리보기 ${n}.png`, hidden: true, parentId: card.id };
  return { card, slide };
}

/** Frames for preview `n` starting at frame id `at`: file, file, craft_preview. */
function previewFrames(n: number, at: number, runId: string): Array<[number, string, unknown]> {
  const { card, slide } = preview(n);
  return [
    [at, "file", { runId, attachment: card }],
    [at + 1, "file", { runId, attachment: slide }],
    [at + 2, "craft_preview", { runId, app: "photocraft", attachmentId: card.id }],
  ];
}

describe("craft_preview", () => {
  it("a following pane shows the card under the app's Korean name, with its slide", async () => {
    const id = seedPane();
    await readLog(id, "run-c1", previewFrames(1, 1, "run-c1"));
    const tabs = pane(id).fileTabs ?? [];
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      attachment: { id: "pc-1" },
      craftApp: "photocraft",
      label: "포토크래프트 · 미리보기 1.png",
    });
    expect(tabs[0].slides.map((s) => s.id)).toEqual(["pc-1-s"]);
    expect(resolveSideTab(pane(id))).toEqual({ kind: "file", id: "pc-1" });
    // Left the collapsed strip (or SidePanel consumed the one-shot already).
    expect(pane(id).sideUnseen ?? []).toEqual([]);
  });

  it("does not take the panel from a tab the viewer picked — the preview gets a dot", async () => {
    const canvas = { id: "cv1", title: "캔버스", contentType: "markdown", content: "x", currentVersion: 1, versionCount: 1 } as any;
    const id = seedPane({ canvases: [canvas], sideTab: { kind: "canvas", id: "cv1" }, sideFollow: false });
    await readLog(id, "run-c2", previewFrames(1, 1, "run-c2"));
    expect(pane(id).fileTabs?.map((tab) => tab.attachment.id)).toEqual(["pc-1"]);
    expect(pane(id).sideTab).toEqual({ kind: "canvas", id: "cv1" });
    expect(pane(id).sideUnseen).toEqual(["file:pc-1"]);
    expect(pane(id).sideExpand).toBeFalsy();
  });

  it("the next preview of the same app replaces its live tab in place", async () => {
    const id = seedPane();
    const frames = [...previewFrames(1, 1, "run-c3"), ...previewFrames(2, 4, "run-c3")];
    await readLog(id, "run-c3", frames);
    expect(pane(id).fileTabs?.map((tab) => tab.attachment.id)).toEqual(["pc-2"]);
    expect(pane(id).fileTabs?.[0].slides.map((s) => s.id)).toEqual(["pc-2-s"]);
    expect(resolveSideTab(pane(id))).toEqual({ kind: "file", id: "pc-2" });
  });

  it("a replaced live tab the viewer is looking at keeps showing, without a dot", async () => {
    const id = seedPane();
    await readLog(id, "run-c4", previewFrames(1, 1, "run-c4"));
    // The viewer picks the live tab from the strip → no longer following.
    updateState((s) => {
      const p = s.chatPanes.find((item) => item.id === id)!;
      p.sideTab = { kind: "file", id: "pc-1" };
      p.sideFollow = false;
    });
    await readLog(id, "run-c4", [...previewFrames(1, 1, "run-c4"), ...previewFrames(2, 4, "run-c4")]);
    expect(pane(id).sideTab).toEqual({ kind: "file", id: "pc-2" });
    expect(pane(id).sideUnseen ?? []).toEqual([]);
  });

  it("a card the viewer opened is never swapped away by the next preview", async () => {
    const id = seedPane();
    await readLog(id, "run-c5", previewFrames(1, 1, "run-c5"));
    const { card, slide } = preview(1);
    openFileTab(id, card as any, [slide as any]);
    await readLog(id, "run-c5", [...previewFrames(1, 1, "run-c5"), ...previewFrames(2, 4, "run-c5")]);
    expect(pane(id).fileTabs?.map((tab) => tab.attachment.id)).toEqual(["pc-1", "pc-2"]);
    // The viewer's pick stopped the follow: their tab stays, the new one gets a dot.
    expect(pane(id).sideTab).toEqual({ kind: "file", id: "pc-1" });
    expect(pane(id).sideUnseen).toEqual(["file:pc-2"]);
  });

  it("a replayed log never re-opens a preview tab the viewer closed", async () => {
    const id = seedPane();
    const log = previewFrames(1, 1, "run-c6");
    await readLog(id, "run-c6", log);
    updateState((s) => {
      const p = s.chatPanes.find((item) => item.id === id)!;
      p.fileTabs = [];
      p.sideTab = null;
    });
    await readLog(id, "run-c6", log);
    expect(pane(id).fileTabs).toEqual([]);
  });

  it("a split pane keeps the preview as a plain card", async () => {
    seedPane();
    const id = seedPane();
    await readLog(id, "run-c7", previewFrames(1, 1, "run-c7"));
    expect(pane(id).fileTabs ?? []).toEqual([]);
    expect(pane(id).liveAttachments.map((att) => att.id)).toEqual(["pc-1", "pc-1-s"]);
  });

  it("ignores a frame whose card never arrived", async () => {
    const id = seedPane();
    await readLog(id, "run-c8", [[1, "craft_preview", { runId: "run-c8", app: "photocraft", attachmentId: "missing" }]]);
    expect(pane(id).fileTabs ?? []).toEqual([]);
  });
});
