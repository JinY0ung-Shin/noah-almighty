#!/usr/bin/env node
// Scriptable fake OpenAI-compatible LLM for the pi-gateway e2e instance.
// Modelled on pi-gateway's apps/gateway/test/fixtures/fake-llm.ts, plus an HTTP control plane so tests in other
// processes can script turns.
//
//   node fake-llm.mjs [--host 10.213.0.1] [--port 18091]
//
// Model endpoints (what pi-gateway calls):
//   GET  /v1/models                 vLLM-shaped list (ids from /_fake/models, default fake-model / 131072)
//   POST /v1/chat/completions       stream=true SSE chunks (stream=false also answered, non-streamed)
//
// Routing: every chat request is matched to a QUEUE KEY. The key is the first `[[fake:KEY]]` marker found in any
// message of the request (put it in your first user message; the gateway resends history every call, so all
// LLM calls of that session route to KEY). No marker → key "default". A queue that is empty falls back to the
// key's default turn, then the global default turn (echo of the last user text).
//
// Control plane (JSON):
//   POST /_fake/enqueue   {key?, turns:[Turn...]}       append turns to key's queue → {key, queued}
//   POST /_fake/default   {key?, turn: Turn}            default turn when key's queue is empty
//   POST /_fake/reset     {key?}                        clear one key (or everything) incl. recorded requests
//   GET  /_fake/requests?key=K&limit=N                  recorded chat requests (body + selected headers)
//   POST /_fake/models    {models:[{id,max_model_len}]} replace the /v1/models list
//   GET  /_fake/state                                   queue lengths per key
//
// Turn = {
//   text?: string, textChunks?: string[], reasoning?: string,
//   toolCalls?: [{id?, name, arguments: object}],      // one LLM call may emit several tool calls
//                                                      // or {name, rawArguments: string}: argument text sent as is (streamed only)
//   usage?: {prompt_tokens, completion_tokens, cached_tokens?},
//   delayMs?: number, chunkDelayMs?: number,            // first-chunk / between-chunk delay
//   error?: {status, body},                             // HTTP error instead of a stream
//   dropConnection?: boolean,                           // send text then cut the socket
//   echo?: boolean                                      // text = "echo: <last user text>"
// }
import { createServer } from "node:http";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const HOST = opt("host", process.env.FAKE_LLM_HOST ?? "10.213.0.1");
const PORT = Number(opt("port", process.env.FAKE_LLM_PORT ?? "18091"));
const MAX_RECORDED = 200;

const queues = new Map(); // key -> Turn[]
const defaults = new Map(); // key -> Turn
const recorded = []; // {key, at, index, headers, body}
let models = [{ id: "fake-model", max_model_len: 131072 }];
let callIndex = 0;
const decisions = []; // {at, headers, body} of every POST …/systemone
let decision = { mode: "error" }; // {mode:"prefer", prefer:[tool names]} | {mode:"error"} (500, like a decision server that is down)

const GLOBAL_DEFAULT = { echo: true };
const MARKER = /\[\[fake:([A-Za-z0-9_.:-]{1,80})\]\]/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n");
  return "";
}

function keyOf(body) {
  for (const m of body.messages ?? []) {
    const hit = MARKER.exec(textOf(m.content));
    if (hit) return hit[1];
  }
  return "default";
}

function lastUserText(body) {
  const users = (body.messages ?? []).filter((m) => m.role === "user");
  return textOf(users.at(-1)?.content).slice(0, 500);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function pickHeaders(h) {
  const out = {};
  for (const name of ["authorization", "content-type", "user-agent", "x-api-key"]) {
    if (h[name] === undefined) continue;
    out[name] = name === "authorization" || name === "x-api-key" ? `<${String(h[name]).length} chars>` : h[name];
  }
  for (const [name, value] of Object.entries(h)) if (name.startsWith("x-") && !(name in out)) out[name] = value;
  return out;
}

async function control(req, res, url) {
  const key = url.searchParams.get("key");
  if (req.method === "POST" && url.pathname === "/_fake/enqueue") {
    const body = await readJson(req);
    const k = body.key ?? "default";
    const turns = Array.isArray(body.turns) ? body.turns : body.turn ? [body.turn] : [];
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(...turns);
    return json(res, 200, { key: k, queued: queues.get(k).length });
  }
  if (req.method === "POST" && url.pathname === "/_fake/default") {
    const body = await readJson(req);
    defaults.set(body.key ?? "default", body.turn ?? GLOBAL_DEFAULT);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/_fake/reset") {
    const body = await readJson(req);
    if (body.key) {
      queues.delete(body.key);
      defaults.delete(body.key);
      for (let i = recorded.length - 1; i >= 0; i--) if (recorded[i].key === body.key) recorded.splice(i, 1);
    } else {
      queues.clear();
      defaults.clear();
      recorded.length = 0;
    }
    return json(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/_fake/requests") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const list = recorded.filter((r) => !key || r.key === key).slice(-limit);
    return json(res, 200, { requests: list });
  }
  if (req.method === "POST" && url.pathname === "/_fake/models") {
    const body = await readJson(req);
    if (Array.isArray(body.models)) models = body.models;
    return json(res, 200, { models });
  }
  if (req.method === "POST" && url.pathname === "/_fake/decision") {
    const body = await readJson(req);
    decision = body.mode === "prefer" ? { mode: "prefer", prefer: Array.isArray(body.prefer) ? body.prefer : [] } : { mode: "error" };
    return json(res, 200, decision);
  }
  if (req.method === "GET" && url.pathname === "/_fake/decisions") {
    return json(res, 200, { decisions });
  }
  if (req.method === "GET" && url.pathname === "/_fake/state") {
    return json(res, 200, {
      queues: Object.fromEntries([...queues].map(([k, q]) => [k, q.length])),
      defaults: [...defaults.keys()],
      recorded: recorded.length,
      models,
    });
  }
  return json(res, 404, { error: "unknown control endpoint" });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://fake");
    if (url.pathname.startsWith("/_fake/")) return await control(req, res, url);
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, { object: "list", data: models.map((m) => ({ object: "model", owned_by: "vllm", ...m })) });
    }
    // Decision model ("System One", vLLM shape): POST {baseUrl}/systemone with {model, state, questions}. Added for
    // a boot test, modelled on pi-gateway's apps/gateway/test/fixtures/fake-llm.ts.
    if (req.method === "POST" && url.pathname.endsWith("/systemone")) {
      const body = await readJson(req);
      decisions.push({ at: new Date().toISOString(), headers: pickHeaders(req.headers), body });
      console.log(`[fake-llm] systemone #${decisions.length} mode=${decision.mode} query=${JSON.stringify(body?.state?.query ?? null)}`);
      if (decision.mode !== "prefer") return json(res, 500, { error: "decision model down" });
      const answers = {};
      for (const [id, question] of Object.entries(body.questions ?? {})) {
        const keys = Object.keys(question.criteria ?? {});
        const preferred = (decision.prefer ?? []).filter((k) => keys.includes(k));
        const weights = [0.6, 0.2, 0.1];
        const used = preferred.slice(0, weights.length).reduce((sum, _k, i) => sum + weights[i], 0);
        const rest = keys.filter((k) => !preferred.slice(0, weights.length).includes(k));
        const probabilities = Object.fromEntries(rest.map((k) => [k, (1 - used) / Math.max(1, rest.length)]));
        preferred.slice(0, weights.length).forEach((k, i) => { probabilities[k] = weights[i]; });
        const choice = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "";
        answers[id] = { type: "choice", choice, probabilities, confidence: 1 };
      }
      return json(res, 200, { answers, usage: { input_tokens: 10, output_tokens: 0 } });
    }
    if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) return json(res, 404, { error: "not found" });

    const body = await readJson(req);
    const key = keyOf(body);
    const index = callIndex++;
    recorded.push({ key, index, at: new Date().toISOString(), headers: pickHeaders(req.headers), body });
    if (recorded.length > MAX_RECORDED) recorded.shift();
    let turn = queues.get(key)?.shift() ?? defaults.get(key) ?? defaults.get("default") ?? GLOBAL_DEFAULT;
    if (turn.echo) turn = { ...turn, text: `echo: ${lastUserText(body)}` };
    console.log(`[fake-llm] #${index} key=${key} tools=${(body.tools ?? []).length} -> ${turn.toolCalls ? `tool_calls(${turn.toolCalls.map((c) => c.name).join(",")})` : JSON.stringify((turn.text ?? turn.textChunks?.join("") ?? "").slice(0, 60))}`);

    if (turn.delayMs) await sleep(turn.delayMs);
    if (turn.error) return json(res, turn.error.status, turn.error.body);

    const id = `chatcmpl-${index}`;
    const created = Math.floor(Date.now() / 1000);
    const usage = turn.usage ?? { prompt_tokens: 100, completion_tokens: 20 };
    const usageObj = {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
      ...(usage.cached_tokens !== undefined ? { prompt_tokens_details: { cached_tokens: usage.cached_tokens } } : {}),
    };
    const toolCalls = turn.toolCalls ?? [];
    const textChunks = turn.textChunks ?? (turn.text !== undefined ? [turn.text] : []);

    if (body.stream === false) {
      return json(res, 200, {
        id, object: "chat.completion", created, model: body.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: textChunks.join("") || null,
            ...(toolCalls.length ? { tool_calls: toolCalls.map((c, i) => ({ id: c.id ?? `call_${index}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) } : {}),
          },
          finish_reason: toolCalls.length ? "tool_calls" : "stop",
        }],
        usage: usageObj,
      });
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let closed = false;
    res.on("close", () => { closed = true; });
    const send = async (delta, finish = null) => {
      if (closed) return;
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (turn.chunkDelayMs) await sleep(turn.chunkDelayMs);
    };
    await send({ role: "assistant" });
    if (turn.reasoning) await send({ reasoning_content: turn.reasoning });
    for (const t of textChunks) await send({ content: t });
    if (turn.dropConnection) {
      await sleep(20);
      res.socket?.destroy();
      return;
    }
    for (const [i, call] of toolCalls.entries()) {
      const callId = call.id ?? `call_${index}_${i}`;
      // rawArguments: the argument TEXT as given — for a tool call whose JSON is cut off or broken.
      const a = typeof call.rawArguments === "string" ? call.rawArguments : JSON.stringify(call.arguments ?? {});
      const half = Math.floor(a.length / 2);
      await send({ tool_calls: [{ index: i, id: callId, type: "function", function: { name: call.name, arguments: a.slice(0, half) } }] });
      await send({ tool_calls: [{ index: i, function: { arguments: a.slice(half) } }] });
    }
    await send({}, toolCalls.length > 0 ? "tool_calls" : "stop");
    if (!closed) {
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: usageObj })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    console.error("[fake-llm] error", err);
    if (!res.headersSent) json(res, 500, { error: String(err) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`[fake-llm] listening on http://${HOST}:${PORT}/v1`));
