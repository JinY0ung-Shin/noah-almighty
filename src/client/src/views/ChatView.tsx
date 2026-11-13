// The chat view: one pane, or up to four side by side, each with its
// transcript and composer; the side panel of the active pane; and the ONE
// share-link dialog. State and handlers live in ./chat/controller.tsx, the
// transcript in ./chat/Transcript.tsx, the composer in ./chat/Composer.tsx.
import { Fragment, type ReactNode } from "react";
import AvatarImage from "../components/AvatarImage";
import Icon from "../components/Icon";
import PromptModal from "../components/PromptModal";
import ShareLinkDialog from "../components/ShareLinkDialog";
import SidePanel from "../components/SidePanel";
import { closePane, closeWorkspaceTab, newChat, openWorkspaceTab } from "../lib/chat";
import { cx } from "../lib/hooks";
import { goView } from "../lib/nav";
import { Presence } from "../lib/presence";
import { WORKSPACE_TAB, hasSideTabs, resolveSideTab, sameTab } from "../lib/sidePanel";
import { updateState } from "../lib/state";
import { Composer } from "./chat/Composer";
import { PaneTranscript, fileDropOverlay } from "./chat/Transcript";
import { paneDomId, paneTakesDocuments, useChatController, type ChatController } from "./chat/controller";
import "./ChatView.css";

const SPLIT_LAYOUTS = ["vertical", "horizontal", "grid"] as const;

function splitControls(ctx: ChatController): ReactNode {
  const { panes, state, splitOptions, splitAddBusy } = ctx;
  return (
    <div className="split-controls" role="group" aria-label="분할 대화">
      {panes.length > 1
        ? SPLIT_LAYOUTS.map((layout) => (
            <button
              key={layout}
              type="button"
              className={cx("split-btn", state.chatLayout === layout && "active")}
              aria-label={layout === "vertical" ? "좌우 분할" : layout === "horizontal" ? "상하 분할" : "격자 분할"}
              aria-pressed={state.chatLayout === layout ? "true" : "false"}
              onClick={() =>
                updateState((s) => {
                  s.chatLayout = layout as typeof s.chatLayout;
                })
              }
            >
              <Icon name={layout === "vertical" ? "columns" : layout === "horizontal" ? "rows" : "grid"} />
            </button>
          ))
        : null}{" "}
      <select
        className="split-avatar-select"
        value={ctx.splitAvatarId}
        onChange={(event) => ctx.setSplitAvatarId(event.currentTarget.value)}
        disabled={splitAddBusy || !splitOptions.length || panes.length >= 4}
        aria-label="분할로 추가할 아바타"
      >
        {splitOptions.length ? (
          splitOptions.map((av, index) => (
            <option key={index} value={av.id}>
              {av.alias || av.displayName || av.username}
            </option>
          ))
        ) : (
          <option value="">추가할 아바타 없음</option>
        )}
      </select>{" "}
      <button
        className="split-add"
        type="button"
        title="대화 추가 (분할)"
        aria-label="대화 추가 (분할)"
        disabled={splitAddBusy || !splitOptions.length || panes.length >= 4}
        onClick={() => void ctx.addSplitPane()}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}

// 파일: the viewer's own sandbox workspace as a tab of the side panel (the
// ACTIVE pane's, like every side tab). Only where the server can show it.
// Pressed while that tab is the one showing; pressing it then closes the tab.
function workspaceButton(ctx: ChatController): ReactNode {
  const { state, pane } = ctx;
  if (!pane || !state.bootstrap?.workspaceFiles) return null;
  const shown = Boolean(pane.workspaceTab) && sameTab(resolveSideTab(pane), WORKSPACE_TAB);
  return (
    <button
      className="ghost-sm workspace-open"
      type="button"
      title="아바타가 작업하는 폴더의 파일 보기"
      aria-pressed={shown ? "true" : "false"}
      onClick={() => (shown ? closeWorkspaceTab() : openWorkspaceTab(pane.id))}
    >
      <Icon name="folder" size={14} /> 파일
    </button>
  );
}

export default function ChatView() {
  const ctx = useChatController();
  const { state, panes, pane, dropActive } = ctx;

  let body: ReactNode;
  if (!pane) {
    body = (
      <Fragment key="none">
        <header className="view-header cmp-chat-view">
          <div>
            <h1>대화</h1> <p>탐색에서 아바타를 골라 대화를 시작하세요</p>
          </div>
        </header>{" "}
        <div
          className={cx("view-body", dropActive && "drop-active", "cmp-chat-view")}
          onDragOver={ctx.onWorkbenchDragOver}
          onDragLeave={ctx.onWorkbenchDragLeave}
          onDrop={(event) => void ctx.onWorkbenchDrop(event)}
        >
          <div className="empty-state">
            <div className="hero">
              <h3>아직 선택한 아바타가 없습니다</h3>{" "}
              <p>탐색 탭에서 대화할 아바타를 골라 주세요. 왼쪽 대화 목록에서 대화를 끌어와 열 수도 있습니다.</p>
            </div>{" "}
            <button className="primary" type="button" onClick={() => goView("explore")}>
              대화할 아바타 찾기
            </button>
          </div>
        </div>
      </Fragment>
    );
  } else if (panes.length > 1) {
    body = (
      <Fragment key="split">
        <header className="view-header chat-head cmp-chat-view">
          <div className="header-left">
            <div className="title">
              <h1>분할 대화</h1> <p>최대 4개의 대화를 동시에 진행할 수 있습니다.</p>
            </div>
          </div>{" "}
          <div className="chat-head-actions">
            {splitControls(ctx)} {workspaceButton(ctx)}{" "}
            <button className="ghost-sm" type="button" disabled={pane.streaming} onClick={() => newChat(pane.id)}>
              새 대화
            </button>
          </div>
        </header>{" "}
        <div className="chat-layout cmp-chat-view">
          <div
            className={cx(`chat-workbench ${ctx.splitClass}`, dropActive && "drop-active")}
            onDragOver={ctx.onWorkbenchDragOver}
            onDragLeave={ctx.onWorkbenchDragLeave}
            onDrop={(event) => void ctx.onWorkbenchDrop(event)}
          >
            {panes.map((item, index) => (
              <section
                key={item.id}
                className={cx("chat-col chat-pane compact", item.id === pane.id && "active")}
                data-pane={item.id}
                aria-labelledby={paneDomId("pane-title", item.id)}
                aria-current={item.id === pane.id ? "true" : undefined}
                onFocus={(event) => {
                  // A portaled child (a dialog, a fullscreen stage) is a React
                  // child of the pane: its focus is not the pane's.
                  if (!event.currentTarget.contains(event.target as Node)) return;
                  ctx.setActive(item.id);
                }}
                onDragEnter={(event) => ctx.onPaneFileDragOver(event, item)}
                onDragOver={(event) => ctx.onPaneFileDragOver(event, item)}
                onDragLeave={(event) => ctx.onPaneFileDragLeave(event, item)}
                onDrop={(event) => ctx.onPaneFileDrop(event, item)}
              >
                <div className="pane-head">
                  <button
                    id={paneDomId("pane-title", item.id)}
                    className="pane-title pane-title-button"
                    type="button"
                    aria-pressed={item.id === pane.id ? "true" : "false"}
                    onClick={() => ctx.setActive(item.id)}
                  >
                    <AvatarImage user={item.avatar} size={30} alt="" />{" "}
                    <div>
                      <strong>대화 {index + 1}</strong> <span>{item.avatar.alias || item.avatar.displayName}</span>
                    </div>
                  </button>{" "}
                  <div className="pane-actions">
                    <button
                      className="ghost-sm"
                      type="button"
                      disabled={item.streaming}
                      onClick={(event) => {
                        event.stopPropagation();
                        newChat(item.id);
                      }}
                    >
                      새 대화
                    </button>{" "}
                    <button
                      className="msg-act"
                      type="button"
                      aria-label="대화 창 닫기"
                      disabled={panes.length <= 1}
                      onClick={(event) => {
                        event.stopPropagation();
                        closePane(item.id);
                      }}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                </div>{" "}
                <PaneTranscript ctx={ctx} item={item} /> <Composer ctx={ctx} item={item} compact index={index} />{" "}
                {fileDropOverlay(ctx, item, paneTakesDocuments(item, state))} <PromptModal paneId={item.id} />
              </section>
            ))}
          </div>{" "}
          {/* Same side panel as the single-pane branch, for the ACTIVE pane:
              without it a canvas created while split is invisible until the
              user is back to one pane. */}
          {hasSideTabs(pane) ? <SidePanel pane={pane} onShare={(att) => ctx.openShareDialog(pane, att)} /> : null}
        </div>
      </Fragment>
    );
  } else {
    body = (
      <div
        key="single"
        className={cx("chat-layout", dropActive && "drop-active", "cmp-chat-view")}
        onDragOver={ctx.onWorkbenchDragOver}
        onDragLeave={ctx.onWorkbenchDragLeave}
        onDrop={(event) => void ctx.onWorkbenchDrop(event)}
      >
        <section
          className="chat-col chat-pane active"
          data-pane={pane.id}
          onDragEnter={(event) => ctx.onPaneFileDragOver(event, pane)}
          onDragOver={(event) => ctx.onPaneFileDragOver(event, pane)}
          onDragLeave={(event) => ctx.onPaneFileDragLeave(event, pane)}
          onDrop={(event) => ctx.onPaneFileDrop(event, pane)}
        >
          <header className="view-header chat-head">
            <div className="header-left">
              <div className="chat-avatar">
                <AvatarImage user={pane.avatar} size={36} alt="" />{" "}
                <div>
                  <h1 className="ca-name">{pane.avatar.alias || pane.avatar.displayName}</h1>{" "}
                  <div className="ca-handle">
                    @{pane.avatar.username}
                    {pane.avatar.elevated ? "" : " · 읽기 전용"}
                  </div>
                </div>
              </div>
            </div>{" "}
            <div className="chat-head-actions">
              {splitControls(ctx)} {workspaceButton(ctx)}{" "}
              <button className="ghost-sm" type="button" disabled={pane.streaming} onClick={() => newChat(pane.id)}>
                새 대화
              </button>
            </div>
          </header>{" "}
          <PaneTranscript ctx={ctx} item={pane} /> <Composer ctx={ctx} item={pane} compact={false} index={0} />{" "}
          {fileDropOverlay(ctx, pane, paneTakesDocuments(pane, state))} <PromptModal paneId={pane.id} />
        </section>{" "}
        {hasSideTabs(pane) ? <SidePanel pane={pane} onShare={(att) => ctx.openShareDialog(pane, att)} /> : null}
      </div>
    );
  }

  return (
    <>
      {body}{" "}
      <Presence>
        {ctx.shareTarget ? (
          <ShareLinkDialog
            key="share-link"
            conversationId={ctx.shareTarget.conversationId}
            attachment={ctx.shareTarget.attachment}
            onClose={ctx.closeShareDialog}
          />
        ) : null}
      </Presence>
    </>
  );
}
