/**
 * Serialize git operations that touch the same on-disk clone.
 *
 * Multiple chat turns (and the HTTP routes) can hit the same working tree
 * concurrently: a single user's concurrent turns (and a trusted teammate's on
 * a shared account) race on their personal knowledge clone, and on a registered
 * repo's clone. Interleaved `fetch`/`checkout`/`add`/`commit`/`push` on one
 * working tree corrupt the index or each other's staged state.
 *
 * `withRepoLock` runs `fn` exclusively per `key` by chaining each call onto the
 * previous one for that key (a per-key promise queue). Callers serialize only
 * against the same key; different repos run in parallel.
 *
 * IMPORTANT — deadlock avoidance: the queue is NOT reentrant. A function held
 * under `withRepoLock(key, …)` must never call `withRepoLock(key, …)` again for
 * the same key (it would await a promise that can only settle after itself).
 * Callers wrap the OUTERMOST operation for a clone path and use lock-free
 * internals below it.
 */

/** Tail of the in-flight promise chain per repo key. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to `key`, queued behind any in-flight work for
 * the same key. The key should be the repo's local clone path so all operations
 * on one working tree serialize. Returns `fn`'s result; rejections propagate to
 * the caller without poisoning the queue (the next waiter still runs).
 */
export function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // Chain onto the prior op for this key. We swallow the predecessor's outcome
  // (`.catch`/`.then(() => …)`) so one failure doesn't reject every queued
  // caller — each call's own result/rejection is delivered via `result`.
  const prior = chains.get(key) ?? Promise.resolve();
  const result = prior.then(() => fn(), () => fn());
  // Advance the chain to this op (settled either way) so the next caller waits
  // for it. Drop the entry once it's the tail and has settled, to bound the map.
  const next = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, next);
  void next.then(() => {
    if (chains.get(key) === next) {
      chains.delete(key);
    }
  });
  return result;
}
