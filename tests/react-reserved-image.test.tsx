// Images hold their box before their bytes arrive (ui-review #22): the chat
// transcript's attachments and the side-panel tabs' pages. A recorded size
// becomes width/height attributes; an unknown one (a row stored before sizes
// were recorded) gets a placeholder that goes once the image loads or fails.
// jsdom never lays out, so what is pinned here is the markup; the box itself is
// a real-browser check.
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FileTab from "../src/client/src/components/FileTab";
import ReservedImage, { CHAT_THUMB_MAX_PX, chatThumbSize, fitImageSize, knownImageSize } from "../src/client/src/components/ReservedImage";
import { readState, replaceState } from "../src/client/src/lib/state";
import type { ChatPane, MessageAttachment } from "../src/client/src/lib/types";
import ChatView from "../src/client/src/views/ChatView";
import type { AvatarDetail, StoredMessage } from "../src/server/types";

const attrs = (img: Element) => [img.getAttribute("width"), img.getAttribute("height"), img.hasAttribute("data-pending")];

describe("image sizes", () => {
  it("accepts only positive whole sizes in range", () => {
    expect(knownImageSize(640, 480)).toEqual({ width: 640, height: 480 });
    for (const [w, h] of [
      [undefined, undefined],
      [640, undefined],
      [0, 480],
      [-1, 480],
      [1.5, 480],
      ["640", 480],
      [Number.NaN, 480],
      [Infinity, 480],
      [200_000, 480],
    ] as [unknown, unknown][]) {
      expect(knownImageSize(w, h), `${String(w)}×${String(h)}`).toBeNull();
    }
  });

  it("shrinks into the box like max-width/max-height would, never enlarging", () => {
    expect(fitImageSize({ width: 2400, height: 1200 }, 240, 240)).toEqual({ width: 240, height: 120 });
    expect(fitImageSize({ width: 600, height: 1800 }, 240, 240)).toEqual({ width: 80, height: 240 });
    expect(fitImageSize({ width: 100, height: 50 }, 240, 240)).toEqual({ width: 100, height: 50 });
    expect(fitImageSize({ width: 10_000, height: 1 }, 240, 240)).toEqual({ width: 240, height: 1 });
    expect(CHAT_THUMB_MAX_PX).toBe(240);
    expect(chatThumbSize({ width: 1920, height: 1080 })).toEqual({ width: 240, height: 135 });
    expect(chatThumbSize({})).toBeNull();
  });
});

describe("ReservedImage", () => {
  it("renders width/height and no placeholder when the size is known", () => {
    const { container } = render(<ReservedImage src="/x.png" alt="x" size={{ width: 320, height: 200 }} className="msg-image" />);
    const img = container.querySelector("img")!;
    expect(attrs(img)).toEqual(["320", "200", false]);
    expect(img.className).toBe("cmp-reserved-image msg-image");
    expect(img.getAttribute("decoding")).toBe("async");
  });

  it("holds a placeholder for an unknown size until the image loads — or fails", () => {
    const onError = vi.fn();
    const { container } = render(
      <>
        <ReservedImage src="/a.png" alt="a" />
        <ReservedImage src="/b.png" alt="b" onError={onError} />
      </>,
    );
    const [a, b] = Array.from(container.querySelectorAll("img"));
    expect(attrs(a)).toEqual([null, null, true]);
    fireEvent.load(a);
    expect(a.hasAttribute("data-pending")).toBe(false);
    fireEvent.error(b);
    expect(b.hasAttribute("data-pending")).toBe(false);
    // The caller's own handler still runs (the 파일 tab's "cannot show" message).
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* the surfaces                                                        */
/* ------------------------------------------------------------------ */

const avatar = { id: "avatar-1", username: "ava", displayName: "아바타", isOwn: true, elevated: true, plugins: [] } as unknown as AvatarDetail;

function pane(messages: StoredMessage[], over: Partial<ChatPane> = {}): ChatPane {
  return {
    id: "pane-1",
    avatar,
    conversationId: "conv-1",
    messages,
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
    ...over,
  } as unknown as ChatPane;
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ avatars: [], conversations: [], messages: [], skills: [] }),
    })),
  );
});

describe("the transcript's image attachments", () => {
  it("give a sized image its thumbnail box and an older row's image a placeholder", () => {
    const sized = { id: "img-sized", kind: "image", mediaType: "image/png", name: "wide.png", width: 2400, height: 1200 };
    const legacy = { id: "img-old", kind: "image", mediaType: "image/png", name: "old.png" };
    const shown = { id: "img-shown", kind: "image", mediaType: "image/jpeg", width: 300, height: 900 };
    const user = {
      id: "u-1",
      conversationId: "conv-1",
      role: "user",
      content: "이거 봐줘",
      attachments: [sized, legacy],
      createdAt: "2026-07-26T01:00:00.000Z",
      response: null,
    } as unknown as StoredMessage;
    const answer = {
      id: "m-1",
      conversationId: "conv-1",
      role: "assistant",
      content: "결과입니다",
      attachments: [shown],
      createdAt: "2026-07-26T01:00:01.000Z",
      response: { kind: "text", runtime: "claude", summary: "완료", text: "결과입니다" },
    } as unknown as StoredMessage;
    replaceState({ avatars: [], chatPanes: [pane([user, answer])], activePaneId: "pane-1" });
    const { container } = render(<ChatView />);

    const userImages = Array.from(container.querySelectorAll(".message.user img.msg-image"));
    expect(userImages.map(attrs)).toEqual([
      ["240", "120", false],
      [null, null, true],
    ]);
    const shownImage = container.querySelector(".message.assistant img.msg-image")!;
    expect(attrs(shownImage)).toEqual(["80", "240", false]);
    // Still a link to the full image, lazy and async-decoded.
    expect(shownImage.closest("a.msg-image-link")?.getAttribute("href")).toBe("/api/conversations/conv-1/images/img-shown");
    expect(shownImage.getAttribute("loading")).toBe("lazy");
    expect(shownImage.getAttribute("decoding")).toBe("async");

    fireEvent.load(userImages[1]);
    expect(userImages[1].hasAttribute("data-pending")).toBe(false);
  });
});

describe("pressing a transcript image", () => {
  it("opens it in the side panel as its own tab; a modified press is left to the link", () => {
    const shown = { id: "img-shown", kind: "image", mediaType: "image/jpeg", name: "chart.jpg", width: 300, height: 900 };
    const answer = {
      id: "m-1",
      conversationId: "conv-1",
      role: "assistant",
      content: "결과입니다",
      attachments: [shown],
      createdAt: "2026-07-26T01:00:01.000Z",
      response: { kind: "text", runtime: "claude", summary: "완료", text: "결과입니다" },
    } as unknown as StoredMessage;
    replaceState({ avatars: [], chatPanes: [pane([answer])], activePaneId: "pane-1" });
    const { container } = render(<ChatView />);
    const link = container.querySelector(".message.assistant a.msg-image-link")!;

    // Ctrl+click: the browser's own new tab, nothing opened beside the chat.
    fireEvent.click(link, { ctrlKey: true });
    expect(readState().chatPanes[0].fileTabs ?? []).toEqual([]);

    const plain = fireEvent.click(link);
    expect(plain).toBe(false); // default prevented: no new browser tab
    const opened = readState().chatPanes[0];
    expect(opened.fileTabs?.map((tab) => tab.attachment.id)).toEqual(["img-shown"]);
    expect(opened.fileTabs?.[0].slides?.map((slide) => slide.id)).toEqual(["img-shown"]);
    expect(opened.sideTab).toEqual({ kind: "file", id: "img-shown" });
  });
});

describe("the 파일 tab's slides", () => {
  it("draw a recorded slide at its size and an older one with a placeholder", () => {
    const card: MessageAttachment = { id: "file-1", kind: "file", mediaType: "image/png", name: "스크린샷.png", size: 10 };
    const slides: MessageAttachment[] = [
      { id: "s-1", kind: "image", mediaType: "image/png", name: "slide-1.png", hidden: true, parentId: "file-1", width: 1920, height: 1080 },
      { id: "s-2", kind: "image", mediaType: "image/png", name: "slide-2.png", hidden: true, parentId: "file-1" },
    ];
    replaceState({ avatars: [], chatPanes: [], activePaneId: null } as never);
    const { container } = render(
      <FileTab pane={pane([], { fileTabs: [{ attachment: card, slides }] } as Partial<ChatPane>)} file={{ attachment: card, slides }} active />,
    );
    const images = Array.from(container.querySelectorAll(".file-preview-slide img"));
    expect(images.map(attrs)).toEqual([
      ["1920", "1080", false],
      [null, null, true],
    ]);
  });
});
