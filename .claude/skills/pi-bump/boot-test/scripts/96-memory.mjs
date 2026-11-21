#!/usr/bin/env node
// M — pi's memory service THROUGH the stack (pi-gateway e0e5b8c, 2026-11-17; noah#84). pi's own commits ran the
// service only as a single container and against a broker in tests; Noah's tests ran against an in-process fake.
// This looks at the pieces only a real stack has: the service container under the stack's hardening, the
// `noah-memory` network and what Noah can and cannot reach, Noah's own copy of the key, and the service's real
// answers to the requests Noah's client makes (from INSIDE Noah's container, with Noah's env and key file).
//   - no knowledge repository exists in this stack, so nobody has a brain set up: the avatar's tools writing a
//     vault note through Noah and the one-time repository import are NOT exercised — they rest on Noah's tests.
import { check, client, dind, dindTry, finish, loadState } from "./e2e-common.mjs";

const state = loadState();
const admin = client(state.owner.cookie);
const member = client(state.second.cookie);
const NOAH_C = "noah-almighty-noah-almighty-1";
const MEMORY_C = "noah-almighty-memory-1";
const RUN = Date.now().toString(36);
const OWNER = `bootcheck-${RUN}`;
const note = (label, text) => {
  console.log(`  ${label}: ${String(text).split("\n").join("\n    ")}`);
};
const inspect = (name, format) => dind("docker", "inspect", "-f", format, name).trim();
const NETWORKS = "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}";

// ---------------------------------------------------------------------------------------------- the container
const shape = inspect(MEMORY_C, "{{.State.Health.Status}} user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} ports={{.HostConfig.PortBindings}}");
note("memory container", shape);
check("M  the memory service runs healthy as uid 10002, read-only rootfs, no capability, no published port", /^healthy user=10002:10002 readonly=true capdrop=\[ALL\] ports=map\[\]$/.test(shape), shape);
const memoryNets = inspect(MEMORY_C, NETWORKS).split(" ").filter(Boolean).sort();
const noahNets = inspect(NOAH_C, NETWORKS).split(" ").filter(Boolean).sort();
note("networks", `memory: ${memoryNets.join(", ")}\nnoah:   ${noahNets.join(", ")}`);
check("M  the service is on pi's internal network and noah-memory only", memoryNets.length === 2 && memoryNets.some((n) => n.endsWith("_control")) && memoryNets.some((n) => n.endsWith("_noah-memory")), memoryNets.join(", "));
check("M  Noah is on noah-memory and NOT on pi's internal network", noahNets.some((n) => n.endsWith("_noah-memory")) && !noahNets.some((n) => n.endsWith("_control")), noahNets.join(", "));
const members = dind("docker", "network", "inspect", "-f", "{{range .Containers}}{{.Name}} {{end}}", memoryNets.find((n) => n.endsWith("_noah-memory"))).trim().split(" ").filter(Boolean).sort();
check("M  noah-memory holds exactly Noah and the memory service", members.join(",") === [MEMORY_C, NOAH_C].sort().join(","), members.join(", "));

// ---------------------------------------------------------------------------------------------- Noah's side
const env = dind("docker", "exec", NOAH_C, "sh", "-c", 'echo "url=$PI_MEMORY_URL file=$PI_MEMORY_API_KEY_FILE inline=${PI_MEMORY_API_KEY:-unset}"; stat -c "%u %a" "$PI_MEMORY_API_KEY_FILE"; wc -c < "$PI_MEMORY_API_KEY_FILE"').trim();
note("Noah's env and key copy (never the value)", env);
check("M  Noah has the service's address and its OWN 0400 copy of the key (uid 1000), never inline", /^url=http:\/\/memory:7090 file=\/run\/secrets\/pi_memory_api_key_noah inline=unset\n1000 400\n\d\d+$/.test(env), env.split("\n").join(" | "));

// What Noah's process can reach. The memory network adds the service and nothing else: sandboxd has no name
// here. The broker answers because Noah and the broker already share `noah-mcp` (the broker calls Noah's /mcp
// from there) — that is older than this change; its admin plane wants a token Noah does not hold.
const reach = dind(
  "docker", "exec", NOAH_C, "node", "-e",
  `const probe = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(4000) }); return "HTTP " + r.status; } catch (e) { return "no: " + (e.cause?.code ?? e.name); } };
   (async () => { for (const u of ["http://memory:7090/healthz", "http://gateway:8080/healthz", "http://sandboxd:7070/healthz", "http://mcp-broker:7080/healthz", "http://mcp-broker:7081/healthz"]) console.log(u + " -> " + await probe(u)); })();`,
).trim();
note("reach from Noah's container", reach);
const reached = Object.fromEntries(reach.split("\n").map((l) => l.split(" -> ")));
check("M  from Noah: the memory service and the gateway answer", reached["http://memory:7090/healthz"] === "HTTP 200" && reached["http://gateway:8080/healthz"] === "HTTP 200");
check("M  from Noah: sandboxd is NOT reachable (no name for it on any of Noah's networks)", (reached["http://sandboxd:7070/healthz"] ?? "").startsWith("no: "), reached["http://sandboxd:7070/healthz"]);
check("M  from Noah: the broker's admin plane refuses a request without its token (401)", reached["http://mcp-broker:7081/healthz"] === "HTTP 401", reached["http://mcp-broker:7081/healthz"]);
console.log(`  (recorded, not judged) the broker's data plane from Noah over noah-mcp: ${reached["http://mcp-broker:7080/healthz"]}`);
// The service itself is on no network a sandbox or the broker's callers could use to get to it by another way.
const brokerNets = inspect("noah-almighty-mcp-broker-1", NETWORKS).split(" ").filter(Boolean).sort();
check("M  the broker is NOT on noah-memory", brokerNets.length > 0 && !brokerNets.some((n) => n.endsWith("_noah-memory")), brokerNets.join(", "));

// ---------------------------------------------------------------------------------------------- the service's answers
// The requests Noah's client makes (src/server/memory/memoryClient.ts), sent from Noah's container with Noah's
// env and key file, for a throwaway owner id. One JSON line per step: [label, status, body].
const script = `
const fs = require("node:fs");
const base = process.env.PI_MEMORY_URL, key = fs.readFileSync(process.env.PI_MEMORY_API_KEY_FILE, "utf8").trim();
const owner = process.argv[1];
const call = async (label, method, path, body, auth = true) => {
  const res = await fetch(base + path, { method, headers: { ...(auth ? { authorization: "Bearer " + key } : {}), ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
  console.log(JSON.stringify([label, res.status, json]));
  return json;
};
const q = (o) => new URLSearchParams(o).toString();
(async () => {
  const W = "/wiki/" + encodeURIComponent(owner);
  await call("no-key", "GET", W + "/notes", null, false);
  await call("list-empty-wiki", "GET", W + "/notes");
  await call("list-missing-folder", "GET", W + "/notes?prefix=raw");
  await call("search-empty-wiki", "GET", W + "/search?" + q({ q: "배포", prefix: "wiki" }));
  await call("read-missing", "GET", W + "/note?" + q({ path: "wiki/none.md" }));
  const made = await call("create", "PUT", W + "/note", { path: "wiki/개념/배포.md", content: "---\\ntitle: 배포\\ntags: [ops]\\n---\\n금요일에는 배포하지 않는다" });
  await call("create-again", "PUT", W + "/note", { path: "wiki/개념/배포.md", content: "x" });
  await call("claude-md", "PUT", W + "/note", { path: "CLAUDE.md", content: "standing memory" });
  await call("read", "GET", W + "/note?" + q({ path: "wiki/개념/배포.md" }));
  await call("list", "GET", W + "/notes");
  await call("list-prefix", "GET", W + "/notes?prefix=wiki");
  await call("search", "GET", W + "/search?" + q({ q: "배포", limit: "5", prefix: "wiki" }));
  const replaced = await call("replace", "PUT", W + "/note", { path: "wiki/개념/배포.md", content: "목요일까지만", hash: made.hash });
  await call("replace-stale", "PUT", W + "/note", { path: "wiki/개념/배포.md", content: "y", hash: made.hash });
  await call("bad-path", "PUT", W + "/note", { path: "wiki/.obsidian/x.md", content: "x" });
  await call("delete-stale", "DELETE", W + "/note?" + q({ path: "wiki/개념/배포.md", hash: made.hash }));
  await call("delete", "DELETE", W + "/note?" + q({ path: "wiki/개념/배포.md", hash: replaced.hash }));
  await call("delete-again", "DELETE", W + "/note?" + q({ path: "wiki/개념/배포.md", hash: replaced.hash }));
  await call("no-route", "GET", W + "/nope");
  await call("delete-wiki", "DELETE", W);
  await call("list-after-delete", "GET", W + "/notes");
})().catch((e) => { console.log(JSON.stringify(["CRASH", 0, String(e)])); process.exit(1); });
`;
const ran = dindTry("docker", "exec", NOAH_C, "node", "-e", script, OWNER);
note("service answers (from Noah's container)", ran.out.trim());
const steps = Object.fromEntries(ran.out.trim().split("\n").filter((l) => l.startsWith("[")).map((l) => JSON.parse(l)).map(([label, status, body]) => [label, { status, body }]));
const is = (label, status, pred = () => true) => steps[label]?.status === status && pred(steps[label].body);
const code = (label) => steps[label]?.body?.error?.code;
check("M  the script ran to its end", ran.ok && Boolean(steps["list-after-delete"]), ran.ok ? "" : ran.out.slice(-300));
check("M  without the key: 401 unauthorized", is("no-key", 401) && code("no-key") === "unauthorized");
check("M  an owner with no wiki lists as empty — also under a folder that does not exist (200, never 404)", is("list-empty-wiki", 200, (b) => Array.isArray(b.notes) && b.notes.length === 0) && is("list-missing-folder", 200, (b) => Array.isArray(b.notes) && b.notes.length === 0));
check("M  a search of an empty wiki answers no hits, not an error", is("search-empty-wiki", 200, (b) => Array.isArray(b.hits) && b.hits.length === 0 && b.unscanned === 0));
check("M  a missing note is 404 not_found, a missing route 404 no_route", is("read-missing", 404) && code("read-missing") === "not_found" && is("no-route", 404) && code("no-route") === "no_route");
check("M  create returns the path and a sha256 hash; creating again is 409 exists", is("create", 200, (b) => b.created === true && b.path === "wiki/개념/배포.md" && /^[0-9a-f]{64}$/.test(b.hash)) && is("create-again", 409) && code("create-again") === "exists");
check("M  read returns the whole note and the same hash", is("read", 200, (b) => b.content.endsWith("금요일에는 배포하지 않는다") && b.hash === steps.create.body.hash));
check("M  list is in path order (CLAUDE.md before wiki/), a folder prefix narrows it", is("list", 200, (b) => b.notes.map((n) => n.path).join("|") === "CLAUDE.md|wiki/개념/배포.md") && is("list-prefix", 200, (b) => b.notes.length === 1 && b.notes[0].path === "wiki/개념/배포.md"));
check("M  search finds the note by its title/tag/body", is("search", 200, (b) => b.hits.length === 1 && b.hits[0].path === "wiki/개념/배포.md" && b.hits[0].title === "배포" && b.hits[0].tags.join() === "ops"));
check("M  replace needs the current hash: the stale one is 409 stale", is("replace", 200, (b) => b.created === false) && is("replace-stale", 409) && code("replace-stale") === "stale");
check("M  a path the service cannot store is 400 invalid_path", is("bad-path", 400) && code("bad-path") === "invalid_path");
check("M  delete needs the current hash; deleting a note that is gone is 404 not_found", is("delete-stale", 409) && code("delete-stale") === "stale" && is("delete", 200) && is("delete-again", 404) && code("delete-again") === "not_found");
check("M  deleting the whole wiki leaves nothing", is("delete-wiki", 200, (b) => b.deleted === true) && is("list-after-delete", 200, (b) => b.notes.length === 0));

// ---------------------------------------------------------------------------------------------- Noah's routes
// The vault has ONE home (the memory service) since 2026-11-20: the migration routes are gone, what is left is
// how full each brain is (admins) and whether the service answers (everybody).
const view = await admin.get("/api/admin/personal-vaults/usage");
const body = await view.json().catch(() => null);
note("GET /api/admin/personal-vaults/usage (admin)", JSON.stringify(body).slice(0, 600));
check("M  Noah's admin usage view: the service is configured, its limits are named, and nobody is listed (no account has a repository)", view.status === 200 && body?.serviceConfigured === true && body?.limits?.notes === 10000 && body?.limits?.bytes === 256 * 1024 * 1024 && Array.isArray(body?.owners) && body.owners.length === 0, JSON.stringify(body).slice(0, 300));
const denied = await member.get("/api/admin/personal-vaults/usage");
check("M  a member is refused the admin view", denied.status === 403, `status ${denied.status}`);
const mine = await member.get("/api/me/personal-vault");
const mineBody = await mine.json().catch(() => null);
check("M  a member's own view: the service is configured and answers", mine.status === 200 && mineBody?.serviceConfigured === true && mineBody?.service === "ok", JSON.stringify(mineBody));
const retired = await admin.post("/api/admin/personal-vaults/dry-run");
check("M  the retired migration route is gone (not a 200)", retired.status === 404, `status ${retired.status}`);

// ---------------------------------------------------------------------------------------------- not one of pi's MCP servers
const servers = await admin.get("/admin/api/mcp/servers");
const serversBody = await servers.json().catch(() => null);
const ids = (serversBody?.servers ?? serversBody ?? []).map((s) => s.id ?? s.config?.id).filter(Boolean);
note("pi's broker servers (through Noah's /admin proxy)", ids.join(", "));
check("M  the memory service is NOT registered in pi's broker (no session gets a second set of memory tools)", servers.status === 200 && ids.length > 0 && !ids.includes("memory"), `${ids.length} servers`);

// ---------------------------------------------------------------------------------------------- logs
const noahLog = dindTry("docker", "logs", NOAH_C);
const memoryWarn = noahLog.out.split("\n").filter((l) => l.includes('"module":"memory"') || /vault import|personal vault/i.test(l));
note("Noah log lines about the memory service", memoryWarn.length ? memoryWarn.join("\n").slice(0, 1500) : "(none)");
check("M  Noah's log has no failure line about the memory service or the vault import", !memoryWarn.some((l) => /"level":(40|50|60)/.test(l)), `${memoryWarn.length} line(s)`);
const serviceLog = dindTry("docker", "logs", MEMORY_C);
note("memory service log (tail)", serviceLog.out.trim().split("\n").slice(-6).join("\n"));
check("M  the memory service logged no error", !/"level":(50|60)/.test(serviceLog.out));

finish();
