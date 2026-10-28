// E2E "Noah" client for craft-runner. Runs in its OWN network-none container as uid 1000 with the
// exchange volume mounted at $X (default /x), exactly where Noah would see it (/app/craft-exchange).
//   node noah-client.mjs setup     — control ops + a full PhotoCraft session over mcp.sock
//   node noah-client.mjs teardown  — revoke + purge (after run-e2e.sh's cross-uid isolation checks)
//   node noah-client.mjs open-d|purge-d — one session around run-e2e.sh's busy-uid / orphan checks (N5)
// Env: SECRET, TOKEN_A, TOKEN_B. Prints one `E2E ok|FAIL …` line per check; exits 1 on any failure.
// Both sockets use the mutual challenge-response handshakes of spec Addendum A1/A2 (runner/src/auth.mjs):
// neither the secret nor a token is ever written to a socket, and the runner's MAC is verified before
// any request is sent.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { solidPng } from "/runner-src/selftest.mjs";
import {
  controlClientMac,
  controlServerMac,
  macMatches,
  mcpClientMac,
  mcpServerMac,
  newNonce,
  tokenIdOf,
} from "/runner-src/auth.mjs";

const X = process.env.X ?? "/x";
const RUNNER_X = "/exchange"; // the same volume as the runner sees it
const SECRET = process.env.SECRET;
const phase = process.argv[2];
const sidOf = (c) => crypto.createHash("sha256").update(`noah-craft:${c}`).digest("hex").slice(0, 32);
const SID_A = sidOf("e2e-conversation-A");
const SID_B = sidOf("e2e-conversation-B");
let failures = 0;
const check = (name, cond, detail = "") => {
  if (!cond) failures += 1;
  console.log(`E2E ${cond ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const short = (v) => JSON.stringify(v, (k, x) => (typeof x === "string" && x.length > 160 ? `${x.slice(0, 160)}…(${x.length})` : x));

class Lines {
  constructor(sock) {
    this.sock = net.createConnection(sock);
    this.buf = "";
    this.q = [];
    this.w = [];
    this.closed = new Promise((r) => this.sock.on("close", r));
    this.sock.on("error", () => {});
    this.sock.on("data", (b) => {
      this.buf += b;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const m = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        const w = this.w.shift();
        if (w) w(m);
        else this.q.push(m);
      }
    });
  }
  next(ms = 120000) {
    if (this.q.length) return Promise.resolve(this.q.shift());
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), ms);
      this.w.push((m) => {
        clearTimeout(t);
        res(m);
      });
    });
  }
  rpc(m) {
    const line = `${JSON.stringify(m)}\n`;
    this.sent = (this.sent ?? "") + line;
    this.sock.write(line);
    return this.next();
  }
}

/** Addendum A1: wait for the runner's challenge, prove the secret, verify the runner's MAC. */
async function controlHandshake(c, secret) {
  const ch = await c.next();
  const nonce = newNonce();
  const reply = await c.rpc({ op: "hello", nonce, mac: controlClientMac(secret, ch.nonce) });
  return { ch, reply, verified: reply.ok === true && macMatches(reply.mac, controlServerMac(secret, nonce)) };
}

/** Addendum A2: attach by tokenId with a MAC bound to the runner nonce and the app; verify the runner. */
async function attachHandshake(m, token, app, macToken = token) {
  const ch = await m.next();
  const nonce = newNonce();
  const att = await m.rpc({ op: "attach", app, tokenId: tokenIdOf(token), nonce, mac: mcpClientMac(macToken, ch.nonce, app) });
  return { ch, att, verified: att.ok === true && macMatches(att.mac, mcpServerMac(token, nonce)) };
}

async function controlClient() {
  const c = new Lines(`${X}/sock/control.sock`);
  const hs = await controlHandshake(c, SECRET);
  check("control handshake: challenge first", hs.ch.op === "challenge" && hs.ch.v === 1 && /^[0-9a-f]{32}$/.test(hs.ch.nonce), short(hs.ch));
  check("control handshake: runner MAC verified", hs.verified, short(hs.reply));
  if (!hs.verified) throw new Error("runner failed to authenticate; no request sent");
  check("control handshake: secret never written to the socket", !c.sent.includes(SECRET));
  let n = 0;
  return (op, args = {}) => c.rpc({ id: `e2e-${++n}`, op, ...args });
}

async function mcpClient(token) {
  const m = new Lines(`${X}/sock/mcp.sock`);
  const { att, verified } = await attachHandshake(m, token, "photocraft");
  if (att.ok) {
    check("attach handshake: runner MAC verified", verified, short(att));
    check("attach handshake: token never written to the socket", !m.sent.includes(token));
  }
  let id = 0;
  const call = (name, args = {}) => m.rpc({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
  return { m, att, call, rpc: (method, params) => m.rpc({ jsonrpc: "2.0", id: ++id, method, params }) };
}

const text = (r) => (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");

async function setup() {
  // Wrong secret (→ wrong MAC) first, then the legacy plaintext hello with the RIGHT secret.
  const bad = new Lines(`${X}/sock/control.sock`);
  const badHs = await controlHandshake(bad, "x".repeat(40));
  check("wrong-secret MAC rejected", badHs.reply.ok === false && badHs.reply.error === "unauthorized", short(badHs.reply));
  await bad.closed;
  const plain = new Lines(`${X}/sock/control.sock`);
  await plain.next();
  const plainHello = await plain.rpc({ op: "hello", secret: SECRET });
  check("plaintext-secret hello refused", plainHello.ok === false && plainHello.error === "unauthorized", short(plainHello));
  await plain.closed;

  const op = await controlClient();
  const health = await op("health");
  const pc = health.apps?.find((a) => a.id === "photocraft");
  check("health: photocraft ready", pc?.status === "ready" && pc.version === "0.16.0", short(health));
  check("health: 20 tools served", pc?.tools === 20, `tools=${pc?.tools}`);

  const openA = await op("open", { sid: SID_A });
  check("open A", openA.ok && openA.inDir === `${RUNNER_X}/work/${SID_A}/in`, short(openA));
  check("open B", (await op("open", { sid: SID_B })).ok);
  check("open rejects bad sid", (await op("open", { sid: "../../state" })).ok === false);

  // Noah writes the inbox (uid 1000, 0700).
  const inboxA = `${X}/inbox/${SID_A}/attachments`;
  fs.mkdirSync(inboxA, { recursive: true, mode: 0o700 });
  fs.chmodSync(`${X}/inbox/${SID_A}`, 0o700);
  fs.writeFileSync(`${inboxA}/test.png`, solidPng(320, 200, [30, 120, 220]), { mode: 0o600 });
  fs.symlinkSync(`${RUNNER_X}/state/uids.json`, `${inboxA}/sneaky.json`);
  const inboxB = `${X}/inbox/${SID_B}/attachments`;
  fs.mkdirSync(inboxB, { recursive: true, mode: 0o700 });
  fs.chmodSync(`${X}/inbox/${SID_B}`, 0o700);
  fs.writeFileSync(`${inboxB}/secret.png`, solidPng(16, 16, [255, 0, 0]), { mode: 0o600 });

  const syncA = await op("sync_in", { sid: SID_A });
  check("sync_in A copies the PNG", syncA.ok && syncA.copied === 1, short(syncA));
  check("sync_in A rejects the planted symlink", syncA.rejected?.some((r) => r.path === "attachments/sneaky.json" && /symlink/.test(r.reason)));
  check("sync_in B", (await op("sync_in", { sid: SID_B })).copied === 1);

  check("grant A", (await op("grant", { sid: SID_A, token: process.env.TOKEN_A })).ok);
  check("grant B", (await op("grant", { sid: SID_B, token: process.env.TOKEN_B })).ok);

  // Attach with a MAC keyed by the wrong token, and the legacy plaintext attach line.
  const wrong = new Lines(`${X}/sock/mcp.sock`);
  const wrongHs = await attachHandshake(wrong, process.env.TOKEN_A, "photocraft", process.env.TOKEN_B);
  check("attach with a wrong MAC refused", wrongHs.att.ok === false && wrongHs.att.error === "unauthorized", short(wrongHs.att));
  await wrong.closed;
  const legacy = new Lines(`${X}/sock/mcp.sock`);
  await legacy.next();
  const legacyAtt = await legacy.rpc({ op: "attach", token: process.env.TOKEN_A, app: "photocraft" });
  check("plaintext-token attach refused", legacyAtt.ok === false, short(legacyAtt));
  await legacy.closed;

  const { att, call, rpc } = await mcpClient(process.env.TOKEN_A);
  check("attach over mcp.sock as uid 1000", att.ok === true, `uid=${process.getuid()} ${short(att)}`);
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "noah-e2e", version: "1" } });
  check("initialize from manifest", init.result?.serverInfo?.name === "photocraft" && init.result.instructions.includes(`${RUNNER_X}/work/${SID_A}/out`), short(init.result?.serverInfo));
  const runningBefore = (await op("health")).procs.running;
  check("no process spawned by initialize", runningBefore === 0, `running=${runningBefore}`);
  const tools = (await rpc("tools/list", {})).result?.tools ?? [];
  check("tools/list filtered", tools.length === 20 && !tools.some((t) => t.name.startsWith("ui_") || t.name === "control_call"), tools.map((t) => t.name).join(","));

  const opened = await call("doc_open", { path: "in/attachments/test.png" });
  check("doc_open in/attachments/test.png", opened.result?.isError === false, text(opened).slice(0, 200));
  check("first tools/call spawned the child", (await op("health")).procs.running === 1);
  const blur = await call("command_run", { id: "filter.blur.gaussianBlur", params: { radius: 4 } });
  check("command_run gaussian blur", blur.result?.isError === false, text(blur).slice(0, 200));
  const prev = await call("render_preview", { max_side: 4000 });
  const img = prev.result?.content?.find((c) => c.type === "image");
  check("render_preview max_side 4000 clamped and returns an image", prev.result?.isError === false && img?.mimeType === "image/png" && img.data.length > 100, `${img?.data?.length ?? 0} b64 chars; ${text(prev).slice(0, 120)}`);
  const png = img ? Buffer.from(img.data, "base64") : Buffer.alloc(0);
  check("preview bitmap is ≤ 1568 px", png.length > 24 && png.readUInt32BE(16) <= 1568, png.length > 24 ? `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : "");

  const exp = await call("doc_export", { path: `${RUNNER_X}/work/${SID_A}/out/result.png` });
  check("doc_export absolute out/result.png", exp.result?.isError === false, text(exp).slice(0, 200));
  const expRel = await call("doc_export", { path: "relative.png" });
  console.log(`E2E info doc_export relative.png → ${text(expRel).slice(0, 200)}`);
  // The outbox is already current when the tool result arrives (sync_out ran before the response).
  const outFile = `${X}/outbox/${SID_A}/result.png`;
  const outOk = fs.existsSync(outFile) && fs.readFileSync(outFile).subarray(1, 4).toString() === "PNG";
  check("outbox has result.png right after the tool result", outOk);
  const st = outOk ? fs.statSync(outFile) : null;
  check("outbox file owned 1000, mode 0600", st && st.uid === 1000 && (st.mode & 0o777) === 0o600, st ? `uid=${st.uid} mode=${(st.mode & 0o777).toString(8)}` : "");
  const so = await op("sync_out", { sid: SID_A });
  check("sync_out lists result.png", so.files?.some((f) => f.path === "result.png" && f.size === st?.size), short(so.files));
  check(
    "sync_out reports the budget (under: 2 GiB out/, 20 GiB exchange)",
    so.budget?.over === null && so.budget.outMaxBytes === 2 * 1024 ** 3 && so.budget.exchangeMaxBytes === 20 * 1024 ** 3 && so.budget.outBytes > 0,
    short(so.budget),
  );
  console.log(`E2E info outbox files: ${so.files?.map((f) => f.path).join(", ")}`);

  const ui = await call("ui_inspect", {});
  check("denied tool ui_inspect", ui.result?.isError === true && /Denied by the Noah craft-runner/.test(text(ui)), text(ui).slice(0, 160));
  const fo = await call("command_run", { id: "file.open", params: { path: "/etc/passwd" } });
  check("denied command file.open", fo.result?.isError === true && /Denied by the Noah craft-runner/.test(text(fo)), text(fo).slice(0, 160));
  const ba = await call("command_batch", { steps: [{ id: "layer.new.layer" }, { id: "actions.play", params: { action: 0 } }] });
  check("denied batch step actions.play", ba.result?.isError === true && /step 1/.test(text(ba)), text(ba).slice(0, 160));
  const outsideB = await call("doc_open", { path: `${RUNNER_X}/work/${SID_B}/in/attachments/secret.png` });
  check("outside path (other session) rejected", outsideB.result?.isError === true, text(outsideB).slice(0, 200));
  const dotdot = await call("doc_open", { path: `../${SID_B}/in/attachments/secret.png` });
  check("../ escape rejected", dotdot.result?.isError === true, text(dotdot).slice(0, 200));
  const state = await call("doc_open", { path: `${RUNNER_X}/state/uids.json` });
  check("runner state path rejected", state.result?.isError === true, text(state).slice(0, 120));
  const exportOut = await call("doc_export", { path: `${RUNNER_X}/outbox/${SID_A}/direct.png` });
  check("export outside the write root rejected", exportOut.result?.isError === true, text(exportOut).slice(0, 200));
  // Keep A's child alive for run-e2e.sh's process/permission inspection; exit leaves the socket.
}

async function teardown() {
  const op = await controlClient();
  const { att, m } = await mcpClient(process.env.TOKEN_A);
  check("re-attach A before revoke", att.ok === true);
  check("revoke A", (await op("revoke", { token: process.env.TOKEN_A })).ok);
  await m.closed;
  check("revoke closed the mcp connection", true);
  const after = await mcpClient(process.env.TOKEN_A);
  check("revoked token cannot attach", after.att.ok === false, short(after.att));
  const purgeA = await op("purge", { sid: SID_A });
  check("purge A (incl. the stray setsid process of uid A)", purgeA.ok, short(purgeA));
  // N8: a grant (or sync_in) after purge never resurrects the session.
  const late = await op("grant", { sid: SID_A, token: crypto.randomBytes(32).toString("hex") });
  check("grant after purge refused", late.ok === false && late.error === "no such session — open it first", short(late));
  const lateSync = await op("sync_in", { sid: SID_A });
  check("sync_in after purge refused", lateSync.ok === false && /open first/.test(lateSync.error), short(lateSync));
  check("purged session not recreated (work/<A> absent)", !fs.existsSync(path.join(X, "work", SID_A)));
  const ra = await op("revoke_all");
  check("revoke_all revokes the remaining token (B)", ra.ok && ra.revoked === 1, short(ra));
  const afterAll = await mcpClient(process.env.TOKEN_B);
  check("token B cannot attach after revoke_all", afterAll.att.ok === false, short(afterAll.att));
  check("purge B", (await op("purge", { sid: SID_B })).ok);
  // Round-robin: the next session does not get the just-freed uids.
  const SID_C = sidOf("e2e-conversation-C");
  check("open C", (await op("open", { sid: SID_C })).ok);
  console.log(`E2E info sid C=${SID_C}`);
  check("purge C", (await op("purge", { sid: SID_C })).ok);
  const h = await op("health");
  check("no processes after purge", h.procs.running === 0 && h.sessions === 0, short(h.procs));
  check("health reports exchange usage", typeof h.exchange?.bytes === "number" && h.exchange.maxBytes === 20 * 1024 ** 3, short(h.exchange));
  for (const d of ["inbox", "work", "outbox"]) {
    check(`purged ${d}/<A>`, !fs.existsSync(path.join(X, d, SID_A)));
  }
}

/** N5: open D while the round-robin cursor's uid still owns a process (run-e2e.sh checks which uid D got). */
async function openD() {
  const op = await controlClient();
  check("open D", (await op("open", { sid: sidOf("e2e-conversation-D") })).ok);
}

async function purgeD() {
  const op = await controlClient();
  const r = await op("purge", { sid: sidOf("e2e-conversation-D") });
  check("purge D", r.ok, short(r));
  const h = await op("health");
  check("no sessions left", h.sessions === 0 && h.procs.running === 0, short(h));
}

try {
  if (phase === "setup") await setup();
  else if (phase === "teardown") await teardown();
  else if (phase === "open-d") await openD();
  else if (phase === "purge-d") await purgeD();
  else throw new Error("usage: noah-client.mjs setup|teardown|open-d|purge-d");
} catch (err) {
  failures += 1;
  console.log(`E2E FAIL exception — ${err.stack ?? err}`);
}
console.log(`E2E ${phase} done: ${failures} failure(s); sids A=${SID_A} B=${SID_B}`);
process.exit(failures ? 1 : 0);
