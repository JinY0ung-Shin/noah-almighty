/**
 * Inbound MID-TURN user messages ("steers") for one live chat run.
 *
 * While the avatar is streaming, the viewer can send another message. It is
 * NOT a new turn: the held-open prompt generator (`buildHeldOpenQueryPrompt`)
 * yields it straight into the CLI's stdin, and the CLI folds it into the
 * running turn after the next `tool_result` — or, when the turn reaches its
 * `result` first, runs it as a SECOND turn in the same session.
 *
 * This class is the queue + the state machine between those two halves:
 *
 *   route  --push()-->  [unsent FIFO]  --next()-->  prompt generator --> CLI
 *   CLI  --command_lifecycle-->  noteLifecycle()  -->  listeners --> SSE
 *
 * The CLI never echoes a folded steer back as a stream `user` message, so its
 * `command_lifecycle` frames are the ONLY delivery signal: `started` means the
 * text actually reached the model, and nothing else does. A record that never
 * gets one (the run was cancelled, errored, or wrapped up first) ends as
 * `dropped` and is never persisted to history — the model never saw it.
 *
 * Deliberately dependency-free (only `node:crypto`): it is unit-tested on its
 * own and is consumed from both the run loop and the HTTP route.
 */

import { randomUUID } from "node:crypto";

/**
 * Lifecycle of one mid-turn message.
 *  - `queued`    accepted by the server, not yet handed to the model.
 *  - `delivered` the CLI reported `started` — the model has the text.
 *  - `completed` the CLI reported `completed` (informational).
 *  - `dropped`   it never reached the model (run cancelled/errored/closed).
 */
export type SteerState = "queued" | "delivered" | "completed" | "dropped";

export interface SteerRecord {
  /** Also the SDK user message's `uuid`, which is how the CLI keys its lifecycle frames. */
  id: string;
  text: string;
  createdAt: string;
  state: SteerState;
  /**
   * True when the running turn's `result` boundary passed while this record was
   * still `queued`: the CLI will start it as its OWN follow-up turn rather than
   * folding it into the turn the viewer was watching. Set by
   * `noteResultBoundary`, reported to the client on `delivered`.
   */
  followUp: boolean;
}

/** `previous` is null when the record was just pushed (there was no prior state). */
export type SteerListener = (
  record: SteerRecord,
  change: { previous: SteerState | null },
) => void;

/**
 * How many accepted-but-undelivered steers a run will hold. A viewer typing
 * faster than the model can fold is normal; an unbounded queue is not — every
 * one of these is dumped into the model's context the moment it can take them.
 */
export const MAX_UNDELIVERED_STEERS = 10;

export class SteerChannel {
  private readonly all: SteerRecord[] = [];
  /** Accepted but not yet yielded to the SDK prompt generator (FIFO). */
  private readonly unsent: SteerRecord[] = [];
  private readonly listeners = new Set<SteerListener>();
  private waiter: ((record: SteerRecord | undefined) => void) | null = null;
  private isClosed = false;

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Accept a mid-turn message. Returns null once the channel is closed (the
   * turn is wrapping up, so nothing more can reach the model) — the route maps
   * that to a 410.
   */
  push(text: string): SteerRecord | null {
    if (this.isClosed) {
      return null;
    }
    const record: SteerRecord = {
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
      state: "queued",
      followUp: false,
    };
    this.all.push(record);
    this.unsent.push(record);
    this.notify(record, null);
    this.wake();
    return record;
  }

  /**
   * Take the next message for the SDK prompt generator, parking until one
   * arrives. Resolves `undefined` when the channel closes, or when `until`
   * settles (resolve OR reject) — the run loop passes its "held input released"
   * promise there, so the generator returns exactly when the SDK is done with
   * stdin.
   *
   * ONE consumer at a time: a second concurrent call replaces the parked
   * waiter, and the displaced one resolves `undefined`.
   */
  next(until?: Promise<unknown>): Promise<SteerRecord | undefined> {
    const ready = this.unsent.shift();
    if (ready) {
      return Promise.resolve(ready);
    }
    if (this.isClosed) {
      return Promise.resolve(undefined);
    }
    return new Promise<SteerRecord | undefined>((resolve) => {
      // A displaced waiter must still settle, or its generator parks forever.
      this.waiter?.(undefined);
      this.waiter = resolve;
      if (until) {
        const release = () => {
          if (this.waiter === resolve) {
            this.waiter = null;
            resolve(undefined);
          }
        };
        // Both settle paths release: a rejected gate is still a gate that is
        // gone, and swallowing it here keeps it from becoming an unhandled
        // rejection on a path that already reported the failure elsewhere.
        until.then(release, release);
      }
    });
  }

  /**
   * Fold a CLI `command_lifecycle` frame into the record it names. Unknown
   * uuids (anything the CLI queued that we did not push) are ignored.
   */
  noteLifecycle(commandUuid: string, state: string): SteerRecord | undefined {
    const record = this.all.find((entry) => entry.id === commandUuid);
    if (!record) {
      return undefined;
    }
    if (state === "started" && record.state === "queued") {
      this.transition(record, "delivered");
    } else if (
      state === "completed" &&
      (record.state === "delivered" || record.state === "queued")
    ) {
      // The queued→completed jump is defensive: a CLI that reports only the
      // terminal frame must still leave the record out of "undelivered".
      this.transition(record, "completed");
    } else if (state === "cancelled" && record.state === "queued") {
      this.transition(record, "dropped");
    }
    return record;
  }

  /**
   * A `result` boundary passed. Everything still queued now belongs to the
   * FOLLOW-UP turn the CLI starts next, not to the turn the viewer watched. No
   * notification — the flag is reported when the record goes `delivered`.
   */
  noteResultBoundary(): void {
    for (const record of this.all) {
      if (record.state === "queued") {
        record.followUp = true;
      }
    }
  }

  hasUndelivered(): boolean {
    return this.all.some((record) => record.state === "queued");
  }

  undelivered(): SteerRecord[] {
    return this.all.filter((record) => record.state === "queued");
  }

  records(): SteerRecord[] {
    return [...this.all];
  }

  /**
   * Close the channel: no further pushes, the parked consumer returns, and
   * every record that never reached the model is dropped. Idempotent, and the
   * dropped records are returned so the caller can report them. The run loop
   * closes at a task-free steer-free result boundary and again around the whole
   * attempt loop, so abort/error/normal-end all land here.
   */
  close(): SteerRecord[] {
    const dropped: SteerRecord[] = [];
    if (!this.isClosed) {
      this.isClosed = true;
      this.unsent.length = 0;
      for (const record of this.all) {
        if (record.state === "queued") {
          dropped.push(record);
        }
      }
    }
    this.wake();
    for (const record of dropped) {
      this.transition(record, "dropped");
    }
    return dropped;
  }

  /** Subscribe to every state change (including the push). Returns an unsubscribe. */
  onChange(listener: SteerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private transition(record: SteerRecord, next: SteerState): void {
    const previous = record.state;
    record.state = next;
    this.notify(record, previous);
  }

  private notify(record: SteerRecord, previous: SteerState | null): void {
    for (const listener of [...this.listeners]) {
      // A bad sink must never break the run loop it is observing.
      try {
        listener(record, { previous });
      } catch {
        /* ignore */
      }
    }
  }

  private wake(): void {
    const waiter = this.waiter;
    if (!waiter) {
      return;
    }
    this.waiter = null;
    waiter(this.unsent.shift());
  }
}

/**
 * The SDK user-message envelope for one steer. Yielding this from the held-open
 * prompt generator writes it to the CLI's stdin immediately; the CLI queues it
 * and reports its lifecycle keyed by this `uuid`. The shape is the VERIFIED
 * default one — do NOT add `origin`, `priority` or `shouldQuery`.
 */
export function steerToSdkUserMessage(
  record: SteerRecord,
): Record<string, unknown> {
  return {
    type: "user",
    parent_tool_use_id: null,
    uuid: record.id,
    message: {
      role: "user",
      content: [{ type: "text", text: record.text }],
    },
  };
}
