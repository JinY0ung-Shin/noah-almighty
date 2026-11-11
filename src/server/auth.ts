import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import logger from "./logger.js";
import type { Store } from "./store.js";
import type { User } from "./types.js";

const SESSION_COOKIE = "ac_session";

export interface AuthenticatedRequest extends Request {
  user?: User;
}

// ---- Password hashing (scrypt) -----------------------------------------

const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 64;

/** `crypto.scrypt` (libuv threadpool, default cost parameters) as a promise. */
function scrypt(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
}

/**
 * Hash a password as `${saltHex}:${hashHex}` using scrypt with a random salt.
 * Asynchronous: scrypt takes tens of milliseconds, and the synchronous variant
 * stalled the event loop — every SSE stream with it — on each login. Every
 * REQUEST path uses this one and hands the digest to the store.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(PASSWORD_SALT_BYTES);
  const hash = await scrypt(password, salt, PASSWORD_HASH_BYTES);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * {@link hashPassword}, blocking — the SAME digest format and parameters. Only
 * for callers that are not serving requests and cannot await (the store's
 * `createUser({ password })` used by fixtures and scripts). Never call it from
 * a route: it blocks the event loop for the whole derivation.
 */
export function hashPasswordSync(password: string): string {
  const salt = crypto.randomBytes(PASSWORD_SALT_BYTES);
  const hash = crypto.scryptSync(password, salt, PASSWORD_HASH_BYTES);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Verify a password against a `${saltHex}:${hashHex}` digest in constant time
 * (asynchronous, see {@link hashPassword}). The derived length is the stored
 * hash's own length, so every digest ever written keeps verifying; a digest
 * with no hash bytes (corrupt hex) never verifies.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) {
    return false;
  }
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length === 0) {
    return false;
  }
  const actual = await scrypt(password, salt, expected.length);
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

/** Hash a session token (sha256) for storage as token_hash. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ---- Cookies ------------------------------------------------------------

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const cookie of header.split(";").map((part) => part.trim())) {
    const [cookieName, ...rest] = cookie.split("=");
    if (cookieName === name) {
      return decodeURIComponent(rest.join("="));
    }
  }
  return undefined;
}

// Only mark the cookie `Secure` when explicitly opted in (HTTPS deployments).
// NODE_ENV is "production" in the Docker image even though docker-compose serves
// plain HTTP, and a Secure cookie is never sent back over HTTP — which silently
// breaks auth on the first post-login request. Gate on a dedicated flag instead.
const secureCookies = process.env.SECURE_COOKIES === "true";

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    path: "/",
    maxAge: 14 * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function sessionTokenFromRequest(req: Request): string | undefined {
  return readCookie(req, SESSION_COOKIE);
}

// ---- Middleware ---------------------------------------------------------

export function requireAuth(store: Store) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const user = store.getUserBySessionToken(sessionTokenFromRequest(req));
    if (!user) {
      logger.warn({ method: req.method, path: req.path }, "auth rejected");
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.user = user;
    next();
  };
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.user?.roles.includes("admin")) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
