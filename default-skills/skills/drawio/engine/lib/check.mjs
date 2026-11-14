// `check`: what is wrong with a .drawio file, found without a renderer.
//
// ERRORS are what makes the viewer draw nothing, or the wrong thing: broken
// XML, a compressed page, missing root cells, duplicate ids, an edge whose end
// names no cell. WARNINGS are what a reader sees as a messy diagram: shapes on
// top of each other, a connector running through a shape, a label that does
// not fit its box, text too small to read. NOTES are habits worth fixing.
// Every finding names its cell and how to fix it, so it can be acted on
// without looking at the picture.

import { repairDiagramXml } from "../src/repair-xml.js";
import { parseAttrs, transformPages } from "../src/mx-xml.js";
import { absRect, allCells, hasVertexChildren, isContainerStyle, isHidden, labelFacts, overflows, shapeName } from "./model.mjs";
import { labelLines, textWidth, wrappedLineCount, LINE_HEIGHT } from "./text.mjs";
import { canonicalAttributes, rootName, wellFormedError, withoutComments } from "./xmlcheck.mjs";

/**
 * Stencil sets the chat preview can draw (src/client/public/drawio/stencils,
 * kept equal by tests/drawio-skill.test.ts). Anything else under `mxgraph.`
 * is shown as a labelled placeholder box.
 */
export const BUNDLED_STENCILS = ["arrows", "basic", "bpmn", "flowchart"];

const MAX_PER_CODE = 8;

/**
 * A right-angled connector: the kind `route` draws. A straight (no edgeStyle),
 * curved (`curved=1`) or entity-relation line is a look the author chose, and
 * `route` leaves it as drawn.
 */
export function isRightAngled(rawStyle) {
  const style = rawStyle ?? "";
  return /(^|;)\s*edgeStyle=(orthogonalEdgeStyle|elbowEdgeStyle|segmentEdgeStyle)\b/.test(style) && !/(^|;)\s*curved=1\b/.test(style);
}

function decode(value) {
  return value == null
    ? null
    : String(value).replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name]);
}

/** The pages of a file: each <mxGraphModel> with the name of the <diagram> around it. */
function pagesOf(xml) {
  const pages = [];
  const re = /<mxGraphModel\b[^>]*>[\s\S]*?<\/mxGraphModel>/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    const before = xml.slice(0, m.index);
    const open = before.lastIndexOf("<diagram");
    const closed = before.lastIndexOf("</diagram>");
    let name = null;
    if (open !== -1 && open > closed) name = decode(parseAttrs(before.slice(open, before.indexOf(">", open) + 1 || undefined)).name ?? null);
    pages.push({ name: name || `page ${pages.length + 1}`, text: m[0] });
  }
  return pages;
}

/** Raw <mxCell> elements of one page (ids of <object>/<UserObject> wrappers resolved). */
function rawCells(text) {
  const wrappers = [];
  const wrapperRe = /<(object|UserObject)\b([^>]*?)>([\s\S]*?)<\/\1>/g;
  for (let m = wrapperRe.exec(text); m !== null; m = wrapperRe.exec(text)) {
    wrappers.push({ start: m.index, end: m.index + m[0].length, attrs: parseAttrs(m[2]) });
  }
  const cells = [];
  const cellRe = /<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g;
  for (let m = cellRe.exec(text); m !== null; m = cellRe.exec(text)) {
    const attrs = parseAttrs(m[1]);
    const wrapper = wrappers.find((w) => m.index > w.start && m.index < w.end);
    const body = m[3] ?? "";
    cells.push({
      id: decode(attrs.id ?? wrapper?.attrs.id ?? null),
      parent: decode(attrs.parent ?? null),
      source: decode(attrs.source ?? null),
      target: decode(attrs.target ?? null),
      vertex: attrs.vertex === "1",
      edge: attrs.edge === "1",
      hasGeometry: /<mxGeometry\b/.test(body),
      hasSourcePoint: /as="sourcePoint"/.test(body),
      hasTargetPoint: /as="targetPoint"/.test(body),
    });
  }
  return cells;
}

function structuralFindings(page, add) {
  const cells = rawCells(page.text);
  const ids = new Map();
  for (const cell of cells) {
    if (cell.id == null) {
      add("error", "cell-without-id", null, "an <mxCell> has no id", "give every cell a unique id");
      continue;
    }
    ids.set(cell.id, (ids.get(cell.id) ?? 0) + 1);
  }
  for (const [id, count] of ids) {
    if (count > 1) add("error", "duplicate-id", id, `${count} cells share this id; only the first is drawn`, "make every id unique");
  }
  const roots = cells.filter((cell) => cell.parent == null && !cell.vertex && !cell.edge);
  if (roots.length === 0) {
    add("error", "missing-root", null, "the page has no root cell, so nothing is drawn", 'start <root> with <mxCell id="0"/><mxCell id="1" parent="0"/>');
  } else if (!cells.some((cell) => cell.parent === roots[0].id && !cell.vertex && !cell.edge)) {
    add("error", "missing-layer", null, "the page has no layer cell under the root", `add <mxCell id="1" parent="${roots[0].id}"/> and give shapes parent="1"`);
  }
  // A parent chain that comes back to itself: no cell of it is drawn, and a
  // walk up such a chain never ends.
  const parentOf = new Map(cells.filter((cell) => cell.id != null).map((cell) => [cell.id, cell.parent]));
  const looped = new Set();
  for (const cell of cells) {
    if (cell.id == null || cell.parent === cell.id || looped.has(cell.id)) continue;
    const walked = new Set([cell.id]);
    for (let up = cell.parent; up != null && parentOf.has(up); up = parentOf.get(up)) {
      if (up === parentOf.get(up)) break;
      if (walked.has(up)) {
        for (const id of walked) looped.add(id);
        add("error", "parent-cycle", cell.id, `the parent chain of this cell comes back to '${up}', so none of these cells is drawn`, 'a shape\'s parent is "1" or the id of the container it is in, and a container is never inside its own child');
        break;
      }
      walked.add(up);
    }
  }
  for (const cell of cells) {
    if (cell.id == null) continue;
    if (cell.parent != null && cell.parent === cell.id) {
      add("error", "self-parent", cell.id, "the cell is its own parent, which hides it and its children", 'the default layer is <mxCell id="1" parent="0"/>');
    } else if (cell.parent != null && !ids.has(cell.parent)) {
      add("error", "unknown-parent", cell.id, `parent="${cell.parent}" names no cell`, 'use parent="1", or the id of the container the cell is in');
    } else if (cell.parent == null && (cell.vertex || cell.edge)) {
      add("error", "no-parent", cell.id, "the cell has no parent, so it is not drawn", 'add parent="1" (or the id of its container)');
    }
    if (cell.vertex && !cell.hasGeometry) {
      add("error", "vertex-without-geometry", cell.id, "the shape has no <mxGeometry>, so it has no size", '<mxGeometry x=".." y=".." width=".." height=".." as="geometry"/>');
    }
    if (!cell.edge) continue;
    if (!cell.hasGeometry) {
      add("error", "edge-without-geometry", cell.id, "the edge has no <mxGeometry>, so it is not drawn", 'never self-close an edge: <mxCell …><mxGeometry relative="1" as="geometry"/></mxCell> (`layout` and `route` add it)');
    }
    for (const end of ["source", "target"]) {
      const ref = cell[end];
      const hasPoint = end === "source" ? cell.hasSourcePoint : cell.hasTargetPoint;
      if (ref != null && !ids.has(ref)) {
        add("error", "dangling-edge", cell.id, `${end}="${ref}" names no cell`, "point it at the id of an existing shape");
      } else if (ref == null && !hasPoint) {
        add("warning", "unattached-edge", cell.id, `the edge has no ${end}, so that end is not attached to a shape`, `add ${end}="<shape id>"`);
      }
    }
  }
  return { cyclic: looped.size > 0 };
}

function intersects(a, b, inset = 0) {
  return a.x + inset < b.x + b.w && b.x + inset < a.x + a.w && a.y + inset < b.y + b.h && b.y + inset < a.y + a.h;
}

function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** Does the segment p→q pass through the inside of `rect` (shrunk by `inset`)? Liang–Barsky. */
function segmentHitsRect(p, q, rect, inset = 3) {
  const minX = rect.x + inset;
  const maxX = rect.x + rect.w - inset;
  const minY = rect.y + inset;
  const maxY = rect.y + rect.h - inset;
  if (minX >= maxX || minY >= maxY) return false;
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  for (const [delta, low, high] of [
    [dx, minX - p.x, maxX - p.x],
    [dy, minY - p.y, maxY - p.y],
  ]) {
    if (delta === 0) {
      if (low > 0 || high < 0) return false;
      continue;
    }
    let a = low / delta;
    let b = high / delta;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return true;
}

const inRect = (p, rect) => p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;

/**
 * Where draw.io puts an edge's label: the middle of the drawn line. Known for
 * a routed edge (its waypoints) and for two shapes that face each other
 * across a gap (a straight connector); null when the route is the viewer's to
 * choose.
 */
function labelSpot(path, routed, from, to) {
  if (!routed) {
    const overlapY = Math.min(from.y + from.h, to.y + to.h) - Math.max(from.y, to.y);
    const overlapX = Math.min(from.x + from.w, to.x + to.w) - Math.max(from.x, to.x);
    if (overlapY > 0 && overlapX <= 0) {
      const left = from.x < to.x ? from : to;
      const right = left === from ? to : from;
      return { x: (left.x + left.w + right.x) / 2, y: Math.max(from.y, to.y) + overlapY / 2 };
    }
    if (overlapX > 0 && overlapY <= 0) {
      const upper = from.y < to.y ? from : to;
      const lower = upper === from ? to : from;
      return { x: Math.max(from.x, to.x) + overlapX / 2, y: (upper.y + upper.h + lower.y) / 2 };
    }
    return null;
  }
  const samples = [];
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k];
    const b = path[k + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
    for (let i = 0; i < steps; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps };
      if (!inRect(p, from) && !inRect(p, to)) samples.push(p);
    }
  }
  return samples.length > 0 ? samples[Math.floor(samples.length / 2)] : null;
}

const center = (rect) => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });

function describe(graph, cell) {
  const lines = labelLines(graph.getLabel(cell), true);
  const text = lines.join(" ").slice(0, 30);
  return text ? `'${cell.id}' ("${text}")` : `'${cell.id}'`;
}

/** The visible shapes of a page: `{ cell, rect (page coordinates), raw style, container }`. */
function pageBoxes(graph) {
  const model = graph.getModel();
  const boxes = [];
  for (const cell of allCells(model)) {
    if (!model.isVertex(cell) || isHidden(model, cell)) continue;
    const rect = absRect(model, cell);
    if (!rect || rect.w <= 0 || rect.h <= 0) continue;
    const raw = model.getStyle(cell) ?? "";
    const container = isContainerStyle(raw, graph.getCellStyle(cell)) || hasVertexChildren(model, cell);
    boxes.push({ cell, rect, raw, container });
  }
  return boxes;
}

function leafOverlaps(leaves) {
  const pairs = [];
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) if (intersects(leaves[i].rect, leaves[j].rect, 4)) pairs.push([leaves[i], leaves[j]]);
  }
  return pairs;
}

/**
 * The leaf shapes that sit on top of each other, per page, each with its
 * geometry as written (in its parent's frame): `layout` compares before and
 * after to tell an overlap it produced from one the author wrote and it never
 * touched (the rows of a stack whose y was left out).
 */
export function overlapState(xml) {
  const pages = [];
  for (const page of pagesOf(xml)) {
    const state = { pairs: [], local: new Map() };
    transformPages(page.text, (graph) => {
      const model = graph.getModel();
      const leaves = pageBoxes(graph).filter((box) => !box.container);
      for (const box of leaves) {
        const geo = model.getGeometry(box.cell);
        state.local.set(box.cell.id, `${geo.x},${geo.y},${geo.width},${geo.height}`);
      }
      state.pairs = leafOverlaps(leaves).map(([a, b]) => [a.cell.id, b.cell.id]);
    });
    pages.push(state);
  }
  return pages;
}

function visualFindings(graph, add, after) {
  const model = graph.getModel();
  const cells = allCells(model);
  const boxes = pageBoxes(graph);
  if (boxes.length === 0) {
    add("warning", "empty-page", null, "the page has no shape", "add vertices, or remove the page");
    return;
  }
  const leaves = boxes.filter((box) => !box.container);

  // Shapes on top of each other, wherever they are filed: the reader sees one page.
  for (const [a, b] of leafOverlaps(leaves)) {
    const stacked = contains(a.rect, b.rect) || contains(b.rect, a.rect);
    add(
      "warning",
      "overlap",
      a.cell.id,
      `${describe(graph, a.cell)} and ${describe(graph, b.cell)} ${stacked ? "sit on top of each other" : "overlap"}`,
      stacked
        ? "give each shape its own grid cell; to put one inside another, make the outer one a container and set the inner one's parent to it"
        : "give each shape its own grid cell, or run `layout`",
    );
  }
  const containers = boxes.filter((box) => box.container);
  for (let i = 0; i < containers.length; i++) {
    for (let j = i + 1; j < containers.length; j++) {
      const a = containers[i];
      const b = containers[j];
      if (model.getParent(a.cell) !== model.getParent(b.cell) || !intersects(a.rect, b.rect, 4)) continue;
      add("warning", "overlap", a.cell.id, `the containers ${describe(graph, a.cell)} and ${describe(graph, b.cell)} overlap`, "move one of them, or make one the parent of the other");
    }
  }
  for (const box of boxes) {
    const parent = model.getParent(box.cell);
    const holder = boxes.find((other) => other.cell === parent);
    if (!holder || shapeName(holder.raw) === "group") continue;
    const room = { x: holder.rect.x - 1, y: holder.rect.y - 1, w: holder.rect.w + 2, h: holder.rect.h + 2 };
    if (!contains(room, box.rect)) {
      add("warning", "outside-container", box.cell.id, `${describe(graph, box.cell)} reaches outside its container ${describe(graph, holder.cell)}`, "move it inside (its x/y are relative to the container) or make the container bigger (`layout` grows containers around their children)");
    }
  }
  // Container titles: the band a swimlane keeps for its title.
  for (const box of containers) {
    const label = graph.getLabel(box.cell).trim();
    if (!label || shapeName(box.raw) !== "swimlane") continue;
    const style = graph.getCellStyle(box.cell);
    const size = typeof style.fontSize === "number" && style.fontSize > 0 ? style.fontSize : 12;
    const bold = (Number(style.fontStyle) & 1) === 1;
    const lines = labelLines(label, style.html === 1);
    if (lines.length === 0) continue;
    const along = style.horizontal === 0 ? box.rect.h : box.rect.w;
    const band = typeof style.startSize === "number" ? style.startSize : 23;
    const single = Math.max(...lines.map((line) => textWidth(line, size, bold)));
    const wrapped = style.whiteSpace === "wrap";
    const spills = wrapped ? wrappedLineCount(lines, size, bold, along - 8) * size * LINE_HEIGHT > band * 1.1 : single > along * 1.1;
    if (spills) {
      add(
        "warning",
        "label-overflow",
        box.cell.id,
        `the title of the container ${describe(graph, box.cell)} does not fit${wrapped ? ` its ${Math.round(band)} px title band` : ` along the container (${Math.round(along)} px) and has no whiteSpace=wrap`}`,
        wrapped ? "shorten the title or raise startSize" : "add whiteSpace=wrap; to the container style, shorten the title, or raise startSize",
      );
    }
  }

  // Connectors through shapes.
  const stencils = new Set();
  let unsizedFonts = 0;
  let bareEdgeLabels = 0;
  for (const box of boxes) {
    const shape = shapeName(box.raw);
    const set = /^mxgraph\.([A-Za-z0-9_]+)\./.exec(shape);
    if (set && !BUNDLED_STENCILS.includes(set[1])) stencils.add(set[1]);
    const style = graph.getCellStyle(box.cell);
    const label = graph.getLabel(box.cell).trim();
    if (label && /(^|;)\s*fontSize=/.test(box.raw) && typeof style.fontSize === "number" && style.fontSize < 11) {
      add("warning", "small-font", box.cell.id, `${describe(graph, box.cell)} uses fontSize=${style.fontSize}, too small to read in the chat preview`, "use fontSize=14 (12 at the least) and a bigger box");
    }
    if (label && !box.container && !/(^|;)\s*fontSize=/.test(box.raw)) unsizedFonts += 1;
    if (box.container) continue;
    const capFacts = /^cylinder3?$/.test(shape) && style.boundedLbl !== 1 ? labelFacts(graph, box.cell) : null;
    const capRows = capFacts ? (capFacts.wrap ? wrappedLineCount(capFacts.lines, capFacts.fontSize, capFacts.bold, box.rect.w - 4) : capFacts.lines.length) : 0;
    // The label is centred in the whole shape; the cap's lower arc is `2 × size` (15 by default) from the top.
    if (capFacts && box.rect.h / 2 - (capRows * capFacts.fontSize * LINE_HEIGHT) / 2 < 2 * (typeof style.size === "number" ? style.size : 15) - 1) {
      add("warning", "label-on-cap", box.cell.id, `the label of ${describe(graph, box.cell)} is centred in the whole cylinder, so the line of its top cap runs through the text`, "add boundedLbl=1;backgroundOutline=1;size=15; to the style (the label then sits below the cap) and make the shape at least 80 high");
    }
    const facts = labelFacts(graph, box.cell);
    if (facts && overflows(facts, box.rect.w, box.rect.h)) {
      add(
        "warning",
        "label-overflow",
        box.cell.id,
        `the label of ${describe(graph, box.cell)} does not fit its ${Math.round(box.rect.w)}×${Math.round(box.rect.h)} box${facts.wrap ? "" : " (no whiteSpace=wrap, so it runs past the sides)"}`,
        facts.wrap ? "make the box bigger or the label shorter (`layout` grows boxes to their labels)" : "add whiteSpace=wrap;html=1 and make the box bigger (`layout` grows boxes to their labels)",
      );
    }
  }

  const ancestors = (cell) => {
    const out = new Set();
    for (let p = cell; p != null; p = model.getParent(p)) out.add(p);
    return out;
  };
  for (const cell of cells) {
    if (!model.isEdge(cell) || isHidden(model, cell)) continue;
    const raw = model.getStyle(cell) ?? "";
    const label = graph.getLabel(cell).trim();
    if (label) {
      const text = labelLines(label, true).join(" ");
      if (!/(^|;)\s*labelBackgroundColor=/.test(raw)) bareEdgeLabels += 1;
      if (textWidth(text, 11, false) > 150) {
        add("warning", "long-edge-label", cell.id, `the edge label "${text.slice(0, 30)}…" is long; it covers the line and the shapes next to it`, "keep an edge label to 1–3 words and move the detail into a shape's text");
      }
    }
    const source = model.getTerminal(cell, true);
    const target = model.getTerminal(cell, false);
    if (!source || !target || !model.isVertex(source) || !model.isVertex(target) || source === target) continue;
    const from = absRect(model, source);
    const to = absRect(model, target);
    if (!from || !to) continue;
    const geo = model.getGeometry(cell);
    const routed = geo?.points != null && geo.points.length > 0;
    const origin = model.getOrigin(model.getParent(cell));
    const a = center(from);
    const b = center(to);
    const path = [a, ...(routed ? geo.points.map((p) => ({ x: p.x + origin.x, y: p.y + origin.y })) : []), b];
    // An unrouted connector is the viewer's to draw: a straight line without
    // an edgeStyle; with one, its router leaves along the longer axis and
    // turns once, so that elbow is tried next to the straight line.
    const bends = /(^|;)\s*edgeStyle=(?!none\b)/.test(raw);
    const elbow = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    const guesses = routed ? [path] : bends ? [path, [a, elbow, b]] : [path];
    const related = new Set([...ancestors(source), ...ancestors(target)]);
    // Leaf shapes only: a line over the body of a group or of a lane it passes is how such diagrams look.
    const hit = leaves.find((box) => {
      if (related.has(box.cell) || model.isAncestor(source, box.cell) || model.isAncestor(target, box.cell)) return false;
      return guesses.some((line) => {
        for (let k = 0; k + 1 < line.length; k++) if (segmentHitsRect(line[k], line[k + 1], box.rect)) return true;
        return false;
      });
    });
    const edgeName = `the edge '${cell.id}' (${describe(graph, source)} → ${describe(graph, target)})`;
    const spot = label ? labelSpot(path, routed, from, to) : null;
    if (spot) {
      const style = graph.getCellStyle(cell);
      const size = typeof style.fontSize === "number" && style.fontSize > 0 ? style.fontSize : 11;
      const lines = labelLines(label, true);
      const w = Math.max(...lines.map((line) => textWidth(line, size, false))) + 6;
      const h = lines.length * size * LINE_HEIGHT + 2;
      const covered = leaves.find((leaf) => intersects({ x: spot.x - w / 2, y: spot.y - h / 2, w, h }, leaf.rect, 2));
      if (covered) {
        add(
          "warning",
          "edge-label-covers-shape",
          cell.id,
          `the label "${lines.join(" ").slice(0, 30)}" of ${edgeName} is about ${Math.round(w)} px wide and covers ${describe(graph, covered.cell)}`,
          "shorten the label (1–3 words), or leave more room between the shapes (the grid of SKILL.md leaves 60 px between columns and 80 px between rows; `layout` leaves room for labels)",
        );
      }
    }
    if (!hit) continue;
    if (routed) {
      add("warning", "edge-through-shape", cell.id, `${edgeName} runs through ${describe(graph, hit.cell)}`, "move that shape off the line, or delete the edge's <Array as=\"points\"> so the line is drawn anew on the next run");
    } else if (!isRightAngled(raw)) {
      add("warning", "edge-may-cross-shape", cell.id, `${edgeName} is a straight, curved or entity-relation line and ${describe(graph, hit.cell)} lies on it`, "move a shape so the line is clear, or make the edge right-angled (edgeStyle=orthogonalEdgeStyle;rounded=1; and no curved=1) and run `route` — `route` leaves other lines as drawn");
    } else if (after === "layout") {
      add("warning", "edge-may-cross-shape", cell.id, `${edgeName} was left to the viewer's own router, and ${describe(graph, hit.cell)} is between its ends`, "run `layout` with --flow down or right (they route every connector), or move that shape");
    } else if (after === "route") {
      add("warning", "edge-may-cross-shape", cell.id, `${edgeName} could not be routed, and ${describe(graph, hit.cell)} is between its ends`, "check both ends are shapes with a size, or move that shape off the line");
    } else {
      add("warning", "edge-may-cross-shape", cell.id, `${edgeName} has ${describe(graph, hit.cell)} between its ends; draw.io's own router does not go around shapes`, "run `route` (keeps every shape where it is) or `layout`");
    }
  }

  if (stencils.size > 0) {
    add("warning", "unbundled-icons", null, `shapes from ${[...stencils].map((name) => `mxgraph.${name}.*`).join(", ")} are drawn as labelled placeholder boxes in the chat preview`, "use labelled rounded rectangles unless the user asked for these icons (they still show in a draw.io app)");
  }
  if (unsizedFonts > 0) {
    add("note", "default-font-size", null, `${unsizedFonts} labelled shape(s) set no fontSize and render at draw.io's 12 px default, which is small once the preview scales the diagram`, "put fontSize=14 in every shape style of a diagram you author (16 for a diagram of more than ~12 shapes)");
  }
  if (bareEdgeLabels > 0) {
    add("note", "edge-label-background", null, `${bareEdgeLabels} edge label(s) have no background, so the line runs through the text`, "add labelBackgroundColor=default to the edge style (`layout` and `route` add it)");
  }
  const right = Math.max(...boxes.map((box) => box.rect.x + box.rect.w));
  const bottom = Math.max(...boxes.map((box) => box.rect.y + box.rect.h));
  const left = Math.min(...boxes.map((box) => box.rect.x));
  const top = Math.min(...boxes.map((box) => box.rect.y));
  if (right - left > 1800 || bottom - top > 1500 || leaves.length > 40) {
    add("note", "large-diagram", null, `the page is ${Math.round(right - left)}×${Math.round(bottom - top)} px with ${leaves.length} shapes; the chat preview scales it down and the text with it`, "split it into pages (one <diagram> per view), or use fontSize=16 on every shape");
  }
}

/**
 * Names of the pages that hold swimlanes: a `swimlane` with a turned title
 * (`horizontal=0`), or two `swimlane` siblings that tile (same x and width,
 * one right under the other; or same y and height, side by side). A layout
 * would move each lane on its own and break the grid the lanes form, so
 * `layout` refuses such a page and `route` is the tool. Titled containers that
 * merely sit next to each other are not lanes.
 */
export function pagesWithLanes(xml) {
  const names = [];
  const near = (a, b) => Math.abs(a - b) <= 2;
  for (const page of pagesOf(xml)) {
    transformPages(page.text, (graph) => {
      const model = graph.getModel();
      const lanes = [];
      for (const cell of allCells(model)) {
        if (!model.isVertex(cell) || shapeName(model.getStyle(cell)) !== "swimlane") continue;
        const geo = model.getGeometry(cell);
        if (geo == null || geo.relative) continue;
        lanes.push({ parent: model.getParent(cell), geo, turned: graph.getCellStyle(cell).horizontal === 0 });
      }
      const tiled = lanes.some((a, i) =>
        lanes.some((b, j) => {
          if (i === j || a.parent !== b.parent) return false;
          const stacked = near(a.geo.x, b.geo.x) && near(a.geo.width, b.geo.width) && near(a.geo.y + a.geo.height, b.geo.y);
          const abreast = near(a.geo.y, b.geo.y) && near(a.geo.height, b.geo.height) && near(a.geo.x + a.geo.width, b.geo.x);
          return stacked || abreast;
        }),
      );
      if (tiled || lanes.some((lane) => lane.turned)) names.push(page.name);
    });
  }
  return names;
}

/**
 * Names of the pages with shapes on more than one layer. ELK arranges the
 * children of ONE layer; the others would stay where they are, under or over
 * the result.
 */
export function pagesWithLayers(xml) {
  const names = [];
  for (const page of pagesOf(xml)) {
    transformPages(page.text, (graph) => {
      const model = graph.getModel();
      const root = model.getRoot();
      let used = 0;
      for (let i = 0; i < model.getChildCount(root); i++) {
        const layer = model.getChildAt(root, i);
        let shapes = false;
        for (let k = 0; k < model.getChildCount(layer); k++) if (model.isVertex(model.getChildAt(layer, k))) shapes = true;
        if (shapes) used += 1;
      }
      if (used > 1) names.push(page.name);
    });
  }
  return names;
}

/** The default layer written as its own parent: well-formed XML that hides the whole page. */
const SELF_PARENTED_LAYER = /<mxCell id="([^"]+)" parent="\1"\s*\/>/;

/**
 * The text the checks and the passes work on. A file that is well-formed is
 * taken as it is (its declaration, comments and formatting stay); only a file
 * that is not gets the mechanical repairs (text around the diagram, `<` or a
 * bare `&` in a value, the layer that is its own parent). `broken` is what
 * still stops it from parsing.
 */
export function repairIfNeeded(xml) {
  const broken = wellFormedError(xml);
  // A diagram wrapped in another element (`<content><mxfile>…`) parses and draws nothing.
  const wrapped = !broken && !["mxfile", "mxGraphModel"].includes(rootName(xml));
  if (!broken && !wrapped && !SELF_PARENTED_LAYER.test(xml)) return { xml, repairs: [], broken: null };
  const repaired = repairDiagramXml(xml);
  return { xml: repaired.xml, repairs: repaired.repairs, broken: wellFormedError(repaired.xml) ? (broken ?? wellFormedError(repaired.xml)) : null };
}

/**
 * Check a .drawio file's text. Returns the findings (errors first) and whether
 * the structure is sound enough for `layout` / `route` to work on.
 */
export function checkDiagram(xml, options = {}) {
  const findings = [];
  const counts = new Map();
  const adder = (page) => (level, code, cell, message, fix) => {
    const seen = (counts.get(code)?.seen ?? 0) + 1;
    counts.set(code, { seen, level });
    if (seen <= MAX_PER_CODE) findings.push({ level, code, page, cell, message, fix });
  };
  const add = adder(null);

  if (typeof xml !== "string" || !/<mx(?:GraphModel|file)[\s>]/.test(xml)) {
    add("error", "not-a-diagram", null, "the file holds no <mxfile> or <mxGraphModel>", "write an mxfile (SKILL.md §1)");
    return finish(findings, counts);
  }
  const repaired = repairIfNeeded(xml);
  if (repaired.broken) {
    add("error", "malformed-xml", null, `the XML is not well-formed: ${repaired.broken.message} (line ${repaired.broken.line})`, "fix that line; nothing renders until the file parses");
  } else if (repaired.repairs.length > 0) {
    add("error", "needs-repair", null, `the file does not draw as written (${repaired.repairs.join(", ")})`, "run `layout` or `route` (both repair this), or fix it yourself: escape &lt; &gt; &amp; &quot; in values, nothing outside <mxfile>, the layer is <mxCell id=\"1\" parent=\"0\"/>");
  }
  // Cells are scanned up to a tag's first `>` and in double quotes only (canonicalAttributes),
  // and a commented-out cell is not a cell.
  const text = repaired.broken ? repaired.xml : canonicalAttributes(withoutComments(repaired.xml));
  const diagramRe = /<diagram\b([^>]*)>([\s\S]*?)<\/diagram>/g;
  let compressed = 0;
  for (let m = diagramRe.exec(text); m !== null; m = diagramRe.exec(text)) {
    const inner = m[2].trim();
    if (inner && !inner.startsWith("<")) {
      compressed += 1;
      const name = decode(parseAttrs(m[1]).name ?? null) ?? "a page";
      adder(name)("note", "compressed-page", null, "the page is deflate-compressed: the viewer draws it, but this tool cannot check it and `layout` / `route` refuse the file", "share it as it is; to edit, lay out or route it, first decode the page and save it as plain <mxGraphModel> XML (SKILL.md §5)");
    }
  }
  const pages = pagesOf(text);
  if (pages.length === 0 && compressed === 0) {
    add("error", "no-page", null, "the file has no <mxGraphModel> page", "write <mxfile><diagram><mxGraphModel><root>…</root></mxGraphModel></diagram></mxfile>");
  }
  for (const page of pages) {
    const pageName = pages.length > 1 ? page.name : null;
    const addForPage = adder(pageName);
    const { cyclic } = structuralFindings(page, addForPage);
    if (cyclic) continue;
    let seen = false;
    transformPages(page.text, (graph) => {
      seen = true;
      try {
        visualFindings(graph, addForPage, options.after ?? null);
      } catch (error) {
        addForPage("note", "check-incomplete", null, `the layout checks stopped early (${error instanceof Error ? error.message : String(error)})`, "the structural checks above still hold");
      }
    });
    if (!seen && !findings.some((finding) => finding.level === "error" && finding.page === pageName)) {
      addForPage("error", "unreadable-page", null, "the page's cells could not be read", "check the <root> element and its <mxCell> children");
    }
  }
  return finish(findings, counts);
}

function finish(findings, counts) {
  const order = { error: 0, warning: 1, note: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  const omitted = [...counts].filter(([, { seen }]) => seen > MAX_PER_CODE).map(([code, { seen }]) => ({ code, more: seen - MAX_PER_CODE }));
  // Totals count every finding, the ones the list leaves out too.
  const total = (level) => [...counts.values()].filter((entry) => entry.level === level).reduce((sum, entry) => sum + entry.seen, 0);
  return { findings, omitted, errors: total("error"), warnings: total("warning"), notes: total("note") };
}

/** The report as the lines the CLI prints. */
export function formatReport(report) {
  const lines = report.findings.map((finding) => {
    const where = [finding.page ? `page "${finding.page}"` : null, finding.cell != null ? `cell '${finding.cell}'` : null].filter(Boolean).join(", ");
    return `${finding.level} [${finding.code}]${where ? ` ${where}:` : ""} ${finding.message} — fix: ${finding.fix}`;
  });
  for (const { code, more } of report.omitted) lines.push(`… and ${more} more [${code}]`);
  const summary =
    report.errors + report.warnings + report.notes === 0
      ? "drawio check: OK"
      : `drawio check: ${report.errors} error(s), ${report.warnings} warning(s), ${report.notes} note(s)`;
  return [...lines, summary];
}
