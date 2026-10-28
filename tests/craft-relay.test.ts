import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startFakeRunner, type FakeRunner } from "./fake-craft-runner.js";
import { withTempDir } from "./helpers.js";
import {
  CraftRunnerError,
  __resetCraftRunnerForTests,
  craftBootRevokeSettled,
  craftControlRequest,
  craftExchangeOverBudget,
  craftSessionId,
  parseCraftBudget,
  parseCraftHealth,
  refreshCraftRunnerHealth,
  revokeAllCraftTokensAtBoot,
  sanitizeCraftRunnerText,
} from "../src/server/craftRunner.js";
import {
  CRAFT_MAX_DEPTH,
  clearCraftStaged,
  ensureCraftInbox,
  mirrorOutboxToWorkspace,
  mirrorWorkspaceToInbox,
  removeTreeNoFollow,
  stageWorkspaceFile,
  stagedFileName,
  CRAFT_LIMITS,
} from "../src/server/craftExchange.js";

const RELAY = path.join(process.cwd(), "scripts", "craft-mcp-relay.mjs");
const SECRET = "control-secret-for-tests";

let tempDir: string;
const getTempDir = withTempDir("craft-relay", () => {
  tempDir = getTempDir();
  __resetCraftRunnerForTests();
});

let runner: FakeRunner | null = null;
afterEach(async () => {
  await runner?.close();
  runner = null;
});

function exchangeConfig() {
  return { craftExchangeDir: path.join(tempDir, "ex"), craftControlSecret: SECRET, dataDir: path.join(tempDir, "data") };
}

/** Spawn the relay on a fresh handoff file; collect stdout lines. */
function spawnRelay(handoff: Record<string, unknown>) {
  const file = path.join(tempDir, `handoff-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(handoff), { mode: 0o600 });
  const child = spawn(process.execPath, [RELAY, file], { stdio: ["pipe", "pipe", "pipe"] });
  const out: string[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      out.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, file, out, exited, stderr: () => stderr };
}

async function until(predicate: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("craft-mcp-relay.mjs", () => {
  it("reads + deletes the handoff, attaches with the run token, and pipes JSON-RPC both ways", async () => {
    runner = await startFakeRunner(path.join(tempDir, "ex"), { secret: SECRET });
    const token = "a".repeat(64);
    runner.tokens.set(token, "sid");
    const relay = spawnRelay({ socket: path.join(tempDir, "ex", "sock", "mcp.sock"), token, app: "photocraft" });
    // Written before the ack arrives: buffered, then flushed in order.
    relay.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    relay.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "render_preview", arguments: {} } })}\n`);
    await until(() => relay.out.length >= 2);
    expect(fs.existsSync(relay.file)).toBe(false);
    expect(runner.attaches).toEqual([{ token, app: "photocraft", ok: true }]);
    expect(JSON.parse(relay.out[0]!)).toEqual({ jsonrpc: "2.0", id: 1, result: { echo: "initialize" } });
    expect(JSON.parse(relay.out[1]!).result.content[0].type).toBe("image");
    expect(runner.mcpLines.map((line) => JSON.parse(line).method)).toEqual(["initialize", "tools/call"]);
    relay.child.stdin.end();
    expect(await relay.exited).toBe(0);
  });

  it("never sends the token itself: tokenId + MAC over the runner's challenge and the app", async () => {
    runner = await startFakeRunner(path.join(tempDir, "ex"), { secret: SECRET });
    const token = "c".repeat(64);
    runner.tokens.set(token, "sid");
    const relay = spawnRelay({ socket: path.join(tempDir, "ex", "sock", "mcp.sock"), token, app: "photocraft" });
    relay.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
    await until(() => relay.out.length >= 1);
    const attach = JSON.parse(runner.rawLines.find((entry) => entry.socket === "mcp")!.line);
    expect(attach).toEqual({
      op: "attach",
      app: "photocraft",
      tokenId: crypto.createHash("sha256").update(token).digest("hex"),
      nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
      mac: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(runner.rawLines)).not.toContain(token);
    relay.child.stdin.end();
    expect(await relay.exited).toBe(0);
  });

  it.each(["no_mac", "wrong_mac"] as const)(
    "refuses to relay a single CLI byte to a peer that cannot prove the token (%s)",
    async (mcpImpostor) => {
      runner = await startFakeRunner(path.join(tempDir, "ex"), { secret: SECRET, mcpImpostor });
      const token = "d".repeat(64);
      const relay = spawnRelay({ socket: path.join(tempDir, "ex", "sock", "mcp.sock"), token, app: "photocraft" });
      // Written before the handshake: must stay buffered, never forwarded.
      relay.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "doc_open" } })}\n`);
      expect(await relay.exited).toBe(1);
      expect(relay.stderr()).toContain("failed to prove the run token");
      expect(runner.mcpLines).toEqual([]);
      // The impostor saw exactly the attach line — no JSON-RPC, no token.
      expect(runner.rawLines.filter((entry) => entry.socket === "mcp").map((entry) => JSON.parse(entry.line).op)).toEqual(["attach"]);
      expect(JSON.stringify(runner.rawLines)).not.toContain(token);
      expect(relay.out).toEqual([]);
    },
  );

  it("exits non-zero when the runner refuses the token", async () => {
    runner = await startFakeRunner(path.join(tempDir, "ex"), { secret: SECRET });
    const relay = spawnRelay({ socket: path.join(tempDir, "ex", "sock", "mcp.sock"), token: "b".repeat(64), app: "photocraft" });
    expect(await relay.exited).toBe(1);
    expect(relay.stderr()).toContain("refused the attach");
    expect(fs.existsSync(relay.file)).toBe(false);
  });

  it("fails loudly on a consumed handoff and rejects malformed ones", async () => {
    const missing = spawn(process.execPath, [RELAY, path.join(tempDir, "nope.json")]);
    expect(await new Promise((resolve) => missing.on("exit", resolve))).toBe(1);
    const bad = spawnRelay({ socket: "/x", token: "short", app: "photocraft" });
    expect(await bad.exited).toBe(1);
    expect(bad.stderr()).toContain("no valid token");
  });
});

describe("craftRunner control client", () => {
  it("authenticates by mutual HMAC, echoes ids, and maps refusals and outages to CraftRunnerError", async () => {
    runner = await startFakeRunner(path.join(tempDir, "ex"), { secret: SECRET, failOps: new Set(["grant"]) });
    const reply = await craftControlRequest(exchangeConfig(), "open", { sid: "0".repeat(32) });
    expect(reply.inDir).toBe(`/exchange/work/${"0".repeat(32)}/in`);
    // The hello carries a nonce + MAC, never the secret itself.
    const hello = JSON.parse(runner.rawLines.find((entry) => entry.socket === "control")!.line);
    expect(Object.keys(hello).sort()).toEqual(["mac", "nonce", "op"]);
    expect(JSON.stringify(runner.rawLines)).not.toContain(SECRET);
    await expect(craftControlRequest(exchangeConfig(), "grant", { sid: "x", token: "t" })).rejects.toMatchObject({
      kind: "rejected",
    });
    await expect(
      craftControlRequest({ ...exchangeConfig(), craftControlSecret: "wrong" }, "health"),
    ).rejects.toMatchObject({ kind: "unauthenticated", message: expect.stringContaining("unauthorized") });
    await runner.close();
    runner = null;
    const down = craftControlRequest(exchangeConfig(), "health");
    await expect(down).rejects.toBeInstanceOf(CraftRunnerError);
    await expect(down).rejects.toMatchObject({ kind: "unreachable" });
  });

  it.each(["no_mac", "wrong_mac"] as const)(
    "never sends a request to a control peer that cannot prove the secret (%s)",
    async (controlImpostor) => {
      runner = await startFakeRunner(path.join(tempDir, "ex"), { secret: SECRET, controlImpostor });
      await expect(craftControlRequest(exchangeConfig(), "grant", { sid: "0".repeat(32), token: "e".repeat(64) })).rejects.toMatchObject({
        kind: "unauthenticated",
        message: expect.stringContaining("failed to prove the control secret"),
      });
      // Only the hello reached the impostor: no request, no token, no secret.
      expect(runner.ops).toEqual([]);
      expect(runner.rawLines.map((entry) => JSON.parse(entry.line).op)).toEqual(["hello"]);
      expect(JSON.stringify(runner.rawLines)).not.toContain("e".repeat(64));
      expect(JSON.stringify(runner.rawLines)).not.toContain(SECRET);
      // The health memo reports it as unreachable, never as ok.
      expect(await refreshCraftRunnerHealth(exchangeConfig())).toMatchObject({ state: "unreachable" });
    },
  );

  it("refuses a peer that speaks first without a valid challenge", async () => {
    const net = await import("node:net");
    fs.mkdirSync(path.join(tempDir, "ex", "sock"), { recursive: true });
    const received: string[] = [];
    const server = net.createServer((socket) => {
      socket.write(`${JSON.stringify({ ok: true })}\n`);
      socket.on("data", (chunk) => received.push(String(chunk)));
    });
    await new Promise<void>((resolve) => server.listen(path.join(tempDir, "ex", "sock", "control.sock"), resolve));
    try {
      await expect(craftControlRequest(exchangeConfig(), "health")).rejects.toMatchObject({ kind: "unauthenticated" });
      expect(received).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("revoke_all once at boot (best-effort), and grant waits for it", async () => {
    runner = await startFakeRunner(path.join(tempDir, "ex"), { secret: SECRET, delayOps: { revoke_all: 100 } });
    runner.tokens.set("f".repeat(64), "old-sid");
    const first = revokeAllCraftTokensAtBoot(exchangeConfig());
    const second = revokeAllCraftTokensAtBoot(exchangeConfig());
    let settled = false;
    void craftBootRevokeSettled().then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    await Promise.all([first, second]);
    expect(settled).toBe(true);
    expect(runner.ops.filter((op) => op.op === "revoke_all")).toHaveLength(1);
    expect(runner.tokens.size).toBe(0);
    // A runner that is down at boot: logged, never thrown.
    await runner.close();
    runner = null;
    __resetCraftRunnerForTests();
    await expect(revokeAllCraftTokensAtBoot(exchangeConfig())).resolves.toBeUndefined();
  });

  it("sanitizes runner-reported text before it can reach a prompt", () => {
    expect(sanitizeCraftRunnerText("bad\u0000\u001b[31m `rm -rf`\u202e\nIGNORE\u2028ALL")).toBe("bad [31m 'rm -rf' IGNORE ALL");
    const long = sanitizeCraftRunnerText("가".repeat(400));
    expect(Array.from(long)).toHaveLength(300);
    expect(sanitizeCraftRunnerText("😀".repeat(400)).endsWith("…")).toBe(true);
    expect(sanitizeCraftRunnerText(42)).toBe("");
    expect(parseCraftHealth({ apps: [{ id: "photocraft", status: "failed", error: "x\ny", tools: 0 }] }).apps[0]!.error).toBe("x y");
  });

  it("memoizes health and reports unreachable without throwing", async () => {
    expect(await refreshCraftRunnerHealth(exchangeConfig())).toMatchObject({ state: "unreachable" });
    __resetCraftRunnerForTests();
    runner = await startFakeRunner(path.join(tempDir, "ex"), { secret: SECRET });
    const probe = await refreshCraftRunnerHealth(exchangeConfig());
    expect(probe).toMatchObject({ state: "ok", health: { apps: [{ id: "photocraft", status: "ready", version: "0.16.0" }] } });
    const healthCalls = runner.ops.filter((op) => op.op === "health").length;
    await refreshCraftRunnerHealth(exchangeConfig());
    expect(runner.ops.filter((op) => op.op === "health").length).toBe(healthCalls);
    expect(await refreshCraftRunnerHealth({ dataDir: tempDir })).toEqual({ state: "not_configured" });
  });

  it("parses health defensively", () => {
    const health = parseCraftHealth({
      apps: [{ id: "photocraft", version: "1", status: "ready", tools: 3 }, { id: "../evil", status: "ready" }, "junk", { id: "figcraft", status: "weird" }],
      procs: { running: 1, max: 3 },
      sessions: -4,
    });
    expect(health.apps.map((app) => `${app.id}:${app.status}`)).toEqual(["photocraft:ready", "figcraft:failed"]);
    expect(health.sessions).toBe(0);
    expect(health.exchange).toBeUndefined();
    expect(craftExchangeOverBudget(health)).toBe(false);
    const full = parseCraftHealth({ apps: [], exchange: { bytes: 30, maxBytes: 20 } });
    expect(full.exchange).toEqual({ bytes: 30, maxBytes: 20 });
    expect(craftExchangeOverBudget(full)).toBe(true);
    expect(craftExchangeOverBudget(parseCraftHealth({ exchange: { bytes: 20, maxBytes: 20 } }))).toBe(false);
    expect(parseCraftHealth({ exchange: { bytes: 5, maxBytes: "x" } }).exchange).toBeUndefined();
  });

  it("a budget refusal carries the runner's verdict on the CraftRunnerError (N2)", async () => {
    expect(parseCraftBudget({ over: "exchange", exchangeBytes: 1 })).toEqual({ over: "exchange" });
    expect(parseCraftBudget({ over: null })).toBeUndefined();
    expect(parseCraftBudget("exchange")).toBeUndefined();
    runner = await startFakeRunner(path.join(tempDir, "ex"), { secret: SECRET, exchange: { bytes: 30, maxBytes: 20 } });
    await expect(craftControlRequest(exchangeConfig(), "open", { sid: "1".repeat(32) })).rejects.toMatchObject({
      kind: "rejected",
      budget: { over: "exchange" },
      message: expect.stringContaining("Craft storage budget exceeded"),
    });
    await expect(craftControlRequest(exchangeConfig(), "grant", { sid: "1".repeat(32), token: "e".repeat(64) })).rejects.toMatchObject({
      kind: "rejected",
      budget: undefined,
      message: "no such session — open it first",
    });
  });

  it("derives a 32-hex session id per conversation", () => {
    const sid = craftSessionId("conv-1");
    expect(sid).toMatch(/^[0-9a-f]{32}$/);
    expect(sid).toBe(crypto.createHash("sha256").update("noah-craft:conv-1").digest("hex").slice(0, 32));
  });
});

describe("craft exchange mirroring", () => {
  async function layout() {
    const workspace = path.join(tempDir, "ws");
    const inboxRoot = path.join(tempDir, "ex", "inbox");
    fs.mkdirSync(path.join(workspace, "attachments", "sub"), { recursive: true });
    fs.mkdirSync(inboxRoot, { recursive: true });
    const inbox = (await ensureCraftInbox(inboxRoot, "s".repeat(32)))!;
    return { workspace, inboxRoot, inbox };
  }

  it("copies regular files incrementally, keeps mtime, prunes removed files", async () => {
    const { workspace, inbox } = await layout();
    fs.writeFileSync(path.join(workspace, "attachments", "a.png"), "A");
    fs.writeFileSync(path.join(workspace, "attachments", "sub", "b.png"), "BB");
    fs.mkdirSync(path.join(workspace, "craft", "out"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "craft", "out", "prev.pcraft"), "P");
    const first = await mirrorWorkspaceToInbox(workspace, inbox);
    expect(first).toMatchObject({ copied: 3, skipped: 0, rejected: [] });
    expect(fs.readFileSync(path.join(inbox, "attachments", "sub", "b.png"), "utf8")).toBe("BB");
    expect(fs.readFileSync(path.join(inbox, "craft-out", "prev.pcraft"), "utf8")).toBe("P");
    expect(fs.statSync(path.join(inbox, "attachments", "a.png")).mode & 0o777).toBe(0o600);
    expect(
      Math.abs(
        fs.statSync(path.join(inbox, "attachments", "a.png")).mtimeMs -
          fs.statSync(path.join(workspace, "attachments", "a.png")).mtimeMs,
      ),
    ).toBeLessThanOrEqual(1);
    const second = await mirrorWorkspaceToInbox(workspace, inbox);
    expect(second).toMatchObject({ copied: 0, skipped: 3 });
    fs.rmSync(path.join(workspace, "attachments", "a.png"));
    const third = await mirrorWorkspaceToInbox(workspace, inbox);
    expect(third.removed).toBe(1);
    expect(fs.existsSync(path.join(inbox, "attachments", "a.png"))).toBe(false);
  });

  it("never follows symlinks: file links, directory links and a linked source root are rejected", async () => {
    const { workspace, inbox } = await layout();
    const secret = path.join(tempDir, "secret.db");
    fs.writeFileSync(secret, "SECRET");
    fs.mkdirSync(path.join(tempDir, "elsewhere"));
    fs.writeFileSync(path.join(tempDir, "elsewhere", "x.png"), "X");
    fs.symlinkSync(secret, path.join(workspace, "attachments", "leak.png"));
    fs.symlinkSync(path.join(tempDir, "elsewhere"), path.join(workspace, "attachments", "dir"));
    fs.symlinkSync(path.join(tempDir, "elsewhere"), path.join(workspace, "captures"));
    const report = await mirrorWorkspaceToInbox(workspace, inbox);
    expect(report.rejected).toEqual(
      expect.arrayContaining([
        { path: path.join("attachments", "leak.png"), reason: "symlink" },
        { path: path.join("attachments", "dir"), reason: "symlink" },
      ]),
    );
    expect(fs.existsSync(path.join(inbox, "attachments", "leak.png"))).toBe(false);
    expect(fs.existsSync(path.join(inbox, "captures", "x.png"))).toBe(false);
    expect(fs.readdirSync(path.join(inbox, "captures"))).toEqual([]);
  });

  it("rejects FIFOs without opening them", async () => {
    const { workspace, inbox } = await layout();
    execFileSync("mkfifo", [path.join(workspace, "attachments", "pipe.png")]);
    const report = await mirrorWorkspaceToInbox(workspace, inbox);
    expect(report.rejected).toEqual([{ path: path.join("attachments", "pipe.png"), reason: "not_regular" }]);
  });

  it("enforces the per-file, file-count and total caps", async () => {
    const { workspace, inbox } = await layout();
    fs.writeFileSync(path.join(workspace, "attachments", "big.png"), Buffer.alloc(50));
    for (let i = 0; i < 4; i += 1) fs.writeFileSync(path.join(workspace, "attachments", `f${i}.png`), Buffer.alloc(10));
    const report = await mirrorWorkspaceToInbox(workspace, inbox, { maxFileBytes: 40, maxTotalBytes: 25, maxFiles: 3 });
    const reasons = Object.fromEntries(report.rejected.map((entry) => [path.basename(entry.path), entry.reason]));
    expect(reasons["big.png"]).toBe("too_large");
    expect(Object.values(reasons)).toContain("total_cap");
    expect(report.copied).toBe(2);
    const counted = await mirrorWorkspaceToInbox(workspace, inbox, { maxFileBytes: 40, maxTotalBytes: 1000, maxFiles: 3 });
    expect(counted.rejected.map((entry) => entry.reason)).toContain("count_cap");
  });

  it("replaces a link planted in the inbox instead of writing through it", async () => {
    const { workspace, inbox } = await layout();
    const target = path.join(tempDir, "target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(inbox, "attachments"));
    fs.writeFileSync(path.join(workspace, "attachments", "a.png"), "A");
    await mirrorWorkspaceToInbox(workspace, inbox);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.lstatSync(path.join(inbox, "attachments")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(inbox, "attachments", "a.png"), "utf8")).toBe("A");
  });

  it("mirrors the outbox into craft/out/, through no planted link, and never wipes on a missing outbox", async () => {
    const workspace = path.join(tempDir, "ws");
    const outbox = path.join(tempDir, "outbox");
    fs.mkdirSync(path.join(outbox, "nested"), { recursive: true });
    fs.writeFileSync(path.join(outbox, "nested", "result.png"), "R");
    fs.mkdirSync(path.join(workspace, "craft"), { recursive: true });
    const target = path.join(tempDir, "victim");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(workspace, "craft", "out"));
    const report = await mirrorOutboxToWorkspace(outbox, workspace);
    expect(report.copied).toBe(1);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(fs.readFileSync(path.join(workspace, "craft", "out", "nested", "result.png"), "utf8")).toBe("R");
    expect((await mirrorOutboxToWorkspace(path.join(tempDir, "no-outbox"), workspace)).removed).toBe(0);
    expect(fs.existsSync(path.join(workspace, "craft", "out", "nested", "result.png"))).toBe(true);
  });

  it("the workspace mirror is ADDITIVE: an emptied (GC'd / rebuilt) outbox never wipes earlier results", async () => {
    const workspace = path.join(tempDir, "ws");
    const outbox = path.join(tempDir, "outbox");
    fs.mkdirSync(outbox, { recursive: true });
    fs.mkdirSync(path.join(workspace, "craft", "out"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "craft", "out", "yesterday.psd"), "8BPS-old");
    fs.writeFileSync(path.join(outbox, "today.png"), "NEW");
    const report = await mirrorOutboxToWorkspace(outbox, workspace);
    expect(report).toMatchObject({ copied: 1, removed: 0 });
    expect(fs.readdirSync(path.join(workspace, "craft", "out")).sort()).toEqual(["today.png", "yesterday.psd"]);
    // The runner GC'd the session: the next run's outbox is empty.
    fs.rmSync(outbox, { recursive: true });
    fs.mkdirSync(outbox);
    expect(await mirrorOutboxToWorkspace(outbox, workspace)).toMatchObject({ copied: 0, removed: 0 });
    expect(fs.readdirSync(path.join(workspace, "craft", "out")).sort()).toEqual(["today.png", "yesterday.psd"]);
    // An overwrite still lands.
    fs.writeFileSync(path.join(outbox, "today.png"), "NEWER");
    await mirrorOutboxToWorkspace(outbox, workspace);
    expect(fs.readFileSync(path.join(workspace, "craft", "out", "today.png"), "utf8")).toBe("NEWER");
  });

  it("craft/out/ is capped as a WHOLE: what it holds plus what a mirror adds stays within the cap (N2)", async () => {
    const workspace = path.join(tempDir, "ws");
    const outbox = path.join(tempDir, "outbox");
    fs.mkdirSync(path.join(workspace, "craft", "out"), { recursive: true });
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(path.join(workspace, "craft", "out", "old.psd"), Buffer.alloc(6));
    fs.writeFileSync(path.join(outbox, "a.png"), Buffer.alloc(3));
    fs.writeFileSync(path.join(outbox, "b.png"), Buffer.alloc(3));
    const report = await mirrorOutboxToWorkspace(outbox, workspace, CRAFT_LIMITS, 10);
    expect(report.copied).toBe(1);
    expect(report.rejected).toEqual([{ path: path.join("out", "b.png"), reason: "workspace_cap" }]);
    expect(fs.readdirSync(path.join(workspace, "craft", "out")).sort()).toEqual(["a.png", "old.psd"]);
    // An overwrite only counts its growth: a same-size rewrite of a.png still lands at the cap.
    fs.writeFileSync(path.join(outbox, "a.png"), Buffer.alloc(3, 1));
    fs.utimesSync(path.join(outbox, "a.png"), new Date(), new Date(Date.now() + 5_000));
    const again = await mirrorOutboxToWorkspace(outbox, workspace, CRAFT_LIMITS, 10);
    expect(again.copied).toBe(1);
    expect(fs.readFileSync(path.join(workspace, "craft", "out", "a.png"))).toEqual(Buffer.alloc(3, 1));
    expect(again.rejected.map((entry) => entry.reason)).toEqual(["workspace_cap"]);
  });

  it("walks are iterative and depth-capped: a deep chain is rejected too_deep, the rest still mirrors", async () => {
    const { workspace, inbox } = await layout();
    let deep = path.join(workspace, "attachments");
    for (let i = 0; i < CRAFT_MAX_DEPTH + 8; i += 1) deep = path.join(deep, "d");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "deep.png"), "D");
    fs.writeFileSync(path.join(workspace, "attachments", "top.png"), "T");
    const report = await mirrorWorkspaceToInbox(workspace, inbox);
    expect(report.rejected.map((entry) => entry.reason)).toEqual(["too_deep"]);
    expect(report.rejected[0]!.path.split(path.sep).length).toBe(CRAFT_MAX_DEPTH + 2);
    expect(fs.readFileSync(path.join(inbox, "attachments", "top.png"), "utf8")).toBe("T");
  });

  it("removeTreeNoFollow: iterative, never follows links, leaves only what is too deep", async () => {
    const root = path.join(tempDir, "victim-tree");
    const outside = path.join(tempDir, "outside-dir");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "K");
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(root, "a", "b", "f.txt"), "F");
    fs.symlinkSync(outside, path.join(root, "a", "link"));
    expect(await removeTreeNoFollow(root)).toBe(0);
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("K");
    let deep = path.join(tempDir, "deep-tree");
    for (let i = 0; i < CRAFT_MAX_DEPTH + 3; i += 1) deep = path.join(deep, "d");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(tempDir, "deep-tree", "shallow.txt"), "S");
    expect(await removeTreeNoFollow(path.join(tempDir, "deep-tree"))).toBe(1);
    expect(fs.existsSync(path.join(tempDir, "deep-tree", "shallow.txt"))).toBe(false);
    expect(await removeTreeNoFollow(path.join(tempDir, "nope"))).toBe(0);
  });

  it("copies do not block the event loop (async, chunked)", async () => {
    const { workspace, inbox } = await layout();
    fs.writeFileSync(path.join(workspace, "attachments", "big.bin"), Buffer.alloc(8 * 1024 * 1024, 7));
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 0);
    try {
      const report = await mirrorWorkspaceToInbox(workspace, inbox);
      expect(report.copied).toBe(1);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
    expect(fs.statSync(path.join(inbox, "attachments", "big.bin")).size).toBe(8 * 1024 * 1024);
  });

  it("staged names are capped by UTF-8 bytes on a code-point boundary, keeping the extension", () => {
    const tag = (source: string) => `-${crypto.createHash("sha256").update(source).digest("hex").slice(0, 8)}`;
    const hangul = `/ws/${"가".repeat(120)}.psd`;
    const name = stagedFileName(hangul);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(200);
    // 200 - ".psd" (4) - tag (9) = 187 bytes of stem = 62 Hangul characters.
    expect(name).toBe(`${"가".repeat(62)}${tag(hangul)}.psd`);
    const emoji = `/ws/${"😀".repeat(80)}`;
    expect(stagedFileName(emoji)).toBe(`${"😀".repeat(47)}${tag(emoji)}`);
    expect(stagedFileName("/ws/short.png")).toBe(`short${tag("/ws/short.png")}.png`);
    expect(stagedFileName("/ws/.hidden")).toBe(`hidden${tag("/ws/.hidden")}`);
  });

  it("staged names are unique per source path: the same basename from two folders never collides (N6)", () => {
    const a = stagedFileName("/ws/a/logo.png");
    const b = stagedFileName("/ws/b/logo.png");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^logo-[0-9a-f]{8}\.png$/);
    expect(b).toMatch(/^logo-[0-9a-f]{8}\.png$/);
    // Re-staging the same file keeps its own name.
    expect(stagedFileName("/ws/a/logo.png")).toBe(a);
  });

  it("staged/ counts against the whole-inbox cap and is cleared per run", async () => {
    const { workspace, inbox } = await layout();
    fs.writeFileSync(path.join(workspace, "attachments", "a.png"), Buffer.alloc(30));
    fs.writeFileSync(path.join(workspace, "one.png"), Buffer.alloc(30));
    fs.writeFileSync(path.join(workspace, "two.png"), Buffer.alloc(30));
    const limits = { maxFileBytes: 100, maxTotalBytes: 80, maxFiles: 10 };
    await mirrorWorkspaceToInbox(workspace, inbox, limits);
    const one = stagedFileName(fs.realpathSync(path.join(workspace, "one.png")));
    const two = stagedFileName(fs.realpathSync(path.join(workspace, "two.png")));
    expect(await stageWorkspaceFile([workspace], "one.png", inbox, limits)).toEqual({ name: one, size: 30 });
    // 30 (attachments) + 30 (one) + 30 > 80.
    expect(await stageWorkspaceFile([workspace], "two.png", inbox, limits)).toEqual({ error: "INBOX_FULL" });
    // Re-staging the same file replaces its copy instead of adding.
    expect(await stageWorkspaceFile([workspace], "one.png", inbox, limits)).toEqual({ name: one, size: 30 });
    await clearCraftStaged(inbox);
    expect(fs.existsSync(path.join(inbox, "staged"))).toBe(false);
    expect(await stageWorkspaceFile([workspace], "two.png", inbox, limits)).toEqual({ name: two, size: 30 });
  });

  it("stages one workspace file by realpath, refusing outside paths, links to outside and oversize files", async () => {
    const { workspace, inbox } = await layout();
    fs.writeFileSync(path.join(workspace, "logo.png"), "L");
    const logo = stagedFileName(fs.realpathSync(path.join(workspace, "logo.png")));
    expect(await stageWorkspaceFile([workspace], "logo.png", inbox)).toEqual({ name: logo, size: 1 });
    expect(fs.readFileSync(path.join(inbox, "staged", logo), "utf8")).toBe("L");
    fs.writeFileSync(path.join(tempDir, "outside.png"), "O");
    expect(await stageWorkspaceFile([workspace], path.join(tempDir, "outside.png"), inbox)).toEqual({ error: "OUTSIDE_WORKSPACE" });
    fs.symlinkSync(path.join(tempDir, "outside.png"), path.join(workspace, "via-link.png"));
    expect(await stageWorkspaceFile([workspace], "via-link.png", inbox)).toEqual({ error: "OUTSIDE_WORKSPACE" });
    expect(await stageWorkspaceFile([workspace], "missing.png", inbox)).toEqual({ error: "NOT_FOUND" });
    expect(await stageWorkspaceFile([workspace], "attachments", inbox)).toEqual({ error: "NOT_FILE" });
    expect(await stageWorkspaceFile([workspace], "logo.png", inbox, { ...CRAFT_LIMITS, maxFileBytes: 0 })).toEqual({ error: "TOO_LARGE" });
    // A staged file survives the next mirror (staged/ is never pruned).
    await mirrorWorkspaceToInbox(workspace, inbox);
    expect(fs.existsSync(path.join(inbox, "staged", logo))).toBe(true);
  });
});
