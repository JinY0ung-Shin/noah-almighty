// Runtime configuration and hard limits for the craft-runner daemon.
// Every limit lives here so tests can inject smaller values and the README can point at one place.

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Hard limits (spec §3/§4). Tests pass overrides through `createRunner({ limits })`. */
export const DEFAULT_LIMITS = Object.freeze({
  // Mirroring (sync_in / sync_out)
  maxFileBytes: 200 * MiB,
  maxTotalBytes: 1024 * MiB,
  maxFiles: 2000,
  maxDirs: 2000,
  /** Directory levels any walk opens (mirror, measure, remove); deeper = `too_deep` (Addendum A4). */
  maxDepth: 32,
  maxRejectedListed: 100,
  // MCP relay
  maxResponseLineBytes: 10 * MiB,
  maxRequestLineBytes: 10 * MiB,
  callTimeoutMs: 120_000,
  initTimeoutMs: 30_000,
  spawnWaitMs: 30_000,
  idleMs: 10 * 60_000,
  // Sockets
  maxControlLineBytes: 1 * MiB,
  helloTimeoutMs: 10_000,
  // Session garbage collection (idle sessions without a live token)
  sessionGcMs: 24 * 60 * 60_000,
  gcIntervalMs: 10 * 60_000,
  // Run tokens: absolute lifetime from `grant` (Addendum A3); expired tokens are revoked by the sweeper
  tokenTtlMs: 12 * 60 * 60_000,
  sweepIntervalMs: 60_000,
  // Disk budgets (Addendum A4): one session's work/<sid>/out, and the whole exchange volume
  sessionOutMaxBytes: 2 * GiB,
  exchangeMaxBytes: 20 * GiB,
  /** How long a measurement of the whole exchange is reused before the next walk. */
  exchangeMeasureMs: 30_000,
  /** A session's out/ growing by more than this since the last exchange walk forces a fresh walk. */
  exchangeRemeasureDeltaBytes: 64 * MiB,
  // Tree removal (Addendum A4): iterative; at most `maxDepth` levels are ever open at once
  removeMaxOps: 2_000_000,
  // Killing every process of a uid before it returns to the pool (Addendum A3)
  uidKillRounds: 50,
  uidKillWaitMs: 20,
});

/** Session uid pool (spec §2). */
export const UID_MIN = 20000;
export const UID_MAX = 29999;
/** uid used only by the boot self-test; deliberately OUTSIDE the session pool. */
export const SELFTEST_UID = 19999;
/** Noah's container user (node:22 image `node`). */
export const NOAH_UID = 1000;
export const NOAH_GID = 1000;

/** Minimum CRAFT_CONTROL_SECRET length; shorter secrets keep the control socket closed. */
export const MIN_SECRET_LENGTH = 32;

function intEnv(value, fallback, min, max) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/**
 * Parse the daemon environment. Pure (takes the env object) so tests can call it.
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const secret = env.CRAFT_CONTROL_SECRET ?? "";
  return {
    exchangeDir: env.CRAFT_EXCHANGE_ROOT || "/exchange",
    tmpRoot: env.CRAFT_TMP_ROOT || "/tmp/craft",
    secret,
    secretProblem:
      secret.length === 0
        ? "CRAFT_CONTROL_SECRET is not set"
        : secret.length < MIN_SECRET_LENGTH
          ? `CRAFT_CONTROL_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`
          : null,
    maxProcs: intEnv(env.CRAFT_MAX_PROCS, 3, 1, 32),
    limits: {
      ...DEFAULT_LIMITS,
      callTimeoutMs: intEnv(env.CRAFT_CALL_TIMEOUT_MS, DEFAULT_LIMITS.callTimeoutMs, 1000, 3_600_000),
      idleMs: intEnv(env.CRAFT_IDLE_MS, DEFAULT_LIMITS.idleMs, 1000, 24 * 3_600_000),
      sessionGcMs: intEnv(env.CRAFT_SESSION_GC_HOURS, 24, 1, 24 * 365) * 3_600_000,
      exchangeMaxBytes: intEnv(env.CRAFT_EXCHANGE_MAX_BYTES, DEFAULT_LIMITS.exchangeMaxBytes, 64 * MiB, 2 ** 50),
    },
  };
}
