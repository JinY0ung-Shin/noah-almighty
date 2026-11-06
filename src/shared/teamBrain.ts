// Team brain (팀 브레인) — shared client↔server vocabulary. ONE instance-wide
// LOCAL git vault that only Noah writes; teammates READ and PROPOSE, an admin
// decides. Every state change is a human button press on a chat card (the model
// only drafts). Design: docs/architecture/team-brain.md.

/** propose = a teammate's proposal; direct = an admin's own note; review = an admin's decision on a proposal. */
export const TEAM_BRAIN_PROPOSAL_KINDS = ["propose", "direct", "review"] as const;
export type TeamBrainProposalKind = (typeof TEAM_BRAIN_PROPOSAL_KINDS)[number];

/**
 * propose: draft → pending (submitted) → approved | rejected; draft/pending → withdrawn; draft → expired.
 * direct / review: draft → applied | cancelled; draft → expired.
 */
export const TEAM_BRAIN_PROPOSAL_STATUSES = [
  "draft",
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "applied",
  "cancelled",
  "expired",
] as const;
export type TeamBrainProposalStatus = (typeof TEAM_BRAIN_PROPOSAL_STATUSES)[number];

/** No delete op — a wrong note is corrected with an update (user decision 2026-11-06). */
export const TEAM_BRAIN_OPS = ["create", "update"] as const;
export type TeamBrainOp = (typeof TEAM_BRAIN_OPS)[number];

export type TeamBrainDecision = "approve" | "reject";

/** Max proposal body (bytes, UTF-8). */
export const TEAM_BRAIN_MAX_CONTENT_BYTES = 64 * 1024;
/** Max open (draft + pending) proposals per user. */
export const TEAM_BRAIN_MAX_OPEN_PROPOSALS = 20;
/** A draft card nobody pressed expires after this long. */
export const TEAM_BRAIN_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isTeamBrainOp(value: unknown): value is TeamBrainOp {
  return typeof value === "string" && (TEAM_BRAIN_OPS as readonly string[]).includes(value);
}

export function isTeamBrainProposalStatus(value: unknown): value is TeamBrainProposalStatus {
  return typeof value === "string" && (TEAM_BRAIN_PROPOSAL_STATUSES as readonly string[]).includes(value);
}

export function isTeamBrainProposalKind(value: unknown): value is TeamBrainProposalKind {
  return typeof value === "string" && (TEAM_BRAIN_PROPOSAL_KINDS as readonly string[]).includes(value);
}

/** A proposal row as the server and the card see it. */
export interface TeamBrainProposal {
  id: string;
  kind: TeamBrainProposalKind;
  status: TeamBrainProposalStatus;
  proposerUserId: string;
  proposerName: string;
  /** Null once the source conversation is gone. */
  conversationId: string | null;
  path: string;
  op: TeamBrainOp;
  title: string;
  summary: string;
  content: string;
  /** git blob of the target note when the draft was made (null for create). */
  baseBlob: string | null;
  /** review rows: the proposal being decided. */
  targetId: string | null;
  /** review rows: what pressing the button does. */
  decision: TeamBrainDecision | null;
  decisionReason: string | null;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a chat card renders (GET /api/team-brain/cards/:id). */
export interface TeamBrainCardView {
  proposal: TeamBrainProposal;
  /** review cards: the proposal being decided (null otherwise). */
  target: TeamBrainProposal | null;
  /** The note changed since the draft was made (or a create target now exists) — apply is refused. */
  stale: boolean;
  /** Current note content (update cards; null when absent). */
  currentContent: string | null;
  /** Which buttons this viewer may press now. */
  actions: { submit: boolean; withdraw: boolean; apply: boolean; cancel: boolean };
}

/** Badge numbers (GET /api/team-brain/status). */
export interface TeamBrainStatus {
  /** My decided (approved/rejected) proposals I have not looked at yet. */
  unseenResults: number;
  /** Admins only: proposals awaiting review (0 for everyone else). */
  pendingReview: number;
}

/** Admin backup state (GET /api/admin/team-brain). */
export interface TeamBrainBackupState {
  url: string | null;
  branch: string;
  /** Username of the admin whose git token pushes; null when unset. */
  adminName: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastAttemptAt: string | null;
}
