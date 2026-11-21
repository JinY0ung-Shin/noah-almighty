// The way to the login server (single sign-on; bootstrap `sso`). Logging in and
// registering there are FULL-PAGE navigations: Noah's server redirects the
// browser on, and the login server sends it back to `/` (a session) or to
// `/?auth=<code>` (no session — see AuthView).

const START_PATH = "/api/auth/oidc/start";

// A share link opened while logged out: the address's fragment does not come
// back from the login server's own page, so it is kept for this tab across the
// round trip. Only a share link, like a session expiry keeps only that.
const RETURN_HASH_KEY = "noah.loginReturnHash";
const RETURN_HASH_MAX_AGE_MS = 15 * 60 * 1000;
const SHARE_HASH_PREFIX = "#/share/";

/** The navigation itself, as a seam a test can watch (jsdom cannot navigate). */
export const loginServerNav = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

function rememberReturnHash(): void {
  try {
    if (location.hash.startsWith(SHARE_HASH_PREFIX)) {
      sessionStorage.setItem(RETURN_HASH_KEY, JSON.stringify({ hash: location.hash, at: Date.now() }));
    } else {
      sessionStorage.removeItem(RETURN_HASH_KEY);
    }
  } catch {
    // No storage (private mode, blocked): the link is opened again by hand.
  }
}

/**
 * Back from the login server: put the share link's fragment back in the address
 * (once), before the app reads its route. A no-op when nothing was kept, when
 * the address already has a fragment, or when what was kept is stale.
 */
export function restoreLoginReturnHash(): void {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(RETURN_HASH_KEY);
    if (raw !== null) sessionStorage.removeItem(RETURN_HASH_KEY);
  } catch {
    return;
  }
  if (!raw || location.hash) return;
  let kept: { hash?: unknown; at?: unknown };
  try {
    kept = JSON.parse(raw) as { hash?: unknown; at?: unknown };
  } catch {
    return;
  }
  if (typeof kept?.hash !== "string" || !kept.hash.startsWith(SHARE_HASH_PREFIX)) return;
  if (typeof kept.at !== "number" || Date.now() - kept.at > RETURN_HASH_MAX_AGE_MS) return;
  history.replaceState(history.state, "", `${location.pathname}${location.search}${kept.hash}`);
}

/** Log in on the login server, with the username already typed here filled in. */
export function goToLoginServerLogin(username: string): void {
  rememberReturnHash();
  loginServerNav.assign(`${START_PATH}?hint=${encodeURIComponent(username)}`);
}

/** The login server's registration form (a new account; on a first run, the administrator's). */
export function goToLoginServerRegistration(): void {
  rememberReturnHash();
  loginServerNav.assign(`${START_PATH}?register=1`);
}
