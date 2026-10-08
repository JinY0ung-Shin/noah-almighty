// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";

import {
  activePane,
  appState,
  dismissToast,
  newId,
  notify,
  pauseToast,
  readState,
  replaceState,
  resumeToast,
  setDocumentTitle,
  toasts,
  updateState,
} from "../src/client/src/lib/state.js";
import { consumeSse } from "../src/client/src/lib/sse.js";
import { api, refreshMe, setSessionExpiredHandler } from "../src/client/src/lib/api.js";
import {
  ensureNotificationPermission,
  notificationsSupported,
  osNotify,
} from "../src/client/src/lib/notifications.js";
import {
  SLASH_COMMANDS,
  commandsForPane,
  isCompactCommandText,
  filterSlashCommands,
  menuCommandsForPane,
  resolveTypedSlashCommand,
  skillToSlashCommand,
} from "../src/client/src/lib/slash.js";
import { TOUR_SLUG_LIST } from "../src/shared/tourScenarios.js";
import {
  applyInitialRoute,
  currentRoute,
  goView,
  installRouteListener,
  routeFromHash,
  syncHash,
} from "../src/client/src/lib/nav.js";
import { recordKnowledgeViaAvatar } from "../src/client/src/lib/knowledge.js";
import {
  allowlistSeed,
  bridgeVersionVerdict,
  compareBridgeVersions,
  extensionSupportsSecretInput,
  SECRET_INPUT_MIN_EXTENSION_VERSION,
} from "../src/client/src/lib/browserBridge.js";
import { defaultAllowlistFor, patternMatchesHost } from "../src/shared/originPatterns.js";
import {
  clearExtensionDir,
  ensureDirPermission,
  extensionIdFromManifestKey,
  fsaSupported,
  loadSavedExtensionDir,
  mergeManifestOrigins,
  pickExtensionDir,
  saveExtensionDir,
  updateExtensionInPlace,
  verifyExtensionDir,
  writeExtensionFiles,
} from "../src/client/src/lib/browserBridgeInstall.js";
import {
  loadAdminGroups,
  loadAdminOverview,
  loadAvatars,
  loadConversations,
  loadInboxData,
  loadRoutinesData,
  loadSettingsData,
  refreshKnowledgeStatus,
  refreshNotificationStatus,
  startKnowledgeWatch,
  stopKnowledgeWatch,
} from "../src/client/src/lib/loaders.js";
import {
  avatarGradient,
  avatarImageUrl,
  countdownLabel,
  formatRoutineSchedule,
  relativeDayTimeLabel,
  formatTokenCount,
  hashHue,
  initials,
  minuteToTime,
  normalizeTags,
  renderMarkdown,
  renderMarkdownCached,
  repoToHref,
  routineTitle,
  timeLabel,
  timeToMinute,
} from "../src/client/src/lib/format.js";

/* ------------------------------------------------------------------ */
/* shared fixtures + fetch stubbing                                    */
/* ------------------------------------------------------------------ */

// Pristine store snapshot captured before any test mutates the singleton.
const PRISTINE = structuredClone(readState());

type FetchHandler = (url: string, init: RequestInit) => unknown;

/** Route fetch calls through `handler`; returning undefined signals an unmocked URL. */
function useFetch(handler: FetchHandler) {
  const fn = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const res = handler(String(input), init);
    if (res === undefined) throw new Error(`unhandled fetch: ${String(input)}`);
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function jsonRes(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

function sseRes(chunks: string[], status = 200) {
  return { ok: status >= 200 && status < 300, status, body: streamFrom(chunks), json: async () => ({}) };
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
  // Clear any residual hash so nav routing starts from a known base.
  history.replaceState(null, "", "/");
  setSessionExpiredHandler(() => {});
});

afterEach(() => {
  // stopKnowledgeWatch also zeroes the module-level announce baselines.
  stopKnowledgeWatch();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* state.ts                                                            */
/* ------------------------------------------------------------------ */

describe("state store", () => {
  it("updateState mutates in place and recomputes `streaming` from panes", () => {
    updateState((s) => {
      s.chatPanes = [{ id: "p1", streaming: false } as any];
    });
    expect(readState().streaming).toBe(false);
    updateState((s) => {
      s.chatPanes[0].streaming = true;
    });
    expect(readState().streaming).toBe(true);
  });

  it("replaceState merges a partial and recomputes `streaming`", () => {
    replaceState({ view: "inbox", chatPanes: [{ id: "p", streaming: true } as any] });
    const s = readState();
    expect(s.view).toBe("inbox");
    expect(s.streaming).toBe(true);
  });

  it("activePane returns the active pane, else the first, else null", () => {
    expect(activePane()).toBeNull();
    updateState((s) => {
      s.chatPanes = [{ id: "a" } as any, { id: "b" } as any];
      s.activePaneId = "b";
    });
    expect(activePane()?.id).toBe("b");
    updateState((s) => {
      s.activePaneId = "nope";
    });
    // Falls back to the first pane when the active id no longer matches.
    expect(activePane()?.id).toBe("a");
  });

  it("newId yields unique ids and falls back when crypto.randomUUID is absent", () => {
    expect(newId()).not.toBe(newId());
    vi.stubGlobal("crypto", {});
    const id = newId();
    expect(id).toContain("-");
    expect(typeof id).toBe("string");
  });

  it("notify pushes a toast, defaults kind to warn, and caps the list at four", () => {
    notify("첫 경고");
    const first = get(toasts)[0];
    expect(first.kind).toBe("warn");
    expect(first.message).toBe("첫 경고");
    for (let i = 0; i < 5; i++) notify(`m${i}`, "info");
    expect(get(toasts)).toHaveLength(4);
  });

  it("notify with an action gets the longer duration and auto-dismisses on timeout", () => {
    vi.useFakeTimers();
    const action = vi.fn();
    notify("작업 알림", "info", { actionLabel: "열기", action });
    const toast = get(toasts).at(-1)!;
    expect(toast.actionLabel).toBe("열기");
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(9000);
    expect(get(toasts)).toHaveLength(0);
  });

  it("keeps a toast alive while paused and resumes only the remaining timeout", () => {
    vi.useFakeTimers();
    notify("읽는 중인 알림", "info", { durationMs: 1000 });
    const toast = get(toasts)[0];

    vi.advanceTimersByTime(400);
    pauseToast(toast.id);
    vi.advanceTimersByTime(2000);
    expect(get(toasts).map((item) => item.id)).toContain(toast.id);

    resumeToast(toast.id);
    vi.advanceTimersByTime(599);
    expect(get(toasts).map((item) => item.id)).toContain(toast.id);
    vi.advanceTimersByTime(1);
    expect(get(toasts).map((item) => item.id)).not.toContain(toast.id);
  });

  it("dismissToast removes a toast by id", () => {
    notify("사라질 토스트", "ok");
    const id = get(toasts)[0].id;
    dismissToast(id);
    expect(get(toasts)).toHaveLength(0);
  });

  it("setDocumentTitle reflects streaming / logged-out / per-view titles", () => {
    setDocumentTitle();
    expect(document.title).toBe("Noah Almighty");
    replaceState({ user: { id: "u", roles: [] } as any, view: "explore" });
    setDocumentTitle();
    expect(document.title).toBe("탐색 · Noah Almighty");
    updateState((s) => {
      s.chatPanes = [{ id: "p", streaming: true, avatar: { alias: "노아" } } as any];
    });
    setDocumentTitle();
    expect(document.title).toBe("● 응답 중 · Noah Almighty");
  });
});

/* ------------------------------------------------------------------ */
/* sse.ts                                                              */
/* ------------------------------------------------------------------ */

describe("consumeSse", () => {
  async function collect(chunks: string[]) {
    const frames: { event: string; id: string; data: any }[] = [];
    await consumeSse(streamFrom(chunks), (f) => frames.push(f));
    return frames;
  }

  it("parses id / event / JSON-data frames", async () => {
    const frames = await collect([
      "id: 1\nevent: open\ndata: {\"conversationId\":\"c1\"}\n\n",
      "event: delta\ndata: {\"text\":\"hi\"}\n\n",
    ]);
    expect(frames).toEqual([
      { id: "1", event: "open", data: { conversationId: "c1" } },
      { id: "", event: "delta", data: { text: "hi" } },
    ]);
  });

  it("joins multi-line data, strips CR, and ignores comment/blank lines", async () => {
    const frames = await collect([": keep-alive\nevent: note\ndata: line1\r\ndata: line2\n\n"]);
    expect(frames).toHaveLength(1);
    // Non-JSON payload → wrapped as { text }, newline-joined.
    expect(frames[0]).toEqual({ id: "", event: "note", data: { text: "line1\nline2" } });
  });

  it("flushes a trailing frame that has no terminating blank line", async () => {
    const frames = await collect(["event: done\ndata: {\"ok\":true}"]);
    expect(frames).toEqual([{ id: "", event: "done", data: { ok: true } }]);
  });

  it("reassembles a frame split across stream reads", async () => {
    const frames = await collect(["event: delta\nda", "ta: {\"text\":\"split\"}\n\n"]);
    expect(frames).toEqual([{ id: "", event: "delta", data: { text: "split" } }]);
  });

  it("drops a frame that carries no data line", async () => {
    const frames = await collect(["event: ping\n\n"]);
    expect(frames).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* api.ts                                                              */
/* ------------------------------------------------------------------ */

describe("api()", () => {
  it("returns the parsed body on success", async () => {
    useFetch((url) => (url === "/api/thing" ? jsonRes({ value: 42 }) : undefined));
    await expect(api<{ value: number }>("/api/thing")).resolves.toEqual({ value: 42 });
  });

  it("maps a known server error to Korean, else surfaces the raw error", async () => {
    useFetch(() => jsonRes({ error: "Authentication required" }, 403));
    await expect(api("/x")).rejects.toThrow("로그인이 필요합니다.");
    useFetch(() => jsonRes({ error: "custom boom" }, 400));
    await expect(api("/x")).rejects.toThrow("custom boom");
  });

  it("uses a generic coded message when the body has no error string", async () => {
    useFetch(() => jsonRes({}, 500));
    await expect(api("/x")).rejects.toThrow("코드 500");
  });

  it("fires the session-expired handler on 401 while logged in", async () => {
    replaceState({ user: { id: "u" } as any });
    const onExpire = vi.fn();
    setSessionExpiredHandler(onExpire);
    useFetch(() => jsonRes({}, 401));
    await expect(api("/x")).rejects.toThrow("세션이 만료되었습니다");
    expect(onExpire).toHaveBeenCalledOnce();
  });

  it("treats a 401 as a normal error when logged out", async () => {
    const onExpire = vi.fn();
    setSessionExpiredHandler(onExpire);
    useFetch(() => jsonRes({}, 401));
    await expect(api("/x")).rejects.toThrow("코드 401");
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("translates a fetch TimeoutError and a network failure; rethrows AbortError", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    await expect(api("/x")).rejects.toThrow("요청 시간이 초과되었습니다");

    vi.stubGlobal("fetch", async () => {
      throw new Error("boom");
    });
    await expect(api("/x")).rejects.toThrow("서버에 연결할 수 없습니다");

    const abortErr = Object.assign(new Error("stop"), { name: "AbortError" });
    vi.stubGlobal("fetch", async () => {
      throw abortErr;
    });
    await expect(api("/x")).rejects.toBe(abortErr);
  });

  it("refreshMe stores the returned user", async () => {
    useFetch((url) => (url === "/api/me" ? jsonRes({ user: { id: "me", roles: [] } }) : undefined));
    await refreshMe();
    expect(readState().user?.id).toBe("me");
  });
});

/* ------------------------------------------------------------------ */
/* notifications.ts                                                    */
/* ------------------------------------------------------------------ */

class MockNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  static instances: MockNotification[] = [];
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    MockNotification.instances.push(this);
  }
}

function stubNotification(permission: NotificationPermission = "granted") {
  MockNotification.permission = permission;
  MockNotification.instances = [];
  MockNotification.requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  vi.stubGlobal("Notification", MockNotification);
}

describe("notifications", () => {
  it("notificationsSupported reflects the Notification global", () => {
    expect(notificationsSupported()).toBe(false);
    stubNotification();
    expect(notificationsSupported()).toBe(true);
  });

  it("ensureNotificationPermission only prompts while permission is default", async () => {
    stubNotification("granted");
    await ensureNotificationPermission();
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();

    stubNotification("default");
    await ensureNotificationPermission();
    expect(MockNotification.requestPermission).toHaveBeenCalledOnce();
  });

  it("ensureNotificationPermission swallows a throwing requestPermission", async () => {
    stubNotification("default");
    MockNotification.requestPermission = vi.fn(async () => {
      throw new Error("legacy callback form");
    });
    await expect(ensureNotificationPermission()).resolves.toBeUndefined();
  });

  it("osNotify no-ops without permission or while the app is focused", () => {
    stubNotification("default"); // not granted
    osNotify("t", "b");
    expect(MockNotification.instances).toHaveLength(0);

    stubNotification("granted");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    osNotify("t", "b");
    expect(MockNotification.instances).toHaveLength(0);
  });

  it("osNotify constructs a Notification when backgrounded, wiring onclick to focus", () => {
    stubNotification("granted");
    vi.spyOn(document, "hasFocus").mockReturnValue(false); // backgrounded
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    osNotify("제목", "본문", "tag-1");
    expect(MockNotification.instances).toHaveLength(1);
    const note = MockNotification.instances[0];
    expect(note.title).toBe("제목");
    expect(note.options).toMatchObject({ body: "본문", tag: "tag-1", renotify: true });
    note.onclick?.();
    expect(focus).toHaveBeenCalled();
    expect(note.close).toHaveBeenCalled();
  });

  it("osNotify swallows a throwing Notification constructor", () => {
    class Throwing {
      static permission = "granted";
      constructor() {
        throw new Error("android without SW");
      }
    }
    vi.stubGlobal("Notification", Throwing);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    expect(() => osNotify("t", "b")).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* slash.ts                                                            */
/* ------------------------------------------------------------------ */

describe("slash commands", () => {
  const ownPane = { avatar: { id: "me", isOwn: true } } as any;
  const otherPane = { avatar: { id: "other", isOwn: false } } as any;

  it("hides owner-only commands unless the pane belongs to the owner", () => {
    const guest = commandsForPane(otherPane).map((c) => c.name);
    expect(guest).toContain("summarize");
    expect(guest).not.toContain("remember");

    const owner = commandsForPane(ownPane).map((c) => c.name);
    expect(owner).toContain("remember");
    expect(owner).toContain("learn");
  });

  it("treats a pane whose avatar id equals the current user as owner-owned", () => {
    replaceState({ user: { id: "u1" } as any });
    const pane = { avatar: { id: "u1", isOwn: false } } as any;
    expect(commandsForPane(pane).map((c) => c.name)).toContain("remember");
  });

  it("offers /tour to the owner only, naming the scenarios from the shared contract", () => {
    expect(commandsForPane(otherPane).map((c) => c.name)).not.toContain("tour");

    const tour = commandsForPane(ownPane).find((c) => c.name === "tour");
    // requiresArgs gives it the /remember UX: the menu seeds "/tour " and waits.
    expect(tour).toMatchObject({ argsLabel: "시나리오", requiresArgs: true });
    // Read from src/shared, never hand-copied — a new scenario must show up here
    // without anyone remembering to edit the menu entry.
    expect(tour?.description).toContain(TOUR_SLUG_LIST);
    expect(resolveTypedSlashCommand(ownPane, "/tour browser")).toMatchObject({
      command: { name: "tour" },
      args: "browser",
    });
  });

  it("offers /compact on every local avatar pane — the owner's and a colleague's — but never on an external one", () => {
    const compact = commandsForPane(otherPane).find((c) => c.name === "compact");
    expect(compact).toMatchObject({
      title: "대화 맥락 정리",
      argsLabel: "남길 내용",
      description: "지금까지의 대화를 요약해 컨텍스트를 줄입니다. 뒤에 적은 내용은 요약에 꼭 남길 것으로 전달됩니다.",
    });
    // Optional args: "/compact" alone is a complete command, sent as the literal.
    expect(compact?.requiresArgs).toBeFalsy();
    expect(compact?.ownerOnly).toBeFalsy();
    expect(commandsForPane(ownPane).map((c) => c.name)).toContain("compact");
    expect(resolveTypedSlashCommand(otherPane, "/compact  결정 사항은 남겨줘 ")).toMatchObject({
      command: { name: "compact" },
      args: "결정 사항은 남겨줘",
    });
    // The gateway behind an external avatar has no such command.
    const externalPane = { avatar: { id: "external:gw", isOwn: false, runtime: "external" } } as any;
    expect(commandsForPane(externalPane).map((c) => c.name)).not.toContain("compact");
    expect(commandsForPane(externalPane).map((c) => c.name)).toContain("summarize");
    expect(resolveTypedSlashCommand(externalPane, "/compact")).toBeNull();
  });

  it("recognizes the /compact text itself, with or without what to keep", () => {
    expect(isCompactCommandText("/compact")).toBe(true);
    expect(isCompactCommandText("  /compact 결정 사항은 남겨줘")).toBe(true);
    expect(isCompactCommandText("/COMPACT")).toBe(true);
    expect(isCompactCommandText("/compactify")).toBe(false);
    expect(isCompactCommandText("compact")).toBe(false);
    expect(isCompactCommandText("요약해줘 /compact")).toBe(false);
    expect(isCompactCommandText(undefined)).toBe(false);
  });

  it("resolves a typed slash command with trimmed args, rejecting //, unknown, and non-slash text", () => {
    expect(resolveTypedSlashCommand(ownPane, "/new")).toMatchObject({ command: { name: "new" }, args: "" });
    expect(resolveTypedSlashCommand(ownPane, "/remember   기억할 것  ")).toMatchObject({
      command: { name: "remember" },
      args: "기억할 것",
    });
    expect(resolveTypedSlashCommand(ownPane, "//literal")).toBeNull();
    expect(resolveTypedSlashCommand(ownPane, "/nope")).toBeNull();
    expect(resolveTypedSlashCommand(ownPane, "just text")).toBeNull();
    // owner-only command is unresolvable from a guest pane
    expect(resolveTypedSlashCommand(otherPane, "/remember x")).toBeNull();
  });

  it("skillToSlashCommand builds a menu entry whose prompt names the skill", () => {
    const cmd = skillToSlashCommand({ name: "deep-research", description: "리서치", source: "core" } as any);
    expect(cmd).toMatchObject({ name: "deep-research", kind: "skill", source: "core" });
    expect(cmd.prompt?.("")).toContain('"deep-research"');
    expect(cmd.prompt?.("추가 지시")).toContain("추가 지시");
  });

  it("menuCommandsForPane appends installed skills to the built-ins", () => {
    const pane = { avatar: { id: "me", isOwn: true }, skills: [{ name: "wrap-up", description: "d" }] } as any;
    const names = menuCommandsForPane(pane).map((c) => c.name);
    expect(names).toContain("summarize");
    expect(names).toContain("wrap-up");
  });

  it("filterSlashCommands matches across name/title/description/source and returns all on empty query", () => {
    expect(filterSlashCommands(SLASH_COMMANDS, "")).toBe(SLASH_COMMANDS);
    // "요약" is /summarize's title AND part of /compact's description.
    const byTitle = filterSlashCommands(SLASH_COMMANDS, "요약");
    expect(byTitle.map((c) => c.name)).toEqual(["summarize", "compact"]);
    expect(filterSlashCommands(SLASH_COMMANDS, "맥락 정리").map((c) => c.name)).toEqual(["compact"]);
  });
});

/* ------------------------------------------------------------------ */
/* nav.ts                                                              */
/* ------------------------------------------------------------------ */

describe("nav routing", () => {
  it("routeFromHash parses valid views + args and rejects bad ones", () => {
    history.replaceState(null, "", "#/settings/access");
    expect(routeFromHash()).toEqual({ view: "settings", arg: "access" });
    history.replaceState(null, "", "#/bogus");
    expect(routeFromHash()).toEqual({ view: null, arg: null });
    history.replaceState(null, "", "#/chat/%E2%9C%93");
    expect(routeFromHash()).toEqual({ view: "chat", arg: "✓" });
    // A share link's viewer (#/share/<token>); the token pins live in client-share-links.
    history.replaceState(null, "", "#/share/Ab3_-token");
    expect(routeFromHash()).toEqual({ view: "share", arg: "Ab3_-token" });
    // malformed percent-encoding decodes to null rather than throwing
    history.replaceState(null, "", "#/chat/%E0%A4%A");
    expect(routeFromHash()).toEqual({ view: "chat", arg: null });
    // legacy 그룹-tab hashes redirect to the merged 그룹 view
    history.replaceState(null, "", "#/settings/groups");
    expect(routeFromHash()).toEqual({ view: "groups", arg: null });
    history.replaceState(null, "", "#/admin/groups");
    expect(routeFromHash()).toEqual({ view: "groups", arg: null });
  });

  it("currentRoute renders the per-view hash from store state", () => {
    replaceState({ view: "settings", settingsTab: "knowledge" });
    expect(currentRoute()).toBe("#/settings/knowledge");
    replaceState({ view: "admin", adminTab: "audit" });
    expect(currentRoute()).toBe("#/admin/audit");
    replaceState({ view: "admin", adminTab: "external-agents" });
    expect(currentRoute()).toBe("#/admin/external-agents");
    replaceState({ view: "brain", brainSource: "group:42" });
    expect(currentRoute()).toBe("#/brain/group%3A42");
    replaceState({ view: "brain", brainSource: "personal" });
    expect(currentRoute()).toBe("#/brain");
    replaceState({
      view: "chat",
      chatPanes: [{ id: "p", conversationId: "conv7" } as any],
      activePaneId: "p",
    });
    expect(currentRoute()).toBe("#/chat/conv7");
  });

  it("syncHash pushes the target only for a logged-in user with a changed hash", () => {
    const push = vi.spyOn(history, "pushState");
    replaceState({ user: null, view: "explore" });
    syncHash();
    expect(push).not.toHaveBeenCalled(); // no user → no-op

    replaceState({ user: { id: "u" } as any, view: "explore" });
    syncHash();
    expect(push).toHaveBeenCalledWith(null, "", "#/explore");
    push.mockClear();
    // Now the hash already matches the target → no second push.
    syncHash();
    expect(push).not.toHaveBeenCalled();
  });

  it("goView switches views and redirects a non-admin away from admin", () => {
    replaceState({ user: { id: "u", roles: [] } as any });
    goView("admin");
    expect(readState().view).toBe("explore");

    replaceState({ user: { id: "u", roles: ["admin"] } as any });
    goView("admin", "system");
    expect(readState()).toMatchObject({ view: "admin", adminTab: "system" });

    goView("settings", "knowledge");
    expect(readState()).toMatchObject({ view: "settings", settingsTab: "knowledge" });

    goView("groups");
    expect(readState().view).toBe("groups");
  });

  it("applyInitialRoute hydrates the store from the current hash", () => {
    replaceState({ user: { id: "u", roles: [] } as any });
    history.replaceState(null, "", "#/routines/conv9");
    applyInitialRoute();
    expect(readState()).toMatchObject({ view: "routines", routineConversationId: "conv9" });
  });

  it("applyInitialRoute rewrites a legacy groups alias in place", () => {
    replaceState({ user: { id: "u", roles: [] } as any });
    history.replaceState(null, "", "#/settings/groups");
    applyInitialRoute();
    expect(readState().view).toBe("groups");
    expect(location.hash).toBe("#/groups");
    // non-alias hashes are left untouched (chat deep-links stay intact)
    history.replaceState(null, "", "#/chat/conv7");
    applyInitialRoute();
    expect(location.hash).toBe("#/chat/conv7");
  });

  it("applyInitialRoute keeps a real screen for a bookmark to a view or tab that no longer exists", () => {
    replaceState({ user: { id: "u", roles: ["admin"] } as any, view: "explore", settingsTab: "profile" });
    // An unknown view parses as no route at all, so the boot view (탐색) stays.
    history.replaceState(null, "", "#/retired-view/some-id");
    applyInitialRoute();
    expect(readState().view).toBe("explore");
    // An unknown settings tab opens 설정 on the tab it already had, never a blank panel.
    history.replaceState(null, "", "#/settings/retired-tab");
    applyInitialRoute();
    expect(readState()).toMatchObject({ view: "settings", settingsTab: "profile" });
  });

  it("installRouteListener updates state on hashchange and invokes the chat callback", () => {
    replaceState({ user: { id: "u", roles: [] } as any });
    const onChat = vi.fn();
    const cleanup = installRouteListener(onChat);
    history.replaceState(null, "", "#/chat/conv-live");
    window.dispatchEvent(new Event("hashchange"));
    expect(readState().view).toBe("chat");
    expect(onChat).toHaveBeenCalledWith("conv-live");

    cleanup();
    onChat.mockClear();
    history.replaceState(null, "", "#/chat/conv-after-cleanup");
    window.dispatchEvent(new Event("hashchange"));
    expect(onChat).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* knowledge.ts                                                        */
/* ------------------------------------------------------------------ */

describe("recordKnowledgeViaAvatar", () => {
  const request = { id: "req1", question: "배포 절차는?", askerName: "지수" } as any;

  beforeEach(() => {
    localStorage.clear();
  });

  it("requires a logged-in avatar", async () => {
    const res = await recordKnowledgeViaAvatar(request, "답");
    expect(res).toEqual({ ok: false, error: "로그인이 필요합니다." });
  });

  it("streams the recording turn, persists the conversation id, and titles it", async () => {
    replaceState({ user: { id: "owner1" } as any });
    const calls: string[] = [];
    useFetch((url, init) => {
      calls.push(`${(init as any).method || "GET"} ${url}`);
      if (url === "/api/chat/stream") {
        return sseRes([frame("open", { conversationId: "kc1", runId: "r1" })]);
      }
      if (url.startsWith("/api/conversations/")) return jsonRes({ ok: true });
      return undefined;
    });
    const res = await recordKnowledgeViaAvatar(request, "배포는 이렇게");
    expect(res).toEqual({ ok: true });
    expect(localStorage.getItem("knowledgeRecConv:owner1")).toBe("kc1");
    expect(calls).toContain("PATCH /api/conversations/kc1");
  });

  it("auto-denies an unexpected permission prompt and cancels a question", async () => {
    replaceState({ user: { id: "owner2" } as any });
    const responded: any[] = [];
    useFetch((url, init) => {
      if (url === "/api/chat/stream") {
        return sseRes([
          frame("open", { conversationId: "kc2", runId: "r2" }),
          frame("permission", { requestId: "perm1" }),
          frame("question", { requestId: "q1" }),
        ]);
      }
      if (url === "/api/chat/respond") {
        responded.push(JSON.parse((init as any).body));
        return jsonRes({ ok: true });
      }
      if (url.startsWith("/api/conversations/")) return jsonRes({ ok: true });
      return undefined;
    });
    const res = await recordKnowledgeViaAvatar(request, "내용");
    expect(res.ok).toBe(true);
    expect(responded).toContainEqual(expect.objectContaining({ requestId: "perm1", value: { behavior: "deny" } }));
    expect(responded).toContainEqual(expect.objectContaining({ requestId: "q1", value: { cancelled: true } }));
  });

  it("returns the error carried by an SSE error frame", async () => {
    replaceState({ user: { id: "owner3" } as any });
    useFetch((url) =>
      url === "/api/chat/stream" ? sseRes([frame("error", { error: "기록 실패" })]) : undefined,
    );
    expect(await recordKnowledgeViaAvatar(request, "x")).toEqual({ ok: false, error: "기록 실패" });
  });

  it("maps a 401 and a non-ok stream open to a friendly error", async () => {
    replaceState({ user: { id: "owner4" } as any });
    useFetch(() => sseRes([], 401));
    expect(await recordKnowledgeViaAvatar(request, "x")).toEqual({ ok: false, error: "세션이 만료되었습니다." });

    useFetch(() => ({ ok: false, status: 500, body: null, json: async () => ({ error: "서버 터짐" }) }));
    expect(await recordKnowledgeViaAvatar(request, "x")).toEqual({ ok: false, error: "서버 터짐" });
  });

  it("rejects a concurrent second recording while one is in flight", async () => {
    replaceState({ user: { id: "owner5" } as any });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    useFetch(async (url) => {
      if (url === "/api/chat/stream") {
        await gate;
        return sseRes([frame("open", { conversationId: "kc5", runId: "r5" })]);
      }
      if (url.startsWith("/api/conversations/")) return jsonRes({ ok: true });
      return undefined;
    });
    const first = recordKnowledgeViaAvatar(request, "첫 기록");
    const second = await recordKnowledgeViaAvatar(request, "둘째 기록");
    expect(second.ok).toBe(false);
    expect(second.error).toContain("다른 기록 요청");
    release();
    expect((await first).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* loaders.ts                                                          */
/* ------------------------------------------------------------------ */

describe("loaders", () => {
  it("loadAvatars fetches once, caches, honors force, and clears loading on error", async () => {
    let hits = 0;
    useFetch((url) => {
      if (url === "/api/avatars") {
        hits++;
        return jsonRes({ avatars: [{ id: "a1" }] });
      }
      return undefined;
    });
    const first = await loadAvatars();
    expect(first).toEqual([{ id: "a1" }]);
    expect(readState()).toMatchObject({ avatarsLoaded: true, avatarsLoading: false });
    // Cached: no second network hit, returns [].
    expect(await loadAvatars()).toEqual([]);
    expect(hits).toBe(1);
    // force re-fetches.
    await loadAvatars(true);
    expect(hits).toBe(2);

    useFetch((url) => (url === "/api/avatars" ? jsonRes({}, 500) : undefined));
    await expect(loadAvatars(true)).rejects.toThrow();
    expect(readState().avatarsLoading).toBe(false);
  });

  it("loadConversations routes chat vs routine into the right slice", async () => {
    useFetch((url) => {
      if (url === "/api/conversations") return jsonRes({ conversations: [{ id: "c" }] });
      if (url === "/api/conversations?kind=routine") return jsonRes({ conversations: [{ id: "r" }] });
      return undefined;
    });
    await loadConversations();
    expect(readState().conversations).toEqual([{ id: "c" }]);
    await loadConversations("routine");
    expect(readState().routineConversations).toEqual([{ id: "r" }]);
  });

  it("loadSettingsData fans out to me/plugins/requests", async () => {
    useFetch((url) => {
      if (url === "/api/me") return jsonRes({ user: { id: "u", roles: [] } });
      if (url === "/api/me/plugins") return jsonRes({ plugins: [{ slug: "p" }] });
      if (url === "/api/me/knowledge/requests") return jsonRes({ requests: [{ id: "q" }] });
      return undefined;
    });
    await loadSettingsData();
    const s = readState();
    expect(s.user?.id).toBe("u");
    expect(s.plugins).toEqual([{ slug: "p" }]);
    expect(s.knowledgeRequests).toEqual([{ id: "q" }]);
  });

  it("loadInboxData renders partial success and reports the failing backend", async () => {
    useFetch((url) => {
      if (url === "/api/me/knowledge/requests") return jsonRes({ requests: [{ id: "q", status: "open" }] });
      if (url === "/api/me/notifications") return jsonRes({}, 500); // fails
      if (url === "/api/conversations?kind=routine") return jsonRes({ conversations: [] });
      return undefined;
    });
    const result = await loadInboxData();
    expect(readState().knowledgeRequests).toEqual([{ id: "q", status: "open" }]);
    expect(result.requestsError).toBeNull();
    expect(result.notificationsError).toBeTruthy();
    expect(result.routinesError).toBeNull();
  });

  it("refreshKnowledgeStatus announces only when the open-request count grows", async () => {
    replaceState({ user: { id: "u" } as any });
    useFetch((url) =>
      url === "/api/me/knowledge/requests"
        ? jsonRes({ requests: [{ id: "a", status: "open" }, { id: "b", status: "open" }] })
        : undefined,
    );
    await refreshKnowledgeStatus({ announce: true });
    expect(get(toasts).some((t) => t.message.includes("2건"))).toBe(true);
    toasts.set([]);
    // Same count on the next poll → no new toast.
    await refreshKnowledgeStatus({ announce: true });
    expect(get(toasts)).toHaveLength(0);
  });

  it("refreshNotificationStatus counts unread and keeps state on fetch failure", async () => {
    replaceState({ user: { id: "u" } as any, notifications: [{ id: "old", readAt: "t" } as any] });
    useFetch((url) =>
      url === "/api/me/notifications"
        ? jsonRes({ notifications: [{ id: "n1", readAt: null }, { id: "n2", readAt: null }] })
        : undefined,
    );
    await refreshNotificationStatus({ announce: true });
    expect(readState().notifications).toHaveLength(2);
    expect(get(toasts).some((t) => t.message.includes("2건"))).toBe(true);

    // A transient failure must not clobber the loaded notifications.
    useFetch(() => jsonRes({}, 500));
    await refreshNotificationStatus({ announce: true });
    expect(readState().notifications).toHaveLength(2);
  });

  it("skips refresh entirely when logged out", async () => {
    const fetchFn = useFetch(() => jsonRes({}));
    await refreshKnowledgeStatus({ announce: true });
    await refreshNotificationStatus({ announce: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("startKnowledgeWatch/stopKnowledgeWatch register and tear down the poll + listener", () => {
    const setInterval = vi.spyOn(window, "setInterval");
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");
    startKnowledgeWatch();
    expect(setInterval).toHaveBeenCalled();
    expect(addListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    stopKnowledgeWatch();
    expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("loadRoutinesData / loadAdminOverview / loadAdminGroups populate their slices", async () => {
    useFetch((url) => {
      if (url === "/api/me/routines") return jsonRes({ routines: [{ id: "rt" }] });
      if (url === "/api/conversations?kind=routine") return jsonRes({ conversations: [{ id: "rc" }] });
      if (url === "/api/admin/stats") return jsonRes({ stats: { users: 3 } });
      if (url === "/api/admin/system") return jsonRes({ uptime: 1 });
      if (url === "/api/admin/users") return jsonRes({ users: [{ id: "au" }] });
      // Real server shape ({ audit }, see routes/admin.ts) — the loader once
      // read a nonexistent `events` key and the admin audit tab rendered empty.
      if (url === "/api/audit") return jsonRes({ audit: [{ id: "ev" }] });
      if (url === "/api/admin/groups") return jsonRes({ groups: [{ id: "g" }] });
      return undefined;
    });
    await loadRoutinesData();
    expect(readState().routines).toEqual([{ id: "rt" }]);
    expect(readState().routineConversations).toEqual([{ id: "rc" }]);

    await loadAdminOverview();
    expect(readState()).toMatchObject({
      adminStats: { users: 3 },
      adminSystem: { uptime: 1 },
      adminUsers: [{ id: "au" }],
      audit: [{ id: "ev" }],
    });

    await loadAdminGroups();
    expect(readState().adminGroups).toEqual([{ id: "g" }]);
  });
});

/* ------------------------------------------------------------------ */
/* format.ts                                                           */
/* ------------------------------------------------------------------ */

describe("format helpers", () => {
  it("avatarImageUrl returns a versioned URL only when the user has an image", () => {
    expect(avatarImageUrl(null)).toBeNull();
    expect(avatarImageUrl({ id: "u1" })).toBeNull();
    expect(avatarImageUrl({ id: "a b", hasImage: true }, 48)).toBe("/api/users/a%20b/avatar-image?v=48");
  });

  it("initials takes the first uppercased char of the best available label", () => {
    expect(initials(null)).toBe("?");
    expect(initials({ displayName: "noah" })).toBe("N");
    expect(initials({ username: "  zed" })).toBe("Z");
    expect(initials({ alias: "" })).toBe("?");
  });

  it("hashHue is deterministic and within 0..359; avatarGradient uses the seed", () => {
    expect(hashHue("seed")).toBe(hashHue("seed"));
    expect(hashHue("seed")).toBeGreaterThanOrEqual(0);
    expect(hashHue("seed")).toBeLessThan(360);
    const grad = avatarGradient({ id: "abc" });
    expect(grad).toMatch(/^linear-gradient\(135deg, hsl\(\d+ 58% 52%\), hsl\(\d+ 64% 42%\)\)$/);
    expect(avatarGradient(null)).toContain("linear-gradient");
  });

  it("renderMarkdown sanitizes to HTML and falls back to a <pre> for markup-only input", () => {
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("")).toBe("");
    // A tag-only string sanitizes to empty, so it is re-escaped inside <pre>.
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out).toContain("<pre>");
    expect(out).not.toContain("<script>");
  });

  it("renderMarkdown never keeps a <style>, which would restyle the whole app", () => {
    // After a paragraph the parser keeps it in <body>, so only FORBID_TAGS removes it.
    const out = renderMarkdown("목업입니다\n\n<style>body{display:none}</style>\n\n<div style=\"color:red\">카드</div>");
    expect(out).not.toContain("<style");
    expect(out).not.toContain("display:none");
    expect(out).toContain("목업입니다");
    expect(out).toContain('style="color:red"'); // inline styles stay
    expect(renderMarkdown("text <svg><style>text{fill:red}</style></svg>")).not.toContain("<style");
  });

  it("renderMarkdownCached returns the same html and reuses it for repeated source text", () => {
    // The transcript re-evaluates every message's body on each SSE token, so the
    // cache is what keeps a long thread from re-parsing all of it per token.
    const source = `**bold** ${Math.random()}`;
    const first = renderMarkdownCached(source);
    expect(first).toBe(renderMarkdown(source));
    expect(renderMarkdownCached(source)).toBe(first); // same string instance, not just equal
  });

  it("renderMarkdownCached evicts the oldest entries instead of growing without bound", () => {
    // Rendering far past the cap must stay correct; only the memo is dropped.
    for (let i = 0; i < 600; i += 1) renderMarkdownCached(`entry ${i}`);
    expect(renderMarkdownCached("entry 599")).toContain("entry 599");
    expect(renderMarkdownCached("entry 0")).toContain("entry 0");
  });

  it("normalizeTags strips markers, dedupes case-insensitively, caps length and count", () => {
    expect(normalizeTags("#alpha, beta beta")).toEqual(["alpha", "beta"]);
    expect(normalizeTags(["#dup", "DUP", "Ok."])).toEqual(["dup", "Ok"]);
    expect(normalizeTags("x".repeat(40))[0]).toHaveLength(30);
    expect(normalizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(12);
    expect(normalizeTags(null)).toEqual([]);
  });

  it("repoToHref resolves shorthand + full URLs and rejects junk (server-mirrored)", () => {
    expect(repoToHref(null, "github.com")).toBeNull();
    expect(repoToHref("owner/repo", "")).toBe("https://github.com/owner/repo");
    expect(repoToHref("owner/repo.git", "https://ghe.corp/")).toBe("https://ghe.corp/owner/repo");
    expect(repoToHref("https://x.com/o/r.git", "github.com")).toBe("https://x.com/o/r");
    expect(repoToHref("nonsense", "github.com")).toBeNull();
  });

  it("timeToMinute / minuteToTime round-trip and clamp", () => {
    expect(timeToMinute("09:30")).toBe(570);
    expect(timeToMinute("bad")).toBe(0);
    expect(minuteToTime(570)).toBe("09:30");
    expect(minuteToTime(-5)).toBe("00:00");
    expect(minuteToTime(99999)).toBe("23:59");
    expect(minuteToTime(null)).toBe("00:00");
  });

  it("timeLabel returns '' for empty/invalid and includes the year only when not current", () => {
    expect(timeLabel(null)).toBe("");
    expect(timeLabel("nope")).toBe("");
    const thisYear = new Date().getFullYear();
    expect(timeLabel(`${thisYear}-07-06T09:30:00`)).not.toMatch(/\d{2,}\. \d{2}\. \d{2}\./);
    expect(timeLabel("2001-07-06T09:30:00")).not.toBe("");
  });

  it("relativeDayTimeLabel spells out near days and weekday-tags the rest", () => {
    const now = new Date("2026-07-27T12:00:00+09:00");
    expect(relativeDayTimeLabel("2026-07-27T09:00:00+09:00", now)).toBe("오늘 오전 9:00");
    expect(relativeDayTimeLabel("2026-07-28T09:00:00+09:00", now)).toBe("내일 오전 9:00");
    expect(relativeDayTimeLabel("2026-07-26T18:00:00+09:00", now)).toBe("어제 오후 6:00");
    expect(relativeDayTimeLabel("2026-07-31T18:00:00+09:00", now)).toBe("7. 31. (금) 오후 6:00");
    // A different year keeps a 2-digit year so the date isn't ambiguous.
    expect(relativeDayTimeLabel("2027-01-04T09:00:00+09:00", now)).toBe("27. 1. 4. (월) 오전 9:00");
    expect(relativeDayTimeLabel(null, now)).toBe("");
    expect(relativeDayTimeLabel("nope", now)).toBe("");
  });

  it("countdownLabel bucketises future instants and skips past ones", () => {
    const now = new Date("2026-07-27T12:00:00+09:00");
    expect(countdownLabel("2026-07-27T12:00:20+09:00", now)).toBe("곧");
    expect(countdownLabel("2026-07-27T12:12:00+09:00", now)).toBe("12분 후");
    expect(countdownLabel("2026-07-27T15:00:00+09:00", now)).toBe("3시간 후");
    expect(countdownLabel("2026-07-29T12:00:00+09:00", now)).toBe("2일 후");
    expect(countdownLabel("2026-07-27T11:00:00+09:00", now)).toBe("");
    expect(countdownLabel(null, now)).toBe("");
    expect(countdownLabel("nope", now)).toBe("");
  });

it("formatRoutineSchedule renders once/interval/weekly/daily variants (server-mirrored)", () => {
  expect(
    formatRoutineSchedule({ scheduleKind: "once", runDate: "2099-12-31", time: "14:30" }),
  ).toBe("한 번 · 2099. 12. 31. 14:30 (KST)");
    expect(formatRoutineSchedule({ scheduleKind: "interval", intervalMinutes: 180 })).toBe("3시간마다");
    expect(formatRoutineSchedule({ scheduleKind: "interval", intervalMinutes: 45 })).toBe("45분마다");
    expect(formatRoutineSchedule({ scheduleKind: "weekly", daysOfWeek: [5, 1, 3], time: "09:00" })).toBe(
      "매주 월·수·금 09:00 (KST)",
    );
    // Empty days + empty time collapses to the placeholder day and a doubled space (source has no re-collapse).
    expect(formatRoutineSchedule({ scheduleKind: "weekly", daysOfWeek: [], time: "" })).toBe("매주 —  (KST)");
    expect(formatRoutineSchedule({ scheduleKind: "daily", time: "07:00" })).toBe("매일 07:00 (KST)");
  });

  it("routineTitle prefers the name, then a one-line prompt preview, then a placeholder", () => {
    expect(routineTitle({ name: "  Standup " })).toBe("Standup");
    expect(routineTitle({ prompt: "  line one\nline two  " })).toBe("line one line two");
    expect(routineTitle({ prompt: "x".repeat(50) })).toBe(`${"x".repeat(40)}…`);
    expect(routineTitle({})).toBe("(이름 없는 예약 작업)");
  });

  it("formatTokenCount compacts by magnitude", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(-1)).toBe("0");
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(17500)).toBe("17.5K");
    expect(formatTokenCount(184000)).toBe("184K");
  });
});

/* ------------------------------------------------------------------ */
/* browserBridge.ts — version verdict for the composer badge           */
/* ------------------------------------------------------------------ */

describe("browser-control default allowlist", () => {
  it("patternMatchesHost mirrors the extension: exact, *.suffix (never the apex), bare *", () => {
    expect(patternMatchesHost("intra.example.com", "intra.example.com")).toBe(true);
    expect(patternMatchesHost("intra.example.com", "other.example.com")).toBe(false);
    expect(patternMatchesHost("*.corp.local", "noah.corp.local")).toBe(true);
    expect(patternMatchesHost("*.corp.local", "corp.local")).toBe(false);
    expect(patternMatchesHost("*", "anything.example")).toBe(true);
  });

  it("defaultAllowlistFor drops anything covering Noah's own host and normalizes", () => {
    expect(
      defaultAllowlistFor(
        [" Confluence.corp.example ", "noah.corp.example", "*.corp.example", "*", "", "confluence.corp.example"],
        "noah.corp.example",
      ),
    ).toEqual(["confluence.corp.example"]);
  });

  it("allowlistSeed writes ONLY into an empty, unmanaged, reachable allowlist", () => {
    const defaults = ["confluence.corp.example"];
    // The one seedable state: extension answered, no policy, nothing stored.
    expect(allowlistSeed(defaults, { ok: true, source: "empty", patterns: [] }, "noah.corp")).toEqual(
      defaults,
    );
    // A user's list — even a different one — is never overwritten.
    expect(
      allowlistSeed(defaults, { ok: true, source: "local", patterns: ["a.example"] }, "noah.corp"),
    ).toBeNull();
    // Managed policy governs; the extension would refuse the write anyway.
    expect(
      allowlistSeed(defaults, { ok: true, source: "managed", patterns: ["a.example"] }, "noah.corp"),
    ).toBeNull();
    // Unreachable extension / failed probe.
    expect(allowlistSeed(defaults, null, "noah.corp")).toBeNull();
    expect(allowlistSeed(defaults, { ok: false }, "noah.corp")).toBeNull();
    // Nothing usable to seed (all entries covered Noah itself).
    expect(
      allowlistSeed(["noah.corp"], { ok: true, source: "empty", patterns: [] }, "noah.corp"),
    ).toBeNull();
    expect(allowlistSeed([], { ok: true, source: "empty", patterns: [] }, "noah.corp")).toBeNull();
    expect(allowlistSeed(undefined, { ok: true, source: "empty", patterns: [] }, "noah.corp")).toBeNull();
  });
});

describe("browser bridge versioning", () => {
  it("compareBridgeVersions compares numerically, not lexicographically", () => {
    expect(compareBridgeVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareBridgeVersions("0.4.0", "0.4.0")).toBe(0);
    expect(compareBridgeVersions("0.4", "0.4.0")).toBe(0);
    expect(compareBridgeVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareBridgeVersions("beta", "1.0.0")).toBeNull();
    expect(compareBridgeVersions("1.0.0", "")).toBeNull();
  });

  it("bridgeVersionVerdict: exact = current, at/above floor = compatible, else outdated", () => {
    expect(bridgeVersionVerdict("0.5.0", "0.5.0", "0.4.0")).toBe("current");
    expect(bridgeVersionVerdict("0.4.0", "0.5.0", "0.4.0")).toBe("compatible");
    // Newer than the bundle (server rollback) still satisfies the floor.
    expect(bridgeVersionVerdict("0.6.0", "0.5.0", "0.4.0")).toBe("compatible");
    expect(bridgeVersionVerdict("0.3.9", "0.5.0", "0.4.0")).toBe("outdated");
    // Pre-0.4.0 builds answer without a version.
    expect(bridgeVersionVerdict("", "0.5.0", "0.4.0")).toBe("outdated");
    // No/unparseable floor → nothing vouches for a difference: exact match only.
    expect(bridgeVersionVerdict("0.4.0", "0.5.0", null)).toBe("outdated");
    expect(bridgeVersionVerdict("0.4.0", "0.5.0", "beta")).toBe("outdated");
    // String equality precedes parsing, so odd-but-equal versions stay green.
    expect(bridgeVersionVerdict("beta", "beta", null)).toBe("current");
  });

  it("extensionSupportsSecretInput gates stored-secret typing at 0.28.0, failing toward refusal", () => {
    expect(SECRET_INPUT_MIN_EXTENSION_VERSION).toBe("0.28.0");
    expect(extensionSupportsSecretInput("0.28.0")).toBe(true);
    expect(extensionSupportsSecretInput("0.28.1")).toBe(true);
    expect(extensionSupportsSecretInput("0.29.0")).toBe(true);
    expect(extensionSupportsSecretInput("1.0.0")).toBe(true);
    // Just below the boundary — and a lexicographic compare would call "0.9.0"
    // newer than "0.28.0", so this is the pin that catches a string compare.
    expect(extensionSupportsSecretInput("0.27.9")).toBe(false);
    expect(extensionSupportsSecretInput("0.9.0")).toBe(false);
    // No version at all (pre-0.4.0 builds) and unparseable versions are a NO:
    // handing a credential to a build that drops it is the worse failure.
    expect(extensionSupportsSecretInput(undefined)).toBe(false);
    expect(extensionSupportsSecretInput(null)).toBe(false);
    expect(extensionSupportsSecretInput("")).toBe(false);
    expect(extensionSupportsSecretInput("beta")).toBe(false);
  });

  it("extensionsPageUrl points Edge at edge://extensions, everyone else at chrome://extensions", async () => {
    const { extensionsPageUrl } = await import("../src/client/src/lib/browserBridge.js");
    const original = globalThis.navigator;
    const withUA = (ua: string | undefined) => {
      if (ua === undefined) {
        // @ts-expect-error deleting the global for the no-navigator branch
        delete globalThis.navigator;
      } else {
        Object.defineProperty(globalThis, "navigator", {
          value: { userAgent: ua },
          configurable: true,
        });
      }
    };
    try {
      withUA("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120.0.0.0");
      expect(extensionsPageUrl()).toBe("edge://extensions");
      withUA("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0 Safari/537.36");
      expect(extensionsPageUrl()).toBe("chrome://extensions");
      withUA(undefined);
      expect(extensionsPageUrl()).toBe("chrome://extensions");
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* browserBridgeInstall.ts — one-click update plumbing                 */
/* ------------------------------------------------------------------ */

describe("browser bridge one-click install lib", () => {
  /** In-memory stand-in for a FileSystemDirectoryHandle. */
  function fakeDir(initial: Record<string, string> = {}) {
    const files = new Map<string, string | Uint8Array>(Object.entries(initial));
    const writeOrder: string[] = [];
    const handle = {
      name: "noah-browser-bridge",
      getFileHandle: async (name: string, opts?: { create?: boolean }) => {
        if (!files.has(name) && !opts?.create) throw new Error("NotFoundError");
        return {
          getFile: async () => ({
            text: async () => {
              const value = files.get(name);
              return typeof value === "string" ? value : "";
            },
          }),
          createWritable: async () => {
            // Binary writes arrive as a single Uint8Array; text may stream in
            // pieces. Store bytes as-is so a test can assert no utf8 mangling.
            const parts: (string | Uint8Array)[] = [];
            return {
              write: async (data: string | Uint8Array) => {
                parts.push(data);
              },
              close: async () => {
                files.set(
                  name,
                  parts.length === 1 && typeof parts[0] !== "string"
                    ? parts[0]
                    : parts.map((p) => (typeof p === "string" ? p : "")).join(""),
                );
                writeOrder.push(name);
              },
            };
          },
        };
      },
    };
    return { files, writeOrder, handle };
  }

  // The pinned key from extension/manifest.json (a known vector for the
  // derivation algorithm). The repo pins the same pair elsewhere — the guide
  // spec asserts the id literal — so drift cannot pass unnoticed.
  const REAL_KEY =
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzQwjoxQnknlYiuPeAzugRXUYNVYkMgMfVFZSk0leqe8O66qjvzeNVENLXCbmIKlMppj3UcGZOm1NZIYUoQYSMDcunH+6NZQGruq2OPuUCHGHLrkHHFIK1bc+16scU1YMTzqMehPM6VzZ9x1Y6omvPMl8rOTDciW/aVPuaJjVce964Vgte1CRCoUhAPpMecOOitn19gwgCOkai1p4NsjRxu1XppuCOUh6u5StGLa+OE5xG9p/Q2vW/b4C9ucPW/Mj9Ws2XtNWf8zToWm5XnSP1+PmtpwCc89ApjKWxMKpg+HizFDYSS+F5jWHMprvEaIpAn2pKi5ooNLpuSsNAhhXOwIDAQAB";

  beforeEach(async () => {
    // jsdom's crypto may lack subtle; the id derivation needs real WebCrypto.
    // The specifier is computed so the CLIENT tsconfig (no node types) does not
    // try to resolve the node builtin — vitest resolves it fine at runtime.
    if (!globalThis.crypto?.subtle) {
      const mod = (await import(["node", "crypto"].join(":"))) as { webcrypto: Crypto };
      vi.stubGlobal("crypto", mod.webcrypto);
    }
  });

  it("derives the pinned extension id from the bundled manifest key (server rule mirrored)", async () => {
    expect(await extensionIdFromManifestKey(REAL_KEY)).toBe("gdaheigeedlnhagpmokpmocahgieiobc");
    expect(await extensionIdFromManifestKey("not base64!!")).toBeNull();
  });

  it("verifyExtensionDir accepts only a folder holding OUR extension", async () => {
    const ours = fakeDir({ "manifest.json": JSON.stringify({ key: REAL_KEY }) });
    expect(await verifyExtensionDir(ours.handle)).toBe("ok");

    const empty = fakeDir();
    expect(await verifyExtensionDir(empty.handle)).toBe("not-extension");

    const foreign = fakeDir({ "manifest.json": JSON.stringify({ key: btoa("someone else") }) });
    expect(await verifyExtensionDir(foreign.handle)).toBe("different-extension");

    // Keyless manifests fail closed: nothing to verify against.
    const keyless = fakeDir({ "manifest.json": JSON.stringify({ name: "x" }) });
    expect(await verifyExtensionDir(keyless.handle)).toBe("different-extension");

    const broken = fakeDir({ "manifest.json": "{nope" });
    expect(await verifyExtensionDir(broken.handle)).toBe("not-extension");
  });

  it("writeExtensionFiles writes manifest.json last and refuses path-like names", async () => {
    const dir = fakeDir();
    await writeExtensionFiles(dir.handle, [
      { name: "manifest.json", content: "{}" },
      { name: "background.js", content: "// sw" },
      { name: "policy-schema.json", content: "{}" },
    ]);
    expect(dir.files.get("background.js")).toBe("// sw");
    expect(dir.writeOrder[dir.writeOrder.length - 1]).toBe("manifest.json");

    // Base64 entries (icons) must land as RAW BYTES: written as a utf8 string
    // they corrupt, and Chrome refuses to load a manifest naming a bad icon.
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a]);
    const withIcon = fakeDir();
    await writeExtensionFiles(withIcon.handle, [
      { name: "icon-16.png", content: btoa(String.fromCharCode(...bytes)), encoding: "base64" },
    ]);
    const written = withIcon.files.get("icon-16.png");
    expect(written).toBeInstanceOf(Uint8Array);
    expect([...(written as Uint8Array)]).toEqual([...bytes]);

    await expect(
      writeExtensionFiles(dir.handle, [{ name: "../evil.js", content: "x" }]),
    ).rejects.toThrow(/unexpected bundle filename/);
    await expect(
      writeExtensionFiles(dir.handle, [{ name: ".ssh", content: "x" }]),
    ).rejects.toThrow(/unexpected bundle filename/);
  });

  it("mergeManifestOrigins keeps hand-added origins across an update", () => {
    const incoming = JSON.stringify({
      version: "0.5.0",
      externally_connectable: { matches: ["https://a/*"] },
    });
    const existing = JSON.stringify({
      version: "0.4.0",
      externally_connectable: { matches: ["https://a/*", "https://hand-added/*"] },
    });
    const merged = JSON.parse(mergeManifestOrigins(existing, incoming)) as {
      version: string;
      externally_connectable: { matches: string[] };
    };
    expect(merged.externally_connectable.matches).toEqual(["https://a/*", "https://hand-added/*"]);
    expect(merged.version).toBe("0.5.0");
    expect(mergeManifestOrigins(null, incoming)).toBe(incoming);
    expect(mergeManifestOrigins("{broken", incoming)).toBe(incoming);
  });

  function stubBridgeChrome(opts: { reloadSupported: boolean; versionAfterReload: string }) {
    let reloaded = false;
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: (_id: string, message: { op: string }, cb: (r: unknown) => void) => {
          if (message.op === "reloadExtension") {
            if (opts.reloadSupported) {
              reloaded = true;
              cb({ ok: true, version: "0.4.0" });
            } else {
              cb({ ok: false, message: `Unsupported operation "reloadExtension".` });
            }
            return;
          }
          if (message.op === "getAllowedOrigins") {
            cb({
              ok: true,
              patterns: [],
              source: "empty",
              version: reloaded ? opts.versionAfterReload : "0.4.0",
            });
            return;
          }
          cb({ ok: false, message: `Unsupported operation "${message.op}".` });
        },
      },
    });
  }

  function stubFilesEndpoint() {
    useFetch((url) =>
      url.includes("/api/browser-extension.files")
        ? jsonRes({
            version: "0.5.0",
            files: [
              { name: "background.js", content: "// v0.5.0" },
              {
                name: "manifest.json",
                content: JSON.stringify({
                  version: "0.5.0",
                  externally_connectable: { matches: ["https://a/*"] },
                }),
              },
            ],
          })
        : undefined,
    );
  }

  it("updateExtensionInPlace overwrites, reloads, and confirms the running build end-to-end", async () => {
    stubFilesEndpoint();
    stubBridgeChrome({ reloadSupported: true, versionAfterReload: "0.5.0" });
    const dir = fakeDir({
      "manifest.json": JSON.stringify({
        version: "0.4.0",
        externally_connectable: { matches: ["https://a/*", "https://hand-added/*"] },
      }),
    });

    vi.useFakeTimers();
    const pending = updateExtensionInPlace(dir.handle);
    await vi.runAllTimersAsync();
    const outcome = await pending;

    expect(outcome).toEqual({ status: "updated", version: "0.5.0" });
    expect(dir.files.get("background.js")).toBe("// v0.5.0");
    const written = JSON.parse((dir.files.get("manifest.json") as string) ?? "{}") as {
      externally_connectable: { matches: string[] };
    };
    // Hand-added origin survived the rewrite.
    expect(written.externally_connectable.matches).toContain("https://hand-added/*");
    expect(dir.writeOrder[dir.writeOrder.length - 1]).toBe("manifest.json");
  });

  it("updateExtensionInPlace falls back to one manual reload on a pre-0.5.0 build", async () => {
    stubFilesEndpoint();
    stubBridgeChrome({ reloadSupported: false, versionAfterReload: "0.4.0" });
    const dir = fakeDir({ "manifest.json": JSON.stringify({ version: "0.4.0" }) });

    vi.useFakeTimers();
    const pending = updateExtensionInPlace(dir.handle);
    await vi.runAllTimersAsync();
    const outcome = await pending;

    // Files are already swapped; the old worker just can't reload itself.
    expect(outcome).toEqual({ status: "manual-reload", version: "0.5.0" });
    expect(dir.files.get("background.js")).toBe("// v0.5.0");
  });

  it("updateExtensionInPlace flags a copy folder when the running build never changes", async () => {
    stubFilesEndpoint();
    stubBridgeChrome({ reloadSupported: true, versionAfterReload: "0.4.0" });
    const dir = fakeDir({ "manifest.json": JSON.stringify({ version: "0.4.0" }) });

    vi.useFakeTimers();
    const pending = updateExtensionInPlace(dir.handle);
    await vi.runAllTimersAsync();
    const outcome = await pending;

    expect(outcome).toEqual({ status: "wrong-folder" });
  });

  it("updateExtensionInPlace surfaces a failed file fetch without touching the folder", async () => {
    useFetch((url) =>
      url.includes("/api/browser-extension.files")
        ? jsonRes({ error: "확장 번들을 만들 수 없습니다." }, 500)
        : undefined,
    );
    const dir = fakeDir({ "manifest.json": JSON.stringify({ version: "0.4.0" }) });
    expect(await updateExtensionInPlace(dir.handle)).toEqual({
      status: "failed",
      reason: "확장 번들을 만들 수 없습니다.",
    });
    expect(dir.writeOrder).toEqual([]);
  });

  it("updateExtensionInPlace refuses an answer with no files or no version", async () => {
    const dir = fakeDir();
    const noFiles = { status: "failed", reason: "서버가 확장 파일 목록을 주지 않았습니다." };

    useFetch((url) =>
      url.includes("/api/browser-extension.files") ? jsonRes({ version: "0.5.0", files: [] }) : undefined,
    );
    expect(await updateExtensionInPlace(dir.handle)).toEqual(noFiles);

    // A version-less answer is equally unusable: the post-reload probe compares
    // against it, so without one there is nothing to confirm the update by.
    useFetch((url) =>
      url.includes("/api/browser-extension.files")
        ? jsonRes({ files: [{ name: "background.js", content: "// x" }] })
        : undefined,
    );
    expect(await updateExtensionInPlace(dir.handle)).toEqual(noFiles);

    // A body with no `files` key at all (older/garbled answer) reads the same
    // way as an empty list rather than throwing on the missing array.
    useFetch((url) =>
      url.includes("/api/browser-extension.files") ? jsonRes({ version: "0.5.0" }) : undefined,
    );
    expect(await updateExtensionInPlace(dir.handle)).toEqual(noFiles);
    expect(dir.writeOrder).toEqual([]);
  });

  it("updateExtensionInPlace aborts on a path-like filename, leaving the old manifest loadable", async () => {
    useFetch((url) =>
      url.includes("/api/browser-extension.files")
        ? jsonRes({
            version: "0.5.0",
            files: [
              { name: "../escape.js", content: "x" },
              { name: "manifest.json", content: JSON.stringify({ version: "0.5.0" }) },
            ],
          })
        : undefined,
    );
    const dir = fakeDir({ "manifest.json": JSON.stringify({ version: "0.4.0" }) });

    expect(await updateExtensionInPlace(dir.handle)).toEqual({
      status: "failed",
      reason: expect.stringContaining("unexpected bundle filename"),
    });
    // manifest.json is written LAST as the commit marker, so a refused bundle
    // leaves the previous — still loadable — extension untouched.
    expect(dir.writeOrder).toEqual([]);
    expect(dir.files.get("manifest.json")).toBe(JSON.stringify({ version: "0.4.0" }));
  });

  it("updateExtensionInPlace re-probes once before settling for a manual reload", async () => {
    stubFilesEndpoint();
    let probes = 0;
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: (_id: string, message: { op: string }, cb: (r: unknown) => void) => {
          if (message.op === "reloadExtension") {
            cb({ ok: true, version: "0.4.0" });
            return;
          }
          if (message.op === "getAllowedOrigins") {
            probes += 1;
            cb({ ok: false, message: "worker restarting" });
            return;
          }
          cb({ ok: false, message: `Unsupported operation "${message.op}".` });
        },
      },
    });
    const dir = fakeDir();

    vi.useFakeTimers();
    const pending = updateExtensionInPlace(dir.handle);
    await vi.runAllTimersAsync();
    const outcome = await pending;

    // The reload was accepted but the running build never answered, so the
    // files are in place and one manual ↻ finishes it — never "wrong-folder",
    // which would send the user hunting for a folder that is in fact correct.
    expect(outcome).toEqual({ status: "manual-reload", version: "0.5.0" });
    expect(probes).toBe(2); // first probe, then one more beat for a slow restart
    expect(dir.files.get("background.js")).toBe("// v0.5.0");
  });

  it("updateExtensionInPlace finishes when the reload is refused without a reason", async () => {
    stubFilesEndpoint();
    // An `ok:false` with no message is a valid wire answer, and the pre-0.5.0
    // fallback keys on that text — an absent one must not read as a match.
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: (_id: string, _message: unknown, cb: (r: unknown) => void) => cb({ ok: false }),
      },
    });
    const dir = fakeDir();

    vi.useFakeTimers();
    const pending = updateExtensionInPlace(dir.handle);
    await vi.runAllTimersAsync();

    expect(await pending).toEqual({ status: "manual-reload", version: "0.5.0" });
    expect(dir.files.get("background.js")).toBe("// v0.5.0");
  });

  /* ---------------------------------------------------------------- */
  /* folder handle: picker + IndexedDB persistence                     */
  /* ---------------------------------------------------------------- */

  describe("extension folder handle", () => {
    /**
     * Minimal in-memory IndexedDB — jsdom ships none, and the real API's shape
     * is exactly what is under test: requests settle asynchronously, so the
     * handlers the module assigns AFTER the call returns must still fire.
     */
    function fakeIdb(opts: { failOpen?: boolean; failOp?: boolean; nullError?: boolean } = {}) {
      const rows = new Map<string, unknown>();
      const stats = { opens: 0, closes: 0, upgrades: 0, modes: [] as string[] };
      const failure = () => (opts.nullError ? null : new Error("QuotaExceededError"));

      interface FakeRequest {
        result: unknown;
        error: Error | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onupgradeneeded: (() => void) | null;
      }
      const request = (settle: (req: FakeRequest) => void): FakeRequest => {
        const req: FakeRequest = {
          result: undefined,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        queueMicrotask(() => settle(req));
        return req;
      };

      const store = {
        get: (key: string) =>
          request((req) => {
            if (opts.failOp) {
              req.error = failure();
              req.onerror?.();
              return;
            }
            req.result = rows.get(key);
            req.onsuccess?.();
          }),
        put: (value: unknown, key: string) =>
          request((req) => {
            if (opts.failOp) {
              req.error = failure();
              req.onerror?.();
              return;
            }
            rows.set(key, value);
            req.onsuccess?.();
          }),
        delete: (key: string) =>
          request((req) => {
            if (opts.failOp) {
              req.error = failure();
              req.onerror?.();
              return;
            }
            rows.delete(key);
            req.onsuccess?.();
          }),
      };

      const db = {
        createObjectStore: () => {
          stats.upgrades += 1;
          return store;
        },
        transaction: (_name: string, mode: string) => {
          stats.modes.push(mode);
          return { objectStore: () => store };
        },
        close: () => {
          stats.closes += 1;
        },
      };

      vi.stubGlobal("indexedDB", {
        open: () =>
          request((req) => {
            stats.opens += 1;
            if (opts.failOpen) {
              req.error = failure();
              req.onerror?.();
              return;
            }
            req.result = db;
            if (!stats.upgrades) req.onupgradeneeded?.(); // first open creates the store
            req.onsuccess?.();
          }),
      });
      return { rows, stats };
    }

    it("fsaSupported and pickExtensionDir follow the picker's presence", async () => {
      // jsdom has no File System Access; so does any non-Chromium browser and
      // any fleet where enterprise policy disabled it.
      expect(fsaSupported()).toBe(false);
      expect(await pickExtensionDir()).toBeNull();

      const picked = fakeDir().handle;
      const picker = vi.fn(async () => picked);
      vi.stubGlobal("showDirectoryPicker", picker);
      expect(fsaSupported()).toBe(true);
      expect(await pickExtensionDir()).toBe(picked);
      // readwrite at pick time: a readonly handle could never run the update.
      expect(picker).toHaveBeenCalledWith({ mode: "readwrite" });

      // Dismissing the OS dialog throws AbortError — a choice, not a failure.
      vi.stubGlobal("showDirectoryPicker", async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      });
      expect(await pickExtensionDir()).toBeNull();
    });

    it("round-trips the picked folder through IndexedDB and closes every connection", async () => {
      const idb = fakeIdb();
      const handle = fakeDir().handle;

      expect(await loadSavedExtensionDir()).toBeNull(); // nothing connected yet
      await saveExtensionDir(handle);
      // The key is the cross-session contract: renaming it orphans every
      // already-connected install without any visible error.
      expect([...idb.rows.keys()]).toEqual(["extensionDir"]);
      // The live handle comes back, not a copy — a clone would carry no grant.
      expect(await loadSavedExtensionDir()).toBe(handle);

      await clearExtensionDir();
      expect(await loadSavedExtensionDir()).toBeNull();
      expect(idb.rows.size).toBe(0);

      expect(idb.stats.opens).toBe(5);
      expect(idb.stats.closes).toBe(5); // every op closes its own connection
      expect(idb.stats.upgrades).toBe(1); // the store is created once, then reused
      expect(idb.stats.modes).toEqual([
        "readonly",
        "readwrite",
        "readonly",
        "readwrite",
        "readonly",
      ]);
    });

    it("treats unusable storage as 'never connected', but never hides a failed save", async () => {
      fakeIdb({ failOpen: true });
      // Private mode / blocked storage: the page simply acts as if no folder
      // was ever connected, and clearing is already at its goal state.
      expect(await loadSavedExtensionDir()).toBeNull();
      await expect(clearExtensionDir()).resolves.toBeUndefined();
      // Saving is the step the user is waiting on, so it must not be silent.
      await expect(saveExtensionDir(fakeDir().handle)).rejects.toThrow("QuotaExceededError");

      // A failing REQUEST (rather than a failing open) still closes the db.
      const opened = fakeIdb({ failOp: true });
      expect(await loadSavedExtensionDir()).toBeNull();
      await expect(saveExtensionDir(fakeDir().handle)).rejects.toThrow("QuotaExceededError");
      expect(opened.stats.closes).toBe(opened.stats.opens);
    });

    it("names the failing stage when the IndexedDB request carries no error", async () => {
      fakeIdb({ failOpen: true, nullError: true });
      await expect(saveExtensionDir(fakeDir().handle)).rejects.toThrow("indexedDB open failed");
      fakeIdb({ failOp: true, nullError: true });
      await expect(saveExtensionDir(fakeDir().handle)).rejects.toThrow("indexedDB op failed");
    });

    it("ensureDirPermission re-asks only while the stored grant is in doubt", async () => {
      const base = {
        getFileHandle: async (): Promise<never> => {
          throw new Error("unused by the permission path");
        },
      };
      const requestPermission = vi.fn(async () => "granted");

      // A handle with no permission API (tests, future spec drift) passes.
      expect(await ensureDirPermission({ ...base })).toBe(true);

      // Persisted grant (Chrome 122+): no second prompt, so the user's click is
      // not spent re-authorizing a folder they already authorized.
      expect(
        await ensureDirPermission({ ...base, queryPermission: async () => "granted", requestPermission }),
      ).toBe(true);
      expect(requestPermission).not.toHaveBeenCalled();

      // "prompt" is how a stored handle normally wakes up → ask, then proceed.
      const queryPermission = vi.fn(async () => "prompt");
      expect(await ensureDirPermission({ ...base, queryPermission, requestPermission })).toBe(true);
      expect(queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
      expect(requestPermission).toHaveBeenCalledWith({ mode: "readwrite" });

      // Denied is final — re-asking would only be a prompt the browser ignores.
      const afterDenied = vi.fn(async () => "granted");
      expect(
        await ensureDirPermission({
          ...base,
          queryPermission: async () => "denied",
          requestPermission: afterDenied,
        }),
      ).toBe(false);
      expect(afterDenied).not.toHaveBeenCalled();

      // The user dismissed the prompt.
      expect(
        await ensureDirPermission({
          ...base,
          queryPermission: async () => "prompt",
          requestPermission: async () => "denied",
        }),
      ).toBe(false);
      // Queryable but with no request half → fail closed rather than write blind.
      expect(await ensureDirPermission({ ...base, queryPermission: async () => "prompt" })).toBe(false);
      // A revoked/detached handle throws instead of answering.
      expect(
        await ensureDirPermission({
          ...base,
          queryPermission: async () => {
            throw new Error("NotAllowedError");
          },
        }),
      ).toBe(false);
    });
  });
});
