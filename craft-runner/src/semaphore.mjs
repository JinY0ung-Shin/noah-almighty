// FIFO counting semaphore with a bounded wait (global cap on live app processes, spec §4).

export class Busy extends Error {}

export class Semaphore {
  constructor(max) {
    this.max = max;
    this.running = 0;
    /** @type {{grant: Function, timer: NodeJS.Timeout}[]} */
    this.queue = [];
  }

  /**
   * Take a slot, waiting at most `waitMs`. Resolves to a release function (idempotent).
   * @param {number} waitMs
   * @returns {Promise<() => void>}
   */
  acquire(waitMs) {
    if (this.running < this.max && this.queue.length === 0) {
      this.running += 1;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimeout(entry.timer);
          this.running += 1;
          resolve(this.releaser());
        },
        timer: setTimeout(() => {
          this.queue = this.queue.filter((e) => e !== entry);
          reject(new Busy(`no free app slot within ${waitMs} ms`));
        }, waitMs),
      };
      this.queue.push(entry);
    });
  }

  releaser() {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.running -= 1;
      const next = this.queue.shift();
      if (next) next.grant();
    };
  }
}

/** Per-key promise chain: serializes async work per key (sync_in/sync_out/purge per sid). */
export class KeyedMutex {
  constructor() {
    /** @type {Map<string, Promise<unknown>>} */
    this.tails = new Map();
  }

  run(key, fn) {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
