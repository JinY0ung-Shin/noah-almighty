#!/usr/bin/env node
// C: document attachments against the REAL pi-gateway (Noah → pi input_file → /workspace/uploads/<name>).
// Also B(2) (python libraries in a sandbox of the built image) and B(3) (Agent / SendMessage in the tool list).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { W, check, client, dind, dindTry, fake, finish, loadState, sha256, textOf, turn } from "./e2e-common.mjs";

const state = loadState();
const owner = client(state.owner.cookie);
const second = client(state.second.cookie);
const evidence = {};
const dataUrl = (buffer) => `data:application/octet-stream;base64,${buffer.toString("base64")}`;
const userKey = (principal) => `u-${createHash("sha256").update(principal, "utf8").digest("hex").slice(0, 24)}`;

const NAMES = ["report.pdf", "매출표.csv", "notes.md"];
const FILES = NAMES.map((name) => ({ name, buffer: readFileSync(`${W}/fixtures/${name}`) }));
const SENT = Object.fromEntries(FILES.map((f) => [f.name, sha256(f.buffer)]));
console.log("sent:", JSON.stringify(SENT, null, 1));
check("fixture: the pdf starts with %PDF-", FILES[0].buffer.subarray(0, 5).toString() === "%PDF-");
let csvIsUtf8 = true;
try {
  new TextDecoder("utf-8", { fatal: true }).decode(FILES[1].buffer);
} catch {
  csvIsUtf8 = false;
}
check("fixture: the csv is NOT valid UTF-8 and decodes as CP949 Korean", !csvIsUtf8 && new TextDecoder("euc-kr").decode(FILES[1].buffer).includes("영업1팀"), JSON.stringify(new TextDecoder("euc-kr").decode(FILES[1].buffer).split("\r\n")[0]));

const KEY = `docs-${Date.now().toString(36)}`;
const conv = randomUUID();
const ownerWorkspace = `${W}/home/workspaces/${userKey(state.owner.id)}`;
const sandboxName = `pi-sbx-${userKey(state.owner.id)}`;

// ---------------------------------------------------------------------------------------------------------
// 1. the owner's document turn. The scripted model first runs ONE shell command in the sandbox (hashes the
//    uploads, imports the libraries, reads the pdf and the CP949 csv), then answers.
// ---------------------------------------------------------------------------------------------------------
const SHELL = [
  "cd /workspace/uploads",
  "echo ---SHA; sha256sum -- report.pdf 매출표.csv notes.md",
  "echo ---LS; ls -la",
  `echo ---IMPORT; python3 -c "import pypdf, docx, pptx, openpyxl, pandas; print('ok')"`,
  `echo ---PDF; python3 -c "import pypdf; print(pypdf.PdfReader('report.pdf').pages[0].extract_text())"`,
  `echo ---CSV; python3 -c "import pandas; print(pandas.read_csv('매출표.csv', encoding='cp949').to_string())"`,
  "echo ---ID; id; hostname",
].join("; ");
await fake.enqueue(KEY, [{ text: "문서를 확인하겠습니다.", toolCalls: [{ name: "bash", arguments: { command: SHELL } }] }, { text: "문서 세 개를 모두 읽었습니다." }]);
const message = `첨부한 문서 세 개를 요약해 줘 [[fake:${KEY}]]`;
const t1 = await turn(owner, { avatarId: state.owner.id, conversationId: conv, message, files: FILES.map((f) => ({ name: f.name, data: dataUrl(f.buffer) })) });
const done1 = t1.of("done")[0];
console.log("  SSE events:", [...new Set(t1.frames.map((f) => f.event))].join(", "));
check("C  the document turn completes (200, one done frame, the scripted answer)", t1.status === 200 && t1.of("done").length === 1 && t1.of("error").length === 0 && String(done1?.message?.content ?? "").includes("문서 세 개를 모두 읽었습니다."), `status ${t1.status}, answer ${JSON.stringify(done1?.message?.content)}${t1.json ? ` ${JSON.stringify(t1.json)}` : ""}`);
if (t1.of("error").length) console.log("  error frames:", JSON.stringify(t1.of("error")));

const reqs1 = await fake.requests(KEY);
evidence.firstRequest = reqs1[0]?.body;
writeFileSync(`${W}/evidence/C-fake-llm-requests-turn1.json`, JSON.stringify(reqs1, null, 1));
const first = reqs1[0]?.body ?? {};
const userTexts = (body) => (body.messages ?? []).filter((m) => m.role === "user").map((m) => textOf(m.content));
const lastUser1 = userTexts(first).at(-1) ?? "";
const markers = NAMES.map((name) => `[Attached file: /workspace/uploads/${name}]`);
check("C  the model's request carries pi's [Attached file: …] marker for each of the three", markers.every((m) => lastUser1.includes(m)), markers.filter((m) => lastUser1.includes(m)).join(" "));
const preamble = lastUser1.split("\n").find((line) => line.includes("**Attached documents (this turn)**")) ?? "";
check("C  …and Noah's turn-preamble line about the attached documents (three paths)", preamble.length > 0 && NAMES.every((name) => preamble.includes(`/workspace/uploads/${name}`)), "");
console.log("  preamble line:", preamble);
console.log("  tail of the user message as the model saw it:", JSON.stringify(lastUser1.slice(-330)));

// B(3): the tool list
const toolNames = (first.tools ?? []).map((t) => t.function?.name ?? t.name);
check("B3 the tool list of an ordinary owner turn includes Agent and SendMessage", toolNames.includes("Agent") && toolNames.includes("SendMessage"), `${toolNames.length} tools: ${toolNames.join(", ")}`);
const agentTool = (first.tools ?? []).find((t) => (t.function?.name ?? t.name) === "Agent");
console.log("  Agent.subagent_type enum:", JSON.stringify(agentTool?.function?.parameters?.properties?.subagent_type?.enum));

// The sandbox's own answer (the tool result the model received on its second call).
const toolResult = textOf((reqs1[1]?.body?.messages ?? []).findLast((m) => m.role === "tool")?.content);
writeFileSync(`${W}/evidence/C-sandbox-tool-result.txt`, toolResult);
const section = (name) => (new RegExp(`---${name}\\n([\\s\\S]*?)(?=\\n---|$)`).exec(toolResult)?.[1] ?? "").trim();
const sandboxHashes = Object.fromEntries(section("SHA").split("\n").filter(Boolean).map((line) => [line.slice(66), line.slice(0, 64)]));
check("C  inside the sandbox (model-run sha256sum) the three files are byte-identical to what was sent", NAMES.every((name) => sandboxHashes[name] === SENT[name]), JSON.stringify(sandboxHashes));
check("B2 in that sandbox: python3 -c \"import pypdf, docx, pptx, openpyxl, pandas; print('ok')\" → ok", section("IMPORT") === "ok", JSON.stringify(section("IMPORT")));
check("C  (extra) pypdf reads the pdf's text, pandas reads the CP949 csv in the sandbox", section("PDF").includes("PDF-MARK-7Q2") && section("CSV").includes("영업1팀") && section("CSV").includes("김하늘"), `${JSON.stringify(section("PDF"))} / ${JSON.stringify(section("CSV").split("\n")[1])}`);
console.log("  sandbox ls:\n" + section("LS").split("\n").map((l) => "    " + l).join("\n"));
console.log("  sandbox id:", section("ID").replace(/\n/g, " | "));

// The same files seen from outside the model: the sandbox CONTAINER and the owner's workspace on the host.
const containers = dind("docker", "ps", "--filter", "label=pi-gateway.sandbox=1", "--format", "{{.Names}}\t{{.Image}}\t{{.Label \"pi-gateway.user-key\"}}").trim();
console.log("  sandbox containers:\n" + containers.split("\n").map((l) => "    " + l).join("\n"));
check("C  the sandbox is the OWNER's (pi-sbx-u-sha256(ownerId)[:24]) and the only one", containers.split("\n").length === 1 && containers.startsWith(`${sandboxName}\t`), `expected ${sandboxName}`);
const inspect = dind("docker", "inspect", "-f", "{{.Config.Image}} network={{.HostConfig.NetworkMode}} user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}}", sandboxName).trim();
check("A  the sandbox runs noah-almighty/pi-sandbox:latest with network none", inspect.startsWith("noah-almighty/pi-sandbox:latest network=none"), inspect);
const execSha = dind("docker", "exec", sandboxName, "sh", "-c", "cd /workspace/uploads && sha256sum -- *").trim();
check("C  docker exec in the owner's sandbox container: same three hashes", NAMES.every((name) => execSha.includes(`${SENT[name]}  ${name}`)), execSha.replace(/\n/g, " | "));
const execImport = dindTry("docker", "exec", sandboxName, "python3", "-c", "import pypdf, docx, pptx, openpyxl, pandas; print('ok')");
check("B2 docker exec in the sandbox container: the import one-liner → ok", execImport.ok && execImport.out.trim() === "ok", execImport.out.trim().slice(0, 200));
const hostHashes = Object.fromEntries(NAMES.map((name) => [name, existsSync(`${ownerWorkspace}/uploads/${name}`) ? sha256(readFileSync(`${ownerWorkspace}/uploads/${name}`)) : null]));
check("C  the owner's workspace on the host (PI_GATEWAY_HOME/workspaces/u-…/uploads) holds the same bytes", NAMES.every((name) => hostHashes[name] === SENT[name]), `${ownerWorkspace}/uploads: ${readdirSync(`${ownerWorkspace}/uploads`).join(", ")}`);

// ---------------------------------------------------------------------------------------------------------
// 2. what Noah stored: the user message's attachments and the downloads.
// ---------------------------------------------------------------------------------------------------------
const messages1 = (await (await owner.get(`/api/messages?conversationId=${conv}`)).json()).messages ?? [];
const userRow = messages1.find((m) => m.role === "user");
const attachments = (userRow?.attachments ?? []).filter((a) => a.kind === "file");
console.log("  stored attachments:", JSON.stringify(attachments));
check("C  the stored user message lists the three attachments with uploaded: true", attachments.length === 3 && attachments.every((a, i) => a.uploaded === true && a.name === NAMES[i] && a.size === FILES[i].buffer.length), `content ${JSON.stringify(userRow?.content)}`);
for (const [i, att] of attachments.entries()) {
  const res = await owner.get(`/api/conversations/${conv}/files/${att.id}?name=${encodeURIComponent(att.name)}`);
  const body = Buffer.from(await res.arrayBuffer());
  check(`C  download ${att.name} → 200, byte-identical`, res.status === 200 && sha256(body) === SENT[NAMES[i]], `${res.status} ${sha256(body)} type=${res.headers.get("content-type")} disposition=${res.headers.get("content-disposition")} nosniff=${res.headers.get("x-content-type-options")}`);
}
if (attachments[0]) {
  const res = await second.get(`/api/conversations/${conv}/files/${attachments[0].id}?name=report.pdf`);
  check("C  (extra) the SECOND user cannot download the owner's document", res.status !== 200, `status ${res.status}`);
}
const noahCopies = dindTry("docker", "exec", "noah-almighty-noah-almighty-1", "sh", "-c", `ls -l /app/data/chat-files/${conv}/`);
console.log("  Noah's copies:", noahCopies.out.trim().replace(/\n/g, " | "));

// ---------------------------------------------------------------------------------------------------------
// 3. negatives
// ---------------------------------------------------------------------------------------------------------
const exeConv = randomUUID();
const before = (await fake.requests()).length;
const exe = await turn(owner, { avatarId: state.owner.id, conversationId: exeConv, message: "이거 실행해 줘", files: [{ name: "setup.exe", data: dataUrl(Buffer.from("MZ\x90\x00 not a document")) }] });
check("C  a .exe → 400 with the Korean message", exe.status === 400 && String(exe.json?.error ?? "").startsWith("지원하지 않는 파일 형식입니다."), `${exe.status} ${JSON.stringify(exe.json)}`);
const exeMessages = (await (await owner.get(`/api/messages?conversationId=${exeConv}`)).json()).messages ?? [];
check("C  …and nothing was stored or run for it", exeMessages.length === 0 && (await fake.requests()).length === before && !existsSync(`${ownerWorkspace}/uploads/setup.exe`), `messages ${exeMessages.length}`);
const disguised = await turn(owner, { avatarId: state.owner.id, conversationId: exeConv, message: "x", files: [{ name: "fake.pdf", data: dataUrl(Buffer.from("MZ\x90\x00 not a pdf")) }] });
check("C  (extra) an .exe renamed .pdf → 400 BAD_FORMAT message", disguised.status === 400 && String(disguised.json?.error ?? "").includes("확장자와 맞지 않거나"), `${disguised.status} ${JSON.stringify(disguised.json)}`);

// A second approved user on the FIRST user's avatar.
const MATE_KEY = `mate-${Date.now().toString(36)}`;
const mateConv = randomUUID();
const mateDocConv = randomUUID();
const mateWorkspace = `${W}/home/workspaces/${userKey(state.second.id)}`;
await fake.enqueue(MATE_KEY, [{ text: "동료 대화 응답입니다." }]);
const control = await turn(second, { avatarId: state.owner.id, conversationId: mateConv, message: `안녕하세요 [[fake:${MATE_KEY}]]` });
check("C  control: the second user CAN chat with the first user's avatar without files (200, done)", control.status === 200 && control.of("done").length === 1, `status ${control.status} ${JSON.stringify(control.json ?? control.of("error"))}`);
const mateBefore = (await fake.requests()).length;
const refused = await turn(second, { avatarId: state.owner.id, conversationId: mateDocConv, message: `이 문서 봐 줘 [[fake:${MATE_KEY}]]`, files: [{ name: "colleague-doc.pdf", data: dataUrl(FILES[0].buffer) }] });
check("C  the second user sending files to the first user's avatar → 400 NOT_ALLOWED_HERE text", refused.status === 400 && refused.json?.error === "문서는 내 아바타와의 대화에서만 첨부할 수 있습니다.", `${refused.status} ${JSON.stringify(refused.json)}`);
const mateMessages = (await (await second.get(`/api/messages?conversationId=${mateDocConv}`)).json()).messages ?? [];
const strays = dindTry("docker", "exec", "noah-almighty-noah-almighty-1", "sh", "-c", `ls -d /app/data/chat-files/${mateDocConv} 2>&1; find /app/data /srv/pi-workspaces -name 'colleague-doc*' 2>/dev/null | head`);
const hostStrays = [ownerWorkspace, mateWorkspace].filter((dir) => existsSync(`${dir}/uploads/colleague-doc.pdf`));
check("C  …and nothing was written (no message, no Noah copy, no sandbox file, no model call)", mateMessages.length === 0 && (await fake.requests()).length === mateBefore && hostStrays.length === 0 && !strays.out.includes("colleague-doc") && strays.out.includes("No such file"), `messages ${mateMessages.length}; ${strays.out.trim().replace(/\n/g, " | ")}; second user's uploads dir exists: ${existsSync(`${mateWorkspace}/uploads`)}`);

// ---------------------------------------------------------------------------------------------------------
// 4. regenerate re-sends the documents. One sandbox file is deleted first, so a re-send is visible on disk too.
// ---------------------------------------------------------------------------------------------------------
const mtimeBefore = Object.fromEntries(NAMES.map((name) => [name, statSync(`${ownerWorkspace}/uploads/${name}`).mtimeMs]));
rmSync(`${ownerWorkspace}/uploads/notes.md`);
const countBefore = (await fake.requests(KEY)).length;
await new Promise((r) => setTimeout(r, 1100));
await fake.enqueue(KEY, [{ text: "다시 읽었습니다." }]);
const regen = await turn(owner, { avatarId: state.owner.id, conversationId: conv, message: "", regenerate: true });
const regenDone = regen.of("done")[0];
check("C  regenerate of the document turn completes", regen.status === 200 && regen.of("done").length === 1 && String(regenDone?.message?.content ?? "").includes("다시 읽었습니다."), `status ${regen.status} ${JSON.stringify(regen.json ?? regenDone?.message?.content)}`);
const reqs2 = await fake.requests(KEY);
writeFileSync(`${W}/evidence/C-fake-llm-requests-regenerate.json`, JSON.stringify(reqs2.slice(countBefore), null, 1));
const regenReq = reqs2[countBefore]?.body ?? {};
const regenUsers = userTexts(regenReq);
const regenLast = regenUsers.at(-1) ?? "";
check("C  the model's request for the regenerate carries the three markers again", reqs2.length === countBefore + 1 && markers.every((m) => regenLast.includes(m)), `${reqs2.length - countBefore} new request(s); user messages in it: ${regenUsers.length}; markers in the last one: ${markers.filter((m) => regenLast.includes(m)).length}`);
check("C  …and Noah's preamble line again", regenLast.includes("**Attached documents (this turn)**"));
const after = Object.fromEntries(NAMES.map((name) => [name, existsSync(`${ownerWorkspace}/uploads/${name}`) ? { sha: sha256(readFileSync(`${ownerWorkspace}/uploads/${name}`)), mtimeMs: statSync(`${ownerWorkspace}/uploads/${name}`).mtimeMs } : null]));
check("C  pi wrote the files again: the deleted notes.md is back, all three identical, mtimes newer", NAMES.every((name) => after[name]?.sha === SENT[name] && after[name].mtimeMs > mtimeBefore[name]), NAMES.map((name) => `${name} +${Math.round((after[name]?.mtimeMs ?? 0) - mtimeBefore[name])}ms`).join(", "));
const messages2 = (await (await owner.get(`/api/messages?conversationId=${conv}`)).json()).messages ?? [];
const userRows2 = messages2.filter((m) => m.role === "user");
check("C  after the regenerate the conversation still has ONE user message with the three uploaded attachments", userRows2.length === 1 && (userRows2[0].attachments ?? []).filter((a) => a.kind === "file" && a.uploaded).length === 3 && messages2.filter((m) => m.role === "assistant").length === 1, `${messages2.map((m) => m.role).join(",")}`);

writeFileSync(`${W}/evidence/C-summary.json`, JSON.stringify({ conv, KEY, SENT, sandboxHashes, hostHashes, attachments, toolNames, preamble, sandbox: inspect }, null, 1));
finish();
