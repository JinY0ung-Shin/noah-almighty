import { describe, expect, it } from "vitest";
import {
  MAX_TEAM_BRAIN_CARD_PRESSES,
  TEAM_BRAIN_CARD_PRESS_TTL_MS,
  TeamBrainCardPressLog,
  composeTeamBrainCardPress,
  type TeamBrainCardPressReport,
} from "../src/server/teamBrainCardPress.js";
import {
  TEAM_BRAIN_CARD_PRESS_ACTIONS,
  TEAM_BRAIN_CARD_PRESS_MARK,
  teamBrainCardButtonLabel,
  teamBrainCardPressBubble,
  type TeamBrainLiveKind,
  type TeamBrainProposal,
} from "../src/shared/teamBrain.js";

type LiveCard = TeamBrainProposal & { kind: TeamBrainLiveKind };

function card(extra: Partial<LiveCard> = {}): LiveCard {
  return {
    id: "card-1",
    kind: "direct",
    status: "draft",
    proposerUserId: "u1",
    proposerName: "mate",
    conversationId: "conv-1",
    path: "raw/2026/11/2026-11-11-card0001.md",
    op: "create",
    title: "배포 절차",
    summary: "",
    content: "",
    baseBlob: null,
    intake: null,
    changeset: {
      changes: [
        { path: "wiki/howto/deploy.md", op: "create", content: "x", baseBlob: null },
        { path: "wiki/systems/compose.md", op: "update", content: "y", baseBlob: "b1" },
      ],
      conflicts: [],
    },
    personalNotes: [],
    targetId: null,
    decision: null,
    decisionReason: null,
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    ...extra,
  };
}

function report(extra: Partial<TeamBrainCardPressReport> = {}): TeamBrainCardPressReport {
  return { proposalId: "card-1", userId: "u1", action: "apply", ok: true, agentText: "agent", displayText: "bubble", ...extra };
}

describe("TeamBrainCardPressLog", () => {
  it("hands a report over once, to its presser only", () => {
    const log = new TeamBrainCardPressLog();
    log.put(report());
    expect(log.peek("u2", "card-1")).toBeNull();
    expect(log.peek("u1", "other-card")).toBeNull();
    // A look leaves it waiting (the turn may still be refused)…
    expect(log.peek("u1", "card-1")?.agentText).toBe("agent");
    expect(log.peek("u1", "card-1")).not.toBeNull();
    // …a take does not.
    expect(log.take("u1", "card-1")?.displayText).toBe("bubble");
    expect(log.take("u1", "card-1")).toBeNull();
    expect(log.peek("u1", "card-1")).toBeNull();
  });

  it("keeps only the latest press of a card", () => {
    const log = new TeamBrainCardPressLog();
    log.put(report({ ok: false, agentText: "failed" }));
    log.put(report({ ok: true, agentText: "done" }));
    expect(log.take("u1", "card-1")).toMatchObject({ ok: true, agentText: "done" });
    expect(log.take("u1", "card-1")).toBeNull();
  });

  it("a taken report that did not reach the avatar waits again — unless a newer press replaced it", () => {
    const log = new TeamBrainCardPressLog();
    log.put(report({ agentText: "first" }));
    const taken = log.take("u1", "card-1")!;
    expect(log.peek("u1", "card-1")).toBeNull();
    log.restore(taken);
    expect(log.take("u1", "card-1")?.agentText).toBe("first");
    // Pressed again while the first report was out: the newer one is the news.
    log.put(report({ agentText: "second" }));
    log.restore(taken);
    expect(log.take("u1", "card-1")?.agentText).toBe("second");
    expect(log.take("u1", "card-1")).toBeNull();
  });

  it("drops a report nobody collected after the TTL", () => {
    let now = 1_000;
    const log = new TeamBrainCardPressLog(() => now);
    log.put(report());
    now += TEAM_BRAIN_CARD_PRESS_TTL_MS - 1;
    expect(log.peek("u1", "card-1")).not.toBeNull();
    now += 1;
    expect(log.peek("u1", "card-1")).toBeNull();
    expect(log.take("u1", "card-1")).toBeNull();
  });

  it("is bounded: the oldest report goes first", () => {
    const log = new TeamBrainCardPressLog();
    for (let i = 0; i <= MAX_TEAM_BRAIN_CARD_PRESSES; i++) log.put(report({ proposalId: `card-${i}` }));
    expect(log.peek("u1", "card-0")).toBeNull();
    expect(log.peek("u1", "card-1")).not.toBeNull();
    expect(log.peek("u1", `card-${MAX_TEAM_BRAIN_CARD_PRESSES}`)).not.toBeNull();
  });

  it("forgets a deleted user's reports", () => {
    const log = new TeamBrainCardPressLog();
    log.put(report());
    log.put(report({ userId: "u2" }));
    log.forgetUser("u1");
    expect(log.peek("u1", "card-1")).toBeNull();
    expect(log.peek("u2", "card-1")).not.toBeNull();
  });
});

describe("composeTeamBrainCardPress", () => {
  it("a direct apply: names the button, the card, what was committed and what to do next", () => {
    const { agentText, displayText } = composeTeamBrainCardPress({ card: card(), outcome: { ok: true } });
    expect(agentText.startsWith(TEAM_BRAIN_CARD_PRESS_MARK)).toBe(true);
    expect(agentText).toContain("The user did not type this message");
    expect(agentText).toContain('The user pressed "팀 브레인에 반영" on the team-brain change card "배포 절차" (draft card-1).');
    expect(agentText).toContain(
      "DONE: committed to the team brain — the new source raw/2026/11/2026-11-11-card0001.md and wiki/howto/deploy.md (create), wiki/systems/compose.md (update).",
    );
    expect(agentText).toContain("Do not draft this change again.");
    expect(agentText).not.toContain("Linked personal note");
    expect(displayText).toBe("팀 브레인에 반영했습니다: 배포 절차");
  });

  it("a maintenance apply has no source; linked personal notes point at PROMOTED NOTES", () => {
    const { agentText } = composeTeamBrainCardPress({
      card: card({ path: "", personalNotes: [{ path: "wiki/concepts/deploy.md", blob: "b" }] }),
      outcome: { ok: true },
    });
    expect(agentText).toContain("DONE: committed to the team brain — wiki/howto/deploy.md (create)");
    expect(agentText).not.toContain("the new source");
    expect(agentText).toContain("Linked personal note(s): wiki/concepts/deploy.md — none of them was changed");
    expect(agentText).toContain("PROMOTED NOTES in the Brain policy");
  });

  it("a policy apply", () => {
    const { agentText, displayText } = composeTeamBrainCardPress({
      card: card({ kind: "policy", path: "POLICY.md", changeset: null, title: "검토 주기 12개월" }),
      outcome: { ok: true },
    });
    expect(agentText).toContain('The user pressed "팀 정책 반영" on the team-policy card "검토 주기 12개월" (draft card-1).');
    expect(agentText).toContain("DONE: POLICY.md is committed.");
    expect(displayText).toBe("팀 정책 변경을 반영했습니다: 검토 주기 12개월");
  });

  it("a refused press carries the action's reason and says nothing changed", () => {
    const { agentText, displayText } = composeTeamBrainCardPress({
      card: card(),
      outcome: { ok: false, agent: "The team brain changed after this card was drafted (wiki/howto/deploy.md)." },
    });
    expect(agentText.startsWith(TEAM_BRAIN_CARD_PRESS_MARK)).toBe(true);
    expect(agentText).toContain("FAILED — this press changed nothing. The team brain changed after this card was drafted (wiki/howto/deploy.md).");
    expect(agentText).toContain("If the reason names a fix that is yours, do it now");
    expect(agentText).not.toContain("DONE");
    expect(displayText).toBe("카드의 ‘팀 브레인에 반영’ 버튼을 눌렀지만 처리되지 않았습니다.");
    // No reason from the action still makes a report.
    const bare = composeTeamBrainCardPress({ card: card({ kind: "policy" }), outcome: { ok: false } });
    expect(bare.agentText).toContain("FAILED — this press changed nothing. Noah refused the press");
    expect(bare.displayText).toBe("카드의 ‘팀 정책 반영’ 버튼을 눌렀지만 처리되지 않았습니다.");
  });

  it("keeps a quoted title on one line", () => {
    const { agentText, displayText } = composeTeamBrainCardPress({
      card: card({ title: `줄\n바꿈 "따옴표" ${"가".repeat(200)}` }),
      outcome: { ok: true },
    });
    const pressed = agentText.split("\n")[1];
    expect(pressed).toContain(`card "줄 바꿈 '따옴표' `);
    expect(pressed).toContain("…\" (draft card-1).");
    expect(displayText.includes("\n")).toBe(false);
    expect(displayText.endsWith("…")).toBe(true);
  });
});

describe("the card's labels", () => {
  it("one label table for the card button and the report; the confirm button is the only reported press", () => {
    expect(TEAM_BRAIN_CARD_PRESS_ACTIONS).toEqual(["apply"]);
    expect(teamBrainCardButtonLabel({ kind: "direct" })).toBe("팀 브레인에 반영");
    expect(teamBrainCardButtonLabel({ kind: "policy" })).toBe("팀 정책 반영");
    expect(teamBrainCardPressBubble({ kind: "direct", title: "  " }, true)).toBe("팀 브레인에 반영했습니다.");
    expect(teamBrainCardPressBubble({ kind: "policy", title: "검토 주기" }, true)).toBe("팀 정책 변경을 반영했습니다: 검토 주기");
    expect(teamBrainCardPressBubble({ kind: "direct", title: "배포" }, false)).toBe("카드의 ‘팀 브레인에 반영’ 버튼을 눌렀지만 처리되지 않았습니다.");
  });
});
