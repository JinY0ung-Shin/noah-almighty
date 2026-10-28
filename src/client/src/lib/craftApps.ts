import { CRAFT_APPS } from "../../../shared/craftApps";
import type { McpToolGroupId } from "../../../shared/mcpToolGroups";
import { readState, replaceState } from "./state";
import type { CraftAppStatus, CraftAppsInfo, User } from "./types";

/**
 * Admin-only ArtCraft "Craft" apps (PhotoCraft etc.) on the client: which of
 * their `craft_*` MCP tool groups the composer may offer, and their Korean
 * labels. The app registry itself is the shared `CRAFT_APPS`; availability is
 * `GET /api/me`'s `craftApps` (admins only — the server probes the runner).
 * The server gates every run on its own; this only keeps the picker from
 * offering a group the run cannot have.
 */
const CRAFT_STATUSES = new Set<string>(["ready", "failed", "unavailable"]);

/** Every `craft_*` tool-group id, ready or not. */
export const CRAFT_TOOL_GROUP_IDS: ReadonlySet<string> = new Set(CRAFT_APPS.map((app) => app.toolGroupId));

/** The app's Korean label (`CRAFT_APPS[].labelKo`); the id itself for an unknown app. */
export function craftAppLabelKo(appId: string): string {
  return CRAFT_APPS.find((app) => app.id === appId)?.labelKo ?? appId;
}

/** Defensive parse of the `/api/me` field; anything malformed is "no Craft apps". */
export function normalizeCraftApps(raw: unknown): CraftAppsInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { enabled?: unknown; configured?: unknown; runnerReachable?: unknown; apps?: unknown };
  const apps = Array.isArray(value.apps)
    ? value.apps.flatMap((app) => {
        const { id, status, version } = (app ?? {}) as { id?: unknown; status?: unknown; version?: unknown };
        return typeof id === "string" && typeof status === "string" && CRAFT_STATUSES.has(status)
          ? [{ id, status: status as CraftAppStatus, ...(typeof version === "string" && version ? { version } : {}) }]
          : [];
      })
    : [];
  return {
    enabled: value.enabled === true,
    ...(typeof value.configured === "boolean" ? { configured: value.configured } : {}),
    ...(typeof value.runnerReachable === "boolean" ? { runnerReachable: value.runnerReachable } : {}),
    apps,
  };
}

/**
 * The `craftApps` of a `GET /api/me` body. The spec puts it on the response
 * for admins; read it from the user object too, so either server placement works.
 */
export function craftAppsFromMe(body: { user?: unknown; craftApps?: unknown } | null | undefined): CraftAppsInfo | null {
  if (!body) return null;
  return normalizeCraftApps(body.craftApps ?? (body.user as { craftApps?: unknown } | null)?.craftApps);
}

export function isSystemAdmin(user: Pick<User, "roles"> | null | undefined): boolean {
  return Boolean(user?.roles?.includes("admin"));
}

/**
 * The `craft_*` groups the composer must NOT show: all of them unless the
 * viewer is a system admin, the feature is on and that app's runner status is
 * `ready`. A hidden group may still sit in a saved selection — it is kept (the
 * server gates the run), but never shown, counted or toggled.
 */
export function hiddenCraftToolGroups(
  info: CraftAppsInfo | null | undefined,
  user: Pick<User, "roles"> | null | undefined,
): Set<McpToolGroupId> {
  const usable = new Set<string>();
  if (info?.enabled && isSystemAdmin(user)) {
    for (const app of CRAFT_APPS) {
      if (info.apps.some((entry) => entry.id === app.id && entry.status === "ready")) usable.add(app.toolGroupId);
    }
  }
  return new Set([...CRAFT_TOOL_GROUP_IDS].filter((id) => !usable.has(id)) as McpToolGroupId[]);
}

/**
 * Refresh only `craftApps` from `GET /api/me` (the runner may have come up or
 * failed since boot, and a login from the auth screen never fetched it). The
 * composer calls this when an admin opens the tool picker; failures keep the
 * last known value.
 */
export async function refreshCraftApps(
  fetchMe: () => Promise<{ user?: unknown; craftApps?: unknown }>,
): Promise<void> {
  if (!isSystemAdmin(readState().user)) return;
  try {
    const body = await fetchMe();
    replaceState({ craftApps: craftAppsFromMe(body) });
  } catch {
    // Keep the last known availability; the server gates the run regardless.
  }
}
