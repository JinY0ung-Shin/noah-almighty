import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { ClientChannel, Client as SshClient } from "ssh2";
import { SERVER_AGENT_REMOTE_CONFIG_DIR, SERVER_AGENT_REMOTE_DIR } from "../../shared/serverAgents.js";
import type { ServerConnection } from "./connection.js";
import { serverAgentInstanceId } from "./limits.js";

export interface RemoteSpawnOptions {
  /** Unique per remote run; names the pid file `~/.noah-agent/run/<runId>.pid`. */
  runId: string;
  /**
   * This Noah deployment's stable id (store.serverAgentDeploymentId), recorded in
   * the pid file so another deployment sharing the account never sweeps the run.
   */
  deploymentId: string;
  /** This process's instance id (default: serverAgentInstanceId()); the sweep spares other instances' unexpired runs. */
  instanceId?: string;
  /** CLI path relative to the remote $HOME (installer.PreparedServer.cliRemotePath). */
  cliRemotePath: string;
  /** Upper bound on the remote process lifetime (`timeout --kill-after`), seconds. */
  lifetimeSec: number;
  /**
   * Extra remote env, values may reference `$HOME` (double-quoted on the remote).
   * The spawner ALWAYS adds CLAUDE_CONFIG_DIR="$HOME/.claude-noah" and
   * CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1.
   */
  extraRemoteEnv?: Record<string, string>;
  /** Remote stderr chunks (the CLI's diagnostics; the SDK's SpawnedProcess has no stderr). */
  onStderr?: (chunk: string) => void;
}

/**
 * Remote wrapper exit codes (besides the CLI's own): 97 = the env line never
 * arrived on stdin, 98 = `cd` into the workdir failed, 124/137 = the lifetime
 * `timeout` fired (TERM / KILL after the grace), 255 = the channel or the
 * connection closed without the CLI's exit status (transport failure).
 */
export const REMOTE_EXIT_NO_ENV = 97;
export const REMOTE_EXIT_WORKDIR = 98;
export const REMOTE_EXIT_TRANSPORT = 255;

const FORWARDABLE_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "MAX_THINKING_TOKENS",
]);
const FORWARDABLE_ENV_RE = /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEPLOYMENT_ID_RE = /^[A-Za-z0-9]{1,64}$/;

/** `timeout --kill-after` grace, seconds (the remote CLI gets this long after its TERM). */
const KILL_AFTER_SEC = 10;
/** Slack added to a pid file's deadline beyond lifetime + kill-after (remote clock). */
const PID_DEADLINE_MARGIN_SEC = 30;
/**
 * A pid file without a deadline (written by a build before deadlines existed)
 * counts as expired once it is older than the longest possible run: the max task
 * timeout (30 min) + the runner's lifetime grace (120 s) + kill-after, rounded up.
 */
const LEGACY_PID_MAX_AGE_MIN = 40;
/** How long a caller waits for a spawner's remote kill + pid cleanup before ending the connection. */
export const REMOTE_SETTLE_TIMEOUT_MS = 12_000;

/**
 * True for an env key the remote CLI may receive from SpawnOptions.env
 * (auth/model/SDK markers only — never proxies, NODE_OPTIONS, NOAH_*, or shell-exposed secrets).
 */
export function isForwardableRemoteEnv(key: string): boolean {
  return FORWARDABLE_ENV.has(key) || FORWARDABLE_ENV_RE.test(key);
}

/** POSIX single-quote: the value reaches the remote shell byte-for-byte. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Double-quoted with `$` left live (so `$HOME` expands) — for Noah-authored values only. */
function shellQuoteExpandable(value: string): string {
  return `"${value.replace(/["\\`]/g, "\\$&")}"`;
}

/**
 * The script the remote wrapper `eval`s from stdin line 1 (base64): forwarded
 * auth/model env single-quoted, extra env expandable, and the fixed remote
 * values LAST so nothing can override them.
 */
export function buildRemoteEnvScript(env: SpawnOptions["env"], extraRemoteEnv: Record<string, string> = {}): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !isForwardableRemoteEnv(key)) continue;
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  for (const [key, value] of Object.entries(extraRemoteEnv)) {
    if (!ENV_NAME_RE.test(key)) throw new Error(`invalid remote env name: ${key}`);
    lines.push(`export ${key}=${shellQuoteExpandable(value)}`);
  }
  lines.push(`export CLAUDE_CONFIG_DIR="$HOME/${SERVER_AGENT_REMOTE_CONFIG_DIR}"`);
  // A backgrounded Bash task ends the remote turn early (and bypasses the hooks) — P0 finding.
  lines.push("export CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1");
  return lines.join("\n") + "\n";
}

function pidFile(runId: string): string {
  return `"$HOME/${SERVER_AGENT_REMOTE_DIR}/run/${runId}.pid"`;
}

/** Shell test: pid `$p` still runs a Noah-installed CLI (never signal a recycled pid). */
const IS_NOAH_CLI = `tr '\\000' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q "${SERVER_AGENT_REMOTE_DIR}/bin/claude-"`;

/**
 * `desc_of <pid>` prints every descendant pid. Collected BEFORE a TERM: once the
 * CLI dies its Bash commands (their OWN process groups) reparent to init and can
 * no longer be found by walking ppids.
 */
const DESC_OF = `desc_of() {
  ps -eo pid=,ppid= 2>/dev/null | awk -v root="$1" '
    { parent[$1] = $2 }
    END {
      seen[root] = 1; grew = 1
      while (grew) { grew = 0; for (p in parent) if (!(p in seen) && (parent[p] in seen)) { seen[p] = 1; grew = 1 } }
      for (p in seen) if (p != root) printf "%s ", p
    }'
}`;

/**
 * Stop one run by its pid file: TERM the wrapper's process group AND every
 * descendant collected beforehand (the CLI's Bash commands run in their own
 * groups), wait up to ~3 s, KILL the descendants still there, and drop the pid
 * file once the wrapper is gone (a survivor keeps it for the stale-run sweep).
 * sshd's own `signal` request reaches only the session child — when the login
 * shell did not exec, `timeout` (and the CLI) sit in a group it never signals.
 * Runs under REMOTE_SCRIPT_RUNNER (execText), so the login shell never parses it.
 */
export function buildKillScript(runId: string): string {
  const file = pidFile(runId);
  return [
    `f=${file}`,
    '[ -f "$f" ] || exit 0',
    'p=""',
    'read -r p _rest < "$f" 2>/dev/null',
    'case "$p" in ""|*[!0-9]*) exit 0 ;; esac',
    `${IS_NOAH_CLI} || { rm -f "$f"; exit 0; }`,
    DESC_OF,
    'victims=$(desc_of "$p")',
    'kill -TERM -- "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null',
    'for v in $victims; do kill -TERM "$v" 2>/dev/null; done',
    "i=0",
    'while kill -0 "$p" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done',
    'for v in $victims; do kill -KILL "$v" 2>/dev/null; done',
    'kill -0 "$p" 2>/dev/null || rm -f "$f"',
    "exit 0",
  ].join("\n");
}

/**
 * The exec command of a remote run. CONSTANT and login-shell independent: one
 * line, single-quoted, no `!` (csh history expansion), no arguments — sshd
 * hands it to the account's login shell (bash, tcsh, fish, …), which only
 * starts `sh`. Everything else (env, workdir, pid file, the CLI and its
 * arguments) arrives base64-encoded on stdin line 1 and runs under `sh`; the
 * rest of stdin stays the CLI's own (`read` consumes exactly one line).
 */
export const REMOTE_RUN_WRAPPER = `sh -c 'IFS= read -r e || exit ${REMOTE_EXIT_NO_ENV}; eval "$(printf %s "$e" | base64 -d)"'`;

/**
 * The run half of the stdin script (after the env exports): config/run dirs,
 * `cd <workdir> || exit 98`, the pid file `<pid> <deadline> <deploymentId> <instanceId>`
 * (deadline = remote epoch seconds after which the run is certainly over), then
 * `exec timeout … <cli> <args>`. The pid recorded is the shell's `$$`, which
 * `exec timeout` keeps — the process group leader the kill/sweep scripts signal.
 */
export function buildRemoteRunScript(opts: RemoteSpawnOptions, args: readonly string[], cwd: string | undefined): string {
  if (!RUN_ID_RE.test(opts.runId)) throw new Error("invalid runId");
  if (!DEPLOYMENT_ID_RE.test(opts.deploymentId)) throw new Error("invalid deploymentId");
  const instanceId = opts.instanceId ?? serverAgentInstanceId();
  if (!DEPLOYMENT_ID_RE.test(instanceId)) throw new Error("invalid instanceId");
  if (!opts.cliRemotePath || opts.cliRemotePath.startsWith("/") || opts.cliRemotePath.split("/").includes("..")) {
    throw new Error("cliRemotePath must be relative to $HOME");
  }
  const lifetime = Math.max(1, Math.ceil(opts.lifetimeSec));
  return [
    `mkdir -p "$CLAUDE_CONFIG_DIR" "$HOME/${SERVER_AGENT_REMOTE_DIR}/run"`,
    `cd ${cwd ? shellQuote(cwd) : '"$HOME"'} || exit ${REMOTE_EXIT_WORKDIR}`,
    `echo "$$ $(( $(date +%s) + ${lifetime + KILL_AFTER_SEC + PID_DEADLINE_MARGIN_SEC} )) ${opts.deploymentId} ${instanceId}" > ${pidFile(opts.runId)}`,
    `exec timeout --signal=TERM --kill-after=${KILL_AFTER_SEC} ${lifetime} "$HOME/${opts.cliRemotePath}" ${args.map(shellQuote).join(" ")}`,
  ].join("\n") + "\n";
}

/** Stdin line 1 of a remote run: base64 of the env exports followed by the run script. */
export function buildRemoteStdinLine(
  env: SpawnOptions["env"],
  opts: RemoteSpawnOptions,
  args: readonly string[],
  cwd: string | undefined,
): string {
  const script = buildRemoteEnvScript(env, opts.extraRemoteEnv) + buildRemoteRunScript(opts, args, cwd);
  return Buffer.from(script).toString("base64") + "\n";
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

/** createRemoteSpawner's result: the SDK spawn hook plus a way to wait for its remote teardown. */
export type RemoteSpawner = ((options: SpawnOptions) => SpawnedProcess) & {
  /**
   * Resolves once every process this spawner started has reported its exit —
   * which waits for a kill's remote kill script and the pid-file cleanup. Await
   * it (bounded: waitRemoteSettled) BEFORE ending the connection, or the kill
   * never reaches the server.
   */
  settled(): Promise<void>;
};

/** Wait for spawners to settle, at most `timeoutMs` (a hung remote never blocks the caller). */
export async function waitRemoteSettled(spawners: readonly RemoteSpawner[], timeoutMs = REMOTE_SETTLE_TIMEOUT_MS): Promise<void> {
  if (spawners.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(spawners.map((spawner) => spawner.settled())),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}

/**
 * SDK `spawnClaudeCodeProcess` over an ssh2 exec channel: the constant
 * REMOTE_RUN_WRAPPER is the only thing the login shell sees; secrets, the
 * workdir, the CLI path and its arguments ride stdin line 1 (never
 * argv/AcceptEnv) and run under `sh` with `timeout` and a pid file; a channel
 * that closes without the CLI's own exit status reports exit 255.
 *
 * The SDK's local `command` is ignored (the remote CLI path runs instead) and
 * `SpawnOptions.cwd` is the REMOTE workdir. The pid file cannot be removed by
 * the wrapper (it `exec`s), so after a real exit the spawner removes it over
 * the same connection BEFORE reporting 'exit' (the runner ends the connection
 * right after `settled()`); a transport failure leaves it to the next stale-run sweep.
 */
export function createRemoteSpawner(conn: ServerConnection, opts: RemoteSpawnOptions): RemoteSpawner {
  const client = conn.raw as SshClient;
  const teardowns: Promise<void>[] = [];
  const spawn = (spawnOptions: SpawnOptions): SpawnedProcess => {
    const command = REMOTE_RUN_WRAPPER;
    const envLine = buildRemoteStdinLine(spawnOptions.env, opts, spawnOptions.args, spawnOptions.cwd);
    let markSettled: () => void = () => {};
    teardowns.push(
      new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
    );

    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let stream: ClientChannel | null = null;
    let killed = false;
    let exitCode: number | null = null;
    let signalCode: NodeJS.Signals | null = null;
    let finished = false;
    // A kill's remote TERM; 'exit' waits for it so the caller cannot end the
    // connection before the TERM went out.
    let remoteKill: Promise<unknown> | null = null;
    stdin.on("error", () => {});

    const finish = (code: number | null, signal: NodeJS.Signals | null, cleanup: boolean) => {
      if (finished) return;
      finished = true;
      stdout.end();
      const report = () => {
        exitCode = signal ? null : (code ?? REMOTE_EXIT_TRANSPORT);
        signalCode = signal;
        emitter.emit("exit", exitCode, signalCode);
        markSettled();
      };
      if (!cleanup && !remoteKill) return report();
      const cleanupDone = cleanup
        ? conn.execText(`rm -f ${pidFile(opts.runId)}`, { timeoutMs: 5_000 }).catch(() => undefined)
        : null;
      void Promise.all([remoteKill, cleanupDone]).then(report);
    };

    const kill = (signal: NodeJS.Signals = "SIGTERM"): boolean => {
      if (!killed && stream && !finished) {
        remoteKill = conn.execText(buildKillScript(opts.runId), { timeoutMs: 10_000 }).catch(() => undefined);
      }
      killed = true;
      try {
        stream?.signal(String(signal).replace(/^SIG/, ""));
      } catch {
        /* sshd without signal support: closing the channel still EOFs the CLI's stdin */
      }
      try {
        stream?.close();
      } catch {
        /* already closed */
      }
      return true;
    };

    void conn.closed.then(() => finish(REMOTE_EXIT_TRANSPORT, null, false));
    spawnOptions.signal?.addEventListener("abort", () => kill("SIGTERM"), { once: true });

    try {
      client.exec(command, (err, channel) => {
        if (err) {
          emitter.emit("error", err);
          return finish(REMOTE_EXIT_TRANSPORT, null, false);
        }
        stream = channel;
        if (killed || finished) {
          channel.close();
          return;
        }
        channel.on("error", () => {});
        channel.write(envLine);
        stdin.pipe(channel);
        channel.pipe(stdout, { end: false });
        channel.stderr.on("data", (chunk: Buffer) => opts.onStderr?.(chunk.toString("utf8")));
        let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
        channel.on("exit", (code: number | null, signal?: string) => {
          exitInfo = {
            code: typeof code === "number" ? code : null,
            signal: signal ? (`SIG${signal}` as NodeJS.Signals) : null,
          };
        });
        channel.on("close", () => {
          if (!exitInfo || (exitInfo.code === null && exitInfo.signal === null)) {
            // Closed without the CLI's own exit status: a transport failure, never a silent success.
            return finish(REMOTE_EXIT_TRANSPORT, null, false);
          }
          finish(exitInfo.code, exitInfo.signal, true);
        });
      });
    } catch (error) {
      queueMicrotask(() => {
        emitter.emit("error", error instanceof Error ? error : new Error(String(error)));
        finish(REMOTE_EXIT_TRANSPORT, null, false);
      });
    }

    const proc: SpawnedProcess = {
      stdin,
      stdout,
      get killed() {
        return killed;
      },
      get exitCode() {
        return exitCode;
      },
      get signalCode() {
        return signalCode;
      },
      kill,
      on: (event: "exit" | "error", listener: ExitListener | ((error: Error) => void)) => {
        emitter.on(event, listener);
      },
      once: (event: "exit" | "error", listener: ExitListener | ((error: Error) => void)) => {
        emitter.once(event, listener);
      },
      off: (event: "exit" | "error", listener: ExitListener | ((error: Error) => void)) => {
        emitter.off(event, listener);
      },
    } as SpawnedProcess;
    return proc;
  };
  return Object.assign(spawn, { settled: () => Promise.all(teardowns).then(() => undefined) });
}

/** Seconds the sweep waits between TERM and the final KILL of leftover descendants. */
const SWEEP_GRACE_SEC = 10;

/**
 * The sweep script (runs under REMOTE_SCRIPT_RUNNER). Remote state is per
 * ACCOUNT while Noah's ledger is per PROCESS, so a pid file counts as stale only
 * when it is
 *   - past its recorded deadline (that run is over by its own `timeout`), or
 *   - THIS deployment's AND THIS process instance's, and not live in this
 *     process (`activeRunIds` = every live run of the process, whichever row or
 *     owner it belongs to), or
 *   - a legacy file without a deadline older than the longest possible run.
 * Another deployment's — or another process instance's (a rolling-deploy
 * overlap, a replica on the same DB) — unexpired run is never touched. A stale file only gets
 * its process signalled when that pid still runs a `.noah-agent/bin/claude-`
 * command line, so a recycled pid is never signalled — the file is just removed.
 */
export function buildSweepScript(
  activeRunIds: ReadonlySet<string>,
  deploymentId: string,
  graceSec = SWEEP_GRACE_SEC,
  instanceId = serverAgentInstanceId(),
): string {
  if (!DEPLOYMENT_ID_RE.test(deploymentId)) throw new Error("invalid deploymentId");
  if (!DEPLOYMENT_ID_RE.test(instanceId)) throw new Error("invalid instanceId");
  const keep = [...activeRunIds].filter((id) => RUN_ID_RE.test(id)).join(" ");
  return `
dir="$HOME/${SERVER_AGENT_REMOTE_DIR}/run"
[ -d "$dir" ] || exit 0
keep=" ${keep} "
self="${deploymentId}"
inst="${instanceId}"
now=$(date +%s)
victims=""
${DESC_OF}
for f in "$dir"/*.pid; do
  [ -e "$f" ] || continue
  id=$(basename "$f" .pid)
  case "$keep" in *" $id "*) continue ;; esac
  pid=""; d=""; dep=""; di=""
  read -r pid d dep di _rest < "$f" 2>/dev/null
  case "$d" in *[!0-9]*) d="" ;; esac
  stale=""
  if [ -n "$d" ]; then
    if [ "$now" -gt "$d" ]; then stale=1
    elif [ "$dep" = "$self" ] && [ "$di" = "$inst" ]; then stale=1; fi
  elif [ -n "$(find "$f" -mmin +${LEGACY_PID_MAX_AGE_MIN} 2>/dev/null)" ]; then
    stale=1
  fi
  [ -n "$stale" ] || continue
  case "$pid" in ''|*[!0-9]*) rm -f "$f"; echo "SWEPT $id"; continue ;; esac
  p="$pid"
  if ${IS_NOAH_CLI}; then
    victims="$victims $pid $(desc_of "$pid")"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  fi
  rm -f "$f"
  echo "SWEPT $id"
done
if [ -n "$victims" ]; then
  sleep ${Math.max(0, Math.ceil(graceSec))}
  for p in $victims; do kill -KILL "$p" 2>/dev/null; done
fi
exit 0
`;
}

/**
 * Kill leftovers of runs Noah no longer tracks (a FIN-less partition leaves the
 * remote CLI running) — only the stale ones buildSweepScript defines: TERM the
 * run's process group, then after a grace KILL any remaining descendants (Bash
 * commands run in their OWN process groups). Removes their pid files. Returns
 * the swept run ids. Best-effort.
 */
export async function sweepStaleRemoteRuns(
  conn: ServerConnection,
  activeRunIds: ReadonlySet<string>,
  opts: { deploymentId: string; instanceId?: string; graceSec?: number },
): Promise<string[]> {
  const graceSec = opts.graceSec ?? SWEEP_GRACE_SEC;
  try {
    const result = await conn.execText(buildSweepScript(activeRunIds, opts.deploymentId, graceSec, opts.instanceId), {
      timeoutMs: (graceSec + 30) * 1000,
    });
    return result.stdout
      .split("\n")
      .map((line) => /^SWEPT (\S+)$/.exec(line.trim())?.[1])
      .filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}
