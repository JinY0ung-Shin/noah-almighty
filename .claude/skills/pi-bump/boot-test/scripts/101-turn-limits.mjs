#!/usr/bin/env node
// C — pi's turn limits THROUGH the stack (pi-gateway 52d765b + a9f4801, 2026-11-20): the defaults went 16 → 48 turns
// in all and 3 → 6 per user. pi's commits measured a gateway alone (fake sandboxd and broker) and ran the config tests;
// nothing looked at one user's turns sharing a REAL sandbox session start, or at what Noah's stack runs with.
//   1. the gateway container of the bundled stack runs with 48 / 6 (no .env line sets either — pi's defaults)
//   2. ONE owner starts seven chat turns at once; every model call is held HOLD ms by the fake LLM. Six reach the
//      model while the first is still held; the seventh reaches it only after a call has ended — and all seven
//      complete (a turn over the limit WAITS, it is not refused).
// Times are the fake LLM's own arrival stamps, so no two clocks are compared.
import { randomUUID } from "node:crypto";
import { check, client, dind, fake, finish, loadState, turn } from "./e2e-common.mjs";

const GATEWAY_C = "noah-almighty-gateway-1";
const PER_USER = 6;
const HOLD = 12_000;
const state = loadState();
const owner = client(state.owner.cookie);
const RUN = Date.now().toString(36);

// ---------------------------------------------------------------------------------------------- 1. what runs
const env = dind("docker", "exec", GATEWAY_C, "printenv", "MAX_CONCURRENT_TURNS", "MAX_CONCURRENT_TURNS_PER_USER", "TURN_QUEUE_TIMEOUT_SECONDS")
  .trim()
  .split("\n");
check("C  the stack's gateway runs with pi's new defaults: 48 turns in all, 6 per user, a 120 s wait", env.join("/") === `48/${PER_USER}/120`, `MAX_CONCURRENT_TURNS=${env[0]} MAX_CONCURRENT_TURNS_PER_USER=${env[1]} TURN_QUEUE_TIMEOUT_SECONDS=${env[2]}`);

// ---------------------------------------------------------------------------------------------- 2. seven at once
const N = PER_USER + 1;
const keys = Array.from({ length: N }, (_, i) => `limit-${RUN}-${i}`);
for (const [i, key] of keys.entries()) await fake.enqueue(key, [{ text: `끝 ${i}`, delayMs: HOLD }]);
const started = Date.now();
const turns = await Promise.all(
  keys.map((key, i) => turn(owner, { avatarId: state.owner.id, conversationId: randomUUID(), message: `동시 턴 ${i} [[fake:${key}]]` })),
);
const wall = Date.now() - started;

const done = turns.map((t, i) => t.status === 200 && t.of("done").length === 1 && t.of("error").length === 0 && String(t.of("done")[0]?.message?.content ?? "").includes(`끝 ${i}`));
for (const [i, t] of turns.entries()) if (!done[i]) console.log(`  [turn ${i}] status ${t.status} ${JSON.stringify(t.json ?? t.of("error")).slice(0, 400)}`);
check(`C  all ${N} simultaneous turns of one user complete with their own answer — none refused`, done.every(Boolean), `${done.filter(Boolean).length}/${N} in ${(wall / 1000).toFixed(1)} s (each model call held ${HOLD / 1000} s)`);

const requests = await Promise.all(keys.map((key) => fake.requests(key)));
console.log(`  (recorded, not judged) model calls per conversation: ${requests.map((r) => r.length).join(" ")}`);
const arrivals = requests.map((r) => (r[0] ? Date.parse(r[0].at) : NaN)).sort((a, b) => a - b);
const rel = arrivals.map((a) => ((a - arrivals[0]) / 1000).toFixed(1));
console.log(`  model-call arrivals, seconds after the first: ${rel.join(" ")}`);
check(`C  every turn made its model call`, arrivals.every(Number.isFinite), `${arrivals.filter(Number.isFinite).length}/${N}`);

// A call is in flight from its arrival for HOLD ms (the fake LLM waits before the first chunk).
const inFlightAt = (t) => arrivals.filter((a) => a <= t && t < a + HOLD).length;
const peak = Math.max(...arrivals.map(inFlightAt));
check(`C  ${PER_USER} of them are at the model at the same time`, arrivals[PER_USER - 1] - arrivals[0] < HOLD && inFlightAt(arrivals[PER_USER - 1]) === PER_USER, `the ${PER_USER}th arrived ${rel[PER_USER - 1]} s after the first, while all earlier calls were still held`);
check(`C  never more than ${PER_USER}: the 7th reaches the model only after a call has ended`, peak === PER_USER && arrivals[N - 1] >= arrivals[0] + HOLD, `peak ${peak} in flight; the 7th arrived ${rel[N - 1]} s after the first (hold ${HOLD / 1000} s)`);

finish();
