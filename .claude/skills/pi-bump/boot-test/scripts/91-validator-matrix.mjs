// NOT in the default run (drive.sh): it compares TWO gateway images, and the old one exists only where an older
// stack was built. Run it by hand when a bump changes pi's agent libraries (pi-ai / pi-schema): once in an image
// of the OLD pin and once in the image the dind just built, then diff the two outputs.
//   old (an image on the host daemon):   docker run --rm -i --network none --entrypoint node -w /app \
//                                          pi-gateway/gateway:latest --input-type=module - < 91-validator-matrix.mjs
//   new (inside the run's dind):         docker exec -i noahcompose-dind docker run --rm -i --network none \
//                                          --entrypoint node -w /app pi-gateway/gateway:latest --input-type=module - < 91-validator-matrix.mjs
// With no image at hand, pi-ai alone from npm does it (`npm i @earendil-works/pi-ai@<version>` in a scratch folder).
//
// Library-level look at pi-ai's validateToolArguments with plain JSON schemas (what an MCP tool lists): one block
// per case, the converted arguments or the validation failure.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { validateToolArguments } from "@earendil-works/pi-ai";
const require = createRequire(`${process.cwd()}/`);
let version = "?";
try { version = JSON.parse(readFileSync(require.resolve("@earendil-works/pi-ai/package.json"), "utf8")).version; } catch { try { version = JSON.parse(readFileSync(`${process.cwd()}/node_modules/@earendil-works/pi-ai/package.json`, "utf8")).version; } catch {} }
console.log(`pi-ai ${version}`);
const S = (properties, required = [], extra = {}) => ({ type: "object", properties, required, ...extra });
const CASES = [
  ["integer given as a numeric string", S({ n: { type: "integer" } }), { n: "24" }],
  ["number given as a numeric string", S({ n: { type: "number" } }), { n: "2.5" }],
  ["integer given as a word", S({ n: { type: "integer" } }), { n: "many" }],
  ["boolean given as \"true\"", S({ b: { type: "boolean" } }), { b: "true" }],
  ["string given as a number", S({ id: { type: "string" } }, ["id"]), { id: 5 }],
  ["array of strings given one string", S({ tags: { type: "array", items: { type: "string" } } }), { tags: "solo" }],
  ["array of objects given one object", S({ items: { type: "array", minItems: 1, items: S({ title: { type: "string" } }, ["title"]) } }, ["items"]), { items: { title: "t" } }],
  ["array given as a JSON string", S({ tags: { type: "array", items: { type: "string" } } }), { tags: "[\"a\",\"b\"]" }],
  ["object given as a JSON string", S({ o: S({ a: { type: "string" } }) }), { o: "{\"a\":\"x\"}" }],
  ["required argument missing", S({ id: { type: "string" }, status: { type: "string" } }, ["id"]), { status: "done" }],
  ["nested required argument missing", S({ items: { type: "array", items: S({ title: { type: "string" } }, ["title"]) } }, ["items"]), { items: [{ note: "n" }] }],
  ["value outside an enum", S({ e: { type: "string", enum: ["markdown", "mermaid"] } }), { e: "widget" }],
  ["anyOf string|number given a numeric string", S({ v: { anyOf: [{ type: "string" }, { type: "number" }] } }), { v: "5" }],
  ["optional string given null", S({ s: { type: "string" } }), { s: null }],
  ["nullable string given null", S({ s: { anyOf: [{ type: "string" }, { type: "null" }] } }), { s: null }],
  ["unknown key, additionalProperties false", S({ a: { type: "string" } }, [], { additionalProperties: false }), { a: "x", extra: 1 }],
  ["unknown key, additionalProperties unset", S({ a: { type: "string" } }), { a: "x", extra: 1 }],
  ["integer out of range (max 5)", S({ n: { type: "integer", minimum: 1, maximum: 5 } }), { n: "9" }],
];
for (const [label, parameters, args] of CASES) {
  let out;
  try {
    out = `OK   → ${JSON.stringify(validateToolArguments({ name: "t", description: "", parameters }, { type: "toolCall", id: "c", name: "t", arguments: args }))}`;
  } catch (err) {
    out = `FAIL → ${String(err?.message ?? err).split("\n\nReceived arguments")[0].replace(/\n/g, " ⏎ ")}`;
  }
  console.log(`\n# ${label}: ${JSON.stringify(args)}\n${out}`);
}
