// Date groups for the rail's conversation list: 오늘 / 어제 / 지난 7일 / 지난 30일 /
// 그 이전, by LAST ACTIVITY in the viewer's local time. Pure on purpose — the
// grouping is a function of (conversations, now), so the rail only has to hand it
// a fresh `now` when the local date changes (see `msUntilNextLocalDay`).

export type ConversationGroupId = "today" | "yesterday" | "week" | "month" | "older";

export interface ConversationGroup<T> {
  id: ConversationGroupId;
  /** The heading the rail shows (user-facing, Korean). */
  label: string;
  items: T[];
}

export const CONVERSATION_GROUP_LABELS: Record<ConversationGroupId, string> = {
  today: "오늘",
  yesterday: "어제",
  week: "지난 7일",
  month: "지난 30일",
  older: "그 이전",
};

const GROUP_ORDER: ConversationGroupId[] = ["today", "yesterday", "week", "month", "older"];

function toMs(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}

/**
 * Local midnight `daysAgo` calendar days before the day `now` falls in. Built
 * from calendar fields, never by subtracting 24 h: a DST day is 23 or 25 hours
 * long, and a fixed step would move the boundary off midnight.
 */
export function localDayStart(now: Date | number = Date.now(), daysAgo = 0): number {
  const d = new Date(toMs(now));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo).getTime();
}

/** Milliseconds from `now` to the next local midnight (always > 0). */
export function msUntilNextLocalDay(now: Date | number = Date.now()): number {
  const ms = toMs(now);
  return Math.max(1, localDayStart(ms, -1) - ms);
}

/** Which group a last-activity timestamp falls in, as seen at `now`. */
export function conversationGroupId(
  updatedAt: string | null | undefined,
  now: Date | number = Date.now(),
): ConversationGroupId {
  const at = updatedAt ? new Date(updatedAt).getTime() : Number.NaN;
  // An unreadable timestamp has no "recent" claim.
  if (Number.isNaN(at)) return "older";
  // A timestamp ahead of this clock (skew between server and viewer) is today.
  if (at >= localDayStart(now)) return "today";
  if (at >= localDayStart(now, 1)) return "yesterday";
  if (at >= localDayStart(now, 7)) return "week";
  if (at >= localDayStart(now, 30)) return "month";
  return "older";
}

/**
 * Split a conversation list into its date groups. The order INSIDE a group is
 * the input's order (the list arrives newest-first and stays that way), the
 * groups come out newest-first, and a group with nothing in it is left out.
 */
export function groupConversationsByDate<T extends { updatedAt?: string | null }>(
  conversations: readonly T[],
  now: Date | number = Date.now(),
): ConversationGroup<T>[] {
  const nowMs = toMs(now);
  const buckets = new Map<ConversationGroupId, T[]>();
  for (const conversation of conversations) {
    const id = conversationGroupId(conversation.updatedAt, nowMs);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(conversation);
    else buckets.set(id, [conversation]);
  }
  const groups: ConversationGroup<T>[] = [];
  for (const id of GROUP_ORDER) {
    const items = buckets.get(id);
    if (items?.length) groups.push({ id, label: CONVERSATION_GROUP_LABELS[id], items });
  }
  return groups;
}
