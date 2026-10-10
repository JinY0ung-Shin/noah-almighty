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
  // It only reviews and completes them: adding is the 할 일 tab's form or the
  // viewer's own avatar (`mcp__todo__*`, `/todo`).
  import { onMount } from "svelte";
  import type { AnimationConfig } from "svelte/animate";
  import { quartOut } from "svelte/easing";
  import { fade, type TransitionConfig } from "svelte/transition";
  import Icon from "./Icon.svelte";
  import { clickOutside } from "../lib/dom";
  import { prefersReducedMotion } from "../lib/motion";
  import { goView } from "../lib/nav";
  import { appState } from "../lib/state";
  import {
    avatarChangeFlushing,
    completeTodoWithUndo,
    consumeTodoOverlayFocus,
    dismissTodoOverlay,
    dueDateText,
    dueLabel,
    isPendingTodo,
    onBeforeAvatarChange,
    openTodoInTab,
    overlaySections,
    restoreTodoOverlay,
    setTodoOverlayOpen,
    takeAvatarDeparture,
    todoActivity,
    todoHiddenArrivalSeq,
    todoOverlayMode,
    type TodoOverlayMode,
  } from "../lib/todos";
  import type { TodoItem } from "../lib/types";
  import { todoDueBucket } from "../../../shared/todos";

  /** Whether the hosting pane talks to the viewer's OWN avatar — the only one that can add to this list. */
  export let ownAvatar = false;

  let root: HTMLElement | null = null;
  let list: HTMLElement | null = null;
  let mode: TodoOverlayMode =
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 860px)").matches ? "sheet" : "popover";

  $: todos = $appState.todos;
  $: counts = todos.counts;
  // Every app-state write (each streamed token) re-runs these `$:` lines, but the
  // keyed lists — which measure every row for `animate:` on each reconcile — are
  // rebuilt only when the items or the KST day actually changed.
  let overlayItems: TodoItem[] | null = null;
  let todayKst = "";
  let overlay = overlaySections([], "");
  $: refreshOverlay(todos.items, todos.todayKst);
  function refreshOverlay(items: TodoItem[], today: string) {
    if (items === overlayItems && today === todayKst) return;
    overlayItems = items;
    todayKst = today;
    overlay = overlaySections(items, today);
  }
  $: marks = $todoActivity.marks;
  // The avatar's newest addition that has no row here (past the visible rows):
  // the footer's `(외 N개)` pops for that change instead.
  $: footerPop = todoHiddenArrivalSeq(overlay.sections, marks, overlayItems ?? []);
  $: transient = mode !== "pinned";
  $: dismissed = $appState.todoOverlayDismissed;
  // Pinned never honours a transient dismissal: once the column is wide again
  // the persistent card is back.
  $: if (mode === "pinned" && dismissed) restoreTodoOverlay();
  // Shown again by the composer toggle after a dismissal: take focus if asked.
  let wasDismissed = false;
  $: onDismissedChange(dismissed);
  function onDismissedChange(now: boolean) {
    if (wasDismissed && !now && consumeTodoOverlayFocus()) afterPaint(focusCard);
    wasDismissed = now;
  }

  // Deferred past first paint (never focus/measure inside the mount task); by
  // then the first measurement has decided the mode.
  function afterPaint(run: () => void) {
    requestAnimationFrame(() => requestAnimationFrame(run));
  }

  /**
   * An explicit toggle press hands focus to a TRANSIENT card, where Escape gives
   * it back to the toggle. The pinned card is a persistent side region that
   * Escape never closes, so focus stays on the toggle there. Focusable only for
   * that moment (a temporary tabindex), so a click on the card's background
   * never pulls the caret out of the composer. A persisted "on" re-opening the
   * card after a reload never steals focus.
   */
  function focusCard() {
    const card = root;
    if (!card || mode === "pinned" || $appState.todoOverlayDismissed) return;
    card.setAttribute("tabindex", "-1");
    card.addEventListener("blur", () => card.removeAttribute("tabindex"), { once: true });
    card.focus();
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
      if (late) afterPaint(focusCard);
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
    if (!dismissed && explicit) afterPaint(focusCard);
    const stopListening = onBeforeAvatarChange(beforeAvatarChange);
    return () => {
      observer?.disconnect();
      narrow?.removeEventListener?.("change", decide);
      window.removeEventListener("keydown", onWindowKeydown);
      stopListening();
      if (heightHold) clearTimeout(heightHold);
    };
  });

  // Where each row sat on screen right before the avatar's change landed: a row
  // that leaves exits from exactly there (rowOut), whatever else the same change
  // moved — a parallel addition above can shift it before Svelte measures it.
  const rowsBefore = new Map<string, number>();

  // An avatar's change is about to land — the list still shows the old rows.
  function beforeAvatarChange() {
    rowsBefore.clear();
    if (!list || prefersReducedMotion() || $appState.todoOverlayDismissed) return;
    for (const row of list.querySelectorAll<HTMLElement>("li[data-todo-id]")) {
      rowsBefore.set(row.dataset.todoId ?? "", row.getBoundingClientRect().top);
    }
    holdListHeight();
  }

  // Hold the list's height until the change's motion ends — in the PINNED card only. It is
  // TOP-anchored: a leaving row is taken out of flow at once and the rows below
  // glide up from their old places, so a card that shrank with the data would be
  // overflowed for the whole glide (a scrollbar flashing in a card that does not
  // scroll); held, it settles to its new height once the rows have. The popover
  // and sheet are BOTTOM-anchored: shrinking moves their top, the rows below stay
  // put and the ones above glide down — a hold would only make everything jump
  // back down when it ends. Under reduced motion nothing glides, so the layout
  // changes once, at once.
  const HEIGHT_HOLD_MS = 240;
  let heightHold: ReturnType<typeof setTimeout> | null = null;
  function holdListHeight() {
    if (!list || mode !== "pinned" || prefersReducedMotion() || $appState.todoOverlayDismissed) return;
    list.style.minHeight = `${list.getBoundingClientRect().height}px`;
    if (heightHold) clearTimeout(heightHold);
    heightHold = setTimeout(() => {
      heightHold = null;
      if (list) list.style.minHeight = "";
    }, HEIGHT_HOLD_MS);
  }

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
    // Focus goes back to the toggle only when it was inside the card (the card
    // itself included); Escape pressed in the composer leaves the caret there.
    dismiss(Boolean(active && root?.contains(active)));
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

  // Motion for the AVATAR's changes only (lib/todos.ts decides which those are):
  // a row it added rises in with an accent wash and a row it edited gets the wash
  // (CSS, `data-arrival`); a row it deleted or completed slides out while the
  // rows below glide up; any other row that enters with the change (the next item
  // moving into the visible rows, an edit that moved a row to another section)
  // fades in behind them. These read NON-reactive state when the motion STARTS —
  // a removed keyed row only ever sees the params of its last render — so the
  // viewer's own checkbox, a poll and the first load stay instant. quartOut is
  // the svelte/easing curve closest to `--ease-out` (the Toasts precedent).
  // `|global`: a row (or the section around it) still moves when its whole
  // section or the list goes with it. Under reduced motion nothing moves: the
  // glide is off, so exits are instant too (a fade would sit on top of the row
  // that already took the slot); arrivals only fade.
  const NONE: TransitionConfig = { duration: 0 };
  /** The rows' and sections' glide — a leaving row's exit shares it (see rowOut). */
  const GLIDE_MS = 200;

  // Exits are DEFERRED (a function): Svelte caches a transition's options for its
  // element, and a row revived mid-exit keeps them — a deferred exit re-asks the
  // registry each time, so a later removal of the viewer's own is never the avatar's.
  // Deferred also means it runs once the sections' glides have started. The row
  // leaves from where it was: first moved back to its spot from before the change
  // (rowsBefore — undoing whatever shifted it or the section around it), then held
  // against its section's glide, which has the same duration and curve (in a
  // bottom-anchored card that section glides down as the card shrinks from its top).
  function rowOut(node: Element, id: string) {
    return (): TransitionConfig => {
      if (!takeAvatarDeparture(id) || prefersReducedMotion()) return NONE;
      // Composed onto the translate `animate:` holds the leaving row at (as `fly` does).
      const style = getComputedStyle(node);
      const base = !style.transform || style.transform === "none" ? "" : style.transform;
      // A row still inside rowIn's delay is at 0 — keep it there, never flash it in.
      const parsed = Number.parseFloat(style.opacity);
      const opacity = Number.isNaN(parsed) ? 1 : parsed;
      const before = rowsBefore.get(id);
      const back = before === undefined ? 0 : before - node.getBoundingClientRect().top;
      const shift = glideShift(node.closest("section"));
      return {
        duration: GLIDE_MS,
        easing: quartOut,
        css: (t, u) => `transform: ${base} translate(${u * 12}px, ${back + shift * u}px); opacity: ${t * opacity}`,
      };
    };
  }

  /**
   * The offset a GLIDING section starts from — 0 for one that stays put or is
   * leaving itself (Svelte marks a leaving section `inert` and holds it with a
   * STATIC translate, which is no glide to ride against).
   */
  function glideShift(section: HTMLElement | null): number {
    if (!section || section.inert || getComputedStyle(section).position === "absolute") return 0;
    const transform = getComputedStyle(section).transform;
    return !transform || transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
  }

  function rowIn(node: Element, id: string): TransitionConfig {
    // A row the avatar added has its own rise (CSS); this is for the rest.
    if (!avatarChangeFlushing() || $todoActivity.marks[id]?.kind === "added") return NONE;
    return fade(node, { delay: 80, duration: 160, easing: quartOut });
  }

  // Translate-only FLIP. svelte/animate's `flip` also SCALES an element whose size
  // changed — a section a row just left would squash its text for the whole
  // glide (and drag the leaving row with it) — so the glide moves, never resizes.
  // A row glides from where it sat BEFORE the change (rowsBefore): Svelte measures
  // a section's rows only after the sections above it have already updated, so a
  // row under an addition would otherwise start from its pushed-down place. Its
  // `to` already carries its section's own glide (sections start first), so a row
  // that only rides its section gets no glide of its own.
  function glide(node: Element, { from, to }: { from: DOMRect; to: DOMRect }): AnimationConfig {
    if (!avatarChangeFlushing() || prefersReducedMotion()) return NONE;
    const before = node instanceof HTMLElement && node.dataset.todoId ? rowsBefore.get(node.dataset.todoId) : undefined;
    const dx = from.left - to.left;
    const dy = (before ?? from.top) - to.top;
    // Under half a pixel is no glide (and float noise of a row that only rides its section).
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return NONE;
    const style = getComputedStyle(node);
    const base = style.transform === "none" ? "" : style.transform;
    return { duration: GLIDE_MS, easing: quartOut, css: (_t, u) => `transform: ${base} translate(${u * dx}px, ${u * dy}px)` };
  }

  function sectionIn(node: Element): TransitionConfig {
    return avatarChangeFlushing() ? fade(node, { duration: 240, easing: quartOut }) : NONE;
  }

  function sectionOut(node: Element) {
    return () => (avatarChangeFlushing() && !prefersReducedMotion() ? fade(node, { duration: 180, easing: quartOut }) : NONE);
  }

  function emptyIn(node: Element): TransitionConfig {
    // After the leaving row has mostly gone, so the two never stack up.
    return avatarChangeFlushing() ? fade(node, { delay: 120, duration: 180, easing: quartOut }) : NONE;
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

  <div class="todo-overlay-body scroll-thin" bind:this={list}>
    {#if !todos.loaded}
      <p class="todo-overlay-empty" role="status">불러오는 중…</p>
    {:else}
      <!-- One keyed list that stays mounted once loaded, so a section the avatar
           empties leaves (and the rest glide up) instead of the list remounting. -->
      {#each overlay.sections as section (section.id)}
        <section
          class="todo-overlay-section"
          aria-label={section.label}
          animate:glide
          in:sectionIn|global
          out:sectionOut|global
        >
          <h3 class:warn={section.id === "overdue"}>{section.label}</h3>
          <ul>
            {#each section.items as item (item.id)}
              {@const bucket = todoDueBucket(item.dueDate, todayKst)}
              {@const pending = isPendingTodo(item)}
              {@const mark = marks[item.id]}
              <li
                class="todo-overlay-item"
                data-todo-id={item.id}
                data-arrival={mark?.kind}
                style:--todo-arrival-delay={mark ? `${mark.delay}ms` : undefined}
                aria-busy={pending ? "true" : undefined}
                animate:glide
                in:rowIn|global={item.id}
                out:rowOut|global={item.id}
              >
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
      {#if !overlay.sections.length}
        <p class="todo-overlay-empty" in:emptyIn|global>
          {#if ownAvatar}
            열린 할 일이 없습니다. 이 대화에서 “할 일에 넣어줘” 또는 /todo로 부탁하거나, 할 일 탭에서 추가해 보세요.
          {:else}
            열린 할 일이 없습니다. 할 일 탭에서 추가해 보세요.
          {/if}
        </p>
      {/if}
    {/if}
  </div>

  <footer class="todo-overlay-foot">
    <button class="linkish small" type="button" on:click={openAll}
      >전체 보기{#if overlay.hidden > 0}{" "}{#key footerPop}<span class="todo-overlay-more" class:is-popping={footerPop > 0}
            >(외 {overlay.hidden}개)</span
          >{/key}{/if} →</button
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
  /* Positioned: a row or section the avatar removes is held in place
     (`animate:` fixes it absolutely) while it leaves, and must stay inside —
     and scroll with — this list. No horizontal overflow: the leaving row's
     sideways slide must never flash a scrollbar. The fleet's classic scrollbars
     take width when they appear, so the gutter is reserved: a list growing
     into scrolling never narrows (and re-ellipsizes) its rows. The bottom
     padding clears an added last row's 6px rise. */
  .todo-overlay-body {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-gutter: stable;
    padding: var(--s-1) var(--s-2) var(--s-2);
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
    /* Its own stacking context, so the wash below paints over the row's
       background but under its content. */
    position: relative;
    isolation: isolate;
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
  /* The accent wash on a row the avatar just added or edited: an opacity-only
     layer, held briefly, then fading out over the rest of ~1.2 s. Kept under
     reduced motion — it moves nothing. Longer than DESIGN §2.5's 120–240 ms on
     purpose: a highlight that lingers long enough to be found is the USER's
     choice for this card (2026-10-10) — not a motion-audit fix target.
     Fill `backwards` (end = resting styles): a finished animation leaves
     getAnimations(), so `animate:` can still fix and glide this row at once. */
  .todo-overlay-item::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    background: var(--accent-soft);
    opacity: 0;
    pointer-events: none;
  }
  .todo-overlay-item[data-arrival]::before {
    animation: todo-row-wash 1200ms var(--ease-out) var(--todo-arrival-delay, 0ms) backwards;
  }
  /* A row the avatar added rises in, staggered top to bottom; under reduced
     motion it only fades in. */
  .todo-overlay-item[data-arrival="added"] {
    animation: todo-row-fade 240ms var(--ease-out) var(--todo-arrival-delay, 0ms) backwards;
  }
  @media (prefers-reduced-motion: no-preference) {
    .todo-overlay-item[data-arrival="added"] {
      animation-name: todo-row-rise;
    }
  }
  @keyframes todo-row-rise {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  @keyframes todo-row-fade {
    from {
      opacity: 0;
    }
  }
  @keyframes todo-row-wash {
    0%,
    30% {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
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
  /* The avatar added an item past the visible rows: its count pops (the
     composer count's `todo-count-pop`, 30-agent-md-composer.css — its 360 ms
     overshoot is the user's choice, see there). */
  @media (prefers-reduced-motion: no-preference) {
    .todo-overlay-more.is-popping {
      display: inline-block;
      animation: todo-count-pop 360ms var(--ease-out);
    }
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
