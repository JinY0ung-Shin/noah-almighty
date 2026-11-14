// mxGraphModel XML <-> headless model, for the server-side diagram passes.
//
// Every pass that touches a generated diagram server-side - the model
// normalization (normalize-model.js), the ELK layout
// (mcp-tool-server/src/elk-pass.js) and the libavoid edge routing
// (mcp-tool-server/src/libavoid-pass.js) - needs the same thing: read one
// page's cell tree out of the XML, work on it through the headless mxGraph
// model (mx-model.js), and write back ONLY what changed, leaving every other
// byte of the document alone.
//
// Parsing is a deliberately small, targeted pass over `<mxCell>` /
// `<mxGeometry>` - draw.io XML is regular, and the LLM is asked to emit
// well-formed XML with escaped attribute values. Anything unexpected leaves
// that page untouched, so a parse hiccup never produces a broken diagram.
// `<object>` / `<UserObject>` wrappers are understood: they carry the cell's
// id and label while the inner `<mxCell>` carries style, parent and
// terminals.

import { MxCell, MxGeometry, MxPoint, MxGraphModel, MxGraph } from "./mx-model.js";

// ─── Parsing ─────────────────────────────────────────────────────

// Parse double-quoted attributes from a tag's attribute string into a map.
export function parseAttrs(s)
{
  var attrs = {};
  var re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  var m;

  while ((m = re.exec(s)) !== null)
  {
    attrs[m[1]] = m[2];
  }

  return attrs;
}

var XML_ENTITIES = { lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&" };

// Attribute values are kept decoded in the model - a style's `&amp;` is one
// `&` to every style parser, not a `;`-terminated token - and re-encoded by
// escapeXml when a pass writes one back. One pass, so `&amp;lt;` decodes to
// `&lt;`, not `<`. Anything that isn't a known entity is left as written.
function unescapeXml(s)
{
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, function(m, e)
  {
    if (e.charAt(0) !== "#")
    {
      return (XML_ENTITIES[e] != null) ? XML_ENTITIES[e] : m;
    }

    var code = (e.charAt(1) === "x") ? parseInt(e.substring(2), 16) :
      parseInt(e.substring(1), 10);

    return (code > 0 && code <= 0x10FFFF) ? String.fromCodePoint(code) : m;
  });
}

function decoded(v)
{
  return (v != null) ? unescapeXml(v) : null;
}

// Line breaks and tabs are written as character references: a literal one in
// an attribute value is read back as a space (XML attribute normalization).
function escapeXml(s)
{
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#xa;")
    .replace(/\r/g, "&#xd;")
    .replace(/\t/g, "&#x9;");
}

function num(v, fallback)
{
  var n = parseFloat(v);
  return isNaN(n) ? ((fallback != null) ? fallback : 0) : n;
}

// Trims float noise a pass can leave behind (-0, 1/3 tails).
function fmt(n)
{
  var v = Math.round(n * 100) / 100;
  return String(v === 0 ? 0 : v);
}

// Each <mxGraphModel> element is one page and is processed independently. A
// fragment with cells but no mxGraphModel wrapper is treated as one page.
function parseModelBlocks(xml)
{
  var blocks = [];
  var re = /<mxGraphModel\b[^>]*>([\s\S]*?)<\/mxGraphModel>/g;
  var m;

  while ((m = re.exec(xml)) !== null)
  {
    // Offset of the inner text: past the opening tag, before the closing one.
    blocks.push({
      start: m.index + m[0].length - m[1].length - "</mxGraphModel>".length,
      text: m[1],
    });
  }

  if (blocks.length === 0 && xml.indexOf("<mxCell") !== -1)
  {
    blocks.push({ start: 0, text: xml });
  }

  return blocks;
}

// <object>/<UserObject> wrappers carry the id (and the label) of the cell
// they wrap; the inner <mxCell> carries style/parent/terminals.
function parseWrappers(text)
{
  var wrappers = [];
  var re = /<(object|UserObject)\b([^>]*?)>([\s\S]*?)<\/\1>/g;
  var m;

  while ((m = re.exec(text)) !== null)
  {
    wrappers.push({
      start: m.index,
      end: m.index + m[0].length,
      attrs: parseAttrs(m[2]),
    });
  }

  return wrappers;
}

// All <mxCell> blocks (self-closing or with a body), with the offsets needed
// to splice a rebuilt block back into the source text.
function parseCells(text)
{
  var wrappers = parseWrappers(text);
  var cells = [];
  var re = /<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g;
  var m;

  while ((m = re.exec(text)) !== null)
  {
    var wrapper = null;

    for (var i = 0; i < wrappers.length; i++)
    {
      if (m.index > wrappers[i].start && m.index < wrappers[i].end)
      {
        wrapper = wrappers[i];
        break;
      }
    }

    var attrs = parseAttrs(m[1]);

    // Values the model holds are decoded; the write-back compares against
    // these to tell what a pass changed, and re-encodes only that.
    cells.push({
      start: m.index,
      end: m.index + m[0].length,
      rawAttrs: m[1],
      attrs: attrs,
      selfClosing: m[2] === "/>",
      body: m[3] || "",
      id: decoded((attrs.id != null) ? attrs.id :
        ((wrapper != null) ? wrapper.attrs.id : null)),
      label: decoded((attrs.value != null) ? attrs.value :
        ((wrapper != null) ? wrapper.attrs.label : null)),
      style: decoded(attrs.style || null),
      parent: decoded(attrs.parent),
      source: decoded(attrs.source),
      target: decoded(attrs.target),
    });
  }

  return cells;
}

// The first <mxGeometry> of a cell body, as a live MxGeometry. Unknown
// attributes and child elements ride along so the write-back restores them.
function parseGeometry(body)
{
  var m = /<mxGeometry\b([^>]*?)(\/>|>([\s\S]*?)<\/mxGeometry>)/.exec(body);

  if (m == null) return null;

  var attrs = parseAttrs(m[1]);
  var geo = new MxGeometry(num(attrs.x), num(attrs.y),
    num(attrs.width), num(attrs.height));

  geo.relative = (attrs.relative === "1" || attrs.relative === "true");
  geo.origAttrs = attrs;

  var inner = m[3] || "";
  var pm;

  var pointRe = /<mxPoint\b([^>]*?)\/?>/g;

  while ((pm = pointRe.exec(inner)) !== null)
  {
    var pa = parseAttrs(pm[1]);
    var point = new MxPoint(num(pa.x), num(pa.y));

    if (pa.as === "sourcePoint") geo.sourcePoint = point;
    else if (pa.as === "targetPoint") geo.targetPoint = point;
    else if (pa.as === "offset") geo.offset = point;
  }

  var am = /<Array\b[^>]*as="points"[^>]*>([\s\S]*?)<\/Array>/.exec(inner);

  if (am != null)
  {
    geo.points = [];
    var wpRe = /<mxPoint\b([^>]*?)\/?>/g;
    var wm;

    while ((wm = wpRe.exec(am[1])) !== null)
    {
      var wa = parseAttrs(wm[1]);
      geo.points.push(new MxPoint(num(wa.x), num(wa.y)));
    }
  }

  // Anything else inside the geometry (alternateBounds, …) is preserved
  // verbatim - no pass has an opinion on it.
  geo.extraXml = inner
    .replace(/<Array\b[^>]*as="points"[\s\S]*?<\/Array>/g, "")
    .replace(/<mxPoint\b[^>]*?\/?>/g, "")
    .trim();

  return geo;
}

// ─── Model construction ──────────────────────────────────────────

/**
 * Builds the headless model for one page. Returns null when the page has no
 * usable cell tree.
 *
 * @param {Array} cells - parseCells() output
 * @returns {MxGraph|null}
 */
export function buildModel(cells)
{
  var byId = new Map();
  var i;

  for (i = 0; i < cells.length; i++)
  {
    var c = cells[i];

    if (c.id == null || byId.has(c.id)) continue;

    var cell = new MxCell(c.id, c.label, c.style);

    cell.vertex = c.attrs.vertex === "1";
    cell.edge = c.attrs.edge === "1";
    cell.visible = c.attrs.visible !== "0";
    cell.geometry = parseGeometry(c.body);
    cell.source_ = c.source;
    cell.target_ = c.target;
    cell.parent_ = c.parent;
    cell.block = c;
    c.cell = cell;

    byId.set(c.id, cell);
  }

  // Wire the tree. The root is the cell with no parent attribute (draw.io
  // writes id="0"); its children are the layers.
  var root = null;
  var cellList = Array.from(byId.values());

  for (i = 0; i < cellList.length; i++)
  {
    if (cellList[i].parent_ == null && !cellList[i].vertex && !cellList[i].edge)
    {
      root = cellList[i];
      break;
    }
  }

  if (root == null) return null;

  for (i = 0; i < cellList.length; i++)
  {
    var child = cellList[i];

    if (child === root) continue;

    var parent = byId.get(child.parent_);

    // A dangling parent reference would drop the cell out of the tree
    // (draw.io's codec does the same); keep it on the root's first layer so
    // the passes still see it.
    if (parent == null) parent = root;

    child.parent = parent;
    parent.children.push(child);
  }

  // Terminals, and the per-vertex edge lists mxGraphModel maintains.
  for (i = 0; i < cellList.length; i++)
  {
    var edge = cellList[i];

    if (!edge.edge) continue;

    edge.source = byId.get(edge.source_) || null;
    edge.target = byId.get(edge.target_) || null;

    if (edge.source != null) edge.source.edges.push(edge);
    if (edge.target != null && edge.target !== edge.source)
    {
      edge.target.edges.push(edge);
    }
  }

  // The default parent: the first layer holding vertices (mxGraph's
  // defaultParent is the root's first child; a diagram whose content sits on
  // a later layer would otherwise hand a pass an empty parent).
  var layer = null;

  for (i = 0; i < root.children.length; i++)
  {
    var candidate = root.children[i];
    var vertices = candidate.children.filter(function(c)
    {
      return c.vertex;
    });

    if (vertices.length > 0) { layer = candidate; break; }
  }

  if (layer == null) layer = root.children[0];

  if (layer == null) return null;

  return new MxGraph(new MxGraphModel(root), layer);
}

// ─── Write-back ──────────────────────────────────────────────────

function serializeGeometry(geo)
{
  var orig = geo.origAttrs || {};
  var attrs = [];
  var seen = { x: 1, y: 1, width: 1, height: 1, relative: 1, as: 1 };

  if (orig.x != null || geo.x !== 0) attrs.push('x="' + fmt(geo.x) + '"');
  if (orig.y != null || geo.y !== 0) attrs.push('y="' + fmt(geo.y) + '"');

  if (orig.width != null || geo.width > 0)
  {
    attrs.push('width="' + fmt(geo.width) + '"');
  }

  if (orig.height != null || geo.height > 0)
  {
    attrs.push('height="' + fmt(geo.height) + '"');
  }

  for (var k in orig)
  {
    if (!seen[k]) attrs.push(k + '="' + orig[k] + '"');
  }

  if (geo.relative) attrs.push('relative="1"');
  attrs.push('as="geometry"');

  var inner = "";

  if (geo.sourcePoint != null)
  {
    inner += '<mxPoint x="' + fmt(geo.sourcePoint.x) + '" y="' +
      fmt(geo.sourcePoint.y) + '" as="sourcePoint" />';
  }

  if (geo.targetPoint != null)
  {
    inner += '<mxPoint x="' + fmt(geo.targetPoint.x) + '" y="' +
      fmt(geo.targetPoint.y) + '" as="targetPoint" />';
  }

  if (geo.points != null && geo.points.length > 0)
  {
    inner += '<Array as="points">';

    for (var i = 0; i < geo.points.length; i++)
    {
      inner += '<mxPoint x="' + fmt(geo.points[i].x) + '" y="' +
        fmt(geo.points[i].y) + '" />';
    }

    inner += "</Array>";
  }

  if (geo.offset != null)
  {
    inner += '<mxPoint x="' + fmt(geo.offset.x) + '" y="' +
      fmt(geo.offset.y) + '" as="offset" />';
  }

  if (geo.extraXml) inner += geo.extraXml;

  return (inner === "")
    ? "<mxGeometry " + attrs.join(" ") + " />"
    : "<mxGeometry " + attrs.join(" ") + ">" + inner + "</mxGeometry>";
}

// Replace an attribute in a raw attribute string (or append it).
function withAttr(rawAttrs, name, value)
{
  var escaped = escapeXml(value);
  var re = new RegExp("\\b" + name + '\\s*=\\s*"[^"]*"');

  // A function replacement, so a `$&` in the value is taken literally.
  if (re.test(rawAttrs))
  {
    return rawAttrs.replace(re, function()
    {
      return name + '="' + escaped + '"';
    });
  }

  return rawAttrs + " " + name + '="' + escaped + '"';
}

// Rebuild one <mxCell> block from the model cell, preserving everything no
// pass touched. The geometry element is only re-serialized when the geometry
// actually changed - a pass that just moves a cell to another parent leaves
// the original element, and its formatting, alone.
function buildCellBlock(cell, geometryChanged)
{
  var block = cell.block;
  var rawAttrs = block.rawAttrs;

  // Both sides decoded: an attribute no pass touched keeps its bytes exactly
  // as authored, entities and all.
  if (cell.style !== block.style)
  {
    rawAttrs = withAttr(rawAttrs, "style", cell.style || "");
  }

  if (cell.parent != null && cell.parent.id !== block.parent)
  {
    rawAttrs = withAttr(rawAttrs, "parent", cell.parent.id);
  }

  if (cell.geometry == null || !geometryChanged)
  {
    return "<mxCell" + rawAttrs + (block.selfClosing ? "/>" :
      ">" + block.body + "</mxCell>");
  }

  var body = block.body
    .replace(/<mxGeometry\b[^>]*?\/>/g, "")
    .replace(/<mxGeometry\b[\s\S]*?<\/mxGeometry>/g, "");

  return "<mxCell" + rawAttrs + ">" + body + serializeGeometry(cell.geometry) +
    "</mxCell>";
}

/**
 * Runs `transform(graph)` over every page of a diagram and writes the cells
 * it changed back into the XML. The transform mutates the model through the
 * usual mxGraph calls (setGeometry / setStyle / add); everything it doesn't
 * touch comes back byte-identical, including cells, pages and wrappers.
 *
 * A page whose transform throws, or that has no usable cell tree, is left
 * exactly as it was - these passes improve a diagram, they never break one.
 *
 * @param {string} xml - mxGraphModel or mxfile XML
 * @param {function(MxGraph): void} transform
 * @returns {{xml: string, changed: number}} the rewritten XML and how many
 *   cells were rewritten
 */
export function transformPages(xml, transform)
{
  if (typeof xml !== "string" || xml.indexOf("<mxCell") === -1)
  {
    return { xml: xml, changed: 0 };
  }

  var blocks = parseModelBlocks(xml);
  var out = xml;
  var changedCells = 0;

  // Back to front, so earlier offsets stay valid while splicing.
  for (var b = blocks.length - 1; b >= 0; b--)
  {
    var result = transformPage(blocks[b].text, transform);

    if (result == null) continue;

    changedCells += result.changed;
    out = out.substring(0, blocks[b].start) + result.text +
      out.substring(blocks[b].start + blocks[b].text.length);
  }

  return { xml: out, changed: changedCells };
}

function transformPage(text, transform)
{
  try
  {
    var cells = parseCells(text);
    var graph = buildModel(cells);

    if (graph == null) return null;

    transform(graph);

    var model = graph.getModel();
    var changed = new Set();

    model.changedGeometry.forEach(function(cell) { changed.add(cell); });
    model.changedStyle.forEach(function(cell) { changed.add(cell); });
    model.changedParent.forEach(function(cell) { changed.add(cell); });

    if (changed.size === 0) return null;

    // Splice back to front so the recorded offsets stay valid.
    var dirty = Array.from(changed)
      .filter(function(cell) { return cell.block != null; })
      .sort(function(a, b) { return b.block.start - a.block.start; });

    var out = text;

    for (var i = 0; i < dirty.length; i++)
    {
      var block = dirty[i].block;

      out = out.substring(0, block.start) +
        buildCellBlock(dirty[i], model.changedGeometry.has(dirty[i])) +
        out.substring(block.end);
    }

    return { text: out, changed: dirty.length };
  }
  catch (e)
  {
    // Never break the diagram - fall back to the page as authored.
    return null;
  }
}
