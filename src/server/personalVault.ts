/**
 * The personal vault and where it lives.
 *
 * An owner's PERSONAL VAULT is the repo-root `CLAUDE.md` plus every `.md` note
 * under `wiki/` and `raw/` of their knowledge repo. Its HOME is either
 * - `repo`: the clone on disk IS the vault (how it always was — every code
 *   path is today's, untouched), or
 * - `memory`: the memory service is the vault, and the clone only receives a
 *   mirror (`vaultMirror.ts`).
 *
 * ONE writer per owner: with home `memory` a vault note is read and written
 * ONLY through {@link MemoryVault}; the clone's vault files are written by the
 * mirror alone and read by nobody. Everything else in the knowledge repo
 * (skills, plugins, images, non-markdown) is a repo path and stays in the
 * clone, whatever the home.
 *
 * Every vault WRITE of an owner — in BOTH homes — runs in the owner's vault
 * write queue and decides the home INSIDE it ({@link withVaultWrite}): the
 * cutover and the rollback hold the same queue, so no write can pick a home,
 * wait, and land in the one that is no longer the vault. Lock order: vault
 * write queue → repo lock.
 *
 * The home is the owner's `personal_vaults` row (`store/personalVault.ts`): a
 * row = `memory`. The instance setting `personalVaultMode` is only the target
 * the migration works towards.
 */
import path from "node:path";
import type { BrainNoteHit, BrainSearchResult } from "./agent/brainSearch.js";
import {
  MEMORY_REFUSAL,
  MemoryRefusedError,
  MemoryUnavailableError,
  memoryClientFor,
  type MemoryClient,
  type MemoryNoteEntry,
} from "./memory/memoryClient.js";
import type { Store } from "./store.js";
import type { AppConfig } from "./types.js";

export type VaultHome = "repo" | "memory";

/** A vault note's size limit: the service's, and `knowledgeRepo.ts`' `MAX_FILE_BYTES` (both 512 KiB). */
export const VAULT_NOTE_MAX_BYTES = 512 * 1024;

/**
 * Thrown (as `Error.message`) by a {@link MemoryVault} write that found the
 * owner's home is no longer `memory` — a rollback ran while the write waited.
 * Nothing was written; the caller's next attempt takes the repo path.
 */
export const VAULT_HOME_CHANGED = "VAULT_HOME_CHANGED";

/**
 * Thrown (as `Error.message`) by a write through the vault {@link withVaultWrite}
 * handed out, once its callback has finished: that vault writes WITHOUT taking
 * the queue, which is only safe while the callback holds it.
 */
export const VAULT_WRITER_CLOSED = "VAULT_WRITER_CLOSED";

/**
 * After a vault change whose answer was lost, the mirror is marked dirty at
 * once and ONCE more this much later: the service may carry the change out
 * after a mirror pass already read the old content and recorded itself clean.
 */
export const VAULT_LOST_ANSWER_REMARK_MS = 60_000;

// The service's own path rules (its `segmentsOf`): a path it refuses can never
// be a vault note, so it is a repo path and stays in the clone.
const SERVICE_MAX_PATH_BYTES = 512;
const SERVICE_MAX_SEGMENT_BYTES = 255;
const SERVICE_MAX_SEGMENTS = 16;
const SERVICE_FORBIDDEN_CHARS = /[\u0000-\u001f\u007f\\]/;

/** Strip leading `./` and `/`, posix-normalize, NFC (the form the service stores). Never throws. */
export function normalizeVaultPath(rel: string): string {
  return path.posix.normalize(rel.replace(/^(?:\.?\/)+/, "")).normalize("NFC");
}

/**
 * Whether `rel` (any spelling; normalized here) names a personal-vault note:
 * `CLAUDE.md` at the repo root, or a `.md` under `wiki/` or `raw/` that the
 * memory service can hold. Everything else is a repo path — including a
 * markdown file the service's path rules refuse (a folder or name starting
 * with a dot such as `wiki/.obsidian/x.md`, a backslash or control character,
 * more than 16 parts, an over-long path), which therefore stays in the clone.
 */
export function isPersonalVaultPath(rel: string): boolean {
  const norm = normalizeVaultPath(rel);
  if (norm === "CLAUDE.md") return true;
  if (!/^(wiki|raw)\/.+\.md$/.test(norm)) return false;
  if (SERVICE_FORBIDDEN_CHARS.test(norm) || Buffer.byteLength(norm, "utf8") > SERVICE_MAX_PATH_BYTES) return false;
  const segments = norm.split("/");
  if (segments.length > SERVICE_MAX_SEGMENTS) return false;
  return segments.every(
    (segment) => segment !== "" && !segment.startsWith(".") && Buffer.byteLength(segment, "utf8") <= SERVICE_MAX_SEGMENT_BYTES,
  );
}

/** Where this owner's vault lives right now (a `personal_vaults` row = `memory`). */
export function vaultHomeOf(store: Store, userId: string): VaultHome {
  return store.getPersonalVault(userId) ? "memory" : "repo";
}

export interface MemoryVault {
  readonly userId: string;
  /** Vault notes only, path order. */
  list(): Promise<MemoryNoteEntry[]>;
  /** Throws an Error whose message is `NOT_FOUND` when missing (same sentinel style as knowledgeRepo). */
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /** Create or replace (reads the current hash itself; retries once on `stale`). Marks the mirror dirty. */
  write(path: string, content: string): Promise<{ created: boolean }>;
  /** Same contract and sentinel errors as `knowledgeRepo.editFile` (NOT_FOUND, STRING_NOT_FOUND, STRING_NOT_UNIQUE, NO_CHANGE, FILE_TOO_LARGE); returns the replacement count. */
  edit(path: string, oldString: string, newString: string, replaceAll?: boolean): Promise<number>;
  /** Missing note = no-op. Records the path in the deletion ledger first, then marks the mirror dirty. */
  remove(path: string): Promise<void>;
  /** Personal-brain search: wiki/ only, minus wiki/index.md, wiki/log.md and *_template.md, same result type as rankBrainNotes; `no_vault` when the wiki holds no note under wiki/ or raw/. */
  search(query: string, limit?: number): Promise<BrainSearchResult>;
}

/**
 * The vault {@link withVaultWrite} hands to its callback: the same operations,
 * but `write`/`edit`/`remove` do NOT take the owner's queue again — the
 * callback is already in it. Valid only until the callback finishes.
 */
export interface MemoryVaultWriter extends MemoryVault {
  readonly inQueue: true;
}

/** Where a vault write goes, as decided inside the owner's vault write queue. */
export type VaultWriteTarget = { home: "repo" } | { home: "memory"; vault: MemoryVaultWriter };

// ---- One writer at a time per owner ------------------------------------------

const writeTails = new WeakMap<Store, Map<string, Promise<unknown>>>();

/**
 * Run `fn` alone among this owner's vault writes (in-process, per app
 * instance): every {@link MemoryVault} write, edit and remove takes it, so a
 * read-then-write inside `fn` sees no other Noah write in between. For the
 * mirror and the migration (a tool that changes a vault path uses
 * {@link withVaultWrite}) — NOT re-entrant: calling a `MemoryVault` write, or
 * this function, for the same owner from inside `fn` waits for `fn` itself and
 * never finishes.
 */
export function withVaultWriteLock<T>(store: Store, userId: string, fn: () => Promise<T>): Promise<T> {
  let tails = writeTails.get(store);
  if (!tails) {
    tails = new Map();
    writeTails.set(store, tails);
  }
  const owners = tails;
  const run = (owners.get(userId) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => undefined);
  owners.set(userId, tail);
  void tail.then(() => {
    if (owners.get(userId) === tail) owners.delete(userId);
  });
  return run;
}

// ---- The vault over the service ----------------------------------------------

/** Personal-brain search bounds — `brainSearch.ts`' (default 8, at most 20), which are also the service's. */
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;
/**
 * The longest search query Noah sends, in UTF-16 code units. The service's rule
 * is `z.string().max(500)`, and what that counts depends on its zod: the
 * version it pins (4.6.7) counts code points, an older one (4.4.x, the one in
 * Noah's own tree) counts UTF-16 units. 500 units is at most 500 code points,
 * so a query this long passes whichever the deployed service runs.
 */
const MAX_SEARCH_QUERY_UNITS = 500;
/** The structural pages a search may match and must drop: `wiki/index.md`, `wiki/log.md`, the stock `wiki/_template.md`. */
const SEARCH_STRUCTURAL_SLACK = 3;

/**
 * The query as the service accepts it: at most its first 500 UTF-16 code units,
 * one fewer when the cut would fall inside a surrogate pair (the half left
 * behind would travel as U+FFFD). `rankBrainNotes` takes any length, so a long
 * query is cut rather than refused.
 */
function searchQueryOf(query: string): string {
  if (query.length <= MAX_SEARCH_QUERY_UNITS) return query;
  const last = query.charCodeAt(MAX_SEARCH_QUERY_UNITS - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return query.slice(0, splitsPair ? MAX_SEARCH_QUERY_UNITS - 1 : MAX_SEARCH_QUERY_UNITS);
}

/** The exclusions `rankBrainNotes` applies to the personal wiki. */
function isSearchableNote(notePath: string): boolean {
  return (
    notePath.startsWith("wiki/") &&
    notePath.endsWith(".md") &&
    !notePath.endsWith("_template.md") &&
    notePath !== "wiki/index.md" &&
    notePath !== "wiki/log.md"
  );
}

/**
 * A service refusal that has a knowledgeRepo sentinel becomes that sentinel
 * (the tools already word those); every other error — `MemoryUnavailableError`
 * above all — is returned as it is.
 */
function toSentinel(error: unknown): unknown {
  if (!(error instanceof MemoryRefusedError)) return error;
  switch (error.code) {
    case MEMORY_REFUSAL.tooLarge:
    case MEMORY_REFUSAL.bodyTooLarge:
      return new Error("FILE_TOO_LARGE", { cause: error });
    case MEMORY_REFUSAL.invalidPath:
      return new Error("INVALID_PATH", { cause: error });
    case MEMORY_REFUSAL.notFound:
      return new Error("NOT_FOUND", { cause: error });
    default:
      return error;
  }
}

function isRefusal(error: unknown, ...codes: string[]): boolean {
  return error instanceof MemoryRefusedError && codes.includes(error.code);
}

const lostAnswerRemarks = new WeakMap<Store, Map<string, NodeJS.Timeout>>();

/**
 * One more `markVaultMirrorDirty` for this owner, {@link VAULT_LOST_ANSWER_REMARK_MS}
 * from now (one timer per owner: a later lost answer pushes it back). The timer
 * never keeps the process alive, and a store closed in the meantime is simply
 * not marked.
 */
function remarkAfterLostAnswer(store: Store, userId: string): void {
  let owners = lostAnswerRemarks.get(store);
  if (!owners) {
    owners = new Map();
    lostAnswerRemarks.set(store, owners);
  }
  const pending = owners;
  clearTimeout(pending.get(userId));
  const timer = setTimeout(() => {
    pending.delete(userId);
    try {
      store.markVaultMirrorDirty(userId);
    } catch {
      // The store was closed: there is no row left to mark.
    }
  }, VAULT_LOST_ANSWER_REMARK_MS);
  timer.unref();
  pending.set(userId, timer);
}

class ServiceMemoryVault implements MemoryVault {
  /** Set once the `withVaultWrite` callback this vault was made for has finished. */
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly client: MemoryClient,
    readonly userId: string,
    /** true: the caller already holds the owner's vault write queue (`withVaultWrite`), so writes must not take it. */
    readonly inQueue: boolean,
  ) {}

  /** `withVaultWrite`: the callback is over, and with it the queue this vault relied on. */
  close(): void {
    this.closed = true;
  }

  /** The normalized path of a vault note; anything else is not this vault's to hold. */
  private notePath(raw: string): string {
    const norm = normalizeVaultPath(raw);
    if (!isPersonalVaultPath(norm)) throw new Error("INVALID_PATH");
    return norm;
  }

  private async reading<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toSentinel(error);
    }
  }

  /**
   * One write of this owner, alone among their writes: in the owner's queue,
   * or — for the vault `withVaultWrite` handed out — in the queue its callback
   * already holds.
   */
  private writing<T>(fn: (touched: () => void) => Promise<T>): Promise<T> {
    if (this.inQueue) {
      if (this.closed) return Promise.reject(new Error(VAULT_WRITER_CLOSED));
      return this.sending(fn);
    }
    return withVaultWriteLock(this.store, this.userId, () => {
      // The home may have flipped back to `repo` while this write waited its turn.
      if (!this.store.getPersonalVault(this.userId)) throw new Error(VAULT_HOME_CHANGED);
      return this.sending(fn);
    });
  }

  /**
   * `touched()` is called just before a change is SENT: from then on the
   * mirror is marked dirty whatever the outcome — on success because the vault
   * changed, on a lost answer because it may have (a spurious mark only costs
   * a pass that finds nothing to do). A lost answer is also marked once more
   * later: the service may still carry the change out after a pass has run.
   */
  private async sending<T>(fn: (touched: () => void) => Promise<T>): Promise<T> {
    const change = { sent: false };
    try {
      return await fn(() => {
        change.sent = true;
      });
    } catch (error) {
      if (change.sent && error instanceof MemoryUnavailableError) remarkAfterLostAnswer(this.store, this.userId);
      throw toSentinel(error);
    } finally {
      if (change.sent) this.store.markVaultMirrorDirty(this.userId);
    }
  }

  list(): Promise<MemoryNoteEntry[]> {
    return this.reading(async () => (await this.client.list(this.userId)).filter((entry) => isPersonalVaultPath(entry.path)));
  }

  async read(notePath: string): Promise<string> {
    const rel = this.notePath(notePath);
    const note = await this.reading(() => this.client.read(this.userId, rel));
    if (!note) throw new Error("NOT_FOUND");
    return note.content;
  }

  async exists(notePath: string): Promise<boolean> {
    const rel = this.notePath(notePath);
    return (await this.reading(() => this.client.read(this.userId, rel))) !== null;
  }

  async write(notePath: string, content: string): Promise<{ created: boolean }> {
    const rel = this.notePath(notePath);
    if (Buffer.byteLength(content, "utf8") > VAULT_NOTE_MAX_BYTES) throw new Error("FILE_TOO_LARGE");
    return this.writing(async (touched) => {
      for (let attempt = 0; ; attempt += 1) {
        const current = await this.client.read(this.userId, rel);
        touched();
        try {
          const { created } = await this.client.put(this.userId, rel, content, current?.hash);
          // The note exists again by Noah's own write: an earlier deletion of this path is settled.
          this.store.clearVaultDeletes(this.userId, [rel]);
          return { created };
        } catch (error) {
          // Something outside Noah changed or created the note between the read and the put: once more, on what is there now.
          if (attempt === 0 && isRefusal(error, MEMORY_REFUSAL.stale, MEMORY_REFUSAL.exists)) continue;
          throw error;
        }
      }
    });
  }

  async edit(notePath: string, oldString: string, newString: string, replaceAll = false): Promise<number> {
    // The order of knowledgeRepo.editFile: NO_CHANGE before the path is looked at.
    if (!oldString || oldString === newString) throw new Error("NO_CHANGE");
    const rel = this.notePath(notePath);
    return this.writing(async (touched) => {
      for (let attempt = 0; ; attempt += 1) {
        const current = await this.client.read(this.userId, rel);
        if (!current) throw new Error("NOT_FOUND");
        const occurrences = current.content.split(oldString).length - 1;
        if (occurrences === 0) throw new Error("STRING_NOT_FOUND");
        if (occurrences > 1 && !replaceAll) throw new Error("STRING_NOT_UNIQUE");
        // split/join (not String.replace) so `newString` is inserted literally.
        const next = current.content.split(oldString).join(newString);
        if (Buffer.byteLength(next, "utf8") > VAULT_NOTE_MAX_BYTES) throw new Error("FILE_TOO_LARGE");
        touched();
        try {
          await this.client.put(this.userId, rel, next, current.hash);
          this.store.clearVaultDeletes(this.userId, [rel]);
          return replaceAll ? occurrences : 1;
        } catch (error) {
          if (attempt === 0 && isRefusal(error, MEMORY_REFUSAL.stale)) continue;
          throw error;
        }
      }
    });
  }

  async remove(notePath: string): Promise<void> {
    const rel = this.notePath(notePath);
    await this.writing(async (touched) => {
      // BEFORE the service is asked: the mirror deletes a clone file only for a path in this ledger that the
      // service no longer holds, so an entry for a note that turns out to stay is harmless — a missing one is not.
      this.store.recordVaultDelete(this.userId, rel);
      for (let attempt = 0; ; attempt += 1) {
        const current = await this.client.read(this.userId, rel);
        // Already gone. Still marked: an earlier delete whose answer was lost left the mirror holding the file.
        touched();
        if (!current) return;
        try {
          await this.client.remove(this.userId, rel, current.hash);
          return;
        } catch (error) {
          if (attempt === 0 && isRefusal(error, MEMORY_REFUSAL.stale)) continue;
          throw error;
        }
      }
    });
  }

  async search(query: string, limit: number = DEFAULT_SEARCH_LIMIT): Promise<BrainSearchResult> {
    return this.reading(async () => {
      const wanted = Math.min(Math.max(1, Math.floor(Number.isFinite(limit) ? limit : DEFAULT_SEARCH_LIMIT)), MAX_SEARCH_LIMIT);
      let hits: BrainNoteHit[] = [];
      let unscanned = 0;
      const asked = searchQueryOf(query);
      // The service refuses a query without a word; rankBrainNotes answers it with no hit.
      if (asked.trim()) {
        // The service ranks every note under wiki/, the structural pages included, and returns at most 20: ask
        // for enough that dropping those pages still leaves `wanted` hits, and for all 20 when it did not.
        for (const ask of new Set([Math.min(MAX_SEARCH_LIMIT, wanted + SEARCH_STRUCTURAL_SLACK), MAX_SEARCH_LIMIT])) {
          const found = await this.client.search(this.userId, asked, ask, "wiki");
          hits = found.hits.filter((hit) => isSearchableNote(hit.path));
          unscanned = found.unscanned;
          if (hits.length >= wanted || found.hits.length < ask) break;
        }
      }
      if (hits.length === 0 && !(await this.holdsVault())) return { kind: "no_vault" };
      return { kind: "ok", hits: hits.slice(0, wanted), ...(unscanned > 0 ? { unscanned } : {}) };
    });
  }

  /** Whether the service holds any note under `wiki/` or `raw/`. */
  private async holdsVault(): Promise<boolean> {
    for (const folder of ["wiki", "raw"]) {
      if ((await this.client.list(this.userId, folder)).length > 0) return true;
    }
    return false;
  }
}

/** A row says the vault is in the service, but this server was started without one: every use fails as unavailable. */
function unconfiguredClient(): MemoryClient {
  const fail = () =>
    Promise.reject(
      new MemoryUnavailableError(
        "memory service unavailable: this owner's vault lives in the memory service, but this server has none configured (PI_MEMORY_URL, PI_MEMORY_API_KEY_FILE)",
        "not_configured",
      ),
    );
  return { list: fail, read: fail, put: fail, remove: fail, search: fail, deleteWiki: fail };
}

/** The owner's vault over this server's client — or over one that fails every call when the server has none. */
function vaultOver(store: Store, config: AppConfig, userId: string, inQueue: boolean): ServiceMemoryVault {
  return new ServiceMemoryVault(store, memoryClientFor(store, config) ?? unconfiguredClient(), userId, inQueue);
}

/**
 * The owner's vault when (and only when) its home is `memory`; null otherwise
 * — the caller then runs today's clone code unchanged. Never throws itself:
 * the vault's methods reject with `MemoryUnavailableError` when the service
 * cannot be used (also when this server has no memory service configured —
 * falling back to the clone would be a second writer).
 *
 * For READS, and for a write that is not already inside the owner's queue. A
 * tool operation that CHANGES a vault path goes through {@link withVaultWrite}
 * instead, so that the home is decided inside the queue.
 */
export function memoryVaultFor(store: Store, config: AppConfig, userId: string): MemoryVault | null {
  if (!store.getPersonalVault(userId)) return null;
  return vaultOver(store, config, userId, false);
}

/**
 * Run a vault-changing operation of this owner inside their vault write queue,
 * with the home decided INSIDE the queue:
 * - `{ home: "repo" }` — run today's clone code, here, inside the queue;
 * - `{ home: "memory", vault }` — write through `vault`, whose
 *   `write`/`edit`/`remove` do not take the queue again (its reads are the
 *   ordinary ones). `vault` is valid only until `fn` finishes.
 *
 * The cutover and the rollback hold the same queue ({@link withVaultWriteLock}),
 * so the home cannot change while `fn` runs, whatever kind of run it is in.
 * NOT re-entrant: inside `fn`, never call this function, `withVaultWriteLock`
 * or a write of a `memoryVaultFor` vault for the same owner — it would wait for
 * `fn` itself. Take the repo lock INSIDE `fn`, never around this call.
 */
export function withVaultWrite<T>(
  store: Store,
  config: AppConfig,
  userId: string,
  fn: (target: VaultWriteTarget) => Promise<T>,
): Promise<T> {
  return withVaultWriteLock(store, userId, async () => {
    if (!store.getPersonalVault(userId)) return fn({ home: "repo" });
    const vault = vaultOver(store, config, userId, true);
    try {
      return await fn({ home: "memory", vault: vault as ServiceMemoryVault & { inQueue: true } });
    } finally {
      vault.close();
    }
  });
}
