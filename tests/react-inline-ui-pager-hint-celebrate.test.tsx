// Inline UI's <pager>, <hint> and <celebrate>, drawn by the chat's own
// renderer (components/widget/AnswerUi.tsx) from an answer's text: the pager
// turns pages by itself or follows a bound state, the hint is a disclosure that
// one Escape closes (and nothing under it), and the celebration plays only on a
// change the viewer made — never for a value that was already true, never while
// the answer is being written, and as a still badge under 움직임 줄이기.
// jsdom: no layout, and the Web Animations polyfill of setup-dom.ts stands in
// for the real animation (a real browser is not covered here).
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AnswerUi from "../src/client/src/components/widget/AnswerUi";
import { clearLiveWidgetState } from "../src/client/src/lib/widgetState.js";
import type { ChatPane } from "../src/client/src/lib/types.js";
import type { AvatarDetail } from "../src/server/types.js";

const avatar = { id: "avatar-1", username: "ava", displayName: "아바타", isOwn: true, elevated: true, plugins: [], hashtags: [] } as unknown as AvatarDetail;

function pane(over: Record<string, unknown> = {}): ChatPane {
  return {
    id: "pane-1",
    avatar,
    conversationId: "conv-1",
    messages: [],
    canvases: [],
    fileTabs: [],
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

/** A gallery-style preview: nothing is kept in this browser or reported. */
function draw(text: string, props: { streaming?: boolean } = {}) {
  return render(<AnswerUi pane={pane()} text={text} outbox={() => {}} {...props} />);
}

beforeEach(() => {
  localStorage.clear();
  clearLiveWidgetState("pane-1");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 204, json: async () => ({}) })));
});

afterEach(() => {
  delete document.documentElement.dataset.motion;
  vi.unstubAllGlobals();
});

const STEPS = `<pager label="설치 안내">
  <page title="1. 내려받기"><text>파일을 받습니다.</text></page>
  <page title="2. 설치"><text>설치합니다.</text></page>
  <page title="3. 로그인"><text>로그인합니다.</text></page>
</pager>
`;

describe("<pager>", () => {
  it("shows one page at a time and turns with its arrows and with ←/→ — keeping the focus at either end", () => {
    const { container } = draw(STEPS);
    const pager = screen.getByRole("region", { name: "설치 안내" });
    const prev = within(pager).getByRole("button", { name: "이전" });
    const next = within(pager).getByRole("button", { name: "다음" });
    expect(within(pager).getByText("1 / 3")).toBeTruthy();
    expect(within(pager).getByText("파일을 받습니다.")).toBeTruthy();
    expect(within(pager).queryByText("설치합니다.")).toBeNull();
    expect(prev.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(next);
    expect(within(pager).getByText("2 / 3")).toBeTruthy();
    expect(within(pager).getByText("설치합니다.")).toBeTruthy();
    expect(within(pager).queryByText("파일을 받습니다.")).toBeNull();

    next.focus();
    fireEvent.keyDown(next, { key: "ArrowRight" });
    expect(within(pager).getByText("3 / 3")).toBeTruthy();
    expect(next.getAttribute("aria-disabled")).toBe("true");
    // aria-disabled, not disabled: the focus stays on the arrow, and a press does nothing.
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    expect(within(pager).getByText("3 / 3")).toBeTruthy();

    fireEvent.keyDown(next, { key: "ArrowLeft" });
    fireEvent.keyDown(next, { key: "ArrowLeft" });
    expect(within(pager).getByText("1 / 3")).toBeTruthy();
    expect(container.querySelector(".wg-page-title")?.textContent).toBe("1. 내려받기");
  });

  it("bound to a state: a turn calls onChange, the answer's own control moves it, and nextDisabled holds the › arrow", () => {
    draw(`{@state q = 0}
{@state ok = false}
<pager label="퀴즈" value={q} onChange={setQ} nextDisabled={!ok}>
  <page><text>첫 문제</text></page>
  <page><text>둘째 문제</text></page>
  <page><text>셋째 문제</text></page>
</pager>
<checkbox checked={ok} onChange={setOk}>풀었음</checkbox>
<text>지금 {q}번</text>
<button onClick={() => setQ(2)}>마지막으로</button>
`);
    const pager = screen.getByRole("region", { name: "퀴즈" });
    const next = within(pager).getByRole("button", { name: "다음" });
    expect(next.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(next);
    expect(within(pager).getByText("1 / 3")).toBeTruthy();
    expect(screen.getByText("지금 0번")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "풀었음" }));
    expect(next.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(next);
    // The turn went through the setter: the state the answer reads moved with it.
    expect(within(pager).getByText("2 / 3")).toBeTruthy();
    expect(screen.getByText("지금 1번")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "마지막으로" }));
    expect(within(pager).getByText("3 / 3")).toBeTruthy();
    expect(within(pager).getByText("셋째 문제")).toBeTruthy();
  });
});

describe("<hint>", () => {
  const HINT = "<text>2 + 2는? <hint>**두 번** 세어 보세요.</hint></text>\n";

  it("is a disclosure: the press opens its bubble, a second press closes it", () => {
    draw(HINT);
    const button = screen.getByRole("button", { name: "힌트" });
    const bubble = document.getElementById(button.getAttribute("aria-controls") ?? "")!;
    expect(bubble).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(bubble.hidden).toBe(true);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(bubble.hidden).toBe(false);
    expect(bubble.textContent).toBe("두 번 세어 보세요.");
    expect(bubble.querySelector("strong")?.textContent).toBe("두 번");
    fireEvent.click(button);
    expect(bubble.hidden).toBe(true);
  });

  it("Escape closes only the bubble — no window listener gets it — and the focus goes back to the button", () => {
    draw(HINT);
    const windowKeys = vi.fn();
    window.addEventListener("keydown", windowKeys);
    try {
      const button = screen.getByRole("button", { name: "힌트" });
      fireEvent.click(button);
      const bubble = document.getElementById(button.getAttribute("aria-controls") ?? "")!;
      // The focus may be anywhere inside the hint (a link in the bubble).
      bubble.tabIndex = -1;
      bubble.focus();
      fireEvent.keyDown(bubble, { key: "Escape" });
      expect(bubble.hidden).toBe(true);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(button);
      expect(windowKeys).not.toHaveBeenCalled();
      // A closed hint keeps its hands off Escape: whatever is under it gets the key.
      fireEvent.keyDown(button, { key: "Escape" });
      expect(windowKeys).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", windowKeys);
    }
  });

  it("an Escape that ends an IME composition leaves the bubble open", () => {
    draw(HINT);
    const button = screen.getByRole("button", { name: "힌트" });
    fireEvent.click(button);
    const bubble = document.getElementById(button.getAttribute("aria-controls") ?? "")!;
    fireEvent.keyDown(bubble, { key: "Escape", isComposing: true });
    expect(bubble.hidden).toBe(false);
    // Some browsers mark the composing key only with keyCode 229.
    fireEvent.keyDown(bubble, { key: "Escape", keyCode: 229 });
    expect(bubble.hidden).toBe(false);
    fireEvent.keyDown(bubble, { key: "Escape" });
    expect(bubble.hidden).toBe(true);
  });

  it("a press anywhere else closes it", () => {
    draw(HINT + '<hint label="둘째">다른 힌트</hint>\n');
    const first = screen.getByRole("button", { name: "힌트" });
    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(document.body);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    // A press inside its own bubble does not.
    fireEvent.click(first);
    fireEvent.pointerDown(document.getElementById(first.getAttribute("aria-controls") ?? "")!);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "둘째" }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("<celebrate>", () => {
  const COUNTER = `{@state n = 0}
<button onClick={() => setN(n + 1)}>하나 더</button>
<celebrate when={n >= 2} label="두 번!" />
`;
  const burstOf = (container: HTMLElement) => container.querySelector(".wg-celebrate")?.getAttribute("data-burst") ?? null;

  it("plays when `when` turns true because of the viewer — once per change from false to true", () => {
    const { container } = draw(COUNTER);
    const more = screen.getByRole("button", { name: "하나 더" });
    expect(burstOf(container)).toBeNull();
    fireEvent.click(more);
    expect(burstOf(container)).toBeNull();
    fireEvent.click(more);
    expect(burstOf(container)).toBe("motion");
    expect(container.querySelectorAll(".wg-confetti .wg-confetti-piece").length).toBeGreaterThan(10);
    expect(container.querySelector(".wg-celebrate [role=status]")?.textContent).toBe("두 번!");
  });

  it("does nothing for a value that is already true when it is drawn (a reload, a restored state)", () => {
    const { container } = draw("{@state n = 5}\n<button onClick={() => setN(n + 1)}>하나 더</button>\n<celebrate when={n >= 2} />\n");
    expect(burstOf(container)).toBeNull();
    // Still true after the viewer's change: no change from false to true, no burst.
    fireEvent.click(screen.getByRole("button", { name: "하나 더" }));
    expect(burstOf(container)).toBeNull();
    expect(container.querySelector(".wg-confetti")).toBeNull();
  });

  it("does nothing while the answer is being written, even when its text makes `when` true", () => {
    const view = draw("{@state n = 0}\n<celebrate when={n >= 1} />\n", { streaming: true });
    view.rerender(<AnswerUi pane={pane()} text={"{@state n = 1}\n<celebrate when={n >= 1} />\n"} outbox={() => {}} streaming={true} />);
    view.rerender(<AnswerUi pane={pane()} text={"{@state n = 1}\n<celebrate when={n >= 1} />\n"} outbox={() => {}} streaming={false} />);
    expect(burstOf(view.container)).toBeNull();
    expect(view.container.querySelector(".wg-confetti")).toBeNull();
  });

  it("with 움직임 줄이기 on, shows a still badge for a moment instead of the burst", async () => {
    vi.useFakeTimers();
    try {
      document.documentElement.dataset.motion = "reduce";
      const { container } = draw(COUNTER);
      const more = screen.getByRole("button", { name: "하나 더" });
      fireEvent.click(more);
      fireEvent.click(more);
      expect(burstOf(container)).toBe("still");
      expect(container.querySelector(".wg-confetti")).toBeNull();
      expect(container.querySelector(".wg-celebrate-badge")?.textContent).toBe("🎉 두 번!");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      expect(burstOf(container)).toBeNull();
      expect(container.querySelector(".wg-celebrate-badge")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
