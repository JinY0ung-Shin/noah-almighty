/**
 * Skills on pi runs (docs/architecture/pi-runtime.md "Skills").
 *
 * pi does not load Claude Code plugin roots, so Noah materializes the run's
 * skills as FILES in the viewer's sandbox, `/workspace/.noah/skills/<root>/<skill>/`,
 * and lists them (name, description, SKILL.md path) in the conversation's
 * frozen instructions; the model `read`s a skill's SKILL.md before using it.
 *
 *  - OWNER runs (owner chat, routine, task API) copy every root of the run:
 *    the bundled default-skills, the owner's plugins, the personal and group
 *    knowledge repos' skills.
 *  - A trusted COLLEAGUE runs in their OWN sandbox (design U4), so only the
 *    bundled default-skills (public) are copied there; the owner's personal
 *    skills are listed with `via: "mcp"` and read through the read-only
 *    `mcp__skills__read` tool — their files never land in someone else's sandbox.
 *  - The admin skill policy is enforced by omission: a disabled skill (bare
 *    name or `<plugin>:<name>`, the same rule the SDK hook applies) is neither
 *    copied nor listed nor readable.
 *
 * Claude Code specifics are rewritten in the copied Markdown: `${CLAUDE_SKILL_DIR}`
 * becomes the skill's sandbox path, and the Bash tool's millisecond
 * `timeout: 600000` becomes pi's seconds (`timeout: 600`).
 *
 * Re-sync is cheap: a stat-only fingerprint (path, size, mtime) of each source
 * root and of what was written is kept in `.noah/skills/.noah-sync.json`, and a
 * root is rewritten only when either side changed. Noah owns `.noah/skills`
 * wholesale (a stale root is removed); nothing outside it is ever touched.
 *
 * The sandbox can replace `.noah`, `.noah/skills` or anything inside them with
 * a link (review C1: `ln -s ../.. .noah/skills` once made this sync list
 * `PI_WORKSPACES_DIR` and delete every other user's workspace). So every write,
 * listing and removal here goes through descriptor-pinned folders
 * (`piSandboxDir`, `pinnedFs.ts`): a link anywhere below the user root refuses
 * the sync — the run then lists the skills as `via: "mcp"` (read through
 * `mcp__skills__read`, like a colleague run) instead of at paths Noah could not
 * write — and nothing is ever followed or removed outside `.noah/skills`.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppConfig, PiSkillIndexEntry, PluginRoot } from "../../types.js";
import { skillMdMeta } from "../skillDiscovery.js";
import type { PinnedDir } from "../../pinnedFs.js";
import { PI_SANDBOX_ROOT, piSandboxDir, type PiWorkspace } from "./piWorkspace.js";

/** Where skills live in the sandbox. */
export const PI_SKILLS_SANDBOX_DIR = path.posix.join(PI_SANDBOX_ROOT, ".noah", "skills");
const MANIFEST = ".noah-sync.json";
/** Bump when the copy/rewrite rules change, so every sandbox re-syncs once. */
const SYNC_VERSION = 1;
const SKIP_NAMES = new Set(["__pycache__", ".build", ".git", "node_modules", ".DS_Store"]);
const ROOT_MAX_FILES = 5_000;
const ROOT_MAX_BYTES = 128 * 1024 * 1024;
const FILE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_INDEX_ENTRIES = 80;
const MAX_DESCRIPTION_CHARS = 300;

export type PiSkillEntry = PiSkillIndexEntry;

export interface PiSkillPlan {
  entries: PiSkillEntry[];
  /** `<root>/<dir>` → host skill folder, for mcp__skills__read (colleague runs). */
  mcpSources: Map<string, string>;
  /** Roots that could not be written (logged; the run still starts). */
  failures: string[];
}

export type PiPluginRootKind = "default" | "knowledge" | "group" | "plugin" | "other";

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Where a plugin root lives: the plugins bundled with this Noah build, the
 * personal or a group knowledge clone, an installed plugin repo, or elsewhere.
 * Also decides which roots may spawn stdio MCP servers on pi (`mcpProxies.ts`).
 */
export function piPluginRootKind(config: AppConfig, root: string): PiPluginRootKind {
  const resolved = path.resolve(root);
  if (config.defaultPluginsDir && inside(path.resolve(config.defaultPluginsDir), resolved)) return "default";
  const data = path.resolve(config.dataDir);
  if (inside(path.join(data, "knowledge"), resolved)) return "knowledge";
  if (inside(path.join(data, "group-knowledge"), resolved)) return "group";
  if (inside(path.join(data, "plugins"), resolved)) return "plugin";
  return "other";
}

/** The plugin.json `name` of a root (the `<plugin>:<skill>` qualifier), or null. */
function pluginNameOf(root: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null;
  } catch {
    return null;
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40) || "root";
}

/** Skill directories of a root: `<root>/skills/<dir>/SKILL.md` (real folders only). */
function skillDirsOf(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(root, "skills"), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((dir) => {
      try {
        return fs.lstatSync(path.join(root, "skills", dir, "SKILL.md")).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

interface WalkedFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

/** lstat walk of one folder: links and specials never followed, SKIP_NAMES pruned. */
function walk(dir: string, budget: { files: number; bytes: number }): WalkedFile[] {
  const out: WalkedFile[] = [];
  const visit = (abs: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_NAMES.has(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(childAbs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(childAbs, childRel, depth + 1);
      } else if (stat.isFile() && stat.size <= FILE_MAX_BYTES) {
        budget.files += 1;
        budget.bytes += stat.size;
        if (budget.files > ROOT_MAX_FILES || budget.bytes > ROOT_MAX_BYTES) throw new Error("skill root exceeds the copy caps");
        out.push({ rel: childRel, abs: childAbs, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode });
      }
    }
  };
  visit(dir, "", 0);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function fingerprint(parts: string[], files: WalkedFile[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part}\0`);
  for (const file of files) hash.update(`${file.rel}\0${file.size}\0${Math.trunc(file.mtimeMs)}\0`);
  return hash.digest("hex");
}

/**
 * Claude Code → pi rewrites of a skill's Markdown: the skill folder
 * placeholder, and the Bash tool's millisecond timeout (pi's bash `timeout` is
 * in seconds and caps at 86 400, so a literal 600000 fails validation).
 */
export function rewriteSkillMarkdown(text: string, skillDir: string): string {
  return text.split("${CLAUDE_SKILL_DIR}").join(skillDir).replace(/timeout:\s*600000\b/g, "timeout: 600");
}

function isDisabled(disabled: Set<string>, name: string, dir: string, pluginName: string | null): boolean {
  return [name, dir].some((candidate) => disabled.has(candidate) || (pluginName !== null && disabled.has(`${pluginName}:${candidate}`)));
}

interface Manifest {
  version: number;
  roots: Record<string, { source: string; dest: string }>;
}

function readManifest(skills: PinnedDir): Manifest {
  try {
    const raw = skills.readFile(MANIFEST, 4 * 1024 * 1024);
    if (!raw) throw new Error("no manifest");
    const parsed = JSON.parse(raw.toString("utf8")) as Manifest;
    if (parsed.version === SYNC_VERSION && parsed.roots && typeof parsed.roots === "object") return parsed;
  } catch {
    /* rebuilt below */
  }
  return { version: SYNC_VERSION, roots: {} };
}

/**
 * Copy one root's included skills into `target` (a fresh pinned folder),
 * rewriting Markdown. Every sub-folder is pinned and every file created
 * exclusively, so a link the sandbox races into the fresh folder is never
 * written through (the copy fails instead).
 */
function writeRoot(source: string, dirs: string[], target: PinnedDir, sandboxRoot: string): void {
  const budget = { files: 0, bytes: 0 };
  const folders = new Map<string, PinnedDir>();
  const folderOf = (parts: string[]): PinnedDir => {
    const key = parts.join("/");
    let folder = folders.get(key);
    if (!folder) {
      const opened = target.dir(parts, { create: true, mode: 0o755 });
      if (!opened) throw new Error(`could not create ${key} in the sandbox skill copy`);
      folders.set(key, opened);
      folder = opened;
    }
    return folder;
  };
  try {
    for (const dir of dirs) {
      const skillSandboxDir = path.posix.join(sandboxRoot, dir);
      for (const file of walk(path.join(source, "skills", dir), budget)) {
        const parts = [dir, ...file.rel.split("/")];
        const name = parts.pop()!;
        const folder = folderOf(parts);
        const mode = file.mode & 0o111 ? 0o755 : 0o644;
        if (file.rel.toLowerCase().endsWith(".md")) {
          const data = rewriteSkillMarkdown(fs.readFileSync(file.abs, "utf8"), skillSandboxDir);
          if (folder.writeFileExclusive(name, data, mode) !== "written") throw new Error(`${dir}/${file.rel} already exists`);
        } else {
          folder.copyFileIn(file.abs, name, mode);
        }
      }
    }
  } finally {
    for (const folder of folders.values()) folder.close();
  }
}

export interface MaterializeInput {
  config: AppConfig;
  workspace: PiWorkspace;
  pluginRoots: PluginRoot[];
  /** True when the run executes AS the owner (their own sandbox). */
  ownerRun: boolean;
  /** Admin policy: bare skill names and `<plugin>:<skill>`. */
  disabledSkills: string[];
}

/**
 * Sync the run's skills into the sandbox and return the index for the
 * prompt (plus the colleague-run MCP sources). Best effort per root: a root
 * that cannot be written is left out of the index rather than listed at a
 * path that does not exist.
 */
export function materializePiSkills(input: MaterializeInput): PiSkillPlan {
  const skills = input.workspace.hostRoot
    ? piSandboxDir(input.workspace, [".noah", "skills"], { create: true, mode: 0o755 })
    : null;
  try {
    return materializeInto(input, skills);
  } finally {
    skills?.close();
  }
}

function materializeInto(input: MaterializeInput, skills: PinnedDir | null): PiSkillPlan {
  const { config, workspace, pluginRoots, ownerRun } = input;
  const disabled = new Set(input.disabledSkills);
  const plan: PiSkillPlan = { entries: [], mcpSources: new Map(), failures: [] };
  const used = new Set<string>();
  const roots: { label: string; source: string; dirs: string[]; local: boolean }[] = [];
  for (const root of pluginRoots) {
    const source = path.resolve(root.path);
    const kind = piPluginRootKind(config, source);
    const pluginName = pluginNameOf(source);
    let label = kind === "default" || kind === "knowledge" ? kind : `${kind}-${slug(pluginName ?? path.basename(source))}`;
    for (let n = 2; used.has(label); n += 1) label = `${label.replace(/-\d+$/, "")}-${n}`;
    used.add(label);
    const dirs = skillDirsOf(source).filter((dir) => {
      const meta = skillMdMeta(path.join(source, "skills", dir, "SKILL.md"));
      return !isDisabled(disabled, meta.name || dir, dir, pluginName);
    });
    if (dirs.length === 0) continue;
    // A colleague's sandbox only ever receives the bundled (public) skills;
    // with no usable `.noah/skills` (unmounted, or a link/file planted there)
    // every root is read through mcp__skills__read instead.
    roots.push({ label, source, dirs, local: skills !== null && (ownerRun || kind === "default") });
  }
  if (workspace.hostRoot && !skills) {
    plan.failures.push(".noah/skills: not a plain folder in the sandbox (a link or a file there is never followed); skills are read through mcp__skills__read this run");
  }

  const manifest = skills ? readManifest(skills) : { version: SYNC_VERSION, roots: {} };
  const next: Manifest = { version: SYNC_VERSION, roots: {} };
  const written = new Set<string>();

  for (const root of roots) {
    const sandboxRoot = path.posix.join(PI_SKILLS_SANDBOX_DIR, root.label);
    if (root.local && skills) {
      // Stat-only fingerprint walks go through the pinned folder too.
      const target = skills.entry(root.label);
      try {
        const sourceFp = fingerprint(
          [String(SYNC_VERSION), root.label, ...root.dirs],
          root.dirs.flatMap((dir) =>
            walk(path.join(root.source, "skills", dir), { files: 0, bytes: 0 }).map((file) => ({ ...file, rel: `${dir}/${file.rel}` })),
          ),
        );
        const destFp = () => fingerprint([], walk(target, { files: 0, bytes: 0 }));
        const known = manifest.roots[root.label];
        const isDir = skills.kind(root.label) === "dir";
        if (!(known && isDir && known.source === sourceFp && known.dest === destFp())) {
          const tmpName = `.tmp-${root.label}-${randomBytes(4).toString("hex")}`;
          try {
            const tmp = skills.dir([tmpName], { create: true, mode: 0o755 });
            if (!tmp) throw new Error("could not create a staging folder in .noah/skills");
            try {
              writeRoot(root.source, root.dirs, tmp, sandboxRoot);
            } finally {
              tmp.close();
            }
            skills.remove(root.label);
            skills.rename(tmpName, root.label);
          } finally {
            skills.remove(tmpName);
          }
        }
        next.roots[root.label] = { source: sourceFp, dest: destFp() };
        written.add(root.label);
      } catch (error) {
        plan.failures.push(`${root.label}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    for (const dir of root.dirs) {
      const meta = skillMdMeta(path.join(root.source, "skills", dir, "SKILL.md"));
      const entry: PiSkillEntry = {
        root: root.label,
        dir,
        name: meta.name || dir,
        description: (meta.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
        via: root.local ? "file" : "mcp",
        ...(root.local ? { skillMd: path.posix.join(sandboxRoot, dir, "SKILL.md") } : {}),
      };
      if (!root.local) plan.mcpSources.set(`${root.label}/${dir}`, path.join(root.source, "skills", dir));
      if (plan.entries.length < MAX_INDEX_ENTRIES) plan.entries.push(entry);
    }
  }

  if (skills) {
    // Noah owns .noah/skills: anything there that is not a current root goes
    // (through the pinned folder — never a listing of wherever a link points).
    try {
      for (const entry of skills.list()) {
        if (entry.name !== MANIFEST && !written.has(entry.name)) skills.remove(entry.name);
      }
      const tmpManifest = `.tmp-manifest-${randomBytes(4).toString("hex")}`;
      if (skills.writeFileExclusive(tmpManifest, JSON.stringify(next)) === "written") skills.rename(tmpManifest, MANIFEST);
    } catch {
      /* the next turn re-syncs */
    }
  }
  return plan;
}
