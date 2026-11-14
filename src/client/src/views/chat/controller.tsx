// The chat view's state and handlers — the logic behind ChatView.tsx's
// markup. ONE instance per mounted ChatView (`useChatController`), read by
// the pane components (Transcript.tsx, Composer.tsx) as `ctx`.
//
// The app state is mutated in place (lib/hooks.ts): everything derived from it
// is derived in the render body, and what a handler reads LATER (after an
// await, from a listener registered once) goes through a ref.
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  SyntheticEvent,
} from "react";
import type AnswerUiComponent from "../../components/widget/AnswerUi";
import { activePane, newId, notify, readState, updateState, type ClientState } from "../../lib/state";
import {
  addConversationToSplit,
  attachActiveRun,
  cancelRewindEdit,
  hasVisibleImages,
  knownModel,
  newChat,
  openSharedFile,
  selectConversation,
  sendMessage,
  sendSteer,
  stableMessageId,
  startChatWith,
  startRewindEdit,
  submitRewindEdit,
} from "../../lib/chat";
import { api } from "../../lib/api";
import {
  allowlistSeed,
  browserBridgeReachable,
  bridgeVersionVerdict,
  extensionsPageUrl,
  readAllowedOrigins,
  writeAllowedOrigins,
  type BridgeVersionVerdict,
} from "../../lib/browserBridge";
import { copyText, downscaleImageToDataUrl, readFileAsDataUrl } from "../../lib/dom";
import { documentsReading, isFileDrag, splitAttachFiles, stageDocuments } from "../../lib/composerDocuments";
import { startUploadRelay } from "../../lib/uploadRelay";
import { loadAvatars, loadConversations } from "../../lib/loaders";
import { goView, routeFromHash } from "../../lib/nav";
import { createStreamMarkdown, type StreamBlock, type StreamMarkdown } from "../../lib/streamMarkdown";
import { liveReveal } from "../../lib/streamReveal";
import { thinkingClocks, thinkingNow } from "../../lib/streamThinking";
import { createStickController, type StickController } from "../../lib/autoscroll";
import { panelSlides } from "../../lib/bubbleSegments";
import { containsInlineUi } from "../../../../shared/widget/detect";
import { queueInlineUiReport } from "../../lib/canvasReport";
import { menuCommandsForPane, filterSlashCommands, type SlashCommand } from "../../lib/slash";
import { setTodoOverlayOpen, todoActivity, todoOverlayVisible } from "../../lib/todos";
import { useAppState, useStore, useWindowEvent } from "../../lib/hooks";
import type {
  AgentActivity,
  AvatarSummary,
  ChatPane,
  ImageMediaType,
  LiveAgentNode,
  LiveTaskRow,
  LiveToolRow,
  MessageAttachment,
  PendingImage,
  SkillInfo,
  StoredMessage,
} from "../../lib/types";
import {
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVELS,
  effortForModel,
  type EffortLevel,
  type ModelEffortSupport,
} from "../../../../server/effortLevels";
import {
  DEFAULT_MCP_TOOL_GROUPS,
  MCP_TOOL_GROUPS,
  effectiveMcpToolGroups,
  isRequiredMcpToolGroup,
  type McpToolGroupId,
} from "../../../../shared/mcpToolGroups";
import { TOUR_SCENARIOS, type TourScenario } from "../../../../shared/tourScenarios";
import { isPptxCard } from "../../../../shared/shareLinks";

/* ------------------------------------------------------------------ */
/* helpers that read only their arguments                              */
/* ------------------------------------------------------------------ */

/** The toggle's tooltip; state passed in. */
export function todoToggleTitle(shownHere: boolean, loaded: boolean, open: number, overdue: number): string {
  return `${shownHere ? "할 일 목록 닫기" : "할 일 목록 띄우기"}${loaded ? ` · 열린 할 일 ${open}개` : ""}${overdue ? ` · 마감 지남 ${overdue}개` : ""}`;
}

export function hasModelPicker(state: ClientState): boolean {
  return Boolean(state.bootstrap?.modelSelection?.models.length);
}

// The pane's pi model id as the picker shows it; "" = pi-gateway's default
// model (also for a stored id pi no longer offers).
export function currentModel(item: ChatPane, state: ClientState): string {
  return knownModel(item.model, state.bootstrap?.modelSelection?.models ?? []);
}

// "" = no pick: name the model the run actually uses (pi's `falcon` tier,
// bootstrap's modelSelection.defaultModel) when pi offers it — the same text
// as the picker's first option.
export function modelLabel(model: string, state: ClientState): string {
  if (model) return model;
  const defaultModel = state.bootstrap?.modelSelection?.defaultModel;
  return defaultModel ? `기본 모델 (${defaultModel})` : "기본 모델";
}

export function hasEffortPicker(state: ClientState): boolean {
  return Boolean(state.bootstrap?.effortSelection);
}

export function hasComposerControls(item: ChatPane): boolean {
  // Every pane gets the settings row — the MCP tool-group picker always exists
  // (MCP_TOOL_GROUPS is a non-empty registry), so the row is never empty. The
  // per-item argument is kept for call-site clarity and future gating.
  void item;
  return true;
}

export function currentModelLabel(item: ChatPane, state: ClientState): string {
  return modelLabel(currentModel(item, state), state);
}

export function effortLabel(item: ChatPane, state: ClientState): string {
  const levelId = item.effort ?? state.bootstrap?.effortSelection?.default ?? DEFAULT_EFFORT_LEVEL;
  return state.bootstrap?.effortSelection?.levels.find((level) => level.id === levelId)?.label ?? levelId;
}

export function selectedMcpToolGroups(item: ChatPane): McpToolGroupId[] {
  const selected = item.mcpToolGroups ?? DEFAULT_MCP_TOOL_GROUPS;
  return effectiveMcpToolGroups(selected);
}

// Browser-bridge compatibility badge for the composer hint row: compares the
// INSTALLED extension build against the server bundle AND the server's
// min-compatible floor, so a stale install shows up before the avatar hits
// "Unsupported operation" — but an install that merely differs while staying
// at/above the floor keeps working instead of demanding a re-download on
// every extension-folder touch. Probed once per app load — both sides only
// change with a deploy or an extension reload, and either reloads this page in
// practice. The probe only starts once a pane actually has the browser tool
// group selected, so panes that never touch the bridge never ping it.
//
// FOUR distinct states, not three: `compatible` (works now, an update exists)
// is its own rung between "matches the server" and "must update", because
// collapsing it into the healthy state hides an update the user could take at
// their convenience. `unreachable` is the version verdict's absence, so the
// reachability and version axes fold into ONE level the badge renders from —
// they were two fields that always moved together.
export type BridgeBadgeLevel = BridgeVersionVerdict | "unreachable";
export interface BridgeCompat {
  level: BridgeBadgeLevel;
  installed: string;
  expected: string;
}

// Each rung carries its own TEXT, not just its own colour: `current` and
// `compatible` would otherwise read identically to anyone who cannot tell the
// two dots apart, and a difference nobody can name is not a state.
export function bridgeBadge(compat: BridgeCompat): { text: string; title: string } {
  if (compat.level === "current") {
    return {
      text: `브라우저 확장 v${compat.installed}`,
      title: "설치된 브라우저 확장이 서버가 배포하는 버전과 일치합니다.",
    };
  }
  if (compat.level === "compatible") {
    return {
      text: `브라우저 확장 v${compat.installed} · 업데이트 있음`,
      title: `서버 번들(v${compat.expected || "?"})과 다르지만 호환되는 버전이라 그대로 쓸 수 있습니다. 설정 → 접근/보안의 원클릭 업데이트로 편할 때 올리세요.`,
    };
  }
  if (compat.level === "outdated") {
    return {
      text: `확장 업데이트 필요 (${compat.installed ? `v${compat.installed}` : "구버전"} → v${compat.expected || "?"})`,
      title: `설치된 브라우저 확장이 이 서버와 호환되지 않는 버전입니다. 설정 → 접근/보안에서 원클릭 업데이트를 누르거나, zip을 다시 받아 폴더를 교체한 뒤 ${extensionsPageUrl()}에서 리로드(↻)하세요.`,
    };
  }
  return {
    text: "브라우저 확장 연결 안 됨",
    title:
      "이 브라우저에서 Noah 확장에 연결할 수 없습니다. 설정 → 접근/보안의 안내대로 설치했는지, Noah 주소가 확장의 허용 origin에 있는지 확인하세요.",
  };
}

/**
 * Jump from the composer's problem badge to where the extension is actually
 * installed. `browserGuideRequested` is the one-shot deep link the 접근/보안
 * tab consumes on activation (same path the what's-new dialog uses); goView
 * carries the hash so Back returns to the chat.
 */
export function openBrowserBridgeGuide(): void {
  updateState((state) => {
    state.browserGuideRequested = true;
  });
  goView("settings", "access");
}

/** "N/M": the selected groups the admin policy leaves on, over every group. */
export function mcpToolsCount(item: ChatPane, adminBlocked: Set<McpToolGroupId>): string {
  const effective = selectedMcpToolGroups(item).filter((id) => !adminBlocked.has(id));
  return `${effective.length}/${MCP_TOOL_GROUPS.length}`;
}

export function mcpToolsLabel(item: ChatPane, adminBlocked: Set<McpToolGroupId>): string {
  return `도구 ${mcpToolsCount(item, adminBlocked)}`;
}

export function composerSettingsSummary(item: ChatPane, adminBlocked: Set<McpToolGroupId>, state: ClientState): string {
  const parts: string[] = [];
  if (hasModelPicker(state)) parts.push(currentModelLabel(item, state));
  if (hasEffortPicker(state)) parts.push(`강도 ${effortLabel(item, state)}`);
  parts.push(mcpToolsLabel(item, adminBlocked));
  return parts.join(" · ");
}

export function paneDomId(prefix: string, paneId: string): string {
  return `${prefix}-${paneId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export function slashOptionId(paneId: string, index: number): string {
  return paneDomId(`slash-option-${index}`, paneId);
}

// A staged document whose bytes are still being read holds the send back: a
// message must never go out with half of what its chips promise.
export function canSendMessage(item: ChatPane): boolean {
  return Boolean(
    !item.streaming &&
      item.avatar &&
      (item.draft.trim() || item.pendingImages?.length || item.pendingDocuments?.length) &&
      !documentsReading(item),
  );
}

function isMobileViewport(): boolean {
  return window.matchMedia?.("(max-width: 860px)").matches ?? false;
}

// Scoped to the composer box: the transcript can hold textareas of its own (the
// inline 여기서부터 다시 editor), which come FIRST in the
// pane's DOM order.
function blurComposer(paneId: string) {
  const el = document.querySelector<HTMLTextAreaElement>(`[data-pane="${paneId}"] .composer-box textarea`);
  el?.blur();
}

/* ---- image attachments ---- */
const MAX_COMPOSER_IMAGES = 6;
// Long-edge cap before upload (Claude's recommended max; also keeps payloads small).
const IMAGE_MAX_DIM = 1568;
// Hand-mirrors the server's MAX_CHAT_IMAGE_BYTES (chatImages.ts). Only file mode
// needs it: the vision path downscales, so it never approaches the cap.
const MAX_ATTACH_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES: ImageMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// Downscale to IMAGE_MAX_DIM via canvas (re-encoding to the same family). GIFs
// are kept verbatim so animation survives (still size-capped server-side). The
// decode/downscale (a CSP-sensitive `data:` URL load) lives in downscaleImageToDataUrl.
async function resizeImageForChat(file: File): Promise<{ dataUrl: string; mediaType: ImageMediaType }> {
  const type: ImageMediaType = (ACCEPTED_IMAGE_TYPES as string[]).includes(file.type) ? (file.type as ImageMediaType) : "image/png";
  if (type === "image/gif") {
    const sourceDataUrl = await readFileAsDataUrl(file);
    return { dataUrl: sourceDataUrl, mediaType: "image/gif" };
  }
  const out = type === "image/jpeg" ? "image/jpeg" : type === "image/webp" ? "image/webp" : "image/png";
  const dataUrl = await downscaleImageToDataUrl(file, IMAGE_MAX_DIM, { outputType: out });
  // The browser may emit PNG if it can't encode the requested type — trust the prefix.
  const mediaType = (/^data:(image\/[a-z+]+);/.exec(dataUrl)?.[1] as ImageMediaType) || "image/png";
  return { dataUrl, mediaType };
}

// Vision support for the model THIS pane would use: the pane's pick when pi
// still offers it, else the default model's (pi's `falcon` tier, else pi's own). Mirrors the server's
// resolution (which also enforces it on upload); unknown reads as vision on,
// like the server (visionForCatalogModel).
export function paneVisionEnabled(item: ChatPane, state: ClientState = readState()): boolean {
  const sel = state.bootstrap?.modelSelection;
  if (!sel) return true;
  const model = knownModel(item.model, sel.models);
  const entry = model ? sel.models.find((m) => m.id === model) : undefined;
  if (entry) return entry.vision !== false;
  return sel.defaultVision !== false;
}

// pi's reasoning efforts for the model THIS pane would use (same resolution as
// paneVisionEnabled): undefined = unknown (an older pi), null = no reasoning.
function paneEffortSupport(item: ChatPane, state: ClientState): ModelEffortSupport | null | undefined {
  const sel = state.bootstrap?.modelSelection;
  if (!sel) return undefined;
  const model = knownModel(item.model, sel.models);
  return model ? sel.models.find((m) => m.id === model)?.reasoning : sel.defaultReasoning;
}

// An effort option on this pane's model: a level the model does not take as
// picked is greyed out (the server clamps it the same way, effortForModel),
// and its label says what runs instead. The current value stays selectable.
export function effortOption(item: ChatPane, level: EffortLevel, state: ClientState) {
  const sent = effortForModel(level.id, paneEffortSupport(item, state));
  const current = item.effort ?? state.bootstrap?.effortSelection?.default ?? DEFAULT_EFFORT_LEVEL;
  const name = (id: string) => EFFORT_LEVELS.find((e) => e.id === id)?.label ?? id;
  const note =
    sent.kind === "lowered" && sent.effort
      ? `이 모델 미지원 → ${name(sent.effort)}`
      : sent.kind === "model_default"
        ? `이 모델 미지원 → 모델 기본값${sent.effort ? `(${name(sent.effort)})` : ""}`
        : sent.kind === "not_reasoning"
          ? "이 모델은 사고 강도를 쓰지 않음"
          : "";
  return {
    label: note ? `${level.label} (${note})` : level.label,
    title: note ? `${level.description}\n${note}` : level.description,
    disabled: Boolean(note) && level.id !== current,
  };
}

// Documents (pdf, docx, …) are offered only where the avatar is the viewer's
// OWN: its runtime writes them into the viewer's own sandbox. The same rule
// as `isOwnPane`, reading only its arguments.
export function paneTakesDocuments(item: ChatPane, state: ClientState): boolean {
  return Boolean(item.avatar.isOwn || item.avatar.id === state.user?.id);
}

// A vision-off pane still attaches — the model gets the FILE, never the
// pixels. Say that on the control itself instead of hiding it.
export function attachHint(item: ChatPane, state: ClientState): string {
  if (paneTakesDocuments(item, state))
    return paneVisionEnabled(item, state) ? "이미지·문서 첨부" : "이미지·문서 첨부 (모델이 이미지 내용을 보지 못해 이미지도 파일로 전달됨)";
  return paneVisionEnabled(item, state) ? "이미지 첨부" : "이미지 첨부 (모델이 내용을 보지 못하고 파일로 전달됨)";
}

// The tooltip also names the two ways in that need no file dialog: on the
// fleet a security agent can refuse the picker, and nothing else would say so.
// With an upload relay the button opens the relay's page, and the title says
// so before the press (a window appearing unannounced reads as a fault).
export function attachTitle(item: ChatPane, state: ClientState): string {
  const how = state.bootstrap?.uploadRelay ? " (업로드 창이 열립니다)" : "";
  return `${attachHint(item, state)}${how} · 붙여넣기(Ctrl+V)나 끌어다 놓기로도 첨부할 수 있어요`;
}

// The disabled send button's title enumerates what WOULD make it sendable —
// or says what it is waiting for.
export function sendBlockedHint(item: ChatPane, state: ClientState): string {
  if (documentsReading(item)) return "첨부한 파일을 읽는 중입니다…";
  return paneTakesDocuments(item, state) ? "메시지를 입력하거나 이미지·문서를 첨부하세요" : "메시지 또는 이미지를 추가하세요";
}

// A file dropped anywhere ELSE would make the browser open it — navigating
// away from the chat (and from an answer still streaming). While this view is
// mounted the window refuses such a drop; the listeners go with the view. A
// native file input keeps its own drop.
function isFileInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && target.type === "file";
}

// Live (just-sent) bubbles render from the locally-held data URL; on reload it
// falls back to the owner-scoped serving endpoint.
export function imageSrc(message: StoredMessage, att: MessageAttachment, item: ChatPane): string {
  return (
    item.localImages?.[att.id] ||
    `/api/conversations/${encodeURIComponent(message.conversationId)}/images/${encodeURIComponent(att.id)}`
  );
}

// Hidden attachments (slide PNGs published for canvas embeds) are served by
// URL but never rendered in the bubble.
export function visibleAttachments(attachments: MessageAttachment[] | undefined): MessageAttachment[] {
  return (attachments ?? []).filter((att) => !att.hidden);
}

// What waits for the answer to end when a mid-turn message is sent: a steer
// carries no attachment. "" = nothing staged.
function heldAttachmentNoun(item: ChatPane): string {
  const images = Boolean(item.pendingImages?.length);
  const documents = Boolean(item.pendingDocuments?.length);
  return images && documents ? "이미지와 문서" : images ? "이미지" : documents ? "문서" : "";
}

// Download URL for a file attachment — a generated file or a document the
// user uploaded (always served as a download, never inline); `name` only picks
// the save-dialog filename (the server sanitizes it).
export function fileSrc(conversationId: string, att: MessageAttachment): string {
  const base = `/api/conversations/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(att.id)}`;
  return att.name ? `${base}?name=${encodeURIComponent(att.name)}` : base;
}

// 공유 링크 beside a deck card: PPTX decks only.
export function canShareCard(att: MessageAttachment): boolean {
  return isPptxCard(att);
}

/* ---- slash autocomplete ---- */
function slashQuery(text: string): string | null {
  if (typeof text !== "string" || text.startsWith("//")) return null;
  const match = /^\/([A-Za-z0-9_-]*)$/.exec(text);
  return match ? match[1].toLowerCase() : null;
}
export function slashMatches(item: ChatPane): SlashCommand[] {
  const query = slashQuery(item.draft);
  if (query === null || item.streaming) return [];
  return filterSlashCommands(menuCommandsForPane(item), query);
}

/**
 * Can this pane take a mid-turn message at all? For as long as a turn is streaming. It
 * deliberately does NOT look at the draft: the control is a standing part of
 * the streaming composer, disabled while there is nothing to send, so the grid
 * column list never changes under the user's fingers as they type.
 */
export function canSteer(item: ChatPane): boolean {
  return Boolean(item.streaming);
}

/**
 * When a message sent now reaches the avatar, as the composer says it: during
 * the work, at its next tool-call boundary — so it can change what the avatar
 * is doing (one that arrives as the turn ends follows as its own turn).
 */
const STEER_WHEN = "작업 도중에 전달돼 진행 중인 일을 바꿀 수 있어요";

/**
 * The mid-turn send button's tooltip. A control disabled with no stated
 * prerequisite reads as broken, so the empty-draft state names what would make
 * it work rather than just greying out.
 */
export function steerSendTitle(item: ChatPane): string {
  return item.draft.trim()
    ? `응답 중 메시지 보내기 (${STEER_WHEN})`
    : "메시지를 입력하면 응답 중에도 보낼 수 있어요";
}

/**
 * The composer's placeholder while a turn is streaming: when a message sent now
 * is delivered (`STEER_WHEN`), and the gesture that actually sends on this
 * device — Enter only sends where a physical keyboard was detected.
 */
export function streamingPlaceholder(sends: boolean): string {
  return sends
    ? `응답 중에도 메시지를 보낼 수 있어요 · Enter로 보내면 ${STEER_WHEN}`
    : `응답 중에도 메시지를 보낼 수 있어요 · 보내기 버튼을 누르면 ${STEER_WHEN}`;
}

function setDraft(paneId: string, value: string) {
  updateState((state) => {
    const target = state.chatPanes.find((item) => item.id === paneId);
    if (target) target.draft = value;
  });
}

function setActive(paneId: string) {
  updateState((state) => {
    state.activePaneId = paneId;
    state.currentAvatar = state.chatPanes.find((item) => item.id === paneId)?.avatar || state.currentAvatar;
  });
}

function copyMessage(message: StoredMessage, event: MouseEvent<HTMLButtonElement>) {
  void copyText(message.content || message.response?.text || "", event.currentTarget);
}

// Drop target for a conversation dragged from the rail's "내 대화" list.
// Mirrors the MIME set in Shell's onConvDragStart.
const CONV_DND_MIME = "application/x-noah-conversation";

function isConvDrag(event: DragEvent): boolean {
  return Boolean(event.dataTransfer?.types?.includes(CONV_DND_MIME));
}

export function messageText(message: StoredMessage) {
  return message.response?.text || message.response?.summary || message.content;
}

/** The conversation's last assistant message: the one whose render problems the avatar is told. */
export function latestAnswerId(messages: StoredMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === "assistant") return messages[i].id;
  return null;
}

// A ```mermaid block of a stored answer that could not be drawn (lib/mermaidBlock.ts):
// nothing checked it before it was on screen, so the avatar hears of it with its
// next turn — the same report an answer with inline UI makes, for the
// conversation's latest answer only.
export function reportDiagramProblem(item: ChatPane, message: StoredMessage, problem: string): void {
  if (message.id !== latestAnswerId(item.messages)) return;
  const paneId = item.id;
  const messageId = message.id;
  const content = messageText(message);
  queueInlineUiReport({
    conversationId: item.conversationId,
    messageId,
    content,
    errors: [problem],
    stillCurrent: () => {
      const now = readState().chatPanes.find((candidate) => candidate.id === paneId);
      return Boolean(now) && !now!.streaming && latestAnswerId(now!.messages) === messageId;
    },
  });
}

export function runtimeBadge(message: StoredMessage): string | null {
  const runtime = message.response?.runtime;
  if (runtime === "local") return "로컬";
  if (message.response?.summary === "오류" || message.response?.summary === "중지됨") return message.response.summary;
  return null;
}

// "도구 N개 · 태스크 N개 · 에이전트 N개 <suffix>" from the three counts, or
// emptyLabel when all are zero. Shared by the live + completed activity labels.
function activityCountLabel(toolCount: number, taskCount: number, agentCount: number, suffix: string, emptyLabel: string): string {
  const parts: string[] = [];
  if (toolCount) parts.push(`도구 ${toolCount}개`);
  if (taskCount) parts.push(`태스크 ${taskCount}개`);
  if (agentCount) parts.push(`에이전트 ${agentCount}개`);
  return parts.length ? `${parts.join(" · ")} ${suffix}` : emptyLabel;
}

export type ActivityRows = { agents: LiveAgentNode[]; tools: LiveToolRow[]; tasks: LiveTaskRow[] };
function rowsRunning(rows: ActivityRows): boolean {
  return (
    rows.agents.some((a) => !a.isMain && a.status === "running") ||
    rows.tools.some((t) => t.status === "running") ||
    rows.tasks.some((t) => t.status === "running")
  );
}

// The in-flight turn's rows: "진행 중" only while one of them runs — between
// actions (the model is writing, or a pi run waits on a consulted avatar) the
// rows are finished, so "사용함".
export function activitySummary(rows: ActivityRows): string {
  const toolCount = rows.tools.filter((t) => t.kind === "tool").length;
  const taskCount = rows.tasks.length;
  const agentCount = rows.agents.filter((a) => !a.isMain).length;
  return activityCountLabel(toolCount, taskCount, agentCount, rowsRunning(rows) ? "진행 중" : "사용함", "작업 중…");
}

// Activity-tree snapshot kept on a COMPLETED assistant message, so the tool/agent
// runs stay visible after the response finishes (collapsed by default).
export function completedActivity(message: StoredMessage) {
  const activity = message.response?.activity;
  // An agent card with no tool rows of its own is still worth showing.
  return activity &&
    (activity.tools.length || activity.tasks?.length || activity.agents.some((a) => !a.isMain))
    ? activity
    : null;
}

export function completedActivityLabel(activity: AgentActivity): string {
  const toolCount = activity.tools.filter((t) => t.kind === "tool").length;
  const taskCount = (activity.tasks?.length || 0) + activity.tools.filter((t) => t.kind === "task").length;
  const agentCount = activity.agents.filter((a) => !a.isMain).length;
  return activityCountLabel(toolCount, taskCount, agentCount, "사용함", "작업 내역");
}

// Second-brain captures ride the activity rows as kind:"memory", but render
// as a chip on the SUMMARY line — visible while the disclosure is collapsed
// (ActivityTree deliberately skips them, so they never appear inside).
export function memoryChip(
  tools: Array<{ kind: string; label: string; detail?: string }>,
): { label: string; title: string } | null {
  const rows = tools.filter((t) => t.kind === "memory");
  if (!rows.length) return null;
  return {
    label: rows.length === 1 ? rows[0].label : `기억 ${rows.length}건 저장됨`,
    title: rows.map((r) => [r.label, r.detail].filter(Boolean).join(" · ")).join("\n"),
  };
}

// Context compactions ride the activity rows as kind:"compact" and DO render
// inside the tree (unlike 기억), but the card is collapsed by default — so the
// summary line also carries a chip: a compaction nobody notices is exactly the
// gap this row exists to close. Failure says so in its TEXT, not by colour.
export function compactChip(
  tools: Array<{ kind: string; label: string; detail?: string; status?: string }>,
): { icon: string; label: string; title: string } | null {
  const rows = tools.filter((t) => t.kind === "compact");
  if (!rows.length) return null;
  const failed = rows.some((r) => r.status === "failed");
  return {
    icon: failed ? "⚠️" : "✂️",
    label: failed
      ? "맥락 정리 실패"
      : rows.length === 1
        ? "맥락 요약됨"
        : `맥락 ${rows.length}회 요약됨`,
    title: rows.map((r) => [r.label, r.detail].filter(Boolean).join(" · ")).join("\n"),
  };
}

// Keyed on the row's STABLE id (what the transcript keys on too), so a card the
// viewer opened stays open when its bubble adopts the server's id.
export function cardKey(message: StoredMessage, card: "thinking" | "activity"): string {
  return `${stableMessageId(message) || message.createdAt}:${card}`;
}

/* ------------------------------------------------------------------ */
/* the controller                                                      */
/* ------------------------------------------------------------------ */

/**
 * State that is drawn AND read by code that runs later than the render that
 * made it: the value for the render, a ref (written together with it) for the
 * late reads.
 */
function useLive<T>(initial: T): [T, (next: T) => void, { current: T }] {
  const [value, setValue] = useState<T>(() => initial);
  const ref = useRef(value);
  const set = useRef((next: T): void => {
    ref.current = next;
    setValue(() => next);
  }).current;
  return [value, set, ref];
}

/** What the view keeps for its lifetime and never draws (timers, flags, caches). */
interface Instance {
  stickControllers: Record<string, StickController>;
  todoTogglePress: { paneId: string; shownHere: boolean; at: number } | null;
  bridgeCompatStarted: boolean;
  bridgeCompatFailures: number;
  skillsInFlight: Set<string>;
  answerUiLoading: boolean;
  inlineUiVerdicts: Map<string, boolean>;
  streamRenderers: Map<string, StreamMarkdown>;
  /** The pane whose composer takes the focus once the pending render is in the DOM. */
  focusPane: string | null;
}

export type SplitOption = { id: string; alias?: string; displayName?: string; username?: string };
export type ShareTarget = { conversationId: string; attachment: MessageAttachment };
export type CardsRenderer = (pane: ChatPane, atts: MessageAttachment[], source: MessageAttachment[] | undefined) => ReactNode;

export function useChatController() {
  const state = useAppState();
  // What the live bubble shows (lib/streamReveal.ts) and the reasoning clocks
  // (lib/streamThinking.ts): read here, so every pane is drawn again when one
  // of them publishes.
  const reveal = useStore(liveReveal);
  const clocks = useStore(thinkingClocks);
  const now = useStore(thinkingNow);
  // The count pops when the avatar changes the list, card shown or not: the
  // fresh change's seq keys a remount (restarting the keyframes); 0 once it has
  // played, so a later remount (pane switch) replays nothing.
  const todoCountPop = useStore(todoActivity).pop;

  const [inst] = useState<Instance>(() => ({
    // Auto-scroll: one StickController per pane owns ALL the mechanics — the
    // ResizeObserver re-pins, wheel/touch/pointer gesture capture (user intent is
    // read from INPUT events, not inferred from scroll deltas), and the
    // scroll-event decision via `nextStickBottom`. See `lib/autoscroll.ts` for
    // the full rationale; `stickBottom` stays in the pane store so the FAB and
    // the send-time re-arm (lib/chat.ts) keep working unchanged.
    stickControllers: {},
    // Whether the card showed in a toggle's pane at the moment a POINTER pressed
    // it. Read at pointerdown because a split pane's own focusin activates that
    // pane before the click lands, which would make "another pane" look like
    // "this pane" and switch the card off. Keyboard activation has no pointerdown
    // and reads the live state instead.
    todoTogglePress: null,
    bridgeCompatStarted: false,
    // Bounds the transient-failure retry below: resetting the started flag on
    // every catch would spin an unbounded fetch loop while
    // GET /api/browser-extension keeps 5xx-ing.
    bridgeCompatFailures: 0,
    // Skill entries in the slash menu are populated from the avatar's installed
    // skills, fetched once (lazily) the first time the menu opens for a pane. The
    // result is stored on the pane so slashMatches follows the store.
    skillsInFlight: new Set<string>(),
    answerUiLoading: false,
    // The scan runs for every answer on every render of the transcript; a stored
    // answer's text does not change, so its verdict is kept.
    inlineUiVerdicts: new Map<string, boolean>(),
    // A LIVE answer is drawn as top-level markdown blocks (lib/streamMarkdown.ts):
    // a block that can no longer change is parsed once and keeps its DOM, and only
    // the open tail is rendered again per token — instead of one html of the
    // whole text, which replaced every node (and every code block's buttons) each
    // time. One renderer per (scope, segment): the scope is the pane for its live
    // bubble, or a stored message while the end of its answer is still draining
    // in (lib/streamReveal.ts).
    streamRenderers: new Map<string, StreamMarkdown>(),
    focusPane: null,
  }));
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  const [splitAvatarIdState, setSplitAvatarId] = useState("");
  const [splitAddBusy, setSplitAddBusy, splitAddBusyRef] = useLive(false);
  // Slash autocomplete: which pane it's open for + the selected index.
  const [slashPaneId, setSlashPaneId, slashPaneIdRef] = useLive("");
  const [slashIndex, setSlashIndex, slashIndexRef] = useLive(0);
  const [physicalKeyboard, setPhysicalKeyboard] = useState(false);
  // Per-pane MCP tool-group checkbox panel open state.
  const [mcpToolsOpenPaneId, setMcpToolsOpenPaneId, mcpToolsOpenPaneIdRef] = useLive("");
  // Per-pane mobile composer settings disclosure state.
  const [composerSettingsOpenPaneId, setComposerSettingsOpenPaneId, composerSettingsOpenPaneIdRef] = useLive("");
  const [bridgeCompat, setBridgeCompat] = useState<BridgeCompat | null>(null);
  // The pane a file drag is over ("" = none): it shows the drop affordance.
  const [fileDropPaneId, setFileDropPaneId, fileDropPaneIdRef] = useLive("");
  // The card whose share-link dialog is open; null = closed. The dialog
  // portals itself, so one instance serves every pane (split view included —
  // there the card click downloads, and this is the only way to a link). A deck
  // tab's 공유 링크 in the side panel opens THIS instance too (its onShare): the
  // tab unmounts when it is closed (and the panel with its last tab), and a
  // dialog rendered inside it would vanish with it, mid-create included.
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // Inline UI: an answer whose text holds component tags is drawn by
  // components/widget/AnswerUi (the parser, the interpreter and the components),
  // loaded on the first answer that needs it — `containsInlineUi` is the cheap
  // line scan that decides. Until the chunk is here the answer's place shows a
  // placeholder (never its raw tags); if it cannot be loaded, the answer is
  // drawn as the Markdown it is.
  const [AnswerUi, setAnswerUi, answerUiRef] = useLive<typeof AnswerUiComponent | null>(null);
  const [answerUiFailed, setAnswerUiFailed] = useState(false);
  // Which collapsed "생각 과정" / "작업 내역" cards the user has opened, keyed by
  // `${stableMessageId}:${card}`. <details> only HIDES its children, so a body left in
  // the tree still costs a full markdown parse (thinking) or an ActivityTree
  // mount (activity) for every message in the transcript, on a card almost nobody
  // opens. Rendering on first open keeps a long transcript's mount cost flat.
  // Trade-off: Chrome's find-in-page can no longer reach inside an unopened card.
  const [expandedCards, setExpandedCards, expandedCardsRef] = useLive<Set<string>>(new Set<string>());
  // The live "생각 과정" card renders its body only while open (as the stored
  // cards do): closed, it parsed the whole reasoning text on every token.
  const [openLiveThinkingState, setOpenLiveThinking, openLiveThinkingRef] = useLive<Set<string>>(new Set<string>());

  const panes = state.chatPanes;
  const pane = panes.find((item) => item.id === state.activePaneId) ?? panes[0] ?? null;
  // 할 일 overlay: ONE card, hosted by the active pane's transcript region
  // (TodoOverlay decides pinned/popover/sheet from that region's width). The
  // toggle in every composer drives the same per-browser switch; it reads as
  // pressed only while the card is actually shown (a popover dismissed by an
  // outside click keeps the preference but is not visible).
  const todoOverlayOpen = state.todoOverlayOpen;
  const todoOverlayShown = todoOverlayVisible(state);
  const todoLoaded = state.todos.loaded;
  const todoOpenCount = state.todos.counts.open;
  const todoOverdueCount = state.todos.counts.overdue;

  function noteTodoTogglePress(item: ChatPane) {
    inst.todoTogglePress = { paneId: item.id, shownHere: todoOverlayShown && pane?.id === item.id, at: Date.now() };
  }

  /**
   * The composer's 할 일 switch, per pane. The card lives in the ACTIVE pane
   * only, so a toggle pressed where the card is not showing brings the card
   * THERE (activates that pane, shows the card) instead of switching it off from
   * a pane where it was never visible.
   */
  function toggleTodoOverlayIn(item: ChatPane) {
    const press =
      inst.todoTogglePress?.paneId === item.id && Date.now() - inst.todoTogglePress.at < 2000 ? inst.todoTogglePress : null;
    inst.todoTogglePress = null;
    const shownHere = press ? press.shownHere : todoOverlayShown && pane?.id === item.id;
    if (shownHere) {
      setTodoOverlayOpen(false, { focus: true });
      return;
    }
    if (pane?.id !== item.id) setActive(item.id);
    setTodoOverlayOpen(true, { focus: true });
  }

  const splitClass = panes.length <= 1 ? "single" : state.chatLayout;
  // Split-add options: ALL visible avatars (duplicates allowed — you can run
  // several parallel conversations with the same avatar, incl. your own), with
  // the open panes' avatars unioned in as a fallback so your own avatar is always
  // selectable even before discovery loads.
  const splitOptions = (() => {
    const byId = new Map<string, SplitOption>();
    for (const item of panes) if (item.avatar?.id) byId.set(item.avatar.id, item.avatar);
    for (const avatar of state.avatars) if (avatar?.id) byId.set(avatar.id, avatar);
    return [...byId.values()];
  })();
  let splitAvatarId = splitAvatarIdState;
  if (splitOptions.length && !splitOptions.some((avatar) => avatar.id === splitAvatarId)) {
    splitAvatarId = splitOptions[0].id;
  } else if (!splitOptions.length && splitAvatarId) {
    splitAvatarId = "";
  }
  if (splitAvatarId !== splitAvatarIdState) setSplitAvatarId(splitAvatarId);

  const user = state.user;
  // Desktop / physical keyboard → Enter sends; touch-only → button sends.
  const [finePointer] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(hover: hover) and (pointer: fine)").matches : true,
  );
  const enterSends = finePointer || physicalKeyboard;

  function isOwnPane(item: ChatPane): boolean {
    return Boolean(item.avatar.isOwn || item.avatar.id === user?.id);
  }

  // Admin MCP tool policy from /api/me (`user.allowedMcpToolGroups`, the one
  // deployment-wide allowlist): blocked groups render disabled in the picker; the
  // server clamps every run regardless.
  const adminBlockedMcpToolGroupSet = (() => {
    const allowed = state.user?.allowedMcpToolGroups;
    if (!allowed) return new Set<McpToolGroupId>();
    return new Set<McpToolGroupId>(
      MCP_TOOL_GROUPS.map((group) => group.id).filter((id) => !isRequiredMcpToolGroup(id) && !allowed.includes(id)),
    );
  })();

  // Guided tours offered in the owner's empty state. A browser-driven scenario
  // disappears entirely when admin policy blocks the browser tool group — never
  // offer a route this run cannot have.
  const tourScenarios = TOUR_SCENARIOS.filter(
    (scenario) => !scenario.needsBrowser || !adminBlockedMcpToolGroupSet.has("browser"),
  );

  async function probeBridgeCompat(): Promise<void> {
    try {
      const [meta, reply] = await Promise.all([
        api<{
          version?: string | null;
          minCompatibleVersion?: string | null;
          defaultAllowedOrigins?: string[];
        }>("/api/browser-extension"),
        // getAllowedOrigins exists in every extension build, so it is the one
        // probe that cannot side-effect an old install; pre-0.4.0 builds
        // answer without `version`, which reads as "outdated".
        browserBridgeReachable() ? readAllowedOrigins() : Promise.resolve(null),
      ]);
      const expected = typeof meta.version === "string" ? meta.version : "";
      const floor = typeof meta.minCompatibleVersion === "string" ? meta.minCompatibleVersion : null;
      const installed = reply?.ok && typeof reply.version === "string" ? reply.version : "";
      setBridgeCompat(
        !reply || !reply.ok
          ? { level: "unreachable", installed: "", expected }
          : { level: bridgeVersionVerdict(installed, expected, floor), installed, expected },
      );
      // First-run convenience: an EMPTY local allowlist (deny-all, before any
      // user choice exists) is seeded once with the operator's default
      // (BROWSER_ALLOWED_ORIGINS). A user-edited or managed list never is —
      // allowlistSeed answers null there — and the notice keeps the change
      // visible instead of silently widening what the agent may drive.
      const seed = allowlistSeed(meta.defaultAllowedOrigins, reply, location.hostname);
      if (seed) {
        const seeded = await writeAllowedOrigins(seed);
        if (seeded.ok) {
          notify(
            `브라우저 제어 허용 사이트에 서버 기본값 ${seed.length}개를 적용했습니다. 설정 → 접근/보안에서 바꿀 수 있어요.`,
            "ok",
          );
        }
      }
    } catch {
      // Transient failure — allow a couple of retries on the next render,
      // then give up (until a reload) so a persistent 5xx can't spin forever.
      inst.bridgeCompatFailures += 1;
      if (inst.bridgeCompatFailures < 2) {
        inst.bridgeCompatStarted = false;
        redraw();
      }
    }
  }

  const browserBridgeSelected =
    !adminBlockedMcpToolGroupSet.has("browser") && state.chatPanes.some((p) => selectedMcpToolGroups(p).includes("browser"));
  // Declared before the mount effect below, so it runs first (effects run in
  // declaration order): the probe's request goes out before the mount's loads.
  useEffect(() => {
    if (browserBridgeSelected && !inst.bridgeCompatStarted) {
      inst.bridgeCompatStarted = true;
      void probeBridgeCompat();
    }
  });

  useEffect(() => {
    void (async () => {
      try {
        const route = routeFromHash();
        await loadConversations();
        await loadAvatars();
        if (route.view === "chat" && route.arg && activePane()?.conversationId !== route.arg) {
          await selectConversation(route.arg);
          return;
        }
        const active = activePane();
        if (active) {
          // NOT awaited: attachActiveRun resolves only when the RUN ends (a run
          // parked on a blocking canvas can wait 30 minutes), and the mount must
          // not stay pending that long.
          void attachActiveRun(active.id);
        }
      } catch (err) {
        notify(`대화 목록을 불러오지 못했습니다: ${(err as Error).message}`, "warn");
      }
    })();
    // Once, when the view mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stickFor(paneId: string): StickController {
    return (inst.stickControllers[paneId] ??= createStickController({
      // Read/write through the LIVE store — never a captured pane snapshot, so
      // the controller can't act on a stale stickBottom between re-renders.
      isStuck: () => readState().chatPanes.find((p) => p.id === paneId)?.stickBottom,
      setStuck: (next) =>
        updateState((s) => {
          const target = s.chatPanes.find((p) => p.id === paneId);
          if (target && target.stickBottom !== next) target.stickBottom = next;
        }),
    }));
  }

  // Action for the `.transcript` element of one pane. In the single-pane
  // layout the SAME element serves whichever pane is shown, so when the pane
  // is replaced (a new chat, another conversation) the element is handed to
  // the new pane's controller. Without that the old controller kept the
  // element and wrote `stickBottom` to a pane that no longer exists: wheel-up
  // never detached, 맨 아래로 never appeared, and a streamed answer pulled the
  // reader back down.
  function transcriptStick(node: HTMLElement, paneId: string) {
    let boundTo = paneId;
    let wired = stickFor(boundTo).attach(node);
    const release = (): void => {
      wired.destroy();
      delete inst.stickControllers[boundTo];
    };
    return {
      update(next: string) {
        if (next === boundTo) return;
        release();
        boundTo = next;
        wired = stickFor(boundTo).attach(node); // attach() lands at the bottom, as on a conversation open
      },
      destroy: release,
    };
  }

  // Per-pane active slash-option id, so aria-activedescendant tracks ArrowUp/Down.
  function activeSlashOptionId(item: ChatPane): string | undefined {
    if (slashPaneId !== item.id) return undefined;
    const matches = slashMatches(item);
    if (!matches.length) return undefined;
    return slashOptionId(item.id, Math.min(slashIndex, matches.length - 1));
  }
  const activeSlashDescendant: Record<string, string | undefined> = {};
  for (const p of state.chatPanes) activeSlashDescendant[p.id] = activeSlashOptionId(p);

  function toggleComposerSettings(item: ChatPane) {
    const closing = composerSettingsOpenPaneIdRef.current === item.id;
    setComposerSettingsOpenPaneId(closing ? "" : item.id);
    if (closing && mcpToolsOpenPaneIdRef.current === item.id) setMcpToolsOpenPaneId("");
  }

  function toggleMcpToolsPanel(item: ChatPane) {
    const closing = mcpToolsOpenPaneIdRef.current === item.id;
    setMcpToolsOpenPaneId(closing ? "" : item.id);
  }

  function closeMcpToolsPanel() {
    setMcpToolsOpenPaneId("");
  }

  // The composer takes the focus once the DOM has what the handler just wrote
  // (the new draft): asked for here, done in the layout effect below.
  function focusComposer(paneId: string) {
    inst.focusPane = paneId;
    redraw();
  }

  async function submit(item: ChatPane) {
    if (!canSendMessage(item)) return;
    closeSlash();
    const message = item.draft;
    // On desktop, restore focus to the composer so the user can keep typing while
    // the response streams (the send button / touch tap moves focus off it). On
    // mobile, do the opposite: blur the textarea so the soft keyboard drops away
    // after sending instead of staying up over the conversation.
    const pending = sendMessage(item.id, message);
    if (isMobileViewport()) blurComposer(item.id);
    else focusComposer(item.id);
    await pending;
  }

  async function addImages(item: ChatPane, files: FileList | File[] | null | undefined) {
    if (!files) return;
    // Vision-off pane = FILE MODE: the server stages the image in the agent
    // workspace and hands the model only the path, so the ORIGINAL bytes go up
    // (no canvas re-encode) and only the four types the server sniffs pass.
    const fileMode = !paneVisionEnabled(item);
    const dropped = Array.from(files);
    let list = dropped.filter((f) => f.type.startsWith("image/"));
    if (fileMode) {
      list = list.filter((f) => (ACCEPTED_IMAGE_TYPES as string[]).includes(f.type));
      if (list.length < dropped.length) notify("PNG/JPEG/WebP/GIF만 첨부할 수 있습니다.", "warn");
      // Size-check before the room slice so an oversized file can't eat a slot.
      list = list.filter((f) => {
        if (f.size <= MAX_ATTACH_FILE_BYTES) return true;
        notify(`'${f.name || "이미지"}'은(는) 5 MB를 넘어 첨부할 수 없습니다.`, "warn");
        return false;
      });
    }
    if (!list.length) return;
    const current = readState().chatPanes.find((p) => p.id === item.id);
    const room = MAX_COMPOSER_IMAGES - (current?.pendingImages?.length || 0);
    if (room <= 0) {
      notify(`이미지는 최대 ${MAX_COMPOSER_IMAGES}장까지 첨부할 수 있습니다.`, "warn");
      return;
    }
    const accepted: PendingImage[] = [];
    for (const file of list.slice(0, room)) {
      try {
        const { dataUrl, mediaType } = fileMode
          ? { dataUrl: await readFileAsDataUrl(file), mediaType: file.type as ImageMediaType }
          : await resizeImageForChat(file);
        accepted.push({ id: newId(), dataUrl, name: file.name || "image", mediaType });
      } catch {
        notify(`'${file.name || "이미지"}'를 불러오지 못했습니다.`, "warn");
      }
    }
    if (list.length > room) notify(`이미지는 최대 ${MAX_COMPOSER_IMAGES}장까지 첨부할 수 있습니다.`, "warn");
    if (!accepted.length) return;
    updateState((s) => {
      const target = s.chatPanes.find((p) => p.id === item.id);
      if (target) target.pendingImages = [...(target.pendingImages || []), ...accepted];
    });
    if (fileMode) notify("현재 모델은 이미지 내용을 보지 못합니다. 이미지는 파일로만 전달됩니다.", "info");
  }

  // EVERY way in (picker, paste, drop) ends here. An image keeps the image
  // path whatever it is named; anything else is a document candidate, judged
  // by the shared rules — and refused outright where documents are not offered.
  async function addFiles(item: ChatPane, files: FileList | File[] | null | undefined) {
    const { images, others } = splitAttachFiles(files);
    await Promise.all([
      images.length ? addImages(item, images) : undefined,
      stageDocuments(item.id, others, paneTakesDocuments(item, readState())),
    ]);
  }

  // On a deployment with an upload relay the button never opens THIS page's
  // file dialog (the fleet's DRM agent decrypts only what is uploaded to a
  // registered address): the click is cancelled and the relay's page opens in
  // a popup — synchronously, inside the click, or the browser blocks it. What
  // is uploaded there comes back through `addFiles` like any other file.
  // Paste and drop are untouched.
  function onAttachClick(event: MouseEvent<HTMLInputElement>, item: ChatPane) {
    if (!readState().bootstrap?.uploadRelay) return;
    event.preventDefault();
    void startUploadRelay({
      documents: paneTakesDocuments(item, readState()),
      onFiles: (files) => addFiles(item, files),
      notify,
    });
  }

  async function onPickFiles(event: ChangeEvent<HTMLInputElement>, item: ChatPane) {
    const input = event.currentTarget;
    await addFiles(item, input.files);
    input.value = ""; // allow re-picking the same file
  }

  function onComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>, item: ChatPane) {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    // Prefer items (covers screenshots/copied images), fall back to files (some
    // browsers only populate one of the two; files copied in the OS file
    // manager arrive as `files`). Text entries are `kind:"string"` and never
    // count: a plain-text paste has no file and stays the textarea's own.
    const fromItems = Array.from(clipboard.items || [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => Boolean(f));
    const fromFiles = Array.from(clipboard.files || []);
    const files = (fromItems.length ? fromItems : fromFiles).filter(
      (f, i, arr) => arr.findIndex((g) => g.name === f.name && g.size === f.size) === i,
    );
    if (files.length) {
      event.preventDefault();
      void addFiles(item, files);
    }
  }

  /* ---- file drag and drop ---- */

  // A pane takes dropped files. Files only: the rail's conversation drag
  // (CONV_DND_MIME, below) carries no "Files" type and keeps its own handlers.
  // Every pane handler ignores an event that started outside the pane's own
  // DOM: a portaled dialog or fullscreen stage is a React child of this view,
  // so its events bubble here although they never crossed the pane.
  function onPaneFileDragOver(event: DragEvent<HTMLElement>, item: ChatPane) {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    if (fileDropPaneIdRef.current !== item.id) setFileDropPaneId(item.id);
  }
  function onPaneFileDragLeave(event: DragEvent<HTMLElement>, item: ChatPane) {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (fileDropPaneIdRef.current !== item.id) return;
    // Crossing between the pane's own children is not leaving it.
    const to = event.relatedTarget as Node | null;
    if (to && event.currentTarget.contains(to)) return;
    setFileDropPaneId("");
  }
  function onPaneFileDrop(event: DragEvent<HTMLElement>, item: ChatPane) {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setFileDropPaneId("");
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    void addFiles(item, files);
    focusComposer(item.id);
  }

  // While the chat view is mounted a file dropped outside a pane must not
  // navigate the browser to it.
  useWindowEvent("dragover", (event) => {
    if (!isFileDrag(event) || event.defaultPrevented || isFileInput(event.target)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  });
  useWindowEvent("drop", (event) => {
    setFileDropPaneId("");
    if (!isFileDrag(event) || event.defaultPrevented || isFileInput(event.target)) return;
    event.preventDefault();
  });
  // The drag ended outside the page (or was cancelled there): no pane's
  // dragleave ever fires for that.
  useWindowEvent("dragleave", (event) => {
    if (fileDropPaneIdRef.current && !event.relatedTarget) setFileDropPaneId("");
  });

  function removePendingImage(item: ChatPane, id: string) {
    updateState((s) => {
      const target = s.chatPanes.find((p) => p.id === item.id);
      if (target) target.pendingImages = (target.pendingImages || []).filter((img) => img.id !== id);
    });
  }

  function openShareDialog(item: ChatPane, att: MessageAttachment): void {
    setShareTarget({ conversationId: item.conversationId, attachment: att });
  }

  function closeShareDialog(): void {
    setShareTarget(null);
  }

  // File-card click: the file opens in the right-side panel — in the 파일 tab,
  // at the file as it is now, where the card recorded its place; a deck (its
  // own slide renders) and a card without a place open as their own tab
  // (`openSharedFile`). Split view keeps the direct download: its panes are
  // narrow, and the one side panel serves only the ACTIVE pane.
  function openFilePreview(item: ChatPane, att: MessageAttachment, source: MessageAttachment[] | undefined): void {
    if (readState().chatPanes.length > 1) {
      const a = document.createElement("a");
      a.href = fileSrc(item.conversationId, att);
      a.download = att.name || "file";
      document.body.append(a);
      a.click();
      a.remove();
      return;
    }
    openSharedFile(item.id, att, panelSlides(source, att));
  }

  async function ensureSkills(item: ChatPane) {
    if (item.skillsLoaded || inst.skillsInFlight.has(item.id) || !item.avatar?.id) return;
    inst.skillsInFlight.add(item.id);
    try {
      const result = await api<{ skills: SkillInfo[] }>(`/api/avatars/${encodeURIComponent(item.avatar.id)}/skills`);
      updateState((s) => {
        const target = s.chatPanes.find((p) => p.id === item.id);
        if (target) {
          target.skills = result.skills || [];
          target.skillsLoaded = true;
        }
      });
    } catch {
      // Soft-fail: the menu still shows built-in commands. Mark loaded so we don't
      // retry on every keystroke; a fresh pane (e.g. reload) gets another chance.
      updateState((s) => {
        const target = s.chatPanes.find((p) => p.id === item.id);
        if (target) target.skillsLoaded = true;
      });
    } finally {
      inst.skillsInFlight.delete(item.id);
    }
  }
  function closeSlash() {
    setSlashPaneId("");
    setSlashIndex(0);
  }
  function applySlash(item: ChatPane, cmd: SlashCommand) {
    closeSlash();
    if (cmd.action === "new") {
      setDraft(item.id, "");
      newChat(item.id);
      return;
    }
    // Skill entries aren't typeable as a raw "/command" (names can contain ":"),
    // so we send the expanded instruction that names the skill instead.
    if (cmd.kind === "skill") {
      setDraft(item.id, cmd.prompt ? cmd.prompt("") : "");
      void submit(item);
      return;
    }
    if (cmd.requiresArgs) {
      setDraft(item.id, `/${cmd.name} `);
      focusComposer(item.id);
      return;
    }
    setDraft(item.id, `/${cmd.name}`);
    void submit(item);
  }
  function completeSlash(item: ChatPane, cmd: SlashCommand) {
    // Tab on a skill drops its instruction into the composer (editable) instead of
    // sending, so the user can append details before pressing Enter.
    if (cmd.kind === "skill") {
      setDraft(item.id, cmd.prompt ? `${cmd.prompt("")} ` : "");
      focusComposer(item.id);
      return;
    }
    setDraft(item.id, `/${cmd.name}${cmd.requiresArgs ? " " : ""}`);
    focusComposer(item.id);
  }

  function onComposerKeydown(event: KeyboardEvent<HTMLTextAreaElement>, item: ChatPane) {
    if (/^(Key|Digit|Numpad|Arrow|F\d)/.test(event.code || "")) setPhysicalKeyboard(true);
    const matches = slashPaneIdRef.current === item.id ? slashMatches(item) : [];
    if (matches.length) {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "Home") setSlashIndex(0);
        else if (event.key === "End") setSlashIndex(matches.length - 1);
        else setSlashIndex((slashIndexRef.current + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        applySlash(item, matches[Math.min(slashIndexRef.current, matches.length - 1)]);
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        completeSlash(item, matches[Math.min(slashIndexRef.current, matches.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlash();
        return;
      }
    }
    // As drawn: the key that reveals a physical keyboard does not itself send.
    if (!enterSends) return;
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      if (item.streaming) {
        // Mid-turn message: the server hands it to the model between the running
        // turn's tool calls.
        const held = heldAttachmentNoun(item);
        if (held) {
          // Swallow the Enter too: the user meant "send", and a stray newline on
          // top of the refusal is noise. What is staged stays staged for the
          // next ordinary message.
          event.preventDefault();
          notify(`${held}는 응답이 끝난 뒤 보낼 수 있어요.`, "warn");
          return;
        }
        // Nothing typed — fall through so Enter still breaks the line.
        if (!item.draft.trim()) return;
        event.preventDefault();
        void sendSteer(item.id, item.draft);
        return;
      }
      if (!canSendMessage(item)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      void submit(item);
    }
  }

  function onComposerInput(event: ChangeEvent<HTMLTextAreaElement>, item: ChatPane) {
    const value = event.currentTarget.value;
    setDraft(item.id, value);
    if (slashQuery(value) !== null && !item.streaming) {
      setSlashPaneId(item.id);
      setSlashIndex(0);
      void ensureSkills(item);
    } else if (slashPaneIdRef.current === item.id) {
      closeSlash();
    }
  }

  // (`useStarter`/`useTour` in the original: renamed, since a `use…` name reads as a hook here.)
  function seedStarter(item: ChatPane, text: string) {
    setActive(item.id);
    setDraft(item.id, text);
    focusComposer(item.id);
  }

  /**
   * Seed a guided tour: the literal "/tour <slug>" goes into the composer and the
   * SERVER expands it, so no copy of the agent-facing prompt lives client-side.
   * A browser tour turns its own prerequisite on in the SAME click (a card whose
   * unstated prerequisite makes it fail on step one reads as broken) — which also
   * brings up the bridge badge, itself the path to the install guide. Never
   * auto-sent: the owner reads the seeded line and presses send.
   */
  function seedTour(item: ChatPane, scenario: TourScenario) {
    if (scenario.needsBrowser && !selectedMcpToolGroups(item).includes("browser")) {
      setMcpToolGroup(item, "browser", true);
    }
    seedStarter(item, `/tour ${scenario.slug}`);
  }

  /* ---- 여기서부터 다시: edit an earlier user message in place ------------------
     The bubble turns into its own small editor; sending it (after one confirm)
     replaces that message and everything after it. The composer is not involved,
     so a half-typed next message there survives the edit. */
  function openRewindEdit(item: ChatPane, message: StoredMessage) {
    setActive(item.id);
    startRewindEdit(item.id, message.id);
  }

  function onRewindEditKeydown(event: KeyboardEvent<HTMLTextAreaElement>, item: ChatPane) {
    if (/^(Key|Digit|Numpad|Arrow|F\d)/.test(event.code || "")) setPhysicalKeyboard(true);
    // An IME composition owns Enter and Escape until it commits.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRewindEdit(item.id);
      return;
    }
    // Same rule as the composer: Enter sends where a physical keyboard is in
    // use; on touch it is a newline and the button sends.
    if (!enterSends || event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    const edit = item.rewindEdit;
    if (item.streaming || !edit) return;
    if (!edit.draft.trim() && !hasVisibleImages(item.messages.find((m) => m.id === edit.messageId))) return;
    void submitRewindEdit(item.id);
  }

  function scrollToBottom(item: ChatPane) {
    stickFor(item.id).jumpToBottom();
  }

  async function addSplitPane() {
    if (splitAddBusyRef.current) return;
    const avatar = splitOptions.find((item) => item.id === splitAvatarId);
    if (!avatar) return;
    if (panes.length >= 4) {
      notify("분할 대화는 최대 4개까지 가능합니다.", "warn");
      return;
    }
    setSplitAddBusy(true);
    try {
      await startChatWith(avatar as AvatarSummary, true);
    } catch (err) {
      notify(`분할 대화를 추가하지 못했습니다: ${(err as Error).message}`, "warn");
    } finally {
      setSplitAddBusy(false);
    }
  }

  // The same guard as the pane's handlers: only what happened inside the
  // element itself counts (a portaled child's events bubble through React).
  function onWorkbenchDragOver(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (!isConvDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  }
  function onWorkbenchDragLeave(event: DragEvent<HTMLElement>) {
    // Only clear when leaving the workbench itself, not when crossing children.
    if (event.currentTarget === event.target) setDropActive(false);
  }
  async function onWorkbenchDrop(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (!isConvDrag(event)) return;
    event.preventDefault();
    setDropActive(false);
    const conversationId = event.dataTransfer?.getData(CONV_DND_MIME);
    if (!conversationId) return;
    try {
      await addConversationToSplit(conversationId);
    } catch (err) {
      notify(`분할에 추가하지 못했습니다: ${(err as Error).message}`, "warn");
    }
  }

  // pi model picked in the composer ("" = pi-gateway's default model). It lives
  // on the pane and rides the next chat POST (which persists it per-conversation),
  // AND writes through to the owner's remembered default so the choice seeds the
  // next new conversation.
  function setModel(item: ChatPane, model: string) {
    updateState((s) => {
      const target = s.chatPanes.find((p) => p.id === item.id);
      if (target) target.model = model || undefined;
      if (s.user) s.user.modelDefault = model || null;
    });
    notify(`모델을 ${modelLabel(model, readState())}(으)로 변경했습니다. 다음 메시지부터 적용됩니다.`, "info");
    api("/api/me/chat-defaults", { method: "PUT", body: JSON.stringify({ model: model || null }) }).catch((err) =>
      notify(`기본 모델을 저장하지 못했습니다: ${(err as Error).message}`, "warn"),
    );
  }

  // Reasoning effort, mirroring setModel: lives on the pane, rides the next chat
  // POST (per-conversation), and writes through to the remembered per-user default.
  // Every value is a real level (the default is "높음"/high when never chosen).
  function setEffort(item: ChatPane, effort: string) {
    updateState((s) => {
      const target = s.chatPanes.find((p) => p.id === item.id);
      if (target) target.effort = effort;
      if (s.user) s.user.effortDefault = effort;
    });
    const label = readState().bootstrap?.effortSelection?.levels.find((e) => e.id === effort)?.label;
    notify(`사고 강도: ${label ?? effort}. 다음 메시지부터 적용됩니다.`, "info");
    api("/api/me/chat-defaults", { method: "PUT", body: JSON.stringify({ effort }) }).catch((err) =>
      notify(`기본 사고 강도를 저장하지 못했습니다: ${(err as Error).message}`, "warn"),
    );
  }

  function setMcpToolGroup(item: ChatPane, groupId: McpToolGroupId, on: boolean) {
    // Admin-blocked groups are disabled in the picker; ignore any stray toggle.
    if (isRequiredMcpToolGroup(groupId) || adminBlockedMcpToolGroupSet.has(groupId)) return;
    const current = new Set(selectedMcpToolGroups(item));
    if (on) current.add(groupId);
    else current.delete(groupId);
    const next = MCP_TOOL_GROUPS.map((group) => group.id).filter((id) => current.has(id));
    updateState((s) => {
      const target = s.chatPanes.find((p) => p.id === item.id);
      if (target) target.mcpToolGroups = next;
      if (s.user) s.user.mcpToolGroupsDefault = [...next];
    });
    const label = MCP_TOOL_GROUPS.find((group) => group.id === groupId)?.labelKo ?? groupId;
    notify(`"${label}" MCP 도구를 ${on ? "사용" : "사용 해제"}했습니다. 다음 메시지부터 적용됩니다.`, "info");
    api("/api/me/chat-defaults", { method: "PUT", body: JSON.stringify({ mcpToolGroups: next }) }).catch((err) =>
      notify(`기본 MCP 도구 설정을 저장하지 못했습니다: ${(err as Error).message}`, "warn"),
    );
  }

  /** Start loading AnswerUi (once): called when the first placeholder for it mounts. */
  function loadAnswerUi(): void {
    if (!answerUiRef.current && !inst.answerUiLoading) {
      inst.answerUiLoading = true;
      void import("../../components/widget/AnswerUi").then(
        (mod) => {
          setAnswerUi(mod.default);
        },
        () => {
          setAnswerUiFailed(true);
        },
      );
    }
  }
  function hasInlineUi(text: string | null | undefined): boolean {
    if (!text) return false;
    if (text.length < 400) return containsInlineUi(text);
    const known = inst.inlineUiVerdicts.get(text);
    if (known !== undefined) return known;
    const verdict = containsInlineUi(text);
    inst.inlineUiVerdicts.set(text, verdict);
    if (inst.inlineUiVerdicts.size > 300) inst.inlineUiVerdicts.delete(inst.inlineUiVerdicts.keys().next().value as string);
    return verdict;
  }

  function toggleCard(key: string, event: SyntheticEvent<HTMLDetailsElement>): void {
    const open = event.currentTarget.open;
    const current = expandedCardsRef.current;
    if (open === current.has(key)) return;
    const next = new Set(current);
    if (open) next.add(key);
    else next.delete(key);
    setExpandedCards(next);
  }

  function streamBlocks(scope: string, segment: number | string, text: string, heal: boolean): StreamBlock[] {
    const key = `${scope}\u0000${segment}`;
    let renderer = inst.streamRenderers.get(key);
    if (!renderer) {
      renderer = createStreamMarkdown();
      inst.streamRenderers.set(key, renderer);
    }
    return renderer.render(text, { heal });
  }

  function toggleLiveThinking(paneId: string, event: SyntheticEvent<HTMLDetailsElement>): void {
    const open = event.currentTarget.open;
    const current = openLiveThinkingRef.current;
    if (open === current.has(paneId)) return;
    const next = new Set(current);
    if (open) next.add(paneId);
    else next.delete(paneId);
    setOpenLiveThinking(next);
  }

  // Drop the renderers and open-card marks of bubbles that are gone (a turn
  // ended, a drain finished) — in the render body, before anything below is
  // drawn.
  let openLiveThinking = openLiveThinkingState;
  if (inst.streamRenderers.size || openLiveThinking.size) {
    for (const key of [...inst.streamRenderers.keys()]) {
      const scope = key.slice(0, key.indexOf("\u0000"));
      const alive = scope.startsWith("m:") ? scope in reveal : panes.some((p) => p.id === scope && p.streaming);
      if (!alive) inst.streamRenderers.delete(key);
    }
    const kept = [...openLiveThinking].filter((paneId) => panes.some((p) => p.id === paneId && p.streaming && p.liveThinking));
    if (kept.length !== openLiveThinking.size) {
      openLiveThinking = new Set(kept);
      setOpenLiveThinking(openLiveThinking);
    }
  }

  // After every render of the view, with the DOM already updated (the panes'
  // own layout effects ran first):
  useLayoutEffect(() => {
    // Re-pin on every store-driven render (new message, conversation switch —
    // even one that doesn't change content height, which the ResizeObserver
    // can't see). pin() bails when the user has scrolled up.
    for (const item of panes) inst.stickControllers[item.id]?.pin();
    // The composer focus a handler asked for, caret at the end.
    const paneId = inst.focusPane;
    if (paneId !== null) {
      inst.focusPane = null;
      const el = document.querySelector<HTMLTextAreaElement>(`[data-pane="${paneId}"] .composer-box textarea`);
      el?.focus();
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    }
  });

  return {
    state,
    reveal,
    clocks,
    now,
    panes,
    pane,
    user,
    splitClass,
    splitOptions,
    splitAvatarId,
    setSplitAvatarId,
    splitAddBusy,
    addSplitPane,
    enterSends,
    isOwnPane,
    tourScenarios,
    adminBlockedMcpToolGroupSet,
    // 할 일
    todoOverlayOpen,
    todoOverlayShown,
    todoLoaded,
    todoOpenCount,
    todoOverdueCount,
    todoCountPop,
    noteTodoTogglePress,
    toggleTodoOverlayIn,
    // composer
    slashPaneId,
    slashIndex,
    activeSlashDescendant,
    applySlash,
    mcpToolsOpenPaneId,
    composerSettingsOpenPaneId,
    toggleComposerSettings,
    toggleMcpToolsPanel,
    closeMcpToolsPanel,
    bridgeCompat,
    submit,
    onPickFiles,
    onAttachClick,
    onComposerPaste,
    onComposerKeydown,
    onComposerInput,
    removePendingImage,
    setModel,
    setEffort,
    setMcpToolGroup,
    // panes
    setActive,
    fileDropPaneId,
    onPaneFileDragOver,
    onPaneFileDragLeave,
    onPaneFileDrop,
    dropActive,
    onWorkbenchDragOver,
    onWorkbenchDragLeave,
    onWorkbenchDrop,
    // transcript
    transcriptStick,
    scrollToBottom,
    seedStarter,
    seedTour,
    copyMessage,
    openRewindEdit,
    onRewindEditKeydown,
    openFilePreview,
    openShareDialog,
    closeShareDialog,
    shareTarget,
    AnswerUi,
    answerUiFailed,
    loadAnswerUi,
    hasInlineUi,
    expandedCards,
    toggleCard,
    streamBlocks,
    openLiveThinking,
    toggleLiveThinking,
  };
}

export type ChatController = ReturnType<typeof useChatController>;
