// The 파일 tab of the side panel (WorkspaceTab) and its place in the tab strip:
// the tree reads one folder at a time, opens the conversation's own folder by
// itself, hides dot entries until asked, and draws a file by its kind — an
// agent-written file never as live markup. Runs in the vitest "react" project.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SidePanel from "../src/client/src/components/SidePanel";
import WorkspaceTab from "../src/client/src/components/WorkspaceTab";
import { closeWorkspaceTab, newChat, openWorkspaceTab, revealWorkspaceFile, workspaceTabStartsOpen } from "../src/client/src/lib/chat";
import { WORKSPACE_TAB, hasSideTabs, resolveSideTab, sideTabs } from "../src/client/src/lib/sidePanel";
import { readState, replaceState, updateState } from "../src/client/src/lib/state";
import type { WorkspaceEntry, WorkspaceListing } from "../src/shared/workspaceFiles";

const PRISTINE = structuredClone(readState());
const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const dir = (name: string, extra: Partial<WorkspaceEntry> = {}): WorkspaceEntry => ({ name, kind: "dir", ...extra });
const file = (name: string, size = 10): WorkspaceEntry => ({ name, kind: "file", size });
const listing = (path: string, entries: WorkspaceEntry[], extra: Partial<WorkspaceListing> = {}): WorkspaceListing => ({
  path,
  exists: true,
  entries,
  total: entries.length,
  truncated: false,
  ...extra,
});

let folders: Record<string, WorkspaceListing>;
let files: Record<string, string | Uint8Array>;
let requests: string[];
/** What `/api/me/workspace/preview` answers, one per ask (the last one repeats). */
let previewAnswers: unknown[];

function stubFetch(): void {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://noah.test");
      requests.push(`${url.pathname}${url.search}`);
      const path = url.searchParams.get("path") ?? "";
      if (url.pathname === "/api/me/workspace") {
        const found = folders[path];
        if (!found) return new Response(JSON.stringify({ error: "폴더를 찾을 수 없습니다." }), { status: 404 });
        const conversation = url.searchParams.get("conversation");
        return new Response(JSON.stringify(conversation ? { ...found, current: `c/${conversation}` } : found), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/api/me/workspace/preview") {
        const answer = previewAnswers.length > 1 ? previewAnswers.shift() : previewAnswers[0];
        return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const content = files[path];
      if (content === undefined) return new Response(JSON.stringify({ error: "파일을 찾을 수 없습니다." }), { status: 404 });
      return new Response(content as BodyInit, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    }),
  );
}

/** Also list `c`, the folder that holds the other conversations' work folders. */
function showOthers(): void {
  fireEvent.click(screen.getByRole("button", { name: "다른 대화" }));
}

/** The pinned first row: this conversation's own folder. */
function currentRow(): HTMLElement {
  return screen.getByRole("button", { name: /이 대화의 작업 폴더/ });
}

function pane(overrides: Record<string, unknown> = {}): any {
  return { id: "p1", conversationId: CONVERSATION, streaming: false, canvases: [], fileTabs: [], workspaceTab: true, ...overrides };
}

beforeEach(() => {
  folders = {
    "": listing("", [dir(".noah"), dir("c"), dir("uploads"), file("notes.md", 12), { name: "out", kind: "link" }]),
    c: listing("c", [
      dir(OTHER, { conversation: { id: OTHER, title: "다른 대화" } }),
      dir(CONVERSATION, { conversation: { id: CONVERSATION, title: "분기 보고 준비" } }),
      dir("33333333-3333-4333-8333-333333333333", { orphan: true }),
    ]),
    [`c/${CONVERSATION}`]: listing(`c/${CONVERSATION}`, [
      file("report.html", 40),
      file("data.csv", 20),
      file("deck.pptx", 900),
      file("archive.zip", 300),
    ]),
    uploads: listing("uploads", []),
  };
  files = {
    "notes.md": "# 제목\n\n<script>window.pwned = 1</script><b style=\"position:fixed\">굵게</b>",
    [`c/${CONVERSATION}/report.html`]: "<h1>보고서</h1><script>window.pwned = 1</script>",
    [`c/${CONVERSATION}/data.csv`]: '이름,값\n"가,나",1\n',
  };
  previewAnswers = [{ status: "ready", id: "a".repeat(64), pages: 2 }];
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  replaceState(structuredClone(PRISTINE));
  localStorage.removeItem("workspaceTabOpen"); // the remembered open/close of the 파일 tab
});

describe("WorkspaceTab", () => {
  it("shows this conversation's folder next to the shared folders, without the other conversations", async () => {
    render(<WorkspaceTab pane={pane()} active />);
    // The conversation's own folder is pinned first and unfolded…
    expect(await screen.findByRole("button", { name: "report.html" })).toBeTruthy();
    expect(currentRow().getAttribute("aria-expanded")).toBe("true");
    expect(within(currentRow()).getByText("현재 대화")).toBeTruthy();
    // …the folders every conversation shares are right there…
    expect(screen.getByRole("button", { name: /uploads/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "notes.md" })).toBeTruthy();
    const rows = Array.from(document.querySelectorAll(".ws-name")).map((node) => node.textContent);
    expect(rows[0]).toBe("이 대화의 작업 폴더");
    // …and `c` with everybody else's folders is not.
    expect(screen.queryByRole("button", { name: /대화별 작업 폴더/ })).toBeNull();
    expect(screen.queryByText("다른 대화", { selector: ".ws-name" })).toBeNull();
    expect(screen.queryByText("삭제된 대화")).toBeNull();
    expect(screen.getByText(/맨 위는 이 대화의 작업 폴더이고/)).toBeTruthy();
    // It asked for the root (which names the folder) and the folder — not for `c`.
    expect(requests).toEqual([
      `/api/me/workspace?conversation=${CONVERSATION}`,
      `/api/me/workspace?path=${encodeURIComponent(`c/${CONVERSATION}`)}&conversation=${CONVERSATION}`,
    ]);
  });

  it("다른 대화 lists the other conversations' folders, without repeating this one", async () => {
    render(<WorkspaceTab pane={pane()} active />);
    await screen.findByRole("button", { name: "report.html" });
    showOthers();
    const all = screen.getByRole("button", { name: /대화별 작업 폴더/ });
    expect(all.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(all);
    expect(await screen.findByText("다른 대화", { selector: ".ws-name" })).toBeTruthy();
    expect(screen.getByText("삭제된 대화")).toBeTruthy();
    // This conversation is the pinned row, not a second entry under `c`.
    expect(screen.queryByText("분기 보고 준비")).toBeNull();
    expect(screen.getAllByText("현재 대화")).toHaveLength(1);

    showOthers();
    expect(screen.queryByRole("button", { name: /대화별 작업 폴더/ })).toBeNull();
    expect(screen.getByRole("button", { name: /uploads/ })).toBeTruthy();
  });

  it("says a conversation has made nothing yet instead of showing an error", async () => {
    render(<WorkspaceTab pane={pane({ conversationId: "not-run-yet" })} active />);
    expect(await screen.findByText("이 대화에서는 아직 만든 파일이 없습니다.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /uploads/ })).toBeTruthy(); // the shared folders are there all the same
    // An existing but empty folder (Noah makes it at the first turn) reads the same.
    folders["c/not-run-yet"] = listing("c/not-run-yet", []);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "새로고침" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("이 대화에서는 아직 만든 파일이 없습니다.")).toBeTruthy();
    // And its files show once it has some.
    folders["c/not-run-yet"] = listing("c/not-run-yet", [file("first.txt", 1)]);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(await screen.findByRole("button", { name: "first.txt" })).toBeTruthy();
  });

  it("reads a folder only when it is opened, and hides dot entries until asked", async () => {
    render(<WorkspaceTab pane={pane({ conversationId: "not-run-yet" })} active />);
    await screen.findByRole("button", { name: /uploads/ });
    expect(requests.some((url) => url.includes("path=uploads"))).toBe(false);
    expect(screen.queryByRole("button", { name: /\.noah/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /uploads/ }));
    expect(await screen.findByText("비어 있습니다.")).toBeTruthy();
    expect(requests.some((url) => url.includes("path=uploads"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "숨김 항목" }));
    expect(screen.getByRole("button", { name: /\.noah/ })).toBeTruthy();
  });

  it("lists a link without a way to open or download it", async () => {
    render(<WorkspaceTab pane={pane({ conversationId: "not-run-yet" })} active />);
    const row = (await screen.findByText("out")).closest(".ws-row") as HTMLElement;
    expect(within(row).getByText("링크 · 열 수 없음")).toBeTruthy();
    expect(row.querySelector("button, a")).toBeNull();
  });

  it("gives every file a download link to the file route", async () => {
    render(<WorkspaceTab pane={pane()} active />);
    const link = (await screen.findByRole("link", { name: "다운로드: deck.pptx" })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      `/api/me/workspace/file?path=${encodeURIComponent(`c/${CONVERSATION}/deck.pptx`)}`,
    );
    expect(link.getAttribute("download")).toBe("deck.pptx");
  });

  it("draws Markdown through the sanitizer and comes back to the same tree", async () => {
    const { container } = render(<WorkspaceTab pane={pane()} active />);
    fireEvent.click(await screen.findByRole("button", { name: "notes.md" }));
    expect(await screen.findByRole("heading", { name: "제목" })).toBeTruthy();
    const md = container.querySelector(".md") as HTMLElement;
    expect(md.querySelector("script")).toBeNull();
    expect(md.querySelector("b")?.getAttribute("style")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    expect(requests).toContain("/api/me/workspace/file?path=notes.md&preview=1");

    // Offered one commit after the text landed (the preview reports it to the tab).
    fireEvent.click(await screen.findByRole("button", { name: "원문 보기" }));
    expect(container.querySelector("pre.ws-text")?.textContent).toContain("<script>window.pwned = 1</script>");

    fireEvent.click(screen.getByRole("button", { name: /목록/ }));
    expect(currentRow().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "report.html" })).toBeTruthy();
  });

  it("draws an HTML file as a script-less sandboxed page, never into the app", async () => {
    const { container } = render(<WorkspaceTab pane={pane()} active />);
    fireEvent.click(await screen.findByRole("button", { name: "report.html" }));
    const frame = await waitFor(() => {
      const found = container.querySelector("iframe") as HTMLIFrameElement | null;
      expect(found).toBeTruthy();
      return found!;
    });
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    const doc = frame.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("<h1>보고서</h1>");
    expect(doc).not.toContain("<script");
    expect(container.querySelector(".cmp-workspace-tab h1")).toBeNull();
  });

  it("draws a CSV as a table", async () => {
    render(<WorkspaceTab pane={pane()} active />);
    fireEvent.click(await screen.findByRole("button", { name: "data.csv" }));
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "이름" })).toBeTruthy();
    expect(within(table).getByRole("cell", { name: "가,나" })).toBeTruthy();
  });

  it("does not fetch a file it will not preview", async () => {
    render(<WorkspaceTab pane={pane()} active />);
    fireEvent.click(await screen.findByRole("button", { name: "archive.zip" }));
    expect(await screen.findByText(/미리보기를 제공하지 않습니다/)).toBeTruthy();
    expect(requests.some((url) => url.includes("archive.zip"))).toBe(false);
    expect(screen.getByRole("link", { name: "다운로드" })).toBeTruthy();
  });

  it("shows a document as the page images the server rendered, asking until they are ready", async () => {
    previewAnswers = [{ status: "rendering" }, { status: "ready", id: "b".repeat(64), pages: 3 }];
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = render(<WorkspaceTab pane={pane()} active />);
      fireEvent.click(await screen.findByRole("button", { name: "deck.pptx" }));
      expect(await screen.findByText(/문서를 미리보기로 변환하는 중입니다/)).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      await waitFor(() => expect(container.querySelectorAll(".ws-preview img")).toHaveLength(3));
      const sources = Array.from(container.querySelectorAll(".ws-preview img")).map((img) => img.getAttribute("src"));
      expect(sources[2]).toBe(`/api/me/workspace/preview/page?id=${"b".repeat(64)}&n=3`);
      expect(screen.getByText("3 / 3")).toBeTruthy();
      expect(screen.getByText(/글꼴·배치가 조금 다를 수 있습니다/)).toBeTruthy();
      // The file's bytes were never fetched for the preview: only the conversion was asked for.
      const asked = requests.filter((url) => url.includes("deck.pptx"));
      expect(asked.every((url) => url.startsWith("/api/me/workspace/preview?"))).toBe(true);
      expect(asked).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why a document has no preview, and 새로고침 asks the server to try again", async () => {
    previewAnswers = [{ status: "failed", reason: "RENDER_FAILED" }];
    render(<WorkspaceTab pane={pane()} active />);
    fireEvent.click(await screen.findByRole("button", { name: "deck.pptx" }));
    expect(await screen.findByText(/미리보기를 만들지 못했습니다/)).toBeTruthy();
    expect(requests.filter((url) => url.includes("/preview?")).every((url) => !url.includes("retry=1"))).toBe(true);

    previewAnswers = [{ status: "ready", id: "c".repeat(64), pages: 1 }];
    const refresh = screen.getAllByRole("button", { name: "새로고침" }).find((button) => button.closest("[hidden]") === null)!;
    fireEvent.click(refresh);
    await waitFor(() => expect(requests.some((url) => url.includes("/preview?") && url.includes("retry=1"))).toBe(true));
    await waitFor(() => expect(document.querySelectorAll(".ws-preview img")).toHaveLength(1));

    previewAnswers = [{ status: "failed", reason: "UNAVAILABLE" }];
    fireEvent.click(screen.getByRole("button", { name: /목록/ }));
    fireEvent.click(screen.getByRole("button", { name: "deck.pptx" }));
    expect(await screen.findByText(/이 서버에서는 문서 미리보기를 제공하지 않습니다/)).toBeTruthy();
  });

  it("calls bytes that are not text binary instead of drawing them", async () => {
    folders[""] = listing("", [file("blob", 4)]);
    files.blob = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    render(<WorkspaceTab pane={pane({ conversationId: "not-run-yet" })} active />);
    fireEvent.click(await screen.findByRole("button", { name: "blob" }));
    expect(await screen.findByText(/미리보기를 제공하지 않습니다/)).toBeTruthy();
  });

  it("re-reads the open folders on 새로고침 and when the answer ends", async () => {
    const view = render(<WorkspaceTab pane={pane({ streaming: true })} active />);
    await screen.findByRole("button", { name: "report.html" });
    folders[`c/${CONVERSATION}`] = listing(`c/${CONVERSATION}`, [file("report.html", 40), file("new.txt", 3)]);
    view.rerender(<WorkspaceTab pane={pane({ streaming: false })} active />);
    expect(await screen.findByRole("button", { name: "new.txt" })).toBeTruthy();

    folders[`c/${CONVERSATION}`] = listing(`c/${CONVERSATION}`, [file("later.txt", 3)]);
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    expect(await screen.findByRole("button", { name: "later.txt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "new.txt" })).toBeNull();
  });

  it("keeps re-reading while ANOTHER pane's avatar is answering, and once more when it ends", async () => {
    // Split view: the panel serves p1 (idle); p2's avatar is writing files.
    const shown = pane({ id: "p1" });
    const busy = pane({ id: "p2", conversationId: OTHER, streaming: true });
    replaceState({ ...structuredClone(PRISTINE), chatPanes: [shown, busy] as any, activePaneId: "p1" });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // jsdom never lays out, and the poll skips a panel that is folded away (no boxes): give it one.
    const boxes = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    try {
      render(<WorkspaceTab pane={readState().chatPanes[0]} active />);
      await screen.findByRole("button", { name: "report.html" });
      fireEvent.click(screen.getByRole("button", { name: /uploads/ }));
      await screen.findByText("비어 있습니다.");

      // The other conversation's avatar drops a file into the shared folder.
      folders.uploads = listing("uploads", [file("from-pane-2.txt", 5)]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4100);
      });
      expect(await screen.findByRole("button", { name: "from-pane-2.txt" })).toBeTruthy();

      // Its answer ends: one more re-read, then no more polling.
      folders.uploads = listing("uploads", [file("from-pane-2.txt", 5), file("last.txt", 1)]);
      await act(async () => {
        updateState((state) => {
          state.chatPanes[1].streaming = false;
        });
      });
      expect(await screen.findByRole("button", { name: "last.txt" })).toBeTruthy();
      await waitFor(() => expect((screen.getByRole("button", { name: "새로고침" }) as HTMLButtonElement).disabled).toBe(false));
      requests.length = 0;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(requests).toEqual([]);
    } finally {
      boxes.mockRestore();
      vi.useRealTimers();
    }
  });

  it("follows the pane to another conversation even while a re-read is running", async () => {
    folders[`c/${OTHER}`] = listing(`c/${OTHER}`, [file("other.txt", 3)]);
    // Hold the first root read open, so the conversation changes mid-flight.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = globalThis.fetch;
    let held = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!held) {
          held = true;
          await gate;
        }
        return real(input, init);
      }),
    );
    const view = render(<WorkspaceTab pane={pane()} active />);
    view.rerender(<WorkspaceTab pane={pane({ conversationId: OTHER })} active />);
    await act(async () => {
      release();
    });
    // The pinned folder is now the other conversation's: its files, none of the first one's.
    expect(await screen.findByRole("button", { name: "other.txt" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "report.html" })).toBeNull();
    expect(currentRow().getAttribute("title")).toBe(`/workspace/c/${OTHER}`);
  });

  it("re-reads only what is on screen", async () => {
    folders[`c/${CONVERSATION}`] = listing(`c/${CONVERSATION}`, [dir("out"), file("report.html", 40)]);
    folders[`c/${CONVERSATION}/out`] = listing(`c/${CONVERSATION}/out`, [file("a.txt", 1)]);
    render(<WorkspaceTab pane={pane()} active />);
    fireEvent.click(await screen.findByRole("button", { name: "out" }));
    await screen.findByRole("button", { name: "a.txt" });
    fireEvent.click(screen.getByRole("button", { name: /uploads/ }));
    await screen.findByText("비어 있습니다.");
    // `c` unfolded, then hidden again: it must not be asked for while it is not shown.
    showOthers();
    fireEvent.click(screen.getByRole("button", { name: /대화별 작업 폴더/ }));
    await screen.findByText("삭제된 대화");
    showOthers();

    const idle = () => expect((screen.getByRole("button", { name: "새로고침" }) as HTMLButtonElement).disabled).toBe(false);
    await waitFor(idle);
    requests.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(requests.length).toBeGreaterThanOrEqual(4));
    await waitFor(idle);
    const asked = requests.map((url) => new URL(url, "http://noah.test").searchParams.get("path") ?? "");
    expect(asked.sort()).toEqual(["", `c/${CONVERSATION}`, `c/${CONVERSATION}/out`, "uploads"]);
  });

  it("leaves the conversation's folder folded once the viewer folds it", async () => {
    render(<WorkspaceTab pane={pane()} active />);
    await screen.findByRole("button", { name: "report.html" });
    fireEvent.click(currentRow());
    expect(screen.queryByRole("button", { name: "report.html" })).toBeNull();
    requests.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    await waitFor(() => expect((screen.getByRole("button", { name: "새로고침" }) as HTMLButtonElement).disabled).toBe(false));
    // Only the root was read: a re-read neither unfolds it again nor asks for what is hidden.
    expect(requests.every((url) => !url.includes("path="))).toBe(true);
    expect(currentRow().getAttribute("aria-expanded")).toBe("false");
  });

  it("moves keyboard focus into the open file and back onto its row", async () => {
    render(<WorkspaceTab pane={pane()} active />);
    fireEvent.click(await screen.findByRole("button", { name: "data.csv" }));
    const back = await screen.findByRole("button", { name: /목록/ });
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "data.csv" }));
  });

  it("says a huge folder holds more than it counted", async () => {
    folders[""] = listing("", [file("a.txt")], { total: 20000, totalIsMinimum: true, truncated: true });
    render(<WorkspaceTab pane={pane({ conversationId: "not-run-yet" })} active />);
    expect(await screen.findByText(/20,000개 이상 중/)).toBeTruthy();
  });

  it("says so when the sandbox has never been used", async () => {
    folders[""] = listing("", [], { exists: false });
    render(<WorkspaceTab pane={pane({ conversationId: "not-run-yet" })} active />);
    expect(await screen.findByText("이 대화에서는 아직 만든 파일이 없습니다.")).toBeTruthy();
    expect(currentRow().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("a shared file's card pointing into the 파일 tab (작업 폴더에서 보기)", () => {
  const reveal = (path: string, nonce = 1) => pane({ workspaceReveal: { path, nonce } });

  it("unfolds the tree down to the file, marks its row and puts keyboard focus on it", async () => {
    folders.uploads = listing("uploads", [dir("spec")]);
    folders["uploads/spec"] = listing("uploads/spec", [file("요구사항.md", 30), file("other.md", 5)]);
    render(<WorkspaceTab pane={reveal("uploads/spec/요구사항.md")} active />);
    const row = await screen.findByRole("button", { name: "요구사항.md" });
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.closest(".ws-row")!.classList.contains("ws-row-marked")).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(row));
    expect(screen.getByRole("button", { name: /uploads/ }).getAttribute("aria-expanded")).toBe("true");
    // Only the one row is marked, and nothing is said above the tree.
    expect(document.querySelectorAll(".ws-row-marked")).toHaveLength(1);
    expect(screen.queryByRole("status")).toBeNull();
    // The file is shown in the tree, not opened: the card already holds its copy.
    expect(screen.queryByRole("button", { name: /목록/ })).toBeNull();
  });

  it("finds a file of this conversation under the pinned folder, without listing the other conversations", async () => {
    render(<WorkspaceTab pane={reveal(`c/${CONVERSATION}/deck.pptx`)} active />);
    const row = await screen.findByRole("button", { name: "deck.pptx" });
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
    expect(currentRow().getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("button", { name: /대화별 작업 폴더/ })).toBeNull();
    expect(screen.getByRole("button", { name: "다른 대화" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("shows another conversation's file behind 다른 대화, and a dot folder's behind 숨김 항목", async () => {
    folders[`c/${OTHER}`] = listing(`c/${OTHER}`, [file("old.md", 3)]);
    const view = render(<WorkspaceTab pane={reveal(`c/${OTHER}/old.md`)} active />);
    await waitFor(() => expect(screen.getByRole("button", { name: "old.md" }).getAttribute("aria-current")).toBe("true"));
    expect(screen.getByRole("button", { name: "다른 대화" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "숨김 항목" }).getAttribute("aria-pressed")).toBe("false");

    folders[".noah"] = listing(".noah", [file("state.json", 2)]);
    view.rerender(<WorkspaceTab pane={reveal(".noah/state.json", 2)} active />);
    await waitFor(() => expect(screen.getByRole("button", { name: "state.json" }).getAttribute("aria-current")).toBe("true"));
    expect(screen.getByRole("button", { name: "숨김 항목" }).getAttribute("aria-pressed")).toBe("true");
    // The earlier mark moved: one row at a time.
    expect(document.querySelectorAll(".ws-row-marked")).toHaveLength(1);
  });

  it("says a file that is no longer there is gone — the tree still opens as far as it exists", async () => {
    render(<WorkspaceTab pane={reveal(`c/${CONVERSATION}/ghost.pptx`)} active />);
    const said = await screen.findByRole("status");
    expect(said.textContent).toContain("작업 폴더에서 이 파일을 찾지 못했습니다");
    expect(said.textContent).toContain("카드의 다운로드는 전달한 시점의 사본");
    // Focus goes to the line (the tree may be scrolled far below it).
    await waitFor(() => expect(document.activeElement).toBe(said));
    expect(await screen.findByRole("button", { name: "deck.pptx" })).toBeTruthy();
    expect(document.querySelector(".ws-row-marked")).toBeNull();
    // 새로고침 clears the line.
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("says the same when a folder on the way is gone, and when the name is a folder now", async () => {
    const view = render(<WorkspaceTab pane={reveal("uploads/removed/x.md")} active />);
    expect((await screen.findByRole("status")).textContent).toContain("찾지 못했습니다");
    view.rerender(<WorkspaceTab pane={reveal("uploads", 2)} active />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("찾지 못했습니다"));
    expect(document.querySelector(".ws-row-marked")).toBeNull();
  });

  it("drops the mark once the viewer opens a file", async () => {
    render(<WorkspaceTab pane={reveal(`c/${CONVERSATION}/data.csv`)} active />);
    const row = await screen.findByRole("button", { name: "data.csv" });
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
    fireEvent.click(row);
    fireEvent.click(await screen.findByRole("button", { name: /목록/ }));
    expect(screen.getByRole("button", { name: "data.csv" }).getAttribute("aria-current")).toBeNull();
  });

  it("opens the tab from the card's press and is asked only once", async () => {
    const base = structuredClone(PRISTINE);
    replaceState({ ...base, chatPanes: [pane({ workspaceTab: false, fileTabs: [] })] as any, activePaneId: "p1" });
    act(() => revealWorkspaceFile("p1", `c/${CONVERSATION}/deck.pptx`));
    const state = readState();
    expect(state.workspaceTabOpen).toBe(true);
    expect(state.chatPanes[0].workspaceTab).toBe(true);
    expect(state.chatPanes[0].sideTab).toEqual(WORKSPACE_TAB);
    expect(state.chatPanes[0].sideFollow).toBe(false);
    expect(state.chatPanes[0].sideExpand).toBe(true);
    expect(state.chatPanes[0].workspaceReveal?.path).toBe(`c/${CONVERSATION}/deck.pptx`);

    const view = render(<SidePanel pane={readState().chatPanes[0]} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "deck.pptx" }).getAttribute("aria-current")).toBe("true"));
    // Taken: a tab closed and opened again starts plain.
    expect(readState().chatPanes[0].workspaceReveal).toBeUndefined();
    view.unmount();
    render(<SidePanel pane={readState().chatPanes[0]} />);
    await screen.findByRole("button", { name: "deck.pptx" });
    expect(document.querySelector(".ws-row-marked")).toBeNull();
  });
});

describe("the 파일 tab in the side panel", () => {
  it("is the last tab, and the default only when nothing else is open", () => {
    const only = pane();
    expect(hasSideTabs(only)).toBe(true);
    expect(resolveSideTab(only)).toEqual(WORKSPACE_TAB);
    const withCanvas = pane({ canvases: [{ id: "cv1", title: "표", content: "x", contentType: "markdown" }] });
    expect(sideTabs(withCanvas).map((tab) => tab.kind)).toEqual(["canvas", "workspace"]);
    expect(resolveSideTab(withCanvas)).toEqual({ kind: "canvas", id: "cv1" });
    expect(hasSideTabs(pane({ workspaceTab: false }))).toBe(false);
  });

  it("opens for every pane, stays for the next one, and closes everywhere", () => {
    const base = structuredClone(PRISTINE);
    replaceState({ ...base, chatPanes: [pane({ id: "p1", workspaceTab: false }), pane({ id: "p2", workspaceTab: false })] as any, activePaneId: "p1" });
    act(() => openWorkspaceTab("p1"));
    const state = readState();
    expect(state.workspaceTabOpen).toBe(true);
    expect(state.chatPanes.map((item) => item.workspaceTab)).toEqual([true, true]);
    expect(state.chatPanes[0].sideTab).toEqual(WORKSPACE_TAB);
    expect(state.chatPanes[0].sideFollow).toBe(false);
    expect(state.chatPanes[0].sideExpand).toBe(true);
    expect(state.chatPanes[1].sideTab ?? null).toBeNull();

    act(() => closeWorkspaceTab());
    expect(readState().workspaceTabOpen).toBe(false);
    expect(readState().chatPanes.map((item) => item.workspaceTab)).toEqual([false, false]);
    expect(resolveSideTab(readState().chatPanes[0])).toBeNull();
  });

  it("is open by default where the deployment has it, until the viewer closes it", () => {
    expect(workspaceTabStartsOpen({ bootstrap: { workspaceFiles: true } as any })).toBe(true);
    expect(workspaceTabStartsOpen({ bootstrap: { workspaceFiles: false } as any })).toBe(false);
    expect(workspaceTabStartsOpen({ bootstrap: null })).toBe(false);
    // The viewer's last word on this page wins over the default, either way.
    expect(workspaceTabStartsOpen({ bootstrap: { workspaceFiles: true } as any, workspaceTabOpen: false })).toBe(false);
    expect(workspaceTabStartsOpen({ bootstrap: { workspaceFiles: true } as any, workspaceTabOpen: true })).toBe(true);
  });

  it("remembers the viewer's close and open across a reload", () => {
    const fresh = { bootstrap: { workspaceFiles: true } as any }; // a page just loaded: nothing said on it yet
    replaceState({ ...structuredClone(PRISTINE), workspaceTabOpen: undefined, chatPanes: [pane()] as any, activePaneId: "p1" });
    act(() => closeWorkspaceTab());
    expect(localStorage.getItem("workspaceTabOpen")).toBe("0");
    expect(workspaceTabStartsOpen(fresh)).toBe(false);
    act(() => openWorkspaceTab("p1"));
    expect(localStorage.getItem("workspaceTabOpen")).toBe("1");
    expect(workspaceTabStartsOpen(fresh)).toBe(true);
    // A card's 폴더에서 보기 opens the tab too, so it counts as opening it.
    act(() => closeWorkspaceTab());
    act(() => revealWorkspaceFile("p1", "notes.md"));
    expect(workspaceTabStartsOpen(fresh)).toBe(true);
    // A remembered "open" never shows a tab the deployment does not have; anything else stored is no choice.
    expect(workspaceTabStartsOpen({ bootstrap: { workspaceFiles: false } as any })).toBe(false);
    localStorage.setItem("workspaceTabOpen", "yes");
    expect(workspaceTabStartsOpen(fresh)).toBe(true);
  });

  it("starts a new chat with the tab in the strip, without taking the panel from the avatar", () => {
    const base = structuredClone(PRISTINE);
    const avatar = { id: "owner-1", username: "owner", displayName: "나", isOwn: true } as any;
    // A pane from before the deployment's answer arrived stands in for "any pane": the chat made next is what counts.
    const seed = pane({ id: "p1", avatar, workspaceTab: false });
    // (`replaceState` patches: an earlier test's close would otherwise still stand.)
    replaceState({ ...base, bootstrap: { workspaceFiles: true } as any, workspaceTabOpen: undefined, currentAvatar: avatar, chatPanes: [seed] as any, activePaneId: "p1" });
    act(() => newChat());
    const made = readState().chatPanes[0];
    expect(made.workspaceTab).toBe(true);
    expect(resolveSideTab(made)).toEqual(WORKSPACE_TAB);
    // Only in the strip: nothing was picked for the viewer and the panel is not forced open.
    expect(made.sideTab ?? null).toBeNull();
    expect(made.sideFollow).toBeUndefined();
    expect(made.sideExpand).toBeFalsy();

    // Closed by the viewer: the next chat starts without it.
    act(() => closeWorkspaceTab());
    act(() => newChat(readState().chatPanes[0].id));
    expect(readState().chatPanes.every((item) => !item.workspaceTab)).toBe(true);
    // Opened again: it is back for the chats made after.
    act(() => openWorkspaceTab(readState().chatPanes[0].id));
    act(() => newChat(readState().chatPanes[0].id));
    expect(readState().chatPanes.every((item) => item.workspaceTab)).toBe(true);
  });

  it("shows in the strip with its own close button", async () => {
    render(<SidePanel pane={pane()} />);
    const tab = screen.getByRole("tab", { name: /작업 폴더/ });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "작업 폴더 닫기" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "report.html" })).toBeTruthy();
  });
});
