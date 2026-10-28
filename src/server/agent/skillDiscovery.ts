// Global skill discovery for the admin tool/skill policy (#toolSkillPolicy).
//
// The CLI is the only authority on which skills exist (built-in plugin skills
// are embedded in its binary), so we enumerate them the way oh-my-gateway
// does: start ONE preflight SDK session that never sends a user turn, read
// `supportedCommands()` from its initialize data, and cache the result in
// app_config keyed by the bundled CLI version. Per-avatar plugin skills are
// NOT part of that cache — they are enumerated per run by scanning the run's
// plugin roots (`listPluginRootSkills`), because roots differ per avatar.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import logger from "../logger.js";
import type { AppConfig } from "../types.js";
import { GIT_CREDENTIAL_ENV_NAMES, scrubServerOnlySecretEnv } from "../secretPolicy.js";
import type { Store } from "../store.js";
import type {
  DiscoveredSkill,
  SkillDiscoveryCache,
  ToolSkillPolicy,
} from "../toolSkillPolicy.js";

const agentLogger = logger.child({ module: "agent" });

/** Preflight hard cap: a hung CLI must not wedge the admin panel. */
const PREFLIGHT_TIMEOUT_MS = 30_000;

/** Race marker for that cap — see the deadline in runSkillPreflight. */
const TIMED_OUT = Symbol("preflight deadline");

/**
 * The preflight CLI's env: like a run's (agentSubprocessEnv in runPlan, not
 * imported here — runPlan imports this module), no git credentials and no
 * server-only secrets (#71).
 */
function discoveryEnv(agentSessionsDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of GIT_CREDENTIAL_ENV_NAMES) {
    delete env[name];
  }
  scrubServerOnlySecretEnv(env);
  return { ...env, CLAUDE_CONFIG_DIR: agentSessionsDir };
}

/**
 * Version of the Claude Code CLI bundled in the installed SDK (the discovery
 * cache key: skills are embedded in the CLI binary, so the set can only change
 * when this changes). Walks up from the resolved SDK entry to its package.json
 * because the package's `exports` map does not expose "./package.json".
 */
export function bundledCliVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    let dir = path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
    for (let depth = 0; depth < 5; depth += 1) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
          claudeCodeVersion?: string;
        };
        if (pkg.name === "@anthropic-ai/claude-agent-sdk") {
          return pkg.claudeCodeVersion || pkg.version || "unknown";
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch (error) {
    agentLogger.warn({ err: error }, "bundled CLI version resolution failed");
  }
  return "unknown";
}

/**
 * The stored discovery cache, but ONLY when it matches the currently bundled
 * CLI version — after an SDK upgrade the stale list might omit newly added
 * built-in skills, and an allowlist computed from it would hide them.
 */
export function freshSkillDiscoveryCache(store: Store): SkillDiscoveryCache | null {
  const cache = store.getSkillDiscoveryCache();
  if (!cache) {
    return null;
  }
  return cache.cliVersion === bundledCliVersion() ? cache : null;
}

/** Single-flight guard: concurrent admin requests share one preflight. */
let inflightDiscovery: Promise<SkillDiscoveryCache> | null = null;

/**
 * Return the global skill list (CLI built-ins + app default-skills), running
 * the preflight and refreshing the cache when it is missing or stale.
 * Rejections propagate — callers decide the fallback (the admin route reports
 * the failure; agent runs never call this, they use the cache or "all").
 */
export async function discoverGlobalSkills(
  store: Store,
  config: AppConfig,
): Promise<SkillDiscoveryCache> {
  const fresh = freshSkillDiscoveryCache(store);
  if (fresh) {
    return fresh;
  }
  if (!inflightDiscovery) {
    inflightDiscovery = runSkillPreflight(config)
      .then((skills) => {
        const cache: SkillDiscoveryCache = {
          cliVersion: bundledCliVersion(),
          fetchedAt: new Date().toISOString(),
          skills,
        };
        store.setSkillDiscoveryCache(cache);
        agentLogger.info(
          { cliVersion: cache.cliVersion, skillCount: skills.length },
          "skill discovery preflight completed",
        );
        return cache;
      })
      .finally(() => {
        inflightDiscovery = null;
      });
  }
  return inflightDiscovery;
}

/**
 * One SDK session in streaming-input mode whose input generator stays pending
 * until aborted: the CLI initializes (discovers plugins + skills, opens the
 * control channel) but no user turn is ever sent, so no model/API call is
 * made and no auth is required. `supportedCommands()` answers from that
 * initialize data. Scope is GLOBAL on purpose: only the app default-skills
 * root is mounted; avatar plugin roots are per-run (listPluginRootSkills).
 * The env is a plain copy (not agentSubprocessEnv, which lives in
 * claudeAgent.ts and would import-cycle) — acceptable because this session
 * runs zero turns and zero tools.
 */
async function runSkillPreflight(config: AppConfig): Promise<DiscoveredSkill[]> {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query: (input: unknown) => AsyncIterable<unknown> & {
      supportedCommands?: () => Promise<Array<{ name?: unknown; description?: unknown }>>;
    };
  };
  const abort = new AbortController();
  const idleInput = (async function* (): AsyncGenerator<never> {
    await new Promise<void>((resolve) => {
      abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  })();
  fs.mkdirSync(config.agentSessionsDir, { recursive: true });
  const query = sdk.query({
    prompt: idleInput,
    options: {
      plugins: [{ type: "local", path: config.defaultPluginsDir }],
      skills: "all",
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 1,
      abortController: abort,
      cwd: config.dataDir,
      env: discoveryEnv(config.agentSessionsDir),
    },
  });
  // ONE deadline for the WHOLE preflight — enumeration AND the post-abort
  // drain. Aborting alone bounds nothing: a CLI is free to ignore the abort and
  // leave supportedCommands() pending or its message stream open forever, and
  // the admin route awaits this inline. Resolving (never rejecting) keeps the
  // loser of every race below observed.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timeout = setTimeout(() => {
      abort.abort();
      resolve(TIMED_OUT);
    }, PREFLIGHT_TIMEOUT_MS);
  });
  try {
    if (typeof query.supportedCommands !== "function") {
      throw new Error("SDK query() has no supportedCommands()");
    }
    const commands = await Promise.race([query.supportedCommands(), expired]);
    if (commands === TIMED_OUT) {
      throw new Error(`skill discovery preflight timed out after ${PREFLIGHT_TIMEOUT_MS}ms`);
    }
    return commands
      .filter(
        (command): command is { name: string; description?: unknown } =>
          typeof command?.name === "string" && command.name.length > 0,
      )
      .map((command) => ({
        name: command.name,
        description:
          typeof command.description === "string" ? command.description : "",
      }));
  } finally {
    abort.abort();
    // Drain so the CLI subprocess is reaped before we return. Best effort: the
    // skills are already enumerated, so a drain that throws (the aborted
    // session usually ends with an abort error) or never ends must not lose
    // them. The catch sits on the drain itself, not on the race, so a drain
    // rejecting AFTER it lost to the deadline still has a handler.
    const drained = (async () => {
      for await (const _message of query) {
        void _message;
      }
    })().catch(() => {});
    await Promise.race([drained, expired]);
    // Last, not first: the deadline stays armed across the drain.
    clearTimeout(timeout);
  }
}

/** Cap for SKILL.md reads — frontmatter sits at the top of the file. */
const SKILL_MD_READ_BYTES = 4096;

/** Read a SKILL.md's frontmatter name/description (capped, tolerant). Also
 *  used by skillTransfer.ts to snapshot share metadata. */
export function skillMdMeta(filePath: string): { name?: string; description?: string } {
  let head: string;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(SKILL_MD_READ_BYTES);
      const read = fs.readSync(fd, buf, 0, SKILL_MD_READ_BYTES, 0);
      head = buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
  if (!head.startsWith("---")) {
    return {};
  }
  const end = head.indexOf("\n---", 3);
  const frontmatter = end >= 0 ? head.slice(0, end) : head;
  const pick = (key: "name" | "description"): string | undefined => {
    const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match ? match[1].trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { name: pick("name"), description: pick("description") };
}

/**
 * Enumerate skills shipped by a run's plugin roots — `<root>/skills/<dir>/SKILL.md`,
 * the layout default-skills, owner plugins, and knowledge-repo scaffolds all
 * use. Name comes from SKILL.md frontmatter, falling back to the directory
 * name (the CLI accepts either). Unreadable roots are skipped: this feeds an
 * ALLOWLIST, so over-inclusion is harmless while omission hides a skill.
 */
export function listPluginRootSkills(rootPaths: string[]): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  const seen = new Set<string>();
  for (const root of rootPaths) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, "skills"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const mdPath = path.join(root, "skills", entry.name, "SKILL.md");
      if (!fs.existsSync(mdPath)) {
        continue;
      }
      const meta = skillMdMeta(mdPath);
      const name = meta.name || entry.name;
      if (!seen.has(name)) {
        seen.add(name);
        out.push({ name, description: meta.description ?? "" });
      }
    }
  }
  return out;
}

/** `plugin:skill` → `skill`; bare names pass through. */
function bareSkillName(name: string): string {
  const idx = name.lastIndexOf(":");
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * The `options.skills` value for one agent run.
 *
 * - No skills disabled → `"all"`: byte-identical to the pre-feature behavior.
 * - Discovery cache missing/stale for this CLI version → `"all"` as well:
 *   visibility is FAIL-OPEN (an avatar's skills must never vanish because a
 *   preflight failed or the SDK was upgraded), while execution stays
 *   FAIL-CLOSED — the PreToolUse hook denies disabled skills regardless.
 * - Otherwise → allowlist = (global discovered ∪ this run's plugin-root
 *   skills) − disabled. A disabled bare name also removes plugin-qualified
 *   `plugin:name` entries. Non-skill command names that ride along from
 *   `supportedCommands()` are inert in the allowlist (their `Skill(name)`
 *   allow rules match no skill), so over-inclusion is safe.
 */
export function computeSkillsOption(
  policy: ToolSkillPolicy,
  cache: SkillDiscoveryCache | null,
  pluginRootPaths: string[],
): "all" | string[] {
  if (policy.disabledSkills.length === 0) {
    return "all";
  }
  if (!cache) {
    return "all";
  }
  const names = new Set(cache.skills.map((skill) => skill.name));
  for (const skill of listPluginRootSkills(pluginRootPaths)) {
    names.add(skill.name);
  }
  const disabled = new Set(policy.disabledSkills);
  return Array.from(names)
    .filter((name) => !disabled.has(name) && !disabled.has(bareSkillName(name)))
    .sort();
}
