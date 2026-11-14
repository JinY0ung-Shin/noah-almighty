#!/usr/bin/env node
// C (extra, beyond the brief): REAL Office files, a duplicate name, names with spaces, the 5-document cap, a
// document on a LATER turn and its edit (rewind), and one document at the 8 MiB cap through pi's real body limit.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { W, check, client, fake, finish, loadState, sha256, textOf, turn } from "./e2e-common.mjs";

const state = loadState();
const owner = client(state.owner.cookie);
const dataUrl = (buffer) => `data:application/octet-stream;base64,${buffer.toString("base64")}`;
const userKey = (principal) => `u-${createHash("sha256").update(principal, "utf8").digest("hex").slice(0, 24)}`;
const workspace = `${W}/home/workspaces/${userKey(state.owner.id)}`;
const sandbox = `pi-sbx-${userKey(state.owner.id)}`;
const userTexts = (body) => (body?.messages ?? []).filter((m) => m.role === "user").map((m) => textOf(m.content));

// ---- real docx / xlsx / pptx, made with the sandbox image's own libraries ---------------------------------
const GEN = `
import os
os.makedirs('/workspace/gen-fixtures', exist_ok=True)
os.chdir('/workspace/gen-fixtures')
import docx, openpyxl, pptx
d = docx.Document(); d.add_heading('회의록 초안', 1); d.add_paragraph('DOCX-MARK-3F8 결정 사항: 배포는 금요일.'); d.save('a.docx')
wb = openpyxl.Workbook(); ws = wb.active; ws.title = '실적'; ws.append(['부서', '매출']); ws.append(['영업1팀', 1200]); ws.append(['XLSX-MARK-5T1', 980]); wb.save('b.xlsx')
p = pptx.Presentation(); s = p.slides.add_slide(p.slide_layouts[0]); s.shapes.title.text = '발표 PPTX-MARK-8W6'; p.save('c.pptx')
print('generated')
`;
const gen = execFileSync("docker", ["exec", "-i", "noahcompose-dind", "docker", "exec", "-i", sandbox, "python3", "-"], { input: GEN, encoding: "utf8" });
check("extra: real docx/xlsx/pptx generated with the sandbox image's python-docx / openpyxl / python-pptx", gen.trim() === "generated", gen.trim());
const docx = readFileSync(`${workspace}/gen-fixtures/a.docx`);
const xlsx = readFileSync(`${workspace}/gen-fixtures/b.xlsx`);
const pptx = readFileSync(`${workspace}/gen-fixtures/c.pptx`);
rmSync(`${workspace}/gen-fixtures`, { recursive: true });
const pdf = readFileSync(`${W}/fixtures/report.pdf`);
const pdf2 = Buffer.concat([pdf, Buffer.from("\n% second copy, different bytes\n")]);

const stamp = Date.now().toString(36);
const KEY = `xdocs-${stamp}`;
const conv = randomUUID();
// What is SENT (two entries share a name) and what must be STORED (unique within the message).
const sent = [
  { name: "회의록 초안 v2.docx", buffer: docx },
  { name: "실적 (3분기).xlsx", buffer: xlsx },
  { name: "발표.pptx", buffer: pptx },
  { name: "report.pdf", buffer: pdf },
  { name: "report.pdf", buffer: pdf2 },
];
const storedNames = ["회의록 초안 v2.docx", "실적 (3분기).xlsx", "발표.pptx", "report.pdf", "report (2).pdf"];
const SENT = Object.fromEntries(storedNames.map((name, i) => [name, sha256(sent[i].buffer)]));

// ---- turn 1: plain text; turn 2: five documents --------------------------------------------------------
await fake.enqueue(KEY, [{ text: "안녕하세요." }]);
const t1 = await turn(owner, { avatarId: state.owner.id, conversationId: conv, message: `먼저 인사부터 [[fake:${KEY}]]` });
check("extra: turn 1 (no documents) completes", t1.status === 200 && t1.of("done").length === 1);

const SHELL = [
  "cd /workspace/uploads",
  "echo ---SHA; sha256sum -- '회의록 초안 v2.docx' '실적 (3분기).xlsx' '발표.pptx' report.pdf 'report (2).pdf'",
  `echo ---DOCX; python3 -c "import docx; print(' / '.join(p.text for p in docx.Document('회의록 초안 v2.docx').paragraphs))"`,
  `echo ---XLSX; python3 -c "import openpyxl; print([[c.value for c in r] for r in openpyxl.load_workbook('실적 (3분기).xlsx').active.iter_rows()])"`,
  `echo ---PPTX; python3 -c "import pptx; print([sh.text_frame.text for s in pptx.Presentation('발표.pptx').slides for sh in s.shapes if sh.has_text_frame])"`,
  "echo ---END",
].join("; ");
await fake.enqueue(KEY, [{ text: "읽어 보겠습니다.", toolCalls: [{ name: "bash", arguments: { command: SHELL } }] }, { text: "다섯 개를 읽었습니다." }]);
const before2 = (await fake.requests(KEY)).length;
const t2 = await turn(owner, { avatarId: state.owner.id, conversationId: conv, message: "이 문서들을 비교해 줘", files: sent.map((f) => ({ name: f.name, data: dataUrl(f.buffer) })) });
check("extra: turn 2 with five documents (3 real Office files, a duplicate name) completes", t2.status === 200 && t2.of("done").length === 1 && t2.of("error").length === 0, `status ${t2.status} ${JSON.stringify(t2.json ?? t2.of("error"))}`);
const reqs = await fake.requests(KEY);
const last2 = userTexts(reqs[before2]?.body).at(-1) ?? "";
check("extra: five [Attached file: …] markers, the duplicate as 'report (2).pdf'", storedNames.every((name) => last2.includes(`[Attached file: /workspace/uploads/${name}]`)), last2.split("\n").filter((l) => l.startsWith("[Attached file:")).join(" "));
const toolResult = textOf((reqs[before2 + 1]?.body?.messages ?? []).findLast((m) => m.role === "tool")?.content);
writeFileSync(`${W}/evidence/C-extra-sandbox-tool-result.txt`, toolResult);
const section = (name) => (new RegExp(`---${name}\\n([\\s\\S]*?)(?=\\n---|$)`).exec(toolResult)?.[1] ?? "").trim();
const hashes = Object.fromEntries(section("SHA").split("\n").filter(Boolean).map((line) => [line.slice(66), line.slice(0, 64)]));
check("extra: all five byte-identical in the sandbox (the two same-named PDFs kept apart)", storedNames.every((name) => hashes[name] === SENT[name]) && hashes["report.pdf"] !== hashes["report (2).pdf"], JSON.stringify(hashes));
check("extra: python-docx / openpyxl / python-pptx read the uploaded files in the sandbox", section("DOCX").includes("DOCX-MARK-3F8") && section("XLSX").includes("XLSX-MARK-5T1") && section("PPTX").includes("PPTX-MARK-8W6"), `${section("DOCX")} | ${section("XLSX")} | ${section("PPTX")}`);

const rows2 = (await (await owner.get(`/api/messages?conversationId=${conv}`)).json()).messages ?? [];
const docRow = rows2.filter((m) => m.role === "user").at(-1);
const atts = (docRow?.attachments ?? []).filter((a) => a.kind === "file");
check("extra: stored names are the unique ones, all uploaded: true", atts.map((a) => a.name).join("|") === storedNames.join("|") && atts.every((a) => a.uploaded === true), atts.map((a) => `${a.name}:${a.mediaType.split("/").pop().slice(-12)}`).join(", "));
for (const [i, att] of atts.entries()) {
  const res = await owner.get(`/api/conversations/${conv}/files/${att.id}?name=${encodeURIComponent(att.name)}`);
  const body = Buffer.from(await res.arrayBuffer());
  check(`extra: download ${att.name} byte-identical`, res.status === 200 && sha256(body) === SENT[storedNames[i]], `${res.status}`);
}

// ---- edit (rewind) of the document message: re-sent, kept on the replacement row ---------------------
rmSync(`${workspace}/uploads/발표.pptx`);
await fake.enqueue(KEY, [{ text: "표 위주로 다시 봤습니다." }]);
const before3 = (await fake.requests(KEY)).length;
const t3 = await turn(owner, { avatarId: state.owner.id, conversationId: conv, message: "표 위주로 다시 비교해 줘", rewindFromMessageId: docRow.id });
check("extra: editing the document message completes", t3.status === 200 && t3.of("done").length === 1, `status ${t3.status} ${JSON.stringify(t3.json ?? t3.of("error"))}`);
const reqs3 = await fake.requests(KEY);
const users3 = userTexts(reqs3[before3]?.body);
const last3 = users3.at(-1) ?? "";
check("extra: the edit's request carries the five markers again, with the edited text and the EARLIER turn still in history", storedNames.every((name) => last3.includes(`[Attached file: /workspace/uploads/${name}]`)) && last3.includes("표 위주로 다시 비교해 줘") && users3.length === 2 && users3[0].includes("먼저 인사부터"), `user messages ${users3.length}`);
check("extra: pi rewrote the deleted upload on the edit", existsSync(`${workspace}/uploads/발표.pptx`) && sha256(readFileSync(`${workspace}/uploads/발표.pptx`)) === SENT["발표.pptx"]);
const rows3 = (await (await owner.get(`/api/messages?conversationId=${conv}`)).json()).messages ?? [];
const newRow = rows3.filter((m) => m.role === "user").at(-1);
check("extra: the replacement row keeps the five uploaded attachments; 2 user + 2 assistant rows remain", rows3.map((m) => m.role).join(",") === "user,assistant,user,assistant" && newRow.content === "표 위주로 다시 비교해 줘" && (newRow.attachments ?? []).filter((a) => a.kind === "file" && a.uploaded).length === 5, rows3.map((m) => m.role).join(","));
const again = await owner.get(`/api/conversations/${conv}/files/${(newRow.attachments ?? []).find((a) => a.name === "발표.pptx")?.id}?name=x.pptx`);
check("extra: the replacement row's document still downloads", again.status === 200 && sha256(Buffer.from(await again.arrayBuffer())) === SENT["발표.pptx"], `${again.status}`);

// ---- caps ---------------------------------------------------------------------------------------------
const six = await turn(owner, { avatarId: state.owner.id, conversationId: randomUUID(), message: "x", files: Array.from({ length: 6 }, (_, i) => ({ name: `n${i}.md`, data: dataUrl(Buffer.from(`# ${i}\n`)) })) });
check("extra: six documents → 400 TOO_MANY message", six.status === 400 && String(six.json?.error).includes("5개까지"), `${six.status} ${JSON.stringify(six.json)}`);

// One document of EXACTLY 8 MiB on the FIRST turn of a conversation (the frozen instructions ride the same
// request): pi's body cap is 16 MiB for the whole JSON, so this is the real-limit check of Noah's budget.
const big = Buffer.from(randomBytes(6 * 1024 * 1024).toString("base64")); // 8 MiB of ASCII text
const BIG_KEY = `big-${stamp}`;
await fake.enqueue(BIG_KEY, [{ text: "크기를 확인합니다.", toolCalls: [{ name: "bash", arguments: { command: "cd /workspace/uploads; sha256sum big-8mib.txt; stat -c %s big-8mib.txt" } }] }, { text: "큰 파일도 받았습니다." }]);
const bigConv = randomUUID();
const started = Date.now();
const tb = await turn(owner, { avatarId: state.owner.id, conversationId: bigConv, message: `이 큰 파일 받아 줘 [[fake:${BIG_KEY}]]`, files: [{ name: "big-8mib.txt", data: dataUrl(big) }] });
check(`extra: a single ${big.length}-byte (8 MiB) document on a first turn completes through pi's 16 MiB body cap`, big.length === 8 * 1024 * 1024 && tb.status === 200 && tb.of("done").length === 1 && tb.of("error").length === 0, `status ${tb.status} in ${Date.now() - started} ms ${JSON.stringify(tb.json ?? tb.of("error")).slice(0, 300)}`);
const bigReqs = await fake.requests(BIG_KEY);
const bigResult = textOf((bigReqs[1]?.body?.messages ?? []).findLast((m) => m.role === "tool")?.content);
check("extra: …and it is byte-identical in the sandbox", bigResult.includes(sha256(big)) && bigResult.includes(String(big.length)), bigResult.trim().replace(/\n/g, " | ").slice(0, 160));
console.log("  first-turn request to the model: system prompt chars =", textOf((bigReqs[0]?.body?.messages ?? []).find((m) => m.role === "system" || m.role === "developer")?.content).length);
const over = Buffer.concat([big, Buffer.from("x")]);
const tooLarge = await turn(owner, { avatarId: state.owner.id, conversationId: randomUUID(), message: "x", files: [{ name: "over.txt", data: dataUrl(over) }] });
check("extra: 8 MiB + 1 byte → 400 TOO_LARGE message", tooLarge.status === 400 && String(tooLarge.json?.error).includes("8MB까지"), `${tooLarge.status} ${JSON.stringify(tooLarge.json)}`);
finish();
