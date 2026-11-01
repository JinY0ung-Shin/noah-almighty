/**
 * Inbound MID-TURN user messages ("steers") for one live chat run.
 *
 * While the avatar is streaming, the viewer can send another message. It is
 * folded INTO the running answer (design P2): `pi/eventAdapter.ts`'s
 * `runPiTurn` hands each queued record to the live pi response, which delivers
 * it at its next tool boundary (`response.input_consumed`). A record pi did
 * not deliver before the response ended stays queued, and the run loop
 * (`pi/runPiAgent.ts`) sends every such record TOGETHER as ONE follow-up turn
 * of the same run (the chat route's `turn_end` contract). Background-job
 * results ride the same queue (`pi/asyncJobs.ts`).
 *
 * This class is the queue + the state machine between the route and the loop:
 *
 *   route  --push()-->  [queued]  --undelivered()-->  live pi response | follow-up turn
 *   run loop  --noteLifecycle()-->  listeners --> SSE
 *
 * A record the model never received (the run was cancelled, errored, or
 * wrapped up first) ends as `dropped` and is never persisted to history.
 *
 * Deliberately dependency-free (only `node:crypto`): it is unit-tested on its
 * own and is consumed from both the run loop and the HTTP route.
 */

import { randomUUID } from "node:crypto";

/**
 * Lifecycle of one mid-turn message.
 *  - `queued`    accepted by the server, not yet handed to the model.
 *  - `delivered` the model received it: pi folded it into the running turn,
 *                or the run loop sent it as the follow-up turn's input.
 *  - `completed` the run's answer covering it finished (informational).
 *  - `dropped`   it never reached the model (run cancelled/errored/closed).
 */
export type SteerState = "queued" | "delivered" | "completed" | "dropped";

/** Who a machine-delivered record comes from (see {@link SteerRecord.source}). */
export interface SteerSource {
  kind: "consultation";
  /** The background job id the model was given. */
  id: string;
  username?: string;
  displayName?: string;
}

export interface SteerRecord {
  /** The record's id (lifecycle updates and the client's SSE key). */
  id: string;
  /** What the model receives. */
  text: string;
  /**
   * What the chat shows and persists, when it differs from `text` — a pi run's
   * asynchronous tool result (`pi/asyncJobs.ts`): English with provenance for
   * the model, a Korean bubble for the user. Absent for a typed message.
   */
  displayText?: string;
  /**
   * Set when NOAH pushed the record, not the viewer: a consulted teammate
   * avatar's answer (`pi/asyncJobs.ts`). Persisted as a `kind: "consultation"`
   * row carrying this source — never as the viewer's own message — and never
   * handed back to the composer when it is dropped.
   */
  source?: SteerSource;
  createdAt: string;
  state: SteerState;
  /**
   * True when the running answer's boundary passed while this record was still
   * `queued`: it starts its OWN follow-up turn instead of joining the running
   * one. Set by `noteResultBoundary`, reported to the client on `delivered`.
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
  private readonly listeners = new Set<SteerListener>();
  private isClosed = false;

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Accept a mid-turn message. Returns null once the channel is closed (the
   * turn is wrapping up, so nothing more can reach the model) — the route maps
   * that to a 410.
   */
  push(text: string, options: { displayText?: string; source?: SteerSource } = {}): SteerRecord | null {
    if (this.isClosed) {
      return null;
    }
    const record: SteerRecord = {
      id: randomUUID(),
      text,
      ...(options.displayText !== undefined ? { displayText: options.displayText } : {}),
      ...(options.source ? { source: options.source } : {}),
      createdAt: new Date().toISOString(),
      state: "queued",
      followUp: false,
    };
    this.all.push(record);
    this.notify(record, null);
    return record;
  }

  /**
   * Move the record it names along its lifecycle: `started` (sent to the
   * model), `completed` (answered) or `cancelled`. Unknown ids are ignored.
   */
  noteLifecycle(id: string, state: string): SteerRecord | undefined {
    const record = this.all.find((entry) => entry.id === id);
    if (!record) {
      return undefined;
    }
    if (state === "started" && record.state === "queued") {
      this.transition(record, "delivered");
    } else if (
      state === "completed" &&
      (record.state === "delivered" || record.state === "queued")
    ) {
      // The queued→completed jump is defensive: a record reported only as
      // answered must still leave "undelivered".
      this.transition(record, "completed");
    } else if (state === "cancelled" && record.state === "queued") {
      this.transition(record, "dropped");
    }
    return record;
  }

  /**
   * An answer boundary passed. Everything still queued now belongs to the
   * FOLLOW-UP turn the run starts next, not to the turn the viewer watched. No
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
   * Close the channel: no further pushes, and every record that never reached
   * the model is dropped. Idempotent, and the dropped records are returned so
   * the caller can report them. The run loop closes at a steer-free answer
   * boundary and again in its `finally`, so abort/error/normal-end all land here.
   */
  close(): SteerRecord[] {
    const dropped: SteerRecord[] = [];
    if (!this.isClosed) {
      this.isClosed = true;
      for (const record of this.all) {
        if (record.state === "queued") {
          dropped.push(record);
        }
      }
    }
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
}
