import { Router } from "express";
import {
  clearSessionCookie,
  sessionTokenFromRequest,
  setSessionCookie,
} from "../auth.js";
import logger from "../logger.js";
import { createRateLimiter } from "../rateLimit.js";
import { apiError, safeString, MIN_PASSWORD_LENGTH, type RouterDeps } from "./_shared.js";
import { DEFAULT_MODEL_TIER, MODEL_TIERS } from "../modelTiers.js";
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
  router.get("/api/bootstrap", (_req, res) => {
    res.json({
      needsSetup: !store.hasAnyUser(),
      githubHost: config.githubHost,
      // Lets the auth screen hide/adjust the signup affordance and show the right
      // copy (open vs. approval vs. closed) before anyone tries to register.
      signupMode: store.getSignupMode(),
      // Lets onboarding show the Confluence PAT field only when the deployment
      // has a Confluence host configured (the PAT is useless otherwise).
      confluenceConfigured: Boolean(config.confluenceUrl),
      // Deployment default for image input (MODEL_VISION). Per-TIER support
      // rides on modelSelection.tiers[].vision below; this global remains the
      // fallback for locked/unresolvable cases.
      visionEnabled: config.visionEnabled,
      // Per-conversation model picker: the selectable tiers + whether the choice
      // is locked by an env-pinned ANTHROPIC_MODEL (then the composer hides the
      // picker). The concrete model each tier maps to is the operator's call via
      // ANTHROPIC_DEFAULT_*_MODEL (see modelTiers.ts).
      modelSelection: {
        // Each tier carries the concrete model id it resolves to when the operator
        // pinned one via ANTHROPIC_DEFAULT_<TIER>_MODEL (null otherwise — the SDK
        // then uses the account default, which the app can't name), plus whether
        // that tier accepts image input (admin per-tier policy ∘ MODEL_VISION).
        tiers: MODEL_TIERS.map((tier) => ({
          ...tier,
          model: config.defaultTierModels[tier.id] ?? null,
          vision: visionForModel(tier.id, store.getModelVisionPolicy(), config.visionEnabled),
        })),
        locked: Boolean(config.anthropicModel),
        // Vision of the model a conversation gets when the user picked nothing:
        // env pin > admin override > default tier (mirrors claudeAgent).
        defaultVision: visionForModel(
          config.anthropicModel ?? store.getModelOverride() ?? DEFAULT_MODEL_TIER,
          store.getModelVisionPolicy(),
          config.visionEnabled,
        ),
      },
      // Per-conversation reasoning effort picker. Independent of the model pin
      // (effort still applies when ANTHROPIC_MODEL locks the model), so there is
      // no `locked` flag here. The SDK downgrades unsupported levels per model.
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
