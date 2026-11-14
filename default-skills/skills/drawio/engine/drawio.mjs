#!/usr/bin/env node
// drawio.sh — tidy a .drawio diagram: place its shapes, route its connectors,
// check it. The `drawio` skill's tool (SKILL.md), run by the avatar in its own
// sandbox on files of its own; it needs Node only, no network and no browser.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addLabelPerimeters, fitEdgeLabels } from "./src/label-perimeter.js";
import { normalizeDiagram } from "./src/normalize-model.js";
import { checkDiagram, formatReport, overlapState, pagesWithLanes, pagesWithLayers, repairIfNeeded } from "./lib/check.mjs";
import { elkLayout, ensureEdgeGeometry, fitLabels, FLOWS, libavoidRoute, routableEdgeCount } from "./lib/passes.mjs";
import { canonicalAttributes } from "./lib/xmlcheck.mjs";

const ENGINE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = fs.readFileSync(path.join(ENGINE, "VERSION"), "utf8").trim();
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CELLS = 3000;
/** libavoid's time grows fast with the connectors between shapes (measured: 300 in ~5 s, 700 in ~66 s). */
const MAX_ROUTED_EDGES = 400;

const EXIT = { ok: 0, diagram: 1, usage: 2, engine: 4 };

const HELP = `drawio.sh — tidy a .drawio diagram (version ${VERSION})

usage:
  drawio.sh layout <file.drawio> [--flow <flow>] [--out <file>]
  drawio.sh route  <file.drawio> [--out <file>]
  drawio.sh check  <file.drawio>

commands:
  layout   place every shape and redraw every connector right-angled (ELK, draw.io's own
           Arrange > Layout).
           Positions you wrote are only a starting hint; boxes grow to fit their labels; free
           text cells (a title) go above the result. Refused for a page with swimlanes or with
           shapes on several layers. Use it for flowcharts, pipelines, graphs, trees, org charts.
  route    keep every shape where it is and re-route the right-angled connectors around the
           shapes (libavoid); up to 400 connectors between shapes. Use it when the placement carries meaning:
           lanes, containers, a grid you chose, a diagram you were handed.
  check    report what is wrong, change nothing. layout and route end with the same report.

options:
  --flow <flow>   layout only: down (default), right, tree-down, tree-right, radial, organic
  --out <file>    write the result there instead of over the input

Both first repair a file that does not parse (unescaped < or & in a label, text around the
diagram), add the geometry an edge was written without, and give edge labels a background.
layout also files each edge in the container that holds both its ends and grows a container
around its children. A file with a compressed page is refused.

route leaves a connector drawn straight, curved or as an entity relation (no edgeStyle,
curved=1, entityRelationEdgeStyle) as it is; layout redraws every connector right-angled.

exit status:
  0   done; warnings and notes may follow, read them
  1   the diagram has errors (they are listed), the file cannot be read, or this diagram
      cannot take the command (the reason is printed); nothing was written
  2   usage
  4   the layout engine could not start (report it; never install anything)
`;

function fail(code, message) {
  process.stderr.write(`drawio: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    process.exit(command ? EXIT.ok : EXIT.usage);
  }
  if (command === "--version") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(EXIT.ok);
  }
  if (!["layout", "route", "check"].includes(command)) fail(EXIT.usage, `unknown command '${command}' (layout | route | check; --help)`);
  const options = { command, file: null, flow: "down", out: null };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--flow" || arg === "--out") {
      const value = rest[++i];
      if (value == null) fail(EXIT.usage, `${arg} needs a value`);
      if (arg === "--flow") options.flow = value;
      else options.out = value;
    } else if (arg.startsWith("--flow=")) {
      options.flow = arg.slice("--flow=".length);
    } else if (arg.startsWith("--out=")) {
      options.out = arg.slice("--out=".length);
    } else if (arg.startsWith("-")) {
      fail(EXIT.usage, `unknown option '${arg}' (--help)`);
    } else if (options.file == null) {
      options.file = arg;
    } else {
      fail(EXIT.usage, "one file at a time");
    }
  }
  if (options.file == null) fail(EXIT.usage, `${command} needs a .drawio file`);
  if (command !== "layout" && rest.some((arg) => arg === "--flow" || arg.startsWith("--flow="))) fail(EXIT.usage, "--flow applies to layout only");
  if (command === "check" && options.out != null) fail(EXIT.usage, "check writes nothing; --out applies to layout and route");
  if (!Object.hasOwn(FLOWS, options.flow)) fail(EXIT.usage, `unknown flow '${options.flow}' (${Object.keys(FLOWS).join(" | ")})`);
  return options;
}

function readDiagram(file) {
  let bytes;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) fail(EXIT.diagram, `not a file: ${file}`);
    if (stat.size > MAX_BYTES) fail(EXIT.diagram, `${file} is ${stat.size} bytes; this tool reads diagrams up to ${MAX_BYTES} bytes`);
    bytes = fs.readFileSync(file);
  } catch (error) {
    fail(EXIT.diagram, `cannot read ${file}: ${error?.code === "ENOENT" ? "no such file" : error instanceof Error ? error.message : String(error)}`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(EXIT.diagram, `${file} is not UTF-8 text; nothing was written. Save the diagram as UTF-8 (a .drawio file always is)`);
  }
  if ((text.match(/<mxCell\b/g) ?? []).length > MAX_CELLS) fail(EXIT.diagram, `${file} has more than ${MAX_CELLS} cells: too large for this tool; split the diagram into pages or files`);
  return text;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Where a write to `target` really lands: through a link to the file it names. */
function realTarget(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function writeDiagram(target, xml) {
  const resolved = realTarget(target);
  const skill = fs.realpathSync(path.dirname(ENGINE));
  if (inside(skill, resolved)) fail(EXIT.usage, "the skill folder is read-only; write the diagram in your working folder");
  const tmp = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.tmp`);
  try {
    let mode = 0o644;
    try {
      mode = fs.statSync(resolved).mode & 0o777;
    } catch {
      /* a new file */
    }
    fs.writeFileSync(tmp, xml, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, resolved);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    fail(EXIT.diagram, `could not write ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printReport(report) {
  process.stdout.write(`${formatReport(report).join("\n")}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = readDiagram(options.file);

  if (options.command === "check") {
    const report = checkDiagram(source);
    printReport(report);
    process.exit(report.errors > 0 ? EXIT.diagram : EXIT.ok);
  }

  // Repair what does not parse, then refuse what no pass can work on:
  // everything below reads the cells out of the XML, and a page it cannot read
  // would silently stay as it was.
  const repaired = repairIfNeeded(source);
  let xml = repaired.xml;
  const before = checkDiagram(xml);
  const blocking = before.findings.filter((finding) => (finding.level === "error" && finding.code !== "edge-without-geometry") || finding.code === "compressed-page");
  if (blocking.length > 0) {
    printReport({ ...before, findings: blocking, omitted: [] });
    fail(EXIT.diagram, `${options.command} did not run and nothing was written: fix the finding(s) above first`);
  }
  const refuse = (reason) => fail(EXIT.diagram, `${options.command} did not run and nothing was written: ${reason}`);
  // The passes read the text as cells whether or not it is inside a comment: an old copy of a
  // cell left in a comment would take the write meant for the live one.
  if (/<!--(?:(?!-->)[\s\S])*?<mxCell\b/.test(xml)) refuse("a comment holds an <mxCell>; delete that comment (a .drawio file needs none) and run the command again");
  const named = (names) => names.map((name) => `"${name}"`).join(", ");
  // Every pass scans a tag up to its first `>` and reads double-quoted values only.
  xml = canonicalAttributes(xml);

  const done = [];
  if (repaired.repairs.length > 0) done.push(`repaired: ${repaired.repairs.join(", ")}`);
  if (options.command === "layout") {
    const lanes = pagesWithLanes(xml);
    if (lanes.length > 0) refuse(`${named(lanes)} has swimlanes, and a layout would pull the lanes apart. Keep the lane grid (SKILL.md §3 B) and run route instead`);
    const layers = pagesWithLayers(xml);
    if (layers.length > 0) refuse(`${named(layers)} has shapes on more than one layer, and a layout arranges one layer only. Run route instead, or put the shapes on one layer`);
    const fitted = fitLabels(xml);
    xml = fitted.xml;
    if (fitted.grown > 0) done.push(`${fitted.grown} box(es) grown to fit their labels`);
    xml = normalizeDiagram(xml).xml;
    let laid;
    try {
      laid = await elkLayout(xml, options.flow);
    } catch (error) {
      fail(EXIT.engine, `the layout engine could not start (${error instanceof Error ? error.message : String(error)}); nothing was written`);
    }
    if (laid.failures.length > 0) {
      const other = options.flow === "down" || options.flow === "right" ? "" : " Try --flow down or right: tree-down, tree-right and radial need a tree (one root, no cycle, nothing joining two branches).";
      refuse(`the '${options.flow}' layout cannot take this diagram (${laid.failures[0]}).${other} Or place the shapes on the grid (SKILL.md §3 B) and run route`);
    }
    // A layout that puts shapes on top of each other did not work for this diagram. An
    // overlap between two shapes it never moved is the author's (the report says so below).
    const was = overlapState(xml);
    const now = overlapState(laid.xml);
    const made = now.flatMap((page, index) => page.pairs.filter(([a, b]) => page.local.get(a) !== was[index]?.local.get(a) || page.local.get(b) !== was[index]?.local.get(b)));
    xml = laid.xml;
    done.push(`laid out (${options.flow}): ${laid.changed} cell(s) placed or routed; the connectors it routed are right-angled now`);
    if (made.length > 0) {
      const after = checkDiagram(xml, { after: "layout" });
      printReport({ ...after, findings: after.findings.filter((finding) => finding.code === "overlap"), omitted: [] });
      const other = options.flow === "down" || options.flow === "right" ? "" : " Try --flow down or right.";
      refuse(`the '${options.flow}' layout left shapes on top of each other.${other} Or place the shapes on the grid (SKILL.md §3 B) and run route`);
    }
  } else {
    const edges = routableEdgeCount(xml);
    if (edges > MAX_ROUTED_EDGES) refuse(`${edges} connectors between shapes, and this tool routes up to ${MAX_ROUTED_EDGES} (the time grows fast with their number). Split the diagram into pages or files, or run layout`);
    xml = ensureEdgeGeometry(xml);
    let routed;
    try {
      routed = await libavoidRoute(xml);
    } catch (error) {
      fail(EXIT.engine, `the routing engine could not start (${error instanceof Error ? error.message : String(error)}); nothing was written`);
    }
    xml = routed.xml;
    done.push(routed.routed > 0 ? `${routed.routed} connector(s) routed around the shapes` : "no right-angled connector between two shapes to route");
    if (routed.kept > 0) done.push(`${routed.kept} straight, curved or entity-relation connector(s) left as drawn`);
  }
  xml = fitEdgeLabels(addLabelPerimeters(xml).xml).xml;

  const target = options.out ?? options.file;
  writeDiagram(target, xml);
  process.stdout.write(`drawio ${options.command}: wrote ${target}\n`);
  for (const line of done) process.stdout.write(`  ${line}\n`);
  const report = checkDiagram(xml, { after: options.command });
  printReport(report);
  process.exit(report.errors > 0 ? EXIT.diagram : EXIT.ok);
}

main().catch((error) => fail(EXIT.engine, error instanceof Error ? (error.stack ?? error.message) : String(error)));
