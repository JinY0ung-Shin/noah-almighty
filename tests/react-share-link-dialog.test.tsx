// The owner's 공유 링크 dialog for ONE deck card. (The deck tab's button that
// hands the card to ChatView's single dialog instance is FileTab's, and is
// tested with it.) The dialog is a PORTALED Modal: it inerts everything
// else under <body>, App's ConfirmationDialog and Toasts included, so a
// confirmAction/notify raised from it would mount inert and hidden underneath
// (jsdom ignores inert, so only an explicit pin catches that). Hence: revoke
// confirms INLINE, every error renders inside the card, and the dialog is
// pinned to never call either — by spy AND by import.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/src/lib/confirm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client/src/lib/confirm")>()),
  confirmAction: vi.fn(async () => true),
}));
vi.mock("../src/client/src/lib/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client/src/lib/state")>()),
  notify: vi.fn(),
}));

import ShareLinkDialog from "../src/client/src/components/ShareLinkDialog";
import dialogSource from "../src/client/src/components/ShareLinkDialog.tsx?raw";
import { confirmAction, confirmation } from "../src/client/src/lib/confirm";
import { appState, notify, readState, replaceState, toasts } from "../src/client/src/lib/state";
import { get } from "../src/client/src/lib/store";
import { PPTX_MEDIA_TYPE, shareLinkPath } from "../src/shared/shareLinks";
import type { BootstrapInfo, MessageAttachment, ShareLinkSummary } from "../src/client/src/lib/types";

const PRISTINE = structuredClone(readState());
const TOKEN = `${"Ab3_-".repeat(8)}xyz`;
const DECK: MessageAttachment = { id: "file-1", kind: "file", mediaType: PPTX_MEDIA_TYPE, name: "분기 보고.pptx", size: 2048 };

function summary(over: Partial<ShareLinkSummary> = {}): ShareLinkSummary {
  return {
    id: "link-1",
    kind: "file",
    conversationId: "conv-1",
    conversationTitle: "보고서 만들기",
    fileId: "file-1",
    sourcePath: "",
    fileName: "분기 보고.pptx",
    messageCount: 0,
    includesFiles: false,
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
      if (call.method === "POST" && (url.endsWith("/share-links") || url === "/api/me/share-links/workspace")) {
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
  const view = render(<ShareLinkDialog conversationId="conv-1" attachment={DECK} onClose={onClose} />);
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
        "링크를 받은 Noah 사용자는 누구나 로그인하면 파일을 내려받을 수 있습니다. PPT 파일은 슬라이드도 볼 수 있고, 파일에 발표자 노트가 포함됩니다.",
      ),
    ).toBeTruthy();
  });

  it("creates a link with the chosen expiry and shows THIS origin's address", async () => {
    stubFetch();
    openDialog();
    const card = dialog();
    fireEvent.click(await within(card).findByRole("radio", { name: "30일" }));
    expect(within(card).getByRole("radio", { name: "30일" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(card).getByRole("button", { name: "공유 링크 만들기" }));

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
    fireEvent.focus(input);
    expect(select).toHaveBeenCalled();
  });

  it("without a card it is the CONVERSATION's link: says what is shared, offers the file choice, posts it", async () => {
    const conversationLink = summary({ id: "link-c", kind: "conversation", fileId: "", fileName: "분기 실적 정리", viewCount: 0, messageCount: 6, includesFiles: true });
    stubFetch({ create: () => json({ link: conversationLink, created: true }, 201) });
    replaceState({ user: { id: "owner-1" } as any, bootstrap: { signupMode: "closed" } as BootstrapInfo });
    render(<ShareLinkDialog conversationId="conv-1" conversationTitle="분기 실적 정리" />);
    const card = screen.getByRole("dialog", { name: "대화 공유 링크" });
    expect(within(card).getByText("분기 실적 정리")).toBeTruthy();
    // Its own link only: asked by kind, never by a file id.
    expect(await within(card).findByRole("radiogroup", { name: "유효 기간" })).toBeTruthy();
    expect(calls[0]).toMatchObject({ url: "/api/me/share-links?conversationId=conv-1&kind=conversation", method: "GET" });
    // What the link shows and leaves out is said BEFORE the press.
    expect(
      within(card).getByText(
        "지금까지의 대화만 공유됩니다. 이후에 이어지는 대화는 포함되지 않습니다. 도구 실행 기록과 생각 과정은 공유되지 않습니다. 직접 첨부한 문서는 이름만 보이고 내려받을 수 없으며, 첨부한 이미지는 대화와 함께 보입니다.",
      ),
    ).toBeTruthy();
    expect(
      within(card).getByText("링크를 받은 Noah 사용자는 누구나 로그인하면 이 대화를 읽을 수 있습니다. 읽기만 할 수 있고, 이어서 대화할 수는 없습니다."),
    ).toBeTruthy();
    const files = within(card).getByRole("checkbox", { name: "아바타가 만들어 준 파일도 내려받을 수 있게 하기" }) as HTMLInputElement;
    expect(files.checked).toBe(false);
    fireEvent.click(files);
    fireEvent.click(within(card).getByRole("radio", { name: "1일" }));
    fireEvent.click(within(card).getByRole("button", { name: "공유 링크 만들기" }));

    expect(await within(card).findByLabelText("링크 주소")).toBeTruthy();
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.url).toBe("/api/conversations/conv-1/share-links");
    expect(post.body).toEqual({ expiresInDays: 1, includeFiles: true });
    expect(within(card).getByText(/메시지 6개까지 공유 중 · 아바타가 만든 파일 포함/)).toBeTruthy();
    expect(
      within(card).getByText("이후 대화를 포함하거나 파일 포함 여부·유효 기간을 바꾸려면 공유를 해제하고 새로 만드세요."),
    ).toBeTruthy();
  });

  it("for a file of the workspace it shares the copy taken now: asks by path, posts the path, says so", async () => {
    const workspaceLink = summary({
      id: "link-w",
      kind: "workspace_file",
      conversationId: "",
      conversationTitle: null,
      fileId: "",
      sourcePath: "c/conv-1/보고서.pdf",
      fileName: "보고서.pdf",
      viewCount: 0,
    });
    stubFetch({ create: () => json({ link: workspaceLink, created: true }, 201) });
    replaceState({ user: { id: "owner-1" } as any, bootstrap: { signupMode: "closed" } as BootstrapInfo });
    render(<ShareLinkDialog conversationId="" workspaceFile={{ path: "c/conv-1/보고서.pdf", name: "보고서.pdf" }} />);
    const card = dialog();
    expect(within(card).getByText("보고서.pdf")).toBeTruthy();
    expect(await within(card).findByRole("radiogroup", { name: "유효 기간" })).toBeTruthy();
    expect(calls[0]).toMatchObject({
      url: `/api/me/share-links?${new URLSearchParams({ kind: "workspace_file", path: "c/conv-1/보고서.pdf" })}`,
      method: "GET",
    });
    expect(
      within(card).getByText("지금 이 파일의 사본이 공유됩니다. 이후에 작업 폴더의 파일이 바뀌거나 지워져도 링크의 파일은 그대로입니다."),
    ).toBeTruthy();
    // No conversation choice here.
    expect(within(card).queryByRole("checkbox")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "공유 링크 만들기" }));

    expect(await within(card).findByLabelText("링크 주소")).toBeTruthy();
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.url).toBe("/api/me/share-links/workspace");
    expect(post.body).toEqual({ path: "c/conv-1/보고서.pdf", expiresInDays: 7 });
    expect(within(card).getByText(/에 만든 사본을 보여 줍니다\. 바뀐 파일을 공유하거나 유효 기간을 바꾸려면 공유를 해제하고 새로 만드세요\./)).toBeTruthy();
  });

  it("ignores a file link of the same conversation when it is the conversation's dialog", async () => {
    // A server that did not narrow by kind: the card's link must not show as the conversation's.
    stubFetch({ list: () => json([summary()]) });
    replaceState({ user: { id: "owner-1" } as any, bootstrap: { signupMode: "closed" } as BootstrapInfo });
    render(<ShareLinkDialog conversationId="conv-1" conversationTitle="분기 실적 정리" />);
    const card = screen.getByRole("dialog", { name: "대화 공유 링크" });
    expect(await within(card).findByRole("button", { name: "공유 링크 만들기" })).toBeTruthy();
    expect(within(card).queryByLabelText("링크 주소")).toBeNull();
  });

  it("says so when the create call hands back the link that already existed", async () => {
    stubFetch({ create: () => json({ link: summary(), created: false }) });
    openDialog();
    fireEvent.click(await within(dialog()).findByRole("button", { name: "공유 링크 만들기" }));
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
      fireEvent.click(copy);
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
    fireEvent.click(await within(card).findByRole("button", { name: "공유 해제" }));
    expect(within(card).getByText("이 링크를 해제할까요? 해제하면 링크를 받은 사람도 더 이상 열 수 없습니다.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(card).getByRole("button", { name: "취소" })));
    // 취소 backs out without a request and returns focus to 공유 해제.
    fireEvent.click(within(card).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(document.activeElement).toBe(within(card).getByRole("button", { name: "공유 해제" })));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    fireEvent.click(within(card).getByRole("button", { name: "공유 해제" }));
    const confirm = within(card).getByRole("button", { name: "해제" });
    expect(confirm.className).toContain("confirm-danger");
    fireEvent.click(confirm);
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
      fireEvent.click(create);
      const revoke = await within(card).findByRole("button", { name: "공유 해제" });
      // A button inserted disabled paints at the disabled opacity and fades in
      // (the global button transition), so right after a create 공유 해제
      // would read as unavailable.
      expect(inserted.get("공유 해제")).toBe(false);
      expect(document.activeElement).toBe(within(card).getByRole("button", { name: "공유 링크 복사" }));

      fireEvent.click(revoke);
      fireEvent.click(within(card).getByRole("button", { name: "해제" }));
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
    fireEvent.click(await within(card).findByRole("button", { name: "공유 링크 만들기" }));
    const alert = await within(card).findByRole("alert");
    expect(alert.textContent).toContain(cap);
    expect(alert.className).toContain("warn-box");
  });

  it("keeps a revoke failure inside the card too", async () => {
    stubFetch({ list: () => json([summary()]), revoke: () => json({}, 500) });
    openDialog();
    const card = dialog();
    fireEvent.click(await within(card).findByRole("button", { name: "공유 해제" }));
    fireEvent.click(within(card).getByRole("button", { name: "해제" }));
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
    fireEvent.click(within(card).getByRole("button", { name: "다시 시도" }));
    expect(await within(card).findByRole("button", { name: "공유 링크 만들기" })).toBeTruthy();
  });

  it("tells the owner that any logged-in Noah user with the link can open it", async () => {
    stubFetch();
    openDialog({ signupMode: "approval" });
    expect(
      await within(dialog()).findByText(
        "링크를 받은 Noah 사용자는 누구나 로그인하면 파일을 내려받을 수 있습니다. PPT 파일은 슬라이드도 볼 수 있고, 파일에 발표자 노트가 포함됩니다.",
      ),
    ).toBeTruthy();
  });

  it("closes from 닫기", async () => {
    stubFetch();
    const { onClose } = openDialog();
    fireEvent.click(await within(dialog()).findByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
