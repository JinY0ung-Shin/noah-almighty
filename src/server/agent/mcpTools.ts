// Shared helpers for the in-process MCP tool servers (`agent/*Tools.ts`). Each
// tool returns a content block to the model; this is the single definition of
// that result shape so every server stays byte-compatible.

import { scrubGitError } from "../marketplace.js";

/** Build an MCP tool result carrying a single text block. `isError` marks a refusal/failure. */
export function text(message: string, isError = false) {
  return { content: [{ type: "text" as const, text: message }], isError };
}

/**
 * Map a knowledge-repo file-op error (the value `scrubGitError` returns) to its
 * agent-facing English message. The repo and group-repo servers share the same
 * filesystem sentinels (`INVALID_PATH`/`FILE_TOO_LARGE`/`NOT_A_FILE`/
 * `SKILL_EXISTS`); the per-operation copy varies only in the FILE_TOO_LARGE
 * wording and the catch-all fallback, so callers pass those in.
 */
export function decodeRepoFsError(
  detail: string,
  opts: { tooLarge?: string; notAFile?: string; skillExists?: string; fallback: string },
): string {
  if (detail === "INVALID_PATH") return "Invalid path.";
  if (detail === "FILE_TOO_LARGE" && opts.tooLarge) return opts.tooLarge;
  if (detail === "NOT_A_FILE" && opts.notAFile) return opts.notAFile;
  if (detail === "SKILL_EXISTS" && opts.skillExists) return opts.skillExists;
  return `${opts.fallback}: ${detail}`;
}

/**
 * Reduce a child-process / git error (which may carry `stderr`/`stdout` as a
 * string or Buffer) to a single scrubbed message string, plus the numeric exit
 * code when present. Shared by the knowledge-repo (`gh`) and general git-repo
 * servers, which both prefer stderr→stdout→message and run it through
 * `scrubGitError`. `redactToken`, if given, masks the token before scrubbing.
 * Each part is capped at ~2 KB and the whole at ~4 KB: a failed command's
 * stdout can be a megabyte of listing (a `git ls-files` past its buffer once
 * was), all of which would otherwise land in the tool result. Redaction and
 * scrubbing run on each FULL part before it is cut, so a cut never leaves a
 * partial secret behind.
 */
export function decodeExecError(
  error: unknown,
  opts: { redactToken?: string; fallback?: string } = {},
): { message: string; exitCode?: number } {
  const err = error as Error & {
    stderr?: string | Buffer;
    stdout?: string | Buffer;
    code?: unknown;
  };
  const clean = (value: string): string => {
    const redacted = opts.redactToken
      ? value.replace(new RegExp(opts.redactToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[REDACTED]")
      : value;
    return scrubGitError(redacted);
  };
  const parts = [err.stderr, err.stdout, err.message]
    .map((part) => (Buffer.isBuffer(part) ? part.toString("utf8") : part))
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => truncateChars(clean(part.trim()), EXEC_ERROR_PART_CHARS));
  const joined = parts.join("\n").trim() || clean(opts.fallback || String(error));
  return {
    message: truncateChars(joined, EXEC_ERROR_TOTAL_CHARS),
    exitCode: typeof err.code === "number" ? err.code : undefined,
  };
}

/** Per-part and whole caps on a decoded exec error (characters). */
const EXEC_ERROR_PART_CHARS = 2048;
const EXEC_ERROR_TOTAL_CHARS = 4096;

function truncateChars(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}… [truncated, ${value.length - max} more characters]` : value;
}

export {
  createMcpToolServer,
  tool,
  type InProcessMcpServer,
  type McpToolArgs,
  type McpToolDefinition,
  type McpToolExtra,
  type McpToolShape,
} from "./mcpServer.js";
