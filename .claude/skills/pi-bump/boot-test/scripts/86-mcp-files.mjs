#!/usr/bin/env node
// F — files in MCP tool results against the REAL stack (pi-gateway 5adb8e5, 2026-11-13): a binary `resource`
// block from a broker MCP server (the `filefix` fixture, 06-mcp-fixture.sh) is saved into the OWNER's sandbox at
// /workspace/artifacts/<pi session id>/<name>-<sha8><ext>, and the model gets the path, size and checksum.
// pi's own tests only saw a fake sandbox; this goes fixture → broker → gateway → sandboxd → the container.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { W, check, client, dind, dindTry, fake, finish, loadState, sha256, textOf, turn } from "./e2e-common.mjs";

const state = loadState();
const owner = client(state.owner.cookie);
const second = client(state.second.cookie);
const MiB = 1024 * 1024;
const userKey = (principal) => `u-${createHash("sha256").update(principal, "utf8").digest("hex").slice(0, 24)}`;
const ownerWorkspace = `${W}/home/workspaces/${userKey(state.owner.id)}`;
const sandboxName = `pi-sbx-${userKey(state.owner.id)}`;
const bytesOf = (size) => {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 7 + 3) % 251;
  return b;
};
const fixtureCalls = async () => (await (await fetch("http://10.217.0.11:18092/_calls")).json()).calls;
const artifactsOnHost = () => {
  const root = `${ownerWorkspace}/artifacts`;
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((sid) => readdirSync(`${root}/${sid}`).map((name) => `${sid}/${name}`)).sort();
};
const evidence = {};

/** One scripted turn: the model calls the fixture through mcp_call, optionally runs a shell command, then answers. */
const RUN = Date.now().toString(36);
async function fileTurn(c, { conv, avatarId, args, shell, label }) {
  // The fake LLM routes by the FIRST [[fake:KEY]] marker of the request, so one conversation keeps one key.
  const key = `mcpfile-${RUN}-${conv.slice(0, 8)}`;
  const turns = [{ text: "파일을 받겠습니다.", toolCalls: [{ name: "mcp_call", arguments: { name: "mcp__filefix__file", arguments: args } }] }];
  if (shell) turns.push({ toolCalls: [{ name: "bash", arguments: { command: shell } }] });
  turns.push({ text: `끝 (${label})` });
  await fake.enqueue(key, turns);
  const started = Date.now();
  const t = await turn(c, { avatarId, conversationId: conv, message: `파일 받아 줘 [[fake:${key}]]` });
  const ms = Date.now() - started;
  const reqs = await fake.requests(key);
  const toolTexts = (reqs.at(-1)?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => textOf(m.content));
  const done = t.of("done")[0];
  const ok = t.status === 200 && t.of("done").length === 1 && t.of("error").length === 0 && String(done?.message?.content ?? "").includes(`끝 (${label})`);
  if (!ok) console.log(`  [${label}] status ${t.status} errors ${JSON.stringify(t.json ?? t.of("error")).slice(0, 400)}`);
  // The tool results of THIS turn are the last ones in the model's final request.
  const mine = toolTexts.slice(-(shell ? 2 : 1));
  return { ok, ms, fileResult: mine[0] ?? "", shellResult: shell ? (mine[1] ?? "") : "", frames: t.frames };
}
const savedOf = (text) => {
  const m = /Saved to the workspace: (\{.*\})/.exec(text);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------------------
// 1. a small file with a declared size + sha256
// ---------------------------------------------------------------------------------------------------------
const conv = randomUUID();
const SMALL = 1_234_567;
const small = bytesOf(SMALL);
const smallSha = sha256(small);
const before = artifactsOnHost();
const t1 = await fileTurn(owner, { conv, avatarId: state.owner.id, args: { size: SMALL }, shell: "sha256sum /workspace/artifacts/*/*; echo ---LS; ls -la /workspace/artifacts/*/; echo ---ID; id", label: "small" });
writeFileSync(`${W}/evidence/F-tool-result-small.txt`, `${t1.fileResult}\n\n=== shell ===\n${t1.shellResult}`);
console.log("  the model's tool result:", JSON.stringify(t1.fileResult));
const saved1 = savedOf(t1.fileResult);
const sid = /^\/workspace\/artifacts\/([0-9a-f-]{36})\//.exec(saved1?.saved_path ?? "")?.[1];
check("F  the turn completes and the model's tool result names a saved file", t1.ok && saved1 !== null, `${t1.ms} ms`);
check(
  "F  saved_path is /workspace/artifacts/<pi session uuid>/report-<sha8>.pdf with the true size, sha256, mime and truncated:false",
  saved1?.saved_path === `/workspace/artifacts/${sid}/report-${smallSha.slice(0, 8)}.pdf` && saved1.size === SMALL && saved1.sha256 === smallSha && saved1.mime === "application/pdf" && saved1.truncated === false,
  JSON.stringify(saved1),
);
check("F  the fixture's own text stays in the result, the base64 does not reach the model", t1.fileResult.startsWith(`file of ${SMALL} bytes\n`) && t1.fileResult.length < 600, `${t1.fileResult.length} chars`);
check("F  the model, with its own shell in that sandbox, reads the same bytes at that path", t1.shellResult.includes(`${smallSha}  ${saved1?.saved_path}`), t1.shellResult.split("\n")[0]);
console.log("  sandbox ls / id:\n" + t1.shellResult.split("---LS")[1]?.split("\n").map((l) => "    " + l).join("\n"));
const containers = dind("docker", "ps", "--filter", "label=pi-gateway.sandbox=1", "--format", "{{.Names}}").trim().split("\n");
check("F  the file is in the OWNER's sandbox container (docker exec sha256sum)", containers.includes(sandboxName) && dindTry("docker", "exec", sandboxName, "sha256sum", saved1?.saved_path ?? "/nonexistent").out.startsWith(smallSha), containers.join(" "));
const hostFile = `${ownerWorkspace}/artifacts/${sid}/report-${smallSha.slice(0, 8)}.pdf`;
check("F  …and on the host under the owner's workspace, byte-identical", existsSync(hostFile) && sha256(readFileSync(hostFile)) === smallSha, hostFile.replace(W, "$W"));
const afterSmall = artifactsOnHost();
check("F  exactly one new file, no .part- left behind", afterSmall.length === before.length + 1 && !afterSmall.some((p) => p.includes(".part-")), afterSmall.filter((p) => !before.includes(p)).join(" "));
const st = existsSync(hostFile) ? statSync(hostFile) : null;
console.log(`  host file: mode ${st ? (st.mode & 0o777).toString(8) : "-"} uid ${st?.uid} size ${st?.size}; folder mode ${(statSync(`${ownerWorkspace}/artifacts/${sid}`).mode & 0o777).toString(8)}`);

// ---------------------------------------------------------------------------------------------------------
// 2. the same file again in the same conversation → the same path; another conversation → another folder
// ---------------------------------------------------------------------------------------------------------
const t2 = await fileTurn(owner, { conv, avatarId: state.owner.id, args: { size: SMALL }, label: "again" });
check("F  the same file again in the same conversation → the same path, still one file", t2.ok && savedOf(t2.fileResult)?.saved_path === saved1?.saved_path && artifactsOnHost().length === afterSmall.length, savedOf(t2.fileResult)?.saved_path);
const conv2 = randomUUID();
const t2b = await fileTurn(owner, { conv: conv2, avatarId: state.owner.id, args: { size: SMALL }, label: "other-conversation" });
const sid2 = /^\/workspace\/artifacts\/([0-9a-f-]{36})\//.exec(savedOf(t2b.fileResult)?.saved_path ?? "")?.[1];
check("F  another conversation saves into another session folder (the first one's file is untouched)", t2b.ok && sid2 && sid2 !== sid && sha256(readFileSync(hostFile)) === smallSha, `${sid} vs ${sid2}`);

// ---------------------------------------------------------------------------------------------------------
// 3. the limit: 28 MiB goes through the real sandboxd; one byte more is refused by the broker
// ---------------------------------------------------------------------------------------------------------
const BIG = 28 * MiB;
const bigSha = sha256(bytesOf(BIG));
const t3 = await fileTurn(owner, { conv, avatarId: state.owner.id, args: { size: BIG, uri: "artifact://fx/big.bin", declare: "none" }, label: "28MiB" });
const saved3 = savedOf(t3.fileResult);
console.log("  28 MiB tool result:", JSON.stringify(t3.fileResult), `— the whole turn took ${t3.ms} ms`);
check("F  a 28 MiB file (the limit) is saved: path, size and sha256 as sent", t3.ok && saved3?.saved_path === `/workspace/artifacts/${sid}/big-${bigSha.slice(0, 8)}.bin` && saved3.size === BIG && saved3.sha256 === bigSha, `${t3.ms} ms`);
const bigInSandbox = dindTry("docker", "exec", sandboxName, "sha256sum", saved3?.saved_path ?? "/nonexistent");
check("F  …and the container holds exactly those 28 MiB (docker exec sha256sum)", bigInSandbox.out.startsWith(bigSha), bigInSandbox.out.trim().slice(0, 120));
const countBeforeOver = artifactsOnHost().length;
const t4 = await fileTurn(owner, { conv, avatarId: state.owner.id, args: { size: BIG + 1, uri: "artifact://fx/toobig.bin" }, label: "over" });
console.log("  over-limit tool result:", JSON.stringify(t4.fileResult.slice(0, 300)));
check(
  "F  28 MiB + 1 byte: the broker drops the file and says so; nothing is saved",
  t4.ok && t4.fileResult.includes(`its files are ${BIG + 1} bytes, over the ${BIG}-byte limit; its images and files were not delivered`) && !t4.fileResult.includes("Saved to the workspace") && artifactsOnHost().length === countBeforeOver,
  "",
);

// ---------------------------------------------------------------------------------------------------------
// 4. bytes that differ from what the server declared; a uri that tries to leave the folder
// ---------------------------------------------------------------------------------------------------------
for (const [declare, expected] of [["wrong-sha", "was not saved: the sha256 of the received bytes does not match the one the server declared"], ["wrong-size", `was not saved: received ${SMALL} bytes, but the server declared ${SMALL + 1}`]]) {
  const t = await fileTurn(owner, { conv, avatarId: state.owner.id, args: { size: SMALL, uri: `artifact://fx/${declare}.pdf`, declare }, label: declare });
  check(`F  declared ${declare.replace("wrong-", "")} differs → not saved, and the model is told why`, t.ok && t.fileResult.includes(expected) && !t.fileResult.includes("artifact://") && artifactsOnHost().length === countBeforeOver, JSON.stringify(t.fileResult.slice(0, 200)));
}
const ESCAPE = 4321;
const escapeSha = sha256(bytesOf(ESCAPE));
const t5 = await fileTurn(owner, { conv, avatarId: state.owner.id, args: { size: ESCAPE, uri: "artifact://fx/..%2F..%2F.home%2F.bashrc" }, label: "escape" });
const saved5 = savedOf(t5.fileResult);
check("F  a uri whose last piece is ../../.home/.bashrc → artifact-<sha8>.bin inside the session folder", t5.ok && saved5?.saved_path === `/workspace/artifacts/${sid}/artifact-${escapeSha.slice(0, 8)}.bin`, saved5?.saved_path);
check("F  …and nothing was written to .home/.bashrc", !existsSync(`${ownerWorkspace}/.home/.bashrc`) || !readFileSync(`${ownerWorkspace}/.home/.bashrc`).equals(bytesOf(ESCAPE)));

// ---------------------------------------------------------------------------------------------------------
// 5. a colleague's chat with the owner's avatar is a read_only session: nothing is written
// ---------------------------------------------------------------------------------------------------------
const mateConv = randomUUID();
const callsBefore = await fixtureCalls();
const filesBeforeMate = artifactsOnHost();
const t6 = await fileTurn(second, { conv: mateConv, avatarId: state.owner.id, args: { size: SMALL, uri: "artifact://fx/colleague.pdf" }, label: "colleague" });
console.log("  colleague tool result:", JSON.stringify(t6.fileResult.slice(0, 300)));
const mateWorkspace = `${W}/home/workspaces/${userKey(state.second.id)}`;
check(
  "F  a colleague chat (read_only): the tool ran, the file is NOT saved — not in the owner's workspace, not in the colleague's",
  t6.ok && (await fixtureCalls()) === callsBefore + 1 && !t6.fileResult.includes("Saved to the workspace") && JSON.stringify(artifactsOnHost()) === JSON.stringify(filesBeforeMate) && !existsSync(`${mateWorkspace}/artifacts`),
  `fixture calls ${callsBefore} → ${await fixtureCalls()}`,
);

// ---------------------------------------------------------------------------------------------------------
// 6. what Noah's 파일 tab shows of it (recorded; the tab is a read-only window onto the owner's workspace)
// ---------------------------------------------------------------------------------------------------------
const json = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};
const root = await json(await owner.get("/api/me/workspace"));
const rootNames = (root?.entries ?? []).map((e) => e.name);
const artifactsListing = await json(await owner.get("/api/me/workspace?path=artifacts"));
const sessionFolders = (artifactsListing?.entries ?? []).map((e) => e.name);
const inFolder = await json(await owner.get(`/api/me/workspace?path=${encodeURIComponent(`artifacts/${sid}`)}`));
console.log("  파일 tab root:", rootNames.join(" "));
console.log("  파일 tab artifacts/:", sessionFolders.join(" "));
console.log("  파일 tab artifacts/<this session>/:", (inFolder?.entries ?? []).map((e) => `${e.name} (${e.size ?? "?"})`).join(", "));
check("F  the 파일 tab lists artifacts/ at the workspace root, with one folder per pi session (both conversations' folders show)", rootNames.includes("artifacts") && sessionFolders.includes(sid) && sessionFolders.includes(sid2), `${sessionFolders.length} session folders`);
const dl = await owner.get(`/api/me/workspace/file?path=${encodeURIComponent(`artifacts/${sid}/report-${smallSha.slice(0, 8)}.pdf`)}`);
check("F  …and the saved file downloads through the tab byte-identical", dl.status === 200 && sha256(Buffer.from(await dl.arrayBuffer())) === smallSha, `status ${dl.status}`);

// ---------------------------------------------------------------------------------------------------------
// 7. the logs carry no uri and no content
// ---------------------------------------------------------------------------------------------------------
const logs = ["gateway", "mcp-broker", "sandboxd"].map((s) => dindTry("docker", "logs", `noah-almighty-${s}-1`).out).join("\n");
check("F  gateway, broker and sandboxd logs carry no artifact:// uri and no base64 of the file", !logs.includes("artifact://") && !logs.includes(small.toString("base64").slice(0, 120)), `${logs.length} log chars`);

evidence.saved = { small: saved1, big: saved3, escape: saved5 };
evidence.timing = { smallTurnMs: t1.ms, bigTurnMs: t3.ms, overLimitTurnMs: t4.ms };
evidence.fileTab = { rootNames, sessionFolders };
evidence.files = artifactsOnHost();
writeFileSync(`${W}/evidence/F-summary.json`, JSON.stringify(evidence, null, 1));
finish();
