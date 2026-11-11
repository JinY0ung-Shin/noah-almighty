// Names a SELF-SERVICE signup may not take: they read as the system, an
// operator or a route word ("admin", "root", "noah", "me", "api"…), so a pending
// row or a teammate list entry carrying one invites a mistaken approval or
// misplaced trust. Only `POST /api/auth/signup` past the first account applies
// this; the first account (the admin bootstrap) and every EXISTING account are
// never judged by it — an instance whose admin is called `admin` keeps working.

const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // Operators
  "admin",
  "admins",
  "administrator",
  "administrators",
  "sysadmin",
  "superadmin",
  "root",
  "superuser",
  // The system itself
  "system",
  "sys",
  "noah",
  "noahalmighty",
  // Help / trust
  "support",
  "helpdesk",
  "security",
  // Values and route words that read as "nobody" or as a path
  "null",
  "undefined",
  "none",
  "nil",
  "me",
  "self",
  "api",
]);

/** Digits commonly typed in place of a letter (`adm1n`, `r00t`, `n0ah`). */
const LOOKALIKE_DIGITS: Readonly<Record<string, string>> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };

/**
 * Whether a self-service signup must not take `username`. Compared
 * case-insensitively and across close variants: separators (`.`, `_`, `-`) are
 * ignored, a numeric suffix is ignored (`admin2`, `root_01`), and look-alike
 * digits are read as their letters (`adm1n`, `r00t`). A reserved word inside a
 * longer name is fine (`noah.kim`, `adminton`).
 */
export function isReservedUsername(username: string): boolean {
  const folded = username.trim().toLowerCase().replace(/[._-]+/g, "");
  if (!folded) return false;
  const withoutSuffix = folded.replace(/\d+$/, "");
  const lookalike = (value: string) => value.replace(/[013457]/g, (digit) => LOOKALIKE_DIGITS[digit] ?? digit);
  return [folded, withoutSuffix, lookalike(folded), lookalike(withoutSuffix)].some(
    (candidate) => candidate !== "" && RESERVED_USERNAMES.has(candidate),
  );
}
