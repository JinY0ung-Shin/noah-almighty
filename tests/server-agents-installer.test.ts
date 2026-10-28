import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerAgent } from "../src/shared/serverAgents.js";
import type { ServerConnection } from "../src/server/serverAgents/connection.js";
import { ServerAgentError } from "../src/server/serverAgents/errors.js";
import type { Store } from "../src/server/store.js";
import type { AppConfig } from "../src/server/types.js";

const mocks = vi.hoisted(() => ({
  openServerConnection: vi.fn(),
  query: vi.fn(),
}));

vi.mock("../src/server/serverAgents/connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/serverAgents/connection.js")>()),
  openServerConnection: mocks.openServerConnection,
}));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: mocks.query,
}));

const {
  buildProbeScript,
  checkServerAgent,
  classifyRemoteApiFailure,
  cleanupServerRemote,
  localCaBundle,
  localCliInfo,
  localCliSha256,
  parseProbeOutput,
  planPrune,
  prepareServer,
  resetLocalCliInfoForTests,
} = await import("../src/server/serverAgents/installer.js");
const { markServerAgentDeleting, resetServerAgentSlotsForTests, tryAcquireServerAgentSlot } = await import(
  "../src/server/serverAgents/limits.js"
);
const { REMOTE_SCRIPT_RUNNER } = await import("../src/server/serverAgents/connection.js");
const { serverAgentBaseEnv, serverAgentDefaultModel } = await import("../src/server/serverAgents/env.js");

// A ServerConnection that behaves like the real one against a temp HOME: a script
// travels on stdin to REMOTE_SCRIPT_RUNNER (run by a LOCAL `sh -c`, standing in for
// the login shell), and "uploads" are copies, so the real probe / verify / prune /
// CA / cleanup scripts execute. `probeOverride` swaps the probe's stdout to reach
// the failure branches the dev box cannot produce (aarch64, noexec, full disk).

let root: string;
let home: string;
let fakeCli: string;

function localConnection(opts: { probeOverride?: string; failPut?: boolean } = {}) {
  const commands: string[] = [];
  const puts: string[] = [];
  const conn: ServerConnection & { commands: string[]; puts: string[]; ended: boolean } = {
    commands,
    puts,
    ended: false,
    raw: null,
    closed: new Promise(() => {}),
    end() {
      conn.ended = true;
    },
    execText(script, execOpts = {}) {
      const verbatim = execOpts.stdin !== undefined;
      commands.push(script);
      if (opts.probeOverride !== undefined && script.includes('echo "arch=')) {
        return Promise.resolve({ code: 0, stdout: opts.probeOverride, stderr: "" });
      }
      return new Promise((resolve) => {
        const child = spawn("sh", ["-c", verbatim ? script : REMOTE_SCRIPT_RUNNER], { cwd: home, env: { PATH: process.env.PATH, HOME: home } });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d));
        child.stderr.on("data", (d: Buffer) => (stderr += d));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        // A command that exits without reading stdin makes this write EPIPE; that is
        // the command's business (its exit code says what happened), not an unhandled error.
        child.stdin.on("error", () => {});
        child.stdin.end(verbatim ? execOpts.stdin : script);
      });
    },
    async putFile(localPath, remotePath, mode, onProgress) {
      puts.push(remotePath);
      if (opts.failPut) throw new ServerAgentError("UPLOAD_FAILED", "sftp: permission denied");
      const target = path.isAbsolute(remotePath) ? remotePath : path.join(home, remotePath);
      fs.copyFileSync(localPath, target);
      fs.chmodSync(target, mode);
      const size = fs.statSync(localPath).size;
      onProgress?.(size, size);
    },
  };
  return conn;
}

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const binDir = () => path.join(home, ".noah-agent", "bin");

const server: ServerAgent = {
  id: "srv-1",
  name: "web-01",
  host: "10.0.0.5",
  port: 22,
  username: "svc",
  workdir: "/placeholder",
  role: "",
  notes: "",
  access: "read",
  enabled: true,
  installState: null,
  createdAt: "",
  updatedAt: "",
};

function fakeStore(secrets: Record<string, string> = { SSH_PRIVATE_KEY: "KEY", SSH_PASSPHRASE: "PW" }) {
  const states: unknown[] = [];
  const store = {
    getUserSecrets: vi.fn(() => secrets),
    setServerAgentInstallState: vi.fn((_owner: string, _id: string, state: unknown) => states.push(state)),
    getAppSecret: vi.fn(() => null),
    getModelOverride: vi.fn(() => null),
    serverAgentDeploymentId: vi.fn(() => "dep0self"),
    isServerAgentsEnabled: vi.fn(() => true),
    countServerAgentsOnAccount: vi.fn(() => 0),
  };
  return { store: store as unknown as Store, raw: store, states };
}

const config = { dataDir: "/unused" } as AppConfig;

async function* messages(...items: unknown[]) {
  for (const item of items) yield item;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "noah-sa-installer-"));
  home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  fakeCli = path.join(root, "claude");
  fs.writeFileSync(fakeCli, '#!/bin/sh\n[ "$1" = "--version" ] && echo "9.9.9 (Claude Code)"\n', { mode: 0o755 });
  resetLocalCliInfoForTests({ version: "9.9.9", path: fakeCli });
  resetServerAgentSlotsForTests();
  mocks.openServerConnection.mockReset();
  mocks.query.mockReset();
  delete process.env.NOAH_EGRESS_POLICY;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.NOAH_EGRESS_POLICY;
});

describe("probe parsing and prune planning", () => {
  it("parses the probe script's key=value lines", () => {
    const probe = parseProbeOutput(
      ["arch=x86_64", "missing=timeout", "missing=sha256sum", "free=123456", "home=ok", "exec=fail", `cli=${"a".repeat(64)}`, "ca=", "bin=claude-1.0.0", "bin=claude-0.9.0", "junk"].join("\n"),
    );
    expect(probe).toEqual({
      arch: "x86_64",
      missingTools: ["timeout", "sha256sum"],
      freeKb: 123456,
      homeWritable: true,
      execOk: false,
      cliSha: "a".repeat(64),
      caSha: "",
      binFiles: ["claude-1.0.0", "claude-0.9.0"],
    });
    expect(parseProbeOutput("free=\ncli=not-a-sha").freeKb).toBeNull();
  });

  it("the real probe script reports this machine", async () => {
    const conn = localConnection();
    const out = await conn.execText(buildProbeScript("9.9.9"));
    const probe = parseProbeOutput(out.stdout);
    expect(probe.arch).toBe(os.arch() === "x64" ? "x86_64" : probe.arch);
    expect(probe.missingTools).toEqual([]);
    expect(probe.homeWritable).toBe(true);
    expect(probe.execOk).toBe(true);
    expect(probe.freeKb).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(home, ".noah-agent"))).toEqual(expect.arrayContaining(["bin", "run"]));
  });

  it.each([
    [["claude-0.3.283", "claude-0.3.280", "claude-0.3.270", "claude-0.3.290"], "0.3.283", ["claude-0.3.270"]],
    [["claude-0.3.283", "claude-0.3.283.ab12cd34.tmp", "claude-0.3.281"], "0.3.283", []],
    [["claude-0.2.9", "claude-0.10.1", "claude-0.3.0"], "0.11.0", ["claude-0.2.9", "claude-0.3.0"]],
    [["claude-weird", "ca.pem"], "1.0.0", []],
  ])("planPrune(%j, %s) → %j", (files, current, expected) => {
    expect(planPrune(files, current)).toEqual(expected);
  });

  it("classifies remote API failures", () => {
    expect(classifyRemoteApiFailure("API Error: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)")).toBe("TLS_CA");
    expect(classifyRemoteApiFailure("self signed certificate in certificate chain")).toBe("TLS_CA");
    expect(classifyRemoteApiFailure("API Error: Unable to connect to API (ECONNREFUSED)")).toBe("MODEL_UNREACHABLE");
    expect(classifyRemoteApiFailure("Request timed out.")).toBe("MODEL_UNREACHABLE");
    expect(classifyRemoteApiFailure("API Error: 401 invalid x-api-key")).toBe("UNKNOWN");
  });
});

describe("local CLI + CA", () => {
  it("resolves the bundled platform CLI and hashes it once in the background", async () => {
    resetLocalCliInfoForTests();
    const info = localCliInfo();
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.path).toMatch(/claude-agent-sdk-linux-x64[/\\]claude$/);
    const [a, b] = await Promise.all([localCliSha256(), localCliSha256()]);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(localCliInfo().sha256).toBe(a);
  }, 30_000);

  it("picks NODE_EXTRA_CA_CERTS when readable", () => {
    const ca = path.join(root, "ca.crt");
    fs.writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n");
    expect(localCaBundle({ NODE_EXTRA_CA_CERTS: ca })).toEqual({ path: ca, sha256: sha256(ca) });
    if (!fs.existsSync("/usr/local/share/ca-certificates/extra-proxy-ca.crt")) {
      expect(localCaBundle({ NODE_EXTRA_CA_CERTS: path.join(root, "missing.crt") })).toBeNull();
      expect(localCaBundle({})).toBeNull();
    }
  });
});

describe("prepareServer", () => {
  it("installs on first run (tmp → sha check → mv), then skips while the sha matches", async () => {
    const conn = localConnection();
    const stages: string[] = [];
    const first = await prepareServer(conn, { env: {}, onProgress: (stage) => stages.push(stage) });
    expect(first).toEqual({ cliRemotePath: ".noah-agent/bin/claude-9.9.9", caRemotePath: null, version: "9.9.9", pushed: true });
    expect(conn.puts[0]).toMatch(/^\.noah-agent\/bin\/claude-9\.9\.9\.[0-9a-f]{8}\.tmp$/);
    expect(sha256(path.join(binDir(), "claude-9.9.9"))).toBe(sha256(fakeCli));
    expect(fs.readdirSync(binDir())).toEqual(["claude-9.9.9"]);
    expect(stages).toEqual(expect.arrayContaining(["probe", "upload", "verify", "prune"]));

    const again = localConnection();
    expect((await prepareServer(again, { env: {} })).pushed).toBe(false);
    expect(again.puts).toEqual([]);
  });

  it("re-uploads on a sha mismatch and keeps only current + newest previous (newer kept)", async () => {
    fs.mkdirSync(binDir(), { recursive: true });
    for (const name of ["claude-9.9.9", "claude-9.9.8", "claude-9.9.7", "claude-10.0.0"]) {
      fs.writeFileSync(path.join(binDir(), name), "old");
    }
    fs.writeFileSync(path.join(binDir(), "claude-9.9.9.deadbeef.tmp"), "in-flight upload");
    const result = await prepareServer(localConnection(), { env: {} });
    expect(result.pushed).toBe(true);
    expect(sha256(path.join(binDir(), "claude-9.9.9"))).toBe(sha256(fakeCli));
    expect(fs.readdirSync(binDir()).sort()).toEqual(["claude-10.0.0", "claude-9.9.8", "claude-9.9.9", "claude-9.9.9.deadbeef.tmp"]);
  });

  it("installs the CA bundle once (0600) and reports its remote path", async () => {
    const ca = path.join(root, "corp-ca.crt");
    fs.writeFileSync(ca, "CA-BODY\n");
    const conn = localConnection();
    const result = await prepareServer(conn, { env: { NODE_EXTRA_CA_CERTS: ca } });
    expect(result.caRemotePath).toBe(".noah-agent/ca.pem");
    const remote = path.join(home, ".noah-agent", "ca.pem");
    expect(fs.readFileSync(remote, "utf8")).toBe("CA-BODY\n");
    expect(fs.statSync(remote).mode & 0o777).toBe(0o600);
    const again = localConnection();
    expect((await prepareServer(again, { env: { NODE_EXTRA_CA_CERTS: ca } })).caRemotePath).toBe(".noah-agent/ca.pem");
    expect(again.puts).toEqual([]);
  });

  const okProbe = ["arch=x86_64", "free=9999999", "home=ok", "exec=ok", "cli=", "ca="];
  it.each([
    [["arch=aarch64", ...okProbe.slice(1)], "UNSUPPORTED_ARCH"],
    [[...okProbe, "missing=timeout"], "MISSING_TOOLS"],
    [okProbe.map((l) => (l === "home=ok" ? "home=fail" : l)), "HOME_NOT_WRITABLE"],
    [okProbe.map((l) => (l === "exec=ok" ? "exec=fail" : l)), "NOEXEC_HOME"],
    [okProbe.map((l) => (l.startsWith("free=") ? "free=1024" : l)), "DISK_SPACE"],
  ])("probe %j → %s", async (lines, code) => {
    await expect(prepareServer(localConnection({ probeOverride: lines.join("\n") }), { env: {} })).rejects.toMatchObject({ code });
  });

  it("does not need free space when nothing is uploaded", async () => {
    await prepareServer(localConnection(), { env: {} });
    const lines = ["arch=x86_64", "free=10", "home=ok", "exec=ok", `cli=${sha256(fakeCli)}`, "ca="];
    expect((await prepareServer(localConnection({ probeOverride: lines.join("\n") }), { env: {} })).pushed).toBe(false);
  });

  it("maps an upload failure to UPLOAD_FAILED and a CLI that does not start to UNSUPPORTED_ARCH", async () => {
    await expect(prepareServer(localConnection({ failPut: true }), { env: {} })).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
    fs.writeFileSync(fakeCli, "#!/bin/sh\necho 'GLIBC_2.99 not found' >&2\nexit 1\n");
    resetLocalCliInfoForTests({ version: "9.9.9", path: fakeCli });
    await expect(prepareServer(localConnection(), { env: {} })).rejects.toMatchObject({ code: "UNSUPPORTED_ARCH" });
    // The binary that failed its smoke is removed: a matching sha must not skip the smoke next time.
    expect(fs.existsSync(path.join(binDir(), "claude-9.9.9"))).toBe(false);
    const retry = localConnection();
    await expect(prepareServer(retry, { env: {} })).rejects.toMatchObject({ code: "UNSUPPORTED_ARCH" });
    expect(retry.puts).toHaveLength(1);
  });
});

describe("checkServerAgent", () => {
  const okResult = { type: "result", subtype: "success", is_error: false, result: "OK" };

  it("connects with the vault key, prepares, checks the workdir, pings the model, and persists ok", async () => {
    const conn = localConnection();
    mocks.openServerConnection.mockResolvedValue(conn);
    mocks.query.mockReturnValue(messages({ type: "system" }, okResult));
    const { store, states, raw } = fakeStore();
    const workdir = path.join(root, "work", "deep");
    const state = await checkServerAgent({ store, config }, "owner-1", { ...server, workdir });
    expect(state).toMatchObject({ ok: true, version: "9.9.9", error: null, detail: null });
    expect(states).toEqual([state]);
    // Written conditionally on the target the check ran against (an owner re-point mid-check wins).
    expect(raw.setServerAgentInstallState).toHaveBeenCalledWith("owner-1", server.id, state, {
      host: "10.0.0.5",
      port: 22,
      username: "svc",
      workdir,
    });
    expect(fs.existsSync(workdir)).toBe(true);
    expect(mocks.openServerConnection).toHaveBeenCalledWith(
      config,
      { ownerUserId: "owner-1", host: "10.0.0.5", port: 22, username: "svc" },
      { privateKey: "KEY", passphrase: "PW" },
    );
    const options = mocks.query.mock.calls[0][0].options;
    expect(options).toMatchObject({ cwd: workdir, tools: [], settingSources: [], strictMcpConfig: true, maxTurns: 1, model: "opus" });
    expect(options.settings).toEqual({ crossSessionInbound: "refuse" });
    expect(typeof options.spawnClaudeCodeProcess).toBe("function");
    expect(options.env.SESSION_SECRET).toBeUndefined();
    expect(conn.ended).toBe(true);
    // The check's slot was released.
    expect(tryAcquireServerAgentSlot("x", "owner-1", server.id).ok).toBe(true);
  });

  it("classifies a remote TLS failure from the result text", async () => {
    mocks.openServerConnection.mockResolvedValue(localConnection());
    mocks.query.mockReturnValue(
      messages({ type: "result", subtype: "success", is_error: true, result: "API Error: UNABLE_TO_VERIFY_LEAF_SIGNATURE" }),
    );
    const { store } = fakeStore();
    const state = await checkServerAgent({ store, config }, "owner-1", { ...server, workdir: path.join(root, "w") });
    expect(state).toMatchObject({ ok: false, version: "9.9.9", error: "TLS_CA" });
  });

  it("maps a remote exit 98 to WORKDIR and other process failures by text", async () => {
    mocks.openServerConnection.mockResolvedValue(localConnection());
    mocks.query.mockImplementation(() =>
      (async function* () {
        throw new Error("Claude Code process exited with code 98");
      })(),
    );
    const { store } = fakeStore();
    expect((await checkServerAgent({ store, config }, "owner-1", { ...server, workdir: path.join(root, "w") })).error).toBe("WORKDIR");
  });

  it("reports an uncreatable workdir as WORKDIR", async () => {
    mocks.openServerConnection.mockResolvedValue(localConnection());
    const { store } = fakeStore();
    const state = await checkServerAgent({ store, config }, "owner-1", { ...server, workdir: "/proc/noah-cannot-create" });
    expect(state).toMatchObject({ ok: false, error: "WORKDIR" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("fails closed before connecting without a key or under egress domain-proxy, keeping the known version", async () => {
    const { store, states } = fakeStore({});
    const known = { ...server, installState: { ok: true, version: "9.9.8", error: null, detail: null, checkedAt: "t" } };
    expect(await checkServerAgent({ store, config }, "owner-1", known)).toMatchObject({ ok: false, error: "NO_SSH_KEY", version: "9.9.8" });
    process.env.NOAH_EGRESS_POLICY = "domain-proxy";
    expect((await checkServerAgent({ store: fakeStore().store, config }, "owner-1", server)).error).toBe("EGRESS_BLOCKED");
    expect(mocks.openServerConnection).not.toHaveBeenCalled();
    expect(states).toHaveLength(1);
  });

  it("persists a classified connection failure", async () => {
    mocks.openServerConnection.mockRejectedValue(new ServerAgentError("HOST_NOT_TRUSTED", "host key not in known_hosts"));
    const { store, states } = fakeStore();
    const state = await checkServerAgent({ store, config }, "owner-1", server);
    expect(state).toMatchObject({ ok: false, error: "HOST_NOT_TRUSTED", detail: "host key not in known_hosts" });
    expect(states).toEqual([state]);
  });

  it("refuses without persisting while the server is at its run cap", async () => {
    tryAcquireServerAgentSlot("r1", "owner-1", server.id);
    tryAcquireServerAgentSlot("r2", "owner-1", server.id);
    const { store, states } = fakeStore();
    const state = await checkServerAgent({ store, config }, "owner-1", server);
    expect(state).toMatchObject({ ok: false, error: "BUSY" });
    expect(state.detail).toContain("busy");
    expect(states).toEqual([]);
    expect(mocks.openServerConnection).not.toHaveBeenCalled();
  });

  it("refuses without connecting or persisting while the admin switch is off", async () => {
    const { store, states, raw } = fakeStore();
    raw.isServerAgentsEnabled.mockReturnValue(false as never);
    const state = await checkServerAgent({ store, config }, "owner-1", server);
    expect(state).toMatchObject({ ok: false, error: "ADMIN_DISABLED" });
    expect(states).toEqual([]);
    expect(mocks.openServerConnection).not.toHaveBeenCalled();
  });

  it("refuses without persisting while the server row is being deleted", async () => {
    const release = markServerAgentDeleting(server.id)!;
    const { store, states } = fakeStore();
    const state = await checkServerAgent({ store, config }, "owner-1", server);
    expect(state).toMatchObject({ ok: false, error: "BUSY", detail: "the server is being deleted" });
    expect(states).toEqual([]);
    release();
    expect(tryAcquireServerAgentSlot("after", "owner-1", server.id).ok).toBe(true);
  });
});

describe("cleanupServerRemote", () => {
  it("removes both remote dirs", async () => {
    fs.mkdirSync(path.join(home, ".noah-agent", "bin"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude-noah"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const conn = localConnection();
    mocks.openServerConnection.mockResolvedValue(conn);
    expect(await cleanupServerRemote({ store: fakeStore().store, config }, "owner-1", server)).toEqual({ status: "done" });
    expect(fs.readdirSync(home)).toEqual([".claude"]);
    expect(conn.ended).toBe(true);
  });

  it("skips (never forces) when another row targets the same account, or a run there is live or unexpired", async () => {
    fs.mkdirSync(path.join(home, ".noah-agent", "run"), { recursive: true });
    fs.mkdirSync(path.join(home, ".claude-noah"), { recursive: true });
    const shared = fakeStore();
    shared.raw.countServerAgentsOnAccount.mockReturnValue(1 as never);
    expect(await cleanupServerRemote({ store: shared.store, config }, "owner-1", server)).toEqual({ status: "skipped", reason: "shared_account" });
    expect(shared.raw.countServerAgentsOnAccount).toHaveBeenCalledWith("10.0.0.5", 22, "svc", server.id);
    expect(mocks.openServerConnection).not.toHaveBeenCalled();

    // Another deployment's unexpired run on the account: the sweep spares it, so the cleanup stands down.
    const future = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(path.join(home, ".noah-agent", "run", "foreign-run.pid"), `999999 ${future} otherdep\n`);
    mocks.openServerConnection.mockResolvedValue(localConnection());
    expect(await cleanupServerRemote({ store: fakeStore().store, config }, "owner-1", server)).toEqual({ status: "skipped", reason: "active_runs" });
    expect(fs.existsSync(path.join(home, ".claude-noah"))).toBe(true);

    // Once that run's deadline has passed it is swept like any stale file, and the cleanup proceeds.
    fs.writeFileSync(path.join(home, ".noah-agent", "run", "foreign-run.pid"), `999999 ${future - 7200} otherdep\n`);
    mocks.openServerConnection.mockResolvedValue(localConnection());
    expect(await cleanupServerRemote({ store: fakeStore().store, config }, "owner-1", server)).toEqual({ status: "done" });
    expect(fs.existsSync(path.join(home, ".noah-agent"))).toBe(false);
  });

  it("throws a classified error when it cannot connect", async () => {
    await expect(cleanupServerRemote({ store: fakeStore({}).store, config }, "owner-1", server)).rejects.toMatchObject({ code: "NO_SSH_KEY" });
  });
});

describe("env", () => {
  it("mirrors runPlan's auth env: no git creds/SESSION_SECRET, subscription token when no API key", () => {
    const saved = { ...process.env };
    try {
      process.env.SESSION_SECRET = "master";
      process.env.GITHUB_TOKEN = "ghp";
      process.env.ANTHROPIC_API_KEY = "";
      const { store, raw } = fakeStore();
      raw.getAppSecret.mockReturnValue("oauth-tok" as never);
      const env = serverAgentBaseEnv(store, config);
      expect(env.SESSION_SECRET).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok");
      const withKey = serverAgentBaseEnv(store, { ...config, anthropicApiKey: "sk" } as AppConfig);
      expect(withKey.CLAUDE_CODE_OAUTH_TOKEN).toBe(process.env.CLAUDE_CODE_OAUTH_TOKEN);
    } finally {
      process.env = saved;
    }
  });

  it("resolves the default model: config pin > admin override > default tier", () => {
    const { store, raw } = fakeStore();
    expect(serverAgentDefaultModel(store, config)).toBe("opus");
    raw.getModelOverride.mockReturnValue("sonnet" as never);
    expect(serverAgentDefaultModel(store, config)).toBe("sonnet");
    expect(serverAgentDefaultModel(store, { ...config, anthropicModel: "claude-x" } as AppConfig)).toBe("claude-x");
  });
});
