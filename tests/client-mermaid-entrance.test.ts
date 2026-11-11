// @vitest-environment jsdom
// lib/mermaidEntrance.ts — what moves when a ```mermaid diagram appears. The
// fixtures are mermaid 11's own output for small diagrams (as lib/mermaidRender
// sanitizes it), cut down to the elements and attributes the plan reads; mermaid
// cannot lay a diagram out without a real browser, so the REAL output is pinned
// in tests/visual/ui-gallery.spec.ts.
import { describe, expect, it } from "vitest";

import { planMermaidEntrance } from "../src/client/src/lib/mermaidEntrance.js";
import type { EntranceStep } from "../src/client/src/lib/uiEntrance.js";

function host(markup: string): HTMLElement {
  const node = document.createElement("div");
  node.innerHTML = markup;
  return node;
}

const clip = (step: EntranceStep, at: 0 | 1) => String(step.keyframes[at]?.clipPath ?? "");
const on = (steps: EntranceStep[], selector: string) => steps.filter((step) => step.el.matches(selector));

// flowchart LR: A --> B, B -->|예| C, B -.->|아니오| D, subgraph S { C --> E }
const FLOW = `<svg class="flowchart" aria-roledescription="flowchart-v2"><style>.node{}</style><g>
<marker id="m"><path class="arrowMarkerPath"></path></marker>
<g class="root">
  <g class="clusters"><g class="cluster" id="S"><rect x="333" y="8" width="310" height="117"></rect></g></g>
  <g class="edgePaths">
    <path id="L_A_B_0" class="edge-pattern-solid flowchart-link" d="M98,125L102.16,125C106.33,125,114.66,125,122.33,125L144,125"></path>
    <path id="L_B_C_0" class="edge-pattern-solid flowchart-link" d="M217.34,108.34L228.36,101.36C239.39,94.39,261.44,80.44,280.72,73.47L354,66.5"></path>
    <path id="L_B_D_0" class="edge-pattern-dotted flowchart-link" d="M217.34,141.65L228.36,148.63C239.39,155.6,261.44,169.55,280.72,176.52L354.59,183.5"></path>
    <path id="L_X_Y_0" class="edge-pattern-solid flowchart-link" d="M400,40L400,90C400,120,400,150,400,180"></path>
    <path id="L_Y_X_0" class="edge-pattern-solid flowchart-link" d="M500,125L420,125"></path>
  </g>
  <g class="edgeLabels">
    <g class="edgeLabel"><g class="label"><text></text></g></g>
    <g><rect class="background"></rect></g>
    <g class="edgeLabel" transform="translate(283.5, 66.5)"><g class="label"><text>예</text></g></g>
    <g class="edgeLabel" transform="translate(283.5, 183.5)"><g class="label"><text>아니오</text></g></g>
    <g class="edgeLabel"><g class="label"><text></text></g></g>
    <g class="edgeLabel"><g class="label"><text></text></g></g>
  </g>
  <g class="nodes">
    <g class="node default" id="flowchart-A-0" transform="translate(75.5, 125)"><rect class="basic label-container"></rect></g>
    <g class="node default" id="flowchart-B-1" transform="translate(183, 125)"><polygon></polygon></g>
    <g class="node default" id="flowchart-C-3" transform="translate(425, 66.5)"><rect class="basic label-container"></rect></g>
    <g class="node default" id="flowchart-D-5" transform="translate(425, 183.5)"><rect class="basic label-container"></rect></g>
  </g>
</g></g><defs><filter id="shadow"></filter></defs></svg>`;

// sequenceDiagram: U->>A 질문, A-->>U 답변, a note, a loop with one more message.
const SEQUENCE = `<svg aria-roledescription="sequence">
<g><rect x="200" y="331" class="actor actor-bottom"></rect><text x="275" y="363.5" class="actor actor-box">아바타</text></g>
<g><rect x="0" y="331" class="actor actor-bottom"></rect><text x="75" y="363.5" class="actor actor-box">사용자</text></g>
<g><line id="actor1" x1="275" y1="65" x2="275" y2="331" class="actor-line 200"></line><g><rect x="200" y="0" class="actor actor-top"></rect><text x="275" y="32.5" class="actor actor-box">아바타</text></g></g>
<g><line id="actor0" x1="75" y1="65" x2="75" y2="331" class="actor-line 200"></line><g><rect x="0" y="0" class="actor actor-top"></rect><text x="75" y="32.5" class="actor actor-box">사용자</text></g></g>
<g></g>
<style>.actor{}</style>
<defs><symbol id="computer"></symbol></defs>
<g data-et="note"><rect x="50" y="171" class="note"></rect><text x="175" y="176" class="noteText">메모</text></g>
<g data-et="control-structure"><line x1="64" y1="218" x2="286" y2="218" class="loopLine"></line><text x="89" y="231" class="labelText">loop</text></g>
<text x="174" y="80" class="messageText">질문</text>
<line x1="76" y1="113" x2="271" y2="113" class="messageLine0" id="m1"></line>
<text x="177" y="128" class="messageText">답변</text>
<line x1="274" y1="161" x2="79" y2="161" class="messageLine1" id="m2"></line>
<text x="174" y="268" class="messageText">다시</text>
<line x1="76" y1="301" x2="271" y2="301" class="messageLine0" id="m3"></line>
</svg>`;

const PIE = `<svg aria-roledescription="pie"><style></style><g></g><g transform="translate(225,225)">
<circle class="pieOuterCircle"></circle><path class="pieCircle" d="M0,-185A185,185,0,0,1,108,149L0,0Z"></path><path class="pieCircle" d="M108,149A185,185,0,1,1,0,-185L0,0Z"></path>
<text class="slice">40%</text><text class="slice">60%</text><text class="pieTitleText">비중</text>
<g class="legend"><rect></rect><text>A</text></g><g class="legend"><rect></rect><text>B</text></g></g></svg>`;

describe("planMermaidEntrance: a graph (flowchart, state, ER, class, mindmap)", () => {
  const root = host(FLOW);
  const steps = planMermaidEntrance(root);

  it("shows the subgraph frame first and the nodes one after the other, by opacity alone", () => {
    const [frame] = on(steps, "g.cluster");
    expect(frame.delay).toBe(0);
    const nodes = on(steps, "g.node");
    expect(nodes.map((step) => step.el.id)).toEqual(["flowchart-A-0", "flowchart-B-1", "flowchart-C-3", "flowchart-D-5"]);
    expect(nodes.map((step) => step.delay)).toEqual([0, 60, 120, 180]);
    // A node is placed by its `transform` attribute: an animated transform would move it.
    for (const node of nodes) expect(node.keyframes).toEqual([{ opacity: 0, offset: 0 }]);
  });

  it("draws each edge towards its arrowhead, after the nodes began", () => {
    const edges = on(steps, "g.edgePaths > path");
    expect(edges).toHaveLength(5);
    expect(edges.every((edge) => edge.delay >= 180)).toBe(true);
    expect(edges[1].delay).toBeGreaterThan(edges[0].delay);
    // Left to right: the right side starts cut off. A dotted edge is drawn the same way.
    expect(clip(edges[0], 0)).toBe("inset(-12px 100% -12px -12px)");
    expect(clip(edges[2], 0)).toBe("inset(-12px 100% -12px -12px)");
    // Downwards, and right to left.
    expect(clip(edges[3], 0)).toBe("inset(-12px -12px 100% -12px)");
    expect(clip(edges[4], 0)).toBe("inset(-12px -12px -12px 100%)");
    // All end uncovered, with room for the stroke and the arrowhead.
    for (const edge of edges) expect(clip(edge, 1)).toBe("inset(-12px -12px -12px -12px)");
  });

  it("brings each edge's label in right behind its edge", () => {
    const edges = on(steps, "g.edgePaths > path");
    const labels = on(steps, "g.edgeLabels > g.edgeLabel");
    expect(labels).toHaveLength(5);
    labels.forEach((label, i) => expect(label.delay).toBe(edges[i].delay + 160));
    // What else sits among the labels (their backgrounds) comes with the first.
    const [extra] = on(steps, "g.edgeLabels > g:not(.edgeLabel)");
    expect(extra.delay).toBe(labels[0].delay);
  });

  it("moves nothing else: no marker, style or definition", () => {
    expect(steps.some((step) => step.el.closest("marker, style, defs"))).toBe(false);
    expect(steps).toHaveLength(1 + 4 + 5 + 6);
  });

  it("is over inside the window a remount may continue it in", () => {
    expect(Math.max(...steps.map((step) => step.delay + step.duration))).toBeLessThanOrEqual(900);
  });
});

describe("planMermaidEntrance: a sequence diagram", () => {
  const steps = planMermaidEntrance(host(SEQUENCE));
  const order = [...steps].sort((a, b) => a.delay - b.delay);

  it("reads from top to bottom: participants, each message, the bottom row last", () => {
    const what = order.map((step) => step.el.id || step.el.textContent?.trim().slice(0, 6) || step.el.tagName);
    expect(what).toEqual(["아바타", "사용자", "질문", "m1", "답변", "m2", "메모", "loop", "다시", "m3", "아바타", "사용자"]);
    expect(order[0].delay).toBe(0);
    // The two top participants are the first two; the two bottom ones the last.
    expect(order.slice(0, 2).every((step) => step.el.querySelector(".actor-top"))).toBe(true);
    expect(order.slice(-2).every((step) => step.el.querySelector(".actor-bottom"))).toBe(true);
  });

  it("draws a message in the direction it is sent", () => {
    const [toRight, toLeft] = on(steps, "line.messageLine0, line.messageLine1");
    expect(clip(toRight, 0)).toBe("inset(-12px 100% -12px -12px)");
    expect(clip(toLeft, 0)).toBe("inset(-12px -12px -12px 100%)");
  });

  it("leaves out the empty group, the style and the definitions", () => {
    expect(steps).toHaveLength(12);
    expect(Math.max(...steps.map((step) => step.delay + step.duration))).toBeLessThanOrEqual(900);
  });
});

describe("planMermaidEntrance: any other diagram", () => {
  it("opens a lone wrapping group and fades its parts in, in the order they were written", () => {
    const steps = planMermaidEntrance(host(PIE));
    expect(steps.map((step) => step.el.getAttribute("class"))).toEqual(["pieOuterCircle", "pieCircle", "pieCircle", "slice", "slice", "pieTitleText", "legend", "legend"]);
    expect(steps.every((step) => "opacity" in step.keyframes[0])).toBe(true);
    expect(steps[0].delay).toBe(0);
    expect(steps[7].delay).toBeGreaterThan(steps[6].delay);
  });

  it("fades a drawing with too many parts in as one", () => {
    const nodes = Array.from({ length: 200 }, (_, i) => `<g class="node" id="n${i}"></g>`).join("");
    const root = host(`<svg><g class="nodes">${nodes}</g></svg>`);
    const steps = planMermaidEntrance(root);
    expect(steps).toHaveLength(1);
    expect(steps[0].el).toBe(root.querySelector("svg"));
  });

  it("fades a drawing it can make nothing of in as one, and plans nothing where there is none", () => {
    const root = host("<svg><style></style></svg>");
    expect(planMermaidEntrance(root).map((step) => step.el)).toEqual([root.querySelector("svg")]);
    expect(planMermaidEntrance(host("<p>그림 없음</p>"))).toEqual([]);
  });
});
