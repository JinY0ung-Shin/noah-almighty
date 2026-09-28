// The recipient side of a PPTX share link: the #/share/<token> viewer, its
// present mode, and the first-visit path through the login screen. Pinned:
//  - the four states come from the HTTP STATUS, not the message (404 = dead
//    link, anything else = retry) and a malformed token never reaches fetch;
//  - payload strings are the deck author's and render as TEXT, and only
//    /api/share/ URLs ever become an <img> or a download;
//  - present mode works without a keyboard (bar + tap zones), starts on the
//    clicked slide, keeps the first Space/Enter on the stage, and ends when the
//    browser leaves fullscreen (Esc there never reaches the page);
//  - a colleague arriving from a link is told why the login screen appeared,
//    and the welcome / what's-new modals wait until they leave the deck.
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import App from "../src/client/src/App.svelte";
import SlidePresenter from "../src/client/src/components/SlidePresenter.svelte";
import ShareView from "../src/client/src/views/ShareView.svelte";
import { goView } from "../src/client/src/lib/nav.js";
import { SHARE_TICKET_REFRESH_MS } from "../src/client/src/lib/shareLinks.js";
import { appState, readState, replaceState } from "../src/client/src/lib/state.js";
import { SHARE_LINK_GONE_MESSAGE } from "../src/shared/shareLinks.js";
import type { ShareViewPayload, ShareViewSlide, User } from "../src/client/src/lib/types.js";

const PRISTINE = structuredClone(readState());
const TOKEN = `${"Ab3_-".repeat(8)}xyz`;
const TOKEN_2 = `${"Zz9-_".repeat(8)}abc`;

function userOf(over: Partial<User> = {}): User {
  return {
    id: "viewer-1",
    username: "viewer",
    displayName: "동료",
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
    gitTokenSet: false,
    sshPublicKey: "",
    onboardedAt: "2026-08-01T00:00:00.000Z",
    lastSeenRelease: null,
    allowedMcpToolGroups: null,
    mcpToolGroupsDefault: null,
    groups: [],
    ...over,
  } as unknown as User;
}

function slidesOf(count: number, ticket = "tk"): ShareViewSlide[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    url: `/api/share/t/${ticket}/slides/${i + 1}`,
    alt: `슬라이드 ${i + 1} – 제목 ${i + 1}`,
  }));
}

function payload(over: Partial<ShareViewPayload> = {}): ShareViewPayload {
  return {
    fileName: "분기 보고.pptx",
    ownerName: "김민수",
    ownerUsername: "minsu",
    createdAt: new Date(2026, 9, 1, 9, 0).toISOString(),
    expiresAt: new Date(2026, 9, 8, 9, 5).toISOString(),
    slides: slidesOf(3),
    downloadUrl: "/api/share/t/tk/download",
    previewCapped: false,
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
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Routes {
  /** Answers POST /api/share/open (default: a 3-slide deck). */
  open?: (call: Call) => Response | Promise<Response>;
  me?: User | null;
  signupMode?: string;
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
      if (url === "/api/share/open") return (routes.open ?? (() => json(payload())))(call);
      if (url === "/api/bootstrap") {
        return json({ needsSetup: false, githubHost: "github.com", signupMode: routes.signupMode ?? "closed", confluenceConfigured: false });
      }
      if (url === "/api/me") return json({ user: routes.me ?? null });
      return json({ conversations: [], avatars: [], notifications: [], requests: [], messages: [], skills: [], plugins: [] });
    }),
  );
}

const opens = (): Call[] => calls.filter((call) => call.url === "/api/share/open");

function openViewer(token = TOKEN) {
  replaceState({ user: userOf(), view: "share", shareToken: token });
  return render(ShareView);
}

/* Fullscreen API stand-in (jsdom has none): requestFullscreen enters, the
   browser's own exit is simulated by leaveFullscreen(). */
let fullscreenElement: Element | null = null;

function installFullscreen(): { request: ReturnType<typeof vi.fn>; exit: ReturnType<typeof vi.fn> } {
  fullscreenElement = null;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  const request = vi.fn(function (this: Element) {
    fullscreenElement = this;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  const exit = vi.fn(() => {
    fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  });
  Object.defineProperty(HTMLElement.prototype, "requestFullscreen", { configurable: true, writable: true, value: request });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, writable: true, value: exit });
  return { request, exit };
}

function leaveFullscreen(): void {
  fullscreenElement = null;
  document.dispatchEvent(new Event("fullscreenchange"));
}

function uninstallFullscreen(): void {
  delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
  delete (document as { exitFullscreen?: unknown }).exitFullscreen;
  delete (document as { fullscreenElement?: unknown }).fullscreenElement;
  fullscreenElement = null;
}

beforeEach(() => {
  appState.set(structuredClone(PRISTINE));
  history.replaceState(null, "", "/");
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

afterEach(async () => {
  // Drain lazy view imports and fire-and-forget loads while fetch is still
  // stubbed; a promise settling after teardown fails the run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await vi.dynamicImportSettled();
  uninstallFullscreen();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* viewer states                                                       */
/* ------------------------------------------------------------------ */

describe("ShareView", () => {
  it("renders the deck: title, provenance, actions and a lazy slide list", async () => {
    stubFetch();
    const { container } = openViewer();
    // Loading first, under the generic title.
    expect(screen.getByText("공유 자료를 불러오는 중…")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("공유된 PPT");

    expect(await screen.findByRole("heading", { level: 1, name: "분기 보고.pptx" })).toBeTruthy();
    expect(screen.getByText("김민수 (@minsu)님이 공유 · 10월 8일 09:05까지")).toBeTruthy();
    expect(opens()).toEqual([{ url: "/api/share/open", method: "POST", body: { token: TOKEN } }]);

    const download = screen.getByRole("link", { name: "다운로드" });
    expect(download.getAttribute("href")).toBe("/api/share/t/tk/download");
    expect(download.getAttribute("download")).toBe("분기 보고.pptx");
    expect(screen.getByRole("button", { name: "발표 모드" })).toBeTruthy();

    const images = [...container.querySelectorAll<HTMLImageElement>(".share-slides img")];
    expect(images.map((img) => img.getAttribute("src"))).toEqual([
      "/api/share/t/tk/slides/1",
      "/api/share/t/tk/slides/2",
      "/api/share/t/tk/slides/3",
    ]);
    expect(images.every((img) => img.getAttribute("loading") === "lazy")).toBe(true);
    expect(images[1].getAttribute("alt")).toBe("슬라이드 2 – 제목 2");
    expect(screen.getByText("슬라이드 3 / 3")).toBeTruthy();
    // The tab title follows the deck through state (setDocumentTitle reads it).
    expect(readState().shareTitle).toBe("분기 보고.pptx");
    expect(document.title).toBe("분기 보고.pptx · Noah Almighty");
  });

  it("shows a download-only deck with the empty note and no present mode", async () => {
    stubFetch({ open: () => json(payload({ slides: [] })) });
    openViewer();
    expect(await screen.findByText("미리보기가 없습니다. 파일을 내려받아 확인해 주세요.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "발표 모드" })).toBeNull();
    expect(screen.getByRole("link", { name: "다운로드" })).toBeTruthy();
  });

  it("says when the preview was capped", async () => {
    stubFetch({ open: () => json(payload({ slides: slidesOf(30), previewCapped: true })) });
    openViewer();
    expect(
      await screen.findByText("미리보기는 최대 30장까지 표시됩니다. 전체 슬라이드는 파일을 내려받아 확인해 주세요."),
    ).toBeTruthy();
  });

  it("turns a 404 into the dead-link state with a way back to 탐색", async () => {
    stubFetch({ open: () => json({ error: SHARE_LINK_GONE_MESSAGE }, 404) });
    openViewer();
    expect(await screen.findByText(SHARE_LINK_GONE_MESSAGE)).toBeTruthy();
    expect(screen.getByText("링크를 보낸 분께 새 링크를 요청해 주세요.")).toBeTruthy();
    expect(screen.queryByText("공유 자료를 불러오지 못했습니다.")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "탐색으로 이동" }));
    expect(readState().view).toBe("explore");
  });

  it("never fetches a malformed token — it is a dead link on sight", async () => {
    stubFetch();
    openViewer("..%2F..%2Fapi%2Fme");
    expect(await screen.findByText(SHARE_LINK_GONE_MESSAGE)).toBeTruthy();
    expect(opens()).toEqual([]);
  });

  it("offers a retry for any other failure instead of calling the link dead", async () => {
    let attempt = 0;
    stubFetch({ open: () => (++attempt === 1 ? json({}, 503) : json(payload())) });
    openViewer();
    expect(await screen.findByText("공유 자료를 불러오지 못했습니다.")).toBeTruthy();
    expect(screen.queryByText(SHARE_LINK_GONE_MESSAGE)).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("heading", { level: 1, name: "분기 보고.pptx" })).toBeTruthy();
    expect(opens()).toHaveLength(2);
  });

  it("refetches when a second link opens while the viewer is mounted", async () => {
    stubFetch({
      open: (call) => json(payload({ fileName: call.body.token === TOKEN ? "첫 자료.pptx" : "둘째 자료.pptx" })),
    });
    openViewer();
    expect(await screen.findByRole("heading", { level: 1, name: "첫 자료.pptx" })).toBeTruthy();
    replaceState({ shareToken: TOKEN_2 });
    expect(await screen.findByRole("heading", { level: 1, name: "둘째 자료.pptx" })).toBeTruthy();
    expect(opens().map((call) => call.body.token)).toEqual([TOKEN, TOKEN_2]);
  });

  it("renders every payload string as text, never as markup", async () => {
    const hostile = '<img src="x" onerror="alert(1)">보고서';
    stubFetch({
      open: () =>
        json(
          payload({
            fileName: hostile,
            ownerName: "<b>보안팀</b>",
            slides: [{ index: 1, url: "/api/share/t/tk/slides/1", alt: "<script>alert(1)</script>" }],
          }),
        ),
    });
    const { container } = openViewer();
    const heading = await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(heading.textContent).toBe(hostile));
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelector("b, script")).toBeNull();
    expect(screen.getByText("<b>보안팀</b> (@minsu)님이 공유 · 10월 8일 09:05까지")).toBeTruthy();
    expect(container.querySelector(".share-slides img")?.getAttribute("alt")).toBe("<script>alert(1)</script>");
  });

  it("uses only /api/share/ URLs for renders and the download", async () => {
    stubFetch({
      open: () =>
        json(
          payload({
            slides: [
              { index: 1, url: "/api/share/t/tk/slides/1", alt: "슬라이드 1" },
              { index: 2, url: "https://evil.example/2.png", alt: "슬라이드 2" },
              { index: 3, url: "/api/conversations/c/images/i", alt: "슬라이드 3" },
            ],
            downloadUrl: "https://evil.example/deck.pptx",
          }),
        ),
    });
    const { container } = openViewer();
    await screen.findByRole("heading", { level: 1, name: "분기 보고.pptx" });
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources).toEqual(["/api/share/t/tk/slides/1"]);
    expect(screen.queryByRole("link", { name: "다운로드" })).toBeNull();
  });

  it("marks a render that failed to load and refreshes the viewer tickets on retry", async () => {
    let ticket = 0;
    stubFetch({ open: () => json(payload({ slides: slidesOf(2, `tk${++ticket}`) })) });
    const { container } = openViewer();
    await screen.findByRole("heading", { level: 1, name: "분기 보고.pptx" });
    await fireEvent.error(container.querySelector(".share-slides img")!);
    expect(await screen.findByText("슬라이드를 불러오지 못했습니다")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() =>
      expect(container.querySelector(".share-slides img")?.getAttribute("src")).toBe("/api/share/t/tk2/slides/1"),
    );
    expect(screen.queryByText("슬라이드를 불러오지 못했습니다")).toBeNull();
    expect(opens()).toHaveLength(2);
    // The first open is a view; renewing the tickets is marked as a refresh.
    expect(opens().map((call) => call.body)).toEqual([{ token: TOKEN }, { token: TOKEN, refresh: true }]);
  });

  it("turns into the dead-link state when a refresh finds the link revoked", async () => {
    let attempt = 0;
    stubFetch({ open: () => (++attempt === 1 ? json(payload()) : json({ error: SHARE_LINK_GONE_MESSAGE }, 404)) });
    const { container } = openViewer();
    await screen.findByRole("heading", { level: 1, name: "분기 보고.pptx" });
    await fireEvent.error(container.querySelector(".share-slides img")!);
    await fireEvent.click(await screen.findByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText(SHARE_LINK_GONE_MESSAGE)).toBeTruthy();
    expect(readState().shareTitle).toBe("");
  });

  it("re-opens the link for fresh tickets before presenting from a long-open viewer", async () => {
    let ticket = 0;
    stubFetch({ open: () => json(payload({ slides: slidesOf(3, `tk${++ticket}`) })) });
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    openViewer();
    await screen.findByRole("heading", { level: 1, name: "분기 보고.pptx" });
    now.mockReturnValue(1_000_000 + SHARE_TICKET_REFRESH_MS + 1);
    await fireEvent.click(screen.getByRole("button", { name: "발표 모드" }));
    const stage = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".slide-presenter-stage");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(opens()).toHaveLength(2);
    expect(opens()[1].body).toEqual({ token: TOKEN, refresh: true });
    expect(stage.querySelector("img")?.getAttribute("src")).toBe("/api/share/t/tk2/slides/1");
  });

  it("starts present mode on the slide clicked in the list", async () => {
    stubFetch();
    openViewer();
    await screen.findByRole("heading", { level: 1, name: "분기 보고.pptx" });
    await fireEvent.click(screen.getByRole("button", { name: "슬라이드 2 – 제목 2 — 이 슬라이드부터 발표" }));
    const dialog = await screen.findByRole("dialog", { name: "발표 모드: 분기 보고.pptx" });
    expect(dialog.querySelector(".slide-presenter-count")?.textContent?.replace(/\s+/g, " ").trim()).toBe("슬라이드 2 / 3");
    await fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

/* ------------------------------------------------------------------ */
/* present mode                                                        */
/* ------------------------------------------------------------------ */

describe("SlidePresenter", () => {
  const counter = (): string =>
    document.querySelector(".slide-presenter-count")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const shown = (): string | null => document.querySelector(".slide-presenter-image")?.getAttribute("src") ?? null;

  function present(start = 0, count = 4) {
    const onClose = vi.fn();
    const onRetry = vi.fn();
    const view = render(SlidePresenter, {
      props: { slides: slidesOf(count), start, title: "분기 보고.pptx" },
      events: { close: onClose, retry: onRetry },
    });
    return { ...view, onClose, onRetry };
  }

  it("focuses the stage, never 닫기, so the first Space turns the page", async () => {
    const { onClose } = present(0);
    await tick();
    expect(document.activeElement?.classList.contains("slide-presenter-stage")).toBe(true);
    await fireEvent.keyDown(document.activeElement!, { key: " " });
    expect(counter()).toBe("슬라이드 2 / 4");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("turns pages with ←/→/PageUp/PageDown/Space/Enter/Home/End and clamps at the ends", async () => {
    present(1);
    expect(counter()).toBe("슬라이드 2 / 4");
    const press = async (key: string) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      await tick();
      return event.defaultPrevented;
    };
    expect(await press("ArrowRight")).toBe(true);
    expect(counter()).toBe("슬라이드 3 / 4");
    await press("PageDown");
    expect(shown()).toBe("/api/share/t/tk/slides/4");
    await press("Enter");
    expect(counter()).toBe("슬라이드 4 / 4"); // clamped
    await press("Home");
    expect(counter()).toBe("슬라이드 1 / 4");
    await press("ArrowLeft");
    expect(counter()).toBe("슬라이드 1 / 4");
    await press("End");
    expect(counter()).toBe("슬라이드 4 / 4");
    await press("PageUp");
    expect(counter()).toBe("슬라이드 3 / 4");
    // Browser shortcuts stay the browser's.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true }));
    await tick();
    expect(counter()).toBe("슬라이드 3 / 4");
  });

  it("lets a focused bar button activate itself instead of turning the page twice", async () => {
    present(0);
    const next = screen.getByRole("button", { name: "다음" });
    next.focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    next.dispatchEvent(event);
    await tick();
    expect(event.defaultPrevented).toBe(false);
    expect(counter()).toBe("슬라이드 1 / 4");
  });

  it("works without a keyboard: bar buttons and left/right tap zones", async () => {
    const { onClose } = present(1);
    await fireEvent.click(screen.getByRole("button", { name: "다음" }));
    expect(counter()).toBe("슬라이드 3 / 4");
    await fireEvent.click(screen.getByRole("button", { name: "이전" }));
    expect(counter()).toBe("슬라이드 2 / 4");
    await fireEvent.click(screen.getByRole("button", { name: "다음 슬라이드" }));
    expect(counter()).toBe("슬라이드 3 / 4");
    await fireEvent.click(screen.getByRole("button", { name: "이전 슬라이드" }));
    expect(counter()).toBe("슬라이드 2 / 4");
    expect((screen.getByRole("button", { name: "이전 슬라이드" }) as HTMLButtonElement).tabIndex).toBe(-1);
    await fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables 이전 on the first slide and 다음 on the last", () => {
    present(0, 2);
    expect((screen.getByRole("button", { name: "이전" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "다음" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("closes on Esc in the overlay fallback (no Fullscreen API)", async () => {
    const { onClose } = present(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await tick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks for real fullscreen and ends present mode when the browser leaves it", async () => {
    const { request } = installFullscreen();
    const { onClose } = present(0);
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
    expect(fullscreenElement?.classList.contains("slide-presenter")).toBe(true);
    // Esc in element fullscreen: the browser exits and no keydown reaches us.
    leaveFullscreen();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves fullscreen when 닫기 is pressed", async () => {
    const { exit } = installFullscreen();
    const { onClose } = present(0);
    await tick();
    await fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(exit).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays usable as an overlay when fullscreen is refused", async () => {
    installFullscreen();
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      writable: true,
      value: vi.fn(() => Promise.reject(new Error("denied"))),
    });
    const { onClose } = present(0);
    await tick();
    await fireEvent.click(screen.getByRole("button", { name: "다음" }));
    expect(counter()).toBe("슬라이드 2 / 4");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("preloads the next slide", async () => {
    // jsdom's Image is a legacy factory that ignores subclass prototypes, so a
    // plain constructor records what the presenter asks the cache to load.
    const created: string[] = [];
    vi.stubGlobal(
      "Image",
      vi.fn(function FakeImage() {
        return {
          set src(value: string) {
            created.push(value);
          },
        };
      }),
    );
    present(0);
    await tick();
    expect(created).toContain("/api/share/t/tk/slides/2");
    await fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await tick();
    expect(created).toContain("/api/share/t/tk/slides/3");
  });

  it("replaces a broken render with a retry that asks for fresh tickets", async () => {
    const { onRetry, rerender } = present(0);
    await fireEvent.error(document.querySelector(".slide-presenter-image")!);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("슬라이드를 불러오지 못했습니다")).toBeTruthy();
    expect(document.querySelector(".slide-presenter-image")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(shown()).toBe("/api/share/t/tk/slides/1");
    // Fresh tickets arrive as new URLs; an earlier failure never sticks to them.
    await fireEvent.error(document.querySelector(".slide-presenter-image")!);
    await rerender({ slides: slidesOf(4, "fresh") });
    expect(shown()).toBe("/api/share/t/fresh/slides/1");
  });
});

/* ------------------------------------------------------------------ */
/* first visit through the app shell                                   */
/* ------------------------------------------------------------------ */

describe("first visit from a share link", () => {
  it("tells a logged-out visitor why the login screen appeared", async () => {
    history.replaceState(null, "", `/#/share/${TOKEN}`);
    stubFetch({ me: null });
    render(App);
    expect(await screen.findByText("공유받은 PPT를 보려면 Noah에 로그인하세요.")).toBeTruthy();
    // The hash survives the login screen, so the deck opens right after login.
    expect(location.hash).toBe(`#/share/${TOKEN}`);
    expect(opens()).toEqual([]);
  });

  it("shows no hint on an ordinary login", async () => {
    stubFetch({ me: null });
    render(App);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText("공유받은 PPT를 보려면 Noah에 로그인하세요.")).toBeNull();
  });

  it("shows the hint when a link is pasted into a tab already on the login screen", async () => {
    // A same-document fragment navigation: no reload and no AuthView remount,
    // only a hashchange — a hint read once at mount stayed hidden.
    stubFetch({ me: null });
    render(App);
    const loginHeading = await screen.findByRole("heading", { level: 1 });
    const navigated = () => new Promise((resolve) => window.addEventListener("hashchange", resolve, { once: true }));
    let hashChanged = navigated();
    location.hash = `#/share/${TOKEN}`;
    await hashChanged;
    expect(await screen.findByText("공유받은 PPT를 보려면 Noah에 로그인하세요.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 })).toBe(loginHeading);
    // Leaving the link takes the hint away again.
    hashChanged = navigated();
    location.hash = "#/explore";
    await hashChanged;
    await waitFor(() => expect(screen.queryByText("공유받은 PPT를 보려면 Noah에 로그인하세요.")).toBeNull());
    expect(opens()).toEqual([]);
  });

  it("opens the deck after login and holds the welcome modal until the viewer is left", async () => {
    history.replaceState(null, "", `/#/share/${TOKEN}`);
    stubFetch({ me: userOf({ onboardedAt: null }) });
    render(App);
    expect(await screen.findByRole("heading", { level: 1, name: "분기 보고.pptx" })).toBeTruthy();
    expect(readState().view).toBe("share");
    expect(screen.queryByText("아바타 사용 준비하기")).toBeNull();

    goView("explore");
    expect(await screen.findByText("아바타 사용 준비하기")).toBeTruthy();
  });

  it("holds what's-new the same way", async () => {
    history.replaceState(null, "", `/#/share/${TOKEN}`);
    stubFetch({ me: userOf({ lastSeenRelease: null }) });
    render(App);
    await screen.findByRole("heading", { level: 1, name: "분기 보고.pptx" });
    expect(screen.queryByText("새로워진 기능")).toBeNull();
    goView("explore");
    expect(await screen.findByText("새로워진 기능")).toBeTruthy();
  });

  it("keeps the share link through a session expiry so the deck reopens after login", async () => {
    history.replaceState(null, "", `/#/share/${TOKEN}`);
    stubFetch({ me: userOf(), open: () => json({ error: "Authentication required" }, 401) });
    render(App);
    expect(await screen.findByText("공유받은 PPT를 보려면 Noah에 로그인하세요.")).toBeTruthy();
    expect(readState().user).toBeNull();
    expect(location.hash).toBe(`#/share/${TOKEN}`);
  });
});
