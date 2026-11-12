// lib/uiGallery.ts — the samples of the 인라인 UI gallery (`#/uiGallery`). The
// gallery is only worth having while it is COMPLETE and RIGHT: every component
// of the grammar (src/shared/widget/spec.ts) has a sample, and every sample is
// an answer the checker and the evaluator take without a complaint — the same
// two an avatar's answer goes through.
import { describe, expect, it } from "vitest";

import { UI_GALLERY, gallerySourceMarkdown, type GallerySample } from "../src/client/src/lib/uiGallery.js";
import { answerNodes, buildAnswerItems, collectWidgetProblems, createAnswerViewCache, type VNode } from "../src/client/src/lib/widgetView.js";
import { WIDGET_COMPONENTS, WIDGET_TAGS, containsInlineUi, createRootEnv, createRuntime, parseAnswer, restoreState, widgetProblems } from "../src/shared/widget/index.js";

const samples: GallerySample[] = UI_GALLERY.flatMap((section) => section.samples);
const allSource = samples.map((sample) => sample.source).join("\n");

function flat(nodes: VNode[]): VNode[] {
  return nodes.flatMap((node) => (node.k === "el" ? [node, ...flat(node.children)] : [node]));
}

describe("the inline UI gallery", () => {
  it("names every section and sample once", () => {
    const sectionIds = UI_GALLERY.map((section) => section.id);
    expect(new Set(sectionIds).size).toBe(sectionIds.length);
    const ids = samples.map((sample) => sample.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of UI_GALLERY) expect(section.samples.length).toBeGreaterThan(0);
  });

  it("has a sample for every component of the grammar", () => {
    const missing = WIDGET_TAGS.filter((tag) => !new RegExp(`<${tag}[\\s/>]`).test(allSource));
    expect(missing).toEqual([]);
  });

  it("has a sample for every chart type and a diagram — and none of the retired Vega-Lite form", () => {
    const type = WIDGET_COMPONENTS.chart.props.type.type;
    const types = type.k === "enum" ? type.values : [];
    expect(types.length).toBeGreaterThan(0);
    for (const name of types) expect(allSource).toContain(`<chart type="${name}"`);
    expect(allSource).not.toContain("spec={");
    expect(allSource).toContain("```mermaid");
  });

  it.each(samples.map((sample) => [sample.id, sample] as const))("%s is an answer the checker and the evaluator accept", (_id, sample) => {
    const doc = parseAnswer(sample.source, { streaming: false });
    expect(doc.failed).toBe(false);
    expect(widgetProblems(doc)).toEqual([]);
    if (sample.sourceOnly) return;

    const values = { ...restoreState(doc, {}).values };
    const rt = createRuntime();
    const host = { get: (name: string) => values[name], set: () => {}, copy: () => {} };
    const nodes = answerNodes(buildAnswerItems(doc, createRootEnv(doc, values, rt, host), rt, values, createAnswerViewCache(), { conversationId: null, svgNs: "t" }));
    expect(collectWidgetProblems(doc, nodes)).toEqual([]);
    expect(flat(nodes).filter((node) => node.k === "error" || node.k === "warn")).toEqual([]);
    // A sample that draws UI is recognised as one by the chat's own scan (a diagram is plain Markdown).
    if (nodes.length > 0) expect(containsInlineUi(sample.source)).toBe(true);
  });

  it("shows a sample's source in a fence its own fences cannot close", () => {
    expect(gallerySourceMarkdown("<divider />")).toBe("```text\n<divider />\n```");
    expect(gallerySourceMarkdown("```mermaid\nflowchart LR\n```")).toBe("````text\n```mermaid\nflowchart LR\n```\n````");
  });
});
