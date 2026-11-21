/**
 * The access token of the PERSON behind a Noah session — what the pi admin
 * relay sends to pi instead of the shared admin key, so pi sees who is acting
 * and checks that person's admin role itself (`routes/piAdminProxy.ts`).
 *
 * Only a session that began at Keycloak has one: its login's refresh token is
 * on the session row (encrypted) and is traded here for a short-lived access
 * token. Everything else is "none" (null), and the caller falls back: no
 * Keycloak configured, a built-in-login session, a refresh Keycloak refused
 * (its session ended), Keycloak not answering.
 *
 * - Access tokens live in MEMORY only, keyed by a hash of the session token,
 *   and are reused until shortly before they expire. Noah never parses one.
 * - The Noah session is looked up on EVERY call, before the cache: a logged-out,
 *   expired or suspended session gets nothing, cached or not.
 * - One refresh per session at a time: Keycloak may answer with a NEW refresh
 *   token (then the old one is dead), so two refreshes racing would strand the
 *   session. The newer one replaces the stored one.
 * - A failure is remembered for a while, so a panel that polls every 10 s does
 *   not ask Keycloak (and wait for its timeout) on every request.
 * - No log line carries a token: only this module's fixed texts and the
 *   Keycloak client's own token-free error messages.
 */
import { hashToken } from "./auth.js";
import { keycloakFor, KeycloakRefusedError, KeycloakUnavailableError, type KeycloakClient } from "./keycloak.js";
import logger from "./logger.js";
import type { Store } from "./store.js";
import type { AppConfig } from "./types.js";

/** A token is replaced this long before it expires, so one handed out is still good when pi checks it. */
const EXPIRY_MARGIN_SECONDS = 30;
/** …but a token is always reused for at least this long (a lifetime shorter than the margin). */
const MIN_REUSE_SECONDS = 5;

/**
 * How long "none" is remembered. A refusal is final for that refresh token
 * (the Keycloak session ended), so it is asked again only rarely; an outage is
 * retried sooner. `maxEntries` bounds the memory. Mutable only so tests can
 * shorten them.
 */
export const PERSON_TOKEN_LIMITS = {
  retryAfterRefusedMs: 5 * 60_000,
  retryAfterUnavailableMs: 30_000,
  maxEntries: 1_000,
};

/** `accessToken: null` = "none to be had", remembered until `until` like a token. */
interface Entry {
  accessToken: string | null;
  until: number;
}

interface Cache {
  entries: Map<string, Entry>;
  refreshing: Map<string, Promise<string | null>>;
}

// Per app instance (keyed by its Store, like `keycloakFor`).
const caches = new WeakMap<Store, Cache>();

function cacheOf(store: Store): Cache {
  let cache = caches.get(store);
  if (!cache) {
    cache = { entries: new Map(), refreshing: new Map() };
    caches.set(store, cache);
  }
  return cache;
}

function remember(cache: Cache, key: string, entry: Entry): void {
  const now = Date.now();
  for (const [other, held] of cache.entries) {
    if (held.until <= now) cache.entries.delete(other);
  }
  // Re-inserted so the Map's order stays "oldest first" for the cap below.
  cache.entries.delete(key);
  while (cache.entries.size >= PERSON_TOKEN_LIMITS.maxEntries) {
    const oldest = cache.entries.keys().next();
    if (oldest.done) break;
    cache.entries.delete(oldest.value);
  }
  cache.entries.set(key, entry);
}

/** What may be logged about a failure: the Keycloak client's own token-free message, else only the error's kind. */
function describeFailure(error: unknown): string {
  if (error instanceof KeycloakRefusedError || error instanceof KeycloakUnavailableError) return error.message;
  return error instanceof Error ? error.name : "error";
}

async function refresh(store: Store, keycloak: KeycloakClient, cache: Cache, key: string, sessionToken: string): Promise<string | null> {
  const refreshToken = store.takeSessionKeycloakToken(sessionToken);
  if (!refreshToken) {
    // A built-in-login session never gains a Keycloak login: no need to look again soon.
    remember(cache, key, { accessToken: null, until: Date.now() + PERSON_TOKEN_LIMITS.retryAfterRefusedMs });
    return null;
  }
  let fresh: Awaited<ReturnType<KeycloakClient["refresh"]>>;
  try {
    fresh = await keycloak.refresh(refreshToken);
  } catch (error) {
    const refused = error instanceof KeycloakRefusedError;
    logger.warn(
      { err: describeFailure(error) },
      refused
        ? "person token: Keycloak refused the refresh (its session ended?) — the caller falls back"
        : "person token: Keycloak could not refresh — the caller falls back",
    );
    remember(cache, key, {
      accessToken: null,
      until: Date.now() + (refused ? PERSON_TOKEN_LIMITS.retryAfterRefusedMs : PERSON_TOKEN_LIMITS.retryAfterUnavailableMs),
    });
    return null;
  }
  // Logged out while Keycloak was answering: the token is neither kept nor handed out.
  if (!store.getUserBySessionToken(sessionToken, { touch: false })) return null;
  if (fresh.refreshToken && fresh.refreshToken !== refreshToken) store.setSessionKeycloakToken(sessionToken, fresh.refreshToken);
  const reuseSeconds = Math.max(MIN_REUSE_SECONDS, fresh.expiresInSeconds - EXPIRY_MARGIN_SECONDS);
  remember(cache, key, { accessToken: fresh.accessToken, until: Date.now() + reuseSeconds * 1000 });
  return fresh.accessToken;
}

/**
 * The Keycloak access token of the person this Noah session belongs to, or
 * null when there is none to be had (see the module comment). Never throws.
 */
export async function personAccessTokenFor(store: Store, config: AppConfig, sessionToken: string | undefined): Promise<string | null> {
  if (!sessionToken) return null;
  try {
    const keycloak = keycloakFor(store, config);
    if (!keycloak) return null;
    const cache = cacheOf(store);
    const key = hashToken(sessionToken);
    // Before the cache: logout cannot reach this memory, so the session row is asked every time.
    if (!store.getUserBySessionToken(sessionToken, { touch: false })) {
      cache.entries.delete(key);
      return null;
    }
    const held = cache.entries.get(key);
    if (held && held.until > Date.now()) return held.accessToken;
    let pending = cache.refreshing.get(key);
    if (!pending) {
      pending = refresh(store, keycloak, cache, key, sessionToken).finally(() => cache.refreshing.delete(key));
      cache.refreshing.set(key, pending);
    }
    return await pending;
  } catch (error) {
    // The store threw (a locked database): no token this time, nothing remembered.
    logger.warn({ err: describeFailure(error) }, "person token: lookup failed — the caller falls back");
    return null;
  }
}

/** Tests: forget every token (and every remembered "none") of this app instance. */
export function clearPersonTokensForTests(store: Store): void {
  caches.delete(store);
}

/** Tests: how many sessions this app instance remembers something for. */
export function personTokenCountForTests(store: Store): number {
  return caches.get(store)?.entries.size ?? 0;
}
