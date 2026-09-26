// Kernel-held concurrency locks: abstract UNIX socket names (Linux). A name is held while a listening server owns
// it; the kernel releases it the instant the holder dies (SIGKILL included), so there are no lock files, no pid or
// age heuristics and nothing under /tmp. libuv creates the sockets CLOEXEC: children never inherit them.
//
//   \0noah-pptx/<ns>/slot-<k>        host-wide conversion slots, k < NOAH_PPTX_MAX_CONCURRENT
//   \0noah-pptx/<ns>/deck-<hash>     one check/build per deck (hash = sha256(realpath of the deck)[0:32])
//
// Abstract names are per network namespace — per container. Every conversion of one deployment runs in the same
// namespace as long as the agent's Bash is not sandboxed into its own netns (docs/CONTRACT.md "Locks").
import crypto from 'node:crypto';
import net from 'node:net';

export function defaultNamespace(env = process.env) {
  const ns = env.NOAH_PPTX_LOCK_NAMESPACE;
  if (ns && /^[A-Za-z0-9._-]{1,64}$/.test(ns)) return ns;
  return `uid-${typeof process.getuid === 'function' ? process.getuid() : 0}`;
}

export function slotName(ns, k) {
  return `\0noah-pptx/${ns}/slot-${k}`;
}

export function deckLockName(ns, deckRealpath) {
  return `\0noah-pptx/${ns}/deck-${crypto.createHash('sha256').update(String(deckRealpath)).digest('hex').slice(0, 32)}`;
}

/** Hold `name` -> {name, release()} or null when another process holds it (EADDRINUSE). */
export function tryLock(name) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err && err.code === 'EADDRINUSE') resolve(null);
      else reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      let released = false;
      resolve({
        name,
        release() {
          if (released) return;
          released = true;
          try {
            server.close();
          } catch {
            /* already closed */
          }
        },
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ path: name, exclusive: true });
  });
}

/** Sleep `ms`, or less when `signal` aborts first. */
function sleep(ms, signal = null) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Wait for one of `max` host-wide slots: poll every second (never past the deadline), call onWait({max}) once when
 * the first round finds every slot taken. -> {k, release()} or null after waitMs — or at once when `signal` (an
 * AbortSignal: the run was cancelled) aborts.
 */
export async function acquireSlot({ max = 2, waitMs = 0, ns = defaultNamespace(), onWait = null, pollMs = 1000, signal = null } = {}) {
  const n = Math.max(1, Math.floor(Number(max) || 1));
  const t0 = Date.now();
  let waited = false;
  for (;;) {
    if (signal?.aborted) return null;
    for (let k = 0; k < n; k++) {
      const l = await tryLock(slotName(ns, k));
      if (l) {
        if (!signal?.aborted) return { k, name: l.name, release: l.release, waitedMs: Date.now() - t0 };
        l.release();
        return null;
      }
    }
    const left = waitMs - (Date.now() - t0);
    if (left <= 0) return null;
    if (!waited) {
      waited = true;
      onWait?.({ max: n });
    }
    await sleep(Math.min(pollMs, left), signal);
  }
}

/** The per-deck lock -> {release()} or null while another check/build of that deck runs. */
export async function lockDeck({ deckRealpath, ns = defaultNamespace() }) {
  return tryLock(deckLockName(ns, deckRealpath));
}
