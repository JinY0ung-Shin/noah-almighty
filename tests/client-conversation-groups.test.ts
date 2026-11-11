// Date groups of the rail's conversation list (lib/conversationGroups.ts): a pure
// function of (conversations, now) in the viewer's LOCAL time.
import { describe, expect, it } from "vitest";

import {
  CONVERSATION_GROUP_LABELS,
  conversationGroupId,
  groupConversationsByDate,
  localDayStart,
  msUntilNextLocalDay,
} from "../src/client/src/lib/conversationGroups.js";

// Built from LOCAL calendar fields, so the assertions hold in any TZ the suite runs in.
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
const iso = (y: number, m: number, d: number, h = 12, min = 0) => at(y, m, d, h, min).toISOString();
const NOW = at(2026, 11, 11, 15, 30);

function conv(id: string, updatedAt: string) {
  return { id, updatedAt };
}

describe("conversationGroupId", () => {
  it("draws every boundary at a local midnight", () => {
    expect(conversationGroupId(iso(2026, 11, 11, 0, 0), NOW)).toBe("today");
    expect(conversationGroupId(iso(2026, 11, 10, 23, 59), NOW)).toBe("yesterday");
    expect(conversationGroupId(iso(2026, 11, 10, 0, 0), NOW)).toBe("yesterday");
    expect(conversationGroupId(iso(2026, 11, 9, 23, 59), NOW)).toBe("week");
    expect(conversationGroupId(iso(2026, 11, 4, 0, 0), NOW)).toBe("week");
    expect(conversationGroupId(iso(2026, 11, 3, 23, 59), NOW)).toBe("month");
    expect(conversationGroupId(iso(2026, 10, 12, 0, 0), NOW)).toBe("month");
    expect(conversationGroupId(iso(2026, 10, 11, 23, 59), NOW)).toBe("older");
    expect(conversationGroupId(iso(2025, 1, 1), NOW)).toBe("older");
  });

  it("puts a timestamp ahead of this clock in 오늘 and an unreadable one in 그 이전", () => {
    expect(conversationGroupId(iso(2026, 11, 12, 9), NOW)).toBe("today");
    expect(conversationGroupId("not a date", NOW)).toBe("older");
    expect(conversationGroupId("", NOW)).toBe("older");
    expect(conversationGroupId(null, NOW)).toBe("older");
  });

  it("accepts now as a Date or as epoch milliseconds", () => {
    expect(conversationGroupId(iso(2026, 11, 10, 8), NOW.getTime())).toBe("yesterday");
  });
});

describe("groupConversationsByDate", () => {
  it("labels the groups in Korean, newest first, and leaves empty ones out", () => {
    const groups = groupConversationsByDate(
      [
        conv("a", iso(2026, 11, 11, 9)),
        conv("b", iso(2026, 11, 6)),
        conv("c", iso(2026, 1, 2)),
      ],
      NOW,
    );
    expect(groups.map((group) => [group.id, group.label])).toEqual([
      ["today", "오늘"],
      ["week", "지난 7일"],
      ["older", "그 이전"],
    ]);
    expect(Object.values(CONVERSATION_GROUP_LABELS)).toEqual(["오늘", "어제", "지난 7일", "지난 30일", "그 이전"]);
  });

  it("keeps the list's own order inside a group, even when it is not sorted by time", () => {
    const groups = groupConversationsByDate(
      [
        conv("early", iso(2026, 11, 11, 1)),
        conv("old", iso(2026, 9, 1)),
        conv("late", iso(2026, 11, 11, 14)),
        conv("mid", iso(2026, 11, 11, 7)),
        conv("yday", iso(2026, 11, 10, 7)),
      ],
      NOW,
    );
    expect(groups.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ["today", ["early", "late", "mid"]],
      ["yesterday", ["yday"]],
      ["older", ["old"]],
    ]);
  });

  it("returns no groups for an empty list", () => {
    expect(groupConversationsByDate([], NOW)).toEqual([]);
  });

  it("regroups the SAME list when now crosses midnight", () => {
    const list = [conv("a", iso(2026, 11, 11, 23, 50)), conv("b", iso(2026, 11, 10, 23, 50))];
    const before = groupConversationsByDate(list, at(2026, 11, 11, 23, 59));
    const after = groupConversationsByDate(list, at(2026, 11, 12, 0, 1));
    expect(before.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ["today", ["a"]],
      ["yesterday", ["b"]],
    ]);
    expect(after.map((group) => [group.id, group.items.map((item) => item.id)])).toEqual([
      ["yesterday", ["a"]],
      ["week", ["b"]],
    ]);
  });
});

describe("local day helpers", () => {
  it("localDayStart is the local midnight of now's day, and steps by calendar days", () => {
    expect(localDayStart(NOW)).toBe(at(2026, 11, 11, 0, 0).getTime());
    expect(localDayStart(NOW, 1)).toBe(at(2026, 11, 10, 0, 0).getTime());
    // Across a month boundary.
    expect(localDayStart(at(2026, 3, 1, 8), 1)).toBe(at(2026, 2, 28, 0, 0).getTime());
  });

  it("msUntilNextLocalDay lands exactly on the next local midnight", () => {
    const now = at(2026, 11, 11, 23, 59);
    expect(now.getTime() + msUntilNextLocalDay(now)).toBe(at(2026, 11, 12, 0, 0).getTime());
    // At midnight itself the NEXT one is a whole day away, never 0.
    const midnight = at(2026, 11, 12, 0, 0);
    expect(midnight.getTime() + msUntilNextLocalDay(midnight)).toBe(at(2026, 11, 13, 0, 0).getTime());
  });
});
