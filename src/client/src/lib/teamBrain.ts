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
    const open = () => {
      replaceState({ brainOpenTeamTab: true });
      goView("brain");
    };
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
  replaceState({ teamBrainStatus: { unseenResults: 0, pendingReview: 0 }, brainOpenTeamTab: false });
}
