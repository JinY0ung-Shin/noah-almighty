// @vitest-environment jsdom
// Drafts that survive switching conversations (lib/chatDrafts.ts + the pane
// swaps in lib/chat.ts): what a draft holds, its key, restore, clear-on-send,
// deletion, the user boundary, and the beforeunload guard that is armed only
// while some draft has content.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closePane, forgetConversationWidgets, newChat, selectConversation, sendMessage, startNewChat } from "../src/client/src/lib/chat.js";
import {
  draftKey,
  hasUnsentDraft,
  resetDraftsForTest,
  setPaneDraft,
  setPaneRewindDraft,
  watchUnsentDrafts,
} from "../src/client/src/lib/chatDrafts.js";
import { appState, readState, replaceState, updateState } from "../src/client/src/lib/state.js";
import { DEFAULT_MCP_TOOL_GROUPS } from "../src/shared/mcpToolGroups.js";
import type { ChatPane, PendingDocument, PendingImage } from "../src/client/src/lib/types.js";

const PRISTINE = structuredClone(readState());

function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function row(id: string, role: "user" | "assistant", content: string, conversationId: string) {
  return { id, role, content, conversationId, createdAt: "t", response: role === "assistant" ? { kind: "text", runtime: "claude", text: content } : null };
}

/** Serves two stored conversations of avatar av1: c1 and c2. */
function serveConversations() {
  replaceState({
    conversations: [{ id: "c1", avatarUserId: "av1", isRoutine: false } as any, { id: "c2", avatarUserId: "av1", isRoutine: false } as any],
  });
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith("/api/messages")) {
      const id = new URL(url, "http://x").searchParams.get("conversationId") ?? "c1";
      return jsonRes({ messages: [row(`${id}-u`, "user", `${id} 질문`, id), row(`${id}-a`, "assistant", `${id} 답`, id)], canvases: [] });
    }
    if (url === "/api/avatars/av1") return jsonRes({ avatar: { id: "av1", alias: "노아", isOwn: true } });
    if (url.startsWith("/api/chat/runs")) return jsonRes({ run: null });
    if (url === "/api/conversations") return jsonRes({ conversations: readState().conversations });
    throw new Error(`unhandled fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Let the guard's coalesced check (a microtask) run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function active(): ChatPane {
  const s = readState();
  return s.chatPanes.find((p) => p.id === s.activePaneId)!;
}

const IMAGE: PendingImage = { id: "img1", dataUrl: "data:image/png;base64,AA==", name: "a.png", mediaType: "image/png" };
const DOC: PendingDocument = { id: "doc1", name: "a.pdf", size: 3, mediaType: "application/pdf", dataUrl: "data:application/pdf;base64,AA==" };
const READING: PendingDocument = { ...DOC, id: "doc2", name: "b.pdf", dataUrl: null };

function stage(paneId: string, patch: Partial<ChatPane>) {
  updateState((s) => Object.assign(s.chatPanes.find((p) => p.id === paneId)!, patch));
}

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  resetDraftsForTest();
  replaceState({ user: { id: "owner", roles: [] } as any });
  history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a draft survives switching conversations", () => {
  it("keeps text, staged files and an open edit for a conversation, and gives them back on return", async () => {
    serveConversations();
    await selectConversation("c1");
    const first = active();
    setPaneDraft(first.id, "쓰다 만 메시지");
    stage(first.id, { pendingImages: [IMAGE], pendingDocuments: [DOC, READING], rewindEdit: { messageId: "c1-u", draft: "고친 질문" } });

    await selectConversation("c2");
    // The other conversation starts clean.
    expect(active()).toMatchObject({ conversationId: "c2", draft: "" });
    expect(active().rewindEdit ?? null).toBeNull();
    expect(active().pendingImages ?? []).toEqual([]);

    await selectConversation("c1");
    const back = active();
    expect(back.id).not.toBe(first.id);
    expect(back.draft).toBe("쓰다 만 메시지");
    expect(back.pendingImages).toEqual([IMAGE]);
    // A document still being read cannot come along (its read lands on the dropped pane).
    expect(back.pendingDocuments).toEqual([DOC]);
    expect(back.rewindEdit).toEqual({ messageId: "c1-u", draft: "고친 질문" });
  });

  it("keeps the draft when the conversation on screen is opened again", async () => {
    serveConversations();
    await selectConversation("c1");
    setPaneDraft(active().id, "그대로");
    await selectConversation("c1");
    expect(active().draft).toBe("그대로");
  });

  it("is taken once: leaving again with an emptied composer leaves nothing behind", async () => {
    serveConversations();
    await selectConversation("c1");
    setPaneDraft(active().id, "임시");
    await selectConversation("c2");
    await selectConversation("c1");
    setPaneDraft(active().id, "");
    await selectConversation("c2");
    await selectConversation("c1");
    expect(active().draft).toBe("");
    expect(hasUnsentDraft()).toBe(false);
  });

  it("keys a never-sent new chat by its avatar: the next new chat with that avatar gets it back", async () => {
    serveConversations();
    await selectConversation("c1");
    newChat();
    const fresh = active();
    expect(draftKey(fresh)).toBe("new:av1");
    setPaneDraft(fresh.id, "새 대화 초안");
    await selectConversation("c2");
    expect(active().draft).toBe("");
    await startNewChat();
    expect(active().conversationId).not.toBe(fresh.conversationId);
    expect(active().draft).toBe("새 대화 초안");
  });

  it("keeps a closed split pane's draft for its conversation", async () => {
    serveConversations();
    await selectConversation("c1");
    const { addConversationToSplit } = await import("../src/client/src/lib/chat.js");
    await addConversationToSplit("c2");
    const second = active();
    setPaneDraft(second.id, "분할 창 초안");
    await closePane(second.id);
    expect(readState().chatPanes.map((p) => p.conversationId)).toEqual(["c1"]);
    await addConversationToSplit("c2");
    expect(active()).toMatchObject({ conversationId: "c2", draft: "분할 창 초안" });
  });

  it("drops a deleted conversation's draft for good", async () => {
    serveConversations();
    await selectConversation("c1");
    setPaneDraft(active().id, "지워질 대화의 초안");
    await selectConversation("c2");
    expect(hasUnsentDraft()).toBe(true);
    forgetConversationWidgets("c1");
    expect(hasUnsentDraft()).toBe(false);
    await selectConversation("c1");
    expect(active().draft).toBe("");
  });

  it("is cleared by sending it", async () => {
    serveConversations();
    await selectConversation("c1");
    setPaneDraft(active().id, "보낼 말");
    await selectConversation("c2");
    await selectConversation("c1");
    const paneId = active().id;
    expect(active().draft).toBe("보낼 말");
    const enc = new TextEncoder();
    const base = (globalThis.fetch as unknown as (input: unknown, init?: RequestInit) => Promise<unknown>).bind(globalThis);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        if (String(input) === "/api/chat/stream") {
          const frames = [
            ["open", { conversationId: "c1", runId: "r1" }],
            ["done", { message: row("c1-n", "assistant", "새 답", "c1") }],
          ];
          return {
            ok: true,
            status: 200,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                for (const [event, data] of frames) controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
                controller.close();
              },
            }),
            json: async () => ({}),
          };
        }
        return base(input, init);
      }),
    );
    await sendMessage(paneId, "보낼 말");
    expect(readState().chatPanes.find((p) => p.id === paneId)?.draft).toBe("");
    await selectConversation("c2");
    await selectConversation("c1");
    expect(active().draft).toBe("");
    expect(hasUnsentDraft()).toBe(false);
  });

  it("never shows one user's drafts to another user signing in on the same page", async () => {
    serveConversations();
    await selectConversation("c1");
    setPaneDraft(active().id, "owner의 초안");
    await selectConversation("c2");
    updateState((s) => {
      s.user = null;
      s.chatPanes = [];
      s.activePaneId = null;
    });
    replaceState({ user: { id: "someone-else", roles: [] } as any });
    expect(hasUnsentDraft()).toBe(false);
    await selectConversation("c1");
    expect(active().draft).toBe("");
  });
});

describe("typing writes the draft without publishing the app state", () => {
  it("changes the pane in place and leaves app-state subscribers alone", async () => {
    serveConversations();
    await selectConversation("c1");
    const paneId = active().id;
    let published = 0;
    const off = appState.subscribe(() => (published += 1));
    published = 0;
    setPaneDraft(paneId, "한 글자씩");
    setPaneRewindDraft(paneId, "열린 편집 없음 — 무시");
    off();
    expect(active().draft).toBe("한 글자씩");
    expect(active().rewindEdit ?? null).toBeNull();
    expect(published).toBe(0);
  });
});

describe("the leave-page prompt is armed only while a draft has content", () => {
  function fakeWindow() {
    const added: string[] = [];
    const removed: string[] = [];
    let listener: ((event: Event) => void) | null = null;
    return {
      added,
      removed,
      get listener() {
        return listener;
      },
      target: {
        addEventListener: (type: string, fn: (event: Event) => void) => {
          added.push(type);
          listener = fn;
        },
        removeEventListener: (type: string) => {
          removed.push(type);
          listener = null;
        },
      } as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
    };
  }

  it("registers on the first unsent text, stays through a switch, and unregisters once it is gone", async () => {
    serveConversations();
    await selectConversation("c1");
    const win = fakeWindow();
    const stop = watchUnsentDrafts(win.target);
    await settle();
    expect(win.added).toEqual([]);

    setPaneDraft(active().id, "   ");
    await settle();
    expect(win.added).toEqual([]); // whitespace is not work

    setPaneDraft(active().id, "초안");
    await settle();
    expect(win.added).toEqual(["beforeunload"]);
    const event = new Event("beforeunload", { cancelable: true });
    win.listener!(event);
    expect(event.defaultPrevented).toBe(true);

    // Stashed, not lost: the prompt stays.
    await selectConversation("c2");
    await settle();
    expect(win.removed).toEqual([]);

    await selectConversation("c1");
    setPaneDraft(active().id, "");
    await settle();
    expect(win.removed).toEqual(["beforeunload"]);

    // Staged files count too.
    stage(active().id, { pendingImages: [IMAGE] });
    await settle();
    expect(win.added).toEqual(["beforeunload", "beforeunload"]);
    stop();
    await settle();
    expect(win.removed).toEqual(["beforeunload", "beforeunload"]);
  });

  it("does not count an edit that still says what the message said", async () => {
    serveConversations();
    await selectConversation("c1");
    const win = fakeWindow();
    const stop = watchUnsentDrafts(win.target);
    stage(active().id, { rewindEdit: { messageId: "c1-u", draft: "c1 질문" } });
    await settle();
    expect(win.added).toEqual([]);
    setPaneRewindDraft(active().id, "c1 질문 (고침)");
    await settle();
    expect(win.added).toEqual(["beforeunload"]);
    stop();
  });

  it("is off while signed out", async () => {
    serveConversations();
    await selectConversation("c1");
    const win = fakeWindow();
    const stop = watchUnsentDrafts(win.target);
    setPaneDraft(active().id, "초안");
    await settle();
    expect(win.added).toHaveLength(1);
    updateState((s) => {
      s.user = null;
      s.chatPanes = [];
    });
    await settle();
    expect(win.removed).toHaveLength(1);
    stop();
  });
});
