// The messenger dock's pure decisions (src/client/src/lib/directMessages.ts).
// Each of these is a branch the dock takes on data it does not control — a
// mocked route answering `{}`, a page that arrived out of order, a transcript
// that crossed midnight — so they are pinned here without a DOM.
import { describe, expect, it } from "vitest";

import {
  dayLabel,
  groupByDay,
  makeNonce,
  mergeMessages,
  normalizeInbox,
  timeLabel,
} from "../src/client/src/lib/directMessages.js";
import type { DirectMessage } from "../src/shared/directMessages.js";

/** The exact regex the server validates a send identifier against. */
const NONCE = /^[a-zA-Z0-9_-]{16,80}$/;

function message(id: number, createdAt: string, text = `m${id}`): DirectMessage {
  return { id, senderId: "peer", recipientId: "me", text, createdAt };
}

/** Local-noon ISO for an offset in days from now — never straddles a day edge. */
function localNoon(dayOffset: number): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 12, 0, 0).toISOString();
}

describe("normalizeInbox", () => {
  it("turns an empty body into an empty inbox instead of throwing", () => {
    // Other Playwright specs answer every unmocked /api/** with `{}`, and the
    // dock mounts on every view — so this IS a production path, not a nicety.
    expect(normalizeInbox({})).toEqual({ peers: [], unread: 0, windowMinutes: 60 });
    expect(normalizeInbox(null)).toEqual({ peers: [], unread: 0, windowMinutes: 60 });
    expect(normalizeInbox({ peers: "nope", unread: "2", windowMinutes: 0 })).toEqual({
      peers: [],
      unread: 0,
      windowMinutes: 60,
    });
  });

  it("keeps a real payload and coerces per-peer fields", () => {
    const inbox = normalizeInbox({
      unread: 3,
      windowMinutes: 45,
      peers: [
        { id: "p1", username: "minji", displayName: "이민지", online: true, available: true, unread: 2 },
        { id: "p2", username: "other", displayName: "다른 사용자" },
        { id: "", username: "ghost", displayName: "빈 아이디" },
      ],
    });

    expect(inbox.unread).toBe(3);
    expect(inbox.windowMinutes).toBe(45);
    // The id-less row is dropped: it could never be addressed anyway.
    expect(inbox.peers.map((peer) => peer.id)).toEqual(["p1", "p2"]);
    expect(inbox.peers[0]).toEqual({
      id: "p1",
      username: "minji",
      displayName: "이민지",
      online: true,
      available: true,
      unread: 2,
    });
    // Missing flags default to offline-but-reachable, never "이용 정지".
    expect(inbox.peers[1]).toMatchObject({ online: false, available: true, unread: 0 });
  });
});

describe("mergeMessages", () => {
  it("dedupes by id and sorts ascending", () => {
    const merged = mergeMessages(
      [message(3, localNoon(0)), message(1, localNoon(0))],
      [message(2, localNoon(0)), message(1, localNoon(0), "재수신")],
    );

    expect(merged.map((item) => item.id)).toEqual([1, 2, 3]);
    // Last writer wins: a re-poll of the same id carries the fresher row.
    expect(merged[0].text).toBe("재수신");
  });

  it("tolerates missing sides and junk rows", () => {
    expect(mergeMessages([], [])).toEqual([]);
    expect(
      mergeMessages([message(1, localNoon(0))], undefined as unknown as DirectMessage[]),
    ).toHaveLength(1);
    expect(mergeMessages([], [null as unknown as DirectMessage])).toEqual([]);
  });
});

describe("makeNonce", () => {
  it("matches the server's send-identifier regex and differs across calls", () => {
    const first = makeNonce();
    const second = makeNonce();

    expect(first).toMatch(NONCE);
    expect(first).toHaveLength(32);
    expect(second).toMatch(NONCE);
    expect(second).not.toBe(first);
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 8, 10, 15, 0, 0);

  it("names today and yesterday, and dates anything older", () => {
    expect(dayLabel(new Date(2026, 8, 10, 1, 0, 0).toISOString(), now)).toBe("오늘");
    expect(dayLabel(new Date(2026, 8, 9, 23, 30, 0).toISOString(), now)).toBe("어제");

    const older = new Date(2026, 8, 8, 9, 0, 0);
    expect(dayLabel(older.toISOString(), now)).toBe(
      older.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" }),
    );
  });

  it("crosses a month boundary as a calendar day, not a 24h window", () => {
    const firstOfMonth = new Date(2026, 8, 1, 10, 0, 0);
    expect(dayLabel(new Date(2026, 7, 31, 22, 0, 0).toISOString(), firstOfMonth)).toBe("어제");
  });

  it("returns an empty label for an unparseable timestamp", () => {
    expect(dayLabel("not-a-date", now)).toBe("");
    expect(timeLabel("not-a-date")).toBe("");
  });
});

describe("timeLabel", () => {
  it("states the clock time only — the day comes from the separator above", () => {
    const at = new Date(2026, 8, 10, 14, 5, 0);
    expect(timeLabel(at.toISOString())).toBe(
      at.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
    );
    expect(timeLabel(at.toISOString())).toContain("05");
  });
});

describe("groupByDay", () => {
  it("splits on the local calendar day and keeps message order", () => {
    const days = groupByDay([
      message(1, localNoon(-2)),
      message(2, localNoon(-1)),
      message(3, localNoon(-1)),
      message(4, localNoon(0)),
    ]);

    expect(days).toHaveLength(3);
    expect(days.map((day) => day.messages.map((item) => item.id))).toEqual([[1], [2, 3], [4]]);
    expect(days.at(-1)?.label).toBe("오늘");
    expect(days[1].label).toBe("어제");
    expect(new Set(days.map((day) => day.key)).size).toBe(3);
  });

  it("keeps two messages minutes apart across midnight in different groups", () => {
    const now = new Date(2026, 8, 10, 12, 0, 0);
    const days = groupByDay(
      [
        message(1, new Date(2026, 8, 9, 23, 55, 0).toISOString()),
        message(2, new Date(2026, 8, 10, 0, 5, 0).toISOString()),
      ],
      now,
    );

    expect(days.map((day) => day.label)).toEqual(["어제", "오늘"]);
  });

  it("returns nothing for an empty or missing transcript", () => {
    expect(groupByDay([])).toEqual([]);
    expect(groupByDay(undefined as unknown as DirectMessage[])).toEqual([]);
  });

  it("gives every group a unique key even when a timestamp is unparseable", () => {
    // The keys are {#each} keys: a collision is a runtime crash, not a glitch.
    const days = groupByDay([
      message(1, "not-a-date"),
      message(2, localNoon(0)),
      message(3, "also-not-a-date"),
    ]);

    expect(new Set(days.map((day) => day.key)).size).toBe(days.length);
  });
});
