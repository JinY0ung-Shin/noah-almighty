// Team brain client state: the rail badge numbers (my unseen results; an
// admin's pending reviews) polled with the knowledge watch, plus a toast when
// either grows. The cards themselves read their own live state.
import { api } from "./api";
import { notify, readState, replaceState } from "./state";
import { goView } from "./nav";
import type { TeamBrainStatus } from "../../../shared/teamBrain";

let lastAnnounced: TeamBrainStatus = { unseenResults: 0, pendingReview: 0 };

export function teamBrainBadgeCount(status: TeamBrainStatus): number {
  return status.unseenResults + status.pendingReview;
}

export function teamBrainBadgeTitle(status: TeamBrainStatus): string {
  return [
    status.unseenResults ? `결과가 나온 내 제안 ${status.unseenResults}건` : "",
    status.pendingReview ? `검토 대기 제안 ${status.pendingReview}건` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// Cards on screen re-read themselves when a press on ANOTHER card changed
// what they show: 초안 모두 제출 sends several cards' drafts at once, and any
// submit / 취소 moves which card carries that button.
const cardListeners = new Set<() => void>();

/** Subscribe a mounted card; returns the unsubscribe. */
export function onTeamBrainCardsChanged(listener: () => void): () => void {
  cardListeners.add(listener);
  return () => {
    cardListeners.delete(listener);
  };
}

/** A press went through on the card that owns `self` — every OTHER card re-reads. */
export function teamBrainCardsChanged(self?: () => void): void {
  for (const listener of [...cardListeners]) {
    if (listener !== self) listener();
  }
}

let mountedTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A draft card appeared (a new card of this turn, a conversation just opened):
 * the other draft cards re-read once — which of them carries 초안 모두 제출, and
 * for how many, may have changed. Coalesced, so a conversation that opens with
 * several cards re-reads once.
 */
export function teamBrainDraftCardMounted(): void {
  if (mountedTimer) return;
  mountedTimer = setTimeout(() => {
    mountedTimer = null;
    teamBrainCardsChanged();
  }, 150);
}

export async function refreshTeamBrainStatus({ announce = false } = {}): Promise<void> {
  if (!readState().user) return;
  let status: TeamBrainStatus;
  try {
    status = await api<TeamBrainStatus>("/api/team-brain/status");
  } catch {
    return;
  }
  replaceState({ teamBrainStatus: status });
  if (announce) {
    const open = () => goView("teamBrain");
    if (status.unseenResults > lastAnnounced.unseenResults) {
      notify(`팀 브레인 제안 결과가 ${status.unseenResults}건 나왔어요.`, "info", { actionLabel: "확인", action: open });
    } else if (status.pendingReview > lastAnnounced.pendingReview) {
      notify(`검토를 기다리는 팀 브레인 제안이 ${status.pendingReview}건 있어요. 아바타에게 검토를 요청하세요.`, "info", {
        actionLabel: "목록 보기",
        action: open,
      });
    }
  }
  lastAnnounced = status;
}

export function resetTeamBrainClientState(): void {
  lastAnnounced = { unseenResults: 0, pendingReview: 0 };
  replaceState({ teamBrainStatus: { unseenResults: 0, pendingReview: 0 } });
}
