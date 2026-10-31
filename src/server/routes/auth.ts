import { Router } from "express";
import {
  clearSessionCookie,
  sessionTokenFromRequest,
  setSessionCookie,
} from "../auth.js";
import logger from "../logger.js";
import { createRateLimiter } from "../rateLimit.js";
import { apiError, safeString, MIN_PASSWORD_LENGTH, type RouterDeps } from "./_shared.js";
import { catalogModelIds } from "../agent/pi/modelCatalog.js";
import { piServicesFor } from "../agent/pi/piRuntime.js";
import { effectiveModelOverride } from "../modelOverride.js";
import { visionForModel } from "../modelVisionPolicy.js";
import { EFFORT_LEVELS, DEFAULT_EFFORT_LEVEL } from "../effortLevels.js";

// ---- Auth ------------------------------------------------------------
export function createAuthRouter({ config, store }: RouterDeps): Router {
  const router = Router();

  // Throttle credential guessing / signup floods (in-memory, single-process;
  // bypassed under NODE_ENV=test). Login is keyed per (ip, username) so one
  // account can't be hammered; signup is keyed per ip.
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

  router.post("/api/auth/signup", signupLimiter, (req, res) => {
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
    let user;
    try {
      user = store.createUser({ username, displayName, password });
    } catch (error) {
      if (error instanceof Error && error.message === "DUPLICATE_USERNAME") {
        apiError(res, 409, "이미 사용 중인 사용자명입니다.");
        return;
      }
      throw error;
    }
    // Approval mode: the account is created but parked (suspended) with no session
    // until an admin activates it. The client shows a "pending approval" notice.
    if (!isFirstUser && signupMode === "approval") {
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
  });

  router.post("/api/auth/login", loginLimiter, (req, res) => {
    const username = safeString(req.body?.username);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const user = store.verifyLogin(username, password);
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
    const visionPolicy = store.getModelVisionPolicy();
    res.json({
      needsSetup: !store.hasAnyUser(),
      githubHost: config.githubHost,
      // Lets the auth screen hide/adjust the signup affordance and show the right
      // copy (open vs. approval vs. closed) before anyone tries to register.
      signupMode: store.getSignupMode(),
      // Lets onboarding show the Confluence PAT field only when the deployment
      // has a Confluence host configured (the PAT is useless otherwise).
      confluenceConfigured: Boolean(config.confluenceUrl),
      // Deployment default for image input (MODEL_VISION). Per-MODEL support
      // rides on modelSelection.models[].vision below; this global remains the
      // fallback when no model resolves.
      visionEnabled: config.visionEnabled,
      // Per-conversation model picker: the models pi-gateway offers right now.
      // A pick is a pi model id; none (or one pi stopped offering) runs the
      // admin override, else pi-gateway's default model.
      modelSelection: {
        // `server` is pi's `owned_by`; `vision` the admin per-model policy ∘ MODEL_VISION.
        models: models.map((model) => ({
          id: model.id,
          server: model.server,
          vision: visionForModel(model.id, visionPolicy, config.visionEnabled),
        })),
        // Vision of the model a conversation gets when the user picked nothing:
        // the admin override when pi offers it, else pi-gateway's default model
        // (mirrors runCapabilities).
        defaultVision: visionForModel(
          effectiveModelOverride(store, catalogModelIds(models)),
          visionPolicy,
          config.visionEnabled,
        ),
      },
      // Per-conversation reasoning effort picker. A change mid-conversation
      // starts a new pi session from the text history (pi fixes effort per
      // session).
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
