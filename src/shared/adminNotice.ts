// 관리자 공지 — the ONE notice an admin shows at the top of every teammate's
// screen. Shared by the server (validation, storage) and the client (the bar,
// the admin card), so the levels and the length limit have one home.
//
// A notice is PLAIN TEXT for people: it is never rendered as markup and never
// reaches the avatar's prompt.

/** Importance, lowest first. The bar's colour AND its label follow it. */
export const ADMIN_NOTICE_LEVELS = ["info", "warn", "urgent"] as const;
export type AdminNoticeLevel = (typeof ADMIN_NOTICE_LEVELS)[number];

/** User-facing label of each level (shown in the bar and in the admin card). */
export const ADMIN_NOTICE_LEVEL_LABELS: Record<AdminNoticeLevel, string> = {
  info: "안내",
  warn: "주의",
  urgent: "긴급",
};

/** Longest notice text, counted after {@link normalizeAdminNoticeText}. */
export const ADMIN_NOTICE_MAX_LENGTH = 300;

/** What a teammate's browser gets: the notice in force. */
export interface AdminNotice {
  /** Minted on every save — a dismissal names the id, so a changed notice shows again. */
  id: string;
  text: string;
  level: AdminNoticeLevel;
}

/** What the admin card gets: the stored notice, shown or not. */
export interface AdminNoticeSetting extends AdminNotice {
  enabled: boolean;
  updatedAt: string;
}

export function isAdminNoticeLevel(value: unknown): value is AdminNoticeLevel {
  return typeof value === "string" && (ADMIN_NOTICE_LEVELS as readonly string[]).includes(value);
}

/** One paragraph: every run of whitespace (line breaks included) becomes one space. */
export function normalizeAdminNoticeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
