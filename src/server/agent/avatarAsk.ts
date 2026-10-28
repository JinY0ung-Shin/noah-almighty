import fs from "node:fs";
import type { AppConfig, PluginRoot } from "../types.js";
import type { Store } from "../store.js";
import type { AgentEvents } from "./events.js";
import { runAgentStream } from "./index.js";
import { EMPTY_SDK_RESPONSE_MESSAGE } from "./claudeAgent.js";
import {
  AVATAR_ASK_ANSWER_CAP,
  AVATAR_ASK_TIMEOUT_MS,
  type AvatarAskOutcome,
} from "./avatarAskShared.js";
import { loadAgentPluginRoots, loadKnowledgeRepoMemory } from "../plugins.js";
import { workspaceDirFor } from "../workspace.js";
import logger from "../logger.js";

// Compatibility re-exports: born here and imported from this module by tests;
// their real home is the leaf avatarAskShared.ts. (MAX_PER_TURN/TIMEOUT_MS are
// consumed only via that leaf now, so they are not re-exported here.)
export {
  AVATAR_ASK_ANSWER_CAP,
  type AvatarAskOutcome,
} from "./avatarAskShared.js";

/**
 * Avatar-to-avatar consultation (#ask-avatar): run ONE headless agent turn
 * against a same-group teammate's avatar and return its answer text.
 *
 * Trust model — deliberately identical to a teammate chatting with that avatar
 * in the UI: the asker must be able to REACH the avatar (`resolveChatAvatar`,
 * the visibility gate) AND share a group with its owner (`isTrustedFor`, the
 * single trust choke point). The inner run is the existing trusted-colleague
 * viewer class (`viewerIsOwner: false, elevated: true`), so owner-only tools
 * stay locked no matter what `allowHeadlessTools` opens: the target answers
 * with persona + personal-knowledge READ tools (second-brain recall), exactly
 * what the asking user could already get by chatting directly.
 *
 * Depth guard: the inner request carries `avatarConsultation: true`, which
 * keeps `ask_avatar` OUT of the inner run's tool registration — an A→B→C (or
 * A→B→A) chain is impossible by construction.
 */

export interface AvatarAskInput {
  /** The asking avatar's OWNER (ask is owner-driven; viewer == owner). */
  askerUserId: string;
  askerName: string;
  /** Target avatar's @username, with or without the leading `@`. */
  targetUsername: string;
  question: string;
  /**
   * The OUTER run's abort signal: cancelling the asking turn also cancels the
   * consultation instead of leaving it running for the full timeout.
   */
  parentSignal?: AbortSignal;
}

/** Test seam: the inner-run executor (defaults to the real runAgentStream). */
export interface AvatarAskDeps {
  run?: typeof runAgentStream;
  loadRoots?: (store: Store, avatarId: string, config: AppConfig) => Promise<PluginRoot[]>;
  timeoutMs?: number;
}

function capAnswer(raw: string): { answer: string; truncated: boolean } {
  const trimmed = raw.trim();
  if (trimmed.length <= AVATAR_ASK_ANSWER_CAP) {
    return { answer: trimmed, truncated: false };
  }
  return { answer: trimmed.slice(0, AVATAR_ASK_ANSWER_CAP), truncated: true };
}

/**
 * The consultation's synchronous gates (target exists, is not the asker, is
 * visible, and its owner is trusted): the refusal outcome, or the resolved
 * target. Run again by `askAvatar` itself; exported so a background start (pi
 * runs, design D8) can refuse at once instead of in a later message.
 */
export function preflightAvatarAsk(
  store: Store,
  input: Pick<AvatarAskInput, "askerUserId" | "targetUsername">,
):
  | { ok: false; outcome: AvatarAskOutcome }
  | { ok: true; username: string; target: NonNullable<ReturnType<Store["resolveChatAvatar"]>> } {
  const username = input.targetUsername.trim().replace(/^@/, "");
  const targetUser = username ? store.getUserByUsername(username) : null;
  if (!targetUser) {
    return { ok: false, outcome: { ok: false, reason: "not_found", username } };
  }
  if (targetUser.id === input.askerUserId) {
    return { ok: false, outcome: { ok: false, reason: "self", username } };
  }
  // Visibility gate (public/group/private + suspended), then the trust gate.
  // Both fail as if the avatar didn't exist where that avoids leaking existence.
  const target = store.resolveChatAvatar(input.askerUserId, targetUser.id);
  if (!target) {
    return { ok: false, outcome: { ok: false, reason: "not_found", username } };
  }
  if (!store.isTrustedFor(input.askerUserId, target.id)) {
    return {
      ok: false,
      outcome: { ok: false, reason: "not_trusted", username, displayName: target.displayName },
    };
  }
  return { ok: true, username, target };
}

export async function askAvatar(
  store: Store,
  config: AppConfig,
  input: AvatarAskInput,
  deps: AvatarAskDeps = {},
): Promise<AvatarAskOutcome> {
  const question = input.question.trim();
  const preflight = preflightAvatarAsk(store, input);
  if (!preflight.ok) {
    return preflight.outcome;
  }
  const { username, target } = preflight;
  // Early-out BEFORE the expensive prep (plugin-root sync can clone/pull).
  if (input.parentSignal?.aborted) {
    return { ok: false, reason: "failed", username, detail: "the asking run was cancelled" };
  }

  // The TARGET owner's skills + standing memory, like a teammate chat with them.
  const loadRoots =
    deps.loadRoots ??
    ((s: Store, avatarId: string, c: AppConfig) =>
      loadAgentPluginRoots(s, avatarId, c, (message) =>
        logger.warn({ avatarId, message }, "avatar-ask plugin root warning"),
      ));
  const pluginRoots = await loadRoots(store, target.id, config);
  const knowledgeMemory = await loadKnowledgeRepoMemory(store, target.id, config);
  const workspaceDir = workspaceDirFor(config, target.id, `avatar-ask-${input.askerUserId}`);
  fs.mkdirSync(workspaceDir, { recursive: true });

  const timeoutMs = deps.timeoutMs ?? AVATAR_ASK_TIMEOUT_MS;
  const abortController = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);
  const onParentAbort = () => abortController.abort();
  input.parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  // Accumulate deltas only so a timed-out run can still return what arrived —
  // `response.text` never materializes on abort (mirrors the routine scheduler).
  let partial = "";
  const events: AgentEvents = {
    onDelta: (chunk) => {
      partial += chunk;
    },
  };
  const run = deps.run ?? runAgentStream;
  try {
    const response = await run(
      {
        message: question,
        avatar: target,
        cwd: workspaceDir,
        viewerUserId: input.askerUserId,
        viewerName: input.askerName,
        // The trusted-colleague viewer class: elevated READ access (verified via
        // isTrustedFor above), never owner tools. allowHeadlessTools only lifts
        // the headless read-restriction so the elevated recall tools (second
        // brain / repo read) register; owner gates key off viewerIsOwner=false.
        viewerIsOwner: false,
        elevated: true,
        trustedViaGroups: store.sharedGroupNames(input.askerUserId, target.id),
        headless: true,
        allowHeadlessTools: true,
        // Depth guard + consultation prompt framing (see promptBuilder).
        avatarConsultation: true,
        // The target answers from its own knowledge only: personal-knowledge
        // recall + request_info (so it can escalate a true unknown to ITS owner).
        mcpToolGroups: ["personal_knowledge"],
        knowledgeMemory,
        // Headless with no live stream — transient model errors retry down the
        // tier chain like routines do.
        modelFallback: true,
      },
      pluginRoots,
      config,
      store,
      events,
      abortController,
    );
    // An error result (e.g. error_max_turns) substitutes a Korean fallback into
    // `response.text` instead of throwing — relaying that as the teammate's
    // "answer" would be wrong twice over (it's an error, and it's user-facing
    // Korean crossing into the model channel). Same for the empty-run sentinel.
    if (response.resultError) {
      return {
        ok: false,
        reason: "failed",
        username,
        displayName: target.displayName,
        detail: `the target run ended with ${response.resultError}`,
      };
    }
    const raw = response.text === EMPTY_SDK_RESPONSE_MESSAGE ? "" : response.text;
    const { answer, truncated } = capAnswer(raw);
    if (!answer) {
      return { ok: false, reason: "empty", username, displayName: target.displayName };
    }
    return { ok: true, username, displayName: target.displayName, answer, truncated };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (timedOut) {
      const { answer } = capAnswer(partial);
      return {
        ok: false,
        reason: "timeout",
        username,
        displayName: target.displayName,
        partialAnswer: answer || undefined,
      };
    }
    // The SDK labels EVERY abort "aborted by user" (see the routine scheduler
    // note) — when the ASKING turn was cancelled, name the real cause instead.
    if (input.parentSignal?.aborted) {
      return {
        ok: false,
        reason: "failed",
        username,
        displayName: target.displayName,
        detail: "the asking run was cancelled",
      };
    }
    logger.warn(
      { askerUserId: input.askerUserId, targetId: target.id, detail },
      "avatar-ask consultation run failed",
    );
    return { ok: false, reason: "failed", username, displayName: target.displayName, detail };
  } finally {
    clearTimeout(deadline);
    input.parentSignal?.removeEventListener("abort", onParentAbort);
  }
}
