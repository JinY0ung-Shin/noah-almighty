// Canvas `widget` — the client side: an avatar-declared interactive artifact
// that recomputes in the browser. Runs in the vitest "components" project
// (jsdom). What only a real browser shows (stale legacy-mode reads masked by
// jsdom, layout, CSP) is covered by tests/visual/canvas-widget.spec.ts.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { tick } from "svelte";
import { get } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SidePanel from "../src/client/src/components/SidePanel.svelte";
import WidgetView from "../src/client/src/components/widget/WidgetView.svelte";
import * as chat from "../src/client/src/lib/chat.js";
import { confirmation, resolveConfirmation } from "../src/client/src/lib/confirm.js";
import { readState, replaceState } from "../src/client/src/lib/state.js";
import { WIDGET_STATE_SAVE_DELAY_MS, loadWidgetState, widgetStateKey } from "../src/client/src/lib/widgetState.js";
import { checkWidget, parseWidget, restoreState } from "../src/shared/widget/index.js";

vi.mock("../src/client/src/lib/chat.js", async (original) => ({
  ...(await original<typeof import("../src/client/src/lib/chat.js")>()),
  submitCanvas: vi.fn(async () => {}),
}));

const LOCKED = "아바타 응답이 끝난 뒤 보낼 수 있습니다.";
// widgetPane()'s canvas, for this file's signed-in user.
const REF = { userId: "u1", conversationId: "conv-1", canvasId: "cv1" };
const KEY = widgetStateKey(REF)!;

const CALC = `{@state n = 2}
{@state note = "메모"}
{@const doubled = n * 2}

수량을 **바꿔** 보세요.

<box border>
  <col>
    <slider label="수량" value={n} onChange={setN} min={0} max={10} />
    <input label="메모" value={note} onChange={setNote} />
    <row>
      <text>합계 {doubled}개</text>
      {#if n > 5}
        <badge tone="warning">많음</badge>
      {/if}
    </row>
    {#each Array.from({ length: n }, (_, i) => i + 1) as k}
      <text>항목 {k}</text>
    {/each}
  </col>
</box>

<submit values={{ n, note }}>이 수량으로 진행</submit>
`;

/** Every source in this file is one the server would have shown. */
function widgetSource(source: string): string {
  const check = checkWidget(source);
  expect(check, check.ok ? "" : check.error).toMatchObject({ ok: true });
  return source;
}

function widgetPane(over: Record<string, unknown> = {}, canvas: Record<string, unknown> = {}): any {
  return {
    id: "p1",
    streaming: false,
    sideTab: { kind: "canvas", id: "cv1" },
    avatar: { id: "owner-1", username: "owner", displayName: "나", isOwn: true },
    conversationId: "conv-1",
    liveAttachments: [],
    fileTabs: [],
    canvases: [
      { id: "cv1", title: "계산기", content: widgetSource(CALC), contentType: "widget", interaction: "async", ...canvas },
    ],
    ...over,
  };
}

/** The widget library and components load on demand: wait for the first draw. */
async function widgetShown(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(container.querySelector(".wg-root")).toBeTruthy());
}

async function slide(name: string, value: number): Promise<HTMLInputElement> {
  const slider = (await screen.findByRole("slider", { name })) as HTMLInputElement;
  await fireEvent.input(slider, { target: { value: String(value) } });
  await tick();
  return slider;
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(chat.submitCanvas).mockClear();
  replaceState({ chatPanes: [], user: { id: "u1", username: "me", displayName: "나" } } as unknown as Parameters<typeof replaceState>[0]);
});

/** A bare WidgetView with its state held by the test (what CanvasTab does in the app). */
function mount(source: string) {
  const doc = parseWidget(source);
  expect(doc.problems).toEqual([]);
  let values: Record<string, unknown> = { ...restoreState(doc, null).values };
  const copied: string[] = [];
  const view = render(WidgetView, {
    props: {
      doc,
      values,
      host: {
        get: (name: string) => values[name],
        set: (name: string, value: unknown) => {
          values = { ...values, [name]: value };
          void view.rerender({ values });
        },
        copy: (text: string) => void copied.push(text),
      },
    },
  });
  return { view, copied, values: () => values };
}

describe("WidgetView (recursive render, Svelte legacy mode)", () => {
  it("re-renders nested nodes from new state, with no stale value left behind", async () => {
    mount(widgetSource(CALC));
    expect(screen.getByText("합계 4개")).toBeTruthy();
    expect(screen.getAllByText(/^항목 \d+$/)).toHaveLength(2);

    const slider = await slide("수량", 7);
    expect(screen.getByText("합계 14개")).toBeTruthy();
    expect(screen.queryByText("합계 4개")).toBeNull();
    expect(screen.getByText("많음")).toBeTruthy();
    expect(screen.getAllByText(/^항목 \d+$/)).toHaveLength(7);
    // The same DOM node survives the re-render: a drag or the caret is not lost.
    expect(screen.getByRole("slider", { name: "수량" })).toBe(slider);

    await slide("수량", 1);
    expect(screen.getByText("합계 2개")).toBeTruthy();
    expect(screen.queryByText("많음")).toBeNull();
    expect(screen.getAllByText(/^항목 \d+$/)).toHaveLength(1);
  });

  it("draws top-level prose as Markdown and tag text as inline runs", () => {
    const { view } = mount(
      widgetSource(`# 제목\n\n본문 *기울임*\n\n<text>가격은 **1,000원**이고 \`code\`와 ~~취소~~가 있음</text>\n`),
    );
    expect(view.container.querySelector(".wg-md h1")?.textContent).toBe("제목");
    const text = view.container.querySelector(".wg-text") as HTMLElement;
    expect(text.querySelector("strong")?.textContent).toBe("1,000원");
    expect(text.querySelector("code")?.textContent).toBe("code");
    expect(text.querySelector("s")?.textContent).toBe("취소");
    expect(text.textContent).toContain("가격은 1,000원이고 code와 취소가 있음");
  });

  it("shows what an expression produced as TEXT, never as HTML", async () => {
    const payload = `<img src=x onerror="alert(1)"><b>굵게</b>`;
    const { view } = mount(
      widgetSource(`{@state s = ${JSON.stringify(payload)}}\n\n<text>{s}</text>\n<badge>{s}</badge>\n<stat label={s} value={s} />\n<table columns={[{ key: "a", label: s }]} rows={[{ a: s }]} caption={s} />\n<input label="입력" value={s} onChange={setS} />\n`),
    );
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("b")).toBeNull();
    expect(view.container.querySelector(".wg-text")?.textContent).toBe(payload);
    expect(view.container.querySelector(".wg-badge")?.textContent).toBe(payload);
    expect(view.container.querySelector("td")?.textContent).toBe(payload);
    expect(view.container.querySelector("th")?.textContent).toBe(payload);

    // …and neither does what the PERSON types.
    const typed = `<script>alert(2)</script>`;
    await fireEvent.input(screen.getByRole("textbox", { name: "입력" }), { target: { value: typed } });
    await tick();
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector(".wg-text")?.textContent).toBe(typed);
  });

  it("replaces a node that fails with a notice and keeps drawing its siblings", () => {
    // Not statically valid (the server would refuse it) — a stored version can still be like this.
    const doc = parseWidget(`<text>앞</text>\n<text>{missing(1)}</text>\n<text>뒤</text>\n`);
    expect(doc.problems).toEqual([]);
    const view = render(WidgetView, {
      props: { doc, values: {}, host: { get: () => undefined, set: () => {}, copy: () => {} } },
    });
    expect(screen.getByText("앞")).toBeTruthy();
    expect(screen.getByText("뒤")).toBeTruthy();
    const errors = view.container.querySelectorAll(".wg-error");
    expect(errors).toHaveLength(1);
    expect(errors[0].textContent).toBe("이 부분을 표시하지 못했습니다.");
    expect(errors[0].getAttribute("title")).toContain("missing");
  });

  it("drives every input kind through its handler", async () => {
    const { view, copied, values } = mount(
      widgetSource(`{@state on = false}
{@state dark = false}
{@state plan = "basic"}
{@state region = "kr"}
{@state tab = "a"}
{@state qty = 1}
{@state clicks = 0}

<checkbox checked={on} onChange={setOn}>알림 받기</checkbox>
<switch checked={dark} onChange={setDark}>다크</switch>
<segmented-control label="요금제" value={plan} onChange={setPlan} options={[{ label: "기본", value: "basic" }, { label: "프로", value: "pro" }]} />
<select label="지역" value={region} onChange={setRegion} options={[{ label: "한국", value: "kr" }, { label: "일본", value: "jp" }]} />
<tabs label="보기" value={tab} onChange={setTab} options={[{ label: "요약", value: "a" }, { label: "상세", value: "b" }]} />
<input label="수량" type="number" value={qty} onChange={setQty} />
<button onClick={() => { setClicks((c) => c + 1); setClicks((c) => c + 1); copy("복사됨") }}>두 번</button>
{#if tab === "b"}
  <text>상세 패널</text>
{/if}
<text>{on ? "켬" : "끔"} / {dark ? "다크" : "라이트"} / {plan} / {region} / {qty} / {clicks}</text>
`),
    );
    const summary = () => Array.from(view.container.querySelectorAll(".wg-root > .wg-text")).at(-1)?.textContent;
    expect(summary()).toBe("끔 / 라이트 / basic / kr / 1 / 0");

    await fireEvent.click(screen.getByRole("checkbox", { name: "알림 받기" }));
    await fireEvent.click(screen.getByRole("switch", { name: "다크" }));
    await fireEvent.click(screen.getByRole("radio", { name: "프로" }));
    await fireEvent.change(screen.getByRole("combobox", { name: "지역" }), { target: { value: "1" } });
    await fireEvent.click(screen.getByRole("tab", { name: "상세" }));
    await fireEvent.input(screen.getByRole("spinbutton", { name: "수량" }), { target: { value: "12" } });
    // Chained updater calls in ONE handler compose (each sees the newest value).
    await fireEvent.click(screen.getByRole("button", { name: "두 번" }));
    await tick();

    expect(summary()).toBe("켬 / 다크 / pro / jp / 12 / 2");
    expect(screen.getByText("상세 패널")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "다크" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "프로" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("tab", { name: "상세" }).getAttribute("aria-selected")).toBe("true");
    expect(values().qty).toBe(12); // a number, not the field's text
    expect(copied).toEqual(["복사됨"]);
  });

  it("keeps the text a person is typing into a number field", async () => {
    mount(widgetSource(`{@state qty = 1}\n\n<input label="수량" type="number" value={qty} onChange={setQty} />\n<text>{qty * 2}</text>\n`));
    const field = screen.getByRole("spinbutton", { name: "수량" }) as HTMLInputElement;
    field.focus();
    // "1.50" MEANS 1.5: the re-render must not rewrite it to "1.5" under the caret.
    await fireEvent.input(field, { target: { value: "1.50" } });
    await tick();
    expect(field.value).toBe("1.50");
    expect(screen.getByText("3")).toBeTruthy();
  });
});

describe("WidgetView controls stay on the STATE's value", () => {
  // A native control changes itself before the handler runs. When the handler
  // refuses or alters the change, Svelte sees the same prop and writes nothing —
  // the control then showed one value while the state (and a <submit>) held another.
  it("a checkbox the handler refuses goes back to unchecked", async () => {
    const { values } = mount(
      widgetSource(`{@state picked = []}

{#each ["a", "b", "c"] as k}
  <checkbox checked={picked.includes(k)} onChange={(c) => c ? (picked.length >= 1 ? null : setPicked([...picked, k])) : setPicked(picked.filter((x) => x !== k))}>{k}</checkbox>
{/each}
<text>고른 수 {picked.length}</text>
`),
    );
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    await fireEvent.click(boxes[0]);
    await fireEvent.click(boxes[1]); // refused: at most one
    await waitFor(() => expect(boxes.map((b) => b.checked)).toEqual([true, false, false]));
    expect(values().picked).toEqual(["a"]);
    expect(screen.getByText("고른 수 1")).toBeTruthy();
  });

  it("a slider, a text field and a select follow a handler that clamps or refuses", async () => {
    const { values } = mount(
      widgetSource(`{@state n = 5}
{@state s = "abc"}
{@state r = "kr"}

<slider label="수량" value={n} onChange={(v) => setN(Math.min(v, 5))} min={0} max={10} />
<input label="글자" value={s} onChange={(v) => setS(v.slice(0, 3))} />
<select label="지역" value={r} onChange={(v) => v === "jp" ? null : setR(v)} options={["kr", "jp", "us"]} />
`),
    );
    const slider = screen.getByRole("slider", { name: "수량" }) as HTMLInputElement;
    await fireEvent.input(slider, { target: { value: "9" } });
    await waitFor(() => expect(slider.value).toBe("5"));
    expect(values().n).toBe(5);

    const field = screen.getByRole("textbox", { name: "글자" }) as HTMLInputElement;
    await fireEvent.input(field, { target: { value: "abcd" } });
    await waitFor(() => expect(field.value).toBe("abc"));

    const select = screen.getByRole("combobox", { name: "지역" }) as HTMLSelectElement;
    await fireEvent.change(select, { target: { value: "1" } }); // "jp": refused
    await waitFor(() => expect(select.value).toBe("0"));
    expect(values().r).toBe("kr");
    await fireEvent.change(select, { target: { value: "2" } }); // "us": accepted
    await waitFor(() => expect(values().r).toBe("us"));
    expect(select.value).toBe("2");
  });

  it("does not rewrite a text field in the middle of an IME composition", async () => {
    mount(widgetSource(`{@state s = ""}\n\n<input label="글자" value={s} onChange={(v) => setS(v.slice(0, 2))} />\n`));
    const field = screen.getByRole("textbox", { name: "글자" }) as HTMLInputElement;
    await fireEvent.compositionStart(field);
    await fireEvent.input(field, { target: { value: "한글ㅇ" } }); // state is capped at "한글"
    await tick();
    await tick();
    expect(field.value).toBe("한글ㅇ"); // the syllable being built is left alone
    await fireEvent.compositionEnd(field);
    await waitFor(() => expect(field.value).toBe("한글"));
  });
});

describe("WidgetView with values that evaluate to nothing", () => {
  it("draws a checklist kept in a map: an unset entry is an unchecked box", async () => {
    const { view, values } = mount(
      widgetSource(`{@state done = {}}
{@const items = ["여권", "환전", "보험"]}

{#each items as k}
  <checkbox checked={done[k]} onChange={(c) => setDone({ ...done, [k]: c })}>{k}</checkbox>
{/each}
<text>{Object.values(done).filter((v) => v).length} / {items.length}</text>
`),
    );
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, false, false]);
    expect(view.container.querySelectorAll(".wg-error")).toHaveLength(0);
    await fireEvent.click(boxes[1]);
    await tick();
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(values().done).toEqual({ 환전: true });
    expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).map((b) => b.checked)).toEqual([false, true, false]);
  });

  it("an empty chart spec is an empty chart, not an error", async () => {
    const { view } = mount(
      widgetSource(`{@state on = false}

<switch checked={on} onChange={setOn}>차트 보기</switch>
<chart label="값" spec={on ? { mark: "bar", data: { values: [{ x: "a", y: 1 }] }, encoding: { x: { field: "x", type: "nominal" }, y: { field: "y", type: "quantitative" } } } : null} />
`),
    );
    const chart = view.container.querySelector(".wg-chart") as HTMLElement;
    expect(chart.querySelector(".canvas-render-error")).toBeNull();
    expect(chart.querySelector(".wg-note")?.textContent).toBe("표시할 차트가 없습니다.");
    expect(view.container.querySelectorAll(".wg-error")).toHaveLength(0);

    await fireEvent.click(screen.getByRole("switch", { name: "차트 보기" }));
    await waitFor(() => expect((chart.querySelector(".canvas-svg") as HTMLElement | null)?.shadowRoot?.querySelector("svg")).toBeTruthy(), {
      timeout: 15000,
    });
    expect(chart.querySelector(".wg-note")).toBeNull();
    await fireEvent.click(screen.getByRole("switch", { name: "차트 보기" }));
    await waitFor(() => expect(chart.querySelector(".wg-note")).toBeTruthy());
    expect(chart.querySelector(".canvas-svg")).toBeNull();
  }, 40000);

  it("does not draw, or serialize, a chart spec over the size cap", async () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const { view } = mount(
        widgetSource(`{@const rows = Array.from({ length: 300 }, (_, i) => ({ x: "항목 " + i, y: i, note: "가".repeat(1000) }))}

<chart label="큰 차트" spec={{ mark: "bar", data: { values: rows }, encoding: { x: { field: "x", type: "nominal" }, y: { field: "y", type: "quantitative" } } }} />
`),
      );
      const chart = view.container.querySelector(".wg-chart") as HTMLElement;
      expect(chart.querySelector(".canvas-render-error")?.textContent).toBe("차트 데이터가 너무 커서 그리지 못했습니다.");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(chart.querySelector(".canvas-svg")).toBeNull();
      expect(stringify.mock.calls.some(([value]) => typeof value === "object" && value !== null && "mark" in (value as object))).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it("does not send a <submit> whose values are empty", async () => {
    const sent: unknown[] = [];
    const doc = parseWidget(widgetSource(`{@state pick = null}\n\n<submit values={pick}>보내기</submit>\n`));
    const view = render(WidgetView, {
      props: { doc, values: { pick: null }, host: { get: () => null, set: () => {}, copy: () => {} }, onSubmit: (values: unknown) => void sent.push(values) },
    });
    await fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(sent).toEqual([]);
    expect(view.container.querySelector(".wg-status")?.textContent).toBe("보낼 값이 없어 보내지 않았습니다.");
  });
});

describe("WidgetView handler failures", () => {
  it("says so when a handler exceeds its budget, and keeps the state it had", async () => {
    const { view, values } = mount(
      widgetSource(`{@state n = 0}
{@state big = ""}

<button onClick={() => Array.from({ length: 3000 }, (_, i) => i).forEach((i) => setN(i))}>너무 많이</button>
<button onClick={() => setBig("가".repeat(90000).repeat(20))}>너무 크게</button>
<button onClick={() => setN(n + 1)}>하나 더</button>
<text>n={n} 길이={big.length}</text>
`),
    );
    const status = () => view.container.querySelector(".wg-status")?.textContent;
    await fireEvent.click(screen.getByRole("button", { name: "너무 많이" }));
    await tick();
    expect(status()).toBe("동작을 실행하지 못했습니다.");

    await fireEvent.click(screen.getByRole("button", { name: "너무 크게" }));
    await tick();
    expect(status()).toBe("동작을 실행하지 못했습니다.");
    expect(values().big).toBe("");

    // The widget is still alive: the next handler works and clears the notice.
    const before = Number(values().n);
    await fireEvent.click(screen.getByRole("button", { name: "하나 더" }));
    await tick();
    expect(values().n).toBe(before + 1);
    expect(status()).toBe("");
  });
});

describe("WidgetView <details>", () => {
  it("applies `open` once and then keeps what the person did", async () => {
    const { view } = mount(
      widgetSource(`{@state n = 1}

<details title="고급 설정">
  <slider label="안쪽" value={n} onChange={setN} min={0} max={10} />
</details>
<details title="처음부터 열림" open>
  <text>값 {n}</text>
</details>
`),
    );
    const [closed, opened] = Array.from(view.container.querySelectorAll("details")) as HTMLDetailsElement[];
    expect([closed.open, opened.open]).toEqual([false, true]);

    closed.open = true; // the person opens the first and closes the second
    opened.open = false;
    await slide("안쪽", 4);
    await tick();
    expect(view.container.querySelector(".wg-details .wg-text")?.textContent).toBe("값 4");
    // Neither snapped back to its declared state on the re-evaluation.
    expect([closed.open, opened.open]).toEqual([true, false]);
    expect(view.container.querySelectorAll("details")[0]).toBe(closed);
  });
});

describe("WidgetView top-level prose", () => {
  it("keeps Markdown and drops every other element and attribute", () => {
    // Mid-line, so it is prose (a `<tag>` at the start of a line is a component).
    const { view } = mount(
      widgetSource(`# 제목

안내 <div class="canvas-fs" id="wg1-status"><button class="btn btn-primary btn-sm wg-submit" onclick="alert(1)">보내기</button><a href="https://example.test/x" class="btn">링크</a><form action="https://example.test/p"><input name="pw" type="password"></form><img src="https://example.test/i.png" alt="그림"><span style="position:fixed;inset:0">덮개</span></div> 그리고 [문서](https://example.test/doc) **굵게** \`코드\`

- 하나
- 둘

| 이름 | 값 |
| :-- | --: |
| 가 | 1 |

<text>끝</text>
`),
    );
    const prose = view.container.querySelector(".wg-md") as HTMLElement;
    // What Markdown produces is there…
    expect(prose.querySelector("h1")?.textContent).toBe("제목");
    expect(prose.querySelector("strong")?.textContent).toBe("굵게");
    expect(prose.querySelector("code")?.textContent).toBe("코드");
    expect(prose.querySelectorAll("li")).toHaveLength(2);
    expect(prose.querySelector("td[align='right']")?.textContent).toBe("1");
    // …nothing else is, and no element carries a class, id, style, href or handler.
    expect(prose.querySelector("div, button, a, form, input, img, span, script, style, iframe")).toBeNull();
    const attributes = Array.from(prose.querySelectorAll("*")).flatMap((el) => el.getAttributeNames());
    expect(new Set(attributes)).toEqual(new Set(["align"]));
    // A link or a button leaves its TEXT behind; it does not open or act.
    expect(prose.textContent).toContain("보내기");
    expect(prose.textContent).toContain("링크");
    expect(prose.textContent).toContain("문서");
    expect(prose.innerHTML).not.toContain("example.test");
    expect(view.container.querySelectorAll(".wg-submit")).toHaveLength(0);
  });
});

describe("SidePanel widget canvas", () => {
  it("draws a widget in the panel and recomputes it without the avatar", async () => {
    const pane = widgetPane();
    replaceState({ chatPanes: [pane], user: { id: "u1" } } as unknown as Parameters<typeof replaceState>[0]);
    const { container } = render(SidePanel, { props: { pane } });
    await widgetShown(container);

    expect(container.querySelector(".canvas-content .wg-root")).toBeTruthy();
    expect(container.querySelector(".canvas-content")?.classList.contains("md")).toBe(false);
    expect(screen.getByText("합계 4개")).toBeTruthy();
    // A widget is not a drawing: no image export, the copy button copies its source.
    expect(screen.queryByRole("button", { name: "PNG" })).toBeNull();
    expect(screen.queryByRole("button", { name: "SVG" })).toBeNull();

    await slide("수량", 9);
    expect(screen.getByText("합계 18개")).toBeTruthy();
    expect(chat.submitCanvas).not.toHaveBeenCalled();
  });

  it("sends a submit's values through the canvas submission path", async () => {
    const pane = widgetPane();
    replaceState({ chatPanes: [pane] } as unknown as Parameters<typeof replaceState>[0]);
    render(SidePanel, { props: { pane } });

    await slide("수량", 3);
    await fireEvent.input(screen.getByRole("textbox", { name: "메모" }), { target: { value: "급함" } });
    await tick();
    const submit = screen.getByRole("button", { name: "이 수량으로 진행" }) as HTMLButtonElement;
    expect(submit.classList.contains("btn-primary")).toBe(true);
    expect(submit.disabled).toBe(false);
    await fireEvent.click(submit);

    expect(chat.submitCanvas).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chat.submitCanvas).mock.calls[0]).toEqual(["p1", "cv1", { n: 3, note: "급함" }]);
  });

  it("locks only the submit while the avatar is responding", async () => {
    const pane = widgetPane({ streaming: true });
    render(SidePanel, { props: { pane } });

    const submit = (await screen.findByRole("button", { name: "이 수량으로 진행" })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(LOCKED)).toBeTruthy();
    expect(submit.getAttribute("aria-describedby")).toBe(screen.getByText(LOCKED).id);
    await fireEvent.click(submit);
    expect(chat.submitCanvas).not.toHaveBeenCalled();
    // The widget itself keeps working: it needs no turn.
    await slide("수량", 6);
    expect(screen.getByText("합계 12개")).toBeTruthy();
  });

  it("lists what was actually sent, by key, and leaves the widget usable", async () => {
    const pane = widgetPane({}, { submittedValues: { n: 3, note: "급함", tags: ["a", "b"] } });
    const { container } = render(SidePanel, { props: { pane } });
    await widgetShown(container);

    const answered = container.querySelector(".canvas-answered") as HTMLElement;
    expect(within(answered).getByText("응답 완료")).toBeTruthy();
    expect(Array.from(answered.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["n: 3", "note: 급함", "tags: a, b"]);
    expect((screen.getByRole("button", { name: "이 수량으로 진행" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("slider", { name: "수량" })).toBeTruthy();
  });

  it("keeps the widget's state while another tab shows", async () => {
    const pdf = { id: "file-1", kind: "file", mediaType: "application/pdf", name: "보고.pdf" };
    const base = widgetPane({ fileTabs: [{ attachment: pdf, slides: [] }] });
    const view = render(SidePanel, { props: { pane: base } });
    await slide("수량", 8);

    await view.rerender({ pane: { ...base, sideTab: { kind: "file", id: "file-1" } } });
    expect(screen.queryByRole("slider", { name: "수량" })).toBeNull(); // the card's DOM is dropped

    await view.rerender({ pane: { ...base, sideTab: { kind: "canvas", id: "cv1" } } });
    expect((screen.getByRole("slider", { name: "수량" }) as HTMLInputElement).value).toBe("8");
    expect(screen.getByText("합계 16개")).toBeTruthy();
  });

  it("carries state across a refinement only where the declaration is unchanged", async () => {
    const base = widgetPane();
    const view = render(SidePanel, { props: { pane: base } });
    await slide("수량", 8);
    await fireEvent.input(screen.getByRole("textbox", { name: "메모" }), { target: { value: "바뀐 메모" } });
    await tick();

    // Same canvas id, new version: `n` is declared as before, `note` got a new initializer.
    const refined = widgetSource(CALC.replace('{@state note = "메모"}', '{@state note = "새 기본값"}').replace("합계", "총"));
    await view.rerender({ pane: { ...base, canvases: [{ ...base.canvases[0], content: refined, currentVersion: 2, versionCount: 2 }] } });

    expect(await screen.findByText("총 16개")).toBeTruthy();
    expect((screen.getByRole("slider", { name: "수량" }) as HTMLInputElement).value).toBe("8");
    expect((screen.getByRole("textbox", { name: "메모" }) as HTMLInputElement).value).toBe("새 기본값");
  });

  it("stores what the viewer changed in this browser and restores it on the next visit", async () => {
    vi.useFakeTimers();
    try {
      const pane = widgetPane();
      replaceState({ chatPanes: [pane], user: { id: "u1" } } as unknown as Parameters<typeof replaceState>[0]);
      const first = render(SidePanel, { props: { pane } });
      await slide("수량", 5);
      expect(localStorage.getItem(KEY)).toBeNull(); // debounced
      vi.advanceTimersByTime(WIDGET_STATE_SAVE_DELAY_MS + 1);
      // Only the changed variable is stored, under its declaration.
      expect(loadWidgetState(REF)).toEqual({ n: { sig: "n = 2", value: 5 } });
      first.unmount();

      render(SidePanel, { props: { pane: widgetPane() } });
      expect(((await screen.findByRole("slider", { name: "수량" })) as HTMLInputElement).value).toBe("5");
      expect(screen.getByText("합계 10개")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deleting the canvas forgets its stored state, a pending save included", async () => {
    const pane = widgetPane();
    replaceState({ chatPanes: [pane], user: { id: "u1" } } as unknown as Parameters<typeof replaceState>[0]);
    localStorage.setItem(KEY, JSON.stringify({ n: { sig: "n = 2", value: 4 } }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
    try {
      const view = render(SidePanel, { props: { pane } });
      await slide("수량", 9); // leaves a debounced save pending
      await fireEvent.click(screen.getByRole("button", { name: "캔버스 삭제" }));
      await waitFor(() => expect(get(confirmation)).toBeTruthy());
      resolveConfirmation(true);
      await waitFor(() => expect(readState().chatPanes[0].canvases).toEqual([]));
      view.unmount(); // the tab goes away: its flush must not write the state back
      await new Promise((resolve) => setTimeout(resolve, WIDGET_STATE_SAVE_DELAY_MS + 50));
      expect(loadWidgetState(REF)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not show another account's or another conversation's stored values", async () => {
    localStorage.setItem(widgetStateKey({ ...REF, userId: "someone-else" })!, JSON.stringify({ n: { sig: "n = 2", value: 9 } }));
    // …nor the same canvas id from ANOTHER conversation (an id the avatar picked twice).
    localStorage.setItem(widgetStateKey({ ...REF, conversationId: "conv-other" })!, JSON.stringify({ n: { sig: "n = 2", value: 8 } }));
    const pane = widgetPane();
    render(SidePanel, { props: { pane } });
    expect(await screen.findByText("합계 4개")).toBeTruthy();
  });

  it("falls back to the source when a stored version does not parse", async () => {
    const pane = widgetPane({}, { content: "<box>\n  <text>닫히지 않음\n" });
    const { container } = render(SidePanel, { props: { pane } });
    expect((await screen.findByRole("alert")).textContent).toContain("위젯 소스에 오류가 있어 표시하지 못했습니다.");
    expect(container.querySelector(".wg-root")).toBeNull();
    expect(container.querySelector(".canvas-content pre")?.textContent).toContain("<box>");
  });

  it("keeps the viewer's values when a replay shows an older version first", async () => {
    // A reattach replays the run's whole log: the canvas's previous version
    // lands, renders, and only then the current one.
    const v1 = widgetSource(CALC);
    const v2 = widgetSource(CALC.replace('{@state note = "메모"}', '{@state note = "둘째 판"}'));
    const base = widgetPane({}, { content: v2 });
    replaceState({ chatPanes: [base], user: { id: "u1" } } as unknown as Parameters<typeof replaceState>[0]);
    const view = render(SidePanel, { props: { pane: base } });
    const memo = () => screen.getByRole("textbox", { name: "메모" }) as HTMLInputElement;
    await screen.findByRole("textbox", { name: "메모" });
    await fireEvent.input(memo(), { target: { value: "내 메모" } });
    await tick();

    await view.rerender({ pane: { ...base, canvases: [{ ...base.canvases[0], content: v1 }] } });
    await waitFor(() => expect(memo().value).toBe("메모")); // v1 declares `note` differently
    await view.rerender({ pane: { ...base, canvases: [{ ...base.canvases[0], content: v2 }] } });
    await waitFor(() => expect(memo().value).toBe("내 메모"));
    // …and storage still has it once the next save runs.
    await slide("수량", 3);
    await new Promise((resolve) => setTimeout(resolve, WIDGET_STATE_SAVE_DELAY_MS + 50));
    expect(loadWidgetState(REF)).toEqual({ n: { sig: "n = 2", value: 3 }, note: { sig: 'note = "둘째 판"', value: "내 메모" } });
  });

  it("a change made while the DELETE is in flight is not written back", async () => {
    const pane = widgetPane();
    replaceState({ chatPanes: [pane], user: { id: "u1" } } as unknown as Parameters<typeof replaceState>[0]);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }),
    );
    try {
      const view = render(SidePanel, { props: { pane } });
      await screen.findByRole("slider", { name: "수량" });
      await fireEvent.click(screen.getByRole("button", { name: "캔버스 삭제" }));
      await waitFor(() => expect(get(confirmation)).toBeTruthy());
      resolveConfirmation(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await slide("수량", 9); // the request is still in flight; the widget is on screen
      release();
      await waitFor(() => expect(readState().chatPanes[0].canvases).toEqual([]));
      view.unmount();
      await new Promise((resolve) => setTimeout(resolve, WIDGET_STATE_SAVE_DELAY_MS + 50));
      expect(loadWidgetState(REF)).toBeNull();
      expect(localStorage.getItem(KEY)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resumes saving when the delete fails", async () => {
    const pane = widgetPane();
    replaceState({ chatPanes: [pane], user: { id: "u1" } } as unknown as Parameters<typeof replaceState>[0]);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "서버 오류" }) })));
    try {
      render(SidePanel, { props: { pane } });
      await slide("수량", 7);
      await fireEvent.click(screen.getByRole("button", { name: "캔버스 삭제" }));
      await waitFor(() => expect(get(confirmation)).toBeTruthy());
      resolveConfirmation(true);
      await waitFor(() => expect(loadWidgetState(REF)).toEqual({ n: { sig: "n = 2", value: 7 } }), { timeout: 2000 });
      expect(readState().chatPanes[0].canvases).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("writes a pending change when the page is hidden or going away", async () => {
    const pane = widgetPane();
    replaceState({ chatPanes: [pane], user: { id: "u1" } } as unknown as Parameters<typeof replaceState>[0]);
    const view = render(SidePanel, { props: { pane } });
    await slide("수량", 6);
    expect(loadWidgetState(REF)).toBeNull(); // still inside the debounce
    window.dispatchEvent(new Event("pagehide"));
    expect(loadWidgetState(REF)).toEqual({ n: { sig: "n = 2", value: 6 } });

    await slide("수량", 7);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      visibility.mockRestore();
    }
    expect(loadWidgetState(REF)).toEqual({ n: { sig: "n = 2", value: 7 } });

    // The listeners go away with the tab.
    view.unmount();
    localStorage.clear();
    window.dispatchEvent(new Event("pagehide"));
    expect(loadWidgetState(REF)).toBeNull();
  });

  it("removes the previous chart when a new spec cannot be drawn", async () => {
    const source = widgetSource(`{@state bad = false}

<switch checked={bad} onChange={setBad}>깨기</switch>
<chart label="차트" spec={bad ? { mark: "bar", data: { url: "https://x.test/d.json" } } : { mark: "bar", data: { values: [{ x: "a", y: 1 }] }, encoding: { x: { field: "x", type: "nominal" }, y: { field: "y", type: "quantitative" } } }} />
`);
    const { container } = render(SidePanel, { props: { pane: widgetPane({}, { content: source }) } });
    const drawn = () => Boolean((container.querySelector(".wg-chart .canvas-svg") as HTMLElement | null)?.shadowRoot?.querySelector("svg"));
    await waitFor(() => expect(drawn()).toBe(true), { timeout: 15000 });
    await fireEvent.click(screen.getByRole("switch", { name: "깨기" }));
    await waitFor(() => expect(container.querySelector(".wg-chart .canvas-render-error")?.textContent).toContain("차트를 그리지 못했습니다"), {
      timeout: 15000,
    });
    expect(drawn()).toBe(false); // not an old chart sitting above the error
    // …and it comes back when the spec is drawable again.
    await fireEvent.click(screen.getByRole("switch", { name: "깨기" }));
    await waitFor(() => expect(drawn()).toBe(true), { timeout: 15000 });
    expect(container.querySelector(".wg-chart .canvas-render-error")).toBeNull();
  }, 60000);

  it("draws a chart from the widget's state in its own shadow root", async () => {
    const source = widgetSource(`{@state k = 2}

<slider label="배수" value={k} onChange={setK} min={1} max={5} />
<chart label="배수 차트" spec={{ mark: "bar", data: { values: [{ x: "a", y: k }, { x: "b", y: k * 2 }] }, encoding: { x: { field: "x", type: "nominal" }, y: { field: "y", type: "quantitative" } } }} />
`);
    const pane = widgetPane({}, { content: source });
    const { container } = render(SidePanel, { props: { pane } });

    const host = await waitFor(
      () => {
        const el = container.querySelector(".wg-chart .canvas-svg") as HTMLElement | null;
        if (!el?.shadowRoot?.querySelector("svg")) throw new Error("chart not drawn yet");
        return el;
      },
      { timeout: 15000 },
    );
    expect(host.getAttribute("role")).toBe("img");
    expect(host.getAttribute("aria-label")).toBe("배수 차트");
    expect(container.querySelector(".canvas-content > .wg-root svg")).toBeNull(); // only inside the shadow root
    const before = host.shadowRoot!.innerHTML;

    await slide("배수", 5);
    await waitFor(() => expect(host.shadowRoot!.innerHTML).not.toBe(before), { timeout: 15000 });
  }, 40000);
});
