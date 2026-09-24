import crypto from "node:crypto";
import fs from "node:fs";
import { Router, type Response } from "express";
import { requireAuth, type AuthenticatedRequest } from "../auth.js";
import logger from "../logger.js";
import {
  groupKnowledgeRepoSkillSources,
  knowledgeRepoSkillSources,
  KNOWLEDGE_REPO_SOURCE,
  listSkillsInRoots,
  loadAgentPluginRoots,
  loadGroupAgentKnowledgeMemory,
  loadGroupAgentPluginRoots,
  loadKnowledgeRepoMemory,
} from "../plugins.js";
import { knowledgeRepoContextFor } from "../knowledgeRepo.js";
import { groupKnowledgeRepoContextFor } from "../groupKnowledgeRepo.js";
import { scrubGitError } from "../marketplace.js";
import { resolveActiveWorkspaceRepo } from "../activeRepoResolve.js";
import type { Store } from "../store.js";
import type {
  AgentConversationMessage,
  AgentImageFileInput,
  AgentImageInput,
  AgentResponse,
  AppConfig,
  BotTask,
  ExternalAgentConfig,
  MessageAttachment,
  StoredMessage,
} from "../types.js";
import type {
  AgentEvents,
  BrowserCookie,
  BrowserStorageEntry,
  BrowserTab,
} from "../agent/events.js";
import {
  formatSubmission,
  MAX_CANVAS_CONTENT_CHARS,
} from "../agent/canvasTools.js";
import { redactSecretValues } from "../agent/postToolUseHook.js";
import {
  DEFAULT_MCP_TOOL_GROUPS,
  normalizeMcpToolGroups,
  effectiveMcpToolGroups,
  type McpToolGroupId,
} from "../../shared/mcpToolGroups.js";
import {
  findTourScenario,
  TOUR_SLUG_LIST,
} from "../../shared/tourScenarios.js";
import { TOUR_PROMPTS } from "../tourScenarios.js";
import {
  decodeChatImages,
  deleteChatImageAttachments,
  deleteConversationImages,
  publishWorkspaceImage,
  readChatImages,
  resolveStoredImage,
  saveChatImages,
  savePreviewImages,
  stageChatImageFilesFromAttachments,
  MAX_CHAT_IMAGES_PER_MESSAGE,
  MAX_CHAT_IMAGE_BYTES,
  type DecodedChatImage,
  type DecodeError,
} from "../chatImages.js";
import { visionForModel } from "../modelVisionPolicy.js";
import { isPreviewableExtension, renderDocumentPreviews } from "../deckRender.js";
import {
  deleteChatFileAttachments,
  deleteConversationFiles,
  publishBrowserScreenshot,
  publishWorkspaceFile,
  resolveStoredFile,
  MAX_CHAT_FILES_PER_MESSAGE,
  MAX_HIDDEN_CHAT_IMAGES_PER_MESSAGE,
  MAX_SHARED_SCREENSHOTS_PER_MESSAGE,
  SHAREABLE_EXTENSIONS,
  MAX_CHAT_FILE_BYTES,
  sanitizeDownloadName,
} from "../chatFiles.js";
import { runAgentStream, isRetryableModelError } from "../agent/index.js";
import {
  probeExternalAgentGateway,
  runExternalAgent,
} from "../agent/externalAgent.js";
import {
  externalAvatarDetail,
  findExternalAgent,
  findVisibleExternalAgent,
  isSafeExternalModelId,
  listExternalAvatarSummaries,
  mergeExternalAgentRegistries,
} from "../externalAgents.js";
import {
  findChattableGroupAgent,
  groupAgentAvatarDetail,
  groupAgentCaptureAllowed,
  listGroupAgentAvatarSummaries,
  type ChattableGroupAgent,
} from "../groupAgents.js";
import {
  botTaskTitle,
  findChattablePersonalAgent,
  listPersonalAgentAvatarSummaries,
  MAX_QUEUED_BOT_TASKS,
  personalAgentAvatarDetail,
  personalAgentMemoryRoot,
  type ChattablePersonalAgent,
} from "../personalAgents.js";
import {
  isModelTier,
  modelTierLabel,
  MODEL_TIERS,
  DEFAULT_MODEL_TIER,
} from "../modelTiers.js";
import { isEffortLevel } from "../effortLevels.js";
import {
  attachRunClient,
  awaitResponse,
  cancelRun,
  closeRun,
  emitRunEvent,
  getActiveRun,
  getActiveRunForConversation,
  isRunCancelled,
  markRunBackground,
  openRun,
  pushRunSteer,
  submitResponse,
  CANCELLED,
} from "../agent/runRegistry.js";
import { SteerChannel, type SteerRecord } from "../agent/steerChannel.js";
import { workspaceDirFor } from "../workspace.js";
import {
  apiError,
  isSafePathId,
  requestOrigin,
  resolveAvatarSkillSources,
  safeString,
  viewerPlatformFromUserAgent,
  type ObservedModelHolder,
  type RouterDeps,
} from "./_shared.js";

interface ChatSlashExpansion {
  message: string;
  error?: string;
  ownerOnly?: boolean;
}

// Validate + size-cap a client-sent activity-tree snapshot before persisting it on
// a message (the client owns the humanized labels; we only sanitize/bound it so a
// bad/huge payload can't bloat the stored response JSON). Returns null when empty.
function sanitizeActivity(raw: unknown): AgentResponse["activity"] | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { agents?: unknown; tools?: unknown; tasks?: unknown };
  const cap = (s: unknown, max: number): string =>
    typeof s === "string" ? s.slice(0, max) : "";
  const agents = (Array.isArray(obj.agents) ? obj.agents : [])
    .slice(0, 60)
    .map((a) => {
      const node = a as Record<string, unknown>;
      const status = cap(node.status, 16);
      return {
        id: cap(node.id, 80),
        parentId: cap(node.parentId, 80),
        label: cap(node.label, 300),
        status: (status === "done" || status === "failed" ? status : "done") as
          | "running"
          | "done"
          | "failed",
        isMain: node.isMain === true,
      };
    });
  const rawTools = (Array.isArray(obj.tools) ? obj.tools : []).slice(0, 300);
  const legacyTaskRows = rawTools.filter(
    (t) => cap((t as Record<string, unknown>).kind, 16) === "task",
  );
  const tools = rawTools
    .filter((t) => cap((t as Record<string, unknown>).kind, 16) !== "task")
    .map((t) => {
      const row = t as Record<string, unknown>;
      const kind = cap(row.kind, 16);
      const status = cap(row.status, 16);
      return {
        id: cap(row.id, 80),
        agentId: cap(row.agentId, 80) || "main",
        // "memory" must survive the round-trip: the 기억 summary chip is
        // rebuilt from persisted kind:"memory" rows after reload. "compact"
        // likewise — it is the only lasting record that the conversation was
        // summarized mid-turn.
        kind: (kind === "blocked" || kind === "memory" || kind === "compact"
          ? kind
          : "tool") as "tool" | "blocked" | "memory" | "compact",
        label: cap(row.label, 300),
        detail: row.detail ? cap(row.detail, 400) : undefined,
        status: (["done", "failed", "blocked"].includes(status)
          ? status
          : "done") as "running" | "done" | "failed" | "blocked",
      };
    });
  const tasks = [
    ...(Array.isArray(obj.tasks) ? obj.tasks : []),
    ...legacyTaskRows,
  ]
    .slice(0, 200)
    .map((t) => {
      const row = t as Record<string, unknown>;
      const status = cap(row.status, 16);
      return {
        id: cap(row.id, 80),
        agentId: cap(row.agentId, 80) || "main",
        label: cap(row.label, 300),
        detail: row.detail ? cap(row.detail, 400) : undefined,
        status: (status === "failed"
          ? "failed"
          : status === "running"
            ? "running"
            : "done") as "running" | "done" | "failed",
      };
    });
  if (!tools.length && !tasks.length) return null;
  return { agents, tools, tasks };
}

// Agent-facing (the user only ever sees the literal "/learn" in their bubble;
// this expanded instruction goes to the model), so it is written in English.
// The avatar still REPLIES in the user's language per buildPrompt.
const LEARN_SLASH_PROMPT = [
  "Review this conversation session and identify the knowledge that is worth reusing later, so my knowledge repository can be updated.",
  "",
  "Look for important facts, decisions, repeatable procedures, project rules, or ways the user said they prefer to work, plus a clear and explicit record of what you (this avatar) CAN and CANNOT do right now — your current capabilities, the tools/repositories/skills you have connected, and any known limitations or things you were unable to do this session — so future sessions act on an accurate self-picture instead of guessing.",
  "Do not include small talk, anything already stored, or anything not useful long-term.",
  "",
  "The goal is NOT to file a reflection essay in some corner of the repo — it is to change what actually happens next time. So make every entry actionable and retrievable:",
  "- For any mistake, dead end, or thing that went wrong this session, do not just record what happened. Record it as a reusable recipe: the SYMPTOM (how it shows up), the ROOT CAUSE, and the CORRECTION (what to do instead next time) — so the same mistake is not repeated when this kind of work comes up again.",
  "- State the TRIGGER for each entry: which task, workflow, or situation should bring this knowledge back to mind in a future session. Phrase it with the words a future search would actually use (recall here is read-only search, so an entry that is not findable at the right moment is useless).",
  "- Prefer durable rules and 'do X instead of Y' guidance over one-off facts. If an entry cannot influence a future decision or action, it is probably not worth saving.",
  "",
  "IMPORTANT — ask before writing: do NOT write to or commit anything to the knowledge repository yet. First show me a concise summary of exactly what you propose to save (which file or skill each entry goes to, and the gist of each entry) and what you will deliberately skip and why, then ask me to confirm.",
  "Only after I approve should you write the entries and commit. If I ask for changes, adjust the proposal and confirm again before writing.",
].join("\n");

export function expandChatSlashCommand(message: string): ChatSlashExpansion {
  const trimmed = message.trim();
  const match = /^\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return { message };
  }

  const command = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();

  switch (command) {
    case "learn":
      // Text typed after "/learn" is forwarded as an extra focus hint for what to
      // capture (e.g. "/learn 보안 설정 위주로"), appended to the standing instruction.
      return {
        message: args
          ? `${LEARN_SLASH_PROMPT}\n\nThe user added this focus for what to learn or record this time:\n${args}`
          : LEARN_SLASH_PROMPT,
        ownerOnly: true,
      };
    // The expansions below are agent-facing: the user only ever sees the literal
    // "/command" in the bubble (the client sends the literal; the server swaps in
    // these prompts for the model), so per the language split they are English.
    // The avatar still REPLIES in the user's language per buildPrompt. Only the
    // user-facing `error` strings stay Korean.
    case "summarize":
      return {
        message:
          "Summarize the conversation so far, grouped into key decisions, action items, and open questions.",
      };
    case "remember":
      return args
        ? {
            message: `Record the following into my knowledge repository so you can answer the same question in the future.\n\n${args}`,
            ownerOnly: true,
          }
        : {
            message,
            error: "/remember 뒤에 저장할 내용을 입력해 주세요.",
            ownerOnly: true,
          };
    case "routine":
      return args
        ? {
            message: `Create a routine that runs the following task either once at a specific KST date/time or on a recurring schedule. Use any date/time written below as-is; otherwise ask me which execution schedule I want first.\n\n${args}`,
            ownerOnly: true,
          }
        : {
            message,
            error: "/routine 뒤에 작업 내용을 입력해 주세요.",
            ownerOnly: true,
          };
    case "find":
      return args
        ? {
            message: `Find and recommend a colleague avatar better suited to this request.\n\n${args}`,
          }
        : { message, error: "/find 뒤에 요청 내용을 입력해 주세요." };
    // "/tour <slug> [focus]" — a 체험 시나리오 card click (or the typed command)
    // swaps in that scenario's walkthrough prompt (src/server/tourScenarios.ts).
    // The slug list itself is the shared contract, so an unknown slug is caught
    // here rather than expanding into a tour that doesn't exist.
    case "tour": {
      if (!args) {
        return {
          message,
          error: `/tour 뒤에 체험할 시나리오를 입력해 주세요: ${TOUR_SLUG_LIST}`,
          ownerOnly: true,
        };
      }
      const rawSlug = args.split(/\s+/)[0];
      const scenario = findTourScenario(rawSlug.toLowerCase());
      if (!scenario) {
        return {
          message,
          error: `모르는 체험 시나리오입니다: "${rawSlug.slice(0, 40)}". 사용할 수 있는 시나리오: ${TOUR_SLUG_LIST}`,
          ownerOnly: true,
        };
      }
      // Anything typed after the slug rides along as a focus hint (the /learn
      // pattern) — e.g. "/tour browser 사내 위키 위주로".
      const focus = args.slice(rawSlug.length).trim();
      const prompt = TOUR_PROMPTS[scenario.slug];
      return {
        message: focus
          ? `${prompt}\n\nThe user added this focus for the tour:\n${focus}`
          : prompt,
        ownerOnly: true,
      };
    }
    case "new":
      return {
        message,
        error: "/new는 입력창의 슬래시 메뉴에서 새 대화로 실행해 주세요.",
      };
    default:
      return { message };
  }
}

// User-facing (Korean) messages for image-upload validation failures. Typed by
// the DecodeError union so a new variant is a compile error here, not a silent
// `apiError(res, 400, undefined)`.
const CHAT_IMAGE_ERROR: Record<DecodeError, string> = {
  TOO_MANY: `이미지는 한 번에 최대 ${MAX_CHAT_IMAGES_PER_MESSAGE}장까지 첨부할 수 있습니다.`,
  BAD_FORMAT: "지원하는 이미지 형식은 png/jpeg/webp/gif 입니다.",
  EMPTY: "빈 이미지는 첨부할 수 없습니다.",
  TOO_LARGE: `이미지 한 장의 크기는 ${Math.floor(MAX_CHAT_IMAGE_BYTES / 1024 / 1024)}MB 이하여야 합니다.`,
};

/**
 * How long a browser-bridge operation parks. Deliberately seconds, not the
 * interactive PROMPT_TTL_MS: the responder is the extension, so silence means
 * the bridge is gone (tab closed, extension missing, tab detached) rather than
 * a user still deciding. Generous enough for a slow page load to finish.
 */
const BROWSER_OP_TTL_MS = 45 * 1000;

/**
 * Reduce a URL to scheme://host/path for an audit row: credentials in userinfo
 * and tokens in the query string must not land in a table admins can read.
 */
function scrubAuditUrl(raw: string | null | undefined): string {
  if (!raw) return "(unknown)";
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

function prepareSse(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function isEmptyStoppedAssistant(message: StoredMessage): boolean {
  return (
    message.role === "assistant" &&
    message.content.trim() === "(중지됨)" &&
    message.response?.summary === "중지됨" &&
    !message.response.text?.trim()
  );
}

export function conversationHistoryForPrompt(
  messages: StoredMessage[],
): AgentConversationMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") {
      return [];
    }
    if (!message.content.trim() || isEmptyStoppedAssistant(message)) {
      return [];
    }
    return [{ role: message.role, content: message.content }];
  });
}

/** A non-blocking canvas submission/edit delivered as a normal /api/chat/stream turn. */
interface CanvasSubmissionInput {
  canvasId: string;
  values?: Record<string, unknown>;
  editedContent?: string;
}

/** Parse + validate the optional `canvasSubmission` body field (#50). Null when absent/invalid. */
function parseCanvasSubmission(raw: unknown): CanvasSubmissionInput | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const canvasId = typeof obj.canvasId === "string" ? obj.canvasId.trim() : "";
  if (!canvasId) {
    return null;
  }
  const out: CanvasSubmissionInput = { canvasId };
  if (
    obj.values &&
    typeof obj.values === "object" &&
    !Array.isArray(obj.values)
  ) {
    out.values = obj.values as Record<string, unknown>;
  }
  if (typeof obj.editedContent === "string" && obj.editedContent.trim()) {
    out.editedContent = obj.editedContent.slice(0, MAX_CANVAS_CONTENT_CHARS);
  }
  // Must carry at least one of values/editedContent to be meaningful.
  if (!out.values && !out.editedContent) {
    return null;
  }
  return out;
}


/**
 * The avatar a chat turn actually targets, after every reach gate ran.
 *
 * `avatar` is the RUN-facing row and carries capability (a personal-agent turn
 * resolves it to the OWNER's own row); `threadAvatarId` is the THREAD-facing id
 * and carries identity (the composite `personal:<owner>:<agent>` for a bot).
 */
export interface ChatTarget {
  externalAgent: ExternalAgentConfig | null;
  groupAgentHit: ChattableGroupAgent | null;
  personalAgentHit: ChattablePersonalAgent | null;
  avatar: { id: string; displayName: string; alias: string; persona: string };
  threadAvatarId: string;
  threadAvatarLabel: string;
  viewerIsOwner: boolean;
}

/**
 * A turn that cannot start, in a transport-neutral shape: the HTTP route maps it
 * to `apiError`, the bot-task dispatcher just leaves its task queued.
 */
export interface ChatTurnRefusal {
  status: number;
  message: string;
  /**
   * `active_run` is the one refusal a bot thread converts into a queued task.
   * `task_gone` means the delegated row the caller handed us is no longer
   * runnable (the owner cancelled it while it was being popped) — the
   * dispatcher skips to the next item rather than treating it as contention.
   * `repo_locked` means the conversation's working repo is open in ANOTHER
   * conversation right now; the turn refused before writing any message or task
   * row, so a routine firing treats it as "try again on the next tick".
   */
  reason?: "active_run" | "task_gone" | "repo_locked";
  /** True when the turn already wrote the user message before refusing. */
  userMessagePersisted?: boolean;
}

/** Both 409 texts for "this conversation is already running" (two check sites). */
function activeRunMessage(background: boolean): string {
  return background
    ? "아바타가 이 대화의 백그라운드 작업을 진행 중입니다. 작업이 끝나면 메시지를 보낼 수 있어요. 기다리지 않으려면 중지 버튼으로 백그라운드 작업을 중단해 주세요."
    : "이미 이 대화의 응답을 생성 중입니다. 잠시 후 다시 시도해 주세요.";
}

/**
 * Both moved to `../personalAgents.js` so the 봇 간 위임 MCP tool can share them
 * without an `agent/` → `routes/chat.js` import (that direction is a cycle —
 * see botTaskDispatchBroker.ts). Re-exported here because this route has been
 * their import path since they existed.
 */
export { botTaskTitle, MAX_QUEUED_BOT_TASKS };

/**
 * User-facing note stored on a timed-out unattended run (delegated bot task,
 * bot routine, external task API run), derived from the SAME config value that
 * armed the deadline. The SDK labels EVERY abort "Claude Code
 * process aborted by user" (it only checks `signal.aborted`), and nobody was
 * present to cancel an unattended task — see the routine scheduler's identical
 * substitution.
 */
function botTaskTimeoutMessage(timeoutMs: number): string {
  return `실행 제한 시간(${formatDurationKo(timeoutMs)})을 초과해 작업이 중단되었습니다. 작업을 더 작은 단위로 나눠 다시 맡겨 주세요.`;
}

/** "30분" / "5시간" / "1시간 30분" — the external task API budget runs to hours. */
export function formatDurationKo(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes}분`;
  return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
}

/**
 * Resolve who a chat turn is talking to and refuse every unreachable target,
 * in the ORDER the checks have always run (external → group agent → personal
 * agent → native row → image support → owner-only command).
 */
export function resolveChatTarget(args: {
  store: Store;
  externalAgents: ExternalAgentConfig[];
  viewerGroupIds: Set<string>;
  viewerUserId: string;
  avatarId: string;
  /** This turn carries image attachments (external avatars refuse them). */
  hasImages: boolean;
  /** The message expanded from an owner-only slash command (`/learn`, …). */
  ownerOnlyCommand: boolean;
}): { ok: true; target: ChatTarget } | { ok: false; refusal: ChatTurnRefusal } {
  const { store, viewerUserId, avatarId } = args;
  const externalAgent = findVisibleExternalAgent(
    args.externalAgents,
    avatarId,
    args.viewerGroupIds,
  );
  // Group shared agent: member-only reach; a member-visible DISABLED agent
  // gets its own 403 (they already know it exists — no leak), everything
  // else collapses into the generic 403 below (external precedent). Images
  // are allowed: unlike externals, group agents run the full local stack.
  const groupAgentHit = externalAgent
    ? null
    : findChattableGroupAgent(store, viewerUserId, avatarId, {
        includeDisabled: true,
      });
  if (groupAgentHit && !groupAgentHit.agent.enabled) {
    return {
      ok: false,
      refusal: { status: 403, message: "그룹 에이전트가 비활성화되어 있습니다. 그룹 관리자에게 문의해 주세요." },
    };
  }
  // Personal agent (내 봇): OWNER-only reach, and only while the owner still
  // holds the admin role. A disabled bot gets its own 403 — the owner
  // manages it themselves, so naming the state leaks nothing; every other
  // miss collapses into the generic fail-closed 403 below.
  const personalAgentHit =
    externalAgent || groupAgentHit
      ? null
      : findChattablePersonalAgent(store, viewerUserId, avatarId, {
          includeDisabled: true,
        });
  if (personalAgentHit && !personalAgentHit.agent.enabled) {
    return {
      ok: false,
      refusal: { status: 403, message: "이 봇은 비활성화되어 있습니다. 설정 → 내 봇에서 활성화한 뒤 다시 시도해 주세요." },
    };
  }
  const avatar = externalAgent
    ? externalAvatarDetail(externalAgent)
    : groupAgentHit
      ? groupAgentAvatarDetail(groupAgentHit.agent, groupAgentHit.groupName)
      : // A bot turn is a FULL OWNER run, so the run-facing avatar is the
        // OWNER's own (avatar.id = the owner's uuid) and every owner-keyed
        // loader — plugins, knowledge repo, secrets, work repos, trust —
        // works untouched. The bot's composite id lives in
        // `threadAvatarId` below, never here. (types.ts personalAgent)
        store.resolveChatAvatar(
          viewerUserId,
          personalAgentHit ? viewerUserId : avatarId,
        );
  if (!avatar) {
    return {
      ok: false,
      refusal: { status: 403, message: "이 아바타와 대화할 수 없습니다." },
    };
  }
  /**
   * The id this THREAD is keyed by: the composite
   * `personal:<owner>:<agent>` on a bot turn, else `avatar.id`. Everything
   * thread-scoped — the conversation binding, the scratch workspace, the
   * run registry, client-facing payloads — uses THIS, so a bot's history
   * and files stay its own while the run keeps owner capability.
   */
  const threadAvatarId = personalAgentHit ? avatarId : avatar.id;
  /** Chat target for audit/logs — the BOT's name on a personal turn. */
  const threadAvatarLabel = personalAgentHit
    ? personalAgentHit.agent.displayName
    : avatar.displayName;
  if (externalAgent && args.hasImages) {
    return {
      ok: false,
      refusal: { status: 400, message: "외부 아바타는 아직 이미지 첨부를 지원하지 않습니다." },
    };
  }
  // ownerOnly bites on a RAW `/command`: server-expanded commands (e.g. /learn)
  // arrive verbatim and DO match here, and so does a stale client / direct API
  // caller. Client-expanded commands arrive already-expanded and slip past — but
  // that's fine: this is a convenience guard, not the real boundary. The owner-only
  // EFFECTS (knowledge-repo writes, routine creation) run through `mcp__repo__*` /
  // routine APIs that owner-gate in their own handlers, so an expanded prompt from
  // a non-owner can't reach them.
  if (args.ownerOnlyCommand && viewerUserId !== avatar.id) {
    return {
      ok: false,
      refusal: { status: 403, message: "이 명령은 내 아바타와의 대화에서만 사용할 수 있습니다." },
    };
  }
  // True for a bot turn by construction: the personal branch resolved
  // `avatar` to the viewer's OWN row, and the reach gate already proved
  // owner + admin. Keep it that way — a bot run must stay an owner run.
  const viewerIsOwner =
    !externalAgent && !groupAgentHit && viewerUserId === avatar.id;
  return {
    ok: true,
    target: {
      externalAgent,
      groupAgentHit,
      personalAgentHit,
      avatar,
      threadAvatarId,
      threadAvatarLabel,
      viewerIsOwner,
    },
  };
}

/** App-level collaborators a turn needs, independent of how it was started. */
export interface ChatTurnDeps {
  config: AppConfig;
  store: Store;
  observedModel: ObservedModelHolder;
  /**
   * Fired once a PERSONAL-AGENT turn's run has closed, so the delegated-task
   * dispatcher can pick up the thread's next queued item. Injected rather than
   * imported: `botTaskRunner` calls back into `executeChatTurn`, and a direct
   * import here would close the cycle.
   */
  onBotTurnSettled?: (ownerUserId: string, conversationId: string) => void;
}

/**
 * Everything a turn needs that an HTTP request would normally supply. A
 * server-started turn (the delegated-task dispatcher) fills the same shape with
 * `undefined` for every optional selection, which the derivations below already
 * read as "use whatever is stored on the conversation".
 */
/**
 * Visible-reply text of a turn that hands work to background tasks/subagents
 * before it streamed anything itself (the early `done{background:true}` frame).
 * Exported so the task-API runner can keep it OUT of a stored task result — the
 * real answer arrives later as `bg_message` reports.
 */
export const BACKGROUND_TURN_PLACEHOLDER = "백그라운드 작업을 진행 중입니다.";

/**
 * Filler text for a visible segment a steer cut short before the model wrote
 * anything: the run stays open and the follow-up turn answers next, but the
 * segment is still persisted as its own assistant row so the transcript keeps
 * its user/assistant alternation. User-facing → Korean.
 */
export const STEER_TURN_END_PLACEHOLDER = "(이어서 다음 메시지에 답합니다.)";

/**
 * Cap on one mid-turn message. Generous enough for a pasted log excerpt and
 * small enough that ten queued ones cannot blow up the turn they land in.
 */
export const MAX_STEER_LENGTH = 20_000;

/**
 * A mid-turn message as the client sees it — the POST response body carries
 * exactly this, and every `steer` SSE frame carries it as `data.steer`.
 * `followUp: true` means the model got it only AFTER a result boundary, so it
 * runs as its own turn inside the same run.
 *
 * On the DELIVERED frame the persisted user row rides INSIDE this object as
 * `message` (null when the conversation was deleted mid-run), not beside it —
 * the client reads one object per frame. Hand-mirrored in the client's
 * `src/client/src/lib/types.ts`; nothing type-checks across that gap.
 */
export interface SteerPublic {
  id: string;
  text: string;
  state: SteerRecord["state"];
  createdAt: string;
  followUp: boolean;
  /** The persisted `kind: "steer"` user row. Only on the `delivered` frame. */
  message?: StoredMessage | null;
}

/** Project a channel record onto the wire shape (drops nothing sensitive; it is the viewer's own text). */
function publicSteer(record: SteerRecord): SteerPublic {
  return {
    id: record.id,
    text: record.text,
    state: record.state,
    createdAt: record.createdAt,
    followUp: record.followUp,
  };
}

export interface ChatTurnContext {
  ownerUserId: string;
  ownerDisplayName: string;
  target: ChatTarget;
  conversationId: string;
  /** What the MODEL receives (slash commands / canvas submissions expanded). */
  agentMessage: string;
  /** What the USER sees and what is persisted as the user turn. */
  displayMessage: string;
  images: DecodedChatImage[];
  regenerate: boolean;
  requestedModel?: string | null;
  requestedEffort?: string | null;
  requestedMcpToolGroups?: McpToolGroupId[] | null;
  requestedGroupKnowledgeOff?: string[] | null;
  appOrigin?: string;
  viewerPlatform?: "mac" | "windows" | "linux";
  audit: (entry: {
    action: string;
    detail: string;
    status?: "success" | "error";
  }) => void;
  // ---- Delegated bot tasks (내 봇) ---------------------------------------
  // Every field below is inert unless `target.personalAgentHit` is set.
  /**
   * The already-created `bot_tasks` row this turn executes (the dispatcher's
   * queued item). Absent → the turn creates its own row, or resumes the
   * thread's parked `waiting_input` one.
   */
  existingBotTaskId?: string;
  /**
   * Wall-clock budget for an UNATTENDED turn. Set only by the unattended callers:
   * the bot-task dispatcher and bot routines pass `botTaskRunTimeoutMs`, the
   * external task API `avatarTaskRunTimeoutMs`. An owner-typed turn has a live
   * stop button, so it stays un-deadlined.
   */
  unattendedDeadlineMs?: number;
  /** Fall down the model tier chain on transient failures (unattended runs). */
  modelFallback?: boolean;
  /** The user message is already stored (the queue persisted it on enqueue). */
  skipUserMessagePersist?: boolean;
  /**
   * 봇 루틴 provenance: the routine_jobs.id this turn was fired by, stamped onto
   * the task row this turn opens. Set only by the routine scheduler. PROVENANCE
   * ONLY — it never changes how the turn runs; it labels the card and lets the
   * scheduler dedupe its own queued firings.
   */
  routineJobId?: string;
  /**
   * The `avatar_tasks` row this turn executes, when an EXTERNAL SYSTEM submitted
   * the instruction through the owner's personal task API (`POST
   * /api/v1/avatar/tasks`). Set only by `avatarTaskRunner`. PROVENANCE, not
   * capability: the run stays a full owner run, but the SDK request is stamped
   * `externalTaskApi` so the prompt, `describe_system`, and the interactive-only
   * tool gates (bot creation) can tell that no owner typed this turn.
   */
  externalTaskId?: string;
}

export interface ChatTurnHooks {
  onEvent?: (event: string, data: unknown) => void;
  /**
   * Called between `openRun` and the agent stream, exactly where the SSE
   * handshake sits. Return false to abandon the turn (the run is closed for
   * you); throwing is also safe.
   */
  onRunOpen(runId: string): boolean;
}

export type ChatTurnOutcome =
  | { ok: true }
  | { ok: false; refusal: ChatTurnRefusal };

/**
 * Run ONE chat turn end to end: pre-run derivations, the working-repo lock, the
 * run registry entry, the agent stream with all of its sinks, and every
 * finalize path (done / cancel / error). Emits exclusively through
 * `emitRunEvent`, so it neither knows nor needs an HTTP response — a caller with
 * no client attached still gets the whole turn journaled on the run.
 */
export async function executeChatTurn(
  deps: ChatTurnDeps,
  ctx: ChatTurnContext,
  hooks: ChatTurnHooks,
): Promise<ChatTurnOutcome> {
  const { config, store, observedModel } = deps;
  const {
    ownerUserId,
    conversationId,
    agentMessage,
    displayMessage,
    regenerate,
    audit,
  } = ctx;
  const {
    externalAgent,
    groupAgentHit,
    personalAgentHit,
    avatar,
    threadAvatarId,
    threadAvatarLabel,
    viewerIsOwner,
  } = ctx.target;
  const decodedImages = ctx.images;
  // Absent (a server-started turn) reads as "keep whatever is stored", which is
  // the same null the HTTP prelude produces when the client sends nothing.
  const requestedModel = ctx.requestedModel ?? null;
  const requestedEffort = ctx.requestedEffort ?? null;
  const requestedMcpToolGroups = ctx.requestedMcpToolGroups ?? null;
  const requestedGroupKnowledgeOff = ctx.requestedGroupKnowledgeOff ?? null;
  const existingAvatarId = store.getConversationAvatarId(
    ownerUserId,
    conversationId,
  );
  // Effective vision for THIS turn's model, mirroring claudeAgent's
  // resolution chain (env pin > this turn's tier pick > stored tier >
  // admin override > default) against the admin per-tier policy. Gates the
  // upload below AND the regenerate image re-feed; the run itself
  // recomputes the same value. External turns keep the deployment default
  // (gateway models are outside the tier policy; their composer has no
  // attach UI anyway).
  const turnModel = externalAgent
    ? config.anthropicModel
    : (config.anthropicModel ??
      (requestedModel === null
        ? store.getConversationModel(ownerUserId, conversationId)
        : requestedModel || null) ??
      store.getModelOverride() ??
      DEFAULT_MODEL_TIER);
  const turnVisionEnabled = visionForModel(
    turnModel,
    store.getModelVisionPolicy(),
    config.visionEnabled,
  );
  // Text-only model for this turn: images are NOT rejected — they are staged
  // as FILES in the conversation scratch workspace and the model receives only
  // their paths (buildUserPrompt), never image content blocks (which would 400
  // the whole turn at the API layer). External turns never reach here with
  // images (rejected above).
  const imageFileMode =
    decodedImages.length > 0 && !turnVisionEnabled && !externalAgent;
  if (externalAgent && existingAvatarId) {
    const boundEndpoint = store.getConversationExternalEndpoint(
      ownerUserId,
      conversationId,
    );
    if (!boundEndpoint) {
      return {
        ok: false,
        refusal: {
          status: 409,
          message:
            "이 기존 대화에는 신뢰한 Gateway 주소 정보가 없습니다. 기록 보호를 위해 새 대화를 시작해 주세요.",
        },
      };
    }
    if (boundEndpoint !== externalAgent.endpoint) {
      return {
        ok: false,
        refusal: {
          status: 409,
          message:
            "이 대화는 이전 Gateway 주소에 연결되어 있습니다. 기록 보호를 위해 새 대화를 시작해 주세요.",
        },
      };
    }
  }
  const conversationMcpToolGroups = requestedMcpToolGroups ??
    store.getConversationMcpToolGroups(ownerUserId, conversationId) ?? [
      ...DEFAULT_MCP_TOOL_GROUPS,
    ];
  // Admin per-group tool policy: the RUN uses the intersection of the
  // composer selection and what the system admin allows for this user
  // (null = unrestricted). The per-conversation row keeps the user's RAW
  // choice — lifting the policy later restores it untouched. claudeAgent
  // re-clamps identically, always retaining system; this local copy exists because git-repo gating
  // below must see the same effective set BEFORE the run starts.
  const adminAllowedMcpToolGroups = store.allowedMcpToolGroupsForUser(
    ownerUserId,
  );
  const effectiveMcpToolGroupsForRun = effectiveMcpToolGroups(
    conversationMcpToolGroups, adminAllowedMcpToolGroups,
  );
  const gitRepoToolsEnabled =
    effectiveMcpToolGroupsForRun.includes("git_repo");
  // A run is already streaming for this conversation. This POST carries a NEW
  // typed message; the old attach-and-replay path would silently swallow it
  // (never persisted, never echoed — the client would only mirror the FIRST
  // turn's answer). Reject so the client surfaces the error and keeps the text
  // in the composer. Reconnecting to WATCH an in-flight run uses the dedicated
  // GET /api/chat/runs/:runId/events path, not a second POST.
  const activeRun = getActiveRunForConversation(
    ownerUserId,
    conversationId,
  );
  if (activeRun) {
    return {
      ok: false,
      refusal: {
        status: 409,
        message: activeRunMessage(activeRun.background),
        // A bot thread QUEUES this turn instead of refusing it — nothing has
        // been persisted yet, so the caller owns the whole enqueue.
        reason: "active_run",
        userMessagePersisted: false,
      },
    };
  }

  // Working repository: the avatar opens one registered git repo (via
  // `mcp__git_repo__open_repo`) as the SDK cwd so it edits/tests with native
  // tools. The selection is held per conversation (repoWorkspace.ts) and read
  // here at turn start via the shared resolver (also used by the routine
  // scheduler, so the two can't drift). Resolve + clone + take the per-clone
  // serialization lock BEFORE switching to SSE, so validation/contention
  // failures stay plain JSON. The clone path is server-side only and never
  // returned to the client (only the repo name). The elevated gate is
  // belt-and-suspenders — open_repo is itself elevated-only — in case trust
  // changed since the repo was opened.
  const elevatedViewer =
    !externalAgent &&
    !groupAgentHit &&
    (viewerIsOwner || store.isTrustedFor(ownerUserId, avatar.id));
  let activeRepoCwd: string | null = null;
  let activeRepoName: string | null = null;
  let releaseActiveRepoLock: (() => void) | null = null;
  // Group-agent runs skip the whole block: no isTrustedFor on a synthetic
  // id, no personal work-repo workspace (the run kind carries capability).
  // Bot turns DO run it — `avatar` is the owner's own row, so the owner's
  // registered repos and commit identity resolve exactly as usual.
  if (!externalAgent && !groupAgentHit) {
    const repoResolution = await resolveActiveWorkspaceRepo({
      store,
      config,
      avatar: {
        id: avatar.id,
        displayName: avatar.displayName,
        alias: avatar.alias,
      },
      conversationId,
      elevated: elevatedViewer,
      gitRepoToolsEnabled,
    });
    if (repoResolution.kind === "error") {
      return {
        ok: false,
        refusal:
          repoResolution.reason === "not_found"
            ? {
                status: 400,
                message:
                  "등록된 저장소를 찾을 수 없습니다. 먼저 저장소를 등록해 주세요.",
              }
            : repoResolution.reason === "locked"
              ? {
                  status: 409,
                  message:
                    "이 저장소는 다른 대화에서 작업 중입니다. 잠시 후 다시 시도해 주세요.",
                  reason: "repo_locked",
                }
              : {
                  status: 502,
                  message: `저장소 작업공간을 열지 못했습니다: ${repoResolution.detail ?? ""}`,
                },
      };
    }
    if (repoResolution.kind === "ok") {
      activeRepoCwd = repoResolution.cwd;
      activeRepoName = repoResolution.repoName;
      // Frees the per-clone serialization lock; called once when the run ends.
      releaseActiveRepoLock = repoResolution.release;
    }
  }

  try {
    const runId = crypto.randomUUID();
    const chatStart = Date.now();
    if (regenerate) {
      const last = [...store.listMessages(ownerUserId, conversationId)].pop();
      store.dropLastAssistant(ownerUserId, conversationId);
      if (last?.role === "assistant") {
        deleteChatImageAttachments(config, conversationId, last.attachments);
        deleteChatFileAttachments(config, conversationId, last.attachments);
      }
    }
    const imageTurn =
      !regenerate && decodedImages.length > 0 && turnVisionEnabled;
    // Resume the conversation's prior SDK session so the model keeps its context
    // across turns. A regenerate re-runs the same turn and starts fresh to avoid
    // duplicating history in the transcript. Image turns also start fresh: the SDK
    // receives images through streaming input, and combining that with `resume`
    // can drop the structured image blocks before they reach the model. File-mode
    // turns (text-only model) never build a structured message — the prompt stays
    // a plain string — so they keep the session resume.
    const resumeSessionId =
      externalAgent || regenerate || imageTurn
        ? undefined
        : (store.getAgentSessionId(ownerUserId, conversationId) ??
          undefined);
    // Carry prior context on every turn. It is INJECTED into the prompt only when
    // there's no SDK session to resume (buildPrompt guards on resumeSessionId) —
    // a regenerate/image turn starts fresh and needs it, and a resume turn keeps
    // it latent so claudeAgent can self-heal a stale/missing SDK transcript by
    // re-running without `resume` (then this history is what rebuilds the context).
    // A regenerate also persists its fresh session id, so without this every later
    // turn would resume a context-less session.
    // (chat-01 / lifecycle-02)
    const priorMessages = store.listMessages(ownerUserId, conversationId);
    const conversationHistory = conversationHistoryForPrompt(priorMessages);
    // On regenerate the trailing history entry is the user turn being re-run,
    // which is ALSO re-sent as `message` — drop it so it isn't duplicated.
    if (
      regenerate &&
      conversationHistory.length > 0 &&
      conversationHistory[conversationHistory.length - 1].role === "user"
    ) {
      conversationHistory.pop();
    }
    // Images fed to the model THIS turn. For a fresh send we save the uploads to
    // disk + record them on the user message; on regenerate the client doesn't
    // re-send images (it re-runs from a fresh SDK session), so re-read the prior
    // user turn's stored attachments so the re-run still sees them.
    let requestImages: AgentImageInput[] = [];
    // The same images in FILE mode (text-only model): staged copies in the
    // scratch workspace whose paths — never their bytes — reach the model.
    let requestImageFiles: AgentImageFileInput[] = [];
    // Per-conversation workspace: each chat session gets an isolated cwd, scoped
    // under the avatar so sessions cannot mix files by accident. Created here
    // (before the message persist) because file mode stages attachments into it.
    // External turns run no local workspace, so they don't get a directory.
    const workspaceDir = workspaceDirFor(
      config,
      threadAvatarId,
      conversationId,
    );
    if (!externalAgent) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }
    store.touchConversation(
      ownerUserId,
      conversationId,
      threadAvatarId,
      displayMessage,
      externalAgent ? { externalEndpoint: externalAgent.endpoint } : {},
    );
    // Persist the owner's group-knowledge selection now that the row exists, so
    // it survives reload and applies to later turns until changed again.
    if (requestedGroupKnowledgeOff) {
      store.setConversationGroupKnowledgeOff(
        ownerUserId,
        conversationId,
        requestedGroupKnowledgeOff,
      );
    }
    // Persist the chosen model so it survives reload and applies to later
    // turns until changed. null = client sent nothing → leave the stored value.
    // Native rows hold a tier alias; external rows hold a gateway model id.
    if (requestedModel !== null) {
      store.setConversationModel(
        ownerUserId,
        conversationId,
        requestedModel || null,
      );
    }
    // Persist the chosen effort level (same semantics as the model tier above).
    if (!externalAgent && requestedEffort !== null) {
      store.setConversationEffort(
        ownerUserId,
        conversationId,
        requestedEffort || null,
      );
    }
    if (!externalAgent && requestedMcpToolGroups !== null) {
      store.setConversationMcpToolGroups(
        ownerUserId,
        conversationId,
        requestedMcpToolGroups,
      );
    }
    if (!regenerate) {
      const saved = saveChatImages(config, conversationId, decodedImages);
      // The persisted attachments are the same either way — the bubble
      // renders identically; only the MODEL-facing shape differs.
      if (imageFileMode) {
        requestImageFiles = stageChatImageFilesFromAttachments(
          config,
          conversationId,
          workspaceDir,
          saved.attachments,
        );
      } else {
        requestImages = saved.images;
      }
      // A dispatched queued task skips this: the enqueue already stored the
      // user's message, and re-adding it would double the bubble. The
      // touchConversation above still ran, so the thread's updated_at moves.
      if (!ctx.skipUserMessagePersist) {
        store.addMessage(conversationId, {
          role: "user",
          content: displayMessage,
          attachments: saved.attachments,
        });
      }
    } else {
      const lastUser = [...priorMessages]
        .reverse()
        .find((m) => m.role === "user");
      // On a text-only turn the attachments resurface as FILES by design (same
      // staging path as a fresh send), never as image blocks the API would
      // reject — so a regenerate under a swapped model still sees them.
      if (turnVisionEnabled) {
        requestImages = readChatImages(
          config,
          conversationId,
          lastUser?.attachments,
        );
      } else {
        requestImageFiles = stageChatImageFilesFromAttachments(
          config,
          conversationId,
          workspaceDir,
          lastUser?.attachments,
        );
      }
    }
    // The SDK session id this run reports (init event); persisted on success so
    // the next turn can resume it.
    let runSessionId: string | null = null;
    // Accumulate the main-agent text as it streams, so the cancel/error paths can
    // persist the partial the user already watched (not an empty "(중지됨)" stub).
    let streamedText = "";
    // Accumulate the main-agent reasoning (extended-thinking) text as it streams,
    // so it can be persisted on the response (success) and the cancel/error paths.
    let streamedThinking = "";
    // Images published by `show_file` during this run. They render live over
    // SSE and are attached to the terminal assistant message on every exit
    // path so a reload matches what the user already saw.
    const shownAttachments: MessageAttachment[] = [];
    // Browser screenshots auto-shared as file cards this run — own budget,
    // separate from the share_file/show_file caps (see chatFiles.ts).
    let sharedScreenshotCount = 0;
    // Documents the model shared via share_file this run. Counted on its own
    // rather than off `shownAttachments`, which also carries the screenshot
    // auto-share's kind:"file" cards — a browsing loop must not spend this cap.
    let sharedFileCount = 0;
    // Visual-canvas artifacts (#50) now persist to the dedicated canvas tables as
    // they are shown (see the onCanvas handler), with version history — they no
    // longer ride the assistant message's response JSON.
    // The latest plan the avatar submitted via ExitPlanMode this turn (plan mode).
    // Persisted on the assistant response so the plan card rebuilds on reload, and
    // mirrored on the cancel/error paths like canvases. Latest plan of the turn wins.
    let latestPlan: string | null = null;
    // Background phase (SDK-native): when the model hands work to a background
    // task/subagent, the SDK holds the session open past the first `result`,
    // wakes the model when a task settles, and streams follow-up turns. We
    // finalize the VISIBLE turn at that first result (persist + done with
    // `background: true`, run kept open) and deliver each wake-up turn as a
    // NEW assistant message (`bg_message`). `turnFinalized` marks the phase;
    // the offsets remember how much of the accumulated stream text/thinking/
    // attachments was already persisted, so wake-up and cancel/error paths
    // only carry their own tail.
    let turnFinalized = false;
    let persistedTextOffset = 0;
    let persistedThinkingOffset = 0;
    let persistedAttachmentsOffset = 0;
    // How much of `streamedText` was FOLDED into the reasoning view (a newer
    // text block superseded it — see the onTextFold sinks below). The answer
    // restarted from this offset, so the cancel/error tails must start here
    // too or they resurrect narration the live view already moved away.
    let foldedTextOffset = 0;
    // The model THIS run actually resolved to (fallback-aware), for the task
    // card. Kept per-run rather than read back off `observedModel`, which is one
    // app-wide box every concurrent run overwrites.
    let observedRunModel: string | null = null;
    logger.info(
      {
        userId: ownerUserId,
        avatarId: threadAvatarId,
        conversationId,
        regenerate,
      },
      "chat stream started",
    );

    // The 409 check at the top of the handler ran BEFORE `await
    // resolveActiveWorkspaceRepo` (a possible git clone), so a concurrent POST
    // on this same conversation could have slipped past it. Re-check
    // synchronously here — openRun below is the real reservation, and there
    // must be NO `await` between this check and openRun or the race reopens.
    // The response is still plain JSON (prepareSse runs after openRun). Null
    // the lock release first: the winning run owns this conversation's
    // (reentrant, per-conversation) active-repo lock and frees it itself —
    // releasing it here would yank it from under the winner.
    const racedRun = getActiveRunForConversation(ownerUserId, conversationId);
    if (racedRun) {
      releaseActiveRepoLock = null;
      return {
        ok: false,
        refusal: {
          status: 409,
          message: activeRunMessage(racedRun.background),
          reason: "active_run",
          // The turn body already wrote the user message above, so a caller
          // that turns this into a queued task must NOT persist it again.
          userMessagePersisted: true,
        },
      };
    }

    const abortController = new AbortController();
    // Mid-turn messages ("steers"): the viewer can keep typing while this run
    // streams. Two run kinds get no channel, and POST …/message answers 409 for
    // both. An EXTERNAL gateway avatar is one stateless request/response with no
    // live stdin to fold a message into. An EXTERNAL-TASK-API turn is the
    // interactive-only gate every such capability carries (`AgentRequest`'s own
    // contract: midTurnMessages is never set there) — nobody typed it, the key
    // holder answers only through /respond, and both metacognition surfaces
    // already tell the avatar no person is on the other side.
    const steers =
      externalAgent || ctx.externalTaskId ? undefined : new SteerChannel();
    openRun(runId, ownerUserId, {
      conversationId,
      avatarId: threadAvatarId,
      onEvent: hooks.onEvent,
      abortController,
      steers,
    });
    // Subscribe BEFORE the agent starts, so the very first accepted steer is
    // already observable. Every state change becomes one `steer` frame; the
    // DELIVERED one additionally persists the user row (only then — a message
    // the model never received must not appear in history).
    steers?.onChange((record) => {
      if (record.state !== "delivered") {
        emitRunEvent(runId, "steer", { steer: publicSteer(record) });
        return;
      }
      // The conversation may have been deleted mid-run; skip the insert (the FK
      // would reject it) and report the frame without a message, exactly like
      // the other persist sites here. The channel SWALLOWS a listener throw, so
      // guard the insert rather than the whole sink: a failed write must still
      // let the `delivered` frame out, or the viewer's pending bubble never
      // resolves.
      let message: StoredMessage | null = null;
      try {
        if (store.conversationOwner(conversationId) === ownerUserId) {
          message = store.addMessage(conversationId, {
            role: "user",
            content: record.text,
            kind: "steer",
          });
        }
      } catch (err) {
        logger.error({ err, runId, steerId: record.id }, "steer could not be persisted");
      }
      logger.info(
        { runId, steerId: record.id, followUp: record.followUp },
        "steer delivered",
      );
      emitRunEvent(runId, "steer", { steer: { ...publicSteer(record), message } });
    });
    // openRun sits BEFORE the run's own try/finally { closeRun }, so guard the
    // SSE handshake: a throw here (headers already sent, client detached) would
    // otherwise strand the run in the registry and 409 this conversation for
    // the whole process lifetime.
    try {
      // The HTTP caller switches its response to SSE and attaches here; a
      // server-started turn just returns true (the registry journals every
      // event for a viewer who attaches later).
      if (!hooks.onRunOpen(runId)) {
        closeRun(runId);
        return { ok: true };
      }
    } catch (err) {
      closeRun(runId);
      throw err;
    }

    // ---- Delegated task bookkeeping (내 봇 threads only) ------------------
    // Every executed turn in a bot thread IS a task row: the dispatcher hands
    // us the queued one it popped, an owner message answering a parked question
    // RESUMES that row, and anything else opens a new one. Best-effort start to
    // finish — bookkeeping must never take down the turn it is describing.
    // A box, not a bare `let`: every write happens inside publishBotTask, and a
    // plain local would stay narrowed to `null` at the read sites below.
    const botTask: { row: BotTask | null } = { row: null };
    /**
     * The ONE place a delegated-task row reaches the client. The frame is
     * `bot_task`, NOT `task`: `task`/`task_update`/`task_end` already belong to
     * the SDK activity relay (onTaskStart below), whose client handler keys on
     * `data.taskId` and drops anything without one. Payload is the whole row —
     * the client renders the card straight from it.
     */
    const publishBotTask = (task: BotTask | null): void => {
      if (!task) return;
      botTask.row = task;
      emitRunEvent(runId, "bot_task", { task });
    };
    if (personalAgentHit) {
      try {
        const threadTasks = ctx.existingBotTaskId
          ? []
          : store.listBotTasksForConversation(conversationId);
        const parked = threadTasks[threadTasks.length - 1];
        publishBotTask(
          ctx.existingBotTaskId
            ? store.markBotTaskRunning(ctx.existingBotTaskId, runId)
            : parked?.status === "waiting_input"
              ? store.markBotTaskRunning(parked.id, runId)
              : store.createBotTask({
                  ownerUserId,
                  agentId: personalAgentHit.agent.id,
                  conversationId,
                  title: botTaskTitle(displayMessage),
                  requestText: displayMessage,
                  status: "running",
                  runId,
                  routineJobId: ctx.routineJobId ?? null,
                }),
        );
      } catch (err) {
        logger.error(
          { err, conversationId, runId },
          "bot task could not be opened for this turn",
        );
      }
      // The dispatcher's row would not go `running`: the owner cancelled it
      // between the pop and this transition (markBotTaskRunning is guarded on
      // status and answers null rather than resurrecting a closed task). Run
      // nothing — untracked unattended work has no stop button anywhere.
      if (ctx.existingBotTaskId && !botTask.row) {
        closeRun(runId);
        return {
          ok: false,
          refusal: {
            status: 409,
            message: "이미 종료된 작업입니다.",
            reason: "task_gone",
          },
        };
      }
    }
    /**
     * Close the task out at a turn boundary. The DONE path re-reads the row
     * first: the bot may have written `reported_outcome` mid-run via
     * `mcp__personal_agent__report_task`, and `need_input` PARKS the task for
     * the owner's answer instead of terminating it. `model` is omitted when the
     * run never reported one, so a resume can't blank the stored value.
     */
    const settleBotTask = (
      kind: "done" | "cancelled" | "failed",
      error?: string,
    ): void => {
      const pending = botTask.row;
      if (!pending) return;
      try {
        const model = observedRunModel ? { model: observedRunModel } : {};
        if (kind !== "done") {
          publishBotTask(
            store.finishBotTask(pending.id, {
              status: kind,
              ...(kind === "failed" ? { error: error ?? null } : {}),
              ...model,
            }),
          );
          return;
        }
        const current = store.getBotTask(pending.id) ?? pending;
        publishBotTask(
          store.finishBotTask(pending.id, {
            status:
              current.reportedOutcome === "need_input" ? "waiting_input" : "done",
            ...model,
          }),
        );
      } catch (err) {
        logger.error({ err, taskId: pending.id }, "bot task finalize failed");
      }
    };
    // Unattended turn (the dispatcher started it, nobody can press stop): a hung
    // SDK call must not pin this thread's whole queue. Owner-typed turns stay
    // un-deadlined — the stop button already is the deadline.
    let timedOut = false;
    const deadline = ctx.unattendedDeadlineMs
      ? setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, ctx.unattendedDeadlineMs)
      : undefined;

    try {
      if (externalAgent) {
        // External avatars are conversation-stateless and run their own tool
        // stack behind the gateway. Do not resolve local plugins, knowledge,
        // MCP servers, repos, workspaces, or SDK sessions. The one local
        // setting that DOES apply is the viewer-picked gateway model id
        // (this turn's pick, else the stored per-conversation choice); the
        // admin-configured model stays the default when neither is set.
        const selectedExternalModel =
          requestedModel === null
            ? store.getConversationModel(ownerUserId, conversationId)
            : requestedModel || null;
        const response = await runExternalAgent(
          {
            message: agentMessage,
            conversationHistory,
          },
          selectedExternalModel
            ? { ...externalAgent, model: selectedExternalModel }
            : externalAgent,
          {
            onDelta: (text) => {
              streamedText += text;
              emitRunEvent(runId, "delta", { text });
            },
            onThinking: (text) => {
              streamedThinking += text;
              emitRunEvent(runId, "thinking", { text });
            },
            onTextFold: (text) => {
              // Demoted narration joins the reasoning stream (persisted as
              // response.thinking)…
              streamedThinking += (streamedThinking ? "\n\n" : "") + text;
              // …and leaves the answer: cancel/error tails must not resurrect it.
              foldedTextOffset = streamedText.length;
              // Anchors index into the answer text, and the answer just
              // restarted from empty — every stamped card now belongs before
              // the new tail.
              for (const attachment of shownAttachments) {
                if (typeof attachment.anchor === "number") attachment.anchor = 0;
              }
              emitRunEvent(runId, "text_fold", {});
            },
            onStatus: (label) => {
              emitRunEvent(runId, "status", { label });
            },
            // onModel and onSessionId are intentionally OMITTED for external
            // runs: external Gateway telemetry must not overwrite the local SDK
            // model shown in the admin system overview, and a gateway SDK
            // session id must never become Noah continuation state
            // (runExternalAgent nulls onSessionId regardless). runSessionId
            // stays null here and the external branch returns before any reader,
            // so no handler is wired.
            onPlugin: (event) => {
              emitRunEvent(runId, "plugin", event);
            },
            onToolStart: (event) => {
              emitRunEvent(runId, "tool", event);
            },
            onToolEnd: (event) => {
              emitRunEvent(runId, "tool_end", event);
            },
            onTaskStart: (event) => {
              emitRunEvent(runId, "task", event);
            },
            onTaskUpdate: (event) => {
              emitRunEvent(runId, "task_update", event);
            },
            onTaskEnd: (event) => {
              emitRunEvent(runId, "task_end", event);
            },
            onAgentStart: (event) => {
              emitRunEvent(runId, "agent", event);
            },
            onAgentEnd: (event) => {
              emitRunEvent(runId, "agent_end", event);
            },
            onBlocked: (event) => {
              emitRunEvent(runId, "blocked", event);
            },
            onMemory: (event) => {
              // Stable id: an SSE reattach replays the whole event log, and
              // the client dedupes 기억 rows by this id.
              emitRunEvent(runId, "memory", { id: crypto.randomUUID(), ...event });
            },
            onCompact: (event) => {
              emitRunEvent(runId, "compact", { id: crypto.randomUUID(), ...event });
            },
            onPlan: (event) => {
              if (event.plan) latestPlan = event.plan;
              emitRunEvent(runId, "plan", {
                plan: event.plan,
                planning: event.planning ?? false,
              });
            },
          } satisfies AgentEvents,
          abortController,
        );
        if (latestPlan) response.plan = latestPlan;
        if (streamedThinking) response.thinking = streamedThinking;

        const assistantMessage =
          store.conversationOwner(conversationId) === ownerUserId
            ? store.addMessage(conversationId, {
                role: "assistant",
                content: response.text || response.summary,
                response,
              })
            : null;
        audit({
          action: "chat",
          detail: `chat with ${threadAvatarLabel} (${response.runtime})`,
        });
        logger.info(
          {
            userId: ownerUserId,
            avatarId: threadAvatarId,
            conversationId,
            runtime: response.runtime,
            durationMs: Date.now() - chatStart,
          },
          "external chat completed",
        );
        emitRunEvent(runId, "done", { message: assistantMessage, response });
        return { ok: true };
      }

      // Load plugin roots (read-only): default plugins + the avatar's own + its
      // personal knowledge repo + group knowledge repos. Shared with the routine
      // scheduler via `loadAgentPluginRoots` so the two can't drift. Tolerate
      // clone/resolve fails.
      const pluginWarnings: string[] = [];
      // Owner-only per-conversation group-knowledge toggle: skip the OFF groups'
      // skills AND their CLAUDE.md. Use this turn's selection when the client sent
      // one, else the stored set. Colleague turns ignore the toggle (always ON).
      const disabledGroupIds = viewerIsOwner
        ? new Set(
            requestedGroupKnowledgeOff ??
              store.getConversationGroupKnowledgeOff(
                ownerUserId,
                conversationId,
              ),
          )
        : new Set<string>();
      // Model tier for this turn: this turn's pick if the client sent one ("" =
      // explicit reset to default), else the stored value. Ignored downstream when
      // ANTHROPIC_MODEL pins a model (env pin is a hard lock).
      const conversationModelTier =
        requestedModel === null
          ? store.getConversationModel(ownerUserId, conversationId)
          : requestedModel || null;
      // Effort for this turn: this turn's pick if sent ("" = reset to default),
      // else the stored value. Mirrors the model tier resolution above.
      const conversationEffort =
        requestedEffort === null
          ? store.getConversationEffort(ownerUserId, conversationId)
          : requestedEffort || null;
      // Group-agent runs load ONLY the owning group's repo (with the acting
      // member's tokens) + defaults; native runs load the avatar's full set.
      const pluginRoots = groupAgentHit
        ? await loadGroupAgentPluginRoots(
            store,
            groupAgentHit.groupId,
            ownerUserId,
            config,
            (warn) => pluginWarnings.push(warn),
          )
        : await loadAgentPluginRoots(
            store,
            avatar.id,
            config,
            (warn) => pluginWarnings.push(warn),
            {
              disabledGroupIds,
              // Bot runs load only the knowledge-repo skills the owner granted
              // this bot (empty = none); defaults/plugins/groups are unchanged.
              ...(personalAgentHit
                ? {
                    personalAgent: {
                      selectedSkills: personalAgentHit.agent.selectedSkills,
                    },
                  }
                : {}),
            },
          );
      // Standing CLAUDE.md memory (personal repo always; group repos gated by the
      // toggle). Read after plugin roots ensured the clones for this turn.
      const knowledgeMemory = groupAgentHit
        ? await loadGroupAgentKnowledgeMemory(
            store,
            groupAgentHit.groupId,
            config,
          )
        : await loadKnowledgeRepoMemory(store, avatar.id, config, {
            disabledGroupIds,
            // A bot's standing memory is the CLAUDE.md inside its OWN folder,
            // never the owner's repo-root one.
            ...(personalAgentHit
              ? {
                  personalAgentMemoryRoot: personalAgentMemoryRoot(
                    personalAgentHit.agent.memoryDir,
                  ),
                }
              : {}),
          });

      for (const warn of pluginWarnings) {
        emitRunEvent(runId, "status", { label: `플러그인 경고: ${warn}` });
      }

      const response = await runAgentStream(
        {
          message: agentMessage,
          // A bot speaks as ITSELF while running with the OWNER's
          // capability: the id stays the owner's (every capability key in
          // runPlan reads it, and AgentOwner resolves commit identity from
          // that user row) while only the conversational identity moves to
          // the bot. `personalAgentState` carries no persona TEXT, so this
          // is the ONLY channel a bot's persona can reach the prompt on.
          // `??`, not `||`: an EMPTY bot alias/persona must stay empty
          // rather than inherit the owner's — a persona-less bot must never
          // recite its owner's persona as its own instructions.
          avatar: {
            id: avatar.id,
            displayName:
              personalAgentHit?.agent.displayName ?? avatar.displayName,
            alias: personalAgentHit?.agent.alias ?? avatar.alias,
            persona: personalAgentHit?.agent.persona ?? avatar.persona,
          },
          // Lets in-process tools (open_repo/close_repo) key the working-repo
          // selection to this conversation.
          conversationId,
          // Working repository: the opened repo's clone becomes the cwd and the
          // per-conversation scratch dir is exposed as an additional writable dir.
          cwd: activeRepoCwd ?? workspaceDir,
          additionalDirs: activeRepoCwd ? [workspaceDir] : undefined,
          // Noah's own public origin, so copy_image can hand the agent an
          // absolute clipboard-staging URL to open with new_tab. Derived
          // from THIS request to match the origin the user's browser is on.
          appOrigin: ctx.appOrigin,
          // The bridge drives THIS browser, so its UA is the only platform
          // signal we have for the paste shortcut (Cmd+V vs Ctrl+V).
          viewerPlatform: ctx.viewerPlatform,
          activeRepoName: activeRepoName ?? undefined,
          resumeSessionId,
          conversationHistory,
          images: requestImages.length ? requestImages : undefined,
          // Text-only turn: the model gets the staged file PATHS in the user
          // prompt instead of image content blocks.
          imageFiles: requestImageFiles.length
            ? requestImageFiles
            : undefined,
          modelTier: conversationModelTier ?? undefined,
          effort: conversationEffort ?? undefined,
          mcpToolGroups: effectiveMcpToolGroupsForRun,
          viewerUserId: ownerUserId,
          viewerName: ctx.ownerDisplayName,
          viewerIsOwner,
          knowledgeMemory,
          // Elevated tool permissions for the owner OR a trusted user. The tool
          // gate denies everyone else, so auto-approving the elevated path is safe.
          // (Group-agent runs carry capability via `groupAgent` instead.)
          elevated: elevatedViewer,
          // WHY a non-owner viewer is elevated, when group co-membership is the
          // source: the shared group names surface in the prompt (META-COGNITION).
          trustedViaGroups:
            groupAgentHit || ownerUserId === avatar.id
              ? []
              : store.sharedGroupNames(ownerUserId, avatar.id),
          // Group shared-agent run kind: pins the run to ONE group's
          // resources and carries the acting member's role/capture right.
          groupAgent: groupAgentHit
            ? {
                groupId: groupAgentHit.groupId,
                agentId: groupAgentHit.agent.id,
                groupName: groupAgentHit.groupName,
                viewerRole: groupAgentHit.viewerRole,
                captureAllowed: groupAgentCaptureAllowed(
                  groupAgentHit.agent,
                  groupAgentHit.viewerRole,
                ),
              }
            : undefined,
          // Personal-agent run kind: IDENTITY only (prompt/self-config/
          // describe_system). Capability stays the owner's — `avatar` above
          // is the owner's own row and `groupAgent` must stay unset, or the
          // run loses the owner tools this bot is meant to have.
          personalAgent: personalAgentHit
            ? {
                agentId: personalAgentHit.agent.id,
                ownerUserId: ownerUserId,
                // Lets the bot report on ITS OWN task (report_task) without the
                // model having to be told which row it is working. Bookkeeping,
                // never capability — same contract as the parent field.
                ...(botTask.row ? { taskId: botTask.row.id } : {}),
              }
            : undefined,
          autoApprove: true,
          // Unattended delegated work falls down the tier chain on a transient
          // model failure, exactly like a routine — there is no live viewer to
          // hand the "try another model" nudge to.
          ...(ctx.modelFallback ? { modelFallback: true } : {}),
          // Provenance stamp from the task runner: an EXTERNAL SYSTEM submitted
          // this instruction through the owner's task API. Capability is
          // unchanged (still a full owner run) — the flag only reaches the
          // prompt, describe_system, and the interactive-only tool gates.
          ...(ctx.externalTaskId ? { externalTaskApi: true } : {}),
        },
        pluginRoots,
        config,
        store,
        {
          // Mid-turn messages: the run loop yields whatever lands here into the
          // CLI's stdin and feeds its command_lifecycle frames back, which is
          // what drives the `steer` frames subscribed above.
          steers,
          onDelta: (text) => {
            streamedText += text;
            emitRunEvent(runId, "delta", { text });
          },
          onThinking: (text) => {
            streamedThinking += text;
            emitRunEvent(runId, "thinking", { text });
          },
          // Empty-turn retry: drop the discarded attempt's reasoning so the kept
          // turn's thinking isn't shown/persisted glued onto the throwaway one.
          onThinkingReset: () => {
            streamedThinking = "";
            emitRunEvent(runId, "thinking_reset", {});
          },
          // A newer text block superseded the answer streamed so far: the
          // interim narration is demoted to the reasoning view so the bubble
          // keeps only the LAST block, and nothing is lost.
          onTextFold: (text) => {
            // Demoted narration joins the reasoning stream (persisted as
            // response.thinking)…
            streamedThinking += (streamedThinking ? "\n\n" : "") + text;
            // …and leaves the answer: cancel/error tails must not resurrect it.
            foldedTextOffset = streamedText.length;
            // Anchors index into the answer text, and the answer just
            // restarted from empty — every stamped card now belongs before
            // the new tail.
            for (const attachment of shownAttachments) {
              if (typeof attachment.anchor === "number") attachment.anchor = 0;
            }
            emitRunEvent(runId, "text_fold", {});
          },
          onStatus: (label) => {
            emitRunEvent(runId, "status", { label });
          },
          onModel: (model) => {
            observedModel.set(model);
            observedRunModel = model;
          },
          onSessionId: (sessionId) => {
            runSessionId = sessionId;
          },
          onPlugin: (event) => {
            emitRunEvent(runId, "plugin", {
              status: event.status,
              name: event.name,
            });
          },
          onToolStart: (event) => {
            emitRunEvent(runId, "tool", event);
          },
          onToolEnd: (event) => {
            emitRunEvent(runId, "tool_end", event);
          },
          onTaskStart: (event) => {
            emitRunEvent(runId, "task", event);
          },
          onTaskUpdate: (event) => {
            emitRunEvent(runId, "task_update", event);
          },
          onTaskEnd: (event) => {
            emitRunEvent(runId, "task_end", event);
          },
          onAgentStart: (event) => {
            emitRunEvent(runId, "agent", event);
          },
          onAgentEnd: (event) => {
            emitRunEvent(runId, "agent_end", event);
          },
          // Live background-task set (REPLACE semantics). Relayed so the
          // client can show a "백그라운드 작업 진행 중" indicator, and mirrored
          // onto the run snapshot so reloads/new-POST 409s know the state.
          onBackgroundTasks: (event) => {
            if (turnFinalized) {
              markRunBackground(runId, event.tasks.length);
            }
            emitRunEvent(runId, "bg_tasks", { tasks: event.tasks });
          },
          // Result boundary. First boundary with live background tasks →
          // finalize the visible turn NOW (persist + done{background:true})
          // while the SDK session keeps running underneath; every later
          // boundary is a wake-up turn delivered as a NEW assistant message.
          onTurnResult: (segment) => {
            if (!turnFinalized) {
              if (segment.backgroundTasks.length === 0) {
                if (!segment.steerPending) {
                  return; // normal turn — the post-await done path handles it
                }
                // A mid-turn message the model never got to fold in: the CLI
                // runs it as a SECOND turn in this same session, so the run
                // stays open and the visible segment becomes its own assistant
                // message (a `turn_end` frame, not `done`). Deliberately does
                // NOT set turnFinalized — the follow-up turn's answer is still
                // this run's real `done`.
                if (runSessionId) {
                  store.setAgentSessionId(
                    ownerUserId,
                    conversationId,
                    runSessionId,
                  );
                }
                const thinkingTail = streamedThinking.slice(persistedThinkingOffset);
                const attachmentsTail = shownAttachments.slice(persistedAttachmentsOffset);
                const segResponse: AgentResponse = {
                  kind: "text",
                  runtime: config.agentRuntime,
                  summary: "Claude Agent SDK 실행이 완료되었습니다.",
                  text: segment.text || STEER_TURN_END_PLACEHOLDER,
                  ...(latestPlan ? { plan: latestPlan } : {}),
                  ...(thinkingTail ? { thinking: thinkingTail } : {}),
                  ...(segment.usage ? { usage: segment.usage } : {}),
                };
                const message =
                  store.conversationOwner(conversationId) === ownerUserId
                    ? store.addMessage(conversationId, {
                        role: "assistant",
                        content: segResponse.text,
                        response: segResponse,
                        attachments: attachmentsTail,
                      })
                    : null;
                emitRunEvent(runId, "turn_end", {
                  message,
                  response: segResponse,
                });
                persistedTextOffset = streamedText.length;
                persistedThinkingOffset = streamedThinking.length;
                persistedAttachmentsOffset = shownAttachments.length;
                // The plan belongs to the segment just persisted; the follow-up
                // turn carries its own (or none).
                latestPlan = null;
                return;
              }
              turnFinalized = true;
              markRunBackground(runId, segment.backgroundTasks.length);
              // Persist the session id NOW: the phase can outlive tab
              // closes, and the next turn must resume this transcript.
              if (runSessionId) {
                store.setAgentSessionId(
                  ownerUserId,
                  conversationId,
                  runSessionId,
                );
              }
              const segResponse: AgentResponse = {
                kind: "text",
                runtime: config.agentRuntime,
                summary: "Claude Agent SDK 실행이 완료되었습니다.",
                text: segment.text || BACKGROUND_TURN_PLACEHOLDER,
                ...(latestPlan ? { plan: latestPlan } : {}),
                ...(streamedThinking ? { thinking: streamedThinking } : {}),
                ...(segment.usage ? { usage: segment.usage } : {}),
              };
              const message =
                store.conversationOwner(conversationId) === ownerUserId
                  ? store.addMessage(conversationId, {
                      role: "assistant",
                      content: segResponse.text,
                      response: segResponse,
                      attachments: shownAttachments.slice(),
                    })
                  : null;
              persistedTextOffset = streamedText.length;
              persistedThinkingOffset = streamedThinking.length;
              persistedAttachmentsOffset = shownAttachments.length;
              emitRunEvent(runId, "done", {
                message,
                response: segResponse,
                background: true,
                tasks: segment.backgroundTasks,
              });
              return;
            }
            // Wake-up turn finished → its own assistant message. Skip pure
            // bookkeeping boundaries (no text, no new attachments).
            const text = segment.text.trim();
            const thinkingTail = streamedThinking.slice(persistedThinkingOffset);
            const attachmentsTail = shownAttachments.slice(persistedAttachmentsOffset);
            persistedTextOffset = streamedText.length;
            persistedThinkingOffset = streamedThinking.length;
            persistedAttachmentsOffset = shownAttachments.length;
            if (!text && attachmentsTail.length === 0) {
              return;
            }
            const segResponse: AgentResponse = {
              kind: "text",
              runtime: config.agentRuntime,
              summary: "백그라운드 작업 보고",
              text: text || "(백그라운드 작업이 종료되었습니다.)",
              ...(thinkingTail ? { thinking: thinkingTail } : {}),
              ...(segment.usage ? { usage: segment.usage } : {}),
            };
            const message =
              store.conversationOwner(conversationId) === ownerUserId
                ? store.addMessage(conversationId, {
                    role: "assistant",
                    content: segResponse.text,
                    response: segResponse,
                    attachments: attachmentsTail,
                  })
                : null;
            if (message) {
              emitRunEvent(runId, "bg_message", { message });
            }
          },
          onBlocked: (event) => {
            emitRunEvent(runId, "blocked", event);
          },
          onMemory: (event) => {
            // Stable id: an SSE reattach replays the whole event log, and
            // the client dedupes 기억 rows by this id.
            emitRunEvent(runId, "memory", { id: crypto.randomUUID(), ...event });
          },
          // Compaction happened (or failed). Same id discipline as 기억 —
          // a reattach replays the log and the client dedupes on it.
          onCompact: (event) => {
            emitRunEvent(runId, "compact", { id: crypto.randomUUID(), ...event });
          },
          // Plan mode: the avatar submitted a plan via ExitPlanMode. Surface it as
          // a dedicated plan card (display-only) and keep the latest one to persist
          // on the assistant response so it rebuilds on reload.
          onPlan: (event) => {
            // EnterPlanMode emits an empty-plan "planning" signal; only a real plan
            // (ExitPlanMode) is worth persisting on the response.
            if (event.plan) latestPlan = event.plan;
            emitRunEvent(runId, "plan", {
              plan: event.plan,
              planning: event.planning ?? false,
            });
          },
          // Interactive plan approval (owner only). The avatar proposed a plan
          // via ExitPlanMode; park the run and emit the plan to the client,
          // which shows approve/reject controls on the plan card. Approve →
          // the avatar implements; reject → feed the feedback back so it revises.
          onPlanReview: async (requestData) => {
            const requestId = crypto.randomUUID();
            emitRunEvent(runId, "plan_review", {
              runId,
              requestId,
              plan: requestData.plan,
            });
            const answer = await awaitResponse(runId, requestId);
            if (answer === CANCELLED) {
              // Run ended / cancelled / timed out before an answer: treat as a
              // rejection (no feedback) so the avatar never barrels ahead with
              // an unapproved plan.
              return { behavior: "rejected" };
            }
            const reply = answer as { behavior?: string; feedback?: string };
            return reply?.behavior === "approved"
              ? { behavior: "approved" }
              : { behavior: "rejected", feedback: reply?.feedback };
          },
          // Interactive permission prompt (owner only — see claudeAgent).
          onPermission: async (requestData) => {
            const requestId = crypto.randomUUID();
            emitRunEvent(runId, "permission", {
              runId,
              requestId,
              ...requestData,
            });
            const answer = await awaitResponse(runId, requestId);
            if (answer === CANCELLED) {
              // TTL expiry / stop / run end — nobody clicked anything.
              // Marked so the hook doesn't misreport it as a user refusal.
              return { behavior: "deny", unanswered: true };
            }
            return (answer as { behavior: "allow" }).behavior === "allow"
              ? { behavior: "allow" }
              : { behavior: "deny" };
          },
          // AskUserQuestion (and other request_user_dialog kinds).
          onQuestion: async (requestData) => {
            const requestId = crypto.randomUUID();
            emitRunEvent(runId, "question", {
              runId,
              requestId,
              dialogKind: requestData.dialogKind,
              payload: requestData.payload,
            });
            const answer = await awaitResponse(runId, requestId);
            if (answer === CANCELLED) {
              return { behavior: "cancelled" };
            }
            const reply = answer as { cancelled?: boolean; result?: unknown };
            if (reply?.cancelled) {
              return { behavior: "cancelled" };
            }
            return { behavior: "completed", result: reply?.result };
          },
          // Visual canvas (experimental `canvas` feature, #50). Mirror the
          // question wiring: emit the artifact over SSE, and when controls were
          // declared (awaitInput) park the run until the user submits via
          // /api/chat/respond. Always record the artifact so it persists.
          onCanvas: async (requestData) => {
            const requestId = crypto.randomUUID();
            const {
              artifactId,
              title,
              content,
              contentType,
              controls,
              interaction,
              editable,
            } = requestData;
            emitRunEvent(runId, "canvas", {
              runId,
              requestId,
              artifactId,
              title,
              content,
              contentType,
              // Pass controls WHENEVER present (not only when blocking) so an async
              // canvas's form still renders client-side.
              controls: controls ?? null,
              interaction: interaction ?? null,
              editable: Boolean(editable),
            });
            const record = (submittedValues?: Record<string, unknown>) => {
              // Persist to the dedicated canvas tables (version history). Refining
              // the same id appends a version; an unchanged re-show just refreshes
              // the submission.
              store.upsertCanvasArtifact(ownerUserId, conversationId, {
                artifactId,
                title,
                content,
                contentType,
                controls,
                submittedValues,
                interaction,
                editable,
              });
            };
            if (!requestData.awaitInput) {
              record();
              return { behavior: "shown" };
            }
            const answer = await awaitResponse(runId, requestId);
            if (answer === CANCELLED) {
              record();
              return { behavior: "cancelled" };
            }
            const reply = answer as {
              cancelled?: boolean;
              deleteCanvas?: boolean;
              values?: Record<string, unknown>;
            };
            if (reply?.deleteCanvas) {
              store.deleteCanvasArtifact(ownerUserId, artifactId);
              return { behavior: "cancelled" };
            }
            if (reply?.cancelled) {
              record();
              return { behavior: "cancelled" };
            }
            record(reply?.values ?? {});
            return { behavior: "submitted", values: reply?.values ?? {} };
          },
          // Browser bridge. Same emit-and-park shape as onCanvas, but the
          // responder is the user's browser extension, not a person: park
          // for BROWSER_OP_TTL_MS, and read a silent timeout as "the bridge
          // isn't there" rather than "the user declined".
          onBrowser: async (requestData) => {
            const requestId = crypto.randomUUID();
            // Stored secrets riding THIS op, name → plaintext. Collected once:
            // it decides whether the frame may be replayed, and it is the
            // redaction set applied to the extension's reply below. NEVER
            // logged, never audited, never put in a status label.
            const secretValues: Record<string, string> = {};
            if (requestData.secret && typeof requestData.secretText === "string") {
              secretValues[requestData.secret.name] = requestData.secretText;
            }
            for (const field of requestData.fields ?? []) {
              if (field.secret && typeof field.secretValue === "string") {
                secretValues[field.secret.name] = field.secretValue;
              }
            }
            const carriesSecret = Object.keys(secretValues).length > 0;
            emitRunEvent(
              runId,
              "browser",
              {
                runId,
                requestId,
                op: requestData.op,
                url: requestData.url ?? null,
                name: requestData.name ?? null,
                kind: requestData.kind ?? null,
                uid: requestData.uid ?? null,
                x: typeof requestData.x === "number" ? requestData.x : null,
                y: typeof requestData.y === "number" ? requestData.y : null,
                xFraction:
                  typeof requestData.xFraction === "number" ? requestData.xFraction : null,
                yFraction:
                  typeof requestData.yFraction === "number" ? requestData.yFraction : null,
                toUid: requestData.toUid ?? null,
                toX: typeof requestData.toX === "number" ? requestData.toX : null,
                toY: typeof requestData.toY === "number" ? requestData.toY : null,
                toXFraction:
                  typeof requestData.toXFraction === "number" ? requestData.toXFraction : null,
                toYFraction:
                  typeof requestData.toYFraction === "number" ? requestData.toYFraction : null,
                text: requestData.text ?? null,
                // Secret input: the POLICY the extension re-enforces at the
                // keyboard, and the plaintext on its OWN field. `secretText` is
                // never `text`, so an extension that predates secret input types
                // nothing rather than typing a credential unguarded.
                secret: requestData.secret ?? null,
                secretText: requestData.secretText ?? null,
                submit: Boolean(requestData.submit),
                clear: Boolean(requestData.clear),
                keystrokes: Boolean(requestData.keystrokes),
                key: requestData.key ?? null,
                modifiers: requestData.modifiers ?? null,
                repeat: requestData.repeat ?? null,
                direction: requestData.direction ?? null,
                pixels: requestData.pixels ?? null,
                accept: typeof requestData.accept === "boolean" ? requestData.accept : null,
                promptText: requestData.promptText ?? null,
                textGone: requestData.textGone ?? null,
                timeoutS: requestData.timeoutS ?? null,
                tabId: requestData.tabId ?? null,
                fields: requestData.fields ?? null,
                option: requestData.option ?? null,
                fullPage: typeof requestData.fullPage === "boolean" ? requestData.fullPage : null,
                offset: requestData.offset ?? null,
                expand: typeof requestData.expand === "boolean" ? requestData.expand : null,
                maxChars: typeof requestData.maxChars === "number" ? requestData.maxChars : null,
              },
              // A frame carrying a plaintext secret is written to the live
              // clients and NOT kept in the run's replay buffer: it would
              // otherwise sit there for the rest of the turn and be re-sent
              // verbatim to every reconnecting client.
              carriesSecret ? { replay: false } : undefined,
            );
            const answer = await awaitResponse(runId, requestId, BROWSER_OP_TTL_MS);
            if (answer === CANCELLED) {
              return {
                behavior: "error",
                message:
                  "The browser bridge did not respond. The Noah tab may be closed, the extension may not be installed, or no tab is attached. " +
                  "Ask the user to open Noah in the browser you should drive and attach a tab, then retry — there is no other way to reach their browser.",
              };
            }
            // Redact every secret this op carried out of the extension's reply
            // BEFORE anything reads it — the audit row, the size gates, the
            // model-facing result. A page that echoes a typed password into its
            // own DOM (or a bridge note that quotes a field) would otherwise
            // carry the plaintext straight into the turn.
            const reply = (
              carriesSecret ? redactSecretValues(answer, secretValues).value : answer
            ) as {
              ok?: boolean;
              message?: string;
              snapshot?: string;
              snapshotError?: string;
              note?: string;
              url?: string;
              title?: string;
              tabs?: BrowserTab[];
              dialog?: { type?: string; message?: string; defaultPrompt?: string };
              imageBase64?: string;
              imageMimeType?: string;
              landedOn?: string;
              pageText?: string;
              pageTextOffset?: number;
              pageTextTotal?: number;
              cookies?: BrowserCookie[];
              storage?: BrowserStorageEntry[];
              storageKind?: "local" | "session";
            };
            if (!reply?.ok) {
              const raw =
                reply?.message ||
                "The browser extension refused the operation without a reason. Report this to the user rather than retrying.";
              // "Unsupported operation" is the OLD extension build's
              // catch-all for an op it predates. The old build cannot
              // explain itself, so translate here: without this the model
              // retries other new ops and fails the same way.
              const message = /unsupported operation/i.test(raw)
                ? `${raw} The browser extension installed in the user's browser is an OLDER build than this server, so it does not know this operation (and will refuse every other recently added one too). Tell the user to update it: download the extension zip again from 설정 → 접근/보안 → 브라우저 브릿지, replace the previously loaded folder's contents, then press the reload (↻) button on that extension's card in the browser's extensions page (chrome://extensions, or edge://extensions on Edge) — the card must show the new version number afterwards. Until then, use only snapshot/navigate/click/type and the tab tools.`
                : raw;
              return { behavior: "error", message };
            }
            // read_cookies returns the CURRENT tab origin's cookies. This route
            // is the primary size gate on extension-supplied strings, so bound
            // the count and every field BEFORE anything reads them: the values
            // are secrets, the names are page-controlled untrusted text, and
            // both ride into the model turn. Shape-validate each entry so a
            // hostile/oversized reply can't smuggle an unbounded payload. Used
            // by BOTH the audit (names only, below) and the return.
            const cookies =
              requestData.op === "read_cookies" && Array.isArray(reply.cookies)
                ? reply.cookies.slice(0, 300).flatMap((c: unknown): BrowserCookie[] => {
                    if (!c || typeof c !== "object") return [];
                    const cookie = c as Record<string, unknown>;
                    if (typeof cookie.name !== "string") return [];
                    return [
                      {
                        name: cookie.name.slice(0, 4_096),
                        value: typeof cookie.value === "string" ? cookie.value.slice(0, 8_192) : "",
                        domain: typeof cookie.domain === "string" ? cookie.domain.slice(0, 512) : "",
                        path: typeof cookie.path === "string" ? cookie.path.slice(0, 2_048) : "",
                        httpOnly: cookie.httpOnly === true,
                        secure: cookie.secure === true,
                        sameSite:
                          typeof cookie.sameSite === "string"
                            ? cookie.sameSite.slice(0, 32)
                            : undefined,
                        expires:
                          typeof cookie.expires === "number" && cookie.expires > 0
                            ? cookie.expires
                            : undefined,
                      },
                    ];
                  })
                : undefined;
            // read_storage returns the CURRENT tab origin's localStorage or
            // sessionStorage. Same treatment as cookies: this route is the
            // primary size gate, the values are secrets and the keys are
            // page-controlled untrusted text, and both ride into the model turn.
            // Shape-validate each entry so a hostile/oversized reply can't
            // smuggle an unbounded payload. Used by BOTH the audit (key NAMES
            // only, below) and the return.
            const storage =
              requestData.op === "read_storage" && Array.isArray(reply.storage)
                ? reply.storage.slice(0, 300).flatMap((e: unknown): BrowserStorageEntry[] => {
                    if (!e || typeof e !== "object") return [];
                    const entry = e as Record<string, unknown>;
                    if (typeof entry.key !== "string") return [];
                    return [
                      {
                        key: entry.key.slice(0, 4_096),
                        value: typeof entry.value === "string" ? entry.value.slice(0, 8_192) : "",
                      },
                    ];
                  })
                : undefined;
            // Which store was read — authoritative from what WE asked for (the
            // extension keys its read off this exact value), normalized so a
            // bad field can only ever read "session", never leak or throw.
            const storageKind =
              requestData.op === "read_storage"
                ? requestData.kind === "local"
                  ? "local"
                  : "session"
                : undefined;
            // Audit every ACTION against the user's live session, plus the
            // DELIBERATE reads (screenshot/read_text/read_cookies — the
            // exfiltration surface an admin wants rows for). `snapshot`,
            // `wait_for` and `dialog_status` are skipped: the first two fire
            // between every step, and the third is a pure status read the agent
            // makes when it is confused about why a page won't respond — all
            // three would bury the rows that matter and none of them touches the
            // page. read_cookies logs the host + cookie NAMES + count only —
            // NEVER a cookie value.
            // URLs are scrubbed of userinfo and query string — an audit row
            // is admin-visible and a query string routinely carries tokens.
            if (
              requestData.op !== "snapshot" &&
              requestData.op !== "wait_for" &&
              requestData.op !== "dialog_status"
            ) {
              audit({
                action: `browser_${requestData.op}`,
                detail: [
                  `op=${requestData.op}`,
                  requestData.uid ? `uid=${requestData.uid}` : "",
                  typeof requestData.x === "number" && typeof requestData.y === "number"
                    ? `at=(${requestData.x},${requestData.y})`
                    : "",
                  // click_at's uid mode: the point is relative to the
                  // element above, so the row needs both to be readable.
                  typeof requestData.xFraction === "number" &&
                  typeof requestData.yFraction === "number"
                    ? `rel=(${requestData.xFraction},${requestData.yFraction})`
                    : "",
                  // drag's END, in whichever mode the start was given.
                  requestData.toUid ? `toUid=${requestData.toUid}` : "",
                  typeof requestData.toX === "number" && typeof requestData.toY === "number"
                    ? `to=(${requestData.toX},${requestData.toY})`
                    : "",
                  typeof requestData.toXFraction === "number" &&
                  typeof requestData.toYFraction === "number"
                    ? `relTo=(${requestData.toXFraction},${requestData.toYFraction})`
                    : "",
                  requestData.key
                    ? `key=${(requestData.modifiers ?? []).map((m) => `${m}+`).join("")}${requestData.key}${requestData.repeat && requestData.repeat > 1 ? ` x${requestData.repeat}` : ""}`
                    : "",
                  requestData.fields ? `fields=${requestData.fields.length}` : "",
                  // Browser secret input: the NAME only. The value never
                  // reaches an admin-visible row, and neither does `text`.
                  requestData.secret ? `secret=${requestData.secret.name}` : "",
                  requestData.fields?.some((f) => f.secret)
                    ? `secrets=[${requestData.fields
                        .flatMap((f) => (f.secret ? [f.secret.name] : []))
                        .join(",")}]`
                    : "",
                  requestData.option ? `option=${requestData.option.slice(0, 80)}` : "",
                  // A type that REPLACED what the field held, rather than
                  // adding to it — the destructive half of the same op.
                  requestData.clear ? "clear" : "",
                  requestData.expand ? "expand" : "",
                  // read_cookies: NAMES + count only. `cookies` above holds
                  // `.value` too, but only `.name` is ever read here — a cookie
                  // value must never reach an admin-visible audit row.
                  requestData.op === "read_cookies" && cookies
                    ? `cookies=${cookies.length} names=[${cookies
                        .map((c) => c.name)
                        .join(",")
                        .slice(0, 400)}]`
                    : "",
                  // read_storage: storage kind + KEY NAMES + count only. Same
                  // rule as cookies — `storage` holds `.value` too, but only
                  // `.key` is ever read here; a stored value must never reach an
                  // admin-visible audit row.
                  requestData.op === "read_storage" && storage
                    ? `storage=${storageKind} entries=${storage.length} keys=[${storage
                        .map((e) => e.key)
                        .join(",")
                        .slice(0, 400)}]`
                    : "",
                  `url=${scrubAuditUrl(reply.url || requestData.url)}`,
                ]
                  .filter(Boolean)
                  .join(" "),
              });
            }
            // The screenshot rides the parked reply as base64. Bound it
            // here — a runaway payload must fail the one tool call, not
            // balloon the model turn.
            if (typeof reply.imageBase64 === "string" && reply.imageBase64.length > 8_000_000) {
              return {
                behavior: "error",
                message:
                  "The screenshot was too large to relay. Capture a smaller area: the viewport (no fullPage) or a single element via uid.",
              };
            }
            // Screenshot auto-share: the model sees the capture — persist
            // the SAME bytes for the user as a download card + hidden
            // preview slide (the card+panel shape share_file produces), so
            // the user can open exactly what the avatar looked at, live
            // and after reload. Best-effort BY DESIGN: a publish failure
            // must not fail the tool call, and the note keeps the model's
            // self-knowledge honest about whether the user got a copy.
            let shareNote: string | undefined;
            let sharedAttachments: MessageAttachment[] | undefined;
            if (
              requestData.op === "screenshot" &&
              typeof reply.imageBase64 === "string" &&
              reply.imageBase64
            ) {
              if (sharedScreenshotCount >= MAX_SHARED_SCREENSHOTS_PER_MESSAGE) {
                shareNote = `This capture was NOT shared with the user — this turn already shared ${MAX_SHARED_SCREENSHOTS_PER_MESSAGE} screenshots. The user has not seen it; continue in the next turn if they need it.`;
              } else if (store.conversationOwner(conversationId) !== ownerUserId) {
                shareNote =
                  "This capture was NOT shared with the user: the conversation no longer exists.";
              } else {
                const published = publishBrowserScreenshot(
                  config,
                  conversationId,
                  Buffer.from(reply.imageBase64, "base64"),
                  typeof reply.title === "string" ? reply.title : undefined,
                );
                if ("error" in published) {
                  shareNote =
                    "This capture could NOT be shared with the user as a file card — the user has not seen it.";
                } else {
                  sharedScreenshotCount += 1;
                  sharedAttachments = [published.file, published.slide];
                  for (const attachment of sharedAttachments) {
                    shownAttachments.push(attachment);
                    emitRunEvent(runId, "file", { runId, attachment });
                  }
                  shareNote =
                    "This capture was also shared with the user as a file card in the chat (it opens in the preview panel), so they can already see it — no need to re-send or exhaustively re-describe it.";
                }
              }
            }
            return {
              behavior: "ok",
              shareNote,
              sharedAttachments,
              // Every field below is UNTRUSTED extension input that rides into
              // the model turn, and this route is the PRIMARY size gate
              // (browserTools.report adds only a model-facing snapshot cap for
              // old extension builds). Bound each explicitly and shape-validate
              // tabs[] so a hostile/oversized reply can't blow up the turn or
              // smuggle an unbounded payload.
              snapshot:
                typeof reply.snapshot === "string" ? reply.snapshot.slice(0, 200_000) : undefined,
              // Why the post-action snapshot is missing. One line, not a
              // stack: it rides into the model turn like everything else.
              snapshotError:
                typeof reply.snapshotError === "string"
                  ? reply.snapshotError.slice(0, 1_000)
                  : undefined,
              // A bridge-authored caveat about the op's outcome (a repaired
              // or unverifiable clear). Short by construction on the
              // extension side; bounded here because it lands OUTSIDE the
              // untrusted wrapper, where a long one would read as ours.
              note:
                typeof reply.note === "string" && reply.note
                  ? reply.note.slice(0, 500)
                  : undefined,
              url: typeof reply.url === "string" ? reply.url.slice(0, 4_000) : undefined,
              title: typeof reply.title === "string" ? reply.title.slice(0, 2_000) : undefined,
              tabs: Array.isArray(reply.tabs)
                ? reply.tabs.slice(0, 100).flatMap((t: unknown) => {
                    if (!t || typeof t !== "object") return [];
                    const tab = t as {
                      tabId?: unknown;
                      title?: unknown;
                      url?: unknown;
                      current?: unknown;
                    };
                    if (typeof tab.tabId !== "string") return [];
                    return [
                      {
                        tabId: tab.tabId.slice(0, 200),
                        title: typeof tab.title === "string" ? tab.title.slice(0, 300) : "",
                        url: typeof tab.url === "string" ? tab.url.slice(0, 2_000) : "",
                        current: tab.current === true,
                      },
                    ];
                  })
                : undefined,
              dialog:
                reply.dialog && typeof reply.dialog.message === "string"
                  ? {
                      type: typeof reply.dialog.type === "string" ? reply.dialog.type : "alert",
                      message: reply.dialog.message,
                      defaultPrompt:
                        typeof reply.dialog.defaultPrompt === "string"
                          ? reply.dialog.defaultPrompt
                          : undefined,
                    }
                  : undefined,
              image:
                typeof reply.imageBase64 === "string" && reply.imageBase64
                  ? {
                      base64: reply.imageBase64,
                      // Whitelisted mime types only — this string lands in an
                      // API image block, and the extension is semi-trusted.
                      mimeType:
                        reply.imageMimeType === "image/png" || reply.imageMimeType === "image/webp"
                          ? reply.imageMimeType
                          : "image/jpeg",
                    }
                  : undefined,
              // Bounded: a one-line element description, not a page dump —
              // the extension is semi-trusted and this rides into the model.
              landedOn:
                typeof reply.landedOn === "string" && reply.landedOn
                  ? reply.landedOn.slice(0, 300)
                  : undefined,
              pageText:
                typeof reply.pageText === "string"
                  ? {
                      text: reply.pageText.slice(0, 200_000),
                      offset:
                        typeof reply.pageTextOffset === "number" && reply.pageTextOffset >= 0
                          ? reply.pageTextOffset
                          : 0,
                      total:
                        typeof reply.pageTextTotal === "number" && reply.pageTextTotal >= 0
                          ? reply.pageTextTotal
                          : reply.pageText.length,
                    }
                  : undefined,
              // Already bounded + shape-validated above; the values are secrets
              // and reach only the model context + conversation history, never a
              // log or the audit row.
              cookies,
              // Same posture as cookies: bounded + shape-validated above,
              // secret values reach only the model turn + history, and
              // storageKind is authoritative from the request.
              storage,
              storageKind,
            };
          },
          onFile: async (requestData) => {
            // Separate per-turn caps: visible images guard the bubble from
            // spam; hidden publishes (canvas slide embeds) only cost disk,
            // so a whole deck fits in one turn.
            const visibleImages = shownAttachments.filter(
              (a) => a.kind === "image" && !a.hidden,
            ).length;
            const hiddenImages = shownAttachments.filter(
              (a) => a.kind === "image" && a.hidden,
            ).length;
            if (requestData.hidden && hiddenImages >= MAX_HIDDEN_CHAT_IMAGES_PER_MESSAGE) {
              return {
                behavior: "error",
                message: `This turn already published ${MAX_HIDDEN_CHAT_IMAGES_PER_MESSAGE} hidden images. Reuse the URLs you already have or continue in the next turn.`,
              };
            }
            if (!requestData.hidden && visibleImages >= MAX_CHAT_IMAGES_PER_MESSAGE) {
              return {
                behavior: "error",
                message: `This turn already showed ${MAX_CHAT_IMAGES_PER_MESSAGE} images. Do not show more in the same response.`,
              };
            }
            if (store.conversationOwner(conversationId) !== ownerUserId) {
              return {
                behavior: "error",
                message: "The conversation no longer exists, so the image cannot be shown.",
              };
            }
            const result = publishWorkspaceImage(
              config,
              conversationId,
              requestData.path,
              [activeRepoCwd ?? workspaceDir, ...(activeRepoCwd ? [workspaceDir] : [])],
              requestData.caption,
            );
            if ("error" in result) {
              const messages = {
                OUTSIDE_WORKSPACE: "The image path must stay inside the current working directory or conversation scratch workspace. Do not use Read on the image. Copy it into the current directory with Bash (for example: cp /tmp/image.png \"$PWD/image.png\"), then retry show_file with ./image.png.",
                NOT_FOUND: "The image file does not exist.",
                NOT_FILE: "The supplied path is not a regular file.",
                EMPTY: "The image file is empty.",
                TOO_LARGE: "The image is larger than the 5 MB limit.",
                UNSUPPORTED: "Unsupported image format. show_file accepts PNG, JPEG, WebP, or GIF files whose bytes match the format.",
                READ_FAILED: "The image file could not be read.",
              } as const;
              return { behavior: "error", message: messages[result.error] };
            }
            const attachment = requestData.hidden
              ? { ...result.attachment, hidden: true }
              : result.attachment;
            shownAttachments.push(attachment);
            emitRunEvent(runId, "file", {
              runId,
              attachment,
            });
            return {
              behavior: "shown",
              attachment,
              url: `/api/conversations/${encodeURIComponent(conversationId)}/images/${encodeURIComponent(attachment.id)}`,
            };
          },
          onShareFile: async (requestData) => {
            if (sharedFileCount >= MAX_CHAT_FILES_PER_MESSAGE) {
              return {
                behavior: "error",
                message: `This turn already shared ${MAX_CHAT_FILES_PER_MESSAGE} files. Do not share more in the same response.`,
              };
            }
            if (store.conversationOwner(conversationId) !== ownerUserId) {
              return {
                behavior: "error",
                message: "The conversation no longer exists, so the file cannot be shared.",
              };
            }
            const result = publishWorkspaceFile(
              config,
              conversationId,
              requestData.path,
              [activeRepoCwd ?? workspaceDir, ...(activeRepoCwd ? [workspaceDir] : [])],
              requestData.name,
            );
            if ("error" in result) {
              const maxMb = Math.round(MAX_CHAT_FILE_BYTES / (1024 * 1024));
              const messages = {
                OUTSIDE_WORKSPACE: "The file path must stay inside the current working directory or conversation scratch workspace. Copy it into the current directory with Bash (for example: cp /tmp/deck.pptx \"$PWD/deck.pptx\"), then retry share_file with ./deck.pptx.",
                NOT_FOUND: "The file does not exist.",
                NOT_FILE: "The supplied path is not a regular file.",
                EMPTY: "The file is empty.",
                TOO_LARGE: `The file is larger than the ${maxMb} MB limit.`,
                UNSUPPORTED: `Unsupported file type. share_file accepts: ${SHAREABLE_EXTENSIONS.map((e) => `.${e}`).join(", ")} — and the content must match the extension. There is no Bash or Markdown workaround for delivering other file types.`,
                READ_FAILED: "The file could not be read.",
              } as const;
              return { behavior: "error", message: messages[result.error] };
            }
            sharedFileCount += 1;
            shownAttachments.push(result.attachment);
            emitRunEvent(runId, "file", {
              runId,
              attachment: result.attachment,
            });
            // Auto-render page previews SERVER-SIDE (pptx/docx/xlsx/pdf →
            // hidden PNG attachments on this same message) so the agent
            // never has to rasterize and publish slides one by one.
            // Best-effort: a missing toolchain or a render failure still
            // delivers the file, just without the panel preview.
            let previewCount = 0;
            const stored = resolveStoredFile(config, conversationId, result.attachment.id);
            if (stored && isPreviewableExtension(stored.ext)) {
              const pages = await renderDocumentPreviews(stored.path, stored.ext);
              if (pages.length) {
                const previewAttachments = savePreviewImages(
                  config,
                  conversationId,
                  pages,
                  result.attachment.id,
                );
                previewCount = previewAttachments.length;
                for (const attachment of previewAttachments) {
                  shownAttachments.push(attachment);
                  emitRunEvent(runId, "file", { runId, attachment });
                }
              }
            }
            return {
              behavior: "shown",
              attachment: result.attachment,
              url: `/api/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(result.attachment.id)}`,
              previews: previewCount,
            };
          },
        },
        abortController,
      );

      // Canvases shown this turn are already persisted to the dedicated tables by
      // the onCanvas handler (with version history); they no longer ride the
      // response JSON. The live panel is driven by the SSE "canvas" events. (#50)
      // Carry the plan submitted this turn (plan mode) so the plan card persists
      // and rebuilds on reload.
      if (latestPlan) {
        response.plan = latestPlan;
      }
      // Carry the turn's reasoning so the collapsible "생각 과정" view rebuilds
      // on reload (streaming path only — headless runs emit no onThinking).
      // Only the TAIL since the last persisted boundary: a run whose turn was
      // cut by a mid-turn message already stored the earlier reasoning on that
      // segment's own message. With no boundary the offset is 0 and this is the
      // whole string, exactly as before.
      const thinkingTail = streamedThinking.slice(persistedThinkingOffset);
      if (thinkingTail) {
        response.thinking = thinkingTail;
      }

      // Remember this run's SDK session so the next turn resumes its context.
      if (runSessionId) {
        store.setAgentSessionId(ownerUserId, conversationId, runSessionId);
      }
      audit({
        action: "chat",
        detail: `chat with ${threadAvatarLabel} (${response.runtime})`,
      });
      logger.info(
        {
          userId: ownerUserId,
          avatarId: threadAvatarId,
          conversationId,
          runtime: response.runtime,
          background: turnFinalized,
          durationMs: Date.now() - chatStart,
        },
        "chat completed",
      );
      // Settle the task BEFORE the terminal frame: `done`/`bg_end`/`cancelled`/
      // `error` are what tell the client the run is over, and it stops reading
      // there — a task frame behind one would only surface on the next refetch.
      settleBotTask("done");
      if (turnFinalized) {
        // Background phase over: the visible turn and every wake-up report
        // were already persisted at their result boundaries — persisting the
        // aggregate `response` here would duplicate them. Just signal the
        // end of the phase; the run closes in the finally below.
        emitRunEvent(runId, "bg_end", {});
      } else {
        // The conversation may have been deleted mid-run; skip persistence (the FK
        // on messages would reject the insert) and just signal completion.
        const assistantMessage =
          store.conversationOwner(conversationId) === ownerUserId
            ? store.addMessage(conversationId, {
                role: "assistant",
                content: response.text || response.summary,
                response,
                // Same tail rule as the reasoning above: cards already carried
                // by a `turn_end` segment must not be attached twice. Offset 0
                // on an ordinary run, so this is the full array.
                attachments: shownAttachments.slice(persistedAttachmentsOffset),
              })
            : null;
        emitRunEvent(runId, "done", { message: assistantMessage, response });
      }
    } catch (error) {
      if (isRunCancelled(runId)) {
        // Clear the persisted SDK session: the aborted run's transcript is
        // incomplete, so the NEXT turn rebuilds context from stored messages
        // (which now include this cancelled turn's user message + partial)
        // instead of resuming a half-written session that omits it. (chat-02)
        if (!externalAgent) {
          store.setAgentSessionId(ownerUserId, conversationId, null);
        }
        // Keep whatever the model already streamed before the stop. The client's
        // finalizeStopped keeps it on screen, so the persisted record must carry
        // it too — otherwise the visible answer is gone on the next reload/revisit.
        // In a background phase, only the TAIL since the last persisted result
        // boundary belongs here (earlier segments are already stored messages);
        // an empty tail still persists a notice so the kill is visible on reload.
        const cancelledText = streamedText.slice(
          Math.max(persistedTextOffset, foldedTextOffset),
        );
        const cancelledThinking = streamedThinking.slice(persistedThinkingOffset);
        const response: AgentResponse = {
          kind: "text",
          runtime: externalAgent ? "external" : config.agentRuntime,
          summary: "중지됨",
          text: cancelledText,
          ...(latestPlan && !turnFinalized ? { plan: latestPlan } : {}),
          ...(cancelledThinking ? { thinking: cancelledThinking } : {}),
        };
        // Skip the insert if the conversation was deleted mid-run (FK would reject).
        const stopped =
          store.conversationOwner(conversationId) === ownerUserId
            ? store.addMessage(conversationId, {
                role: "assistant",
                content:
                  cancelledText ||
                  (turnFinalized
                    ? "(진행 중이던 백그라운드 작업이 중지되었습니다.)"
                    : "(중지됨)"),
                response,
                attachments: shownAttachments.slice(persistedAttachmentsOffset),
              })
            : null;
        settleBotTask("cancelled");
        emitRunEvent(runId, "cancelled", {
          message: stopped,
          response,
          background: turnFinalized,
        });
        return { ok: true };
      }
      // Scrub before logging too: a git auth failure carries the token in its
      // argv (`http.extraHeader`), which pino's `err` serializer would emit.
      const detail = scrubGitError(error);
      logger.error(
        {
          detail,
          userId: ownerUserId,
          avatarId: threadAvatarId,
          conversationId,
          durationMs: Date.now() - chatStart,
        },
        "chat error",
      );
      audit({ action: "chat", detail, status: "error" });
      // When a TRANSIENT model/server failure ends the turn (overload, rate-limit,
      // 5xx, timeout) AND the model isn't env-pinned (so the picker is available),
      // nudge the user to switch models. Chat never auto-falls-back (a live viewer
      // is watching the stream — only headless routines retry on a lower tier), so
      // this is how a stuck model gets unblocked. Every other failure gets a Korean
      // lead with `detail` appended: the SDK's own text is English, so it can never
      // be the whole bubble. The technical `detail` still goes to logs/audit above.
      const failedTier =
        store.getConversationModel(ownerUserId, conversationId) ??
        DEFAULT_MODEL_TIER;
      const alternatives = MODEL_TIERS.filter((t) => t.id !== failedTier)
        .map((t) => t.label)
        .join(", ");
      // OUR deadline wins the message: the SDK labels every abort as the user's
      // doing, and no user was there to press stop on an unattended task.
      const userFacing = timedOut
        ? botTaskTimeoutMessage(ctx.unattendedDeadlineMs ?? 0)
        : !externalAgent &&
            !config.anthropicModel &&
            isRetryableModelError(error)
          ? `지금 ${modelTierLabel(failedTier)} 모델이 일시적으로 응답하지 못했어요 (서버 과부하 또는 일시적 오류). 입력창의 모델 선택에서 다른 모델(${alternatives})로 바꿔 다시 시도해 보세요.`
          : detail.trim()
            ? `응답 생성 중 오류가 발생했습니다: ${detail}`
            : "응답 생성 중 오류가 발생했습니다.";
      if (store.conversationOwner(conversationId) === ownerUserId) {
        // Clear the session for the same reason as the cancel path (chat-02), and
        // don't discard the partial the user already watched stream — keep it
        // alongside the error so a reload shows what the live view showed.
        if (!externalAgent) {
          store.setAgentSessionId(ownerUserId, conversationId, null);
        }
        // Background phase: earlier segments are already stored messages, so
        // only the tail since the last result boundary rides the error bubble.
        const erroredText = streamedText.slice(
          Math.max(persistedTextOffset, foldedTextOffset),
        );
        const erroredThinking = streamedThinking.slice(persistedThinkingOffset);
        const content = erroredText
          ? `${erroredText}\n\n${userFacing}`
          : userFacing;
        // Any canvas shown before the error is already persisted to the canvas
        // tables by the onCanvas handler. If a plan and/or reasoning was produced,
        // carry it so the plan/thinking cards survive reload; text=content keeps the
        // error bubble identical, and a response is attached only when there's
        // something to carry (plain errors keep their existing null-response shape).
        store.addMessage(conversationId, {
          role: "assistant",
          content,
          attachments: shownAttachments.slice(persistedAttachmentsOffset),
          response:
            (latestPlan && !turnFinalized) || erroredThinking
              ? {
                  kind: "text",
                  runtime: externalAgent ? "external" : config.agentRuntime,
                  summary: "오류",
                  text: content,
                  ...(latestPlan && !turnFinalized ? { plan: latestPlan } : {}),
                  ...(erroredThinking ? { thinking: erroredThinking } : {}),
                }
              : undefined,
        });
      }
      // The same Korean text the thread now carries, so the task card and the
      // bubble never disagree about why the work stopped.
      settleBotTask("failed", userFacing);
      emitRunEvent(runId, "error", {
        error: userFacing,
        background: turnFinalized,
      });
    } finally {
      clearTimeout(deadline);
      closeRun(runId);
      // The thread is free again: let the dispatcher pop its next queued task.
      // AFTER closeRun, or the dispatcher's own active-run guard would see this
      // run still holding the conversation and skip. Fire-and-forget, and it
      // must never throw into a finalize that already succeeded.
      if (personalAgentHit) {
        try {
          deps.onBotTurnSettled?.(ownerUserId, conversationId);
        } catch (err) {
          logger.error(
            { err, conversationId },
            "bot task dispatcher hand-off failed",
          );
        }
      }
    }
    // Outer finally: release the per-clone lock on EVERY exit — normal end, the
    // attachRunClient early-return, OR a throw anywhere in the prelude above
    // (Express 4 won't catch an async throw, and a stranded lock 409s every other
    // conversation for that clone until restart).
  } finally {
    releaseActiveRepoLock?.();
  }
  return { ok: true };
}

export function createChatRouter({
  config,
  store,
  observedModel,
  auditAs,
  onBotTurnSettled,
}: RouterDeps): Router {
  const router = Router();
  const viewerGroupIds = (req: AuthenticatedRequest): Set<string> =>
    new Set((req.user?.groups ?? []).map((group) => group.id));
  const effectiveExternalAgents = () =>
    mergeExternalAgentRegistries(
      config.externalAgents,
      store.getManagedExternalAgents(),
    );
  // Gateway model catalogs for the external-avatar composer picker, cached per
  // agent so opening the settings row doesn't probe the gateway on every hit.
  // Keyed by id+endpoint (an admin rebind changes the endpoint → fresh probe).
  const externalModelCatalogCache = new Map<
    string,
    { at: number; models: string[] }
  >();
  const EXTERNAL_MODEL_CATALOG_TTL_MS = 60_000;

  // ---- Discovery -------------------------------------------------------

  router.get(
    "/api/avatars",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      // External summaries hardcode hasImage:false (pure config); overlay the
      // admin-set profile images stored outside the registry.
      const externalImageIds = store.listExternalAvatarImageIds();
      const avatars = [
        ...store.listPublishedAvatars(req.user!.id),
        // The viewer's OWN personal agents (내 봇, enabled only). Nobody else
        // ever sees them, and the helper returns [] unless the viewer still
        // holds the admin role (the phase-1 feature gate).
        ...listPersonalAgentAvatarSummaries(store, req.user!.id),
        // Shared group agents of the viewer's groups (enabled only) — reach is
        // membership-scoped by the store query, like the native list above.
        ...listGroupAgentAvatarSummaries(store, req.user!.id),
        ...listExternalAvatarSummaries(
          effectiveExternalAgents(),
          viewerGroupIds(req),
        ).map((summary) =>
          externalImageIds.has(summary.id)
            ? { ...summary, hasImage: true }
            : summary,
        ),
      ].sort((a, b) => a.displayName.localeCompare(b.displayName));
      res.json({ avatars });
    },
  );

  router.get(
    "/api/avatars/:id",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const external = findVisibleExternalAgent(
        effectiveExternalAgents(),
        req.params.id,
        viewerGroupIds(req),
      );
      const groupAgentHit = external
        ? null
        : findChattableGroupAgent(store, req.user!.id, req.params.id);
      // Personal agents come last and only for their own owner; a disabled one
      // 404s here exactly like a disabled group agent (discovery hides it).
      const personalAgentHit =
        external || groupAgentHit
          ? null
          : findChattablePersonalAgent(store, req.user!.id, req.params.id);
      const avatar = external
        ? externalAvatarDetail(external)
        : groupAgentHit
          ? groupAgentAvatarDetail(groupAgentHit.agent, groupAgentHit.groupName)
          : personalAgentHit
            ? personalAgentAvatarDetail(personalAgentHit.agent)
            : store.getAvatar(req.user!.id, req.params.id);
      if (!avatar) {
        apiError(res, 404, "아바타를 찾을 수 없습니다.");
        return;
      }
      if (external) {
        // Detail mirrors the list overlay: images live outside the registry.
        avatar.hasImage =
          store.getExternalAvatarImageExt(avatar.id) !== null;
      }
      res.json({ avatar });
    },
  );

  // List the skills an avatar can use, for the explore-page intro dialog.
  // Lazily resolves plugin roots (may clone), so it's a separate endpoint hit
  // only when the dialog opens — not bundled into the avatar detail above.
  // Visibility mirrors getAvatar: must be an avatar visible to the viewer (or their own).
  router.get(
    "/api/avatars/:id/skills",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const external = findVisibleExternalAgent(
        effectiveExternalAgents(),
        req.params.id,
        viewerGroupIds(req),
      );
      const groupAgentHit = external
        ? null
        : findChattableGroupAgent(store, req.user!.id, req.params.id);
      const personalAgentHit =
        external || groupAgentHit
          ? null
          : findChattablePersonalAgent(store, req.user!.id, req.params.id);
      const avatar = external
        ? externalAvatarDetail(external)
        : groupAgentHit
          ? groupAgentAvatarDetail(groupAgentHit.agent, groupAgentHit.groupName)
          : personalAgentHit
            ? personalAgentAvatarDetail(personalAgentHit.agent)
            : store.getAvatar(req.user!.id, req.params.id);
      if (!avatar) {
        apiError(res, 404, "아바타를 찾을 수 없습니다.");
        return;
      }
      if (external) {
        res.json({ skills: [] });
        return;
      }
      // The local runtime loads no plugins/skills, so there's nothing to list.
      if (config.agentRuntime === "local") {
        res.json({ skills: [] });
        return;
      }
      if (groupAgentHit) {
        // A group agent's skills come from the owning group's shared repo only,
        // cloned with the VIEWER's tokens (the standing group-repo pattern).
        const ctx = groupKnowledgeRepoContextFor(
          store,
          groupAgentHit.groupId,
          req.user!.id,
          config,
          groupAgentHit.groupName,
        );
        const sources = await groupKnowledgeRepoSkillSources(ctx ? [ctx] : []);
        res.json({ skills: await listSkillsInRoots(sources) });
        return;
      }
      if (personalAgentHit) {
        // What a bot RUN actually loads: the bundled defaults and the owner's
        // plugin repos unchanged (a bot run is a full owner run there), but the
        // owner's PERSONAL knowledge repo narrowed to the skills they granted
        // this bot — empty grants mean no knowledge-repo skills at all. Resolve
        // against the owner's OWN avatar row: `avatar` here carries the
        // composite `personal:` id, which no skill/plugin loader can key on.
        const owner = store.getAvatar(req.user!.id, req.user!.id);
        if (!owner) {
          res.json({ skills: [] });
          return;
        }
        const { sourced: ownerSources } = await resolveAvatarSkillSources(
          store,
          owner,
          config,
          false,
        );
        // Re-resolve the personal repo under the bot's allowlist rather than
        // filtering resolved roots by name: `selected` is the SAME filter the
        // run applies, so the panel can never advertise a skill the bot would
        // not load.
        const granted = personalAgentHit.agent.selectedSkills;
        const ctx = knowledgeRepoContextFor(store, owner.id, config);
        const botKnowledgeSources =
          granted.length > 0 && ctx
            ? await knowledgeRepoSkillSources({ ...ctx, selected: granted })
            : [];
        res.json({
          skills: await listSkillsInRoots([
            ...ownerSources.filter((s) => s.source !== KNOWLEDGE_REPO_SOURCE),
            ...botKnowledgeSources,
          ]),
        });
        return;
      }
      const { sourced } = await resolveAvatarSkillSources(
        store,
        avatar,
        config,
        false,
      );
      res.json({ skills: await listSkillsInRoots(sourced) });
    },
  );

  // Gateway model catalog for an EXTERNAL avatar's composer model picker.
  // Visibility mirrors getAvatar/skills (shared external visibility helper).
  // Returns the gateway-advertised Claude model ids plus the admin-configured
  // default; a native avatar gets an empty catalog (its picker uses the
  // bootstrap model tiers instead). Probes are cached briefly per agent.
  router.get(
    "/api/avatars/:id/models",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const external = findVisibleExternalAgent(
        effectiveExternalAgents(),
        req.params.id,
        viewerGroupIds(req),
      );
      if (!external) {
        const avatar =
          findChattableGroupAgent(store, req.user!.id, req.params.id) ??
          findChattablePersonalAgent(store, req.user!.id, req.params.id) ??
          store.getAvatar(req.user!.id, req.params.id);
        if (!avatar) {
          apiError(res, 404, "아바타를 찾을 수 없습니다.");
          return;
        }
        // Native, group and personal agents all use the bootstrap model-tier
        // picker (a bot's own tier default rides its AvatarSummary instead).
        res.json({ models: [], defaultModel: null });
        return;
      }
      const cacheKey = `${external.id}\n${external.endpoint}`;
      const cached = externalModelCatalogCache.get(cacheKey);
      if (cached && Date.now() - cached.at < EXTERNAL_MODEL_CATALOG_TTL_MS) {
        res.json({
          models: cached.models,
          defaultModel: external.model ?? null,
        });
        return;
      }
      try {
        const probe = await probeExternalAgentGateway(external);
        externalModelCatalogCache.set(cacheKey, {
          at: Date.now(),
          models: probe.models,
        });
        res.json({ models: probe.models, defaultModel: external.model ?? null });
      } catch (error) {
        logger.warn(
          { externalAgentId: external.id, detail: (error as Error).message },
          "external model catalog probe failed",
        );
        apiError(res, 502, "Gateway 모델 목록을 가져오지 못했습니다.");
      }
    },
  );

  // The owner's registered general git repos, for the active-repo-workspace
  // picker (#47). Returns name/repo/branch only — never the local clone path.
  router.get(
    "/api/me/git-repos",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      res.json({
        repos: store
          .listGitRepos(req.user!.id)
          .map((r) => ({ name: r.name, repo: r.repo, branch: r.branch })),
      });
    },
  );

  // ---- Conversations & messages ---------------------------------------

  router.get(
    "/api/conversations",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const avatarId = safeString(req.query.avatarId) || undefined;
      const kindRaw = safeString(req.query.kind);
      const kind =
        kindRaw === "routine" || kindRaw === "all" ? kindRaw : "chat";
      res.json({
        conversations: store
          .listConversations(req.user!.id, avatarId, kind)
          .map((conversation) => {
            const external = findExternalAgent(
              effectiveExternalAgents(),
              conversation.avatarUserId,
            );
            // Live run state (in-memory map lookup per row) so the sidebar can
            // badge a conversation that is still working — the only in-app signal
            // once the user navigates away from its pane.
            const active = getActiveRunForConversation(
              req.user!.id,
              conversation.id,
            );
            return {
              ...conversation,
              ...(external ? { avatarDisplayName: external.displayName } : {}),
              activeRun: active ? { background: active.background } : null,
            };
          }),
      });
    },
  );

  router.get(
    "/api/messages",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const conversationId = safeString(req.query.conversationId);
      if (!conversationId) {
        res.json({ messages: [] });
        return;
      }
      res.json({
        messages: store.listMessages(req.user!.id, conversationId),
        // Owner-only group-knowledge toggle state for this conversation (group ids
        // turned OFF). The client shows the toggle only for the owner's own avatar.
        groupKnowledgeOff: store.getConversationGroupKnowledgeOff(
          req.user!.id,
          conversationId,
        ),
        // The user's chosen model tier for this conversation (null = server default),
        // so the composer picker restores on reload.
        selectedModel: store.getConversationModel(req.user!.id, conversationId),
        // The user's chosen effort level for this conversation (null = SDK default),
        // so the composer picker restores on reload.
        selectedEffort: store.getConversationEffort(
          req.user!.id,
          conversationId,
        ),
        // MCP tool groups chosen for this conversation. null means the default-all
        // selection; [] means the user explicitly disabled every optional MCP group.
        selectedMcpToolGroups: store.getConversationMcpToolGroups(
          req.user!.id,
          conversationId,
        ),
        // Visual-canvas artifacts (current version of each) so the side panel rebuilds
        // on reload from the dedicated tables, not from message.response.canvases (#50).
        canvases: store.listCanvasArtifacts(req.user!.id, conversationId),
      });
    },
  );

  // Canvas version history + non-destructive rollback (#50). User-initiated UI,
  // owner-gated in the store; not agent-facing.
  router.get(
    "/api/chat/canvases/:id/versions",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      res.json({
        versions: store.listCanvasVersions(req.user!.id, req.params.id),
      });
    },
  );

  router.post(
    "/api/chat/canvases/:id/rollback",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const version = Number(req.body?.version);
      if (!Number.isInteger(version) || version < 1) {
        apiError(res, 400, "잘못된 버전입니다.");
        return;
      }
      const artifact = store.rollbackCanvasArtifact(
        req.user!.id,
        req.params.id,
        version,
      );
      if (!artifact) {
        apiError(res, 404, "캔버스 또는 버전을 찾을 수 없습니다.");
        return;
      }
      res.json({ canvas: artifact });
    },
  );

  // Hard-delete a persisted canvas (closing its tab). Owner-gated in the store.
  router.delete(
    "/api/chat/canvases/:id",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const ok = store.deleteCanvasArtifact(req.user!.id, req.params.id);
      if (!ok) {
        apiError(res, 404, "캔버스를 찾을 수 없습니다.");
        return;
      }
      res.json({ ok: true });
    },
  );

  // Persist the activity-tree snapshot (tools/agents the avatar ran) onto a stored
  // assistant message so the completed bubble keeps showing it after reload. The
  // client posts its already-humanized snapshot once the turn finishes.
  router.put(
    "/api/messages/:id/activity",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const ok = store.setMessageActivity(
        req.user!.id,
        req.params.id,
        sanitizeActivity(req.body?.activity),
      );
      if (!ok) {
        apiError(res, 404, "메시지를 찾을 수 없습니다.");
        return;
      }
      res.json({ ok: true });
    },
  );

  router.patch(
    "/api/conversations/:id",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const title = safeString(req.body?.title);
      const conversation = store.renameConversation(
        req.user!.id,
        req.params.id,
        title,
      );
      if (!conversation) {
        apiError(res, 404, "대화를 찾을 수 없습니다.");
        return;
      }
      res.json({ conversation });
    },
  );

  router.delete(
    "/api/conversations",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const ownerId = req.user!.id;
      const ids = store
        .listConversations(ownerId, undefined, "chat")
        .map((conversation) => conversation.id);
      for (const id of ids) {
        const active = getActiveRunForConversation(ownerId, id);
        if (active) {
          cancelRun(active.runId, ownerId);
        }
      }
      const deletedIds = store.deleteChatConversations(ownerId);
      for (const id of deletedIds) {
        deleteConversationImages(config, id);
        deleteConversationFiles(config, id);
      }
      res.json({
        ok: true,
        deleted: deletedIds.length,
        conversationIds: deletedIds,
      });
    },
  );

  router.delete(
    "/api/conversations/:id",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      // Cancel any in-flight run for this conversation first so it stops streaming
      // and its cancel/error path skips the (now-impossible) message persistence
      // instead of racing the row deletion. (lifecycle-03)
      const active = getActiveRunForConversation(req.user!.id, req.params.id);
      if (active) {
        cancelRun(active.runId, req.user!.id);
      }
      const removed = store.deleteConversation(req.user!.id, req.params.id);
      if (!removed) {
        apiError(res, 404, "대화를 찾을 수 없습니다.");
        return;
      }
      // Sweep the conversation's uploaded chat images + generated files (best effort).
      deleteConversationImages(config, req.params.id);
      deleteConversationFiles(config, req.params.id);
      res.json({ ok: true });
    },
  );

  // Serve a chat-message image attachment. Owner-scoped: only the conversation's
  // owner may read its images (matches listMessages' ownership gate). The id is
  // validated against path traversal inside resolveStoredImage.
  router.get(
    "/api/conversations/:conversationId/images/:imageId",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const { conversationId, imageId } = req.params;
      if (store.conversationOwner(conversationId) !== req.user!.id) {
        apiError(res, 404, "이미지를 찾을 수 없습니다.");
        return;
      }
      const resolved = resolveStoredImage(config, conversationId, imageId);
      if (!resolved) {
        apiError(res, 404, "이미지를 찾을 수 없습니다.");
        return;
      }
      res.type(resolved.mediaType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.sendFile(resolved.path);
    },
  );

  // Serve a generated chat file (agent-shared document) as a DOWNLOAD. Same
  // owner-scoped gate as the image route; `Content-Disposition: attachment`
  // (never inline) so a shared document can't render in-origin. The optional
  // `name` query only picks the save-dialog filename (owner-supplied, sanitized).
  router.get(
    "/api/conversations/:conversationId/files/:fileId",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const { conversationId, fileId } = req.params;
      if (store.conversationOwner(conversationId) !== req.user!.id) {
        apiError(res, 404, "파일을 찾을 수 없습니다.");
        return;
      }
      const resolved = resolveStoredFile(config, conversationId, fileId);
      if (!resolved) {
        apiError(res, 404, "파일을 찾을 수 없습니다.");
        return;
      }
      const requestedName = sanitizeDownloadName(
        typeof req.query.name === "string" ? req.query.name : undefined,
      );
      const downloadName = requestedName ?? `file.${resolved.ext}`;
      const asciiFallback = downloadName.replace(/[^ -~]+/g, "_").replace(/"/g, "'") || `file.${resolved.ext}`;
      res.type(resolved.mediaType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.sendFile(resolved.path);
    },
  );

  // ---- Chat (SSE) ------------------------------------------------------

  router.post(
    "/api/chat/stream",
    requireAuth(store),
    async (req: AuthenticatedRequest, res) => {
      const rawMessage = safeString(req.body?.message);
      const slashExpansion = expandChatSlashCommand(rawMessage);
      if (slashExpansion.error) {
        apiError(res, 400, slashExpansion.error);
        return;
      }
      // Show/store the literal command the user typed (e.g. "/learn"); feed the
      // EXPANDED prompt to the agent. So the bubble + persisted turn stay "/learn"
      // while the model receives the full instruction. For a normal (non-slash)
      // message the two are identical.
      let displayMessage = rawMessage;
      let agentMessage = slashExpansion.message;
      // Non-blocking canvas interaction (#50): a submission or content edit arrives as
      // a normal turn. The visible bubble is a short Korean summary; the agent gets a
      // formatted English message describing what the user did, referencing the canvas
      // id so the avatar can refine it in place with the same canvasId.
      const canvasSubmission = parseCanvasSubmission(
        req.body?.canvasSubmission,
      );
      if (canvasSubmission) {
        const title = store
          .getCanvasArtifact(req.user!.id, canvasSubmission.canvasId)
          ?.title?.trim();
        const ref = title
          ? `the canvas "${title}" (id: ${canvasSubmission.canvasId})`
          : `the canvas (id: ${canvasSubmission.canvasId})`;
        const parts: string[] = [];
        if (canvasSubmission.values) {
          parts.push(`On ${ref}, ${formatSubmission(canvasSubmission.values)}`);
        }
        if (canvasSubmission.editedContent) {
          parts.push(
            `The user edited ${ref} content to:\n${canvasSubmission.editedContent}`,
          );
        }
        agentMessage = parts.join("\n\n") || `The user interacted with ${ref}.`;
        displayMessage = canvasSubmission.editedContent
          ? "캔버스를 수정해 보냈습니다."
          : "캔버스 응답을 보냈습니다.";
      }
      const avatarId = safeString(req.body?.avatarId);

      // Image attachments on this turn (data URLs from the composer). Validate +
      // decode up front so a bad/oversized upload stays plain JSON (before SSE).
      // Bytes are written to disk in the persist block below; the model is fed
      // `requestImages` this turn.
      const decodedImagesResult = decodeChatImages(req.body?.images);
      if ("error" in decodedImagesResult) {
        apiError(res, 400, CHAT_IMAGE_ERROR[decodedImagesResult.error]);
        return;
      }
      const decodedImages = decodedImagesResult.images;

      // Validate BEFORE switching to SSE so failures stay plain JSON. A turn with
      // image attachments but no text is allowed (the images are the message).
      if (!displayMessage && decodedImages.length === 0) {
        apiError(res, 400, "메시지를 입력해 주세요.");
        return;
      }
      if (!avatarId) {
        apiError(res, 400, "avatarId가 필요합니다.");
        return;
      }
      const resolved = resolveChatTarget({
        store,
        externalAgents: effectiveExternalAgents(),
        viewerGroupIds: viewerGroupIds(req),
        viewerUserId: req.user!.id,
        avatarId,
        hasImages: decodedImages.length > 0,
        ownerOnlyCommand: slashExpansion.ownerOnly === true,
      });
      if (!resolved.ok) {
        apiError(res, resolved.refusal.status, resolved.refusal.message);
        return;
      }
      const { externalAgent, personalAgentHit, avatar, threadAvatarId, viewerIsOwner } =
        resolved.target;
      // Owner-only per-conversation group-knowledge selection, chosen in the UI and
      // sent with the turn: the group ids turned OFF (skills + CLAUDE.md). The client
      // owns this state from the moment a chat starts, so no separate persist step is
      // needed; the server applies it this turn and stores it on the conversation.
      // Colleague turns ignore it (always all-on); null = client sent nothing → keep
      // whatever is already stored.
      const requestedGroupKnowledgeOff =
        viewerIsOwner && Array.isArray(req.body?.groupKnowledgeOff)
          ? (req.body.groupKnowledgeOff as unknown[]).filter(
              (x): x is string => typeof x === "string",
            )
          : null;

      // Per-conversation model tier chosen in the composer (all viewers, not just
      // the owner). A known tier alias applies; "" clears back to the server default;
      // anything else (incl. nothing sent) → null = keep whatever is already stored.
      // The client owns this and sends it on each turn, so it works from a brand-new
      // chat with no row yet. The composer ALSO writes the choice to a per-user
      // default (PUT /api/me/chat-defaults → users.model_default) that seeds the next
      // new conversation's pane; this per-conversation value still overrides that
      // default for an already-started thread.
      // External conversations reuse the same slot for the GATEWAY model id the
      // viewer picked (validated syntactically here; the gateway is the authority
      // on whether the id actually exists). Native turns keep tier-alias semantics.
      const rawModel = safeString(req.body?.model);
      const requestedModel: string | null =
        req.body?.model === undefined || req.body?.model === null
          ? null
          : externalAgent
            ? isSafeExternalModelId(rawModel)
              ? rawModel
              : "" // sent but not a usable model id (incl. empty) → clear to default
            : isModelTier(rawModel)
              ? rawModel
              : ""; // sent but not a known tier (incl. empty) → clear to default

      // Per-conversation reasoning effort, same client-owned model as the tier
      // above: a known level applies; "" clears back to the SDK default; nothing
      // sent → null = keep whatever is already stored. Like the tier, the composer
      // also writes a per-user default (users.effort_default) that seeds new panes.
      const rawEffort = safeString(req.body?.effort);
      const requestedEffort: string | null =
        req.body?.effort === undefined || req.body?.effort === null
          ? null
          : isEffortLevel(rawEffort)
            ? rawEffort
            : ""; // sent but not a known level (incl. empty) → clear to default

      // Per-conversation MCP tool-group selection from the composer. Unknown IDs are
      // ignored; an explicit [] means "disable all optional MCP groups". Missing
      // means keep the conversation's stored choice, or default-all for a new chat.
      const rawMcpToolGroups = req.body?.mcpToolGroups;
      let requestedMcpToolGroups: McpToolGroupId[] | null = null;
      if (rawMcpToolGroups !== undefined && rawMcpToolGroups !== null) {
        if (!Array.isArray(rawMcpToolGroups)) {
          apiError(res, 400, "MCP 도구 설정이 올바르지 않습니다.");
          return;
        }
        requestedMcpToolGroups = normalizeMcpToolGroups(rawMcpToolGroups);
      }

      const suppliedConversationId = safeString(req.body?.conversationId);
      if (suppliedConversationId && !isSafePathId(suppliedConversationId)) {
        apiError(res, 400, "대화 ID가 올바르지 않습니다.");
        return;
      }
      // Reject a supplied id that already belongs to ANOTHER user before any DB
      // write: otherwise touchConversation falls through to an INSERT that hits the
      // conversations PRIMARY KEY and throws (an unhandled rejection on Express 4).
      if (suppliedConversationId) {
        const owner = store.conversationOwner(suppliedConversationId);
        if (owner && owner !== req.user!.id) {
          apiError(res, 409, "사용할 수 없는 대화 ID입니다.");
          return;
        }
      }
      const conversationId = suppliedConversationId || crypto.randomUUID();
      const existingAvatarId = store.getConversationAvatarId(
        req.user!.id,
        conversationId,
      );
      if (existingAvatarId && existingAvatarId !== threadAvatarId) {
        apiError(res, 409, "이 대화는 다른 아바타의 대화입니다.");
        return;
      }
      /**
       * A 내 봇 thread QUEUES instead of refusing: the whole point of delegating
       * is that the owner can hand over the next piece of work without waiting
       * for the current one. The message is persisted NOW (so the thread reads
       * in the order it was typed) and a `queued` task carries the replay text
       * the dispatcher will run once the active run settles.
       *
       * `userMessagePersisted` distinguishes the two refusal sites: the
       * pre-flight check has written nothing yet, the raced re-check already
       * wrote the user turn.
       */
      const queueBotTurn = (refusal: ChatTurnRefusal): void => {
        if (req.body?.regenerate === true) {
          // Re-running a turn against a busy bot has no queue semantics — the
          // answer it would replace is still being written.
          apiError(res, refusal.status, refusal.message);
          return;
        }
        if (decodedImages.length > 0) {
          if (refusal.userMessagePersisted) {
            // The bytes are already on the stored bubble; queueing would run the
            // text alone and silently drop them. Keep the plain refusal.
            apiError(res, refusal.status, refusal.message);
            return;
          }
          apiError(
            res,
            400,
            "봇이 작업 중일 때는 이미지 없이 텍스트만 보낼 수 있어요. 작업이 끝난 뒤 다시 시도해 주세요.",
          );
          return;
        }
        if (store.countQueuedBotTasks(conversationId) >= MAX_QUEUED_BOT_TASKS) {
          apiError(
            res,
            429,
            `이 봇의 대기열이 가득 찼습니다(최대 ${MAX_QUEUED_BOT_TASKS}개). 진행 중인 작업이 끝난 뒤 다시 시도해 주세요.`,
          );
          return;
        }
        if (!refusal.userMessagePersisted) {
          store.touchConversation(
            req.user!.id,
            conversationId,
            threadAvatarId,
            displayMessage,
          );
          store.addMessage(conversationId, {
            role: "user",
            content: displayMessage,
          });
        }
        const task = store.createBotTask({
          ownerUserId: req.user!.id,
          agentId: personalAgentHit!.agent.id,
          conversationId,
          title: botTaskTitle(displayMessage),
          requestText: displayMessage,
          status: "queued",
        });
        // Plain JSON, never SSE: there is no run to stream yet. The client shows
        // the queued card and picks the run up through /api/chat/runs when the
        // dispatcher starts it.
        res.status(202).json({ queued: true, task });
        // Close the enqueue race: the run we deferred to may have settled
        // between its refusal and this insert, in which case its own settle hook
        // already looked and found an empty queue. Poking the dispatcher again
        // is free — it no-ops while a run still holds the thread.
        onBotTurnSettled?.(req.user!.id, conversationId);
      };

      const outcome = await executeChatTurn(
        { config, store, observedModel, onBotTurnSettled },
        {
          ownerUserId: req.user!.id,
          ownerDisplayName: req.user!.displayName,
          target: resolved.target,
          conversationId,
          agentMessage,
          displayMessage,
          images: decodedImages,
          regenerate: req.body?.regenerate === true,
          requestedModel,
          requestedEffort,
          requestedMcpToolGroups,
          requestedGroupKnowledgeOff,
          // Noah's own public origin, so copy_image can hand the agent an
          // absolute clipboard-staging URL to open with new_tab. Derived
          // from THIS request to match the origin the user's browser is on.
          appOrigin: requestOrigin(req) ?? undefined,
          // The bridge drives THIS browser, so its UA is the only platform
          // signal we have for the paste shortcut (Cmd+V vs Ctrl+V).
          viewerPlatform: viewerPlatformFromUserAgent(req.get("user-agent")),
          audit: (entry) =>
            auditAs(req, entry.action, entry.detail, entry.status),
        },
        {
          // The response becomes an SSE stream only once the run is reserved,
          // so every refusal above stays plain JSON.
          onRunOpen: (runId) => {
            prepareSse(res);
            if (!attachRunClient(runId, req.user!.id, res)) {
              res.end();
              return false;
            }
            emitRunEvent(runId, "open", {
              conversationId,
              avatarId: threadAvatarId,
              runId,
            });
            return true;
          },
        },
      );
      if (!outcome.ok) {
        if (personalAgentHit && outcome.refusal.reason === "active_run") {
          queueBotTurn(outcome.refusal);
          return;
        }
        apiError(res, outcome.refusal.status, outcome.refusal.message);
      }
    },
  );

  router.get(
    "/api/chat/runs",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const conversationId = safeString(req.query.conversationId);
      if (!conversationId) {
        apiError(res, 400, "conversationId가 필요합니다.");
        return;
      }
      res.json({
        run: getActiveRunForConversation(req.user!.id, conversationId),
      });
    },
  );

  router.get(
    "/api/chat/runs/:runId/events",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const runId = safeString(req.params.runId);
      const run = getActiveRun(runId, req.user!.id);
      if (!run) {
        apiError(res, 404, "진행 중인 실행을 찾을 수 없습니다.");
        return;
      }
      const lastEventId = Number(
        req.get("Last-Event-ID") || req.query.since || 0,
      );
      prepareSse(res);
      if (
        !attachRunClient(
          runId,
          req.user!.id,
          res,
          Number.isFinite(lastEventId) ? lastEventId : 0,
        )
      ) {
        res.end();
      }
    },
  );

  router.post(
    "/api/chat/runs/:runId/cancel",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const runId = safeString(req.params.runId);
      if (!cancelRun(runId, req.user!.id)) {
        apiError(res, 404, "진행 중인 실행을 찾을 수 없습니다.");
        return;
      }
      res.json({ ok: true });
    },
  );

  // Send ANOTHER message while the run is still streaming (a "steer"). It is
  // not a new turn: the run's held-open prompt generator writes it to the CLI's
  // stdin, which folds it into the running turn after the next tool call — or
  // starts it as a follow-up turn in the same session. Session cookie only,
  // exactly like /api/chat/respond; personal API keys are never accepted here.
  // Plain text by design: no slash-command expansion, no images, no canvas.
  router.post(
    "/api/chat/runs/:runId/message",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const runId = safeString(req.params.runId);
      const message = safeString(req.body?.message).trim();
      if (!message) {
        apiError(res, 400, "메시지를 입력해 주세요.");
        return;
      }
      if (message.length > MAX_STEER_LENGTH) {
        apiError(res, 400, "메시지가 너무 깁니다.");
        return;
      }
      const pushed = pushRunSteer(runId, req.user!.id, message);
      if (!pushed.ok) {
        if (pushed.reason === "unsupported") {
          apiError(res, 409, "이 대화에서는 응답 중에 메시지를 보낼 수 없습니다.");
        } else if (pushed.reason === "closed") {
          apiError(
            res,
            410,
            "응답이 마무리되는 중이라 전달할 수 없습니다. 응답이 끝난 뒤 다시 보내 주세요.",
          );
        } else if (pushed.reason === "too_many") {
          apiError(res, 409, "전달 대기 중인 메시지가 너무 많습니다.");
        } else {
          apiError(res, 404, "진행 중인 실행을 찾을 수 없습니다.");
        }
        return;
      }
      res.json({ ok: true, steer: publicSteer(pushed.steer) });
    },
  );

  // Answer an interactive prompt (permission / AskUserQuestion) raised mid-run.
  // The run stream stays open on a separate request; this delivers the reply.
  router.post(
    "/api/chat/respond",
    requireAuth(store),
    (req: AuthenticatedRequest, res) => {
      const runId = safeString(req.body?.runId);
      const requestId = safeString(req.body?.requestId);
      if (!runId || !requestId) {
        apiError(res, 400, "runId와 requestId가 필요합니다.");
        return;
      }
      // The value is consumed by onPermission/onQuestion as an object
      // ({behavior} | {cancelled} | {result}); reject a non-object up front.
      const value = req.body?.value;
      if (
        value !== undefined &&
        (typeof value !== "object" || value === null)
      ) {
        apiError(res, 400, "응답 형식이 올바르지 않습니다.");
        return;
      }
      const delivered = submitResponse(runId, requestId, req.user!.id, value);
      if (!delivered) {
        apiError(
          res,
          404,
          "처리할 수 없는 응답입니다(만료되었거나 권한 없음).",
        );
        return;
      }
      res.json({ ok: true });
    },
  );

  return router;
}
