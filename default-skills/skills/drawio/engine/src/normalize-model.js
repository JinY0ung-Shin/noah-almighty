// Model normalization for generated diagrams.
//
// An mxGraph edge belongs to the nearest common ancestor of its terminals:
// two cells inside one container are connected by an edge that is a child of
// that container, and the edge's coordinates live in that container's frame.
// The editor maintains this itself — every model edit runs
// mxGraphModel.updateEdgeParents — but XML written by an LLM never does: it
// parks every edge on the layer (`parent="1"`), which is the form our own XML
// reference asks for because it renders correctly and keeps the prompt
// simple.
//
// Renders correctly, but does not LAY OUT correctly: ELK reads an edge's
// coordinates in the frame of the node that contains it, so an edge filed on
// the layer while its terminals sit inside a container comes back routed in
// the layer's frame — the connector jumps out of its container (see
// jgraph/drawio-mcp#64). The layout pass is not the place to fix that: a
// layout must not rewrite the cell hierarchy as a side effect. Normalizing
// the diagram before anything else touches it is, and it is exactly what the
// editor would have done to the same file.
//
// Two more mistakes travel with the same diagrams and are repaired in the
// same pass (the full list lives in mx-model.js's normalizeModel, a port of
// drawio-dev's Graph.normalizeModel behind the desktop CLI's --normalize, so
// a diagram repaired here and one repaired by the CLI come out the same):
//
//   - an edge written without a geometry is silently not rendered at all;
//     the standard relative geometry brings it back
//   - a container whose child reaches past its bounds draws that child
//     outside the box; the container is grown to contain it — never shrunk,
//     and no child is moved, so deliberate breathing room survives
//
// The pass needs no layout engine, changes nothing else, and is idempotent: a
// diagram that is already in this shape comes back byte-identical.
//
// One deliberate difference from the editor: a reparented edge's `<mxCell>`
// element stays where it is in the document instead of being moved to the end
// of its new parent's children. Generated XML lists edges after vertices, so
// the element already sorts last among its new siblings; keeping it in place
// makes the rewrite a minimal diff.

import { transformPages } from "./mx-xml.js";

/**
 * Normalizes every page of a diagram: edges at the nearest common ancestor of
 * their terminals (geometry translated into that parent's frame), a geometry
 * for edges written without one, and containers grown around children they
 * would otherwise clip.
 *
 * @param {string} xml - mxGraphModel or mxfile XML
 * @returns {{xml: string, changed: number}} the normalized XML and the number
 *   of cells that were rewritten
 */
export function normalizeDiagram(xml)
{
  return transformPages(xml, function(graph)
  {
    graph.normalizeModel();
  });
}
