#!/usr/bin/env bash
# NOT in the default run (drive.sh): it swaps the jaeger image, stops and starts jaeger and recreates containers,
# so run it by hand and LAST, when a bump touches the tracing service. It needs 71-tracing-turn.mjs to have run
# (evidence/T-sessions.json) and uses 73-traced-turn-check.mjs (about 2 minutes). Last run at pi 02a023e. For a
# footprint after load, run `node 74-tracing-load.mjs 40` before it.
#
# T7 (image override), T9 (Jaeger stopped / started), T10 (footprint).
set -uo pipefail
. "$(dirname "$0")/lib.sh"
cd "$W/scripts"
J=noah-almighty-jaeger-1
jimg() { dind docker inspect -f 'image={{.Config.Image}} id={{.Image}} state={{.State.Status}} restarts={{.RestartCount}} created={{.Created}}' $J; }
T4_SESSION=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).t4.sessionId)' "$W/evidence/T-sessions.json")

echo "===== T7: NOAH_PI_JAEGER_IMAGE"
echo "before: $(jimg)"
dind docker tag jaegertracing/jaeger:2.23.0 noahcompose.local/jaeger:2.23.0
echo 'NOAH_PI_JAEGER_IMAGE=noahcompose.local/jaeger:2.23.0' >> "$W/noah-almighty/.env"
dc up -d > "$W/logs/72-up-jaeger-override.log" 2>&1; echo "up -d exit=$?"; grep -E 'jaeger-1 (Recreate|Recreated|Started)|gateway-1 (Recreate|Recreated)|noah-almighty-1 (Recreate|Recreated)' "$W/logs/72-up-jaeger-override.log" | sort -u
for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$NOAH/api/bootstrap")" = 200 ] && break; sleep 2; done
echo "after:  $(jimg)"
echo "config: $(dc config 2>/dev/null | awk '/^  jaeger:/{p=1} p&&/image:/{print;exit}')"
node 73-traced-turn-check.mjs traced "T7 교체 이미지"
node 73-traced-turn-check.mjs old "$T4_SESSION"
echo "--- put it back"
sed -i '/^NOAH_PI_JAEGER_IMAGE=/d' "$W/noah-almighty/.env"
dc up -d > "$W/logs/72-up-jaeger-back.log" 2>&1; echo "up -d exit=$?"; grep -E 'jaeger-1 (Recreate|Recreated|Started)' "$W/logs/72-up-jaeger-back.log" | sort -u
for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$NOAH/api/bootstrap")" = 200 ] && break; sleep 2; done
echo "back:   $(jimg)"
node 73-traced-turn-check.mjs traced "T7 원래 이미지"

echo; echo "===== T9: Jaeger stopped"
T0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
dc stop jaeger 2>&1 | tail -1; echo "jaeger: $(dind docker inspect -f '{{.State.Status}}' $J)"
node 73-traced-turn-check.mjs untraced "T9 Jaeger 정지 중" | tee "$W/evidence/T9-down-turn.log"
DOWN_SESSION=$(grep '^SESSION ' "$W/evidence/T9-down-turn.log" | cut -d' ' -f2)
sleep 12   # two export intervals, so the exporters have tried and failed
echo "--- gateway / sandboxd / mcp-broker log lines at warn or above since Jaeger stopped (count × message):"
for s in gateway sandboxd mcp-broker; do
  dc logs --no-log-prefix --since "$T0" $s 2>&1 > "$W/evidence/T9-log-$s.txt"
  echo "[$s] $(wc -l < "$W/evidence/T9-log-$s.txt") lines in all"
  node -e 'const c={};let other=0;for(const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;try{const j=JSON.parse(l);if(j.level>=40){const k=`level ${j.level}: ${String(j.msg).slice(0,110)}${j.err?" | "+String(j.err.message??"").slice(0,90):""}`;c[k]=(c[k]??0)+1}}catch{other++;const k="non-JSON: "+l.slice(0,150);c[k]=(c[k]??0)+1}}console.log(Object.entries(c).map(([k,v])=>`    ${v}× ${k}`).join("\n")||"    (none)")' "$W/evidence/T9-log-$s.txt"
done
echo "--- start jaeger again"
dc start jaeger 2>&1 | tail -1; sleep 5; echo "jaeger: $(jimg)"
node 73-traced-turn-check.mjs traced "T9 Jaeger 재시작 후"
sleep 8
echo "--- the turn that ran while Jaeger was down (session $DOWN_SESSION), now:"
node -e 'import("./tracing-lib.mjs").then(async m=>{const g=await m.traces(process.argv[1]);console.log("    traces route HTTP",g.status,"traces:",g.traces.length,"spans:",g.traces[0]?.spans.map(s=>s.service+":"+s.name).join(", ")??"-")})' "$DOWN_SESSION"
node 73-traced-turn-check.mjs old "$T4_SESSION"

echo; echo "===== T10: footprint"
dind docker stats --no-stream --format '{{.Name}}\tmem={{.MemUsage}}\tmem%={{.MemPerc}}\tcpu={{.CPUPerc}}\tpids={{.PIDs}}' $J noah-almighty-gateway-1 noah-almighty-mcp-broker-1 noah-almighty-sandboxd-1 noah-almighty-noah-almighty-1
echo "jaeger-data volume: $(dind du -sh /var/lib/docker/volumes/noah-almighty_jaeger-data/_data | cut -f1) on disk, apparent $(dind du -sh --apparent-size /var/lib/docker/volumes/noah-almighty_jaeger-data/_data 2>/dev/null | cut -f1)"
dind sh -c 'ls -la /var/lib/docker/volumes/noah-almighty_jaeger-data/_data/keys /var/lib/docker/volumes/noah-almighty_jaeger-data/_data/values 2>/dev/null | head -30'
echo "traces stored: $(dc exec -T gateway node -e 'fetch("http://jaeger:16686/api/v3/traces?query.service_name=gateway&query.start_time_min="+new Date(Date.now()-864e5).toISOString()+"&query.start_time_max="+new Date().toISOString()+"&query.search_depth=1000").then(async r=>{const t=await r.text();console.log(new Set([...t.matchAll(/"traceId":"([0-9a-f]+)"/g)].map(m=>m[1])).size+" traces, "+(t.split("\"spanId\"").length-1)+" spans (gateway service search)")})')"
echo "jaeger restarts: $(dind docker inspect -f '{{.RestartCount}}' $J); image $(dind docker inspect -f '{{.Config.Image}}' $J)"
