// App registry. A P2 app (VectorCraft, DesignCraft, FigCraft) is ONE more entry here plus its
// binary in the Dockerfile — the relay, policy, self-test and mirroring are generic over this shape.
//
// Bumping an app version: change the Dockerfile pin (version + sha256), then re-verify:
//   1. the tool list (`expectedTools` — the boot self-test FAILS the app when it drifts),
//   2. the command catalogue against `deniedCommands` (command_list in a network-none container),
//   3. the clamps' argument names and ceilings.
// See README.md › "Bumping an app version".

/**
 * @typedef {object} CommandRule
 * @property {string} match            exact command id, or `prefix.*` for a whole family
 * @property {string[]} [except]       exact ids exempt from a family rule
 * @property {string} [param]          deny only when params[param] is present (non-null)
 * @property {boolean} [pathLike]      with `param`: deny only when that value looks like a filesystem path
 * @property {string} reason           English: why, and what to do instead
 */

const FILE_TOOLS = "use doc_open / doc_place / doc_replace_smart_object to read and doc_save / doc_export / doc_export_layers to write";

/** PhotoCraft 0.16.0 — tool list and command catalogue verified 2026-10-28 in a network-none container. */
export const PHOTOCRAFT = Object.freeze({
  id: "photocraft",
  label: "PhotoCraft",
  version: "0.16.0",
  bin: "/opt/craft/bin/photocraft-cli",
  /** argv: ALWAYS the headless `mcp` subcommand with both roots; never --bridge/--connect/--attach. */
  args: ({ readRoot, writeRoot }) => ["mcp", "--automation-read-root", readRoot, "--automation-write-root", writeRoot],
  /** Extra env on top of the runner's fixed allowlist (HOME, XDG_* dirs, TMPDIR, PATH, FONTCONFIG_FILE). */
  env: Object.freeze({
    // rayon would otherwise start one worker per HOST cpu in every process.
    RAYON_NUM_THREADS: "4",
  }),
  /** Bridge-only tools (drive a desktop window that does not exist here). */
  deniedTools: Object.freeze(["ui_*", "control_call"]),
  /** Exact tool set served after `deniedTools` filtering; any drift fails the boot self-test. */
  expectedTools: Object.freeze([
    "command_batch",
    "command_list",
    "command_run",
    "doc_close",
    "doc_export",
    "doc_export_data_sets",
    "doc_export_layers",
    "doc_import_data_sets",
    "doc_inspect",
    "doc_new",
    "doc_open",
    "doc_place",
    "doc_render_preview",
    "doc_replace_smart_object",
    "doc_save",
    "doc_select",
    "jobs_cancel",
    "jobs_list",
    "render_preview",
    "session_list",
  ]),
  /** Tools that run engine commands, and where the command id(s) live in their arguments. */
  commandTools: Object.freeze({
    command_run: { idArg: "id", paramsArg: "params" },
    command_batch: { stepsArg: "steps", idArg: "id", paramsArg: "params" },
  }),
  /**
   * Defense in depth over PhotoCraft's own automation gate (which already refuses ambient-path
   * commands): a second, runner-side list that also removes INDIRECTION (actions, scripts, droplets,
   * batch) so this list cannot be bypassed by nesting, plus prefs/plug-ins/updates.
   * @type {readonly CommandRule[]}
   */
  deniedCommands: Object.freeze([
    {
      match: "file.*",
      except: [
        "file.new",
        "file.newFromClipboard",
        "file.close",
        "file.closeAll",
        "file.closeOthers",
        "file.fileInfo",
        "file.automate.fitImage",
        "file.automate.conditionalModeChange",
        "file.automate.cropAndStraightenPhotos",
        "file.scripts.deleteAllEmptyLayers",
        "file.scripts.flattenAllLayerEffects",
        "file.scripts.flattenAllMasks",
      ],
      reason: `File-menu commands that touch files, scripts, droplets, printing or batch processing are disabled; ${FILE_TOOLS}`,
    },
    { match: "actions.*", reason: "Actions (recorded command lists) are disabled; run the steps directly with command_batch" },
    { match: "plugin.*", reason: "Plug-in installation and execution are disabled in this session" },
    { match: "prefs.set", reason: "Preferences are read-only in this session (prefs.get still works)" },
    { match: "prefs.reset", reason: "Preferences are read-only in this session (prefs.get still works)" },
    { match: "help.*", reason: "Help and update commands are not available in the headless runner" },
    { match: "updates.*", reason: "Help and update commands are not available in the headless runner" },
    { match: "edit.keyboardShortcuts", reason: "Keyboard-shortcut files are disabled in this session" },
    { match: "edit.colorSettings", reason: "Colour settings scan OS profile folders and are disabled; use edit.assignProfile / edit.convertToProfile with a built-in profile id" },
    { match: "edit.installedProfiles", reason: "Listing OS colour profiles is disabled; use the built-in profile ids" },
    { match: "edit.presets.migratePresets", reason: "Preset migration reads arbitrary files and is disabled" },
    { match: "color.profileMismatch", reason: "Profile-mismatch handling scans OS profile folders and is disabled" },
    { match: "view.proofSetup", param: "profile", pathLike: true, reason: "Proof profiles must be built-in ids, not file paths" },
    { match: "edit.assignProfile", param: "profile", pathLike: true, reason: "Colour profiles must be built-in ids, not file paths" },
    { match: "edit.convertToProfile", param: "profile", pathLike: true, reason: "Colour profiles must be built-in ids, not file paths" },
    { match: "edit.profileInfo", param: "profile", pathLike: true, reason: "Colour profiles must be built-in ids, not file paths" },
    { match: "view.gamutWarning", param: "profile", pathLike: true, reason: "Colour profiles must be built-in ids, not file paths" },
    { match: "image.mode.*", param: "profile", pathLike: true, reason: "Colour profiles must be built-in ids, not file paths" },
    { match: "layer.smartObjects.replaceContents", reason: "Use the doc_replace_smart_object tool (it reads beneath the read root)" },
    { match: "layer.smartObjects.exportContents", reason: `Exporting smart-object contents to a path is disabled; ${FILE_TOOLS}` },
    { match: "layer.smartObjects.relinkToFile", reason: "Linked smart objects are disabled; place files embedded with doc_place" },
    { match: "layer.smartObjects.convertToLinked", reason: "Linked smart objects are disabled; keep them embedded" },
    { match: "layer.smartObjects.revealInFinder", reason: "Revealing files is not available in the headless runner" },
    { match: "layer.smartObjects.updateChanged", reason: "Linked smart objects are disabled" },
    { match: "layer.smartObjects.updateModifiedContent", reason: "Linked smart objects are disabled" },
    { match: "layer.smartObjects.updateAllModifiedContent", reason: "Linked smart objects are disabled" },
    { match: "layer.quickExportAsPng", reason: `Per-layer path exports are disabled; ${FILE_TOOLS}` },
    { match: "layer.exportAs", reason: `Per-layer path exports are disabled; ${FILE_TOOLS}` },
    { match: "pattern.export", reason: "Pattern files cannot be written by path in this session" },
    { match: "pattern.import", param: "path", reason: "Import patterns from base64 `data`, not a path" },
    { match: "measurementLog.export", param: "path", reason: "Omit `path` to get the CSV text back instead" },
    { match: "swatches.import", param: "path", reason: "Import swatches from base64 `data`, not a path" },
    { match: "swatches.export", param: "path", reason: "Omit `path` to get the bytes back as base64 `data`" },
    { match: "brush.presets.importAbr", param: "path", reason: "Import brushes from base64 `data`, not a path" },
    { match: "brush.presets.importImage", param: "path", reason: "Import brush images from base64 `data`, not a path" },
    { match: "gradient.presets.importGrd", param: "path", reason: "Import gradients from base64 `data`, not a path" },
    { match: "style.presets.importAsl", param: "path", reason: "Import styles from base64 `data`, not a path" },
    { match: "style.presets.exportAsl", param: "path", reason: "Omit `path` to get the bytes back as base64 `data`" },
    { match: "layer.layerStyle.contours.load", param: "path", reason: "Load contours from base64 `data`, not a path" },
    { match: "layer.layerStyle.contours.save", param: "path", reason: "Omit `path` to get the bytes back as base64 `data`" },
    { match: "image.adjustments.colorLookup", param: "file", reason: "Use a built-in `lut` name; LUT files by path are disabled" },
    { match: "layer.newAdjustmentLayer.colorLookup", param: "file", reason: "Use a built-in `lut` name; LUT files by path are disabled" },
    { match: "filter.distort.displace", param: "mapPath", reason: "Use `mapDocument` (an open document) instead of a map file path" },
  ]),
  /** Argument clamps (spec §4): previews ≤ 1568 px = Claude's standard-tier vision size. */
  clamps: Object.freeze([
    { tools: ["render_preview", "doc_render_preview"], arg: "max_side", max: 1568, zeroMeansMax: true },
  ]),
  /** Boot self-test: the tool that opens a file by path, and how to build its arguments. */
  selfTest: Object.freeze({ openTool: "doc_open", openArgs: (p) => ({ path: p }) }),
});

/** Apps served in this build (P1: PhotoCraft only). */
export const APPS = Object.freeze([PHOTOCRAFT]);

const FORBIDDEN_FLAGS = ["--bridge", "--connect", "--attach", "--control", "--control-token", "--control-token-file"];
const FORBIDDEN_SUBCOMMANDS = ["run", "batch", "convert", "droplet", "serve", "info"];
const RESERVED_ENV = ["PATH", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "TMPDIR", "FONTCONFIG_FILE"];

/**
 * Structural validation of a registry entry. Throws an Error naming the first problem.
 * Run at boot for every app and in tests for the shipped registry.
 */
export function validateApp(app) {
  const fail = (m) => {
    throw new Error(`app ${app?.id ?? "?"}: ${m}`);
  };
  if (!app || typeof app !== "object") fail("not an object");
  if (!/^[a-z][a-z0-9]{1,31}$/.test(app.id)) fail("id must be lowercase alphanumeric");
  if (typeof app.label !== "string" || !app.label) fail("label missing");
  if (typeof app.version !== "string" || !app.version) fail("version missing");
  if (typeof app.bin !== "string" || !app.bin.startsWith("/")) fail("bin must be an absolute path");
  const argv = app.args({ readRoot: "/r", writeRoot: "/r/out" });
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== "string")) fail("args must return string[]");
  if (FORBIDDEN_SUBCOMMANDS.includes(argv[0])) fail(`subcommand ${argv[0]} is trusted-local and never allowed`);
  for (const a of argv) {
    if (FORBIDDEN_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))) fail(`flag ${a} is never allowed`);
  }
  if (!argv.includes("/r") || !argv.includes("/r/out")) fail("args must pass both the read and the write root");
  for (const k of Object.keys(app.env ?? {})) {
    if (RESERVED_ENV.includes(k)) fail(`env ${k} is set by the runner`);
    if (/CONTROL|BRIDGE|TOKEN|SECRET|PROXY/i.test(k)) fail(`env ${k} is not allowed`);
  }
  if (!Array.isArray(app.deniedTools) || !Array.isArray(app.expectedTools)) fail("deniedTools/expectedTools missing");
  if (!Array.isArray(app.deniedCommands)) fail("deniedCommands missing");
  for (const r of app.deniedCommands) {
    if (typeof r.match !== "string" || !r.match) fail("command rule without match");
    if (typeof r.reason !== "string" || !r.reason) fail(`command rule ${r.match} without reason`);
  }
  if (!app.selfTest || typeof app.selfTest.openTool !== "string" || typeof app.selfTest.openArgs !== "function") {
    fail("selfTest.openTool/openArgs missing");
  }
  if (!app.expectedTools.includes(app.selfTest.openTool)) fail("selfTest.openTool must be an expected tool");
  return app;
}
