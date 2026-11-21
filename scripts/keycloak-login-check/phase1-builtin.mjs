// Phase 1 — the install BEFORE Keycloak: the built-in login only. Leaves two accounts behind.
import { Browser, check, summary } from "./lib.mjs";
const admin = new Browser();
const boot = await admin.json("/api/bootstrap");
check("built-in install: sso is off, setup pending", boot.body.sso === false && boot.body.needsSetup === true, JSON.stringify({ sso: boot.body.sso, needsSetup: boot.body.needsSetup }));
const a = await admin.json("/api/auth/signup", { method: "POST", json: { username: "legacy1", displayName: "레거시 하나", password: "legacy1-password" } });
check("first account (admin) through the built-in signup", a.status === 201 && a.body.user?.roles?.includes("admin"), String(a.status));
const b = await new Browser().json("/api/auth/signup", { method: "POST", json: { username: "Legacy2", displayName: "레거시 둘", password: "legacy2-password" } });
check("second account waits for approval", b.status === 202 && b.body.pending === true, String(b.status));
const users = (await admin.json("/api/admin/users")).body.users;
const second = users.find((u) => u.username === "Legacy2");
const ok = await admin.json(`/api/admin/users/${second.id}/suspend`, { method: "POST", json: { suspended: false } });
check("admin approves it", ok.status === 200 && ok.body.user?.suspended === false, String(ok.status));
const c = await new Browser().json("/api/auth/signup", { method: "POST", json: { username: "legacy3", displayName: "레거시 셋(대기)", password: "legacy3-password" } });
check("a third account stays pending", c.status === 202);
// Keycloak is already up next to this install (its realm imported, Noah not using it yet): its
// registration form must be closed until Noah's first pass has created the accounts above.
const early = await new Browser().req("/sso/realms/noah/protocol/openid-connect/registrations?client_id=noah&response_type=code&scope=openid&redirect_uri=" + encodeURIComponent("https://noah.rig.test/api/auth/oidc/callback"));
const earlyText = await early.text();
check("before Noah's first pass Keycloak offers no registration", !/password-confirm/.test(earlyText), String(early.status));
console.log("IDS " + JSON.stringify(Object.fromEntries((await admin.json("/api/admin/users")).body.users.map((u) => [u.username, u.id]))));
summary();
