// The owner's 공유 링크 dialog for ONE deck card, and the deck tab's (FileTab)
// button that hands the card to ChatView's single dialog instance (a review
// canvas takes the side panel mid-create — that path is pinned in
// svelte-chat-transcript). The dialog is a PORTALED Modal: it inerts everything
// else under <body>, App's ConfirmationDialog and Toasts included, so a
// confirmAction/notify raised from it would mount inert and hidden underneath
// (jsdom ignores inert, so only an explicit pin catches that). Hence: revoke
// confirms INLINE, every error renders inside the card, and the dialog is
// pinned to never call either — by spy AND by import.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { get } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/src/lib/confirm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client/src/lib/confirm.js")>()),
  confirmAction: vi.fn(async () => true),
}));
vi.mock("../src/client/src/lib/state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client/src/lib/state.js")>()),
  notify: vi.fn(),
}));

import FileTab from "../src/client/src/components/FileTab.svelte";
import ShareLinkDialog from "../src/client/src/components/ShareLinkDialog.svelte";
import dialogSource from "../src/client/src/components/ShareLinkDialog.svelte?raw";
import { confirmAction, confirmation } from "../src/client/src/lib/confirm.js";
import { appState, notify, readState, replaceState, toasts } from "../src/client/src/lib/state.js";
import { PPTX_MEDIA_TYPE, shareLinkPath } from "../src/shared/shareLinks.js";
import type { BootstrapInfo, ChatPane, MessageAttachment, ShareLinkSummary } from "../src/client/src/lib/types.js";

const PRISTINE = structuredClone(readState());
const TOKEN = `${"Ab3_-".repeat(8)}xyz`;
const DECK: MessageAttachment = { id: "file-1", kind: "file", mediaType: PPTX_MEDIA_TYPE, name: "분기 보고.pptx", size: 2048 };

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
    // Absolute on an INTERNAL origin: the dialog must show the owner's own.
    url: `http://10.0.0.5:48787${shareLinkPath(TOKEN)}`,
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  body: any;
}

let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Routes {
  list?: () => Response;
  create?: (call: Call) => Response;
  revoke?: (call: Call) => Response;
}

function stubFetch(routes: Routes = {}): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const call: Call = {
        url,
        method: String(init?.method || "GET").toUpperCase(),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      };
      calls.push(call);
      if (url.startsWith("/api/me/share-links?")) return (routes.list ?? (() => json([])))();
      if (call.method === "POST" && url.endsWith("/share-links")) {
        return (routes.create ?? (() => json({ link: summary({ viewCount: 0 }), created: true }, 201)))(call);
      }
      if (call.method === "DELETE" && url.startsWith("/api/me/share-links/")) {
        return (routes.revoke ?? (() => json(null, 204)))(call);
      }
      return json({});
    }),
  );
}

function openDialog(bootstrap: Partial<BootstrapInfo> = { signupMode: "closed" }) {
  replaceState({ user: { id: "owner-1" } as any, bootstrap: bootstrap as BootstrapInfo });
  const onClose = vi.fn();
  const view = render(ShareLinkDialog, {
    props: { conversationId: "conv-1", attachment: DECK },
    events: { close: onClose },
  });
  return { ...view, onClose };
}

const dialog = (): HTMLElement => screen.getByRole("dialog", { name: "공유 링크" });

/** Each button's `disabled` state at the moment it was inserted under `root`, keyed by its text. */
function watchInsertedButtons(root: HTMLElement): { get: (text: string) => boolean | undefined; stop: () => void } {
  const states = new Map<string, boolean>();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const buttons = node instanceof HTMLButtonElement ? [node] : [...node.querySelectorAll("button")];
        for (const button of buttons) states.set(button.textContent?.trim() ?? "", button.disabled);
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return { get: (text) => states.get(text), stop: () => observer.disconnect() };
}

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  toasts.set([]);
  vi.mocked(confirmAction).mockClear();
  vi.mocked(notify).mockClear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
});

afterEach(() => {
  // The dialog must never have routed feedback through the app-root channels.
  expect(confirmAction).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(get(confirmation)).toBeNull();
  expect(get(toasts)).toEqual([]);
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.unstubAllGlobals();
});

describe("ShareLinkDialog", () => {
  it("never imports confirmAction or notify", () => {
    expect(dialogSource).toContain("<Modal");
    expect(dialogSource).not.toMatch(/import[^;]*\bconfirmAction\b/);
    expect(dialogSource).not.toMatch(/import[^;]*\bnotify\b/);
  });

  it("portals to <body>, loads this card's links, and offers 1/7/30 days with 7 preselected", async () => {
    stubFetch();
    const { container } = openDialog();
    const card = dialog();
    // Portaled: the panel's backdrop-filter would otherwise trap the overlay.
    expect(container.contains(card)).toBe(false);
    expect(document.body.contains(card)).toBe(true);
    expect(within(card).getByText("분기 보고.pptx")).toBeTruthy();
    expect(await within(card).findByRole("radiogroup", { name: "유효 기간" })).toBeTruthy();
    expect(calls[0]).toMatchObject({ url: "/api/me/share-links?conversationId=conv-1&fileId=file-1", method: "GET" });
    const radios = within(card).getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent?.trim())).toEqual(["1일", "7일(기본)", "30일"]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(
      within(card).getByText(
        "링크를 받은 Noah 사용자는 누구나 로그인하면 슬라이드를 보고 파일을 내려받을 수 있습니다. 파일에는 발표자 노트도 포함됩니다.",
      ),
    ).toBeTruthy();
  });

  it("creates a link with the chosen expiry and shows THIS origin's address", async () => {
    stubFetch();
    openDialog();
    const card = dialog();
    await fireEvent.click(await within(card).findByRole("radio", { name: "30일" }));
    expect(within(card).getByRole("radio", { name: "30일" }).getAttribute("aria-checked")).toBe("true");
    await fireEvent.click(within(card).getByRole("button", { name: "공유 링크 만들기" }));

    const input = (await within(card).findByLabelText("링크 주소")) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe(`${location.origin}/#/share/${TOKEN}`);
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.url).toBe("/api/conversations/conv-1/files/file-1/share-links");
    expect(post.body).toEqual({ expiresInDays: 30 });
    expect(within(card).getByText("10월 8일 09:00까지 · 조회 0회")).toBeTruthy();
    expect(within(card).getByText("유효 기간을 바꾸려면 공유를 해제하고 새로 만드세요.")).toBeTruthy();
    expect(within(card).queryByText("이미 만든 링크를 보여 드립니다.")).toBeNull();
    // The readonly field is the real fallback on plain HTTP: it selects itself.
    const select = vi.spyOn(input, "select");
    await fireEvent.focus(input);
    expect(select).toHaveBeenCalled();
  });

  it("says so when the create call hands back the link that already existed", async () => {
    stubFetch({ create: () => json({ link: summary(), created: false }) });
    openDialog();
    await fireEvent.click(await within(dialog()).findByRole("button", { name: "공유 링크 만들기" }));
    expect(await within(dialog()).findByText("이미 만든 링크를 보여 드립니다.")).toBeTruthy();
    expect(within(dialog()).getByText("10월 8일 09:00까지 · 조회 4회")).toBeTruthy();
  });

  it("notes when this card's previous link lapsed", async () => {
    stubFetch({ list: () => json([summary({ expired: true, url: null, expiresAt: new Date(2026, 8, 20, 18, 0).toISOString() })]) });
    openDialog();
    expect(await within(dialog()).findByText("이전 링크는 9월 20일에 만료되었습니다.")).toBeTruthy();
    expect(within(dialog()).getByRole("button", { name: "공유 링크 만들기" })).toBeTruthy();
  });

  it("opens straight on the card's live link, ignoring any other card's", async () => {
    stubFetch({
      list: () => json([summary({ id: "other", fileId: "file-9", url: "/#/share/other" }), summary()]),
    });
    openDialog();
    const input = (await within(dialog()).findByLabelText("링크 주소")) as HTMLInputElement;
    expect(input.value).toBe(`${location.origin}/#/share/${TOKEN}`);
    expect(within(dialog()).queryByRole("button", { name: "공유 링크 만들기" })).toBeNull();
  });

  it("explains an active link that can no longer be shown again", async () => {
    stubFetch({ list: () => json([summary({ url: null })]) });
    openDialog();
    expect(
      await within(dialog()).findByText(
        "이 링크는 계속 열리지만 다시 표시할 수 없습니다. 다시 보내려면 공유를 해제하고 새 링크를 만드세요.",
      ),
    ).toBeTruthy();
    expect(within(dialog()).queryByLabelText("링크 주소")).toBeNull();
    expect(within(dialog()).queryByRole("button", { name: "공유 링크 복사" })).toBeNull();
  });

  it("copies through copyText with the clicked button, then gives the button its name back", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    stubFetch({ list: () => json([summary()]) });
    openDialog();
    // Named for what it copies; the visible 복사 stays inside the name.
    const copy = await within(dialog()).findByRole("button", { name: "공유 링크 복사" });
    expect(copy.textContent?.trim()).toBe("복사");
    vi.useFakeTimers();
    try {
      await fireEvent.click(copy);
      await vi.advanceTimersByTimeAsync(0);
      expect(writeText).toHaveBeenCalledWith(`${location.origin}/#/share/${TOKEN}`);
      // The clicked button carries the outcome (copyText is silent without one)…
      expect(copy.getAttribute("aria-label")).toBe("복사됨");
      // …and then its own name again — never a leftover "복사됨".
      await vi.advanceTimersByTimeAsync(1200);
      expect(copy.getAttribute("aria-label")).toBe("공유 링크 복사");
      expect(copy.hasAttribute("title")).toBe(false);
      expect(copy.textContent?.trim()).toBe("복사");
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes through an INLINE confirmation whose safe choice has focus", async () => {
    stubFetch({ list: () => json([summary()]) });
    openDialog();
    const card = dialog();
    await fireEvent.click(await within(card).findByRole("button", { name: "공유 해제" }));
    expect(within(card).getByText("이 링크를 해제할까요? 해제하면 링크를 받은 사람도 더 이상 열 수 없습니다.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(card).getByRole("button", { name: "취소" })));
    // 취소 backs out without a request and returns focus to 공유 해제.
    await fireEvent.click(within(card).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(document.activeElement).toBe(within(card).getByRole("button", { name: "공유 해제" })));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    await fireEvent.click(within(card).getByRole("button", { name: "공유 해제" }));
    const confirm = within(card).getByRole("button", { name: "해제" });
    expect(confirm.className).toContain("confirm-danger");
    await fireEvent.click(confirm);
    expect(await within(card).findByText("공유 링크를 해제했습니다.")).toBeTruthy();
    expect(calls.find((call) => call.method === "DELETE")?.url).toBe("/api/me/share-links/link-1");
    // Back to the create state, ready for a link with a different expiry.
    expect(within(card).getByRole("button", { name: "공유 링크 만들기" })).toBeTruthy();
    expect(within(card).queryByLabelText("링크 주소")).toBeNull();
  });

  it("mounts each next footer button ENABLED, so nothing flashes disabled and focus lands", async () => {
    stubFetch();
    openDialog();
    const card = dialog();
    const create = await within(card).findByRole("button", { name: "공유 링크 만들기" });
    const inserted = watchInsertedButtons(card);
    try {
      await fireEvent.click(create);
      const revoke = await within(card).findByRole("button", { name: "공유 해제" });
      // A button inserted disabled paints at the disabled opacity and fades in
      // (the global button transition), so right after a create 공유 해제
      // would read as unavailable.
      expect(inserted.get("공유 해제")).toBe(false);
      expect(document.activeElement).toBe(within(card).getByRole("button", { name: "공유 링크 복사" }));

      await fireEvent.click(revoke);
      await fireEvent.click(within(card).getByRole("button", { name: "해제" }));
      await within(card).findByText("공유 링크를 해제했습니다.");
      expect(inserted.get("공유 링크 만들기")).toBe(false);
      // …and it takes the focus: focus() on a still-disabled button is a no-op.
      await waitFor(() =>
        expect(document.activeElement).toBe(within(card).getByRole("button", { name: "공유 링크 만들기" })),
      );
    } finally {
      inserted.stop();
    }
  });

  it("renders every failure inside the card", async () => {
    const cap =
      "공유 링크는 최대 50개까지 만들 수 있습니다. 내 아바타 → 권한·연결 → 공유 링크에서 쓰지 않는 링크를 해제한 뒤 다시 시도해 주세요.";
    stubFetch({ create: () => json({ error: cap }, 409) });
    openDialog();
    const card = dialog();
    await fireEvent.click(await within(card).findByRole("button", { name: "공유 링크 만들기" }));
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toContain(cap);
    expect(alert.className).toContain("warn-box");
  });

  it("keeps a revoke failure inside the card too", async () => {
    stubFetch({ list: () => json([summary()]), revoke: () => json({}, 500) });
    openDialog();
    const card = dialog();
    await fireEvent.click(await within(card).findByRole("button", { name: "공유 해제" }));
    await fireEvent.click(within(card).getByRole("button", { name: "해제" }));
    expect((await within(card).findByRole("alert")).textContent).toContain("코드 500");
    // The link is still there.
    expect(within(card).getByLabelText("링크 주소")).toBeTruthy();
  });

  it("offers a retry when the list cannot load", async () => {
    let attempt = 0;
    stubFetch({ list: () => (++attempt === 1 ? json({ error: "서버 내부 오류" }, 500) : json([])) });
    openDialog();
    const card = dialog();
    expect((await within(card).findByRole("alert")).textContent).toContain("서버 내부 오류");
    await fireEvent.click(within(card).getByRole("button", { name: "다시 시도" }));
    expect(await within(card).findByRole("button", { name: "공유 링크 만들기" })).toBeTruthy();
  });

  it("tells the owner that open sign-up lets anyone who can reach Noah in", async () => {
    stubFetch();
    openDialog({ signupMode: "open" });
    expect(
      await within(dialog()).findByText(
        "링크를 받은 사람은 누구나 Noah에 가입·로그인해 슬라이드를 보고 파일을 내려받을 수 있습니다. 파일에는 발표자 노트도 포함됩니다.",
      ),
    ).toBeTruthy();
  });

  it("closes from 닫기", async () => {
    stubFetch();
    const { onClose } = openDialog();
    await fireEvent.click(await within(dialog()).findByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* entry point: the deck's side-panel tab                              */
/* ------------------------------------------------------------------ */

function paneWith(attachment: MessageAttachment, over: Partial<ChatPane> = {}): ChatPane {
  return {
    id: "pane-1",
    avatar: { id: "owner-1", username: "owner", displayName: "나", isOwn: true } as any,
    conversationId: "conv-1",
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
    fileTabs: [{ attachment, slides: [] }],
    sideTab: { kind: "file", id: attachment.id },
    ...over,
  } as unknown as ChatPane;
}

function tabProps(attachment: MessageAttachment, over: Partial<ChatPane> = {}) {
  return { pane: paneWith(attachment, over), file: { attachment, slides: [] }, active: true };
}

describe("FileTab 공유 링크", () => {
  it("offers 공유 링크 next to 다운로드 on a PPTX card and hands the card to onShare", async () => {
    stubFetch();
    const onShare = vi.fn();
    const { container } = render(FileTab, { props: { ...tabProps(DECK), onShare } });
    const actions = container.querySelector(".file-tab .canvas-toolbar")!;
    const share = within(actions as HTMLElement).getByRole("button", { name: "공유 링크" }) as HTMLButtonElement;
    expect(share.disabled).toBe(false);
    // Right before the download link.
    expect(share.nextElementSibling?.textContent).toBe("다운로드");
    await fireEvent.click(share);
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onShare).toHaveBeenCalledWith(DECK);
    // No dialog of the tab's own: ChatView's single instance opens instead, so
    // a tab that unmounts cannot take an open dialog with it.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("disables it while the card is still streaming, and says why", async () => {
    const props = tabProps(DECK, { streaming: true, liveAttachments: [DECK] });
    const pane = props.pane;
    const view = render(FileTab, { props });
    const share = screen.getByRole("button", { name: "공유 링크" }) as HTMLButtonElement;
    expect(share.disabled).toBe(true);
    expect(share.title).toBe("응답이 끝난 뒤 만들 수 있습니다.");
    await view.rerender({ pane: { ...pane, streaming: false } });
    expect((screen.getByRole("button", { name: "공유 링크" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stays enabled while a LATER turn streams (the card itself is stored)", () => {
    render(FileTab, { props: tabProps(DECK, { streaming: true, liveAttachments: [] }) });
    expect((screen.getByRole("button", { name: "공유 링크" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("is absent for other file types and in a group agent's thread", async () => {
    const pdf: MessageAttachment = { id: "file-2", kind: "file", mediaType: "application/pdf", name: "보고.pdf" };
    const view = render(FileTab, { props: tabProps(pdf) });
    expect(screen.queryByRole("button", { name: "공유 링크" })).toBeNull();
    const groupPane = paneWith(DECK, {
      avatar: { id: "group:g1:a1", username: "team", displayName: "팀 에이전트", groupAgent: { groupId: "g1", groupName: "팀" } } as any,
    });
    await view.rerender({ pane: groupPane, file: { attachment: DECK, slides: [] } });
    expect(screen.queryByRole("button", { name: "공유 링크" })).toBeNull();
  });
});
