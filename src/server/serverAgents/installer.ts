import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  SERVER_AGENT_REMOTE_CONFIG_DIR,
  SERVER_AGENT_REMOTE_DIR,
  type ServerAgent,
  type ServerAgentInstallState,
} from "../../shared/serverAgents.js";
import { webFetchProxyState } from "../agent/webFetchTools.js";
import { CROSS_SESSION_SETTINGS } from "../agent/sessionIsolation.js";
import type { Store } from "../store.js";
import type { AppConfig } from "../types.js";
import { openServerConnection, type ServerConnection } from "./connection.js";
import { serverAgentBaseEnv, serverAgentDefaultModel } from "./env.js";
import { ServerAgentError, isServerAgentError } from "./errors.js";
import { allActiveServerAgentRunIds, tryAcquireServerAgentSlot } from "./limits.js";
import {
  REMOTE_EXIT_WORKDIR,
  createRemoteSpawner,
  shellQuote,
  sweepStaleRemoteRuns,
  waitRemoteSettled,
  type RemoteSpawner,
} from "./remoteProcess.js";

export interface LocalCliInfo {
  /** Bundled CLI version (= the SDK platform package version). */
  version: string;
  path: string;
  /**
   * sha256 of the binary, or "" until the one-time background hash (~240 MB)
   * finishes — localCliInfo() never blocks the event loop on it. Await
   * localCliSha256() where the hash matters (prepareServer does).
   */
  sha256: string;
}

// The remote CLI must be the exact binary the SDK in this build drives (the
// control protocol is version-locked), so we ship the platform package's own
// binary. Servers are x86_64 Linux (glibc) only.
const CLI_PLATFORM_PACKAGE = "@anthropic-ai/claude-agent-sdk-linux-x64";
// Two versions side by side (current + previous) during an upgrade.
const MIN_FREE_KB_FOR_UPLOAD = 600 * 1024;
const BUNDLED_CA_PATH = "/usr/local/share/ca-certificates/extra-proxy-ca.crt";
const REMOTE_BIN_DIR = `${SERVER_AGENT_REMOTE_DIR}/bin`;
const REMOTE_CA_PATH = `${SERVER_AGENT_REMOTE_DIR}/ca.pem`;
const PING_TIMEOUT_MS = 120_000;

let cliLocation: { version: string; path: string } | null = null;
let cliShaCache: string | null = null;
let cliShaInFlight: Promise<string> | null = null;

function resolveCliLocation(): { version: string; path: string } {
  if (cliLocation) return cliLocation;
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve(`${CLI_PLATFORM_PACKAGE}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    cliLocation = { version: String(pkg.version ?? "unknown"), path: path.join(path.dirname(pkgPath), "claude") };
  } catch {
    // Not installed (e.g. an arm64/musl dev box): reported, and prepareServer refuses to push.
    cliLocation = { version: "unknown", path: "" };
  }
  return cliLocation;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** The bundled CLI's sha256, hashed once per process (concurrent callers share one read). */
export function localCliSha256(): Promise<string> {
  if (cliShaCache !== null) return Promise.resolve(cliShaCache);
  const { path: cliPath } = resolveCliLocation();
  if (!cliPath) return Promise.reject(new ServerAgentError("UPLOAD_FAILED", `${CLI_PLATFORM_PACKAGE} is not installed in this build`));
  cliShaInFlight ??= sha256File(cliPath).then(
    (sha) => {
      cliShaCache = sha;
      return sha;
    },
    (error: unknown) => {
      cliShaInFlight = null;
      throw new ServerAgentError("UPLOAD_FAILED", `cannot read the bundled CLI: ${(error as Error).message}`);
    },
  );
  return cliShaInFlight;
}

/** The CLI binary this Noah build ships (cached after the first hash). */
export function localCliInfo(): LocalCliInfo {
  const { version, path: cliPath } = resolveCliLocation();
  if (cliShaCache === null && cliPath) {
    // Warm the hash in the background so the first check does not pay for it.
    localCliSha256().catch(() => undefined);
  }
  return { version, path: cliPath, sha256: cliShaCache ?? "" };
}

/** Test seam: forget the resolved CLI + hash. */
export function resetLocalCliInfoForTests(override?: { version: string; path: string }): void {
  cliLocation = override ?? null;
  cliShaCache = null;
  cliShaInFlight = null;
}

/** The corporate CA bundle to install remotely: NODE_EXTRA_CA_CERTS file, else the image's extra-proxy-ca.crt, else null. */
export function localCaBundle(env: Record<string, string | undefined>): { path: string; sha256: string } | null {
  const candidates = [env.NODE_EXTRA_CA_CERTS?.trim(), BUNDLED_CA_PATH].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    try {
      const body = fs.readFileSync(candidate);
      return { path: candidate, sha256: createHash("sha256").update(body).digest("hex") };
    } catch {
      /* unreadable → next candidate */
    }
  }
  return null;
}

export type PrepareStage = "probe" | "upload" | "verify" | "ca" | "prune";

export interface PreparedServer {
  /** Relative to the remote $HOME, e.g. `.noah-agent/bin/claude-0.3.283`. */
  cliRemotePath: string;
  /** Relative to $HOME when a CA bundle was installed, else null. */
  caRemotePath: string | null;
  version: string;
  /** True when this call uploaded the CLI (first install or version change). */
  pushed: boolean;
}

export interface ServerProbe {
  arch: string;
  missingTools: string[];
  /** Free KB in $HOME, null when df gave nothing parsable. */
  freeKb: number | null;
  homeWritable: boolean;
  execOk: boolean;
  /** sha256 of the installed `claude-<version>`, "" when absent. */
  cliSha: string;
  /** sha256 of the installed CA bundle, "" when absent. */
  caSha: string;
  /** File names in the remote bin dir. */
  binFiles: string[];
}

/** One round trip: arch, base tools, free space, write+exec in $HOME, installed CLI/CA hashes, bin listing. */
export function buildProbeScript(version: string): string {
  return `
d="$HOME/${SERVER_AGENT_REMOTE_DIR}"
echo "arch=$(uname -m)"
for t in sh base64 timeout sha256sum; do command -v "$t" >/dev/null 2>&1 || echo "missing=$t"; done
echo "free=$(df -Pk "$HOME" 2>/dev/null | awk 'NR==2 {print $4}')"
if mkdir -p "$d/bin" "$d/run" 2>/dev/null && [ -w "$d" ]; then
  echo "home=ok"
  p="$d/.exec-probe-$$"
  printf '#!/bin/sh\\necho noah-exec-ok\\n' > "$p" && chmod 700 "$p"
  if [ "$("$p" 2>/dev/null)" = "noah-exec-ok" ]; then echo "exec=ok"; else echo "exec=fail"; fi
  rm -f "$p"
else
  echo "home=fail"
fi
echo "cli=$(sha256sum "$d/bin/claude-${version}" 2>/dev/null | cut -d' ' -f1)"
echo "ca=$(sha256sum "$d/ca.pem" 2>/dev/null | cut -d' ' -f1)"
for f in "$d/bin"/*; do [ -e "$f" ] && echo "bin=$(basename "$f")"; done
exit 0
`;
}

export function parseProbeOutput(stdout: string): ServerProbe {
  const probe: ServerProbe = {
    arch: "",
    missingTools: [],
    freeKb: null,
    homeWritable: false,
    execOk: false,
    cliSha: "",
    caSha: "",
    binFiles: [],
  };
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "arch") probe.arch = value;
    else if (key === "missing" && value) probe.missingTools.push(value);
    else if (key === "free") probe.freeKb = /^\d+$/.test(value) ? Number(value) : null;
    else if (key === "home") probe.homeWritable = value === "ok";
    else if (key === "exec") probe.execOk = value === "ok";
    else if (key === "cli") probe.cliSha = /^[0-9a-f]{64}$/.test(value) ? value : "";
    else if (key === "ca") probe.caSha = /^[0-9a-f]{64}$/.test(value) ? value : "";
    else if (key === "bin" && value) probe.binFiles.push(value);
  }
  return probe;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Which installed `claude-<version>` binaries to delete: the versions OLDER than
 * the current one, except the newest of them. A NEWER version is kept (another
 * Noah deployment sharing the account may be running it), and in-flight `.tmp`
 * uploads are never chosen — stale ones are aged out separately.
 */
export function planPrune(binFiles: readonly string[], currentVersion: string): string[] {
  const older = binFiles
    .map((name) => /^claude-(\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?)$/.exec(name)?.[1])
    .filter((v): v is string => v !== undefined && compareVersions(v, currentVersion) < 0)
    .sort(compareVersions);
  return older.slice(0, -1).map((v) => `claude-${v}`);
}

function stageError(code: ServerAgentError["code"], detail: string): ServerAgentError {
  return new ServerAgentError(code, detail);
}

/**
 * Probe (x86_64, sh/base64/timeout/sha256sum, writable+exec home, ≥600 MB free),
 * install the CLI if the remote sha differs (unique tmp name → sha check → mv),
 * keep current+previous versions only, install the CA bundle if any. Throws
 * ServerAgentError (UNSUPPORTED_ARCH, MISSING_TOOLS, NOEXEC_HOME, DISK_SPACE, UPLOAD_FAILED, …).
 */
export async function prepareServer(
  conn: ServerConnection,
  opts: { env: Record<string, string | undefined>; onProgress?: (stage: PrepareStage, detail?: string) => void },
): Promise<PreparedServer> {
  const progress = opts.onProgress ?? (() => {});
  const cli = resolveCliLocation();
  const cliRemotePath = `${REMOTE_BIN_DIR}/claude-${cli.version}`;

  progress("probe");
  const probeResult = await conn.execText(buildProbeScript(cli.version), { timeoutMs: 120_000 });
  const probe = parseProbeOutput(probeResult.stdout);
  if (probe.arch !== "x86_64") throw stageError("UNSUPPORTED_ARCH", probe.arch || "uname -m gave nothing");
  if (probe.missingTools.length > 0) throw stageError("MISSING_TOOLS", probe.missingTools.join(", "));
  if (!probe.homeWritable) throw stageError("HOME_NOT_WRITABLE", `$HOME/${SERVER_AGENT_REMOTE_DIR} is not writable`);
  if (!probe.execOk) throw stageError("NOEXEC_HOME", "a script under $HOME could not be executed");

  const localSha = await localCliSha256();
  let pushed = false;
  if (probe.cliSha !== localSha) {
    if (probe.freeKb !== null && probe.freeKb < MIN_FREE_KB_FOR_UPLOAD) {
      throw stageError("DISK_SPACE", `${Math.floor(probe.freeKb / 1024)} MB free`);
    }
    const tmp = `${cliRemotePath}.${randomBytes(4).toString("hex")}.tmp`;
    progress("upload", cli.version);
    try {
      await conn.putFile(cli.path, tmp, 0o755, (sent, total) => {
        if (total > 0) progress("upload", `${Math.floor((sent / total) * 100)}%`);
      });
    } catch (error) {
      await conn.execText(`rm -f "$HOME/"${shellQuote(tmp)}`).catch(() => undefined);
      throw isServerAgentError(error) ? error : stageError("UPLOAD_FAILED", (error as Error).message);
    }
    progress("verify");
    // Verify the uploaded bytes BEFORE they replace anything, then rename atomically
    // (a concurrent installer of the same version lands the same bytes).
    const verify = await conn.execText(
      `t="$HOME/"${shellQuote(tmp)}; s=$(sha256sum "$t" | cut -d' ' -f1); ` +
        `if [ "$s" = ${shellQuote(localSha)} ]; then chmod 755 "$t" && mv -f "$t" "$HOME/"${shellQuote(cliRemotePath)} && echo ok; ` +
        `else rm -f "$t"; echo "sha=$s"; fi`,
      { timeoutMs: 120_000 },
    );
    if (verify.stdout.trim() !== "ok") throw stageError("UPLOAD_FAILED", "remote sha256 mismatch after upload");
    const version = await conn.execText(
      `CLAUDE_CONFIG_DIR="$HOME/${SERVER_AGENT_REMOTE_CONFIG_DIR}" "$HOME/"${shellQuote(cliRemotePath)} --version </dev/null`,
      { timeoutMs: 60_000 },
    );
    if (version.code !== 0) {
      // Uploaded and verified, yet it does not start: wrong libc/kernel for the bundled binary.
      // Removed, or its matching sha would skip both the upload AND this smoke next time.
      await conn.execText(`rm -f "$HOME/"${shellQuote(cliRemotePath)}`, { timeoutMs: 15_000 }).catch(() => undefined);
      throw stageError("UNSUPPORTED_ARCH", `CLI does not start: ${(version.stderr || version.stdout).trim().slice(0, 200)}`);
    }
    pushed = true;
  }

  progress("prune");
  const prune = planPrune(probe.binFiles, cli.version);
  const pruneCommand = [
    ...prune.map((name) => `rm -f "$HOME/${REMOTE_BIN_DIR}/"${shellQuote(name)}`),
    // Uploads abandoned by a dropped connection; an hour is far beyond any live upload.
    `find "$HOME/${REMOTE_BIN_DIR}" -maxdepth 1 -name 'claude-*.tmp' -mmin +60 -exec rm -f {} + 2>/dev/null`,
    "true",
  ].join("; ");
  await conn.execText(pruneCommand).catch(() => undefined);

  let caRemotePath: string | null = null;
  const ca = localCaBundle(opts.env);
  if (ca) {
    if (probe.caSha !== ca.sha256) {
      progress("ca");
      const tmp = `${REMOTE_CA_PATH}.${randomBytes(4).toString("hex")}.tmp`;
      await conn.putFile(ca.path, tmp, 0o600);
      const moved = await conn.execText(`mv -f "$HOME/"${shellQuote(tmp)} "$HOME/${REMOTE_CA_PATH}" && echo ok`);
      if (moved.stdout.trim() !== "ok") throw stageError("UPLOAD_FAILED", "CA bundle install failed");
    }
    caRemotePath = REMOTE_CA_PATH;
  }

  return { cliRemotePath, caRemotePath, version: cli.version, pushed };
}

/**
 * Classify a remote model failure from its result/error text (the remote CLI
 * reports API errors as `is_error` results with "API Error" text, not as
 * exceptions). Shared with the runner.
 */
export function classifyRemoteApiFailure(text: string): "TLS_CA" | "MODEL_UNREACHABLE" | "UNKNOWN" {
  if (/SSL certificate|UNABLE_TO_VERIFY|self[- ]signed|unable to get local issuer/i.test(text)) return "TLS_CA";
  if (/Unable to connect|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed out|Connection error/i.test(text)) return "MODEL_UNREACHABLE";
  return "UNKNOWN";
}

/** The remote CA env the runner/ping pass to createRemoteSpawner. */
export function caRemoteEnv(prepared: PreparedServer): Record<string, string> | undefined {
  return prepared.caRemotePath ? { NODE_EXTRA_CA_CERTS: `$HOME/${prepared.caRemotePath}` } : undefined;
}

async function pingModel(
  deps: { store: Store; config: AppConfig },
  conn: ServerConnection,
  server: ServerAgent,
  prepared: PreparedServer,
  runId: string,
): Promise<void> {
  const abortController = new AbortController();
  let spawner: RemoteSpawner | null = null;
  const timer = setTimeout(() => abortController.abort(), PING_TIMEOUT_MS);
  let stderrTail = "";
  let resultText = "";
  let isError = false;
  let sawResult = false;
  try {
    const q = query({
      prompt: "Reply with exactly: OK",
      options: {
        cwd: server.workdir,
        model: serverAgentDefaultModel(deps.store, deps.config),
        env: serverAgentBaseEnv(deps.store, deps.config),
        systemPrompt: "You are a connectivity check. Reply with exactly: OK",
        tools: [],
        settingSources: [],
        settings: { ...CROSS_SESSION_SETTINGS },
        strictMcpConfig: true,
        maxTurns: 1,
        persistSession: false,
        canUseTool: async () => ({ behavior: "deny", message: "No tools in a connectivity check." }),
        abortController,
        spawnClaudeCodeProcess: (spawner = createRemoteSpawner(conn, {
          runId,
          deploymentId: deps.store.serverAgentDeploymentId(),
          cliRemotePath: prepared.cliRemotePath,
          lifetimeSec: Math.ceil(PING_TIMEOUT_MS / 1000) + 60,
          extraRemoteEnv: caRemoteEnv(prepared),
          onStderr: (chunk) => {
            stderrTail = (stderrTail + chunk).slice(-2000);
          },
        })),
      },
    });
    for await (const message of q) {
      if (message.type === "result") {
        sawResult = true;
        isError = message.is_error;
        resultText = message.subtype === "success" ? message.result : (message.errors ?? []).join("\n");
      }
    }
  } catch (error) {
    if (abortController.signal.aborted) throw new ServerAgentError("TIMEOUT", "model ping did not finish in time");
    const message = (error as Error).message ?? String(error);
    if (new RegExp(`code ${REMOTE_EXIT_WORKDIR}\\b`).test(message)) throw new ServerAgentError("WORKDIR", server.workdir);
    const code = classifyRemoteApiFailure(`${message}\n${stderrTail}`);
    throw new ServerAgentError(code, `${message}`.slice(0, 300));
  } finally {
    clearTimeout(timer);
    // The caller ends the connection next: let a timeout's remote kill and the
    // pid-file cleanup land first.
    if (spawner) await waitRemoteSettled([spawner]);
  }
  if (!sawResult) throw new ServerAgentError("UNKNOWN", "remote CLI ended without a result");
  if (isError || /API Error/i.test(resultText)) {
    throw new ServerAgentError(classifyRemoteApiFailure(resultText), resultText.slice(0, 300));
  }
}

/** The connection columns a check/run started against: an install state or session from them must not land on an edited row. */
export function serverAgentTarget(server: ServerAgent): { host: string; port: number; username: string; workdir: string } {
  return { host: server.host, port: server.port, username: server.username, workdir: server.workdir };
}

function serverCredentials(store: Store, ownerUserId: string): { privateKey: string; passphrase?: string } {
  const secrets = store.getUserSecrets(ownerUserId);
  if (!secrets.SSH_PRIVATE_KEY) throw new ServerAgentError("NO_SSH_KEY");
  return { privateKey: secrets.SSH_PRIVATE_KEY, ...(secrets.SSH_PASSPHRASE ? { passphrase: secrets.SSH_PASSPHRASE } : {}) };
}

async function connectToServer(deps: { store: Store; config: AppConfig }, ownerUserId: string, server: ServerAgent): Promise<ServerConnection> {
  if (webFetchProxyState().egressPolicy === "domain-proxy") throw new ServerAgentError("EGRESS_BLOCKED");
  const credentials = serverCredentials(deps.store, ownerUserId);
  return openServerConnection(
    deps.config,
    { ownerUserId, host: server.host, port: server.port, username: server.username },
    credentials,
  );
}

/**
 * The full settings-card check: SSH key present, egress not blocked, connect
 * (host trust enforced), prepareServer, workdir creatable, then a minimal
 * 1-turn model ping through the remote CLI. Persists and returns the install
 * state (store.setServerAgentInstallState). Never throws for classified failures.
 *
 * The check holds a run slot for its whole duration so a concurrent run's
 * stale-pid sweep spares the ping; when the server is at its run cap the check
 * is refused WITHOUT persisting (the stored state stays as it was).
 */
export async function checkServerAgent(
  deps: { store: Store; config: AppConfig },
  ownerUserId: string,
  server: ServerAgent,
): Promise<ServerAgentInstallState> {
  if (!deps.store.isServerAgentsEnabled()) {
    // Defensive (the route refuses first): a check sends the deployment's model
    // credentials to the server. Not persisted — it says nothing about the server.
    return {
      ok: false,
      version: server.installState?.version ?? null,
      error: "ADMIN_DISABLED",
      detail: null,
      checkedAt: new Date().toISOString(),
    };
  }
  const runId = `check-${randomUUID()}`;
  const slot = tryAcquireServerAgentSlot(runId, ownerUserId, server.id);
  if (!slot.ok) {
    return {
      ok: false,
      version: server.installState?.version ?? null,
      error: "BUSY",
      detail:
        slot.reason === "deleting"
          ? "the server is being deleted"
          : `server busy (${slot.reason} run limit reached); try again when the running delegations finish`,
      checkedAt: new Date().toISOString(),
    };
  }
  let conn: ServerConnection | null = null;
  let version: string | null = server.installState?.version ?? null;
  let state: ServerAgentInstallState;
  try {
    conn = await connectToServer(deps, ownerUserId, server);
    await sweepStaleRemoteRuns(conn, allActiveServerAgentRunIds(), { deploymentId: deps.store.serverAgentDeploymentId() });
    const prepared = await prepareServer(conn, { env: serverAgentBaseEnv(deps.store, deps.config) });
    version = prepared.version;
    const workdir = shellQuote(server.workdir);
    const wd = await conn.execText(`mkdir -p ${workdir} && test -w ${workdir} && cd ${workdir}`);
    if (wd.code !== 0) throw new ServerAgentError("WORKDIR", (wd.stderr.trim() || server.workdir).slice(0, 300));
    await pingModel(deps, conn, server, prepared, runId);
    state = { ok: true, version, error: null, detail: null, checkedAt: new Date().toISOString() };
  } catch (error) {
    const classified = isServerAgentError(error) ? error : new ServerAgentError("UNKNOWN", String((error as Error)?.message ?? error).slice(0, 300));
    state = { ok: false, version, error: classified.code, detail: classified.detail || null, checkedAt: new Date().toISOString() };
  } finally {
    conn?.end();
    slot.release();
  }
  // Conditional on the target the check ran against: an owner who re-pointed the
  // row meanwhile must not inherit a verdict about the OLD server.
  deps.store.setServerAgentInstallState(ownerUserId, server.id, state, serverAgentTarget(server));
  return state;
}

export type ServerCleanupResult = { status: "done" } | { status: "skipped"; reason: "shared_account" | "active_runs" };

/**
 * Remove `~/.noah-agent` and `~/.claude-noah` on the server (the settings "서버 삭제" option).
 * Remote state is per ACCOUNT, so the removal is SKIPPED (never forced) when
 * another server row of this deployment — any owner's — targets the same
 * host:port:username, or when a pid file in the run dir is still live or
 * unexpired after the stale-run sweep (another row's, another owner's or
 * another deployment's run). Throws a classified ServerAgentError when the
 * server cannot be reached or the removal fails — callers treat that as
 * non-fatal and report it.
 */
export async function cleanupServerRemote(
  deps: { store: Store; config: AppConfig },
  ownerUserId: string,
  server: ServerAgent,
): Promise<ServerCleanupResult> {
  if (deps.store.countServerAgentsOnAccount(server.host, server.port, server.username, server.id) > 0) {
    return { status: "skipped", reason: "shared_account" };
  }
  const conn = await connectToServer(deps, ownerUserId, server);
  try {
    await sweepStaleRemoteRuns(conn, allActiveServerAgentRunIds(), { deploymentId: deps.store.serverAgentDeploymentId() });
    const result = await conn.execText(
      [
        `for f in "$HOME/${SERVER_AGENT_REMOTE_DIR}/run"/*.pid; do [ -e "$f" ] && { echo ACTIVE; exit 0; }; done`,
        `rm -rf "$HOME/${SERVER_AGENT_REMOTE_DIR}" "$HOME/${SERVER_AGENT_REMOTE_CONFIG_DIR}" && echo REMOVED`,
      ].join("\n"),
    );
    if (result.stdout.trim() === "ACTIVE") return { status: "skipped", reason: "active_runs" };
    if (result.code !== 0 || result.stdout.trim() !== "REMOVED") {
      throw new ServerAgentError("UNKNOWN", `remote cleanup failed: ${result.stderr.trim().slice(0, 200)}`);
    }
    return { status: "done" };
  } finally {
    conn.end();
  }
}
