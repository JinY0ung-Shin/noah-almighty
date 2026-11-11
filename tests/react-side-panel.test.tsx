// The side panel (SidePanel + CanvasTab + FileTab + CanvasHtmlFrame): the
// "SidePanel canvas tab" and "SidePanel tabs" suites. Runs in the vitest
// "react" project.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import DOMPurify from "dompurify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SidePanel from "../src/client/src/components/SidePanel";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm";
import { readState, replaceState } from "../src/client/src/lib/state";
import { get } from "../src/client/src/lib/store";

/* ------------------------------------------------------------------ */
/* SidePanel (canvas tabs) — a parked blocking ask must stay answerable */
/* ------------------------------------------------------------------ */

function canvasPane(overrides: Record<string, unknown>, canvas: Record<string, unknown>): any {
  return {
    id: "p1",
    streaming: true,
    sideTab: { kind: "canvas", id: "cv1" },
    canvases: [
      {
        id: "cv1",
        title: "질문",
        content: "골라 주세요",
        contentType: "markdown",
        controls: [
          { type: "buttons", id: "pick", label: "선택", options: [{ label: "A" }, { label: "B" }] },
        ],
        ...canvas,
      },
    ],
    ...overrides,
  };
}

describe("SidePanel canvas tab", () => {
  const LOCKED = "아바타 응답이 끝난 뒤 보낼 수 있습니다.";

  it("a parked blocking canvas stays answerable while the run streams", async () => {
    render(
      <SidePanel pane={canvasPane({}, { pending: true, requestId: "rq1", runId: "rn1", interaction: "blocking" })} />,
    );

    // The run is parked on THIS form: locking it on pane.streaming would deadlock
    // the question (the run resumes only via /api/chat/respond).
    const optA = screen.getByRole("button", { name: /A/ }) as HTMLButtonElement;
    expect(optA.disabled).toBe(false);
    fireEvent.click(optA);

    expect((screen.getByRole("button", { name: "보내기" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "건너뛰기" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("보낼 준비가 됐습니다.")).toBeTruthy();
    expect(screen.queryByText(LOCKED)).toBeNull();
  });

  it("an async canvas locks its form while the avatar is responding", () => {
    render(<SidePanel pane={canvasPane({}, { pending: false, interaction: "async" })} />);

    // No park to unblock, so the answer rides a NEW turn — which must wait.
    expect((screen.getByRole("button", { name: /A/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "보내기" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(LOCKED)).toBeTruthy();
  });

  it("the edit path stays locked while parked (edits ride a new turn)", () => {
    const { container } = render(
      <SidePanel pane={canvasPane({}, { pending: true, requestId: "rq1", runId: "rn1", editable: true })} />,
    );

    const textarea = container.querySelector(
      'textarea[placeholder="내용을 수정해 아바타에게 보내세요"]',
    ) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.disabled).toBe(true); // submitCanvasEdit → sendMessage needs the turn to end
    expect((screen.getByRole("button", { name: /A/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("an html canvas renders as its own sandboxed page, never into the app's DOM", () => {
    const { container } = render(
      <SidePanel
        pane={canvasPane(
          { streaming: false },
          { title: "목업", content: "<style>body{display:none}</style><div class=\"card\">카드</div>", contentType: "html", controls: [] },
        )}
      />,
    );

    const frame = container.querySelector("iframe.canvas-html-frame") as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin"); // never allow-scripts
    expect(frame.getAttribute("title")).toBe("목업");
    expect(frame.getAttribute("srcdoc")).toContain("<style>body{display:none}</style>");
    // The page's CSS lives only in the frame's document: none of it reaches the app.
    expect(container.querySelector("style")).toBeNull();
    expect(container.querySelector(".card")).toBeNull();
  });

  it("an svg canvas draws in its own shadow root, and export still finds the drawing", async () => {
    const drawing =
      '<svg viewBox="0 0 10 10"><style>.shape{fill:red} .canvas-panel{display:none}</style>' +
      '<rect class="shape" width="10" height="10"/></svg>';
    const { container } = render(
      <SidePanel
        pane={canvasPane({ streaming: false }, { title: "도형", content: drawing, contentType: "svg", controls: [] })}
      />,
    );

    const host = container.querySelector(".canvas-content .canvas-svg") as HTMLElement;
    expect(host.hasAttribute("data-fit")).toBe(true);
    expect(host.shadowRoot?.querySelector("svg style")?.textContent).toContain(".canvas-panel{display:none}");
    // The drawing and its <style> live only in the shadow root, never the app's DOM.
    expect(container.querySelector(".shape")).toBeNull();
    expect(container.querySelector("style")).toBeNull();

    // SVG export serializes the shadow root's <svg>, its own <style> included.
    const hrefs: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      hrefs.push(this.href);
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "SVG" }));
    } finally {
      click.mockRestore();
    }
    expect(hrefs).toHaveLength(1);
    expect(atob(hrefs[0].split(",")[1])).toContain(".shape{fill:red}");
  });
});

/* ------------------------------------------------------------------ */
/* SidePanel — canvases and opened files as ONE tab strip              */
/* ------------------------------------------------------------------ */

describe("SidePanel tabs", () => {
  const pdf = { id: "file-1", kind: "file", mediaType: "application/pdf", name: "보고.pdf" };

  function mixedPane(over: Record<string, unknown> = {}): any {
    return {
      ...canvasPane(
        { streaming: false },
        { interaction: "async", controls: [{ type: "text", id: "note", label: "의견" }] },
      ),
      avatar: { id: "owner-1", username: "owner", displayName: "나", isOwn: true },
      conversationId: "conv-1",
      liveAttachments: [],
      fileTabs: [{ attachment: pdf, slides: [] }],
      ...over,
    };
  }

  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* no storage: the panel falls back to its defaults */
    }
    replaceState({ chatPanes: [] });
  });

  it("lists canvases and files in one strip, and a typed answer survives a switch", async () => {
    const base = mixedPane();
    const view = render(<SidePanel pane={base} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent?.trim())).toEqual(["질문", "보고.pdf"]);
    fireEvent.change(screen.getByRole("textbox", { name: "의견" }), { target: { value: "작성 중인 의견" } });

    view.rerender(<SidePanel pane={{ ...base, sideTab: { kind: "file", id: "file-1" } }} />);
    expect(screen.getByRole("tab", { name: "보고.pdf" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("textbox", { name: "의견" })).toBeNull();
    expect(screen.getByText("이 파일 형식은 미리보기를 제공하지 않습니다. 다운로드해서 확인해 주세요.")).toBeTruthy();

    view.rerender(<SidePanel pane={{ ...base, sideTab: { kind: "canvas", id: "cv1" } }} />);
    expect((screen.getByRole("textbox", { name: "의견" }) as HTMLTextAreaElement).value).toBe("작성 중인 의견");
  });

  it("marks a tab that changed while another showed, and a file tab's × closes it", async () => {
    const pane = mixedPane({ sideTab: { kind: "canvas", id: "cv1" }, sideUnseen: ["file:file-1"] });
    replaceState({ chatPanes: [pane] });
    render(<SidePanel pane={pane} />);
    expect(screen.getByRole("tab", { name: "보고.pdf (새 항목)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 닫기: 보고.pdf" }));
    expect(readState().chatPanes[0].fileTabs).toEqual([]);
  });

  it("deletes a canvas only through its confirmed trash action", async () => {
    const pane = mixedPane({ fileTabs: [] });
    pane.canvases[0].controls = [];
    replaceState({ chatPanes: [pane] });
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchFn);
    try {
      render(<SidePanel pane={pane} />);
      // No tab carries a delete-× — the strip's × only ever closes a file tab.
      expect(screen.queryByRole("button", { name: /캔버스 닫기/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "캔버스 삭제" }));
      await waitFor(() => expect(get(confirmation)?.title).toBe("캔버스를 삭제할까요?"));
      expect(get(confirmation)?.tone).toBe("danger");
      resolveConfirmation(false);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchFn).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "캔버스 삭제" }));
      await waitFor(() => expect(get(confirmation)).toBeTruthy());
      resolveConfirmation(true);
      await waitFor(() => expect(readState().chatPanes[0].canvases).toEqual([]));
      expect(fetchFn).toHaveBeenCalledWith("/api/chat/canvases/cv1", expect.objectContaining({ method: "DELETE" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders a canvas once per change, not on every store write", async () => {
    const drawing = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    const pane = canvasPane({ streaming: false }, { content: drawing, contentType: "svg", controls: [] });
    const view = render(<SidePanel pane={pane} />);
    await waitFor(() => expect(document.querySelector(".canvas-svg")).toBeTruthy());
    const sanitize = vi.spyOn(DOMPurify, "sanitize");
    try {
      // Unrelated writes (a streamed token…) hand the tab the same canvas again.
      for (let i = 0; i < 5; i += 1) view.rerender(<SidePanel pane={{ ...pane, liveText: "x".repeat(i + 1) }} />);
      expect(sanitize).not.toHaveBeenCalled();
      const refined = { ...pane.canvases[0], content: drawing.replace('width="10"', 'width="5"') };
      view.rerender(<SidePanel pane={{ ...pane, canvases: [refined] }} />);
      expect(sanitize).toHaveBeenCalledTimes(1);
    } finally {
      sanitize.mockRestore();
    }
  });

  it("a refinement re-seeds an untouched edit draft, keeps an edited one, and defaults new controls", async () => {
    const original = { id: "cv1", title: "초안", content: "v1 원본", contentType: "markdown", editable: true, controls: [] };
    const pane = { ...mixedPane({ fileTabs: [] }), canvases: [original] };
    const view = render(<SidePanel pane={pane} />);
    const draft = () => screen.getByRole("textbox", { name: "내용 편집" }) as HTMLTextAreaElement;
    expect(draft().value).toBe("v1 원본");

    const v2 = {
      ...original,
      content: "v2 수정본",
      controls: [{ type: "slider", id: "level", label: "강도", min: 1, max: 9, defaultValue: 4 }],
      interaction: "async",
    };
    view.rerender(<SidePanel pane={{ ...pane, canvases: [v2] }} />);
    // Untouched: it follows the new content, so 보내기 cannot send v1 back.
    expect(draft().value).toBe("v2 수정본");
    expect(screen.getByText("원본과 같은 내용입니다.")).toBeTruthy();
    // The slider added by the refinement starts at its default.
    expect((screen.getByRole("slider", { name: "강도" }) as HTMLInputElement).value).toBe("4");

    fireEvent.change(draft(), { target: { value: "내가 고치는 중" } });
    view.rerender(<SidePanel pane={{ ...pane, canvases: [{ ...v2, content: "v3 또 수정" }] }} />);
    expect(draft().value).toBe("내가 고치는 중");
  });

  it("a sent edit is no longer an edit in progress: the avatar's next version replaces it", async () => {
    const original = { id: "cv1", title: "초안", content: "v1 원본", contentType: "markdown", editable: true, controls: [] };
    const pane = { ...mixedPane({ fileTabs: [] }), canvases: [original] };
    const view = render(<SidePanel pane={pane} />);
    const draft = () => screen.getByRole("textbox", { name: "내용 편집" }) as HTMLTextAreaElement;
    fireEvent.change(draft(), { target: { value: "내 수정본" } });
    fireEvent.click(screen.getByRole("button", { name: "수정해서 보내기" }));
    view.rerender(<SidePanel pane={{ ...pane, canvases: [{ ...original, content: "아바타가 반영한 v2" }] }} />);
    expect(draft().value).toBe("아바타가 반영한 v2");
    expect((screen.getByRole("button", { name: "수정해서 보내기" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closing a fullscreen view whose ⤢ was re-created lands on the new ⤢", async () => {
    const pane = {
      ...canvasPane({ streaming: false }, { controls: [] }),
      canvases: [
        { id: "cv1", title: "하나", content: "첫 캔버스", contentType: "markdown", controls: [] },
        { id: "cv2", title: "둘", content: "둘째 캔버스", contentType: "markdown", controls: [] },
      ],
      sideTab: { kind: "canvas", id: "cv1" },
    };
    const view = render(<SidePanel pane={pane} />);
    fireEvent.click(screen.getByRole("button", { name: "전체화면" }));
    view.rerender(<SidePanel pane={{ ...pane, sideTab: { kind: "canvas", id: "cv2" } }} />);
    view.rerender(<SidePanel pane={{ ...pane, sideTab: { kind: "canvas", id: "cv1" } }} />);
    const stage = screen.getByRole("dialog", { name: "캔버스 전체화면" });
    fireEvent.click(within(stage).getAllByRole("button", { name: "닫기" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "캔버스 전체화면" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "전체화면" }));
  });

  it("a tab the avatar shows next leaves an open fullscreen view; closing it lands on the shown tab", async () => {
    const pane = {
      ...canvasPane({ streaming: false }, { controls: [] }),
      canvases: [
        { id: "cv1", title: "하나", content: "첫 캔버스", contentType: "markdown", controls: [] },
        { id: "cv2", title: "둘", content: "둘째 캔버스", contentType: "markdown", controls: [] },
      ],
    };
    const view = render(<SidePanel pane={pane} />);
    fireEvent.click(screen.getByRole("button", { name: "전체화면" }));
    const stage = screen.getByRole("dialog", { name: "캔버스 전체화면" });
    view.rerender(<SidePanel pane={{ ...pane, sideTab: { kind: "canvas", id: "cv2" } }} />);
    expect(stage.isConnected).toBe(true);
    fireEvent.click(within(stage).getAllByRole("button", { name: "닫기" })[0]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "캔버스 전체화면" })).toBeNull());
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "둘" }));
  });

  it("the collapsed strip says when the panel moved on while folded", async () => {
    localStorage.setItem("canvasPanelCollapsed", "1");
    const pane = {
      ...canvasPane({ streaming: false }, { controls: [] }),
      canvases: [
        { id: "cv1", title: "하나", content: "a", contentType: "markdown", controls: [] },
        { id: "cv2", title: "둘", content: "b", contentType: "markdown", controls: [] },
      ],
      sideTab: { kind: "canvas", id: "cv1" },
    };
    const view = render(<SidePanel pane={pane} />);
    expect(screen.getByRole("button", { name: "패널 펼치기" })).toBeTruthy();
    view.rerender(<SidePanel pane={{ ...pane, sideTab: { kind: "canvas", id: "cv2" } }} />);
    expect(screen.getByRole("button", { name: "패널 펼치기 (확인할 항목 있음)" })).toBeTruthy();
  });

  it("leaves its collapsed strip when an ask for input or an opened file needs it", async () => {
    localStorage.setItem("canvasPanelCollapsed", "1");
    const pane = mixedPane({ sideExpand: true });
    replaceState({ chatPanes: [pane] });
    const { container } = render(<SidePanel pane={pane} />);
    await waitFor(() => expect(readState().chatPanes[0].sideExpand).toBe(false));
    expect(container.querySelector("aside.canvas-panel")?.classList.contains("collapsed")).toBe(false);
    // Shown this once — the viewer's choice to keep it folded still stands.
    expect(localStorage.getItem("canvasPanelCollapsed")).toBe("1");
  });
});
