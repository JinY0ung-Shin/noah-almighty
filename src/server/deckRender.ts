import {
  execFile,
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
} from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppConfig } from "./types.js";
import logger from "./logger.js";

const execFileAsync = promisify(execFile);
const deckLogger = logger.child({ module: "deck-render" });

/**
 * Deployment-level probes for the PPTX deck toolchain the bundled `pptx` skill
 * drives from the agent shell. Two halves, both reported from here:
 *
 * - LEGACY (`probeDeckRendering`): LibreOffice (`soffice`, pptx→pdf), poppler's
 *   `pdftoppm` (pdf→slide PNGs) and the `python-pptx` library — all three back
 *   the python-pptx authoring path. The server's own approximate share_file
 *   previews (`renderDocumentPreviews`) need only the first two
 *   (`probeDocumentPreviews`): gating them on python-pptx too would silently
 *   switch previews off on a host that installs LibreOffice without it.
 * - CONVERTER (`probeDeckToolchain`): the skill's HTML→editable-PPTX converter,
 *   probed by running its own `deck.mjs probe --json` (Chromium, playwright-core,
 *   the pinned Python modules, fonts, limits and the build-time self-test
 *   record). The server never launches Chromium itself.
 *
 * Both reach the avatar through ONE state (`DeckToolchainState`): the standing
 * prompt (`AgentRequest.deckRenderingEnabled` / `deckConverterEnabled`) and
 * `describe_system` (`SystemToolsContext.deckToolchain`) render it with the
 * explicit `converter: INSTALLED` / `converter: NOT INSTALLED` markers the
 * skill's preflight keys on. A dev machine usually has neither half, and an
 * older image may miss one — the feature must degrade to an honest report
 * instead of letting the avatar walk into shell errors.
 *
 * Probed at boot and memoized: the result cannot change without a container
 * rebuild, and a spawn per turn would be wasted latency. The one exception is a
 * converter probe that could not be read at all (spawn error, timeout, bad
 * JSON): that result is NOT definitive and is re-probed in the background at
 * most every 5 minutes, never blocking a turn. This is deliberately NOT owner
 * state (`ownerState.ts`) — it is a per-deployment fact, threaded per run like
 * `fileOutputEnabled` (see `runPlan.ts` / `claudeAgent.ts`).
 */

const PROBE_TIMEOUT_MS = 5_000;

/** The three legacy command checks, memoized together (one spawn each, ever). */
export interface LegacyDeckProbe {
  soffice: boolean;
  pdftoppm: boolean;
  pythonPptx: boolean;
}

let legacyCached: LegacyDeckProbe | null = null;

function commandWorks(command: string, args: string[]): boolean {
  const result = nodeSpawnSync(command, args, {
    stdio: "ignore",
    timeout: PROBE_TIMEOUT_MS,
  });
  return !result.error && result.status === 0;
}

function legacyDeckProbe(): LegacyDeckProbe {
  if (legacyCached !== null) return legacyCached;
  // `-env:UserInstallation` points soffice at a throwaway profile dir so the
  // probe doesn't trigger the slow, HOME-writability-dependent default-profile
  // init (which can blow the 5s timeout and wrongly memoize `false`).
  const sofficeProfile = path.join(os.tmpdir(), "noah-soffice-probe");
  const soffice = commandWorks("soffice", [
    `-env:UserInstallation=file://${sofficeProfile}`,
    "--version",
  ]);
  const pdftoppm = commandWorks("pdftoppm", ["-v"]);
  const pythonPptx = commandWorks("python3", ["-c", "import pptx"]);
  legacyCached = { soffice, pdftoppm, pythonPptx };
  deckLogger.info(
    {
      soffice,
      pdftoppm,
      pythonPptx,
      available: soffice && pdftoppm && pythonPptx,
      previews: soffice && pdftoppm,
    },
    "deck rendering probe",
  );
  return legacyCached;
}

/** True when soffice + pdftoppm + python-pptx are all usable in this deployment. */
export function probeDeckRendering(): boolean {
  const probe = legacyDeckProbe();
  return probe.soffice && probe.pdftoppm && probe.pythonPptx;
}

/** True when soffice + pdftoppm can rasterize documents for share_file previews. */
export function probeDocumentPreviews(): boolean {
  const probe = legacyDeckProbe();
  return probe.soffice && probe.pdftoppm;
}

/**
 * Test hook: override or clear (null) the memoized probe result. A boolean pins
 * all three commands; an object pins each one (unlisted commands are false).
 */
export function __setDeckRenderingForTests(value: boolean | Partial<LegacyDeckProbe> | null): void {
  if (value === null) {
    legacyCached = null;
  } else if (typeof value === "boolean") {
    legacyCached = { soffice: value, pdftoppm: value, pythonPptx: value };
  } else {
    legacyCached = {
      soffice: value.soffice ?? false,
      pdftoppm: value.pdftoppm ?? false,
      pythonPptx: value.pythonPptx ?? false,
    };
  }
}

// ---- HTML→PPTX converter probe ---------------------------------------------

export type DeckFontProfile = "embedded" | "malgun";

/** The converter's own caps, as its probe reports them (I3 `limits`). */
export interface DeckConverterLimits {
  maxSlides: number;
  maxSeconds: number;
  maxSlideHtmlBytes: number;
  maxDomElements: number;
  maxAssetBytes: number;
  maxDeckInputBytes: number;
  maxConcurrent: number;
  slotWaitSeconds: number;
}

/**
 * Everything the avatar is told about deck generation in this deployment:
 * the legacy python-pptx toolchain, the converter, and the `pptx` skill names
 * an admin policy could disable. Unformatted facts — each metacognition
 * surface formats (and gates) them itself.
 */
export interface DeckToolchainState {
  /** Legacy probe: `python3 -c "import pptx"`. */
  pythonPptx: boolean;
  /** Legacy probe: `soffice` AND `pdftoppm`. */
  libreOffice: boolean;
  /** `deck.mjs probe` reported `converter: true`. */
  converter: boolean;
  converterVersion?: string;
  chromiumVersion?: string;
  /** Usable font profiles — `[]` unless `converter`. */
  profiles: DeckFontProfile[];
  /** Present when `converter`. */
  limits?: DeckConverterLimits;
  /** The build-time self-test record (`not-recorded` on dev boxes). */
  selftest: "pass" | "drift" | "disabled" | "not-recorded";
  /** English facts for the administrator (the probe's `missing`); `[]` when `converter`. */
  converterMissing: string[];
  /** `["pptx", "<plugin.json name>:pptx"]` — just `["pptx"]` if plugin.json is unreadable. */
  pptxSkillNames: string[];
  /** False → the converter half is re-probed in the background after 5 minutes. */
  definitive: boolean;
}

export type DeckMode = "converter" | "legacy" | "unavailable";

/** The deck mode both metacognition surfaces branch on. */
export function deckModeOf(s: DeckToolchainState): DeckMode {
  if (s.converter) return "converter";
  return s.pythonPptx && s.libreOffice ? "legacy" : "unavailable";
}

/** Where the bundled skill's converter CLI lives under DEFAULT_PLUGINS_DIR. */
export function deckConverterScript(defaultPluginsDir: string): string {
  return path.join(defaultPluginsDir, "skills", "pptx", "converter", "tools", "deck.mjs");
}

/** Hard cap on one converter probe (it never launches a browser; ~0.3 s normally). */
const CONVERTER_PROBE_TIMEOUT_MS = 10_000;
/** Minimum spacing between background re-probes after a non-definitive result. */
const CONVERTER_REPROBE_INTERVAL_MS = 5 * 60_000;
/** The probe prints ONE small JSON object; anything bigger is a broken probe. */
const CONVERTER_PROBE_MAX_OUTPUT_BYTES = 1024 * 1024;
const DECK_PROBE_FORMAT = "noah-deck-probe";
const DECK_PROBE_VERSION = 1;
const SELFTEST_STATUSES = ["pass", "drift", "disabled", "not-recorded"] as const;
const LIMIT_KEYS = [
  "maxSlides",
  "maxSeconds",
  "maxSlideHtmlBytes",
  "maxDomElements",
  "maxAssetBytes",
  "maxDeckInputBytes",
  "maxConcurrent",
  "slotWaitSeconds",
] as const satisfies readonly (keyof DeckConverterLimits)[];
/** Plain (unqualified) plugin name, the shape `plugin.json` `name` must have. */
const PLUGIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const MAX_MISSING_FACTS = 12;
const MAX_FACT_CHARS = 300;

/**
 * The ONLY environment the probe process sees: an allowlist, so no server
 * secret (SESSION_SECRET, git tokens, the Claude credentials, …) can ever
 * reach it — the opposite of the agent subprocess's strip-list, which is also
 * why this module needs nothing from `runPlan.ts`.
 */
const DECK_PROBE_ENV_NAMES = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "NODE_ENV"] as const;

function deckProbeEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of DECK_PROBE_ENV_NAMES) {
    const value = base[name];
    if (typeof value === "string") env[name] = value;
  }
  for (const [name, value] of Object.entries(base)) {
    if (name.startsWith("NOAH_PPTX_") && typeof value === "string") env[name] = value;
  }
  env.PYTHONDONTWRITEBYTECODE = "1";
  return env;
}

/**
 * The names under which an admin policy can disable the bundled `pptx` skill:
 * its bare name and its plugin-qualified name — exactly the two spellings the
 * PreToolUse hook blocks for it (`other:pptx` is a DIFFERENT skill).
 */
function pptxSkillNamesFor(defaultPluginsDir: string): string[] {
  try {
    const manifest = path.join(defaultPluginsDir, ".claude-plugin", "plugin.json");
    if (fs.statSync(manifest).size <= 64 * 1024) {
      const parsed: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const name = isRecord(parsed) ? parsed.name : undefined;
      if (typeof name === "string" && PLUGIN_NAME_RE.test(name)) {
        return ["pptx", `${name}:pptx`];
      }
    }
  } catch {
    // Unreadable/invalid manifest: only the bare name is certain.
  }
  return ["pptx"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** One-line, bounded rendering of an unexpected JSON value for a failure reason. */
function brief(value: unknown): string {
  const rendered = JSON.stringify(value) ?? String(value);
  return rendered.length > 40 ? `${rendered.slice(0, 40)}…` : rendered;
}

function versionOf(value: unknown): string | undefined {
  return typeof value === "string" && VERSION_RE.test(value) ? value : undefined;
}

/** The probe's `missing` facts, cleaned for the model: one line each, bounded. */
function missingFactsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const facts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const fact = entry.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!fact) continue;
    facts.push(fact.length > MAX_FACT_CHARS ? `${fact.slice(0, MAX_FACT_CHARS)}…` : fact);
    if (facts.length === MAX_MISSING_FACTS) break;
  }
  return facts;
}

function profilesOf(value: unknown): DeckFontProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles: DeckFontProfile[] = [];
  for (const entry of value) {
    if ((entry === "embedded" || entry === "malgun") && !profiles.includes(entry)) {
      profiles.push(entry);
    }
  }
  return profiles;
}

function limitsOf(value: unknown): DeckConverterLimits | null {
  if (!isRecord(value)) return null;
  const limits = {} as DeckConverterLimits;
  for (const key of LIMIT_KEYS) {
    const n = value[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
    limits[key] = n;
  }
  return limits;
}

function selftestOf(value: unknown): DeckToolchainState["selftest"] {
  const status = isRecord(value) ? value.status : undefined;
  return (SELFTEST_STATUSES as readonly unknown[]).includes(status)
    ? (status as DeckToolchainState["selftest"])
    : "not-recorded";
}

/** The converter half of the state, as read from one successful probe. */
type ConverterFacts = Pick<
  DeckToolchainState,
  | "converter"
  | "converterVersion"
  | "chromiumVersion"
  | "profiles"
  | "limits"
  | "selftest"
  | "converterMissing"
>;

/**
 * Validate `deck.mjs probe --json` output (I3). Returns the facts, or an
 * English reason the output is unusable. A valid report of `converter: false`
 * IS a result (definitive); only unreadable output fails.
 */
function parseProbeJson(stdout: string): ConverterFacts | string {
  const body = stdout.trim();
  if (!body) return "the probe printed no JSON";
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return "the probe output is not valid JSON";
  }
  if (!isRecord(value)) return "the probe output is not a JSON object";
  if (value.format !== DECK_PROBE_FORMAT || value.version !== DECK_PROBE_VERSION) {
    return `unexpected probe format ${brief(value.format)} version ${brief(value.version)}`;
  }
  if (typeof value.converter !== "boolean") {
    return "the probe JSON has no boolean `converter` field";
  }
  const converterVersion = versionOf(value.converterVersion);
  const chromiumVersion = versionOf(isRecord(value.chromium) ? value.chromium.version : undefined);
  const common = {
    ...(converterVersion ? { converterVersion } : {}),
    ...(chromiumVersion ? { chromiumVersion } : {}),
    selftest: selftestOf(value.selftest),
  };
  if (!value.converter) {
    return {
      converter: false,
      ...common,
      profiles: [],
      converterMissing: missingFactsOf(value.missing),
    };
  }
  const profiles = profilesOf(value.profiles);
  if (profiles.length === 0) return "the probe reports the converter without a usable font profile";
  const limits = limitsOf(value.limits);
  if (!limits) return "the probe reports the converter without valid limits";
  return { converter: true, ...common, profiles, limits, converterMissing: [] };
}

type ConverterOutcome =
  | { definitive: true; facts: ConverterFacts }
  | { definitive: false; reason: string };

interface ProbeRun {
  error?: Error;
  timedOut: boolean;
  overflow: boolean;
  signal: string | null;
  status: number | null;
  stdout: string;
}

function interpretProbeRun(run: ProbeRun): ConverterOutcome {
  const failed = (reason: string): ConverterOutcome => ({ definitive: false, reason });
  if (run.timedOut) return failed(`timed out after ${CONVERTER_PROBE_TIMEOUT_MS / 1000} s`);
  if (run.overflow) return failed(`the probe printed more than ${CONVERTER_PROBE_MAX_OUTPUT_BYTES} bytes`);
  if (run.error) {
    const code = (run.error as NodeJS.ErrnoException).code;
    return failed(`could not run the probe (${code ?? run.error.message})`);
  }
  if (run.signal) return failed(`the probe was killed by ${run.signal}`);
  const facts = parseProbeJson(run.stdout);
  if (typeof facts === "string") return failed(`${facts} (exit ${run.status ?? "unknown"})`);
  return { definitive: true, facts };
}

function missingScriptOutcome(script: string): ConverterOutcome {
  return {
    definitive: true,
    facts: {
      converter: false,
      profiles: [],
      selftest: "not-recorded",
      converterMissing: [`converter scripts not found under DEFAULT_PLUGINS_DIR (${script})`],
    },
  };
}

function scriptExists(script: string): boolean {
  try {
    return fs.statSync(script).isFile();
  } catch {
    return false;
  }
}

const PROBE_ARGS = (script: string) => [script, "probe", "--json"];

function probeConverterSync(script: string, spawnSyncImpl: typeof nodeSpawnSync): ConverterOutcome {
  if (!scriptExists(script)) return missingScriptOutcome(script);
  let result: ReturnType<typeof nodeSpawnSync>;
  try {
    result = spawnSyncImpl(process.execPath, PROBE_ARGS(script), {
      env: deckProbeEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: CONVERTER_PROBE_TIMEOUT_MS,
      // SIGKILL: spawnSync blocks until the child exits, so a probe that ignored
      // SIGTERM would hang the boot. Its own children die with it (PDEATHSIG /
      // pipe close on the converter side).
      killSignal: "SIGKILL",
      maxBuffer: CONVERTER_PROBE_MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
  } catch (error) {
    return interpretProbeRun({
      error: error instanceof Error ? error : new Error(String(error)),
      timedOut: false,
      overflow: false,
      signal: null,
      status: null,
      stdout: "",
    });
  }
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return interpretProbeRun({
    error: code === "ETIMEDOUT" || code === "ENOBUFS" ? undefined : result.error,
    timedOut: code === "ETIMEDOUT",
    overflow: code === "ENOBUFS",
    signal: result.signal ?? null,
    status: result.status ?? null,
    stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? ""),
  });
}

function probeConverterAsync(script: string, spawnImpl: typeof nodeSpawn): Promise<ConverterOutcome> {
  if (!scriptExists(script)) return Promise.resolve(missingScriptOutcome(script));
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(process.execPath, PROBE_ARGS(script), {
        env: deckProbeEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve(
        interpretProbeRun({
          error: error instanceof Error ? error : new Error(String(error)),
          timedOut: false,
          overflow: false,
          signal: null,
          status: null,
          stdout: "",
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CONVERTER_PROBE_TIMEOUT_MS);
    timer.unref?.();
    const finish = (run: Omit<ProbeRun, "timedOut" | "overflow">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(interpretProbeRun({ ...run, timedOut, overflow }));
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size > CONVERTER_PROBE_MAX_OUTPUT_BYTES) {
        if (!overflow) {
          overflow = true;
          child.kill("SIGKILL");
        }
        return;
      }
      chunks.push(buffer);
    });
    // Human text goes to stderr; drain it so a chatty probe can't stall on a
    // full pipe, but never parse it.
    child.stderr?.resume();
    child.on("error", (error) =>
      finish({ error, signal: null, status: null, stdout: "" }),
    );
    child.on("close", (status: number | null, signal: NodeJS.Signals | null) =>
      finish({ signal, status, stdout: Buffer.concat(chunks).toString("utf8") }),
    );
  });
}

interface LegacyHalf {
  pythonPptx: boolean;
  libreOffice: boolean;
}

function legacyHalf(): LegacyHalf {
  const probe = legacyDeckProbe();
  return { pythonPptx: probe.pythonPptx, libreOffice: probe.soffice && probe.pdftoppm };
}

function freezeState(state: DeckToolchainState): DeckToolchainState {
  Object.freeze(state.profiles);
  Object.freeze(state.converterMissing);
  Object.freeze(state.pptxSkillNames);
  if (state.limits) Object.freeze(state.limits);
  return Object.freeze(state);
}

function composeState(
  legacy: LegacyHalf,
  outcome: ConverterOutcome,
  pptxSkillNames: string[],
): DeckToolchainState {
  const facts: ConverterFacts = outcome.definitive
    ? outcome.facts
    : {
        converter: false,
        profiles: [],
        selftest: "not-recorded",
        converterMissing: [`converter probe failed: ${outcome.reason}`],
      };
  return freezeState({
    ...legacy,
    ...facts,
    pptxSkillNames: [...pptxSkillNames],
    definitive: outcome.definitive,
  });
}

/** The fields the boot log (and a successful background re-probe) report. */
export function deckToolchainLogFields(state: DeckToolchainState) {
  return {
    mode: deckModeOf(state),
    converter: state.converter,
    chromiumVersion: state.chromiumVersion ?? null,
    profiles: state.profiles,
    limits: state.limits ?? null,
    selftest: state.selftest,
    converterMissing: state.converterMissing,
    pythonPptx: state.pythonPptx,
    libreOffice: state.libreOffice,
    definitive: state.definitive,
  };
}

interface ToolchainMemo {
  state: DeckToolchainState;
  /** Clock reading when the last probe ATTEMPT started (sync or background). */
  attemptedAt: number;
}

let toolchainMemo: ToolchainMemo | null = null;
let reprobeInFlight = false;
/** Bumped on every test reset/override so a stale background probe can't land. */
let memoGeneration = 0;

type ProbeDeps = {
  spawnSync?: typeof nodeSpawnSync;
  spawn?: typeof nodeSpawn;
  now?: () => number;
};

function scheduleReprobe(
  config: Pick<AppConfig, "defaultPluginsDir">,
  deps: ProbeDeps | undefined,
  now: () => number,
): void {
  const memo = toolchainMemo;
  if (!memo || memo.state.definitive || reprobeInFlight) return;
  const startedAt = now();
  if (startedAt - memo.attemptedAt < CONVERTER_REPROBE_INTERVAL_MS) return;
  reprobeInFlight = true;
  const generation = memoGeneration;
  memo.attemptedAt = startedAt;
  const script = deckConverterScript(config.defaultPluginsDir);
  const legacy = { pythonPptx: memo.state.pythonPptx, libreOffice: memo.state.libreOffice };
  const pptxSkillNames = [...memo.state.pptxSkillNames];
  void probeConverterAsync(script, deps?.spawn ?? nodeSpawn)
    .then((outcome) => {
      if (generation !== memoGeneration) return;
      const state = composeState(legacy, outcome, pptxSkillNames);
      toolchainMemo = { state, attemptedAt: startedAt };
      if (outcome.definitive) {
        deckLogger.info(deckToolchainLogFields(state), "deck toolchain re-probe settled");
      } else {
        deckLogger.warn(
          { reason: outcome.reason, script },
          "deck converter probe failed again; retrying in the background in 5 minutes",
        );
      }
    })
    .catch((err: unknown) => {
      deckLogger.warn({ err, script }, "deck converter background re-probe crashed");
    })
    .finally(() => {
      if (generation === memoGeneration) reprobeInFlight = false;
    });
}

/**
 * The deployment's deck toolchain (legacy half + the converter's own probe).
 * Memoized: a DEFINITIVE result (valid probe JSON — `converter: false`
 * included — or a missing converter script) is kept for the process lifetime.
 * A non-definitive one (spawn error, timeout, unreadable output) reports
 * `converter: false` with a `converter probe failed: …` fact and triggers a
 * background re-probe (async spawn, never blocking this call) at most every
 * 5 minutes; each failure is logged at warn.
 *
 * Under `NODE_ENV=test` without injected deps it returns a fixed "not probed"
 * converter state and never spawns, so unrelated suites stay hermetic — pass
 * `deps` (even just the real `spawnSync`) to exercise a real probe.
 */
export function probeDeckToolchain(
  config: Pick<AppConfig, "defaultPluginsDir">,
  deps?: ProbeDeps,
): DeckToolchainState {
  const memo = toolchainMemo;
  const hermetic = !deps && process.env.NODE_ENV === "test";
  if (memo) {
    if (!memo.state.definitive && !hermetic) {
      scheduleReprobe(config, deps, deps?.now ?? Date.now);
    }
    return memo.state;
  }
  if (hermetic) return notProbedState(config);
  const now = deps?.now ?? Date.now;
  const attemptedAt = now();
  const script = deckConverterScript(config.defaultPluginsDir);
  const outcome = probeConverterSync(script, deps?.spawnSync ?? nodeSpawnSync);
  const state = composeState(legacyHalf(), outcome, pptxSkillNamesFor(config.defaultPluginsDir));
  toolchainMemo = { state, attemptedAt };
  if (!outcome.definitive) {
    deckLogger.warn(
      { reason: outcome.reason, script },
      "deck converter probe failed; retrying in the background in 5 minutes",
    );
  }
  return state;
}

/**
 * Test-environment state: the converter half is fixed ("not probed"), the
 * legacy half mirrors whatever the legacy memo already holds (runPlan probes it
 * first) WITHOUT spawning, and the skill names come from plugin.json (a file
 * read, not a spawn) so admin-disabled-skill gating stays real. Not memoized.
 */
function notProbedState(config: Pick<AppConfig, "defaultPluginsDir">): DeckToolchainState {
  const legacy = legacyCached;
  return freezeState({
    pythonPptx: legacy?.pythonPptx ?? false,
    libreOffice: legacy ? legacy.soffice && legacy.pdftoppm : false,
    converter: false,
    profiles: [],
    selftest: "not-recorded",
    converterMissing: ["the converter was not probed in this test environment"],
    pptxSkillNames: pptxSkillNamesFor(config.defaultPluginsDir),
    definitive: false,
  });
}

/**
 * Test hook: pin the toolchain state (returned as is by every later call; a
 * non-definitive pin is re-probed on the next call that passes deps) or clear
 * it (null) together with any background re-probe still in flight.
 */
export function __setDeckToolchainForTests(state: DeckToolchainState | null): void {
  memoGeneration += 1;
  reprobeInFlight = false;
  toolchainMemo = state ? { state, attemptedAt: Number.NEGATIVE_INFINITY } : null;
}

/** Whether THIS run may author a deck: the `pptx` skill's policy, then Bash/Write access. */
export type DeckAuthoringStatus = "allowed" | "read-only" | "skill-disabled";

/**
 * Mirrors the two gates a deck build actually passes: the admin skill policy
 * (the PreToolUse hook blocks `pptx` and `<plugin>:pptx`, so `other:pptx`
 * does NOT disable the bundled skill) and the elevated built-in tools the
 * converter's Bash command needs (a plain colleague or a restricted headless
 * run is read-only).
 */
export function deckAuthoringStatusFor(input: {
  elevatedToolAccess: boolean;
  disabledSkills: string[];
  pptxSkillNames: string[];
}): DeckAuthoringStatus {
  if (input.disabledSkills.some((name) => input.pptxSkillNames.includes(name))) {
    return "skill-disabled";
  }
  return input.elevatedToolAccess ? "allowed" : "read-only";
}

/**
 * The prompt's two deck flags (promptBuilder `deckSection`): standing guidance
 * needs the toolchain, a turn that can publish files (the preview/download
 * card), AND a viewer allowed to author — the same `deckAuthoring` status
 * describe_system's deck line branches on. The converter branch wins when both
 * are set.
 */
export function deckGuidanceFlags(input: {
  deckRenderingAvailable: boolean;
  deckConverterInstalled: boolean;
  fileOutputActive: boolean;
  deckAuthoring: DeckAuthoringStatus;
}): { deckRenderingEnabled: boolean; deckConverterEnabled: boolean } {
  const canDeliver = input.fileOutputActive && input.deckAuthoring === "allowed";
  return {
    deckRenderingEnabled: input.deckRenderingAvailable && canDeliver,
    deckConverterEnabled: input.deckConverterInstalled && canDeliver,
  };
}

/** Document types the server can rasterize into page previews. */
export const PREVIEWABLE_EXTENSIONS = ["pptx", "docx", "xlsx", "pdf"] as const;

export function isPreviewableExtension(ext: string): boolean {
  return (PREVIEWABLE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/** Cap on auto-rendered preview pages (matches the hidden-publish budget). */
export const MAX_PREVIEW_PAGES = 30;

/** Per-stage (soffice / pdftoppm) time budget for an auto-render. */
const RENDER_STAGE_TIMEOUT_MS = 120_000;

/**
 * Order pdftoppm outputs numerically: it emits `slide-1.png`…`slide-10.png`
 * for short docs but zero-pads (`slide-01.png`) for longer ones, so a plain
 * lexicographic sort would interleave pages. Exported for tests.
 */
export function sortSlideFiles(names: string[]): string[] {
  const pageNo = (name: string) => {
    const match = /-(\d+)\.png$/i.exec(name);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };
  return [...names].sort((a, b) => pageNo(a) - pageNo(b));
}

/**
 * Rasterize a stored document into per-page PNG buffers (page order), fully
 * SERVER-SIDE — the agent never has to render/publish slides itself. pdf goes
 * straight through pdftoppm; office formats convert to pdf first via a
 * profile-isolated headless soffice (parallel conversions would otherwise
 * fight over the shared profile lock). Returns [] when the toolchain is
 * missing or anything fails — callers treat previews as best-effort.
 */
export async function renderDocumentPreviews(
  sourcePath: string,
  ext: string,
): Promise<Buffer[]> {
  if (!probeDocumentPreviews() || !isPreviewableExtension(ext)) {
    return [];
  }
  let workDir: string | null = null;
  try {
    workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "deck-preview-"));
    let pdfPath = sourcePath;
    if (ext.toLowerCase() !== "pdf") {
      await execFileAsync(
        "soffice",
        [
          "--headless",
          "--norestore",
          `-env:UserInstallation=file://${workDir}/lo-profile`,
          "--convert-to",
          "pdf",
          "--outdir",
          workDir,
          sourcePath,
        ],
        { timeout: RENDER_STAGE_TIMEOUT_MS },
      );
      const base = path.basename(sourcePath);
      pdfPath = path.join(workDir, `${base.slice(0, base.lastIndexOf("."))}.pdf`);
    }
    await fs.promises.access(pdfPath);
    await execFileAsync(
      "pdftoppm",
      ["-png", "-r", "120", "-l", String(MAX_PREVIEW_PAGES), pdfPath, path.join(workDir, "slide")],
      { timeout: RENDER_STAGE_TIMEOUT_MS },
    );
    const entries = await fs.promises.readdir(workDir);
    const slides = sortSlideFiles(entries.filter((name) => /^slide-\d+\.png$/i.test(name))).slice(
      0,
      MAX_PREVIEW_PAGES,
    );
    const buffers: Buffer[] = [];
    for (const name of slides) {
      buffers.push(await fs.promises.readFile(path.join(workDir, name)));
    }
    return buffers;
  } catch (err) {
    deckLogger.warn({ err, sourcePath, ext }, "document preview render failed");
    return [];
  } finally {
    if (workDir) {
      fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
