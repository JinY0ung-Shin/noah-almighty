import type {
  AgentRequest,
  AgentRewindInfo,
  AppConfig,
  PiSandboxOwner,
  SharedMcpRunState,
} from "../types.js";
import { kstDateString } from "../routineSchedule.js";
import { memoryClientFor } from "../memory/memoryClient.js";
import { vaultHomeOf, type VaultHome } from "../personalVault.js";
import { VAULT_MIRROR_ERROR } from "../vaultMirror.js";
import type { BrowserSecretPolicy } from "../secretPolicy.js";
import type { Store } from "../store.js";
import type { TodoSnapshot } from "../../shared/todos.js";
import { CHAT_DOCUMENT_EXTENSIONS, CHAT_DOCUMENT_SANDBOX_DIR } from "../../shared/chatDocuments.js";

/**
 * Structured, UNFORMATTED snapshot of an avatar owner's current system self-state.
 *
 * The root CLAUDE.md mandates that buildPrompt's owner self-state (promptBuilder.ts)
 * and the `describe_system` tool (systemTools.ts) report the SAME runtime facts.
 * This is the single place that reads those facts from the live `store` + `config`
 * so the two call sites can't drift in WHAT they read; each caller still FORMATS
 * the data its own way (buildPrompt → English prompt paragraphs, gated by
 * ownerToolAccess; describe_system → its tool-result text). Returning raw data
 * only — never formatted strings — keeps both existing outputs byte-identical.
 *
 * NOTE on gating: this returns the ungated facts (e.g. full `secretNames`,
 * `teammateCount`). buildPrompt blanks `secretNames` to `[]` and leaves
 * `teammateCount` unset unless `ownerToolAccess`; describe_system always reads them live (it only runs for the
 * owner). That gating stays at the call sites, not here.
 *
 * NOTE on Confluence: the two sites compute `confluencePatConfigured` from
 * DIFFERENT sources (buildPrompt from the actual decrypted secret VALUES it
 * already holds; describe_system from secret-NAME presence). This module exposes
 * `secretNames` only and leaves the Confluence derivation to each caller, so
 * neither output changes.
 *
 * NOTE on model: there is no owner-independent model fact here any more — the
 * admin model override is retired (pi-gateway's admin LLM page picks the
 * default model), so a run's model is the composer pick or the default (pi's
 * `falcon` tier, else pi's own default), both
 * known to describe_system from its own context.
 */
/**
 * The copy of a `memory`-home vault that Noah pushes into the owner's
 * repository (`vaultMirror.ts`), as the `personal_vaults` row records it.
 */
export interface OwnerVaultMirrorState {
  /** A vault note changed since the last successful push. */
  dirty: boolean;
  /** ISO time of the last successful push; null = none since the vault moved. */
  syncedAt: string | null;
  /** The last attempt's failure (a short English code or message); null when it worked. */
  error: string | null;
  /**
   * What the last successful push has to tell the owner (the repository holds
   * vault notes the memory service does not); null = nothing.
   */
  notice: string | null;
  /**
   * Why Noah is not writing the vault into the connected repository (null = it
   * may): `checking` — a repository or branch was just connected or changed and
   * Noah has not looked at it yet; `confirm` — it holds vault notes the copy
   * would replace, and only the owner can confirm.
   */
  hold: "checking" | "confirm" | null;
}

/** Where the owner's personal vault lives (`personalVault.ts`) and, for `memory`, what its repository copy is doing. */
export interface OwnerVaultState {
  /** `repo`: the knowledge repository is the vault, as it always was. `memory`: the memory service is. */
  home: VaultHome;
  /** `memory` only: when the vault moved there (ISO). */
  migratedAt: string | null;
  /** `memory` only: the repository copy's state. */
  mirror: OwnerVaultMirrorState | null;
  /** Whether THIS server has a memory service to call (`config.memory`). False with home `memory` = every vault call fails. */
  serviceConfigured: boolean;
}

export interface OwnerState {
  /**
   * Where the owner's personal vault lives. The prompt (frozen per
   * conversation) states only `home`; describe_system states the rest live,
   * plus whether the service answers right now (its own probe — not a fact
   * of the store, so not read here).
   */
  vault: OwnerVaultState;
  /** Active personal keys for the external task API (POST /api/v1/avatar/tasks). */
  avatarApiKeyCount: number;
  /** Whether the owner has connected a personal knowledge repo (repo set). */
  knowledgeRepoConfigured: boolean;
  /** Raw knowledge-repo connection (null when none); describe_system shows `@ branch`. */
  knowledgeRepo: { repo: string | null; branch: string | null };
  /** Whether the internal GIT_TOKEN is stored. */
  gitTokenSet: boolean;
  /** Names of the owner's configured secret-tab env vars (values never included). */
  secretNames: string[];
  /** Subset of `secretNames` opted into agent-shell exposure (per-key toggle). */
  shellExposedSecretNames: string[];
  /**
   * Secrets opted into BROWSER INPUT (per-key 브라우저 입력 toggle), with the
   * hosts each may be typed on and whether it is password-fields-only. Values
   * never included — the model gets the NAME to pass as `secretName`. Only
   * currently-usable policies appear, so both metacognition surfaces can state
   * them as fact.
   */
  browserSecrets: BrowserSecretPolicy[];
  /**
   * Active teammates of the owner: approved (not suspended) users other than
   * the owner. Noah serves ONE team, so this is the whole reach of the avatar
   * (who may see it unless it is private, and who is mutually trusted) and the
   * ask_avatar gate (0 → nobody to consult).
   */
  teammateCount: number;
  /**
   * Teammates whose avatar the owner's avatar can REACH (active, not private —
   * `store.countReachableTeammates`). Gates ask_avatar on all three
   * hand-synced sites; `teammateCount` stays the team size.
   */
  reachableTeammateCount: number;
  /** Number of general (work/code) git repos the owner has registered. */
  gitRepoCount: number;
  /** Pending knowledge (request_info) gaps in the owner's inbox. */
  openRequestCount: number;
  /** Skills shared by visible teammates that this owner could learn (#skill-share). */
  learnableSkillCount: number;
  /** Skills this owner currently shares from their knowledge repo. */
  sharedSkillCount: number;
  /** Total times teammates learned this owner's skills (전수된 횟수, all skills). */
  sharedSkillLearnTotal: number;
  /** Experimental (beta) feature keys the owner enabled for this avatar (#50). */
  experimentalFeatures: string[];
  /**
   * Shared (communal) account flag: trusted teammates may also WRITE
   * to the owner's personal knowledge repo (see repoTools.ts `writeAccess`).
   */
  sharedAccount: boolean;
  /**
   * The owner's LIVE 할 일 counts against TODAY in KST, with that date.
   * describe_system is its ONLY reader, by design — a deliberate exception to
   * "an OwnerState fact feeds BOTH consumers": a per-turn append that changes
   * breaks prompt caching, so the prompt states the capability (`todoState`)
   * plus the list FROZEN at the conversation's first to-do-capable turn
   * (agent/todoSnapshot.ts), never these live numbers.
   */
  todos: TodoSnapshot;
}

/**
 * Read the owner's current system self-state from the live store + config.
 * Pure read — no mutation. `avatarUserId` is the avatar's own user id (== owner).
 */
export function summarizeOwnerState(
  store: Store,
  config: AppConfig,
  avatarUserId: string,
): OwnerState {
  const knowledgeRepo = store.getKnowledgeRepo(avatarUserId);
  // One row read, eager: both surfaces need the home. `vaultHomeOf` stays the
  // one answer to "where does it live" — the row only adds the mirror facts.
  const vaultHome = vaultHomeOf(store, avatarUserId);
  const vaultRow = vaultHome === "memory" ? store.getPersonalVault(avatarUserId) : null;
  return {
    vault: {
      home: vaultHome,
      migratedAt: vaultRow?.migratedAt ?? null,
      mirror: vaultRow
        ? {
            dirty: vaultRow.mirrorDirty,
            syncedAt: vaultRow.mirrorSyncedAt,
            error: vaultRow.mirrorError,
            notice: vaultRow.mirrorNotice,
            hold: vaultRow.mirrorHold,
          }
        : null,
      serviceConfigured: memoryClientFor(store, config) !== null,
    },
    // Eager like every other field here: the key list is capped per owner, so
    // one small read is cheaper than the getter it replaced (which re-queried on
    // every access, and hid the read from `{...state}` spreads).
    avatarApiKeyCount: store.listAvatarApiKeys(avatarUserId).length,
    knowledgeRepoConfigured: Boolean(knowledgeRepo.repo),
    knowledgeRepo: { repo: knowledgeRepo.repo, branch: knowledgeRepo.branch },
    gitTokenSet: Boolean(store.getGitToken(avatarUserId)),
    secretNames: store.listUserSecretNames(avatarUserId),
    shellExposedSecretNames: store.listShellExposedSecretNames(avatarUserId),
    browserSecrets: store.listBrowserSecretPolicies(avatarUserId),
    teammateCount: store.countTeammates(avatarUserId),
    reachableTeammateCount: store.countReachableTeammates(avatarUserId),
    // Lazy: only describe_system reads these; the prompt (buildSystemPromptAppend) path
    // never accesses them, so defer the store queries until a consumer reads them.
    get gitRepoCount() {
      return store.listGitRepos(avatarUserId).length;
    },
    get openRequestCount() {
      return store.countOpenKnowledgeRequests(avatarUserId);
    },
    // Lazy like the counts above: read by owner-driven prompts + describe_system.
    get learnableSkillCount() {
      return store.countLearnableSkills(avatarUserId);
    },
    get sharedSkillCount() {
      return store.listSharedSkillsByOwner(avatarUserId).length;
    },
    // Lazy; only describe_system reads it (gitRepoCount precedent).
    get sharedSkillLearnTotal() {
      return store.countSkillLearnsForOwner(avatarUserId);
    },
    experimentalFeatures: store.getExperimentalFeatures(avatarUserId),
    sharedAccount: store.isSharedAccount(avatarUserId),
    // Lazy like the counts above: only describe_system reads it (the prompt stays static).
    get todos() {
      const todayKst = kstDateString();
      return { todayKst, counts: store.countTodos(avatarUserId, todayKst) };
    },
  };
}

/** A high-impact setup step the owner has not completed yet. */
export type GettingStartedGapId = "repo" | "gitToken";

/**
 * The owner's unfinished setup, most impactful first. Facts only — no prose and
 * no labels: `buildSystemPromptAppend` turns these ids into its standing
 * "you may offer to fix this ONCE" guidance and `describe_system` into its own
 * state line, each formatting its own way (the ownerState.ts contract above).
 *
 * Deliberately only TWO ids. Both keep whole capability families dark — with no
 * repository the avatar has no memory, no skills, and nowhere to capture; with
 * no token it can neither create a repository nor commit/push one. Counts that
 * could merely be HIGHER (secrets, plugins, shared/learnable skills, teammates) are
 * not gaps: an avatar that recites everything its owner has not done yet nags.
 *
 * Takes the two flags rather than a whole OwnerState so the prompt builder can
 * call it with the same facts riding on `AgentRequest` — the derivation stays
 * HERE, at the sync point, instead of being re-implemented per consumer.
 */
export function gettingStartedGaps(
  state: Pick<OwnerState, "knowledgeRepoConfigured" | "gitTokenSet">,
): GettingStartedGapId[] {
  const gaps: GettingStartedGapId[] = [];
  if (!state.knowledgeRepoConfigured) {
    gaps.push("repo");
  }
  if (!state.gitTokenSet) {
    gaps.push("gitToken");
  }
  return gaps;
}

/**
 * Whose sandbox a run's built-in tools work in (`PiRuntimeFacts.sandboxOwner`),
 * ONE text for both metacognition surfaces (the prompt's runtime section and
 * describe_system's runtime line). Empty for the owner's own runs: "this
 * user's sandbox" already says it. A colleague's run is also READ-ONLY
 * (`readOnlyBuiltins` is true exactly then), and this sentence says so.
 */
export function piSandboxOwnerSentence(owner: PiSandboxOwner | undefined): string {
  if (owner === "viewer") {
    return "This sandbox belongs to the person you are talking to, a colleague — NOT to the avatar owner — and this session is READ-ONLY there: your only built-in tools are `read`, `ls`, `find` and `grep` (pi left out `write`, `edit` and `bash`), they see only that colleague's own files, never the owner's, and you cannot create or change a file or run a program in this conversation. Put what you produce in your reply instead; for work that needs a shell or a new file, the colleague can ask their OWN avatar. The owner's knowledge and repositories are reachable only through the Noah tools this run lists, which refuse anything reserved for the owner.";
  }
  if (owner === "nobody") {
    return "This consultation runs in a FRESH, EMPTY, temporary sandbox created for this one run and owned by nobody — neither your owner's nor the asking teammate's: it starts with no files and no secrets (no 셸 노출 secret reaches a consultation's shell), nothing you write there reaches the answer, and it is deleted when the run ends. Answer from your owner's knowledge through the Noah recall tools this run lists.";
  }
  return "";
}

/** "pdf, docx, xlsx, pptx, csv, txt, md, json" — from the shared contract, so neither surface drifts from the route. */
export const DOCUMENT_TYPES_PHRASE = CHAT_DOCUMENT_EXTENSIONS.join(", ");

/** The sandbox image's Python libraries for reading documents (pi `images/sandbox/Dockerfile`). */
export const DOCUMENT_LIBRARIES_PHRASE = "pypdf, python-docx, python-pptx, openpyxl, pandas";

/**
 * The HTTP libraries Noah's sandbox image adds for the avatar's own scripts
 * (`docker/pi-sandbox/requirements.txt`), ONE sentence for the prompt append
 * and describe_system. Said only when `PiRuntimeFacts.httpLibraries` holds.
 * They are no way around the egress allowlist, and the sentence says so.
 */
export const SANDBOX_HTTP_LIBRARIES_SENTENCE =
  "Python in your shell has `requests` and `urllib3` for HTTP(S) calls: they leave through the same egress proxy and allowlist as curl (a refused destination is the same `407`), and verify TLS against the sandbox's system CA bundle.";

/**
 * A text attachment's encoding is not checked at intake (the fleet's Excel
 * exports are often CP949/EUC-KR), so every place that tells the avatar to read
 * an attached file carries this clause.
 */
export const DOCUMENT_ENCODING_CLAUSE =
  'a csv or text file may be CP949/EUC-KR (common for Korean Excel exports) rather than UTF-8 — if UTF-8 decoding fails, read it with `encoding="cp949"`';

/**
 * Where a user-attached document lands and how long it stays — ONE text for
 * both metacognition surfaces (the frozen prompt's attached-documents note and
 * describe_system's line). pi writes the file; the folder is per USER, not per
 * conversation (user decision 2026-11-11).
 */
export const DOCUMENT_UPLOADS_SENTENCE =
  `each one is saved at \`${CHAT_DOCUMENT_SANDBOX_DIR}/<filename>\` in your sandbox before the turn starts, and the message names its path. ` +
  `\`${CHAT_DOCUMENT_SANDBOX_DIR}/\` is kept between conversations and shared by all of this user's conversations, and a later file with the same name REPLACES the earlier one — if that matters, copy the file into this conversation's folder. ` +
  `Read an attached document with the sandbox's Python libraries (${DOCUMENT_LIBRARIES_PHRASE}) instead of asking the user to paste it; ${DOCUMENT_ENCODING_CLAUSE}`;

/**
 * pi's built-in subagents (pi `agent/subagents.ts`): every pi session has the
 * `Agent` and `SendMessage` tools with a `general-purpose` subagent, whether or
 * not a plugin ships one. ONE text for describe_system's line and the manual.
 */
export const PI_SUBAGENT_SENTENCE =
  "the built-in `Agent` tool starts a `general-purpose` subagent (plus any agent a loaded plugin ships) that works on its own in this same sandbox with the same tools you have, and `SendMessage` continues one by its agent_id. " +
  "It does not see this conversation, so put everything it needs in the prompt; only its final report comes back, which keeps long intermediate work (reading many files, running many commands) out of this conversation. " +
  "A subagent cannot ask the user anything, cannot show or share files with them, and cannot start another subagent";

/**
 * A run nobody can answer (`PiRuntimeFacts.nonInteractive`: a scheduled
 * routine, an avatar consultation, a profile generator) has a pi session
 * started `interactive: false`, so AskUserQuestion is not among its tools.
 * ONE text for both metacognition surfaces (the prompt's per-turn run-kind
 * note and describe_system's runtime line).
 */
export const PI_NO_ASK_USER_SENTENCE =
  "`AskUserQuestion` is not available in this run: its session was started without it because nobody can answer.";

/** The run facts inline UI is decided on (`AgentRequest` and `SystemToolsContext` both carry them). */
export type InlineUiRun = Pick<AgentRequest, "headless" | "externalTaskApi" | "avatarConsultation">;

/**
 * Whether a run's ANSWER TEXT may carry inline UI (`src/shared/widget/guide.ts`:
 * tags the viewer's app draws in place while the answer streams): only an
 * interactive chat turn a person is watching in the app. Never a headless run
 * (a routine or a profile generator — nobody watches the stream), never an
 * external-task-API turn (the calling system reads the answer as text), never
 * an avatar consultation (the answer goes to another avatar) — the
 * interactive-only gate every such capability carries (`headless` AND
 * `externalTaskApi`). It depends on no tool group and no flag, and holds for
 * every viewer class. ONE function for the capability plan
 * (`AgentRequest.inlineUiEnabled`) and whatever else has to agree with it.
 */
export function inlineUiAllowed(run: InlineUiRun): boolean {
  return !run.headless && !run.externalTaskApi && !run.avatarConsultation;
}

/**
 * A LIVE chat run: a person sent this turn from the chat screen and reads the
 * answer as it streams — never a routine, a task-API turn or a consultation.
 * Decided by the server when the run starts (the model cannot claim it). In such
 * a run `notify_user` is refused (2026-11-16, the user's call: the avatar left
 * notifications while the owner was reading the very chat) — what the owner
 * needs to know goes in the answer.
 */
export function liveChatRun(run: InlineUiRun): boolean {
  return !run.headless && !run.externalTaskApi && !run.avatarConsultation;
}

/**
 * Why a run has no inline UI, by precedence consultation > external task >
 * unattended. ONE text for both metacognition surfaces (describe_system's
 * inline-UI line and the turn preamble's answer-format note).
 */
export function inlineUiUnavailableReason(run: InlineUiRun): string {
  if (run.avatarConsultation) {
    return "this is an avatar-to-avatar consultation, so the answer goes to another avatar as text, not to a person's screen";
  }
  if (run.externalTaskApi) {
    return "an external system submitted this turn and reads the answer as plain text";
  }
  if (run.headless) {
    return "this is an unattended run, so nobody is watching the answer being written in the app";
  }
  return "this run is not an interactive chat turn";
}

/**
 * What happens to a sandbox repo copy that open_repo or sync_repo REPLACES
 * (`ensurePiRepoCopy`, review R4). ONE text for both metacognition surfaces
 * (the prompt's working-repository note and describe_system's copy line) and
 * the open_repo tool description.
 */
export const PI_REPO_REPLACED_COPY_SENTENCE =
  "A copy that open_repo or sync_repo replaces is deleted only when it provably holds nothing but the commit it was made from (no edited, added or ignored files, links, stashes or sandbox commits); otherwise it is moved aside to a new `<name>.prev-<UTC stamp>` folder next to it, which stays until remove_repo removes the repository (that deletes the copy and every such folder) — move anything you still need out of it before then.";

/**
 * The owner's shell-secret state (pi `sandbox_env`, design P4), ONE text for
 * both metacognition surfaces (the prompt's secrets section and describe_system's
 * shell-secret line). `exported` is what this run's bash receives
 * (`PiRuntimeFacts.shellSecretNames`), `flagged` what the owner set to 셸 노출;
 * a flagged name pi refuses (sandbox-reserved, or past its size cap) is named
 * as not exported.
 */
export function shellSecretsSentence(exported: readonly string[], flagged: readonly string[]): string {
  const list = (names: readonly string[]) => names.map((name) => `\`${name}\``).join(", ");
  const withheld = flagged.filter((name) => !exported.includes(name));
  const parts: string[] = [];
  if (exported.length > 0) {
    parts.push(
      `${list(exported)} ${exported.length === 1 ? "is" : "are"} set to 셸 노출 and present as \`$NAME\` environment variables in every \`bash\` command of this run — use them INSIDE commands (e.g. \`curl -H "Authorization: Bearer $${exported[0]}"\`) and never print, echo or write a value: pi and Noah replace it with [REDACTED] in every tool result`,
    );
  }
  if (withheld.length > 0) {
    parts.push(
      `${list(withheld)} ${withheld.length === 1 ? "is" : "are"} set to 셸 노출 but NOT in the shell — the sandbox reserves that name (PATH, HOME, *_PROXY, LD_*, BASH*, LC_* and the like) or the shell's secret budget (64 names, 256 KiB) is full; the owner can rename the secret`,
    );
  }
  if (parts.length === 0) return "no secret is set to 셸 노출, so the sandbox shell holds none";
  return parts.join("; ");
}

/**
 * Turn PROVENANCE of a rewind (`AgentRequest.rewind`): the viewer edited an
 * earlier message or regenerated the latest answer. ONE text for both
 * metacognition surfaces — buildSystemPromptAppend's per-turn line and
 * describe_system's — so they cannot disagree about what the model can still
 * see or about what was NOT undone. Each surface adds its own label.
 */
export function rewindTurnState(rewind: AgentRewindInfo): string {
  const n = Math.max(0, Math.floor(rewind.discardedMessages));
  const edit = rewind.kind === "edit";
  const head = edit
    ? "The user went back to an earlier point in this conversation and re-sent one of their messages, edited — the message you are answering now. " +
      (n > 0
        ? `The ${n === 1 ? "1 message" : `${n} messages`} after it ${n === 1 ? "was" : "were"} deleted, and your context ends at that point`
        : "Your context ends at that point")
    : n > 0
      ? `The user discarded your previous answer to this message (${n === 1 ? "1 message" : `${n} messages`} deleted) and asked for a new one. Your context ends just before that answer`
      : "The user asked you to answer this message again. Your context ends just before your earlier attempt";
  // What the rewind itself removed: the discarded rows' chat attachments (the
  // route sweeps their images and file cards and revokes those cards' share
  // links). Everything outside the chat is exactly as those turns left it.
  const aftermath = edit
    ? "The discarded turns' chat attachments went with them — the files and images you showed or shared there were deleted, and those decks' share links revoked (links to decks in the kept messages still work). " +
      "Nothing else they did was undone: workspace and repository files, commits and pushes, browser actions, and any routines or shared skills they created remain as those turns left them."
    : "The discarded attempt's chat attachments went with it — the files and images it showed or shared were deleted, and those decks' share links revoked (links to decks in earlier messages still work). " +
      "Nothing else it did was undone: workspace and repository files, commits and pushes, browser actions, and any routines or shared skills it created remain as it left them.";
  return (
    `${head}: you cannot see what was discarded, so if the user refers to it, say so instead of guessing. ` +
    `${aftermath} Re-check that state before building on what you remember.`
  );
}

/**
 * 공용 MCP 서버 lines (`planSharedMcpRun` states) — ONE wording for both
 * metacognition surfaces: the prompt's standing section and describe_system.
 * Slot/secret names ride only owner runs (the plan strips them for everyone
 * else, like the prompt's secret-name list), so a teammate hears that
 * something is missing, never which. Noah relays every active one under the
 * `shared` broker id (`mcp__shared__<name>__<tool>`).
 */
export function sharedMcpServerLines(
  states: SharedMcpRunState[],
): string[] {
  const fix =
    "If the user wants it, tell them to open Settings → 권한·연결 → 시크릿, find this server under 공용 MCP 서버 and pick which of their own secrets to connect (adding the secret first if needed); it applies from their next message.";
  return states.map((state) => {
    const label = state.label && state.label !== state.name ? ` (${state.label})` : "";
    const about = state.description ? ` — ${state.description}` : "";
    const head = `\`${state.name}\`${label}${about}`;
    switch (state.status) {
      case "active":
        return `${head}: available in this run as \`mcp__shared__${state.name}__<tool>\` (relayed by Noah).`;
      case "needs_binding":
        if (state.unboundSlots.length === 0) {
          return `${head}: NOT available in this conversation — the avatar owner has not connected a secret to it.`;
        }
        return state.hostChanged
          ? `${head}: NOT available in this run — the admin moved it to a new address since the owner connected a secret, so the connection was reset (${state.unboundSlots.join(", ")}) and must be made again. ${fix}`
          : `${head}: NOT available in this run — the owner has not connected a secret to ${state.unboundSlots.map((slot) => `"${slot}"`).join(", ")}. ${fix}`;
      case "missing_secrets":
        return state.missingSecrets.length > 0
          ? `${head}: NOT available in this run — the secret(s) the owner connected (${state.missingSecrets.map((name) => `\`${name}\``).join(", ")}) are missing or unusable (a value must be a single line). ${fix}`
          : `${head}: NOT available in this conversation — a secret the avatar owner connected to it is missing.`;
      case "secrets_unavailable":
        return `${head}: NOT available in this conversation — it authenticates with personal secrets from a user's own vault, which this kind of run never carries.`;
    }
  });
}

/** What a personal vault IS, in the words both metacognition surfaces use. */
export const VAULT_NOTES_PHRASE = "the repository-root `CLAUDE.md` and every `.md` note under `wiki/` and `raw/`";

/**
 * A memory-service failure is an OUTAGE, never an empty brain — ONE rule for
 * the prompt's vault paragraph and describe_system's memory-service line.
 * `writes` adds the half that only a run able to write notes needs.
 */
export function vaultOutageRule(writes: boolean): string {
  return (
    "that is an outage, never an empty brain: tell the user, and do not answer as if nothing were known or as if no note existed" +
    (writes ? "; do not write the note somewhere else instead, and try again later rather than in a loop" : "")
  );
}

/**
 * The standing fact for a conversation whose owner's vault lives in the memory
 * service (`AgentRequest.vaultHome === "memory"`). FROZEN with the prompt, so it
 * says only what holds for the whole conversation — where the vault lived at
 * its first turn, that a note is saved when written, what `commit` does.
 * "Commit after writing" stays the instruction, which is also what keeps a
 * conversation right if its owner's vault moves back.
 *
 * Three readers, three texts:
 * - `owner` — the owner's own run (chat, routine, task API). Live questions
 *   (still there? reachable? copy behind?) go to describe_system, which
 *   answers them for the owner.
 * - `writer` — a shared-account teammate, who may write notes but is NOT the
 *   owner: describe_system gives a non-owner no owner state, so this text
 *   promises nothing about it and points at the tool results instead.
 * - `reader` — a plain teammate or a consultation: where the notes are, and
 *   that an outage is not an empty brain.
 */
export function vaultMemoryHomeParagraph(viewer: "owner" | "writer" | "reader"): string {
  if (viewer === "reader") {
    return (
      `**Where the owner's vault lives**: when this conversation started, the owner's personal vault (${VAULT_NOTES_PHRASE}) was stored in Noah's memory service, not in the git repository. The same tools and paths read it. ` +
      `If a tool reports that the memory service is unavailable, ${vaultOutageRule(false)}.`
    );
  }
  const head =
    viewer === "owner"
      ? `**Where your vault lives**: when this conversation started, your personal vault — ${VAULT_NOTES_PHRASE} — was stored in Noah's memory service, not in the git repository (\`mcp__system__describe_system\` reports where it is now, whether the memory service answers, and the state of the repository copy). `
      : `**Where the owner's vault lives**: when this conversation started, the owner's personal vault — ${VAULT_NOTES_PHRASE} — was stored in Noah's memory service, not in the git repository. Each write's tool result says where that note went; if a result and this paragraph differ, the result is right. `;
  return (
    head +
    "The same tools and paths apply: `mcp__repo__*` reads and writes those notes there, `mcp__brain__*` recalls them. " +
    "A vault note is SAVED the moment its write, edit, move or delete succeeds — it needs no commit to exist, and the tool result says so. " +
    "The git repository keeps a COPY of the vault that only Noah writes: `mcp__repo__commit` pushes that copy now, together with your other repository changes, so commit after writing as before. " +
    "Everything else in the repository (skills, plugins, non-markdown files) lives in git and is pushed only by that commit. " +
    "A vault note edited directly in git is NOT read back — the next push of the copy replaces it, so change vault notes only through these tools. " +
    `If a tool reports that the memory service is unavailable, ${vaultOutageRule(true)}.`
  );
}

/**
 * The owner's vault is in the memory service but NO knowledge repository is
 * connected: every `mcp__repo__*` file tool refuses (NO_REPO) and the brain
 * tools are not registered, so the notes cannot be reached through the tools
 * — and must not be reported as gone. ONE text for the prompt's no-repository
 * branch and describe_system's vault line (which adds "since when").
 */
export const VAULT_MEMORY_NO_REPO_SENTENCE =
  `${VAULT_NOTES_PHRASE} are kept in Noah's memory service and are still there, but they are NOT reachable through your tools while no knowledge repository is connected: the repository file tools refuse and brain recall is off until one is. ` +
  "Nothing was lost, so never tell the owner their brain is empty. Connecting a repository again makes the notes reachable — Noah looks at that repository before it writes anything into it";

/**
 * describe_system's line about the repository copy of a `memory`-home vault,
 * in plain words, with what to do when it is behind or on hold. Notes are
 * saved in the memory service in every one of these states — the line says so
 * wherever the state could read as "your notes are not saved".
 * `repoConnected` false = there is no repository to copy into (and no
 * `mcp__repo__commit` to recommend: it refuses).
 */
export function vaultMirrorStateText(mirror: OwnerVaultMirrorState, repoConnected = true): string {
  if (!repoConnected) {
    return "none right now — no knowledge repository is connected, so there is nowhere to copy the notes to; they exist only in the memory service until one is connected again";
  }
  const oneWay = " The copy is one-way: a vault note edited directly in git is not read back and is replaced by the next push.";
  if (mirror.hold === "checking") {
    return (
      "CHECKING — a repository (or branch) was just connected or changed, and Noah has not looked at it yet: it writes nothing into it until it has. " +
      "There is nothing to confirm and nothing for you or the owner to do — the check runs by itself, and the copy starts once the repository is known to hold no vault notes the copy would replace. " +
      "If it stays in this state, the check could not finish — the repository could not be read (no usable `GIT_TOKEN`, unreachable) or the memory service did not answer. Noah keeps retrying on its own (about once a minute for the first half hour, then every ten minutes), an admin sees what is in the way in the admin's 개인 브레인 이전 table, and once it is fixed the owner can start it at once with 지금 다시 확인 in 설정 → 지식·플러그인 → 지식 저장소 (브레인 노트 보관) — so report it instead of waiting; you have no tool for it. " +
      "Meanwhile notes keep being saved in the memory service, and `mcp__repo__commit` still pushes the other repository files." +
      oneWay
    );
  }
  if (mirror.hold === "confirm") {
    return (
      "WAITING FOR THE OWNER — Noah looked at the connected repository and it holds vault notes of its own (`CLAUDE.md`, `wiki/`, `raw/`) that the copy would replace with the memory service's version (a note only the repository has would be removed from it; the earlier content stays in git history). Nothing there has been overwritten. " +
      "Only the owner can confirm, in 설정 → 지식·플러그인 → 지식 저장소 (브레인 노트 보관) — tell them; you have no tool for it. Until then notes keep being saved in the memory service, the repository's vault files stay as they are, and `mcp__repo__commit` still pushes the other repository files." +
      oneWay
    );
  }
  // What the last successful push found: the repository holds vault notes the service does not. Stated with
  // every state below — it stays true until a later push says otherwise.
  const notice = mirror.notice
    ? ` Notice from the last successful push: \`${mirror.notice}\` — the repository holds vault notes that the memory service does not (added directly in git, or no longer in the service). Noah deleted NOTHING: they stay in the repository, but they are not part of the brain — search and read do not see them, and you cannot read them through your tools. Tell the owner; for a note they want in the brain, they can give you its text and you write it as a note. If many are missing or the brain itself looks emptied, that is an administrator's recovery — moving this owner back to the repository and then to the memory service again brings every repository note into the brain — not something to rebuild by hand.`
    : "";
  const last = mirror.syncedAt
    ? `the last successful push was ${mirror.syncedAt}`
    : "nothing has been pushed since the vault moved to the memory service";
  if (mirror.error) {
    // What to do depends on WHY it failed (`VAULT_MIRROR_ERROR` — each value is the stored text or its
    // beginning). A text this table does not know gets the generic sentence.
    const failedWith = (head: string) => mirror.error === head || mirror.error!.startsWith(`${head} `) || mirror.error!.startsWith(`${head}:`);
    const next = failedWith(VAULT_MIRROR_ERROR.repoDirty)
      ? "Call `mcp__repo__commit` to push the copy now: that error means the repository's working copy holds uncommitted changes outside the vault, which Noah's own background push never touches — your commit carries both."
      : failedWith(VAULT_MIRROR_ERROR.noToken)
        ? "No commit can push it either: the owner has no usable internal Git token (`GIT_TOKEN`) — ask them to register one under Settings → Git credentials."
        : failedWith(VAULT_MIRROR_ERROR.serviceUnavailable) || failedWith(VAULT_MIRROR_ERROR.serviceRefused)
          ? "A commit will not help while the memory service does not serve the vault (see the memory service line): nothing can be copied out of it until it does."
          : "Call `mcp__repo__commit` to push the copy now. If the commit fails too, report its error as it is (a rejected `GIT_TOKEN`, a protected branch, a conflict) instead of retrying in a loop.";
    return (
      `BEHIND — the last attempt to push the copy FAILED (\`${mirror.error}\`); ${last}. Vault notes written since then are saved in the memory service but may be missing from the repository. ` +
      `${next} The notes stay saved either way, and Noah retries on its own.` +
      oneWay +
      notice
    );
  }
  if (mirror.dirty) {
    return (
      `BEHIND — vault notes changed since the last push are saved in the memory service but not yet in the repository; ${last}. ` +
      "Call `mcp__repo__commit` to push the copy now (Noah also pushes it on its own, usually within a minute or two)." +
      oneWay +
      notice
    );
  }
  return `up to date — ${last}${mirror.syncedAt ? "" : ", and the repository holds the notes as they were then"}.${oneWay}${notice}`;
}

/**
 * Noah serves ONE team (groups retired 2026-11-06): every approved user is a
 * teammate, all equal and mutually trusted. ONE wording for both
 * metacognition surfaces (the prompt's owner team line and describe_system),
 * each adding the team size its own way: describe_system the LIVE count, the
 * FROZEN prompt the count as of the conversation's start. Never mentions
 * groups — they no longer exist.
 */
export const TEAM_SENTENCE =
  "Noah serves a single team: every approved user is a teammate. Teammates see your avatar unless it is private and are mutually trusted (elevated tools on each other's avatars).";

/** "N teammate(s) besides the owner" — the size half of the team line. */
export function teammateCountPhrase(teammateCount: number): string {
  return `${teammateCount} teammate${teammateCount === 1 ? "" : "s"} besides the owner`;
}

/**
 * The per-GROUP repositories and brain are gone (retired 2026-10-30, groups
 * themselves 2026-11-06); the ONE instance-wide team brain came back
 * 2026-11-06 (docs/architecture/team-brain.md). Said on BOTH metacognition
 * surfaces, because a frozen prompt of an older conversation, a skill or a
 * note may still name `mcp__group_repo__*` / `mcp__group_brain__*`.
 */
export const GROUP_REPOS_RETIRED_SENTENCE =
  "The old per-GROUP knowledge repositories and per-group brain were removed with groups, so the `mcp__group_repo__*` and `mcp__group_brain__*` tools no longer exist. If an earlier message, a skill or a note names them, say they were removed and use the ONE team brain instead (`mcp__brain__search` with scope \"team\"; every teammate adds to it from their own chat, through a card they press), the owner's personal repository (`mcp__repo__*`) or skill sharing (`mcp__skill_exchange__*`) — never look for a workaround.";
