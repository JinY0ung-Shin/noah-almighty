// Paced reveal (lib/streamReveal.ts) and the reasoning clock (lib/streamThinking.ts).
// Pure logic on an injected clock — nothing here sleeps, and nothing needs a DOM.
import { describe, expect, it } from "vitest";
import {
  REVEAL_DRAIN_SECONDS,
  REVEAL_LAG_SECONDS,
  REVEAL_MAX_CATCH_UP,
  browserRevealClock,
  createRevealController,
  revealedAttachments,
  revealedText,
  snapReveal,
  type RevealClock,
} from "../src/client/src/lib/streamReveal.js";
import {
  formatThinkingDuration,
  noteThinking,
  resetThinkingClock,
  thinkingElapsedMs,
  thinkingTopic,
} from "../src/client/src/lib/streamThinking.js";

/** A clock the test drives: frames run only when `frame()` is called. */
function fakeClock() {
  let now = 1000;
  let nextHandle = 1;
  const pending = new Map<number, (time: number) => void>();
  const state = { reduced: false, hidden: false, framesRun: 0 };
  const clock: RevealClock = {
    now: () => now,
    request(callback) {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      pending.delete(handle);
    },
    reducedMotion: () => state.reduced,
    hidden: () => state.hidden,
  };
  return {
    clock,
    state,
    /** Let time pass without running frames. */
    wait(ms: number) {
      now += ms;
    },
    /** Advance `ms` and run the frames due (one batch, like one display refresh). */
    frame(ms = 16) {
      now += ms;
      const due = Array.from(pending.entries());
      pending.clear();
      for (const [, callback] of due) {
        state.framesRun += 1;
        callback(now);
      }
    },
    get scheduled() {
      return pending.size;
    },
  };
}

const SENTENCE = "스트리밍으로 도착하는 문장입니다. 한글과 English가 섞여 있고, 단어 중간에서 끊기지 않아야 합니다. ";

/** Feed `text` in bursts of `burst` chars every `everyMs`, running 16 ms frames in between; returns every shown count. */
function stream(fake: ReturnType<typeof fakeClock>, controller: ReturnType<typeof createRevealController>, key: string, text: string, burst: number, everyMs: number) {
  const seen: number[] = [];
  let arrived = "";
  for (let at = 0; at < text.length; at += burst) {
    arrived = text.slice(0, at + burst);
    controller.push(key, arrived);
    for (let t = 0; t < everyMs; t += 16) {
      fake.frame(16);
      seen.push(controller.peek(key) ?? arrived.length);
    }
  }
  return { seen, arrived };
}

describe("streamReveal: pacing", () => {
  it("reveals bursts evenly: small steps on frames, trailing the arrival, never past it", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    const text = SENTENCE.repeat(12);
    const { seen } = stream(fake, controller, "pane", text, 40, 200);
    // Never ahead of what arrived, never backwards.
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(Math.max(...seen)).toBeLessThanOrEqual(text.length);
    // Once the rate estimate has settled (200 cps here), a frame adds a few
    // characters — not the 40 of a burst.
    const steady = seen.slice(Math.floor(seen.length / 2));
    const steps = steady.slice(1).map((value, i) => value - steady[i]);
    expect(Math.max(...steps)).toBeLessThanOrEqual(24);
    expect(steps.filter((step) => step > 0).length).toBeGreaterThan(steps.length / 3);
    // …and stays roughly REVEAL_LAG_SECONDS of text behind the arrival.
    const rate = 40 / 0.2;
    const lagChars = text.length - steady[steady.length - 1];
    expect(lagChars).toBeGreaterThan(0);
    expect(lagChars).toBeLessThan(rate * REVEAL_LAG_SECONDS * 3);
  });

  it("catches up at no more than REVEAL_MAX_CATCH_UP times the arrival rate", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    const text = SENTENCE.repeat(20);
    // Establish ~100 cps, then drop a large backlog (under the replay threshold).
    for (let at = 20; at <= 400; at += 20) {
      controller.push("pane", text.slice(0, at));
      for (let t = 0; t < 200; t += 16) fake.frame(16);
    }
    controller.push("pane", text.slice(0, 1100));
    const before = controller.peek("pane") ?? 0;
    for (let i = 0; i < 30; i += 1) fake.frame(16); // 0.48 s
    const advanced = (controller.peek("pane") ?? 1100) - before;
    // The estimate after one big burst is still far below the burst itself;
    // 3× of it over 0.48 s cannot swallow the backlog in one go.
    expect(advanced).toBeGreaterThan(0);
    expect(advanced).toBeLessThan(700);
    expect(REVEAL_MAX_CATCH_UP).toBe(3);
  });

  it("snaps to word boundaries and never splits a surrogate pair", () => {
    expect(snapReveal("hello world again", 2)).toBe(5);
    expect(snapReveal("hello world again", 5)).toBe(5);
    expect(snapReveal("한글 단어입니다", 1)).toBe(2);
    expect(snapReveal("a".repeat(40), 3)).toBe(15); // no boundary within reach
    const emoji = "ab😀cd";
    expect(snapReveal(`${"x".repeat(12)}😀 tail`, 1)).not.toBe(13);
    for (let pos = 0; pos <= emoji.length; pos += 1) {
      const at = snapReveal(`${"x".repeat(20)}${emoji}`, 20 + pos - 12 < 0 ? 0 : 20 + pos - 12);
      const cut = `${"x".repeat(20)}${emoji}`.slice(0, at);
      expect(cut.charCodeAt(cut.length - 1) >= 0xd800 && cut.charCodeAt(cut.length - 1) <= 0xdbff).toBe(false);
    }
    expect(snapReveal("짧다", 99)).toBe(2);
  });

  it("paces each key by itself (split view)", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    controller.push("left", SENTENCE.repeat(4));
    fake.frame(16);
    fake.frame(16);
    controller.push("right", SENTENCE);
    fake.frame(16);
    const left = controller.peek("left")!;
    const right = controller.peek("right")!;
    expect(left).toBeGreaterThan(right);
    controller.flush("left");
    expect(controller.peek("left")).toBeUndefined();
    expect(controller.peek("right")).toBe(right);
    fake.frame(16);
    expect(controller.peek("right")!).toBeGreaterThan(right);
  });

  it("settles (no entry, no frame scheduled) once everything is shown", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    controller.push("pane", "짧은 답입니다.");
    for (let i = 0; i < 120 && controller.peek("pane") !== undefined; i += 1) fake.frame(16);
    expect(controller.peek("pane")).toBeUndefined();
    expect(fake.scheduled).toBe(0);
  });
});

describe("streamReveal: when it must not pace", () => {
  it("reduced motion: nothing is ever held back, and no frame is requested", () => {
    const fake = fakeClock();
    fake.state.reduced = true;
    const controller = createRevealController(fake.clock);
    const { seen } = stream(fake, controller, "pane", SENTENCE.repeat(3), 30, 100);
    expect(controller.peek("pane")).toBeUndefined();
    expect(fake.state.framesRun).toBe(0);
    expect(new Set(seen.map((value, i) => value >= 0 && i >= 0)).size).toBe(1);
  });

  it("reads reduced motion when a reveal STARTS, not per token", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    controller.push("pane", SENTENCE);
    fake.state.reduced = true; // changed mid-turn: this turn keeps pacing
    controller.push("pane", SENTENCE.repeat(2));
    expect(controller.peek("pane")).not.toBeUndefined();
    controller.reset("pane"); // next turn
    controller.push("pane", SENTENCE);
    expect(controller.peek("pane")).toBeUndefined();
  });

  it("a hidden tab never stalls the text: it goes straight through, and it is all there on return", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    controller.push("pane", SENTENCE);
    fake.frame(16);
    expect(controller.peek("pane")).not.toBeUndefined();
    // The tab goes to the background: no frame runs any more.
    fake.state.hidden = true;
    controller.flushAll();
    expect(controller.peek("pane")).toBeUndefined();
    for (let i = 2; i <= 6; i += 1) {
      fake.wait(300);
      controller.push("pane", SENTENCE.repeat(i));
      expect(controller.peek("pane")).toBeUndefined();
    }
    expect(fake.scheduled).toBe(0);
    // Back in front: new text is paced again, from where the text stands.
    fake.state.hidden = false;
    controller.push("pane", SENTENCE.repeat(7));
    expect(controller.peek("pane")).toBe(SENTENCE.repeat(6).length);
  });

  it("frames that stop coming (throttled, occluded) are abandoned on the next arrival", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    controller.push("pane", SENTENCE);
    fake.frame(16);
    const held = controller.peek("pane");
    expect(held).not.toBeUndefined();
    fake.wait(900); // text keeps arriving, but no frame ran
    controller.push("pane", SENTENCE.repeat(2));
    expect(controller.peek("pane")).toBeUndefined();
  });

  it("no clock (node, SSR): pushes are ignored and everything shows", () => {
    expect(browserRevealClock()).toBeNull();
    const controller = createRevealController(null);
    controller.push("pane", SENTENCE);
    expect(controller.peek("pane")).toBeUndefined();
    expect(controller.handoff("pane", "m:1", SENTENCE)).toBe(false);
  });

  it("a replayed log (a huge backlog at once) skips to near its end instead of typing it out", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    const text = SENTENCE.repeat(80);
    controller.push("pane", text);
    fake.frame(16);
    expect(controller.peek("pane")!).toBeGreaterThan(text.length - 400);
  });
});

describe("streamReveal: flush, reset, handoff", () => {
  it("flush shows everything now and paces what comes after", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    controller.push("pane", SENTENCE);
    fake.frame(16);
    controller.flush("pane"); // a card arrived / a mid-turn message was delivered
    expect(controller.peek("pane")).toBeUndefined();
    controller.push("pane", SENTENCE + SENTENCE);
    expect(controller.peek("pane")).toBe(SENTENCE.length); // holds exactly what was on screen
  });

  it("reset (fold, stop, error) drops the entry, and the next text starts from nothing", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    controller.push("pane", SENTENCE.repeat(3));
    fake.frame(16);
    controller.reset("pane");
    expect(controller.peek("pane")).toBeUndefined();
    expect(fake.scheduled).toBe(0);
    controller.push("pane", "새 블록의 첫 조각입니다. 이어서 더 옵니다.");
    expect(controller.peek("pane")).toBe(0);
  });

  it("text that is not a continuation (a fold nobody announced) restarts by itself", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    controller.push("pane", SENTENCE.repeat(3));
    for (let i = 0; i < 10; i += 1) fake.frame(16);
    expect(controller.peek("pane")!).toBeGreaterThan(20);
    controller.push("pane", "완전히 다른 글이 시작됩니다.");
    expect(controller.peek("pane")).toBe(0);
  });

  it("handoff drains the remainder on the stored message within REVEAL_DRAIN_SECONDS", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    const text = SENTENCE.repeat(6);
    controller.push("pane", text);
    for (let i = 0; i < 5; i += 1) fake.frame(16);
    const onScreen = controller.peek("pane")!;
    expect(onScreen).toBeLessThan(text.length);
    expect(controller.handoff("pane", "m:1", text)).toBe(true);
    // The live key is gone at once; the message starts exactly where the bubble stood.
    expect(controller.peek("pane")).toBeUndefined();
    expect(controller.peek("m:1")).toBe(onScreen);
    let frames = 0;
    while (controller.peek("m:1") !== undefined && frames < 200) {
      fake.frame(16);
      frames += 1;
    }
    expect(controller.peek("m:1")).toBeUndefined();
    expect(frames * 16).toBeLessThanOrEqual(REVEAL_DRAIN_SECONDS * 1000 + 32);
    expect(fake.scheduled).toBe(0);
  });

  it("handoff with nothing left, a different text, or reduced motion shows the message whole", () => {
    const fake = fakeClock();
    const controller = createRevealController(fake.clock);
    controller.push("a", "끝났다.");
    controller.flush("a");
    expect(controller.handoff("a", "m:a", "끝났다.")).toBe(false);
    controller.push("b", SENTENCE.repeat(3));
    for (let i = 0; i < 6; i += 1) fake.frame(16);
    expect(controller.handoff("b", "m:b", "서버가 저장한 글은 다르다")).toBe(false);
    expect(controller.peek("m:b")).toBeUndefined();
    expect(controller.peek("b")).toBeUndefined();
  });
});

describe("streamReveal: what the bubble shows", () => {
  it("revealedText clamps and passes the whole text through when nothing is held", () => {
    expect(revealedText("가나다라", undefined)).toBe("가나다라");
    expect(revealedText("가나다라", 2)).toBe("가나");
    expect(revealedText("가나다라", 99)).toBe("가나다라");
    expect(revealedText("가나다라", -3)).toBe("");
  });

  it("a card anchored at N waits until N characters are shown", () => {
    const cards = [
      { id: "a", anchor: 5 },
      { id: "b", anchor: 20 },
      { id: "legacy" },
    ];
    expect(revealedAttachments(cards, 30, undefined)).toBe(cards);
    expect(revealedAttachments(cards, 30, 30)).toBe(cards);
    expect(revealedAttachments(cards, 30, 4)!.map((c) => c.id)).toEqual([]);
    expect(revealedAttachments(cards, 30, 5)!.map((c) => c.id)).toEqual(["a"]);
    expect(revealedAttachments(cards, 30, 19)!.map((c) => c.id)).toEqual(["a"]);
    expect(revealedAttachments(cards, 30, 20)!.map((c) => c.id)).toEqual(["a", "b"]);
    expect(revealedAttachments(undefined, 30, 3)).toBeUndefined();
  });
});

describe("streamThinking", () => {
  it("sums the intervals a pane spent reasoning", () => {
    resetThinkingClock("p");
    noteThinking("p", true, 1_000);
    noteThinking("p", true, 1_500); // still reasoning: no restart
    expect(thinkingElapsedMs("p", 4_000)).toBe(3_000);
    noteThinking("p", false, 5_000); // answer text / a tool
    noteThinking("p", false, 9_000);
    expect(thinkingElapsedMs("p", 60_000)).toBe(4_000);
    noteThinking("p", true, 10_000);
    expect(thinkingElapsedMs("p", 12_500)).toBe(6_500);
    resetThinkingClock("p");
    expect(thinkingElapsedMs("p", 99_000)).toBe(0);
    noteThinking("p", false, 99_000); // nothing to stop
    expect(thinkingElapsedMs("p")).toBe(0);
  });

  it("formats a duration, and says nothing under a second", () => {
    expect(formatThinkingDuration(undefined)).toBe("");
    expect(formatThinkingDuration(999)).toBe("");
    expect(formatThinkingDuration(1_000)).toBe("1초");
    expect(formatThinkingDuration(59_900)).toBe("59초");
    expect(formatThinkingDuration(60_000)).toBe("1분");
    expect(formatThinkingDuration(125_000)).toBe("2분 5초");
  });

  it("finds the current sub-heading: the last line that is only **…**", () => {
    expect(thinkingTopic("")).toBeNull();
    expect(thinkingTopic("그냥 생각하는 중이다.\n**굵은** 낱말이 있는 줄")).toBeNull();
    const text = "**요구사항 정리**\n\n먼저 무엇을 볼지 정한다.\n\n**구현 방식 비교**\n\n두 가지가 있다.";
    expect(thinkingTopic(text)).toBe("구현 방식 비교");
    // A heading still being written is not one yet.
    expect(thinkingTopic(`${text}\n\n**검증 계`)).toBe("구현 방식 비교");
    expect(thinkingTopic(`${text}\n\n**검증 계획**`)).toBe("검증 계획");
    expect(thinkingTopic("**Planning the fix:**\nbody")).toBe("Planning the fix:");
  });
});
