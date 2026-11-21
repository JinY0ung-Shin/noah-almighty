// Phase 2 — the SAME install after the Keycloak overlay is turned on (same data volume).
import { Browser, check, summary, keycloakAdmin, kcError } from "./lib.mjs";
const kc = await keycloakAdmin(process.env.SECRET);
const IDS = JSON.parse(process.env.IDS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(500); } };
const loginAtKeycloak = async (browser, username, password, hint = username) => {
  const page = await browser.go(`/api/auth/oidc/start?hint=${encodeURIComponent(hint)}`);
  return browser.submitKeycloakForm(page, { username, password });
};

const boot = (await new Browser().json("/api/bootstrap")).body;
check("Keycloak install: sso is on", boot.sso === true && boot.needsSetup === false);

// ---- the boot import ------------------------------------------------------
const imported = await until(async () => (await kc.user(IDS.legacy1)) && (await kc.user(IDS.Legacy2)) && (await kc.user(IDS.legacy3)));
check("boot import: every existing account is in Keycloak under its Noah id", Boolean(imported));
check("usernames arrive lower-cased; no display name is sent (free text in Noah)", (await kc.user(IDS.Legacy2))?.username === "legacy2" && !(await kc.user(IDS.Legacy2))?.firstName);
const teammates = await until(async () => { const t = await kc.teammates(); return t.includes("legacy1") && t.includes("legacy2") ? t : null; });
check("teammates group = approved accounts only (the pending one is out)", JSON.stringify(teammates) === JSON.stringify(["legacy1", "legacy2"]), JSON.stringify(teammates));
check("admin role = Noah admins", JSON.stringify(await kc.admins()) === JSON.stringify(["legacy1"]), JSON.stringify(await kc.admins()));

// ---- the move of a built-in password -------------------------------------
const method = async (username) => (await new Browser().json("/api/auth/login-method", { method: "POST", json: { username } })).body.method;
check("login-method: an account not moved yet → password; an unknown name → sso", (await method("legacy1")) === "password" && (await method("nobody")) === "sso");
const before = await loginAtKeycloak(new Browser(), "legacy1", "legacy1-password");
check("before the move Keycloak has no password for the account", before.res.status === 200 && Boolean(kcError(before.text)), kcError(before.text) ?? before.url);
const adminBrowser = new Browser();
const builtIn = await adminBrowser.json("/api/auth/login", { method: "POST", json: { username: "legacy1", password: "legacy1-password" } });
check("built-in login with the old password still works (and moves it)", builtIn.status === 200 && builtIn.body.user?.id === IDS.legacy1, String(builtIn.status));
check("after the move: login-method says sso, the built-in form answers 409 sso", (await method("legacy1")) === "sso" && (await new Browser().json("/api/auth/login", { method: "POST", json: { username: "legacy1", password: "legacy1-password" } })).status === 409);
const moved = new Browser();
const back = await loginAtKeycloak(moved, "legacy1", "legacy1-password");
const me = (await moved.json("/api/me")).body.user;
check("the SAME password now logs in at Keycloak and lands in Noah as the same account", new URL(back.url).pathname === "/" && me?.id === IDS.legacy1 && me?.roles?.includes("admin"), `${back.url} ${me?.id}`);
check("a wrong password is refused by Keycloak", Boolean(kcError((await loginAtKeycloak(new Browser(), "legacy1", "wrong-password")).text)));

// A mixed-case name: moved through the built-in form, then typed either way at Keycloak.
await new Browser().json("/api/auth/login", { method: "POST", json: { username: "Legacy2", password: "legacy2-password" } });
const l2 = new Browser();
const l2back = await loginAtKeycloak(l2, "Legacy2", "legacy2-password");
check("mixed-case account: logs in at Keycloak and is matched by id", new URL(l2back.url).pathname === "/" && (await l2.json("/api/me")).body.user?.id === IDS.Legacy2, l2back.url);
const list = (await adminBrowser.json("/api/admin/users")).body.users;
const flag = (name) => list.find((u) => u.username === name)?.builtInPassword;
check("admin list: moved accounts have no built-in password, the untouched one still has", flag("legacy1") === false && flag("Legacy2") === false && flag("legacy3") === true, JSON.stringify(list.map((u) => [u.username, u.builtInPassword])));

// ---- a new person ---------------------------------------------------------
check("the built-in signup form is closed", (await new Browser().json("/api/auth/signup", { method: "POST", json: { username: "viaform", displayName: "x", password: "password123" } })).status === 400);
const newbie = new Browser();
const regPage = await newbie.go("/api/auth/oidc/start?register=1");
check("register=1 opens Keycloak's registration form (Korean)", /password-confirm/.test(regPage.text) && /lang="ko"/.test(regPage.text), regPage.url.slice(0, 80));
const regBack = await newbie.submitKeycloakForm(regPage, { username: "newbie", password: "newbie-password", "password-confirm": "newbie-password", firstName: "새내기" });
check("a new registration comes back as pending, with no session", regBack.url.endsWith("/?auth=pending") && (await newbie.json("/api/me")).body.user === null, regBack.url);
const rows = (await adminBrowser.json("/api/admin/users")).body.users;
const newbieRow = rows.find((u) => u.username === "newbie");
const newbieKc = newbieRow ? await kc.user(newbieRow.id) : null;
check("Noah's account took Keycloak's id and display name; it is suspended (pending)", Boolean(newbieKc) && newbieRow.suspended === true && newbieRow.displayName === "새내기" && newbieRow.builtInPassword === false, JSON.stringify(newbieRow));
check("a pending account is not a teammate in Keycloak", !(await kc.teammates()).includes("newbie"));
const again = await loginAtKeycloak(newbie, "newbie", "newbie-password");
check("pending again on the next try (the Keycloak session had been ended: the form was shown)", again.url.endsWith("/?auth=pending"), again.url);

await adminBrowser.json(`/api/admin/users/${newbieRow.id}/suspend`, { method: "POST", json: { suspended: false } });
check("approval puts the account in the teammates group", Boolean(await until(async () => (await kc.teammates()).includes("newbie"))));
const approved = await loginAtKeycloak(newbie, "newbie", "newbie-password");
check("approved: the same login now gets a session", new URL(approved.url).pathname === "/" && (await newbie.json("/api/me")).body.user?.id === newbieRow.id, approved.url);

// ---- logout ends the Keycloak session --------------------------------------
await newbie.json("/api/auth/logout", { method: "POST", json: {} });
await sleep(1500);
const afterLogout = await newbie.go("/api/auth/oidc/start");
check("after logout Keycloak asks for the password again (no silent re-login)", /name="password"/.test(afterLogout.text) && afterLogout.url.includes("/sso/realms/noah/"), afterLogout.url.slice(0, 70));

// ---- suspension, roles, delete ---------------------------------------------
const relogin = new Browser();
await loginAtKeycloak(relogin, "newbie", "newbie-password");
await adminBrowser.json(`/api/admin/users/${newbieRow.id}/suspend`, { method: "POST", json: { suspended: true } });
check("suspension takes the account out of the group", Boolean(await until(async () => !(await kc.teammates()).includes("newbie"))));
check("…and kills its Noah session", (await relogin.json("/api/me")).body.user === null);
const susp = await loginAtKeycloak(new Browser(), "newbie", "newbie-password");
check("a suspended account that logs in at Keycloak is told so and gets no session", susp.url.endsWith("/?auth=suspended"), susp.url);

await adminBrowser.json(`/api/admin/users/${IDS.Legacy2}/roles`, { method: "POST", json: { role: "admin", grant: true } });
check("granting admin in Noah grants the realm role", Boolean(await until(async () => (await kc.admins()).includes("legacy2"))));
await adminBrowser.json(`/api/admin/users/${IDS.Legacy2}/roles`, { method: "POST", json: { role: "admin", grant: false } });
check("…and revoking it revokes the role", Boolean(await until(async () => !(await kc.admins()).includes("legacy2"))));

const reset = await adminBrowser.json(`/api/admin/users/${IDS.legacy3}/password`, { method: "POST", json: { password: "reset-by-admin-1" } });
const afterReset = (await adminBrowser.json("/api/admin/users")).body.users.find((u) => u.username === "legacy3");
check("an admin password reset goes to Keycloak, not into Noah", reset.status === 200 && afterReset.builtInPassword === false, String(reset.status));
const l3 = await loginAtKeycloak(new Browser(), "legacy3", "reset-by-admin-1");
check("…the reset password works at Keycloak (the account is still pending in Noah)", l3.url.endsWith("/?auth=pending"), l3.url);
const short = await adminBrowser.json(`/api/admin/users/${IDS.legacy3}/password`, { method: "POST", json: { password: "short" } });
check("a too-short reset is refused", short.status === 400, String(short.status));

await adminBrowser.json("/api/admin/signup-mode", { method: "PUT", json: { mode: "closed" } });
const closedRealm = await until(async () => ((await kc.realm()).registrationAllowed === false ? true : null));
const closedPage = await new Browser().go("/api/auth/oidc/start?register=1");
check("signup closed: Keycloak stops offering registration, register=1 is a plain login", Boolean(closedRealm) && !/password-confirm/.test(closedPage.text), String(closedRealm));
await adminBrowser.json("/api/admin/signup-mode", { method: "PUT", json: { mode: "approval" } });
check("signup approval again: registration is back", Boolean(await until(async () => ((await kc.realm()).registrationAllowed === true ? true : null))));

const del = await adminBrowser.req(`/api/admin/users/${newbieRow.id}`, { method: "DELETE" });
check("deleting the account in Noah deletes it in Keycloak", del.status === 200 && Boolean(await until(async () => ((await kc.user(newbieRow.id)) === null ? true : null))), String(del.status));

// ---- pi's admin API through Noah's /admin relay --------------------------------
// Noah's copy of pi's admin key is WRONG in this stack, so whatever pi lets in came on the person's token.
const viaRelay = (browser) => browser.json("/admin/api/session");
const adminViaToken = await viaRelay(moved);
check("a Noah admin on a Keycloak session reaches pi's admin API — on their own token, checked by pi", adminViaToken.status === 200 && adminViaToken.body.authenticated === true, `${adminViaToken.status} ${JSON.stringify(adminViaToken.body).slice(0, 120)}`);
const adminViaKey = await viaRelay(adminBrowser);
check("the same admin on a built-in session falls back to the key (wrong here → pi refuses)", adminViaKey.status === 401, `${adminViaKey.status} ${JSON.stringify(adminViaKey.body).slice(0, 120)}`);
const memberViaRelay = await viaRelay(l2);
check("a teammate who is not an admin never gets past Noah's relay", memberViaRelay.status === 403, String(memberViaRelay.status));
const direct = (headers, path = "/admin/api/session", init = {}) => fetch("http://gateway:8080" + path, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
check("pi itself: a program's Bearer admin key still works, a wrong key does not", (await direct({ authorization: "Bearer " + process.env.PI_ADMIN_KEY })).status === 200 && (await direct({ authorization: "Bearer " + "0".repeat(64) })).status === 401);
const keyLogin = await direct({ "x-admin-request": "1", "content-type": "application/json" }, "/admin/api/login", { method: "POST", body: JSON.stringify({ apiKey: process.env.PI_ADMIN_KEY }) });
check("pi itself: the admin key's screen login is off on an install with an issuer", keyLogin.status === 403 && (await keyLogin.json()).error?.code === "key_login_disabled", String(keyLogin.status));
// ---- the front door ---------------------------------------------------------
const b = new Browser();
check("Keycloak's admin console and API are not reachable through nginx", (await b.req("/sso/admin/")).status === 404 && (await b.req("/sso/admin/realms/noah/users")).status === 404 && (await b.req("/sso/")).status === 404);
check("the account console (change your own password) is", [200, 302].includes((await b.req("/sso/realms/noah/account/")).status));
check("Keycloak's own `master` realm has no page at the front door", (await b.req("/sso/realms/master/.well-known/openid-configuration")).status === 404 && (await b.req("/sso/realms/master/protocol/openid-connect/token", { method: "POST", form: { grant_type: "password" } })).status === 404);
const grant = await b.req("/sso/realms/noah/protocol/openid-connect/token", { method: "POST", form: { grant_type: "password", client_id: "admin-cli", username: "legacy1", password: "legacy1-password" } });
check("no password grant in the realm (the default `admin-cli` client is off)", grant.status >= 400 && !(await grant.text()).includes("access_token"), String(grant.status));
summary();
