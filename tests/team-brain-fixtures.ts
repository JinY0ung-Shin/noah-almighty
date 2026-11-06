// Shared team-brain test fixtures (not a test file): schema-valid pages and a
// one-call vault seed through the real apply path.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { applyTeamChangeset, teamBrainRoot } from "../src/server/teamBrain.js";
import type { TeamBrainOp, TeamPageType } from "../src/shared/teamBrain.js";

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
    `review_after: ${o.reviewAfter ?? "2099-01-01"}`,
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
