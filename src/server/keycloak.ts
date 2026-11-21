/**
 * Noah's client of the bundled Keycloak — the login of an install that has one
 * (`AppConfig.keycloak`). Two halves:
 *
 * - LOGIN (standard OIDC, nothing Keycloak-specific but the paths): the
 *   authorization-code flow with PKCE. Noah is a confidential client; it trades
 *   the code on the internal network and then asks Keycloak's own `userinfo`
 *   who the token is for — so Noah parses and verifies NO token itself. What
 *   binds a code to the browser that started the flow is `state` + the PKCE
 *   verifier, both held in that browser's own cookie (`routes/auth.ts`).
 * - ADMIN (Keycloak's REST API, as the `noah` client's service account): what
 *   Noah decides about a person — approved teammate, admin, the password an old
 *   account moves over — is written into Keycloak so everything else that
 *   trusts this Keycloak (pi) sees it. Every admin token is requested with the
 *   `kc-admin-api` scope: Keycloak 26.8 refuses an admin call whose token lacks
 *   that audience (401, whatever its roles).
 *
 * The browser only ever sees `publicUrl`; every call this module makes goes to
 * `internalUrl`. The client secret is sent only as a form field / Basic header
 * of a request to that address (redirects are refused). No error message and
 * no log line of this module carries the secret, a password, a code or a token.
 */
import crypto from "node:crypto";
import type { Store } from "./store.js";
import type { AppConfig, KeycloakConfig } from "./types.js";

/** The realm and the client of the bundled Keycloak (`docker/keycloak/noah-realm.json`). Fixed names, not configuration. */
export const KEYCLOAK_REALM = "noah";
export const KEYCLOAK_CLIENT_ID = "noah";
/** The group an approved (not suspended) teammate is in, and the realm role of a Noah admin. */
export const KEYCLOAK_TEAM_GROUP = "teammates";
export const KEYCLOAK_ADMIN_ROLE = "admin";
/** The path of Noah's own address Keycloak sends the browser back to. */
export const KEYCLOAK_CALLBACK_PATH = "/api/auth/oidc/callback";

/** Keycloak could not be used at all (unreachable, timeout, 5xx, an answer that is not what the API returns). */
export class KeycloakUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeycloakUnavailableError";
  }
}

/** Keycloak answered and said no (a 4xx). `status` is its HTTP status; `code` its `error` field when it sent one. */
export class KeycloakRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KeycloakRefusedError";
  }
}

/**
 * What the code exchange returns. The refresh token is kept (encrypted) on the
 * session row: it ends the Keycloak session at logout, and until then it gets
 * the person's access token for the pi admin relay (`keycloakPersonToken.ts`).
 */
export interface KeycloakTokens {
  accessToken: string;
  refreshToken: string | null;
}

/** What a refresh returns. `refreshToken` is the one to use NEXT when Keycloak sent one (null = keep using the old one). */
export interface KeycloakRefreshedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
}

/** Who a token is for, as Keycloak's `userinfo` says. `sub` is the Keycloak user id — for an imported account, the Noah user id. */
export interface KeycloakIdentity {
  sub: string;
  username: string;
  /** The person's display name when Keycloak has one (first + last name), else "". */
  name: string;
}

/** One account as the admin API lists it. */
export interface KeycloakUser {
  id: string;
  username: string;
}

/**
 * An account to create WITH its id (the id-keeping import). No credentials: a
 * password arrives later, by `setPassword`. `displayName` is NOT sent: Noah's
 * display names are free text, and one that breaks a rule of Keycloak's user
 * profile would stop that person at Keycloak's "update your profile" page on
 * every login. Keycloak needs the id and the name to log in with, nothing else.
 */
export interface KeycloakUserImport {
  id: string;
  username: string;
  displayName: string;
}

export interface KeycloakClient {
  // ---- login -------------------------------------------------------------
  /** Where to send the browser. `register` opens Keycloak's registration form instead of its login form. */
  authorizationUrl(input: { state: string; codeChallenge: string; loginHint?: string; register?: boolean }): string;
  /** The redirect URI registered for the `noah` client (Noah's own address + {@link KEYCLOAK_CALLBACK_PATH}). */
  redirectUri(): string;
  exchangeCode(code: string, codeVerifier: string): Promise<KeycloakTokens>;
  userinfo(accessToken: string): Promise<KeycloakIdentity>;
  /**
   * A fresh access token of the login a refresh token belongs to. A session
   * that ended (logout, suspension, idle too long) is REFUSED: 400 `invalid_grant`.
   */
  refresh(refreshToken: string): Promise<KeycloakRefreshedTokens>;
  /** End the Keycloak session a refresh token belongs to. An already-ended session is not an error. */
  endSession(refreshToken: string): Promise<void>;

  // ---- admin (service account) ---------------------------------------------
  /** null = Keycloak has no such account. */
  getUser(id: string): Promise<KeycloakUser | null>;
  /** Every account of the realm (paged inside). */
  listUsers(): Promise<KeycloakUser[]>;
  /** Create the accounts Keycloak does not have yet, keeping each `id`; existing ones (same id or same username) are left as they are. */
  importUsers(users: readonly KeycloakUserImport[]): Promise<{ added: number; skipped: number }>;
  /** Set the account's password (not temporary). Refused (400) when it breaks Keycloak's password policy. */
  setPassword(id: string, password: string): Promise<void>;
  /** Put the account in / take it out of the approved-teammates group. Idempotent. */
  setTeammate(id: string, teammate: boolean): Promise<void>;
  /** Grant / revoke the realm `admin` role. Idempotent. */
  setAdmin(id: string, admin: boolean): Promise<void>;
  /** The ids in the approved-teammates group / holding the realm `admin` role. */
  listTeammateIds(): Promise<Set<string>>;
  listAdminIds(): Promise<Set<string>>;
  /** End every Keycloak session of the account (its refresh tokens stop working at once). */
  logoutUser(id: string): Promise<void>;
  /** Delete the account. A missing account is not an error. */
  deleteUser(id: string): Promise<void>;
  /** Whether Keycloak's login page offers self-registration (Noah's signup mode `approval`). */
  setRegistrationAllowed(allowed: boolean): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 10_000;
const LIST_PAGE = 200;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** PKCE: a fresh verifier and its S256 challenge. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createHttpKeycloakClient(config: KeycloakConfig, fetchImpl: typeof fetch = fetch): KeycloakClient {
  const realmPath = `/realms/${KEYCLOAK_REALM}`;
  const oidc = (base: string) => `${base}${realmPath}/protocol/openid-connect`;
  const admin = `${config.internalUrl}/admin/realms/${KEYCLOAK_REALM}`;
  const redirectUri = `${new URL(config.publicUrl).origin}${KEYCLOAK_CALLBACK_PATH}`;

  /** One request to the internal address. Throws the two errors above; returns the parsed JSON body (null when empty). */
  async function call(
    what: string,
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | URLSearchParams },
    opts: { allow404?: boolean } = {},
  ): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : "error";
      throw new KeycloakUnavailableError(`Keycloak did not answer (${what}: ${reason}).`);
    }
    const text = await response.text().catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (response.status === 404 && opts.allow404) return { status: 404, body };
    if (response.status >= 500) throw new KeycloakUnavailableError(`Keycloak failed (${what}: HTTP ${response.status}).`);
    if (response.status >= 400) {
      // Keycloak's `error` / `errorMessage` name the reason; never its `error_description` (it can echo input).
      const code = isRecord(body) && typeof body.error === "string" ? body.error : isRecord(body) && typeof body.errorMessage === "string" ? body.errorMessage : "";
      throw new KeycloakRefusedError(response.status, code, `Keycloak refused (${what}: HTTP ${response.status}${code ? ` ${code}` : ""}).`);
    }
    return { status: response.status, body };
  }

  const form = (fields: Record<string, string>) => new URLSearchParams({ client_id: KEYCLOAK_CLIENT_ID, client_secret: config.clientSecret, ...fields });

  // The service account's token, reused until shortly before it expires.
  let adminToken: { value: string; expiresAt: number } | null = null;
  async function adminAuthorization(): Promise<string> {
    if (!adminToken || adminToken.expiresAt <= Date.now()) {
      const { body } = await call("service account token", `${oidc(config.internalUrl)}/token`, {
        method: "POST",
        body: form({ grant_type: "client_credentials", scope: "kc-admin-api" }),
      });
      if (!isRecord(body) || typeof body.access_token !== "string") {
        throw new KeycloakUnavailableError("Keycloak returned no service account token.");
      }
      const seconds = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 60;
      adminToken = { value: body.access_token, expiresAt: Date.now() + Math.max(5, seconds - 30) * 1000 };
    }
    return `Bearer ${adminToken.value}`;
  }

  async function adminCall(
    what: string,
    path: string,
    init: { method?: string; json?: unknown } = {},
    opts: { allow404?: boolean } = {},
  ): Promise<{ status: number; body: unknown }> {
    const send = async () =>
      call(
        what,
        `${admin}${path}`,
        {
          method: init.method,
          headers: { authorization: await adminAuthorization(), ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
          body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
        },
        opts,
      );
    try {
      return await send();
    } catch (error) {
      // A token Keycloak no longer accepts (restart, key rotation): one fresh token, one retry.
      if (error instanceof KeycloakRefusedError && error.status === 401) {
        adminToken = null;
        return send();
      }
      throw error;
    }
  }

  // Ids of the group and the role, looked up once (they are created by the realm import and never renamed).
  let teamGroupId: string | null = null;
  async function groupId(): Promise<string> {
    if (!teamGroupId) {
      const { body } = await adminCall("find group", `/groups?search=${encodeURIComponent(KEYCLOAK_TEAM_GROUP)}&exact=true`);
      const found = Array.isArray(body) ? body.find((g) => isRecord(g) && g.name === KEYCLOAK_TEAM_GROUP) : undefined;
      if (!isRecord(found) || typeof found.id !== "string") {
        throw new KeycloakUnavailableError(`Keycloak has no "${KEYCLOAK_TEAM_GROUP}" group (is the realm imported?).`);
      }
      teamGroupId = found.id;
    }
    return teamGroupId;
  }
  let adminRole: { id: string; name: string } | null = null;
  async function role(): Promise<{ id: string; name: string }> {
    if (!adminRole) {
      const { body } = await adminCall("find role", `/roles/${encodeURIComponent(KEYCLOAK_ADMIN_ROLE)}`);
      if (!isRecord(body) || typeof body.id !== "string") {
        throw new KeycloakUnavailableError(`Keycloak has no "${KEYCLOAK_ADMIN_ROLE}" role (is the realm imported?).`);
      }
      adminRole = { id: body.id, name: KEYCLOAK_ADMIN_ROLE };
    }
    return adminRole;
  }

  const user = (id: string) => `/users/${encodeURIComponent(id)}`;

  async function pagedIds(what: string, path: string): Promise<Set<string>> {
    const ids = new Set<string>();
    for (let first = 0; ; first += LIST_PAGE) {
      const { body } = await adminCall(what, `${path}${path.includes("?") ? "&" : "?"}first=${first}&max=${LIST_PAGE}`);
      const page = Array.isArray(body) ? body : [];
      for (const entry of page) if (isRecord(entry) && typeof entry.id === "string") ids.add(entry.id);
      if (page.length < LIST_PAGE) return ids;
    }
  }

  return {
    authorizationUrl({ state, codeChallenge, loginHint, register }) {
      const url = new URL(`${oidc(config.publicUrl)}/${register ? "registrations" : "auth"}`);
      url.searchParams.set("client_id", KEYCLOAK_CLIENT_ID);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid");
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      if (loginHint) url.searchParams.set("login_hint", loginHint);
      return url.toString();
    },

    redirectUri: () => redirectUri,

    async exchangeCode(code, codeVerifier) {
      const { body } = await call("code exchange", `${oidc(config.internalUrl)}/token`, {
        method: "POST",
        body: form({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier }),
      });
      if (!isRecord(body) || typeof body.access_token !== "string") {
        throw new KeycloakUnavailableError("Keycloak returned no access token for the code.");
      }
      return { accessToken: body.access_token, refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null };
    },

    async userinfo(accessToken) {
      const { body } = await call("userinfo", `${oidc(config.internalUrl)}/userinfo`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!isRecord(body) || typeof body.sub !== "string" || !body.sub || typeof body.preferred_username !== "string" || !body.preferred_username) {
        throw new KeycloakUnavailableError("Keycloak's userinfo carried no subject or username.");
      }
      return { sub: body.sub, username: body.preferred_username, name: typeof body.name === "string" ? body.name.trim() : "" };
    },

    async refresh(refreshToken) {
      const { body } = await call("token refresh", `${oidc(config.internalUrl)}/token`, {
        method: "POST",
        body: form({ grant_type: "refresh_token", refresh_token: refreshToken }),
      });
      if (!isRecord(body) || typeof body.access_token !== "string" || !body.access_token) {
        throw new KeycloakUnavailableError("Keycloak returned no access token for the refresh.");
      }
      return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
        // No lifetime in the answer: treat the token as short-lived rather than guess long.
        expiresInSeconds: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 60,
      };
    },

    async endSession(refreshToken) {
      try {
        await call("end session", `${oidc(config.internalUrl)}/logout`, { method: "POST", body: form({ refresh_token: refreshToken }) });
      } catch (error) {
        // An expired or already-ended session answers 400 `invalid_grant`: there is nothing left to end.
        if (error instanceof KeycloakRefusedError && error.status === 400) return;
        throw error;
      }
    },

    async getUser(id) {
      const { status, body } = await adminCall("get user", user(id), {}, { allow404: true });
      if (status === 404) return null;
      if (!isRecord(body) || typeof body.id !== "string" || typeof body.username !== "string") {
        throw new KeycloakUnavailableError("Keycloak returned an account without id or username.");
      }
      return { id: body.id, username: body.username };
    },

    async listUsers() {
      const users: KeycloakUser[] = [];
      for (let first = 0; ; first += LIST_PAGE) {
        const { body } = await adminCall("list users", `/users?briefRepresentation=true&first=${first}&max=${LIST_PAGE}`);
        const page = Array.isArray(body) ? body : [];
        for (const entry of page) {
          if (isRecord(entry) && typeof entry.id === "string" && typeof entry.username === "string") {
            users.push({ id: entry.id, username: entry.username });
          }
        }
        if (page.length < LIST_PAGE) return users;
      }
    },

    async importUsers(users) {
      if (users.length === 0) return { added: 0, skipped: 0 };
      // The partial import is the one admin call that KEEPS a given id (`POST /users` mints its own).
      const { body } = await adminCall("import users", "/partialImport", {
        method: "POST",
        json: {
          ifResourceExists: "SKIP",
          users: users.map((u) => ({ id: u.id, username: u.username, enabled: true })),
        },
      });
      const added = isRecord(body) && typeof body.added === "number" ? body.added : 0;
      const skipped = isRecord(body) && typeof body.skipped === "number" ? body.skipped : 0;
      return { added, skipped };
    },

    async setPassword(id, password) {
      await adminCall("set password", `${user(id)}/reset-password`, { method: "PUT", json: { type: "password", value: password, temporary: false } });
    },

    async setTeammate(id, teammate) {
      await adminCall(teammate ? "join group" : "leave group", `${user(id)}/groups/${encodeURIComponent(await groupId())}`, {
        method: teammate ? "PUT" : "DELETE",
      });
    },

    async setAdmin(id, grant) {
      await adminCall(grant ? "grant role" : "revoke role", `${user(id)}/role-mappings/realm`, { method: grant ? "POST" : "DELETE", json: [await role()] });
    },

    async listTeammateIds() {
      return pagedIds("list group members", `/groups/${encodeURIComponent(await groupId())}/members?briefRepresentation=true`);
    },

    async listAdminIds() {
      return pagedIds("list role holders", `/roles/${encodeURIComponent(KEYCLOAK_ADMIN_ROLE)}/users?briefRepresentation=true`);
    },

    async logoutUser(id) {
      await adminCall("logout user", `${user(id)}/logout`, { method: "POST" }, { allow404: true });
    },

    async deleteUser(id) {
      await adminCall("delete user", user(id), { method: "DELETE" }, { allow404: true });
    },

    async setRegistrationAllowed(allowed) {
      // A realm PUT applies only the fields it carries.
      await call("set registration", admin, {
        method: "PUT",
        headers: { authorization: await adminAuthorization(), "content-type": "application/json" },
        body: JSON.stringify({ registrationAllowed: allowed }),
      });
    },
  };
}

const clients = new WeakMap<Store, KeycloakClient | null>();
const installedForTests = new WeakMap<Store, KeycloakClient>();

/** The client of one app instance (keyed by its Store, like `memoryClientFor`); null when `config.keycloak` is unset — the built-in login. */
export function keycloakFor(store: Store, config: AppConfig): KeycloakClient | null {
  const installed = installedForTests.get(store);
  if (installed) return installed;
  let client = clients.get(store);
  if (client === undefined) {
    client = config.keycloak ? createHttpKeycloakClient(config.keycloak) : null;
    clients.set(store, client);
  }
  return client;
}

/** Tests: install a client for this Store (pass null to remove). It wins over `config.keycloak`, set or not. */
export function setKeycloakClientForTests(store: Store, client: KeycloakClient | null): void {
  if (client) installedForTests.set(store, client);
  else installedForTests.delete(store);
}
