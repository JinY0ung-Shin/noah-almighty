#!/usr/bin/env node
// pi 33ffa1d: the context figure Noah's usage badge shows (AgentUsage.inputTokens = pi's
// usage.input_tokens_details.context_tokens).
//   1. an ordinary turn: the LAST call's input + output (pi's own auto-compaction basis), not its input alone
//   2. a turn that ends in pi's AUTOMATIC compaction: the pre-compaction usage with its conversation share
//      scaled by how much the conversation's chars/4 estimate shrank (the system prompt's share stays) — not
//      pi's bare estimate, which also counts the declarations of every registered tool (109 here, 12 on the wire)
//   3. /compact (manual): the same figure in the compact frame and in the bubble's usage
// The expected post-compaction value is recomputed here from what pi actually sent to the (fake) LLM.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { W, check, client, fake, finish, loadState, textOf, turn } from "./e2e-common.mjs";

const state = loadState();
const owner = client(state.owner.cookie);
const WINDOW = 131072; // fake-model's contextWindow (04-fake-llm.sh)
const stamp = Date.now().toString(36);
const big = (word) => `${word} lorem ipsum dolor sit amet. `.repeat(4000); // ~120-140K chars ≈ 30K+ estimated tokens

/** pi's estimateTokens over a chat-completions message list: ceil(chars / 4) per message. */
const est = (messages) => messages.reduce((sum, m) => sum + Math.ceil(textOf(m.content).length / 4), 0);
const systemOf = (body) => est(body.messages.filter((m) => m.role === "system"));
const conversationOf = (messages) => est(messages.filter((m) => m.role !== "system"));
/** pi-gateway's contextTokensAfterCompaction. */
const expectedAfter = (usageBefore, system, before, after) => Math.round(system + ((usageBefore - system) * after) / before);
/** A summary request carries no tools (pi asks twice when the cut splits a turn: the history, then the turn's head). */
const isSummary = (r) => (r.body.tools ?? []).length === 0;
const lastUser = (body) => textOf([...body.messages].reverse().find((m) => m.role === "user")?.content ?? "");
/** The model request of the turn whose user message carries `tag` (a summary request never ends on it). */
const requestOf = (requests, tag) => requests.find((r) => !isSummary(r) && lastUser(r.body).includes(tag) && r.body.messages.at(-1)?.role === "user")?.body;
const usageOf = (t) => t.of("done")[0]?.response?.usage;
const evidence = {};

// ---------------------------------------------------------------- 1 + 2: ordinary turns, then auto compaction
{
  const key = `ctxauto-${stamp}`;
  const mark = `[[fake:${key}]]`;
  const conversationId = randomUUID();
  const say = (tag) => turn(owner, { avatarId: state.owner.id, conversationId, message: `${tag} 질문 ${mark}` });
  const a1 = big("first");
  const a2 = big("second");
  const a3 = "셋째 답.";
  await fake.enqueue(key, [
    { text: a1, usage: { prompt_tokens: 10000, completion_tokens: 30000 } },
    { text: a2, usage: { prompt_tokens: 45000, completion_tokens: 30000 } },
    // 120500 > 131072 - 16384: pi compacts after this answer, inside the same turn.
    { text: a3, usage: { prompt_tokens: 120000, completion_tokens: 500 } },
    { text: `SUMMARY-AUTO ${mark} the earlier conversation, summarized.` },
    { text: `SUMMARY-AUTO-HEAD ${mark} the head of the split turn, summarized.` },
    { text: "넷째 답.", usage: { prompt_tokens: 50000, completion_tokens: 100 } },
  ]);

  const t1 = await say("TAG-ONE");
  const u1 = usageOf(t1);
  check("1. ordinary turn: context = the call's input + output (10000 + 30000)", u1?.inputTokens === 40000, JSON.stringify(u1));
  check("1. the window is the session model's", u1?.contextWindow === WINDOW, String(u1?.contextWindow));
  check("1. output is the turn's own output", u1?.outputTokens === 30000, String(u1?.outputTokens));
  check("1. no compaction yet", t1.of("compact").length === 0);

  const t2 = await say("TAG-TWO");
  check("1. second turn: 45000 + 30000, still under the threshold", usageOf(t2)?.inputTokens === 75000 && t2.of("compact").length === 0, JSON.stringify(usageOf(t2)));

  const t3 = await say("TAG-THREE");
  const compact = t3.of("compact");
  const u3 = usageOf(t3);
  check("2. the third turn ends in pi's automatic compaction", compact.length === 1 && compact[0].ok === true && compact[0].trigger === "auto", JSON.stringify(compact));
  check("2. the turn itself completed", t3.of("done").length === 1 && t3.of("error").length === 0, JSON.stringify(t3.of("error")));

  const t4 = await say("TAG-FOUR");
  const u4 = usageOf(t4);
  const requests = await fake.requests(key);
  const req3 = requestOf(requests, "TAG-THREE");
  const req4 = requestOf(requests, "TAG-FOUR");
  const summaries = requests.filter(isSummary);
  check("2. pi asked the model for the summary (twice: the cut splits a turn)", summaries.length === 2, `${requests.length} requests, ${summaries.length} without tools`);
  check("2. the next turn continues from the summary", Boolean(req4) && JSON.stringify(req4.messages).includes("SUMMARY-AUTO") && !JSON.stringify(req4.messages).includes(a1.slice(0, 200)));
  if (req3 && req4) {
    const system = systemOf(req3);
    const before = conversationOf(req3.messages) + Math.ceil(a3.length / 4);
    const after = conversationOf(req4.messages.slice(0, -1));
    const expected = expectedAfter(120500, system, before, after);
    const got = u3?.inputTokens ?? 0;
    const wireTools = Math.ceil(JSON.stringify(req3.tools ?? []).length / 4);
    evidence.auto = { usageBefore: 120500, systemEstimate: system, conversationBefore: before, conversationAfter: after, expected, got, toolsOnTheWire: (req3.tools ?? []).length, wireToolsEstimate: wireTools, window: u3?.contextWindow };
    check("2. context after it = system + (usage before − system) × (conversation after / before), within 2%", Math.abs(got - expected) / expected < 0.02, JSON.stringify(evidence.auto));
    check("2. … smaller than before the compaction, window still reported", got < 120500 && u3?.contextWindow === WINDOW);
  } else {
    check("2. the turn-3 and turn-4 model requests were recorded", false, `${requests.length} requests`);
  }
  check("2. the turn after it reports the model's real usage again (50000 + 100)", u4?.inputTokens === 50100, JSON.stringify(u4));
}

// ---------------------------------------------------------------- 3: /compact
{
  const key = `ctxmanual-${stamp}`;
  const mark = `[[fake:${key}]]`;
  const conversationId = randomUUID();
  const say = (message) => turn(owner, { avatarId: state.owner.id, conversationId, message });
  const a1 = big("uno");
  const a2 = big("dos");
  await fake.enqueue(key, [
    { text: a1, usage: { prompt_tokens: 10000, completion_tokens: 30000 } },
    { text: a2, usage: { prompt_tokens: 60000, completion_tokens: 30000 } },
    { text: `SUMMARY-MANUAL ${mark} the earlier conversation, summarized.` },
    { text: `SUMMARY-MANUAL-HEAD ${mark} the head of the split turn, summarized.` },
    { text: "셋째 답.", usage: { prompt_tokens: 40000, completion_tokens: 100 } },
  ]);
  await say(`TAG-ONE 질문 ${mark}`);
  const t2 = await say(`TAG-TWO 질문 ${mark}`);
  check("3. before /compact: 60000 + 30000, no automatic compaction", usageOf(t2)?.inputTokens === 90000 && t2.of("compact").length === 0, JSON.stringify(usageOf(t2)));

  const c = await say("/compact");
  const frame = c.of("compact")[0];
  const uc = usageOf(c);
  check("3. /compact compacts (manual)", frame?.ok === true && frame?.trigger === "manual", JSON.stringify(c.of("compact")) + JSON.stringify(c.json ?? ""));
  check("3. before = the last answer's usage (90000)", frame?.preTokens === 90000, String(frame?.preTokens));
  check("3. the bubble's usage carries the same after-figure, output 0", uc?.inputTokens === frame?.postTokens && uc?.outputTokens === 0 && uc?.contextWindow === WINDOW, JSON.stringify(uc));

  const t3 = await say(`TAG-THREE 질문 ${mark}`);
  const requests = await fake.requests(key);
  const req2 = requestOf(requests, "TAG-TWO");
  const req3 = requestOf(requests, "TAG-THREE");
  if (req2 && req3) {
    const system = systemOf(req2);
    const before = conversationOf(req2.messages) + Math.ceil(a2.length / 4);
    const after = conversationOf(req3.messages.slice(0, -1));
    const expected = expectedAfter(90000, system, before, after);
    const got = frame?.postTokens ?? 0;
    evidence.manual = { usageBefore: 90000, systemEstimate: system, conversationBefore: before, conversationAfter: after, expected, got, bubble: c.of("done")[0]?.response?.text };
    check("3. after = system + (usage before − system) × (conversation after / before), within 2%", Math.abs(got - expected) / expected < 0.02, JSON.stringify(evidence.manual));
    check("3. the next turn continues from the summary", JSON.stringify(req3.messages).includes("SUMMARY-MANUAL") && !JSON.stringify(req3.messages).includes(a1.slice(0, 200)));
  } else {
    check("3. the turn-2 and turn-3 model requests were recorded", false, `${requests.length} requests`);
  }
  check("3. the turn after it reports real usage again (40000 + 100)", usageOf(t3)?.inputTokens === 40100, JSON.stringify(usageOf(t3)));
}

writeFileSync(`${W}/evidence/F-context-usage.json`, JSON.stringify(evidence, null, 2));
finish();
