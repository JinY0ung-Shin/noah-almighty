#!/usr/bin/env node
// Accounts for the run: the FIRST signup is the admin/owner; a second signup waits for approval and is approved
// by the admin. Session cookies are kept in evidence/state.json (0600) so later scripts do not log in again
// (the login limiter is 20 per 5 minutes).
import { PASSWORD, check, client, finish, loadState, saveState } from "./e2e-common.mjs";

const state = loadState();
const stamp = Date.now().toString(36);

const owner = client(state.owner?.cookie);
if (!state.owner) {
  const username = `owner${stamp}`;
  const res = await owner.post("/api/auth/signup", { username, displayName: "Owner E2E", password: PASSWORD });
  const body = await res.json();
  check("first signup → 201, becomes admin", res.status === 201 && body.user?.roles?.includes("admin"), `status ${res.status}, roles ${JSON.stringify(body.user?.roles)}`);
  state.owner = { username, id: body.user.id, cookie: owner.cookie };
  saveState(state);
}
const me = await (await owner.get("/api/me")).json();
check("owner session works (/api/me)", me.user?.id === state.owner.id, `roles ${JSON.stringify(me.user?.roles)}`);

if (!state.second) {
  const username = `mate${stamp}`;
  const anon = client();
  const res = await anon.post("/api/auth/signup", { username, displayName: "Mate E2E", password: PASSWORD });
  const body = await res.json();
  check("second signup → 202 pending (approval mode)", res.status === 202 && body.pending === true, `status ${res.status}`);
  const early = await anon.post("/api/auth/login", { username, password: PASSWORD });
  check("pending account cannot log in (403)", early.status === 403, `status ${early.status} ${(await early.json()).error}`);
  const users = await (await owner.get("/api/admin/users")).json();
  const list = Array.isArray(users) ? users : users.users;
  const row = list.find((u) => u.username === username);
  const approve = await owner.post(`/api/admin/users/${row.id}/suspend`, { suspended: false });
  check("admin approves the second user", approve.status === 200, `status ${approve.status}`);
  const second = client();
  const login = await second.post("/api/auth/login", { username, password: PASSWORD });
  const loginBody = await login.json();
  check("approved second user logs in", login.status === 200 && loginBody.user?.id === row.id, `status ${login.status}, roles ${JSON.stringify(loginBody.user?.roles)}`);
  state.second = { username, id: row.id, cookie: second.cookie };
  saveState(state);
}
console.log(`owner ${state.owner.username} (${state.owner.id}), second ${state.second.username} (${state.second.id})`);
finish();
