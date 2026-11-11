import { Router } from "express";
import {
  clearSessionCookie,
  hashPassword,
  sessionTokenFromRequest,
  setSessionCookie,
} from "../auth.js";
import { isReservedUsername } from "../usernamePolicy.js";
import logger from "../logger.js";
import { createRateLimiter } from "../rateLimit.js";
import { apiError, safeString, MIN_PASSWORD_LENGTH, type RouterDeps } from "./_shared.js";
import { catalogEffortSupport, noahDefaultModel, visionForCatalogModel } from "../agent/pi/modelCatalog.js";
import { piServicesFor } from "../agent/pi/piRuntime.js";
import { EFFORT_LEVELS, DEFAULT_EFFORT_LEVEL } from "../effortLevels.js";

/**
 * Instance-wide bounds on self-service signup, on top of the per-address
 * limiter (which is ONE bucket for everybody behind a reverse proxy — no
 * `trust proxy` — and none at all for a flood from many addresses):
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

// ---- Auth ------------------------------------------------------------
export function createAuthRouter({ config, store }: RouterDeps): Router {
  const router = Router();

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
      const username = safeString(req.body?.username);
      const displayName = safeString(req.body?.displayName) || username;
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (!username || !/^[\w.-]{3,32}$/.test(username)) {
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

  router.post("/api/auth/login", loginLimiter, async (req, res, next) => {
    try {
      const username = safeString(req.body?.username);
      const password = typeof req.body?.password === "string" ? req.body.password : "";
      // The name is matched exactly as stored (case-sensitive); the scrypt
      // verification runs on the threadpool, not the event loop.
      const user = await store.verifyLogin(username, password);
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

  router.post("/api/auth/logout", (req, res) => {
    const user = store.getUserBySessionToken(sessionTokenFromRequest(req));
    store.revokeSession(sessionTokenFromRequest(req));
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
      githubHost: config.githubHost,
      // Lets the auth screen hide/adjust the signup affordance and show the right
      // copy (approval vs. closed) before anyone tries to register.
      signupMode: store.getSignupMode(),
      // Lets onboarding show the Confluence PAT field only when the deployment
      // has a Confluence host configured (the PAT is useless otherwise).
      confluenceConfigured: Boolean(config.confluenceUrl),
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
