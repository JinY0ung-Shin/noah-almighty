// Pure helpers behind the messenger dock (DirectMessageDock.svelte). They live
// here — not in the component — because every one of them is a decision the dock
// makes on data it does not control (a mocked `/api/**` route that answers `{}`,
// a page that arrived out of order, a clock that crossed midnight) and those are
// exactly the branches worth unit-testing without a DOM.
import type { DirectMessage, DirectMessageInbox, DirectMessagePeer } from "../../../shared/directMessages";

export interface DirectMessageDay {
  /** Human separator text — "오늘" / "어제" / a full Korean date. */
  label: string;
  /** Local calendar day, `YYYY-MM-DD` (`invalid-<id>` for an unparseable
      timestamp). Stable, collision-free `{#each}` key. */
  key: string;
  messages: DirectMessage[];
}

const DEFAULT_WINDOW_MINUTES = 60;

function normalizePeer(raw: Partial<DirectMessagePeer>): DirectMessagePeer {
  return {
    id: String(raw.id),
    username: typeof raw.username === "string" ? raw.username : "",
    displayName: typeof raw.displayName === "string" && raw.displayName ? raw.displayName : String(raw.id),
    online: raw.online === true,
    available: raw.available !== false,
    unread: Number.isFinite(raw.unread) ? Math.max(0, Math.trunc(raw.unread as number)) : 0,
  };
}

/**
 * Coerce whatever `/api/dm` returned into a usable inbox. The dock renders on
 * every view including test fixtures where an unmocked `/api/**` route answers
 * `{}`, so a missing `peers` must become an empty list rather than a throw.
 */
export function normalizeInbox(raw: unknown): DirectMessageInbox {
  const source = (raw ?? {}) as Partial<DirectMessageInbox>;
  const peers = Array.isArray(source.peers)
    ? source.peers.filter((peer): peer is DirectMessagePeer => !!peer && typeof peer.id === "string" && !!peer.id).map(normalizePeer)
    : [];
  const unread = Number.isFinite(source.unread) ? Math.max(0, Math.trunc(source.unread as number)) : 0;
  const windowMinutes =
    Number.isFinite(source.windowMinutes) && (source.windowMinutes as number) > 0
      ? Math.trunc(source.windowMinutes as number)
      : DEFAULT_WINDOW_MINUTES;
  return { peers, unread, windowMinutes };
}

/**
 * Dedupe by id and sort ascending. Ids are monotonic per the server, so id order
 * IS arrival order — polling can hand us the same message twice (a poll landing
 * on top of a just-sent optimistic insert) and a gap fetch hands us an older
 * page after a newer one.
 */
export function mergeMessages(current: DirectMessage[], incoming: DirectMessage[]): DirectMessage[] {
  const byId = new Map<number, DirectMessage>();
  for (const message of [...(current ?? []), ...(incoming ?? [])]) {
    if (message && Number.isFinite(message.id)) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Send identifier the server accepts (`/^[a-zA-Z0-9_-]{16,80}$/`). Retained
 * across a retry by the caller: the same nonce cannot duplicate delivery, so a
 * network failure whose write actually landed replays instead of double-sending.
 */
export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    // No WebCrypto (a stripped test global): a nonce is a dedupe key, not a
    // secret, so a weaker source still satisfies the contract.
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Local calendar day — the unit a person means by "same day", not UTC. */
function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
}

export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const key = localDayKey(date);
  if (key === localDayKey(now)) return "오늘";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === localDayKey(yesterday)) return "어제";
  return date.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
}

/** Bubble timestamp: the day is already stated by the separator above it. */
export function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Split an ascending transcript into consecutive local-day runs. Consecutive —
 * not grouped-by-key — so the output preserves message order even if the input
 * ever interleaves days.
 */
export function groupByDay(messages: DirectMessage[], now: Date = new Date()): DirectMessageDay[] {
  const days: DirectMessageDay[] = [];
  for (const message of messages ?? []) {
    const date = new Date(message.createdAt);
    // These keys are {#each} keys, where a collision is a runtime crash. An
    // unparseable timestamp therefore falls back to the message's own id
    // instead of sharing one empty key with every other broken row.
    const key = Number.isNaN(date.getTime()) ? `invalid-${message.id}` : localDayKey(date);
    const last = days.at(-1);
    if (last && last.key === key) last.messages.push(message);
    else days.push({ key, label: dayLabel(message.createdAt, now), messages: [message] });
  }
  return days;
}
