// 설정 ▸ 지식·플러그인 (SettingsKnowledgeTab) and the plugin picker it embeds
// (SettingsPluginSelect). Neither had a Svelte component test; these pin what a
// port is most likely to break: the tab is ALWAYS MOUNTED and gates only its
// markup on `active`, each card saves in place without wiping the text typed
// into the others, the DOM work that used to follow `await tick()` runs once
// the panel it needs is rendered, and the picker re-seeds from the saved
// selection.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsKnowledgeTab from "../src/client/src/components/SettingsKnowledgeTab";
import SettingsPluginSelect from "../src/client/src/components/SettingsPluginSelect";
import { readState, replaceState, toasts } from "../src/client/src/lib/state";
import { get } from "../src/client/src/lib/store";
import type { Plugin, RepoPluginContents, User } from "../src/client/src/lib/types";

// The graph modal is another component's business (and draws on a canvas);
// here only its wiring matters: mounted on demand, closed through `onClose`.
vi.mock("../src/client/src/components/GraphViewModal", () => ({
  default: ({ onClose }: { onClose?: () => void }) => (
    <div role="dialog" aria-label="지식 그래프">
      <button type="button" onClick={() => onClose?.()}>
        닫기
      </button>
    </div>
  ),
}));

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];
let answer: (call: Call) => unknown | Promise<unknown> | undefined = () => undefined;
/** What the page looked like each time something was scrolled into view. */
let scrolled: Array<{ id: string; block: unknown; checkboxes: number; focusedInside: boolean }> = [];

function userOf(over: Partial<User> = {}): User {
  return {
    id: "me",
    username: "me",
    displayName: "나",
    alias: "",
    bio: "",
    intro: "",
    persona: "",
    hashtags: [],
    hasImage: false,
    visibility: "group",
    roles: [],
    secretNames: [],
    browserSecrets: [],
    knowledgeRepo: "",
    knowledgeBranch: "",
    knowledgeSelected: null,
    gitTokenSet: false,
    sshPublicKey: "",
    onboardedAt: "2026-08-01T00:00:00.000Z",
    allowedMcpToolGroups: null,
    mcpToolGroupsDefault: null,
    ...over,
  } as unknown as User;
}

function pluginOf(over: Partial<Plugin> = {}): Plugin {
  return {
    id: "p1",
    repo: "team/tools",
    ref: null,
    label: null,
    enabled: true,
    selected: null,
    lastSyncedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

const MARKET: RepoPluginContents = {
  kind: "marketplace",
  plugins: [
    { name: "alpha", loadable: true },
    { name: "beta", loadable: true },
    { name: "broken", loadable: false },
  ],
};

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const click = (element: Element): Promise<void> => act(async () => void fireEvent.click(element));
const submit = (element: Element): Promise<void> => act(async () => void fireEvent.submit(element.closest("form")!));

const field = (label: string): HTMLInputElement => screen.getByText(label).closest("label")!.querySelector("input")!;

const boxes = (): Array<[string, boolean, boolean]> =>
  [...document.querySelectorAll<HTMLInputElement>(".pc-item input")].map((box) => [
    box.closest("label")!.textContent || "",
    box.checked,
    box.disabled,
  ]);

beforeEach(() => {
  calls = [];
  scrolled = [];
  answer = () => undefined;
  toasts.set([]);
  // jsdom has no layout, so no scrollIntoView either.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value(this: Element, options?: ScrollIntoViewOptions) {
      scrolled.push({
        id: this.id,
        block: options?.block,
        checkboxes: this.querySelectorAll('input[type="checkbox"]').length,
        focusedInside: this.contains(document.activeElement),
      });
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method || "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const custom = await answer(call);
      if (custom !== undefined) return ok(custom);
      return ok({});
    }),
  );
  replaceState({ user: userOf(), plugins: [], settingsTab: "knowledge", view: "settings" });
});

afterEach(() => {
  toasts.set([]);
  vi.unstubAllGlobals();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("SettingsPluginSelect", () => {
  it("says why there is nothing to pick", () => {
    const onSave = vi.fn(async () => {});
    const view = render(<SettingsPluginSelect info={{ kind: "none", plugins: [] }} selected={null} headText="머리말" onSave={onSave} />);
    expect(view.container.textContent).toBe("Claude 플러그인 저장소가 아닙니다 (plugin.json / marketplace.json 없음).");
    expect(view.container.querySelector(".error-note")?.getAttribute("role")).toBe("alert");

    view.rerender(<SettingsPluginSelect info={{ kind: "single", plugins: [] }} selected={null} headText="머리말" onSave={onSave} />);
    expect(view.container.textContent).toBe("단일 플러그인 저장소입니다 — 선택할 항목이 없습니다.");

    view.rerender(<SettingsPluginSelect info={{ kind: "marketplace", plugins: [] }} selected={null} headText="머리말" onSave={onSave} />);
    expect(view.container.textContent).toBe("불러올 수 있는 플러그인이 없습니다.");
  });

  it("ticks every loadable row for 'load all', and saves a subset by name", async () => {
    const onSave = vi.fn(async () => {});
    render(<SettingsPluginSelect info={MARKET} selected={null} headText="머리말" onSave={onSave} />);

    expect(boxes()).toEqual([
      ["alpha", true, false],
      ["beta", true, false],
      ["broken (로드 불가)", false, true],
    ]);
    expect(document.querySelector(".pc-item.disabled")?.textContent).toBe("broken (로드 불가)");
    expect(document.querySelector(".pc-summary")?.textContent).toBe("로드 가능한 2개 전체가 사용됩니다.");
    const save = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>(".pc-actions button")!;
    expect(save().textContent).toBe("변경 없음");
    expect(save().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "전체 사용" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));

    expect(document.querySelector(".pc-summary")?.textContent).toBe("1개만 사용하도록 저장됩니다.");
    expect(document.querySelector(".pc-save-status")?.className).toBe("pc-save-status dirty");
    expect(save().textContent).toBe("선택 저장");
    await click(save());

    expect(onSave.mock.calls).toEqual([[["alpha"]]]);
    expect(get(toasts).at(-1)?.message).toBe("플러그인 선택을 저장했습니다.");
  });

  it("re-seeds from a new saved selection and drops ticks that were not saved", async () => {
    const onSave = vi.fn(async () => {});
    const view = render(<SettingsPluginSelect info={MARKET} selected={null} headText="머리말" onSave={onSave} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "alpha" }));
    expect(boxes().map(([, checked]) => checked)).toEqual([false, true, false]);

    // The parent's store now holds another selection (a save, or another tab).
    view.rerender(<SettingsPluginSelect info={MARKET} selected={["alpha"]} headText="머리말" onSave={onSave} />);

    expect(boxes().map(([, checked]) => checked)).toEqual([true, false, false]);
    expect(document.querySelector(".pc-actions button")?.textContent).toBe("변경 없음");

    // 전체 사용 → everything ticked means "load all": saved as null.
    fireEvent.click(screen.getByRole("button", { name: "전체 사용" }));
    expect(boxes().map(([, checked]) => checked)).toEqual([true, true, false]);
    await click(document.querySelector(".pc-actions button")!);
    expect(onSave.mock.calls).toEqual([[null]]);

    // 저장값 복원 goes back to what the parent says is saved.
    fireEvent.click(screen.getByRole("button", { name: "저장값 복원" }));
    expect(boxes().map(([, checked]) => checked)).toEqual([true, false, false]);
  });

  it("keeps the ticks and shows the reason when the save is rejected", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("권한이 없습니다");
    });
    render(<SettingsPluginSelect info={MARKET} selected={null} headText="머리말" onSave={onSave} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));

    await click(document.querySelector(".pc-actions button")!);

    const status = document.querySelector(".pc-save-status")!;
    expect(status.textContent).toBe("저장 실패: 권한이 없습니다");
    expect(status.className).toBe("pc-save-status invalid");
    expect(boxes().map(([, checked]) => checked)).toEqual([true, false, false]);
    expect((document.querySelector(".pc-actions button") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("SettingsKnowledgeTab — always mounted, saved in place", () => {
  it("renders nothing while inactive and keeps unsaved text across a tab switch", () => {
    const view = render(<SettingsKnowledgeTab active={false} />);
    expect(view.container.innerHTML).toBe("");

    view.rerender(<SettingsKnowledgeTab active={true} />);
    fireEvent.change(field("저장소 주소"), { target: { value: "me/brain" } });
    fireEvent.change(field("플러그인 저장소"), { target: { value: "team/tools" } });
    expect(document.getElementById("knowledge-repo-save-status")?.textContent).toBe("저장하지 않은 저장소 변경 사항이 있습니다.");

    view.rerender(<SettingsKnowledgeTab active={false} />);
    expect(view.container.innerHTML).toBe("");
    view.rerender(<SettingsKnowledgeTab active={true} />);

    expect(field("저장소 주소").value).toBe("me/brain");
    expect(field("플러그인 저장소").value).toBe("team/tools");
  });

  it("shows the empty state's running text with its spaces", () => {
    render(<SettingsKnowledgeTab active={true} />);
    expect(document.querySelector(".empty-note")?.textContent).toBe(
      "지식 저장소를 연결하면 아바타가 그 저장소의 지식·스킬을 사용하고, 대화로 직접 관리할 수 있어요. 아바타에게 저장소 만들기 요청",
    );
    expect(document.getElementById("knowledge-repo-save-status")?.textContent).toBe("연결 전");
    expect(document.querySelector(".knowledge-repo-form button")?.textContent).toBe("연결");
  });

  it("connects a repo in place and keeps the plugin form's unsaved text", async () => {
    answer = (call) =>
      call.method === "PUT" && call.url.endsWith("/api/me/knowledge-repo")
        ? { user: userOf({ knowledgeRepo: "me/brain", knowledgeBranch: "main" }) }
        : undefined;
    render(<SettingsKnowledgeTab active={true} />);
    fireEvent.change(field("플러그인 저장소"), { target: { value: "team/tools" } });
    fireEvent.change(field("저장소 주소"), { target: { value: "  me/brain " } });
    fireEvent.change(field("브랜치 (선택)"), { target: { value: "main" } });

    await submit(field("저장소 주소"));

    await waitFor(() => expect(readState().user?.knowledgeRepo).toBe("me/brain"));
    expect(calls.map((call) => call.body)).toEqual([{ repo: "me/brain", branch: "main" }]);
    await waitFor(() => expect(document.getElementById("knowledge-repo-save-status")?.textContent).toBe("연결됨"));
    // The form now shows what the server saved; the other card kept its text.
    expect(field("저장소 주소").value).toBe("me/brain");
    expect(field("플러그인 저장소").value).toBe("team/tools");
    expect(document.querySelector(".kr-link a")?.textContent).toBe("me/brain @ main");
    expect(document.querySelector(".kr-link a")?.getAttribute("href")).toBe("https://github.com/me/brain");
    expect(document.querySelector(".git-token-status")?.textContent).toBe(
      "GIT_TOKEN이 없어 읽기만 가능해요. 권한·연결 탭의 Git 자격증명 에서 사내 Git 토큰을 설정하면 아바타가 커밋·푸시할 수 있어요.",
    );
    expect(document.querySelector(".knowledge-repo-form button")?.textContent).toBe("저장");
  });

  it("refuses an emptied address instead of disconnecting", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "me/brain" }) });
    render(<SettingsKnowledgeTab active={true} />);
    fireEvent.change(field("저장소 주소"), { target: { value: " " } });
    expect(document.getElementById("knowledge-repo-save-status")?.textContent).toBe("연결 해제는 오른쪽의 ‘연결 해제’ 버튼을 사용합니다.");

    await submit(field("저장소 주소"));

    expect(calls).toEqual([]);
    expect(document.getElementById("knowledge-repo-save-status")?.textContent).toBe("저장 실패: 연결 해제는 오른쪽의 ‘연결 해제’ 버튼을 사용해 주세요.");
    expect(field("저장소 주소").getAttribute("aria-invalid")).toBe("true");
  });

  it("loads the repo's plugins on first open, scrolls once they are rendered, and saves the selection in place", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "me/brain" }) });
    const contents = deferred<unknown>();
    answer = (call) => {
      if (call.url.endsWith("/api/me/knowledge-repo/contents")) return contents.promise;
      if (call.url.endsWith("/api/me/knowledge-repo/selected")) return { user: userOf({ knowledgeRepo: "me/brain", knowledgeSelected: ["alpha"] }) };
      return undefined;
    };
    render(<SettingsKnowledgeTab active={true} />);
    fireEvent.change(field("플러그인 저장소"), { target: { value: "team/tools" } });
    const toggle = screen.getByRole("button", { name: "사용할 플러그인 선택" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await click(toggle);

    const panel = document.getElementById("knowledge-repo-plugin-contents")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel.getAttribute("aria-busy")).toBe("true");
    expect(panel.textContent).toBe("불러오는 중…");
    expect(scrolled).toEqual([]);

    await act(async () => contents.resolve({ contents: MARKET }));

    // Scrolled only after the list it centres on was in the DOM.
    await waitFor(() => expect(scrolled).toEqual([{ id: "knowledge-repo-plugin-contents", block: "center", checkboxes: 3, focusedInside: false }]));
    expect(panel.getAttribute("aria-busy")).toBe("false");
    expect(document.querySelector(".kr-plugins .muted")?.textContent).toBe("저장소의 모든 플러그인을 사용 중");

    fireEvent.click(within(panel).getByRole("checkbox", { name: "beta" }));
    await click(within(panel).getByRole("button", { name: "선택 저장" }));

    await waitFor(() => expect(readState().user?.knowledgeSelected).toEqual(["alpha"]));
    expect(calls.at(-1)).toEqual({ url: "/api/me/knowledge-repo/selected", method: "PUT", body: { selected: ["alpha"] } });
    expect(document.querySelector(".kr-plugins .muted")?.textContent).toBe("1개 플러그인만 사용 중");
    // The picker stayed open on the saved selection; the other card kept its text.
    expect(boxes().map(([, checked]) => checked)).toEqual([true, false, false]);
    expect(field("플러그인 저장소").value).toBe("team/tools");

    // Closing and re-opening reuses the listing: no second request.
    await click(toggle);
    expect(document.getElementById("knowledge-repo-plugin-contents")).toBeNull();
    await click(toggle);
    await waitFor(() => expect(scrolled.length).toBe(2));
    expect(calls.filter((call) => call.url.endsWith("/contents")).length).toBe(1);
  });

  it("loads another account's repo into the form and closes the picker", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "me/brain" }) });
    answer = (call) => (call.url.endsWith("/contents") ? { contents: MARKET } : undefined);
    render(<SettingsKnowledgeTab active={true} />);
    fireEvent.change(field("브랜치 (선택)"), { target: { value: "typing" } });
    await click(screen.getByRole("button", { name: "사용할 플러그인 선택" }));
    await waitFor(() => expect(boxes().length).toBe(3));

    await act(async () => replaceState({ user: userOf({ id: "other", username: "other", knowledgeRepo: "other/notes", knowledgeBranch: "dev" }) }));

    expect(field("저장소 주소").value).toBe("other/notes");
    expect(field("브랜치 (선택)").value).toBe("dev");
    expect(document.getElementById("knowledge-repo-plugin-contents")).toBeNull();
    expect(screen.getByRole("button", { name: "사용할 플러그인 선택" }).getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("knowledge-repo-save-status")?.textContent).toBe("연결됨");
  });

  it("shows a listing failure with its details and retries", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "me/brain" }) });
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (fail) return { ok: false, status: 502, json: async () => ({ error: "Command failed: git clone https://x" }) } as unknown as Response;
        return ok({ contents: MARKET });
      }),
    );
    render(<SettingsKnowledgeTab active={true} />);

    await click(screen.getByRole("button", { name: "사용할 플러그인 선택" }));

    const note = await waitFor(() => document.querySelector<HTMLElement>("#knowledge-repo-plugin-contents .error-note")!);
    await waitFor(() => expect(note.isConnected).toBe(true));
    const message = note.querySelector("code")?.textContent || "";
    expect(note.textContent).toBe(`조회 실패: 저장소 내용을 가져오지 못했습니다. 오류 상세 ${message} 다시 시도`);

    fail = false;
    await click(within(note).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(boxes().length).toBe(3));
  });

  it("adds a plugin in place, clears only its own form, and lists the row", async () => {
    const added = pluginOf({ id: "p2", repo: "team/tools", ref: "v1", label: "도구" });
    answer = (call) => (call.method === "POST" && call.url.endsWith("/api/me/plugins") ? { plugin: added } : undefined);
    render(<SettingsKnowledgeTab active={true} />);
    expect(document.querySelector(".plugin-rows")?.textContent).toBe("추가한 플러그인이 없습니다.");
    expect(document.getElementById("plugin-add-save-status")?.textContent).toBe("추가할 플러그인 저장소를 입력하세요.");
    fireEvent.change(field("저장소 주소"), { target: { value: "me/brain" } });
    fireEvent.change(field("플러그인 저장소"), { target: { value: " team/tools " } });
    fireEvent.change(field("브랜치/태그 (선택)"), { target: { value: "v1" } });
    fireEvent.change(field("라벨 (선택)"), { target: { value: "도구" } });
    expect(document.getElementById("plugin-add-save-status")?.className).toBe("settings-save-status dirty");

    await submit(field("플러그인 저장소"));

    await waitFor(() => expect(readState().plugins).toEqual([added]));
    expect(calls.map((call) => call.body)).toEqual([{ repo: "team/tools", ref: "v1", label: "도구" }]);
    await waitFor(() => expect(field("플러그인 저장소").value).toBe(""));
    expect(field("브랜치/태그 (선택)").value).toBe("");
    expect(field("라벨 (선택)").value).toBe("");
    expect(field("저장소 주소").value).toBe("me/brain");
    expect(document.querySelector(".plugin-row .pr-main")?.textContent).toBe("도구 team/tools @ v1 아직 동기화되지 않음 · 모든 플러그인 사용");
    expect(screen.getByRole("switch", { name: "플러그인 사용: 도구" }).getAttribute("aria-checked")).toBe("true");
  });

  it("opens the branch editor with the row's ref, focuses it once it is rendered, and closes the plugin picker", async () => {
    replaceState({ plugins: [pluginOf({ id: "a/b c", ref: "v1" }), pluginOf({ id: "p2", repo: "team/other" })] });
    answer = (call) => (call.url.endsWith("/contents") ? { contents: MARKET } : undefined);
    render(<SettingsKnowledgeTab active={true} />);
    const [pick] = screen.getAllByRole("button", { name: "저장소 내 플러그인 선택" });
    const edit = screen.getByRole("button", { name: "브랜치/태그 변경: team/tools" });
    expect(pick.getAttribute("aria-controls")).toBe("plugin-contents-a-b-c");
    expect(edit.getAttribute("aria-controls")).toBe("plugin-ref-edit-a-b-c");

    await click(pick);
    await waitFor(() => expect(scrolled).toEqual([{ id: "plugin-contents-a-b-c", block: "center", checkboxes: 3, focusedInside: false }]));
    expect(calls.map((call) => call.url)).toEqual(["/api/me/plugins/a%2Fb%20c/contents"]);
    expect(pick.getAttribute("aria-expanded")).toBe("true");

    await click(edit);

    const draft = (await screen.findByRole("textbox", { name: "브랜치/태그: team/tools" })) as HTMLInputElement;
    expect(draft.value).toBe("v1");
    await waitFor(() => expect(document.activeElement).toBe(draft));
    expect(scrolled.at(-1)).toEqual({ id: "plugin-ref-edit-a-b-c", block: "nearest", checkboxes: 0, focusedInside: false });
    // One panel per row at a time.
    expect(document.getElementById("plugin-contents-a-b-c")).toBeNull();
    expect(pick.getAttribute("aria-expanded")).toBe("false");
    expect(edit.getAttribute("aria-expanded")).toBe("true");

    // The same button closes it again.
    await click(edit);
    expect(document.getElementById("plugin-ref-edit-a-b-c")).toBeNull();
  });

  it("switches a plugin's ref in place: saved, re-synced, editor closed", async () => {
    replaceState({ plugins: [pluginOf({ ref: "v1" })] });
    answer = (call) => {
      if (call.method === "PATCH") return { plugin: pluginOf({ ref: "v2" }) };
      if (call.url.endsWith("/refresh")) return { plugin: pluginOf({ ref: "v2", lastSyncedAt: "2026-11-12T00:00:00.000Z" }) };
      return undefined;
    };
    render(<SettingsKnowledgeTab active={true} />);
    fireEvent.change(field("플러그인 저장소"), { target: { value: "typing" } });
    await click(screen.getByRole("button", { name: "브랜치/태그 변경: team/tools" }));
    const draft = await screen.findByRole("textbox", { name: "브랜치/태그: team/tools" });
    fireEvent.change(draft, { target: { value: " v2 " } });

    await submit(draft);

    await waitFor(() => expect(readState().plugins[0].lastSyncedAt).toBe("2026-11-12T00:00:00.000Z"));
    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ["PATCH", "/api/me/plugins/p1", { ref: "v2" }],
      ["POST", "/api/me/plugins/p1/refresh", undefined],
    ]);
    await waitFor(() => expect(document.getElementById("plugin-ref-edit-p1")).toBeNull());
    expect(document.querySelector(".pr-sub")?.textContent).toBe("team/tools @ v2");
    await waitFor(() => expect(document.querySelector(".plugin-row")?.className).toBe("plugin-row"));
    expect(field("플러그인 저장소").value).toBe("typing");
    expect(get(toasts).at(-1)?.message).toBe('"team/tools" 플러그인을 "v2" 브랜치/태그로 전환했습니다.');
  });

  it("keeps a plugin's switch where it was when the change is refused", async () => {
    replaceState({ plugins: [pluginOf()] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response),
    );
    render(<SettingsKnowledgeTab active={true} />);
    const toggle = screen.getByRole("switch", { name: "플러그인 사용: team/tools" });

    await click(toggle);

    await waitFor(() => expect(toggle.getAttribute("aria-busy")).toBe("false"));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(readState().plugins[0].enabled).toBe(true);
    expect(get(toasts).at(-1)?.message).toContain("변경 실패: ");
  });

  it("opens the graph modal on demand and closes it through onClose", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "me/brain", gitTokenSet: true }) });
    render(<SettingsKnowledgeTab active={true} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".git-token-status")?.textContent).toBe("● GIT_TOKEN 연결됨 · 아바타가 커밋·푸시할 수 있어요");

    await click(screen.getByRole("button", { name: "그래프 보기" }));
    expect(screen.getByRole("dialog", { name: "지식 그래프" })).toBeTruthy();

    await click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sends the Git credential link to the 권한·연결 tab", async () => {
    replaceState({ user: userOf({ knowledgeRepo: "me/brain" }) });
    render(<SettingsKnowledgeTab active={true} />);

    await click(screen.getByRole("button", { name: "권한·연결 탭의 Git 자격증명" }));

    expect(readState().settingsTab).toBe("access");
  });
});
