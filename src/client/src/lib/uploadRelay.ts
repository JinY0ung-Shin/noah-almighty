// The attach button on a deployment with an upload relay (`bootstrap.uploadRelay`).
//
// A DRM agent on the fleet decrypts a file only while it is uploaded to a
// registered address, which this app is not. So the button opens the relay's
// page in a popup instead of this page's own file dialog; the user picks the
// file THERE, the server pulls it back (`routes/uploadRelay.ts`) and this
// module hands it to the composer's ordinary intake as a `File` — from there
// on a relayed file is indistinguishable from a picked, pasted or dropped one.
//
// The popup is another origin: this page never reads it and never listens to
// it. The one thing taken from it is `closed`; what was uploaded is learned by
// asking our own server.

import { api } from "./api";
import { uploadRelayMediaType } from "../../../shared/uploadRelay";

const POPUP_NAME = "noah-upload-relay";
const POPUP_FEATURES = "popup,width=560,height=720";
const POLL_INTERVAL_MS = 2000;
/**
 * After the popup is seen closed the session keeps looking, more slowly, for
 * this long: a file whose upload finished as the window went away still
 * arrives — and so does one uploaded in a popup this page merely LOST SIGHT of
 * (a sign-in page that isolates its window makes `closed` read true while the
 * user is still in it).
 */
const POLL_AFTER_CLOSE_INTERVAL_MS = 5000;
const POLL_AFTER_CLOSE_MS = 120_000;
/** Consecutive failed polls before the session gives up (and says so). */
const MAX_POLL_FAILURES = 3;
/** Tries one file gets before it is given up on (a refusal or a file that is gone ends it at once). */
const MAX_COLLECT_ATTEMPTS = 3;
/** How long past the ticket's lifetime a still-open popup is watched (an upload made in its last second). */
const WATCH_PAST_EXPIRY_MS = 30_000;

export const UPLOAD_RELAY_POPUP_BLOCKED = "업로드 창을 열지 못했습니다. 이 사이트의 팝업을 허용한 뒤 다시 눌러 주세요.";
export const UPLOAD_RELAY_OPENED = "업로드 창에서 파일을 고르면 여기에 첨부됩니다.";
export const UPLOAD_RELAY_EXPIRED = "업로드 창이 만료되었습니다. 첨부 버튼을 다시 눌러 주세요.";
export const UPLOAD_RELAY_LOST = "업로드한 파일을 가져오지 못했습니다. 첨부 버튼을 눌러 다시 올려 주세요.";

type Notify = (message: string, level: "info" | "warn") => void;

export interface UploadRelayOptions {
  /** Whether the pane takes documents (else the ticket is images only). */
  documents: boolean;
  /** The composer's intake; called once per arrived file. */
  onFiles: (files: File[]) => void | Promise<void>;
  notify: Notify;
  /** Pause between polls while the popup is open (tests shorten it). */
  pollIntervalMs?: number;
}

interface Session {
  /** A newer press took over: look once more for what this ticket holds, then stop. */
  cancelled: boolean;
  /** Stop at the next step without touching anything (tests). */
  aborted: boolean;
}

interface TicketResponse {
  ticket: string;
  url: string;
  /** The ticket's lifetime as a DURATION: this page never compares its clock with the server's. */
  ttlSeconds?: number;
}

interface PollResponse {
  files: { id: string; name: string; size: number }[];
}

/** What one attempt at one relayed file came to. */
type Collected =
  | { kind: "file"; file: File }
  /** Final: the server judged the file and refused it (its Korean reason). */
  | { kind: "refused"; message: string }
  /** Final: the relay no longer has it (collected already, or its keep time ran out). */
  | { kind: "gone" }
  /** Not final: the file is still on the relay; try again on a later poll. */
  | { kind: "retry"; message: string };

/** The session of the last press. A new press ends it — after one last look for what its ticket still holds. */
let current: Session | null = null;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `popup.closed`, treating a window we can no longer ask as closed. */
function isClosed(popup: Window): boolean {
  try {
    return popup.closed;
  } catch {
    return true;
  }
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" && body.error ? body.error : `파일을 받지 못했습니다. (코드 ${response.status})`;
}

/**
 * One attempt at one relayed file: fetch its bytes, then CONFIRM that this
 * page has them. The confirmation is what the server records as the hand-over
 * (and what lets the relay drop its copy), so the file is given to the
 * composer only after it succeeded — a file is never attached without its
 * audit row, and never audited as received without having arrived.
 */
async function collect(ticket: string, entry: { id: string; name: string }): Promise<Collected> {
  const offline = "서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.";
  let blob: Blob;
  try {
    const response = await post("/api/chat/upload-relay/fetch", { ticket, fileId: entry.id });
    if (response.status === 404) return { kind: "gone" };
    if (response.status === 422) return { kind: "refused", message: await errorOf(response) };
    if (!response.ok) return { kind: "retry", message: await errorOf(response) };
    // The body can still break off after the headers arrived.
    blob = await response.blob();
  } catch {
    return { kind: "retry", message: offline };
  }
  try {
    const confirmed = await post("/api/chat/upload-relay/confirm", { ticket, fileId: entry.id });
    // 404: the server no longer remembers sending it (a restart) — fetch it again.
    if (!confirmed.ok) return { kind: "retry", message: await errorOf(confirmed) };
  } catch {
    return { kind: "retry", message: offline };
  }
  return { kind: "file", file: new File([blob], entry.name, { type: uploadRelayMediaType(entry.name) ?? "" }) };
}

/**
 * Open the relay page and feed what is uploaded there into `onFiles` until the
 * popup has been closed for a while or the ticket runs out. MUST be called
 * synchronously from the click: the popup is opened before anything is
 * awaited, or the browser blocks it. Resolves when the session is over
 * (callers need not wait) and never rejects.
 */
export async function startUploadRelay(options: UploadRelayOptions): Promise<void> {
  // Deliberately no `noopener`: `closed` is read from this handle.
  const popup = window.open("about:blank", POPUP_NAME, POPUP_FEATURES);
  if (!popup) {
    options.notify(UPLOAD_RELAY_POPUP_BLOCKED, "warn");
    return;
  }
  try {
    // The relay page gets no handle on THIS page (it could navigate it); our
    // handle on the popup, and its `closed`, are unaffected.
    popup.opener = null;
  } catch {
    // A reused popup that already left for the relay's origin: it was disowned on its first press.
  }
  if (current) current.cancelled = true;
  const session: Session = { cancelled: false, aborted: false };
  current = session;
  try {
    await runSession(popup, session, options);
  } catch (error) {
    options.notify((error as Error)?.message || UPLOAD_RELAY_LOST, "warn");
  }
}

async function runSession(popup: Window, session: Session, options: UploadRelayOptions): Promise<void> {
  let ticket: TicketResponse;
  try {
    ticket = await api<TicketResponse>("/api/chat/upload-relay/tickets", {
      method: "POST",
      body: JSON.stringify({ documents: options.documents }),
    });
  } catch (error) {
    popup.close();
    options.notify((error as Error).message, "warn");
    return;
  }
  if (session.cancelled || session.aborted || isClosed(popup)) return;
  popup.location.replace(ticket.url);
  options.notify(UPLOAD_RELAY_OPENED, "info");

  /** Files that reached a final outcome (handed over, refused, gone or given up on). */
  const settled = new Set<string>();
  const attempts = new Map<string, number>();
  const watchUntil = Date.now() + (ticket.ttlSeconds ?? 600) * 1000 + WATCH_PAST_EXPIRY_MS;
  let failures = 0;
  let closedAt: number | null = null;
  for (;;) {
    if (session.aborted) return;
    // A newer press took the popup over: look once more for what THIS ticket
    // still holds (a file uploaded a moment before the press), then stop.
    const lastLook = session.cancelled;
    const closed = isClosed(popup);
    if (closed && closedAt === null) closedAt = Date.now();
    let listed: PollResponse["files"] = [];
    try {
      listed = (await api<PollResponse>("/api/chat/upload-relay/poll", { method: "POST", body: JSON.stringify({ ticket: ticket.ticket }) })).files ?? [];
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= MAX_POLL_FAILURES && !lastLook) {
        options.notify((error as Error).message, "warn");
        return;
      }
    }
    for (const entry of listed) {
      if (session.aborted) return;
      if (settled.has(entry.id)) continue;
      const result = await collect(ticket.ticket, entry);
      if (result.kind === "retry") {
        const tried = (attempts.get(entry.id) ?? 0) + 1;
        attempts.set(entry.id, tried);
        // Still on the relay: the next poll tries again, a few times.
        if (tried < MAX_COLLECT_ATTEMPTS && !lastLook) continue;
        options.notify(`'${entry.name}': ${result.message}`, "warn");
      } else if (result.kind === "refused") {
        options.notify(`'${entry.name}': ${result.message}`, "warn");
      } else if (result.kind === "file") {
        await options.onFiles([result.file]);
      }
      settled.add(entry.id);
    }
    if (lastLook) return;
    if (closedAt !== null) {
      if (Date.now() - closedAt > POLL_AFTER_CLOSE_MS) return;
    } else if (Date.now() > watchUntil) {
      options.notify(UPLOAD_RELAY_EXPIRED, "info");
      return;
    }
    await sleep(closedAt !== null ? POLL_AFTER_CLOSE_INTERVAL_MS : (options.pollIntervalMs ?? POLL_INTERVAL_MS));
  }
}

/** Test seam: forget the session of an earlier test. */
export function resetUploadRelayForTests(): void {
  if (current) current.aborted = true;
  current = null;
}
