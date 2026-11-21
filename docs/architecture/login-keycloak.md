# Login through the bundled Keycloak (2026-11-21)

Step 2 of "pi owns the harness" ([`pi-runtime.md`](pi-runtime.md), "Direction"). Built: Noah's login, and —
since pi `d6411c9` — pi's ADMIN API taking the person's own token (Noah's `/admin` relay carries it; pi checks
signature, issuer, audience `pi`, expiry, the admin role and the teammates group itself). Not built: a browser
login of pi's own, the per-person screens in pi, tokens on pi's `/v1`.

An install either has a Keycloak (`AppConfig.keycloak`, the `docker-compose.keycloak.yml` overlay) or it does
not. Without one, login is the built-in username + password, unchanged. With one, **Keycloak says WHO a person
is; Noah still says whether that person is a teammate.**

## The pieces

| Piece | Where |
|---|---|
| The three values (`KEYCLOAK_PUBLIC_URL`, `KEYCLOAK_INTERNAL_URL`, `KEYCLOAK_CLIENT_SECRET_FILE`; all or none, the secret from a file only) | `config.ts` `parseKeycloakConfig` |
| Keycloak client: the code flow + the admin API as the `noah` service account | `keycloak.ts` (`keycloakFor`) |
| Routes: `login-method`, the move inside `login`, `oidc/start`, `oidc/callback`, logout | `routes/auth.ts` |
| Writing Noah's decisions into Keycloak, and the boot pass | `keycloakSync.ts` (`syncUserToKeycloak`, `reconcileKeycloak`), hooks in `routes/admin.ts` |
| Store: `createUser({ id })`, `hasBuiltInPassword`, `clearBuiltInPassword`, `accountGate`, `sessions.keycloak_refresh_enc` | `store/users.ts` |
| Login screen (name first) and the admin badge | `components/AuthView.tsx`, `lib/loginServer.ts`, `AdminUserRow.tsx` |
| Realm (imported ONCE), compose overlay, nginx paths, secrets | `docker/keycloak/noah-realm.json`, `docker-compose.keycloak.yml`, `docker/nginx/noah.conf.template`, `docker/pi/setup-host.sh` |

Realm `noah`, client `noah`, group `teammates`, realm role `admin` are fixed names (`keycloak.ts`), not
configuration.

## Rules

- **One id.** A Keycloak account's id IS the Noah user id (pi's workspaces and memory wikis are keyed by it).
  An existing account is created in Keycloak with its Noah id (`partialImport` — the one admin call that keeps
  a given id; `POST /users` mints its own). An account born in Keycloak gives Noah its id
  (`createUser({ id: sub })`). A login is matched **by id only**; a username that exists under another id is
  never merged (`auth=name`, an error line for the operator).
- **Approval is still the trust gate.** A Keycloak account alone is nobody: a first login creates a PENDING
  Noah account (suspended, never seen) and gets no session; signup mode `closed`, the signup caps and the
  reserved names apply as they do to the built-in signup. The first account ever is the admin, as before.
- **Noah writes, Keycloak holds.** Approved (= not suspended) ↔ member of `teammates`; a Noah admin who is
  not suspended ↔ realm role `admin` (a suspended admin holds neither); deleted ↔ deleted; signup mode `approval` ↔ the realm's `registrationAllowed`. Written at each
  admin press (best effort, per-user order kept) and made equal again by a PASS (`reconcileKeycloak`: import the
  missing accounts, add AND remove group/role until both match Noah) — at boot, and shortly after any write
  that failed (the failed user ids are written again first, so a delete Keycloak missed is repeated too). One
  account Keycloak refuses to create never holds back the others. Noah never disables a Keycloak account —
  a suspension takes the group away and ends the account's Keycloak sessions, so Noah's own notice is what the
  person sees.
- **Noah handles no Keycloak password and verifies no token.** The client has no password grant. The code is
  traded on the internal network (client secret + PKCE verifier) and Keycloak's own `userinfo` says who the
  token is for. `state` + the verifier live in the starting browser's HttpOnly cookie (`ac_login_flow`, path
  `/api/auth/oidc`, 10 minutes, cleared by the first callback).
- **A session that began at Keycloak ends there too.** The login's refresh token is kept encrypted on the
  session row for that; logout and a refused login AWAIT Keycloak's logout — a retry that arrives
  while the session is still ending gets a code that is dead when Noah trades it.
- **The pi admin relay carries the PERSON's token when the session has one, pi's admin key otherwise**
  (`keycloakPersonToken.ts`; [`pi-runtime.md`](pi-runtime.md), "pi admin panel proxy"). The same stored refresh
  token is traded for a short-lived access token (a newer refresh token Keycloak returns replaces the stored
  one); access tokens live in memory only and are never parsed by Noah — pi verifies the token itself. A
  built-in-login session, a refused refresh or an unreachable Keycloak falls back to the key.
- **One password per account, ever.** With Keycloak configured the admin's password reset writes Keycloak, not
  Noah; a login at Keycloak drops a digest Noah still held. A reset and a move of the same account run in
  that account's turn (`setKeycloakPassword`), the digest is dropped inside it, and a move acts only while
  the digest its password verified against is still there — so a move queued behind a reset never puts the
  old password back (that login is a 401). The one exception: an account Keycloak cannot hold (its username
  is another account's there) keeps its built-in password, and an admin's reset writes that.

## The move of existing passwords (user decision 2026-11-21: at each person's next login)

Keycloak (26.8) verifies argon2 and pbkdf2 only; Noah's digests are scrypt, so a digest cannot be imported.
Accounts are imported WITHOUT a password. The login screen asks the name first (`POST /api/auth/login-method`):
a name that still has a built-in digest types its password into Noah's form one last time — `login` verifies
the digest, puts that password into Keycloak (`reset-password`, not temporary), drops the digest and logs this
one login in (through `setKeycloakPassword`, in that account's own turn, like an admin's reset). Every other name (moved, born in Keycloak, unknown — the same answer for all three) goes to
Keycloak's page; the built-in form answers `409 { sso: true }` for them. A move that fails (Keycloak down, a
password its policy refuses) keeps the digest and the login, and is tried again next time.

Known and accepted while the move lasts: `login-method` tells an unauthenticated caller which names have not
moved yet. The admin list shows who is left (`builtInPassword`). **Retiring the built-in form and the
`password_hash` column is a separate, later step** (through `retirementGate()`), when nobody is left or an
admin has reset the stragglers.

## Deployment

- The overlay needs the nginx overlay: Keycloak's pages are a path of Noah's own address
  (`https://<NOAH_SERVER_NAME>/sso/`). nginx passes `/sso/realms/noah/` and `/sso/resources/` only — the
  admin console, the admin API and Keycloak's own `master` realm are a 404 at the front door — and strips
  Noah's `ac_session` cookie from what it passes (same host name, so the browser sends it). What does come
  through besides the login pages: the realm's account console (a person changes their own password
  there) and its token endpoint. The realm has no password grant (`noah` has none; the default `admin-cli`
  client is switched off by the realm file).
- **Keycloak shares Noah's ORIGIN.** A script-injection bug in a Keycloak page would run in Noah's origin.
  A host name of its own for Keycloak would separate the two; the path was chosen so no second name,
  certificate or port is needed.
- `KC_HOSTNAME` = the browser's address, `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`: every token's `iss` and every
  page carry the public address, while Noah calls token / userinfo / admin on `http://keycloak:8080/sso`
  (network `noah-auth`, internal). Keycloak believes forwarded headers from nginx's pinned address only.
- Keycloak's database is its own PostgreSQL (`keycloak-db-data`) — **back it up with Noah's data volume**.
- `setup-host.sh` makes Keycloak's secrets once and keeps them (a regenerated value would not match the
  database); half a set stops the script. `keycloak.env` is NOT a compose `env_file` (compose itself would
  have to read a file in root's folder): it is mounted as a secret, owned by the uid Keycloak runs as, and
  sourced by the container's entrypoint.
- The realm file is imported once. A later change to it does not reach an existing realm. It arrives with
  registration CLOSED: Noah's first pass opens it (signup mode `approval`) after it created the existing
  accounts — an open form before that would let anyone take an existing username first.
- Keycloak's health check is "the `noah` realm answers": its own readiness page turns UP before the first
  start's import is done.

## Gotchas found on a real Keycloak (26.8.2)

- The admin API refuses a token without the admin-API audience (401 "Expected audience not available"),
  whatever its roles: the `noah` client has the `kc-admin-api` scope as OPTIONAL and the service account asks
  for it per token, so no person's token carries it.
- `partialImport` needs `manage-realm` (with `manage-users` alone: 403). Noah's service account has both; it
  also flips `registrationAllowed`.
- Keycloak lower-cases usernames. Matching is by id, so `Legacy2` logs in as `legacy2`; two Noah accounts that
  differ only by case cannot both be imported (the second is reported, never merged).
- Display names are NOT sent: a free-text name that breaks a rule of Keycloak's user profile sends that person
  to "update your profile" on every login. The profile asks a new person for username, password and an
  optional display name; no e-mail.
- A user disabled or logged out in Keycloak keeps a validly SIGNED access token until it expires (300 s).
  Noah checks its own session per request, so nothing changes for Noah; it matters to whoever verifies only the
  signature (pi, later).

## Verify

`scripts/keycloak-login-check/run.sh` — a private compose project (nothing published on the host) with the
REAL `keycloak`, `keycloak-db` and `noah-nginx` service definitions and a Noah image built from the checkout:
phase 1 creates accounts on the built-in login, phase 2 turns Keycloak on over the same data and walks the
import, the move, a new registration, approval, logout, suspension, roles, the admin reset, signup mode and
delete, what the front door refuses, and pi's admin API through the `/admin` relay with pi's gateway built from
`vendor/pi-gateway` (Noah's copy of pi's admin key is wrong there on purpose, so what pi lets in came on the
person's token) — 6 + 42 checks. Not covered by it: a real browser, the root-owned
secrets folder of a real host (the check's files are the caller's), and the rest of pi (sandboxes, turns).
