#!/usr/bin/env node
// Correction check for a claim in the first run's report: is `tiers: { falcon }` REQUIRED in PUT /admin/api/llm
// for Noah's default (no model picked) turn? Sets pi's LLM with defaultModel only, runs an owner turn, then
// restores the falcon tier. Through Noah's /admin proxy.
import { randomUUID } from "node:crypto";
import { FAKE, NOAH, check, client, fake, finish, loadState, turn } from "./e2e-common.mjs";
const state = loadState();
const admin = client(state.owner.cookie);
const PANEL = { origin: NOAH, referer: `${NOAH}/admin/`, "sec-fetch-site": "same-origin", "x-admin-request": "1" };
const settings = (tiers) => ({ defaultModel: "fake-model", tiers, servers: [{ id: "fake", api: "openai-completions", baseUrl: `${FAKE}/v1`, apiKey: "", models: [{ id: "fake-model", contextWindow: 131072, maxTokens: 4096, input: ["text", "image"] }] }] });
let res = await admin.put("/admin/api/llm", settings({}), PANEL);
let body = await res.json();
check("PUT /admin/api/llm with defaultModel only (no tiers) → 200", res.status === 200 && Object.keys(body.settings?.tiers ?? {}).length === 0, JSON.stringify(body.settings?.tiers));
const key = `notier-${Date.now().toString(36)}`;
await fake.enqueue(key, [{ text: "티어 없이 응답." }]);
const t = await turn(admin, { avatarId: state.owner.id, conversationId: randomUUID(), message: `안녕 [[fake:${key}]]` });
const reqs = await fake.requests(key);
check("an owner turn with NO falcon tier set still completes on pi's default model", t.status === 200 && t.of("done").length === 1 && t.of("error").length === 0 && reqs[0]?.body?.model === "fake-model", `status ${t.status}, model sent to the LLM: ${reqs[0]?.body?.model} ${JSON.stringify(t.json ?? t.of("error"))}`);
res = await admin.put("/admin/api/llm", settings({ falcon: "fake-model" }), PANEL);
body = await res.json();
check("restore: falcon tier set again", res.status === 200 && body.settings?.tiers?.falcon === "fake-model");
finish();
