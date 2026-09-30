import crypto from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ensureClone, knowledgeRepoContextFor } from "../knowledgeRepo.js";
import { scrubGitError } from "../marketplace.js";
import { listRepoSkills } from "../skillTransfer.js";
import type { Store } from "../store.js";
import { MAX_PERSONAL_AGENTS } from "../store.js";
import type { AgentOwner, AppConfig, PersonalAgent } from "../types.js";
import { requestBotTaskDispatch } from "../botTaskDispatchBroker.js";
import {
  botTaskTitle,
  findChattablePersonalAgent,
  normalizePersonalAgentSkills,
  MAX_DELEGATION_DEPTH,
  MAX_DELEGATIONS_PER_TURN,
  MAX_PERSONAL_AGENT_SKILLS,
  MAX_QUEUED_BOT_TASKS,
  personalAgentAvatarId,
  PERSONAL_AGENT_DISPLAY_NAME_CAP,
  PERSONAL_AGENT_FIELD_CAPS,
  PERSONAL_AGENT_SKILL_SLUG_CAP,
  type PersonalAgentSkillSelection,
} from "../personalAgents.js";
import { text } from "./mcpTools.js";

/**
 * Personal-agent (내 봇) tools — the OWNER-scoped counterpart of
 * groupAgentProfileTools.ts, split over the two run kinds that can reach them:
 *
 * - `update_profile` registers only on a PERSONAL-AGENT run: the bot edits its
 *   OWN persona/profile mid-conversation (the group agent's self-configuration,
 *   scoped to one person's bot instead of a team's).
 * - `report_task` registers on the SAME bot runs: the bot declares how the
 *   delegated turn went (done / need_input) onto the owner's task card. Always
 *   registered — the handler refuses when the run tracks no task, because a
 *   greeting turn and a delegated one are the same tool set.
 * - `adopt_skill` / `drop_skill` register on the SAME bot runs: the bot manages
 *   its OWN allowlist of the owner's knowledge-repo skills. A bot loads NONE by
 *   default, and a grant is a live reference into `skills/<slug>/` (never a
 *   copy) that reaches the run only from the NEXT conversation.
 * - `create_agent` registers only on a NON-bot owner run: the owner's main
 *   avatar stands a new bot up for them, optionally with its first skills.
 * - `delegate_to_bot` registers on BOTH sets — it is the one tool a bot and the
 *   owner's own avatar share. It hands a self-contained request to ANOTHER of
 *   the owner's bots as a QUEUED task on that bot's thread; the server runs it
 *   unattended and the result lands on the 봇 오피스 board. Async hand-off, not
 *   a question: nothing flows back into the delegating turn.
 *
 * Both are gated per call on the LIVE owner + admin role (the phase-1 feature
 * gate), because the `mcp__` auto-allow in the PreToolUse hook fires before any
 * check. Field caps and the cap-vs-name throws are NOT re-derived here — they
 * come from `../personalAgents.js` and the store, the single enforcement points
 * the HTTP settings route shares. State surfaces via `PersonalAgentState`
 * (ownerState.ts) into BOTH the prompt branch and describe_system.
 */

/** MCP server name; tools surface as `mcp__personal_agent__<tool>`. */
export const PERSONAL_AGENT_SERVER_NAME = "personal_agent";

/** Bot-run tool names in `allowedTools` form (keep in sync with the factory). */
export const PERSONAL_AGENT_SELF_TOOL_NAMES = [
  "mcp__personal_agent__update_profile",
  "mcp__personal_agent__report_task",
  "mcp__personal_agent__delegate_to_bot",
  "mcp__personal_agent__adopt_skill",
  "mcp__personal_agent__drop_skill",
] as const;

/** Owner-run (non-bot) tool names in `allowedTools` form. */
export const PERSONAL_AGENT_OWNER_TOOL_NAMES = [
  "mcp__personal_agent__create_agent",
  "mcp__personal_agent__delegate_to_bot",
] as const;

// Re-exported for symmetry with GROUP_AGENT_FIELD_CAPS: every writer of a bot
// profile (this module, the settings route) enforces the SAME numbers, and they
// are DEFINED in ../personalAgents.js next to the id/reach helpers.
export { PERSONAL_AGENT_DISPLAY_NAME_CAP, PERSONAL_AGENT_FIELD_CAPS };

const AGENT_GONE =
  "This bot no longer exists — its owner deleted it. Tell the owner instead of retrying.";
const NOT_OWNER =
  "This bot belongs to a different user, so you cannot change its profile.";
const AGENT_DISABLED =
  "This bot is currently DISABLED in its owner's settings (설정 → 내 봇), so its profile cannot be changed. Ask the owner to re-enable it first.";
const ADMIN_FEATURE_OFF =
  "Personal bots (내 봇) are an administrator-only feature in this deployment and this owner no longer holds the admin role, so bot management is unavailable. Say so plainly — there is no other route.";
const EMPTY_PATCH =
  "Provide at least one field to update (persona, alias, bio, or intro).";
const NO_TRACKED_TASK =
  "No delegated task is being tracked for this turn (e.g. this conversation predates task tracking, or this is a greeting). Just answer normally — do not retry.";
const TASK_NOT_RUNNING =
  "The tracked task is not in a running state anymore, so the report was not recorded. Finish your reply normally.";
const EMPTY_REPORT_SUMMARY =
  "The summary is empty. For 'done', write 1-3 sentences on what you accomplished; for 'need_input', write the question you need the owner to answer. The owner reads this text on the task card, so it cannot be blank.";

/** Cap for the text written onto the task card — a card, not an essay. */
const REPORT_SUMMARY_CAP = 2000;

// ---------------------------------------------------------------------------
// Skill grants (adopt_skill / drop_skill) — the bot's own allowlist
// ---------------------------------------------------------------------------

/**
 * The codebase-wide truth about skill loading: plugin/skill roots are resolved
 * when a run STARTS, so a grant made mid-conversation cannot join this session.
 * Every surface that changes a skill set says this in the same words.
 */
const SKILL_CHANGE_TIMING =
  "Takes effect from the NEXT conversation (this session keeps its current skill set).";

const NO_SKILL_CATALOG =
  "This run cannot read the owner's knowledge repository, so skills cannot be granted from here. Tell the owner to grant it in 설정 → 내 봇 instead.";
const NO_KNOWLEDGE_REPO =
  "The owner has no knowledge repository connected, so there are no skills to adopt. Tell them to connect one in 설정 → 지식 저장소 first, then ask again.";
const EMPTY_SKILL_SLUG =
  "Name the skill: the exact `skills/<name>` directory name in the owner's knowledge repository.";

/** How many slugs an error lists before it summarizes — bounds the result size. */
const ROSTER_PREVIEW = 30;

/** Render a slug roster for an error/refusal, capped. */
function rosterLine(slugs: string[]): string {
  if (slugs.length === 0) {
    return "The owner's repository holds no skills yet (a skill is a `skills/<name>/SKILL.md` directory).";
  }
  const shown = slugs.slice(0, ROSTER_PREVIEW);
  const more =
    slugs.length > shown.length ? `, … (${slugs.length} in total)` : "";
  return `The owner's skills are: ${shown.join(", ")}${more}.`;
}

/** The bot's CURRENT grants, for a result that has to say where things stand. */
function grantedLine(slugs: string[]): string {
  return slugs.length > 0
    ? `You now carry: ${slugs.join(", ")}.`
    : "You now carry no skills at all.";
}

/** Map the shared slug validator's refusal onto its agent-facing English text. */
function skillSelectionRefusal(
  result: Extract<PersonalAgentSkillSelection, { ok: false }>,
): string {
  if (result.reason === "count") {
    return `A bot may hold at most ${MAX_PERSONAL_AGENT_SKILLS} skills, which this list exceeds. Ask the owner which ones actually matter.`;
  }
  if (result.reason === "length") {
    return `A skill name is limited to ${PERSONAL_AGENT_SKILL_SLUG_CAP} characters — that is a description, not a \`skills/<name>\` directory name.`;
  }
  if (result.reason === "slug") {
    return `"${result.slug.slice(0, 60)}" is not a skill directory name. Use the exact \`skills/<name>\` folder name from the owner's repository (letters, digits, \`.\`, \`_\`, \`-\` only).`;
  }
  return "The skill list must be an array of `skills/<name>` directory names (strings).";
}

/**
 * The owner's grantable skill roster, read LIVE from their knowledge repo — a
 * grant must name a directory that actually exists, or the run would silently
 * load nothing. Returns the refusal text instead of throwing, because every
 * failure here (no repo, unreadable repo) is something the bot must TELL the
 * owner rather than retry.
 *
 * `config` is optional only because the run context may not carry it yet (see
 * PersonalAgentSelfToolsContext.config); missing it fails CLOSED.
 */
async function ownerSkillRoster(
  store: Store,
  ownerUserId: string,
  config: AppConfig | undefined,
): Promise<{ ok: true; slugs: string[] } | { ok: false; message: string }> {
  if (!config) return { ok: false, message: NO_SKILL_CATALOG };
  const ctx = knowledgeRepoContextFor(store, ownerUserId, config);
  if (!ctx) return { ok: false, message: NO_KNOWLEDGE_REPO };
  try {
    const repoRoot = await ensureClone(ctx);
    return { ok: true, slugs: listRepoSkills(repoRoot).map((s) => s.slug) };
  } catch (error) {
    return {
      ok: false,
      message:
        `Failed to load the owner's knowledge repository: ${scrubGitError(error)}\n` +
        "Tell the owner — do not work around this with Bash git, the shell has no git credentials.",
    };
  }
}

const FIELD_CAPS = PERSONAL_AGENT_FIELD_CAPS;
type ProfileField = keyof typeof FIELD_CAPS;
const PROFILE_FIELDS = Object.keys(FIELD_CAPS) as ProfileField[];

/** `Provide at least one…`-style cap refusal, shared by both tools. */
function overCap(field: string, cap: number, length: number): string {
  return `The ${field} field is limited to ${cap} characters (got ${length}). Shorten it and try again.`;
}

/** Context for ONE personal-agent run's self-configuration + reporting tools. */
export interface PersonalAgentSelfToolsContext {
  /** WHICH bot this run is; ownership/enabled/role are re-read per call. */
  agentId: string;
  /** The owner driving this run: live gate subject AND audit actor. */
  owner: AgentOwner;
  /**
   * The `bot_tasks` row tracking THIS turn as a delegated task, when the run
   * carries one (`AgentRequest.personalAgent.taskId`). Absent/null on turns
   * that track no task — `report_task` then refuses with a redirect instead of
   * guessing which card to write. Bookkeeping only: it never widens the run.
   */
  taskId?: string | null;
  /** The thread this run belongs to, for the report's audit attribution. */
  conversationId?: string | null;
  /**
   * Needed ONLY to resolve the owner's knowledge-repo clone for `adopt_skill`
   * (validating a grant against the real `skills/` tree). Optional so a caller
   * that has no config still gets every other tool; `adopt_skill` then refuses
   * with NO_SKILL_CATALOG rather than granting something unverified.
   */
  config?: AppConfig;
}

/**
 * The live per-call gate BOTH bot-run tools share (the `mcp__` auto-allow in the
 * PreToolUse hook fires before any check): a deleted bot, someone else's bot, a
 * mid-turn disable, and an owner whose admin role was revoked all refuse —
 * matching the reach gate that will refuse the NEXT turn
 * (findChattablePersonalAgent). Returns the refusal text, or null to proceed.
 */
function selfToolRefusal(
  store: Store,
  ctx: PersonalAgentSelfToolsContext,
): string | null {
  const agent = store.getPersonalAgentById(ctx.agentId);
  if (!agent) return AGENT_GONE;
  if (agent.ownerUserId !== ctx.owner.id) return NOT_OWNER;
  if (!agent.enabled) return AGENT_DISABLED;
  if (!store.isAdmin(ctx.owner.id)) return ADMIN_FEATURE_OFF;
  return null;
}

/** Context for an owner's own (non-bot) run, which may CREATE bots. */
export interface PersonalAgentOwnerToolsContext {
  /** The avatar owner: live gate subject AND audit actor. */
  owner: AgentOwner;
  /**
   * Needed ONLY when `create_agent` is called WITH skills, to check them
   * against the owner's real `skills/` tree. Optional for the same reason as on
   * the bot context: without it a skill-bearing create refuses instead of
   * storing a grant nobody verified.
   */
  config?: AppConfig;
}

// ---------------------------------------------------------------------------
// delegate_to_bot — 봇 간 위임 (the ONE tool both run kinds carry)
// ---------------------------------------------------------------------------

const DELEGATION_DEPTH_SPENT =
  "This task is already two hand-offs deep — the chain stops here. Finish what you can yourself and report need_input if you are blocked.";
const DELEGATION_BUDGET_SPENT =
  `You have already handed off ${MAX_DELEGATIONS_PER_TURN} request(s) in this turn, which is the limit. Each hand-off starts a FULL unattended run on the owner's account, so the rest of this work is yours: do it here, or tell the owner plainly what is left and which bot they should ask next.`;
const DELEGATION_SELF =
  "Delegating to yourself is a no-op — just do the work in this turn.";
const EMPTY_DELEGATION_REQUEST =
  "The `request` is empty. Write the complete instruction the other bot should carry out — it sees only that text, never this conversation.";
const EMPTY_DELEGATION_TARGET =
  "Name which bot to hand this to: its name, its alias, or its id — one of this owner's own enabled bots.";

/**
 * Everything the shared factory needs about the RUN doing the delegating. One
 * tool, two run kinds: a bot hand-off carries the delegating bot's id (and,
 * when the turn is tracked, the task whose depth the chain cap counts), while
 * the owner's main avatar carries neither.
 */
interface DelegationSource {
  /** The bot handing off; null on the owner's OWN avatar run. */
  agentId: string | null;
  /** The `bot_tasks` row tracking the delegating turn, when there is one. */
  taskId?: string | null;
  /** The run kind's live per-call gate (the `mcp__` auto-allow fires first). */
  guard: () => string | null;
}

/**
 * The 봇 간 위임 tool, built ONCE for both tool sets.
 *
 * The hand-off is deliberately ASYNC: it queues a `bot_tasks` row on the target
 * bot's own thread and pokes the dispatcher, then returns. No answer flows back
 * into this turn — the target runs later, unattended, and reports onto the
 * owner's 봇 오피스 board. That is what keeps a hand-off from silently becoming
 * a nested synchronous run inside the caller's deadline.
 *
 * Two independent caps guard the owner's bill: `delegationDepth` bounds the
 * CHAIN across turns (a task at MAX_DELEGATION_DEPTH may not hand off again),
 * and the closure counter below bounds the FAN-OUT of this single turn. Neither
 * is a capability boundary — the target bot's run is a full owner run either
 * way, exactly as a typed message to it would be.
 */
function buildDelegateToBotTool(
  store: Store,
  owner: AgentOwner,
  source: DelegationSource,
) {
  // Per-TURN budget. This closure is created with the run's tool set and dies
  // with it, so the counter is scoped to one run — it counts SUCCESSFUL
  // hand-offs only, since a refusal never started anything.
  let handedOff = 0;
  return tool(
    "delegate_to_bot",
    `**Use this when the owner's request clearly belongs to ANOTHER of their bots** — work squarely inside a different bot's role, or an explicit "리서치봇한테 시켜줘" / "hand this to X". It queues a self-contained request as a task on that bot's own thread, which the server then runs UNATTENDED. This is an async hand-off, not a question: no answer comes back into this conversation, and the owner reads the result on their 봇 오피스 board. Each hand-off is a full unattended run the owner pays for — never hand over what you can do yourself, and never pass along a task that was already delegated to you. Chains stop after ${MAX_DELEGATION_DEPTH} hops and one turn may hand off at most ${MAX_DELEGATIONS_PER_TURN} times. (this owner's own bots only)`,
    {
      target: z
        .string()
        .describe(
          "Which bot to hand this to: its name, its alias, or its id. Must be one of THIS owner's enabled bots.",
        ),
      request: z
        .string()
        .describe(
          "The complete instruction for that bot, written to stand ALONE: it sees only this text plus its own persona and knowledge — never this conversation, its history, or anything you have open. Include the context, the deliverable, and any constraint it must respect.",
        ),
    },
    async (args) => {
      const refusal = source.guard();
      if (refusal) return text(refusal, true);
      if (handedOff >= MAX_DELEGATIONS_PER_TURN) {
        return text(DELEGATION_BUDGET_SPENT, true);
      }
      // Chain depth rides the TASK, not the run: an untracked bot turn (a
      // greeting the owner typed) is depth 0 like a fresh request, and the
      // owner's main avatar always opens a chain at hop 1.
      const currentDepth = source.taskId
        ? (store.getBotTask(source.taskId)?.delegationDepth ?? 0)
        : 0;
      const nextDepth = currentDepth + 1;
      if (nextDepth > MAX_DELEGATION_DEPTH) {
        return text(DELEGATION_DEPTH_SPENT, true);
      }
      const request = args.request.trim();
      if (!request) return text(EMPTY_DELEGATION_REQUEST, true);
      const wanted = args.target.trim();
      if (!wanted) return text(EMPTY_DELEGATION_TARGET, true);

      // ENABLED bots only — a disabled bot reads as "not one of the names you
      // can use" rather than as an existing target that then fails to run.
      const roster = store.listPersonalAgents(owner.id);
      const needle = wanted.toLowerCase();
      const byId = roster.find((bot) => bot.id === wanted);
      const matches: PersonalAgent[] = byId
        ? [byId]
        : roster.filter(
            (bot) =>
              bot.displayName.trim().toLowerCase() === needle ||
              bot.alias.trim().toLowerCase() === needle,
          );
      if (matches.length === 0) {
        const others = roster.filter((bot) => bot.id !== source.agentId);
        return text(
          `No enabled bot of this owner matches "${wanted}". ` +
            (others.length > 0
              ? `Their enabled bots are: ${others.map((bot) => bot.displayName).join(", ")}. Use one of those names (or an id) — or do the work yourself.`
              : "They have no other enabled bot, so there is nobody to hand this to: do the work yourself, or tell them."),
          true,
        );
      }
      if (matches.length > 1) {
        return text(
          `"${wanted}" matches ${matches.length} of this owner's bots: ${matches
            .map((bot) => `${bot.displayName} (id ${bot.id})`)
            .join("; ")}. Call this again with the exact id of the one you mean.`,
          true,
        );
      }
      const target = matches[0];
      if (source.agentId && target.id === source.agentId) {
        return text(DELEGATION_SELF, true);
      }
      // The SAME reach gate a typed turn passes, LIVE — the roster read above
      // is not the boundary (the owner's admin role can be gone this instant).
      const targetAvatarId = personalAgentAvatarId(owner.id, target.id);
      if (!findChattablePersonalAgent(store, owner.id, targetAvatarId)) {
        return text(
          `"${target.displayName}" cannot take delegated work right now — it was disabled or deleted, or personal bots are no longer available to this owner. Tell the owner instead of retrying.`,
          true,
        );
      }

      // Land in the thread the owner already has with that bot, so a hand-off
      // reads as part of their conversation rather than a thread per delegation.
      const conversationId =
        store.latestChatConversationIdForAvatar(owner.id, targetAvatarId) ??
        crypto.randomUUID();
      if (store.countQueuedBotTasks(conversationId) >= MAX_QUEUED_BOT_TASKS) {
        return text(
          `"${target.displayName}" already has ${MAX_QUEUED_BOT_TASKS} requests waiting in its queue, which is the limit — tell the owner instead of stacking more onto it.`,
          true,
        );
      }

      // Korean, USER-facing: this is the message the owner reads in the target
      // bot's thread, so it must name who handed the work over.
      const sourceLabel = source.agentId
        ? (store.getPersonalAgentById(source.agentId)?.displayName ?? "봇")
        : "아바타";
      const message = `[${sourceLabel} 위임] ${request}`;
      // The enqueue recipe queueBotTurn uses: persist the user turn, queue the
      // task, poke the dispatcher.
      store.touchConversation(owner.id, conversationId, targetAvatarId, message);
      // QUEUED, busy thread or not: the dispatcher runs it only after whatever
      // holds the thread now — and an owner turn can start ahead of it — so
      // rows after it need not be its own run's output, and it can never
      // anchor a rewind (the chat route's queueBotTurn rule).
      store.addMessage(conversationId, { role: "user", content: message, kind: "queued" });
      const task = store.createBotTask({
        ownerUserId: owner.id,
        agentId: target.id,
        conversationId,
        title: botTaskTitle(request),
        requestText: message,
        status: "queued",
        // NULL for a main-avatar hand-off; the depth is what says a task was
        // delegated at all.
        delegatedByAgentId: source.agentId,
        delegationDepth: nextDepth,
      });
      handedOff += 1;
      store.audit({
        actorUserId: owner.id,
        actorName: owner.username,
        action: "personal_agent_delegate",
        status: "success",
        detail: `from=${source.agentId ?? "avatar"} to=${target.id} (${target.displayName}) task=${task.id} depth=${nextDepth} via delegate_to_bot`,
      });
      requestBotTaskDispatch(owner.id, conversationId);
      return text(
        `Handed off to "${target.displayName}" — task ${task.id}, QUEUED on that bot's own thread. ` +
          "The server runs it unattended with the owner's full capability, and they follow it on their 봇 오피스 board; the result lands THERE, never in this conversation, so do not wait for it or claim it is done. " +
          "Tell the owner what you handed off and why in your final reply. " +
          "The target bot cannot see this conversation: if it needs context, you did not include enough in `request`.",
      );
    },
  );
}

/**
 * The bot's own profile tool, exposed separately from the server so tests can
 * exercise the handler directly (the sibling group factories' pattern).
 */
export function buildPersonalAgentSelfTools(
  store: Store,
  ctx: PersonalAgentSelfToolsContext,
) {
  return [
    tool(
      "update_profile",
      `**Use this tool when your owner asks you to change your role, persona, or profile** (e.g. "from now on you are my release-notes bot"). It updates THIS bot — you — for every future conversation the owner has with you, so CONFIRM the wording with them before calling; never change your own persona unprompted. Changes take effect from the NEXT turn (this turn keeps running on the current profile). Omitted fields keep their value; pass an empty string to clear one. (this bot's owner only)`,
      {
        persona: z
          .string()
          .optional()
          .describe(
            "New persona / standing instructions: the role, tone, and priorities you should follow in every conversation with this owner.",
          ),
        alias: z
          .string()
          .optional()
          .describe("What you call yourself in chat (max 64 chars)."),
        bio: z
          .string()
          .optional()
          .describe("One-line description shown in discovery (max 200 chars)."),
        intro: z
          .string()
          .optional()
          .describe(
            "Self-introduction shown in the avatar introduction dialog on the explore page.",
          ),
      },
      async (args) => {
        const refusal = selfToolRefusal(store, ctx);
        if (refusal) return text(refusal, true);
        const patch: Partial<Record<ProfileField, string>> = {};
        for (const field of PROFILE_FIELDS) {
          const value = args[field];
          if (value === undefined) continue;
          if (value.length > FIELD_CAPS[field]) {
            return text(overCap(field, FIELD_CAPS[field], value.length), true);
          }
          patch[field] = value;
        }
        const changed = Object.keys(patch);
        if (changed.length === 0) return text(EMPTY_PATCH, true);
        // displayName is never patched here, so the store's name throw is
        // unreachable; null = the bot was deleted between the read and now.
        const updated = store.updatePersonalAgent(ctx.agentId, patch);
        if (!updated) return text(AGENT_GONE, true);
        store.audit({
          actorUserId: ctx.owner.id,
          actorName: ctx.owner.username,
          action: "personal_agent_update",
          status: "success",
          detail: `agent=${ctx.agentId} self-config via update_profile (${changed.join(", ")})`,
        });
        return text(
          `Updated your ${changed.join(", ")}. The change applies to every future conversation with this bot and takes effect from the NEXT turn — this turn still runs on the previous profile.`,
        );
      },
    ),
    tool(
      "report_task",
      `**Call this near the end of EVERY delegated-task turn in this conversation**, before writing your final reply: outcome 'done' with a short result summary when the request is complete, or 'need_input' with the blocking question when you cannot proceed without the owner. It updates the task card the owner sees. After 'need_input', END your turn with that question in your reply — the owner's next message resumes the task. (this bot's owner only)`,
      {
        outcome: z
          .enum(["done", "need_input"])
          .describe(
            "'done' = the delegated request is finished. 'need_input' = you are blocked on something only the owner can decide or supply.",
          ),
        summary: z
          .string()
          .describe(
            "For 'done': 1-3 sentences on WHAT you accomplished (Korean is fine — the owner reads this on the task card). For 'need_input': the single decisive question you need answered.",
          ),
      },
      async (args) => {
        const refusal = selfToolRefusal(store, ctx);
        if (refusal) return text(refusal, true);
        // No card to write against: an untracked turn (a greeting, or a thread
        // older than task tracking). Redirect rather than fail the turn — the
        // tool is registered on EVERY bot run, so this is a normal outcome.
        if (!ctx.taskId) return text(NO_TRACKED_TASK, true);
        if (args.summary.length > REPORT_SUMMARY_CAP) {
          return text(
            overCap("summary", REPORT_SUMMARY_CAP, args.summary.length),
            true,
          );
        }
        const summary = args.summary.trim();
        if (!summary) return text(EMPTY_REPORT_SUMMARY, true);
        // Null = the task left 'running' (aborted, already finalized, or never
        // dispatched). The store owns that guard; nothing is retried here.
        const updated = store.setBotTaskReport(ctx.taskId, {
          outcome: args.outcome,
          summary,
        });
        if (!updated) return text(TASK_NOT_RUNNING, true);
        store.audit({
          actorUserId: ctx.owner.id,
          actorName: ctx.owner.username,
          action: "personal_agent_task_report",
          status: "success",
          detail:
            `agent=${ctx.agentId} task=${ctx.taskId} outcome=${args.outcome} via report_task` +
            (ctx.conversationId ? ` (conversation=${ctx.conversationId})` : ""),
        });
        return text(
          args.outcome === "done"
            ? "Recorded. The task will be marked complete when this turn ends — make sure your final reply also contains the full answer, not just a pointer to this summary."
            : "Recorded — the task will show 입력 대기 (waiting for input) when this turn ends. Now END your turn with that question addressed to the owner; their next message in this conversation resumes the task. Do not keep working past the question.",
        );
      },
    ),
    // Same live gate as the two above, and the same tracked task — its
    // delegationDepth is what caps the chain this bot may extend.
    buildDelegateToBotTool(store, ctx.owner, {
      agentId: ctx.agentId,
      taskId: ctx.taskId,
      guard: () => selfToolRefusal(store, ctx),
    }),
    tool(
      "adopt_skill",
      `**Use this when the owner asks you to take on, borrow, or start using one of THEIR skills** (e.g. "code-review 스킬 너도 써", "use my release-notes skill from now on"). You start with NO skills at all: the owner's knowledge-repo skills reach you only through this grant, one at a time. It is a LIVE reference into their \`skills/<name>/\` directory — nothing is copied, so their later edits reach you too. ${SKILL_CHANGE_TIMING} Confirm WHICH skill with the owner if they were vague; a bot may hold at most ${MAX_PERSONAL_AGENT_SKILLS}. (this bot's owner only)`,
      {
        slug: z
          .string()
          .describe(
            "The exact `skills/<name>` directory name in the owner's knowledge repository — not a title or a description.",
          ),
      },
      async (args) => {
        const refusal = selfToolRefusal(store, ctx);
        if (refusal) return text(refusal, true);
        const wanted = args.slug.trim();
        if (!wanted) return text(EMPTY_SKILL_SLUG, true);
        // The same slug rule the settings route enforces, reused rather than
        // re-derived, so one surface can never accept what the other rejects.
        const shape = normalizePersonalAgentSkills([wanted]);
        if (!shape.ok) return text(skillSelectionRefusal(shape), true);
        const slug = shape.slugs[0];

        const roster = await ownerSkillRoster(store, ctx.owner.id, ctx.config);
        if (!roster.ok) return text(roster.message, true);
        if (!roster.slugs.includes(slug)) {
          return text(
            `The owner's knowledge repository has no skill named "${slug}". ${rosterLine(roster.slugs)} Ask the owner which one they meant — do not guess a similar name.`,
            true,
          );
        }
        // Re-read the row: the roster fetch above cloned a repo, which is long
        // enough for the owner to have changed the grants in settings.
        const current = store.getPersonalAgentById(ctx.agentId);
        if (!current) return text(AGENT_GONE, true);
        if (current.selectedSkills.includes(slug)) {
          return text(
            `You already have "${slug}" — nothing changed. ${grantedLine(current.selectedSkills)} It loads from your next conversation onward.`,
          );
        }
        const next = [...current.selectedSkills, slug];
        if (next.length > MAX_PERSONAL_AGENT_SKILLS) {
          return text(
            `You already hold ${current.selectedSkills.length} skills, which is the limit of ${MAX_PERSONAL_AGENT_SKILLS}. Ask the owner which one to drop first (drop_skill), then adopt this one.`,
            true,
          );
        }
        const updated = store.updatePersonalAgent(ctx.agentId, {
          selectedSkills: next,
        });
        if (!updated) return text(AGENT_GONE, true);
        store.audit({
          actorUserId: ctx.owner.id,
          actorName: ctx.owner.username,
          action: "personal_agent_update",
          status: "success",
          detail: `agent=${ctx.agentId} adopt_skill slug=${slug}`,
        });
        return text(
          `Adopted "${slug}" from the owner's knowledge repository. ${grantedLine(updated.selectedSkills)} ` +
            `${SKILL_CHANGE_TIMING} Tell the owner that plainly — do not act as though you can already follow it in this conversation.`,
        );
      },
    ),
    tool(
      "drop_skill",
      `**Use this when the owner asks you to stop using, give back, or forget one of your skills** (e.g. "그 스킬은 이제 빼", "you don't need the deploy skill anymore"). It removes the grant only — the skill itself stays untouched in the owner's knowledge repository, so it can be adopted again later. ${SKILL_CHANGE_TIMING} (this bot's owner only)`,
      {
        slug: z
          .string()
          .describe("The `skills/<name>` directory name to stop loading."),
      },
      async (args) => {
        const refusal = selfToolRefusal(store, ctx);
        if (refusal) return text(refusal, true);
        const slug = args.slug.trim();
        if (!slug) return text(EMPTY_SKILL_SLUG, true);
        const current = store.getPersonalAgentById(ctx.agentId);
        if (!current) return text(AGENT_GONE, true);
        // NOT an error: "stop using X" when X was never granted is already the
        // state the owner asked for, so say so instead of failing the turn.
        if (!current.selectedSkills.includes(slug)) {
          return text(
            `"${slug}" was not one of your skills, so there is nothing to drop. ${grantedLine(current.selectedSkills)}`,
          );
        }
        const updated = store.updatePersonalAgent(ctx.agentId, {
          selectedSkills: current.selectedSkills.filter((s) => s !== slug),
        });
        if (!updated) return text(AGENT_GONE, true);
        store.audit({
          actorUserId: ctx.owner.id,
          actorName: ctx.owner.username,
          action: "personal_agent_update",
          status: "success",
          detail: `agent=${ctx.agentId} drop_skill slug=${slug}`,
        });
        return text(
          `Dropped "${slug}". ${grantedLine(updated.selectedSkills)} ` +
            `The skill itself is untouched in the owner's repository. ${SKILL_CHANGE_TIMING}`,
        );
      },
    ),
  ];
}

/** The owner's bot-creation tool (non-bot owner runs), exposed for tests. */
export function buildPersonalAgentOwnerTools(
  store: Store,
  ctx: PersonalAgentOwnerToolsContext,
) {
  return [
    tool(
      "create_agent",
      `**Use this tool when the owner asks you to create a new personal bot / teammate of their own** (e.g. "make me a bot that only does release notes", "내 봇 하나 만들어줘"). It creates a NEW chat contact owned by them — a separate conversation partner with its own name and persona, running with the owner's own capability — and it becomes chattable immediately. Ask for the name first if they did not give one; up to ${MAX_PERSONAL_AGENTS} bots per owner. A new bot starts with NO skills, so pass \`skills\` when the owner names one in the same breath ("코딩봇 만들고 code-review 스킬 줘"). Editing an existing bot is NOT done here: the owner edits it in 설정 → 내 봇, or asks the bot itself in ITS conversation. (owner only, administrators only)`,
      {
        display_name: z
          .string()
          .describe(
            `The bot's name, as the owner wants it listed (max ${PERSONAL_AGENT_DISPLAY_NAME_CAP} chars). Required.`,
          ),
        alias: z
          .string()
          .optional()
          .describe("What the bot calls itself in chat (max 64 chars)."),
        bio: z
          .string()
          .optional()
          .describe("One-line description shown in discovery (max 200 chars)."),
        intro: z
          .string()
          .optional()
          .describe(
            "Self-introduction shown in the avatar introduction dialog on the explore page.",
          ),
        persona: z
          .string()
          .optional()
          .describe(
            "Persona / standing instructions for the new bot: role, tone, priorities. Draft it from what the owner described.",
          ),
        skills: z
          .array(z.string())
          .optional()
          .describe(
            `Knowledge-repo skills the new bot may load, as exact \`skills/<name>\` directory names from the OWNER's repository (max ${MAX_PERSONAL_AGENT_SKILLS}). Omit it and the bot starts with none; the owner can grant more later by asking the bot itself.`,
          ),
      },
      async (args) => {
        // Live admin re-check: registration is not the boundary (the mcp__
        // auto-allow), and the role can be revoked mid-conversation.
        if (!store.isAdmin(ctx.owner.id)) return text(ADMIN_FEATURE_OFF, true);
        const displayName = args.display_name.trim();
        if (!displayName) {
          return text(
            "The bot needs a name — ask the owner what to call it, then call this again with display_name.",
            true,
          );
        }
        if (displayName.length > PERSONAL_AGENT_DISPLAY_NAME_CAP) {
          return text(
            overCap(
              "display_name",
              PERSONAL_AGENT_DISPLAY_NAME_CAP,
              displayName.length,
            ),
            true,
          );
        }
        const profile: Partial<Record<ProfileField, string>> = {};
        for (const field of PROFILE_FIELDS) {
          const value = args[field];
          if (value === undefined) continue;
          if (value.length > FIELD_CAPS[field]) {
            return text(overCap(field, FIELD_CAPS[field], value.length), true);
          }
          profile[field] = value;
        }
        // Skills are checked against the owner's REAL tree before the row is
        // written: a bot born holding a slug that does not exist would look
        // configured and load nothing. Only paid for when skills were asked for.
        const requested =
          args.skills === undefined
            ? { ok: true as const, slugs: [] as string[] }
            : normalizePersonalAgentSkills(args.skills);
        if (!requested.ok) return text(skillSelectionRefusal(requested), true);
        if (requested.slugs.length > 0) {
          const roster = await ownerSkillRoster(
            store,
            ctx.owner.id,
            ctx.config,
          );
          if (!roster.ok) return text(roster.message, true);
          const unknown = requested.slugs.filter(
            (slug) => !roster.slugs.includes(slug),
          );
          if (unknown.length > 0) {
            return text(
              `The owner's knowledge repository has no skill named ${unknown.map((slug) => `"${slug}"`).join(", ")}. ${rosterLine(roster.slugs)} Create the bot without that skill, or ask the owner which one they meant.`,
              true,
            );
          }
        }
        try {
          const agent = store.createPersonalAgent(ctx.owner.id, {
            displayName,
            ...profile,
            selectedSkills: requested.slugs,
          });
          store.audit({
            actorUserId: ctx.owner.id,
            actorName: ctx.owner.username,
            action: "personal_agent_create",
            status: "success",
            detail:
              `agent=${agent.id} (${agent.displayName}) via create_agent` +
              (agent.selectedSkills.length > 0
                ? ` skills=${agent.selectedSkills.join(",")}`
                : ""),
          });
          return text(
            `Created the personal bot "${agent.displayName}"${agent.alias ? ` (alias "${agent.alias}")` : ""} — id ${agent.id}. ` +
              `The owner now has ${store.countPersonalAgents(ctx.owner.id)} of ${MAX_PERSONAL_AGENTS} bots. ` +
              "Tell them it is chattable RIGHT NOW: it appears in 탐색 and in the '내 봇' section of the left rail, and opening it starts a conversation with the new bot. " +
              (agent.selectedSkills.length > 0
                ? `It carries the owner's ${agent.selectedSkills.join(", ")} skill(s) from its very first conversation. `
                : "It carries no skills yet — the owner can grant one by asking the bot itself, or in 설정 → 내 봇. ") +
              (profile.persona
                ? "Its persona is already set; to change it later they can ask the bot itself in its own conversation, or edit it in 설정 → 내 봇."
                : "It has no persona yet — they can give it one by asking the bot itself in its own conversation, or in 설정 → 내 봇."),
          );
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (code === "PERSONAL_AGENT_LIMIT") {
            return text(
              `The owner already has the maximum of ${MAX_PERSONAL_AGENTS} personal bots, so no new one can be created. Suggest they delete or repurpose one in 설정 → 내 봇 first.`,
              true,
            );
          }
          if (code === "INVALID_PERSONAL_AGENT_NAME") {
            return text(
              "The bot needs a non-empty name — ask the owner what to call it, then call this again with display_name.",
              true,
            );
          }
          throw error;
        }
      },
    ),
    // The owner's own avatar hands work to a NAMED bot when they ask for it.
    // No source bot and no tracked task: a main-avatar hand-off always opens a
    // chain at hop 1. Its live gate is create_agent's — the admin feature gate.
    buildDelegateToBotTool(store, ctx.owner, {
      agentId: null,
      guard: () => (store.isAdmin(ctx.owner.id) ? null : ADMIN_FEATURE_OFF),
    }),
  ];
}

/** Build the in-process MCP server for a PERSONAL-AGENT run's self-configuration. */
export function buildPersonalAgentSelfServer(
  store: Store,
  ctx: PersonalAgentSelfToolsContext,
) {
  return createSdkMcpServer({
    name: PERSONAL_AGENT_SERVER_NAME,
    version: "0.1.0",
    tools: buildPersonalAgentSelfTools(store, ctx),
  });
}

/**
 * Build the in-process MCP server for an OWNER run's bot creation. Shares the
 * server NAME with the self server above — the two never coexist (one needs a
 * bot run, the other a non-bot run; see runPlan's mutually exclusive gates).
 */
export function buildPersonalAgentOwnerServer(
  store: Store,
  ctx: PersonalAgentOwnerToolsContext,
) {
  return createSdkMcpServer({
    name: PERSONAL_AGENT_SERVER_NAME,
    version: "0.1.0",
    tools: buildPersonalAgentOwnerTools(store, ctx),
  });
}
