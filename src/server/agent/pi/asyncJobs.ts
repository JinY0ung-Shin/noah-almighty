/**
 * Background work a pi run's tools started (design D8): a Noah tool that would
 * otherwise hold pi's broker call for minutes — `mcp__avatars__ask_avatar` in
 * an interactive chat — returns an acceptance id at once and runs here.
 *
 * Delivery reuses the steer path: a finished job pushes its result into the
 * run's SteerChannel (model-facing English text + the Korean bubble the chat
 * shows), and runPiAgent turns undelivered steers into ONE follow-up turn after
 * the current pi response. The runner keeps the run OPEN while jobs are pending
 * (`waitForChange`), so a result always finds a live run; when the run ends
 * anyway (cancel, error) every pending job is aborted and nothing is delivered.
 */
import { randomUUID } from "node:crypto";
import logger from "../../logger.js";
import type { SteerSource } from "../steerChannel.js";

const log = logger.child({ module: "agent", component: "pi-async" });

export interface PiAsyncDelivery {
  /** What the model reads (English, with provenance). */
  agentText: string;
  /** What the chat shows and persists as the row (Korean). */
  displayText: string;
  /**
   * Who the result comes from. The row is persisted as THEIRS
   * (`kind: "consultation"`), so a history rebuild never re-feeds it as the
   * owner's own words.
   */
  source: SteerSource;
}

export class PiAsyncJobs {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private listeners = new Set<() => void>();

  /** `deliver` returns false when the run could not take the result (its steer channel closed). */
  constructor(private readonly deliver: (delivery: PiAsyncDelivery) => boolean) {}

  /** Number of jobs still running. */
  get pending(): number {
    return this.jobs.size;
  }

  /** True once the run ended and its jobs were aborted. */
  get aborted(): boolean {
    return this.abort.signal.aborted;
  }

  /**
   * Start one job; returns its id (`<kind>-<8 hex>`). `run` gets the run-scoped
   * signal and resolves with what to deliver, or null for nothing.
   */
  start(kind: string, run: (signal: AbortSignal) => Promise<PiAsyncDelivery | null>): string {
    const id = `${kind}-${randomUUID().slice(0, 8)}`;
    const job = (async () => {
      try {
        const delivery = await run(this.abort.signal);
        if (!delivery || this.abort.signal.aborted) return;
        if (!this.deliver(delivery)) {
          log.warn({ id }, "pi async job finished after its run stopped taking messages; result dropped");
        }
      } catch (error) {
        log.warn({ id, err: String(error) }, "pi async job failed");
      } finally {
        this.jobs.delete(id);
        for (const listener of [...this.listeners]) listener();
      }
    })();
    this.jobs.set(id, job);
    return id;
  }

  /** Resolves when any job settles, `signal` aborts, or `capMs` passes. */
  waitForChange(signal: AbortSignal | undefined, capMs: number): Promise<void> {
    if (this.jobs.size === 0 || signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        this.listeners.delete(done);
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, capMs);
      timer.unref?.();
      this.listeners.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** The run ended: abort every pending job (their results are never delivered). */
  abortAll(): void {
    this.abort.abort();
  }
}
