/**
 * Constants + outcome type shared between the consultation CORE (avatarAsk.ts,
 * which drags in the full agent runner) and the TOOL layer
 * (avatarDirectoryTools.ts, a leaf module built per run). Keeping these in a
 * leaf of their own lets the tool file avoid a static dependency on the runner.
 */

/** Hard wall-clock budget for one consultation run. */
export const AVATAR_ASK_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Cap on the answer text returned into the ASKING avatar's context. The answer
 * is another user's model output — bounding it bounds both token cost and the
 * prompt-injection surface (mirrors the bio truncation in avatarDirectoryTools).
 */
export const AVATAR_ASK_ANSWER_CAP = 8_000;

/**
 * Consultations one turn may start. Each spawns a full agent run for the target
 * (its own pi run, model calls, and a 3-min budget), so an unbounded loop
 * would be a cheap cost amplifier on the shared deployment credentials.
 */
export const AVATAR_ASK_MAX_PER_TURN = 5;

/** Outcome of one consultation attempt (decoded to agent-facing text by the tool). */
export type AvatarAskOutcome =
  | {
      ok: true;
      /** Target's @username / display name, for provenance labeling. */
      username: string;
      displayName: string;
      answer: string;
      truncated: boolean;
    }
  | {
      ok: false;
      /**
       * `not_found` covers unknown, private, and suspended targets alike so the
       * tool cannot be used to probe for the existence of invisible avatars.
       */
      reason: "not_found" | "self" | "not_trusted" | "empty" | "timeout" | "failed";
      username: string;
      displayName?: string;
      /** Text streamed before a timeout, when any arrived. */
      partialAnswer?: string;
      detail?: string;
    };
