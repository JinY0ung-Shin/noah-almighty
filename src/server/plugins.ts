import fs from "node:fs/promises";
import path from "node:path";
import { marketplaceCloneUrl, pathExists, sanitizeName, scrubGitError, syncGitRepo } from "./marketplace.js";
import { assertAllowedGitSource, gitSourceRefusalKorean, GitSourceRefusedError } from "./gitSourcePolicy.js";
import { tokenForGitUrl, type GitTokenSet } from "./gitCredentials.js";
import {
  ensureClone,
  knowledgeClonePath,
  knowledgeRepoContextFor,
  type KnowledgeRepoContext,
} from "./knowledgeRepo.js";
import logger from "./logger.js";
import { memoryVaultFor, type MemoryVault } from "./personalVault.js";
import { readRegularFileAsync } from "./chatImages.js";
import { mcpHttpBridgeServerDef, type McpHttpBridgeConfig } from "./sharedMcpServers.js";
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
  const manifest = await readJson<{ name?: string }>(dir, path.join(dir, ".claude-plugin", "plugin.json"));
  return typeof manifest?.name === "string" ? manifest.name : null;
}

/** Cap on any one text file Noah reads out of a cloned repo (manifests, SKILL.md, CLAUDE.md). */
const REPO_TEXT_MAX_BYTES = 1024 * 1024;

/**
 * Text of `file`, which must be a REGULAR file reached from `root` through NO
 * link — else null. Every file Noah reads out of a cloned repo goes through
 * here: the content is user-pushed, and git checks a committed symlink out as a
 * real link, so a plain `readFile` would follow `CLAUDE.md -> /run/secrets/…`
 * or `.mcp.json -> ../<another user>/.mcp.json` straight out of the clone (into
 * the frozen prompt, a relayed MCP definition, the skill index). The opened
 * descriptor must resolve to exactly `<realpath(root)>/<rel>` (`fdPathIs`), so a
 * link at ANY component below `root` fails, and the final one is O_NOFOLLOW.
 * `root` itself is trusted: callers pass a clone / plugin root Noah resolved
 * (marketplace sources are contained by `containedPluginDir`).
 */
async function readTextBelow(root: string, file: string, maxBytes: number = REPO_TEXT_MAX_BYTES): Promise<string | null> {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return null;
  }
  const read = await readRegularFileAsync(path.join(realRoot, rel), maxBytes);
  return "buffer" in read ? read.buffer.toString("utf8") : null;
}

async function readJson<T>(root: string, file: string): Promise<T | null> {
  const raw = await readTextBelow(root, file);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * MCP servers the APP relays itself (`agent/pi/mcpProxies.ts`), per-user-configured —
 * e.g. `hex-ssh`, which we inject with the owner's SSH key. A plugin's bundled
 * `.mcp.json` may declare a server of the SAME name but WITHOUT the per-user
 * env (the public ops plugin ships a keyless `hex-ssh`). Since MCP config is
 * keyed by server name, the two collide and only one survives — and the
 * plugin's keyless copy can shadow ours, so the avatar gets a server with no
 * key. We strip these names from each plugin `.mcp.json` before the root's
 * servers are relayed, leaving the app's keyed registration as the sole definition.
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
  // readJson refuses a linked .mcp.json, so the write below never goes through a link.
  const config = await readJson<Record<string, unknown>>(rootDir, file);
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
 * loose on purpose — the relayed server validates the rest; we only look at the
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
  const config = await readJson<Record<string, unknown>>(rootDir, path.join(rootDir, ".mcp.json"));
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
 * subdirs). The app's default plugin roots are NOT owned: secrets must never
 * flow into an MCP server the app repo defined. Used by the secret-injection lift below.
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

/** The `.mcp.json` env reference forms (Claude Code plugin convention): `${VAR}` and `${VAR:-default}`. */
const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Env names an http/sse def's url + string header values reference. */
function httpDefEnvRefs(def: PluginMcpServerDef): string[] {
  const names = new Set<string>();
  const scan = (value: unknown) => {
    if (typeof value !== "string") return;
    for (const match of value.matchAll(ENV_REF_RE)) names.add(match[1]);
  };
  scan(def.url);
  if (def.headers && typeof def.headers === "object") {
    Object.values(def.headers as Record<string, unknown>).forEach(scan);
  }
  return [...names];
}

/** Rewrite the url + string header values of an http/sse def through `fn`. */
function mapHttpDefStrings(def: PluginMcpServerDef, fn: (value: string) => string): void {
  if (typeof def.url === "string") {
    def.url = fn(def.url);
  }
  if (def.headers && typeof def.headers === "object" && !Array.isArray(def.headers)) {
    const headers: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(def.headers as Record<string, unknown>)) {
      headers[name] = typeof value === "string" ? fn(value) : value;
    }
    def.headers = headers;
  }
}

/**
 * Lift the MCP servers defined by the given plugin roots' `.mcp.json` files
 * into one name → definition map, for the pi run's `plugins` relay
 * (`agent/pi/mcpProxies.ts`), which decides per definition whether it may run
 * and spawns or bridges it itself. Per root:
 *  - `${CLAUDE_PLUGIN_ROOT}` in string fields (command/args/env/url/…) is
 *    expanded to the root path. Other `${VAR}` forms are left for the relay
 *    (which refuses them outside the bundled roots).
 *  - FIRST definition of a name wins, matching the load order default →
 *    avatar plugins → knowledge repo.
 * No definition carries a secret value: nothing from the vault is resolved here.
 */
export async function liftPluginMcpServers(
  rootPaths: string[],
): Promise<{ servers: Record<string, PluginMcpServerDef> }> {
  const servers: Record<string, PluginMcpServerDef> = {};
  for (const rootPath of rootPaths) {
    const defs = await readPluginMcpServers(rootPath);
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
      servers[name] = def;
    }
  }
  return { servers };
}

/**
 * A marketplace entry's relative `source` resolved INSIDE the repo: the target
 * must lie below `repoRoot` and be reached through no link (its realpath is
 * exactly `<realpath(repoRoot)>/<rel>`), else null. Without this a pushed
 * `"source": "../../plugins/<victim>/<repo>"` (or a `plugins -> ../..` link)
 * made another user's clone a plugin root of this user's runs.
 */
async function containedPluginDir(repoRoot: string, source: string): Promise<string | null> {
  const abs = path.resolve(repoRoot, source);
  const rel = path.relative(path.resolve(repoRoot), abs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  try {
    const realRoot = await fs.realpath(repoRoot);
    if ((await fs.realpath(abs)) !== path.join(realRoot, rel)) return null;
  } catch {
    return null;
  }
  return abs;
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
 * `resolvePluginRoots` (resolves plugin roots) and `inspectRepoContents` (reports
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
    repoRoot,
    path.join(repoRoot, ".claude-plugin", "marketplace.json"),
  );
  if (manifest && Array.isArray(manifest.plugins)) {
    const entries: EnumeratedPlugin[] = [];
    for (const entry of manifest.plugins) {
      const source = entry?.source;
      if (typeof source === "string" && source.startsWith(".")) {
        const abs = await containedPluginDir(repoRoot, source);
        if (!abs) {
          // `../` out of the repo, or a link on the way: never a plugin root (it
          // could name another user's clone — their skills, .mcp.json credentials).
          entries.push({ entry, dir: null, loadable: false });
          continue;
        }
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
async function readSkill(root: string, skillDir: string, source: string): Promise<SkillInfo | null> {
  const raw = await readTextBelow(root, path.join(skillDir, "SKILL.md"));
  if (raw === null) return null;
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
    const selfSkill = await readSkill(root.path, root.path, root.source);
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
      const skill = await readSkill(root.path, path.join(skillsDir, entry.name), root.source);
      if (skill && !byName.has(skill.name)) {
        byName.set(skill.name, skill);
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve a cloned repo into one or more plugin roots:
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
          // can't shadow the app's keyed registration. See agent/pi/mcpProxies.ts.
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
 * resolving plugin roots.
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
 * Every knowledge-repo skill source flows through the single resolver below.
 */
interface KnowledgeRepoJob {
  ensure: () => Promise<string>;
  source: string;
  selected: string[] | null;
}

/**
 * THE knowledge-repo resolver: clone each job's working tree and resolve it into
 * `{path, source}` skill-source entries. The two public functions below
 * (roots/sources) are thin views over this — they differ only in whether
 * failures warn (Korean) or stay silent.
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

/**
 * The full set of plugin roots an avatar's AGENT should load for a real turn:
 * the repo-bundled default plugins, the avatar's own enabled plugins, its
 * and its personal knowledge repo (group knowledge repos were retired 2026-10-30).
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
): Promise<PluginRoot[]> {
  if (config.agentRuntime === "local") {
    return [];
  }
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
  ];
}

/** Cap on the injected CLAUDE.md so standing memory can't bloat every turn. */
const PERSONAL_CLAUDE_MD_CAP = 6_000;

/** The avatar's standing CLAUDE.md memory (push, every turn). */
export interface KnowledgeRepoMemory {
  /** `CLAUDE.md` of the owner's personal vault (or the unavailable notice), or null when absent/empty. */
  personal: string | null;
}

/**
 * Load the avatar's standing CLAUDE.md memory. `CLAUDE.md` is a note of the
 * owner's personal vault, so it is read from the memory service — never from
 * the knowledge repository's clone (a `CLAUDE.md` file there is not the vault's
 * and is read by nobody). The brain rides the knowledge repository: without a
 * connected one there is no standing memory. A missing or empty note
 * contributes nothing; a service that cannot be used contributes the notice
 * below, never nothing. Unlike skills (pulled on demand), this is injected into
 * the prompt, so it is capped. (Group repo CLAUDE.md files were injected too
 * until group knowledge repos were retired 2026-10-30.)
 */
export async function loadKnowledgeRepoMemory(
  store: Store,
  avatarId: string,
  config: AppConfig,
  options: { vaultDeadlineMs?: number } = {},
): Promise<KnowledgeRepoMemory> {
  if (config.agentRuntime === "local") {
    return { personal: null };
  }
  if (!store.getKnowledgeRepo(avatarId).repo) {
    return { personal: null };
  }
  const personal = await readVaultClaudeMd(
    memoryVaultFor(store, config, avatarId),
    PERSONAL_CLAUDE_MD_CAP,
    options.vaultDeadlineMs ?? STANDING_MEMORY_VAULT_DEADLINE_MS,
  );
  return { personal };
}

/**
 * What stands in for the standing memory when it could not be LOADED (the
 * memory service was unavailable). It rides the same slot as CLAUDE.md, so
 * every caller — a chat turn, a routine, a consultation — passes it on
 * unchanged and the avatar reads it: a missing memory must never look like
 * "the owner has no standing guidance". The prompt it lands in is frozen per
 * conversation, so it also says how to get the real text later.
 */
export const STANDING_MEMORY_UNAVAILABLE_NOTICE =
  "(Noah's notice, not the owner's text.) The owner's standing guidance (CLAUDE.md) could NOT be loaded when this conversation started: it is a vault note kept in the memory service, and that service was unavailable. It is NOT empty and NOT missing — it simply is not shown here. Before relying on the owner's standing rules, read it yourself with `mcp__repo__read_file` (path `CLAUDE.md`) if that tool is available in this run; if it cannot be read either, tell the user that the owner's standing guidance could not be loaded because the memory service is unavailable.";

/**
 * How long a turn waits for the standing memory. The read is awaited at the start of EVERY turn (the prompt it feeds
 * is frozen after the first), so a service that hangs must not hold each turn
 * for the client's whole timeout: past this, the notice takes the memory's place.
 */
export const STANDING_MEMORY_VAULT_DEADLINE_MS = 3_000;

/**
 * The vault's `CLAUDE.md`, trimmed and capped (with a truncation mark); a
 * missing or empty note is null. A service that cannot be used — or does not
 * answer within `deadlineMs` — is NOT null: the notice above takes the
 * memory's place.
 */
async function readVaultClaudeMd(vault: MemoryVault, cap: number, deadlineMs: number): Promise<string | null> {
  let raw: string;
  let timer: NodeJS.Timeout | undefined;
  try {
    const reading = vault.read("CLAUDE.md");
    // The read itself is left to end on the client's own timeout; nothing waits for it.
    reading.catch(() => undefined);
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${deadlineMs} ms`)), deadlineMs);
      timer.unref?.();
    });
    raw = (await Promise.race([reading, late])).trim();
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") return null;
    logger.warn(
      { userId: vault.userId, err: error instanceof Error ? error.message : String(error) },
      "standing memory (CLAUDE.md) could not be read from the memory service; the run gets a notice instead",
    );
    return STANDING_MEMORY_UNAVAILABLE_NOTICE;
  } finally {
    clearTimeout(timer);
  }
  if (!raw) {
    return null;
  }
  return raw.length > cap ? `${raw.slice(0, cap)}\n…(truncated)` : raw;
}

/**
 * Clone each enabled plugin for an avatar into
 * `${dataDir}/plugins/${userId}/${sanitize(repo)}` and return local plugin
 * roots (on pi their skills are copied into the run's sandbox and their
 * `.mcp.json` servers relayed by Noah). A repo may be a single plugin or a
 * marketplace of many.
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
      // A refused SOURCE is not a failed refresh: its cached clone (made before
      // the policy existed) holds what the policy exists to keep out, so it is
      // never loaded.
      if (error instanceof GitSourceRefusedError) {
        onWarn?.(`${plugin.repo}: 불러오지 않았습니다 — ${gitSourceRefusalKorean(error)}`);
        logger.warn({ repo: plugin.repo, code: error.code }, "plugin source refused by the git source policy");
        continue;
      }
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
  const url = marketplaceCloneUrl(plugin.repo, config.githubHost);
  // Source policy on EVERY use (gitSourcePolicy.ts), before the clone-once cache
  // can answer: a plugin stored with a source the policy refuses — another
  // user's clone or the team-brain vault by path, a loopback host — throws
  // GitSourceRefusedError here, so its clone is never handed out, cached or not.
  await assertAllowedGitSource(url, config);
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
    const token = tokenForGitUrl(url, config, userTokens);
    // The network use: the host is resolved now, and the transfer carries what
    // the policy asks for (no redirects / pinned addresses off the configured host).
    sync = assertAllowedGitSource(url, config, { resolve: true })
      .then((source) => syncGitRepo(url, destination, plugin.ref ?? undefined, token, source.gitConfig))
      .then(() => {
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
