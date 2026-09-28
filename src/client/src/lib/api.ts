import { readState, replaceState } from "./state";

const API_ERROR_KO: Record<string, string> = {
  "Internal server error": "서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
  "Authentication required": "로그인이 필요합니다.",
  "Admin access required": "관리자 권한이 필요합니다.",
};

// The server phrases `apiError` in Korean, but an unmapped English string can
// still reach us (legacy rows, an unexpected path, a proxy's own error body).
// Raw English in a Korean UI reads as a crash, so wrap it in a Korean sentence
// and keep the original as the detail instead of hiding it.
function localizeApiError(raw: string): string {
  if (!raw) return "";
  return /[가-힣]/.test(raw) ? raw : `서버 오류가 발생했습니다. (상세: ${raw})`;
}

/**
 * A non-OK response. The message stays the Korean sentence every caller already
 * shows; `status` lets the few callers that must tell outcomes apart (the share
 * viewer's dead-link vs. retry states) do so without string-matching it.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let sessionExpiredHandler: (() => void) | null = null;

export function setSessionExpiredHandler(handler: () => void): void {
  sessionExpiredHandler = handler;
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      credentials: "same-origin",
      signal:
        options.signal ??
        (typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(120000) : undefined),
      ...options,
    });
  } catch (err) {
    if ((err as Error)?.name === "TimeoutError") {
      throw new Error("요청 시간이 초과되었습니다. 네트워크 상태를 확인해 주세요.");
    }
    if ((err as Error)?.name === "AbortError") throw err;
    throw new Error("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
  }
  if (response.status === 401 && readState().user) {
    sessionExpiredHandler?.();
    throw new ApiError("세션이 만료되었습니다. 다시 로그인해 주세요.", 401);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const raw = typeof body.error === "string" ? body.error.trim() : "";
    throw new ApiError(
      API_ERROR_KO[raw] ||
        localizeApiError(raw) ||
        `서버 오류가 발생했습니다. (코드 ${response.status}) 잠시 후 다시 시도해 주세요.`,
      response.status,
    );
  }
  return body as T;
}

export async function refreshMe(): Promise<void> {
  const { user } = await api<{ user: import("./types").User | null }>("/api/me");
  replaceState({ user });
}
