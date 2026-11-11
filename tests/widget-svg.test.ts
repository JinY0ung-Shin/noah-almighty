// A widget's `<svg>`: a drawing whose attributes and text follow state. The
// source is written by a model (possibly steered by a page it read), so the
// rules are an ALLOWLIST — elements, attributes per element, and the SHAPE of
// every value — enforced twice: statically by `checkWidget` (the server, before
// anything is shown) and again on the evaluated values by `renderSvg` (the
// browser, which parses the source itself). The third wall, DOMPurify + a
// shadow root, is in tests/svelte-canvas-widget-more.test.ts.
import { describe, expect, it } from "vitest";

import { checkWidget } from "../src/shared/widget/check.js";
import { WidgetBudgetError, WidgetRuntimeError, createRuntime, type Runtime } from "../src/shared/widget/interp.js";
import { createRootEnv, resolveProps, restoreState } from "../src/shared/widget/runtime.js";
import { SVG_PAINT_TOKENS } from "../src/shared/widget/style.js";
import { MAX_SVG_CHARS, MAX_SVG_NODES, MAX_SVG_PATH_CHARS, SVG_ELEMENTS, SVG_TAGS, svgAttrValue, svgReference } from "../src/shared/widget/svg.js";
import { renderSvg, svgMarkup, type SvgTree } from "../src/shared/widget/svgRender.js";
import { MAX_TEMPLATE_NESTING, MAX_WIDGET_SOURCE_CHARS, parseWidget, type ElNode, type TNode } from "../src/shared/widget/template.js";

const BOX = 'viewBox="0 0 100 100"';
const svg = (inner: string) => `<svg ${BOX}>${inner}</svg>`;

const ok = (src: string) => {
  const r = checkWidget(src);
  expect(r, r.ok ? "" : r.error).toMatchObject({ ok: true });
};
const errorOf = (src: string): string => {
  const r = checkWidget(src);
  expect(r.ok, `expected the check to fail: ${src.slice(0, 120)}`).toBe(false);
  return r.ok ? "" : r.error;
};

function findSvg(nodes: TNode[]): ElNode | null {
  for (const n of nodes) {
    if (n.t === "el" && n.name === "svg") return n;
    if (n.t === "el") {
      const inner = findSvg(n.children);
      if (inner) return inner;
    }
  }
  return null;
}

/** Evaluate the first `<svg>` of a source the way the client does (no static check: the browser parses on its own). */
function draw(source: string, ns = "wg1", override: Record<string, unknown> = {}): { markup: string; errors: string[]; tree: SvgTree; rt: Runtime } {
  const doc = parseWidget(source);
  expect(doc.problems).toEqual([]);
  const values = { ...restoreState(doc, null).values, ...override };
  const rt = createRuntime();
  const env = createRootEnv(doc, values, rt, { get: (name) => values[name], set: () => {}, copy: () => {} });
  const node = findSvg(doc.nodes)!;
  const { props } = resolveProps(node, env, rt);
  const drawn = renderSvg(node, { viewBox: String(props.viewBox), width: props.width as number | undefined }, env, rt, ns);
  return { markup: svgMarkup(drawn.tree), errors: drawn.errors, tree: drawn.tree, rt };
}

const GAUGE = `{@state pct = 60}
{@const a = Math.PI * (1 - pct / 100)}

<slider label="Progress" value={pct} onChange={setPct} suffix="%" />
<svg viewBox="0 0 200 110" label="Progress">
  <defs>
    <linearGradient id="arc" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="success" />
      <stop offset="100%" stop-color="#E11D48" />
    </linearGradient>
    <clipPath id="top"><rect x="0" y="0" width="200" height="100" /></clipPath>
  </defs>
  <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="url(#arc)" stroke-width="14" clip-path="url(#top)" />
  <line x1="100" y1="100" x2={100 + 70 * Math.cos(a)} y2={100 - 70 * Math.sin(a)} stroke={pct > 80 ? "danger" : "accent"} stroke-width="4" stroke-linecap="round" />
  {#each [0, 50, 100] as tick, i}
    <text x={20 + i * 80} y="108" font-size="9" text-anchor="middle" fill="muted">{tick}</text>
  {/each}
  <text x="100" y="90" text-anchor="middle" font-size="20" font-weight="bold">{pct}%</text>
</svg>`;

describe("parser: the inside of an <svg> is its own mode", () => {
  it("marks <svg> and everything under it, blocks included, and leaves the mode at </svg>", () => {
    const doc = parseWidget(`{@state xs = [1, 2]}\n<svg ${BOX}>\n  <g>{#each xs as x}{#if x > 1}<circle r={x} />{/if}{/each}</g>\n</svg>\n<slider label="a" value={1} onChange={(v) => v}>\n<text>after</text>`);
    expect(doc.problems).toEqual([]);
    const root = doc.nodes.find((n): n is ElNode => n.t === "el" && n.name === "svg")!;
    expect(root.svg).toBe(true);
    const flags: [string, boolean][] = [];
    const walk = (nodes: TNode[]) => {
      for (const n of nodes) {
        if (n.t === "el") {
          flags.push([n.name, n.svg === true]);
          walk(n.children);
        } else if (n.t === "each") walk(n.children);
        else if (n.t === "if") for (const b of n.branches) walk(b.children);
      }
    };
    walk(doc.nodes);
    expect(flags).toEqual([
      ["svg", true],
      ["g", true],
      ["circle", true],
      // back in component mode: <slider> closes itself, <text> is the widget's paragraph
      ["slider", false],
      ["text", false],
    ]);
  });

  it("an SVG element is never implicitly self-closing, even when a component of that name is", () => {
    // <image> the COMPONENT takes no children and closes itself; inside <svg> it is just an element that must be closed as written.
    const doc = parseWidget(svg("<image><rect /></image>"));
    expect(doc.problems).toEqual([]);
    const image = (doc.nodes[0] as ElNode).children[0] as ElNode;
    expect(image.name).toBe("image");
    expect(image.children.map((c) => (c.t === "el" ? c.name : c.t))).toEqual(["rect"]);
    // An unclosed shape is reported with the XML fix, not swallowed.
    const open = parseWidget(svg('<circle r="1">'));
    expect(open.problems.map((p) => p.message).join("\n")).toMatch(/<circle> is not closed before "<\/svg>"\. End the tag with "\/>" \(no children\) or add <\/circle> first\./);
  });

  it("text is literal: a backtick is a character, and {expr} still interpolates", () => {
    const doc = parseWidget("{@state v = 3}\n" + svg("<text>`{v}` \\{literal\\}</text>"));
    expect(doc.problems).toEqual([]);
    const text = ((doc.nodes.find((n) => n.t === "el") as ElNode).children[0] as ElNode).children;
    expect(text.map((n) => n.t)).toEqual(["text", "expr", "text"]);
    expect(draw("{@state v = 3}\n" + svg("<text>`{v}` \\{literal\\}</text>")).markup).toContain("<text>`3` {literal}</text>");
  });

  it("deep nesting is a clean error (the same cap as components), never a throw", () => {
    const deep = `<svg ${BOX}>` + "<g>".repeat(MAX_TEMPLATE_NESTING + 5) + "</g>".repeat(MAX_TEMPLATE_NESTING + 5) + "</svg>";
    expect(errorOf(deep)).toMatch(/Tags and blocks are nested too deeply \(limit 32 levels\)\. Flatten the layout\./);
    const blocks = `<svg ${BOX}>` + "{#if true}".repeat(40) + "<rect />" + "{/if}".repeat(40) + "</svg>";
    expect(errorOf(blocks)).toMatch(/nested too deeply/);
    expect(() => checkWidget(`<svg ${BOX}>` + "<g>".repeat(6000))).not.toThrow();
  });
});

describe("checkWidget: <svg> elements are an allowlist", () => {
  it("accepts a drawing bound to state", () => {
    expect(checkWidget(GAUGE)).toEqual({ ok: true, submits: false });
    ok(svg("")); // an empty drawing is still a component
    ok(
      svg(`<title>무엇을 그렸는지</title><desc>설명</desc>
<defs>
  <radialGradient id="r" cx="50%" cy="50%" r="50%" fx="0.3" fy="0.3" gradientUnits="objectBoundingBox" spreadMethod="pad"><stop offset="0.2" stop-color="accent" stop-opacity="0.5" /></radialGradient>
  <mask id="m" x="0" y="0" width="100" height="100" maskUnits="userSpaceOnUse"><rect width="100" height="100" fill="url(#r)" /></mask>
  <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto-start-reverse" markerUnits="strokeWidth" viewBox="0 0 6 6"><path d="M0 0L6 3L0 6z" /></marker>
  <pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="line" /></pattern>
</defs>
<g transform="translate(10 10) scale(0.9)" opacity="0.9" mask="url(#m)">
  <rect x="0" y="0" width="80" height="50%" rx="4" ry="4" fill="url(#hatch)" stroke="rgb(10 20 30 / 0.5)" stroke-dasharray="4 2" vector-effect="non-scaling-stroke" />
  <circle cx="20" cy="20" r="1e1" fill="hsl(210deg 50% 40%)" fill-opacity=".5"><title>툴팁</title></circle>
  <ellipse cx="50" cy="50" rx="10" ry="5" fill="transparent" stroke="currentColor" />
  <polyline points="0,0 10,5 20,0" fill="none" stroke="#abc" marker-end="url(#arrow)" />
  <polygon points="0 0 10 5 20 0" fill-rule="evenodd" visibility="hidden" />
  <text x="5" y="5" dy="0.35em" text-anchor="end" dominant-baseline="middle" font-size="12px" font-weight="600" font-style="italic">가<tspan dx="2" fill="danger">나</tspan></text>
</g>`),
    );
  });

  it.each([
    ["script", "<script>alert(1)</script>", /<script> is not allowed inside <svg>: scripts never run in a widget/],
    ["style", "<style>* { fill: red }</style>", /<style> is not allowed inside <svg>: stylesheets are not supported — set fill, stroke, font-size … as attributes/],
    ["foreignObject", '<foreignObject width="10" height="10"><div>x</div></foreignObject>', /<foreignObject> is not allowed inside <svg>: HTML cannot be embedded in a drawing/],
    ["image", '<image href="https://evil.example/x.png" />', /<image> is not allowed inside <svg>: images cannot be embedded in a drawing — use the widget's <image> component next to it/],
    ["use", '<use href="#a" />', /<use> is not allowed inside <svg>: <use> is not supported — repeat shapes with \{#each\} instead/],
    ["a", '<a href="https://evil.example"><rect /></a>', /<a> is not allowed inside <svg>: links are not available inside a drawing/],
    ["animate", '<rect><animate attributeName="x" to="9" dur="1s" /></rect>', /<animate> is not allowed inside <svg>: animation elements are not supported/],
    ["animateTransform", '<animateTransform attributeName="transform" />', /<animateTransform> is not allowed inside <svg>: animation elements are not supported/],
    ["animateMotion", "<animateMotion />", /<animateMotion> is not allowed inside <svg>: animation elements are not supported/],
    ["set", '<set attributeName="x" to="1" />', /<set> is not allowed inside <svg>: animation elements are not supported/],
    ["filter", '<filter id="f"><feGaussianBlur stdDeviation="100" /></filter>', /<filter> is not allowed inside <svg>: filters are not supported/],
    ["feGaussianBlur", '<feGaussianBlur stdDeviation="100" />', /<feGaussianBlur> is not allowed inside <svg>: filters are not supported/],
    ["nested svg", `<svg ${BOX}><rect /></svg>`, /<svg> is not allowed inside <svg>: a nested <svg> is not supported — group with <g transform="…"> instead/],
    ["symbol", '<symbol id="s"><rect /></symbol>', /<symbol> is not allowed inside <svg>/],
    ["textPath", "<text><textPath>x</textPath></text>", /<textPath> is not allowed inside <svg>: text on a path is not supported/],
    ["switch", "<switch><rect /></switch>", /<switch> is not allowed inside <svg>/],
    ["iframe", '<iframe src="https://evil.example"></iframe>', /<iframe> is not an SVG element a widget can draw\./],
    ["a component", '<button send="hi">x</button>', /<button> is not an SVG element a widget can draw\./],
    ["a near miss", '<circl r="3" />', /<circl> is not an SVG element a widget can draw\. Did you mean <circle>\? Allowed inside <svg>: g, defs, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, title, desc, linearGradient, radialGradient, stop, clipPath, mask, marker, pattern\./],
    ["an Object member", "<constructor />", /<constructor> is not an SVG element a widget can draw\./],
  ])("refuses <%s>", (_name, inner, message) => {
    expect(errorOf(svg(inner))).toMatch(message);
  });

  it("names the line and column of the refused element, and still reports mistakes inside it", () => {
    const err = errorOf(`{@state n = 1}\n<svg ${BOX}>\n  <script x={missing}>\n    <rect width="wide" />\n  </script>\n</svg>`);
    expect(err).toMatch(/\n1\. line 3:3 — <script> is not allowed inside <svg>/);
    expect(err).toMatch(/line 3:11 — "missing" is not defined/);
    expect(err).toMatch(/line 4:11 — Attribute "width" of <rect> must be a number, optionally with px, % or em/);
  });

  it.each([
    ["style", '<rect style="fill:red" />', /<rect> inside <svg> has no attribute "style"\. There is no style\/class: set fill, stroke, opacity, font-size … as attributes\. Attributes: id, fill, stroke, /],
    ["class", '<rect class="btn btn-primary" />', /has no attribute "class"\. There is no style\/class/],
    ["onclick", '<rect onclick="alert(1)" />', /has no attribute "onclick"\. A drawing has no events/],
    ["onLoad", "<g onLoad={() => 1} />", /has no attribute "onLoad"\. A drawing has no events/],
    ["href", '<rect href="#a" />', /has no attribute "href"\. A drawing cannot link or load anything/],
    ["src", '<rect src="https://evil.example/a" />', /has no attribute "src"\. A drawing cannot link or load anything/],
    ["xmlns", '<g xmlns="http://www.w3.org/2000/svg" />', /has no attribute "xmlns"\. It is not needed — remove it\./],
    ["marker-mid", '<path d="M0 0" marker-mid="url(#m)" />', /has no attribute "marker-mid"\. Only marker-start and marker-end exist\./],
    ["font-family", '<text font-family="Comic Sans MS">x</text>', /has no attribute "font-family"\. Text uses the app's font\./],
    ["filter", '<rect filter="url(#f)" />', /<rect> inside <svg> has no attribute "filter"\./],
    ["tabindex", '<rect tabindex="0" />', /has no attribute "tabindex"\./],
    ["data-*", '<rect data-x="1" />', /has no attribute "data-x"\./],
    ["a near miss", '<rect strok="accent" />', /has no attribute "strok"\. Did you mean "stroke"\?/],
    ["another element's attribute", '<circle width="3" />', /<circle> inside <svg> has no attribute "width"\./],
    ["a marker on a shape that has no ends", '<rect marker-end="url(#m)" />', /<rect> inside <svg> has no attribute "marker-end"\./],
    ["an attribute on <defs>", '<defs id="d" />', /<defs> inside <svg> has no attribute "id"\..* Attributes: \(none\)\./],
  ])("refuses the attribute %s", (_name, inner, message) => {
    expect(errorOf(svg(inner))).toMatch(message);
  });

  it("xlink:href does not even parse as an attribute, and a duplicate attribute is reported", () => {
    expect(errorOf(svg('<rect xlink:href="#a" />'))).toMatch(/has no attribute "xlink"|Unexpected ":"/);
    expect(errorOf(svg('<rect x="1" x="2" />'))).toMatch(/Attribute "x" is given twice on <rect>\./);
  });

  it("the root takes only viewBox, width and label", () => {
    expect(errorOf('<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"></svg>')).toMatch(/<svg> has no prop "xmlns"\. It is not needed — remove it\. Props: viewBox, width, label\./);
    expect(errorOf('<svg viewBox="0 0 10 10" height="40"></svg>')).toMatch(/<svg> has no prop "height"\. The height follows the viewBox's aspect ratio\./);
    expect(errorOf('<svg viewBox="0 0 10 10" style="position:fixed"></svg>')).toMatch(/<svg> has no prop "style"\. Styling props are not supported/);
    expect(errorOf('<svg viewBox="0 0 10 10" onload="alert(1)"></svg>')).toMatch(/<svg> has no prop "onload"/);
    expect(errorOf("<svg></svg>")).toMatch(/<svg> is missing the required prop "viewBox" \("minX minY width height"\)\./);
    for (const bad of ["0 0 0 10", "0 0 10 -1", "a b c d", "0 0 10", "0 0 10 10 10", "0,0,1e9,10", ""]) {
      expect(errorOf(`<svg viewBox="${bad}"></svg>`), bad).toMatch(/Prop "viewBox" of <svg> (must be four numbers "minX minY width height" with a positive width and height, e\.g\. "0 0 200 120"|is empty)\./);
    }
    expect(errorOf("<svg viewBox={[0, 0, 1, 1]}></svg>")).toMatch(/Prop "viewBox" of <svg> must be a string\./);
    expect(errorOf('<svg viewBox="0 0 10 10" width="100%"></svg>')).toMatch(/Prop "width" of <svg> must be a number — write it in braces/);
  });

  it("an SVG element lives only inside an <svg>, and a component only outside one", () => {
    expect(errorOf('<path d="M0 0" />')).toMatch(/<path> is an SVG element: it exists only inside <svg viewBox="…">…<\/svg>\. Wrap the drawing in an <svg>\./);
    expect(errorOf(svg('<slider label="a" value={1} onChange={(v) => v} />'))).toMatch(/<slider> is not an SVG element a widget can draw\./);
    // <text> inside an inline component is refused by the component's own rule
    expect(errorOf(`<text>a <svg ${BOX}></svg></text>`)).toMatch(/<text> takes text, \{expr\} and <link> only, but contains <svg>/);
  });

  it("what may sit inside what", () => {
    expect(errorOf(svg("<rect><circle r=\"1\" /></rect>"))).toMatch(/<circle> cannot be a child of <rect>\. <rect> takes <title>, <desc>\./);
    expect(errorOf(svg('<stop offset="0" />'))).toMatch(/<stop> cannot be a child of <svg>\./);
    expect(errorOf(svg('<linearGradient id="g"><rect /></linearGradient>'))).toMatch(/<rect> cannot be a child of <linearGradient>\. <linearGradient> takes <stop>\./);
    expect(errorOf(svg("<text><g /></text>"))).toMatch(/<g> cannot be a child of <text>\. <text> takes <tspan>, <title>, <desc> and text\./);
    expect(errorOf(svg('<clipPath id="c"><g><rect /></g></clipPath>'))).toMatch(/<g> cannot be a child of <clipPath>\./);
    expect(errorOf(svg("<tspan>x</tspan>"))).toMatch(/<tspan> cannot be a child of <svg>\./);
    // text and {expr} belong in <text>
    expect(errorOf(svg("<g>label</g>"))).toMatch(/Text directly inside <g> is not drawn\. Put it in a <text x="…" y="…"> element\./);
    expect(errorOf(svg("hello"))).toMatch(/Text directly inside <svg> is not drawn/);
    expect(errorOf("{@state n = 1}\n" + svg("<rect>{n}</rect>"))).toMatch(/\{…\} directly inside <rect> is not drawn\. Put it in a <text> element, or bind it to an attribute \(r=\{…\}\)\./);
  });

  it("expressions inside a drawing are checked like any other", () => {
    expect(errorOf(svg("<rect x={nope} />"))).toMatch(/"nope" is not defined/);
    expect(errorOf("{@state n = 1}\n" + svg("<rect x={setN(2)} />"))).toMatch(/setN\(…\) is called while rendering/);
    expect(errorOf(svg("<text>{nope}</text>"))).toMatch(/"nope" is not defined/);
    expect(errorOf(svg("<g>{#each nope as x}<rect />{/each}</g>"))).toMatch(/"nope" is not defined/);
    expect(errorOf(svg("<rect x={() => 1} />"))).toMatch(/Attribute "x" of <rect> must be a string or a number, not a function\./);
    expect(errorOf(svg("<rect x={[1]} />"))).toMatch(/must be a string or a number, not an array\./);
    expect(errorOf(svg("<rect x={{ a: 1 }} />"))).toMatch(/must be a string or a number, not an object\./);
    expect(errorOf(svg("<rect x />"))).toMatch(/Attribute "x" of <rect> needs a value\./);
    // {@state} stays a top-level declaration
    expect(errorOf(svg("{@state n = 1}<rect />"))).toMatch(/\{@state\} must be declared at the top level/);
    // a {@const} inside the drawing is visible to its siblings
    ok(svg("{@const r = 4}<circle r={r} /><g>{@const k = r * 2}<circle r={k} /></g>"));
  });

  it("a static drawing over the element cap is refused", () => {
    const many = svg('<rect x="1" />'.repeat(MAX_SVG_NODES + 1));
    expect(errorOf(many)).toMatch(new RegExp(`This <svg> has too many elements \\(${MAX_SVG_NODES + 1}; limit ${MAX_SVG_NODES}\\)\\. Draw fewer shapes`));
    ok(svg('<rect x="1" />'.repeat(MAX_SVG_NODES)));
  });
});

describe("attribute values are validated by SHAPE and rebuilt", () => {
  it.each<[string, string, unknown, string]>([
    ["a number", "len", "12", "12"],
    ["a number from an expression", "len", 12.3456789, "12.3457"],
    ["an exponent is expanded", "len", "1e2", "100"],
    ["negative zero", "len", -0, "0"],
    ["percent", "len", " 50% ", "50%"],
    ["em", "len", "0.35em", "0.35em"],
    ["px", "len", "+4px", "4px"],
    ["opacity", "unit", ".5", "0.5"],
    ["offset percent", "offset", "100%", "100%"],
    ["a token", "paint", "accent", "var(--accent)"],
    ["a soft token", "paint", "danger-soft", "var(--danger-soft)"],
    ["hex is lower-cased", "paint", "#E11D48", "#e11d48"],
    ["hex with alpha", "paint", "#abcd", "#abcd"],
    ["rgb with commas is re-assembled", "paint", "RGB(1, 2,3)", "rgb(1 2 3)"],
    ["rgba", "paint", "rgba(1 2 3 / 50%)", "rgb(1 2 3 / 50%)"],
    ["hsl", "paint", "hsl(120deg 50% 50%)", "hsl(120deg 50% 50%)"],
    ["currentColor", "paint", "CURRENTCOLOR", "currentColor"],
    ["none", "paint", "None", "none"],
    ["dashes", "dash", "4, 2", "4 2"],
    ["points", "points", "0,0 10,5\n20,0", "0 0 10 5 20 0"],
    ["a path", "path", "M10 10 L 90,10 a5 5 0 0 1 1e1 -1.5z", "M10 10 L 90,10 a5 5 0 0 1 1e1 -1.5z"],
    ["transforms", "transform", "rotate(45, 50 50)  translate(10)", "rotate(45 50 50) translate(10)"],
    ["a matrix", "transform", "matrix(1 0 0 1 10 20)", "matrix(1 0 0 1 10 20)"],
    ["viewBox", "viewBox", "0,0 200  110", "0 0 200 110"],
    ["orient", "orient", "auto-start-reverse", "auto-start-reverse"],
  ])("accepts %s", (_name, kind, raw, value) => {
    expect(svgAttrValue(kind as never, raw)).toEqual({ ok: true, value });
  });

  it("an id and a url(#id) come back as the BARE id, for the renderer to namespace", () => {
    expect(svgAttrValue("id", "arc-1_b")).toEqual({ ok: true, value: "", id: "arc-1_b" });
    expect(svgAttrValue("paint", "url( #arc )")).toEqual({ ok: true, value: "", ref: "arc" });
    expect(svgAttrValue("ref", "url(#clip)")).toEqual({ ok: true, value: "", ref: "clip" });
    expect(svgAttrValue("ref", "none")).toEqual({ ok: true, value: "none" });
  });

  // Each of these is refused statically (a literal) AND when it is the value of an expression.
  const HOSTILE: [string, string, string][] = [
    // colours and paint servers
    ["fill", "red", "a CSS colour name"],
    ["fill", "url(https://evil.example/x.svg#a)", "a remote paint server"],
    ["fill", "url(//evil.example/x.svg#a)", "a protocol-relative url()"],
    ["fill", "url(data:image/svg+xml,%3Csvg/%3E#a)", "a data: url()"],
    ["fill", "url('#a')", "a quoted url()"],
    ["fill", "url(#a) red", "a paint with a fallback"],
    ["fill", "url(#a);background:url(https://evil.example)", "a declaration smuggled after a url()"],
    ["fill", "URL(#a", "an unclosed url("],
    ["fill", "javascript:alert(1)", "a javascript: URL"],
    ["fill", "var(--accent)", "a raw var()"],
    ["fill", "expression(alert(1))", "an IE expression()"],
    ["fill", "image-set(url(https://evil.example/a) 1x)", "an image-set()"],
    ["fill", "rgb(1, 2)", "a short rgb()"],
    ["fill", "rgb(calc(1 + 1) 2 3)", "calc() inside rgb()"],
    ["fill", "rgb(var(--x) 2 3)", "var() inside rgb()"],
    ["fill", "#12", "a short hex"],
    ["fill", "#ggg", "a non-hex"],
    // CSS escapes and backslashes
    ["fill", "\\75rl(#a)", "a CSS-escaped url"],
    ["fill", "u\\rl(#a)", "a backslash inside url"],
    ["fill", "url(#a\\)", "an escaped parenthesis"],
    ["fill", "#fff\\9", "a backslash after a hex"],
    ["stroke", "\\red", "an escaped keyword"],
    ["stop-color", "url(#a)", "a url() where only a colour fits"],
    // references
    ["clip-path", "url(https://evil.example/c.svg#c)", "a remote clip path"],
    ["clip-path", "inset(10%)", "a CSS shape function"],
    ["mask", "url(evil.svg#m)", "a relative mask URL"],
    ["marker-end", "url(#a) url(#b)", "two references"],
    // numbers and lengths
    ["x", "12abc", "a number with junk"],
    ["x", "calc(1px + 2px)", "calc()"],
    ["x", "100vw", "a viewport unit"],
    ["x", "1;2", "two values"],
    ["x", "1e999", "an infinite number"],
    ["x", "9999999", "a coordinate out of range"],
    ["width", "auto", "a keyword length"],
    ["opacity", "2", "an opacity over 1"],
    ["fill-opacity", "-0.1", "a negative opacity"],
    ["stroke-miterlimit", "4px", "a unit on a bare number"],
    ["stroke-dasharray", "0.001", "a dash pattern shorter than one unit"],
    ["stroke-dasharray", "1 -2", "a negative dash"],
    ["stroke-dasharray", "1 2 3 4 5 6 7 8 9 10 11 12 13", "too many dashes"],
    // enums
    ["stroke-linecap", "circle", "an unknown line cap"],
    ["fill-rule", "NONZERO", "a wrongly cased keyword"],
    ["visibility", "collapse; x", "a keyword with a tail"],
    // transforms
    ["transform", "rotate(45deg)", "a unit in a transform"],
    ["transform", "translate(1 2) url(#x)", "a non-transform function"],
    ["transform", "matrix(1 2 3)", "a matrix with too few numbers"],
    ["transform", "perspective(10)", "an unknown transform"],
    ["transform", "rotate(1) ".repeat(9).trim(), "too many transforms"],
    ["transform", "rotate(1 2)", "a wrong argument count"],
    ["transform", "rotate(", "an unfinished transform"],
    // ids
    ["id", "1a", "an id that starts with a digit"],
    ["id", "a b", "an id with a space"],
    ["id", 'a" onload="alert(1)', "an id that tries to close the attribute"],
    ["id", "a".repeat(41), "an id that is too long"],
    ["id", "a#b", "an id with a hash"],
  ];

  it.each(HOSTILE)("refuses %s=%j (%s)", (attr, value, _why) => {
    const tag = attr === "stop-color" ? "stop" : attr === "marker-end" ? "line" : "rect";
    const wrap = (inner: string) => (tag === "stop" ? svg(`<linearGradient id="g">${inner}</linearGradient>`) : svg(inner));
    // 1. the static check, on a quoted string and on a string literal in braces
    expect(errorOf(wrap(`<${tag} ${attr}="${value.replace(/"/g, "&quot;")}" />`))).toMatch(new RegExp(`Attribute "${attr}" of <${tag}> `));
    expect(errorOf(wrap(`<${tag} ${attr}={${JSON.stringify(value)}} />`))).toMatch(new RegExp(`Attribute "${attr}" of <${tag}> `));
    // 2. the renderer, on the same value computed at run time: the attribute is left out and reported
    const drawn = draw(`{@state evil = ${JSON.stringify(value)}}\n` + wrap(`<${tag} ${attr}={evil} />`));
    expect(drawn.errors.join("\n")).toContain(`<${tag}> ${attr} `);
    expect(drawn.markup).toMatch(new RegExp(`<${tag}/>`));
    expect(drawn.markup).not.toContain("evil");
  });

  it("path data and point lists are a character class with a length cap", () => {
    expect(errorOf(svg('<path d="L 0 0" />'))).toMatch(/Attribute "d" of <path> must be path data: commands M L H V C S Q T A Z with numbers, starting with M/);
    expect(errorOf(svg('<path d="M0 0 url(#x)" />'))).toMatch(/must be path data/);
    expect(errorOf(svg('<path d="M0 0;fill:red" />'))).toMatch(/must be path data/);
    expect(errorOf(svg(`<path d="M${" 1 1".repeat(MAX_SVG_PATH_CHARS / 4)}" />`))).toMatch(new RegExp(`Attribute "d" of <path> is too long \\(limit ${MAX_SVG_PATH_CHARS} chars\\)`));
    expect(errorOf(svg('<polyline points="0,0 10" />'))).toMatch(/Attribute "points" of <polyline> must be x,y number pairs/);
    expect(errorOf(svg('<polyline points="0,0 a,b" />'))).toMatch(/must be x,y number pairs/);
    ok(svg(`<path d="M${" 1 1".repeat(900)}" />`));
  });

  it("never throws and stays linear on long or odd values", () => {
    const odd: unknown[] = [null, undefined, true, false, {}, [], () => 1, NaN, Infinity, -Infinity, 1e300, Symbol.iterator, "", " ", "\u0000", "a".repeat(100_000), "(".repeat(50_000), "rotate(".repeat(20_000), "1 ".repeat(50_000)];
    const kinds = ["len", "num", "unit", "offset", "paint", "color", "dash", "points", "path", "transform", "id", "ref", "viewBox", "orient", ["a", "b"]] as const;
    const t0 = Date.now();
    for (const kind of kinds) for (const value of odd) expect(svgAttrValue(kind as never, value).ok, `${String(kind)} ${String(value).slice(0, 12)}`).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("every attribute's kind is one the validator knows, and no element takes a free-form or linking attribute", () => {
    expect(SVG_TAGS).toEqual(["g", "defs", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "marker", "pattern"]);
    const kinds = new Set(["len", "num", "unit", "offset", "paint", "color", "dash", "points", "path", "transform", "id", "ref", "viewBox", "orient"]);
    for (const tag of SVG_TAGS) {
      for (const [name, kind] of Object.entries(SVG_ELEMENTS[tag].attrs)) {
        expect(typeof kind === "string" ? kinds.has(kind) : Array.isArray(kind), `${tag}.${name}`).toBe(true);
        expect(name, `${tag}.${name}`).not.toMatch(/^(style|class|href|src|xmlns|filter|font-family|marker-mid|on.*)$/i);
      }
    }
    // not reachable through Object.prototype
    expect(SVG_ELEMENTS["constructor"]).toBe(undefined);
    expect(SVG_PAINT_TOKENS).toEqual(["default", "muted", "accent", "success", "warning", "danger", "info", "surface", "subtle", "line", "accent-soft", "success-soft", "warning-soft", "danger-soft", "info-soft"]);
    expect(svgReference()).toContain(`elements: ${SVG_TAGS.join(" ")}`);
    expect(svgReference()).toContain(`≤ ${MAX_SVG_NODES} elements, path d ≤ ${MAX_SVG_PATH_CHARS} chars`);
  });
});

describe("references stay inside the drawing", () => {
  it("a literal url(#id) must name an element of the same <svg>, of a kind the attribute takes", () => {
    expect(errorOf(svg('<rect fill="url(#nope)" />'))).toMatch(/fill="url\(#nope\)": this drawing has no element with id="nope"\. Define it \(usually inside <defs>\) in the SAME <svg>\./);
    expect(errorOf(svg('<clipPath id="c"><rect /></clipPath><rect fill="url(#c)" />'))).toMatch(/fill="url\(#c\)" points at a <clipPath>; fill can reference only <linearGradient> or <radialGradient> or <pattern>\./);
    expect(errorOf(svg('<linearGradient id="g" /><rect clip-path="url(#g)" />'))).toMatch(/clip-path="url\(#g\)" points at a <linearGradient>; clip-path can reference only <clipPath>\./);
    expect(errorOf(svg('<rect id="r" /><line marker-end="url(#r)" />'))).toMatch(/marker-end="url\(#r\)" points at a <rect>; marker-end can reference only <marker>\./);
    // another drawing's id is not this drawing's
    expect(errorOf(`<svg ${BOX}><linearGradient id="g" /></svg>\n<svg ${BOX}><rect fill="url(#g)" /></svg>`)).toMatch(/this drawing has no element with id="g"/);
    expect(errorOf(svg('<rect id="a" /><circle id="a" />'))).toMatch(/id="a" is used more than once in this <svg>\. Ids must be unique\./);
    // a computed id may be the target: left to the renderer
    ok("{@state k = 1}\n" + svg('<linearGradient id={`g${k}`} /><rect fill="url(#g1)" />'));
  });

  it("a resource cannot use another resource (nested references would multiply the work)", () => {
    const inside = (attr: string) => svg(`<clipPath id="c"><rect /></clipPath><mask id="m"><rect ${attr} /></mask>`);
    for (const attr of ['clip-path="url(#c)"', 'mask="url(#m)"']) {
      expect(errorOf(inside(attr))).toMatch(/cannot be used inside a <clipPath>, <mask>, <marker> or <pattern> \(a resource may not use another one\)/);
    }
    expect(errorOf(svg('<marker id="k"><path d="M0 0" /></marker><pattern id="p"><line marker-end="url(#k)" /></pattern>'))).toMatch(/"marker-end" cannot be used inside a <clipPath>, <mask>, <marker> or <pattern>/);
    expect(errorOf(svg('<pattern id="a"><rect /></pattern><pattern id="b"><rect fill="url(#a)" /></pattern>'))).toMatch(
      /fill="url\(#a\)" inside a <clipPath>, <mask>, <marker> or <pattern> may reference only a gradient, not a <pattern> \(resources cannot be nested\)\./,
    );
    expect(errorOf(svg('<mask id="m"><g><mask id="n"><rect /></mask></g></mask>'))).toMatch(/<mask> cannot be defined inside another <clipPath>, <mask>, <marker> or <pattern>\. Move it to the <svg>'s <defs>\./);
    expect(errorOf(svg('<pattern id="p"><g><linearGradient id="g" /></g></pattern>'))).toMatch(/<linearGradient> cannot be defined inside another/);
    // a gradient inside a resource is the one thing that IS allowed
    ok(svg('<linearGradient id="g"><stop offset="0" stop-color="accent" /></linearGradient><mask id="m"><rect fill="url(#g)" /></mask><rect mask="url(#m)" />'));
  });
});

describe("renderSvg: the evaluated drawing", () => {
  it("draws the gauge and redraws it from new state", () => {
    const at60 = draw(GAUGE);
    expect(at60.errors).toEqual([]);
    expect(at60.markup).toBe(
      '<svg viewBox="0 0 200 110" width="200" fill="currentColor">' +
        '<defs><linearGradient id="wg1-arc" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--ok)"/><stop offset="100%" stop-color="#e11d48"/></linearGradient>' +
        '<clipPath id="wg1-top"><rect x="0" y="0" width="200" height="100"/></clipPath></defs>' +
        '<path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="url(#wg1-arc)" stroke-width="14" clip-path="url(#wg1-top)"/>' +
        '<line x1="100" y1="100" x2="121.6312" y2="33.426" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"/>' +
        '<text x="20" y="108" font-size="9" text-anchor="middle" fill="var(--muted)">0</text>' +
        '<text x="100" y="108" font-size="9" text-anchor="middle" fill="var(--muted)">50</text>' +
        '<text x="180" y="108" font-size="9" text-anchor="middle" fill="var(--muted)">100</text>' +
        '<text x="100" y="90" text-anchor="middle" font-size="20" font-weight="bold">60%</text></svg>',
    );
    const at90 = draw(GAUGE, "wg1", { pct: 90 });
    expect(at90.markup).toContain('x2="166.574" y2="78.3688" stroke="var(--danger)"');
    expect(at90.markup).toContain(">90%</text>");
  });

  it("namespaces every id and rewrites every url(#id) the same way: two instances cannot collide", () => {
    const a = draw(GAUGE, "wg1/12");
    const b = draw(GAUGE, "wg2/12");
    const ids = (markup: string) => [...markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    const refs = (markup: string) => [...markup.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(ids(a.markup)).toEqual(["wg1_12-arc", "wg1_12-top"]);
    expect(ids(b.markup)).toEqual(["wg2_12-arc", "wg2_12-top"]);
    // every reference points at an id of ITS OWN drawing, never at the other one's
    expect(refs(a.markup).sort()).toEqual(ids(a.markup).sort());
    expect(refs(b.markup).sort()).toEqual(ids(b.markup).sort());
    for (const id of ids(a.markup)) expect(b.markup).not.toContain(id);
    // the namespace itself can only be letters, digits, - and _ (it is derived from a node key)
    expect(draw(svg('<linearGradient id="g" /><rect fill="url(#g)" />'), '"><script>#/?').markup).toContain('id="w___script____-g"');
    expect(draw(svg('<linearGradient id="g" />'), "").markup).toContain('id="w-g"');
    // a long key is cut, and still unique: two keys that share their first 64 characters differ
    const long = "wg1" + "/123#4".repeat(30);
    const idOf = (ns: string) => / id="([^"]+)"/.exec(draw(svg('<linearGradient id="g" />'), ns).markup)![1];
    expect(idOf(`${long}/1`)).toMatch(/^wg1_123_4[0-9_]{55}_[0-9a-z]+-g$/);
    expect(idOf(`${long}/1`)).not.toBe(idOf(`${long}/2`));
    expect(idOf(`${long}/1`)).toBe(idOf(`${long}/1`));
    expect(idOf(`${long}/1`).length).toBeLessThan(80);
  });

  it("the root is rebuilt: viewBox, a clamped pixel width, and the text colour as the default fill", () => {
    expect(draw('<svg viewBox="0,0 2000 100"></svg>').markup).toBe('<svg viewBox="0 0 2000 100" width="800" fill="currentColor"/>');
    expect(draw('<svg viewBox="0 0 4 4"></svg>').markup).toBe('<svg viewBox="0 0 4 4" width="16" fill="currentColor"/>');
    expect(draw('<svg viewBox="0 0 100 50" width={320}></svg>').markup).toBe('<svg viewBox="0 0 100 50" width="320" fill="currentColor"/>');
    // a very tall viewBox is drawn narrower, so its height stays under 1,200 px (and never under 16 px wide)
    expect(draw('<svg viewBox="0 0 100 400" width={800}></svg>').markup).toBe('<svg viewBox="0 0 100 400" width="300" fill="currentColor"/>');
    expect(draw('<svg viewBox="0 0 1 1000000"></svg>').markup).toBe('<svg viewBox="0 0 1 1000000" width="16" fill="currentColor"/>');
  });

  it("an element the checker would refuse is not drawn — nor is anything inside it evaluated", () => {
    const drawn = draw(`{@state n = 1}\n<svg ${BOX}>\n<script>alert(1)</script>\n<a href="javascript:alert(1)"><rect x={boom()} /></a>\n<foreignObject><div>x</div></foreignObject>\n<image href="https://evil.example/a.png" />\n<use href="#a" />\n<animate attributeName="x" />\n<circle r="2" />\n</svg>`);
    expect(drawn.markup).toBe('<svg viewBox="0 0 100 100" width="100" fill="currentColor"><circle r="2"/></svg>');
    expect(drawn.errors.join("\n")).toMatch(/<script> is not allowed inside <svg>/);
    expect(drawn.errors.join("\n")).toMatch(/<a> is not allowed inside <svg>/);
    // `boom()` was never called: there is no evaluation error about it
    expect(drawn.errors.join("\n")).not.toMatch(/boom/);
    for (const gone of ["script", "alert", "href", "evil", "foreignObject", "<image", "<use", "animate"]) expect(drawn.markup).not.toContain(gone);
  });

  it("an attribute outside the element's list is left out, whatever it evaluates to", () => {
    const drawn = draw(`{@state css = "position:fixed;inset:0"}\n` + svg('<rect style={css} class="btn" onclick="alert(1)" href="#x" xmlns="x" x="1" />'));
    expect(drawn.markup).toBe('<svg viewBox="0 0 100 100" width="100" fill="currentColor"><rect x="1"/></svg>');
    expect(drawn.errors.join("\n")).toMatch(/has no attribute "style"/);
  });

  it("a computed value is validated like a literal one; an empty one just leaves the attribute out", () => {
    const drawn = draw(
      `{@state on = false}\n{@state bad = 0 / 0}\n` +
        svg('<rect x={bad} y={1 / 0} width={{ a: 1 }} height={[1]} rx={() => 1} fill={on ? "danger" : null} stroke={undefined} opacity={on && 0.5} ry={"4"} />'),
    );
    expect(drawn.markup).toContain('<rect ry="4"/>');
    expect(drawn.errors).toEqual([
      "<rect> x is not a finite number (NaN or Infinity)",
      "<rect> y is not a finite number (NaN or Infinity)",
      "<rect> width must be a string or a number",
      "<rect> height must be a string or a number",
      "<rect> rx must be a string or a number",
    ]);
  });

  it("an expression that throws drops only its attribute", () => {
    const drawn = draw(svg('<rect x={nope.deep} y="2" />'));
    expect(drawn.markup).toContain('<rect y="2"/>');
    expect(drawn.errors.join("\n")).toMatch(/^<rect> x: /);
  });

  it("text is text: markup in an interpolated value or in the source is escaped, never parsed", () => {
    const drawn = draw(`{@state t = "</text><script>alert(1)</script>&amp;"}\n` + svg("<text>{t} a \\< b & c</text><title>{t}</title>"));
    expect(drawn.markup).toContain("<text>&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;amp; a &lt; b &amp; c</text>");
    expect(drawn.markup).toContain("<title>&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;amp;</title>");
    expect(drawn.markup).not.toContain("<script");
    // text outside a text element is not drawn
    const stray = draw("{@state t = 1}\n" + svg("<g>stray {t}</g>"));
    expect(stray.markup).toBe('<svg viewBox="0 0 100 100" width="100" fill="currentColor"><g/></svg>');
    expect(stray.errors).toEqual(["text directly inside <g> is not drawn — put it in a <text> element", "{…} directly inside <g> is not drawn — put it in a <text> element, or bind it to an attribute"]);
  });

  it("references are judged on the drawn ids: a missing or wrong target loses the attribute", () => {
    const drawn = draw(
      `{@state k = "g"}\n` +
        svg('<linearGradient id={k} /><clipPath id="c"><rect /></clipPath><rect fill="url(#g)" stroke="url(#nope)" clip-path="url(#g)" /><circle fill="url(#c)" clip-path="url(#c)" />'),
    );
    expect(drawn.markup).toContain('<rect fill="url(#wg1-g)"/>');
    expect(drawn.markup).toContain('<circle clip-path="url(#wg1-c)"/>');
    expect(drawn.errors).toEqual([
      'stroke="url(#nope)": this drawing has no element with id="nope". Define it (usually inside <defs>) in the SAME <svg>.',
      'clip-path="url(#g)" points at a <linearGradient>; clip-path can reference only <clipPath>.',
      'fill="url(#c)" points at a <clipPath>; fill can reference only <linearGradient> or <radialGradient> or <pattern>.',
    ]);
  });

  it("a resource never reaches another resource at run time either", () => {
    const drawn = draw(
      `{@state p = "url(#a)"}\n{@state c = "url(#c)"}\n` +
        svg('<pattern id="a"><rect /></pattern><clipPath id="c"><rect /></clipPath><linearGradient id="g" /><pattern id="b"><rect fill={p} stroke="url(#g)" clip-path={c} /></pattern>'),
    );
    expect(drawn.markup).toContain('<pattern id="wg1-b"><rect stroke="url(#wg1-g)"/></pattern>');
    expect(drawn.errors.join("\n")).toMatch(/fill="url\(#a\)" inside a <clipPath>, <mask>, <marker> or <pattern> may reference only a gradient, not a <pattern>/);
    expect(drawn.errors.join("\n")).toMatch(/"clip-path" cannot be used inside a <clipPath>, <mask>, <marker> or <pattern>/);
  });

  it("an id repeated by a loop is drawn once", () => {
    const drawn = draw(svg('{#each [1, 2, 3] as n}<linearGradient id="g" />{/each}{#each [1, 2] as n}<rect id={`r${n}`} />{/each}'));
    expect([...drawn.markup.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])).toEqual(["wg1-g", "wg1-r1", "wg1-r2"]);
    expect(drawn.errors).toEqual(['<linearGradient> id="g" is used more than once in this <svg> — ids must be unique (inside {#each}, build it from the index)']);
  });
});

describe("a drawing is bounded", () => {
  it("at most MAX_SVG_NODES elements per <svg>, counted after {#each}", () => {
    const loop = (n: number) => svg(`{#each Array.from({ length: ${n} }, (_, i) => i) as i}<circle cx={i} r="1" />{/each}`);
    expect(draw(loop(MAX_SVG_NODES)).tree.children).toHaveLength(MAX_SVG_NODES);
    ok(loop(MAX_SVG_NODES + 1)); // statically fine: only a render knows the count
    expect(() => draw(loop(MAX_SVG_NODES + 1))).toThrow(WidgetRuntimeError);
    expect(() => draw(loop(MAX_SVG_NODES + 1))).toThrow(/the <svg> draws too many elements \(limit 500\)/);
  });

  it("at most MAX_SVG_CHARS of attributes and text per <svg>", () => {
    const d = "M" + " 1 1".repeat(900); // 3,601 chars, under the per-path cap
    const paths = (n: number) => `{@const d = ${JSON.stringify(d)}}\n` + svg(`{#each ${n} as i}<path d={d} />{/each}`);
    expect(draw(paths(10)).errors).toEqual([]);
    expect(() => draw(paths(Math.ceil(MAX_SVG_CHARS / d.length) + 1))).toThrow(/the <svg> carries too much \(limit 60000 characters of attributes and text\)/);
    const text = `{@const t = "가".repeat(${MAX_SVG_CHARS / 2})}\n` + svg("<text>{t}</text><text>{t}</text><text>x</text>");
    expect(() => draw(text)).toThrow(/the <svg> carries too much/);
  });

  it("every element and character is charged to the render pass's output budget", () => {
    const one = draw(svg('<rect x="1" y="2" /><text>abc</text>'));
    const more = draw(svg('<rect x="1" y="2" /><text>abc</text><rect x="1" y="2" /><text>abc</text>'));
    // two elements; "x"+"1"+"y"+"2" and "abc" = 7 characters
    expect(one.rt.outEls - more.rt.outEls).toBe(2);
    expect(one.rt.outChars - more.rt.outChars).toBe(7);
    // many small drawings still stop at the pass's budget (20,000 elements)
    const flood = `{@const row = Array.from({ length: 400 }, (_, i) => i)}\n` + Array.from({ length: 60 }, () => svg("{#each row as i}<rect />{/each}")).join("\n");
    const doc = parseWidget(flood);
    expect(doc.problems).toEqual([]);
    const rt = createRuntime();
    const env = createRootEnv(doc, {}, rt, { get: () => undefined, set: () => {}, copy: () => {} });
    const all = doc.nodes.filter((n): n is ElNode => n.t === "el");
    expect(() => {
      for (const node of all) renderSvg(node, { viewBox: "0 0 1 1" }, env, rt, "w");
    }).toThrow(WidgetBudgetError);
  });

  it("checks any 20,000-character <svg> well inside 100 ms", () => {
    const head = `<svg ${BOX}>`;
    const fill = (unit: string, tail = "</svg>") => head + unit.repeat(Math.floor((MAX_WIDGET_SOURCE_CHARS - head.length - tail.length) / unit.length)) + tail;
    const shapes: Record<string, string> = {
      unknownElements: fill("<a/>"),
      nearMisses: fill("<circl/>"),
      rects: fill('<rect x="1"/>'),
      unknownAttrs: fill('<rect style="x"/>'),
      nearMissAttrs: fill('<rect strok="x"/>'),
      badValues: fill('<rect fill="red"/>'),
      danglingRefs: fill('<rect fill="url(#nope)"/>'),
      duplicateIds: fill('<g id="a"/>'),
      deep: head + "<g>".repeat(6000),
      longPath: head + '<path d="M' + " 1 1".repeat(4900) + '"/></svg>',
      transforms: fill('<g transform="rotate(1) rotate(1) rotate(1) rotate(1) rotate(1) rotate(1) rotate(1) rotate(1)"/>'),
      unfinishedTransform: head + '<g transform="' + "rotate(".repeat(2800) + '"/></svg>',
      points: head + '<polyline points="' + "1,1 ".repeat(4900) + '"/></svg>',
      expressions: fill("<rect x={a} />"),
      blocks: head + "{#each a as b}".repeat(1400),
      texts: fill("<text>{a}</text>"),
      colours: fill('<rect fill="rgb(1 2 3 / 4)"/>'),
      unclosed: fill("<rect>", ""),
      strayText: fill("<g>x</g>"),
      backslashes: head + '<rect fill="' + "\\".repeat(19_000) + '"/></svg>',
    };
    checkWidget(shapes.rects); // warm up
    const slow: string[] = [];
    for (const [name, src] of Object.entries(shapes)) {
      expect(src.length, name).toBeLessThanOrEqual(MAX_WIDGET_SOURCE_CHARS);
      const t0 = performance.now();
      const verdict = checkWidget(src);
      const ms = performance.now() - t0;
      if (ms > 100) slow.push(`${name}: ${ms.toFixed(1)} ms`);
      // every one of these is refused or accepted with a verdict — none throws
      expect(typeof verdict.ok, name).toBe("boolean");
    }
    expect(slow).toEqual([]);
  });
});

describe("svgMarkup", () => {
  it("escapes text and attribute values, and prints nothing whose NAME is not a plain word", () => {
    const tree: SvgTree = {
      tag: "svg",
      attrs: [
        ["viewBox", '0 0 1 1" onload="alert(1)'],
        ['x" onload="alert(1)', "1"],
      ],
      children: [
        { tag: "text", attrs: [["x", "<&>\""]], children: ['</text><script>alert("x")</script>&'] },
        { tag: "rect onload=alert(1)", attrs: [], children: [] },
        { tag: "g><script", attrs: [], children: ["never printed"] },
      ],
    };
    expect(svgMarkup(tree)).toBe('<svg viewBox="0 0 1 1&quot; onload=&quot;alert(1)"><text x="&lt;&amp;&gt;&quot;">&lt;/text&gt;&lt;script&gt;alert("x")&lt;/script&gt;&amp;</text></svg>');
  });
});
