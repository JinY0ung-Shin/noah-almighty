// Personal vault (개인 브레인) as the two screens that show it read it: 설정 ▸
// 지식·플러그인 (`SettingsVaultStatus`) and 관리자 ▸ 시스템 ▸ 개인 브레인 사용량
// (`AdminPersonalVaultPanel`). Every owner's brain notes are kept in the memory
// service; nothing here moves or copies them.
//
// The response shapes are declared HERE because their server home
// (`src/server/routes/personalVault.ts`) is not one of the server modules the
// client may import (`tsconfig.client.json`). Keep them in step with that file.

/** `GET /api/me/personal-vault`. */
export interface MyPersonalVault {
  /** False = this server has no memory service configured. */
  serviceConfigured: boolean;
  /**
   * Whether the memory service answered the server's check of this owner's notes just now — `ok`,
   * `unavailable` (no answer) or `refused` (it answered but would not serve them). Null on a server
   * without the service.
   */
  service: "ok" | "unavailable" | "refused" | null;
}

/** The answer as the settings card uses it; null for anything that is not the route's shape. */
export function readMyPersonalVault(value: unknown): MyPersonalVault | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { serviceConfigured?: unknown; service?: unknown };
  if (typeof raw.serviceConfigured !== "boolean") return null;
  const service = raw.service === "ok" || raw.service === "unavailable" || raw.service === "refused" ? raw.service : null;
  return { serviceConfigured: raw.serviceConfigured, service };
}

/** One owner's wiki size (`GET /api/admin/personal-vaults/usage`), or why it could not be listed. */
export type AdminVaultOwnerUsage =
  | { userId: string; notes: number; bytes: number }
  | { userId: string; error: "unavailable" | "refused" | "timeout" };

/** `GET /api/admin/personal-vaults/usage`: counts and sizes only, never a note's path or content. */
export interface AdminVaultUsage {
  serviceConfigured: boolean;
  /** The memory service's per-owner limits: past either it refuses to save (`wiki_full`). */
  limits: { notes: number; bytes: number };
  /** Every user with a knowledge repository connected, in the order the accounts were made. */
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
