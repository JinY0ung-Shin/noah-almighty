import fs from "node:fs/promises";
import ssh2, { type ClientChannel, type ConnectConfig } from "ssh2";
import { knownHostKeyStatus, knownHostsPath, trustedKeyTypes, type KnownHostKeyStatus } from "../sshTrust.js";
import type { AppConfig } from "../types.js";
import { ServerAgentError, isServerAgentError } from "./errors.js";

const { Client } = ssh2;

export interface ServerAgentConnectTarget {
  /** Owner whose known_hosts (sshTrust.knownHostsPath) verifies the host key, fail-closed. */
  ownerUserId: string;
  host: string;
  port: number;
  username: string;
}

export interface ServerAgentCredentials {
  privateKey: string;
  passphrase?: string;
}

export interface ServerAgentConnectOptions {
  /** Default 15 000 ms. */
  keepaliveIntervalMs?: number;
  /** Default 3 (→ a silent partition is detected in ~45 s). */
  keepaliveCountMax?: number;
  /** SSH handshake timeout, default 15 000 ms. */
  readyTimeoutMs?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * One authenticated SSH connection to a registered server. Wraps the ssh2
 * Client so no caller imports ssh2 directly. Every failure surfaces as a
 * ServerAgentError with a classified code.
 */
export interface ServerConnection {
  /**
   * Run a short POSIX `sh` script and collect output. Rejects on timeout (TIMEOUT).
   * The script travels on stdin to REMOTE_SCRIPT_RUNNER, so the account's login
   * shell (bash, tcsh, fish, …) never parses it. With `stdin`, `script` is instead
   * the exec command itself, run VERBATIM by the login shell (it must be
   * login-shell independent on its own, e.g. `sh -s`) and `stdin` is written to it.
   */
  execText(script: string, opts?: { timeoutMs?: number; stdin?: string }): Promise<ExecResult>;
  /** Upload a local file over SFTP to a path relative to the remote $HOME (or absolute), with the given mode. */
  putFile(localPath: string, remotePath: string, mode: number, onProgress?: (sent: number, total: number) => void): Promise<void>;
  /** The underlying ssh2 Client for remoteProcess.ts ONLY (typed loosely on purpose). */
  readonly raw: unknown;
  /** Resolves once the connection is gone (closed, keepalive timeout, error). */
  readonly closed: Promise<void>;
  end(): void;
}

/**
 * The exec command every Noah-authored remote script runs under: sshd hands it
 * to the account's LOGIN shell, so it is one line (csh rejects a newline inside
 * quotes), single-quoted, with no `!` (csh history expansion) — tcsh, fish and
 * bash all pass it to `sh` unchanged. The script itself arrives on stdin and is
 * read to EOF before it runs, so a command inside it that reads stdin sees EOF
 * instead of the rest of the script.
 */
export const REMOTE_SCRIPT_RUNNER = `sh -c 'eval "$(cat)"'`;

const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000;
const DEFAULT_KEEPALIVE_COUNT_MAX = 3;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
// execText is for short probes; a runaway output must not grow without bound.
const EXEC_OUTPUT_CAP = 1024 * 1024;

const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "EHOSTDOWN", "ECONNRESET"]);

// ssh2 algorithm names per known_hosts key type. Restricting the negotiation to
// the TRUSTED types means a key we reject is a genuinely different key, not just
// another of the host's keys that happened to win the negotiation.
const HOST_KEY_ALGORITHMS: Record<string, string[]> = {
  "ssh-ed25519": ["ssh-ed25519"],
  "ecdsa-sha2-nistp256": ["ecdsa-sha2-nistp256"],
  "ecdsa-sha2-nistp384": ["ecdsa-sha2-nistp384"],
  "ecdsa-sha2-nistp521": ["ecdsa-sha2-nistp521"],
  "ssh-rsa": ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
};

/**
 * Map an ssh2 connect/parse failure to a classified code. `hostStatus` is what
 * the host verifier saw (set only when it ran and rejected the key).
 */
export function classifyConnectError(error: unknown, hostStatus: KnownHostKeyStatus | null, restrictedHostKeys = false): ServerAgentError {
  if (isServerAgentError(error)) return error;
  const err = error as { message?: string; code?: string; level?: string };
  const message = String(err?.message ?? error);
  if (hostStatus === "unknown") return new ServerAgentError("HOST_NOT_TRUSTED", "host key not in known_hosts");
  if (hostStatus === "mismatch") return new ServerAgentError("HOST_KEY_MISMATCH", "presented key differs from the trusted one");
  if (/no passphrase given/i.test(message)) return new ServerAgentError("PASSPHRASE_REQUIRED", "encrypted private key");
  if (/bad passphrase|integrity check failed|bad decrypt/i.test(message)) return new ServerAgentError("BAD_PASSPHRASE", "private key decryption failed");
  if (/All configured authentication methods failed/i.test(message)) return new ServerAgentError("AUTH_FAILED", "publickey rejected");
  if (restrictedHostKeys && /no matching host key/i.test(message)) {
    // The server no longer offers any key type the owner trusted.
    return new ServerAgentError("HOST_KEY_MISMATCH", "server offers none of the trusted host key types");
  }
  if (err?.code && UNREACHABLE_CODES.has(err.code)) return new ServerAgentError("UNREACHABLE", err.code);
  if (err?.code === "ETIMEDOUT" || /Timed out while waiting for handshake|Keepalive timeout/i.test(message)) {
    return new ServerAgentError("TIMEOUT", message);
  }
  return new ServerAgentError("UNKNOWN", message.slice(0, 300));
}

export async function openServerConnection(
  config: AppConfig,
  target: ServerAgentConnectTarget,
  credentials: ServerAgentCredentials,
  opts: ServerAgentConnectOptions = {},
): Promise<ServerConnection> {
  // Read FRESH per connection: a trust added/removed in settings applies to the next connect.
  let knownHosts = "";
  try {
    knownHosts = await fs.readFile(knownHostsPath(target.ownerUserId, config), "utf8");
  } catch {
    /* no file → every key is unknown → fail closed */
  }
  const serverHostKey = trustedKeyTypes(knownHosts, target.host, target.port).flatMap((t) => HOST_KEY_ALGORITHMS[t] ?? []);
  let hostStatus: KnownHostKeyStatus | null = null;

  const client = new Client();
  const connectConfig: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    privateKey: credentials.privateKey,
    ...(credentials.passphrase ? { passphrase: credentials.passphrase } : {}),
    readyTimeout: opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    keepaliveInterval: opts.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: opts.keepaliveCountMax ?? DEFAULT_KEEPALIVE_COUNT_MAX,
    // Public key only: never fall back to keyboard-interactive/password prompts.
    tryKeyboard: false,
    hostVerifier: (key: Buffer) => {
      const status = knownHostKeyStatus(knownHosts, target.host, target.port, key);
      if (status === "trusted") return true;
      hostStatus = status;
      return false;
    },
    ...(serverHostKey.length > 0 ? { algorithms: { serverHostKey: serverHostKey as never } } : {}),
  };

  // ssh2 may emit more than one 'error' (e.g. ECONNREFUSED, then "Connection
  // lost before handshake"), and a keepalive timeout after ready is one too: an
  // unhandled 'error' would crash the process, so a no-op listener stays for the
  // connection's life and `closed` reports the end.
  client.on("error", () => {});
  const closed = new Promise<void>((resolve) => {
    client.once("close", () => resolve());
    client.once("end", () => resolve());
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      client.removeListener("ready", onReady);
      reject(classifyConnectError(error, hostStatus, serverHostKey.length > 0));
    };
    const onReady = () => {
      client.removeListener("error", onError);
      resolve();
    };
    client.once("error", onError);
    client.once("ready", onReady);
    try {
      client.connect(connectConfig);
    } catch (error) {
      // A private key that does not parse (missing/bad passphrase) throws synchronously.
      client.removeListener("error", onError);
      client.removeListener("ready", onReady);
      reject(classifyConnectError(error, null));
    }
  }).catch((error: unknown) => {
    try {
      client.end();
    } catch {
      /* already gone */
    }
    throw error;
  });

  const exec = (command: string): Promise<ClientChannel> =>
    new Promise((resolve, reject) => {
      try {
        client.exec(command, (err, stream) => (err ? reject(classifyConnectError(err, null)) : resolve(stream)));
      } catch (error) {
        reject(classifyConnectError(error, null));
      }
    });

  return {
    raw: client,
    closed,
    end: () => {
      try {
        client.end();
      } catch {
        /* already gone */
      }
    },
    async execText(script, execOpts = {}) {
      const verbatim = execOpts.stdin !== undefined;
      const stream = await exec(verbatim ? script : REMOTE_SCRIPT_RUNNER);
      const input = verbatim ? execOpts.stdin! : script.endsWith("\n") ? script : `${script}\n`;
      return new Promise<ExecResult>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let code: number | null = null;
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            stream.signal("KILL");
          } catch {
            /* server may not support signals */
          }
          stream.close();
          reject(new ServerAgentError("TIMEOUT", `command timed out after ${execOpts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS} ms`));
        }, execOpts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS);
        stream.on("data", (chunk: Buffer) => {
          if (stdout.length < EXEC_OUTPUT_CAP) stdout += chunk.toString("utf8");
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < EXEC_OUTPUT_CAP) stderr += chunk.toString("utf8");
        });
        stream.on("error", () => {});
        stream.on("exit", (exitCode: number | null) => {
          code = typeof exitCode === "number" ? exitCode : null;
        });
        stream.on("close", () => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          resolve({ code, stdout, stderr });
        });
        stream.write(input);
        stream.end();
      });
    },
    async putFile(localPath, remotePath, mode, onProgress) {
      await new Promise<void>((resolve, reject) => {
        client.sftp((err, sftp) => {
          if (err) return reject(new ServerAgentError("UPLOAD_FAILED", `sftp: ${err.message}`));
          sftp.fastPut(
            localPath,
            remotePath,
            { mode, ...(onProgress ? { step: (sent: number, _chunk: number, total: number) => onProgress(sent, total) } : {}) },
            (putErr) => {
              sftp.end();
              if (putErr) reject(new ServerAgentError("UPLOAD_FAILED", putErr.message));
              else resolve();
            },
          );
        });
      });
    },
  };
}
