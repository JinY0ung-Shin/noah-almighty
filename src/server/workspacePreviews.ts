/**
 * Page images for a document in a user's sandbox workspace — the 파일 tab's
 * preview of a pdf, pptx or docx (`routes/workspaceFiles.ts`). The tab cannot
 * draw these formats itself, so the SERVER renders them with the converter the
 * file cards already use (`renderDocumentPreviews`: LibreOffice → pdf →
 * pdftoppm, first 30 pages; a pdf skips LibreOffice). A .pptx the bundled
 * `pptx` skill built comes with exact renders next to it (`<stem>.preview/`),
 * which are used instead when they are bound to these very bytes.
 *
 * What makes this different from the tab's other previews:
 *
 * - **Noah converts a copy, never the workspace file.** The workspace is
 *   agent-writable, so a path into it can be swapped for a link at any time.
 *   The bytes are read ONCE through the pinned descriptor
 *   (`openWorkspaceFile`), bounded by the cap itself, and written to a private
 *   file of Noah's own under a fixed name; only that file is handed to the
 *   converter, and it is removed when the conversion ends. The magic check
 *   (`%PDF`, a zip's `PK`) only turns away the obviously wrong: what makes an
 *   untrusted document safe to convert is `renderDocumentPreviews` itself —
 *   the format's own import filter forced, linked content and macros off.
 * - **The renders are a CACHE, and it empties itself.** Pages live under
 *   `<dataDir>/workspace-previews/<u-key>/<id>/` so the browser can fetch them
 *   one by one. An entry is dropped once it is `CACHE_TTL_MS` old or the user
 *   holds more than `CACHE_MAX_ENTRIES_PER_USER`; the whole folder goes with
 *   the account (`deleteWorkspacePreviewsForUser`) and is cleared at boot. Nothing else points at
 *   it — no table, no message — so there is nothing to cascade.
 * - **Converting is slow and heavy**, so a request never waits for it: the
 *   first one starts the job and later ones ask again (`rendering`). At most
 *   `MAX_CONCURRENT` conversions run at a time, one per user; a failure is
 *   remembered briefly so a poll does not start the same doomed job again.
 *
 * `id` is derived from what the kernel says the opened file IS (device, inode,
 * size, mtime) plus the user, so a rewritten file is a new entry and the
 * browser never shows an older version's pages under the new one's name. It is
 * not a content hash: a file whose bytes change while its size and mtime are
 * forced back keeps its old pages until the entry expires — it is the user's
 * own file in their own sandbox, and the download is always the real bytes.
 *
 * The state (jobs in flight, recent failures) belongs to ONE instance made by
 * the router factory — no module-level mutable state.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { piUserKey } from "./agent/pi/piWorkspace.js";
import { loadConverterPreviews } from "./deckPreview.js";
import { probeDocumentPreviews, renderDocumentPreviews } from "./deckRender.js";
import logger from "./logger.js";
import { procFdAvailable } from "./pinnedFs.js";
import type { AppConfig } from "./types.js";
import { openWorkspaceFile, workspaceBrowserAvailable } from "./workspaceBrowser.js";
import {
  WORKSPACE_DOCUMENT_PREVIEW_MAX_BYTES,
  WORKSPACE_DOCUMENT_PREVIEW_MAX_PAGES,
  workspaceDocumentExtension,
  type WorkspaceDocumentExtension,
  type WorkspaceDocumentPreview,
  type WorkspaceDocumentPreviewFailure,
} from "../shared/workspaceFiles.js";

/** Conversions running at once (LibreOffice is the cost), and per user. */
const MAX_CONCURRENT = 2;
const MAX_CONCURRENT_PER_USER = 1;
/** How long a request waits for a conversion it started or found running before answering `rendering`. */
const REQUEST_WAIT_MS = 8_000;
/** How long a failed conversion is remembered (a poll must not start the same job again). */
const FAILURE_MEMORY_MS = 5 * 60_000;
const CACHE_TTL_MS = 6 * 60 * 60_000;
const CACHE_MAX_ENTRIES_PER_USER = 20;
const SWEEP_INTERVAL_MS = 10 * 60_000;

/** A staging folder younger than this belongs to a conversion that may still be writing it. */
const STAGING_GRACE_MS = 30 * 60_000;

const PREVIEW_ID = /^[0-9a-f]{64}$/;
/** Where a conversion keeps its private copy of the document (inside the cache root: cleared with it at boot). */
const WORK_DIR = ".work";

const readAsync = promisify(fs.read);

/**
 * The bytes of an open file, or null when it holds more than `max`. Read in
 * chunks against the limit itself — never by the size a stat reported, which
 * the sandbox can change between the stat and the read.
 */
async function readBounded(fd: number, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, max + 1 - total));
    const { bytesRead } = await readAsync(fd, chunk, 0, chunk.length, total);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > max) return null;
    chunks.push(chunk.subarray(0, bytesRead));
  }
}
const META_FILE = "meta.json";

const MAGIC: Record<WorkspaceDocumentExtension, Buffer> = {
  pdf: Buffer.from("%PDF"),
  pptx: Buffer.from("PK"),
  docx: Buffer.from("PK"),
};

const PAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

interface PageImage {
  buffer: Buffer;
  mediaType: string;
}

interface CacheMeta {
  pages: { file: string; mediaType: string }[];
}

export interface WorkspacePreviewPage {
  path: string;
  mediaType: string;
}

/** The converter, replaceable in tests (the real one needs LibreOffice). */
export interface WorkspacePreviewDeps {
  available: () => boolean;
  render: (sourcePath: string, ext: string) => Promise<Buffer[]>;
  now: () => number;
  requestWaitMs: number;
}

const DEFAULT_DEPS: WorkspacePreviewDeps = {
  available: probeDocumentPreviews,
  render: renderDocumentPreviews,
  now: Date.now,
  requestWaitMs: REQUEST_WAIT_MS,
};

function cacheRootOf(config: AppConfig): string {
  return path.join(config.dataDir, "workspace-previews");
}

/** Remove everything rendered for a user (account deletion — the cache is a per-user folder on disk). */
export function deleteWorkspacePreviewsForUser(config: AppConfig, userId: string): void {
  fs.rmSync(path.join(cacheRootOf(config), piUserKey(userId)), { recursive: true, force: true });
}

function failed(reason: WorkspaceDocumentPreviewFailure): WorkspaceDocumentPreview {
  return { status: "failed", reason };
}

export class WorkspaceDocumentPreviews {
  private readonly deps: WorkspacePreviewDeps;
  /** Conversions in flight by `<u-key>/<id>`; each resolves to its page count (0 = failed). */
  private readonly jobs = new Map<string, Promise<number>>();
  private readonly failures = new Map<string, { at: number; reason: WorkspaceDocumentPreviewFailure }>();
  private readonly runningByUser = new Map<string, number>();
  private running = 0;
  private lastSweep = 0;

  constructor(
    private readonly config: AppConfig,
    deps: Partial<WorkspacePreviewDeps> = {},
  ) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
    // A restart loses the jobs; what they left half-written — pages and the
    // private copies under `.work` — and every older entry goes with it. The
    // cache is only ever a convenience.
    fs.rmSync(this.cacheRoot(), { recursive: true, force: true });
    // Entries expire even when nobody asks for a preview again.
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS).unref();
  }

  private cacheRoot(): string {
    return cacheRootOf(this.config);
  }

  private userDir(userId: string): string {
    return path.join(this.cacheRoot(), piUserKey(userId));
  }

  /**
   * The page images of one document of `userId`'s workspace, or how far along
   * they are. "unavailable" / "not_found" as `openWorkspaceFile`; "not_document"
   * for a name that is not a pdf, pptx or docx. `retry` forgets a remembered
   * failure (the viewer pressed 새로고침).
   */
  async request(
    userId: string,
    segments: readonly string[],
    options: { retry?: boolean } = {},
  ): Promise<WorkspaceDocumentPreview | "unavailable" | "not_found" | "not_document"> {
    if (!workspaceBrowserAvailable(this.config)) return "unavailable";
    const ext = workspaceDocumentExtension(segments[segments.length - 1] ?? "");
    if (!ext) return "not_document";
    if (!this.deps.available()) return failed("UNAVAILABLE");
    this.sweep();

    const file = openWorkspaceFile(this.config, userId, segments);
    if (file === "unavailable" || file === "not_found") return file;
    let handedOver = false;
    try {
      const stat = fs.fstatSync(file.fd, { bigint: true });
      if (stat.size > BigInt(WORKSPACE_DOCUMENT_PREVIEW_MAX_BYTES)) return failed("TOO_LARGE");
      const id = crypto
        .createHash("sha256")
        .update([userId, stat.dev, stat.ino, stat.size, stat.mtimeNs, ext].join("\0"))
        .digest("hex");
      const key = `${piUserKey(userId)}/${id}`;

      const cached = this.readMeta(userId, id);
      if (cached) return { status: "ready", id, pages: cached.pages.length };

      const running = this.jobs.get(key);
      if (running) return this.answer(id, running);

      const failure = this.failures.get(key);
      if (failure) {
        if (!options.retry && this.deps.now() - failure.at < FAILURE_MEMORY_MS) return failed(failure.reason);
        this.failures.delete(key);
      }

      if (this.running >= MAX_CONCURRENT || (this.runningByUser.get(userId) ?? 0) >= MAX_CONCURRENT_PER_USER) {
        return { status: "rendering", waiting: true };
      }

      // The ONE read of the workspace file: everything after works on these
      // bytes. Bounded by the cap itself — the size above is only what the file
      // was a moment ago.
      const bytes = await readBounded(file.fd, WORKSPACE_DOCUMENT_PREVIEW_MAX_BYTES);
      if (!bytes) return failed("TOO_LARGE");
      // Another request may have started this document while the read ran.
      const started = this.jobs.get(key);
      if (started) return this.answer(id, started);
      if (this.running >= MAX_CONCURRENT || (this.runningByUser.get(userId) ?? 0) >= MAX_CONCURRENT_PER_USER) {
        return { status: "rendering", waiting: true };
      }
      if (!bytes.subarray(0, MAGIC[ext].length).equals(MAGIC[ext])) {
        this.failures.set(key, { at: this.deps.now(), reason: "BAD_FORMAT" });
        return failed("BAD_FORMAT");
      }
      // Where the kernel says the opened file is — for the deck sidecar next to it.
      let sourcePath: string | null = null;
      try {
        if (procFdAvailable()) sourcePath = fs.readlinkSync(`/proc/self/fd/${file.fd}`);
      } catch {
        sourcePath = null; // no sidecar lookup: LibreOffice renders the deck
      }

      this.running += 1;
      this.runningByUser.set(userId, (this.runningByUser.get(userId) ?? 0) + 1);
      const job = this.convert(userId, id, ext, bytes, sourcePath)
        .catch((error: unknown) => {
          logger.warn({ module: "workspace-previews", err: String(error), ext }, "document preview failed");
          return 0;
        })
        .then((pages) => {
          if (!pages) this.failures.set(key, { at: this.deps.now(), reason: "RENDER_FAILED" });
          return pages;
        })
        .finally(() => {
          this.jobs.delete(key);
          this.running -= 1;
          const left = (this.runningByUser.get(userId) ?? 1) - 1;
          if (left > 0) this.runningByUser.set(userId, left);
          else this.runningByUser.delete(userId);
        });
      this.jobs.set(key, job);
      handedOver = true;
      fs.closeSync(file.fd);
      return this.answer(id, job);
    } finally {
      if (!handedOver) fs.closeSync(file.fd);
    }
  }

  /** `ready` when the job ends within the wait, `rendering` when it does not, `failed` when it ended with nothing. */
  private async answer(id: string, job: Promise<number>): Promise<WorkspaceDocumentPreview> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.deps.requestWaitMs);
    });
    const pages = await Promise.race([job, waited]);
    clearTimeout(timer);
    if (pages === null) return { status: "rendering" };
    return pages > 0 ? { status: "ready", id, pages } : failed("RENDER_FAILED");
  }

  /** Render `bytes` and store the pages; resolves to the page count (0 = nothing came out). */
  private async convert(
    userId: string,
    id: string,
    ext: WorkspaceDocumentExtension,
    bytes: Buffer,
    sourcePath: string | null,
  ): Promise<number> {
    let pages: PageImage[] = [];
    if (ext === "pptx" && sourcePath) pages = await this.deckSidecarPages(userId, sourcePath, bytes);
    if (!pages.length) {
      const workRoot = path.join(this.cacheRoot(), WORK_DIR);
      await fs.promises.mkdir(workRoot, { recursive: true, mode: 0o700 });
      const workDir = await fs.promises.mkdtemp(path.join(workRoot, "doc-"));
      try {
        // A fixed name: the workspace file's own name never reaches a command line.
        const copy = path.join(workDir, `document.${ext}`);
        await fs.promises.writeFile(copy, bytes, { mode: 0o600 });
        const rendered = await this.deps.render(copy, ext);
        pages = rendered
          .slice(0, WORKSPACE_DOCUMENT_PREVIEW_MAX_PAGES)
          .map((buffer) => ({ buffer, mediaType: "image/png" }));
      } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    if (!pages.length) return 0;
    await this.store(userId, id, pages);
    return pages.length;
  }

  /**
   * The converter's own renders for a deck it built, when its sidecar is bound
   * to exactly these bytes (`loadConverterPreviews` checks the hash before it
   * reads an image, and every read stays inside the user's root). Anything
   * else — no sidecar, a stale or invalid one — is an empty list: LibreOffice
   * renders the deck instead.
   */
  private async deckSidecarPages(userId: string, sourcePath: string, bytes: Buffer): Promise<PageImage[]> {
    const workspacesDir = this.config.pi?.workspacesDir;
    if (!workspacesDir) return [];
    const loaded = await loadConverterPreviews({
      sourcePath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      allowedRoots: [path.join(workspacesDir, piUserKey(userId))],
      maxPages: WORKSPACE_DOCUMENT_PREVIEW_MAX_PAGES,
    });
    if (loaded.status !== "loaded") return [];
    return loaded.slides
      .filter((slide) => PAGE_EXTENSIONS[slide.mediaType])
      .map((slide) => ({ buffer: slide.buffer, mediaType: slide.mediaType }));
  }

  /** Write the pages beside each other, then publish the folder in one rename (a reader never sees half of it). */
  private async store(userId: string, id: string, pages: PageImage[]): Promise<void> {
    const userDir = this.userDir(userId);
    await fs.promises.mkdir(userDir, { recursive: true, mode: 0o700 });
    const staging = path.join(userDir, `.tmp-${crypto.randomBytes(8).toString("hex")}`);
    await fs.promises.mkdir(staging, { mode: 0o700 });
    try {
      const meta: CacheMeta = { pages: [] };
      for (const [index, page] of pages.entries()) {
        const file = `page-${index + 1}.${PAGE_EXTENSIONS[page.mediaType]}`;
        await fs.promises.writeFile(path.join(staging, file), page.buffer, { mode: 0o600 });
        meta.pages.push({ file, mediaType: page.mediaType });
      }
      await fs.promises.writeFile(path.join(staging, META_FILE), JSON.stringify(meta), { mode: 0o600 });
      const target = path.join(userDir, id);
      await fs.promises.rm(target, { recursive: true, force: true });
      await fs.promises.rename(staging, target);
    } catch (error) {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private readMeta(userId: string, id: string): CacheMeta | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.userDir(userId), id, META_FILE), "utf8")) as CacheMeta;
      if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** One rendered page of the CALLER's own document, or null (an unknown id, a page past the end, an expired entry). */
  page(userId: string, id: unknown, n: unknown): WorkspacePreviewPage | null {
    if (typeof id !== "string" || !PREVIEW_ID.test(id)) return null;
    const index = typeof n === "string" && /^[1-9]\d{0,2}$/.test(n) ? Number(n) : 0;
    const entry = index ? this.readMeta(userId, id)?.pages[index - 1] : undefined;
    // The names in meta.json are Noah's own (`page-N.<ext>`); the check keeps a damaged file from naming anything else.
    if (!entry || !/^page-\d+\.(?:png|jpg|webp)$/.test(entry.file) || !PAGE_EXTENSIONS[entry.mediaType]) return null;
    return { path: path.join(this.userDir(userId), id, entry.file), mediaType: entry.mediaType };
  }

  /** Drop expired entries and each user's oldest past the cap. At most once per `SWEEP_INTERVAL_MS`; best effort. */
  private sweep(): void {
    const now = this.deps.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS / 2) return;
    this.lastSweep = now;
    for (const [key, failure] of this.failures) {
      if (now - failure.at >= FAILURE_MEMORY_MS) this.failures.delete(key);
    }
    let users: string[];
    try {
      users = fs.readdirSync(this.cacheRoot());
    } catch {
      return;
    }
    for (const user of users) {
      if (user === WORK_DIR) continue; // conversions clean up their own copies; boot clears the rest
      const dir = path.join(this.cacheRoot(), user);
      try {
        const entries = fs
          .readdirSync(dir)
          .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
          // A conversion still writing its staging folder is left alone.
          .filter((entry) => !(entry.name.startsWith(".tmp-") && now - entry.at < STAGING_GRACE_MS))
          .sort((a, b) => b.at - a.at);
        entries.forEach((entry, position) => {
          if (now - entry.at >= CACHE_TTL_MS || position >= CACHE_MAX_ENTRIES_PER_USER) {
            fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
          }
        });
      } catch {
        /* best effort: the next sweep tries again */
      }
    }
  }
}
