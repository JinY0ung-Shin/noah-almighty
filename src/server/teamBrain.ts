// Team brain (팀 브레인): ONE instance-wide LOCAL git vault at
// <dataDir>/team-brain that ONLY Noah's own code writes. Teammates read it
// (brain search scope "team") and PROPOSE; an admin decides; every state change
// is a human button press on a chat card (routes/teamBrain.ts). There is no
// `origin` remote — the admin backup is a push-only mirror (teamBrainBackup.ts).
//
// Never hand this tree to a sandbox and never run git in any other `.git`: the
// agent sees note CONTENT only, through the brain tools. All git goes through
// repoGitCore's `git()` (serverGitEnv hardening, config on env, never argv) and
// every write is serialized under ONE withRepoLock key (not reentrant — the
// exported ops take it once, the *Locked internals never do).
//
// Design + mechanics: docs/architecture/team-brain.md.

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { withRepoLock } from "./gitMutex.js";
import { git } from "./repoGitCore.js";
import { safeIdentity } from "./repoGitGuards.js";
import { listTree, readFile, writeFile } from "./knowledgeRepo.js";
import { normalizeWikiPath, rankBrainNotes, type BrainSearchResult } from "./agent/brainSearch.js";
import { buildKnowledgeGraph } from "./knowledgeGraph.js";
import { TEAM_BRAIN_MAX_CONTENT_BYTES, type TeamBrainOp } from "../shared/teamBrain.js";
import type { AppConfig, KnowledgeGraph } from "./types.js";

/** Directory under dataDir. `group-knowledge` is a RETIRED name — never reuse it. */
export const TEAM_BRAIN_DIR = "team-brain";
export const TEAM_BRAIN_BRANCH = "main";

/** Noah's own committer identity for the seed commit. */
const NOAH_IDENTITY = { name: "Noah Almighty", email: "team-brain@noah-almighty.local" };

const INDEX_SEED = `# Team brain

This is the team's shared knowledge — decisions, system facts, fixes for recurring
problems, glossary terms, conventions and owners. Every note was proposed by a
teammate and approved by an admin. Notes state the CURRENT truth; history is git.
`;

/** Structural files a proposal may never target (mirrors brainSearch/knowledgeGraph exclusions). */
const STRUCTURAL = new Set(["wiki/index.md", "wiki/log.md"]);
const MAX_PATH_LENGTH = 200;

export function teamBrainRoot(config: Pick<AppConfig, "dataDir">): string {
  return path.join(config.dataDir, TEAM_BRAIN_DIR);
}

/** True once the vault exists on disk (it is created lazily on first use). */
export function teamBrainInitialized(config: Pick<AppConfig, "dataDir">): boolean {
  return fsSync.existsSync(path.join(teamBrainRoot(config), ".git"));
}

export type TeamNotePathCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * A path a proposal may target: a `.md` note under `wiki/`, no structural file,
 * no `_template.md`, only plain path characters. The reason is agent-facing English.
 */
export function validateTeamNotePath(raw: unknown): TeamNotePathCheck {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, reason: "A note path is required, e.g. `wiki/concepts/deploy-process.md`." };
  }
  const checked = normalizeWikiPath(raw.trim());
  if (!checked.ok || checked.norm === "wiki") {
    return { ok: false, reason: "Team notes live under `wiki/` — use a path like `wiki/concepts/<name>.md`." };
  }
  const norm = checked.norm;
  if (norm.length > MAX_PATH_LENGTH) {
    return { ok: false, reason: `The note path is too long (max ${MAX_PATH_LENGTH} characters).` };
  }
  if (!norm.endsWith(".md") || norm.endsWith("_template.md") || STRUCTURAL.has(norm)) {
    return {
      ok: false,
      reason: "Only a regular `.md` note under `wiki/` can be proposed (not `wiki/index.md`, `wiki/log.md` or a template).",
    };
  }
  // Letters (any script), digits, space, and . _ - / only — no control chars, no `..`, no hidden segments.
  if (!/^[\p{L}\p{N} ._\-/]+$/u.test(norm) || norm.split("/").some((seg) => seg === "" || seg.startsWith("."))) {
    return { ok: false, reason: "The note path may only contain letters, digits, spaces, `.`, `_`, `-` and `/`." };
  }
  return { ok: true, path: norm };
}

/** Patterns that look like a credential (accident prevention, not containment). */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAuthorization:\s*(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{12,}/i,
];

/**
 * Does `text` carry a credential — one of the proposer's own stored secret
 * values (≥ 6 chars), or a well-known token shape? Returns the secret NAME (or
 * the generic label) so the refusal can say what to remove without echoing it.
 */
export function findSecretInText(text: string, ownSecrets: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(ownSecrets)) {
    if (typeof value === "string" && value.length >= 6 && text.includes(value)) return name;
  }
  return SECRET_PATTERNS.some((re) => re.test(text)) ? "a credential-like token" : null;
}

export function contentTooLarge(content: string): boolean {
  return Buffer.byteLength(content, "utf8") > TEAM_BRAIN_MAX_CONTENT_BYTES;
}

async function initLocked(root: string): Promise<void> {
  if (fsSync.existsSync(path.join(root, ".git"))) return;
  await fs.mkdir(path.join(root, "wiki"), { recursive: true });
  await git(root, ["init", "--quiet", `--initial-branch=${TEAM_BRAIN_BRANCH}`]);
  await fs.writeFile(path.join(root, "wiki", "index.md"), INDEX_SEED, "utf8");
  await git(root, ["add", "--", "wiki/index.md"]);
  await git(root, ["commit", "--quiet", "-m", "team-brain: initialize"], undefined, identityConfig(NOAH_IDENTITY));
}

function identityConfig(identity: { name: string; email: string }) {
  const { name, email } = safeIdentity(identity);
  return [
    ["user.name", name],
    ["user.email", email],
  ] as const;
}

/** Create the vault on first use; returns its root. */
export async function ensureTeamBrainRepo(config: Pick<AppConfig, "dataDir">): Promise<string> {
  const root = teamBrainRoot(config);
  if (teamBrainInitialized(config)) return root;
  await withRepoLock(root, () => initLocked(root));
  return root;
}

/** The note's committed git blob id, or null when it is not in HEAD. */
export async function teamNoteBlob(root: string, notePath: string): Promise<string | null> {
  try {
    const { stdout } = await git(root, ["rev-parse", "--verify", "--quiet", `HEAD:${notePath}`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** A note's content, or null when it does not exist. `notePath` must be validated. */
export async function readTeamNote(config: Pick<AppConfig, "dataDir">, notePath: string): Promise<string | null> {
  if (!teamBrainInitialized(config)) return null;
  try {
    return await readFile(teamBrainRoot(config), notePath);
  } catch (error) {
    if (error instanceof Error && (error.message === "INVALID_PATH" || error.message === "NOT_A_FILE")) return null;
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

export interface TeamNoteState {
  content: string | null;
  blob: string | null;
}

/** Content + committed blob of a note (both null when absent). */
export async function teamNoteState(config: Pick<AppConfig, "dataDir">, notePath: string): Promise<TeamNoteState> {
  if (!teamBrainInitialized(config)) return { content: null, blob: null };
  const root = teamBrainRoot(config);
  const [content, blob] = await Promise.all([readTeamNote(config, notePath), teamNoteBlob(root, notePath)]);
  return { content, blob };
}

/** Ranked recall over the team vault (an absent vault reads as an empty one). */
export async function searchTeamBrain(
  config: Pick<AppConfig, "dataDir">,
  query: string,
  limit?: number,
): Promise<BrainSearchResult> {
  if (!teamBrainInitialized(config)) return { kind: "ok", hits: [] };
  return rankBrainNotes(teamBrainRoot(config), query, limit);
}

/** Notes in the vault (excluding the structural index/log and templates). */
export async function countTeamNotes(config: Pick<AppConfig, "dataDir">): Promise<number> {
  if (!teamBrainInitialized(config)) return 0;
  const entries = await listTree(teamBrainRoot(config));
  return entries.filter(
    (e) =>
      e.type === "file" &&
      e.path.startsWith("wiki/") &&
      e.path.endsWith(".md") &&
      !e.path.endsWith("_template.md") &&
      !STRUCTURAL.has(e.path),
  ).length;
}

/** Sync twin of countTeamNotes for describe_system (a bounded walk; never follows a link). */
export function countTeamNotesSync(config: Pick<AppConfig, "dataDir">): number {
  const wiki = path.join(teamBrainRoot(config), "wiki");
  let count = 0;
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 8 || count > 10_000) return;
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const relPath = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(dir, e.name), relPath, depth + 1);
      else if (e.isFile() && e.name.endsWith(".md") && !e.name.endsWith("_template.md") && !STRUCTURAL.has(relPath)) count += 1;
    }
  };
  walk(wiki, "wiki", 0);
  return count;
}

export async function teamBrainGraph(config: Pick<AppConfig, "dataDir">): Promise<KnowledgeGraph> {
  if (!teamBrainInitialized(config)) return { nodes: [], edges: [] };
  return buildKnowledgeGraph(teamBrainRoot(config));
}

export class TeamNoteConflictError extends Error {
  constructor(public readonly reason: "STALE" | "EXISTS" | "MISSING") {
    super(reason);
  }
}

export interface ApplyTeamNoteInput {
  path: string;
  op: TeamBrainOp;
  content: string;
  /** The blob the decision was made against (null = the note must not exist yet). */
  expectedBlob: string | null;
  title: string;
  proposalId: string;
  /** The admin who pressed the button. */
  author: { name: string; email: string };
  /** The teammate who proposed it (omitted when the admin wrote it). */
  coAuthor?: { name: string; email: string } | null;
}

/**
 * Write ONE note and commit it — under the vault lock, re-checking that the
 * note is still exactly what the decision saw (`expectedBlob`), so a note that
 * changed after the card was drafted is refused instead of overwritten.
 * Returns the new commit id.
 */
export async function applyTeamNote(config: Pick<AppConfig, "dataDir">, input: ApplyTeamNoteInput): Promise<string> {
  const checked = validateTeamNotePath(input.path);
  if (!checked.ok) throw new Error("INVALID_PATH");
  if (contentTooLarge(input.content)) throw new Error("FILE_TOO_LARGE");
  const root = teamBrainRoot(config);
  return withRepoLock(root, async () => {
    await initLocked(root);
    const current = await teamNoteBlob(root, checked.path);
    if (input.op === "create" && current !== null) throw new TeamNoteConflictError("EXISTS");
    if (input.op === "update" && current === null) throw new TeamNoteConflictError("MISSING");
    if (current !== input.expectedBlob) throw new TeamNoteConflictError("STALE");
    const body = input.content.endsWith("\n") ? input.content : `${input.content}\n`;
    await writeFile(root, checked.path, body);
    try {
      return await commitNoteLocked(root, checked.path, input);
    } catch (error) {
      // Never leave an unapproved note in the working tree (reads serve it) or
      // staged for the NEXT approval's commit: back to HEAD (or gone, for a create).
      await git(root, ["reset", "-q", "--", checked.path]).catch(() => undefined);
      if (current) await git(root, ["checkout", "--", checked.path]).catch(() => undefined);
      else await fs.rm(path.join(root, checked.path), { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

/** Stage + commit ONE note (vault lock held by the caller). Identical content → current HEAD. */
async function commitNoteLocked(root: string, notePath: string, input: ApplyTeamNoteInput): Promise<string> {
  await git(root, ["add", "--", notePath]);
  try {
    await git(root, ["diff", "--cached", "--quiet", "--", notePath]);
    const { stdout } = await git(root, ["rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    /* staged changes exist — commit them */
  }
  const subject = `team-brain: ${input.title.replace(/[\r\n]+/g, " ").trim().slice(0, 120) || notePath}`;
  const trailers = [`Proposal: ${input.proposalId}`];
  if (input.coAuthor) {
    const co = safeIdentity(input.coAuthor);
    trailers.push(`Co-authored-by: ${co.name} <${co.email}>`);
  }
  // Pathspec: the commit carries THIS note only, whatever else the index holds.
  await git(root, ["commit", "--quiet", "-m", `${subject}\n\n${trailers.join("\n")}`, "--", notePath], undefined, identityConfig(input.author));
  const { stdout } = await git(root, ["rev-parse", "HEAD"]);
  return stdout.trim();
}
