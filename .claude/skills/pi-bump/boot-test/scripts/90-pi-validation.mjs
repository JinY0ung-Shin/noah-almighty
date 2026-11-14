#!/usr/bin/env node
// V — pi 1.5.2's tool-argument validation THROUGH Noah's stack (pi-gateway d2d6704, 2026-11-14): the model's
// `mcp_call` arguments are validated by the gateway against the schema Noah's /mcp LISTS, before the call
// reaches Noah. One owner conversation, every call scripted by the fake LLM; what each tool answered is read
// back from the model's next request. `rawArguments` (fake-llm.mjs) sends argument text that is not whole JSON.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { W, check, client, fake, finish, loadState, textOf, turn } from "./e2e-common.mjs";

const state = loadState();
const owner = client(state.owner.cookie);
const RUN = Date.now().toString(36);
const conv = randomUUID();
const key = `valid-${RUN}`; // ONE key for the conversation (the fake LLM routes by the first marker)

async function scripted(calls, label) {
  await fake.enqueue(key, [...calls.map((call) => ({ toolCalls: [call] })), { text: `끝 (${label})` }]);
  const t = await turn(owner, { avatarId: state.owner.id, conversationId: conv, message: `검증 ${label} [[fake:${key}]]` });
  const reqs = await fake.requests(key);
  const tools = (reqs.at(-1)?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => textOf(m.content)).slice(-calls.length);
  const done = t.of("done")[0];
  const ok = t.status === 200 && t.of("done").length === 1 && t.of("error").length === 0 && String(done?.message?.content ?? "").includes(`끝 (${label})`);
  if (!ok) console.log(`  [${label}] status ${t.status} ${JSON.stringify(t.json ?? t.of("error")).slice(0, 400)}`);
  return { ok, tools };
}
const mcp = (name, args) => ({ name: "mcp_call", arguments: { name, arguments: args } });
const head = (text, n = 300) => JSON.stringify(String(text ?? "").slice(0, n));
const ALL = [];
const show = (label, text) => {
  ALL.push(`=== ${label}\n${text ?? "(no tool result)"}`);
  console.log(`  ${label}: ${head(text)}`);
};

// ---------------------------------------------------------------------------------------------------------
// 1. arguments that are not the listed type but can be made so
// ---------------------------------------------------------------------------------------------------------
const TITLE = `검증 단일값 ${RUN}`;
const MARK = `PARTIALRAN${RUN}`;
const t1 = await scripted(
  [
    mcp("mcp__system__list_recent_conversations", { sinceHours: "24", limit: "3" }),
    mcp("mcp__todo__add_todos", { items: { title: TITLE } }),
    mcp("mcp__todo__list_todos", { query: RUN }),
  ],
  "coerce",
);
show("numeric strings (sinceHours \"24\", limit \"3\")", t1.tools[0]);
show("one object where an array is listed (items: {title})", t1.tools[1]);
show("list_todos afterwards", t1.tools[2]);
check("V  the turn with the three calls completes", t1.ok);
check(
  "V  numbers sent as strings: mcp__system__list_recent_conversations answers its list, not a validation error",
  t1.ok && (t1.tools[0] ?? "").length > 0 && !/validation/i.test(t1.tools[0] ?? "") && !/Invalid arguments/i.test(t1.tools[0] ?? ""),
  head(t1.tools[0], 160),
);
check(
  "V  ONE object where the schema lists an array: mcp__todo__add_todos adds it",
  t1.ok && (t1.tools[1] ?? "").includes("Added 1 to-do(s)") && (t1.tools[1] ?? "").includes(TITLE),
  head(t1.tools[1], 200),
);
check("V  …and the item is really in the owner's list (list_todos by the run's mark)", (t1.tools[2] ?? "").includes(TITLE), head(t1.tools[2], 200));

// ---------------------------------------------------------------------------------------------------------
// 2. arguments that cannot be made valid: the wording the model reads
// ---------------------------------------------------------------------------------------------------------
const t2 = await scripted(
  [
    mcp("mcp__todo__update_todo", { status: "done" }),
    mcp("mcp__system__list_recent_conversations", { sinceHours: "many" }),
    mcp("mcp__todo__list_todos", { status: "everything" }),
    { name: "bash", arguments: {} },
  ],
  "refuse",
);
const [missing, wrongType, wrongEnum, bashMissing] = t2.tools;
show("required argument missing (update_todo without id)", missing);
show("a word where a number is listed (sinceHours \"many\")", wrongType);
show("a value outside a listed enum (list_todos status \"everything\")", wrongEnum);
show("a built-in tool without its required argument (bash {})", bashMissing);
check("V  the turn with the four refused calls completes (a refused call is a tool result, not a failed turn)", t2.ok);
check("V  a missing required argument → a validation failure naming the argument, with the tool's parameters", /Validation failed for tool/.test(missing ?? "") && /id/.test(missing ?? "") && (missing ?? "").includes("Parameters of mcp__todo__update_todo:"), head(missing, 220));
check("V  a word where a number is listed → a validation failure naming the argument", /Validation failed for tool/.test(wrongType ?? "") && /sinceHours/.test(wrongType ?? ""), head(wrongType, 220));
check("V  a built-in tool (bash) without its command → a validation failure naming it", /Validation failed for tool/.test(bashMissing ?? "") && /command/.test(bashMissing ?? ""), head(bashMissing, 220));
console.log(`  (recorded, not judged) enum outside the list: answered by ${/Validation failed for tool/.test(wrongEnum ?? "") ? "pi's validation" : "Noah's handler"}`);

// ---------------------------------------------------------------------------------------------------------
// 3. tool-call JSON that is cut off: nothing runs on the fields that did arrive
// ---------------------------------------------------------------------------------------------------------
const t3 = await scripted(
  [
    { name: "bash", rawArguments: `{"command":"echo ${MARK}","timeout":` },
    { name: "mcp_call", rawArguments: `{"name":"mcp__todo__add_todos","arguments":{"items":[{"title":"잘린 ${RUN}"}],` },
    mcp("mcp__todo__list_todos", { query: `잘린 ${RUN}` }),
  ],
  "cut",
);
show("bash with cut-off JSON", t3.tools[0]);
show("mcp_call with cut-off JSON", t3.tools[1]);
show("list_todos afterwards", t3.tools[2]);
check("V  the turn with the cut-off calls completes", t3.ok);
check("V  bash whose JSON is cut off after `command`: the command does NOT run (no echo output in the result)", t3.ok && (t3.tools[0] ?? "").length > 0 && !(t3.tools[0] ?? "").split("\n").some((l) => l.trim() === MARK), head(t3.tools[0], 220));
check("V  mcp_call whose JSON is cut off after the first item: nothing is added", t3.ok && (t3.tools[1] ?? "").length > 0 && !(t3.tools[1] ?? "").includes("Added 1 to-do(s)") && !(t3.tools[2] ?? "").includes(`잘린 ${RUN}`), `${head(t3.tools[1], 200)} / list: ${head(t3.tools[2], 120)}`);

// ---------------------------------------------------------------------------------------------------------
// 4. what pi's validation lets through to Noah
// ---------------------------------------------------------------------------------------------------------
const TAGGED = `검증 태그 ${RUN}`;
const t4 = await scripted(
  [
    mcp("mcp__todo__list_todos", { state: "open" }),
    mcp("mcp__todo__add_todos", { items: [{ title: TAGGED, tags: '["알파","베타"]' }] }),
    mcp("mcp__todo__list_todos", { query: TAGGED }),
  ],
  "through",
);
show("an argument name the tool does not list (list_todos {state})", t4.tools[0]);
show("an array sent as a JSON STRING (tags: '[\"알파\",\"베타\"]')", t4.tools[1]);
show("list_todos afterwards", t4.tools[2]);
check("V  the turn with the passed-through calls completes", t4.ok);
check(
  "V  an unknown argument name passes pi (Noah's listed schemas are open) and is refused by NOAH's own gate with the valid names",
  !/Validation failed for tool/.test(t4.tools[0] ?? "") && (t4.tools[0] ?? "").includes("Unknown argument name for mcp__todo__list_todos") && (t4.tools[0] ?? "").includes("valid:"),
  head(t4.tools[0], 220),
);
check(
  "V  a list sent as a JSON STRING (tags: '[\"알파\",\"베타\"]') is stored as TWO tags (Noah 313f80b unwrapStringList)",
  (t4.tools[1] ?? "").includes("Added 1 to-do(s)") && (t4.tools[2] ?? "").includes("#알파 #베타") && !(t4.tools[2] ?? "").includes('#["알파"'),
  head((t4.tools[2] ?? "").split("\n").at(-1), 200),
);
const addedId = /- \[ \] ([0-9a-f-]{36}) · 검증 태그/.exec(t4.tools[1] ?? "")?.[1];
const t4b = await scripted(
  [
    mcp("mcp__todo__update_todo", { id: addedId ?? "missing", tags: '["감마","델타"]' }),
    mcp("mcp__todo__update_todo", { id: addedId ?? "missing", tags: "[긴급]" }),
    mcp("mcp__todo__list_todos", { query: TAGGED }),
  ],
  "update",
);
show("update_todo with tags as a JSON string", t4b.tools[0]);
show("update_todo with ONE tag that only looks like a list ('[긴급]')", t4b.tools[1]);
show("list_todos afterwards", t4b.tools[2]);
check("V  …on update too: tags '[\"감마\",\"델타\"]' replaces the tags with TWO", t4b.ok && Boolean(addedId) && (t4b.tools[0] ?? "").includes("#감마 #델타"), head((t4b.tools[0] ?? "").split("\n").find((l) => l.includes("검증 태그")) ?? t4b.tools[0], 200));
check("V  …and one tag that only looks like a list ('[긴급]', wrapped by pi) stays ONE tag", t4b.ok && (t4b.tools[2] ?? "").includes("#[긴급]") && !(t4b.tools[2] ?? "").includes("#감마"), head((t4b.tools[2] ?? "").split("\n").at(-1), 200));

// ---------------------------------------------------------------------------------------------------------
// 5. the canvas contentType has no listed enum (Noah 313f80b): the HANDLER answers a retired or unknown type
// ---------------------------------------------------------------------------------------------------------
const WIDGET = '{@state n = 1}\n<slider label="n" value={n} onChange={setN} min={1} max={9} />';
const t5 = await scripted(
  [
    mcp("mcp__canvas__show", { title: "배수", content: WIDGET, contentType: "widget" }),
    mcp("mcp__canvas__show", { title: "차트", content: '{"mark":"bar"}', contentType: "vega" }),
    mcp("mcp__canvas__show", { title: "문서", content: "x", contentType: "pdf" }),
    mcp("mcp__canvas__show", { title: "메모", content: "# 검증\n\n본문", contentType: "markdown" }),
    { name: "mcp_search", arguments: { query: "canvas show" } },
  ],
  "canvas",
);
const [cWidget, cVega, cPdf, cMarkdown, cSearch] = t5.tools;
show("canvas show, contentType 'widget'", cWidget);
show("canvas show, contentType 'vega'", cVega);
show("canvas show, contentType 'pdf'", cPdf);
show("canvas show, contentType 'markdown' (control)", cMarkdown);
const listed = /"contentType":\{[^}]*\}/.exec(cSearch ?? "")?.[0] ?? "";
console.log(`  the contentType property as mcp_search shows it: ${head(listed, 400)}`);
check("V  the turn with the canvas calls completes", t5.ok);
check("V  contentType 'widget' through pi: the model reads NOAH's redirect, not pi's \"expected one of\"", (cWidget ?? "").startsWith("contentType 'widget' is retired:") && (cWidget ?? "").endsWith("Nothing was shown.") && !/Validation failed|expected one of/.test(cWidget ?? ""), head(cWidget, 160));
check("V  contentType 'vega' through pi: Noah's redirect", (cVega ?? "").startsWith("contentType 'vega' is retired:") && !/Validation failed|expected one of/.test(cVega ?? ""), head(cVega, 160));
check("V  contentType 'pdf' through pi: Noah's \"Unknown contentType 'pdf'…\" with the valid list", (cPdf ?? "") === "Unknown contentType 'pdf'. Use one of: 'markdown', 'mermaid', 'svg', 'html'. Nothing was shown.", head(cPdf, 200));
check("V  (control) contentType 'markdown' is shown: neither a refusal nor a validation failure", (cMarkdown ?? "").length > 0 && !/Validation failed|Unknown contentType|is retired|Unknown tool|not available/i.test(cMarkdown ?? ""), head(cMarkdown, 200));
check("V  the schema the model is shown has no enum for contentType (the values are in its description)", listed.length > 0 && !listed.includes('"enum"') && listed.includes("'markdown'"), head(listed, 200));

writeFileSync(`${W}/evidence/V-tool-results.txt`, ALL.join("\n\n"));
finish();
