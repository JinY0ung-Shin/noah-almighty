import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BrainView from "../src/client/src/views/BrainView";
import { readState, replaceState } from "../src/client/src/lib/state";
import type { User } from "../src/client/src/lib/types";

const user = {
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
  modelDefault: null,
  effortDefault: null,
  mcpToolGroupsDefault: null,
  allowedMcpToolGroups: null,
  secretNames: [],
  shellExposedSecretNames: [],
  browserSecrets: [],
  sshPublicKey: null,
  experimentalFeatures: [],
  sharedAccount: false,
  onboardedAt: null,
  lastSeenRelease: null,
  seenFeatureHints: [],
} satisfies User;

beforeEach(() => {
  replaceState({ user, view: "brain", settingsTab: "profile" });
});

describe("BrainView empty setup state", () => {
  it("does not request a missing repository and routes the CTA to knowledge settings", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<BrainView />);

    expect(screen.getByRole("heading", { name: "연결된 지식 저장소가 없습니다" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "새로고침" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "지식 저장소 설정" }));
    expect(readState().view).toBe("settings");
    expect(readState().settingsTab).toBe("knowledge");
  });
});

describe("BrainView team brain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function serve(graph: unknown): string[] {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      return url === "/api/team-brain/graph"
        ? new Response(JSON.stringify({ graph }), { status: 200, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    return urls;
  }

  it("says the team writes it together, and shows no review queue — for an admin either", async () => {
    replaceState({ user: { ...user, roles: ["admin"] }, view: "teamBrain" });
    const urls = serve({ nodes: [], edges: [] });
    const { container } = render(<BrainView scope="team" />);

    expect(screen.getByRole("heading", { name: "팀 브레인", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(await screen.findByText(/팀 브레인에 아직 노트가 없습니다\. 아바타에게 팀과 나눌 내용을 알려 주고/)).toBeTruthy();
    const pane = screen.getByRole("complementary", { name: "노트 내용" });
    expect(within(pane).getByText(/팀원 모두가 함께 쓰는 위키입니다.*카드의 ‘팀 브레인에 반영’을 누르면 바로 저장됩니다\./)).toBeTruthy();
    // No list, no button in the pane: the lists and their actions went with the review queue.
    expect(within(pane).queryByRole("heading")).toBeNull();
    expect(within(pane).queryByRole("button")).toBeNull();
    expect(container.textContent).not.toMatch(/관리자|승인|검토|제안|반려|철회/);
    // Only the graph is read — none of the retired status / proposals routes.
    expect(urls).toEqual(["/api/team-brain/graph"]);

    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(urls).toEqual(["/api/team-brain/graph", "/api/team-brain/graph"]));
  });

  it("keeps the hint above the most-linked notes", async () => {
    const node = (id: string, label: string) => ({ id, label, section: "howto", tags: [], dangling: false });
    serve({
      nodes: [node("wiki/howto/a.md", "배포 서버 접속"), node("wiki/howto/b.md", "점프 호스트")],
      edges: [{ source: "wiki/howto/a.md", target: "wiki/howto/b.md" }],
    });
    render(<BrainView scope="team" />);

    const hubs = await screen.findByRole("region", { name: "주요 노트" });
    expect(within(hubs).getByRole("button", { name: /배포 서버 접속/ })).toBeTruthy();
    const hint = screen.getByText(/팀원 모두가 함께 쓰는 위키입니다/);
    expect(hint.compareDocumentPosition(hubs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("BrainView note pane width", () => {
  const KEY = "noah.brainNoteWidth";
  // jsdom lays nothing out: a 1400px body, and a pane that is as wide as its dragged width (700px by default).
  const BODY = 1400;
  const DEFAULT = 700;

  beforeEach(() => {
    localStorage.clear();
    replaceState({ user, view: "teamBrain" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const ok = String(input) === "/api/team-brain/graph";
      return new Response(JSON.stringify(ok ? { graph: { nodes: [], edges: [] } } : { error: "not found" }), {
        status: ok ? 200 : 404,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = this.classList.contains("brain-body")
        ? BODY
        : this.classList.contains("brain-note")
          ? parseFloat(this.style.getPropertyValue("--brain-note-w")) || DEFAULT
          : 0;
      return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function parts(): { splitter: HTMLElement; note: HTMLElement } {
    return {
      splitter: screen.getByRole("separator", { name: "노트 패널 너비 조절" }),
      note: screen.getByRole("complementary", { name: "노트 내용" }),
    };
  }
  const widthOf = (note: HTMLElement) => note.style.getPropertyValue("--brain-note-w");

  it("leaves the CSS default alone until a width is stored, and applies a stored one", () => {
    const first = render(<BrainView scope="team" />);
    expect(widthOf(parts().note)).toBe("");
    first.unmount();

    localStorage.setItem(KEY, "640");
    render(<BrainView scope="team" />);
    expect(widthOf(parts().note)).toBe("640px");
    expect(parts().splitter.getAttribute("aria-valuenow")).toBe("640");
  });

  it("ignores a stored width that is not a usable number", () => {
    localStorage.setItem(KEY, "12");
    render(<BrainView scope="team" />);
    expect(widthOf(parts().note)).toBe("");
  });

  it("widens and narrows from the keyboard, bounded by what the graph can spare, and resets on Home", () => {
    render(<BrainView scope="team" />);
    const { splitter, note } = parts();

    fireEvent.keyDown(splitter, { key: "ArrowLeft" });
    expect(widthOf(note)).toBe(`${DEFAULT + 16}px`);
    expect(localStorage.getItem(KEY)).toBe(String(DEFAULT + 16));

    fireEvent.keyDown(splitter, { key: "ArrowRight", shiftKey: true });
    expect(widthOf(note)).toBe(`${DEFAULT + 16 - 48}px`);

    fireEvent.keyDown(splitter, { key: "End" });
    expect(widthOf(note)).toBe(`${BODY - 320 - 16}px`);
    fireEvent.keyDown(splitter, { key: "ArrowLeft" });
    expect(widthOf(note)).toBe(`${BODY - 320 - 16}px`);

    fireEvent.keyDown(splitter, { key: "Home" });
    expect(widthOf(note)).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("follows a drag (left = wider), never under the minimum, and stores the width on release", () => {
    render(<BrainView scope="team" />);
    const { splitter, note } = parts();

    fireEvent.pointerDown(splitter, { clientX: 600, pointerId: 1 });
    expect(document.body.classList.contains("col-resizing")).toBe(true);
    fireEvent.pointerMove(splitter, { clientX: 500, pointerId: 1 });
    expect(widthOf(note)).toBe(`${DEFAULT + 100}px`);
    expect(localStorage.getItem(KEY)).toBeNull();
    fireEvent.pointerMove(splitter, { clientX: 1300, pointerId: 1 });
    expect(widthOf(note)).toBe("320px");
    fireEvent.pointerUp(splitter, { pointerId: 1 });
    expect(document.body.classList.contains("col-resizing")).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("320");

    fireEvent.doubleClick(splitter);
    expect(widthOf(note)).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("stores nothing for a press that never moves", () => {
    render(<BrainView scope="team" />);
    const { splitter, note } = parts();
    fireEvent.pointerDown(splitter, { clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(splitter, { pointerId: 1 });
    expect(widthOf(note)).toBe("");
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
