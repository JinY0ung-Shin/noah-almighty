import type {
  AgentRewindInfo,
  AppConfig,
  PiSandboxOwner,
  SharedMcpRunState,
  UserGroupMembership,
} from "../types.js";
import { kstDateString } from "../routineSchedule.js";
import type { BrowserSecretPolicy } from "../secretPolicy.js";
import type { Store } from "../store.js";
import type { TodoSnapshot } from "../../shared/todos.js";
import { modelOverrideState } from "../modelOverride.js";

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
 * NOTE on gating: this returns the ungated facts (e.g. full `secretNames`/
 * `groups`). buildPrompt blanks `secretNames`/`groupMemberships` to `[]` unless
 * `ownerToolAccess`; describe_system always reads them live (it only runs for the
 * owner). That gating stays at the call sites, not here.
 *
 * NOTE on Confluence: the two sites compute `confluencePatConfigured` from
 * DIFFERENT sources (buildPrompt from the actual decrypted secret VALUES it
 * already holds; describe_system from secret-NAME presence). This module exposes
 * `secretNames` only and leaves the Confluence derivation to each caller, so
 * neither output changes.
 *
 * NOTE on model: this exposes the raw resolution input (`modelOverride` admin
 * setting) — user tier > admin override > default tier — not a formatted
 * label, since describe_system renders its own label and buildPrompt does not
 * surface the model at all.
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
  /** Groups the owner belongs to, with role + avatar-sharing flag per group. */
  groups: UserGroupMembership[];
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
  /** Admin-selected model override runs use when the conversation picked no tier (null: none, or ignored). */
  modelOverride: string | null;
  /** A stored override that is neither a tier nor a `PI_MODEL_MAP` key — ignored, runs use the default tier. */
  modelOverrideIgnored: string | null;
  /** Experimental (beta) feature keys the owner enabled for this avatar (#50). */
  experimentalFeatures: string[];
  /**
   * Shared (communal) account flag: trusted same-group teammates may also WRITE
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
    groups: store.listUserGroups(avatarUserId),
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
    ...(() => {
      const override = modelOverrideState(store, config);
      return { modelOverride: override.effective, modelOverrideIgnored: override.ignored };
    })(),
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
 * could merely be HIGHER (secrets, plugins, shared/learnable skills, groups) are
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
 * What the admin built-in-tool disables mean on pi (review L6). pi has none of
 * WebFetch/WebSearch/NotebookEdit, and its own subagent tool (`Agent`) cannot
 * be switched off per request (design P1), so the subagent toggle is the
 * model's to honor.
 * Mirrored by describe_system's admin-disabled line.
 */
export function piAdminDisabledToolsNote(disabledTools: readonly string[]): string {
  if (!disabledTools.some((name) => name === "Agent" || name === "Task")) return "";
  return " On this runtime that subagent switch is NOT enforced by a tool gate (pi's own `Agent` tool stays callable), so honor it yourself: never spawn a subagent with `Agent`; do the work in this run.";
}

/**
 * Whose sandbox a run's built-in tools work in (`PiRuntimeFacts.sandboxOwner`),
 * ONE text for both metacognition surfaces (the prompt's runtime section and
 * describe_system's runtime line). Empty for the owner's own runs: "this
 * user's sandbox" already says it.
 */
export function piSandboxOwnerSentence(owner: PiSandboxOwner | undefined): string {
  if (owner === "viewer") {
    return "This sandbox belongs to the person you are talking to, a colleague — NOT to the avatar owner: your built-in tools (read/write/edit/ls/find/grep/bash) work only on that colleague's own files, never on the owner's, and anything you build there is theirs. The owner's knowledge and repositories are reachable only through the Noah tools this run lists, which refuse anything reserved for the owner.";
  }
  if (owner === "nobody") {
    return "This consultation runs in a FRESH, EMPTY, temporary sandbox created for this one run and owned by nobody — neither your owner's nor the asking teammate's: it starts with no files, nothing you write there reaches the answer, and it is deleted when the run ends. Answer from your owner's knowledge through the Noah recall tools this run lists.";
  }
  return "";
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

/** Product-wide UI capability; never reads private DM content or presence into agent context. */
export const DIRECT_MESSAGE_STATE = "Human-to-human DM is available to signed-in users across groups via the 메시지 dock at the bottom-right corner of the screen (a collapsible chat window available on every view). It has recent-active contacts, persisted conversations and unread badges. No avatar tool can read or send these DMs; guide the user to the UI. Read manual topic direct-messages for details.";

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
 * Groups have no shared knowledge repository and there is no team brain
 * (both retired 2026-10-30). Said on BOTH metacognition surfaces, because a
 * frozen prompt of an older conversation, a skill or a note may still name
 * `mcp__group_repo__*` / `mcp__group_brain__*`.
 */
export const GROUP_REPOS_RETIRED_SENTENCE =
  "Groups have NO shared knowledge repository and there is no team brain: both were removed, so the `mcp__group_repo__*` and `mcp__group_brain__*` tools no longer exist. If an earlier message, a skill or a note names them, say group repositories were removed and use the owner's personal repository (`mcp__repo__*`) or skill sharing (`mcp__skill_exchange__*`) instead — never look for a workaround.";
