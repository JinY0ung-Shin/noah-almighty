// Brain policy — the ONE home of every rule about WHAT goes into the personal
// second brain vs the team brain and how the two relate (user decisions
// 2026-11-10, docs/architecture/repo-knowledge.md + team-brain.md). The prompt
// (promptBuilder.ts), the tool descriptions/results (brainTools.ts,
// teamBrainTools.ts) and read_manual (systemManual.ts) import these strings;
// the bundled brain-* / team-brain-curate skills and the knowledge-repo
// template REFER to them ("the Brain policy in your instructions") instead of
// restating them — tests/brain-policy.test.ts pins both halves. Agent-facing,
// so English. The team's ADMINS add their own rules in POLICY.md
// (teamBrainPolicy.ts) — guidelines that refine these, never override them.

/** The four team-knowledge tests (prompt + tool descriptions share this wording). */
export const TEAM_KNOWLEDGE_DEFINITION =
  "TEAM KNOWLEDGE — what belongs in the team brain. Something is team knowledge only if ALL four hold: (1) useful to others — another teammate would look for it in the same situation; (2) durable — it stays true for a while, not a one-off status update; (3) settled — a decision that was made or a fact that was verified, not an opinion or a guess; (4) safe to share — no secrets, tokens or passwords, personal data, customer data, or anyone's private matters. Good fits: team decisions (what and why), system/infrastructure facts, fixes for recurring problems, glossary terms, conventions, owners and points of contact. Never: personal preferences, work in progress, personal to-dos, feelings or judgments about people.";

/**
 * The altitude test on top of the four (user decision 2026-11-12: "너무 세부적인
 * 정보는 말고 팀에 공유할만한 정보로"). It gates the everyday OFFER TO SHARE and
 * the brain-share selection pass alike — one rule, so the two never drift.
 */
export const TEAM_SHARE_LEVEL_RULE =
  "THE RIGHT LEVEL — passing the four tests is not enough: the team brain holds what a teammate can reuse, not the detail of how one person got there. Worth sharing: a decision and its reason, how a system works and where it lives, the fix for a problem that will come back, a convention, a term, who owns what. Too detailed — it stays personal: the step-by-step record of one debugging or work session, the particulars of one ticket, one meeting or one case, values that mattered only once (a temporary path, a one-off number, yesterday's status), anyone's task list or progress, drafts and half-formed ideas. When a detailed note or conversation holds a conclusion a teammate could reuse, offer only the part that states that conclusion; when nothing reusable is left once the detail is removed, do not offer it at all. This holds for every offer to share and for every pass that selects personal notes for the team. When in doubt, leave it out: a short team brain people trust beats a complete one.";

/** The bundled skill that selects personal notes for the team (default-skills/skills/brain-share). */
export const TEAM_SHARE_SKILL = "brain-share";

/** Cards ONE selection pass may draft (user decision 2026-11-12) — a pass stays small enough to read before pressing. */
export const TEAM_SHARE_PASS_MAX = 3;

/** Frontmatter key (+ its one value) of a personal note the owner decided to keep out of the team brain. */
export const PERSONAL_TEAM_SHARE_KEY = "team_share";
export const PERSONAL_TEAM_SHARE_DECLINED = "no";

/** The rule's name, for the tool refusal that points at it (brainTools.ts). */
export const BRAIN_KEPT_PERSONAL_NAME = "KEPT PERSONAL";

/**
 * The selection pass over the personal brain (user decisions 2026-11-12: on
 * request, the cards are drafted without a per-candidate question, at most
 * TEAM_SHARE_PASS_MAX per pass — a number the admins' POLICY.md guidelines may
 * replace; 2026-11-13: each card writes the team brain when pressed, so each
 * is pressed on its own — there is no "all at once" button).
 */
export const TEAM_SHARE_PASS_RULE =
  `SELECTING FOR THE TEAM: when the user asks which of their own notes are worth sharing with the team, run the \`${TEAM_SHARE_SKILL}\` skill — it goes through the personal brain's \`wiki/\` notes, keeps only what passes the TEAM KNOWLEDGE tests at THE RIGHT LEVEL, and drafts a team-brain card for the best ones. Asking for the pass is the user's yes to DRAFT those cards — do not ask again per note — but not to share them: nothing reaches the team brain until the user presses a card. In a pass, each card's source is the note's own passage that states the conclusion, verbatim, and the intake facts (provenance included) come from the note where it states them; ask ONCE, for all the drafts together, only for what the notes do not say — a note whose origin the user cannot name is left out. One pass drafts at most ${TEAM_SHARE_PASS_MAX} cards (the team guidelines may set another number), the most useful first; name the other candidates by title only and leave them for the next pass. Each card (\`mcp__brain__prepare_team_changes\`) writes the team brain when pressed, so each is pressed on its own — there is no button for all of them. Never select a LINK note, a PROMOTED note, a note marked \`${PERSONAL_TEAM_SHARE_KEY}: ${PERSONAL_TEAM_SHARE_DECLINED}\`, or a fact that the team brain or an unpressed card of this conversation already holds.`;

/** Remembering a "no" (user decision 2026-11-12: a declined note is not asked about again). */
export const BRAIN_KEPT_PERSONAL_RULE =
  `${BRAIN_KEPT_PERSONAL_NAME}: when the user says a personal note should stay out of the team brain — they decline it in a selection pass, or say so about a note — record it so it is not asked again: add the frontmatter line \`${PERSONAL_TEAM_SHARE_KEY}: ${PERSONAL_TEAM_SHARE_DECLINED}\` to that note with \`mcp__repo__edit_file\`, commit, and say in one line that the note is now kept personal. When they only cancelled its card without saying why, ask once whether to leave it out of future passes before marking it. A note marked so is never offered or selected again; it goes to the team only when the user names that note and asks — then remove the mark and commit first.`;

/** What the personal second brain holds, and that capture needs no question first (user decision 2026-11-10). */
export const PERSONAL_KNOWLEDGE_DEFINITION =
  "PERSONAL KNOWLEDGE — what belongs in the owner's second brain: what matters to the owner themselves — their preferences and way of working, their own projects and unfinished work, the people and context they deal with, sources they want to keep, and facts that are durable for them but not (yet) team knowledge. Capture it without asking first (the brain-ingest skill), then say in one short line what you saved and where.";

/** One fact, one home (the SSOT rule both brains follow). */
export const BRAIN_ONE_HOME_RULE =
  "ONE FACT, ONE HOME: team knowledge lives in the team brain, personal knowledge in the personal brain. Once a fact is in the team brain, the team page is the canonical version; a personal note about the same fact becomes at most a one-line link to it (only with the user's yes — see PROMOTED NOTES). Never create a second full copy of a fact the other brain already holds: link to it or search it instead.";

/** Where a durable fact goes (the routing decision on every capture). */
export const BRAIN_ROUTING_RULE =
  "WHERE IT GOES: when the conversation produces something durable, decide its home first. Personal knowledge → capture it in the personal brain. Team knowledge → offer to put it into the team brain (OFFER TO SHARE). It may also live in the personal brain while the user has not said yes or has not pressed its card (capture it there when it is useful to the owner meanwhile); when you draft the card, pass that personal note's `wiki/` path in `personalNotes`, so the link is recorded.";

/** The rule's name, for the team flows that point at it (teamBrainTools.ts) instead of restating it. */
export const BRAIN_LINK_CHECK_NAME = "BEFORE A TEAM CARD";

/**
 * The execution point of ONE FACT, ONE HOME (issue #82): the link between a
 * personal note and its team page exists only when the avatar passes
 * `personalNotes`, so every team card starts with a look into the personal
 * brain — new knowledge AND a correction or maintenance card (the migration
 * pass, where the link used to be refused).
 * Still soft by decision (2026-11-10): the server detects nothing and never
 * writes the personal repo.
 */
export const BRAIN_LINK_CHECK_RULE =
  `${BRAIN_LINK_CHECK_NAME}: every time you are about to draft a team-brain card — \`mcp__brain__prepare_team_changes\`, for new knowledge AND for a correction or maintenance of existing pages — also search the personal brain (\`mcp__brain__search\`, scope "personal") for the topic: the card's title and the title of every page it creates or updates. Pass the \`wiki/\` path of each personal note that states the same fact in \`personalNotes\`, so the link is recorded and the note is marked once the change is in the team brain; a note that only mentions the topic is not one. This check changes nothing in the personal brain.`;

/** When the two brains disagree (user decision 2026-11-10: no precedence — show both). */
export const BRAIN_CONFLICT_RULE =
  "WHEN THEY DISAGREE: if a personal note and a team page say different things about the same topic, do not pick one and do not merge them silently. Show both — say which is the personal brain (내 브레인) and which is the team brain (팀 브레인), with their dates when they have any — and ask the user which holds. Then offer the fix that fits: correct the personal note, or correct the team page (a `mcp__brain__prepare_team_changes` card the user presses).";

/**
 * Turning a personal note whose fact went into the team brain into a link (user decisions 2026-11-10:
 * never forced, asked IN WORDS, and the question must be unambiguous to
 * someone who has never heard of the mechanism — the five required elements).
 */
export const PROMOTED_NOTE_RULE =
  "PROMOTED NOTES: a personal note that went into the team brain as the source of a team-brain card — or that a correction or maintenance card recorded as stating the same fact as a team page — is marked so by `mcp__brain__get_note` and `mcp__brain__search`, and in the owner's own chat `mcp__brain__team_brain_health` lists them. Nothing changes it automatically. When it comes up, ask the user ONCE, in plain words, whether to replace the personal note's body with a one-line link to the team page. The question MUST say: (1) which personal note — its title and path; (2) which team page now holds it — title and path; (3) exactly what changes — the note's body is deleted and only one line linking to the team page stays; (4) what is kept — the raw/ capture and the git history still hold the old text; (5) what happens if they say no — both stay, and searches show both. Never use vague words like 'tidy up', 'clean up' or 'pointer'. If the note changed after it went in (the mark says so), show the part that changed and offer three choices instead: put that part into the team brain as a follow-up change, keep only that part in the personal note and link the rest, or change nothing. If the mark says the note was NOT the team page's source, read the team page first and treat whatever only the note says the same way as a changed part. Only after the user's yes: rewrite the note with `mcp__repo__write_file` — frontmatter `title` (unchanged) and `team_page: <team page path>`, body ONE line naming the team page — and commit.";

/** Frontmatter key of a personal note that became a link to its team page. */
export const PERSONAL_TEAM_PAGE_KEY = "team_page";

/** How a skill or template refers to these rules instead of restating them. */
export const BRAIN_POLICY_REFERENCE = "the Brain policy in your instructions";

export interface BrainPolicyScope {
  /** The personal second brain can be written in this run (capture/consolidate). */
  personalWrite: boolean;
  /** The personal second brain can at least be read. */
  personalRead: boolean;
  /** The team brain can be read. */
  teamRead: boolean;
  /** Team-brain cards can be drafted in this run (the owner's own interactive chat). */
  teamWrite: boolean;
}

/**
 * The prompt's **Brain policy** section for what this run can do, or null when
 * the run has neither brain. Rules about writing are stated only where the run
 * can write; the conflict rule wherever both brains can be read.
 */
export function brainPolicySection(scope: BrainPolicyScope): string | null {
  const personal = scope.personalRead || scope.personalWrite;
  if (!personal && !scope.teamRead) return null;
  const parts: string[] = ["**Brain policy** (the rules for both brains; the brain-* and team-brain-curate skills follow them):"];
  if (scope.personalWrite) parts.push(PERSONAL_KNOWLEDGE_DEFINITION);
  if (scope.personalWrite && scope.teamWrite) parts.push(BRAIN_ROUTING_RULE, BRAIN_LINK_CHECK_RULE, TEAM_SHARE_PASS_RULE, BRAIN_KEPT_PERSONAL_RULE);
  if (personal && scope.teamRead) {
    parts.push(BRAIN_ONE_HOME_RULE, BRAIN_CONFLICT_RULE);
    if (scope.personalWrite) parts.push(PROMOTED_NOTE_RULE);
  }
  return parts.length > 1 ? parts.join(" ") : null;
}

/** The same rules for read_manual (every rule, whatever this run can do). */
export function brainPolicyManualText(): string {
  return [
    PERSONAL_KNOWLEDGE_DEFINITION,
    TEAM_KNOWLEDGE_DEFINITION,
    TEAM_SHARE_LEVEL_RULE,
    BRAIN_ROUTING_RULE,
    BRAIN_LINK_CHECK_RULE,
    TEAM_SHARE_PASS_RULE,
    BRAIN_KEPT_PERSONAL_RULE,
    BRAIN_ONE_HOME_RULE,
    BRAIN_CONFLICT_RULE,
    PROMOTED_NOTE_RULE,
  ].join("\n\n");
}
