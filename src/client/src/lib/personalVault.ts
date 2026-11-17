// Personal vault (개인 브레인) home + its git mirror, as the two screens that
// show it read it: 설정 ▸ 지식·플러그인 (`SettingsVaultStatus`) and 관리자 ▸
// 시스템 ▸ 개인 브레인 이전 (`AdminPersonalVaultPanel`).
//
// The response shapes are declared HERE because their server home
// (`src/server/routes/personalVault.ts`, `src/server/vaultMigration.ts`) is not
// one of the server modules the client may import (`tsconfig.client.json`).
// Keep them in step with those two files.
//
// The server reports a mirror failure, a migration blocker and a skipped file
// as short English text (it is also what the avatar reads). A person reads a
// Korean sentence here; text this file does not know is shown as it came.
import { timeLabel } from "./format";
import {
  VAULT_BLOCKER_KO,
  VAULT_LEFTOVER_BLOCKERS,
  VAULT_MIRROR_ERROR_KINDS,
  VAULT_MIRROR_NOTICE_PREFIX,
  VAULT_SKIP_KO,
  type VaultMirrorFailure,
} from "./personalVaultCodes";

export type { VaultMirrorFailure } from "./personalVaultCodes";

export type VaultHome = "repo" | "memory";

/** The push-only copy of a `memory` vault in the owner's repository. */
export interface VaultMirrorState {
  /** A vault write happened since the last successful copy. */
  dirty: boolean;
  syncedAt: string | null;
  /** Why the last attempt failed; null when it worked. */
  error: string | null;
  /**
   * The copy does not write into the connected repository while this is set.
   * `checking`: a repository or branch was just connected and nobody has looked
   * at it yet. `confirm`: the look found vault notes there that the copy would
   * replace — the owner must confirm.
   */
  hold: VaultMirrorHold | null;
  /** What the last successful copy has to tell the owner (repository notes the memory service does not hold); null = nothing. */
  notice: string | null;
}

export type VaultMirrorHold = "checking" | "confirm";

/**
 * The mirror as the screens use it, whatever a server sent: a `hold` that is
 * neither of the two states (and not empty) reads as `checking` — the neutral
 * one, which offers no button.
 */
export function normalizeVaultMirror(raw: unknown): VaultMirrorState | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  return {
    dirty: m.dirty === true,
    syncedAt: typeof m.syncedAt === "string" ? m.syncedAt : null,
    error: typeof m.error === "string" && m.error ? m.error : null,
    hold: m.hold === "confirm" ? "confirm" : m.hold ? "checking" : null,
    notice: typeof m.notice === "string" && m.notice ? m.notice : null,
  };
}

/** `GET /api/me/personal-vault`. */
export interface MyPersonalVault {
  home: VaultHome;
  mirror: VaultMirrorState | null;
  /** False = this server has no memory service configured (an older server that does not say counts as configured). */
  serviceConfigured: boolean;
  /**
   * Home `memory`: whether the memory service answered the server's check of this vault just now — `ok`,
   * `unavailable` (no answer) or `refused` (it answered but would not serve this vault). Null for home `repo`,
   * a server without the service, or an older server that does not say.
   */
  service: "ok" | "unavailable" | "refused" | null;
}

export type VaultOwnerState = "repo" | "memory" | "no_repo";

/** One owner's dry-run or cutover report (`VaultMigrationReport` in `vaultMigration.ts`). */
export interface VaultMigrationReport {
  userId: string;
  repo: string | null;
  sourceCommit: string | null;
  notes: number;
  bytes: number;
  /** Files under `wiki/` / `raw/` that are not vault notes: they stay in the repository. */
  skipped: { path: string; reason: string }[];
  /** Non-empty: this owner is not moved. */
  blockers: string[];
  state: VaultOwnerState;
  /** When the server made this report (ISO); an older server sends none. */
  at?: string;
}

export interface AdminVaultOwner {
  userId: string;
  username: string;
  displayName: string;
  state: VaultOwnerState;
  repo: string | null;
  migratedAt: string | null;
  mirror: VaultMirrorState | null;
  /** The last dry-run or cutover report the server still holds for this owner. */
  report: VaultMigrationReport | null;
}

/** `GET /api/admin/personal-vaults`. */
export interface AdminPersonalVaults {
  mode: VaultHome;
  serviceConfigured: boolean;
  running: boolean;
  owners: AdminVaultOwner[];
}

/** The answers as the screens use them: every mirror normalized (`normalizeVaultMirror`). */
export function readMyPersonalVault(value: unknown): MyPersonalVault | null {
  if (!isMyPersonalVault(value)) return null;
  const raw = value as { serviceConfigured?: unknown; service?: unknown };
  const service = raw.service === "ok" || raw.service === "unavailable" || raw.service === "refused" ? raw.service : null;
  return { home: value.home, mirror: normalizeVaultMirror(value.mirror), serviceConfigured: raw.serviceConfigured !== false, service };
}

/** One moved owner's wiki size (`GET /api/admin/personal-vaults/usage`), or why it could not be listed. */
export type AdminVaultOwnerUsage =
  | { userId: string; notes: number; bytes: number }
  | { userId: string; error: "unavailable" | "refused" | "timeout" };

/** `GET /api/admin/personal-vaults/usage`: counts and sizes only, never a note's path or content. */
export interface AdminVaultUsage {
  serviceConfigured: boolean;
  /** The memory service's per-owner limits: past either it refuses to save (`wiki_full`). */
  limits: { notes: number; bytes: number };
  owners: AdminVaultOwnerUsage[];
}

export function readAdminVaultUsage(value: unknown): AdminVaultUsage | null {
  const v = value as AdminVaultUsage | null;
  if (!v || !Array.isArray(v.owners) || !v.limits || !(v.limits.notes > 0) || !(v.limits.bytes > 0)) return null;
  const owners = v.owners.filter(
    (o): o is AdminVaultOwnerUsage =>
      Boolean(o) && typeof o.userId === "string" && (("notes" in o && Number.isFinite(o.notes) && Number.isFinite(o.bytes)) || "error" in o),
  );
  return { serviceConfigured: v.serviceConfigured !== false, limits: { notes: v.limits.notes, bytes: v.limits.bytes }, owners };
}

/** How full a wiki is, as the larger of its two shares of the limits (0..100+, rounded down to a whole percent). */
export function vaultUsagePercent(usage: { notes: number; bytes: number }, limits: { notes: number; bytes: number }): number {
  return Math.floor(Math.max(usage.notes / limits.notes, usage.bytes / limits.bytes) * 100);
}

/** From this share of a limit on, the admin screen marks a wiki as nearly full. */
export const VAULT_USAGE_WARN_PERCENT = 80;

export function readAdminPersonalVaults(value: unknown): AdminPersonalVaults | null {
  if (!isAdminPersonalVaults(value)) return null;
  return {
    mode: value.mode,
    serviceConfigured: value.serviceConfigured === true,
    running: value.running === true,
    owners: value.owners.map((owner) => ({ ...owner, mirror: normalizeVaultMirror(owner.mirror) })),
  };
}

export function isMyPersonalVault(value: unknown): value is MyPersonalVault {
  const v = value as MyPersonalVault | null;
  return Boolean(v) && (v!.home === "repo" || v!.home === "memory");
}

export function isAdminPersonalVaults(value: unknown): value is AdminPersonalVaults {
  const v = value as AdminPersonalVaults | null;
  return Boolean(v) && (v!.mode === "repo" || v!.mode === "memory") && Array.isArray(v!.owners);
}

// ---- the copy's state ----

export type VaultMirrorKind = "checking" | "confirm" | "failed" | "waiting" | "synced";

/** One state at a time, the one a person has to act on first. */
export function vaultMirrorKind(mirror: VaultMirrorState): VaultMirrorKind {
  if (mirror.hold) return mirror.hold;
  if (mirror.error) return "failed";
  if (mirror.dirty) return "waiting";
  return "synced";
}

// What a failure is about is keyed on the server's closed list — see
// `VAULT_MIRROR_ERROR_KINDS` in `personalVaultCodes.ts`.

function splitMirrorError(raw: string): { head: string | null; detail: string } {
  const text = raw.trim();
  for (const head of Object.keys(VAULT_MIRROR_ERROR_KINDS)) {
    if (text === head) return { head, detail: "" };
    if (text.startsWith(`${head}: `)) return { head, detail: text.slice(head.length + 2).trim() };
    if (text.startsWith(`${head} (`) && text.endsWith(")")) return { head, detail: text.slice(head.length + 2, -1).trim() };
  }
  return { head: null, detail: text };
}

/** A failed push, told apart by git's own words: no permission, a branch that moved, or anything else. */
function pushFailure(detail: string): VaultMirrorFailure {
  const text = detail.toLowerCase();
  // A protected branch or a server hook: neither a new token scope nor a refresh fixes it, so git's words are shown.
  if (/remote rejected|protected branch|hook declined/.test(text)) return "other";
  if (/\b40[13]\b|denied|permission|authentication failed|could not read username|unauthorized/.test(text)) return "denied";
  if (/rejected|non-fast-forward|fetch first/.test(text)) return "rejected";
  return "other";
}

export function vaultMirrorFailure(raw: string): VaultMirrorFailure {
  const { head, detail } = splitMirrorError(raw);
  const kind = head ? VAULT_MIRROR_ERROR_KINDS[head] : "other";
  return kind === "push" ? pushFailure(detail) : kind;
}

/** The failure as one sentence a person can act on; text this file does not know is shown as it came. */
export function vaultMirrorFailureText(raw: string): string {
  const { detail } = splitMirrorError(raw);
  const more = detail ? ` (상세: ${detail})` : "";
  switch (vaultMirrorFailure(raw)) {
    case "no_token":
      return "Git 토큰이 없어 저장소에 올리지 못했습니다.";
    case "repo_dirty":
      return "저장소에 아직 커밋하지 않은 다른 변경이 있어 사본만 따로 올리지 않았습니다. 아바타가 저장소를 커밋하면 사본도 함께 올라갑니다.";
    case "rejected":
      return "저장소가 사본을 받지 않았습니다. 저장소에 이 서버가 아직 가져오지 않은 커밋이 있을 수 있습니다.";
    case "denied":
      return "Git 토큰으로 저장소에 올릴 권한이 없습니다. 토큰의 쓰기 권한을 확인해 주세요.";
    case "conflict":
      return `저장소에 새로 올라온 커밋과 이 서버가 아직 올리지 못한 커밋이 같은 파일을 고쳐서 사본을 올리지 못했습니다. 브레인 노트가 아닌 파일의 충돌이라 자동으로 정리되지 않고, 아바타도 풀 수 없습니다. 저장소에서 겹친 파일의 변경을 되돌려 올리거나, 관리자에게 서버 쪽 저장소 사본 정리를 요청해 주세요.${more}`;
    case "sync":
      return `저장소를 가져오지 못했습니다. 저장소 주소와 Git 토큰 권한을 확인해 주세요.${more}`;
    case "not_cloned":
      return "서버에 저장소 사본이 아직 없습니다. 위의 ‘새로고침’으로 저장소를 다시 가져와 주세요.";
    case "service":
      return "메모리 서비스에 연결하지 못해 사본을 만들지 못했습니다. 계속되면 관리자에게 알려 주세요.";
    case "refused":
      return `메모리 서비스가 요청을 받지 않아 사본을 만들지 못했습니다. 계속되면 관리자에게 알려 주세요.${more}`;
    case "path":
      return `저장소의 브레인 경로에 링크나 예상과 다른 파일·폴더가 있어 사본을 쓸 수 없습니다.${more}`;
    default:
      return `저장소에 올리지 못했습니다. (상세: ${raw})`;
  }
}

/** The short form for a table cell. */
export function vaultMirrorCellText(mirror: VaultMirrorState | null): string {
  if (!mirror) return "—";
  switch (vaultMirrorKind(mirror)) {
    case "checking":
      return "저장소 확인 중";
    case "confirm":
      return "보류 · 본인 확인 대기";
    case "failed":
      return `실패 · ${VAULT_MIRROR_FAILURE_SHORT[vaultMirrorFailure(mirror.error || "")] || mirror.error}`;
    case "waiting":
      return "올릴 변경 있음";
    default: {
      const at = timeLabel(mirror.syncedAt);
      return at ? `최신 · ${at}` : "최신";
    }
  }
}

const VAULT_MIRROR_FAILURE_SHORT: Record<VaultMirrorFailure, string> = {
  no_token: "Git 토큰 없음",
  repo_dirty: "저장소에 커밋하지 않은 변경",
  rejected: "저장소가 받지 않음",
  denied: "Git 토큰 권한 없음",
  conflict: "저장소 충돌",
  sync: "저장소를 가져오지 못함",
  not_cloned: "서버에 저장소 사본 없음",
  service: "메모리 서비스 연결 실패",
  refused: "메모리 서비스가 거절",
  path: "저장소의 브레인 경로가 막힘",
  other: "",
};

// ---- the notice ----

/**
 * How many repository notes the memory service does not hold, read from the
 * mirror's notice; null when the notice is something this file does not know
 * (it is then shown as it came).
 */
export function vaultMirrorNoticeCount(notice: string | null | undefined): number | null {
  if (!notice || !notice.startsWith(VAULT_MIRROR_NOTICE_PREFIX)) return null;
  const count = /\d+/.exec(notice.slice(VAULT_MIRROR_NOTICE_PREFIX.length));
  return count ? Number(count[0]) : null;
}

/** The notice for the OWNER (settings): what it is, that nothing was deleted, what it means, who can help. */
export function vaultMirrorNoticeText(notice: string): string {
  const count = vaultMirrorNoticeCount(notice);
  if (count === null) return notice;
  return `저장소 사본에는 메모리 서비스에 없는 노트가 ${count}개 있습니다. 아무것도 지우지 않았습니다. 이 노트들은 브레인에 들어 있지 않아 아바타가 찾거나 읽지 못합니다. 브레인에 넣으려면 관리자에게 ‘되돌린 뒤 다시 옮기기’를 요청해 주세요.`;
}

/** The notice for the ADMIN (the owner's row). The way out is named only where it can be carried out. */
export function vaultMirrorAdminNoticeText(notice: string, canAct = true): string {
  const count = vaultMirrorNoticeCount(notice);
  if (count === null) return notice;
  const what = `저장소 사본에 메모리 서비스에는 없는 노트가 ${count}개 있습니다. 아무것도 지우지 않았습니다. 이 노트들은 이 팀원의 브레인에 들어 있지 않습니다.`;
  return canAct ? `${what} ‘되돌리기’를 한 뒤 다시 옮기면 저장소의 노트가 모두 브레인에 들어갑니다.` : what;
}

// ---- migration reports ----
//
// A blocker and a skip reason are `<code>: <English detail>` (`VAULT_BLOCKER` /
// `VAULT_SKIP` in `vaultMigration.ts`). The code picks the Korean sentence; the
// detail (which file, how many) follows where it adds something.

function splitCoded(raw: string): { code: string; detail: string } {
  const at = raw.indexOf(": ");
  return at > 0 ? { code: raw.slice(0, at), detail: raw.slice(at + 2).trim() } : { code: raw.trim(), detail: "" };
}

/** Why an owner cannot be moved yet, as a sentence; text this file does not know is shown as it came. */
export function vaultBlockerText(raw: string): string {
  const { code, detail } = splitCoded(raw);
  const known = VAULT_BLOCKER_KO[code];
  if (!known) return raw;
  const more = /^and (\d+) more of this kind$/.exec(detail);
  if (more) return `${known.text} (같은 사유 ${more[1]}건 더 있음)`;
  return known.detail && detail ? `${known.text} (상세: ${detail})` : known.text;
}

/**
 * The blockers that go away once the service's leftover copy of this owner is
 * discarded (an import that never finished, or a copy an earlier rollback could
 * not delete): the owner's notes live in the repository, nothing reads that copy.
 */
export function vaultHasLeftoverCopy(report: VaultMigrationReport | null): boolean {
  if (!report || report.state !== "repo") return false;
  return report.blockers.some((raw) => VAULT_LEFTOVER_BLOCKERS.includes(splitCoded(raw).code));
}

/** Why a file under `wiki/` / `raw/` stays in the repository; unknown text is shown as it came. */
export function vaultSkippedReasonText(raw: string): string {
  const { code, detail } = splitCoded(raw);
  const known = VAULT_SKIP_KO[code];
  if (!known) return raw;
  // The closing line that counts the non-markdown files not listed one by one.
  const more = /^(\d+) more files/.exec(detail);
  return more ? `마크다운(.md) 노트가 아닌 파일 ${more[1]}개가 더 있습니다` : known;
}

export const VAULT_OWNER_STATE_LABELS: Record<VaultOwnerState, string> = {
  repo: "저장소",
  memory: "메모리 서비스",
  no_repo: "저장소 없음",
};
