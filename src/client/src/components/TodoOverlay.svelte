<script lang="ts">
  // The chat screen's 할 일 card, switched on/off from the composer's `할 일 N`
  // button. ChatView mounts it inside the ACTIVE pane's `.chat-body` — the
  // transcript region between the chat header and the composer — so it can never
  // cover the composer, and an open canvas/file panel (which narrows the chat
  // column) moves it left with the column. Three presentations, decided from the
  // host's measured width (a ResizeObserver callback, never a layout read at
  // mount) and the viewport (`todoOverlayMode`):
  //   pinned  — wide column: a persistent card at the top-right; the transcript
  //             reserves its room (the :global rule below), so no text sits under it.
  //   popover — narrow column (split panes, a side panel open, a laptop): a
  //             transient card above the composer like the MCP tool panel.
  //   sheet   — ≤860px viewport: the popover at full width.
  // Two ways to close it, deliberately different: the × (and the composer
  // toggle) switch the per-browser preference OFF; an outside click, Escape or
  // leaving for the tab only DISMISSES a popover/sheet for now (never persisted).
  // Only the PINNED card shows up on its own: a mount whose first measured mode
  // is transient (a reload on a narrow layout) starts dismissed unless the
  // toggle itself opened it, so a popover never lands on the newest messages
  // unasked; the column widening back to pinned brings the card back.
  // ChatView keeps this mounted while the preference is on; a dismissed card
  // stays mounted (hidden) so it can still see the column widen.
  // It always lists the VIEWER's own items, whichever avatar the pane talks to.
  import { onMount, tick } from "svelte";
  import Icon from "./Icon.svelte";
  import { clickOutside } from "../lib/dom";
  import { goView } from "../lib/nav";
  import { appState } from "../lib/state";
  import {
    completeTodoWithUndo,
    consumeTodoOverlayFocus,
    createTodo,
    dismissTodoOverlay,
    dueDateText,
    dueLabel,
    isPendingTodo,
    openTodoInTab,
    overlaySections,
    restoreTodoOverlay,
    setTodoOverlayOpen,
    todoOverlayMode,
    type TodoOverlayMode,
  } from "../lib/todos";
  import type { TodoItem } from "../lib/types";
  import { MAX_TODO_TITLE_LENGTH, todoDueBucket } from "../../../shared/todos";

  /** Whether the hosting pane talks to the viewer's OWN avatar — the only one that can add to this list. */
  export let ownAvatar = false;

  let root: HTMLElement | null = null;
  let input: HTMLInputElement | null = null;
  let draft = "";
  let mode: TodoOverlayMode =
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 860px)").matches ? "sheet" : "popover";

  $: todos = $appState.todos;
  $: todayKst = todos.todayKst;
  $: counts = todos.counts;
  $: overlay = overlaySections(todos.items, todayKst);
  $: transient = mode !== "pinned";
  $: dismissed = $appState.todoOverlayDismissed;
  // Pinned never honours a transient dismissal: once the column is wide again
  // the persistent card is back.
  $: if (mode === "pinned" && dismissed) restoreTodoOverlay();
  // Shown again by the composer toggle after a dismissal: take focus if asked.
  let wasDismissed = false;
  $: onDismissedChange(dismissed);
  function onDismissedChange(now: boolean) {
    if (wasDismissed && !now) focusInputSoon();
    wasDismissed = now;
  }

  // Focus only on an explicit toggle click — a persisted "on" re-opening the
  // card after a reload must not steal focus from the composer. Deferred past
  // first paint (never focus/measure inside the mount task).
  function focusInputSoon() {
    if (consumeTodoOverlayFocus()) requestAnimationFrame(() => requestAnimationFrame(() => input?.focus()));
  }

  onMount(() => {
    const host = root?.parentElement ?? null;
    const narrow = window.matchMedia?.("(max-width: 860px)") ?? null;
    // An explicit toggle click asked for this card (and its focus).
    const explicit = consumeTodoOverlayFocus();
    let hostWidth = 0;
    let measured = false;
    const decide = () => {
      mode = todoOverlayMode(hostWidth, Boolean(narrow?.matches));
      if (measured) return;
      measured = true;
      // A toggle click that landed between mount and this first measure (a fast
      // click in another split pane remounts the card first) is explicit too.
      const late = consumeTodoOverlayFocus();
      if (late) requestAnimationFrame(() => requestAnimationFrame(() => input?.focus()));
      if (mode !== "pinned" && !explicit && !late) dismissTodoOverlay();
    };
    const observer =
      host && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver((entries) => {
            hostWidth = entries[0]?.contentRect.width ?? hostWidth;
            decide();
          })
        : null;
    if (host) observer?.observe(host);
    narrow?.addEventListener?.("change", decide);
    // Escape anywhere (the composer included) dismisses a transient card; bubble
    // phase, so a handler that owns Escape first (slash menu, rewind editor, a
    // dialog, the DM dock) wins by preventing/stopping it.
    window.addEventListener("keydown", onWindowKeydown);
    if (!dismissed && explicit) requestAnimationFrame(() => requestAnimationFrame(() => input?.focus()));
    return () => {
      observer?.disconnect();
      narrow?.removeEventListener?.("change", decide);
      window.removeEventListener("keydown", onWindowKeydown);
    };
  });

  function toggleButton(): HTMLButtonElement | null {
    return root?.closest(".chat-pane")?.querySelector<HTMLButtonElement>(".composer-todo-btn") ?? null;
  }

  /** The × button: switch the preference off (persisted). */
  function close() {
    const button = toggleButton();
    setTodoOverlayOpen(false);
    button?.focus();
  }

  /** Transient: hide the popover/sheet for now, keep the preference. */
  function dismiss(returnFocus: boolean) {
    const button = returnFocus ? toggleButton() : null;
    dismissTodoOverlay();
    button?.focus();
  }

  function onOutside() {
    if (transient && !dismissed) dismiss(false);
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !transient || dismissed || event.defaultPrevented) return;
    // An IME composition owns Escape until it commits; a dialog keeps its own.
    if (event.isComposing || event.keyCode === 229) return;
    const active = document.activeElement;
    if (active?.closest('[role="dialog"], [aria-modal="true"], .modal-overlay')) return;
    event.preventDefault();
    // Focus goes back to the toggle only when it was inside the card; Escape
    // pressed in the composer leaves the caret where it is.
    dismiss(Boolean(active && root?.contains(active)));
  }

  async function add() {
    const title = draft.trim();
    if (!title) return;
    draft = "";
    const created = await createTodo({ title });
    if (!created && !draft) draft = title;
    await tick();
    input?.focus();
  }

  function complete(item: TodoItem) {
    if (isPendingTodo(item)) return;
    void completeTodoWithUndo(item);
  }

  // A transient card has done its job once the viewer leaves for the tab; a
  // pinned one stays switched on for when they come back.
  function openItem(item: TodoItem) {
    if (isPendingTodo(item)) return;
    if (transient) dismissTodoOverlay();
    openTodoInTab(item.id);
  }

  function openAll() {
    if (transient) dismissTodoOverlay();
    goView("todos");
  }
</script>

<aside
  bind:this={root}
  id="todo-overlay"
  class="todo-overlay"
  class:is-pinned={mode === "pinned"}
  class:is-popover={mode === "popover"}
  class:is-sheet={mode === "sheet"}
  data-mode={mode}
  aria-label="할 일"
  hidden={dismissed}
  use:clickOutside={{ onOutside, ignore: ".composer-todo-btn, .toast-wrap, .modal-overlay" }}
>
  <header class="todo-overlay-head">
    <h2>할 일</h2>
    {#if todos.loaded}
      <span class="todo-overlay-counts">
        열림 {counts.open}{#if counts.overdue}<span class="todo-overlay-overdue">{` · 마감 지남 ${counts.overdue}`}</span>{/if}
      </span>
    {/if}
    <button class="todo-overlay-close" type="button" aria-label="할 일 닫기" title="할 일 닫기" on:click={close}>
      <Icon name="close" size={14} />
    </button>
  </header>

  <form class="todo-overlay-add" on:submit|preventDefault={add}>
    <label class="field todo-overlay-field">
      <span class="sr-only">새 할 일 제목</span>
      <input
        bind:this={input}
        class="todo-overlay-input"
        type="text"
        placeholder="할 일 추가 후 Enter"
        maxlength={MAX_TODO_TITLE_LENGTH}
        bind:value={draft}
      />
    </label>
  </form>

  <div class="todo-overlay-body scroll-thin">
    {#if !todos.loaded}
      <p class="todo-overlay-empty" role="status">불러오는 중…</p>
    {:else if !overlay.sections.length}
      <p class="todo-overlay-empty">
        {#if ownAvatar}
          열린 할 일이 없습니다. 위에 적거나, 이 대화에서 “할 일에 넣어줘” 또는 /todo로 부탁해 보세요.
        {:else}
          열린 할 일이 없습니다. 위에 적어 두세요. 아바타에게 맡기려면 내 아바타와의 대화에서 부탁해 보세요.
        {/if}
      </p>
    {:else}
      {#each overlay.sections as section (section.id)}
        <section class="todo-overlay-section" aria-label={section.label}>
          <h3 class:warn={section.id === "overdue"}>{section.label}</h3>
          <ul>
            {#each section.items as item (item.id)}
              {@const bucket = todoDueBucket(item.dueDate, todayKst)}
              {@const pending = isPendingTodo(item)}
              <li class="todo-overlay-item" aria-busy={pending ? "true" : undefined}>
                <!-- The label is only the touch-sized hit area; the name is the checkbox's own. -->
                <label class="todo-overlay-check-hit">
                  <input
                    class="todo-overlay-check"
                    type="checkbox"
                    checked={false}
                    disabled={pending}
                    aria-label={`완료: ${item.title}`}
                    on:change={() => complete(item)}
                  />
                </label>
                <button class="todo-overlay-title" type="button" disabled={pending} title={item.title} on:click={() => openItem(item)}>
                  {item.title}
                </button>
                {#if item.dueDate}
                  <span class="todo-overlay-due" data-bucket={bucket} title={dueDateText(item.dueDate, todayKst)}
                    >{dueLabel(item.dueDate, todayKst)}</span
                  >
                {/if}
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  </div>

  <footer class="todo-overlay-foot">
    <button class="linkish small" type="button" on:click={openAll}
      >전체 보기{#if overlay.hidden > 0}{` (외 ${overlay.hidden}개)`}{/if} →</button
    >
  </footer>
</aside>

<style>
  /* The surface (border colour, radius, the frosted --material-thick with its
     backdrop blur, shadow, and the opaque reduced-transparency fallback) comes
     from the shared popover material group in 80-apple-design.css — the same
     glass as the MCP tool panel beside it — for the TRANSIENT modes; the pinned
     card overrides it with an opaque surface (see .is-pinned). Otherwise only
     geometry lives here. */
  .todo-overlay {
    /* Card width + its right offset + breathing room before the transcript's
       text column; the pinned :global rule reserves exactly this. */
    --todo-overlay-width: 300px;
    position: absolute;
    z-index: var(--z-popover);
    width: min(var(--todo-overlay-width), calc(100% - 2 * var(--s-4)));
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-width: 1px;
    border-style: solid;
    overflow: hidden;
  }
  .todo-overlay[hidden] {
    display: none;
  }
  .todo-overlay.is-pinned {
    top: var(--s-3);
    right: var(--s-4);
    max-height: calc(50% - var(--s-3));
    /* Pinned stays up while the transcript scrolls and streams beside it, with
       nothing behind it to frost — so no permanent backdrop blur (it would
       re-composite on every transcript repaint); the opaque elevated surface the
       prompt card uses instead. The transient modes keep the shared glass. */
    background: linear-gradient(var(--bg-elevated), var(--bg-elevated)) var(--bg);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  /* Above the composer, right-aligned — the .composer-tools-panel spot. The
     host's bottom edge IS the composer's top edge. */
  .todo-overlay.is-popover {
    bottom: var(--s-2);
    right: var(--s-4);
    max-height: min(calc(100% - 2 * var(--s-2)), 440px);
  }
  .todo-overlay.is-sheet {
    left: var(--s-2);
    right: var(--s-2);
    bottom: var(--s-2);
    width: auto;
    max-height: min(calc(100% - 2 * var(--s-2)), 70dvh);
  }
  /* Pinned: give the transcript enough right padding that its centred text
     column ends left of the card. Padding % resolves against .chat-body's width,
     so this is clamp(normal padding, 2×reserve + column − host width, reserve):
     nothing extra on a wide screen, a left shift of the full column on a laptop,
     and never more than the card's own reserve — below 1152px the column narrows
     (648px at the 1000px pin threshold, lib/todos.ts) instead of being squeezed
     around a dead gap. */
  :global(.chat-body:has(> .todo-overlay.is-pinned:not([hidden])) > .transcript) {
    --todo-overlay-reserve: calc(300px + var(--s-4) + var(--s-3));
    padding-right: clamp(
      var(--s-5),
      calc(2 * var(--todo-overlay-reserve) + var(--transcript-max) + var(--s-5) - 100%),
      var(--todo-overlay-reserve)
    );
  }

  .todo-overlay-head {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-2) var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--line-soft);
  }
  .todo-overlay-head h2 {
    margin: 0;
    font-size: var(--t-sm);
    font-weight: 700;
  }
  .todo-overlay-counts {
    flex: 1;
    min-width: 0;
    color: var(--muted);
    font-size: var(--t-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .todo-overlay-overdue {
    color: var(--warn);
    font-weight: 600;
  }
  .todo-overlay-close {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    margin-left: auto;
    border: 1px solid transparent;
    border-radius: var(--r-pill);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .todo-overlay-close:hover {
    color: var(--text);
    background: var(--panel-strong);
  }
  .todo-overlay-add {
    padding: var(--s-2) var(--s-3);
  }
  /* A `.field` control (border, surface, accent-on-focus, the global
     :focus-visible ring); only the card's tighter density is set here. */
  .todo-overlay-input {
    font-size: var(--t-sm);
    padding: var(--s-1-5) var(--s-2-5);
  }
  .todo-overlay-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 var(--s-2) var(--s-1);
  }
  .todo-overlay-empty {
    margin: 0;
    padding: var(--s-2) var(--s-1) var(--s-3);
    color: var(--muted);
    font-size: var(--t-xs);
    line-height: 1.5;
  }
  .todo-overlay-section h3 {
    margin: var(--s-1-5) var(--s-1) var(--s-1);
    color: var(--muted);
    font-size: var(--t-2xs);
    font-weight: 700;
    letter-spacing: 0.06em;
  }
  .todo-overlay-section h3.warn {
    color: var(--warn);
  }
  .todo-overlay-section ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: var(--s-0-5);
  }
  .todo-overlay-item {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-1) var(--s-1);
    border-radius: var(--r-sm);
  }
  .todo-overlay-item:hover {
    background: var(--bg-subtle);
  }
  .todo-overlay-item[aria-busy="true"] {
    opacity: 0.7;
  }
  .todo-overlay-check-hit {
    display: inline-grid;
    place-items: center;
    cursor: pointer;
  }
  .todo-overlay-check {
    width: 16px;
    height: 16px;
    margin: 0;
    accent-color: var(--accent);
    cursor: pointer;
  }
  /* Touch: the global 44px target rule exempts checkboxes, so the hit area is
     the label around it. */
  @media (pointer: coarse) {
    .todo-overlay-check-hit {
      min-width: 44px;
      min-height: 44px;
      margin: calc(var(--s-2) * -1) 0;
    }
    .todo-overlay-check {
      width: 20px;
      height: 20px;
    }
  }
  .todo-overlay-title {
    min-width: 0;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text);
    font-size: var(--t-sm);
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .todo-overlay-title:hover {
    text-decoration: underline;
  }
  .todo-overlay-title:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
    border-radius: var(--r-xs);
  }
  .todo-overlay-due {
    flex: none;
    color: var(--muted);
    font-size: var(--t-2xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .todo-overlay-due[data-bucket="overdue"] {
    color: var(--warn);
    font-weight: 600;
  }
  .todo-overlay-due[data-bucket="today"] {
    color: var(--accent-strong);
    font-weight: 600;
  }
  .todo-overlay-foot {
    display: flex;
    justify-content: flex-end;
    padding: var(--s-1-5) var(--s-3);
    border-top: 1px solid var(--line-soft);
  }
  @media (prefers-reduced-motion: no-preference) {
    .todo-overlay {
      animation: todo-overlay-in 160ms var(--ease-out) both;
    }
  }
  @keyframes todo-overlay-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
</style>
