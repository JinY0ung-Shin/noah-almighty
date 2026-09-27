/**
 * Process-warning filter for ONE advisory the Agent SDK prints on every run.
 *
 * SDK 0.3.283+ emits `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` whenever `canUseTool`
 * is set alongside bare `allowedTools` entries. It tells the host that those
 * tools skip the callback and that a PreToolUse hook is the way to gate every
 * call. That is exactly this app's design: the hook is the gate and
 * `canUseTool` is only a confirmer (`buildCanUseToolSafetyNet`). Its tool list
 * is not even accurate here, because the CLI still asks the callback about
 * ExitPlanMode and protected-path writes. So the warning is one long stderr
 * line of noise per agent run. Every other warning still reaches Node's
 * default handler untouched.
 */
const SUPPRESSED_WARNING_CODES: ReadonlySet<string> = new Set([
  "CLAUDE_SDK_CAN_USE_TOOL_SHADOWED",
]);

/** The `code` of a `process.emitWarning` call, in any of its call shapes. */
export function processWarningCode(warning: unknown, args: unknown[]): string | undefined {
  const [first, second] = args;
  if (first && typeof first === "object") {
    const code = (first as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  // Positional form: emitWarning(warning, type, code, ctor).
  if (typeof first === "string" && typeof second === "string") {
    return second;
  }
  if (warning instanceof Error) {
    const code = (warning as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

let installed = false;

/** Wrap `process.emitWarning` once so SUPPRESSED_WARNING_CODES never print. */
export function filterAdvisoryProcessWarnings(): void {
  if (installed) {
    return;
  }
  installed = true;
  const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
    const code = processWarningCode(warning, args);
    if (code && SUPPRESSED_WARNING_CODES.has(code)) {
      return;
    }
    emitWarning(warning, ...args);
  }) as typeof process.emitWarning;
}
