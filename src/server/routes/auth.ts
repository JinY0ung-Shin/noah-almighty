import crypto from "node:crypto";
import { Router, type Response } from "express";
import {
  clearKeycloakFlowCookie,
  clearSessionCookie,
  hashPassword,
  keycloakFlowFromRequest,
  sessionTokenFromRequest,
  setKeycloakFlowCookie,
  setSessionCookie,
} from "../auth.js";
import { createPkcePair, keycloakFor, type KeycloakClient, type KeycloakIdentity, type KeycloakTokens } from "../keycloak.js";
import { setKeycloakPassword, syncRegistrationToKeycloak, syncUserToKeycloak } from "../keycloakSync.js";
import { isReservedUsername } from "../usernamePolicy.js";
import logger from "../logger.js";
import { createRateLimiter } from "../rateLimit.js";
import { apiError, safeString, MIN_PASSWORD_LENGTH, type RouterDeps } from "./_shared.js";
import { catalogEffortSupport, noahDefaultModel, visionForCatalogModel } from "../agent/pi/modelCatalog.js";
import { piServicesFor } from "../agent/pi/piRuntime.js";
import { EFFORT_LEVELS, DEFAULT_EFFORT_LEVEL } from "../effortLevels.js";
import { workspaceBrowserAvailable } from "../workspaceBrowser.js";

/**
 * Instance-wide bounds on self-service signup, on top of the per-address
 * limiter (which is ONE bucket for everybody behind a reverse proxy that is
 * not listed in `NOAH_TRUSTED_PROXY_CIDRS` — trustedProxies.ts — and none at
 * all for a flood from many addresses):
 *
 * - `perHour`: accounts created in the last hour, any address.
 * - `pending`: signups still waiting for an admin (`countPendingSignups`). Each
 *   pending signup is a suspended user row an admin has to read, so this is the
 *   bound on what a flood can leave in the approval list; approving or deleting
 *   entries frees room.
 *
 * Both are counted from the users table, so they hold across restarts and
 * processes. The first account (admin bootstrap) is never refused. Mutable only
 * so tests can shorten them.
 */
export const SIGNUP_LIMITS = { perHour: 50, pending: 100 };

const SIGNUP_BUSY_MESSAGE = "지금은 가입 신청이 많아 새 신청을 받을 수 없습니다. 잠시 후 다시 시도해 주세요.";
const SIGNUP_PENDING_FULL_MESSAGE =
  "승인을 기다리는 가입 신청이 너무 많아 새 신청을 받을 수 없습니다. 관리자에게 문의해 주세요.";

const USERNAME_PATTERN = /^[\w.-]{3,32}$/;

/**
 * Why a login that came back from Keycloak produced no session. The browser
 * lands on `/?auth=<code>` and the auth screen says it in Korean:
 * `pending` (a new signup waiting for an admin), `suspended`, `closed` (signup
 * is closed), `full` (the signup caps), `name` (the username cannot be used
 * here), `failed` (anything else — the server log has the cause).
 */
type KeycloakLoginRefusal = "pending" | "suspended" | "closed" | "full" | "name" | "failed";

// ---- Auth ------------------------------------------------------------
export function createAuthRouter({ config, store }: RouterDeps): Router {
  const router = Router();
  /** This server's Keycloak; null = the built-in login only. */
  const keycloak = (): KeycloakClient | null => keycloakFor(store, config);

  // Throttle credential guessing / signup floods (in-memory, single-process;
  // bypassed under NODE_ENV=test). Login is keyed per (ip, username) so one
  // account can't be hammered; signup is keyed per ip, with the instance-wide
  // SIGNUP_LIMITS behind it.
  const loginLimiter = createRateLimiter({
    windowMs: 5 * 60 * 1000,
    max: 20,
    keyFn: (req) =>
      `${req.ip ?? "?"}:${safeString((req.body as { username?: unknown } | undefined)?.username).toLowerCase()}`,
    message: "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  });
  const signupLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20,
    keyFn: (req) => req.ip ?? "?",
  });

  /** The instance-wide signup bound that is exhausted right now, as its 429 message; null = room left. */
  const signupCapMessage = (): string | null => {
    if (store.countPendingSignups() >= SIGNUP_LIMITS.pending) return SIGNUP_PENDING_FULL_MESSAGE;
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    if (store.countUsersCreatedSince(hourAgo) >= SIGNUP_LIMITS.perHour) return SIGNUP_BUSY_MESSAGE;
    return null;
  };

  router.post("/api/auth/signup", signupLimiter, async (req, res, next) => {
    try {
      // With Keycloak an account is born THERE (its registration form) and
      // reaches Noah through the login callback below — never through this form.
      if (keycloak()) {
        apiError(res, 400, "가입은 로그인 화면의 가입 신청으로 진행해 주세요.");
        return;
      }
      const username = safeString(req.body?.username);
      const displayName = safeString(req.body?.displayName) || username;
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!username || !USERNAME_PATTERN.test(username)) {
        apiError(res, 400, "사용자명은 3~32자의 영문/숫자/._- 만 허용됩니다.");
        return;
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        apiError(res, 400, "비밀번호는 8자 이상이어야 합니다.");
        return;
      }
      // The very first account (admin bootstrap) is always allowed; after that the
      // admin-configured signup mode gates self-service registration.
      const isFirstUser = !store.hasAnyUser();
      const signupMode = store.getSignupMode();
      if (!isFirstUser && signupMode === "closed") {
        apiError(res, 403, "현재 회원가입이 비활성화되어 있습니다. 관리자에게 문의해 주세요.");
        return;
      }
      if (!isFirstUser) {
        // Names that read as the system or an operator (usernamePolicy.ts). The
        // bootstrap admin is exempt — it may well be called `admin` — and the
        // answer says nothing about which names exist.
        if (isReservedUsername(username)) {
          apiError(res, 400, "사용할 수 없는 사용자명입니다. 다른 사용자명을 입력해 주세요.");
          return;
        }
        // Instance-wide bounds, checked before the name so a refused flood learns
        // nothing about taken names and costs no scrypt run.
        const capped = signupCapMessage();
        if (capped) {
          logger.warn({ pending: store.countPendingSignups() }, "signup refused: instance-wide signup limit reached");
          apiError(res, 429, capped);
          return;
        }
      }
      // Case-insensitive for a NEW name (`Admin` next to `admin`); checked before
      // hashing so a taken name costs no scrypt run.
      if (store.usernameTaken(username)) {
        apiError(res, 409, "이미 사용 중인 사용자명입니다.");
        return;
      }
      // Off the event loop (crypto.scrypt): a signup never stalls the SSE streams.
      const passwordHash = await hashPassword(password);
      // Everything from here to the response is synchronous, so the checks below
      // and the insert are one step: requests that were hashing at the same time
      // cannot together slip past a bound, take one name twice, or both become
      // the bootstrap admin.
      const stillFirstUser = !store.hasAnyUser();
      if (!stillFirstUser) {
        if (isFirstUser) {
          // Another signup became the bootstrap admin while this one was hashing:
          // this one was never checked as a self-service signup, so it starts over.
          apiError(res, 409, "방금 다른 계정이 먼저 만들어졌습니다. 다시 시도해 주세요.");
          return;
        }
        const capped = signupCapMessage();
        if (capped) {
          apiError(res, 429, capped);
          return;
        }
      }
      let user;
      try {
        user = store.createUser({ username, displayName, passwordHash });
      } catch (error) {
        if (error instanceof Error && error.message === "DUPLICATE_USERNAME") {
          apiError(res, 409, "이미 사용 중인 사용자명입니다.");
          return;
        }
        throw error;
      }
      // Approval (the only other mode — `open` is retired): the account is created
      // but parked (suspended) with no session until an admin activates it.
      // Approval IS joining the team (and with it, trust — isTrustedFor), so no
      // self-service signup past the first may skip it. The client shows a
      // "pending approval" notice.
      if (!stillFirstUser) {
        store.setSuspended(user.id, true);
        store.audit({
          actorUserId: user.id,
          actorName: user.username,
          action: "signup_pending",
          status: "success",
          detail: "awaiting admin approval",
        });
        logger.info({ userId: user.id, username: user.username }, "signup pending approval");
        res.status(202).json({ pending: true });
        return;
      }
      const token = store.createSession(user.id);
      setSessionCookie(res, token);
      store.audit({
        actorUserId: user.id,
        actorName: user.username,
        action: "signup",
        status: "success",
        detail: `signup as ${user.roles.join("/")}`,
      });
      logger.info({ userId: user.id, username: user.username }, "signup");
      res.status(201).json({ user });
    } catch (error) {
      // Express 4 does not catch a rejected async handler.
      next(error);
    }
  });

  // The login screen of an install with Keycloak asks the name first: an
  // account that still has a built-in password types it HERE one last time
  // (the login below moves it), every other name — moved, born in Keycloak or
  // unknown — goes to Keycloak's own page. During the move this tells an
  // unauthenticated caller which names have not moved yet; it ends with the
  // built-in login.
  // Per address as well: the per-(address, name) limit alone would let one
  // caller walk through names.
  const methodLimiter = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 60, keyFn: (req) => req.ip ?? "?" });
  router.post("/api/auth/login-method", methodLimiter, loginLimiter, (req, res) => {
    const username = safeString(req.body?.username);
    res.json({ method: !keycloak() || store.usernameHasBuiltInPassword(username) ? "password" : "sso" });
  });

  router.post("/api/auth/login", loginLimiter, async (req, res, next) => {
    try {
      const username = safeString(req.body?.username);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      const sso = keycloak();
      // No built-in password to check (moved, born in Keycloak, or no such
      // name — the same answer for all three): the login is Keycloak's.
      if (sso && !store.usernameHasBuiltInPassword(username)) {
        res.status(409).json({ error: "이 계정은 통합 로그인으로 로그인해 주세요.", sso: true });
        return;
      }
      // The name is matched exactly as stored (case-sensitive); the scrypt
      // verification runs on the threadpool, not the event loop.
      const verified = await store.verifyBuiltInLogin(username, password);
      const user = verified === null || verified === "suspended" ? verified : verified.user;
      if (user === "suspended") {
        apiError(res, 403, "비활성화된 계정입니다. 관리자 승인이나 문의가 필요합니다.");
        return;
      }
      if (!user) {
        // Audit failed logins (username only, never the password) so /api/audit —
        // not just the pino log — carries the brute-force / spray trail an auth log
        // exists for. actorUserId is null: the attempt didn't authenticate anyone.
        store.audit({
          actorUserId: null,
          actorName: username || "(unknown)",
          action: "login",
          status: "error",
          detail: "failed login",
        });
        apiError(res, 401, "사용자명 또는 비밀번호가 올바르지 않습니다.");
        return;
      }
      // The move: the password that just verified against Noah's digest is put
      // into Keycloak, and only then is the digest dropped — from here on the
      // account logs in at Keycloak. A failure keeps the digest (the next
      // built-in login tries again) and never fails this login.
      if (sso) {
        // In the account's own turn (keycloakSync.ts), so it cannot interleave
        // with an admin's reset of the same account; the account is created
        // there first when Keycloak lacks it.
        const digest = verified !== null && verified !== "suspended" ? verified.digest : "";
        const moved = await setKeycloakPassword(store, config, user.id, password, { whileDigest: digest });
        // The digest this password verified against is not the account's any
        // more — an admin reset it (or it moved) while this login was in
        // flight: the password is no longer valid, and nothing was written.
        // The same goes for an account suspended or deleted meanwhile.
        if ((!moved.ok && moved.reason === "stale") || store.accountGate(user.id) !== "active") {
          apiError(res, 401, "사용자명 또는 비밀번호가 올바르지 않습니다.");
          return;
        }
        if (moved.ok) {
          void syncUserToKeycloak(store, config, user.id);
          store.audit({
            actorUserId: user.id,
            actorName: user.username,
            action: "password_moved",
            status: "success",
            detail: "built-in password moved to the login server",
          });
          logger.info({ userId: user.id, username: user.username }, "built-in password moved to Keycloak");
        } else {
          logger.warn({ userId: user.id, reason: moved.reason }, "the built-in password could not be moved to Keycloak; it stays in Noah until the next login");
        }
      }
      const token = store.createSession(user.id);
      setSessionCookie(res, token);
      store.audit({
        actorUserId: user.id,
        actorName: user.username,
        action: "login",
        status: "success",
        detail: "login",
      });
      logger.info({ userId: user.id, username: user.username }, "login");
      res.json({ user });
    } catch (error) {
      next(error);
    }
  });

  // ---- Login through Keycloak (authorization code + PKCE) ---------------

  const flowLimiter = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 60, keyFn: (req) => req.ip ?? "?" });

  /** Whether a new account may be created right now (the first one always may). */
  const registrationOpen = (): boolean => !store.hasAnyUser() || store.getSignupMode() === "approval";

  // Send the browser to Keycloak. `hint` pre-fills the name the login screen
  // already asked for; `register=1` opens Keycloak's registration form (only
  // while Noah takes signups — otherwise it is a plain login).
  router.get("/api/auth/oidc/start", flowLimiter, (req, res) => {
    const sso = keycloak();
    if (!sso) {
      res.status(404).end();
      return;
    }
    const { verifier, challenge } = createPkcePair();
    const state = crypto.randomBytes(24).toString("base64url");
    setKeycloakFlowCookie(res, { state, verifier });
    const hint = safeString(req.query.hint);
    res.redirect(
      sso.authorizationUrl({
        state,
        codeChallenge: challenge,
        ...(/^[\w.-]{1,64}$/.test(hint) ? { loginHint: hint } : {}),
        register: req.query.register === "1" && registrationOpen(),
      }),
    );
  });

  /**
   * The account a Keycloak identity logs in as, or why it gets no session.
   * Keycloak says WHO it is; whether that person is a teammate is still Noah's
   * answer (approval is the trust gate — a Keycloak account alone is nobody).
   * An account is matched by ID only: the Keycloak id of an imported account
   * IS its Noah id, and an account born in Keycloak gets its Keycloak id here.
   * A name that exists under another id is never merged.
   */
  const accountForKeycloakLogin = (identity: KeycloakIdentity): { userId: string } | { refusal: KeycloakLoginRefusal } => {
    const gate = store.accountGate(identity.sub);
    if (gate === "active") return { userId: identity.sub };
    if (gate) return { refusal: gate };
    const username = identity.username.trim();
    if (!USERNAME_PATTERN.test(username)) return { refusal: "name" };
    if (store.usernameTaken(username)) {
      logger.error(
        { username, keycloakId: identity.sub },
        "Keycloak login refused: the username belongs to a Noah account with another id (never merged; an operator must resolve it)",
      );
      return { refusal: "name" };
    }
    const isFirstUser = !store.hasAnyUser();
    if (!isFirstUser) {
      if (store.getSignupMode() === "closed") return { refusal: "closed" };
      if (isReservedUsername(username)) return { refusal: "name" };
      if (signupCapMessage()) {
        logger.warn({ pending: store.countPendingSignups() }, "signup refused: instance-wide signup limit reached");
        return { refusal: "full" };
      }
    }
    // Synchronous from the checks above to the insert, like the built-in signup.
    let user;
    try {
      user = store.createUser({ id: identity.sub, username, displayName: identity.name || username, passwordHash: "" });
    } catch (error) {
      if (error instanceof Error && (error.message === "DUPLICATE_USERNAME" || error.message === "DUPLICATE_ID")) {
        return { refusal: "name" };
      }
      throw error;
    }
    if (!isFirstUser) {
      // Parked until an admin approves, exactly like a built-in signup.
      store.setSuspended(user.id, true);
      store.audit({ actorUserId: user.id, actorName: user.username, action: "signup_pending", status: "success", detail: "awaiting admin approval" });
      logger.info({ userId: user.id, username: user.username }, "signup pending approval");
      return { refusal: "pending" };
    }
    store.audit({ actorUserId: user.id, actorName: user.username, action: "signup", status: "success", detail: `signup as ${user.roles.join("/")}` });
    logger.info({ userId: user.id, username: user.username }, "signup");
    // Registration was open for the first account whatever the signup mode; from here the mode decides.
    void syncRegistrationToKeycloak(store, config);
    return { userId: user.id };
  };

  router.get("/api/auth/oidc/callback", flowLimiter, async (req, res, next) => {
    const sso = keycloak();
    if (!sso) {
      res.status(404).end();
      return;
    }
    const refuse = async (code: KeycloakLoginRefusal, tokens?: KeycloakTokens): Promise<void> => {
      // No Noah session came of it, so the Keycloak session ends too: the next
      // attempt starts at Keycloak's login form, not silently as the same person.
      // Awaited — a retry that arrives while the session is still ending gets a
      // code from it that is dead by the time Noah trades it.
      if (tokens?.refreshToken) {
        await sso.endSession(tokens.refreshToken).catch((err: unknown) => logger.warn({ err }, "could not end the Keycloak session of a refused login"));
      }
      (res as Response).redirect(`/?auth=${code}`);
    };
    try {
      const flow = keycloakFlowFromRequest(req);
      clearKeycloakFlowCookie(res);
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const state = typeof req.query.state === "string" ? req.query.state : "";
      // The code must come back to the browser that started the flow.
      // Compared as bytes (timingSafeEqual throws on unequal lengths, and a
      // string's length is not its byte length).
      const given = Buffer.from(state);
      const expected = Buffer.from(flow?.state ?? "");
      const stateMatches = flow !== null && given.length === expected.length && crypto.timingSafeEqual(given, expected);
      if (!code || !flow || !stateMatches) {
        // Also the person who pressed cancel at Keycloak (`error=` and no code).
        logger.warn({ hasCode: Boolean(code), hasFlow: Boolean(flow) }, "Keycloak login callback without a matching login in flight");
        await refuse("failed");
        return;
      }
      let tokens: KeycloakTokens;
      let identity: KeycloakIdentity;
      try {
        tokens = await sso.exchangeCode(code, flow.verifier);
        identity = await sso.userinfo(tokens.accessToken);
      } catch (err) {
        logger.warn({ err }, "Keycloak login failed at the code exchange");
        await refuse("failed");
        return;
      }
      const account = accountForKeycloakLogin(identity);
      if ("refusal" in account) {
        if (account.refusal === "pending" || account.refusal === "suspended") {
          store.audit({ actorUserId: identity.sub, actorName: identity.username, action: "login", status: "error", detail: `login refused: ${account.refusal}` });
        }
        await refuse(account.refusal, tokens);
        return;
      }
      const user = store.getUserById(account.userId);
      if (!user) {
        await refuse("failed", tokens);
        return;
      }
      // Whoever logs in at Keycloak has a password there: a digest still in
      // Noah would be a second password for the same account.
      if (store.clearBuiltInPassword(user.id)) {
        logger.info({ userId: user.id }, "built-in password dropped: the account logged in through Keycloak");
      }
      // Group and role follow Noah (the first account is the admin; an import
      // that failed at boot is repaired here).
      void syncUserToKeycloak(store, config, user.id);
      const token = store.createSession(user.id, { keycloakRefreshToken: tokens.refreshToken });
      setSessionCookie(res, token);
      store.audit({ actorUserId: user.id, actorName: user.username, action: "login", status: "success", detail: "login (sso)" });
      logger.info({ userId: user.id, username: user.username }, "login through Keycloak");
      res.redirect("/");
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/auth/logout", async (req, res) => {
    const user = store.getUserBySessionToken(sessionTokenFromRequest(req));
    // A session that began at Keycloak ends there too — otherwise the next
    // press on 로그인 would walk straight back in on Keycloak's own cookie.
    const keycloakToken = store.takeSessionKeycloakToken(sessionTokenFromRequest(req));
    const sso = keycloak();
    // Noah's session goes first and unconditionally; the Keycloak one is
    // awaited (see the refused login above) but its failure changes nothing.
    store.revokeSession(sessionTokenFromRequest(req));
    if (keycloakToken && sso) {
      await sso.endSession(keycloakToken).catch((err: unknown) => logger.warn({ err }, "could not end the Keycloak session at logout"));
    }
    clearSessionCookie(res);
    if (user) {
      logger.info({ userId: user.id, username: user.username }, "logout");
      // Pair with the login audit so /api/audit shows session ends, not just starts.
      store.audit({
        actorUserId: user.id,
        actorName: user.username,
        action: "logout",
        status: "success",
        detail: "logout",
      });
    }
    res.json({ ok: true });
  });

  // First-run probe: when no account exists yet, the client shows the
  // admin-account setup screen instead of the normal login.
  router.get("/api/bootstrap", async (_req, res) => {
    // pi-gateway's live model list (cached; empty on the `local` stub and while
    // pi has never answered — the client then hides the picker).
    const models = await piServicesFor(store, config).models.list();
    const defaultReasoning = catalogEffortSupport(models, undefined);
    res.json({
      needsSetup: !store.hasAnyUser(),
      // Login goes through this install's Keycloak: the auth screen asks the
      // name first and has no signup form of its own (`login-method` above).
      sso: Boolean(keycloak()),
      githubHost: config.githubHost,
      // Lets the auth screen hide/adjust the signup affordance and show the right
      // copy (approval vs. closed) before anyone tries to register.
      signupMode: store.getSignupMode(),
      // Lets onboarding show the Confluence PAT field only when the deployment
      // has a Confluence host configured (the PAT is useless otherwise).
      confluenceConfigured: Boolean(config.confluenceUrl),
      // The attach button opens the upload relay's page instead of this
      // browser's own file dialog (a fleet whose DRM agent only decrypts
      // uploads to a registered address).
      uploadRelay: Boolean(config.uploadRelay),
      // The chat's 파일 button: this deployment can show a user their own
      // sandbox workspace (pi runtime with the workspaces mounted).
      workspaceFiles: workspaceBrowserAvailable(config),
      // Per-conversation model picker: the models pi-gateway offers right now.
      // A pick is a pi model id; none (or one pi stopped offering) runs the
      // default model (pi's `falcon` tier, else pi-gateway's own default). Image input is pi's own per-model setting
      // (visionForCatalogModel); the retired deployment-wide MODEL_VISION flag
      // (`visionEnabled`) is no longer sent.
      modelSelection: {
        // `server` is pi's `owned_by`; `vision` pi's image setting
        // (visionForCatalogModel). `reasoning`: the efforts pi lists for the
        // model (null = it does not reason; absent = pi did not say) — the
        // composer greys out what effortForModel would not send as picked.
        models: models.map((model) => ({
          id: model.id,
          server: model.server,
          vision: visionForCatalogModel(models, model.id),
          ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        })),
        // The model a conversation gets when the user picked nothing: Noah's
        // default (pi's `falcon` tier) while pi offers it; absent → pi-gateway's
        // own default. The picker names it on its "기본 모델" option.
        ...(noahDefaultModel(models) ? { defaultModel: noahDefaultModel(models) } : {}),
        // Vision of that model (mirrors runCapabilities and the chat route).
        defaultVision: visionForCatalogModel(models, undefined),
        // That model's efforts, the same way (absent = unknown).
        ...(defaultReasoning !== undefined ? { defaultReasoning } : {}),
      },
      // Per-conversation reasoning effort picker. A change applies from the
      // next turn on, in the same pi session (P3); what is sent is clamped to
      // the model's efforts (modelSelection above).
      effortSelection: {
        levels: EFFORT_LEVELS,
        default: DEFAULT_EFFORT_LEVEL,
      },
    });
  });

  router.get("/api/me", (req, res) => {
    const user = store.getUserBySessionToken(sessionTokenFromRequest(req));
    res.json({ user });
  });

  return router;
}
