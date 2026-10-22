import type { ServerAgentErrorCode } from "../../shared/serverAgents.js";

/** A classified server-agent failure: `code` maps to the KO (UI) / EN (agent) tables in shared/serverAgents.ts. */
export class ServerAgentError extends Error {
  readonly code: ServerAgentErrorCode;
  /** Short technical detail (English, never a secret value). */
  readonly detail: string;
  constructor(code: ServerAgentErrorCode, detail = "") {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.name = "ServerAgentError";
    this.code = code;
    this.detail = detail;
  }
}

export function isServerAgentError(error: unknown): error is ServerAgentError {
  return error instanceof ServerAgentError;
}
