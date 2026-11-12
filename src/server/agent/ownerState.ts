import type {
  AgentRequest,
  AgentRewindInfo,
  AppConfig,
  PiSandboxOwner,
  SharedMcpRunState,
} from "../types.js";
import { kstDateString } from "../routineSchedule.js";
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
export interface OwnerState {
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
  return {
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
  "The old per-GROUP knowledge repositories and per-group brain were removed with groups, so the `mcp__group_repo__*` and `mcp__group_brain__*` tools no longer exist. If an earlier message, a skill or a note names them, say they were removed and use the ONE team brain instead (`mcp__brain__search` with scope \"team\"; new team knowledge is proposed from the owner's own chat and approved by an admin), the owner's personal repository (`mcp__repo__*`) or skill sharing (`mcp__skill_exchange__*`) — never look for a workaround.";
