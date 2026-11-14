// Read-only views over the headless mxGraph model (../src/mx-model.js) that the
// fit pass and the checks share: which vertices are "boxes with a label inside",
// where a cell sits on the page, and the room its label has.

import { labelLines, textWidth, widestPiece, wrappedLineCount, LINE_HEIGHT } from "./text.mjs";

/** Every cell of a page, in document order. */
export function allCells(model) {
  const out = [];
  (function visit(cell) {
    out.push(cell);
    for (let i = 0; i < model.getChildCount(cell); i++) visit(model.getChildAt(cell, i));
  })(model.getRoot());
  return out;
}

/** A vertex's rectangle in page coordinates, or null without a usable geometry. */
export function absRect(model, cell) {
  const geo = model.getGeometry(cell);
  if (geo == null || geo.relative) return null;
  const origin = model.getOrigin(model.getParent(cell));
  return { x: origin.x + geo.x, y: origin.y + geo.y, w: geo.width, h: geo.height };
}

export function hasVertexChildren(model, cell) {
  for (let i = 0; i < model.getChildCount(cell); i++) if (model.isVertex(model.getChildAt(cell, i))) return true;
  return false;
}

/** Bare words draw.io's stylesheet knows as shapes; any other shape needs `shape=<name>`. */
const NAMED_SHAPES = new Set(["ellipse", "rhombus", "triangle", "swimlane", "text", "group", "image", "line", "label", "icon", "arrow"]);

/**
 * The shape a style string names: its `shape=` key, else a bare word the
 * stylesheet knows (`ellipse;…`, `rhombus;…`, `swimlane;…`), else a rectangle
 * (a bare `hexagon` or `cloud` is not a style and draws a plain box). Read
 * from the RAW style: the resolved one reports draw.io's default vertex shape
 * (`label`) for every plain box.
 */
export function shapeName(rawStyle) {
  const parts = String(rawStyle ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) if (part.startsWith("shape=")) return part.slice("shape=".length);
  for (const part of parts) if (!part.includes("=") && NAMED_SHAPES.has(part)) return part;
  return "rectangle";
}

/**
 * A cell the viewer does not draw: hidden itself, or inside a hidden or
 * collapsed ancestor.
 */
export function isHidden(model, cell) {
  if (!model.isVisible(cell)) return true;
  for (let p = model.getParent(cell); p != null; p = model.getParent(p)) {
    if (!model.isVisible(p) || p.block?.attrs?.collapsed === "1") return true;
  }
  return false;
}

/** A vertex that is a container by STYLE (a swimlane, a group, a table), with or without children. */
export function isContainerStyle(rawStyle, style) {
  const shape = shapeName(rawStyle);
  return shape === "swimlane" || shape === "group" || shape === "table" || style.container === 1 || style.childLayout != null;
}

/**
 * How much of a shape's box its label can use: [width share, height share].
 * A diamond's text sits in its middle, where the outline is narrowest for a
 * tall label; an ellipse loses its corners; a cylinder loses its caps.
 */
function labelShare(shape) {
  if (shape === "rhombus") return [0.62, 0.62];
  if (shape === "ellipse" || shape === "doubleEllipse") return [0.78, 0.78];
  if (shape === "cloud") return [0.7, 0.6];
  if (shape === "triangle") return [0.55, 0.55];
  if (shape === "hexagon" || shape === "parallelogram" || shape === "trapezoid" || shape === "step") return [0.8, 1];
  if (shape.startsWith("cylinder") || shape === "datastore") return [0.92, 0.5];
  if (shape === "document" || shape === "tape") return [0.94, 0.75];
  return [1, 1];
}

const PAD_X = 20;
const PAD_Y = 12;
/** A label line up to this wide (px) is given a box it fits in without wrapping. */
const ONE_LINE_MAX = 200;

/**
 * The label facts of a vertex, or null when the label is not a text block
 * inside the shape (no label, a container title, a label placed outside the
 * shape, an image).
 */
export function labelFacts(graph, cell) {
  const model = graph.getModel();
  const label = graph.getLabel(cell);
  if (!label.trim()) return null;
  const raw = model.getStyle(cell) ?? "";
  const style = graph.getCellStyle(cell);
  if (isContainerStyle(raw, style) || hasVertexChildren(model, cell)) return null;
  const shape = shapeName(raw);
  if (shape === "image" || shape === "text" || shape === "line" || shape.startsWith("mxgraph.")) return null;
  const outside =
    (style.labelPosition != null && style.labelPosition !== "center") ||
    (style.verticalLabelPosition != null && style.verticalLabelPosition !== "middle");
  if (outside) return null;
  // Turned text (a vertical bar's label, a rotated shape) is not measured.
  if (style.horizontal === 0 || (typeof style.rotation === "number" && style.rotation !== 0)) return null;
  const fontSize = typeof style.fontSize === "number" && style.fontSize > 0 ? style.fontSize : 12;
  const bold = (Number(style.fontStyle) & 1) === 1 || /<(b|strong)\b/i.test(label);
  const lines = labelLines(label, style.html === 1 || style.html === "1");
  if (lines.length === 0) return null;
  return { lines, fontSize, bold, wrap: style.whiteSpace === "wrap", share: labelShare(shape), shape };
}

/**
 * The smallest size (w, h) at which the label fits with room around it,
 * growing from the current size: width first (up to `maxWidth`), then height.
 *
 * The viewer wraps a label at the width of the BOX, whatever the outline: in
 * a diamond or an ellipse a wrapped row is as wide as the box and crosses the
 * outline. So such a shape is widened until its longest line fits unwrapped
 * in the part of the box the outline leaves; a rectangle may wrap.
 */
export function sizeForLabel(facts, width, height, maxWidth = 320) {
  const { lines, fontSize, bold, wrap, share } = facts;
  const lineHeight = fontSize * LINE_HEIGHT;
  const needWidth = (text) => (text + PAD_X) / share[0];
  const heightFor = (rows) => (rows * lineHeight + PAD_Y) / share[1];
  const single = Math.max(...lines.map((line) => textWidth(line, fontSize, bold)));
  if (!wrap) return { w: Math.max(width, needWidth(single)), h: Math.max(height, heightFor(lines.length)) };
  if (share[0] < 1) {
    const w = Math.max(width, Math.min(maxWidth, needWidth(single)));
    const rows = single <= w - PAD_X ? lines.length : wrappedLineCount(lines, fontSize, bold, w - PAD_X);
    return { w, h: Math.max(height, heightFor(rows)) };
  }
  // A short line stays on one line: Hangul wraps between any two syllables, so
  // a box a little too narrow leaves one syllable alone on the last row.
  const least = single <= ONE_LINE_MAX ? single : widestPiece(lines, fontSize, bold);
  let w = Math.max(width, Math.min(maxWidth, needWidth(least)));
  const rowsAt = (boxWidth) => wrappedLineCount(lines, fontSize, bold, boxWidth - PAD_X);
  // Wider only while that saves a row: hard line breaks do not go away.
  while (heightFor(rowsAt(w)) > height && w < maxWidth) {
    let next = w;
    while (next < maxWidth && rowsAt(next) === rowsAt(w)) next = Math.min(maxWidth, next + 20);
    if (rowsAt(next) === rowsAt(w)) break;
    w = next;
  }
  return { w, h: Math.max(height, heightFor(rowsAt(w))) };
}

/**
 * True when the label clearly spills out of what the outline leaves of the
 * box (`tolerance` is the margin for an estimate made without a renderer).
 */
export function overflows(facts, width, height, tolerance = 1.1) {
  const { lines, fontSize, bold, wrap, share } = facts;
  const lineHeight = fontSize * LINE_HEIGHT;
  const roomW = width * share[0] * tolerance;
  const roomH = height * share[1] * tolerance;
  const single = Math.max(...lines.map((line) => textWidth(line, fontSize, bold)));
  const wrapAt = width - 4;
  if (!wrap || single <= wrapAt) return single > roomW || lines.length * lineHeight > roomH;
  const rows = wrappedLineCount(lines, fontSize, bold, wrapAt);
  const rowWidth = share[0] < 1 ? Math.min(single, wrapAt) : widestPiece(lines, fontSize, bold);
  return rowWidth > roomW || rows * lineHeight > roomH;
}
