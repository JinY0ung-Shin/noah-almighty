// Shared team-brain test fixtures (not a test file): schema-valid pages and a
// one-call vault seed through the real apply path.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { applyTeamChangeset, teamBrainRoot } from "../src/server/teamBrain.js";
import type {
  TeamBrainChangeset,
  TeamBrainDecision,
  TeamBrainOp,
  TeamBrainProposalStatus,
  TeamPageType,
  TeamPersonalNoteLink,
} from "../src/shared/teamBrain.js";
import { teamRawPath } from "../src/shared/teamBrain.js";
import { addMonthsIso } from "../src/server/teamBrainPolicy.js";

/** A review_after inside every type's default POLICY.md horizon (the shortest is 3 months). */
export const NEAR_REVIEW_AFTER = addMonthsIso(new Date().toISOString().slice(0, 10), 1);

export const SEED_RAW = "raw/2026/11/2026-11-06-seed0001.md";
export const SEED_RAW_CONTENT = "---\ntitle: Seed source\ntype: raw\n---\n# Seed source\n\n## Source\n\n배포는 compose up 으로 한다.\n";
export const ADMIN_IDENTITY = { name: "Admin", email: "admin@noah-almighty.local" };

export interface PageOptions {
  title: string;
  type?: TeamPageType;
  summary?: string;
  sources?: string[];
  aliases?: string[];
  reviewAfter?: string;
  /** Extra raw frontmatter lines (e.g. "status: accepted"). */
  extra?: string[];
  body?: string;
}

/** A page that passes the schema (decisions get `status: accepted` unless `extra` sets one). */
export function teamPage(o: PageOptions): string {
  const type = o.type ?? "howto";
  const extra = [...(o.extra ?? [])];
  if (type === "decision" && !extra.some((l) => l.startsWith("status:"))) extra.push("status: accepted");
  return [
    "---",
    `title: ${o.title}`,
    `type: ${type}`,
    `summary: ${o.summary ?? `${o.title} summary`}`,
    ...(o.aliases ? [`aliases: [${o.aliases.join(", ")}]`] : []),
    `sources: [${(o.sources ?? [SEED_RAW]).join(", ")}]`,
    `review_after: ${o.reviewAfter ?? NEAR_REVIEW_AFTER}`,
    ...extra,
    "---",
    "",
    o.body ?? `${o.title} body.`,
    "",
  ].join("\n");
}

/** Seed the vault with the seed raw source + the given pages (one commit). */
export async function seedTeamVault(
  config: { dataDir: string },
  pages: Array<{ path: string; content: string; op?: TeamBrainOp }>,
  raw: { path: string; content: string } | null = { path: SEED_RAW, content: SEED_RAW_CONTENT },
): Promise<string> {
  return applyTeamChangeset(config, {
    raw,
    changes: pages.map((p) => ({ path: p.path, op: p.op ?? "create", content: p.content, baseBlob: null })),
    title: "seed",
    proposalId: "seed",
    logOp: "direct",
    author: ADMIN_IDENTITY,
  });
}

/** Write files straight into the vault and commit them, bypassing validation (to build bad vaults). */
export function commitIntoVault(config: { dataDir: string }, files: Record<string, string>, message = "test: raw commit"): void {
  const root = teamBrainRoot(config);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  execFileSync("git", ["-C", root, "add", "--", ...Object.keys(files)]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=t@x", "commit", "-q", "-m", message]);
}

export function gitOut(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args]).toString();
}

/** A row of the RETIRED review queue, as an older build left it (nothing mints one any more, so tests write it straight into the table). */
export interface LegacyTeamBrainRow {
  id?: string;
  kind: "propose" | "review";
  status: TeamBrainProposalStatus;
  proposerUserId: string;
  conversationId?: string | null;
  /** Defaults to the row's own raw path (a review passes its target's). */
  path?: string;
  title?: string;
  content?: string;
  /** Stored as JSON exactly as given (an old row's intake may carry `followups`). */
  intake?: unknown;
  changeset?: TeamBrainChangeset | null;
  personalNotes?: TeamPersonalNoteLink[];
  targetId?: string | null;
  decision?: TeamBrainDecision | null;
  decisionReason?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  createdAt?: string;
}

/** Insert a legacy `propose` / `review` row; returns its id. */
export function insertLegacyTeamBrainRow(store: object, row: LegacyTeamBrainRow): string {
  const db = (store as { db: Database.Database }).db;
  const id = row.id ?? crypto.randomUUID();
  const at = row.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO team_brain_proposals (id, kind, status, proposer_user_id, conversation_id, path, op, title, summary, content,
       base_blob, intake_json, changes_json, personal_notes_json, target_id, decision, decision_reason, decided_by, decided_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'create', ?, '', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    row.kind,
    row.status,
    row.proposerUserId,
    row.conversationId ?? null,
    row.path ?? teamRawPath(at, id),
    row.title ?? "배포",
    row.content ?? (row.kind === "propose" ? "배포는 compose up 으로 한다.\n" : ""),
    row.intake ? JSON.stringify(row.intake) : null,
    row.changeset ? JSON.stringify(row.changeset) : null,
    row.personalNotes?.length ? JSON.stringify(row.personalNotes) : null,
    row.targetId ?? null,
    row.decision ?? null,
    row.decisionReason ?? null,
    row.decidedBy ?? null,
    row.decidedAt ?? null,
    at,
    at,
  );
  return id;
}
