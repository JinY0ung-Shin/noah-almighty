import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import ssh2 from "ssh2";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fingerprintOfRawKey,
  hostToken,
  inspectHostKey,
  isHostTrusted,
  knownHostKeyStatus,
  knownHostsPath,
  parseKnownHosts,
  trustHostWithFingerprint,
  trustedKeyTypes,
} from "../src/server/sshTrust.js";
import { REMOTE_SCRIPT_RUNNER, openServerConnection, type ServerConnection } from "../src/server/serverAgents/connection.js";
import {
  REMOTE_RUN_WRAPPER,
  buildRemoteEnvScript,
  createRemoteSpawner,
  isForwardableRemoteEnv,
  sweepStaleRemoteRuns,
  waitRemoteSettled,
} from "../src/server/serverAgents/remoteProcess.js";
import { serverAgentInstanceId } from "../src/server/serverAgents/limits.js";
import type { AppConfig } from "../src/server/types.js";

const { Server, utils } = ssh2;

// fetchHostKey shells out to paramiko; report the key in `python.presented` instead.
const python = vi.hoisted(() => ({ presented: "" }));
vi.mock("../src/server/pythonExec.js", () => ({
  runPython: async (_script: string, args: string[]) => {
    const [host, portArg] = args;
    const raw = Buffer.from(python.presented.split(" ")[1], "base64");
    const tok = Number(portArg) === 22 ? host : `[${host}]:${portArg}`;
    const fp = "SHA256:" + (await import("node:crypto")).createHash("sha256").update(raw).digest("base64").replace(/=+$/, "");
    return `${tok} ${python.presented}\n${fp}\n`;
  },
}));

// In-process SSH server whose exec handler runs the command through a LOCAL
// `sh -c` (like sshd running the login shell), so the real remote wrapper,
// env handoff, pid file and sweep scripts execute for real. Every child gets a
// CLEAN env (PATH + a temp HOME) so forwarded names can only come from the
// wrapper's stdin env line. A remote RUN's exec command is the constant
// REMOTE_RUN_WRAPPER, so the fake decodes its stdin line 1 (`scripts`) to find
// the test markers.

type ParsedKey = ReturnType<typeof utils.parseKey> & { getPublicSSH(): Buffer; type: string; verify(d: Buffer, s: Buffer, h?: string): boolean };

function parsed(privateKey: string, passphrase?: string): ParsedKey {
  const key = utils.parseKey(privateKey, passphrase);
  if (key instanceof Error) throw key;
  return (Array.isArray(key) ? key[0] : key) as ParsedKey;
}

// ssh2's OWN generator emits an OpenSSH ed25519 key its parser rejects as
// "Malformed OpenSSH private key" ~0.4% of the time (measured 12/3000; keys from
// ssh-keygen and from Noah's python-cryptography generator parse 0/2300 failures),
// which made this file flaky. Regenerate until the key round-trips.
function keyPair(type: "ed25519" | "rsa", opts: Record<string, unknown> = {}, passphrase?: string) {
  for (;;) {
    const pair = utils.generateKeyPairSync(type as "ed25519", opts as never);
    if (!(utils.parseKey(pair.private, passphrase) instanceof Error)) return pair;
  }
}

const ed25519Host = keyPair("ed25519");
const rsaHost = keyPair("rsa", { bits: 2048 });
const otherHost = keyPair("ed25519");
const clientKey = keyPair("ed25519");
const strangerKey = keyPair("ed25519");
const lockedKey = keyPair("ed25519", { passphrase: "s3cret-pass", cipher: "aes256-ctr", rounds: 4 }, "s3cret-pass");
const lockedPub = parsed(lockedKey.private, "s3cret-pass");
const allowedClientKeys = [parsed(clientKey.private), lockedPub];

let root: string;
let home: string;
let server: InstanceType<typeof Server>;
let port: number;
const commands: string[] = [];
const scripts: string[] = [];
const children = new Set<ChildProcess>();
const DEPLOYMENT = "dep0self";
const config = () => ({ dataDir: path.join(root, "data") }) as AppConfig;
const OWNER = "owner-1";

function hostLine(privateKey: string): string {
  const pub = parsed(privateKey);
  return `${hostToken("127.0.0.1", port)} ${pub.type} ${pub.getPublicSSH().toString("base64")}`;
}

function writeKnownHosts(lines: string[]): void {
  const file = knownHostsPath(OWNER, config());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

function connect(privateKey = clientKey.private, passphrase?: string): Promise<ServerConnection> {
  return openServerConnection(
    config(),
    { ownerUserId: OWNER, host: "127.0.0.1", port, username: "svc" },
    { privateKey, ...(passphrase ? { passphrase } : {}) },
    { readyTimeoutMs: 5000 },
  );
}

function isAlive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const FAKE_CLI = `#!/bin/sh
# Fake remote CLI: reports what it can see, then behaves per its first arg.
mode="$1"
echo "args=$*"
echo "pwd=$(pwd)"
for n in CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_DEFAULT_OPUS_MODEL HTTPS_PROXY NODE_OPTIONS NOAH_EGRESS_POLICY MY_SHELL_SECRET SESSION_SECRET CLAUDE_CONFIG_DIR CLAUDE_CODE_DISABLE_BACKGROUND_TASKS NODE_EXTRA_CA_CERTS; do
  eval "v=\\\${$n-__unset__}"
  echo "env.$n=$v"
done
case "$mode" in
  sleep) sleep 30 ;;
  orphans)
    setsid sh -c 'echo $$ >> "$HOME/pids"; exec sleep 300' &
    sh -c 'echo $$ >> "$HOME/pids"; exec sleep 300' &
    sleep 300
    ;;
  *) IFS= read -r line; echo "stdin=$line"; exit 7 ;;
esac
`;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "noah-sa-transport-"));
  home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".noah-agent", "bin"), { recursive: true });
  fs.mkdirSync(path.join(home, "work"), { recursive: true });
  fs.writeFileSync(path.join(home, ".noah-agent", "bin", "claude-test"), FAKE_CLI, { mode: 0o755 });

  server = new Server({ hostKeys: [ed25519Host.private, rsaHost.private] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
      const match = allowedClientKeys.find((k) => k.type === ctx.key.algo && k.getPublicSSH().equals(ctx.key.data));
      if (!match) return ctx.reject();
      if (ctx.signature && !match.verify(ctx.blob!, ctx.signature, ctx.hashAlgo)) return ctx.reject();
      ctx.accept();
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        let child: ChildProcess | null = null;
        session.on("signal", (accept, _reject, info) => {
          accept?.();
          if (child?.pid) {
            try {
              process.kill(-child.pid, `SIG${info.name}` as NodeJS.Signals);
            } catch {
              /* gone */
            }
          }
        });
        session.on("exec", (accept, _reject, info) => {
          commands.push(info.command);
          const stream = accept();
          if (info.command !== REMOTE_RUN_WRAPPER) return run(stream, Buffer.alloc(0));
          // A remote run: peek at stdin line 1 (the base64 script) before starting it.
          let head = Buffer.alloc(0);
          const onData = (chunk: Buffer) => {
            head = Buffer.concat([head, chunk]);
            const nl = head.indexOf(10);
            if (nl < 0) return;
            stream.removeListener("data", onData);
            stream.pause();
            const script = Buffer.from(head.subarray(0, nl).toString("utf8"), "base64").toString("utf8");
            scripts.push(script);
            if (script.includes("__ABRUPT_CONNECTION__")) {
              stream.write("partial\n");
              setTimeout(() => client.end(), 50);
              return;
            }
            if (script.includes("__CLOSE_NO_STATUS__")) {
              stream.write("partial\n");
              setTimeout(() => stream.close(), 50);
              return;
            }
            run(stream, head);
          };
          stream.on("data", onData);
        });
        function run(stream: ssh2.ServerChannel, alreadyRead: Buffer) {
          const info = { command: commands.at(-1)! };
          // detached → its own session, like sshd's setsid() for the session child.
          const proc = spawn("sh", ["-c", info.command], {
            cwd: home,
            env: { PATH: process.env.PATH, HOME: home },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          });
          child = proc;
          children.add(proc);
          if (alreadyRead.length > 0) proc.stdin!.write(alreadyRead);
          stream.pipe(proc.stdin!).on("error", () => {});
          stream.resume();
          proc.stdin!.on("error", () => {});
          proc.stdout!.pipe(stream, { end: false });
          proc.stderr!.pipe(stream.stderr, { end: false });
          stream.on("error", () => {});
          proc.on("exit", (code, signal) => {
            children.delete(proc);
            try {
              if (signal) stream.exit(signal.replace(/^SIG/, ""), false, "");
              else stream.exit(code ?? 0);
              stream.end();
            } catch {
              /* channel already closed (the remote CLI outlived its connection) */
            }
          });
        }
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<number, number>();
          let next = 1;
          const resolveRemote = (p: string) => (path.isAbsolute(p) ? p : path.join(home, p));
          const STATUS = utils.sftp.STATUS_CODE;
          sftp.on("OPEN", (reqid, filename, flags) => {
            try {
              const fd = fs.openSync(resolveRemote(filename), utils.sftp.flagsToString(flags) ?? "w");
              const id = next++;
              handles.set(id, fd);
              const handle = Buffer.alloc(4);
              handle.writeUInt32BE(id);
              sftp.handle(reqid, handle);
            } catch {
              sftp.status(reqid, STATUS.FAILURE);
            }
          });
          sftp.on("WRITE", (reqid, handle, offset, data) => {
            fs.writeSync(handles.get(handle.readUInt32BE())!, data, 0, data.length, offset);
            sftp.status(reqid, STATUS.OK);
          });
          sftp.on("FSETSTAT", (reqid, handle, attrs) => {
            if (attrs.mode !== undefined) fs.fchmodSync(handles.get(handle.readUInt32BE())!, attrs.mode);
            sftp.status(reqid, STATUS.OK);
          });
          sftp.on("CLOSE", (reqid, handle) => {
            const id = handle.readUInt32BE();
            fs.closeSync(handles.get(id)!);
            handles.delete(id);
            sftp.status(reqid, STATUS.OK);
          });
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  for (const child of children) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(path.join(config().dataDir, "ssh"), { recursive: true, force: true });
});

describe("sshTrust server-agent exports", () => {
  it("fingerprints a raw key in hex-ssh's SHA256 form and classifies known_hosts status", () => {
    const pub = parsed(ed25519Host.private).getPublicSSH();
    const fp = fingerprintOfRawKey(pub);
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    const body = `[10.0.0.1]:2222 ssh-ed25519 ${pub.toString("base64")}\n`;
    expect(parseKnownHosts(body)[0].fingerprint).toBe(fp);
    expect(knownHostKeyStatus(body, "10.0.0.1", 2222, pub)).toBe("trusted");
    expect(knownHostKeyStatus(body, "10.0.0.1", 2222, parsed(otherHost.private).getPublicSSH())).toBe("mismatch");
    expect(knownHostKeyStatus(body, "10.0.0.1", 22, pub)).toBe("unknown");
    expect(trustedKeyTypes(body, "10.0.0.1", 2222)).toEqual(["ssh-ed25519"]);
    expect(hostToken("h", 22)).toBe("h");
  });

  it("isHostTrusted reads the owner's known_hosts per host:port", async () => {
    expect(await isHostTrusted(OWNER, config(), "127.0.0.1", port)).toBe(false);
    writeKnownHosts([hostLine(ed25519Host.private)]);
    expect(await isHostTrusted(OWNER, config(), "127.0.0.1", port)).toBe(true);
    expect(await isHostTrusted(OWNER, config(), "127.0.0.1", port + 1)).toBe(false);
  });
});

describe("host-key trust flow (settings card)", () => {
  const presented = (privateKey: string) => {
    const pub = parsed(privateKey);
    return `${pub.type} ${pub.getPublicSSH().toString("base64")}`;
  };

  it("shows the live key, trusts only the fingerprint that was shown, and the transport then connects", async () => {
    python.presented = presented(ed25519Host.private);
    const shown = await inspectHostKey(OWNER, config(), "127.0.0.1", port);
    expect(shown).toMatchObject({ keyType: "ssh-ed25519", trusted: false, mismatch: false });
    expect(shown.fingerprint).toBe(fingerprintOfRawKey(parsed(ed25519Host.private).getPublicSSH()));

    // The key changed between "show" and "trust": refused, nothing written.
    python.presented = presented(otherHost.private);
    await expect(trustHostWithFingerprint(OWNER, config(), "127.0.0.1", port, shown.fingerprint)).rejects.toMatchObject({
      code: "HOST_KEY_MISMATCH",
    });
    expect(await isHostTrusted(OWNER, config(), "127.0.0.1", port)).toBe(false);

    python.presented = presented(ed25519Host.private);
    const trusted = await trustHostWithFingerprint(OWNER, config(), "127.0.0.1", port, shown.fingerprint);
    expect(trusted).toMatchObject({ changed: true, entry: { host: `[127.0.0.1]:${port}`, fingerprint: shown.fingerprint } });
    expect(await inspectHostKey(OWNER, config(), "127.0.0.1", port)).toMatchObject({ trusted: true, mismatch: false });
    const conn = await connect();
    conn.end();

    python.presented = presented(otherHost.private);
    expect(await inspectHostKey(OWNER, config(), "127.0.0.1", port)).toMatchObject({ trusted: false, mismatch: true });
  });
});

describe("openServerConnection", () => {
  it("connects when the host key is trusted, runs commands, and resolves closed on end", async () => {
    writeKnownHosts([hostLine(ed25519Host.private)]);
    const conn = await connect();
    const out = await conn.execText("echo hi; echo err >&2; exit 3");
    expect(out).toEqual({ code: 3, stdout: "hi\n", stderr: "err\n" });
    // The script rides stdin to the constant runner — the login shell never parses it —
    // and is read to EOF first, so a command in it that reads stdin cannot eat the rest.
    expect(commands.at(-1)).toBe(REMOTE_SCRIPT_RUNNER);
    expect((await conn.execText("cat\necho after-cat")).stdout).toBe("after-cat\n");
    const piped = await conn.execText("cat", { stdin: "from-stdin" });
    expect(piped.stdout).toBe("from-stdin");
    expect(commands.at(-1)).toBe("cat");
    await expect(conn.execText("sleep 5", { timeoutMs: 200 })).rejects.toMatchObject({ code: "TIMEOUT" });
    conn.end();
    await conn.closed;
  });

  it("refuses an unknown host (HOST_NOT_TRUSTED) and a different key (HOST_KEY_MISMATCH)", async () => {
    await expect(connect()).rejects.toMatchObject({ code: "HOST_NOT_TRUSTED" });
    writeKnownHosts([hostLine(otherHost.private)]);
    await expect(connect()).rejects.toMatchObject({ code: "HOST_KEY_MISMATCH" });
  });

  it("negotiates the TRUSTED key type, so trusting the host's RSA key alone still connects", async () => {
    writeKnownHosts([hostLine(rsaHost.private)]);
    const conn = await connect();
    conn.end();
  });

  it("classifies auth and passphrase failures", async () => {
    writeKnownHosts([hostLine(ed25519Host.private)]);
    await expect(connect(strangerKey.private)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(connect(lockedKey.private)).rejects.toMatchObject({ code: "PASSPHRASE_REQUIRED" });
    await expect(connect(lockedKey.private, "wrong")).rejects.toMatchObject({ code: "BAD_PASSPHRASE" });
    const conn = await connect(lockedKey.private, "s3cret-pass");
    conn.end();
  });

  it("classifies a refused port as UNREACHABLE", async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const freePort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    await expect(
      openServerConnection(config(), { ownerUserId: OWNER, host: "127.0.0.1", port: freePort, username: "svc" }, { privateKey: clientKey.private }),
    ).rejects.toMatchObject({ code: "UNREACHABLE" });
  });

  it("uploads over SFTP with the requested mode and progress", async () => {
    writeKnownHosts([hostLine(ed25519Host.private)]);
    const conn = await connect();
    const local = path.join(root, "payload.bin");
    fs.writeFileSync(local, Buffer.alloc(100_000, 7));
    const progress: number[] = [];
    await conn.putFile(local, ".noah-agent/payload.tmp", 0o750, (sent) => progress.push(sent));
    const remote = path.join(home, ".noah-agent", "payload.tmp");
    expect(fs.readFileSync(remote).equals(fs.readFileSync(local))).toBe(true);
    expect(fs.statSync(remote).mode & 0o777).toBe(0o750);
    expect(progress.at(-1)).toBe(100_000);
    conn.end();
  });
});

describe("isForwardableRemoteEnv", () => {
  it.each([
    ["ANTHROPIC_API_KEY", true],
    ["ANTHROPIC_AUTH_TOKEN", true],
    ["ANTHROPIC_BASE_URL", true],
    ["ANTHROPIC_MODEL", true],
    ["ANTHROPIC_SMALL_FAST_MODEL", true],
    ["ANTHROPIC_CUSTOM_HEADERS", true],
    ["ANTHROPIC_DEFAULT_OPUS_MODEL", true],
    ["ANTHROPIC_DEFAULT_HAIKU_4_5_MODEL", true],
    ["CLAUDE_CODE_OAUTH_TOKEN", true],
    ["CLAUDE_CODE_ENTRYPOINT", true],
    ["CLAUDE_AGENT_SDK_VERSION", true],
    ["CLAUDE_CODE_SUBAGENT_MODEL", true],
    ["MAX_THINKING_TOKENS", true],
    ["ANTHROPIC_DEFAULT_MODEL", false],
    ["CLAUDE_CONFIG_DIR", false],
    ["CLAUDE_CODE_EXECPATH", false],
    ["CLAUDE_CODE_USE_BEDROCK", false],
    ["NODE_EXTRA_CA_CERTS", false],
    ["NODE_OPTIONS", false],
    ["HTTPS_PROXY", false],
    ["https_proxy", false],
    ["NOAH_EGRESS_POLICY", false],
    ["SESSION_SECRET", false],
    ["GITHUB_TOKEN", false],
    ["SSH_PRIVATE_KEY", false],
    ["PATH", false],
    ["HOME", false],
  ])("%s → %s", (key, expected) => {
    expect(isForwardableRemoteEnv(key)).toBe(expected);
  });

  it("puts the fixed remote values last so extra env cannot override them", () => {
    const script = buildRemoteEnvScript({ CLAUDE_CODE_OAUTH_TOKEN: "t'ok" }, { CLAUDE_CONFIG_DIR: "/tmp/evil", X_A: 'a"$HOME`b' });
    const lines = script.trim().split("\n");
    expect(lines[0]).toBe(`export CLAUDE_CODE_OAUTH_TOKEN='t'\\''ok'`);
    expect(lines[2]).toBe('export X_A="a\\"$HOME\\`b"');
    expect(lines.at(-2)).toBe('export CLAUDE_CONFIG_DIR="$HOME/.claude-noah"');
    expect(lines.at(-1)).toBe("export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1");
    expect(() => buildRemoteEnvScript({}, { "BAD-NAME": "x" })).toThrow();
  });
});

describe("createRemoteSpawner", () => {
  const TOKEN = "oauth-token-VALUE-123";
  function spawnFake(
    conn: ServerConnection,
    args: string[],
    runId: string,
    extra: Partial<SpawnOptions> = {},
  ): { proc: SpawnedProcess; output: () => string; exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> } {
    const spawner = createRemoteSpawner(conn, {
      runId,
      deploymentId: DEPLOYMENT,
      cliRemotePath: ".noah-agent/bin/claude-test",
      lifetimeSec: 60,
      extraRemoteEnv: { NODE_EXTRA_CA_CERTS: "$HOME/.noah-agent/ca.pem" },
    });
    const proc = spawner({
      command: "/local/path/never/used",
      args,
      cwd: path.join(home, "work"),
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
        ANTHROPIC_BASE_URL: "https://gateway.example",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5",
        HTTPS_PROXY: "http://proxy:3128",
        NODE_OPTIONS: "--require /evil.js",
        NOAH_EGRESS_POLICY: "open",
        MY_SHELL_SECRET: "shell-secret",
        SESSION_SECRET: "master",
        CLAUDE_CONFIG_DIR: "/local/sessions",
      },
      signal: new AbortController().signal,
      ...extra,
    });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.on("exit", (code, signal) => resolve({ code, signal })),
    );
    return { proc, output: () => out, exit };
  }

  it("hands the env over stdin (never argv), forwards only allowlisted names, and reports the CLI's exit", async () => {
    writeKnownHosts([hostLine(ed25519Host.private)]);
    const conn = await connect();
    const { proc, output, exit } = spawnFake(conn, ["normal", "--flag", "it's quoted"], "run-env");
    proc.stdin.write('{"type":"user"}\n');
    proc.stdin.end();
    expect(await exit).toEqual({ code: 7, signal: null });
    expect(proc.exitCode).toBe(7);
    const out = output();
    expect(out).toContain("args=normal --flag it's quoted");
    expect(out).toContain(`pwd=${path.join(home, "work")}`);
    expect(out).toContain(`env.CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`);
    expect(out).toContain("env.ANTHROPIC_BASE_URL=https://gateway.example");
    expect(out).toContain("env.ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5");
    for (const dropped of ["HTTPS_PROXY", "NODE_OPTIONS", "NOAH_EGRESS_POLICY", "MY_SHELL_SECRET", "SESSION_SECRET"]) {
      expect(out).toContain(`env.${dropped}=__unset__`);
    }
    expect(out).toContain(`env.CLAUDE_CONFIG_DIR=${home}/.claude-noah`);
    expect(out).toContain("env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1");
    expect(out).toContain(`env.NODE_EXTRA_CA_CERTS=${home}/.noah-agent/ca.pem`);
    expect(out).toContain('stdin={"type":"user"}');
    // The login shell sees ONLY the constant wrapper: no secret, no argument, no `!`.
    expect(commands).toContain(REMOTE_RUN_WRAPPER);
    expect(commands.some((c) => c.includes(TOKEN) || c.includes("it's quoted"))).toBe(false);
    expect(REMOTE_RUN_WRAPPER).not.toMatch(/[!\n]/);
    const script = scripts.find((c) => c.includes("run-env"))!;
    expect(script).toContain(`export CLAUDE_CODE_OAUTH_TOKEN='${TOKEN}'`);
    expect(script).not.toContain("/local/path/never/used");
    expect(script).toContain("timeout --signal=TERM --kill-after=10 60");
    expect(fs.existsSync(path.join(home, ".claude-noah"))).toBe(true);
    // A real exit removes the pid file before 'exit' is reported.
    expect(fs.existsSync(path.join(home, ".noah-agent", "run", "run-env.pid"))).toBe(false);
    conn.end();
  });

  it("exits 98 when the workdir cannot be entered", async () => {
    writeKnownHosts([hostLine(ed25519Host.private)]);
    const conn = await connect();
    const { proc, exit } = spawnFake(conn, ["normal"], "run-nowd", { cwd: path.join(home, "missing-dir") });
    proc.stdin.end();
    expect((await exit).code).toBe(98);
    conn.end();
  });

  it("reports exit 255 when the channel closes without an exit status", async () => {
    writeKnownHosts([hostLine(ed25519Host.private)]);
    const conn = await connect();
    const { output, exit } = spawnFake(conn, ["__CLOSE_NO_STATUS__"], "run-nostatus");
    expect(await exit).toEqual({ code: 255, signal: null });
    expect(output()).toBe("partial\n");
    conn.end();
  });

  it("reports exit 255 when the connection drops mid-run", async () => {
    writeKnownHosts([hostLine(ed25519Host.private)]);
    const conn = await connect();
    const { exit } = spawnFake(conn, ["__ABRUPT_CONNECTION__"], "run-abrupt");
    expect(await exit).toEqual({ code: 255, signal: null });
    await conn.closed;
  });

  it("kill() and the SDK abort signal stop the remote CLI", async () => {
    writeKnownHosts([hostLine(ed25519Host.private)]);
    const conn = await connect();
    const ac = new AbortController();
    const { proc, exit } = spawnFake(conn, ["sleep"], "run-kill", { signal: ac.signal });
    const pidFile = path.join(home, ".noah-agent", "run", "run-kill.pid");
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
    const [pidText, deadline, deployment, instance] = fs.readFileSync(pidFile, "utf8").trim().split(" ");
    expect(instance).toBe(serverAgentInstanceId());
    const pid = Number(pidText);
    // `<pid> <deadline> <deployment>`: deadline = remote now + lifetime + kill-after + margin.
    expect(Number(deadline) - Date.now() / 1000).toBeGreaterThan(90);
    expect(Number(deadline) - Date.now() / 1000).toBeLessThan(110);
    expect(deployment).toBe(DEPLOYMENT);
    ac.abort();
    const result = await exit;
    expect(proc.killed).toBe(true);
    expect(result.code === null ? result.signal : result.code).toBeTruthy();
    await waitFor(() => !isAlive(pid));
    // The kill TERMed the run's group by its pid file and dropped the file once it was gone.
    expect(fs.existsSync(pidFile)).toBe(false);
    conn.end();
  });

  it("an abort also kills the CLI's escaped Bash children, and settled() resolves only after that teardown", async () => {
    writeKnownHosts([hostLine(ed25519Host.private)]);
    fs.rmSync(path.join(home, "pids"), { force: true });
    const conn = await connect();
    const ac = new AbortController();
    const spawner = createRemoteSpawner(conn, { runId: "run-tree", deploymentId: DEPLOYMENT, cliRemotePath: ".noah-agent/bin/claude-test", lifetimeSec: 600 });
    const proc = spawner({ command: "x", args: ["orphans"], cwd: home, env: {}, signal: ac.signal });
    proc.on("exit", () => {});
    const pidFile = path.join(home, ".noah-agent", "run", "run-tree.pid");
    await waitFor(() => fs.existsSync(path.join(home, "pids")) && fs.readFileSync(path.join(home, "pids"), "utf8").trim().split("\n").length === 2);
    const wrapperPid = Number(fs.readFileSync(pidFile, "utf8").split(" ")[0]);
    const orphanPids = fs.readFileSync(path.join(home, "pids"), "utf8").trim().split("\n").map(Number);
    ac.abort();
    // The runner's order: wait for the teardown, THEN end the connection.
    await waitRemoteSettled([spawner]);
    conn.end();
    expect(fs.existsSync(pidFile)).toBe(false);
    await waitFor(() => !isAlive(wrapperPid));
    for (const pid of orphanPids) await waitFor(() => !isAlive(pid));
  }, 20_000);
});

describe("sweepStaleRemoteRuns", () => {
  it("TERMs a stale run's group, KILLs descendants that escaped into their own groups, and spares active runs", async () => {
    writeKnownHosts([hostLine(ed25519Host.private)]);
    const runDir = path.join(home, ".noah-agent", "run");
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(path.join(home, "pids"), { force: true });
    const first = await connect();
    const spawner = createRemoteSpawner(first, { runId: "run-stale", deploymentId: DEPLOYMENT, cliRemotePath: ".noah-agent/bin/claude-test", lifetimeSec: 600 });
    const proc = spawner({ command: "x", args: ["orphans"], cwd: home, env: {}, signal: new AbortController().signal });
    proc.on("exit", () => {});
    await waitFor(() => fs.existsSync(path.join(home, "pids")) && fs.readFileSync(path.join(home, "pids"), "utf8").trim().split("\n").length === 2);
    const wrapperPid = Number(fs.readFileSync(path.join(runDir, "run-stale.pid"), "utf8").split(" ")[0]);
    const orphanPids = fs.readFileSync(path.join(home, "pids"), "utf8").trim().split("\n").map(Number);
    // A FIN-less partition: Noah forgets the run, the remote side keeps running.
    first.end();
    await first.closed;
    expect(isAlive(wrapperPid)).toBe(true);

    // An active run's pid file (live in THIS process, whichever row it belongs to),
    // a garbage file, one pointing at an unrelated process, another deployment's
    // runs (unexpired / expired) and legacy deadline-less files (fresh / old).
    const now = Math.floor(Date.now() / 1000);
    const bystander = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    const old = new Date(Date.now() - 2 * 3600_000);
    const me = serverAgentInstanceId();
    fs.writeFileSync(path.join(runDir, "run-active.pid"), `${bystander.pid} ${now + 3600} ${DEPLOYMENT} ${me}\n`);
    fs.writeFileSync(path.join(runDir, "run-garbage.pid"), "not-a-pid\n");
    fs.utimesSync(path.join(runDir, "run-garbage.pid"), old, old);
    fs.writeFileSync(path.join(runDir, "run-recycled.pid"), `${bystander.pid} ${now + 3600} ${DEPLOYMENT} ${me}\n`);
    // Another PROCESS on the same deployment/DB (rolling-deploy overlap): spared until its deadline.
    fs.writeFileSync(path.join(runDir, "run-other-instance.pid"), `${bystander.pid} ${now + 3600} ${DEPLOYMENT} otherinst\n`);
    fs.writeFileSync(path.join(runDir, "run-other-instance-expired.pid"), `${bystander.pid} ${now - 60} ${DEPLOYMENT} otherinst\n`);
    fs.writeFileSync(path.join(runDir, "run-foreign.pid"), `${bystander.pid} ${now + 3600} otherdep\n`);
    fs.writeFileSync(path.join(runDir, "run-foreign-expired.pid"), `${bystander.pid} ${now - 60} otherdep\n`);
    fs.writeFileSync(path.join(runDir, "run-legacy-fresh.pid"), `${bystander.pid}\n`);
    fs.writeFileSync(path.join(runDir, "run-legacy-old.pid"), `${bystander.pid}\n`);
    fs.utimesSync(path.join(runDir, "run-legacy-old.pid"), old, old);

    const second = await connect();
    const swept = await sweepStaleRemoteRuns(second, new Set(["run-active"]), { deploymentId: DEPLOYMENT, graceSec: 1 });
    expect(swept.sort()).toEqual(["run-foreign-expired", "run-garbage", "run-legacy-old", "run-other-instance-expired", "run-recycled", "run-stale"]);
    expect(fs.readdirSync(runDir).sort()).toEqual(["run-active.pid", "run-foreign.pid", "run-legacy-fresh.pid", "run-other-instance.pid"]);
    await waitFor(() => !isAlive(wrapperPid));
    for (const pid of orphanPids) await waitFor(() => !isAlive(pid));
    // The recycled pid ran no .noah-agent CLI, so it was never signalled.
    expect(isAlive(bystander.pid!)).toBe(true);
    bystander.kill("SIGKILL");
    second.end();
  }, 20_000);

  it("returns [] when there is no run dir or the command fails", async () => {
    const fake = { execText: async () => ({ code: 0, stdout: "", stderr: "" }) } as unknown as ServerConnection;
    expect(await sweepStaleRemoteRuns(fake, new Set(), { deploymentId: DEPLOYMENT })).toEqual([]);
    const failing = { execText: async () => Promise.reject(new Error("gone")) } as unknown as ServerConnection;
    expect(await sweepStaleRemoteRuns(failing, new Set(), { deploymentId: DEPLOYMENT })).toEqual([]);
  });
});
