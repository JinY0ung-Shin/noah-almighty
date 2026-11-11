// The React side of the client's shared plumbing: reading a store, attaching a
// DOM behaviour ("action") to an element, listening on window/document.
//
// READ THIS BEFORE WRITING A COMPONENT — the app's state is MUTATED IN PLACE:
// `updateState(fn)` changes the one state object and publishes the same
// reference again. `useAppState()` re-renders the component on every
// publication, but nothing below the state object gets a new identity, so
//   - never `useMemo`/`useEffect`/`useCallback` on a store object as a
//     dependency expecting it to change — it will not; derive in the render
//     body, or depend on `useStoreVersion(appState)`;
//   - never wrap a component that takes store objects as props in `memo()`
//     with the default comparison — it would never update.

import { useLayoutEffect, useRef, useState, useSyncExternalStore, type RefCallback } from "react";
import { appState, type ClientState } from "./state";
import { changed, type Readable } from "./store";

interface Tracker<T> {
  value: T;
  version: number;
  listeners: Set<() => void>;
}

const trackers = new WeakMap<object, Tracker<unknown>>();

// One permanent subscription per store, taken the first time React reads it.
// The version is what React compares: a value mutated in place keeps its
// identity, so the value itself cannot tell React that something changed.
function track<T>(store: Readable<T>): Tracker<T> {
  let tracker = trackers.get(store) as Tracker<T> | undefined;
  if (!tracker) {
    const created: Tracker<T> = { value: undefined as T, version: 0, listeners: new Set() };
    let first = true;
    store.subscribe((value) => {
      created.value = value;
      if (first) {
        first = false;
        return;
      }
      created.version += 1;
      for (const listener of [...created.listeners]) listener();
    });
    trackers.set(store, created as Tracker<unknown>);
    tracker = created;
  }
  return tracker;
}

/** A counter that goes up every time the store publishes — the honest dependency for memos and effects. */
export function useStoreVersion(store: Readable<unknown>): number {
  const tracker = track(store);
  return useSyncExternalStore(
    (onChange) => {
      tracker.listeners.add(onChange);
      return () => {
        tracker.listeners.delete(onChange);
      };
    },
    () => tracker.version,
  );
}

/** The store's current value; the component re-renders on every publication. */
export function useStore<T>(store: Readable<T>): T {
  useStoreVersion(store);
  return track(store).value;
}

/** The app state (lib/state.ts). Re-renders on every `updateState`/`replaceState`. */
export function useAppState(): ClientState {
  return useStore(appState);
}

/** The latest value of something a long-lived callback needs, without re-subscribing. */
export function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * State that starts from a prop, can be set locally, and takes the prop's value
 * again whenever the PROP changes — a prop the component also assigns to
 * (`Toggle`'s `on`: flipped locally after a save, overwritten when the parent
 * passes a new value).
 */
export function usePropState<T>(prop: T): [T, (next: T) => void] {
  const [value, setValue] = useState(prop);
  const [seen, setSeen] = useState(prop);
  if (!Object.is(seen, prop)) {
    setSeen(prop);
    setValue(prop);
    return [prop, setValue];
  }
  return [value, setValue];
}

/** A DOM behaviour: called with the element, may be told about a new parameter, cleans up after itself. */
export type Action<E extends Element, P> = (
  node: E,
  param: P,
) => void | { update?: (param: P) => void; destroy?: () => void };

/**
 * Attach an action (lib/dom.ts and friends) to an element: `<textarea
 * ref={useAction(autosize, draft)} />`. The action runs when the element
 * mounts, `update(param)` after a render that changed `param` — an object
 * parameter counts as changed on every render — and `destroy()` when it
 * unmounts. `update` runs after the DOM has been updated.
 *
 * A hook, so one per element: an element inside `.map()` needs its own small
 * component.
 */
export function useAction<E extends Element, P>(action: Action<E, P>, param: P): RefCallback<E> {
  const slot = useRef<{
    handle: void | { update?: (param: P) => void; destroy?: () => void };
    attached: boolean;
    param: P;
    action: Action<E, P>;
    ref: RefCallback<E> | null;
  }>({ handle: undefined, attached: false, param, action, ref: null });
  const s = slot.current;
  s.action = action;

  // Before the element exists the action has not run, so the parameter it will
  // be called with is always the latest one.
  if (!s.attached) s.param = param;

  useLayoutEffect(() => {
    if (!s.attached || !changed(s.param, param)) return;
    s.param = param;
    if (s.handle) s.handle.update?.(param);
  });

  s.ref ??= (node: E | null) => {
    if (!node) return;
    s.handle = s.action(node, s.param);
    s.attached = true;
    return () => {
      if (s.handle) s.handle.destroy?.();
      s.handle = undefined;
      s.attached = false;
    };
  };
  return s.ref;
}

/**
 * One ref callback that feeds several refs — an element that needs your own
 * `useRef` AND an action: `ref={useMergedRef(boxRef, useAction(autosize, text))}`.
 * The returned callback keeps its identity (a ref callback whose identity
 * changes is detached and attached again, which would restart the action).
 */
export function useMergedRef<E>(...refs: Array<RefCallback<E> | { current: E | null } | null | undefined>): RefCallback<E> {
  const latest = useRef(refs);
  latest.current = refs;
  const merged = useRef<RefCallback<E> | null>(null);
  merged.current ??= (node: E | null) => {
    if (!node) return;
    const cleanups: Array<() => void> = [];
    for (const ref of latest.current) {
      if (!ref) continue;
      if (typeof ref === "function") {
        const cleanup = ref(node);
        cleanups.push(typeof cleanup === "function" ? cleanup : () => void ref(null));
      } else {
        ref.current = node;
        cleanups.push(() => {
          ref.current = null;
        });
      }
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  };
  return merged.current;
}

type TargetEventMap<T> = T extends Window ? WindowEventMap : T extends Document ? DocumentEventMap : HTMLElementEventMap;

function useTargetEvent<T extends Window | Document, K extends keyof TargetEventMap<T> & string>(
  target: () => T | null,
  type: K,
  handler: (event: TargetEventMap<T>[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void {
  const latest = useLatest(handler);
  const capture = typeof options === "boolean" ? options : Boolean(options?.capture);
  const passive = typeof options === "object" ? options.passive : undefined;
  useLayoutEffect(() => {
    const node = target();
    if (!node) return;
    const listener = (event: Event): void => latest.current(event as TargetEventMap<T>[K]);
    const listenerOptions = passive === undefined ? capture : { capture, passive };
    node.addEventListener(type, listener, listenerOptions);
    return () => node.removeEventListener(type, listener, listenerOptions);
    // `target` and `latest` are stable by construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, capture, passive]);
}

/** A `window` listener for the component's lifetime; always calls the latest handler. */
export function useWindowEvent<K extends keyof WindowEventMap>(
  type: K,
  handler: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void {
  useTargetEvent(() => (typeof window === "undefined" ? null : window), type, handler, options);
}

/** A `document` listener for the component's lifetime; always calls the latest handler. */
export function useDocumentEvent<K extends keyof DocumentEventMap>(
  type: K,
  handler: (event: DocumentEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void {
  useTargetEvent(() => (typeof document === "undefined" ? null : document), type, handler, options);
}

/** Join class names, dropping the falsy ones: `cx("toggle", on && "on")`. */
export function cx(...parts: Array<string | false | null | undefined | 0>): string {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    out = out ? `${out} ${part}` : part;
  }
  return out;
}
