// When an element's transition plays, and how it outlives its own removal.
//
// React unmounts a child the moment the parent stops rendering it, so an exit
// animation needs somebody to keep the child around: <Presence> does. It goes
// around whatever is rendered CONDITIONALLY or as a KEYED LIST, and a child that
// was dropped stays mounted — with the props it last had — until every
// transition inside it has played out (lib/transition.ts runs them).
//
//   <Presence>{open && <Modal key="m" … />}</Presence>
//   <Presence>{items.map((item) => <Row key={item.id} … />)}</Presence>
//
// The rules, which are the ones the app's motion was written against:
// - An INTRO plays for a child that arrives after its <Presence> mounted, not
//   for one that mounts together with it (a view opening with a card already
//   in place does not animate that card in).
// - While a child exits it is `inert`, and it is still MOUNTED: its effects and
//   listeners stay live until the exit ends, and so does its cleanup.
// - A child that comes back mid-exit turns around from where it is.
// - No <Presence> above: the intro plays, and there is no exit.

import {
  Children,
  createContext,
  createElement,
  isValidElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type HTMLAttributes,
  type JSX,
  type Key,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { runTransition, type TransitionFn, type TransitionResult, type TransitionRun } from "./transition";

interface ExitTicket {
  /** The exit played out. */
  done(): void;
  /** The exit was called off (the child came back, or its transition unmounted). */
  cancel(): void;
}

interface PresenceValue {
  present: boolean;
  intro: boolean;
  beginExit(): ExitTicket;
}

const PresenceContext = createContext<PresenceValue | null>(null);

/** Whether this subtree is still wanted by its parent (false while it plays its exit). */
export function useIsPresent(): boolean {
  return useContext(PresenceContext)?.present ?? true;
}

function PresenceChild({
  present,
  mounted,
  onExited,
  children,
}: {
  present: boolean;
  mounted: RefObject<boolean>;
  /** `inCommit`: called from a layout effect (React is committing) rather than from a finished animation. */
  onExited: (inCommit: boolean) => void;
  children: ReactNode;
}): ReactElement {
  // Fixed at first render: did this child arrive after its <Presence> mounted?
  const [intro] = useState(() => mounted.current);
  const exits = useRef(0);
  const presentRef = useRef(present);
  presentRef.current = present;
  const exitedRef = useRef(onExited);
  exitedRef.current = onExited;
  // True from the render that drops this child until its own layout effect:
  // the window in which the transitions inside take their exit tickets. An
  // exit that finishes inside that window (nothing to play) must not remove
  // the child yet — a sibling transition may still be about to take a ticket.
  const collecting = useRef(false);
  const wasPresent = useRef(present);
  if (wasPresent.current !== present) {
    wasPresent.current = present;
    collecting.current = !present;
  }

  const value = useMemo<PresenceValue>(
    () => ({
      present,
      intro,
      beginExit() {
        let open = true;
        exits.current += 1;
        const settle = (leave: boolean): void => {
          if (!open) return;
          open = false;
          exits.current -= 1;
          if (leave && exits.current === 0 && !presentRef.current && !collecting.current) exitedRef.current(false);
        };
        return { done: () => settle(true), cancel: () => settle(false) };
      },
    }),
    [present, intro],
  );

  // Children's layout effects ran before this one, so every transition that
  // wants to play an exit has taken its ticket by now. None taken: leave at once.
  useLayoutEffect(() => {
    collecting.current = false;
    if (!present && exits.current === 0) exitedRef.current(true);
  }, [present]);

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

function childKey(child: ReactElement, index: number): Key {
  return child.key ?? `.${index}`;
}

export function Presence({ children }: { children?: ReactNode }): ReactElement {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const mounted = useRef(false);
  /** What the last COMMITTED render showed, exiting children included, in order. */
  const committed = useRef<{ order: Key[]; elements: Map<Key, ReactElement> }>({ order: [], elements: new Map() });
  /** Exits that have played out since the last commit. */
  const gone = useRef(new Set<Key>());

  const live = new Map<Key, ReactElement>();
  Children.forEach(children, (child, index) => {
    if (isValidElement(child)) live.set(childKey(child, index), child);
  });

  const previous = committed.current;
  const order = [...live.keys()];
  const elements = new Map(live);
  previous.order.forEach((key, index) => {
    if (live.has(key) || gone.current.has(key)) return;
    const element = previous.elements.get(key);
    if (!element) return;
    // An exiting child keeps its place: right after its nearest earlier
    // neighbour that is still shown.
    let at = 0;
    for (let i = index - 1; i >= 0; i -= 1) {
      const found = order.indexOf(previous.order[i]);
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    order.splice(at, 0, key);
    elements.set(key, element);
  });

  useLayoutEffect(() => {
    // From here on a child that appears is an arrival (children read this
    // while they render, so the ones of the first render never see it).
    mounted.current = true;
    committed.current = { order, elements };
    for (const key of [...gone.current]) if (!elements.has(key) || live.has(key)) gone.current.delete(key);
  });

  return (
    <>
      {order.map((key) => (
        <PresenceChild
          key={key}
          present={live.has(key)}
          mounted={mounted}
          onExited={(inCommit) => {
            // Called only while the child is not wanted; a child that came back
            // since is `live` again and the next render ignores the mark.
            gone.current.add(key);
            // An exit that ended on its own (a finished animation, a deferred
            // exit that decided not to play) removes the child NOW, not at
            // React's next scheduled render — it would otherwise stay on screen,
            // finished and inert, for up to a frame.
            if (inCommit) rerender();
            else flushSync(rerender);
          }}
        >
          {elements.get(key)}
        </PresenceChild>
      ))}
    </>
  );
}

export interface TransitionSpec<E extends Element = HTMLElement> {
  /** Plays when the element arrives. */
  in?: TransitionFn<E>;
  /** Plays when the element leaves. */
  out?: TransitionFn<E>;
  /** One reversible transition for both directions (an exit undone mid-way runs back). */
  both?: TransitionFn<E>;
}

/**
 * Give the element behind `ref` an enter/exit transition. The spec's functions
 * are read when a transition STARTS, so they may close over the latest render.
 */
export function useTransition<E extends HTMLElement>(ref: RefObject<E | null>, spec: TransitionSpec<E>): void {
  const context = useContext(PresenceContext);
  const present = context?.present ?? true;
  const playIntro = context ? context.intro : true;
  const specRef = useRef(spec);
  specRef.current = spec;
  const contextRef = useRef(context);
  contextRef.current = context;
  const state = useRef<{
    started: boolean;
    intro?: TransitionRun;
    outro?: TransitionRun;
    options?: TransitionResult;
    inert: boolean;
  }>({ started: false, inert: false });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const s = state.current;
    const current = specRef.current;
    const introFn = current.both ?? current.in;
    const outroFn = current.both ?? current.out;
    const reversible = Boolean(current.both);
    // While one half is still running, the other reuses its options, so a
    // reversed transition runs back along the same path instead of jumping.
    const optionsFor = (fn: TransitionFn<E>): TransitionResult => (s.options ??= fn(node));

    if (present) {
      const first = !s.started;
      s.started = true;
      if (first) {
        s.inert = Boolean(node.inert);
        if (!playIntro) return;
      } else {
        node.inert = s.inert;
      }
      if (!introFn) {
        s.outro?.abort();
        s.outro?.reset();
        s.outro = undefined;
        return;
      }
      if (!reversible) {
        // `in` and `out` given separately are two independent transitions: the
        // arrival starts from the far end, and an exit still running is dropped.
        s.intro?.abort();
        s.outro?.abort();
        s.outro?.reset();
        s.outro = undefined;
        s.options = undefined;
      }
      s.intro = runTransition(node, optionsFor(introFn), reversible ? s.outro : undefined, 1, () => {
        s.intro?.abort();
        s.intro = undefined;
        s.options = undefined;
      });
      return;
    }

    s.started = true;
    const ticket = contextRef.current?.beginExit();
    if (!outroFn) {
      s.options = undefined;
      ticket?.done();
      return;
    }
    node.inert = true;
    if (!reversible) s.options = undefined;
    s.outro = runTransition(node, optionsFor(outroFn), reversible ? s.intro : undefined, 0, () => ticket?.done());
    return () => ticket?.cancel();
  }, [present, playIntro, ref]);

  useEffect(
    () => () => {
      state.current.intro?.abort();
      state.current.outro?.abort();
    },
    [],
  );
}

type TagName = keyof JSX.IntrinsicElements & keyof HTMLElementTagNameMap;

export type TransitionProps<T extends TagName> = TransitionSpec<HTMLElementTagNameMap[T]> &
  Omit<HTMLAttributes<HTMLElementTagNameMap[T]>, "in" | "out"> & {
    tag: T;
    ref?: Ref<HTMLElementTagNameMap[T]>;
  } & Record<`data-${string}`, string | number | boolean | undefined>;

/**
 * One element with a transition, for the common case of an element rendered
 * conditionally inside a component: `<Presence>{open && <Transition key="x"
 * tag="div" both={(node) => slide(node, {…})} className="…">…</Transition>}</Presence>`.
 */
export function Transition<T extends TagName>(props: TransitionProps<T>): ReactElement {
  const { tag, in: introFn, out: outroFn, both, ref, ...rest } = props;
  const local = useRef<HTMLElementTagNameMap[T] | null>(null);
  useTransition(local, { in: introFn, out: outroFn, both });
  return createElement(tag, {
    ...rest,
    ref: (node: HTMLElementTagNameMap[T] | null) => {
      local.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
  });
}
