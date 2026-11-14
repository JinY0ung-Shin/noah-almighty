// Shared by the T (tracing) scripts: a scripted owner turn with a sandbox tool and an MCP tool, the pi session
// behind a Noah conversation, and the turn's trace through Noah's /admin proxy and from Jaeger itself.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { W, client, fake, loadState, textOf, turn } from "./e2e-common.mjs";

export const state = loadState();
export const admin = client(state.owner.cookie);
export const member = client(state.second.cookie);
export const anon = client();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = () => randomBytes(6).toString("hex");

/**
 * One owner turn in a new conversation: the scripted model runs `bash` in the sandbox, then calls the MCP tool
 * mcp__todo__add_todos through `mcp_call`, then answers. Four unique markers: in the USER message, in the bash
 * COMMAND, in the bash RESULT only (the command holds it reversed), and in the MCP tool's ARGUMENTS.
 */
export async function tracedTurn(label) {
  const id = rnd();
  const markers = { user: `TRACEUSER${id}`, command: `TRACECMD${id}`, result: `TRACERESULT${id}`, mcpArg: `TRACEMCPARG${id}` };
  const key = `trace-${id}`;
  const reversed = [...markers.result].reverse().join("");
  await fake.enqueue(key, [
    { text: "셸을 실행합니다.", toolCalls: [{ name: "bash", arguments: { command: `echo ${markers.command}; echo ${reversed} | rev` } }] },
    { toolCalls: [{ name: "mcp_call", arguments: { name: "mcp__todo__add_todos", arguments: { items: [{ title: `trace check ${markers.mcpArg}` }] } } }] },
    { text: `${label} 완료.` },
  ]);
  const conversationId = randomUUID();
  const t = await turn(admin, { avatarId: state.owner.id, conversationId, message: `${label} ${markers.user} [[fake:${key}]]` });
  const reqs = await fake.requests(key);
  const toolTexts = (reqs.at(-1)?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => textOf(m.content));
  return { ok: t.status === 200 && t.of("done").length === 1 && t.of("error").length === 0, t, conversationId, markers, key, llmCalls: reqs.length, toolTexts, done: t.of("done")[0] };
}

/** pi's sessions of the owner (newest first), through the /admin proxy. */
export async function ownerSessions() {
  const res = await admin.get(`/admin/api/history?user=${encodeURIComponent(state.owner.id)}`);
  const body = await res.json();
  return { status: res.status, items: (body.items ?? []).slice().sort((a, b) => String(b.lastActiveAt).localeCompare(String(a.lastActiveAt))) };
}

/** The pi session whose transcript holds `marker` (searching the owner's newest sessions). */
export async function sessionWith(marker) {
  const { items } = await ownerSessions();
  for (const item of items.slice(0, 12)) {
    const res = await admin.get(`/admin/api/history/${item.id}`);
    const text = await res.text();
    if (text.includes(marker)) return { ...item, transcript: text };
  }
  return null;
}

export async function traces(sessionId, c = admin) {
  const res = await c.get(`/admin/api/history/${sessionId}/traces`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, text, traces: json?.traces ?? [], json };
}

/** Poll until the newest trace of the session satisfies `ready` (spans arrive in batches: ~5 s export delay per service). */
export async function waitForTrace(sessionId, ready, { timeoutMs = 40_000, minTraces = 1 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { status: 0, traces: [], text: "" };
  while (Date.now() < deadline) {
    last = await traces(sessionId);
    if (last.status === 200 && last.traces.length >= minTraces && ready(last.traces[0], last.traces)) {
      await sleep(6000); // one more export interval, so late children (sandboxd / mcp-broker batches) are in
      return await traces(sessionId);
    }
    await sleep(1500);
  }
  return last;
}

export const names = (trace) => (trace?.spans ?? []).map((s) => `${s.service}:${s.name}`);
/** The spans as an indented tree (service, name, ms, error flag). */
export function tree(trace) {
  const spans = trace?.spans ?? [];
  const children = new Map();
  for (const s of spans) {
    const key = s.parentId && spans.some((p) => p.id === s.parentId) ? s.parentId : "";
    children.set(key, [...(children.get(key) ?? []), s]);
  }
  const lines = [];
  const walk = (key, depth) => {
    for (const s of children.get(key) ?? []) {
      lines.push(`${"  ".repeat(depth)}[${s.service}] ${s.name}  ${Math.round(s.durationMs)}ms${s.error ? "  ERROR" : ""}`);
      walk(s.id, depth + 1);
    }
  };
  walk("", 0);
  return lines.join("\n");
}
/** Every ancestor span of `span` within the trace. */
export function ancestors(trace, span) {
  const byId = new Map(trace.spans.map((s) => [s.id, s]));
  const out = [];
  for (let p = byId.get(span.parentId); p; p = byId.get(p.parentId)) out.push(p);
  return out;
}

/** Jaeger's own API, called from INSIDE the gateway container (the only place that reaches it): the raw text. */
export function jaegerRaw(path) {
  const js = `fetch("http://jaeger:16686${path}",{signal:AbortSignal.timeout(10000)}).then(async r=>{process.stdout.write(JSON.stringify({status:r.status})+"\\n"+await r.text())}).catch(e=>{process.stdout.write(JSON.stringify({status:0,error:String(e.cause?.code??e.message)})+"\\n")})`;
  const out = execFileSync("docker", ["exec", "noahcompose-dind", "docker", "exec", "noah-almighty-gateway-1", "node", "-e", js], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const nl = out.indexOf("\n");
  return { ...JSON.parse(out.slice(0, nl)), text: out.slice(nl + 1) };
}
export { W };
