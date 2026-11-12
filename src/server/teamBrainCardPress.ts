// Team brain — telling the avatar that a card's button was pressed.
//
// A card tool only DRAFTS a row and returns at once, so by the time the user
// presses 관리자에게 제출 / 팀 브레인에 반영 / … the turn that drafted the card is
// usually over and the avatar would learn of the press only by looking. Instead
// the press route records a REPORT here, and the presser's chat hands it to the
// avatar straight away: as a turn of its own (POST /api/chat/stream with
// `teamBrainCardPress`), or — while an answer is still streaming — as a
// mid-turn message on the running run (POST /api/chat/runs/:runId/message).
//
// The report is the SERVER's word. Both routes take only a proposal id from the
// client and look the report up here, so nothing a browser sends can make the
// avatar believe a press that did not happen, or a different outcome: no
// recorded press, no report. Each press is told at most once: a route TAKES the
// report in the same tick it looked it up (two requests can never both carry
// it) and puts it back (`restore`) only if it did not reach the avatar.
//
// Process memory on purpose: a report is news for a few seconds after a press.
// One lost to a restart costs nothing the avatar could not always do — look
// (`list_team_proposals`, `get_note`). Bounded in count and in time.
// 취소 / 제안 철회 is never recorded (a cancelled card is not news to act on).

import {
  TEAM_BRAIN_CARD_PRESS_MARK,
  teamBrainCardButtonLabel,
  teamBrainCardPressBubble,
  type TeamBrainCardPressAction,
  type TeamBrainProposal,
} from "../shared/teamBrain.js";

/** A report nobody collected is dropped after this long. */
export const TEAM_BRAIN_CARD_PRESS_TTL_MS = 10 * 60 * 1000;
/** Reports kept at once (the oldest goes first). */
export const MAX_TEAM_BRAIN_CARD_PRESSES = 200;

export interface TeamBrainCardPressReport {
  proposalId: string;
  /** The presser — the card's own drafter (only they can press it). */
  userId: string;
  action: TeamBrainCardPressAction;
  ok: boolean;
  /** What the model receives (English, starts with TEAM_BRAIN_CARD_PRESS_MARK). */
  agentText: string;
  /** What the chat shows and stores as the presser's turn (Korean). */
  displayText: string;
}

/** The latest uncollected press report per (presser, card). */
export class TeamBrainCardPressLog {
  /** Insertion order = oldest first (a re-press re-inserts its key at the end). */
  private readonly reports = new Map<string, { report: TeamBrainCardPressReport; at: number }>();

  constructor(private readonly clock: () => number = Date.now) {}

  private key(userId: string, proposalId: string): string {
    return `${userId}\n${proposalId}`;
  }

  /** Record a press. A later press of the same card replaces the earlier report (the latest outcome is the news). */
  put(report: TeamBrainCardPressReport): void {
    const now = this.clock();
    for (const [key, entry] of this.reports) {
      if (now - entry.at < TEAM_BRAIN_CARD_PRESS_TTL_MS) break;
      this.reports.delete(key);
    }
    const key = this.key(report.userId, report.proposalId);
    this.reports.delete(key);
    this.reports.set(key, { report, at: now });
    while (this.reports.size > MAX_TEAM_BRAIN_CARD_PRESSES) {
      this.reports.delete(this.reports.keys().next().value as string);
    }
  }

  /** The waiting report, left in place (a turn that may still be refused looks first). */
  peek(userId: string, proposalId: string): TeamBrainCardPressReport | null {
    const key = this.key(userId, proposalId);
    const entry = this.reports.get(key);
    if (!entry) return null;
    if (this.clock() - entry.at >= TEAM_BRAIN_CARD_PRESS_TTL_MS) {
      this.reports.delete(key);
      return null;
    }
    return entry.report;
  }

  /** The waiting report, removed: it is on its way to the avatar. */
  take(userId: string, proposalId: string): TeamBrainCardPressReport | null {
    const report = this.peek(userId, proposalId);
    if (report) this.reports.delete(this.key(userId, proposalId));
    return report;
  }

  /**
   * Put a taken report back: it did not reach the avatar after all (the turn
   * was refused before it opened, the mid-turn message was dropped). A newer
   * press of the same card that is already waiting wins — it is the news now.
   */
  restore(report: TeamBrainCardPressReport): void {
    if (!this.peek(report.userId, report.proposalId)) this.put(report);
  }

  /** Everything about a deleted user's presses. */
  forgetUser(userId: string): void {
    for (const [key, entry] of this.reports) {
      if (entry.report.userId === userId) this.reports.delete(key);
    }
  }
}

const HEADER = `${TEAM_BRAIN_CARD_PRESS_MARK} — Noah's own report of a button the user just pressed on a card you drafted. The user did not type this message; it states what the press did.]`;

const TITLE_MAX = 120;

/** A card title as one quoted line (it is avatar-drafted text shown on the card). */
function quoted(title: string): string {
  const oneLine = title.replace(/\s+/g, " ").trim().replace(/"/g, "'");
  return `"${oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX)}…` : oneLine}"`;
}

/**
 * How the report names the card. A review card's title is the SUBMISSION's —
 * a teammate's text — so a review is named by ids only (the avatar drafted the
 * decision and knows the submission by its id).
 */
function cardRef(card: TeamBrainProposal): string {
  if (card.kind === "review") {
    return `your ${card.decision ?? "review"} decision card (draft ${card.id}) on submission ${card.targetId ?? "?"}`;
  }
  const what = card.kind === "policy" ? "team-policy" : card.kind === "direct" ? "team-brain change" : "team-brain submission";
  return `the ${what} card ${quoted(card.title)} (draft ${card.id})`;
}

function pagesText(card: TeamBrainProposal): string {
  const changes = card.changeset?.changes ?? [];
  if (changes.length === 0) return "no pages";
  return changes.map((c) => `${c.path} (${c.op})`).join(", ");
}

function doneText(action: TeamBrainCardPressAction, card: TeamBrainProposal): string {
  const notes = card.personalNotes.map((n) => n.path).join(", ");
  if (action === "submit") {
    return [
      "DONE: the source is now in the admins' review queue (status pending). Nothing is in the team brain yet — an admin's avatar compiles it and the admin approves it, asks for more information or rejects it; the user sees the result on the card and as a badge.",
      ...(notes ? [`Linked personal note(s): ${notes} — unchanged; they are marked only once an admin approves the submission.`] : []),
      "What to do now: tell the user, in one or two sentences, that it is with the admins (not shared yet), then carry on with anything that was waiting on this press. Do not submit it again.",
    ].join("\n");
  }
  if (card.kind === "policy") {
    return [
      "DONE: POLICY.md is committed. Its settings are in force now; new guidelines ride conversations started after this (this conversation keeps its instructions).",
      "What to do now: carry on with what was waiting on this press, or, if nothing was, confirm in one or two sentences. Do not draft this change again.",
    ].join("\n");
  }
  if (card.kind === "review") {
    const done =
      card.decision === "approve"
        ? `DONE: submission ${card.targetId ?? "?"} is approved — its source (${card.path}) and ${pagesText(card)} are committed to the team brain. The proposer sees the approval on their card and as a badge.`
        : card.decision === "ask"
          ? `DONE: the questions went to the proposer — submission ${card.targetId ?? "?"} is now needs_info and comes back to the queue when they answer.`
          : `DONE: submission ${card.targetId ?? "?"} is rejected; the proposer sees the reason on their card.`;
    return [
      done,
      "What to do now: if you were working through the review queue, go on to the next pending submission (mcp__brain__list_team_proposals); otherwise confirm in one or two sentences. Do not draft this decision again.",
    ].join("\n");
  }
  return [
    `DONE: committed to the team brain — ${card.path ? `the new source ${card.path} and ` : ""}${pagesText(card)}.`,
    ...(notes
      ? [
          `Linked personal note(s): ${notes} — none of them was changed; for each, the team page is now the canonical version. Follow PROMOTED NOTES in the Brain policy (ask the user, with all five points, before rewriting one).`,
        ]
      : []),
    "What to do now: carry on with what was waiting on this press — the step you said would follow, the next card of a batch — or, if nothing was, confirm in one or two sentences. Do not draft this change again.",
  ].join("\n");
}

const FAILED_FALLBACK = "Noah refused the press and gave no further reason; the card shows the user why.";

/**
 * The report of ONE press: the English text the avatar reads and the Korean
 * bubble the presser's conversation keeps. `card` is the row the button sits on
 * (its title, pages and links do not change with the press); a failed press
 * carries the action's own agent-facing reason (`TeamBrainActionResult.agent`).
 */
export function composeTeamBrainCardPress(input: {
  action: TeamBrainCardPressAction;
  card: TeamBrainProposal;
  outcome: { ok: true } | { ok: false; agent?: string };
}): Pick<TeamBrainCardPressReport, "agentText" | "displayText"> {
  const { action, card, outcome } = input;
  const pressed = `The user pressed "${teamBrainCardButtonLabel(action, card)}" on ${cardRef(card)}.`;
  const result = outcome.ok
    ? doneText(action, card)
    : [
        `FAILED — this press changed nothing. ${outcome.agent?.trim() || FAILED_FALLBACK}`,
        "What to do now: tell the user plainly that the press did not go through and why. If the reason names a fix that is yours, do it now; if it is the user's, say what they need to do.",
      ].join("\n");
  return {
    agentText: `${HEADER}\n${pressed}\n${result}`,
    displayText: teamBrainCardPressBubble(action, card, outcome.ok),
  };
}
