import path from "node:path";
import type { AgentEvents } from "./events.js";
import { MAIN_AGENT_ID } from "./events.js";
import logger from "../logger.js";
import {
  DEFAULT_HEX_SSH_TOOL_POLICY,
  extractHexSshToolName,
  isHexSshToolAllowed,
  type HexSshToolPolicy,
  type HexSshViewerClass,
} from "../hexSshPolicy.js";
import { asString, isRecord, truncate, TOOL_TRACE_ENABLED } from "./agentUtils.js";
import {
  SDK_INTERNAL_HIDDEN_TOOLS,
  SDK_ORCHESTRATION_TOOLS,
  SDK_SUBAGENT_TOOLS,
  SDK_TEAM_TOOLS,
  SDK_WORKFLOW_TOOLS,
} from "../../shared/sdkToolPresentation.js";
import {
  DEFAULT_TOOL_SKILL_POLICY,
  type ToolSkillPolicy,
} from "../toolSkillPolicy.js";

const agentLogger = logger.child({ module: "agent" });

/**
 * File types the SDK `Read` tool turns into image content blocks (rasters, and
 * PDFs which are rendered to page images) — exactly what a text-only backend
 * rejects. SVG stays readable: it is text/XML.
 */
const NO_VISION_READ_BLOCKED = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic|heif|avif|pdf)$/i;

/**
 * SDK orchestration tools that should never trigger the user permission modal.
 * Includes the agent-teams coordination tools (SendMessage): messaging a
 * teammate is meta-work like spawning one (Agent is already here) — the
 * teammate's OWN tool calls still hit this hook individually. Also includes
 * `Workflow` (ultracode): launching a workflow is meta-work too — it always
 * returns `status: "async_launched"` and never blocks on the spawned agents,
 * so there is nothing here to gate. Those agents' OWN tool calls still hit
 * this hook (or, per SUBAGENT_SPAWN_TOOLS below, don't — Workflow has no
 * foreground lever to dodge that gap the way Task/Agent do). The admin
 * disabledTools policy check runs BEFORE the auto-allow, so an admin can still
 * turn team messaging or workflows off.
 */
export const TASK_ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set([
  ...SDK_ORCHESTRATION_TOOLS,
  ...SDK_TEAM_TOOLS,
  ...SDK_WORKFLOW_TOOLS,
]);
const AUTO_ALLOWED_META_TOOLS: ReadonlySet<string> = new Set(["Skill", ...SDK_INTERNAL_HIDDEN_TOOLS]);

/**
 * Subagent spawns (Task/Agent) are forced to the FOREGROUND — including a spawn
 * that OMITS `run_in_background`, because the CLI's default for an omitted flag
 * is background (every flagless spawn in the transcripts ran async, 2.1.222
 * through 2.1.283). The rewrite dates from 2.1.222, where a background
 * subagent's tool calls ran outside this gate entirely (no SDK-callback hooks,
 * no canUseTool, not even `allowedTools`) and every permission-needing call was
 * auto-denied with user-refusal wording (claude-code #34692, #27661). The
 * bundled 2.1.283 closed that gap — this hook fires for a background subagent's
 * calls with its `agent_id`, and a deny is honored (measured) — but the rewrite
 * stays: a foreground spawn keeps the turn open and steerable, answers in the
 * same bubble, and matches what the prompt promises, while the parked asks (a
 * question or permission raised after the visible turn ended) are still
 * unverified for background subagents. Agents that run in the background anyway
 * (a SendMessage resume, teammates, remote agents) are rendered from their task
 * events in sdkMessageHandlers. Bash keeps `run_in_background`: a running shell
 * makes no further tool calls, so backgrounding it never bypasses the gate.
 */
const SUBAGENT_SPAWN_TOOLS: ReadonlySet<string> = new Set(SDK_SUBAGENT_TOOLS);

/**
 * Tools that run without a permission prompt: read-only built-ins, any MCP tool
 * (only the in-process knowledge server is configured), and orchestration
 * meta-tools. Everything else is gated by the PreToolUse hook.
 */
function isAutoAllowed(toolName: string, readOnlyTools: string[]): boolean {
  if (readOnlyTools.includes(toolName)) return true;
  if (toolName.startsWith("mcp__")) return true;
  return AUTO_ALLOWED_META_TOOLS.has(toolName) || TASK_ORCHESTRATION_TOOLS.has(toolName);
}

/** Render a question answer (from the client) into text the model can read. */
function formatQuestionAnswer(result: unknown): string {
  if (!isRecord(result)) {
    return "The user provided an answer.";
  }
  const answers = isRecord(result.answers) ? result.answers : {};
  const lines = Object.entries(answers).map(([q, a]) => `- "${q}" → ${asString(a) || String(a)}`);
  return lines.length
    ? `The user answered the question(s) as follows:\n${lines.join("\n")}`
    : "The user provided an answer.";
}

/**
 * The dialog's answers in the shape AskUserQuestion's own input carries them
 * (`answers`: question text → answer, multi-select comma-joined, which is what
 * the question modal submits). Null when the payload holds no usable answer.
 */
function questionAnswers(result: unknown): Record<string, string> | null {
  if (!isRecord(result) || !isRecord(result.answers)) {
    return null;
  }
  const entries = Object.entries(result.answers)
    .map(([question, value]): [string, string] => [
      question,
      Array.isArray(value) ? value.map(String).join(", ") : asString(value) || (value == null ? "" : String(value)),
    ])
    .filter(([question, value]) => question && value);
  return entries.length ? Object.fromEntries(entries) : null;
}

/** Shallow copy with long string fields capped, so we never ship huge inputs to the client. */
function safeToolInput(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = typeof value === "string" ? truncate(value, 2000) : value;
  }
  return out;
}

type HookOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
};
const hookAllow = (updatedInput?: Record<string, unknown>): HookOutput => {
  const hookSpecificOutput: HookOutput["hookSpecificOutput"] = {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
  };
  if (updatedInput) {
    hookSpecificOutput.updatedInput = updatedInput;
  }
  return { hookSpecificOutput };
};
const hookDeny = (reason: string): HookOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});

/**
 * Tools whose own permission check may still ASK after this hook allowed them:
 * leaving plan mode is an approval built into ExitPlanMode, so the CLI routes
 * it to the SDK's `canUseTool` even on a hook `allow` (measured on the bundled
 * CLI 2.1.283 — unconfirmed, the model stays stuck in plan mode).
 * AskUserQuestion rides along defensively: 2.1.283 runs a hook-allowed call
 * that already carries its `answers` without asking (measured), but a CLI that
 * does ask must get the hook's answers back rather than a deny.
 */
const HOOK_CONFIRMED_TOOLS: ReadonlySet<string> = new Set(["ExitPlanMode", "AskUserQuestion"]);

/**
 * One run's record of the hook's allows that `canUseTool` may be asked to
 * confirm. Only HOOK_CONFIRMED_TOOLS are recorded; a confirmation consumes it.
 */
export interface HookApprovalLedger {
  record(toolName: string, toolUseId: string, updatedInput?: Record<string, unknown>): void;
  take(toolName: string, toolUseId: string): { updatedInput?: Record<string, unknown> } | null;
}

export function createHookApprovalLedger(): HookApprovalLedger {
  const allowed = new Map<string, Record<string, unknown> | undefined>();
  return {
    record(toolName, toolUseId, updatedInput) {
      if (toolUseId && HOOK_CONFIRMED_TOOLS.has(toolName)) {
        allowed.set(toolUseId, updatedInput);
      }
    },
    take(toolName, toolUseId) {
      if (!HOOK_CONFIRMED_TOOLS.has(toolName) || !allowed.has(toolUseId)) {
        return null;
      }
      const updatedInput = allowed.get(toolUseId);
      allowed.delete(toolUseId);
      return { updatedInput };
    },
  };
}

type CanUseToolResult =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

/**
 * The SDK `canUseTool` callback — a CONFIRMER, never a second gate. Its main
 * job is to EXIST: with it the SDK passes `--permission-prompt-tool stdio`.
 * Without that route the CLI (since somewhere in 2.1.186–2.1.220) hides
 * AskUserQuestion, EnterPlanMode and ExitPlanMode from a non-interactive
 * session. The hook above still decides every call. The CLI lands here only
 * when its OWN policy still asks after the hook allowed. It confirms exactly
 * the ExitPlanMode / AskUserQuestion call the hook allowed and denies everything
 * else, which is how those asks ended before this route existed. One example is the CLI's
 * safety check on a write to `.claude/settings.json`; approving that here would
 * bypass the CLI's own guard.
 */
export function buildCanUseToolSafetyNet(approvals: HookApprovalLedger) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    options: { toolUseID?: string; agentID?: string; decisionReason?: string },
  ): Promise<CanUseToolResult> => {
    const agentId = options.agentID || MAIN_AGENT_ID;
    const approved = approvals.take(toolName, asString(options.toolUseID));
    if (approved) {
      agentLogger.info({ toolName, agentId }, "canUseTool confirmed a hook-allowed call");
      return { behavior: "allow", updatedInput: approved.updatedInput ?? input };
    }
    const reason = asString(options.decisionReason);
    agentLogger.info({ toolName, agentId, reason }, "canUseTool ask denied (no approval route)");
    return {
      behavior: "deny",
      message:
        `This call needs an interactive approval that this session cannot grant${reason ? ` (${reason})` : ""}, so it was not run. ` +
        "Do not retry it the same way; if it is essential, tell the user what you need instead.",
    };
  };
}

/**
 * The single tool gate. Fires before every tool call (main thread + subagents),
 * can block, and can await the user. See the runClaudeAgent doc comment for why
 * this is the gate and `canUseTool` only confirms (buildCanUseToolSafetyNet).
 */
/**
 * Git subcommands that change branches/destructively mutate the tree or touch the
 * remote. In an active repo workspace (#47) these are blocked in Bash — NOT for
 * security (the shell has no git credentials, so remote ops fail anyway) but for
 * integrity: sync/push stay app-managed. Local staging + normal commit are
 * intentionally allowed so the avatar can use the repo cwd as a normal working tree. This
 * denylist is advisory and deliberately leaky (`git -C`, aliases, `.git/` writes
 * can evade it) — the real boundary is token-stripping, so we don't over-invest
 * in a perfect parser.
 */
// Only unambiguously tree/state-mutating or remote subcommands. Subcommands with
// a common read-only form (`git branch`/`tag` list, `git remote -v`,
// `git stash list`, `git config --get`) are deliberately omitted so inspection
// isn't over-blocked — the prompt's allow-list steers the avatar, and this
// denylist is an advisory integrity guard, not a security boundary.
const BLOCKED_ACTIVE_REPO_GIT_SUBCOMMANDS = [
  "reset", "checkout", "switch", "merge", "rebase", "cherry-pick",
  "revert", "restore", "clean", "rm", "mv",
  "push", "pull", "fetch", "clone", "am", "apply",
];
// Matches a `git <subcommand>` invocation (optionally wrapped by rtk and/or
// `-C <dir>`) anywhere in the command string, capturing the subcommand.
const GIT_SUBCOMMAND_RE = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:rtk\s+(?:proxy\s+)?)?git(?:\s+-C\s+\S+)*\s+(${BLOCKED_ACTIVE_REPO_GIT_SUBCOMMANDS.join("|")})\b`,
  "i",
);
const GIT_COMMIT_AMEND_RE = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:rtk\s+(?:proxy\s+)?)?git(?:\s+-C\s+\S+)*\s+commit\b(?=[^;&|)]*\s--amend(?:\s|$|[;&|)]))`,
  "i",
);

function stateChangingGitInBash(command: string): string | null {
  if (GIT_COMMIT_AMEND_RE.test(command)) {
    return "commit --amend";
  }
  const match = GIT_SUBCOMMAND_RE.exec(command);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Native file-mutation tools addressed by a path argument — the ones the
 * knowledge-clone guard below can resolve. Bash is deliberately absent: parsing
 * a shell command for write targets is the leaky game the active-repo denylist
 * already declines to play, and this is an integrity guard, not a boundary.
 */
const NATIVE_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "FileWrite",
  "FileEdit",
  "NotebookEdit",
]);

/**
 * A personal-bot (내 봇) run's knowledge-clone write scope. A bot run IS a full
 * owner run, so its native tools can reach the owner's knowledge clone on disk
 * even though every `mcp__repo__*` op is confined to the bot's memory folder.
 * This keeps the two paths consistent: same folder, and edits keep flowing
 * through the repo tools so they are staged and committed.
 */
export interface PersonalAgentWriteScope {
  /** Absolute path of the OWNER's knowledge-repo clone. */
  clonePath: string;
  /** Repo-relative memory root (`agents/<dir>`, no trailing slash). */
  memoryRoot: string;
}

/** True when `target` IS `dir` or lives under it (both already resolved). */
function isUnderDir(target: string, dir: string): boolean {
  return target === dir || target.startsWith(dir + path.sep);
}

export function buildPreToolUseHook(
  events: AgentEvents,
  elevated: boolean,
  readOnlyTools: string[],
  headless: boolean,
  allowHeadlessTools: boolean,
  autoApprove: boolean,
  hexSshViewerClass: HexSshViewerClass = "colleague",
  hexSshPolicy: HexSshToolPolicy = DEFAULT_HEX_SSH_TOOL_POLICY,
  activeRepoMode = false,
  toolSkillPolicy: ToolSkillPolicy = DEFAULT_TOOL_SKILL_POLICY,
  visionEnabled = true,
  // Personal-bot (내 봇) run: the question DIALOG is replaced by the
  // turn-boundary protocol below. Last parameter with a default so the existing
  // positional call sites (and the test suites that build the hook directly)
  // stay valid. A scope OBJECT additionally confines native file writes to the
  // bot's own memory folder — ONE parameter carries the run kind, so the two
  // bot behaviors can never disagree about whether this is a bot run.
  personalAgentRun: boolean | PersonalAgentWriteScope = false,
  // The run's ledger shared with buildCanUseToolSafetyNet: every allow passes
  // through `trace()` below, which records the ones the CLI may still ask about.
  approvals?: HookApprovalLedger,
) {
  const personalAgentRunning = Boolean(personalAgentRun);
  const botWriteScope =
    typeof personalAgentRun === "object" ? personalAgentRun : null;
  return async (
    input: { tool_name?: string; tool_input?: unknown; tool_use_id?: string; agent_id?: string },
    toolUseID?: string,
  ): Promise<HookOutput> => {
    const toolName = asString(input.tool_name);
    let toolInput = isRecord(input.tool_input) ? input.tool_input : {};
    const toolUseId = toolUseID || asString(input.tool_use_id);
    const agentId = asString(input.agent_id) || MAIN_AGENT_ID;

    // Opt-in (AGENT_TOOL_TRACE) lifecycle trace: log that the hook fired for this
    // tool call, then pass every return through `trace()` so the decision is
    // logged too. The pair answers "did the announced tool call reach dispatch,
    // and what did the gate decide?" — the key question when a vLLM-style backend
    // emits a tool_use that never executes. No-op unless the flag is set.
    if (TOOL_TRACE_ENABLED) {
      agentLogger.info({ trace: "tool", toolName, toolUseId, agentId }, "trace: PreToolUse hook entry");
    }
    const trace = (out: HookOutput): HookOutput => {
      if (TOOL_TRACE_ENABLED) {
        agentLogger.info(
          { trace: "tool", toolName, toolUseId, agentId, decision: out.hookSpecificOutput.permissionDecision },
          "trace: PreToolUse hook decision",
        );
      }
      if (out.hookSpecificOutput.permissionDecision === "allow") {
        approvals?.record(toolName, toolUseId, out.hookSpecificOutput.updatedInput);
      }
      return out;
    };

    // AskUserQuestion: surface the question, await the answer, and hand it back
    // by ALLOWING the call with the collected `answers` in updatedInput — the
    // tool then returns them as its own ordinary result ("Your questions have
    // been answered: …", measured on the bundled CLI 2.1.283). onUserDialog never
    // fires headlessly. The older carrier, a deny whose reason held the answer,
    // reached the model as a "PreToolUse:AskUserQuestion hook error" (is_error),
    // so it survives only for a payload without usable answers.
    if (toolName === "AskUserQuestion") {
      // Personal-bot conversations answer questions at the TURN BOUNDARY, never
      // through a modal: a delegated turn may have been dispatched from the
      // queue with the owner away, and a parked dialog would hang it until the
      // hook budget expires. Interactive and queued bot turns follow the SAME
      // protocol — one shape for the owner to read on the task card. This runs
      // BEFORE the headless check because a bot run is normally interactive.
      if (personalAgentRunning) {
        agentLogger.info({ toolName, agentId }, "personal-bot question redirected to report_task");
        return trace(
          hookDeny(
            "In a personal-bot conversation, never block on an interactive question dialog — the owner may be away and delegated turns can run unattended. " +
              "Instead: (1) call mcp__personal_agent__report_task with outcome 'need_input' and the blocking question as the summary, then (2) END your turn with that question in your reply text. " +
              "The owner's next message resumes the work.",
          ),
        );
      }
      if (headless || !events.onQuestion) {
        return trace(
          hookDeny(
            headless
              ? "During a scheduled automated run you cannot ask the user questions. Proceed with reasonable assumptions."
              : "The question feature is unavailable.",
          ),
        );
      }
      const questions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const answer = await events.onQuestion({ dialogKind: "AskUserQuestion", payload: { questions }, toolUseId });
      if (answer.behavior !== "completed") {
        return trace(hookDeny("The user did not answer the question (cancelled). Proceed without an answer."));
      }
      const answers = questionAnswers(answer.result);
      return trace(answers ? hookAllow({ ...toolInput, answers }) : hookDeny(formatQuestionAnswer(answer.result)));
    }

    // ExitPlanMode: the avatar finished planning and proposed a plan. For a PRESENT
    // owner (interactive, non-auto-approve) we PARK for explicit approval — approve
    // → allow (the avatar proceeds to implement); reject → deny carrying the user's
    // feedback, which the model reads as a tool result and uses to revise the plan
    // before re-proposing. Headless / colleague / auto-approve runs keep the
    // original display-only behavior (fall through to the auto-allow below). An
    // empty plan (degenerate ExitPlanMode) has nothing to approve, so it skips too.
    if (toolName === "ExitPlanMode") {
      const plan = asString((toolInput as Record<string, unknown>).plan);
      const canReview =
        plan && !headless && elevated && !autoApprove && Boolean(events.onPlanReview);
      if (canReview) {
        const decision = await events.onPlanReview!({ plan, toolUseId });
        if (decision.behavior === "approved") {
          return trace(hookAllow());
        }
        const feedback = decision.feedback?.trim();
        return trace(
          hookDeny(
            "The user REJECTED this plan and did NOT approve proceeding." +
              (feedback
                ? ` Their feedback: ${feedback}`
                : " They gave no specific feedback.") +
              " Revise the plan to address this, then call ExitPlanMode again with the" +
              " updated plan. Do NOT begin implementing until a plan is approved.",
          ),
        );
      }
    }

    let updatedToolInput: Record<string, unknown> | undefined;
    // Force subagent spawns foreground — see SUBAGENT_SPAWN_TOOLS. An OMITTED
    // flag counts too: the CLI's own default for a flagless spawn is background.
    if (SUBAGENT_SPAWN_TOOLS.has(toolName) && toolInput.run_in_background !== false) {
      updatedToolInput = { ...toolInput, run_in_background: false };
      toolInput = updatedToolInput;
      agentLogger.info({ toolName, agentId }, "background subagent spawn forced foreground");
    }
    if (toolName === "Bash") {
      // Active repo workspace (#47): block remote/branch/destructive Bash git so
      // sync/push stay app-managed. Read-only git and local add/commit are allowed.
      if (activeRepoMode) {
        const gitSub = stateChangingGitInBash(asString(toolInput.command));
        if (gitSub) {
          const uiReason = `'git ${gitSub}'은(는) 활성 저장소 작업공간에서 셸로 실행할 수 없습니다. 원격/동기화 작업은 mcp__git_repo__* 도구를 사용하고, 위험한 로컬 git 작업은 피하세요.`;
          events.onBlocked?.({ toolUseId, toolName, agentId, uiReason });
          agentLogger.info({ toolName, agentId, gitSub }, "active-repo bash git blocked");
          return trace(hookDeny(
            `Running 'git ${gitSub}' via Bash is not allowed in the active repo workspace. ` +
              "Remote/sync git must go through the mcp__git_repo__* tools (push/sync_repo) because the shell has no git credentials. " +
              "Branch-changing, history-rewriting, or destructive git is blocked to protect the active working tree. " +
              "Read-only git (status/diff/log/show/rev-parse/ls-files/grep) and local staging/normal commit (add/commit) are allowed.",
          ));
        }
      }
    }

    // Personal-bot run: the owner's knowledge clone is edited through the
    // `mcp__repo__*` tools (which are path-scoped to this bot's memory folder
    // and stage/commit what they write). A native Write/Edit into the clone
    // would land outside that scope and outside any commit, so it is denied
    // unless it targets the bot's own folder. Integrity guard like
    // activeRepoMode, not a security boundary: Bash is not parsed.
    if (botWriteScope && NATIVE_FILE_WRITE_TOOLS.has(toolName)) {
      const rawPath =
        asString(toolInput.file_path) || asString(toolInput.notebook_path);
      if (rawPath) {
        const clone = path.resolve(botWriteScope.clonePath);
        // These tools take an ABSOLUTE file_path; a relative one resolves
        // outside the clone and is left to the normal permission path.
        const target = path.resolve(rawPath);
        const memoryDir = path.resolve(clone, botWriteScope.memoryRoot);
        if (isUnderDir(target, clone) && !isUnderDir(target, memoryDir)) {
          const uiReason = `봇의 메모리 폴더(${botWriteScope.memoryRoot}/) 밖의 지식 저장소 파일은 직접 수정할 수 없습니다.`;
          events.onBlocked?.({ toolUseId, toolName, agentId, uiReason });
          agentLogger.info(
            { toolName, agentId, memoryRoot: botWriteScope.memoryRoot },
            "personal-bot knowledge-clone write blocked",
          );
          return trace(
            hookDeny(
              `${toolName} on this path is not allowed: the knowledge repository is edited through the mcp__repo__* tools, and this bot's folder is \`${botWriteScope.memoryRoot}/\`. ` +
                `Write it with mcp__repo__write_file (or edit_file) under \`${botWriteScope.memoryRoot}/\` and push it with mcp__repo__commit — a native write there would neither be staged nor committed. ` +
                "The rest of the owner's knowledge repository is not yours to edit; if something belongs outside your folder, tell the owner instead.",
            ),
          );
        }
      }
    }

    // Non-vision deployment: the active model rejects image input, so a Read
    // on a raster/PDF file would 400 the WHOLE turn at the API layer. Deny
    // early with a redirect instead — this must run BEFORE the read-only
    // auto-allow below (Read is normally auto-approved).
    if (!visionEnabled && toolName === "Read") {
      const filePath = asString(toolInput.file_path);
      if (NO_VISION_READ_BLOCKED.test(filePath)) {
        const uiReason = "현재 모델은 이미지 입력을 지원하지 않아 이미지/PDF 읽기가 차단되었습니다.";
        events.onBlocked?.({ toolUseId, toolName, agentId, uiReason });
        agentLogger.info({ toolName, agentId, filePath }, "no-vision image read blocked");
        return trace(
          hookDeny(
            "The active model cannot accept image input, so Read on image/PDF files is blocked in this deployment. " +
              "Do not retry or try to view the file another way. For a PDF, extract its text with Bash (`pdftotext file.pdf -`). " +
              "To let the USER see an image, publish it with mcp__file_output__show_file — the user can view it even though you cannot.",
          ),
        );
      }
    }

    // Admin tool/skill policy — enforced HERE (the single gate) regardless of
    // what the CLI advertises: a disabled skill can still be listed (stale
    // discovery cache), and `Skill` is otherwise auto-allowed as a meta tool
    // below, so this check must come before the auto-allow.
    if (toolName === "Skill" && toolSkillPolicy.disabledSkills.length > 0) {
      const skillName = asString(toolInput.skill);
      const bareName = skillName.includes(":")
        ? skillName.slice(skillName.lastIndexOf(":") + 1)
        : skillName;
      if (
        skillName &&
        (toolSkillPolicy.disabledSkills.includes(skillName) ||
          toolSkillPolicy.disabledSkills.includes(bareName))
      ) {
        const uiReason = `관리자가 비활성화한 스킬입니다: ${skillName}`;
        events.onBlocked?.({ toolUseId, toolName, agentId, uiReason });
        agentLogger.info({ toolName, agentId, skillName }, "admin-disabled skill blocked");
        return trace(
          hookDeny(
            `The skill '${skillName}' is disabled by the system administrator for this deployment, even if it appears in the skill list. ` +
              "Do not retry it or work around the restriction; if the user asked for it, explain that it is administratively disabled.",
          ),
        );
      }
    }
    if (toolSkillPolicy.disabledTools.includes(toolName)) {
      const uiReason = `관리자가 비활성화한 도구입니다: ${toolName}`;
      events.onBlocked?.({ toolUseId, toolName, agentId, uiReason });
      agentLogger.info({ toolName, agentId }, "admin-disabled tool blocked");
      return trace(
        hookDeny(
          `The built-in tool '${toolName}' is disabled by the system administrator for this deployment. Use the available alternatives instead.`,
        ),
      );
    }

    const hexSshTool = extractHexSshToolName(toolName);
    if (hexSshTool) {
      if (isHexSshToolAllowed(toolName, hexSshViewerClass, hexSshPolicy)) {
        return trace(hookAllow(updatedToolInput));
      }
      const uiReason = `현재 권한에서는 hex-ssh 도구 '${hexSshTool}' 사용이 허용되지 않습니다.`;
      events.onBlocked?.({ toolUseId, toolName, agentId, uiReason });
      agentLogger.info({ toolName, agentId, viewerClass: hexSshViewerClass }, "hex-ssh tool blocked");
      return trace(hookDeny(`The hex-ssh tool '${hexSshTool}' is not permitted at your current permission level.`));
    }

    // Read-only / knowledge / orchestration tools run without a prompt.
    if (isAutoAllowed(toolName, readOnlyTools)) {
      return trace(hookAllow(updatedToolInput));
    }

    const canRunElevatedTools = elevated && (!headless || allowHeadlessTools);

    // Any other tool: a PRESENT elevated viewer (owner or trusted user) may run
    // it; owner-scheduled routines may also run it when they explicitly opt into
    // owner-level headless tools. Plain headless runs and colleagues stay read-only.
    // Auto-approval opted in: run the tool without prompting.
    if (canRunElevatedTools && autoApprove) {
      return trace(hookAllow(updatedToolInput));
    }
    if (!headless && elevated && events.onPermission) {
      const decision = await events.onPermission({
        toolUseId,
        toolName,
        input: safeToolInput(toolInput),
        agentId,
      });
      if (decision.behavior === "allow") {
        return trace(hookAllow(updatedToolInput));
      }
      if (decision.unanswered) {
        // The prompt expired (TTL) or the run ended before anyone clicked —
        // common when a background subagent asks after the visible turn ended.
        // Never word this as a refusal: the owner likely never saw the prompt.
        events.onBlocked?.({
          toolUseId,
          toolName,
          agentId,
          uiReason: "권한 요청이 응답 없이 만료되어 도구를 실행하지 않았습니다.",
        });
        return trace(
          hookDeny(
            "The permission prompt went unanswered (the owner may not have seen it) — do NOT treat this as a refusal. " +
              "Retry the tool call when the owner is available (it raises a fresh prompt), or continue without it and note that approval is still pending.",
          ),
        );
      }
      return trace(hookDeny("The user denied the use of this tool."));
    }

    events.onBlocked?.({ toolUseId, toolName, agentId, uiReason: "읽기 전용 대화에서는 쓸 수 없는 도구입니다." });
    agentLogger.info({ toolName, agentId, reason: "read-only" }, "tool blocked");
    return trace(
      hookDeny(
        headless
          ? "This run is an automated routine (read-only). File-editing/command-execution tools are unavailable, so use only Read/Glob/Grep."
          : "This conversation is read-only. File-editing/command-execution tools are unavailable, so use only Read/Glob/Grep and the information-request tools.",
      ),
    );
  };
}
