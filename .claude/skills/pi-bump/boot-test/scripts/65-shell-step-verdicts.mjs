#!/usr/bin/env node
// The shell steps of run-all.sh (05, 20, 04, 22, 40, 60) only PRINT what they saw. This reads their evidence
// files and judges them against what a healthy stack answers, so the run's summary needs no reading by eye.
// When one of those steps gains or loses a line, change the expectation here in the same edit.
import { existsSync, readFileSync } from "node:fs";
import { W, check, finish } from "./e2e-common.mjs";

const read = (name) => (existsSync(`${W}/evidence/${name}`) ? readFileSync(`${W}/evidence/${name}`, "utf8") : "");
/** The HTTP status printed in the section of `text` whose `== …` heading contains `heading`. */
const statusIn = (text, heading) => {
  const start = text.split("\n").findIndex((line) => line.startsWith("== ") && line.includes(heading));
  if (start < 0) return null;
  for (const line of text.split("\n").slice(start + 1)) {
    if (line.startsWith("== ")) break;
    const hit = /^HTTP (\d{3})\b/.exec(line);
    if (hit) return Number(hit[1]);
  }
  return null;
};
/** The status on the line of `text` that starts with `label` (`<label> → HTTP <code>`). */
const statusAfter = (text, label) => {
  const line = text.split("\n").find((l) => l.startsWith(label));
  const hit = line ? /→ HTTP (\d{3})\b/.exec(line) : null;
  return hit ? Number(hit[1]) : null;
};

// ---- 05-pi-setup-logs.sh: one PUT per MCP server on the first run, the same number unchanged on a re-run
const setup = read("A1-pi-setup.log");
const puts = Number(/first run: (\d+) PUT lines/.exec(setup)?.[1] ?? -1);
const unchanged = Number(/re-run: (\d+) '\(unchanged\)' lines/.exec(setup)?.[1] ?? -2);
const rerunOther = (setup.split(/re-run: .*\n/)[1] ?? "x").split("\n").filter(Boolean);
check("05 pi-setup: the first run PUTs every server, a re-run leaves each one (unchanged)", puts > 0 && puts === unchanged, `${puts} PUT, ${unchanged} unchanged`);
check("05 pi-setup: the re-run's other lines are all `ok …` (tools still disabled, the prompt still live)", rerunOther.length > 0 && rerunOther.every((l) => l.startsWith("ok ")), rerunOther.join(" | "));

// ---- 20-boot-checks.sh
const boot = read("A-boot-checks.log");
for (const [heading, want] of [
  ["/api/bootstrap (published port", 200],
  ["POST /mcp/repo from mcp-broker", 401],
  ["POST /mcp/repo from gateway", 403],
  ["POST /mcp/repo from the published port", 403],
  ["GET http://gateway:8080/v1/models with the mounted key", 200],
  ["same call without the key", 401],
]) {
  const got = statusIn(boot, heading);
  check(`20 boot checks: ${heading} → ${want}`, got === want, `HTTP ${got}`);
}

// ---- 04-fake-llm.sh
const llm = read("fake-llm-setup.log");
check("04 fake LLM: it answers its control plane and pi takes it as the LLM (PUT /admin/api/llm → 200)", llm.includes('"models":[{"id":"fake-model"') && llm.includes("PUT /admin/api/llm -> 200"), llm.split("\n").find((l) => l.startsWith("PUT ")) ?? "(no PUT line)");

// ---- 22-admin-proxy-extra.mjs: every forged or cross-site mutating call is a 403 csrf
const extra = read("B1-admin-proxy-extra.log").split("\n").filter(Boolean);
check("22 /admin proxy: all five cross-site / header-less mutating calls → 403 csrf", extra.length === 5 && extra.every((l) => l.startsWith("403 ") && l.includes('"code":"csrf"')), extra.map((l) => l.slice(0, 3)).join(" "));

// ---- 40-same-origin.sh
const origin = read("D-same-origin.log");
for (const [label, want] of [
  ["(i)   no Origin, no Sec-Fetch-Site", 200],
  ["(ii)  Origin = the address called", 200],
  ["(iii) Origin: https://evil.example", 403],
  ["(extra) Sec-Fetch-Site: cross-site, own Origin", 403],
  ["(extra) Sec-Fetch-Site: same-site, own Origin", 403],
  ["(extra) Sec-Fetch-Site: same-origin", 200],
  ["(extra) Sec-Fetch-Site: none", 200],
  ["PATCH /api/me, Origin evil", 403],
  ["PATCH /api/me, own Origin", 200],
  ["GET /api/bootstrap, Origin evil", 200],
  ["GET /api/me (session), Origin evil + Sec-Fetch-Site cross-site", 200],
  ["GET /api/conversations (session), Origin evil", 200],
  ["HEAD /api/bootstrap, Origin evil", 200],
  ["(iv)  Origin: https://evil.example, now trusted", 200],
  ["(iv+) Origin: https://evil.example + Sec-Fetch-Site: cross-site, trusted", 200],
  ["(iv control) Origin: https://other.example (not listed)", 403],
  ["(after removal) Origin: https://evil.example", 403],
  ["(after removal) no Origin", 200],
]) {
  const got = statusAfter(origin, label);
  check(`40 same-origin: ${label.replace(/\s+/g, " ")} → ${want}`, got === want, `HTTP ${got}`);
}
check("40 same-origin: Noah logged the refusals as warnings", (origin.match(/"level":40,"method":"POST","path":"\/api\/auth\/login"/g) ?? []).length >= 3);
check("40 same-origin: TRUSTED_ORIGINS reached the container and is gone again afterwards", origin.includes("in container: TRUSTED_ORIGINS=https://evil.example") && origin.includes("in container: TRUSTED_ORIGINS=[]"));

// ---- 60-security-check.sh: pi's own security check, twice, and what the sandboxes are
const sec = read("A-security-check.log");
check("60 security check: both runs exit 0 with `security-check: OK`", /run 1 exit=0\s+security-check: OK/.test(sec) && /run 2 exit=0\s+security-check: OK/.test(sec), sec.split("\n").filter((l) => /^run [12] /.test(l)).join(" | "));
const results = sec.split("\n").filter((l) => l.includes("결과:"));
check("60 security check: no FAIL, WARN or INVALID row in either report", results.length === 2 && results.every((l) => /FAIL 0, WARN 0, INVALID 0/.test(l)), results.map((l) => l.replace(/^.*— /, "")).join(" | "));
const sandboxes = (sec.split("== sandboxes now\n")[1] ?? "").split("\n").filter(Boolean);
check("60 security check: every sandbox is Noah's image with network none", sandboxes.length > 0 && sandboxes.every((l) => l.includes("noah-almighty/pi-sandbox:latest") && l.endsWith("network=none")), `${sandboxes.length} sandbox(es)`);
finish();
