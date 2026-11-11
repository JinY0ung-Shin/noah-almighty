// The chat screen's 할 일 card, switched on/off from the composer's `할 일 N`
// button. ChatView mounts it inside the ACTIVE pane's `.chat-body` — the
// transcript region between the chat header and the composer — so it can never
// cover the composer, and an open canvas/file panel (which narrows the chat
// column) moves it left with the column. Three presentations, decided from the
// host's measured width (a ResizeObserver callback, never a layout read at
// mount) and the viewport (`todoOverlayMode`):
//   pinned  — wide column: a persistent card at the top-right; the transcript
//             reserves its room (the unscoped .chat-body rule in TodoOverlay.css),
//             so no text sits under it.
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
// It always lists the VIEWER's own items, whichever avatar the pane talks to,
// in-progress ones in their own 진행 중 section on top, under a header that
// sums up the day (오늘 완료/남음 + chips into the tab's filters). A row's
// checkbox completes; its hover/focus actions start it (진행 중), put it back
// (시작 전) or drop it (user decision 2026-10-21). Adding stays the 할 일 tab's or
// the viewer's own avatar's (`mcp__todo__*`, `/todo`). Sections fold, and the
// pinned card minimizes to its header — both remembered per browser.
import { Component, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import Icon from "./Icon";
import { clickOutside } from "../lib/dom";
import { cx, useAction, useAppState, useMergedRef, useStore } from "../lib/hooks";
import {
  loadTodoOverlayCollapsed,
  loadTodoOverlayMinimized,
  persistTodoOverlayCollapsed,
  persistTodoOverlayMinimized,
} from "../lib/layout";
import { prefersReducedMotion } from "../lib/motion";
import { goView } from "../lib/nav";
import { Presence, useIsPresent, useTransition, type TransitionSpec } from "../lib/presence";
import { readState } from "../lib/state";
import { get } from "../lib/store";
import {
  TODO_OVERLAY_LIMIT,
  TODO_OVERLAY_SECTION_IDS,
  avatarChangeFlushing,
  closeTodoWithUndo,
  completeTodoWithUndo,
  consumeTodoOverlayFocus,
  dismissTodoOverlay,
  dueDateText,
  dueLabel,
  isPendingTodo,
  onBeforeAvatarChange,
  openTodoInTab,
  openTodosFiltered,
  overlaySections,
  restoreTodoOverlay,
  setTodoOverlayOpen,
  setTodoStatus,
  takeAvatarDeparture,
  todoActivity,
  todoFilterCounts,
  todoHiddenArrivalSeq,
  todoOverlayMode,
  todoSectionArrivalSeq,
  todoSourceTitle,
  todoTodayProgress,
  type TodoMark,
  type TodoOverlayMode,
  type TodoOverlaySection,
  type TodoOverlaySectionId,
} from "../lib/todos";
import {
  fade,
  quartOut,
  runTransition,
  type TransitionConfig,
  type TransitionFn,
  type TransitionResult,
  type TransitionRun,
} from "../lib/transition";
import type { TodoFilter, TodoItem } from "../lib/types";
import { todoDueBucket } from "../../../shared/todos";
import "./TodoOverlay.css";

export interface TodoOverlayProps {
  /** Whether the hosting pane talks to the viewer's OWN avatar — the only one that can add to this list. */
  ownAvatar?: boolean;
}

// Motion for the AVATAR's changes only (lib/todos.ts decides which those are):
// a row it added rises in with an accent wash and a row it edited gets the wash
// (CSS, `data-arrival`); a row it deleted or closed (completed or dropped)
// slides out while the rows below glide up; any other row that enters with the
// change (the next item moving into the visible rows, an edit that moved a row
// to another section — a new due date, or 진행 중) fades in behind them. These read NON-reactive state when the motion STARTS —
// a removed keyed row only ever sees the props of its last render — so the
// viewer's own checkbox, a poll and the first load stay instant. quartOut is
// the lib/transition curve closest to `--ease-out` (the Toasts precedent).
// A row (or the section around it) still moves when its whole section or the
// list goes with it (the originals were `|global`; see `useEntrance` and the
// rows' section-leaving branch below). Under reduced motion nothing moves: the
// glide is off, so exits are instant too (a fade would sit on top of the row
// that already took the slot); arrivals only fade.
const NONE: TransitionConfig = { duration: 0 };
/** The rows' and sections' glide — a leaving row's exit shares it (see rowOut). */
const GLIDE_MS = 200;
const HEIGHT_HOLD_MS = 240;

// The exit's GEOMETRY is deferred (a function): it runs once the sections'
// glides have started (the card's layout effect starts them; this runs a
// microtask later). Whether the row leaves with motion at all — the avatar's
// registry, asked again on every exit, so a later removal of the viewer's own is
// never the avatar's — is read by the row when it STARTS to leave (Row, below).
// The row leaves from where it was: first moved back to its spot from before the
// change (rowsBefore — undoing whatever shifted it or the section around it),
// then held against its section's glide, which has the same duration and curve
// (in a bottom-anchored card that section glides down as the card shrinks from
// its top).
function rowOut(node: Element, id: string, rowsBefore: ReadonlyMap<string, number>): () => TransitionConfig {
  return () => {
    // Composed onto the translate the leaving row is held at (as `fly` does).
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
 * leaving itself (a leaving section is `inert` and held with a STATIC
 * translate, which is no glide to ride against).
 */
function glideShift(section: HTMLElement | null): number {
  if (!section || section.inert || getComputedStyle(section).position === "absolute") return 0;
  const transform = getComputedStyle(section).transform;
  return !transform || transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
}

function rowIn(node: Element, id: string): TransitionConfig {
  // A row the avatar added has its own rise (CSS); this is for the rest.
  if (!avatarChangeFlushing() || get(todoActivity).marks[id]?.kind === "added") return NONE;
  return fade(node, { delay: 80, duration: 160, easing: quartOut });
}

// Translate-only FLIP. A scaling one would squash the text of a section a row
// just left for the whole glide (and drag the leaving row with it) — so the
// glide moves, never resizes. A row glides from where it sat BEFORE the change
// (rowsBefore). Its `to` already carries its section's own glide (sections
// start first), so a row that only rides its section gets no glide of its own.
function glide(node: Element, { from, to }: { from: DOMRect; to: DOMRect }, rowsBefore: ReadonlyMap<string, number>): TransitionConfig {
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

/** What keeps a leaving section mounted until the rows leaving with it have played out (they share GLIDE_MS). */
const rowsOut: TransitionFn<HTMLElement> = () => () => ({ duration: GLIDE_MS });

/** The inline styles `hold` replaced on a leaving element, put back if it is revived mid-exit. */
interface HeldStyles {
  position: string;
  width: string;
  height: string;
  transform: string;
}

/**
 * The card's sibling glide (a hand-written, translate-only FLIP) and what it
 * needs to know about leaving rows and sections. One per card, never state:
 * everything here is read and written around a commit, not rendered.
 *
 *   snapshot()  right BEFORE the list's new DOM lands (ListSnapshot): where
 *               every row and section is.
 *   leave()     from a row/section's layout effect when it starts to leave.
 *   settle()    the card's layout effect, after its children's: leaving
 *               elements go out of the flow — held in place while their exit
 *               plays, or gone at once — and the ones that stay glide from
 *               where they were to where they are now.
 */
class CardMotion {
  // Where each row sat on screen right before the avatar's change landed: a row
  // that leaves exits from exactly there (rowOut), whatever else the same change
  // moved — a parallel addition above can shift it before it is measured.
  readonly rowsBefore = new Map<string, number>();
  private from = new Map<Element, DOMRect>();
  private fresh = false;
  private departures: { node: HTMLElement; animate: boolean }[] = [];
  /** Rows and sections whose exit is still playing. */
  private readonly leaving = new Set<Element>();
  private readonly held = new Map<Element, HeldStyles>();
  private readonly glides = new Map<Element, TransitionRun>();

  constructor(private readonly list: RefObject<HTMLElement | null>) {}

  snapshot(): void {
    this.fresh = true;
    this.from = new Map();
    const list = this.list.current;
    if (!list) return;
    for (const node of list.querySelectorAll<HTMLElement>("section.todo-overlay-section, li.todo-overlay-item")) {
      // On its way out (or inside a section that is): it never glides, and a
      // row or section that comes back mid-exit does not either.
      if (this.isLeaving(node)) continue;
      this.from.set(node, node.getBoundingClientRect());
    }
  }

  /** Its exit is playing, or its section's is. */
  private isLeaving(node: Element): boolean {
    if (this.leaving.has(node)) return true;
    const section = node.closest("section");
    return section !== null && this.leaving.has(section);
  }

  /** A row or section started to leave: with its exit motion (`animate`), or at once. */
  leave(node: HTMLElement, animate: boolean): void {
    this.departures.push({ node, animate });
    if (animate) this.leaving.add(node);
  }

  /** It came back before its exit ended: back into the flow. */
  revive(node: HTMLElement): void {
    this.leaving.delete(node);
    const styles = this.held.get(node);
    if (!styles) return;
    this.held.delete(node);
    node.style.position = styles.position;
    node.style.width = styles.width;
    node.style.height = styles.height;
    node.style.transform = styles.transform;
  }

  /** The element unmounted. */
  forget(node: Element): void {
    this.leaving.delete(node);
    this.held.delete(node);
    this.from.delete(node);
    this.glides.get(node)?.abort();
    this.glides.delete(node);
  }

  settle(): void {
    const departures = this.departures;
    this.departures = [];
    const fresh = this.fresh;
    this.fresh = false;
    const from = this.from;
    this.from = new Map();
    const list = this.list.current;
    if (!list || (!fresh && !departures.length)) return;

    // What leaves without motion is out of the layout now (React takes it out of
    // the DOM right after this commit); what leaves with motion is held below.
    const gone = new Set<Element>();
    const leavingNow = new Set<Element>();
    for (const { node, animate } of departures) {
      if (animate) {
        leavingNow.add(node);
      } else {
        gone.add(node);
        node.style.display = "none";
      }
    }
    const out = (node: Element): boolean => {
      if (gone.has(node) || this.isLeaving(node)) return true;
      const section = node.closest("section");
      return section !== null && gone.has(section);
    };

    const sections = [...list.querySelectorAll<HTMLElement>("section.todo-overlay-section")].filter((section) => !gone.has(section));

    // Leaving sections first, then — section by section, top to bottom — the
    // rows leaving a section that stays. Each group is measured while all of it
    // is still in the flow, then taken out one element at a time.
    this.holdAll(sections.filter((section) => leavingNow.has(section)));
    for (const section of sections) {
      if (this.leaving.has(section)) continue;
      this.holdAll([...section.querySelectorAll<HTMLElement>("li.todo-overlay-item")].filter((row) => leavingNow.has(row)));
    }

    if (!fresh) return;
    // The glides: sections start first, so a row's `to` carries its section's.
    for (const section of sections) if (!out(section)) this.glide(section, from.get(section));
    for (const row of list.querySelectorAll<HTMLElement>("li.todo-overlay-item")) if (!out(row)) this.glide(row, from.get(row));
  }

  private holdAll(nodes: HTMLElement[]): void {
    const places = nodes.map((node) => node.getBoundingClientRect());
    nodes.forEach((node, index) => this.hold(node, places[index]));
  }

  /**
   * Take a leaving element out of the flow and keep it where it was (`from`),
   * with absolute positioning — the list is the positioned ancestor it stays
   * inside of and scrolls with.
   */
  private hold(node: HTMLElement, from: { left: number; top: number }): void {
    // If an animation is already running, transforming the element is likely to
    // fail: the animation's styles take precedence over the translate below.
    if (node.getAnimations().length) return;
    // Fixed values first: going absolute can change the computed width.
    const { position, width, height } = getComputedStyle(node);
    if (position === "absolute" || position === "fixed") return;
    const style = node.style;
    this.held.set(node, { position: style.position, width: style.width, height: style.height, transform: style.transform });
    style.position = "absolute";
    style.width = width;
    style.height = height;
    const to = node.getBoundingClientRect();
    if (from.left !== to.left || from.top !== to.top) {
      const transform = `translate(${from.left - to.left}px, ${from.top - to.top}px)`;
      style.transform = style.transform ? `${style.transform} ${transform}` : transform;
    }
  }

  private glide(node: HTMLElement, from: DOMRect | undefined): void {
    // Any change of the list cuts a running glide short; only a new offset starts another.
    this.glides.get(node)?.abort();
    this.glides.delete(node);
    // No `from`: it arrived with this change.
    if (!from) return;
    const to = node.getBoundingClientRect();
    if (from.left === to.left && from.right === to.right && from.top === to.top && from.bottom === to.bottom) return;
    const run = play(node, glide(node, { from, to }, this.rowsBefore), undefined, 1, (ended) => {
      ended.abort();
      if (this.glides.get(node) === ended) this.glides.delete(node);
    });
    if (run) this.glides.set(node, run);
  }
}

/**
 * Play one half of a transition by hand (lib/transition's runner, the one
 * <Presence> uses). Returns nothing when there was nothing to play.
 */
function play(
  node: Element,
  options: TransitionResult,
  counterpart: TransitionRun | undefined,
  target: 0 | 1,
  finished: (run: TransitionRun) => void,
): TransitionRun | undefined {
  // A transition with nothing to play reports its end before `runTransition` returns.
  const state: { run?: TransitionRun; done: boolean } = { done: false };
  state.run = runTransition(node, options, counterpart, target, () => {
    state.done = true;
    if (state.run) finished(state.run);
  });
  return state.done ? undefined : state.run;
}

/**
 * Measures the list right before a commit that changes it touches the DOM —
 * the "first" of the FLIP. Only when the list's sections were rebuilt: every
 * app-state write (each streamed token) re-renders the card, and measuring
 * every row on each of those would force a layout per token.
 */
class ListSnapshot extends Component<{ sections: unknown; motion: CardMotion }> {
  getSnapshotBeforeUpdate(previous: { sections: unknown }): null {
    if (previous.sections !== this.props.sections) this.props.motion.snapshot();
    return null;
  }

  componentDidUpdate(): void {}

  render(): null {
    return null;
  }
}

/**
 * An element's entrance, played by hand whenever the element is created — and
 * again when it comes back while it was leaving. The originals' entrances were
 * `|global` (they ran for a row created together with its new section too) and
 * independent of the exit: an exit never took over from a running entrance, and
 * a return dropped the exit and entered from the start. <Presence> plays an
 * entrance only for a child that arrives after it mounted and treats `in`/`out`
 * as one pair, so these elements give it their exit only. The entrance itself
 * still decides, from non-reactive state read when it starts, whether anything
 * moves (nothing does outside an avatar's change — a mount included).
 */
function useEntrance<E extends HTMLElement>(ref: RefObject<E | null>, entrance: (node: E) => TransitionConfig): () => void {
  const running = useRef<TransitionRun | undefined>(undefined);
  const enter = useRef(() => {
    const node = ref.current;
    if (!node) return;
    running.current?.abort();
    running.current = play(node, entrance(node), undefined, 1, (run) => {
      run.abort();
      if (running.current === run) running.current = undefined;
    });
  }).current;
  useLayoutEffect(() => {
    enter();
    return () => running.current?.abort();
    // Mount and unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return enter;
}

/**
 * A count that pops for the avatar's change. Rendered with `key={seq}`, so it
 * is a new element per change; whether it pops is read once, when it mounts —
 * the flag is closed again right after the change's own update, and a class
 * that followed it would cut the pop short on the next render.
 */
function Pop({ className, seq, children }: { className: string; seq: number; children: ReactNode }) {
  const [popping] = useState(() => seq > 0 && avatarChangeFlushing());
  return <span className={cx(className, popping && "is-popping")}>{children}</span>;
}

function EmptyNote({ ownAvatar }: { ownAvatar: boolean }) {
  const ref = useRef<HTMLParagraphElement | null>(null);
  useEntrance(ref, emptyIn);
  return (
    <p className="todo-overlay-empty" ref={ref}>
      {ownAvatar
        ? "열린 할 일이 없습니다. 이 대화에서 “할 일에 넣어줘” 또는 /todo로 부탁하거나, 할 일 탭에서 추가해 보세요."
        : "열린 할 일이 없습니다. 할 일 탭에서 추가해 보세요."}
    </p>
  );
}

interface RowActions {
  complete(item: TodoItem): void;
  toggleStarted(item: TodoItem): void;
  drop(item: TodoItem): void;
  openItem(item: TodoItem): void;
}

/** What the card hands every section and row. */
interface ListProps {
  todayKst: string;
  marks: Record<string, TodoMark>;
  busy: ReadonlySet<string>;
  actions: RowActions;
  motion: CardMotion;
}

function tagText(tags: string[]): string {
  return tags.length > 1 ? `#${tags[0]} +${tags.length - 1}` : `#${tags[0]}`;
}

interface RowProps extends ListProps {
  item: TodoItem;
  /** False while the row's whole section is leaving. */
  sectionPresent: boolean;
  /** Counts the rows leaving, with motion, together with their section. */
  sectionExits: { count: number };
}

function Row({ item, todayKst, marks, busy, actions, motion, sectionPresent, sectionExits }: RowProps) {
  const ref = useRef<HTMLLIElement | null>(null);
  const present = useIsPresent();
  // The key is the id, so it never changes for one row.
  const id = item.id;
  const enter = useEntrance(ref, (node) => rowIn(node, id));
  const leaving = useRef<"no" | "row" | "section">("no");
  /** The exit the row plays by hand, inside its leaving section. */
  const ownExit = useRef<TransitionRun | undefined>(undefined);
  const spec = useRef<TransitionSpec<HTMLLIElement>>({}).current;

  // Decided when the row STARTS to leave, before useTransition (below) reads
  // `spec.out`: a row that leaves without motion gets no exit at all, so it is
  // out of the DOM with this very commit instead of lingering for a frame.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const now = !present ? "row" : !sectionPresent ? "section" : "no";
    const was = leaving.current;
    if (now === was || (was === "row" && now === "section")) return;
    leaving.current = now;
    if (was !== "no") {
      // It came back before its exit ended: it enters again, and the exit is
      // dropped (useTransition drops the one <Presence> was playing).
      enter();
      if (was === "row") {
        motion.revive(node);
      } else {
        node.inert = false;
        ownExit.current?.abort();
        ownExit.current?.reset();
        ownExit.current = undefined;
      }
    }
    if (now === "no") return;
    // One-shot, and asked again on every exit: only a row the avatar's change
    // took away leaves with motion — never under reduced motion.
    const animate = takeAvatarDeparture(id) && !prefersReducedMotion();
    if (now === "row") {
      spec.out = animate ? (target) => rowOut(target, id, motion.rowsBefore) : undefined;
      motion.leave(node, animate);
      return;
    }
    // Leaving with its whole section: the row stays in it (the section is what
    // <Presence> keeps), and plays its own exit there.
    node.inert = true;
    if (!animate) return;
    sectionExits.count += 1;
    ownExit.current = runTransition(node, rowOut(node, id, motion.rowsBefore), undefined, 0, () => {});
    // `enter`, `spec`, `motion` and `sectionExits` keep their identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, sectionPresent]);

  useTransition(ref, spec);

  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      ownExit.current?.abort();
      if (node) motion.forget(node);
    };
  }, [motion]);

  const bucket = todoDueBucket(item.dueDate, todayKst);
  const pending = isPendingTodo(item);
  const rowBusy = pending || busy.has(item.id);
  const mark = marks[item.id];

  return (
    <li
      ref={ref}
      className="todo-overlay-item"
      data-todo-id={item.id}
      data-arrival={mark?.kind}
      style={{ "--todo-arrival-delay": mark ? `${mark.delay}ms` : undefined } as CSSProperties}
      aria-busy={rowBusy ? "true" : undefined}
    >
      {/* The label is only the touch-sized hit area; the name is the checkbox's own. */}
      <label className="todo-overlay-check-hit">
        <input
          className="todo-overlay-check"
          type="checkbox"
          checked={false}
          disabled={rowBusy}
          aria-label={`완료: ${item.title}`}
          onChange={() => actions.complete(item)}
        />
      </label>
      <span className="todo-overlay-main">
        {item.priority === "high" ? (
          <span className="todo-overlay-flag" role="img" aria-label="우선순위 높음" title="우선순위 높음">
            !
          </span>
        ) : null}
        <button className="todo-overlay-title" type="button" disabled={pending} title={item.title} onClick={() => actions.openItem(item)}>
          {item.title}
        </button>
        {item.tags.length ? (
          <span className="todo-overlay-tag" title={item.tags.map((tag) => `#${tag}`).join(" ")}>
            {tagText(item.tags)}
          </span>
        ) : null}
      </span>
      <span className="todo-overlay-trail">
        <span className="todo-overlay-meta">
          {item.note.trim() ? (
            <span className="todo-overlay-icon" role="img" aria-label="메모 있음" title="메모 있음">
              <Icon name="file-text" size={12} />
            </span>
          ) : null}
          {item.source !== "user" ? (
            <span
              className="todo-overlay-icon is-avatar"
              role="img"
              aria-label={todoSourceTitle(item.source)}
              title={todoSourceTitle(item.source)}
            >
              <Icon name="sparkles" size={12} />
            </span>
          ) : null}
          {item.dueDate ? (
            <span className="todo-overlay-due" data-bucket={bucket} title={dueDateText(item.dueDate, todayKst)}>
              {dueLabel(item.dueDate, todayKst)}
            </span>
          ) : null}
        </span>
        {!pending ? (
          <span className="todo-overlay-actions">
            <button
              className="todo-overlay-action"
              type="button"
              disabled={rowBusy}
              aria-label={`${item.status === "in_progress" ? "시작 전으로" : "진행 중으로"}: ${item.title}`}
              title={item.status === "in_progress" ? "시작 전으로" : "진행 중으로"}
              onClick={() => actions.toggleStarted(item)}
            >
              <Icon name={item.status === "in_progress" ? "pause" : "play"} size={13} />
            </button>
            <button
              className="todo-overlay-action"
              type="button"
              disabled={rowBusy}
              aria-label={`드랍: ${item.title}`}
              title="드랍"
              onClick={() => actions.drop(item)}
            >
              <Icon name="ban" size={13} />
            </button>
          </span>
        ) : null}
      </span>
    </li>
  );
}

interface SectionProps extends ListProps {
  section: TodoOverlaySection;
  onToggle(id: TodoOverlaySectionId): void;
}

function Section({ section, onToggle, ...list }: SectionProps) {
  const { marks, motion } = list;
  const ref = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const present = useIsPresent();
  const enter = useEntrance(ref, sectionIn);
  const wasLeaving = useRef(false);
  const rowExits = useRef({ count: 0 }).current;
  const spec = useRef<TransitionSpec<HTMLElement>>({}).current;
  const rowsSpec = useRef<TransitionSpec<HTMLElement>>({}).current;

  // Like a row's: decided when the section STARTS to leave, before the two
  // useTransition calls read their specs. Its rows' effects ran first (children's
  // do), so how many of them leave with motion is known by now.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || wasLeaving.current === !present) return;
    wasLeaving.current = !present;
    if (present) {
      // Back before its exit ended: it enters again (useTransition drops the exit).
      rowExits.count = 0;
      enter();
      motion.revive(node);
      return;
    }
    const animate = avatarChangeFlushing() && !prefersReducedMotion();
    const rows = rowExits.count > 0;
    // The first of the two exits below must be the one that lasts: an exit that
    // ends at once while it is the only one begun lets <Presence> drop the section.
    spec.out = animate ? sectionOut : rows ? rowsOut : undefined;
    rowsSpec.out = animate && rows ? rowsOut : undefined;
    motion.leave(node, animate || rows);
    // `enter`, `spec`, `rowsSpec`, `rowExits` and `motion` keep their identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);

  useTransition(ref, spec);
  // The section's own fade is 180 ms, the rows leaving with it take GLIDE_MS:
  // this second exit (on the heading, which shows nothing of it) keeps the
  // section mounted until they are through.
  useTransition(headingRef, rowsSpec);

  useLayoutEffect(() => {
    const node = ref.current;
    return () => {
      if (node) motion.forget(node);
    };
  }, [motion]);

  const sectionPop = todoSectionArrivalSeq(section, marks);

  return (
    <section ref={ref} className="todo-overlay-section" aria-label={section.label}>
      <h3 ref={headingRef} className={section.id === "overdue" ? "warn" : undefined}>
        <button
          className="todo-overlay-section-toggle"
          type="button"
          aria-expanded={!section.collapsed}
          onClick={() => onToggle(section.id)}
        >
          <Icon name="chevron-down" size={12} /> <span>{section.label}</span>{" "}
          <Pop key={sectionPop} className="todo-overlay-section-count" seq={sectionPop}>
            {section.members.length}
          </Pop>
        </button>
      </h3>
      {!section.collapsed ? (
        <ul>
          <Presence>
            {section.items.map((item) => (
              <Row key={item.id} item={item} sectionPresent={present} sectionExits={rowExits} {...list} />
            ))}
          </Presence>
        </ul>
      ) : null}
    </section>
  );
}

// Deferred past first paint (never focus/measure inside the mount task); by
// then the first measurement has decided the mode.
function afterPaint(run: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(() => run()));
}

/** What the card lists, rebuilt only when its inputs change identity. */
interface Listed {
  items: TodoItem[];
  today: string;
  folded: ReadonlySet<string>;
  overlay: ReturnType<typeof overlaySections>;
  progress: ReturnType<typeof todoTodayProgress>;
  filterCounts: ReturnType<typeof todoFilterCounts>;
}

export default function TodoOverlay({ ownAvatar = false }: TodoOverlayProps) {
  const state = useAppState();
  const marks = useStore(todoActivity).marks;

  const rootRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Rendered (the card's class and attributes) AND read later by callbacks
  // registered once, so each of these is state for the render and a ref for them.
  const [mode, setModeState] = useState<TodoOverlayMode>(() =>
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 860px)").matches ? "sheet" : "popover",
  );
  const modeRef = useRef(mode);

  const todos = state.todos;
  const counts = todos.counts;
  // Folded sections, per browser; a new Set on every toggle, so the list below sees it.
  const [collapsed, setCollapsedState] = useState<ReadonlySet<string>>(() => loadTodoOverlayCollapsed(TODO_OVERLAY_SECTION_IDS));
  const collapsedRef = useRef(collapsed);
  // Every app-state write (each streamed token) re-renders the card, but the
  // lists — whose every row is measured for the glide when they change — are
  // rebuilt only when the items, the KST day or the folded sections actually changed.
  const listedRef = useRef<Listed | null>(null);
  let listed = listedRef.current;
  if (!listed || listed.items !== todos.items || listed.today !== todos.todayKst || listed.folded !== collapsed) {
    listed = listedRef.current = {
      items: todos.items,
      today: todos.todayKst,
      folded: collapsed,
      overlay: overlaySections(todos.items, todos.todayKst, TODO_OVERLAY_LIMIT, collapsed),
      progress: todoTodayProgress(todos.items, todos.todayKst),
      filterCounts: todoFilterCounts(todos.items, counts, todos.todayKst),
    };
  }
  const { overlay, progress, filterCounts, today: todayKst } = listed;
  const progressTotal = progress.done + progress.left;
  // Chips into the tab's filters — only the ones with something in them.
  const chips = (
    [
      { filter: "in_progress", label: "진행 중", count: filterCounts.in_progress },
      { filter: "overdue", label: "마감 지남", count: filterCounts.overdue },
      { filter: "upcoming", label: "예정", count: filterCounts.upcoming },
    ] satisfies { filter: TodoFilter; label: string; count: number }[]
  ).filter((chip) => chip.count > 0);

  function toggleSection(id: TodoOverlaySectionId) {
    const next = new Set(collapsedRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsedRef.current = next;
    setCollapsedState(next);
    persistTodoOverlayCollapsed(next);
  }

  // Minimized (header only) is the PINNED card's: a popover/sheet is transient
  // already, so there the preference is kept but not applied.
  const [minimizedPref, setMinimizedPref] = useState(loadTodoOverlayMinimized);
  const minimizedPrefRef = useRef(minimizedPref);
  const minimized = mode === "pinned" && minimizedPref;
  function toggleMinimized() {
    const next = !minimizedPrefRef.current;
    minimizedPrefRef.current = next;
    setMinimizedPref(next);
    persistTodoOverlayMinimized(next);
  }

  // More rows below the fold: the list's bottom edge fades. Read in the scroll
  // handler and after a paint — never inside the mount task.
  const [moreBelow, setMoreBelow] = useState(false);
  const moreBelowRef = useRef(false);
  function checkMoreBelow() {
    const list = listRef.current;
    if (!list) return;
    const next = list.scrollHeight - list.scrollTop - list.clientHeight > 1;
    if (next === moreBelowRef.current) return;
    moreBelowRef.current = next;
    // In the DOM with this very task (a frame late, the fade would trail the scroll).
    flushSync(() => setMoreBelow(next));
  }
  // The list's content can also change height without its box or a scroll moving
  // (a leaving row is removed only after its exit, a web font swaps in): the
  // re-checks after the motion and once the fonts are ready cover those.
  const moreCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleMoreCheck() {
    afterPaint(checkMoreBelow);
    if (moreCheckTimer.current) clearTimeout(moreCheckTimer.current);
    moreCheckTimer.current = setTimeout(() => {
      moreCheckTimer.current = null;
      checkMoreBelow();
    }, GLIDE_MS + 80);
  }
  useLayoutEffect(() => {
    scheduleMoreCheck();
    // `overlay` is rebuilt only when the list changed (see `listed`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay, mode, minimized]);

  // The avatar's newest addition that has no row here (past the visible rows):
  // the footer's `(외 N개)` pops for that change instead.
  const footerPop = todoHiddenArrivalSeq(overlay.sections, marks, listed.items);
  const dismissed = state.todoOverlayDismissed;
  // Pinned never honours a transient dismissal: once the column is wide again
  // the persistent card is back.
  useLayoutEffect(() => {
    if (mode === "pinned" && dismissed) restoreTodoOverlay();
  }, [mode, dismissed]);
  // Shown again by the composer toggle after a dismissal: take focus if asked.
  const wasDismissed = useRef(false);
  useLayoutEffect(() => {
    if (wasDismissed.current && !dismissed && consumeTodoOverlayFocus()) afterPaint(focusCard);
    wasDismissed.current = dismissed;
    // focusCard reads refs and the store only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed]);

  /**
   * An explicit toggle press hands focus to a TRANSIENT card, where Escape gives
   * it back to the toggle. The pinned card is a persistent side region that
   * Escape never closes, so focus stays on the toggle there. Focusable only for
   * that moment (a temporary tabindex), so a click on the card's background
   * never pulls the caret out of the composer. A persisted "on" re-opening the
   * card after a reload never steals focus.
   */
  function focusCard(anyMode = false) {
    const card = rootRef.current;
    if (!card || (modeRef.current === "pinned" && !anyMode) || readState().todoOverlayDismissed) return;
    card.setAttribute("tabindex", "-1");
    card.addEventListener("blur", () => card.removeAttribute("tabindex"), { once: true });
    card.focus();
  }

  const motionRef = useRef<CardMotion | null>(null);
  const motion = (motionRef.current ??= new CardMotion(listRef));

  // An avatar's change is about to land — the list still shows the old rows.
  function beforeAvatarChange() {
    motion.rowsBefore.clear();
    const list = listRef.current;
    if (!list || prefersReducedMotion() || readState().todoOverlayDismissed) return;
    for (const row of list.querySelectorAll<HTMLElement>("li[data-todo-id]")) {
      motion.rowsBefore.set(row.dataset.todoId ?? "", row.getBoundingClientRect().top);
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
  const heightHold = useRef<ReturnType<typeof setTimeout> | null>(null);
  function holdListHeight() {
    const list = listRef.current;
    if (!list || modeRef.current !== "pinned" || prefersReducedMotion() || readState().todoOverlayDismissed) return;
    list.style.minHeight = `${list.getBoundingClientRect().height}px`;
    if (heightHold.current) clearTimeout(heightHold.current);
    heightHold.current = setTimeout(() => {
      heightHold.current = null;
      if (listRef.current) listRef.current.style.minHeight = "";
    }, HEIGHT_HOLD_MS);
  }

  function toggleButton(): HTMLButtonElement | null {
    return rootRef.current?.closest(".chat-pane")?.querySelector<HTMLButtonElement>(".composer-todo-btn") ?? null;
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

  // The handlers below are registered once (the mount effect, the outside-press
  // action), so they read the mode and the dismissal as they are when they run.
  function isTransient(): boolean {
    return modeRef.current !== "pinned";
  }

  function onOutside() {
    if (isTransient() && !readState().todoOverlayDismissed) dismiss(false);
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !isTransient() || readState().todoOverlayDismissed || event.defaultPrevented) return;
    // An IME composition owns Escape until it commits; a dialog keeps its own.
    if (event.isComposing || event.keyCode === 229) return;
    const active = document.activeElement;
    if (active?.closest('[role="dialog"], [aria-modal="true"], .modal-overlay')) return;
    event.preventDefault();
    // Focus goes back to the toggle only when it was inside the card (the card
    // itself included); Escape pressed in the composer leaves the caret there.
    dismiss(Boolean(active && rootRef.current?.contains(active)));
  }

  useLayoutEffect(() => {
    const root = rootRef.current;
    const list = listRef.current;
    const host = root?.parentElement ?? null;
    const narrow = window.matchMedia?.("(max-width: 860px)") ?? null;
    // An explicit toggle click asked for this card (and its focus).
    const explicit = consumeTodoOverlayFocus();
    let hostWidth = 0;
    let measured = false;
    const decide = () => {
      const next = todoOverlayMode(hostWidth, Boolean(narrow?.matches));
      if (next !== modeRef.current) {
        modeRef.current = next;
        // Rendered before this frame is painted: a card measured as pinned is
        // never shown once in the popover's place first.
        flushSync(() => setModeState(next));
      }
      if (measured) return;
      measured = true;
      // A toggle click that landed between mount and this first measure (a fast
      // click in another split pane remounts the card first) is explicit too.
      const late = consumeTodoOverlayFocus();
      if (late) afterPaint(focusCard);
      if (next !== "pinned" && !explicit && !late) dismissTodoOverlay();
    };
    const observer =
      host && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver((entries) => {
            hostWidth = entries[0]?.contentRect.width ?? hostWidth;
            decide();
          })
        : null;
    if (host) observer?.observe(host);
    // The list's own box changes (the window's height, the composer growing): re-check the fade.
    const listObserver = list && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => checkMoreBelow()) : null;
    if (list) listObserver?.observe(list);
    void document.fonts?.ready.then(() => checkMoreBelow());
    narrow?.addEventListener?.("change", decide);
    // Escape anywhere (the composer included) dismisses a transient card; bubble
    // phase, so a handler that owns Escape first (slash menu, rewind editor, a
    // dialog) wins by preventing/stopping it.
    window.addEventListener("keydown", onWindowKeydown);
    if (!readState().todoOverlayDismissed && explicit) afterPaint(focusCard);
    const stopListening = onBeforeAvatarChange(beforeAvatarChange);
    return () => {
      observer?.disconnect();
      listObserver?.disconnect();
      if (moreCheckTimer.current) clearTimeout(moreCheckTimer.current);
      narrow?.removeEventListener?.("change", decide);
      window.removeEventListener("keydown", onWindowKeydown);
      stopListening();
      if (heightHold.current) clearTimeout(heightHold.current);
    };
    // Mount and unmount only: everything registered here reads refs and the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After every commit, once the rows' and sections' own effects have run: the
  // list's glide (it acts only when the list changed — see ListSnapshot).
  useLayoutEffect(() => {
    motion.settle();
  });

  function complete(item: TodoItem) {
    void changeStatus(item, () => completeTodoWithUndo(item));
  }

  // One status write per row at a time — the checkbox included: a second press
  // while its PATCH is in flight is ignored, like the tab's status control.
  const [busy, setBusyState] = useState<ReadonlySet<string>>(() => new Set());
  const busyRef = useRef(busy);
  function setBusy(next: ReadonlySet<string>) {
    busyRef.current = next;
    setBusyState(next);
  }
  async function changeStatus(item: TodoItem, run: () => Promise<unknown>) {
    if (isPendingTodo(item) || busyRef.current.has(item.id)) return;
    setBusy(new Set(busyRef.current).add(item.id));
    try {
      await run();
    } finally {
      const next = new Set(busyRef.current);
      next.delete(item.id);
      setBusy(next);
    }
  }
  /** 시작 전 ↔ 진행 중. No toast: the row moves into (or out of) the 진행 중 section where it is seen. */
  function toggleStarted(item: TodoItem) {
    const refocus = focusInCard();
    void changeStatus(item, () => setTodoStatus(item.id, item.status === "in_progress" ? "todo" : "in_progress"));
    // The row was re-created in its new section: keep the keyboard on its same button.
    if (refocus) afterPaint(() => focusRow(item.id, ".todo-overlay-action"));
  }
  /** 드랍, with the same 되돌리기 toast as the tab (it restores the status the item had). */
  function drop(item: TodoItem) {
    const refocus = focusInCard();
    const neighbour = refocus ? neighbourId(item.id) : null;
    void changeStatus(item, () => closeTodoWithUndo(item, "dropped"));
    // The row is gone: focus the next row's title (the previous one at the end), else the card.
    if (refocus) afterPaint(() => (neighbour ? focusRow(neighbour, ".todo-overlay-title") : focusCard(true)));
  }
  function focusInCard(): boolean {
    const active = document.activeElement;
    return Boolean(active && rootRef.current?.contains(active));
  }
  function neighbourId(id: string): string | null {
    const ids = [...(listRef.current?.querySelectorAll<HTMLElement>("li[data-todo-id]") ?? [])].map((row) => row.dataset.todoId ?? "");
    const index = ids.indexOf(id);
    if (index < 0) return null;
    return ids[index + 1] ?? ids[index - 1] ?? null;
  }
  function focusRow(id: string, selector: string) {
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>("li[data-todo-id]") ?? [])].find((entry) => entry.dataset.todoId === id);
    const target = row?.querySelector<HTMLElement>(selector);
    if (target) target.focus();
    else focusCard(true);
  }

  // A transient card has done its job once the viewer leaves for the tab; a
  // pinned one stays switched on for when they come back.
  function openItem(item: TodoItem) {
    if (isPendingTodo(item)) return;
    if (isTransient()) dismissTodoOverlay();
    openTodoInTab(item.id);
  }

  function openAll() {
    if (isTransient()) dismissTodoOverlay();
    goView("todos");
  }

  function openFiltered(filter: TodoFilter) {
    if (isTransient()) dismissTodoOverlay();
    openTodosFiltered(filter);
  }

  const listProps: ListProps = { todayKst, marks, busy, actions: { complete, toggleStarted, drop, openItem }, motion };
  const cardRef = useMergedRef(rootRef, useAction(clickOutside, { onOutside, ignore: ".composer-todo-btn, .toast-wrap, .modal-overlay" }));

  return (
    <aside
      ref={cardRef}
      id="todo-overlay"
      className={cx(
        "todo-overlay cmp-todo-overlay",
        mode === "pinned" && "is-pinned",
        mode === "popover" && "is-popover",
        mode === "sheet" && "is-sheet",
        minimized && "is-minimized",
      )}
      data-mode={mode}
      aria-label="할 일"
      hidden={dismissed}
    >
      <header className="todo-overlay-head">
        <h2>할 일</h2>
        {todos.loaded ? (
          <span className="todo-overlay-counts">
            {`열림 ${counts.open}`}
            {minimized && counts.overdue ? <span className="todo-overlay-overdue">{` · 마감 지남 ${counts.overdue}`}</span> : null}
            {minimized && progressTotal ? ` · 오늘 ${progress.done}/${progressTotal}` : null}
          </span>
        ) : null}
        {mode === "pinned" ? (
          <button
            className="todo-overlay-icon-btn"
            type="button"
            aria-pressed={minimized}
            aria-controls="todo-overlay-content"
            aria-label="할 일 최소화"
            title={minimized ? "할 일 펼치기" : "할 일 최소화"}
            onClick={toggleMinimized}
          >
            <Icon name={minimized ? "chevron-down" : "minus"} size={14} />
          </button>
        ) : null}
        <button className="todo-overlay-icon-btn" type="button" aria-label="할 일 닫기" title="할 일 닫기" onClick={close}>
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="todo-overlay-content" id="todo-overlay-content" hidden={minimized}>
        {todos.loaded && (progressTotal || chips.length) ? (
          <div className="todo-overlay-summary">
            {progressTotal ? (
              // The bar sits beside the button, not in it: a button's children are presentational.
              <div className="todo-overlay-progress" data-complete={progress.left === 0 ? "true" : undefined}>
                <button
                  className="todo-overlay-progress-text"
                  type="button"
                  title="할 일 탭에서 오늘 할 일 보기"
                  onClick={() => openFiltered("today")}
                >
                  {`오늘 완료 ${progress.done} · 남음 ${progress.left}`}
                </button>
                <span
                  className="todo-overlay-progress-bar"
                  role="progressbar"
                  aria-label="오늘 진척도"
                  aria-valuemin={0}
                  aria-valuemax={progressTotal}
                  aria-valuenow={progress.done}
                >
                  <span style={{ width: `${(progress.done / progressTotal) * 100}%` }}></span>
                </span>
              </div>
            ) : null}
            {chips.length ? (
              <div className="todo-overlay-chips">
                {chips.map((chip) => (
                  <button
                    key={chip.filter}
                    className="todo-overlay-chip"
                    type="button"
                    data-filter={chip.filter}
                    title={`할 일 탭에서 ${chip.label} 보기`}
                    aria-label={`${chip.label} ${chip.count}개, 할 일 탭에서 보기`}
                    onClick={() => openFiltered(chip.filter)}
                  >
                    {chip.label} <b>{chip.count}</b>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={cx("todo-overlay-body scroll-thin", moreBelow && "has-more")} ref={listRef} onScroll={checkMoreBelow}>
          {!todos.loaded ? (
            <p className="todo-overlay-empty" role="status">
              불러오는 중…
            </p>
          ) : null}
          {/* One keyed list that stays mounted, so a section the avatar empties
              leaves (and the rest glide up) instead of the list remounting. */}
          <Presence>
            {todos.loaded
              ? overlay.sections.map((section) => (
                  <Section key={section.id} section={section} onToggle={toggleSection} {...listProps} />
                ))
              : null}
          </Presence>
          {todos.loaded && !overlay.sections.length ? <EmptyNote ownAvatar={ownAvatar} /> : null}
          <ListSnapshot sections={overlay.sections} motion={motion} />
        </div>

        <footer className="todo-overlay-foot">
          <button className="linkish small" type="button" onClick={openAll}>
            전체 보기
            {overlay.hidden > 0 ? (
              <>
                {" "}
                <Pop key={footerPop} className="todo-overlay-more" seq={footerPop}>
                  (외 {overlay.hidden}개)
                </Pop>
              </>
            ) : null}
            {" →"}
          </button>
        </footer>
      </div>
    </aside>
  );
}
