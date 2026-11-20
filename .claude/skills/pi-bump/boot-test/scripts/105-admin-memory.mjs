#!/usr/bin/env node
// R — pi's new 장기 메모리 admin page THROUGH Noah's /admin proxy (pi-gateway ea1513f, 2026-11-20): the gateway
// reads the memory service with its own copy of the key (gateway/memory_api_key). pi's tests faked the memory
// service; here it is the real one. A Noah admin reads /admin/api/memory (+ notes/search of a listed wiki);
// a member is refused; a bad user id is a 400; a memory failure never logs the panel out (no 401).
import { check, client, dind, finish, loadState } from "./e2e-common.mjs";
import { randomUUID } from "node:crypto";

const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

// a wiki to look at: one note written the way Noah's client does (Noah's container, Noah's key file)
const OWNER = randomUUID();
dind("docker", "exec", "noah-almighty-noah-almighty-1", "node", "-e", `const fs=require("node:fs");const k=fs.readFileSync(process.env.PI_MEMORY_API_KEY_FILE,"utf8").trim();fetch(process.env.PI_MEMORY_URL+"/wiki/${OWNER}/note",{method:"PUT",headers:{authorization:"Bearer "+k,"content-type":"application/json"},body:JSON.stringify({path:"wiki/개념/배포.md",content:"---\\ntitle: 배포\\n---\\n금요일에는 배포하지 않는다"})}).then(async r=>console.log(r.status,await r.text()))`);
let r = await admin.get("/admin/api/memory");
const body = await j(r);
console.log(`  GET /admin/api/memory → ${r.status} ${JSON.stringify(body).slice(0, 400)}`);
check("admin GET /admin/api/memory → 200 (the gateway's key copy is accepted by the real memory service)", r.status === 200, r.status);
const wikis = body.wikis ?? body.items ?? (Array.isArray(body) ? body : []);
check("the list is an array of wikis", Array.isArray(wikis), JSON.stringify(body).slice(0, 200));
const first = wikis.find((w) => JSON.stringify(w).includes(OWNER)) ?? wikis[0];
check("the wiki just written is listed with its owner (.owner file)", JSON.stringify(first ?? {}).includes(OWNER), JSON.stringify(first));
if (first) {
  const owner = first.owner ?? first.user ?? first.id;
  console.log(`  first wiki: ${JSON.stringify(first)}`);
  r = await admin.get(`/admin/api/memory/notes?user=${encodeURIComponent(owner)}`);
  console.log(`  notes → ${r.status} ${JSON.stringify(await j(r)).slice(0, 300)}`);
  check("notes of a listed wiki → 200", r.status === 200, r.status);
  r = await admin.get(`/admin/api/memory/search?user=${encodeURIComponent(owner)}&q=a`);
  check("search of a listed wiki → 200", r.status === 200, r.status);
} else console.log("  (recorded, not judged) no wiki exists on this stack, so notes/search were not read");
r = await admin.get("/admin/api/memory/notes?user=../x");
check("an invalid user id → 400, never 401", r.status === 400, r.status);
r = await member.get("/admin/api/memory");
check("a member is refused (403)", r.status === 403, r.status);
finish();
