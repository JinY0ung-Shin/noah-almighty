// How a run's failure reads to its callers: whether it was a transient MODEL or
// SERVER-side problem (worth another model or a later retry), and the Korean
// text a turn that ended in an in-band error shows instead of model output.

import { isRecord } from "./agentUtils.js";

// HTTP statuses that indicate a transient model/server-side condition worth
// retrying on a different model (overload/rate-limit/5xx/timeout).
const RETRYABLE_MODEL_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * Whether a run failure looks like a transient MODEL or SERVER-side problem
 * (overloaded, rate-limited, 5xx, network) — as opposed to a genuine error (bad
 * request, auth, a tool failure). The chat route uses it to suggest another
 * model. Inspects a numeric `status` first (pi-gateway errors and failed pi
 * turns carry one), then the message text.
 */
export function isRetryableModelError(error: unknown): boolean {
  const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  if (status && RETRYABLE_MODEL_STATUS.has(status)) {
    return true;
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /overloaded|rate.?limit|too many requests|\b408\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|\b529\b|internal server error|service unavailable|bad gateway|gateway timeout|timed?\s?out|etimedout|econnreset|econnrefused|enotfound|socket hang up|fetch failed|connection error|network error|server_error|api_error/.test(
    message,
  );
}

/** User-facing (Korean) text for a turn that ended in an in-band error subtype. */
export function resultErrorMessage(subtype: string): string {
  if (subtype === "error_max_turns") {
    return "응답이 최대 처리 단계에 도달해 중단되었습니다. 질문을 더 작게 나눠 다시 시도해 주세요.";
  }
  return "응답 생성 중 오류가 발생해 완료하지 못했습니다. 다시 시도해 주세요.";
}
