import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sanitizeName, serverGitEnv } from "./marketplace.js";
import {
  SKILL_DIR,
  ensureClone,
  ensureMarketplaceManifest,
  commitAndPush,
  resolveInRepo,
  realpathContained,
  type KnowledgeRepoContext,
} from "./knowledgeRepo.js";
import { git } from "./repoGitCore.js";
import { resolveShareCopy } from "../shared/skillOriginMatch.js";
import { skillMdMeta } from "./agent/skillDiscovery.js";
import type { SharedSkill, SharedSkillManifest } from "./types.js";

const execFileAsync = promisify(execFile);

// Skill transfer between knowledge repos (#skill-share): the "learn" half of
// skill sharing. The share rows (store/avatars.ts) are metadata only; THIS
// module materializes a learned skill by copying `skills/<slug>/` from the
// sharer's clone into the learner's repo, registering it in the learner's
// marketplace manifest (like scaffoldSkill), and committing with the learner's
// identity. All path handling goes through knowledgeRepo's resolveInRepo +
// realpathContained so the git-safety rules stay single-sourced.
//
// The copied tree is TEACHING MATERIAL authored by a teammate: symlinks are
// never followed (skipped + counted), sizes are capped, and everything lands
// inside the learner's own repo where their avatar can inspect and adapt it.

/** Per-file cap — mirrors knowledgeRepo's MAX_FILE_BYTES for repo writes. */
const MAX_SKILL_FILE_BYTES = 512 * 1024;
/** Whole-skill cap: a skill directory bigger than this refuses to transfer. */
const MAX_SKILL_TOTAL_BYTES = 4 * 1024 * 1024;
/** File-count + depth bounds so a pathological tree can't wedge the copy. */
const MAX_SKILL_FILES = 200;
const MAX_SKILL_DEPTH = 8;
/**
 * Cap on the owner's custom share INTRODUCTION (소개 문구). The frontmatter
 * description it falls back to is unbounded by nature (one YAML line), but this
 * one is free-form user text that rides listings and MCP tool results, so both
 * entry points (the route and share_skill) REJECT past this rather than clip —
 * silently truncating someone's intro is worse than telling them to shorten it.
 */
export const MAX_SKILL_INTRO_CHARS = 500;

/** One shareable skill directory in a repo working tree. */
export interface RepoSkillEntry {
  /** The `skills/<slug>` directory name — the share identity. */
  slug: string;
  /** Frontmatter name (falls back to the slug). */
  name: string;
  description: string;
}

/**
 * Normalize a human-entered skill name into a `skills/<slug>` directory name.
 * Byte-for-byte the slug rule scaffoldSkill uses, so learned and scaffolded
 * skills live under the same naming scheme. Returns "" for an unusable name
 * (callers decide the error).
 */
export function normalizeSkillSlug(name: string): string {
  return sanitizeName(name.trim()).toLowerCase().replace(/^-+|-+$/g, "");
}

/**
 * Enumerate the skills of one repo working tree by scanning
 * `skills/<dir>/SKILL.md` (the shareable set — bundled/plugin skills are
 * deliberately NOT included; everyone already has the bundles, and plugins are
 * shared by installing the same plugin). Tolerant: no skills dir → [].
 */
export function listRepoSkills(repoRoot: string): RepoSkillEntry[] {
  const dir = resolveInRepo(repoRoot, SKILL_DIR);
  if (!dir) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RepoSkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const mdPath = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(mdPath)) {
      continue;
    }
    const meta = skillMdMeta(mdPath);
    out.push({
      slug: entry.name,
      name: meta.name || entry.name,
      description: meta.description ?? "",
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Read one skill's metadata from a repo, or null when it doesn't exist. */
export function readRepoSkill(repoRoot: string, slug: string): RepoSkillEntry | null {
  return listRepoSkills(repoRoot).find((s) => s.slug === slug) ?? null;
}

/**
 * Provenance marker written into a LEARNED skill (`skills/<slug>/` root, named
 * below): which share it came from and the SOURCE directory's content hash at
 * learn time. Comparing that hash with the share row's CURRENT hash is what
 * detects "the sharer updated this since you learned it", and the (owner,
 * skillName) pair is what authorizes an in-place update overwrite.
 */
export interface SkillOrigin {
  ownerUserId: string;
  ownerUsername: string;
  skillName: string;
  contentHash: string | null;
  /**
   * Hash of the LEARNER's copy right after the learn (post identity-rewrite).
   * Comparing it with the copy's current hash detects local customization —
   * the guard that keeps an update from silently flattening the learner's own
   * edits. Null on markers written before this field existed (treated as
   * "possibly modified": the update path then requires explicit confirmation).
   */
  localHash: string | null;
  learnedAt: string;
}

export const SKILL_ORIGIN_FILE = ".noah-skill-origin.json";

/** One file seen by the shared read-only walk below. */
interface SkillWalkFile {
  abs: string;
  /** Path relative to the skill directory, always POSIX-separated. */
  rel: string;
  bytes: number;
}

/**
 * Read-only traversal of ONE skill directory under copySkillDir's rules —
 * symlinks and specials skipped, depth-capped, entries taken in per-directory
 * name order (that order is what makes hashSkillDir's digest stable, so don't
 * change it). Never reads file CONTENT: callers get sizes and decide.
 *
 * Stops (rather than throwing) when it can't see the whole tree — more than
 * `limit` files, deeper than MAX_SKILL_DEPTH, or an unreadable directory — and
 * reports that as `truncated`. hashSkillDir turns it into a null hash (an
 * untransferable skill has no meaningful fingerprint); listSkillFiles keeps the
 * partial listing and flags it, so a preview says honestly what it saw.
 *
 * `skipName` drops entries with that basename at ANY depth (the origin marker,
 * for the hash).
 */
function walkSkillDir(
  dir: string,
  limit: number,
  skipName?: string,
): { files: SkillWalkFile[]; truncated: boolean } {
  const files: SkillWalkFile[] = [];
  const walk = (current: string, depth: number): boolean => {
    if (depth > MAX_SKILL_DEPTH) {
      return false;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(current, entry.name);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        if (!walk(abs, depth + 1)) {
          return false;
        }
        continue;
      }
      if (!stat.isFile() || entry.name === skipName) {
        continue;
      }
      if (files.length >= limit) {
        return false;
      }
      files.push({
        abs,
        rel: path.relative(dir, abs).split(path.sep).join("/"),
        bytes: stat.size,
      });
    }
    return true;
  };
  return { files, truncated: !walk(dir, 0) };
}

/**
 * Deterministic content hash of one skill directory: sha256 over the sorted
 * repo-relative paths + file bytes, mirroring copySkillDir's traversal
 * (symlinks and specials skipped). Excluding the origin marker is still
 * REQUIRED, for a different reason than re-sharing (which is now refused —
 * assertSkillShareable): every comparison a learned copy takes part in is
 * against a marker-less hash — the SOURCE dir's, for update detection, and its
 * own marker's localHash, for customization detection — so the marker must be
 * invisible on both sides. Null when the dir is missing or blows the transfer
 * caps (such a skill can't transfer anyway).
 */
export function hashSkillDir(repoRoot: string, slug: string): string | null {
  const lexical = resolveInRepo(repoRoot, `${SKILL_DIR}/${slug}`);
  if (!lexical) {
    return null;
  }
  const dir = realpathContained(repoRoot, lexical, true);
  if (!dir) {
    return null;
  }
  const { files, truncated } = walkSkillDir(dir, MAX_SKILL_FILES, SKILL_ORIGIN_FILE);
  if (truncated) {
    return null;
  }
  const hash = crypto.createHash("sha256");
  let total = 0;
  for (const file of files) {
    if (file.bytes > MAX_SKILL_FILE_BYTES) {
      return null;
    }
    const bytes = fs.readFileSync(file.abs);
    total += bytes.length;
    if (total > MAX_SKILL_TOTAL_BYTES) {
      return null;
    }
    hash.update(file.rel);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * The file manifest of one skill directory — what a learn would ACTUALLY copy.
 * A skill is the whole `skills/<slug>/` tree (aux docs, scripts, templates),
 * not just its SKILL.md, so the preview lists it rather than letting a learner
 * assume one file. Same walk as copySkillDir minus the copying: symlinks and
 * specials never appear, sizes come from lstat (no content is read), and paths
 * are relative to the skill dir with SKILL.md included.
 *
 * A tree past the transfer caps returns what it saw with `truncated` — such a
 * skill would FAIL to learn anyway, and an honest partial listing beats an
 * empty one. A missing/uncontained dir is an empty manifest, not an error.
 */
export function listSkillFiles(repoRoot: string, slug: string): SharedSkillManifest {
  const lexical = resolveInRepo(repoRoot, `${SKILL_DIR}/${slug}`);
  const dir = lexical ? realpathContained(repoRoot, lexical, true) : null;
  if (!dir) {
    return { files: [], totalBytes: 0, truncated: false };
  }
  const { files, truncated } = walkSkillDir(dir, MAX_SKILL_FILES);
  return {
    // Code-unit order, not localeCompare: a manifest is a stable listing, and
    // this keeps SKILL.md at the top the way `ls` would.
    files: files
      .map((file) => ({ path: file.rel, bytes: file.bytes }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    truncated,
  };
}

/** Read a learned skill's provenance marker, or null when absent/invalid. */
export function readSkillOrigin(repoRoot: string, slug: string): SkillOrigin | null {
  const lexical = resolveInRepo(repoRoot, `${SKILL_DIR}/${slug}/${SKILL_ORIGIN_FILE}`);
  if (!lexical) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(lexical, "utf8")) as Partial<SkillOrigin>;
    if (
      typeof raw.ownerUserId !== "string" ||
      typeof raw.ownerUsername !== "string" ||
      typeof raw.skillName !== "string"
    ) {
      return null;
    }
    return {
      ownerUserId: raw.ownerUserId,
      ownerUsername: raw.ownerUsername,
      skillName: raw.skillName,
      contentHash: typeof raw.contentHash === "string" ? raw.contentHash : null,
      localHash: typeof raw.localHash === "string" ? raw.localHash : null,
      learnedAt: typeof raw.learnedAt === "string" ? raw.learnedAt : "",
    };
  } catch {
    return null;
  }
}

/**
 * Refusal thrown by assertSkillShareable. Message-coded like every other error
 * in this module (callers switching on `error.message` keep working); `origin`
 * rides along so they can name the sharer without re-reading the marker.
 */
export class SkillIsLearnedCopyError extends Error {
  constructor(readonly origin: SkillOrigin) {
    super("SKILL_IS_LEARNED_COPY");
    this.name = "SkillIsLearnedCopyError";
  }
}

/**
 * Refuse to publish a skill directory that still carries a provenance marker.
 * A learned copy lives inside the ORIGINAL owner's avatar-discovery boundary:
 * re-sharing it would carry the CONTENT past that boundary, duplicate the
 * listing, and credit the wrong author. Unlinking (구독 해지) is the deliberate
 * ownership claim that lifts the refusal — see unlinkSkillOrigin.
 *
 * The one choke point for both share paths (the share endpoint in
 * routes/skillShare.ts and mcp__skill_exchange__share_skill) and for the SOURCE
 * side of a learn. A corrupt/unreadable marker reads as no marker
 * (readSkillOrigin's null): a copy making no provenance claim is shareable.
 */
export function assertSkillShareable(repoRoot: string, slug: string): void {
  const origin = readSkillOrigin(repoRoot, slug);
  if (origin) {
    throw new SkillIsLearnedCopyError(origin);
  }
}

/**
 * Unlink a learned copy from its share (구독 해지): delete the origin marker
 * and commit. The skill itself stays; update badges/tracking stop, the copy
 * becomes shareable as the owner's own, and a later re-learn of the same share
 * is a NEW copy. Throws NO_ORIGIN when the slug has no marker (never learned,
 * or already unlinked).
 */
export async function unlinkSkillOrigin(opts: {
  learnerCtx: KnowledgeRepoContext;
  slug: string;
  commitMessage: string;
  identity: { name: string; email: string };
}): Promise<{ origin: SkillOrigin; committed: boolean }> {
  const root = await ensureClone(opts.learnerCtx);
  const origin = readSkillOrigin(root, opts.slug);
  if (!origin) {
    throw new Error("NO_ORIGIN");
  }
  const lexical = resolveInRepo(root, `${SKILL_DIR}/${opts.slug}/${SKILL_ORIGIN_FILE}`);
  const abs = lexical ? realpathContained(root, lexical, true) : null;
  if (!abs) {
    throw new Error("NO_ORIGIN");
  }
  await fsp.rm(abs, { force: true });
  const committed = await commitAndPush(opts.learnerCtx, opts.commitMessage, opts.identity);
  return { origin, committed };
}

/**
 * Whether a learned copy was locally customized since the learn: current dir
 * hash vs the origin marker's localHash. Returns null when it cannot tell —
 * no marker, a legacy marker without localHash, or an unhashable dir — which
 * callers treat as "possibly modified" (fail safe).
 */
export function isSkillLocallyModified(repoRoot: string, slug: string): boolean | null {
  const origin = readSkillOrigin(repoRoot, slug);
  if (!origin?.localHash) {
    return null;
  }
  const current = hashSkillDir(repoRoot, slug);
  if (!current) {
    return null;
  }
  return current !== origin.localHash;
}

// ---- Reconciling an owner's share rows with their working tree -------------
// Share rows are a SNAPSHOT of `skills/<slug>/`, so the tree can move out from
// under them: the dir drifts, is deleted, turns into a learned copy, or is
// RENAMED. Every path that has the owner's fresh clone in hand runs the same
// reconciliation (the mine tab and the commit tool), and a teammate's
// preview/learn runs the rename half of it — see rescueSharedSkillRename.

/**
 * The store surface reconciliation needs, declared STRUCTURALLY so this module
 * keeps not importing Store (it already sits below the store in the layering).
 * The composed Store satisfies it as-is.
 */
export interface SharedSkillReconcileStore {
  listSharedSkillsByOwner(ownerUserId: string): SharedSkill[];
  shareSkill(
    ownerUserId: string,
    skill: {
      skillName: string;
      displayName: string;
      description: string;
      contentHash?: string | null;
    },
  ): SharedSkill;
  unshareSkill(ownerUserId: string, skillName: string): boolean;
  renameSharedSkill(
    ownerUserId: string,
    fromSkillName: string,
    toSkillName: string,
    next: {
      displayName: string;
      description: string;
      contentHash: string | null;
      bumpUpdatedAt: boolean;
    },
  ): SharedSkill | null;
}

/** What one reconciliation pass changed — the caller's material for a report. */
export interface SharedSkillReconcileResult {
  /** Rows whose metadata/fingerprint drifted and were re-snapshotted. */
  resnapshotted: string[];
  /** Rows that FOLLOWED a renamed directory (row id and intro preserved). */
  renamed: { from: string; to: string }[];
  /** Rows unshared because `skills/<slug>/` is gone. */
  unshared: string[];
  /** Rows unshared because the dir became a LEARNED copy (chain drain). */
  drained: string[];
}

/** The row fields a rename match needs — both SharedSkill and its listing fit. */
interface RenameSubject {
  ownerUserId: string;
  skillName: string;
  contentHash: string | null;
}

/** Lazily-computed dir hashes for one pass (hashing reads every file). */
function hashCache(repoRoot: string): (slug: string) => string | null {
  const hashes = new Map<string, string | null>();
  return (slug) => {
    if (!hashes.has(slug)) {
      hashes.set(slug, hashSkillDir(repoRoot, slug));
    }
    return hashes.get(slug) ?? null;
  };
}

// ---- Rename EVIDENCE, read out of git ---------------------------------------
// A share follows a renamed directory only because GIT reported a rename, never
// because some other directory happens to hold the same bytes: an identical
// copy elsewhere made a deletion look like a move, and a `git mv` into an
// existing private directory could carry a share onto content it never
// published. Everything below reads history — nothing infers a move from
// content alone.

/** How far back the evidence is looked for (commits, newest first). */
const MOVE_HISTORY_COMMITS = 30;
/** Longest chain of consecutive renames one row is followed through. */
const MOVE_CHAIN_CAP = 5;

/** What git says became of one `skills/<slug>/` directory. */
type SkillDirMove =
  | {
      kind: "renamed";
      to: string;
      /** The target did not exist in the tree the rename was made against. */
      targetFresh: boolean;
    }
  | { kind: "deleted" };

/** One `--name-status` entry, already detokenized. */
type DiffEntry =
  | { status: "R"; from: string; to: string }
  | { status: "A" | "D"; path: string };

/** The skill-directory events of ONE diff (see skillDirEvents). */
interface SkillDirEvents {
  /** slug → the single slug its files moved to. */
  renamedTo: Map<string, string>;
  /** slugs whose SKILL.md was deleted outright. */
  deleted: Set<string>;
  /** slugs whose SKILL.md was added outright. */
  created: Set<string>;
  /** slugs that RECEIVED another slug's files. */
  renamedInto: Set<string>;
}

/** One step of the newest-first diff timeline the search walks. */
interface MoveTimelineDiff {
  /** The ref the diff was taken AGAINST — its parent tree. */
  parentRef: string;
  /** `--name-status -z` output, fetched on demand. */
  diff: () => Promise<string>;
}

/**
 * Split `--name-status -z` output into entries. NUL-delimited output is the
 * whole point: git QUOTES non-ASCII paths in its default textual form
 * (`"skills/\353\260\260…"`), so a Korean skill directory read that way never
 * matches the tree. A rename token carries two paths, everything else one.
 */
function parseNameStatus(stdout: string): DiffEntry[] {
  const tokens = stdout.split("\0");
  const entries: DiffEntry[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    i += 1;
    if (!status) {
      continue; // trailing NUL
    }
    // R and C carry two paths; everything else one. C never appears without
    // `-C`, but consuming it correctly keeps one stray token from desyncing the
    // whole stream.
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = tokens[i];
      const to = tokens[i + 1];
      i += 2;
      if (from && to && status.startsWith("R")) {
        entries.push({ status: "R", from, to });
      }
      continue;
    }
    const target = tokens[i];
    i += 1;
    if (target && (status[0] === "A" || status[0] === "D")) {
      entries.push({ status: status[0], path: target });
    }
  }
  return entries;
}

/** A repo path inside a skill directory, split into its slug and its role. */
function skillDirRef(repoPath: string): { slug: string; isSkillMd: boolean } | null {
  const match = new RegExp(`^${SKILL_DIR}/([^/]+)/(.+)$`).exec(repoPath);
  return match ? { slug: match[1], isSkillMd: match[2] === "SKILL.md" } : null;
}

/**
 * Reduce one diff to per-directory events.
 *
 * A renamed SKILL.md decides its directory's move on its own. The other files
 * only VOTE, and only for a directory that also LOST its SKILL.md — deleted (a
 * commit rewriting SKILL.md enough is reported as delete+add rather than a
 * rename, which is the case the votes exist for) or taken over by another
 * skill's files. Without that condition a single auxiliary file moved between
 * two LIVING skills would read as a rename of the whole directory. A directory
 * whose files scattered across several targets yields nothing either way.
 *
 * A rename AWAY beats one arriving in the same diff, which is what lets a
 * one-commit swap (a→c, b→a) resolve: `a` left for `c`, and `b` moving in
 * concerns only whoever is following `b`.
 */
function skillDirEvents(entries: DiffEntry[]): SkillDirEvents {
  const renamedTo = new Map<string, string>();
  const votes = new Map<string, Set<string>>();
  const receivers = new Set<string>();
  const addedMd = new Set<string>();
  const deletedMd = new Set<string>();
  for (const entry of entries) {
    if (entry.status === "R") {
      const fromRef = skillDirRef(entry.from);
      const toRef = skillDirRef(entry.to);
      if (!fromRef || !toRef || fromRef.slug === toRef.slug) {
        continue;
      }
      if (fromRef.isSkillMd && toRef.isSkillMd) {
        renamedTo.set(fromRef.slug, toRef.slug);
      }
      const seen = votes.get(fromRef.slug) ?? new Set<string>();
      seen.add(toRef.slug);
      votes.set(fromRef.slug, seen);
      receivers.add(toRef.slug);
      continue;
    }
    const ref = skillDirRef(entry.path);
    if (!ref?.isSkillMd) {
      continue;
    }
    (entry.status === "A" ? addedMd : deletedMd).add(ref.slug);
  }
  for (const [slug, targets] of votes) {
    if (
      !renamedTo.has(slug) &&
      (deletedMd.has(slug) || receivers.has(slug)) &&
      targets.size === 1
    ) {
      renamedTo.set(slug, [...targets][0]);
    }
  }
  const movedAway = new Set(renamedTo.keys());
  return {
    renamedTo,
    deleted: new Set([...deletedMd].filter((slug) => !movedAway.has(slug))),
    created: new Set(
      [...addedMd].filter((slug) => !movedAway.has(slug) && !deletedMd.has(slug)),
    ),
    renamedInto: new Set([...receivers].filter((slug) => !movedAway.has(slug))),
  };
}

/**
 * The working tree against HEAD, INCLUDING untracked files — the uncommitted
 * step of the timeline.
 *
 * `move_file` renames a directory with `fs.rename` and leaves it UNSTAGED, so a
 * plain `git diff HEAD` sees only the vanished side and reports a rename the
 * avatar is about to commit as a deletion — which reconciliation now treats as
 * a hard revoke. Staging into a THROWAWAY index lets git's own `-M` detection
 * see both sides; the clone's real index, refs and worktree are never touched.
 * The index starts EMPTY on purpose: `add -A` then describes the whole tree, so
 * `diff-index --cached HEAD` is exactly worktree-vs-HEAD. GIT_INDEX_FILE is why
 * this one call can't go through repoGitCore's `git` (no env there).
 */
async function worktreeNameStatus(repoRoot: string): Promise<string> {
  const indexFile = path.join(repoRoot, ".git", `noah-reconcile-${crypto.randomUUID()}.index`);
  const run = (args: string[]) =>
    execFileAsync("git", ["-C", repoRoot, ...args], {
      timeout: 120_000,
      env: { ...serverGitEnv(), GIT_INDEX_FILE: indexFile },
    });
  try {
    await run(["add", "-A"]);
    const { stdout } = await run([
      "diff-index",
      "-M",
      "--diff-filter=ARD",
      "--name-status",
      "--cached",
      "-z",
      "HEAD",
    ]);
    return stdout;
  } finally {
    await fsp.rm(indexFile, { force: true });
  }
}

/** The newest-first diff timeline: uncommitted work, then recent commits. */
async function buildMoveTimeline(repoRoot: string): Promise<MoveTimelineDiff[]> {
  const timeline: MoveTimelineDiff[] = [
    { parentRef: "HEAD", diff: () => worktreeNameStatus(repoRoot) },
  ];
  let stdout: string;
  try {
    ({ stdout } = await git(repoRoot, [
      "log",
      "-n",
      String(MOVE_HISTORY_COMMITS),
      "--format=%H",
    ]));
  } catch {
    return timeline; // no history yet (or unreadable) — the worktree is all there is
  }
  for (const hash of stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
    timeline.push({
      parentRef: `${hash}~1`,
      diff: async () =>
        (
          await git(repoRoot, [
            "diff-tree",
            "-r",
            "-M",
            "--diff-filter=ARD",
            "--name-status",
            "--no-commit-id",
            "-z",
            hash,
          ])
        ).stdout,
    });
  }
  return timeline;
}

/**
 * What git can still attest to about each of `names`. Diffs are parsed only
 * when the search reaches them, and the FIRST (newest) diff carrying an event
 * for a directory decides its fate:
 *
 *  - renamed away → the target is followed onward through NEWER diffs only, so
 *    a chain of renames resolves and a target later replaced by something else
 *    yields NOTHING (better no answer than the wrong directory);
 *  - deleted → deleted, even if identical bytes live elsewhere;
 *  - created, or another directory renamed INTO this name → nothing: this
 *    incarnation began here, and an older rename of a previous one must never
 *    be applied to it.
 *
 * Best effort: any git failure ends the search with what it has, and the caller
 * falls back to its no-evidence branch.
 */
async function resolveSkillDirMoves(
  repoRoot: string,
  names: ReadonlySet<string>,
): Promise<Map<string, SkillDirMove>> {
  const moves = new Map<string, SkillDirMove>();
  if (names.size === 0) {
    return moves;
  }
  const timeline = await buildMoveTimeline(repoRoot);
  const parsed = new Map<number, SkillDirEvents | null>();
  const eventsAt = async (index: number): Promise<SkillDirEvents | null> => {
    if (!parsed.has(index)) {
      try {
        parsed.set(index, skillDirEvents(parseNameStatus(await timeline[index].diff())));
      } catch {
        parsed.set(index, null);
      }
    }
    return parsed.get(index) ?? null;
  };
  const targetFresh = async (index: number, slug: string): Promise<boolean> => {
    try {
      const { stdout } = await git(repoRoot, [
        "ls-tree",
        "--name-only",
        "-z",
        timeline[index].parentRef,
        `${SKILL_DIR}/`,
      ]);
      return !stdout.split("\0").includes(`${SKILL_DIR}/${slug}`);
    } catch {
      return true; // nothing to compare against (a root commit) — a new location
    }
  };
  /** Follow one slug forward through the diffs NEWER than `newerThan`. */
  const follow = async (
    slug: string,
    newerThan: number,
    depth: number,
  ): Promise<SkillDirMove | { kind: "settled" } | null> => {
    if (depth > MOVE_CHAIN_CAP) {
      return null;
    }
    for (let index = 0; index < newerThan; index += 1) {
      const events = await eventsAt(index);
      if (!events) {
        return null;
      }
      const to = events.renamedTo.get(slug);
      if (to) {
        const onward = await follow(to, index, depth + 1);
        if (!onward) {
          return null;
        }
        return onward.kind === "settled"
          ? { kind: "renamed", to, targetFresh: await targetFresh(index, to) }
          : onward; // deleted downstream, or the chain runs on
      }
      if (events.deleted.has(slug)) {
        return { kind: "deleted" };
      }
      if (events.created.has(slug) || events.renamedInto.has(slug)) {
        return null;
      }
    }
    return { kind: "settled" }; // nothing happened to it in the window
  };
  for (const name of names) {
    const outcome = await follow(name, timeline.length, 0);
    if (outcome && outcome.kind !== "settled") {
      moves.set(name, outcome);
    }
  }
  return moves;
}

/**
 * Whether `move` may carry a row onto `slug`. Evidence says a rename happened;
 * this says the destination is a legitimate home for THIS share.
 *
 * The content check is the consolidation guard: `git mv skills/a/SKILL.md` into
 * an EXISTING directory is a rename to git, so without it a share would follow
 * onto a directory whose other content was never published. Either the target
 * still holds the row's bytes, or git renamed into a location that did not
 * exist before (a genuine new home, which a rename+edit in one commit needs).
 * A row with no fingerprint at all (an oversized tree) has only the latter.
 */
function renameTargetCorroborated(
  move: { targetFresh: boolean },
  row: { contentHash: string | null },
  targetHash: string | null,
): boolean {
  return move.targetFresh || (row.contentHash !== null && targetHash === row.contentHash);
}

/**
 * Reconcile every share row of one owner against their working tree. OWNER-side:
 * a re-snapshot or a followed rename bumps `updated_at` (the owner changed what
 * teammates see, so the listing may reorder).
 *
 * A rename is followed ONLY on git's own evidence, and only onto a directory
 * that corroborates it (renameTargetCorroborated). Everything that does not
 * resolve falls back rather than guessing, because guessing can carry a share
 * onto content its owner never published: a DELETION revokes even when
 * byte-identical content sits elsewhere, a row whose directory is gone with
 * nothing to explain it unshares, and a rename the safety checks reject leaves
 * the row on the directory it still names. Unsharing costs only the row — the
 * skill, its learn history and a group's blocks all stay.
 */
export async function reconcileOwnerSharedSkills(
  store: SharedSkillReconcileStore,
  repoRoot: string,
  ownerUserId: string,
): Promise<SharedSkillReconcileResult> {
  const result: SharedSkillReconcileResult = {
    resnapshotted: [],
    renamed: [],
    unshared: [],
    drained: [],
  };
  const rows = store.listSharedSkillsByOwner(ownerUserId);
  if (rows.length === 0) {
    return result;
  }
  // A clone being REBUILT has no `.git` and, for a moment, no working tree
  // either (ensureClone removes it before re-cloning a repointed repo). Reading
  // that as "every shared directory was deleted" would revoke the owner's
  // shares wholesale — the callers' repo lock is the first belt, this is the
  // second, since only this function knows the stakes.
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    return result;
  }
  const skills = listRepoSkills(repoRoot);
  const bySlug = new Map(skills.map((entry) => [entry.slug, entry]));
  const hashOf = hashCache(repoRoot);

  // Drain first: a row whose dir turned into a LEARNED copy predates the
  // refusal to re-share linked copies, and must not be followed anywhere.
  const live: SharedSkill[] = [];
  for (const row of rows) {
    if (bySlug.has(row.skillName) && readSkillOrigin(repoRoot, row.skillName)) {
      store.unshareSkill(ownerUserId, row.skillName);
      result.drained.push(row.skillName);
      continue;
    }
    live.push(row);
  }
  // EVERY live row is queried, not only the ones whose directory vanished: a
  // swap committed in one step leaves a directory PRESENT under the old name
  // holding foreign content, so evidence has to beat mere presence.
  const moves = await resolveSkillDirMoves(
    repoRoot,
    new Set(live.map((row) => row.skillName)),
  );

  // Renames first, in dependency order: a row may be moving onto a name another
  // row is about to vacate, so keep sweeping while anything still moves.
  const swept = new Set<string>(); // the rename sweep is finished with this row
  const handled = new Set<string>(); // …and it moved or unshared, so it is done
  const claimed = new Set<string>();
  const held = new Set(live.map((row) => row.skillName));
  const unshare = (row: SharedSkill): void => {
    store.unshareSkill(ownerUserId, row.skillName);
    result.unshared.push(row.skillName);
    held.delete(row.skillName);
    swept.add(row.skillName);
    handled.add(row.skillName);
  };
  const moving = live.filter((row) => moves.get(row.skillName)?.kind === "renamed");
  for (let progress = true; progress; ) {
    progress = false;
    for (const row of moving) {
      const move = moves.get(row.skillName);
      if (swept.has(row.skillName) || move?.kind !== "renamed" || held.has(move.to)) {
        continue;
      }
      const target = bySlug.get(move.to);
      const moved =
        target &&
        !claimed.has(move.to) &&
        !readSkillOrigin(repoRoot, move.to) &&
        renameTargetCorroborated(move, row, hashOf(move.to))
          ? store.renameSharedSkill(ownerUserId, row.skillName, move.to, {
              displayName: target.name,
              description: target.description,
              contentHash: hashOf(move.to),
              bumpUpdatedAt: true,
            })
          : null;
      if (moved) {
        claimed.add(move.to);
        held.delete(row.skillName);
        held.add(move.to);
        swept.add(row.skillName);
        handled.add(row.skillName);
        result.renamed.push({ from: row.skillName, to: move.to });
      } else if (bySlug.has(row.skillName)) {
        // The evidence didn't survive the safety checks (target taken, a
        // learned copy, or content that corroborates nothing) — but the row's
        // OWN directory is still there, so the share stays where it is and the
        // snapshot pass below refreshes it. Guessing further is what this
        // whole path refuses to do.
        swept.add(row.skillName);
      } else {
        unshare(row);
      }
      progress = true;
    }
  }

  for (const row of live) {
    if (handled.has(row.skillName)) {
      continue;
    }
    const current = bySlug.get(row.skillName);
    // Nothing left to describe — the directory is gone (or a leftover rename
    // never resolved). A DELETION revokes even when the directory somehow
    // reappeared: it is a decision, not an accident.
    if (!current || moves.get(row.skillName)?.kind === "deleted") {
      unshare(row);
      continue;
    }
    // Compare against the frontmatter SNAPSHOT, never the effective
    // description: an owner with a custom 소개 문구 would otherwise look
    // permanently drifted and get re-snapshotted (and re-sorted) every pass.
    // shareSkill leaves custom_description alone, so it survives this.
    const currentHash = hashOf(current.slug);
    if (
      current.name !== row.displayName ||
      current.description !== row.snapshotDescription ||
      // A null hash is UNKNOWN (a tree past the transfer caps), not drift.
      // shareSkill COALESCEs a null back to the stored one, so treating it as
      // drift would re-fire every pass: the avatar would keep reporting share
      // changes and every commit would re-sort teammates' 탐색.
      (currentHash !== null && currentHash !== row.contentHash)
    ) {
      store.shareSkill(ownerUserId, {
        skillName: current.slug,
        displayName: current.name,
        description: current.description,
        contentHash: currentHash,
      });
      result.resnapshotted.push(row.skillName);
    }
  }
  return result;
}

/**
 * The VIEWER-path half of the above: a teammate's preview/learn found the
 * listing's source dir gone, before the owner's own commit/tab reconciled it.
 * Same git evidence and the same corroboration as the owner path — matching by
 * content hash alone is gone, because it could follow a DELETION onto an
 * unrelated identical directory. `bumpUpdatedAt: false`, because a viewer
 * action must never reorder the owner's listing (same invariant as
 * setSharedSkillContentHash).
 *
 * Returns the new name on success; null (nothing changed) when the dir is still
 * there, the row is gone, or the evidence doesn't hold — the caller then prunes
 * the stale row exactly as before.
 */
export async function rescueSharedSkillRename(
  store: SharedSkillReconcileStore,
  repoRoot: string,
  row: RenameSubject,
): Promise<{ to: string } | null> {
  // Every preview runs this, and "the dir is still there" is the overwhelmingly
  // common answer — give it with one stat instead of parsing every skill's
  // frontmatter (listRepoSkills reads each SKILL.md). The SKILL.md-exists test
  // is listRepoSkills' membership rule for one slug.
  const presentMd = resolveInRepo(repoRoot, `${SKILL_DIR}/${row.skillName}/SKILL.md`);
  if ((presentMd && fs.existsSync(presentMd)) || !fs.existsSync(path.join(repoRoot, ".git"))) {
    return null; // the dir is present (so this was no rename), or the clone is mid-rebuild
  }
  const bySlug = new Map(listRepoSkills(repoRoot).map((entry) => [entry.slug, entry]));
  const move = (await resolveSkillDirMoves(repoRoot, new Set([row.skillName]))).get(
    row.skillName,
  );
  if (move?.kind !== "renamed") {
    return null;
  }
  const target = bySlug.get(move.to);
  const occupied = new Set(
    store.listSharedSkillsByOwner(row.ownerUserId).map((share) => share.skillName),
  );
  const hashOf = hashCache(repoRoot);
  if (
    !target ||
    occupied.has(move.to) ||
    readSkillOrigin(repoRoot, move.to) ||
    !renameTargetCorroborated(move, row, hashOf(move.to))
  ) {
    return null;
  }
  const moved = store.renameSharedSkill(row.ownerUserId, row.skillName, move.to, {
    displayName: target.name,
    description: target.description,
    contentHash: hashOf(move.to),
    bumpUpdatedAt: false,
  });
  return moved ? { to: move.to } : null;
}

interface CopyStats {
  files: number;
  bytes: number;
  skippedSymlinks: number;
}

/**
 * Recursively copy one skill directory between repo working trees. Source
 * entries are lstat'ed: symlinks are SKIPPED (never followed — a committed
 * link could point anywhere on the server), regular files are size-capped,
 * anything else (sockets, devices) is skipped. Throws message-coded errors in
 * the knowledgeRepo style: SKILL_NOT_FOUND, SKILL_EXISTS, INVALID_NAME,
 * SKILL_FILE_TOO_LARGE, SKILL_TOO_LARGE, TOO_MANY_FILES.
 */
export async function copySkillDir(
  srcRoot: string,
  srcSlug: string,
  destRoot: string,
  destSlug: string,
): Promise<CopyStats> {
  // Slugs are single path segments by construction; anything else is unsafe.
  if (
    srcSlug !== sanitizeName(srcSlug) ||
    destSlug !== sanitizeName(destSlug) ||
    !srcSlug ||
    !destSlug
  ) {
    throw new Error("INVALID_NAME");
  }
  const srcLex = resolveInRepo(srcRoot, `${SKILL_DIR}/${srcSlug}`);
  const destLex = resolveInRepo(destRoot, `${SKILL_DIR}/${destSlug}`);
  if (!srcLex || !destLex) {
    throw new Error("INVALID_NAME");
  }
  // Source must exist (realpath containment guards symlinked ancestors) and
  // actually be a skill directory.
  const src = realpathContained(srcRoot, srcLex, true);
  if (!src || !fs.existsSync(path.join(src, "SKILL.md"))) {
    throw new Error("SKILL_NOT_FOUND");
  }
  if (fs.lstatSync(src).isSymbolicLink() || !fs.statSync(src).isDirectory()) {
    throw new Error("SKILL_NOT_FOUND");
  }
  // Destination must not exist yet; its (possibly not-yet-created) path must
  // stay inside the learner's repo after resolving existing ancestors.
  const dest = realpathContained(destRoot, destLex, false);
  if (!dest) {
    throw new Error("INVALID_NAME");
  }
  if (fs.existsSync(dest)) {
    throw new Error("SKILL_EXISTS");
  }
  const stats: CopyStats = { files: 0, bytes: 0, skippedSymlinks: 0 };
  await copyTree(src, dest, stats, 0);
  return stats;
}

async function copyTree(
  srcDir: string,
  destDir: string,
  stats: CopyStats,
  depth: number,
): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) {
    throw new Error("TOO_MANY_FILES");
  }
  await fsp.mkdir(destDir, { recursive: true });
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    const stat = await fsp.lstat(srcPath);
    if (stat.isSymbolicLink()) {
      stats.skippedSymlinks += 1;
      continue;
    }
    if (stat.isDirectory()) {
      await copyTree(srcPath, destPath, stats, depth + 1);
      continue;
    }
    if (!stat.isFile()) {
      continue; // sockets/FIFOs etc. — never part of a skill
    }
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      throw new Error("SKILL_FILE_TOO_LARGE");
    }
    stats.files += 1;
    stats.bytes += stat.size;
    if (stats.files > MAX_SKILL_FILES) {
      throw new Error("TOO_MANY_FILES");
    }
    if (stats.bytes > MAX_SKILL_TOTAL_BYTES) {
      throw new Error("SKILL_TOO_LARGE");
    }
    // Raw byte copy (binary-safe — skills may bundle small assets/scripts).
    await fsp.copyFile(srcPath, destPath);
  }
}

/**
 * Rewrite the copied skill's IDENTITY files so it loads under `slug`:
 * `.claude-plugin/plugin.json` (created when the source skill lacked one —
 * without it the marketplace entry is not loadable) and, when the frontmatter
 * carries a `name:`, the SKILL.md name line (the CLI prefers frontmatter over
 * the directory name, so a stale name would collide with the source skill).
 */
async function rewriteSkillIdentity(
  destRoot: string,
  slug: string,
  description: string,
): Promise<void> {
  const dir = resolveInRepo(destRoot, `${SKILL_DIR}/${slug}`)!;
  const pluginJsonPath = path.join(dir, ".claude-plugin", "plugin.json");
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(await fsp.readFile(pluginJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    manifest = {};
  }
  manifest.name = slug;
  if (description && !manifest.description) {
    manifest.description = description;
  }
  await fsp.mkdir(path.dirname(pluginJsonPath), { recursive: true });
  await fsp.writeFile(pluginJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const mdPath = path.join(dir, "SKILL.md");
  try {
    const raw = await fsp.readFile(mdPath, "utf8");
    if (raw.startsWith("---")) {
      const end = raw.indexOf("\n---", 3);
      if (end > 0) {
        const frontmatter = raw.slice(0, end);
        const rewritten = frontmatter.replace(/^name:\s*.+$/m, `name: ${slug}`);
        if (rewritten !== frontmatter) {
          await fsp.writeFile(mdPath, rewritten + raw.slice(end), "utf8");
        }
      }
    }
  } catch {
    // SKILL.md unreadable — copy already validated it exists; leave as-is.
  }
}

/** Everything the learn flow needs to report back to its caller. */
export interface LearnResult {
  /** The slug the skill landed under in the learner's repo. */
  slug: string;
  /** Repo-relative path of the learned SKILL.md (UI deep-link / tool text). */
  skillPath: string;
  /** False when the commit found a clean tree (should not happen in practice). */
  committed: boolean;
  /** Symlinks in the source tree that were skipped rather than followed. */
  skippedSymlinks: number;
  /**
   * True when the learner restricts loaded marketplace plugins to a subset
   * (`selected`) — the learned skill won't LOAD until they enable it there.
   */
  needsSelection: boolean;
  /** The SOURCE directory's content hash recorded in the origin marker. */
  contentHash: string | null;
  /** True when this learn replaced an existing provenance-matched copy. */
  updated: boolean;
}

/**
 * Learn one shared skill: refresh both clones, copy the skill directory,
 * rewrite its identity, record provenance, advertise it in the learner's
 * marketplace manifest, and commit+push with the learner's git identity.
 *
 * `updateSlug` switches to UPDATE mode: the learner's existing
 * `skills/<updateSlug>/` is replaced with the sharer's current version —
 * allowed ONLY when the repo's origin markers resolve this share to exactly
 * that directory (fail closed: NOT_LEARNED_FROM_SHARE otherwise).
 *
 * Message-coded errors from copySkillDir propagate, plus SKILL_IS_LEARNED_COPY
 * when the SOURCE is itself a linked copy (a legacy row — prune it); clone/push
 * failures throw raw git errors (callers scrub via scrubGitError).
 */
export async function learnSkillIntoRepo(opts: {
  sharerCtx: KnowledgeRepoContext;
  learnerCtx: KnowledgeRepoContext;
  /** The sharer's `skills/<slug>` directory name (share row's skillName). */
  skillName: string;
  /** Optional different name to learn under (conflict resolution / rebrand). */
  newName?: string;
  /** UPDATE mode: replace this existing learner slug in place (see above). */
  updateSlug?: string;
  /**
   * The share's former names (its rename trail). An existing copy's origin
   * marker records the name it was learned under, so after the share followed a
   * rename the trail is what still matches it — but only as the sole answer
   * (resolveShareCopy). The marker is rewritten with the CURRENT name below, so
   * it self-heals after one update.
   */
  previousNames?: string[];
  /**
   * Overwrite even a LOCALLY CUSTOMIZED copy (update mode only). Without it a
   * copy whose current hash differs from the origin marker's localHash — or
   * whose marker predates localHash — throws SKILL_LOCALLY_MODIFIED so the
   * caller can get explicit user confirmation first.
   */
  allowModified?: boolean;
  /** The sharer's @username, recorded in the origin marker for display. */
  sharerUsername: string;
  commitMessage: string;
  identity: { name: string; email: string };
}): Promise<LearnResult> {
  const destSlug = opts.updateSlug
    ? opts.updateSlug
    : opts.newName
      ? normalizeSkillSlug(opts.newName)
      : opts.skillName;
  if (!destSlug) {
    throw new Error("INVALID_NAME");
  }
  // Refresh the SHARER's clone so the learner gets the current version, then
  // the learner's own working tree (also creates it on first use).
  const srcRoot = await ensureClone(opts.sharerCtx);
  const destRoot = await ensureClone(opts.learnerCtx);
  const source = readRepoSkill(srcRoot, opts.skillName);
  if (!source) {
    throw new Error("SKILL_NOT_FOUND");
  }
  // A share row pointing at a still-linked LEARNED copy predates the
  // no-re-share rule: refuse rather than extend the chain (callers prune the
  // stale row, the same way they prune a share whose directory is gone).
  assertSkillShareable(srcRoot, opts.skillName);
  const sourceHash = hashSkillDir(srcRoot, opts.skillName);
  if (opts.updateSlug) {
    // Only a copy that PROVABLY came from this share may be replaced — the
    // origin marker is the authorization, not the matching directory name.
    // A marker naming the share's CURRENT name is that proof on its own (an
    // owner's live share names are unique), and it must keep authorizing even
    // when the learner holds SEVERAL copies of this share (learn + learn under
    // new_name both write the current name) — the caller named destSlug, so
    // there is nothing to disambiguate. Only a marker matched through the
    // rename TRAIL is resolved across the WHOLE repo and trusted solely as the
    // unique answer: a name this share left behind can now belong to an
    // unrelated share, and a marker naming it would otherwise authorize
    // overwriting THAT share's copy.
    const own = readSkillOrigin(destRoot, destSlug);
    if (!own || own.ownerUserId !== opts.sharerCtx.userId) {
      throw new Error("NOT_LEARNED_FROM_SHARE");
    }
    if (own.skillName !== opts.skillName) {
      const copies: { slug: string; origin: SkillOrigin }[] = [];
      for (const entry of listRepoSkills(destRoot)) {
        const origin = readSkillOrigin(destRoot, entry.slug);
        if (origin?.ownerUserId === opts.sharerCtx.userId) {
          copies.push({ slug: entry.slug, origin });
        }
      }
      const resolved = resolveShareCopy(copies, (copy) => copy.origin.skillName, {
        skillName: opts.skillName,
        previousNames: opts.previousNames ?? [],
      });
      if (!resolved || !("match" in resolved) || resolved.match.slug !== destSlug) {
        throw new Error("NOT_LEARNED_FROM_SHARE");
      }
    }
    // A locally customized copy (or one we can't judge — legacy marker) is
    // only replaced with the caller's explicit go-ahead: the learner's own
    // edits must never silently flatten under an update.
    if (!opts.allowModified && isSkillLocallyModified(destRoot, destSlug) !== false) {
      throw new Error("SKILL_LOCALLY_MODIFIED");
    }
    const lexical = resolveInRepo(destRoot, `${SKILL_DIR}/${destSlug}`)!;
    const abs = realpathContained(destRoot, lexical, true);
    if (!abs) {
      throw new Error("SKILL_NOT_FOUND");
    }
    await fsp.rm(abs, { recursive: true, force: true });
  }
  const stats = await copySkillDir(srcRoot, opts.skillName, destRoot, destSlug);
  await rewriteSkillIdentity(destRoot, destSlug, source.description);
  // Provenance marker LAST so it overwrites any origin file that reached the
  // destination (a marker-carrying source is refused above, and update mode
  // wipes the dir first — this just keeps the invariant local). localHash is
  // the DEST dir hash post-rewrite (marker file excluded), so a later mismatch
  // means the learner customized the copy.
  const originAbs = path.join(
    resolveInRepo(destRoot, `${SKILL_DIR}/${destSlug}`)!,
    SKILL_ORIGIN_FILE,
  );
  const origin: SkillOrigin = {
    ownerUserId: opts.sharerCtx.userId,
    ownerUsername: opts.sharerUsername,
    skillName: opts.skillName,
    contentHash: sourceHash,
    localHash: hashSkillDir(destRoot, destSlug),
    learnedAt: new Date().toISOString(),
  };
  await fsp.writeFile(originAbs, `${JSON.stringify(origin, null, 2)}\n`, "utf8");
  await ensureMarketplaceManifest(destRoot, destSlug);
  const committed = await commitAndPush(opts.learnerCtx, opts.commitMessage, opts.identity);
  return {
    slug: destSlug,
    skillPath: `${SKILL_DIR}/${destSlug}/SKILL.md`,
    committed,
    skippedSymlinks: stats.skippedSymlinks,
    needsSelection: opts.learnerCtx.selected !== null,
    contentHash: sourceHash,
    updated: Boolean(opts.updateSlug),
  };
}
