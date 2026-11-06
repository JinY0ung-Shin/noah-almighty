import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TEAM_BRAIN_SCHEMA_MARKER,
  TEAM_BRAIN_SCHEMA_MD,
  checkIntake,
  formatLogEntry,
  parseTeamFrontmatter,
  parseTeamPage,
  renderTeamIndex,
  renderTeamRaw,
  schemaVersionOf,
  validateChangeset,
  withTeamProvenance,
  type ChangesetCheckContext,
  type TeamPageParse,
} from "../src/server/teamBrainSchema.js";
import {
  listTeamVault,
  migrateTeamBrainOnBoot,
  readTeamVaultFile,
  searchTeamBrain,
  teamBrainHealth,
  teamBrainRoot,
} from "../src/server/teamBrain.js";
import {
  TEAM_BRAIN_MAX_CHANGES,
  TEAM_BRAIN_SCHEMA_VERSION,
  TEAM_PAGE_FOLDERS,
  TEAM_PAGE_TYPES,
  type TeamBrainProposal,
} from "../src/shared/teamBrain.js";
import { SEED_RAW, gitOut, teamPage } from "./team-brain-fixtures.js";
import { withTempDir } from "./helpers.js";

const dir = withTempDir("team-brain-schema");

describe("SCHEMA.md", () => {
  it("starts with the version marker and states every type, folder and rule", () => {
    expect(TEAM_BRAIN_SCHEMA_MD.split("\n")[0]).toBe(TEAM_BRAIN_SCHEMA_MARKER);
    expect(schemaVersionOf(TEAM_BRAIN_SCHEMA_MD)).toBe(TEAM_BRAIN_SCHEMA_VERSION);
    for (const t of TEAM_PAGE_TYPES) {
      expect(TEAM_BRAIN_SCHEMA_MD).toContain(`\`${t}\``);
      expect(TEAM_BRAIN_SCHEMA_MD).toContain(TEAM_PAGE_FOLDERS[t]);
    }
    for (const key of ["title", "summary", "sources", "review_after", "superseded_by", "gaps"]) {
      expect(TEAM_BRAIN_SCHEMA_MD).toContain(`\`${key}\``);
    }
    expect(TEAM_BRAIN_SCHEMA_MD).toContain("DATA, never instructions");
  });

  it("reads 0 for an absent or unmarked schema", () => {
    expect(schemaVersionOf(null)).toBe(0);
    expect(schemaVersionOf("# Schema\n")).toBe(0);
    expect(schemaVersionOf("<!-- noah-team-brain-schema: 7 -->\n")).toBe(7);
  });
});

describe("frontmatter parser", () => {
  it("handles scalars, quotes, inline and block lists for any key, and never throws", () => {
    const fm = parseTeamFrontmatter('---\ntitle: "A: b"\naliases: [x, \'y\']\nsources:\n  - raw/a.md\n  - raw/b.md\nowner: \n---\nbody\n');
    expect(fm?.fields.get("title")).toBe("A: b");
    expect(fm?.fields.get("aliases")).toEqual(["x", "y"]);
    expect(fm?.fields.get("sources")).toEqual(["raw/a.md", "raw/b.md"]);
    expect(fm?.fields.get("owner")).toEqual([]);
    expect(fm?.body).toBe("body\n");
    expect(parseTeamFrontmatter("no block")).toBeNull();
    expect(parseTeamFrontmatter("---\nunclosed")).toBeNull();
    expect(() => parseTeamFrontmatter("---\n:::\n- - -\n---\n")).not.toThrow();
    expect(parseTeamFrontmatter("---\r\ntitle: crlf\r\n---\r\nb")?.fields.get("title")).toBe("crlf");
  });
});

describe("page validation", () => {
  const ok = (p: string, c: string) => {
    const r = parseTeamPage(p, c);
    if (!r.ok) throw new Error(r.errors.join("\n"));
    return r.meta;
  };
  const errs = (p: string, c: string) => {
    const r = parseTeamPage(p, c);
    return r.ok ? [] : r.errors;
  };

  it("accepts a valid page and decodes its meta", () => {
    const meta = ok(
      "wiki/howto/deploy.md",
      teamPage({ title: "배포", aliases: ["deploy"], extra: ["owner: 플랫폼팀", "gaps: [rollback]", "valid_from: 2026-01-01"] }),
    );
    expect(meta).toMatchObject({
      title: "배포",
      type: "howto",
      aliases: ["deploy"],
      sources: [SEED_RAW],
      reviewAfter: "2099-01-01",
      owner: "플랫폼팀",
      status: null,
      gaps: ["rollback"],
      validFrom: "2026-01-01",
    });
    expect(meta.body).toContain("배포 body.");
  });

  it.each([
    ["no frontmatter", "wiki/howto/x.md", "just text", "frontmatter block"],
    ["missing title", "wiki/howto/x.md", teamPage({ title: "" }), "`title` is required"],
    ["bad type", "wiki/howto/x.md", teamPage({ title: "X" }).replace("type: howto", "type: note"), "`type` must be one of"],
    ["wrong folder", "wiki/systems/x.md", teamPage({ title: "X" }), "must live directly in `wiki/howto/`"],
    ["nested folder", "wiki/howto/a/x.md", teamPage({ title: "X" }), "must live directly in"],
    ["no summary", "wiki/howto/x.md", teamPage({ title: "X" }).replace(/summary: .*\n/, ""), "`summary` is required"],
    ["no sources", "wiki/howto/x.md", teamPage({ title: "X", sources: [] }), "`sources` must list"],
    ["non-raw source", "wiki/howto/x.md", teamPage({ title: "X", sources: ["wiki/a.md"] }), "is not a `raw/…md` path"],
    ["unreal date", "wiki/howto/x.md", teamPage({ title: "X", reviewAfter: "2026-02-30" }), "`review_after` must be a real date"],
    ["status on non-decision", "wiki/howto/x.md", teamPage({ title: "X", extra: ["status: accepted"] }), "only for decisions"],
    ["decision without status", "wiki/decisions/x.md", teamPage({ title: "X", type: "decision", extra: ["owner: a"] }).replace("status: accepted\n", ""), "`status` is required"],
    ["superseded without target", "wiki/decisions/x.md", teamPage({ title: "X", type: "decision", extra: ["status: superseded"] }), "`superseded_by` is required"],
    ["superseded_by not a decision", "wiki/decisions/x.md", teamPage({ title: "X", type: "decision", extra: ["status: superseded", "superseded_by: wiki/howto/y.md"] }), "must be a `wiki/decisions/…md`"],
    ["superseded_by while accepted", "wiki/decisions/x.md", teamPage({ title: "X", type: "decision", extra: ["superseded_by: wiki/decisions/y.md"] }), "only allowed with `status: superseded`"],
    ["empty body", "wiki/howto/x.md", teamPage({ title: "X", body: "  " }), "body"],
    ["duplicate key", "wiki/howto/x.md", teamPage({ title: "X", extra: ["title: Y"] }), "more than once"],
  ])("refuses %s", (_label, p, content, needle) => {
    const e = errs(p, content);
    expect(e.join("\n")).toContain(needle);
    expect(e.every((line) => line.startsWith(`${p}: `))).toBe(true);
  });
});

function ctx(pages: Record<string, string>, raw: string[] = [SEED_RAW], newRawPath: string | null = null): ChangesetCheckContext {
  const map = new Map<string, TeamPageParse>();
  for (const [p, c] of Object.entries(pages)) map.set(p, parseTeamPage(p, c));
  return { pages: map, rawPaths: new Set(raw), newRawPath };
}

describe("validateChangeset", () => {
  const head = { "wiki/howto/deploy.md": teamPage({ title: "배포", aliases: ["Deploy"] }) };

  it("passes a clean create + update", () => {
    expect(
      validateChangeset(
        [
          { path: "wiki/howto/deploy.md", op: "update", content: teamPage({ title: "배포", aliases: ["Deploy", "릴리스"] }) },
          { path: "wiki/systems/ci.md", op: "create", content: teamPage({ title: "CI", type: "system", body: "See [[배포]]." }) },
        ],
        ctx(head),
      ),
    ).toEqual([]);
  });

  it.each<[string, Array<{ path: string; op: "create" | "update"; content: string }>, string]>([
    ["create over an existing page", [{ path: "wiki/howto/deploy.md", op: "create", content: teamPage({ title: "배포" }) }], "exists — use update"],
    ["update of a missing page", [{ path: "wiki/howto/none.md", op: "update", content: teamPage({ title: "None" }) }], "does not exist — use create"],
    ["the index as a target", [{ path: "wiki/index.md", op: "update", content: "x" }], "never a change target"],
    ["a raw file as a target", [{ path: "raw/2026/11/x.md", op: "create", content: "x" }], "never a change target"],
    ["SCHEMA.md as a target", [{ path: "SCHEMA.md", op: "update", content: "x" }], "never a change target"],
    ["a path twice", [
      { path: "wiki/howto/a.md", op: "create", content: teamPage({ title: "A" }) },
      { path: "wiki/howto/a.md", op: "create", content: teamPage({ title: "A2" }) },
    ], "more than once"],
    ["a title taken by another page's alias (case-insensitive)", [{ path: "wiki/howto/other.md", op: "create", content: teamPage({ title: "deploy" }) }], "already used by wiki/howto/deploy.md"],
    ["two new pages with one name", [
      { path: "wiki/howto/a.md", op: "create", content: teamPage({ title: "Same" }) },
      { path: "wiki/systems/b.md", op: "create", content: teamPage({ title: "same", type: "system" }) },
    ], "already used by"],
    ["a source that does not exist", [{ path: "wiki/howto/a.md", op: "create", content: teamPage({ title: "A", sources: ["raw/none.md"] }) }], "source raw/none.md does not exist"],
    ["a secret", [{ path: "wiki/howto/a.md", op: "create", content: teamPage({ title: "A", body: `token ghp_${"a".repeat(36)}` }) }], "credential-like token"],
    ["a superseded_by target that does not exist", [
      { path: "wiki/decisions/old.md", op: "create", content: teamPage({ title: "Old", type: "decision", extra: ["status: superseded", "superseded_by: wiki/decisions/new.md"] }) },
    ], "`superseded_by` wiki/decisions/new.md does not exist"],
  ])("refuses %s", (_label, changes, needle) => {
    expect(validateChangeset(changes, ctx(head)).join("\n")).toContain(needle);
  });

  it("requires every page to cite the changeset's new source", () => {
    const fresh = "raw/2026/11/2026-11-06-abcd1234.md";
    const errors = validateChangeset(
      [
        { path: "wiki/howto/a.md", op: "create", content: teamPage({ title: "A", sources: [fresh] }) },
        { path: "wiki/howto/b.md", op: "create", content: teamPage({ title: "B" }) },
      ],
      ctx({}, [SEED_RAW], fresh),
    );
    expect(errors).toEqual([`wiki/howto/b.md: \`sources\` must list ${fresh}`]);
  });

  it("accepts a supersede whose replacement is created in the same changeset", () => {
    const pages = { "wiki/decisions/old.md": teamPage({ title: "Old", type: "decision" }) };
    expect(
      validateChangeset(
        [
          { path: "wiki/decisions/old.md", op: "update", content: teamPage({ title: "Old", type: "decision", extra: ["status: superseded", "superseded_by: wiki/decisions/new.md"] }) },
          { path: "wiki/decisions/new.md", op: "create", content: teamPage({ title: "New", type: "decision" }) },
        ],
        ctx(pages),
      ),
    ).toEqual([]);
  });

  it("uses every known page path for existence when the listing read only some pages (no false negatives)", () => {
    const capped = { ...ctx({}), knownPagePaths: new Set(["wiki/howto/unread.md", "wiki/decisions/new.md"]) };
    expect(validateChangeset([{ path: "wiki/howto/unread.md", op: "create", content: teamPage({ title: "U" }) }], capped).join()).toContain("exists — use update");
    expect(validateChangeset([{ path: "wiki/howto/unread.md", op: "update", content: teamPage({ title: "U" }) }], capped)).toEqual([]);
    expect(
      validateChangeset(
        [{ path: "wiki/decisions/old.md", op: "create", content: teamPage({ title: "Old", type: "decision", extra: ["status: superseded", "superseded_by: wiki/decisions/new.md"] }) }],
        capped,
      ),
    ).toEqual([]);
  });

  it("bounds count, per-page size and the own-secret scan", () => {
    const many = Array.from({ length: TEAM_BRAIN_MAX_CHANGES + 1 }, (_, i) => ({
      path: `wiki/howto/p${i}.md`,
      op: "create" as const,
      content: teamPage({ title: `P${i}` }),
    }));
    expect(validateChangeset(many, ctx({}))[0]).toContain(`at most ${TEAM_BRAIN_MAX_CHANGES} pages`);
    expect(validateChangeset([], ctx({}))).toEqual(["A changeset needs at least one page change."]);
    const big = teamPage({ title: "Big", body: "x".repeat(70 * 1024) });
    expect(validateChangeset([{ path: "wiki/howto/big.md", op: "create", content: big }], ctx({})).join()).toContain("too large");
    const own = { ...ctx({}), ownSecrets: { MY_TOKEN: "s3cr3t-value" } };
    expect(validateChangeset([{ path: "wiki/howto/a.md", op: "create", content: teamPage({ title: "A", body: "use s3cr3t-value" }) }], own).join()).toContain(
      "the secret MY_TOKEN",
    );
  });
});

describe("checkIntake", () => {
  const PROV = { source_kind: "document", source: "배포 가이드 v3", author: "인프라팀", authored_at: "2026-10" };

  it("lists exactly the missing required slots for the type", () => {
    expect(checkIntake("decision", { source: "회의", scope: "전사" })).toEqual({
      ok: false,
      missing: ["source_kind", "author", "authored_at", "validity", "decided_by", "decided_when", "rationale"],
      invalid: [],
    });
    expect(checkIntake("howto", { ...PROV, scope: "y", validity: "z", verified: "  " })).toEqual({
      ok: false,
      missing: ["verified"],
      invalid: [],
    });
  });

  it("trims, drops unknown keys and non-strings, and records unknown answers as gaps", () => {
    const r = checkIntake("system", { ...PROV, source: " 문서 ", scope: "운영", validity: "모름", owner: "unknown", bogus: "x", verified: 3 });
    expect(r).toEqual({
      ok: true,
      intake: {
        type: "system",
        answers: { ...PROV, source: "문서", scope: "운영", validity: "모름", owner: "unknown" },
        gaps: ["validity", "owner"],
        followups: [],
      },
    });
  });

  it("refuses an unknown or unlisted origin, a non-URL link and bad or future dates; keeps unknown author/date as gaps", () => {
    const base = { ...PROV, scope: "운영", validity: "변경 전까지" };
    const invalid = (answers: Record<string, string>) => {
      const r = checkIntake("concept", answers);
      return r.ok ? [] : r.invalid;
    };
    expect(invalid({ ...base, source_kind: "모름" })).toEqual([{ slot: "source_kind", problem: "unknown_not_allowed" }]);
    expect(invalid({ ...base, source: "unknown" })).toEqual([{ slot: "source", problem: "unknown_not_allowed" }]);
    expect(invalid({ ...base, source_kind: "소문" })).toEqual([{ slot: "source_kind", problem: "bad_kind" }]);
    expect(invalid({ ...base, source_kind: "link", source: "wiki page" })).toEqual([{ slot: "source", problem: "bad_url" }]);
    expect(invalid({ ...base, source_kind: "link", source: "https://wiki.internal/deploy" })).toEqual([]);
    expect(invalid({ ...base, authored_at: "2026-02-30" })).toEqual([{ slot: "authored_at", problem: "bad_date" }]);
    expect(invalid({ ...base, authored_at: "지난주" })).toEqual([{ slot: "authored_at", problem: "bad_date" }]);
    expect(invalid({ ...base, authored_at: "2999-01-01" })).toEqual([{ slot: "authored_at", problem: "future_date" }]);
    expect(invalid({ ...base, source: "x".repeat(501) })).toEqual([{ slot: "source", problem: "too_long" }]);
    for (const date of ["2026", "2026-10", "2026-10-31"]) expect(invalid({ ...base, authored_at: date })).toEqual([]);
    const r = checkIntake("concept", { ...base, source_kind: "웹 링크", source: "https://x.internal", author: "모름", authored_at: "unknown" });
    expect(r.ok && r.intake.answers.source_kind).toBe("link");
    expect(r.ok && r.intake.gaps).toEqual(["author", "authored_at"]);
  });

  it("merges a card's provenance edit into the intake and re-validates it", () => {
    const checked = checkIntake("concept", { ...PROV, scope: "운영", validity: "모름" });
    if (!checked.ok) throw new Error("fixture");
    const edited = withTeamProvenance(checked.intake, {
      source_kind: "회의",
      source: "11/4 주간 회의",
      author: "모름",
      authored_at: "2026-11-04",
    });
    expect(edited).toEqual({
      ok: true,
      intake: {
        type: "concept",
        answers: { source_kind: "meeting", source: "11/4 주간 회의", author: "모름", authored_at: "2026-11-04", scope: "운영", validity: "모름" },
        gaps: ["author", "validity"],
        followups: [],
      },
    });
    expect(withTeamProvenance(checked.intake, { source_kind: "link", source: "", author: "", authored_at: "어제" })).toEqual({
      ok: false,
      issues: [
        { slot: "source", problem: "missing" },
        { slot: "author", problem: "missing" },
        { slot: "authored_at", problem: "bad_date" },
      ],
    });
  });
});

const PROPOSAL: TeamBrainProposal = {
  id: "abcd1234-0000-0000-0000-000000000000",
  kind: "propose",
  status: "pending",
  proposerUserId: "u1",
  proposerName: "Mate",
  conversationId: null,
  path: "raw/2026/11/2026-11-06-abcd1234.md",
  op: "create",
  title: "배포 절차",
  summary: "compose up",
  content: "배포는 compose up.\n",
  baseBlob: null,
  intake: {
    type: "howto",
    answers: {
      source_kind: "verified",
      source: "직접 확인",
      author: "Mate",
      authored_at: "2026-11-05",
      scope: "운영",
      validity: "모름",
      verified: "예, v1.2",
    },
    gaps: ["validity"],
    followups: [{ questions: "어느 서버?", answer: "prod-1", askedAt: "2026-11-06T01:00:00.000Z", answeredAt: "2026-11-06T02:00:00.000Z" }],
  },
  changeset: null,
  targetId: null,
  decision: null,
  decisionReason: null,
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
};

describe("server-rendered files", () => {
  it("renders the raw source with provenance, the verbatim source, intake and follow-ups", () => {
    const raw = renderTeamRaw({
      proposal: PROPOSAL,
      approver: { name: "Admin", username: "admin" },
      approvedAt: "2026-11-07T00:00:00.000Z",
      submitter: { name: "Mate", username: "mate" },
    });
    expect(raw).toContain("---\ntitle: 배포 절차\ntype: raw\nid: abcd1234-0000-0000-0000-000000000000\npage_type: howto\n");
    expect(raw).toContain(
      "submitted_by: Mate (mate)\nsubmitted_at: 2026-11-06T00:00:00.000Z\napproved_by: Admin (admin)\napproved_at: 2026-11-07T00:00:00.000Z\n" +
        "source_kind: verified\nsource: 직접 확인\nauthor: Mate\nauthored_at: 2026-11-05\n---",
    );
    expect(raw).toContain("## Source\n\n배포는 compose up.\n");
    // Provenance lives in the frontmatter only.
    expect(raw).toContain("## Intake\n\n- scope: 운영\n- verified: 예, v1.2\n- gaps: validity\n");
    expect(parseTeamFrontmatter(raw)?.fields.get("authored_at")).toBe("2026-11-05");
    expect(raw).toContain("## Follow-up 1 (2026-11-06T01:00:00.000Z)\n### Questions\n어느 서버?\n### Answer (2026-11-06T02:00:00.000Z)\nprod-1");
    expect(parseTeamFrontmatter(raw)?.fields.get("title")).toBe("배포 절차");
  });

  it("renders a legacy row without an Intake section", () => {
    const raw = renderTeamRaw({
      proposal: { ...PROPOSAL, intake: { type: null, answers: {}, gaps: [], followups: [] } },
      approver: { name: "Admin", username: "admin" },
      approvedAt: "2026-11-07T00:00:00.000Z",
    });
    expect(raw).toContain("page_type: legacy");
    expect(raw).toContain("submitted_by: Mate\n");
    expect(raw).not.toContain("## Intake");
  });

  it("generates the index by type, sorted, with superseded and needs-migration sections", () => {
    const meta = (p: string, c: string) => {
      const r = parseTeamPage(p, c);
      if (!r.ok) throw new Error(r.errors.join());
      return { path: p, meta: r.meta };
    };
    const index = renderTeamIndex(
      [
        meta("wiki/systems/z.md", teamPage({ title: "Zeta", type: "system", summary: "z sys" })),
        meta("wiki/systems/a.md", teamPage({ title: "Alpha", type: "system", summary: "a sys" })),
        meta("wiki/decisions/d.md", teamPage({ title: "Use pi", type: "decision" })),
        meta("wiki/decisions/o.md", teamPage({ title: "Use SDK", type: "decision", extra: ["status: superseded", "superseded_by: wiki/decisions/d.md"] })),
      ],
      [{ path: "wiki/concepts/broken.md", title: "" }],
    );
    expect(index.startsWith("<!-- generated by Noah from page frontmatter — do not edit -->\n# Team brain index\n")).toBe(true);
    expect(index).toContain("## Decisions\n- [Use pi](decisions/d.md) — Use pi summary\n");
    expect(index).toContain("## Systems\n- [Alpha](systems/a.md) — a sys\n- [Zeta](systems/z.md) — z sys\n");
    expect(index.indexOf("## Decisions")).toBeLessThan(index.indexOf("## Systems"));
    expect(index).toContain("## Superseded decisions\n- [Use SDK](decisions/o.md)");
    expect(index).toContain("## Needs migration\n- concepts/broken.md\n");
    expect(renderTeamIndex([], [])).toContain("_No pages yet._");
  });

  it("formats a log entry", () => {
    expect(
      formatLogEntry({
        date: "2026-11-06T10:00:00.000Z",
        op: "ingest",
        title: "배포",
        by: "mate",
        approvedBy: "admin",
        changes: [{ op: "create", path: "wiki/howto/deploy.md" }],
        rawPath: "raw/2026/11/x.md",
      }),
    ).toBe("## [2026-11-06] ingest | 배포 | by mate · approved by admin\n- create wiki/howto/deploy.md\n- source raw/2026/11/x.md\n");
  });
});

describe("vault migration v0 → v1", () => {
  function v0Vault(dataDir: string) {
    const root = path.join(dataDir, "team-brain");
    fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
    fs.mkdirSync(path.join(root, "wiki", "tpl"), { recursive: true });
    execFileSync("git", ["-C", root, "init", "-q", "--initial-branch=main"]);
    fs.writeFileSync(path.join(root, "wiki", "index.md"), "# Team brain\n");
    fs.writeFileSync(path.join(root, "wiki", "concepts", "deploy.md"), "---\ntitle: Deploy\n---\n\nWe deploy with compose.\n");
    fs.writeFileSync(path.join(root, "wiki", "용어.md"), "배포 = deploy\n");
    fs.writeFileSync(path.join(root, "wiki", "tpl", "note_template.md"), "template\n");
    execFileSync("git", ["-C", root, "add", "-A"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Old", "-c", "user.email=o@x", "commit", "-q", "-m", "team-brain: initialize"]);
    return root;
  }

  it("moves every pre-schema note to raw/legacy in ONE Noah commit, keeps templates, and is idempotent", async () => {
    const config = { dataDir: dir() };
    const root = v0Vault(config.dataDir);
    const before = fs.readFileSync(path.join(root, "wiki", "concepts", "deploy.md"), "utf8");
    await migrateTeamBrainOnBoot(config);
    expect(gitOut(root, ["log", "-1", "--format=%an|%s"]).trim()).toBe("Noah Almighty|team-brain: migrate to schema v1");
    expect(gitOut(root, ["status", "--porcelain"]).trim()).toBe("");
    expect(fs.readFileSync(path.join(root, "raw", "legacy", "concepts", "deploy.md"), "utf8")).toBe(before);
    expect(fs.existsSync(path.join(root, "raw", "legacy", "용어.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "wiki", "concepts", "deploy.md"))).toBe(false);
    expect(fs.existsSync(path.join(root, "wiki", "tpl", "note_template.md"))).toBe(true);
    expect(await readTeamVaultFile(config, "SCHEMA.md")).toBe(TEAM_BRAIN_SCHEMA_MD);
    expect(await readTeamVaultFile(config, "wiki/index.md")).toContain("_No pages yet._");
    const log = (await readTeamVaultFile(config, "wiki/log.md"))!;
    expect(log).toContain("migrate | schema v1");
    expect(log).toContain("2 pre-schema notes moved to raw/legacy/");
    // Git tracked the moves as renames (history follows the note).
    expect(gitOut(root, ["log", "--follow", "--format=%s", "--", "raw/legacy/concepts/deploy.md"])).toContain("team-brain: initialize");

    const vault = await listTeamVault(config);
    expect(vault.pages.size).toBe(0);
    expect([...vault.rawPaths].sort()).toEqual(["raw/legacy/concepts/deploy.md", "raw/legacy/용어.md"]);
    const health = await teamBrainHealth(config);
    expect(health).toMatchObject({ schemaVersion: 1, pages: 0, rawSources: 2 });
    expect(health.uncompiledSources).toEqual(["raw/legacy/concepts/deploy.md", "raw/legacy/용어.md"]);
    // An uncompiled source is still findable, flagged as such.
    const hits = await searchTeamBrain(config, "compose");
    expect(hits.kind === "ok" && hits.hits.map((h) => [h.path, h.kind])).toEqual([["raw/legacy/concepts/deploy.md", "uncompiled_source"]]);

    const head = gitOut(root, ["rev-parse", "HEAD"]);
    let called = 0;
    await migrateTeamBrainOnBoot(config, () => (called += 1));
    expect(gitOut(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(called).toBe(0);
  });

  it("is a no-op without a vault and never throws on a broken one", async () => {
    const config = { dataDir: dir() };
    await migrateTeamBrainOnBoot(config);
    expect(fs.existsSync(teamBrainRoot(config))).toBe(false);
    fs.mkdirSync(path.join(teamBrainRoot(config), ".git"), { recursive: true });
    await expect(migrateTeamBrainOnBoot(config)).resolves.toBeUndefined();
  });
});
