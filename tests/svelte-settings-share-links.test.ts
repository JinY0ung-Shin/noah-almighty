// 권한·연결 → 공유 링크: the owner's list of PPTX share links. This card is NOT
// a modal, so — unlike the file card's dialog — it confirms a revoke through
// the app-root confirmAction, with EXPLICIT options (the message-inferred
// defaults would title it generically). Pinned: lazy load on the tab, what a
// row tells the owner (deck, where from, dates, state, views), copy only for a
// live link, revoke vs delete by state, and the tab mount point.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsAccessTab from "../src/client/src/components/SettingsAccessTab.svelte";
import SettingsShareLinks from "../src/client/src/components/SettingsShareLinks.svelte";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm.js";
import { appState, readState, replaceState, toasts } from "../src/client/src/lib/state.js";
import { shareLinkPath } from "../src/shared/shareLinks.js";
import type { BootstrapInfo, ShareLinkSummary, User } from "../src/client/src/lib/types.js";

const PRISTINE = structuredClone(readState());
const TOKEN = `${"Ab3_-".repeat(8)}xyz`;

function summary(over: Partial<ShareLinkSummary> = {}): ShareLinkSummary {
  return {
    id: "link-1",
    conversationId: "conv-1",
    conversationTitle: "보고서 만들기",
    fileId: "file-1",
    fileName: "분기 보고.pptx",
    slideCount: 3,
    createdAt: new Date(2026, 9, 1, 9, 0).toISOString(),
    expiresAt: new Date(2026, 9, 8, 9, 0).toISOString(),
    expired: false,
    viewCount: 4,
    lastViewedAt: null,
    url: shareLinkPath(TOKEN),
    ...over,
  };
}

const EXPIRED = summary({
  id: "link-old",
  fileName: "지난 자료.pptx",
  conversationTitle: null,
  createdAt: new Date(2026, 8, 1, 9, 0).toISOString(),
  expiresAt: new Date(2026, 8, 8, 9, 0).toISOString(),
  expired: true,
  viewCount: 12,
  url: null,
});

interface Call {
  url: string;
  method: string;
}

let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(list: () => Response = () => json([summary(), EXPIRED]), revoke: () => Response = () => json(null, 204)): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || "GET").toUpperCase();
      calls.push({ url, method });
      if (url === "/api/me/share-links" && method === "GET") return list();
      if (url.startsWith("/api/me/share-links/") && method === "DELETE") return revoke();
      if (url.startsWith("/api/browser-extension")) return json({ extensionId: null, origins: [], defaultAllowedOrigins: [] });
      return json({});
    }),
  );
}

const listCalls = (): number => calls.filter((call) => call.url === "/api/me/share-links" && call.method === "GET").length;
const toastMessages = (): string[] => get(toasts).map((toast) => toast.message);

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
  replaceState({ bootstrap: { signupMode: "closed" } as BootstrapInfo });
});

afterEach(() => {
  if (get(confirmation)) resolveConfirmation(false);
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.unstubAllGlobals();
});

describe("SettingsShareLinks", () => {
  it("fetches nothing until the tab is opened, and refetches on every re-entry", async () => {
    stubFetch();
    const view = render(SettingsShareLinks, { props: { active: false } });
    expect(listCalls()).toBe(0);
    expect(screen.queryByRole("heading", { name: "공유 링크" })).toBeNull();

    await view.rerender({ active: true });
    expect(screen.getByRole("heading", { name: "공유 링크" }).tagName).toBe("H3");
    await waitFor(() => expect(listCalls()).toBe(1));
    await view.rerender({ active: false });
    await view.rerender({ active: true });
    await waitFor(() => expect(listCalls()).toBe(2));
  });

  it("shows the deck, where it came from, its dates, state and views", async () => {
    stubFetch();
    render(SettingsShareLinks, { props: { active: true } });
    const live = (await screen.findByText("분기 보고.pptx")).closest(".secret-row") as HTMLElement;
    expect(within(live).getByText("보고서 만들기")).toBeTruthy();
    expect(within(live).getByText("10월 1일 만듦 · 10월 8일 09:00까지 · 조회 4회")).toBeTruthy();
    expect(within(live).getByText("활성").className).toContain("tag");

    const old = screen.getByText("지난 자료.pptx").closest(".secret-row") as HTMLElement;
    expect(within(old).getByText("제목 없는 대화")).toBeTruthy();
    expect(within(old).getByText("9월 1일 만듦 · 9월 8일 만료 · 조회 12회")).toBeTruthy();
    expect(within(old).getByText("만료")).toBeTruthy();
    expect(screen.getByText("활성 링크 1개")).toBeTruthy();
    expect(
      screen.getByText((_, el) =>
        Boolean(el?.matches("p.muted") && el.textContent?.includes("링크를 받은 Noah 사용자는 누구나 로그인하면")),
      ),
    ).toBeTruthy();
  });

  it("copies a live link's absolute address, and offers no copy for an expired one", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    stubFetch();
    render(SettingsShareLinks, { props: { active: true } });
    await fireEvent.click(await screen.findByRole("button", { name: "공유 링크 복사: 분기 보고.pptx" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${location.origin}/#/share/${TOKEN}`));
    expect(screen.queryByRole("button", { name: "공유 링크 복사: 지난 자료.pptx" })).toBeNull();
  });

  it("revokes a live link only after an explicit danger confirmation", async () => {
    stubFetch();
    render(SettingsShareLinks, { props: { active: true } });
    await fireEvent.click(await screen.findByRole("button", { name: "공유 링크 해제: 분기 보고.pptx" }));
    const request = get(confirmation)!;
    expect(request).toMatchObject({ title: "공유 링크 해제", confirmLabel: "해제", tone: "danger" });
    expect(request.message).toContain("분기 보고.pptx");
    expect(request.message).toContain("해제하면 링크를 받은 사람도 더 이상 열 수 없습니다.");

    // Cancel: nothing is sent.
    resolveConfirmation(false);
    await waitFor(() => expect(get(confirmation)).toBeNull());
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    await fireEvent.click(screen.getByRole("button", { name: "공유 링크 해제: 분기 보고.pptx" }));
    await waitFor(() => expect(get(confirmation)).not.toBeNull());
    resolveConfirmation(true);
    await waitFor(() => expect(screen.queryByText("분기 보고.pptx")).toBeNull());
    expect(calls.find((call) => call.method === "DELETE")?.url).toBe("/api/me/share-links/link-1");
    expect(toastMessages()).toContain("공유 링크를 해제했습니다.");
  });

  it("deletes an expired row without a confirmation — it is already dead", async () => {
    stubFetch();
    render(SettingsShareLinks, { props: { active: true } });
    await fireEvent.click(await screen.findByRole("button", { name: "만료된 공유 링크 삭제: 지난 자료.pptx" }));
    expect(get(confirmation)).toBeNull();
    await waitFor(() => expect(screen.queryByText("지난 자료.pptx")).toBeNull());
    expect(calls.find((call) => call.method === "DELETE")?.url).toBe("/api/me/share-links/link-old");
    expect(toastMessages()).toContain("만료된 공유 링크를 삭제했습니다.");
  });

  it("shows an empty state", async () => {
    stubFetch(() => json([]));
    render(SettingsShareLinks, { props: { active: true } });
    expect(await screen.findByText("만든 공유 링크가 없습니다.")).toBeTruthy();
    expect(screen.queryByText(/활성 링크 \d+개/)).toBeNull();
  });

  it("surfaces a load failure with a retry", async () => {
    let attempt = 0;
    stubFetch(() => (++attempt === 1 ? json({ error: "목록을 불러오지 못했습니다." }, 500) : json([summary()])));
    render(SettingsShareLinks, { props: { active: true } });
    expect((await screen.findByRole("alert")).textContent).toContain("목록을 불러오지 못했습니다.");
    await fireEvent.click(screen.getByRole("button", { name: "목록 다시 불러오기" }));
    expect(await screen.findByText("분기 보고.pptx")).toBeTruthy();
  });

  it("keeps a failed revoke visible as an error, with the row still there", async () => {
    stubFetch(undefined, () => json({ error: "잠시 후 다시 시도해 주세요." }, 503));
    render(SettingsShareLinks, { props: { active: true } });
    await fireEvent.click(await screen.findByRole("button", { name: "만료된 공유 링크 삭제: 지난 자료.pptx" }));
    expect((await screen.findByRole("alert")).textContent).toContain("잠시 후 다시 시도해 주세요.");
    expect(screen.getByText("지난 자료.pptx")).toBeTruthy();
    expect(toastMessages()).toEqual([]);
  });
});

describe("권한·연결 tab", () => {
  const USER = {
    id: "owner-1",
    username: "owner",
    displayName: "Owner",
    alias: "",
    bio: "",
    persona: "",
    intro: "",
    hashtags: [],
    hasImage: false,
    visibility: "private",
    roles: [],
    pluginCount: 0,
    gitTokenSet: false,
    gitIdentityName: null,
    gitIdentityEmail: null,
    knowledgeRepo: null,
    knowledgeBranch: null,
    knowledgeSelected: null,
    groupKnowledgeOffDefault: [],
    modelDefault: null,
    effortDefault: null,
    mcpToolGroupsDefault: null,
    allowedMcpToolGroups: null,
    secretNames: [],
    shellExposedSecretNames: [],
    browserSecrets: [],
    sshPublicKey: null,
    groups: [],
    experimentalFeatures: [],
    sharedAccount: false,
    onboardedAt: null,
    lastSeenRelease: null,
  } satisfies User;

  it("mounts the card with the tab's active prop", async () => {
    stubFetch();
    replaceState({ user: USER });
    const view = render(SettingsAccessTab, { props: { active: true } });
    expect(await screen.findByRole("heading", { name: "공유 링크" })).toBeTruthy();
    await waitFor(() => expect(listCalls()).toBe(1));
    await view.rerender({ active: false });
    expect(screen.queryByRole("heading", { name: "공유 링크" })).toBeNull();
  });
});
