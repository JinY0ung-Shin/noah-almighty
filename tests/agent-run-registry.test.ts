import type { Response } from "express";
import { describe, expect, it } from "vitest";
import {
  CANCELLED,
  attachRunClient,
  awaitResponse,
  cancelRun,
  closeRun,
  emitRunEvent,
  getRunPrompts,
  openRun,
  pushRunSteer,
} from "../src/server/agent/runRegistry.js";
import {
  MAX_UNDELIVERED_STEERS,
  SteerChannel,
  type SteerState,
} from "../src/server/agent/steerChannel.js";

/** Minimal SSE sink: records every chunk `writeSse` emits. */
function sseSink() {
  const chunks: string[] = [];
  const res = {
    writableEnded: false,
    write: (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    },
    on: () => res,
    end: () => res,
  } as unknown as Response;
  return { chunks, res };
}

describe("runRegistry: prompts that arrive after an abort", () => {
  it("resolves a post-abort prompt VISIBLY so the replay journal never strands a modal", async () => {
    const abort = new AbortController();
    openRun("ab-1", "u", { conversationId: "c-ab", abortController: abort });
    const live = sseSink();
    attachRunClient("ab-1", "u", live.res);

    // Deadline / stop button: the registry releases every parked prompt here.
    abort.abort();
    // The SDK's last hook fires AFTER the abort — chat.ts emits the frame first,
    // then parks. The prompt must resolve at once (no wait for closeRun) …
    emitRunEvent("ab-1", "question", { requestId: "late", payload: {} });
    await expect(awaitResponse("ab-1", "late")).resolves.toBe(CANCELLED);

    // … and its resolution must be a real frame, both for the attached viewer …
    const joined = live.chunks.join("");
    expect(joined).toContain('"requestId":"late"');
    expect(joined).toContain("event: prompt_resolved");
    // … and for anyone replaying the journal later (question, then resolution).
    const late = sseSink();
    attachRunClient("ab-1", "u", late.res, 0);
    const replayed = late.chunks.join("");
    expect(replayed.indexOf("event: question")).toBeGreaterThanOrEqual(0);
    expect(replayed.indexOf("event: question")).toBeLessThan(replayed.indexOf("event: prompt_resolved"));
    // Nothing is outstanding: the external task API's pendingRequests stay empty.
    expect(getRunPrompts("ab-1", "u")).toEqual([]);
    closeRun("ab-1");
  });

  it("treats cancelRun the same way for a run opened without an abort controller", async () => {
    openRun("ab-3", "u", { conversationId: "c-ab3" });
    const live = sseSink();
    attachRunClient("ab-3", "u", live.res);
    expect(cancelRun("ab-3", "u")).toBe(true);
    emitRunEvent("ab-3", "permission", { requestId: "late-perm" });
    await expect(awaitResponse("ab-3", "late-perm")).resolves.toBe(CANCELLED);
    expect(live.chunks.join("")).toContain("event: prompt_resolved");
    expect(getRunPrompts("ab-3", "u")).toEqual([]);
    closeRun("ab-3");
  });

  it("still resolves CANCELLED silently for a run that already ended", async () => {
    openRun("ab-2", "u", { conversationId: "c-ab2" });
    closeRun("ab-2");
    await expect(awaitResponse("ab-2", "gone")).resolves.toBe(CANCELLED);
  });
});

describe("runRegistry: mid-turn messages", () => {
  it("accepts a steer for a live run and refuses every other case by reason", () => {
    const channel = new SteerChannel();
    openRun("st-1", "u", { conversationId: "c-st1", steers: channel });

    const accepted = pushRunSteer("st-1", "u", "이것부터 해줘");
    expect(accepted).toEqual({ ok: true, steer: expect.objectContaining({ text: "이것부터 해줘", state: "queued" }) });
    expect(channel.undelivered()).toHaveLength(1);

    // Unknown run, and a run that belongs to someone else, are indistinguishable.
    expect(pushRunSteer("st-nope", "u", "x")).toEqual({ ok: false, reason: "not_found" });
    expect(pushRunSteer("st-1", "other", "x")).toEqual({ ok: false, reason: "not_found" });

    // A run with no channel at all (an external gateway avatar).
    openRun("st-ext", "u", { conversationId: "c-stext" });
    expect(pushRunSteer("st-ext", "u", "x")).toEqual({ ok: false, reason: "unsupported" });

    // Cap: MAX_UNDELIVERED_STEERS already waiting.
    for (let i = 1; i < MAX_UNDELIVERED_STEERS; i += 1) {
      expect(pushRunSteer("st-1", "u", `메시지 ${i}`).ok).toBe(true);
    }
    expect(pushRunSteer("st-1", "u", "하나 더")).toEqual({ ok: false, reason: "too_many" });
    // Delivering one frees a slot — the cap counts UNDELIVERED, not total.
    channel.noteLifecycle(channel.records()[0].id, "started");
    expect(pushRunSteer("st-1", "u", "자리 났음").ok).toBe(true);

    closeRun("st-1");
    closeRun("st-ext");
  });

  it("refuses a steer once the channel closed on its own, and after the run is stopped", () => {
    const drained = new SteerChannel();
    openRun("st-2", "u", { conversationId: "c-st2", steers: drained });
    drained.close();
    expect(pushRunSteer("st-2", "u", "늦었다")).toEqual({ ok: false, reason: "closed" });
    closeRun("st-2");

    openRun("st-3", "u", { conversationId: "c-st3", steers: new SteerChannel() });
    expect(cancelRun("st-3", "u")).toBe(true);
    expect(pushRunSteer("st-3", "u", "중지 후")).toEqual({ ok: false, reason: "closed" });
    closeRun("st-3");
  });

  it("cancelRun drops the queued steers at once, and the frames survive for a late viewer", () => {
    const channel = new SteerChannel();
    const seen: SteerState[] = [];
    openRun("st-4", "u", { conversationId: "c-st4", steers: channel });
    // The chat route's sink: one frame per state change.
    channel.onChange((record) => {
      seen.push(record.state);
      emitRunEvent("st-4", "steer", { steer: { id: record.id, state: record.state } });
    });
    const live = sseSink();
    attachRunClient("st-4", "u", live.res);

    const pushed = pushRunSteer("st-4", "u", "전달되지 못할 메시지");
    expect(pushed.ok).toBe(true);
    expect(cancelRun("st-4", "u")).toBe(true);

    // Dropped as part of the cancel, so the notice precedes the stop status.
    expect(seen).toEqual(["queued", "dropped"]);
    expect(channel.closed).toBe(true);
    const joined = live.chunks.join("");
    expect(joined.indexOf('"state":"queued"')).toBeLessThan(joined.indexOf('"state":"dropped"'));
    expect(joined.indexOf('"state":"dropped"')).toBeLessThan(joined.indexOf("응답을 중지하는 중"));

    // Journaled: a client attaching after the fact replays both states.
    const late = sseSink();
    attachRunClient("st-4", "u", late.res, 0);
    const replayed = late.chunks.join("");
    expect(replayed).toContain('"state":"queued"');
    expect(replayed).toContain('"state":"dropped"');
    closeRun("st-4");
  });

  it("closeRun drops queued steers BEFORE the run ends, so their frames still go out", () => {
    const channel = new SteerChannel();
    const seen: SteerState[] = [];
    openRun("st-5", "u", { conversationId: "c-st5", steers: channel });
    channel.onChange((record) => {
      seen.push(record.state);
      // emitRunEvent refuses an ENDED run, so a drop after `ended` would be
      // silently swallowed — this return value is the actual regression guard.
      expect(emitRunEvent("st-5", "steer", { steer: { id: record.id, state: record.state } })).toBe(true);
    });
    expect(pushRunSteer("st-5", "u", "마무리 중 도착").ok).toBe(true);

    closeRun("st-5");
    expect(seen).toEqual(["queued", "dropped"]);
    expect(channel.closed).toBe(true);
  });
});
