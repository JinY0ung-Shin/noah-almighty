// The 파일 tab's two reads (`/api/me/workspace*`): one folder's listing and one
// file's bytes. The contract — shapes, caps, what may be previewed — is
// `src/shared/workspaceFiles.ts`; nothing here writes.
import { ApiError, api, sessionExpiredError } from "./api";
import { WORKSPACE_TEXT_PREVIEW_MAX_BYTES, type WorkspaceListing } from "../../../shared/workspaceFiles";

/** One folder (`""` = the workspace root). `conversationId` only asks for `current`, that conversation's folder. */
export function loadWorkspaceFolder(path: string, conversationId: string, signal?: AbortSignal): Promise<WorkspaceListing> {
  const query = new URLSearchParams();
  if (path) query.set("path", path);
  if (conversationId) query.set("conversation", conversationId);
  const suffix = query.toString();
  return api<WorkspaceListing>(`/api/me/workspace${suffix ? `?${suffix}` : ""}`, { signal });
}

/**
 * The file route's address. Without `preview` it is the DOWNLOAD link; with it
 * the tab's own read (an `<img>` source, a text fetch), which the server
 * refuses past the preview cap. `version` only makes a re-read a new URL for
 * the `<img>` cache.
 */
export function workspaceFileUrl(path: string, preview = false, version = 0): string {
  const query = new URLSearchParams({ path });
  if (preview) query.set("preview", "1");
  if (version) query.set("v", String(version));
  return `/api/me/workspace/file?${query.toString()}`;
}

/** A text-like file's bytes for a preview; throws a Korean `ApiError` (413 when it outgrew the text cap). */
export async function fetchWorkspaceBytes(path: string, signal?: AbortSignal): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(workspaceFileUrl(path, true), { credentials: "same-origin", signal });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    throw new Error("서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.");
  }
  if (response.status === 401) throw sessionExpiredError();
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new ApiError(
      typeof body.error === "string" && body.error ? body.error : "파일을 불러오지 못했습니다.",
      response.status,
    );
  }
  // The listing's size may be stale (the agent is still writing): judge what arrived.
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > WORKSPACE_TEXT_PREVIEW_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError("미리보기에는 너무 큰 파일입니다. 다운로드해서 확인해 주세요.", 413);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > WORKSPACE_TEXT_PREVIEW_MAX_BYTES) {
    throw new ApiError("미리보기에는 너무 큰 파일입니다. 다운로드해서 확인해 주세요.", 413);
  }
  return bytes;
}
