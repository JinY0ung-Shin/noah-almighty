import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRequest } from "../src/server/types.js";
import { createServices } from "../src/server/app.js";
import { buildRunCapabilities, stampPromptRequest } from "../src/server/agent/runCapabilities.js";
import { buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { buildSystemTools } from "../src/server/agent/systemTools.js";
import { readSystemManual } from "../src/server/agent/systemManual.js";
import { TOUR_PROMPTS } from "../src/server/tourScenarios.js";
import { summarizeOwnerState } from "../src/server/agent/ownerState.js";
import { writeRepoTemplate } from "../src/server/knowledgeRepo.js";
import {
  MemoryRefusedError,
  MemoryUnavailableError,
  setMemoryClientForTests,
  type MemoryClient,
} from "../src/server/memory/memoryClient.js";
import { callTool, withTempDir } from "./helpers.js";
import { createFakeMemoryClient } from "./helpers/fakeMemory.js";

// ---------------------------------------------------------------------------
// The personal vault on BOTH metacognition surfaces.
//
// The vault lives in the memory service, for every owner (the `repo` home, the
// repository copy and the migration were retired 2026-11-20). The frozen
// prompt states only what holds for a whole conversation: where the notes are,
// that a note is saved when written with nothing to commit, that repository
// files still need a commit. describe_system adds the one live fact — whether
// the service answers right now.
// ---------------------------------------------------------------------------

let tempDir: string;
const getTempDir = withTempDir("vault-self-knowledge", () => {
  tempDir = getTempDir();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(dir: string) {
  const { config, store } = createServices({
    dataDir: path.join(tempDir, dir, "data"),
    agentRuntime: "pi",
    sessionSecret: "test",
    pi: {
      gatewayUrl: "http://pi.invalid",
      apiKey: "k",
      deckSandbox: false,
      workspacesDir: path.join(tempDir, dir, "pi-ws"),
    },
  });
  const owner = store.createUser({ username: "owner", displayName: "오너", password: "password123" });
  const mate = store.createUser({ username: "mate", displayName: "동료", password: "password123" });
  store.setKnowledgeRepo(owner.id, "owner/brain", "main");
  const cwd = path.join(tempDir, dir, "ws");
  fs.mkdirSync(cwd, { recursive: true });
  const ownerRequest: AgentRequest = {
    message: "안녕",
    avatar: { id: owner.id, displayName: "오너", alias: "노아", persona: "" },
    conversationId: "conv-1",
    cwd,
    viewerUserId: owner.id,
    viewerName: "오너",
    viewerIsOwner: true,
    autoApprove: true,
  };
  const teammateRequest: AgentRequest = {
    ...ownerRequest,
    viewerUserId: mate.id,
    viewerName: "동료",
    viewerIsOwner: false,
    elevated: true,
    autoApprove: false,
  };
  return { config, store, owner, mate, ownerRequest, teammateRequest };
}
type Setup = ReturnType<typeof setup>;

/** The request as the prompt builders see it, through the run's real capability plan. */
async function stamped(s: Setup, request: AgentRequest): Promise<AgentRequest> {
  const caps = await buildRunCapabilities(request, [], s.config, s.store, undefined, undefined, () => 0);
  return stampPromptRequest(request, caps, s.config, undefined);
}

async function promptOf(s: Setup, request: AgentRequest): Promise<string> {
  return buildSystemPromptAppend(await stamped(s, request));
}

async function describeSystem(s: Setup, over: { viewerIsOwner?: boolean } = {}): Promise<string> {
  const tools = buildSystemTools(s.store, {
    avatarUserId: s.owner.id,
    owner: { id: s.owner.id, username: s.owner.username, displayName: s.owner.displayName },
    config: s.config,
    viewerIsOwner: true,
    ...over,
  });
  const result = await callTool(tools, "describe_system", {});
  return result.content[0].text ?? "";
}

/** Give this server a memory service (a fake one that answers). */
function withService(s: Setup) {
  const fake = createFakeMemoryClient();
  setMemoryClientForTests(s.store, fake);
  return fake;
}

const lineOf = (report: string, label: string) => report.split("\n").find((line) => line.startsWith(`- ${label}:`)) ?? "";

/** The lines describe_system can say about a vault; everything else in a report is not about it. */
const VAULT_LABELS = ["Personal vault", "Memory service", "Vault copy in the repository", "Repository import"];
const vaultLines = (report: string) => report.split("\n").filter((line) => VAULT_LABELS.some((label) => line.startsWith(`- ${label}:`)));

const NOTES = "the repository-root `CLAUDE.md` and every `.md` note under `wiki/` and `raw/`";

/** What every text about the retired copy / second home said. None of it may come back. */
const RETIRED_WORDING = [
  "personal vault — the repository-root `CLAUDE.md` and every `.md` note under `wiki/` and `raw/` — was stored",
  "was stored in Noah's memory service",
  "COPY",
  "pushes that copy",
  "pushes its copy",
  "repository's copy",
  "commit after writing",
  "Brain edits are not pushed until you commit",
  "Changes from these write tools are **not pushed",
  "BEHIND",
  "on hold",
  "WAITING FOR THE OWNER",
];

describe("the frozen prompt states the one home and save-on-write, nothing live", () => {
  it("owner: the notes are in the memory service, saved when written, nothing to commit; repository files still need the commit", async () => {
    const s = setup("prompt-owner");
    withService(s);
    expect(await stamped(s, s.ownerRequest)).not.toHaveProperty("vaultHome");
    const p = await promptOf(s, s.ownerRequest);

    expect(p).toContain(`**Where your vault lives**: your vault notes — ${NOTES} — are stored in Noah's memory service, not in git; the same tools and paths read and write them.`);
    expect(p).toContain("A vault note is saved the moment its write succeeds (the result says `is saved now`): nothing to commit, and it is not copied to the repository.");
    expect(p).toContain("A note file in the git repository itself is not part of the brain.");
    expect(p).toContain("that is an outage, never an empty brain");
    expect(p).toContain("do not write the note somewhere else instead");
    // The repository section: only the files that live in git wait for a commit.
    expect(p).toContain(
      "Repository files that are not vault notes are **not pushed until you call `mcp__repo__commit`**, so commit when a unit of work on them is finished or the owner asks.",
    );
    for (const gone of RETIRED_WORDING) expect(p, gone).not.toContain(gone);
    // The rest of the brain guidance is untouched.
    expect(p).toContain("**Second brain**");
    expect(p).toContain("states the CURRENT truth only");
  });

  it("carries no live fact: the prompt is the same whether the service is there, down or not configured", async () => {
    const s = setup("prompt-frozen");
    const unconfigured = await promptOf(s, s.ownerRequest);
    expect(summarizeOwnerState(s.store, s.config, s.owner.id).vault).toEqual({ serviceConfigured: false });
    const fake = withService(s);
    expect(summarizeOwnerState(s.store, s.config, s.owner.id).vault).toEqual({ serviceConfigured: true });
    expect(await promptOf(s, s.ownerRequest)).toBe(unconfigured);
    fake.failNext(new MemoryUnavailableError("memory service unavailable (list): network error (ECONNREFUSED)", "network"));
    const down = await promptOf(s, s.ownerRequest);
    expect(down).toBe(unconfigured);
    expect(down).not.toContain("UNREACHABLE");
  });

  it("a teammate and a consultation hear where the notes are and that an outage is not an empty brain — never the write facts", async () => {
    const s = setup("prompt-readers");
    withService(s);
    const teammate = await promptOf(s, s.teammateRequest);
    expect(teammate).toContain(`**Where the owner's vault lives**: the owner's vault notes (${NOTES}) are stored in Noah's memory service, not in git; the same tools and paths read them.`);
    expect(teammate).toContain("If a tool reports that the memory service is unavailable, that is an outage, never an empty brain");
    expect(teammate).not.toContain("A vault note is saved the moment");
    expect(teammate).not.toContain("do not write the note somewhere else instead");

    const consultation = await promptOf(s, {
      ...s.teammateRequest,
      avatarConsultation: true,
      headless: true,
      allowHeadlessTools: true,
    });
    expect(consultation).toContain("**Where the owner's vault lives**");
    expect(consultation).not.toContain("A vault note is saved the moment");

    // A shared account lets the teammate write, so they get the writer's facts — but NOT the pointer to
    // describe_system: a non-owner's describe_system carries no owner state (below).
    s.store.updateProfile(s.owner.id, { sharedAccount: true });
    const shared = await promptOf(s, s.teammateRequest);
    expect(shared).toContain(`**Where the owner's vault lives**: the owner's vault notes — ${NOTES} — are stored in Noah's memory service, not in git; the same tools and paths read and write them. `);
    expect(shared).not.toContain("**Where your vault lives**");
    expect(shared).toContain("A vault note is saved the moment");
    expect(shared).toContain("do not write the note somewhere else instead");
    expect(shared).toContain("(a brain note is saved when written; any other repository file is not pushed until you call `mcp__repo__commit`)");
    for (const p of [teammate, consultation, shared]) {
      for (const gone of RETIRED_WORDING) expect(p, gone).not.toContain(gone);
    }
  });

  it("with no repository connected: notes written earlier are not lost, said conditionally and without the vault paragraph", async () => {
    const s = setup("prompt-no-repo");
    withService(s);
    s.store.setKnowledgeRepo(s.owner.id, null, null);
    const p = await promptOf(s, s.ownerRequest);
    expect(p).toContain("You do not have a knowledge repository yet");
    expect(p).toContain(
      `Any brain notes written while a repository was connected (${NOTES}) are still kept in Noah's memory service but NOT reachable through your tools until a repository is connected again (the repository file tools refuse and brain recall is off) — nothing was lost, so never tell the owner their brain is empty or gone.`,
    );
    expect(p).not.toContain("**Where your vault lives**");
    expect(p).not.toContain("the same tools and paths read and write them");
    expect(p).not.toContain("Noah looks at that repository");
  });
});

describe("describe_system states where the vault is and whether the service answers", () => {
  it("a repository import that is still pending is one more line — and gone when it is over", async () => {
    const s = setup("describe-import");
    withService(s);
    s.store.setVaultImport(s.owner.id, "check");
    const line = lineOf(await describeSystem(s), "Repository import");
    expect(line).toContain("PENDING — Noah is still importing the notes of the connected knowledge repository into this vault");
    expect(line).toContain("do not run `brain-migrate` or rebuild notes meanwhile");
    s.store.clearVaultImport(s.owner.id);
    expect(lineOf(await describeSystem(s), "Repository import")).toBe("");
  });

  it("with a repository: the vault line, then the live memory-service line — and no line about a copy", async () => {
    const s = setup("describe");
    const fake = withService(s);
    const report = await describeSystem(s);
    expect(vaultLines(report)).toEqual([
      `- Personal vault: in Noah's memory service — ${NOTES} are stored there, not in the git repository. ` +
        "The same tools and paths apply (`mcp__repo__*` reads and writes them, `mcp__brain__*` recalls them). " +
        'A vault note is SAVED the moment its write, edit, move or delete succeeds (its tool result says "is saved now"): there is nothing to commit for it, the memory service keeps its change history, and it is NOT copied to the git repository — a note file found there is an old copy that is no longer updated. ' +
        'Everything else in the repository (skills, plugins, non-markdown files) lives in git and is saved only when `mcp__repo__commit` succeeds (a tool result that says "Not committed yet" is not saved yet)',
      "- Memory service: reachable right now (it answered a listing of this vault)",
    ]);
    // ONE cheap call, as this owner.
    expect(fake.calls).toEqual([{ op: "list", owner: s.owner.id, prefix: "raw" }]);
    // They sit with the knowledge lines, right after the brain line.
    const lines = report.split("\n");
    expect(lines[lines.findIndex((line) => line.startsWith("- Personal vault:")) - 1]).toMatch(/^- Second brain \(personal\): active/);
    expect(report).toContain("- Knowledge repository: owner/brain @ main");
    for (const gone of RETIRED_WORDING) expect(report, gone).not.toContain(gone);
  });

  it("with no repository connected the notes are there but unreachable, no tool that refuses is named, and the service is not asked", async () => {
    const s = setup("describe-no-repo");
    const fake = withService(s);
    s.store.setKnowledgeRepo(s.owner.id, null, null);

    const report = await describeSystem(s);
    expect(vaultLines(report)).toHaveLength(1);
    const vault = lineOf(report, "Personal vault");
    expect(vault).toContain("NO knowledge repository connected — any brain notes written while a repository was connected");
    expect(vault).toContain("NOT reachable through your tools until a repository is connected again");
    expect(vault).toContain("nothing was lost, so never tell the owner their brain is empty or gone");
    expect(vault).not.toContain("the same tools and paths read and write them");
    expect(vault).not.toContain("mcp__repo__commit");
    expect(vault).not.toContain("mcp__repo__*");
    expect(report).toContain("Second brain (personal): inactive");
    expect(fake.calls).toEqual([]);

    // A server without a memory service and an owner without a repository: there is no vault to speak of.
    setMemoryClientForTests(s.store, null);
    expect(vaultLines(await describeSystem(s))).toEqual([]);
  });

  it("a service that cannot be used is UNREACHABLE — never an empty brain", async () => {
    const s = setup("describe-unreachable");
    const fake = withService(s);

    fake.failNext(new MemoryUnavailableError("memory service unavailable (list): network error (ECONNREFUSED)", "network"), { op: "list" });
    let line = lineOf(await describeSystem(s), "Memory service");
    expect(line).toContain("UNREACHABLE right now (Noah could not connect to it)");
    expect(line).toContain("vault notes cannot be read, searched or written until it answers");
    expect(line).toContain("that is an outage, never an empty brain");
    expect(line).toContain("Notes saved before are not lost.");
    expect(line).not.toContain("reachable right now (it answered");

    fake.failNext(new MemoryUnavailableError("memory service unavailable (list): HTTP 401", "unauthorized"), { op: "list" });
    expect(lineOf(await describeSystem(s), "Memory service")).toContain("UNREACHABLE right now (it did not accept Noah's key)");

    // It answered, but would not serve this vault: up, and still not usable.
    fake.failNext(new MemoryRefusedError("invalid_owner", 400, "the owner is not a valid user id"), { op: "list" });
    line = lineOf(await describeSystem(s), "Memory service");
    expect(line).toContain("answering, but it REFUSED Noah's check of this vault (`invalid_owner`)");
    expect(line).toContain("never an empty brain");

    // A repository is connected but the server has no service: every vault call fails, and the report says why.
    setMemoryClientForTests(s.store, null);
    const report = await describeSystem(s);
    expect(lineOf(report, "Memory service")).toContain(
      "UNREACHABLE right now (this server has no memory service configured — an operator sets PI_MEMORY_URL and PI_MEMORY_API_KEY_FILE)",
    );
    // Where the vault is stays reported — it is Noah's own fact.
    expect(lineOf(report, "Personal vault")).toContain("in Noah's memory service");
    expect(summarizeOwnerState(s.store, s.config, s.owner.id).vault).toEqual({ serviceConfigured: false });
  });

  it("a service that never answers does not hold the report", async () => {
    const s = setup("describe-hang");
    const never = new Promise<never>(() => undefined);
    const hanging: MemoryClient = {
      list: () => never,
      read: () => never,
      put: () => never,
      remove: () => never,
      search: () => never,
      deleteWiki: () => never,
    };
    setMemoryClientForTests(s.store, hanging);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = describeSystem(s);
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    expect(lineOf(await pending, "Memory service")).toContain("UNREACHABLE right now (no answer within 3 seconds)");
  });

  it("a viewer who is not the owner gets no owner state, and no call is made for them", async () => {
    const s = setup("describe-non-owner");
    const fake = withService(s);
    const report = await describeSystem(s, { viewerIsOwner: false });
    expect(vaultLines(report)).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("the tool's description promises the vault and the live service check, nothing about a copy", () => {
    const s = setup("describe-description");
    const tools = buildSystemTools(s.store, {
      avatarUserId: s.owner.id,
      owner: { id: s.owner.id, username: s.owner.username, displayName: s.owner.displayName },
      config: s.config,
      viewerIsOwner: true,
    });
    const description = tools.find((t) => t.name === "describe_system")?.description ?? "";
    expect(description).toContain("the personal vault (CLAUDE.md, wiki/, raw/ notes kept in the memory service) and whether that service answers right now");
    expect(description).not.toContain("copy");
  });
});

describe("standing text every owner shares states the one home", () => {
  const skill = (name: string) =>
    fs.readFileSync(path.join(process.cwd(), "default-skills", "skills", name, "SKILL.md"), "utf8").replace(/\s+/g, " ");
  const BRAIN_SKILLS = ["brain-ingest", "brain-reflect", "brain-lint", "brain-migrate", "brain-search", "brain-share", "knowledge-backfill"];

  it("the skills say a brain note is saved when written and no longer tell the avatar to commit one", () => {
    const ingest = skill("brain-ingest");
    // Which result means saved and which does not — the two phrases the tool results carry.
    expect(ingest).toContain('A result that says the vault note "is saved now" is saved — there is nothing to commit for a brain note.');
    expect(ingest).toContain('A result that says "Not committed yet" (a repository file, not a brain note) is NOT saved until `mcp__repo__commit` succeeds.');
    expect(ingest).not.toContain("Always commit");
    const backfill = skill("knowledge-backfill");
    expect(backfill).toContain("capture is a repo-tool write, and a brain note is saved the moment it is written, with nothing to commit");
    expect(skill("brain-reflect")).toContain("**Nothing to commit:** each note is saved as it is written, and its tool result says so.");
    expect(skill("brain-lint")).toContain("Each fix is saved as it is made — there is nothing to commit.");
    // brain-migrate also writes repository files (`.gitkeep`), which are what its one commit is for.
    expect(skill("brain-migrate")).toContain("if you wrote a `.gitkeep`: those are repository files. The `.md` files above are brain notes — saved as you write them, with nothing to commit.");
    for (const name of [...BRAIN_SKILLS, "avatar-system-guide"]) {
      const text = skill(name);
      expect(text, name).not.toContain("an uncommitted write is not persisted");
      expect(text, name).not.toMatch(/not (persisted|saved) until you commit/);
      expect(text, name).not.toMatch(/pushes (its|the|that) copy/);
      expect(text, name).not.toContain("the commit is what pushes the capture");
      expect(text, name).not.toContain("plus a commit");
      // brain-migrate keeps its one commit: it also writes repository files (`.gitkeep`).
      if (name !== "brain-migrate") expect(text, name).not.toMatch(/commit once|then commit/i);
    }
    // A service outage is not an empty brain, on the read side and in the consolidation pass.
    expect(skill("brain-search")).toContain("**Memory service unavailable** — an outage, not an empty brain");
    expect(skill("brain-reflect")).toContain("an outage, not an empty vault: stop the pass and say so");
  });

  it("the tour captures without a commit and reads the tool result before saying 'saved'", () => {
    const text = Object.values(TOUR_PROMPTS).join("\n");
    expect(text).toContain("A brain note is saved the moment the tool writes it — there is nothing to commit for it.");
    expect(text).toContain("a result that says 'Not committed yet' (a repository file, not a brain note) is NOT saved until `mcp__repo__commit` succeeds");
    expect(text).not.toContain("it is what pushes the note to the repository");
    expect(text).not.toContain("commit the deletion");
  });

  it("the repository template says where brain notes are saved and what the repository still holds", async () => {
    const dir = path.join(tempDir, "template");
    fs.mkdirSync(dir, { recursive: true });
    expect(await writeRepoTemplate(dir, "owner/brain")).toBe(true);
    const claudeMd = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").replace(/\s+/g, " ");
    expect(claudeMd).toContain("are saved in Noah's memory service when they are written: there is nothing to commit, and they are NOT copied to the knowledge repository.");
    expect(claudeMd).toContain("`mcp__repo__commit` is what pushes the change to the repository.");
    expect(claudeMd).not.toContain("An edit is not persisted until you commit");
    expect(claudeMd).not.toContain("COPY");
    expect(claudeMd).not.toContain("replaced by the next push");
    // Standing memory is capped at 6,000 characters; the template stays far below it.
    expect(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").length).toBeLessThan(3000);
    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    expect(readme).toContain("메모리");
    expect(readme).not.toContain("**사본**");
    expect(readme).not.toContain("pi-gateway");
  });

  it("the manual explains the one home: what is saved when, what the repository holds, and what an outage is", () => {
    const manual = readSystemManual("knowledge").text;
    expect(manual).toContain("## Where the vault lives");
    expect(manual).toContain('its result says the vault note "is saved now", and there is nothing to commit for it');
    expect(manual).toContain('is saved only when mcp__repo__commit succeeds, which pushes it to the remote repository: its result says "Not committed yet" until then');
    expect(manual).toContain("never report as saved what the results do not say is saved");
    expect(manual).toContain("It lives in Noah's memory service, for every owner");
    expect(manual).toContain("A vault note is saved the moment its write, edit, move or delete succeeds and needs no commit.");
    expect(manual).toContain("The memory service keeps each note's change history; nothing is copied or pushed to the git repository.");
    expect(manual).toContain("A note file in the git repository itself is not part of the brain: no tool reads or updates it.");
    expect(manual).toContain("old copies from the time Noah copied the vault into the repository (it no longer does, so they stay as they were)");
    expect(manual).toContain("Noah imports that repository's notes once, in the background; an existing note is never replaced");
    expect(manual).toContain("With none connected the notes stay in the memory service but the repository and brain tools refuse");
    expect(manual).toContain("that is an outage, not an empty brain");
    // What describe_system reports is promised to the owner only.
    expect(manual).toContain("For the owner, mcp__system__describe_system reports whether the service answers right now (a non-owner's describe_system reports no owner state)");
    for (const gone of ["ONE home per owner", "in both cases", "pushes its copy", "marked behind", "WAITS until the owner confirms", "is looked at first", "Uncommitted local files are not persisted", "pi-gateway"]) {
      expect(manual, gone).not.toContain(gone);
    }
  });
});
