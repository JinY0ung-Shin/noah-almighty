import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import CanvasTab from "./CanvasTab";
import FileTab from "./FileTab";
import Icon from "./Icon";
import { closeFileTab, selectSideTab } from "../lib/chat";
import { cx } from "../lib/hooks";
import { resolveSideTab, sameTab, sideTabs, tabKey, type SideTab } from "../lib/sidePanel";
import { updateState } from "../lib/state";
import type { ChatPane, MessageAttachment, SideTabRef } from "../lib/types";

// The right-side panel: ONE frame — width, collapse, tab strip — for
// everything shown beside the chat. Canvases (#50) and the files opened from
// their cards are tabs of the same strip, so a .drawio preview and a canvas
// never take turns in the slot as two differently built panels. Every tab
// stays MOUNTED while another shows: a half-typed canvas answer and a
// rendered diagram survive a switch. Resizable via the left-edge handle,
// collapse state persisted in localStorage, stacked below the chat on narrow
// viewports. ChatView mounts it only while the pane has a tab.
export interface SidePanelProps {
  pane: ChatPane;
  /** 공유 링크 on a deck tab → ChatView's single dialog (FileTab explains why). */
  onShare?: (attachment: MessageAttachment) => void;
}

const WIDTH_MIN = 300;
const WIDTH_MAX = 1520;
const WIDTH_DEFAULT = 440;

function pref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function setPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: prefs just won't persist */
  }
}
// Bound the stored/dragged width to the panel's own min/max only. CSS owns the
// actual fit (`.canvas-panel:not(.collapsed)` flex-shrink + the chat-col floor,
// and stacking on narrow viewports — #40 responsive).
function clampWidth(width: number): number {
  return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, width));
}
function keyOf(ref: SideTabRef | null): string {
  return ref ? tabKey(ref) : "";
}
function needsLook(tab: SideTab, shown: SideTabRef | null, marks: Set<string>): boolean {
  if (sameTab(tab, shown)) return false;
  return marks.has(tabKey(tab)) || (tab.kind === "canvas" && Boolean(tab.canvas.pending));
}
function tabLabel(tab: SideTab): string {
  return tab.kind === "canvas" ? tab.canvas.title : tab.file.attachment.name || "파일";
}
function domId(paneId: string, prefix: string, key: string): string {
  return `${prefix}-${paneId}-${key}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export default function SidePanel({ pane, onShare = () => {} }: SidePanelProps) {
  // Read before the first render, not after the mount: an expand request that
  // arrives with the panel's first tab must find the stored state already
  // applied. One width for every tab (the canvas key, so a width dragged
  // before the merge is kept; the file preview's old key only seeds it).
  const [stored] = useState(() => {
    const width =
      clampWidth(Number(pref("canvasPanelWidth", pref("filePanelWidth", String(WIDTH_DEFAULT)))) || WIDTH_DEFAULT);
    const mobile = typeof window !== "undefined" && (window.matchMedia?.("(max-width: 860px)").matches ?? false);
    const collapsed = pref("canvasPanelCollapsed", mobile ? "1" : "0") === "1";
    return { width, collapsed, foldedOn: collapsed ? keyOf(resolveSideTab(pane)) : "" };
  });
  const [panelWidth, setPanelWidthState] = useState(stored.width);
  const panelWidthRef = useRef(stored.width); // the same width, for a drag's pointer listeners
  const [collapsed, setCollapsedState] = useState(stored.collapsed);
  // The tab that showed when the panel was folded away: the avatar moving the
  // panel on to another one since puts a dot on the strip (split view re-reads
  // it for each pane the panel serves).
  const [foldedOn, setFoldedOn] = useState(stored.foldedOn);
  const [foldedPane, setFoldedPane] = useState(pane.id);

  const tabs = sideTabs(pane);
  const current = resolveSideTab(pane);
  const currentKey = keyOf(current);
  const unseen = new Set(pane.sideUnseen ?? []);
  const stripLabel = pane.fileTabs?.length
    ? tabs.some((tab) => tab.kind === "canvas")
      ? "캔버스·파일 보기"
      : "파일 보기"
    : "캔버스 보기";

  if (pane.id !== foldedPane) {
    setFoldedPane(pane.id);
    setFoldedOn(currentKey);
  }

  function setPanelWidth(width: number): void {
    panelWidthRef.current = width;
    setPanelWidthState(width);
  }
  function savePanelWidth(width: number): void {
    setPanelWidth(clampWidth(width));
    setPref("canvasPanelWidth", String(Math.round(panelWidthRef.current)));
  }
  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startW = panelWidthRef.current;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("col-resizing");
    const onMove = (ev: PointerEvent) => {
      // Panel sits at the right edge → dragging left (smaller clientX) widens it.
      setPanelWidth(clampWidth(startW + (startX - ev.clientX)));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("col-resizing");
      setPref("canvasPanelWidth", String(Math.round(panelWidthRef.current)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }
  function onResizeKeydown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      savePanelWidth(panelWidthRef.current + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      savePanelWidth(panelWidthRef.current - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      savePanelWidth(WIDTH_DEFAULT);
    } else if (event.key === "End") {
      event.preventDefault();
      savePanelWidth(WIDTH_MAX);
    }
  }
  function setCollapsed(value: boolean): void {
    setCollapsedState(value);
    if (value) setFoldedOn(currentKey);
    setPref("canvasPanelCollapsed", value ? "1" : "0");
  }

  // One-shot: an ask for input or a file the viewer opened must not stay
  // hidden behind the collapsed strip. Consumed here, whatever pane is shown.
  // Not persisted: the viewer's own choice to keep the panel folded stands
  // for the next conversation (only the strip's buttons write it).
  const sideExpand = Boolean(pane.sideExpand);
  const paneId = pane.id;
  useLayoutEffect(() => {
    if (!sideExpand) return;
    setCollapsedState(false);
    updateState((state) => {
      const target = state.chatPanes.find((item) => item.id === paneId);
      if (target) target.sideExpand = false;
    });
  }, [sideExpand, paneId]);

  const anyNeedsLook = (collapsed && currentKey !== foldedOn) || tabs.some((tab) => needsLook(tab, null, unseen));

  const headId = domId(pane.id, "side-head", "");
  const bodyId = domId(pane.id, "side-body", "");

  function focusTab(key: string): void {
    const id = domId(pane.id, "side-tab", key);
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }
  function onTabKeydown(event: ReactKeyboardEvent<HTMLButtonElement>, tab: SideTab): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.findIndex((item) => sameTab(item, tab));
    if (index < 0) return;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    selectSideTab(pane.id, next);
    focusTab(tabKey(next));
  }

  // The tabs share one scroller: each keeps its own scroll position across a switch.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const scrollByTab = useRef(new Map<string, number>());
  const shownKey = useRef("");
  // The tab going away is measured HERE, while its content is still what the
  // scroller holds (once the switch is in the DOM its position reads clamped
  // to the next tab's height); the next tab's position is put back below.
  if (bodyRef.current && shownKey.current && currentKey !== shownKey.current) {
    scrollByTab.current.set(shownKey.current, bodyRef.current.scrollTop);
  }
  useLayoutEffect(() => {
    if (currentKey === shownKey.current) return;
    shownKey.current = currentKey;
    if (bodyRef.current) bodyRef.current.scrollTop = scrollByTab.current.get(currentKey) ?? 0;
  }, [currentKey]);

  useEffect(
    () => () => {
      // Never strand the drag cursor/user-select lock if the panel unmounts mid-resize.
      document.body.classList.remove("col-resizing");
    },
    [],
  );

  return (
    <aside
      className={cx("canvas-panel", collapsed && "collapsed")}
      aria-label="캔버스와 파일"
      style={collapsed ? undefined : { width: `${panelWidth}px` }}
    >
      <div
        className="canvas-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="패널 너비 조절"
        aria-valuenow={Math.round(panelWidth)}
        aria-valuemin={WIDTH_MIN}
        aria-valuemax={WIDTH_MAX}
        aria-valuetext={`${Math.round(panelWidth)}px`}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={onResizeKeydown}
      ></div>
      <button
        className="canvas-collapse"
        type="button"
        aria-label="패널 접기"
        title="패널 접기"
        aria-expanded={!collapsed}
        aria-controls={`${headId} ${bodyId}`}
        onClick={() => setCollapsed(true)}
      >
        ›
      </button>

      <div id={headId} className="canvas-head">
        <div className="canvas-tabs" role="tablist" aria-label="캔버스와 파일">
          {tabs.map((tab) => {
            const key = tabKey(tab);
            const shown = sameTab(tab, current);
            const look = needsLook(tab, current, unseen);
            return (
              <div className={cx("canvas-tab-wrap", shown && "active")} key={key}>
                <button
                  id={domId(pane.id, "side-tab", key)}
                  className="canvas-tab"
                  type="button"
                  role="tab"
                  aria-selected={shown}
                  aria-controls={domId(pane.id, "side-panel", key)}
                  tabIndex={shown ? 0 : -1}
                  title={tabLabel(tab)}
                  onClick={() => selectSideTab(pane.id, tab)}
                  onKeyDown={(event) => onTabKeydown(event, tab)}
                >
                  {tab.kind === "file" ? (
                    <span className="canvas-tab-icon">
                      <Icon name="file" size={12} />
                    </span>
                  ) : null}{" "}
                  <span className="canvas-tab-label">{tabLabel(tab)}</span>{" "}
                  {look ? (
                    <>
                      <span className="canvas-tab-dot" aria-hidden="true"></span>{" "}
                      <span className="sr-only">{tab.kind === "canvas" && tab.canvas.pending ? "(응답 필요)" : "(새 항목)"}</span>
                    </>
                  ) : null}
                </button>
                {tab.kind === "file" ? (
                  <button
                    className="canvas-tab-close"
                    type="button"
                    aria-label={`미리보기 닫기: ${tabLabel(tab)}`}
                    title="미리보기 닫기"
                    onClick={() => closeFileTab(pane.id, tab.id)}
                  >
                    <Icon name="close" size={14} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div id={bodyId} className="canvas-body scroll-thin" ref={bodyRef}>
        {tabs.map((tab) => {
          const key = tabKey(tab);
          const shown = sameTab(tab, current);
          return (
            <div
              id={domId(pane.id, "side-panel", key)}
              className="side-tabpanel"
              role="tabpanel"
              aria-labelledby={domId(pane.id, "side-tab", key)}
              hidden={!shown}
              key={key}
            >
              {tab.kind === "canvas" ? (
                <CanvasTab pane={pane} canvas={tab.canvas} active={shown} />
              ) : (
                <FileTab pane={pane} file={tab.file} active={shown} onShare={onShare} />
              )}
            </div>
          );
        })}
      </div>

      {/* The state rides the aria-label: a label overrides the button's content, an sr-only span inside included. */}
      <button
        className="canvas-expand"
        type="button"
        aria-label={anyNeedsLook ? "패널 펼치기 (확인할 항목 있음)" : "패널 펼치기"}
        title="패널 펼치기"
        aria-expanded={!collapsed}
        aria-controls={`${headId} ${bodyId}`}
        onClick={() => setCollapsed(false)}
      >
        <span aria-hidden="true">‹</span> <span className="canvas-expand-label">{stripLabel}</span>{" "}
        {anyNeedsLook ? <span className="canvas-tab-dot" aria-hidden="true"></span> : null}
      </button>
    </aside>
  );
}
