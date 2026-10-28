// Pure per-call policy: tool deny list, command deny rules (incl. every command_batch step), clamps.

/** `ui_*` style glob (trailing `*` only) or exact match. */
export function globMatch(pattern, name) {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

/** Tools the relay serves: the app's list minus denied names. */
export function filterTools(tools, deniedTools) {
  return tools.filter((t) => t && typeof t.name === "string" && !deniedTools.some((p) => globMatch(p, t.name)));
}

const normId = (id) => id.trim().toLowerCase();

function ruleMatchesId(rule, id) {
  const m = rule.match.toLowerCase();
  if (m.endsWith(".*")) {
    const prefix = m.slice(0, -1); // keeps the trailing dot
    if (!id.startsWith(prefix)) return false;
  } else if (id !== m) {
    return false;
  }
  return !(rule.except ?? []).some((e) => e.toLowerCase() === id);
}

/** A value that looks like a filesystem path rather than a built-in id. */
export function looksLikePath(v) {
  return typeof v === "string" && (/[/\\]/.test(v) || /\.(icc|icm)$/i.test(v.trim()) || v.trim().startsWith("~"));
}

/**
 * Check one engine command. Returns the matching rule's reason, or null when allowed.
 * @param {{deniedCommands: readonly any[]}} app
 * @param {string} id
 * @param {unknown} params
 */
export function commandDenial(app, id, params) {
  const nid = normId(id);
  const p = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  for (const rule of app.deniedCommands) {
    if (!ruleMatchesId(rule, nid)) continue;
    if (rule.param) {
      const v = p[rule.param];
      if (v === undefined || v === null) continue;
      if (rule.pathLike && !looksLikePath(v)) continue;
    }
    return rule.reason;
  }
  return null;
}

/** An isError tool result carrying `text`. */
export function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

const deniedText = (app, what, reason) =>
  `Denied by the Noah craft-runner: ${app.label} ${what} is not available in this session. ${reason}.`;

/**
 * Evaluate one tools/call. Never throws.
 * @param {object} app            registry entry
 * @param {Set<string>} served    tool names the relay serves (manifest after filtering)
 * @param {unknown} name
 * @param {unknown} args
 * @returns {{ ok: true, args: Record<string, unknown> } | { ok: false, result: object, command?: string }}
 */
export function evaluateToolCall(app, served, name, args) {
  if (typeof name !== "string" || !name) return { ok: false, result: errorResult("tools/call needs a tool name.") };
  if (app.deniedTools.some((p) => globMatch(p, name))) {
    return {
      ok: false,
      result: errorResult(
        deniedText(app, `tool \`${name}\``, "It drives a desktop window, which does not exist in the headless runner; use the doc_* / command_* / render_preview tools instead"),
      ),
    };
  }
  if (!served.has(name)) {
    return { ok: false, result: errorResult(`Unknown ${app.label} tool \`${name}\`. Call tools/list for the available tools.`) };
  }
  const a = args === undefined || args === null ? {} : args;
  if (typeof a !== "object" || Array.isArray(a)) {
    return { ok: false, result: errorResult("Tool arguments must be a JSON object.") };
  }
  const spec = app.commandTools?.[name];
  if (spec) {
    const denial = checkCommandTool(app, spec, a);
    if (denial) return { ok: false, ...denial };
  }
  return { ok: true, args: applyClamps(app, name, a) };
}

function checkCommandTool(app, spec, a) {
  if (spec.stepsArg) {
    const steps = a[spec.stepsArg];
    if (!Array.isArray(steps)) {
      return { result: errorResult(`\`${spec.stepsArg}\` must be an array of {id, params} steps.`) };
    }
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const id = step && typeof step === "object" && !Array.isArray(step) ? step[spec.idArg] : undefined;
      if (typeof id !== "string") {
        return { result: errorResult(`Step ${i} of \`${spec.stepsArg}\` needs a string \`${spec.idArg}\`.`) };
      }
      const reason = commandDenial(app, id, step[spec.paramsArg]);
      if (reason) {
        return {
          command: id,
          result: errorResult(`${deniedText(app, `command \`${id}\` (step ${i})`, reason)} No step of this batch was run.`),
        };
      }
    }
    return null;
  }
  const id = a[spec.idArg];
  if (typeof id !== "string") return { result: errorResult(`\`${spec.idArg}\` must be a command id string.`) };
  const reason = commandDenial(app, id, a[spec.paramsArg]);
  return reason ? { command: id, result: errorResult(deniedText(app, `command \`${id}\``, reason)) } : null;
}

/** Apply the app's argument clamps for `name` (returns a shallow copy when anything changes). */
export function applyClamps(app, name, args) {
  let out = args;
  for (const c of app.clamps ?? []) {
    if (!c.tools.includes(name)) continue;
    const v = out[c.arg];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const next = v > c.max || (c.zeroMeansMax && v === 0) ? c.max : v;
    if (next !== v) out = { ...out, [c.arg]: next };
  }
  return out;
}

/** The command id(s) a call runs, for logs (never params). */
export function commandIdsOf(app, name, args) {
  const spec = app.commandTools?.[name];
  if (!spec || !args || typeof args !== "object") return [];
  if (spec.stepsArg) {
    const steps = Array.isArray(args[spec.stepsArg]) ? args[spec.stepsArg] : [];
    return steps.map((s) => (s && typeof s[spec.idArg] === "string" ? s[spec.idArg] : "?")).slice(0, 20);
  }
  return typeof args[spec.idArg] === "string" ? [args[spec.idArg]] : [];
}
