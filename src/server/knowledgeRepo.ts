import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import logger from "./logger.js";
import { gitAuthArgs, marketplaceCloneUrl, pathExists, sanitizeName } from "./marketplace.js";
import { tokenForGitUrl, type GitTokenSet } from "./gitCredentials.js";
import { withRepoLock } from "./gitMutex.js";
import {
  git,
  currentBranch,
  originUrl,
  alignBranch,
  commitAndPushClone,
  assertSafeGitValue,
} from "./repoGitCore.js";
import fsSync from "node:fs";
import type { AppConfig, KnowledgeRepoTreeEntry } from "./types.js";
import type { Store } from "./store.js";

const execFileAsync = promisify(execFile);

// The user's knowledge-repo working tree is a FULL clone (unlike the read-only
// shallow plugin clones) so the avatar can commit and push edits back. It lives
// at ${dataDir}/knowledge/${userId}. All file access is constrained to this
// directory — see `resolveInRepo`, which rejects path traversal.

/** The repo directory holding one sub-directory per skill (skills/<slug>/SKILL.md). */
export const SKILL_DIR = "skills";
/** Files/dirs never listed or written through the repo tools. */
const IGNORED_SEGMENTS = new Set([".git"]);
/** Cap how much of a file the repo tools will read, to avoid loading huge blobs. */
const MAX_FILE_BYTES = 512 * 1024;

export interface KnowledgeRepoContext {
  userId: string;
  repo: string;
  branch: string | null;
  // The INTERNAL git token (sees a `users` column / GIT_TOKEN secret). Doubles
  // as the "is a token configured?" gate in repoTools.ts (`if (!c.token)`), so
  // its type/meaning must stay a nullable string. Host routing happens below.
  token: string | null;
  // The EXTERNAL git token (GITHUB_TOKEN secret), used when the repo is hosted
  // on github.com under a GHES deployment. Resolved alongside `token` and
  // routed per-URL via `tokenForGitUrl` (git-05). Optional so existing callers
  // that build this context don't break.
  externalToken?: string | null;
  config: AppConfig;
  // Subset of plugin names to load when the repo is a marketplace of many;
  // null means "load all". Mirrors a plugin's `selected`.
  selected: string[] | null;
}

/** Host-aware token set for a knowledge-repo context (internal + external). */
function repoTokens(ctx: KnowledgeRepoContext): GitTokenSet {
  return { internal: ctx.token, external: ctx.externalToken ?? null };
}

/** On-disk clone path for a user's knowledge-repo working tree. */
export function knowledgeClonePath(userId: string, config: AppConfig): string {
  return path.join(config.dataDir, "knowledge", sanitizeName(userId));
}

/**
 * Resolve a repo-relative path to an absolute one, rejecting any path that
 * escapes the repo root (`..`, absolute paths, symlink-style tricks). Returns
 * null when the path is unsafe. The repo root itself resolves to "".
 */
export function resolveInRepo(repoRoot: string, relPath: string): string | null {
  // Reject absolute paths outright rather than silently reinterpreting them as
  // repo-relative (which would make "/etc/passwd" look "safe").
  if (path.isAbsolute(relPath)) {
    return null;
  }
  const normalized = path.normalize(relPath).replace(/^(\.\/)+/, "");
  if (normalized === "" || normalized === ".") {
    return repoRoot;
  }
  const segments = normalized.split(/[\\/]/);
  if (segments.some((s) => s === ".." || IGNORED_SEGMENTS.has(s))) {
    return null;
  }
  const abs = path.resolve(repoRoot, normalized);
  const root = path.resolve(repoRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return null;
  }
  return abs;
}

/**
 * Verify that an already lexically-resolved path stays inside the repo even
 * after following symlinks. The clone is a full checkout of a user-controlled
 * repo, and git preserves committed symlinks — so `evil -> /etc/passwd` would
 * pass the purely-lexical `resolveInRepo` check. We realpath the deepest
 * existing ancestor (the target itself for reads; its parent for not-yet-created
 * writes) and confirm it's still under the repo root's realpath. Returns null
 * if it escapes. `mustExist` distinguishes read (target must exist) from write
 * (parent must exist, leaf may not). Exported for skillTransfer.ts so the
 * skill-copy path shares THIS containment logic instead of re-deriving it.
 */
export function realpathContained(repoRoot: string, abs: string, mustExist: boolean): string | null {
  let realRoot: string;
  try {
    realRoot = fsSync.realpathSync(repoRoot);
  } catch {
    return null;
  }
  const within = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);

  // Fast path: the target itself exists — realpath it directly.
  try {
    return within(fsSync.realpathSync(abs)) ? abs : null;
  } catch {
    if (mustExist) {
      return null; // read of a non-existent target
    }
  }

  // Write to a not-yet-existing path: realpath the DEEPEST EXISTING ancestor so
  // a symlinked ancestor (at any depth) can't let a later mkdir/write escape.
  // The non-existing tail is appended lexically and re-validated against root.
  let ancestor = path.dirname(abs);
  while (ancestor !== path.dirname(ancestor)) {
    try {
      const realAncestor = fsSync.realpathSync(ancestor);
      if (!within(realAncestor)) {
        return null;
      }
      // Recompose: real ancestor + the lexical remainder below it.
      const rel = path.relative(ancestor, abs);
      const recomposed = path.resolve(realAncestor, rel);
      return within(recomposed) ? recomposed : null;
    } catch {
      ancestor = path.dirname(ancestor); // climb until an existing dir is found
    }
  }
  return null;
}

/**
 * Ensure the user's knowledge repo is cloned (full clone) and up to date on
 * the configured branch. Returns the working-tree path. Fetches if already
 * cloned, then fast-forwards the branch to the remote tip — but PRESERVES
 * committed-but-unpushed work: if HEAD is ahead of origin/<branch> (e.g. a prior
 * commitAndPush committed locally but the push failed on token/network/branch
 * protection), it merges --ff-only and, if that can't fast-forward, leaves the
 * local branch untouched rather than hard-resetting it away. Serialized per
 * clone path so concurrent turns can't interleave fetch/checkout (git-02).
 */
export async function ensureClone(ctx: KnowledgeRepoContext): Promise<string> {
  const repoRoot = knowledgeClonePath(ctx.userId, ctx.config);
  return withRepoLock(repoRoot, () => ensureCloneLocked(ctx, repoRoot));
}

async function ensureCloneLocked(ctx: KnowledgeRepoContext, repoRoot: string): Promise<string> {
  const url = marketplaceCloneUrl(ctx.repo, ctx.config.githubHost);
  // Reject values git would read as options (e.g. `--upload-pack=…` → RCE) and
  // `scheme::` remote-helper syntax (`ext::sh -c …` → command execution). ONE
  // shared validator across every clone path — this path used to check only for
  // a leading dash, so it relied on git's own default protocol policy to refuse
  // `ext` (T3.8).
  assertSafeGitValue(url, "repo");
  assertSafeGitValue(ctx.branch, "branch");
  const auth = gitAuthArgs(url, tokenForGitUrl(url, ctx.config, repoTokens(ctx)));

  // If the connected repo was changed in settings, the existing clone's `origin`
  // still points at the OLD repo and `git fetch origin` would silently keep
  // pulling it (the new URL is only used on the first clone). When origin no
  // longer matches the configured repo, discard the stale clone and re-clone —
  // its branches/commits belonged to a different repo and don't apply here.
  if (await pathExists(path.join(repoRoot, ".git"))) {
    const origin = await originUrl(repoRoot);
    if (origin !== null && origin !== url) {
      logger.info({ userId: ctx.userId, repo: ctx.repo, origin }, "knowledge repo changed; re-cloning");
      await fs.rm(repoRoot, { recursive: true, force: true }).catch(() => {});
      // If the removal failed, `.git` still points at the OLD repo and the fetch
      // branch below would silently keep serving it as the newly-configured one.
      // Fail loudly rather than mistake the stale clone for the new repo.
      if (await pathExists(path.join(repoRoot, ".git"))) {
        throw new Error(
          "STALE_CLONE_REMOVAL_FAILED: could not discard the previous knowledge-repo clone; refusing to serve the old repository",
        );
      }
    }
  }

  if (await pathExists(path.join(repoRoot, ".git"))) {
    await git(repoRoot, [...auth, "fetch", "--prune", "origin"]);
  } else {
    await fs.mkdir(path.dirname(repoRoot), { recursive: true });
    // `--` stops a crafted url/repoRoot from being parsed as an option.
    const args = [...auth, "clone"];
    if (ctx.branch) {
      args.push("--branch", ctx.branch);
    }
    args.push("--", url, repoRoot);
    try {
      await execFileAsync("git", args, { timeout: 180_000 });
    } catch (error) {
      // A failed/interrupted clone leaves a half-initialized dir that poisons
      // every later sync (next run sees a dir, skips clone, then fails). Remove
      // the partial destination so the next run re-clones cleanly (git-06).
      await fs.rm(repoRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    logger.info({ userId: ctx.userId, repo: ctx.repo }, "knowledge repo cloned");
  }

  // Align the working tree with the chosen branch's remote tip.
  const branch = ctx.branch || (await currentBranch(repoRoot));
  if (branch && !branch.startsWith("-")) {
    await alignBranch(
      repoRoot,
      branch,
      { userId: ctx.userId, repo: ctx.repo },
      "knowledge repo has unpushed commits that can't fast-forward; leaving local branch as-is",
    );
  }
  return repoRoot;
}

/**
 * List the repo's tracked files + directories (excluding `.git`), as relative
 * POSIX paths, sorted dirs-then-files for a stable tree render.
 */
export async function listTree(repoRoot: string): Promise<KnowledgeRepoTreeEntry[]> {
  const entries: KnowledgeRepoTreeEntry[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (IGNORED_SEGMENTS.has(dirent.name)) {
        continue;
      }
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        entries.push({ path: rel, type: "dir" });
        await walk(path.join(dir, dirent.name), rel);
      } else if (dirent.isFile()) {
        entries.push({ path: rel, type: "file" });
      }
    }
  }
  await walk(repoRoot, "");
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return entries;
}

/** Read a file's text content. Throws on traversal, missing file, or oversize. */
export async function readFile(repoRoot: string, relPath: string): Promise<string> {
  const lexical = resolveInRepo(repoRoot, relPath);
  if (!lexical || lexical === repoRoot) {
    throw new Error("INVALID_PATH");
  }
  // Follow symlinks and re-check containment (defeats committed `evil -> /etc/...`).
  const abs = realpathContained(repoRoot, lexical, true);
  if (!abs) {
    throw new Error("INVALID_PATH");
  }
  const stat = await fs.lstat(abs);
  if (stat.isSymbolicLink()) {
    throw new Error("INVALID_PATH");
  }
  if (!stat.isFile()) {
    throw new Error("NOT_A_FILE");
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error("FILE_TOO_LARGE");
  }
  return fs.readFile(abs, "utf8");
}

/** Write (creating parent dirs) a text file. Throws on traversal/oversize. */
export async function writeFile(repoRoot: string, relPath: string, content: string): Promise<void> {
  const lexical = resolveInRepo(repoRoot, relPath);
  if (!lexical || lexical === repoRoot) {
    throw new Error("INVALID_PATH");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new Error("FILE_TOO_LARGE");
  }
  // Resolve symlinks on the deepest existing ancestor BEFORE creating any dirs:
  // a committed symlink ancestor (e.g. `skills -> /tmp`) must not let mkdir/write
  // escape the repo. `abs` is the realpath-validated, repo-contained target.
  const abs = realpathContained(repoRoot, lexical, false);
  if (!abs) {
    throw new Error("INVALID_PATH");
  }
  // Refuse to write through an existing symlink at the leaf.
  try {
    if ((await fs.lstat(abs)).isSymbolicLink()) {
      throw new Error("INVALID_PATH");
    }
  } catch (e) {
    if (e instanceof Error && e.message === "INVALID_PATH") throw e;
    // ENOENT: leaf doesn't exist yet — fine.
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/**
 * Replace an exact text snippet in an EXISTING tracked file (targeted edit, so
 * the caller need not resend the whole file). Mirrors the built-in `Edit` tool:
 * `oldString` must occur exactly once unless `replaceAll` is set. Throws the same
 * traversal/symlink guards as read/write (INVALID_PATH), plus NOT_FOUND (missing
 * file), NOT_A_FILE, FILE_TOO_LARGE, NO_CHANGE (old === new or empty old),
 * STRING_NOT_FOUND (no match), and STRING_NOT_UNIQUE (multiple matches without
 * replaceAll). Returns the number of replacements made.
 */
export async function editFile(
  repoRoot: string,
  relPath: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): Promise<number> {
  if (!oldString || oldString === newString) {
    throw new Error("NO_CHANGE");
  }
  const lexical = resolveInRepo(repoRoot, relPath);
  if (!lexical || lexical === repoRoot) {
    throw new Error("INVALID_PATH");
  }
  // mustExist=false resolves symlinked ancestors but leaves the leaf unresolved,
  // so the lstat below can reject a symlinked leaf (same guard as writeFile).
  const abs = realpathContained(repoRoot, lexical, false);
  if (!abs) {
    throw new Error("INVALID_PATH");
  }
  const stat = await fs.lstat(abs).catch(() => null);
  if (!stat) {
    throw new Error("NOT_FOUND");
  }
  if (stat.isSymbolicLink()) {
    throw new Error("INVALID_PATH");
  }
  if (!stat.isFile()) {
    throw new Error("NOT_A_FILE");
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error("FILE_TOO_LARGE");
  }
  const current = await fs.readFile(abs, "utf8");
  const occurrences = current.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error("STRING_NOT_FOUND");
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error("STRING_NOT_UNIQUE");
  }
  // split/join (not String.replace) so `newString` is inserted literally — a `$&`
  // or `$1` in the replacement must not be interpreted as a match reference. When
  // !replaceAll we've already asserted a single occurrence, so this replaces once.
  const next = current.split(oldString).join(newString);
  if (Buffer.byteLength(next, "utf8") > MAX_FILE_BYTES) {
    throw new Error("FILE_TOO_LARGE");
  }
  await fs.writeFile(abs, next, "utf8");
  return replaceAll ? occurrences : 1;
}

/**
 * Delete a tracked file OR directory (recursively). Throws on traversal. No-op
 * if already gone. `recursive` lets a whole skill directory be removed in one
 * call; `force` won't follow a symlinked leaf (it removes the link itself) and
 * the realpath'd parent containment guards against symlinked ancestors.
 */
export async function deleteFile(repoRoot: string, relPath: string): Promise<void> {
  const lexical = resolveInRepo(repoRoot, relPath);
  if (!lexical || lexical === repoRoot) {
    throw new Error("INVALID_PATH");
  }
  const abs = realpathContained(repoRoot, lexical, false);
  if (!abs) {
    throw new Error("INVALID_PATH");
  }
  await fs.rm(abs, { force: true, recursive: true });
}

/**
 * Move/rename a file or directory within the repo. Throws on traversal, a
 * missing source (NOT_FOUND), or a symlinked source/destination leaf. Creates
 * the destination's parent dirs. Works for both files and directories.
 */
export async function moveFile(repoRoot: string, fromRel: string, toRel: string): Promise<void> {
  const fromLex = resolveInRepo(repoRoot, fromRel);
  const toLex = resolveInRepo(repoRoot, toRel);
  if (!fromLex || fromLex === repoRoot || !toLex || toLex === repoRoot) {
    throw new Error("INVALID_PATH");
  }
  const absFrom = realpathContained(repoRoot, fromLex, false);
  const absTo = realpathContained(repoRoot, toLex, false);
  if (!absFrom || !absTo) {
    throw new Error("INVALID_PATH");
  }
  // Source must exist and not be a symlink (don't move the link target out).
  const src = await fs.lstat(absFrom).catch(() => null);
  if (!src) {
    throw new Error("NOT_FOUND");
  }
  if (src.isSymbolicLink()) {
    throw new Error("INVALID_PATH");
  }
  // Refuse to overwrite through an existing symlink at the destination leaf.
  try {
    if ((await fs.lstat(absTo)).isSymbolicLink()) {
      throw new Error("INVALID_PATH");
    }
  } catch (e) {
    if (e instanceof Error && e.message === "INVALID_PATH") throw e;
    // ENOENT: destination doesn't exist yet — fine.
  }
  await fs.mkdir(path.dirname(absTo), { recursive: true });
  await fs.rename(absFrom, absTo);
}

/**
 * Scaffold a new skill under `skills/<name>/SKILL.md` with a minimal frontmatter
 * stub, and ensure the repo advertises it as a marketplace (creating/updating
 * `.claude-plugin/marketplace.json`). Returns the SKILL.md relative path so the
 * UI can open it for editing. Throws if the skill dir already exists.
 */
export async function scaffoldSkill(
  repoRoot: string,
  name: string,
  description: string,
): Promise<string> {
  const slug = sanitizeName(name).toLowerCase().replace(/^-+|-+$/g, "") || "skill";
  const skillRel = `${SKILL_DIR}/${slug}`;
  const abs = resolveInRepo(repoRoot, skillRel);
  if (!abs) {
    throw new Error("INVALID_PATH");
  }
  if (await pathExists(abs)) {
    throw new Error("SKILL_EXISTS");
  }
  const desc = description.trim() || `${slug} skill`;
  const skillMd = `---
name: ${slug}
description: ${desc}
---

# ${name}

Describe what this skill does and when the avatar should use it.
`;
  await writeFile(repoRoot, `${skillRel}/SKILL.md`, skillMd);
  // The plugin manifest the SDK looks for inside each marketplace plugin dir.
  await writeFile(
    repoRoot,
    `${skillRel}/.claude-plugin/plugin.json`,
    `${JSON.stringify({ name: slug, description: desc }, null, 2)}\n`,
  );
  await ensureMarketplaceManifest(repoRoot, slug);
  return `${skillRel}/SKILL.md`;
}

/**
 * Ensure `.claude-plugin/marketplace.json` exists and lists the given plugin
 * (by relative source). Idempotent: an already-listed plugin is left untouched.
 * Shared with skillTransfer.ts (a learned skill must be advertised the same
 * way a scaffolded one is, or it never loads).
 */
export async function ensureMarketplaceManifest(repoRoot: string, slug: string): Promise<void> {
  const manifestRel = ".claude-plugin/marketplace.json";
  const abs = resolveInRepo(repoRoot, manifestRel)!;
  interface Entry {
    name?: string;
    source?: string;
  }
  interface Manifest {
    name?: string;
    plugins?: Entry[];
  }
  let manifest: Manifest = { name: "marketplace", plugins: [] };
  if (await pathExists(abs)) {
    try {
      manifest = JSON.parse(await fs.readFile(abs, "utf8")) as Manifest;
    } catch {
      // Corrupt manifest: start fresh rather than fail the scaffold.
      manifest = { name: "marketplace", plugins: [] };
    }
  }
  if (!Array.isArray(manifest.plugins)) {
    manifest.plugins = [];
  }
  const source = `./${SKILL_DIR}/${slug}`;
  if (!manifest.plugins.some((p) => p?.source === source)) {
    manifest.plugins.push({ name: slug, source });
  }
  await writeFile(repoRoot, manifestRel, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Seed a freshly-created knowledge repo with a default template: a VALID (but
 * empty) Claude plugin marketplace — a root `.claude-plugin/marketplace.json`
 * with `{name, plugins: []}` — plus a README explaining the skill layout. This
 * is what makes the repo loadable as a marketplace from the moment it's created.
 * No-op (returns false) when a marketplace manifest already exists, so it never
 * clobbers an established repo; returns true when it wrote the template.
 */
export async function writeRepoTemplate(
  repoRoot: string,
  repoName: string,
  kind: "personal" | "group" = "personal",
): Promise<boolean> {
  const manifestRel = ".claude-plugin/marketplace.json";
  if (await pathExists(resolveInRepo(repoRoot, manifestRel)!)) {
    return false;
  }
  const shortName = repoName.split("/").pop() || repoName;
  const marketplaceName =
    sanitizeName(shortName).toLowerCase().replace(/^-+|-+$/g, "") || "knowledge";
  await writeFile(
    repoRoot,
    manifestRel,
    `${JSON.stringify({ name: marketplaceName, plugins: [] }, null, 2)}\n`,
  );
  await writeFile(repoRoot, "README.md", repoTemplateReadme(shortName, kind));
  await writeFile(repoRoot, "CLAUDE.md", repoTemplateClaudeMd(shortName, kind));
  // Seed the second-brain vault skeleton (raw/ inbox + wiki/ consolidated layer) for
  // BOTH personal and group repos. Empty dirs need a .gitkeep to survive commit/clone.
  // The brain-* default skills operate on this layout; existing repos created before
  // this change keep marketplace.json (so they early-return above) and are upgraded by
  // the brain-migrate skill instead. NOTE: no skills are seeded here on purpose — the
  // brain skills are default-bundled, so marketplace.json stays {plugins: []}.
  await writeFile(repoRoot, "raw/.gitkeep", "");
  for (const section of ["sources", "entities", "concepts", "synthesis"]) {
    await writeFile(repoRoot, `wiki/${section}/.gitkeep`, "");
  }
  await writeFile(repoRoot, "wiki/index.md", vaultIndexStub());
  await writeFile(repoRoot, "wiki/log.md", vaultLogStub());
  await writeFile(repoRoot, "wiki/_template.md", vaultNoteTemplate());
  return true;
}

/**
 * Starter CLAUDE.md seeded at the repo root. Unlike skills (which the avatar
 * pulls on demand), this file is injected into the avatar's prompt as standing
 * guidance on EVERY conversation, so it's the place for always-apply rules,
 * conventions, and long-term context. Kept short on purpose — the server caps
 * what it injects.
 */
function repoTemplateClaudeMd(name: string, kind: "personal" | "group" = "personal"): string {
  if (kind === "group") {
    // Team-framed, Korean human-facing + English-readable structure. Kept short —
    // the server caps the GROUP CLAUDE.md injection at GROUP_CLAUDE_MD_CAP (4000).
    return `# ${name} — 팀 공유 브레인 (CLAUDE.md)

이 저장소는 그룹이 함께 쓰는 **공유 지식 저장소(팀 브레인)** 입니다. 이 파일은 구성원들의
아바타에게 **매 대화마다** 상시 지침으로 주입됩니다. 시스템·안전 지침이 항상 우선하며,
길어지면 서버가 일부를 잘라냅니다(그룹 CLAUDE.md는 개인보다 짧게).

## 구조 (vault)
- \`wiki/<section>/<slug>.md\` — 정제된 팀 노트. frontmatter: \`title\`, \`tags\`, \`aliases\`.
  팀 브레인 검색(\`mcp__group_brain__search\`)이 우선 검색합니다.
- 관련 노트는 본문에서 \`[[노트 제목]]\`으로 연결하세요 — 이 링크가 지식 그래프를 잇습니다.
- \`raw/\` — 아직 정리되지 않은 원본 캡처. 나중에 reflect로 wiki에 정리.

## 운영 원칙
- 답하기 전에 먼저 팀 브레인을 검색하세요.
- **읽기는 모든 구성원**, **쓰기·커밋은 그룹 관리자만**(\`mcp__group_repo__write_file\`/\`commit\`).
  구성원은 관리자에게 정리를 요청하세요.
- 정리(consolidation)는 **온디맨드**입니다. 관리자가 brain-reflect로 \`raw/\`+\`wiki/\`만 보고
  정리합니다. **대화 기록은 절대 읽지 않습니다** — 그룹에는 공유 대화 스트림이 없고, 구성원
  개인 대화를 읽는 것은 프라이버시 위반입니다.

## 여기에 적어 둘 것
- 팀 공통 응답 말투/형식, 자주 쓰는 용어·약어, 반복 작업의 기본 규칙, 합의된 결정과 배경.
`;
  }
  // Personal: bilingual — English instructions (the model reads this as standing input)
  // + Korean examples for the human owner. Kept under PERSONAL_CLAUDE_MD_CAP (6000).
  return `# ${name} — your second brain (CLAUDE.md)

This file is injected into your avatar as standing guidance on EVERY turn (skills load on
demand; this file always applies). System and safety instructions always win, and the server
caps the injected length — keep it tight.

## This repo is a second brain (vault layout)
- \`raw/\` — timestamped raw capture (inbox).
- \`wiki/\` — consolidated, durable notes: \`sources/\`, \`entities/\`, \`concepts/\`, \`synthesis/\`.
- \`wiki/index.md\` — table of contents. \`wiki/log.md\` — reflection history.
  \`wiki/_template.md\` — the note shape (title / date / source / tags / aliases).

## Operating principles
- Search the brain (\`mcp__brain__search\`) BEFORE answering from memory or asking the user to
  repeat themselves.
- Capture durable facts with the **brain-ingest** skill; consolidate \`raw/\` → \`wiki/\` with
  **brain-reflect**; keep it healthy with **brain-lint**.
- Link related notes inline as \`[[Note Title]]\` — these links connect the knowledge graph view.
- If the \`wiki/\` vault is missing (an older repo), run **brain-migrate** once — it never
  overwrites existing files.
- An edit is not persisted until you commit.

## 여기에 적어 둘 것 (소유자 메모)
- 자주 쓰는 용어·약어, 합의된 결정과 배경, 반복 작업의 기본 규칙, 선호하는 응답 말투/형식.
`;
}

/** The starter README seeded alongside the marketplace manifest. */
function repoTemplateReadme(name: string, kind: "personal" | "group" = "personal"): string {
  if (kind === "group") {
    return `# ${name} — 팀 공유 지식 저장소

이 저장소는 그룹이 함께 쓰는 **공유 지식 저장소(팀 브레인)** 입니다. 구성원의 아바타가
대화에서 활용하며, 정리된 지식을 다음 대화부터 함께 사용합니다.

## 구조 (세컨드 브레인 vault)

- \`raw/\` — 원본 캡처 인박스
- \`wiki/{sources,entities,concepts,synthesis}/\` — 정제된 팀 노트
- \`wiki/index.md\` · \`wiki/log.md\` · \`wiki/_template.md\` — 목차 / 정리 이력 / 노트 템플릿

읽기는 모든 구성원, 쓰기·커밋은 그룹 관리자만 가능합니다.
`;
  }
  return `# ${name} — 지식 저장소 (세컨드 브레인)

이 저장소는 아바타(Noah Almighty)의 **개인 지식 저장소(세컨드 브레인)** 입니다. 아바타가
대화에서 직접 관리하며, 여기에 정리한 지식을 다음 대화부터 사용합니다.

## 구조 (세컨드 브레인 vault)

- \`raw/\` — 원본 캡처 인박스 (brain-ingest)
- \`wiki/{sources,entities,concepts,synthesis}/\` — 정제된 노트 (brain-reflect)
- \`wiki/index.md\` · \`wiki/log.md\` · \`wiki/_template.md\` — 목차 / 정리 이력 / 노트 템플릿
- \`.claude-plugin/marketplace.json\` — 추가 스킬(플러그인) 목록

기본 brain-* 스킬은 아바타에 기본 내장되어 있습니다. 새 스킬은 "○○ 스킬 만들어줘"라고
요청하면 \`scaffold_skill\`로 생성됩니다.
`;
}

/** Starter `wiki/index.md` — the table of contents brain-reflect keeps current. */
function vaultIndexStub(): string {
  return `# Index

Table of contents for the consolidated \`wiki/\` notes. brain-reflect keeps this current;
brain-lint flags notes missing from here.

## Sources

## Entities

## Concepts

## Synthesis
`;
}

/** Starter `wiki/log.md` — append-only history of consolidation passes. */
function vaultLogStub(): string {
  return `# Reflection log

Append-only history of consolidation passes (brain-reflect). One dated entry per pass.
`;
}

/** Starter `wiki/_template.md` — the shape of a single durable note. */
function vaultNoteTemplate(): string {
  return `---
title:
date:
source:
tags: []
aliases: []
---

<!-- One durable note. \`title\` is how other notes link to it; keep it factual and
self-contained. \`tags\`/\`aliases\` improve brain search recall. Reference related
notes inline as \`[[Note Title]]\` — these links connect the knowledge graph. -->
`;
}

/**
 * Stage all changes, commit with the user's identity, and push to the remote
 * branch. Returns false (no commit) when the tree is clean. Throws on git
 * failure (auth, conflicts) so the route can surface the detail.
 */
export async function commitAndPush(
  ctx: KnowledgeRepoContext,
  message: string,
  identity: { name: string; email: string },
): Promise<boolean> {
  const repoRoot = knowledgeClonePath(ctx.userId, ctx.config);
  // Serialize the add/commit/push against any concurrent ensureClone or other
  // commit on the same working tree (git-02). Keyed by clone path, same as
  // ensureClone, and never nested under that lock (commitAndPush doesn't clone).
  return withRepoLock(repoRoot, () =>
    commitAndPushClone(repoRoot, {
      url: marketplaceCloneUrl(ctx.repo, ctx.config.githubHost),
      config: ctx.config,
      tokens: repoTokens(ctx),
      branch: ctx.branch,
      message,
      defaultMessage: "Update knowledge repo",
      identity,
      log: { userId: ctx.userId, repo: ctx.repo },
      pushedMessage: "knowledge repo pushed",
    }),
  );
}

/**
 * Build a knowledge-repo context for a user, or null if no repo is configured.
 * Shared by the HTTP routes, the chat plugin-load path, and the agent's repo
 * tools so they all resolve the same repo/branch/token from the store.
 */
export function knowledgeRepoContextFor(
  store: Store,
  userId: string,
  config: AppConfig,
): KnowledgeRepoContext | null {
  const { repo, branch, selected } = store.getKnowledgeRepo(userId);
  if (!repo) {
    return null;
  }
  // Resolve BOTH tokens: the internal one (and its truthiness gate) plus the
  // external GITHUB_TOKEN, so a github.com-hosted repo on a GHES deployment
  // still authenticates (git-05). `tokenForGitUrl` routes by host per git call.
  const tokens = store.getGitTokens(userId);
  return {
    userId,
    repo,
    branch,
    selected,
    token: tokens.internal ?? null,
    externalToken: tokens.external ?? null,
    config,
  };
}

/**
 * Resolve the commit author identity for a user's knowledge-repo commits,
 * falling back to the display name / username when the explicit identity is
 * unset. A no-reply-style default email keeps commits valid without leaking a
 * real address.
 */
export function commitIdentityFor(
  store: Store,
  user: { id: string; username: string; displayName: string; alias?: string },
): { name: string; email: string } {
  const u = store.getUserById(user.id);
  return {
    name: u?.gitIdentityName || u?.alias || user.alias || user.displayName || user.username,
    email: u?.gitIdentityEmail || `${user.username}@noah-almighty.local`,
  };
}
