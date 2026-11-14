#!/usr/bin/env node
// NOT in the default run (drive.sh): it waits up to an HOUR. Run it by hand, in the background, only when a
// bump changes pi's hourly marketplace refresh AND the user agreed to the wait — otherwise write "the hourly
// timer was not seen" in the bump note. It needs 88-plugin-refresh.mjs to have run in the same stack
// (`node 89-plugin-timer.mjs > ../evidence/Q-plugin-timer.log`), and the stack must stay up until it ends.
//
// Q — pi 08d35cb's hourly marketplace refresh, in the real gateway. pi's tests call refreshAll() directly and its
// commit says the timer itself was never watched running. 88-plugin-refresh.mjs left alpha 1.3.0 committed in the
// fixture repository and unfetched; this WAITS for the gateway's own first tick (one hour after it started) and
// looks at what happened with nobody pressing anything. Run it in the background: it sleeps until the tick.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { W, check, client, dind, fake, finish, loadState, turn } from "./e2e-common.mjs";

const GIT = "http://10.217.0.12:18093";
const NOAH_ORIGIN = "http://10.217.0.2:48787";
const state = loadState();
const timer = state.pluginTimer;
if (!timer) throw new Error("run 88-plugin-refresh.mjs first");
const admin = client(state.owner.cookie);
const PANEL = { origin: NOAH_ORIGIN, referer: `${NOAH_ORIGIN}/admin/`, "sec-fetch-site": "same-origin", "x-admin-request": "1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (path) => (await admin.request(`/admin/api${path}`, { headers: PANEL })).json();
const plugins = async () => Object.fromEntries(((await get("/plugins")).plugins ?? []).map((p) => [p.id, p]));
const fixture = async () => (await fetch(`${GIT}/_state`)).json();
const inspect = (format) => dind("docker", "inspect", "-f", format, "noah-almighty-gateway-1").trim();
const brief = (p) => (p ? `${p.id} v${p.version}${p.update ? ` (update → ${p.update.version})` : ""}` : "(none)");

const startedAt = inspect("{{.State.StartedAt}}");
const due = Date.parse(startedAt) + 3_600_000;
check("Q  the gateway has not restarted since 88 left the version pending", startedAt === timer.gatewayStartedAt, `${startedAt} vs ${timer.gatewayStartedAt}`);
console.log(`  gateway started ${startedAt}; the tick is due about ${new Date(due).toISOString()} (now ${new Date().toISOString()})`);

// ---- before the tick: nothing has moved on its own
if (Date.now() < due - 60_000) {
  const now = await plugins();
  const fx = await fixture();
  check("Q  before the tick: alpha is still v1.2.0 and nobody fetched the repository since 88", now["alpha@bootmk"]?.version === "1.2.0" && fx.fetches.length === timer.fetches, `${brief(now["alpha@bootmk"])}; fetches ${fx.fetches.length} (was ${timer.fetches})`);
  await sleep(due - 60_000 - Date.now());
  const late = await fixture();
  check("Q  one minute before the hour is up there is still no fetch", late.fetches.length === timer.fetches, `fetches ${late.fetches.length}`);
} else {
  console.log("  (started after the tick was due: the before-the-tick checks are skipped)");
}

// ---- the tick: wait for the fixture to be fetched (up to 4 minutes past the hour)
let fx = await fixture();
while (fx.fetches.length === timer.fetches && Date.now() < due + 240_000) {
  await sleep(5_000);
  fx = await fixture();
}
const fresh = fx.fetches.slice(timer.fetches);
const offset = fresh.length ? (Date.parse(fresh[0]) - due) / 1000 : null;
check("Q  the gateway fetched the marketplace by itself, one hour after it started", fresh.length >= 1 && offset >= 0 && offset <= 120, fresh.length ? `first fetch ${fresh[0]} = container start + 3600 s + ${offset.toFixed(1)} s; ${fresh.length} upload-pack request(s)` : "no fetch within 4 minutes of the hour");
await sleep(20_000); // the install that follows the fetch

const now = await plugins();
const market = (await get("/marketplaces")).marketplaces?.find((m) => m.name === "bootmk");
check("Q  alpha is v1.3.0 — updated with nobody pressing anything", now["alpha@bootmk"]?.version === "1.3.0" && !now["alpha@bootmk"]?.update, brief(now["alpha@bootmk"]));
check("Q  the marketplace record is at the repository's HEAD, refreshed at the tick", market?.commitSha === timer.pendingHead && Math.abs(Date.parse(market.refreshedAt) - due) < 180_000, `${market?.commitSha?.slice(0, 7)} refreshed ${market?.refreshedAt}`);
check("Q  beta (unreadable plugin.json) is still the installed v1.0.0, still marked as having an update", now["beta@bootmk"]?.version === "1.0.0" && Boolean(now["beta@bootmk"]?.update), brief(now["beta@bootmk"]));

const audit = (await (await admin.get("/api/audit")).json()).audit ?? [];
const pressed = audit.filter((e) => e.action === "pi_admin_proxy" && /^POST \/admin\/api\/(marketplaces|plugins)/.test(e.detail) && Date.parse(e.createdAt ?? e.created_at ?? e.at ?? 0) > Date.parse(timer.pendingSetAt));
check("Q  Noah's audit log has no refresh or plugin write after the version was left pending (it was not a person)", pressed.length === 0, pressed.map((e) => e.detail).join(" | ") || `0 rows after ${timer.pendingSetAt}`);

// ---- what the gateway logged for an update nobody watched
const log = dind("docker", "logs", "--since", new Date(due - 30_000).toISOString(), "noah-almighty-gateway-1");
writeFileSync(`${W}/evidence/Q-gateway-log-at-tick.log`, log);
const entries = log.split("\n").flatMap((line) => {
  const at = line.indexOf("{");
  if (at < 0) return [];
  try {
    return [JSON.parse(line.slice(at))];
  } catch {
    return [];
  }
});
const refreshed = entries.find((e) => e.msg === "marketplace refreshed" && e.marketplace === "bootmk");
const installed = entries.find((e) => e.msg === "plugin installed" && e.plugin === "alpha@bootmk");
const warned = entries.find((e) => e.msg === "marketplace refresh had warnings" && e.marketplace === "bootmk");
check("Q  the gateway's log has the refresh and alpha's install at the tick", Boolean(refreshed) && installed?.version === "1.3.0", JSON.stringify({ refreshed: refreshed?.commit?.slice(0, 7), installed: installed?.version }));
check("Q  …and ONE warn line naming the plugin it could not install — the only place that failure shows", warned?.level === 40 && JSON.stringify(warned.warnings ?? []).includes("beta@bootmk"), JSON.stringify(warned ?? null).slice(0, 300));
check("Q  the gateway is still the same healthy container (no restart)", inspect("{{.State.StartedAt}} {{.RestartCount}} {{.State.Health.Status}}") === `${startedAt} 0 healthy`, inspect("{{.State.StartedAt}} {{.RestartCount}} {{.State.Health.Status}}"));

// ---- a conversation started after the tick
const key = `plugtimer-${Date.now().toString(36)}`;
const t = await turn(admin, { avatarId: state.owner.id, conversationId: randomUUID(), message: `안녕 (tick) [[fake:${key}]]` });
const body = JSON.stringify((await fake.requests(key)).at(-1)?.body ?? {});
const markers = [...new Set(body.match(/BOOTMK-[a-z]+-\d+\.\d+\.\d+/g) ?? [])].sort().join(" ");
check("Q  a conversation started after the tick is told alpha 1.3.0", t.status === 200 && t.of("done").length === 1 && markers === "BOOTMK-alpha-1.3.0 BOOTMK-beta-1.0.0", markers || "(no marker)");
finish();
