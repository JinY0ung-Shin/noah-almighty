// @vitest-environment jsdom
// PPTX share links — the client's pure half. Pinned here:
//  - the status-aware open call: ONLY a 404 is a dead link (a timeout, a 5xx or
//    a rate limit must not tell a recipient a live link expired), and a token
//    that fails the shared regex never leaves the browser;
//  - the viewer's URL allowlist and text coercion (the payload is the deck
//    author's content);
//  - the #/share/<token> route: currentRoute() is re-run by syncHash on every
//    run-stream `open` frame, so without its branch the token would silently
//    collapse to "#/share" and a reload would lose the link;
//  - the item-1 client change riding in this lane: a canvas that ASKS for input
//    takes the side slot back from the file preview.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, setSessionExpiredHandler } from "../src/client/src/lib/api.js";
import { attachRun } from "../src/client/src/lib/chat.js";
import { applyInitialRoute, currentRoute, goView, installRouteListener, syncHash } from "../src/client/src/lib/nav.js";
import { appState, readState, replaceState, setDocumentTitle, updateState } from "../src/client/src/lib/state.js";
import {
  SHARE_TICKET_REFRESH_MS,
  absoluteShareUrl,
  activeShareLink,
  createShareLink,
  isShareAssetUrl,
  latestExpiredShareLink,
  listShareLinks,
  openShareLink,
  revokeShareLink,
  sanitizeSharePayload,
  shareAudienceNote,
  shareDateLabel,
  shareDateTimeLabel,
  shareOwnerLine,
  shareTicketsStale,
} from "../src/client/src/lib/shareLinks.js";
import { SHARE_LINK_GONE_MESSAGE, SHARE_TICKET_TTL_MINUTES, shareLinkPath } from "../src/shared/shareLinks.js";
import type { ChatPane, ShareLinkSummary, ShareViewPayload } from "../src/client/src/lib/types.js";

const PRISTINE = structuredClone(readState());
/** A well-formed token: 43 base64url characters. */
const TOKEN = `${"Ab3_-".repeat(8)}xyz`;
const TOKEN_2 = `${"Zz9-_".repeat(8)}abc`;

type FetchHandler = (url: string, init: RequestInit) => unknown;

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

function payload(over: Partial<ShareViewPayload> = {}): ShareViewPayload {
  return {
    fileName: "분기 보고.pptx",
    ownerName: "김민수",
    ownerUsername: "minsu",
    createdAt: new Date(2026, 9, 1, 9, 0).toISOString(),
    expiresAt: new Date(2026, 9, 8, 9, 5).toISOString(),
    slides: [
      { index: 1, url: "/api/share/t/tk/slides/1", alt: "슬라이드 1 – 표지" },
      { index: 2, url: "/api/share/t/tk/slides/2", alt: "슬라이드 2" },
    ],
    downloadUrl: "/api/share/t/tk/download",
    previewCapped: false,
    ...over,
  };
}

function summary(over: Partial<ShareLinkSummary> = {}): ShareLinkSummary {
  return {
    id: "link-1",
    conversationId: "conv-1",
    conversationTitle: "보고서 만들기",
    fileId: "file-1",
    fileName: "분기 보고.pptx",
    slideCount: 2,
    createdAt: new Date(2026, 9, 1, 9, 0).toISOString(),
    expiresAt: new Date(2026, 9, 8, 9, 0).toISOString(),
    expired: false,
    viewCount: 0,
    lastViewedAt: null,
    url: shareLinkPath(TOKEN),
    ...over,
  };
}

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSessionExpiredHandler(() => {});
});

/* ------------------------------------------------------------------ */
/* openShareLink — the status-aware wrapper                            */
/* ------------------------------------------------------------------ */

describe("openShareLink", () => {
  it("posts the token in the BODY and returns the sanitized payload", async () => {
    const fetchMock = useFetch((url) => (url === "/api/share/open" ? jsonRes(payload()) : undefined));
    const result = await openShareLink(TOKEN);
    expect(result).toEqual({ status: "ok", payload: payload() });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/share/open");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN });
  });

  it("marks a ticket refresh so the owner's view count does not count it again", async () => {
    const fetchMock = useFetch((url) => (url === "/api/share/open" ? jsonRes(payload()) : undefined));
    await openShareLink(TOKEN, { refresh: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ token: TOKEN, refresh: true });
  });

  it("never sends a token that fails the shared regex (dead link, no request)", async () => {
    const fetchMock = useFetch(() => jsonRes(payload()));
    // A decoded hash arg could otherwise steer the request anywhere.
    for (const bad of ["", "short", `${TOKEN}x`, "../../api/me", `${TOKEN.slice(0, 42)}.`]) {
      expect(await openShareLink(bad)).toEqual({ status: "gone" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps ONLY a 404 to the dead-link state", async () => {
    useFetch(() => jsonRes({ error: SHARE_LINK_GONE_MESSAGE }, 404));
    expect(await openShareLink(TOKEN)).toEqual({ status: "gone" });
  });

  it("keeps every other failure retryable, with the message to show", async () => {
    useFetch(() => jsonRes({ error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." }, 429));
    expect(await openShareLink(TOKEN)).toEqual({
      status: "error",
      message: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
    });

    useFetch(() => jsonRes({}, 500));
    const server = await openShareLink(TOKEN);
    expect(server.status).toBe("error");
    expect(server.status === "error" && server.message).toContain("코드 500");

    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect(await openShareLink(TOKEN)).toEqual({
      status: "error",
      message: "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.",
    });
  });

  it("lets a 401 while logged in end the session like any other call", async () => {
    replaceState({ user: { id: "viewer" } as any });
    const onExpire = vi.fn();
    setSessionExpiredHandler(onExpire);
    useFetch(() => jsonRes({ error: "Authentication required" }, 401));
    const result = await openShareLink(TOKEN);
    expect(onExpire).toHaveBeenCalledOnce();
    expect(result.status).toBe("error");
  });
});

describe("ApiError", () => {
  it("carries the HTTP status next to the Korean message", async () => {
    const { api } = await import("../src/client/src/lib/api.js");
    useFetch(() => jsonRes({ error: "파일을 찾을 수 없습니다." }, 404));
    const err = await api("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ status: 404, message: "파일을 찾을 수 없습니다." });
  });
});

/* ------------------------------------------------------------------ */
/* payload hygiene                                                     */
/* ------------------------------------------------------------------ */

describe("isShareAssetUrl", () => {
  it("accepts only same-origin /api/share/ paths, after normalization", () => {
    expect(isShareAssetUrl("/api/share/t/tk/slides/1")).toBe(true);
    expect(isShareAssetUrl("/api/share/t/tk/download")).toBe(true);
    for (const bad of [
      "/api/conversations/c/images/i",
      "https://evil.example/api/share/x",
      "//evil.example/api/share/x",
      "/api/share/../me",
      "/api/share/%2e%2e/me",
      "/api/share\\..\\me",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "",
      null,
      42,
    ]) {
      expect(isShareAssetUrl(bad), String(bad)).toBe(false);
    }
  });
});

describe("sanitizeSharePayload", () => {
  it("drops renders and downloads that point anywhere but a share route", () => {
    const clean = sanitizeSharePayload(
      payload({
        slides: [
          { index: 1, url: "/api/share/t/tk/slides/1", alt: "슬라이드 1" },
          { index: 2, url: "https://evil.example/x.png", alt: "외부" },
          { index: 3, url: "/api/me", alt: "API" },
        ],
        downloadUrl: "https://evil.example/deck.pptx",
      }),
    );
    expect(clean.slides.map((slide) => slide.index)).toEqual([1]);
    expect(clean.downloadUrl).toBe("");
  });

  it("coerces every display string to text and fills the gaps", () => {
    const clean = sanitizeSharePayload({
      fileName: 7,
      ownerName: { html: "<b>x</b>" },
      ownerUsername: null,
      createdAt: undefined,
      expiresAt: "2026-10-08T00:00:00.000Z",
      slides: [{ index: 0, url: "/api/share/t/tk/slides/1", alt: null }],
      downloadUrl: "/api/share/t/tk/download",
      previewCapped: 1,
    } as unknown as ShareViewPayload);
    expect(clean).toEqual({
      fileName: "공유된 PPT",
      ownerName: "",
      ownerUsername: "",
      createdAt: "",
      expiresAt: "2026-10-08T00:00:00.000Z",
      slides: [{ index: 1, url: "/api/share/t/tk/slides/1", alt: "슬라이드 1" }],
      downloadUrl: "/api/share/t/tk/download",
      previewCapped: true,
    });
    expect(sanitizeSharePayload(null).slides).toEqual([]);
  });
});

describe("display rules", () => {
  it("formats dates as M월 D일 (HH:mm) in local time", () => {
    const iso = new Date(2026, 9, 5, 9, 7).toISOString();
    expect(shareDateLabel(iso)).toBe("10월 5일");
    expect(shareDateTimeLabel(iso)).toBe("10월 5일 09:07");
    expect(shareDateLabel("not a date")).toBe("");
    expect(shareDateTimeLabel(null)).toBe("");
  });

  it("names the sharer by display name AND username, with the expiry", () => {
    expect(shareOwnerLine(payload())).toBe("김민수 (@minsu)님이 공유 · 10월 8일 09:05까지");
    expect(shareOwnerLine(payload({ ownerName: "" }))).toBe("@minsu님이 공유 · 10월 8일 09:05까지");
    expect(shareOwnerLine(payload({ ownerUsername: "", expiresAt: "" }))).toBe("김민수님이 공유");
    expect(shareOwnerLine(payload({ ownerName: "", ownerUsername: "", expiresAt: "" }))).toBe("알 수 없는 사용자님이 공유");
  });

  it("tells the audience the truth about sign-up and speaker notes", () => {
    expect(shareAudienceNote("closed")).toBe(
      "링크를 받은 Noah 사용자는 누구나 로그인하면 슬라이드를 보고 파일을 내려받을 수 있습니다. 파일에는 발표자 노트도 포함됩니다.",
    );
    expect(shareAudienceNote(undefined)).toBe(shareAudienceNote("approval"));
    expect(shareAudienceNote("open")).toBe(
      "링크를 받은 사람은 누구나 Noah에 가입·로그인해 슬라이드를 보고 파일을 내려받을 수 있습니다. 파일에는 발표자 노트도 포함됩니다.",
    );
  });

  it("copies THIS origin + the link's path and hash, whatever origin the server used", () => {
    expect(absoluteShareUrl(shareLinkPath(TOKEN), "https://noah.corp")).toBe(`https://noah.corp/#/share/${TOKEN}`);
    expect(absoluteShareUrl(`http://10.0.0.5:48787/#/share/${TOKEN}`, "https://noah.corp")).toBe(
      `https://noah.corp/#/share/${TOKEN}`,
    );
    expect(absoluteShareUrl(shareLinkPath(TOKEN))).toBe(`${location.origin}/#/share/${TOKEN}`);
    expect(absoluteShareUrl(null)).toBe("");
    expect(absoluteShareUrl("http://[::1", "https://noah.corp")).toBe("");
  });

  it("picks the card's live link and its most recently lapsed one", () => {
    const older = summary({ id: "old", expired: true, expiresAt: "2026-09-01T00:00:00.000Z" });
    const newer = summary({ id: "new", expired: true, expiresAt: "2026-09-20T00:00:00.000Z" });
    const live = summary({ id: "live" });
    expect(activeShareLink([older, live, newer])?.id).toBe("live");
    expect(activeShareLink([older, newer])).toBeNull();
    expect(latestExpiredShareLink([older, live, newer])?.id).toBe("new");
    expect(latestExpiredShareLink([live])).toBeNull();
  });

  it("treats viewer tickets as stale five minutes before their 30-minute life ends", () => {
    expect(SHARE_TICKET_REFRESH_MS).toBe(25 * 60 * 1000);
    // Derived from the ONE shared lifetime the server signs tickets for.
    expect(SHARE_TICKET_REFRESH_MS).toBe((SHARE_TICKET_TTL_MINUTES - 5) * 60 * 1000);
    expect(shareTicketsStale(1_000, 1_000 + SHARE_TICKET_REFRESH_MS - 1)).toBe(false);
    expect(shareTicketsStale(1_000, 1_000 + SHARE_TICKET_REFRESH_MS)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* owner calls                                                         */
/* ------------------------------------------------------------------ */

describe("owner API calls", () => {
  it("lists links (bare array or a { links } envelope) with the card filter in the query", async () => {
    const fetchMock = useFetch((url) =>
      url.startsWith("/api/me/share-links?") ? jsonRes([summary()]) : url === "/api/me/share-links" ? jsonRes({ links: [summary({ id: "b" })] }) : undefined,
    );
    expect((await listShareLinks({ conversationId: "conv 1", fileId: "file-1" })).map((l) => l.id)).toEqual(["link-1"]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/me/share-links?conversationId=conv+1&fileId=file-1");
    expect((await listShareLinks()).map((l) => l.id)).toEqual(["b"]);
    useFetch(() => jsonRes({ unexpected: true }));
    expect(await listShareLinks()).toEqual([]);
  });

  it("creates a link for one card with the chosen expiry", async () => {
    const fetchMock = useFetch(() => jsonRes({ link: summary(), created: true }, 201));
    await expect(createShareLink("conv/1", "file-1", 30)).resolves.toEqual({ link: summary(), created: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/conversations/conv%2F1/files/file-1/share-links");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ expiresInDays: 30 });
    await createShareLink("c", "f");
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({ expiresInDays: 7 });
  });

  it("revokes by id, treating an already-gone link as revoked", async () => {
    const fetchMock = useFetch(() => ({ ok: true, status: 204, json: async () => ({}) }));
    await revokeShareLink("link 1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/me/share-links/link%201");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");

    useFetch(() => jsonRes({ error: "공유 링크를 찾을 수 없습니다." }, 404));
    await expect(revokeShareLink("gone")).resolves.toBeUndefined();

    useFetch(() => jsonRes({}, 500));
    await expect(revokeShareLink("x")).rejects.toThrow("코드 500");
  });
});

/* ------------------------------------------------------------------ */
/* the #/share/<token> route                                           */
/* ------------------------------------------------------------------ */

describe("share route", () => {
  it("keeps the token in currentRoute()", () => {
    replaceState({ view: "share", shareToken: TOKEN });
    // What syncHash(true) writes on EVERY run-stream `open` frame.
    expect(currentRoute()).toBe(`#/share/${TOKEN}`);
    replaceState({ shareToken: "" });
    expect(currentRoute()).toBe("#/share");
    replaceState({ shareToken: "공유/1" });
    expect(currentRoute()).toBe(`#/share/${encodeURIComponent("공유/1")}`);
  });

  it("survives a syncHash while the viewer is open", () => {
    replaceState({ user: { id: "u", roles: [] } as any, view: "share", shareToken: TOKEN });
    history.replaceState(null, "", `#/share/${TOKEN}`);
    syncHash(true);
    expect(location.hash).toBe(`#/share/${TOKEN}`);
  });

  it("reads the token out of the initial hash", () => {
    replaceState({ user: { id: "u", roles: [] } as any, view: "explore" });
    history.replaceState(null, "", `#/share/${TOKEN}`);
    applyInitialRoute();
    expect(readState()).toMatchObject({ view: "share", shareToken: TOKEN });
  });

  it("switches the token on hashchange (a second link while the viewer is mounted)", () => {
    replaceState({ user: { id: "u", roles: [] } as any, view: "share", shareToken: TOKEN });
    const cleanup = installRouteListener();
    history.replaceState(null, "", `#/share/${TOKEN_2}`);
    window.dispatchEvent(new Event("hashchange"));
    expect(readState()).toMatchObject({ view: "share", shareToken: TOKEN_2 });
    cleanup();
  });

  it("sets the token through goView, and is open to non-admins", () => {
    replaceState({ user: { id: "u", roles: [] } as any, view: "explore" });
    goView("share", TOKEN);
    expect(readState()).toMatchObject({ view: "share", shareToken: TOKEN });
    expect(location.hash).toBe(`#/share/${TOKEN}`);
    goView("share");
    expect(readState().shareToken).toBe("");
  });

  it("titles the tab with the deck's file name, from state", () => {
    replaceState({ user: { id: "u" } as any, view: "share", shareTitle: "" });
    setDocumentTitle();
    expect(document.title).toBe("공유된 PPT · Noah Almighty");
    replaceState({ shareTitle: "분기 보고.pptx" });
    setDocumentTitle();
    expect(document.title).toBe("분기 보고.pptx · Noah Almighty");
  });
});

/* ------------------------------------------------------------------ */
/* item 1: a canvas that asks for input takes the side slot back       */
/* ------------------------------------------------------------------ */

function streamFrom(chunks: string[], onDrained?: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else {
        onDrained?.();
        controller.close();
      }
    },
  });
}

function seedPane(): string {
  const deck = { id: "deck-1", kind: "file" as const, mediaType: "application/pdf", name: "deck.pptx" };
  const pane = {
    id: "pane-canvas",
    avatar: { id: "av1", alias: "노아", displayName: "Noah", isOwn: true } as any,
    conversationId: "conv-canvas",
    messages: [],
    draft: "",
    streaming: false,
    liveText: "",
    liveAttachments: [],
    liveStatus: "",
    liveRunId: null,
    liveAgents: [],
    liveTools: [],
    liveTasks: [],
    livePlugins: [],
    groupKnowledgeOff: [],
    canvases: [],
    activeCanvasId: null,
    stickBottom: true,
    abortController: null,
    filePreview: { attachment: deck, slides: [] },
  } as unknown as ChatPane;
  updateState((state) => {
    state.chatPanes = [pane];
    state.activePaneId = pane.id;
  });
  return pane.id;
}

/** Replay canvas frames through the real SSE reader, then detach. */
async function driveCanvasFrames(paneId: string, frames: unknown[]): Promise<void> {
  const runId = "canvas-run";
  useFetch((url) => {
    if (url.includes(`/api/chat/runs/${runId}/events`)) {
      const chunks = frames.map((data) => `event: canvas\ndata: ${JSON.stringify(data)}\n\n`);
      return {
        ok: true,
        status: 200,
        body: streamFrom(chunks, () => readState().chatPanes.find((p) => p.id === paneId)?.abortController?.abort()),
        json: async () => ({}),
      };
    }
    return jsonRes({ ok: true });
  });
  await attachRun(paneId, runId);
}

describe("item 1 — a canvas with controls clears the file preview", () => {
  const preview = (id: string) => readState().chatPanes.find((p) => p.id === id)?.filePreview;

  it("keeps the preview for a display-only canvas", async () => {
    const id = seedPane();
    await driveCanvasFrames(id, [{ artifactId: "cv-show", title: "미리보기", content: "본문" }]);
    expect(preview(id)?.attachment.id).toBe("deck-1");
  });

  it("drops the preview when an async review form arrives, so the form is seen", async () => {
    const id = seedPane();
    await driveCanvasFrames(id, [
      { artifactId: "cv-r1", title: "검토", content: "", controls: [{ id: "r1-s01" }], interaction: "async" },
    ]);
    expect(preview(id)).toBeNull();
    expect(readState().chatPanes[0].activeCanvasId).toBe("cv-r1");
  });

  it("drops it for a blocking form too, but not for an empty control list", async () => {
    const id = seedPane();
    await driveCanvasFrames(id, [{ artifactId: "cv-empty", controls: [] }]);
    expect(preview(id)?.attachment.id).toBe("deck-1");
    await driveCanvasFrames(id, [
      { artifactId: "cv-b", controls: [{ id: "q" }], interaction: "blocking", requestId: "rq", runId: "canvas-run" },
    ]);
    expect(preview(id)).toBeNull();
  });
});
