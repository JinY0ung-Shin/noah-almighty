import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AvatarCapabilitiesModal from "../src/client/src/components/AvatarCapabilitiesModal.svelte";
import type { AvatarDetail, AvatarSummary, SkillInfo } from "../src/client/src/lib/types.js";

/** What the 탐색 card hands the dialog (no intro/plugins — those need the detail call). */
const avatar = {
  id: "avatar-1",
  username: "mate",
  displayName: "메이트",
  alias: "메이",
  bio: "한 줄 소개",
  hashtags: ["코드리뷰"],
  hasImage: false,
  pluginCount: 1,
  visibility: "group",
  updatedAt: null,
} satisfies AvatarSummary;

const detail = {
  ...avatar,
  persona: "",
  intro: "제가 할 수 있는 일을 소개합니다.",
  isOwn: false,
  elevated: false,
  plugins: [{ repo: "acme/tools", label: "사내 도구" }],
} satisfies AvatarDetail;

const skills: SkillInfo[] = [
  { name: "release", description: "릴리즈를 준비합니다.", source: "default" },
  { name: "deck", description: "", source: "acme/tools" },
];

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function fail(status: number, error: string): Response {
  return { ok: false, status, json: async () => ({ error }) } as unknown as Response;
}

/**
 * The skills URL starts with the detail URL, so the suffix decides — a prefix
 * match would answer both requests with the detail payload.
 */
function mockFetch(handlers: { detail: () => Response; skills: () => Response }) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/skills")) return handlers.skills();
    if (url.includes("/api/avatars/")) return handlers.detail();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AvatarCapabilitiesModal", () => {
  it("renders the intro, hashtags, plugins and skills from the two parallel fetches", async () => {
    const fetchMock = mockFetch({ detail: () => ok({ avatar: detail }), skills: () => ok({ skills }) });
    render(AvatarCapabilitiesModal, { props: { avatar } });

    // The card data names the avatar before either request lands.
    expect(screen.getByText("메이트 아바타가 사용할 수 있는 도구")).toBeTruthy();

    await waitFor(() => expect(screen.getByText("제가 할 수 있는 일을 소개합니다.")).toBeTruthy());
    expect(screen.getByText("#코드리뷰")).toBeTruthy();
    expect(screen.getByText("사내 도구")).toBeTruthy();
    expect(screen.getByText("release")).toBeTruthy();
    // "acme/tools" shows twice: the plugin row's repo, and the source badge on the
    // skill that came from it (a bundled skill carries no badge).
    expect(screen.getAllByText("acme/tools").length).toBe(2);
    // Both endpoints hit exactly once, neither waiting on the other.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("toggles a skill's description on click, and leaves a description-less skill inert", async () => {
    mockFetch({ detail: () => ok({ avatar: detail }), skills: () => ok({ skills }) });
    const { container } = render(AvatarCapabilitiesModal, { props: { avatar } });

    await waitFor(() => expect(screen.getByRole("button", { name: /release/ })).toBeTruthy());
    const head = screen.getByRole("button", { name: /release/ });
    const row = container.querySelector<HTMLElement>(".ai-skill")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(row.classList.contains("open")).toBe(false);

    await fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(row.classList.contains("open")).toBe(true);
    expect(screen.getByText("릴리즈를 준비합니다.")).toBeTruthy();

    await fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(row.classList.contains("open")).toBe(false);

    // "deck" carries no description, so there is nothing to expand.
    const inert = screen.getByRole("button", { name: /deck/ }) as HTMLButtonElement;
    expect(inert.disabled).toBe(true);
    expect(inert.getAttribute("aria-expanded")).toBeNull();
  });

  it("offers a retry on a failed skills fetch and shows the skills once it succeeds", async () => {
    let skillCalls = 0;
    const fetchMock = mockFetch({
      detail: () => ok({ avatar: detail }),
      skills: () => (++skillCalls === 1 ? fail(500, "스킬을 불러오지 못했습니다.") : ok({ skills })),
    });
    render(AvatarCapabilitiesModal, { props: { avatar } });

    await waitFor(() => expect(screen.getByText("스킬을 불러오지 못했습니다.")).toBeTruthy());
    // The intro half of the dialog is unaffected by the skills failure.
    expect(screen.getByText("제가 할 수 있는 일을 소개합니다.")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.getByText("release")).toBeTruthy());
    expect(screen.queryByText("스킬을 불러오지 못했습니다.")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("offers a retry on a failed detail fetch while the skills list still renders", async () => {
    let detailCalls = 0;
    mockFetch({
      detail: () => (++detailCalls === 1 ? fail(500, "아바타 정보를 불러오지 못했습니다.") : ok({ avatar: detail })),
      skills: () => ok({ skills }),
    });
    render(AvatarCapabilitiesModal, { props: { avatar } });

    await waitFor(() => expect(screen.getByText("아바타 정보를 불러오지 못했습니다.")).toBeTruthy());
    expect(screen.getByText("release")).toBeTruthy();

    await fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.getByText("제가 할 수 있는 일을 소개합니다.")).toBeTruthy());
  });

  it("says so when the avatar has no skills or plugins", async () => {
    mockFetch({
      detail: () => ok({ avatar: { ...detail, intro: "", plugins: [] } }),
      skills: () => ok({ skills: [] }),
    });
    render(AvatarCapabilitiesModal, { props: { avatar } });

    await waitFor(() => expect(screen.getByText("사용 가능한 스킬이 없습니다.")).toBeTruthy());
    expect(screen.queryByText("플러그인")).toBeNull();
  });

  it("dispatches close from the 닫기 button", async () => {
    mockFetch({ detail: () => ok({ avatar: detail }), skills: () => ok({ skills: [] }) });
    const onClose = vi.fn();
    render(AvatarCapabilitiesModal, {
      props: { avatar },
      events: { close: onClose },
    });

    await waitFor(() => expect(screen.getByText("사용 가능한 스킬이 없습니다.")).toBeTruthy());

    await fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
