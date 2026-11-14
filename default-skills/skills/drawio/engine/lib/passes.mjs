// The passes `layout` and `route` run over a diagram. The engines are
// draw.io's own, vendored from jgraph/drawio-mcp (../README.md): ELK through
// the drawio-elk bridge places the shapes and routes the connectors, libavoid
// re-routes connectors around shapes that stay where they are. Both work on
// the headless model in ../src and write back only the cells they changed.

import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getElkBridge } from "../src/elk-engine.js";
import { routeXml } from "../src/libavoid-pass.js";
import { installMxGlobals, MxGeometry } from "../src/mx-model.js";
import { transformPages } from "../src/mx-xml.js";
import { isRightAngled } from "./check.mjs";
import { allCells, labelFacts, shapeName, sizeForLabel } from "./model.mjs";
import { labelLines, textWidth, LINE_HEIGHT } from "./text.mjs";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `--flow` value → the preset of draw.io's Arrange ▸ Layout menu. */
export const FLOWS = {
  down: "verticalFlow",
  right: "horizontalFlow",
  "tree-down": "verticalTree",
  "tree-right": "horizontalTree",
  radial: "radialTree",
  organic: "organic",
};

const snapUp = (value) => Math.ceil(value / 10) * 10;

/** mxUtils.getSizeForString for the ELK bridge: an unwrapped label's box. */
function labelSize(text, fontSize, _fontFamily, _textWidth, fontStyle) {
  const size = typeof fontSize === "number" && fontSize > 0 ? fontSize : 12;
  const bold = (Number(fontStyle) & 1) === 1;
  const lines = labelLines(text, true);
  const widest = Math.max(0, ...lines.map((line) => textWidth(line, size, bold)));
  return { width: Math.ceil(widest + 4), height: Math.ceil(Math.max(lines.length, 1) * size * LINE_HEIGHT) };
}

/**
 * Grow every box whose label does not fit it (width first, then height). The
 * layout keeps the sizes it is given, so this runs before it; nothing is ever
 * shrunk and nothing is moved.
 */
export function fitLabels(xml) {
  let grown = 0;
  const result = transformPages(xml, (graph) => {
    const model = graph.getModel();
    for (const cell of allCells(model)) {
      if (!model.isVertex(cell)) continue;
      const geo = model.getGeometry(cell);
      if (geo == null || geo.relative || geo.width <= 0 || geo.height <= 0) continue;
      const facts = labelFacts(graph, cell);
      if (!facts) continue;
      const need = sizeForLabel(facts, geo.width, geo.height);
      if (need.w <= geo.width + 1 && need.h <= geo.height + 1) continue;
      const next = geo.clone();
      next.width = Math.max(geo.width, snapUp(need.w));
      next.height = Math.max(geo.height, snapUp(need.h));
      model.setGeometry(cell, next);
      grown += 1;
    }
  });
  return { xml: result.xml, grown };
}

/**
 * Free text on a layer — a title, a caption: a `text` cell no connector
 * touches. It is not part of the graph, so the layout leaves it out (an
 * unconnected node lands wherever the algorithm drops it, and under `radial`
 * it collapses the whole page onto one spot) and it is put back above the
 * result.
 */
function freeText(graph) {
  const model = graph.getModel();
  const layer = graph.getDefaultParent();
  const out = [];
  for (let i = 0; i < model.getChildCount(layer); i++) {
    const cell = model.getChildAt(layer, i);
    if (!model.isVertex(cell) || shapeName(model.getStyle(cell)) !== "text") continue;
    if (model.getEdgeCount(cell) > 0 || model.getChildCount(cell) > 0) continue;
    const geo = model.getGeometry(cell);
    if (geo != null && !geo.relative) out.push(cell);
  }
  return out;
}

function placeAbove(graph, cells) {
  const model = graph.getModel();
  const layer = graph.getDefaultParent();
  const held = new Set(cells);
  let left = Infinity;
  let top = Infinity;
  for (let i = 0; i < model.getChildCount(layer); i++) {
    const cell = model.getChildAt(layer, i);
    const geo = model.getGeometry(cell);
    if (!model.isVertex(cell) || held.has(cell) || geo == null || geo.relative) continue;
    left = Math.min(left, geo.x);
    top = Math.min(top, geo.y);
  }
  if (!Number.isFinite(left)) return;
  let y = top - 20;
  for (const cell of [...cells].reverse()) {
    const next = model.getGeometry(cell).clone();
    y -= next.height;
    next.x = left;
    next.y = y;
    model.setGeometry(cell, next);
    y -= 10;
  }
}

/**
 * Lay every page out with ELK. `failures` names what kept a page as it was
 * (transformPages never throws: a page whose layout fails is left untouched) —
 * a diagram the chosen flow cannot take, not a broken engine. Throws only when
 * the engine itself cannot start.
 */
export async function elkLayout(xml, flow) {
  const bridge = await getElkBridge();
  installMxGlobals();
  // The bridge reserves room for labels with mxUtils.getSizeForString. The
  // headless stand-in counts every character as 0.6 em, half of what Hangul
  // takes, so labels of this fleet would be given too little room.
  globalThis.mxUtils.getSizeForString = labelSize;
  const preset = (bridge.ElkLayout.MENU_PRESETS ?? {})[FLOWS[flow]];
  if (preset == null) throw new Error(`the ELK bundle has no '${FLOWS[flow]}' layout`);
  const failures = [];
  const result = transformPages(xml, (graph) => {
    try {
      const titles = freeText(graph);
      const left = new Set(titles);
      // Sizes are pinned (resizeParent false): there is no renderer to measure
      // text with, so the boxes keep the sizes fitLabels gave them.
      const options = { applierOptions: { resizeParent: false }, cellFilter: (cell) => !left.has(cell) };
      const canonical = bridge.ElkLayout.CANONICAL_EDGE;
      if (canonical != null) {
        options.edgeStyleMode = canonical.edgeStyleMode;
        options.corners = canonical.corners;
      }
      const layout = new bridge.ElkLayout(graph, preset.algorithm, { ...(preset.options ?? {}) }, options);
      if (!layout.canExecuteSync()) throw new Error("no synchronous ELK engine");
      layout.executeSync(graph.getDefaultParent());
      placeAbove(graph, titles);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
  return { xml: result.xml, changed: result.changed, failures };
}

/** Give every edge written without a geometry the standard relative one (it is not drawn without). */
export function ensureEdgeGeometry(xml) {
  return transformPages(xml, (graph) => {
    const model = graph.getModel();
    for (const cell of allCells(model)) {
      if (!model.isEdge(cell) || model.getGeometry(cell) != null) continue;
      const geo = new MxGeometry();
      geo.relative = true;
      model.setGeometry(cell, geo);
    }
  }).xml;
}

/**
 * How many connectors the router computes: every one between two shapes. The
 * vendored pass routes them all, the ones `keepEdgeStyles` restores included.
 */
export function routableEdgeCount(xml) {
  let count = 0;
  transformPages(xml, (graph) => {
    const model = graph.getModel();
    for (const cell of allCells(model)) {
      if (model.isEdge(cell) && model.isVertex(model.getTerminal(cell, true)) && model.isVertex(model.getTerminal(cell, false))) count += 1;
    }
  });
  return count;
}

/**
 * The router turns every connector it touches into a right-angled one. A line
 * the author drew straight, curved or as an entity relation is a choice
 * (SKILL.md: state and network links, ER diagrams) and `route` moves nothing,
 * so those get their style and geometry back. (`layout` does not do this: it
 * moves every shape, and a straight line between the new places runs through
 * whatever lies between them — seen in the viewer.)
 */
export function keepEdgeStyles(before, after) {
  const pages = [];
  transformPages(before, (graph) => {
    const model = graph.getModel();
    const kept = new Map();
    for (const cell of allCells(model)) {
      if (!model.isEdge(cell) || isRightAngled(model.getStyle(cell))) continue;
      const geo = model.getGeometry(cell);
      kept.set(cell.id, { style: model.getStyle(cell), geometry: geo ? geo.clone() : null });
    }
    pages.push(kept);
  });
  let page = 0;
  let count = 0;
  const xml = transformPages(after, (graph) => {
    const kept = pages[page++] ?? new Map();
    const model = graph.getModel();
    for (const cell of allCells(model)) {
      const was = model.isEdge(cell) ? kept.get(cell.id) : undefined;
      if (!was) continue;
      count += 1;
      if (model.getStyle(cell) !== was.style) model.setStyle(cell, was.style);
      if (was.geometry) model.setGeometry(cell, was.geometry);
    }
  }).xml;
  return { xml, kept: count };
}

/**
 * Re-route the right-angled connectors between two shapes around the other
 * shapes, without moving a shape. Throws when the router cannot start; the
 * upstream pass itself never throws, so what it needs is checked here first
 * (it loads the router itself, and loading it twice prints into the report).
 */
export async function libavoidRoute(xml) {
  const wasm = fs.readFileSync(join(ENGINE, "vendor", "libavoid", "libavoid.wasm"));
  if (!WebAssembly.validate(wasm)) throw new Error("vendor/libavoid/libavoid.wasm is not a WebAssembly module");
  fs.accessSync(join(ENGINE, "vendor", "libavoid", "libavoid-routing.js"), fs.constants.R_OK);
  const routed = await routeXml(xml);
  const kept = keepEdgeStyles(xml, routed);
  return { xml: kept.xml, routed: (kept.xml.match(/libavoidRouting=1/g) ?? []).length, kept: kept.kept };
}
