// Canvas `widget` — sortable tables, icons and state-bound <svg> drawings, as
// the client draws them. Runs in the vitest "components" project (jsdom): what
// only a real browser shows (focus, layout, CSP, a redraw without a flicker) is
// in tests/visual/canvas-widget.spec.ts.
import { fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { describe, expect, it } from "vitest";

import WidgetView from "../src/client/src/components/widget/WidgetView.svelte";
import { ICON_PATHS } from "../src/client/src/lib/icons.js";
import { sanitizeWidgetSvg } from "../src/client/src/lib/widgetSvg.js";
import { SVG_ELEMENTS, SVG_TAGS, checkWidget, parseWidget, restoreState, svgMarkup, type SvgTree } from "../src/shared/widget/index.js";

function widgetSource(source: string): string {
  const check = checkWidget(source);
  expect(check, check.ok ? "" : check.error).toMatchObject({ ok: true });
  return source;
}

/** A bare WidgetView with its state held by the test (what CanvasTab does in the app). */
function mount(source: string, checked = true) {
  const doc = parseWidget(checked ? widgetSource(source) : source);
  expect(doc.problems).toEqual([]);
  let values: Record<string, unknown> = { ...restoreState(doc, null).values };
  const sent: unknown[] = [];
  const problems: string[] = [];
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
        copy: () => {},
      },
      onSubmit: (v: unknown) => void sent.push(v),
      onProblems: (lines: string[]) => void problems.push(...lines),
    },
  });
  return { view, sent, problems, values: () => values };
}

const cells = (container: HTMLElement, column: number): string[] =>
  [...container.querySelectorAll("tbody tr")].map((tr) => tr.querySelectorAll("td")[column]?.textContent ?? "");
const header = (name: string) => screen.getByRole("columnheader", { name: new RegExp(`^${name}`) });

async function slide(name: string, value: number): Promise<void> {
  const slider = (await screen.findByRole("slider", { name })) as HTMLInputElement;
  await fireEvent.input(slider, { target: { value: String(value) } });
  await tick();
}

const TABLE = `{@state bonus = 0}
{@state wide = false}
{@const rows = [{ name: "다람쥐", score: 9 + bonus, team: "B" }, { name: "가방", score: 100, team: "" }, { name: "나비", score: 10, team: "A" }, { name: "하늘", score: null, team: "A" }]}

<slider label="보너스" value={bonus} onChange={setBonus} max={200} />
<switch checked={wide} onChange={setWide}>팀 열 보기</switch>
<table sortable caption="점수표" columns={wide ? [{ key: "name", label: "이름" }, { key: "score", label: "점수", align: "end" }, { key: "team", label: "팀", sortable: false }] : [{ key: "name", label: "이름" }, { key: "score", label: "점수", align: "end" }]} rows={rows} />
<submit values={{ first: rows[0].name, bonus }}>보내기</submit>
`;

describe("<table sortable>", () => {
  it("each header is a button cycling ascending → descending → the document's order, with aria-sort", async () => {
    const { view } = mount(TABLE);
    const { container } = view;
    expect(cells(container, 0)).toEqual(["다람쥐", "가방", "나비", "하늘"]);
    expect(header("이름").getAttribute("aria-sort")).toBe("none");
    expect(header("점수").getAttribute("aria-sort")).toBe("none");

    const score = screen.getByRole("button", { name: "점수" });
    await fireEvent.click(score);
    // numbers numerically (9 < 10 < 100), the empty cell last
    expect(cells(container, 1)).toEqual(["9", "10", "100", ""]);
    expect(header("점수").getAttribute("aria-sort")).toBe("ascending");
    expect(header("이름").getAttribute("aria-sort")).toBe("none");
    expect(score.querySelector(".wg-sort-mark")?.textContent).toBe("▲");
    expect(score.getAttribute("title")).toBe("오름차순으로 정렬됨 — 누르면 내림차순");

    await fireEvent.click(score);
    expect(cells(container, 1)).toEqual(["100", "10", "9", ""]); // empty still last
    expect(header("점수").getAttribute("aria-sort")).toBe("descending");
    expect(score.querySelector(".wg-sort-mark")?.textContent).toBe("▼");

    await fireEvent.click(score);
    expect(cells(container, 0)).toEqual(["다람쥐", "가방", "나비", "하늘"]);
    expect(header("점수").getAttribute("aria-sort")).toBe("none");
    expect(score.querySelector(".wg-sort-mark")?.textContent).toBe("");

    // text: Korean order, and switching column starts at ascending
    await fireEvent.click(screen.getByRole("button", { name: "이름" }));
    expect(cells(container, 0)).toEqual(["가방", "나비", "다람쥐", "하늘"]);
    expect(header("이름").getAttribute("aria-sort")).toBe("ascending");
    expect(header("점수").getAttribute("aria-sort")).toBe("none");
  });

  it("the header button is the same node across sorts and re-evaluations, so focus stays on it", async () => {
    const { view } = mount(TABLE);
    const score = screen.getByRole("button", { name: "점수" });
    score.focus();
    await fireEvent.click(score);
    await fireEvent.click(score);
    expect(screen.getByRole("button", { name: "점수" })).toBe(score);
    expect(document.activeElement).toBe(score);
    await slide("보너스", 150);
    expect(screen.getByRole("button", { name: "점수" })).toBe(score);
    expect(view.container.contains(score)).toBe(true);
  });

  it("is the viewer's LOCAL view: it survives a re-evaluation, follows the new values, and is never state or a submitted value", async () => {
    const { view, sent, values } = mount(TABLE);
    const { container } = view;
    await fireEvent.click(screen.getByRole("button", { name: "점수" }));
    expect(cells(container, 0)).toEqual(["다람쥐", "나비", "가방", "하늘"]);

    // New rows from new state: still sorted by score, now in the new order (9+150 > 100).
    await slide("보너스", 150);
    expect(header("점수").getAttribute("aria-sort")).toBe("ascending");
    expect(cells(container, 1)).toEqual(["10", "100", "159", ""]);
    expect(cells(container, 0)).toEqual(["나비", "가방", "다람쥐", "하늘"]);

    // The widget's state holds nothing about the sort…
    expect(values()).toEqual({ bonus: 150, wide: false });
    // …and a submit sends what the DOCUMENT computed: its first row, not the first row on screen.
    await fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    expect(sent).toEqual([{ first: "다람쥐", bonus: 150 }]);
  });

  it("starts unsorted again when the columns change, and a column can opt out", async () => {
    const { view } = mount(TABLE);
    const { container } = view;
    await fireEvent.click(screen.getByRole("button", { name: "이름" }));
    expect(cells(container, 0)).toEqual(["가방", "나비", "다람쥐", "하늘"]);

    await fireEvent.click(screen.getByRole("switch"));
    await tick();
    expect(cells(container, 0)).toEqual(["다람쥐", "가방", "나비", "하늘"]);
    expect(header("이름").getAttribute("aria-sort")).toBe("none");
    // `sortable: false`: a plain header — no button, no aria-sort
    const team = header("팀");
    expect(team.querySelector("button")).toBeNull();
    expect(team.hasAttribute("aria-sort")).toBe(false);
    expect(screen.getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(expect.arrayContaining(["이름", "점수"]));
  });

  it("a table without `sortable` has plain headers, as before", () => {
    const { view } = mount(`<table columns={[{ key: "a", label: "가" }, "b"]} rows={[{ a: 2, b: "x" }, { a: 1, b: "y" }]} />`);
    expect(view.container.querySelectorAll("th button")).toHaveLength(0);
    expect(view.container.querySelector("th")?.hasAttribute("aria-sort")).toBe(false);
    expect(cells(view.container, 0)).toEqual(["2", "1"]);
    expect([...view.container.querySelectorAll("th")].map((th) => th.textContent)).toEqual(["가", "b"]);
  });
});

describe("icons", () => {
  it("draws the app's own icon: decoration by default, an image with a name when labelled", () => {
    const { view } = mount(`<row><icon name="check" /><icon name="clock" size="xl" color="danger" label="마감 임박" /></row>`);
    const [plain, named] = [...view.container.querySelectorAll(".wg-icon")];
    expect(plain.getAttribute("aria-hidden")).toBe("true");
    expect(plain.hasAttribute("role")).toBe(false);
    expect(plain.querySelector("svg")?.getAttribute("width")).toBe("18");
    // the geometry is the app's (lib/icons.ts), not anything the widget wrote
    const svg = plain.querySelector("svg")!;
    const own = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    own.innerHTML = ICON_PATHS.check;
    expect(svg.innerHTML.replace(/<!--.*?-->/g, "")).toBe(own.innerHTML);

    expect(named.getAttribute("role")).toBe("img");
    expect(named.getAttribute("aria-label")).toBe("마감 임박");
    expect(named.hasAttribute("aria-hidden")).toBe(false);
    expect(named.querySelector("svg")?.getAttribute("width")).toBe("32");
    expect((named as HTMLElement).style.color).toBe("var(--danger)");
    expect(screen.getByRole("img", { name: "마감 임박" })).toBe(named);
  });

  it("a button and a callout take an icon before their text", () => {
    const { view } = mount(`{@state n = 0}
<button onClick={() => setN(n + 1)} icon="plus">추가 {n}</button>
<button send="다시 해 줘" icon="refresh" variant="ghost">다시</button>
<button href="https://example.com/docs" icon="link">문서</button>
<callout tone="warning" icon="clock" title="마감">내일까지입니다.</callout>
<callout tone="info">아이콘 없음</callout>`);
    for (const name of ["추가 0", "다시"]) {
      const button = screen.getByRole("button", { name });
      expect(button.classList.contains("wg-has-icon")).toBe(true);
      expect(button.firstElementChild?.tagName.toLowerCase()).toBe("svg");
      expect(button.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(screen.getByRole("link", { name: "문서" }).querySelector("svg")).toBeTruthy();
    const [withIcon, without] = [...view.container.querySelectorAll(".wg-callout")];
    expect(withIcon.querySelector(".wg-callout-mark svg")).toBeTruthy();
    expect(withIcon.querySelector(".wg-callout-body .wg-callout-title")?.textContent).toBe("마감");
    expect(withIcon.textContent).toContain("내일까지입니다.");
    expect(without.querySelector("svg")).toBeNull();
    expect(without.classList.contains("wg-callout-row")).toBe(false);
  });

  it("a computed name that is not an icon draws no icon and is reported", () => {
    const { view, problems } = mount(`{@state name = "serch"}\n<text>앞</text>\n<icon name={name} />\n<button send="go" icon={name}>가기</button>`);
    expect(view.container.querySelector(".wg-icon")).toBeNull();
    expect(view.container.querySelector(".wg-error")?.getAttribute("title")).toBe('name: "serch" is not one of its names (nearest: search)');
    expect(problems.join("\n")).toContain('<icon>: name: "serch" is not one of its names (nearest: search)');
    // the button is still a button, without an icon
    expect(screen.getByRole("button", { name: "가기" }).querySelector("svg")).toBeNull();
    expect(screen.getByText("앞")).toBeTruthy();
  });
});

const GAUGE = `{@state pct = 60}
{@const a = Math.PI * (1 - pct / 100)}

<slider label="진행률" value={pct} onChange={setPct} suffix="%" />
<svg viewBox="0 0 200 110" label="진행률 게이지">
  <defs><linearGradient id="arc"><stop offset="0" stop-color="success" /><stop offset="1" stop-color="danger" /></linearGradient></defs>
  <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="url(#arc)" stroke-width="14" />
  <line x1="100" y1="100" x2={100 + 70 * Math.cos(a)} y2={100 - 70 * Math.sin(a)} stroke={pct > 80 ? "danger" : "accent"} stroke-width="4" />
  <text x="100" y="90" text-anchor="middle" font-size="20">{pct}%</text>
</svg>
`;

const shadow = (container: HTMLElement, index = 0): ShadowRoot => (container.querySelectorAll(".wg-svg")[index] as HTMLElement).shadowRoot!;

describe("<svg> bound to state", () => {
  it("draws in its own shadow root and redraws from new state WITHOUT re-mounting it", async () => {
    const { view } = mount(GAUGE);
    const host = view.container.querySelector(".wg-svg") as HTMLElement;
    const root = host.shadowRoot!;
    expect(root).toBeTruthy();
    // nothing of the drawing is in the app's own DOM
    expect(view.container.querySelector(".wg-svg svg")).toBeNull();
    expect(host.getAttribute("role")).toBe("img");
    expect(host.getAttribute("aria-label")).toBe("진행률 게이지");

    const line = () => root.querySelector("line")!;
    expect(root.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 200 110");
    expect(root.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
    expect(line().getAttribute("x2")).toBe("121.6312");
    expect(line().getAttribute("stroke")).toBe("var(--accent)");
    expect(root.querySelector("text")?.textContent).toBe("60%");

    await slide("진행률", 90);
    // the same host, the same shadow root — only its content is new
    expect(view.container.querySelector(".wg-svg")).toBe(host);
    expect(host.shadowRoot).toBe(root);
    expect(line().getAttribute("x2")).toBe("166.574");
    expect(line().getAttribute("stroke")).toBe("var(--danger)");
    expect(root.querySelector("text")?.textContent).toBe("90%");
    expect(root.querySelectorAll("svg")).toHaveLength(1);
  });

  it("writes nothing when a state change leaves the drawing as it was", async () => {
    const { view } = mount(`{@state other = 1}\n{@state r = 5}\n<slider label="다른 값" value={other} onChange={setOther} />\n<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r={r} /></svg>`);
    const root = shadow(view.container);
    const circle = root.querySelector("circle");
    await slide("다른 값", 7);
    expect(root.querySelector("circle")).toBe(circle); // the node was not replaced
  });

  it("ids are namespaced per drawing: two copies of one widget, and two drawings in it, never share one", () => {
    const two = `<svg viewBox="0 0 10 10"><linearGradient id="g" /><rect fill="url(#g)" /></svg>\n<svg viewBox="0 0 10 10"><linearGradient id="g" /><rect fill="url(#g)" /></svg>`;
    const card = mount(two);
    const fullscreen = mount(two);
    const idsOf = (container: HTMLElement) => [0, 1].map((i) => shadow(container, i).querySelector("linearGradient")!.id);
    const all = [...idsOf(card.view.container), ...idsOf(fullscreen.view.container)];
    expect(new Set(all).size).toBe(4);
    for (const id of all) expect(id).toMatch(/^wg\d+_[0-9_]+-g$/);
    // each rect points at the gradient of ITS OWN drawing
    for (const container of [card.view.container, fullscreen.view.container]) {
      for (const i of [0, 1]) {
        const root = shadow(container, i);
        expect(root.querySelector("rect")!.getAttribute("fill")).toBe(`url(#${root.querySelector("linearGradient")!.id})`);
      }
    }
  });

  it("without a label the drawing is not an image (its text stays readable); a refused part is reported, the rest draws", () => {
    // Not statically valid — the browser parses a stored version on its own.
    const { view, problems } = mount(`{@state evil = "url(https://evil.example/x.svg#a)"}\n<svg viewBox="0 0 10 10"><script>alert(1)</script><rect fill={evil} onclick="alert(1)" x="1" /><text>값</text></svg>`, false);
    const host = view.container.querySelector(".wg-svg") as HTMLElement;
    expect(host.hasAttribute("role")).toBe(false);
    expect(host.hasAttribute("aria-label")).toBe(false);
    expect(host.shadowRoot!.querySelector("svg")!.innerHTML).toBe('<rect x="1"></rect><text>값</text>');
    expect(problems.join("\n")).toMatch(/<svg>: a prop was dropped — <script> is not allowed inside <svg>/);
    expect(problems.join("\n")).toContain("<rect> fill may only reference an element of this drawing as url(#id) — no other URL");
    expect(view.container.querySelector(".wg-error")?.textContent).toBe("일부 설정을 적용하지 못했습니다.");
  });

  it("a drawing over its element cap becomes one error in its place; its siblings still draw", () => {
    const { view, problems } = mount(`<text>앞</text>\n<svg viewBox="0 0 10 10">{#each 600 as i}<rect x={i} />{/each}</svg>\n<text>뒤</text>`);
    expect(view.container.querySelector(".wg-svg")).toBeNull();
    expect(view.container.querySelector(".wg-error")?.getAttribute("title")).toMatch(/the <svg> draws too many elements \(limit 500\)/);
    expect(screen.getByText("앞")).toBeTruthy();
    expect(screen.getByText("뒤")).toBeTruthy();
    expect(problems.join("\n")).toMatch(/line 2:1 <svg>: the <svg> draws too many elements/);
  });
});

describe("the second wall: DOMPurify on the printed drawing", () => {
  const el = (tag: string, attrs: [string, string][] = [], children: (SvgTree | string)[] = []): SvgTree => ({ tag, attrs, children });
  const clean = (tree: SvgTree) => sanitizeWidgetSvg(svgMarkup(tree));

  it("keeps what the library builds", () => {
    const markup =
      '<svg viewBox="0 0 200 110" width="200" fill="currentColor"><defs><linearGradient id="wg1-arc" x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox">' +
      '<stop offset="0" stop-color="var(--ok)"></stop><stop offset="100%" stop-color="#e11d48" stop-opacity="0.5"></stop></linearGradient>' +
      '<clipPath id="wg1-top" clipPathUnits="userSpaceOnUse"><rect x="0" y="0" width="200" height="100"></rect></clipPath>' +
      '<marker id="wg1-m" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3L0 6z"></path></marker></defs>' +
      '<path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="url(#wg1-arc)" stroke-width="14" stroke-linecap="round" clip-path="url(#wg1-top)" marker-end="url(#wg1-m)"></path>' +
      '<g transform="rotate(45 50 50) translate(10)" opacity="0.5"><line x1="100" y1="100" x2="121.6312" y2="33.426" stroke="rgb(1 2 3 / 0.5)" stroke-dasharray="4 2"></line></g>' +
      '<text x="100" y="90" dy="0.35em" text-anchor="middle" dominant-baseline="middle" font-size="20" font-weight="bold" fill="hsl(210deg 50% 40%)">60%<tspan dx="2">p</tspan></text>' +
      "<title>툴팁 &lt;b&gt;</title></svg>";
    expect(sanitizeWidgetSvg(markup)).toBe(markup);
    expect(sanitizeWidgetSvg("")).toBe("");
  });

  it("lets through EVERY element and attribute of the allowlist (a profile that dropped one would change drawings silently)", () => {
    const sample = (kind: unknown): string => {
      if (Array.isArray(kind)) return String(kind[0]);
      switch (kind) {
        case "paint":
        case "color":
          return "var(--accent)";
        case "dash":
          return "4 2";
        case "points":
          return "0 0 10 5";
        case "path":
          return "M0 0L6 3z";
        case "transform":
          return "rotate(45 5 5)";
        case "id":
          return "wg1-a";
        case "ref":
          return "url(#wg1-a)";
        case "viewBox":
          return "0 0 6 6";
        case "orient":
          return "auto";
        case "unit":
        case "offset":
          return "0.5";
        default:
          return "3";
      }
    };
    const lost: string[] = [];
    for (const tag of SVG_TAGS) {
      const attrs = Object.entries(SVG_ELEMENTS[tag].attrs).map(([name, kind]): [string, string] => [name, sample(kind)]);
      const out = clean(el("svg", [["viewBox", "0 0 1 1"], ["width", "10"], ["fill", "currentColor"]], [el(tag, attrs)]));
      const root = document.createElement("div");
      root.innerHTML = out;
      const node = root.querySelector("svg")?.firstElementChild;
      if (!node || node.tagName !== tag) {
        lost.push(`<${tag}>`);
        continue;
      }
      for (const [name, value] of attrs) if (node.getAttribute(name) !== value) lost.push(`${tag}.${name}`);
      expect(root.querySelector("svg")?.getAttribute("viewBox"), tag).toBe("0 0 1 1");
    }
    expect(lost).toEqual([]);
  });

  it("strips a hostile element that somehow reached the renderer", () => {
    const out = clean(
      el("svg", [["viewBox", "0 0 1 1"]], [
        el("circle", [["r", "2"]]),
        el("script", [], ["alert(1)"]),
        el("style", [], ["* { position: fixed; background: url(https://evil.example/a) }"]),
        el("foreignObject", [], [el("iframe", [["src", "https://evil.example"]])]),
        el("image", [["href", "https://evil.example/pixel.png"]]),
        el("use", [["href", "https://evil.example/x.svg#a"]]),
        el("a", [["href", "javascript:alert(1)"]], [el("rect", [["x", "1"]])]),
        el("animate", [["attributeName", "href"], ["to", "javascript:alert(1)"]]),
        el("set", [["attributeName", "onload"], ["to", "alert(1)"]]),
        el("filter", [["id", "f"]], [el("feImage", [["href", "https://evil.example/a.png"]])]),
        el("iframe", [["src", "https://evil.example"]]),
        el("img", [["src", "x"], ["onerror", "alert(1)"]]),
        // An HTML element makes the parser LEAVE the svg: what follows it is no longer SVG and goes too (fail closed).
        el("rect", [["x", "9"]]),
      ]),
    );
    expect(out).toBe('<svg viewBox="0 0 1 1"><circle r="2"></circle></svg>');
    for (const gone of ["script", "alert", "style", "evil", "iframe", "img", "href", "animate", "filter", "foreignObject"]) expect(out).not.toContain(gone);
  });

  it("strips a hostile attribute or value that somehow reached the renderer", () => {
    const out = clean(
      el("svg", [["viewBox", "0 0 1 1"], ["onload", "alert(1)"], ["style", "position:fixed;inset:0"], ["class", "btn btn-primary"]], [
        el("rect", [["onclick", "alert(1)"], ["style", "fill:url(https://evil.example/a)"], ["class", "modal"], ["href", "https://evil.example"], ["xlink:href", "#a"], ["x", "1"]]),
        el("rect", [["fill", "url(https://evil.example/x.svg#a)"], ["stroke", "url(//evil.example/x.svg#a)"], ["clip-path", "url(data:image/svg+xml,x#c)"], ["y", "2"]]),
        el("rect", [["fill", "url(#a);background:url(https://evil.example)"], ["stroke", "\\75rl(https://evil.example)"], ["mask", "u\\rl(#m)"], ["rx", "3"]]),
        el("rect", [["fill", "javascript:alert(1)"], ["stroke", "expression(alert(1))"], ["filter", "url(#f)"], ["tabindex", "0"], ["data-x", "1"], ["aria-label", "x"], ["ry", "4"]]),
        el("rect", [["fill", "url(#wg1-ok)"], ["stroke", "var(--accent)"]]),
      ]),
    );
    expect(out).toBe('<svg viewBox="0 0 1 1"><rect x="1"></rect><rect y="2"></rect><rect rx="3"></rect><rect ry="4"></rect><rect fill="url(#wg1-ok)" stroke="var(--accent)"></rect></svg>');
  });
});
