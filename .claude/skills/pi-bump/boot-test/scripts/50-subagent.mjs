#!/usr/bin/env node
// E: a subagent through Noah. The scripted model answers the first request of an owner turn with an `Agent`
// tool call (general-purpose); the SUBAGENT's own model calls route to their own fake-LLM key through a marker
// in the prompt it is given (pi hands the subagent only that prompt).
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { W, check, client, fake, finish, loadState, textOf, turn } from "./e2e-common.mjs";

const state = loadState();
const owner = client(state.owner.cookie);
const stamp = Date.now().toString(36);
const KEY = `agent-${stamp}`;
const SUB = `sub-${stamp}`;
const conv = randomUUID();

await fake.enqueue(KEY, [
  { text: "하위 에이전트에게 맡기겠습니다.", toolCalls: [{ name: "Agent", arguments: { description: "Count upload files", prompt: `[[fake:${SUB}]] List /workspace/uploads and report how many files are there.`, subagent_type: "general-purpose" } }] },
  { text: "하위 에이전트가 보고를 마쳤습니다." },
]);
await fake.enqueue(SUB, [
  { text: "Listing.", toolCalls: [{ name: "bash", arguments: { command: "ls /workspace/uploads | wc -l; echo SUBAGENT-SHELL-OK" } }] },
  { text: "SUBAGENT-REPORT: three files in /workspace/uploads." },
]);

const t = await turn(owner, { avatarId: state.owner.id, conversationId: conv, message: `업로드 폴더 파일 수를 하위 에이전트로 세어 줘 [[fake:${KEY}]]` });
writeFileSync(`${W}/evidence/E-sse-frames.json`, JSON.stringify(t.frames, null, 1));
console.log("  SSE event sequence:", t.frames.map((f) => f.event).filter((e, i, a) => e !== "delta" || a[i - 1] !== "delta").join(" → "));
const starts = t.of("agent");
const ends = t.of("agent_end");
console.log("  agent frame:", JSON.stringify(starts[0]));
console.log("  agent_end frame:", JSON.stringify(ends[0]));
const tools = t.of("tool");
const toolEnds = t.of("tool_end");
console.log("  tool frames:", JSON.stringify(tools));
console.log("  tool_end frames:", JSON.stringify(toolEnds).slice(0, 900));
check("E  the turn completes (200, one done, no error)", t.status === 200 && t.of("done").length === 1 && t.of("error").length === 0, `status ${t.status} ${JSON.stringify(t.json ?? t.of("error"))}`);
check("E  the SSE stream carries an agent-card START (event `agent`, general-purpose)", starts.length === 1 && starts[0].subagentType === "general-purpose", JSON.stringify(starts[0]));
check("E  …and its END (event `agent_end`, ok:true, same agentId)", ends.length === 1 && ends[0].ok === true && ends[0].agentId === starts[0]?.agentId, JSON.stringify(ends[0]));
const done = t.of("done")[0];
check("E  the final answer is the parent's text after the subagent", String(done?.message?.content ?? "").includes("하위 에이전트가 보고를 마쳤습니다."), JSON.stringify(done?.message?.content));
const nested = tools.filter((x) => x.agentId === starts[0]?.agentId || x.parentAgentId === starts[0]?.agentId || x.scope?.agentId === starts[0]?.agentId || JSON.stringify(x).includes(starts[0]?.agentId ?? "\0"));
check("E  the subagent's own tool call (bash) is attributed to the agent in the stream", nested.length >= 1, JSON.stringify(nested[0]));

const parent = await fake.requests(KEY);
const sub = await fake.requests(SUB);
writeFileSync(`${W}/evidence/E-fake-llm-requests.json`, JSON.stringify({ parent, sub }, null, 1));
check("E  the fake LLM saw 2 parent calls and 2 subagent calls", parent.length === 2 && sub.length === 2, `parent ${parent.length}, sub ${sub.length}`);
const subTools = (sub[0]?.body?.tools ?? []).map((x) => x.function?.name);
check("E  the subagent session has no Agent/SendMessage/AskUserQuestion (depth 1)", sub.length > 0 && !subTools.includes("Agent") && !subTools.includes("SendMessage") && !subTools.includes("AskUserQuestion"), subTools.join(", "));
const subSystem = textOf((sub[0]?.body?.messages ?? []).find((m) => m.role === "system" || m.role === "developer")?.content);
console.log("  subagent system prompt starts:", JSON.stringify(subSystem.slice(0, 120)));
// The owner's uploads as the host sees them (earlier scripts add files, so the count is read, not assumed).
const uploads = readdirSync(`${W}/home/workspaces/u-${createHash("sha256").update(state.owner.id, "utf8").digest("hex").slice(0, 24)}/uploads`);
const subToolResult = textOf((sub[1]?.body?.messages ?? []).findLast((m) => m.role === "tool")?.content);
check("E  the subagent's shell ran in the OWNER's sandbox (sees the owner's uploads)", uploads.length >= 3 && Number(subToolResult.trim().split("\n")[0]) === uploads.length && subToolResult.includes("SUBAGENT-SHELL-OK"), `${JSON.stringify(subToolResult.slice(0, 80))} vs ${uploads.length} files on the host`);
const agentResult = textOf((parent[1]?.body?.messages ?? []).findLast((m) => m.role === "tool")?.content);
check("E  the parent model received the subagent's report + agent_id as the Agent tool result", agentResult.includes("SUBAGENT-REPORT") && /agent_id: [a-f0-9]{16}/.test(agentResult), JSON.stringify(agentResult));

const messages = (await (await owner.get(`/api/messages?conversationId=${conv}`)).json()).messages ?? [];
const assistant = messages.find((m) => m.role === "assistant");
const activity = await (await owner.get(`/api/messages/${assistant?.id}/activity`)).text();
console.log("  stored assistant message keys:", Object.keys(assistant ?? {}).join(", "));
console.log("  activity (first 700 chars):", activity.slice(0, 700));
finish();
