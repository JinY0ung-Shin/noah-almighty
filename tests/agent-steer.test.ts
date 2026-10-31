import { describe, expect, it, vi } from "vitest";
import {
  MAX_UNDELIVERED_STEERS,
  SteerChannel,
  type SteerRecord,
  type SteerState,
} from "../src/server/agent/steerChannel.js";

/** Record every (state, previous) pair a channel reports, in order. */
function recorder(channel: SteerChannel) {
  const seen: { id: string; state: SteerState; previous: SteerState | null }[] = [];
  channel.onChange((record, change) => {
    seen.push({ id: record.id, state: record.state, previous: change.previous });
  });
  return seen;
}

describe("SteerChannel: accepting messages", () => {
  it("returns queued records in acceptance order and keeps them until the run delivers them", () => {
    const channel = new SteerChannel();
    const first = channel.push("첫 메시지")!;
    const second = channel.push("둘째 메시지", { displayText: "표시용" })!;

    expect(first.state).toBe("queued");
    expect(first.followUp).toBe(false);
    expect(first.text).toBe("첫 메시지");
    expect(second.displayText).toBe("표시용");
    expect(first.id).not.toBe(second.id);
    expect(Date.parse(first.createdAt)).not.toBeNaN();
    expect(channel.records().map((r) => r.text)).toEqual(["첫 메시지", "둘째 메시지"]);
    expect(channel.undelivered()).toEqual([first, second]);
    expect(channel.hasUndelivered()).toBe(true);
  });

  it("carries a machine-delivered record's source", () => {
    const channel = new SteerChannel();
    const record = channel.push("answer", { source: { kind: "consultation", id: "ask-1", username: "kim" } })!;
    expect(record.source).toEqual({ kind: "consultation", id: "ask-1", username: "kim" });
  });

  it("refuses a push once closed", () => {
    const channel = new SteerChannel();
    channel.close();
    expect(channel.closed).toBe(true);
    expect(channel.push("늦은 메시지")).toBeNull();
    expect(channel.hasUndelivered()).toBe(false);
  });
});

describe("SteerChannel: lifecycle updates", () => {
  it("moves queued → delivered on `started` and notifies once", () => {
    const channel = new SteerChannel();
    const seen = recorder(channel);
    const record = channel.push("지금 이걸로 바꿔줘")!;

    expect(channel.noteLifecycle(record.id, "started")).toBe(record);
    expect(record.state).toBe("delivered");
    expect(channel.hasUndelivered()).toBe(false);
    expect(channel.undelivered()).toEqual([]);
    expect(seen).toEqual([
      { id: record.id, state: "queued", previous: null },
      { id: record.id, state: "delivered", previous: "queued" },
    ]);
  });

  it("ignores an unknown uuid and the informational `queued` frame", () => {
    const channel = new SteerChannel();
    const record = channel.push("메시지")!;
    const seen = recorder(channel);

    expect(channel.noteLifecycle("not-ours", "started")).toBeUndefined();
    expect(channel.noteLifecycle(record.id, "queued")).toBe(record);
    expect(record.state).toBe("queued");
    expect(seen).toEqual([]);
  });

  it("completes from delivered AND defensively from queued, then ignores repeats", () => {
    const channel = new SteerChannel();
    const folded = channel.push("접힌 메시지")!;
    const jumped = channel.push("건너뛴 메시지")!;
    channel.noteLifecycle(folded.id, "started");
    const seen = recorder(channel);

    channel.noteLifecycle(folded.id, "completed");
    expect(folded.state).toBe("completed");
    // A CLI that reports only the terminal frame must still leave the record
    // out of "undelivered" — otherwise the run would hold its input open.
    channel.noteLifecycle(jumped.id, "completed");
    expect(jumped.state).toBe("completed");
    expect(channel.hasUndelivered()).toBe(false);

    // Repeats are no-ops: no state change, no extra notification.
    channel.noteLifecycle(folded.id, "completed");
    channel.noteLifecycle(folded.id, "started");
    expect(seen).toEqual([
      { id: folded.id, state: "completed", previous: "delivered" },
      { id: jumped.id, state: "completed", previous: "queued" },
    ]);
  });

  it("drops a queued record on `cancelled` but never one the model already got", () => {
    const channel = new SteerChannel();
    const waiting = channel.push("아직 대기")!;
    const arrived = channel.push("이미 전달")!;
    channel.noteLifecycle(arrived.id, "started");
    const seen = recorder(channel);

    channel.noteLifecycle(waiting.id, "cancelled");
    channel.noteLifecycle(arrived.id, "cancelled");
    expect(waiting.state).toBe("dropped");
    expect(arrived.state).toBe("delivered");
    expect(seen).toEqual([{ id: waiting.id, state: "dropped", previous: "queued" }]);
  });

  it("ignores an unrecognized lifecycle state without touching the record", () => {
    const channel = new SteerChannel();
    const record = channel.push("메시지")!;
    expect(channel.noteLifecycle(record.id, "reticulating")).toBe(record);
    expect(record.state).toBe("queued");
  });
});

describe("SteerChannel: result boundaries and close", () => {
  it("marks only the still-queued records as follow-ups, silently", () => {
    const channel = new SteerChannel();
    const delivered = channel.push("턴 안에서 전달됨")!;
    const pending = channel.push("경계를 못 넘음")!;
    channel.noteLifecycle(delivered.id, "started");
    const seen = recorder(channel);

    channel.noteResultBoundary();
    expect(delivered.followUp).toBe(false);
    expect(pending.followUp).toBe(true);
    // No notification of its own — followUp is reported on `delivered`.
    expect(seen).toEqual([]);

    channel.noteLifecycle(pending.id, "started");
    expect(seen).toEqual([{ id: pending.id, state: "delivered", previous: "queued" }]);
    expect(pending.followUp).toBe(true);
  });

  it("drops every undelivered record on close, returns them, and is idempotent", async () => {
    const channel = new SteerChannel();
    const gone = channel.push("전달 못 함")!;
    const kept = channel.push("전달됨")!;
    // Only `kept` was sent to the model.
    channel.noteLifecycle(kept.id, "started");
    const seen = recorder(channel);

    const dropped = channel.close();
    expect(dropped).toEqual([gone]);
    expect(gone.state).toBe("dropped");
    expect(kept.state).toBe("delivered");
    expect(channel.closed).toBe(true);
    expect(seen).toEqual([{ id: gone.id, state: "dropped", previous: "queued" }]);

    // Second close: nothing left to drop, nothing re-notified.
    expect(channel.close()).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("keeps the run alive when a listener throws, and stops notifying after unsubscribe", () => {
    const channel = new SteerChannel();
    const good: SteerState[] = [];
    channel.onChange(() => {
      throw new Error("bad sink");
    });
    const unsubscribe = channel.onChange((record) => good.push(record.state));

    const record = channel.push("메시지")!;
    expect(() => channel.noteLifecycle(record.id, "started")).not.toThrow();
    expect(good).toEqual(["queued", "delivered"]);

    unsubscribe();
    channel.noteLifecycle(record.id, "completed");
    expect(good).toEqual(["queued", "delivered"]);
  });

  it("exposes the cap the route enforces", () => {
    expect(MAX_UNDELIVERED_STEERS).toBe(10);
    const channel = new SteerChannel();
    for (let i = 0; i < MAX_UNDELIVERED_STEERS; i += 1) {
      channel.push(`메시지 ${i}`);
    }
    expect(channel.undelivered()).toHaveLength(MAX_UNDELIVERED_STEERS);
    // The channel itself does NOT enforce it — pushRunSteer does, so the route
    // can answer with its own status instead of a bare null.
    expect(channel.push("하나 더")).not.toBeNull();
  });
});
