<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import CanvasTab from "./CanvasTab.svelte";
  import FileTab from "./FileTab.svelte";
  import Icon from "./Icon.svelte";
  import { closeFileTab, selectSideTab } from "../lib/chat";
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
  export let pane: ChatPane;
  /** 공유 링크 on a deck tab → ChatView's single dialog (FileTab explains why). */
  export let onShare: (attachment: MessageAttachment) => void = () => {};

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
  // Read before the first render, not in onMount: an expand request that
  // arrives with the panel's first tab must find the stored state already
  // applied. One width for every tab (the canvas key, so a width dragged
  // before the merge is kept; the file preview's old key only seeds it).
  let panelWidth =
    clampWidth(Number(pref("canvasPanelWidth", pref("filePanelWidth", String(WIDTH_DEFAULT)))) || WIDTH_DEFAULT);
  const mobile = typeof window !== "undefined" && (window.matchMedia?.("(max-width: 860px)").matches ?? false);
  let collapsed = pref("canvasPanelCollapsed", mobile ? "1" : "0") === "1";

  function savePanelWidth(width: number): void {
    panelWidth = clampWidth(width);
    setPref("canvasPanelWidth", String(Math.round(panelWidth)));
  }
  function startResize(event: PointerEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startW = panelWidth;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("col-resizing");
    const onMove = (ev: PointerEvent) => {
      // Panel sits at the right edge → dragging left (smaller clientX) widens it.
      panelWidth = clampWidth(startW + (startX - ev.clientX));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("col-resizing");
      setPref("canvasPanelWidth", String(Math.round(panelWidth)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }
  function onResizeKeydown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      savePanelWidth(panelWidth + step);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      savePanelWidth(panelWidth - step);
    } else if (event.key === "Home") {
      event.preventDefault();
      savePanelWidth(WIDTH_DEFAULT);
    } else if (event.key === "End") {
      event.preventDefault();
      savePanelWidth(WIDTH_MAX);
    }
  }
  function setCollapsed(value: boolean) {
    collapsed = value;
    if (value) foldedOn = keyOf(current);
    setPref("canvasPanelCollapsed", value ? "1" : "0");
  }
  function keyOf(ref: SideTabRef | null): string {
    return ref ? tabKey(ref) : "";
  }
  // The tab that showed when the panel was folded away: the avatar moving the
  // panel on to another one since puts a dot on the strip (split view re-reads
  // it for each pane the panel serves).
  let foldedOn = collapsed ? keyOf(resolveSideTab(pane)) : "";
  let foldedPane = pane.id;
  $: if (pane.id !== foldedPane) {
    foldedPane = pane.id;
    foldedOn = keyOf(current);
  }

  // One-shot: an ask for input or a file the viewer opened must not stay
  // hidden behind the collapsed strip. Consumed here, whatever pane is shown.
  // Not persisted: the viewer's own choice to keep the panel folded stands
  // for the next conversation (only the strip's buttons write it).
  $: if (pane.sideExpand) consumeExpand(pane.id);
  function consumeExpand(paneId: string): void {
    collapsed = false;
    updateState((state) => {
      const target = state.chatPanes.find((item) => item.id === paneId);
      if (target) target.sideExpand = false;
    });
  }

  $: tabs = sideTabs(pane);
  $: current = resolveSideTab(pane);
  $: unseen = new Set(pane.sideUnseen ?? []);
  $: stripLabel = pane.fileTabs?.length
    ? pane.canvases?.length
      ? "캔버스·파일 보기"
      : "파일 보기"
    : "캔버스 보기";
  // Reads only its arguments, so the template's dependencies stay complete.
  function needsLook(tab: SideTab, shown: SideTabRef | null, marks: Set<string>): boolean {
    if (sameTab(tab, shown)) return false;
    return marks.has(tabKey(tab)) || (tab.kind === "canvas" && Boolean(tab.canvas.pending));
  }
  $: anyNeedsLook = (collapsed && keyOf(current) !== foldedOn) || tabs.some((tab) => needsLook(tab, null, unseen));

  function tabLabel(tab: SideTab): string {
    return tab.kind === "canvas" ? tab.canvas.title : tab.file.attachment.name || "파일";
  }
  function domId(paneId: string, prefix: string, key: string): string {
    return `${prefix}-${paneId}-${key}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  }
  $: headId = domId(pane.id, "side-head", "");
  $: bodyId = domId(pane.id, "side-body", "");

  function focusTab(key: string): void {
    const id = domId(pane.id, "side-tab", key);
    requestAnimationFrame(() => document.getElementById(id)?.focus());
  }
  function onTabKeydown(event: KeyboardEvent, tab: SideTab): void {
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
  let bodyEl: HTMLDivElement | undefined;
  const scrollByTab = new Map<string, number>();
  let shownKey = "";
  $: void restoreScroll(current ? tabKey(current) : "");
  async function restoreScroll(key: string): Promise<void> {
    if (key === shownKey) return;
    if (bodyEl && shownKey) scrollByTab.set(shownKey, bodyEl.scrollTop);
    shownKey = key;
    await tick();
    if (bodyEl) bodyEl.scrollTop = scrollByTab.get(key) ?? 0;
  }

  onDestroy(() => {
    // Never strand the drag cursor/user-select lock if the panel unmounts mid-resize.
    document.body.classList.remove("col-resizing");
  });
</script>

<aside class="canvas-panel" class:collapsed aria-label="캔버스와 파일" style={collapsed ? undefined : `width:${panelWidth}px`}>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
  <div
    class="canvas-resize"
    role="separator"
    aria-orientation="vertical"
    aria-label="패널 너비 조절"
    aria-valuenow={Math.round(panelWidth)}
    aria-valuemin={WIDTH_MIN}
    aria-valuemax={WIDTH_MAX}
    aria-valuetext={`${Math.round(panelWidth)}px`}
    tabindex="0"
    on:pointerdown={startResize}
    on:keydown={onResizeKeydown}
  ></div>
  <button class="canvas-collapse" type="button" aria-label="패널 접기" title="패널 접기" aria-expanded={!collapsed} aria-controls={`${headId} ${bodyId}`} on:click={() => setCollapsed(true)}>›</button>

  <div id={headId} class="canvas-head">
    <div class="canvas-tabs" role="tablist" aria-label="캔버스와 파일">
      {#each tabs as tab (tabKey(tab))}
        {@const key = tabKey(tab)}
        {@const shown = sameTab(tab, current)}
        <div class="canvas-tab-wrap" class:active={shown}>
          <button
            id={domId(pane.id, "side-tab", key)}
            class="canvas-tab"
            type="button"
            role="tab"
            aria-selected={shown}
            aria-controls={domId(pane.id, "side-panel", key)}
            tabindex={shown ? 0 : -1}
            title={tabLabel(tab)}
            on:click={() => selectSideTab(pane.id, tab)}
            on:keydown={(event) => onTabKeydown(event, tab)}
          >
            {#if tab.kind === "file"}<span class="canvas-tab-icon"><Icon name="file" size={12} /></span>{/if}
            <span class="canvas-tab-label">{tabLabel(tab)}</span>
            {#if needsLook(tab, current, unseen)}
              <span class="canvas-tab-dot" aria-hidden="true"></span>
              <span class="sr-only">{tab.kind === "canvas" && tab.canvas.pending ? "(응답 필요)" : "(새 항목)"}</span>
            {/if}
          </button>
          {#if tab.kind === "file"}
            <button class="canvas-tab-close" type="button" aria-label={`미리보기 닫기: ${tabLabel(tab)}`} title="미리보기 닫기" on:click={() => closeFileTab(pane.id, tab.id)}><Icon name="close" size={14} /></button>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <div id={bodyId} class="canvas-body scroll-thin" bind:this={bodyEl}>
    {#each tabs as tab (tabKey(tab))}
      {@const key = tabKey(tab)}
      {@const shown = sameTab(tab, current)}
      <div id={domId(pane.id, "side-panel", key)} class="side-tabpanel" role="tabpanel" aria-labelledby={domId(pane.id, "side-tab", key)} hidden={!shown}>
        {#if tab.kind === "canvas"}
          <CanvasTab {pane} canvas={tab.canvas} active={shown} />
        {:else}
          <FileTab {pane} file={tab.file} active={shown} {onShare} />
        {/if}
      </div>
    {/each}
  </div>

  <!-- The state rides the aria-label: a label overrides the button's content, an sr-only span inside included. -->
  <button class="canvas-expand" type="button" aria-label={anyNeedsLook ? "패널 펼치기 (확인할 항목 있음)" : "패널 펼치기"} title="패널 펼치기" aria-expanded={!collapsed} aria-controls={`${headId} ${bodyId}`} on:click={() => setCollapsed(false)}>
    <span aria-hidden="true">‹</span>
    <span class="canvas-expand-label">{stripLabel}</span>
    {#if anyNeedsLook}<span class="canvas-tab-dot" aria-hidden="true"></span>{/if}
  </button>
</aside>
