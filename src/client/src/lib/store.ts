// The client's store primitive. It keeps the store CONTRACT the app was built
// on (`subscribe(run)` calls `run` with the current value at once and returns
// the unsubscribe; `set`/`update` notify synchronously) so every module that
// publishes state — lib/state.ts above all — reads the same as before, and the
// React components consume it through lib/hooks.ts (`useStore`).
//
// Two behaviours are load-bearing and must not be "optimised":
// - An OBJECT value always notifies, even when it is the same reference:
//   `updateState` mutates the state in place and hands the same object back.
// - A `set` made while subscribers are being notified is queued behind the
//   notification in progress, so every subscriber sees values in the order
//   they were set.

export type Subscriber<T> = (value: T) => void;
export type Unsubscriber = () => void;
export type Updater<T> = (value: T) => T;

export interface Readable<T> {
  subscribe(run: Subscriber<T>): Unsubscriber;
}

export interface Writable<T> extends Readable<T> {
  set(value: T): void;
  update(updater: Updater<T>): void;
}

/** True when `next` must be published: primitives by value, objects and functions always. */
export function changed(previous: unknown, next: unknown): boolean {
  // eslint-disable-next-line no-self-compare
  if (previous !== previous) return next === next;
  return previous !== next || (previous !== null && typeof previous === "object") || typeof previous === "function";
}

// One queue for every store: a set() made inside a subscriber is delivered
// after the notification that is already running, across stores too.
const queue: Array<[Subscriber<unknown>, unknown]> = [];

export function writable<T>(initial: T): Writable<T> {
  let value = initial;
  const subscribers = new Set<[Subscriber<T>]>();

  function set(next: T): void {
    if (!changed(value, next)) return;
    value = next;
    if (!subscribers.size) return;
    const drain = queue.length === 0;
    for (const subscriber of subscribers) queue.push([subscriber[0] as Subscriber<unknown>, value]);
    if (!drain) return;
    for (let i = 0; i < queue.length; i += 1) queue[i][0](queue[i][1]);
    queue.length = 0;
  }

  function update(updater: Updater<T>): void {
    set(updater(value));
  }

  function subscribe(run: Subscriber<T>): Unsubscriber {
    // A tuple, not the bare function: the same callback may subscribe twice.
    const subscriber: [Subscriber<T>] = [run];
    subscribers.add(subscriber);
    run(value);
    return () => {
      subscribers.delete(subscriber);
    };
  }

  return { set, update, subscribe };
}

/** The store's current value, read through a throwaway subscription. */
export function get<T>(store: Readable<T>): T {
  let value!: T;
  store.subscribe((current) => {
    value = current;
  })();
  return value;
}
