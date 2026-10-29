export type {
  AdminGroupSummary,
  SharedMcpServerUserView,
  SharedMcpServerView,
  SharedMcpTransport,
  AdminPresence,
  AdminStats,
  AdminUserDetail,
  AdminUserSummary,
  AgentActivity,
  AgentResponse,
  AuditEvent,
  AvatarDetail,
  AvatarNotification,
  AvatarSummary,
  AvatarVisibility,
  CanvasArtifact,
  ConversationSummary,
  GroupMember,
  GroupSharedSkill,
  ImageMediaType,
  KnowledgeGraph,
  KnowledgeGraphNode,
  KnowledgeNote,
  KnowledgeRequest,
  MessageAttachment,
  Plugin,
  RepoPluginContents,
  RoutineJob,
  SharedSkill,
  SharedSkillListing,
  SharedSkillManifest,
  SignupMode,
  SkillInfo,
  StoredMessage,
  User,
} from "../../../server/types.js";

export type {
  TodoCounts,
  TodoItem,
  TodoPriority,
  TodoStatus,
} from "../../../shared/todos";

export type {
  ShareLinkSummary,
  ShareViewPayload,
  ShareViewSlide,
} from "../../../shared/shareLinks";

import type { CanvasArtifact, RoutineJob } from "../../../server/types.js";
import type { TodoCounts, TodoItem } from "../../../shared/todos";

/**
 * The 할 일 tab's filters (오늘 = overdue + due today; 예정 = future-dated; 진행 중 =
 * in progress; 전체 = every open item; 완료 / 드랍 = that closed status).
 */
export type TodoFilter = "today" | "upcoming" | "overdue" | "in_progress" | "all" | "done" | "dropped";

/**
 * The ONE client slice of the viewer's to-do list: the 할 일 tab, the chat
 * overlay and the rail badge all read it, so a change in one shows in all.
 * `todayKst`/`counts` are the server's snapshot from the latest response.
 */
export interface TodoState {
  items: TodoItem[];
  todayKst: string;
  counts: TodoCounts;
  loaded: boolean;
}
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
   * Present when Noah pushed it, not the viewer: a consulted teammate avatar's
   * answer (persisted as `kind: "consultation"`). Never a pending "나" bubble,
   * never handed back to the composer when dropped.
   */
  source?: import("../../../server/types.js").MessageConsultationSource;
  /**
   * The persisted user row (`kind: "steer"`, or `"consultation"` with a
   * `source`), `null` when the conversation was
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
  | "brain"
  | "inbox"
  | "routines"
  | "groups"
  | "skills"
  | "settings"
  | "admin"
  /** A PPTX share link's viewer (`#/share/<token>`); not in the rail — only a link opens it. */
  | "share"
  /** The 할 일 tab (`#/todos[/<id>]`). */
  | "todos";
export type SettingsTab = "profile" | "access" | "knowledge";
export type AdminTab =
  | "overview"
  | "users"
  | "mcp"
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
  /** True while reasoning deltas are actively streaming (set on each thinking delta, cleared once answer text / tool / agent / task activity arrives). Drives the live "생각 중…" indicator on the collapsed thinking card. */
  thinkingActive?: boolean;
  liveStatus: string;
  liveRunId: string | null;
  /** Multi-agent activity tree (root "main" + sub-agents) for the live bubble. */
  liveAgents: LiveAgentNode[];
  /** Tool / blocked rows, each owned by an agent in liveAgents. */
  liveTools: LiveToolRow[];
  /** Task rows, tracked separately from normal tool calls. */
  liveTasks: LiveTaskRow[];
  /** Plugin-load chips (name + status). */
  livePlugins: LivePluginChip[];
  /** ms timestamp until which a sticky status label resists a generic overwrite. */
  liveStatusStickyUntil?: number;
  /** The tool whose frame set the current pin: its own progress echo is dropped while it runs. */
  liveStatusPinSource?: string;
  /** The newest server status that arrived while the pin held: shown once the pin lapses (setStatus). */
  liveStatusHeld?: string;
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
  /**
   * 여기서부터 다시: an earlier USER message being edited in place, and the text
   * so far. Sending it rewinds the conversation to that message — it and every
   * row after it are replaced by the edited message and the new answer. Cleared
   * by every send; a rewind the server refused (or never received) restores it.
   */
  rewindEdit?: { messageId: string; draft: string } | null;
  /** Images staged in the composer, not yet sent (data URLs for preview + upload). */
  pendingImages?: PendingImage[];
  /**
   * Locally-held image data URLs keyed by attachment id, so a just-sent user
   * message renders its images instantly (before the bytes are fetchable from
   * the server). On reload this is empty and the bubble falls back to the
   * serving URL (`/api/conversations/:id/images/:imageId`).
   */
  localImages?: Record<string, string>;
  /** User-chosen model TIER alias for this conversation; "" / undefined = server default. */
  modelTier?: string;
  /** User-chosen reasoning effort level for this conversation; "" / undefined = SDK default (high). */
  effort?: string;
  /** MCP tool groups enabled for this conversation; defaults to every group. */
  mcpToolGroups?: McpToolGroupId[];
  /** Visual-canvas artifacts shown in this conversation (#50). */
  canvases: PaneCanvas[];
  /**
   * Files opened as tabs of the right-side panel, next to the canvases (a
   * file-card click; a live .drawio share opens one by itself). Live-only: a
   * reload or another conversation starts with none.
   */
  fileTabs?: PaneFileTab[];
  /** The selected side-panel tab; null/undefined = the default (lib/sidePanel `resolveSideTab`). */
  sideTab?: SideTabRef | null;
  /**
   * `false` once the viewer picks a tab themselves: what the avatar shows next
   * then gets a dot (`sideUnseen`) instead of taking the panel over. A send
   * re-arms it (undefined = following).
   */
  sideFollow?: boolean;
  /** Tab keys (lib/sidePanel `tabKey`) of tabs that changed while another one showed. */
  sideUnseen?: string[];
  /**
   * Highest canvas/file frame id this pane already applied, per run. The server
   * replays a run's whole log on every (re)attach; a replayed frame rebuilds
   * state but never re-selects a tab, re-opens a closed file or re-marks a dot.
   */
  sideSeen?: { runId: string; through: number } | null;
  /**
   * One-shot: the side panel must leave its collapsed strip (an ask for input,
   * a file the viewer opened). SidePanel consumes and clears it.
   */
  sideExpand?: boolean;
  /** Whether the viewer is pinned to the transcript bottom (intent-based follow). */
  stickBottom?: boolean;
  /** Last assistant turn's token usage, for the composer badge. */
  usage?: import("../../../server/types.js").AgentUsage | null;
  abortController?: AbortController | null;
}

/** A file open in the right-side panel; slides = the same message's hidden slide PNGs. */
export interface PaneFileTab {
  attachment: import("../../../server/types.js").MessageAttachment;
  slides: import("../../../server/types.js").MessageAttachment[];
}

/** One tab of the right-side panel: a canvas (artifact id) or an open file (attachment id). */
export interface SideTabRef {
  kind: "canvas" | "file";
  id: string;
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
  /**
   * Addressable teammate name from the retired agent teams. Read-only: only
   * older stored snapshots carry it; new runs never set it.
   */
  name?: string;
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

/** A non-subagent task row in the activity tree. */
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

/** An interactive prompt (AskUserQuestion) awaiting the owner. */
export interface PromptRequest {
  id: string;
  runId: string;
  paneId: string;
  kind: "question";
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
   * Per-conversation model picker config: the selectable tiers. Optional for
   * forward-compat with an older server that omits it.
   */
  modelSelection?: {
    /** Each tier + the pi model id it maps to (`PI_MODEL_MAP`; null under the local stub). */
    tiers: (import("../../../server/modelTiers").ModelTier & {
      model: string | null;
      /** Whether this tier's model accepts image input (admin per-tier policy). */
      vision?: boolean;
    })[];
    /** Vision of the model used when the user picked no tier (admin override/default). */
    defaultVision?: boolean;
  };
  /**
   * Per-conversation reasoning effort picker config: selectable levels + the
   * default level applied when unset.
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
