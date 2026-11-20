#!/usr/bin/env node
// J — the memory service's HISTORY through the stack (pi-gateway 2759ae2, 2026-11-20): every change of a wiki is
// one commit in a local git repository inside the service's volume, and nothing is pushed anywhere. pi's own tests
// ran the store in a temp directory with the developer's git. This looks at what only the stack has: the git of the
// memory IMAGE under the stack's hardening (read-only rootfs, uid 10002, no capability), driven by the requests
// Noah's client makes from INSIDE Noah's container with Noah's key.
//   - NOT seen here: a moved owner's tools writing through Noah (nobody is moved in this stack — no knowledge
//     repository exists), a commit that fails, and the first commit of a wiki with thousands of notes.
import { createHash } from "node:crypto";
import { check, dind, dindTry, finish } from "./e2e-common.mjs";

const NOAH_C = "noah-almighty-noah-almighty-1";
const MEMORY_C = "noah-almighty-memory-1";
const RUN = Date.now().toString(36);
const OWNER = `histcheck-${RUN}`;
const OLD_OWNER = `histold-${RUN}`;
const wikiDir = (owner) => `/data/wikis/u-${createHash("sha256").update(owner).digest("hex").slice(0, 24)}`;
const note = (label, text) => {
  console.log(`  ${label}: ${String(text).split("\n").join("\n    ")}`);
};
/** git inside the memory container, as the service's own user, on one wiki's repository. */
const git = (owner, ...args) => dindTry("docker", "exec", MEMORY_C, "git", `--git-dir=${wikiDir(owner)}/.git`, ...args);
const inMemory = (command) => dindTry("docker", "exec", MEMORY_C, "sh", "-c", command);

const version = dindTry("docker", "exec", MEMORY_C, "git", "--version");
note("git in the memory image", version.out.trim());
check("J  the memory image has git", version.ok && /^git version \d/.test(version.out.trim()), version.out.trim().slice(0, 200));

// A note that was in the volume BEFORE the wiki had a history (every wiki of an existing deployment is one).
const placed = inMemory(`mkdir -p ${wikiDir(OLD_OWNER)}/wiki && printf before > ${wikiDir(OLD_OWNER)}/wiki/old.md && ls -a ${wikiDir(OLD_OWNER)}`);
note("a note placed in the volume before any history", placed.out.trim());
check("J  a wiki without a history was put in the volume (no .git yet)", placed.ok && !placed.out.includes(".git"), placed.out.trim());

// The requests Noah's client makes, from Noah's container with Noah's env and key file. One JSON line per step.
const script = `
const fs = require("node:fs");
const base = process.env.PI_MEMORY_URL, key = fs.readFileSync(process.env.PI_MEMORY_API_KEY_FILE, "utf8").trim();
const [owner, oldOwner] = process.argv.slice(1);
const call = async (label, method, path, body) => {
  const started = Date.now();
  const res = await fetch(base + path, { method, headers: { authorization: "Bearer " + key, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
  console.log(JSON.stringify([label, res.status, json, Date.now() - started]));
  return json;
};
const q = (o) => new URLSearchParams(o).toString();
(async () => {
  const W = "/wiki/" + encodeURIComponent(owner), O = "/wiki/" + encodeURIComponent(oldOwner);
  const made = await call("create", "PUT", W + "/note", { path: "wiki/개념/배포.md", content: "금요일에는 배포하지 않는다" });
  await call("claude-md", "PUT", W + "/note", { path: "CLAUDE.md", content: "standing memory" });
  const replaced = await call("replace", "PUT", W + "/note", { path: "wiki/개념/배포.md", content: "목요일까지만", hash: made.hash });
  const same = await call("replace-same", "PUT", W + "/note", { path: "wiki/개념/배포.md", content: "목요일까지만", hash: replaced.hash });
  await call("list", "GET", W + "/notes");
  await call("delete", "DELETE", W + "/note?" + q({ path: "wiki/개념/배포.md", hash: same.hash }));
  const old = await call("old-read", "GET", O + "/note?" + q({ path: "wiki/old.md" }));
  await call("old-replace", "PUT", O + "/note", { path: "wiki/old.md", content: "after", hash: old.hash });
})().catch((e) => { console.log(JSON.stringify(["CRASH", 0, String(e), 0])); process.exit(1); });
`;
const ran = dindTry("docker", "exec", NOAH_C, "node", "-e", script, OWNER, OLD_OWNER);
note("service answers (from Noah's container; the last number is ms)", ran.out.trim());
const steps = Object.fromEntries(ran.out.trim().split("\n").filter((l) => l.startsWith("[")).map((l) => JSON.parse(l)).map(([label, status, body, ms]) => [label, { status, body, ms }]));
const ok = (label) => steps[label]?.status === 200;
check("J  every change Noah's client sent was answered 200", ran.ok && ["create", "claude-md", "replace", "replace-same", "delete", "old-read", "old-replace"].every(ok), ran.ok ? Object.entries(steps).map(([k, v]) => `${k}=${v.status}`).join(" ") : ran.out.slice(-300));
check("J  the listing shows the notes and nothing of the repository", ok("list") && steps.list.body.notes.map((n) => n.path).join("|") === "CLAUDE.md|wiki/개념/배포.md", JSON.stringify(steps.list?.body).slice(0, 200));
console.log(`  (recorded, not judged) ms per change with its commit: ${["create", "claude-md", "replace", "replace-same", "delete", "old-replace"].map((k) => `${k}=${steps[k]?.ms}`).join(" ")}`);

// ---------------------------------------------------------------------------------------------- what the repository holds
const log = git(OWNER, "log", "--reverse", "--format=%s|%an|%ae");
note("history of the new wiki (oldest first)", log.out.trim());
const expected = ["create wiki/개념/배포.md", "create CLAUDE.md", "replace wiki/개념/배포.md", "delete wiki/개념/배포.md"].map((s) => `${s}|${OWNER}|memory@pi-gateway.invalid`);
check("J  one commit per change, named by what changed and by the wiki's owner — and none for a rewrite with the same text", log.ok && log.out.trim() === expected.join("\n"), log.out.trim().slice(0, 400));
const before = git(OWNER, "show", "HEAD~1:wiki/개념/배포.md");
check("J  the text a note had before it was deleted is still in the history", before.ok && before.out === "목요일까지만", before.out.slice(0, 100));
const first = git(OWNER, "show", "HEAD~3:wiki/개념/배포.md");
check("J  and so is its first text", first.ok && first.out === "금요일에는 배포하지 않는다", first.out.slice(0, 100));
const remotes = git(OWNER, "remote", "-v");
check("J  the repository has no remote (nothing is pushed anywhere)", remotes.ok && remotes.out.trim() === "", remotes.out.trim());
const dirty = git(OWNER, `--work-tree=${wikiDir(OWNER)}`, "status", "--porcelain");
check("J  nothing in the wiki is left uncommitted", dirty.ok && dirty.out.trim() === "", dirty.out.trim().slice(0, 200));
const hooks = inMemory(`ls -a ${wikiDir(OWNER)}/.git | tr '\\n' ' '; stat -c '%u %a' ${wikiDir(OWNER)}/.git`);
note("the repository folder", hooks.out.trim());
check("J  the repository is the service's own (uid 10002, 0700) and was made without git's sample hooks", hooks.ok && / 10002 700$/.test(hooks.out.trimEnd()) && !/\bhooks\b/.test(hooks.out), hooks.out.trim().slice(0, 300));

const oldLog = git(OLD_OWNER, "log", "--reverse", "--format=%s");
note("history of the wiki that had a note before", oldLog.out.trim());
check("J  a note from before the history is committed FIRST, on its own, then the change", oldLog.ok && oldLog.out.trim() === ["notes from before history began", "replace wiki/old.md"].join("\n"), oldLog.out.trim().slice(0, 300));
const oldBefore = git(OLD_OWNER, "show", "HEAD~1:wiki/old.md");
check("J  so the text it had before its first change can be read back", oldBefore.ok && oldBefore.out === "before", oldBefore.out.slice(0, 100));

// ---------------------------------------------------------------------------------------------- deleting a wiki
const wipe = dindTry(
  "docker", "exec", NOAH_C, "node", "-e",
  `const fs = require("node:fs"); const key = fs.readFileSync(process.env.PI_MEMORY_API_KEY_FILE, "utf8").trim();
   (async () => { for (const o of process.argv.slice(1)) { const r = await fetch(process.env.PI_MEMORY_URL + "/wiki/" + encodeURIComponent(o), { method: "DELETE", headers: { authorization: "Bearer " + key } }); console.log(o + " " + r.status); } })();`,
  OWNER, OLD_OWNER,
);
const gone = inMemory(`for d in ${wikiDir(OWNER)} ${wikiDir(OLD_OWNER)}; do test -e $d && echo "still there: $d"; done; echo checked`);
note("after deleting both wikis", `${wipe.out.trim()}\n${gone.out.trim()}`);
check("J  deleting a wiki removes its history with it", wipe.ok && wipe.out.trim().split("\n").every((l) => l.endsWith(" 200")) && gone.out.trim() === "checked", `${wipe.out.trim()} | ${gone.out.trim()}`);

// ---------------------------------------------------------------------------------------------- logs
const serviceLog = dindTry("sh", "-c", `docker logs ${MEMORY_C} 2>&1`);
check("J  the memory service logged no error during these changes", serviceLog.ok && !/"level":(50|60)/.test(serviceLog.out), serviceLog.out.trim().split("\n").slice(-3).join(" | ").slice(0, 400));

finish();
