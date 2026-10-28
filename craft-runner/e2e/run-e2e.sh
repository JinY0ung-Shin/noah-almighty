#!/usr/bin/env bash
# Real end-to-end test of craft-runner with the actual PhotoCraft binary. EVERY container here runs with
# --network none; the downloaded binary never runs anywhere else.
#
#   docker build -f craft-runner/Dockerfile -t noah-craft-runner:e2e .     # build (network: download only)
#   craft-runner/e2e/run-e2e.sh [image]                                    # this script
#
# 1. starts the runner with the docker-compose.yml hardening flags and a throwaway exchange volume,
# 2. acts as Noah from a SECOND network-none container (uid 1000, volume at /x) — noah-client.mjs setup,
# 3. checks process credentials and cross-session file isolation with `docker exec --user <session uid>`,
# 4. revokes + purges (noah-client.mjs teardown), then removes the containers and the volume.
set -euo pipefail

IMAGE="${1:-noah-craft-runner:e2e}"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$HERE/../src" && pwd)"
RUN_ID="craft-e2e-$$"
VOL="${RUN_ID}-exchange"
RUNNER="${RUN_ID}-runner"
SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
TOKEN_A="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
TOKEN_B="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
FAIL=0

cleanup() {
  docker rm -f "$RUNNER" >/dev/null 2>&1 || true
  docker volume rm -f "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ok() { echo "E2E ok   $*"; }
bad() { echo "E2E FAIL $*"; FAIL=1; }

docker volume create "$VOL" >/dev/null
# Same flags as the craft-runner service in docker-compose.yml.
docker run -d --name "$RUNNER" \
  --network none --read-only --tmpfs /tmp:size=1g,mode=0711 \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --cap-add KILL \
  --security-opt no-new-privileges:true --memory 8g --cpus 4 --pids-limit 512 --init \
  -e CRAFT_CONTROL_SECRET="$SECRET" -e CRAFT_MAX_PROCS=3 \
  -v "$VOL:/exchange" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if docker logs "$RUNNER" 2>&1 | grep -q "listening on"; then break; fi
  sleep 0.5
done
echo "--- runner boot log"
docker logs "$RUNNER" 2>&1 | sed 's/^/    /'

client() {
  docker run --rm --network none --read-only --tmpfs /tmp --user 1000:1000 \
    --cap-drop ALL --security-opt no-new-privileges:true \
    -e SECRET="$SECRET" -e TOKEN_A="$TOKEN_A" -e TOKEN_B="$TOKEN_B" -e X=/x \
    -v "$VOL:/x" -v "$HERE:/e2e:ro" -v "$SRC:/runner-src:ro" \
    node:22-bookworm-slim node /e2e/noah-client.mjs "$1"
}

echo "--- noah-client setup"
client setup || FAIL=1

echo "--- process credentials + cross-session isolation (docker exec in the runner)"
UIDS="$(docker exec "$RUNNER" cat /exchange/state/uids.json)"
echo "    uids.json: $UIDS"
read -r SID_A SID_B <<<"$(docker exec -e TA="$TOKEN_A" "$RUNNER" node -e '
  const c = require("crypto"); const s = (x) => c.createHash("sha256").update("noah-craft:" + x).digest("hex").slice(0, 32);
  console.log(s("e2e-conversation-A"), s("e2e-conversation-B"));')"
UID_A="$(docker exec "$RUNNER" node -e "console.log(JSON.parse(require('fs').readFileSync('/exchange/state/uids.json','utf8')).sessions['$SID_A'])")"
UID_B="$(docker exec "$RUNNER" node -e "console.log(JSON.parse(require('fs').readFileSync('/exchange/state/uids.json','utf8')).sessions['$SID_B'])")"
echo "    session A sid=$SID_A uid=$UID_A; session B sid=$SID_B uid=$UID_B"
[ "$UID_A" != "$UID_B" ] && ok "distinct session uids" || bad "session uids collide"

STATUS="$(docker exec "$RUNNER" node -e '
  const fs = require("fs");
  for (const p of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let cmd = ""; try { cmd = fs.readFileSync(`/proc/${p}/cmdline`, "utf8"); } catch { continue; }
    if (!cmd.startsWith("/opt/craft/bin/photocraft-cli")) continue;
    const st = fs.readFileSync(`/proc/${p}/status`, "utf8");
    const pick = (k) => ((st.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m")) || [])[1] ?? "").replace(/\t/g, " ").trim();
    console.log(JSON.stringify({ pid: p, argv: cmd.split("\0").filter(Boolean), Uid: pick("Uid"), Gid: pick("Gid"), Groups: pick("Groups"),
      CapEff: pick("CapEff"), CapPrm: pick("CapPrm"), CapBnd: pick("CapBnd"), NoNewPrivs: pick("NoNewPrivs"),
      oom: fs.readFileSync(`/proc/${p}/oom_score_adj`, "utf8").trim() }));
  }')"
echo "    live app processes: $STATUS"
echo "$STATUS" | grep -q "\"Uid\":\"$UID_A $UID_A $UID_A $UID_A\"" && ok "child runs as session uid $UID_A (real/eff/saved/fs)" || bad "child uid"
echo "$STATUS" | grep -q '"Groups":"",' && ok "child has no supplementary groups" || bad "child groups"
echo "$STATUS" | grep -q '"CapEff":"0000000000000000"' && ok "child effective caps = 0" || bad "child CapEff"
echo "$STATUS" | grep -q '"CapPrm":"0000000000000000"' && ok "child permitted caps = 0" || bad "child CapPrm"
echo "$STATUS" | grep -q '"NoNewPrivs":"1"' && ok "child no_new_privs" || bad "child NoNewPrivs"
echo "$STATUS" | grep -q -- '--automation-write-root","/exchange/work/'"$SID_A"'/out' && ok "child argv has both roots" || bad "child argv"

as_uid() { local u="$1"; shift; docker exec --user "$u:$u" "$RUNNER" "$@" >/dev/null 2>&1; }
as_uid "$UID_A" cat "/exchange/work/$SID_A/in/attachments/test.png" && ok "A reads its own in/ (control)" || bad "A cannot read its own in/"
as_uid "$UID_A" ls "/exchange/work/$SID_B" && bad "A listed B's work dir" || ok "A cannot list B's work dir"
as_uid "$UID_A" cat "/exchange/work/$SID_B/in/attachments/secret.png" && bad "A read B's input" || ok "A cannot read B's work/in"
as_uid "$UID_A" cat "/exchange/inbox/$SID_A/attachments/test.png" && bad "A read the inbox" || ok "A cannot read even its own inbox"
as_uid "$UID_A" cat "/exchange/inbox/$SID_B/attachments/secret.png" && bad "A read B's inbox" || ok "A cannot read B's inbox"
as_uid "$UID_A" cat "/exchange/outbox/$SID_A/result.png" && bad "A read the outbox" || ok "A cannot read the outbox"
as_uid "$UID_A" cat /exchange/state/uids.json && bad "A read runner state" || ok "A cannot read runner state"
as_uid "$UID_A" ls /exchange/sock && bad "A listed the socket dir" || ok "A cannot reach the sockets"
as_uid "$UID_A" touch "/exchange/work/$SID_A/in/planted" && bad "A wrote into in/" || ok "A cannot modify in/ (root-owned)"
as_uid "$UID_A" touch /tmp/planted && bad "A wrote to shared /tmp" || ok "A cannot write the shared /tmp"
as_uid "$UID_B" ls "/exchange/work/$SID_A/out" && bad "B listed A's out/" || ok "B cannot list A's out/"

# A process of session uid A OUTSIDE the app's process group (as if the app had setsid()'d a helper):
# purge must SIGKILL every process of the uid before the uid returns to the pool (Addendum A3).
docker exec -d --user "$UID_A:$UID_A" "$RUNNER" setsid sleep 3600
sleep 0.5
uid_procs() { docker exec "$RUNNER" node -e '
  const fs = require("fs"); let n = 0;
  for (const p of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    let st = ""; try { st = fs.readFileSync(`/proc/${p}/status`, "utf8"); } catch { continue; }
    const u = (st.match(/^Uid:\s+(\d+)/m) || [])[1]; const s = (st.match(/^State:\s+(\S)/m) || [])[1];
    if (u === process.argv[1] && s !== "Z") n += 1;
  }
  console.log(n);' "$1"; }
[ "$(uid_procs "$UID_A")" -ge 2 ] && ok "stray setsid process of uid $UID_A is running next to the app child" || bad "stray process not started"

echo "--- noah-client teardown"
client teardown || FAIL=1

[ "$(uid_procs "$UID_A")" = 0 ] && ok "no process of uid $UID_A survived purge" || bad "processes of uid $UID_A survived purge"
STATE="$(docker exec "$RUNNER" cat /exchange/state/uids.json)"
echo "    uids.json after teardown: $STATE"
echo "$STATE" | grep -q '"sessions":{}' && ok "every uid freed" || bad "uids left in the pool"
NEXT="$(echo "$STATE" | sed -n 's/.*"next":\([0-9]*\).*/\1/p')"
MAXU=$(( UID_A > UID_B ? UID_A : UID_B ))
[ "$NEXT" = "$(( MAXU + 2 ))" ] && ok "round-robin: session C got uid $(( MAXU + 1 )), not a just-freed uid (next=$NEXT)" || bad "round-robin cursor next=$NEXT (A=$UID_A B=$UID_B)"

# N5: a uid that still owns a process is never handed out, even when it is the round-robin cursor.
echo "--- busy uid / orphan trees (N5)"
docker exec -d --user "$NEXT:$NEXT" "$RUNNER" setsid sleep 3600
sleep 0.5
[ "$(uid_procs "$NEXT")" -ge 1 ] && ok "a process of the cursor uid $NEXT is running (no session holds it)" || bad "busy-uid process not started"
client open-d || FAIL=1
SID_D="$(docker exec "$RUNNER" node -e 'const c=require("crypto");console.log(c.createHash("sha256").update("noah-craft:e2e-conversation-D").digest("hex").slice(0,32))')"
UID_D="$(docker exec "$RUNNER" node -e "console.log(JSON.parse(require('fs').readFileSync('/exchange/state/uids.json','utf8')).sessions['$SID_D'])")"
[ "$UID_D" = "$(( NEXT + 1 ))" ] && ok "session D skipped busy uid $NEXT and got $UID_D" || bad "session D got uid $UID_D (busy uid was $NEXT)"
# An orphan work dir (its sid has no state entry, e.g. uids.json lost) owned by the busy uid: the boot
# sweep kills that uid's processes and removes the tree.
SID_O="$(docker exec "$RUNNER" node -e 'const c=require("crypto");console.log(c.createHash("sha256").update("noah-craft:e2e-orphan").digest("hex").slice(0,32))')"
docker exec "$RUNNER" sh -c "mkdir -p /exchange/work/$SID_O/out && echo x > /exchange/work/$SID_O/out/f && chown -R $NEXT:$NEXT /exchange/work/$SID_O"
BOOTS_BEFORE="$(docker logs "$RUNNER" 2>&1 | grep -c "listening on")"
docker restart "$RUNNER" >/dev/null
for _ in $(seq 1 120); do
  [ "$(docker logs "$RUNNER" 2>&1 | grep -c "listening on")" -gt "$BOOTS_BEFORE" ] && break
  sleep 0.5
done
docker exec "$RUNNER" test -e "/exchange/work/$SID_O" && bad "orphan work dir survived the boot sweep" || ok "boot sweep removed the orphan work dir"
docker logs "$RUNNER" 2>&1 | grep -q "removed 1 orphan session tree" && ok "boot sweep logged the orphan removal" || bad "no orphan-sweep log line"
docker exec "$RUNNER" test -d "/exchange/work/$SID_D" && ok "tracked session D kept by the sweep" || bad "sweep removed tracked session D"
client purge-d || FAIL=1
docker exec "$RUNNER" node -e '
  const fs = require("fs");
  for (const p of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try { const st = fs.readFileSync(`/proc/${p}/status`, "utf8"); if ((st.match(/^Uid:\s+(\d+)/m) || [])[1] === process.argv[1]) process.kill(Number(p), "SIGKILL"); } catch {}
  }' "$NEXT" >/dev/null 2>&1 || true

# N9: as root with the runner's real capabilities, an app spawn without a valid uid is refused before
# any child exists (Node would otherwise IGNORE `uid: undefined` and run the app as root).
echo "--- spawn without a valid session uid (N9)"
N9="$(docker exec -i "$RUNNER" node --input-type=module - <<'JS'
import { AppProcess } from "/opt/craft-runner/src/appProcess.mjs";
import { SessionManager } from "/opt/craft-runner/src/sessions.mjs";
import { DEFAULT_LIMITS } from "/opt/craft-runner/src/config.mjs";
const app = { id: "probe", label: "Probe", bin: "/bin/sleep", args: () => ["3600"], env: {} };
const out = {};
const p = new AppProcess({ app, readRoot: "/tmp", writeRoot: "/tmp", cwd: "/tmp", env: {}, ids: { uid: undefined, gid: undefined }, limits: DEFAULT_LIMITS, log: () => {} });
try { await p.start(); out.app = "SPAWNED"; } catch (e) { out.app = e.message; }
out.appChild = p.child ? p.child.pid : null;
const sm = new SessionManager({ exchangeDir: "/tmp", tmpRoot: "/tmp", limits: DEFAULT_LIMITS, maxProcs: 1,
  apps: new Map([["probe", { app, status: "ready" }]]), uids: { get: () => undefined, sids: () => [], size: 0 },
  owner: () => null, spawnAsSessionUid: true, log: () => {} });
try { await sm.getProc({ sid: "0".repeat(32), token: "0".repeat(64), revoked: false, procs: new Map(), conns: new Map() }, "probe", {}); out.session = "SPAWNED"; }
catch (e) { out.session = e.message; }
console.log(JSON.stringify(out));
JS
)"
echo "    $N9"
echo "$N9" | grep -q '"app":"refusing to spawn an app without a valid non-root uid/gid","appChild":null' && ok "AppProcess refuses ids {uid: undefined} as root, no child" || bad "AppProcess spawn without uid: $N9"
echo "$N9" | grep -q '"session":"the session has no valid uid' && ok "SessionManager refuses to spawn for a sid without a uid" || bad "SessionManager spawn without uid: $N9"
[ "$(docker exec "$RUNNER" node -e 'const fs=require("fs");let n=0;for(const p of fs.readdirSync("/proc").filter((d)=>/^\d+$/.test(d))){try{if(fs.readFileSync(`/proc/${p}/cmdline`,"utf8").startsWith("/bin/sleep\u00003600"))n++}catch{}}console.log(n)')" = 0 ] && ok "no probe process exists" || bad "a probe process was spawned"
STATE2="$(docker exec "$RUNNER" cat /exchange/state/uids.json)"
echo "$STATE2" | grep -q '"sessions":{}' && ok "every uid freed after D" || bad "uids left after D: $STATE2"

echo "--- runner log (calls)"
docker logs "$RUNNER" 2>&1 | grep -E "call |started|exited|killing" | sed 's/^/    /'

if [ "$FAIL" = 0 ]; then echo "E2E PASSED"; else echo "E2E FAILED"; fi
exit "$FAIL"
