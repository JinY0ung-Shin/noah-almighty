// Headless mxGraph model for the servers' diagram passes.
//
// Two things need a model server-side: the drawio-elk bridge (ElkLayout /
// ElkAdapter / ElkApplier), which is written against mxGraph — it walks a
// model, reads resolved cell styles and writes geometries and styles back —
// and normalize-model.js, which repairs a generated diagram with
// mxGraphModel's own updateEdgeParents and friends. The editor hands the bridge a real Graph; here there is
// no renderer, so this module provides the slice of mxGraph those passes
// actually touch — nothing more:
//
//   model   getGeometry/setGeometry, getStyle/setStyle, isVertex/isEdge,
//           isVisible, getChildCount/getChildAt, getParent, getTerminal,
//           getEdgeCount/getEdgeAt/getEdges, beginUpdate/endUpdate, plus the
//           ancestry/reparenting set updateEdgeParent needs (getRoot,
//           getOrigin, isAncestor, getNearestCommonAncestor, add)
//   graph   getModel, getDefaultParent, getCellStyle, getLabel, resetEdge,
//           isCellMovable
//   globals mxPoint, mxConstants, mxUtils
//
// Deliberately NOT provided: `graph.view` (every bridge call site is guarded
// and falls back to geometry-based sizing, which is what we want — the XML's
// geometry is the authority, there is nothing rendered to measure) and
// `mxUtils.setStyle` (the bridge carries a faithful port and uses it when the
// global is absent, so there is one implementation instead of two).
//
// Style resolution mirrors mxStylesheet.getCellStyle EXACTLY, including its
// quirks — numeric values become numbers, `none` deletes the key — so a
// layout computed here matches what the editor computes for the same
// diagram. Bug-compatible beats better here.

// ─── mxGraph globals ─────────────────────────────────────────────

export function MxPoint(x, y)
{
  this.x = (x != null) ? x : 0;
  this.y = (y != null) ? y : 0;
}

MxPoint.prototype.clone = function()
{
  return new MxPoint(this.x, this.y);
};

// Only the keys the bridge reads. Values are mxConstants verbatim.
const MX_CONSTANTS = {
  NONE: "none",
  DEFAULT_STARTSIZE: 40,
  DEFAULT_FONTSIZE: 12,
  EDGESTYLE_ORTHOGONAL: "orthogonalEdgeStyle",
  SHAPE_RECTANGLE: "rectangle",
  SHAPE_CONNECTOR: "connector",
  STYLE_SHAPE: "shape",
  STYLE_PERIMETER: "perimeter",
  STYLE_EDGE: "edgeStyle",
  STYLE_CURVED: "curved",
  STYLE_ROUNDED: "rounded",
  STYLE_ORTHOGONAL: "orthogonal",
  STYLE_NOEDGESTYLE: "noEdgeStyle",
  STYLE_STARTSIZE: "startSize",
  STYLE_EXIT_X: "exitX",
  STYLE_EXIT_Y: "exitY",
  STYLE_ENTRY_X: "entryX",
  STYLE_ENTRY_Y: "entryY",
  STYLE_FONTSIZE: "fontSize",
  STYLE_FONTFAMILY: "fontFamily",
  STYLE_FONTSTYLE: "fontStyle",
  STYLE_ALIGN: "align",
  STYLE_VERTICAL_ALIGN: "verticalAlign",
  STYLE_LABEL_POSITION: "labelPosition",
  STYLE_VERTICAL_LABEL_POSITION: "verticalLabelPosition",
};

// mxUtils.isNumeric verbatim - decides which style values become numbers.
function isNumeric(n)
{
  return !isNaN(parseFloat(n)) && isFinite(n) &&
    (typeof n !== "string" || n.toLowerCase().indexOf("x") < 0);
}

function clone(obj)
{
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(clone);
  if (typeof obj.clone === "function") return obj.clone();

  var copy = {};

  for (var k in obj)
  {
    copy[k] = clone(obj[k]);
  }

  return copy;
}

// Estimated text bounds, in place of mxUtils.getSizeForString (which measures
// a rendered DOM node). Used by the adapter only to reserve room for labels,
// so an estimate is enough - but a better one than the bridge's own fallback
// (7px per character, one line, font size ignored), which is what runs when
// this is absent. Average glyph advance of the draw.io default font is close
// to 0.6em; line breaks and <br> count as lines.
function getSizeForString(text, fontSize, fontFamily, textWidth, fontStyle)
{
  var size = (fontSize != null && !isNaN(fontSize)) ?
    fontSize : MX_CONSTANTS.DEFAULT_FONTSIZE;
  var bold = (fontStyle != null && (parseInt(fontStyle) & 1) === 1);
  var lines = String(text == null ? "" : text).split(/<br\s*\/?>|\n/);
  var longest = 0;

  for (var i = 0; i < lines.length; i++)
  {
    longest = Math.max(longest, lines[i].replace(/<[^>]*>/g, "").length);
  }

  return {
    width: Math.ceil(longest * size * (bold ? 0.64 : 0.6)),
    height: Math.ceil(lines.length * size * 1.2),
  };
}

/**
 * Installs the mxGraph globals the drawio-elk bridge reads at runtime. Safe
 * to call repeatedly; existing globals (a real mxGraph, or a previous call)
 * are left alone.
 */
export function installMxGlobals()
{
  if (globalThis.mxPoint == null) globalThis.mxPoint = MxPoint;
  if (globalThis.mxConstants == null) globalThis.mxConstants = MX_CONSTANTS;

  if (globalThis.mxUtils == null)
  {
    globalThis.mxUtils = { clone: clone, getSizeForString: getSizeForString };
  }
}

// ─── Model ───────────────────────────────────────────────────────

export function MxGeometry(x, y, width, height)
{
  this.x = (x != null) ? x : 0;
  this.y = (y != null) ? y : 0;
  this.width = (width != null) ? width : 0;
  this.height = (height != null) ? height : 0;
  this.relative = false;
  this.points = null;
  this.offset = null;
  this.sourcePoint = null;
  this.targetPoint = null;
}

MxGeometry.prototype.clone = function()
{
  var geo = new MxGeometry(this.x, this.y, this.width, this.height);

  geo.relative = this.relative;
  geo.offset = (this.offset != null) ? this.offset.clone() : null;
  geo.sourcePoint = (this.sourcePoint != null) ? this.sourcePoint.clone() : null;
  geo.targetPoint = (this.targetPoint != null) ? this.targetPoint.clone() : null;
  geo.points = (this.points != null) ? this.points.map(function(p)
  {
    return p.clone();
  }) : null;
  // The source element's attributes and any child elements this pass doesn't
  // model (alternateBounds, …) ride along untouched, so the write-back can
  // restore them verbatim on a geometry the bridge cloned.
  geo.origAttrs = this.origAttrs;
  geo.extraXml = this.extraXml;

  return geo;
};

MxGeometry.prototype.getTerminalPoint = function(isSource)
{
  return isSource ? this.sourcePoint : this.targetPoint;
};

// mxGeometry.translate. mxGeometry.TRANSLATE_CONTROL_POINTS is true in
// mxGraph, so the waypoints move with the geometry; a relative geometry's
// x/y are a position ON the edge, not a coordinate, and stay put.
MxGeometry.prototype.translate = function(dx, dy)
{
  dx = parseFloat(dx);
  dy = parseFloat(dy);

  if (!this.relative)
  {
    this.x = parseFloat(this.x) + dx;
    this.y = parseFloat(this.y) + dy;
  }

  if (this.sourcePoint != null)
  {
    this.sourcePoint.x = parseFloat(this.sourcePoint.x) + dx;
    this.sourcePoint.y = parseFloat(this.sourcePoint.y) + dy;
  }

  if (this.targetPoint != null)
  {
    this.targetPoint.x = parseFloat(this.targetPoint.x) + dx;
    this.targetPoint.y = parseFloat(this.targetPoint.y) + dy;
  }

  if (this.points != null)
  {
    for (var i = 0; i < this.points.length; i++)
    {
      if (this.points[i] != null)
      {
        this.points[i].x = parseFloat(this.points[i].x) + dx;
        this.points[i].y = parseFloat(this.points[i].y) + dy;
      }
    }
  }
};

MxGeometry.prototype.setTerminalPoint = function(point, isSource)
{
  if (isSource) this.sourcePoint = point;
  else this.targetPoint = point;

  return point;
};

export function MxCell(id, value, style)
{
  this.id = id;
  this.value = (value != null) ? value : null;
  this.style = (style != null) ? style : null;
  this.vertex = false;
  this.edge = false;
  this.visible = true;
  this.parent = null;
  this.children = [];
  this.edges = [];
  this.source = null;
  this.target = null;
  this.geometry = null;
}

export function MxGraphModel(root)
{
  this.root = root;
  this.updateLevel = 0;
  // Cells whose geometry, style or parent a pass changed - the write-back
  // only touches these, so everything else stays byte-identical in the XML.
  this.changedGeometry = new Set();
  this.changedStyle = new Set();
  this.changedParent = new Set();
}

MxGraphModel.prototype.getGeometry = function(cell)
{
  return (cell != null) ? cell.geometry : null;
};

// A write that changes nothing is not a change: updateEdgeParent always
// hands over a translated clone, and a converged layout re-run writes the
// same numbers back. Comparing by value keeps those out of the dirty set, so
// the write-back leaves the element (and its formatting) alone.
function pointEquals(a, b)
{
  if (a == null || b == null) return a == b;

  return a.x === b.x && a.y === b.y;
}

function geometryEquals(a, b)
{
  if (a == null || b == null) return a == b;

  if (a.x !== b.x || a.y !== b.y || a.width !== b.width ||
    a.height !== b.height || !!a.relative !== !!b.relative)
  {
    return false;
  }

  if (!pointEquals(a.offset, b.offset) ||
    !pointEquals(a.sourcePoint, b.sourcePoint) ||
    !pointEquals(a.targetPoint, b.targetPoint))
  {
    return false;
  }

  var pa = a.points || [];
  var pb = b.points || [];

  if (pa.length !== pb.length) return false;

  for (var i = 0; i < pa.length; i++)
  {
    if (!pointEquals(pa[i], pb[i])) return false;
  }

  return true;
}

MxGraphModel.prototype.setGeometry = function(cell, geometry)
{
  if (cell != null)
  {
    if (!geometryEquals(cell.geometry, geometry))
    {
      this.changedGeometry.add(cell);
    }

    cell.geometry = geometry;
  }

  return geometry;
};

MxGraphModel.prototype.getStyle = function(cell)
{
  return (cell != null) ? cell.style : null;
};

MxGraphModel.prototype.setStyle = function(cell, style)
{
  if (cell != null && cell.style !== style)
  {
    cell.style = style;
    this.changedStyle.add(cell);
  }

  return style;
};

MxGraphModel.prototype.isVertex = function(cell)
{
  return cell != null && cell.vertex === true;
};

MxGraphModel.prototype.isEdge = function(cell)
{
  return cell != null && cell.edge === true;
};

MxGraphModel.prototype.isVisible = function(cell)
{
  return cell != null && cell.visible !== false;
};

MxGraphModel.prototype.getChildCount = function(cell)
{
  return (cell != null && cell.children != null) ? cell.children.length : 0;
};

MxGraphModel.prototype.getChildAt = function(cell, index)
{
  return (cell != null && cell.children != null) ? cell.children[index] : null;
};

MxGraphModel.prototype.getParent = function(cell)
{
  return (cell != null) ? cell.parent : null;
};

MxGraphModel.prototype.getTerminal = function(edge, isSource)
{
  if (edge == null) return null;

  return isSource ? edge.source : edge.target;
};

MxGraphModel.prototype.getEdgeCount = function(cell)
{
  return (cell != null && cell.edges != null) ? cell.edges.length : 0;
};

MxGraphModel.prototype.getEdgeAt = function(cell, index)
{
  return (cell != null && cell.edges != null) ? cell.edges[index] : null;
};

// mxGraphModel.getEdges(cell, incoming, outgoing, includeLoops)
MxGraphModel.prototype.getEdges = function(cell, incoming, outgoing, includeLoops)
{
  incoming = (incoming != null) ? incoming : true;
  outgoing = (outgoing != null) ? outgoing : true;
  includeLoops = (includeLoops != null) ? includeLoops : true;

  var result = [];
  var count = this.getEdgeCount(cell);

  for (var i = 0; i < count; i++)
  {
    var edge = this.getEdgeAt(cell, i);
    var source = this.getTerminal(edge, true);
    var target = this.getTerminal(edge, false);

    if ((includeLoops && source === target) ||
      ((source !== target) && ((incoming && target === cell) ||
        (outgoing && source === cell))))
    {
      result.push(edge);
    }
  }

  return result;
};

// mxGraphModel.getRoot: the model root, or the topmost ancestor of `cell`.
MxGraphModel.prototype.getRoot = function(cell)
{
  var root = cell || this.root;

  if (cell != null)
  {
    while (cell != null)
    {
      root = cell;
      cell = this.getParent(cell);
    }
  }

  return root;
};

// ─── Ancestry + reparenting (mxGraphModel, ports for updateEdgeParent) ──

MxGraphModel.prototype.isAncestor = function(parent, child)
{
  while (child != null && child != parent)
  {
    child = this.getParent(child);
  }

  return child == parent;
};

// The absolute origin of a cell: the summed geometry offsets of its vertex
// ancestors. Recursive, like mxGraphModel.getOrigin.
MxGraphModel.prototype.getOrigin = function(cell)
{
  var result;

  if (cell != null)
  {
    result = this.getOrigin(this.getParent(cell));

    if (!this.isEdge(cell))
    {
      var geo = this.getGeometry(cell);

      if (geo != null)
      {
        result.x += geo.x;
        result.y += geo.y;
      }
    }
  }
  else
  {
    result = new MxPoint();
  }

  return result;
};

// mxGraphModel.getNearestCommonAncestor, without mxCellPath: walk up from
// the shallower cell and return the first STRICT ancestor of the other that
// is not the root itself (mxGraph expresses both conditions through the cell
// path prefix and its `parent != null` check).
MxGraphModel.prototype.getNearestCommonAncestor = function(cell1, cell2)
{
  if (cell1 == null || cell2 == null) return null;

  var depth = function(cell, model)
  {
    var n = 0;

    while (cell != null) { cell = model.getParent(cell); n++; }

    return n;
  };

  // Ties keep cell1, as mxGraph's length comparison does.
  var cell = (depth(cell1, this) <= depth(cell2, this)) ? cell1 : cell2;
  var other = (cell === cell1) ? cell2 : cell1;

  while (cell != null)
  {
    var parent = this.getParent(cell);

    if (parent != null && cell !== other && this.isAncestor(cell, other))
    {
      return cell;
    }

    cell = parent;
  }

  return null;
};

// mxGraphModel.add, reduced to what reparenting needs: move the child to the
// end of the new parent's children.
MxGraphModel.prototype.add = function(parent, child, index)
{
  if (parent == null || child == null || parent === child) return child;

  var previous = this.getParent(child);

  if (previous != null)
  {
    var at = previous.children.indexOf(child);

    if (at >= 0) previous.children.splice(at, 1);
  }

  child.parent = parent;
  parent.children.splice((index != null) ? index : parent.children.length,
    0, child);
  this.changedParent.add(child);

  return child;
};

// draw.io sets mxGraphModel.ignoreRelativeEdgeParent = false (Graph.js), so
// only the SOURCE side climbs out of relative children. Kept as a flag to
// stay readable against the original.
MxGraphModel.prototype.ignoreRelativeEdgeParent = false;

/**
 * mxGraphModel.updateEdgeParent: files the edge at the nearest common
 * ancestor of its terminals (the parent of the source for a self-loop),
 * translating the edge's geometry into the new parent's frame. No-op when
 * the edge already sits there, when a terminal is outside `root`, or when
 * the ancestor is a layer the edge isn't already inside.
 *
 * @param {MxCell} edge
 * @param {MxCell} root - the model root (mxGraph passes the layout root)
 */
MxGraphModel.prototype.updateEdgeParent = function(edge, root)
{
  var source = this.getTerminal(edge, true);
  var target = this.getTerminal(edge, false);
  var cell = null;

  // Uses the first non-relative descendants of the source terminal
  while (source != null && !this.isEdge(source) &&
    source.geometry != null && source.geometry.relative)
  {
    source = this.getParent(source);
  }

  // Uses the first non-relative descendants of the target terminal
  while (target != null && this.ignoreRelativeEdgeParent &&
    !this.isEdge(target) && target.geometry != null &&
    target.geometry.relative)
  {
    target = this.getParent(target);
  }

  if (this.isAncestor(root, source) && this.isAncestor(root, target))
  {
    if (source == target)
    {
      cell = this.getParent(source);
    }
    else
    {
      cell = this.getNearestCommonAncestor(source, target);
    }

    if (cell != null && (this.getParent(cell) != this.root ||
      this.isAncestor(cell, edge)) && this.getParent(edge) != cell)
    {
      var geo = this.getGeometry(edge);

      if (geo != null)
      {
        var origin1 = this.getOrigin(this.getParent(edge));
        var origin2 = this.getOrigin(cell);

        var dx = origin2.x - origin1.x;
        var dy = origin2.y - origin1.y;

        geo = geo.clone();
        geo.translate(-dx, -dy);
        this.setGeometry(edge, geo);
      }

      this.add(cell, edge, this.getChildCount(cell));
    }
  }
};

/**
 * mxGraphModel.updateEdgeParents: children first, then every edge connected
 * to `cell`. The traversal order is the one the editor runs, so the edges a
 * pass reparents end up in the same order the editor would produce.
 *
 * @param {MxCell} cell
 * @param {MxCell} [root]
 */
MxGraphModel.prototype.updateEdgeParents = function(cell, root)
{
  // Gets the topmost node of the hierarchy
  root = root || this.getRoot(cell);

  // Updates edges on children first
  var childCount = this.getChildCount(cell);

  for (var i = 0; i < childCount; i++)
  {
    var child = this.getChildAt(cell, i);
    this.updateEdgeParents(child, root);
  }

  // Updates the parents of all connected edges
  var edgeCount = this.getEdgeCount(cell);
  var edges = [];

  for (var i = 0; i < edgeCount; i++)
  {
    edges.push(this.getEdgeAt(cell, i));
  }

  for (var i = 0; i < edges.length; i++)
  {
    var edge = edges[i];

    // Updates edge parent if edge and child have a common root node (does
    // not need to be the model root node)
    if (this.isAncestor(root, edge))
    {
      this.updateEdgeParent(edge, root);
    }
  }
};

// No events, no undo history: the bridge brackets its writes in these, and
// the write-back reads the finished model.
MxGraphModel.prototype.beginUpdate = function()
{
  this.updateLevel++;
};

MxGraphModel.prototype.endUpdate = function()
{
  this.updateLevel--;
};

// ─── Graph ───────────────────────────────────────────────────────

// draw.io's default stylesheet, reduced to the keys the bridge reads:
// `styles/default.xml` in drawio-dev, the same table the editor and the
// viewer (and therefore the app server's postLayout) resolve styles against.
// A style token without '=' is a named style - `swimlane;startSize=30;`
// resolves shape=swimlane through this map, and without it a swimlane would
// lay out as a plain box and its children would land under the title bar.
// Numbers are stored as numbers, matching mxStylesheetCodec's parseFloat.
const NAMED_STYLES = {
  defaultVertex: { shape: "label", perimeter: "rectanglePerimeter",
    fontSize: 12, fontFamily: "Helvetica" },
  defaultEdge: { shape: "connector", fontSize: 11, fontFamily: "Helvetica",
    rounded: 1 },
  edgeLabel: { fontSize: 11 },
  label: { fontStyle: 1, rounded: 1 },
  icon: { fontStyle: 0, rounded: 1, verticalLabelPosition: "bottom" },
  swimlane: { shape: "swimlane", fontSize: 12, fontStyle: 1, startSize: 23 },
  ellipse: { shape: "ellipse", perimeter: "ellipsePerimeter" },
  rhombus: { shape: "rhombus", perimeter: "rhombusPerimeter" },
  triangle: { shape: "triangle", perimeter: "trianglePerimeter" },
  line: { shape: "line" },
  image: { shape: "image", verticalLabelPosition: "bottom" },
  roundImage: { shape: "image", verticalLabelPosition: "bottom",
    perimeter: "ellipsePerimeter" },
  rhombusImage: { shape: "image", verticalLabelPosition: "bottom",
    perimeter: "rhombusPerimeter" },
  arrow: { shape: "arrow", edgeStyle: "none" },
  group: {},
  text: {},
};

export function MxGraph(model, defaultParent)
{
  this.model = model;
  this.defaultParent = defaultParent;
  this._styleCache = new Map();
}

MxGraph.prototype.getModel = function()
{
  return this.model;
};

MxGraph.prototype.getDefaultParent = function()
{
  return this.defaultParent;
};

/**
 * mxStylesheet.getCellStyle over the cell's style string: draw.io's default
 * vertex/edge style as the base, named styles merged in, `key=value` pairs
 * on top - numeric values parsed to numbers, `none` deleting the key. A
 * named style this table doesn't carry resolves to nothing, exactly as an
 * unknown name does in mxStylesheet.
 */
MxGraph.prototype.getCellStyle = function(cell)
{
  if (cell == null) return {};

  var name = this.model.getStyle(cell);
  var isEdge = this.model.isEdge(cell);
  var key = (isEdge ? "e:" : "v:") + (name || "");
  var cached = this._styleCache.get(key);

  if (cached != null) return cached;

  var style = {};
  var base = isEdge ? NAMED_STYLES.defaultEdge : NAMED_STYLES.defaultVertex;
  var k;

  // A leading ';' means "ignore the defaults" in mxStylesheet.
  if (name == null || name.length === 0 || name.charAt(0) !== ";")
  {
    for (k in base) style[k] = base[k];
  }

  var pairs = (name || "").split(";");

  for (var i = 0; i < pairs.length; i++)
  {
    var pos = pairs[i].indexOf("=");

    if (pos < 0)
    {
      var named = Object.prototype.hasOwnProperty.call(NAMED_STYLES, pairs[i])
        ? NAMED_STYLES[pairs[i]] : null;

      if (named != null)
      {
        for (k in named) style[k] = named[k];
      }

      continue;
    }

    var sKey = pairs[i].substring(0, pos);
    var value = pairs[i].substring(pos + 1);

    if (value === MX_CONSTANTS.NONE) delete style[sKey];
    else if (isNumeric(value)) style[sKey] = parseFloat(value);
    else style[sKey] = value;
  }

  this._styleCache.set(key, style);

  return style;
};

// The cell's label. `value` is always a plain string here: a cell wrapped in
// an <object>/<UserObject> element (draw.io's metadata form) carries its text
// in that element's label attribute, and the parser stores it on the cell.
MxGraph.prototype.getLabel = function(cell)
{
  if (cell == null || typeof cell.value !== "string") return "";

  return cell.value;
};

// mxGraph.resetEdge - drops the waypoints so the router re-computes them.
MxGraph.prototype.resetEdge = function(cell)
{
  var geo = this.model.getGeometry(cell);

  if (geo != null && geo.points != null && geo.points.length > 0)
  {
    geo = geo.clone();
    geo.points = [];
    this.model.setGeometry(cell, geo);
  }

  return cell;
};

// No locked cells server-side: every vertex is free to move.
MxGraph.prototype.isCellMovable = function()
{
  return true;
};

// ─── Normalization (mirrors Graph.prototype.normalizeModel) ──────

// drawio's transparentBounds cells keep their geometry pinned at (0,0,0,0) —
// their rendered box is derived from their children — so no bounds pass may
// touch them. Same check the drawio-elk bridge makes (raw style token).
MxGraph.prototype.isTransparentBounds = function(cell)
{
  var style = this.model.getStyle(cell);

  if (style == null) return false;

  var parts = style.split(";");

  for (var i = 0; i < parts.length; i++)
  {
    if (parts[i] === "transparentBounds=1") return true;
  }

  return false;
};

// mxUtils.getBoundingBox: the axis-aligned box of a rectangle rotated around
// its center.
function rotatedBounds(rect, rotation)
{
  var rad = rotation * Math.PI / 180;
  var cos = Math.cos(rad);
  var sin = Math.sin(rad);
  var cx = rect.x + rect.width / 2;
  var cy = rect.y + rect.height / 2;

  var corners = [
    [rect.x, rect.y], [rect.x + rect.width, rect.y],
    [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height],
  ];

  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (var i = 0; i < corners.length; i++)
  {
    var dx = corners[i][0] - cx;
    var dy = corners[i][1] - cy;
    var x = cx + dx * cos - dy * sin;
    var y = cy + dy * cos + dx * sin;

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * mxGraph.getBoundingBoxFromGeometry reduced to the case the normalization
 * needs: sibling vertices with their own (non-relative) geometry, in their
 * parent's coordinate frame. Offsets and a `rotation` style are honored, as
 * in the original; edges, relative children and stroke widths are not part
 * of this box.
 *
 * @param {Array<MxCell>} cells
 * @returns {{x: number, y: number, width: number, height: number}|null}
 */
MxGraph.prototype.getBoundingBoxFromGeometry = function(cells)
{
  var result = null;

  for (var i = 0; i < cells.length; i++)
  {
    if (!this.model.isVertex(cells[i])) continue;

    var geo = this.model.getGeometry(cells[i]);

    if (geo == null || geo.relative) continue;

    var bbox = { x: geo.x, y: geo.y, width: geo.width, height: geo.height };

    if (geo.offset != null)
    {
      bbox.x += geo.offset.x;
      bbox.y += geo.offset.y;
    }

    var rotation = parseFloat(this.getCellStyle(cells[i])["rotation"]);

    if (!isNaN(rotation) && rotation !== 0)
    {
      bbox = rotatedBounds(bbox, rotation);
    }

    if (result == null)
    {
      result = bbox;
    }
    else
    {
      var right = Math.max(result.x + result.width, bbox.x + bbox.width);
      var bottom = Math.max(result.y + result.height, bbox.y + bbox.height);

      result.x = Math.min(result.x, bbox.x);
      result.y = Math.min(result.y, bbox.y);
      result.width = right - result.x;
      result.height = bottom - result.y;
    }
  }

  return result;
};

/**
 * Repairs the structural mistakes a generated diagram tends to carry, without
 * touching what the author expressed. Port of Graph.prototype.normalizeModel
 * (drawio-dev, behind the desktop CLI's --normalize), so a diagram that goes
 * through an MCP server and one that goes through the desktop CLI are
 * repaired the same way. See shared/normalize-model.js for the reasoning.
 *
 * @param {MxCell} [root] - model root to normalize (defaults to the model root)
 * @returns {Object} counts per step: {edgeParents, edgeGeometries, containers}
 */
MxGraph.prototype.normalizeModel = function(root)
{
  var model = this.getModel();
  root = (root != null) ? root : model.getRoot();

  var result = { edgeParents: 0, edgeGeometries: 0, containers: 0 };
  var graph = this;
  var edges = [];

  var collectEdges = function(cell)
  {
    var childCount = model.getChildCount(cell);

    for (var i = 0; i < childCount; i++)
    {
      var child = model.getChildAt(cell, i);

      if (model.isEdge(child))
      {
        edges.push({ edge: child, parent: model.getParent(child) });
      }

      collectEdges(child);
    }
  };

  collectEdges(root);

  model.beginUpdate();

  try
  {
    model.updateEdgeParents(root);

    for (var i = 0; i < edges.length; i++)
    {
      if (model.getParent(edges[i].edge) !== edges[i].parent)
      {
        result.edgeParents++;
      }

      if (model.getGeometry(edges[i].edge) == null)
      {
        var edgeGeo = new MxGeometry();
        edgeGeo.relative = true;
        model.setGeometry(edges[i].edge, edgeGeo);
        result.edgeGeometries++;
      }
    }

    var growContainers = function(cell)
    {
      var childCount = model.getChildCount(cell);

      for (var i = 0; i < childCount; i++)
      {
        growContainers(model.getChildAt(cell, i));
      }

      if (!model.isVertex(cell) || childCount === 0 ||
        graph.isTransparentBounds(cell))
      {
        return;
      }

      var geo = model.getGeometry(cell);

      if (geo == null || geo.relative) return;

      // Child geometry is relative to this cell's origin, so the children's
      // bounding box is directly comparable to its size.
      var children = [];

      for (var j = 0; j < childCount; j++)
      {
        children.push(model.getChildAt(cell, j));
      }

      var bounds = graph.getBoundingBoxFromGeometry(children);

      if (bounds == null) return;

      var width = Math.max(geo.width, bounds.x + bounds.width);
      var height = Math.max(geo.height, bounds.y + bounds.height);

      if (width > geo.width || height > geo.height)
      {
        geo = geo.clone();
        geo.width = width;
        geo.height = height;
        model.setGeometry(cell, geo);
        result.containers++;
      }
    };

    growContainers(root);
  }
  finally
  {
    model.endUpdate();
  }

  return result;
};
