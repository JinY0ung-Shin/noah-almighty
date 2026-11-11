// 설정 ▸ 프로필 (SettingsProfileTab) and the hashtag chip editor it embeds.
//
// The first block is the SettingsProfileTab half of
// tests/svelte-onboarding-tours.test.ts (the settings card that re-opens the
// welcome modal). The rest pins what a port is most likely to break: the tab is
// ALWAYS MOUNTED and gates only its markup on `active`, every card saves in
// place without wiping the text typed into the others, a late answer is merged
// into the form as it is THEN, and the chip editor's keyboard handling.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import HashtagChipEditor from "../src/client/src/components/HashtagChipEditor";
import SettingsProfileTab from "../src/client/src/components/SettingsProfileTab";
import { readState, replaceState, toasts } from "../src/client/src/lib/state";
import { get } from "../src/client/src/lib/store";
import type { User } from "../src/client/src/lib/types";

// jsdom decodes no images; the resize itself is lib/dom's business.
vi.mock("../src/client/src/lib/dom", async (original) => ({
  ...(await original<typeof import("../src/client/src/lib/dom")>()),
  downscaleImageToDataUrl: vi.fn(async () => "data:image/png;base64,AAAA"),
}));

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Every request fetch() was asked for. */
let calls: Call[] = [];
/** Per-test answers, tried before the defaults: return undefined to pass. */
let answer: (call: Call) => unknown | Promise<unknown> | undefined = () => undefined;

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
    sharedAccount: false,
    roles: [],
    secretNames: [],
    browserSecrets: [],
    knowledgeRepo: "",
    gitTokenSet: false,
    sshPublicKey: "",
    onboardedAt: "2026-08-01T00:00:00.000Z",
    allowedMcpToolGroups: null,
    mcpToolGroupsDefault: null,
    ...over,
  } as unknown as User;
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const click = (element: Element): Promise<void> => act(async () => void fireEvent.click(element));

const field = (label: string): HTMLInputElement | HTMLTextAreaElement =>
  screen.getByText(label).closest("label")!.querySelector("input, textarea")!;

const chipTexts = (): string[] => [...document.querySelectorAll(".hashtag-chip > span")].map((el) => el.textContent || "");

beforeEach(() => {
  calls = [];
  answer = () => undefined;
  toasts.set([]);
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
      if (call.url.endsWith("/api/me")) return ok({ user: readState().user });
      return ok({});
    }),
  );
  replaceState({
    user: userOf(),
    chatPanes: [],
    activePaneId: null,
    conversations: [],
    view: "explore",
    settingsTab: "profile",
    onboardingRequested: false,
  });
});

afterEach(() => {
  toasts.set([]);
  vi.unstubAllGlobals();
});

describe("onboarding re-open", () => {
  it("arms the one-shot flag from the 시작 안내 settings card", async () => {
    const { getByRole } = render(<SettingsProfileTab active={true} />);

    expect(readState().onboardingRequested).toBe(false);
    fireEvent.click(getByRole("button", { name: "온보딩 안내 다시 보기" }));

    // No navigation — the modal is a global overlay App owns.
    expect(readState().onboardingRequested).toBe(true);
    expect(readState().view).toBe("explore");
  });
});

describe("SettingsProfileTab — always mounted, saved in place", () => {
  it("renders nothing while inactive and keeps unsaved text across a tab switch", () => {
    const view = render(<SettingsProfileTab active={false} />);
    expect(view.container.innerHTML).toBe("");

    view.rerender(<SettingsProfileTab active={true} />);
    fireEvent.change(field("아바타 이름"), { target: { value: "세바스찬" } });
    fireEvent.change(field("페르소나 (행동 지침)"), { target: { value: "차분하게" } });

    // Another tab: the markup goes, the component (and its form state) stays.
    view.rerender(<SettingsProfileTab active={false} />);
    expect(view.container.innerHTML).toBe("");
    view.rerender(<SettingsProfileTab active={true} />);

    expect(field("아바타 이름").value).toBe("세바스찬");
    expect(field("페르소나 (행동 지침)").value).toBe("차분하게");
    expect(document.getElementById("settings-profile-save-status")?.textContent).toBe("저장하지 않은 변경 사항이 있습니다.");
  });

  it("initialises the form once: a later store update does not overwrite what was typed", async () => {
    render(<SettingsProfileTab active={true} />);
    fireEvent.change(field("내 이름"), { target: { value: "새 이름" } });

    // Same account, refreshed from the server (refreshMe after an avatar upload).
    await act(async () => replaceState({ user: userOf({ displayName: "서버 이름", hasImage: true }) }));

    expect(field("내 이름").value).toBe("새 이름");
    // The header shows the saved name; the delete button arrives with the image.
    expect(document.querySelector(".settings-id h3")?.textContent).toBe("서버 이름");
    expect(screen.getByRole("button", { name: "사진 삭제" })).toBeTruthy();
  });

  it("loads another account's profile into the form, but only once nothing is in flight", async () => {
    const generated = deferred<unknown>();
    answer = (call) => (call.url.endsWith("/api/me/intro/generate") ? generated.promise : undefined);
    render(<SettingsProfileTab active={true} />);
    fireEvent.change(field("내 이름"), { target: { value: "타이핑" } });
    await click(screen.getAllByRole("button", { name: "아바타가 자동 생성" })[0]);
    const other = userOf({ id: "other", username: "other", displayName: "다른 사람", hashtags: ["x"], visibility: "private", sharedAccount: true });

    await act(async () => replaceState({ user: other }));

    // The header follows the store at once; the form waits for the request.
    expect(document.querySelector(".settings-id h3")?.textContent).toBe("다른 사람");
    expect(field("내 이름").value).toBe("타이핑");

    await act(async () => generated.resolve({ intro: "" }));

    await waitFor(() => expect(field("내 이름").value).toBe("다른 사람"));
    expect(chipTexts()).toEqual(["#x"]);
    expect(screen.getByRole("radio", { name: "비공개" }).getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(document.getElementById("settings-profile-save-status")?.textContent).toBe("저장됨");
    // The previous account's generation message went with it.
    expect(document.getElementById("settings-profile-generation-status")).toBeNull();
  });

  it("saves the visibility in place and keeps the unsaved text in the profile fields", async () => {
    answer = (call) => (call.method === "PATCH" ? { user: userOf({ visibility: "private" }) } : undefined);
    render(<SettingsProfileTab active={true} />);
    fireEvent.change(field("소개 (한 줄)"), { target: { value: "아직 저장 안 함" } });

    await click(screen.getByRole("radio", { name: "비공개" }));

    await waitFor(() => expect(readState().user?.visibility).toBe("private"));
    expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([{ visibility: "private" }]);
    expect(screen.getByRole("radio", { name: "비공개" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "팀 공개" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: "비공개" }).tabIndex).toBe(0);
    await waitFor(() => expect(screen.getByRole("radiogroup").getAttribute("aria-busy")).toBe("false"));
    // The other card's text survived the save.
    expect(field("소개 (한 줄)").value).toBe("아직 저장 안 함");
    expect(document.getElementById("settings-profile-save-status")?.textContent).toBe("저장하지 않은 변경 사항이 있습니다.");
  });

  it("rolls the visibility back when the save fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response),
    );
    render(<SettingsProfileTab active={true} />);

    await click(screen.getByRole("radio", { name: "비공개" }));

    await waitFor(() => expect(screen.getByRole("radio", { name: "팀 공개" }).getAttribute("aria-checked")).toBe("true"));
    expect(readState().user?.visibility).toBe("group");
    expect(get(toasts).at(-1)?.message).toContain("공개 범위 변경 실패");
  });

  it("saves the shared-account switch in place, without touching the profile form", async () => {
    answer = (call) => (call.method === "PATCH" ? { user: userOf({ sharedAccount: true }) } : undefined);
    render(<SettingsProfileTab active={true} />);
    fireEvent.change(field("내 이름"), { target: { value: "바뀐 이름" } });
    const box = screen.getByRole("checkbox") as HTMLInputElement;

    await click(box);

    await waitFor(() => expect(readState().user?.sharedAccount).toBe(true));
    expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([{ sharedAccount: true }]);
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(true);
    expect(field("내 이름").value).toBe("바뀐 이름");
  });

  it("sends the form as typed and settles on 저장됨", async () => {
    answer = (call) => (call.method === "PATCH" ? { user: userOf(call.body as Partial<User>) } : undefined);
    render(<SettingsProfileTab active={true} />);
    const save = screen.getByRole("button", { name: "프로필 저장" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(document.getElementById("settings-profile-save-status")?.textContent).toBe("저장됨");

    fireEvent.change(field("내 이름"), { target: { value: "김노아" } });
    fireEvent.change(field("아바타 이름"), { target: { value: "노아" } });
    const tagInput = screen.getByRole("textbox", { name: "역량 해시태그 추가" });
    fireEvent.change(tagInput, { target: { value: "#설계" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(save.disabled).toBe(false);

    await act(async () => void fireEvent.submit(save.closest("form")!));

    await waitFor(() => expect(readState().user?.displayName).toBe("김노아"));
    expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
      { displayName: "김노아", alias: "노아", bio: "", intro: "", persona: "", hashtags: ["설계"] },
    ]);
    await waitFor(() => expect(document.getElementById("settings-profile-save-status")?.textContent).toBe("저장됨"));
    expect((screen.getByRole("button", { name: "프로필 저장" }) as HTMLButtonElement).disabled).toBe(true);
    expect(field("내 이름").value).toBe("김노아");
    expect(chipTexts()).toEqual(["#설계"]);
    expect(get(toasts).at(-1)?.message).toBe("프로필을 저장했습니다.");
  });

  it("keeps the typed text and says why when the profile save fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response),
    );
    render(<SettingsProfileTab active={true} />);
    fireEvent.change(field("내 이름"), { target: { value: "김노아" } });

    await act(async () => void fireEvent.submit(field("내 이름").closest("form")!));

    const status = document.getElementById("settings-profile-save-status")!;
    await waitFor(() => expect(status.textContent).toContain("저장 실패: "));
    expect(status.className).toBe("settings-save-status invalid");
    expect(field("내 이름").value).toBe("김노아");
    // Typing again clears the error and the form is simply dirty.
    fireEvent.change(field("내 이름"), { target: { value: "김노아2" } });
    expect(status.textContent).toBe("저장하지 않은 변경 사항이 있습니다.");
    expect(status.className).toBe("settings-save-status dirty");
  });

  it("merges 더 추가 into the chips as they are when the answer arrives", async () => {
    replaceState({ user: userOf({ hashtags: ["설계"] }) });
    const generated = deferred<unknown>();
    answer = (call) => (call.url.endsWith("/api/me/hashtags/generate") ? generated.promise : undefined);
    render(<SettingsProfileTab active={true} />);

    await click(screen.getByRole("button", { name: "더 추가" }));
    expect(calls.at(-1)?.body).toEqual({ existing: ["설계"] });
    expect(screen.getByRole("button", { name: "추가 중…" })).toBeTruthy();
    expect(document.getElementById("settings-profile-generation-status")?.textContent).toBe("자동 생성 중입니다.");

    // A chip added by hand while the request is out.
    const tagInput = screen.getByRole("textbox", { name: "역량 해시태그 추가" });
    fireEvent.change(tagInput, { target: { value: "리뷰" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(chipTexts()).toEqual(["#설계", "#리뷰"]);

    await act(async () => generated.resolve({ hashtags: ["배포", "설계"] }));

    await waitFor(() => expect(chipTexts()).toEqual(["#설계", "#리뷰", "#배포"]));
    expect(document.getElementById("settings-profile-generation-status")?.textContent).toBe("해시태그 1개를 추가했습니다.");
    // A draft only: nothing was saved.
    expect(readState().user?.hashtags).toEqual(["설계"]);
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("fills the intro draft without saving it", async () => {
    answer = (call) => (call.url.endsWith("/api/me/intro/generate") ? { intro: "안녕하세요, 노아입니다." } : undefined);
    render(<SettingsProfileTab active={true} />);
    fireEvent.change(field("내 이름"), { target: { value: "타이핑 중" } });

    await click(screen.getAllByRole("button", { name: "아바타가 자동 생성" })[0]);

    const intro = document.querySelector<HTMLTextAreaElement>(".settings-form textarea")!;
    await waitFor(() => expect(intro.value).toBe("안녕하세요, 노아입니다."));
    const status = document.getElementById("settings-profile-generation-status")!;
    expect(status.textContent).toBe("자기소개 초안이 채워졌습니다.");
    expect(status.className).toBe("settings-save-status success");
    expect(field("내 이름").value).toBe("타이핑 중");
    expect(readState().user?.intro).toBe("");
  });

  it("takes a pasted image as the avatar photo only while the tab is showing", async () => {
    const paste = (): Event => {
      const event = new Event("paste", { bubbles: true, cancelable: true });
      const file = new File(["x"], "shot.png", { type: "image/png" });
      Object.defineProperty(event, "clipboardData", { value: { items: [], files: [file], getData: () => "" } });
      return event;
    };
    const view = render(<SettingsProfileTab active={false} />);

    const ignored = paste();
    await act(async () => void window.dispatchEvent(ignored));
    expect(ignored.defaultPrevented).toBe(false);
    expect(calls).toEqual([]);

    view.rerender(<SettingsProfileTab active={true} />);
    const taken = paste();
    await act(async () => void window.dispatchEvent(taken));

    expect(taken.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(["PUT /api/me/avatar-image", "GET /api/me"]),
    );
    expect(calls[0].body).toEqual({ image: "data:image/png;base64,AAAA" });
    await waitFor(() => expect(document.querySelector(".pic-paste-hint")?.textContent).toBe("복사한 이미지를 Ctrl+V로 붙여넣어도 돼요"));
  });

  it("moves the visibility choice with the arrow keys", async () => {
    answer = (call) => (call.method === "PATCH" ? { user: userOf({ visibility: (call.body as { visibility: User["visibility"] }).visibility }) } : undefined);
    render(<SettingsProfileTab active={true} />);

    await act(async () => void fireEvent.keyDown(screen.getByRole("radio", { name: "팀 공개" }), { key: "ArrowRight" }));

    await waitFor(() => expect(readState().user?.visibility).toBe("private"));
    expect(screen.getByRole("radio", { name: "비공개" }).getAttribute("aria-checked")).toBe("true");
  });

  it("puts the component's scope class on each card", () => {
    const { container } = render(<SettingsProfileTab active={true} />);
    const cards = [...container.children];
    expect(cards.length).toBe(4);
    for (const card of cards) expect(card.className).toBe("settings-card cmp-settings-profile-tab");
  });
});

describe("HashtagChipEditor", () => {
  function Harness({ initial = [], disabled = false, seen }: { initial?: string[]; disabled?: boolean; seen?: (tags: string[]) => void }) {
    const [tags, setTags] = useState(initial);
    return (
      <HashtagChipEditor
        tags={tags}
        disabled={disabled}
        onTagsChange={(next) => {
          seen?.(next);
          setTags(next);
        }}
      />
    );
  }

  const input = (): HTMLInputElement => screen.getByRole("textbox", { name: "역량 해시태그 추가" }) as HTMLInputElement;
  const type = (value: string): void => void fireEvent.change(input(), { target: { value } });

  it("adds on Enter, comma and space, and clears the input", () => {
    const seen = vi.fn();
    render(<Harness seen={seen} />);

    type("설계");
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(false);
    expect(chipTexts()).toEqual(["#설계"]);
    expect(input().value).toBe("");

    type("리뷰");
    expect(fireEvent.keyDown(input(), { key: "," })).toBe(false);
    type("배포");
    expect(fireEvent.keyDown(input(), { key: " " })).toBe(false);
    expect(chipTexts()).toEqual(["#설계", "#리뷰", "#배포"]);
    expect(seen.mock.calls.map(([tags]) => tags)).toEqual([["설계"], ["설계", "리뷰"], ["설계", "리뷰", "배포"]]);

    // A space in an EMPTY input is just a space.
    expect(fireEvent.keyDown(input(), { key: " " })).toBe(true);
    expect(chipTexts().length).toBe(3);
    expect(screen.getByRole("status").textContent).toBe("3개 해시태그가 선택되었습니다. Enter, 쉼표, 공백으로 추가할 수 있습니다.");
  });

  it("splits pasted text on the server's separators and drops duplicates", () => {
    render(<Harness initial={["설계"]} />);

    type("#리뷰，배포、설계 운영");
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(chipTexts()).toEqual(["#설계", "#리뷰", "#배포", "#운영"]);
  });

  it("removes the last chip on Backspace in an empty input only", () => {
    render(<Harness initial={["a", "b"]} />);

    type("x");
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(chipTexts()).toEqual(["#a", "#b"]);

    type("");
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(chipTexts()).toEqual(["#a"]);
    fireEvent.keyDown(input(), { key: "Backspace" });
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(chipTexts()).toEqual([]);
    expect(screen.getByRole("status").textContent).toBe("선택된 해시태그가 없습니다. Enter, 쉼표, 공백으로 추가할 수 있습니다.");
  });

  it("removes a chip by its × button", () => {
    render(<Harness initial={["a", "b", "c"]} />);

    fireEvent.click(screen.getByRole("button", { name: "b 제거" }));

    expect(chipTexts()).toEqual(["#a", "#c"]);
  });

  it("adds what was typed when the input loses focus", () => {
    render(<Harness />);

    type("  ");
    fireEvent.blur(input());
    expect(chipTexts()).toEqual([]);

    type("설계");
    fireEvent.blur(input());
    expect(chipTexts()).toEqual(["#설계"]);
    expect(input().value).toBe("");
  });

  it("says so when the input added nothing or was cut", () => {
    render(<Harness initial={Array.from({ length: 12 }, (_, i) => `t${i}`)} />);

    type("열셋째");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(chipTexts().length).toBe(12);
    expect(get(toasts).at(-1)?.message).toBe("해시태그는 최대 12개까지만 추가할 수 있어 더 추가되지 않았습니다.");

    fireEvent.keyDown(input(), { key: "Backspace" });
    type("가".repeat(31));
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(chipTexts().at(-1)).toBe(`#${"가".repeat(30)}`);
    expect(get(toasts).at(-1)?.message).toBe("해시태그는 최대 30자까지만 사용할 수 있어 일부가 잘렸습니다.");
  });

  it("changes nothing while disabled", () => {
    const seen = vi.fn();
    render(<Harness initial={["a"]} disabled={true} seen={seen} />);

    expect(screen.getByRole("group", { name: "역량 해시태그 편집" }).getAttribute("aria-disabled")).toBe("true");
    expect(input().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "a 제거" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input(), { key: "Backspace" });
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(chipTexts()).toEqual(["#a"]);
    expect(seen).not.toHaveBeenCalled();
  });

  it("follows a new tags prop, and works without a parent holding the list", () => {
    const view = render(<HashtagChipEditor tags={["a"]} />);
    expect(chipTexts()).toEqual(["#a"]);

    // No onTagsChange: the editor keeps the list itself.
    type("b");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(chipTexts()).toEqual(["#a", "#b"]);

    view.rerender(<HashtagChipEditor tags={["x", "y"]} />);
    expect(chipTexts()).toEqual(["#x", "#y"]);
  });

  it("focuses the input on a click in the editor's empty area, not on a chip", () => {
    render(<Harness initial={["a"]} />);
    const editor = screen.getByRole("group", { name: "역량 해시태그 편집" });
    expect(editor.className).toBe("hashtag-editor cmp-hashtag-chip-editor");

    fireEvent.click(within(editor).getByText("#a"));
    expect(document.activeElement).not.toBe(input());

    fireEvent.click(editor);
    expect(document.activeElement).toBe(input());
  });
});
