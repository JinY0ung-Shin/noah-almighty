#!/usr/bin/env node
/**
 * Register Noah's HTTP MCP servers with a pi-gateway instance's MCP broker, and
 * (optionally) apply Noah's instance settings there. Idempotent: re-running it
 * changes nothing that is already right. docs/architecture/pi-runtime.md.
 *
 *   PI_GATEWAY_ADMIN_KEY=… node scripts/pi-register-mcp.mjs \
 *     --gateway http://127.0.0.1:18080 --noah-url http://10.213.0.1:48787 [--configure-instance] [--dry-run]
 *   node scripts/pi-register-mcp.mjs --remove …     # delete the entries this Noah owns
 *
 * Options (each also read from the env named in brackets):
 *   --gateway URL     pi-gateway origin [PI_GATEWAY_URL]
 *   --noah-url URL    the base the BROKER uses to reach this Noah [NOAH_MCP_PUBLIC_URL]
 *   --timeout-sec N   broker per-call timeout for EVERY server, overriding the per-server
 *                     defaults below (1..600, pi's cap)
 *   --configure-instance
 *                     also disable pi's request_admin / present_file built-ins and deploy
 *                     scripts/pi-system-prompt.md as the live system prompt (name "noah")
 *   --force           take over a broker id that points at a different URL
 *   --dry-run         print what would change, change nothing
 *   --remove          delete every broker entry that points at THIS Noah
 *
 * The admin key is read from PI_GATEWAY_ADMIN_KEY only (never an argument, so it
 * stays out of shell history and `ps`); Noah never stores it.
 *
 * Broker ids ARE Noah's server names (`repo`, `system`, `git_repo`, …), so pi's
 * `mcp__<id>__<tool>` names equal the names Noah's prompts and skills use; the
 * last three ids are servers Noah RELAYS as an MCP client (`hex-ssh`, and the
 * `plugins` / `shared` aggregates). Each entry forwards the run token:
 * `Authorization: Bearer {{ctx.header:x-noah-run-token}}`, and a noun-only `description` (SERVER_DESCRIPTIONS)
 * that pi's mcp_search lists and matches.
 *
 * Timeouts: 120 s unless a server's own work takes longer (SERVER_TIMEOUT_SEC).
 * The two tools that used to hold a call for minutes no longer do on pi (design
 * D8): a canvas never waits for the user, and ask_avatar in a chat returns at
 * once (its answer arrives as a follow-up turn). Browser ops are bounded by the
 * bridge's own ~45 s relay timeout, well inside 120 s.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Mirror of PI_MCP_SERVER_NAMES (src/server/agent/pi/mcpCatalog.ts); tests/pi-runner.test.ts keeps them equal. */
export const NOAH_MCP_SERVER_NAMES = [
  "knowledge",
  "repo",
  "system",
  "todo",
  "confluence",
  "web",
  "avatars",
  "skill_exchange",
  "ssh_identity",
  "git_repo",
  "group_repo",
  "brain",
  "group_brain",
  "canvas",
  "browser",
  "file_output",
  "ssh_trust",
  "skills",
  "hex-ssh",
  "plugins",
  "shared",
];

/**
 * The broker entry's `description` per id: what the service IS, in NOUNS only. pi shows its first line in
 * `mcp_search`'s always-visible "Connected services" list AND appends it to the search text of EVERY tool of
 * that server — so a verb here would match every tool of the server and push the right one down (measured:
 * a verb list cost held-out recall, nouns kept it and raised rank 1; usability report §6.5, 2026-10-29).
 * Keep each under pi's 1000-character cap.
 */
export const SERVER_DESCRIPTIONS = {
  knowledge: "Questions relayed to the owner.",
  repo: "Personal knowledge repository (git) of notes, skills and the second-brain wiki.",
  system: "Noah itself: current capabilities and settings, the product manual, routines (scheduled tasks), notifications, plugins, conversations.",
  todo: "Persistent to-do list (할 일) of tasks.",
  confluence: "Confluence wiki pages and attachments.",
  web: "Web pages and URLs fetched by the server.",
  avatars: "Colleagues' avatars.",
  skill_exchange: "Skill sharing between teammates' avatars.",
  ssh_identity: "The owner's SSH key pair.",
  git_repo: "General git code repositories (GitHub projects) of the owner.",
  group_repo: "Group (team) shared knowledge repository.",
  brain: "Second brain: the owner's curated wiki notes, memory of past decisions, people and projects.",
  group_brain: "Team brain: a group's shared wiki notes.",
  canvas: "Visual canvas side panel: diagrams, mockups, charts, HTML previews.",
  browser: "The user's own web browser (Chrome extension): pages, tabs, forms.",
  file_output: "Files for the user: images in the chat, download cards, share links.",
  ssh_trust: "Trusted SSH host keys (known_hosts).",
  skills: "The avatar owner's skills (SKILL.md instructions) for a colleague's run.",
  "hex-ssh": "Remote servers over SSH: shell commands and remote files.",
  plugins: "MCP servers of the owner's installed plugins.",
  shared: "Admin-registered shared MCP servers (공용 MCP).",
};

const DEFAULT_TIMEOUT_SEC = 120;
/** Per-server broker timeouts (s) where the server's own work can outlast the default. */
export const SERVER_TIMEOUT_SEC = {
  // ask_avatar in an UNATTENDED run (routine, API task) still waits for the consultation (3 min budget).
  avatars: 240,
  // clone / sync / push of a large repository (git clone budget 180 s) plus the sandbox copy.
  repo: 300,
  git_repo: 300,
  group_repo: 300,
  // share_file renders deck previews Noah-side (LibreOffice + pdftoppm, 120 s per stage).
  file_output: 240,
  // relayed servers: a remote command over SSH, third-party tools of unknown duration.
  "hex-ssh": 600,
  plugins: 300,
  shared: 300,
};

/** The broker timeout one server gets (`override` = --timeout-sec). */
export function timeoutFor(name, override) {
  return override ?? SERVER_TIMEOUT_SEC[name] ?? DEFAULT_TIMEOUT_SEC;
}

const BROKER_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const RUN_TOKEN_HEADER = "x-noah-run-token";
const PROMPT_NAME = "noah";
/** pi built-ins Noah replaces with its own tools (admin requests, file publishing). */
const DISABLED_BUILTINS = ["request_admin", "present_file"];

function parseArgs(argv) {
  const opts = { force: false, dryRun: false, remove: false, configure: false, timeoutSec: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--gateway") opts.gateway = value();
    else if (arg === "--noah-url") opts.noahUrl = value();
    else if (arg === "--timeout-sec") opts.timeoutSec = Number(value());
    else if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--remove") opts.remove = true;
    else if (arg === "--configure-instance") opts.configure = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  opts.gateway ??= process.env.PI_GATEWAY_URL;
  opts.noahUrl ??= process.env.NOAH_MCP_PUBLIC_URL;
  return opts;
}

/** The broker config for one Noah server (what --apply converges to). */
export function brokerEntry(name, noahUrl, timeoutSec) {
  return {
    runIn: "broker",
    displayName: `Noah ${name}`,
    ...(SERVER_DESCRIPTIONS[name] ? { description: SERVER_DESCRIPTIONS[name] } : {}),
    transport: {
      type: "http",
      url: `${noahUrl.replace(/\/+$/, "")}/mcp/${name}`,
      headers: { Authorization: `Bearer {{ctx.header:${RUN_TOKEN_HEADER}}}` },
    },
    timeoutSec,
  };
}

function sameEntry(have, want) {
  return (
    have?.transport?.url === want.transport.url &&
    have?.transport?.headers?.Authorization === want.transport.headers.Authorization &&
    have?.timeoutSec === want.timeoutSec &&
    (have?.description ?? "") === (want.description ?? "") &&
    have?.enabled !== false
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2).join("\n").split("\n */")[0]);
    return;
  }
  const adminKey = process.env.PI_GATEWAY_ADMIN_KEY?.trim();
  if (!opts.gateway || !adminKey) throw new Error("need --gateway (or PI_GATEWAY_URL) and PI_GATEWAY_ADMIN_KEY in the environment");
  if (!opts.noahUrl) throw new Error("need --noah-url (or NOAH_MCP_PUBLIC_URL): the base pi's broker uses to reach this Noah");
  if (opts.timeoutSec !== undefined && (!Number.isInteger(opts.timeoutSec) || opts.timeoutSec < 1 || opts.timeoutSec > 600)) {
    throw new Error("--timeout-sec must be an integer 1..600");
  }
  const base = `${opts.gateway.replace(/\/+$/, "")}/admin/api`;
  const admin = async (method, route, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      // Fastify refuses an empty body under a JSON content-type.
      ...(body === undefined && method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  };
  const act = async (label, fn) => {
    if (opts.dryRun) {
      console.log(`would ${label}`);
      return;
    }
    await fn();
    console.log(label);
  };

  const listed = await admin("GET", "/mcp/servers");
  const existing = new Map((listed.servers ?? []).map((s) => [s.config?.id, s.config]));
  const ours = (config, name) => config?.transport?.url === brokerEntry(name, opts.noahUrl, timeoutFor(name, opts.timeoutSec)).transport.url;

  for (const name of NOAH_MCP_SERVER_NAMES) {
    if (!BROKER_ID.test(name)) throw new Error(`server name ${name} is not a valid pi broker id`);
    const have = existing.get(name);
    if (opts.remove) {
      if (have && ours(have, name)) await act(`DELETE ${name}`, () => admin("DELETE", `/mcp/servers/${name}`));
      else console.log(`skip ${name}: ${have ? `not ours (${have.transport?.url ?? "?"})` : "absent"}`);
      continue;
    }
    const want = brokerEntry(name, opts.noahUrl, timeoutFor(name, opts.timeoutSec));
    if (have && sameEntry(have, want)) {
      console.log(`ok ${name} (unchanged)`);
      continue;
    }
    if (have && !ours(have, name) && !opts.force) {
      console.log(`skip ${name}: id already registered → ${have.transport?.url ?? "?"} (--force to take it over)`);
      continue;
    }
    await act(`PUT ${name} → ${want.transport.url}`, () => admin("PUT", `/mcp/servers/${name}`, { config: want }));
  }

  if (!opts.configure || opts.remove) return;

  const tools = await admin("GET", "/tools");
  for (const name of DISABLED_BUILTINS) {
    const tool = (tools.tools ?? []).find((t) => t.name === name);
    if (!tool) console.log(`skip tool ${name}: not on this instance`);
    else if (!tool.enabled) console.log(`ok tool ${name} (disabled)`);
    else await act(`disable tool ${name}`, () => admin("POST", `/tools/${name}/disable`));
  }

  const content = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "pi-system-prompt.md"), "utf8");
  const prompts = await admin("GET", "/prompts");
  const summary = (Array.isArray(prompts) ? prompts : (prompts.prompts ?? [])).find((p) => p.name === PROMPT_NAME);
  let version;
  if (!summary) {
    await act(`create prompt ${PROMPT_NAME}`, () =>
      admin("POST", "/prompts", { name: PROMPT_NAME, description: "Noah Almighty avatars (scripts/pi-system-prompt.md)", content, message: "Noah prompt" }),
    );
    version = 1;
  } else {
    const detail = await admin("GET", `/prompts/${PROMPT_NAME}`);
    const latest = [...(detail.versions ?? [])].sort((a, b) => b.version - a.version)[0];
    if (latest && latest.content === content) {
      version = latest.version;
    } else {
      version = (latest?.version ?? 0) + 1;
      await act(`add prompt ${PROMPT_NAME} version ${version}`, () =>
        admin("POST", `/prompts/${PROMPT_NAME}/versions`, { content, message: "Noah prompt update" }),
      );
    }
    if (detail.liveVersion === version) {
      console.log(`ok prompt ${PROMPT_NAME} v${version} (live)`);
      return;
    }
  }
  await act(`deploy prompt ${PROMPT_NAME} v${version}`, () =>
    admin("POST", `/prompts/${PROMPT_NAME}/deploy`, { version, note: "scripts/pi-register-mcp.mjs" }),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`pi-register-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
