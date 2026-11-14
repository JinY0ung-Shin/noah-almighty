#!/usr/bin/env node
// G — workspace files as MCP tool arguments against the REAL stack (pi-gateway 89a69bd, 2026-11-14): a tool
// argument the server marks `"x-workspace-file": true` is shown to the model as a /workspace path and filled by
// the gateway with {filename, mimeType, size, sha256, data} read from the OWNER's sandbox. pi's own tests only
// saw a fake sandbox; this goes model → gateway → sandboxd (lstat per path piece, read) → broker → the fixture.
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { W, check, client, dindTry, fake, finish, loadState, textOf, turn } from "./e2e-common.mjs";

const state = loadState();
const owner = client(state.owner.cookie);
const second = client(state.second.cookie);
const MiB = 1024 * 1024;
const stageCalls = async () => (await (await fetch("http://10.217.0.11:18092/_calls")).json()).stageCalls;
const RUN = Date.now().toString(36);

/** One scripted turn: the model makes the given tool calls one after another, then answers. Returns the tool results it read. */
async function scripted(c, { conv, avatarId, calls, label }) {
  // The fake LLM routes by the FIRST [[fake:KEY]] marker of the request, so one conversation keeps one key.
  const key = `mcpargs-${RUN}-${conv.slice(0, 8)}`;
  await fake.enqueue(key, [...calls.map((call) => ({ toolCalls: [call] })), { text: `끝 (${label})` }]);
  const started = Date.now();
  const t = await turn(c, { avatarId, conversationId: conv, message: `파일 올려 줘 [[fake:${key}]]` });
  const ms = Date.now() - started;
  const reqs = await fake.requests(key);
  const tools = (reqs.at(-1)?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => textOf(m.content)).slice(-calls.length);
  const done = t.of("done")[0];
  const ok = t.status === 200 && t.of("done").length === 1 && t.of("error").length === 0 && String(done?.message?.content ?? "").includes(`끝 (${label})`);
  if (!ok) console.log(`  [${label}] status ${t.status} ${JSON.stringify(t.json ?? t.of("error")).slice(0, 400)}`);
  return { ok, ms, tools, llm: JSON.stringify(reqs.map((r) => r.body)) };
}
const stage = (files, note = "n") => ({ name: "mcp_call", arguments: { name: "mcp__filefix__stage", arguments: { note, files } } });
const bash = (command) => ({ name: "bash", arguments: { command } });
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------------------
// 0. what the model is told about the tool
// ---------------------------------------------------------------------------------------------------------
const conv = randomUUID();
const found = await scripted(owner, { conv, avatarId: state.owner.id, calls: [{ name: "mcp_search", arguments: { query: "stage workspace files" } }], label: "search" });
console.log("  mcp_search result (head):", JSON.stringify((found.tools[0] ?? "").slice(0, 420)));
check(
  "G  the model sees the file argument as a /workspace path, not as the server's object",
  found.ok && (found.tools[0] ?? "").includes("mcp__filefix__stage") && (found.tools[0] ?? "").includes('"file":{"type":"string","description":"The file to stage. Absolute path of a file under /workspace') && !(found.tools[0] ?? "").includes("x-workspace-file"),
);

// ---------------------------------------------------------------------------------------------------------
// 1. two files the model made in its sandbox, sent by path
// ---------------------------------------------------------------------------------------------------------
const MAKE = [
  "mkdir -p /workspace/out && cd /workspace/out",
  `python3 -c "open('capture.png','wb').write(bytes(range(256))*40 + b'\\x00\\xff\\x00')"`,
  `printf 'a,b\\n1,2\\n' > 'map 1.csv'`,
  "head -c 29360128 /dev/urandom > big.pdf",
  ": > empty.png",
  "printf MZ > run.exe",
  "mkdir -p dir.png",
  "ln -sfn /etc/hostname link.txt",
  "ln -sfn /etc etc",
  "echo ---SHA; sha256sum capture.png 'map 1.csv' big.pdf",
  "echo ---LS; ls -la",
].join("; ");
const t1 = await scripted(owner, {
  conv,
  avatarId: state.owner.id,
  calls: [bash(MAKE), stage([{ field: "capture", file: "/workspace/out/capture.png" }, { field: "maps", file: "out/map 1.csv" }], "두 파일")],
  label: "two",
});
writeFileSync(`${W}/evidence/G-tool-results-two.txt`, t1.tools.join("\n\n=== next ===\n"));
const shaOf = Object.fromEntries(((t1.tools[0] ?? "").split("---SHA")[1]?.split("---LS")[0] ?? "").trim().split("\n").map((l) => [l.slice(66), l.slice(0, 64)]));
console.log("  sandbox sha256sum:", JSON.stringify(shaOf));
const got1 = parse(t1.tools[1] ?? "");
console.log("  stage result:", JSON.stringify(got1));
const KEYS = ["data", "filename", "mimeType", "sha256", "size"];
check("G  the turn completes and the fixture answers what it received", t1.ok && got1?.received?.length === 2 && got1.note === "두 파일", `${t1.ms} ms`);
const [capture, map] = got1?.received ?? [];
check(
  "G  capture.png arrives whole: the bytes hash to what the sandbox's own sha256sum says, with name, type, size and checksum declared",
  capture?.field === "capture" && capture.filename === "capture.png" && capture.mimeType === "image/png" && capture.receivedSize === 256 * 40 + 3 && capture.declaredSize === capture.receivedSize && capture.receivedSha256 === shaOf["capture.png"] && capture.declaredSha256 === capture.receivedSha256 && JSON.stringify(capture.keys) === JSON.stringify(KEYS),
  JSON.stringify(capture),
);
check(
  "G  a relative path with a space resolves under /workspace: 'out/map 1.csv' arrives as text/csv with its checksum",
  map?.field === "maps" && map.filename === "map 1.csv" && map.mimeType === "text/csv" && map.receivedSize === 8 && map.receivedSha256 === shaOf["map 1.csv"] && map.declaredSha256 === map.receivedSha256,
  JSON.stringify(map),
);
const captureB64 = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i))]).toString("base64").slice(0, 100);
check("G  the model's own requests carry the path, never the file's base64", t1.llm.includes("/workspace/out/capture.png") && !t1.llm.includes(captureB64));

// ---------------------------------------------------------------------------------------------------------
// 2. the limit: a 28 MiB file goes through sandboxd and the broker; more than 28 MiB together is refused
// ---------------------------------------------------------------------------------------------------------
const t2 = await scripted(owner, { conv, avatarId: state.owner.id, calls: [stage([{ field: "doc", file: "out/big.pdf" }], "큰 파일")], label: "28MiB" });
const big = parse(t2.tools[0] ?? "")?.received?.[0];
console.log("  28 MiB stage result:", JSON.stringify(big), `— the whole turn took ${t2.ms} ms`);
check(
  "G  a 28 MiB file (the limit) arrives whole: size and sha256 as the sandbox has them",
  t2.ok && big?.receivedSize === 28 * MiB && big.receivedSha256 === shaOf["big.pdf"] && big.declaredSha256 === big.receivedSha256 && big.mimeType === "application/pdf",
  `${t2.ms} ms`,
);
const before = await stageCalls();
const t3 = await scripted(owner, { conv, avatarId: state.owner.id, calls: [stage([{ file: "out/big.pdf" }, { file: "out/capture.png" }])], label: "over" });
console.log("  over-limit result:", JSON.stringify((t3.tools[0] ?? "").slice(0, 200)));
check("G  28 MiB + one more file: refused with the limit named, and the tool is not called", t3.ok && (t3.tools[0] ?? "").includes("can be at most 28 MiB together") && (await stageCalls()) === before);

// ---------------------------------------------------------------------------------------------------------
// 3. what is not a regular, non-empty, allowed file of the workspace is refused — with a good file next to it
// ---------------------------------------------------------------------------------------------------------
const REFUSALS = [
  ["/etc/hostname.txt", "is outside /workspace"],
  ["out/../../etc/hostname.txt", "is outside /workspace"],
  ["/tmp/x.txt", "is outside /workspace"],
  ["out/missing.png", "does not exist"],
  ["out/empty.png", "is empty"],
  ["out/run.exe", "cannot be sent: only .pdf"],
  ["out/dir.png", "is not a regular file"],
  ["out/link.txt", "goes through a symbolic link (/workspace/out/link.txt)"],
  ["out/etc/hostname.txt", "goes through a symbolic link (/workspace/out/etc)"],
];
const refusedBefore = await stageCalls();
const t4 = await scripted(owner, {
  conv,
  avatarId: state.owner.id,
  calls: REFUSALS.map(([file]) => stage([{ field: "ok", file: "out/capture.png" }, { field: "bad", file }])),
  label: "refusals",
});
for (const [i, [file, message]] of REFUSALS.entries()) {
  check(`G  ${file} → refused: "${message}"`, t4.ok && (t4.tools[i] ?? "").includes(message), JSON.stringify((t4.tools[i] ?? "").slice(0, 160)));
}
check("G  …and none of those calls reached the tool (a good file in the same call is not sent either)", (await stageCalls()) === refusedBefore, `stage calls ${refusedBefore} → ${await stageCalls()}`);

// ---------------------------------------------------------------------------------------------------------
// 4. a colleague's chat with the owner's avatar is read_only: the owner's files are not sent
// ---------------------------------------------------------------------------------------------------------
const mateBefore = await stageCalls();
const t5 = await scripted(second, { conv: randomUUID(), avatarId: state.owner.id, calls: [stage([{ file: "/workspace/out/capture.png" }])], label: "colleague" });
console.log("  colleague result:", JSON.stringify((t5.tools[0] ?? "").slice(0, 200)));
check(
  "G  a colleague chat (read_only): refused, the tool is not called, the owner's file stays where it is",
  t5.ok && (t5.tools[0] ?? "").includes("This session is read-only: files of the workspace cannot be sent.") && (await stageCalls()) === mateBefore,
);

// ---------------------------------------------------------------------------------------------------------
// 5. the logs carry no file content
// ---------------------------------------------------------------------------------------------------------
const logs = ["gateway", "mcp-broker", "sandboxd"].map((s) => dindTry("docker", "logs", `noah-almighty-${s}-1`).out).join("\n");
check("G  gateway, broker and sandboxd logs carry none of the file's base64", !logs.includes(captureB64), `${logs.length} log chars`);

writeFileSync(`${W}/evidence/G-summary.json`, JSON.stringify({ shaOf, two: got1, big, timing: { twoMs: t1.ms, bigMs: t2.ms }, stageCalls: await stageCalls() }, null, 1));
finish();
