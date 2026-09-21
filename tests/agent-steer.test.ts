import { describe, expect, it, vi } from "vitest";
import {
  MAX_UNDELIVERED_STEERS,
  SteerChannel,
  steerToSdkUserMessage,
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

describe("SteerChannel: accepting and handing over messages", () => {
  it("returns a queued record and hands it to a LATER next() in FIFO order", async () => {
    const channel = new SteerChannel();
    const first = channel.push("첫 메시지")!;
    const second = channel.push("둘째 메시지")!;

    expect(first.state).toBe("queued");
    expect(first.followUp).toBe(false);
    expect(first.text).toBe("첫 메시지");
    expect(first.id).not.toBe(second.id);
    expect(Date.parse(first.createdAt)).not.toBeNaN();

    await expect(channel.next()).resolves.toBe(first);
    await expect(channel.next()).resolves.toBe(second);
    // records() keeps BOTH — taking one for the SDK is not a delivery.
    expect(channel.records().map((r) => r.text)).toEqual(["첫 메시지", "둘째 메시지"]);
    expect(channel.undelivered()).toHaveLength(2);
  });

  it("wakes a parked next() when a message arrives", async () => {
    const channel = new SteerChannel();
    const parked = channel.next();
    let settled = false;
    void parked.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);

    const pushed = channel.push("나중에 온 메시지")!;
    await expect(parked).resolves.toBe(pushed);
  });

  it("releases a parked next() when `until` settles, either way, and clears the waiter", async () => {
    const resolved = new SteerChannel();
    await expect(resolved.next(Promise.resolve())).resolves.toBeUndefined();
    // Not closed by the release — the run loop owns closing.
    expect(resolved.closed).toBe(false);
    // A message pushed afterwards is still takeable.
    const later = resolved.push("이어서")!;
    await expect(resolved.next()).resolves.toBe(later);

    const rejected = new SteerChannel();
    await expect(rejected.next(Promise.reject(new Error("aborted")))).resolves.toBeUndefined();
    expect(rejected.closed).toBe(false);
  });

  it("prefers a ready message over an already-settled `until`", async () => {
    const channel = new SteerChannel();
    const pushed = channel.push("먼저 대기 중")!;
    await expect(channel.next(Promise.resolve())).resolves.toBe(pushed);
  });

  it("settles a displaced waiter when a second consumer parks (one consumer at a time)", async () => {
    const channel = new SteerChannel();
    const first = channel.next();
    const second = channel.next();
    await expect(first).resolves.toBeUndefined();
    const pushed = channel.push("두번째 소비자에게")!;
    await expect(second).resolves.toBe(pushed);
  });

  it("refuses a push once closed and resolves next() immediately", async () => {
    const channel = new SteerChannel();
    channel.close();
    expect(channel.closed).toBe(true);
    expect(channel.push("늦은 메시지")).toBeNull();
    await expect(channel.next()).resolves.toBeUndefined();
  });
});

describe("SteerChannel: CLI lifecycle frames", () => {
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
    // Both were already handed to the SDK; only `kept` came back as started.
    await channel.next();
    await channel.next();
    channel.noteLifecycle(kept.id, "started");
    const parked = channel.next();
    const seen = recorder(channel);

    const dropped = channel.close();
    expect(dropped).toEqual([gone]);
    expect(gone.state).toBe("dropped");
    expect(kept.state).toBe("delivered");
    expect(channel.closed).toBe(true);
    // The parked consumer is released so its generator can return.
    await expect(parked).resolves.toBeUndefined();
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

describe("steerToSdkUserMessage", () => {
  it("builds the VERIFIED default SDK user-message shape, keyed by the record id", () => {
    const record: SteerRecord = {
      id: "11111111-2222-3333-4444-555555555555",
      text: "대신 이걸 먼저 해줘",
      createdAt: new Date().toISOString(),
      state: "queued",
      followUp: false,
    };
    const message = steerToSdkUserMessage(record);

    expect(message).toEqual({
      type: "user",
      parent_tool_use_id: null,
      uuid: record.id,
      message: {
        role: "user",
        content: [{ type: "text", text: "대신 이걸 먼저 해줘" }],
      },
    });
    // The uuid IS how the CLI keys its command_lifecycle frames back to us.
    expect(message.uuid).toBe(record.id);
    // Fields the live spike showed are NOT part of the verified shape: adding
    // any of them changes how the CLI schedules the message.
    expect(message).not.toHaveProperty("origin");
    expect(message).not.toHaveProperty("priority");
    expect(message).not.toHaveProperty("shouldQuery");
  });

  it("carries exactly one text block", () => {
    const channel = new SteerChannel();
    const record = channel.push("한 덩어리")!;
    const content = (
      steerToSdkUserMessage(record).message as { content: unknown[] }
    ).content;
    expect(content).toHaveLength(1);
  });
});

describe("SteerChannel: listener isolation from the consumer", () => {
  it("emits `queued` before the message is taken for the SDK", async () => {
    const channel = new SteerChannel();
    const order: string[] = [];
    channel.onChange((record) => order.push(`notify:${record.state}`));
    const taken = vi.fn();
    const parked = channel.next().then((record) => {
      order.push("taken");
      taken(record);
    });

    const pushed = channel.push("순서 확인")!;
    await parked;
    expect(order).toEqual(["notify:queued", "taken"]);
    expect(taken).toHaveBeenCalledWith(pushed);
  });
});
