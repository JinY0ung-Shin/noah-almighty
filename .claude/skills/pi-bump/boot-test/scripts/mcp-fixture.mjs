#!/usr/bin/env node
// Minimal MCP Streamable HTTP server for the boot test: ONE tool, `file`, that answers with a binary
// `resource` block (pi-gateway 5adb8e5 saves it into the run's sandbox). Arguments:
//   size      bytes of the file (the bytes are (i*7+3)%251, so the checker can recompute them)
//   uri       the resource uri (default artifact://fx/report.pdf)
//   declare   "ok" (default: _meta carries the true size + sha256) | "none" | "wrong-sha" | "wrong-size"
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PORT = 18092;
const bytesOf = (size) => {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 7 + 3) % 251;
  return b;
};
const TOOL = {
  name: "file",
  description: "Returns a test file of the given size as a binary resource.",
  inputSchema: { type: "object", properties: { size: { type: "number" }, uri: { type: "string" }, declare: { type: "string" } }, required: ["size"] },
};
// `stage` takes workspace files (pi-gateway 89a69bd fills the marked argument) and answers what it received.
const STAGE = {
  name: "stage",
  description: "Stages workspace files and reports what arrived.",
  inputSchema: {
    type: "object",
    properties: {
      note: { type: "string" },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: { field: { type: "string" }, file: { type: "object", "x-workspace-file": true, description: "The file to stage." } },
          required: ["file"],
        },
      },
    },
    required: ["files"],
  },
};
let calls = 0;
let stageCalls = 0;
createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/_calls") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ calls, stageCalls }));
    if (req.method !== "POST") return res.writeHead(405).end();
    const msg = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (msg.id === undefined) return res.writeHead(202).end();
    let result;
    if (msg.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "file-fixture", version: "1" } };
    else if (msg.method === "tools/list") result = { tools: [TOOL, STAGE] };
    else if (msg.method === "tools/call" && msg.params?.name === "stage") {
      stageCalls++;
      const args = msg.params.arguments ?? {};
      const received = (args.files ?? []).map((f) => {
        const file = f.file ?? {};
        const bytes = typeof file.data === "string" ? Buffer.from(file.data, "base64") : Buffer.alloc(0);
        return {
          field: f.field ?? null,
          keys: Object.keys(file).sort(),
          filename: file.filename,
          mimeType: file.mimeType,
          declaredSize: file.size,
          declaredSha256: file.sha256,
          receivedSize: bytes.length,
          receivedSha256: createHash("sha256").update(bytes).digest("hex"),
        };
      });
      result = { content: [{ type: "text", text: JSON.stringify({ note: args.note ?? null, received }) }] };
    }
    else if (msg.method === "tools/call" && msg.params?.name === "file") {
      calls++;
      const args = msg.params.arguments ?? {};
      const bytes = bytesOf(Number(args.size));
      const sha = createHash("sha256").update(bytes).digest("hex");
      const declare = args.declare ?? "ok";
      const meta = declare === "none" ? undefined : { size: declare === "wrong-size" ? bytes.length + 1 : bytes.length, sha256: declare === "wrong-sha" ? "0".repeat(64) : sha };
      result = {
        content: [
          { type: "text", text: `file of ${bytes.length} bytes` },
          { type: "resource", resource: { uri: args.uri ?? "artifact://fx/report.pdf", mimeType: "application/pdf", blob: bytes.toString("base64"), ...(meta ? { _meta: meta } : {}) } },
        ],
      };
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
}).listen(PORT, "0.0.0.0", () => console.log(`mcp fixture on :${PORT}`));
