// Server-side libavoid edge-routing pass for open_drawio_xml.
//
// The app server runs libavoid in the browser against the live mxGraph model.
// The tool server has no renderer — it just compresses XML into a #R URL
// — so here we run the SAME shared routing core (AvoidRouting.computeRoutes)
// against the headless model shared/mx-xml.js parses out of the XML, and let
// it write the resulting waypoints back before the XML is compressed.
//
// Every page (`<mxGraphModel>`) is routed on its own: cell ids and obstacles
// belong to one page, and a page never sees another page's shapes — the
// same guarantee the ELK layout pass and the normalization get from
// transformPages. Only the routed edges are rewritten; every other byte of
// the document stays as authored. Anything unexpected leaves that page
// unrouted, so a parse hiccup never produces a broken diagram, only an
// un-routed one.

import { AvoidLib } from "../vendor/libavoid/libavoid-node.mjs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(__dirname, "..", "vendor", "libavoid", "libavoid.wasm");

// The routing core is libavoid-routing.js (canonical source: drawio-dev
// js/libavoid-js/ — the same artifact the draw.io editor bundles and the app
// server loads from the CDN). It is a plain browser script that assigns
// globalThis.AvoidRouting. Loaded through the ETag-revalidated per-user disk
// cache (cdn-cache.js: primed by npm postinstall, refreshed from the
// viewer.diagrams.net CDN only when the file actually changed — a 304
// otherwise), so routing fixes ship with draw.io releases without
// re-vendoring here; the vendored copy is the last fallback (CDN unreachable
// with a cold cache, path not yet in a release, or the source failing the
// sanity check below). The WASM glue + binary stay vendored either way: the
// CDN only serves the browser build of the glue, and the core is
// deliberately compatible with the bindings both builds expose. One
// revalidation per process (memoized like the wasm load).
import { loadCachedSource, ROUTING_CORE } from "./cdn-cache.js";

let routingPromise = null;

// Indirect eval runs in global scope, where the script's IIFE assigns
// globalThis.AvoidRouting — the same effect as a side-effect import. Throws
// on unusable source, so loadCoreSource never caches or returns one. The
// global is cleared first: loadCoreSource validates the cached copy before
// a download, and its leftover global must not vouch for a fresh body that
// fails to define AvoidRouting itself.
function evalRoutingCore(src)
{
  delete globalThis.AvoidRouting;

  (0, eval)(src);

  if (globalThis.AvoidRouting == null ||
    typeof globalThis.AvoidRouting.computeRoutes !== "function")
  {
    throw new Error("AvoidRouting missing after eval");
  }
}

function getRouting()
{
  if (routingPromise == null)
  {
    routingPromise = loadCachedSource(ROUTING_CORE, evalRoutingCore).then(function(src)
    {
      // Evaluate the returned choice: a NEWER download that failed
      // validation is evaluated (clearing the global) AFTER the cached
      // copy loadCachedSource falls back to, so the last eval doesn't
      // necessarily match the returned source. Eval is idempotent and the
      // file is tiny.
      evalRoutingCore(src);

      return globalThis.AvoidRouting;
    }).catch(function(e)
    {
      // stderr — stdout carries the MCP protocol
      console.error("[libavoid] routing core CDN/cache unavailable (" +
        (e && e.message) + "); using the vendored copy");

      // A script without import/export is valid ESM; import it for its
      // side effect and read the global.
      return import("../vendor/libavoid/libavoid-routing.js")
        .then(function() { return globalThis.AvoidRouting; });
    });
  }

  return routingPromise;
}

// Lazy, memoized — the wasm only loads when routing is actually requested.
let avoidPromise = null;

function getAvoid()
{
  if (avoidPromise == null)
  {
    avoidPromise = AvoidLib.load(WASM_PATH).then(function()
    {
      return AvoidLib.getInstance();
    });
  }

  return avoidPromise;
}

// shared/mx-model.js + shared/mx-xml.js, copied into src/ by copy-shared —
// same local-copy-then-repo import as elk-pass.js, so an in-repo run works
// without the copy. Memoized.
let sharedPromise = null;

function loadShared()
{
  if (!sharedPromise)
  {
    sharedPromise = Promise.all([
      import("./mx-model.js").catch(function()
      {
        return import("../../shared/mx-model.js");
      }),
      import("./mx-xml.js").catch(function()
      {
        return import("../../shared/mx-xml.js");
      }),
    ]).then(function(mods)
    {
      return { model: mods[0], xml: mods[1] };
    });
  }

  return sharedPromise;
}

// Absolute offset of a cell's frame: the summed geometries of its vertex
// ancestors (a container's children are positioned relative to it).
function parentOffset(model, cell)
{
  var x = 0, y = 0;
  var p = model.getParent(cell);

  while (p != null && model.isVertex(p))
  {
    var geo = model.getGeometry(p);

    if (geo != null)
    {
      x += geo.x;
      y += geo.y;
    }

    p = model.getParent(p);
  }

  return { x: x, y: y };
}

// Parse an mxGraph style string ("key=value;key2=value2;…") into a map.
// Valueless tokens (shape names) are skipped — every key read here is k=v.
function parseStyleMap(style)
{
  var map = {};
  var parts = (style || "").split(";");

  for (var i = 0; i < parts.length; i++)
  {
    var eq = parts[i].indexOf("=");
    if (eq > 0) map[parts[i].substring(0, eq).trim()] = parts[i].substring(eq + 1);
  }

  return map;
}

// A fixed connection point on one end of an edge (exitX/exitY for the source,
// entryX/entryY for the target) as {x, y, dir} via
// AvoidRouting.constraintForPoint (clamps to the pin's [0,1] domain, derives
// the ConnDirFlags from the original values). null for a floating endpoint.
// Mirrors LibavoidRouting.fixedConstraint in the draw.io editor. The Routing
// param is the loaded AvoidRouting namespace (getRouting()).
function fixedConstraint(Routing, styleMap, source)
{
  // exitPerimeter/entryPerimeter=0 lets a flip move the point on a
  // transformed terminal (see shapeFrame); older cores ignore the argument.
  return Routing.constraintForPoint(
    parseFloat(styleMap[source ? "exitX" : "entryX"]),
    parseFloat(styleMap[source ? "exitY" : "entryY"]),
    styleMap[source ? "exitPerimeter" : "entryPerimeter"] != "0");
}

// The transform a vertex's style applies to its connection points —
// rotation, direction, flips (AvoidRouting.shapeFrame) — so the core routes
// around the box the shape is drawn in and pins each end where the shape
// draws its connection point. Legacy stencilFlipH/V need to know whether the
// shape is a stencil, which only a renderer does; they are ignored here. A
// core from before rotation support has no shapeFrame: the shape then
// routes unrotated, as it always did.
function shapeFrame(Routing, style)
{
  return (typeof Routing.shapeFrame === "function") ?
    Routing.shapeFrame(style, false) : null;
}

// Resolved jetty size (minimum first/last segment length, px) for one end,
// mirroring mxEdgeStyle.getJettySize: sourceJettySize/targetJettySize over
// jettySize, with 'auto' derived from the end's arrow size. Two server-side
// adaptations: a missing jettySize resolves as 'auto' (what setEdgeStyle
// writes back, so the route matches a later in-editor re-route) and missing
// arrows mean the editor's stylesheet defaults (endArrow=classic, no
// startArrow) — the tool server has no stylesheet to merge.
function jettyFor(styleMap, source)
{
  var value = styleMap[source ? "sourceJettySize" : "targetJettySize"];
  if (value == null) value = styleMap.jettySize;
  if (value == null) value = "auto";

  if (value === "auto")
  {
    var type = styleMap[source ? "startArrow" : "endArrow"];
    if (type == null) type = source ? "none" : "classic";

    if (type !== "none")
    {
      var size = parseFloat(styleMap[source ? "startSize" : "endSize"]);
      if (isNaN(size)) size = 6; // mxConstants.DEFAULT_MARKERSIZE
      value = Math.max(2, Math.ceil((size + 10) / 10)) * 10; // orthBuffer 10
    }
    else
    {
      value = 20; // 2 * orthBuffer
    }
  }

  value = parseFloat(value);
  return isNaN(value) ? 0 : value;
}

// Apply the canonical libavoid edge style on an mxGraph style string, preserving
// every other key (stroke, arrows, colors, …). libavoidRouting=1 keeps the edge
// auto-routing via libavoid if the diagram is later opened and edited in the
// draw.io editor; rounded/orthogonalLoop/jettySize match what the editor's
// libavoid checkbox pairs with the flag. An explicit jettySize is preserved
// (the route was computed with it — see jettyFor); only a missing one gets the
// editor default 'auto'.
function setEdgeStyle(style)
{
  var kept = [];
  var parts = (style || "").split(";");
  var managed = {
    edgeStyle: 1, rounded: 1, curved: 1,
    libavoidRouting: 1, orthogonalLoop: 1, html: 1
  };
  // Same tokenization as jettyFor (parseStyleMap), so the written-back style
  // always matches the route just computed — a malformed token (bare
  // 'jettySize' with no value) must not suppress the default.
  var hasJetty = parseStyleMap(style).jettySize != null;

  for (var i = 0; i < parts.length; i++)
  {
    var p = parts[i].trim();
    if (p === "") continue;
    var key = p.split("=")[0];
    if (managed[key]) continue;
    kept.push(p);
  }

  kept.push("edgeStyle=orthogonalEdgeStyle");
  kept.push("rounded=0");
  kept.push("libavoidRouting=1");
  kept.push("orthogonalLoop=1");
  if (!hasJetty) kept.push("jettySize=auto");
  kept.push("html=1");
  return kept.join(";") + ";";
}

/**
 * Route the edges of a draw.io XML document with libavoid, one page at a
 * time. Returns the XML with orthogonal obstacle-avoiding waypoints written
 * onto each edge, or the original XML unchanged if there's nothing to route
 * or anything goes wrong.
 *
 * @param {string} xml - mxGraphModel or mxfile XML
 * @returns {Promise<string>}
 */
export async function routeXml(xml)
{
  try
  {
    if (typeof xml !== "string" || xml.indexOf("<mxCell") === -1) return xml;

    // All three are memoized per process. The routing core is tiny; the
    // wasm is the expensive one, but routing was explicitly asked for.
    var Routing = await getRouting();
    var Avoid = await getAvoid();
    var shared = await loadShared();

    return shared.xml.transformPages(xml, function(graph)
    {
      routeGraph(graph, Routing, Avoid, shared.model);
    }).xml;
  }
  catch (e)
  {
    // Never break the diagram — fall back to the un-routed XML.
    return xml;
  }
}

// Routes one page's model: every vertex is an obstacle, every edge between
// two vertices gets a route, in absolute model coordinates. Mirrors
// routeWithLibavoid in the app server. The write-back picks up the edges'
// new geometries and styles; a page that throws stays as authored
// (transformPages' own error handling). `mx` is the mx-model module.
function routeGraph(graph, Routing, Avoid, mx)
{
  var model = graph.getModel();
  var vertices = [];
  var edges = [];
  var id;

  // mxGraphModel.cells: every cell by id, added in tree order. The editor
  // and the app server collect with for-in over that map, and libavoid's
  // nudging depends on the order shapes and connectors are registered in,
  // so the same map gives the same routes.
  var cells = Object.create(null);

  (function add(cell)
  {
    cells[cell.id] = cell;

    for (var i = 0; i < model.getChildCount(cell); i++)
    {
      add(model.getChildAt(cell, i));
    }
  })(model.getRoot());

  for (id in cells)
  {
    var cell = cells[id];

    if (model.isVertex(cell))
    {
      var geo = model.getGeometry(cell);

      if (geo != null && geo.width > 0 && geo.height > 0)
      {
        // Unrotated bounds plus the style's transform (named styles
        // resolved by getCellStyle): the core turns them into the drawn box.
        var off = parentOffset(model, cell);
        vertices.push({ id: id, x: geo.x + off.x, y: geo.y + off.y,
          w: geo.width, h: geo.height,
          frame: shapeFrame(Routing, graph.getCellStyle(cell)) });
      }
    }
    else if (model.isEdge(cell))
    {
      var s = model.getTerminal(cell, true);
      var t = model.getTerminal(cell, false);

      if (model.isVertex(s) && model.isVertex(t))
      {
        // Fixed connection points (exitX/entryX…) route via directed pins and
        // the per-end jettySize gives their minimum stub — like the editor.
        var sm = parseStyleMap(model.getStyle(cell));
        edges.push({ id: id, source: s.id, target: t.id,
          sourceConstraint: fixedConstraint(Routing, sm, true),
          targetConstraint: fixedConstraint(Routing, sm, false),
          sourceJetty: jettyFor(sm, true),
          targetJetty: jettyFor(sm, false) });
      }
    }
  }

  if (edges.length === 0) return;

  var routes = Routing.computeRoutes(Avoid, vertices, edges);

  for (id in routes)
  {
    var edge = cells[id];
    var eOff = parentOffset(model, edge);
    var eGeo = model.getGeometry(edge);

    // The routes are absolute; waypoints live in the edge's parent frame.
    eGeo = (eGeo != null) ? eGeo.clone() : new mx.MxGeometry();
    eGeo.relative = true;
    eGeo.points = routes[id].map(function(p)
    {
      return new mx.MxPoint(p.x - eOff.x, p.y - eOff.y);
    });

    model.setGeometry(edge, eGeo);
    model.setStyle(edge, setEdgeStyle(model.getStyle(edge)));
  }
}
