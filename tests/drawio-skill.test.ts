// The drawio skill's tool (default-skills/skills/drawio/engine, run as scripts/drawio.sh): `check`
// finds what the viewer would draw wrong, `layout` places shapes and routes connectors, `route` keeps
// the placement and routes around shapes. Everything runs the CLI the way the avatar does (a child
// `node`), from a COPY of the skill folder — the sandbox gets a copy too, with no node_modules near it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withTempDir } from "./helpers.js";

const REPO = process.cwd();
const SKILL = path.join(REPO, "default-skills", "skills", "drawio");
const ENGINE = path.join(SKILL, "engine");

// Vendored files (engine/README.md lists their origin). A refresh is a deliberate edit of this table.
const VENDORED: Record<string, string> = {
  "src/mx-model.js": "42a8387340b549bec8e76af5ec19892f8514d6b7b7c0ceda8969dc8fa95cf5dd",
  "src/mx-xml.js": "615805ddc91735b77fbf2afbfbaef96d6cb279ab56735419a034b0844d284e66",
  "src/normalize-model.js": "cfbcca33e0df107451591f253f4456cd18bbb8e30e8b79d70d5cd92b731baad0",
  "src/repair-xml.js": "758b108bc905ead290330aa673f64580d522b4c1322ac891210d15d4bfdac63a",
  "src/label-perimeter.js": "3d9d1a89bd8df698b1cf825fd80fa8f58ad09f6561ecd0acc1b1c33b32c0395f",
  "src/edge-waypoints.js": "e8b836c2899db089d22dba1c7506ed396d588917d166d99a03924ba7c5020828",
  "src/elk-engine.js": "fbbc01bc87fc51e41a536a59a91e71434ba5c5274709be15bee64ce9d183241d",
  "src/libavoid-pass.js": "d2db798f4de45ac443f846fdd06f63d2c4cb428ece95575f77df5dacff60ffcc",
  "vendor/elk/drawio-elk.min.js": "95856210cd397f3dc0bdabbf697a86e79ac7e116ee29c0e0a8606f540950e522",
  "vendor/libavoid/libavoid-node.mjs": "79c7751cf72b2e53a081e7e432fda4adb547922a80708a0d76e38dd70f5b22ab",
  "vendor/libavoid/libavoid.wasm": "65deb7172894049eb554cf6e02c520274ac117a1992d3d16a3f346c09ceb41e5",
  "vendor/libavoid/libavoid-routing.js": "3b4f1a0f3083f31ea7d2ede45ec709a3b5b5631d7e4de6e42779bb3c72e995bd",
};

const cell = (id: string, label: string, x: number, y: number, w = 160, h = 60, style = "rounded=1;whiteSpace=wrap;html=1;fontSize=14;", parent = "1") =>
  `<mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="${parent}"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
const edge = (id: string, source: string, target: string, label = "") =>
  `<mxCell id="${id}"${label ? ` value="${label}"` : ""} style="edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
const page = (cells: string[], name = "Page-1") =>
  `<diagram id="${name}" name="${name}"><mxGraphModel grid="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join("")}</root></mxGraphModel></diagram>`;
const mxfile = (...pages: string[]) => `<mxfile host="app">${pages.join("")}</mxfile>`;

/** Three boxes in a row, and a connector from the first to the third: draw.io draws it through the second. */
const THROUGH = mxfile(page([cell("a", "시작", 40, 40), cell("b", "가운데", 260, 40), cell("c", "끝", 480, 40), edge("e1", "a", "c")]));

interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function vertices(xml: string): Rect[] {
  const out: Rect[] = [];
  const re = /<mxCell id="([^"]+)"[^>]*vertex="1"[^>]*>\s*<mxGeometry x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) out.push({ id: m[1], x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) });
  return out;
}

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("drawio skill tool", () => {
  const tempDir = withTempDir("drawio-skill");

  /** The CLI as the sandbox has it: a copy of the skill folder, away from the repo's node_modules. */
  function kit(): string {
    const copy = path.join(tempDir(), "skill");
    if (!fs.existsSync(copy)) fs.cpSync(SKILL, copy, { recursive: true });
    return copy;
  }

  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [path.join(kit(), "engine", "drawio.mjs"), ...args], { cwd: tempDir(), encoding: "utf8", timeout: 60_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function write(name: string, xml: string): string {
    const file = path.join(tempDir(), name);
    fs.writeFileSync(file, xml);
    return file;
  }

  it("keeps the vendored engine files byte-identical to the pinned upstream", () => {
    for (const [rel, sha] of Object.entries(VENDORED)) {
      expect(createHash("sha256").update(fs.readFileSync(path.join(ENGINE, rel))).digest("hex"), rel).toBe(sha);
    }
    // Every engine file is either pinned above or Noah's own.
    const own = new Set(["src/cdn-cache.js"]);
    const found = [...fs.readdirSync(path.join(ENGINE, "src")).map((name) => `src/${name}`)];
    for (const rel of found) expect(Object.hasOwn(VENDORED, rel) || own.has(rel), rel).toBe(true);
  });

  it("never reaches for the network: the CDN cache is replaced by a reader of the vendored files", () => {
    const shim = fs.readFileSync(path.join(ENGINE, "src", "cdn-cache.js"), "utf8");
    expect(shim).not.toMatch(/https?:\/\//);
    // Every source file that is not a minified engine bundle: no fetch, no network or process module.
    const sources = ["drawio.mjs", ...fs.readdirSync(path.join(ENGINE, "lib")).map((name) => `lib/${name}`), ...fs.readdirSync(path.join(ENGINE, "src")).map((name) => `src/${name}`)];
    expect(sources.length).toBeGreaterThanOrEqual(14);
    for (const name of sources) {
      const source = fs.readFileSync(path.join(ENGINE, name), "utf8");
      expect(source, name).not.toMatch(/\bfetch\s*\(/);
      expect(source, name).not.toMatch(/["'](?:node:)?(?:https?|http2|net|tls|dgram|dns|child_process|worker_threads)["']/);
    }
  });

  it("lists exactly the stencil sets the chat's viewer ships", async () => {
    const check = (await import(pathToFileURL(path.join(ENGINE, "lib", "check.mjs")).href)) as { BUNDLED_STENCILS: string[] };
    const shipped = fs
      .readdirSync(path.join(REPO, "src", "client", "public", "drawio", "stencils"))
      .filter((name) => name.endsWith(".xml"))
      .map((name) => name.slice(0, -".xml".length))
      .sort();
    expect([...check.BUNDLED_STENCILS].sort()).toEqual(shipped);
  });

  it("the skill names the tool, its three commands and the exit statuses the tool has", () => {
    const skill = fs.readFileSync(path.join(SKILL, "SKILL.md"), "utf8");
    expect(skill).toContain("bash ${CLAUDE_SKILL_DIR}/scripts/drawio.sh");
    for (const command of ["layout <file>", "route <file>", "check <file>"]) expect(skill).toContain(command);
    expect(skill).toContain("`0` done (read the warnings); `1` the diagram has errors or cannot take\nthe command — the reason is printed and nothing was written; `2` usage; `4` the engine could not\nstart");
    expect(fs.readFileSync(path.join(SKILL, "scripts", "drawio.sh"), "utf8")).toContain("engine/drawio.mjs");
    const help = run(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--flow <flow>   layout only: down (default), right, tree-down, tree-right, radial, organic");
    expect(skill).toContain("--flow down\\|right\\|tree-down\\|tree-right\\|radial\\|organic");
    // The index a run is given cuts a description at 300 characters (piSkills.ts).
    const description = /^description: (.*)$/m.exec(skill)![1];
    expect(description.length).toBeLessThanOrEqual(300);
  });

  it("check: a sound diagram is OK", () => {
    const file = write("ok.drawio", mxfile(page([cell("a", "시작", 40, 40), cell("b", "끝", 40, 180), edge("e1", "a", "b").replace("html=1;", "html=1;labelBackgroundColor=default;")])));
    const result = run(["check", file]);
    expect(result.stdout.trim()).toBe("drawio check: OK");
    expect(result.status).toBe(0);
  });

  it("check: reports what the viewer cannot draw as errors, each with its cell and a fix", () => {
    const broken = mxfile(
      page([
        cell("a", "A", 40, 40),
        cell("a", "A again", 260, 40),
        `<mxCell id="e1" edge="1" parent="1" source="a" target="ghost"><mxGeometry relative="1" as="geometry"/></mxCell>`,
        `<mxCell id="e2" edge="1" parent="1" source="a" target="a"/>`,
        cell("orphan", "X", 40, 200, 160, 60, "html=1;", "nowhere"),
      ]),
    );
    const result = run(["check", write("broken.drawio", broken)]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("error [duplicate-id] cell 'a'");
    expect(result.stdout).toContain(`error [dangling-edge] cell 'e1': target="ghost" names no cell`);
    expect(result.stdout).toContain("error [edge-without-geometry] cell 'e2'");
    expect(result.stdout).toContain(`error [unknown-parent] cell 'orphan': parent="nowhere" names no cell`);
    expect(result.stdout).toMatch(/— fix: /);
  });

  it("check: names the line of malformed XML, an unescaped label, a compressed page and a missing root", () => {
    const unclosed = run(["check", write("unclosed.drawio", `<mxfile>\n<diagram name="p"><mxGraphModel><root>\n<mxCell id="0"/>\n<mxCell id="1" parent="0">\n</root></mxGraphModel></diagram></mxfile>`)]);
    expect(unclosed.status).toBe(1);
    expect(unclosed.stdout).toMatch(/error \[malformed-xml\] .*<\/root> closes <mxCell> \(opened on line 4\) \(line 5\)/);

    const raw = run(["check", write("raw.drawio", mxfile(page([cell("a", "<b>제목</b><br>R&D", 40, 40)])))]);
    expect(raw.status).toBe(1);
    expect(raw.stdout).toContain("error [needs-repair]");
    expect(raw.stdout).toContain("run `layout` or `route` (both repair this)");

    // A compressed page is not an error — the viewer draws it — but nothing here can read or rewrite it.
    const z = write("z.drawio", `<mxfile><diagram id="p" name="압축">7VpLc9owEP41HNPxA2w4NiRpD+1MZ3JoexS2sDUVlitEgP76rmzJT0iBAHYm</diagram></mxfile>`);
    const compressed = run(["check", z]);
    expect(compressed.status).toBe(0);
    expect(compressed.stdout).toContain(`note [compressed-page] page "압축"`);
    const refused = run(["route", z]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("route did not run and nothing was written");

    const twice = run(["check", write("twice.drawio", mxfile(page([cell("a", "A", 0, 0).replace('vertex="1"', 'vertex="1" vertex="1"')])))]);
    expect(twice.status).toBe(1);
    expect(twice.stdout).toContain("has the attribute vertex twice");
    const late = run(["check", write("late.drawio", `\n<?xml version="1.0" encoding="UTF-8"?>${THROUGH}`)]);
    expect(late.status).toBe(1);
    expect(late.stdout).toContain("the XML declaration is not the first thing in the file");

    const rootless = run(["check", write("rootless.drawio", `<mxfile><diagram name="p"><mxGraphModel><root>${cell("a", "A", 0, 0)}</root></mxGraphModel></diagram></mxfile>`)]);
    expect(rootless.status).toBe(1);
    expect(rootless.stdout).toContain("error [missing-root]");
  });

  it("check: warns about what a reader sees as a messy diagram", () => {
    const messy = mxfile(
      page([
        cell("a", "시작", 40, 40),
        cell("b", "가운데", 260, 40),
        cell("c", "끝", 480, 40),
        cell("d", "겹침", 300, 60),
        cell("long", "사용자 브라우저와 크롬 확장 프로그램 연결", 40, 300, 140, 40),
        cell("tiny", "작은 글씨", 260, 300, 160, 60, "rounded=1;whiteSpace=wrap;html=1;fontSize=8;"),
        cell("aws", "Lambda", 480, 300, 80, 80, "shape=mxgraph.aws4.lambda;html=1;fontSize=14;"),
        cell("bare", "크기 없음", 700, 300, 160, 60, "rounded=1;whiteSpace=wrap;html=1;"),
        cell("db", "주문 DB", 40, 460, 120, 60, "shape=cylinder3;whiteSpace=wrap;html=1;fontSize=14;"),
        cell("db2", "결제 DB", 260, 460, 120, 80, "shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=15;whiteSpace=wrap;html=1;fontSize=14;"),
        cell("db3", "정산 DB", 480, 460, 120, 80, "shape=cylinder3;whiteSpace=wrap;html=1;fontSize=14;"),
        edge("e1", "a", "c"),
        edge("e2", "a", "b", "아주 긴 설명이 붙은 연결선 라벨입니다"),
      ]),
    );
    const result = run(["check", write("messy.drawio", messy)]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/warning \[overlap\] cell 'b': 'b' \("가운데"\) and 'd' \("겹침"\) overlap/);
    expect(result.stdout).toMatch(/warning \[edge-may-cross-shape\] cell 'e1': .* has 'b' \("가운데"\) between its ends/);
    expect(result.stdout).toContain("warning [label-overflow] cell 'long'");
    expect(result.stdout).toContain("warning [small-font] cell 'tiny'");
    expect(result.stdout).toContain("warning [unbundled-icons]");
    expect(result.stdout).toContain("mxgraph.aws4.*");
    expect(result.stdout).toContain("warning [long-edge-label] cell 'e2'");
    expect(result.stdout).toMatch(/warning \[edge-label-covers-shape\] cell 'e2'/);
    expect(result.stdout).toContain("warning [label-on-cap] cell 'db'");
    // Below the cap (boundedLbl), or a one-line label in a cylinder tall enough: nothing to say.
    expect(result.stdout).not.toContain("cell 'db2'");
    expect(result.stdout).not.toContain("cell 'db3'");
    expect(result.stdout).toContain("note [default-font-size] 1 labelled shape(s)");
    expect(result.stdout).toContain("note [edge-label-background] 1 edge label(s)");
    // A Hangul character is a full font size wide: the same box holds as many Latin letters (21 here) without trouble.
    const latin = run(["check", write("latin.drawio", mxfile(page([cell("long", "browser and extension", 40, 300, 140, 40)])))]);
    expect(latin.stdout.trim()).toBe("drawio check: OK");
    expect(latin.status).toBe(0);
  });

  it("route: keeps every shape where it is and takes the connector around the shape in its way", () => {
    const file = write("through.drawio", THROUGH);
    const out = path.join(tempDir(), "routed.drawio");
    const result = run(["route", file, "--out", out]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 connector(s) routed around the shapes");
    expect(result.stdout).not.toContain("edge-through-shape");
    expect(result.stdout).not.toContain("edge-may-cross-shape");
    expect(fs.readFileSync(file, "utf8")).toBe(THROUGH);
    const routed = fs.readFileSync(out, "utf8");
    expect(vertices(routed)).toEqual(vertices(THROUGH));
    const points = [...routed.matchAll(/<mxPoint x="([-\d.]+)" y="([-\d.]+)" \/>/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    expect(points.length).toBeGreaterThanOrEqual(2);
    // No waypoint lies inside the box in the way (b: 260..420 × 40..100).
    for (const p of points) expect(p.x > 260 && p.x < 420 && p.y > 40 && p.y < 100).toBe(false);
    // The route leaves the row of the boxes: it goes above or below b.
    expect(points.some((p) => p.y < 40 || p.y > 100)).toBe(true);
  });

  it("route: a hand-written line through a shape is reported, and routing replaces it", () => {
    const hand = THROUGH.replace('<mxGeometry relative="1" as="geometry"/></mxCell></root>', '<mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="340" y="70"/></Array></mxGeometry></mxCell></root>');
    const file = write("hand.drawio", hand);
    expect(run(["check", file]).stdout).toMatch(/warning \[edge-through-shape\] cell 'e1': .* runs through 'b'/);
    const result = run(["route", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("edge-through-shape");
  });

  it("layout: repairs the file, grows boxes to their labels, and leaves no overlap or line through a shape", () => {
    const cramped = mxfile(
      page([
        cell("user", "사용자 브라우저 (Chrome 확장 포함)", 40, 40, 100, 40, "rounded=1;whiteSpace=wrap;html=1;"),
        cell("api", "Noah API 서버<br>(Express BFF)", 40, 40, 100, 40, "rounded=1;whiteSpace=wrap;html=1;"),
        cell("pi", "pi-gateway 에이전트 런타임", 60, 60, 100, 40, "rounded=1;whiteSpace=wrap;html=1;"),
        cell("db", "SQLite DB", 80, 80, 100, 60, "shape=cylinder3;whiteSpace=wrap;html=1;"),
        cell("dec", "승인된 사용자인가?", 100, 100, 100, 60, "rhombus;whiteSpace=wrap;html=1;"),
        edge("e1", "user", "api", "HTTPS"),
        edge("e2", "api", "pi"),
        edge("e3", "api", "db"),
        edge("e4", "user", "dec"),
        `<mxCell id="e5" value="아니오" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="dec" target="db"/>`,
      ]),
    );
    const file = write("cramped.drawio", cramped);
    const before = run(["check", file]);
    expect(before.status).toBe(1);
    expect(before.stdout).toContain("needs-repair");

    const result = run(["layout", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("repaired: attribute values escaped");
    expect(result.stdout).toMatch(/\d+ box\(es\) grown to fit their labels/);
    expect(result.stdout).toMatch(/laid out \(down\)/);
    for (const code of ["overlap", "label-overflow", "edge-through-shape", "edge-may-cross-shape", "edge-label-covers-shape"]) expect(result.stdout, code).not.toContain(`[${code}]`);

    const laid = fs.readFileSync(file, "utf8");
    // The label with a raw `>` (…&lt;br>…) is still a vertex of the diagram: it was placed like the rest.
    const boxes = vertices(laid);
    expect(boxes.map((box) => box.id).sort()).toEqual(["api", "db", "dec", "pi", "user"]);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlap(boxes[i], boxes[j]), `${boxes[i].id}/${boxes[j].id}`).toBe(false);
    const user = boxes.find((box) => box.id === "user")!;
    expect(user.w).toBeGreaterThanOrEqual(200);
    // The edge written without a geometry is drawn now, and labels got a background.
    expect(laid).toMatch(/<mxCell id="e5"[^>]*>\s*<mxGeometry[^>]*relative="1"/);
    expect(laid).toMatch(/<mxCell id="e1"[^>]*labelBackgroundColor=default/);
    expect(run(["check", file]).status).toBe(0);
  });

  it("layout: --flow right runs left to right, and shapes of a container stay inside it", () => {
    const nested = mxfile(
      page([
        cell("box", "스택", 200, 20, 420, 320, "swimlane;startSize=28;html=1;fontSize=14;"),
        cell("n1", "Noah", 40, 60, 140, 60, undefined, "box"),
        cell("n2", "pi-gateway", 40, 60, 140, 60, undefined, "box"),
        cell("out", "사내 LLM", 700, 60, 140, 60),
        edge("e1", "n1", "n2"),
        edge("e2", "n2", "out"),
      ]),
    );
    const file = write("nested.drawio", nested);
    const result = run(["layout", file, "--flow", "right"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("drawio check: OK");
    const laid = fs.readFileSync(file, "utf8");
    expect(laid).toMatch(/<mxCell id="n1"[^>]*parent="box"/);
    const at = (id: string) => vertices(laid).find((box) => box.id === id)!;
    // Children are relative to the container: both inside it, n1 left of n2, the outside shape right of the container.
    expect(at("n1").x).toBeLessThan(at("n2").x);
    expect(at("n2").x + at("n2").w).toBeLessThanOrEqual(at("box").w);
    expect(at("out").x).toBeGreaterThanOrEqual(at("box").x + at("box").w);
  });

  it("layout: refuses a page with swimlanes and writes nothing", () => {
    const lane = (id: string, name: string, row: number) => cell(id, name, 0, row * 160, 800, 160, "swimlane;horizontal=0;startSize=110;html=1;fontSize=14;");
    const lanes = mxfile(page([lane("l1", "고객", 0), lane("l2", "주문", 1), cell("a", "요청", 140, 50, 160, 60, undefined, "l1"), cell("b", "확인", 140, 50, 160, 60, undefined, "l2"), edge("e1", "a", "b")], "주문 흐름"));
    const file = write("lanes.drawio", lanes);
    const result = run(["layout", file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`"주문 흐름" has swimlanes`);
    expect(result.stderr).toContain("run route instead");
    expect(fs.readFileSync(file, "utf8")).toBe(lanes);
    expect(run(["route", file]).status).toBe(0);
  });

  it("route on lanes: a connector that passes a lane it does not belong to is not a line through a shape", () => {
    const lane = (id: string, name: string, row: number) => cell(id, name, 0, row * 160, 800, 160, "swimlane;horizontal=0;startSize=110;whiteSpace=wrap;html=1;fontSize=14;");
    const lanes = mxfile(
      page([lane("l1", "고객", 0), lane("l2", "주문", 1), lane("l3", "결제", 2), cell("a", "요청", 140, 50, 160, 60, undefined, "l1"), cell("m", "확인", 140, 50, 160, 60, undefined, "l2"), cell("z", "승인", 140, 50, 160, 60, undefined, "l3"), edge("e1", "a", "z")]),
    );
    const file = write("skip.drawio", lanes);
    expect(run(["check", file]).stdout).toMatch(/warning \[edge-may-cross-shape\] cell 'e1': .* has 'm' \("확인"\) between its ends/);
    const result = run(["route", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("drawio check: OK");
    expect(vertices(fs.readFileSync(file, "utf8"))).toEqual(vertices(lanes));
  });

  it("layout: titled containers next to each other are not lanes; shapes on two layers are refused", () => {
    const groups = mxfile(
      page([
        cell("g1", "프런트", 0, 0, 240, 160, "swimlane;startSize=28;html=1;fontSize=14;"),
        cell("g2", "백엔드", 400, 300, 240, 160, "swimlane;startSize=28;html=1;fontSize=14;"),
        cell("a", "웹", 40, 60, 160, 60, undefined, "g1"),
        cell("b", "API", 40, 60, 160, 60, undefined, "g2"),
        edge("e1", "a", "b"),
      ]),
    );
    const ok = run(["layout", write("groups.drawio", groups)]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("drawio check: OK");

    const layered = mxfile(page([`<mxCell id="2" parent="0"/>`, cell("a", "하나", 0, 0), cell("b", "둘", 0, 200), cell("c", "셋", 0, 0, 160, 60, undefined, "2"), edge("e1", "a", "b")]));
    const file = write("layers.drawio", layered);
    const refused = run(["layout", file]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("has shapes on more than one layer");
    expect(fs.readFileSync(file, "utf8")).toBe(layered);
  });

  it("layout: a title stays out of the graph and goes above it; a flow the diagram cannot take writes nothing", () => {
    const title = cell("title", "조직도", 500, 500, 300, 30, "text;html=1;fontSize=20;fontStyle=1;");
    const tree = [title, cell("ceo", "대표", 0, 0), cell("a", "개발", 0, 0), cell("b", "영업", 0, 0), cell("a1", "플랫폼", 0, 0), edge("e1", "ceo", "a"), edge("e2", "ceo", "b"), edge("e3", "a", "a1")];
    for (const flow of ["radial", "tree-down", "organic", "down"]) {
      const file = write(`tree-${flow}.drawio`, mxfile(page(tree)));
      const result = run(["layout", file, "--flow", flow]);
      expect(result.status, flow).toBe(0);
      expect(result.stdout, flow).not.toContain("[overlap]");
      const boxes = vertices(fs.readFileSync(file, "utf8"));
      const top = Math.min(...boxes.filter((box) => box.id !== "title").map((box) => box.y));
      const placed = boxes.find((box) => box.id === "title")!;
      expect(placed.y + placed.h, flow).toBeLessThanOrEqual(top);
    }
    // ceo → a → a1 → ceo is a cycle: not a tree.
    const cyclic = mxfile(page([...tree, edge("e4", "a1", "ceo")]));
    const file = write("cyclic.drawio", cyclic);
    const result = run(["layout", file, "--flow", "radial"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("layout did not run and nothing was written");
    expect(result.stderr).toContain("Try --flow down or right");
    expect(fs.readFileSync(file, "utf8")).toBe(cyclic);
    expect(run(["layout", file]).status).toBe(0);
  });

  it("layout: hard line breaks do not widen a box, and a diamond is widened until its line fits", () => {
    const file = write("fit.drawio", mxfile(page([cell("s", "주문 서비스&lt;br&gt;(Spring)&lt;br&gt;v2", 0, 0), cell("d", "승인된 사용자인가?", 0, 0, 100, 60, "rhombus;whiteSpace=wrap;html=1;fontSize=14;"), edge("e1", "s", "d")])));
    expect(run(["layout", file]).status).toBe(0);
    const at = (id: string) => vertices(fs.readFileSync(file, "utf8")).find((box) => box.id === id)!;
    expect(at("s").w).toBe(160);
    expect(at("s").h).toBeGreaterThan(60);
    // 9 Hangul characters and a space at 14 px are about 130 px; a diamond leaves ~62 % of its width.
    expect(at("d").w).toBeGreaterThanOrEqual(220);
  });

  it("route: changes no container, and leaves a straight or curved connector as it was drawn", () => {
    const boxes = [
      `<mxCell id="g" value="접힌 그룹" style="swimlane;startSize=28;html=1;fontSize=14;" vertex="1" collapsed="1" parent="1"><mxGeometry x="40" y="300" width="140" height="30" as="geometry"><mxRectangle x="40" y="300" width="300" height="200" as="alternateBounds"/></mxGeometry></mxCell>`,
      cell("h", "숨은 자식", 20, 40, 400, 400, undefined, "g"),
      cell("a", "시작", 40, 40),
      cell("b", "가운데", 260, 40),
      cell("c", "끝", 480, 40),
    ];
    const straight = `<mxCell id="s1" value="직선" style="html=1;dashed=1;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>`;
    const curved = `<mxCell id="s2" style="edgeStyle=orthogonalEdgeStyle;curved=1;html=1;" edge="1" parent="1" source="b" target="c"><mxGeometry relative="1" as="geometry"/></mxCell>`;
    const input = mxfile(page([...boxes, straight, curved, edge("e1", "a", "c")]));
    const file = write("keep.drawio", input);
    const result = run(["route", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 connector(s) routed around the shapes");
    expect(result.stdout).toContain("2 straight, curved or entity-relation connector(s) left as drawn");
    const routed = fs.readFileSync(file, "utf8");
    expect(vertices(routed)).toEqual(vertices(input));
    expect(routed).toContain(`<mxRectangle x="40" y="300" width="300" height="200" as="alternateBounds"/>`);
    expect(routed).toMatch(/<mxCell id="s1" value="직선" style="html=1;dashed=1;labelBackgroundColor=default;[^"]*" edge="1"/);
    const s2 = /<mxCell id="s2" style="([^"]*)"[^>]*>(.*?)<\/mxCell>/.exec(routed)!;
    expect(s2[1].startsWith("edgeStyle=orthogonalEdgeStyle;curved=1;html=1;")).toBe(true);
    expect(s2[1]).not.toContain("libavoidRouting");
    expect(s2[2]).not.toContain("points");
    // The child of the collapsed group is not on the page: it is neither an obstacle nor a finding.
    expect(result.stdout).not.toContain("'h'");
  });

  it("keeps a label written in single quotes, a declaration and a comment; a name with > is not a compressed page", () => {
    const quoted = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- 주문 흐름 -->\n<mxfile host='app'><diagram id='p' name='A -> B'><mxGraphModel grid='0'><root><mxCell id='0'/><mxCell id='1' parent='0'/>${cell("a", "A", 40, 40)}${cell("b", "B", 260, 40)}${cell("c", "C", 480, 40)}<mxCell id="e" value='&lt;span style="color:red"&gt;예&lt;/span&gt;' style="edgeStyle=orthogonalEdgeStyle;html=1;dashed=1;" edge="1" parent="1" source="a" target="c"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;
    const file = write("quoted.drawio", quoted);
    const checked = run(["check", file]);
    expect(checked.stdout).not.toMatch(/^error /m);
    expect(checked.stdout).toMatch(/warning \[edge-may-cross-shape\] cell 'e'/);
    expect(checked.status).toBe(0);
    const result = run(["route", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 connector(s) routed around the shapes");
    const routed = fs.readFileSync(file, "utf8");
    expect(routed.startsWith(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- 주문 흐름 -->\n<mxfile`)).toBe(true);
    expect(routed).toContain(`value="&lt;span style=&quot;color:red&quot;&gt;예&lt;/span&gt;"`);
    expect(routed).toMatch(/<mxCell id="e" value="[^"]*" style="dashed=1;edgeStyle=orthogonalEdgeStyle;[^"]*libavoidRouting=1/);
  });

  it("refuses what it cannot read or route: not UTF-8, a parent cycle, too many connectors", () => {
    const cp949 = Buffer.concat([Buffer.from(`<mxfile><diagram name="p"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="`), Buffer.from([0xc1, 0xd6, 0xb9, 0xae]), Buffer.from(`" vertex="1" parent="1"><mxGeometry width="80" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`)]);
    const legacy = path.join(tempDir(), "cp949.drawio");
    fs.writeFileSync(legacy, cp949);
    const encoded = run(["layout", legacy]);
    expect(encoded.status).toBe(1);
    expect(encoded.stderr).toContain("is not UTF-8 text");
    expect(fs.readFileSync(legacy).equals(cp949)).toBe(true);

    const cycle = mxfile(page([cell("a", "A", 0, 0, 160, 60, undefined, "b"), cell("b", "B", 0, 0, 160, 60, undefined, "a"), cell("c", "C", 300, 0), edge("e1", "a", "c")]));
    const looped = write("cycle.drawio", cycle);
    expect(run(["check", looped]).stdout).toContain("error [parent-cycle]");
    for (const command of ["layout", "route"]) {
      const result = run([command, looped]);
      expect(result.status, command).toBe(1);
      expect(fs.readFileSync(looped, "utf8")).toBe(cycle);
    }

    const many: string[] = [];
    for (let i = 0; i <= 401; i++) many.push(cell(`n${i}`, `${i}`, (i % 20) * 220, Math.floor(i / 20) * 140));
    for (let i = 0; i < 401; i++) many.push(edge(`e${i}`, `n${i}`, `n${i + 1}`));
    const big = run(["route", write("many.drawio", mxfile(page(many)))]);
    expect(big.status).toBe(1);
    expect(big.stderr).toContain("401 connectors between shapes, and this tool routes up to 400");
    // Straight connectors count too: the router computes every one before the kept ones are put back.
    const straight = run(["route", write("straight.drawio", mxfile(page(many.map((text) => text.replace("edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;", "html=1;")))))]);
    expect(straight.status).toBe(1);
    expect(straight.stderr).toContain("401 connectors between shapes");

    // An old copy of a cell left in a comment would take the write meant for the live one.
    const commented = mxfile(page([`<!-- old: ${cell("a", "A", 500, 500)} -->`, cell("a", "A", 40, 40), cell("b", "B", 260, 40), edge("e1", "a", "b")]));
    const withComment = write("comment.drawio", commented);
    expect(run(["check", withComment]).status).toBe(0);
    const held = run(["layout", withComment]);
    expect(held.status).toBe(1);
    expect(held.stderr).toContain("a comment holds an <mxCell>");
    expect(fs.readFileSync(withComment, "utf8")).toBe(commented);
  });

  it("check: overlap is judged on the page, containers and their titles included, and the summary counts everything", () => {
    const page1 = [
      cell("box", "서비스", 0, 0, 300, 200, "swimlane;startSize=28;html=1;fontSize=14;"),
      cell("in", "API", 20, 60, 160, 60, undefined, "box"),
      cell("big", "밖으로 나간 자식", 200, 60, 160, 60, undefined, "box"),
      cell("out", "위에 놓인 상자", 60, 80),
      cell("box2", "다른 그룹", 250, 100, 300, 200, "swimlane;startSize=28;html=1;fontSize=14;"),
      cell("lane", "고객 지원 및 주문 접수 담당 부서", 0, 600, 800, 160, "swimlane;horizontal=0;startSize=110;html=1;fontSize=14;"),
      cell("ghost", "보이지 않음", 60, 80).replace('vertex="1"', 'vertex="1" visible="0"'),
    ];
    const result = run(["check", write("page.drawio", mxfile(page(page1)))]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/warning \[overlap\] cell 'in': 'in' \("API"\) and 'out' \("위에 놓인 상자"\) overlap/);
    expect(result.stdout).toMatch(/warning \[overlap\] cell 'box': the containers 'box' \("서비스"\) and 'box2' \("다른 그룹"\) overlap/);
    expect(result.stdout).toMatch(/warning \[outside-container\] cell 'big'/);
    expect(result.stdout).toMatch(/warning \[label-overflow\] cell 'lane': the title of the container .* has no whiteSpace=wrap/);
    expect(result.stdout).not.toContain("'ghost'");

    const pile: string[] = [];
    for (let i = 0; i < 6; i++) pile.push(cell(`p${i}`, `${i}`, 0, 0));
    const piled = run(["check", write("pile.drawio", mxfile(page(pile)))]);
    // 6 shapes on one spot are 15 pairs: 8 are listed, 7 more are counted.
    expect(piled.stdout).toContain("… and 7 more [overlap]");
    expect(piled.stdout).toContain("drawio check: 0 error(s), 15 warning(s), 0 note(s)");
  });

  it("a diagram wrapped in another element is repaired, not passed as sound", () => {
    const wrapped = `<content>${THROUGH}</content>`;
    const file = write("wrapped.drawio", wrapped);
    const checked = run(["check", file]);
    expect(checked.status).toBe(1);
    expect(checked.stdout).toContain("error [needs-repair]");
    const result = run(["route", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("repaired: text around the diagram removed");
    const routed = fs.readFileSync(file, "utf8");
    expect(routed.startsWith("<mxfile")).toBe(true);
    expect(routed.endsWith("</mxfile>")).toBe(true);
    // A declaration in a comment is text, not a misplaced declaration.
    const quiet = run(["check", write("decl.drawio", `<?xml version="1.0"?><!-- was: <?xml version="1.1"?> -->${THROUGH}`)]);
    expect(quiet.stdout).not.toContain("malformed-xml");
  });

  it("layout: every connector comes out right-angled, and an overlap it did not make is reported, not blamed on it", () => {
    const straight = (id: string, source: string, target: string) => `<mxCell id="${id}" style="html=1;" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
    const file = write("straight-layout.drawio", mxfile(page([cell("a", "하나", 0, 0), cell("b", "둘", 0, 0), cell("c", "셋", 0, 0), straight("s1", "a", "b"), straight("s2", "b", "c"), straight("s3", "a", "c")])));
    const result = run(["layout", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("the connectors it routed are right-angled now");
    expect(result.stdout).not.toContain("edge-may-cross-shape");
    const laid = fs.readFileSync(file, "utf8");
    for (const id of ["s1", "s2", "s3"]) expect(laid).toMatch(new RegExp(`<mxCell id="${id}" style="[^"]*edgeStyle=orthogonalEdgeStyle`));

    // The rows of a stack written without y sit on each other as authored; the layout never moves them.
    const row = (id: string, label: string) => `<mxCell id="${id}" value="${label}" style="text;html=1;fontSize=14;" vertex="1" parent="cls"><mxGeometry width="160" height="26" as="geometry"/></mxCell>`;
    const uml = mxfile(page([cell("cls", "Order", 0, 0, 160, 86, "swimlane;childLayout=stackLayout;startSize=26;html=1;fontSize=14;"), row("r1", "+ id"), row("r2", "+ total"), cell("other", "Customer", 0, 0), edge("e1", "cls", "other")]));
    const stack = run(["layout", write("uml.drawio", uml)]);
    expect(stack.status).toBe(0);
    expect(stack.stdout).toMatch(/warning \[overlap\] cell 'r1'/);
  });

  it("writes through a link to the file it names and keeps the file's mode", () => {
    const file = write("real.drawio", THROUGH);
    fs.chmodSync(file, 0o600);
    const link = path.join(tempDir(), "link.drawio");
    fs.symlinkSync(file, link);
    expect(run(["route", link]).status).toBe(0);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toContain("libavoidRouting=1");
  });

  it("layout and route write nothing while the diagram has an error", () => {
    const dup = mxfile(page([cell("a", "A", 40, 40), cell("a", "B", 260, 40)]));
    for (const command of ["layout", "route"]) {
      const file = write(`${command}-dup.drawio`, dup);
      const result = run([command, file]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("error [duplicate-id] cell 'a'");
      expect(result.stderr).toContain("nothing was written");
      expect(fs.readFileSync(file, "utf8")).toBe(dup);
    }
  });

  it("lays out every page of a file", () => {
    const two = mxfile(page([cell("a", "하나", 0, 0), cell("b", "둘", 0, 0), edge("e1", "a", "b")], "첫째"), page([cell("c", "셋", 0, 0), cell("d", "넷", 0, 0), edge("e2", "c", "d")], "둘째"));
    const file = write("two.drawio", two);
    expect(run(["check", file]).stdout).toMatch(/warning \[overlap\] page "첫째", cell 'a'[\s\S]*warning \[overlap\] page "둘째", cell 'c'/);
    const result = run(["layout", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("[overlap]");
  });

  it("answers usage errors with status 2 and never writes into the skill folder", () => {
    expect(run([]).status).toBe(2);
    expect(run(["tidy", "x.drawio"]).status).toBe(2);
    expect(run(["layout"]).status).toBe(2);
    const file = write("u.drawio", THROUGH);
    const badFlow = run(["layout", file, "--flow", "sideways"]);
    expect(badFlow.status).toBe(2);
    expect(badFlow.stderr).toContain("down | right | tree-down | tree-right | radial | organic");
    expect(run(["route", file, "--flow", "right"]).status).toBe(2);
    expect(run(["check", file, "--out", "y.drawio"]).status).toBe(2);
    const inside = run(["route", file, "--out", path.join(kit(), "engine", "out.drawio")]);
    expect(inside.status).toBe(2);
    expect(inside.stderr).toContain("the skill folder is read-only");
    expect(run(["check", path.join(tempDir(), "missing.drawio")]).status).toBe(1);
  });
});
