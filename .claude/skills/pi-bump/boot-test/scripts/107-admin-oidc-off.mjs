#!/usr/bin/env node
// B — pi's admin API on an install WITHOUT an issuer (pi-gateway d6411c9, 2026-11-21). That commit lets the
// admin API take a person's OIDC access token when OIDC_ISSUER + OIDC_JWKS_URL are set, and made its
// authentication asynchronous for it. This stack sets neither value (no Keycloak overlay), so everything must be
// what it was: Noah's /admin relay gets in on the admin key, the key's own screen login still works, and a
// JWT-shaped bearer is just a wrong key. pi's tests ran against an in-process app; this looks at the gateway
// IMAGE as the stack runs it.
//   - NOT seen here: the path WITH an issuer (a real Keycloak token through Noah's relay) — that is
//     scripts/keycloak-login-check/run.sh, which has its own stack.
import { check, client, dindTry, finish, loadState } from "./e2e-common.mjs";

const NOAH_C = "noah-almighty-noah-almighty-1";
const GATEWAY_C = "noah-almighty-gateway-1";
const state = loadState();
const admin = client(state.owner.cookie);

const env = dindTry("docker", "exec", GATEWAY_C, "sh", "-c", 'printf "[%s][%s]" "$OIDC_ISSUER" "$OIDC_JWKS_URL"');
check("B  the gateway of this stack has no issuer configured", env.ok && env.out.trim() === "[][]", env.out.trim().slice(0, 120));

const viaRelay = await admin.get("/admin/api/session");
const relayText = await viaRelay.text();
check("B  Noah's /admin relay still gets a Noah admin in (on the admin key)", viaRelay.status === 200 && JSON.parse(relayText).authenticated === true, `${viaRelay.status} ${relayText.slice(0, 120)}`);

// Straight at the gateway, from inside Noah's container, with Noah's copy of the admin key (never printed).
const direct = (script) => dindTry("docker", "exec", NOAH_C, "node", "-e", `
  const fs = require("node:fs");
  const key = fs.readFileSync(process.env.PI_GATEWAY_ADMIN_API_KEY_FILE, "utf8").trim();
  const base = process.env.PI_GATEWAY_URL.replace(/\\/+$/, "");
  (async () => { ${script} })().catch((e) => { console.log("ERR " + e.message); });
`);
const jwtShaped = ["eyJhbGciOiJSUzI1NiIsImtpZCI6IngifQ", "eyJzdWIiOiJ4IiwiYXVkIjoicGkifQ", "c2ln"].join(".");
const out = direct(`
  const get = async (bearer) => (await fetch(base + "/admin/api/session", { headers: { authorization: "Bearer " + bearer } })).status;
  console.log("key " + (await get(key)));
  console.log("jwt " + (await get(${JSON.stringify(jwtShaped)})));
  const login = await fetch(base + "/admin/api/login", { method: "POST", headers: { "x-admin-request": "1", "content-type": "application/json" }, body: JSON.stringify({ apiKey: key }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  console.log("login " + login.status + " cookie=" + (cookie.startsWith("pi_gw_admin=") && cookie.length > 20));
  const withCookie = await fetch(base + "/admin/api/session", { headers: { cookie } });
  console.log("cookie-session " + withCookie.status);
  const logout = await fetch(base + "/admin/api/logout", { method: "POST", headers: { cookie, "x-admin-request": "1" } });
  console.log("logout " + logout.status + " after=" + (await fetch(base + "/admin/api/session", { headers: { cookie } })).status);
`);
const line = (name) => (out.out.split("\n").find((l) => l.startsWith(name + " ")) ?? "").slice(name.length + 1).trim();
console.log("  direct: " + out.out.trim().split("\n").join(" | "));
check("B  a program's Bearer admin key gets in", line("key") === "200", line("key"));
check("B  a JWT-shaped bearer is only a wrong key here: 401", line("jwt") === "401", line("jwt"));
check("B  the admin key's own screen login still works (a session cookie is issued and accepted)", line("login") === "200 cookie=true" && line("cookie-session") === "200", `${line("login")} / ${line("cookie-session")}`);
check("B  …and logging out ends that session", line("logout") === "200 after=401", line("logout"));
finish();
