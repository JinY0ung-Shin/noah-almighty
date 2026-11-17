/**
 * Noah's client of the memory service — the per-owner markdown wiki of the
 * bundled stack, where the personal vault of an owner with vault home `memory`
 * lives (`personalVault.ts`). Program API only (`/wiki/<owner>/…`, JSON): the
 * owner is ALWAYS the Noah user id the caller decided on, never a model
 * argument.
 *
 * Two failures, kept apart on purpose:
 * - {@link MemoryRefusedError}: the service answered and said no (a coded
 *   refusal the caller can act on — `stale`, `exists`, `too_large`, …).
 * - {@link MemoryUnavailableError}: the service could not be used at all. A
 *   caller must report it as such — never as "no such note" or "no match".
 *
 * The key is sent only as the Authorization header of a request to the
 * configured address (redirects are refused). No error message and no log line
 * of this module carries it.
 */
import type { Store } from "../store.js";
import type { AppConfig } from "../types.js";
import logger from "../logger.js";

export interface MemoryNoteEntry {
  path: string;
  bytes: number;
}

export interface MemoryNote {
  path: string;
  content: string;
  hash: string;
}

export interface MemorySearchHit {
  path: string;
  title: string;
  tags: string[];
  snippet: string;
  score: number;
}

export interface MemoryClient {
  /** Every note (path order), or those under the FOLDER `prefix`. */
  list(owner: string, prefix?: string): Promise<MemoryNoteEntry[]>;
  /** null = the note does not exist. */
  read(owner: string, path: string): Promise<MemoryNote | null>;
  /** No `hash`: create (refused `exists` when there). With `hash`: replace (refused `stale` when changed or gone). */
  put(owner: string, path: string, content: string, hash?: string): Promise<{ path: string; hash: string; created: boolean }>;
  /** Resolves when the note is gone (an already-missing note is not an error). */
  remove(owner: string, path: string, hash: string): Promise<void>;
  /** `limit` 1..20 (the service's default is 8); `prefix` is a folder. */
  search(owner: string, query: string, limit?: number, prefix?: string): Promise<{ hits: MemorySearchHit[]; unscanned: number }>;
  /** Delete the owner's whole wiki (a wiki that does not exist is fine). */
  deleteWiki(owner: string): Promise<void>;
}

/**
 * The service refused the request: a coded 4xx other than 401 / `no_route`,
 * and 507 `wiki_full` (the owner's wiki is full — a refusal the owner can fix,
 * not an outage). `code` is the service's.
 */
export class MemoryRefusedError extends Error {
  override readonly name = "MemoryRefusedError";
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message?: string) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

/** Why the service could not be used (for the server log and `describe_system`; the message says the same in words). */
export type MemoryUnavailableReason =
  | "not_configured"
  | "network"
  | "timeout"
  | "unauthorized"
  | "no_route"
  | "server_error"
  | "bad_answer";

/** The service could not be used: network error, timeout, 5xx, 401, `no_route`, a body that is not the documented JSON. */
export class MemoryUnavailableError extends Error {
  override readonly name = "MemoryUnavailableError";
  readonly reason: MemoryUnavailableReason;

  constructor(message = "memory service unavailable", reason: MemoryUnavailableReason = "network") {
    super(message);
    this.reason = reason;
  }
}

/** The service's refusal codes Noah acts on. */
export const MEMORY_REFUSAL = {
  notFound: "not_found",
  exists: "exists",
  stale: "stale",
  tooLarge: "too_large",
  bodyTooLarge: "body_too_large",
  invalidPath: "invalid_path",
  wikiFull: "wiki_full",
} as const;

const DEFAULT_TIMEOUT_MS = 15_000;
/** Far above the largest documented answer (a 10,000-note listing; one 512 KiB note as JSON). */
const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
/** What the service accepts as an owner (pi's user-id rule; every Noah user id fits). */
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

type Operation = "list" | "read" | "put" | "remove" | "search" | "deleteWiki";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{"error":{"code","message"}}` → its code and message, else null. */
function errorOf(body: unknown): { code: string; message: string } | null {
  if (!isRecord(body) || !isRecord(body.error) || typeof body.error.code !== "string" || !body.error.code) return null;
  return { code: body.error.code, message: typeof body.error.message === "string" ? body.error.message : "" };
}

/** The response body as text, refused past `MAX_ANSWER_BYTES` (a wrong address must not fill the process). */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new MemoryUnavailableError("memory service unavailable: the answer is larger than any documented one", "bad_answer");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createHttpMemoryClient(options: { url: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number }): MemoryClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = options.url.replace(/\/+$/, "");
  const { apiKey } = options;

  /** Belt and braces: nothing this client throws or logs may carry the key, whatever the service echoed. */
  const scrub = (text: string) => (apiKey ? text.split(apiKey).join("[redacted]") : text);

  const unavailable = (op: Operation, reason: MemoryUnavailableReason, detail: string, status?: number) => {
    logger.warn({ module: "memory", op, reason, ...(status ? { status } : {}) }, "memory service request failed");
    return new MemoryUnavailableError(scrub(`memory service unavailable (${op}): ${detail}`), reason);
  };

  /**
   * One request. Resolves with the parsed body of a 200, or `null` for a 404
   * `not_found` when the caller said that is an answer (`missingIsNull`);
   * everything else throws one of the two error classes.
   */
  async function call(
    op: Operation,
    owner: string,
    method: "GET" | "PUT" | "DELETE",
    suffix: string,
    query: Record<string, string | undefined>,
    request: { body?: Record<string, unknown>; missingIsNull?: boolean } = {},
  ): Promise<unknown> {
    // Refused here, before it becomes a URL: `..` would otherwise be resolved away into another route.
    if (!OWNER_PATTERN.test(owner)) {
      throw new MemoryRefusedError("invalid_owner", 400, "the owner is not a valid user id");
    }
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) search.set(key, value);
    }
    const qs = search.toString();
    const url = `${base}/wiki/${encodeURIComponent(owner)}${suffix}${qs ? `?${qs}` : ""}`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();

    let status: number;
    let text: string;
    try {
      const response = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          ...(request.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        // The key goes to the configured address only.
        redirect: "error",
        signal: controller.signal,
      });
      status = response.status;
      text = await readCapped(response);
    } catch (error) {
      if (error instanceof MemoryUnavailableError) throw error;
      if (timedOut) throw unavailable(op, "timeout", `no answer within ${timeoutMs} ms`);
      // Only a system error code (ECONNREFUSED, ENOTFOUND, …) is passed on — never the transport's own text.
      const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
      const detail = typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? `network error (${code})` : "network error";
      throw unavailable(op, "network", detail);
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    let parsed = true;
    try {
      body = JSON.parse(text);
    } catch {
      parsed = false;
    }

    if (status === 200) {
      if (!parsed) throw unavailable(op, "bad_answer", "the answer is not JSON", status);
      return body;
    }
    if (status === 401) throw unavailable(op, "unauthorized", "the service did not accept Noah's key (HTTP 401)", status);
    const refusal = parsed ? errorOf(body) : null;
    if (!refusal) {
      throw status >= 500
        ? unavailable(op, "server_error", `HTTP ${status}`, status)
        : unavailable(op, "bad_answer", `HTTP ${status} without the documented error body`, status);
    }
    if (status === 404 && refusal.code === "no_route") {
      throw unavailable(op, "no_route", "the address answers, but not as this memory service (no such route)", status);
    }
    const coded4xx = status >= 400 && status < 500;
    if (coded4xx || (status === 507 && refusal.code === MEMORY_REFUSAL.wikiFull)) {
      if (request.missingIsNull && status === 404 && refusal.code === MEMORY_REFUSAL.notFound) return null;
      throw new MemoryRefusedError(refusal.code, status, scrub(refusal.message));
    }
    if (status >= 500) throw unavailable(op, "server_error", `HTTP ${status} (${scrub(refusal.code)})`, status);
    throw unavailable(op, "bad_answer", `unexpected HTTP ${status}`, status);
  }

  const badShape = (op: Operation) => unavailable(op, "bad_answer", "the answer does not have the documented fields", 200);

  return {
    async list(owner, prefix) {
      const body = await call("list", owner, "GET", "/notes", { prefix });
      if (!isRecord(body) || !Array.isArray(body.notes)) throw badShape("list");
      return body.notes.map((entry) => {
        if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.bytes !== "number") throw badShape("list");
        return { path: entry.path, bytes: entry.bytes };
      });
    },

    async read(owner, path) {
      const body = await call("read", owner, "GET", "/note", { path }, { missingIsNull: true });
      if (body === null) return null;
      if (!isRecord(body) || typeof body.path !== "string" || typeof body.content !== "string" || typeof body.hash !== "string") {
        throw badShape("read");
      }
      return { path: body.path, content: body.content, hash: body.hash };
    },

    async put(owner, path, content, hash) {
      const body = await call("put", owner, "PUT", "/note", {}, { body: { path, content, ...(hash !== undefined ? { hash } : {}) } });
      if (!isRecord(body) || typeof body.path !== "string" || typeof body.hash !== "string" || typeof body.created !== "boolean") {
        throw badShape("put");
      }
      return { path: body.path, hash: body.hash, created: body.created };
    },

    async remove(owner, path, hash) {
      // 404 `not_found` = it is already gone, which is what was asked for.
      const body = await call("remove", owner, "DELETE", "/note", { path, hash }, { missingIsNull: true });
      if (body !== null && (!isRecord(body) || typeof body.path !== "string")) throw badShape("remove");
    },

    async search(owner, query, limit, prefix) {
      const body = await call("search", owner, "GET", "/search", {
        q: query,
        limit: limit === undefined ? undefined : String(limit),
        prefix,
      });
      if (!isRecord(body) || !Array.isArray(body.hits) || typeof body.unscanned !== "number") throw badShape("search");
      const hits = body.hits.map((hit) => {
        if (
          !isRecord(hit) ||
          typeof hit.path !== "string" ||
          typeof hit.title !== "string" ||
          typeof hit.snippet !== "string" ||
          typeof hit.score !== "number" ||
          !Array.isArray(hit.tags) ||
          !hit.tags.every((tag) => typeof tag === "string")
        ) {
          throw badShape("search");
        }
        return { path: hit.path, title: hit.title, tags: hit.tags as string[], snippet: hit.snippet, score: hit.score };
      });
      return { hits, unscanned: body.unscanned };
    },

    async deleteWiki(owner) {
      const body = await call("deleteWiki", owner, "DELETE", "", {});
      if (!isRecord(body) || body.deleted !== true) throw badShape("deleteWiki");
    },
  };
}

const clients = new WeakMap<Store, MemoryClient | null>();
const installedForTests = new WeakMap<Store, MemoryClient>();

/** The client of one app instance (keyed by its Store, like `piServicesFor`); null when `config.memory` is unset. */
export function memoryClientFor(store: Store, config: AppConfig): MemoryClient | null {
  const installed = installedForTests.get(store);
  if (installed) return installed;
  let client = clients.get(store);
  if (client === undefined) {
    client = config.memory ? createHttpMemoryClient({ url: config.memory.url, apiKey: config.memory.apiKey }) : null;
    clients.set(store, client);
  }
  return client;
}

/** Tests: install a client for this Store (pass null to remove). It wins over `config.memory`, set or not. */
export function setMemoryClientForTests(store: Store, client: MemoryClient | null): void {
  if (client) installedForTests.set(store, client);
  else installedForTests.delete(store);
}
