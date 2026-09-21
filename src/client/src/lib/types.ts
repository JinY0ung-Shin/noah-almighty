export type {
  AdminGroupSummary,
  AdminExternalAgent,
  AdminExternalAgentInput,
  AdminPresence,
  AdminPresenceUser,
  AdminStats,
  AdminUserDetail,
  AdminUserSummary,
  AgentActivity,
  AgentResponse,
  AgentUsage,
  AuditEvent,
  AvatarDetail,
  AvatarNotification,
  AvatarSummary,
  AvatarVisibility,
  BotTask,
  BotTaskStatus,
  CanvasArtifact,
  CanvasContentType,
  CanvasControl,
  ConversationSummary,
  Group,
  GroupAgent,
  GroupAgentCaptureScope,
  GroupMember,
  GroupSharedSkill,
  ImageMediaType,
  KnowledgeGraph,
  KnowledgeGraphNode,
  KnowledgeNote,
  KnowledgeRequest,
  MessageAttachment,
  PersonalAgent,
  Plugin,
  RepoPluginContents,
  RoutineJob,
  SharedSkill,
  SharedSkillFile,
  SharedSkillListing,
  SharedSkillManifest,
  SignupMode,
  SkillInfo,
  StoredMessage,
  User,
} from "../../../server/types.js";

import type { CanvasArtifact, RoutineJob } from "../../../server/types.js";
import type { McpToolGroupId } from "../../../shared/mcpToolGroups";

/**
 * Seed values for a NEW routine, used by the routines empty-state starter
 * cards to open the create modal pre-filled. Client-only: the server never
 * sees a preset, only the routine the user ends up saving.
 */
export interface RoutinePreset {
  name?: string;
  prompt?: string;
  scheduleKind?: RoutineJob["scheduleKind"];
  time?: string;
  daysOfWeek?: number[];
}

/**
 * A mid-turn message ("steer") as the server reports it — on the POST response
 * and on every `steer` SSE frame. `followUp: true` means the model got it AFTER
 * a result boundary, so it starts its own turn inside the same run.
 *
 * Hand-mirrors the `SteerPublic` exported from `src/server/routes/chat.ts`. It
 * is NOT re-exported from `server/types.ts` the way the rest of this barrel is:
 * the type lives in the route module, which `tsconfig.client.json` must not
 * include (it reaches express and better-sqlite3 through its imports). Nothing
 * type-checks across that gap, so keep the two declarations in lockstep.
 */
export interface SteerPublic {
  id: string;
  text: string;
  state: "queued" | "delivered" | "completed" | "dropped";
  createdAt: string;
  followUp: boolean;
  /**
   * The persisted `kind: "steer"` user row, `null` when the conversation was
   * deleted mid-run. Present only on the `delivered` SSE frame — the POST
   * response's steer never carries it, and the other three states omit the key.
   */
  message?: import("../../../server/types.js").StoredMessage | null;
}

/**
 * A steer the server accepted but has NOT handed to the model yet (state
 * `queued` only). Rendered as a dimmed "전달 대기 중" bubble under the transcript
 * until the matching `steer{delivered}` frame replaces it with the persisted
 * user row. Rebuilt from the replayed event log on reattach, never persisted.
 */
export interface PendingSteer {
  id: string;
  text: string;
  createdAt: string;
}

export type ViewName =
  | "explore"
  | "chat"
  | "bots"
  | "brain"
  | "inbox"
  | "routines"
  | "groups"
  | "skills"
  | "settings"
  | "admin";
/** 내 봇 (`agents`) is admin-only — SettingsView hides the tab for everyone else. */
export type SettingsTab = "profile" | "access" | "knowledge" | "agents";
export type AdminTab =
  | "overview"
  | "users"
  | "external-agents"
  | "access"
  | "system"
  | "audit";
export type ChatLayout = "vertical" | "horizontal" | "grid";

/** An image staged in the composer before sending. */
export interface PendingImage {
  /** Client-generated id; reused as the server-side attachment id + filename stem. */
  id: string;
  /** Resized image as a base64 data URL — used for preview AND upload. */
  dataUrl: string;
  /** Original filename for alt text / display. */
  name: string;
  mediaType: import("../../../server/types.js").ImageMediaType;
}

export interface ChatPane {
  id: string;
  avatar: import("../../../server/types.js").AvatarDetail;
  conversationId: string;
  messages: import("../../../server/types.js").StoredMessage[];
  draft: string;
  streaming: boolean;
  liveText: string;
  /** Images published by show_file during the currently streaming assistant turn. */
  liveAttachments: import("../../../server/types.js").MessageAttachment[];
  /** Set when tool/agent activity interrupts the text stream; the next delta inserts a paragraph break so resumed text doesn't run onto the previous line. */
  liveTextBreakPending?: boolean;
  /** Set once this turn's terminal (stop/error) bubble was pushed — stopPane finalizes at the user's stop, and the loop the abort lands in finalizes again when it surfaces; the marker makes the second call (and a buffered done frame) a no-op instead of a second bubble. Cleared by resetLive. */
  turnFinalized?: boolean;
  /** The model's reasoning (extended-thinking) text streamed this turn; shown in a collapsible "생각 과정" view until the turn finishes and the persisted `response.thinking` takes over. */
  liveThinking?: string;
  /** True while reasoning deltas are actively streaming (set on each thinking delta, cleared once answer text / tool / agent / task / plan activity arrives). Drives the live "생각 중…" indicator on the collapsed thinking card. */
  thinkingActive?: boolean;
  /** Plan submitted via ExitPlanMode this turn (plan mode); shown live as a plan card until the turn finishes and the persisted `response.plan` takes over. */
  livePlan?: string;
  /** True between EnterPlanMode and ExitPlanMode: the avatar is composing a plan in the background. Drives a "writing plan…" placeholder card so the turn doesn't look stalled. Cleared once `livePlan` arrives. */
  planPending?: boolean;
  /** Set when the avatar proposed a plan (ExitPlanMode) and is awaiting the owner's approval; drives inline approve/reject controls on the live plan card. Holds the ids needed to answer via /api/chat/respond. Cleared once answered/resolved. */
  planReview?: { requestId: string; runId: string } | null;
  /** A plan-approval submit (approve/reject) is in flight, to disable the controls. */
  planReviewSubmitting?: boolean;
  liveStatus: string;
  liveRunId: string | null;
  /** Multi-agent activity tree (root "main" + sub-agents) for the live bubble. */
  liveAgents: LiveAgentNode[];
  /** Tool / blocked rows, each owned by an agent in liveAgents. */
  liveTools: LiveToolRow[];
  /** SDK task rows, tracked separately from normal tool calls. */
  liveTasks: LiveTaskRow[];
  /** Plugin-load chips (name + status). */
  livePlugins: LivePluginChip[];
  /** ms timestamp until which a sticky status label resists a generic overwrite. */
  liveStatusStickyUntil?: number;
  /** True between done{background:true} and bg_end/cancelled: the visible turn is finalized but the SDK session is still running background work. Drives the background chip + keeps the live activity tree mounted. */
  backgroundPhase?: boolean;
  /** Live background tasks (SDK level signal, REPLACE semantics). */
  backgroundTasks?: BackgroundTaskChip[];
  /** Persisted message id of the finalized turn, so the final activity snapshot lands on it at bg_end/cancel. */
  backgroundMessageId?: string | null;
  groupKnowledgeOff: string[];
  /** Installed skills for this pane's avatar, lazily fetched the first time the slash menu opens (#slash-skills). Drives skill entries in the "/" menu. */
  skills?: import("../../../server/types.js").SkillInfo[];
  /** Guards the one-shot skills fetch (set once the request settles, success or fail). */
  skillsLoaded?: boolean;
  /**
   * Mid-turn messages the server accepted but has not delivered to the model
   * yet. Live-only: `resetLive` clears the list and a reattach rebuilds it from
   * the replayed `steer` frames.
   */
  steers?: PendingSteer[];
  /** A steer POST is in flight — guards a double submit from Enter + the button. */
  steerSending?: boolean;
  /** Images staged in the composer, not yet sent (data URLs for preview + upload). */
  pendingImages?: PendingImage[];
  /**
   * Locally-held image data URLs keyed by attachment id, so a just-sent user
   * message renders its images instantly (before the bytes are fetchable from
   * the server). On reload this is empty and the bubble falls back to the
   * serving URL (`/api/conversations/:id/images/:imageId`).
   */
  localImages?: Record<string, string>;
  /** User-chosen model for this conversation; "" / undefined = server default. Native panes hold a model TIER alias; external panes hold a GATEWAY model id. */
  modelTier?: string;
  /** Gateway model catalog for an EXTERNAL avatar's picker, lazily fetched when the composer settings first open. undefined = not fetched yet, null = fetch failed (default-only picker). */
  externalModels?: string[] | null;
  /** Admin-configured default gateway model id for an EXTERNAL avatar (null = gateway decides), from the same catalog fetch. */
  externalDefaultModel?: string | null;
  /** User-chosen reasoning effort level for this conversation; "" / undefined = SDK default (high). */
  effort?: string;
  /** MCP tool groups enabled for this conversation; defaults to every group. */
  mcpToolGroups?: McpToolGroupId[];
  /** Visual-canvas artifacts shown in this conversation (experimental, #50). */
  canvases: PaneCanvas[];
  /**
   * File attachment opened in the right-side preview panel (slides = the same
   * message's hidden slide PNGs). Takes the canvas panel's slot while open;
   * null/undefined = closed.
   */
  filePreview?: {
    attachment: import("../../../server/types.js").MessageAttachment;
    slides: import("../../../server/types.js").MessageAttachment[];
  } | null;
  /** Which canvas is currently shown in the side panel (artifact id). */
  activeCanvasId?: string | null;
  /** Whether the viewer is pinned to the transcript bottom (intent-based follow). */
  stickBottom?: boolean;
  /** Last assistant turn's token usage, for the composer badge. */
  usage?: import("../../../server/types.js").AgentUsage | null;
  abortController?: AbortController | null;
}

/**
 * A canvas artifact tracked in a pane. Extends the persisted shape with the live
 * fields needed to submit its controls back through /api/chat/respond. Rebuilt
 * from `message.response.canvases` on reload (then `pending` is false / no ids).
 */
export interface PaneCanvas extends CanvasArtifact {
  /** Run + request ids for submitting declared controls (live turns only). */
  runId?: string;
  requestId?: string;
  /** Controls are shown and awaiting the user's submission (blocking canvases only). */
  pending?: boolean;
  /** A submit POST is in flight. */
  submitting?: boolean;
}

/** One agent in the live activity tree; "main" is the root, others nest under parentId. */
export interface LiveAgentNode {
  id: string;
  parentId: string;
  label: string;
  status: "running" | "done" | "failed";
  isMain: boolean;
}

/** A tool/blocked/memory/compact row in the activity tree, owned by an agent. */
export interface LiveToolRow {
  id: string;
  agentId: string;
  kind: "tool" | "task" | "blocked" | "memory" | "compact";
  label: string;
  detail?: string;
  status: "running" | "done" | "failed" | "blocked";
}

/** A non-subagent SDK task row in the activity tree. */
export interface LiveTaskRow {
  id: string;
  agentId: string;
  label: string;
  detail?: string;
  status: "running" | "done" | "failed";
}

export interface LivePluginChip {
  name: string;
  status: string;
}

/** One live background task (SDK level signal), for the background-phase chip. */
export interface BackgroundTaskChip {
  taskId: string;
  taskType?: string;
  description?: string;
}

/** An interactive prompt (permission / AskUserQuestion) awaiting the owner. */
export interface PromptRequest {
  id: string;
  runId: string;
  paneId: string;
  kind: "permission" | "question";
  data: any;
}

export interface BootstrapInfo {
  needsSetup: boolean;
  githubHost: string;
  signupMode: "open" | "closed" | "approval";
  confluenceConfigured: boolean;
  /**
   * False when the deployment's model is text-only (MODEL_VISION=off): the
   * composer hides the image-attach UI. Optional for older servers (absent =
   * assume vision).
   */
  visionEnabled?: boolean;
  /**
   * True when the deployment has speech-to-text configured: the composer shows
   * the mic button and POSTs recordings to `/api/stt`. Optional for older
   * servers (absent = no voice input).
   */
  sttEnabled?: boolean;
  /**
   * Per-conversation model picker config: selectable tiers + whether an env-pinned
   * ANTHROPIC_MODEL locks the choice (then the composer hides the picker). Optional
   * for forward-compat with an older server that omits it.
   */
  modelSelection?: {
    /** Each tier + the concrete model id it resolves to (null when not env-pinned). */
    tiers: (import("../../../server/modelTiers").ModelTier & {
      model: string | null;
      /** Whether this tier's model accepts image input (admin per-tier policy). */
      vision?: boolean;
    })[];
    locked: boolean;
    /** Vision of the model used when the user picked no tier (pin/override/default). */
    defaultVision?: boolean;
  };
  /**
   * Per-conversation reasoning effort picker config: selectable levels + the
   * default level applied when unset. Independent of the model pin (no lock).
   * Optional for forward-compat with an older server that omits it.
   */
  effortSelection?: {
    levels: import("../../../server/effortLevels").EffortLevel[];
    default: string;
  };
}

export interface Toast {
  id: string;
  message: string;
  kind: "ok" | "info" | "warn";
  actionLabel?: string;
  action?: () => void;
  durationMs?: number;
}
