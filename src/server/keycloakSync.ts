/**
 * What Noah decides about a person, written into the bundled Keycloak.
 *
 * Noah stays the place where a person is approved, suspended, made admin or
 * deleted. Everything else that trusts this Keycloak (pi) sees those decisions
 * only because this module writes them there:
 *
 * - approved teammate (a user row that is NOT suspended) = member of the
 *   `teammates` group; Noah admin = the realm `admin` role. Group membership
 *   is the ONLY gate written: an account is never disabled or enabled here.
 * - ONE DIRECTION: Noah → Keycloak. Nothing here reads a decision back; where
 *   the two disagree, Noah's answer is written over Keycloak's.
 * - BEST EFFORT, then caught up: a write after an admin's press
 *   ({@link syncUserToKeycloak}) never fails the press — Noah's own state has
 *   already changed. What it could not write is written by the boot pass
 *   ({@link reconcileKeycloak}), which makes the group and the role match Noah
 *   exactly.
 * - ONE WRITER PER ACCOUNT: every call about one user id runs after the one
 *   before it, and reads Noah's state when it RUNS — so two quick presses end
 *   with the later state, whatever order Keycloak answers in.
 * - NEVER MERGES: an account is matched by id alone (a Keycloak account carries
 *   its Noah user's id). A Noah user whose username Keycloak holds under
 *   another id is left out and named in the log for the operator.
 *
 * Without `AppConfig.keycloak` every function here does nothing.
 */
import { keycloakFor, KeycloakRefusedError, KeycloakUnavailableError, type KeycloakClient } from "./keycloak.js";
import logger from "./logger.js";
import type { Store } from "./store.js";
import type { AppConfig } from "./types.js";

const syncLogger = logger.child({ module: "keycloak-sync" });

/** How many accounts one import call carries. */
const IMPORT_CHUNK = 100;
/** Keycloak's own name prefix for a client's service account — never a person, never touched by the boot pass. */
const SERVICE_ACCOUNT_PREFIX = "service-account-";
/** The chain the realm's registration switch is written on (not a user id). */
const REGISTRATION_KEY = " registration";

/**
 * The boot pass is tried again after a pause that doubles (Keycloak may come
 * up later than Noah), a bounded number of times; after that the next boot
 * tries again.
 */
const retry = { delayMs: 5_000, maxDelayMs: 60_000, attempts: 20 };

/** Tests: shorten the pauses, or turn the retries off (`attempts: 0`). No argument = the defaults. */
export function setKeycloakSyncRetryForTests(options: { delayMs?: number; attempts?: number } = {}): void {
  retry.delayMs = options.delayMs ?? 5_000;
  retry.attempts = options.attempts ?? 20;
}

interface SyncState {
  /** The settled tail of each key's chain (a user id, or {@link REGISTRATION_KEY}); dropped once nothing waits behind it. */
  chains: Map<string, Promise<void>>;
  /** Everything running or queued right now (none of these reject). */
  inFlight: Set<Promise<unknown>>;
  reconcile: { running: boolean; round: number; timer: NodeJS.Timeout | null; again: boolean };
  /** User ids whose last write failed: the next pass writes them again first (a deleted user's account is deleted there). */
  repair: Set<string>;
}

const states = new WeakMap<Store, SyncState>();

function stateOf(store: Store): SyncState {
  let state = states.get(store);
  if (!state) {
    state = { chains: new Map(), inFlight: new Set(), reconcile: { running: false, round: 0, timer: null, again: false }, repair: new Set() };
    states.set(store, state);
  }
  return state;
}

function track(state: SyncState, work: Promise<unknown>): void {
  state.inFlight.add(work);
  void work.then(() => state.inFlight.delete(work));
}

/** Run `job` after everything queued earlier under `key`. The returned promise is the job's own (it may reject). */
function serial<T>(store: Store, key: string, job: () => Promise<T>): Promise<T> {
  const state = stateOf(store);
  const run = (state.chains.get(key) ?? Promise.resolve()).then(job);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  state.chains.set(key, tail);
  void tail.then(() => {
    if (state.chains.get(key) === tail) state.chains.delete(key);
  });
  track(state, tail);
  return run;
}

/** Resolves when every write and boot pass started so far has finished (tests). A pending retry timer is not waited for. */
export async function whenKeycloakSyncIdle(store: Store): Promise<void> {
  const state = stateOf(store);
  while (state.inFlight.size > 0) await Promise.all([...state.inFlight]);
}

/** A line for the log. keycloak.ts writes its two errors to carry no secret, password, code or token. */
function reasonOf(error: unknown): string {
  if (error instanceof KeycloakUnavailableError || error instanceof KeycloakRefusedError) return error.message;
  return error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
}

const isMissing = (error: unknown): boolean => error instanceof KeycloakRefusedError && error.status === 404;

/**
 * Make sure Keycloak has an account with this Noah user's id. `username_taken`:
 * the import left it out because Keycloak holds that username under another id
 * — the two are never merged.
 */
async function ensureAccount(
  client: KeycloakClient,
  user: { id: string; username: string; displayName: string },
): Promise<"present" | "imported" | "username_taken"> {
  if (await client.getUser(user.id)) return "present";
  const { added } = await client.importUsers([{ id: user.id, username: user.username, displayName: user.displayName }]);
  if (added > 0) return "imported";
  return (await client.getUser(user.id)) ? "present" : "username_taken";
}

function logUsernameTaken(usernames: string[]): void {
  syncLogger.error(
    { usernames },
    "keycloak sync: Keycloak holds these usernames under another account id, so the Noah accounts were NOT created there and nothing was merged; rename or delete the Keycloak account, then restart Noah",
  );
}

/** The group and the role of one account, as Noah has them NOW; a suspended account's Keycloak sessions end at once. */
async function writeMembership(store: Store, client: KeycloakClient, userId: string): Promise<void> {
  const teammate = store.accountGate(userId) === "active";
  await client.setTeammate(userId, teammate);
  // The role is for whoever trusts this Keycloak without asking Noah: a suspended admin must not hold it.
  await client.setAdmin(userId, teammate && store.isAdmin(userId));
  // Leaving the group stops new tokens; ending the sessions kills the refresh tokens already out.
  if (!teammate) await client.logoutUser(userId);
}

async function writeUser(store: Store, client: KeycloakClient, userId: string): Promise<void> {
  const user = store.getUserById(userId);
  if (!user) {
    await client.deleteUser(userId);
    return;
  }
  if ((await ensureAccount(client, user)) === "username_taken") {
    logUsernameTaken([user.username]);
    return;
  }
  await writeMembership(store, client, userId);
}

/**
 * Write what Noah holds about this user id into Keycloak: the account (created
 * with the same id when Keycloak lacks it), the teammates group, the admin
 * role — or, when Noah has no such user any more, the account's deletion.
 * Best effort: never throws; a failure is logged and left to the boot pass.
 */
export async function syncUserToKeycloak(store: Store, config: AppConfig, userId: string): Promise<void> {
  try {
    const client = keycloakFor(store, config);
    if (!client) return;
    await serial(store, userId, () => writeUser(store, client, userId));
  } catch (error) {
    syncLogger.warn({ userId, reason: reasonOf(error) }, "keycloak sync: the account could not be written; a pass will write it again shortly");
    scheduleRepair(store, config, userId);
  }
}

/** End every Keycloak session of the account (an admin's force-logout). Best effort: never throws. */
export async function logoutKeycloakUser(store: Store, config: AppConfig, userId: string): Promise<void> {
  try {
    const client = keycloakFor(store, config);
    if (!client) return;
    await serial(store, userId, () => client.logoutUser(userId));
  } catch (error) {
    syncLogger.warn({ userId, reason: reasonOf(error) }, "keycloak sync: the account's Keycloak sessions could not be ended");
  }
}

/**
 * Whether Keycloak's login page offers self-registration: Noah's signup mode
 * `approval` — and always while Noah has no user at all (the first account is
 * how an install gets its admin).
 */
function registrationAllowed(store: Store): boolean {
  return store.getSignupMode() === "approval" || !store.hasAnyUser();
}

/** Write Noah's signup mode into Keycloak's registration switch. Best effort: never throws. */
export async function syncRegistrationToKeycloak(store: Store, config: AppConfig): Promise<void> {
  try {
    const client = keycloakFor(store, config);
    if (!client) return;
    await serial(store, REGISTRATION_KEY, () => client.setRegistrationAllowed(registrationAllowed(store)));
  } catch (error) {
    syncLogger.warn({ reason: reasonOf(error) }, "keycloak sync: the registration switch could not be written; a pass will write it again shortly");
    scheduleRepair(store, config);
  }
}

export type KeycloakPasswordOutcome =
  | { ok: true }
  /**
   * Nothing was changed. `policy`: Keycloak's password policy refused it. `username_taken`: Keycloak has no
   * account for this user and could not get one (the username is another account's there).
   */
  /** `stale`: `whileDigest` was given and is no longer the account's built-in digest (it was reset, or already moved). */
  | { ok: false; reason: "no_keycloak" | "no_user" | "policy" | "username_taken" | "unavailable" | "stale" };

/**
 * Put a password into the user's Keycloak account (created first when Keycloak
 * lacks it) and drop Noah's built-in digest — both in that account's turn, so
 * an admin's reset and the move of an old password (`routes/auth.ts`) never
 * interleave: whichever runs second sees what the first did. `whileDigest` is
 * the move's guard — it acts only while the digest the old password verified
 * against is still the account's, so a move queued behind a reset does not put
 * the old password back. Never throws, and never logs the password.
 */
export async function setKeycloakPassword(
  store: Store,
  config: AppConfig,
  userId: string,
  password: string,
  opts: { whileDigest?: string } = {},
): Promise<KeycloakPasswordOutcome> {
  try {
    const client = keycloakFor(store, config);
    if (!client) return { ok: false, reason: "no_keycloak" };
    return await serial(store, userId, async (): Promise<KeycloakPasswordOutcome> => {
      const user = store.getUserById(userId);
      if (!user) return { ok: false, reason: "no_user" };
      if (opts.whileDigest !== undefined && store.builtInPasswordDigest(userId) !== opts.whileDigest) return { ok: false, reason: "stale" };
      const account = await ensureAccount(client, user);
      if (account === "username_taken") {
        logUsernameTaken([user.username]);
        return { ok: false, reason: "username_taken" };
      }
      await client.setPassword(userId, password);
      // One password per account: from here it is Keycloak's.
      store.clearBuiltInPassword(userId);
      if (account === "imported") {
        // A new account is in no group yet. The password is set either way; the boot pass catches a failure up.
        await writeMembership(store, client, userId).catch((error: unknown) =>
          syncLogger.warn({ userId, reason: reasonOf(error) }, "keycloak sync: the new account's group and role could not be written"),
        );
      }
      return { ok: true };
    });
  } catch (error) {
    const policy = error instanceof KeycloakRefusedError && error.status === 400;
    syncLogger.warn({ userId, reason: reasonOf(error) }, "keycloak sync: the password could not be set in Keycloak; nothing was changed");
    return { ok: false, reason: policy ? "policy" : "unavailable" };
  }
}

// ---- The boot pass ---------------------------------------------------------------

export type KeycloakReconcileOutcome =
  /** This server has no Keycloak. */
  | { kind: "off" }
  | {
      kind: "done";
      /** Noah's users. */
      users: number;
      /** Accounts created in Keycloak (with the Noah id, without a password). */
      imported: number;
      /** Noah usernames Keycloak holds under another id: left out, never merged. */
      usernameTaken: string[];
      teammatesAdded: number;
      teammatesRemoved: number;
      adminsGranted: number;
      adminsRevoked: number;
      registrationAllowed: boolean;
    }
  /** Keycloak could not be used (yet). */
  | { kind: "retry"; reason: string };

/**
 * One pass that makes Keycloak match Noah: (a) every Noah user Keycloak lacks
 * is created there with the same id, (b) one whose username Keycloak holds
 * under another id is named in the log and left out, (c) the teammates group
 * and the admin role are changed where — and only where — they differ from
 * Noah, in both directions, and (d) the registration switch follows the signup
 * mode. Each account's change runs in that account's own turn and re-reads
 * Noah there, so a press made while the pass runs is not undone. Never throws.
 */
export async function runKeycloakReconcile(store: Store, config: AppConfig): Promise<KeycloakReconcileOutcome> {
  try {
    const client = keycloakFor(store, config);
    if (!client) return { kind: "off" };
    // First the writes that failed since the last pass (an approval, a suspension, a delete).
    const { repair } = stateOf(store);
    for (const userId of [...repair]) {
      await serial(store, userId, () => writeUser(store, client, userId));
      repair.delete(userId);
    }

    const noah = store.listUsers();
    const noahById = new Map(noah.map((user) => [user.id, user]));

    let accounts = await client.listUsers();
    let present = new Set(accounts.map((account) => account.id));
    const missing = noah.filter((user) => !present.has(user.id));
    let imported = 0;
    if (missing.length > 0) {
      for (let at = 0; at < missing.length; at += IMPORT_CHUNK) {
        const chunk = missing.slice(at, at + IMPORT_CHUNK);
        const entries = chunk.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName }));
        try {
          imported += (await client.importUsers(entries)).added;
        } catch (error) {
          // Keycloak refused the whole set (one entry it does not accept): one by one, so a single
          // account cannot hold back the others or the group and role work below. Whoever is still
          // missing afterwards is named in the log there.
          if (!(error instanceof KeycloakRefusedError)) throw error;
          for (const entry of entries) {
            try {
              imported += (await client.importUsers([entry])).added;
            } catch (single) {
              if (!(single instanceof KeycloakRefusedError)) throw single;
              syncLogger.error({ username: entry.username, reason: reasonOf(single) }, "keycloak sync: Keycloak refused to create this Noah account");
            }
          }
        }
      }
      // A user deleted from Noah while the import ran must not be left behind as a Keycloak account.
      for (const user of missing) {
        if (!store.getUserById(user.id)) await serial(store, user.id, () => client.deleteUser(user.id));
      }
      accounts = await client.listUsers();
      present = new Set(accounts.map((account) => account.id));
    }
    const leftOut = missing.filter((user) => !present.has(user.id) && store.getUserById(user.id));
    const takenNames = new Set(accounts.map((account) => account.username.toLowerCase()));
    const usernameTaken = leftOut.filter((user) => takenNames.has(user.username.toLowerCase())).map((user) => user.username);
    if (usernameTaken.length > 0) logUsernameTaken(usernameTaken);
    const unexplained = leftOut.filter((user) => !takenNames.has(user.username.toLowerCase())).map((user) => user.username);
    if (unexplained.length > 0) {
      syncLogger.error({ usernames: unexplained }, "keycloak sync: Keycloak did not create these Noah accounts (the import skipped them)");
    }

    const teammateIds = await client.listTeammateIds();
    const adminIds = await client.listAdminIds();
    const counts = { teammatesAdded: 0, teammatesRemoved: 0, adminsGranted: 0, adminsRevoked: 0 };
    // Only accounts Keycloak lists as users: a client's service account that holds the role is not Noah's to change.
    for (const account of accounts) {
      const user = noahById.get(account.id);
      if (!user && account.username.startsWith(SERVICE_ACCOUNT_PREFIX)) continue;
      const fixTeammate = Boolean(user && !user.suspended) !== teammateIds.has(account.id);
      const fixAdmin = Boolean(user && !user.suspended && user.roles.includes("admin")) !== adminIds.has(account.id);
      if (!fixTeammate && !fixAdmin) continue;
      await serial(store, account.id, async () => {
        try {
          // No Noah user at all reads as "no" for both: Noah is the source of truth.
          if (fixTeammate) {
            const teammate = store.accountGate(account.id) === "active";
            await client.setTeammate(account.id, teammate);
            counts[teammate ? "teammatesAdded" : "teammatesRemoved"] += 1;
            if (!teammate) {
              await client.logoutUser(account.id).catch((error: unknown) =>
                syncLogger.warn({ userId: account.id, reason: reasonOf(error) }, "keycloak sync: the account's Keycloak sessions could not be ended"),
              );
            }
          }
          if (fixAdmin) {
            const admin = store.accountGate(account.id) === "active" && store.isAdmin(account.id);
            await client.setAdmin(account.id, admin);
            counts[admin ? "adminsGranted" : "adminsRevoked"] += 1;
          }
        } catch (error) {
          // Deleted meanwhile (the delete wrote that itself): nothing left to fix.
          if (!isMissing(error)) throw error;
        }
      });
    }

    const allowed = await serial(store, REGISTRATION_KEY, async () => {
      const value = registrationAllowed(store);
      await client.setRegistrationAllowed(value);
      return value;
    });

    const outcome: KeycloakReconcileOutcome = { kind: "done", users: noah.length, imported, usernameTaken, ...counts, registrationAllowed: allowed };
    syncLogger.info({ ...outcome, usernameTaken: usernameTaken.length }, "keycloak sync: Keycloak matches Noah (accounts, teammates group, admin role, registration)");
    return outcome;
  } catch (error) {
    return { kind: "retry", reason: reasonOf(error) };
  }
}

function attemptReconcile(store: Store, config: AppConfig): void {
  const state = stateOf(store);
  const { reconcile } = state;
  reconcile.running = true;
  track(
    state,
    runKeycloakReconcile(store, config).then((outcome) => {
      reconcile.running = false;
      if (outcome.kind !== "retry") {
        // A write failed while this pass ran: it may have missed it.
        if (reconcile.again) {
          reconcile.again = false;
          scheduleRepair(store, config);
        }
        return;
      }
      if (reconcile.round >= retry.attempts) {
        syncLogger.error(
          { reason: outcome.reason, attempts: reconcile.round + 1 },
          "keycloak sync: Keycloak could not be brought in line with Noah; giving up until the next boot (changes made from now on are still written one by one)",
        );
        return;
      }
      // One warning, then quiet: a Keycloak that is still starting answers the same way every round.
      syncLogger[reconcile.round === 0 ? "warn" : "debug"]({ reason: outcome.reason }, "keycloak sync: Keycloak could not be used yet; trying again");
      const delay = Math.min(retry.delayMs * 2 ** reconcile.round, retry.maxDelayMs);
      reconcile.round += 1;
      reconcile.timer = setTimeout(() => {
        reconcile.timer = null;
        attemptReconcile(store, config);
      }, delay);
      // Never keeps the process alive.
      reconcile.timer.unref();
    }),
  );
}

/**
 * A write failed (Keycloak down for a moment): run a pass after a pause, so a
 * suspension or a revoked role does not wait for the next boot to reach
 * Keycloak. `userId`: also written again by that pass, whatever Noah holds for
 * it by then (nothing = the account is deleted).
 */
function scheduleRepair(store: Store, config: AppConfig, userId?: string): void {
  const state = stateOf(store);
  if (userId) state.repair.add(userId);
  // Tests turn the retries off.
  if (retry.attempts === 0) return;
  const { reconcile } = state;
  if (reconcile.running) {
    reconcile.again = true;
    return;
  }
  if (reconcile.timer) return;
  reconcile.round = 0;
  reconcile.timer = setTimeout(() => {
    reconcile.timer = null;
    attemptReconcile(store, config);
  }, retry.delayMs);
  reconcile.timer.unref();
}

/**
 * Boot: bring Keycloak in line with Noah ({@link runKeycloakReconcile}) in the
 * background. Fire and forget — it never blocks or fails the boot, and a
 * Keycloak that is not up yet is tried again. Does nothing without Keycloak.
 */
export function reconcileKeycloak(store: Store, config: AppConfig): void {
  try {
    if (!keycloakFor(store, config)) return;
    const { reconcile } = stateOf(store);
    if (reconcile.running) return;
    if (reconcile.timer) {
      clearTimeout(reconcile.timer);
      reconcile.timer = null;
    }
    reconcile.round = 0;
    attemptReconcile(store, config);
  } catch (error) {
    syncLogger.error({ reason: reasonOf(error) }, "reconcileKeycloak failed");
  }
}
