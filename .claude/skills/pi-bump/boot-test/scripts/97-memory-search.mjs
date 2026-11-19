#!/usr/bin/env node
// S — the memory service's SEARCH through Noah's own client (pi-gateway 1d4a1fe, 2026-11-19). pi moved the
// note search from "is the word in the note" to BM25 with Korean cut into two-character pieces; its commit ran
// typecheck and vitest only. This runs Noah's BUILT client (`dist/server/memory/memoryClient.js`, the code a moved
// owner's `mcp__brain__search` uses) inside Noah's container, with Noah's env and key file, against the stack's
// real service, for a throwaway owner:
//   - what a search now finds and does not find (a particle on a Korean word, a whole English word, case);
//   - that the answer still passes the client's shape check (the score is no longer a whole number);
//   - what Noah's client gets for a query with no word in it (a refusal, where an empty query used to be the only one).
// Nobody is moved in this stack (no knowledge repository): the tool text a model reads for a moved owner is NOT
// produced here — it rests on Noah's tests.
import { check, dindTry, finish } from "./e2e-common.mjs";

const NOAH_C = "noah-almighty-noah-almighty-1";
const OWNER = `searchcheck-${Date.now().toString(36)}`;
const note = (label, text) => console.log(`  ${label}: ${String(text).split("\n").join("\n    ")}`);

const script = `
const fs = require("node:fs");
(async () => {
  const { createHttpMemoryClient, MemoryRefusedError } = await import("/app/dist/server/memory/memoryClient.js");
  const client = createHttpMemoryClient({ url: process.env.PI_MEMORY_URL, apiKey: fs.readFileSync(process.env.PI_MEMORY_API_KEY_FILE, "utf8").trim() });
  const owner = process.argv[1];
  const out = (label, value) => console.log(JSON.stringify([label, value]));
  const notes = {
    "wiki/개념/결함-점검.md": "---\\ntitle: 점검 절차\\ntags: [품질]\\n---\\n배포 전에 결함이 있는지 확인한다.",
    "wiki/개념/deployment.md": "---\\ntitle: Deployment checklist\\ntags: [ops]\\n---\\nThe deployment runs on Thursday. We keep the code on GitHub.",
    "wiki/개념/금요일.md": "---\\ntitle: 금요일 규칙\\ntags: [ops]\\n---\\n금요일에는 릴리스를 하지 않는다.",
    "wiki/개념/릴리스-제목.md": "---\\ntitle: 릴리스\\ntags: [절차]\\n---\\n순서를 적는다.",
    "wiki/개념/릴리스-태그.md": "---\\ntitle: 꼬리표\\ntags: [릴리스]\\n---\\n순서를 적는다.",
  };
  for (const [path, content] of Object.entries(notes)) await client.put(owner, path, content);
  const search = async (label, query) => {
    try {
      const found = await client.search(owner, query, 20, "wiki");
      out(label, { hits: found.hits.map((h) => ({ path: h.path, score: h.score, snippet: h.snippet.slice(0, 60) })), unscanned: found.unscanned });
    } catch (error) {
      out(label, { thrown: error?.name, refused: error instanceof MemoryRefusedError, code: error?.code, status: error?.status, message: String(error?.message).slice(0, 200) });
    }
  };
  await search("particle", "결함을");
  await search("whole-word-miss", "deploy");
  await search("whole-word-hit", "deployment");
  await search("case", "github");
  await search("fields", "릴리스");
  await search("no-match", "없는낱말zzz");
  await search("symbols-only", "?!");
  await search("blank", "   ");
  await client.deleteWiki(owner);
  out("left", (await client.list(owner)).length);
})().catch((e) => { console.log(JSON.stringify(["CRASH", String(e && e.stack || e).slice(0, 600)])); process.exit(1); });
`;
const ran = dindTry("docker", "exec", NOAH_C, "node", "-e", script, OWNER);
note("Noah's client against the stack's memory service", ran.out.trim());
const got = Object.fromEntries(ran.out.trim().split("\n").filter((l) => l.startsWith("[")).map((l) => JSON.parse(l)));
const paths = (label) => (got[label]?.hits ?? []).map((h) => h.path);
const hits = (label) => got[label]?.hits ?? [];

check("S  the script ran to its end and left no note behind", ran.ok && got.left === 0, ran.ok ? `left=${got.left}` : ran.out.slice(-400));
check("S  a Korean word with a different particle finds the note (`결함을` → `결함이 있는지`)", paths("particle").join() === "wiki/개념/결함-점검.md", paths("particle").join() || JSON.stringify(got.particle));
check("S  an English word matches only as a whole word: `deploy` does not find `deployment`", Array.isArray(got["whole-word-miss"]?.hits) && paths("whole-word-miss").length === 0, paths("whole-word-miss").join());
check("S  …and `deployment` does", paths("whole-word-hit").join() === "wiki/개념/deployment.md", paths("whole-word-hit").join());
check("S  case does not matter: `github` finds `GitHub`", paths("case").join() === "wiki/개념/deployment.md", paths("case").join());
// 릴리스: in a title, in a tag, in a body — the order the weights 5/3/1 give.
check("S  title before tag before body", paths("fields").join() === ["wiki/개념/릴리스-제목.md", "wiki/개념/릴리스-태그.md", "wiki/개념/금요일.md"].join(), paths("fields").join());
const scores = hits("fields").map((h) => h.score);
check("S  every hit passed Noah's shape check with a positive number as its score, in descending order", scores.length === 3 && scores.every((s) => typeof s === "number" && Number.isFinite(s) && s > 0) && scores[0] > scores[1] && scores[1] > scores[2], scores.join(", "));
console.log(`  (recorded, not judged) scores are no longer whole numbers: ${scores.map((s) => (Number.isInteger(s) ? "integer" : "decimal")).join(", ")}`);
check("S  a query no note matches answers no hits, not an error", Array.isArray(got["no-match"]?.hits) && got["no-match"].hits.length === 0 && got["no-match"].unscanned === 0, JSON.stringify(got["no-match"]));
const symbols = got["symbols-only"];
check("S  a query with no word in it (`?!`) is REFUSED: Noah's client throws MemoryRefusedError 400 invalid_query", symbols?.refused === true && symbols.status === 400 && symbols.code === "invalid_query", JSON.stringify(symbols));
note("what that refusal carries (Noah's tool puts it after \"The memory service refused this:\")", symbols?.message);
const blank = got.blank;
check("S  a blank query is refused the same way (Noah never sends one: personalVault.search answers it itself)", blank?.refused === true && blank.code === "invalid_query", JSON.stringify(blank));

finish();
