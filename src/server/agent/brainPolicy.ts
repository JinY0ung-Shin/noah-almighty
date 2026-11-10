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

/** What the personal second brain holds, and that capture needs no question first (user decision 2026-11-10). */
export const PERSONAL_KNOWLEDGE_DEFINITION =
  "PERSONAL KNOWLEDGE — what belongs in the owner's second brain: what matters to the owner themselves — their preferences and way of working, their own projects and unfinished work, the people and context they deal with, sources they want to keep, and facts that are durable for them but not (yet) team knowledge. Capture it without asking first (the brain-ingest skill), then say in one short line what you saved and where.";

/** One fact, one home (the SSOT rule both brains follow). */
export const BRAIN_ONE_HOME_RULE =
  "ONE FACT, ONE HOME: team knowledge lives in the team brain, personal knowledge in the personal brain. Once an admin approves a fact into the team brain, the team page is the canonical version; a personal note about the same fact becomes at most a one-line link to it (only with the user's yes — see PROMOTED NOTES). Never create a second full copy of a fact the other brain already holds: link to it or search it instead.";

/** Where a durable fact goes (the routing decision on every capture). */
export const BRAIN_ROUTING_RULE =
  "WHERE IT GOES: when the conversation produces something durable, decide its home first. Personal knowledge → capture it in the personal brain. Team knowledge → offer to share it with the team brain (OFFER TO SHARE). While a submission waits for an admin it may also live in the personal brain (capture it there when it is useful to the owner meanwhile); when you submit, pass that personal note's `wiki/` path in `personalNotes`, so the link is recorded.";

/** The rule's name, for the team flows that point at it (teamBrainTools.ts) instead of restating it. */
export const BRAIN_LINK_CHECK_NAME = "BEFORE A TEAM CARD";

/**
 * The execution point of ONE FACT, ONE HOME (issue #82): the link between a
 * personal note and its team page exists only when the avatar passes
 * `personalNotes`, so every team card starts with a look into the personal
 * brain — the owner's own submission, an admin's own knowledge AND an admin's
 * maintenance card (the migration pass, where the link used to be refused).
 * Still soft by decision (2026-11-10): the server detects nothing and never
 * writes the personal repo.
 */
export const BRAIN_LINK_CHECK_RULE =
  `${BRAIN_LINK_CHECK_NAME}: every time you are about to draft a team-brain card — \`mcp__brain__propose_team_note\`, or an admin's \`mcp__brain__prepare_team_changes\` (their own knowledge AND maintenance) — also search the personal brain (\`mcp__brain__search\`, scope "personal") for the topic: the card's title and the title of every page it creates or updates. Pass the \`wiki/\` path of each personal note that states the same fact in \`personalNotes\`, so the link is recorded and the note is marked once the change is in the team brain; a note that only mentions the topic is not one. This check changes nothing in the personal brain.`;

/** When the two brains disagree (user decision 2026-11-10: no precedence — show both). */
export const BRAIN_CONFLICT_RULE =
  "WHEN THEY DISAGREE: if a personal note and a team page say different things about the same topic, do not pick one and do not merge them silently. Show both — say which is the personal brain (내 브레인) and which is the team brain (팀 브레인), with their dates when they have any — and ask the user which holds. Then offer the fix that fits: correct the personal note, or submit a correction to the team brain.";

/**
 * Turning an approved personal note into a link (user decisions 2026-11-10:
 * never forced, asked IN WORDS, and the question must be unambiguous to
 * someone who has never heard of the mechanism — the five required elements).
 */
export const PROMOTED_NOTE_RULE =
  "PROMOTED NOTES: a personal note that was submitted and approved into the team brain — or that an admin's maintenance change recorded as stating the same fact as a team page — is marked so by `mcp__brain__get_note`, `mcp__brain__search` and `mcp__brain__list_team_proposals`. Nothing changes it automatically. When it comes up, ask the user ONCE, in plain words, whether to replace the personal note's body with a one-line link to the team page. The question MUST say: (1) which personal note — its title and path; (2) which team page it was approved as — title and path; (3) exactly what changes — the note's body is deleted and only one line linking to the team page stays; (4) what is kept — the raw/ capture and the git history still hold the old text; (5) what happens if they say no — both stay, and searches show both. Never use vague words like 'tidy up', 'clean up' or 'pointer'. If the note changed after it was submitted (the mark says so), show the part that changed and offer three choices instead: submit that part to the team brain as a follow-up, keep only that part in the personal note and link the rest, or change nothing. If the mark says the note was NOT the team page's source, read the team page first and treat whatever only the note says the same way as a changed part. Only after the user's yes: rewrite the note with `mcp__repo__write_file` — frontmatter `title` (unchanged) and `team_page: <team page path>`, body ONE line naming the team page — and commit.";

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
  /** Team submissions can be drafted in this run (the owner's own interactive chat). */
  teamPropose: boolean;
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
  if (scope.personalWrite && scope.teamPropose) parts.push(BRAIN_ROUTING_RULE, BRAIN_LINK_CHECK_RULE);
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
    BRAIN_ROUTING_RULE,
    BRAIN_LINK_CHECK_RULE,
    BRAIN_ONE_HOME_RULE,
    BRAIN_CONFLICT_RULE,
    PROMOTED_NOTE_RULE,
  ].join("\n\n");
}
