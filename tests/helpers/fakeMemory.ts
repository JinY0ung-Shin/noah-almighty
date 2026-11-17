/**
 * An in-process memory service for tests: the SAME rules as the real one
 * (pi-gateway `apps/memory`: `wiki.ts`, `search.ts`, `rest.ts`), behind the
 * `MemoryClient` interface. A test double — never imported by `src/`.
 *
 * Rules kept: paths are relative `.md` paths stored NFC (no segment starting
 * with a dot, no `..`, no control character or backslash, at most 16 parts,
 * 512 bytes, 255 per part); a prefix is a FOLDER; a note is at most 512 KiB of
 * text without NUL; `hash` = sha256 hex of the bytes; create refuses `exists`,
 * replace/delete refuse `stale`; a wiki holds at most 10,000 notes / 256 MiB
 * (`wiki_full`); a search query is at most 500 characters (`invalid_request`
 * past that); search scores every note under the prefix (title/aliases 5,
 * tags 3, whole text 1), reads the first 2,000 in path order and reports the
 * rest as `unscanned`.
 *
 * "500 characters" is the service's `z.string().max(500)`, and what that counts
 * depends on the zod it runs: measured against the real service code, its
 * pinned zod 4.6.7 counts CODE POINTS (`"😀".repeat(500)` is accepted), while
 * zod 4.4.x counts UTF-16 units (`"😀".repeat(251)` is refused). The fake
 * counts UTF-16 units by default — the stricter rule, so a query it accepts
 * passes either service; `queryLength: "codePoints"` is the pinned service's.
 *
 * Like the HTTP client, `read` answers null for a missing note and `remove`
 * resolves for one that is already gone.
 */
import { createHash } from "node:crypto";
import {
  MemoryRefusedError,
  type MemoryClient,
  type MemoryNote,
  type MemoryNoteEntry,
  type MemorySearchHit,
} from "../../src/server/memory/memoryClient.js";

export const FAKE_MEMORY_MAX_NOTE_BYTES = 512 * 1024;
const MAX_NOTES = 10_000;
const MAX_WIKI_BYTES = 256 * 1024 * 1024;
const MAX_PATH_BYTES = 512;
const MAX_SEGMENT_BYTES = 255;
const MAX_DEPTH = 16;
const SCAN_CAP = 2000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_QUERY_CHARS = 500;
const SNIPPET_RADIUS = 90;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

export type FakeMemoryOp = keyof MemoryClient;

export interface FakeMemoryCall {
  op: FakeMemoryOp;
  owner: string;
  path?: string;
  prefix?: string;
  query?: string;
  limit?: number;
  hash?: string;
}

export interface FakeMemoryClient extends MemoryClient {
  /**
   * Make the next call fail with `error` — the next call of any method, or of
   * `options.op` only. `options.applied`: the operation is carried out first
   * and THEN fails (an answer lost on the way back).
   */
  failNext(error: Error, options?: { op?: FakeMemoryOp; applied?: boolean }): void;
  /** Run `fn` once, just before the next call of `op` is carried out (something else writing in between). */
  beforeNext(op: FakeMemoryOp, fn: () => void | Promise<void>): void;
  /** The owner's notes, `path → content`, in path order. */
  dump(owner: string): Record<string, string>;
  /** Put a note in place without going through the rules' write path (still normalized and hashed). */
  seed(owner: string, path: string, content: string): void;
  /** Every call so far, in order. */
  readonly calls: FakeMemoryCall[];
}

export function fakeMemoryHash(content: string): string {
  return createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

const refuse = (code: string, status: number, message: string) => new MemoryRefusedError(code, status, message);

function segmentsOf(raw: string): string[] {
  const text = raw.normalize("NFC");
  if (Buffer.byteLength(text) > MAX_PATH_BYTES) throw refuse("invalid_path", 400, `a path is at most ${MAX_PATH_BYTES} bytes`);
  if (/[\u0000-\u001f\u007f\\]/.test(text)) throw refuse("invalid_path", 400, "a path must not contain control characters or backslashes");
  const segments = text.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length > MAX_DEPTH) throw refuse("invalid_path", 400, `a path has at most ${MAX_DEPTH} parts (folders and the note name)`);
  for (const s of segments) {
    if (s.startsWith(".")) throw refuse("invalid_path", 400, `'${s}': a folder or note name must not start with a dot`);
    if (Buffer.byteLength(s) > MAX_SEGMENT_BYTES) throw refuse("invalid_path", 400, `a folder or note name is at most ${MAX_SEGMENT_BYTES} bytes`);
  }
  return segments;
}

function normalizeNotePath(raw: string): string {
  const segments = segmentsOf(raw);
  if (!segments.at(-1)?.endsWith(".md")) {
    throw refuse("invalid_path", 400, "a note path is a relative path that ends with .md (e.g. projects/deploy.md)");
  }
  return segments.join("/");
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---- search (the service's search.ts) ----------------------------------------

const unquote = (v: string) => v.replace(/^["']|["']$/g, "").trim();
const inlineList = (v: string) =>
  v
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((x) => unquote(x.trim()))
    .filter(Boolean);
const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*$/m;

function parseFrontmatter(content: string): { fm: { title: string; tags: string[]; aliases: string[] }; body: string } {
  const fm = { title: "", tags: [] as string[], aliases: [] as string[] };
  const open = OPEN.exec(content);
  if (!open) return { fm, body: content };
  const rest = content.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) return { fm, body: content };
  const body = rest.slice(close.index + close[0].length).replace(/^\r?\n/, "");
  let listKey: "tags" | "aliases" | null = null;
  for (const raw of rest.slice(0, close.index).split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const v = unquote(item[1]);
      if (v) fm[listKey].push(v);
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    listKey = null;
    const key = kv[1];
    const val = kv[2].trim();
    if (key === "title") {
      fm.title = unquote(val);
    } else if (key === "tags" || key === "aliases") {
      if (val.startsWith("[")) fm[key] = inlineList(val);
      else if (val) fm[key] = [unquote(val)];
      else {
        fm[key] = [];
        listKey = key;
      }
    }
  }
  return { fm, body };
}

function snippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = at === -1 ? 0 : Math.max(0, at - SNIPPET_RADIUS);
  const end = start + SNIPPET_RADIUS * 2;
  return `${start > 0 ? "…" : ""}${body.slice(start, end).replace(/\s+/g, " ").trim()}${end < body.length ? "…" : ""}`;
}

function searchNotes(notes: [string, string][], query: string, limit: number): { hits: MemorySearchHit[]; unscanned: number } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scanned = notes.slice(0, SCAN_CAP);
  const hits: MemorySearchHit[] = [];
  for (const [path, content] of scanned) {
    const { fm, body } = parseFrontmatter(content);
    const title = fm.title || (path.split("/").pop() ?? path).replace(/\.md$/, "");
    const titleHay = `${title} ${fm.aliases.join(" ")}`.toLowerCase();
    const tagHay = fm.tags.join(" ").toLowerCase();
    const bodyHay = content.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (titleHay.includes(t)) score += 5;
      if (tagHay.includes(t)) score += 3;
      if (bodyHay.includes(t)) score += 1;
    }
    if (score > 0) hits.push({ path, title, tags: fm.tags, snippet: snippet(body, terms), score });
  }
  hits.sort((a, b) => b.score - a.score || byPath(a.path, b.path));
  return { hits: hits.slice(0, Math.min(Math.max(1, limit), MAX_LIMIT)), unscanned: notes.length - scanned.length };
}

// ---- the store ----------------------------------------------------------------

export interface FakeMemoryOptions {
  maxNotes?: number;
  maxWikiBytes?: number;
  /** How the 500-character limit of a search query is counted (default `utf16`, the stricter rule). */
  queryLength?: "utf16" | "codePoints";
}

export function createFakeMemoryClient(limits: FakeMemoryOptions = {}): FakeMemoryClient {
  const maxNotes = limits.maxNotes ?? MAX_NOTES;
  const maxWikiBytes = limits.maxWikiBytes ?? MAX_WIKI_BYTES;
  const queryLength = (query: string) => (limits.queryLength === "codePoints" ? [...query].length : query.length);
  const wikis = new Map<string, Map<string, string>>();
  const calls: FakeMemoryCall[] = [];
  const failures: { error: Error; op?: FakeMemoryOp; applied: boolean }[] = [];
  const hooks: { op: FakeMemoryOp; fn: () => void | Promise<void> }[] = [];

  const wikiOf = (owner: string) => {
    let wiki = wikis.get(owner);
    if (!wiki) {
      wiki = new Map();
      wikis.set(owner, wiki);
    }
    return wiki;
  };
  const bytesOf = (content: string) => Buffer.byteLength(content, "utf8");
  const sortedPaths = (wiki: Map<string, string>) => [...wiki.keys()].sort(byPath);

  /** A path through or onto something of the wrong kind (`a.md/b.md` under the note `a.md`; a note named like a folder). */
  function assertPlace(wiki: Map<string, string>, rel: string, want: "note" | "folder"): void {
    const segments = rel.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      const ancestor = segments.slice(0, i).join("/");
      if (wiki.has(ancestor)) throw refuse("invalid_path", 400, `${rel}: '${segments[i - 1]}' is not a folder`);
    }
    const isNote = wiki.has(rel);
    const isFolder = [...wiki.keys()].some((p) => p.startsWith(`${rel}/`));
    if (want === "note" && isFolder) throw refuse("invalid_path", 400, `${rel}: '${segments.at(-1)}' is not a note`);
    if (want === "folder" && isNote) throw refuse("invalid_path", 400, `${rel}: '${segments.at(-1)}' is not a folder`);
  }

  function under(wiki: Map<string, string>, prefix: string | undefined): string[] {
    const folder = prefix === undefined ? "" : segmentsOf(prefix).join("/");
    if (!folder) return sortedPaths(wiki);
    assertPlace(wiki, folder, "folder");
    return sortedPaths(wiki).filter((p) => p.startsWith(`${folder}/`));
  }

  /** Bookkeeping around one operation: the call log, an owner check, hooks, injected failures, a real async gap. */
  async function run<T>(call: FakeMemoryCall, fn: () => T): Promise<T> {
    calls.push(call);
    // Every operation yields first, as a network call would: concurrent callers really interleave.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const failAt = failures.findIndex((f) => !f.op || f.op === call.op);
    const failure = failAt === -1 ? null : failures.splice(failAt, 1)[0];
    if (failure && !failure.applied) throw failure.error;
    const hookAt = hooks.findIndex((h) => h.op === call.op);
    if (hookAt !== -1) await hooks.splice(hookAt, 1)[0].fn();
    if (!OWNER_PATTERN.test(call.owner)) throw refuse("invalid_owner", 400, "the owner in the URL is not a valid user id");
    const result = fn();
    if (failure) throw failure.error;
    return result;
  }

  return {
    calls,

    list(owner, prefix) {
      return run({ op: "list", owner, ...(prefix !== undefined ? { prefix } : {}) }, (): MemoryNoteEntry[] => {
        const wiki = wikiOf(owner);
        return under(wiki, prefix).map((path) => ({ path, bytes: bytesOf(wiki.get(path)!) }));
      });
    },

    read(owner, path) {
      return run({ op: "read", owner, path }, (): MemoryNote | null => {
        const rel = normalizeNotePath(path);
        const wiki = wikiOf(owner);
        assertPlace(wiki, rel, "note");
        const content = wiki.get(rel);
        return content === undefined ? null : { path: rel, content, hash: fakeMemoryHash(content) };
      });
    },

    put(owner, path, content, hash) {
      return run({ op: "put", owner, path, ...(hash !== undefined ? { hash } : {}) }, () => {
        if (hash !== undefined && !HASH_PATTERN.test(hash)) throw refuse("invalid_request", 400, "the request does not have the expected fields");
        const rel = normalizeNotePath(path);
        if (content.includes("\0")) throw refuse("invalid_content", 400, "a note is text; it must not contain NUL characters");
        const size = bytesOf(content);
        if (size > FAKE_MEMORY_MAX_NOTE_BYTES) {
          throw refuse("too_large", 413, `a note is at most ${FAKE_MEMORY_MAX_NOTE_BYTES} bytes; this one is ${size}. Split it into several notes`);
        }
        const wiki = wikiOf(owner);
        assertPlace(wiki, rel, "note");
        const before = wiki.get(rel);
        if (hash !== undefined) {
          if (before === undefined) throw refuse("stale", 409, `${rel} does not exist any more: it was deleted since it was read`);
          if (fakeMemoryHash(before) !== hash) throw refuse("stale", 409, `${rel} changed since it was read. Read it again and redo the change on the current text`);
        } else if (before !== undefined) {
          throw refuse("exists", 409, `${rel} already exists. Read it and pass its hash to replace it, or use edit to change part of it`);
        }
        if (before === undefined && wiki.size >= maxNotes) throw refuse("wiki_full", 507, `this wiki already holds ${maxNotes} notes; delete or merge notes first`);
        let total = size - (before === undefined ? 0 : bytesOf(before));
        for (const value of wiki.values()) total += bytesOf(value);
        if (total > maxWikiBytes) throw refuse("wiki_full", 507, `this wiki would exceed ${maxWikiBytes} bytes; delete or shorten notes first`);
        wiki.set(rel, content);
        return { path: rel, hash: fakeMemoryHash(content), created: before === undefined };
      });
    },

    remove(owner, path, hash) {
      return run({ op: "remove", owner, path, hash }, (): void => {
        if (!HASH_PATTERN.test(hash)) throw refuse("invalid_request", 400, "the request does not have the expected fields");
        const rel = normalizeNotePath(path);
        const wiki = wikiOf(owner);
        assertPlace(wiki, rel, "note");
        const before = wiki.get(rel);
        if (before === undefined) return;
        if (fakeMemoryHash(before) !== hash) throw refuse("stale", 409, `${rel} changed since it was read. Read it again and redo the change on the current text`);
        wiki.delete(rel);
      });
    },

    search(owner, query, limit, prefix) {
      return run({ op: "search", owner, query, ...(limit !== undefined ? { limit } : {}), ...(prefix !== undefined ? { prefix } : {}) }, () => {
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
          throw refuse("invalid_request", 400, "the request does not have the expected fields");
        }
        // The service's `q` limit (judged before the query is looked at).
        if (queryLength(query) > MAX_QUERY_CHARS) throw refuse("invalid_request", 400, "the request does not have the expected fields");
        if (!query.trim()) throw refuse("invalid_query", 400, "the query has no words to look for");
        const wiki = wikiOf(owner);
        const notes = under(wiki, prefix).map((path): [string, string] => [path, wiki.get(path)!]);
        return searchNotes(notes, query, limit ?? DEFAULT_LIMIT);
      });
    },

    deleteWiki(owner) {
      return run({ op: "deleteWiki", owner }, (): void => {
        wikis.delete(owner);
      });
    },

    failNext(error, options = {}) {
      failures.push({ error, ...(options.op ? { op: options.op } : {}), applied: options.applied === true });
    },

    beforeNext(op, fn) {
      hooks.push({ op, fn });
    },

    dump(owner) {
      const wiki = wikis.get(owner) ?? new Map<string, string>();
      return Object.fromEntries(sortedPaths(wiki).map((path) => [path, wiki.get(path)!]));
    },

    seed(owner, path, content) {
      wikiOf(owner).set(normalizeNotePath(path), content);
    },
  };
}
