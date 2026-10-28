/**
 * Client for the craft-runner's CONTROL socket (Craft apps, admin-only beta).
 *
 * The runner is a separate, network-less container that runs the ArtCraft app
 * binaries (PhotoCraft, …) as per-session uids. Noah talks to it over two unix
 * sockets on the shared `craft-exchange` volume (`CRAFT_EXCHANGE_DIR`):
 *  - `sock/control.sock` — THIS module: JSON lines, a mutual HMAC
 *    challenge/response over CRAFT_CONTROL_SECRET first (the secret never
 *    crosses the socket), then one `{id, op, …}` request per connection
 *    (health / open / sync_in / grant / revoke / revoke_all / sync_out / purge);
 *  - `sock/mcp.sock` — the per-app stdio relay (`scripts/craft-mcp-relay.mjs`)
 *    attaches there with a MAC keyed by the per-RUN token `grant` issued.
 *
 * Health is probed at boot and MEMOIZED (deckRender.ts pattern): readers get the
 * last probe synchronously, a stale or failed one is refreshed in the
 * background (at most every {@link HEALTH_RETRY_MS} while the runner is
 * unreachable), and a run that actually wants a Craft app asks for a fresh one
 * with {@link refreshCraftRunnerHealth}.
 *
 * Conversation-deleting paths call {@link purgeCraftSessions}; a purge the
 * runner could not take (down, restarting) leaves a marker under
 * `dataDir/runtime/craft-purge/` that is retried after the next good probe.
 *
 * Protocol: see docs/architecture/craft-apps.md.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AppConfig } from "./types.js";
import logger from "./logger.js";
import { CRAFT_APPS, type CraftAppId } from "../shared/craftApps.js";
import { removeTreeNoFollow } from "./craftExchange.js";

const craftLogger = logger.child({ module: "craft-runner" });

/** Default per-request budget; `sync_in`/`sync_out` copy files and get longer. */
const DEFAULT_TIMEOUT_MS = 5_000;
export const CRAFT_SYNC_TIMEOUT_MS = 60_000;
/**
 * Budget of each control request a run's RELEASE makes (Addendum B N3): the
 * `revoke` on the response path, and the fallback `sync_out` of the final
 * output collect. A slow or hung runner never holds a finished turn longer;
 * the runner's token expiry and Noah's boot `revoke_all` are the backstops.
 */
export const CRAFT_RELEASE_TIMEOUT_MS = 10_000;
/** A health answer older than this is refreshed before a run relies on it. */
export const HEALTH_MAX_AGE_MS = 30_000;
/** Background re-probe cadence while the runner is unreachable. */
const HEALTH_RETRY_MS = 60_000;
/** Bound on one response line — a runner reply is small JSON, never a stream. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type CraftControlOp =
  | "health"
  | "open"
  | "sync_in"
  | "grant"
  | "revoke"
  | "revoke_all"
  | "sync_out"
  | "purge";

/**
 * The disk-budget verdict a runner attaches to a refusal (`open` of a new
 * session / `sync_in` while the exchange is over `CRAFT_EXCHANGE_MAX_BYTES`,
 * Addendum B N2) — only the fields Noah acts on.
 */
export interface CraftBudgetRefusal {
  over: "session" | "exchange";
}

/** Shape-check a runner `budget` object: a verdict only when it says what is over. */
export function parseCraftBudget(value: unknown): CraftBudgetRefusal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const over = (value as Record<string, unknown>).over;
  return over === "session" || over === "exchange" ? { over } : undefined;
}

export class CraftRunnerError extends Error {
  constructor(
    message: string,
    /**
     * `unreachable` = no connection / timeout; `rejected` = the runner answered
     * ok:false to a request; `unauthenticated` = the handshake failed in either
     * direction (wrong secret, or a peer that cannot prove it); `protocol` =
     * an unreadable reply.
     */
    readonly kind: "unreachable" | "rejected" | "unauthenticated" | "protocol",
    /** A `rejected` refusal's disk-budget verdict, when the runner gave one. */
    readonly budget?: CraftBudgetRefusal,
  ) {
    super(message);
    this.name = "CraftRunnerError";
  }
}

export interface CraftExchangePaths {
  root: string;
  controlSocket: string;
  mcpSocket: string;
  inboxRoot: string;
  outboxRoot: string;
}

/** The exchange layout, or null when the feature is not configured (fail closed). */
export function craftExchangePaths(
  config: Pick<AppConfig, "craftExchangeDir" | "craftControlSecret">,
): CraftExchangePaths | null {
  if (!config.craftExchangeDir || !config.craftControlSecret) return null;
  const root = path.resolve(config.craftExchangeDir);
  return {
    root,
    controlSocket: path.join(root, "sock", "control.sock"),
    mcpSocket: path.join(root, "sock", "mcp.sock"),
    inboxRoot: path.join(root, "inbox"),
    outboxRoot: path.join(root, "outbox"),
  };
}

/** Session id of a conversation: 32 hex of sha256("noah-craft:" + id) — the runner validates the shape. */
export function craftSessionId(conversationId: string): string {
  return crypto.createHash("sha256").update(`noah-craft:${conversationId}`).digest("hex").slice(0, 32);
}

/** Fresh per-RUN MCP token (64 hex) for `grant`. */
export function newCraftRunToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Nonce shape of both handshakes (Addendum A1/A2): 16 random bytes as 32 lowercase hex. */
const NONCE_RE = /^[0-9a-f]{32}$/;
const MAC_RE = /^[0-9a-f]{64}$/;

/** Fresh handshake nonce (32 hex). */
export function newCraftNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/** HMAC-SHA256 hex over `message`, keyed by the UTF-8 bytes of `key`. */
export function craftHmacHex(key: string, message: string): string {
  return crypto.createHmac("sha256", key).update(message, "utf8").digest("hex");
}

/** Constant-time equality of two hex MACs (a malformed one never matches). */
export function craftMacMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || !MAC_RE.test(given)) return false;
  return crypto.timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

/**
 * One control request over the MUTUALLY authenticated handshake (Addendum A1):
 *  1. the runner speaks first: `{"op":"challenge","v":1,"nonce":<32 hex>}`;
 *  2. Noah answers `{"op":"hello","nonce":<own 32 hex>,"mac":HMAC(secret, "noah-craft-control|client|" + runnerNonce)}`;
 *  3. the runner replies `{"ok":true,"mac":HMAC(secret, "noah-craft-control|server|" + noahNonce)}`,
 *     and Noah verifies that MAC (constant time) BEFORE it sends the request.
 * The secret itself never crosses the socket, so whatever listens at the
 * socket path learns nothing it can replay, and a listener that does not know
 * the secret never receives a request (`unauthenticated`).
 *
 * Then: send the request, read the reply carrying the same id, close. Rejects
 * with a CraftRunnerError — `unreachable` for connect failures and timeouts,
 * `rejected` when the runner answered `ok:false` (its English error text is
 * the message), `unauthenticated` when either side of the handshake failed.
 */
export function craftControlRequest(
  config: Pick<AppConfig, "craftExchangeDir" | "craftControlSecret">,
  op: CraftControlOp,
  payload: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const paths = craftExchangePaths(config);
  const secret = config.craftControlSecret;
  if (!paths || !secret) {
    return Promise.reject(new CraftRunnerError("the craft-runner is not configured", "unreachable"));
  }
  const id = crypto.randomUUID();
  const noahNonce = newCraftNonce();
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";
    let stage: "challenge" | "hello" | "reply" = "challenge";
    const socket = net.createConnection(paths.controlSocket);
    const finish = (error: CraftRunnerError | null, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? {});
    };
    const timer = setTimeout(
      () =>
        finish(
          new CraftRunnerError(
            stage === "reply"
              ? `craft-runner ${op} timed out after ${timeoutMs} ms`
              : `craft-runner handshake timed out after ${timeoutMs} ms`,
            "unreachable",
          ),
        ),
      timeoutMs,
    );
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) {
        finish(new CraftRunnerError("craft-runner reply exceeded the line limit", "protocol"));
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1 && !settled) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
          message = parsed as Record<string, unknown>;
        } catch {
          finish(new CraftRunnerError("craft-runner sent an unreadable reply", "protocol"));
          return;
        }
        if (stage === "challenge") {
          const runnerNonce = message.nonce;
          if (message.op !== "challenge" || message.v !== 1 || typeof runnerNonce !== "string" || !NONCE_RE.test(runnerNonce)) {
            finish(new CraftRunnerError("the peer on the craft-runner control socket sent no valid challenge", "unauthenticated"));
            return;
          }
          stage = "hello";
          socket.write(
            `${JSON.stringify({ op: "hello", nonce: noahNonce, mac: craftHmacHex(secret, `noah-craft-control|client|${runnerNonce}`) })}\n`,
          );
          continue;
        }
        if (stage === "hello") {
          if (message.ok !== true) {
            finish(
              new CraftRunnerError(
                `craft-runner refused the control handshake (${String(message.error ?? "unauthorized").slice(0, 200)})`,
                "unauthenticated",
              ),
            );
            return;
          }
          if (!craftMacMatches(message.mac, craftHmacHex(secret, `noah-craft-control|server|${noahNonce}`))) {
            // Whatever answered does not know the secret: never send it a request.
            finish(
              new CraftRunnerError("the peer on the craft-runner control socket failed to prove the control secret", "unauthenticated"),
            );
            return;
          }
          stage = "reply";
          socket.write(`${JSON.stringify({ ...payload, id, op })}\n`);
          continue;
        }
        if (message.id !== id) continue; // not ours (the protocol echoes ids)
        if (message.ok !== true) {
          finish(
            new CraftRunnerError(String(message.error ?? `craft-runner ${op} failed`), "rejected", parseCraftBudget(message.budget)),
          );
          return;
        }
        finish(null, message);
        return;
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      finish(new CraftRunnerError(`craft-runner unreachable (${error.code ?? error.message})`, "unreachable"));
    });
    socket.on("close", () => {
      finish(new CraftRunnerError(`craft-runner closed the connection before answering ${op}`, "unreachable"));
    });
  });
}

// ---------------------------------------------------------------------------
// Health (memoized)
// ---------------------------------------------------------------------------

export interface CraftRunnerHealthApp {
  id: string;
  version: string;
  status: "ready" | "failed";
  error?: string;
  tools: number;
}

export interface CraftRunnerHealth {
  apps: CraftRunnerHealthApp[];
  procs: { running: number; max: number };
  sessions: number;
  /** Bytes on the exchange volume vs the runner's `CRAFT_EXCHANGE_MAX_BYTES` (absent from an older runner). */
  exchange?: { bytes: number; maxBytes: number };
}

/**
 * The exchange volume is over the runner's budget (Addendum B N2): Noah then
 * copies nothing more into the session inbox. Unknown (an older runner) = not over.
 */
export function craftExchangeOverBudget(health: Pick<CraftRunnerHealth, "exchange">): boolean {
  return Boolean(health.exchange && health.exchange.bytes > health.exchange.maxBytes);
}

export type CraftRunnerProbe =
  | { state: "not_configured" }
  | { state: "unprobed" }
  | { state: "unreachable"; error: string; checkedAt: number }
  | { state: "ok"; health: CraftRunnerHealth; checkedAt: number };

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Max length (code points) of runner-reported text that may reach a prompt. */
export const CRAFT_RUNNER_TEXT_MAX = 300;

/**
 * Runner-reported free text (an app's self-test error, which can carry the
 * third-party app's stderr) made safe to quote as DATA in agent-facing text:
 * control, format and line/paragraph separator characters become spaces,
 * backticks become quotes (no breaking out of a code span), whitespace is
 * collapsed, and the result is cut to {@link CRAFT_RUNNER_TEXT_MAX} code points
 * (never splitting a surrogate pair). The runner already does the same; this is
 * the second, Noah-side pass (Addendum A5).
 */
export function sanitizeCraftRunnerText(value: unknown): string {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]+/gu, " ")
    .replace(/`/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(cleaned);
  return points.length > CRAFT_RUNNER_TEXT_MAX ? `${points.slice(0, CRAFT_RUNNER_TEXT_MAX - 1).join("").trimEnd()}…` : cleaned;
}

/** Shape-check a `health` reply; unknown fields are dropped, strings bounded. */
export function parseCraftHealth(reply: Record<string, unknown>): CraftRunnerHealth {
  const apps = Array.isArray(reply.apps) ? reply.apps : [];
  const procs = reply.procs && typeof reply.procs === "object" ? (reply.procs as Record<string, unknown>) : {};
  const exchange = reply.exchange && typeof reply.exchange === "object" ? (reply.exchange as Record<string, unknown>) : {};
  const exchangeMax = asCount(exchange.maxBytes);
  return {
    apps: apps.slice(0, 32).flatMap((raw: unknown) => {
      if (!raw || typeof raw !== "object") return [];
      const app = raw as Record<string, unknown>;
      const id = asString(app.id);
      if (!/^[a-z0-9]{1,32}$/.test(id)) return [];
      const error = sanitizeCraftRunnerText(app.error);
      return [
        {
          id,
          version: sanitizeCraftRunnerText(app.version).slice(0, 40),
          status: app.status === "ready" ? ("ready" as const) : ("failed" as const),
          ...(error ? { error } : {}),
          tools: asCount(app.tools),
        },
      ];
    }),
    procs: { running: asCount(procs.running), max: asCount(procs.max) },
    sessions: asCount(reply.sessions),
    ...(exchangeMax > 0 ? { exchange: { bytes: asCount(exchange.bytes), maxBytes: exchangeMax } } : {}),
  };
}

interface HealthMemo {
  key: string;
  probe: CraftRunnerProbe;
}

let healthMemo: HealthMemo | null = null;
let healthInFlight: Promise<CraftRunnerProbe> | null = null;
let memoGeneration = 0;

function memoKey(config: Pick<AppConfig, "craftExchangeDir" | "craftControlSecret">): string {
  return `${config.craftExchangeDir ?? ""}\0${crypto.createHash("sha256").update(config.craftControlSecret ?? "").digest("hex")}`;
}

function probeTime(probe: CraftRunnerProbe): number {
  return probe.state === "ok" || probe.state === "unreachable" ? probe.checkedAt : Number.NEGATIVE_INFINITY;
}

/**
 * Ask the runner for `health` now (deduplicated while one is in flight) and
 * memoize the answer. Never rejects. A successful probe also retries any purge
 * left pending by an earlier outage.
 */
function probeNow(config: Pick<AppConfig, "craftExchangeDir" | "craftControlSecret" | "dataDir">): Promise<CraftRunnerProbe> {
  if (!craftExchangePaths(config)) {
    return Promise.resolve({ state: "not_configured" });
  }
  if (healthInFlight) return healthInFlight;
  const key = memoKey(config);
  const generation = memoGeneration;
  const previous = healthMemo?.key === key ? healthMemo.probe : null;
  const attempt = craftControlRequest(config, "health", {}, 3_000)
    .then((reply): CraftRunnerProbe => ({ state: "ok", health: parseCraftHealth(reply), checkedAt: Date.now() }))
    .catch((error: unknown): CraftRunnerProbe => ({
      state: "unreachable",
      error: error instanceof Error ? error.message : String(error),
      checkedAt: Date.now(),
    }))
    .then((probe) => {
      if (generation === memoGeneration) {
        healthMemo = { key, probe };
        if (probe.state === "unreachable" && previous?.state !== "unreachable") {
          craftLogger.warn({ error: probe.error }, "craft-runner health probe failed; retrying in the background");
        } else if (probe.state === "ok" && previous?.state !== "ok") {
          craftLogger.info(
            { apps: probe.health.apps.map((app) => `${app.id}@${app.version}:${app.status}`) },
            "craft-runner reachable",
          );
        }
        if (probe.state === "ok") void retryPendingCraftPurges(config as AppConfig);
      }
      return probe;
    })
    .finally(() => {
      if (healthInFlight === attempt) healthInFlight = null;
    });
  healthInFlight = attempt;
  return attempt;
}

/**
 * The memoized probe, synchronously (no I/O on the caller's path). A probe
 * that is missing, stale or failed schedules a background refresh — failed
 * ones at most every {@link HEALTH_RETRY_MS}. Hermetic under NODE_ENV=test:
 * nothing is scheduled there; tests call {@link refreshCraftRunnerHealth}.
 */
export function cachedCraftRunnerHealth(
  config: Pick<AppConfig, "craftExchangeDir" | "craftControlSecret" | "dataDir">,
): CraftRunnerProbe {
  if (!craftExchangePaths(config)) return { state: "not_configured" };
  const memo = healthMemo?.key === memoKey(config) ? healthMemo.probe : null;
  if (process.env.NODE_ENV !== "test") {
    const age = memo ? Date.now() - probeTime(memo) : Number.POSITIVE_INFINITY;
    const due = !memo || (memo.state === "unreachable" ? age >= HEALTH_RETRY_MS : age >= HEALTH_MAX_AGE_MS);
    if (due) void probeNow(config);
  }
  return memo ?? { state: "unprobed" };
}

/**
 * A probe no older than `maxAgeMs` (a live `health` call when the memo is
 * older). For runs that are about to rely on a Craft app.
 */
export async function refreshCraftRunnerHealth(
  config: Pick<AppConfig, "craftExchangeDir" | "craftControlSecret" | "dataDir">,
  maxAgeMs = HEALTH_MAX_AGE_MS,
): Promise<CraftRunnerProbe> {
  if (!craftExchangePaths(config)) return { state: "not_configured" };
  const memo = healthMemo?.key === memoKey(config) ? healthMemo.probe : null;
  if (memo && Date.now() - probeTime(memo) < maxAgeMs) return memo;
  return probeNow(config);
}

let bootRevoke: Promise<void> | null = null;

/**
 * Boot, once (Addendum A3): `revoke_all` — every run token a previous Noah
 * process granted dies with that process, even when it crashed before its
 * run's release. Best-effort (a runner that is down has nothing live to
 * revoke, or its own 12 h token expiry does it); never rejects.
 */
export function revokeAllCraftTokensAtBoot(
  config: Pick<AppConfig, "craftExchangeDir" | "craftControlSecret">,
): Promise<void> {
  if (!craftExchangePaths(config)) return Promise.resolve();
  bootRevoke ??= craftControlRequest(config, "revoke_all", {}, CRAFT_SYNC_TIMEOUT_MS).then(
    () => {
      craftLogger.info("craft-runner: revoked every run token of earlier Noah processes");
    },
    (error: unknown) => {
      craftLogger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "craft-runner revoke_all at boot failed (best-effort; the runner's token expiry still applies)",
      );
    },
  );
  return bootRevoke;
}

/**
 * Settles once the boot `revoke_all` has (no-op when it never started). A
 * `grant` waits on it so the boot sweep can never kill a token THIS process
 * just granted.
 */
export function craftBootRevokeSettled(): Promise<void> {
  return bootRevoke ?? Promise.resolve();
}

/**
 * Boot: `revoke_all` once, then probe, and keep re-probing in the background
 * while the runner is unreachable (it may start after Noah). A no-op when not
 * configured. Returns a stop function (the timer is unref'd either way).
 */
export function startCraftRunnerProbe(
  config: Pick<AppConfig, "craftExchangeDir" | "craftControlSecret" | "dataDir">,
): () => void {
  if (!craftExchangePaths(config)) return () => {};
  void revokeAllCraftTokensAtBoot(config).then(() => probeNow(config));
  const timer = setInterval(() => {
    const memo = healthMemo?.probe;
    if (!memo || memo.state !== "ok") void probeNow(config);
  }, HEALTH_RETRY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Test hook: drop the memo (and orphan any in-flight probe). */
export function __resetCraftRunnerForTests(): void {
  memoGeneration += 1;
  healthMemo = null;
  healthInFlight = null;
  bootRevoke = null;
}

/** What the client is told (`GET /api/me` for admins, the admin system payload). */
export interface CraftAppsClientStatus {
  /** The admin switch is on AND the deployment configures the runner. */
  enabled: boolean;
  /** CRAFT_EXCHANGE_DIR + CRAFT_CONTROL_SECRET are set. */
  configured: boolean;
  /** The memoized probe reached the runner. */
  runnerReachable: boolean;
  apps: { id: CraftAppId; status: "ready" | "failed" | "unavailable"; version?: string }[];
}

/**
 * Per-app availability for the UI from the MEMOIZED probe (no I/O on the
 * request path; a stale probe refreshes in the background). The composer shows
 * a Craft tool group only when `enabled` and that app is `ready`.
 */
export function craftAppsClientStatus(
  config: Pick<AppConfig, "craftExchangeDir" | "craftControlSecret" | "dataDir">,
  toggleOn: boolean,
): CraftAppsClientStatus {
  const configured = Boolean(craftExchangePaths(config));
  const probe = cachedCraftRunnerHealth(config);
  const healthApps = probe.state === "ok" ? probe.health.apps : [];
  return {
    enabled: toggleOn && configured,
    configured,
    runnerReachable: probe.state === "ok",
    apps: CRAFT_APPS.map((app) => {
      const health = healthApps.find((entry) => entry.id === app.id);
      return health
        ? { id: app.id, status: health.status, ...(health.version ? { version: health.version } : {}) }
        : { id: app.id, status: "unavailable" as const };
    }),
  };
}

// ---------------------------------------------------------------------------
// Purge on conversation delete
// ---------------------------------------------------------------------------

function pendingPurgeDir(config: Pick<AppConfig, "dataDir">): string {
  return path.join(config.dataDir, "runtime", "craft-purge");
}

const SID_RE = /^[0-9a-f]{32}$/;

async function purgeOne(config: AppConfig, sid: string, marker: string, inbox?: string): Promise<void> {
  if (inbox) {
    // Noah owns the inbox: drop it first (async, iterative, depth-capped —
    // anything left is the runner's purge's to remove).
    const left = await removeTreeNoFollow(inbox);
    if (left > 0) craftLogger.warn({ sid, left }, "craft inbox removal left entries behind (too deep); the runner's purge removes them");
  }
  try {
    await craftControlRequest(config, "purge", { sid }, CRAFT_SYNC_TIMEOUT_MS);
    fs.rmSync(marker, { force: true });
    craftLogger.info({ sid }, "craft session purged");
  } catch (error) {
    craftLogger.warn(
      { sid, error: error instanceof Error ? error.message : String(error) },
      "craft session purge failed; retried after the next good health probe",
    );
  }
}

/**
 * Purge the Craft sessions of deleted conversations: the runner kills their
 * app processes and deletes inbox/work/outbox. Called next to every
 * `deleteConversationWorkspaceCopies`. Only conversations that ever HAD a
 * session (Noah created their `inbox/<sid>/`) are sent; Noah drops that inbox
 * itself right away (it owns it). Fire-and-forget and never throws: a purge
 * the runner cannot take now leaves a marker that is retried later.
 */
export function purgeCraftSessions(config: AppConfig, conversationIds: readonly string[]): void {
  const paths = craftExchangePaths(config);
  if (!paths || conversationIds.length === 0) return;
  for (const conversationId of conversationIds) {
    const sid = craftSessionId(conversationId);
    const inbox = path.join(paths.inboxRoot, sid);
    let hadSession = false;
    try {
      hadSession = fs.lstatSync(inbox, { throwIfNoEntry: false }) !== undefined;
    } catch {
      hadSession = false;
    }
    if (!hadSession) continue;
    const marker = path.join(pendingPurgeDir(config), sid);
    try {
      fs.mkdirSync(pendingPurgeDir(config), { recursive: true, mode: 0o700 });
      fs.writeFileSync(marker, "");
    } catch {
      // Best effort: without the marker a failed purge is only logged.
    }
    void purgeOne(config, sid, marker, inbox);
  }
}

/** Retry every purge an earlier outage left pending. Never throws. */
export async function retryPendingCraftPurges(config: AppConfig): Promise<void> {
  let entries: string[];
  try {
    entries = fs.readdirSync(pendingPurgeDir(config));
  } catch {
    return;
  }
  for (const sid of entries) {
    const marker = path.join(pendingPurgeDir(config), sid);
    if (!SID_RE.test(sid)) {
      fs.rmSync(marker, { force: true });
      continue;
    }
    await purgeOne(config, sid, marker);
  }
}
