import fs from "node:fs/promises";
import path from "node:path";
import { marketplaceCloneUrl, pathExists, sanitizeName, scrubGitError, syncGitRepo } from "./marketplace.js";
import { tokenForGitUrl, type GitTokenSet } from "./gitCredentials.js";
import {
  ensureClone,
  knowledgeClonePath,
  knowledgeRepoContextFor,
  type KnowledgeRepoContext,
} from "./knowledgeRepo.js";
import {
  ensureGroupClone,
  groupKnowledgeClonePath,
  groupKnowledgeRepoContextFor,
  groupKnowledgeRepoContextsForUser,
  type GroupKnowledgeRepoContext,
} from "./groupKnowledgeRepo.js";
import logger from "./logger.js";
import type { Store } from "./store.js";
import type {
  AppConfig,
  Plugin,
  PluginRoot,
  RepoPluginContents,
  RepoPluginEntry,
  SkillInfo,
} from "./types.js";

// Per-process clone cache keyed by the destination clone path. Avoids
// re-fetching the same repo on every chat turn; stale entries are refreshed by
// the chat/routine loader's TTL or explicitly by the refresh endpoint.
const clonedPaths = new Set<string>();
const syncingPaths = new Map<string, Promise<void>>();

interface MarketplaceEntry {
  name?: string;
  source?: unknown;
}
interface MarketplaceManifest {
  plugins?: MarketplaceEntry[];
}

/** The on-disk clone path for a given user's plugin repo. */
export function pluginClonePath(userId: string, repo: string, config: AppConfig): string {
  return path.join(config.dataDir, "plugins", sanitizeName(userId), sanitizeName(repo));
}

/** Drop a destination from the clone-once cache so the next sync re-fetches. */
export function forgetClone(destination: string): void {
  clonedPaths.delete(destination);
}

function isPluginRefreshDue(plugin: Pick<Plugin, "lastSyncedAt">, intervalMs: number): boolean {
  if (intervalMs <= 0) {
    return false;
  }
  if (!plugin.lastSyncedAt) {
    return true;
  }
  const syncedAt = Date.parse(plugin.lastSyncedAt);
  if (!Number.isFinite(syncedAt)) {
    return true;
  }
  return Date.now() - syncedAt >= intervalMs;
}

/** The plugin name a repo subdirectory advertises (its `plugin.json` `name`). */
async function pluginNameAt(dir: string): Promise<string | null> {
  const manifest = await readJson<{ name?: string }>(
    path.join(dir, ".claude-plugin", "plugin.json"),
  );
  return typeof manifest?.name === "string" ? manifest.name : null;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * MCP servers the APP registers itself (in claudeAgent), per-user-configured —
 * e.g. `hex-ssh`, which we inject with the owner's SSH key. A plugin's bundled
 * `.mcp.json` may declare a server of the SAME name but WITHOUT the per-user
 * env (the public ops plugin ships a keyless `hex-ssh`). Since MCP config is
 * keyed by server name, the two collide and only one survives — and the
 * plugin's keyless copy can shadow ours, so the avatar gets a server with no
 * key. We strip these names from each plugin `.mcp.json` before handing the
 * root to the SDK, leaving the app's keyed registration as the sole definition.
 */
export const APP_MANAGED_MCP_SERVERS = ["hex-ssh"] as const;

/**
 * Remove app-managed server names (above) from a plugin dir's `.mcp.json`,
 * rewriting it in place. Idempotent and tolerant: no file / not our server /
 * unparseable → no-op. Returns true if it rewrote the file.
 *
 * NOTE: for the knowledge repo this edits the avatar's COMMITTABLE working tree,
 * so `commitAndPush` restores `.mcp.json` from HEAD before `git add -A` — the
 * strip must never be pushed back to the user's repo. See knowledgeRepo.ts.
 */
export async function stripManagedMcpServers(rootDir: string): Promise<boolean> {
  const file = path.join(rootDir, ".mcp.json");
  const config = await readJson<Record<string, unknown>>(file);
  if (!config || typeof config !== "object") {
    return false;
  }
  let changed = false;
  for (const name of APP_MANAGED_MCP_SERVERS) {
    if (name in config) {
      delete config[name];
      changed = true;
    }
  }
  if (changed) {
    await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  }
  return changed;
}

/**
 * A raw MCP server definition read from a plugin root's `.mcp.json`. Kept
 * loose on purpose — the SDK validates the real schema; we only look at the
 * fields we transform (`type`/`env`, plus string fields for
 * `${CLAUDE_PLUGIN_ROOT}` expansion) and pass everything else through.
 */
export type PluginMcpServerDef = Record<string, unknown>;

/**
 * Read the MCP server definitions from a plugin root's `.mcp.json`.
 *
 * Accepts BOTH shapes seen in the wild: a `{ "mcpServers": { <name>: def } }`
 * wrapper (project-style) and a flat `{ <name>: def }` map (the shape
 * `stripManagedMcpServers` has always assumed). App-managed server names
 * (hex-ssh) are dropped here for the same reason that strip exists: the app's
 * keyed registration must stay the sole definition. Missing/unparseable file →
 * empty map.
 */
export async function readPluginMcpServers(
  rootDir: string,
): Promise<Record<string, PluginMcpServerDef>> {
  const config = await readJson<Record<string, unknown>>(path.join(rootDir, ".mcp.json"));
  if (!config || typeof config !== "object") {
    return {};
  }
  const wrapper = config.mcpServers;
  const entries =
    wrapper && typeof wrapper === "object" && !Array.isArray(wrapper)
      ? (wrapper as Record<string, unknown>)
      : config;
  const out: Record<string, PluginMcpServerDef> = {};
  for (const [name, def] of Object.entries(entries)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) continue;
    if ((APP_MANAGED_MCP_SERVERS as readonly string[]).includes(name)) continue;
    out[name] = def as PluginMcpServerDef;
  }
  return out;
}

/**
 * True when a plugin root belongs to the avatar OWNER's own sources — their
 * synced plugin repos (`dataDir/plugins/<userId>/…`) or their personal
 * knowledge repo clone (`dataDir/knowledge/<userId>`, incl. marketplace
 * subdirs). Group knowledge repos and the app's default plugin roots are NOT
 * owned: secrets must never flow into an MCP server a group teammate (or the
 * app repo) defined. Used by the secret-injection lift below.
 */
export function isOwnedPluginRoot(
  rootPath: string,
  avatarUserId: string,
  config: AppConfig,
): boolean {
  const resolved = path.resolve(rootPath);
  const pluginBase = path.resolve(
    path.join(config.dataDir, "plugins", sanitizeName(avatarUserId)),
  );
  const knowledgeBase = path.resolve(knowledgeClonePath(avatarUserId, config));
  return (
    resolved === pluginBase ||
    resolved.startsWith(pluginBase + path.sep) ||
    resolved === knowledgeBase ||
    resolved.startsWith(knowledgeBase + path.sep)
  );
}

/** Expand `${CLAUDE_PLUGIN_ROOT}` in one string value. */
function expandPluginRoot(value: string, rootDir: string): string {
  return value.split("${CLAUDE_PLUGIN_ROOT}").join(rootDir);
}

/**
 * Secret-handoff wiring for `liftPluginMcpServers`: the app-owned wrapper
 * script plus the directory the per-server mode-0600 secret files go in. The
 * caller (claudeAgent) WRITES the files after the lift returns which paths are
 * needed — the values never enter the server definitions themselves.
 */
export interface McpSecretWrapper {
  /** Absolute path of scripts/mcp-secret-wrapper.mjs. */
  scriptPath: string;
  /** Directory for the one-shot secret files (created by the caller). */
  secretsDir: string;
  /** Per-run unique id used in the secret file names. */
  runId: string;
}

/**
 * Lift the MCP servers defined by the given plugin roots' `.mcp.json` files
 * into an SDK `mcpServers`-shaped map, so the app — not the CLI — registers
 * them. Runs with `strictMcpConfig: true` on the query, which stops the CLI
 * from ALSO auto-spawning the same servers from the plugin dirs.
 *
 * Why the app registers them itself: it lets the owner's secret vault reach
 * the OWNED servers while the agent shell (Bash) env stays clean. Per root:
 *  - `${CLAUDE_PLUGIN_ROOT}` in string fields (command/args/env/url/…) is
 *    expanded to the root path, since the CLI can no longer resolve the
 *    plugin origin. Other `${VAR}` forms are left for the CLI's own
 *    `--mcp-config` expansion, same as before the lift.
 *  - OWNED roots (see `isOwnedPluginRoot`) with a stdio def (no `type` or
 *    `type: "stdio"`) are REWRITTEN to run through the secret wrapper:
 *    `node mcp-secret-wrapper.mjs --secrets <file> -- <command> [args…]`.
 *    SECURITY: the SDK serializes `mcpServers` into the CLI's `--mcp-config`
 *    ARGV (readable via /proc/<pid>/cmdline by the agent's own Bash), so
 *    secret VALUES must never be embedded in the def env — only the secret
 *    FILE PATH may appear. The wrapper reads + deletes the 0600 file and
 *    execs the real server with the secrets merged over its env.
 *  - Non-owned roots (group repos, default plugins) are lifted verbatim —
 *    they keep loading, but NEVER receive the owner's secrets.
 *  - FIRST definition of a name wins, matching the load order default →
 *    avatar plugins → knowledge repo → group repos, so a group repo can't
 *    shadow the owner's own server. App in-process servers are spread AFTER
 *    the lifted map at the call site, so app names always win overall.
 *
 * Returns the servers plus the secret-file paths the wrapped defs reference;
 * the caller writes the injectable env to each (0600) BEFORE starting the
 * query. `secretWrapper: null` (no injectable secrets) lifts without wrapping.
 */
export async function liftPluginMcpServers(
  rootPaths: string[],
  opts: {
    avatarUserId: string;
    config: AppConfig;
    secretWrapper: McpSecretWrapper | null;
    /**
     * Env names to BLANK (`""`) on non-owned stdio servers. Shell-exposed
     * secrets live in the CLI subprocess env, which every CLI-spawned server
     * inherits — group/default servers must not see those values.
     */
    maskEnvNames?: string[];
  },
): Promise<{ servers: Record<string, PluginMcpServerDef>; secretFiles: string[] }> {
  const servers: Record<string, PluginMcpServerDef> = {};
  const secretFiles: string[] = [];
  for (const rootPath of rootPaths) {
    const defs = await readPluginMcpServers(rootPath);
    const owned = isOwnedPluginRoot(rootPath, opts.avatarUserId, opts.config);
    for (const [name, rawDef] of Object.entries(defs)) {
      if (name in servers) continue;
      const def: PluginMcpServerDef = {};
      for (const [key, value] of Object.entries(rawDef)) {
        if (typeof value === "string") {
          def[key] = expandPluginRoot(value, rootPath);
        } else if (Array.isArray(value)) {
          def[key] = value.map((v) =>
            typeof v === "string" ? expandPluginRoot(v, rootPath) : v,
          );
        } else if (key === "env" && value && typeof value === "object") {
          const env: Record<string, unknown> = {};
          for (const [envName, envValue] of Object.entries(value)) {
            env[envName] =
              typeof envValue === "string"
                ? expandPluginRoot(envValue, rootPath)
                : envValue;
          }
          def[key] = env;
        } else {
          def[key] = value;
        }
      }
      const type = typeof def.type === "string" ? def.type : "stdio";
      if (!owned && type === "stdio" && opts.maskEnvNames?.length) {
        def.env = {
          ...(def.env && typeof def.env === "object" ? (def.env as object) : {}),
          ...Object.fromEntries(opts.maskEnvNames.map((n) => [n, ""])),
        };
      }
      if (
        owned &&
        type === "stdio" &&
        opts.secretWrapper &&
        typeof def.command === "string"
      ) {
        const file = path.join(
          opts.secretWrapper.secretsDir,
          `plugin-${opts.secretWrapper.runId}-${sanitizeName(name)}.json`,
        );
        secretFiles.push(file);
        const originalArgs = Array.isArray(def.args)
          ? def.args.filter((a): a is string => typeof a === "string")
          : [];
        def.args = [
          opts.secretWrapper.scriptPath,
          "--secrets",
          file,
          "--",
          def.command,
          ...originalArgs,
        ];
        def.command = process.execPath;
        def.type = "stdio";
      }
      servers[name] = def;
    }
  }
  return { servers, secretFiles };
}

async function isPluginDir(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, ".claude-plugin", "plugin.json"));
}

/** One marketplace manifest entry, classified by its on-disk layout. */
interface EnumeratedPlugin {
  /** The raw manifest entry (its `name`/`source`), as authored. */
  entry: MarketplaceEntry;
  /**
   * Absolute dir for a relative (`./...`) in-repo source, else null when the
   * source is missing/non-string/non-relative (remote or object sources, which
   * neither consumer can expand from a local clone). Carries the (string) source
   * alongside so consumers can interpolate it without re-narrowing `unknown`.
   */
  dir: { abs: string; source: string } | null;
  /** Whether `dir` is a loadable plugin dir (has `.claude-plugin/plugin.json`). */
  loadable: boolean;
}

/** The overall repo layout, used by both resolve + inspect walks. */
type MarketplaceLayout =
  | { kind: "single" }
  | { kind: "marketplace"; entries: EnumeratedPlugin[] }
  | { kind: "none" };

/**
 * Walk a cloned repo's marketplace manifest layout ONCE, shared by
 * `resolvePluginRoots` (resolves SDK roots) and `inspectRepoContents` (reports
 * names for the selection UI) — they previously re-implemented the same detect-
 * layout + per-entry resolve loop ("Mirrors" comment). Returns the layout kind
 * and, for a marketplace, every entry already classified (resolved dir +
 * loadable flag). Name resolution (`pluginNameAt`) and warnings stay in each
 * consumer so their exact behavior is unchanged.
 */
async function enumerateMarketplacePlugins(repoRoot: string): Promise<MarketplaceLayout> {
  if (await isPluginDir(repoRoot)) {
    return { kind: "single" };
  }
  const manifest = await readJson<MarketplaceManifest>(
    path.join(repoRoot, ".claude-plugin", "marketplace.json"),
  );
  if (manifest && Array.isArray(manifest.plugins)) {
    const entries: EnumeratedPlugin[] = [];
    for (const entry of manifest.plugins) {
      const source = entry?.source;
      if (typeof source === "string" && source.startsWith(".")) {
        const abs = path.resolve(repoRoot, source);
        entries.push({ entry, dir: { abs, source }, loadable: await isPluginDir(abs) });
      } else {
        entries.push({ entry, dir: null, loadable: false });
      }
    }
    return { kind: "marketplace", entries };
  }
  return { kind: "none" };
}

/**
 * Pull `name` and `description` out of a SKILL.md YAML frontmatter block. We
 * only need two scalar string keys, so a tiny line scanner beats pulling in a
 * full YAML parser (the project has no YAML dep). Returns null if the file has
 * no leading `---` frontmatter. Values may be quoted; quotes are stripped.
 */
function parseSkillFrontmatter(text: string): { name?: string; description?: string } | null {
  // Frontmatter must be the very first thing in the file.
  if (!/^---\r?\n/.test(text)) {
    return null;
  }
  // The closing fence must be a line that is exactly `---` (optional trailing
  // whitespace / CR), so a body line like `---foo` or `----` can't end it early.
  const closing = /\n---[ \t]*\r?(?:\n|$)/.exec(text);
  if (!closing) {
    return null;
  }
  const block = text.slice(text.indexOf("\n") + 1, closing.index);
  const out: { name?: string; description?: string } = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^(name|description)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1] as "name" | "description"] = value;
  }
  return out;
}

/** Read one skill's `SKILL.md` frontmatter into a SkillInfo, or null if absent/invalid. */
async function readSkill(skillDir: string, source: string): Promise<SkillInfo | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const fm = parseSkillFrontmatter(raw);
  const name = fm?.name?.trim() || path.basename(skillDir);
  const description = fm?.description?.trim() ?? "";
  return { name, description, source };
}

/**
 * Enumerate the skills bundled in the given plugin roots by reading each root's
 * `skills/<name>/SKILL.md`. Each root carries a `source` label (e.g. "default"
 * or the plugin repo slug) so the UI can attribute skills to their origin.
 * Tolerant: a missing `skills/` dir or unreadable SKILL.md is simply skipped.
 * Skills are de-duplicated by name (first occurrence wins).
 */
export async function listSkillsInRoots(
  roots: { path: string; source: string }[],
): Promise<SkillInfo[]> {
  const byName = new Map<string, SkillInfo>();
  for (const root of roots) {
    // A resolved root may ITSELF be a single skill (SKILL.md at its root) — the
    // layout a knowledge-repo marketplace produces, where each plugin source
    // points directly at `./skills/<name>`. readSkill returns null when there's
    // no SKILL.md at the root, so this is a no-op for default/owner plugin roots
    // (whose skills live one level down under `skills/`, handled below).
    const selfSkill = await readSkill(root.path, root.source);
    if (selfSkill && !byName.has(selfSkill.name)) {
      byName.set(selfSkill.name, selfSkill);
    }
    // The common plugin layout: skills live in `<root>/skills/<name>/SKILL.md`.
    const skillsDir = path.join(root.path, "skills");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skill = await readSkill(path.join(skillsDir, entry.name), root.source);
      if (skill && !byName.has(skill.name)) {
        byName.set(skill.name, skill);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a cloned repo into one or more SDK plugin roots:
 * - a single-plugin repo (`.claude-plugin/plugin.json` at root) → [root]
 * - a marketplace repo (`.claude-plugin/marketplace.json`) → each listed
 *   plugin's directory (relative `./...` sources, the common case)
 *
 * `selected` (when non-null) restricts a marketplace repo to plugins whose
 * manifest `name` is in the set; `null` loads all. It has no effect on a
 * single-plugin repo.
 */
export async function resolvePluginRoots(
  repoRoot: string,
  label: string,
  onWarn?: (m: string) => void,
  selected?: string[] | null,
): Promise<string[]> {
  const layout = await enumerateMarketplacePlugins(repoRoot);
  if (layout.kind === "single") {
    await stripManagedMcpServers(repoRoot);
    return [repoRoot];
  }
  if (layout.kind === "marketplace") {
    const selectedSet = selected ? new Set(selected) : null;
    const roots: string[] = [];
    for (const { entry, dir, loadable } of layout.entries) {
      // Only relative in-repo sources are expanded; remote/object sources in a
      // marketplace would need their own clone and are skipped with a warning.
      if (dir !== null) {
        if (loadable) {
          // Filter against the owner's selection by the manifest `name`,
          // falling back to the entry name when plugin.json omits one.
          if (selectedSet) {
            const name = (await pluginNameAt(dir.abs)) ?? entry?.name;
            if (!name || !selectedSet.has(name)) {
              continue;
            }
          }
          // Strip any app-managed MCP server (e.g. a keyless `hex-ssh`) so it
          // can't shadow the app's keyed registration. See claudeAgent.
          await stripManagedMcpServers(dir.abs);
          roots.push(dir.abs);
          continue;
        }
        onWarn?.(`${label}: 마켓플레이스 플러그인 "${entry?.name ?? dir.source}"에 .claude-plugin/plugin.json이 없습니다`);
      } else {
        onWarn?.(`${label}: 마켓플레이스 플러그인 "${entry?.name ?? "?"}"의 소스 형식을 지원하지 않습니다`);
      }
    }
    if (roots.length === 0) {
      onWarn?.(`${label}: 마켓플레이스에 불러올 수 있는 플러그인이 없습니다`);
    }
    return roots;
  }

  onWarn?.(`${label}: Claude 플러그인이 아닙니다 (.claude-plugin/plugin.json 또는 marketplace.json 없음)`);
  return [];
}

/**
 * Inspect a cloned repo and list the plugins it contains, for the selection UI.
 * Mirrors `resolvePluginRoots`' layout detection but reports names instead of
 * resolving SDK roots.
 */
export async function inspectRepoContents(repoRoot: string): Promise<RepoPluginContents> {
  const layout = await enumerateMarketplacePlugins(repoRoot);
  if (layout.kind === "single") {
    const name = (await pluginNameAt(repoRoot)) ?? "(unnamed)";
    return { kind: "single", plugins: [{ name, loadable: true }] };
  }
  if (layout.kind === "marketplace") {
    const plugins: RepoPluginEntry[] = [];
    for (const { entry, dir, loadable } of layout.entries) {
      if (dir !== null) {
        const name = (loadable ? await pluginNameAt(dir.abs) : null) ?? entry?.name ?? dir.source;
        plugins.push({ name, loadable });
      } else if (entry?.name) {
        // Unsupported (remote/object) source — surfaced as non-loadable.
        plugins.push({ name: entry.name, loadable: false });
      }
    }
    return { kind: "marketplace", plugins };
  }

  return { kind: "none", plugins: [] };
}

/**
 * Resolve the repo-bundled default plugin (`config.defaultPluginsDir`) into
 * plugin roots loaded for EVERY avatar. No clone — it ships with the server.
 * A missing/invalid dir is tolerated with a warning (chat still works).
 */
export async function loadDefaultPluginRoots(
  config: AppConfig,
  onWarn?: (message: string) => void,
): Promise<PluginRoot[]> {
  const dir = config.defaultPluginsDir;
  if (!dir || !(await pathExists(dir))) {
    return [];
  }
  const roots: PluginRoot[] = [];
  for (const root of await resolvePluginRoots(dir, "default-skills", onWarn)) {
    roots.push({ type: "local", path: root });
  }
  return roots;
}

/** Display label attributed to skills coming from the avatar's knowledge repo. */
export const KNOWLEDGE_REPO_SOURCE = "지식 저장소";

/**
 * One knowledge-repo clone job: how to materialize the working tree (`ensure`),
 * the UI source label to attribute its skills to, and the plugin subset to load.
 * Personal and group knowledge repos differ ONLY in these three fields, so both
 * flow through the single resolver below.
 */
interface KnowledgeRepoJob {
  ensure: () => Promise<string>;
  source: string;
  selected: string[] | null;
}

/**
 * THE shared knowledge-repo resolver: clone each job's working tree and resolve
 * it into `{path, source}` skill-source entries. The 4 public functions below
 * (personal/group × roots/sources) are thin views over this — they differ only
 * in how the jobs are built and whether failures warn (Korean) or stay silent.
 * Tolerant: a clone/fetch failure on one job warns (when `onWarn` given) and
 * contributes no skills, so chat never breaks.
 */
async function resolveKnowledgeRepoSources(
  jobs: KnowledgeRepoJob[],
  onWarn?: (message: string) => void,
): Promise<{ path: string; source: string }[]> {
  const sources: { path: string; source: string }[] = [];
  for (const job of jobs) {
    try {
      const repoRoot = await job.ensure();
      for (const root of await resolvePluginRoots(repoRoot, job.source, onWarn, job.selected)) {
        sources.push({ path: root, source: job.source });
      }
    } catch (error) {
      onWarn?.(`${job.source}: 불러오기 실패 (${scrubGitError(error)})`);
    }
  }
  return sources;
}

/** Wrap a personal knowledge-repo context as a clone job (or none if unset). */
function knowledgeRepoJobs(ctx: KnowledgeRepoContext | null): KnowledgeRepoJob[] {
  return ctx
    ? [{ ensure: () => ensureClone(ctx), source: KNOWLEDGE_REPO_SOURCE, selected: ctx.selected }]
    : [];
}

/**
 * Resolve the avatar's personal knowledge repo into plugin roots, so the skills
 * and knowledge the avatar accumulates there are loaded for EVERY chat. The
 * repo is a FULL clone (via `ensureClone`) shared with the agent's repo-
 * management tools — we reuse that same working tree as a plugin root rather
 * than cloning twice.
 *
 * Failure-tolerant like `loadAvatarPluginRoots`: an unset repo returns `[]`
 * silently; a clone/fetch failure warns and returns `[]` so chat never breaks.
 */
export async function loadKnowledgeRepoRoots(
  ctx: KnowledgeRepoContext | null,
  onWarn?: (message: string) => void,
): Promise<PluginRoot[]> {
  const sources = await resolveKnowledgeRepoSources(knowledgeRepoJobs(ctx), onWarn);
  return sources.map(({ path }) => ({ type: "local", path }));
}

/**
 * Like `loadKnowledgeRepoRoots` but returns `{path, source}` entries for the
 * skills/intro paths, which attribute each skill to its origin. Tolerant: any
 * failure contributes no skills.
 */
export async function knowledgeRepoSkillSources(
  ctx: KnowledgeRepoContext | null,
): Promise<{ path: string; source: string }[]> {
  return resolveKnowledgeRepoSources(knowledgeRepoJobs(ctx));
}

/** Display label attributed to skills coming from a group's shared knowledge repo. */
export const GROUP_KNOWLEDGE_REPO_SOURCE = "그룹 지식 저장소";

/** Source label for one group's repo, including the group name when known. */
function groupRepoSource(ctx: GroupKnowledgeRepoContext): string {
  return ctx.groupName ? `${GROUP_KNOWLEDGE_REPO_SOURCE} · ${ctx.groupName}` : GROUP_KNOWLEDGE_REPO_SOURCE;
}

/** Wrap each group knowledge-repo context as a clone job. */
function groupKnowledgeRepoJobs(contexts: GroupKnowledgeRepoContext[]): KnowledgeRepoJob[] {
  return contexts.map((ctx) => ({
    ensure: () => ensureGroupClone(ctx),
    source: groupRepoSource(ctx),
    selected: ctx.selected,
  }));
}

/**
 * Resolve the group knowledge repos a member shares into plugin roots, so the
 * shared skills load for EVERY chat the member has with their own avatar. Mirrors
 * `loadKnowledgeRepoRoots`; tolerant — a clone/fetch failure on one group warns
 * and contributes no roots rather than breaking chat. Accepts many contexts (a
 * user may belong to several groups, each with a repo).
 */
export async function loadGroupKnowledgeRepoRoots(
  contexts: GroupKnowledgeRepoContext[],
  onWarn?: (message: string) => void,
): Promise<PluginRoot[]> {
  const sources = await resolveKnowledgeRepoSources(groupKnowledgeRepoJobs(contexts), onWarn);
  return sources.map(({ path }) => ({ type: "local", path }));
}

/**
 * The full set of plugin roots an avatar's AGENT should load for a real turn:
 * the repo-bundled default plugins, the avatar's own enabled plugins, its
 * personal knowledge repo, and every group knowledge repo its owner belongs to.
 * Returns `[]` in `local` runtime (no plugins in local dev). This is the SINGLE
 * source of truth shared by the chat endpoint AND the routine scheduler, so the
 * two cannot drift — a routine must be able to USE the same skills a chat can.
 * (The intro/hashtag-generation paths deliberately do NOT use this — they only
 * introspect skill sources read-only, not load full roots.)
 */
export async function loadAgentPluginRoots(
  store: Store,
  avatarId: string,
  config: AppConfig,
  onWarn?: (message: string) => void,
  opts?: { disabledGroupIds?: Set<string> },
): Promise<PluginRoot[]> {
  if (config.agentRuntime === "local") {
    return [];
  }
  // Per-conversation group-knowledge toggle (owner-only): skip the skill roots of
  // any group the owner turned OFF for this conversation. The scheduler and
  // intro/hashtag paths pass no opts, so they always load every group.
  const disabled = opts?.disabledGroupIds;
  const groupContexts = groupKnowledgeRepoContextsForUser(store, avatarId, config).filter(
    (ctx) => !disabled?.has(ctx.groupId),
  );
  return [
    ...(await loadDefaultPluginRoots(config, onWarn)),
    ...(await loadAvatarPluginRoots(
      avatarId,
      store.listEnabledPlugins(avatarId),
      config,
      onWarn,
      store.getGitTokens(avatarId),
      {
        autoRefreshIntervalMs: config.pluginAutoRefreshIntervalMs,
        onSynced: (plugin) => {
          store.markPluginSynced(avatarId, plugin.id);
        },
      },
    )),
    ...(await loadKnowledgeRepoRoots(knowledgeRepoContextFor(store, avatarId, config), onWarn)),
    // Shared knowledge repos of every group the avatar's owner belongs to — so
    // group skills load for all members' chats and routines alike.
    ...(await loadGroupKnowledgeRepoRoots(groupContexts, onWarn)),
  ];
}

/** Per-group/total caps on injected CLAUDE.md so standing memory can't bloat every turn. */
const PERSONAL_CLAUDE_MD_CAP = 6_000;
const GROUP_CLAUDE_MD_CAP = 4_000;
const TOTAL_GROUP_CLAUDE_MD_CAP = 8_000;

/** Standing CLAUDE.md memory read from the avatar's knowledge repos (push, every turn). */
export interface KnowledgeRepoMemory {
  /** Root CLAUDE.md of the personal knowledge repo, or null when absent/empty. */
  personal: string | null;
  /** Root CLAUDE.md of each enabled group repo that has one. */
  groups: { name: string; content: string }[];
}

/** Read a repo-root CLAUDE.md (trimmed, capped). Returns null when missing/empty. */
async function readRepoClaudeMd(repoRoot: string, cap: number): Promise<string | null> {
  try {
    const raw = (await fs.readFile(path.join(repoRoot, "CLAUDE.md"), "utf8")).trim();
    if (!raw) {
      return null;
    }
    return raw.length > cap ? `${raw.slice(0, cap)}\n…(truncated)` : raw;
  } catch {
    return null;
  }
}

/**
 * Load the standing CLAUDE.md memory from the avatar's personal knowledge repo
 * and each enabled group repo. Reads the working-tree clones directly (which
 * `loadAgentPluginRoots` already ensured for the same turn); a missing repo, a
 * missing CLAUDE.md, or a not-yet-cloned repo simply contributes nothing.
 *
 * Group filtering mirrors `loadAgentPluginRoots`: `disabledGroupIds` (the
 * owner's per-conversation toggle) are skipped; colleague turns pass none.
 * Unlike skills (pulled on demand), this is injected into the prompt every turn,
 * so it is capped. Personal memory is always included; the group toggle controls
 * only group memory.
 */
export async function loadKnowledgeRepoMemory(
  store: Store,
  avatarId: string,
  config: AppConfig,
  opts?: { disabledGroupIds?: Set<string> },
): Promise<KnowledgeRepoMemory> {
  if (config.agentRuntime === "local") {
    return { personal: null, groups: [] };
  }
  const personal = store.getKnowledgeRepo(avatarId).repo
    ? await readRepoClaudeMd(knowledgeClonePath(avatarId, config), PERSONAL_CLAUDE_MD_CAP)
    : null;
  const disabled = opts?.disabledGroupIds;
  const groups: { name: string; content: string }[] = [];
  let totalGroupChars = 0;
  for (const g of store.listGroupKnowledgeReposForUser(avatarId)) {
    if (disabled?.has(g.groupId)) {
      continue;
    }
    // Bound the TOTAL, not just entry: the old `>= CAP` check ran BEFORE the read,
    // so N groups each under GROUP_CLAUDE_MD_CAP could still sum past the total
    // (up to ~TOTAL-1 + GROUP_CAP). Truncate the tail entry to the remaining
    // budget so the injected group memory can never exceed TOTAL_GROUP_CLAUDE_MD_CAP.
    const remaining = TOTAL_GROUP_CLAUDE_MD_CAP - totalGroupChars;
    if (remaining <= 0) {
      break;
    }
    const content = await readRepoClaudeMd(groupKnowledgeClonePath(g.groupId, config), GROUP_CLAUDE_MD_CAP);
    if (content) {
      const bounded = content.length > remaining ? content.slice(0, remaining) : content;
      groups.push({ name: g.groupName, content: bounded });
      totalGroupChars += bounded.length;
    }
  }
  return { personal, groups };
}

/** Like `loadGroupKnowledgeRepoRoots` but returns `{path, source}` for the skills/intro paths. */
export async function groupKnowledgeRepoSkillSources(
  contexts: GroupKnowledgeRepoContext[],
): Promise<{ path: string; source: string }[]> {
  return resolveKnowledgeRepoSources(groupKnowledgeRepoJobs(contexts));
}

/**
 * Plugin roots for a GROUP-AGENT run: the bundled defaults + ONLY the owning
 * group's shared repo, cloned with the ACTING member's tokens (groups own no
 * credentials). Deliberately no personal plugins, no personal knowledge repo,
 * no other groups — the shared agent's capability boundary is group resources.
 */
export async function loadGroupAgentPluginRoots(
  store: Store,
  groupId: string,
  actingUserId: string,
  config: AppConfig,
  onWarn?: (message: string) => void,
): Promise<PluginRoot[]> {
  if (config.agentRuntime === "local") {
    return [];
  }
  const ctx = groupKnowledgeRepoContextFor(
    store,
    groupId,
    actingUserId,
    config,
    store.getGroup(groupId)?.name,
  );
  return [
    ...(await loadDefaultPluginRoots(config, onWarn)),
    ...(await loadGroupKnowledgeRepoRoots(ctx ? [ctx] : [], onWarn)),
  ];
}

/** Standing CLAUDE.md memory for a GROUP-AGENT run: the owning group's only. */
export async function loadGroupAgentKnowledgeMemory(
  store: Store,
  groupId: string,
  config: AppConfig,
): Promise<KnowledgeRepoMemory> {
  if (config.agentRuntime === "local") {
    return { personal: null, groups: [] };
  }
  const group = store.getGroup(groupId);
  if (!group?.knowledgeRepo) {
    return { personal: null, groups: [] };
  }
  const content = await readRepoClaudeMd(
    groupKnowledgeClonePath(groupId, config),
    GROUP_CLAUDE_MD_CAP,
  );
  return { personal: null, groups: content ? [{ name: group.name, content }] : [] };
}

/**
 * Clone each enabled plugin for an avatar into
 * `${dataDir}/plugins/${userId}/${sanitize(repo)}` and return local plugin
 * roots for the SDK. A repo may be a single plugin or a marketplace of many.
 * Clone/resolve failures are tolerated: the plugin is skipped with a warning,
 * never crashing the chat.
 */
export async function loadAvatarPluginRoots(
  userId: string,
  plugins: Plugin[],
  config: AppConfig,
  onWarn?: (message: string) => void,
  // The avatar owner's internal/external git tokens, selected per repo host.
  userTokens?: string | null | GitTokenSet,
  opts?: {
    autoRefreshIntervalMs?: number;
    onSynced?: (plugin: Plugin) => void;
  },
): Promise<PluginRoot[]> {
  const roots: PluginRoot[] = [];
  for (const plugin of plugins) {
    const destination = pluginClonePath(userId, plugin.repo, config);
    const forceRefresh = isPluginRefreshDue(
      plugin,
      opts?.autoRefreshIntervalMs ?? config.pluginAutoRefreshIntervalMs,
    );
    try {
      const sync = await syncPluginRepoWithStatus(
        userId,
        plugin,
        config,
        forceRefresh,
        userTokens,
      );
      if (sync.synced) {
        opts?.onSynced?.(plugin);
        logger.debug(
          { repo: plugin.repo, destination },
          forceRefresh ? "plugin repo auto-refreshed" : "plugin repo cloned",
        );
      }
    } catch (error) {
      // A refresh/clone failure is non-fatal if we already have a cached clone.
      // Scrub the error: the git auth header (token) is embedded in its argv.
      const detail = scrubGitError(error);
      if (!(await pathExists(destination))) {
        onWarn?.(`${plugin.repo}: 복제 실패 (${detail})`);
        logger.warn({ repo: plugin.repo, detail }, "plugin clone failed");
        continue;
      }
      onWarn?.(`${plugin.repo}: 새로고침 실패, 캐시된 복제본 사용`);
      logger.warn({ repo: plugin.repo, detail }, "plugin refresh failed, using cache");
    }

    if (!(await pathExists(destination))) {
      onWarn?.(`${plugin.repo}: 복제 후 플러그인 경로를 찾을 수 없습니다`);
      continue;
    }
    for (const root of await resolvePluginRoots(destination, plugin.repo, onWarn, plugin.selected)) {
      roots.push({ type: "local", path: root });
    }
  }
  return roots;
}

interface PluginSyncOutcome {
  path: string;
  synced: boolean;
}

/**
 * Ensure a single plugin repo is cloned/up-to-date on disk and return its path.
 * `force` re-fetches even if the process already synced it this run (used by the
 * refresh endpoint); otherwise it respects the clone-once cache.
 */
export async function syncPluginRepoWithStatus(
  userId: string,
  plugin: Pick<Plugin, "repo" | "ref">,
  config: AppConfig,
  force = false,
  userTokens?: string | null | GitTokenSet,
): Promise<PluginSyncOutcome> {
  const destination = pluginClonePath(userId, plugin.repo, config);
  if (force) {
    forgetClone(destination);
  }
  const needsSync = force || !clonedPaths.has(destination);
  const existing = syncingPaths.get(destination);
  if (!needsSync) {
    if (existing) {
      await existing;
    }
    return { path: destination, synced: false };
  }

  let sync = existing;
  if (!sync) {
    const url = marketplaceCloneUrl(plugin.repo, config.githubHost);
    const token = tokenForGitUrl(url, config, userTokens);
    sync = syncGitRepo(url, destination, plugin.ref ?? undefined, token).then(() => {
      clonedPaths.add(destination);
    });
    syncingPaths.set(destination, sync);
    const clearInFlight = () => {
      if (syncingPaths.get(destination) === sync) {
        syncingPaths.delete(destination);
      }
    };
    sync.then(clearInFlight, clearInFlight);
  }
  await sync;
  return { path: destination, synced: true };
}

export async function syncPluginRepo(
  userId: string,
  plugin: Pick<Plugin, "repo" | "ref">,
  config: AppConfig,
  force = false,
  userTokens?: string | null | GitTokenSet,
): Promise<string> {
  const result = await syncPluginRepoWithStatus(userId, plugin, config, force, userTokens);
  return result.path;
}
