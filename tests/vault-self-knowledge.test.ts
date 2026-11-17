import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRequest } from "../src/server/types.js";
import { createServices } from "../src/server/app.js";
import { buildRunCapabilities, stampPromptRequest } from "../src/server/agent/runCapabilities.js";
import { buildSystemPromptAppend } from "../src/server/agent/promptBuilder.js";
import { buildSystemTools } from "../src/server/agent/systemTools.js";
import { readSystemManual } from "../src/server/agent/systemManual.js";
import { summarizeOwnerState, vaultMirrorStateText } from "../src/server/agent/ownerState.js";
import { writeRepoTemplate } from "../src/server/knowledgeRepo.js";
import { VAULT_MIRROR_ERROR } from "../src/server/vaultMirror.js";
import {
  MemoryRefusedError,
  MemoryUnavailableError,
  setMemoryClientForTests,
  type MemoryClient,
} from "../src/server/memory/memoryClient.js";
import { callTool, withTempDir } from "./helpers.js";
import { createFakeMemoryClient } from "./helpers/fakeMemory.js";

// ---------------------------------------------------------------------------
// Where the personal vault lives, on BOTH metacognition surfaces (#84).
//
// Home `repo` (no `personal_vaults` row): the frozen prompt append and
// describe_system are exactly what they were — also on a server that has a
// memory service and is set to migrate, as long as THIS owner was not moved.
// Home `memory`: the prompt states only what holds for a whole conversation
// (where the vault lived at its start, saved on write, what commit pushes);
// describe_system states the live rest — the home, whether the service answers
// right now, and the repository copy's state with what to do about it.
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

/** Move the owner's vault to the memory service (a fake one that answers). */
function moveToMemory(s: Setup) {
  const fake = createFakeMemoryClient();
  setMemoryClientForTests(s.store, fake);
  s.store.setPersonalVaultMemory(s.owner.id, { sourceRepo: "owner/brain", sourceCommit: null });
  return fake;
}

const lineOf = (report: string, label: string) => report.split("\n").find((line) => line.startsWith(`- ${label}:`)) ?? "";

/** The three lines describe_system can say about a vault; everything else in a report is not about it. */
const VAULT_LABELS = ["Personal vault", "Memory service", "Vault copy in the repository"];
const isVaultLine = (line: string) => VAULT_LABELS.some((label) => line.startsWith(`- ${label}:`));
const vaultLines = (report: string) => report.split("\n").filter(isVaultLine);
const withoutVaultLines = (report: string) => report.split("\n").filter((line) => !isVaultLine(line));

/** The ONE line a repo-home owner with a connected repository gets. */
const REPO_HOME_LINE =
  "- Personal vault: in the knowledge repository — the repository-root `CLAUDE.md` and every `.md` note under `wiki/` and `raw/` are files of that repository. " +
  "A note you write, edit, move or delete is changed only in Noah's working copy and is saved for good only when `mcp__repo__commit` pushes it " +
  '(a tool result that says "Not committed yet" is not saved yet)';

describe("vault home `repo`: the prompt is what it was, and describe_system gains exactly one line", () => {
  it("nothing changes when the server gains a memory service and a migration target; only the row does", async () => {
    const s = setup("repo-unchanged");
    const before = {
      owner: await promptOf(s, s.ownerRequest),
      teammate: await promptOf(s, s.teammateRequest),
      report: await describeSystem(s),
    };
    // The pins that the wording for the other home must never touch.
    expect(before.owner).toContain("Changes from these write tools are **not pushed until you call `mcp__repo__commit`**");
    expect(before.owner).toContain("Brain edits are not pushed until you commit.");
    expect(before.owner).not.toContain("memory service");
    // describe_system says where the vault is — ONE line, the exact text, and no other vault line.
    expect(vaultLines(before.report)).toEqual([REPO_HOME_LINE]);
    // It sits with the knowledge lines, right after the brain line.
    const lines = before.report.split("\n");
    expect(lines[lines.indexOf(REPO_HOME_LINE) - 1]).toMatch(/^- Second brain \(personal\): active/);

    // A memory service is configured and the instance is set to migrate — this owner just was not moved (yet).
    const fake = createFakeMemoryClient();
    setMemoryClientForTests(s.store, fake);
    s.store.setPersonalVaultMode("memory");
    expect(summarizeOwnerState(s.store, s.config, s.owner.id).vault).toEqual({
      home: "repo",
      migratedAt: null,
      mirror: null,
      serviceConfigured: true,
    });

    expect(await promptOf(s, s.ownerRequest)).toBe(before.owner);
    expect(await promptOf(s, s.teammateRequest)).toBe(before.teammate);
    expect(await describeSystem(s)).toBe(before.report);
    // Nothing rides the request, and nobody asked the service anything.
    expect(await stamped(s, s.ownerRequest)).not.toHaveProperty("vaultHome");
    expect(fake.calls).toEqual([]);

    // And it is the row, nothing else, that changes them — and in describe_system ONLY the vault lines:
    // every other line of the report is the same for both homes.
    s.store.setPersonalVaultMemory(s.owner.id, { sourceRepo: "owner/brain", sourceCommit: null });
    expect(await promptOf(s, s.ownerRequest)).not.toBe(before.owner);
    const moved = await describeSystem(s);
    expect(vaultLines(moved)).toHaveLength(3);
    expect(withoutVaultLines(moved)).toEqual(withoutVaultLines(before.report));
    s.store.clearPersonalVault(s.owner.id);
    expect(await promptOf(s, s.ownerRequest)).toBe(before.owner);
    expect(await describeSystem(s)).toBe(before.report);
  });

  it("without a connected repository there is no vault and no vault line", async () => {
    const s = setup("repo-none");
    const connected = await describeSystem(s);
    s.store.setKnowledgeRepo(s.owner.id, null, null);
    const report = await describeSystem(s);
    expect(vaultLines(report)).toEqual([]);
    expect(report).toContain("Second brain (personal): inactive");
    // The line is the only vault difference a connected repository makes.
    expect(vaultLines(connected)).toEqual([REPO_HOME_LINE]);
    expect(await promptOf(s, s.ownerRequest)).not.toContain("memory service");
  });
});

describe("vault home `memory`: the frozen prompt states the home and save-on-write, nothing live", () => {
  it("owner: where the vault lives, saved when written, what commit pushes — and still 'commit after writing'", async () => {
    const s = setup("memory-prompt-owner");
    moveToMemory(s);
    expect(await stamped(s, s.ownerRequest)).toMatchObject({ vaultHome: "memory" });
    const p = await promptOf(s, s.ownerRequest);

    expect(p).toContain("**Where your vault lives**: when this conversation started, your personal vault");
    expect(p).toContain("was stored in Noah's memory service, not in the git repository");
    expect(p).toContain("A vault note is SAVED the moment its write, edit, move or delete succeeds — it needs no commit to exist");
    expect(p).toContain("`mcp__repo__commit` pushes that copy now, together with your other repository changes, so commit after writing as before");
    expect(p).toContain("A vault note edited directly in git is NOT read back");
    expect(p).toContain("that is an outage, never an empty brain");
    expect(p).toContain("`mcp__system__describe_system` reports where it is now");
    // The sentences that are false for this home are replaced, not left standing next to the new ones.
    expect(p).not.toContain("Changes from these write tools are **not pushed until you call `mcp__repo__commit`**");
    expect(p).not.toContain("Brain edits are not pushed until you commit.");
    expect(p).toContain("Repository files outside your vault (skills, plugins, non-markdown files) are **not pushed until you call `mcp__repo__commit`**");
    expect(p).toContain("A brain note is saved the moment you write it; commit after a brain edit all the same");
    // The rest of the brain guidance is untouched.
    expect(p).toContain("Second brain");
    expect(p).toContain("states the CURRENT truth only");
  });

  it("carries no live fact: the mirror's state never reaches the prompt", async () => {
    const s = setup("memory-prompt-frozen");
    moveToMemory(s);
    const clean = await promptOf(s, s.ownerRequest);
    s.store.markVaultMirrorDirty(s.owner.id);
    s.store.recordVaultMirror(s.owner.id, { ok: false, error: "push rejected: protected branch" });
    s.store.setVaultMirrorHold(s.owner.id, "confirm");
    const behind = await promptOf(s, s.ownerRequest);
    expect(behind).toBe(clean);
    expect(behind).not.toContain("push rejected");
    expect(behind).not.toContain("WAITING FOR THE OWNER");
  });

  it("a teammate and a consultation hear where the notes are and that an outage is not an empty brain — never the write facts", async () => {
    const s = setup("memory-prompt-readers");
    moveToMemory(s);
    const teammate = await promptOf(s, s.teammateRequest);
    expect(teammate).toContain("**Where the owner's vault lives**: when this conversation started, the owner's personal vault");
    expect(teammate).toContain("If a tool reports that the memory service is unavailable, that is an outage, never an empty brain");
    expect(teammate).not.toContain("A vault note is SAVED the moment");
    expect(teammate).not.toContain("do not write the note somewhere else instead");

    const consultation = await promptOf(s, {
      ...s.teammateRequest,
      avatarConsultation: true,
      headless: true,
      allowHeadlessTools: true,
    });
    expect(consultation).toContain("**Where the owner's vault lives**");
    expect(consultation).not.toContain("A vault note is SAVED the moment");

    // A shared account lets the teammate write, so they get the writer's facts — but NOT the promise that
    // describe_system reports the vault: a non-owner's describe_system carries no owner state (below).
    s.store.updateProfile(s.owner.id, { sharedAccount: true });
    const shared = await promptOf(s, s.teammateRequest);
    expect(shared).toContain("**Where the owner's vault lives**: when this conversation started, the owner's personal vault — ");
    expect(shared).not.toContain("**Where your vault lives**");
    expect(shared).not.toContain("`mcp__system__describe_system` reports where it is now");
    expect(shared).toContain("Each write's tool result says where that note went; if a result and this paragraph differ, the result is right.");
    expect(shared).toContain("do not write the note somewhere else instead");
    expect(shared).toContain("A vault note is SAVED the moment");
    expect(shared).toContain("(a vault note is saved when written, and the commit pushes the repository's copy of it together with every other change)");
    expect(shared).not.toContain("(changes are not pushed until you commit)");
  });
});

describe("vault home `memory`: describe_system states the live facts", () => {
  it("the home, the service answering, and each state of the repository copy", async () => {
    const s = setup("memory-describe");
    const fake = moveToMemory(s);
    const migratedAt = s.store.getPersonalVault(s.owner.id)!.migratedAt;

    // Clean, never pushed since the move.
    let report = await describeSystem(s);
    expect(lineOf(report, "Personal vault")).toContain(`in Noah's memory service (since ${migratedAt})`);
    expect(lineOf(report, "Personal vault")).toContain("a vault note is SAVED the moment its write, edit, move or delete succeeds — it needs no commit to exist");
    expect(lineOf(report, "Personal vault")).toContain("so commit after writing as before");
    expect(lineOf(report, "Memory service")).toBe("- Memory service: reachable right now (it answered a listing of this vault)");
    expect(lineOf(report, "Vault copy in the repository")).toContain(
      "up to date — nothing has been pushed since the vault moved to the memory service, and the repository holds the notes as they were then",
    );
    // ONE cheap call, as this owner.
    expect(fake.calls).toEqual([{ op: "list", owner: s.owner.id, prefix: "raw" }]);
    // The lines that were there stay.
    expect(report).toContain("- Knowledge repository: owner/brain @ main");
    expect(report).toContain("Second brain (personal): active");

    // Behind: a note was written since the last push.
    s.store.markVaultMirrorDirty(s.owner.id);
    report = await describeSystem(s);
    const behind = lineOf(report, "Vault copy in the repository");
    expect(behind).toContain("BEHIND — vault notes changed since the last push are saved in the memory service but not yet in the repository");
    expect(behind).toContain("Call `mcp__repo__commit` to push the copy now");

    // Pushed.
    s.store.recordVaultMirror(s.owner.id, { ok: true });
    const syncedAt = s.store.getPersonalVault(s.owner.id)!.mirrorSyncedAt;
    report = await describeSystem(s);
    expect(lineOf(report, "Vault copy in the repository")).toContain(`up to date — the last successful push was ${syncedAt}.`);

    // The last push failed.
    s.store.markVaultMirrorDirty(s.owner.id);
    s.store.recordVaultMirror(s.owner.id, { ok: false, error: "push rejected: protected branch" });
    report = await describeSystem(s);
    const failed = lineOf(report, "Vault copy in the repository");
    expect(failed).toContain("BEHIND — the last attempt to push the copy FAILED (`push rejected: protected branch`)");
    expect(failed).toContain(`the last successful push was ${syncedAt}`);
    expect(failed).toContain("saved in the memory service but may be missing from the repository");
    expect(failed).toContain("Call `mcp__repo__commit` to push the copy now. If the commit fails too, report its error as it is");
    expect(failed).toContain("The notes stay saved either way, and Noah retries on its own.");

    // A failure a commit cannot fix does not send the avatar to commit.
    s.store.recordVaultMirror(s.owner.id, { ok: false, error: VAULT_MIRROR_ERROR.noToken });
    const noToken = lineOf(await describeSystem(s), "Vault copy in the repository");
    expect(noToken).toContain("No commit can push it either: the owner has no usable internal Git token (`GIT_TOKEN`)");
    expect(noToken).not.toContain("Call `mcp__repo__commit`");
    s.store.recordVaultMirror(s.owner.id, { ok: false, error: `${VAULT_MIRROR_ERROR.serviceUnavailable} (timeout)` });
    const serviceDown = lineOf(await describeSystem(s), "Vault copy in the repository");
    expect(serviceDown).toContain("A commit will not help while the memory service does not serve the vault");
    expect(serviceDown).not.toContain("Call `mcp__repo__commit`");

    // The background pass left a repository with other uncommitted work alone: the avatar's commit carries it.
    s.store.recordVaultMirror(s.owner.id, { ok: false, error: VAULT_MIRROR_ERROR.repoDirty });
    report = await describeSystem(s);
    expect(lineOf(report, "Vault copy in the repository")).toContain(
      "Call `mcp__repo__commit` to push the copy now: that error means the repository's working copy holds uncommitted changes outside the vault, which Noah's own background push never touches — your commit carries both",
    );

    // Hold, state 1: Noah has not looked at the newly connected repository yet — nothing to confirm.
    s.store.setVaultMirrorHold(s.owner.id, "checking");
    const checking = lineOf(await describeSystem(s), "Vault copy in the repository");
    expect(checking).toContain("CHECKING — a repository (or branch) was just connected or changed, and Noah has not looked at it yet");
    expect(checking).toContain("There is nothing to confirm and nothing for you or the owner to do");
    expect(checking).not.toContain("Only the owner can confirm");
    expect(checking).toContain("notes keep being saved in the memory service");

    // Hold, state 2: it holds vault notes the copy would replace — only the owner can confirm, in settings.
    s.store.setVaultMirrorHold(s.owner.id, "confirm");
    const confirm = lineOf(await describeSystem(s), "Vault copy in the repository");
    expect(confirm).toContain("WAITING FOR THE OWNER — Noah looked at the connected repository and it holds vault notes of its own");
    expect(confirm).toContain("Nothing there has been overwritten.");
    expect(confirm).toContain("Only the owner can confirm, in 설정 → 지식·플러그인 → 지식 저장소");
    expect(confirm).toContain("you have no tool for it");
    expect(confirm).toContain("notes keep being saved in the memory service");
    expect(confirm).not.toContain("CHECKING");

    // Every state says the copy is one-way.
    const base = { dirty: false, syncedAt: null, error: null, notice: null, hold: null };
    for (const mirror of [
      base,
      { ...base, dirty: true },
      { ...base, dirty: true, syncedAt: "2026-11-17T00:00:00.000Z", error: "x" },
      { ...base, hold: "checking" as const },
      { ...base, hold: "confirm" as const },
    ]) {
      expect(vaultMirrorStateText(mirror)).toContain("a vault note edited directly in git is not read back and is replaced by the next push");
    }
    // A failure text this table does not know gets the generic next step, never silence.
    expect(vaultMirrorStateText({ ...base, dirty: true, error: "something new: detail" })).toContain(
      "Call `mcp__repo__commit` to push the copy now. If the commit fails too, report its error as it is",
    );
  });

  it("a notice from the last push is said in plain words: repository notes the service does not hold, nothing deleted", async () => {
    const s = setup("memory-notice");
    moveToMemory(s);
    s.store.recordVaultMirror(s.owner.id, { ok: true, notice: "3 repository notes are not in the memory service" });
    const line = lineOf(await describeSystem(s), "Vault copy in the repository");
    expect(line).toContain("up to date — the last successful push was");
    expect(line).toContain("Notice from the last successful push: `3 repository notes are not in the memory service`");
    expect(line).toContain("the repository holds vault notes that the memory service does not");
    expect(line).toContain("Noah deleted NOTHING");
    expect(line).toContain("they are not part of the brain — search and read do not see them");
    // It stays while the copy is behind, and goes when a later push has nothing to say.
    s.store.markVaultMirrorDirty(s.owner.id);
    expect(lineOf(await describeSystem(s), "Vault copy in the repository")).toContain("Notice from the last successful push");
    s.store.recordVaultMirror(s.owner.id, { ok: true });
    expect(lineOf(await describeSystem(s), "Vault copy in the repository")).not.toContain("Notice from the last successful push");
  });

  it("with no repository connected the notes are there but unreachable, and no tool that refuses is named", async () => {
    const s = setup("memory-no-repo");
    moveToMemory(s);
    s.store.markVaultMirrorDirty(s.owner.id);
    s.store.setKnowledgeRepo(s.owner.id, null, null);

    const report = await describeSystem(s);
    const vault = lineOf(report, "Personal vault");
    expect(vault).toContain("in Noah's memory service (since ");
    expect(vault).toContain("with NO knowledge repository connected");
    expect(vault).toContain("NOT reachable through your tools while no knowledge repository is connected");
    expect(vault).toContain("Nothing was lost, so never tell the owner their brain is empty");
    expect(vault).not.toContain("The same tools and paths apply");
    const copy = lineOf(report, "Vault copy in the repository");
    expect(copy).toContain("none right now — no knowledge repository is connected");
    for (const line of [vault, copy]) {
      expect(line).not.toContain("mcp__repo__commit");
      expect(line).not.toContain("mcp__repo__*");
    }
    // The service is still asked: whether the notes are safe is the question now.
    expect(lineOf(report, "Memory service")).toContain("reachable right now");

    // The frozen prompt of a conversation started in this state says the same, next to "no repository yet".
    const p = await promptOf(s, s.ownerRequest);
    expect(p).toContain("You do not have a knowledge repository yet");
    expect(p).toContain("Your personal vault outlived the repository:");
    expect(p).toContain("NOT reachable through your tools while no knowledge repository is connected");
    expect(p).not.toContain("**Where your vault lives**");
    expect(p).not.toContain("The same tools and paths apply");
    // An owner whose vault is the repository hears none of it.
    s.store.clearPersonalVault(s.owner.id);
    expect(await promptOf(s, s.ownerRequest)).not.toContain("outlived the repository");
  });

  it("a service that cannot be used is UNREACHABLE — never an empty brain", async () => {
    const s = setup("memory-unreachable");
    const fake = moveToMemory(s);

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

    // The row says memory, the server has no service: every vault call fails, and the report says why.
    setMemoryClientForTests(s.store, null);
    const report = await describeSystem(s);
    expect(lineOf(report, "Memory service")).toContain(
      "UNREACHABLE right now (this server has no memory service configured — an operator sets PI_MEMORY_URL and PI_MEMORY_API_KEY_FILE)",
    );
    // The home and the copy's state are still reported — they are Noah's own facts.
    expect(lineOf(report, "Personal vault")).toContain("in Noah's memory service");
    expect(lineOf(report, "Vault copy in the repository")).toContain("up to date");
    expect(summarizeOwnerState(s.store, s.config, s.owner.id).vault.serviceConfigured).toBe(false);
  });

  it("a service that never answers does not hold the report", async () => {
    const s = setup("memory-hang");
    moveToMemory(s);
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
    const s = setup("memory-non-owner");
    const fake = moveToMemory(s);
    s.store.setVaultMirrorHold(s.owner.id, "confirm");
    const report = await describeSystem(s, { viewerIsOwner: false });
    expect(vaultLines(report)).toEqual([]);
    expect(report).not.toContain("WAITING FOR THE OWNER");
    expect(fake.calls).toEqual([]);
    // The same for an owner whose vault is the repository: the one line is owner state too.
    s.store.clearPersonalVault(s.owner.id);
    expect(vaultLines(await describeSystem(s, { viewerIsOwner: false }))).toEqual([]);
  });
});

describe("standing text that every owner shares is true for both homes", () => {
  const skill = (name: string) =>
    fs.readFileSync(path.join(process.cwd(), "default-skills", "skills", name, "SKILL.md"), "utf8").replace(/\s+/g, " ");

  it("the skills keep 'commit after writing' and no longer say an uncommitted write is not saved", () => {
    const ingest = skill("brain-ingest");
    expect(ingest).toContain("**Always commit** after writing (`mcp__repo__commit`) — the commit is what pushes the capture to the repository");
    // One text, true for both homes: which result means saved and which does not.
    expect(ingest).toContain('a result that says "Not committed yet" is NOT saved until `mcp__repo__commit` succeeds');
    expect(ingest).toContain('a result that says the vault note "is saved now" is saved, and the commit pushes its copy');
    const backfill = skill("knowledge-backfill");
    expect(backfill).toContain("capture is a repo write plus a commit, and the commit is never skipped");
    for (const name of ["brain-ingest", "brain-reflect", "brain-lint", "brain-migrate", "brain-search", "brain-share", "knowledge-backfill"]) {
      expect(skill(name), name).not.toContain("an uncommitted write is not persisted");
      expect(skill(name), name).not.toMatch(/not (persisted|saved) until you commit/);
    }
    // A service outage is not an empty brain, on the read side and in the consolidation pass.
    expect(skill("brain-search")).toContain("**Memory service unavailable** — an outage, not an empty brain");
    expect(skill("brain-reflect")).toContain("an outage, not an empty vault: stop the pass and say so");
    // The skills state no home of their own: where a vault lives is said per owner, elsewhere.
    for (const name of ["brain-ingest", "knowledge-backfill"]) expect(skill(name), name).not.toContain("memory service");
  });

  it("the repository template says the same for both, and that the vault paths can be a copy", async () => {
    const dir = path.join(tempDir, "template");
    fs.mkdirSync(dir, { recursive: true });
    expect(await writeRepoTemplate(dir, "owner/brain")).toBe(true);
    const claudeMd = fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").replace(/\s+/g, " ");
    expect(claudeMd).not.toContain("An edit is not persisted until you commit");
    expect(claudeMd).toContain("Commit after you edit: `mcp__repo__commit` is what pushes your changes to this repository.");
    expect(claudeMd).toContain("in this repository, or in Noah's memory service with this repository holding a COPY that Noah pushes");
    expect(claudeMd).toContain("a note edited directly in git is not read back and is replaced by the next push");
    expect(claudeMd).toContain("In the owner's own conversations `mcp__system__describe_system` says which; each write's tool result says whether it is saved.");
    // Standing memory is capped at 6,000 characters; the template stays far below it.
    expect(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8").length).toBeLessThan(3000);
    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    expect(readme).toContain("메모리 서비스");
    expect(readme).toContain("**사본**");
    expect(readme).not.toContain("pi-gateway");
  });

  it("the manual explains both homes under one instruction", () => {
    const manual = readSystemManual("knowledge").text;
    expect(manual).toContain("## Where the vault lives");
    expect(manual).toContain('a result that says "Not committed yet" is NOT saved until mcp__repo__commit succeeds');
    expect(manual).toContain('a result that says the vault note "is saved now" is saved, and the commit pushes its copy');
    expect(manual).toContain("commit after writing, and never report as saved what the results do not say is saved");
    // What describe_system reports is promised to the owner only.
    expect(manual).toContain("In the owner's own runs mcp__system__describe_system says which (a non-owner's describe_system reports no owner state)");
    expect(manual).toContain("a vault note is saved the moment its write, edit, move or delete succeeds and needs no commit to exist");
    expect(manual).toContain("that is an outage, not an empty brain");
    expect(manual).toContain("is looked at first, and nothing is copied into it meanwhile");
    expect(manual).toContain("WAITS until the owner confirms in settings");
    expect(manual).toContain("With no repository connected the notes stay in the memory service but the repository and brain tools refuse");
    expect(manual).not.toContain("Uncommitted local files are not persisted");
    expect(manual).not.toContain("pi-gateway");
  });
});
