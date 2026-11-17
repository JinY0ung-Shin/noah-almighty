// Build a `[[wikilink]]` graph over a knowledge repo's second-brain vault, for
// the client's interactive graph view (Obsidian-style). Pure read over an
// already-cloned working tree — no git/network: the caller hands in `repoRoot`
// (e.g. from `ensureClone`). Mirrors brainSearch.ts's no-new-infra philosophy:
// walk the markdown, parse minimal frontmatter, regex out `[[links]]`, resolve
// each to a note by stem/title/alias/path. Unresolved targets become "dangling"
// nodes (as Obsidian shows them) so the graph still reflects intent.

import { listTree, readFile } from "./knowledgeRepo.js";
import { parseNoteFrontmatter } from "./agent/brainSearch.js";
import type { KnowledgeGraph, KnowledgeGraphNode } from "./types.js";

// Hard cap on notes scanned — protects the endpoint from a pathological vault.
// `listTree` orders by path (not recency), so a very large vault truncates by
// path order; acceptable at expected scale (the same path-order trade-off as brainSearch `BRAIN_SCAN_CAP`, which reports what it skips).
const SCAN_CAP = 1000;

// `[[target]]`, `[[target|alias]]`, `[[target#heading]]`, `[[target^block]]`.
// Captures the raw inside; we strip the alias/anchor parts when resolving.
const WIKILINK_RE = /\[\[([^\]\[\n]+?)\]\]/g;

/**
 * A repo-relative path the graph view may read as a note: a markdown file inside
 * the second-brain vault (`wiki/` or `raw/`), never a `_template.md`. A permissive
 * SUPERSET of the filter `buildKnowledgeGraph` uses: every real node id (which IS a
 * repo-relative path) passes, so the content endpoint can trust it — while the
 * structural `wiki/index.md` / `wiki/log.md` stay readable here but are never nodes.
 */
export function isVaultNotePath(relPath: unknown): relPath is string {
  return (
    typeof relPath === "string" &&
    relPath.endsWith(".md") &&
    !relPath.endsWith("_template.md") &&
    (relPath.startsWith("wiki/") || relPath.startsWith("raw/"))
  );
}

/**
 * Section bucket for node coloring, derived from the note's vault path — the
 * PERSONAL second-brain layout. The team vault passes its own (`teamSectionOf`).
 */
export function vaultSectionOf(relPath: string): string {
  if (relPath.startsWith("raw/")) return "raw";
  for (const s of ["sources", "entities", "concepts", "synthesis"]) {
    if (relPath.startsWith(`wiki/${s}/`)) return s;
  }
  if (relPath.startsWith("wiki/")) return "wiki";
  return "other";
}

function stemOf(relPath: string): string {
  return relPath.split("/").pop()?.replace(/\.md$/i, "") ?? relPath;
}

/** Normalize a link target / index key for case-insensitive matching. */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Strip the `|alias` and `#heading`/`^block` parts off a raw `[[target...]]`. */
function linkTarget(raw: string): string {
  let t = raw.split("|")[0];
  t = t.split("#")[0].split("^")[0];
  return t.trim();
}

/**
 * Build the wikilink graph for an already-cloned knowledge repo. Returns
 * `{noVault:true}` (empty graph) when the repo predates the vault layout, so the
 * client can point the owner at brain-migrate — distinct from a present-but-empty
 * vault (`nodes:[]` with `noVault` unset).
 */
export async function buildKnowledgeGraph(
  repoRoot: string,
  opts: { sectionOf?: (relPath: string) => string } = {},
): Promise<KnowledgeGraph> {
  return graphOf(
    await listTree(repoRoot),
    // FILE_TOO_LARGE / unreadable — skip this note, never abort the build.
    (relPath) => readFile(repoRoot, relPath).catch(() => null),
    opts.sectionOf ?? vaultSectionOf,
  );
}

/**
 * Notes that are not files of a directory — the personal vault of an owner
 * whose vault lives in the memory service.
 */
export interface KnowledgeNoteSource {
  /** Every note of the vault (any order). */
  list(): Promise<Array<{ path: string }>>;
  /**
   * One note's text. Resolve with null to leave a note out of the graph (it is
   * gone, unreadable); REJECT to abort the build — a source that cannot be
   * used must not come back as a graph with notes missing.
   */
  read(relPath: string): Promise<string | null>;
}

/** Notes read at a time from a {@link KnowledgeNoteSource} (each read is a request). */
const SOURCE_READ_CONCURRENCY = 8;

/**
 * {@link buildKnowledgeGraph} over a note source instead of a cloned working
 * tree: same notes, same order (path order, as `listTree` gives it), same
 * nodes and edges. `{noVault:true}` when the source holds no note under
 * `wiki/` or `raw/` (a source has no empty folders to tell the two apart).
 */
export async function buildKnowledgeGraphFromNotes(
  source: KnowledgeNoteSource,
  opts: { sectionOf?: (relPath: string) => string } = {},
): Promise<KnowledgeGraph> {
  const entries = (await source.list())
    .map((note) => ({ path: note.path, type: "file" }))
    .sort((a, b) => a.path.localeCompare(b.path));
  // Read the notes the graph will use a few at a time, up front; the graph is then built from them in order.
  const wanted = entries.filter(isGraphNote).slice(0, SCAN_CAP);
  const contents = new Map<string, string | null>();
  for (let at = 0; at < wanted.length; at += SOURCE_READ_CONCURRENCY) {
    const batch = wanted.slice(at, at + SOURCE_READ_CONCURRENCY);
    const read = await Promise.all(batch.map((note) => source.read(note.path)));
    for (const [i, note] of batch.entries()) contents.set(note.path, read[i]);
  }
  return graphOf(entries, async (relPath) => contents.get(relPath) ?? null, opts.sectionOf ?? vaultSectionOf);
}

/** A tree entry the graph reads as a note: vault markdown, minus templates and the structural index/log. */
function isGraphNote(e: { path: string; type: string }): boolean {
  return (
    e.type === "file" &&
    e.path.endsWith(".md") &&
    !e.path.endsWith("_template.md") &&
    e.path !== "wiki/index.md" &&
    e.path !== "wiki/log.md" &&
    (e.path.startsWith("wiki/") || e.path.startsWith("raw/"))
  );
}

/**
 * The graph of a vault given as its entries (`listTree`'s shape and order) and
 * a way to read one note (null = skip it).
 */
async function graphOf(
  entries: Array<{ path: string; type: string }>,
  readNote: (relPath: string) => Promise<string | null>,
  sectionOf: (relPath: string) => string,
): Promise<KnowledgeGraph> {
  const hasVault = entries.some(
    (e) => e.path === "wiki" || e.path.startsWith("wiki/") || e.path === "raw" || e.path.startsWith("raw/"),
  );
  if (!hasVault) {
    return { nodes: [], edges: [], noVault: true };
  }

  // `wiki/index.md` (the table of contents) and `wiki/log.md` (brain-reflect's
  // append-only pass log) are STRUCTURAL, not knowledge notes — excluded here exactly
  // as `rankBrainNotes` excludes them from search, so a freshly seeded vault renders
  // the client's empty state and the TOC never becomes a hub wired to every note.
  const noteFiles = entries.filter(isGraphNote).slice(0, SCAN_CAP);

  // First pass: read every note, build nodes + a resolution index
  // (stem / title / aliases / path-without-ext → node id).
  const nodes = new Map<string, KnowledgeGraphNode>();
  const index = new Map<string, string>();
  const bodies = new Map<string, string>();

  for (const f of noteFiles) {
    const content = await readNote(f.path);
    if (content === null) continue;
    const { fm, body } = parseNoteFrontmatter(content);
    const stem = stemOf(f.path);
    const label = fm.title || stem;
    nodes.set(f.path, { id: f.path, label, section: sectionOf(f.path), tags: fm.tags });
    bodies.set(f.path, body);

    // Index keys (first writer wins on collision — deterministic by path order).
    const keys = [stem, fm.title, f.path.replace(/\.md$/i, ""), ...fm.aliases];
    for (const k of keys) {
      const nk = norm(k);
      if (nk && !index.has(nk)) index.set(nk, f.path);
    }
  }

  // Second pass: extract `[[links]]`, resolve, build de-duplicated directed edges.
  const edgeSet = new Set<string>();
  const edges: KnowledgeGraph["edges"] = [];
  for (const [sourceId, body] of bodies) {
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(body)) !== null) {
      const target = linkTarget(m[1]);
      if (!target) continue;
      const resolved = index.get(norm(target));
      let targetId: string;
      if (resolved) {
        targetId = resolved;
      } else {
        // Dangling link → a placeholder node, as Obsidian's graph shows it.
        targetId = `unresolved:${norm(target)}`;
        if (!nodes.has(targetId)) {
          nodes.set(targetId, { id: targetId, label: target, section: "unresolved", tags: [], dangling: true });
        }
      }
      if (targetId === sourceId) continue; // ignore self-links
      const key = `${sourceId}\n${targetId}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ source: sourceId, target: targetId });
    }
  }

  return { nodes: [...nodes.values()], edges };
}
