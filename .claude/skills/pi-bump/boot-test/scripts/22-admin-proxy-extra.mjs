#!/usr/bin/env node
// Extra: which combinations the /admin proxy refuses on a mutating call (information for the report).
import { NOAH, client, loadState } from "./e2e-common.mjs";
const admin = client(loadState().owner.cookie);
const cases = {
  "Origin evil, no Sec-Fetch-Site, X-Admin-Request:1 (what a plain-HTTP browser page elsewhere could at most send)": { origin: "https://evil.example", "x-admin-request": "1" },
  "Sec-Fetch-Site cross-site, own Origin, X-Admin-Request:1": { origin: NOAH, "sec-fetch-site": "cross-site", "x-admin-request": "1" },
  "Sec-Fetch-Site same-site, X-Admin-Request:1": { origin: NOAH, "sec-fetch-site": "same-site", "x-admin-request": "1" },
  "own Origin, Referer outside /admin, X-Admin-Request:1": { origin: NOAH, referer: `${NOAH}/chat`, "x-admin-request": "1" },
  "only X-Admin-Request:1 (no Origin, no Sec-Fetch-Site — curl)": { "x-admin-request": "1" },
};
for (const [name, headers] of Object.entries(cases)) {
  const res = await admin.put("/admin/api/systemone", { model: null }, headers);
  console.log(`${res.status}  ${name}  ${(await res.text()).slice(0, 120)}`);
}
