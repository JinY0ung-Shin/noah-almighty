// Team brain (팀 브레인): ONE instance-wide LOCAL git vault at
// <dataDir>/team-brain that ONLY Noah's own code writes. Teammates read it
// (brain search scope "team") and SUBMIT SOURCES; an admin's avatar compiles a
// source into wiki pages under the FIXED schema (teamBrainSchema.ts), the
// server validates the changeset, and an admin decides; every state change is
// a human button press on a chat card (routes/teamBrain.ts). There is no
// `origin` remote — the admin backup is a push-only mirror (teamBrainBackup.ts).
//
// Never hand this tree to a sandbox and never run git in any other `.git`: the
// agent sees note CONTENT only, through the brain tools. All git goes through
// repoGitCore's `git()` (serverGitEnv hardening, config on env, never argv) and
// every write is serialized under ONE withRepoLock key (not reentrant — the
// exported ops take it once, the *Locked internals never do).
//
// Layout (schema v2): SCHEMA.md · POLICY.md (the admins' knobs + guidelines,
// teamBrainPolicy.ts; changed only by a policy card) · raw/YYYY/MM/<date>-<id8>.md
// (immutable sources, committed only at approval) · raw/legacy/ (pre-schema
// notes) · wiki/<type folder>/<slug>.md pages · wiki/index.md + wiki/log.md
// (server-generated on every commit).
//
// Design + mechanics: docs/architecture/team-brain.md.

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { withRepoLock } from "./gitMutex.js";
import { git } from "./repoGitCore.js";
import { safeIdentity } from "./repoGitGuards.js";
import { readFile, writeFile } from "./knowledgeRepo.js";
import { rankBrainNotes, type BrainNoteHit, type BrainSearchResult } from "./agent/brainSearch.js";
import { buildKnowledgeGraph } from "./knowledgeGraph.js";
import logger from "./logger.js";
import {
  TEAM_BRAIN_SCHEMA_MD,
  TEAM_LOG_HEADER,
  TEAM_STRUCTURAL_PATHS,
  formatLogEntry,
  isTeamRawPath,
  parseTeamPage,
  renderTeamIndex,
  schemaVersionOf,
  teamNameKey,
  validateChangeset,
  validateTeamNotePath,
  type ChangesetCheckContext,
  type TeamPageParse,
  type TeamVaultIndexEntry,
} from "./teamBrainSchema.js";
import { TEAM_POLICY_DEFAULT_MD, parseTeamPolicy, reviewAfterCeiling, type TeamPolicyParse } from "./teamBrainPolicy.js";
import {
  TEAM_BRAIN_MAX_CONTENT_BYTES,
  TEAM_BRAIN_SCHEMA_VERSION,
  TEAM_POLICY_PATH,
  type TeamPageChange,
  type TeamPageType,
} from "../shared/teamBrain.js";
import type { AppConfig, KnowledgeGraph } from "./types.js";

// The path / secret checks moved to the pure schema module; this stays their import path.
export { findSecretInText, validateTeamNotePath, type TeamNotePathCheck } from "./teamBrainSchema.js";

/** Directory under dataDir. `group-knowledge` is a RETIRED name — never reuse it. */
export const TEAM_BRAIN_DIR = "team-brain";
export const TEAM_BRAIN_BRANCH = "main";

/** Noah's own committer identity (init, migrations). */
const NOAH_IDENTITY = { name: "Noah Almighty", email: "team-brain@noah-almighty.local" };

const INDEX_PATH = "wiki/index.md";
const LOG_PATH = "wiki/log.md";
const SCHEMA_PATH = "SCHEMA.md";
const POLICY_PATH = TEAM_POLICY_PATH;
/**
 * Bound on the pages listVault READS (content) — a pathological vault never
 * stalls a call. Paths are never capped (one ls-tree), so existence checks
 * (create/update, sources, superseded_by) stay exact beyond it.
 */
const PAGE_CAP = 2000;
/** Health: lists are capped, counts stay exact. */
const HEALTH_LIST_CAP = 50;
/** Health reads at most this many raw files for the suspicious-text scan. */
const HEALTH_RAW_READ_CAP = 500;

type Config = Pick<AppConfig, "dataDir">;

export function teamBrainRoot(config: Config): string {
  return path.join(config.dataDir, TEAM_BRAIN_DIR);
}

/** True once the vault exists on disk (it is created lazily on first use). */
export function teamBrainInitialized(config: Config): boolean {
  return fsSync.existsSync(path.join(teamBrainRoot(config), ".git"));
}

export function contentTooLarge(content: string): boolean {
  return Buffer.byteLength(content, "utf8") > TEAM_BRAIN_MAX_CONTENT_BYTES;
}

function isPagePath(p: string): boolean {
  return p.startsWith("wiki/") && p.endsWith(".md") && !p.endsWith("_template.md") && !TEAM_STRUCTURAL_PATHS.has(p);
}

function identityConfig(identity: { name: string; email: string }) {
  const { name, email } = safeIdentity(identity);
  return [
    ["user.name", name],
    ["user.email", email],
  ] as const;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function headHasCommit(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** A file's content in HEAD, or null. */
async function showHead(root: string, relPath: string): Promise<string | null> {
  try {
    const { stdout } = await git(root, ["show", `HEAD:${relPath}`]);
    return stdout;
  } catch {
    return null;
  }
}

// ── Vault listing ────────────────────────────────────────────────────────────

export interface TeamVaultListing {
  /** Wiki pages (structural files and templates excluded), parsed — at most PAGE_CAP of them. */
  pages: Map<string, TeamPageParse>;
  /** EVERY tracked wiki page path (never capped). */
  pagePaths: Set<string>;
  /** Committed blob id per tracked path (pages, raw, structural). */
  blobs: Map<string, string>;
  /** raw/ sources in HEAD. */
  rawPaths: Set<string>;
}

/**
 * HEAD's tracked files (`git ls-tree`, regular files only — a link is never a
 * page) with page CONTENT read from the working tree. The two agree: only Noah
 * writes the vault, always under the lock, and a failed write restores every
 * touched path — so outside an in-flight apply the working tree IS HEAD, and
 * the apply path itself lists under the lock. Reading files avoids one git
 * process per page.
 */
async function listVaultAt(root: string): Promise<TeamVaultListing> {
  const pages = new Map<string, TeamPageParse>();
  const pagePaths = new Set<string>();
  const blobs = new Map<string, string>();
  const rawPaths = new Set<string>();
  if (!(await headHasCommit(root))) return { pages, pagePaths, blobs, rawPaths };
  const { stdout } = await git(root, ["ls-tree", "-r", "-z", "HEAD", "--", SCHEMA_PATH, "wiki", "raw"], 60_000);
  for (const entry of stdout.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, blob] = entry.slice(0, tab).split(" ");
    const p = entry.slice(tab + 1);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
    blobs.set(p, blob);
    if (p.startsWith("raw/") && p.endsWith(".md")) rawPaths.add(p);
    else if (isPagePath(p)) pagePaths.add(p);
  }
  for (const p of [...pagePaths].slice(0, PAGE_CAP)) {
    let content: string;
    try {
      content = await readFile(root, p);
    } catch {
      pages.set(p, { ok: false, errors: [`${p}: unreadable (too large or not a regular file)`], title: "" });
      continue;
    }
    pages.set(p, parseTeamPage(p, content));
  }
  return { pages, pagePaths, blobs, rawPaths };
}

/** The vault as HEAD holds it (empty when the vault does not exist yet). */
export async function listTeamVault(config: Config): Promise<TeamVaultListing> {
  if (!teamBrainInitialized(config)) return { pages: new Map(), pagePaths: new Set(), blobs: new Map(), rawPaths: new Set() };
  return listVaultAt(teamBrainRoot(config));
}

/** What `validateChangeset` checks a draft against (the vault as it is now). */
export async function teamChangesetContext(
  config: Config,
  newRawPath: string | null,
  ownSecrets?: Record<string, string>,
): Promise<ChangesetCheckContext> {
  const vault = await listTeamVault(config);
  const policy = await readTeamPolicy(config);
  return {
    pages: vault.pages,
    knownPagePaths: vault.pagePaths,
    rawPaths: vault.rawPaths,
    newRawPath,
    ...(ownSecrets ? { ownSecrets } : {}),
    reviewCeiling: ceilingFor(policy),
  };
}

/**
 * POLICY.md's review_after ceiling per type — a DRAFT-time rule (prepare_* tools),
 * never re-checked at the press: a card drafted before an upgrade or a knob
 * change still applies. Counted from tomorrow (UTC) so a curator's local date
 * one day ahead of the server is not refused.
 */
function ceilingFor(policy: TeamPolicyParse): (type: TeamPageType) => string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return (type) => reviewAfterCeiling(policy.knobs, type, tomorrow);
}

function indexFor(pages: Map<string, TeamPageParse>): string {
  const ok: TeamVaultIndexEntry[] = [];
  const invalid: Array<{ path: string; title: string }> = [];
  for (const [p, page] of pages) {
    if (page.ok) ok.push({ path: p, meta: page.meta });
    else invalid.push({ path: p, title: page.title });
  }
  return renderTeamIndex(ok, invalid);
}

/** Keep the log well under knowledgeRepo's file cap: the oldest entries roll off (git keeps them). */
const LOG_KEEP_BYTES = 256 * 1024;
const LOG_TRIMMED_NOTE = "_Older entries are in the vault's git history._\n";

async function appendLog(root: string, entry: string): Promise<string> {
  let current: string | null = null;
  try {
    current = await readFile(root, LOG_PATH);
  } catch {
    current = null; // absent, or over the read cap: start a fresh log (history stays in git)
  }
  const body = current && current.trim() ? current.replace(/\n*$/, "\n") : TEAM_LOG_HEADER;
  let next = `${body}\n${entry}`;
  if (Buffer.byteLength(next, "utf8") > LOG_KEEP_BYTES) {
    const entries = next.slice(next.indexOf("\n## [") + 1).split(/\n(?=## \[)/);
    while (entries.length > 1 && Buffer.byteLength(entries.join("\n"), "utf8") > LOG_KEEP_BYTES / 2) entries.shift();
    next = `${TEAM_LOG_HEADER}\n${LOG_TRIMMED_NOTE}\n${entries.join("\n")}`;
  }
  return next;
}

/**
 * Put every touched path back to HEAD (or remove it when HEAD lacks it) and
 * unstage it — a failed write never leaves an unapproved file readable (reads
 * serve the working tree) or staged for the NEXT commit.
 */
async function restorePathsLocked(root: string, paths: string[], inHead: (p: string) => boolean): Promise<void> {
  if (paths.length === 0) return;
  await git(root, ["reset", "-q", "--", ...paths]).catch(() => undefined);
  for (const p of paths) {
    if (!inHead(p)) {
      await fs.rm(path.join(root, p), { force: true }).catch(() => undefined);
      continue;
    }
    // Content straight from the HEAD object, written back — unlike `git checkout`
    // this needs no index lock, so it still works when the failure WAS the lock.
    const content = await showHead(root, p);
    if (content !== null) await writeFile(root, p, content).catch(() => undefined);
  }
}

// ── Init + migration ─────────────────────────────────────────────────────────

/**
 * Put the index and working tree back to HEAD (lock held by the caller) —
 * run at the start of every locked write. A crash mid-write (after a write
 * or `git mv`, before the path-scoped commit) can otherwise leave a staged
 * rename forever or an uncommitted raw/page file readable and searchable.
 * Only Noah writes the vault, so anything not in HEAD is such a leftover.
 */
async function reconcileLocked(root: string): Promise<void> {
  if (!(await headHasCommit(root))) return;
  await git(root, ["reset", "-q"]);
  await git(root, ["checkout", "-q", "HEAD", "--", "."]);
  await git(root, ["clean", "-fdq", "--", "wiki", "raw", SCHEMA_PATH, POLICY_PATH]);
}

async function initLocked(root: string): Promise<void> {
  const hasGit = fsSync.existsSync(path.join(root, ".git"));
  // A crash between `git init` and the first commit leaves a .git with no HEAD: finish the init.
  if (hasGit && (await headHasCommit(root))) return;
  await fs.mkdir(path.join(root, "wiki"), { recursive: true });
  if (!hasGit) await git(root, ["init", "--quiet", `--initial-branch=${TEAM_BRAIN_BRANCH}`]);
  await writeFile(root, SCHEMA_PATH, TEAM_BRAIN_SCHEMA_MD);
  await writeFile(root, POLICY_PATH, TEAM_POLICY_DEFAULT_MD);
  await writeFile(root, INDEX_PATH, renderTeamIndex([], []));
  await writeFile(
    root,
    LOG_PATH,
    `${TEAM_LOG_HEADER}\n${formatLogEntry({ date: today(), op: "migrate", title: `initialize schema v${TEAM_BRAIN_SCHEMA_VERSION}`, changes: [] })}`,
  );
  await git(root, ["add", "--", SCHEMA_PATH, POLICY_PATH, INDEX_PATH, LOG_PATH]);
  await git(
    root,
    ["commit", "--quiet", "-m", `team-brain: initialize (schema v${TEAM_BRAIN_SCHEMA_VERSION})`],
    undefined,
    identityConfig(NOAH_IDENTITY),
  );
}

/**
 * Bring the vault to the current schema (lock held by the caller). v0 → v1
 * moves every pre-schema note to raw/legacy/ (git mv — nothing is deleted) and
 * writes SCHEMA.md, the index and a log entry in ONE commit by Noah; a later
 * bump rewrites SCHEMA.md + index + log. Idempotent; a vault from a NEWER build
 * is left alone. Returns whether it committed.
 */
async function migrateTeamBrainLocked(root: string): Promise<boolean> {
  if (!(await headHasCommit(root))) return false;
  const version = schemaVersionOf(await showHead(root, SCHEMA_PATH));
  if (version >= TEAM_BRAIN_SCHEMA_VERSION) return false;
  const before = await listVaultAt(root);
  const inHead = (p: string) => before.blobs.has(p);
  const touched: string[] = [];
  const moves: Array<{ from: string; to: string }> = [];
  try {
    if (version === 0) {
      // From HEAD, never the index (a leftover staged state must not shape the move).
      const { stdout } = await git(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", "wiki"]);
      for (const p of stdout.split("\0").filter(Boolean)) {
        if (!p.endsWith(".md") || p.endsWith("_template.md") || p === INDEX_PATH || p === LOG_PATH) continue;
        const to = `raw/legacy/${p.slice("wiki/".length)}`;
        if (before.blobs.has(to)) continue;
        moves.push({ from: p, to });
      }
      for (const m of moves) {
        await fs.mkdir(path.dirname(path.join(root, m.to)), { recursive: true });
        touched.push(m.from, m.to);
        await git(root, ["mv", "--", m.from, m.to]);
      }
    }
    touched.push(SCHEMA_PATH, INDEX_PATH, LOG_PATH);
    await writeFile(root, SCHEMA_PATH, TEAM_BRAIN_SCHEMA_MD);
    // v2 brought POLICY.md: a vault without one gets the built-in policy (an
    // existing file — a restored newer mirror — is never overwritten).
    const seedPolicy = (await showHead(root, POLICY_PATH)) === null;
    if (seedPolicy) {
      touched.push(POLICY_PATH);
      await writeFile(root, POLICY_PATH, TEAM_POLICY_DEFAULT_MD);
    }
    const moved = new Set(moves.map((m) => m.from));
    const remaining = new Map([...before.pages].filter(([p]) => !moved.has(p)));
    // Pages that stay (v1+ bumps) are re-parsed under the NEW rules.
    for (const [p] of remaining) {
      try {
        remaining.set(p, parseTeamPage(p, await readFile(root, p)));
      } catch {
        /* keep the listing's verdict */
      }
    }
    await writeFile(root, INDEX_PATH, indexFor(remaining));
    const note =
      version === 0
        ? `${moves.length} pre-schema notes moved to raw/legacy/; compile them with the team-brain-curate skill`
        : `schema v${version} → v${TEAM_BRAIN_SCHEMA_VERSION}; run team_brain_health and fix the pages it lists with the team-brain-curate skill`;
    await writeFile(
      root,
      LOG_PATH,
      await appendLog(
        root,
        formatLogEntry({
          date: today(),
          op: "migrate",
          title: `schema v${TEAM_BRAIN_SCHEMA_VERSION}`,
          changes: [
            ...moves.map((m) => ({ op: "move", path: `${m.from} → ${m.to}` })),
            ...(seedPolicy ? [{ op: "create", path: POLICY_PATH }] : []),
          ],
          note,
        }),
      ),
    );
    await git(root, ["add", "--", SCHEMA_PATH, INDEX_PATH, LOG_PATH, ...(seedPolicy ? [POLICY_PATH] : [])]);
    await git(
      root,
      ["commit", "--quiet", "-m", `team-brain: migrate to schema v${TEAM_BRAIN_SCHEMA_VERSION}`, "--", ...new Set(touched)],
      undefined,
      identityConfig(NOAH_IDENTITY),
    );
    return true;
  } catch (error) {
    await restorePathsLocked(root, [...new Set(touched)], inHead);
    throw error;
  }
}

/** Fast path: the working tree's SCHEMA.md already declares the current version. */
function schemaCurrentSync(root: string): boolean {
  try {
    return schemaVersionOf(fsSync.readFileSync(path.join(root, SCHEMA_PATH), "utf8")) >= TEAM_BRAIN_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

/** Create the vault on first use, or migrate it to the current schema; returns its root. */
export async function ensureTeamBrainRepo(config: Config): Promise<string> {
  const root = teamBrainRoot(config);
  if (teamBrainInitialized(config) && schemaCurrentSync(root)) return root;
  await withRepoLock(root, async () => {
    await initLocked(root);
    await reconcileLocked(root);
    await migrateTeamBrainLocked(root);
  });
  return root;
}

/**
 * Boot hook: migrate an EXISTING vault to the current schema (a missing vault
 * is created lazily later, already current). Never throws — logs instead.
 * `onMigrated` runs after a migration commit (the backup schedules a push).
 */
export async function migrateTeamBrainOnBoot(config: Config, onMigrated?: () => void): Promise<void> {
  if (!teamBrainInitialized(config)) return;
  const root = teamBrainRoot(config);
  try {
    const migrated = await withRepoLock(root, async () => {
      await initLocked(root);
      await reconcileLocked(root);
      return migrateTeamBrainLocked(root);
    });
    if (migrated) {
      logger.info({ schemaVersion: TEAM_BRAIN_SCHEMA_VERSION }, "team brain migrated to the current schema (admins: run the team-brain-curate migration pass)");
      onMigrated?.();
    }
  } catch (error) {
    logger.error({ err: error }, "team brain schema migration failed; it is retried on the next write and boot");
  }
}

/** Run a migration with the vault lock ALREADY held (teamBrainBackup's restore). */
export async function migrateTeamBrainHoldingLock(root: string): Promise<boolean> {
  await reconcileLocked(root);
  return migrateTeamBrainLocked(root);
}

/** Reconcile the index/working tree to HEAD with the vault lock ALREADY held (teamBrainBackup). */
export async function reconcileTeamBrainHoldingLock(root: string): Promise<void> {
  if (fsSync.existsSync(path.join(root, ".git"))) await reconcileLocked(root);
}

/** The vault's declared schema version (0 = absent or pre-schema). Sync, for describe_system. */
export function teamVaultSchemaVersionSync(config: Config): number {
  try {
    return schemaVersionOf(fsSync.readFileSync(path.join(teamBrainRoot(config), SCHEMA_PATH), "utf8"));
  } catch {
    return 0;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The note's committed git blob id, or null when it is not in HEAD. */
export async function teamNoteBlob(root: string, notePath: string): Promise<string | null> {
  try {
    const { stdout } = await git(root, ["rev-parse", "--verify", "--quiet", `HEAD:${notePath}`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * A readable vault path, normalized: `SCHEMA.md`, `POLICY.md`, `wiki/**.md` or
 * `raw/**.md` (no `..`, no hidden or empty segment, plain characters). Null otherwise.
 */
export function normalizeTeamVaultPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 400) return null;
  const norm = path.posix.normalize(raw.trim().replace(/^[/]+/, ""));
  if (norm === SCHEMA_PATH || norm === POLICY_PATH) return norm;
  if (!norm.endsWith(".md") || !(norm.startsWith("wiki/") || norm.startsWith("raw/"))) return null;
  if (!/^[\p{L}\p{N} ._\-/]+$/u.test(norm) || norm.split("/").some((seg) => seg === "" || seg === ".." || seg.startsWith("."))) {
    return null;
  }
  return norm;
}

/** Read SCHEMA.md, POLICY.md, a wiki page (incl. index/log) or a raw source; null when absent or not allowed. */
export async function readTeamVaultFile(config: Config, rawPath: string): Promise<string | null> {
  const p = normalizeTeamVaultPath(rawPath);
  if (!p || !teamBrainInitialized(config)) return null;
  try {
    return await readFile(teamBrainRoot(config), p);
  } catch (error) {
    if (error instanceof Error && (error.message === "INVALID_PATH" || error.message === "NOT_A_FILE")) return null;
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

/** A wiki note's content, or null (alias of readTeamVaultFile kept for wiki callers). */
export async function readTeamNote(config: Config, notePath: string): Promise<string | null> {
  return readTeamVaultFile(config, notePath);
}

// ── Team policy (POLICY.md) ──────────────────────────────────────────────────

/** POLICY.md from the working tree (= HEAD outside an in-flight write), or null when absent. */
async function readPolicyFile(root: string): Promise<string | null> {
  try {
    return await readFile(root, POLICY_PATH);
  } catch {
    return null;
  }
}

/** The effective team policy (built-in defaults when the vault or the file is absent). */
export async function readTeamPolicy(config: Config): Promise<TeamPolicyParse> {
  if (!teamBrainInitialized(config)) return parseTeamPolicy(null);
  return parseTeamPolicy(await readPolicyFile(teamBrainRoot(config)));
}

/** Sync-read cache keyed by vault root: re-parsed only when POLICY.md's mtime/size change. */
const policyCache = new Map<string, { key: string; parse: TeamPolicyParse }>();

/**
 * Sync twin of readTeamPolicy for hot paths (the store's draft expiry / open
 * cap, run assembly). A bounded read of ONE regular file (never follows a link),
 * cached on mtime + size; anything unreadable reads as the built-in policy.
 */
export function readTeamPolicySync(config: Config): TeamPolicyParse {
  const root = teamBrainRoot(config);
  const file = path.join(root, POLICY_PATH);
  let stat: fsSync.Stats;
  try {
    stat = fsSync.lstatSync(file);
  } catch {
    policyCache.delete(root);
    return parseTeamPolicy(null);
  }
  if (!stat.isFile() || stat.size > TEAM_BRAIN_MAX_CONTENT_BYTES) return parseTeamPolicy(null);
  // ino + ctime too: a same-size rewrite within one mtime tick (or a restore of the old bytes) still re-reads.
  const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const hit = policyCache.get(root);
  if (hit && hit.key === key) return hit.parse;
  let parse: TeamPolicyParse;
  try {
    parse = parseTeamPolicy(fsSync.readFileSync(file, "utf8"));
  } catch {
    return parseTeamPolicy(null);
  }
  policyCache.set(root, { key, parse });
  return parse;
}

/** The store's limits from POLICY.md (draft expiry in ms, open cap) — wired in createServices. */
export function teamBrainStoreLimits(config: Config): { draftTtlMs: number; maxOpenProposals: number } {
  const { knobs } = readTeamPolicySync(config);
  return { draftTtlMs: knobs.draftTtlDays * 24 * 60 * 60 * 1000, maxOpenProposals: knobs.maxOpenProposals };
}

/** POLICY.md's content + committed blob (both null when absent). */
export async function teamPolicyState(config: Config): Promise<TeamNoteState> {
  if (!teamBrainInitialized(config)) return { content: null, blob: null };
  const root = teamBrainRoot(config);
  const [content, blob] = await Promise.all([readPolicyFile(root), teamNoteBlob(root, POLICY_PATH)]);
  return { content, blob };
}

/** Recent POLICY.md commits, newest first (the admin panel's 변경 이력). */
export async function teamPolicyHistory(config: Config, limit = 20): Promise<Array<{ at: string; by: string; title: string }>> {
  const root = teamBrainRoot(config);
  if (!teamBrainInitialized(config) || !(await headHasCommit(root))) return [];
  const n = Math.min(Math.max(1, limit), 100);
  const { stdout } = await git(root, ["log", `-n${n}`, "--format=%aI%x1f%an%x1f%s", "HEAD", "--", POLICY_PATH]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [at = "", by = "", title = ""] = line.split("\x1f");
      return { at, by, title: title.replace(/^team-brain:\s*/, "") };
    });
}

export interface ApplyTeamPolicyInput {
  /** The new POLICY.md (validated again here). */
  content: string;
  /** POLICY.md's blob the draft saw (null = it did not exist) — anything else is STALE. */
  baseBlob: string | null;
  title: string;
  proposalId: string;
  /** The admin who pressed the button. */
  author: { name: string; email: string };
  logApprovedBy?: string;
}

/**
 * Commit a new POLICY.md (+ a log entry) under the vault lock, refusing a file
 * that changed since the draft (STALE, never overwritten) or that does not pass
 * the policy rules as they are now. Any failure restores both paths. Returns the
 * commit id.
 */
export async function applyTeamPolicy(config: Config, input: ApplyTeamPolicyInput): Promise<string> {
  const root = teamBrainRoot(config);
  return withRepoLock(root, async () => {
    await initLocked(root);
    await reconcileLocked(root);
    await migrateTeamBrainLocked(root);
    const current = await teamNoteBlob(root, POLICY_PATH);
    if (current !== input.baseBlob) throw new TeamNoteConflictError("STALE", POLICY_PATH);
    const problems = parseTeamPolicy(input.content).problems;
    if (problems.length > 0) throw new TeamChangesetInvalidError(problems.map((p) => `${POLICY_PATH}: ${p.kind}`));
    const touched = [POLICY_PATH, LOG_PATH];
    const inHead = (p: string) => (p === POLICY_PATH ? current !== null : true);
    try {
      await writeFile(root, POLICY_PATH, input.content.endsWith("\n") ? input.content : `${input.content}\n`);
      await writeFile(
        root,
        LOG_PATH,
        await appendLog(
          root,
          formatLogEntry({
            date: today(),
            op: "policy",
            title: input.title,
            approvedBy: input.logApprovedBy,
            changes: [{ op: current === null ? "create" : "update", path: POLICY_PATH }],
          }),
        ),
      );
      await git(root, ["add", "--", ...touched]);
      const subject = `team-brain: ${input.title.replace(/[\r\n]+/g, " ").trim().slice(0, 120) || "update the team policy"}`;
      await git(
        root,
        ["commit", "--quiet", "-m", `${subject}\n\nProposal: ${input.proposalId}`, "--", ...touched],
        undefined,
        identityConfig(input.author),
      );
      const { stdout } = await git(root, ["rev-parse", "HEAD"]);
      return stdout.trim();
    } catch (error) {
      await restorePathsLocked(root, touched, inHead);
      throw error;
    }
  });
}

export interface TeamNoteState {
  content: string | null;
  blob: string | null;
}

/** Content + committed blob of a note (both null when absent). */
export async function teamNoteState(config: Config, notePath: string): Promise<TeamNoteState> {
  if (!teamBrainInitialized(config)) return { content: null, blob: null };
  const root = teamBrainRoot(config);
  const [content, blob] = await Promise.all([readTeamNote(config, notePath), teamNoteBlob(root, notePath)]);
  return { content, blob };
}

/** teamNoteState for several paths with ONE git call (the card view's pages). */
export async function teamPageStates(config: Config, paths: readonly string[]): Promise<Map<string, TeamNoteState>> {
  const out = new Map<string, TeamNoteState>();
  for (const p of paths) out.set(p, { content: null, blob: null });
  if (paths.length === 0 || !teamBrainInitialized(config)) return out;
  const root = teamBrainRoot(config);
  const safe = paths.filter((p) => normalizeTeamVaultPath(p) === p);
  if (safe.length === 0 || !(await headHasCommit(root))) return out;
  const { stdout } = await git(root, ["ls-tree", "-z", "HEAD", "--", ...safe]);
  const blobs = new Map<string, string>();
  for (const entry of stdout.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [mode, type, blob] = entry.slice(0, tab).split(" ");
    if (type === "blob" && (mode === "100644" || mode === "100755")) blobs.set(entry.slice(tab + 1), blob);
  }
  for (const p of safe) {
    const blob = blobs.get(p) ?? null;
    out.set(p, { blob, content: blob ? await readTeamVaultFile(config, p) : null });
  }
  return out;
}

/** Raw sources no valid page cites (incl. raw/legacy). */
function uncompiledOf(vault: TeamVaultListing): string[] {
  const cited = new Set<string>();
  for (const page of vault.pages.values()) if (page.ok) for (const s of page.meta.sources) cited.add(s);
  return [...vault.rawPaths].filter((p) => !cited.has(p)).sort();
}

/**
 * Ranked recall over the team vault (an absent vault reads as an empty one):
 * wiki page hits first (`kind: "page"`), then hits from raw sources NO page
 * cites yet (`kind: "uncompiled_source"`, at most half the limit) — so a
 * submitted-and-approved but not-yet-compiled fact is still findable.
 */
export async function searchTeamBrain(config: Config, query: string, limit?: number): Promise<BrainSearchResult> {
  if (!teamBrainInitialized(config)) return { kind: "ok", hits: [] };
  const root = teamBrainRoot(config);
  const pages = await rankBrainNotes(root, query, limit);
  const wikiHits: BrainNoteHit[] = pages.kind === "ok" ? pages.hits.map((h) => ({ ...h, kind: "page" as const })) : [];
  let extra: BrainNoteHit[] = [];
  if (fsSync.existsSync(path.join(root, "raw"))) {
    // The cited set FIRST, then rank only uncited sources — a lower-ranked
    // uncompiled source is never crowded out by compiled ones.
    const uncompiled = new Set(uncompiledOf(await listVaultAt(root)));
    if (uncompiled.size > 0) {
      const cap = Math.max(1, Math.ceil(Math.min(Math.max(1, limit ?? 8), 20) / 2));
      const raw = await rankBrainNotes(root, query, cap, { prefix: "raw/", include: (p) => uncompiled.has(p) });
      if (raw.kind === "ok") extra = raw.hits.map((h) => ({ ...h, kind: "uncompiled_source" as const }));
    }
  }
  return { kind: "ok", hits: [...wikiHits, ...extra] };
}

/** Admin panel numbers: wiki pages, raw sources, and raw sources no page cites yet. */
export async function teamBrainCounts(config: Config): Promise<{ pages: number; rawSources: number; uncompiledSources: number }> {
  const vault = await listTeamVault(config);
  return { pages: vault.pagePaths.size, rawSources: vault.rawPaths.size, uncompiledSources: uncompiledOf(vault).length };
}

/**
 * The proposal ids named by a `Proposal: <id>` trailer in commits since
 * `sinceIso` (the boot sweep's evidence that an applied card really landed).
 */
export async function teamBrainProposalCommits(config: Config, sinceIso: string): Promise<Set<string>> {
  const out = new Set<string>();
  const root = teamBrainRoot(config);
  if (!teamBrainInitialized(config) || !(await headHasCommit(root))) return out;
  const { stdout } = await git(root, ["log", `--since=${sinceIso}`, "--format=%B%x00", "HEAD"], 60_000);
  for (const m of stdout.matchAll(/^Proposal: (\S+)$/gm)) out.add(m[1]);
  return out;
}

/** Wiki pages in the vault (excluding the structural index/log and templates). */
export async function countTeamNotes(config: Config): Promise<number> {
  return (await listTeamVault(config)).pagePaths.size;
}

/** Raw sources in the vault (incl. raw/legacy). */
export async function countTeamRaw(config: Config): Promise<number> {
  return (await listTeamVault(config)).rawPaths.size;
}

function countSync(dir: string, rel: string, accept: (relPath: string) => boolean): number {
  let count = 0;
  const walk = (abs: string, relDir: string, depth: number) => {
    if (depth > 8 || count > 10_000) return;
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const relPath = `${relDir}/${e.name}`;
      if (e.isDirectory()) walk(path.join(abs, e.name), relPath, depth + 1);
      else if (e.isFile() && accept(relPath)) count += 1;
    }
  };
  walk(dir, rel, 0);
  return count;
}

/** Sync twin of countTeamNotes for describe_system (a bounded walk; never follows a link). */
export function countTeamNotesSync(config: Config): number {
  return countSync(path.join(teamBrainRoot(config), "wiki"), "wiki", isPagePath);
}

/** Sync raw-source count for describe_system (bounded walk; never follows a link). */
export function countTeamRawSync(config: Config): number {
  return countSync(path.join(teamBrainRoot(config), "raw"), "raw", (p) => p.endsWith(".md"));
}

export async function teamBrainGraph(config: Config): Promise<KnowledgeGraph> {
  if (!teamBrainInitialized(config)) return { nodes: [], edges: [] };
  return buildKnowledgeGraph(teamBrainRoot(config));
}

// ── Apply a changeset ────────────────────────────────────────────────────────

/** A page changed under a draft: `EXISTS` (create target now exists), `MISSING` (update target gone), `STALE`. */
export class TeamNoteConflictError extends Error {
  constructor(
    public readonly reason: "STALE" | "EXISTS" | "MISSING",
    public readonly path: string = "",
  ) {
    super(path ? `${reason} ${path}` : reason);
  }
}

/** The changeset breaks the schema as the vault is NOW (errors: agent-facing English, one per line). */
export class TeamChangesetInvalidError extends Error {
  constructor(public readonly errors: string[]) {
    super(`INVALID_CHANGESET: ${errors.length} problem(s)`);
  }
}

export interface ApplyTeamChangesetInput {
  /** The new raw source (server-rendered; must not exist yet), or null for maintenance. */
  raw: { path: string; content: string } | null;
  /** Page writes; each `baseBlob` is re-checked against HEAD under the lock. */
  changes: TeamPageChange[];
  title: string;
  proposalId: string;
  logOp: "ingest" | "direct" | "maintain";
  logBy?: string;
  logApprovedBy?: string;
  /** The admin who pressed the button. */
  author: { name: string; email: string };
  /** The teammate who submitted the source (omitted when the admin wrote it). */
  coAuthor?: { name: string; email: string } | null;
}

/**
 * Write ONE changeset — the raw source (if any), every page, the regenerated
 * index and a log entry — and commit exactly those paths, under the vault lock.
 * Every page is re-checked against the blob its draft saw (refused, never
 * overwritten) and the whole changeset is re-validated against the vault as it
 * is NOW. Any failure restores every touched path. Returns the commit id.
 */
export async function applyTeamChangeset(config: Config, input: ApplyTeamChangesetInput): Promise<string> {
  const root = teamBrainRoot(config);
  return withRepoLock(root, async () => {
    await initLocked(root);
    await reconcileLocked(root);
    await migrateTeamBrainLocked(root);
    const vault = await listVaultAt(root);

    const changes: TeamPageChange[] = [];
    const pathErrors: string[] = [];
    for (const c of input.changes) {
      const checked = validateTeamNotePath(c.path);
      if (!checked.ok) pathErrors.push(`${String(c.path)}: ${checked.reason}`);
      else changes.push({ ...c, path: checked.path });
    }
    if (pathErrors.length > 0) throw new TeamChangesetInvalidError(pathErrors);
    if (input.raw) {
      if (!isTeamRawPath(input.raw.path)) throw new TeamChangesetInvalidError([`${input.raw.path}: not a raw source path`]);
      if (vault.blobs.has(input.raw.path)) throw new TeamNoteConflictError("EXISTS", input.raw.path);
    }
    for (const c of changes) {
      const current = vault.blobs.get(c.path) ?? null;
      if (c.op === "create" && current !== null) throw new TeamNoteConflictError("EXISTS", c.path);
      if (c.op === "update" && current === null) throw new TeamNoteConflictError("MISSING", c.path);
      if (c.op === "update" && current !== c.baseBlob) throw new TeamNoteConflictError("STALE", c.path);
    }
    const errors = validateChangeset(changes, {
      pages: vault.pages,
      knownPagePaths: vault.pagePaths,
      rawPaths: vault.rawPaths,
      newRawPath: input.raw?.path ?? null,
    });
    if (errors.length > 0) throw new TeamChangesetInvalidError(errors);

    const inHead = (p: string) => vault.blobs.has(p);
    const touched: string[] = [];
    const withNewline = (s: string) => (s.endsWith("\n") ? s : `${s}\n`);
    try {
      if (input.raw) {
        touched.push(input.raw.path);
        await writeFile(root, input.raw.path, withNewline(input.raw.content));
      }
      const after = new Map(vault.pages);
      for (const c of changes) {
        touched.push(c.path);
        await writeFile(root, c.path, withNewline(c.content));
        after.set(c.path, parseTeamPage(c.path, c.content));
      }
      touched.push(INDEX_PATH, LOG_PATH);
      await writeFile(root, INDEX_PATH, indexFor(after));
      await writeFile(
        root,
        LOG_PATH,
        await appendLog(
          root,
          formatLogEntry({
            date: today(),
            op: input.logOp,
            title: input.title,
            by: input.logBy,
            approvedBy: input.logApprovedBy,
            changes: changes.map((c) => ({ op: c.op, path: c.path })),
            rawPath: input.raw?.path ?? null,
          }),
        ),
      );
      await git(root, ["add", "--", ...touched]);
      const subject = `team-brain: ${input.title.replace(/[\r\n]+/g, " ").trim().slice(0, 120) || "update"}`;
      const trailers = [`Proposal: ${input.proposalId}`];
      if (input.coAuthor) {
        const co = safeIdentity(input.coAuthor);
        trailers.push(`Co-authored-by: ${co.name} <${co.email}>`);
      }
      // Pathspec: the commit carries THIS changeset only, whatever else the index holds.
      await git(root, ["commit", "--quiet", "-m", `${subject}\n\n${trailers.join("\n")}`, "--", ...touched], undefined, identityConfig(input.author));
      const { stdout } = await git(root, ["rev-parse", "HEAD"]);
      return stdout.trim();
    } catch (error) {
      await restorePathsLocked(root, touched, inHead);
      throw error;
    }
  });
}

// ── Health (lint) ────────────────────────────────────────────────────────────

export interface TeamBrainHealth {
  schemaVersion: number;
  currentSchemaVersion: number;
  pages: number;
  rawSources: number;
  uncompiledSources: string[];
  invalidPages: Array<{ path: string; errors: string[] }>;
  overdue: Array<{ path: string; reviewAfter: string }>;
  danglingLinks: Array<{ from: string; target: string }>;
  orphans: string[];
  duplicateNames: Array<{ name: string; paths: string[] }>;
  missingSources: Array<{ path: string; source: string }>;
  withGaps: Array<{ path: string; gaps: string[] }>;
  historyNarrative: string[];
  suspiciousText: string[];
  /** Exact sizes of every list above (each list is capped at 50). */
  counts: {
    uncompiledSources: number;
    invalidPages: number;
    overdue: number;
    danglingLinks: number;
    orphans: number;
    duplicateNames: number;
    missingSources: number;
    withGaps: number;
    historyNarrative: number;
    suspiciousText: number;
  };
}

const WIKILINK_RE = /\[\[([^\]\[\n]+?)\]\]/g;
const HISTORY_RE = /\bpreviously\b|\bused to be\b|\bchanged (from|to)\b|기존에는|변경되었|로 바뀌/i;
const SUSPICIOUS_RE = /ignore (all|previous|the above) instructions|system prompt|you are now|<\/?untrusted/i;

function linkTargetOf(raw: string): string {
  return raw.split("|")[0].split("#")[0].split("^")[0].trim();
}

/** The lint report the admin's avatar works from (read-only, bounded). */
export async function teamBrainHealth(config: Config): Promise<TeamBrainHealth> {
  const vault = await listTeamVault(config);
  const root = teamBrainRoot(config);
  const uncompiled = uncompiledOf(vault);
  const invalidPages: TeamBrainHealth["invalidPages"] = [];
  const overdue: TeamBrainHealth["overdue"] = [];
  const missingSources: TeamBrainHealth["missingSources"] = [];
  const withGaps: TeamBrainHealth["withGaps"] = [];
  const historyNarrative: string[] = [];
  const suspiciousText: string[] = [];
  const nameOwners = new Map<string, { name: string; paths: Set<string> }>();
  const resolve = new Map<string, string>();
  const now = today();

  const sortedPages = [...vault.pages].sort(([a], [b]) => a.localeCompare(b));
  for (const [p, page] of sortedPages) {
    const stem = p.split("/").pop()!.replace(/\.md$/, "");
    const names = page.ok ? [page.meta.title, ...page.meta.aliases] : page.title ? [page.title] : [];
    for (const n of names) {
      const key = teamNameKey(n);
      if (!key) continue;
      const entry = nameOwners.get(key) ?? { name: n.trim(), paths: new Set<string>() };
      entry.paths.add(p);
      nameOwners.set(key, entry);
    }
    for (const k of [...names, stem, p.replace(/\.md$/, "")]) {
      const key = teamNameKey(k);
      if (key && !resolve.has(key)) resolve.set(key, p);
    }
    if (!page.ok) {
      invalidPages.push({ path: p, errors: page.errors });
      continue;
    }
    const m = page.meta;
    if (m.reviewAfter < now) overdue.push({ path: p, reviewAfter: m.reviewAfter });
    for (const s of m.sources) if (!vault.rawPaths.has(s)) missingSources.push({ path: p, source: s });
    if (m.gaps.length > 0) withGaps.push({ path: p, gaps: m.gaps });
    if (HISTORY_RE.test(m.body)) historyNarrative.push(p);
  }

  const danglingLinks: TeamBrainHealth["danglingLinks"] = [];
  const linked = new Set<string>();
  for (const [p, page] of sortedPages) {
    if (!page.ok) continue;
    WIKILINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WIKILINK_RE.exec(page.meta.body)) !== null) {
      const target = linkTargetOf(match[1]);
      if (!target) continue;
      const hit = resolve.get(teamNameKey(target));
      if (!hit) danglingLinks.push({ from: p, target });
      else if (hit !== p) {
        linked.add(p);
        linked.add(hit);
      }
    }
    if (SUSPICIOUS_RE.test(page.meta.body) || SUSPICIOUS_RE.test(page.meta.summary)) suspiciousText.push(p);
  }
  const orphans = sortedPages.filter(([p, page]) => page.ok && !linked.has(p)).map(([p]) => p);
  const duplicateNames = [...nameOwners.values()]
    .filter((e) => e.paths.size > 1)
    .map((e) => ({ name: e.name, paths: [...e.paths].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  let rawRead = 0;
  for (const p of [...vault.rawPaths].sort()) {
    if (rawRead >= HEALTH_RAW_READ_CAP) break;
    rawRead += 1;
    try {
      if (SUSPICIOUS_RE.test(await readFile(root, p))) suspiciousText.push(p);
    } catch {
      /* unreadable raw: skip */
    }
  }

  const cap = <T>(list: T[]) => list.slice(0, HEALTH_LIST_CAP);
  return {
    schemaVersion: teamBrainInitialized(config) ? teamVaultSchemaVersionSync(config) : TEAM_BRAIN_SCHEMA_VERSION,
    currentSchemaVersion: TEAM_BRAIN_SCHEMA_VERSION,
    pages: vault.pagePaths.size,
    rawSources: vault.rawPaths.size,
    uncompiledSources: cap(uncompiled),
    invalidPages: cap(invalidPages),
    overdue: cap(overdue),
    danglingLinks: cap(danglingLinks),
    orphans: cap(orphans),
    duplicateNames: cap(duplicateNames),
    missingSources: cap(missingSources),
    withGaps: cap(withGaps),
    historyNarrative: cap(historyNarrative),
    suspiciousText: cap(suspiciousText),
    counts: {
      uncompiledSources: uncompiled.length,
      invalidPages: invalidPages.length,
      overdue: overdue.length,
      danglingLinks: danglingLinks.length,
      orphans: orphans.length,
      duplicateNames: duplicateNames.length,
      missingSources: missingSources.length,
      withGaps: withGaps.length,
      historyNarrative: historyNarrative.length,
      suspiciousText: suspiciousText.length,
    },
  };
}
