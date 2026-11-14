#!/usr/bin/env node
// pi 1.5.2 describes grep's `glob` to the model as "relative to path … A pattern without '/' matches file names
// at any depth". The gateway runs grep in the sandbox with its OWN execute, so this asks the real rg there
// whether it does what the text says (it did not at pi 92a69dd — a glob with a '/' was matched against the
// session's cwd; fixed at cbbb1b7). A guard since then.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { W, check, client, fake, finish, loadState, textOf, turn } from "./e2e-common.mjs";

const state = loadState();
const owner = client(state.owner.cookie);
const RUN = Date.now().toString(36);
const key = `glob-${RUN}`;
const D = `/workspace/gv-${RUN}`;
const NEEDLE = `GLOBNEEDLE${RUN}`;
const calls = [
  { name: "bash", arguments: { command: `mkdir -p ${D}/sub/deep && cd ${D} && for f in a.txt sub/b.txt sub/deep/c.txt sub/d.md other.md; do echo ${NEEDLE} > $f; done; find . -type f | sort` } },
  { name: "grep", arguments: { pattern: NEEDLE, path: D, glob: "*.txt" } },
  { name: "grep", arguments: { pattern: NEEDLE, path: D, glob: "sub/**/*.txt" } },
  { name: "grep", arguments: { pattern: NEEDLE, path: D, glob: "sub/*.txt" } },
  { name: "grep", arguments: { pattern: NEEDLE, path: D } },
  // diagnosis: is a glob with '/' matched against the rg process's cwd (/workspace) instead of `path`?
  { name: "grep", arguments: { pattern: NEEDLE, path: D, glob: `gv-${RUN}/sub/*.txt` } },
  { name: "grep", arguments: { pattern: NEEDLE, path: D, glob: "**/sub/*.txt" } },
  { name: "grep", arguments: { pattern: NEEDLE, glob: `gv-${RUN}/sub/**/*.txt` } },
  // pi-gateway cbbb1b7: rg runs in the searched directory, and a leading "./" on a glob is dropped
  { name: "grep", arguments: { pattern: NEEDLE, path: D, glob: "./sub/*.txt" } },
  { name: "grep", arguments: { pattern: NEEDLE, path: D, glob: "!sub/**" } },
  { name: "grep", arguments: { pattern: NEEDLE, path: `${D}/sub/b.txt` } },
];
await fake.enqueue(key, [...calls.map((call) => ({ toolCalls: [call] })), { text: "끝 (glob)" }]);
const t = await turn(owner, { avatarId: state.owner.id, conversationId: randomUUID(), message: `grep 확인 [[fake:${key}]]` });
const reqs = await fake.requests(key);
const tools = (reqs.at(-1)?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => textOf(m.content)).slice(-calls.length);
writeFileSync(`${W}/evidence/V-grep-glob-results.txt`, tools.map((x, i) => `=== ${JSON.stringify(calls[i].arguments)}\n${x}`).join("\n\n"));
const files = (text) => ["a.txt", "sub/b.txt", "sub/deep/c.txt", "sub/d.md", "other.md"].filter((f) => new RegExp(`(^|[\\s/])${f.replace(/[.]/g, "\\.")}[:\\s-]`, "m").test(text ?? "")).join(" ");
for (const [i, x] of tools.entries()) console.log(`  ${JSON.stringify(calls[i].arguments.glob ?? calls[i].arguments.command?.slice(0, 20))}: ${JSON.stringify((x ?? "").slice(0, 400))}`);
check("the turn completes", t.status === 200 && t.of("done").length === 1 && t.of("error").length === 0);
check("glob '*.txt' (no '/'): the .txt files at EVERY depth, no .md", files(tools[1]) === "a.txt sub/b.txt sub/deep/c.txt", files(tools[1]));
check("glob 'sub/**/*.txt' is relative to path: the .txt files under sub/ only", files(tools[2]) === "sub/b.txt sub/deep/c.txt", files(tools[2]));
check("glob 'sub/*.txt': sub/b.txt only", files(tools[3]) === "sub/b.txt", files(tools[3]));
check("(control) no glob: all five files", files(tools[4]) === "a.txt sub/b.txt sub/deep/c.txt sub/d.md other.md", files(tools[4]));
check("glob './sub/*.txt' (a leading './'): sub/b.txt only", files(tools[8]) === "sub/b.txt", files(tools[8]));
check("glob '!sub/**' (an exclusion, relative to path): the two files outside sub/", files(tools[9]) === "a.txt other.md", files(tools[9]));
check("(control) path is ONE file: its match, named by the file", /(^|\n)b\.txt:1: /.test(tools[10] ?? ""), JSON.stringify((tools[10] ?? "").slice(0, 80)));
check("a glob written from /workspace no longer matches under another path ('gv-<run>/sub/*.txt' → nothing)", (tools[5] ?? "") === "No matches found", JSON.stringify((tools[5] ?? "").slice(0, 80)));
check("no path (cwd /workspace): 'gv-<run>/sub/**/*.txt' finds the two files, named from /workspace", new RegExp(`gv-${RUN}/sub/b\\.txt:1:`).test(tools[7] ?? "") && new RegExp(`gv-${RUN}/sub/deep/c\\.txt:1:`).test(tools[7] ?? ""), JSON.stringify((tools[7] ?? "").slice(0, 120)));
console.log(`  (diagnosis) path + glob written from /workspace ('gv-<run>/sub/*.txt'): ${files(tools[5]) || "nothing"}`);
console.log(`  (diagnosis) path + glob '**/sub/*.txt': ${files(tools[6]) || "nothing"}`);
console.log(`  (diagnosis) no path (cwd /workspace) + glob 'gv-<run>/sub/**/*.txt': ${files(tools[7]) || "nothing"}`);
finish();
