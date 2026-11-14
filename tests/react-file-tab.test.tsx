// The deck tab's (FileTab) 공유 링크 button, which hands the card to ChatView's
// single dialog instance (the dialog's own cases are
// tests/react-share-link-dialog.test.tsx). That file's pins apply here too:
// nothing this tab does may route feedback through confirmAction/notify.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/client/src/lib/confirm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client/src/lib/confirm")>()),
  confirmAction: vi.fn(async () => true),
}));
vi.mock("../src/client/src/lib/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/client/src/lib/state")>()),
  notify: vi.fn(),
}));

import FileTab from "../src/client/src/components/FileTab";
import { confirmAction, confirmation } from "../src/client/src/lib/confirm";
import { appState, notify, readState, toasts } from "../src/client/src/lib/state";
import { get } from "../src/client/src/lib/store";
import { PPTX_MEDIA_TYPE } from "../src/shared/shareLinks";
import type { ChatPane, MessageAttachment } from "../src/client/src/lib/types";

const PRISTINE = structuredClone(readState());
const DECK: MessageAttachment = { id: "file-1", kind: "file", mediaType: PPTX_MEDIA_TYPE, name: "분기 보고.pptx", size: 2048 };

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

function stubFetch(): void {
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
      if (url.startsWith("/api/me/share-links?")) return json([]);
      return json({});
    }),
  );
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
  // The tab must never have routed feedback through the app-root channels.
  expect(confirmAction).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  expect(get(confirmation)).toBeNull();
  expect(get(toasts)).toEqual([]);
  delete (navigator as { clipboard?: unknown }).clipboard;
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* entry point: the deck's side-panel tab                              */
/* ------------------------------------------------------------------ */

describe("the card's copy shown because its workspace file is gone", () => {
  it("says why above the preview, and says nothing otherwise", () => {
    const note: MessageAttachment = { id: "file-9", kind: "file", mediaType: "text/markdown", name: "메모.md", size: 12 };
    const view = render(<FileTab pane={paneWith(note)} file={{ attachment: note, slides: [], notice: "작업 폴더에서 이 파일을 찾지 못했습니다." }} active />);
    expect(screen.getByRole("status").textContent).toBe("작업 폴더에서 이 파일을 찾지 못했습니다.");
    expect(screen.getByRole("link", { name: "다운로드" })).toBeTruthy();
    view.unmount();
    // The way back to the folder is not offered from a tab that shows because the file is not there.
    appState.set({ ...structuredClone(PRISTINE), bootstrap: { workspaceFiles: true } as any });
    const placed = { ...note, workspacePath: "c/x/메모.md" };
    const gone = render(<FileTab pane={paneWith(placed)} file={{ attachment: placed, slides: [], notice: "사본입니다." }} active />);
    expect(screen.queryByRole("button", { name: "작업 폴더에서 보기" })).toBeNull();
    gone.unmount();
    const there = render(<FileTab pane={paneWith(placed)} file={{ attachment: placed, slides: [] }} active />);
    expect(screen.getByRole("button", { name: "작업 폴더에서 보기" })).toBeTruthy();
    there.unmount();
    appState.set(structuredClone(PRISTINE));
    render(<FileTab pane={paneWith(note)} file={{ attachment: note, slides: [] }} active />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

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
    canvases: [],
    fileTabs: [{ attachment, slides: [] }],
    sideTab: { kind: "file", id: attachment.id },
    ...over,
  } as unknown as ChatPane;
}

function tabProps(attachment: MessageAttachment, over: Partial<ChatPane> = {}) {
  return { pane: paneWith(attachment, over), file: { attachment, slides: [] }, active: true };
}

describe("FileTab 폴더에서 보기", () => {
  const PLACED: MessageAttachment = { ...DECK, workspacePath: "c/conv-1/deck/분기 보고.pptx" };
  const withWorkspace = (on: boolean) => appState.set({ ...structuredClone(PRISTINE), bootstrap: { workspaceFiles: on } as any });

  it("opens the 파일 tab at the place the card recorded", () => {
    withWorkspace(true);
    const props = tabProps(PLACED);
    appState.set({ ...readState(), chatPanes: [props.pane], activePaneId: props.pane.id });
    const { container } = render(<FileTab {...props} />);
    const actions = container.querySelector(".file-tab .canvas-toolbar") as HTMLElement;
    const button = within(actions).getByRole("button", { name: "작업 폴더에서 보기" });
    expect(button.textContent).toBe("폴더에서 보기");
    // It says the card is a copy and the folder's file may have changed since.
    expect(button.title).toContain("전달한 시점의 사본");
    fireEvent.click(button);
    const pane = readState().chatPanes[0];
    expect(pane.workspaceTab).toBe(true);
    expect(pane.sideTab).toEqual({ kind: "workspace", id: expect.any(String) });
    expect(pane.workspaceReveal?.path).toBe("c/conv-1/deck/분기 보고.pptx");
    // The card's own tab stays open next to it.
    expect(pane.fileTabs).toHaveLength(1);
  });

  it("is absent for a card that recorded no place, and on a deployment without the 파일 tab", () => {
    withWorkspace(true);
    const plain = render(<FileTab {...tabProps(DECK)} />);
    expect(screen.queryByRole("button", { name: "작업 폴더에서 보기" })).toBeNull();
    plain.unmount();
    withWorkspace(false);
    render(<FileTab {...tabProps(PLACED)} />);
    expect(screen.queryByRole("button", { name: "작업 폴더에서 보기" })).toBeNull();
  });
});

describe("FileTab 공유 링크", () => {
  it("offers 공유 링크 next to 다운로드 on a PPTX card and hands the card to onShare", async () => {
    stubFetch();
    const onShare = vi.fn();
    const { container } = render(<FileTab {...tabProps(DECK)} onShare={onShare} />);
    const actions = container.querySelector(".file-tab .canvas-toolbar")!;
    const share = within(actions as HTMLElement).getByRole("button", { name: "공유 링크" }) as HTMLButtonElement;
    expect(share.disabled).toBe(false);
    // Right before the download link.
    expect(share.nextElementSibling?.textContent).toBe("다운로드");
    fireEvent.click(share);
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
    const view = render(<FileTab {...props} />);
    const share = screen.getByRole("button", { name: "공유 링크" }) as HTMLButtonElement;
    expect(share.disabled).toBe(true);
    expect(share.title).toBe("응답이 끝난 뒤 만들 수 있습니다.");
    view.rerender(<FileTab {...props} pane={{ ...pane, streaming: false }} />);
    expect((screen.getByRole("button", { name: "공유 링크" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stays enabled while a LATER turn streams (the card itself is stored)", () => {
    render(<FileTab {...tabProps(DECK, { streaming: true, liveAttachments: [] })} />);
    expect((screen.getByRole("button", { name: "공유 링크" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("is absent for other file types", () => {
    const pdf: MessageAttachment = { id: "file-2", kind: "file", mediaType: "application/pdf", name: "보고.pdf" };
    render(<FileTab {...tabProps(pdf)} />);
    expect(screen.queryByRole("button", { name: "공유 링크" })).toBeNull();
  });
});
