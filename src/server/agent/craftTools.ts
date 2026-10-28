/**
 * Craft apps (admin-only beta) — the agent side: run gating, the per-run
 * session lifecycle against the craft-runner, the in-process
 * `mcp__craft_files__stage` tool, and the tool-result tracker that publishes
 * previews, mirrors outputs and audits every Craft call.
 *
 * Shape of one run (runPlan.ts drives it, claudeAgent.ts closes it):
 *  1. `prepareCraftRun` (plan half): gate every app ({@link planCraftApps}); if
 *     any is usable, `open` the conversation's session, mirror the workspace
 *     inputs into `inbox/<sid>/`, `sync_in`, and refresh `craft/out/` from the
 *     outbox. The state it returns is what BOTH metacognition surfaces report.
 *  2. runPlan registers one stdio relay per active app (`craft-mcp-relay.mjs`
 *     on a one-shot 0600 handoff file) + `mcp__craft_files__stage`, then calls
 *     `session.grant()` LAST — a failed grant unregisters them again.
 *  3. The run loop feeds every SDK message to {@link createCraftToolTracker};
 *     each finished Craft call is audited (`craft_tool`, ids only), its images
 *     published through `events.onCraftPreview`, and the outbox mirrored into
 *     the workspace so `share_file` can deliver what the app saved.
 *  4. `session.release()` in the run's outer finally (every exit path):
 *     `revoke` the token (≤ 10 s — the only part on the response path), then
 *     one last output mirror OFF the response path (Addendum B N3); the next
 *     run of the same conversation waits for it before mirroring inputs.
 *
 * Every mirror INTO the workspace re-checks that the conversation still exists
 * (Addendum B N8): a run that outlives its conversation's deletion never
 * recreates `craft/out/` there — it skips, removes what raced in, and purges.
 *
 * The relay servers cannot self-gate per call (they are byte pipes), so
 * REGISTRATION plus the runner's per-run token are the gate — that is why the
 * gate is evaluated here, once, from live store/runner state.
 */
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AppConfig, CraftAppRunState, CraftRunState, CraftUnavailableReason, ImageMediaType } from "../types.js";
import type { Store } from "../store.js";
import type { AgentEvents } from "./events.js";
import { CRAFT_APPS, craftAppOfToolName, type CraftAppId } from "../../shared/craftApps.js";
import { DEFAULT_MCP_TOOL_GROUPS, normalizeMcpToolGroups, type McpToolGroupId } from "../../shared/mcpToolGroups.js";
import {
  CRAFT_RELEASE_TIMEOUT_MS,
  CRAFT_SYNC_TIMEOUT_MS,
  CraftRunnerError,
  cachedCraftRunnerHealth,
  craftBootRevokeSettled,
  craftControlRequest,
  craftExchangeOverBudget,
  craftExchangePaths,
  craftSessionId,
  newCraftRunToken,
  purgeCraftSessions,
  refreshCraftRunnerHealth,
  type CraftRunnerProbe,
} from "../craftRunner.js";
import {
  CRAFT_STAGED_DIR,
  CRAFT_WORKSPACE_OUT_DIR,
  clearCraftStaged,
  ensureCraftInbox,
  mirrorOutboxToWorkspace,
  mirrorWorkspaceToInbox,
  removeTreeNoFollow,
  stageWorkspaceFile,
} from "../craftExchange.js";
import { MAX_CHAT_FILE_BYTES } from "../chatFiles.js";
import { detectImageMediaType } from "../chatImages.js";
import { isRecord, asString } from "./agentUtils.js";
import { text } from "./mcpTools.js";
import logger from "../logger.js";

const craftLogger = logger.child({ module: "craft" });

export const CRAFT_FILES_SERVER_NAME = "craft_files";
export const CRAFT_FILES_TOOL_NAMES = ["mcp__craft_files__stage"] as const;

// ---------------------------------------------------------------------------
// Gate (pure)
// ---------------------------------------------------------------------------

export interface CraftGateInput {
  /** CRAFT_EXCHANGE_DIR + CRAFT_CONTROL_SECRET are set. */
  configured: boolean;
  /** The admin `craft_apps_enabled` switch. */
  toggleOn: boolean;
  /** The run's OWNER is a system admin (`store.isAdmin`). */
  ownerIsAdmin: boolean;
  /** An interactive turn of the owner's own avatar (not headless/API/group/consultation, viewer = owner, live sink). */
  interactiveOwnerRun: boolean;
  /** The run's model accepts images (render_preview returns image blocks). */
  visionEnabled: boolean;
  /** The run has a conversation scratch workspace to mirror. */
  hasWorkspace: boolean;
  /** The conversation's RAW composer selection (before the admin group policy). */
  selected: readonly McpToolGroupId[];
  /** The admin per-group tool policy (null = unrestricted). */
  policyAllowed: readonly McpToolGroupId[] | null;
  probe: CraftRunnerProbe;
}

/**
 * Every Craft app's availability for one run, from the facts above. Reasons in
 * gate order: deployment (configured, switch), owner (admin), run kind, model,
 * workspace, the admin group policy, what a reachable runner says about the app
 * (absent, failed), the conversation's selection, then reachability. Pure and unit-pinned: the relay
 * servers cannot self-gate, so these booleans ARE the gate.
 */
export function planCraftApps(input: CraftGateInput): CraftAppRunState[] {
  const healthApps = input.probe.state === "ok" ? input.probe.health.apps : [];
  return CRAFT_APPS.map((app) => {
    const health = healthApps.find((entry) => entry.id === app.id);
    const known = health
      ? {
          status: health.status,
          ...(health.version ? { version: health.version } : {}),
          tools: health.tools,
          ...(health.error ? { error: health.error } : {}),
        }
      : {};
    const reason: CraftUnavailableReason | null = !input.configured
      ? "not_configured"
      : !input.toggleOn
        ? "admin_disabled"
        : !input.ownerIsAdmin
          ? "not_admin"
          : !input.interactiveOwnerRun
            ? "run_kind"
            : !input.visionEnabled
              ? "no_vision"
              : !input.hasWorkspace
                ? "no_workspace"
                : input.policyAllowed && !input.policyAllowed.includes(app.toolGroupId)
                  ? "group_unavailable"
                  : // A runner known NOT to serve the app outranks the composer
                    // choice: "turn it on" would be advice that cannot work.
                    input.probe.state === "ok" && !health
                    ? "app_unavailable"
                    : health && health.status !== "ready"
                      ? "app_failed"
                      : !input.selected.includes(app.toolGroupId)
                        ? "group_off"
                        : input.probe.state !== "ok"
                          ? "runner_unreachable"
                          : null;
    return { id: app.id, labelEn: app.labelEn, active: reason === null, reason, ...known };
  });
}

/**
 * Whether every gate except the runner passes for at least one SELECTED app —
 * i.e. a live health probe is worth it. With a fake "serves everything" probe,
 * only the runner-independent gates can say no.
 */
function wantsRunner(input: Omit<CraftGateInput, "probe">): boolean {
  const servesAll: CraftRunnerProbe = {
    state: "ok",
    checkedAt: 0,
    health: {
      apps: CRAFT_APPS.map((app) => ({ id: app.id, version: "", status: "ready" as const, tools: 0 })),
      procs: { running: 0, max: 0 },
      sessions: 0,
    },
  };
  return planCraftApps({ ...input, probe: servesAll }).some((app) => app.active);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export interface CraftRunSession {
  sid: string;
  token: string;
  /** As the apps see it (`/exchange/work/<sid>/in`, …/out). */
  inDir: string;
  outDir: string;
  /** Noah-side folders. */
  inboxDir: string;
  outboxDir: string;
  workspaceDir: string;
  /** Activate the run token. False = the runner refused or is gone (or the conversation was deleted). */
  grant(): Promise<boolean>;
  /**
   * `revoke` (≤ {@link CRAFT_RELEASE_TIMEOUT_MS}); resolves once it settled.
   * The last output mirror then runs in the background (Addendum B N3) —
   * {@link craftFinalCollectSettled} awaits it. Never throws; idempotent.
   */
  release(): Promise<void>;
  /** `sync_out`, then mirror the outbox into `<workspace>/craft/out/`. Serialized; never throws. */
  collectOutputs(): Promise<void>;
  /** Copy one workspace file into `inbox/<sid>/staged/` and `sync_in`. */
  stage(roots: readonly string[], inputPath: string): Promise<{ runnerPath: string } | { error: string }>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The final output collect of each released run, per sid, while it is still
 * running (Addendum B N3: it runs after the turn returned). The next run of
 * the same conversation waits for it before mirroring its inputs, so
 * `in/craft-out/` carries the previous run's last results.
 */
const pendingFinalCollects = new Map<string, Promise<void>>();

/** Settles once the background final output collect of `sid`'s last released run has. */
export function craftFinalCollectSettled(sid: string): Promise<void> {
  return pendingFinalCollects.get(sid) ?? Promise.resolve();
}

const STORAGE_FULL_STAGE =
  "The craft-runner's shared storage is over its budget, so no file can be staged into the Craft session right now. Tell the user a system administrator must free Craft storage (deleting old Craft conversations frees theirs).";
const CONVERSATION_GONE_STAGE = "This conversation was deleted, so nothing can be staged into its Craft session.";

interface SessionContext {
  config: AppConfig;
  sid: string;
  conversationId: string;
  /** The run's Craft state — `storage` is updated in place (both surfaces read it). */
  state: CraftRunState;
  /** Whether the conversation still exists (undefined → no check: unit tests). */
  isConversationLive?: () => boolean;
}

function createSession(
  ctx: SessionContext,
  opened: { inDir: string; outDir: string },
  dirs: { inboxDir: string; outboxDir: string; workspaceDir: string },
): CraftRunSession {
  const { config, sid } = ctx;
  const token = newCraftRunToken();
  let granted = false;
  let released = false;
  let purged = false;
  let chain: Promise<void> = Promise.resolve();
  const live = () => !ctx.isConversationLive || ctx.isConversationLive();
  /**
   * The conversation was deleted while this run was going (Addendum B N8):
   * its copy sweep already ran, so purge the session again (idempotent — the
   * delete's own purge may have raced this run's open).
   */
  const purgeGone = () => {
    if (purged) return;
    purged = true;
    craftLogger.info({ sid }, "craft conversation deleted mid-run; skipping workspace mirrors and purging its session");
    purgeCraftSessions(config, [ctx.conversationId]);
  };
  const collect = async (syncOutMs: number | null): Promise<void> => {
    if (!live()) {
      purgeGone();
      return;
    }
    if (syncOutMs !== null) {
      try {
        await craftControlRequest(config, "sync_out", { sid }, syncOutMs);
      } catch (error) {
        // Still mirror what the outbox already holds (the runner syncs after every call).
        craftLogger.warn({ sid, error: errorText(error) }, "craft sync_out failed");
      }
    }
    if (!live()) {
      purgeGone();
      return;
    }
    const report = await mirrorOutboxToWorkspace(dirs.outboxDir, dirs.workspaceDir).catch(
      (error: unknown) => ({ rejected: [{ path: "out", reason: errorText(error) }] }),
    );
    if (!live()) {
      // Deleted DURING the mirror: what it wrote outlives the sweep — remove it.
      await removeTreeNoFollow(path.join(dirs.workspaceDir, path.dirname(CRAFT_WORKSPACE_OUT_DIR)));
      purgeGone();
      return;
    }
    ctx.state.storage.workspaceOutFull = report.rejected.some((entry) => entry.reason === "workspace_cap");
    if (report.rejected.length > 0) {
      craftLogger.warn({ sid, rejected: report.rejected.slice(0, 20) }, "craft outbox mirror rejected files");
    }
  };
  const enqueue = (syncOutMs: number | null): Promise<void> => {
    const next = () => collect(syncOutMs);
    chain = chain.then(next, next);
    return chain;
  };
  const session: CraftRunSession = {
    sid,
    token,
    ...opened,
    ...dirs,
    async grant() {
      if (!live()) {
        purgeGone();
        return false;
      }
      try {
        // Never race the boot revoke_all (it would kill this fresh token).
        await craftBootRevokeSettled();
        // The runner's grant waits on the session mutex and may first revoke
        // an older token (kill + final sync_out): the long budget, so a slow
        // grant is not mistaken for a refused one (release revokes either way).
        await craftControlRequest(config, "grant", { sid, token }, CRAFT_SYNC_TIMEOUT_MS);
        granted = true;
        return true;
      } catch (error) {
        craftLogger.warn({ sid, error: errorText(error) }, "craft grant failed");
        return false;
      }
    },
    async release() {
      if (released) return;
      released = true;
      // ALWAYS revoke the token this run generated — also when `grant`
      // errored or timed out: the runner may still have committed it, and a
      // live orphan would block that session's GC (Addendum A3). Revoking a
      // token the runner never saw is harmless.
      // Bounded (Addendum B N3): this is the one step on the response path.
      let revoked = false;
      try {
        await craftControlRequest(config, "revoke", { token }, CRAFT_RELEASE_TIMEOUT_MS);
        revoked = true;
      } catch (error) {
        // The runner's 12 h token expiry and Noah's boot revoke_all are the backstops.
        craftLogger.warn({ sid, granted, error: errorText(error) }, "craft revoke failed");
      }
      // The last output mirror runs AFTER the turn returns. A successful revoke
      // already ran the runner's final sync_out, so only a failed one (of a
      // granted token) asks for it again — bounded the same way.
      const final = enqueue(granted && !revoked ? CRAFT_RELEASE_TIMEOUT_MS : null);
      pendingFinalCollects.set(sid, final);
      void final.finally(() => {
        if (pendingFinalCollects.get(sid) === final) pendingFinalCollects.delete(sid);
      });
    },
    collectOutputs() {
      return enqueue(CRAFT_SYNC_TIMEOUT_MS);
    },
    async stage(roots, inputPath) {
      if (!live()) {
        purgeGone();
        return { error: CONVERSATION_GONE_STAGE };
      }
      // Honour the runner's exchange budget before copying up to 200 MB more
      // into the inbox (Addendum B N2): the run-start verdict or a newer probe.
      const probe = cachedCraftRunnerHealth(config);
      if (ctx.state.storage.exchangeFull || (probe.state === "ok" && craftExchangeOverBudget(probe.health))) {
        return { error: STORAGE_FULL_STAGE };
      }
      const staged = await stageWorkspaceFile(roots, inputPath, dirs.inboxDir);
      if ("error" in staged) {
        const messages: Record<typeof staged.error, string> = {
          OUTSIDE_WORKSPACE: "The file must be inside the run's working directory or conversation scratch workspace.",
          NOT_FOUND: "The file does not exist.",
          NOT_FILE: "The path is not a regular file (links, folders and special files cannot be staged).",
          TOO_LARGE: "The file is larger than the 200 MB staging limit.",
          INBOX_FULL:
            "This conversation's Craft session inbox is full (1 GB / 2000 files in total, including files staged earlier in this message). Staged files are cleared at the start of the next message; stage fewer or smaller files.",
          NO_SESSION: "This conversation has no Craft session right now; retry on the next message.",
          COPY_FAILED: "The file could not be copied into the Craft session.",
        };
        return { error: messages[staged.error] };
      }
      let reply: Record<string, unknown>;
      try {
        reply = await craftControlRequest(config, "sync_in", { sid }, CRAFT_SYNC_TIMEOUT_MS);
      } catch (error) {
        if (error instanceof CraftRunnerError && error.budget) {
          // The runner takes in no new bytes: do not leave the copy counting against the volume.
          await removeTreeNoFollow(path.join(dirs.inboxDir, CRAFT_STAGED_DIR, staged.name));
          return { error: STORAGE_FULL_STAGE };
        }
        return { error: `The file was staged but the craft-runner could not take it in (${errorText(error)}). Retry once; if it keeps failing, tell the user the Craft runner is unavailable.` };
      }
      const refusal = stagedRejection(reply.rejected, staged.name);
      if (refusal !== null) {
        return {
          error: `The craft-runner refused the staged file (${refusal || "rejected"}), so the app cannot open it. Check its size and name, or tell the user the file cannot be used in the Craft app.`,
        };
      }
      return { runnerPath: path.posix.join(opened.inDir, CRAFT_STAGED_DIR, staged.name) };
    },
  };
  return session;
}

/**
 * Whether a `sync_in` reply's `rejected` list names the staged file — the
 * runner's reason (bounded, sanitized as data), or null when it was taken.
 * Paths are matched by their `staged/<name>` tail, whatever prefix the runner
 * reports them under.
 */
export function stagedRejection(rejected: unknown, name: string): string | null {
  if (!Array.isArray(rejected)) return null;
  const target = `${CRAFT_STAGED_DIR}/${name}`;
  for (const entry of rejected) {
    if (!isRecord(entry) || typeof entry.path !== "string") continue;
    const entryPath = entry.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (entryPath === target || entryPath.endsWith(`/${target}`)) {
      return asString(entry.reason).replace(/[^A-Za-z0-9_ -]+/g, "").slice(0, 40);
    }
  }
  return null;
}

export interface CraftRunPreparation {
  state: CraftRunState;
  session: CraftRunSession | null;
}

/**
 * Gate + open the conversation's Craft session for ONE run. Returns null when
 * the run carries no Craft self-state at all: not an owner-driven run, or an
 * owner who is neither a system admin nor has a Craft group selected (so
 * every ordinary user's prompt stays free of the beta).
 */
export async function prepareCraftRun(input: {
  store: Store;
  config: AppConfig;
  ownerUserId: string;
  ownerRun: boolean;
  interactive: boolean;
  visionEnabled: boolean;
  conversationId: string | undefined;
  workspaceDir: string | undefined;
  rawMcpToolGroups: unknown;
  policyAllowed: readonly McpToolGroupId[] | null;
  /** Whether the conversation still exists — re-checked before every workspace mirror and stage (Addendum B N8). */
  isConversationLive?: () => boolean;
}): Promise<CraftRunPreparation | null> {
  if (!input.ownerRun) return null;
  const selected = input.rawMcpToolGroups == null ? [...DEFAULT_MCP_TOOL_GROUPS] : normalizeMcpToolGroups(input.rawMcpToolGroups);
  const anySelected = CRAFT_APPS.some((app) => selected.includes(app.toolGroupId));
  const ownerIsAdmin = input.store.isAdmin(input.ownerUserId);
  if (!ownerIsAdmin && !anySelected) return null;
  const paths = craftExchangePaths(input.config);
  const facts: Omit<CraftGateInput, "probe"> = {
    configured: Boolean(paths),
    toggleOn: input.store.isCraftAppsEnabled(),
    ownerIsAdmin,
    interactiveOwnerRun: input.interactive,
    visionEnabled: input.visionEnabled,
    hasWorkspace: Boolean(input.workspaceDir && input.conversationId),
    selected,
    policyAllowed: input.policyAllowed,
  };
  // A live probe only when an app could actually be used; otherwise the
  // memoized one (versions for describe_system) is enough.
  const probe = wantsRunner(facts) ? await refreshCraftRunnerHealth(input.config) : cachedCraftRunnerHealth(input.config);
  const apps = planCraftApps({ ...facts, probe });
  const workspaceOutDir = input.workspaceDir ? path.join(input.workspaceDir, CRAFT_WORKSPACE_OUT_DIR) : null;
  const state: CraftRunState = {
    apps,
    selected: anySelected,
    session: null,
    workspaceOutDir,
    stageToolActive: false,
    storage: { exchangeFull: false, workspaceOutFull: false },
  };
  if (!paths || !apps.some((app) => app.active) || !input.conversationId || !input.workspaceDir) {
    return { state, session: null };
  }
  const sid = craftSessionId(input.conversationId);
  const failSession = (why: string, reason: CraftUnavailableReason = "session_failed"): CraftRunPreparation => {
    craftLogger.warn({ sid, error: why }, "craft session could not be opened");
    for (const app of apps) {
      if (app.active) {
        app.active = false;
        app.reason = reason;
      }
    }
    return { state, session: null };
  };
  // A conversation deleted before this run got here must not re-open (and so
  // resurrect) its runner session; purge again in case the delete path's
  // purge did not reach the runner.
  if (input.isConversationLive && !input.isConversationLive()) {
    purgeCraftSessions(input.config, [input.conversationId]);
    return failSession("the conversation no longer exists");
  }
  let opened: { inDir: string; outDir: string };
  try {
    // `open` of a NEW sid waits for the runner's exchange measurement, so it
    // gets the copy budget rather than the default request timeout.
    const reply = await craftControlRequest(input.config, "open", { sid }, CRAFT_SYNC_TIMEOUT_MS);
    const inDir = asString(reply.inDir);
    const outDir = asString(reply.outDir);
    if (!inDir.startsWith("/") || !outDir.startsWith("/")) return failSession("open returned no session paths");
    opened = { inDir, outDir };
  } catch (error) {
    // A NEW session over the exchange budget is refused (an existing one still opens).
    const full = error instanceof CraftRunnerError && error.budget !== undefined;
    return failSession(errorText(error), full ? "storage_full" : "session_failed");
  }
  const inboxDir = await ensureCraftInbox(paths.inboxRoot, sid);
  if (!inboxDir) return failSession("the session inbox could not be prepared");
  // The previous run's final output mirror (off its response path) lands
  // before this run mirrors craft/out/ into in/craft-out/.
  await craftFinalCollectSettled(sid);
  // staged/ is per RUN (Addendum A4): what an earlier message staged never
  // piles up against the inbox cap.
  await clearCraftStaged(inboxDir);
  // Honour the runner's exchange budget (Addendum B N2): over it, nothing more
  // is copied in (the runner's sync_in would refuse anyway) — the session
  // still opens so earlier results stay deliverable, and both surfaces say why.
  state.storage.exchangeFull = probe.state === "ok" && craftExchangeOverBudget(probe.health);
  if (state.storage.exchangeFull) {
    craftLogger.warn({ sid }, "craft exchange over budget; workspace inputs not mirrored into the session");
  } else {
    const mirror = await mirrorWorkspaceToInbox(input.workspaceDir, inboxDir);
    if (mirror.rejected.length > 0) {
      craftLogger.warn({ sid, rejected: mirror.rejected.slice(0, 20) }, "craft inbox mirror rejected files");
    }
    try {
      await craftControlRequest(input.config, "sync_in", { sid }, CRAFT_SYNC_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof CraftRunnerError) || error.kind !== "rejected") {
        // Raced a delete: the run must not leave the re-opened session behind.
        if (input.isConversationLive && !input.isConversationLive()) purgeCraftSessions(input.config, [input.conversationId]);
        return failSession(errorText(error));
      }
      // A rejected sync (caps) still leaves the session usable with what fit;
      // a budget refusal means the runner took nothing in.
      if (error.budget) state.storage.exchangeFull = true;
      craftLogger.warn({ sid, error: errorText(error) }, "craft sync_in rejected");
    }
  }
  const session = createSession(
    { config: input.config, sid, conversationId: input.conversationId, state, isConversationLive: input.isConversationLive },
    opened,
    {
      inboxDir,
      outboxDir: path.join(paths.outboxRoot, sid),
      workspaceDir: input.workspaceDir,
    },
  );
  // Results of earlier runs (a missed final mirror) are visible from the start.
  await session.collectOutputs();
  state.session = opened;
  state.stageToolActive = true;
  return { state, session };
}

/** Deactivate every app of a run whose grant failed (the relays were unregistered). */
export function markCraftSessionFailed(state: CraftRunState): void {
  for (const app of state.apps) {
    if (app.active) {
      app.active = false;
      app.reason = "session_failed";
    }
  }
  state.session = null;
  state.stageToolActive = false;
}

/** The stdio relay definition for one app (only the handoff PATH rides argv). */
export function craftRelayServerDef(relayScriptPath: string, handoffFile: string): {
  type: "stdio";
  command: string;
  args: string[];
} {
  return { type: "stdio", command: process.execPath, args: [relayScriptPath, handoffFile] };
}

// ---------------------------------------------------------------------------
// mcp__craft_files__stage
// ---------------------------------------------------------------------------

export function buildCraftFilesServer(ctx: {
  /** runPlan's Craft gate for this run (re-checked per call — the mcp__ auto-allow fires first). */
  allowed: () => boolean;
  stage: (inputPath: string) => Promise<{ runnerPath: string } | { error: string }>;
}) {
  return createSdkMcpServer({
    name: CRAFT_FILES_SERVER_NAME,
    version: "1.0.0",
    tools: [
      tool(
        "stage",
        "Copy ONE file from your workspace into this conversation's Craft session so a Craft app (PhotoCraft, …) can open it. " +
          "Chat attachments, browser captures, Confluence downloads and earlier Craft results are mirrored automatically at the start of every message (in/attachments/, in/captures/, in/confluence/, in/craft-out/) — use this only for any OTHER workspace file. " +
          "Returns the path the app must be given (under in/staged/). Max 200 MB; regular files only.",
        {
          path: z.string().min(1).max(4096).describe("Workspace file path, relative to the current working directory or absolute inside an allowed working root."),
        },
        async (args) => {
          if (!ctx.allowed()) {
            return text("Craft apps are not available in this run.", true);
          }
          const result = await ctx.stage(args.path);
          if ("error" in result) return text(result.error, true);
          return text(`Staged. Open it in the Craft app as: ${result.runnerPath}`);
        },
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// Tool-result tracking (previews, output mirror, audit)
// ---------------------------------------------------------------------------

export interface CraftToolCompletion {
  toolUseId: string;
  app: CraftAppId;
  tool: string;
  /** Command ids from command_run / each command_batch step — never params. */
  commandIds: string[];
  ok: boolean;
  images: { buffer: Buffer; mediaType: ImageMediaType }[];
}

const MAX_COMMAND_IDS = 20;

/** Command ids a Craft tool input names (`{id}` or a batch of `{id}` steps). Bounded; ids only. */
export function craftCommandIds(input: unknown): string[] {
  if (!isRecord(input)) return [];
  const ids: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value && ids.length < MAX_COMMAND_IDS) ids.push(value.slice(0, 120));
  };
  push(input.id);
  for (const key of ["steps", "commands", "batch"]) {
    const list = input[key];
    if (Array.isArray(list)) {
      for (const step of list) {
        if (isRecord(step)) push(step.id);
      }
    }
  }
  return ids;
}

/** Image blocks of one tool_result, in either the API shape (`source.data`) or the MCP shape (`data` + `mimeType`). */
export function craftResultImages(content: unknown): { buffer: Buffer; mediaType: ImageMediaType }[] {
  if (!Array.isArray(content)) return [];
  const images: { buffer: Buffer; mediaType: ImageMediaType }[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "image") continue;
    const source = isRecord(block.source) ? block.source : undefined;
    const data = typeof source?.data === "string" ? source.data : typeof block.data === "string" ? block.data : "";
    if (!data || data.length > Math.ceil((MAX_CHAT_FILE_BYTES * 4) / 3) + 4) continue;
    const buffer = Buffer.from(data, "base64");
    // MIME from the bytes, never from the block's claim.
    const mediaType = detectImageMediaType(buffer);
    if (mediaType) images.push({ buffer, mediaType });
  }
  return images;
}

/**
 * Follow the SDK stream for calls to the ACTIVE Craft apps: remember each
 * `tool_use` (main agent or subagent), and turn its `tool_result` into a
 * completion. Calls to apps not active this run are ignored (they cannot
 * exist — nothing registered them).
 */
export function createCraftToolTracker(activeApps: readonly CraftAppId[]) {
  const pending = new Map<string, { app: CraftAppId; tool: string; commandIds: string[] }>();
  const active = new Set<CraftAppId>(activeApps);
  return (message: Record<string, unknown>): CraftToolCompletion[] => {
    if (active.size === 0) return [];
    const body = isRecord(message.message) ? message.message : undefined;
    const content = body?.content;
    if (!Array.isArray(content)) return [];
    if (message.type === "assistant") {
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_use") continue;
        const name = asString(block.name);
        const app = craftAppOfToolName(name);
        const id = asString(block.id);
        if (!app || !id || !active.has(app)) continue;
        pending.set(id, { app, tool: name.slice(`mcp__${app}__`.length), commandIds: craftCommandIds(block.input) });
      }
      return [];
    }
    if (message.type !== "user") return [];
    const done: CraftToolCompletion[] = [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const id = asString(block.tool_use_id);
      const call = pending.get(id);
      if (!call) continue;
      pending.delete(id);
      done.push({ toolUseId: id, ...call, ok: block.is_error !== true, images: craftResultImages(block.content) });
    }
    return done;
  };
}

/**
 * What the run loop does with one finished Craft call: audit it (app, tool,
 * command ids — never params), mirror the outbox into the workspace, then
 * publish its images to the user. Never throws.
 */
export async function handleCraftCompletion(
  completion: CraftToolCompletion,
  deps: {
    store: Store;
    owner: { id: string; displayName: string };
    session: CraftRunSession | null;
    events: AgentEvents | undefined;
    anchor: number;
  },
): Promise<void> {
  try {
    deps.store.audit({
      actorUserId: deps.owner.id,
      actorName: deps.owner.displayName,
      action: "craft_tool",
      status: completion.ok ? "success" : "error",
      detail: JSON.stringify({
        app: completion.app,
        tool: completion.tool,
        ...(completion.commandIds.length ? { commands: completion.commandIds } : {}),
      }),
    });
  } catch (error) {
    craftLogger.warn({ error: errorText(error) }, "craft_tool audit failed");
  }
  await deps.session?.collectOutputs();
  if (completion.images.length > 0 && deps.events?.onCraftPreview) {
    try {
      await deps.events.onCraftPreview({
        app: completion.app,
        tool: completion.tool,
        images: completion.images,
        anchor: deps.anchor,
      });
    } catch (error) {
      craftLogger.warn({ error: errorText(error) }, "craft preview publish failed");
    }
  }
}
