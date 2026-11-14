// One pane's composer (views/ChatView.tsx): slash menu, staged attachments,
// the message box with its send / mid-turn send / stop controls, and the hint
// row (할 일 switch, per-conversation settings, usage, the bridge badge) with
// the MCP 도구 panel. State and handlers come from the controller (`ctx`).
// The `{" "}` between siblings are the original template's whitespace text
// nodes (see Transcript.tsx).
import Icon from "../../components/Icon";
import { sendSteer, stopPane } from "../../lib/chat";
import { autosize, clickOutside } from "../../lib/dom";
import { featureHintAnchor } from "../../lib/featureHints";
import { IMAGE_ACCEPT, IMAGE_AND_DOCUMENT_ACCEPT, documentTypeLabel, removePendingDocument } from "../../lib/composerDocuments";
import { formatFileSize, formatUsageLabel } from "../../lib/format";
import { cx, useAction } from "../../lib/hooks";
import type { ChatPane } from "../../lib/types";
import { DEFAULT_EFFORT_LEVEL } from "../../../../server/effortLevels";
import { MCP_TOOL_GROUPS, isRequiredMcpToolGroup } from "../../../../shared/mcpToolGroups";
import {
  attachHint,
  attachTitle,
  bridgeBadge,
  canSendMessage,
  canSteer,
  composerSettingsSummary,
  currentModel,
  effortOption,
  hasComposerControls,
  mcpToolsCount,
  openBrowserBridgeGuide,
  paneDomId,
  paneTakesDocuments,
  selectedMcpToolGroups,
  sendBlockedHint,
  slashMatches,
  slashOptionId,
  steerSendTitle,
  streamingPlaceholder,
  todoToggleTitle,
  type ChatController,
} from "./controller";

/** The MCP 도구 checkbox panel of one pane; a press anywhere else closes it. */
function ToolsPanel({ ctx, item }: { ctx: ChatController; item: ChatPane }) {
  const { adminBlockedMcpToolGroupSet } = ctx;
  const ref = useAction<HTMLDivElement, { onOutside: () => void; ignore?: string }>(clickOutside, {
    onOutside: ctx.closeMcpToolsPanel,
    ignore: ".composer-tools-btn",
  });
  return (
    <div id={paneDomId("composer-tools-panel", item.id)} className="composer-tools-panel" role="group" aria-label="이 대화에서 사용할 MCP 도구" ref={ref}>
      <div className="composer-tools-title">이 대화에서 사용할 MCP 도구</div>{" "}
      {MCP_TOOL_GROUPS.map((group) => {
        const adminBlocked = adminBlockedMcpToolGroupSet.has(group.id);
        return (
          <label key={group.id} className="composer-tools-item">
            <input
              type="checkbox"
              checked={selectedMcpToolGroups(item).includes(group.id) && !adminBlocked}
              disabled={isRequiredMcpToolGroup(group.id) || adminBlocked}
              onChange={(event) => ctx.setMcpToolGroup(item, group.id, event.currentTarget.checked)}
            />{" "}
            <span>
              <strong>{group.labelKo}</strong>{" "}
              <small>
                {isRequiredMcpToolGroup(group.id)
                  ? "항상 사용 · 매뉴얼과 시스템 상태를 확인합니다. 설정 변경은 기존 권한을 따릅니다."
                  : adminBlocked
                    ? "관리자의 도구 정책으로 제한된 도구 묶음입니다"
                    : group.descriptionKo}
              </small>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function Composer({ ctx, item, compact, index }: { ctx: ChatController; item: ChatPane; compact: boolean; index: number }) {
  const { state, pane, enterSends, adminBlockedMcpToolGroupSet, bridgeCompat, slashIndex } = ctx;
  const { todoLoaded, todoOpenCount, todoOverdueCount, todoCountPop } = ctx;
  // Grows with the draft, and shrinks back when a send clears it.
  const box = useAction(autosize, item.draft);
  const takesDocuments = paneTakesDocuments(item, state);
  const matches = ctx.slashPaneId === item.id ? slashMatches(item) : [];
  const models = state.bootstrap?.modelSelection;
  const efforts = state.bootstrap?.effortSelection;
  const usage = formatUsageLabel(item.usage);
  // Pressed only in the pane that actually shows the card (the active one).
  const todoHere = ctx.todoOverlayShown && pane?.id === item.id;
  const settingsOpen = ctx.composerSettingsOpenPaneId === item.id;
  const toolsOpen = ctx.mcpToolsOpenPaneId === item.id;
  const activeDescendant = ctx.activeSlashDescendant[item.id];
  const badge =
    bridgeCompat && selectedMcpToolGroups(item).includes("browser") && !adminBlockedMcpToolGroupSet.has("browser") ? bridgeBadge(bridgeCompat) : null;
  // The document-attach hint (#feature-hints) points at the + button — only
  // where it IS a + (a pane that takes documents), and not while the slash menu
  // or the staged-file strip occupies the space above it, where the bubble opens.
  const attachHintAnchor =
    takesDocuments && !matches.length && !item.pendingImages?.length && !item.pendingDocuments?.length
      ? featureHintAnchor("composer-attach")
      : undefined;

  return (
    <footer className="composer">
      <div className="composer-inner">
        <form
          className="composer-form"
          onSubmit={(event) => {
            event.preventDefault();
            void ctx.submit(item);
          }}
        >
          {matches.length ? (
            <div id={paneDomId("slash-menu", item.id)} className="slash-menu" role="listbox" aria-label="슬래시 명령">
              <div className="slash-menu-head">슬래시 명령</div>{" "}
              {matches.map((cmd, i) => (
                <button
                  key={i}
                  id={slashOptionId(item.id, i)}
                  className={cx("slash-option", i === Math.min(slashIndex, matches.length - 1) && "active")}
                  type="button"
                  role="option"
                  aria-selected={i === slashIndex ? "true" : "false"}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => ctx.applySlash(item, cmd)}
                >
                  <span className="slash-option-command">
                    /{cmd.name}
                    {cmd.argsLabel ? ` ${cmd.argsLabel}` : ""}{" "}
                    {cmd.kind === "skill" ? (
                      <span className="slash-option-tag">스킬{cmd.source && cmd.source !== "default" ? ` · ${cmd.source}` : ""}</span>
                    ) : null}
                  </span>{" "}
                  <span className="slash-option-main">
                    <strong>{cmd.title}</strong>
                    <span>{cmd.description}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}{" "}
          {item.pendingImages?.length || item.pendingDocuments?.length ? (
            <div className="composer-attachments" role="group" aria-label="첨부한 파일">
              {(item.pendingImages ?? []).map((img) => (
                <div key={img.id} className="composer-thumb">
                  <img src={img.dataUrl} alt={img.name} />{" "}
                  <button
                    className="composer-thumb-remove"
                    type="button"
                    aria-label="이미지 제거"
                    title="제거"
                    disabled={item.streaming}
                    onClick={() => ctx.removePendingImage(item, img.id)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}{" "}
              {/* Document chips, after the image thumbnails: type, name, size (or
                  that the file is still being read) and a remove button. */}
              {(item.pendingDocuments ?? []).map((doc) => (
                <div key={doc.id} className={cx("composer-doc", doc.dataUrl === null && "is-reading")}>
                  <span className="composer-doc-type">{documentTypeLabel(doc.name)}</span>{" "}
                  <span className="composer-doc-meta">
                    <span className="composer-doc-name" title={doc.name}>
                      {doc.name}
                    </span>{" "}
                    <span className="composer-doc-info">{doc.dataUrl === null ? "읽는 중…" : formatFileSize(doc.size)}</span>
                  </span>{" "}
                  <button
                    className="composer-doc-remove"
                    type="button"
                    aria-label={`${doc.name} 제거`}
                    title="제거"
                    disabled={item.streaming}
                    onClick={() => removePendingDocument(item.id, doc.id)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
            </div>
          ) : null}{" "}
          <div className={cx("composer-box", canSteer(item) && "with-steer")}>
            <label ref={attachHintAnchor} className={cx("composer-attach", item.streaming && "disabled")} title={attachTitle(item, state)}>
              <Icon name={takesDocuments ? "plus" : "image"} />{" "}
              {/* Visually hidden, NOT `hidden`: the input stays in the tab order,
                  so the picker opens from the keyboard too (Space/Enter), and it
                  carries the control's name. */}
              <input
                className="sr-only"
                type="file"
                accept={takesDocuments ? IMAGE_AND_DOCUMENT_ACCEPT : IMAGE_ACCEPT}
                multiple
                aria-label={attachHint(item, state)}
                disabled={item.streaming}
                onClick={(event) => ctx.onAttachClick(event, item)}
                onChange={(event) => void ctx.onPickFiles(event, item)}
              />
            </label>{" "}
            {/* Intentionally NOT disabled while streaming: disabling blurs the
                textarea (focus loss after every send) and blocks composing the
                next message. What is typed mid-stream can be SENT into the
                running turn (see `canSteer`). */}
            <textarea
              rows={1}
              placeholder={item.streaming ? streamingPlaceholder(enterSends) : `${item.avatar.alias || item.avatar.displayName}에게 메시지…`}
              value={item.draft}
              aria-label={`${item.avatar.alias || item.avatar.displayName}에게 보낼 메시지`}
              aria-describedby={paneDomId("composer-hint", item.id)}
              ref={box}
              aria-controls={activeDescendant ? paneDomId("slash-menu", item.id) : undefined}
              aria-haspopup="listbox"
              aria-activedescendant={activeDescendant}
              onChange={(event) => ctx.onComposerInput(event, item)}
              onKeyDown={(event) => ctx.onComposerKeydown(event, item)}
              onPaste={(event) => ctx.onComposerPaste(event, item)}
            ></textarea>{" "}
            {/* Mid-turn send, LEFT of the stop button: two different actions on a
                streaming turn — hand the model another message, or kill the run —
                so they are two controls, never one that changes meaning. It stays
                mounted for the whole stream and merely disables, so the row never
                reflows mid-keystroke and the affordance is visible BEFORE the
                user has typed anything to use it on. */}
            {canSteer(item) ? (
              <button
                className="send-button steer-send"
                type="button"
                aria-label="응답 중 메시지 보내기"
                title={steerSendTitle(item)}
                disabled={item.steerSending || !item.draft.trim()}
                onClick={() => void sendSteer(item.id, item.draft)}
              >
                <Icon name="send" />
              </button>
            ) : null}{" "}
            <button
              className={cx("send-button", item.streaming && "is-stop")}
              type="button"
              aria-label={item.streaming ? "응답 중지" : "보내기"}
              title={item.streaming ? "응답 중지" : canSendMessage(item) ? "보내기" : sendBlockedHint(item, state)}
              disabled={!item.streaming && !canSendMessage(item)}
              onClick={() => void (item.streaming ? stopPane(item.id) : ctx.submit(item))}
            >
              <Icon name={item.streaming ? "stop" : "send"} />
            </button>
          </div>{" "}
          <div className="composer-hint" id={paneDomId("composer-hint", item.id)}>
            {compact ? (
              <span>대화 {index + 1}</span>
            ) : enterSends ? (
              <span>
                Enter 전송 · <kbd>Shift+Enter</kbd> 줄바꿈
              </span>
            ) : (
              <span>보내기 버튼으로 전송</span>
            )}{" "}
            {hasComposerControls(item) || usage ? (
              <span className="composer-meta">
                {/* The 할 일 overlay switch: the VIEWER's own list, in every pane
                    (one shared preference). Overdue carries text, not just a dot. */}
                <button
                  className="composer-todo-btn"
                  type="button"
                  aria-pressed={todoHere ? "true" : "false"}
                  aria-controls={todoHere ? "todo-overlay" : undefined}
                  title={todoToggleTitle(todoHere, todoLoaded, todoOpenCount, todoOverdueCount)}
                  onPointerDown={() => ctx.noteTodoTogglePress(item)}
                  onClick={() => ctx.toggleTodoOverlayIn(item)}
                >
                  <Icon name="check-square" size={14} />{" "}
                  <span>
                    할 일
                    {todoLoaded ? (
                      <>
                        {" "}
                        <span key={todoCountPop} className={cx("composer-todo-count", todoCountPop > 0 && "is-popping")}>
                          {todoOpenCount}
                        </span>
                      </>
                    ) : null}
                  </span>{" "}
                  {todoOverdueCount ? (
                    <span className="composer-todo-overdue">
                      <span className="composer-todo-dot" aria-hidden="true"></span>지남 {todoOverdueCount}
                    </span>
                  ) : null}
                </button>{" "}
                {hasComposerControls(item) ? (
                  <>
                    <button
                      className="composer-settings-btn"
                      type="button"
                      aria-expanded={settingsOpen ? "true" : "false"}
                      aria-controls={paneDomId("composer-controls", item.id)}
                      title="이 대화의 모델, 사고 강도, 지식, MCP 도구를 설정합니다"
                      onClick={() => ctx.toggleComposerSettings(item)}
                    >
                      <Icon name="gear" size={16} /> <span className="composer-settings-label">설정</span>{" "}
                      <span className="composer-settings-summary">{composerSettingsSummary(item, adminBlockedMcpToolGroupSet, state)}</span>
                    </button>{" "}
                    <span id={paneDomId("composer-controls", item.id)} className={cx("composer-controls", settingsOpen && "open")}>
                      {models?.models.length ? (
                        <select
                          className="composer-model-select"
                          aria-label="이 대화에 사용할 모델"
                          title="이 대화에서 다음 메시지부터 사용할 모델을 고릅니다"
                          value={currentModel(item, state)}
                          onChange={(event) => ctx.setModel(item, event.currentTarget.value)}
                        >
                          <option
                            value=""
                            title={models.defaultModel ? `관리자가 정한 기본 모델(${models.defaultModel})을 사용합니다` : "관리자가 정한 기본 모델을 사용합니다"}
                          >
                            {models.defaultModel ? `기본 모델 (${models.defaultModel})` : "기본 모델"}
                          </option>
                          {models.models.map((model) => (
                            <option key={model.id} value={model.id} title={model.server ? `${model.id}\n(${model.server})` : model.id}>
                              {model.id}
                            </option>
                          ))}
                        </select>
                      ) : null}{" "}
                      {efforts ? (
                        <select
                          className="composer-model-select"
                          aria-label="이 대화에 사용할 사고 강도(effort)"
                          title="이 대화에서 다음 메시지부터 모델이 들이는 사고/추론 강도를 고릅니다"
                          value={item.effort ?? efforts.default ?? DEFAULT_EFFORT_LEVEL}
                          onChange={(event) => ctx.setEffort(item, event.currentTarget.value)}
                        >
                          {efforts.levels.map((level) => {
                            const option = effortOption(item, level, state);
                            return (
                              <option key={level.id} value={level.id} title={option.title} disabled={option.disabled}>
                                {option.label}
                              </option>
                            );
                          })}
                        </select>
                      ) : null}{" "}
                      <button
                        className="composer-tools-btn"
                        type="button"
                        aria-expanded={toolsOpen ? "true" : "false"}
                        aria-controls={paneDomId("composer-tools-panel", item.id)}
                        title="이 대화에서 다음 메시지부터 사용할 MCP 도구 묶음을 고릅니다"
                        onClick={() => ctx.toggleMcpToolsPanel(item)}
                      >
                        MCP 도구 {mcpToolsCount(item, adminBlockedMcpToolGroupSet)}
                      </button>
                    </span>
                  </>
                ) : null}{" "}
                {usage ? <span className="composer-usage">{usage}</span> : null}{" "}
                {bridgeCompat && badge ? (
                  bridgeCompat.level === "current" ? (
                    <span className="composer-bridge" data-status="current" title={badge.title}>
                      {badge.text}
                    </span>
                  ) : (
                    // Any badge that reports something ACTIONABLE is a dead end
                    // without a way out: make the whole line the button to the
                    // install guide — including `compatible`, where the action
                    // is optional but real. Only the exact-match install stays a
                    // plain span, so the hint row keeps no control nobody needs.
                    <button
                      className="composer-bridge"
                      type="button"
                      data-status={bridgeCompat.level}
                      title={`${badge.title}\n\n눌러서 설치·업데이트 안내를 엽니다.`}
                      onClick={openBrowserBridgeGuide}
                    >
                      {badge.text} →
                    </button>
                  )
                ) : null}
              </span>
            ) : null}
          </div>
        </form>{" "}
        {toolsOpen ? <ToolsPanel ctx={ctx} item={item} /> : null}
      </div>
    </footer>
  );
}
