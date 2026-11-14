#!/usr/bin/env node
// A (extra): pi's admin UI assets load through Noah's /admin proxy, and the new pi's UI has the System One tab.
import { check, client, finish, loadState } from "./e2e-common.mjs";
const admin = client(loadState().owner.cookie);
const html = await (await admin.get("/admin/")).text();
console.log(html.replace(/\s+/g, " ").slice(0, 760));
const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
for (const asset of assets) {
  const url = asset.startsWith("/") ? asset : `/admin/${asset.replace(/^\.\//, "")}`;
  const res = await admin.get(url);
  const body = await res.text();
  check(`GET ${url} → 200 (${res.headers.get("content-type")}, ${body.length} bytes)`, res.status === 200 && body.length > 0);
  if (url.endsWith(".js")) check("  the UI bundle has the System One tab", /System One/.test(body) && body.includes("systemone"));
}
const alias = await admin.get("/settings/pi");
console.log("GET /settings/pi →", alias.status, alias.headers.get("location") ?? alias.headers.get("content-type"));
finish();
