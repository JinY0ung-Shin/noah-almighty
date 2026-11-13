// 관리자 공지 — the client half: the notice in force for this account
// (`state.adminNotice`, drawn by components/NoticeBar.tsx at the top of every
// screen). The SERVER decides what is in force (shown, and not closed by this
// account); this module only fetches it on the once-a-minute tick and records
// a close.
import { api } from "./api";
import { readState, replaceState } from "./state";
import type { AdminNotice } from "../../../shared/adminNotice";

// The id this session closed. An answer fetched BEFORE the close was recorded
// can land after it and would bring the bar back; the server's own record
// covers every later load.
let closedId = "";

function apply(notice: AdminNotice | null): void {
  const next = notice && notice.id !== closedId ? notice : null;
  const current = readState().adminNotice;
  if ((current?.id ?? "") === (next?.id ?? "")) return;
  replaceState({ adminNotice: next });
}

/** Best-effort: a failed poll (or a server from before the feature) keeps what is shown. */
export async function refreshAdminNotice(): Promise<void> {
  if (!readState().user) return;
  try {
    const { notice } = await api<{ notice: AdminNotice | null }>("/api/me/notice");
    if (!readState().user) return;
    apply(notice ?? null);
  } catch {
    /* keep what is shown; the next tick retries */
  }
}

/**
 * Close the notice for this account. The bar goes at once; if the record
 * fails it stays closed for this session and returns on the next load.
 */
export async function dismissAdminNotice(id: string): Promise<void> {
  closedId = id;
  apply(null);
  try {
    const { notice } = await api<{ notice: AdminNotice | null }>("/api/me/notice/dismiss", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    // The admin may have saved a NEW notice meanwhile: the answer carries it.
    if (readState().user) apply(notice ?? null);
  } catch {
    /* closed for this session only */
  }
}

/** Logout / session expiry: the next account starts clean. */
export function resetAdminNoticeClientState(): void {
  closedId = "";
  if (readState().adminNotice) replaceState({ adminNotice: null });
}
