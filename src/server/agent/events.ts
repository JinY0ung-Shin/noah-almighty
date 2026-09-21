import type { SteerChannel } from "./steerChannel.js";

export type PluginStatus = "started" | "installed" | "failed" | "completed";

export interface PluginEvent {
  status: PluginStatus;
  name: string;
}

/** A tool/permission/question belongs to the main agent or a named subagent. */
export const MAIN_AGENT_ID = "main";

/**
 * The model asked to use a tool that is NOT pre-approved. The host decides
 * whether to run it. Only ever raised for the avatar's OWNER (colleagues stay
 * read-only and get an `onBlocked` notice instead). The returned decision is
 * fed back to the SDK as the PreToolUse hook's permission decision.
 */
export interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  /** Short noun phrase from the SDK (e.g. "Read file"), if any. */
  displayName?: string;
  /** Full prompt sentence from the SDK (e.g. "Claude wants to run …"), if any. */
  title?: string;
  description?: string;
  /** Trimmed tool input, for the user to inspect before approving. */
  input: Record<string, unknown>;
  /** Which agent wants the tool: MAIN_AGENT_ID or a subagent's id. */
  agentId: string;
}
export type PermissionDecision =
  | { behavior: "allow" }
  | {
      behavior: "deny";
      /**
       * True when the prompt expired (TTL) or the run ended before ANY answer,
       * as opposed to the owner explicitly clicking 거부. The hook words the
       * deny reason differently so the model never mistakes an unattended
       * prompt for a refusal.
       */
      unanswered?: boolean;
    };

/**
 * The model invoked AskUserQuestion (or another `request_user_dialog` kind).
 * `payload` is forwarded to the client verbatim; the client's answer becomes
 * the dialog result. `cancelled` lets the SDK apply the dialog's default.
 */
export interface QuestionRequest {
  dialogKind: string;
  payload: Record<string, unknown>;
  toolUseId?: string;
}
export type QuestionAnswer = { behavior: "completed"; result: unknown } | { behavior: "cancelled" };

/**
 * The avatar called `mcp__canvas__show` (experimental `canvas` feature, #50).
 * The host forwards the artifact to the client to render in a side panel. When
 * `awaitInput` is true (the avatar declared controls) the runner BLOCKS for the
 * user's submission via the same out-of-band `/api/chat/respond` path used by
 * permission/question prompts; otherwise it returns immediately (display-only).
 */
export interface CanvasRequest {
  /** Stable artifact id, so the client can upsert (live event + persisted copy). */
  artifactId: string;
  title: string;
  content: string;
  contentType: import("../types.js").CanvasContentType;
  /**
   * Declared controls, passed WHENEVER present — not only when blocking — so a
   * non-blocking (async) canvas can still render its form on the client.
   */
  controls?: import("../types.js").CanvasControl[];
  /**
   * The SOLE run-parking signal: true only for a BLOCKING canvas (controls
   * present AND `wait` not false). An async/display-only/editable canvas does
   * NOT park; the user's later answer arrives as a new /api/chat/stream turn.
   */
  awaitInput: boolean;
  /** How input is collected: "blocking" parks the run, "async" does not. Undefined = display-only. */
  interaction?: "blocking" | "async";
  /** The user may edit/annotate the content and send it back as a new turn. */
  editable?: boolean;
}
export type CanvasResult =
  | { behavior: "submitted"; values: Record<string, unknown> }
  | { behavior: "cancelled" }
  | { behavior: "shown" };

/** A local image the avatar wants to publish into the current assistant turn. */
export interface FileOutputRequest {
  /** Relative to the run cwd, or an absolute path inside one of the allowed roots. */
  path: string;
  /** Optional user-facing description displayed below the image. */
  caption?: string;
  /**
   * Publish WITHOUT rendering in the chat bubble: the image is stored and
   * servable by URL (for embedding in a canvas, e.g. rendered slide previews)
   * but stays out of the visible message. Hidden publishes have their own,
   * larger per-turn cap.
   */
  hidden?: boolean;
}

/** A generated document the avatar wants to hand to the user as a download. */
export interface ShareFileRequest {
  /** Relative to the run cwd, or an absolute path inside one of the allowed roots. */
  path: string;
  /** Download filename shown to the user; defaults to the file's basename. */
  name?: string;
}

export type FileOutputResult =
  | {
      behavior: "shown";
      attachment: import("../types.js").MessageAttachment;
      /** Same-origin serving URL (e.g. for canvas markdown embeds / download cards). */
      url: string;
      /**
       * share_file only: page previews the SERVER auto-rendered and attached
       * (0/undefined = none). Lets the tool text tell the model not to publish
       * slides itself.
       */
      previews?: number;
    }
  | { behavior: "error"; message: string };

/** A concrete tool call (NOT a subagent spawn — those use AgentSpawnEvent). */
export interface ToolEvent {
  toolUseId: string;
  name: string;
  /** MAIN_AGENT_ID or the spawning Task tool_use id. */
  agentId: string;
  /** One-line, human-readable summary of the input (path, command, …). */
  inputSummary?: string;
}

/** A background/foreground SDK task that is not necessarily a subagent. */
export interface TaskEvent {
  taskId: string;
  toolUseId?: string;
  taskType?: string;
  subagentType?: string;
  workflowName?: string;
  description?: string;
  prompt?: string;
}

/** Progress or state update for a previously created SDK task. */
export interface TaskUpdateEvent {
  taskId: string;
  status?: string;
  description?: string;
  summary?: string;
  lastToolName?: string;
  error?: string;
  isBackgrounded?: boolean;
}

/** A subagent was spawned via the Task/Agent tool. `agentId` === its tool_use id. */
export interface AgentSpawnEvent {
  agentId: string;
  /** Teammate name for addressable agent-teams spawns (`Agent` with `name:`). */
  name?: string;
  subagentType?: string;
  description?: string;
  /** The parent agent that spawned it (MAIN_AGENT_ID for top-level spawns). */
  parentId: string;
}

/**
 * One live background task, relayed from the SDK's `background_tasks_changed`
 * level signal (REPLACE semantics: each event carries the FULL set).
 */
export interface BackgroundTaskSummary {
  taskId: string;
  /** SDK task-type label, e.g. "local_bash", "subagent". */
  taskType?: string;
  description?: string;
}

/**
 * A turn boundary: the SDK emitted a `result` message. When background tasks
 * are still live at this point the query keeps running (the SDK holds the
 * session open, wakes the model when a task settles, and streams follow-up
 * turns) — each of those follow-ups ends in another TurnResultEvent.
 */
export interface TurnResultEvent {
  /** Main-agent text streamed since the previous result boundary. */
  text: string;
  /** Usage carried by this result message, if any. */
  usage?: import("../types.js").AgentUsage;
  /** In-band error subtype on this result (e.g. error_max_turns), if any. */
  errorSubtype?: string;
  /** Live background tasks at this boundary (empty = the run is truly over). */
  backgroundTasks: BackgroundTaskSummary[];
  /**
   * A steer accepted for this run had not reached the model when this result
   * boundary passed; the CLI will start it as a follow-up turn and the run
   * stays open. The host finalizes the visible segment as its own assistant
   * message (a `turn_end` frame) rather than the run's terminal `done`.
   */
  steerPending?: boolean;
}

/** A tool was denied without an interactive prompt (read-only colleague, deny rule, dontAsk). */
export interface BlockedEvent {
  toolUseId?: string;
  toolName: string;
  agentId: string;
  /**
   * MODEL-facing deny text, mirroring the SDK's `decision_reason` — English, and
   * on a hook deny it is this app's own directive prose. Diagnostic only: the
   * client shows it as a detail, never as the row's label.
   */
  reason?: string;
  /** User-facing (Korean) explanation the client labels the blocked row with. */
  uiReason?: string;
}

/**
 * The avatar saved a note into a second brain: a successful repo write under
 * `wiki/` (personal knowledge repo or a group's shared repo). Surfaced as a
 * dedicated "기억" row in the activity tree — separate from the raw tool rows —
 * so the viewer sees at a glance that a memory was captured. Fired per note
 * write, before the commit that persists it (the standing prompt already
 * drives the avatar to commit right after capturing).
 */
export interface MemoryEvent {
  scope: "personal" | "group";
  /** write_file → "add", edit_file → "update". */
  action: "add" | "update";
  /** Repo-relative note path (always under wiki/). */
  path: string;
  /** The group whose brain was written (scope "group" only). */
  groupName?: string;
}

/**
 * A context compaction completed (compact_boundary) or failed (status
 * compact_result). The live "맥락 정리 중…" status label is transient, so this
 * event is what leaves a DURABLE trace in the activity tree — otherwise a user
 * who looked away never learns the conversation was summarized, and a FAILED
 * compaction stays invisible until the run dies on the context limit.
 */
export interface CompactEvent {
  ok: boolean;
  trigger?: "auto" | "manual";
  preTokens?: number;
  /** SDK English error detail (diagnostic; client shows it as detail, never the row label). */
  error?: string;
}

/**
 * The model submitted a plan via ExitPlanMode (plan mode). The host forwards the
 * plan markdown to the client to render as a dedicated plan card. This is the
 * DISPLAY signal (always fires); a PRESENT owner additionally gets an interactive
 * approval gate via `onPlanReview` (see below), which BLOCKS the run.
 */
export interface PlanEvent {
  /** The plan markdown the model proposed. Empty while still planning. */
  plan: string;
  /**
   * True the moment the model ENTERS plan mode (EnterPlanMode), before any plan
   * exists. Lets the UI show a "writing plan…" placeholder so the turn doesn't
   * look stalled during the (tool-row-suppressed) planning phase. The real plan
   * arrives in a later event with `plan` set and this falsy.
   */
  planning?: boolean;
}

/**
 * The model proposed a plan via ExitPlanMode and the present owner must approve
 * it before the avatar starts implementing. Surfaced to the client as inline
 * approve/reject controls on the plan card; the run blocks on the answer.
 */
export interface PlanReviewRequest {
  /** The plan markdown awaiting approval. */
  plan: string;
  /** The ExitPlanMode tool_use id, for correlating with the display card. */
  toolUseId?: string;
}
export type PlanReviewDecision =
  | { behavior: "approved" }
  | { behavior: "rejected"; feedback?: string };

/**
 * One operation shipped to the VIEWER's own browser through the extension
 * bridge. The chat route emits it over the run's SSE stream and parks; the
 * Noah tab relays it to the extension, which performs the CDP calls and posts
 * the outcome back. No executable string ever crosses this boundary — `op` is
 * a closed set and elements are addressed by snapshot `uid` only.
 */
export interface BrowserRequest {
  op:
    | "snapshot"
    | "navigate"
    | "click"
    | "click_at"
    | "drag"
    | "type"
    | "fill_form"
    | "select_option"
    | "press_key"
    | "scroll"
    | "hover"
    | "navigate_back"
    | "handle_dialog"
    // Pure STATUS read of the tab's dialog state, carrying NO other field:
    // answering a dialog that isn't open is an error, so handle_dialog with no
    // `accept` asks whether one is open at all instead of guessing.
    | "dialog_status"
    | "wait_for"
    | "read_text"
    | "read_cookies"
    | "read_storage"
    | "screenshot"
    | "list_tabs"
    | "new_tab"
    | "select_tab"
    | "close_tab";
  /** navigate/new_tab: absolute http(s) URL. */
  url?: string;
  /**
   * read_cookies: return just this one cookie by name (omit for all).
   * read_storage: return just this one entry by key (omit for all). Reused
   * across both — the field is a single name filter either way.
   */
  name?: string;
  /** read_storage only: which store to read — localStorage vs sessionStorage. */
  kind?: "local" | "session";
  /**
   * Element uid minted by a previous snapshot. Required by click/type/hover,
   * optional on press_key/scroll/click_at (uid mode), and a SCOPE on
   * snapshot/read_text/screenshot — that element's subtree instead of the whole
   * page. Dies with the document it was minted in: a navigation invalidates it.
   */
  uid?: string;
  /** click_at/drag PIXEL mode: coordinates measured on the most recent viewport screenshot image. */
  x?: number;
  /** click_at/drag PIXEL mode: coordinates measured on the most recent viewport screenshot image. */
  y?: number;
  /**
   * click_at/drag UID mode: where inside `uid`'s box to act, as a 0–1 fraction
   * of its width/height (0.5 = centre). Needs no screenshot, so it is the only
   * coordinate action available to a model that cannot receive images.
   */
  xFraction?: number;
  yFraction?: number;
  /** drag UID mode: the element the drag ENDS on (defaults to `uid` itself). */
  toUid?: string;
  /** drag UID mode: where inside the END element's box to release, 0–1. */
  toXFraction?: number;
  toYFraction?: number;
  /** drag PIXEL mode: release coordinates on the most recent viewport screenshot image. */
  toX?: number;
  toY?: number;
  /** type: the literal text to enter. wait_for: text that must appear. */
  text?: string;
  /**
   * type only: enter a STORED SECRET (the owner's vault) instead of `text`. This
   * is the POLICY, not the value — the extension re-checks it at the keyboard
   * (host match, password-field shape, consent popup) because the server's own
   * host pre-check reads the LAST url the bridge reported, which can be stale.
   */
  secret?: { name: string; hosts: string[]; passwordOnly: boolean };
  /**
   * type only: the secret's plaintext, resolved server-side. Deliberately NOT
   * `text`: an extension build that predates secret input reads no `secretText`
   * and types NOTHING (a harmless no-op) instead of typing a credential with
   * none of the guards this field implies. Never logged, never audited, never
   * pushed to the run's replay buffer (the SSE frame carrying it is transient).
   */
  secretText?: string;
  /** type only: press Enter afterwards. */
  submit?: boolean;
  /** type only: replace the field's existing content instead of inserting into it. */
  clear?: boolean;
  /** type only: enter per-character as real key events instead of one insert. */
  keystrokes?: boolean;
  /** press_key only: W3C key value ("Enter", "Escape", "ArrowDown", "a", …). */
  key?: string;
  /** press_key only: held modifier keys. */
  modifiers?: ("Alt" | "Control" | "Meta" | "Shift")[];
  /** press_key only: press the key this many times in one operation. */
  repeat?: number;
  /** scroll only: which way to scroll. */
  direction?: "up" | "down" | "left" | "right";
  /** scroll only: distance in CSS pixels (defaults to ~one viewport). */
  pixels?: number;
  /** handle_dialog only: accept (OK) or dismiss (Cancel) the open dialog. */
  accept?: boolean;
  /** handle_dialog only: input for a prompt() dialog when accepting. */
  promptText?: string;
  /** wait_for only: text that must disappear. */
  textGone?: string;
  /** wait_for only: seconds to keep polling (bounded by the bridge budget). */
  timeoutS?: number;
  /** select_tab/close_tab: a tab id from a previous list_tabs. */
  tabId?: string;
  /**
   * fill_form only: fields to fill, in order. `clear` replaces existing content.
   * A SECRET field carries `value: ""` plus `secret`/`secretValue` — the per-field
   * twins of `secret`/`secretText` above, with the same degrade story.
   */
  fields?: {
    uid: string;
    value: string;
    clear?: boolean;
    secret?: { name: string; hosts: string[]; passwordOnly: boolean };
    secretValue?: string;
  }[];
  /** select_option only: the option's label exactly as the latest snapshot shows it. */
  option?: string;
  /** screenshot only: capture the whole page height instead of the viewport. */
  fullPage?: boolean;
  /** read_text only: character offset to continue a previous read from. */
  offset?: number;
  /** read_text only: scroll through the page while reading, so lazy-loaded content is included. */
  expand?: boolean;
  /**
   * snapshot + every snapshot-returning action: tighten the returned snapshot's
   * character budget (re-clamped extension-side).
   */
  maxChars?: number;
}

/** One tab inside the consented group — the only tabs that exist to the agent. */
export interface BrowserTab {
  tabId: string;
  title: string;
  url: string;
  current: boolean;
}

/**
 * One cookie of the CURRENTLY ATTACHED tab's origin, returned by `read_cookies`.
 * `value` is a SECRET (a live session token when `httpOnly`); `name` is
 * page-controlled and must be treated as untrusted text. Never audited or
 * logged by value — only the name/count reach the audit row.
 */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
  /** Unix seconds; omitted for a session cookie (CDP reports -1). */
  expires?: number;
}

/**
 * One localStorage / sessionStorage entry of the CURRENTLY ATTACHED tab's
 * origin, returned by `read_storage`. `value` is a SECRET (localStorage
 * commonly holds bearer/JWT tokens); `key` is page-controlled and must be
 * treated as untrusted text. Never audited or logged by value — only the
 * key/count reach the audit row.
 */
export interface BrowserStorageEntry {
  key: string;
  value: string;
}

export type BrowserResult =
  | {
      behavior: "ok";
      /** Serialized accessibility tree — UNTRUSTED page content. */
      snapshot?: string;
      /**
       * The ACTION succeeded but the fresh snapshot could not be rendered, and
       * this is why. Bridge-authored (not page content), so it is reported
       * outside the untrusted wrapper — and it exists so a failed read-back
       * never reads as a failed action, which had the agent retrying an
       * action that had already happened.
       */
      snapshotError?: string;
      /**
       * A BRIDGE-authored caveat about this op's outcome — currently a clear
       * that had to be REPAIRED to take, or one that could not be verified at
       * all. Not page content (any page-derived value inside it is pre-sliced by
       * the extension), so it is rendered OUTSIDE the untrusted wrapper. It
       * exists because the alternative was silence: a script-controlled field
       * appended instead of replacing and the tool reported plain success.
       */
      note?: string;
      url?: string;
      title?: string;
      tabs?: BrowserTab[];
      /**
       * A JavaScript dialog (alert/confirm/prompt/beforeunload) is OPEN on the
       * tab. The page is frozen until it is answered, so no snapshot could be
       * taken; `message`/`defaultPrompt` are UNTRUSTED page content.
       */
      dialog?: { type: string; message: string; defaultPrompt?: string };
      /** screenshot: captured image (base64 bytes) — pixels of UNTRUSTED page content. */
      image?: { base64: string; mimeType: string };
      /**
       * screenshot only, SERVER-INTERNAL (set by the chat route's auto-share,
       * never crosses the extension wire): the outcome note appended to the
       * model-facing report — whether the user got a file-card copy.
       */
      shareNote?: string;
      /**
       * screenshot only, SERVER-INTERNAL: the download-card + hidden-slide
       * attachments the auto-share published, exposed so claudeAgent can stamp
       * the same text anchor the file-output wrappers stamp.
       */
      sharedAttachments?: import("../types.js").MessageAttachment[];
      /** click_at: element found at the clicked point — UNTRUSTED page content. */
      landedOn?: string;
      /** read_text: one chunk of the page's readable text — UNTRUSTED page content. */
      pageText?: { text: string; offset: number; total: number };
      /**
       * read_cookies: the current tab origin's cookies — the user's LIVE
       * session, incl. httpOnly. VALUES ARE SECRETS (session tokens); cookie
       * NAMES are page-controlled untrusted text.
       */
      cookies?: BrowserCookie[];
      /**
       * read_storage: the current tab origin's localStorage or sessionStorage
       * (which one is in `storageKind`). VALUES ARE SECRETS (localStorage
       * commonly holds bearer/JWT tokens); entry KEYS are page-controlled
       * untrusted text.
       */
      storage?: BrowserStorageEntry[];
      /** read_storage: which store the `storage` entries came from. */
      storageKind?: "local" | "session";
    }
  | { behavior: "error"; message: string };

/**
 * Streaming sink passed into the agent runners. Every callback is optional so a
 * caller can subscribe to only the events it cares about. When NO events sink
 * is supplied, the runners must behave exactly like the original non-streaming
 * implementations (so POST /api/chat stays unchanged).
 */
export interface AgentEvents {
  /** Incremental assistant text to APPEND to the live bubble (main agent only). */
  onDelta?: (text: string) => void;
  /**
   * Incremental THINKING/reasoning text (main agent only). Surfaced in a
   * separate collapsible reasoning view — NEVER appended to the answer bubble.
   */
  onThinking?: (text: string) => void;
  /**
   * Discard the reasoning streamed so far this run (the empty-turn retry re-runs
   * the model, so the failed attempt's thinking must not glue onto the kept one).
   */
  onThinkingReset?: () => void;
  /**
   * Earlier answer text was superseded by a newer text block and demoted to the
   * reasoning view. `text` is the folded text (chunk-joined). The host must move
   * it into its thinking accumulator, drop it from its pending answer text, and
   * re-anchor already-stamped attachments to 0 (the folded text no longer exists
   * in the answer the anchors index into).
   */
  onTextFold?: (text: string) => void;
  /** Human-readable Korean activity label. */
  onStatus?: (label: string) => void;
  /** The model the SDK actually initialized with (from the `init` system event). */
  onModel?: (model: string) => void;
  /**
   * The SDK session id for this run (from the `init` system event). Persist it
   * to resume the conversation's context on the next turn.
   */
  onSessionId?: (sessionId: string) => void;
  /** Plugin install lifecycle. */
  onPlugin?: (event: PluginEvent) => void;

  /** A concrete tool call started, attributed to its agent. */
  onToolStart?: (event: ToolEvent) => void;
  /** A tool call finished (tool_result observed). */
  onToolEnd?: (event: { toolUseId: string; ok: boolean }) => void;
  /** A non-subagent SDK task started. */
  onTaskStart?: (event: TaskEvent) => void;
  /** A non-subagent SDK task changed progress/state. */
  onTaskUpdate?: (event: TaskUpdateEvent) => void;
  /** A non-subagent SDK task finished. */
  onTaskEnd?: (event: { taskId: string; ok: boolean; status?: string; summary?: string }) => void;
  /** A subagent was spawned. */
  onAgentStart?: (event: AgentSpawnEvent) => void;
  /** A subagent finished. */
  onAgentEnd?: (event: { agentId: string; ok: boolean }) => void;
  /**
   * The full set of live background tasks changed (SDK level signal).
   * REPLACE semantics: swap any kept set for this payload — never pair edges.
   */
  onBackgroundTasks?: (event: { tasks: BackgroundTaskSummary[] }) => void;
  /**
   * A `result` boundary passed. With live background tasks the SDK session
   * stays open past this point, so the host can finalize the visible turn here
   * and treat later boundaries as background follow-up reports.
   */
  onTurnResult?: (event: TurnResultEvent) => void;
  /**
   * Inbound mid-turn user messages for this run; the held-open prompt generator
   * yields them to the SDK and the run loop feeds `command_lifecycle` frames
   * back. Absent on headless/external runs.
   */
  steers?: SteerChannel;
  /** A tool was auto-denied (no interactive prompt). */
  onBlocked?: (event: BlockedEvent) => void;
  /** A second-brain note was saved (repo write under wiki/) — display notice. */
  onMemory?: (event: MemoryEvent) => void;
  /** A context compaction finished or failed — durable activity-row notice. */
  onCompact?: (event: CompactEvent) => void;
  /** The model submitted a plan via ExitPlanMode (plan mode) — display card. */
  onPlan?: (event: PlanEvent) => void;

  /**
   * BLOCKING: the model finished planning and proposed a plan via ExitPlanMode.
   * For a present owner (interactive, non-auto-approve) the run PARKS here for an
   * explicit approval: approve → the avatar proceeds to implement; reject → the
   * (optional) feedback is fed back to the model so it revises and re-proposes.
   * If omitted (headless / colleague / auto-approve), the plan tool just
   * auto-continues and only the display card (`onPlan`) is shown.
   */
  onPlanReview?: (request: PlanReviewRequest) => Promise<PlanReviewDecision>;

  /**
   * BLOCKING: the model wants a non-pre-approved tool. Resolve with the user's
   * decision. If omitted, the runner falls back to auto-deny semantics.
   */
  onPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
  /**
   * BLOCKING: the model raised a user dialog (AskUserQuestion). Resolve with the
   * user's answer. If omitted, the dialog is cancelled (SDK default applies).
   */
  onQuestion?: (request: QuestionRequest) => Promise<QuestionAnswer>;
  /**
   * The avatar showed a visual canvas (experimental `canvas` feature). Resolve
   * with the user's submission when controls were declared (`awaitInput`), or
   * immediately for display-only. If omitted, the canvas tool is not registered.
   */
  onCanvas?: (request: CanvasRequest) => Promise<CanvasResult>;
  /**
   * Publish a local raster image into the live assistant bubble. If omitted,
   * the file-output tools are not registered (headless runs have no viewer).
   */
  onFile?: (request: FileOutputRequest) => Promise<FileOutputResult>;
  /**
   * Publish a generated document (pptx/pdf/…) as a download card on the live
   * assistant bubble. Registered together with `onFile` — the chat route
   * provides both or neither.
   */
  onShareFile?: (request: ShareFileRequest) => Promise<FileOutputResult>;
  /**
   * BLOCKING: drive the viewer's own browser through the extension bridge and
   * resolve with the outcome. Parks the run for seconds (not the interactive
   * prompt TTL) — the responder is software, so a slow answer means the bridge
   * is gone, not that a human is thinking. If omitted, the browser tools are
   * not registered (a headless run has no browser to drive).
   */
  onBrowser?: (request: BrowserRequest) => Promise<BrowserResult>;
}
